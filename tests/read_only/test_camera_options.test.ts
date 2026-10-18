/**
 * Tests for synthesized Camera Options defaults (AE 2026 ground truth).
 *
 * An untouched camera stores no Camera Options chunks; py synthesizes them.
 * Zoom and Focus Distance default to `comp width / 0.72` (AE's 50mm lens),
 * Aperture to a width-independent constant, and AE 2026 exposes two options
 * (Focus Area Width, Near/Far Blur Level) that AE 25 did not. All values were
 * probed against AE 2026 (2026-07-14) at comp widths 1920/1280/640.
 */

import { describe, expect, test } from "bun:test";
import { Path, StopIteration, len, pyAssert } from "../../src/pyrt/index.ts";
import { approx } from "../../src/pyrt/pytest.ts";
import "../../src/py_aep/binary/_register.ts";
import { parseProject } from "../conftest.ts";
import { CameraLayer, type Layer } from "../../src/py_aep/models/layers/index.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";

const SAMPLES_DIR = new Path(import.meta.dir).div("..", "..", "samples", "models", "layer");
const CAMERAS_AEP = SAMPLES_DIR.div("camera_rigs.aep");
const TYPE_AEP = SAMPLES_DIR.div("type.aep");

function _camera(compName: string): CameraLayer {
  const project = parseProject(CAMERAS_AEP);
  const comp = project.compositions.find((c) => c.name === compName);
  if (comp === undefined) throw new StopIteration();
  const cam = comp.layers.find((ly) => ly instanceof CameraLayer);
  if (cam === undefined) throw new StopIteration();
  return cam;
}

describe("TestCameraOptionDefaults", () => {
  const _opt = (cam: CameraLayer, matchName: string): Property => {
    const prop = cam.property("ADBE Camera Options Group").property(matchName);
    expect(prop instanceof Property).toBe(true);
    pyAssert(prop instanceof Property);
    return prop;
  };

  test("test_zoom_and_focus_are_width_over_072", () => {
    // CAM_ONE is a 1920-wide comp with an untouched camera.
    const cam = _camera("CAM_ONE");
    const expected = 1920 / 0.72;
    const zoom = _opt(cam, "ADBE Camera Zoom");
    const focus = _opt(cam, "ADBE Camera Focus Distance");
    expect(approx(zoom.value, expected)).toBe(true);
    expect(approx(focus.value, expected)).toBe(true);
    // An untouched default is not "modified".
    expect(zoom.isModified).toBe(false);
    expect(focus.isModified).toBe(false);
  });

  test("test_aperture_is_constant", () => {
    const cam = _camera("CAM_ONE");
    const aperture = _opt(cam, "ADBE Camera Aperture");
    expect(approx(aperture.value, 25.3093363329584)).toBe(true);
    expect(aperture.isModified).toBe(false);
  });

  test("test_ae26_has_fifteen_options", () => {
    const cam = _camera("CAM_ONE");
    const options = cam.property("ADBE Camera Options Group").properties;
    expect(len(options)).toBe(15);
    const names = options.map((p) => p.matchName);
    expect(names.includes("ADBE Camera Focus Area Width")).toBe(true);
    expect(names.includes("ADBE Camera Split Blur Level")).toBe(true);
    // Iris Shape follows the two 2026 additions.
    expect(names.indexOf("ADBE Iris Shape")).toBe(7);
  });

  test("test_new_option_metadata_matches_ae", () => {
    const cam = _camera("CAM_ONE");
    const focusArea = _opt(cam, "ADBE Camera Focus Area Width");
    expect(approx(focusArea.value, 0.0)).toBe(true);
    expect(focusArea.hasMin).toBe(true);
    expect(focusArea.hasMax).toBe(false);
    expect(focusArea.canSetExpression).toBe(false);

    const splitBlur = _opt(cam, "ADBE Camera Split Blur Level");
    expect(approx(Array.from(splitBlur.value), [100.0, 100.0])).toBe(true);
    expect(splitBlur.hasMax).toBe(false);
    expect(splitBlur.canSetExpression).toBe(false);
    expect(splitBlur.unitsText).toBe("percent");
  });

  test("test_ae25_gate_keeps_thirteen_options", () => {
    // type.aep is authored by AE 25, which predates the two 2026
    // additions; min_major=26 gating must keep it at 13 options.
    const project = parseProject(TYPE_AEP);
    expect(project._head.aeVersionMajor).toBe(25);
    const cam = project.compositions
      .flatMap((c) => c.layers)
      .find((ly) => ly instanceof CameraLayer);
    if (cam === undefined) throw new StopIteration();
    const options = cam.property("ADBE Camera Options Group").properties;
    expect(len(options)).toBe(13);
    const names = options.map((p) => p.matchName);
    expect(names.includes("ADBE Camera Focus Area Width")).toBe(false);
    expect(names.includes("ADBE Camera Split Blur Level")).toBe(false);
  });
});

/**
 * Transform-property metadata that AE reports specially for camera and
 * light layers (probed AE 2026; separate from the Camera Options group).
 *
 * - The Z Position separation follower reads isModified True on camera and
 *   light layers (always positioned in depth) but False on regular layers,
 *   even though the follower's stored value is a placeholder 0 while the
 *   leader is unseparated.
 * - Point of Interest (the camera anchor point) is expressionable only on a
 *   two-node camera (orient towards POI); a one-node camera's POI is
 *   inactive and non-expressionable.
 */
describe("TestCameraLightTransformMetadata", () => {
  const GEOMETRY_AEP = SAMPLES_DIR.div("geometry_probe.aep");

  const _zFollower = (layer: Layer): Property => {
    const prop = layer.transform.property("ADBE Position_2");
    expect(prop instanceof Property).toBe(true);
    // These probes assume the leader is NOT dimension-separated.
    const leader = layer.transform.property("ADBE Position");
    expect(leader instanceof Property).toBe(true);
    expect(leader.dimensionsSeparated).toBe(false);
    return prop;
  };

  test("test_camera_z_position_follower_is_modified", () => {
    for (const compName of ["CAM_ONE", "CAM_TWO"]) {
      const cam = _camera(compName);
      // Compared as [name, value] so a failure names the comp, like the Python message.
      expect([compName, _zFollower(cam).isModified]).toEqual([compName, true]);
    }
  });

  test("test_regular_layer_z_follower_not_modified", () => {
    // Non-regression: a normal 3D layer keeps Z follower isModified False.
    const project = parseProject(GEOMETRY_AEP);
    const comp = project.compositions.find((c) => c.name === "PROBE_MAIN");
    if (comp === undefined) throw new StopIteration();
    const solid = comp.layers.find((ly) => ly.name === "solid_3d");
    if (solid === undefined) throw new StopIteration();
    expect(_zFollower(solid).isModified).toBe(false);
  });

  test("test_two_node_camera_poi_expressionable", () => {
    const cam = _camera("CAM_TWO");
    expect(cam._ldta.poiAutoOrient).toBe(true);
    const poi = cam.transform.property("ADBE Anchor Point");
    expect(poi instanceof Property).toBe(true);
    expect(poi.canSetExpression).toBe(true);
  });

  test("test_one_node_camera_poi_not_expressionable", () => {
    const cam = _camera("CAM_ONE");
    expect(cam._ldta.poiAutoOrient).toBe(false);
    const poi = cam.transform.property("ADBE Anchor Point");
    expect(poi instanceof Property).toBe(true);
    expect(poi.canSetExpression).toBe(false);
  });
});
