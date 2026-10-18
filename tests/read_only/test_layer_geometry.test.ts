/**
 * Tests for AVLayer geometry methods against AE 2026 probe fixtures.
 *
 * `geometry_probe.aep` / `camera_rigs.aep` were generated headlessly in
 * AE 2026 (2026-07-14) together with per-method ground-truth JSONs read back
 * via ExtendScript: `sourcePointToComp` / `compPointToSource` for seven layer
 * setups at two times, `calculateTransformFromPoints` for eleven point sets
 * (including mirrored and non-orthogonal ones), `sourceRectAtTime` for every
 * layer kind, and the point conversions under four camera rigs.
 */

// `from __future__ import annotations` and `typing` imports are dropped.
// `json` → JSON, `math.isfinite` → Number.isFinite, `pathlib.Path` → pyrt Path.
// Keyword arguments `time=` become positional arguments (§5); `abs=` becomes the
// tolerance options object of pyrt `approx`.

import { describe, expect, test } from "bun:test";

import {
  NotImplementedError,
  Path,
  StopIteration,
  ValueError,
  float,
  floatRepr,
  getOrThrow,
  assert,
  valueEquals,
  repr,
} from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { parseProject } from "../conftest.ts";
import { fontVersionString } from "../../src/py_aep/svg/fonts.ts";
import { AVLayer, CompItem, Layer, Project } from "../../src/py_aep/index.ts";
import { asInstance } from "../helpers.ts";
import { approx, raises, skip, importorskip } from "../support/pytest.ts";
import { format, sorted, split } from "../support/python.ts";

const SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models", "layer");
const GEOMETRY_AEP = SAMPLES_DIR.div("geometry_probe.aep");
const CAMERAS_AEP = SAMPLES_DIR.div("camera_rigs.aep");
const SHAPES_AEP = SAMPLES_DIR.div("shape_source_rect.aep");
const AUTO_ORIENT_AEP = SAMPLES_DIR.div("auto_orient.aep");
const TEXT_INK_AEP = SAMPLES_DIR.div("text_ink.aep");

const POINTS = [
  [0.0, 0.0],
  [100.0, 50.0],
  [960.0, 540.0],
];
const CAMERA_POINTS = [
  [0.0, 0.0],
  [100.0, 50.0],
  [200.0, 100.0],
];

/**
 * Skip where the text cannot be measured as the fixture was: without
 * uharfbuzz (Python 3.7), or with a font missing or at another version
 * than the one AE embedded.
 *
 * Returns true when the test must be skipped; callers `return` on true.
 */
function _skipUnlessFontsMatch(layer: Layer): boolean {
  // TODO(port): harfbuzzjs (0.4.7) vs uharfbuzz shaping cannot be closed here. This
  // check only proves the package resolves; text-layer sourceRectAtTime cases
  // (TEXT_INK fixture) may differ from uharfbuzz-measured advances.
  if (!importorskip("harfbuzzjs")) return true;
  const text = layer.text;
  assert(text != null, "not a text layer");
  const document = text.property("ADBE Text Document").value;
  for (const font of document._fonts) {
    if (!valueEquals(fontVersionString(font.postScriptName), font.version)) {
      skip(`${font.postScriptName} not installed at the fixture's version`);
      return true;
    }
  }
  return false;
}

// `str(list_of_floats)` for assertion messages (POINTS are all floats).
function _ptRepr(pt: number[]): string {
  return `[${pt.map(floatRepr).join(", ")}]`;
}

// Shapes of the AE probe JSON fixtures.
interface PointProbe {
  ok: boolean;
  value: number[];
}
interface PointsEntry {
  s2c: PointProbe[];
  c2s: PointProbe[];
}
interface CtfpValue {
  anchorPoint: number[];
  position: number[];
  xRotation: number;
  yRotation: number;
  zRotation: number;
  scale: number[];
}
interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}
type PointsProbeJson = Record<string, Record<string, PointsEntry>>;
type CameraRigsProbeJson = Record<string, { conv: Record<string, PointsEntry> }>;
type CtfpProbeJson = Record<string, Record<string, { value: CtfpValue }>>;
type RectsProbeJson = Record<string, Record<string, { value: Rect }>>;
type ShapeRectsProbeJson = Record<string, { time: number; ext: Rect; noext: Rect }>;
// Per layer: `autoOrient` (a string) plus one record of points per `t<time>` key.
type AutoOrientProbeJson = Record<string, Record<string, Record<string, number[]> | string>>;
type TextInkProbeJson = Record<string, { ext: Rect; noext: Rect }>;

function _fixture<T>(name: string): T {
  return JSON.parse(SAMPLES_DIR.div(name).readText("utf-8"));
}

// NOTE(port): local stand-in for Python `next(genexpr)`; first match or StopIteration, as in CPython.
function _next<T>(items: Iterable<T>, pred: (x: T) => boolean): T {
  for (const x of items) if (pred(x)) return x;
  throw new StopIteration();
}

function _comp(project: Project, name: string): CompItem {
  return _next(project.compositions, (c) => valueEquals(c.name, name));
}

function _probeComp(project: Project): CompItem {
  return _comp(project, "PROBE_MAIN");
}

function _layer(comp: CompItem, name: string): AVLayer {
  return asInstance(
    _next(comp.layers, (ly) => valueEquals(ly.name, name)),
    AVLayer,
  );
}

// `[*v]` on a transform value: a scalar is not iterable in Python either.
function _vec(v: number | number[]): number[] {
  if (typeof v === "number") throw new TypeError("'float' object is not iterable");
  return v;
}

describe("TestPointConversions", () => {
  /** sourcePointToComp / compPointToSource vs the AE probe values. */

  test.each([
    ["time0", 0.0],
    ["time1.5", 1.5],
  ])("test_all_layers_match_ae[%#]", (timeKey, timeVal) => {
    const expected = _fixture<PointsProbeJson>("geometry_points_probe.json")[timeKey];
    const comp = _probeComp(parseProject(GEOMETRY_AEP));
    for (const [layerName, entry] of Object.entries(expected)) {
      const layer = _layer(comp, layerName);
      for (const [pi, pt] of POINTS.entries()) {
        const want = entry["s2c"][pi];
        if (want["ok"]) {
          const got = layer.sourcePointToComp(pt, timeVal);
          assert(approx(got, want["value"], { abs: 5e-3 }), `${layerName} s2c ${_ptRepr(pt)} @ ${floatRepr(timeVal)}`);
        }
        const wantC2s = entry["c2s"][pi];
        if (wantC2s["ok"]) {
          const got = layer.compPointToSource(pt, timeVal);
          assert(
            approx(got, wantC2s["value"], { abs: 5e-3 }),
            `${layerName} c2s ${_ptRepr(pt)} @ ${floatRepr(timeVal)}`,
          );
        }
      }
    }
  });

  test("test_default_time_is_comp_time", () => {
    // The saved playhead of the fixture is 0, so the no-time call must
    // equal the explicit t=0 call (AE evaluates at the comp time).
    const comp = _probeComp(parseProject(GEOMETRY_AEP));
    expect(comp.time).toBe(0.0);
    const layer = _layer(comp, "solid_keyed");
    expect(approx(layer.sourcePointToComp([0.0, 0.0]), layer.sourcePointToComp([0.0, 0.0], 0.0))).toBe(true);
  });

  test("test_roundtrip_inverse_2d", () => {
    const comp = _probeComp(parseProject(GEOMETRY_AEP));
    const layer = _layer(comp, "solid_xform");
    for (const pt of POINTS) {
      const compPt = layer.sourcePointToComp(pt, 0.0);
      const back = layer.compPointToSource(compPt, 0.0);
      expect(approx(back, pt, { abs: 1e-6 })).toBe(true);
    }
  });

  test("test_invalid_point_raises", () => {
    const comp = _probeComp(parseProject(GEOMETRY_AEP));
    const layer = _layer(comp, "solid_default");
    raises(ValueError, () => layer.sourcePointToComp([1.0, 2.0, 3.0]));
  });
});

describe("TestPointConversionsUnderCameras", () => {
  /** The four camera rigs: s2c is camera-independent, c2s is not. */

  test.each([
    ["CAM_ONE", "one_node"],
    ["CAM_TWO", "two_node"],
    ["CAM_KEYED", "keyed_zoom"],
    ["CAM_NONE", "no_camera"],
  ])("test_rig_matches_ae[%#]", (compName, fixtureKey) => {
    const expected = _fixture<CameraRigsProbeJson>("camera_rigs_probe.json")[fixtureKey]["conv"];
    const project = parseProject(CAMERAS_AEP);
    const comp = _comp(project, compName);
    const layer = _layer(comp, "target3d");
    for (const [timeKey, entry] of Object.entries(expected)) {
      const timeVal = float(timeKey.slice(1));
      for (const [pi, pt] of CAMERA_POINTS.entries()) {
        const want = entry["s2c"][pi];
        if (want["ok"]) {
          const got = layer.sourcePointToComp(pt, timeVal);
          assert(approx(got, want["value"], { abs: 5e-3 }), `${compName} s2c ${_ptRepr(pt)} @ ${floatRepr(timeVal)}`);
        }
        const wantC2s = entry["c2s"][pi];
        if (wantC2s["ok"]) {
          const got = layer.compPointToSource(pt, timeVal);
          assert(
            approx(got, wantC2s["value"], { abs: 5e-3 }),
            `${compName} c2s ${_ptRepr(pt)} @ ${floatRepr(timeVal)}`,
          );
        }
      }
    }
  });
});

describe("TestCalculateTransformFromPoints", () => {
  /** All eleven AE-probed point sets, on 2D and 3D layers. */

  // (fixture group, key) -> (tl, tr, bl) inputs used in the probe run.
  const _SQ = 141.4213562373095; // 200 * sin(45 deg)
  const SETS = new Map<string, number[][]>([
    [
      "identity_bl",
      [
        [0, 0, 0],
        [200, 0, 0],
        [0, 100, 0],
      ],
    ],
    [
      "identity_br",
      [
        [0, 0, 0],
        [200, 0, 0],
        [200, 100, 0],
      ],
    ],
    [
      "translated",
      [
        [300, 200, 0],
        [500, 200, 0],
        [300, 300, 0],
      ],
    ],
    [
      "rot90",
      [
        [0, 0, 0],
        [0, 200, 0],
        [-100, 0, 0],
      ],
    ],
    [
      "scaled2x",
      [
        [0, 0, 0],
        [400, 0, 0],
        [0, 200, 0],
      ],
    ],
    [
      "tilt_y45",
      [
        [0, 0, 0],
        [_SQ, 0, -_SQ],
        [0, 100, 0],
      ],
    ],
  ]);
  const MIRROR_SETS = new Map<string, number[][]>([
    [
      "mirrorX",
      [
        [0, 0, 0],
        [-200, 0, 0],
        [0, 100, 0],
      ],
    ],
    [
      "mirrorY",
      [
        [0, 0, 0],
        [200, 0, 0],
        [0, -100, 0],
      ],
    ],
    [
      "mirrorBoth",
      [
        [0, 0, 0],
        [-200, 0, 0],
        [0, -100, 0],
      ],
    ],
  ]);
  const FOOTAGE_SETS = new Map<string, number[][]>([
    [
      "identity_srcdims",
      [
        [0, 0, 0],
        [640, 0, 0],
        [0, 346, 0],
      ],
    ],
    [
      "rect200x100",
      [
        [0, 0, 0],
        [200, 0, 0],
        [0, 100, 0],
      ],
    ],
  ]);

  function _assertMatches(got: Record<string, number | number[]>, want: CtfpValue): void {
    expect(valueEquals(got["anchor_point"], want["anchorPoint"])).toBe(true);
    expect(approx(got["position"], want["position"], { abs: 1e-9 })).toBe(true);
    expect(approx(got["x_rotation"], want["xRotation"], { abs: 1e-4 })).toBe(true);
    expect(approx(got["y_rotation"], want["yRotation"], { abs: 1e-4 })).toBe(true);
    expect(approx(got["z_rotation"], want["zRotation"], { abs: 1e-4 })).toBe(true);
    expect(approx(got["scale"], want["scale"], { abs: 1e-4 })).toBe(true);
  }

  test.each([["layer2d"], ["layer3d"]])("test_solid_point_sets[%#]", (layerKey) => {
    const expected = _fixture<CtfpProbeJson>("geometry_ctfp_probe.json")[layerKey];
    const comp = _probeComp(parseProject(GEOMETRY_AEP));
    const layer = _layer(comp, layerKey === "layer2d" ? "solid_default" : "solid_3d");
    for (const [key, [tl, tr, bl]] of SETS) {
      const got = layer.calculateTransformFromPoints(tl, tr, bl);
      _assertMatches(got, expected[key]["value"]);
    }
  });

  test("test_mirrored_point_sets", () => {
    const expected = _fixture<CtfpProbeJson>("geometry_ctfp_probe2.json")["solid"];
    const comp = _probeComp(parseProject(GEOMETRY_AEP));
    const layer = _layer(comp, "solid_default");
    for (const [key, [tl, tr, bl]] of MIRROR_SETS) {
      const got = layer.calculateTransformFromPoints(tl, tr, bl);
      _assertMatches(got, expected[key]["value"]);
    }
  });

  test("test_source_dimension_divisor", () => {
    // 640x346 footage: confirms the scale divisor is the SOURCE size.
    const expected = _fixture<CtfpProbeJson>("geometry_ctfp_probe2.json")["footage"];
    const comp = _probeComp(parseProject(GEOMETRY_AEP));
    const layer = _layer(comp, "footage_layer");
    for (const [key, [tl, tr, bl]] of FOOTAGE_SETS) {
      const got = layer.calculateTransformFromPoints(tl, tr, bl);
      _assertMatches(got, expected[key]["value"]);
    }
  });

  test("test_degenerate_points_raise", () => {
    const comp = _probeComp(parseProject(GEOMETRY_AEP));
    const layer = _layer(comp, "solid_default");
    raises(ValueError, () => layer.calculateTransformFromPoints([0, 0, 0], [0, 0, 0], [0, 1, 0]));
    // collinear
    raises(ValueError, () => layer.calculateTransformFromPoints([0, 0, 0], [1, 0, 0], [2, 0, 0]));
  });
});

describe("TestSourceRectAtTime", () => {
  /** Footage/solid/precomp/shape rects; text refuses. */

  test("test_rects_match_ae", () => {
    const expected = _fixture<RectsProbeJson>("geometry_rects_probe.json");
    const comp = _probeComp(parseProject(GEOMETRY_AEP));
    for (const layerName of [
      "solid_default",
      "solid_xform",
      "solid_parented",
      "solid_3d",
      "solid_keyed",
      "precomp_layer",
      "footage_layer",
      "shape_rect",
    ]) {
      const layer = _layer(comp, layerName);
      for (const timeVal of [0.0, 1.5, 2.5]) {
        for (const extents of [false, true]) {
          const suffix = extents ? "ext" : "noext";
          const want = expected[layerName][`t${format(timeVal, "g")}_${suffix}`]["value"];
          const got = layer.sourceRectAtTime(timeVal, extents);
          expect(approx(got["top"], want["top"])).toBe(true);
          expect(approx(got["left"], want["left"])).toBe(true);
          expect(approx(got["width"], want["width"])).toBe(true);
          expect(approx(got["height"], want["height"])).toBe(true);
        }
      }
    }
  });

  test.each([["text_point"], ["text_box"], ["text_animated"]])("test_text_rects_match_ae[%#]", (layerName) => {
    const expected = _fixture<RectsProbeJson>("geometry_rects_probe.json")[layerName];
    const layer = _layer(_probeComp(parseProject(GEOMETRY_AEP)), layerName);
    if (_skipUnlessFontsMatch(layer)) return;
    for (const [key, record] of Object.entries(expected)) {
      const [timeKey, suffix] = split(key, "_");
      const got = layer.sourceRectAtTime(float(timeKey.slice(1)), suffix === "ext");
      for (const side of ["top", "left", "width", "height"] as const) {
        expect(approx(got[side], record["value"][side], { abs: 1e-3 })).toBe(true);
      }
    }
  });

  test("test_invalid_args_raise", () => {
    const comp = _probeComp(parseProject(GEOMETRY_AEP));
    const layer = _layer(comp, "solid_default");
    raises(TypeError, () =>
      // @ts-expect-error deliberately passes a list time to check runtime validation
      layer.sourceRectAtTime([0.0], false),
    );
    raises(TypeError, () =>
      // @ts-expect-error deliberately passes a string extents to check runtime validation
      layer.sourceRectAtTime(0.0, "yes"),
    );
  });
});

describe("TestCalculateTransformFromPointsNumerics", () => {
  /**
   * The returned transform must be finite whenever the inputs are.
   *
   * The method validates that its points are finite, and its result is
   * documented as assignable to the transform properties - an `inf` scale is
   * not. `_vec3_norm` computed `sqrt(x*x + y*y + z*z)`, whose intermediate
   * square overflows to `inf` above ~1.34e154, so finite-but-huge points
   * produced a non-finite scale.
   */

  test.each([[1e6], [1e100], [1e154], [1e200], [1e300]])(
    "test_huge_but_finite_points_give_a_finite_transform[%#]",
    (magnitude) => {
      const layer = _layer(_probeComp(parseProject(GEOMETRY_AEP)), "solid_default");
      const got = layer.calculateTransformFromPoints([0.0, 0.0, 0.0], [magnitude, 0.0, 0.0], [0.0, magnitude, 0.0]);
      const values = [
        ..._vec(got["anchor_point"]),
        ..._vec(got["position"]),
        ..._vec(got["scale"]),
        got["x_rotation"],
        got["y_rotation"],
        got["z_rotation"],
      ];
      assert(
        values.every((v) => Number.isFinite(v)),
        repr(got),
      );
    },
  );

  test("test_scale_is_proportional_at_huge_magnitudes", () => {
    // 1e300 wide over a source `width` must scale to 1e300 / width * 100,
    // not saturate.
    const layer = _layer(_probeComp(parseProject(GEOMETRY_AEP)), "solid_default");
    const got = layer.calculateTransformFromPoints([0.0, 0.0, 0.0], [1e300, 0.0, 0.0], [0.0, 1e300, 0.0]);
    expect(approx(_vec(got["scale"])[0], (1e300 / layer.width) * 100.0)).toBe(true);
    expect(approx(_vec(got["scale"])[1], (1e300 / layer.height) * 100.0)).toBe(true);
  });
});

const _SHAPE_TRUTH = _fixture<ShapeRectsProbeJson>("shape_source_rect_probe.json");
const _UNMODELED_SHAPES = new Set(["mod_offset", "ps_k2_p5.5_r50"]);

describe("TestShapeSourceRect", () => {
  /**
   * Shape layers against AE 2026 (`shape_source_rect.aep`, built headlessly
   * in AE 2026 with its `sourceRectAtTime` read back): shape types,
   * stroke joins/caps/miter limits, group transforms and nesting, disabled
   * items, paint order and path operations.
   */

  // `@pytest.fixture(scope="class") def comp` - parsed once, on first use.
  let _shapesComp: CompItem | undefined;
  function compFixture(): CompItem {
    _shapesComp ??= _comp(parseProject(SHAPES_AEP), "SHAPE_RECTS");
    return _shapesComp;
  }

  const SHAPE_NAMES = sorted(Object.keys(_SHAPE_TRUTH).filter((n) => !_UNMODELED_SHAPES.has(n)));
  const SHAPE_CASES = SHAPE_NAMES.flatMap((name) => [false, true].map((extents): [string, boolean] => [name, extents]));

  test.each(SHAPE_CASES)("test_matches_ae[%#]", (name, extents) => {
    const comp = compFixture();
    const record = _SHAPE_TRUTH[name];
    const want = record[extents ? "ext" : "noext"];
    const got = _layer(comp, name).sourceRectAtTime(record["time"], extents);
    for (const key of ["top", "left", "width", "height"] as const) {
      // AE measures in single precision.
      assert(approx(got[key], want[key], { abs: 1e-3 }), key);
    }
  });

  test.each(sorted(_UNMODELED_SHAPES).map((name) => [name]))("test_unmodeled_constructs_raise[%#]", (name) => {
    const comp = compFixture();
    raises(NotImplementedError, () => _layer(comp, name).sourceRectAtTime(0.0, false));
  });
});

const _ORIENT_TRUTH = _fixture<AutoOrientProbeJson>("auto_orient_probe.json");

describe("TestAutoOrientPointConversions", () => {
  /**
   * Point conversions under auto-orientation and camera/light parents
   * against AE 2026 (`auto_orient.aep`, built headlessly in AE 2026
   * with its point conversions read back): along 2D/3D paths
   * (straight, curved, eased, with the layer's own rotations, at and past
   * keyframes), towards the default and a moving camera, and children of
   * an oriented null, two-node and one-node cameras, spot, parallel and
   * point lights.
   */

  let _comps: Map<string, CompItem> | undefined;
  function compsFixture(): Map<string, CompItem> {
    _comps ??= new Map(parseProject(AUTO_ORIENT_AEP).compositions.map((comp) => [String(comp.name), comp]));
    return _comps;
  }

  test.each(sorted(Object.keys(_ORIENT_TRUTH)).map((key) => [key]))("test_matches_ae[%#]", (key) => {
    const comps = compsFixture();
    const [compName, layerName] = split(key, "/", 1);
    const layer = _layer(getOrThrow(comps, compName), layerName);
    for (const [timeKey, record] of Object.entries(_ORIENT_TRUTH[key])) {
      if (!timeKey.startsWith("t")) continue;
      assert(typeof record !== "string", timeKey);
      const time = float(timeKey.slice(1));
      // All three conversions run before any comparison, as in the Python tuple.
      const probes: [string, number[]][] = [
        ["p00", layer.sourcePointToComp([0.0, 0.0], time)],
        ["p10050", layer.sourcePointToComp([100.0, 50.0], time)],
        ["inv", layer.compPointToSource([500.0, 400.0], time)],
      ];
      for (const [point, got] of probes) {
        assert(approx(got, record[point], { abs: 1e-2 }), `(${repr(timeKey)}, ${repr(point)})`);
      }
    }
  });
});

const _TEXT_TRUTH = _fixture<TextInkProbeJson>("text_ink_probe.json");

describe("TestTextSourceRect", () => {
  /**
   * Text-layer ink boxes against AE 2026 (`text_ink.aep`, built headlessly in AE 2026 with
   * its `sourceRectAtTime` read back): sizes 8-500, CFF and
   * TrueType fonts, justification, leading, tracking and stroke.
   */

  let _textComp: CompItem | undefined;
  function compFixture(): CompItem {
    _textComp ??= _comp(parseProject(TEXT_INK_AEP), "TEXT_INK");
    return _textComp;
  }

  const TEXT_CASES = sorted(Object.keys(_TEXT_TRUTH)).flatMap((name) =>
    [false, true].map((extents): [string, boolean] => [name, extents]),
  );

  test.each(TEXT_CASES)("test_matches_ae[%#]", (name, extents) => {
    const layer = _layer(compFixture(), name);
    if (_skipUnlessFontsMatch(layer)) return;
    const want = _TEXT_TRUTH[name][extents ? "ext" : "noext"];
    const got = layer.sourceRectAtTime(0.0, extents);
    for (const side of ["top", "left", "width", "height"] as const) {
      // AE measures in single precision.
      assert(approx(got[side], want[side], { abs: 1e-3 }), side);
    }
  });
});
