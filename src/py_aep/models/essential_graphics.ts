/**
 * Essential Graphics controller model for After Effects compositions.
 *
 * The Essential Graphics panel (EGP) allows properties to be exposed as
 * controllers in a Motion Graphics template (.mogrt). Each composition
 * can have an EGP definition stored in a `LIST:CIF3` chunk.
 */

import { INSPECT, describe } from "../../pyrt/index.ts";
import { descriptor } from "../../pyrt/index.ts";
import { ChunkField } from "./descriptors.ts";
import { validateName } from "./validators.ts";
import type { U4Chunk, Utf8Chunk } from "../binary/scalar_chunks.ts";

/** Whether `x` has a callable `[Symbol.iterator]`, the check spreading `x` makes. */
function _isIterable(x: unknown): x is Iterable<unknown> {
  return (
    (typeof x === "object" || typeof x === "function") &&
    x !== null &&
    Symbol.iterator in x &&
    typeof x[Symbol.iterator] === "function"
  );
}

/**
 * One node in a controller's source-property path, from root to leaf.
 *
 * `propIndex` is After Effects' raw 0-based position of the node within its
 * parent property group's full (AE-internal) child list, or `null` to match
 * by name (AE stores `0xFFFFFFFF` for by-name). It does NOT correspond to
 * py_aep's `property(n)`/`properties[n]` index - e.g. the Fill effect's
 * `ADBE Fill-0002` leaf has `prop_index=3` but is py_aep child position 1.
 * (Named `propIndex`, not `index`, to avoid shadowing `tuple.index`.)
 */
export class SourcePropertyRef {
  readonly matchName: string;
  readonly propIndex: number | null;

  constructor(matchName: string, propIndex: number | null) {
    this.matchName = matchName;
    this.propIndex = propIndex;
  }

  /** NamedTuple `_replace(**kw)`: a copy with the given fields changed. */
  _replace(kw: { matchName?: string; propIndex?: number | null } = {}): SourcePropertyRef {
    const f = { matchName: this.matchName, propIndex: this.propIndex, ...kw };
    return new SourcePropertyRef(f.matchName, f.propIndex);
  }

  /** NamedTuple equality: elementwise over the fields (also against a plain tuple). */
  equals(other: unknown): boolean {
    if (other == null || typeof other === "string" || !_isIterable(other)) return false;
    const o = [...other];
    return o.length === 2 && o[0] === this.matchName && o[1] === this.propIndex;
  }

  get length(): number {
    return 2;
  }

  *[Symbol.iterator]() {
    yield this.matchName;
    yield this.propIndex;
  }
}

/**
 * A single controller in the Essential Graphics panel.
 *
 * Each controller maps to a `LIST:CCtl` chunk inside `LIST:CIF3`.
 * The controller name is stored in a `LIST:CpS2` localized string
 * chunk and can be renamed via the `name` attribute.
 */
export class EssentialGraphicsController {
  /** The display name of the controller. Read / Write. */
  declare name: string;

  /**
   * The controller type ID. Read-only.
   *
   * Known values: 1=Checkbox, 2=Slider, 4=Color, 5=Point,
   * 6=Text, 8=Comment, 9=MultiDimensional, 10=Group, 13=Dropdown,
   * 14=Media Replacement.
   */
  declare controllerType: number;

  declare _nameUtf8: Utf8Chunk;
  declare _ctyp: U4Chunk;
  declare uuid: string;
  /**
   * The path (root to leaf) to the source-composition property this
   * controller exposes, as `SourcePropertyRef` nodes. Empty when the
   * path is not stored. Read-only.
   */
  declare sourcePropertyPath: SourcePropertyRef[];
  /**
   * The item id of the source composition that owns the controlled
   * property (the `CCId` chunk), or `null` when not stored. Read-only.
   */
  declare sourceCompId: number | null;
  /**
   * The `layerId` of the source layer that owns the controlled
   * property (the `CLId` chunk), or `null` when not stored. Read-only.
   */
  declare sourceLayerId: number | null;

  constructor(kw: {
    _nameUtf8: Utf8Chunk;
    _ctyp: U4Chunk;
    uuid: string;
    sourcePropertyPath: SourcePropertyRef[];
    sourceCompId?: number | null;
    sourceLayerId?: number | null;
  }) {
    const { _nameUtf8, _ctyp, uuid, sourcePropertyPath, sourceCompId = null, sourceLayerId = null } = kw;
    this._nameUtf8 = _nameUtf8;
    this._ctyp = _ctyp;
    this.uuid = uuid;
    /** The unique identifier for this controller. */
    this.sourcePropertyPath = sourcePropertyPath;
    /**
     * The path (root to leaf) to the source-composition property this
     * controller exposes, as `SourcePropertyRef` nodes. Empty when the
     * path is not stored. Read-only.
     */
    this.sourceCompId = sourceCompId;
    /**
     * The item id of the source composition that owns the controlled
     * property (the `CCId` chunk), or `null` when not stored. Read-only.
     */
    this.sourceLayerId = sourceLayerId;
    /**
     * The `layerId` of the source layer that owns the controlled
     * property (the `CLId` chunk), or `null` when not stored. Read-only.
     */
  }

  [INSPECT](): string {
    return describe("EssentialGraphicsController", { name: this.name, type: this.controllerType, uuid: this.uuid });
  }

  static {
    descriptor(this, "name", new ChunkField("_nameUtf8", "value", { validate: validateName }));
    descriptor(this, "controllerType", new ChunkField("_ctyp", "value", { readOnly: true }));
  }
}
