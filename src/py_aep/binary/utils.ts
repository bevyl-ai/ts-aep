/** Chunk tree navigation helpers for the binary I/O layer. */

import { DeferredListChunk, ListChunk } from "./chunk.ts";
import { U4LeChunk, Utf8Chunk } from "./scalar_chunks.ts";
import {
  AepError,
  ValueError,
  b,
  jsonDumps,
  jsonLoads,
  typeName,
  type JsonValue,
} from "../../pyrt/index.ts";
import { Chunk } from "./chunk.ts";
import type { ChunkOf } from "./chunk_types.ts";

export class ChunkNotFoundError extends AepError {
  /** Raised when a required chunk is not found in the AEP chunk tree. */
}

/** Sentinel value indicating an undefined frame number in the binary format. */
export const UNDEFINED_FRAME = 0xFFFFFFFF;

/** `getattr(chunk, "list_type", None)`: the list type of a LIST chunk, else `null`. */
export function listTypeOf(chunk: Chunk | null | undefined): string | null {
  return chunk instanceof ListChunk ? chunk.listType : null;
}

/** `c.chunk_type == chunk_type`: `c` was read as the class registered for that type. */
export function isChunkType<K extends string>(c: Chunk, chunkType: K): c is ChunkOf<K> {
  return c.chunkType === chunkType;
}

/** Return first chunk matching `chunkType`, or null if there is none. */
export function findByTypeOrNull<K extends string>(chunks: Chunk[], chunkType: K): ChunkOf<K> | null {
  for (const c of chunks) {
    if (isChunkType(c, chunkType)) return c;
  }
  return null;
}

/**
 * Return first chunk matching `chunkType`.
 *
 * @throws {@link ChunkNotFoundError} If no matching chunk is found.
 */
export function findByType<K extends string>(chunks: Chunk[], chunkType: K): ChunkOf<K> {
  const c = findByTypeOrNull(chunks, chunkType);
  if (c === null) throw new ChunkNotFoundError(`Missing ${chunkType} chunk`);
  return c;
}

/** Return first ListChunk with matching `listType`, or null if there is none. */
export function findByListTypeOrNull(chunks: Chunk[], listType: string): ListChunk | null {
  for (const c of chunks) {
    if (c instanceof ListChunk && c.listType === listType) return c;
  }
  return null;
}

/**
 * Return first ListChunk with matching `listType`.
 *
 * @throws {@link ChunkNotFoundError} If no matching LIST chunk is found.
 */
export function findByListType(chunks: Chunk[], listType: string): ListChunk {
  const c = findByListTypeOrNull(chunks, listType);
  if (c === null) throw new ChunkNotFoundError(`Missing LIST/${listType} chunk`);
  return c;
}

/** Return all chunks matching `chunkType`. */
export function filterByType<K extends string>(chunks: Chunk[], chunkType: K): ChunkOf<K>[] {
  return chunks.filter((c) => isChunkType(c, chunkType));
}

/** Return all ListChunks with matching `listType`. */
export function filterByListType(chunks: Chunk[], listType: string): ListChunk[] {
  return chunks.filter(
    (c): c is ListChunk => c instanceof ListChunk && c.listType === listType,
  );
}

/**
 * Index of `target` in `chunks` by object identity.
 *
 * attrs `@define` chunks compare structurally, so `list.index()` can
 * match a different, byte-equal chunk; identity avoids that.
 *
 * @throws {@link ValueError} If `target` is not found in `chunks`.
 */
export function indexByIdentity<_T>(chunks: readonly _T[], target: object | null): number {
  for (const [i, c] of chunks.entries()) {
    if (c === target) return i;
  }
  throw new ValueError("target chunk not found in chunk list");
}

/**
 * Return `(start, end)` indices of a contiguous block starting at `target`.
 *
 * Scans forward from `target` until a `ListChunk` whose `listType` is
 * in `boundaryListTypes`, or the end of the list.  Uses identity
 * comparison (`is`) to locate `target`.
 *
 * @param chunks - The chunk list to search.
 * @param target - The chunk that starts the block (matched by identity).
 * @param boundaryListTypes - `listType` values that mark the beginning of the next block.
 * @throws {@link ValueError} If `target` is not found in `chunks`.
 */
export function blockSlice(
  chunks: Chunk[],
  target: Chunk,
  boundaryListTypes: ReadonlySet<string>,
): [number, number] {
  const start = indexByIdentity(chunks, target);
  for (let end = start + 1; end < chunks.length; end++) {
    const c = chunks[end];
    if (c instanceof ListChunk && boundaryListTypes.has(c.listType)) {
      return [start, end];
    }
  }
  return [start, chunks.length];
}

/**
 * Return the index of the first chunk matching `anchorType`.
 *
 * `anchorType` can be a plain chunk type (e.g. `"opti"`) or a LIST type
 * prefixed with `"LIST:"` (e.g. `"LIST:Als2"`).
 *
 * @throws {@link ChunkNotFoundError} If no matching chunk is found.
 */
export function _findAnchorIndex(chunks: Chunk[], anchorType: string): number {
  if (anchorType.startsWith("LIST:")) {
    const lt = anchorType.slice(5);
    for (const [i, c] of chunks.entries()) {
      if (c instanceof ListChunk && c.listType === lt) return i;
    }
    throw new ChunkNotFoundError(`Missing LIST/${lt} chunk`);
  }

  for (const [i, c] of chunks.entries()) {
    if (c.chunkType === anchorType) return i;
  }
  throw new ChunkNotFoundError(`Missing ${anchorType} chunk`);
}

/**
 * Return consecutive chunks of `chunkType` immediately before `beforeType`.
 *
 * Scans `chunks` for the first occurrence of `beforeType`, then collects the
 * uninterrupted run of `chunkType` chunks that directly precede it.
 *
 * `beforeType` can be a plain chunk type (e.g. `"opti"`) or a LIST type
 * prefixed with `"LIST:"` (e.g. `"LIST:Als2"`).
 *
 * @throws {@link ChunkNotFoundError} If no chunk with `beforeType` is found.
 */
export function findChunksBefore<K extends string>(
  chunks: Chunk[],
  chunkType: K,
  beforeType: string,
): ChunkOf<K>[] {
  const anchor = _findAnchorIndex(chunks, beforeType);
  const result: ChunkOf<K>[] = [];
  for (let i = anchor - 1; i >= 0; i--) {
    const c = chunks[i];
    if (isChunkType(c, chunkType)) {
      result.unshift(c);
    } else {
      break;
    }
  }
  return result;
}

/**
 * Return consecutive chunks of `chunkType` immediately after `afterType`.
 *
 * Scans `chunks` for the first occurrence of `afterType`, then collects the
 * uninterrupted run of `chunkType` chunks that directly follow it.
 *
 * `afterType` can be a plain chunk type (e.g. `"opti"`) or a LIST type
 * prefixed with `"LIST:"` (e.g. `"LIST:Als2"`).
 *
 * @throws {@link ChunkNotFoundError} If no chunk with `afterType` is found.
 */
export function findChunksAfter<K extends string>(
  chunks: Chunk[],
  chunkType: K,
  afterType: string,
): ChunkOf<K>[] {
  const anchor = _findAnchorIndex(chunks, afterType);
  const result: ChunkOf<K>[] = [];
  for (let i = anchor + 1; i < chunks.length; i++) {
    const c = chunks[i];
    if (isChunkType(c, chunkType)) {
      result.push(c);
    } else {
      break;
    }
  }
  return result;
}

/**
 * Split `chunks` into groups bounded by `startType` ... `endType` (inclusive).
 *
 * Chunks that fall outside any group are ignored.
 */
export function groupChunks(
  chunks: Chunk[],
  startType: string,
  endType: string,
): Chunk[][] {
  const groups: Chunk[][] = [];
  let current: Chunk[] | null = null;
  for (const chunk of chunks) {
    if (chunk.chunkType === startType && current == null) {
      current = [chunk];
    } else if (current != null) {
      current.push(chunk);
      if (chunk.chunkType === endType) {
        groups.push(current);
        current = null;
      }
    }
  }
  return groups;
}

/**
 * Split `chunks` into groups starting at each occurrence of `chunkType`.
 *
 * Every time a chunk with `chunkType` is encountered a new group begins.
 * Chunks that appear before the first occurrence are discarded.
 */
export function splitOnType(chunks: Chunk[], chunkType: string): Chunk[][] {
  const groups: Chunk[][] = [];
  let current: Chunk[] | null = null;
  for (const chunk of chunks) {
    if (chunk.chunkType === chunkType) {
      if (current != null) groups.push(current);
      current = [chunk];
    } else if (current != null) {
      current.push(chunk);
    }
  }
  if (current != null) groups.push(current);
  return groups;
}

/**
 * Parsed `alas` JSON record. After Effects writes `ascendcount_base`,
 * `ascendcount_target`, `fullpath`, `platform`, `server_name`,
 * `server_volume_name` and `targetIsFolder`; a record is re-dumped whole,
 * so keys py_aep does not read survive an edit.
 */
export type AlasData = Map<string, JsonValue>;

/**
 * Parse path information from an Als2/alas chunk structure.
 *
 * @returns Map of alas data (fullpath, target_is_folder, etc.), or an empty Map if not found
 *   or invalid.
 */
export function parseAlasData(parentChunks: Chunk[]): AlasData {
  const als2Chunk = findByListTypeOrNull(parentChunks, "Als2");
  if (als2Chunk === null) return new Map();
  const alasChunk = findByTypeOrNull(als2Chunk.chunks, "alas");
  if (alasChunk === null) return new Map();
  const alasText = alasChunk.value;
  // `value` may be a `_NulTailStr` (String object), which py_bool would call truthy.
  if (alasText == null || String(alasText).length === 0) return new Map();
  const result = jsonLoads(String(alasText));
  return result instanceof Map ? result : new Map();
}

/**
 * `data.get("fullpath", "")`. After Effects always writes the path as a
 * string; anything else is a corrupt record and fails here.
 */
export function alasFullpath(data: AlasData): string {
  const stored = data.get("fullpath");
  const fullpath = stored === undefined ? "" : stored;
  if (typeof fullpath !== "string") throw new TypeError(`alas fullpath must be a str, not '${typeName(fullpath)}'`);
  return fullpath;
}

/** `data.get("target_is_folder", False)`, which After Effects writes as a boolean. */
export function alasTargetIsFolder(data: AlasData): boolean {
  const stored = data.get("target_is_folder");
  const targetIsFolder = stored === undefined ? false : stored;
  if (typeof targetIsFolder !== "boolean") {
    throw new TypeError(`alas targetIsFolder must be a bool, not '${typeName(targetIsFolder)}'`);
  }
  return targetIsFolder;
}

/**
 * `ascendcount_*` value marking an `alas` path record py_aep wrote: the
 * relative-path counts depend on where the project is saved, so
 * `Project.save` fills them in for the file it writes.
 */
export const PENDING_ASCENDCOUNT = -1;

/**
 * The `alas` `platform` code After Effects stores for a path: 2 for a
 * POSIX path, 1 for a drive-letter or UNC path (it follows the path's
 * style, not the saving machine).
 */
export function alasPlatform(fullpath: string): number {
  return fullpath.startsWith("/") ? 2 : 1;
}

/**
 * Serialize an `alas` record the way After Effects writes it: sorted
 * keys, no whitespace.
 */
export function dumpAlas(data: AlasData): string {
  return jsonDumps(data, { sortKeys: true, separators: [",", ":"] });
}

/**
 * Build a `LIST:Als2 -> alas` chunk holding a footage source path.
 *
 * Inverse of `parseAlasData`. AE locates the file via the absolute
 * `fullpath`, falling back to the relative-path counts
 * (`ascendcount_*`), which are left `PENDING_ASCENDCOUNT` for
 * `Project.save` to compute.
 *
 * @param fullpath - Absolute path to the file, or the containing folder for an image sequence.
 * @param kw - Options:
 * - `targetIsFolder`: `true` when `fullpath` is a sequence folder.
 */
export function buildAls2List(
  fullpath: string,
  kw: { targetIsFolder: boolean },
): ListChunk {
  const { targetIsFolder } = kw;
  const data: AlasData = new Map<string, JsonValue>([
    ["ascendcount_base", PENDING_ASCENDCOUNT],
    ["ascendcount_target", PENDING_ASCENDCOUNT],
    ["fullpath", fullpath],
    ["platform", alasPlatform(fullpath)],
    ["server_name", ""],
    ["server_volume_name", ""],
    ["target_is_folder", targetIsFolder],
  ]);
  const alas = new Utf8Chunk({ chunkType: "alas", value: dumpAlas(data) });
  return new ListChunk({ listType: "Als2", chunks: [alas] });
}

/**
 * Build the `LIST:StVc` frame list of an alphabetical image sequence:
 * the file count, then one `Utf8` name per frame, in order.
 */
export function buildStvcList(fileNames: string[]): ListChunk {
  const names: Chunk[] = fileNames.map((name) => new Utf8Chunk({ value: name }));
  return new ListChunk({
    listType: "StVc",
    chunks: [
      new U4LeChunk({ chunkType: "StVS", value: fileNames.length }),
      ...names,
    ],
  });
}

/**
 * Return a text tree representation of chunks for debugging.
 *
 * @param chunks - List of chunks to visualize.
 * @param depth - Max depth to recurse (-1 for unlimited).
 * @param indent - Current indentation level (used internally).
 */
export function chunkTree(chunks: Chunk[], depth = -1, indent = 0): string {
  const lines: string[] = [];
  const prefix = "  ".repeat(indent);
  for (const chunk of chunks) {
    const lt = chunk instanceof ListChunk ? chunk.listType : null;
    const children = chunk instanceof ListChunk ? chunk.chunks : null;
    const size = ("data" in chunk ? chunk.data : b("")).length;
    if (lt != null) {
      const label = `LIST:${lt}`;
      lines.push(`${prefix}${label}`);
      if (depth !== 0 && children != null) {
        lines.push(chunkTree(children, depth - 1, indent + 1));
      }
    } else {
      lines.push(`${prefix}${chunk.chunkType} (${size} B)`);
    }
  }
  return lines.join("\n");
}

/**
 * Add or remove a flag chunk from a ListChunk container.
 *
 * Flag chunks are tiny (1-byte body `b"\x01"`) presence/absence
 * markers.
 *
 * Some flag chunks are positional: After Effects reads them in a fixed
 * slot and rejects the file ("missing data") when they appear elsewhere.
 * Pass `afterTypes` to insert the new chunk immediately after the last
 * chunk of one of those types (e.g. `("cpid",)` for `lnrb`); when none of
 * them is present, or `afterTypes` is empty, the chunk is appended.
 */
export function toggleFlagChunk(
  container: ListChunk,
  chunkType: string,
  enable: boolean,
  kw: { afterTypes?: readonly string[] } = {},
): void {
  const { afterTypes = [] } = kw;

  const existing = container.chunks.flatMap((c, i) => (c.chunkType === chunkType ? [i] : []));
  if (enable && existing.length === 0) {
    const newChunk = new Chunk({ chunkType, data: b("\x01") });
    const anchors = container.chunks.flatMap((c, i) =>
      afterTypes.includes(c.chunkType) ? [i] : [],
    );
    if (anchors.length > 0) {
      container.chunks.splice(anchors[anchors.length - 1] + 1, 0, newChunk);
    } else {
      container.chunks.push(newChunk);
    }
  } else if (!enable && existing.length > 0) {
    for (const i of [...existing].reverse()) {
      container.chunks.splice(i, 1);
    }
  }
}

/**
 * Recursively search the chunk tree for matching chunks.
 *
 * At least one of `chunkType` or `listType` must be given.
 * `skipUnparsed` leaves the children of a `DeferredListChunk` never read
 * unsearched (searching parses it and costs the save its raw-bytes write).
 *
 * @returns All matching chunks across the entire tree, in DFS order.
 */
export function recursiveFind<K extends string>(
  chunks: Chunk[],
  chunkType: K,
  listType?: null,
  skipUnparsed?: boolean,
): ChunkOf<K>[];
export function recursiveFind(
  chunks: Chunk[],
  chunkType?: string | null,
  listType?: string | null,
  skipUnparsed?: boolean,
): Chunk[];
export function recursiveFind(
  chunks: Chunk[],
  chunkType: string | null = null,
  listType: string | null = null,
  skipUnparsed = false,
): Chunk[] {
  if (chunkType == null && listType == null) {
    throw new ValueError("At least one of chunkType or listType is required");
  }
  const results: Chunk[] = [];
  for (const chunk of chunks) {
    if (listType != null) {
      if (chunk instanceof ListChunk && chunk.listType === listType) results.push(chunk);
    } else if (chunk.chunkType === chunkType) {
      results.push(chunk);
    }
    if (skipUnparsed && chunk instanceof DeferredListChunk && !chunk.isParsed) {
      continue;
    }
    if (chunk instanceof ListChunk) {
      for (const found of recursiveFind(chunk.chunks, chunkType, listType, skipUnparsed)) {
        results.push(found);
      }
    }
  }
  return results;
}
