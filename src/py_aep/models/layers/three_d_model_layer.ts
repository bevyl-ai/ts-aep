import { AVLayer } from "./av_layer.ts";

/**
 * The `ThreeDModelLayer` object represents a 3D Model layer within a
 * composition.
 *
 *
 * Info:
 *     `ThreeDModelLayer` is a subclass of {@link AVLayer} object. All methods and
 *     attributes of {@link AVLayer} are available when working with
 *     `ThreeDModelLayer`.
 *
 * **Note:** This functionality was added in After Effects 24.4
 *
 * @example
 * ```ts
 * import { parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const comp = app.project.compositions[0];
 * const modelLayer = comp.threeDModelLayers[0];
 * console.log(modelLayer.source);
 * ```
 * @see https://ae-scripting.docsforadobe.dev/layer/threedmodellayer/
 */
export class ThreeDModelLayer extends AVLayer {
  /** `true` for 3D Model layers. Read-only. */
  get canSetCollapseTransformation(): boolean {
    return true;
  }

  /** `false` for 3D Model layers (time remapping is not supported). Read-only. */
  get canSetTimeRemapEnabled(): boolean {
    return false;
  }
}
