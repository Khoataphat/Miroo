import { TypedEmitter } from '../../common/TypedEmitter';

export interface AudioPlayerEvents {
    'state-change': AudioContextState;
    'volume-change': number;
    'mute-change': boolean;
    error: Error;
}

export class AudioPlayer extends TypedEmitter<AudioPlayerEvents> {
    private static readonly SAMPLE_RATE = 48000;
    private static readonly CHANNELS = 2;
    private static readonly BYTES_PER_SAMPLE = 2;
    private static readonly FRAME_SIZE = AudioPlayer.CHANNELS * AudioPlayer.BYTES_PER_SAMPLE; // 4 bytes

    private audioCtx?: AudioContext;
    private gainNode?: GainNode;
    private ws?: WebSocket;
    private nextPlayTime = 0;
    private remainder?: Uint8Array;
    private volume = 1.0;
    private muted = false;
    private destroyed = false;
    private manualStop = false;
    private reconnectAttempts = 0;
    private reconnectTimeout?: number;
    private lastUrl?: string;
    private boundInteractionHandler?: () => void;
    private activeSources: AudioBufferSourceNode[] = [];

    constructor() {
        super();
        this.setupAutoplayUnlock();
    }

    private getOrCreateAudioContext(): AudioContext {
        if (!this.audioCtx) {
            const AudioContextClass =
                window.AudioContext ||
                (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
            this.audioCtx = new AudioContextClass({
                sampleRate: AudioPlayer.SAMPLE_RATE,
                latencyHint: 'interactive',
            });
            this.gainNode = this.audioCtx.createGain();
            this.gainNode.gain.value = this.muted ? 0 : this.volume;
            this.gainNode.connect(this.audioCtx.destination);

            this.audioCtx.onstatechange = () => {
                if (this.audioCtx) {
                    this.emit('state-change', this.audioCtx.state);
                }
            };
        }
        return this.audioCtx;
    }

    private setupAutoplayUnlock(): void {
        this.boundInteractionHandler = () => {
            if (this.audioCtx && this.audioCtx.state === 'suspended') {
                this.audioCtx.resume().catch((err) => {
                    console.warn('[AudioPlayer] AudioContext resume failed:', err);
                });
            }
        };

        window.addEventListener('pointerdown', this.boundInteractionHandler, { capture: true, passive: true });
        window.addEventListener('touchstart', this.boundInteractionHandler, { capture: true, passive: true });
        window.addEventListener('keydown', this.boundInteractionHandler, { capture: true, passive: true });
        window.addEventListener('click', this.boundInteractionHandler, { capture: true, passive: true });
        document.addEventListener('pointerdown', this.boundInteractionHandler, { capture: true, passive: true });
        document.addEventListener('click', this.boundInteractionHandler, { capture: true, passive: true });
    }

    public async resume(): Promise<void> {
        const ctx = this.getOrCreateAudioContext();
        if (ctx.state === 'suspended') {
            await ctx.resume();
        }
    }

    public connect(url: string | URL): WebSocket {
        if (this.ws) {
            this.ws.close();
            this.ws = undefined;
        }

        this.manualStop = false;
        const wsUrl = url.toString();
        this.lastUrl = wsUrl;
        const ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
            console.log('[AudioPlayer] Audio WebSocket connected');
            this.reconnectAttempts = 0;
            this.resume().catch((e) => {
                console.warn('[AudioPlayer] Failed to resume on socket open:', e);
            });
        };

        ws.onmessage = (event: MessageEvent) => {
            if (this.destroyed) {
                return;
            }
            if (event.data instanceof ArrayBuffer) {
                this.handlePcmData(new Uint8Array(event.data));
            }
        };

        ws.onerror = (event: Event) => {
            console.error('[AudioPlayer] Audio WebSocket error', event);
            this.emit('error', new Error('Audio WebSocket error'));
        };

        ws.onclose = (ev: CloseEvent) => {
            console.log('[AudioPlayer] Audio WebSocket closed', ev.code, ev.reason);
            // Do not reconnect on fatal server error codes (e.g. 4003, 4004, 4005) or manual stop
            const isFatal = ev.code >= 4000 && ev.code <= 4009;
            if (!this.destroyed && !this.manualStop && !isFatal && this.reconnectAttempts < 3) {
                this.reconnectAttempts++;
                const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 3000);
                this.reconnectTimeout = window.setTimeout(() => {
                    if (!this.destroyed && !this.manualStop && this.lastUrl) {
                        console.log(`[AudioPlayer] Reconnecting audio (attempt ${this.reconnectAttempts})...`);
                        this.connect(this.lastUrl);
                    }
                }, delay);
            }
        };

        this.ws = ws;
        return ws;
    }

    public handlePcmData(chunk: Uint8Array): void {
        if (this.destroyed || this.muted) {
            return;
        }

        let data = chunk;
        if (this.remainder && this.remainder.length > 0) {
            const combined = new Uint8Array(this.remainder.length + chunk.length);
            combined.set(this.remainder, 0);
            combined.set(chunk, this.remainder.length);
            data = combined;
            this.remainder = undefined;
        }

        const leftover = data.length % AudioPlayer.FRAME_SIZE;
        if (leftover > 0) {
            this.remainder = data.slice(data.length - leftover);
            data = data.subarray(0, data.length - leftover);
        }

        const frameCount = data.length / AudioPlayer.FRAME_SIZE;
        if (frameCount === 0) {
            return;
        }

        const ctx = this.getOrCreateAudioContext();
        if (ctx.state === 'suspended') {
            ctx.resume().catch(() => void 0);
            return;
        }

        const audioBuffer = ctx.createBuffer(AudioPlayer.CHANNELS, frameCount, AudioPlayer.SAMPLE_RATE);
        const leftChannel = audioBuffer.getChannelData(0);
        const rightChannel = audioBuffer.getChannelData(1);

        const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
        for (let i = 0; i < frameCount; i++) {
            const offset = i * AudioPlayer.FRAME_SIZE;
            // 16-bit signed PCM, little endian
            leftChannel[i] = dataView.getInt16(offset, true) / 32768.0;
            rightChannel[i] = dataView.getInt16(offset + 2, true) / 32768.0;
        }

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        if (this.gainNode) {
            source.connect(this.gainNode);
        } else {
            source.connect(ctx.destination);
        }

        const currentTime = ctx.currentTime;
        // Jitter buffer with smooth 20ms lead time and 80ms max drift to prevent crackle and lag
        const minLeadTime = 0.02; // 20ms buffer lead time
        const maxDrift = 0.08; // 80ms max buffer ahead
        if (this.nextPlayTime < currentTime) {
            this.nextPlayTime = currentTime + minLeadTime;
        } else if (this.nextPlayTime > currentTime + maxDrift) {
            // Buffer drifted ahead. Stop and disconnect active sources to prevent overlapping cacophony/echo.
            for (const s of this.activeSources) {
                try {
                    s.stop();
                    s.disconnect();
                } catch {
                    // Ignore errors if already finished
                }
            }
            this.activeSources = [];
            this.nextPlayTime = currentTime + minLeadTime;
        }

        source.onended = () => {
            const idx = this.activeSources.indexOf(source);
            if (idx !== -1) {
                this.activeSources.splice(idx, 1);
            }
        };
        this.activeSources.push(source);
        source.start(this.nextPlayTime);
        this.nextPlayTime += audioBuffer.duration;
    }

    public setVolume(volume: number): void {
        this.volume = Math.max(0, Math.min(1, volume));
        if (this.gainNode && !this.muted) {
            this.gainNode.gain.setValueAtTime(this.volume, this.audioCtx ? this.audioCtx.currentTime : 0);
        }
        this.emit('volume-change', this.volume);
    }

    public getVolume(): number {
        return this.volume;
    }

    public setMute(mute: boolean): void {
        this.muted = mute;
        if (this.gainNode) {
            const target = this.muted ? 0 : this.volume;
            this.gainNode.gain.setValueAtTime(target, this.audioCtx ? this.audioCtx.currentTime : 0);
        }
        if (this.muted) {
            // Stop queued sources on mute to avoid burst on unmute
            for (const s of this.activeSources) {
                try {
                    s.stop();
                    s.disconnect();
                } catch {
                    // Ignore
                }
            }
            this.activeSources = [];
            this.nextPlayTime = 0;
            this.remainder = undefined;
        }
        this.emit('mute-change', this.muted);
    }

    public toggleMute(): boolean {
        this.setMute(!this.muted);
        return this.muted;
    }

    public isMuted(): boolean {
        return this.muted;
    }

    public isPlaying(): boolean {
        return !!(this.audioCtx && this.audioCtx.state === 'running' && !this.muted);
    }

    public stop(): void {
        this.manualStop = true;
        if (this.reconnectTimeout !== undefined) {
            window.clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = undefined;
        }
        for (const s of this.activeSources) {
            try {
                s.stop();
                s.disconnect();
            } catch {
                // Ignore
            }
        }
        this.activeSources = [];
        this.nextPlayTime = 0;
        this.remainder = undefined;
    }

    public destroy(): void {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        this.stop();

        if (this.boundInteractionHandler) {
            window.removeEventListener('pointerdown', this.boundInteractionHandler);
            window.removeEventListener('touchstart', this.boundInteractionHandler);
            window.removeEventListener('keydown', this.boundInteractionHandler);
            window.removeEventListener('click', this.boundInteractionHandler);
            this.boundInteractionHandler = undefined;
        }

        if (this.gainNode) {
            this.gainNode.disconnect();
            this.gainNode = undefined;
        }

        if (this.audioCtx) {
            this.audioCtx.close().catch((e) => {
                console.warn('[AudioPlayer] Error closing AudioContext:', e);
            });
            this.audioCtx = undefined;
        }
    }
}
