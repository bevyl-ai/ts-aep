// Python: src/py_aep/models/guide.py (`from __future__ import annotations`: dropped)

import { INSPECT } from "../../pyrt/index.ts";
import { GuideItem } from "../binary/ldat_chunks.ts";
import { GuideOrientationType } from "../enums/index.ts";
import { descriptor, floatRepr } from "../../pyrt/index.ts";
import { ChunkField } from "./descriptors.ts";
import { validateF8 } from "./validators.ts";

/**
 * A ruler guide used for alignment in a composition.
 *
 * Guides are horizontal or vertical lines placed at specific pixel positions
 * within a composition. They are visual aids and do not affect rendering.
 *
 * **Note:** Guide class has no ExtendScript equivalent.
 *
 * @example
 * ```ts
 * import { parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const comp = app.project.compositions[0];
 * for (const guide of comp.guides) {
 *   console.log(guide.orientationType, guide.position);
 * }
 * ```
 */
export class Guide {
  /** The orientation of the guide. Read / Write. */
  declare orientationType: GuideOrientationType;

  /**
   * The position of the guide in pixels from the top (horizontal) or
   * left (vertical) edge of the composition. Read / Write.
   *
   * May be negative or fractional: guides sit anywhere on the ruler, and
   * After Effects accepts both (probed on AE 2026, backed by a signed f8).
   */
  declare position: number;

  /** The position type of the guide. Always 0 (pixels). Read / Write. */
  declare positionType: number;

  declare _guideItem: GuideItem;

  constructor(_guideItem: GuideItem) {
    this._guideItem = _guideItem;
  }

  /**
   * Create a new guide with the given orientation and position.
   *
   * Any `orientationType` value other than 0 or 1 defaults to
   * horizontal (matching ExtendScript behavior).
   *
   * @param orientationType - 0 for horizontal, 1 for vertical.
   * @param position - The pixel position of the guide.
   * @returns A new `Guide` instance backed by a freshly created `GuideItem`.
   */
  static _new(orientationType: number, position: number): Guide {
    const orientation = GuideOrientationType.fromBinary(orientationType);
    validateF8(position);
    const item = new GuideItem({
      orientationType: GuideOrientationType.toBinary(orientation),
      positionType: 0,
      position,
    });
    return new this(item);
  }

  [INSPECT](): string {
    const orient = this.orientationType === GuideOrientationType.HORIZONTAL ? "horizontal" : "vertical";
    return `Guide(${orient}, position=${floatRepr(this.position)})`;
  }

  static {
    descriptor(this, "orientationType", ChunkField.enum(GuideOrientationType, "_guideItem", "orientationType"));
    descriptor(this, "position", new ChunkField("_guideItem", "position", { validate: validateF8 }));
    descriptor(this, "positionType", new ChunkField("_guideItem", "positionType"));
  }
}
