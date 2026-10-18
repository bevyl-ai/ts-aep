/** Advanced 3D (`ADBE Calder`) render options. */

import { EnvironmentLightShadowResolution } from "../../../enums/index.ts";
import { ChunkField } from "../../descriptors.ts";
import { validateAdvancedQuality, validateCastingBoxCenter, validateCastingBoxSize, validateShadowSmoothness } from "../../validators.ts";
import { RendererOptionsBase } from "./renderer_options_base.ts";
import { descriptor } from "../../../../pyrt/index.ts";
import type { AdvancedPrdaChunk } from "../../../binary/misc_chunks.ts";

/**
 * Options for the Advanced 3D renderer.
 *
 * Casting Box Size and Casting Box Center are stored as fractions of the
 * composition's **raw pixel** dimensions - pixel aspect ratio is not
 * applied - and are exposed here in the pixel values the Options dialog
 * shows. Two things worth knowing:
 *
 * - Resizing a composition silently rescales these options in pixel
 *   terms, because the stored fraction does not move. That is After
 *   Effects' own behaviour.
 * - Values that cross a save are stored as `float32`, so a pixel value
 *   read back after saving can differ from the one written by a tiny
 *   fraction of a pixel.
 */
export class AdvancedRendererOptions extends RendererOptionsBase {
  declare _body: AdvancedPrdaChunk;

  static _SPEC: Map<string, [string, typeof EnvironmentLightShadowResolution | null]> = new Map<string, [string, typeof EnvironmentLightShadowResolution | null]>([
    ["Quality", ["quality", null]],
    ["Resolution", ["resolution", EnvironmentLightShadowResolution]],
    ["Smoothness", ["smoothness", null]],
    ["Casting Box Size", ["castingBoxSize", null]],
    ["Casting Box Center", ["castingBoxCenter", null]],
  ]);

  /** Renderer quality, `1` to `125`. Read / Write. */
  declare quality: number;

  /** Environment light shadow resolution. Read / Write. */
  declare resolution: EnvironmentLightShadowResolution;

  /** Environment light shadow smoothness, `1` to `20`. Read / Write. */
  declare smoothness: number;

  /** Size of the shadow casting box, in pixels, as shown in the Options
   * dialog. One dialog control drives all three stored axes, so reads
   * report the X axis.
   * Read / Write.
   */
  get castingBoxSize(): number {
    return this._body.castingBoxSizeX * this._comp.width;
  }

  set castingBoxSize(value: number) {
    validateCastingBoxSize(value);
    const fraction = value / this._comp.width;
    this._body.castingBoxSizeX = fraction;
    this._body.castingBoxSizeY = fraction;
    this._body.castingBoxSizeZ = fraction;
  }

  /** Centre of the shadow casting box as `[x, y, z]` in pixels, as shown
   * in the Options dialog. X and Y are offsets from the composition
   * centre; Z is measured from zero. Read / Write.
   */
  get castingBoxCenter(): number[] {
    const width = this._comp.width;
    const height = this._comp.height;
    return [
      this._body.castingBoxCenterX * width + width / 2,
      this._body.castingBoxCenterY * height + height / 2,
      this._body.castingBoxCenterZ * width,
    ];
  }

  set castingBoxCenter(value: number[]) {
    validateCastingBoxCenter(value);
    const width = this._comp.width;
    const height = this._comp.height;
    const [x, y, z] = value;
    this._body.castingBoxCenterX = (x - width / 2) / width;
    this._body.castingBoxCenterY = (y - height / 2) / height;
    this._body.castingBoxCenterZ = z / width;
  }
}

// Descriptors assigned in the class body: `declare` above, installed here.

/** Renderer quality, `1` to `125`. Read / Write. */
descriptor(
  AdvancedRendererOptions,
  "quality",
  new ChunkField("_body", "quality", { validate: validateAdvancedQuality }),
);

/** Environment light shadow resolution. Read / Write. */
descriptor(
  AdvancedRendererOptions,
  "resolution",
  ChunkField.enum(EnvironmentLightShadowResolution, "_body", "resolution"),
);

/** Environment light shadow smoothness, `1` to `20`. Read / Write. */
descriptor(
  AdvancedRendererOptions,
  "smoothness",
  new ChunkField("_body", "smoothness", { validate: validateShadowSmoothness }),
);
