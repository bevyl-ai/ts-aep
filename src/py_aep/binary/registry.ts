/**
 * Chunk type registry for dispatching binary parsing.
 */

import type { Chunk } from "./chunk.ts";
import type { ChunkClasses } from "./chunk_types.ts";

/** The registry by `chunk_type`; `get` of a literal registered type returns its class. */
export interface ChunkRegistry extends Map<string, typeof Chunk> {
  get<K extends keyof ChunkClasses>(chunkType: K): ChunkClasses[K] | undefined;
  get(chunkType: string): typeof Chunk | undefined;
}

export const CHUNK_TYPES: ChunkRegistry = new Map();

/**
 * Decorator that registers a Chunk subclass for one or more chunk_types.
 */
export function register(...chunkTypes: string[]): <T extends typeof Chunk>(cls: T) => T {
  function decorator<T extends typeof Chunk>(cls: T): T {
    for (const ct of chunkTypes) {
      CHUNK_TYPES.set(ct, cls);
    }
    return cls;
  }
  return decorator;
}

/**
 * The class registered for `chunk_type`, for modules that cannot import it
 * (Python's function-level import). Chunk modules register on import
 * (`_register.ts`), so a miss means none of them was loaded.
 */
export function registered<K extends keyof ChunkClasses>(chunkType: K): ChunkClasses[K] {
  const cls = CHUNK_TYPES.get(chunkType);
  if (cls === undefined) throw new Error(`chunk type "${chunkType}" is not registered: import py_aep/binary/_register.ts`);
  return cls;
}
