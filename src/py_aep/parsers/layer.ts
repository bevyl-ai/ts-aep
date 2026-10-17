import { warn } from "../../pyrt/index.ts";
import type { ListChunk } from "../binary/chunk.ts";
import { find_by_list_type, find_by_type, find_by_type_or_null } from "../binary/utils.ts";
import { LayerType } from "../enums/index.ts";
import { _suppress_materialization } from "../models/descriptors.ts";
import { AVLayer } from "../models/layers/av_layer.ts";
import { CameraLayer } from "../models/layers/camera_layer.ts";
import { LightLayer } from "../models/layers/light_layer.ts";
import { ParametricMeshLayer } from "../models/layers/parametric_mesh_layer.ts";
import { ShapeLayer } from "../models/layers/shape_layer.ts";
import { TextLayer } from "../models/layers/text_layer.ts";
import { ThreeDModelLayer } from "../models/layers/three_d_model_layer.ts";
import type { ParamDef } from "./effect.ts";
import type { CompItem } from "../models/items/composition.ts";
import type { Layer } from "../models/layers/layer.ts";

// NOTE(port): eager module-level table exactly as in Python; the ESM import order (tests and py_aep/index.ts load the models first) keeps the layer classes out of the TDZ.
export const _LAYER_CLASSES: Map<number, typeof Layer> = new Map<number, typeof Layer>([
  [LayerType.AV, AVLayer],
  [LayerType.LIGHT, LightLayer],
  [LayerType.CAMERA, CameraLayer],
  [LayerType.TEXT, TextLayer],
  [LayerType.SHAPE, ShapeLayer],
  [LayerType.THREE_D_MODEL, ThreeDModelLayer],
  [LayerType.PARAMETRIC_MESH, ParametricMeshLayer],
]);

/**
 * Parse a composition layer.
 *
 * This layer is an instance of an item in a composition. Some information can
 * only be found on the source item. To access it, use `source_item = layer.source`.
 *
 * @param layer_chunk - The LIST chunk to parse.
 * @param composition - The composition.
 * @param effect_param_defs - Project-level effect parameter definitions, used as fallback when
 *   layer-level parT chunks are missing.
 * @returns An {@link AVLayer} for most layers, a {@link LightLayer} for light layers, or a
 *   {@link ParametricMeshLayer} for parametric mesh layers.
 */
export const parse_layer = _suppress_materialization().decorate(function parse_layer(
  layer_chunk: ListChunk,
  composition: CompItem,
  effect_param_defs: Map<string, Map<string, ParamDef>>,
): Layer {
  const child_chunks = layer_chunk.chunks;

  const cmta = find_by_type_or_null(child_chunks, "cmta");

  const ldta = find_by_type(child_chunks, "ldta");
  const name_utf8 = find_by_type(child_chunks, "Utf8");

  const layer_type = ldta.layer_type;

  let layer_cls = _LAYER_CLASSES.get(layer_type);
  if (layer_cls === undefined) {
    // NOTE(port): Python passes stacklevel=2; pyrt warn() only records the message, which is all that is observable.
    warn(`Failed to create layer type ${layer_type}, falling back to AVLayer`);
    layer_cls = AVLayer;
  }

  const layer = new layer_cls({
    _ldta: ldta,
    _cmta: cmta,
    _name_utf8: name_utf8,
    _layer_list: layer_chunk,
    containing_comp: composition,
  });
  layer._tdgp = find_by_list_type(child_chunks, "tdgp");
  // The property tree is built on first access (`Layer._tree_param_defs`).
  Reflect.deleteProperty(layer, "_properties");
  layer._tree_param_defs = effect_param_defs;
  return layer;
});
