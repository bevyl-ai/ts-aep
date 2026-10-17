import type { Chunk, ListChunk } from "../binary/chunk.ts";
import { TdmnChunk } from "../binary/property_chunks.ts";
import { py_bool, setdefault } from "../../pyrt/index.ts";

export const _SKIP_CHUNK_TYPES: readonly string[] = ["engv", "aRbs"];

/**
 * Group chunks into runs of consecutive same-match-name properties.
 *
 * Each run is a `(match_name, chunks)` pair covering one or more
 * adjacent properties sharing a match name (e.g. mask atoms, or an
 * effect duplicated right after the original). A match name that
 * re-occurs after a different one starts a new run, so file order is
 * preserved for same-type properties separated by others (unlike
 * `get_chunks_by_match_name`, which merges them).
 */
export function get_match_name_runs(root_chunk: ListChunk): [string, Chunk[]][] {
  const runs: [string, Chunk[]][] = [];
  if (py_bool(root_chunk)) {
    let skip_to_next_tdmn_flag = true;
    for (const chunk of root_chunk.chunks) {
      if (chunk.chunk_type === "tdmn" && chunk instanceof TdmnChunk) {
        const match_name = chunk.value;
        if (match_name === "ADBE Group End") {
          skip_to_next_tdmn_flag = true;
          continue;
        }
        skip_to_next_tdmn_flag = false;
        if (runs.length === 0 || runs[runs.length - 1][0] !== match_name) {
          runs.push([match_name, []]);
        }
        runs[runs.length - 1][1].push(chunk);
      } else if (!skip_to_next_tdmn_flag && !_SKIP_CHUNK_TYPES.includes(chunk.chunk_type)) {
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
 * `get_match_name_runs` when property order matters.
 */
export function get_chunks_by_match_name(root_chunk: ListChunk): Map<string, Chunk[]> {
  const chunks_by_match_name = new Map<string, Chunk[]>();
  for (const [match_name, chunks] of get_match_name_runs(root_chunk)) {
    setdefault(chunks_by_match_name, match_name, []).push(...chunks);
  }
  return chunks_by_match_name;
}
