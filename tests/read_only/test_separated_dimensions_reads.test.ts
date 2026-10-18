/**
 * Reads on a dimension-separated Position must match ExtendScript.
 *
 * While `dimensionsSeparated` is on, AE drives the layer from the X / Y / Z
 * followers and resets the leader's own stored value to the comp-centre
 * default, so reading that value reports the default rather than the position.
 * Expressibility moves the same way: the leader refuses an expression and the
 * followers accept one.
 *
 * Every expectation is taken from the matching `.json` ExtendScript export.
 */

import { expect, test } from "bun:test";
import { approx } from "../../src/pyrt/pytest.ts";
import { AssertionError_, Path, getitem, py_assert, py_or, range } from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { as_instance, get_layer_from_json, load_expected, parse_project, type ExpectedProperty } from "../helpers.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";

const SAMPLES_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "property");

/** `{matchName: property dict}` for the first layer's transform group. */
function _expected_transform(sample: string): Map<string, ExpectedProperty> {
  const layer = get_layer_from_json(load_expected(SAMPLES_DIR, sample));
  for (const group of py_or(layer.properties, [])) {
    if (group.matchName === "ADBE Transform Group") {
      return new Map(py_or(group.properties, []).map((child) => [child.matchName, child]));
    }
  }
  throw new AssertionError_(`no transform group in ${sample}.json`);
}

test.each(["transform_unseparated", "transform_separated", "keyframe_separated_dimensions"])(
  "test_position_reads_match_extendscript[%#]",
  (sample: string) => {
    const expected = _expected_transform(sample);
    const layer = parse_project(SAMPLES_DIR.div(`${sample}.aep`)).compositions[0].layers[0];

    for (const match_name of ["ADBE Position", "ADBE Position_0", "ADBE Position_1", "ADBE Position_2"]) {
      const prop = as_instance(layer.transform.property(match_name), Property);
      const wanted = getitem(expected, match_name);
      py_assert(approx(prop.value, wanted.value), match_name);
      py_assert(prop.can_set_expression === wanted.canSetExpression, match_name);
    }
  },
);

test("test_separated_leader_composes_from_its_followers", () => {
  /**
   * The stored leader value is the comp centre (100, 100 on this 200x200
   * comp); AE reports the followers' composite, [0, 200, 0].
   */
  const comp = parse_project(SAMPLES_DIR.div("keyframe_separated_dimensions.aep")).compositions[0];
  const position = comp.layers[0].transform.property("ADBE Position");
  expect(position.dimensions_separated).toBe(true);

  const stored = position._read_cdat_raw();
  expect(approx(stored, [comp.width / 2, comp.height / 2, 0.0])).toBe(true);
  expect(approx(position.value, [0.0, 200.0, 0.0])).toBe(true);
});

test("test_expressibility_moves_to_the_followers_when_separated", () => {
  const layer = parse_project(SAMPLES_DIR.div("transform_separated.aep")).compositions[0].layers[0];
  const position = layer.transform.property("ADBE Position");
  expect(position.dimensions_separated).toBe(true);

  expect(position.can_set_expression).toBe(false);
  expect(layer.transform.property("ADBE Position_0").can_set_expression).toBe(true);
  expect(layer.transform.property("ADBE Position_1").can_set_expression).toBe(true);
  // Z stays unexpressionable on a 2D layer.
  expect(layer.transform.property("ADBE Position_2").can_set_expression).toBe(false);
});

test("test_unseparated_keeps_expressibility_on_the_leader", () => {
  const layer = parse_project(SAMPLES_DIR.div("transform_unseparated.aep")).compositions[0].layers[0];
  expect(layer.transform.property("ADBE Position").can_set_expression).toBe(true);
  for (const dimension of range(3)) {
    const follower = as_instance(layer.transform.property(`ADBE Position_${dimension}`), Property);
    expect(follower.can_set_expression).toBe(false);
  }
});
