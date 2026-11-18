import '../../../vendor/Genymobile/scrcpy/scrcpy-server-audio.jar';

import { Device } from './Device';
import path from 'path';
import fs from 'fs';
import { AdbUtils } from './AdbUtils';

const TEMP_PATH = '/data/local/tmp/';
const FILE_DIR = path.join(__dirname, 'vendor/Genymobile/scrcpy');
const FILE_NAME = 'scrcpy-server-audio.jar';
const AUDIO_RUN_COMMAND = `CLASSPATH=${TEMP_PATH}${FILE_NAME} nohup app_process / com.genymobile.scrcpy.Server 3.3.4 tunnel_forward=true audio=true video=false control=false audio_codec=raw raw_stream=true send_dummy_byte=false send_codec_meta=false send_frame_meta=false send_device_meta=false > /data/local/tmp/scrcpy-audio.log 2>&1 &`;

export class AudioServer {
    private static runningPorts: Map<string, number> = new Map();
    private static startingPromises: Map<string, Promise<number>> = new Map();

    private static getJarPath(): string {
        const candidates = [
            path.join(FILE_DIR, FILE_NAME),
            path.join(process.cwd(), 'dist/vendor/Genymobile/scrcpy', FILE_NAME),
            path.join(process.cwd(), 'vendor/Genymobile/scrcpy', FILE_NAME),
        ];
        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        return candidates[0];
    }

    private static async copyServer(device: Device): Promise<void> {
        const src = this.getJarPath();
        const dst = TEMP_PATH + FILE_NAME;

        // Optimization: check if jar already exists with identical file size
        try {
            const localStats = fs.statSync(src);
            const remoteStats = await AdbUtils.stats(device.udid, dst).catch(() => undefined);
            if (remoteStats && remoteStats.size === localStats.size) {
                return;
            }
        } catch {
            // Proceed to push if stat check fails
        }

        const transfer = await device.push(src, dst);
        return new Promise<void>((resolve, reject) => {
            transfer.on('end', () => resolve());
            transfer.on('error', (err: Error) => reject(err));
        });
    }

    public static async killExistingAudioServer(device: Device): Promise<void> {
        try {
            await device.runShellCommandAdbKit(
                `pkill -9 -f "audio=true" 2>/dev/null; for p in /proc/[0-9]*; do if grep -Fq "audio=true" "$p/cmdline" 2>/dev/null && grep -Fq "video=false" "$p/cmdline" 2>/dev/null; then kill -9 "\${p#/proc/}" 2>/dev/null; fi; done`,
            );
        } catch (e: any) {
            console.warn(device.TAG, 'Cleanup of old audio server:', e?.message || e);
        }
    }

    public static async isAudioServerRunning(device: Device): Promise<boolean> {
        if (!device.isConnected()) {
            return false;
        }
        try {
            const unixList = await device.runShellCommandAdbKit('cat /proc/net/unix');
            const proc = await device.runShellCommandAdbKit(
                'for p in /proc/[0-9]*; do if grep -Fq "audio=true" "$p/cmdline" 2>/dev/null && grep -Fq "video=false" "$p/cmdline" 2>/dev/null; then echo "RUNNING"; break; fi; done',
            );
            return unixList.includes('@scrcpy') && proc.includes('RUNNING');
        } catch {
            return false;
        }
    }

    private static async waitForSocketReady(device: Device, maxWaitMs = 6000): Promise<boolean> {
        const startTime = Date.now();
        const pollInterval = 150;
        while (Date.now() - startTime < maxWaitMs) {
            if (!device.isConnected()) {
                throw new Error('Device disconnected while waiting for audio server socket');
            }
            try {
                const unixList = await device.runShellCommandAdbKit('cat /proc/net/unix');
                if (unixList.includes('@scrcpy')) {
                    return true;
                }
            } catch {
                // Ignore transient shell read errors during app_process boot
            }

            // Check if audio server died prematurely (e.g. Android < 10 or permission failure)
            if (Date.now() - startTime > 2500) {
                try {
                    const checkProc = await device.runShellCommandAdbKit(
                        'for p in /proc/[0-9]*; do if grep -Fq "audio=true" "$p/cmdline" 2>/dev/null && grep -Fq "video=false" "$p/cmdline" 2>/dev/null; then echo "RUNNING"; break; fi; done',
                    );
                    if (!checkProc.includes('RUNNING')) {
                        const log = await device
                            .runShellCommandAdbKit('cat /data/local/tmp/scrcpy-audio.log 2>/dev/null')
                            .catch(() => '');
                        throw new Error(
                            `Audio server app_process exited prematurely: ${log.trim() || 'unknown error'}`,
                        );
                    }
                } catch (e: any) {
                    if (e?.message?.includes('Audio server app_process exited')) {
                        throw e;
                    }
                }
            }
            await new Promise((resolve) => setTimeout(resolve, pollInterval));
        }
        return false;
    }

    public static async start(device: Device): Promise<number> {
        const udid = device.descriptor.udid;
        if (!device.isConnected()) {
            throw new Error(`Device ${udid} is not connected`);
        }

        const props = await device.getProperties().catch(() => undefined);
        const sdkVersion = props ? parseInt(props['ro.build.version.sdk'] || '0', 10) : 0;
        if (sdkVersion > 0 && sdkVersion < 29) {
            throw new Error(`Internal audio capture requires Android 10+ (API 29+), device is API ${sdkVersion}`);
        }

        const existingPort = this.runningPorts.get(udid);
        if (existingPort) {
            const isAlive = await this.isAudioServerRunning(device);
            if (isAlive) {
                return existingPort;
            }
            this.runningPorts.delete(udid);
        }

        const pending = this.startingPromises.get(udid);
        if (pending) {
            return pending;
        }

        const startPromise = (async () => {
            try {
                await this.killExistingAudioServer(device);
                await this.copyServer(device);

                // Run scrcpy-server with audio enabled
                device.runShellCommandAdb(AUDIO_RUN_COMMAND).catch((e: any) => {
                    console.log(device.TAG, 'AudioServer exited:', e?.message || e);
                    this.runningPorts.delete(udid);
                });

                const isReady = await this.waitForSocketReady(device);
                if (!isReady) {
                    throw new Error('Timed out waiting for scrcpy audio abstract socket to bind');
                }

                // Forward local abstract socket 'scrcpy' (created by scrcpy 3.3.4 when tunnel_forward=true)
                const localPort = await AdbUtils.forward(udid, 'localabstract:scrcpy');
                this.runningPorts.set(udid, localPort);
                return localPort;
            } finally {
                this.startingPromises.delete(udid);
            }
        })();

        this.startingPromises.set(udid, startPromise);
        return startPromise;
    }

    public static stop(udid: string, device?: Device): void {
        this.runningPorts.delete(udid);
        this.startingPromises.delete(udid);
        if (device && device.isConnected()) {
            this.killExistingAudioServer(device).catch(() => undefined);
        }
    }
}
