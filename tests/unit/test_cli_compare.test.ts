/**
 * Tests for CLI compare module.
 *
 * These tests verify the aep-compare command line tool functionality,
 * including leaf-only diff output, multi-file comparison, and context display.
 */

import { describe, expect, test } from "bun:test";

import "../../src/py_aep/binary/_register.ts";
import { formatHexDump } from "../../src/py_aep/cli/_chunk_helpers.ts";
import { ByteDifference, ChunkDifference, MultiFileDifference, _compareChunkDicts, _gradientXmlOnlyFloatDiff, _multiOnlyFloatDiff, _onlyFloatDiff, compareBinaryData, filterDifferences, toJsonOutput } from "../../src/py_aep/cli/compare.ts";
import { CdatChunk } from "../../src/py_aep/binary/property_chunks.ts";
import { ShphChunk } from "../../src/py_aep/binary/misc_chunks.ts";
import { Utf8Chunk } from "../../src/py_aep/binary/scalar_chunks.ts";
import { Path, b, valueEquals } from "../../src/pyrt/index.ts";
import { range, split, strip } from "../support/python.ts";

// SAMPLES_DIR = Path(__file__).parent.parent.parent / "samples"
const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples");

describe("TestByteDifference", () => {
  /** Test that single bit differences are detected and position calculated. */
  test("test_single_bit_difference_detected", () => {
    // Bit 0 differs (0x00 vs 0x01)
    const diff = new ByteDifference("test", 0, 0x00, 0x01);
    expect(diff.bitPosition).toBe(7); // Bit 0 from right = bit 7 from left
  });

  /** Test that multiple bit differences don't have a bit position. */
  test("test_multiple_bit_difference_no_position", () => {
    // Multiple bits differ (0x00 vs 0xFF)
    const diff = new ByteDifference("test", 0, 0x00, 0xff);
    expect(diff.bitPosition == null).toBe(true);
  });

  /** Test format_diff output includes bit position when applicable. */
  test("test_format_diff_with_bit_position", () => {
    const diff = new ByteDifference("test", 10, 0x80, 0x00);
    const formatted = diff.formatDiff();
    expect(formatted).toContain("bit 0"); // MSB is bit 0
    expect(formatted).toContain("0x80");
    expect(formatted).toContain("0x00");
  });
});

describe("TestMultiFileDifference", () => {
  /** Bit position is set when exactly two distinct values differ by 1 bit. */
  test("test_single_bit_two_distinct_values", () => {
    const diff = new MultiFileDifference("test", 0, [0x00, 0x80, 0x00, 0x80]);
    expect(diff.bitPosition).toBe(0); // MSB
  });

  /** No bit position when values differ by more than one bit. */
  test("test_multiple_bits_no_position", () => {
    const diff = new MultiFileDifference("test", 0, [0x00, 0xff, 0x00]);
    expect(diff.bitPosition == null).toBe(true);
  });

  /** No bit position when more than two distinct values. */
  test("test_three_distinct_values_no_position", () => {
    const diff = new MultiFileDifference("test", 0, [0x00, 0x01, 0x02]);
    expect(diff.bitPosition == null).toBe(true);
  });
});

describe("TestCompareBinaryData", () => {
  /** Test that identical byte sequences produce no differences. */
  test("test_identical_bytes_no_differences", () => {
    const data = b("\x00\x01\x02\x03");
    const diffs = [...compareBinaryData(data, data, "test")];
    expect(diffs.length).toBe(0);
  });

  /** Test detection of a single byte difference. */
  test("test_single_byte_difference", () => {
    const data1 = b("\x00\x01\x02\x03");
    const data2 = b("\x00\xff\x02\x03");
    const diffs = [...compareBinaryData(data1, data2, "test")];
    expect(diffs.length).toBe(1);
    expect(diffs[0].offset).toBe(1);
    expect(diffs[0].byte1).toBe(0x01);
    expect(diffs[0].byte2).toBe(0xff);
  });

  /** Test that extra bytes in longer sequence are reported. */
  test("test_different_lengths_reported", () => {
    const data1 = b("\x00\x01\x02");
    const data2 = b("\x00\x01\x02\x03\x04");
    const diffs = [...compareBinaryData(data1, data2, "test")];
    expect(diffs.length).toBe(2); // Two extra bytes in data2
    expect(diffs[0].offset).toBe(3);
    expect(diffs[0].byte1).toBe(-1); // Missing in data1
    expect(diffs[0].byte2).toBe(0x03);
  });
});

describe("TestCompareChunkDicts", () => {
  /** Identical dicts produce no differences. */
  test("test_identical_dicts", () => {
    const data = new Map([
      ["a", b("\x00\x01")],
      ["b", b("\x02\x03")],
    ]);
    const [diffs, only1, only2, suppressed] = _compareChunkDicts(data, data);
    expect(diffs.length).toBe(0);
    expect(only1.length).toBe(0);
    expect(only2.length).toBe(0);
    expect(valueEquals(suppressed, [])).toBe(true);
  });

  /** Paths in one dict but not the other are reported. */
  test("test_missing_paths_detected", () => {
    const data1 = new Map([
      ["a", b("\x00")],
      ["b", b("\x01")],
    ]);
    const data2 = new Map([
      ["a", b("\x00")],
      ["c", b("\x02")],
    ]);
    const [_, only1, only2, __] = _compareChunkDicts(data1, data2);
    expect(only1).toContain("b");
    expect(only2).toContain("c");
  });
});

describe("TestFloatTolerance", () => {
  // Class attribute _GRAD_XML: the template's only placeholder is {a}.
  const _GRAD_XML =
    "<?xml version='1.0'?>\n<prop.map version='4'>\n" +
    "<float>{a}</float>\n<float>0.5</float>\n</prop.map>\n";

  /** cdat within tolerance is suppressed. */
  test("test_cdat_within_tolerance_suppressed", () => {
    const c1 = new CdatChunk({ values: [535.0, 228.0, 0.0] });
    const c2 = new CdatChunk({ values: [535.00001, 228.0, 0.0] });
    expect(_onlyFloatDiff(c1, c2)).toBe(true);
  });

  /**
   * Gradient colors live as text floats in a Utf8 chunk; a 1-ULP
   * color difference (AE vs py float32 rounding) must be tolerated.
   */
  test("test_gradient_xml_color_ulp_suppressed", () => {
    const c1 = new Utf8Chunk({ value: _GRAD_XML.replace("{a}", "0.44705886") });
    const c2 = new Utf8Chunk({ value: _GRAD_XML.replace("{a}", "0.44705883") });
    expect(_onlyFloatDiff(c1, c2)).toBe(true);
  });

  test("test_gradient_xml_real_color_change_reported", () => {
    const c1 = new Utf8Chunk({ value: _GRAD_XML.replace("{a}", "0.44705886") });
    const c2 = new Utf8Chunk({ value: _GRAD_XML.replace("{a}", "0.80000001") });
    expect(_onlyFloatDiff(c1, c2)).toBe(false);
  });

  /**
   * An empty <float></float> element must not crash float() parsing; it
   * is not a pure float-precision diff, so it is reported (False).
   */
  test("test_gradient_xml_empty_float_tag_not_crash", () => {
    const xml = "<prop.map><array><float>0.5</float><float></float></array></prop.map>";
    expect(_gradientXmlOnlyFloatDiff(xml, xml)).toBe(false);
  });

  /**
   * A plain Utf8 (e.g. a layer name) is not gradient XML; only exact
   * equality applies (no float parsing).
   */
  test("test_non_gradient_utf8_not_tolerated", () => {
    expect(
      _onlyFloatDiff(new Utf8Chunk({ value: "Layer 1" }), new Utf8Chunk({ value: "Layer 2" })),
    ).toBe(false);
  });

  test("test_cdat_beyond_tolerance_reported", () => {
    const c1 = new CdatChunk({ values: [535.0, 228.0, 0.0] });
    const c2 = new CdatChunk({ values: [600.0, 228.0, 0.0] });
    expect(_onlyFloatDiff(c1, c2)).toBe(false);
  });

  test("test_shph_within_tolerance_suppressed", () => {
    const c1 = new ShphChunk({ topLeftX: -29.75, topLeftY: -32.5 });
    const c2 = new ShphChunk({ topLeftX: -29.7500012, topLeftY: -32.5 });
    expect(_onlyFloatDiff(c1, c2)).toBe(true);
  });

  /** Same floats but a different open/closed flag must NOT be suppressed. */
  test("test_nonfloat_bytes_still_reported", () => {
    const c1 = new ShphChunk({ topLeftX: 1.0, bottomRightX: 2.0 });
    const c2 = new ShphChunk({ topLeftX: 1.0, bottomRightX: 2.0 });
    c2.open = true;
    expect(_onlyFloatDiff(c1, c2)).toBe(false);
  });

  test("test_dict_compare_suppresses_float_noise", () => {
    const c1 = new CdatChunk({ values: [1.0, 2.0] });
    const c2 = new CdatChunk({ values: [1.00001, 2.0] });
    const data1 = new Map([["x", c1.tobytes()]]);
    const data2 = new Map([["x", c2.tobytes()]]);
    const typed1 = new Map([["x", c1]]);
    const typed2 = new Map([["x", c2]]);
    const [diffs, _, __, suppressed] = _compareChunkDicts(data1, data2, typed1, typed2);
    expect(valueEquals(diffs, [])).toBe(true);
    // the float-only diff is reported, not silent
    expect(valueEquals(suppressed, ["x"])).toBe(true);
    // --exact disables tolerance.
    const [diffsExact, ___, ____, suppressedExact] = _compareChunkDicts(
      data1,
      data2,
      typed1,
      typed2,
      true,
    );
    expect(diffsExact.length).toBe(1);
    expect(valueEquals(suppressedExact, [])).toBe(true);
  });

  /**
   * Multi-file: a chunk differing only in float coords across all files
   * is float-noise (a byte-identical file does not count as a diff).
   */
  test("test_multi_float_only_suppressed", () => {
    const ref = new CdatChunk({ values: [1.0, 2.0] });
    const close = new CdatChunk({ values: [1.00001, 2.0] });
    const same = new CdatChunk({ values: [1.0, 2.0] });
    const allTyped = [new Map([["x", ref]]), new Map([["x", close]]), new Map([["x", same]])];
    expect(_multiOnlyFloatDiff(allTyped, [0, 1, 2], "x")).toBe(true);
  });

  test("test_multi_real_diff_not_suppressed", () => {
    const ref = new CdatChunk({ values: [1.0, 2.0] });
    const far = new CdatChunk({ values: [9.0, 2.0] }); // beyond tolerance
    const allTyped = [new Map([["x", ref]]), new Map([["x", far]])];
    expect(_multiOnlyFloatDiff(allTyped, [0, 1], "x")).toBe(false);
  });
});

describe("TestFormatHexDump", () => {
  /** Hex dump of a few bytes formats correctly. */
  test("test_small_data", () => {
    const data = b("\x00\x01\x02\x03");
    const result = formatHexDump(data);
    expect(result).toContain("0000:");
    expect(result).toContain("00 01 02 03");
  });

  /** ASCII column shows printable chars and dots for non-printable. */
  test("test_ascii_representation", () => {
    const data = b("Hello\x00World");
    const result = formatHexDump(data);
    expect(result).toContain("Hello.World");
  });

  /** Data longer than 16 bytes produces multiple lines. */
  test("test_multi_line", () => {
    const data = Uint8Array.from(range(32));
    const result = formatHexDump(data);
    const lines = split(strip(result), "\n");
    expect(lines.length).toBe(2);
    expect(lines[0].startsWith("0000:")).toBe(true);
    expect(lines[1].startsWith("0010:")).toBe(true);
  });
});

describe("TestFilterDifferences", () => {
  /** Test that filter correctly matches patterns. */
  test("test_filter_matches_pattern", () => {
    const diff1 = new ChunkDifference("LIST:Layr/ldta", [], 10, 10);
    const diff2 = new ChunkDifference("LIST:Comp/cdta", [], 10, 10);
    const differences = [diff1, diff2];

    const [filtered, _, __] = filterDifferences(differences, [], [], "ldta");
    expect(filtered.length).toBe(1);
    expect(filtered[0].path).toBe("LIST:Layr/ldta");
  });

  /** Test that filter is case-insensitive. */
  test("test_filter_case_insensitive", () => {
    const diff = new ChunkDifference("LIST:Layr/LDTA", [], 10, 10);
    const [filtered, _, __] = filterDifferences([diff], [], [], "ldta");
    expect(filtered.length).toBe(1);
  });
});

describe("TestToJsonOutput", () => {
  /** Test that JSON output has expected structure. */
  test("test_json_output_structure", () => {
    const diff = new ChunkDifference(
      "test/path",
      [new ByteDifference("test", 0, 0x00, 0x01)],
      10,
      10,
    );
    const output = toJsonOutput(
      new Path("file1.aep"),
      new Path("file2.aep"),
      [diff],
      ["only1"],
      ["only2"],
    );
    expect("file1" in output).toBe(true);
    expect("file2" in output).toBe(true);
    expect("chunks_with_differences" in output).toBe(true);
    expect("only_in_file1" in output).toBe(true);
    expect("only_in_file2" in output).toBe(true);
    expect("summary" in output).toBe(true);
    expect(output.summary.chunks_with_differences).toBe(1);
    expect(output.summary.total_byte_differences).toBe(1);
  });
});
