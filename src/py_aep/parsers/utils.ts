import type { Chunk, ListChunk } from "../binary/chunk.ts";
import { TdmnChunk } from "../binary/property_chunks.ts";
import { truthy, setdefault } from "../../pyrt/index.ts";

export const _SKIP_CHUNK_TYPES: readonly string[] = ["engv", "aRbs"];

/**
 * Group chunks into runs of consecutive same-match-name properties.
 *
 * Each run is a `(match_name, chunks)` pair covering one or more
 * adjacent properties sharing a match name (e.g. mask atoms, or an
 * effect duplicated right after the original). A match name that
 * re-occurs after a different one starts a new run, so file order is
 * preserved for same-type properties separated by others (unlike
 * `getChunksByMatchName`, which merges them).
 */
export function getMatchNameRuns(rootChunk: ListChunk): [string, Chunk[]][] {
  const runs: [string, Chunk[]][] = [];
  if (truthy(rootChunk)) {
    let skipToNextTdmnFlag = true;
    for (const chunk of rootChunk.chunks) {
      if (chunk.chunkType === "tdmn" && chunk instanceof TdmnChunk) {
        const matchName = chunk.value;
        if (matchName === "ADBE Group End") {
          skipToNextTdmnFlag = true;
          continue;
        }
        skipToNextTdmnFlag = false;
        if (runs.length === 0 || runs[runs.length - 1][0] !== matchName) {
          runs.push([matchName, []]);
        }
        runs[runs.length - 1][1].push(chunk);
      } else if (!skipToNextTdmnFlag && !_SKIP_CHUNK_TYPES.includes(chunk.chunkType)) {
        runs[runs.length - 1][1].push(chunk);
      }
    }
  }
  return runs;
}

/**
 * Get chunks grouped by their match name.
 *
 * Re-occurrences of a match name merge into one entry, losing the
 * relative order of same-type properties separated by others; use
 * `getMatchNameRuns` when property order matters.
 */
export function getChunksByMatchName(rootChunk: ListChunk): Map<string, Chunk[]> {
  const chunksByMatchName = new Map<string, Chunk[]>();
  for (const [matchName, chunks] of getMatchNameRuns(rootChunk)) {
    setdefault(chunksByMatchName, matchName, []).push(...chunks);
  }
  return chunksByMatchName;
}
