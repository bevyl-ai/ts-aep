/**
 * Property synthesis - single-pass post-processing for parsed layers.
 *
 * After binary parsing produces a raw property tree, this module runs one
 * pass over it to:
 *
 * * Set `defaultValue` on transform properties parsed from the binary.
 * * Synthesize missing transform properties (AE always exposes twelve).
 * * Reorder top-level layer groups to match the canonical ExtendScript order.
 * * Synthesize missing children in standard property groups
 *   (Material Options, Geometry Options, Layer Styles, Mask atoms, etc.).
 * * Set `minValue` / `maxValue` on properties with known bounds.
 *
 * The single public entry point is `synthesize_layer_properties`, called
 * once per layer when its property tree is built
 * (`Layer._build_property_tree`).
 *
 * **Note:** Effect parameter synthesis remains a separate dynamic step inside
 * `parse_effect()`, because it relies on binary parT/pard data rather
 * than static spec tables.
 */

import { getAeVersionMajor } from "../ae_version.ts";
import { AVLayer } from "../models/layers/av_layer.ts";
import { CameraLayer } from "../models/layers/camera_layer.ts";
import { LightLayer } from "../models/layers/light_layer.ts";
import { ParametricMeshLayer } from "../models/layers/parametric_mesh_layer.ts";
import { ShapeLayer } from "../models/layers/shape_layer.ts";
import { TextLayer } from "../models/layers/text_layer.ts";
import { ThreeDModelLayer } from "../models/layers/three_d_model_layer.ts";
import { Property } from "../models/properties/property.ts";
import { PropertyGroup, _applyBounds, _deriveLayerStylesEnabled, _reorderAndFill } from "../models/properties/property_group.ts";
import { _bindPointDefault } from "../parsers/effect.ts";
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
export function synthesizeChildren(group: PropertyGroup, aeMajor: number): void {
  if (group.matchName === "ADBE Layer Styles") {
    _deriveLayerStylesEnabled(group, aeMajor, { synthesizeSubgroups: false });
  }
  group._deferredAeMajor = aeMajor;
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
export function _synthesizeMissingTopLevelGroups(layer: Layer, aeMajor: number): void {
  let specs: ReadonlyArray<PropSpec | GroupSpec> = _TOP_LEVEL_SPECS;
  let skipGroups: ReadonlySet<string>;
  if (layer instanceof CameraLayer) {
    skipGroups = _SKIP_FOR_CAMERA;
  } else if (layer instanceof LightLayer) {
    skipGroups = _SKIP_FOR_LIGHT;
  } else if (!(layer instanceof AVLayer)) {
    return;
  } else if (layer instanceof TextLayer) {
    skipGroups = _SKIP_FOR_TEXT;
  } else if (layer instanceof ShapeLayer) {
    skipGroups = _SKIP_FOR_SHAPE;
  } else if (layer instanceof ParametricMeshLayer) {
    // Mesh layers expose a different group set AND order (Geometry
    // Options / Essential Properties after Material Assignment), so
    // they use their own full spec list instead of a skip set.
    specs = _PARAMETRIC_MESH_TOP_LEVEL_SPECS;
    skipGroups = new Set<string>();
  } else {
    // AVLayer
    skipGroups = _SKIP_FOR_REGULAR_AV;
  }

  _reorderAndFill(layer, specs, 1, { skip: skipGroups, tailMode: "all", aeMajor: aeMajor });

  // Post-processing: Layer Sets elided flag and depth fixup.
  const canonicalMns = new Set<string>(specs.map((s) => s.matchName));
  for (const child of layer.properties) {
    if (child.matchName === "ADBE Layer Sets") child._elided = true;
    if (child instanceof PropertyGroup && canonicalMns.has(child.matchName)) {
      child._propertyDepth = 1;
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
 * 1. Sets `defaultValue` on every transform property already parsed from
 *    the binary so that `Property.isModified` works correctly.
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
export function _setTransformDefaults(layer: Layer, aeMajor: number): void {
  const transform = layer.transform;
  if (transform == null) return;

  // Anchor Point is relative to the layer itself (source dimensions),
  // while Position is relative to the containing composition.
  const compW = layer.containingComp.width;
  const compH = layer.containingComp.height;
  let anchorW: number;
  let anchorH: number;
  let sourceBacked = false;
  if (layer instanceof AVLayer) {
    if (
      layer instanceof TextLayer ||
      layer instanceof ShapeLayer ||
      layer instanceof ParametricMeshLayer ||
      layer instanceof ThreeDModelLayer ||
      layer.nullLayer
    ) {
      // Source-less AVLayers: anchor defaults to origin. So does a 3D
      // model layer, whose anchor is in model space (AE 2026 reports
      // [0, 0, 0] for an untouched one).
      anchorW = 0;
      anchorH = 0;
    } else {
      // The centre of the source, at its current size: set by
      // `follow_source_anchor` below.
      anchorW = anchorH = 0;
      sourceBacked = true;
    }
  } else {
    anchorW = compW;
    anchorH = compH;
  }

  const position = layer._defaultPosition();

  // Spatial defaults depend on layer dimensions. The X / Y / Z followers
  // default to the leader's components: separating a camera or light
  // Position left at its default reads all three unmodified in AE 2026.
  const spatialDefaults = new Map<string, number[] | number>([
    ["ADBE Anchor Point", [anchorW / 2.0, anchorH / 2.0, 0.0]],
    ["ADBE Position", position],
    ["ADBE Position_0", position[0]],
    ["ADBE Position_1", position[1]],
    ["ADBE Position_2", position[2]],
  ]);

  // --- Phase 1: set default_value on properties parsed from binary --------
  const existing = new Map<string, Property>();
  for (const prop of transform.properties) {
    if (prop instanceof Property) {
      existing.set(prop.matchName, prop);
      // A 2-component Scale padded to 3 used to be handled here. AE
      // never writes one: probed on AE 2026, Scale reads back 3
      // components and ThreeD on a 2D layer as much as a 3D one, and
      // even `setValue([50, 50])` stores [50, 50, 100]. Every one of
      // the 12721 Scale properties in samples/ carries dimensions=3
      // from its own tdb4, so the padding never ran. (Half of it
      // could not have worked anyway: `propertyValueType` is a
      // plain property, so the `__dict__` write was discarded.)
      if (prop.defaultValue != null) continue; // already set (e.g. by effect param defs)
      let default_: number | number[] | null = _TRANSFORM_FIXED_DEFAULTS.get(prop.matchName) ?? null;
      if (default_ == null) default_ = spatialDefaults.get(prop.matchName) ?? null;
      if (default_ != null) {
        // When the parser stores a vector property as a scalar
        // (e.g. Orientation parsed as 0.0 instead of [0,0,0]),
        // coerce the default to match the actual value type.
        if (Array.isArray(default_) && !Array.isArray(prop.value)) {
          default_ = default_?.length > 0 ? default_[0] : 0.0;
        }
        prop.defaultValue = default_;
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
    const mn = spec.matchName;
    let default_: number | number[] | null = _TRANSFORM_FIXED_DEFAULTS.get(mn) ?? null;
    if (default_ == null) default_ = spatialDefaults.get(mn) ?? null;
    let value: number | number[] | null = _INACTIVE_FOLLOWER_VALUE.get(mn) ?? null;
    if (value == null) value = default_;
    if (value == null) value = spec.dimensions > 1 ? Array(spec.dimensions).fill(0.0) : 0.0;
    if (default_ == null) default_ = value;
    overrides.set(mn, [value, default_]);
  }

  _reorderAndFill(transform, _TRANSFORM_SPECS, 2, {
    valueOverrides: overrides,
    tailMode: "none",
    aeMajor: aeMajor,
  });

  // A null's Opacity defaults to 0: left out, it reads 0, while a written
  // 100 reads 100 (AE 2026, a file py writes too).
  if (layer instanceof AVLayer && layer.nullLayer) {
    const opacity = transform.property("ADBE Opacity");
    opacity.defaultValue = 0.0;
    if (!opacity._isLive()) {
      opacity._value = 0.0;
    }
  }

  if (sourceBacked) {
    followSourceAnchor(transform.property("ADBE Anchor Point"));
  }

  // --- Phase 3: context-dependent naming ----------------------------------
  applyDimensionalityNaming(layer);

  // Camera and Light layers show "Point of Interest" instead of
  // "Anchor Point" in the Transform group.
  if (layer instanceof CameraLayer || layer instanceof LightLayer) {
    const anchor = transform.property("ADBE Anchor Point");
    if (anchor != null) {
      anchor._autoName = "Point of Interest";
    }
  }

  // --- Phase 4: set min/max on transform properties -----------------------
  for (const child of transform.properties) {
    if (child instanceof Property) {
      _applyBounds(child);
    }
  }
}

/**
 * Read a source-backed layer's default Anchor Point - and the anchor
 * itself when left out - as the centre of the source at its current size.
 *
 * AE stores a footage, solid or precomp layer's anchor as a fraction of its
 * source (`Property._effect_scale`): measured on AE 2026, a left-out one
 * reads the new centre, unmodified, after `replaceSource`, a solid resize
 * or a precomp resize. An audio-only source has no pixels to scale by, so
 * the fraction reads as is: AE 2026 reports [0.5, 0.5, 0].
 */
export function followSourceAnchor(anchor: Property): void {
  const cdat = anchor._cdat;
  if (!anchor._isLive() && cdat != null) {
    cdat.values = [0.5, 0.5, 0.0];
    anchor._value = null;
  }
  _bindPointDefault(anchor, [50.0, 50.0, 0.0]);
}

/** One component of the vector `source` returns, read on each call. */
export function _component(source: () => number[], dim: number): () => number {
  return () => source()[dim];
}

/**
 * Make the defaults that follow other state read it changes.
 *
 * A layer's Position follows its comp's size, and a camera's its Zoom too;
 * a camera or light's Point of Interest follows the comp's centre; a
 * camera's Zoom and Focus Distance follow the comp's width and pixel
 * aspect. `Layer._write_out_moved_defaults` writes them once moved (AE
 * 2026 keeps a Point of Interest where it was, modified, on a resize).
 */
export function _followLiveDefaults(layer: Layer): void {
  const transform = layer.transform;
  const position = transform.property("ADBE Position");
  position._defaultValueSource = () => layer._defaultPosition();
  for (const dim of [0, 1, 2] as const) {
    const follower = transform.property(`ADBE Position_${dim}`);
    follower._defaultValueSource = _component(() => layer._defaultPosition(), dim);
  }
  if (layer instanceof CameraLayer || layer instanceof LightLayer) {
    const poi = transform.property("ADBE Anchor Point");
    poi._defaultValueSource = () => layer._compCentre();
  }
  if (layer instanceof CameraLayer) {
    const options = layer.property("ADBE Camera Options Group");
    for (const matchName of ["ADBE Camera Zoom", "ADBE Camera Focus Distance"] as const) {
      const prop = options.property(matchName);
      prop._defaultValueSource = () => layer._defaultZoom();
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
export function _flattenScaleZ(scaleProp: Property): void {
  if (scaleProp.keyframes?.length > 0) {
    for (const kf of scaleProp.keyframes) {
      const value = kf.value;
      if (Array.isArray(value) && value.length >= 3) {
        kf.value = [value[0], value[1], 100.0];
      }
    }
    return;
  }
  const current = scaleProp.value;
  if (Array.isArray(current) && current.length >= 3) {
    scaleProp.value = [current[0], current[1], 100.0];
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
 * `resetScaleZ` additionally writes the 100 into the chunk. A 2-D layer's
 * Scale Z is not masked but DEAD, and AE normalizes it away the moment it
 * touches the layer, in both directions (measured on AE 2026: a file whose
 * chunk held Z = 0.4 while 2-D came back holding 1.0 once the layer was
 * switched to 3-D, and every keyframe's Z with it; a Z of 40 set while 3-D
 * reads 100 once the layer is 2-D and still reads 100 on the way back).
 * Only the setter passes it - synthesis must not touch the bytes it is
 * describing.
 */
export function applyDimensionalityNaming(layer: Layer, kw: { resetScaleZ?: boolean } = {}): void {
  const { resetScaleZ: reset_scale_z = false } = kw;
  const transform = layer.transform;
  if (transform == null) return;
  const rotateZ = transform.property("ADBE Rotate Z");
  const scaleProp = transform.property("ADBE Scale");
  if (layer.is3d) {
    // _reorder_and_fill set _auto_name="Rotation" from the spec;
    // undo it so the sentinel _name_utf8 falls through to
    // MATCH_NAME_TO_AUTO_NAME -> "Z Rotation".
    if (rotateZ != null) {
      rotateZ._autoName = null;
    }
    if (reset_scale_z && scaleProp instanceof Property && scaleProp._scaleZOverride != null) {
      // The layer is arriving from 2-D, where its Z was dead. AE writes
      // the 100 it was showing into the chunk, so there is nothing left
      // to mask - and a later write to Z then actually sticks. Drop the
      // override FIRST or the write reads back its own 100 and no-ops.
      scaleProp._scaleZOverride = null;
      _flattenScaleZ(scaleProp);
    }
    return;
  }
  if (rotateZ != null) {
    rotateZ._autoName = "Rotation";
  }
  if (scaleProp instanceof Property) {
    if (reset_scale_z) {
      // Leaving 3-D discards the Z outright, keyframes included.
      scaleProp._scaleZOverride = null;
      _flattenScaleZ(scaleProp);
    }
    // For parsed properties (cdat path), _resolve_value applies
    // the override; for synthesized properties (_value path),
    // fix the user-facing value directly.
    scaleProp._scaleZOverride = 100.0;
    if (Array.isArray(scaleProp._value) && scaleProp._value.length >= 3) {
      scaleProp._value[2] = 100.0;
    }
    for (const kf of scaleProp.keyframes) {
      const raw = kf._extractRawValue();
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
 * Called once per layer when its property tree is built
 * (`Layer._build_property_tree`).
 *
 * @param layer - The layer whose property tree should be finalized.
 */
export function synthesizeLayerProperties(layer: Layer): void {
  const aeMajor: number = getAeVersionMajor(layer);

  // --- Synthesize missing top-level groups --------------------------------
  _synthesizeMissingTopLevelGroups(layer, aeMajor);

  // --- Synthesize children & apply min/max (single recursive pass) --------
  for (const group of layer.properties) {
    if (group instanceof PropertyGroup) {
      if (group.matchName === "ADBE Transform Group") {
        continue; // handled by _set_transform_defaults below
      }
      synthesizeChildren(group, aeMajor);
    } else if (group instanceof Property) {
      _applyBounds(group);
      // Time Remap max defaults to 0 when no _tduM chunk provides the
      // actual source duration.
      if (group.matchName === "ADBE Time Remapping" && group._tduM == null) {
        group._maxValueFallback = 0;
      }
    }
  }

  // After the pass: a camera's default Position reads its Zoom, which is
  // only synthesized (when AE left it out) once its group is registered.
  _setTransformDefaults(layer, aeMajor);
  _followLiveDefaults(layer);
}
