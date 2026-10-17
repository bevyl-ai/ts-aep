/**
 * Shared helpers for AEP CLI tools.
 *
 * Provides chunk labeling, path building, tree walking, and hex formatting
 * used by both `aep-compare` and `aep-inspect`.
 */

// Python's `from ..binary.chunk import ...` runs py_aep/__init__ first, which
// registers every chunk type. Standalone CLI runs need the same registration.
import "../binary/_register.ts";
import { ListChunk, read_aep } from "../binary/chunk.ts";
import type { Chunk } from "../binary/chunk.ts";
import { BytesIO, bytes_, floordiv, format, getitem, ValueError } from "../../pyrt/index.ts";
import type { Path } from "../../pyrt/index.ts";

/**
 * Return a human-readable label for a chunk.
 *
 * @param chunk - A parsed chunk object.
 * @returns `LIST:<list_type>` for list chunks, otherwise the chunk type string.
 */
export function chunk_label(chunk: Chunk): string {
  const chunk_type = chunk.chunk_type;
  if (chunk_type === "LIST" && "list_type" in chunk) {
    return `LIST:${chunk.list_type}`;
  }
  return chunk_type;
}

/**
 * Build a chunk path with duplicate indexing.
 *
 * Tracks how many times each identifier has been seen at a given level
 * and appends `[N]` when a duplicate is encountered.
 *
 * @param parent_path - Parent chunk path prefix.
 * @param identifier - Chunk identifier (e.g. `ldta`, `LIST:Fold`).
 * @param counters - Mutable counter dict tracking duplicates at this level.
 * @returns Full chunk path string.
 */
export function build_chunk_path(
  parent_path: string,
  identifier: string,
  counters: Map<string, number>,
): string {
  const counter_key = parent_path ? parent_path + "/" + identifier : identifier;

  const count = counters.get(counter_key);
  if (count === undefined) {
    counters.set(counter_key, 0);
  } else {
    counters.set(counter_key, count + 1);
  }

  if (getitem(counters, counter_key) > 0) {
    return parent_path
      ? `${parent_path}/${identifier}[${getitem(counters, counter_key)}]`
      : `${identifier}[${getitem(counters, counter_key)}]`;
  }
  return parent_path ? `${parent_path}/${identifier}` : identifier;
}

/**
 * Walk a chunk tree yielding metadata for each node.
 *
 * @param chunks - List of chunk objects.
 * @param parent_path - Parent chunk path prefix.
 * @param depth - Current nesting depth.
 * @returns An iterator yielding Tuples of `(full_path, identifier, raw_data_size, depth, is_list)`.
 */
export function* walk_chunks(
  chunks: Chunk[],
  parent_path = "",
  depth = 0,
): Generator<[string, string, number, number, boolean]> {
  const counters = new Map<string, number>();

  for (const chunk of chunks) {
    const identifier = chunk_label(chunk);
    const current_path = build_chunk_path(parent_path, identifier, counters);

    const size = chunk.chunk_type !== "LIST" ? chunk.tobytes().length : 0;
    const is_list = chunk instanceof ListChunk && chunk.chunks != null;
    yield [current_path, identifier, size, depth, is_list];

    if (chunk instanceof ListChunk && chunk.chunks != null) {
      yield* walk_chunks(chunk.chunks, current_path, depth + 1);
    }
  }
}

/**
 * Recursively extract leaf chunk data with paths.
 *
 * Stores raw data for all non-LIST (leaf) chunks, including empty ones.
 * LIST chunks are traversed but their aggregate raw data is not stored,
 * so diff output only appears at the deepest chunk level. When `typed`
 * is provided, the decoded leaf `Chunk` objects are stored alongside the
 * raw bytes (used for float-tolerant comparison).
 */
export function _extract_chunks_recursive(
  chunks: Chunk[],
  parent_path: string,
  result: Map<string, Uint8Array>,
  counters: Map<string, number> | null = null,
  typed: Map<string, Chunk> | null = null,
): void {
  if (counters == null) counters = new Map<string, number>();

  for (const chunk of chunks) {
    const identifier = chunk_label(chunk);
    const current_path = build_chunk_path(parent_path, identifier, counters);

    if (chunk instanceof ListChunk) {
      if (chunk.chunks?.length > 0) {
        const child_counters = new Map<string, number>();
        _extract_chunks_recursive(chunk.chunks, current_path, result, child_counters, typed);
      }
    } else {
      // Store all leaf chunks, including empty ones, so missing
      // empty chunks (e.g. Utf8 with no content) are detected
      result.set(current_path, chunk.tobytes());
      if (typed != null) typed.set(current_path, chunk);
    }
  }
}

/**
 * Parse an AEP file and extract leaf chunk data with paths.
 *
 * @param file_path - Path to the `.aep` file.
 * @returns Map mapping chunk paths to their raw binary data. Only leaf chunks (non-LIST) are
 *   included.
 */
export function extract_leaf_chunks(file_path: Path): Map<string, Uint8Array> {
  return extract_leaf_chunks_typed(file_path)[0];
}

/**
 * Like `extract_leaf_chunks`, but also return the decoded leaf chunks.
 *
 * @returns A tuple `(raw_bytes_by_path, typed_chunk_by_path)`. The typed chunks let callers compare
 *   numeric fields (e.g. float coordinates) with tolerance instead of byte-exactly.
 */
export function extract_leaf_chunks_typed(
  file_path: Path,
): [Map<string, Uint8Array>, Map<string, Chunk>] {
  // `with open(file_path, "rb") as f:` - the file is read whole, then parsed
  // from memory (same pattern as compare.ts / inspect.ts).
  const f = new BytesIO(file_path.read_bytes());
  const [rifx, _xmp] = read_aep(f);
  const result = new Map<string, Uint8Array>();
  const typed = new Map<string, Chunk>();
  _extract_chunks_recursive(rifx.chunks, "", result, undefined, typed);
  return [result, typed];
}

/**
 * Format binary data as a hex dump with ASCII representation.
 *
 * @param data - Raw bytes to format.
 * @param bytes_per_line - Number of bytes per output line.
 * @returns Multi-line hex dump string.
 */
export function format_hex_dump(data: Uint8Array, bytes_per_line = 16): string {
  const lines: string[] = [];
  const mid = floordiv(bytes_per_line, 2);

  if (bytes_per_line === 0) throw new ValueError("range() arg 3 must not be zero");
  for (let i = 0; bytes_per_line > 0 && i < data.length; i += bytes_per_line) {
    const chunk = bytes_.slice(data, i, i + bytes_per_line);

    const left_bytes = bytes_.slice(chunk, null, mid);
    const right_bytes = bytes_.slice(chunk, mid);
    const left = Array.from(left_bytes, (b) => format(b, "02X")).join(" ");
    const right = Array.from(right_bytes, (b) => format(b, "02X")).join(" ");

    const joined = right ? `${left}  ${right}` : left;

    const full_width = (mid * 3 - 1) + 2 + (mid * 3 - 1);
    const hex_str = joined.padEnd(full_width);

    const ascii_str = Array.from(chunk, (b) => (0x20 <= b && b <= 0x7e ? String.fromCodePoint(b) : ".")).join("");
    lines.push(`${format(i, "04X")}: ${hex_str}  ${ascii_str}`);
  }

  return lines.join("\n");
}
