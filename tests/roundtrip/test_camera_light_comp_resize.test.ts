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
import { parse as parseAep } from "../../src/py_aep/index.ts";
import type { Layer } from "../../src/py_aep/models/layers/index.ts";
import type { Project } from "../../src/py_aep/models/project.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { asInstance, getComp, parseProjectFresh } from "../helpers.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";
import { Path, assert, setMember } from "../../src/pyrt/index.ts";
import { approx, makeTmpPath } from "../../src/pyrt/pytest.ts";

// `Path(__file__).parent.parent.parent / "samples" / ...` in Python is the
// package root's `samples/`; from this file's directory that is two `.parent`s.
const SAMPLES_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "layer");
const CAMERA_SAMPLE = SAMPLES_DIR.div("camera_default_position.aep");
const LIGHT_SAMPLE = SAMPLES_DIR.div("light_default_position.aep");

function _prop(layer: Layer, group: string, matchName: string): Property {
  const prop = asInstance(layer.property(group), PropertyGroup).property(matchName);
  assert(prop instanceof Property);
  return prop;
}

function _reopened(project: Project, tmpPath: Path, compName: string, layerName: string): Layer {
  const out = tmpPath.div("out.aep");
  project.save(out);
  const comp = getComp(parseAep(out).project, compName);
  const found = comp.layers.find((layer) => layer.name === layerName);
  // Python `next(...)` raises StopIteration when no layer matches.
  if (found === undefined) throw new Error("StopIteration");
  return found;
}

function _assertWritten(prop: Property, value: number[] | number): void {
  assert(prop._tdsb != null);
  expect(prop._tdsb.synthetic).toBe(false);
  expect(approx(prop.value, value)).toBe(true);
  expect(prop.isModified).toBe(true);
}

function _assertLeftOut(prop: Property, value: number[] | number): void {
  assert(prop._tdsb != null);
  expect(prop._tdsb.synthetic).toBe(true);
  expect(approx(prop.value, value)).toBe(true);
  expect(prop.isModified).toBe(false);
}

describe("TestCameraCompResize", () => {
  test("test_width_writes_position_and_focus_distance", () => {
    const tmpPath = makeTmpPath();
    // The comp is resized before any of its layers is read.
    const project = parseProjectFresh(CAMERA_SAMPLE);
    getComp(project, "zoom_1000").width = 1280;

    const camera = _reopened(project, tmpPath, "zoom_1000", "Camera");

    _assertWritten(_prop(camera, "ADBE Transform Group", "ADBE Position"), [720.0, 405.0, -1000.0]);
    _assertWritten(_prop(camera, "ADBE Camera Options Group", "ADBE Camera Focus Distance"), 2000.0);
  });

  test("test_pixel_aspect_writes_focus_distance_only", () => {
    const tmpPath = makeTmpPath();
    // A camera's default Position follows its own Zoom, not the pixel
    // aspect, so AE leaves it out.
    const project = parseProjectFresh(CAMERA_SAMPLE);
    getComp(project, "zoom_1000").pixelAspect = 2.0;

    const camera = _reopened(project, tmpPath, "zoom_1000", "Camera");

    _assertLeftOut(_prop(camera, "ADBE Transform Group", "ADBE Position"), [720.0, 405.0, -1000.0]);
    _assertWritten(_prop(camera, "ADBE Camera Options Group", "ADBE Camera Focus Distance"), 2000.0);
  });

  test("test_untouched_comps_are_not_loaded_on_save", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(CAMERA_SAMPLE);
    getComp(project, "zoom_1000").width = 1280;

    project.save(tmpPath.div("out.aep"));

    expect(getComp(project, "moved")._layersLoaded).toBe(false);
  });
});

describe("TestLightCompResize", () => {
  const rows: [string, number][] = [
    ["width", 1280],
    ["height", 720],
    ["pixelAspect", 2.0],
  ];
  test.each(rows)("test_writes_position[%#]", (attr, value) => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(LIGHT_SAMPLE);
    setMember(getComp(project, "1920x1080"), attr, value);

    const light = _reopened(project, tmpPath, "1920x1080", "Point");

    _assertWritten(_prop(light, "ADBE Transform Group", "ADBE Position"), [1040.0, 460.0, -2000.0 / 3]);
  });
});
