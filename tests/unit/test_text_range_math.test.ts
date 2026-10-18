/**
 * Unit tests for text-range boundary math on synthetic COS documents.
 *
 * These cover structural cases the AE-generated sample corpus cannot
 * (multi-segment composed lines, multiple frames, sparse style runs) plus
 * the UTF-16 helpers and the RangeField/CosField spec consistency guard.
 */

import { describe, expect, test } from "bun:test";
import { raises } from "../../src/pyrt/pytest.ts";
// Importing `py_aep.cos` in Python runs `py_aep/__init__`, which registers every chunk type.
import "../../src/py_aep/binary/_register.ts";
import { CosField, CosName } from "../../src/py_aep/cos/index.ts";
import { CosString, type CosDict, type CosNode } from "../../src/py_aep/cos/cos.ts";
import { cos_at, cos_item, cos_iter, cos_num, cos_setitem } from "../../src/py_aep/cos/kinds.ts";
import { CHARACTER_RANGE_OOB, CharacterRange, ComposedLineRange, RangeField, _composed_line_spans, _merge_adjacent_runs, _snap_to_pairs, _split_run_array, u16_len, u16_slice } from "../../src/py_aep/models/text/ranges.ts";
import { TextDocument } from "../../src/py_aep/models/text/text_document.ts";
import {
  TypeError_,
  ValueError,
  deepcopy,
  descriptors_of,
  dict_get,
  get_descriptor,
  py_eq,
  py_or,
  repr,
  setattr,
  str,
  sum,
} from "../../src/pyrt/index.ts";
import { as_instance } from "../helpers.ts";

const EMOJI = "\u{1f600}";

describe("TestWriteEnginePrimitives", () => {
  test("test_split_keeps_original_as_left_fragment", () => {
    const style = new Map<string, CosNode>([["1", 36.0]]);
    const runs: CosNode[] = [
      new Map<string, CosNode>([
        ["0", new Map<string, CosNode>([["0", new Map<string, CosNode>([["6", style]])]])],
        ["1", 10],
      ]),
    ];
    const original = runs[0];
    _split_run_array(runs, new Set([3, 7]));
    expect(py_eq(runs.map((r) => cos_item(r, "1")), [3, 4, 3])).toBe(true);
    // Run 0 keeps its object (and its style dict) as the left piece.
    expect(runs[0]).toBe(original);
    expect(cos_item(cos_item(cos_item(runs[0], "0"), "0"), "6")).toBe(style);
    // Fragments are independent copies.
    cos_setitem(cos_item(cos_item(cos_item(runs[1], "0"), "0"), "6"), "1", 72.0);
    expect(cos_item(cos_item(cos_item(cos_item(runs[0], "0"), "0"), "6"), "1")).toBe(36.0);
  });

  test("test_merge_keeps_first_object", () => {
    const a = new Map<string, CosNode>([
      ["0", new Map<string, CosNode>([["0", new Map<string, CosNode>([["6", new Map<string, CosNode>([["1", 72.0]])]])]])],
      ["1", 3],
    ]);
    const b = new Map<string, CosNode>([
      ["0", new Map<string, CosNode>([["0", new Map<string, CosNode>([["6", new Map<string, CosNode>([["1", 72.0]])]])]])],
      ["1", 4],
    ]);
    const c = new Map<string, CosNode>([
      ["0", new Map<string, CosNode>([["0", new Map<string, CosNode>([["6", new Map<string, CosNode>([["1", 36.0]])]])]])],
      ["1", 4],
    ]);
    const runs: CosNode[] = [a, b, c];
    _merge_adjacent_runs(runs);
    expect(py_eq(runs, [a, c])).toBe(true);
    expect(runs[0]).toBe(a);
    expect(cos_item(runs[0], "1")).toBe(7);
  });

  test("test_snap_to_pairs", () => {
    const raw = `ab${EMOJI}cd\r`;
    expect(py_eq(_snap_to_pairs(raw, 3, 5), [2, 5])).toBe(true);
    expect(py_eq(_snap_to_pairs(raw, 2, 3), [2, 4])).toBe(true);
    expect(py_eq(_snap_to_pairs(raw, 0, 2), [0, 2])).toBe(true);
    // A mid-pair caret moves past the pair but stays zero-span, so
    // caret writes remain no-ops instead of covering the glyph.
    expect(py_eq(_snap_to_pairs(raw, 3, 3), [4, 4])).toBe(true);
    expect(py_eq(_snap_to_pairs(raw, 1, 1), [1, 1])).toBe(true);
  });

  test("test_deepcopy_preserves_cos_scalars", () => {
    // The split engine deepcopies full style dicts; the serializer's
    // byte output depends on these flags surviving the copy.
    const nested = new Map<string, CosNode>([
      ["99", new CosName("X")],
      ["0", [new CosString("s", { utf16: false })]],
    ]);
    const clone = deepcopy(nested);
    expect(as_instance(cos_at(cos_item(clone, "0"), 0), CosString).cos_utf16).toBe(false);
    expect(str(cos_item(clone, "99"))).toBe("X");
  });

  test("test_range_write_on_synthetic_doc", () => {
    const doc = make_doc("abcdefghij\r");
    new CharacterRange(doc, 3, 7).fontSize = 72;
    const lengths = cos_iter(cos_item(cos_item(cos_item(doc._doc, "0"), "6"), "0")).map((r) => cos_item(r, "1"));
    expect(py_eq(lengths, [3, 4, 4])).toBe(true);
    expect(new CharacterRange(doc, 3, 7).fontSize).toBe(72.0);
    // key absent -> default
    expect(new CharacterRange(doc, 0, 3).fontSize).toBeNull();
  });

  test("test_range_write_validation", () => {
    const doc = make_doc("abcdefghij\r");
    raises(ValueError, () => {
      new CharacterRange(doc, 0, 5).fontSize = 0;
    });
    // NOTE(port): pytest.raises((TypeError, ValueError)) tuple form checked inline; same accepted exception set.
    let caught: unknown;
    try {
      // @ts-expect-error 5 is not an AutoKernType; the setter must reject it
      new CharacterRange(doc, 0, 5).autoKernType = 5;
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof TypeError_ || caught instanceof ValueError).toBe(true);
  });

  test("test_kerning_write_skips_terminator", () => {
    // AE never kerns the raw \r terminator: a range ending at the
    // visible length must leave the final unit in an empty run.
    const doc = make_doc("AVAW\r");
    new CharacterRange(doc, 2, 4).kerning = 100;
    const runs = cos_item(cos_item(cos_item(doc._doc, "0"), "8"), "0");
    expect(py_eq(cos_at(runs, -1), new Map<string, CosNode>([["0", new Map<string, CosNode>()], ["1", 1]]))).toBe(true);
    expect(sum(cos_iter(runs).map((r) => cos_num(cos_item(r, "1"))))).toBe(5);
  });
});

/** Build a duck-typed document from `(length, style)` run pairs. */
function make_doc(
  raw: string,
  char_runs: [number, CosDict][] | null = null,
  para_runs: [number, CosDict][] | null = null,
  line_cache: CosNode[] | null = null,
): TextDocument {
  const run_array = (runs: [number, CosDict][], style_key: string): CosDict =>
    new Map<string, CosNode>([
      [
        "0",
        runs.map(
          ([length, style]) =>
            new Map<string, CosNode>([
              ["0", new Map<string, CosNode>([["0", new Map<string, CosNode>([[style_key, style]])]])],
              ["1", length],
            ]),
        ),
      ],
    ]);

  const total = u16_len(raw);
  const doc = new Map<string, CosNode>([["0", new Map<string, CosNode>([["0", raw]])]]);
  cos_setitem(cos_item(doc, "0"), "6", run_array(py_or(char_runs, [[total, new Map<string, CosNode>()]]), "6"));
  cos_setitem(cos_item(doc, "0"), "5", run_array(py_or(para_runs, [[total, new Map<string, CosNode>()]]), "5"));
  if (line_cache != null) doc.set("1", new Map<string, CosNode>([["2", line_cache]]));
  // Docs carrying a line cache act as box text (point text derives its
  // composed lines from the paragraphs and never reads the cache).
  // @ts-expect-error duck-typed document (Python SimpleNamespace), not a TextDocument
  return { _doc: doc, _fonts: [], boxText: line_cache != null };
}

function line(...segment_counts: number[]): CosDict {
  /** A synthetic `/L` record with one `/S` per count. */
  return new Map<string, CosNode>([
    ["99", new CosName("L")],
    [
      "6",
      segment_counts.map(
        (count) =>
          new Map<string, CosNode>([
            ["99", new CosName("S")],
            ["15", new Map<string, CosNode>([["0", count]])],
          ]),
      ),
    ],
  ]);
}

describe("TestU16Helpers", () => {
  test("test_len_bmp", () => {
    expect(u16_len("hello")).toBe(5);
    expect(u16_len("")).toBe(0);
  });

  test("test_len_astral", () => {
    expect(u16_len(EMOJI)).toBe(2);
    expect(u16_len(`ab${EMOJI}cd`)).toBe(6);
  });

  test("test_slice_bmp", () => {
    expect(u16_slice("hello", 1, 3)).toBe("el");
  });

  test("test_slice_astral", () => {
    expect(u16_slice(`ab${EMOJI}cd`, 2, 4)).toBe(EMOJI);
    expect(u16_slice(`ab${EMOJI}cd`, 0, 6)).toBe(`ab${EMOJI}cd`);
  });

  test("test_slice_splits_surrogate_pair", () => {
    // AE allows the split and yields a lone surrogate; so do we.
    expect(u16_slice(`ab${EMOJI}cd`, 2, 3)).toBe("\ud83d");
    expect(u16_slice(`ab${EMOJI}cd`, 0, 3)).toBe("ab\ud83d");
  });
});

describe("TestComposedLineSpans", () => {
  test("test_multi_segment_lines", () => {
    // A line split into several /S segments (e.g. bidi) must sum them.
    const cache = [
      new Map<string, CosNode>([
        ["99", new CosName("PC")],
        ["6", [new Map<string, CosNode>([["99", new CosName("F")], ["6", [line(3, 2), line(4)]]])]],
      ]),
    ];
    const doc = make_doc("abcdefgh\r", null, null, cache);
    expect(py_eq(_composed_line_spans(doc), [[0, 5], [5, 9]])).toBe(true);
  });

  test("test_multiple_frames", () => {
    const cache = [
      new Map<string, CosNode>([
        ["99", new CosName("PC")],
        [
          "6",
          [
            new Map<string, CosNode>([["99", new CosName("F")], ["6", [line(4)]]]),
            new Map<string, CosNode>([["99", new CosName("F")], ["6", [line(5)]]]),
          ],
        ],
      ]),
    ];
    const doc = make_doc("abcdefgh\r", null, null, cache);
    expect(py_eq(_composed_line_spans(doc), [[0, 4], [4, 9]])).toBe(true);
  });

  test("test_box_without_cache", () => {
    const doc = make_doc("abcd\r");
    setattr(doc, "boxText", true);
    expect(_composed_line_spans(doc)).toBeNull();
  });

  test("test_point_text_lines_are_the_paragraphs", () => {
    // Point text never wraps; its composed lines derive from the
    // paragraph runs and stay fresh without any cache.
    const doc = make_doc("ab\rcd\r", null, [
      [3, new Map<string, CosNode>()],
      [3, new Map<string, CosNode>()],
    ]);
    expect(py_eq(_composed_line_spans(doc), [[0, 3], [3, 6]])).toBe(true);
  });

  test("test_stale_cache_clamps_and_raises", () => {
    // Cache describes 9 chars, text shrank to "ab\r" (visible 2).
    const cache = [
      new Map<string, CosNode>([
        ["99", new CosName("PC")],
        ["6", [new Map<string, CosNode>([["99", new CosName("F")], ["6", [line(5), line(4)]]])]],
      ]),
    ];
    const doc = make_doc("ab\r", null, null, cache);
    const first = new ComposedLineRange(doc, 0, 1);
    expect(py_eq([first.characterStart, first.characterEnd], [0, 2])).toBe(true);
    raises(ValueError, () => new ComposedLineRange(doc, 1, 2), "ComposedLine index range");
  });
});

describe("TestCharacterRangeMath", () => {
  test("test_dynamic_minus_one_end", () => {
    const doc = make_doc("hello\r");
    const rng = new CharacterRange(doc, 0, -1);
    expect(rng.characterEnd).toBe(5);
    cos_setitem(cos_item(doc._doc, "0"), "0", "hi\r");
    expect(rng.characterEnd).toBe(2);
  });

  test("test_shrink_invalidates_fixed_end", () => {
    const doc = make_doc("hello\r");
    const rng = new CharacterRange(doc, 0, 5);
    expect(rng.isRangeValid).toBe(true);
    cos_setitem(cos_item(doc._doc, "0"), "0", "hi\r");
    expect(rng.isRangeValid).toBe(false);
    raises(ValueError, () => rng.characterStart, CHARACTER_RANGE_OOB.slice(0, 20));
  });

  test("test_creation_bounds", () => {
    const doc = make_doc("hello\r");
    for (const [start, end] of [
      [6, 7],
      [0, 6],
      [3, 1],
      [0, -2],
      [-1, 2],
    ]) {
      raises(ValueError, () => new CharacterRange(doc, start, end), "Character index range");
    }
  });

  test("test_sparse_runs_mix_with_default", () => {
    // Defensive path: a run lacking the key contributes the default.
    const doc = make_doc("abcdef\r", [
      [3, new Map<string, CosNode>([["2", true]])],
      [4, new Map<string, CosNode>()],
    ]);
    const rng = new CharacterRange(doc, 0, 6);
    // Stored True vs absent (default None) -> mixed -> None
    expect(rng.fauxBold).toBeNull();
  });

  test("test_gated_color_resolution", () => {
    const red = new Map<string, CosNode>([
      ["99", new CosName("SimplePaint")],
      ["0", new Map<string, CosNode>([["0", 1], ["1", [1.0, 1.0, 0.0, 0.0]]])],
    ]);
    const black = new Map<string, CosNode>([
      ["99", new CosName("SimplePaint")],
      ["0", new Map<string, CosNode>([["0", 1], ["1", [1.0, 0.0, 0.0, 0.0]]])],
    ]);
    const doc = make_doc("abcdef\r", [
      [3, new Map<string, CosNode>([["57", false], ["54", black]])],
      [4, new Map<string, CosNode>([["57", true], ["54", red]])],
    ]);
    // Only the applyStroke run participates: uniform red, not mixed.
    expect(py_eq(new CharacterRange(doc, 0, 6).strokeColor, [1.0, 0.0, 0.0])).toBe(true);
    // A range over non-stroked runs only reads None.
    expect(new CharacterRange(doc, 0, 3).strokeColor).toBeNull();
  });

  test("test_zero_span_uses_containing_run", () => {
    const doc = make_doc("abcdef\r", [
      [3, new Map<string, CosNode>([["1", 72.0]])],
      [4, new Map<string, CosNode>([["1", 36.0]])],
    ]);
    expect(new CharacterRange(doc, 2, 2).fontSize).toBe(72.0);
    // A caret on a run boundary belongs to the following run.
    expect(new CharacterRange(doc, 3, 3).fontSize).toBe(36.0);
    // EOF caret lands in the final run (which covers the terminator).
    expect(new CharacterRange(doc, 6, 6).fontSize).toBe(36.0);
  });
});

describe("TestUnassociatedDocuments", () => {
  test("test_template_document_refuses_ranges", () => {
    const doc = new TextDocument("hello");
    expect(doc.composedLineCount).toBeNull();
    raises(ValueError, () => doc.characterRange(0), "not associated with a layer");
    raises(ValueError, () => doc.paragraphRange(0), "not associated with a layer");
    raises(ValueError, () => doc.composedLineRange(0), "not associated with a layer");
    raises(ValueError, () => doc.paragraphCharacterIndexesAt(0), "not associated with a layer");
  });
});

describe("TestSpecConsistency", () => {
  // RangeField declarations must agree with TextDocument's CosFields.
  const KIND_TO_DICT_ATTR = new Map<string, string>([
    ["char", "_char_style"],
    ["para", "_para_style"],
  ]);

  test("test_rangefields_match_cosfields", () => {
    const mismatches: string[] = [];
    // vars(CharacterRange).items(): descriptors declared on the class.
    for (const [name, field] of descriptors_of(CharacterRange)) {
      if (!(field instanceof RangeField)) continue;
      // NOTE(port): TextDocument has no base class, so the MRO walk in get_descriptor equals TextDocument.__dict__.get(name).
      const cos_field = get_descriptor(TextDocument, name);
      if (!(cos_field instanceof CosField)) continue;
      if (field.key !== cos_field.key) {
        mismatches.push(
          `${name}: RangeField key ${repr(field.key)} != CosField key ${repr(cos_field.key)}`,
        );
      }
      const expected_dict_attr = dict_get(KIND_TO_DICT_ATTR, field.kind);
      if (cos_field.dictAttr !== expected_dict_attr) {
        mismatches.push(
          `${name}: RangeField kind ${repr(field.kind)} vs CosField dict ` +
            `${repr(cos_field.dictAttr)}`,
        );
      }
      if (!field.readOnly && field.validate !== cos_field.validate) {
        mismatches.push(
          `${name}: RangeField validate ${repr(field.validate)} != ` +
            `CosField validate ${repr(cos_field.validate)}`,
        );
      }
    }
    expect(mismatches.join("\n")).toBe("");
  });
});
