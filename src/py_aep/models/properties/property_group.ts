import {
  AttributeError,
  ByteStream,
  KeyError,
  NotImplementedError,
  ValueError,
  at,
  Bytes,
  getOr,
  getMember,
  getOrThrow,
  objectGetattr,
  objectSetattr,
  assert,
  pyClassHooks,
  literal,
  instanceDict,
  typeName,
} from "../../../pyrt/index.ts";
import { BUILTIN_EFFECTS } from "../../data/builtin_effects.ts";
import { EXPRESSION_CONTROLS } from "../../data/effect_controls.ts";
import { MATCH_NAME_TO_AUTO_NAME } from "../../data/match_names.ts";
import { PropertyType } from "../../enums/index.ts";
import { AddableKind, canAddProperty as _canAddProperty, resolveAddable } from "../../resolvers/can_add_property.ts";
import { getAeVersionMajor, requiresVersion } from "../../ae_version.ts";
import { Chunk, ListChunk, readChunks } from "../../binary/chunk.ts";
import { buildDropdownControl, buildExpressionControl, buildTextAnimator, buildTextSelector, buildVectorElement, cloneChunkTree, rewriteOwnerTdpi, rewriteTimeBase } from "../../binary/mutations.ts";
import { TDSN_SENTINEL, TdmnChunk, TdsbChunk, TdsnChunk, TdumChunk, VfdnChunk, tdb4ApplyVfAxisTemplate } from "../../binary/property_chunks.ts";
import type { Utf8Chunk } from "../../binary/scalar_chunks.ts";
import { findByListTypeOrNull, indexByIdentity } from "../../binary/utils.ts";
import { DROPDOWN_CONTROL } from "../../data/dropdown_control.ts";
import { readDesignAxes } from "../../resolvers/font_axes.ts";
import { resolveFontExact } from "../../svg/fonts.ts";
import type { CameraLayer } from "../layers/camera_layer.ts";
import { _GROUP_CHILD_SPECS, _LAYER_STYLE_CHILD_SPECS, _USE_VALUE, GroupSpec, type PropSpec } from "../../synthesis/property.ts";
import { validateString } from "../validators.ts";
import { _PROPERTY_MIN_MAX } from "./overrides.ts";
import { Property, _valuesEqual, _vfTagFromStr } from "./property.ts";
import { _INDEXED_GROUP_MATCH_NAMES, PropertyBase } from "./property_base.ts";
import type { MaskPropertyGroup } from "./mask_property_group.ts";
import type { MatchNameTypes } from "./match_name_types.ts";
import { late } from "../late.ts";



// Mandatory empty subgroups AE writes inside some freshly added shape
// elements, as (match name, tdsb lock flags, tdsb enable flags) triples. A
// group's own contents carries lock-flag 0x04, like the Root Vectors Group.
// Enable-flags is 1 (enabled) except the Materials Group, which AE writes
// as 3 (enabled + collapsed) - matching its default-collapsed UI state.
export const _STROKE_SUBGROUPS: ReadonlyArray<readonly [string, number, number]> = [
  ["ADBE Vector Stroke Dashes", 0, 1],
  ["ADBE Vector Stroke Taper", 0, 1],
  ["ADBE Vector Stroke Wave", 0, 1],
];
export const _VECTOR_SUBGROUPS = new Map<string, ReadonlyArray<readonly [string, number, number]>>([
  [
    "ADBE Vector Group",
    [
      ["ADBE Vectors Group", 4, 1],
      ["ADBE Vector Transform Group", 0, 1],
      ["ADBE Vector Materials Group", 0, 3],
    ],
  ],
  ["ADBE Vector Graphic - Stroke", _STROKE_SUBGROUPS],
  ["ADBE Vector Graphic - G-Stroke", _STROKE_SUBGROUPS],
  ["ADBE Vector Filter - Repeater", [["ADBE Vector Repeater Transform", 0, 1]]],
  ["ADBE Vector Filter - Wiggler", [["ADBE Vector Wiggler Transform", 0, 1]]],
]);

// AE's creation names for shape elements, where they differ from the
// auto-name table ("Rectangle Path 1" vs auto-name "Rectangle").
export const _VECTOR_CREATION_NAMES = new Map<string, string>([
  ["ADBE Vector Shape - Rect", "Rectangle Path"],
  ["ADBE Vector Shape - Ellipse", "Ellipse Path"],
  ["ADBE Vector Shape - Star", "Polystar Path"],
]);

// Per-type creation-name base for text selectors. The Range Selector
// also carries an empty Advanced subgroup in binary.
export const _TEXT_SELECTOR_NAMES = new Map<string, string>([
  ["ADBE Text Selector", "Range Selector"],
  ["ADBE Text Wiggly Selector", "Wiggly Selector"],
  ["ADBE Text Expressible Selector", "Expression Selector"],
]);

// The Puppet engine version. Measured on AE 2026: AE writes an `engv` atom
// holding 2 between every Puppet's `tdmn` and its `LIST:sspc` (new instances,
// its EfdG definition, and an AE 15 project's stored 1 on resave). Without
// the atom AE loads the instance with the Legacy engine: Puppet Engine reads 1
// and the Advanced-only parameters are hidden.
export const _PUPPET_ENGINE_VERSION = Bytes.intToBytes(2, 4, "big");

/**
 * Resolve `name` against the baked built-in effect templates.
 *
 * Matches the effect match name first, then the display name, the same
 * order `matchEffectDefinition` uses for the project's own EfdG. The
 * stored blob is deserialized fresh on every call, so the caller owns
 * the returned chunks and the table stays pristine.
 */
export function _bakedEffectDef(name: string): [string, string, ListChunk] | null {
  let matchName: string;
  let entry = BUILTIN_EFFECTS.get(name) ?? null;
  if (entry != null) {
    matchName = name;
  } else {
    const found = [...BUILTIN_EFFECTS].find(([, value]) => value[0] === name);
    if (found == null) return null;
    matchName = found[0];
    entry = found[1];
  }
  const [display, blob] = entry;
  const raw = Bytes.fromHex(blob);
  const sspc = readChunks(new ByteStream(raw), raw.length)[0];
  assert(sspc instanceof ListChunk);
  return [matchName, display, sspc];
}

/**
 * Insert *chunk* before the 'ADBE Group End' tdmn in *tdgp*.
 *
 * Falls back to appending if no group end marker exists.
 */
export function _insertBeforeGroupEnd(tdgp: ListChunk, chunk: Chunk): void {
  for (let i = tdgp.chunks.length - 1; i >= 0; i--) {
    const c = tdgp.chunks[i];
    if (c.chunkType === "tdmn" && "value" in c && c.value === "ADBE Group End") {
      tdgp.chunks.splice(i, 0, chunk);
      return;
    }
  }
  tdgp.chunks.push(chunk);
}

/** The instance `tdgp` (param container) inside an effect sspc. */
export function _effectTdgp(sspc: ListChunk): ListChunk | null {
  return findByListTypeOrNull(sspc.chunks, "tdgp");
}

/** Replace the instance display name (tdsn) in a cloned effect sspc. */
export function _setEffectInstanceName(sspc: ListChunk, name: string): void {
  const tdgp = _effectTdgp(sspc);
  if (tdgp == null) return;
  for (const [i, inner] of tdgp.chunks.entries()) {
    if (inner.chunkType === "tdsn") {
      tdgp.chunks[i] = TdsnChunk.new_(name);
      return;
    }
  }
}

// A sibling mask name the next "Mask N" counts: "Mask" (number 1) or "Mask"
// plus 1 to 6 ASCII digits (AE 2026 ignores 7-digit numbers, other digit
// sets and any other spacing).
export const _NUMBERED_MASK = /^Mask(?: ([0-9]{1,6}))?$/;

/**
 * The name AE 2026 gives a new mask beside masks named `names`: one past
 * the highest number, keeping the zero padding of the first name holding
 * it ("Mask 007" -\> "Mask 008"; "Mask 0" counts as unnumbered).
 */
export function _nextMaskName(names: Iterable<string>): string {
  let highest = 0;
  let width = 1;
  for (const name of names) {
    const match = _NUMBERED_MASK.exec(name);
    if (match == null) continue;
    const digits = match[1] ?? null;
    const number = digits != null ? Number.parseInt(digits, 10) : 1;
    if (number > highest) {
      highest = number;
      width = digits != null ? digits.length : 1;
    }
  }
  return `Mask ${String(highest + 1).padStart(width, "0")}`;
}

/**
 * Reset every value leaf of a freshly cloned effect to its default.
 *
 * AE's EfdG definition mirrors the project's first applied instance -
 * including edited values, keyframes, and expressions - but
 * `addProperty` must produce a static, default-valued instance. Each
 * leaf is de-animated (keyframes removed) and stripped of any
 * expression, then leaves whose value still differs from the `pard`
 * default are reset. Leaves with no known default keep their value but
 * are still de-animated / de-expressioned.
 */
export function _resetToDefaultValues(group: PropertyGroup): void {
  for (const child of group.properties) {
    if (child instanceof PropertyGroup) {
      _resetToDefaultValues(child);
      continue;
    }
    if (child._arbs != null) {
      // The Curves effect's curves are arbitrary data, with no pard
      // default to reset to.
      child._resetCurves();
      child._clearExpression();
      continue;
    }
    // Clearing the keyframes reverts the leaf to a static value, so
    // the value setter (which rejects keyframed properties) can run.
    child.removeAllKeys();
    child._clearExpression();
    const dflt = child.defaultValue;
    if (dflt != null && !_valuesEqual(child.value, dflt)) {
      // Use the parse-path writer, not the public `value` setter: an
      // enum/popup leaf's stored default can sit below its own pard min
      // (e.g. a no-selection 0 with min=1), which the validating setter
      // would reject - here we are restoring AE's own default, not taking
      // user input, so validation must not run.
      child._cacheValue(dflt);
    }
  }
}

/**
 * Reorder `container.properties` according to `specs`, synthesizing missing entries.
 *
 * Existing children whose match name appears in `specs` are preserved in
 * canonical order. Missing children are created via `Property.synthesized`
 * (for `PropSpec`) or as empty `PropertyGroup` instances (for `GroupSpec`).
 *
 * @param container - Object whose `.properties` list is reordered/filled. Also set as
 *   `parentProperty` on synthesized children.
 * @param specs - Full canonical spec list (NOT pre-filtered by `skip`).
 * @param childDepth - `propertyDepth` for synthesized children.
 * @param kw - Options:
 * - `skip`: Match names to skip synthesis for. Checked only when the match name is **not**
 *     already in the container - existing children are always preserved in canonical position.
 * - `valueOverrides`: `{match_name: (value, default_value)}` for overriding synthesized
 *     property values. When `null`, uses `spec.value` / `spec.defaultValue`.
 * - `tailMode`: What non-spec children to append after the canonical entries: `"groups"`
 *     (only `PropertyGroup`), `"all"` (everything), or `"none"` (nothing).
 */
export function _reorderAndFill(
  container: PropertyGroup,
  specs: ReadonlyArray<PropSpec | GroupSpec>,
  childDepth: number,
  kw: {
    skip?: ReadonlySet<string>;
    valueOverrides?: Map<string, [number | number[], number | number[]]> | null;
    tailMode?: "none" | "groups" | "all";
    aeMajor: number;
  },
): void {
  const { skip = new Set<string>(), valueOverrides = null, tailMode = "groups", aeMajor } = kw;

  const existing = new Map<string, Property | PropertyGroup>();
  for (const child of container.properties) {
    existing.set(child.matchName, child);
  }

  const ordered: (Property | PropertyGroup)[] = [];
  for (const spec of specs) {
    const mn = spec.matchName;
    const child = existing.get(mn);
    if (child !== undefined) {
      child._autoName = spec.autoName;
      if (!(spec instanceof GroupSpec) && child instanceof Property) {
        // Only where the stored flag disagrees: an override is an
        // instance-dict key (see the class defaults of `Property`).
        if (child._color !== spec.color) instanceDict(child).set("_color", spec.color);
        if (spec.chunkBoundsAreHints) {
          // tdum/tduM hold UI slider hints, not real bounds:
          // the spec is authoritative (None = unbounded).
          child._minValueFallback = spec.minValue;
          child._maxValueFallback = spec.maxValue;
        } else {
          if (spec.minValue != null) {
            child._minValueFallback = spec.minValue;
          }
          if (spec.maxValue != null) {
            child._maxValueFallback = spec.maxValue;
          }
        }
        if (spec.canVaryOverTime != null) {
          child._canVaryOverTime = spec.canVaryOverTime;
        }
        if (spec.unitsText != null) {
          child._unitsText = spec.unitsText;
        }
        if (child.defaultValue == null) {
          const dv =
            spec.defaultValue === _USE_VALUE
              ? spec.value
              : spec.defaultValue;
          if (dv != null) child.defaultValue = dv;
        }
      }
      ordered.push(child);
    } else if (skip.has(mn)) {
      continue;
    } else if (spec.minMajor != null && spec.minMajor > aeMajor) {
      continue;
    } else if (spec instanceof GroupSpec) {
      const group = PropertyGroup._new(spec.matchName, spec.autoName, childDepth, {
        parentProperty: container,
        synthetic: true,
        enableFlags: spec.enableFlags,
      });
      ordered.push(group);
    } else {
      const [v, d] = getOr<string, [number | number[], number | number[]], [typeof _USE_VALUE, typeof _USE_VALUE]>(valueOverrides ?? new Map(), mn, [_USE_VALUE, _USE_VALUE]);
      const prop = Property._new(spec, childDepth, {
        parentProperty: container,
        value: v,
        defaultValue: d,
        synthetic: true,
      });
      ordered.push(prop);
    }
  }

  if (tailMode !== "none") {
    const specMatchNames = new Set(specs.map((s) => s.matchName));
    for (const child of container.properties) {
      if (!specMatchNames.has(child.matchName)) {
        if (tailMode === "all" || child instanceof PropertyGroup) ordered.push(child);
      }
    }
  }

  container._properties = ordered;
  for (const child of ordered) child._parentProperty = container;
}

/** Apply min/max override from `_PROPERTY_MIN_MAX` if one exists. */
export function _applyBounds(prop: Property): void {
  const bounds = _PROPERTY_MIN_MAX.get(prop.matchName);
  if (bounds != null) {
    prop._minValueFallback = bounds[0];
    prop._maxValueFallback = bounds[1];
  }
}

/**
 * Derive the collapsed `enabled` state for Layer Styles.
 *
 * ExtendScript reports the Layer Styles group as disabled when no
 * individual style is enabled, and Blend Options mirrors the parent.
 * Synthesized (not in binary) style groups default to disabled.
 */
export function _deriveLayerStylesEnabled(
  group: PropertyGroup,
  aeMajor: number,
  kw: { synthesizeSubgroups: boolean },
): void {
  const { synthesizeSubgroups } = kw;
  let anyStyleEnabled = false;
  let blendOptions: PropertyGroup | null = null;
  for (const child of group.properties) {
    if (!(child instanceof PropertyGroup)) continue;
    const childSpecs = _LAYER_STYLE_CHILD_SPECS.get(child.matchName) ?? null;
    if (childSpecs != null && synthesizeSubgroups) {
      _reorderAndFill(child, childSpecs, child.propertyDepth + 1, { aeMajor });
    }
    if (child.matchName === "ADBE Blend Options Group") {
      blendOptions = child;
    } else if (child._tdsb != null && child._tdsb.synthetic) {
      instanceDict(child).set("enabled", false);
    } else if (child.enabled) {
      anyStyleEnabled = true;
    }
  }
  // Avoid mutating chunk fields (preserves round-trip)
  instanceDict(group).set("enabled", anyStyleEnabled);
  if (blendOptions != null) instanceDict(blendOptions).set("enabled", anyStyleEnabled);
}

/**
 * The `PropertyGroup` object represents a group of properties. It can contain
 * {@link Property} objects and other `PropertyGroup` objects. Property groups can
 * be nested to provide a parent-child hierarchy, with a {@link Layer} object at the
 * top (root) down to a single {@link Property} object, such as the mask feather of
 * the third mask. To traverse the group hierarchy, use {@link PropertyBase} methods
 * and attributes; see `PropertyBase.propertyGroup()`. For examples of how to
 * access properties and property groups, see {@link PropertyBase} object.
 *
 *
 * Info:
 *     `PropertyGroup` is a subclass of {@link PropertyBase}. All methods and
 *     attributes of {@link PropertyBase} are available when working with
 *     `PropertyGroup`.
 *
 * Info:
 *     `PropertyGroup` is a base class for {@link Layer} and `MaskPropertyGroup`.
 *     `PropertyGroup` attributes and methods are available when working with
 *     layer or mask groups.
 *
 * @example
 * ```ts
 * import { parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const comp = app.project.compositions[0];
 * const effects = comp.layers[0].effects;
 * if (effects !== null) {
 *   for (const effect of effects) {
 *     // ...
 *   }
 * }
 * ```
 * @see https://ae-scripting.docsforadobe.dev/property/propertygroup/
 */
export class PropertyGroup extends PropertyBase {
  /**
   * The child list as stored, WITHOUT running deferred child synthesis.
   *
   * Read it directly only where skipping synthesis is the point - during
   * construction, inside `_runDeferredSynthesis` itself, or when
   * materializing chunks (`_materializeLayer`), where forcing synthesis
   * would write children AE omits. Everywhere else use `properties`, which
   * synthesizes first; reading the raw list from a public method silently
   * sees an unsynthesized group.
   */
  declare _properties: (Property | PropertyGroup)[];
  declare _tdmn: TdmnChunk | null;
  declare _tdgp: ListChunk | null;
  declare _fnamUtf8: Utf8Chunk | null;
  declare _deferredAeMajor: number | null;

  /**
   * Create a synthetic empty PropertyGroup with backing chunks.
   *
   * @param matchName - The property's match name.
   * @param autoName - The display name for the group.
   * @param propertyDepth - The depth of the group in the tree.
   * @param kw - Keyword arguments:
   * - `parentProperty`: The container that owns the synthesized group.
   * - `synthetic`: If True, mark backing chunks as synthetic (skipped during serialization).
   * - `enableFlags`: `tdsb` enable-flags byte (bit 0 enabled, bit 1 collapsed). Defaults to `1`
   *     (enabled); pass `2` for a group AE leaves disabled (e.g. an unused layer style).
   */
  static _new(
    matchName: string,
    autoName: string,
    propertyDepth: number,
    kw: {
      parentProperty?: PropertyGroup | null;
      synthetic?: boolean;
      enableFlags?: number;
    } = {},
  ): PropertyGroup {
    const { parentProperty = null, synthetic = false, enableFlags = 1 } = kw;
    const _tdsb = new TdsbChunk({ synthetic });
    _tdsb._enableFlags = enableFlags;
    // AE writes the unnamed sentinel; the display name resolves
    // from auto_name on the model.
    const tdsn = TdsnChunk.new_(TDSN_SENTINEL, { synthetic });
    const nameUtf8 = tdsn.utf8;
    const groupEnd = new TdmnChunk({ value: "ADBE Group End", synthetic });
    const _tdgp = new ListChunk({
      listType: "tdgp",
      chunks: [_tdsb, tdsn, groupEnd],
      synthetic,
    });

    // Insert into parent's chunk tree (before parent's group end).
    let _tdmn: TdmnChunk | null = null;
    if (parentProperty != null) {
      const parentTdgp = "_tdgp" in parentProperty ? parentProperty._tdgp : null;
      if (parentTdgp != null) {
        _tdmn = new TdmnChunk({
          value: matchName,
          synthetic,
        });
        _insertBeforeGroupEnd(parentTdgp, _tdmn);
        _insertBeforeGroupEnd(parentTdgp, _tdgp);
      }
    }

    return new this({
      _tdmn,
      _tdsb,
      _tdgp,
      _nameUtf8: nameUtf8,
      matchName,
      autoName,
      propertyDepth,
      properties: [],
      parentProperty,
    });
  }

  constructor(kw: {
    _tdmn?: TdmnChunk | null;
    _tdgp?: ListChunk | null;
    _tdsb: TdsbChunk | null;
    _nameUtf8?: Utf8Chunk | null;
    _fnamUtf8?: Utf8Chunk | null;
    parentProperty?: PropertyGroup | null;
    matchName: string;
    propertyDepth: number;
    properties: (Property | PropertyGroup)[];
    autoName?: string | null;
  }) {
    const {
      _tdmn = null,
      _tdgp = null,
      _tdsb,
      _nameUtf8 = null,
      _fnamUtf8 = null,
      parentProperty = null,
      matchName,
      propertyDepth,
      properties,
      autoName = null,
    } = kw;
    super({
      _tdsb,
      _nameUtf8,
      parentProperty,
      matchName,
      propertyDepth,
      autoName,
    });

    this._tdmn = _tdmn;
    this._tdgp = _tdgp;
    this._fnamUtf8 = _fnamUtf8;
    this._deferredAeMajor = null;

    this._properties = properties;

    if (_INDEXED_GROUP_MATCH_NAMES.has(matchName)) {
      this._propertyType = PropertyType.INDEXED_GROUP;
    }

    if (
      [
        "ADBE Effect Mask Parade",
        "ADBE Vectors Group",
        // Text-animator structural containers are elided in AE.
        "ADBE Text Animators",
        "ADBE Text Selectors",
        "ADBE Text Animator Properties",
        // The Paint effect's stroke list.
        "ADBE Paint Group",
      ].includes(matchName)
    ) {
      this._elided = true;
    }
    for (const child of this._properties) {
      child._parentProperty = this;
    }
  }

  /** The automatic (display) name derived from `matchName`. */
  get autoName(): string {
    if (this._autoName != null) return this._autoName;
    if (this._fnamUtf8 != null) {
      const name: string = this._fnamUtf8.value.split("\0")[0];
      return name;
    }
    return MATCH_NAME_TO_AUTO_NAME.get(this.matchName) ?? this.matchName;
  }

  /**
   * Flip synthetic flags so backing chunks become visible to write_aep().
   *
   * Called automatically by `ChunkField.set` on first end-user write
   * to a synthesized group. After this method, the group is
   * indistinguishable from one that was parsed from binary.
   */
  _ensureMaterialized(): void {
    if (this._tdsb == null || !this._tdsb.synthetic) return;

    const parent = this.parentProperty;
    if (parent != null) parent._ensureMaterialized();

    // Flip synthetic flags on tdmn + group-owned chunks (not children).
    if (this._tdmn != null) this._tdmn.synthetic = false;
    assert(this._tdgp != null);
    const tdgp = this._tdgp;
    tdgp.synthetic = false;
    this._tdsb.synthetic = false;
    if (this._nameUtf8 != null) {
      this._nameUtf8.synthetic = false;
      // Also unflag tdsn container if present
      for (const c of tdgp.chunks) {
        if (c.chunkType === "tdsn") {
          c.synthetic = false;
          break;
        }
      }
    }
    // Also flip the group end marker.
    for (const c of tdgp.chunks) {
      if (c.chunkType === "tdmn" && "value" in c && c.value === "ADBE Group End") {
        c.synthetic = false;
        break;
      }
    }

    this._repositionCanonically();
  }

  _chunkBody(): ListChunk | null {
    return this._tdgp;
  }

  /** Run deferred child synthesis exactly once, on first access. */
  _ensureChildrenSynthesized(): void {
    const aeMajor = this._deferredAeMajor;
    if (aeMajor == null) return;
    this._deferredAeMajor = null;
    this._runDeferredSynthesis(aeMajor);
  }

  /**
   * Perform full child synthesis for this group.
   *
   * Looks up child specs for the group's match name, reorders/fills
   * children, and defers synthesis on child groups recursively.
   */
  _runDeferredSynthesis(aeMajor: number): void {
    const specs = _GROUP_CHILD_SPECS.get(this.matchName) ?? null;
    if (specs != null) {
      _reorderAndFill(this, specs, this.propertyDepth + 1, {
        aeMajor,
        valueOverrides: this._synthesisValueOverrides(),
      });
    }

    if (this.matchName === "ADBE Layer Styles") {
      _deriveLayerStylesEnabled(this, aeMajor, { synthesizeSubgroups: true });
    }

    for (const child of this._properties) {
      if (child instanceof PropertyGroup) {
        child._deferredAeMajor = aeMajor;
      } else if (child instanceof Property) {
        _applyBounds(child);
      }
    }
  }

  /**
   * Comp-dependent default values for synthesized children.
   *
   * Camera Zoom and Focus Distance default to AE's 50mm-lens zoom
   * (`comp width * pixel aspect / 0.72`), a value the static spec table
   * cannot express. Returns `null` for groups with no comp-dependent
   * defaults.
   */
  _synthesisValueOverrides(): Map<string, [number | number[], number | number[]]> | null {
    if (this.matchName !== "ADBE Camera Options Group") return null;
    let zoom: number;
    try {
      const layer = this._containingLayer;
      if (!("_defaultZoom" in layer)) return null;
      zoom = (layer as CameraLayer)._defaultZoom();
    } catch (e) {
      if (e instanceof ValueError || e instanceof AttributeError) return null;
      throw e;
    }
    return new Map<string, [number | number[], number | number[]]>([
      ["ADBE Camera Zoom", [zoom, zoom]],
      ["ADBE Camera Focus Distance", [zoom, zoom]],
    ]);
  }

  /** List of properties in this group. Read-only. */
  get properties(): (Property | PropertyGroup)[] {
    this._ensureChildrenSynthesized();
    return this._properties;
  }

  /**
   * Return an iterator over the properties in this group.
   *
   * Iterates a snapshot so children can be removed while looping -
   * `PropertyBase.remove()` mutates `properties` in place, so the live
   * list would skip every other child (issue #230).
   */
  [Symbol.iterator](): Iterator<Property | PropertyGroup> {
    return [...this.properties][Symbol.iterator]();
  }

  /** Return the number of child properties in this group. */
  get length(): number {
    return this.properties.length;
  }

  /** Every leaf `Property` under this group, depth-first. */
  *_leafProperties(): Generator<Property> {
    for (const child of this) {
      if (child instanceof PropertyGroup) {
        yield* child._leafProperties();
      } else if (child instanceof Property) {
        yield child;
      }
    }
  }

  /**
   * Look up a child property by attribute access.
   *
   * Matches the attribute name against the camelCase display names
   * of child properties ("Anchor Point" is `anchorPoint`).  This allows natural syntax such as:
   *
   * ```ts
   * import { parse } from "@bevyl-ai/ts-aep";
   * const layer = parse("project.aep").project.compositions[0].layers[0];
   * layer.transform.position.value;
   * layer.transform.opacity.value;
   * ```
   *
   * **Note:** Only invoked when normal attribute lookup has already
   * failed, so class attributes and `@property` descriptors
   * always take priority.
   */
  _missingAttribute(name: string): Property | PropertyGroup {
    // A child property is never named with a leading underscore, so a
    // private name here is always a miss on an internal attribute
    // (`_ldta`, `_chunk`, ...). Answering it without the child scan
    // keeps parent-chain probes like `hasattr(node, "_ldta")` O(1)
    // instead of deriving every sibling's display name.
    if (name.startsWith("_")) throw new AttributeError(name);
    // Avoid infinite recursion during __init__ (before
    // `properties` has been set on the instance).
    try {
      objectGetattr(this, "_properties");
    } catch (e) {
      if (e instanceof AttributeError) throw new AttributeError(name);
      throw e;
    }
    try {
      return this.property(name);
    } catch (e) {
      if (e instanceof KeyError) {
        throw new AttributeError(`'${this.constructor.name}' has no property '${name}'`);
      }
      throw e;
    }
  }

  _assignAttribute(name: string, value: unknown): void {
    // A name the class does not define would only become a Python
    // attribute: nothing reaches the file, and it would shadow the child
    // that attribute access resolves (`transform.position = [...]` leaves
    // Position untouched and makes `transform.position` the list). Layers
    // opt out (`Layer._assignAttribute`) to keep their own public instance
    // attributes.
    if (
      !name.startsWith("_") &&
      !(name in this.constructor.prototype) &&
      !hasClassStatic(this.constructor, name) &&
      !Object.prototype.hasOwnProperty.call(this, name) &&
      !instanceDict(this).has(name)
    ) {
      throw new AttributeError(
        `'${this.constructor.name}' has no attribute '${name}' to set; ` +
          "assign a child property's `value` instead",
      );
    }
    // NOTE(port): PropertyBase defines no `__setattr__`, so Python's `super().__setattr__` is `object`'s, as here.
    objectSetattr(this, name, value);
  }

  property<K extends keyof MatchNameTypes>(key: K): MatchNameTypes[K];
  property(key: number | string): Property | PropertyGroup;
  /**
   * Look up a child property by index or name.
   *
   * This is the canonical access method; `_missingAttribute` (
   * attribute access) delegates here.
   *
   * @example
   * ```ts
   * import { parse } from "@bevyl-ai/ts-aep";
   * const layer = parse("project.aep").project.compositions[0].layers[0];
   * layer.property("ADBE Transform Group").property("ADBE Position");
   * layer.property("ADBE Mask Parade").property(0);
   * layer.property(0);
   * ```
   * @param key - A `number` index or a `string` display name / match name.
   * @throws {@link KeyError} If the string key does not match any child.
   * @throws {@link IndexError} If the integer index is out of range.
   * @throws {@link TypeError} If `key` is neither a `number` nor a `string`.
   */
  property(key: number | string): Property | PropertyGroup {
    if (typeof key === "number" && Number.isInteger(key)) {
      return at(this.properties, key);
    }
    if (typeof key === "string") {
      const prop = this._childOrNull(key);
      if (prop === null) throw new KeyError(literal(key));
      return prop;
    }
    throw new TypeError(`Property key must be int or str, not ${typeName(key)}`);
  }

  /** The child whose display name, match name or snake_case name is `name`, or `null`. */
  _childOrNull<K extends keyof MatchNameTypes>(name: K): MatchNameTypes[K] | null;
  _childOrNull(name: string): Property | PropertyGroup | null;
  _childOrNull(name: string): Property | PropertyGroup | null {
    for (const prop of this.properties) {
      // The match name first: `name` is derived, not stored.
      if (prop.matchName === name) return prop;
      const propName = prop.name;
      if (propName === name || _attrName(propName) === name) return prop;
    }
    return null;
  }

  /**
   * `true` if any child property is modified.
   *
   * For indexed groups (such as Effects or Masks parades), the group
   * is considered modified when it has any children - adding items to
   * an indexed group is itself a modification.  Shape vector groups
   * (value) follow the same rule.
   */
  get isModified(): boolean {
    if (this.propertyType === PropertyType.INDEXED_GROUP && !this.isEffect) {
      return this.properties.length > 0;
    }
    if (this.matchName === "ADBE Vectors Group" && this.properties.length > 0) {
      return true;
    }
    // Essential Properties override groups report modified whenever they
    // hold any override, independent of whether a leaf differs from its
    // source value (AE treats having an override as a modification).
    if (
      (this.matchName === "ADBE Layer Overrides" ||
        this.matchName === "ADBE Layer Overrides Group") &&
      this.properties.length > 0
    ) {
      return true;
    }
    // A parametric-mesh Material Assignment parade reports modified
    // whenever it holds a material atom (like an indexed group), even
    // when the atom's own streams are all at default. (AE 2026.)
    if (this.matchName === "ADBE3D Para Mat Parade") {
      return this.properties.length > 0;
    }
    return this.properties.some((child) => child.isModified);
  }

  /**
   * The number of child properties in this group.
   *
   * Equivalent to ExtendScript `PropertyGroup.numProperties`.
   */
  get numProperties(): number {
    return this.properties.length;
  }

  /**
   * Remove every keyframe from all properties in this group,
   * recursively.
   *
   * Calling this on a {@link Layer} clears the keyframes of every
   * property on the layer, including its marker keyframes. Each
   * animated property reverts to a static value; see
   * `Property.removeAllKeys`.
   */
  removeAllKeys(): void {
    for (const child of this.properties) {
      child.removeAllKeys();
    }
  }

  /**
   * Check whether a property with the given name can be added.
   *
   * Returns `true` if this group is an indexed group and `name` is
   * a valid match name or display name for the group type. For the
   * Effect Parade, the expression controls py_aep can create plus
   * any effect already defined in the project (`LIST:EfdG`) are
   * accepted.
   *
   * @param name - A match name or display name to check.
   */
  canAddProperty(name: string): boolean {
    if (_canAddProperty(this.matchName, this.propertyType, name)) return true;
    return this._installedEffectDef(name) != null;
  }

  /**
   * Create and return a {@link Property} for a variable font axis, and
   * add it to this group.
   *
   * Mirrors ExtendScript `PropertyGroup.addVariableFontAxis()`. Can
   * only be called on the `ADBE Text Animator Properties` group
   * within a text animator. The axis binds to the first free of the
   * 8 `ADBE Text VF Axis` slots; calling it again with an already
   * active tag returns the existing property.
   *
   * The axis bounds, default value, and display name are read from
   * the variable font file with fontTools (After Effects reads them
   * from the installed font; the project file does not store a font
   * path). Pass `fontFile` explicitly, or leave it `null` to locate
   * the installed font from the text document's font family.
   *
   * **Note:** This functionality was added in After Effects 26.0.
   *
   * @param axisTag - The 4-character tag identifying the variable font axis (e.g. `wght`, `wdth`,
   *   `slnt`, `ital`, `opsz`).
   * @param fontFile - Optional path to the variable font file. When `null`, the font is located in
   *   the OS font directories by the text document's font family.
   * @throws {@link ValueError} If this group is not a text animator Properties group, the font
   *   cannot be located or is not a variable font, `axisTag` is not one of the font's axes, or all
   *   8 axis slots are in use.
   */
  addVariableFontAxis(axisTag: string, fontFile: string | null = null): Property {
    validateString(axisTag);
    if (Array.from(axisTag).length !== 4) {
      throw new ValueError("axisTag must be a 4-character tag (e.g. 'wght').");
    }
    if (this.matchName !== "ADBE Text Animator Properties") {
      throw new ValueError(
        "addVariableFontAxis() can only be called on the " +
          "'ADBE Text Animator Properties' group of a text animator.",
      );
    }
    let fontNumber = 0;
    if (fontFile == null) {
      // The .aep stores only the PostScript name; its prefix is the
      // variable font's family (FontObject.familyPrefix semantics).
      // Python `layer.text.sourceText.value`: only a text layer has the group.
      const text = this._containingLayer.text;
      if (text == null) throw new AttributeError("cannot read 'sourceText' of null");
      const textDoc = text.property("ADBE Text Document").value;
      const psName: string = textDoc.font || "";
      const family = psName.split("-")[0];
      const resolved = family ? resolveFontExact(family) : null;
      if (resolved == null) {
        throw new ValueError(
          `Could not locate an installed font for family ${literal(family)}; pass fontFile explicitly.`,
        );
      }
      fontFile = resolved[0].toString();
      fontNumber = resolved[1];
    }
    const axes = readDesignAxes(fontFile, fontNumber);
    const axis = axes.find((a) => a.tag === axisTag) ?? null;
    if (axis == null) {
      const available = axes.map((a) => a.tag).join(", ");
      throw new ValueError(`The font has no ${literal(axisTag)} axis (available: ${available}).`);
    }

    const slots = this.properties.filter(
      (p): p is Property => p instanceof Property && p._isVfAxis,
    );
    for (const p of slots) {
      if (p.axisTag === axisTag) return p;
    }
    const slot = slots.find((p) => p.axisTag == null) ?? null;
    if (slot == null) throw new ValueError("All 8 variable-font axis slots are in use.");

    slot._ensureMaterialized();
    const tagRaw = _vfTagFromStr(axisTag);
    const tdbs = slot._tdbs;
    tdb4ApplyVfAxisTemplate(slot._tdb4);
    assert(slot._cdat != null);
    // AE writes [value, tag] plus eight zero-padding slots.
    slot._cdat.values = [axis.defaultValue, tagRaw, ...new Array(8).fill(0)];
    slot._value = null;
    // Axis bounds come from the font's range (single-component).
    for (const [attr, chunkType, bound] of [
      ["_tdum", "tdum", axis.minValue],
      ["_tduM", "tduM", axis.maxValue],
    ] as const) {
      const existing = getMember(slot, attr);
      if (existing == null) {
        const created = new TdumChunk({ chunkType, values: [bound] });
        tdbs.chunks.push(created);
        slot[attr] = created;
      } else {
        existing.values = [bound];
      }
    }
    // AE stores the axis display name in a vfdn sibling after the tdbs.
    const vfdn = VfdnChunk.new_(`Font Axis ${axis.name}`);
    assert(this._tdgp != null);
    const tdgp = this._tdgp;
    tdgp.chunks.splice(indexByIdentity(tdgp.chunks, tdbs) + 1, 0, vfdn);
    slot._vfdn = vfdn;
    slot._vfTagCache = tagRaw;
    return slot;
  }

  /**
   * Create and return a new property with the specified name,
   * and add it to this group.
   *
   * Indexed groups (and, as a named-group exception, the text
   * animator `Properties` pool) support adding properties; see
   * `canAddProperty`. Accepted names cover every ExtendScript
   * addable family: mask atoms (`ADBE Mask Atom` / `Mask`), the
   * expression controls including the Dropdown Menu Control (e.g.
   * `ADBE Slider Control` / `Slider Control`, `ADBE Dropdown Control`), shape elements on a contents group (e.g.
   * `ADBE Vector Shape - Rect`, `ADBE Vector Group`), text
   * selectors (e.g. `ADBE Text Selector` / `Range Selector`), text
   * animators (`ADBE Text Animator` / `Animator`), and animator
   * properties from the fixed pool (e.g. `ADBE Text Position 3D` /
   * `Position`).
   *
   * **Note:** Unlike ExtendScript, adding a property does not invalidate
   * existing references to the group's other properties.
   *
   * @param name - The display name or match name of the property to add.
   * @throws {@link ValueError} If a property with this name cannot be added to this group.
   */
  addProperty<K extends keyof MatchNameTypes>(name: K): MatchNameTypes[K];
  addProperty(name: string): Property | PropertyGroup;
  addProperty(name: string): Property | PropertyGroup {
    const result = resolveAddable(this.matchName, this.propertyType, name);
    if (result == null) {
      // Effect Parade: any effect already defined in the project's
      // EfdG (re-applied by cloning its stored definition).
      const installed = this._installedEffectDef(name);
      if (installed != null) return this._addInstalledEffect(...installed);
      throw new ValueError(`Cannot add property '${name}' to group '${this.matchName}'`);
    }
    const [resolved, kind] = result;
    if (kind === AddableKind.MASK) return this._addMaskAtom();
    if (kind === AddableKind.EXPRESSION_CONTROL) return this._addExpressionControl(resolved);
    if (kind === AddableKind.DROPDOWN) return this._addDropdownControl();
    if (kind === AddableKind.SHAPE) return this._addVectorElement(resolved);
    if (kind === AddableKind.TEXT_SELECTOR) return this._addTextSelector(resolved);
    if (kind === AddableKind.TEXT_ANIMATOR) return this._addTextAnimator();
    if (kind === AddableKind.ANIMATOR_PROPERTY) return this._addAnimatorProperty(resolved);
    // Exhaustiveness guard: resolve_addable returns one of the seven
    // AddableKind members, each handled above. Reached only if a new
    // kind is added without a dispatch arm.
    throw new NotImplementedError(`no addProperty builder for '${resolved}'`);
  }

  /**
   * `'{base} {n}'` with `n >= start`, skipping any number already
   * used by a sibling so a new instance never duplicates an existing
   * name. AE numbers same-type instances per container, but a count+1
   * scheme collides once an instance is removed or the existing names
   * are non-contiguous (e.g. `['Stroke 1', 'Stroke 3']`).
   */
  _freeNumberedName(base: string, start: number): string {
    const existing = new Set(this.properties.map((p) => p.name));
    let n = start;
    while (existing.has(`${base} ${n}`)) n += 1;
    return `${base} ${n}`;
  }

  /**
   * The tdsn name for a new effect instance: the first instance uses
   * the unnamed sentinel (so it shows the effect's own name); later ones
   * get a baked `"{display} N"`. `sameType` is the count of existing
   * instances (counted per match name, or per pseudo-effect namespace
   * for the Dropdown Control).
   */
  _effectInstanceName(display: string, sameType: number): string {
    if (sameType === 0) return TDSN_SENTINEL;
    return this._freeNumberedName(display, sameType + 1);
  }

  /** Add a new default mask atom to this Masks parade group. */
  _addMaskAtom(): MaskPropertyGroup {
    this._ensureMaterialized();
    // AE assigns a monotonic per-layer mask id (highest existing + 1),
    // not a positional count: len+1 collides after a mid-parade mask is
    // removed, or on a parsed layer whose mask ids are non-contiguous.
    const existing = this.properties.filter(
      (m): m is MaskPropertyGroup => m._isMaskGroup(),
    );
    const nextId = Math.max(0, ...existing.map((m) => m._mkif.maskId)) + 1;
    // The name is numbered past the highest "Mask N" name, independently
    // of the id (AE 2026: beside "Mask 1" and a mask renamed "stored" the
    // new mask is id 3 "Mask 2"; beside "Mask 1" and "Mask 3", "Mask 4").
    const mask = late.MaskPropertyGroup._new(this, this.propertyDepth + 1, {
      name: _nextMaskName(existing.map((m) => m.name)),
      maskId: nextId,
    });
    this._properties.push(mask);
    return mask;
  }

  /** Add a fresh expression-control effect to this Effect Parade. */
  _addExpressionControl(matchName: string): PropertyGroup {
    const skeleton = getOrThrow(EXPRESSION_CONTROLS, matchName);
    this._ensureMaterialized();
    const comp = this._containingLayer.containingComp;

    // AE names the first instance after the effect (unnamed tdsn
    // sentinel) and later instances "Name N" with a baked tdsn.
    const display: string = skeleton.name;
    const sameType = this.properties.filter((p) => p.matchName === matchName).length;
    const tdsnName = this._effectInstanceName(display, sameType);

    const [tdmn, sspc] = buildExpressionControl(
      matchName,
      display,
      Bytes.fromHex(skeleton.part),
      {
        tdsnName,
        timeBase: comp._cdta.internalTimebase,
        layerId: this._containingLayer.id,
        layerParamName: skeleton.layerParam,
      },
    );
    return this._attachEffect(tdmn, sspc, matchName);
  }

  /**
   * Add a fresh Dropdown Menu Control to this Effect Parade.
   *
   * The Dropdown Menu Control is a pseudo-effect with a per-instance
   * generated match name, so AE's "Name N" numbering counts existing
   * dropdowns by the `Pseudo/` namespace rather than by match name.
   */
  _addDropdownControl(): PropertyGroup {
    this._ensureMaterialized();
    const comp = this._containingLayer.containingComp;

    const display: string = DROPDOWN_CONTROL.name;
    const sameType = this.properties.filter((p) =>
      p.matchName.startsWith("Pseudo/@@"),
    ).length;
    const tdsnName = this._effectInstanceName(display, sameType);

    const [tdmn, sspc] = buildDropdownControl({
      tdsnName,
      timeBase: comp._cdta.internalTimebase,
      layerId: this._containingLayer.id,
    });
    return this._attachEffect(tdmn, sspc, tdmn.value);
  }

  /**
   * Resolve `name` to an effect template.
   *
   * Only the Effect Parade can host installed effects. The project's
   * own `LIST:EfdG` wins: its definition was written by whichever AE
   * release saved the project, so cloning it keeps the instance
   * consistent with the rest of the file. A built-in absent from the
   * project falls back to the baked table, which is what lets an
   * effect be added to a project that has never used it.
   *
   * Returns `(match_name, display_name, def_sspc)`, else `null`.
   */
  _installedEffectDef(name: string): [string, string, ListChunk] | null {
    if (this.matchName !== "ADBE Effect Parade") return null;
    const project = this._containingLayer.containingComp._project;
    const found = late.matchEffectDefinition(project._effectDefinitions(), name);
    if (found != null) return found;
    return _bakedEffectDef(name);
  }

  /**
   * Add an effect already defined in the project by cloning its
   * `LIST:EfdG` definition.
   *
   * The stored definition is a complete sspc template, so cloning it
   * and retargeting the hidden `-0000` internal param to this layer
   * yields a valid applied effect. AE's EfdG entry mirrors the first
   * applied instance (including edited values and keyframes), so the
   * value parameters are de-animated and reset to their `pard`
   * defaults to match `addProperty`'s static, default-valued
   * semantics.
   *
   * The definition also mirrors that instance's `tdb4` timebases, so
   * the clone is restamped with this composition's: an effect first
   * applied in a 24 fps comp otherwise carries 24576 into a 60 fps
   * one, and the parameter's keyframe times are then read against the
   * wrong base.
   */
  _addInstalledEffect(
    matchName: string,
    display: string,
    defSspc: ListChunk,
  ): PropertyGroup {
    this._ensureMaterialized();
    const sspc = cloneChunkTree(defSspc);
    assert(sspc instanceof ListChunk);
    rewriteOwnerTdpi(sspc, this._containingLayer.id);
    const comp = this._containingLayer.containingComp;
    rewriteTimeBase(sspc, comp._cdta.internalTimebase);

    // Name the instance: the first uses the unnamed tdsn sentinel
    // (so it shows the effect's fnam name); later ones get "Name N".
    const sameType = this.properties.filter((p) => p.matchName === matchName).length;
    const tdsnName = this._effectInstanceName(display, sameType);
    _setEffectInstanceName(sspc, tdsnName);

    const engv =
      matchName === "ADBE FreePin3"
        ? new Chunk({ chunkType: "engv", data: _PUPPET_ENGINE_VERSION })
        : null;
    const effect = this._attachEffect(
      new TdmnChunk({ value: matchName }),
      sspc,
      matchName,
      engv,
    );
    _resetToDefaultValues(effect);
    return effect;
  }

  /**
   * Insert a built effect's chunks, parse, wire the model, append.
   *
   * `parseEffect` is the canonical chunks-\>model path for effects
   * (param-def merging, child synthesis); `duplicate()` uses it too.
   * `engv` is the engine-version atom AE stores between an effect's
   * `tdmn` and its `sspc` (Puppet only).
   */
  _attachEffect(
    tdmn: TdmnChunk,
    sspc: ListChunk,
    matchName: string,
    engv: Chunk | null = null,
  ): PropertyGroup {
    const layer = this._containingLayer;
    const comp = layer.containingComp;
    const parentTdgp = this._tdgp;
    assert(parentTdgp != null);
    _insertBeforeGroupEnd(parentTdgp, tdmn);
    if (engv != null) _insertBeforeGroupEnd(parentTdgp, engv);
    _insertBeforeGroupEnd(parentTdgp, sspc);

    const effectParamDefs = comp._project._effectParamDefs;
    const effect = late.parseEffect(
      sspc,
      matchName,
      this.propertyDepth + 1,
      effectParamDefs,
      comp,
      tdmn,
      layer,
    );
    effect._parentProperty = this;
    effect._deferredAeMajor = getAeVersionMajor(layer);
    this._properties.push(effect);
    return effect;
  }

  /**
   * Insert a built group's chunks, parse, wire the model, append.
   *
   * `parsePropertyGroup` is the canonical chunks-\>model path for
   * added groups (mandatory subgroups, the Path element's om-s,
   * deferred child synthesis); the shape, selector and animator
   * builders share it, as `_attachEffect` does for effects.
   */
  _attachGroup(tdmn: TdmnChunk, tdgp: ListChunk, matchName: string): PropertyGroup {
    const layer = this._containingLayer;
    const comp = layer.containingComp;
    const parentTdgp = this._tdgp;
    assert(parentTdgp != null);
    _insertBeforeGroupEnd(parentTdgp, tdmn);
    _insertBeforeGroupEnd(parentTdgp, tdgp);

    const group = late.parsePropertyGroup(
      tdgp,
      matchName,
      this.propertyDepth + 1,
      comp._project._effectParamDefs,
      comp,
      tdmn,
      layer,
    );
    group._parentProperty = this;
    group._deferredAeMajor = getAeVersionMajor(layer);
    this._properties.push(group);
    return group;
  }

  /** Add a fresh shape element to this contents group. */
  _addVectorElement(matchName: string): PropertyGroup {
    this._ensureMaterialized();
    const comp = this._containingLayer.containingComp;

    // AE bakes a per-container, per-type numbered name into the tdsn.
    const base = _VECTOR_CREATION_NAMES.get(matchName) || (MATCH_NAME_TO_AUTO_NAME.get(matchName) ?? matchName);
    const sameType = this.properties.filter((p) => p.matchName === matchName).length;
    const pathTimeBase =
      matchName === "ADBE Vector Shape - Group" ? comp._cdta.internalTimebase : null;
    const [tdmn, tdgp] = buildVectorElement(
      matchName,
      this._freeNumberedName(base, sameType + 1),
      {
        subgroups: _VECTOR_SUBGROUPS.get(matchName) ?? [],
        pathTimeBase,
      },
    );
    return this._attachGroup(tdmn, tdgp, matchName);
  }

  /**
   * Apply an animator property from the fixed pool (the
   * named-group exception).
   *
   * The `ADBE Text Animator Properties` group exposes a fixed pool
   * of synthesized members; unlike indexed groups, "adding" one
   * materializes the existing member in place (it keeps its pool
   * position) rather than appending a new child. Idempotent: adding
   * an already-applied property is a no-op, as in AE.
   */
  _addAnimatorProperty(matchName: string): Property | PropertyGroup {
    const prop = this.properties.find((p) => p.matchName === matchName) ?? null;
    // resolve_addable returns only pool match names, so the member exists.
    assert(prop != null);
    prop._ensureMaterialized();
    return prop;
  }

  /**
   * Add a fresh animator to this Text Animators group.
   *
   * A new animator is a minimal `[Animator N, Properties (empty)]`
   * container; its (empty) Selectors group and the 103-property
   * Properties pool are synthesized on parse.
   */
  _addTextAnimator(): PropertyGroup {
    this._ensureMaterialized();
    const sameType = this.properties.filter(
      (p) => p.matchName === "ADBE Text Animator",
    ).length;
    const [tdmn, tdgp] = buildTextAnimator(
      this._freeNumberedName("Animator", sameType + 1),
    );
    return this._attachGroup(tdmn, tdgp, "ADBE Text Animator");
  }

  /**
   * Add a fresh selector to this text animator's Selectors group.
   *
   * Like shape elements, a selector is a minimal named group whose
   * value children are synthesized; the Range Selector additionally
   * carries an empty `ADBE Text Range Advanced` subgroup in binary.
   */
  _addTextSelector(matchName: string): PropertyGroup {
    this._ensureMaterialized();
    const base = getOrThrow(_TEXT_SELECTOR_NAMES, matchName);
    const sameType = this.properties.filter((p) => p.matchName === matchName).length;
    const [tdmn, tdgp] = buildTextSelector(
      matchName,
      this._freeNumberedName(base, sameType + 1),
      { hasAdvanced: matchName === "ADBE Text Selector" },
    );
    return this._attachGroup(tdmn, tdgp, matchName);
  }

  _isGroup(): this is PropertyGroup {
    return true;
  }
}

// `_missingAttribute` (child lookup by attribute name) and `_assignAttribute` without a proxy
// around each group. Exact here: `_assignAttribute` (this one and `Layer`'s) passes every
// existing attribute through and only refuses new public names.
pyClassHooks(PropertyGroup, { setattrPassesPrivate: true });

// Python `@requires_version(26)` on `addVariableFontAxis`: the
// decorator wraps the method once the class body has been evaluated.
PropertyGroup.prototype.addVariableFontAxis = requiresVersion(26)(
  PropertyGroup.prototype.addVariableFontAxis,
);

/** Class-level attributes (TS statics) of `ctor` and its bases, excluding Function built-ins. */
function hasClassStatic(ctor: Function, name: string): boolean {
  if (name === "name" || name === "length" || name === "prototype") return false;
  for (let c = ctor; c && c !== Function.prototype; c = Object.getPrototypeOf(c)) {
    if (Object.prototype.hasOwnProperty.call(c, name)) return true;
  }
  return false;
}

/** The attribute a child is reachable by: its display name in camelCase ("Anchor Point" is `anchorPoint`). */
export function _attrName(displayName: string): string {
  return displayName.toLowerCase().replace(/ (.)/g, (_m, c: string) => c.toUpperCase());
}
