/**
 * Resolvers module - business logic for computing derived values.
 *
 * This module contains functions that compute derived values from parsed
 * model data. Models remain pure data containers; resolvers perform the
 * computation.
 */

export { resolveOutputFilename } from "./output.ts";

export const __all__ = ["resolve_output_filename"] as const;
