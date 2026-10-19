// Port of py_aep/models/layers/text_layer.py

import { assert, getOrThrow } from "../../../pyrt/index.ts";
import { ListChunk } from "../../binary/chunk.ts";
import { TdmnChunk, TdsbChunk, TdsnChunk } from "../../binary/property_chunks.ts";
import { LayerType } from "../../enums/index.ts";
import { labelIndex } from "../preferences.ts";
import { AVLayer } from "./av_layer.ts";
import type { CompItem } from "../items/composition.ts";
import type { EffectParamDefs } from "../descriptors.ts";
import type { MatchNameTypes } from "../properties/match_name_types.ts";

type TextLayerNewKw = {
  name: string;
  layerId: number;
  duration: number;
  containingComp: CompItem;
  btds: ListChunk;
  btgu: ListChunk;
  tdmn: TdmnChunk;
  effectParamDefs?: EffectParamDefs | null;
};

/**
 * The `TextLayer` object represents a text layer within a composition.
 *
 *
 * Info:
 *     `TextLayer` is a subclass of {@link AVLayer} object. All methods and
 *     attributes of {@link AVLayer} are available when working with `TextLayer`.
 *
 * @example
 * ```ts
 * import { parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const comp = app.project.compositions[0];
 * const textLayer = comp.textLayers[0];
 * console.log(textLayer.text);
 * ```
 * @see https://ae-scripting.docsforadobe.dev/layer/textlayer/
 */
export class TextLayer extends AVLayer {
  static _autoName: string = "Text";

  /** The layer's Text group (Source Text, Path Options, More Options, Animators). */
  override get text(): MatchNameTypes["ADBE Text Properties"] {
    const group = super.text;
    assert(group !== null);
    return group;
  }

  static _new(kw: TextLayerNewKw): TextLayer;
  static _new(...args: never[]): never;
  static _new(kw: TextLayerNewKw): TextLayer {
    const { name, layerId, duration, containingComp, btds, btgu, tdmn, effectParamDefs = null } = kw;
    const textPropsTdmn = new TdmnChunk({ value: "ADBE Text Properties" });
    const textPropsTdgp = new ListChunk({
      listType: "tdgp",
      chunks: [
        new TdsbChunk({}),
        TdsnChunk.new_(),
        tdmn,
        btds,
        btgu,
        // AE terminates the group's match-name stream; without it
        // the file fails with "missing data in file".
        new TdmnChunk({ value: "ADBE Group End" }),
      ],
    });

    const layer = super._new<TextLayer>({
      name,
      layerId,
      duration,
      containingComp,
      rootTdgpExtra: [textPropsTdmn, textPropsTdgp],
      effectParamDefs,
    });
    layer._ldta.layerType = LayerType.TEXT;
    // The base factory named the layer from the AV type it started with.
    layer._matchName = getOrThrow(layer.constructor._LAYER_MATCH_NAMES, LayerType.TEXT);
    // AE labels scripted text layers with the "Text Label Index"
    // preference (factory value 1, probed in AE 2026).
    layer._ldta.label = labelIndex(containingComp._project._preferences, "Text Label Index", 1);
    return layer;
  }
}
