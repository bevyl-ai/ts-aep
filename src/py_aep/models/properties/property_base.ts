import {
  AttributeError,
  ValueError,
  IndexError,
  descriptor,
  assert,
  valueEquals,
  literal,
} from "../../../pyrt/index.ts";
import { PropertyType, PropertyValueType } from "../../enums/index.ts";
import { getAeVersionMajor } from "../../ae_version.ts";
import { ListChunk, type Chunk } from "../../binary/chunk.ts";
import { cloneChunkTree } from "../../binary/mutations.ts";
import { TDSN_SENTINEL, type TdmnChunk, type TdsbChunk } from "../../binary/property_chunks.ts";
import { findByType, indexByIdentity } from "../../binary/utils.ts";
import { MATCH_NAME_TO_AUTO_NAME } from "../../data/match_names.ts";
import { ChunkField, type EffectParamDefs } from "../descriptors.ts";
import { validateBool, validateName } from "../validators.ts";
import type { Utf8Chunk } from "../../binary/scalar_chunks.ts";
import type { Layer } from "../layers/layer.ts";
import type { MaskPropertyGroup } from "./mask_property_group.ts";
import type { Property } from "./property.ts";
import type { PropertyGroup } from "./property_group.ts";
import * as _propertyGroup from "./property_group.ts";
import * as _propertyValue from "../../parsers/property_value.ts";
import { late } from "../late.ts";

// Local twin of CPython `list.index` / `list.remove` (py_eq compare, ValueError "x is not in list"); no pyrt shim exists.
function listIndex<T>(xs: readonly T[], x: T): number {
  const i = xs.findIndex((y) => valueEquals(y, x));
  if (i < 0) throw new ValueError(`${literal(x)} is not in list`);
  return i;
}

function listRemove<T>(xs: T[], x: T): void {
  xs.splice(listIndex(xs, x), 1);
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
const _TEXT_ANIMATOR_TOGGLEABLE: ReadonlySet<string> = new Set<string>([
  "ADBE Text Animator",
  "ADBE Text Selector",
  "ADBE Text Wiggly Selector",
  "ADBE Text Expressible Selector",
]);

function _validateEnabled(value: boolean, obj: PropertyBase): void {
  validateBool(value);
  if (!obj.canSetEnabled) {
    throw new AttributeError("'enabled' is read-only when 'canSetEnabled' is false.");
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
function _renumberMaskAutoNames(parent: PropertyGroup): void {
  let i = 1;
  for (const child of parent._properties) {
    if (child._isMask) {
      child._autoName = `Mask ${i}`;
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
function _clearMaskReferences(mask: MaskPropertyGroup): void {
  const maskId = mask._mkif.maskId;
  for (const prop of mask._containingLayer._leafProperties()) {
    if (prop.propertyValueType !== PropertyValueType.MASK_INDEX) continue;
    const tdli = prop._tdliChunk();
    if (tdli == null || tdli.value !== maskId) continue;
    tdli.value = 0;
    if (!prop.expression) prop._revertToSynthetic();
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
function _assignDuplicateMaskIdentity(source: PropertyBase, newMask: MaskPropertyGroup, parent: PropertyGroup): void {
  const siblings = parent._properties.filter((m) => m._isMask && m !== newMask).filter((m) => m._isMaskGroup());
  const newId = Math.max(0, ...siblings.map((m) => m._mkif.maskId)) + 1;
  newMask._mkif.maskId = newId;
  // Python `$` also matches before a trailing newline; the lookahead mirrors that.
  const base = source.name.replace(/ \p{Nd}+(?=\n?$)/u, "");
  newMask.name = `${base} ${newId}`;
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
  declare _nameUtf8: Utf8Chunk | null;
  declare _matchName: string;
  declare _autoName: string | null;
  declare _propertyDepth: number;
  declare _tdmn: TdmnChunk | null;
  declare _name: string | null;
  declare _elided: boolean;
  declare _isEffect: boolean;
  declare _isMask: boolean;
  declare _parentProperty: PropertyGroup | null;
  declare _propertyType: PropertyType;

  constructor(kw: {
    _tdsb: TdsbChunk | null;
    _nameUtf8?: Utf8Chunk | null;
    parentProperty?: PropertyGroup | null;
    matchName: string;
    propertyDepth: number;
    autoName?: string | null;
  }) {
    const { _tdsb, _nameUtf8 = null, parentProperty = null, matchName, propertyDepth, autoName = null } = kw;
    this._tdsb = _tdsb;
    this._nameUtf8 = _nameUtf8;
    this._matchName = matchName;
    this._autoName = autoName;
    this._propertyDepth = propertyDepth;
    this._tdmn = null;

    this._name = null;

    this._elided = false;
    this._isEffect = false;
    this._isMask = false;
    this._parentProperty = parentProperty;
    this._propertyType = PropertyType.NAMED_GROUP;
  }

  _ensureMaterialized(): void {
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
  _chunkBody(): Chunk | null {
    return null;
  }

  /** Whether this property's chunks are serialized (not synthetic). */
  _isLive(): boolean {
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
  _repositionCanonically(): void {
    const parent = this._parentProperty;
    if (parent == null) return;
    const tdgp = "_tdgp" in parent ? parent._tdgp : null;
    const tdmn = this._tdmn;
    const body = this._chunkBody();
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
      if (sib._isLive() && sib._tdmn != null) {
        const sibPos = chunks.findIndex((c) => c === sib._tdmn);
        if (sibPos >= 0) {
          pos = sibPos;
          break;
        }
      }
    }
    if (pos == null) {
      // No live following sibling: insert before the group-end marker.
      pos = chunks.length;
      for (let i = chunks.length - 1; i >= 0; i--) {
        const c = chunks[i];
        if (c.chunkType === "tdmn" && "value" in c && valueEquals(c.value, "ADBE Group End")) {
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
    return this._matchName;
  }

  /**
   * The number of levels of parent groups between this property
   * and the containing layer. The value is 0 for a layer.
   * Read-only.
   */
  get propertyDepth(): number {
    return this._propertyDepth;
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
    return this._isEffect;
  }

  /**
   * When `true`, this property is a mask {@link PropertyGroup}.
   * Read-only.
   */
  get isMask(): boolean {
    return this._isMask;
  }

  /**
   * The type of this property. One of `PropertyType.PROPERTY`,
   * `PropertyType.NAMED_GROUP`, or `PropertyType.INDEXED_GROUP`.
   * Read-only.
   */
  get propertyType(): PropertyType {
    return this._propertyType;
  }

  /**
   * The parent {@link PropertyGroup} of this property, or `null` for
   * top-level layer property groups. Read-only.
   */
  get parentProperty(): PropertyGroup | null {
    return this._parentProperty;
  }

  /** The automatic (display) name derived from `matchName`. */
  get autoName(): string {
    if (this._autoName != null) return this._autoName;
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
    if (this._nameUtf8 != null) {
      const text: string = this._nameUtf8.value.split("\0")[0];
      if (text && text !== TDSN_SENTINEL) return text;
    }
    return this.autoName;
  }

  set name(value: string) {
    validateName(value);
    // A Layer is a PropertyBase but its name is a layer attribute, not a
    // property name - `Layer.name` extends this setter and is always
    // writable.
    const parent = this._parentProperty;
    if (!("_ldta" in this) && (parent == null || parent.propertyType !== PropertyType.INDEXED_GROUP)) {
      // Materializing a synthetic property just to hold a name AE
      // would not accept writes a truncated LIST:tdbs (no cdat, no
      // tdum/tduM) for MARKER and NO_VALUE properties, which makes
      // AE reject the whole project as damaged.
      const where = parent == null ? "a root property" : literal(parent.matchName);
      throw new ValueError(
        `Cannot set the name of ${literal(this.matchName)}: its parent ` +
          `(${where}) is not an indexed group. Only masks, effects, ` +
          `text animators and shape groups can be renamed.`,
      );
    }

    this._ensureMaterialized();
    this._name = value;
    assert(this._nameUtf8 != null);
    this._nameUtf8.value = value;
  }

  /** `true` if the name has been explicitly set by the user. Read-only. */
  get isNameSet(): boolean {
    if (this._name != null) return true;
    if (this._nameUtf8 != null) {
      const text: string = this._nameUtf8.value.split("\0")[0];
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
    return listIndex<PropertyBase>(parent.properties, this);
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
    // excluded and always reports false.
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

  /** Whether this is a group (`PropertyGroup` answers true). */
  _isGroup(): this is PropertyGroup {
    return false;
  }

  /** Whether this is a layer (`Layer` answers true). */
  _isLayer(): this is Layer {
    return false;
  }

  /** Whether this is a mask (`MaskPropertyGroup` answers true). */
  _isMaskGroup(): this is MaskPropertyGroup {
    return false;
  }

  /**
   * Walk up the parent_property chain to find the containing layer.
   *
   * Returns the Layer object (detected by having `_ldta`), or raises
   * a ValueError if the property is not attached to a layer.
   */
  get _containingLayer(): Layer {
    let node: PropertyBase | null = this.parentProperty;
    while (node != null) {
      if ("_ldta" in node && node._isLayer()) return node;
      node = node.parentProperty;
    }
    throw new ValueError("Property is not attached to a layer");
  }

  /** Check if this property is inside an effect PropertyGroup. */
  _isInEffect(): boolean {
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
  private _canMutate(): [PropertyGroup, ListChunk] {
    const parent = this._parentProperty;
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
  _backingListChunk(parentTdgp: ListChunk): ListChunk {
    const chunk: ListChunk | null =
      "_tdbs" in this ? (this._tdbs as ListChunk) : "_tdgp" in this ? (this._tdgp as ListChunk | null) : null;
    assert(chunk != null);
    // Identity check - attrs __eq__ is structural, so .index() / `in`
    // would give false positives for chunks with identical fields.
    if (parentTdgp.chunks.some((c) => c === chunk)) return chunk;

    // Effect case: _tdgp is inside a LIST:sspc wrapper
    for (const c of parentTdgp.chunks) {
      if (c instanceof ListChunk && c.listType === "sspc" && c.chunks.some((inner) => inner === chunk)) {
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
  private _findChunkSpan(parentTdgp: ListChunk): [number, number] {
    const start = indexByIdentity(parentTdgp.chunks, this._tdmn);
    const backing = this._backingListChunk(parentTdgp);
    const end = indexByIdentity(parentTdgp.chunks, backing);
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
    const [parent, parentTdgp] = this._canMutate();
    if (this._isMask && this._isMaskGroup()) _clearMaskReferences(this);
    const [start, end] = this._findChunkSpan(parentTdgp);
    const removed = parentTdgp.chunks.splice(start, end - start);
    late.rehomeEffectDefinitions(
      this._containingLayer.containingComp._project,
      removed
        .filter((chunk): chunk is ListChunk => chunk instanceof ListChunk && chunk.listType === "sspc")
        .map((chunk): [string, ListChunk] => [this.matchName, chunk]),
    );
    listRemove<PropertyBase>(parent.properties, this);
    if (this._isMask) _renumberMaskAutoNames(parent);
  }

  /**
   * Move this property to a new 0-based index within its parent group.
   *
   * Only valid for children of indexed groups.
   *
   * @param newIndex - The target 0-based position.
   * @throws {@link ValueError} If this property is not in an indexed group.
   * @throws {@link IndexError} If `newIndex` is out of range.
   */
  moveTo(newIndex: number): void {
    const [parent, parentTdgp] = this._canMutate();

    const numProps = parent.properties.length;
    if (!(0 <= newIndex && newIndex < numProps)) {
      throw new IndexError(`Index ${newIndex} out of range [0, ${numProps})`);
    }

    const currentIndex = listIndex<PropertyBase>(parent.properties, this);
    const child = parent.properties[currentIndex];
    if (currentIndex === newIndex) return;

    // Extract chunk span
    const [start, end] = this._findChunkSpan(parentTdgp);
    const chunkSpan = parentTdgp.chunks.slice(start, end);
    parentTdgp.chunks.splice(start, end - start);

    // Remove from model list
    listRemove(parent.properties, child);

    // Find chunk insertion point: before the target property's span
    if (newIndex >= parent.properties.length) {
      parentTdgp.chunks.push(...chunkSpan);
      parent.properties.push(child);
    } else {
      const target = parent.properties[newIndex];
      const [targetStart] = target._findChunkSpan(parentTdgp);
      for (const [i, c] of chunkSpan.entries()) {
        parentTdgp.chunks.splice(targetStart + i, 0, c);
      }
      parent.properties.splice(newIndex, 0, child);
    }
    if (this._isMask) _renumberMaskAutoNames(parent);
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
    const [parent, parentTdgp] = this._canMutate();

    // Clone the full chunk span: tdmn, auxiliary chunks (e.g. mkif
    // for masks) and the backing LIST chunk.
    const [start, end] = this._findChunkSpan(parentTdgp);
    const cloned = parentTdgp.chunks.slice(start, end).map((c) => cloneChunkTree(c));

    // Insert after original in parent's chunk list
    for (const [i, c] of cloned.entries()) {
      parentTdgp.chunks.splice(end + i, 0, c);
    }

    // Re-parse the cloned chunks into a model
    const newProp = this._parseClone(cloned, parent);

    // Insert in model list after original
    const modelIdx = listIndex<PropertyBase>(parent.properties, this);
    parent.properties.splice(modelIdx + 1, 0, newProp);

    if (this._isMask && newProp._isMaskGroup()) {
      _assignDuplicateMaskIdentity(this, newProp, parent);
      _renumberMaskAutoNames(parent);
    }
    return newProp;
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
  private _parseClone(cloned: Chunk[], parent: PropertyGroup): Property | PropertyGroup {
    // Determine the composition context
    const layer = this._containingLayer;
    const comp = layer.containingComp;

    // Get effect param defs from the project
    let effectParamDefs: EffectParamDefs = new Map();
    const project = comp._project;
    if (project != null) {
      effectParamDefs = project._effectParamDefs;
    }

    const tdmn = cloned[0] as TdmnChunk;
    const listChunk = cloned.at(-1) as ListChunk;
    let result: Property | PropertyGroup;
    if (this._isMask) {
      const mkif = findByType(cloned, "mkif");
      result = late._parseMaskAtom(listChunk, mkif, this._propertyDepth, effectParamDefs, comp, tdmn, layer);
    } else if (listChunk.listType === "tdbs") {
      result = _propertyValue.parseProperty(listChunk, this._matchName, comp, this._propertyDepth, tdmn);
    } else if (listChunk.listType === "sspc") {
      result = late.parseEffect(listChunk, this._matchName, this._propertyDepth, effectParamDefs, comp, tdmn, layer);
    } else if (listChunk.listType === "tdgp") {
      result = late.parsePropertyGroup(
        listChunk,
        this._matchName,
        this._propertyDepth,
        effectParamDefs,
        comp,
        tdmn,
        layer,
      );
    } else {
      throw new ValueError(`Unexpected backing chunk type '${listChunk.listType}'`);
    }
    // clone_chunk_tree strips synthetic chunks, so synthesized children
    // (e.g. Mask Feather/Opacity) are missing from the clone; re-arm
    // deferred synthesis to fill them on first access, like a fresh parse.
    if (result instanceof _propertyGroup.PropertyGroup) {
      result._deferredAeMajor = getAeVersionMajor(comp);
    }
    result._parentProperty = parent;
    return result;
  }

  static {
    // Descriptors for the `declare`d fields above.
    descriptor(
      this,
      "enabled",
      ChunkField.bool("_tdsb", "enabled", {
        default: true,
        validate: _validateEnabled,
      }),
    );
  }
}
