/**
 * Property synthesis - single-pass post-processing for parsed layers.
 *
 * After binary parsing produces a raw property tree, this module runs one
 * pass over it to:
 *
 * * Set `default_value` on transform properties parsed from the binary.
 * * Synthesize missing transform properties (AE always exposes twelve).
 * * Reorder top-level layer groups to match the canonical ExtendScript order.
 * * Synthesize missing children in standard property groups
 *   (Material Options, Geometry Options, Layer Styles, Mask atoms, etc.).
 * * Set `min_value` / `max_value` on properties with known bounds.
 *
 * The single public entry point is `synthesize_layer_properties`, called
 * once per layer at the end of `parse_layer`.
 *
 * **Note:** Effect parameter synthesis remains a separate dynamic step inside
 * `parse_effect()`, because it relies on binary parT/pard data rather
 * than static spec tables.
 */

import { get_ae_version_major } from "../ae_version.ts";
import { AVLayer } from "../models/layers/av_layer.ts";
import { CameraLayer } from "../models/layers/camera_layer.ts";
import { LightLayer } from "../models/layers/light_layer.ts";
import { ParametricMeshLayer } from "../models/layers/parametric_mesh_layer.ts";
import { ShapeLayer } from "../models/layers/shape_layer.ts";
import { TextLayer } from "../models/layers/text_layer.ts";
import { ThreeDModelLayer } from "../models/layers/three_d_model_layer.ts";
import { Property } from "../models/properties/property.ts";
import { PropertyGroup, _apply_bounds, _derive_layer_styles_enabled, _reorder_and_fill } from "../models/properties/property_group.ts";
import { _PARAMETRIC_MESH_TOP_LEVEL_SPECS, _SKIP_FOR_CAMERA, _SKIP_FOR_LIGHT, _SKIP_FOR_REGULAR_AV, _SKIP_FOR_SHAPE, _SKIP_FOR_TEXT, _TOP_LEVEL_SPECS, _TRANSFORM_FIXED_DEFAULTS, _TRANSFORM_SPECS } from "./property.ts";
import type { GroupSpec, PropSpec } from "./property.ts";
import type { Layer } from "../models/layers/layer.ts";

// ---------------------------------------------------------------------------
// Recursive child synthesis + bounds application (single pass)
// ---------------------------------------------------------------------------

/**
 * Register deferred child synthesis for a group.
 *
 * Child groups and leaf min/max bounds are synthesized when the group's
 * `properties` are first accessed. Layer Styles keeps its collapsed
 * `enabled` state eagerly derived to preserve existing behavior.
 */
export function synthesize_children(group: PropertyGroup, ae_major: number): void {
  if (group.match_name === "ADBE Layer Styles") {
    _derive_layer_styles_enabled(group, ae_major, { synthesize_subgroups: false });
  }
  group._deferred_ae_major = ae_major;
}

// ---------------------------------------------------------------------------
// Top-level group synthesis
// ---------------------------------------------------------------------------

/**
 * Add missing top-level property groups expected by ExtendScript.
 *
 * ExtendScript always reports a fixed set of top-level property groups
 * on every AV layer, even when most are empty.  The binary only stores
 * groups that contain data.  This function synthesizes the missing empty
 * groups and reorders all groups to match the canonical ExtendScript order.
 */
export function _synthesize_missing_top_level_groups(layer: Layer, ae_major: number): void {
  let specs: ReadonlyArray<PropSpec | GroupSpec> = _TOP_LEVEL_SPECS;
  let skip_groups: ReadonlySet<string>;
  if (layer instanceof CameraLayer) {
    skip_groups = _SKIP_FOR_CAMERA;
  } else if (layer instanceof LightLayer) {
    skip_groups = _SKIP_FOR_LIGHT;
  } else if (!(layer instanceof AVLayer)) {
    return;
  } else if (layer instanceof TextLayer) {
    skip_groups = _SKIP_FOR_TEXT;
  } else if (layer instanceof ShapeLayer) {
    skip_groups = _SKIP_FOR_SHAPE;
  } else if (layer instanceof ParametricMeshLayer) {
    // Mesh layers expose a different group set AND order (Geometry
    // Options / Essential Properties after Material Assignment), so
    // they use their own full spec list instead of a skip set.
    specs = _PARAMETRIC_MESH_TOP_LEVEL_SPECS;
    skip_groups = new Set<string>();
  } else {
    // AVLayer
    skip_groups = _SKIP_FOR_REGULAR_AV;
  }

  _reorder_and_fill(layer, specs, 1, { skip: skip_groups, tail_mode: "all", ae_major });

  // Post-processing: Layer Sets elided flag and depth fixup.
  const canonical_mns = new Set<string>(specs.map((s) => s.match_name));
  for (const child of layer.properties) {
    if (child.match_name === "ADBE Layer Sets") child._elided = true;
    if (child instanceof PropertyGroup && canonical_mns.has(child.match_name)) {
      child._property_depth = 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Transform defaults
// ---------------------------------------------------------------------------

/**
 * Assign defaults and synthesize missing transform properties.
 *
 * After Effects always exposes twelve transform properties via ExtendScript
 * regardless of whether the layer is 2-D or 3-D.  The binary format, however,
 * only stores properties relevant to the current layer state.  This function:
 *
 * 1. Sets `default_value` on every transform property already parsed from
 *    the binary so that `Property.is_modified` works correctly.
 * 2. Creates `Property` objects for any of the twelve canonical properties
 *    that are absent from the binary.
 * 3. Re-orders `transform.properties` to match the canonical ExtendScript
 *    order.
 * 4. Applies context-dependent naming (Rotation vs Z Rotation, Point of
 *    Interest vs Anchor Point).
 * 5. Applies min/max bounds on transform leaf properties.
 *
 * Spatial defaults (Anchor Point, Position, and the X / Y / Z separated
 * followers) depend on layer dimensions - and a camera or light's Position
 * on a camera zoom - and are computed here; all other defaults are fixed
 * constants defined in `_TRANSFORM_FIXED_DEFAULTS`.
 */
export function _set_transform_defaults(layer: Layer, ae_major: number): void {
  const transform = layer.transform;
  if (transform == null) return;

  // Anchor Point is relative to the layer itself (source dimensions),
  // while Position is relative to the containing composition.
  const comp_w = layer.containing_comp.width;
  const comp_h = layer.containing_comp.height;
  let anchor_w: number;
  let anchor_h: number;
  if (layer instanceof AVLayer) {
    if (
      layer instanceof TextLayer ||
      layer instanceof ShapeLayer ||
      layer instanceof ParametricMeshLayer ||
      layer instanceof ThreeDModelLayer ||
      layer.null_layer
    ) {
      // Source-less AVLayers: anchor defaults to origin. So does a 3D
      // model layer, whose anchor is in model space (AE 2026 reports
      // [0, 0, 0] for an untouched one).
      anchor_w = 0;
      anchor_h = 0;
    } else {
      anchor_w = layer.width;
      anchor_h = layer.height;
    }
  } else {
    anchor_w = comp_w;
    anchor_h = comp_h;
  }

  let position: number[] = [comp_w / 2.0, comp_h / 2.0, 0.0];
  if (layer instanceof CameraLayer || layer instanceof LightLayer) {
    position = layer._default_position();
  }

  // Spatial defaults depend on layer dimensions. The X / Y / Z followers
  // default to the leader's components: separating a camera or light
  // Position left at its default reads all three unmodified in AE 2026.
  const spatial_defaults = new Map<string, number[] | number>([
    ["ADBE Anchor Point", [anchor_w / 2.0, anchor_h / 2.0, 0.0]],
    ["ADBE Position", position],
    ["ADBE Position_0", position[0]],
    ["ADBE Position_1", position[1]],
    ["ADBE Position_2", position[2]],
  ]);

  // --- Phase 1: set default_value on properties parsed from binary --------
  const existing = new Map<string, Property>();
  for (const prop of transform.properties) {
    if (prop instanceof Property) {
      existing.set(prop.match_name, prop);
      // A 2-component Scale padded to 3 used to be handled here. AE
      // never writes one: probed on AE 2026, Scale reads back 3
      // components and ThreeD on a 2D layer as much as a 3D one, and
      // even `setValue([50, 50])` stores [50, 50, 100]. Every one of
      // the 12721 Scale properties in samples/ carries dimensions=3
      // from its own tdb4, so the padding never ran. (Half of it
      // could not have worked anyway: `property_value_type` is a
      // plain property, so the `__dict__` write was discarded.)
      if (prop.default_value != null) continue; // already set (e.g. by effect param defs)
      let default_: number | number[] | null = _TRANSFORM_FIXED_DEFAULTS.get(prop.match_name) ?? null;
      if (default_ == null) default_ = spatial_defaults.get(prop.match_name) ?? null;
      if (default_ != null) {
        // When the parser stores a vector property as a scalar
        // (e.g. Orientation parsed as 0.0 instead of [0,0,0]),
        // coerce the default to match the actual value type.
        if (Array.isArray(default_) && !Array.isArray(prop.value)) {
          default_ = default_?.length > 0 ? default_[0] : 0.0;
        }
        prop.default_value = default_;
      }
    }
  }

  // --- Phase 2: synthesize missing properties & reorder -------------------
  // Match names whose synthesized `value` is 0.0 (inactive separation
  // followers) while their `default` comes from spatial_defaults.
  const _INACTIVE_FOLLOWER_VALUE = new Map<string, number>([
    ["ADBE Position_0", 0.0],
    ["ADBE Position_1", 0.0],
    ["ADBE Position_2", 0.0],
  ]);

  const overrides = new Map<string, [number | number[], number | number[]]>();
  for (const spec of _TRANSFORM_SPECS) {
    const mn = spec.match_name;
    let default_: number | number[] | null = _TRANSFORM_FIXED_DEFAULTS.get(mn) ?? null;
    if (default_ == null) default_ = spatial_defaults.get(mn) ?? null;
    let value: number | number[] | null = _INACTIVE_FOLLOWER_VALUE.get(mn) ?? null;
    if (value == null) value = default_;
    if (value == null) value = spec.dimensions > 1 ? Array(spec.dimensions).fill(0.0) : 0.0;
    if (default_ == null) default_ = value;
    overrides.set(mn, [value, default_]);
  }

  _reorder_and_fill(transform, _TRANSFORM_SPECS, 2, {
    value_overrides: overrides,
    tail_mode: "none",
    ae_major,
  });

  // For null layers where opacity was already parsed from binary,
  // override the value to 0 (matching ExtendScript behavior).
  if (layer instanceof AVLayer && layer.null_layer) {
    const opacity = transform.property("ADBE Opacity");
    if (opacity instanceof Property && opacity.value === 100.0) {
      opacity._value = 0.0;
      opacity.default_value = 0.0;
    }
  }

  // --- Phase 3: context-dependent naming ----------------------------------
  apply_dimensionality_naming(layer);

  // Camera and Light layers show "Point of Interest" instead of
  // "Anchor Point" in the Transform group.
  if (layer instanceof CameraLayer || layer instanceof LightLayer) {
    const anchor = transform.property("ADBE Anchor Point");
    if (anchor != null) {
      anchor._auto_name = "Point of Interest";
    }
  }

  // --- Phase 4: set min/max on transform properties -----------------------
  for (const child of transform.properties) {
    if (child instanceof Property) {
      _apply_bounds(child);
    }
  }
}

/** One component of the vector `source` returns, read on each call. */
export function _component(source: () => number[], dim: number): () => number {
  return () => source()[dim];
}

/**
 * Make the defaults that follow other state read it as it changes.
 *
 * A camera or light's Position follows its comp's size, and a camera's its
 * Zoom too; a camera's Zoom and Focus Distance follow the comp's width and
 * pixel aspect. `Layer._write_out_moved_defaults` writes them once moved.
 */
export function _follow_live_defaults(layer: CameraLayer | LightLayer): void {
  const transform = layer.transform;
  const position = transform.property("ADBE Position");
  position._default_value_source = () => layer._default_position();
  for (const dim of [0, 1, 2] as const) {
    const follower = transform.property(`ADBE Position_${dim}`);
    follower._default_value_source = _component(() => layer._default_position(), dim);
  }
  if (layer instanceof CameraLayer) {
    const options = layer.property("ADBE Camera Options Group");
    for (const match_name of ["ADBE Camera Zoom", "ADBE Camera Focus Distance"] as const) {
      const prop = options.property(match_name);
      prop._default_value_source = () => layer._default_zoom();
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Write Scale Z = 100 through to the chunks, static value and keyframes.
 *
 * A 2-D layer's Z is dead data; AE normalizes it to 100 whenever it touches
 * the layer rather than leaving a stale number behind.
 */
export function _flatten_scale_z(scale_prop: Property): void {
  if (scale_prop.keyframes?.length > 0) {
    for (const kf of scale_prop.keyframes) {
      const value = kf.value;
      if (Array.isArray(value) && value.length >= 3) {
        kf.value = [value[0], value[1], 100.0];
      }
    }
    return;
  }
  const current = scale_prop.value;
  if (Array.isArray(current) && current.length >= 3) {
    scale_prop.value = [current[0], current[1], 100.0];
  }
}

/**
 * Apply the transform state that depends on the layer's dimensionality.
 *
 * ExtendScript displays `ADBE Rotate Z` as "Rotation" on a 2-D layer and
 * "Z Rotation" on a 3-D one, and always reports Scale Z as 100 for a 2-D
 * layer whatever the binary holds. Camera and Light layers are always 3-D.
 *
 * Called from synthesis and again whenever `three_d_layer` is written -
 * AE 2026 renames in both directions the moment the switch is toggled.
 *
 * `reset_scale_z` additionally writes the 100 into the chunk. A 2-D layer's
 * Scale Z is not masked but DEAD, and AE normalizes it away the moment it
 * touches the layer, in both directions (measured on AE 2026: a file whose
 * chunk held Z = 0.4 while 2-D came back holding 1.0 once the layer was
 * switched to 3-D, and every keyframe's Z with it; a Z of 40 set while 3-D
 * reads 100 once the layer is 2-D and still reads 100 on the way back).
 * Only the setter passes it - synthesis must not touch the bytes it is
 * describing.
 */
export function apply_dimensionality_naming(layer: Layer, kw: { reset_scale_z?: boolean } = {}): void {
  const { reset_scale_z = false } = kw;
  const transform = layer.transform;
  if (transform == null) return;
  const rotate_z = transform.property("ADBE Rotate Z");
  const scale_prop = transform.property("ADBE Scale");
  if (layer.is_3d) {
    // _reorder_and_fill set _auto_name="Rotation" from the spec;
    // undo it so the sentinel _name_utf8 falls through to
    // MATCH_NAME_TO_AUTO_NAME -> "Z Rotation".
    if (rotate_z != null) {
      rotate_z._auto_name = null;
    }
    if (reset_scale_z && scale_prop instanceof Property && scale_prop._scale_z_override != null) {
      // The layer is arriving from 2-D, where its Z was dead. AE writes
      // the 100 it was showing into the chunk, so there is nothing left
      // to mask - and a later write to Z then actually sticks. Drop the
      // override FIRST or the write reads back its own 100 and no-ops.
      scale_prop._scale_z_override = null;
      _flatten_scale_z(scale_prop);
    }
    return;
  }
  if (rotate_z != null) {
    rotate_z._auto_name = "Rotation";
  }
  if (scale_prop instanceof Property) {
    if (reset_scale_z) {
      // Leaving 3-D discards the Z outright, keyframes included.
      scale_prop._scale_z_override = null;
      _flatten_scale_z(scale_prop);
    }
    // For parsed properties (cdat path), _resolve_value applies
    // the override; for synthesized properties (_value path),
    // fix the user-facing value directly.
    scale_prop._scale_z_override = 100.0;
    if (Array.isArray(scale_prop._value) && scale_prop._value.length >= 3) {
      scale_prop._value[2] = 100.0;
    }
    for (const kf of scale_prop.keyframes) {
      const raw = kf._extract_raw_value();
      if (Array.isArray(raw) && raw.length >= 3) {
        kf._value = raw;
        kf._value[2] = 1.0;
      }
    }
  }
}

/**
 * Run the full post-parse property synthesis pass on a layer.
 *
 * This is the single entry point for all static property enrichment:
 * transform defaults, top-level group ordering, recursive child
 * synthesis, and min/max bounds application.
 *
 * Called once per layer at the end of `parse_layer`.
 *
 * @param layer - The layer whose property tree should be finalized.
 */
export function synthesize_layer_properties(layer: Layer): void {
  const ae_major: number = get_ae_version_major(layer);

  // --- Synthesize missing top-level groups --------------------------------
  _synthesize_missing_top_level_groups(layer, ae_major);

  // --- Synthesize children & apply min/max (single recursive pass) --------
  for (const group of layer.properties) {
    if (group instanceof PropertyGroup) {
      if (group.match_name === "ADBE Transform Group") {
        continue; // handled by _set_transform_defaults below
      }
      synthesize_children(group, ae_major);
    } else if (group instanceof Property) {
      _apply_bounds(group);
      // Time Remap max defaults to 0 when no _tduM chunk provides the
      // actual source duration.
      if (group.match_name === "ADBE Time Remapping" && group._tduM == null) {
        group._max_value_fallback = 0;
      }
    }
  }

  // After the pass: a camera's default Position reads its Zoom, which is
  // only synthesized (when AE left it out) once its group is registered.
  _set_transform_defaults(layer, ae_major);
  if (layer instanceof CameraLayer || layer instanceof LightLayer) {
    _follow_live_defaults(layer);
  }
}
