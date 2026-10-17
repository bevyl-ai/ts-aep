import { round } from "../../../pyrt/index.ts";
import { LdtaChunk } from "../../binary/layer_chunks.ts";
import { LayerType } from "../../enums/index.ts";
import { default_camera_zoom } from "../../resolvers/transform.ts";
import { label_index } from "../preferences.ts";
import { Layer, type LiveDefaultGroup, type LiveDefaultProperty } from "./layer.ts";
import type { CompItem } from "../items/composition.ts";
import type {EffectParamDefs} from "../descriptors.ts";


/**
 * The CameraLayer object represents a camera layer within a composition.
 *
 *
 * Info:
 *     `CameraLayer` is a subclass of {@link Layer} object. All methods and
 *     attributes of {@link Layer} are available when working with `CameraLayer`.
 *
 * @example
 * ```ts
 * import { parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const comp = app.project.compositions[0];
 * const camera = comp.camera_layers[0];
 * console.log(camera.name);
 * ```
 * @see https://ae-scripting.docsforadobe.dev/layer/cameralayer/
 */
export class CameraLayer extends Layer {
  static _auto_name: string = "Camera";
  static _fov_rad: number = (39.5978 * Math.PI) / 180;
  // AE's default 50mm camera: zoom = width / 0.72 exactly
  // (2 * tan(fov/2) rounds to 0.72; AE uses the exact ratio).
  static _zoom_dividend: number = 0.72;

  /** Always `true`: a camera / light layer only exists in 3D space.
   * Read-only. */
  get is_3d(): boolean {
    return true;
  }

  static _LIVE_DEFAULTS: ReadonlyArray<readonly [LiveDefaultGroup, LiveDefaultProperty]> = [
    ["ADBE Transform Group", "ADBE Position"],
    ["ADBE Camera Options Group", "ADBE Camera Zoom"],
    ["ADBE Camera Options Group", "ADBE Camera Focus Distance"],
  ];

  /**
   * AE's default Position: the camera's Zoom in front of the comp centre.
   *
   * It follows the Zoom at the layer's own time 0, pre-expression: AE
   * leaves a Position still there out of the file and places the camera
   * from that Zoom on open (measured on AE 2026, also after the Zoom was
   * keyframed or given an expression, and on a layer started, trimmed or
   * stretched away from the comp's time 0).
   */
  _default_position(): number[] {
    const comp = this.containing_comp;
    const options = this.property("ADBE Camera Options Group");
    const zoom = options.property("ADBE Camera Zoom");
    // The layer's time 0 is the comp time it starts at.
    const z = zoom.value_at_time(this.start_time);
    return [comp.width / 2.0, comp.height / 2.0, -z];
  }

  /** AE's default Zoom and Focus Distance: the comp's 50mm-lens zoom. */
  _default_zoom(): number {
    const comp = this.containing_comp;
    // AE rounds the zoom to 8 decimals before storing it.
    return round(default_camera_zoom(comp.width, comp.pixel_aspect), 8);
  }

  // Python `# type: ignore[override]`: keyword shape differs from Layer._new's.
  static _new(kw: {
    name: string;
    layer_id: number;
    duration: number;
    containing_comp: CompItem;
    effect_param_defs?: EffectParamDefs | null;
  }): CameraLayer;
  static _new(...args: never[]): never;
  static _new(kw: {
    name: string;
    layer_id: number;
    duration: number;
    containing_comp: CompItem;
    effect_param_defs?: EffectParamDefs | null;
  }): CameraLayer {
    const {
      name,
      layer_id,
      duration,
      containing_comp,
      effect_param_defs = null,
    } = kw;
    const name_cps = Array.from(name);
    const layer_name = name_cps.length > 31 ? name_cps.slice(0, 31).join("") : name;
    const ldta = new LdtaChunk({
      layer_id,
      label: label_index(
        containing_comp._project._preferences,
        "Camera Label Index 2",
        4,
      ),
      layer_type: LayerType.CAMERA,
      layer_flags_2: 0x01,
      layer_name,
    });
    ldta.out_point = duration;
    ldta.three_d_layer = true;
    return super._new<CameraLayer>({
      ldta,
      name,
      containing_comp,
      effect_param_defs,
    });
  }
}
