import { BaseCanvasBasedPlayer } from './BaseCanvasBasedPlayer';
import VideoSettings from '../VideoSettings';
import Size from '../Size';
import { DisplayInfo } from '../DisplayInfo';
import H264Parser from 'h264-converter/dist/h264-parser';
import NALU from 'h264-converter/dist/util/NALU';
import ScreenInfo from '../ScreenInfo';
import Rect from '../Rect';
import { H265NALU, H265Parser } from './H265Parser';

type ParametersSubSet = {
    codec: string;
    width: number;
    height: number;
};

function toHex(value: number) {
    return value.toString(16).padStart(2, '0').toUpperCase();
}

export class WebCodecsPlayer extends BaseCanvasBasedPlayer {
    public static readonly TAG = 'WebCodecsPlayer';
    public static readonly playerFullName = 'WebCodecs Adapter';
    public static readonly playerCodeName = 'webcodecs';
    public static readonly storageKeyPrefix = 'WebCodecsDecoder';

    public static preferredVideoSettings: VideoSettings = new VideoSettings({
        lockedVideoOrientation: -1,
        bitrate: 16777216, // 16Mbps Ultra HD Quality
        maxFps: 60,
        iFrameInterval: 5,
        bounds: new Size(1920, 1920),
        sendFrameMeta: false,
    });

    public static isSupported(): boolean {
        return typeof window !== 'undefined' && typeof window.VideoDecoder === 'function';
    }

    public static async hasSupport(): Promise<boolean> {
        return WebCodecsPlayer.isSupported();
    }

    private static parseSPS(data: Uint8Array): ParametersSubSet {
        const {
            profile_idc,
            constraint_set_flags,
            level_idc,
            pic_width_in_mbs_minus1,
            frame_crop_left_offset,
            frame_crop_right_offset,
            frame_mbs_only_flag,
            pic_height_in_map_units_minus1,
            frame_crop_top_offset,
            frame_crop_bottom_offset,
            sar,
        } = H264Parser.parseSPS(data);

        const sarScale = sar[0] / sar[1];
        const codec = `avc1.${[profile_idc, constraint_set_flags, level_idc].map(toHex).join('')}`;
        const width = Math.ceil(
            ((pic_width_in_mbs_minus1 + 1) * 16 - frame_crop_left_offset * 2 - frame_crop_right_offset * 2) * sarScale,
        );
        const height =
            (2 - frame_mbs_only_flag) * (pic_height_in_map_units_minus1 + 1) * 16 -
            (frame_mbs_only_flag ? 2 : 4) * (frame_crop_top_offset + frame_crop_bottom_offset);
        return { codec, width, height };
    }

    public readonly supportsScreenshot = true;
    private context?: CanvasRenderingContext2D;
    private decoder: VideoDecoder;
    private buffer: ArrayBuffer | undefined;
    private hadIDR = false;
    private bufferedVPS = false;
    private bufferedSPS = false;
    private bufferedPPS = false;
    private isH265Stream = false;
    private lastTimestamp = 0;

    private getNextTimestamp(): number {
        const now = Math.round(performance.now() * 1000);
        if (now <= this.lastTimestamp) {
            this.lastTimestamp += 1;
        } else {
            this.lastTimestamp = now;
        }
        return this.lastTimestamp;
    }

    constructor(udid: string, displayInfo?: DisplayInfo, name = WebCodecsPlayer.playerFullName) {
        super(udid, displayInfo, name, WebCodecsPlayer.storageKeyPrefix);
        const context = this.tag.getContext('2d');
        if (!context) {
            throw Error('Failed to get 2d context from canvas');
        }
        this.context = context;
        this.decoder = this.createDecoder();
    }

    protected initCanvas(width: number, height: number): void {
        super.initCanvas(width, height);
        this.context = this.tag.getContext('2d') || undefined;
        if (this.context) {
            this.context.imageSmoothingEnabled = true;
            this.context.imageSmoothingQuality = 'high';
        }
    }

    private createDecoder(): VideoDecoder {
        return new VideoDecoder({
            output: (frame) => {
                this.onFrameDecoded(0, 0, frame);
            },
            error: (error: DOMException) => {
                console.error('[WebCodecsPlayer] Decoder error:', error, `code: ${error.code}`);
                this.stop();
            },
        });
    }

    protected addToBuffer(data: Uint8Array): Uint8Array {
        let array: Uint8Array;
        if (this.buffer) {
            array = new Uint8Array(this.buffer.byteLength + data.byteLength);
            array.set(new Uint8Array(this.buffer));
            array.set(new Uint8Array(data), this.buffer.byteLength);
        } else {
            array = data;
        }
        this.buffer = array.buffer;
        return array;
    }

    protected scaleCanvas(width: number, height: number): void {
        const screenInfo = new ScreenInfo(new Rect(0, 0, width, height), new Size(width, height), 0);
        this.emit('input-video-resize', screenInfo);
        this.setScreenInfo(screenInfo);
        this.initCanvas(width, height);
        this.tag.style.transform = '';
        this.tag.style.transformOrigin = '';
    }

    private configureDecoder(codec: string): void {
        const config: VideoDecoderConfig = {
            codec,
            optimizeForLatency: true,
        } as VideoDecoderConfig;
        if (this.decoder.state === 'closed') {
            this.decoder = this.createDecoder();
        }
        try {
            this.decoder.configure(config);
        } catch (e) {
            if (codec.startsWith('hev1.')) {
                try {
                    const fallbackConfig = { ...config, codec: codec.replace('hev1.', 'hvc1.') };
                    this.decoder.configure(fallbackConfig);
                } catch (e2) {
                    console.error('[WebCodecsPlayer] Failed to configure decoder with hev1 and hvc1:', e, e2);
                }
            } else {
                console.error('[WebCodecsPlayer] Failed to configure decoder:', e);
            }
        }
    }

    protected decode(data: Uint8Array): void {
        if (!data || data.length < 4) {
            return;
        }

        // Detect 3 or 4 byte start code for H.264
        let h264Type = -1;
        let h264HeaderOffset = 4;
        if (data[0] === 0 && data[1] === 0) {
            if (data[2] === 1) {
                h264Type = data[3] & 0x1f;
                h264HeaderOffset = 3;
            } else if (data[2] === 0 && data.length > 4 && data[3] === 1) {
                h264Type = data[4] & 0x1f;
                h264HeaderOffset = 4;
            }
        }

        // Check if stream is explicitly H.264
        if (h264Type === NALU.SPS || h264Type === NALU.PPS) {
            this.isH265Stream = false;
        }

        // H.265 VPS authentic header check: byte 0 is 0x40 (nal_unit_type 32, layer 0),
        // and byte 1 has temporal_id_plus1 >= 1 (lower 3 bits > 0).
        // Standard H.264 non-IDR slices (e.g. byte 0x41) must NEVER be mistaken for H.265 VPS!
        const isGenuineH265VPS =
            data.length > h264HeaderOffset + 1 &&
            data[h264HeaderOffset] === 0x40 &&
            (data[h264HeaderOffset + 1] & 0x07) >= 1;

        if (isGenuineH265VPS) {
            this.isH265Stream = true;
        }

        const isH265 = this.isH265Stream;

        if (isH265) {
            const h265Header = H265NALU.parseHeader(data);
            const h265Type = h265Header ? h265Header.type : -1;
            if (h265Type === H265NALU.VPS) {
                this.bufferedVPS = true;
                this.addToBuffer(data);
                return;
            } else if (h265Type === H265NALU.SPS) {
                const rbspOffset = (h265Header ? h265Header.headerOffset : 4) + 2;
                const { codec, width, height } = H265Parser.parseSPS(data.subarray(rbspOffset));
                this.scaleCanvas(width, height);
                this.configureDecoder(codec);
                this.bufferedSPS = true;
                this.addToBuffer(data);
                this.hadIDR = false;
                return;
            } else if (h265Type === H265NALU.PPS) {
                this.bufferedPPS = true;
                this.addToBuffer(data);
                return;
            } else if (h265Type === H265NALU.PREFIX_SEI || h265Type === H265NALU.SUFFIX_SEI) {
                if (!this.bufferedVPS || !this.bufferedSPS || !this.bufferedPPS) {
                    return;
                }
            }

            const isKey = H265NALU.isKeyFrame(h265Type);
            const array = this.addToBuffer(data);
            this.hadIDR = this.hadIDR || isKey;
            if (array && this.decoder.state === 'configured' && this.hadIDR) {
                this.buffer = undefined;
                this.bufferedPPS = false;
                this.bufferedSPS = false;
                this.bufferedVPS = false;
                this.decoder.decode(
                    new EncodedVideoChunk({
                        type: isKey ? 'key' : 'delta',
                        timestamp: this.getNextTimestamp(),
                        data: array.buffer,
                    }),
                );
                return;
            }
            return;
        }

        // H.264 fallback
        const isIDR = h264Type === NALU.IDR;
        if (h264Type === NALU.SPS) {
            const { codec, width, height } = WebCodecsPlayer.parseSPS(data.subarray(h264HeaderOffset));
            this.scaleCanvas(width, height);
            this.configureDecoder(codec);
            this.bufferedSPS = true;
            this.addToBuffer(data);
            this.hadIDR = false;
            return;
        } else if (h264Type === NALU.PPS) {
            this.bufferedPPS = true;
            this.addToBuffer(data);
            return;
        } else if (h264Type === NALU.SEI) {
            if (!this.bufferedSPS || !this.bufferedPPS) {
                return;
            }
        }
        const array = this.addToBuffer(data);
        this.hadIDR = this.hadIDR || isIDR;
        if (array && this.decoder.state === 'configured' && this.hadIDR) {
            this.buffer = undefined;
            this.bufferedPPS = false;
            this.bufferedSPS = false;
            this.decoder.decode(
                new EncodedVideoChunk({
                    type: isIDR ? 'key' : 'delta',
                    timestamp: this.getNextTimestamp(),
                    data: array.buffer,
                }),
            );
            return;
        }
    }

    protected onFrameDecoded(width: number, height: number, frame: VideoFrame): void {
        let dropped = 0;
        const maxStored = Math.max(2, Math.floor((this.videoSettings?.maxFps || 60) / 10));

        while (this.decodedFrames.length > maxStored) {
            const data = this.decodedFrames.shift();
            if (data) {
                this.dropFrame(data.frame);
                dropped++;
            }
        }
        this.decodedFrames.push({ width, height, frame });
        this.videoStats.push({
            decodedFrames: 1,
            droppedFrames: dropped,
            inputBytes: 0,
            inputFrames: 0,
            timestamp: Date.now(),
        });
        if (!this.animationFrameId) {
            this.animationFrameId = requestAnimationFrame(this.drawDecoded);
        }
    }

    protected drawDecoded = (): void => {
        const data = this.decodedFrames.shift();
        if (data) {
            const frame: VideoFrame = data.frame;
            try {
                if (this.context) {
                    if (frame.displayWidth > 0 && frame.displayHeight > 0) {
                        if (this.tag.width !== frame.displayWidth || this.tag.height !== frame.displayHeight) {
                            this.tag.width = frame.displayWidth;
                            this.tag.height = frame.displayHeight;
                            this.context.imageSmoothingEnabled = true;
                            this.context.imageSmoothingQuality = 'high';
                        }
                    }
                    this.context.drawImage(frame, 0, 0);
                }
            } catch (e) {
                console.error('[WebCodecsPlayer] drawImage error:', e);
            } finally {
                frame.close();
            }
        }
        if (this.decodedFrames.length) {
            this.animationFrameId = requestAnimationFrame(this.drawDecoded);
        } else {
            this.animationFrameId = undefined;
        }
    };

    protected dropFrame(frame: VideoFrame): void {
        frame.close();
    }

    public getFitToScreenStatus(): boolean {
        return WebCodecsPlayer.getFitToScreenStatus(this.udid, this.displayInfo);
    }

    public getPreferredVideoSetting(): VideoSettings {
        return WebCodecsPlayer.preferredVideoSettings;
    }

    public static loadVideoSettings(udid: string, displayInfo?: DisplayInfo): VideoSettings {
        const loaded = super.loadVideoSettings(udid, displayInfo);
        const preferred = WebCodecsPlayer.preferredVideoSettings;
        const bitrate = Math.max(loaded.bitrate, preferred.bitrate);
        let bounds = loaded.bounds;
        if (!bounds || bounds.width > 1920 || bounds.height > 1920 || (bounds.width < 1080 && bounds.height < 1080)) {
            bounds = preferred.bounds;
        }
        return new VideoSettings({
            crop: loaded.crop,
            bitrate,
            bounds,
            maxFps: loaded.maxFps,
            iFrameInterval: loaded.iFrameInterval,
            sendFrameMeta: loaded.sendFrameMeta,
            lockedVideoOrientation: loaded.lockedVideoOrientation,
            displayId: loaded.displayId,
            codecOptions: loaded.codecOptions,
            encoderName: loaded.encoderName,
        });
    }

    public loadVideoSettings(): VideoSettings {
        return WebCodecsPlayer.loadVideoSettings(this.udid, this.displayInfo);
    }

    protected needScreenInfoBeforePlay(): boolean {
        return false;
    }

    protected clearState(): void {
        super.clearState();
        while (this.decodedFrames.length) {
            const data = this.decodedFrames.shift();
            if (data && data.frame) {
                this.dropFrame(data.frame);
            }
        }
        this.buffer = undefined;
        this.isH265Stream = false;
        this.bufferedVPS = false;
        this.bufferedSPS = false;
        this.bufferedPPS = false;
        this.hadIDR = false;
    }

    public stop(): void {
        super.stop();
        this.clearState();
        if (this.decoder.state !== 'closed') {
            this.decoder.close();
        }
    }
}
