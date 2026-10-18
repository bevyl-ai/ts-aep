/**
 * Strict-bool validation across the model layer.
 *
 * Writable boolean attributes reject non-bool values (the binary layer would
 * otherwise silently coerce truthy values - `"no"` -> `True`); real booleans
 * are accepted and round-trip. Covers a representative writable bool on each
 * major model. The render-queue package has its own coverage in
 * `test_rq_validation.py`.
 */

import { describe, expect, test } from "bun:test";
import {
  AssertionError,
  getMember,
  len,
  Path,
  truthy,
  setMember,
  StopIteration,
  str,
} from "../../src/pyrt/index.ts";

import { asInstance, parseAppFresh, parseProjectFresh } from "../helpers.ts";
import { ImportOptions } from "../../src/py_aep/models/import_options.ts";
import { MaskPropertyGroup } from "../../src/py_aep/models/properties/mask_property_group.ts";
import type { FootageSource } from "../../src/py_aep/models/sources/footage.ts";
import { Viewer } from "../../src/py_aep/models/viewer/viewer.ts";
import { makeTmpPath, raises } from "../support/pytest.ts";

const SAMPLES = new Path(import.meta.path).parent.parent.parent.div("samples");
const LAYER = SAMPLES.div("models", "layer", "enabled_false.aep");
const FOOTAGE = SAMPLES.div("models", "essential_graphics", "media_replacement.aep");
const MASK = SAMPLES.div("models", "essential_graphics", "indexed_group_controllers.aep");
const VIEW = SAMPLES.div("models", "view", "grid_on.aep");

function _fileSource(): FootageSource {
  const project = parseProjectFresh(FOOTAGE);
  const footage = project.footages.find(
    (f) => getMember(f, "mainSource", null)?.constructor?.name === "FileSource",
  );
  if (footage === undefined) throw new StopIteration();
  return footage.mainSource;
}

function _firstMask(): MaskPropertyGroup {
  const project = parseProjectFresh(MASK);
  for (const comp of project.compositions) {
    for (const layer of comp.layers) {
      const masks = getMember(layer, "masks", null);
      if (masks != null && truthy(masks) && len(masks) > 0) {
        return asInstance(masks.property(0), MaskPropertyGroup);
      }
    }
  }
  throw new AssertionError("no mask found in sample");
}

// (id, factory returning a fresh mutable object, bool attribute name)
const CASES: [string, () => object, string][] = [
  [
    "comp.motion_blur",
    () => parseProjectFresh(LAYER).compositions[0],
    "motionBlur",
  ],
  [
    "comp.frame_blending",
    () => parseProjectFresh(LAYER).compositions[0],
    "frameBlending",
  ],
  [
    "layer.enabled",
    () => parseProjectFresh(LAYER).compositions[0].layers[0],
    "enabled",
  ],
  [
    "layer.solo",
    () => parseProjectFresh(LAYER).compositions[0].layers[0],
    "solo",
  ],
  ["layer.shy", () => parseProjectFresh(LAYER).compositions[0].layers[0], "shy"],
  [
    "project.frames_use_feet_frames",
    () => parseProjectFresh(LAYER),
    "framesUseFeetFrames",
  ],
  ["footage.invert_alpha", _fileSource, "invertAlpha"],
  ["mask.inverted", _firstMask, "inverted"],
  ["view.grid", () => asInstance(parseAppFresh(VIEW).activeViewer, Viewer).views[0].options, "grid"],
  ["import.sequence", () => new ImportOptions(str(LAYER)), "sequence"],
  [
    "import.force_alphabetical",
    () => new ImportOptions(str(LAYER)),
    "forceAlphabetical",
  ],
];

const _IDS = CASES.map((c) => c[0]);
const _PARAMS = CASES.map((c): [() => object, string] => [c[1], c[2]]);
// pytest `ids=_IDS`: the id is prepended to each row so `%s` renders it in the test name.
const _ROWS = _PARAMS.map((p, i): [string, () => object, string] => [_IDS[i], p[0], p[1]]);

describe("TestStrictBool", () => {
  test.each(_ROWS)("test_rejects_non_bool_string[%s]", (_id: string, factory: () => object, attr: string) => {
    const obj = factory();
    raises(TypeError, () => {
      setMember(obj, attr, "no");
    });
  });

  test.each(_ROWS)("test_rejects_bare_int[%s]", (_id: string, factory: () => object, attr: string) => {
    const obj = factory();
    raises(TypeError, () => {
      setMember(obj, attr, 1);
    });
  });

  test.each(_ROWS)("test_accepts_true_and_false[%s]", (_id: string, factory: () => object, attr: string) => {
    const obj = factory();
    setMember(obj, attr, true);
    expect(getMember(obj, attr)).toBe(true);
    setMember(obj, attr, false);
    expect(getMember(obj, attr)).toBe(false);
  });
});

/** A validated bool still serializes through a disk round-trip. */
describe("TestBoolPersists", () => {
  test("test_comp_and_layer_flags_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(LAYER);
    const comp = project.compositions[0];
    const layer = comp.layers[0];
    comp.motionBlur = true;
    layer.solo = true;
    const out = tmpPath.div("bools.aep");
    project.save(out);

    const project2 = parseProjectFresh(out);
    const comp2 = project2.compositions[0];
    expect(comp2.motionBlur).toBe(true);
    expect(comp2.layers[0].solo).toBe(true);
  });
});
