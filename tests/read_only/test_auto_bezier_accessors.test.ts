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
import { dict_get, Path, py_assert, py_bool, py_or, tkey, zip } from "../../src/pyrt/index.ts";
import { approx } from "../../src/pyrt/pytest.ts";
import { parse as parse_aep } from "../../src/py_aep/index.ts";
import type { Property } from "../../src/py_aep/models/properties/property.ts";
import type { CompItem } from "../../src/py_aep/models/items/composition.ts";
import { load_expected } from "../helpers.ts";

const VERSIONS_DIR = new Path(import.meta.dir).parent.parent.div("samples", "versions");

/** Every keyframed property in `comp`, paired with its layer's name. */
function* _keyed(comp: CompItem): Generator<[string, Property]> {
  for (const layer of comp.layers) {
    for (const prop of layer._leaf_properties()) {
      if (py_bool(prop.keyframes)) {
        yield [layer.name, prop];
      }
    }
  }
}

/** The fields of the exported JSON this test reads. */
interface JsonEase {
  speed: number;
  influence: number;
}
interface JsonKeyframe {
  spatialAutoBezier?: boolean;
  temporalAutoBezier?: boolean;
  inSpatialTangent: number[];
  outSpatialTangent: number[];
  inTemporalEase: JsonEase[];
  outTemporalEase: JsonEase[];
}
interface JsonProperty {
  matchName: string;
  numKeys?: number;
  properties?: JsonProperty[] | null;
  keyframes?: JsonKeyframe[] | null;
}
interface JsonDocument {
  items: { name: string; layers?: { name: string; properties?: JsonProperty[] | null }[] | null }[];
}

function* _json_properties(document: JsonDocument): Generator<[string, string, JsonProperty]> {
  const walk = (prop: JsonProperty, out: JsonProperty[]): void => {
    if (py_bool(prop.numKeys ?? null)) {
      out.push(prop);
    }
    for (const child of py_or(prop.properties ?? null, [])) {
      walk(child, out);
    }
  };

  for (const item of "items" in document ? document.items : []) {
    for (const layer of py_or(item.layers ?? null, [])) {
      const found: JsonProperty[] = [];
      for (const group of py_or(layer.properties ?? null, [])) {
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
    const expected = load_expected(VERSIONS_DIR.div(version), "complete");
    const app = parse_aep(aep);

    const parsed = new Map<string, Property>();
    for (const comp of app.project.compositions) {
      for (const [layer_name, prop] of _keyed(comp)) {
        parsed.set(tkey(comp.name, layer_name, prop.match_name), prop);
      }
    }

    let compared = 0;
    for (const [comp_name, layer_name, json_prop] of _json_properties(expected)) {
      const key = tkey(comp_name, layer_name, json_prop.matchName);
      const prop = dict_get(parsed, key);
      if (prop == null) continue;
      const keys = py_or(json_prop.keyframes ?? null, []);
      if (keys.length !== prop.keyframes.length) continue;
      for (const [json_key, keyframe] of zip(keys, prop.keyframes)) {
        if (py_bool(json_key.spatialAutoBezier ?? null)) {
          compared += 1;
          expect(approx(keyframe.in_spatial_tangent, json_key.inSpatialTangent, { abs: 0.001 })).toBe(true);
          expect(approx(keyframe.out_spatial_tangent, json_key.outSpatialTangent, { abs: 0.001 })).toBe(true);
        }
        if (py_bool(json_key.temporalAutoBezier ?? null)) {
          compared += 1;
          for (const [ease, json_ease] of zip(keyframe.in_temporal_ease, json_key.inTemporalEase)) {
            expect(approx(ease.speed, json_ease.speed, { abs: 0.001 })).toBe(true);
            expect(approx(ease.influence, json_ease.influence, { abs: 0.001 })).toBe(true);
          }
          for (const [ease, json_ease] of zip(keyframe.out_temporal_ease, json_key.outTemporalEase)) {
            expect(approx(ease.speed, json_ease.speed, { abs: 0.001 })).toBe(true);
            expect(approx(ease.influence, json_ease.influence, { abs: 0.001 })).toBe(true);
          }
        }
      }
    }

    py_assert(compared, `${version} exercised no auto-bezier keyframe`);
  },
);
