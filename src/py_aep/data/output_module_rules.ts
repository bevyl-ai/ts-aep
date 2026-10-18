/**
 * Allowed values for output-module settings, per format / codec / context.
 *
 * Encodes what After Effects' Output Module Settings dialog allows for each
 * output format: which settings are locked by the format kind (audio formats
 * never have video output), which value sets each format offers (PNG has no
 * floating-point depth), and which values depend on other settings (WAV's
 * GSM codec forces mono, PNG forces straight alpha only when channels are
 * RGB+Alpha).
 *
 * Sources: AE 2025/2026 dialog research (`format_rules.txt`) cross-checked
 * against AE-saved samples in `samples/models/format_options/`,
 * `samples/models/renderqueue/` and `samples/unused/output_module_settings/`.
 * Where the notes and the binaries disagreed, the binaries won (e.g. the
 * QuickTime depth union, and PNG's Color byte being free when channels are
 * plain RGB).
 *
 * Lookup contract (`allowedValues`):
 * - `null` means UNCONSTRAINED - the key has no rule under this format and
 *   context. (Contrast `data/file_formats.py`, where an empty result means
 *   "nothing allowed": callers here must gate on `== null` first.)
 * - Constraint keys are the ExtendScript setting names from `OM_SETTINGS`
 *   (e.g. `"Depth"`, `"Audio Sample Rate"`) plus format-option context keys
 *   (e.g. `"Audio Codec"`, `"BitRate"`).
 * - Conditional entries are ordered general -\> specific; a later matching
 *   entry REPLACES earlier constraints per key. Entries constraining the
 *   same key within one format must have mutually exclusive conditions.
 * - A condition key absent from the context never matches (permissive
 *   degradation: stale or unparseable context disables the rule, it never
 *   rejects).
 */

import { AudioBitDepth, AudioChannels, AudioCodec, FormatKind, MPEGAudioFormat, MPEGAudioLayer, MPEGMultiplexer, OutputAudio, OutputChannels, OutputColorDepth, OutputColorMode, OutputFormat, VideoCodec } from "../enums/index.ts";
import { contains, getOrThrow, valueEquals, setdefault } from "../../pyrt/index.ts";

/**
 * One conditional rule: (conditions, constraints). Every condition must
 * match the context (an array value means "in"); constraints then apply.
 */
export type RuleValue = number | string | boolean;
export type Rule = [Map<string, RuleValue | RuleValue[]>, Map<string, ReadonlySet<RuleValue>>];
export type Constraints = Map<string, ReadonlySet<RuleValue>>;

export const _MILLIONS = OutputColorDepth.MILLIONS_OF_COLORS;
export const _MILLIONS_PLUS = OutputColorDepth.MILLIONS_OF_COLORS_PLUS;
export const _TRILLIONS = OutputColorDepth.TRILLIONS_OF_COLORS;
export const _TRILLIONS_PLUS = OutputColorDepth.TRILLIONS_OF_COLORS_PLUS;
export const _FLOAT = OutputColorDepth.FLOATING_POINT;
export const _FLOAT_PLUS = OutputColorDepth.FLOATING_POINT_PLUS;

export const _8_TO_16_BPC: ReadonlySet<RuleValue> = new Set([_MILLIONS, _MILLIONS_PLUS, _TRILLIONS, _TRILLIONS_PLUS]);
export const _8_TO_32_BPC: ReadonlySet<RuleValue> = new Set([..._8_TO_16_BPC, _FLOAT, _FLOAT_PLUS]);

export const _RGB_OR_ALPHA: ReadonlySet<RuleValue> = new Set([OutputChannels.RGB, OutputChannels.ALPHA]);

// Rates AE offers for plain PCM-style audio (AIFF, WAV Uncompressed, AVI).
export const _PCM_RATES: ReadonlySet<RuleValue> = new Set([8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000]);

// WAV ADPCM/GSM codecs offer this reduced set; A-Law/u-Law add 16000.
export const _ADPCM_RATES: ReadonlySet<RuleValue> = new Set([8000, 11025, 22050, 44100]);
export const _CCITT_RATES: ReadonlySet<RuleValue> = new Set([..._ADPCM_RATES, 16000]);

export const _SIXTEEN_BIT_ONLY: ReadonlySet<RuleValue> = new Set([AudioBitDepth.SIXTEEN_BIT]);

export const _KIND_RULES = new Map<FormatKind, Constraints>([
  [
    FormatKind.AUDIO,
    new Map<string, ReadonlySet<RuleValue>>([
      ["Video Output", new Set([false])],
      ["Output Audio", new Set([OutputAudio.ON])],
    ]),
  ],
  [FormatKind.MOVIE, new Map<string, ReadonlySet<RuleValue>>([])],
  [
    FormatKind.SEQUENCE,
    new Map<string, ReadonlySet<RuleValue>>([
      ["Video Output", new Set([true])],
      ["Output Audio", new Set([OutputAudio.OFF])],
    ]),
  ],
]);

export const _FORMAT_RULES = new Map<OutputFormat, Constraints>([
  [
    OutputFormat.AIFF,
    new Map<string, ReadonlySet<RuleValue>>([["Audio Sample Rate", _PCM_RATES]]),
  ],
  [
    OutputFormat.AVI,
    new Map<string, ReadonlySet<RuleValue>>([
      // 48/64 only reachable via V210 (union over codecs); the 64
      // entry keeps the channels<->depth pairing closed under RGBA.
      ["Depth", new Set([_MILLIONS, _MILLIONS_PLUS, _TRILLIONS, _TRILLIONS_PLUS])],
      ["Audio Sample Rate", _PCM_RATES],
    ]),
  ],
  [
    OutputFormat.DPX_CINEON_SEQUENCE,
    new Map<string, ReadonlySet<RuleValue>>([["Depth", new Set([_TRILLIONS, _TRILLIONS_PLUS])]]),
  ],
  [
    OutputFormat.H264,
    new Map<string, ReadonlySet<RuleValue>>([
      ["Channels", _RGB_OR_ALPHA],
      ["Depth", new Set([_MILLIONS])],
      // Union over audio formats: AAC set + MPEG {32k,44.1k,48k} + PCM
      // {48k,96k}; conditional rows narrow per Audio Format.
      ["Audio Sample Rate", new Set([16000, 22050, 24000, 32000, 44100, 48000, 96000])],
    ]),
  ],
  [
    OutputFormat.IFF_SEQUENCE,
    new Map<string, ReadonlySet<RuleValue>>([["Depth", _8_TO_16_BPC]]),
  ],
  [
    OutputFormat.JPEG_SEQUENCE,
    new Map<string, ReadonlySet<RuleValue>>([
      ["Channels", _RGB_OR_ALPHA],
      ["Depth", new Set([_MILLIONS])],
    ]),
  ],
  [
    OutputFormat.MP3,
    new Map<string, ReadonlySet<RuleValue>>([
      // The depth control is hidden; AE always stores 16-bit (verified
      // across the 18-bitrate sweep in samples/unused/output_module_settings).
      ["Audio Bit Depth", _SIXTEEN_BIT_ONLY],
      // Union over (bitrate, channels) pairs observed in AE-saved files
      // (12000 comes from mono at 18/20 kbps).
      ["Audio Sample Rate", new Set([8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000])],
    ]),
  ],
  [
    OutputFormat.OPENEXR_SEQUENCE,
    new Map<string, ReadonlySet<RuleValue>>([["Depth", new Set([_FLOAT, _FLOAT_PLUS])]]),
  ],
  [
    OutputFormat.PNG_SEQUENCE,
    new Map<string, ReadonlySet<RuleValue>>([["Depth", _8_TO_16_BPC]]),
  ],
  [
    OutputFormat.PHOTOSHOP_SEQUENCE,
    new Map<string, ReadonlySet<RuleValue>>([["Depth", _8_TO_32_BPC]]),
  ],
  [
    OutputFormat.QUICKTIME,
    new Map<string, ReadonlySet<RuleValue>>([
      // Alpha IS QuickTime-legal despite the dialog research notes:
      // AE's own factory template "High Quality with Alpha" writes a
      // QT Rouu with depth 32 (millions+), and alpha-capable codecs
      // (Animation, ProRes 4444, ...) offer RGB+Alpha. 48 comes from
      // the 10-bit YUV codecs (AE-saved sample evidence). Which codecs
      // allow alpha is future per-codec narrowing.
      ["Depth", new Set([_MILLIONS, _MILLIONS_PLUS, _TRILLIONS, _TRILLIONS_PLUS])],
    ]),
  ],
  [
    OutputFormat.RADIANCE_SEQUENCE,
    new Map<string, ReadonlySet<RuleValue>>([
      ["Channels", _RGB_OR_ALPHA],
      ["Depth", new Set([_FLOAT])],
    ]),
  ],
  [
    OutputFormat.SGI_SEQUENCE,
    new Map<string, ReadonlySet<RuleValue>>([["Depth", _8_TO_16_BPC]]),
  ],
  [
    OutputFormat.TIFF_SEQUENCE,
    new Map<string, ReadonlySet<RuleValue>>([["Depth", _8_TO_32_BPC]]),
  ],
  [
    OutputFormat.TARGA_SEQUENCE,
    new Map<string, ReadonlySet<RuleValue>>([["Depth", new Set([_MILLIONS, _MILLIONS_PLUS])]]),
  ],
  [
    OutputFormat.WAV,
    new Map<string, ReadonlySet<RuleValue>>([
      // Unions over codecs; per-codec rows below narrow them.
      ["Audio Sample Rate", _PCM_RATES],
      [
        "Audio Bit Depth",
        new Set([AudioBitDepth.EIGHT_BIT, AudioBitDepth.SIXTEEN_BIT, AudioBitDepth.THIRTY_TWO_BIT]),
      ],
    ]),
  ],
]);

// Format-option fields each format's dialog offers (member sets for the
// codec/container dropdowns and the MP3 bitrate list).
getOrThrow(_FORMAT_RULES, OutputFormat.AVI).set(
  "Video Codec",
  new Set([
    VideoCodec.NONE,
    VideoCodec.V210,
    VideoCodec.UYVY,
    VideoCodec.INTEL_IYUV,
    VideoCodec.DV_24P,
    VideoCodec.DV_NTSC,
    VideoCodec.DV_PAL,
  ]),
);
getOrThrow(_FORMAT_RULES, OutputFormat.AVI).set("Audio Codec", new Set([AudioCodec.UNCOMPRESSED]));
getOrThrow(_FORMAT_RULES, OutputFormat.H264).set(
  "Audio Codec",
  new Set([AudioCodec.AAC, AudioCodec.AAC_PLUS_V1, AudioCodec.AAC_PLUS_V2]),
);
getOrThrow(_FORMAT_RULES, OutputFormat.H264).set(
  "Multiplexer",
  new Set([MPEGMultiplexer.MP4, MPEGMultiplexer.THREEGPP, MPEGMultiplexer.NONE]),
);
getOrThrow(_FORMAT_RULES, OutputFormat.MP3).set(
  "BitRate",
  new Set([16, 18, 20, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]),
);
getOrThrow(_FORMAT_RULES, OutputFormat.WAV).set(
  "Audio Codec",
  new Set([
    AudioCodec.UNCOMPRESSED,
    AudioCodec.IMA_ADPCM,
    AudioCodec.MICROSOFT_ADPCM,
    AudioCodec.CCITT_A_LAW,
    AudioCodec.CCITT_U_LAW,
    AudioCodec.GSM_6_10,
  ]),
);
getOrThrow(_FORMAT_RULES, OutputFormat.QUICKTIME).set(
  "Video Codec",
  new Set([
    VideoCodec.ANIMATION,
    VideoCodec.APPLE_PRORES_422,
    VideoCodec.APPLE_PRORES_422_HQ,
    VideoCodec.APPLE_PRORES_422_LT,
    VideoCodec.APPLE_PRORES_422_PROXY,
    VideoCodec.APPLE_PRORES_4444,
    VideoCodec.APPLE_PRORES_4444_XQ,
    VideoCodec.DNXHR_DNXHD,
    VideoCodec.DV25_NTSC,
    VideoCodec.DV25_NTSC_24P,
    VideoCodec.DV25_PAL,
    VideoCodec.DV50_NTSC,
    VideoCodec.DV50_PAL,
    VideoCodec.DVCPRO_HD_1080I50,
    VideoCodec.DVCPRO_HD_1080I60,
    VideoCodec.DVCPRO_HD_1080P25,
    VideoCodec.DVCPRO_HD_1080P30,
    VideoCodec.DVCPRO_HD_720P50,
    VideoCodec.DVCPRO_HD_720P60,
    VideoCodec.GOPRO_CINEFORM,
    VideoCodec.AVC1,
    VideoCodec.UNCOMPRESSED_RGB_8_BIT,
    VideoCodec.UNCOMPRESSED_YUV_10_BIT_422,
    VideoCodec.UNCOMPRESSED_YUV_8_BIT_422,
  ]),
);

// The H.264 AAC audio-bitrate matrix: (codec, rate group, channels) ->
// allowed kbps. The kbps ladders are irregular (not simple slices), so
// they are transcribed literally from the AE dialog research.
export function _aacBitrateRows(): Rule[] {
  const rows: Rule[] = [];
  const matrix: [AudioCodec, [number[], AudioChannels, number[]][]][] = [
    [
      AudioCodec.AAC,
      [
        [[16000], AudioChannels.MONO, [16, 20, 24, 28, 32, 40, 48, 56, 64, 80]],
        [[16000], AudioChannels.STEREO, [16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160]],
        [[22050, 24000], AudioChannels.MONO, [16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 112, 128]],
        [
          [22050, 24000],
          AudioChannels.STEREO,
          [16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256],
        ],
        [[32000], AudioChannels.MONO, [16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160]],
        [
          [32000],
          AudioChannels.STEREO,
          [16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
        ],
        [
          [44100, 48000],
          AudioChannels.MONO,
          [16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256],
        ],
        [
          [44100, 48000],
          AudioChannels.STEREO,
          [
            16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512,
          ],
        ],
      ],
    ],
    [
      AudioCodec.AAC_PLUS_V1,
      [
        [[16000], AudioChannels.MONO, [16, 20, 24, 28, 32, 40]],
        [[16000], AudioChannels.STEREO, [16, 20, 24, 28, 32, 40, 48, 56]],
        [[22050, 24000], AudioChannels.MONO, [16, 20, 24, 28, 32, 40, 48]],
        [[22050, 24000], AudioChannels.STEREO, [16, 20, 24, 28, 32, 40, 48, 56, 64]],
        [[32000], AudioChannels.MONO, [16, 20, 24, 28, 32, 40, 48, 56]],
        [[32000], AudioChannels.STEREO, [24, 28, 32, 40, 48, 56, 64, 80]],
        [[44100, 48000], AudioChannels.MONO, [16, 20, 24, 28, 32, 40, 48, 56, 64]],
        [[44100, 48000], AudioChannels.STEREO, [32, 40, 48, 56, 64, 80, 96]],
      ],
    ],
    [
      AudioCodec.AAC_PLUS_V2,
      [
        [[16000], AudioChannels.STEREO, [16, 20, 24, 28, 32, 40]],
        [[22050, 24000], AudioChannels.STEREO, [16, 20, 24, 28, 32, 40, 48]],
        [[32000], AudioChannels.STEREO, [16, 20, 24, 28, 32, 40, 48, 56]],
        [[44100, 48000], AudioChannels.STEREO, [16, 20, 24, 28, 32, 40, 48, 56, 64]],
      ],
    ],
  ];
  for (const [codec, groups] of matrix) {
    for (const [rates, channels, kbps] of groups) {
      const rateCond: number | number[] = rates.length > 1 ? rates : rates[0];
      rows.push([
        new Map<string, RuleValue | RuleValue[]>([
          ["Audio Format", MPEGAudioFormat.AAC],
          ["Audio Codec", codec],
          ["Audio Sample Rate", rateCond],
          ["Audio Channels", channels],
        ]),
        new Map<string, ReadonlySet<RuleValue>>([["Audio Bitrate", new Set(kbps)]]),
      ]);
    }
  }
  return rows;
}

// Ordered general -> specific; a later match replaces earlier constraints
// per key. Same-key entries within a format must be mutually exclusive.
export const _CONDITIONAL_RULES = new Map<OutputFormat, Rule[]>([
  [
    OutputFormat.AVI,
    [
      [
        new Map<string, RuleValue | RuleValue[]>([["Video Codec", VideoCodec.NONE]]),
        new Map<string, ReadonlySet<RuleValue>>([
          ["Channels", new Set([OutputChannels.RGB, OutputChannels.RGBA, OutputChannels.ALPHA])],
          ["Depth", new Set([_MILLIONS, _MILLIONS_PLUS])],
        ]),
      ],
      [
        new Map<string, RuleValue | RuleValue[]>([
          [
            "Video Codec",
            [
              VideoCodec.DV_24P,
              VideoCodec.DV_NTSC,
              VideoCodec.DV_PAL,
              VideoCodec.INTEL_IYUV,
              VideoCodec.UYVY,
            ],
          ],
        ]),
        new Map<string, ReadonlySet<RuleValue>>([
          ["Channels", _RGB_OR_ALPHA],
          ["Depth", new Set([_MILLIONS])],
        ]),
      ],
      [
        new Map<string, RuleValue | RuleValue[]>([["Video Codec", VideoCodec.V210]]),
        new Map<string, ReadonlySet<RuleValue>>([
          ["Channels", _RGB_OR_ALPHA],
          ["Depth", new Set([_TRILLIONS])],
        ]),
      ],
    ],
  ],
  [
    OutputFormat.H264,
    [
      [
        new Map<string, RuleValue | RuleValue[]>([["Audio Format", MPEGAudioFormat.AAC]]),
        new Map<string, ReadonlySet<RuleValue>>([
          ["Audio Sample Rate", new Set([16000, 22050, 24000, 32000, 44100, 48000])],
        ]),
      ],
      [
        new Map<string, RuleValue | RuleValue[]>([["Audio Format", MPEGAudioFormat.MPEG]]),
        new Map<string, ReadonlySet<RuleValue>>([["Audio Sample Rate", new Set([32000, 44100, 48000])]]),
      ],
      [
        new Map<string, RuleValue | RuleValue[]>([["Audio Format", MPEGAudioFormat.PCM]]),
        new Map<string, ReadonlySet<RuleValue>>([["Audio Sample Rate", new Set([48000, 96000])]]),
      ],
    ],
  ],
  [
    OutputFormat.OPENEXR_SEQUENCE,
    [
      // The premultiplied/straight choice only exists when alpha is
      // included; with plain RGB the stored byte is inert and AE-saved
      // files hold either value.
      [
        new Map<string, RuleValue | RuleValue[]>([["Channels", OutputChannels.RGBA]]),
        new Map<string, ReadonlySet<RuleValue>>([["Color", new Set([OutputColorMode.PREMULTIPLIED])]]),
      ],
    ],
  ],
  [
    OutputFormat.PNG_SEQUENCE,
    [
      [
        new Map<string, RuleValue | RuleValue[]>([["Channels", OutputChannels.RGBA]]),
        new Map<string, ReadonlySet<RuleValue>>([["Color", new Set([OutputColorMode.STRAIGHT_UNMATTED])]]),
      ],
    ],
  ],
  [
    OutputFormat.MP3,
    // (bitrate kbps, channels) -> the single sample rate AE resolves,
    // decoded from the AE-saved sweeps in
    // samples/unused/output_module_settings/mp3_*.aep (18 stereo
    // files + 4 mono probes). The research notes' mono/stereo
    // columns were swapped wholesale relative to these binaries
    // (every mono probe matches the notes' "stereo" column, incl.
    // the 12000 Hz rows); the binaries won.
    ([
      [
        AudioChannels.STEREO,
        [
          [16, 8000],
          [18, 8000],
          [20, 11025],
          [24, 11025],
          [32, 16000],
          [40, 16000],
          [48, 22050],
          [56, 22050],
          [64, 24000],
          [80, 24000],
          [96, 32000],
          [112, 44100],
          [128, 44100],
          [160, 44100],
          [192, 44100],
          [224, 44100],
          [256, 44100],
          [320, 48000],
        ],
      ],
      [
        AudioChannels.MONO,
        [
          [16, 11025],
          [18, 12000],
          [20, 12000],
          [24, 16000],
          [32, 22050],
          [40, 22050],
          [48, 24000],
          [56, 32000],
          [64, 44100],
          [80, 44100],
          [96, 44100],
          [112, 44100],
          [128, 44100],
          [160, 44100],
          [192, 44100],
          [224, 44100],
          [256, 44100],
          [320, 44100],
        ],
      ],
    ] satisfies [AudioChannels, [number, number][]][]).flatMap(([channels, table]) =>
      table.map(
        ([kbps, rate]): Rule => [
          new Map<string, RuleValue | RuleValue[]>([
            ["BitRate", kbps],
            ["Audio Channels", channels],
          ]),
          new Map<string, ReadonlySet<RuleValue>>([["Audio Sample Rate", new Set([rate])]]),
        ],
      ),
    ),
  ],
  [
    OutputFormat.WAV,
    [
      [
        new Map<string, RuleValue | RuleValue[]>([["Audio Codec", AudioCodec.UNCOMPRESSED]]),
        new Map<string, ReadonlySet<RuleValue>>([
          ["Audio Sample Rate", _PCM_RATES],
          [
            "Audio Bit Depth",
            new Set([AudioBitDepth.EIGHT_BIT, AudioBitDepth.SIXTEEN_BIT, AudioBitDepth.THIRTY_TWO_BIT]),
          ],
        ]),
      ],
      [
        new Map<string, RuleValue | RuleValue[]>([["Audio Codec", [AudioCodec.IMA_ADPCM, AudioCodec.MICROSOFT_ADPCM]]]),
        new Map<string, ReadonlySet<RuleValue>>([
          ["Audio Sample Rate", _ADPCM_RATES],
          ["Audio Bit Depth", _SIXTEEN_BIT_ONLY],
        ]),
      ],
      [
        new Map<string, RuleValue | RuleValue[]>([["Audio Codec", [AudioCodec.CCITT_A_LAW, AudioCodec.CCITT_U_LAW]]]),
        new Map<string, ReadonlySet<RuleValue>>([
          ["Audio Sample Rate", _CCITT_RATES],
          ["Audio Bit Depth", _SIXTEEN_BIT_ONLY],
        ]),
      ],
      [
        new Map<string, RuleValue | RuleValue[]>([["Audio Codec", AudioCodec.GSM_6_10]]),
        new Map<string, ReadonlySet<RuleValue>>([
          ["Audio Sample Rate", _ADPCM_RATES],
          ["Audio Bit Depth", _SIXTEEN_BIT_ONLY],
          // AE forces mono for GSM and writes the byte (sample-verified).
          ["Audio Channels", new Set([AudioChannels.MONO])],
        ]),
      ],
    ],
  ],
]);

// The container gates which audio families exist; the MPEG layer gates
// the kbps ladder (transcribed literally - the ladders are irregular).
getOrThrow(_CONDITIONAL_RULES, OutputFormat.H264).push(
  [
    new Map<string, RuleValue | RuleValue[]>([["Multiplexer", MPEGMultiplexer.MP4]]),
    new Map<string, ReadonlySet<RuleValue>>([["Audio Format", new Set([MPEGAudioFormat.AAC, MPEGAudioFormat.MPEG])]]),
  ],
  [
    new Map<string, RuleValue | RuleValue[]>([["Multiplexer", MPEGMultiplexer.THREEGPP]]),
    new Map<string, ReadonlySet<RuleValue>>([["Audio Format", new Set([MPEGAudioFormat.AAC])]]),
  ],
  [
    new Map<string, RuleValue | RuleValue[]>([["Multiplexer", MPEGMultiplexer.NONE]]),
    new Map<string, ReadonlySet<RuleValue>>([
      ["Audio Format", new Set([MPEGAudioFormat.AAC, MPEGAudioFormat.MPEG, MPEGAudioFormat.PCM])],
    ]),
  ],
  [
    new Map<string, RuleValue | RuleValue[]>([
      ["Audio Format", MPEGAudioFormat.MPEG],
      ["Audio Layer", MPEGAudioLayer.LAYER_I],
    ]),
    new Map<string, ReadonlySet<RuleValue>>([
      ["Audio Bitrate", new Set([128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448])],
    ]),
  ],
  [
    new Map<string, RuleValue | RuleValue[]>([
      ["Audio Format", MPEGAudioFormat.MPEG],
      ["Audio Layer", MPEGAudioLayer.LAYER_II],
      ["Audio Channels", AudioChannels.MONO],
    ]),
    new Map<string, ReadonlySet<RuleValue>>([["Audio Bitrate", new Set([64, 96, 112, 128, 160, 192])]]),
  ],
  [
    new Map<string, RuleValue | RuleValue[]>([
      ["Audio Format", MPEGAudioFormat.MPEG],
      ["Audio Layer", MPEGAudioLayer.LAYER_II],
      ["Audio Channels", AudioChannels.STEREO],
    ]),
    new Map<string, ReadonlySet<RuleValue>>([
      ["Audio Bitrate", new Set([64, 96, 112, 128, 160, 192, 224, 256, 320, 384])],
    ]),
  ],
  // HE-AACv2 is parametric stereo: mono is not offered at all.
  [
    new Map<string, RuleValue | RuleValue[]>([["Audio Codec", AudioCodec.AAC_PLUS_V2]]),
    new Map<string, ReadonlySet<RuleValue>>([["Audio Channels", new Set([AudioChannels.STEREO])]]),
  ],
);
getOrThrow(_CONDITIONAL_RULES, OutputFormat.H264).push(..._aacBitrateRows());

// NOTE: Targa's bits-per-pixel radio is NOT coupled to the OM channels
// in the binary: AE-saved files hold RGB + 32 bpp (targa/base.aep) AND
// RGB+Alpha + 24 bpp (tga_rgba.aep) - the Ropt byte only changes when
// the Targa Options dialog itself is visited, like Cineon's FIDO
// bit_depth. The OM Depth setting is the authoritative alpha/depth
// choice; bits_per_pixel is validated as 24/32 only.


// AE keeps the depth paired to the alpha choice: with RGB+Alpha channels
// the dialog offers only "+" depths, with RGB/Alpha only base depths
// (438 video-on corpus modules, 0 exceptions). Encode the pairing as
// generated conditional rows so Depth writes, validate_state and batch
// exits all enforce it through the ordinary lookup. Inserted FIRST so
// codec-specific Depth rows still win the general->specific merge.
export const _PLUS_DEPTHS: ReadonlySet<RuleValue> = new Set([_MILLIONS_PLUS, _TRILLIONS_PLUS, _FLOAT_PLUS]);
for (const [_fmt, _fmtRules] of _FORMAT_RULES) {
  const _depths = _fmtRules.get("Depth") ?? null;
  if (_depths == null) continue;
  const _rows = setdefault(_CONDITIONAL_RULES, _fmt, []);
  const _rgbaDepths = new Set([..._depths].filter((d) => _PLUS_DEPTHS.has(d)));
  if (_rgbaDepths.size > 0) {
    _rows.unshift([new Map<string, RuleValue | RuleValue[]>([["Channels", OutputChannels.RGBA]]), new Map<string, ReadonlySet<RuleValue>>([["Depth", _rgbaDepths]])]);
  }
  const _baseDepths = new Set([..._depths].filter((d) => !_PLUS_DEPTHS.has(d)));
  if (_baseDepths.size > 0) {
    _rows.unshift([
      new Map<string, RuleValue | RuleValue[]>([["Channels", [OutputChannels.RGB, OutputChannels.ALPHA]]]),
      new Map<string, ReadonlySet<RuleValue>>([["Depth", _baseDepths]]),
    ]);
  }
}


// Context keys whose write re-resolves dependent settings (the keys AE's
// dialog re-clamps when the value changes). Consumed by the write hooks in
// XmlFormatOptions and OutputModule via
// `OutputModule._apply_singleton_clamps`.
export const CLAMP_DEPENDENTS: Map<string, readonly string[]> = new Map<string, readonly string[]>([
  // Order matters: channels first, so a forced mono (GSM) feeds the
  // rate/depth lookups that follow.
  ["Audio Codec", ["Audio Channels", "Audio Sample Rate", "Audio Bit Depth"]],
  ["Audio Format", ["Audio Sample Rate"]],
  ["BitRate", ["Audio Sample Rate"]],
  ["Multiplexer", ["Audio Format"]],
  ["Video Codec", ["Depth"]],
]);


/**
 * True when every condition matches the context.
 *
 * An array condition value means "in"; a context key that is absent
 * never matches (permissive degradation).
 */
export function _conditionsMatch(conditions: Map<string, RuleValue | RuleValue[]>, context: ReadonlyMap<string, RuleValue>): boolean {
  for (const [key, expected] of conditions) {
    const actual = context.get(key) ?? null;
    if (actual == null) return false;
    if (Array.isArray(expected)) {
      if (!contains(expected, actual)) return false;
    } else if (!valueEquals(actual, expected)) {
      return false;
    }
  }
  return true;
}

/**
 * Every setting key that has (or can have) a rule under `fmt`.
 *
 * Drives whole-state validation (`OutputModule.validateState`): keys
 * outside this set are unconstrained for the format and never checked.
 */
export function constrainedKeys(fmt: OutputFormat): ReadonlySet<string> {
  const keys = new Set<string>(getOrThrow(_KIND_RULES, OutputFormat.kind(fmt)).keys());
  for (const k of (_FORMAT_RULES.get(fmt) ?? new Map<string, ReadonlySet<RuleValue>>()).keys()) keys.add(k);
  for (const [, constraints] of (_CONDITIONAL_RULES.get(fmt) ?? [])) {
    for (const k of constraints.keys()) keys.add(k);
  }
  return new Set(keys);
}

/**
 * Allowed values for an output-module setting under `fmt`.
 *
 * @param fmt - The output format of the module.
 * @param key - The setting name (`OM_SETTINGS` key or format-option context key, e.g. `"Depth"`,
 *   `"Audio Codec"`).
 * @param context - Current values of the other settings, used to match conditional rules. Missing
 *   keys disable the rules that need them.
 * @returns The allowed value set, or `null` when unconstrained.
 */
export function allowedValues(
  fmt: OutputFormat,
  key: string,
  context: ReadonlyMap<string, RuleValue> | null = null,
): ReadonlySet<RuleValue> | null {
  const rules = new Map<string, ReadonlySet<RuleValue>>();
  for (const [k, v] of getOrThrow(_KIND_RULES, OutputFormat.kind(fmt))) rules.set(k, v);
  for (const [k, v] of (_FORMAT_RULES.get(fmt) ?? new Map<string, ReadonlySet<RuleValue>>())) rules.set(k, v);
  if (context == null) context = new Map<string, RuleValue>();
  for (const [conditions, constraints] of (_CONDITIONAL_RULES.get(fmt) ?? [])) {
    if (_conditionsMatch(conditions, context)) {
      for (const [k, v] of constraints) rules.set(k, v);
    }
  }
  return rules.get(key) ?? null;
}
