import {
  AttributeError,
  BytesIO,
  KeyError,
  NotImplementedError,
  TypeError_,
  ValueError,
  at,
  bytes_,
  deferred,
  dictGet,
  getattr,
  getitem,
  int,
  max,
  objectGetattr,
  objectSetattr,
  pyAssert,
  pyClassHooks,
  pyOr,
  repr,
  split,
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
import { _GROUP_CHILD_SPECS, _LAYER_STYLE_CHILD_SPECS, _USE_VALUE, GroupSpec, type PropSpec } from "../../synthesis/property.ts";
import { validateString } from "../validators.ts";
import { _PROPERTY_MIN_MAX } from "./overrides.ts";
import { Property, _valuesEqual, _vfTagFromStr } from "./property.ts";
import { _INDEXED_GROUP_MATCH_NAMES, PropertyBase } from "./property_base.ts";
import type { MaskPropertyGroup } from "./mask_property_group.ts";
import type { MatchNameTypes } from "./match_name_types.ts";


const _maskPropertyGroup = deferred<typeof import("./mask_property_group.ts")>("py_aep/models/properties/mask_property_group");
const _effect = deferred<typeof import("../../parsers/effect.ts")>("py_aep/parsers/effect");
const _property = deferred<typeof import("../../parsers/property.ts")>("py_aep/parsers/property");

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
export const _PUPPET_ENGINE_VERSION = bytes_.intToBytes(2, 4, "big");

export function _bakedEffectDef(name: string): [string, string, ListChunk] | null {
  /**
   * Resolve `name` against the baked built-in effect templates.
   *
   * Matches the effect match name first, then the display name, the same
   * order `match_effect_definition` uses for the project's own EfdG. The
   * stored blob is deserialized fresh on every call, so the caller owns
   * the returned chunks and the table stays pristine.
   */
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
  const raw = bytes_.fromhex(blob);
  const sspc = readChunks(new BytesIO(raw), raw.length)[0];
  pyAssert(sspc instanceof ListChunk);
  return [matchName, display, sspc];
}

export function _insertBeforeGroupEnd(tdgp: ListChunk, chunk: Chunk): void {
  /**
   * Insert *chunk* before the 'ADBE Group End' tdmn in *tdgp*.
   *
   * Falls back to appending if no group end marker exists.
   */
  for (let i = tdgp.chunks.length - 1; i >= 0; i--) {
    const c = tdgp.chunks[i];
    if (c.chunk_type === "tdmn" && "value" in c && c.value === "ADBE Group End") {
      tdgp.chunks.splice(i, 0, chunk);
      return;
    }
  }
  tdgp.chunks.push(chunk);
}

export function _effectTdgp(sspc: ListChunk): ListChunk | null {
  /** The instance `tdgp` (param container) inside an effect sspc. */
  return findByListTypeOrNull(sspc.chunks, "tdgp");
}

export function _setEffectInstanceName(sspc: ListChunk, name: string): void {
  /** Replace the instance display name (tdsn) in a cloned effect sspc. */
  const tdgp = _effectTdgp(sspc);
  if (tdgp == null) return;
  for (const [i, inner] of tdgp.chunks.entries()) {
    if (inner.chunk_type === "tdsn") {
      tdgp.chunks[i] = TdsnChunk.new_(name);
      return;
    }
  }
}

// A sibling mask name the next "Mask N" counts: "Mask" (number 1) or "Mask"
// plus 1 to 6 ASCII digits (AE 2026 ignores 7-digit numbers, other digit
// sets and any other spacing).
export const _NUMBERED_MASK = /^Mask(?: ([0-9]{1,6}))?$/;

export function _nextMaskName(names: Iterable<string>): string {
  /**
   * The name AE 2026 gives a new mask beside masks named `names`: one past
   * the highest number, keeping the zero padding of the first name holding
   * it ("Mask 007" -\> "Mask 008"; "Mask 0" counts as unnumbered).
   */
  let highest = 0;
  let width = 1;
  for (const name of names) {
    const match = _NUMBERED_MASK.exec(name);
    if (match == null) continue;
    const digits = match[1] ?? null;
    const number = digits != null ? int(digits) : 1;
    if (number > highest) {
      highest = number;
      width = digits != null ? digits.length : 1;
    }
  }
  return `Mask ${String(highest + 1).padStart(width, "0")}`;
}

export function _resetToDefaultValues(group: PropertyGroup): void {
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
  for (const child of group.properties) {
    if (child instanceof PropertyGroup) {
      _resetToDefaultValues(child);
      continue;
    }
    if (child._arbs != null) {
      // The Curves effect's curves are arbitrary data, with no pard
      // default to reset to.
      child._reset_curves();
      child._clear_expression();
      continue;
    }
    // Clearing the keyframes reverts the leaf to a static value, so
    // the value setter (which rejects keyframed properties) can run.
    child.removeAllKeys();
    child._clear_expression();
    const dflt = child.defaultValue;
    if (dflt != null && !_valuesEqual(child.value, dflt)) {
      // Use the parse-path writer, not the public `value` setter: an
      // enum/popup leaf's stored default can sit below its own pard min
      // (e.g. a no-selection 0 with min=1), which the validating setter
      // would reject - here we are restoring AE's own default, not taking
      // user input, so validation must not run.
      child._cache_value(dflt);
    }
  }
}

export function _reorderAndFill(
  container: PropertyGroup,
  specs: ReadonlyArray<PropSpec | GroupSpec>,
  childDepth: number,
  kw: {
    skip?: ReadonlySet<string>;
    value_overrides?: Map<string, [number | number[], number | number[]]> | null;
    tail_mode?: "none" | "groups" | "all";
    ae_major: number;
  },
): void {
  /**
   * Reorder `container.properties` according to `specs`, synthesizing missing entries.
   *
   * Existing children whose match name appears in `specs` are preserved in
   * canonical order. Missing children are created via `Property.synthesized`
   * (for `PropSpec`) or as empty `PropertyGroup` instances (for `GroupSpec`).
   *
   * @param container - Object whose `.properties` list is reordered/filled. Also set as
   *   `parent_property` on synthesized children.
   * @param specs - Full canonical spec list (NOT pre-filtered by `skip`).
   * @param child_depth - `property_depth` for synthesized children.
   * @param skip - Match names to skip synthesis for. Checked only when the match name is **not**
   *   already in the container - existing children are always preserved in canonical position.
   * @param value_overrides - `{match_name: (value, default_value)}` for overriding synthesized
   *   property values. When `null`, uses `spec.value` / `spec.defaultValue`.
   * @param tail_mode - What non-spec children to append after the canonical entries: `"groups"`
   *   (only `PropertyGroup`), `"all"` (everything), or `"none"` (nothing).
   */
  const { skip = new Set<string>(), value_overrides = null, tail_mode = "groups", ae_major } = kw;

  const existing = new Map<string, Property | PropertyGroup>();
  for (const child of container.properties) {
    existing.set(child.matchName, child);
  }

  const ordered: (Property | PropertyGroup)[] = [];
  for (const spec of specs) {
    const mn = spec.match_name;
    const child = existing.get(mn);
    if (child !== undefined) {
      child._auto_name = spec.auto_name;
      if (!(spec instanceof GroupSpec) && child instanceof Property) {
        // Only where the stored flag disagrees: an override is an
        // instance-dict key (see the class defaults of `Property`).
        if (child._color !== spec.color) instanceDict(child).set("_color", spec.color);
        if (spec.chunk_bounds_are_hints) {
          // tdum/tduM hold UI slider hints, not real bounds:
          // the spec is authoritative (None = unbounded).
          child._min_value_fallback = spec.min_value;
          child._max_value_fallback = spec.max_value;
        } else {
          if (spec.min_value != null) {
            child._min_value_fallback = spec.min_value;
          }
          if (spec.max_value != null) {
            child._max_value_fallback = spec.max_value;
          }
        }
        if (spec.can_vary_over_time != null) {
          child._can_vary_over_time = spec.can_vary_over_time;
        }
        if (spec.units_text != null) {
          child._units_text = spec.units_text;
        }
        if (child.defaultValue == null) {
          const dv =
            spec.default_value === _USE_VALUE
              ? spec.value
              : spec.default_value;
          if (dv != null) child.defaultValue = dv;
        }
      }
      ordered.push(child);
    } else if (skip.has(mn)) {
      continue;
    } else if (spec.min_major != null && spec.min_major > ae_major) {
      continue;
    } else if (spec instanceof GroupSpec) {
      const group = PropertyGroup._new(spec.match_name, spec.auto_name, childDepth, {
        parent_property: container,
        synthetic: true,
        enable_flags: spec.enable_flags,
      });
      ordered.push(group);
    } else {
      const [v, d] = dictGet<string, [number | number[], number | number[]], [typeof _USE_VALUE, typeof _USE_VALUE]>(value_overrides ?? new Map(), mn, [_USE_VALUE, _USE_VALUE]);
      const prop = Property._new(spec, childDepth, {
        parent_property: container,
        value: v,
        default_value: d,
        synthetic: true,
      });
      ordered.push(prop);
    }
  }

  if (tail_mode !== "none") {
    const specMatchNames = new Set(specs.map((s) => s.match_name));
    for (const child of container.properties) {
      if (!specMatchNames.has(child.matchName)) {
        if (tail_mode === "all" || child instanceof PropertyGroup) ordered.push(child);
      }
    }
  }

  container._properties = ordered;
  for (const child of ordered) child._parent_property = container;
}

export function _applyBounds(prop: Property): void {
  /** Apply min/max override from `_PROPERTY_MIN_MAX` if one exists. */
  const bounds = _PROPERTY_MIN_MAX.get(prop.matchName);
  if (bounds != null) {
    prop._min_value_fallback = bounds[0];
    prop._max_value_fallback = bounds[1];
  }
}

export function _deriveLayerStylesEnabled(
  group: PropertyGroup,
  aeMajor: number,
  kw: { synthesize_subgroups: boolean },
): void {
  /**
   * Derive the collapsed `enabled` state for Layer Styles.
   *
   * ExtendScript reports the Layer Styles group as disabled when no
   * individual style is enabled, and Blend Options mirrors the parent.
   * Synthesized (not in binary) style groups default to disabled.
   */
  const { synthesize_subgroups } = kw;
  let anyStyleEnabled = false;
  let blendOptions: PropertyGroup | null = null;
  for (const child of group.properties) {
    if (!(child instanceof PropertyGroup)) continue;
    const childSpecs = _LAYER_STYLE_CHILD_SPECS.get(child.matchName) ?? null;
    if (childSpecs != null && synthesize_subgroups) {
      _reorderAndFill(child, childSpecs, child.propertyDepth + 1, { ae_major: aeMajor });
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
   * construction, inside `_run_deferred_synthesis` itself, or when
   * materializing chunks (`_materialize_layer`), where forcing synthesis
   * would write children AE omits. Everywhere else use `properties`, which
   * synthesizes first; reading the raw list from a public method silently
   * sees an unsynthesized group.
   */
  declare _properties: (Property | PropertyGroup)[];
  declare _tdmn: TdmnChunk | null;
  declare _tdgp: ListChunk | null;
  declare _fnam_utf8: Utf8Chunk | null;
  declare _deferred_ae_major: number | null;

  /**
   * Create a synthetic empty PropertyGroup with backing chunks.
   *
   * @param matchName - The property's match name.
   * @param autoName - The display name for the group.
   * @param propertyDepth - The depth of the group in the tree.
   * @param kw - Keyword arguments:
   * - `parent_property`: The container that owns the synthesized group.
   * - `synthetic`: If True, mark backing chunks as synthetic (skipped during serialization).
   * - `enable_flags`: `tdsb` enable-flags byte (bit 0 enabled, bit 1 collapsed). Defaults to `1`
   *     (enabled); pass `2` for a group AE leaves disabled (e.g. an unused layer style).
   */
  static _new(
    matchName: string,
    autoName: string,
    propertyDepth: number,
    kw: {
      parent_property?: PropertyGroup | null;
      synthetic?: boolean;
      enable_flags?: number;
    } = {},
  ): PropertyGroup {
    const { parent_property = null, synthetic = false, enable_flags = 1 } = kw;
    const _tdsb = new TdsbChunk({ synthetic });
    _tdsb._enable_flags = enable_flags;
    // AE writes the unnamed sentinel; the display name resolves
    // from auto_name on the model.
    const tdsn = TdsnChunk.new_(TDSN_SENTINEL, { synthetic });
    const nameUtf8 = tdsn.utf8;
    const groupEnd = new TdmnChunk({ value: "ADBE Group End", synthetic });
    const _tdgp = new ListChunk({
      list_type: "tdgp",
      chunks: [_tdsb, tdsn, groupEnd],
      synthetic,
    });

    // Insert into parent's chunk tree (before parent's group end).
    let _tdmn: TdmnChunk | null = null;
    if (parent_property != null) {
      const parentTdgp = getattr(parent_property, "_tdgp", null);
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
      _name_utf8: nameUtf8,
      match_name: matchName,
      auto_name: autoName,
      property_depth: propertyDepth,
      properties: [],
      parent_property,
    });
  }

  constructor(kw: {
    _tdmn?: TdmnChunk | null;
    _tdgp?: ListChunk | null;
    _tdsb: TdsbChunk | null;
    _name_utf8?: Utf8Chunk | null;
    _fnam_utf8?: Utf8Chunk | null;
    parent_property?: PropertyGroup | null;
    match_name: string;
    property_depth: number;
    properties: (Property | PropertyGroup)[];
    auto_name?: string | null;
  }) {
    const {
      _tdmn = null,
      _tdgp = null,
      _tdsb,
      _name_utf8 = null,
      _fnam_utf8 = null,
      parent_property = null,
      match_name,
      property_depth,
      properties,
      auto_name = null,
    } = kw;
    super({
      _tdsb,
      _name_utf8,
      parent_property,
      match_name,
      property_depth,
      auto_name,
    });

    this._tdmn = _tdmn;
    this._tdgp = _tdgp;
    this._fnam_utf8 = _fnam_utf8;
    this._deferred_ae_major = null;

    this._properties = properties;

    if (_INDEXED_GROUP_MATCH_NAMES.has(match_name)) {
      this._property_type = PropertyType.INDEXED_GROUP;
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
      ].includes(match_name)
    ) {
      this._elided = true;
    }
    for (const child of this._properties) {
      child._parent_property = this;
    }
  }

  /** The automatic (display) name derived from `match_name`. */
  get autoName(): string {
    if (this._auto_name != null) return this._auto_name;
    if (this._fnam_utf8 != null) {
      const name: string = split(this._fnam_utf8.value, "\0")[0];
      return name;
    }
    return MATCH_NAME_TO_AUTO_NAME.get(this.matchName) ?? this.matchName;
  }

  /**
   * Flip synthetic flags so backing chunks become visible to write_aep().
   *
   * Called automatically by `ChunkField.__set__` on first end-user write
   * to a synthesized group. After this method, the group is
   * indistinguishable from one that was parsed from binary.
   */
  _ensure_materialized(): void {
    if (this._tdsb == null || !this._tdsb.synthetic) return;

    const parent = this.parentProperty;
    if (parent != null) parent._ensure_materialized();

    // Flip synthetic flags on tdmn + group-owned chunks (not children).
    if (this._tdmn != null) this._tdmn.synthetic = false;
    pyAssert(this._tdgp != null);
    const tdgp = this._tdgp;
    tdgp.synthetic = false;
    this._tdsb.synthetic = false;
    if (this._name_utf8 != null) {
      this._name_utf8.synthetic = false;
      // Also unflag tdsn container if present
      for (const c of tdgp.chunks) {
        if (c.chunk_type === "tdsn") {
          c.synthetic = false;
          break;
        }
      }
    }
    // Also flip the group end marker.
    for (const c of tdgp.chunks) {
      if (c.chunk_type === "tdmn" && "value" in c && c.value === "ADBE Group End") {
        c.synthetic = false;
        break;
      }
    }

    this._reposition_canonically();
  }

  _chunk_body(): ListChunk | null {
    return this._tdgp;
  }

  _ensure_children_synthesized(): void {
    /** Run deferred child synthesis exactly once, on first access. */
    const aeMajor = this._deferred_ae_major;
    if (aeMajor == null) return;
    this._deferred_ae_major = null;
    this._run_deferred_synthesis(aeMajor);
  }

  _run_deferred_synthesis(aeMajor: number): void {
    /**
     * Perform full child synthesis for this group.
     *
     * Looks up child specs for the group's match name, reorders/fills
     * children, and defers synthesis on child groups recursively.
     */
    const specs = _GROUP_CHILD_SPECS.get(this.matchName) ?? null;
    if (specs != null) {
      _reorderAndFill(this, specs, this.propertyDepth + 1, {
        ae_major: aeMajor,
        value_overrides: this._synthesis_value_overrides(),
      });
    }

    if (this.matchName === "ADBE Layer Styles") {
      _deriveLayerStylesEnabled(this, aeMajor, { synthesize_subgroups: true });
    }

    for (const child of this._properties) {
      if (child instanceof PropertyGroup) {
        child._deferred_ae_major = aeMajor;
      } else if (child instanceof Property) {
        _applyBounds(child);
      }
    }
  }

  _synthesis_value_overrides(): Map<string, [number | number[], number | number[]]> | null {
    /**
     * Comp-dependent default values for synthesized children.
     *
     * Camera Zoom and Focus Distance default to AE's 50mm-lens zoom
     * (`comp width * pixel aspect / 0.72`), a value the static spec table
     * cannot express. Returns `null` for groups with no comp-dependent
     * defaults.
     */
    if (this.matchName !== "ADBE Camera Options Group") return null;
    let zoom: number;
    try {
      // `None._default_zoom` / a layer without it is an AttributeError in Python.
      const layer = this._containing_layer;
      zoom = getattr(layer, "_default_zoom").call(layer);
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
    this._ensure_children_synthesized();
    return this._properties;
  }

  [Symbol.iterator](): Iterator<Property | PropertyGroup> {
    /**
     * Return an iterator over the properties in this group.
     *
     * Iterates a snapshot so children can be removed while looping -
     * `PropertyBase.remove()` mutates `properties` in place, so the live
     * list would skip every other child (issue #230).
     */
    return [...this.properties][Symbol.iterator]();
  }

  get length(): number {
    /** Return the number of child properties in this group. */
    return this.properties.length;
  }

  *_leaf_properties(): Generator<Property> {
    /** Every leaf `Property` under this group, depth-first. */
    for (const child of this) {
      if (child instanceof PropertyGroup) {
        yield* child._leaf_properties();
      } else if (child instanceof Property) {
        yield child;
      }
    }
  }

  __getattr__(name: string): Property | PropertyGroup {
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

  __setattr__(name: string, value: unknown): void {
    // A name the class does not define would only become a Python
    // attribute: nothing reaches the file, and it would shadow the child
    // that attribute access resolves (`transform.position = [...]` leaves
    // Position untouched and makes `transform.position` the list). Layers
    // opt out (`Layer.__setattr__`) to keep their own public instance
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
  property(key: number | string): Property | PropertyGroup {
    /**
     * Look up a child property by index or name.
     *
     * This is the canonical access method; `__getattr__` (snake_case
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
    if (typeof key === "number" && Number.isInteger(key)) {
      return at(this.properties, key);
    }
    if (typeof key === "string") {
      const prop = this._child_or_null(key);
      if (prop === null) throw new KeyError(repr(key));
      return prop;
    }
    throw new TypeError_(`Property key must be int or str, not ${typeName(key)}`);
  }

  /** The child whose display name, match name or snake_case name is `name`, or `null`. */
  _child_or_null<K extends keyof MatchNameTypes>(name: K): MatchNameTypes[K] | null;
  _child_or_null(name: string): Property | PropertyGroup | null;
  _child_or_null(name: string): Property | PropertyGroup | null {
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

  removeAllKeys(): void {
    /**
     * Remove every keyframe from all properties in this group,
     * recursively.
     *
     * Calling this on a {@link Layer} clears the keyframes of every
     * property on the layer, including its marker keyframes. Each
     * animated property reverts to a static value; see
     * `Property.removeAllKeys`.
     */
    for (const child of this.properties) {
      child.removeAllKeys();
    }
  }

  canAddProperty(name: string): boolean {
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
    if (_canAddProperty(this.matchName, this.propertyType, name)) return true;
    return this._installed_effect_def(name) != null;
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
   * path). Pass `font_file` explicitly, or leave it `null` to locate
   * the installed font from the text document's font family.
   *
   * **Note:** This functionality was added in After Effects 26.0.
   *
   * @param axisTag - The 4-character tag identifying the variable font axis (e.g. `wght`, `wdth`,
   *   `slnt`, `ital`, `opsz`).
   * @param fontFile - Optional path to the variable font file. When `null`, the font is located in
   *   the OS font directories by the text document's font family.
   * @throws {@link ValueError} If this group is not a text animator Properties group, the font
   *   cannot be located or is not a variable font, `axis_tag` is not one of the font's axes, or all
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
      const text = this._containing_layer.text;
      if (text == null) throw new AttributeError("'NoneType' object has no attribute 'sourceText'");
      const textDoc = text.property("ADBE Text Document").value;
      const psName: string = pyOr(textDoc.font, "");
      const family = split(psName, "-", 1)[0];
      const resolved = family ? resolveFontExact(family) : null;
      if (resolved == null) {
        throw new ValueError(
          `Could not locate an installed font for family ${repr(family)}; pass font_file explicitly.`,
        );
      }
      fontFile = resolved[0].toString();
      fontNumber = resolved[1];
    }
    const axes = readDesignAxes(fontFile, fontNumber);
    const axis = axes.find((a) => a.tag === axisTag) ?? null;
    if (axis == null) {
      const available = axes.map((a) => a.tag).join(", ");
      throw new ValueError(`The font has no ${repr(axisTag)} axis (available: ${available}).`);
    }

    const slots = this.properties.filter(
      (p): p is Property => p instanceof Property && p._is_vf_axis,
    );
    for (const p of slots) {
      if (p.axisTag === axisTag) return p;
    }
    const slot = slots.find((p) => p.axisTag == null) ?? null;
    if (slot == null) throw new ValueError("All 8 variable-font axis slots are in use.");

    slot._ensure_materialized();
    const tagRaw = _vfTagFromStr(axisTag);
    const tdbs = slot._tdbs;
    tdb4ApplyVfAxisTemplate(slot._tdb4);
    pyAssert(slot._cdat != null);
    // AE writes [value, tag] plus eight zero-padding slots.
    slot._cdat.values = [axis.default_value, tagRaw, ...new Array(8).fill(0)];
    slot._value = null;
    // Axis bounds come from the font's range (single-component).
    for (const [attr, chunkType, bound] of [
      ["_tdum", "tdum", axis.min_value],
      ["_tduM", "tduM", axis.max_value],
    ] as const) {
      const existing = getattr(slot, attr);
      if (existing == null) {
        const created = new TdumChunk({ chunk_type: chunkType, values: [bound] });
        tdbs.chunks.push(created);
        slot[attr] = created;
      } else {
        existing.values = [bound];
      }
    }
    // AE stores the axis display name in a vfdn sibling after the tdbs.
    const vfdn = VfdnChunk.new_(`Font Axis ${axis.name}`);
    pyAssert(this._tdgp != null);
    const tdgp = this._tdgp;
    tdgp.chunks.splice(indexByIdentity(tdgp.chunks, tdbs) + 1, 0, vfdn);
    slot._vfdn = vfdn;
    slot._vf_tag_cache = tagRaw;
    return slot;
  }

  /**
   * Create and return a new property with the specified name,
   * and add it to this group.
   *
   * Indexed groups (and, as a named-group exception, the text
   * animator `Properties` pool) support adding properties; see
   * `can_add_property`. Accepted names cover every ExtendScript
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
      const installed = this._installed_effect_def(name);
      if (installed != null) return this._add_installed_effect(...installed);
      throw new ValueError(`Cannot add property '${name}' to group '${this.matchName}'`);
    }
    const [resolved, kind] = result;
    if (kind === AddableKind.MASK) return this._add_mask_atom();
    if (kind === AddableKind.EXPRESSION_CONTROL) return this._add_expression_control(resolved);
    if (kind === AddableKind.DROPDOWN) return this._add_dropdown_control();
    if (kind === AddableKind.SHAPE) return this._add_vector_element(resolved);
    if (kind === AddableKind.TEXT_SELECTOR) return this._add_text_selector(resolved);
    if (kind === AddableKind.TEXT_ANIMATOR) return this._add_text_animator();
    if (kind === AddableKind.ANIMATOR_PROPERTY) return this._add_animator_property(resolved);
    // Exhaustiveness guard: resolve_addable returns one of the seven
    // AddableKind members, each handled above. Reached only if a new
    // kind is added without a dispatch arm.
    throw new NotImplementedError(`no addProperty builder for '${resolved}'`);
  }

  _free_numbered_name(base: string, start: number): string {
    /**
     * `'{base} {n}'` with `n >= start`, skipping any number already
     * used by a sibling so a new instance never duplicates an existing
     * name. AE numbers same-type instances per container, but a count+1
     * scheme collides once an instance is removed or the existing names
     * are non-contiguous (e.g. `['Stroke 1', 'Stroke 3']`).
     */
    const existing = new Set(this.properties.map((p) => p.name));
    let n = start;
    while (existing.has(`${base} ${n}`)) n += 1;
    return `${base} ${n}`;
  }

  _effect_instance_name(display: string, sameType: number): string {
    /**
     * The tdsn name for a new effect instance: the first instance uses
     * the unnamed sentinel (so it shows the effect's own name); later ones
     * get a baked `"{display} N"`. `same_type` is the count of existing
     * instances (counted per match name, or per pseudo-effect namespace
     * for the Dropdown Control).
     */
    if (sameType === 0) return TDSN_SENTINEL;
    return this._free_numbered_name(display, sameType + 1);
  }

  _add_mask_atom(): MaskPropertyGroup {
    /** Add a new default mask atom to this Masks parade group. */
    this._ensure_materialized();
    // AE assigns a monotonic per-layer mask id (highest existing + 1),
    // not a positional count: len+1 collides after a mid-parade mask is
    // removed, or on a parsed layer whose mask ids are non-contiguous.
    const existing = this.properties.filter(
      (m): m is MaskPropertyGroup => m instanceof _maskPropertyGroup().MaskPropertyGroup,
    );
    const nextId = max(
      existing.map((m) => m._mkif.mask_id),
      null,
      0,
    ) + 1;
    // The name is numbered past the highest "Mask N" name, independently
    // of the id (AE 2026: beside "Mask 1" and a mask renamed "stored" the
    // new mask is id 3 "Mask 2"; beside "Mask 1" and "Mask 3", "Mask 4").
    const mask = _maskPropertyGroup().MaskPropertyGroup._new(this, this.propertyDepth + 1, {
      name: _nextMaskName(existing.map((m) => m.name)),
      mask_id: nextId,
    });
    this._properties.push(mask);
    return mask;
  }

  _add_expression_control(matchName: string): PropertyGroup {
    /** Add a fresh expression-control effect to this Effect Parade. */
    const skeleton = getitem(EXPRESSION_CONTROLS, matchName);
    this._ensure_materialized();
    const comp = this._containing_layer.containingComp;

    // AE names the first instance after the effect (unnamed tdsn
    // sentinel) and later instances "Name N" with a baked tdsn.
    const display: string = skeleton.name;
    const sameType = this.properties.filter((p) => p.matchName === matchName).length;
    const tdsnName = this._effect_instance_name(display, sameType);

    const [tdmn, sspc] = buildExpressionControl(
      matchName,
      display,
      bytes_.fromhex(skeleton.part),
      {
        tdsn_name: tdsnName,
        time_base: comp._cdta.internal_timebase,
        layer_id: this._containing_layer.id,
        layer_param_name: skeleton.layer_param,
      },
    );
    return this._attach_effect(tdmn, sspc, matchName);
  }

  _add_dropdown_control(): PropertyGroup {
    /**
     * Add a fresh Dropdown Menu Control to this Effect Parade.
     *
     * The Dropdown Menu Control is a pseudo-effect with a per-instance
     * generated match name, so AE's "Name N" numbering counts existing
     * dropdowns by the `Pseudo/` namespace rather than by match name.
     */
    this._ensure_materialized();
    const comp = this._containing_layer.containingComp;

    const display: string = DROPDOWN_CONTROL.name;
    const sameType = this.properties.filter((p) =>
      p.matchName.startsWith("Pseudo/@@"),
    ).length;
    const tdsnName = this._effect_instance_name(display, sameType);

    const [tdmn, sspc] = buildDropdownControl({
      tdsn_name: tdsnName,
      time_base: comp._cdta.internal_timebase,
      layer_id: this._containing_layer.id,
    });
    return this._attach_effect(tdmn, sspc, tdmn.value);
  }

  _installed_effect_def(name: string): [string, string, ListChunk] | null {
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
    if (this.matchName !== "ADBE Effect Parade") return null;
    const project = this._containing_layer.containingComp._project;
    const found = _effect().matchEffectDefinition(project._effect_definitions(), name);
    if (found != null) return found;
    return _bakedEffectDef(name);
  }

  _add_installed_effect(
    matchName: string,
    display: string,
    defSspc: ListChunk,
  ): PropertyGroup {
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
    this._ensure_materialized();
    const sspc = cloneChunkTree(defSspc);
    pyAssert(sspc instanceof ListChunk);
    rewriteOwnerTdpi(sspc, this._containing_layer.id);
    const comp = this._containing_layer.containingComp;
    rewriteTimeBase(sspc, comp._cdta.internal_timebase);

    // Name the instance: the first uses the unnamed tdsn sentinel
    // (so it shows the effect's fnam name); later ones get "Name N".
    const sameType = this.properties.filter((p) => p.matchName === matchName).length;
    const tdsnName = this._effect_instance_name(display, sameType);
    _setEffectInstanceName(sspc, tdsnName);

    const engv =
      matchName === "ADBE FreePin3"
        ? new Chunk({ chunk_type: "engv", data: _PUPPET_ENGINE_VERSION })
        : null;
    const effect = this._attach_effect(
      new TdmnChunk({ value: matchName }),
      sspc,
      matchName,
      engv,
    );
    _resetToDefaultValues(effect);
    return effect;
  }

  _attach_effect(
    tdmn: TdmnChunk,
    sspc: ListChunk,
    matchName: string,
    engv: Chunk | null = null,
  ): PropertyGroup {
    /**
     * Insert a built effect's chunks, parse, wire the model, append.
     *
     * `parse_effect` is the canonical chunks-\>model path for effects
     * (param-def merging, child synthesis); `duplicate()` uses it too.
     * `engv` is the engine-version atom AE stores between an effect's
     * `tdmn` and its `sspc` (Puppet only).
     */
    const layer = this._containing_layer;
    const comp = layer.containingComp;
    const parentTdgp = this._tdgp;
    pyAssert(parentTdgp != null);
    _insertBeforeGroupEnd(parentTdgp, tdmn);
    if (engv != null) _insertBeforeGroupEnd(parentTdgp, engv);
    _insertBeforeGroupEnd(parentTdgp, sspc);

    const effectParamDefs = comp._project._effect_param_defs;
    const effect = _effect().parseEffect(
      sspc,
      matchName,
      this.propertyDepth + 1,
      effectParamDefs,
      comp,
      tdmn,
      layer,
    );
    effect._parent_property = this;
    effect._deferred_ae_major = getAeVersionMajor(layer);
    this._properties.push(effect);
    return effect;
  }

  _attach_group(tdmn: TdmnChunk, tdgp: ListChunk, matchName: string): PropertyGroup {
    /**
     * Insert a built group's chunks, parse, wire the model, append.
     *
     * `parse_property_group` is the canonical chunks-\>model path for
     * added groups (mandatory subgroups, the Path element's om-s,
     * deferred child synthesis); the shape, selector and animator
     * builders share it, as `_attach_effect` does for effects.
     */
    const layer = this._containing_layer;
    const comp = layer.containingComp;
    const parentTdgp = this._tdgp;
    pyAssert(parentTdgp != null);
    _insertBeforeGroupEnd(parentTdgp, tdmn);
    _insertBeforeGroupEnd(parentTdgp, tdgp);

    const group = _property().parsePropertyGroup(
      tdgp,
      matchName,
      this.propertyDepth + 1,
      comp._project._effect_param_defs,
      comp,
      tdmn,
      layer,
    );
    group._parent_property = this;
    group._deferred_ae_major = getAeVersionMajor(layer);
    this._properties.push(group);
    return group;
  }

  _add_vector_element(matchName: string): PropertyGroup {
    /** Add a fresh shape element to this contents group. */
    this._ensure_materialized();
    const comp = this._containing_layer.containingComp;

    // AE bakes a per-container, per-type numbered name into the tdsn.
    const base = _VECTOR_CREATION_NAMES.get(matchName) || (MATCH_NAME_TO_AUTO_NAME.get(matchName) ?? matchName);
    const sameType = this.properties.filter((p) => p.matchName === matchName).length;
    const pathTimeBase =
      matchName === "ADBE Vector Shape - Group" ? comp._cdta.internal_timebase : null;
    const [tdmn, tdgp] = buildVectorElement(
      matchName,
      this._free_numbered_name(base, sameType + 1),
      {
        subgroups: _VECTOR_SUBGROUPS.get(matchName) ?? [],
        path_time_base: pathTimeBase,
      },
    );
    return this._attach_group(tdmn, tdgp, matchName);
  }

  _add_animator_property(matchName: string): Property | PropertyGroup {
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
    const prop = this.properties.find((p) => p.matchName === matchName) ?? null;
    // resolve_addable returns only pool match names, so the member exists.
    pyAssert(prop != null);
    prop._ensure_materialized();
    return prop;
  }

  _add_text_animator(): PropertyGroup {
    /**
     * Add a fresh animator to this Text Animators group.
     *
     * A new animator is a minimal `[Animator N, Properties (empty)]`
     * container; its (empty) Selectors group and the 103-property
     * Properties pool are synthesized on parse.
     */
    this._ensure_materialized();
    const sameType = this.properties.filter(
      (p) => p.matchName === "ADBE Text Animator",
    ).length;
    const [tdmn, tdgp] = buildTextAnimator(
      this._free_numbered_name("Animator", sameType + 1),
    );
    return this._attach_group(tdmn, tdgp, "ADBE Text Animator");
  }

  _add_text_selector(matchName: string): PropertyGroup {
    /**
     * Add a fresh selector to this text animator's Selectors group.
     *
     * Like shape elements, a selector is a minimal named group whose
     * value children are synthesized; the Range Selector additionally
     * carries an empty `ADBE Text Range Advanced` subgroup in binary.
     */
    this._ensure_materialized();
    const base = getitem(_TEXT_SELECTOR_NAMES, matchName);
    const sameType = this.properties.filter((p) => p.matchName === matchName).length;
    const [tdmn, tdgp] = buildTextSelector(
      matchName,
      this._free_numbered_name(base, sameType + 1),
      { has_advanced: matchName === "ADBE Text Selector" },
    );
    return this._attach_group(tdmn, tdgp, matchName);
  }
}

// `__getattr__` (child lookup by attribute name) and `__setattr__` without a proxy
// around each group. Exact here: `__setattr__` (this one and `Layer`'s) passes every
// existing attribute through and only refuses new public names.
pyClassHooks(PropertyGroup, { setattr_passes_private: true });

// Python `@requires_version(26)` on `add_variable_font_axis`: the
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
