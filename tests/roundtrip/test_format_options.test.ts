/** Tests for OutputModule.formatOptions parsing. */

import { describe, expect, test } from "bun:test";

import {
  AttributeError,
  contains,
  float,
  getMember,
  getOrThrow,
  int,
  len,
  Path,
  assert,
  valueEquals,
  setMember,
  sorted,
  compositeKey,
  ValueError,
} from "../../src/pyrt/index.ts";
import { makeTmpPath, raises } from "../../src/pyrt/pytest.ts";
import { parse, type Project } from "../../src/py_aep/index.ts";
import "../../src/py_aep/binary/_register.ts";
import type { Element as ETElement } from "../../src/pyrt/etree.ts";
import { AudioCodec, CineonFileFormat, DnxResolution, Hdr10ColorPrimaries, JpegFormatType, MPEGAudioFormat, MPEGMultiplexer, MPEGMuxStreamCompatibility, MPEGProfile, OpenExrCompression, OutputChannels, OutputColorDepth, PngCompression, VideoCodec } from "../../src/py_aep/enums/index.ts";
import { CineonFormatOptions, JpegFormatOptions, OpenExrFormatOptions, PngFormatOptions, TargaFormatOptions, TiffFormatOptions, XmlFormatOptions } from "../../src/py_aep/models/renderqueue/format_options/index.ts";
import type { OutputModule } from "../../src/py_aep/models/renderqueue/output_module.ts";
import { RenderQueue } from "../../src/py_aep/models/renderqueue/render_queue.ts";
import { asInstance } from "../helpers.ts";

const FORMAT_DIR = new Path(import.meta.dir, "..", "..", "samples", "models", "format_options");
const CINEON_DIR = FORMAT_DIR.div("cineon");
const AVI_DIR = FORMAT_DIR.div("avi");

/** Parse without caching and return (project, format_options). */
function _parseFresh(path: Path): [Project, OutputModule["formatOptions"]] {
  const project = parse(path).project;
  const opts = asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions;
  return [project, opts];
}

describe("TestRoundtripTargaFormatOptions", () => {
  /** Roundtrip tests for TargaFormatOptions. */
  test("test_modify_bits_per_pixel", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("targa", "base.aep"));
    assert(opts instanceof TargaFormatOptions);
    expect(opts.bitsPerPixel).toBe(32);
    opts.bitsPerPixel = 24;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof TargaFormatOptions);
    expect(opts2.bitsPerPixel).toBe(24);
  });

  test("test_modify_rle_compression", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("targa", "base.aep"));
    assert(opts instanceof TargaFormatOptions);
    expect(opts.rleCompression).toBe(false);
    opts.rleCompression = true;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof TargaFormatOptions);
    expect(opts2.rleCompression).toBe(true);
  });

  test("test_validate_bits_per_pixel", () => {
    const [, opts] = _parseFresh(FORMAT_DIR.div("targa", "base.aep"));
    assert(opts instanceof TargaFormatOptions);
    raises(ValueError, () => {
      opts.bitsPerPixel = 16;
    });
  });
});

describe("TestRoundtripTiffFormatOptions", () => {
  /** Roundtrip tests for TiffFormatOptions. */
  test("test_modify_lzw_compression", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("tiff", "base.aep"));
    assert(opts instanceof TiffFormatOptions);
    expect(opts.lzwCompression).toBe(false);
    opts.lzwCompression = true;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof TiffFormatOptions);
    expect(opts2.lzwCompression).toBe(true);
  });

  test("test_modify_ibm_pc_byte_order", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("tiff", "base.aep"));
    assert(opts instanceof TiffFormatOptions);
    expect(opts.ibmPcByteOrder).toBe(false);
    opts.ibmPcByteOrder = true;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof TiffFormatOptions);
    expect(opts2.ibmPcByteOrder).toBe(true);
  });
});

describe("TestRoundtripJpegFormatOptions", () => {
  /** Roundtrip tests for JpegFormatOptions. */
  test("test_modify_quality", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("jpeg", "base.aep"));
    assert(opts instanceof JpegFormatOptions);
    opts.quality = 10;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof JpegFormatOptions);
    expect(opts2.quality).toBe(10);
  });

  test("test_modify_format_type", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("jpeg", "base.aep"));
    assert(opts instanceof JpegFormatOptions);
    opts.formatType = JpegFormatType.PROGRESSIVE;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof JpegFormatOptions);
    expect(opts2.formatType).toBe(JpegFormatType.PROGRESSIVE);
  });

  test("test_modify_scans", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("jpeg", "progressive_3.aep"));
    assert(opts instanceof JpegFormatOptions);
    expect(opts.scans).toBe(3);
    opts.scans = 5;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof JpegFormatOptions);
    expect(opts2.scans).toBe(5);
  });

  test("test_validate_quality_too_high", () => {
    const [, opts] = _parseFresh(FORMAT_DIR.div("jpeg", "base.aep"));
    assert(opts instanceof JpegFormatOptions);
    raises(ValueError, () => {
      opts.quality = 11;
    });
  });

  test("test_validate_scans_invalid", () => {
    const [, opts] = _parseFresh(FORMAT_DIR.div("jpeg", "progressive_3.aep"));
    assert(opts instanceof JpegFormatOptions);
    raises(ValueError, () => {
      opts.scans = 2;
    });
  });
});

describe("TestRoundtripCineonFormatOptions", () => {
  /** Roundtrip tests for CineonFormatOptions. */
  test("test_modify_ten_bit_black_point", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("cineon", "base.aep"));
    assert(opts instanceof CineonFormatOptions);
    opts.tenBitBlackPoint = 100;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof CineonFormatOptions);
    expect(opts2.tenBitBlackPoint).toBe(100);
  });

  test("test_modify_logarithmic_conversion", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("cineon", "base.aep"));
    assert(opts instanceof CineonFormatOptions);
    expect(opts.logarithmicConversion).toBe(false);
    opts.logarithmicConversion = true;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof CineonFormatOptions);
    expect(opts2.logarithmicConversion).toBe(true);
  });

  test("test_modify_file_format", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("cineon", "base.aep"));
    assert(opts instanceof CineonFormatOptions);
    opts.fileFormat = CineonFileFormat.FIDO_CINEON;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof CineonFormatOptions);
    expect(opts2.fileFormat).toBe(CineonFileFormat.FIDO_CINEON);
  });

  test("test_modify_bit_depth", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("cineon", "base.aep"));
    assert(opts instanceof CineonFormatOptions);
    opts.bitDepth = 8;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof CineonFormatOptions);
    expect(opts2.bitDepth).toBe(8);
  });

  test("test_validate_bit_depth_rejects_invalid", () => {
    const [, opts] = _parseFresh(FORMAT_DIR.div("cineon", "base.aep"));
    assert(opts instanceof CineonFormatOptions);
    raises(ValueError, () => {
      opts.bitDepth = 9;
    });
  });

  test("test_validate_ten_bit_black_point_rejects_negative", () => {
    const [, opts] = _parseFresh(FORMAT_DIR.div("cineon", "base.aep"));
    assert(opts instanceof CineonFormatOptions);
    raises(ValueError, () => {
      opts.tenBitBlackPoint = -1;
    });
  });

  test("test_validate_ten_bit_black_point_rejects_too_high", () => {
    const [, opts] = _parseFresh(FORMAT_DIR.div("cineon", "base.aep"));
    assert(opts instanceof CineonFormatOptions);
    raises(ValueError, () => {
      opts.tenBitBlackPoint = 1024;
    });
  });

  // Backed by a u2 field: an unbounded value overflowed `struct` and
  // crashed save() mid-write, leaving a partial .aep.
  test.each([-100, 0x10000, 10 ** 12])("test_validate_highlight_expansion_rejects_out_of_u2[%#]", (value) => {
    const [, opts] = _parseFresh(FORMAT_DIR.div("cineon", "base.aep"));
    assert(opts instanceof CineonFormatOptions);
    raises(ValueError, () => {
      opts.highlightExpansion = value;
    });
  });

  const FLOAT_NONFINITE_ROWS: [string, number][] = [
    "convertedBlackPoint",
    "convertedWhitePoint",
    "currentGamma",
  ].flatMap((field) => [float("nan"), float("inf")].map((bad): [string, number] => [field, bad]));

  test.each(FLOAT_NONFINITE_ROWS)("test_validate_float_fields_reject_nonfinite[%#]", (field, bad) => {
    const [, opts] = _parseFresh(FORMAT_DIR.div("cineon", "base.aep"));
    assert(opts instanceof CineonFormatOptions);
    raises(
      ValueError,
      () => {
        setMember(opts, field, bad);
      },
      "finite",
    );
  });

  test("test_highlight_expansion_valid_roundtrips", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("cineon", "base.aep"));
    assert(opts instanceof CineonFormatOptions);
    opts.highlightExpansion = 42;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof CineonFormatOptions);
    expect(opts2.highlightExpansion).toBe(42);
  });
});

describe("TestRoundtripOpenExrFormatOptions", () => {
  /** Roundtrip tests for OpenExrFormatOptions. */
  test("test_modify_compression", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("openexr", "base.aep"));
    assert(opts instanceof OpenExrFormatOptions);
    opts.compression = OpenExrCompression.RLE;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof OpenExrFormatOptions);
    expect(opts2.compression).toBe(OpenExrCompression.RLE);
  });

  test("test_modify_luminance_chroma", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("openexr", "base.aep"));
    assert(opts instanceof OpenExrFormatOptions);
    expect(opts.luminanceChroma).toBe(false);
    opts.luminanceChroma = true;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof OpenExrFormatOptions);
    expect(opts2.luminanceChroma).toBe(true);
  });

  test("test_modify_thirty_two_bit_float", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("openexr", "base.aep"));
    assert(opts instanceof OpenExrFormatOptions);
    expect(opts.thirtyTwoBitFloat).toBe(false);
    opts.thirtyTwoBitFloat = true;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof OpenExrFormatOptions);
    expect(opts2.thirtyTwoBitFloat).toBe(true);
  });

  test("test_modify_dwa_compression_level", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("openexr", "compression_dwaa_45.0.aep"));
    assert(opts instanceof OpenExrFormatOptions);
    expect(opts.dwaCompressionLevel).toBe(45.0);
    opts.dwaCompressionLevel = 100.0;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof OpenExrFormatOptions);
    expect(opts2.dwaCompressionLevel).toBe(100.0);
  });
});

/**
 * The H.264 `Profile` dropdown.
 *
 * AE encodes `Baseline` by REMOVING the parameter's `<ParamValue>` while
 * KEEPING its `<ExporterParam>` element (the `ObjectID` is referenced by
 * the PremiereData object graph). Both encodings decode identically, so
 * only the element-level assertions below catch a writer that deletes the
 * whole element.
 */
class TestMPEGProfile {
  static H264 = FORMAT_DIR.div("h.264");
  static KEY = "ADBEVideoMPEGProfile";

  static _elements(opts: XmlFormatOptions, key: string): ETElement[] {
    const root = opts._xmlRoot;
    assert(root != null);
    const out: ETElement[] = [];
    for (const elem of root.iter("ExporterParam")) {
      const ident = elem.find("ParamIdentifier");
      if (ident != null && ident.text === key) out.push(elem);
    }
    return out;
  }

  /**
   * The param element's child tags - the ObjectID-independent shape.
   *
   * `ObjectID` is per-file, so comparing serialized elements across
   * samples is meaningless; the child sequence is the invariant.
   */
  static _child_tags(opts: XmlFormatOptions, key: string): string[] {
    const elements = this._elements(opts, key);
    assert(len(elements) === 1);
    // `for child in element` iterates the element's children (the local ETElement keeps them in `.children`).
    const element = elements[0];
    return (element.children ?? [...element]).map((child) => child.tag);
  }
}

describe("TestMPEGProfile", () => {
  /** The H.264 `Profile` dropdown. */
  test.each([
    ["h264_baseline.aep", MPEGProfile.BASELINE],
    ["h264_high.aep", MPEGProfile.HIGH],
    ["base.aep", MPEGProfile.MAIN],
  ])("test_reads[%#]", (sample: string, expected: MPEGProfile) => {
    const [, opts] = _parseFresh(TestMPEGProfile.H264.div(sample));
    assert(opts instanceof XmlFormatOptions);
    expect(opts.profile).toBe(expected);
  });

  test("test_absent_param_reads_as_baseline", () => {
    const [, opts] = _parseFresh(TestMPEGProfile.H264.div("h264_baseline.aep"));
    assert(opts instanceof XmlFormatOptions);
    expect(contains(opts.params, TestMPEGProfile.KEY)).toBe(false);
    expect(opts.profile).toBe(MPEGProfile.BASELINE);
  });

  test("test_write_baseline_matches_ae", () => {
    // The bar is parity with AE's OWN output for the same input: the
    // element must survive VALUELESS, exactly as AE's Baseline module
    // has it - not be deleted (which decodes identically).
    //
    // h264_high/h264_baseline are the controlled pair (one AE batch,
    // differing only in the Profile dropdown). `base.aep` is NOT: it was
    // authored separately and carries an extra ParamIsDisabled child.
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(TestMPEGProfile.H264.div("h264_high.aep"));
    assert(opts instanceof XmlFormatOptions);
    expect(opts.profile).toBe(MPEGProfile.HIGH);
    opts.profile = MPEGProfile.BASELINE;
    project.save(tmpPath.div("out.aep"));

    const [, written] = _parseFresh(tmpPath.div("out.aep"));
    const [, ae] = _parseFresh(TestMPEGProfile.H264.div("h264_baseline.aep"));
    assert(written instanceof XmlFormatOptions);
    assert(ae instanceof XmlFormatOptions);
    expect(written.profile).toBe(MPEGProfile.BASELINE);
    expect(
      valueEquals(
        TestMPEGProfile._child_tags(written, TestMPEGProfile.KEY),
        TestMPEGProfile._child_tags(ae, TestMPEGProfile.KEY),
      ),
    ).toBe(true);
    expect(TestMPEGProfile._child_tags(ae, TestMPEGProfile.KEY).includes("ParamValue")).toBe(false);
  });

  test("test_write_baseline_keeps_the_element_and_its_object_id", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(TestMPEGProfile.H264.div("base.aep"));
    assert(opts instanceof XmlFormatOptions);
    const before = getOrThrow(TestMPEGProfile._elements(opts, TestMPEGProfile.KEY)[0].attrib, "ObjectID");
    opts.profile = MPEGProfile.BASELINE;
    project.save(tmpPath.div("out.aep"));
    const [, written] = _parseFresh(tmpPath.div("out.aep"));
    assert(written instanceof XmlFormatOptions);
    const elements = TestMPEGProfile._elements(written, TestMPEGProfile.KEY);
    expect(len(elements)).toBe(1); // not deleted, not duplicated
    expect(elements[0].find("ParamValue") == null).toBe(true);
    // The PremiereData object graph references this id.
    expect(getOrThrow(elements[0].attrib, "ObjectID")).toBe(before);
  });

  test("test_baseline_then_set_restores_value_in_place", () => {
    // Re-setting must restore ParamValue INSIDE the existing element (as
    // its first child, where AE puts it), not append a second element.
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(TestMPEGProfile.H264.div("h264_baseline.aep"));
    assert(opts instanceof XmlFormatOptions);
    opts.profile = MPEGProfile.MAIN;
    project.save(tmpPath.div("out.aep"));
    const [, written] = _parseFresh(tmpPath.div("out.aep"));
    const [, aeValued] = _parseFresh(TestMPEGProfile.H264.div("h264_high.aep"));
    assert(written instanceof XmlFormatOptions);
    assert(aeValued instanceof XmlFormatOptions);
    expect(written.profile).toBe(MPEGProfile.MAIN);
    expect(
      valueEquals(
        TestMPEGProfile._child_tags(written, TestMPEGProfile.KEY),
        TestMPEGProfile._child_tags(aeValued, TestMPEGProfile.KEY),
      ),
    ).toBe(true);
    expect(TestMPEGProfile._child_tags(written, TestMPEGProfile.KEY)[0]).toBe("ParamValue");
  });

  test.each([MPEGProfile.MAIN, MPEGProfile.HIGH, MPEGProfile.HIGH10])("test_roundtrip[%#]", (profile: MPEGProfile) => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(TestMPEGProfile.H264.div("h264_baseline.aep"));
    assert(opts instanceof XmlFormatOptions);
    opts.profile = profile;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof XmlFormatOptions);
    expect(opts2.profile).toBe(profile);
  });

  test("test_rejects_out_of_enum", () => {
    const [, opts] = _parseFresh(TestMPEGProfile.H264.div("base.aep"));
    assert(opts instanceof XmlFormatOptions);
    raises(ValueError, () => {
      opts.profile = 2; // unobserved; deliberately not an enum member
    });
  });
});

describe("TestOpenExrHtj2k", () => {
  /** AE 2026 added two HTJ2K compression modes beyond the 0-9 block. */
  test.each([
    ["exr_htj2k-256.aep", OpenExrCompression.HTJ2K_256],
    ["exr_htj2k-32.aep", OpenExrCompression.HTJ2K_32],
  ])("test_reads[%#]", (sample: string, expected: OpenExrCompression) => {
    const [, opts] = _parseFresh(FORMAT_DIR.div("openexr", sample));
    assert(opts instanceof OpenExrFormatOptions);
    expect(opts.compression).toBe(expected);
  });

  test("test_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("openexr", "exr_htj2k-256.aep"));
    assert(opts instanceof OpenExrFormatOptions);
    opts.compression = OpenExrCompression.HTJ2K_32;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof OpenExrFormatOptions);
    expect(opts2.compression).toBe(OpenExrCompression.HTJ2K_32);
  });
});

describe("TestDnxResolution", () => {
  /**
   * The DNxHR/DNxHD `Resolution` preset ids (a contiguous 1001-1019 block).
   *
   * Only a few presets are committed as fixtures; the rest of the mapping is
   * recorded in [DnxResolution][] from the AE 2026 sample sweep.
   */
  test.each([
    ["720p DNxHD HQX 10-bit.aep", DnxResolution.DNXHD_720P_HQX_10_BIT],
    ["1080p DNxHD LB 8-bit.aep", DnxResolution.DNXHD_1080P_LB_8_BIT],
    ["DNxHR HQ 8-bit.aep", DnxResolution.DNXHR_HQ_8_BIT],
  ])("test_reads[%#]", (sample: string, expected: DnxResolution) => {
    const [, opts] = _parseFresh(FORMAT_DIR.div("dnx", sample));
    assert(opts instanceof XmlFormatOptions);
    expect(opts.videoCodec).toBe(VideoCodec.DNXHR_DNXHD);
    expect(opts.resolution).toBe(expected);
  });

  test("test_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("dnx", "DNxHR HQ 8-bit.aep"));
    assert(opts instanceof XmlFormatOptions);
    opts.resolution = DnxResolution.DNXHR_LB_8_BIT;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof XmlFormatOptions);
    expect(opts2.resolution).toBe(DnxResolution.DNXHR_LB_8_BIT);
  });

  test("test_rejects_out_of_enum", () => {
    const [, opts] = _parseFresh(FORMAT_DIR.div("dnx", "DNxHR HQ 8-bit.aep"));
    assert(opts instanceof XmlFormatOptions);
    raises(ValueError, () => {
      opts.resolution = 9999;
    });
  });
});

/**
 * `ChunkField.bool` bakes in `validate_bool`, so a non-bool cannot
 * reach the 1-byte chunk field (`= 2` would write a byte AE never
 * writes; `= "no"` would only fail later, inside `save()`).
 */
class TestFormatOptionsBoolValidation {
  static BOOL_FIELDS: [string, string][] = [
    ["openexr/base.aep", "luminanceChroma"],
    ["openexr/base.aep", "thirtyTwoBitFloat"],
    ["targa/base.aep", "rleCompression"],
    ["tiff/base.aep", "lzwCompression"],
    ["tiff/base.aep", "ibmPcByteOrder"],
    ["cineon/base.aep", "logarithmicConversion"],
  ];
}

describe("TestFormatOptionsBoolValidation", () => {
  const BAD_VALUES: unknown[] = ["no", 2, 1, 0, null, []];
  const REJECT_ROWS = TestFormatOptionsBoolValidation.BOOL_FIELDS.flatMap(([sample, field]) =>
    BAD_VALUES.map((bad): [string, string, unknown] => [sample, field, bad]),
  );

  test.each(REJECT_ROWS)("test_rejects_non_bool[%#]", (sample: string, field: string, bad: unknown) => {
    const [, opts] = _parseFresh(FORMAT_DIR.div(sample));
    assert(opts != null);
    raises(TypeError, () => {
      setMember(opts, field, bad);
    });
  });

  test.each(TestFormatOptionsBoolValidation.BOOL_FIELDS)("test_accepts_bool[%#]", (sample: string, field: string) => {
    const [, opts] = _parseFresh(FORMAT_DIR.div(sample));
    assert(opts != null);
    setMember(opts, field, true);
    expect(getMember(opts, field)).toBe(true);
  });
});

describe("TestRoundtripPngFormatOptions", () => {
  /** Roundtrip tests for PngFormatOptions binary fields. */
  test("test_modify_bit_depth", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("png", "base.aep"));
    assert(opts instanceof PngFormatOptions);
    expect(opts.bitDepth).toBe(16);
    opts.bitDepth = 8;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof PngFormatOptions);
    expect(opts2.bitDepth).toBe(8);
  });

  test("test_modify_compression", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("png", "compression_none.aep"));
    assert(opts instanceof PngFormatOptions);
    expect(opts.compression).toBe(PngCompression.NONE);
    opts.compression = PngCompression.INTERLACED;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof PngFormatOptions);
    expect(opts2.compression).toBe(PngCompression.INTERLACED);
  });

  test("test_width_read_only", () => {
    const [, opts] = _parseFresh(FORMAT_DIR.div("png", "base.aep"));
    assert(opts instanceof PngFormatOptions);
    raises(AttributeError, () => {
      opts.width = 3840;
    });
  });

  test("test_height_read_only", () => {
    const [, opts] = _parseFresh(FORMAT_DIR.div("png", "base.aep"));
    assert(opts instanceof PngFormatOptions);
    raises(AttributeError, () => {
      opts.height = 2160;
    });
  });

  test("test_bit_depth_rejects_invalid", () => {
    const [, opts] = _parseFresh(FORMAT_DIR.div("png", "base.aep"));
    assert(opts instanceof PngFormatOptions);
    raises(
      ValueError,
      () => {
        opts.bitDepth = 24;
      },
      "must be one of",
    );
  });

  test("test_bit_depth_accepts_valid", () => {
    // The only values AE writes (8 / 16 bits per channel; no 32-bit PNG).
    const tmpPath = makeTmpPath();
    const [, opts] = _parseFresh(FORMAT_DIR.div("png", "base.aep"));
    assert(opts instanceof PngFormatOptions);
    for (const depth of [8, 16]) {
      opts.bitDepth = depth;
      expect(opts.bitDepth).toBe(depth);
    }
    raises(
      ValueError,
      () => {
        opts.bitDepth = 32;
      },
      "must be one of",
    );
  });
});

describe("TestRoundtripPngHdr10", () => {
  /** Roundtrip tests for PngFormatOptions HDR10 metadata fields. */
  test("test_modify_include_hdr10_metadata", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("png", "include_hdr10_metadata_on.aep"));
    assert(opts instanceof PngFormatOptions);
    expect(opts.includeHdr10Metadata).toBe(true);
    opts.includeHdr10Metadata = false;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof PngFormatOptions);
    expect(opts2.includeHdr10Metadata).toBe(false);
  });

  test("test_modify_color_primaries", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("png", "include_hdr10_metadata_on.aep"));
    assert(opts instanceof PngFormatOptions);
    opts.colorPrimaries = Hdr10ColorPrimaries.REC709;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof PngFormatOptions);
    expect(opts2.colorPrimaries).toBe(Hdr10ColorPrimaries.REC709);
  });

  test("test_modify_luminance_min", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("png", "include_hdr10_metadata_on.aep"));
    assert(opts instanceof PngFormatOptions);
    opts.luminanceMin = 0.1;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof PngFormatOptions);
    expect(opts2.luminanceMin).toBe(0.1);
  });

  test("test_modify_luminance_max", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("png", "include_hdr10_metadata_on.aep"));
    assert(opts instanceof PngFormatOptions);
    opts.luminanceMax = 1000.0;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof PngFormatOptions);
    expect(opts2.luminanceMax).toBe(1000.0);
  });

  test("test_modify_content_light_max", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("png", "include_hdr10_metadata_on.aep"));
    assert(opts instanceof PngFormatOptions);
    opts.contentLightMax = 500.0;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof PngFormatOptions);
    expect(opts2.contentLightMax).toBe(500.0);
  });

  test("test_modify_content_light_average", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("png", "include_hdr10_metadata_on.aep"));
    assert(opts instanceof PngFormatOptions);
    opts.contentLightAverage = 250.0;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof PngFormatOptions);
    expect(opts2.contentLightAverage).toBe(250.0);
  });

  test("test_clear_luminance_min", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("png", "luminance_min_0.aep"));
    assert(opts instanceof PngFormatOptions);
    expect(opts.luminanceMin != null).toBe(true);
    opts.luminanceMin = null;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof PngFormatOptions);
    expect(opts2.luminanceMin == null).toBe(true);
  });
});

describe("TestRoundtripXmlFormatOptions", () => {
  /** Roundtrip tests for XmlFormatOptions. */
  test("test_modify_video_codec", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(AVI_DIR.div("base.aep"));
    assert(opts instanceof XmlFormatOptions);
    expect(opts.videoCodec).toBe(VideoCodec.NONE);
    opts.videoCodec = VideoCodec.DV_NTSC;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof XmlFormatOptions);
    expect(opts2.videoCodec).toBe(VideoCodec.DV_NTSC);
  });

  test("test_modify_audio_codec", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("h.264", "base.aep"));
    assert(opts instanceof XmlFormatOptions);
    expect(opts.audioCodec).toBe(AudioCodec.AAC);
    opts.audioCodec = AudioCodec.AAC_PLUS_V1;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof XmlFormatOptions);
    expect(opts2.audioCodec).toBe(AudioCodec.AAC_PLUS_V1);
  });

  test("test_modify_frame_rate", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("h.264", "base.aep"));
    assert(opts instanceof XmlFormatOptions);
    expect(opts.frameRate).toBe(24.0);
    opts.frameRate = 30.0;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof XmlFormatOptions);
    expect(opts2.frameRate).toBe(30.0);
  });

  test("test_modify_mpeg_multiplexer", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("h.264", "base.aep"));
    assert(opts instanceof XmlFormatOptions);
    expect(opts.mpegMultiplexer).toBe(MPEGMultiplexer.MP4);
    opts.mpegMultiplexer = MPEGMultiplexer.THREEGPP;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof XmlFormatOptions);
    expect(opts2.mpegMultiplexer).toBe(MPEGMultiplexer.THREEGPP);
  });

  test("test_modify_mpeg_audio_format", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("h.264", "base.aep"));
    assert(opts instanceof XmlFormatOptions);
    expect(opts.mpegAudioFormat).toBe(MPEGAudioFormat.AAC);
    // PCM is only offered without a container: switch the
    // multiplexer to None first (as AE's dialog requires).
    opts.mpegMultiplexer = MPEGMultiplexer.NONE;
    opts.mpegAudioFormat = MPEGAudioFormat.PCM;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof XmlFormatOptions);
    expect(opts2.mpegAudioFormat).toBe(MPEGAudioFormat.PCM);
  });

  test("test_modify_mpeg_mux_stream_compatibility", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("h.264", "base.aep"));
    assert(opts instanceof XmlFormatOptions);
    expect(opts.mpegMuxStreamCompatibility).toBe(MPEGMuxStreamCompatibility.STD);
    opts.mpegMuxStreamCompatibility = MPEGMuxStreamCompatibility.IPOD;
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof XmlFormatOptions);
    expect(opts2.mpegMuxStreamCompatibility).toBe(MPEGMuxStreamCompatibility.IPOD);
  });

  test("test_format_code_read_only", () => {
    const [, opts] = _parseFresh(AVI_DIR.div("base.aep"));
    assert(opts instanceof XmlFormatOptions);
    raises(AttributeError, () => {
      opts.formatCode = "H264";
    });
  });

  test("test_set_none_is_noop", () => {
    const [, opts] = _parseFresh(AVI_DIR.div("base.aep"));
    assert(opts instanceof XmlFormatOptions);
    const original = opts.videoCodec;
    opts.videoCodec = null;
    expect<XmlFormatOptions["videoCodec"]>(opts.videoCodec).toBe(original);
  });

  test("test_settings_view_format_code_read_only", () => {
    const [, opts] = _parseFresh(FORMAT_DIR.div("h.264", "base.aep"));
    assert(opts instanceof XmlFormatOptions);
    // `XmlFormatOptions` has no `settings` attribute, so the Python attribute load raises
    // AttributeError before the item assignment; TS property loads yield undefined, so use getattr.
    raises(AttributeError, () => {
      getMember(opts, "settings").set("Format Code", "MooV");
    });
  });
});

describe("TestRoundtripXmlParamsDict", () => {
  /**
   * `params` mutations must reach the XML, not just the dict.
   *
   * `dict.update`/`setdefault` are C-level and skip `__setitem__`, so
   * they used to update the dict (and the typed accessors reading it)
   * while the saved file kept the old value.
   */
  // `update(BitRate="192")` kwargs are passed as a plain object; ParamsDict.update accepts a Map or a record.
  test("test_update_persists", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("mp3", "mp3_mono_320.aep"));
    assert(opts instanceof XmlFormatOptions);
    expect(opts.bitrate).toBe(320);
    opts.params.update(new Map([["BitRate", "128"]]));
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof XmlFormatOptions);
    expect<string>(getOrThrow(opts2.params, "BitRate")).toBe("128");
    expect(opts2.bitrate).toBe(128);
  });

  test("test_update_kwargs_persists", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("mp3", "mp3_mono_320.aep"));
    assert(opts instanceof XmlFormatOptions);
    opts.params.update({ BitRate: "192" });
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof XmlFormatOptions);
    expect(opts2.bitrate).toBe(192);
  });

  test("test_setdefault_persists_new_key", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _parseFresh(FORMAT_DIR.div("mp3", "mp3_mono_320.aep"));
    assert(opts instanceof XmlFormatOptions);
    expect(opts.params.setdefault("ADBEUnusedParam", "7")).toBe("7");
    project.save(tmpPath.div("out.aep"));
    const [, opts2] = _parseFresh(tmpPath.div("out.aep"));
    assert(opts2 instanceof XmlFormatOptions);
    expect<string>(getOrThrow(opts2.params, "ADBEUnusedParam")).toBe("7");
  });

  test("test_setdefault_keeps_existing", () => {
    const [, opts] = _parseFresh(FORMAT_DIR.div("mp3", "mp3_mono_320.aep"));
    assert(opts instanceof XmlFormatOptions);
    expect(opts.params.setdefault("BitRate", "1")).toBe("320");
    expect(opts.bitrate).toBe(320);
  });
});

/** The PNG options' alpha flag, channel count and bits per channel. */
function _pngOptionFields(om: OutputModule): [boolean, number, number] {
  const body = asInstance(om.formatOptions, PngFormatOptions)._body;
  return [body.hasAlpha, body.channelCount, body.bitDepth];
}

// The PNG options' alpha flag, channel count and bits per channel AE stores
// for each Channels / Depth pair (format_options/png samples, AE 2026).
const _PNG_LOCKSTEP: [OutputChannels, OutputColorDepth, [boolean, number, number]][] = [
  [OutputChannels.RGB, OutputColorDepth.MILLIONS_OF_COLORS, [false, 3, 8]],
  [OutputChannels.RGB, OutputColorDepth.TRILLIONS_OF_COLORS, [false, 3, 16]],
  [OutputChannels.RGBA, OutputColorDepth.MILLIONS_OF_COLORS_PLUS, [true, 4, 8]],
  [OutputChannels.RGBA, OutputColorDepth.TRILLIONS_OF_COLORS_PLUS, [true, 4, 16]],
];

describe("TestPngOptionsFollowTheModule", () => {
  const PNG_ROWS = ["base.aep", "compression_none.aep"].flatMap((sample) =>
    _PNG_LOCKSTEP.map(([channels, depth, expected]): [string, OutputChannels, OutputColorDepth, [boolean, number, number]] => [sample, channels, depth, expected]),
  );

  test.each(PNG_ROWS)(
    "test_channels_and_depth_update_the_png_options[%#]",
    (
      sample: string,
      channels: OutputChannels,
      depth: OutputColorDepth,
      expected: [boolean, number, number],
    ) => {
      const tmpPath = makeTmpPath();
      // AE renders from the module's Channels / Depth either way (a stale
      // PNG option renders the module's choice), but stores them in step.
      const app = parse(FORMAT_DIR.div("png", sample));
      const om = asInstance(app.project.renderQueue, RenderQueue).items[0].outputModules[0];
      om.batchEdit(() => {
        om.settings.set("Channels", channels);
        om.settings.set("Depth", depth);
      });
      expect(valueEquals(_pngOptionFields(om), expected)).toBe(true);
      const out = tmpPath.div("png.aep");
      app.project.save(out);
      const reread = asInstance(parse(out).project.renderQueue, RenderQueue).items[0].outputModules[0];
      expect(valueEquals(_pngOptionFields(reread), expected)).toBe(true);
    },
  );

  test("test_single_writes_update_the_png_options", () => {
    const app = parse(FORMAT_DIR.div("png", "base.aep")); // RGB + Alpha, Trillions+
    const om = asInstance(app.project.renderQueue, RenderQueue).items[0].outputModules[0];
    om.settings.set("Channels", OutputChannels.RGB); // pairs Depth to Trillions
    expect(valueEquals(_pngOptionFields(om), [false, 3, 16])).toBe(true);
    om.settings.set("Depth", OutputColorDepth.MILLIONS_OF_COLORS);
    expect(valueEquals(_pngOptionFields(om), [false, 3, 8])).toBe(true);
  });

  test("test_after_effects_samples_are_in_step", () => {
    const lockstep = new Map<string, [boolean, number, number]>(
      _PNG_LOCKSTEP.map(([c, d, fields]) => [compositeKey(int(c), int(d)), fields]),
    );
    for (const path of sorted(FORMAT_DIR.div("png").glob("*.aep"), (p: Path) => p.toString())) {
      const om = asInstance(parse(path).project.renderQueue, RenderQueue).items[0].outputModules[0];
      const key = compositeKey(int(om.settings.get("Channels")), int(om.settings.get("Depth")));
      assert(valueEquals(_pngOptionFields(om), getOrThrow(lockstep, key)), path.name);
    }
  });
});
