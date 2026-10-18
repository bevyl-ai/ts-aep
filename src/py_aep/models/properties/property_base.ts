import {
  AttributeError,
  ValueError,
  IndexError,
  descriptor,
  deferred,
  getattr,
  max,
  py_assert,
  py_eq,
  py_or,
  repr,
  split,
} from "../../../pyrt/index.ts";
import { PropertyType, PropertyValueType } from "../../enums/index.ts";
import { get_ae_version_major } from "../../ae_version.ts";
import { ListChunk, type Chunk } from "../../binary/chunk.ts";
import { clone_chunk_tree } from "../../binary/mutations.ts";
import { TDSN_SENTINEL, type TdmnChunk, type TdsbChunk } from "../../binary/property_chunks.ts";
import { find_by_type, index_by_identity } from "../../binary/utils.ts";
import { MATCH_NAME_TO_AUTO_NAME } from "../../data/match_names.ts";
import { ChunkField, type EffectParamDefs } from "../descriptors.ts";
import { validate_bool, validate_name } from "../validators.ts";
import type { Utf8Chunk } from "../../binary/scalar_chunks.ts";
import type { Layer } from "../layers/layer.ts";
import type { MaskPropertyGroup } from "./mask_property_group.ts";
import type { Property } from "./property.ts";
import type { PropertyGroup } from "./property_group.ts";

const _layer = deferred<typeof import("../layers/layer.ts")>("py_aep/models/layers/layer");
const _mask_property_group = deferred<typeof import("./mask_property_group.ts")>("py_aep/models/properties/mask_property_group");
const _property_group = deferred<typeof import("./property_group.ts")>("py_aep/models/properties/property_group");
const _property = deferred<typeof import("../../parsers/property.ts")>("py_aep/parsers/property");
const _property_value = deferred<typeof import("../../parsers/property_value.ts")>("py_aep/parsers/property_value");
const _effect = deferred<typeof import("../../parsers/effect.ts")>("py_aep/parsers/effect");

// NOTE(port): local twin of CPython `list.index` / `list.remove` (py_eq compare, ValueError "x is not in list"); no pyrt shim exists.
export function list_index<T>(xs: readonly T[], x: T): number {
  const i = xs.findIndex((y) => py_eq(y, x));
  if (i < 0) throw new ValueError(`${repr(x)} is not in list`);
  return i;
}

export function list_remove<T>(xs: T[], x: T): void {
  xs.splice(list_index(xs, x), 1);
}

// Match names of groups that support add/remove/move/duplicate on children
// (AE 2026 reports them INDEXED_GROUP, empty or not). "ADBE Vectors Group" is
// a nested shape group's own contents.
export const _INDEXED_GROUP_MATCH_NAMES: ReadonlySet<string> = new Set<string>([
  "ADBE Effect Parade",
  "ADBE Mask Parade",
  "ADBE Effect Mask Parade",
  "ADBE Text Animators",
  "ADBE Text Selectors",
  "ADBE Root Vectors Group",
  "ADBE Vectors Group",
  "ADBE MTrackers",
  "ADBE Layer Sets",
  "ADBE Paint Group",
  "ADBE Samurai Strokes Group",
]);

// Text animator + selectors expose an enable toggle (canSetEnabled).
export const _TEXT_ANIMATOR_TOGGLEABLE: ReadonlySet<string> = new Set<string>([
  "ADBE Text Animator",
  "ADBE Text Selector",
  "ADBE Text Wiggly Selector",
  "ADBE Text Expressible Selector",
]);

export function _validate_enabled(value: boolean, obj: PropertyBase): void {
  validate_bool(value);
  if (!obj.canSetEnabled) {
    throw new AttributeError("'enabled' is read-only when 'canSetEnabled' is False.");
  }
}

/**
 * Reassign positional `Mask {i}` fallback names after a mutation.
 *
 * The parser numbers mask atoms by position, so a reparse after
 * remove/move/duplicate would renumber them; keep the in-memory
 * fallbacks consistent. Explicit user names (stored in tdsn) take
 * precedence and are unaffected.
 */
export function _renumber_mask_auto_names(parent: PropertyGroup): void {
  let i = 1;
  for (const child of parent._properties) {
    if (child._is_mask) {
      child._auto_name = `Mask ${i}`;
      i += 1;
    }
  }
}

/**
 * Reset the layer's references to a mask being removed.
 *
 * A text Path or an effect's mask parameter (Fill \> Fill Mask) stores the
 * id of the mask it names (`Property._mask_index`). Removing that mask
 * resets it to none, left out of the file as an untouched parameter is
 * (AE 2026), so a later mask reusing the id is not picked up.
 */
export function _clear_mask_references(mask: MaskPropertyGroup): void {
  const mask_id = mask._mkif.mask_id;
  for (const prop of mask._containing_layer._leaf_properties()) {
    if (prop.propertyValueType !== PropertyValueType.MASK_INDEX) continue;
    const tdli = prop._tdli_chunk();
    if (tdli == null || tdli.value !== mask_id) continue;
    tdli.value = 0;
    if (!prop.expression) prop._revert_to_synthetic();
  }
}

/**
 * Give a duplicated mask a fresh per-layer id and matching name.
 *
 * AE assigns the copy the next free mask id (highest existing + 1) and
 * names it `'{base} {new_id}'`, where `base` is the source name with any
 * trailing number stripped (verified in AE 2026: `'Mask 1'` -\> id 2
 * `'Mask 2'`; `'Eyes'` -\> id 2 `'Eyes 2'`; with ids `[1, 3]`, `'Mask 1'`
 * -\> id 4 `'Mask 4'`). A plain clone keeps the source's id and name,
 * colliding with it.
 */
export function _assign_duplicate_mask_identity(
  source: PropertyBase,
  new_mask: MaskPropertyGroup,
  parent: PropertyGroup,
): void {
  const siblings = parent._properties
    .filter((m) => m._is_mask && m !== new_mask)
    .filter((m) => m instanceof _mask_property_group().MaskPropertyGroup);
  const new_id = max(siblings.map((m) => m._mkif.mask_id), null, 0) + 1;
  new_mask._mkif.mask_id = new_id;
  // Python `$` also matches before a trailing newline; the lookahead mirrors that.
  const base = source.name.replace(/ \p{Nd}+(?=\n?$)/u, "");
  new_mask.name = `${base} ${new_id}`;
}

/**
 * Abstract base class for both {@link Property} and {@link PropertyGroup}.
 *
 * Info:
 *     `PropertyBase` is the base class for both {@link Property} and
 *     {@link PropertyGroup}, so `PropertyBase` attributes and methods are available
 *     when working with properties and property groups.
 *
 * @see https://ae-scripting.docsforadobe.dev/property/propertybase/
 */
export class PropertyBase {
  /** Corresponds to the setting of the eyeball icon. Read / Write. */
  declare enabled: boolean;

  declare _tdsb: TdsbChunk | null;
  declare _name_utf8: Utf8Chunk | null;
  declare _match_name: string;
  declare _auto_name: string | null;
  declare _property_depth: number;
  declare _tdmn: TdmnChunk | null;
  declare _name: string | null;
  declare _elided: boolean;
  declare _is_effect: boolean;
  declare _is_mask: boolean;
  declare _parent_property: PropertyGroup | null;
  declare _property_type: PropertyType;

  constructor(kw: {
    _tdsb: TdsbChunk | null;
    _name_utf8?: Utf8Chunk | null;
    parent_property?: PropertyGroup | null;
    match_name: string;
    property_depth: number;
    auto_name?: string | null;
  }) {
    const {
      _tdsb,
      _name_utf8 = null,
      parent_property = null,
      match_name,
      property_depth,
      auto_name = null,
    } = kw;
    this._tdsb = _tdsb;
    this._name_utf8 = _name_utf8;
    this._match_name = match_name;
    this._auto_name = auto_name;
    this._property_depth = property_depth;
    this._tdmn = null;

    this._name = null;

    this._elided = false;
    this._is_effect = false;
    this._is_mask = false;
    this._parent_property = parent_property;
    this._property_type = PropertyType.NAMED_GROUP;
  }

  _ensure_materialized(): void {
    // No-op on `PropertyBase`. Overridden by `Property` and
    // `PropertyGroup` to flip synthetic flags on backing chunks on
    // first user write.
  }

  /**
   * The body chunk that follows this property's `tdmn` in the parent.
   *
   * `tdbs` for a {@link Property}, `tdgp` for a {@link PropertyGroup}.
   * Overridden by subclasses; `null` on the base.
   */
  _chunk_body(): Chunk | null {
    return null;
  }

  /** Whether this property's chunks are serialized (not synthetic). */
  _is_live(): boolean {
    return this._tdsb == null || !this._tdsb.synthetic;
  }

  /**
   * Move this property's `(tdmn, body)` chunks to canonical order.
   *
   * Synthesized properties are appended just before the group-end
   * marker at synthesis time, which does not match After Effects'
   * canonical property order. When such a property is materialized,
   * re-anchor its chunk pair right before the nearest following
   * already-serialized (non-synthetic) sibling, so the written order
   * is what AE expects. Synthetic siblings (skipped on write) are
   * ignored as anchors.
   *
   * Anchoring uses the sibling's `tdmn` (unique per property) rather
   * than its body chunk, because separation followers (e.g.
   * `ADBE Position_0` / `_1`) alias the same body chunk.
   *
   * All chunk lookups use object identity, not `==`: attrs gives
   * chunks structural equality, and an empty group body (e.g. a
   * text animator's Selectors vs Properties tdgp) is structurally
   * identical to a sibling's, so `.remove()`/`.index()` would act on
   * the wrong chunk.
   */
  _reposition_canonically(): void {
    const parent = this._parent_property;
    if (parent == null) return;
    const tdgp = getattr(parent, "_tdgp", null);
    const tdmn = this._tdmn;
    const body = this._chunk_body();
    if (tdgp == null || tdmn == null || body == null) return;
    const chunks = tdgp.chunks;
    if (!chunks.some((c) => c === tdmn) || !chunks.some((c) => c === body)) return;
    const siblings = parent._properties;
    const idx = siblings.findIndex((s: PropertyBase) => s === this);
    if (idx < 0) return;
    chunks.splice(0, chunks.length, ...chunks.filter((c) => c !== tdmn && c !== body));

    let pos: number | null = null;
    // Insert right before the nearest following live sibling's tdmn.
    for (const sib of siblings.slice(idx + 1)) {
      if (sib._is_live() && sib._tdmn != null) {
        const sib_pos = chunks.findIndex((c) => c === sib._tdmn);
        if (sib_pos >= 0) {
          pos = sib_pos;
          break;
        }
      }
    }
    if (pos == null) {
      // No live following sibling: insert before the group-end marker.
      pos = chunks.length;
      for (let i = chunks.length - 1; i >= 0; i--) {
        const c = chunks[i];
        if (c.chunk_type === "tdmn" && "value" in c && py_eq(c.value, "ADBE Group End")) {
          pos = i;
          break;
        }
      }
    }
    chunks.splice(pos, 0, tdmn);
    chunks.splice(pos + 1, 0, body);
  }

  /**
   * When `true`, the property is selected. Read / Write.
   *
   * **Note:** Property selection is stored in the `.aep` binary format but very complex.
   * Parsed projects report `false` for now.
   */
  get selected(): boolean {
    return false;
  }

  /**
   * A special name for the property used to build unique naming
   * paths. The match name is not displayed, but you can refer to it
   * in scripts. Every property has a unique match-name identifier.
   * Read-only.
   */
  get matchName(): string {
    return this._match_name;
  }

  /**
   * The number of levels of parent groups between this property
   * and the containing layer. The value is 0 for a layer.
   * Read-only.
   */
  get propertyDepth(): number {
    return this._property_depth;
  }

  /**
   * When `true`, the property is not shown in the UI. An elided
   * property is still present in the timeline but hidden from view.
   * Read-only.
   */
  get elided(): boolean {
    return this._elided;
  }

  /**
   * When `true`, this property is an effect {@link PropertyGroup}.
   * Read-only.
   */
  get isEffect(): boolean {
    return this._is_effect;
  }

  /**
   * When `true`, this property is a mask {@link PropertyGroup}.
   * Read-only.
   */
  get isMask(): boolean {
    return this._is_mask;
  }

  /**
   * The type of this property. One of `PropertyType.PROPERTY`,
   * `PropertyType.NAMED_GROUP`, or `PropertyType.INDEXED_GROUP`.
   * Read-only.
   */
  get propertyType(): PropertyType {
    return this._property_type;
  }

  /**
   * The parent {@link PropertyGroup} of this property, or `null` for
   * top-level layer property groups. Read-only.
   */
  get parentProperty(): PropertyGroup | null {
    return this._parent_property;
  }

  /** The automatic (display) name derived from `match_name`. */
  get autoName(): string {
    if (this._auto_name != null) return this._auto_name;
    return MATCH_NAME_TO_AUTO_NAME.get(this.matchName) ?? this.matchName;
  }

  /**
   * Display name of the property. Read / Write for a child of an
   * indexed group (a mask, effect, text animator or shape group);
   * read-only otherwise.
   *
   * @throws {@link ValueError} On write, if the parent is not an indexed group. After Effects
   *   refuses the same write ("Can not set name this property, because parent is not an
   *   INDEXED_GROUP").
   */
  get name(): string {
    if (this._name != null) return this._name;
    if (this._name_utf8 != null) {
      const text: string = split(this._name_utf8.value, "\0")[0];
      if (text && text !== TDSN_SENTINEL) return text;
    }
    return this.autoName;
  }

  set name(value: string) {
    validate_name(value);
    // A Layer is a PropertyBase but its name is a layer attribute, not a
    // property name - `Layer.name` extends this setter and is always
    // writable.
    const parent = this._parent_property;
    if (!("_ldta" in this) && (parent == null || parent.propertyType !== PropertyType.INDEXED_GROUP)) {
      // Materializing a synthetic property just to hold a name AE
      // would not accept writes a truncated LIST:tdbs (no cdat, no
      // tdum/tduM) for MARKER and NO_VALUE properties, which makes
      // AE reject the whole project as damaged.
      const where = parent == null ? "a root property" : repr(parent.matchName);
      throw new ValueError(
        `Cannot set the name of ${repr(this.matchName)}: its parent ` +
          `(${where}) is not an indexed group. Only masks, effects, ` +
          `text animators and shape groups can be renamed.`,
      );
    }

    this._ensure_materialized();
    this._name = value;
    py_assert(this._name_utf8 != null);
    this._name_utf8.value = value;
  }

  /** `true` if the name has been explicitly set by the user. Read-only. */
  get isNameSet(): boolean {
    if (this._name != null) return true;
    if (this._name_utf8 != null) {
      const text: string = split(this._name_utf8.value, "\0")[0];
      return !!text && text !== TDSN_SENTINEL;
    }
    return false;
  }

  /** Same as enabled. */
  get active(): boolean {
    return this.enabled;
  }

  /**
   * The 0-based position of this property within its parent group.
   *
   * Returns `null` for layers (property depth 0).
   *
   * **Warning:** Unlike ExtendScript (1-based), this uses Python's 0-based
   * convention so that `group.properties[prop.propertyIndex]`
   * works directly.
   * Read-only.
   */
  get propertyIndex(): number | null {
    const parent = this.parentProperty;
    if (this.propertyDepth === 0 || parent == null) return null;
    return list_index<PropertyBase>(parent.properties, this);
  }

  /**
   * `true` if the `enabled` attribute value can be set.
   *
   * This is `true` for all layers, effect property groups, shape
   * vector groups, text path options, and the Layer Styles group
   * and its individual styles. Read-only.
   */
  get canSetEnabled(): boolean {
    if (this.propertyDepth === 0) return true;
    if (this.isEffect) return true;
    const mn = this.matchName;
    if (mn === "ADBE Text Path Options") return true;
    // A text animator and each text selector can be toggled.
    if (_TEXT_ANIMATOR_TOGGLEABLE.has(mn)) return true;
    // The Layer Styles group and each individual style (match names
    // like "dropShadow/enabled") report canSetEnabled only when
    // applied to the layer. AE writes all ten styles as identical
    // empty groups, so the only "applied" signal is the enabled
    // flag: canSetEnabled tracks it exactly (group = any style
    // enabled). Blending Options ("ADBE Blend Options Group") is
    // excluded and always reports False.
    if (mn === "ADBE Layer Styles" || mn.endsWith("/enabled")) return this.enabled;
    if (
      mn.startsWith("ADBE Vector") &&
      ![
        "ADBE Vectors Group",
        "ADBE Vector Transform Group",
        "ADBE Vector Repeater Transform",
        "ADBE Vector Wiggler Transform",
        "ADBE Vector Materials Group",
      ].includes(mn)
    ) {
      return this.propertyType === PropertyType.NAMED_GROUP || this.propertyType === PropertyType.INDEXED_GROUP;
    }
    return false;
  }

  /**
   * Walk up the parent_property chain to find the containing layer.
   *
   * Returns the Layer object (detected by having `_ldta`), or raises
   * a ValueError if the property is not attached to a layer.
   */
  get _containing_layer(): Layer {
    let node: PropertyBase | null = this.parentProperty;
    while (node != null) {
      if ("_ldta" in node && node instanceof _layer().Layer) return node;
      node = node.parentProperty;
    }
    throw new ValueError("Property is not attached to a layer");
  }

  /** Check if this property is inside an effect PropertyGroup. */
  _is_in_effect(): boolean {
    let node: PropertyBase | null = this.parentProperty;
    while (node != null) {
      if (node.isEffect) return true;
      if ("_ldta" in node) break;
      node = node.parentProperty;
    }
    return false;
  }

  /**
   * `true` if this property has been changed since its creation.
   *
   * A property is considered modified if its value differs from the
   * default, if it has keyframes, or if an expression is enabled.
   * A property group is modified if any of its children are modified,
   * or if it is an indexed group with children (adding items to an
   * indexed group like Effects or Masks is itself a modification).
   */
  get isModified(): boolean {
    return false;
  }

  /**
   * Validate and return the parent group and its backing tdgp.
   *
   * Only children of indexed groups (effects, masks, shape contents,
   * text animators) can be removed/moved/duplicated.
   */
  _can_mutate(): [PropertyGroup, ListChunk] {
    const parent = this._parent_property;
    if (parent == null) throw new ValueError("Cannot mutate a root property");
    if (parent.propertyType !== PropertyType.INDEXED_GROUP) {
      throw new ValueError(`Cannot mutate property in non-indexed group '${parent.matchName}'`);
    }
    // Indexed groups always have a backing tdgp.
    return [parent, parent._tdgp as ListChunk];
  }

  /**
   * The LIST chunk in the parent's chunk list backing this property.
   *
   * For regular properties this is `_tdbs`, for regular groups `_tdgp`.
   * For effects (where the model's `_tdgp` is inside a wrapping
   * `LIST:sspc`), this returns the sspc chunk.
   */
  _backing_list_chunk(parent_tdgp: ListChunk): ListChunk {
    const chunk: ListChunk | null = py_or(getattr(this, "_tdbs", null), getattr(this, "_tdgp", null));
    py_assert(chunk != null);
    // Identity check - attrs __eq__ is structural, so .index() / `in`
    // would give false positives for chunks with identical fields.
    if (parent_tdgp.chunks.some((c) => c === chunk)) return chunk;

    // Effect case: _tdgp is inside a LIST:sspc wrapper
    for (const c of parent_tdgp.chunks) {
      if (c instanceof ListChunk && c.list_type === "sspc" && c.chunks.some((inner) => inner === chunk)) {
        return c;
      }
    }

    return chunk;
  }

  /**
   * Find the [start, end) index span of this property's chunks.
   *
   * Returns the index range covering the preceding `tdmn` chunk, any
   * auxiliary chunks between it and the backing LIST chunk (e.g.
   * `mkif` for masks), and the backing LIST chunk itself. The span
   * is suitable for slice deletion.
   */
  _find_chunk_span(parent_tdgp: ListChunk): [number, number] {
    const start = index_by_identity(parent_tdgp.chunks, this._tdmn);
    const backing = this._backing_list_chunk(parent_tdgp);
    const end = index_by_identity(parent_tdgp.chunks, backing);
    return [start, end + 1];
  }

  /**
   * Remove this property from its parent group.
   *
   * Only valid for children of indexed groups (effects, masks, shape
   * contents, text animators).
   *
   * @throws {@link ValueError} If this property is not in an indexed group.
   */
  remove(): void {
    const [parent, parent_tdgp] = this._can_mutate();
    if (this._is_mask && this instanceof _mask_property_group().MaskPropertyGroup) _clear_mask_references(this);
    const [start, end] = this._find_chunk_span(parent_tdgp);
    const removed = parent_tdgp.chunks.splice(start, end - start);
    _effect().rehome_effect_definitions(
      this._containing_layer.containingComp._project,
      removed
        .filter((chunk): chunk is ListChunk => chunk instanceof ListChunk && chunk.list_type === "sspc")
        .map((chunk): [string, ListChunk] => [this.matchName, chunk]),
    );
    list_remove<PropertyBase>(parent.properties, this);
    if (this._is_mask) _renumber_mask_auto_names(parent);
  }

  /**
   * Move this property to a new 0-based index within its parent group.
   *
   * Only valid for children of indexed groups.
   *
   * @param new_index - The target 0-based position.
   * @throws {@link ValueError} If this property is not in an indexed group.
   * @throws {@link IndexError} If `new_index` is out of range.
   */
  moveTo(new_index: number): void {
    const [parent, parent_tdgp] = this._can_mutate();

    const num_props = parent.properties.length;
    if (!(0 <= new_index && new_index < num_props)) {
      throw new IndexError(`Index ${new_index} out of range [0, ${num_props})`);
    }

    const current_index = list_index<PropertyBase>(parent.properties, this);
    const child = parent.properties[current_index];
    if (current_index === new_index) return;

    // Extract chunk span
    const [start, end] = this._find_chunk_span(parent_tdgp);
    const chunk_span = parent_tdgp.chunks.slice(start, end);
    parent_tdgp.chunks.splice(start, end - start);

    // Remove from model list
    list_remove(parent.properties, child);

    // Find chunk insertion point: before the target property's span
    if (new_index >= parent.properties.length) {
      parent_tdgp.chunks.push(...chunk_span);
      parent.properties.push(child);
    } else {
      const target = parent.properties[new_index];
      const [target_start] = target._find_chunk_span(parent_tdgp);
      for (const [i, c] of chunk_span.entries()) {
        parent_tdgp.chunks.splice(target_start + i, 0, c);
      }
      parent.properties.splice(new_index, 0, child);
    }
    if (this._is_mask) _renumber_mask_auto_names(parent);
  }

  /**
   * Duplicate this property within its parent group.
   *
   * The duplicate is inserted immediately after the original.
   * Only valid for children of indexed groups (see {@link PropertyType}).
   *
   * @returns The newly created {@link PropertyBase}.
   * @throws {@link ValueError} If this property is not in an indexed group.
   */
  duplicate(): PropertyBase {
    const [parent, parent_tdgp] = this._can_mutate();

    // Clone the full chunk span: tdmn, auxiliary chunks (e.g. mkif
    // for masks) and the backing LIST chunk.
    const [start, end] = this._find_chunk_span(parent_tdgp);
    const cloned = parent_tdgp.chunks.slice(start, end).map((c) => clone_chunk_tree(c));

    // Insert after original in parent's chunk list
    for (const [i, c] of cloned.entries()) {
      parent_tdgp.chunks.splice(end + i, 0, c);
    }

    // Re-parse the cloned chunks into a model
    const new_prop = this._parse_clone(cloned, parent);

    // Insert in model list after original
    const model_idx = list_index<PropertyBase>(parent.properties, this);
    parent.properties.splice(model_idx + 1, 0, new_prop);

    if (this._is_mask && new_prop instanceof _mask_property_group().MaskPropertyGroup) {
      _assign_duplicate_mask_identity(this, new_prop, parent);
      _renumber_mask_auto_names(parent);
    }
    return new_prop;
  }

  /**
   * Re-parse cloned chunks into a model instance.
   *
   * Uses the parser infrastructure to rebuild the correct model
   * hierarchy from cloned binary chunks.
   *
   * @param cloned - The cloned chunk span - the `tdmn` first, the backing LIST chunk last,
   *   auxiliary chunks (e.g. `mkif`) in between.
   * @param parent - The parent group of the clone.
   */
  _parse_clone(cloned: Chunk[], parent: PropertyGroup): Property | PropertyGroup {
    // Determine the composition context
    const layer = this._containing_layer;
    const comp = layer.containingComp;

    // Get effect param defs from the project
    let effect_param_defs: EffectParamDefs = new Map();
    const project = comp._project;
    if (project != null) {
      effect_param_defs = project._effect_param_defs;
    }

    const tdmn = cloned[0] as TdmnChunk;
    const list_chunk = cloned.at(-1) as ListChunk;
    let result: Property | PropertyGroup;
    if (this._is_mask) {
      const mkif = find_by_type(cloned, "mkif");
      result = _property()._parse_mask_atom(
        list_chunk,
        mkif,
        this._property_depth,
        effect_param_defs,
        comp,
        tdmn,
        layer,
      );
    } else if (list_chunk.list_type === "tdbs") {
      result = _property_value().parse_property(list_chunk, this._match_name, comp, this._property_depth, tdmn);
    } else if (list_chunk.list_type === "sspc") {
      result = _effect().parse_effect(
        list_chunk,
        this._match_name,
        this._property_depth,
        effect_param_defs,
        comp,
        tdmn,
        layer,
      );
    } else if (list_chunk.list_type === "tdgp") {
      result = _property().parse_property_group(
        list_chunk,
        this._match_name,
        this._property_depth,
        effect_param_defs,
        comp,
        tdmn,
        layer,
      );
    } else {
      throw new ValueError(`Unexpected backing chunk type '${list_chunk.list_type}'`);
    }
    // clone_chunk_tree strips synthetic chunks, so synthesized children
    // (e.g. Mask Feather/Opacity) are missing from the clone; re-arm
    // deferred synthesis to fill them on first access, like a fresh parse.
    if (result instanceof _property_group().PropertyGroup) {
      result._deferred_ae_major = get_ae_version_major(comp);
    }
    result._parent_property = parent;
    return result;
  }
}

// ---- Descriptor class attribute (installed after the class, as in Python) ----
descriptor(
  PropertyBase,
  "enabled",
  ChunkField.bool("_tdsb", "enabled", {
    default: true,
    validate: _validate_enabled,
  }),
);
