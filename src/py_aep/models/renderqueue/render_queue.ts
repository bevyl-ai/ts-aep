import { ListChunk, Chunk } from "../../binary/chunk.ts";
import { LHD3_BLOCK_SINGLE, setLhd3Count, type LdatChunk, type Lhd3Chunk } from "../../binary/ldat_chunks.ts";
import { buildRqSettingsList } from "../../binary/mutations.ts";
import { RhedChunk } from "../../binary/project_chunks.ts";
import { ArsiChunk, RoutChunk } from "../../binary/render_chunks.ts";
import { TypeError_ } from "../../../pyrt/index.ts";
import type { Project } from "../project.ts";
import { CompItem } from "../items/composition.ts";
import { RenderQueueItem } from "./render_queue_item.ts";

/**
 * Clear the `synthetic` flag on a chunk and its container subtree.
 *
 * `parse_render_queue` leaves a synthesized render-queue scaffold (a missing
 * `LRdr`, settings `LIST:list`, or empty-queue `ldat`) marked `synthetic` so
 * `writeAep` skips it and an untouched queue-less file round-trips
 * byte-identically. The first `add()` calls this to materialize the whole
 * subtree so the populated queue is serialized. A no-op for a normal AE file
 * whose `LRdr` is already fully present and non-synthetic.
 */
export function _ensureMaterialized(chunk: Chunk): void {
  chunk.synthetic = false;
  if (chunk instanceof ListChunk) {
    for (const child of chunk.chunks) {
      _ensureMaterialized(child);
    }
  }
}

/**
 * The `RenderQueue` object represents the render automation process, the data
 * and functionality that is available through the Render Queue panel of a
 * particular After Effects project. Attributes provide access to items in
 * the render queue and their render status.
 *
 * ```ts
 * import { parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const render_queue = app.project.renderQueue;
 * for (const rq_item of render_queue) {
 *   // ...
 * }
 * ```
 *
 * @example
 * @see https://ae-scripting.docsforadobe.dev/renderqueue/renderqueue/
 */
export class RenderQueue {
  declare _lrdr: ListChunk;
  declare _rsLhd3: Lhd3Chunk;
  declare _rsLdat: LdatChunk;
  declare _rout: RoutChunk;
  declare _litm: ListChunk;
  declare _arsi: ArsiChunk;
  declare _items: RenderQueueItem[];
  declare _parent: Project;

  constructor(kw: {
    _lrdr: ListChunk;
    _rsLhd3: Lhd3Chunk;
    _rsLdat: LdatChunk;
    _rout: RoutChunk;
    _litm: ListChunk;
    _arsi: ArsiChunk;
    parent: Project;
    items: RenderQueueItem[];
  }) {
    const { _lrdr, _rsLhd3: _rs_lhd3, _rsLdat: _rs_ldat, _rout, _litm, _arsi, parent, items } = kw;
    this._lrdr = _lrdr;
    this._rsLhd3 = _rs_lhd3;
    this._rsLdat = _rs_ldat;
    this._rout = _rout;
    this._litm = _litm;
    this._arsi = _arsi;
    this._items = items;
    this._parent = parent;
  }

  /**
   * Build an empty render queue with its backing `LIST:LRdr` tree.
   *
   * Mirrors the empty-queue scaffold AE writes and `parse_render_queue`
   * synthetic ldat) + empty `LItm` + `LSIf[ARsi]`. The settings ldat is
   * synthetic so it is skipped by `write_aep()` until the first `add()`.
   *
   * @returns An iterator yielding `Rhed` + empty `Rout` + a settings `LIST:list` (lhd3 plus a
   */
  static _new(parent: Project): RenderQueue {
    const rhed = new RhedChunk({});
    const rout = new RoutChunk({});
    const [settings, rsLhd3, rsLdat] = buildRqSettingsList();
    const litm = new ListChunk({ listType: "LItm" });
    const arsi = new ArsiChunk({});
    const lrdr = new ListChunk({
      listType: "LRdr",
      chunks: [
        rhed,
        rout,
        settings,
        litm,
        new ListChunk({ listType: "LSIf", chunks: [arsi] }),
      ],
    });
    return new this({
      _lrdr: lrdr,
      _rsLhd3: rsLhd3,
      _rsLdat: rsLdat,
      _rout: rout,
      _litm: litm,
      _arsi: arsi,
      parent,
      items: [],
    });
  }

  /**
   * Iterate the queue's items.
   *
   * Iterates a snapshot, so removing items as they come up - the
   * obvious way to empty the queue - visits every one instead of
   * skipping every other item (issue #230).
   */
  [Symbol.iterator](): Iterator<RenderQueueItem> {
    return [...this.items][Symbol.iterator]();
  }

  /** A collection of all items in the render queue. Read-only. */
  get items(): RenderQueueItem[] {
    return this._items;
  }

  /** The {@link Project} containing this render queue. Read-only. */
  get parent(): Project {
    return this._parent;
  }

  /**
   * The number of items in the render queue. Read-only.
   *
   * **Note:** Equivalent to `len(render_queue.items)`
   */
  get numItems(): number {
    return this.items.length;
  }

  /**
   * Add a composition to the render queue.
   *
   * Creates a new {@link RenderQueueItem} with default render settings and
   * a single default output module.
   *
   * @param comp - The {@link CompItem} to render.
   * @returns The newly created {@link RenderQueueItem}.
   */
  add(comp: CompItem): RenderQueueItem {
    if (!(comp instanceof CompItem)) {
      throw new TypeError_("comp must be a CompItem");
    }

    // Create the new RQ item with all backing chunks
    const rqi = RenderQueueItem._new(comp, { parent: this });

    // Materialize any synthesized scaffold the parser left synthetic (an
    // empty-queue ldat, or - for a queue-less file - the whole LRdr tree),
    // so the populated queue is actually written. No-op for a normal file.
    _ensureMaterialized(this._lrdr);

    // Append render settings to LRdr's ldat and keep the lhd3 capacity
    // counters in sync with the new item count - AE keeps _count_b /
    // _counter_a / _counter_b equal to `count` for this list and rejects
    // the file ("Invalid read length") when they go stale.
    this._rsLdat.items.push(rqi._ldat);
    setLhd3Count(this._rsLhd3, this._rsLhd3.count + 1, LHD3_BLOCK_SINGLE);

    // Append Rout items (5 per RQ item) and update header
    for (const ri of rqi._routItems) {
      this._rout.items.push(ri);
    }
    this._rout.count = this._rout.items.length;

    // Insert OM metadata and OM container into LItm
    this._litm.chunks.push(rqi._listChunk);
    this._litm.chunks.push(rqi._lom);

    // AE flips two bytes in the LRdr "LSIf/ARsi" state chunk once the
    // render queue is non-empty; without this AE reports "missing data
    // in file" when opening the result. RenderQueueItem.remove clears the
    // non-empty flag again when the last item is removed.
    this._arsi.queueNonempty = 1;
    this._arsi.activeSlotState = 0x73;

    // Register in model list
    this._items.push(rqi);

    return rqi;
  }
}
