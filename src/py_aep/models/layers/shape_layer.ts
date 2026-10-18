// Port of py_aep/models/layers/shape_layer.py

import { getOrThrow } from "../../../pyrt/index.ts";
import { LayerType } from "../../enums/index.ts";
import { labelIndex } from "../preferences.ts";
import { AVLayer } from "./av_layer.ts";
import type { CompItem } from "../items/composition.ts";
import type { EffectParamDefs } from "../descriptors.ts";

/** Keyword arguments of `ShapeLayer._new`. */
type ShapeLayerNewKw = {
  name: string;
  layerId: number;
  duration: number;
  containingComp: CompItem;
  effectParamDefs?: EffectParamDefs | null;
};

/**
 * The `ShapeLayer` object represents a shape layer within a composition.
 *
 *
 * Info:
 *     `ShapeLayer` is a subclass of {@link AVLayer} object. All methods and
 *     attributes of {@link AVLayer} are available when working with `ShapeLayer`.
 *
 * @example
 * ```ts
 * import { parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const comp = app.project.compositions[0];
 * const shapeLayer = comp.shapeLayers[0];
 * console.log(shapeLayer.property("ADBE Root Vectors Group"));
 * ```
 * @see https://ae-scripting.docsforadobe.dev/layer/shapelayer/
 */
export class ShapeLayer extends AVLayer {
  static _autoName: string = "Shape Layer";

  static _new(kw: ShapeLayerNewKw): ShapeLayer;
  static _new(...args: never[]): never;
  static _new(kw: ShapeLayerNewKw): ShapeLayer {
    const {
      name,
      layerId,
      duration,
      containingComp,
      effectParamDefs = null,
    } = kw;
    const layer = super._new<ShapeLayer>({
      name,
      layerId,
      duration,
      containingComp,
      effectParamDefs,
    });
    layer._ldta.layerType = LayerType.SHAPE;
    // The base factory named the layer from the AV type it started with.
    layer._matchName = getOrThrow(
      layer.constructor._LAYER_MATCH_NAMES,
      LayerType.SHAPE,
    );
    layer._ldta.label = labelIndex(
      containingComp._project._preferences,
      "Shape Label Index 2",
      8,
    );
    layer._ldta.collapseTransformation = true;
    return layer;
  }
}
