/**
 * Composer parity against the box-matrix fixture.
 *
 * `samples/models/text/box_matrix.aep` holds ~45 box-text layers generated
 * by `scripts/jsx/generate_box_matrix_sample.jsx`, sweeping the composition
 * parameter space. For every in-envelope layer the composer must reproduce
 * AE's persisted line spans and baselines exactly; every out-of-envelope
 * layer must be refused, never guessed.
 */

// `from __future__ import annotations` and the `dict[...]` annotations are
// dropped. `pytest.importorskip("uharfbuzz")` has no direct twin: the composer
// is expected to run on harfbuzzjs, so the import is assumed present.
// NOTE(port): importorskip only skips when uharfbuzz is absent; harfbuzzjs is a hard dependency, so the skip can never fire.

import { expect, test } from "bun:test";
import { Path, getOrThrow, assert, truthy, valueEquals, repr, zip } from "../../src/pyrt/index.ts";

import "../../src/py_aep/binary/_register.ts";
import { parseProject } from "../helpers.ts";
import type { CosNode } from "../../src/py_aep/cos/cos.ts";
import type { TextDocument } from "../../src/py_aep/models/text/text_document.ts";
import { _cachedLineData } from "../../src/py_aep/models/text/ranges.ts";
import { CompositionUnsupported, _CharStyle, _shapeStretch, composeLines } from "../../src/py_aep/resolvers/text_composition.ts";
import { resolvePostscript } from "../../src/py_aep/svg/fonts.ts";
import { raises } from "../support/pytest.ts";
import { format } from "../support/python.ts";

// Python `Path(__file__).parent.parent.parent` is the repo root. A TS file's
// `import.meta.dir` is already its directory, so two `.parent` steps reach it.
const SAMPLES_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "text");
const FIXTURE = SAMPLES_DIR.div("box_matrix.aep");

/**
 * PostScript names the matrix layers' style runs compose with; CI
 * runners without them (e.g. ubuntu-latest) cannot exercise parity.
 */
const FIXTURE_FONTS = [
  "MyriadPro-Regular",
  "ArialMT",
  "Arial-BoldMT",
  "TimesNewRomanPSMT",
  "CourierNewPSMT",
];

// Python `pytest.skip(..., allow_module_level=True)` skips the whole module.
// Each test carries the same skip condition here.
const moduleSkip = !FIXTURE_FONTS.every((name) => resolvePostscript(name) != null);

/**
 * Layers the composer must refuse (unsupported features). Auto-hyphenate
 * is deliberately NOT here: it is AE's default and inert for the
 * single-line composer (M_HYPHENATE composes greedily like every other
 * layer).
 */
const REFUSED = new Map<string, string>([
  ["M_ELC", "every-line composer"],
  ["M_OPTICAL", "optical"],
  ["M_TAB", "tab"],
  ["M_LIGA", "ligatures"],
  ["M_VERTICAL", "vertical"],
  ["M_RTL", "right-to-left"],
  ["M_NBSP", "no-break space"],
]);

// Module-scoped fixtures: parsed once and cached for every test in this file.
const _cache: { docs?: Map<string, TextDocument> } = {};

/** `@pytest.fixture(scope="module") def docs()`: layer name -> source text. */
function docsFixture(): Map<string, TextDocument> {
  if (_cache.docs === undefined) {
    const project = parseProject(FIXTURE);
    const comp = project.compositions[0];
    _cache.docs = new Map(
      comp.textLayers.map((layer) => {
        const text = layer.text;
        assert(text != null);
        return [layer.name, text.sourceText.value] as const;
      }),
    );
  }
  return _cache.docs;
}

test.skipIf(moduleSkip)("test_every_matrix_layer_composes_or_refuses", () => {
  const docs = docsFixture();
  const mismatches: string[] = [];
  let composedCount = 0;
  for (const [name, doc] of docs) {
    if (REFUSED.has(name)) {
      raises(CompositionUnsupported, () => {
        composeLines(doc);
      });
      continue;
    }
    const cached = _cachedLineData(doc);
    assert(cached != null, name);
    const [cachedSpans, cachedBaselines] = cached;
    let composed;
    try {
      composed = composeLines(doc);
    } catch (exc) {
      if (!(exc instanceof CompositionUnsupported)) throw exc;
      mismatches.push(`${name}: refused: ${exc.message}`);
      continue;
    }
    if (!valueEquals(composed.spans, cachedSpans)) {
      mismatches.push(
        `${name}: spans ${repr(composed.spans.slice(0, 3))}... != ${repr(cachedSpans.slice(0, 3))}...`,
      );
      continue;
    }
    for (const [computed, expected] of zip(composed.baselines, cachedBaselines)) {
      if (expected != null && Math.abs(computed - expected) > 0.05) {
        mismatches.push(`${name}: baseline ${format(computed, ".4f")} != ${format(expected, ".4f")}`);
        break;
      }
    }
    composedCount += 1;
  }
  assert(!truthy(mismatches), mismatches.join("\n"));
  // The matrix must keep exercising the full in-envelope surface.
  expect(composedCount >= 37).toBe(true);
});

test.skipIf(moduleSkip)("test_refusal_reasons_are_specific", () => {
  const docs = docsFixture();
  for (const [name, needle] of REFUSED) {
    raises(
      CompositionUnsupported,
      () => {
        composeLines(getOrThrow(docs, name));
      },
      needle,
    );
  }
});

test.skipIf(moduleSkip)("test_overflow_matches_probe", () => {
  const docs = docsFixture();
  // The height-sweep layers overflow (600px of text in small boxes).
  for (const name of ["M_H40", "M_H55", "M_H70", "M_H90", "M_H120"]) {
    expect(composeLines(getOrThrow(docs, name)).overflow).toBe(true);
  }
  expect(composeLines(getOrThrow(docs, "M_W300")).overflow).toBe(false);
});

test.skipIf(moduleSkip)("test_length_changing_case_map_is_refused", () => {
  // 'straße'.upper() == 'STRASSE': clusters no longer map 1:1 onto the
  // source characters, so both caps modes must refuse, not crash.
  for (const caps of [1, 2]) {
    const style = new _CharStyle("ArialMT", new Map<string, CosNode>([["1", 36.0], ["12", caps]]));
    raises(
      CompositionUnsupported,
      () => {
        _shapeStretch("straße", style);
      },
      "case mapping",
    );
  }
});
