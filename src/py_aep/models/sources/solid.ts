import { descriptor } from "../../../pyrt/index.ts";
import { SoliOptiChunk, SspcChunk } from "../../binary/footage_chunks.ts";
import { solidColorName } from "../../resolvers/solid.ts";
import { ChunkField } from "../descriptors.ts";
import { validateOptiName, validatePixelAspect, validateRgbColor, validateSolidDimension } from "../validators.ts";
import { FootageSource } from "./footage.ts";

import type { ListChunk } from "../../binary/chunk.ts";
import type { OptiChunk } from "../../binary/footage_chunks.ts";
import type { U1Chunk } from "../../binary/scalar_chunks.ts";

/**
 * The `SolidSource` object represents a solid-color footage source.
 *
 * ```ts
 * import { parse, SolidSource } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const footage = app.project.footages[0];
 * if (footage.mainSource instanceof SolidSource) {
 *   console.log(footage.mainSource.color);
 * }
 * ```
 *
 * Info:
 * `SolidSource` is a subclass of {@link FootageSource} object. All methods and
 * attributes of {@link FootageSource} are available when working with `SolidSource`.
 *
 * @example
 * @see https://ae-scripting.docsforadobe.dev/sources/solidsource/
 */
export class SolidSource extends FootageSource {
  declare _opti: OptiChunk;

  static _ownsName = true;

  /**
   * The solid color, expressed as `[R, G, B]` values in the
   * range `[0.0..1.0]`. Read / Write.
   */
  declare color: number[];

  constructor(kw: {
    _sspc: SspcChunk;
    _opti: OptiChunk;
    _linl?: U1Chunk | null;
    _clrs?: ListChunk | null;
  }) {
    const { _sspc, _opti, _linl = null, _clrs = null } = kw;
    super({ _sspc, _linl, _clrs });
    this._opti = _opti;
  }

  /**
   * Derive the base solid name from an RGB color.
   *
   * After Effects names solids by their perceived color category.
   * Returns the base name (e.g. `"Red Solid"`) without a trailing
   * number suffix; the caller is responsible for disambiguation.
   *
   * @param r - Red channel in `[0.0, 1.0]`.
   * @param g - Green channel in `[0.0, 1.0]`.
   * @param b - Blue channel in `[0.0, 1.0]`.
   */
  static _colorName(r: number, g: number, b: number): string {
    return solidColorName(r, g, b);
  }

  /**
   * Create a new solid source with backing chunks.
   *
   * @param color - Solid color as [R, G, B] in 0.0-1.0 range.
   * @param name - The solid name.
   * @param width - Width in pixels (1-30000).
   * @param height - Height in pixels (1-30000).
   * @param pixelAspect - Pixel aspect ratio (0.01-100.0).
   */
  static _new(
    name: string,
    color: number[] = [0.0, 0.0, 0.0],
    width: number = 100,
    height: number = 100,
    pixelAspect: number = 1.0,
  ): SolidSource {
    validateOptiName(name);
    validateSolidDimension(width);
    validateSolidDimension(height);
    validatePixelAspect(pixelAspect);
    validateRgbColor(color);

    const sspc = new SspcChunk({
      width,
      height,
      sourceFormatType: "Soli",
      alphaModeRaw: 3,
      durationDividend: 0,
    });
    sspc.pixelAspect = pixelAspect;

    const opti = new SoliOptiChunk({
      colorR: color[0],
      colorG: color[1],
      colorB: color[2],
      solidName: name,
    });

    return new this({ _sspc: sspc, _opti: opti });
  }

  _resolveName(rawName: string): string {
    return this._opti.solidName;
  }

  _storeName(value: string): void {
    validateOptiName(value);
    this._opti.solidName = value;
  }
}

descriptor(
  SolidSource,
  "color",
  new ChunkField("_opti", "color", {
    validate: validateRgbColor,
  }),
);
