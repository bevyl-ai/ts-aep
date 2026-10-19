/** Shared plumbing for the per-renderer option wrappers. */

import { INSPECT, describe } from "../../../../pyrt/index.ts";
import { SettingsView, type SettingsSpec } from "../../renderqueue/settings.ts";
import type { CompItem } from "../composition.ts";
import type { Chunk } from "../../../binary/chunk.ts";

/**
 * A renderer's options, as both a mapping and a typed object.
 *
 * Subclasses {@link SettingsView} with itself as the owner, so one object
 * satisfies both idioms.
 *
 * ```ts
 * import type { CompItem } from "@bevyl-ai/ts-aep";
 * declare const comp: CompItem;
 * comp.rendererOptions.set("Quality", 61);
 * ```
 *
 * The {@link CompItem} is held because Advanced 3D stores its Casting Box
 * values as fractions of the composition's own pixel dimensions.
 *
 * @example
 */
export class RendererOptionsBase extends SettingsView {
  // ExtendScript-style key -> (attribute name, optional enum class)
  static _SPEC: SettingsSpec = new Map();

  declare _body: Chunk;
  declare _comp: CompItem;

  constructor(kw: { body: Chunk; comp: CompItem }) {
    const { body, comp } = kw;
    // NOTE(port): Python passes `self` as the owner; TS forbids touching `this` before super(), so the owner is patched in just below (SettingsView only stores it).
    super(null, new.target._SPEC);
    this._body = body;
    this._comp = comp;
    this._owner = this;
  }

  [INSPECT](): string {
    return describe(this.constructor.name, Object.fromEntries(this.items()));
  }
}
