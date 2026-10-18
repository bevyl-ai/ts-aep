/**
 * Resolver for `Property.canSetExpression`.
 *
 * After Effects allows an expression on a stream the Timeline shows, whose
 * value is not empty, that can vary over time, and - for an effect
 * parameter - whose parameter type is not a layer, a mask reference or a
 * group. Checked against every ExtendScript `canSetExpression` in the sample
 * corpus.
 *
 * What the Timeline hides depends, for a layer property, on the layer's
 * state (a 3D-only property on a 2D layer, another renderer's material
 * options, another light type's options), which the `overrides` tables state. For
 * an effect parameter it depends on the effect's plugin: AE stores that in
 * the stream's `tdsb`, recomputing it when it opens a project, so a stored
 * flag is trusted there and a synthesized parameter falls back on its
 * `PF_PUI_INVISIBLE` flag. Layer properties never read the stored flag: it
 * would go stale on a py-side edit of the layer (the 3-D switch, the light
 * type, the comp renderer) and stay stale once saved.
 */

import { AttributeError, deferred } from "../../pyrt/index.ts";
import { get_ae_version_major } from "../ae_version.ts";
import { LayerType, PropertyControlType, PropertyValueType } from "../enums/index.ts";
import { _CAMERA_NO_EXPRESSION, _CANSETEXPR_2D_ONLY, _CANSETEXPR_3D_ONLY, _CANSETEXPR_EXTRUSION_DEPTHS, _CANSETEXPR_FALSE_OVERRIDES, _CANSETEXPR_RENDERER_3D_ONLY, _LIGHT_AMBIENT_NO_EXPRESSION, _LIGHT_ENVIRONMENT_NO_EXPRESSION, _LIGHT_NO_EXPRESSION, _LIGHT_PARALLEL_NO_EXPRESSION, _LIGHT_POINT_NO_EXPRESSION, _LIGHT_SPOT_NO_EXPRESSION, _MATERIAL_COEFFICIENTS, _MODEL_LAYER_HIDDEN_MATERIALS, _PARAMETRIC_MESH_CHECKBOX_STREAMS, _PARAMETRIC_MESH_GROUP_TYPE, _PARAMETRIC_MESH_NO_EXPRESSION } from "../models/properties/overrides.ts";
import type { Property } from "../models/properties/property.ts";
import type { Layer } from "../models/layers/layer.ts";

const _av_layer = deferred<typeof import("../models/layers/av_layer.ts")>("py_aep/models/layers/av_layer");

// PVT sets where can_set_expression is always True / False regardless
// of other signals.
export const _PVT_ALWAYS_TRUE: ReadonlySet<number> = new Set<number>([
  PropertyValueType.TEXT_DOCUMENT,
  PropertyValueType.SHAPE,
]);
export const _PVT_ALWAYS_FALSE: ReadonlySet<number> = new Set<number>([
  PropertyValueType.NO_VALUE,
  PropertyValueType.MARKER,
]);

// Effect parameter types that never take an expression: a layer or mask
// reference, and group markers.
export const _NON_EXPRESSION_PARAM_TYPES: ReadonlySet<number> = new Set<number>([
  PropertyControlType.LAYER,
  PropertyControlType.PAINT_GROUP,
  PropertyControlType.MASK,
  PropertyControlType.GROUP,
  PropertyControlType.UNKNOWN_14,
]);

// Hidden, but still expressionable: AE exempts these paint streams.
export const _HIDDEN_BUT_EXPRESSIONABLE: ReadonlySet<string> = new Set<string>([
  "ADBE Paint Transfer Mode",
  "ADBE Paint Duration",
]);

// `CompItem.renderer` of Classic 3D, which draws a 3D layer as a flat plane.
export const _CLASSIC_3D = "ADBE Advanced 3d";

// Shape stroke Line Join value for a miter join.
export const _MITER_JOIN = 1;

/**
 * Compute `can_set_expression` for a property.
 *
 * @param prop - The property to evaluate.
 * @returns Whether an expression can be set on this property.
 */
export function resolve_can_set_expression(prop: Property): boolean {
  const mn = prop.matchName;

  // Separation moves expressibility from the leader to its followers.
  // Measured on AE 2026: unseparated, the leader takes an expression and no
  // follower does; separated, the leader refuses one and X / Y accept, with
  // Z joining them only on a 3D layer.
  if (prop.isSeparationFollower) {
    const leader = prop.separationLeader;
    if (leader == null || !leader.dimensionsSeparated) {
      return false;
    }
    if (prop.separationDimension === 2) {
      return prop._containing_layer.is3d;
    }
    return true;
  }
  if (prop.isSeparationLeader && prop.dimensionsSeparated) {
    return false;
  }

  // An UNAPPLIED text-animator pool property cannot have an expression;
  // once applied (materialized in binary) it can, like any property.
  const parent = prop.parentProperty;
  if (
    parent != null &&
    parent.matchName === "ADBE Text Animator Properties" &&
    !prop._is_live()
  ) {
    return false;
  }

  const pvt = prop.propertyValueType;
  if (_PVT_ALWAYS_TRUE.has(pvt)) {
    return true;
  }

  if (mn === "ADBE Time Remapping") {
    // Only AV layers have one.
    const layer = prop._containing_layer;
    if (!(layer instanceof _av_layer().AVLayer)) {
      // NOTE(port): Python's `cast` reads the attribute anyway, which a non-AV layer answers by child lookup.
      throw new AttributeError(`'${layer.constructor.name}' has no property 'time_remap_enabled'`);
    }
    return layer.timeRemapEnabled;
  }

  if (!prop.canVaryOverTime) {
    return false;
  }

  if (_PVT_ALWAYS_FALSE.has(pvt)) {
    return false;
  }

  if (prop._is_in_effect()) {
    // What the plugin hides: AE's stored flag, then the parameter's
    // PF_PUI_INVISIBLE flag, all a synthesized parameter has.
    const tdsb = prop._tdsb;
    const stored_hidden = tdsb != null && !tdsb.synthetic && tdsb.hidden;
    if (stored_hidden && !_HIDDEN_BUT_EXPRESSIONABLE.has(mn)) {
      return false;
    }
    if (prop._expressions_disabled) {
      return false;
    }
    return !_NON_EXPRESSION_PARAM_TYPES.has(prop.propertyControlType);
  }

  if (pvt === PropertyValueType.LAYER_INDEX || pvt === PropertyValueType.CUSTOM_VALUE) {
    return false;
  }

  const layer = prop._containing_layer;
  const layer_type = layer._ldta.layer_type;

  // Parametric mesh layers have their own expression rules.
  if (layer_type === LayerType.PARAMETRIC_MESH) {
    const mesh_result = _can_set_expression_parametric_mesh(prop, layer, mn);
    if (mesh_result != null) {
      return mesh_result;
    }
  }

  if (_CANSETEXPR_FALSE_OVERRIDES.has(mn)) {
    return false;
  }

  // Camera layers cannot set expressions on Scale/Opacity
  if (layer_type === LayerType.CAMERA) {
    // Point of Interest (the camera's anchor point) is expressionable
    // only on a two-node camera (orient towards POI); a one-node camera
    // leaves the POI inactive (probed AE 2026). poi_auto_orient is the
    // ldta bit set for the two-node rig.
    if (mn === "ADBE Anchor Point") {
      return !!layer._ldta.poi_auto_orient;
    }
    return !_CAMERA_NO_EXPRESSION.has(mn);
  }

  // Light layers have complex rules depending on light type
  if (layer_type === LayerType.LIGHT) {
    return _can_set_expression_light(layer, mn);
  }

  const three_d = !!layer._ldta.three_d_layer;
  const renderer = layer.containingComp.renderer;

  if (
    layer_type === LayerType.THREE_D_MODEL &&
    _MODEL_LAYER_HIDDEN_MATERIALS.has(mn) &&
    parent != null &&
    parent.matchName === "ADBE Material Options Group"
  ) {
    return false;
  }

  // Until AE 23 a Classic 3D comp also shows these material options on a
  // 2D layer: AE 15.1, 22.5 and 23.6 report them expressible on one, AE
  // 24.6 and 26.0 do not. The file's version stands for the AE that saved it.
  if (
    (_MATERIAL_COEFFICIENTS.has(mn) || mn === "ADBE Light Transmission") &&
    renderer === _CLASSIC_3D &&
    get_ae_version_major(layer) <= 23
  ) {
    return true;
  }

  if (_CANSETEXPR_3D_ONLY.has(mn)) {
    return three_d;
  }

  // A mesh or model layer's own Shadow Color, under Compositing Options,
  // shows under every renderer (probed on AE 2026).
  if (
    mn === "ADBE Shadow Color" &&
    parent != null &&
    parent.matchName === "ADBE Compositing Options Group"
  ) {
    return true;
  }

  const only_under = _CANSETEXPR_RENDERER_3D_ONLY.get(mn) ?? null;
  if (only_under != null) {
    return three_d && renderer === only_under;
  }

  const classic_3d = three_d && renderer === _CLASSIC_3D;
  if (_CANSETEXPR_2D_ONLY.has(mn)) {
    return (
      layer.nullLayer ||
      layer_type === LayerType.THREE_D_MODEL ||
      layer_type === LayerType.PARAMETRIC_MESH ||
      !classic_3d
    );
  }

  if (_CANSETEXPR_EXTRUSION_DEPTHS.has(mn)) {
    return !(classic_3d && (layer_type === LayerType.TEXT || layer_type === LayerType.SHAPE));
  }

  // AE shows a stroke's miter limit only while it joins by miter.
  if (mn === "ADBE Vector Stroke Miter Limit" && parent != null) {
    const join = parent.property("ADBE Vector Stroke Line Join");
    return join.value === _MITER_JOIN;
  }

  return true;
}

/** Determine can_set_expression for a property on a light layer. */
export function _can_set_expression_light(layer: Layer, mn: string): boolean {
  if (_LIGHT_NO_EXPRESSION.has(mn)) {
    return false;
  }
  const light_type = layer._ldta.light_and_mesh_type;
  if (light_type === 3) {
    // AMBIENT
    return !_LIGHT_AMBIENT_NO_EXPRESSION.has(mn);
  }
  if (light_type === 1) {
    // SPOT
    return !_LIGHT_SPOT_NO_EXPRESSION.has(mn);
  }
  if (light_type === 0) {
    // PARALLEL
    return !_LIGHT_PARALLEL_NO_EXPRESSION.has(mn);
  }
  if (light_type === 4) {
    // ENVIRONMENT
    return !_LIGHT_ENVIRONMENT_NO_EXPRESSION.has(mn);
  }
  return !_LIGHT_POINT_NO_EXPRESSION.has(mn);
}

/**
 * Determine can_set_expression for a property on a parametric mesh layer.
 *
 * Returns a bool for mesh-specific rules, or `null` to fall through to
 * the generic (layer-type-agnostic) resolution. Rules verified against
 * AE 2026 ExtendScript (parametric_meshes.json):
 *
 * - A fixed set of streams is never expressionable (`Displacement Intensity`, the material texture-projection params).
 * - Mesh-option / bevel streams are expressionable only when they belong
 *   to the layer's ACTIVE mesh type; checkbox toggles (caps / invert
 *   slice) are expressionable regardless of active type.
 */
export function _can_set_expression_parametric_mesh(
  prop: Property,
  layer: Layer,
  mn: string,
): boolean | null {
  if (_PARAMETRIC_MESH_NO_EXPRESSION.has(mn)) {
    return false;
  }
  const parent = prop.parentProperty;
  const group_mn = parent != null ? parent.matchName : "";
  const group_type = _PARAMETRIC_MESH_GROUP_TYPE.get(group_mn) ?? null;
  if (group_type != null) {
    if (_PARAMETRIC_MESH_CHECKBOX_STREAMS.has(mn)) {
      return true;
    }
    return !!(group_type === layer._ldta.light_and_mesh_type);
  }
  return null;
}
