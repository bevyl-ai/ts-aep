/** Tests for OutputModule.formatOptions parsing. */

// `from __future__ import annotations` is dropped: no annotation here is
// evaluated at runtime. `pytest.approx` is the pyrt `approx` (pytest.ts), so
// `x == pytest.approx(y)` becomes `expect(approx(x, y)).toBe(true)`.

import { describe, expect, test } from "bun:test";

import { Path, contains, getOr, getOrThrow, len, valueEquals } from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { parseProject } from "../conftest.ts";
import { asInstance } from "../helpers.ts";
import { CineonRoptChunk, OpenExrRoptChunk } from "../../src/py_aep/binary/render_chunks.ts";
import { findByType } from "../../src/py_aep/binary/utils.ts";
import { AudioCodec, CineonFileFormat, Hdr10ColorPrimaries, JpegFormatType, MPEGAudioFormat, MPEGMultiplexer, MPEGMuxStreamCompatibility, OpenExrCompression, PngCompression, VideoCodec } from "../../src/py_aep/enums/index.ts";
import { RenderQueue } from "../../src/py_aep/models/renderqueue/render_queue.ts";
import { CineonFormatOptions, JpegFormatOptions, OpenExrFormatOptions, PngFormatOptions, TargaFormatOptions, TiffFormatOptions, XmlFormatOptions } from "../../src/py_aep/models/renderqueue/format_options/index.ts";
import { approx } from "../support/pytest.ts";

// Python `Path(__file__).parent.parent.parent` is the repo root. A TS file's
// `import.meta.dir` is already its directory, so two `.parent` steps reach it.
const FORMAT_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "format_options");
const CINEON_DIR = FORMAT_DIR.div("cineon");
const AVI_DIR = FORMAT_DIR.div("avi");

test.each([
  ["cineon", CineonRoptChunk],
  ["openexr", OpenExrRoptChunk],
])("test_ropt_defaults_are_after_effects_bytes[%#]", (folder: string, chunkCls: typeof CineonRoptChunk | typeof OpenExrRoptChunk) => {
  // A fresh chunk reproduces the Ropt AE 2026 writes for the format's
  // default output module (black point 0; DWA compression level 45).
  const project = parseProject(FORMAT_DIR.div(folder, "base.aep"));
  const lom = asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0]._parentRqi._lom;
  const aeRopt = findByType(lom.chunks, "Ropt");
  expect(valueEquals(new chunkCls({}).tobytes(), aeRopt.tobytes())).toBe(true);
});

/** Parse a Cineon sample and return its CineonFormatOptions. */
function _cineonOpts(name: string): CineonFormatOptions {
  const project = parseProject(CINEON_DIR.div(`${name}.aep`));
  const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, CineonFormatOptions);
  expect(opts instanceof CineonFormatOptions).toBe(true);
  return opts;
}

/** Parse an AVI sample and return its XmlFormatOptions. */
function _aviOpts(name: string): XmlFormatOptions {
  const project = parseProject(AVI_DIR.div(`${name}.aep`));
  const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, XmlFormatOptions);
  expect(opts instanceof XmlFormatOptions).toBe(true);
  return opts;
}

/** Parse a sample from the given format dir and return XmlFormatOptions. */
function _formatOpts(fmtDir: string, name = "base"): XmlFormatOptions {
  const project = parseProject(FORMAT_DIR.div(fmtDir, `${name}.aep`));
  const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, XmlFormatOptions);
  expect(opts instanceof XmlFormatOptions).toBe(true);
  return opts;
}

/** Tests for Cineon/DPX format options parsed from Ropt chunks. */
describe("TestCineonFormatOptions", () => {
  /** Base Cineon sample has expected default values. */
  test("test_base_defaults", () => {
    const opts = _cineonOpts("base");
    expect(opts.tenBitBlackPoint).toBe(0);
    expect(opts.tenBitWhitePoint).toBe(1023);
    expect(opts.convertedBlackPoint).toBe(0.0);
    expect(opts.convertedWhitePoint).toBe(1.0);
    expect(opts.currentGamma).toBe(1.0);
    expect(opts.highlightExpansion).toBe(0);
    expect(opts.logarithmicConversion).toBe(false);
    expect(opts.fileFormat).toBe(CineonFileFormat.DPX);
    expect(opts.bitDepth).toBe(10);
  });

  // --- 10-bit black point ---

  test("test_10_bit_black_point_1", () => {
    const opts = _cineonOpts("10_bit_black_point_1");
    expect(opts.tenBitBlackPoint).toBe(1);
  });

  test("test_10_bit_black_point_1023", () => {
    const opts = _cineonOpts("10_bit_black_point_1023");
    expect(opts.tenBitBlackPoint).toBe(1023);
  });

  // --- 10-bit white point ---

  test("test_10_bit_white_point_0", () => {
    const opts = _cineonOpts("10_bit_white_point_0");
    expect(opts.tenBitWhitePoint).toBe(0);
  });

  test("test_10_bit_white_point_1021", () => {
    const opts = _cineonOpts("10_bit_white_point_1021");
    expect(opts.tenBitWhitePoint).toBe(1021);
  });

  // --- converted black point ---

  test("test_converted_black_point_1", () => {
    const opts = _cineonOpts("converted_black_point_1");
    expect(approx(opts.convertedBlackPoint, 1.0 / 255.0)).toBe(true);
  });

  test("test_converted_black_point_2", () => {
    const opts = _cineonOpts("converted_black_point_2");
    expect(approx(opts.convertedBlackPoint, 2.0 / 255.0)).toBe(true);
  });

  test("test_converted_black_point_255", () => {
    const opts = _cineonOpts("converted_black_point_255");
    expect(approx(opts.convertedBlackPoint, 1.0)).toBe(true);
  });

  // --- converted white point ---

  test("test_converted_white_point_0", () => {
    const opts = _cineonOpts("converted_white_point_0");
    expect(approx(opts.convertedWhitePoint, 0.0)).toBe(true);
  });

  test("test_converted_white_point_253", () => {
    const opts = _cineonOpts("converted_white_point_253");
    expect(approx(opts.convertedWhitePoint, 253.0 / 255.0)).toBe(true);
  });

  test("test_converted_white_point_32767", () => {
    const opts = _cineonOpts("converted_white_point_32767");
    expect(approx(opts.convertedWhitePoint, 32767.0 / 32768.0)).toBe(true);
  });

  test("test_converted_white_point_0_987", () => {
    const opts = _cineonOpts("converted_white_point_0.987");
    expect(approx(opts.convertedWhitePoint, 0.987)).toBe(true);
  });

  // --- current gamma ---

  test("test_current_gamma_0_01", () => {
    const opts = _cineonOpts("current_gamma_0.01");
    expect(approx(opts.currentGamma, 0.01)).toBe(true);
  });

  test("test_current_gamma_1_1", () => {
    const opts = _cineonOpts("current_gamma_1.1");
    expect(approx(opts.currentGamma, 1.1)).toBe(true);
  });

  test("test_current_gamma_5", () => {
    const opts = _cineonOpts("current_gamma_5");
    expect(approx(opts.currentGamma, 5.0)).toBe(true);
  });

  // --- logarithmic conversion ---

  test("test_logarithmic_conversion_on", () => {
    // Note: filename has typo "logarighmic"
    const opts = _cineonOpts("logarighmic_conversion_on");
    expect(opts.logarithmicConversion).toBe(true);
  });

  test("test_logarithmic_conversion_off", () => {
    const opts = _cineonOpts("logarighmic_conversion_off");
    expect(opts.logarithmicConversion).toBe(false);
  });

  // --- file format and bit depth ---

  test("test_file_format_dpx_8", () => {
    const opts = _cineonOpts("file_format_dpx_8");
    expect(opts.fileFormat).toBe(CineonFileFormat.DPX);
    expect(opts.bitDepth).toBe(8);
  });

  test("test_file_format_dpx_10", () => {
    const opts = _cineonOpts("file_format_dpx_10");
    expect(opts.fileFormat).toBe(CineonFileFormat.DPX);
    expect(opts.bitDepth).toBe(10);
  });

  test("test_file_format_dpx_12", () => {
    const opts = _cineonOpts("file_format_dpx_12");
    expect(opts.fileFormat).toBe(CineonFileFormat.DPX);
    expect(opts.bitDepth).toBe(12);
  });

  test("test_file_format_dpx_16", () => {
    const opts = _cineonOpts("file_format_dpx_16");
    expect(opts.fileFormat).toBe(CineonFileFormat.DPX);
    expect(opts.bitDepth).toBe(16);
  });

  /** FIDO/Cineon 4.5 format. */
  test("test_file_format_fido", () => {
    const opts = _cineonOpts("file_format_fido");
    expect(opts.fileFormat).toBe(CineonFileFormat.FIDO_CINEON);
  });

  // --- highlight expansion ---

  test("test_highlight_expansion_0", () => {
    const opts = _cineonOpts("highlight_expansion_0");
    expect(opts.highlightExpansion).toBe(0);
  });

  test("test_highlight_expansion_1", () => {
    const opts = _cineonOpts("highlight_expansion_1");
    expect(opts.highlightExpansion).toBe(1);
  });

  test("test_highlight_expansion_150", () => {
    const opts = _cineonOpts("highlight_expansion_150");
    expect(opts.highlightExpansion).toBe(150);
  });
});

/** Tests for AVI format options parsed from Ropt chunks (now XmlFormatOptions). */
describe("TestAviFormatOptions", () => {
  /** AVI base sample has expected default values. */
  test("test_base_defaults", () => {
    const opts = _aviOpts("base");
    expect(opts.formatCode).toBe(".AVI");
    expect(opts.videoCodec).toBe(VideoCodec.NONE);
    expect(opts.audioCodec).toBe(AudioCodec.UNCOMPRESSED);
    expect(opts.frameRate).toBe(24.0);
    expect(contains(opts.params, "ADBEVideoCodec")).toBe(true);
    expect(contains(opts.params, "ADBEVideoQuality")).toBe(true);
    expect(contains(opts.params, "ADBEVideoWidth")).toBe(true);
    expect(contains(opts.params, "ADBEVideoHeight")).toBe(true);
  });

  // --- video codecs ---

  /** DV 24p Advanced codec maps to VideoCodec.DV_24P. */
  test("test_video_codec_dv_24p_advanced", () => {
    const opts = _aviOpts("video_codec_dv_24p_advanced");
    expect(opts.videoCodec).toBe(VideoCodec.DV_24P);
  });

  /** DV NTSC codec maps to VideoCodec.DV_NTSC. */
  test("test_video_codec_dv_ntsc", () => {
    const opts = _aviOpts("video_codec_dv_ntsc");
    expect(opts.videoCodec).toBe(VideoCodec.DV_NTSC);
  });

  /** DV PAL codec maps to VideoCodec.DV_PAL. */
  test("test_video_codec_dv_pal", () => {
    const opts = _aviOpts("video_codec_dv_pal");
    expect(opts.videoCodec).toBe(VideoCodec.DV_PAL);
  });

  /** Intel IYUV codec maps to VideoCodec.INTEL_IYUV. */
  test("test_video_codec_intel_iyuv", () => {
    const opts = _aviOpts("video_codec_intel_iyuv_codec");
    expect(opts.videoCodec).toBe(VideoCodec.INTEL_IYUV);
  });

  /** Uncompressed UYVY 422 8bit maps to VideoCodec.UYVY. */
  test("test_video_codec_uyvy_422", () => {
    const opts = _aviOpts("video_codec_uncompressed_uyvy_422_8bit");
    expect(opts.videoCodec).toBe(VideoCodec.UYVY);
  });

  /** V210 10-bit YUV maps to VideoCodec.V210. */
  test("test_video_codec_v210", () => {
    const opts = _aviOpts("video_codec_v210_10-bit_yuv");
    expect(opts.videoCodec).toBe(VideoCodec.V210);
  });

  // --- audio interleave ---

  /** Audio interleave 'None' has no ADBEAudioInterleave param. */
  test("test_audio_interleave_none", () => {
    const opts = _aviOpts("audio_interleave_none");
    expect(getOr(opts.params, "ADBEAudioInterleave")).toBe(null);
  });

  test("test_audio_interleave_1_frame", () => {
    const opts = _aviOpts("audio_interleave_1_frame");
    expect(getOrThrow(opts.params, "ADBEAudioInterleave")).toBe("1");
  });

  test("test_audio_interleave_half_second", () => {
    const opts = _aviOpts("audio_interleave_half_second");
    expect(getOrThrow(opts.params, "ADBEAudioInterleave")).toBe("2");
  });

  test("test_audio_interleave_1_second", () => {
    const opts = _aviOpts("audio_interleave_1_second");
    expect(getOrThrow(opts.params, "ADBEAudioInterleave")).toBe("3");
  });

  test("test_audio_interleave_2_seconds", () => {
    const opts = _aviOpts("audio_interleave2_seconds");
    expect(getOrThrow(opts.params, "ADBEAudioInterleave")).toBe("4");
  });
});

/** Test that formats without Ropt parsing return None. */
describe("TestFormatOptionsNone", () => {
  /**
   * A format that doesn't have Ropt (or uses unsupported format)
   * should return None for format_options.
   */
  test("test_no_ropt_returns_none", () => {
    const samplesDir = new Path(import.meta.dir).parent.parent.div("samples", "models");
    const rqBase = samplesDir.div("renderqueue", "base.aep");
    const project = parseProject(rqBase);
    const om = asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0];
    expect(
      om.formatOptions == null ||
        [
          CineonFormatOptions,
          JpegFormatOptions,
          OpenExrFormatOptions,
          PngFormatOptions,
          TargaFormatOptions,
          TiffFormatOptions,
          XmlFormatOptions,
        ].some((c) => om.formatOptions instanceof c),
    ).toBe(true);
  });
});

/** Tests for H.264 format options (XML-based). */
describe("TestH264FormatOptions", () => {
  /** Base H.264 sample has expected default values. */
  test("test_base_defaults", () => {
    const opts = _formatOpts("h.264");
    expect(opts.formatCode).toBe("H264");
    expect(opts.videoCodec).toBe(VideoCodec.AVC1);
    expect(opts.audioCodec).toBe(AudioCodec.AAC);
    expect(opts.frameRate).toBe(24.0);
    expect(len(opts.params) > 0).toBe(true);
    expect(opts.mpegAudioFormat).toBe(MPEGAudioFormat.AAC);
    expect(opts.mpegMultiplexer).toBe(MPEGMultiplexer.MP4);
    expect(opts.mpegMuxStreamCompatibility).toBe(MPEGMuxStreamCompatibility.STD);
  });

  /** MPEG audio format sample has MPEG format and layer I. */
  test("test_audio_format_mpeg", () => {
    const project = parseProject(FORMAT_DIR.div("h.264", "audio_format_mpeg.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, XmlFormatOptions);
    expect(opts instanceof XmlFormatOptions).toBe(true);
    expect(opts.mpegAudioFormat).toBe(MPEGAudioFormat.MPEG);
    expect(getOrThrow(opts.params, "ADBEMPEGAudioLayer")).toBe("1");
  });

  test("test_mpeg_audio_layer_ii", () => {
    const project = parseProject(FORMAT_DIR.div("h.264", "audio_format_mpeg_layer_II.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, XmlFormatOptions);
    expect(opts instanceof XmlFormatOptions).toBe(true);
    expect(getOrThrow(opts.params, "ADBEMPEGAudioLayer")).toBe("2");
  });

  /** PCM audio format sample. */
  test("test_mpeg_audio_format_pcm", () => {
    const opts = _formatOpts("h.264", "audio_format_pcm");
    expect(opts.mpegAudioFormat).toBe(MPEGAudioFormat.PCM);
  });

  test("test_multiplexer_3gpp", () => {
    const opts = _formatOpts("h.264", "multiplexer_3gpp");
    expect(opts.mpegMultiplexer).toBe(MPEGMultiplexer.THREEGPP);
  });

  test("test_multiplexer_none", () => {
    const opts = _formatOpts("h.264", "multiplexer_none");
    expect(opts.mpegMultiplexer).toBe(MPEGMultiplexer.NONE);
  });

  test("test_audio_codec_aac_plus_v1", () => {
    const opts = _formatOpts("h.264", "audio_codec_aac+_version_1");
    expect(opts.audioCodec).toBe(AudioCodec.AAC_PLUS_V1);
  });

  test("test_audio_codec_aac_plus_v2", () => {
    const opts = _formatOpts("h.264", "audio_codec_aac+_version_2");
    expect(opts.audioCodec).toBe(AudioCodec.AAC_PLUS_V2);
  });

  test("test_stream_compat_ipod", () => {
    const opts = _formatOpts("h.264", "stream_compat_ipod");
    expect(opts.mpegMuxStreamCompatibility).toBe(MPEGMuxStreamCompatibility.IPOD);
  });

  test("test_stream_compat_psp", () => {
    const opts = _formatOpts("h.264", "stream_compat_psp");
    expect(opts.mpegMuxStreamCompatibility).toBe(MPEGMuxStreamCompatibility.PSP);
  });
});

/** Tests for MP3 format options (XML-based). */
describe("TestMp3FormatOptions", () => {
  /** MP3 base sample has expected default values. */
  test("test_base_defaults", () => {
    const opts = _formatOpts("mp3");
    expect(opts instanceof XmlFormatOptions).toBe(true);
    expect(opts.formatCode).toBe("Mp3 ");
    expect(opts.videoCodec).toBe(null);
    expect(opts.frameRate).toBe(null);
    expect(opts.audioCodec).toBe(AudioCodec.UNCOMPRESSED);
    expect(len(opts.params) > 0).toBe(true);
  });
});

/** Tests for QuickTime format options (XML-based). */
describe("TestQuickTimeFormatOptions", () => {
  /** QuickTime base sample has expected default values. */
  test("test_base_defaults", () => {
    const opts = _formatOpts("quicktime");
    expect(opts instanceof XmlFormatOptions).toBe(true);
    expect(opts.formatCode).toBe("MooV");
    expect(opts.videoCodec).toBe(VideoCodec.ANIMATION);
    expect(opts.frameRate).toBe(24.0);
    expect(opts.audioCodec).toBe(null);
    expect(opts.mpegAudioFormat).toBe(null);
    expect(opts.mpegMultiplexer).toBe(MPEGMultiplexer.MP4);
    expect(opts.mpegMuxStreamCompatibility).toBe(MPEGMuxStreamCompatibility.STD);
    expect(len(opts.params) > 0).toBe(true);
  });

  test("test_video_codec_apple_prores_422", () => {
    const opts = _formatOpts("quicktime", "apple_prores_422");
    expect(opts.videoCodec).toBe(VideoCodec.APPLE_PRORES_422);
  });

  test("test_video_codec_apple_prores_422_hq", () => {
    const opts = _formatOpts("quicktime", "apple_prores_422_hq");
    expect(opts.videoCodec).toBe(VideoCodec.APPLE_PRORES_422_HQ);
  });

  test("test_video_codec_apple_prores_422_lt", () => {
    const opts = _formatOpts("quicktime", "apple_prores_422_lt");
    expect(opts.videoCodec).toBe(VideoCodec.APPLE_PRORES_422_LT);
  });

  test("test_video_codec_apple_prores_422_proxy", () => {
    const opts = _formatOpts("quicktime", "apple_prores_422_proxy");
    expect(opts.videoCodec).toBe(VideoCodec.APPLE_PRORES_422_PROXY);
  });

  test("test_video_codec_apple_prores_4444", () => {
    const opts = _formatOpts("quicktime", "apple_prores_4444");
    expect(opts.videoCodec).toBe(VideoCodec.APPLE_PRORES_4444);
  });

  test("test_video_codec_apple_prores_4444_xq", () => {
    const opts = _formatOpts("quicktime", "apple_prores_4444_xq");
    expect(opts.videoCodec).toBe(VideoCodec.APPLE_PRORES_4444_XQ);
  });

  test("test_video_codec_dnxhr_dnxhd", () => {
    const opts = _formatOpts("quicktime", "dnxhr_dnxhd");
    expect(opts.videoCodec).toBe(VideoCodec.DNXHR_DNXHD);
  });

  test("test_video_codec_dv25_ntsc", () => {
    const opts = _formatOpts("quicktime", "dv25_ntsc");
    expect(opts.videoCodec).toBe(VideoCodec.DV25_NTSC);
  });

  test("test_video_codec_dv25_ntsc_24p", () => {
    const opts = _formatOpts("quicktime", "dv25_ntsc_24p");
    expect(opts.videoCodec).toBe(VideoCodec.DV25_NTSC_24P);
  });

  test("test_video_codec_dv25_pal", () => {
    const opts = _formatOpts("quicktime", "dv25_pal");
    expect(opts.videoCodec).toBe(VideoCodec.DV25_PAL);
  });

  test("test_video_codec_dv50_ntsc", () => {
    const opts = _formatOpts("quicktime", "dv50_ntsc");
    expect(opts.videoCodec).toBe(VideoCodec.DV50_NTSC);
  });

  test("test_video_codec_dv50_pal", () => {
    const opts = _formatOpts("quicktime", "dv50_pal");
    expect(opts.videoCodec).toBe(VideoCodec.DV50_PAL);
  });

  test("test_video_codec_dvcpro_hd_1080i50", () => {
    const opts = _formatOpts("quicktime", "dvcpro_hd_1080i50");
    expect(opts.videoCodec).toBe(VideoCodec.DVCPRO_HD_1080I50);
  });

  test("test_video_codec_dvcpro_hd_1080i60", () => {
    const opts = _formatOpts("quicktime", "dvcpro_hd_1080i60");
    expect(opts.videoCodec).toBe(VideoCodec.DVCPRO_HD_1080I60);
  });

  test("test_video_codec_dvcpro_hd_1080p25", () => {
    const opts = _formatOpts("quicktime", "dvcpro_hd_1080p25");
    expect(opts.videoCodec).toBe(VideoCodec.DVCPRO_HD_1080P25);
  });

  test("test_video_codec_dvcpro_hd_1080p30", () => {
    const opts = _formatOpts("quicktime", "dvcpro_hd_1080p30");
    expect(opts.videoCodec).toBe(VideoCodec.DVCPRO_HD_1080P30);
  });

  test("test_video_codec_dvcpro_hd_720p50", () => {
    const opts = _formatOpts("quicktime", "dvcpro_hd_720p50");
    expect(opts.videoCodec).toBe(VideoCodec.DVCPRO_HD_720P50);
  });

  test("test_video_codec_dvcpro_hd_720p60", () => {
    const opts = _formatOpts("quicktime", "dvcpro_hd_720p60");
    expect(opts.videoCodec).toBe(VideoCodec.DVCPRO_HD_720P60);
  });

  test("test_video_codec_gopro_cineform", () => {
    const opts = _formatOpts("quicktime", "gopro_cineform");
    expect(opts.videoCodec).toBe(VideoCodec.GOPRO_CINEFORM);
  });

  test("test_video_codec_h264", () => {
    const opts = _formatOpts("quicktime", "h.264");
    expect(opts.videoCodec).toBe(VideoCodec.AVC1);
  });

  test("test_video_codec_none_uncompressed_rgb", () => {
    const opts = _formatOpts("quicktime", "none_uncompressed_rgb_8-bit");
    expect(opts.videoCodec).toBe(VideoCodec.UNCOMPRESSED_RGB_8_BIT);
  });

  test("test_video_codec_uncompressed_yuv_10_bit", () => {
    const opts = _formatOpts("quicktime", "uncompressed_yuv_10_bit_422");
    expect(opts.videoCodec).toBe(VideoCodec.UNCOMPRESSED_YUV_10_BIT_422);
  });

  test("test_video_codec_uncompressed_yuv_8_bit", () => {
    const opts = _formatOpts("quicktime", "uncompressed_yuv_8_bit_422");
    expect(opts.videoCodec).toBe(VideoCodec.UNCOMPRESSED_YUV_8_BIT_422);
  });
});

/** Tests for WAV format options (XML-based). */
describe("TestWavFormatOptions", () => {
  /** WAV base sample has expected default values. */
  test("test_base_defaults", () => {
    const opts = _formatOpts("wav");
    expect(opts instanceof XmlFormatOptions).toBe(true);
    expect(opts.formatCode).toBe("wao_");
    expect(opts.videoCodec).toBe(null);
    expect(opts.frameRate).toBe(null);
    expect(opts.audioCodec).toBe(AudioCodec.UNCOMPRESSED);
    expect(len(opts.params) > 0).toBe(true);
  });

  test("test_audio_codec_ima_adpcm", () => {
    const opts = _formatOpts("wav", "audio_codec_ima_adpcm");
    expect(opts.audioCodec).toBe(AudioCodec.IMA_ADPCM);
  });

  test("test_audio_codec_microsoft_adpcm", () => {
    const opts = _formatOpts("wav", "audio_codec_microsoft_adpcm");
    expect(opts.audioCodec).toBe(AudioCodec.MICROSOFT_ADPCM);
  });

  test("test_audio_codec_ccitt_a_law", () => {
    const opts = _formatOpts("wav", "audio_codec_ccitt_a-law");
    expect(opts.audioCodec).toBe(AudioCodec.CCITT_A_LAW);
  });

  test("test_audio_codec_ccitt_u_law", () => {
    const opts = _formatOpts("wav", "audio_codec_ccitt_u-law");
    expect(opts.audioCodec).toBe(AudioCodec.CCITT_U_LAW);
  });

  test("test_audio_codec_gsm_6_10", () => {
    const opts = _formatOpts("wav", "audio_codec_gsm_6.10");
    expect(opts.audioCodec).toBe(AudioCodec.GSM_6_10);
  });
});

/** Tests for JPEG format options. */
describe("TestJpegFormatOptions", () => {
  function _opts(stem: string): JpegFormatOptions {
    const project = parseProject(FORMAT_DIR.div("jpeg", `${stem}.aep`));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, JpegFormatOptions);
    expect(opts instanceof JpegFormatOptions).toBe(true);
    return opts;
  }

  test("test_base_defaults", () => {
    const opts = _opts("base");
    expect(opts.quality).toBe(5);
    expect(opts.scans).toBe(3);
  });

  test("test_quality_0", () => {
    expect(_opts("quality_0").quality).toBe(0);
  });

  test("test_quality_10", () => {
    expect(_opts("quality_10").quality).toBe(10);
  });

  test("test_baseline_standard", () => {
    expect(_opts("baseline_standard").formatType).toBe(JpegFormatType.BASELINE_STANDARD);
  });

  test("test_baseline_optimized", () => {
    expect(_opts("baseline_optimized").formatType).toBe(JpegFormatType.BASELINE_OPTIMIZED);
  });

  test("test_progressive_3", () => {
    const opts = _opts("progressive_3");
    expect(opts.formatType).toBe(JpegFormatType.PROGRESSIVE);
    expect(opts.scans).toBe(3);
  });

  test("test_scans_4", () => {
    expect(_opts("progressive_4").scans).toBe(4);
  });

  test("test_scans_5", () => {
    expect(_opts("progressive_5").scans).toBe(5);
  });

  test("test_scans_non_progressive", () => {
    expect(_opts("baseline_standard").scans).toBe(3);
  });
});

/** Tests for OpenEXR format options. */
describe("TestOpenExrFormatOptions", () => {
  test("test_base_defaults", () => {
    const project = parseProject(FORMAT_DIR.div("openexr", "base.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, OpenExrFormatOptions);
    expect(opts instanceof OpenExrFormatOptions).toBe(true);
    expect(opts.compression).toBe(OpenExrCompression.ZIP);
    expect(opts.luminanceChroma).toBe(false);
    expect(opts.thirtyTwoBitFloat).toBe(false);
    expect(opts.dwaCompressionLevel).toBe(null);
  });

  test("test_compression_none", () => {
    const project = parseProject(FORMAT_DIR.div("openexr", "compression_none.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, OpenExrFormatOptions);
    expect(opts instanceof OpenExrFormatOptions).toBe(true);
    expect(opts.compression).toBe(OpenExrCompression.NONE);
  });

  test("test_compression_rle", () => {
    const project = parseProject(FORMAT_DIR.div("openexr", "compression_rle.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, OpenExrFormatOptions);
    expect(opts instanceof OpenExrFormatOptions).toBe(true);
    expect(opts.compression).toBe(OpenExrCompression.RLE);
  });

  test("test_compression_zip16", () => {
    const project = parseProject(FORMAT_DIR.div("openexr", "compression_zip16.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, OpenExrFormatOptions);
    expect(opts instanceof OpenExrFormatOptions).toBe(true);
    expect(opts.compression).toBe(OpenExrCompression.ZIP16);
  });

  test("test_compression_piz", () => {
    const project = parseProject(FORMAT_DIR.div("openexr", "compression_piz.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, OpenExrFormatOptions);
    expect(opts instanceof OpenExrFormatOptions).toBe(true);
    expect(opts.compression).toBe(OpenExrCompression.PIZ);
  });

  test("test_compression_pxr24", () => {
    const project = parseProject(FORMAT_DIR.div("openexr", "compression_pxr24.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, OpenExrFormatOptions);
    expect(opts instanceof OpenExrFormatOptions).toBe(true);
    expect(opts.compression).toBe(OpenExrCompression.PXR24);
  });

  test("test_compression_b44", () => {
    const project = parseProject(FORMAT_DIR.div("openexr", "compression_b44.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, OpenExrFormatOptions);
    expect(opts instanceof OpenExrFormatOptions).toBe(true);
    expect(opts.compression).toBe(OpenExrCompression.B44);
  });

  test("test_compression_b44a", () => {
    const project = parseProject(FORMAT_DIR.div("openexr", "compression_b44a.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, OpenExrFormatOptions);
    expect(opts instanceof OpenExrFormatOptions).toBe(true);
    expect(opts.compression).toBe(OpenExrCompression.B44A);
  });

  test("test_compression_dwaa", () => {
    const project = parseProject(FORMAT_DIR.div("openexr", "compression_dwaa_45.0.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, OpenExrFormatOptions);
    expect(opts instanceof OpenExrFormatOptions).toBe(true);
    expect(opts.compression).toBe(OpenExrCompression.DWAA);
    expect(opts.dwaCompressionLevel).toBe(45.0);
  });

  test("test_compression_dwab", () => {
    const project = parseProject(FORMAT_DIR.div("openexr", "compression_dwab_200.0.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, OpenExrFormatOptions);
    expect(opts instanceof OpenExrFormatOptions).toBe(true);
    expect(opts.compression).toBe(OpenExrCompression.DWAB);
    expect(opts.dwaCompressionLevel).toBe(200.0);
  });

  test("test_luminance_chroma_on", () => {
    const project = parseProject(FORMAT_DIR.div("openexr", "compression_zip_luminance_chroma.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, OpenExrFormatOptions);
    expect(opts instanceof OpenExrFormatOptions).toBe(true);
    expect(opts.luminanceChroma).toBe(true);
  });

  test("test_32_bit_float_on", () => {
    const project = parseProject(FORMAT_DIR.div("openexr", "compression_zip_32_bit_float.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, OpenExrFormatOptions);
    expect(opts instanceof OpenExrFormatOptions).toBe(true);
    expect(opts.thirtyTwoBitFloat).toBe(true);
  });

  test("test_dwa_compression_level_dwaa_custom", () => {
    const project = parseProject(FORMAT_DIR.div("openexr", "compression_dwaa_1.0.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, OpenExrFormatOptions);
    expect(opts instanceof OpenExrFormatOptions).toBe(true);
    expect(opts.dwaCompressionLevel).toBe(1.0);
  });

  test("test_dwa_compression_level_dwaa_large", () => {
    const project = parseProject(FORMAT_DIR.div("openexr", "compression_dwaa_10000000000.0.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, OpenExrFormatOptions);
    expect(opts instanceof OpenExrFormatOptions).toBe(true);
    expect(opts.dwaCompressionLevel).toBe(10000000000.0);
  });

  test("test_dwa_compression_level_dwab", () => {
    const project = parseProject(FORMAT_DIR.div("openexr", "compression_dwab_200.0.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, OpenExrFormatOptions);
    expect(opts instanceof OpenExrFormatOptions).toBe(true);
    expect(opts.dwaCompressionLevel).toBe(200.0);
  });
});

/** Tests for PNG format options (typed binary). */
describe("TestPngFormatOptions", () => {
  test("test_base_defaults", () => {
    const project = parseProject(FORMAT_DIR.div("png", "base.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, PngFormatOptions);
    expect(opts instanceof PngFormatOptions).toBe(true);
    expect(opts.width).toBe(1920);
    expect(opts.height).toBe(1080);
    expect(opts.bitDepth).toBe(16);
    expect(opts.includeHdr10Metadata).toBe(false);
    expect(opts.luminanceMin).toBe(null);
    expect(opts.luminanceMax).toBe(null);
    expect(opts.contentLightMax).toBe(null);
    expect(opts.contentLightAverage).toBe(null);
  });

  test("test_compression_none", () => {
    const project = parseProject(FORMAT_DIR.div("png", "compression_none.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, PngFormatOptions);
    expect(opts instanceof PngFormatOptions).toBe(true);
    expect(opts.compression).toBe(PngCompression.NONE);
  });

  test("test_compression_interlaced", () => {
    const project = parseProject(FORMAT_DIR.div("png", "compression_interlaced.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, PngFormatOptions);
    expect(opts instanceof PngFormatOptions).toBe(true);
    expect(opts.compression).toBe(PngCompression.INTERLACED);
  });

  test("test_include_hdr10_metadata_on", () => {
    const project = parseProject(FORMAT_DIR.div("png", "include_hdr10_metadata_on.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, PngFormatOptions);
    expect(opts instanceof PngFormatOptions).toBe(true);
    expect(opts.includeHdr10Metadata).toBe(true);
    expect(opts.colorPrimaries).toBe(Hdr10ColorPrimaries.P3_D65);
  });

  test("test_color_primaries_rec709", () => {
    const project = parseProject(FORMAT_DIR.div("png", "color_primaries_rec709.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, PngFormatOptions);
    expect(opts instanceof PngFormatOptions).toBe(true);
    expect(opts.colorPrimaries).toBe(Hdr10ColorPrimaries.REC709);
  });

  test("test_color_primaries_rec2020", () => {
    const project = parseProject(FORMAT_DIR.div("png", "color_primaries_rec2020.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, PngFormatOptions);
    expect(opts instanceof PngFormatOptions).toBe(true);
    expect(opts.colorPrimaries).toBe(Hdr10ColorPrimaries.REC2020);
  });

  test("test_color_primaries_p3d65", () => {
    const project = parseProject(FORMAT_DIR.div("png", "color_primaries_p3d65.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, PngFormatOptions);
    expect(opts instanceof PngFormatOptions).toBe(true);
    expect(opts.colorPrimaries).toBe(Hdr10ColorPrimaries.P3_D65);
  });

  test("test_luminance_min_zero", () => {
    const project = parseProject(FORMAT_DIR.div("png", "luminance_min_0.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, PngFormatOptions);
    expect(opts instanceof PngFormatOptions).toBe(true);
    expect(opts.luminanceMin).toBe(0.0);
  });

  test("test_luminance_max_set", () => {
    const project = parseProject(FORMAT_DIR.div("png", "luminance_max_1.797693e+308.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, PngFormatOptions);
    expect(opts instanceof PngFormatOptions).toBe(true);
    expect(opts.luminanceMax).toBe(1.7976931348623157e308);
  });

  test("test_content_light_max_set", () => {
    const project = parseProject(
      FORMAT_DIR.div("png", "content_light_levels_maximum_1.797693e+308.aep"),
    );
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, PngFormatOptions);
    expect(opts instanceof PngFormatOptions).toBe(true);
    expect(opts.contentLightMax).toBe(1.7976931348623157e308);
  });

  test("test_content_light_average_set", () => {
    const project = parseProject(
      FORMAT_DIR.div("png", "content_light_levels_average_1.797693e+308.aep"),
    );
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, PngFormatOptions);
    expect(opts instanceof PngFormatOptions).toBe(true);
    expect(opts.contentLightAverage).toBe(1.7976931348623157e308);
  });
});

/** Tests for Targa format options (binary). */
describe("TestTargaFormatOptions", () => {
  test("test_base_defaults", () => {
    const project = parseProject(FORMAT_DIR.div("targa", "base.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, TargaFormatOptions);
    expect(opts instanceof TargaFormatOptions).toBe(true);
    expect(opts.bitsPerPixel).toBe(32);
    expect(opts.rleCompression).toBe(false);
  });

  test("test_24_bits_per_pixel", () => {
    const project = parseProject(FORMAT_DIR.div("targa", "24_bits_per_pixel.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, TargaFormatOptions);
    expect(opts instanceof TargaFormatOptions).toBe(true);
    expect(opts.bitsPerPixel).toBe(24);
  });

  test("test_32_bits_per_pixel", () => {
    const project = parseProject(FORMAT_DIR.div("targa", "32_bits_per_pixel.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, TargaFormatOptions);
    expect(opts instanceof TargaFormatOptions).toBe(true);
    expect(opts.bitsPerPixel).toBe(32);
  });

  test("test_rle_compression_on", () => {
    const project = parseProject(FORMAT_DIR.div("targa", "rle_compression_on.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, TargaFormatOptions);
    expect(opts instanceof TargaFormatOptions).toBe(true);
    expect(opts.rleCompression).toBe(true);
    expect(opts.bitsPerPixel).toBe(24);
  });
});

/** Tests for TIFF format options. */
describe("TestTiffFormatOptions", () => {
  test("test_base_defaults", () => {
    const project = parseProject(FORMAT_DIR.div("tiff", "base.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, TiffFormatOptions);
    expect(opts instanceof TiffFormatOptions).toBe(true);
    expect(opts.lzwCompression).toBe(false);
    expect(opts.ibmPcByteOrder).toBe(false);
  });

  test("test_lzw_compression_on", () => {
    const project = parseProject(FORMAT_DIR.div("tiff", "lze_compression_on.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, TiffFormatOptions);
    expect(opts instanceof TiffFormatOptions).toBe(true);
    expect(opts.lzwCompression).toBe(true);
    expect(opts.ibmPcByteOrder).toBe(false);
  });

  test("test_ibm_pc_byte_order_on", () => {
    const project = parseProject(FORMAT_DIR.div("tiff", "ibm_pc_byte_order_on.aep"));
    const opts = asInstance(asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions, TiffFormatOptions);
    expect(opts instanceof TiffFormatOptions).toBe(true);
    expect(opts.ibmPcByteOrder).toBe(true);
    expect(opts.lzwCompression).toBe(false);
  });
});
