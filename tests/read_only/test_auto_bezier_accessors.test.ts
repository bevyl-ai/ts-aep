/**
 * Auto-bezier tangent / ease accessors must agree with AE for real files.
 *
 * `samples/versions/ae2018/complete.aep` is the regression fixture: its stored
 * tangents are stale on one keyframe and zero on another, while AE's own
 * ExtendScript reports chord/6 for all five. Reading the chunk back verbatim
 * produced seven `aep-validate` differences that nothing tracked.
 */

// `from __future__ import annotations`, `typing` and the `Iterator` alias are
// dropped: annotations only. `Path(__file__).parent.parent.parent` (repo root)
// is `import.meta.dir` (this file's directory) with two `.parent` steps.
// `pytest.approx` is the pyrt `approx` (pytest.ts), not an index re-export.

import { expect, test } from "bun:test";
import { dictGet, Path, pyAssert, pyBool, pyOr, tkey, zip } from "../../src/pyrt/index.ts";
import { approx } from "../../src/pyrt/pytest.ts";
import { parse as parseAep } from "../../src/py_aep/index.ts";
import type { Property } from "../../src/py_aep/models/properties/property.ts";
import type { CompItem } from "../../src/py_aep/models/items/composition.ts";
import { loadExpected, type ExpectedProject, type ExpectedProperty } from "../helpers.ts";

const VERSIONS_DIR = new Path(import.meta.dir).parent.parent.div("samples", "versions");

/** Every keyframed property in `comp`, paired with its layer's name. */
function* _keyed(comp: CompItem): Generator<[string, Property]> {
  for (const layer of comp.layers) {
    for (const prop of layer._leafProperties()) {
      if (pyBool(prop.keyframes)) {
        yield [layer.name, prop];
      }
    }
  }
}

function* _jsonProperties(document: ExpectedProject): Generator<[string, string, ExpectedProperty]> {
  const walk = (prop: ExpectedProperty, out: ExpectedProperty[]): void => {
    if (pyBool(prop.numKeys ?? null)) {
      out.push(prop);
    }
    for (const child of pyOr(prop.properties ?? null, [])) {
      walk(child, out);
    }
  };

  for (const item of "items" in document ? document.items : []) {
    for (const layer of pyOr("layers" in item ? item.layers : null, [])) {
      const found: ExpectedProperty[] = [];
      for (const group of pyOr(layer.properties ?? null, [])) {
        walk(group, found);
      }
      for (const prop of found) {
        yield ["name" in item ? item.name : "", "name" in layer ? layer.name : "", prop];
      }
    }
  }
}

/** Every auto-bezier keyframe's tangents and ease must equal what AE
 * reported for the same file. */
test.each(["ae2018", "ae2022", "ae2023", "ae2026"])(
  "test_auto_bezier_accessors_match_extendscript[%#]",
  (version: string) => {
    const aep = VERSIONS_DIR.div(version, "complete.aep");
    const expected = loadExpected(VERSIONS_DIR.div(version), "complete");
    const app = parseAep(aep);

    const parsed = new Map<string, Property>();
    for (const comp of app.project.compositions) {
      for (const [layerName, prop] of _keyed(comp)) {
        parsed.set(tkey(comp.name, layerName, prop.matchName), prop);
      }
    }

    let compared = 0;
    for (const [compName, layerName, jsonProp] of _jsonProperties(expected)) {
      const key = tkey(compName, layerName, jsonProp.matchName);
      const prop = dictGet(parsed, key);
      if (prop == null) continue;
      const keys = pyOr(jsonProp.keyframes ?? null, []);
      if (keys.length !== prop.keyframes.length) continue;
      for (const [jsonKey, keyframe] of zip(keys, prop.keyframes)) {
        if (pyBool(jsonKey.spatialAutoBezier ?? null)) {
          compared += 1;
          expect(approx(keyframe.inSpatialTangent, jsonKey.inSpatialTangent, { abs: 0.001 })).toBe(true);
          expect(approx(keyframe.outSpatialTangent, jsonKey.outSpatialTangent, { abs: 0.001 })).toBe(true);
        }
        if (pyBool(jsonKey.temporalAutoBezier ?? null)) {
          compared += 1;
          for (const [ease, jsonEase] of zip(keyframe.inTemporalEase, jsonKey.inTemporalEase)) {
            expect(approx(ease.speed, jsonEase.speed, { abs: 0.001 })).toBe(true);
            expect(approx(ease.influence, jsonEase.influence, { abs: 0.001 })).toBe(true);
          }
          for (const [ease, jsonEase] of zip(keyframe.outTemporalEase, jsonKey.outTemporalEase)) {
            expect(approx(ease.speed, jsonEase.speed, { abs: 0.001 })).toBe(true);
            expect(approx(ease.influence, jsonEase.influence, { abs: 0.001 })).toBe(true);
          }
        }
      }
    }

    pyAssert(compared, `${version} exercised no auto-bezier keyframe`);
  },
);
