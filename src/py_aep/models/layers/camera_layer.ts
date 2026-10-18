import { round } from "../../../pyrt/index.ts";
import { LdtaChunk } from "../../binary/layer_chunks.ts";
import { LayerType } from "../../enums/index.ts";
import { defaultCameraZoom } from "../../resolvers/transform.ts";
import { labelIndex } from "../preferences.ts";
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
 * const camera = comp.cameraLayers[0];
 * console.log(camera.name);
 * ```
 * @see https://ae-scripting.docsforadobe.dev/layer/cameralayer/
 */
export class CameraLayer extends Layer {
  static _autoName: string = "Camera";
  static _fovRad: number = (39.5978 * Math.PI) / 180;
  // AE's default 50mm camera: zoom = width / 0.72 exactly
  // (2 * tan(fov/2) rounds to 0.72; AE uses the exact ratio).
  static _zoomDividend: number = 0.72;

  /** Always `true`: a camera / light layer only exists in 3D space.
   * Read-only. */
  get is3d(): boolean {
    return true;
  }

  static _LIVE_DEFAULTS: ReadonlyArray<readonly [LiveDefaultGroup, LiveDefaultProperty]> = [
    ...Layer._LIVE_DEFAULTS,
    ["ADBE Transform Group", "ADBE Anchor Point"],
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
  _defaultPosition(): number[] {
    const comp = this.containingComp;
    const options = this.property("ADBE Camera Options Group");
    const zoom = options.property("ADBE Camera Zoom");
    // The layer's time 0 is the comp time it starts at.
    const z = zoom.valueAtTime(this.startTime);
    return [comp.width / 2.0, comp.height / 2.0, -z];
  }

  /** AE's default Zoom and Focus Distance: the comp's 50mm-lens zoom. */
  _defaultZoom(): number {
    const comp = this.containingComp;
    // AE rounds the zoom to 8 decimals before storing it.
    return round(defaultCameraZoom(comp.width, comp.pixelAspect), 8);
  }

  // Python `# type: ignore[override]`: keyword shape differs from Layer._new's.
  static _new(kw: {
    name: string;
    layerId: number;
    duration: number;
    containingComp: CompItem;
    effectParamDefs?: EffectParamDefs | null;
  }): CameraLayer;
  static _new(...args: never[]): never;
  static _new(kw: {
    name: string;
    layerId: number;
    duration: number;
    containingComp: CompItem;
    effectParamDefs?: EffectParamDefs | null;
  }): CameraLayer {
    const {
      name,
      layerId: layer_id,
      duration,
      containingComp: containing_comp,
      effectParamDefs: effect_param_defs = null,
    } = kw;
    const nameCps = Array.from(name);
    const layerName = nameCps.length > 31 ? nameCps.slice(0, 31).join("") : name;
    const ldta = new LdtaChunk({
      layer_id,
      label: labelIndex(
        containing_comp._project._preferences,
        "Camera Label Index 2",
        4,
      ),
      layer_type: LayerType.CAMERA,
      layer_flags_2: 0x01,
      layer_name: layerName,
    });
    ldta.out_point = duration;
    ldta.three_d_layer = true;
    return super._new<CameraLayer>({
      ldta,
      name,
      containingComp: containing_comp,
      effectParamDefs: effect_param_defs,
    });
  }
}
