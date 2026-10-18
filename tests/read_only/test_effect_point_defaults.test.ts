/**
 * Effect point defaults, read from PF_PointDef's dephault (AE 2026).
 *
 * `effect_point_defaults.aep` holds three 800x600 comps:
 *
 * - `edited_above` / `edited_below`: a Gradient Ramp whose End of Ramp and
 *   Ramp Shape were edited on a 400x300 solid, and an untouched one on a
 *   400x600 solid, in both stacking orders - the later instance of the effect
 *   borrows the other's definitions, whose last values are the other's.
 * - `points`: an untouched Lens Flare on a 200x100 solid (Flare Center 40/40
 *   percent) and 3D Point Control on a 300x200 solid (50/50/0).
 */

import { test, expect } from "bun:test";

import { Path, StopIteration, contains, getitem, pyBool, pyAssert } from "../../src/pyrt/index.ts";
import { approx } from "../../src/pyrt/pytest.ts";
import { getComp, getCompFromJsonByName, loadExpected, parseProject } from "../conftest.ts";
import { asInstance, jsonField, type ExpectedProperty } from "../helpers.ts";

import { PropertyControlType } from "../../src/py_aep/enums/index.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";

// Python: Path(__file__).parent.parent.parent / "samples" / ...
const SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models", "property");
const SAMPLE = "effect_point_defaults";

const _CASES: [string, string][] = [
  ["edited_above", "ramp edited"],
  ["edited_above", "ramp untouched"],
  ["edited_below", "ramp edited"],
  ["edited_below", "ramp untouched"],
  ["points", "flare untouched"],
  ["points", "point3d untouched"],
];

function _effectProps(compName: string, layerName: string): Property[] {
  const comp = getComp(parseProject(SAMPLES_DIR.div(`${SAMPLE}.aep`)), compName);
  const layer = comp.layers.find((ly) => ly.name === layerName);
  if (layer === undefined) throw new StopIteration();
  pyAssert(layer.effects != null);
  return asInstance(layer.effects.property(0), PropertyGroup).properties.filter(
    (p): p is Property => p instanceof Property,
  );
}

function _expectedProps(compName: string, layerName: string): Map<string, ExpectedProperty> {
  const comp = getCompFromJsonByName(loadExpected(SAMPLES_DIR, SAMPLE), compName);
  const layer = comp.layers.find((ly) => ly.name === layerName);
  if (layer === undefined) throw new StopIteration();
  const parade = layer.properties.find((p) => p.matchName === "ADBE Effect Parade");
  if (parade === undefined) throw new StopIteration();
  return new Map(jsonField(jsonField(parade, "properties")[0], "properties").map((p) => [p.matchName, p]));
}

test.each(_CASES)("test_points_and_popups_match_json[%#]", (compName: string, layerName: string) => {
  const expected = _expectedProps(compName, layerName);
  let checked = 0;
  for (const prop of _effectProps(compName, layerName)) {
    if (
      !contains(
        [PropertyControlType.TWO_D, PropertyControlType.THREE_D, PropertyControlType.ENUM],
        prop._property_control_type,
      )
    ) {
      continue;
    }
    const propJson = getitem(expected, prop.matchName);
    // NOTE(port): Python's `, prop.name` is only a failure message; bun's expect has no message arg, pass/fail is identical.
    expect(approx(prop.value, propJson.value)).toBe(true);
    expect(prop.isModified).toBe(propJson.isModified);
    checked += 1;
  }
  expect(pyBool(checked)).toBe(true);
});

test.each([
  // 50/100 percent of the edited ramp's own 400x300 layer, not the
  // untouched one's.
  ["edited_above", "ramp edited", "ADBE Ramp-0003", [200.0, 300.0]],
  ["edited_below", "ramp edited", "ADBE Ramp-0003", [200.0, 300.0]],
  ["edited_above", "ramp untouched", "ADBE Ramp-0003", [200.0, 600.0]],
  // 40 percent exactly: the last value read 39.9994.
  ["points", "flare untouched", "ADBE Lens Flare-0001", [80.0, 40.0]],
  ["points", "point3d untouched", "ADBE Point3D Control-0001", [150, 100, 0]],
])(
  "test_point_default_is_a_percentage_of_the_layer[%#]",
  (compName: string, layerName: string, matchName: string, default_: number[]) => {
    const prop = _effectProps(compName, layerName).find((p) => p.matchName === matchName);
    if (prop === undefined) throw new StopIteration();
    expect(approx(prop.defaultValue, default_, { abs: 1e-9 })).toBe(true);
  },
);

test.each<[string, number[]]>([
  ["normal", [100.0, 50.0]],
  ["adjustment", [960.0, 540.0]],
])(
  "test_adjustment_layer_point_is_a_percentage_of_the_comp[%#]",
  /**
   * `effect_point_adjustment.aep`: a Transform effect whose Anchor Point
   * and Position AE 2026 set to 30,40 and 10,20 by script on two 200x100
   * solids of a 1920x1080 comp, one of them an adjustment layer. AE stores
   * the adjustment layer's points against the comp, and centres their
   * defaults on it.
   */
  (layerName, center) => {
    const comp = getComp(parseProject(SAMPLES_DIR.div("effect_point_adjustment.aep")), "coverage");
    const layer = comp.layers.find((ly) => ly.name === layerName);
    if (layer === undefined) throw new StopIteration();
    pyAssert(layer.effects != null);
    const transform = asInstance(layer.effects.property("ADBE Geometry2"), PropertyGroup);
    const points: [string, number[]][] = [
      ["ADBE Geometry2-0001", [30.0, 40.0]],
      ["ADBE Geometry2-0002", [10.0, 20.0]],
    ];
    for (const [matchName, value] of points) {
      const prop = asInstance(transform.property(matchName), Property);
      expect(approx(prop.value, value)).toBe(true);
      expect(approx(prop.defaultValue, center)).toBe(true);
    }
  },
);
