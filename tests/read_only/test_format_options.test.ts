/** Tests for OutputModule.format_options parsing. */

// `from __future__ import annotations` is dropped: no annotation here is
// evaluated at runtime. `pytest.approx` is the pyrt `approx` (pytest.ts), so
// `x == pytest.approx(y)` becomes `expect(approx(x, y)).toBe(true)`.

import { describe, expect, test } from "bun:test";
import { approx } from "../../src/pyrt/pytest.ts";
import { Path, contains, dict_get, getitem, len, py_eq } from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { parse_project } from "../conftest.ts";
import { as_instance } from "../helpers.ts";
import { CineonRoptChunk, OpenExrRoptChunk } from "../../src/py_aep/binary/render_chunks.ts";
import { find_by_type } from "../../src/py_aep/binary/utils.ts";
import { AudioCodec, CineonFileFormat, Hdr10ColorPrimaries, JpegFormatType, MPEGAudioFormat, MPEGMultiplexer, MPEGMuxStreamCompatibility, OpenExrCompression, PngCompression, VideoCodec } from "../../src/py_aep/enums/index.ts";
import { RenderQueue } from "../../src/py_aep/models/renderqueue/render_queue.ts";
import { CineonFormatOptions, JpegFormatOptions, OpenExrFormatOptions, PngFormatOptions, TargaFormatOptions, TiffFormatOptions, XmlFormatOptions } from "../../src/py_aep/models/renderqueue/format_options/index.ts";

// Python `Path(__file__).parent.parent.parent` is the repo root. A TS file's
// `import.meta.dir` is already its directory, so two `.parent` steps reach it.
const FORMAT_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "format_options");
const CINEON_DIR = FORMAT_DIR.div("cineon");
const AVI_DIR = FORMAT_DIR.div("avi");

test.each([
  ["cineon", CineonRoptChunk],
  ["openexr", OpenExrRoptChunk],
])("test_ropt_defaults_are_after_effects_bytes[%#]", (folder: string, chunk_cls: typeof CineonRoptChunk | typeof OpenExrRoptChunk) => {
  // A fresh chunk reproduces the Ropt AE 2026 writes for the format's
  // default output module (black point 0; DWA compression level 45).
  const project = parse_project(FORMAT_DIR.div(folder, "base.aep"));
  const lom = as_instance(project.render_queue, RenderQueue).items[0].output_modules[0]._parent_rqi._lom;
  const ae_ropt = find_by_type(lom.chunks, "Ropt");
  expect(py_eq(new chunk_cls({}).tobytes(), ae_ropt.tobytes())).toBe(true);
});

/** Parse a Cineon sample and return its CineonFormatOptions. */
function _cineon_opts(name: string): CineonFormatOptions {
  const project = parse_project(CINEON_DIR.div(`${name}.aep`));
  const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, CineonFormatOptions);
  expect(opts instanceof CineonFormatOptions).toBe(true);
  return opts;
}

/** Parse an AVI sample and return its XmlFormatOptions. */
function _avi_opts(name: string): XmlFormatOptions {
  const project = parse_project(AVI_DIR.div(`${name}.aep`));
  const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, XmlFormatOptions);
  expect(opts instanceof XmlFormatOptions).toBe(true);
  return opts;
}

/** Parse a sample from the given format dir and return XmlFormatOptions. */
function _format_opts(fmt_dir: string, name = "base"): XmlFormatOptions {
  const project = parse_project(FORMAT_DIR.div(fmt_dir, `${name}.aep`));
  const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, XmlFormatOptions);
  expect(opts instanceof XmlFormatOptions).toBe(true);
  return opts;
}

/** Tests for Cineon/DPX format options parsed from Ropt chunks. */
describe("TestCineonFormatOptions", () => {
  /** Base Cineon sample has expected default values. */
  test("test_base_defaults", () => {
    const opts = _cineon_opts("base");
    expect(opts.ten_bit_black_point).toBe(0);
    expect(opts.ten_bit_white_point).toBe(1023);
    expect(opts.converted_black_point).toBe(0.0);
    expect(opts.converted_white_point).toBe(1.0);
    expect(opts.current_gamma).toBe(1.0);
    expect(opts.highlight_expansion).toBe(0);
    expect(opts.logarithmic_conversion).toBe(false);
    expect(opts.file_format).toBe(CineonFileFormat.DPX);
    expect(opts.bit_depth).toBe(10);
  });

  // --- 10-bit black point ---

  test("test_10_bit_black_point_1", () => {
    const opts = _cineon_opts("10_bit_black_point_1");
    expect(opts.ten_bit_black_point).toBe(1);
  });

  test("test_10_bit_black_point_1023", () => {
    const opts = _cineon_opts("10_bit_black_point_1023");
    expect(opts.ten_bit_black_point).toBe(1023);
  });

  // --- 10-bit white point ---

  test("test_10_bit_white_point_0", () => {
    const opts = _cineon_opts("10_bit_white_point_0");
    expect(opts.ten_bit_white_point).toBe(0);
  });

  test("test_10_bit_white_point_1021", () => {
    const opts = _cineon_opts("10_bit_white_point_1021");
    expect(opts.ten_bit_white_point).toBe(1021);
  });

  // --- converted black point ---

  test("test_converted_black_point_1", () => {
    const opts = _cineon_opts("converted_black_point_1");
    expect(approx(opts.converted_black_point, 1.0 / 255.0)).toBe(true);
  });

  test("test_converted_black_point_2", () => {
    const opts = _cineon_opts("converted_black_point_2");
    expect(approx(opts.converted_black_point, 2.0 / 255.0)).toBe(true);
  });

  test("test_converted_black_point_255", () => {
    const opts = _cineon_opts("converted_black_point_255");
    expect(approx(opts.converted_black_point, 1.0)).toBe(true);
  });

  // --- converted white point ---

  test("test_converted_white_point_0", () => {
    const opts = _cineon_opts("converted_white_point_0");
    expect(approx(opts.converted_white_point, 0.0)).toBe(true);
  });

  test("test_converted_white_point_253", () => {
    const opts = _cineon_opts("converted_white_point_253");
    expect(approx(opts.converted_white_point, 253.0 / 255.0)).toBe(true);
  });

  test("test_converted_white_point_32767", () => {
    const opts = _cineon_opts("converted_white_point_32767");
    expect(approx(opts.converted_white_point, 32767.0 / 32768.0)).toBe(true);
  });

  test("test_converted_white_point_0_987", () => {
    const opts = _cineon_opts("converted_white_point_0.987");
    expect(approx(opts.converted_white_point, 0.987)).toBe(true);
  });

  // --- current gamma ---

  test("test_current_gamma_0_01", () => {
    const opts = _cineon_opts("current_gamma_0.01");
    expect(approx(opts.current_gamma, 0.01)).toBe(true);
  });

  test("test_current_gamma_1_1", () => {
    const opts = _cineon_opts("current_gamma_1.1");
    expect(approx(opts.current_gamma, 1.1)).toBe(true);
  });

  test("test_current_gamma_5", () => {
    const opts = _cineon_opts("current_gamma_5");
    expect(approx(opts.current_gamma, 5.0)).toBe(true);
  });

  // --- logarithmic conversion ---

  test("test_logarithmic_conversion_on", () => {
    // Note: filename has typo "logarighmic"
    const opts = _cineon_opts("logarighmic_conversion_on");
    expect(opts.logarithmic_conversion).toBe(true);
  });

  test("test_logarithmic_conversion_off", () => {
    const opts = _cineon_opts("logarighmic_conversion_off");
    expect(opts.logarithmic_conversion).toBe(false);
  });

  // --- file format and bit depth ---

  test("test_file_format_dpx_8", () => {
    const opts = _cineon_opts("file_format_dpx_8");
    expect(opts.file_format).toBe(CineonFileFormat.DPX);
    expect(opts.bit_depth).toBe(8);
  });

  test("test_file_format_dpx_10", () => {
    const opts = _cineon_opts("file_format_dpx_10");
    expect(opts.file_format).toBe(CineonFileFormat.DPX);
    expect(opts.bit_depth).toBe(10);
  });

  test("test_file_format_dpx_12", () => {
    const opts = _cineon_opts("file_format_dpx_12");
    expect(opts.file_format).toBe(CineonFileFormat.DPX);
    expect(opts.bit_depth).toBe(12);
  });

  test("test_file_format_dpx_16", () => {
    const opts = _cineon_opts("file_format_dpx_16");
    expect(opts.file_format).toBe(CineonFileFormat.DPX);
    expect(opts.bit_depth).toBe(16);
  });

  /** FIDO/Cineon 4.5 format. */
  test("test_file_format_fido", () => {
    const opts = _cineon_opts("file_format_fido");
    expect(opts.file_format).toBe(CineonFileFormat.FIDO_CINEON);
  });

  // --- highlight expansion ---

  test("test_highlight_expansion_0", () => {
    const opts = _cineon_opts("highlight_expansion_0");
    expect(opts.highlight_expansion).toBe(0);
  });

  test("test_highlight_expansion_1", () => {
    const opts = _cineon_opts("highlight_expansion_1");
    expect(opts.highlight_expansion).toBe(1);
  });

  test("test_highlight_expansion_150", () => {
    const opts = _cineon_opts("highlight_expansion_150");
    expect(opts.highlight_expansion).toBe(150);
  });
});

/** Tests for AVI format options parsed from Ropt chunks (now XmlFormatOptions). */
describe("TestAviFormatOptions", () => {
  /** AVI base sample has expected default values. */
  test("test_base_defaults", () => {
    const opts = _avi_opts("base");
    expect(opts.format_code).toBe(".AVI");
    expect(opts.video_codec).toBe(VideoCodec.NONE);
    expect(opts.audio_codec).toBe(AudioCodec.UNCOMPRESSED);
    expect(opts.frame_rate).toBe(24.0);
    expect(contains(opts.params, "ADBEVideoCodec")).toBe(true);
    expect(contains(opts.params, "ADBEVideoQuality")).toBe(true);
    expect(contains(opts.params, "ADBEVideoWidth")).toBe(true);
    expect(contains(opts.params, "ADBEVideoHeight")).toBe(true);
  });

  // --- video codecs ---

  /** DV 24p Advanced codec maps to VideoCodec.DV_24P. */
  test("test_video_codec_dv_24p_advanced", () => {
    const opts = _avi_opts("video_codec_dv_24p_advanced");
    expect(opts.video_codec).toBe(VideoCodec.DV_24P);
  });

  /** DV NTSC codec maps to VideoCodec.DV_NTSC. */
  test("test_video_codec_dv_ntsc", () => {
    const opts = _avi_opts("video_codec_dv_ntsc");
    expect(opts.video_codec).toBe(VideoCodec.DV_NTSC);
  });

  /** DV PAL codec maps to VideoCodec.DV_PAL. */
  test("test_video_codec_dv_pal", () => {
    const opts = _avi_opts("video_codec_dv_pal");
    expect(opts.video_codec).toBe(VideoCodec.DV_PAL);
  });

  /** Intel IYUV codec maps to VideoCodec.INTEL_IYUV. */
  test("test_video_codec_intel_iyuv", () => {
    const opts = _avi_opts("video_codec_intel_iyuv_codec");
    expect(opts.video_codec).toBe(VideoCodec.INTEL_IYUV);
  });

  /** Uncompressed UYVY 422 8bit maps to VideoCodec.UYVY. */
  test("test_video_codec_uyvy_422", () => {
    const opts = _avi_opts("video_codec_uncompressed_uyvy_422_8bit");
    expect(opts.video_codec).toBe(VideoCodec.UYVY);
  });

  /** V210 10-bit YUV maps to VideoCodec.V210. */
  test("test_video_codec_v210", () => {
    const opts = _avi_opts("video_codec_v210_10-bit_yuv");
    expect(opts.video_codec).toBe(VideoCodec.V210);
  });

  // --- audio interleave ---

  /** Audio interleave 'None' has no ADBEAudioInterleave param. */
  test("test_audio_interleave_none", () => {
    const opts = _avi_opts("audio_interleave_none");
    expect(dict_get(opts.params, "ADBEAudioInterleave")).toBe(null);
  });

  test("test_audio_interleave_1_frame", () => {
    const opts = _avi_opts("audio_interleave_1_frame");
    expect(getitem(opts.params, "ADBEAudioInterleave")).toBe("1");
  });

  test("test_audio_interleave_half_second", () => {
    const opts = _avi_opts("audio_interleave_half_second");
    expect(getitem(opts.params, "ADBEAudioInterleave")).toBe("2");
  });

  test("test_audio_interleave_1_second", () => {
    const opts = _avi_opts("audio_interleave_1_second");
    expect(getitem(opts.params, "ADBEAudioInterleave")).toBe("3");
  });

  test("test_audio_interleave_2_seconds", () => {
    const opts = _avi_opts("audio_interleave2_seconds");
    expect(getitem(opts.params, "ADBEAudioInterleave")).toBe("4");
  });
});

/** Test that formats without Ropt parsing return None. */
describe("TestFormatOptionsNone", () => {
  /**
   * A format that doesn't have Ropt (or uses unsupported format)
   * should return None for format_options.
   */
  test("test_no_ropt_returns_none", () => {
    const samples_dir = new Path(import.meta.dir).parent.parent.div("samples", "models");
    const rq_base = samples_dir.div("renderqueue", "base.aep");
    const project = parse_project(rq_base);
    const om = as_instance(project.render_queue, RenderQueue).items[0].output_modules[0];
    expect(
      om.format_options == null ||
        [
          CineonFormatOptions,
          JpegFormatOptions,
          OpenExrFormatOptions,
          PngFormatOptions,
          TargaFormatOptions,
          TiffFormatOptions,
          XmlFormatOptions,
        ].some((c) => om.format_options instanceof c),
    ).toBe(true);
  });
});

/** Tests for H.264 format options (XML-based). */
describe("TestH264FormatOptions", () => {
  /** Base H.264 sample has expected default values. */
  test("test_base_defaults", () => {
    const opts = _format_opts("h.264");
    expect(opts.format_code).toBe("H264");
    expect(opts.video_codec).toBe(VideoCodec.AVC1);
    expect(opts.audio_codec).toBe(AudioCodec.AAC);
    expect(opts.frame_rate).toBe(24.0);
    expect(len(opts.params) > 0).toBe(true);
    expect(opts.mpeg_audio_format).toBe(MPEGAudioFormat.AAC);
    expect(opts.mpeg_multiplexer).toBe(MPEGMultiplexer.MP4);
    expect(opts.mpeg_mux_stream_compatibility).toBe(MPEGMuxStreamCompatibility.STD);
  });

  /** MPEG audio format sample has MPEG format and layer I. */
  test("test_audio_format_mpeg", () => {
    const project = parse_project(FORMAT_DIR.div("h.264", "audio_format_mpeg.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, XmlFormatOptions);
    expect(opts instanceof XmlFormatOptions).toBe(true);
    expect(opts.mpeg_audio_format).toBe(MPEGAudioFormat.MPEG);
    expect(getitem(opts.params, "ADBEMPEGAudioLayer")).toBe("1");
  });

  test("test_mpeg_audio_layer_ii", () => {
    const project = parse_project(FORMAT_DIR.div("h.264", "audio_format_mpeg_layer_II.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, XmlFormatOptions);
    expect(opts instanceof XmlFormatOptions).toBe(true);
    expect(getitem(opts.params, "ADBEMPEGAudioLayer")).toBe("2");
  });

  /** PCM audio format sample. */
  test("test_mpeg_audio_format_pcm", () => {
    const opts = _format_opts("h.264", "audio_format_pcm");
    expect(opts.mpeg_audio_format).toBe(MPEGAudioFormat.PCM);
  });

  test("test_multiplexer_3gpp", () => {
    const opts = _format_opts("h.264", "multiplexer_3gpp");
    expect(opts.mpeg_multiplexer).toBe(MPEGMultiplexer.THREEGPP);
  });

  test("test_multiplexer_none", () => {
    const opts = _format_opts("h.264", "multiplexer_none");
    expect(opts.mpeg_multiplexer).toBe(MPEGMultiplexer.NONE);
  });

  test("test_audio_codec_aac_plus_v1", () => {
    const opts = _format_opts("h.264", "audio_codec_aac+_version_1");
    expect(opts.audio_codec).toBe(AudioCodec.AAC_PLUS_V1);
  });

  test("test_audio_codec_aac_plus_v2", () => {
    const opts = _format_opts("h.264", "audio_codec_aac+_version_2");
    expect(opts.audio_codec).toBe(AudioCodec.AAC_PLUS_V2);
  });

  test("test_stream_compat_ipod", () => {
    const opts = _format_opts("h.264", "stream_compat_ipod");
    expect(opts.mpeg_mux_stream_compatibility).toBe(MPEGMuxStreamCompatibility.IPOD);
  });

  test("test_stream_compat_psp", () => {
    const opts = _format_opts("h.264", "stream_compat_psp");
    expect(opts.mpeg_mux_stream_compatibility).toBe(MPEGMuxStreamCompatibility.PSP);
  });
});

/** Tests for MP3 format options (XML-based). */
describe("TestMp3FormatOptions", () => {
  /** MP3 base sample has expected default values. */
  test("test_base_defaults", () => {
    const opts = _format_opts("mp3");
    expect(opts instanceof XmlFormatOptions).toBe(true);
    expect(opts.format_code).toBe("Mp3 ");
    expect(opts.video_codec).toBe(null);
    expect(opts.frame_rate).toBe(null);
    expect(opts.audio_codec).toBe(AudioCodec.UNCOMPRESSED);
    expect(len(opts.params) > 0).toBe(true);
  });
});

/** Tests for QuickTime format options (XML-based). */
describe("TestQuickTimeFormatOptions", () => {
  /** QuickTime base sample has expected default values. */
  test("test_base_defaults", () => {
    const opts = _format_opts("quicktime");
    expect(opts instanceof XmlFormatOptions).toBe(true);
    expect(opts.format_code).toBe("MooV");
    expect(opts.video_codec).toBe(VideoCodec.ANIMATION);
    expect(opts.frame_rate).toBe(24.0);
    expect(opts.audio_codec).toBe(null);
    expect(opts.mpeg_audio_format).toBe(null);
    expect(opts.mpeg_multiplexer).toBe(MPEGMultiplexer.MP4);
    expect(opts.mpeg_mux_stream_compatibility).toBe(MPEGMuxStreamCompatibility.STD);
    expect(len(opts.params) > 0).toBe(true);
  });

  test("test_video_codec_apple_prores_422", () => {
    const opts = _format_opts("quicktime", "apple_prores_422");
    expect(opts.video_codec).toBe(VideoCodec.APPLE_PRORES_422);
  });

  test("test_video_codec_apple_prores_422_hq", () => {
    const opts = _format_opts("quicktime", "apple_prores_422_hq");
    expect(opts.video_codec).toBe(VideoCodec.APPLE_PRORES_422_HQ);
  });

  test("test_video_codec_apple_prores_422_lt", () => {
    const opts = _format_opts("quicktime", "apple_prores_422_lt");
    expect(opts.video_codec).toBe(VideoCodec.APPLE_PRORES_422_LT);
  });

  test("test_video_codec_apple_prores_422_proxy", () => {
    const opts = _format_opts("quicktime", "apple_prores_422_proxy");
    expect(opts.video_codec).toBe(VideoCodec.APPLE_PRORES_422_PROXY);
  });

  test("test_video_codec_apple_prores_4444", () => {
    const opts = _format_opts("quicktime", "apple_prores_4444");
    expect(opts.video_codec).toBe(VideoCodec.APPLE_PRORES_4444);
  });

  test("test_video_codec_apple_prores_4444_xq", () => {
    const opts = _format_opts("quicktime", "apple_prores_4444_xq");
    expect(opts.video_codec).toBe(VideoCodec.APPLE_PRORES_4444_XQ);
  });

  test("test_video_codec_dnxhr_dnxhd", () => {
    const opts = _format_opts("quicktime", "dnxhr_dnxhd");
    expect(opts.video_codec).toBe(VideoCodec.DNXHR_DNXHD);
  });

  test("test_video_codec_dv25_ntsc", () => {
    const opts = _format_opts("quicktime", "dv25_ntsc");
    expect(opts.video_codec).toBe(VideoCodec.DV25_NTSC);
  });

  test("test_video_codec_dv25_ntsc_24p", () => {
    const opts = _format_opts("quicktime", "dv25_ntsc_24p");
    expect(opts.video_codec).toBe(VideoCodec.DV25_NTSC_24P);
  });

  test("test_video_codec_dv25_pal", () => {
    const opts = _format_opts("quicktime", "dv25_pal");
    expect(opts.video_codec).toBe(VideoCodec.DV25_PAL);
  });

  test("test_video_codec_dv50_ntsc", () => {
    const opts = _format_opts("quicktime", "dv50_ntsc");
    expect(opts.video_codec).toBe(VideoCodec.DV50_NTSC);
  });

  test("test_video_codec_dv50_pal", () => {
    const opts = _format_opts("quicktime", "dv50_pal");
    expect(opts.video_codec).toBe(VideoCodec.DV50_PAL);
  });

  test("test_video_codec_dvcpro_hd_1080i50", () => {
    const opts = _format_opts("quicktime", "dvcpro_hd_1080i50");
    expect(opts.video_codec).toBe(VideoCodec.DVCPRO_HD_1080I50);
  });

  test("test_video_codec_dvcpro_hd_1080i60", () => {
    const opts = _format_opts("quicktime", "dvcpro_hd_1080i60");
    expect(opts.video_codec).toBe(VideoCodec.DVCPRO_HD_1080I60);
  });

  test("test_video_codec_dvcpro_hd_1080p25", () => {
    const opts = _format_opts("quicktime", "dvcpro_hd_1080p25");
    expect(opts.video_codec).toBe(VideoCodec.DVCPRO_HD_1080P25);
  });

  test("test_video_codec_dvcpro_hd_1080p30", () => {
    const opts = _format_opts("quicktime", "dvcpro_hd_1080p30");
    expect(opts.video_codec).toBe(VideoCodec.DVCPRO_HD_1080P30);
  });

  test("test_video_codec_dvcpro_hd_720p50", () => {
    const opts = _format_opts("quicktime", "dvcpro_hd_720p50");
    expect(opts.video_codec).toBe(VideoCodec.DVCPRO_HD_720P50);
  });

  test("test_video_codec_dvcpro_hd_720p60", () => {
    const opts = _format_opts("quicktime", "dvcpro_hd_720p60");
    expect(opts.video_codec).toBe(VideoCodec.DVCPRO_HD_720P60);
  });

  test("test_video_codec_gopro_cineform", () => {
    const opts = _format_opts("quicktime", "gopro_cineform");
    expect(opts.video_codec).toBe(VideoCodec.GOPRO_CINEFORM);
  });

  test("test_video_codec_h264", () => {
    const opts = _format_opts("quicktime", "h.264");
    expect(opts.video_codec).toBe(VideoCodec.AVC1);
  });

  test("test_video_codec_none_uncompressed_rgb", () => {
    const opts = _format_opts("quicktime", "none_uncompressed_rgb_8-bit");
    expect(opts.video_codec).toBe(VideoCodec.UNCOMPRESSED_RGB_8_BIT);
  });

  test("test_video_codec_uncompressed_yuv_10_bit", () => {
    const opts = _format_opts("quicktime", "uncompressed_yuv_10_bit_422");
    expect(opts.video_codec).toBe(VideoCodec.UNCOMPRESSED_YUV_10_BIT_422);
  });

  test("test_video_codec_uncompressed_yuv_8_bit", () => {
    const opts = _format_opts("quicktime", "uncompressed_yuv_8_bit_422");
    expect(opts.video_codec).toBe(VideoCodec.UNCOMPRESSED_YUV_8_BIT_422);
  });
});

/** Tests for WAV format options (XML-based). */
describe("TestWavFormatOptions", () => {
  /** WAV base sample has expected default values. */
  test("test_base_defaults", () => {
    const opts = _format_opts("wav");
    expect(opts instanceof XmlFormatOptions).toBe(true);
    expect(opts.format_code).toBe("wao_");
    expect(opts.video_codec).toBe(null);
    expect(opts.frame_rate).toBe(null);
    expect(opts.audio_codec).toBe(AudioCodec.UNCOMPRESSED);
    expect(len(opts.params) > 0).toBe(true);
  });

  test("test_audio_codec_ima_adpcm", () => {
    const opts = _format_opts("wav", "audio_codec_ima_adpcm");
    expect(opts.audio_codec).toBe(AudioCodec.IMA_ADPCM);
  });

  test("test_audio_codec_microsoft_adpcm", () => {
    const opts = _format_opts("wav", "audio_codec_microsoft_adpcm");
    expect(opts.audio_codec).toBe(AudioCodec.MICROSOFT_ADPCM);
  });

  test("test_audio_codec_ccitt_a_law", () => {
    const opts = _format_opts("wav", "audio_codec_ccitt_a-law");
    expect(opts.audio_codec).toBe(AudioCodec.CCITT_A_LAW);
  });

  test("test_audio_codec_ccitt_u_law", () => {
    const opts = _format_opts("wav", "audio_codec_ccitt_u-law");
    expect(opts.audio_codec).toBe(AudioCodec.CCITT_U_LAW);
  });

  test("test_audio_codec_gsm_6_10", () => {
    const opts = _format_opts("wav", "audio_codec_gsm_6.10");
    expect(opts.audio_codec).toBe(AudioCodec.GSM_6_10);
  });
});

/** Tests for JPEG format options. */
describe("TestJpegFormatOptions", () => {
  function _opts(stem: string): JpegFormatOptions {
    const project = parse_project(FORMAT_DIR.div("jpeg", `${stem}.aep`));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, JpegFormatOptions);
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
    expect(_opts("baseline_standard").format_type).toBe(JpegFormatType.BASELINE_STANDARD);
  });

  test("test_baseline_optimized", () => {
    expect(_opts("baseline_optimized").format_type).toBe(JpegFormatType.BASELINE_OPTIMIZED);
  });

  test("test_progressive_3", () => {
    const opts = _opts("progressive_3");
    expect(opts.format_type).toBe(JpegFormatType.PROGRESSIVE);
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
    const project = parse_project(FORMAT_DIR.div("openexr", "base.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, OpenExrFormatOptions);
    expect(opts instanceof OpenExrFormatOptions).toBe(true);
    expect(opts.compression).toBe(OpenExrCompression.ZIP);
    expect(opts.luminance_chroma).toBe(false);
    expect(opts.thirty_two_bit_float).toBe(false);
    expect(opts.dwa_compression_level).toBe(null);
  });

  test("test_compression_none", () => {
    const project = parse_project(FORMAT_DIR.div("openexr", "compression_none.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, OpenExrFormatOptions);
    expect(opts instanceof OpenExrFormatOptions).toBe(true);
    expect(opts.compression).toBe(OpenExrCompression.NONE);
  });

  test("test_compression_rle", () => {
    const project = parse_project(FORMAT_DIR.div("openexr", "compression_rle.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, OpenExrFormatOptions);
    expect(opts instanceof OpenExrFormatOptions).toBe(true);
    expect(opts.compression).toBe(OpenExrCompression.RLE);
  });

  test("test_compression_zip16", () => {
    const project = parse_project(FORMAT_DIR.div("openexr", "compression_zip16.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, OpenExrFormatOptions);
    expect(opts instanceof OpenExrFormatOptions).toBe(true);
    expect(opts.compression).toBe(OpenExrCompression.ZIP16);
  });

  test("test_compression_piz", () => {
    const project = parse_project(FORMAT_DIR.div("openexr", "compression_piz.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, OpenExrFormatOptions);
    expect(opts instanceof OpenExrFormatOptions).toBe(true);
    expect(opts.compression).toBe(OpenExrCompression.PIZ);
  });

  test("test_compression_pxr24", () => {
    const project = parse_project(FORMAT_DIR.div("openexr", "compression_pxr24.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, OpenExrFormatOptions);
    expect(opts instanceof OpenExrFormatOptions).toBe(true);
    expect(opts.compression).toBe(OpenExrCompression.PXR24);
  });

  test("test_compression_b44", () => {
    const project = parse_project(FORMAT_DIR.div("openexr", "compression_b44.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, OpenExrFormatOptions);
    expect(opts instanceof OpenExrFormatOptions).toBe(true);
    expect(opts.compression).toBe(OpenExrCompression.B44);
  });

  test("test_compression_b44a", () => {
    const project = parse_project(FORMAT_DIR.div("openexr", "compression_b44a.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, OpenExrFormatOptions);
    expect(opts instanceof OpenExrFormatOptions).toBe(true);
    expect(opts.compression).toBe(OpenExrCompression.B44A);
  });

  test("test_compression_dwaa", () => {
    const project = parse_project(FORMAT_DIR.div("openexr", "compression_dwaa_45.0.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, OpenExrFormatOptions);
    expect(opts instanceof OpenExrFormatOptions).toBe(true);
    expect(opts.compression).toBe(OpenExrCompression.DWAA);
    expect(opts.dwa_compression_level).toBe(45.0);
  });

  test("test_compression_dwab", () => {
    const project = parse_project(FORMAT_DIR.div("openexr", "compression_dwab_200.0.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, OpenExrFormatOptions);
    expect(opts instanceof OpenExrFormatOptions).toBe(true);
    expect(opts.compression).toBe(OpenExrCompression.DWAB);
    expect(opts.dwa_compression_level).toBe(200.0);
  });

  test("test_luminance_chroma_on", () => {
    const project = parse_project(FORMAT_DIR.div("openexr", "compression_zip_luminance_chroma.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, OpenExrFormatOptions);
    expect(opts instanceof OpenExrFormatOptions).toBe(true);
    expect(opts.luminance_chroma).toBe(true);
  });

  test("test_32_bit_float_on", () => {
    const project = parse_project(FORMAT_DIR.div("openexr", "compression_zip_32_bit_float.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, OpenExrFormatOptions);
    expect(opts instanceof OpenExrFormatOptions).toBe(true);
    expect(opts.thirty_two_bit_float).toBe(true);
  });

  test("test_dwa_compression_level_dwaa_custom", () => {
    const project = parse_project(FORMAT_DIR.div("openexr", "compression_dwaa_1.0.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, OpenExrFormatOptions);
    expect(opts instanceof OpenExrFormatOptions).toBe(true);
    expect(opts.dwa_compression_level).toBe(1.0);
  });

  test("test_dwa_compression_level_dwaa_large", () => {
    const project = parse_project(FORMAT_DIR.div("openexr", "compression_dwaa_10000000000.0.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, OpenExrFormatOptions);
    expect(opts instanceof OpenExrFormatOptions).toBe(true);
    expect(opts.dwa_compression_level).toBe(10000000000.0);
  });

  test("test_dwa_compression_level_dwab", () => {
    const project = parse_project(FORMAT_DIR.div("openexr", "compression_dwab_200.0.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, OpenExrFormatOptions);
    expect(opts instanceof OpenExrFormatOptions).toBe(true);
    expect(opts.dwa_compression_level).toBe(200.0);
  });
});

/** Tests for PNG format options (typed binary). */
describe("TestPngFormatOptions", () => {
  test("test_base_defaults", () => {
    const project = parse_project(FORMAT_DIR.div("png", "base.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, PngFormatOptions);
    expect(opts instanceof PngFormatOptions).toBe(true);
    expect(opts.width).toBe(1920);
    expect(opts.height).toBe(1080);
    expect(opts.bit_depth).toBe(16);
    expect(opts.include_hdr10_metadata).toBe(false);
    expect(opts.luminance_min).toBe(null);
    expect(opts.luminance_max).toBe(null);
    expect(opts.content_light_max).toBe(null);
    expect(opts.content_light_average).toBe(null);
  });

  test("test_compression_none", () => {
    const project = parse_project(FORMAT_DIR.div("png", "compression_none.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, PngFormatOptions);
    expect(opts instanceof PngFormatOptions).toBe(true);
    expect(opts.compression).toBe(PngCompression.NONE);
  });

  test("test_compression_interlaced", () => {
    const project = parse_project(FORMAT_DIR.div("png", "compression_interlaced.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, PngFormatOptions);
    expect(opts instanceof PngFormatOptions).toBe(true);
    expect(opts.compression).toBe(PngCompression.INTERLACED);
  });

  test("test_include_hdr10_metadata_on", () => {
    const project = parse_project(FORMAT_DIR.div("png", "include_hdr10_metadata_on.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, PngFormatOptions);
    expect(opts instanceof PngFormatOptions).toBe(true);
    expect(opts.include_hdr10_metadata).toBe(true);
    expect(opts.color_primaries).toBe(Hdr10ColorPrimaries.P3_D65);
  });

  test("test_color_primaries_rec709", () => {
    const project = parse_project(FORMAT_DIR.div("png", "color_primaries_rec709.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, PngFormatOptions);
    expect(opts instanceof PngFormatOptions).toBe(true);
    expect(opts.color_primaries).toBe(Hdr10ColorPrimaries.REC709);
  });

  test("test_color_primaries_rec2020", () => {
    const project = parse_project(FORMAT_DIR.div("png", "color_primaries_rec2020.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, PngFormatOptions);
    expect(opts instanceof PngFormatOptions).toBe(true);
    expect(opts.color_primaries).toBe(Hdr10ColorPrimaries.REC2020);
  });

  test("test_color_primaries_p3d65", () => {
    const project = parse_project(FORMAT_DIR.div("png", "color_primaries_p3d65.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, PngFormatOptions);
    expect(opts instanceof PngFormatOptions).toBe(true);
    expect(opts.color_primaries).toBe(Hdr10ColorPrimaries.P3_D65);
  });

  test("test_luminance_min_zero", () => {
    const project = parse_project(FORMAT_DIR.div("png", "luminance_min_0.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, PngFormatOptions);
    expect(opts instanceof PngFormatOptions).toBe(true);
    expect(opts.luminance_min).toBe(0.0);
  });

  test("test_luminance_max_set", () => {
    const project = parse_project(FORMAT_DIR.div("png", "luminance_max_1.797693e+308.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, PngFormatOptions);
    expect(opts instanceof PngFormatOptions).toBe(true);
    expect(opts.luminance_max).toBe(1.7976931348623157e308);
  });

  test("test_content_light_max_set", () => {
    const project = parse_project(
      FORMAT_DIR.div("png", "content_light_levels_maximum_1.797693e+308.aep"),
    );
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, PngFormatOptions);
    expect(opts instanceof PngFormatOptions).toBe(true);
    expect(opts.content_light_max).toBe(1.7976931348623157e308);
  });

  test("test_content_light_average_set", () => {
    const project = parse_project(
      FORMAT_DIR.div("png", "content_light_levels_average_1.797693e+308.aep"),
    );
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, PngFormatOptions);
    expect(opts instanceof PngFormatOptions).toBe(true);
    expect(opts.content_light_average).toBe(1.7976931348623157e308);
  });
});

/** Tests for Targa format options (binary). */
describe("TestTargaFormatOptions", () => {
  test("test_base_defaults", () => {
    const project = parse_project(FORMAT_DIR.div("targa", "base.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, TargaFormatOptions);
    expect(opts instanceof TargaFormatOptions).toBe(true);
    expect(opts.bits_per_pixel).toBe(32);
    expect(opts.rle_compression).toBe(false);
  });

  test("test_24_bits_per_pixel", () => {
    const project = parse_project(FORMAT_DIR.div("targa", "24_bits_per_pixel.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, TargaFormatOptions);
    expect(opts instanceof TargaFormatOptions).toBe(true);
    expect(opts.bits_per_pixel).toBe(24);
  });

  test("test_32_bits_per_pixel", () => {
    const project = parse_project(FORMAT_DIR.div("targa", "32_bits_per_pixel.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, TargaFormatOptions);
    expect(opts instanceof TargaFormatOptions).toBe(true);
    expect(opts.bits_per_pixel).toBe(32);
  });

  test("test_rle_compression_on", () => {
    const project = parse_project(FORMAT_DIR.div("targa", "rle_compression_on.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, TargaFormatOptions);
    expect(opts instanceof TargaFormatOptions).toBe(true);
    expect(opts.rle_compression).toBe(true);
    expect(opts.bits_per_pixel).toBe(24);
  });
});

/** Tests for TIFF format options. */
describe("TestTiffFormatOptions", () => {
  test("test_base_defaults", () => {
    const project = parse_project(FORMAT_DIR.div("tiff", "base.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, TiffFormatOptions);
    expect(opts instanceof TiffFormatOptions).toBe(true);
    expect(opts.lzw_compression).toBe(false);
    expect(opts.ibm_pc_byte_order).toBe(false);
  });

  test("test_lzw_compression_on", () => {
    const project = parse_project(FORMAT_DIR.div("tiff", "lze_compression_on.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, TiffFormatOptions);
    expect(opts instanceof TiffFormatOptions).toBe(true);
    expect(opts.lzw_compression).toBe(true);
    expect(opts.ibm_pc_byte_order).toBe(false);
  });

  test("test_ibm_pc_byte_order_on", () => {
    const project = parse_project(FORMAT_DIR.div("tiff", "ibm_pc_byte_order_on.aep"));
    const opts = as_instance(as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options, TiffFormatOptions);
    expect(opts instanceof TiffFormatOptions).toBe(true);
    expect(opts.ibm_pc_byte_order).toBe(true);
    expect(opts.lzw_compression).toBe(false);
  });
});
