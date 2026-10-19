/**
 * Output module enumerations for After Effects.
 *
 * These enums match the values used in After Effects ExtendScript.
 */

// Python IntEnum members are plain numbers here, so instance
// `@property`s (`label`, `kind`, `toFormatId`, `toBinary`) are enum methods
// taking the member as `self`, e.g. `OutputChannels.label(member)`; same
// values and lookups as the Python properties. Applies to every enum here.

import { ValueError, getOrThrow, literal, defineEnum } from "../../pyrt/index.ts";
import type { EnumValue } from "../../pyrt/index.ts";

/**
 * Output channels setting.
 *
 * Used in OutputModule Settings \> Channels
 *
 * Not documented in AE scripting reference.
 */
export const OutputChannels = defineEnum(
  "OutputChannels",
  {
    RGB: 0,
    RGBA: 1,
    ALPHA: 2,
  },
  {
    /** ExtendScript STRING format label. */
    label(self: OutputChannels): string {
      return _OUTPUT_CHANNELS_LABELS[self];
    },
  },
);
export type OutputChannels = EnumValue<typeof OutputChannels>;

const _OUTPUT_CHANNELS_LABELS: Readonly<Record<OutputChannels, string>> = {
  0: "RGB",
  1: "RGB + Alpha",
  2: "Alpha",
};

/**
 * Output color depth in total bits per pixel.
 *
 * The value represents total bits per pixel: 24 or 32 for 8 bpc
 * (with/without alpha), 48 or 64 for 16 bpc, 96 or 128 for 32 bpc
 * (floating point). The `+` label suffix indicates alpha is included.
 *
 * Used in OutputModule Settings \> Depth
 *
 * Not documented in AE scripting reference.
 */
export const OutputColorDepth = defineEnum(
  "OutputColorDepth",
  {
    FLOATING_POINT_GRAY: -32, // 32 bpc gray (single channel float)
    COLORS_256: 8, // 8 bpc indexed (256 colors)
    MILLIONS_OF_COLORS: 24, // 8 bpc RGB (24 bpp)
    MILLIONS_OF_COLORS_PLUS: 32, // 8 bpc RGBA (32 bpp)
    GRAYS_256: 40, // 8 bpc grayscale (256 grays)
    TRILLIONS_OF_COLORS: 48, // 16 bpc RGB (48 bpp)
    TRILLIONS_OF_COLORS_PLUS: 64, // 16 bpc RGBA (64 bpp)
    FLOATING_POINT: 96, // 32 bpc RGB (96 bpp)
    FLOATING_POINT_PLUS: 128, // 32 bpc RGBA (128 bpp)
  },
  {
    /** ExtendScript STRING format label. */
    label(self: OutputColorDepth): string {
      return _OUTPUT_COLOR_DEPTH_LABELS[self];
    },
  },
);
export type OutputColorDepth = EnumValue<typeof OutputColorDepth>;

const _OUTPUT_COLOR_DEPTH_LABELS: Readonly<Record<OutputColorDepth, string>> = {
  "-32": "Floating Point Gray",
  8: "256 Colors",
  24: "Millions of Colors",
  32: "Millions of Colors+",
  40: "256 Grays",
  48: "Trillions of Colors",
  64: "Trillions of Colors+",
  96: "Floating Point",
  128: "Floating Point+",
};

/**
 * Output color mode (premultiplied vs straight).
 *
 * Used in OutputModule Settings \> Color
 *
 * Not documented in AE scripting reference.
 */
export const OutputColorMode = defineEnum(
  "OutputColorMode",
  {
    STRAIGHT_UNMATTED: 0,
    PREMULTIPLIED: 1,
  },
  {
    /** ExtendScript STRING format label. */
    label(self: OutputColorMode): string {
      return _OUTPUT_COLOR_MODE_LABELS[self];
    },
  },
);
export type OutputColorMode = EnumValue<typeof OutputColorMode>;

const _OUTPUT_COLOR_MODE_LABELS: Readonly<Record<OutputColorMode, string>> = {
  0: "Straight (Unmatted)",
  1: "Premultiplied (Matted)",
};

/**
 * Audio output mode.
 *
 * Used in OutputModule Settings \> Output Audio
 *
 * Not documented in AE scripting reference.
 */
export const OutputAudio = defineEnum(
  "OutputAudio",
  {
    OFF: 1,
    ON: 2,
    AUTO: 3,
  },
  {
    /** ExtendScript STRING format label. */
    label(self: OutputAudio): string {
      return _OUTPUT_AUDIO_LABELS[self];
    },
  },
);
export type OutputAudio = EnumValue<typeof OutputAudio>;

const _OUTPUT_AUDIO_LABELS: Readonly<Record<OutputAudio, string>> = {
  1: "Off",
  2: "On",
  3: "Auto",
};

/**
 * Output plugin capability class.
 *
 * Mirrors the capability flags an AE output plugin declares
 * (`AEIO_MFlag_FILE_SEQUENCE` / `_VIDEO` / `_AUDIO` in the AE SDK's
 * `AE_IO.h`). The `.aep` binary carries no such flag (all `Rouu`
 * reserved bytes are identical across formats), so the classification
 * is static data keyed by the format identity.
 *
 * Not available in ExtendScript.
 */
export const FormatKind = defineEnum("FormatKind", {
  /** Audio stream only (AIFF, MP3, WAV): video output is always off. */
  AUDIO: 1,
  /** Single movie file, video and/or audio (AVI, H.264, QuickTime). */
  MOVIE: 2,
  /** One still image per frame (TIFF, PNG, ...): audio is always off. */
  SEQUENCE: 3,
});
export type FormatKind = EnumValue<typeof FormatKind>;

/**
 * Output file format.
 *
 * Used in OutputModule Settings \> Format
 *
 * Not documented in AE scripting reference.
 */
export const OutputFormat = defineEnum(
  "OutputFormat",
  {
    AIFF: 0,
    AVI: 1,
    DPX_CINEON_SEQUENCE: 2,
    H264: 3,
    IFF_SEQUENCE: 4,
    JPEG_SEQUENCE: 5,
    MP3: 6,
    OPENEXR_SEQUENCE: 7,
    PNG_SEQUENCE: 8,
    PHOTOSHOP_SEQUENCE: 9,
    QUICKTIME: 10,
    RADIANCE_SEQUENCE: 11,
    SGI_SEQUENCE: 12,
    TIFF_SEQUENCE: 13,
    TARGA_SEQUENCE: 14,
    WAV: 15,
  },
  {
    /** ExtendScript STRING format label. */
    label(self: keyof typeof _OUTPUT_FORMAT_LABELS): string {
      return _OUTPUT_FORMAT_LABELS[self];
    },

    /**
     * Whether this format is an audio file, a movie, or a still
     * sequence. See {@link FormatKind}.
     */
    kind(self: number): FormatKind {
      return getOrThrow(_OUTPUT_FORMAT_KINDS, self);
    },

    /**
     * Convert a Roou 4-char format identifier to OutputFormat.
     *
     * @param formatId - The 4-char format identifier from the Roou chunk (e.g. `"H264"`, `"TIF "`,
     *   `"png!"`).
     * @throws {@link ValueError} If the format identifier is not recognised.
     */
    fromFormatId(formatId: string | Uint8Array): OutputFormat {
      if (formatId instanceof Uint8Array) {
        formatId = new TextDecoder().decode(formatId);
      }
      const format = _FORMAT_ID_TO_OUTPUT_FORMAT.get(formatId);
      if (format === undefined) throw new ValueError(`Unknown output format identifier: ${literal(formatId)}`);
      return format;
    },

    /** Convert OutputFormat to a Roou 4-char format identifier. */
    toFormatId(self: number): string {
      return getOrThrow(_OUTPUT_FORMAT_TO_FORMAT_ID, self);
    },
  },
);
export type OutputFormat = EnumValue<typeof OutputFormat>;

export const _OUTPUT_FORMAT_LABELS = {
  0: "AIFF",
  1: "AVI",
  2: "DPX/Cineon Sequence",
  3: "H.264",
  4: "IFF Sequence",
  5: "JPEG Sequence",
  6: "MP3",
  7: "OpenEXR Sequence",
  8: "PNG Sequence",
  9: "Photoshop Sequence",
  10: "QuickTime",
  11: "Radiance Sequence",
  12: "SGI Sequence",
  13: "TIFF Sequence",
  14: "Targa Sequence",
  15: "WAV",
} as const;

// Explicit classification (see FormatKind): never derive this from names -
// OM/template names are user-defined and the binary has no category flag.
const _OUTPUT_FORMAT_KINDS: Map<number, FormatKind> = new Map<number, FormatKind>([
  [OutputFormat.AIFF, FormatKind.AUDIO],
  [OutputFormat.AVI, FormatKind.MOVIE],
  [OutputFormat.DPX_CINEON_SEQUENCE, FormatKind.SEQUENCE],
  [OutputFormat.H264, FormatKind.MOVIE],
  [OutputFormat.IFF_SEQUENCE, FormatKind.SEQUENCE],
  [OutputFormat.JPEG_SEQUENCE, FormatKind.SEQUENCE],
  [OutputFormat.MP3, FormatKind.AUDIO],
  [OutputFormat.OPENEXR_SEQUENCE, FormatKind.SEQUENCE],
  [OutputFormat.PNG_SEQUENCE, FormatKind.SEQUENCE],
  [OutputFormat.PHOTOSHOP_SEQUENCE, FormatKind.SEQUENCE],
  [OutputFormat.QUICKTIME, FormatKind.MOVIE],
  [OutputFormat.RADIANCE_SEQUENCE, FormatKind.SEQUENCE],
  [OutputFormat.SGI_SEQUENCE, FormatKind.SEQUENCE],
  [OutputFormat.TIFF_SEQUENCE, FormatKind.SEQUENCE],
  [OutputFormat.TARGA_SEQUENCE, FormatKind.SEQUENCE],
  [OutputFormat.WAV, FormatKind.AUDIO],
]);

const _FORMAT_ID_TO_OUTPUT_FORMAT: Map<string, OutputFormat> = new Map<string, OutputFormat>([
  ["AIFF", OutputFormat.AIFF],
  [".AVI", OutputFormat.AVI],
  ["sDPX", OutputFormat.DPX_CINEON_SEQUENCE],
  ["H264", OutputFormat.H264],
  ["IFF ", OutputFormat.IFF_SEQUENCE],
  ["JPEG", OutputFormat.JPEG_SEQUENCE],
  ["Mp3 ", OutputFormat.MP3],
  ["oEXR", OutputFormat.OPENEXR_SEQUENCE],
  ["png!", OutputFormat.PNG_SEQUENCE],
  ["8BPS", OutputFormat.PHOTOSHOP_SEQUENCE],
  ["MooV", OutputFormat.QUICKTIME],
  ["RHDR", OutputFormat.RADIANCE_SEQUENCE],
  ["SGI ", OutputFormat.SGI_SEQUENCE],
  ["TIF ", OutputFormat.TIFF_SEQUENCE],
  ["TPIC", OutputFormat.TARGA_SEQUENCE],
  ["wao_", OutputFormat.WAV],
]);

const _OUTPUT_FORMAT_TO_FORMAT_ID: Map<number, string> = new Map<number, string>(
  Array.from(_FORMAT_ID_TO_OUTPUT_FORMAT, ([k, v]): [number, string] => [v, k]),
);

/**
 * Audio bit depth.
 *
 * Used in OutputModule Settings \> Audio \> Format
 *
 * Not documented in AE scripting reference.
 */
export const AudioBitDepth = defineEnum(
  "AudioBitDepth",
  {
    EIGHT_BIT: 1,
    SIXTEEN_BIT: 2,
    /**
     * Read only: After Effects has no 24-bit audio output, so writing it
     * raises `ValueError`.
     */
    TWENTY_FOUR_BIT: 3,
    THIRTY_TWO_BIT: 4,
  },
  {
    /** ExtendScript STRING format label. */
    label(self: AudioBitDepth): string {
      return _AUDIO_BIT_DEPTH_LABELS[self];
    },

    /** Convert binary value to AudioBitDepth. */
    fromBinary(value: number) {
      if (this.has(value)) {
        return this.of(value);
      }
      return this.THIRTY_TWO_BIT;
    },
  },
);
export type AudioBitDepth = EnumValue<typeof AudioBitDepth>;

const _AUDIO_BIT_DEPTH_LABELS: Readonly<Record<AudioBitDepth, string>> = {
  1: "8 Bit",
  2: "16 Bit",
  3: "24 Bit",
  4: "32 Bit",
};

/**
 * Audio channels.
 *
 * Used in OutputModule Settings \> Audio \> Channels
 *
 * Not documented in AE scripting reference.
 */
export const AudioChannels = defineEnum(
  "AudioChannels",
  {
    MONO: 1,
    STEREO: 2,
  },
  {
    /** ExtendScript STRING format label. */
    label(self: AudioChannels): string {
      return _AUDIO_CHANNELS_LABELS[self];
    },

    /** Convert binary value to AudioChannels (0 or unknown defaults to STEREO). */
    fromBinary(value: number) {
      if (value === 1) {
        return this.MONO;
      }
      return this.STEREO;
    },
  },
);
export type AudioChannels = EnumValue<typeof AudioChannels>;

const _AUDIO_CHANNELS_LABELS: Readonly<Record<AudioChannels, string>> = {
  1: "Mono",
  2: "Stereo",
};

/**
 * Resize quality setting.
 *
 * Used in OutputModule Settings \> Stretch \> Quality
 *
 * Not documented in AE scripting reference.
 */
export const ResizeQuality = defineEnum(
  "ResizeQuality",
  {
    LOW: 0,
    HIGH: 1,
  },
  {
    /** ExtendScript STRING format label. */
    label(self: ResizeQuality): string {
      return _RESIZE_QUALITY_LABELS[self];
    },
  },
);
export type ResizeQuality = EnumValue<typeof ResizeQuality>;

const _RESIZE_QUALITY_LABELS: Readonly<Record<ResizeQuality, string>> = {
  0: "Low",
  1: "High",
};

/**
 * Audio sample rate in Hz.
 *
 * Standard sample rates available in After Effects output module
 * audio settings.
 *
 * Used in OutputModule Settings \> Audio \> Sample Rate
 *
 * Not documented in AE scripting reference.
 */
export const AudioSampleRate = defineEnum(
  "AudioSampleRate",
  {
    OFF: -1,
    RATE_8000: 8000,
    RATE_11025: 11025,
    /**
     * Only reachable through MP3 mono at 18/20 kbps (AE-saved evidence);
     * no other format offers it.
     */
    RATE_12000: 12000,
    RATE_16000: 16000,
    RATE_22050: 22050,
    RATE_24000: 24000,
    RATE_32000: 32000,
    RATE_44100: 44100,
    RATE_48000: 48000,
    RATE_88200: 88200,
    RATE_96000: 96000,
  },
  {
    /** ExtendScript STRING format label (e.g. `"48.000 kHz"`). */
    label(self: number): string {
      if (self <= 0) {
        return "";
      }
      return `${(self / 1000).toFixed(3)} kHz`;
    },

    /**
     * Convert binary audio sample rate value.
     *
     * The binary field is stored as `f8` (float).
     *
     * Unknown or negative values (e.g. `-1` when audio is disabled)
     * are mapped to `OFF`.
     */
    fromBinary(value: number) {
      const intValue = Math.round(value) + 0;
      if (this.has(intValue)) {
        return this.of(intValue);
      }
      return this.OFF;
    },

    /** Convert to binary float for the `f8` field. */
    toBinary(value: number): number {
      return Math.round(value) + 0;
    },
  },
);
export type AudioSampleRate = EnumValue<typeof AudioSampleRate>;

/**
 * Convert to Linear Light output module setting.
 *
 * Controls whether the output is converted to linear light color space
 * during rendering. When enabled only for 32 bpc, the conversion is
 * skipped for projects rendered at lower bit depths.
 *
 * Used in OutputModule Settings \> Color Management \> Convert to Linear Light
 *
 * Not documented in AE scripting reference.
 */
export const ConvertToLinearLight = defineEnum(
  "ConvertToLinearLight",
  {
    OFF: 0,
    ON: 1,
    ON_FOR_32_BPC: 2,
  },
  {
    /** ExtendScript STRING format label. */
    label(self: ConvertToLinearLight): string {
      return _CONVERT_TO_LINEAR_LIGHT_LABELS[self];
    },
  },
);
export type ConvertToLinearLight = EnumValue<typeof ConvertToLinearLight>;

const _CONVERT_TO_LINEAR_LIGHT_LABELS: Readonly<Record<ConvertToLinearLight, string>> = {
  0: "Off",
  1: "On",
  2: "On for 32 bpc",
};

/** Action after rendering completes. */
export const PostRenderAction = defineEnum(
  "PostRenderAction",
  {
    NONE: 3612,
    IMPORT: 3613,
    IMPORT_AND_REPLACE_USAGE: 3614,
    SET_PROXY: 3615,
  },
  {
    /** Convert binary value to PostRenderAction. */
    fromBinary(value: number) {
      return this.ofOrNull(value + 3612) ?? this.NONE;
    },

    /** Convert PostRenderAction to binary value. */
    toBinary(self: number): number {
      return Math.trunc(self) - 3612;
    },
  },
);
export type PostRenderAction = EnumValue<typeof PostRenderAction>;
