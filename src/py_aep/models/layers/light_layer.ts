import { LayerType, LightType } from "../../enums/index.ts";

import { LdtaChunk } from "../../binary/layer_chunks.ts";
import { default_camera_zoom } from "../../resolvers/transform.ts";
import {ChunkField, type EffectParamDefs} from "../descriptors.ts";
import { label_index } from "../preferences.ts";
import { AVLayer } from "./av_layer.ts";
import { _UNDEFINED_ID, Layer, _no_source_id, type LiveDefaultGroup, type LiveDefaultProperty } from "./layer.ts";
import { AttributeError, ValueError, descriptor, py_cmp } from "../../../pyrt/index.ts";
import type { CompItem } from "../items/composition.ts";

export function _require_environment_lights(comp: CompItem, what: string): void {
  /** Environment lights and their light source arrived in AE 24.3. */
  const head = comp._project._head;
  if (py_cmp([head.ae_version_major, head.ae_version_minor], [24, 3]) < 0) {
    throw new AttributeError(
      `${what} requires AE 24.3+ file format (file is AE ` +
        `${head.ae_version_major}.${head.ae_version_minor}).`,
    );
  }
}

export function _validate_light_type(value: number, obj: LightLayer): void {
  if (value === LightType.ENVIRONMENT) {
    _require_environment_lights(obj.containingComp, "LightType.ENVIRONMENT");
  }
}

/**
 * The `LightLayer` object represents a light layer within a composition.
 *
 * ```ts
 * import { parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const comp = app.project.compositions[0];
 * const light = comp.lightLayers[0];
 * console.log(light.lightType);
 * ```
 *
 * Info:
 * `LightLayer` is a subclass of {@link Layer} object. All methods and
 * attributes of {@link Layer} are available when working with `LightLayer`.
 *
 * @example
 * @see https://ae-scripting.docsforadobe.dev/layer/lightlayer/
 */
export class LightLayer extends Layer {
  static _auto_name: string = "Light";
  static _fov_rad: number = (39.5978 * Math.PI) / 180;
  // AE's default 50mm camera: zoom = width / 0.72 exactly
  // (2 * tan(fov/2) rounds to 0.72; AE uses the exact ratio).
  static _zoom_dividend: number = 0.72;

  static _LIVE_DEFAULTS: ReadonlyArray<readonly [LiveDefaultGroup, LiveDefaultProperty]> = [
    ...Layer._LIVE_DEFAULTS,
    ["ADBE Transform Group", "ADBE Anchor Point"],
  ];

  /** Always `true`: a camera / light layer only exists in 3D space.
   * Read-only. */
  get is3d(): boolean {
    return true;
  }

  /** AE's default Position: up, right and in front of the comp centre,
   * at fixed fractions of the comp's default camera zoom rather than any
   * camera's. Measured on AE 2026 for every light type, at 1920x1080,
   * 1440x1620, 2880x810, 810x1440 and a 2:1 pixel aspect. */
  _default_position(): number[] {
    const comp = this.containingComp;
    const zoom = default_camera_zoom(comp.width, comp.pixelAspect);
    return [
      comp.width / 2.0 + 0.03 * zoom,
      comp.height / 2.0 - 0.03 * zoom,
      -zoom / 4.0,
    ];
  }

  /** The type of light. Read / Write. */
  declare lightType: LightType;

  /** The ID of the layer used as a light source. `0` if none. */
  declare _light_source_id: number;

  static _new(kw: {
    name: string;
    layer_id: number;
    duration: number;
    containing_comp: CompItem;
    light_type?: number;
    effect_param_defs?: EffectParamDefs | null;
  }): LightLayer;
  static _new(...args: never[]): never;
  static _new(kw: {
    name: string;
    layer_id: number;
    duration: number;
    containing_comp: CompItem;
    light_type?: number;
    effect_param_defs?: EffectParamDefs | null;
  }): LightLayer {
    // NOTE(port): Python `# type: ignore[override]` is type-only; the `never` overload above keeps Layer._new's signatures uncallable.
    const {
      name,
      layer_id,
      duration,
      containing_comp,
      light_type = 1,
      effect_param_defs = null,
    } = kw;
    const name_cps = Array.from(name);
    const layer_name = name_cps.length > 31 ? name_cps.slice(0, 31).join("") : name;
    const ldta = new LdtaChunk({
      layer_id: layer_id,
      source_id: _no_source_id(containing_comp),
      label: label_index(
        containing_comp._project._preferences,
        "Light Label Index 2",
        6,
      ),
      layer_type: LayerType.LIGHT,
      light_and_mesh_type: light_type,
      layer_flags_2: 0x01,
      layer_name: layer_name,
    });
    ldta.out_point = duration;
    ldta.three_d_layer = true;
    return super._new<LightLayer>({
      ldta: ldta,
      name: name,
      containing_comp: containing_comp,
      effect_param_defs: effect_param_defs,
    });
  }

  /**
   * The layer used as a light source when `light_type` is
   * `LightType.ENVIRONMENT`. Returns `null` if no source is assigned.
   * Read / Write.
   *
   * The light source can be any 2D video, still, pre-composition, text
   * or shape layer in the same composition. Like After Effects 2026,
   * assigning a camera or light, a null, an adjustment or a 3D layer, a
   * layer of another composition, or a source on a spot or point light
   * raises `ValueError`.
   *
   * **Warning:** 
   * Added in After Effects 24.3.
   */
  get lightSource(): Layer | null {
    if (this._light_source_id === 0) {
      return null;
    }
    return this.containingComp.layersById.get(this._light_source_id) ?? null;
  }

  set lightSource(value: Layer | null) {
    const comp = this.containingComp;
    if (value == null) {
      this._ldta.source_id = _no_source_id(comp);
      return;
    }
    _require_environment_lights(comp, "light_source");

    if (!(value instanceof Layer)) {
      throw new ValueError("lightSource must be a Layer or None");
    }
    if (!(value instanceof AVLayer)) {
      throw new ValueError("Can't set a non-AV layer as a light source.");
    }
    if (value.containingComp !== comp) {
      throw new ValueError("lightSource must be a layer in the same composition");
    }
    if (this.lightType === LightType.SPOT || this.lightType === LightType.POINT) {
      // AE 2026 refuses these two ("Invalid light source specified")
      // and stores a source on a parallel light.
      throw new ValueError(
        "Invalid light source specified for a spot or point light.",
      );
    }
    if (value.threeDLayer || value.nullLayer || value.adjustmentLayer) {
      throw new ValueError(
        "Invalid light source specified: 3D, null and adjustment layers " +
          "cannot be used as a light source.",
      );
    }
    this._light_source_id = value.id;
  }
}

descriptor(
  LightLayer,
  "lightType",
  ChunkField.enum(LightType, "_ldta", "light_and_mesh_type", {
    validate: _validate_light_type,
  }),
);

descriptor(
  LightLayer,
  "_light_source_id",
  new ChunkField("_ldta", "source_id", {
    transform: (v: number) => (v === _UNDEFINED_ID ? 0 : v),
    reverse: (v: number) => (v === 0 ? _UNDEFINED_ID : v),
  }),
);
