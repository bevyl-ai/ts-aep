/**
 * Format options enumerations for After Effects output modules.
 */

import { defineEnum } from "../../pyrt/index.ts";
import type { EnumValue } from "../../pyrt/index.ts";

/**
 * Cineon output file format type.
 *
 * Not available in ExtendScript.
 */
export const CineonFileFormat = defineEnum("CineonFileFormat", {
  FIDO_CINEON: 0,
  DPX: 1,
});
export type CineonFileFormat = EnumValue<typeof CineonFileFormat>;

/**
 * JPEG format option type.
 *
 * Not available in ExtendScript.
 */
export const JpegFormatType = defineEnum("JpegFormatType", {
  BASELINE_STANDARD: 0,
  BASELINE_OPTIMIZED: 1,
  PROGRESSIVE: 2,
});
export type JpegFormatType = EnumValue<typeof JpegFormatType>;

/**
 * PNG compression / interlace mode.
 *
 * Not available in ExtendScript.
 */
export const PngCompression = defineEnum("PngCompression", {
  NONE: 0,
  INTERLACED: 1,
});
export type PngCompression = EnumValue<typeof PngCompression>;

/**
 * Color primaries for HDR10 metadata embedded in PNG exports.
 *
 * Not available in ExtendScript.
 */
export const Hdr10ColorPrimaries = defineEnum("Hdr10ColorPrimaries", {
  REC709: 0,
  P3_D65: 1,
  REC2020: 2,
});
export type Hdr10ColorPrimaries = EnumValue<typeof Hdr10ColorPrimaries>;

/**
 * OpenEXR compression method.
 *
 * Not available in ExtendScript.
 */
export const OpenExrCompression = defineEnum("OpenExrCompression", {
  NONE: 0,
  RLE: 1,
  ZIP: 2,
  ZIP16: 3,
  PIZ: 4,
  PXR24: 5,
  B44: 6,
  B44A: 7,
  DWAA: 8,
  DWAB: 9,
  HTJ2K_256: 10,
  HTJ2K_32: 11,
});
export type OpenExrCompression = EnumValue<typeof OpenExrCompression>;

/**
 * H.264 encoding profile (the `Profile` dropdown).
 *
 * Stored in the `ADBEVideoMPEGProfile` XML parameter, except for
 * `BASELINE`: After Effects writes NO parameter at all for Baseline, so
 * it is represented by the `-1` sentinel (assigning it removes the
 * parameter; reading an absent parameter returns it). `-1` is never
 * stored in a file.
 *
 * The dropdown's `Auto` is resolved at save time and is not a distinct
 * stored value - an Auto module was observed storing `1`, so it reads
 * back as `MAIN`.
 *
 * Values mapped from AE 2026-authored samples. `2` is unobserved (the
 * dropdown offers no fifth profile), so it is absent from this enum and
 * reads back as a raw `int` if a file ever holds it.
 *
 * Not available in ExtendScript.
 */
export const MPEGProfile = defineEnum("MPEGProfile", {
  BASELINE: -1,
  MAIN: 1,
  HIGH: 3,
  HIGH10: 4,
});
export type MPEGProfile = EnumValue<typeof MPEGProfile>;

/**
 * DNxHR / DNxHD resolution preset.
 *
 * The `Resolution` dropdown of the DNxHR/DNxHD codec options, stored in
 * the `ADBEVideoResolution` XML parameter. Only meaningful when the
 * module's `videoCodec` is `VideoCodec.DNXHR_DNXHD`; the parameter
 * survives a codec change, so it can read back stale under another codec.
 *
 * Member names follow the dropdown labels. Ids are a contiguous
 * 1001-1019 block, mapped one-to-one from AE 2026-authored samples
 * (`samples/models/format_options/dnx/`).
 *
 * Not available in ExtendScript.
 */
export const DnxResolution = defineEnum("DnxResolution", {
  DNXHD_720P_HQX_10_BIT: 1001,
  DNXHD_720P_HQ_8_BIT: 1002,
  DNXHD_720P_SQ_8_BIT: 1003,
  DNXHD_720P_SQ_THIN_RASTER_8_BIT: 1004,
  DNXHD_1080I_HQX_10_BIT: 1005,
  DNXHD_1080I_HQ_8_BIT: 1006,
  DNXHD_1080I_SQ_8_BIT: 1007,
  DNXHD_1080I_SQ_THIN_RASTER_8_BIT: 1008,
  DNXHD_1080P_RGB_444_10_BIT: 1009,
  DNXHD_1080P_HQX_10_BIT: 1010,
  DNXHD_1080P_HQ_8_BIT: 1011,
  DNXHD_1080P_SQ_8_BIT: 1012,
  DNXHD_1080P_SQ_THIN_RASTER_8_BIT: 1013,
  DNXHD_1080P_LB_8_BIT: 1014,
  DNXHR_RGB_444_12_BIT: 1015,
  DNXHR_HQX_10_BIT: 1016,
  DNXHR_HQ_8_BIT: 1017,
  DNXHR_SQ_8_BIT: 1018,
  DNXHR_LB_8_BIT: 1019,
});
export type DnxResolution = EnumValue<typeof DnxResolution>;

/**
 * Audio codec identifier stored as a 32-bit integer.
 *
 * These values are extracted from the `ADBEAudioCodec` parameter in the
 * XML-based format options of output modules (AVI, H.264, MP3, QuickTime,
 * WAV).
 *
 * Not available in ExtendScript.
 */
export const AudioCodec = defineEnum("AudioCodec", {
  /** Uncompressed / PCM audio. */
  UNCOMPRESSED: 1380013856,

  /** IMA ADPCM. */
  IMA_ADPCM: 1,

  /** Microsoft ADPCM. */
  MICROSOFT_ADPCM: 2,

  /** CCITT A-Law. */
  CCITT_A_LAW: 3,

  /** CCITT u-Law. */
  CCITT_U_LAW: 4,

  /** GSM 6.10. */
  GSM_6_10: 5,

  /** AAC (Advanced Audio Coding) (FourCC `'AAC '`). */
  AAC: 1094796064,

  /** HE-AAC / AAC+ Version 1 (FourCC `'AAC1'`). */
  AAC_PLUS_V1: 1094796081,

  /** HE-AACv2 / AAC+ Version 2 (FourCC `'AAC2'`). */
  AAC_PLUS_V2: 1094796082,
});
export type AudioCodec = EnumValue<typeof AudioCodec>;

/**
 * Video codec FourCC identifier stored.
 *
 * These values are extracted from the `ADBEVideoCodec` parameter in the
 * XML-based format options of output modules (AVI, H.264, QuickTime).
 *
 * Not available in ExtendScript.
 */
export const VideoCodec = defineEnum("VideoCodec", {
  /** No codec / uncompressed DIB (FourCC `' BID'`). */
  NONE: 541215044,

  /** V210 10-bit YUV (FourCC `'012v'`). AVI variant. */
  V210: 808530550,

  /** Uncompressed YUV 8 bit 4:2:2 (FourCC `'2vuy'`). */
  UNCOMPRESSED_YUV_8_BIT_422: 846624121,

  /** DNxHR/DNxHD (FourCC `'AVdn'`). */
  DNXHR_DNXHD: 1096180846,

  /** GoPro CineForm (FourCC `'CFHD'`). */
  GOPRO_CINEFORM: 1128679492,

  /** Intel IYUV codec (FourCC `'VUYI'`). */
  INTEL_IYUV: 1448433993,

  /** Uncompressed UYVY 422 8-bit (FourCC `'YVYU'`). AVI variant. */
  UYVY: 1498831189,

  /** Apple ProRes 422 (FourCC `'apcn'`). */
  APPLE_PRORES_422: 1634755438,

  /** Apple ProRes 422 HQ (FourCC `'apch'`). */
  APPLE_PRORES_422_HQ: 1634755432,

  /** Apple ProRes 422 LT (FourCC `'apcs'`). */
  APPLE_PRORES_422_LT: 1634755443,

  /** Apple ProRes 422 Proxy (FourCC `'apco'`). */
  APPLE_PRORES_422_PROXY: 1634755439,

  /** Apple ProRes 4444 (FourCC `'ap4h'`). */
  APPLE_PRORES_4444: 1634743400,

  /** Apple ProRes 4444 XQ (FourCC `'ap4x'`). */
  APPLE_PRORES_4444_XQ: 1634743416,

  /** H.264 / AVC (FourCC `'avc1'`). */
  AVC1: 1635148593,

  /** DV25 NTSC (FourCC `'dvc '`). */
  DV25_NTSC: 1685480224,

  /** DV25 PAL (FourCC `'dvcp'`). */
  DV25_PAL: 1685480304,

  /** DV50 NTSC (FourCC `'dv5n'`). */
  DV50_NTSC: 1685468526,

  /** DV50 PAL (FourCC `'dv5p'`). */
  DV50_PAL: 1685468528,

  /** DV 24p Advanced (FourCC `'dsv2'`). AVI variant. */
  DV_24P: 1685288498,

  /** DV NTSC (FourCC `'dsvn'`). AVI variant. */
  DV_NTSC: 1685288558,

  /** DV PAL (FourCC `'dsvp'`). AVI variant. */
  DV_PAL: 1685288560,

  /** DVCPRO HD 1080i50 (FourCC `'dvh5'`). */
  DVCPRO_HD_1080I50: 1685481525,

  /** DVCPRO HD 1080i60 (FourCC `'dvh6'`). */
  DVCPRO_HD_1080I60: 1685481526,

  /** DVCPRO HD 1080p25 (FourCC `'dvh2'`). */
  DVCPRO_HD_1080P25: 1685481522,

  /** DVCPRO HD 1080p30 (FourCC `'dvh3'`). */
  DVCPRO_HD_1080P30: 1685481523,

  /** DVCPRO HD 720p50 (FourCC `'dvhq'`). */
  DVCPRO_HD_720P50: 1685481585,

  /** DVCPRO HD 720p60 (FourCC `'dvhp'`). */
  DVCPRO_HD_720P60: 1685481584,

  /** DV25 NTSC 24p (FourCC `'pr24'`). */
  DV25_NTSC_24P: 1886532148,

  /** None (Uncompressed RGB 8-bit) (FourCC `'raw '`). */
  UNCOMPRESSED_RGB_8_BIT: 1918990112,

  /** Animation / RLE (FourCC `'rle '`). */
  ANIMATION: 1919706400,

  /** Uncompressed YUV 10 bit 4:2:2 (FourCC `'v210'`). */
  UNCOMPRESSED_YUV_10_BIT_422: 1983000880,
});
export type VideoCodec = EnumValue<typeof VideoCodec>;

/**
 * AVI audio interleave interval.
 *
 * These values are extracted from the `ADBEAudioInterleave` parameter in
 * the XML-based format options of AVI output modules. The dialog's
 * `null` choice stores no parameter at all (the accessor reads `null`).
 *
 * Not available in ExtendScript.
 */
export const AudioInterleave = defineEnum("AudioInterleave", {
  ONE_FRAME: 1,
  HALF_SECOND: 2,
  ONE_SECOND: 3,
  TWO_SECONDS: 4,
});
export type AudioInterleave = EnumValue<typeof AudioInterleave>;

/**
 * MPEG-1 audio layer.
 *
 * These values are extracted from the `ADBEMPEGAudioLayer` parameter in
 * the XML-based format options of H.264 output modules (only meaningful
 * when the audio format is MPEG).
 *
 * Not available in ExtendScript.
 */
export const MPEGAudioLayer = defineEnum("MPEGAudioLayer", {
  LAYER_I: 1,
  LAYER_II: 2,
});
export type MPEGAudioLayer = EnumValue<typeof MPEGAudioLayer>;

/**
 * MPEG audio format identifier.
 *
 * The dialog's top-level `Audio Format` dropdown (AAC / MPEG / PCM) for
 * H.264 output modules; despite the `MPEG` prefix in the parameter name
 * it selects among all three families (AE-sample verified).
 *
 * These values are extracted from the `ADBEMPEGAudioFormat` parameter in
 * the XML-based format options of output modules (H.264, QuickTime).
 *
 * Not available in ExtendScript.
 */
export const MPEGAudioFormat = defineEnum("MPEGAudioFormat", {
  /** AAC (Advanced Audio Coding) (FourCC `'AAC '`). */
  AAC: 1094796064,

  /** MPEG audio (FourCC `'MPEG'`). */
  MPEG: 1297106247,

  /** PCM / uncompressed audio (FourCC `'PCM '`). */
  PCM: 1346587936,
});
export type MPEGAudioFormat = EnumValue<typeof MPEGAudioFormat>;

/**
 * MPEG multiplexer identifier.
 *
 * These values are extracted from the `ADBEMPEGMultiplexer` parameter in
 * the XML-based format options of output modules (H.264, QuickTime).
 *
 * Not available in ExtendScript.
 */
export const MPEGMultiplexer = defineEnum("MPEGMultiplexer", {
  /** 3GPP container (FourCC `'3GPP'`). */
  THREEGPP: 860311632,

  /** MP4 container (FourCC `'MP4 '`). */
  MP4: 1297101856,

  /** No multiplexer (FourCC `'NONE'`). */
  NONE: 1313820229,
});
export type MPEGMultiplexer = EnumValue<typeof MPEGMultiplexer>;

/**
 * MPEG mux stream compatibility identifier.
 *
 * These values are extracted from the `ADBEMPEGMuxStreamCompatibility`
 * parameter in the XML-based format options of output modules (H.264, QuickTime).
 *
 * Not available in ExtendScript.
 */
export const MPEGMuxStreamCompatibility = defineEnum("MPEGMuxStreamCompatibility", {
  /** iPod compatibility (FourCC `'IPOD'`). */
  IPOD: 1229999940,

  /** PSP compatibility (FourCC `'PSP '`). */
  PSP: 1347637280,

  /** Standard compatibility (FourCC `'STD '`). */
  STD: 1398031392,
});
export type MPEGMuxStreamCompatibility = EnumValue<typeof MPEGMuxStreamCompatibility>;
