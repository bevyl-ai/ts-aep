/**
 * Resizing a comp must not move the camera and light properties AE left out.
 *
 * A camera or light Position, and a camera's Focus Distance, left at their
 * default are out of the file, and their defaults follow the comp's width,
 * height and pixel aspect. Changing those in AE 2026 writes the ones whose
 * default moves, keeping them where they were, so they read modified; left
 * out, they would reopen at the new default. In `camera_default_position.aep`
 * the `zoom_1000` camera's Position ([720, 405, -1000]) and Focus Distance
 * (2000, the 1440-wide comp's default zoom) are left out; in
 * `light_default_position.aep` so is the `1920x1080` Point light's Position.
 */

import { describe, expect, test } from "bun:test";

import "../../src/py_aep/binary/_register.ts";
import { parse as parse_aep } from "../../src/py_aep/index.ts";
import type { Layer } from "../../src/py_aep/models/layers/index.ts";
import type { Project } from "../../src/py_aep/models/project.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { as_instance, get_comp, parse_project_fresh } from "../helpers.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";
import { Path, py_assert, setattr } from "../../src/pyrt/index.ts";
import { approx, make_tmp_path } from "../../src/pyrt/pytest.ts";

// `Path(__file__).parent.parent.parent / "samples" / ...` in Python is the
// package root's `samples/`; from this file's directory that is two `.parent`s.
const SAMPLES_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "layer");
const CAMERA_SAMPLE = SAMPLES_DIR.div("camera_default_position.aep");
const LIGHT_SAMPLE = SAMPLES_DIR.div("light_default_position.aep");

function _prop(layer: Layer, group: string, match_name: string): Property {
  const prop = as_instance(layer.property(group), PropertyGroup).property(match_name);
  py_assert(prop instanceof Property);
  return prop;
}

function _reopened(project: Project, tmp_path: Path, comp_name: string, layer_name: string): Layer {
  const out = tmp_path.div("out.aep");
  project.save(out);
  const comp = get_comp(parse_aep(out).project, comp_name);
  const found = comp.layers.find((layer) => layer.name === layer_name);
  // Python `next(...)` raises StopIteration when no layer matches.
  if (found === undefined) throw new Error("StopIteration");
  return found;
}

function _assert_written(prop: Property, value: number[] | number): void {
  py_assert(prop._tdsb != null);
  expect(prop._tdsb.synthetic).toBe(false);
  expect(approx(prop.value, value)).toBe(true);
  expect(prop.isModified).toBe(true);
}

function _assert_left_out(prop: Property, value: number[] | number): void {
  py_assert(prop._tdsb != null);
  expect(prop._tdsb.synthetic).toBe(true);
  expect(approx(prop.value, value)).toBe(true);
  expect(prop.isModified).toBe(false);
}

describe("TestCameraCompResize", () => {
  test("test_width_writes_position_and_focus_distance", () => {
    const tmp_path = make_tmp_path();
    // The comp is resized before any of its layers is read.
    const project = parse_project_fresh(CAMERA_SAMPLE);
    get_comp(project, "zoom_1000").width = 1280;

    const camera = _reopened(project, tmp_path, "zoom_1000", "Camera");

    _assert_written(_prop(camera, "ADBE Transform Group", "ADBE Position"), [720.0, 405.0, -1000.0]);
    _assert_written(_prop(camera, "ADBE Camera Options Group", "ADBE Camera Focus Distance"), 2000.0);
  });

  test("test_pixel_aspect_writes_focus_distance_only", () => {
    const tmp_path = make_tmp_path();
    // A camera's default Position follows its own Zoom, not the pixel
    // aspect, so AE leaves it out.
    const project = parse_project_fresh(CAMERA_SAMPLE);
    get_comp(project, "zoom_1000").pixelAspect = 2.0;

    const camera = _reopened(project, tmp_path, "zoom_1000", "Camera");

    _assert_left_out(_prop(camera, "ADBE Transform Group", "ADBE Position"), [720.0, 405.0, -1000.0]);
    _assert_written(_prop(camera, "ADBE Camera Options Group", "ADBE Camera Focus Distance"), 2000.0);
  });

  test("test_untouched_comps_are_not_loaded_on_save", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(CAMERA_SAMPLE);
    get_comp(project, "zoom_1000").width = 1280;

    project.save(tmp_path.div("out.aep"));

    expect(get_comp(project, "moved")._layers_loaded).toBe(false);
  });
});

describe("TestLightCompResize", () => {
  const rows: [string, number][] = [
    ["width", 1280],
    ["height", 720],
    ["pixelAspect", 2.0],
  ];
  test.each(rows)("test_writes_position[%#]", (attr, value) => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(LIGHT_SAMPLE);
    setattr(get_comp(project, "1920x1080"), attr, value);

    const light = _reopened(project, tmp_path, "1920x1080", "Point");

    _assert_written(_prop(light, "ADBE Transform Group", "ADBE Position"), [1040.0, 460.0, -2000.0 / 3]);
  });
});
