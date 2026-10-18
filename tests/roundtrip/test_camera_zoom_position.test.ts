/**
 * Changing a camera's Zoom must not move a Position AE left out of the file.
 *
 * AE leaves a camera Position at its default, `[w/2, h/2, -zoom]`, out of the
 * file and places the camera from the Zoom on open. In
 * `camera_default_position.aep` the `zoom_1000` camera's Zoom is 1000 and its
 * Position, [720, 405, -1000], is left out. Setting the Zoom to 3000 in AE 2026
 * keeps the camera at -1000, reads it modified, and writes the Position; left
 * out, the camera jumped to -3000 on reopen (checked by opening py-aep's save
 * in AE 2026).
 */

import { describe, expect, test } from "bun:test";

import "../../src/py_aep/binary/_register.ts";
import { parse as parseAep } from "../../src/py_aep/index.ts";
import { CameraLayer } from "../../src/py_aep/models/layers/index.ts";
import type { Project } from "../../src/py_aep/models/project.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { getComp, parseProjectFresh } from "../helpers.ts";
import { Path, assert } from "../../src/pyrt/index.ts";
import { approx, makeTmpPath } from "../support/pytest.ts";


const SAMPLES_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "layer");
const SAMPLE = SAMPLES_DIR.div("camera_default_position.aep");

function _camera(project: Project): CameraLayer {
  const camera = getComp(project, "zoom_1000").layers[0];
  assert(camera instanceof CameraLayer);
  return camera;
}

function _position(camera: CameraLayer): Property<number[]> {
  const prop = camera.transform.property("ADBE Position");
  expect(prop instanceof Property).toBe(true);
  return prop;
}

function _zoom(camera: CameraLayer): Property<number> {
  const prop = camera.property("ADBE Camera Options Group").property("ADBE Camera Zoom");
  expect(prop instanceof Property).toBe(true);
  return prop;
}

function _reopenedPosition(project: Project, tmpPath: Path): Property<number[]> {
  const out = tmpPath.div("out.aep");
  project.save(out);
  return _position(_camera(parseAep(out).project));
}

describe("TestZoomChange", () => {
  test("test_default_follows_zoom_in_memory", () => {
    const camera = _camera(parseProjectFresh(SAMPLE));
    const position = _position(camera);
    expect(position.isModified).toBe(false);

    _zoom(camera).value = 3000;

    expect(approx(position.value, [720.0, 405.0, -1000.0])).toBe(true);
    expect(approx(position.defaultValue, [720.0, 405.0, -3000.0])).toBe(true);
    expect(position.isModified).toBe(true);
    const zFollower = camera.transform.property("ADBE Position_2");
    expect(zFollower instanceof Property).toBe(true);
    expect(approx(zFollower.defaultValue, -3000.0)).toBe(true);
  });

  test("test_default_is_float_after_int_zoom", () => {
    // NOTE(port): int/float — integral values are plain numbers by design (RULEBOOK §4); isinstance(v, float) reduces to a number check, so an int result would not be caught.
    const camera = _camera(parseProjectFresh(SAMPLE));
    _zoom(camera).value = 3000;

    const default_ = _position(camera).defaultValue;
    assert(default_ != null);
    expect(default_.every((v) => typeof v === "number")).toBe(true);
  });

  test("test_static_zoom_change_writes_position", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLE);
    _zoom(_camera(project)).value = 3000;

    const position = _reopenedPosition(project, tmpPath);

    expect(approx(position.value, [720.0, 405.0, -1000.0])).toBe(true);
    expect(position.isModified).toBe(true);
  });

  test("test_keyed_zoom_change_at_time_0_writes_position", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLE);
    const zoom = _zoom(_camera(project));
    zoom.setValueAtTime(0, 3000);
    zoom.setValueAtTime(2, 1000);

    const position = _reopenedPosition(project, tmpPath);

    expect(approx(position.value, [720.0, 405.0, -1000.0])).toBe(true);
    expect(position.isModified).toBe(true);
  });

  test("test_untouched_position_stays_left_out", () => {
    const tmpPath = makeTmpPath();
    const position = _reopenedPosition(parseProjectFresh(SAMPLE), tmpPath);

    assert(position._tdsb != null);
    expect(position._tdsb.synthetic).toBe(true);
    expect(approx(position.value, [720.0, 405.0, -1000.0])).toBe(true);
    expect(position.isModified).toBe(false);
  });

  test("test_start_shift_keeps_keyed_zoom_default", () => {
    // The default reads the Zoom at the layer's own time 0, and the keys
    // move with the layer: AE 2026 keeps this Position out of the file at
    // -1000 after the shift, although the Zoom at comp time 0 is now past
    // its first key.
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLE);
    const camera = getComp(project, "zoom_keyed").layers[0];
    assert(camera instanceof CameraLayer);
    camera.startTime = -1;
    expect(_position(camera).isModified).toBe(false);

    const out = tmpPath.div("out.aep");
    project.save(out);
    const reopened = getComp(parseAep(out).project, "zoom_keyed").layers[0];
    assert(reopened instanceof CameraLayer);
    const position = _position(reopened);

    assert(position._tdsb != null);
    expect(position._tdsb.synthetic).toBe(true);
    expect(approx(position.value, [720.0, 405.0, -1000.0])).toBe(true);
  });
});
