/**
 * Translate Photoshop layer-style descriptors into AE Layer Styles values.
 *
 * After Effects' "Editable Layer Styles" import converts each layer's effects
 * descriptor (the `lmfx` tagged block, or `lfx2` for documents where no style
 * has multiple instances - both wrap the same ActionDescriptor serialization)
 * into the layer's `ADBE Layer Styles` property tree, together with the
 * blend-options tagged blocks (`iOpa`, `infx`, `brst`) and the document's
 * global-light image resources (1037/1049).
 *
 * The mapping rules mirror AE 2026 (the `psd_layer_styles*.aep` fixtures and
 * the synthetic-descriptor probes):
 *
 * - Parameter values are imported verbatim (the master `Scl ` scale factor is
 *   ignored, as are contours, anti-alias flags and dialog bookkeeping).
 * - A style with more than one instance (a `<style>Multi` array) is dropped
 *   entirely - AE does not import even a representable instance. A one-element
 *   `Multi` array imports as a normal single style.
 * - A single stroke imports regardless of paint type: the gradient fill itself
 *   is dropped and the descriptor's color imported.
 */

import * as host from "../../pyrt/host.ts";

import { Gradient, GradientAlphaStop, GradientColorStop } from "../models/properties/gradient.ts";
import { iter_image_resources } from "./media_probe.ts";
import type { PsdGroup, PsdLayer, PsdStyleBlocks } from "./psd_layers.ts";
import {
  BytesIO,
  FileNotFoundError,
  KeyError,
  NotImplementedError,
  OSError,
  TypeError_,
  ValueError,
  b,
  bytes_,
  bytes_eq,
  copysign,
  decode,
  dict_get,
  fspath,
  getitem,
  int,
  json_float,
  py_bool,
  radians,
  repr,
  round,
  rstrip,
  setdefault,
  struct,
  warn,
  type PathLike,
} from "../../pyrt/index.ts";

export type StyleValue = number | number[] | Gradient;
export type _Box = [number, number, number, number];

/** A style instance uses a construct AE's import cannot represent. */
export class UnsupportedStyleError extends ValueError {}

/** One layer's styles resolved to AE Layer Styles values. */
export class PsdLayerStyles {
  /**
   * AE property values keyed by match name (`"dropShadow/mode2"`,
   * `"ADBE Global Angle2"`, ...) for every imported style, enabled or not.
   * Values equal to AE's defaults are included; the import step writes only
   * the non-default ones (matching AE).
   */
  values: Map<string, StyleValue>;

  /**
   * Match-name prefixes of the styles whose eyeball is on (`"dropShadow"`,
   * ...). A style can be imported (contribute to `values`) while disabled -
   * AE keeps the single-instance glow/bevel/satin styles' parameters even
   * when their eyeball is off.
   */
  enabled: readonly string[];

  /**
   * Match-name prefixes of styles present in the document but dropped
   * whole: multi-instance styles (AE drops those entirely) and styles whose
   * descriptor uses constructs AE cannot represent.
   */
  dropped: readonly string[];

  /**
   * Match-name prefixes of styles whose descriptor carries
   * `present=True` with the eyeball off. AE imports their parameters and
   * writes the distinct `tdsb` enable byte 0x00 (probed psd_fill_opacity
   * fixture; a `present=False` style keeps the absent-style 0x02).
   */
  disabled: readonly string[];

  /**
   * `true` when the layer carries blend-options tagged blocks
   * (`iOpa`/`infx`/`brst`). AE enables the container + Blend Options chain
   * (`tdsb` 0x01) for these layers even when no style is enabled.
   */
  blend_options: boolean;

  constructor(
    values: Map<string, StyleValue>,
    enabled: readonly string[],
    dropped: readonly string[],
    disabled: readonly string[] = [],
    blend_options = false,
  ) {
    this.values = values;
    this.enabled = enabled;
    this.dropped = dropped;
    this.disabled = disabled;
    this.blend_options = blend_options;
  }

  *[Symbol.iterator](): Generator<Map<string, StyleValue> | readonly string[] | boolean> {
    yield this.values;
    yield this.enabled;
    yield this.dropped;
    yield this.disabled;
    yield this.blend_options;
  }
}

// ---------------------------------------------------------------------------
// ActionDescriptor reader
// ---------------------------------------------------------------------------

export class _Reader {
  data: Uint8Array;
  pos: number;

  constructor(data: Uint8Array) {
    this.data = data;
    this.pos = 0;
  }

  raw(n: number): Uint8Array {
    const value = bytes_.slice(this.data, this.pos, this.pos + n);
    if (value.length !== n) throw new ValueError("truncated descriptor");
    this.pos += n;
    return value;
  }

  u4(): number {
    return struct.unpack(">I", this.raw(4))[0];
  }

  key(): string {
    const n = this.u4();
    return decode(this.raw(n === 0 ? 4 : n), "latin-1");
  }

  ustr(): string {
    const n = this.u4();
    return rstrip(decode(this.raw(2 * n), "utf-16-be"), "\x00");
  }
}

/** A parsed descriptor value: Objc/GlbO become Maps, VlLs arrays, tdta/alis null. */
export type _Value = number | string | boolean | null | _Value[] | Map<string, _Value>;

export function _parse_item(reader: _Reader, os_type: string): _Value {
  if (["Objc", "GlbO"].includes(os_type)) {
    reader.ustr(); // name from classID (unused)
    const cls = reader.key();
    const out = new Map<string, _Value>([["_class", cls]]);
    for (let i = 0, n = reader.u4(); i < n; i++) {
      const key = reader.key();
      out.set(key, _parse_item(reader, decode(reader.raw(4), "latin-1")));
    }
    return out;
  }
  if (os_type === "VlLs") {
    return Array.from({ length: reader.u4() }, () => _parse_item(reader, decode(reader.raw(4), "latin-1")));
  }
  if (os_type === "doub") {
    return struct.unpack(">d", reader.raw(8))[0];
  }
  if (os_type === "UntF") {
    reader.raw(4); // unit (imported verbatim; the unit tag is redundant)
    return struct.unpack(">d", reader.raw(8))[0];
  }
  if (os_type === "TEXT") {
    return reader.ustr();
  }
  if (os_type === "enum") {
    reader.key(); // enum type
    return reader.key();
  }
  if (os_type === "long") {
    return struct.unpack(">i", reader.raw(4))[0];
  }
  if (os_type === "comp") {
    // Python ints are unbounded; Number() rounds to nearest exactly like
    // float(int), and every consumer in this module converts to float first.
    return Number(struct.unpack(">q", reader.raw(8))[0]);
  }
  if (os_type === "bool") {
    return !bytes_eq(reader.raw(1), b("\x00"));
  }
  if (os_type === "type" || os_type === "GlbC") {
    reader.ustr();
    return reader.key();
  }
  if (os_type === "tdta" || os_type === "alis") {
    reader.raw(reader.u4());
    return null;
  }
  throw new ValueError(`unhandled descriptor OSType ${repr(os_type)}`);
}

export function _parse_effects_descriptor(body: Uint8Array): Map<string, _Value> {
  /** Parse an `lmfx`/`lfx2` block body: version u4s (ending 16) + root Objc. */
  const reader = new _Reader(body);
  let found = false;
  for (let i = 0; i < 4; i++) {
    if (reader.u4() === 16) {
      found = true;
      break;
    }
  }
  if (!found) throw new ValueError("no descriptor version marker");
  const root = _parse_item(reader, "Objc");
  if (!(root instanceof Map)) throw new ValueError("effects descriptor root is not an object");
  return root;
}

// ---------------------------------------------------------------------------
// PS -> AE value tables (AE 2026; see the plan's probe results)
// ---------------------------------------------------------------------------

// Blend-mode enum -> the styles' mode2 integer space (complete for every
// Photoshop-expressible mode; ints 3/9/15/23/26/31 are AE-only slots).
// Legacy writers store the classic modes as zero-length 4-char typeIDs;
// the aliases below are exactly the set AE 2026 resolves (spliced 27-mode
// probe, psd_blend_4cc_all.aep). AE does NOT resolve the post-CS modes'
// 4CCs (lbrn/dkCl/lddg/lgCl/vLit/lLit/pLit/hMix/fsub/fdiv - no legacy
// writer ever produced them): it silently keeps the default mode, so those
// stay unmapped here and py_aep warns where AE is silent.
export const _BLEND_MODE2 = new Map<string, number>([
  ["Nrml", 1.0],
  ["Dslv", 2.0],
  ["Drkn", 4.0],
  ["Mltp", 5.0],
  ["CBrn", 6.0],
  ["Lghn", 10.0],
  ["Scrn", 11.0],
  ["CDdg", 12.0],
  ["Ovrl", 16.0],
  ["SftL", 17.0],
  ["HrdL", 18.0],
  ["Dfrn", 24.0],
  ["Xclu", 25.0],
  ["H   ", 27.0],
  ["Strt", 28.0],
  ["Clr ", 29.0],
  ["Lmns", 30.0],
  ["normal", 1.0],
  ["dissolve", 2.0],
  ["darken", 4.0],
  ["multiply", 5.0],
  ["colorBurn", 6.0],
  ["linearBurn", 7.0],
  ["darkerColor", 8.0],
  ["lighten", 10.0],
  ["screen", 11.0],
  ["colorDodge", 12.0],
  ["linearDodge", 13.0],
  ["lighterColor", 14.0],
  ["overlay", 16.0],
  ["softLight", 17.0],
  ["hardLight", 18.0],
  ["vividLight", 19.0],
  ["linearLight", 20.0],
  ["pinLight", 21.0],
  ["hardMix", 22.0],
  ["difference", 24.0],
  ["exclusion", 25.0],
  ["hue", 27.0],
  ["saturation", 28.0],
  ["color", 29.0],
  ["luminosity", 30.0],
  ["blendSubtraction", 32.0],
  ["blendDivide", 33.0],
]);

export const _GLOW_TECHNIQUE = new Map<string, number>([
  ["SfBL", 1.0],
  ["PrBL", 2.0],
]);
export const _INNER_GLOW_SOURCE = new Map<string, number>([
  ["SrcE", 1.0],
  ["SrcC", 2.0],
]);
// Bevel style/technique/direction: InrB(2)/Embs(3), PrBL(2) and Out(2) are
// fixture-pinned; the rest follow AE's dropdown order.
export const _BEVEL_STYLE = new Map<string, number>([
  ["OtrB", 1.0],
  ["InrB", 2.0],
  ["Embs", 3.0],
  ["PlEb", 4.0],
]);
export const _BEVEL_TECHNIQUE = new Map<string, number>([
  ["SfBL", 1.0],
  ["PrBL", 2.0],
  ["Slmt", 3.0],
]);
export const _BEVEL_DIRECTION = new Map<string, number>([
  ["In  ", 1.0],
  ["Out ", 2.0],
]);
export const _GRADIENT_TYPE = new Map<string, number>([
  ["Lnr ", 1.0],
  ["Rdl ", 2.0],
  ["Angl", 3.0],
  ["Rflc", 4.0],
  ["Dmnd", 5.0],
]);
// Stroke position: OutF=1 (default), InsF=2, CtrF=3 (probe-pinned).
export const _STROKE_POSITION = new Map<string, number>([
  ["OutF", 1.0],
  ["InsF", 2.0],
  ["CtrF", 3.0],
]);

/** Python `repr()` of a parsed descriptor value (dicts print as `{'k': v}`). */
// NOTE(port): int/float — integral values are plain numbers by design (RULEBOOK §4); a whole-valued double prints as "5" not "5.0" in unsupported-style error messages.
export function _repr(value: _Value): string {
  if (value instanceof Map) {
    return `{${[...value].map(([k, v]) => `${repr(k)}: ${_repr(v)}`).join(", ")}}`;
  }
  if (Array.isArray(value)) return `[${value.map(_repr).join(", ")}]`;
  return repr(value);
}

export function _enum(table: Map<string, number>): (value: _Value) => number {
  return function convert(value: _Value): number {
    // Map.get, not a plain-object lookup: descriptor strings such as
    // "constructor" must not reach Object.prototype.
    const hit = typeof value === "string" ? table.get(value) : undefined;
    if (hit === undefined) throw new UnsupportedStyleError(`unmapped enum value ${_repr(value)}`);
    return hit;
  };
}

export function _number(value: _Value): number {
  if (typeof value !== "number") {
    throw new UnsupportedStyleError(`expected a number, got ${_repr(value)}`);
  }
  return value;
}

export function _bool01(value: _Value): number {
  return py_bool(value) ? 1.0 : 0.0;
}

/** Python int/float/bool operand for `/`: bool counts as 0/1, anything else raises. */
export function _arith(value: _Value): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  throw new TypeError_(`unsupported operand type for /: ${repr(value)}`);
}

/** Python `obj[key]` for a descriptor value: only dicts (Maps) are subscriptable here. */
export function _subscript(obj: _Value, key: string): _Value {
  if (obj instanceof Map) return getitem(obj, key);
  throw new TypeError_(`${repr(obj)} is not subscriptable with ${repr(key)}`);
}

/** Python `for x in value` over a parsed descriptor value. */
export function _py_iter(value: _Value): _Value[] {
  if (Array.isArray(value)) return value;
  if (value instanceof Map) return [...value.keys()];
  if (typeof value === "string") return Array.from(value);
  throw new TypeError_(`${repr(value)} object is not iterable`);
}

export function _color(value: _Value): number[] {
  if (!(value instanceof Map) || (value.get("_class") ?? null) !== "RGBC") {
    throw new UnsupportedStyleError(`unsupported color model ${_repr(value)}`);
  }
  return [
    _arith(getitem(value, "Rd  ")) / 255.0,
    _arith(getitem(value, "Grn ")) / 255.0,
    _arith(getitem(value, "Bl  ")) / 255.0,
    1.0,
  ];
}

export function _point(value: _Value): number[] {
  if (!(value instanceof Map)) {
    throw new UnsupportedStyleError(`expected a point, got ${_repr(value)}`);
  }
  return [_number(getitem(value, "Hrzn")), _number(getitem(value, "Vrtc"))];
}

export function _gradient(value: _Value): Gradient {
  if (!(value instanceof Map) || (value.get("_class") ?? null) !== "Grdn") {
    throw new UnsupportedStyleError(`expected a gradient, got ${_repr(value)}`);
  }
  if ((value.get("GrdF") ?? null) !== "CstS") {
    // Noise gradients ("ClNs") have no AE representation.
    throw new UnsupportedStyleError(`unsupported gradient form ${repr(value.get("GrdF") ?? null)}`);
  }
  // `Lctn` stop locations are always on Photoshop's fixed 0..4096 scale.
  // The sibling `Intr` field is the gradient editor's Smoothness slider
  // (0..4096 = 0..100%), NOT the location scale - every repo sample has
  // Intr=4096, so it must not be used as the divisor (smoothness 50%
  // would double every offset, and 0% would divide by zero). Smoothness
  // is left unmapped (AE's gradientSmoothness handling is unprobed).
  const color_stops: GradientColorStop[] = [];
  for (const stop of _py_iter(getitem(value, "Clrs"))) {
    const [red, green, blue] = _color(_subscript(stop, "Clr "));
    color_stops.push(
      new GradientColorStop(
        _arith(_subscript(stop, "Lctn")) / 4096.0,
        _arith(_subscript(stop, "Mdpn")) / 100.0,
        [red, green, blue],
      ),
    );
  }
  const alpha_stops = _py_iter(getitem(value, "Trns")).map(
    (stop) =>
      new GradientAlphaStop(
        _arith(_subscript(stop, "Lctn")) / 4096.0,
        _arith(_subscript(stop, "Mdpn")) / 100.0,
        _number(_subscript(stop, "Opct")) / 100.0,
      ),
  );
  return new Gradient(color_stops, alpha_stops);
}

export class _Param {
  descriptor_key: string;
  suffix: string;
  convert: (value: _Value) => StyleValue;

  constructor(descriptor_key: string, suffix: string, convert: (value: _Value) => StyleValue) {
    this.descriptor_key = descriptor_key;
    this.suffix = suffix;
    this.convert = convert;
  }

  *[Symbol.iterator](): Generator<string | ((value: _Value) => StyleValue)> {
    yield this.descriptor_key;
    yield this.suffix;
    yield this.convert;
  }
}

export const _SHADOW_PARAMS: readonly _Param[] = [
  new _Param("Md  ", "mode2", _enum(_BLEND_MODE2)),
  new _Param("Clr ", "color", _color),
  new _Param("Opct", "opacity", _number),
  new _Param("uglg", "useGlobalAngle", _bool01),
  new _Param("lagl", "localLightingAngle", _number),
  new _Param("Dstn", "distance", _number),
  new _Param("Ckmt", "chokeMatte", _number),
  new _Param("blur", "blur", _number),
  new _Param("Nose", "noise", _number),
];
export const _GLOW_PARAMS: readonly _Param[] = [
  new _Param("Md  ", "mode2", _enum(_BLEND_MODE2)),
  new _Param("Opct", "opacity", _number),
  new _Param("Nose", "noise", _number),
  new _Param("Clr ", "color", _color),
  new _Param("Grad", "gradient", _gradient),
  new _Param("GlwT", "glowTechnique", _enum(_GLOW_TECHNIQUE)),
  new _Param("Ckmt", "chokeMatte", _number),
  new _Param("blur", "blur", _number),
  new _Param("Inpr", "inputRange", _number),
  new _Param("ShdN", "shadingNoise", _number),
];

// Style key in the effects descriptor -> (AE match-name prefix, params).
export const _STYLES = new Map<string, [string, readonly _Param[]]>([
  [
    "DrSh",
    [
      "dropShadow",
      [..._SHADOW_PARAMS, new _Param("layerConceals", "layerConceals", _bool01)],
    ],
  ],
  ["IrSh", ["innerShadow", _SHADOW_PARAMS]],
  ["OrGl", ["outerGlow", _GLOW_PARAMS]],
  [
    "IrGl",
    [
      "innerGlow",
      [..._GLOW_PARAMS, new _Param("glwS", "innerGlowSource", _enum(_INNER_GLOW_SOURCE))],
    ],
  ],
  [
    "ebbl",
    [
      "bevelEmboss",
      [
        new _Param("bvlS", "bevelStyle", _enum(_BEVEL_STYLE)),
        new _Param("bvlT", "bevelTechnique", _enum(_BEVEL_TECHNIQUE)),
        new _Param("srgR", "strengthRatio", _number),
        new _Param("bvlD", "bevelDirection", _enum(_BEVEL_DIRECTION)),
        new _Param("blur", "blur", _number),
        new _Param("Sftn", "softness", _number),
        new _Param("uglg", "useGlobalAngle", _bool01),
        new _Param("lagl", "localLightingAngle", _number),
        new _Param("Lald", "localLightingAltitude", _number),
        new _Param("hglM", "highlightMode", _enum(_BLEND_MODE2)),
        new _Param("hglC", "highlightColor", _color),
        new _Param("hglO", "highlightOpacity", _number),
        new _Param("sdwM", "shadowMode", _enum(_BLEND_MODE2)),
        new _Param("sdwC", "shadowColor", _color),
        new _Param("sdwO", "shadowOpacity", _number),
      ],
    ],
  ],
  [
    "ChFX",
    [
      "chromeFX",
      [
        new _Param("Md  ", "mode2", _enum(_BLEND_MODE2)),
        new _Param("Clr ", "color", _color),
        new _Param("Opct", "opacity", _number),
        new _Param("lagl", "localLightingAngle", _number),
        new _Param("Dstn", "distance", _number),
        new _Param("blur", "blur", _number),
        new _Param("Invr", "invert", _bool01),
      ],
    ],
  ],
  [
    "SoFi",
    [
      "solidFill",
      [
        new _Param("Md  ", "mode2", _enum(_BLEND_MODE2)),
        new _Param("Clr ", "color", _color),
        new _Param("Opct", "opacity", _number),
      ],
    ],
  ],
  [
    "GrFl",
    [
      "gradientFill",
      [
        new _Param("Md  ", "mode2", _enum(_BLEND_MODE2)),
        new _Param("Opct", "opacity", _number),
        new _Param("Grad", "gradient", _gradient),
        new _Param("Angl", "angle", _number),
        new _Param("Type", "type", _enum(_GRADIENT_TYPE)),
        new _Param("Rvrs", "reverse", _bool01),
        new _Param("Algn", "align", _bool01),
        new _Param("Scl ", "scale", _number),
        new _Param("Ofst", "offset", _point),
      ],
    ],
  ],
  [
    "patternFill",
    [
      "patternFill",
      [
        new _Param("Md  ", "mode2", _enum(_BLEND_MODE2)),
        new _Param("Opct", "opacity", _number),
        new _Param("Algn", "align", _bool01),
        new _Param("Scl ", "scale", _number),
        new _Param("phase", "phase", _point),
      ],
    ],
  ],
  [
    "FrFX",
    [
      "frameFX",
      [
        new _Param("Md  ", "mode2", _enum(_BLEND_MODE2)),
        new _Param("Clr ", "color", _color),
        new _Param("Sz  ", "size", _number),
        new _Param("Opct", "opacity", _number),
        new _Param("Styl", "style", _enum(_STROKE_POSITION)),
      ],
    ],
  ],
]);

// `<style>Multi` list keys (the lmfx multi-instance containers).
export const _MULTI_KEYS = new Map<string, string>(
  [..._STYLES].map(([key, [prefix]]): [string, string] => [`${prefix}Multi`, key]),
);

export function _style_instances(descriptor: Map<string, _Value>): Map<string, _Value[]> {
  /**
   * Collect style instances per descriptor style key.
   *
   * Single-instance styles appear as a plain object under the style key,
   * multi-instance ones as an array under the `<style>Multi` key.
   */
  const instances = new Map<string, _Value[]>();
  for (const [key, value] of descriptor) {
    if (_STYLES.has(key)) {
      setdefault(instances, key, []).push(value);
    } else if (_MULTI_KEYS.has(key) && Array.isArray(value)) {
      setdefault(instances, _MULTI_KEYS.get(key), []).push(...value);
    }
  }
  return instances;
}

// Styles Photoshop stores as a plain key whenever they exist (single-instance
// only: the two glows, Bevel/Emboss, Satin). AE imports their parameters
// whenever the key exists, even with `present=False` (psd_noise_gradient
// fixtures). Every other style imports its parameters iff the instance has
// `present=True` - see `parse_layer_styles`.
export const _ALWAYS_WHEN_PRESENT: ReadonlySet<string> = new Set([
  "outerGlow",
  "innerGlow",
  "bevelEmboss",
  "chromeFX",
]);

// Styles whose gradient carries the editor's Smoothness slider as `Intr`
// (0..4096 = 0..100%); AE maps it onto the `gradientSmoothness` leaf
// (psd_styles_smoothness fixture: 2048 -> 50, 1024 -> 25).
export const _GRADIENT_SMOOTHNESS_PREFIXES: ReadonlySet<string> = new Set([
  "outerGlow",
  "innerGlow",
  "gradientFill",
]);

export function _convert_style(
  prefix: string,
  params: readonly _Param[],
  instance: Map<string, _Value>,
): Map<string, StyleValue> {
  const values = new Map<string, StyleValue>();
  for (const param of params) {
    const value = instance.get(param.descriptor_key);
    if (value === undefined) continue;
    try {
      values.set(
        `${prefix}/${param.suffix}`,
        param.convert(value),
      );
    } catch (exc) {
      if (!(exc instanceof UnsupportedStyleError)) throw exc;
      // A single unrepresentable parameter (e.g. a noise-type gradient)
      // is skipped, not fatal - AE imports the style without that leaf.
      // Warn so an unmapped value (e.g. a legacy 4-char blend-mode
      // enum) does not silently leave the leaf at its default.
      warn(
        `style parameter ${prefix}/${param.suffix} was skipped ` +
          `(${exc.message}); the imported style keeps the AE default`,
      );
      continue;
    }
  }
  // The glows choose between a solid color and a gradient fill; AE records
  // the choice explicitly (1 = color, the default; 2 = gradient).
  if (prefix === "outerGlow" || prefix === "innerGlow") {
    values.set(`${prefix}/AEColorChoice`, instance.has("Grad") ? 2.0 : 1.0);
  }
  if (_GRADIENT_SMOOTHNESS_PREFIXES.has(prefix)) {
    const grad = instance.get("Grad") ?? null;
    // bool is an int in Python, so a boolean Intr also counts as a number here.
    const intr = grad instanceof Map ? grad.get("Intr") ?? null : null;
    if (
      grad instanceof Map &&
      (grad.get("GrdF") ?? null) === "CstS" &&
      (typeof intr === "number" || typeof intr === "boolean")
    ) {
      values.set(`${prefix}/gradientSmoothness`, (Number(intr) / 4096.0) * 100.0);
    }
  }
  return values;
}

// ---------------------------------------------------------------------------
// Blend options
// ---------------------------------------------------------------------------

export function read_global_light(file: PathLike): [number, number] {
  /**
   * The document's global light `(angle, altitude)` in degrees.
   *
   * Read from image resources 1037/1049; AE's Layer Styles defaults
   * (120, 30) apply when a resource is absent or the section is malformed.
   */
  let angle = 120.0,
    altitude = 30.0;
  const fp = new BytesIO(
    (() => {
      try {
        return host.fs.readFileSync(fspath(file));
      } catch (e: unknown) {
        const path = fspath(file);
        const err = typeof e === "object" && e !== null ? e : null;
        if (err != null && "code" in err && err.code === "ENOENT") {
          throw new FileNotFoundError(`[Errno 2] No such file or directory: '${path}'`);
        }
        throw new OSError(String((err != null && "message" in err ? err.message : undefined) ?? e));
      }
    })(),
  );
  if (!bytes_eq(fp.read(4), b("8BPS"))) return [angle, altitude];
  fp.seek(26);
  for (const [resource_id, body] of iter_image_resources(fp)) {
    if (resource_id === 1037 && body.length >= 4) {
      angle = struct.unpack(">i", bytes_.slice(body, 0, 4))[0];
    } else if (resource_id === 1049 && body.length >= 4) {
      altitude = struct.unpack(">i", bytes_.slice(body, 0, 4))[0];
    }
  }
  return [angle, altitude];
}

export function _blend_options_values(
  blocks: PsdStyleBlocks,
  global_light: [number, number],
): Map<string, StyleValue> {
  const [angle, altitude] = global_light;
  const values = new Map<string, StyleValue>([
    ["ADBE Global Angle2", angle],
    ["ADBE Global Altitude2", altitude],
  ]);
  if (blocks.fill_opacity != null) {
    values.set("ADBE Layer Fill Opacity2", round((blocks.fill_opacity * 100) / 255));
  }
  if (blocks.blend_interior != null) {
    values.set("ADBE Blend Interior", _bool01(blocks.blend_interior));
  }
  // `brst` lists the channels EXCLUDED from blending as big-endian u4
  // indices (0=R, 1=G, 2=B); an absent/empty block keeps all channels on.
  const restricted = new Set<number>();
  for (let off = 0, n = blocks.channel_restrictions.length - 3; off < n; off += 4) {
    restricted.add(struct.unpack(">I", bytes_.slice(blocks.channel_restrictions, off, off + 4))[0]);
  }
  for (const [index, name] of ["R", "G", "B"].entries()) {
    values.set(`ADBE ${name} Channel Blend`, restricted.has(index) ? 0.0 : 1.0);
  }
  return values;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parse_layer_styles(
  leaf: PsdLayer,
  global_light: [number, number],
): PsdLayerStyles | null {
  /**
   * Resolve a layer's styles to AE Layer Styles values.
   *
   * @param leaf - A `PsdLayer` from `read_psd_layers` (carries the raw blocks).
   * @param global_light - The document global light from `read_global_light`.
   * @returns The resolved styles, or `null` when the layer has no style-related blocks at all or
   *   its descriptor cannot be decoded (the layer then keeps the plain disabled skeleton; a warning
   *   is emitted so the style loss is visible).
   */
  const blocks = leaf.style_blocks;
  if (blocks == null) return null;
  // Photoshop writes an `infx` block (value 0) on every ordinary layer;
  // only a USER deviation activates AE's blend-options chain: a Fill
  // slider away from 100% (`iOpa`), Blend Interior checked (`infx` true)
  // or a channel restriction (`brst`).
  const blend_data =
    blocks.fill_opacity != null ||
    !!blocks.blend_interior ||
    blocks.channel_restrictions?.length > 0;
  let descriptor = new Map<string, _Value>();
  if (blocks.effects != null) {
    try {
      descriptor = _parse_effects_descriptor(blocks.effects);
    } catch (exc) {
      if (!(exc instanceof ValueError)) throw exc;
      warn(
        `layer ${repr(leaf.name)}: the layer-styles descriptor could not ` +
          "be decoded; the styles are imported as disabled",
      );
      return null;
    }
  }
  const values = new Map<string, StyleValue>();
  const enabled: string[] = [];
  const dropped: string[] = [];
  const disabled: string[] = [];
  let imported_any = false;
  for (const [key, instances] of _style_instances(descriptor)) {
    const [prefix, params] = getitem(_STYLES, key);
    const present_instances = instances.filter((inst) => inst instanceof Map);
    if (present_instances.length > 1) {
      // AE drops a multi-instance style entirely, even when every
      // instance is representable.
      dropped.push(prefix);
      continue;
    }
    if (present_instances.length === 0) continue;
    const instance = present_instances[0];
    const is_enabled = py_bool(dict_get(instance, "enab", false));
    // `present` distinguishes an unchecked-but-kept style (imported,
    // tdsb 0x00) from a removed one Photoshop left in the descriptor
    // (skeleton, 0x02). Old writers without the key follow `enab`.
    const is_present = py_bool(dict_get(instance, "present", is_enabled));
    if (!is_present && !_ALWAYS_WHEN_PRESENT.has(prefix)) continue;
    try {
      for (const [k, v] of _convert_style(prefix, params, instance)) values.set(k, v);
    } catch (exc) {
      if (!(exc instanceof KeyError || exc instanceof TypeError_)) throw exc;
      dropped.push(prefix);
      continue;
    }
    imported_any = true;
    if (is_enabled) {
      enabled.push(prefix);
    } else if (is_present) {
      disabled.push(prefix);
    }
  }
  if (imported_any || blend_data) {
    for (const [k, v] of _blend_options_values(blocks, global_light)) values.set(k, v);
  }
  return new PsdLayerStyles(values, enabled, dropped, disabled, blend_data);
}

export function has_enabled_styles(node: PsdLayer | PsdGroup): boolean {
  /**
   * Whether any style instance is enabled on the layer or group.
   *
   * Used to warn about a group's styles, which a layered import does not
   * apply (a layer's merged styles size its footage through
   * `merged_styles_bounds`). An undecodable descriptor counts as styled
   * (the conservative answer).
   */
  const blocks = node.style_blocks;
  if (blocks == null || blocks.effects == null) return false;
  let descriptor: Map<string, _Value>;
  try {
    descriptor = _parse_effects_descriptor(blocks.effects);
  } catch (exc) {
    if (!(exc instanceof ValueError)) throw exc;
    return true;
  }
  return !_enabled_instances(descriptor).next().done;
}

export function* _enabled_instances(
  descriptor: Map<string, _Value>,
): Generator<[string, Map<string, _Value>]> {
  /** `(key, instance)` of every enabled style instance in a descriptor. */
  for (const [key, instances] of _style_instances(descriptor)) {
    for (const instance of instances) {
      if (instance instanceof Map && py_bool(dict_get(instance, "enab", false))) {
        yield [key, instance];
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Merged-styles content box
// ---------------------------------------------------------------------------
//
// Merging styles into the footage rasterizes them, and After Effects sizes the
// result to a box it derives from the style parameters alone - opacity, noise,
// contour shape and the lighting angles do not move it. Measured on AE 2026 by
// importing byte-patched copies of psd_layer_styles.psd (one style at a time,
// ~450 parameter combinations) as COMP_CROPPED_LAYERS:
//
// - A blurred style (drop shadow, outer glow) spreads `round(size * spread%)`
//   px first, then blurs the rest of its size. Its reach is the blur's
//   (Softer: the radius, at least 2; Precise: the radius + 2.5; either: a
//   fixed 4.5 / 6.5 once the spread takes the whole size) plus the spread +
//   2 px. A drop shadow moves by its distance along the light angle, each
//   axis rounded half away from zero.
// - A stroke reaches its size + 2 px outside, half its size (rounded up) + 2
//   centered, nothing inside.
// - A bevel reaches its size (outer bevel) or half of it (emboss, pillow
//   emboss); Smooth adds 1.5 px (2 px at least), Chisel 4 px, and softening
//   `max(softening, 2) - 0.5`. With no softening, a Chisel bevel - or a
//   zero-size one - sits 1 px up and left. An inner bevel stays inside.
// - A reach of `e` px covers `ceil(e)` px left and above and `floor(e)` px
//   right and below, one px less left and above when the style's contour is
//   not anti-aliased.
// - The box is the union of the layer's own bounds and every enabled style
//   instance's box. The effects-scale percentage has no effect.

export function _round_away(value: number): number {
  // The epsilon lands exact halves (a 30 degree light: sin * 11 = 5.4999...
  // in doubles) where AE does.
  return int(copysign(Math.floor(Math.abs(value) + 0.5 + 1e-9), value));
}

export function _blur_reach(size: number, spread: number, precise: boolean): number {
  const spread_px = Math.floor((size * spread) / 100 + 0.5);
  const radius = size - spread_px;
  let reach: number;
  if (precise) {
    reach = radius > 0 ? radius + 2.5 : 6.5;
  } else {
    reach = radius > 0 ? Math.max(radius, 2) : 4.5;
  }
  return reach + (spread_px > 0 ? spread_px + 2 : 0);
}

/** The px a style covers before (left, above) and after (right, below). */
export function _pads(reach: number, anti_aliased: boolean, shift = 0.0): [number, number] {
  const lead = Math.ceil(reach - shift) - (anti_aliased ? 0 : 1);
  return [lead, Math.floor(reach + shift)];
}

export function _bevel_pads(instance: Map<string, _Value>, name: string): [number, number] | null {
  const style = dict_get(instance, "bvlS", "InrB");
  if (style === "InrB") return null;
  const size = json_float(dict_get(instance, "blur", 0));
  let height: number;
  if (style === "OtrB") {
    height = size;
  } else if (style === "Embs" || style === "PlEb") {
    height = Math.ceil(size / 2);
  } else {
    throw new NotImplementedError(
      `layer ${repr(name)}: the merged bounds of a ${repr(style)} bevel are not ` +
        "known; import without merging its layer styles",
    );
  }
  const smooth = dict_get(instance, "bvlT", "SfBL") === "SfBL";
  let reach: number;
  if (smooth) {
    reach = size > 0 ? Math.max(height, 2) + 1.5 : 2.0;
  } else {
    reach = height + 4;
  }
  const softening = json_float(dict_get(instance, "Sftn", 0));
  if (softening > 0) {
    reach += Math.max(softening, 2) - 0.5;
  }
  const shift = softening === 0 && (!smooth || size === 0) ? -1.0 : 0.0;
  const anti_aliased =
    py_bool(dict_get(instance, "useShape", false)) && py_bool(dict_get(instance, "AntA", false));
  return _pads(reach, anti_aliased, shift);
}

export function _instance_box(
  key: string,
  instance: Map<string, _Value>,
  bounds: _Box,
  global_angle: number,
  name: string,
): _Box | null {
  const [left, top, right, bottom] = bounds;
  let dx = 0;
  let dy = 0;
  let lead = 0;
  let trail = 0;
  if (key === "DrSh" || key === "OrGl") {
    const precise = key === "OrGl" && (instance.get("GlwT") ?? null) === "PrBL";
    const reach = _blur_reach(
      json_float(dict_get(instance, "blur", 0)),
      json_float(dict_get(instance, "Ckmt", 0)),
      precise,
    );
    [lead, trail] = _pads(reach, py_bool(dict_get(instance, "AntA", false)));
    if (key === "DrSh") {
      const angle = radians(
        py_bool(instance.get("uglg")) ? global_angle : json_float(dict_get(instance, "lagl", 0)),
      );
      const distance = json_float(dict_get(instance, "Dstn", 0));
      dx = _round_away(-Math.cos(angle) * distance);
      dy = _round_away(Math.sin(angle) * distance);
    }
  } else if (key === "FrFX") {
    const size = json_float(dict_get(instance, "Sz  ", 0));
    const position = dict_get(instance, "Styl", "OutF");
    if (position === "InsF") return null;
    const reach = position === "OutF" ? size : Math.ceil(size / 2);
    lead = trail = int(reach) + 2;
  } else if (key === "ebbl") {
    const pads = _bevel_pads(instance, name);
    if (pads == null) return null;
    [lead, trail] = pads;
  } else {
    // Shadows, glows, satin and overlays inside the layer stay inside it.
    return null;
  }
  return [left + dx - lead, top + dy - lead, right + dx + trail, bottom + dy + trail];
}

export function merged_styles_bounds(node: PsdLayer, global_angle: number): _Box {
  /**
   * The layer's content box once its enabled styles are merged into it.
   *
   * @param node - A `PsdLayer` from `read_psd_layers`, its `bounds` the content the styles grow
   *   from (`psd_bounds.psd_layer_box` passes the masked content: AE grows merged styles from it).
   * @param global_angle - The document's global light angle (`read_global_light`).
   * @returns `(left, top, right, bottom)` in canvas pixels; `node.bounds` when the layer has no
   *   enabled style.
   * @throws {@link NotImplementedError} If the layer has a Stroke Emboss bevel, whose merged bounds
   *   are not known, or its styles cannot be decoded.
   */
  const bounds = node.bounds;
  const blocks = node.style_blocks;
  if (blocks == null || blocks.effects == null) return bounds;
  let descriptor: Map<string, _Value>;
  try {
    descriptor = _parse_effects_descriptor(blocks.effects);
  } catch (exc) {
    if (!(exc instanceof ValueError)) throw exc;
    throw Object.assign(
      new NotImplementedError(
        `layer ${repr(node.name)}: its layer-styles descriptor cannot be ` +
          "decoded, so the merged bounds are not known",
      ),
      { cause: exc },
    );
  }
  let [left, top, right, bottom] = bounds;
  for (const [key, instance] of _enabled_instances(descriptor)) {
    const box = _instance_box(key, instance, bounds, global_angle, node.name);
    if (box != null) {
      left = Math.min(left, box[0]);
      top = Math.min(top, box[1]);
      right = Math.max(right, box[2]);
      bottom = Math.max(bottom, box[3]);
    }
  }
  return [left, top, right, bottom];
}
