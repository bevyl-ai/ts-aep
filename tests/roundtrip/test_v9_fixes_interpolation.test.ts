/**
 * Regression tests for the v9 fuzz findings on keyframe interpolation.
 *
 * After Effects numbers below were measured on AE 2026 running the same
 * scripted operations (`setValueAtTime`, `setTemporalEaseAtKey`,
 * `setInterpolationTypeAtKey`, ...) on layers of the same size in a comp of the
 * same size, pixel aspect and frame rate, then reading `valueAtTime` and the key
 * attributes back. Comps are 1920x1080 at 24 fps unless stated.
 */

import { describe, expect, test } from "bun:test";
import { Path, StopIteration, ValueError, float, getMember, getOrThrow, hasMember, assert, valueEquals, setMember } from "../../src/pyrt/index.ts";
import { approx, makeTmpPath, raises, type ApproxOperand } from "../../src/pyrt/pytest.ts";
import * as py_aep from "../../src/py_aep/index.ts";
import { AVLayer, CompItem, Keyframe, KeyframeEase, Layer, Property, PropertyGroup, Shape, parse } from "../../src/py_aep/index.ts";
import type { PropertyValue } from "../../src/py_aep/models/properties/keyframe.ts";
import { TdumChunk } from "../../src/py_aep/binary/property_chunks.ts";
import { KfNoValue } from "../../src/py_aep/binary/ldat_chunks.ts";
import { KeyframeInterpolationType as KIT } from "../../src/py_aep/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { asInstance, projectBytes } from "../helpers.ts";

const TG = "ADBE Transform Group";
const LIN = KIT.LINEAR;
const BEZ = KIT.BEZIER;
const HOLD = KIT.HOLD;

const SAMPLES = new Path(import.meta.path).parent.parent.parent.div("samples");

function _leaves(group: PropertyGroup): Property[] {
  const out: Property[] = [];
  for (const prop of group.properties) {
    out.push(...(hasMember(prop, "properties") ? _leaves(asInstance(prop, PropertyGroup)) : [asInstance(prop, Property)]));
  }
  return out;
}

/** Python `next(x for x in items if pred(x))`: raises StopIteration when nothing matches. */
function _next<T>(items: Iterable<T>, pred: (x: T) => boolean): T {
  for (const x of items) {
    if (pred(x)) return x;
  }
  throw new StopIteration();
}

function _comp(width = 1920, height = 1080, par = 1.0, fps = 24.0): [py_aep.Application, CompItem] {
  const app = py_aep.newProject();
  const comp = app.project.rootFolder.addComp("C", width, height, par, 10.0, fps);
  return [app, comp];
}

function _solid(comp: CompItem, w = 200, h = 100, threeD = false): AVLayer {
  const layer = comp.addSolid([1.0, 0.0, 0.0], "L", w, h, 1.0);
  if (threeD) layer.threeDLayer = true;
  return layer;
}

function _effect(layer: Layer, effect: string): Property {
  const added = asInstance(asInstance(layer.effects, PropertyGroup).addProperty(effect), PropertyGroup);
  return asInstance(added.property(`${effect}-0001`), Property);
}

function _keys<P extends Property>(prop: P, keys: [number, PropertyValue][]): P {
  for (const [t, v] of keys) prop.setValueAtTime(t, v);
  return prop;
}

function _ease(kf: Keyframe, inEase: number[][], outEase: number[][]): void {
  kf.inTemporalEase = inEase.map(([s, i]) => new KeyframeEase(s, i));
  kf.outTemporalEase = outEase.map(([s, i]) => new KeyframeEase(s, i));
}

function _types(kf: Keyframe, inType: KIT, outType: KIT): void {
  kf.inInterpolationType = inType;
  kf.outInterpolationType = outType;
}

/** A number or a (nested) list of numbers. */
type _Nested = number | readonly _Nested[];

function _flat(value: _Nested): number[] {
  if (typeof value !== "number") return value.flatMap((item) => _flat(item));
  return [value];
}

function _speeds(eases: KeyframeEase[]): number[] {
  return _flat(eases.map((e) => [e.speed, e.influence]));
}

function _verts(shape: Shape): number[] {
  return _flat(shape.vertices.map((v) => [...v]));
}

/** `kf._stored_value[2]`: the stored Z of a 3-D key. */
function _storedZ(kf: Keyframe): number {
  const stored = kf._storedValue;
  assert(Array.isArray(stored));
  return stored[2];
}

function _reparse(app: py_aep.Application, tmpPath: Path): Layer {
  const path = tmpPath.div("out.aep");
  app.project.save(path);
  const comp = _next(parse(path).project.compositions, (c) => c.name === "C");
  return _next(comp.layers, (lyr) => lyr.name === "L");
}

function _reparseComp(app: py_aep.Application, tmpPath: Path): CompItem {
  const path = tmpPath.div("out.aep");
  app.project.save(path);
  return _next(parse(path).project.compositions, (c) => c.name === "C");
}

type _Approx = { expected: number | number[]; abs: number };

/** `pytest.approx(_flat(value) if isinstance(value, list) else value, abs=abs)`: the expected side, compared with `_eq_approx`. */
function _approx(value: _Nested, abs: number = 1e-6): _Approx {
  return { expected: typeof value !== "number" ? _flat(value) : value, abs };
}

/** `actual == _approx(...)`, through pyrt's `approx`. */
function _eqApprox(actual: ApproxOperand, a: _Approx): boolean {
  return approx(actual, a.expected, { abs: a.abs });
}

// NOTE(port): pytest.raises((A, B)) - local helper accepts any listed class, same as CPython tuple matching (instanceof any); re-throws otherwise like pytest.
function raisesAny(classes: (abstract new (...args: never[]) => Error)[], fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    if (e instanceof Error && classes.some((c) => e instanceof c)) return e;
    throw e;
  }
  throw new Error("DID NOT RAISE");
}

describe("TestFootageAnchorPointZ", () => {
  /** F1: a footage layer's Anchor Point Z is stored in layer heights. */

  test("test_static_z_normalized_by_height", () => {
    const tmpPath = makeTmpPath();
    // AE 2026 writes [100, 50, 80] on a 400x300 3-D solid as
    // [100 / 400, 50 / 300, 80 / 300].
    const [app, comp] = _comp();
    const layer = _solid(comp, 400, 300, true);
    const anchor = layer.property(TG).property("ADBE Anchor Point");
    anchor.value = [100, 50, 80];
    expect(_eqApprox(getMember(anchor._cdat, "values").slice(0, 3), _approx([0.25, 50 / 300, 80 / 300]))).toBe(true);
    expect(_eqApprox(anchor.value, _approx([100.0, 50.0, 80.0]))).toBe(true);
    const again = _reparse(app, tmpPath).property(TG).property("ADBE Anchor Point");
    expect(_eqApprox(again.value, _approx([100.0, 50.0, 80.0]))).toBe(true);
  });
});

describe("TestTemporalAutoBezierParallelKinds", () => {
  /** F2 / F3: temporal auto-bezier on a path or an Orientation key. */

  test("test_mask_path_auto_bezier", () => {
    // AE 2026: keys report speed 1; the in-between shapes below.
    const [_app, comp] = _comp();
    const layer = _solid(comp, 3000, 200);
    const path = asInstance(layer.masks, PropertyGroup).addProperty("ADBE Mask Atom").property("ADBE Mask Shape");
    _keys(path, [
      [0, new Shape([[0, 0], [100, 0], [100, 100]], undefined, undefined, { closed: true })],
      [1, new Shape([[20, 10], [150, 0], [120, 140]], undefined, undefined, { closed: true })],
      [2, new Shape([[50, 50], [160, 30], [100, 180]], undefined, undefined, { closed: true })],
    ]);
    const kf = path.keyframes[1];
    kf.temporalAutoBezier = true;
    expect(kf.temporalContinuous).toBe(true);
    expect(_eqApprox(_speeds(kf.inTemporalEase), _approx([[1.0, 100 / 6]]))).toBe(true);
    expect(_eqApprox(_speeds(kf.outTemporalEase), _approx([[1.0, 100 / 6]]))).toBe(true);
    expect(_eqApprox(_verts(path.valueAtTime(0.5)), _approx([[10, 5], [125, 0], [110, 120]], 1e-4))).toBe(true);
    expect(_eqApprox(_verts(path.valueAtTime(1.5)), _approx([[35, 30], [155, 15], [110, 160]], 1e-4))).toBe(true);
  });

  test("test_orientation_auto_bezier", () => {
    const [_app, comp] = _comp();
    const layer = _solid(comp, 400, 300, true);
    const orient = _keys(layer.property(TG).property("ADBE Orientation"), [
      [0, [0, 0, 0]],
      [1, [40, 30, 20]],
      [2, [90, 10, 300]],
    ]);
    const kf = orient.keyframes[1];
    kf.temporalAutoBezier = true;
    expect(_eqApprox(_speeds(kf.inTemporalEase), _approx([[1.0, 100 / 6]]))).toBe(true);
    expect(
      _eqApprox(orient.valueAtTime(1.208333333), _approx([52.6749651539118, 31.754058708850526, 1.4806168873979855], 1e-4)),
    ).toBe(true);
  });
});

describe("TestInterpolationTypeWinsOverAutoBezier", () => {
  /** F4: a LINEAR / HOLD side wins over temporal auto-bezier. */

  test("test_linear_sides_on_auto_bezier_key", () => {
    const [_app, comp] = _comp();
    const slider = _keys(_effect(_solid(comp), "ADBE Slider Control"), [
      [0, 0],
      [1, 100],
      [2.5, 20],
    ]);
    const kf = slider.keyframes[1];
    kf.temporalAutoBezier = true;
    _types(kf, LIN, LIN);
    expect(kf.temporalAutoBezier).toBe(true);
    expect(kf.temporalContinuous).toBe(false);
    expect(_eqApprox(slider.valueAtTime(0.375), _approx(37.5))).toBe(true);
    expect(_eqApprox(slider.valueAtTime(1.5), _approx(73.33333333333334))).toBe(true);
    expect(_eqApprox(kf.inTemporalEase[0].speed, _approx(100.0))).toBe(true);
    expect(_eqApprox(kf.outTemporalEase[0].speed, _approx(-53.333333333333336))).toBe(true);
  });

  test("test_bezier_side_of_last_key_facing_linear", () => {
    // AE 2026: the BEZIER in side of an auto-bezier LAST key whose out
    // side is LINEAR reports speed 0.
    const [_app, comp] = _comp();
    const angle = _keys(_effect(_solid(comp), "ADBE Angle Control"), [
      [0, 0],
      [1, 50],
      [2, 200],
    ]);
    const kf = angle.keyframes[2];
    kf.temporalAutoBezier = true;
    _types(kf, BEZ, LIN);
    expect(valueEquals([kf.temporalAutoBezier, kf.temporalContinuous], [true, true])).toBe(true);
    expect(_eqApprox(kf.inTemporalEase[0].speed, _approx(0.0))).toBe(true);
    expect(_eqApprox(angle.valueAtTime(1.583333333), _approx(147.93916302166082))).toBe(true);
  });
});

describe("TestInHoldSegments", () => {
  /** F5: an in-HOLD key holds the segment START value. */

  test("test_colour", () => {
    const [_app, comp] = _comp();
    const color = _keys(_effect(_solid(comp, 3000, 200), "ADBE Color Control"), [
      [0, [1, 0, 0, 1]],
      [1, [0, 0.5, 1, 1]],
      [2, [0.2, 1, 0.3, 1]],
    ]);
    _types(color.keyframes[1], HOLD, HOLD);
    expect(_eqApprox(color.valueAtTime(0.5), _approx([1.0, 0.0, 0.0, 1.0]))).toBe(true);
  });

  test("test_orientation", () => {
    const [_app, comp] = _comp();
    const null_ = comp.addNull();
    null_.threeDLayer = true;
    const orient = _keys(null_.property(TG).property("ADBE Orientation"), [
      [0, [0, 0, 0]],
      [1, [40, 30, 20]],
      [2, [90, 10, 300]],
    ]);
    _types(orient.keyframes[1], HOLD, HOLD);
    expect(_eqApprox(orient.valueAtTime(0.5), _approx([0.0, 0.0, 0.0]))).toBe(true);
  });

  test("test_mask_path", () => {
    const [_app, comp] = _comp();
    const path = asInstance(_solid(comp).masks, PropertyGroup).addProperty("ADBE Mask Atom").property("ADBE Mask Shape");
    _keys(path, [
      [0, new Shape([[0, 0], [100, 0], [100, 100]], undefined, undefined, { closed: true })],
      [1, new Shape([[20, 10], [150, 0], [120, 140]], undefined, undefined, { closed: true })],
      [2, new Shape([[50, 50], [160, 30], [100, 180]], undefined, undefined, { closed: true })],
    ]);
    _types(path.keyframes[1], HOLD, HOLD);
    expect(_eqApprox(_verts(path.valueAtTime(0.5)), _approx([[0, 0], [100, 0], [100, 100]]))).toBe(true);
  });
});

describe("TestColourModel", () => {
  /** F6: colour eases move along the RGBA line, scaled by its length. */

  const KEYS: [number, number[]][] = [
    [0, [1, 0, 0, 1]],
    [2, [0, 0.5, 1, 1]],
  ];

  const _color = () => {
    const [_app, comp] = _comp();
    return _keys(_effect(_solid(comp), "ADBE Color Control"), KEYS);
  };

  test("test_linear_reports_distance_speed", () => {
    const color = _color();
    // AE 2026: |RGBA delta| * 255 / 2 s
    expect(_eqApprox(_speeds(color.keyframes[0].outTemporalEase), _approx([[191.25, 100 / 6]]))).toBe(true);
    expect(_eqApprox(color.valueAtTime(0.5), _approx([0.75, 0.125, 0.25, 1.0]))).toBe(true);
  });

  test("test_bezier_into_linear", () => {
    const color = _color();
    _ease(color.keyframes[0], [[0, 80]], [[0, 80]]);
    _types(color.keyframes[1], LIN, LIN);
    expect(
      _eqApprox(color.valueAtTime(1.708333333), _approx([0.3087938606486835, 0.34560306967565824, 0.6912061393513165, 1.0])),
    ).toBe(true);
    expect(_eqApprox(_speeds(color.keyframes[1].inTemporalEase), _approx([[191.25, 100 / 6]]))).toBe(true);
  });

  test("test_non_zero_speeds", () => {
    const color = _color();
    for (const kf of color.keyframes) _types(kf, BEZ, BEZ);
    _ease(color.keyframes[0], [[0, 30]], [[60, 50]]);
    _ease(color.keyframes[1], [[40, 40]], [[0, 30]]);
    expect(
      _eqApprox(color.valueAtTime(0.625), _approx([0.7876151810347797, 0.10619240948261015, 0.2123848189652203, 1.0])),
    ).toBe(true);
  });
});

describe("TestRangeClamp", () => {
  /** F7: an eased overshoot evaluates clamped to the property range. */

  test("test_opacity", () => {
    const [_app, comp] = _comp();
    const op = _keys(_solid(comp, 640, 360).property(TG).property("ADBE Opacity"), [
      [0, 10],
      [2, 90],
    ]);
    _ease(op.keyframes[0], [[0, 60]], [[300, 60]]);
    _ease(op.keyframes[1], [[300, 60]], [[0, 60]]);
    expect(op.valueAtTime(1.166666667) === 0.0).toBe(true);
  });

  test("test_mask_feather_and_expansion", () => {
    const [_app, comp] = _comp();
    const mask = asInstance(_solid(comp, 3000, 200).masks, PropertyGroup).addProperty("ADBE Mask Atom");
    const feather = _keys(mask.property("ADBE Mask Feather"), [
      [0, [10, 10]],
      [2, [50, 60]],
    ]);
    _ease(feather.keyframes[0], [[0, 30], [0, 30]], [[-300, 60], [200, 60]]);
    expect(_eqApprox(feather.valueAtTime(0.25), _approx([0.0, 55.58876065072549]))).toBe(true);
    const expansion = _keys(mask.property("ADBE Mask Offset"), [
      [0, 10],
      [2, 20],
    ]);
    _ease(expansion.keyframes[0], [[0, 30]], [[-90000, 60]]);
    expect(expansion.valueAtTime(0.958333333) === -32000.0).toBe(true);
  });
});

describe("TestRejectedWritesDoNotMutate", () => {
  /** F8: a rejected keyframe value leaves the project untouched. */

  test("test_nan_value", () => {
    const [app, comp] = _comp();
    const rot = _solid(comp).property(TG).property("ADBE Rotate Z");
    rot.value = 45.0;
    const before = projectBytes(app.project);
    raises(ValueError, () => {
      rot.setValueAtTime(1.0, float("nan"));
    });
    expect(valueEquals(projectBytes(app.project), before)).toBe(true);
    expect(valueEquals(rot.keyframes, []) && rot.value === 45.0).toBe(true);
  });

  test("test_add_key_at_overshoot_stores_clamped", () => {
    const tmpPath = makeTmpPath();
    // AE 2026 stores the clamped 100 and re-eases both neighbours.
    const [app, comp] = _comp();
    const op = _keys(_solid(comp).property(TG).property("ADBE Opacity"), [
      [0, 10],
      [2, 90],
    ]);
    for (const kf of op.keyframes) _types(kf, BEZ, BEZ);
    _ease(op.keyframes[0], [[0, 60]], [[300, 60]]);
    op.addKey(0.5);
    const new_ = op.keyframes[1];
    expect(new_.value).toBe(100.0);
    expect(_eqApprox(_speeds(new_.inTemporalEase), _approx([[179.0396178959919, 31.451892294166527]]))).toBe(true);
    expect(_eqApprox(_speeds(new_.outTemporalEase), _approx([[179.03961789599282, 61.1377297149683]]))).toBe(true);
    expect(_eqApprox(_speeds(op.keyframes[0].outTemporalEase), _approx([[300.0, 35.131134850035764]]))).toBe(true);
    const again = _reparse(app, tmpPath).property(TG).property("ADBE Opacity");
    expect(valueEquals(again.keyframes.map((k) => k.value), [10.0, 100.0, 90.0])).toBe(true);
  });
});

describe("TestEaseAndTangentWrites", () => {
  /** F9: what an ease or tangent write does to the key's other state. */

  test("test_ease_on_linear_key_turns_it_bezier", () => {
    const [_app, comp] = _comp();
    const op = _keys(_solid(comp).property(TG).property("ADBE Opacity"), [
      [0, 10],
      [2, 90],
    ]);
    _ease(op.keyframes[0], [[0, 75]], [[0, 75]]);
    const kf = op.keyframes[0];
    expect(valueEquals([kf.inInterpolationType, kf.outInterpolationType], [BEZ, BEZ])).toBe(true);
    expect(_eqApprox(_speeds(kf.outTemporalEase), _approx([[0.0, 75.0]]))).toBe(true);
    expect(_eqApprox(op.valueAtTime(0.625), _approx(14.649138906616496))).toBe(true);
    expect(_eqApprox(_speeds(op.keyframes[1].inTemporalEase), _approx([[40.0, 100 / 6]]))).toBe(true);
  });

  test("test_ease_clears_temporal_auto_bezier", () => {
    const [_app, comp] = _comp();
    const rot = _keys(_solid(comp).property(TG).property("ADBE Rotate Z"), [
      [0, 0],
      [1, 100],
      [2, 0],
    ]);
    const kf = rot.keyframes[1];
    kf.temporalAutoBezier = true;
    _ease(kf, [[30, 50]], [[30, 50]]);
    expect(valueEquals([kf.temporalAutoBezier, kf.temporalContinuous], [false, true])).toBe(true);
    expect(_eqApprox(_speeds(kf.inTemporalEase), _approx([[30.0, 50.0]]))).toBe(true);
    expect(_eqApprox(rot.valueAtTime(0.5), _approx(65.31929354403154))).toBe(true);
  });

  test("test_tangent_clears_spatial_auto_bezier", () => {
    const [_app, comp] = _comp();
    const pos = _keys(_solid(comp).property(TG).property("ADBE Position"), [
      [0, [100, 100, 0]],
      [1, [300, 200, 0]],
      [2, [600, 100, 0]],
    ]);
    const kf = pos.keyframes[1];
    kf.spatialAutoBezier = true;
    kf.inSpatialTangent = [-50, 30, 0];
    kf.outSpatialTangent = [50, -30, 0];
    expect(kf.spatialAutoBezier).toBe(false);
    expect(_eqApprox(kf.inSpatialTangent, _approx([-50, 30, 0]))).toBe(true);
    expect(_eqApprox(pos.valueAtTime(0.5), _approx([192.98553351245596, 168.76659157486122, 0.0], 1e-4))).toBe(true);
    expect(_eqApprox(pos.keyframes[0].outTemporalEase[0].speed, _approx(231.49629625710023, 1e-4))).toBe(true);
    expect(_eqApprox(kf.outTemporalEase[0].speed, _approx(316.60351480214035, 1e-4))).toBe(true);
  });
});

describe("TestLinearSpatialSpeed", () => {
  /** F10: a LINEAR spatial side reports arc length over time, not chord. */

  test("test_curved_segment", () => {
    const [_app, comp] = _comp();
    const pos = _keys(_solid(comp).property(TG).property("ADBE Position"), [
      [0, [100, 100, 0]],
      [2, [500, 100, 0]],
    ]);
    pos.keyframes[0].outSpatialTangent = [100, 200, 0];
    pos.keyframes[1].inSpatialTangent = [-100, 200, 0];
    expect(_eqApprox(pos.keyframes[0].outTemporalEase[0].speed, _approx(263.4149868402037, 1e-4))).toBe(true);
    expect(_eqApprox(pos.valueAtTime(0.5), _approx([179.4680619443759, 203.85330816260333, 0.0], 1e-4))).toBe(true);
  });

  test("test_zero_chord_segment", () => {
    const [_app, comp] = _comp();
    const pos = _keys(comp.addNull().property(TG).property("ADBE Position"), [
      [0, [100, 100, 0]],
      [1, [100, 100, 0]],
      [2, [300, 100, 0]],
    ]);
    pos.keyframes[0].outSpatialTangent = [80, 120, 0];
    pos.keyframes[1].inSpatialTangent = [-60, 90, 0];
    expect(_eqApprox(pos.keyframes[0].outTemporalEase[0].speed, _approx(188.63091379888618, 1e-4))).toBe(true);
    expect(_eqApprox(pos.keyframes[1].outTemporalEase[0].speed, _approx(200.0))).toBe(true);
    expect(_eqApprox(pos.valueAtTime(0.5), _approx([109.69902653105451, 179.08373632542654, 0.0], 1e-4))).toBe(true);
  });
});

describe("TestBezierSideFacingHold", () => {
  /** F11: a BEZIER side facing a HOLD side reports speed 0. */

  test("test_speeds", () => {
    const [_app, comp] = _comp();
    const rot = _keys(_solid(comp).property(TG).property("ADBE Rotate Z"), [
      [0, 0],
      [1, 100],
      [2, 300],
    ]);
    _types(rot.keyframes[1], HOLD, HOLD);
    _ease(rot.keyframes[0], [[0, 30]], [[200, 40]]);
    _ease(rot.keyframes[2], [[150, 30]], [[0, 30]]);
    expect(_eqApprox(_speeds(rot.keyframes[0].outTemporalEase), _approx([[0.0, 40.0]]))).toBe(true);
    expect(_eqApprox(_speeds(rot.keyframes[2].inTemporalEase), _approx([[0.0, 30.0]]))).toBe(true);
    expect(_eqApprox(rot.valueAtTime(0.5), _approx(100.0))).toBe(true);
  });
});

const ROVING_KEYS: [number, number[]][] = [
  [0, [100, 100, 0]],
  [1, [300, 150, 0]],
  [2, [350, 400, 0]],
  [3, [500, 420, 0]],
  [5, [800, 300, 0]],
];

function _rovingRun(comp: CompItem) {
  const pos = _keys(comp.addNull().property(TG).property("ADBE Position"), ROVING_KEYS);
  pos.keyframes[1].roving = true;
  pos.keyframes[2].roving = true;
  return pos;
}

describe("TestRovingRunAfterHoldAnchor", () => {
  /** A roving run leaving an out-HOLD anchor: AE 2026 packs the run against
   * the anchor, reports every in side of the run as 0 and keeps the run's
   * speed on the out sides. Comp 640x480, square pixels, 25 fps. */

  test("test_speeds_and_times", () => {
    const [_app, comp] = _comp(640, 480, 1.0, 25.0);
    const pos = _rovingRun(comp);
    _types(pos.keyframes[0], HOLD, HOLD);
    const k = pos.keyframes;
    expect(_eqApprox([1, 2].map((i) => k[i].time), _approx([3.90625e-05, 7.8125e-05]))).toBe(true);
    expect(valueEquals([1, 2, 3].map((i) => k[i].inTemporalEase[0].speed), Array(3).fill(0.0))).toBe(true);
    for (const i of [1, 2]) {
      expect(_eqApprox(k[i].outTemporalEase[0].speed, _approx(204.14457215491265, 1e-4))).toBe(true);
    }
    expect(_eqApprox(k[3].outTemporalEase[0].speed, _approx(161.55494421403515))).toBe(true);
  });
});

describe("TestRovingRunRetimedByAnchorEase", () => {
  /** An anchor's ease decides where its roving run's keys fall, so writing
   * it re-times the run. AE 2026 re-timed py's saved file to these times.
   * Comp 1000x800, 10/11 pixel aspect, 29.97 fps. */

  test("test_eased_anchor", () => {
    const tmpPath = makeTmpPath();
    const [app, comp] = _comp(1000, 800, 10 / 11, 29.97);
    const pos = _rovingRun(comp);
    pos.keyframes[3].spatialAutoBezier = true;
    _ease(pos.keyframes[0], [[0, 80]], [[0, 80]]);
    const want = [1.9925759092425759, 2.6412245578912246];
    expect(_eqApprox(pos.keyframes.slice(1, 3).map((k) => k.time), _approx(want))).toBe(true);
    const compAgain = _reparseComp(app, tmpPath);
    const again = compAgain.layers[0].property(TG).property("ADBE Position");
    expect(_eqApprox(again.keyframes.slice(1, 3).map((k) => k.time), _approx(want))).toBe(true);
  });

  test("test_auto_bezier_anchors", () => {
    const [_app, comp] = _comp(1000, 800, 10 / 11, 29.97);
    const pos = _rovingRun(comp);
    pos.keyframes[0].temporalAutoBezier = true;
    pos.keyframes[3].temporalAutoBezier = true;
    expect(
      _eqApprox(pos.keyframes.slice(1, 3).map((k) => k.time), _approx([0.9633383383383384, 2.267559225892559])),
    ).toBe(true);
  });
});

describe("TestTwoDimensionalLayerZ", () => {
  /** F12: a 2-D layer's Position evaluates with Z = 0, while the stored Z
   * still counts in the path length. */

  test("test_value_at_time", () => {
    const [_app, comp] = _comp();
    const pos = _keys(comp.addNull().property(TG).property("ADBE Position"), [
      [0, [100, 100, 40]],
      [2, [500, 300, -30]],
    ]);
    expect(_eqApprox(pos.valueAtTime(1.0), _approx([299.99689058473786, 199.99844529236896, 0.0], 1e-4))).toBe(true);
    expect(_eqApprox(pos.keyframes[0].outTemporalEase[0].speed, _approx(226.32940595512554, 1e-4))).toBe(true);
  });

  test("test_key_and_static_values", () => {
    // AE 2026 reports Z = 0 in keyValue and value, keeps the stored Z in
    // the file, and addKey stores the interpolated stored Z (5.0005).
    const tmpPath = makeTmpPath();
    const [app, comp] = _comp();
    const null_ = comp.addNull();
    null_.name = "L";
    const pos = _keys(null_.property(TG).property("ADBE Position"), [
      [0, [100, 100, 40]],
      [2, [500, 300, -30]],
    ]);
    pos.addKey(1.0);
    expect(
      _eqApprox(
        _flat(pos.keyframes.map((k) => k.value)),
        _approx(
          [
            [100, 100, 0],
            [299.996890584738, 199.998445292369, 0],
            [500, 300, 0],
          ],
          1e-6,
        ),
      ),
    ).toBe(true);
    expect(_eqApprox(_storedZ(pos.keyframes[1]), _approx(5.0005441476708805))).toBe(true);
    const anchor = null_.property(TG).property("ADBE Anchor Point");
    anchor.value = [30, 20, 15];
    expect(valueEquals(anchor.value, [30.0, 20.0, 0.0])).toBe(true);
    const again = _reparse(app, tmpPath).property(TG);
    expect(valueEquals(again.property("ADBE Anchor Point")._storedStaticValue(), [30, 20, 15])).toBe(true);
    const stored = again.property("ADBE Position").keyframes.map((k) => _storedZ(k));
    expect(_eqApprox(stored, _approx([40.0, 5.0005441476708805, -30.0]))).toBe(true);
  });

  test("test_three_d_layer_keeps_z", () => {
    const [_app, comp] = _comp();
    const pos = _solid(comp, undefined, undefined, true).property(TG).property("ADBE Position");
    pos.value = [100, 120, 40];
    expect(valueEquals(pos.value, [100.0, 120.0, 40.0])).toBe(true);
  });
});

describe("TestAddKeyOnMixedSegment", () => {
  /** F13 / F22: add_key on a LINEAR <-> BEZIER segment. AE turns the LINEAR
   * side BEZIER with the segment's slope, then splits the curve. Comp
   * 1000x800, 10/11 pixel aspect, 29.97 fps. */

  const _slider = () => {
    const [_app, comp] = _comp(1000, 800, 10 / 11, 29.97);
    return _keys(_effect(_solid(comp), "ADBE Slider Control"), [
      [0, 0],
      [2, 100],
    ]);
  };

  test("test_linear_into_bezier", () => {
    const slider = _slider();
    _types(slider.keyframes[1], BEZ, BEZ);
    _ease(slider.keyframes[1], [[10, 40]], [[10, 40]]);
    _types(slider.keyframes[0], LIN, LIN);
    const before = slider.valueAtTime(1.0);
    slider.addKey(0.7);
    const [k0, new_, k2] = slider.keyframes;
    expect(valueEquals([k0.inInterpolationType, k0.outInterpolationType], [LIN, BEZ])).toBe(true);
    expect(_eqApprox(_speeds(k0.outTemporalEase), _approx([[50.0, 20.98365339077507]]))).toBe(true);
    expect(_eqApprox(new_.time, _approx(0.6999916583249917))).toBe(true);
    expect(_eqApprox(new_.value, _approx(45.426218155783275))).toBe(true);
    expect(_eqApprox(_speeds(new_.inTemporalEase), _approx([[63.91994615492312, 43.23832887782448]]))).toBe(true);
    expect(_eqApprox(_speeds(new_.outTemporalEase), _approx([[63.91994615492219, 29.553090510920317]]))).toBe(true);
    expect(_eqApprox(_speeds(k2.inTemporalEase), _approx([[10.0, 34.42122712821061]]))).toBe(true);
    expect(_eqApprox(slider.valueAtTime(1.0), _approx(63.5560834013245))).toBe(true);
    expect(_eqApprox(slider.valueAtTime(1.0), _approx(before))).toBe(true);
  });

  test("test_bezier_into_linear", () => {
    const slider = _slider();
    _types(slider.keyframes[0], BEZ, BEZ);
    _types(slider.keyframes[1], LIN, LIN);
    _ease(slider.keyframes[0], [[20, 60]], [[20, 60]]);
    _types(slider.keyframes[1], BEZ, LIN);
    slider.addKey(0.7);
    const [k0, new_, k2] = slider.keyframes;
    expect(_eqApprox(_speeds(k0.outTemporalEase), _approx([[20.0, 36.03513774186484]]))).toBe(true);
    expect(_eqApprox(new_.value, _approx(20.83860947763496))).toBe(true);
    expect(_eqApprox(_speeds(new_.inTemporalEase), _approx([[39.64385120503754, 30.454616112180773]]))).toBe(true);
    expect(_eqApprox(_speeds(new_.outTemporalEase), _approx([[39.643851205037365, 61.613775791779005]]))).toBe(true);
    expect(valueEquals([k2.inInterpolationType, k2.outInterpolationType], [BEZ, LIN])).toBe(true);
    expect(_eqApprox(slider.valueAtTime(1.0), _approx(34.040679048187606))).toBe(true);
  });
});

describe("TestMaskPathAddKey", () => {
  /** F14: add_key between two path keys inserts the in-between shape.
   * Comp 640x480, 1.5 pixel aspect, 25 fps. */

  test("test_in_between_shape", () => {
    const tmpPath = makeTmpPath();
    const [app, comp] = _comp(640, 480, 1.5, 25.0);
    const path = asInstance(_solid(comp).masks, PropertyGroup).addProperty("ADBE Mask Atom").property("ADBE Mask Shape");
    _keys(path, [
      [0, new Shape([[0, 0], [100, 0], [100, 100]], undefined, undefined, { closed: true })],
      [2, new Shape([[20, 10], [150, 0], [120, 140]], undefined, undefined, { closed: true })],
    ]);
    path.addKey(0.7);
    const want = [[7.0, 3.5], [117.5, 0.0], [107.0, 114.0]];
    expect(_eqApprox(_verts(path.keyframes[1].value), _approx(want, 1e-3))).toBe(true);
    const again = asInstance(getMember(_reparse(app, tmpPath).masks, "properties")[0], PropertyGroup).property("ADBE Mask Shape");
    expect(_eqApprox(_verts(again.keyframes[1].value), _approx(want, 1e-3))).toBe(true);
  });
});

const TRI0 = new Shape([[0, 0], [100, 0], [100, 100]], undefined, undefined, { closed: true });
const TRI1 = new Shape([[20, 10], [150, 0], [120, 140]], undefined, undefined, { closed: true });
const _T = new Map<string, KIT>([
  ["L", LIN],
  ["B", BEZ],
  ["H", HOLD],
]);

describe("TestParallelAddKeyTypes", () => {
  /** add_key on a path or an Orientation: AE 2026 gives the new key types
   * from the key sides facing it (left key's out, right key's in) and does
   * not touch the neighbours. Any BEZIER makes a continuous BEZIER key with
   * speed 1 / influence 16.667 (speed 0 outside the keyed range). */

  const _path = (keys: [number, Shape][]) => {
    const [_app, comp] = _comp();
    const path = asInstance(_solid(comp).masks, PropertyGroup).addProperty("ADBE Mask Atom").property("ADBE Mask Shape");
    return _keys(path, keys);
  };

  const insideRows: [string, string, string, boolean][] = [
    ["L", "L", "LL", false],
    ["L", "B", "BB", true],
    ["L", "H", "LH", false],
    ["B", "L", "BB", true],
    ["B", "B", "BB", true],
    ["B", "H", "BB", true],
    ["H", "L", "HH", false],
    ["H", "B", "BB", true],
    ["H", "H", "HH", false],
  ];

  test.each(insideRows)("test_inside_the_keyed_range[%#]", (leftOut, rightIn, newTypes, continuous) => {
    const path = _path([
      [0, TRI0],
      [2, TRI1],
    ]);
    _types(path.keyframes[0], LIN, getOrThrow(_T, leftOut));
    _types(path.keyframes[1], getOrThrow(_T, rightIn), LIN);
    path.addKey(0.6);
    const [k0, new_, k2] = path.keyframes;
    expect(
      valueEquals(
        [new_.inInterpolationType, new_.outInterpolationType],
        [getOrThrow(_T, newTypes[0]), getOrThrow(_T, newTypes[1])],
      ),
    ).toBe(true);
    expect(new_.temporalContinuous).toBe(continuous);
    expect(k0.outInterpolationType).toBe(getOrThrow(_T, leftOut));
    expect(k2.inInterpolationType).toBe(getOrThrow(_T, rightIn));
    if (continuous) {
      const data = asInstance(new_._ldatItem.kfData, KfNoValue);
      expect(valueEquals([data.inSpeed, data.outSpeed], [1.0, 1.0])).toBe(true);
      expect(_eqApprox(data.inInfluence, _approx(1 / 6))).toBe(true);
    }
  });

  test("test_outside_the_keyed_range", () => {
    const path = _path([
      [1, TRI0],
      [2, TRI1],
    ]);
    for (const kf of path.keyframes) _types(kf, BEZ, BEZ);
    path.addKey(0.4);
    const new_ = path.keyframes[0];
    expect(valueEquals([new_.inInterpolationType, new_.outInterpolationType], [BEZ, BEZ])).toBe(true);
    expect(new_.temporalContinuous).toBe(true);
    expect(_eqApprox(_speeds(new_.outTemporalEase), _approx([0.0, 100 / 6]))).toBe(true);
    const held = _path([
      [0, TRI0],
      [1, TRI1],
    ]);
    _types(held.keyframes[1], HOLD, HOLD);
    held.addKey(2.0);
    const last = held.keyframes[2];
    expect(valueEquals([last.inInterpolationType, last.outInterpolationType], [HOLD, HOLD])).toBe(true);
  });

  test("test_orientation", () => {
    const tmpPath = makeTmpPath();
    const [app, comp] = _comp();
    const orient = _keys(_solid(comp, 400, 300, true).property(TG).property("ADBE Orientation"), [
      [0, [0, 0, 0]],
      [2, [40, 30, 20]],
    ]);
    for (const kf of orient.keyframes) _types(kf, BEZ, BEZ);
    _ease(orient.keyframes[0], [[0, 30]], [[0, 70]]);
    orient.addKey(0.6);
    const new_ = orient.keyframes[1];
    expect(valueEquals([new_.inInterpolationType, new_.temporalContinuous], [BEZ, true])).toBe(true);
    expect(_eqApprox(_speeds(new_.inTemporalEase), _approx([1.0, 100 / 6]))).toBe(true);
    expect(_eqApprox(_speeds(orient.keyframes[0].outTemporalEase), _approx([0.0, 70.0]))).toBe(true);
    const again = _reparse(app, tmpPath).property(TG).property("ADBE Orientation").keyframes[1];
    expect(valueEquals([again.outInterpolationType, again.temporalContinuous], [BEZ, true])).toBe(true);
  });
});

describe("TestQueryTimeQuantization", () => {
  /** F15: AE snaps the query time to the layer's tick grid (comp time, then
   * the layer time it maps to). LINEAR opacity 0 -> 100 over 4 s. */

  /** (stretch, {comp time: AE value}) */
  const CASES: [number, Map<number, number>][] = [
    [
      150,
      new Map<number, number>([
        [0.001, 0.025431315104166668],
        [0.021480183919598, 0.537109375],
        [0.044093249246231155, 1.1016845703125],
      ]),
    ],
    [
      50,
      new Map<number, number>([
        [0.001, 0.025431315104166668],
        [0.021480183919598, 0.537109375],
        [0.044093249246231155, 1.1027018229166665],
      ]),
    ],
  ];

  test.each(CASES)("test_samples[%#]", (stretch, samples) => {
    const [_app, comp] = _comp();
    const layer = _solid(comp);
    layer.stretch = stretch;
    const op = _keys(layer.property(TG).property("ADBE Opacity"), [
      [0, 0],
      [4, 100],
    ]);
    for (const [t, want] of samples) {
      expect(_eqApprox(op.valueAtTime(t), _approx(want, 1e-9))).toBe(true);
    }
  });
});

describe("TestRemoveKeyNextToRovingRun", () => {
  /** F16: remove_key re-times the roving run it bounded. Comp 640x480,
   * square pixels, 25 fps. */

  test("test_times", () => {
    const [_app, comp] = _comp(640, 480, 1.0, 25.0);
    const pos = _keys(_solid(comp).property(TG).property("ADBE Position"), [
      [0, [100, 100, 0]],
      [1, [300, 150, 0]],
      [2, [350, 400, 0]],
      [3, [500, 420, 0]],
      [5, [800, 300, 0]],
    ]);
    pos.keyframes[1].roving = true;
    pos.keyframes[2].roving = true;
    pos.removeKey(3);
    expect(
      _eqApprox(
        pos.keyframes.map((k) => k.time),
        _approx([0.0, 1.1178515625, 2.5003125, 5.0], 1e-9),
      ),
    ).toBe(true);
  });

  test("test_remove_first_anchor", () => {
    // The roving key that becomes first keeps its flag and its time, and
    // bounds the rest of the run (AE 2026).
    const [_app, comp] = _comp(640, 480, 1.0, 25.0);
    const pos = _rovingRun(comp);
    pos.removeKey(0);
    expect(_eqApprox(pos.keyframes.map((k) => k.time), _approx([1.00984375, 2.2587109375, 3.0, 5.0], 1e-9))).toBe(true);
    expect(pos.keyframes[0].roving).toBe(true);
  });
});

describe("TestSetValueAtTimeIntoLinearSegment", () => {
  /** F17: set_value_at_time inside a LINEAR segment stores a virgin 0 / 0
   * ease, which a later switch to BEZIER reports. Comp 1000x800, 10/11 pixel
   * aspect, 29.97 fps. */

  test("test_virgin_ease", () => {
    const tmpPath = makeTmpPath();
    const [app, comp] = _comp(1000, 800, 10 / 11, 29.97);
    const rot = _keys(_solid(comp).property(TG).property("ADBE Rotate Z"), [
      [0, 0],
      [2, 100],
    ]);
    rot.setValueAtTime(0.8, 70.0);
    const kf = rot.keyframes[1];
    _types(kf, BEZ, BEZ);
    expect(valueEquals(_speeds(kf.inTemporalEase), [0.0, 0.0])).toBe(true);
    expect(valueEquals(_speeds(kf.outTemporalEase), [0.0, 0.0])).toBe(true);
    expect(_eqApprox(rot.keyframes[0].outTemporalEase[0].speed, _approx(87.49908763880924, 1e-6))).toBe(true);
    const again = _reparse(app, tmpPath).property(TG).property("ADBE Rotate Z");
    expect(valueEquals(_speeds(again.keyframes[1].inTemporalEase), [0.0, 0.0])).toBe(true);
  });
});

describe("TestOrientationOvershoot", () => {
  /** F18: an eased Orientation segment with a LINEAR side overshoots
   * unclamped. */

  test("test_value", () => {
    const [_app, comp] = _comp();
    const orient = _keys(_solid(comp, 400, 300, true).property(TG).property("ADBE Orientation"), [
      [0, [0, 0, 0]],
      [2, [40, 30, 20]],
    ]);
    _ease(orient.keyframes[0], [[0, 30]], [[50, 50]]);
    expect(
      _eqApprox(orient.valueAtTime(0.125), _approx([203.9391721948668, 60.25097116014023, 293.2536769415112], 1e-4)),
    ).toBe(true);
  });
});

describe("TestDecimalFrameRateKeyTicks", () => {
  /** A keyframe at a decimal frame rate counts AE's frame-grid units:
   * 12.3456 fps is 2000 units a frame, 24692 a second (AE 2026). */

  test("test_key_at_one_second", () => {
    const tmpPath = makeTmpPath();
    const [app, comp] = _comp(400, 300, 1.0, 12.3456);
    const op = _keys(_solid(comp).property(TG).property("ADBE Opacity"), [[1.0, 50]]);
    expect(op.keyframes[0].timeUnits).toBe(24692);
    const again = _reparse(app, tmpPath).property(TG).property("ADBE Opacity");
    expect(again.keyframes[0].timeUnits).toBe(24692);
    expect(_eqApprox(again.keyframes[0].time, _approx(1.0))).toBe(true);
  });
});

describe("TestShapeBoundHints", () => {
  /** The tdum/tduM AE writes for an edited shape property hold a 0 / 100 UI
   * slider hint, not a bound: ExtendScript reports Stroke Width with no
   * maximum and Miter Limit as min 1, no maximum (AE 2026 bounds probe over
   * 131 shape properties, and the sample's own export). */

  test("test_gradient_sample", () => {
    const app = parse(SAMPLES.div("models", "property", "gradient.aep"));
    const seen = new Set<string>();
    for (const comp of app.project.compositions) {
      for (const layer of comp.layers) {
        for (const prop of _leaves(layer)) {
          if (prop.matchName === "ADBE Vector Stroke Width") {
            expect(valueEquals([prop.hasMin, prop.minValue], [true, 0])).toBe(true);
            expect(valueEquals([prop.hasMax, prop.maxValue], [false, null])).toBe(true);
            seen.add(prop.matchName);
          } else if (prop.matchName === "ADBE Vector Stroke Miter Limit") {
            expect(valueEquals([prop.hasMin, prop.minValue], [true, 1])).toBe(true);
            expect(valueEquals([prop.hasMax, prop.maxValue], [false, null])).toBe(true);
            seen.add(prop.matchName);
          }
        }
      }
    }
    expect(valueEquals(seen, new Set(["ADBE Vector Stroke Width", "ADBE Vector Stroke Miter Limit"]))).toBe(true);
  });
});

describe("TestSynthesizedBoundChunks", () => {
  /** A materialized effect param's tdum/tduM: 8-byte doubles holding the UI
   * slider range, as AE 2026 writes for a Slider Control (0 / 100). */

  test("test_slider_control", () => {
    const tmpPath = makeTmpPath();
    const [app, comp] = _comp();
    const slider = _effect(_solid(comp), "ADBE Slider Control");
    slider.value = 7;
    const bounds = new Map(
      slider._tdbs.chunks
        .filter((c) => ["tdum", "tduM"].includes(c.chunkType))
        .map((c): [string, [number[], boolean]] => {
          const tdum = asInstance(c, TdumChunk);
          return [tdum.chunkType, [tdum.values, tdum.isInteger]];
        }),
    );
    expect(valueEquals(bounds, new Map<string, [number[], boolean]>([["tdum", [[0.0], false]], ["tduM", [[100.0], false]]]))).toBe(true);
    const again = asInstance(
      asInstance(getMember(_reparse(app, tmpPath).effects, "properties")[0], PropertyGroup).properties[0],
      Property,
    );
    expect(valueEquals([again.minValue, again.maxValue], [-1000000, 1000000])).toBe(true);
    expect(again.value).toBe(7.0);
  });
});

describe("TestValidation", () => {
  /** F19: inputs AE rejects, and huge coordinates. */

  test("test_none_keyframe_value", () => {
    const [app, comp] = _comp();
    const slider = _effect(_solid(comp), "ADBE Slider Control");
    const before = projectBytes(app.project);
    raises(TypeError, () => {
      slider.setValueAtTime(1.0, null);
    });
    expect(valueEquals(slider.keyframes, []) && valueEquals(projectBytes(app.project), before)).toBe(true);
  });

  test("test_non_numeric_time", () => {
    const [_app, comp] = _comp();
    const rot = _solid(comp).property(TG).property("ADBE Rotate Z");
    raises(TypeError, () => {
      // @ts-expect-error a string time checks the runtime type validation
      rot.valueAtTime("abc");
    });
  });

  test("test_huge_coordinate_evaluates", () => {
    const [_app, comp] = _comp();
    const pos = _keys(_solid(comp).property(TG).property("ADBE Position"), [
      [0, [0, 0, 0]],
      [1, [1e200, 0, 0]],
    ]);
    const value = pos.valueAtTime(0.5);
    expect(value.every((v: number) => Number.isFinite(v))).toBe(true);
    expect(approx(value[0], 5e199, { rel: 1e-6 })).toBe(true);
  });

  test("test_ease_speed_none", () => {
    const ease = new KeyframeEase(1, 50);
    raisesAny([TypeError, ValueError], () => {
      // @ts-expect-error a None speed checks the runtime type validation
      ease.speed = null;
    });
    expect(ease.speed).toBe(1);
  });
});

describe("TestTemporalContinuityFlags", () => {
  /** Temporal continuity versus interpolation types and auto-bezier, as AE
   * 2026 saves the flags (read back from its file). */

  const _rot = () => {
    const [_app, comp] = _comp();
    const rot = _keys(_solid(comp).property(TG).property("ADBE Rotate Z"), [
      [0, 0],
      [1, 100],
      [2, 0],
    ]);
    return rot.keyframes[1];
  };

  const typeRows: [KIT, KIT, boolean][] = [
    [LIN, LIN, false],
    [LIN, BEZ, true],
    [LIN, HOLD, false],
    [BEZ, LIN, true],
    [BEZ, HOLD, true],
    [HOLD, LIN, false],
    [HOLD, BEZ, true],
    [HOLD, HOLD, false],
  ];

  test.each(typeRows)("test_types_after_continuous[%#]", (inType, outType, continuous) => {
    for (const first of ["temporalContinuous", "temporalAutoBezier"]) {
      const kf = _rot();
      setMember(kf, first, true);
      _types(kf, inType, outType);
      expect(kf.temporalContinuous).toBe(continuous);
      expect(kf.temporalAutoBezier).toBe(first === "temporalAutoBezier");
    }
  });

  test("test_continuous_clears_auto_bezier", () => {
    const kf = _rot();
    kf.temporalAutoBezier = true;
    kf.temporalContinuous = true;
    expect(valueEquals([kf.temporalAutoBezier, kf.temporalContinuous], [false, true])).toBe(true);
  });

  test("test_auto_bezier_key_stays_continuous", () => {
    const kf = _rot();
    kf.temporalAutoBezier = true;
    kf.temporalContinuous = false;
    expect(valueEquals([kf.temporalAutoBezier, kf.temporalContinuous], [true, true])).toBe(true);
  });

  test("test_auto_bezier_back_on_bezier_sides", () => {
    const kf = _rot();
    kf.temporalAutoBezier = true;
    _types(kf, LIN, LIN);
    _types(kf, BEZ, BEZ);
    expect(valueEquals([kf.temporalAutoBezier, kf.temporalContinuous], [true, true])).toBe(true);
  });

  test("test_flags_survive_save", () => {
    const tmpPath = makeTmpPath();
    const [app, comp] = _comp();
    const rot = _keys(_solid(comp).property(TG).property("ADBE Rotate Z"), [
      [0, 0],
      [1, 100],
      [2, 0],
    ]);
    const kf = rot.keyframes[1];
    kf.temporalAutoBezier = true;
    _types(kf, LIN, BEZ);
    const again = _reparse(app, tmpPath).property(TG).property("ADBE Rotate Z").keyframes[1];
    expect(valueEquals([again.temporalAutoBezier, again.temporalContinuous], [true, true])).toBe(true);
  });
});
