/** Tests for OutputModule.format_options parsing. */

import { describe, expect, test } from "bun:test";

import {
  AttributeError,
  contains,
  float,
  getattr,
  getitem,
  int,
  len,
  Path,
  py_assert,
  py_eq,
  setattr,
  sorted,
  tkey,
  TypeError_,
  ValueError,
} from "../../src/pyrt/index.ts";
import { make_tmp_path, raises } from "../../src/pyrt/pytest.ts";
import { parse, type Project } from "../../src/py_aep/index.ts";
import "../../src/py_aep/binary/_register.ts";
import type { Element as ETElement } from "../../src/pyrt/etree.ts";
import { AudioCodec, CineonFileFormat, DnxResolution, Hdr10ColorPrimaries, JpegFormatType, MPEGAudioFormat, MPEGMultiplexer, MPEGMuxStreamCompatibility, MPEGProfile, OpenExrCompression, OutputChannels, OutputColorDepth, PngCompression, VideoCodec } from "../../src/py_aep/enums/index.ts";
import { CineonFormatOptions, JpegFormatOptions, OpenExrFormatOptions, PngFormatOptions, TargaFormatOptions, TiffFormatOptions, XmlFormatOptions } from "../../src/py_aep/models/renderqueue/format_options/index.ts";
import type { OutputModule } from "../../src/py_aep/models/renderqueue/output_module.ts";
import { RenderQueue } from "../../src/py_aep/models/renderqueue/render_queue.ts";
import { as_instance } from "../helpers.ts";

const FORMAT_DIR = new Path(import.meta.dir, "..", "..", "samples", "models", "format_options");
const CINEON_DIR = FORMAT_DIR.div("cineon");
const AVI_DIR = FORMAT_DIR.div("avi");

/** Parse without caching and return (project, format_options). */
function _parse_fresh(path: Path): [Project, OutputModule["format_options"]] {
  const project = parse(path).project;
  const opts = as_instance(project.render_queue, RenderQueue).items[0].output_modules[0].format_options;
  return [project, opts];
}

describe("TestRoundtripTargaFormatOptions", () => {
  /** Roundtrip tests for TargaFormatOptions. */
  test("test_modify_bits_per_pixel", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("targa", "base.aep"));
    py_assert(opts instanceof TargaFormatOptions);
    expect(opts.bits_per_pixel).toBe(32);
    opts.bits_per_pixel = 24;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof TargaFormatOptions);
    expect(opts2.bits_per_pixel).toBe(24);
  });

  test("test_modify_rle_compression", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("targa", "base.aep"));
    py_assert(opts instanceof TargaFormatOptions);
    expect(opts.rle_compression).toBe(false);
    opts.rle_compression = true;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof TargaFormatOptions);
    expect(opts2.rle_compression).toBe(true);
  });

  test("test_validate_bits_per_pixel", () => {
    const [, opts] = _parse_fresh(FORMAT_DIR.div("targa", "base.aep"));
    py_assert(opts instanceof TargaFormatOptions);
    raises(ValueError, () => {
      opts.bits_per_pixel = 16;
    });
  });
});

describe("TestRoundtripTiffFormatOptions", () => {
  /** Roundtrip tests for TiffFormatOptions. */
  test("test_modify_lzw_compression", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("tiff", "base.aep"));
    py_assert(opts instanceof TiffFormatOptions);
    expect(opts.lzw_compression).toBe(false);
    opts.lzw_compression = true;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof TiffFormatOptions);
    expect(opts2.lzw_compression).toBe(true);
  });

  test("test_modify_ibm_pc_byte_order", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("tiff", "base.aep"));
    py_assert(opts instanceof TiffFormatOptions);
    expect(opts.ibm_pc_byte_order).toBe(false);
    opts.ibm_pc_byte_order = true;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof TiffFormatOptions);
    expect(opts2.ibm_pc_byte_order).toBe(true);
  });
});

describe("TestRoundtripJpegFormatOptions", () => {
  /** Roundtrip tests for JpegFormatOptions. */
  test("test_modify_quality", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("jpeg", "base.aep"));
    py_assert(opts instanceof JpegFormatOptions);
    opts.quality = 10;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof JpegFormatOptions);
    expect(opts2.quality).toBe(10);
  });

  test("test_modify_format_type", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("jpeg", "base.aep"));
    py_assert(opts instanceof JpegFormatOptions);
    opts.format_type = JpegFormatType.PROGRESSIVE;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof JpegFormatOptions);
    expect(opts2.format_type).toBe(JpegFormatType.PROGRESSIVE);
  });

  test("test_modify_scans", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("jpeg", "progressive_3.aep"));
    py_assert(opts instanceof JpegFormatOptions);
    expect(opts.scans).toBe(3);
    opts.scans = 5;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof JpegFormatOptions);
    expect(opts2.scans).toBe(5);
  });

  test("test_validate_quality_too_high", () => {
    const [, opts] = _parse_fresh(FORMAT_DIR.div("jpeg", "base.aep"));
    py_assert(opts instanceof JpegFormatOptions);
    raises(ValueError, () => {
      opts.quality = 11;
    });
  });

  test("test_validate_scans_invalid", () => {
    const [, opts] = _parse_fresh(FORMAT_DIR.div("jpeg", "progressive_3.aep"));
    py_assert(opts instanceof JpegFormatOptions);
    raises(ValueError, () => {
      opts.scans = 2;
    });
  });
});

describe("TestRoundtripCineonFormatOptions", () => {
  /** Roundtrip tests for CineonFormatOptions. */
  test("test_modify_ten_bit_black_point", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("cineon", "base.aep"));
    py_assert(opts instanceof CineonFormatOptions);
    opts.ten_bit_black_point = 100;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof CineonFormatOptions);
    expect(opts2.ten_bit_black_point).toBe(100);
  });

  test("test_modify_logarithmic_conversion", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("cineon", "base.aep"));
    py_assert(opts instanceof CineonFormatOptions);
    expect(opts.logarithmic_conversion).toBe(false);
    opts.logarithmic_conversion = true;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof CineonFormatOptions);
    expect(opts2.logarithmic_conversion).toBe(true);
  });

  test("test_modify_file_format", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("cineon", "base.aep"));
    py_assert(opts instanceof CineonFormatOptions);
    opts.file_format = CineonFileFormat.FIDO_CINEON;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof CineonFormatOptions);
    expect(opts2.file_format).toBe(CineonFileFormat.FIDO_CINEON);
  });

  test("test_modify_bit_depth", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("cineon", "base.aep"));
    py_assert(opts instanceof CineonFormatOptions);
    opts.bit_depth = 8;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof CineonFormatOptions);
    expect(opts2.bit_depth).toBe(8);
  });

  test("test_validate_bit_depth_rejects_invalid", () => {
    const [, opts] = _parse_fresh(FORMAT_DIR.div("cineon", "base.aep"));
    py_assert(opts instanceof CineonFormatOptions);
    raises(ValueError, () => {
      opts.bit_depth = 9;
    });
  });

  test("test_validate_ten_bit_black_point_rejects_negative", () => {
    const [, opts] = _parse_fresh(FORMAT_DIR.div("cineon", "base.aep"));
    py_assert(opts instanceof CineonFormatOptions);
    raises(ValueError, () => {
      opts.ten_bit_black_point = -1;
    });
  });

  test("test_validate_ten_bit_black_point_rejects_too_high", () => {
    const [, opts] = _parse_fresh(FORMAT_DIR.div("cineon", "base.aep"));
    py_assert(opts instanceof CineonFormatOptions);
    raises(ValueError, () => {
      opts.ten_bit_black_point = 1024;
    });
  });

  // Backed by a u2 field: an unbounded value overflowed `struct` and
  // crashed save() mid-write, leaving a partial .aep.
  test.each([-100, 0x10000, 10 ** 12])("test_validate_highlight_expansion_rejects_out_of_u2[%#]", (value) => {
    const [, opts] = _parse_fresh(FORMAT_DIR.div("cineon", "base.aep"));
    py_assert(opts instanceof CineonFormatOptions);
    raises(ValueError, () => {
      opts.highlight_expansion = value;
    });
  });

  const FLOAT_NONFINITE_ROWS: [string, number][] = [
    "converted_black_point",
    "converted_white_point",
    "current_gamma",
  ].flatMap((field) => [float("nan"), float("inf")].map((bad): [string, number] => [field, bad]));

  test.each(FLOAT_NONFINITE_ROWS)("test_validate_float_fields_reject_nonfinite[%#]", (field, bad) => {
    const [, opts] = _parse_fresh(FORMAT_DIR.div("cineon", "base.aep"));
    py_assert(opts instanceof CineonFormatOptions);
    raises(
      ValueError,
      () => {
        setattr(opts, field, bad);
      },
      "finite",
    );
  });

  test("test_highlight_expansion_valid_roundtrips", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("cineon", "base.aep"));
    py_assert(opts instanceof CineonFormatOptions);
    opts.highlight_expansion = 42;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof CineonFormatOptions);
    expect(opts2.highlight_expansion).toBe(42);
  });
});

describe("TestRoundtripOpenExrFormatOptions", () => {
  /** Roundtrip tests for OpenExrFormatOptions. */
  test("test_modify_compression", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("openexr", "base.aep"));
    py_assert(opts instanceof OpenExrFormatOptions);
    opts.compression = OpenExrCompression.RLE;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof OpenExrFormatOptions);
    expect(opts2.compression).toBe(OpenExrCompression.RLE);
  });

  test("test_modify_luminance_chroma", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("openexr", "base.aep"));
    py_assert(opts instanceof OpenExrFormatOptions);
    expect(opts.luminance_chroma).toBe(false);
    opts.luminance_chroma = true;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof OpenExrFormatOptions);
    expect(opts2.luminance_chroma).toBe(true);
  });

  test("test_modify_thirty_two_bit_float", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("openexr", "base.aep"));
    py_assert(opts instanceof OpenExrFormatOptions);
    expect(opts.thirty_two_bit_float).toBe(false);
    opts.thirty_two_bit_float = true;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof OpenExrFormatOptions);
    expect(opts2.thirty_two_bit_float).toBe(true);
  });

  test("test_modify_dwa_compression_level", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("openexr", "compression_dwaa_45.0.aep"));
    py_assert(opts instanceof OpenExrFormatOptions);
    expect(opts.dwa_compression_level).toBe(45.0);
    opts.dwa_compression_level = 100.0;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof OpenExrFormatOptions);
    expect(opts2.dwa_compression_level).toBe(100.0);
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
    const root = opts._xml_root;
    py_assert(root != null);
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
    py_assert(len(elements) === 1);
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
    const [, opts] = _parse_fresh(TestMPEGProfile.H264.div(sample));
    py_assert(opts instanceof XmlFormatOptions);
    expect(opts.profile).toBe(expected);
  });

  test("test_absent_param_reads_as_baseline", () => {
    const [, opts] = _parse_fresh(TestMPEGProfile.H264.div("h264_baseline.aep"));
    py_assert(opts instanceof XmlFormatOptions);
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
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(TestMPEGProfile.H264.div("h264_high.aep"));
    py_assert(opts instanceof XmlFormatOptions);
    expect(opts.profile).toBe(MPEGProfile.HIGH);
    opts.profile = MPEGProfile.BASELINE;
    project.save(tmp_path.div("out.aep"));

    const [, written] = _parse_fresh(tmp_path.div("out.aep"));
    const [, ae] = _parse_fresh(TestMPEGProfile.H264.div("h264_baseline.aep"));
    py_assert(written instanceof XmlFormatOptions);
    py_assert(ae instanceof XmlFormatOptions);
    expect(written.profile).toBe(MPEGProfile.BASELINE);
    expect(
      py_eq(
        TestMPEGProfile._child_tags(written, TestMPEGProfile.KEY),
        TestMPEGProfile._child_tags(ae, TestMPEGProfile.KEY),
      ),
    ).toBe(true);
    expect(TestMPEGProfile._child_tags(ae, TestMPEGProfile.KEY).includes("ParamValue")).toBe(false);
  });

  test("test_write_baseline_keeps_the_element_and_its_object_id", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(TestMPEGProfile.H264.div("base.aep"));
    py_assert(opts instanceof XmlFormatOptions);
    const before = getitem(TestMPEGProfile._elements(opts, TestMPEGProfile.KEY)[0].attrib, "ObjectID");
    opts.profile = MPEGProfile.BASELINE;
    project.save(tmp_path.div("out.aep"));
    const [, written] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(written instanceof XmlFormatOptions);
    const elements = TestMPEGProfile._elements(written, TestMPEGProfile.KEY);
    expect(len(elements)).toBe(1); // not deleted, not duplicated
    expect(elements[0].find("ParamValue") == null).toBe(true);
    // The PremiereData object graph references this id.
    expect(getitem(elements[0].attrib, "ObjectID")).toBe(before);
  });

  test("test_baseline_then_set_restores_value_in_place", () => {
    // Re-setting must restore ParamValue INSIDE the existing element (as
    // its first child, where AE puts it), not append a second element.
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(TestMPEGProfile.H264.div("h264_baseline.aep"));
    py_assert(opts instanceof XmlFormatOptions);
    opts.profile = MPEGProfile.MAIN;
    project.save(tmp_path.div("out.aep"));
    const [, written] = _parse_fresh(tmp_path.div("out.aep"));
    const [, ae_valued] = _parse_fresh(TestMPEGProfile.H264.div("h264_high.aep"));
    py_assert(written instanceof XmlFormatOptions);
    py_assert(ae_valued instanceof XmlFormatOptions);
    expect(written.profile).toBe(MPEGProfile.MAIN);
    expect(
      py_eq(
        TestMPEGProfile._child_tags(written, TestMPEGProfile.KEY),
        TestMPEGProfile._child_tags(ae_valued, TestMPEGProfile.KEY),
      ),
    ).toBe(true);
    expect(TestMPEGProfile._child_tags(written, TestMPEGProfile.KEY)[0]).toBe("ParamValue");
  });

  test.each([MPEGProfile.MAIN, MPEGProfile.HIGH, MPEGProfile.HIGH10])("test_roundtrip[%#]", (profile: MPEGProfile) => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(TestMPEGProfile.H264.div("h264_baseline.aep"));
    py_assert(opts instanceof XmlFormatOptions);
    opts.profile = profile;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof XmlFormatOptions);
    expect(opts2.profile).toBe(profile);
  });

  test("test_rejects_out_of_enum", () => {
    const [, opts] = _parse_fresh(TestMPEGProfile.H264.div("base.aep"));
    py_assert(opts instanceof XmlFormatOptions);
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
    const [, opts] = _parse_fresh(FORMAT_DIR.div("openexr", sample));
    py_assert(opts instanceof OpenExrFormatOptions);
    expect(opts.compression).toBe(expected);
  });

  test("test_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("openexr", "exr_htj2k-256.aep"));
    py_assert(opts instanceof OpenExrFormatOptions);
    opts.compression = OpenExrCompression.HTJ2K_32;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof OpenExrFormatOptions);
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
    const [, opts] = _parse_fresh(FORMAT_DIR.div("dnx", sample));
    py_assert(opts instanceof XmlFormatOptions);
    expect(opts.video_codec).toBe(VideoCodec.DNXHR_DNXHD);
    expect(opts.resolution).toBe(expected);
  });

  test("test_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("dnx", "DNxHR HQ 8-bit.aep"));
    py_assert(opts instanceof XmlFormatOptions);
    opts.resolution = DnxResolution.DNXHR_LB_8_BIT;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof XmlFormatOptions);
    expect(opts2.resolution).toBe(DnxResolution.DNXHR_LB_8_BIT);
  });

  test("test_rejects_out_of_enum", () => {
    const [, opts] = _parse_fresh(FORMAT_DIR.div("dnx", "DNxHR HQ 8-bit.aep"));
    py_assert(opts instanceof XmlFormatOptions);
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
    ["openexr/base.aep", "luminance_chroma"],
    ["openexr/base.aep", "thirty_two_bit_float"],
    ["targa/base.aep", "rle_compression"],
    ["tiff/base.aep", "lzw_compression"],
    ["tiff/base.aep", "ibm_pc_byte_order"],
    ["cineon/base.aep", "logarithmic_conversion"],
  ];
}

describe("TestFormatOptionsBoolValidation", () => {
  const BAD_VALUES: unknown[] = ["no", 2, 1, 0, null, []];
  const REJECT_ROWS = TestFormatOptionsBoolValidation.BOOL_FIELDS.flatMap(([sample, field]) =>
    BAD_VALUES.map((bad): [string, string, unknown] => [sample, field, bad]),
  );

  test.each(REJECT_ROWS)("test_rejects_non_bool[%#]", (sample: string, field: string, bad: unknown) => {
    const [, opts] = _parse_fresh(FORMAT_DIR.div(sample));
    py_assert(opts != null);
    raises(TypeError_, () => {
      setattr(opts, field, bad);
    });
  });

  test.each(TestFormatOptionsBoolValidation.BOOL_FIELDS)("test_accepts_bool[%#]", (sample: string, field: string) => {
    const [, opts] = _parse_fresh(FORMAT_DIR.div(sample));
    py_assert(opts != null);
    setattr(opts, field, true);
    expect(getattr(opts, field)).toBe(true);
  });
});

describe("TestRoundtripPngFormatOptions", () => {
  /** Roundtrip tests for PngFormatOptions binary fields. */
  test("test_modify_bit_depth", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("png", "base.aep"));
    py_assert(opts instanceof PngFormatOptions);
    expect(opts.bit_depth).toBe(16);
    opts.bit_depth = 8;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof PngFormatOptions);
    expect(opts2.bit_depth).toBe(8);
  });

  test("test_modify_compression", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("png", "compression_none.aep"));
    py_assert(opts instanceof PngFormatOptions);
    expect(opts.compression).toBe(PngCompression.NONE);
    opts.compression = PngCompression.INTERLACED;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof PngFormatOptions);
    expect(opts2.compression).toBe(PngCompression.INTERLACED);
  });

  test("test_width_read_only", () => {
    const [, opts] = _parse_fresh(FORMAT_DIR.div("png", "base.aep"));
    py_assert(opts instanceof PngFormatOptions);
    raises(AttributeError, () => {
      opts.width = 3840;
    });
  });

  test("test_height_read_only", () => {
    const [, opts] = _parse_fresh(FORMAT_DIR.div("png", "base.aep"));
    py_assert(opts instanceof PngFormatOptions);
    raises(AttributeError, () => {
      opts.height = 2160;
    });
  });

  test("test_bit_depth_rejects_invalid", () => {
    const [, opts] = _parse_fresh(FORMAT_DIR.div("png", "base.aep"));
    py_assert(opts instanceof PngFormatOptions);
    raises(
      ValueError,
      () => {
        opts.bit_depth = 24;
      },
      "must be one of",
    );
  });

  test("test_bit_depth_accepts_valid", () => {
    // The only values AE writes (8 / 16 bits per channel; no 32-bit PNG).
    const tmp_path = make_tmp_path();
    const [, opts] = _parse_fresh(FORMAT_DIR.div("png", "base.aep"));
    py_assert(opts instanceof PngFormatOptions);
    for (const depth of [8, 16]) {
      opts.bit_depth = depth;
      expect(opts.bit_depth).toBe(depth);
    }
    raises(
      ValueError,
      () => {
        opts.bit_depth = 32;
      },
      "must be one of",
    );
  });
});

describe("TestRoundtripPngHdr10", () => {
  /** Roundtrip tests for PngFormatOptions HDR10 metadata fields. */
  test("test_modify_include_hdr10_metadata", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("png", "include_hdr10_metadata_on.aep"));
    py_assert(opts instanceof PngFormatOptions);
    expect(opts.include_hdr10_metadata).toBe(true);
    opts.include_hdr10_metadata = false;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof PngFormatOptions);
    expect(opts2.include_hdr10_metadata).toBe(false);
  });

  test("test_modify_color_primaries", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("png", "include_hdr10_metadata_on.aep"));
    py_assert(opts instanceof PngFormatOptions);
    opts.color_primaries = Hdr10ColorPrimaries.REC709;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof PngFormatOptions);
    expect(opts2.color_primaries).toBe(Hdr10ColorPrimaries.REC709);
  });

  test("test_modify_luminance_min", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("png", "include_hdr10_metadata_on.aep"));
    py_assert(opts instanceof PngFormatOptions);
    opts.luminance_min = 0.1;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof PngFormatOptions);
    expect(opts2.luminance_min).toBe(0.1);
  });

  test("test_modify_luminance_max", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("png", "include_hdr10_metadata_on.aep"));
    py_assert(opts instanceof PngFormatOptions);
    opts.luminance_max = 1000.0;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof PngFormatOptions);
    expect(opts2.luminance_max).toBe(1000.0);
  });

  test("test_modify_content_light_max", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("png", "include_hdr10_metadata_on.aep"));
    py_assert(opts instanceof PngFormatOptions);
    opts.content_light_max = 500.0;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof PngFormatOptions);
    expect(opts2.content_light_max).toBe(500.0);
  });

  test("test_modify_content_light_average", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("png", "include_hdr10_metadata_on.aep"));
    py_assert(opts instanceof PngFormatOptions);
    opts.content_light_average = 250.0;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof PngFormatOptions);
    expect(opts2.content_light_average).toBe(250.0);
  });

  test("test_clear_luminance_min", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("png", "luminance_min_0.aep"));
    py_assert(opts instanceof PngFormatOptions);
    expect(opts.luminance_min != null).toBe(true);
    opts.luminance_min = null;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof PngFormatOptions);
    expect(opts2.luminance_min == null).toBe(true);
  });
});

describe("TestRoundtripXmlFormatOptions", () => {
  /** Roundtrip tests for XmlFormatOptions. */
  test("test_modify_video_codec", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(AVI_DIR.div("base.aep"));
    py_assert(opts instanceof XmlFormatOptions);
    expect(opts.video_codec).toBe(VideoCodec.NONE);
    opts.video_codec = VideoCodec.DV_NTSC;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof XmlFormatOptions);
    expect(opts2.video_codec).toBe(VideoCodec.DV_NTSC);
  });

  test("test_modify_audio_codec", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("h.264", "base.aep"));
    py_assert(opts instanceof XmlFormatOptions);
    expect(opts.audio_codec).toBe(AudioCodec.AAC);
    opts.audio_codec = AudioCodec.AAC_PLUS_V1;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof XmlFormatOptions);
    expect(opts2.audio_codec).toBe(AudioCodec.AAC_PLUS_V1);
  });

  test("test_modify_frame_rate", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("h.264", "base.aep"));
    py_assert(opts instanceof XmlFormatOptions);
    expect(opts.frame_rate).toBe(24.0);
    opts.frame_rate = 30.0;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof XmlFormatOptions);
    expect(opts2.frame_rate).toBe(30.0);
  });

  test("test_modify_mpeg_multiplexer", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("h.264", "base.aep"));
    py_assert(opts instanceof XmlFormatOptions);
    expect(opts.mpeg_multiplexer).toBe(MPEGMultiplexer.MP4);
    opts.mpeg_multiplexer = MPEGMultiplexer.THREEGPP;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof XmlFormatOptions);
    expect(opts2.mpeg_multiplexer).toBe(MPEGMultiplexer.THREEGPP);
  });

  test("test_modify_mpeg_audio_format", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("h.264", "base.aep"));
    py_assert(opts instanceof XmlFormatOptions);
    expect(opts.mpeg_audio_format).toBe(MPEGAudioFormat.AAC);
    // PCM is only offered without a container: switch the
    // multiplexer to None first (as AE's dialog requires).
    opts.mpeg_multiplexer = MPEGMultiplexer.NONE;
    opts.mpeg_audio_format = MPEGAudioFormat.PCM;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof XmlFormatOptions);
    expect(opts2.mpeg_audio_format).toBe(MPEGAudioFormat.PCM);
  });

  test("test_modify_mpeg_mux_stream_compatibility", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("h.264", "base.aep"));
    py_assert(opts instanceof XmlFormatOptions);
    expect(opts.mpeg_mux_stream_compatibility).toBe(MPEGMuxStreamCompatibility.STD);
    opts.mpeg_mux_stream_compatibility = MPEGMuxStreamCompatibility.IPOD;
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof XmlFormatOptions);
    expect(opts2.mpeg_mux_stream_compatibility).toBe(MPEGMuxStreamCompatibility.IPOD);
  });

  test("test_format_code_read_only", () => {
    const [, opts] = _parse_fresh(AVI_DIR.div("base.aep"));
    py_assert(opts instanceof XmlFormatOptions);
    raises(AttributeError, () => {
      opts.format_code = "H264";
    });
  });

  test("test_set_none_is_noop", () => {
    const [, opts] = _parse_fresh(AVI_DIR.div("base.aep"));
    py_assert(opts instanceof XmlFormatOptions);
    const original = opts.video_codec;
    opts.video_codec = null;
    expect<XmlFormatOptions["video_codec"]>(opts.video_codec).toBe(original);
  });

  test("test_settings_view_format_code_read_only", () => {
    const [, opts] = _parse_fresh(FORMAT_DIR.div("h.264", "base.aep"));
    py_assert(opts instanceof XmlFormatOptions);
    // `XmlFormatOptions` has no `settings` attribute, so the Python attribute load raises
    // AttributeError before the item assignment; TS property loads yield undefined, so use getattr.
    raises(AttributeError, () => {
      getattr(opts, "settings").set("Format Code", "MooV");
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
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("mp3", "mp3_mono_320.aep"));
    py_assert(opts instanceof XmlFormatOptions);
    expect(opts.bitrate).toBe(320);
    opts.params.update(new Map([["BitRate", "128"]]));
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof XmlFormatOptions);
    expect<string>(getitem(opts2.params, "BitRate")).toBe("128");
    expect(opts2.bitrate).toBe(128);
  });

  test("test_update_kwargs_persists", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("mp3", "mp3_mono_320.aep"));
    py_assert(opts instanceof XmlFormatOptions);
    opts.params.update({ BitRate: "192" });
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof XmlFormatOptions);
    expect(opts2.bitrate).toBe(192);
  });

  test("test_setdefault_persists_new_key", () => {
    const tmp_path = make_tmp_path();
    const [project, opts] = _parse_fresh(FORMAT_DIR.div("mp3", "mp3_mono_320.aep"));
    py_assert(opts instanceof XmlFormatOptions);
    expect(opts.params.setdefault("ADBEUnusedParam", "7")).toBe("7");
    project.save(tmp_path.div("out.aep"));
    const [, opts2] = _parse_fresh(tmp_path.div("out.aep"));
    py_assert(opts2 instanceof XmlFormatOptions);
    expect<string>(getitem(opts2.params, "ADBEUnusedParam")).toBe("7");
  });

  test("test_setdefault_keeps_existing", () => {
    const [, opts] = _parse_fresh(FORMAT_DIR.div("mp3", "mp3_mono_320.aep"));
    py_assert(opts instanceof XmlFormatOptions);
    expect(opts.params.setdefault("BitRate", "1")).toBe("320");
    expect(opts.bitrate).toBe(320);
  });
});

/** The PNG options' alpha flag, channel count and bits per channel. */
function _png_option_fields(om: OutputModule): [boolean, number, number] {
  const body = as_instance(om.format_options, PngFormatOptions)._body;
  return [body.has_alpha, body.channel_count, body.bit_depth];
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
      const tmp_path = make_tmp_path();
      // AE renders from the module's Channels / Depth either way (a stale
      // PNG option renders the module's choice), but stores them in step.
      const app = parse(FORMAT_DIR.div("png", sample));
      const om = as_instance(app.project.render_queue, RenderQueue).items[0].output_modules[0];
      om.batch_edit(() => {
        om.settings.set("Channels", channels);
        om.settings.set("Depth", depth);
      });
      expect(py_eq(_png_option_fields(om), expected)).toBe(true);
      const out = tmp_path.div("png.aep");
      app.project.save(out);
      const reread = as_instance(parse(out).project.render_queue, RenderQueue).items[0].output_modules[0];
      expect(py_eq(_png_option_fields(reread), expected)).toBe(true);
    },
  );

  test("test_single_writes_update_the_png_options", () => {
    const app = parse(FORMAT_DIR.div("png", "base.aep")); // RGB + Alpha, Trillions+
    const om = as_instance(app.project.render_queue, RenderQueue).items[0].output_modules[0];
    om.settings.set("Channels", OutputChannels.RGB); // pairs Depth to Trillions
    expect(py_eq(_png_option_fields(om), [false, 3, 16])).toBe(true);
    om.settings.set("Depth", OutputColorDepth.MILLIONS_OF_COLORS);
    expect(py_eq(_png_option_fields(om), [false, 3, 8])).toBe(true);
  });

  test("test_after_effects_samples_are_in_step", () => {
    const lockstep = new Map<string, [boolean, number, number]>(
      _PNG_LOCKSTEP.map(([c, d, fields]) => [tkey(int(c), int(d)), fields]),
    );
    for (const path of sorted(FORMAT_DIR.div("png").glob("*.aep"), (p: Path) => p.toString())) {
      const om = as_instance(parse(path).project.render_queue, RenderQueue).items[0].output_modules[0];
      const key = tkey(int(om.settings.get("Channels")), int(om.settings.get("Depth")));
      py_assert(py_eq(_png_option_fields(om), getitem(lockstep, key)), path.name);
    }
  });
});
