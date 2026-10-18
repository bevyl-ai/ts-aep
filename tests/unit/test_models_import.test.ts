/** Tests for media-file probing and file-source creation via import_file. */

import { describe, expect, test } from "bun:test";

import "../../src/py_aep/binary/_register.ts";
import { BytesIO, NotImplementedError, Path, ValueError, b, Bytes, concat, decode, encode, floordiv, valueEquals, struct } from "../../src/pyrt/index.ts";
import { approx, raises } from "../../src/pyrt/pytest.ts";
import { _FILE_FORMATS } from "../../src/py_aep/data/file_formats.ts";
import { _PARSERS, _probeBmp, _probeDpxCineon, _probeGif, _probeHdr, _probeHeif, _probeMgjson, _probeMov, _probeMp3, _probeTiff, probeMedia } from "../../src/py_aep/resolvers/media_probe.ts";
import { buildAiDocumentOptiData, buildCrawOptiData, buildDpxOptiData, buildPsdLayerOptiData, buildPsdOptiData, buildRhdrOptiData, buildTextOptiData, buildTiffOptiData } from "../../src/py_aep/binary/footage_chunks.ts";

const ASSETS = new Path(import.meta.dir, "..", "..", "samples", "assets");
const BASE = new Path(import.meta.dir, "..", "..", "samples", "models", "folder", "folder.aep");
const IMPORT_DIR = new Path(import.meta.dir, "..", "..", "samples", "models", "import");

describe("TestMediaProbe", () => {
  /** Media-header probing matches the values AE reads on import. */

  test.each([
    ["image_with_alpha.png", 640, 346, true],
    ["8bits_compressed.png", 25, 26, true],
    ["8bits.tif", 25, 26, true],
    ["8bits_transparency.tif", 25, 26, true],
    ["11_progressive.jpg", 25, 26, false],
    ["tga_16.tga", 25, 26, false],
    ["tga_24.tga", 25, 26, false],
    ["tga_32.tga", 25, 26, true],
    ["bmp.bmp", 25, 26, true],
    ["sequence_001.gif", 146, 93, true],
    ["8bits.psd", 25, 26, true],
    ["8bits.psb", 25, 26, true],
    ["cin.cin", 16, 16, false],
    ["dpx_8bit_rgb.dpx", 16, 16, false],
    ["dpx_8bit_rgba.dpx", 16, 16, true],
    ["dpx_10bit_be.dpx", 16, 16, false],
    ["dpx_12bit_be.dpx", 16, 16, false],
    ["dpx_16bit_rgba_be.dpx", 16, 16, true],
    ["heic.heic", 16, 16, false],
    ["heic_alpha.heic", 16, 16, true],
  ])("test_still_image[%#]", (name: string, width: number, height: number, hasAlpha: boolean) => {
    const info = probeMedia(ASSETS.div(name));
    expect(info.width).toBe(width);
    expect(info.height).toBe(height);
    expect(info.hasAlpha).toBe(hasAlpha);
    expect(info.duration).toBe(0.0);
  });

  test.each([
    ["new_exr.0002.exr", 2356, 1002, false],
    ["old_exr.00004.exr", 2356, 1002, true],
  ])("test_exr[%#]", (name: string, width: number, height: number, hasAlpha: boolean) => {
    const info = probeMedia(ASSETS.div(name));
    expect(valueEquals([info.width, info.height], [width, height])).toBe(true);
    expect(info.hasAlpha).toBe(hasAlpha);
  });

  test.each(["8bits.psd", "8bits.psb"])("test_psd_metadata[%#]", (name: string) => {
    const info = probeMedia(ASSETS.div(name));
    expect(valueEquals([info.width, info.height], [25, 26])).toBe(true);
    expect(info.bitDepth).toBe(8);
    expect(info.layerCount).toBe(2);
  });

  test("test_wav", () => {
    const info = probeMedia(ASSETS.div("wav.wav"));
    expect(info.width).toBe(0);
    expect(info.height).toBe(0);
    expect(info.hasAudio).toBe(true);
    expect(info.audioSampleRate).toBe(44100.0);
    expect(approx(info.duration, 5.9431746, { abs: 1e-4 })).toBe(true);
  });

  test.each([
    ["mov_480.mov", 480, 270, 30.0, true, false, 1.0],
    ["mov_23_976.mov", 480, 270, 23.976, true, false, 1.0],
    ["mov_23_976_no_audio.mov", 480, 270, 23.976, false, false, 1.0],
    ["mov_alpha_small.mov", 320, 240, 25.0, false, true, 1.33333],
  ])(
    "test_mov[%#]",
    (
      name: string,
      width: number,
      height: number,
      fps: number,
      hasAudio: boolean,
      hasAlpha: boolean,
      pixelAspect: number,
    ) => {
      const info = probeMedia(ASSETS.div(name));
      expect(valueEquals([info.width, info.height], [width, height])).toBe(true);
      expect(approx(info.frameRate, fps, { abs: 1e-3 })).toBe(true);
      expect(info.hasAudio).toBe(hasAudio);
      expect(info.hasAlpha).toBe(hasAlpha);
      expect(approx(info.pixelAspect, pixelAspect, { abs: 1e-4 })).toBe(true);
    },
  );

  test("test_m4v", () => {
    // MP4 video shares the QuickTime atom tree, so _probe_mov parses it.
    const info = probeMedia(ASSETS.div("m4v.m4v"));
    expect(valueEquals([info.width, info.height], [640, 360])).toBe(true);
    expect(approx(info.frameRate, 29.97, { abs: 1e-3 })).toBe(true);
    expect(info.hasAudio).toBe(false);
    expect(approx(info.duration, 13.3467, { abs: 1e-3 })).toBe(true);
  });

  test("test_aif", () => {
    const info = probeMedia(ASSETS.div("aif.aif"));
    expect(info.width).toBe(0);
    expect(info.height).toBe(0);
    expect(info.hasAudio).toBe(true);
    expect(info.audioSampleRate).toBe(44100.0);
    expect(approx(info.duration, 0.5, { abs: 1e-5 })).toBe(true);
  });

  test("test_mp4_h264", () => {
    // avc1 video + AAC audio, moov ahead of mdat. Values are AE 2026's.
    const info = probeMedia(ASSETS.div("mp4_5s-360p.mp4"));
    expect(valueEquals([info.width, info.height], [640, 360])).toBe(true);
    expect(approx(info.frameRate, 30.0, { abs: 1e-3 })).toBe(true);
    // The video track's duration wins over the longer mvhd/audio duration.
    expect(approx(info.duration, 5.7, { abs: 1e-4 })).toBe(true);
    expect(info.hasAudio).toBe(true);
    expect(info.audioSampleRate).toBe(44100.0);
  });

  test("test_mp4_moov_after_mdat", () => {
    // This file stores moov at the end, so the probe must scan past mdat.
    const info = probeMedia(ASSETS.div("mp4_640x360.mp4"));
    expect(valueEquals([info.width, info.height], [640, 360])).toBe(true);
    expect(approx(info.frameRate, 29.97, { abs: 1e-3 })).toBe(true);
    expect(approx(info.duration, 13.3467, { abs: 1e-3 })).toBe(true);
    expect(info.hasAudio).toBe(false);
  });

  test("test_mp4_undecodable_codec_reports_audio_only", () => {
    // AE 2026 decodes neither AV1 nor VP9 in MP4: it drops the video track
    // and imports whatever is left. An .aep that claims the real video
    // track instead makes AE report the footage MISSING on open
    // (measured), so the probe must drop it exactly as AE does.
    const info = probeMedia(ASSETS.div("mp4_av1_with_audio.mp4"));
    expect(valueEquals([info.width, info.height], [0, 0])).toBe(true);
    expect(info.frameRate).toBe(0.0);
    expect(info.hasAudio).toBe(true);
    // Audio-only duration comes from the edit list, matching AE's 1.0.
    expect(approx(info.duration, 1.0, { abs: 1e-3 })).toBe(true);
  });

  test("test_mp4_undecodable_codec_with_nothing_left_is_refused", () => {
    // Whether AE refuses turns on what survives, not on the codec: with no
    // audio to keep, AE refuses the file itself ("The source compression
    // type is not supported"), so there is no import to reproduce and
    // probing must raise. Both halves measured in AE 2026 (see _probe_mp4).
    raises(ValueError, () => probeMedia(ASSETS.div("mp4_vp9_no_audio.mp4")), "no video track");
  });

  test("test_undecodable_codec_gate_is_mp4_only", () => {
    // The gate is codec policy, not a parse failure, and .mov/.m4v go
    // through AE's QuickTime importer, which decodes a wider set - so the
    // ungated probe must still read both files' real video track.
    for (const name of ["mp4_av1_with_audio.mp4", "mp4_vp9_no_audio.mp4"]) {
      const fp = new BytesIO(ASSETS.div(name).readBytes());
      const info = _probeMov(fp);
      expect([name, [info.width, info.height]]).toEqual([name, [64, 64]]);
    }
  });

  test("test_aiff", () => {
    const info = probeMedia(ASSETS.div("click.aiff"));
    expect(info.width).toBe(0);
    expect(info.height).toBe(0);
    expect(info.hasAudio).toBe(true);
    expect(info.audioSampleRate).toBe(44100.0);
    expect(approx(info.duration, 0.1274376, { abs: 1e-5 })).toBe(true);
  });

  test("test_unsupported_format_raises", () => {
    // .c4d import is deferred (no media probe), so probing must raise.
    raises(NotImplementedError, () => probeMedia(ASSETS.div("c4d.c4d")));
  });

  test("test_every_importable_format_has_probe", () => {
    // Every extension import_file accepts must have a media probe;
    // otherwise import dies mid-probe with NotImplementedError instead
    // of the early ValueError for unsupported formats.
    const importable = new Set(
      [..._FILE_FORMATS.entries()].filter(([, fmt]) => fmt.opti !== "unsupported").map(([ext]) => ext),
    );
    expect([...importable].every((ext) => _PARSERS.has(ext))).toBe(true);
  });
});

describe("TestProbeFormatVariants", () => {
  /** Spec-derived edge cases not covered by the samples/assets/ files. */

  test("test_gif_bad_signature_raises", () => {
    raises(ValueError, () => _probeGif(new BytesIO(b("NOTGIFdata"))), "GIF");
  });

  test("test_dpx_bad_signature_raises", () => {
    raises(ValueError, () => _probeDpxCineon(new BytesIO(Bytes.repeat(b("NOTDPXdata"), 150))), "DPX/Cineon");
  });

  test("test_dpx_truncated_header_raises", () => {
    raises(ValueError, () => _probeDpxCineon(new BytesIO(b("SDPX\x00\x00\x08\x00"))), "too short");
  });

  test("test_heif_bad_ftyp_raises", () => {
    raises(ValueError, () => _probeHeif(new BytesIO(b("\x00\x00\x00\x14ftypmp41\x00\x00\x00\x00mp41"))), "HEIF");
  });

  test("test_heif_truncated_raises", () => {
    raises(ValueError, () => _probeHeif(new BytesIO(b("\x00\x00\x00\x08"))), "too short");
  });

  test("test_bmp_os2_core_header", () => {
    /** Legacy OS/2 BITMAPCOREHEADER (size 12) stores dims as u2. */
    const data = concat(
      b("BM"),
      Bytes.repeat(b("\x00"), 12), // rest of the 14-byte BITMAPFILEHEADER
      struct.pack("<I", 12), // BITMAPCOREHEADER size
      struct.pack("<HH", 100, 50), // width, height (u2)
      struct.pack("<HH", 1, 24), // planes, bpp
    );
    const info = _probeBmp(new BytesIO(data));
    expect(valueEquals([info.width, info.height], [100, 50])).toBe(true);
    expect(info.hasAlpha).toBe(true);
  });

  test("test_tiff_bigtiff_returns_unknown", () => {
    /** BigTIFF (magic 43) is not a classic TIFF; probe returns no dims. */
    const data = concat(b("II"), struct.pack("<H", 43), struct.pack("<H", 8), Bytes.repeat(b("\x00"), 16));
    const info = _probeTiff(new BytesIO(data));
    expect(valueEquals([info.width, info.height], [0, 0])).toBe(true);
  });

  test("test_mp3_mpeg2_cbr_duration", () => {
    /** MPEG-2/2.5 Layer III CBR frames are 72*bitrate/sr, not 144. */
    // MPEG-2 (version bits 10) Layer III, no CRC, bitrate index 8
    // (64 kbps), sample-rate index 0 (22050 Hz), stereo.
    const header = b("\xff\xf3\x80\x00");
    const frameSize = floordiv(72 * 64000, 22050); // 208 (the 144 bug computes ~2x this)
    const raw = concat(header, Bytes.repeat(b("\x00"), 100 * frameSize - header.length));
    const info = _probeMp3(new BytesIO(raw));
    // 100 frames * 576 samples / 22050 Hz; the 144 coefficient halved this.
    expect(approx(info.duration, (100 * 576) / 22050, { abs: 1e-3 })).toBe(true);
    expect(info.audioSampleRate).toBe(22050.0);
  });

  test("test_hdr_x_major_resolution_line", () => {
    /** An X-major Radiance resolution line must not transpose dims. */
    // "+X 640 -Y 426" (X-major) must still yield width=640, height=426.
    const data = b("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n+X 640 -Y 426\n");
    const info = _probeHdr(new BytesIO(data));
    expect(valueEquals([info.width, info.height], [640, 426])).toBe(true);
  });

  test("test_hdr_malformed_resolution_line_raises_valueerror", () => {
    /** A resolution line missing an axis must raise ValueError, not KeyError. */
    // No Y axis ("+X 640 +X 480") - must not leak a bare KeyError.
    const data = b("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n+X 640 +X 480\n");
    raises(ValueError, () => _probeHdr(new BytesIO(data)));
  });

  test.each([
    [0, [1536, 1024]],
    [90, [1024, 1536]],
    [180, [1536, 1024]],
    [270, [1024, 1536]],
  ])("test_crw_image_info_rotation[%#]", (rotation: number, size: number[]) => {
    /** Camera Raw develops a CRW turned by its ImageInfo rotation: AE 2026
     * reports the sample marked 90 or 270 degrees as 1024x1536. */
    const data = ASSETS.div("crw.crw").readBytes();
    const record = struct.pack("<IIfi", 1536, 1024, 1.0, 0);
    expect(Bytes.count(data, record)).toBe(1);
    const rotated = Bytes.replace(data, record, struct.pack("<IIfi", 1536, 1024, 1.0, rotation));
    const info = probeMedia(ASSETS.div("crw.crw"), rotated);
    expect(valueEquals([info.width, info.height], size)).toBe(true);
  });

  test("test_crw_bad_signature_raises_valueerror", () => {
    raises(ValueError, () =>
      probeMedia(new Path("x.crw"), concat(b("II\x1a\x00\x00\x00NOTACIFF"), Bytes.repeat(b("\x00"), 16))),
    );
  });

  test("test_crw_self_containing_heap_raises_valueerror", () => {
    /** A sub-heap spanning its whole parent heap is malformed: reject it
     * rather than recurse forever. */
    // Heap after the 14-byte header: a one-entry table at offset 0 whose
    // sub-heap entry (tag 0x2800) covers the heap itself, then the table
    // offset.
    const heap = concat(struct.pack("<HHII", 1, 0x2800, 16, 0), struct.pack("<I", 0));
    const data = concat(b("II"), struct.pack("<I", 14), b("HEAPCCDR"), heap);
    raises(ValueError, () => probeMedia(new Path("x.crw"), data));
  });

  test("test_mgjson_tolerant_timestamps", () => {
    /** Sample times with sub-second precision / offsets that Python 3.7's
     * strict fromisoformat rejects must parse, not crash the probe. */
    const doc = {
      dataDynamicSamples: [
        {
          samples: [
            { time: "2020-01-01T00:00:00.1234567Z" },
            { time: "2020-01-01T00:00:05.0000000+00:00" },
          ],
        },
      ],
    };
    const info = _probeMgjson(new BytesIO(encode(JSON.stringify(doc), "utf-8")));
    // Both samples parse (5.0s - 0.123s span + one 30fps frame); if either
    // timestamp had failed to parse the span would collapse to ~0.03s.
    expect(info.duration != null).toBe(true);
    expect(4.8 < info.duration && info.duration < 5.0).toBe(true);
  });
});

describe("TestTiffOpti", () => {
  /** The reverse-engineered TIFF opti header. */

  test("test_build_tiff_opti_data", () => {
    const data = buildTiffOptiData(25, 26, 16, 2, 1, 1);
    expect(data.length).toBe(602);
    expect(valueEquals(data.slice(0, 4), b("TIF "))).toBe(true);
    expect(data[0x1e]).toBe(2); // channels: gray + alpha
    expect(struct.unpackFrom("<I", data, 32)[0]).toBe(26); // height
    expect(struct.unpackFrom("<I", data, 36)[0]).toBe(25); // width
    expect(struct.unpackFrom("<H", data, 0x28)[0]).toBe(16); // bits per sample
    expect(struct.unpackFrom("<H", data, 0x2a)[0]).toBe(1); // grayscale
    expect(struct.unpackFrom("<H", data, 0x30)[0]).toBe(1); // layers
  });

  test.each([
    ["depth/tif_bilevel.tif", 0, 0],
    ["depth/tif_g16_be.tif", 1, 0],
    ["depth/tif_pal8.tif", 2, 0],
    ["depth/tif_rgb8.tif", 3, 0],
    ["depth/tif_cmyk8.tif", 4, 0],
    // An alpha sample counts as one layer; an unspecified extra
    // sample does not.
    ["depth/tif_ga8.tif", 1, 1],
    ["depth/tif_rgba8_unassoc.tif", 3, 1],
    ["depth/tif_rgb8_extra0.tif", 3, 0],
    // Photoshop layer data (tag 37724) in a little-endian TIFF.
    ["8bits.tif", 3, 2],
    ["depth/tif_ps_no34377.tif", 3, 2],
  ])("test_probe_reads_photoshop_mode_and_layers[%#]", (name: string, colorMode: number, layerCount: number) => {
    // The colour mode and layer count AE records for a TIFF
    // (footage_depth.aep, AE 2026).
    const info = probeMedia(ASSETS.div(name));
    expect(valueEquals([info.colorMode, info.layerCount], [colorMode, layerCount])).toBe(true);
  });
});

describe("TestPsdOpti", () => {
  /** The reverse-engineered merged-PSD opti header. */

  test("test_build_psd_opti_data", () => {
    const data = buildPsdOptiData(25, 26, 8, 4, 3, 2);
    expect(data.length).toBe(602);
    expect(valueEquals(data.slice(0, 4), b("8BPS"))).toBe(true);
    expect(valueEquals(data.slice(0x12, 0x16), b("SPB8"))).toBe(true); // reversed code
    expect(data[0x1e]).toBe(4); // channels: RGB + alpha
    expect(struct.unpackFrom("<I", data, 0x20)[0]).toBe(26); // height
    expect(struct.unpackFrom("<I", data, 0x24)[0]).toBe(25); // width
    expect(struct.unpackFrom("<H", data, 0x28)[0]).toBe(8); // bit depth
    expect(struct.unpackFrom("<H", data, 0x2a)[0]).toBe(3); // RGB
    expect(data[0x30]).toBe(2); // layer count
  });

  test("test_flattened_psd_stores_no_layers", () => {
    // A flattened gray PSD: one channel, grayscale, 0 layers (AE 2026,
    // footage_depth.aep psd_gray16_flat.psd).
    const data = buildPsdOptiData(8, 8, 16, 1, 1, 0);
    expect(valueEquals([data[0x1e], data[0x2a], data[0x30]], [1, 1, 0])).toBe(true);
  });

  test.each([
    ["depth/psd_gray8_flat.psd", 1],
    ["depth/psd_cmyk8_flat.psd", 4],
    ["8bits.psd", 3],
  ])("test_probe_reads_the_color_mode[%#]", (name: string, colorMode: number) => {
    expect(probeMedia(ASSETS.div(name)).colorMode).toBe(colorMode);
  });

  test("test_layer_name_truncates_on_utf8_boundary", () => {
    /** A >255-byte layer name is cut on a char boundary, not mid-sequence. */
    // 4-byte chars: 255 is not a multiple of 4, so a naive [:255] slice
    // would split the 64th char (252 full bytes + 3 partial).
    const name = "\u{1f600}".repeat(120);
    const data = buildPsdLayerOptiData(100, 100, 8, 2, 0, 1, name, [0, 0, 100, 100]);
    const raw = data.slice(0x158);
    const decoded = decode(raw.slice(0, Bytes.indexOrThrow(raw, 0)), "utf-8"); // must not raise
    expect(decoded).toBe("\u{1f600}".repeat(floordiv(255, 4)));
  });
});

describe("TestGapOptiBuilders", () => {
  /** opti builders for the newly supported HDR and TEXT (AI/EPS/PDF) formats. */

  test("test_build_dpx_opti_data", () => {
    const data = buildDpxOptiData();
    expect(data.length).toBe(48);
    expect(valueEquals(data.slice(0, 4), b("sDPX"))).toBe(true);
  });

  test("test_build_rhdr_opti_data", () => {
    const data = buildRhdrOptiData();
    expect(data.length).toBe(30);
    expect(valueEquals(data.slice(0, 4), b("RHDR"))).toBe(true);
  });

  test("test_build_craw_opti_data", () => {
    // What AE 2026 writes back for a camera raw file without develop
    // settings (its heap-address tail zeroed).
    expect(
      valueEquals(buildCrawOptiData(), concat(b("Craw\x00\x2e\x00\x00\x00\x1e"), Bytes.repeat(b("\x00"), 20))),
    ).toBe(true);
  });

  test("test_build_text_opti_data", () => {
    const data = buildTextOptiData(612, 792);
    expect(data.length).toBe(596);
    expect(valueEquals(data.slice(0, 4), b("TEXT"))).toBe(true);
    expect(struct.unpackFrom(">H", data, 24)[0]).toBe(612); // width
    expect(struct.unpackFrom(">H", data, 28)[0]).toBe(792); // height
    expect(valueEquals(data.slice(40, 44), b("\xff\xff\xff\xff"))).toBe(true);
  });

  test("test_build_ai_document_opti_data", () => {
    // ai.ai imported whole (AE 2026, footage_depth.aep): its layer
    // count, one page, no chosen layer, and the page-size tail.
    const data = buildAiDocumentOptiData(612, 792, 2);
    expect(data.length).toBe(596);
    expect(struct.unpackFrom(">I", data, 0x30)[0]).toBe(2);
    expect(valueEquals([data[0x3c], data[0x3d]], [1, 0])).toBe(true);
    expect(data[0x44]).toBe(0); // no layer name
    expect(valueEquals(struct.unpackFrom(">HxxH", data, 0x248), [792, 612])).toBe(true);
  });
});
