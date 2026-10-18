/**
 * Shared helpers for AEP CLI tools.
 *
 * Provides chunk labeling, path building, tree walking, and hex formatting
 * used by both `aep-compare` and `aep-inspect`.
 */

// Python's `from ..binary.chunk import ...` runs py_aep/__init__ first, which
// registers every chunk type. Standalone CLI runs need the same registration.
import "../binary/_register.ts";
import { ListChunk, readAep } from "../binary/chunk.ts";
import type { Chunk } from "../binary/chunk.ts";
import { BytesIO, bytes_, floordiv, format, getitem, ValueError } from "../../pyrt/index.ts";
import type { Path } from "../../pyrt/index.ts";

/**
 * Return a human-readable label for a chunk.
 *
 * @param chunk - A parsed chunk object.
 * @returns `LIST:<list_type>` for list chunks, otherwise the chunk type string.
 */
export function chunkLabel(chunk: Chunk): string {
  const chunkType = chunk.chunk_type;
  if (chunkType === "LIST" && "list_type" in chunk) {
    return `LIST:${chunk.list_type}`;
  }
  return chunkType;
}

/**
 * Build a chunk path with duplicate indexing.
 *
 * Tracks how many times each identifier has been seen at a given level
 * and appends `[N]` when a duplicate is encountered.
 *
 * @param parentPath - Parent chunk path prefix.
 * @param identifier - Chunk identifier (e.g. `ldta`, `LIST:Fold`).
 * @param counters - Mutable counter dict tracking duplicates at this level.
 * @returns Full chunk path string.
 */
export function buildChunkPath(
  parentPath: string,
  identifier: string,
  counters: Map<string, number>,
): string {
  const counterKey = parentPath ? parentPath + "/" + identifier : identifier;

  const count = counters.get(counterKey);
  if (count === undefined) {
    counters.set(counterKey, 0);
  } else {
    counters.set(counterKey, count + 1);
  }

  if (getitem(counters, counterKey) > 0) {
    return parentPath
      ? `${parentPath}/${identifier}[${getitem(counters, counterKey)}]`
      : `${identifier}[${getitem(counters, counterKey)}]`;
  }
  return parentPath ? `${parentPath}/${identifier}` : identifier;
}

/**
 * Walk a chunk tree yielding metadata for each node.
 *
 * @param chunks - List of chunk objects.
 * @param parentPath - Parent chunk path prefix.
 * @param depth - Current nesting depth.
 * @returns An iterator yielding Tuples of `(full_path, identifier, raw_data_size, depth, is_list)`.
 */
export function* walkChunks(
  chunks: Chunk[],
  parentPath = "",
  depth = 0,
): Generator<[string, string, number, number, boolean]> {
  const counters = new Map<string, number>();

  for (const chunk of chunks) {
    const identifier = chunkLabel(chunk);
    const currentPath = buildChunkPath(parentPath, identifier, counters);

    const size = chunk.chunk_type !== "LIST" ? chunk.tobytes().length : 0;
    const isList = chunk instanceof ListChunk && chunk.chunks != null;
    yield [currentPath, identifier, size, depth, isList];

    if (chunk instanceof ListChunk && chunk.chunks != null) {
      yield* walkChunks(chunk.chunks, currentPath, depth + 1);
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
export function _extractChunksRecursive(
  chunks: Chunk[],
  parentPath: string,
  result: Map<string, Uint8Array>,
  counters: Map<string, number> | null = null,
  typed: Map<string, Chunk> | null = null,
): void {
  if (counters == null) counters = new Map<string, number>();

  for (const chunk of chunks) {
    const identifier = chunkLabel(chunk);
    const currentPath = buildChunkPath(parentPath, identifier, counters);

    if (chunk instanceof ListChunk) {
      if (chunk.chunks?.length > 0) {
        const childCounters = new Map<string, number>();
        _extractChunksRecursive(chunk.chunks, currentPath, result, childCounters, typed);
      }
    } else {
      // Store all leaf chunks, including empty ones, so missing
      // empty chunks (e.g. Utf8 with no content) are detected
      result.set(currentPath, chunk.tobytes());
      if (typed != null) typed.set(currentPath, chunk);
    }
  }
}

/**
 * Parse an AEP file and extract leaf chunk data with paths.
 *
 * @param filePath - Path to the `.aep` file.
 * @returns Map mapping chunk paths to their raw binary data. Only leaf chunks (non-LIST) are
 *   included.
 */
export function extractLeafChunks(filePath: Path): Map<string, Uint8Array> {
  return extractLeafChunksTyped(filePath)[0];
}

/**
 * Like `extract_leaf_chunks`, but also return the decoded leaf chunks.
 *
 * @returns A tuple `(raw_bytes_by_path, typed_chunk_by_path)`. The typed chunks let callers compare
 *   numeric fields (e.g. float coordinates) with tolerance instead of byte-exactly.
 */
export function extractLeafChunksTyped(
  filePath: Path,
): [Map<string, Uint8Array>, Map<string, Chunk>] {
  // `with open(file_path, "rb") as f:` - the file is read whole, then parsed
  // from memory (same pattern as compare.ts / inspect.ts).
  const f = new BytesIO(filePath.readBytes());
  const [rifx, _xmp] = readAep(f);
  const result = new Map<string, Uint8Array>();
  const typed = new Map<string, Chunk>();
  _extractChunksRecursive(rifx.chunks, "", result, undefined, typed);
  return [result, typed];
}

/**
 * Format binary data as a hex dump with ASCII representation.
 *
 * @param data - Raw bytes to format.
 * @param bytesPerLine - Number of bytes per output line.
 * @returns Multi-line hex dump string.
 */
export function formatHexDump(data: Uint8Array, bytesPerLine = 16): string {
  const lines: string[] = [];
  const mid = floordiv(bytesPerLine, 2);

  if (bytesPerLine === 0) throw new ValueError("range() arg 3 must not be zero");
  for (let i = 0; bytesPerLine > 0 && i < data.length; i += bytesPerLine) {
    const chunk = bytes_.slice(data, i, i + bytesPerLine);

    const leftBytes = bytes_.slice(chunk, null, mid);
    const rightBytes = bytes_.slice(chunk, mid);
    const left = Array.from(leftBytes, (b) => format(b, "02X")).join(" ");
    const right = Array.from(rightBytes, (b) => format(b, "02X")).join(" ");

    const joined = right ? `${left}  ${right}` : left;

    const fullWidth = (mid * 3 - 1) + 2 + (mid * 3 - 1);
    const hexStr = joined.padEnd(fullWidth);

    const asciiStr = Array.from(chunk, (b) => (0x20 <= b && b <= 0x7e ? String.fromCodePoint(b) : ".")).join("");
    lines.push(`${format(i, "04X")}: ${hexStr}  ${asciiStr}`);
  }

  return lines.join("\n");
}
