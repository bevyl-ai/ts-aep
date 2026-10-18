/**
 * Byte-parity harness for the text-range write engine (phase W1).
 *
 * Each test replays one write operation from
 * `scripts/jsx/generate_text_write_samples.jsx` on a pristine base document
 * and compares py_aep's resulting btdk COS tree byte-for-byte against the
 * layer AE produced for the same operation in
 * `samples/models/text/text_writes.aep`. The `/PC` layout cache
 * (`doc["1"]["2"]`) is masked on both sides: AE recomposes it on apply,
 * py_aep must leave it untouched.
 */

import { describe, expect, test } from "bun:test";
import "../../src/py_aep/binary/_register.ts";
import { parse_app_fresh } from "../helpers.ts";
import {
  AttributeError,
  dict_get,
  deepcopy,
  getattr,
  len,
  Path,
  py_assert,
  py_eq,
  py_or,
  range,
  repr,
  StopIteration,
  ValueError,
  zip,
} from "../../src/pyrt/index.ts";
import { approx, make_tmp_path, raises, skip } from "../../src/pyrt/pytest.ts";
import { serialize } from "../../src/py_aep/cos/index.ts";
// noqa: F401 (documents the data source)
import { CosParser, type CosDict, type CosNode } from "../../src/py_aep/cos/cos.ts";
import {
  cos_at,
  cos_contains,
  cos_dict,
  cos_get_or,
  cos_item,
  cos_iter,
  cos_len,
  cos_pop,
} from "../../src/py_aep/cos/kinds.ts";
import type { Application } from "../../src/py_aep/models/application.ts";
import type { TextDocument } from "../../src/py_aep/models/text/text_document.ts";
import { AutoKernType, ParagraphJustification } from "../../src/py_aep/enums/index.ts";
import { _kern_values } from "../../src/py_aep/models/text/ranges.ts";
import { font_version_string } from "../../src/py_aep/svg/fonts.ts";

const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "text");
const FIXTURE = SAMPLES_DIR.div("text_writes.aep");
const PROBE = SAMPLES_DIR.div("text_writes_probe.json");
const FIXTURE2 = SAMPLES_DIR.div("text_writes2.aep");
const PROBE2 = SAMPLES_DIR.div("text_writes2_probe.json");
const FIXTURE3 = SAMPLES_DIR.div("text_writes3.aep");
const PROBE3 = SAMPLES_DIR.div("text_writes3_probe.json");

type ProbeJson = null | boolean | number | string | ProbeJson[] | { [key: string]: ProbeJson };
type TextWritesProbe = { ops: { [op_name: string]: { perChar: { [es_attr: string]: ProbeJson }[] } } };

/** Module-scoped fixture: computed on first use, then cached for the file. */
function cached<T>(load: () => T): () => T {
  let value: T | undefined;
  return () => {
    if (value === undefined) value = load();
    return value;
  };
}

// The pytest fixtures below are module-scoped in the Python suite, so each is
// loaded at most once per file and shared between tests.
const get_probe = cached(() => JSON.parse(PROBE.read_text("utf-8")));
const get_fixture_app = cached(() => parse_app_fresh(FIXTURE));
const get_probe2 = cached(() => JSON.parse(PROBE2.read_text("utf-8")));
const get_fixture2_app = cached(() => parse_app_fresh(FIXTURE2));
const get_probe3 = cached(() => JSON.parse(PROBE3.read_text("utf-8")));
const get_fixture3_app = cached(() => parse_app_fresh(FIXTURE3));

function _doc_for(app: Application, layer_name: string): TextDocument {
  const comp = app.project.compositions[0];
  const layer = comp.text_layers.find((ly) => ly.name === layer_name);
  if (layer === undefined) throw new StopIteration();
  const text = layer.text;
  py_assert(text != null);
  return text.source_text.value;
}

/**
 * A pristine single-run document (the fixture's untouched W_NOOP...
 *
 * ...layer is byte-equal to a freshly added text layer). Setting a
 * different base text goes through the py text setter, which collapses
 * runs exactly like AE's `addText` produces them.
 */
function _base_doc(base_text: string | null = null): [Application, TextDocument] {
  const app = parse_app_fresh(FIXTURE);
  const doc = _doc_for(app, "W_NOOP");
  if (base_text != null) doc.text = base_text;
  return [app, doc];
}

function _cos_path(node: CosNode, ...keys: (string | number)[]): CosNode {
  return keys.reduce<CosNode>((cur, key) => (typeof key === "number" ? cos_at(cur, key) : cos_item(cur, key)), node);
}

function _masked_bytes(cos_data: CosDict): Uint8Array {
  const clone = deepcopy(cos_data);
  for (const doc of cos_iter(py_or(cos_get_or(cos_get_or(clone, "1", new Map<string, CosNode>()), "1", []), []))) {
    const page = cos_dict(doc, "get").get("1");
    if (page instanceof Map) cos_pop(page, "2");
  }
  return serialize(clone);
}

/** The F1 invariant: `_char_style` must be the live first-run style. */
function _assert_alias_integrity(doc: TextDocument): void {
  const first = _cos_path(doc._doc, "0", "6", "0", 0, "0", "0", "6");
  expect<CosNode>(doc._char_style).toBe(first);
}

function _assert_byte_parity(py_doc: TextDocument, fixture_app: Application, op_name: string): void {
  const expected = _doc_for(fixture_app, op_name);
  py_assert(
    py_eq(_masked_bytes(py_doc._cos_data), _masked_bytes(expected._cos_data)),
    `${op_name}: py-written btdk diverges from the AE fixture ` +
      `(outside the masked /PC cache)`,
  );
}

const PER_CHAR_MAP: Record<string, string> = {
  fontSize: "font_size",
  applyFill: "apply_fill",
  applyStroke: "apply_stroke",
  justification: "justification",
  autoLeading: "auto_leading",
  fillColor: "fill_color",
  strokeColor: "stroke_color",
  leading: "leading",
  font: "font",
  kerning: "kerning",
  autoKernType: "auto_kern_type",
};

function _assert_per_char(py_doc: TextDocument, probe: TextWritesProbe, op_name: string, attrs: string[]): void {
  const expected_chars = probe["ops"][op_name]["perChar"];
  const n = len(py_doc.text);
  expect(n).toBe(expected_chars.length);
  for (const i of range(n)) {
    const rng = py_doc.character_range(i, i + 1);
    for (const es_attr of attrs) {
      const expected = expected_chars[i][es_attr];
      const actual = getattr(rng, PER_CHAR_MAP[es_attr]);
      if (expected === "<<undefined>>") {
        py_assert(actual == null, `${op_name}[${i}].${es_attr}: ${repr(actual)}`);
      } else if (Array.isArray(expected)) {
        py_assert(
          approx(actual, expected, { abs: 1e-5 }),
          `${op_name}[${i}].${es_attr}: expected ${repr(expected)}, got ${repr(actual)}`,
        );
      } else {
        py_assert(
          py_eq(actual, expected),
          `${op_name}[${i}].${es_attr}: expected ${repr(expected)}, got ${repr(actual)}`,
        );
      }
    }
  }
}

describe("TestScalarWrites", () => {
  test("test_split", () => {
    const fixture_app = get_fixture_app();
    const probe = get_probe();
    const [_app, doc] = _base_doc();
    doc.character_range(3, 7).font_size = 72;
    _assert_alias_integrity(doc);
    _assert_byte_parity(doc, fixture_app, "W_SPLIT");
    _assert_per_char(doc, probe, "W_SPLIT", ["fontSize"]);
  });

  test("test_adjacent_equal_writes_merge", () => {
    const fixture_app = get_fixture_app();
    const probe = get_probe();
    const [_app, doc] = _base_doc();
    doc.character_range(0, 5).font_size = 72;
    doc.character_range(5, 10).font_size = 72;
    _assert_alias_integrity(doc);
    // AE coalesced this into a single run covering the terminator.
    expect(cos_len(_cos_path(doc._doc, "0", "6", "0"))).toBe(1);
    _assert_byte_parity(doc, fixture_app, "W_MERGE_SAME");
    _assert_per_char(doc, probe, "W_MERGE_SAME", ["fontSize"]);
  });

  test("test_noop_write_keeps_structure", () => {
    const fixture_app = get_fixture_app();
    const probe = get_probe();
    const [_app, doc] = _base_doc();
    doc.character_range(2, 8).font_size = 36;
    _assert_alias_integrity(doc);
    expect(cos_len(_cos_path(doc._doc, "0", "6", "0"))).toBe(1);
    _assert_byte_parity(doc, fixture_app, "W_NOOP");
  });

  test("test_overlapping_equal_writes", () => {
    const fixture_app = get_fixture_app();
    const probe = get_probe();
    const [_app, doc] = _base_doc();
    doc.character_range(0, 5).font_size = 72;
    doc.character_range(3, 8).font_size = 72;
    _assert_alias_integrity(doc);
    _assert_byte_parity(doc, fixture_app, "W_PARTIAL_EQ");
    _assert_per_char(doc, probe, "W_PARTIAL_EQ", ["fontSize"]);
  });

  test("test_bool_write", () => {
    const fixture_app = get_fixture_app();
    const probe = get_probe();
    const [_app, doc] = _base_doc();
    doc.character_range(2, 6).apply_fill = false;
    _assert_alias_integrity(doc);
    _assert_byte_parity(doc, fixture_app, "W_FILL_UNAPPLY");
    _assert_per_char(doc, probe, "W_FILL_UNAPPLY", ["applyFill"]);
  });

  test("test_zero_span_write_is_noop", () => {
    const fixture_app = get_fixture_app();
    const probe = get_probe();
    const [_app, doc] = _base_doc();
    doc.character_range(3, 3).font_size = 90;
    _assert_byte_parity(doc, fixture_app, "W_ZERO_STYLE");
  });

  test("test_validation", () => {
    const [_app, doc] = _base_doc();
    raises(ValueError, () => {
      doc.character_range(0, 5).font_size = 0;
    });
    // Python raises AttributeError on assignment to a getter-only property;
    // strict-mode JS throws TypeError instead, so map it back.
    raises(AttributeError, () => {
      try {
        // @ts-expect-error font_object is read-only; the test checks the runtime refusal
        doc.character_range(0, 5).font_object = null;
      } catch (e) {
        if (e instanceof TypeError) throw new AttributeError(e.message);
        throw e;
      }
    });
  });
});

describe("TestColorFontLeadingWrites", () => {
  test("test_stroke_color_does_not_flip_gate", () => {
    const fixture_app = get_fixture_app();
    const probe = get_probe();
    const [_app, doc] = _base_doc();
    doc.character_range(2, 6).stroke_color = [0, 1, 0];
    _assert_byte_parity(doc, fixture_app, "W_STROKE_GATE");
    // AE leaves applyStroke off, so the gated read stays undefined.
    _assert_per_char(doc, probe, "W_STROKE_GATE", ["strokeColor", "applyStroke"]);
  });

  test("test_leading_disables_auto_leading", () => {
    const fixture_app = get_fixture_app();
    const probe = get_probe();
    const [_app, doc] = _base_doc();
    doc.character_range(1, 4).leading = 50;
    _assert_byte_parity(doc, fixture_app, "W_LEAD");
    _assert_per_char(doc, probe, "W_LEAD", ["leading", "autoLeading"]);
  });

  test("test_font_prepends_and_reindexes", () => {
    const fixture_app = get_fixture_app();
    const probe = get_probe();
    // The fixture embeds the version string AE resolved from the
    // host font; byte parity only holds where that font matches.
    const expected = _doc_for(fixture_app, "W_FONT");
    const fixture_version = dict_get(cos_dict(_cos_path(expected._cos_data, "0", "1", "0", 0, "0", "0"), "get"), "5");
    if (!py_eq(font_version_string("Arial-BoldMT"), fixture_version)) {
      return skip("Arial-BoldMT not installed at the fixture's version");
    }
    const [_app, doc] = _base_doc();
    doc.character_range(3, 7).font = "Arial-BoldMT";
    expect(doc._fonts.map((f) => f.post_script_name)[0]).toBe("Arial-BoldMT");
    _assert_byte_parity(doc, fixture_app, "W_FONT");
    _assert_per_char(doc, probe, "W_FONT", ["font"]);
  });

  test("test_existing_font_reuses_index", () => {
    const [_app, doc] = _base_doc();
    const before = doc._fonts.map((f) => f.post_script_name);
    doc.character_range(3, 7).font = before[0];
    expect(py_eq(doc._fonts.map((f) => f.post_script_name), before)).toBe(true);
  });

  test("test_fill_color_write_and_clear", () => {
    const [_app, doc] = _base_doc();
    doc.character_range(2, 6).fill_color = [1, 0, 0];
    expect(approx(doc.character_range(2, 6).fill_color, [1.0, 0.0, 0.0])).toBe(true);
    const other_fill = doc.character_range(0, 2).fill_color;
    // `None != approx(...)` is True in Python; pyrt approx cannot take null.
    expect(other_fill != null && approx(other_fill, [1.0, 0.0, 0.0])).toBe(false);
    doc.character_range(2, 6).fill_color = null;
    // Cleared paint: the gated read has applyFill runs but no color.
    expect(doc.character_range(2, 6).fill_color == null).toBe(true);
  });
});

describe("TestKerningWrites", () => {
  test("test_kern_mid_pair_shift", () => {
    const fixture_app = get_fixture_app();
    const probe = get_probe();
    const [_app, doc] = _base_doc("AVAWAYAVAW");
    doc.character_range(2, 5).kerning = 150;
    _assert_byte_parity(doc, fixture_app, "W_KERN_MID");
    _assert_per_char(doc, probe, "W_KERN_MID", ["kerning", "autoKernType"]);
  });

  test("test_kern_at_start_writes_leading_edge", () => {
    const fixture_app = get_fixture_app();
    const probe = get_probe();
    const [_app, doc] = _base_doc("AVAWAYAVAW");
    doc.character_range(0, 2).kerning = 150;
    expect(_cos_path(doc._doc, "0", "7")).toBe(150);
    expect(doc.kerning).toBe(150);
    _assert_byte_parity(doc, fixture_app, "W_KERN_START");
    _assert_per_char(doc, probe, "W_KERN_START", ["kerning", "autoKernType"]);
  });

  test("test_document_kerning_reads_leading_edge", () => {
    const fixture_app = get_fixture_app();
    expect(_doc_for(fixture_app, "W_KERN_START").kerning).toBe(150);
    expect(_doc_for(fixture_app, "W_KERN_MID").kerning).toBe(0);
  });

  test("test_auto_kern_type_clears_values", () => {
    const fixture2_app = get_fixture2_app();
    const probe2 = get_probe2();

    const [_app, doc] = _base_doc("AVAWAYAV");
    doc.character_range(1, 4).kerning = 200;
    doc.character_range(0, -1).auto_kern_type = AutoKernType.METRIC_KERN;
    expect(cos_contains(_cos_path(doc._doc, "0"), "8")).toBe(false);
    _assert_byte_parity(doc, fixture2_app, "X_AKT_SET");
    _assert_per_char(doc, probe2, "X_AKT_SET", ["kerning", "autoKernType"]);
  });

  test("test_auto_leading_resets_explicit_leading", () => {
    const fixture2_app = get_fixture2_app();
    const probe2 = get_probe2();
    const [_app, doc] = _base_doc("abcdefgh");
    doc.character_range(1, 4).leading = 50;
    doc.character_range(0, -1).auto_leading = true;
    // AE merges back to a single run with the leading sentinel.
    expect(cos_len(_cos_path(doc._doc, "0", "6", "0"))).toBe(1);
    _assert_byte_parity(doc, fixture2_app, "X_AL_SET");
    _assert_per_char(doc, probe2, "X_AL_SET", ["leading", "autoLeading"]);
  });
});

describe("TestParagraphWrites", () => {
  test("test_partial_range_styles_whole_paragraph", () => {
    const fixture_app = get_fixture_app();
    const probe = get_probe();
    const [_app, doc] = _base_doc("Left one\nRight two");
    doc.character_range(2, 5).justification = ParagraphJustification.RIGHT_JUSTIFY;
    _assert_byte_parity(doc, fixture_app, "W_PARA_PARTIAL");
    _assert_per_char(doc, probe, "W_PARA_PARTIAL", ["justification"]);
  });
});

describe("TestTextReplacement", () => {
  const _styled_base = (): [Application, TextDocument] => {
    const [app, doc] = _base_doc();
    doc.character_range(0, 5).fill_color = [1, 0, 0];
    doc.character_range(0, 5).font_size = 72;
    return [app, doc];
  };

  test("test_replace_shorter", () => {
    const fixture_app = get_fixture_app();
    const probe = get_probe();
    const [_app, doc] = _styled_base();
    const rng = doc.character_range(3, 7);
    rng.text = "XY";
    // The range keeps its creation indices against the new text.
    expect(rng.text).toBe("XYhi");
    _assert_byte_parity(doc, fixture_app, "W_TEXT_SHORTER");
    _assert_per_char(doc, probe, "W_TEXT_SHORTER", ["fontSize", "fillColor"]);
  });

  test("test_replace_longer", () => {
    const fixture_app = get_fixture_app();
    const probe = get_probe();
    const [_app, doc] = _styled_base();
    const rng = doc.character_range(3, 5);
    rng.text = "LONGERBIT";
    expect(rng.text).toBe("LO");
    _assert_byte_parity(doc, fixture_app, "W_TEXT_LONGER");
    _assert_per_char(doc, probe, "W_TEXT_LONGER", ["fontSize", "fillColor"]);
  });

  test("test_replace_adds_paragraph", () => {
    const fixture_app = get_fixture_app();
    const probe = get_probe();
    const [_app, doc] = _styled_base();
    doc.character_range(3, 5).text = "A\nB";
    expect(doc.paragraph_count).toBe(2);
    _assert_byte_parity(doc, fixture_app, "W_TEXT_ADDPARA");
  });

  test("test_zero_span_insert", () => {
    const fixture_app = get_fixture_app();
    const probe = get_probe();
    const [_app, doc] = _styled_base();
    const rng = doc.character_range(4, 4);
    rng.text = "ins";
    expect(rng.text).toBe("");
    expect(doc.text).toBe("abcdinsefghij");
    _assert_byte_parity(doc, fixture_app, "W_TEXT_INSERT");
    _assert_per_char(doc, probe, "W_TEXT_INSERT", ["fontSize", "fillColor"]);
  });

  test("test_replace_at_visible_end", () => {
    const fixture2_app = get_fixture2_app();
    const probe2 = get_probe2();
    const [_app, doc] = _base_doc();
    doc.character_range(0, 4).font_size = 72;
    doc.character_range(6, 10).text = "ZZ";
    expect(doc.text).toBe("abcdefZZ");
    _assert_byte_parity(doc, fixture2_app, "X_TEXT_END");
    _assert_per_char(doc, probe2, "X_TEXT_END", ["fontSize"]);
  });

  test("test_replace_splices_kern_values", () => {
    const fixture2_app = get_fixture2_app();
    const probe2 = get_probe2();
    const [_app, doc] = _base_doc("AVAWAYAV");
    doc.character_range(1, 4).kerning = 200;
    doc.character_range(2, 5).text = "xy";
    expect(doc.text).toBe("AVxyYAV");
    _assert_byte_parity(doc, fixture2_app, "X_TEXT_KERN");
    _assert_per_char(doc, probe2, "X_TEXT_KERN", ["kerning", "autoKernType"]);
  });
});

describe("TestPasteFrom", () => {
  test("test_paste_same_document", () => {
    const fixture_app = get_fixture_app();
    const probe = get_probe();
    const [_app, doc] = _base_doc();
    const src = doc.character_range(0, 3);
    src.fill_color = [1, 0, 0];
    src.font_size = 72;
    doc.character_range(6, 9).paste_from(doc.character_range(0, 3));
    _assert_byte_parity(doc, fixture_app, "W_PASTE_SAME");
    _assert_per_char(doc, probe, "W_PASTE_SAME", ["fontSize", "fillColor"]);
  });

  test("test_paste_cross_document_remaps_fonts", () => {
    const fixture_app = get_fixture_app();
    const probe = get_probe();
    const [app, doc] = _base_doc();
    const src_doc = _doc_for(app, "W_SPLIT");
    src_doc.text = "QQQQ";
    const src_all = src_doc.character_range(0, -1);
    src_all.font = "Arial-BoldMT";
    src_all.font_size = 90;
    doc.character_range(2, 6).paste_from(src_doc.character_range(0, 4));
    expect(doc.text).toBe("abQQQQghij");
    _assert_per_char(doc, probe, "W_PASTE_XDOC", ["fontSize", "font"]);
  });

  test("test_paste_shorter_invalidates_target", () => {
    const fixture_app = get_fixture_app();
    const probe = get_probe();
    const [app, doc] = _base_doc();
    const src_doc = _doc_for(app, "W_SPLIT");
    src_doc.text = "QQQQ";
    const src_all = src_doc.character_range(0, -1);
    src_all.font = "Arial-BoldMT";
    src_all.font_size = 90;
    const target = doc.character_range(2, 9);
    target.paste_from(src_doc.character_range(0, 2));
    expect(doc.text).toBe("abQQj");
    expect(target.is_range_valid).toBe(false);
    raises(ValueError, () => {
      const _ = target.text;
    });
  });

  test("test_paste_transplants_kern_values", () => {
    const fixture2_app = get_fixture2_app();
    const probe2 = get_probe2();
    const [app, doc] = _base_doc("abcdefgh");
    const src_doc = _doc_for(app, "W_SPLIT");
    src_doc.text = "AVAV";
    src_doc.character_range(1, 3).kerning = 150;
    doc.character_range(2, 6).paste_from(src_doc.character_range(0, 4));
    expect(doc.text).toBe("abAVAVgh");
    _assert_byte_parity(doc, fixture2_app, "X_PASTE_KERN");
    _assert_per_char(doc, probe2, "X_PASTE_KERN", ["kerning", "autoKernType"]);
  });

  test("test_transplanted_styles_differ_only_in_font_index", () => {
    const fixture_app = get_fixture_app();
    // W5 entry gate: the only doc-level index a transplanted style
    // carries is the font reference (key "0").
    const pasted = _doc_for(fixture_app, "W_PASTE_XDOC");
    const source = _doc_for(fixture_app, "PasteSrc");
    const pasted_style = cos_dict(_cos_path(pasted._doc, "0", "6", "0", 1, "0", "0", "6"), "get");
    const source_style = cos_dict(_cos_path(source._doc, "0", "6", "0", 0, "0", "0", "6"), "get");
    const keys = new Set<string>([...pasted_style.keys(), ...source_style.keys()]);
    const diff_keys = new Set(
      [...keys].filter((k) => !py_eq(dict_get(pasted_style, k), dict_get(source_style, k))),
    );
    expect([...diff_keys].every((k) => k === "0")).toBe(true);
  });
});

describe("TestPasteLeadingEdgeKern", () => {
  const _edge_source = (app: Application) => {
    const src_doc = _doc_for(app, "W_SPLIT");
    src_doc.text = "AVAV";
    src_doc.character_range(0, 2).kerning = 140;
    return src_doc;
  };

  test("test_paste_at_zero_keeps_leading_edge", () => {
    const fixture3_app = get_fixture3_app();
    const probe3 = get_probe3();
    const [app, doc] = _base_doc("abcdef");
    doc.character_range(0, 3).paste_from(_edge_source(app).character_range(0, 3));
    expect(_cos_path(doc._doc, "0", "7")).toBe(140);
    expect(doc.kerning).toBe(140);
    _assert_byte_parity(doc, fixture3_app, "Y_PASTE_EDGE0");
    const expected = probe3["ops"]["Y_PASTE_EDGE0"]["kernPerChar"].map((e: { value: ProbeJson }) => e["value"]);
    const actual = [...range(len(expected))].map((i) => [
      doc.character_range(i, i + 1).kerning,
      doc.character_range(i, i + 1).auto_kern_type,
    ]);
    for (const [got, exp] of zip(actual, expected)) {
      expect(got[0] ?? "<<undefined>>").toBe(exp[0]);
      expect(got[1]).toBe(exp[1]);
    }
  });

  test("test_paste_mid_maps_edge_to_preceding_pair", () => {
    const fixture3_app = get_fixture3_app();
    const probe3 = get_probe3();
    const [app, doc] = _base_doc("abcdef");
    doc.character_range(2, 5).paste_from(_edge_source(app).character_range(0, 3));
    expect(cos_contains(_cos_path(doc._doc, "0"), "7")).toBe(false);
    // The edge value lands on the pair before the paste (char 1) with
    // NO auto-kern flag change - ES reads it as undefined through the
    // flag, but the binary carries it (probed Y_PASTE_EDGE_MID). AE
    // merges that value run with its equal neighbor; py emits length-1
    // runs - value-identical, so compare decoded values, not bytes.

    expect(py_eq(_kern_values(doc).slice(0, 5), [null, 140, 140, 140, null])).toBe(true);
    const expected = probe3["ops"]["Y_PASTE_EDGE_MID"]["kernPerChar"].map((e: { value: ProbeJson }) => e["value"]);
    const actual = [...range(len(expected))].map((i) => [
      doc.character_range(i, i + 1).kerning,
      doc.character_range(i, i + 1).auto_kern_type,
    ]);
    for (const [got, exp] of zip(actual, expected)) {
      expect(got[0] ?? "<<undefined>>").toBe(exp[0]);
      expect(got[1]).toBe(exp[1]);
    }
  });
});

/** ES TextDocument getters read the FIRST CHARACTER's style on mixed
 * documents (probed Y_DOCREADS) - py's first-run getters match. */
describe("TestDocumentLevelReads", () => {
  test("test_mixed_document_reads_first_character", () => {
    const fixture3_app = get_fixture3_app();
    const probe3 = get_probe3();
    const doc = _doc_for(fixture3_app, "Y_DOCREADS");
    const expected = probe3["ops"]["Y_DOCREADS"]["docLevel"];
    expect(doc.font_size).toBe(expected["fontSize"]);
    expect(approx(doc.fill_color, expected["fillColor"], { abs: 1e-5 })).toBe(true);
    expect(doc.font).toBe(expected["font"]);
    expect(doc.faux_bold).toBe(expected["fauxBold"]);
    expect(doc.apply_stroke).toBe(expected["applyStroke"]);
    expect(doc.tracking).toBe(expected["tracking"]);
    expect(doc.kerning).toBe(expected["kerning"]);
    expect(doc.auto_leading).toBe(expected["autoLeading"]);
    expect(approx(doc.leading, expected["leading"], { abs: 1e-4 })).toBe(true);
  });

  test("test_leading_reads_first_character_auto_value", () => {
    const fixture3_app = get_fixture3_app();
    const probe3 = get_probe3();
    const doc = _doc_for(fixture3_app, "Y_DOCREAD_LEAD");
    const expected = probe3["ops"]["Y_DOCREAD_LEAD"];
    expect(approx(doc.leading, expected["leading"]["value"], { abs: 1e-4 })).toBe(true);
    expect(doc.auto_leading).toBe(expected["autoLeading"]["value"]);
  });
});

describe("TestSurrogateWrites", () => {
  test("test_mid_pair_write_expands", () => {
    // Value parity only: AE materialized an emoji fallback font into
    // the font array at composition, which py cannot reproduce.
    const probe = get_probe();
    const [_app, doc] = _base_doc("ab\u{1F600}cd");
    doc.character_range(2, 3).font_size = 72;
    // Per UTF-16 unit, like the ExtendScript probe (the emoji is 2 units).
    const expected = probe["ops"]["W_SURROGATE_STYLE"]["perChar"].map((c: { fontSize: ProbeJson }) => c["fontSize"]);
    const actual = [...range(len(expected))].map((i) => doc.character_range(i, i + 1).font_size);
    expect(py_eq(actual, expected)).toBe(true);
  });
});

describe("TestDocumentWideWrites", () => {
  test("test_cosfield_setter_collapses_runs", () => {
    const fixture_app = get_fixture_app();
    const probe = get_probe();
    const [_app, doc] = _base_doc();
    doc.character_range(0, 5).font_size = 72;
    doc.font_size = 50;
    expect(cos_len(_cos_path(doc._doc, "0", "6", "0"))).toBe(1);
    _assert_byte_parity(doc, fixture_app, "W_DOCLEVEL");
    _assert_per_char(doc, probe, "W_DOCLEVEL", ["fontSize"]);
  });

  test("test_custom_setter_styles_all_runs", () => {
    const fixture2_app = get_fixture2_app();
    const probe2 = get_probe2();
    const [_app, doc] = _base_doc("abcdefgh");
    doc.character_range(0, 4).font_size = 72;
    doc.fill_color = [0, 0, 1];
    _assert_byte_parity(doc, fixture2_app, "X_DOC_FILL");
    _assert_per_char(doc, probe2, "X_DOC_FILL", ["fillColor", "fontSize"]);
  });

  test("test_paragraph_setter_styles_all_paragraphs", () => {
    const fixture2_app = get_fixture2_app();
    const probe2 = get_probe2();
    const [_app, doc] = _base_doc("One two\nThree four");
    doc.justification = ParagraphJustification.CENTER_JUSTIFY;
    _assert_byte_parity(doc, fixture2_app, "X_DOC_JUST");
    _assert_per_char(doc, probe2, "X_DOC_JUST", ["justification"]);
  });

  test("test_auto_leading_resets_sentinel_document_wide", () => {
    const [_app, doc] = _base_doc();
    doc.character_range(1, 4).leading = 50;
    doc.auto_leading = true;
    expect(cos_len(_cos_path(doc._doc, "0", "6", "0"))).toBe(1);
    expect(py_eq(cos_item(doc._char_style, "5"), 0.01)).toBe(true);
  });
});

describe("TestRoundTripAfterWrite", () => {
  test("test_mutated_save_is_idempotent", () => {
    const tmp_path = make_tmp_path();
    const [app, doc] = _base_doc();
    doc.character_range(3, 7).font_size = 72;
    const first = tmp_path.div("first.aep");
    app.project.save(first);
    const app2 = parse_app_fresh(first);
    const second = tmp_path.div("second.aep");
    app2.project.save(second);
    expect(py_eq(first.read_bytes(), second.read_bytes())).toBe(true);
  });

  test("test_document_getter_tracks_first_run_after_writes", () => {
    // After splits and merges, document-level getters (which alias the
    // first run's style dict) must keep reading char 0's actual style.
    const [_app, doc] = _base_doc();
    doc.character_range(3, 7).font_size = 72;
    expect(doc.font_size).toBe(36.0);
    doc.character_range(0, 3).font_size = 72;
    expect(doc.font_size).toBe(72.0);
  });
});
