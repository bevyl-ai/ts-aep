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
import { parse as parse_aep } from "../../src/py_aep/index.ts";
import { CameraLayer } from "../../src/py_aep/models/layers/index.ts";
import type { Project } from "../../src/py_aep/models/project.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { get_comp, parse_project_fresh } from "../helpers.ts";
import { Path, py_assert } from "../../src/pyrt/index.ts";
import { approx, make_tmp_path } from "../../src/pyrt/pytest.ts";

const SAMPLES_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "layer");
const SAMPLE = SAMPLES_DIR.div("camera_default_position.aep");

function _camera(project: Project): CameraLayer {
  const camera = get_comp(project, "zoom_1000").layers[0];
  py_assert(camera instanceof CameraLayer);
  return camera;
}

function _position(camera: CameraLayer): Property<number[]> {
  const prop = camera.transform.__getitem__("ADBE Position");
  expect(prop instanceof Property).toBe(true);
  return prop;
}

function _zoom(camera: CameraLayer): Property<number> {
  const prop = camera.__getitem__("ADBE Camera Options Group").__getitem__("ADBE Camera Zoom");
  expect(prop instanceof Property).toBe(true);
  return prop;
}

function _reopened_position(project: Project, tmp_path: Path): Property<number[]> {
  const out = tmp_path.div("out.aep");
  project.save(out);
  return _position(_camera(parse_aep(out).project));
}

describe("TestZoomChange", () => {
  test("test_default_follows_zoom_in_memory", () => {
    const camera = _camera(parse_project_fresh(SAMPLE));
    const position = _position(camera);
    expect(position.is_modified).toBe(false);

    _zoom(camera).value = 3000;

    expect(approx(position.value, [720.0, 405.0, -1000.0])).toBe(true);
    expect(approx(position.default_value, [720.0, 405.0, -3000.0])).toBe(true);
    expect(position.is_modified).toBe(true);
    const z_follower = camera.transform.__getitem__("ADBE Position_2");
    expect(z_follower instanceof Property).toBe(true);
    expect(approx(z_follower.default_value, -3000.0)).toBe(true);
  });

  test("test_default_is_float_after_int_zoom", () => {
    // NOTE(port): int/float — integral values are plain numbers by design (RULEBOOK §4); isinstance(v, float) reduces to a number check, so an int result would not be caught.
    const camera = _camera(parse_project_fresh(SAMPLE));
    _zoom(camera).value = 3000;

    const default_ = _position(camera).default_value;
    py_assert(default_ != null);
    expect(default_.every((v) => typeof v === "number")).toBe(true);
  });

  test("test_static_zoom_change_writes_position", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLE);
    _zoom(_camera(project)).value = 3000;

    const position = _reopened_position(project, tmp_path);

    expect(approx(position.value, [720.0, 405.0, -1000.0])).toBe(true);
    expect(position.is_modified).toBe(true);
  });

  test("test_keyed_zoom_change_at_time_0_writes_position", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLE);
    const zoom = _zoom(_camera(project));
    zoom.set_value_at_time(0, 3000);
    zoom.set_value_at_time(2, 1000);

    const position = _reopened_position(project, tmp_path);

    expect(approx(position.value, [720.0, 405.0, -1000.0])).toBe(true);
    expect(position.is_modified).toBe(true);
  });

  test("test_untouched_position_stays_left_out", () => {
    const tmp_path = make_tmp_path();
    const position = _reopened_position(parse_project_fresh(SAMPLE), tmp_path);

    py_assert(position._tdsb != null);
    expect(position._tdsb.synthetic).toBe(true);
    expect(approx(position.value, [720.0, 405.0, -1000.0])).toBe(true);
    expect(position.is_modified).toBe(false);
  });

  test("test_start_shift_keeps_keyed_zoom_default", () => {
    // The default reads the Zoom at the layer's own time 0, and the keys
    // move with the layer: AE 2026 keeps this Position out of the file at
    // -1000 after the shift, although the Zoom at comp time 0 is now past
    // its first key.
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLE);
    const camera = get_comp(project, "zoom_keyed").layers[0];
    py_assert(camera instanceof CameraLayer);
    camera.start_time = -1;
    expect(_position(camera).is_modified).toBe(false);

    const out = tmp_path.div("out.aep");
    project.save(out);
    const reopened = get_comp(parse_aep(out).project, "zoom_keyed").layers[0];
    py_assert(reopened instanceof CameraLayer);
    const position = _position(reopened);

    py_assert(position._tdsb != null);
    expect(position._tdsb.synthetic).toBe(true);
    expect(approx(position.value, [720.0, 405.0, -1000.0])).toBe(true);
  });
});
