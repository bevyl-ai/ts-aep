/** Regression tests for the layer geometry, parenting and layer-mutation
fixes of the v9 API fuzz campaign.

Expected numbers are After Effects 2026 measurements unless a test says it
checks a law. The `*_v9` fixtures under samples/models/layer/ were built by
AE 2026 headless, which also recorded its own answers next to them:

- `geometry_v9.aep` + `geometry_v9_probe.json`: `sourcePointToComp`,
  `compPointToSource` and `sourceRectAtTime` of the PA_* comps' layers at
  times 0, 0.5, 1, 1.5 and 2.5 s (keys `t0`..`t4`).
- `reparent_copy_v9.aep` (saved BEFORE AE's operations; comp PB's playhead
  is at 1 s) + `reparent_copy_v9_probe.json`: the transform AE wrote after
  `layer.parent = ...` (`parent`), after `copyToComp` (`copy`) and its
  light-source refusals (`light`).
- `text_ink_v9.aep` + `text_ink_v9_probe.json`: text rects of tracked
  justified point text and of box text with inset spacing.
- `reparent_more_v9.aep` (saved BEFORE AE's operations) +
  `reparent_more_v9_probe.json`: `parent =` on auto-oriented layers, 2D
  children of cameras and lights, rig children and a 2:1 pixel-aspect
  comp (`parent`), `copyToComp` of parented layers with the playhead at
  0.5 s (`copy`), point text indents (`text`) and `sourcePointToComp` at
  times 0, 0.5, 1, 2, 2.5 s (`s2c`).
*/

import { describe, expect, test } from "bun:test";
import { AttributeError, contains, getMember, getOrThrow, isclose, mod, NotImplementedError, Path, assert, truthy, valueEquals, repr, StopIteration, ValueError, zip } from "../../src/pyrt/index.ts";

import { parse as parseAep, type CompItem, type Layer, type Project } from "../../src/py_aep/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { LightType } from "../../src/py_aep/enums/index.ts";
import { Mat4, intersectLayerPlane } from "../../src/py_aep/resolvers/transform.ts";
import { asInstance, parseProjectFresh } from "../helpers.ts";
import { AVLayer, LightLayer, ThreeDModelLayer } from "../../src/py_aep/models/layers/index.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";
import { makeTmpPath, raises, skip } from "../support/pytest.ts";
import { sorted } from "../support/python.ts";

// Python `Path(__file__).parent.parent.parent / "samples"`.
const SAMPLES = new Path(import.meta.path).parent.parent.parent.div("samples");
const LAYER_DIR = SAMPLES.div("models", "layer");
const GEOMETRY = LAYER_DIR.div("geometry_v9.aep");
const REPARENT = LAYER_DIR.div("reparent_copy_v9.aep");
const TEXT = LAYER_DIR.div("text_ink_v9.aep");
const MORE = LAYER_DIR.div("reparent_more_v9.aep");
const TIMES = [0.0, 0.5, 1.0, 1.5, 2.5];
const MORE_TIMES = [0.0, 0.5, 1.0, 2.0, 2.5];
const PTS = [[0.0, 0.0], [100.0, 50.0], [-30.0, 70.0]];
const CPTS = [[500.0, 400.0], [120.0, 60.0]];

// JSON truth records stay plain objects: they are read by fixed key names
// only and never iterated for their keys (except the sorted() calls below,
// whose keys are non-numeric).
function _json(name: string) {
  return JSON.parse(LAYER_DIR.div(name).readText("utf-8"));
}

const GEOMETRY_TRUTH = _json("geometry_v9_probe.json");
const REPARENT_TRUTH = _json("reparent_copy_v9_probe.json");
const TEXT_TRUTH = _json("text_ink_v9_probe.json");
const MORE_TRUTH = _json("reparent_more_v9_probe.json");

/** Python `next(x for x in items if pred(x))`: raises StopIteration when nothing matches. */
function _next<T>(items: Iterable<T>, pred: (x: T) => boolean): T {
  for (const x of items) {
    if (pred(x)) return x;
  }
  throw new StopIteration();
}

function _layer(project: Project, compName: string, layerName: string): [CompItem, Layer] {
  const comp = _next(project.compositions, (c) => c.name === compName);
  return [comp, _next(comp.layers, (ly) => ly.name === layerName)];
}

function _close(a: number | number[], b: number | number[], tol: number): boolean {
  if (typeof a === "number") return typeof b === "number" && Math.abs(a - b) <= tol;
  if (typeof b === "number") return false;
  return zip(a, b).every(([x, y]) => Math.abs(x - y) <= tol);
}

/** `layer.effects.properties[0].properties[0].value` */
function _firstEffectValue(layer: Layer) {
  const effect = asInstance(getMember(layer.effects, "properties")[0], PropertyGroup);
  return asInstance(effect.properties[0], Property).value;
}

/** Rect, or null after reporting a skip (callers `return` to abort the test body like pytest.skip). */
function _rect(layer: Layer, time: number): number[] | null {
  try {
    const r = asInstance(layer, AVLayer).sourceRectAtTime(time, false);
    // source_rect_at_time returns a fixed-key record (plain object), not a Map.
    return [r.left, r.top, r.width, r.height];
  } catch (exc) {
    if (!(exc instanceof NotImplementedError)) throw exc;
    skip(`text ink unavailable here: ${exc.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Layer.comment
// ---------------------------------------------------------------------------

describe("TestComment", () => {
  // AE 2026 only reads a comment when ldta byte 0x3c bit 0 is set; it
  // clears the bit and drops the `cmta` when the comment is emptied.

  test("test_new_comment_sets_the_flag_and_round_trips", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES.div("versions", "ae2026", "complete.aep"));
    const layer = _next(project.compositions, (c) => c.name === "DropFrame_Comp").layers[0];
    layer.comment = "probe comment";
    expect(layer._ldta.hasComment).toBe(true);
    const out = tmpPath.div("comment.aep");
    project.save(out);
    const again = parseAep(out).project;
    const reread = _next(again.compositions, (c) => c.name === "DropFrame_Comp").layers[0];
    expect(reread.comment).toBe("probe comment");
    expect(reread._ldta.hasComment).toBe(true);
  });

  test("test_emptying_drops_chunk_and_flag", () => {
    const project = parseProjectFresh(SAMPLES.div("versions", "ae2026", "complete.aep"));
    const comp = _next(project.compositions, (c) => c.name === "Main_Comp");
    const layer = _next(comp.layers, (ly) => ly.name === "Null_Controller");
    expect(layer.comment).toBe("Parent null for shapes");
    layer.comment = "";
    expect(layer._cmta == null).toBe(true);
    expect(!layer._ldta.hasComment).toBe(true);
    expect(
      layer._layerList.chunks.every((c) => getMember(c, "chunkType", "") !== "cmta"),
    ).toBe(true);
  });

  test("test_unflagged_comment_reads_empty", () => {
    const project = parseProjectFresh(SAMPLES.div("versions", "ae2026", "complete.aep"));
    const comp = _next(project.compositions, (c) => c.name === "Main_Comp");
    const layer = _next(comp.layers, (ly) => ly.name === "Null_Controller");
    layer._ldta.hasComment = false;
    expect(layer.comment).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Layer.copyToComp / duplicate
// ---------------------------------------------------------------------------

function _copyTruth(src: string, dst: string) {
  for (const r of REPARENT_TRUTH.copy) {
    if (r.src === src && r.dst === dst) return r;
  }
  throw new StopIteration();
}

describe("TestCopyToComp", () => {
  test("test_key_marker_and_remap_times_keep_seconds", () => {
    for (const srcName of ["kf_pos", "stretch_kf", "tr_kf"]) {
      for (const dstName of ["PC_D24", "PC_D30_PAR2"]) {
        const project = parseProjectFresh(REPARENT);
        const [_, src] = _layer(project, "PC_SRC", srcName);
        const dst = _next(project.compositions, (c) => c.name === dstName);
        const copy = src.copyToComp(dst);
        const truth = _copyTruth(srcName, dstName);
        const keys = copy.transform.property("ADBE Position").keyframes.map((kf) => kf.time);
        expect(
          _close(keys, truth.T["ADBE Position"].k.map((k: [number, number | number[]]) => k[0]), 1e-4),
        ).toBe(true);
        const markers = getMember(copy.marker, "keyframes").map((kf) => kf.time);
        expect(_close(markers, truth.mk, 1e-4)).toBe(true);
        if ("tr" in truth) {
          const remap = copy.property("ADBE Time Remapping").keyframes.map((kf) => kf.time);
          expect(_close(remap, truth.tr.map((k: [number, number | number[]]) => k[0]), 1e-4)).toBe(true);
        }
      }
    }
  });

  test("test_copy_survives_save", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(REPARENT);
    const [_, src] = _layer(project, "PC_SRC", "kf_pos");
    const dst = _next(project.compositions, (c) => c.name === "PC_D24");
    src.copyToComp(dst);
    const out = tmpPath.div("copy.aep");
    project.save(out);
    const [__, copy] = _layer(parseAep(out).project, "PC_D24", "kf_pos");
    expect(
      _close(
        copy.transform.property("ADBE Position").keyframes.map((kf) => kf.time),
        [0, 1, 2.48],
        1e-4,
      ),
    ).toBe(true);
  });

  test("test_user_name_kept_without_clash", () => {
    {
      const project = parseProjectFresh(REPARENT);
      const [_, src] = _layer(project, "PC_SRC", "tr_kf");
      const dst = _next(project.compositions, (c) => c.name === "PC_D24");
      expect(src.copyToComp(dst).name).toBe("tr_kf");
    }
    // Same comp: the source's name clashes, as in AE ("tr_kf 2").
    const project = parseProjectFresh(REPARENT);
    const [comp, src] = _layer(project, "PC_SRC", "tr_kf");
    expect(src.copyToComp(comp).name).toBe("tr_kf 2");
  });

  test("test_parented_copy_keeps_its_place", () => {
    for (const dstName of ["PC_D24", "PC_D30_PAR2", "PC_SRC"]) {
      const project = parseProjectFresh(REPARENT);
      const [_, src] = _layer(project, "PC_SRC", "fx_ref");
      const dst = _next(project.compositions, (c) => c.name === dstName);
      const copy = src.copyToComp(dst);
      expect(copy.parent == null).toBe(true);
      expect(_close(copy.transform.property("ADBE Position").value, [960, 590, 0], 1e-6)).toBe(true);
      // Into the 2:1 comp too: AE keeps the values (Scale 100).
      expect(_close(copy.transform.property("ADBE Scale").value, [100, 100, 100], 1e-6)).toBe(true);
    }
  });

  test("test_same_comp_copy_clears_refs_keeps_matte_goes_on_top", () => {
    {
      const project = parseProjectFresh(REPARENT);
      const [comp, src] = _layer(project, "PC_SRC", "fx_ref");
      const copy = src.copyToComp(comp);
      expect(copy.index).toBe(0);
      expect(copy.parent == null).toBe(true);
      expect(_firstEffectValue(copy)).toBe(0);
    }
    {
      const project = parseProjectFresh(REPARENT);
      const [comp, src] = _layer(project, "PC_SRC", "matte_user");
      const copy = asInstance(src.copyToComp(comp), AVLayer);
      expect(copy.trackMatteLayer != null).toBe(true);
      expect(getMember(copy.trackMatteLayer, "name")).toBe("txt");
    }
  });

  test("test_duplicate_keeps_refs", () => {
    /** Law: `duplicate()` keeps parent and effect references. */
    const project = parseProjectFresh(REPARENT);
    const [comp, src] = _layer(project, "PC_SRC", "fx_ref");
    const dup = src.duplicate();
    expect(dup.parent === src.parent).toBe(true);
    expect(_firstEffectValue(dup)).toBe(_firstEffectValue(src));
    expect(comp.layers.indexOf(dup)).toBe(comp.layers.indexOf(src) - 1);
  });

  test.each([0, 1, 2])("test_parented_copy_bakes_the_parent_at_time_zero[%#]", (index: number) => {
    // The source comp's playhead is at 0.5 s; AE still bakes the
    // animated parent's transform at 0 (keys remapped by that delta).
    const truth = MORE_TRUTH.copy[index];
    const project = parseProjectFresh(MORE);
    const [_, src] = _layer(project, "PH_SRC", truth.src);
    const dst = _next(project.compositions, (c) => c.name === truth.dst);
    const copy = src.copyToComp(dst);
    expect(copy.parent == null).toBe(true);
    _assertTransform(copy, dst, truth.T);
  });

  test("test_light_source_cleared_across_comps_kept_within", () => {
    const project = parseProjectFresh(REPARENT);
    const [_, src] = _layer(project, "PC_SRC", "env_light");
    const dst = _next(project.compositions, (c) => c.name === "PC_D24");
    const copy = asInstance(src.copyToComp(dst), LightLayer);
    expect(copy.lightSource == null).toBe(true);
    expect(copy._ldta.sourceId).toBe(0xffffffff);
    {
      const [comp, light] = _layer(parseProjectFresh(REPARENT), "PC_SRC", "env_light");
      expect(getMember(asInstance(light.copyToComp(comp), LightLayer).lightSource, "name")).toBe("env_src");
    }
  });
});

// ---------------------------------------------------------------------------
// LightLayer.lightSource
// ---------------------------------------------------------------------------

describe("TestLightSource", () => {
  test.each(["cam_s", "null_s", "adj_s", "env_light", "solid3d_s"])(
    "test_refused_like_ae[%#]",
    (target: string) => {
      const project = parseProjectFresh(REPARENT);
      const [comp, envLayer] = _layer(project, "PC_SRC", "env_light");
      const env = asInstance(envLayer, LightLayer);
      expect(contains(REPARENT_TRUTH.light[target].env, "ERR")).toBe(true);
      const before = env._ldta.sourceId;
      raises(ValueError, () => {
        env.lightSource = _next(comp.layers, (ly) => ly.name === target);
      });
      expect(env._ldta.sourceId).toBe(before);
    },
  );

  test("test_other_comp_refused", () => {
    const project = parseProjectFresh(REPARENT);
    const env = asInstance(_layer(project, "PC_SRC", "env_light")[1], LightLayer);
    const [__, other] = _layer(project, "PC_D24", "other_comp_solid");
    raises(ValueError, () => {
      env.lightSource = other;
    });
  });

  test("test_spot_and_point_lights_refuse_a_source", () => {
    // AE 2026 refuses a source on spot and point lights and stores one
    // on a parallel light.
    const project = parseProjectFresh(REPARENT);
    const [comp, spotLayer] = _layer(project, "PB", "spot2");
    const spot = asInstance(spotLayer, LightLayer);
    const text = _next(comp.layers, (ly) => ly.name === "c_text");
    expect(spot.lightType).toBe(LightType.SPOT);
    raises(ValueError, () => {
      spot.lightSource = text;
    });
    spot.lightType = LightType.POINT;
    raises(ValueError, () => {
      spot.lightSource = text;
    });
    spot.lightType = LightType.PARALLEL;
    spot.lightSource = text;
    expect(spot.lightSource === text).toBe(true);
  });

  test("test_text_and_shape_sources_accepted", () => {
    const project = parseProjectFresh(REPARENT);
    const [comp, envLayer] = _layer(project, "PC_SRC", "env_light");
    const env = asInstance(envLayer, LightLayer);
    for (const name of ["txt", "shp", "kf_pos"]) {
      expect(REPARENT_TRUTH.light[name].env).toBe(name);
      env.lightSource = _next(comp.layers, (ly) => ly.name === name);
      expect(getMember(env.lightSource, "name")).toBe(name);
    }
  });

  test("test_version_gate", () => {
    const project = parseProjectFresh(SAMPLES.div("versions", "ae2023", "complete.aep"));
    const light = _next(project.compositions.flatMap((c) => c.lightLayers), () => true);
    const solid = _next(
      light.containingComp.avLayers,
      (ly) => !ly.threeDLayer && !ly.nullLayer,
    );
    raises(
      AttributeError,
      () => {
        light.lightType = LightType.ENVIRONMENT;
      },
      "24.3",
    );
    raises(
      AttributeError,
      () => {
        light.lightSource = solid;
      },
      "24.3",
    );
  });
});

// ---------------------------------------------------------------------------
// Layer.parent
// ---------------------------------------------------------------------------

const _PARENT_OPS = new Map<string, string | null>([
  ["c_anim_par2d", "p_anim2d"],
  ["c3d_anim", "p_anim3d"],
  ["c_tiny", "p_tiny"],
  ["c_zero", "p_zero"],
  ["cam2", "p_rot3d"],
  ["spot2", "p_rot3d"],
  ["light_pt", "p_rot3d"],
  ["c_along", "p_rs"],
  ["c2d_under_orient", "p_orient"],
  ["c2d_under_orientx", "p_orientx"],
  ["c_reparent", "p_anim2d"],
  ["c_stretch_kf", "p_anim2d"],
  ["c_neg", "p_rs"],
  ["c_sep", "p_rs"],
  ["c_unparent", null],
  ["cam_unparent", null],
]);
const _COMPARED = [
  "ADBE Anchor Point",
  "ADBE Position",
  "ADBE Scale",
  "ADBE Orientation",
  "ADBE Rotate X",
  "ADBE Rotate Y",
  "ADBE Rotate Z",
] as const;

/** One transform record of a probe JSON: value `v` and keys `k` as `[time, value]`. */
type _TransformTruth = {
  [K in (typeof _COMPARED)[number]]?: { v: number | number[]; k: [number, number | number[]][] };
};

function _angleClose(a: number, b: number, tol: number): boolean {
  return Math.abs(mod(a - b + 180.0, 360.0) - 180.0) <= tol;
}

const _MORE_PARENT_OPS: [string, string, string][] = [
  ["PH", "h_along3d", "h_rot3d"],
  ["PH", "h_along2d_static", "h_rot2d"],
  ["PH", "h_c2d_under_cam", "h_cam"],
  ["PH", "h_c2d_under_spot", "h_spot"],
  ["PH", "h_c2d_under_point", "h_point"],
  ["PH", "h_cam1node", "h_rot3d"],
  ["PH", "h_parallel", "h_rot3d"],
  ["PH", "h_cam2_kfpoi", "h_rot3d"],
  ["PH_PAR2", "h_p2_2dchild", "h_p2_null"],
  ["PH_PAR2", "h_p2_sqchild", "h_p2_null"],
  ["PH_PAR2", "h_p2_3dchild", "h_p2_null3d"],
];

function _assertTransform(child: Layer, comp: CompItem, truth: _TransformTruth): void {
  for (const matchName of _COMPARED) {
    if (!(matchName in truth)) continue;
    const prop = child.transform.property(matchName);
    const expected = getMember(truth, matchName);
    const got = truthy(prop.keyframes) ? prop.valueAtTime(comp.time) : prop.value;
    const exp = expected.v;
    const scalars: number[] = typeof got === "number" ? [got] : [...got];
    const wanted: number[] = typeof exp === "number" ? [exp] : [...exp];
    for (const [g, w] of zip(scalars, wanted)) {
      if (contains(matchName, "Orientation") || contains(matchName, "Rotate")) {
        assert(_angleClose(g, w, 1e-3), `${matchName} ${repr(got)} ${repr(exp)}`);
      } else {
        assert(
          Math.abs(g - w) <= 1e-3 * Math.max(1.0, Math.abs(w)),
          `${matchName} ${repr(got)} ${repr(exp)}`,
        );
      }
    }
    if (truthy(expected.k)) {
      for (const [kf, [time, value]] of zip(prop.keyframes, expected.k)) {
        assert(Math.abs(kf.time - time) < 1e-4);
        expect(
          _close(
            Array.isArray(kf.value) ? kf.value : [kf.value],
            Array.isArray(value) ? value : [value],
            1e-3,
          ),
        ).toBe(true);
      }
    }
  }
}

describe("TestParent", () => {
  test.each([...sorted(_PARENT_OPS.keys())])("test_matches_ae[%#]", (childName: string) => {
    const project = parseProjectFresh(REPARENT);
    const [comp, child] = _layer(project, "PB", childName);
    const parentName = getOrThrow(_PARENT_OPS, childName);
    const parent = truthy(parentName)
      ? _next(comp.layers, (ly) => ly.name === parentName)
      : null;
    child.parent = parent;
    _assertTransform(child, comp, REPARENT_TRUTH.parent[childName].after);
  });

  test.each(_MORE_PARENT_OPS)(
    "test_more_matches_ae[%#]",
    (compName: string, childName: string, parentName: string) => {
      const project = parseProjectFresh(MORE);
      const [comp, child] = _layer(project, compName, childName);
      child.parent = _next(comp.layers, (ly) => ly.name === parentName);
      _assertTransform(child, comp, MORE_TRUTH.parent[childName].after);
    },
  );

  test("test_pixel_aspect_comp", () => {
    const project = parseProjectFresh(REPARENT);
    const [comp, child] = _layer(project, "PB_PAR2", "c3d_under_par2");
    child.parent = _next(comp.layers, (ly) => ly.name === "p_par2_rot");
    _assertTransform(child, comp, REPARENT_TRUTH.parent.c3d_under_par2.after);
  });

  test("test_zero_scale_parent_is_set_without_compensation", () => {
    const project = parseProjectFresh(REPARENT);
    const [comp, child] = _layer(project, "PB", "c_zero");
    child.parent = _next(comp.layers, (ly) => ly.name === "p_zero");
    expect(child.parent != null).toBe(true);
    expect(child.parent.name).toBe("p_zero");
    expect(valueEquals(child.transform.property("ADBE Position").value.slice(0, 2), [300.0, 200.0])).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Point conversions
// ---------------------------------------------------------------------------

const _POINT_LAYERS: [string, string][] = [
  ["PA_MAIN", "child2d_of_3d"],
  ["PA_MAIN", "child3d_of_3d"],
  ["PA_MAIN", "path_hold"],
  ["PA_MAIN", "zscale0_3d"],
  ["PA_MAIN", "tiny_scale_3d"],
  ["PA_MAIN", "stale3d_2d"],
  ["PA_MAIN", "child3d_of_stale2d"],
  ["PA_MAIN", "child2d_of_stale2d"],
  ["PA_MAIN", "path_stationary"],
  ["PA_MAIN", "path_offset_stretch"],
  ["PA_CAM", "plain3d_rigcam"],
  ["PA_CAM", "towards_rigcam"],
  ["PA_CAM", "cam_rig"],
  ["PA_CAMLATE", "plain3d_latecam"],
  ["PA_CAMLATE", "towards_latecam"],
  ["PA_PAR2", "rot30_par2"],
  ["PA_PAR2", "path_par2"],
  ["PA_PAR2", "rotx_par2"],
  ["PA_PAR2", "squarepx_in_par2"],
];
const _MORE_S2C: [string, string][] = [
  ["PH", "h_s2c_under_cam"],
  ["PH", "h_s2c_under_null_orient"],
  ["PH", "h_s2c_under_light"],
  ["PH", "v_down3"],
  ["PH_PAR2", "h_p2_s2c_sq_under_null"],
  ["PH_PAR2", "h_p2_s2c_par2_under_null"],
  ["PH_PAR2", "h_p2_s2c_text"],
  ["PH_PAR2", "h_p2_s2c_precomp"],
  ["PH_PAR2", "h_p2_s2c_3d_cam"],
];

describe("TestPointConversions", () => {
  test.each(_POINT_LAYERS)("test_matches_ae[%#]", (compName: string, layerName: string) => {
    const project = parseProjectFresh(GEOMETRY);
    const layer = asInstance(_layer(project, compName, layerName)[1], AVLayer);
    const truth = GEOMETRY_TRUTH[`${compName}/${layerName}`];
    for (const [index, time] of TIMES.entries()) {
      const row = truth[`t${index}`];
      for (const [point, expected] of zip(PTS, row.s2c)) {
        const got = layer.sourcePointToComp(point, time);
        assert(
          _close(got, expected, 1e-2 * Math.max(1.0, Math.max(...expected.map((v: number) => Math.abs(v)))) * 1e-1),
          `${time} ${repr(point)} ${repr(got)} ${repr(expected)}`,
        );
      }
      for (const [point, expected] of zip(CPTS, row.c2s)) {
        if (!Array.isArray(expected) || valueEquals(expected, [0, 0])) continue;
        const got = layer.compPointToSource(point, time);
        const tol = 1e-3 * Math.max(1.0, Math.max(...expected.map((v: number) => Math.abs(v))));
        assert(
          _close(got, expected, Math.max(tol, 1e-2)),
          `${time} ${repr(point)} ${repr(got)} ${repr(expected)}`,
        );
      }
    }
  });

  test.each(_MORE_S2C)("test_more_matches_ae[%#]", (compName: string, layerName: string) => {
    // 2D children of cameras / lights / oriented nulls, a 3-key vertical
    // path, and layers of a 2:1 pixel-aspect comp.
    const project = parseProjectFresh(MORE);
    const layer = asInstance(_layer(project, compName, layerName)[1], AVLayer);
    const rows = MORE_TRUTH.s2c[`${compName}/${layerName}`];
    for (const [index, time] of MORE_TIMES.entries()) {
      for (const [point, expected] of zip(PTS, rows[index])) {
        const got = layer.sourcePointToComp(point, time);
        expect(_close(got, expected, 1e-3)).toBe(true);
      }
    }
  });

  test("test_x_scale_zero_plane_raises", () => {
    const project = parseProjectFresh(GEOMETRY);
    const layer = asInstance(_layer(project, "PA_MAIN", "xscale0_2d")[1], AVLayer);
    raises(
      ValueError,
      () => {
        layer.compPointToSource([500.0, 400.0], 0.0);
      },
      "degenerate",
    );
  });

  test("test_overflow_raises", () => {
    const project = parseProjectFresh(GEOMETRY);
    // A 2D layer scaled to 110 %: 1.7e308 * 1.1 overflows to inf.
    const layer = asInstance(_layer(project, "PA_MAIN", "stale3d_2d")[1], AVLayer);
    raises(
      ValueError,
      () => {
        layer.sourcePointToComp([1.7e308, 1.7e308], 0.0);
      },
      "overflow",
    );
  });

  test("test_camera_default_position", () => {
    const project = parseProjectFresh(SAMPLES.div("models", "view", "draft3d_false.aep"));
    const comp = project.compositions[0];
    const camera = comp.cameraLayers[0];
    // AE 2026 (the sample's ExtendScript export): [960, 53.5, -2424.24242418]
    expect(
      _close(camera.transform.property("ADBE Position").value, [960.0, 53.5, -2424.24242418], 1e-5),
    ).toBe(true);
    const layer = asInstance(comp.layers.find((ly) => ly.name === "Dark Gray Solid 1"), AVLayer);
    // The camera sits on the default comp camera: c2s is the identity.
    expect(_close(layer.compPointToSource([100.0, 100.0], 0.0), [100.0, 100.0], 1e-6)).toBe(true);
  });
});

describe("TestMatrixLaws", () => {
  test("test_tiny_uniform_scale_inverts", () => {
    const m = Mat4.identity();
    for (let axis = 0; axis < 3; axis++) {
      m.row(axis)[axis] = 3e-4;
    }
    const inv = m.inverse();
    expect(isclose(inv.row(0)[0], 1 / 3e-4)).toBe(true);
  });

  test("test_plane_intersection_ignores_z_scale", () => {
    /** Law: a layer's Z scale does not move its z=0 plane. */
    const m = Mat4.identity();
    m.row(2)[2] = 0.0;
    m.row(0)[3] = 10.0;
    m.row(1)[3] = 20.0;
    expect(
      _close(intersectLayerPlane(m, [5.0, 6.0, -100.0], [0.0, 0.0, 1.0]), [-5.0, -14.0], 1e-12),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sourceRectAtTime
// ---------------------------------------------------------------------------

describe("TestSourceRect", () => {
  test.each(["shape_anim_offset", "text_anim_offset"])("test_time_is_layer_time[%#]", (layerName: string) => {
    const project = parseProjectFresh(GEOMETRY);
    const [_, layer] = _layer(project, "PA_TIME", layerName);
    const truth = GEOMETRY_TRUTH[`PA_TIME/${layerName}`];
    for (const [index, time] of TIMES.entries()) {
      const rect = _rect(layer, time);
      if (rect === null) return;
      expect(_close(rect, truth[`t${index}`].rect, 1e-3)).toBe(true);
    }
  });

  test.each(sorted(Object.keys(TEXT_TRUTH.text)))("test_tracking_and_box_inset[%#]", (name: string) => {
    const project = parseProjectFresh(TEXT);
    const [_, layer] = _layer(project, "PF_TEXT", name);
    // 0.006 px: AE's first box baseline sits that much lower than the
    // composer's for Arial (unmodelled residual).
    const rect = _rect(layer, 0.0);
    if (rect === null) return;
    expect(_close(rect, TEXT_TRUTH.text[name].rect, 1e-2)).toBe(true);
  });

  test.each(sorted(Object.keys(MORE_TRUTH.text)))("test_point_text_indents[%#]", (name: string) => {
    const project = parseProjectFresh(MORE);
    const [_, layer] = _layer(project, "PH_TEXT", name);
    const rect = _rect(layer, 0.0);
    if (rect === null) return;
    expect(_close(rect, MORE_TRUTH.text[name].rect, 1e-2)).toBe(true);
  });

  test("test_three_d_model_layer", () => {
    const project = parseProjectFresh(LAYER_DIR.div("three_d_model_layer.aep"));
    const layer = asInstance(project.compositions[0].layers[0], ThreeDModelLayer);
    // AE 2026 (the sample's ExtendScript export): anchor [0, 0, 0].
    expect(valueEquals(layer.transform.property("ADBE Anchor Point").value, [0.0, 0.0, 0.0])).toBe(true);
    expect(_close(layer.sourcePointToComp([0.0, 0.0], 0.0), [960.0, 540.0], 1e-6)).toBe(true);
    raises(
      NotImplementedError,
      () => {
        layer.sourceRectAtTime(0.0, false);
      },
      "3D model",
    );
  });
});
