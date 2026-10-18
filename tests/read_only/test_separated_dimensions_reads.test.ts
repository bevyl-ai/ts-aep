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
import { AssertionError_, Path, getitem, pyAssert, pyOr, range } from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { asInstance, getLayerFromJson, loadExpected, parseProject, type ExpectedProperty } from "../helpers.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";

const SAMPLES_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "property");

/** `{matchName: property dict}` for the first layer's transform group. */
function _expectedTransform(sample: string): Map<string, ExpectedProperty> {
  const layer = getLayerFromJson(loadExpected(SAMPLES_DIR, sample));
  for (const group of pyOr(layer.properties, [])) {
    if (group.matchName === "ADBE Transform Group") {
      return new Map(pyOr(group.properties, []).map((child) => [child.matchName, child]));
    }
  }
  throw new AssertionError_(`no transform group in ${sample}.json`);
}

test.each(["transform_unseparated", "transform_separated", "keyframe_separated_dimensions"])(
  "test_position_reads_match_extendscript[%#]",
  (sample: string) => {
    const expected = _expectedTransform(sample);
    const layer = parseProject(SAMPLES_DIR.div(`${sample}.aep`)).compositions[0].layers[0];

    for (const matchName of ["ADBE Position", "ADBE Position_0", "ADBE Position_1", "ADBE Position_2"]) {
      const prop = asInstance(layer.transform.property(matchName), Property);
      const wanted = getitem(expected, matchName);
      pyAssert(approx(prop.value, wanted.value), matchName);
      pyAssert(prop.canSetExpression === wanted.canSetExpression, matchName);
    }
  },
);

test("test_separated_leader_composes_from_its_followers", () => {
  /**
   * The stored leader value is the comp centre (100, 100 on this 200x200
   * comp); AE reports the followers' composite, [0, 200, 0].
   */
  const comp = parseProject(SAMPLES_DIR.div("keyframe_separated_dimensions.aep")).compositions[0];
  const position = comp.layers[0].transform.property("ADBE Position");
  expect(position.dimensionsSeparated).toBe(true);

  const stored = position._readCdatRaw();
  expect(approx(stored, [comp.width / 2, comp.height / 2, 0.0])).toBe(true);
  expect(approx(position.value, [0.0, 200.0, 0.0])).toBe(true);
});

test("test_expressibility_moves_to_the_followers_when_separated", () => {
  const layer = parseProject(SAMPLES_DIR.div("transform_separated.aep")).compositions[0].layers[0];
  const position = layer.transform.property("ADBE Position");
  expect(position.dimensionsSeparated).toBe(true);

  expect(position.canSetExpression).toBe(false);
  expect(layer.transform.property("ADBE Position_0").canSetExpression).toBe(true);
  expect(layer.transform.property("ADBE Position_1").canSetExpression).toBe(true);
  // Z stays unexpressionable on a 2D layer.
  expect(layer.transform.property("ADBE Position_2").canSetExpression).toBe(false);
});

test("test_unseparated_keeps_expressibility_on_the_leader", () => {
  const layer = parseProject(SAMPLES_DIR.div("transform_unseparated.aep")).compositions[0].layers[0];
  expect(layer.transform.property("ADBE Position").canSetExpression).toBe(true);
  for (const dimension of range(3)) {
    const follower = asInstance(layer.transform.property(`ADBE Position_${dimension}`), Property);
    expect(follower.canSetExpression).toBe(false);
  }
});
