import { Mw, RequestParameters } from '../../mw/Mw';
import WS from 'ws';
import * as net from 'net';
import { ACTION } from '../../../common/Action';
import { Multiplexer } from '../../../packages/multiplexer/Multiplexer';
import { ControlCenter } from '../services/ControlCenter';
import { AudioServer } from '../AudioServer';

function applySocketNoDelay(ws: WS | Multiplexer): void {
    const raw = (ws as unknown as { _socket?: { setNoDelay?: (noDelay?: boolean) => void } })._socket;
    if (raw && typeof raw.setNoDelay === 'function') {
        raw.setNoDelay(true);
    }
    const multiplexerInner = (ws as unknown as { ws?: { _socket?: { setNoDelay?: (noDelay?: boolean) => void } } }).ws;
    if (multiplexerInner?._socket && typeof multiplexerInner._socket.setNoDelay === 'function') {
        multiplexerInner._socket.setNoDelay(true);
    }
}

export class AudioProxy extends Mw {
    public static readonly TAG = 'AudioProxy';
    private remoteSocket?: net.Socket;
    private released = false;
    private retryTimer?: NodeJS.Timeout;

    public static processRequest(ws: WS, params: RequestParameters): AudioProxy | undefined {
        const { action, url } = params;
        if (action !== ACTION.PROXY_AUDIO && action !== ACTION.AUDIO) {
            return;
        }
        const udid = url.searchParams.get('udid');
        if (!udid) {
            ws.close(4003, `[${this.TAG}] Invalid value for "udid" parameter`);
            return;
        }
        return this.createProxy(ws, udid);
    }

    public static createProxy(ws: WS | Multiplexer, udid: string): AudioProxy {
        const service = new AudioProxy(ws);
        service.init(udid).catch((e) => {
            const msg = `[${this.TAG}] Failed to start audio service: ${e.message}`;
            console.error(msg);
            if (!service.released && service.ws && service.ws.readyState === service.ws.OPEN) {
                service.ws.close(4005, msg);
            }
        });
        return service;
    }

    constructor(ws: WS | Multiplexer) {
        super(ws);
        applySocketNoDelay(this.ws);
    }

    public async init(udid: string): Promise<void> {
        this.name = `[${AudioProxy.TAG}{${udid}}]`;
        const controlCenter = ControlCenter.getInstance();
        const device = controlCenter.getDevice(udid);
        if (!device || !device.isConnected()) {
            throw new Error(`Device not found or not connected: ${udid}`);
        }

        const port = await AudioServer.start(device);
        if (this.released) {
            return;
        }

        let attempts = 0;
        const maxAttempts = 3;
        let hasReceivedData = false;

        const tryConnect = (): Promise<net.Socket> => {
            return new Promise((resolve, reject) => {
                if (this.released) {
                    reject(new Error('AudioProxy already released'));
                    return;
                }
                let connected = false;
                let hasHandledFailure = false;
                const s = net.connect(port, '127.0.0.1');
                s.setNoDelay(true);

                const handleFailure = (err: Error) => {
                    if (hasHandledFailure || connected || this.released) {
                        return;
                    }
                    hasHandledFailure = true;
                    s.removeAllListeners();
                    s.destroy();
                    if (++attempts < maxAttempts) {
                        this.retryTimer = setTimeout(() => {
                            this.retryTimer = undefined;
                            tryConnect().then(resolve, reject);
                        }, 300);
                    } else {
                        reject(err);
                    }
                };

                const onConnect = () => {
                    s.removeListener('error', onError);
                    s.removeListener('close', onCloseBeforeConnect);
                    connected = true;
                    resolve(s);
                };

                const onError = (err: Error) => {
                    handleFailure(err);
                };

                const onCloseBeforeConnect = () => {
                    handleFailure(new Error('Audio socket closed before connection established'));
                };

                s.once('connect', onConnect);
                s.once('error', onError);
                s.once('close', onCloseBeforeConnect);
            });
        };

        const attachSocketListeners = (socket: net.Socket) => {
            if (this.released) {
                socket.destroy();
                return;
            }
            this.remoteSocket = socket;

            socket.on('data', (data: Buffer) => {
                hasReceivedData = true;
                if (!this.released && this.ws && this.ws.readyState === this.ws.OPEN) {
                    this.ws.send(data);
                }
            });

            socket.on('close', () => {
                if (this.released) {
                    return;
                }

                // Only retry if no data was ever received and within maxAttempts
                if (!hasReceivedData && this.ws && this.ws.readyState === this.ws.OPEN && attempts < maxAttempts) {
                    console.log(this.name, 'Socket closed before data received, retrying...');
                    this.retryTimer = setTimeout(() => {
                        this.retryTimer = undefined;
                        if (!this.released && this.ws && this.ws.readyState === this.ws.OPEN) {
                            tryConnect()
                                .then(attachSocketListeners)
                                .catch((e) => {
                                    console.error(this.name, 'Audio retry failed:', e.message);
                                    if (this.ws && this.ws.readyState === this.ws.OPEN) {
                                        this.ws.close(1000);
                                    }
                                });
                        }
                    }, 300);
                    return;
                }

                // When audio socket closes on the device, scrcpy audio server exits
                AudioServer.stop(udid, device);

                if (this.ws && this.ws.readyState === this.ws.OPEN) {
                    this.ws.close(1000);
                }
            });

            socket.on('error', (err: Error) => {
                console.error(this.name, 'Socket error:', err.message);
                if (!this.released && this.ws && this.ws.readyState === this.ws.OPEN) {
                    this.ws.close(4011, err.message);
                }
            });
        };

        const initialSocket = await tryConnect();
        attachSocketListeners(initialSocket);
    }

    protected onSocketMessage(event: WS.MessageEvent): void {
        if (this.remoteSocket && !this.remoteSocket.destroyed) {
            if (typeof event.data === 'string') {
                this.remoteSocket.write(event.data);
            } else if (Buffer.isBuffer(event.data)) {
                this.remoteSocket.write(event.data);
            } else if (event.data instanceof ArrayBuffer) {
                this.remoteSocket.write(Buffer.from(event.data));
            }
        }
    }

    public release(): void {
        if (this.released) {
            return;
        }
        this.released = true;
        super.release();

        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = undefined;
        }
        if (this.remoteSocket) {
            this.remoteSocket.removeAllListeners();
            this.remoteSocket.destroy();
            this.remoteSocket = undefined;
        }
    }
}
