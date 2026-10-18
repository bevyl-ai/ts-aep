import { getOrThrow } from "../../pyrt/index.ts";
import { ContainerChunk, ListChunk } from "../binary/chunk.ts";
import type { Chunk } from "../binary/chunk.ts";
import { LdatChunk } from "../binary/ldat_chunks.ts";
import { LRDR_CHILD_ORDER, buildRqSettingsList } from "../binary/mutations.ts";
import { ROUT_ITEMS_PER_RQ_ITEM, ArsiChunk, RoutChunk } from "../binary/render_chunks.ts";
import type { RenderSettingsItem, RoutItem } from "../binary/render_chunks.ts";
import type { Utf8Chunk } from "../binary/scalar_chunks.ts";
import { findByListTypeOrNull, findByType, findByTypeOrNull, splitOnType } from "../binary/utils.ts";
import type { CompItem } from "../models/items/composition.ts";
import { RenderQueue } from "../models/renderqueue/render_queue.ts";
import { RenderQueueItem } from "../models/renderqueue/render_queue_item.ts";
import type { Project } from "../models/project.ts";
import type { OutputModule } from "../models/renderqueue/output_module.ts";
import { parseOutputModule } from "./output_module.ts";

/**
 * Parse the render queue from the top-level chunks.
 *
 * @param rootChunks - The top-level chunks from the AEP file.
 * @param project - The Project object being constructed, used to link comp references in render
 *   queue items.
 */
export function parseRenderQueue(rootChunks: Chunk[], project: Project): RenderQueue {
  const lrdrChunk = findByListTypeOrNull(rootChunks, "LRdr");
  if (lrdrChunk === null) {
    // Legacy/hand-built files may omit the render-queue scaffold entirely
    // (AE always writes an LRdr, but a minimal file need not). Synthesize an
    // empty queue and attach its LRdr to the root, marked synthetic so
    // write_aep skips it - an untouched queue-less file still round-trips
    // byte-identically. The first add() materializes the tree.
    const renderQueue = RenderQueue._new(project);
    renderQueue._lrdr.synthetic = true;
    // AE writes LRdr immediately before LIST:PTRE (the workspace blob), so
    // insert at that canonical root position rather than appending past it.
    const ptreFound = rootChunks.findIndex((c) => c instanceof ListChunk && c.listType === "PTRE");
    const ptreIdx = ptreFound === -1 ? rootChunks.length : ptreFound;
    rootChunks.splice(ptreIdx, 0, renderQueue._lrdr);
    return renderQueue;
  }
  const lrdrChildChunks = lrdrChunk.chunks;
  let synthesized = false;

  let listSettingsChunk = findByListTypeOrNull(lrdrChildChunks, "list");
  if (listSettingsChunk === null) {
    synthesized = true;
    // An LRdr present but lacking its settings 'list' is degenerate;
    // rebuild it so the parse still yields an empty queue instead of
    // raising.
    [listSettingsChunk] = buildRqSettingsList({ synthetic: true });
    lrdrChildChunks.push(listSettingsChunk);
  }
  const settingsLhd3 = findByType(listSettingsChunk.chunks, "lhd3");

  // Legacy/minimal files may omit the queue scaffolding (Rout, LItm,
  // LSIf/ARsi). Substitute synthetic placeholders attached to the tree so
  // the parse still yields an (empty) render queue; write_aep() skips
  // synthetic chunks, so untouched files round-trip byte-identically.
  let routChunk = findByTypeOrNull(lrdrChildChunks, "Rout");
  if (routChunk === null) {
    synthesized = true;
    routChunk = new RoutChunk({ synthetic: true });
    lrdrChildChunks.push(routChunk);
  }

  let litmChunk = findByListTypeOrNull(lrdrChildChunks, "LItm");
  if (litmChunk === null) {
    synthesized = true;
    litmChunk = new ListChunk({ listType: "LItm", synthetic: true });
    lrdrChildChunks.push(litmChunk);
  }

  let lsifChunk = findByListTypeOrNull(lrdrChildChunks, "LSIf");
  if (lsifChunk === null) {
    synthesized = true;
    lsifChunk = new ListChunk({ listType: "LSIf", synthetic: true });
    lrdrChildChunks.push(lsifChunk);
  }
  let arsiChunk = findByTypeOrNull(lsifChunk.chunks, "ARsi");
  if (arsiChunk === null) {
    arsiChunk = new ArsiChunk({ synthetic: true });
    lsifChunk.chunks.push(arsiChunk);
  }

  if (synthesized) {
    // The synthesized placeholders were appended out of AE's canonical LRdr
    // child order; reorder so a populated queue (after add() materializes
    // them) is written canonically. Only when we synthesized something, so
    // an untouched real file's order - hence its round-trip - is untouched.
    const _canon = new Map<string, number>(LRDR_CHILD_ORDER.map((t, i): [string, number] => [t, i]));
    const rank = (c: Chunk): number => _canon.get((c instanceof ListChunk && c.listType) || c.chunkType) ?? _canon.size;
    lrdrChildChunks.sort((a, b) => rank(a) - rank(b));
  }

  let settingsLdat: LdatChunk;
  if (settingsLhd3.count === 0) {
    // Empty render queue: AE writes the settings 'list' with only an lhd3
    // (no ldat). Create a synthetic ldat and attach it to the tree so the
    // model and tree agree. write_aep() skips synthetic chunks, so an
    // untouched empty queue still round-trips byte-identically; the first
    // add() flips it to non-synthetic. (AE may instead write an empty ldat
    // with count==0; reuse it when present.)
    const existing = findByTypeOrNull(listSettingsChunk.chunks, "ldat");
    if (existing === null) {
      settingsLdat = new LdatChunk({ chunkType: "ldat", synthetic: true });
      listSettingsChunk.chunks.push(settingsLdat);
    } else {
      settingsLdat = existing;
    }
  } else {
    settingsLdat = findByType(listSettingsChunk.chunks, "ldat");
  }

  const renderQueue = new RenderQueue({
    _lrdr: lrdrChunk,
    _rsLhd3: settingsLhd3,
    _rsLdat: settingsLdat,
    _rout: routChunk,
    _litm: litmChunk,
    _arsi: arsiChunk,
    parent: project,
    items: [],
  });

  if (settingsLhd3.count > 0) {
    renderQueue._items = parseRenderQueueItems(litmChunk, settingsLdat.items, routChunk.items, project, renderQueue);
  }
  return renderQueue;
}

/**
 * Parse render queue items from the child chunks of LItm.
 *
 * Each item consists of:
 * - An optional RCom chunk with the item comment
 * - A LIST 'list' chunk with OM metadata (lhd3 + ldat)
 * - A LIST 'LOm ' chunk with output module chunks
 *
 * @param litmChunk - The LIST 'LItm' chunk containing per-item groups.
 * @param renderSettings - The parsed RenderSettingsItem list from LRdr's ldat.
 * @param routItems - The parsed RoutItem list from the Rout chunk.
 * @param project - The Project object, used to resolve comp references.
 * @param renderQueue - The parent RenderQueue being constructed.
 */
export function parseRenderQueueItems(
  litmChunk: ListChunk,
  renderSettings: RenderSettingsItem[],
  routItems: RoutItem[],
  project: Project,
  renderQueue: RenderQueue,
): RenderQueueItem[] {
  const items: RenderQueueItem[] = [];
  let itemIndex = 0;
  let rcomContainer: ContainerChunk | null = null;
  let rcomUtf8: Utf8Chunk | null = null;
  let listChunk: ListChunk | null = null;

  for (const chunk of litmChunk.chunks) {
    if (chunk instanceof ContainerChunk && chunk.chunkType === "RCom") {
      rcomContainer = chunk;
      rcomUtf8 = findByType(chunk.chunks, "Utf8");
    } else if (chunk instanceof ListChunk) {
      if (chunk.listType === "list") {
        listChunk = chunk;
      } else if (chunk.listType === "LOm " && listChunk != null) {
        const routStart = itemIndex * ROUT_ITEMS_PER_RQ_ITEM;
        const item = parseRenderQueueItem(
          listChunk,
          chunk,
          renderSettings.at(itemIndex)!,
          rcomContainer,
          rcomUtf8,
          routItems.slice(routStart, routStart + ROUT_ITEMS_PER_RQ_ITEM),
          litmChunk,
          project,
          renderQueue,
        );
        items.push(item);
        itemIndex += 1;
        rcomContainer = null;
        rcomUtf8 = null;
        listChunk = null;
      }
    }
  }

  return items;
}

/**
 * Parse a single render queue item from its component chunks.
 *
 * @param listChunk - The LIST 'list' chunk containing OM metadata.
 * @param lomChunk - The LIST 'LOm ' chunk containing output modules.
 * @param ldatBody - The RenderSettingsItem for this item.
 * @param rcomContainer - The RCom ContainerChunk, or None if absent.
 * @param rcomUtf8 - The Utf8 chunk inside RCom, or None if absent.
 * @param routItems - This item's block of RoutItems (AE writes 5 per item).
 * @param litmChunk - The LIST 'LItm' chunk.
 * @param project - The Project object, used to resolve comp references.
 * @param renderQueue - The parent RenderQueue being constructed.
 */
export function parseRenderQueueItem(
  listChunk: ListChunk,
  lomChunk: ListChunk,
  ldatBody: RenderSettingsItem,
  rcomContainer: ContainerChunk | null,
  rcomUtf8: Utf8Chunk | null,
  routItems: RoutItem[],
  litmChunk: ListChunk,
  project: Project,
  renderQueue: RenderQueue,
): RenderQueueItem {
  const omLdat = findByType(listChunk.chunks, "ldat");
  const omLdatItems = omLdat.items;

  const compId = ldatBody.compId;
  const comp = getOrThrow(project.items, compId) as CompItem;

  // Group chunks by Roou - each Roou starts a new output module
  const omGroups = splitOnType(lomChunk.chunks, "Roou");

  const renderQueueItem = new RenderQueueItem({
    _ldat: ldatBody,
    _litm: litmChunk,
    _listChunk: listChunk,
    _lom: lomChunk,
    _rcom: rcomContainer,
    _rcomUtf8: rcomUtf8,
    _routItems: routItems,
    parent: renderQueue,
    comp,
    outputModules: [],
  });

  const outputModules: OutputModule[] = [];
  for (const [omIndex, group] of omGroups.entries()) {
    const outputModule = parseOutputModule(group, omLdatItems.at(omIndex)!, renderQueueItem);
    outputModules.push(outputModule);
  }

  renderQueueItem._outputModules = outputModules;

  return renderQueueItem;
}
