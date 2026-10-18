// Port of py_aep/models/layers/text_layer.py

import { getitem } from "../../../pyrt/index.ts";
import { ListChunk } from "../../binary/chunk.ts";
import { TdmnChunk, TdsbChunk, TdsnChunk } from "../../binary/property_chunks.ts";
import { LayerType } from "../../enums/index.ts";
import { labelIndex } from "../preferences.ts";
import { AVLayer } from "./av_layer.ts";
import type { CompItem } from "../items/composition.ts";
import type { EffectParamDefs } from "../descriptors.ts";

type TextLayerNewKw = {
  name: string;
  layer_id: number;
  duration: number;
  containing_comp: CompItem;
  btds: ListChunk;
  btgu: ListChunk;
  tdmn: TdmnChunk;
  effect_param_defs?: EffectParamDefs | null;
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
 * const text_layer = comp.textLayers[0];
 * console.log(text_layer.text);
 * ```
 * @see https://ae-scripting.docsforadobe.dev/layer/textlayer/
 */
export class TextLayer extends AVLayer {
  static _auto_name: string = "Text";

  // NOTE(port): Python has the same `# type: ignore[override]`; the keyword shape differs from AVLayer._new's in both.
  static _new(kw: TextLayerNewKw): TextLayer;
  static _new(...args: never[]): never;
  static _new(kw: TextLayerNewKw): TextLayer {
    const {
      name,
      layer_id,
      duration,
      containing_comp,
      btds,
      btgu,
      tdmn,
      effect_param_defs = null,
    } = kw;
    const textPropsTdmn = new TdmnChunk({ value: "ADBE Text Properties" });
    const textPropsTdgp = new ListChunk({
      list_type: "tdgp",
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
      layer_id,
      duration,
      containing_comp,
      root_tdgp_extra: [textPropsTdmn, textPropsTdgp],
      effect_param_defs,
    });
    layer._ldta.layer_type = LayerType.TEXT;
    // The base factory named the layer from the AV type it started with.
    layer._match_name = getitem(
      layer.constructor._LAYER_MATCH_NAMES,
      LayerType.TEXT,
    );
    // AE labels scripted text layers with the "Text Label Index"
    // preference (factory value 1, probed in AE 2026).
    layer._ldta.label = labelIndex(
      containing_comp._project._preferences,
      "Text Label Index",
      1,
    );
    return layer;
  }
}
