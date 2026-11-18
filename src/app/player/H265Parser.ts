class BitReader {
    private byteOffset = 0;
    private bitOffset = 0;

    constructor(private data: Uint8Array) {}

    public readBit(): number {
        if (this.byteOffset >= this.data.length) {
            return 0;
        }
        const bit = (this.data[this.byteOffset] >> (7 - this.bitOffset)) & 1;
        this.bitOffset++;
        if (this.bitOffset === 8) {
            this.bitOffset = 0;
            this.byteOffset++;
        }
        return bit;
    }

    public readBits(n: number): number {
        let val = 0;
        for (let i = 0; i < n; i++) {
            val = val * 2 + this.readBit();
        }
        return val >>> 0;
    }

    public readUE(): number {
        let leadingZeros = 0;
        while (this.byteOffset < this.data.length && this.readBit() === 0) {
            leadingZeros++;
            if (leadingZeros > 32) {
                return 0;
            }
        }
        if (leadingZeros === 0) {
            return 0;
        }
        return (1 << leadingZeros) - 1 + this.readBits(leadingZeros);
    }

    public readSE(): number {
        const val = this.readUE();
        return val & 1 ? (val + 1) / 2 : -(val / 2);
    }

    public skipBits(n: number): void {
        this.bitOffset += n;
        this.byteOffset += Math.floor(this.bitOffset / 8);
        this.bitOffset = this.bitOffset % 8;
    }
}

export function removeEmulationPrevention(data: Uint8Array): Uint8Array {
    const out = new Uint8Array(data.length);
    let outIdx = 0;
    for (let i = 0; i < data.length; i++) {
        if (i + 2 < data.length && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 3) {
            out[outIdx++] = data[i++];
            out[outIdx++] = data[i++];
            // skip emulation prevention 0x03 byte
        } else {
            out[outIdx++] = data[i];
        }
    }
    return out.subarray(0, outIdx);
}

export class H265NALU {
    public static readonly TRAIL_N = 0;
    public static readonly TRAIL_R = 1;
    public static readonly TSA_N = 2;
    public static readonly TSA_R = 3;
    public static readonly STSA_N = 4;
    public static readonly STSA_R = 5;
    public static readonly RADL_N = 6;
    public static readonly RADL_R = 7;
    public static readonly RASL_N = 8;
    public static readonly RASL_R = 9;
    public static readonly BLA_W_LP = 16;
    public static readonly BLA_W_RADL = 17;
    public static readonly BLA_N_LP = 18;
    public static readonly IDR_W_RADL = 19;
    public static readonly IDR_N_LP = 20;
    public static readonly CRA_NUT = 21;
    public static readonly VPS = 32;
    public static readonly SPS = 33;
    public static readonly PPS = 34;
    public static readonly AUD = 35;
    public static readonly EOS = 36;
    public static readonly EOB = 37;
    public static readonly FD = 38;
    public static readonly PREFIX_SEI = 39;
    public static readonly SUFFIX_SEI = 40;

    public static isKeyFrame(type: number): boolean {
        return type >= H265NALU.BLA_W_LP && type <= H265NALU.CRA_NUT;
    }

    public static getNaluType(headerByte: number): number {
        return (headerByte >> 1) & 0x3f;
    }

    /**
     * Finds the start code offset and header index for both 3-byte (00 00 01) and 4-byte (00 00 00 01) NAL units.
     * Returns { headerOffset, type } or null if no valid start code found.
     */
    public static parseHeader(data: Uint8Array): { headerOffset: number; type: number } | null {
        if (!data || data.length < 4) {
            return null;
        }
        if (data[0] === 0 && data[1] === 0) {
            if (data[2] === 1) {
                // 3-byte start code
                return { headerOffset: 3, type: H265NALU.getNaluType(data[3]) };
            } else if (data[2] === 0 && data.length > 4 && data[3] === 1) {
                // 4-byte start code
                return { headerOffset: 4, type: H265NALU.getNaluType(data[4]) };
            }
        }
        return null;
    }
}

export class H265Parser {
    public static parseSPS(data: Uint8Array): { codec: string; width: number; height: number } {
        try {
            const rbsp = removeEmulationPrevention(data);
            const reader = new BitReader(rbsp);

            reader.skipBits(4); // sps_video_parameter_set_id
            const spsMaxSubLayersMinus1 = reader.readBits(3);
            reader.skipBits(1); // sps_temporal_id_nesting_flag

            // profile_tier_level
            const profileSpace = reader.readBits(2);
            const tierFlag = reader.readBit();
            const profileIdc = reader.readBits(5);

            // ISO/IEC 14496-15 Annex E.3: profile_compatibility_flags is a 32-bit field
            // where bit i indicates compatibility with profile i.
            // Value is formatted as hex: sum_{i=0..31} flag[i] * 2^i
            let profileCompat = 0;
            for (let i = 0; i < 32; i++) {
                const bit = reader.readBit();
                if (bit) {
                    profileCompat |= 1 << i;
                }
            }
            // For standard RFC 6381 codec string, profile_compatibility_flags in hex
            // Maps bit 1 (Main) -> 2, bit 2 (Main 10) -> 4 => 6 for Main
            let compatHex = (profileCompat >>> 0).toString(16).toUpperCase();
            if (!compatHex || compatHex === '0') {
                compatHex = '6'; // Standard Main profile compatibility fallback
            }

            reader.skipBits(4); // progressive_source_flag, interlaced_source_flag, non_packed_constraint_flag, frame_only_constraint_flag
            reader.skipBits(44); // reserved constraint flags
            const levelIdc = reader.readBits(8);

            const subLayerProfilePresentFlag: number[] = [];
            const subLayerLevelPresentFlag: number[] = [];
            for (let i = 0; i < spsMaxSubLayersMinus1; i++) {
                subLayerProfilePresentFlag.push(reader.readBit());
                subLayerLevelPresentFlag.push(reader.readBit());
            }
            if (spsMaxSubLayersMinus1 > 0) {
                for (let i = spsMaxSubLayersMinus1; i < 8; i++) {
                    reader.skipBits(2);
                }
            }
            for (let i = 0; i < spsMaxSubLayersMinus1; i++) {
                if (subLayerProfilePresentFlag[i]) {
                    reader.skipBits(88);
                }
                if (subLayerLevelPresentFlag[i]) {
                    reader.skipBits(8);
                }
            }

            reader.readUE(); // sps_seq_parameter_set_id
            const chromaFormatIdc = reader.readUE();
            if (chromaFormatIdc === 3) {
                reader.skipBits(1); // separate_colour_plane_flag
            }

            let width = reader.readUE();
            let height = reader.readUE();

            const conformanceWindowFlag = reader.readBit();
            if (conformanceWindowFlag) {
                const confWinLeftOffset = reader.readUE();
                const confWinRightOffset = reader.readUE();
                const confWinTopOffset = reader.readUE();
                const confWinBottomOffset = reader.readUE();

                const subWidthC = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1;
                const subHeightC = chromaFormatIdc === 1 ? 2 : 1;

                width -= (confWinLeftOffset + confWinRightOffset) * subWidthC;
                height -= (confWinTopOffset + confWinBottomOffset) * subHeightC;
            }

            const tier = tierFlag ? 'H' : 'L';
            const profileSpaceStr = ['', 'A', 'B', 'C'][profileSpace] || '';
            const codec = `hev1.${profileSpaceStr}${profileIdc || 1}.${compatHex}.${tier}${levelIdc || 120}.B0`;

            return {
                codec,
                width: width > 0 ? width : 1080,
                height: height > 0 ? height : 1920,
            };
        } catch (e) {
            console.warn('[H265Parser] Failed to parse SPS, using safe defaults:', e);
            return {
                codec: 'hev1.1.6.L120.B0',
                width: 1080,
                height: 1920,
            };
        }
    }
}
