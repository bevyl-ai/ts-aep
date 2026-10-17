/** Chunk tree navigation helpers for the binary I/O layer. */

import { DeferredListChunk, ListChunk } from "./chunk.ts";
import { U4LeChunk, Utf8Chunk } from "./scalar_chunks.ts";
import {
  PyException,
  ValueError,
  b,
  json_dumps,
  json_loads,
  len,
  type_name,
  TypeError_,
  type JsonValue,
} from "../../pyrt/index.ts";
import { Chunk } from "./chunk.ts";
import type { ChunkOf } from "./chunk_types.ts";

export class ChunkNotFoundError extends PyException {
  /** Raised when a required chunk is not found in the AEP chunk tree. */
}

/** Sentinel value indicating an undefined frame number in the binary format. */
export const UNDEFINED_FRAME = 0xFFFFFFFF;

/** `getattr(chunk, "list_type", None)`: the list type of a LIST chunk, else `null`. */
export function list_type_of(chunk: Chunk | null | undefined): string | null {
  return chunk instanceof ListChunk ? chunk.list_type : null;
}

/** Return first chunk matching `chunk_type`, or null if there is none. */
export function find_by_type_or_null<K extends string>(chunks: Chunk[], chunk_type: K): ChunkOf<K> | null {
  for (const c of chunks) {
    if (c.chunk_type === chunk_type) return c as ChunkOf<K>;
  }
  return null;
}

/**
 * Return first chunk matching `chunk_type`.
 *
 * @throws {@link ChunkNotFoundError} If no matching chunk is found.
 */
export function find_by_type<K extends string>(chunks: Chunk[], chunk_type: K): ChunkOf<K> {
  const c = find_by_type_or_null(chunks, chunk_type);
  if (c === null) throw new ChunkNotFoundError(`Missing ${chunk_type} chunk`);
  return c;
}

/** Return first ListChunk with matching `list_type`, or null if there is none. */
export function find_by_list_type_or_null(chunks: Chunk[], list_type: string): ListChunk | null {
  for (const c of chunks) {
    if (c instanceof ListChunk && c.list_type === list_type) return c;
  }
  return null;
}

/**
 * Return first ListChunk with matching `list_type`.
 *
 * @throws {@link ChunkNotFoundError} If no matching LIST chunk is found.
 */
export function find_by_list_type(chunks: Chunk[], list_type: string): ListChunk {
  const c = find_by_list_type_or_null(chunks, list_type);
  if (c === null) throw new ChunkNotFoundError(`Missing LIST/${list_type} chunk`);
  return c;
}

/** Return all chunks matching `chunk_type`. */
export function filter_by_type<K extends string>(chunks: Chunk[], chunk_type: K): ChunkOf<K>[] {
  return chunks.filter((c): c is ChunkOf<K> => c.chunk_type === chunk_type);
}

/** Return all ListChunks with matching `list_type`. */
export function filter_by_list_type(chunks: Chunk[], list_type: string): ListChunk[] {
  return chunks.filter(
    (c): c is ListChunk => c instanceof ListChunk && c.list_type === list_type,
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
export function index_by_identity<_T>(chunks: readonly _T[], target: object | null): number {
  for (const [i, c] of chunks.entries()) {
    if (c === target) return i;
  }
  throw new ValueError("target chunk not found in chunk list");
}

/**
 * Return `(start, end)` indices of a contiguous block starting at `target`.
 *
 * Scans forward from `target` until a `ListChunk` whose `list_type` is
 * in `boundary_list_types`, or the end of the list.  Uses identity
 * comparison (`is`) to locate `target`.
 *
 * @param chunks - The chunk list to search.
 * @param target - The chunk that starts the block (matched by identity).
 * @param boundary_list_types - `list_type` values that mark the beginning of the next block.
 * @throws {@link ValueError} If `target` is not found in `chunks`.
 */
export function block_slice(
  chunks: Chunk[],
  target: Chunk,
  boundary_list_types: ReadonlySet<string>,
): [number, number] {
  const start = index_by_identity(chunks, target);
  for (let end = start + 1; end < chunks.length; end++) {
    const c = chunks[end];
    if (c instanceof ListChunk && boundary_list_types.has(c.list_type)) {
      return [start, end];
    }
  }
  return [start, chunks.length];
}

/**
 * Return the index of the first chunk matching `anchor_type`.
 *
 * `anchor_type` can be a plain chunk type (e.g. `"opti"`) or a LIST type
 * prefixed with `"LIST:"` (e.g. `"LIST:Als2"`).
 *
 * @throws {@link ChunkNotFoundError} If no matching chunk is found.
 */
export function _find_anchor_index(chunks: Chunk[], anchor_type: string): number {
  if (anchor_type.startsWith("LIST:")) {
    const lt = anchor_type.slice(5);
    for (const [i, c] of chunks.entries()) {
      if (c instanceof ListChunk && c.list_type === lt) return i;
    }
    throw new ChunkNotFoundError(`Missing LIST/${lt} chunk`);
  }

  for (const [i, c] of chunks.entries()) {
    if (c.chunk_type === anchor_type) return i;
  }
  throw new ChunkNotFoundError(`Missing ${anchor_type} chunk`);
}

/**
 * Return consecutive chunks of `chunk_type` immediately before `before_type`.
 *
 * Scans `chunks` for the first occurrence of `before_type`, then collects the
 * uninterrupted run of `chunk_type` chunks that directly precede it.
 *
 * `before_type` can be a plain chunk type (e.g. `"opti"`) or a LIST type
 * prefixed with `"LIST:"` (e.g. `"LIST:Als2"`).
 *
 * @throws {@link ChunkNotFoundError} If no chunk with `before_type` is found.
 */
export function find_chunks_before<K extends string>(
  chunks: Chunk[],
  chunk_type: K,
  before_type: string,
): ChunkOf<K>[] {
  const anchor = _find_anchor_index(chunks, before_type);
  const result: ChunkOf<K>[] = [];
  for (let i = anchor - 1; i >= 0; i--) {
    if (chunks[i].chunk_type === chunk_type) {
      result.unshift(chunks[i] as ChunkOf<K>);
    } else {
      break;
    }
  }
  return result;
}

/**
 * Return consecutive chunks of `chunk_type` immediately after `after_type`.
 *
 * Scans `chunks` for the first occurrence of `after_type`, then collects the
 * uninterrupted run of `chunk_type` chunks that directly follow it.
 *
 * `after_type` can be a plain chunk type (e.g. `"opti"`) or a LIST type
 * prefixed with `"LIST:"` (e.g. `"LIST:Als2"`).
 *
 * @throws {@link ChunkNotFoundError} If no chunk with `after_type` is found.
 */
export function find_chunks_after<K extends string>(
  chunks: Chunk[],
  chunk_type: K,
  after_type: string,
): ChunkOf<K>[] {
  const anchor = _find_anchor_index(chunks, after_type);
  const result: ChunkOf<K>[] = [];
  for (let i = anchor + 1; i < chunks.length; i++) {
    if (chunks[i].chunk_type === chunk_type) {
      result.push(chunks[i] as ChunkOf<K>);
    } else {
      break;
    }
  }
  return result;
}

/**
 * Split `chunks` into groups bounded by `start_type` ... `end_type` (inclusive).
 *
 * Chunks that fall outside any group are ignored.
 */
export function group_chunks(
  chunks: Chunk[],
  start_type: string,
  end_type: string,
): Chunk[][] {
  const groups: Chunk[][] = [];
  let current: Chunk[] | null = null;
  for (const chunk of chunks) {
    if (chunk.chunk_type === start_type && current == null) {
      current = [chunk];
    } else if (current != null) {
      current.push(chunk);
      if (chunk.chunk_type === end_type) {
        groups.push(current);
        current = null;
      }
    }
  }
  return groups;
}

/**
 * Split `chunks` into groups starting at each occurrence of `chunk_type`.
 *
 * Every time a chunk with `chunk_type` is encountered a new group begins.
 * Chunks that appear before the first occurrence are discarded.
 */
export function split_on_type(chunks: Chunk[], chunk_type: string): Chunk[][] {
  const groups: Chunk[][] = [];
  let current: Chunk[] | null = null;
  for (const chunk of chunks) {
    if (chunk.chunk_type === chunk_type) {
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
 * `server_volume_name` and `target_is_folder`; a record is re-dumped whole,
 * so keys py_aep does not read survive an edit.
 */
export type AlasData = Map<string, JsonValue>;

/**
 * Parse path information from an Als2/alas chunk structure.
 *
 * @returns Map of alas data (fullpath, target_is_folder, etc.), or an empty Map if not found
 *   or invalid.
 */
export function parse_alas_data(parent_chunks: Chunk[]): AlasData {
  const als2_chunk = find_by_list_type_or_null(parent_chunks, "Als2");
  if (als2_chunk === null) return new Map();
  const alas_chunk = find_by_type_or_null(als2_chunk.chunks, "alas");
  if (alas_chunk === null) return new Map();
  const alas_text = alas_chunk.value;
  // `value` may be a `_NulTailStr` (String object), which py_bool would call truthy.
  if (alas_text == null || String(alas_text).length === 0) return new Map();
  const result = json_loads(String(alas_text));
  return result instanceof Map ? result : new Map();
}

/**
 * `data.get("fullpath", "")`. After Effects always writes the path as a
 * string; anything else is a corrupt record and fails here.
 */
export function alas_fullpath(data: AlasData): string {
  const stored = data.get("fullpath");
  const fullpath = stored === undefined ? "" : stored;
  if (typeof fullpath !== "string") throw new TypeError_(`alas fullpath must be a str, not '${type_name(fullpath)}'`);
  return fullpath;
}

/** `data.get("target_is_folder", False)`, which After Effects writes as a boolean. */
export function alas_target_is_folder(data: AlasData): boolean {
  const stored = data.get("target_is_folder");
  const target_is_folder = stored === undefined ? false : stored;
  if (typeof target_is_folder !== "boolean") {
    throw new TypeError_(`alas target_is_folder must be a bool, not '${type_name(target_is_folder)}'`);
  }
  return target_is_folder;
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
export function alas_platform(fullpath: string): number {
  return fullpath.startsWith("/") ? 2 : 1;
}

/**
 * Serialize an `alas` record the way After Effects writes it: sorted
 * keys, no whitespace.
 */
export function dump_alas(data: AlasData): string {
  return json_dumps(data, { sort_keys: true, separators: [",", ":"] });
}

/**
 * Build a `LIST:Als2 -> alas` chunk holding a footage source path.
 *
 * Inverse of `parse_alas_data`. AE locates the file via the absolute
 * `fullpath`, falling back to the relative-path counts
 * (`ascendcount_*`), which are left `PENDING_ASCENDCOUNT` for
 * `Project.save` to compute.
 *
 * @param fullpath - Absolute path to the file, or the containing folder for an image sequence.
 * @param kw - Options:
 * - `target_is_folder`: `true` when `fullpath` is a sequence folder.
 */
export function build_als2_list(
  fullpath: string,
  kw: { target_is_folder: boolean },
): ListChunk {
  const { target_is_folder } = kw;
  const data: AlasData = new Map<string, JsonValue>([
    ["ascendcount_base", PENDING_ASCENDCOUNT],
    ["ascendcount_target", PENDING_ASCENDCOUNT],
    ["fullpath", fullpath],
    ["platform", alas_platform(fullpath)],
    ["server_name", ""],
    ["server_volume_name", ""],
    ["target_is_folder", target_is_folder],
  ]);
  const alas = new Utf8Chunk({ chunk_type: "alas", value: dump_alas(data) });
  return new ListChunk({ list_type: "Als2", chunks: [alas] });
}

/**
 * Build the `LIST:StVc` frame list of an alphabetical image sequence:
 * the file count, then one `Utf8` name per frame, in order.
 */
export function build_stvc_list(file_names: string[]): ListChunk {
  const names: Chunk[] = file_names.map((name) => new Utf8Chunk({ value: name }));
  return new ListChunk({
    list_type: "StVc",
    chunks: [
      new U4LeChunk({ chunk_type: "StVS", value: file_names.length }),
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
export function chunk_tree(chunks: Chunk[], depth = -1, indent = 0): string {
  const lines: string[] = [];
  const prefix = "  ".repeat(indent);
  for (const chunk of chunks) {
    const lt = chunk instanceof ListChunk ? chunk.list_type : null;
    const children = chunk instanceof ListChunk ? chunk.chunks : null;
    const size = len("data" in chunk ? chunk.data : b(""));
    if (lt != null) {
      const label = `LIST:${lt}`;
      lines.push(`${prefix}${label}`);
      if (depth !== 0 && children != null) {
        lines.push(chunk_tree(children, depth - 1, indent + 1));
      }
    } else {
      lines.push(`${prefix}${chunk.chunk_type} (${size} B)`);
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
 * Pass `after_types` to insert the new chunk immediately after the last
 * chunk of one of those types (e.g. `("cpid",)` for `lnrb`); when none of
 * them is present, or `after_types` is empty, the chunk is appended.
 */
export function toggle_flag_chunk(
  container: ListChunk,
  chunk_type: string,
  enable: boolean,
  kw: { after_types?: readonly string[] } = {},
): void {
  const { after_types = [] } = kw;

  const existing = container.chunks.flatMap((c, i) => (c.chunk_type === chunk_type ? [i] : []));
  if (enable && existing.length === 0) {
    const new_chunk = new Chunk({ chunk_type, data: b("\x01") });
    const anchors = container.chunks.flatMap((c, i) =>
      after_types.includes(c.chunk_type) ? [i] : [],
    );
    if (anchors.length > 0) {
      container.chunks.splice(anchors[anchors.length - 1] + 1, 0, new_chunk);
    } else {
      container.chunks.push(new_chunk);
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
 * At least one of `chunk_type` or `list_type` must be given.
 * `skip_unparsed` leaves the children of a `DeferredListChunk` never read
 * unsearched (searching parses it and costs the save its raw-bytes write).
 *
 * @returns All matching chunks across the entire tree, in DFS order.
 */
export function recursive_find<K extends string>(
  chunks: Chunk[],
  chunk_type: K,
  list_type?: null,
  skip_unparsed?: boolean,
): ChunkOf<K>[];
export function recursive_find(
  chunks: Chunk[],
  chunk_type?: string | null,
  list_type?: string | null,
  skip_unparsed?: boolean,
): Chunk[];
export function recursive_find(
  chunks: Chunk[],
  chunk_type: string | null = null,
  list_type: string | null = null,
  skip_unparsed = false,
): Chunk[] {
  if (chunk_type == null && list_type == null) {
    throw new ValueError("At least one of chunk_type or list_type is required");
  }
  const results: Chunk[] = [];
  for (const chunk of chunks) {
    if (list_type != null) {
      if (chunk instanceof ListChunk && chunk.list_type === list_type) results.push(chunk);
    } else if (chunk.chunk_type === chunk_type) {
      results.push(chunk);
    }
    if (skip_unparsed && chunk instanceof DeferredListChunk && !chunk.is_parsed) {
      continue;
    }
    if (chunk instanceof ListChunk) {
      for (const found of recursive_find(chunk.chunks, chunk_type, list_type, skip_unparsed)) {
        results.push(found);
      }
    }
  }
  return results;
}
