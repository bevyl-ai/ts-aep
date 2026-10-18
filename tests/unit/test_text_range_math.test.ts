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
import { cosAt, cosItem, cosIter, cosNum, cosSetitem } from "../../src/py_aep/cos/kinds.ts";
import { CHARACTER_RANGE_OOB, CharacterRange, ComposedLineRange, RangeField, _composedLineSpans, _mergeAdjacentRuns, _snapToPairs, _splitRunArray, u16Len, u16Slice } from "../../src/py_aep/models/text/ranges.ts";
import { TextDocument } from "../../src/py_aep/models/text/text_document.ts";
import {
  TypeError_,
  ValueError,
  deepcopy,
  descriptorsOf,
  dictGet,
  getDescriptor,
  pyEq,
  pyOr,
  repr,
  setattr,
  str,
  sum,
} from "../../src/pyrt/index.ts";
import { asInstance } from "../helpers.ts";

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
    _splitRunArray(runs, new Set([3, 7]));
    expect(pyEq(runs.map((r) => cosItem(r, "1")), [3, 4, 3])).toBe(true);
    // Run 0 keeps its object (and its style dict) as the left piece.
    expect(runs[0]).toBe(original);
    expect(cosItem(cosItem(cosItem(runs[0], "0"), "0"), "6")).toBe(style);
    // Fragments are independent copies.
    cosSetitem(cosItem(cosItem(cosItem(runs[1], "0"), "0"), "6"), "1", 72.0);
    expect(cosItem(cosItem(cosItem(cosItem(runs[0], "0"), "0"), "6"), "1")).toBe(36.0);
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
    _mergeAdjacentRuns(runs);
    expect(pyEq(runs, [a, c])).toBe(true);
    expect(runs[0]).toBe(a);
    expect(cosItem(runs[0], "1")).toBe(7);
  });

  test("test_snap_to_pairs", () => {
    const raw = `ab${EMOJI}cd\r`;
    expect(pyEq(_snapToPairs(raw, 3, 5), [2, 5])).toBe(true);
    expect(pyEq(_snapToPairs(raw, 2, 3), [2, 4])).toBe(true);
    expect(pyEq(_snapToPairs(raw, 0, 2), [0, 2])).toBe(true);
    // A mid-pair caret moves past the pair but stays zero-span, so
    // caret writes remain no-ops instead of covering the glyph.
    expect(pyEq(_snapToPairs(raw, 3, 3), [4, 4])).toBe(true);
    expect(pyEq(_snapToPairs(raw, 1, 1), [1, 1])).toBe(true);
  });

  test("test_deepcopy_preserves_cos_scalars", () => {
    // The split engine deepcopies full style dicts; the serializer's
    // byte output depends on these flags surviving the copy.
    const nested = new Map<string, CosNode>([
      ["99", new CosName("X")],
      ["0", [new CosString("s", { utf16: false })]],
    ]);
    const clone = deepcopy(nested);
    expect(asInstance(cosAt(cosItem(clone, "0"), 0), CosString).cos_utf16).toBe(false);
    expect(str(cosItem(clone, "99"))).toBe("X");
  });

  test("test_range_write_on_synthetic_doc", () => {
    const doc = makeDoc("abcdefghij\r");
    new CharacterRange(doc, 3, 7).fontSize = 72;
    const lengths = cosIter(cosItem(cosItem(cosItem(doc._doc, "0"), "6"), "0")).map((r) => cosItem(r, "1"));
    expect(pyEq(lengths, [3, 4, 4])).toBe(true);
    expect(new CharacterRange(doc, 3, 7).fontSize).toBe(72.0);
    // key absent -> default
    expect(new CharacterRange(doc, 0, 3).fontSize).toBeNull();
  });

  test("test_range_write_validation", () => {
    const doc = makeDoc("abcdefghij\r");
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
    const doc = makeDoc("AVAW\r");
    new CharacterRange(doc, 2, 4).kerning = 100;
    const runs = cosItem(cosItem(cosItem(doc._doc, "0"), "8"), "0");
    expect(pyEq(cosAt(runs, -1), new Map<string, CosNode>([["0", new Map<string, CosNode>()], ["1", 1]]))).toBe(true);
    expect(sum(cosIter(runs).map((r) => cosNum(cosItem(r, "1"))))).toBe(5);
  });
});

/** Build a duck-typed document from `(length, style)` run pairs. */
function makeDoc(
  raw: string,
  charRuns: [number, CosDict][] | null = null,
  paraRuns: [number, CosDict][] | null = null,
  lineCache: CosNode[] | null = null,
): TextDocument {
  const runArray = (runs: [number, CosDict][], styleKey: string): CosDict =>
    new Map<string, CosNode>([
      [
        "0",
        runs.map(
          ([length, style]) =>
            new Map<string, CosNode>([
              ["0", new Map<string, CosNode>([["0", new Map<string, CosNode>([[styleKey, style]])]])],
              ["1", length],
            ]),
        ),
      ],
    ]);

  const total = u16Len(raw);
  const doc = new Map<string, CosNode>([["0", new Map<string, CosNode>([["0", raw]])]]);
  cosSetitem(cosItem(doc, "0"), "6", runArray(pyOr(charRuns, [[total, new Map<string, CosNode>()]]), "6"));
  cosSetitem(cosItem(doc, "0"), "5", runArray(pyOr(paraRuns, [[total, new Map<string, CosNode>()]]), "5"));
  if (lineCache != null) doc.set("1", new Map<string, CosNode>([["2", lineCache]]));
  // Docs carrying a line cache act as box text (point text derives its
  // composed lines from the paragraphs and never reads the cache).
  // @ts-expect-error duck-typed document (Python SimpleNamespace), not a TextDocument
  return { _doc: doc, _fonts: [], boxText: lineCache != null };
}

function line(...segmentCounts: number[]): CosDict {
  /** A synthetic `/L` record with one `/S` per count. */
  return new Map<string, CosNode>([
    ["99", new CosName("L")],
    [
      "6",
      segmentCounts.map(
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
    expect(u16Len("hello")).toBe(5);
    expect(u16Len("")).toBe(0);
  });

  test("test_len_astral", () => {
    expect(u16Len(EMOJI)).toBe(2);
    expect(u16Len(`ab${EMOJI}cd`)).toBe(6);
  });

  test("test_slice_bmp", () => {
    expect(u16Slice("hello", 1, 3)).toBe("el");
  });

  test("test_slice_astral", () => {
    expect(u16Slice(`ab${EMOJI}cd`, 2, 4)).toBe(EMOJI);
    expect(u16Slice(`ab${EMOJI}cd`, 0, 6)).toBe(`ab${EMOJI}cd`);
  });

  test("test_slice_splits_surrogate_pair", () => {
    // AE allows the split and yields a lone surrogate; so do we.
    expect(u16Slice(`ab${EMOJI}cd`, 2, 3)).toBe("\ud83d");
    expect(u16Slice(`ab${EMOJI}cd`, 0, 3)).toBe("ab\ud83d");
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
    const doc = makeDoc("abcdefgh\r", null, null, cache);
    expect(pyEq(_composedLineSpans(doc), [[0, 5], [5, 9]])).toBe(true);
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
    const doc = makeDoc("abcdefgh\r", null, null, cache);
    expect(pyEq(_composedLineSpans(doc), [[0, 4], [4, 9]])).toBe(true);
  });

  test("test_box_without_cache", () => {
    const doc = makeDoc("abcd\r");
    setattr(doc, "boxText", true);
    expect(_composedLineSpans(doc)).toBeNull();
  });

  test("test_point_text_lines_are_the_paragraphs", () => {
    // Point text never wraps; its composed lines derive from the
    // paragraph runs and stay fresh without any cache.
    const doc = makeDoc("ab\rcd\r", null, [
      [3, new Map<string, CosNode>()],
      [3, new Map<string, CosNode>()],
    ]);
    expect(pyEq(_composedLineSpans(doc), [[0, 3], [3, 6]])).toBe(true);
  });

  test("test_stale_cache_clamps_and_raises", () => {
    // Cache describes 9 chars, text shrank to "ab\r" (visible 2).
    const cache = [
      new Map<string, CosNode>([
        ["99", new CosName("PC")],
        ["6", [new Map<string, CosNode>([["99", new CosName("F")], ["6", [line(5), line(4)]]])]],
      ]),
    ];
    const doc = makeDoc("ab\r", null, null, cache);
    const first = new ComposedLineRange(doc, 0, 1);
    expect(pyEq([first.characterStart, first.characterEnd], [0, 2])).toBe(true);
    raises(ValueError, () => new ComposedLineRange(doc, 1, 2), "ComposedLine index range");
  });
});

describe("TestCharacterRangeMath", () => {
  test("test_dynamic_minus_one_end", () => {
    const doc = makeDoc("hello\r");
    const rng = new CharacterRange(doc, 0, -1);
    expect(rng.characterEnd).toBe(5);
    cosSetitem(cosItem(doc._doc, "0"), "0", "hi\r");
    expect(rng.characterEnd).toBe(2);
  });

  test("test_shrink_invalidates_fixed_end", () => {
    const doc = makeDoc("hello\r");
    const rng = new CharacterRange(doc, 0, 5);
    expect(rng.isRangeValid).toBe(true);
    cosSetitem(cosItem(doc._doc, "0"), "0", "hi\r");
    expect(rng.isRangeValid).toBe(false);
    raises(ValueError, () => rng.characterStart, CHARACTER_RANGE_OOB.slice(0, 20));
  });

  test("test_creation_bounds", () => {
    const doc = makeDoc("hello\r");
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
    const doc = makeDoc("abcdef\r", [
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
    const doc = makeDoc("abcdef\r", [
      [3, new Map<string, CosNode>([["57", false], ["54", black]])],
      [4, new Map<string, CosNode>([["57", true], ["54", red]])],
    ]);
    // Only the applyStroke run participates: uniform red, not mixed.
    expect(pyEq(new CharacterRange(doc, 0, 6).strokeColor, [1.0, 0.0, 0.0])).toBe(true);
    // A range over non-stroked runs only reads None.
    expect(new CharacterRange(doc, 0, 3).strokeColor).toBeNull();
  });

  test("test_zero_span_uses_containing_run", () => {
    const doc = makeDoc("abcdef\r", [
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
    for (const [name, field] of descriptorsOf(CharacterRange)) {
      if (!(field instanceof RangeField)) continue;
      // NOTE(port): TextDocument has no base class, so the MRO walk in get_descriptor equals TextDocument.__dict__.get(name).
      const cosField = getDescriptor(TextDocument, name);
      if (!(cosField instanceof CosField)) continue;
      if (field.key !== cosField.key) {
        mismatches.push(
          `${name}: RangeField key ${repr(field.key)} != CosField key ${repr(cosField.key)}`,
        );
      }
      const expectedDictAttr = dictGet(KIND_TO_DICT_ATTR, field.kind);
      if (cosField.dictAttr !== expectedDictAttr) {
        mismatches.push(
          `${name}: RangeField kind ${repr(field.kind)} vs CosField dict ` +
            `${repr(cosField.dictAttr)}`,
        );
      }
      if (!field.readOnly && field.validate !== cosField.validate) {
        mismatches.push(
          `${name}: RangeField validate ${repr(field.validate)} != ` +
            `CosField validate ${repr(cosField.validate)}`,
        );
      }
    }
    expect(mismatches.join("\n")).toBe("");
  });
});
