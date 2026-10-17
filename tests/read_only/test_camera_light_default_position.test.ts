/**
 * Tests for a camera or light Position at its default (AE 2026 ground truth).
 *
 * After Effects leaves a camera or light Position that sits at its default out
 * of the file. A camera's default is `[w/2, h/2, -zoom]`, `zoom` its own Zoom at
 * the layer's time 0; a light's is `[w/2 + 0.03 z, h/2 - 0.03 z, -z/4]`, `z`
 * the comp's default camera zoom. The X / Y / Z separation followers default to
 * the leader's components, so separating a Position left at its default reads
 * all three unmodified.
 *
 * `camera_default_position.aep`: each 1440x810 comp holds a two-node camera
 * whose Zoom was set to 1000 (the comp's default is 2000) and whose Position
 * was then set to [720, 405, -1000], which AE drops, except in `moved`
 * ([720, 405, -2600]). `zoom_keyed` keys the Zoom from 1000 to 3000 afterwards
 * and `zoom_1000_separated` separates the dropped Position.
 *
 * `light_default_position.aep`: one comp per size and pixel aspect, each holding
 * every light type reset to its default Position (Layer > Transform > Reset),
 * plus a Point light whose default Position was then separated. A scripted
 * `addLight` does not place a light there, so the reset is what pins it. The
 * layer named `Environment` is an Ambient light (its ExtendScript JSON reports
 * `lightType` Ambient); `light_source_default.aep` holds an Environment one.
 */

// `from __future__ import annotations` is dropped: no annotation here is
// evaluated at runtime. `pytest.approx` is pyrt `approx` (pytest.ts) and the
// `Path(__file__).parent...` sample lookups become `import.meta.dir`, where
// two `.parent` steps reach the package root. Stacked `parametrize` decorators
// become the cartesian rows built below.

import { describe, expect, test } from "bun:test";
import { approx } from "../../src/pyrt/pytest.ts";
import { getitem, Path, py_assert, range } from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { get_comp, get_comp_from_json_by_name, load_expected, parse_project } from "../conftest.ts";
import type { Layer } from "../../src/py_aep/models/layers/index.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";

const SAMPLES_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "layer");
const VIEW_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "view");

const _POSITION_MATCH_NAMES: readonly string[] = [
  "ADBE Position",
  "ADBE Position_0",
  "ADBE Position_1",
  "ADBE Position_2",
];

const _CAMERA_COMPS = ["moved", "zoom_1000", "zoom_1000_separated", "zoom_keyed"];
const _LIGHT_COMPS = [
  "1920x1080",
  "1440x1620",
  "2880x810",
  "810x1440",
  "1920x1080_par2",
  "1440x810_par05",
];
const _LIGHT_LAYERS = [
  "Point",
  "Spot",
  "Parallel",
  "Ambient",
  "Environment",
  "Point Separated",
];
// pytest: the decorator nearest the function (comp_name) varies fastest.
const _LIGHT_ROWS: string[][] = _LIGHT_LAYERS.flatMap((layer_name) =>
  _LIGHT_COMPS.map((comp_name) => [comp_name, layer_name]),
);

function _layer(sample: string, comp_name: string, layer_name: string): Layer {
  const comp = get_comp(parse_project(SAMPLES_DIR.div(`${sample}.aep`)), comp_name);
  return comp.layers.find((layer) => layer.name === layer_name)!;
}

function _position(layer: Layer, match_name = "ADBE Position"): Property {
  const prop = layer.transform.__getitem__(match_name);
  py_assert(prop instanceof Property);
  return prop;
}

/** `{match name: property record}` for the layer's ADBE Transform Group in the ExtendScript JSON. */
function _expected_transform(sample: string, comp_name: string, layer_name: string): Map<string, any> {
  const expected = load_expected(SAMPLES_DIR, sample);
  const comp_json = get_comp_from_json_by_name(expected, comp_name);
  const layer_json = comp_json["layers"].find((ly: { name: string }) => ly["name"] === layer_name);
  const group = layer_json["properties"].find((p: { matchName: string }) => p["matchName"] === "ADBE Transform Group");
  return new Map(group["properties"].map((p: { matchName: string }): [string, any] => [p["matchName"], p]));
}

function _assert_matches_json(sample: string, comp_name: string, layer_name: string): void {
  const layer = _layer(sample, comp_name, layer_name);
  const expected = _expected_transform(sample, comp_name, layer_name);
  for (const match_name of _POSITION_MATCH_NAMES) {
    const prop = _position(layer, match_name);
    const prop_json = getitem(expected, match_name);
    py_assert(approx(prop.value, prop_json["value"]), match_name);
    py_assert(prop.is_modified === prop_json["isModified"], match_name);
  }
  const leader_json = getitem(expected, "ADBE Position");
  expect(_position(layer).dimensions_separated).toBe(leader_json["dimensionsSeparated"]);
}

describe("TestCameraDefaultPosition", () => {
  test.each(_CAMERA_COMPS)("test_position_and_followers_match_json[%#]", (comp_name) => {
    _assert_matches_json("camera_default_position", comp_name, "Camera");
  });

  test.each(["zoom_1000", "zoom_keyed", "zoom_1000_separated"])("test_default_follows_zoom[%#]", (comp_name) => {
    // AE places a dropped Position from the camera's Zoom at time 0, not
    // the comp's default zoom (-2000), also once the Zoom is keyed.
    const camera = _layer("camera_default_position", comp_name, "Camera");
    expect(approx(_position(camera).default_value, [720.0, 405.0, -1000.0])).toBe(true);
  });

  test("test_separated_followers_default_to_leader", () => {
    const camera = _layer("camera_default_position", "zoom_1000_separated", "Camera");
    const defaults = Array.from(range(3), (dim) => _position(camera, `ADBE Position_${dim}`).default_value);
    expect(approx(defaults, [720.0, 405.0, -1000.0])).toBe(true);
  });

  test("test_moved_off_default", () => {
    const camera = _layer("camera_default_position", "moved", "Camera");
    const position = _position(camera);
    expect(approx(position.default_value, [720.0, 405.0, -1000.0])).toBe(true);
  });

  test("test_camera_with_default_zoom", () => {
    // Zoom and Position are both absent here; the 1920x107 comp's 10:11
    // pixel aspect makes the default zoom 2424.24 rather than 2666.67.
    // ExtendScript: [960, 53.5, -2424.24242418], isModified false.
    const comp = get_comp(parse_project(VIEW_DIR.div("draft3d_false.aep")), "Comp 1");
    const camera = comp.layers.find((layer) => layer.name === "Camera 1")!;
    const position = _position(camera);
    expect(approx(position.value, [960.0, 53.5, -2424.24242418])).toBe(true);
    expect(position.is_modified).toBe(false);
  });
});

describe("TestLightDefaultPosition", () => {
  test.each(_LIGHT_ROWS)("test_position_and_followers_match_json[%#]", (comp_name, layer_name) => {
    _assert_matches_json("light_default_position", comp_name, layer_name);
  });

  test.each(_LIGHT_COMPS)("test_default_value[%#]", (comp_name) => {
    const light = _layer("light_default_position", comp_name, "Point");
    const comp = light.containing_comp;
    const zoom = (comp.width * comp.pixel_aspect) / 0.72;
    const expected = [
      comp.width / 2 + 0.03 * zoom,
      comp.height / 2 - 0.03 * zoom,
      -zoom / 4,
    ];
    expect(approx(_position(light).default_value, expected)).toBe(true);
  });

  test.each(_LIGHT_COMPS)("test_separated_followers_default_to_leader[%#]", (comp_name) => {
    const light = _layer("light_default_position", comp_name, "Point Separated");
    const defaults = Array.from(range(3), (dim) => _position(light, `ADBE Position_${dim}`).default_value);
    expect(approx(defaults, _position(light).default_value)).toBe(true);
  });

  test("test_environment_light_stored_at_default", () => {
    // This light's Position is stored at its default rather than left out;
    // ExtendScript reports it unmodified all the same.
    const comp = get_comp(parse_project(SAMPLES_DIR.div("light_source_default.aep")), "crystal");
    const light = comp.layers.find((ly) => ly.name === "Environment Light 1")!;
    const position = _position(light);
    expect(approx(position.default_value, [1040.0, 460.0, -2000.0 / 3])).toBe(true);
    expect(approx(position.value, position.default_value)).toBe(true);
    expect(position.is_modified).toBe(false);
  });
});
