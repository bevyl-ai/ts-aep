/** Shared plumbing for the per-renderer option wrappers. */

import { INSPECT, describe } from "../../../../pyrt/index.ts";
import { AttributeError, objectSetattr, pyObject, repr } from "../../../../pyrt/index.ts";
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
    // Python's owner is the (possibly proxied) instance itself, so writes via
    // the mapping side go through `_assignAttribute` as well.
    const self = pyObject(this);
    objectSetattr(self, "_owner", self);
    return self;
  }

  _assignAttribute(name: string, value: unknown): void {
    // A fresh wrapper is built on every `rendererOptions` access, so a
    // write to a name with no backing descriptor would vanish with the
    // wrapper. Reject it instead of silently dropping it.
    // NOTE(port): `name in prototype` is `hasattr(type(self), name)`; pyrt `hasattr` would run descriptor getters on the prototype.
    if (!name.startsWith("_") && !(name in this.constructor.prototype)) {
      throw new AttributeError(`${this.constructor.name} has no option ${repr(name)}`);
    }
    objectSetattr(this, name, value);
  }

  [INSPECT](): string {
    return describe(this.constructor.name, Object.fromEntries(this.items()));
  }
}
