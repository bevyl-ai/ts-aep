/** Tests for Layer model parsing. */

import { describe, expect, test } from "bun:test";
import {
  AttributeError,
  len,
  NotImplementedError,
  at,
  Path,
  py_assert,
  py_eq,
  range,
  getitem,
  setdefault,
  py_slice,
  isclose,
  RuntimeError,
  StopIteration,
  ValueError,
} from "../../src/pyrt/index.ts";
import { approx, make_tmp_path, raises, skip } from "../../src/pyrt/pytest.ts";
import * as py_aep from "../../src/py_aep/index.ts";
import { parse as parse_aep } from "../../src/py_aep/index.ts";
import { AutoOrientType, BlendingMode, FrameBlendingType, KeyframeInterpolationType, Label, LayerQuality, LayerSamplingQuality, LightType, TrackMatteType } from "../../src/py_aep/enums/index.ts";
import { AVLayer, LightLayer, ShapeLayer, TextLayer } from "../../src/py_aep/models/layers/index.ts";
import type { Layer } from "../../src/py_aep/models/layers/index.ts";
import { ThreeDModelLayer } from "../../src/py_aep/models/layers/three_d_model_layer.ts";
import { AVItem, CompItem, FootageItem } from "../../src/py_aep/models/items/index.ts";
import type { Project } from "../../src/py_aep/models/project.ts";
import { DeferredListChunk, ListChunk } from "../../src/py_aep/binary/chunk.ts";
import { TdmnChunk } from "../../src/py_aep/binary/property_chunks.ts";
import { S4Chunk } from "../../src/py_aep/binary/scalar_chunks.ts";
import "../../src/py_aep/binary/_register.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";
import { SolidSource } from "../../src/py_aep/models/sources/solid.ts";
import { as_instance, get_comp, get_first_layer, get_layer, parse_project_fresh, project_bytes } from "../helpers.ts";

const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "layer");
const BUGS_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "bugs");
const VERSIONS_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "versions");

/**
 * Collect tdpi values in a layer block, keyed by the owning param's
 * tdmn suffix (`-0000` internal vs `-0001` value param).
 */
function _tdpi_by_param_suffix(layer: Layer): Map<string, number[]> {
  // Python imports ListChunk locally here; the TS twin imports it at module level.
  const result = new Map<string, number[]>();

  function walk(lst: ListChunk): void {
    const chunks = lst.chunks;
    for (const [i, c] of chunks.entries()) {
      if (c.chunk_type === "tdmn" && i + 1 < chunks.length) {
        const body = chunks[i + 1];
        if (body instanceof ListChunk) {
          for (const inner of body.chunks) {
            if (inner.chunk_type === "tdpi") {
              setdefault(result, py_slice(as_instance(c, TdmnChunk).value, -5, null), []).push(as_instance(inner, S4Chunk).value);
            }
          }
        }
      }
      if (c instanceof ListChunk) walk(c);
    }
  }

  walk(layer._layer_list);
  return result;
}

describe("TestLightSource", () => {
  /** Tests for LightLayer.light_source. */

  test("test_light_source_default_is_none", () => {
    const project = parse_project_fresh(SAMPLES_DIR.div("light_source_default.aep"));
    const layer = as_instance(get_first_layer(project), LightLayer);
    expect(layer.light_source == null).toBe(true);
  });

  test("test_light_source_mov", () => {
    const project = parse_project_fresh(SAMPLES_DIR.div("light_source_mov_23_976.mov.aep"));
    const layer = as_instance(get_first_layer(project), LightLayer);
    expect(layer.light_source != null).toBe(true);
    const light_source = as_instance(layer.light_source, AVLayer);
    expect(light_source.name).toBe("mov_23_976.mov");
  });

  test("test_light_source_set_none", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("light_source_mov_23_976.mov.aep"));
    const layer = as_instance(get_first_layer(project), LightLayer);
    expect(layer.light_source != null).toBe(true);

    layer.light_source = null;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const layer2 = as_instance(get_first_layer(parse_aep(out).project), LightLayer);
    expect(layer2.light_source == null).toBe(true);
  });

  test("test_light_source_set_none_before_ae_23", () => {
    // AE 22 stores no light source as 0 (0xFFFFFFFF from AE 23).
    const project = py_aep.new("22.5x53").project;
    const comp = project.root_folder.add_comp("Comp", 100, 100, 1.0, 1.0, 24.0);
    const light = comp.add_light("Light", [50, 50]);
    light.light_source = null;
    expect(light._ldta.source_id).toBe(0);
  });

  test("test_light_source_rejects_3d_layer", () => {
    const project = parse_aep(SAMPLES_DIR.div("light_source_mov_23_976.mov.aep")).project;
    const light = project.compositions[0].light_layers[0];
    expect(light instanceof LightLayer).toBe(true);
    const source = as_instance(light.light_source, AVLayer);

    source.three_d_layer = true;
    raises(ValueError, () => {
      light.light_source = source;
    }, "Invalid light source specified");
  });
});

describe("TestRoundtripLightType", () => {
  /** Roundtrip tests for LightLayer.light_type. */

  test("test_modify_light_type_to_spot", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("lightType.aep"));
    const layer = as_instance(get_layer(project, "lightType_AMBIENT"), LightLayer);
    expect(layer.light_type).toBe(LightType.AMBIENT);

    layer.light_type = LightType.SPOT;
    const out = tmp_path.div("modified_light_type.aep");
    project.save(out);
    const layer2 = as_instance(get_layer(parse_aep(out).project, "lightType_AMBIENT"), LightLayer);
    expect(layer2.light_type).toBe(LightType.SPOT);
  });

  test("test_modify_light_type_to_point", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("lightType.aep"));
    const layer = as_instance(get_layer(project, "lightType_SPOT"), LightLayer);
    expect(layer.light_type).toBe(LightType.SPOT);

    layer.light_type = LightType.POINT;
    const out = tmp_path.div("modified_light_type_point.aep");
    project.save(out);
    const layer2 = as_instance(get_layer(parse_aep(out).project, "lightType_SPOT"), LightLayer);
    expect(layer2.light_type).toBe(LightType.POINT);
  });

  test("test_modify_light_type_to_parallel", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("lightType.aep"));
    const layer = as_instance(get_layer(project, "lightType_POINT"), LightLayer);
    expect(layer.light_type).toBe(LightType.POINT);

    layer.light_type = LightType.PARALLEL;
    const out = tmp_path.div("modified_light_type_parallel.aep");
    project.save(out);
    const layer2 = as_instance(get_layer(parse_aep(out).project, "lightType_POINT"), LightLayer);
    expect(layer2.light_type).toBe(LightType.PARALLEL);
  });

  test("test_light_type_validation_rejects_invalid", () => {
    const project = parse_project_fresh(SAMPLES_DIR.div("lightType.aep"));
    const layer = get_layer(project, "lightType_AMBIENT");
    expect(layer instanceof LightLayer).toBe(true);
    raises(ValueError, () => {
      // @ts-expect-error type: ignore[assignment] in Python: the value is deliberately invalid.
      as_instance(layer, LightLayer).light_type = 9999;
    }, "Invalid value");
  });
});

describe("TestRoundtripLayerFlags", () => {
  /** Roundtrip tests for Layer chunk-backed boolean flags. */

  test("test_modify_locked", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("layer_switches.aep"));
    const layer = get_layer(project, "locked_true");
    expect(layer.locked).toBe(true);

    layer.locked = false;
    const out = tmp_path.div("modified_locked.aep");
    project.save(out);
    const layer2 = get_layer(parse_aep(out).project, "locked_true");
    expect(layer2.locked).toBe(false);
  });

  test("test_modify_shy", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("layer_switches.aep"));
    const layer = get_layer(project, "shy_true");
    expect(layer.shy).toBe(true);

    layer.shy = false;
    const out = tmp_path.div("modified_shy.aep");
    project.save(out);
    const layer2 = get_layer(parse_aep(out).project, "shy_true");
    expect(layer2.shy).toBe(false);
  });

  test("test_modify_solo", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("layer_switches.aep"));
    const layer = get_layer(project, "solo_true");
    expect(layer.solo).toBe(true);

    layer.solo = false;
    const out = tmp_path.div("modified_solo.aep");
    project.save(out);
    const layer2 = get_layer(parse_aep(out).project, "solo_true");
    expect(layer2.solo).toBe(false);
  });
});

describe("TestRoundtripAVLayerFlags", () => {
  /** Roundtrip tests for AVLayer chunk-backed flags. */

  test("test_modify_blending_mode", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("blendingMode.aep"));
    const layer = as_instance(get_layer(project, "blendingMode_ADD"), AVLayer);
    expect(layer.blending_mode).toBe(BlendingMode.ADD);

    layer.blending_mode = BlendingMode.MULTIPLY;
    const out = tmp_path.div("modified_blending.aep");
    project.save(out);
    const layer2 = as_instance(get_layer(parse_aep(out).project, "blendingMode_ADD"), AVLayer);
    expect(layer2.blending_mode).toBe(BlendingMode.MULTIPLY);
  });

  test("test_dancing_dissolve_roundtrip", () => {
    // Dancing Dissolve has no transfer-mode value of its own - AE stores it
    // as Dissolve plus a flag bit in the ldta. Round-tripping exercises both
    // the write (set the bit) and read (recover DANCING_DISSOLVE) paths.
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("blendingMode.aep"));
    const layer = as_instance(get_layer(project, "blendingMode_ADD"), AVLayer);

    layer.blending_mode = BlendingMode.DANCING_DISSOLVE;
    const out = tmp_path.div("dancing.aep");
    project.save(out);
    const layer2 = as_instance(get_layer(parse_aep(out).project, "blendingMode_ADD"), AVLayer);
    expect(layer2.blending_mode).toBe(BlendingMode.DANCING_DISSOLVE);
  });

  test("test_dancing_dissolve_independent_of_preserve_transparency", () => {
    // The dancing flag and preserve-underlying-transparency share one ldta
    // byte (bits 1 and 0). Setting one must not disturb the other.
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("blendingMode.aep"));
    const layer = as_instance(get_layer(project, "blendingMode_ADD"), AVLayer);
    layer.blending_mode = BlendingMode.DANCING_DISSOLVE;
    layer.preserve_transparency = true;
    const out = tmp_path.div("dancing_pt.aep");
    project.save(out);
    const layer2 = as_instance(get_layer(parse_aep(out).project, "blendingMode_ADD"), AVLayer);
    expect(layer2.blending_mode).toBe(BlendingMode.DANCING_DISSOLVE);
    expect(layer2.preserve_transparency).toBe(true);
    // Switching to a non-Dissolve mode clears only the dancing flag.
    layer2.blending_mode = BlendingMode.NORMAL;
    expect(layer2.preserve_transparency).toBe(true);
  });

  test("test_modify_three_d_layer", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("avlayer_flags.aep"));
    const layer = as_instance(get_layer(project, "threeDLayer_true"), AVLayer);
    expect(layer.three_d_layer).toBe(true);

    layer.three_d_layer = false;
    const out = tmp_path.div("modified_3d.aep");
    project.save(out);
    const layer2 = as_instance(get_layer(parse_aep(out).project, "threeDLayer_true"), AVLayer);
    expect(layer2.three_d_layer).toBe(false);
  });

  test("test_environment_layer_makes_a_3d_layer_2d", () => {
    /**
     * AE 2026 turns the 3D switch off, as a toggle does (contrary to
     * the Scripting Guide, which says the layer becomes 3D).
     */
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("avlayer_flags.aep"));
    const layer = as_instance(get_layer(project, "threeDLayer_true"), AVLayer);
    expect(layer.environment_layer).toBe(false);

    layer.environment_layer = true;
    expect(layer.three_d_layer).toBe(false);
    expect(layer.transform.property("ADBE Rotate Z").name).toBe("Rotation");

    const out = tmp_path.div("modified_env.aep");
    project.save(out);
    const layer2 = as_instance(get_layer(parse_aep(out).project, "threeDLayer_true"), AVLayer);
    expect(layer2.environment_layer).toBe(true);
    expect(layer2.three_d_layer).toBe(false);
  });

  test("test_environment_layer_leaves_a_2d_layer_alone", () => {
    /** AE 2026 keeps a 2D layer 2D and its dead Scale Z in the file. */
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("light_source_default.aep"));
    const layer = as_instance(get_comp(project, "crystal").layers[1], AVLayer);
    expect(layer.three_d_layer).toBe(false);
    layer.transform.property("ADBE Scale").value = [50.0, 60.0, 40.0];

    layer.environment_layer = true;
    expect(layer.three_d_layer).toBe(false);

    const out = tmp_path.div("env_2d.aep");
    project.save(out);
    const scale = get_comp(parse_aep(out).project, "crystal").layers[1].transform.property("ADBE Scale");
    expect(py_eq(scale.value, [50.0, 60.0, 100.0])).toBe(true);
    const raw = scale._read_cdat_raw();
    expect(Array.isArray(raw) && approx(raw[2], 0.4)).toBe(true);
  });

  test("test_three_d_layer_keeps_environment_layer", () => {
    /**
     * AE 2026: both switches on after `environmentLayer` then
     * `threeDLayer`.
     */
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("avlayer_flags.aep"));
    const layer = as_instance(get_layer(project, "threeDLayer_true"), AVLayer);

    layer.environment_layer = true;
    layer.three_d_layer = true;
    expect(layer.environment_layer).toBe(true);

    const out = tmp_path.div("modified_3d_env.aep");
    project.save(out);
    const layer2 = as_instance(get_layer(parse_aep(out).project, "threeDLayer_true"), AVLayer);
    expect(layer2.three_d_layer).toBe(true);
    expect(layer2.environment_layer).toBe(true);
  });
});

describe("TestRoundtripAutoOrient", () => {
  /** Roundtrip tests for Layer.auto_orient. */

  test("test_modify_along_path_to_no_auto_orient", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("autoOrient.aep"));
    const layer = get_layer(project, "autoOrient_ALONG_PATH");
    expect(layer.auto_orient).toBe(AutoOrientType.ALONG_PATH);

    layer.auto_orient = AutoOrientType.NO_AUTO_ORIENT;
    const out = tmp_path.div("modified_auto_orient.aep");
    project.save(out);
    const layer2 = get_layer(parse_aep(out).project, "autoOrient_ALONG_PATH");
    expect(layer2.auto_orient).toBe(AutoOrientType.NO_AUTO_ORIENT);
  });

  test("test_modify_no_auto_orient_to_along_path", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("inPoint.aep"));
    const layer = get_layer(project, "inPoint_5");
    expect(layer.auto_orient).toBe(AutoOrientType.NO_AUTO_ORIENT);

    layer.auto_orient = AutoOrientType.ALONG_PATH;
    const out = tmp_path.div("modified_auto_orient.aep");
    project.save(out);
    const layer2 = get_layer(parse_aep(out).project, "inPoint_5");
    expect(layer2.auto_orient).toBe(AutoOrientType.ALONG_PATH);
  });
});

describe("TestRoundtripComment", () => {
  /** Roundtrip tests for Layer.comment. */

  test("test_modify_comment", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("layer_misc.aep"));
    const layer = get_layer(project, "comment");
    expect(layer.comment).not.toBe("");

    layer.comment = "modified comment";
    const out = tmp_path.div("modified_comment.aep");
    project.save(out);
    const layer2 = get_layer(parse_aep(out).project, "comment");
    expect(layer2.comment).toBe("modified comment");
  });
});

describe("TestRoundtripInOutPoint", () => {
  /** Roundtrip tests for Layer.in_point and Layer.out_point. */

  test("test_modify_in_point", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("inPoint.aep"));
    const layer = get_layer(project, "inPoint_5");
    const original_in = layer.in_point;

    const new_in = original_in + 1.0;
    layer.in_point = new_in;
    const out = tmp_path.div("modified_in_point.aep");
    project.save(out);
    const layer2 = get_layer(parse_aep(out).project, "inPoint_5");
    expect(Math.abs(layer2.in_point - new_in) < 0.001).toBe(true);
  });

  test("test_modify_out_point", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("inPoint.aep"));
    const layer = get_layer(project, "inPoint_5");
    const original_out = layer.out_point;

    const new_out = original_out - 1.0;
    layer.out_point = new_out;
    const out = tmp_path.div("modified_out_point.aep");
    project.save(out);
    const layer2 = get_layer(parse_aep(out).project, "inPoint_5");
    expect(Math.abs(layer2.out_point - new_out) < 0.001).toBe(true);
  });
});

describe("TestRoundtripCommentCreate", () => {
  /** Roundtrip tests for Layer.comment when cmta chunk is absent. */

  test("test_create_comment_from_empty", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("inPoint.aep"));
    const layer = get_layer(project, "inPoint_5");
    expect(layer.comment).toBe("");

    layer.comment = "new comment";
    const out = tmp_path.div("created_comment.aep");
    project.save(out);
    const layer2 = get_layer(parse_aep(out).project, "inPoint_5");
    expect(layer2.comment).toBe("new comment");
  });
});

describe("TestRoundtripFramePoints", () => {
  /** Roundtrip tests for frame_in_point, frame_out_point, frame_start_time. */

  test("test_modify_frame_in_point", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("inPoint.aep"));
    const layer = get_layer(project, "inPoint_5");

    layer.frame_in_point = 10;
    const out = tmp_path.div("modified_frame_in_point.aep");
    project.save(out);
    const layer2 = get_layer(parse_aep(out).project, "inPoint_5");
    expect(layer2.frame_in_point).toBe(10);
  });

  test("test_modify_frame_out_point", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("inPoint.aep"));
    const layer = get_layer(project, "inPoint_5");

    layer.frame_out_point = 20;
    const out = tmp_path.div("modified_frame_out_point.aep");
    project.save(out);
    const layer2 = get_layer(parse_aep(out).project, "inPoint_5");
    expect(layer2.frame_out_point).toBe(20);
  });

  test("test_modify_frame_start_time", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("inPoint.aep"));
    const layer = get_layer(project, "inPoint_5");

    layer.frame_start_time = 5;
    const out = tmp_path.div("modified_frame_start_time.aep");
    project.save(out);
    const layer2 = get_layer(parse_aep(out).project, "inPoint_5");
    expect(layer2.frame_start_time).toBe(5);
  });
});

describe("TestRoundtripFrameBlendingType", () => {
  /** Roundtrip tests for AVLayer.frame_blending_type. */

  test("test_no_blend_to_frame_mix", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("frameBlendingType.aep"));
    const layer = as_instance(get_layer(project, "frameBlendingType_NO_FRAME_BLEND"), AVLayer);
    expect(layer.frame_blending_type).toBe(FrameBlendingType.NO_FRAME_BLEND);
    expect(layer.frame_blending).toBe(false);

    layer.frame_blending_type = FrameBlendingType.FRAME_MIX;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const layer2 = as_instance(get_layer(parse_aep(out).project, "frameBlendingType_NO_FRAME_BLEND"), AVLayer);
    expect(layer2.frame_blending_type).toBe(FrameBlendingType.FRAME_MIX);
    expect(layer2.frame_blending).toBe(true);
  });

  test("test_frame_mix_to_pixel_motion", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("frameBlendingType.aep"));
    const layer = as_instance(get_layer(project, "frameBlendingType_FRAME_MIX"), AVLayer);
    expect(layer.frame_blending_type).toBe(FrameBlendingType.FRAME_MIX);

    layer.frame_blending_type = FrameBlendingType.PIXEL_MOTION;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const layer2 = as_instance(get_layer(parse_aep(out).project, "frameBlendingType_FRAME_MIX"), AVLayer);
    expect(layer2.frame_blending_type).toBe(FrameBlendingType.PIXEL_MOTION);
  });

  test("test_pixel_motion_to_no_blend", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("frameBlendingType.aep"));
    const layer = as_instance(get_layer(project, "frameBlendingType_PIXEL_MOTION"), AVLayer);
    expect(layer.frame_blending_type).toBe(FrameBlendingType.PIXEL_MOTION);

    layer.frame_blending_type = FrameBlendingType.NO_FRAME_BLEND;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const layer2 = as_instance(get_layer(parse_aep(out).project, "frameBlendingType_PIXEL_MOTION"), AVLayer);
    expect(layer2.frame_blending_type).toBe(FrameBlendingType.NO_FRAME_BLEND);
    expect(layer2.frame_blending).toBe(false);
  });
});

describe("TestRoundtripTimeRemapEnabled", () => {
  /** Roundtrip tests for AVLayer.time_remap_enabled. */

  test("test_disable_time_remap", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("outPoint_no_clamp.aep"));
    const layer = as_instance(get_layer(project, "outPoint_no_clamp_timeRemap"), AVLayer);
    expect(layer.time_remap_enabled).toBe(true);

    layer.time_remap_enabled = false;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const layer2 = as_instance(get_layer(parse_aep(out).project, "outPoint_no_clamp_timeRemap"), AVLayer);
    expect(layer2.time_remap_enabled).toBe(false);
  });

  test("test_enable_time_remap", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("outPoint_no_clamp.aep"));
    const layer = as_instance(get_layer(project, "outPoint_no_clamp_timeRemap"), AVLayer);

    layer.time_remap_enabled = false;
    const out = tmp_path.div("disabled.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const layer2 = as_instance(get_layer(project2, "outPoint_no_clamp_timeRemap"), AVLayer);
    expect(layer2.time_remap_enabled).toBe(false);

    layer2.time_remap_enabled = true;
    const out2 = tmp_path.div("re_enabled.aep");
    project2.save(out2);
    const layer3 = as_instance(get_layer(parse_aep(out2).project, "outPoint_no_clamp_timeRemap"), AVLayer);
    expect(layer3.time_remap_enabled).toBe(true);
  });
});

describe("TestRoundtripLayerEnabled", () => {
  /** Roundtrip tests for Layer.enabled. */

  test("test_modify_enabled", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("layer_switches.aep"));
    const layer = get_layer(project, "enabled_false");
    expect(layer.enabled).toBe(false);

    layer.enabled = true;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const layer2 = get_layer(parse_aep(out).project, "enabled_false");
    expect(layer2.enabled).toBe(true);
  });
});

describe("TestRoundtripLayerLabel", () => {
  /** Roundtrip tests for Layer.label. */

  test("test_modify_label", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("layer_misc.aep"));
    const layer = get_layer(project, "label_3");
    expect(layer.label).toBe(Label.AQUA);

    layer.label = Label.RED;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const layer2 = get_layer(parse_aep(out).project, "label_3");
    expect(layer2.label).toBe(Label.RED);
  });
});

describe("TestRoundtripLayerStretch", () => {
  /** Roundtrip tests for Layer.stretch. */

  test("test_modify_stretch", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("layer_timing.aep"));
    const layer = get_layer(project, "stretch_200");
    expect(isclose(layer.stretch, 200.0)).toBe(true);

    layer.stretch = 150.0;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const layer2 = get_layer(parse_aep(out).project, "stretch_200");
    expect(isclose(layer2.stretch, 150.0)).toBe(true);
  });
});

describe("TestRoundtripAVLayerBoolFlags", () => {
  /** Roundtrip tests for remaining AVLayer boolean flags. */

  test("test_modify_adjustment_layer", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("avlayer_flags.aep"));
    const layer = as_instance(get_layer(project, "adjustmentLayer_true"), AVLayer);
    expect(layer.adjustment_layer).toBe(true);

    layer.adjustment_layer = false;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const layer2 = get_layer(parse_aep(out).project, "adjustmentLayer_true");
    expect(layer2 instanceof AVLayer).toBe(true);
    expect(layer2.adjustment_layer).toBe(false);
  });

  test("test_modify_audio_enabled", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("audioEnabled.aep"));
    const layer = as_instance(get_layer(project, "audioEnabled_false"), AVLayer);
    expect(layer.audio_enabled).toBe(false);

    layer.audio_enabled = true;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const layer2 = as_instance(get_layer(parse_aep(out).project, "audioEnabled_false"), AVLayer);
    expect(layer2.audio_enabled).toBe(true);
  });

  test("test_modify_collapse_transformation", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("avlayer_flags.aep"));
    const layer = as_instance(get_layer(project, "collapseTransformation_true"), AVLayer);
    expect(layer.collapse_transformation).toBe(true);

    layer.collapse_transformation = false;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const layer2 = as_instance(get_layer(parse_aep(out).project, "collapseTransformation_true"), AVLayer);
    expect(layer2.collapse_transformation).toBe(false);
  });

  test("test_modify_effects_active", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("avlayer_flags.aep"));
    const layer = as_instance(get_layer(project, "effectsActive_false"), AVLayer);
    expect(layer.effects_active).toBe(false);

    layer.effects_active = true;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const layer2 = as_instance(get_layer(parse_aep(out).project, "effectsActive_false"), AVLayer);
    expect(layer2.effects_active).toBe(true);
  });

  test("test_modify_guide_layer", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("avlayer_flags.aep"));
    const layer = as_instance(get_layer(project, "guideLayer_true"), AVLayer);
    expect(layer.guide_layer).toBe(true);

    layer.guide_layer = false;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const layer2 = as_instance(get_layer(parse_aep(out).project, "guideLayer_true"), AVLayer);
    expect(layer2.guide_layer).toBe(false);
  });

  test("test_modify_motion_blur", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("avlayer_flags.aep"));
    const layer = as_instance(get_layer(project, "motionBlur_true"), AVLayer);
    expect(layer.motion_blur).toBe(true);

    layer.motion_blur = false;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const layer2 = as_instance(get_layer(parse_aep(out).project, "motionBlur_true"), AVLayer);
    expect(layer2.motion_blur).toBe(false);
  });

  test("test_modify_preserve_transparency", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("avlayer_flags.aep"));
    const layer = as_instance(get_layer(project, "preserveTransparency_true"), AVLayer);
    expect(layer.preserve_transparency).toBe(true);

    layer.preserve_transparency = false;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const layer2 = as_instance(get_layer(parse_aep(out).project, "preserveTransparency_true"), AVLayer);
    expect(layer2.preserve_transparency).toBe(false);
  });
});

describe("TestRoundtripAVLayerQuality", () => {
  /** Roundtrip tests for AVLayer.quality and sampling_quality. */

  test("test_modify_quality", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("quality.aep"));
    const layer = as_instance(get_layer(project, "quality_BEST"), AVLayer);
    expect(layer.quality).toBe(LayerQuality.BEST);

    layer.quality = LayerQuality.DRAFT;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const layer2 = as_instance(get_layer(parse_aep(out).project, "quality_BEST"), AVLayer);
    expect(layer2.quality).toBe(LayerQuality.DRAFT);
  });

  test("test_modify_sampling_quality", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("avlayer_flags.aep"));
    const layer = as_instance(get_layer(project, "samplingQuality_BICUBIC"), AVLayer);
    expect(layer.sampling_quality).toBe(LayerSamplingQuality.BICUBIC);

    layer.sampling_quality = LayerSamplingQuality.BILINEAR;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const layer2 = as_instance(get_layer(parse_aep(out).project, "samplingQuality_BICUBIC"), AVLayer);
    expect(layer2.sampling_quality).toBe(LayerSamplingQuality.BILINEAR);
  });
});

describe("TestRoundtripThreeDPerChar", () => {
  /** Roundtrip tests for AVLayer.three_d_per_char. */

  test("test_modify_three_d_per_char", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("threeDPerChar_on.aep"));
    const layer = as_instance(get_first_layer(project), AVLayer);
    expect(layer.three_d_per_char).toBe(true);

    layer.three_d_per_char = false;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const layer2 = as_instance(get_first_layer(parse_aep(out).project), AVLayer);
    expect(layer2.three_d_per_char).toBe(false);
  });
});

describe("TestRoundtripTrackMatteType", () => {
  /** Roundtrip tests for AVLayer.track_matte_type. */

  test("test_modify_track_matte_type", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("trackMatteType.aep"));
    const comp = get_comp(project, "trackMatteType_ALPHA");
    // Track matte layer is the one with ALPHA matte
    let matte_layer = null;
    for (const layer of comp.layers) {
      if (layer instanceof AVLayer && layer.track_matte_type === TrackMatteType.ALPHA) {
        matte_layer = layer;
        break;
      }
    }
    expect(matte_layer != null).toBe(true);
    if (matte_layer == null) throw new Error("no alpha-matte layer in comp");

    matte_layer.track_matte_type = TrackMatteType.LUMA;
    const out = tmp_path.div("modified.aep");
    project.save(out);

    const comp2 = get_comp(parse_aep(out).project, "trackMatteType_ALPHA");
    let matte_layer2 = null;
    for (const layer of comp2.layers) {
      if (layer instanceof AVLayer && layer.track_matte_type === TrackMatteType.LUMA) {
        matte_layer2 = layer;
        break;
      }
    }
    expect(matte_layer2 != null).toBe(true);
  });
});

describe("TestRoundtripLayerName", () => {
  /** Roundtrip: modify Layer.name and verify save/reload. */

  test("test_modify_layer_name", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("layer_misc.aep"));
    const layer = get_layer(project, "name_renamed");
    expect(layer.name).toBe("RenamedLayer");

    layer.name = "NewName";
    const out = tmp_path.div("modified_name.aep");
    project.save(out);

    const layer2 = get_layer(parse_project_fresh(out), "name_renamed");
    expect(layer2.name).toBe("NewName");
  });

  test("test_set_name_on_source_layer", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("layer_misc.aep"));
    const layer = get_layer(project, "comment");
    expect(layer.is_name_set).toBe(false);

    layer.name = "CustomName";
    const out = tmp_path.div("set_name.aep");
    project.save(out);

    const layer2 = get_layer(parse_project_fresh(out), "comment");
    expect(layer2.name).toBe("CustomName");
    expect(layer2.is_name_set).toBe(true);
  });
});

describe("TestSetTrackMatte", () => {
  /** Tests for AVLayer.set_track_matte(). */

  test("test_basic", () => {
    /** Assign ALPHA track matte on a file that has none. */
    const app = parse_aep(SAMPLES_DIR.div("track_matte_no.aep"));
    const comp = app.project.compositions[0];
    const matted = as_instance(comp.layers[0], AVLayer);
    const matte = as_instance(comp.layers[1], AVLayer);

    matted.set_track_matte(matte, TrackMatteType.ALPHA);

    expect(matted.track_matte_type).toBe(TrackMatteType.ALPHA);
    expect(matted._matte_layer_id).toBe(matte.id);
    expect(matted.track_matte_layer).toBe(matte);
    expect(matte.enabled).toBe(false);
  });

  test("test_roundtrip", () => {
    const tmp_path = make_tmp_path();
    /** Set matte, save, reparse, verify persisted. */
    const app = parse_aep(SAMPLES_DIR.div("track_matte_no.aep"));
    const comp = app.project.compositions[0];
    const matted = as_instance(comp.layers[0], AVLayer);
    const matte = as_instance(comp.layers[1], AVLayer);

    matted.set_track_matte(matte, TrackMatteType.LUMA);
    app.project.save(tmp_path.div("out.aep"));

    const app2 = parse_aep(tmp_path.div("out.aep"));
    const comp2 = app2.project.compositions[0];
    const matted2 = as_instance(comp2.layers[0], AVLayer);
    const matte2 = comp2.layers[1];

    expect(matted2.track_matte_type).toBe(TrackMatteType.LUMA);
    expect(matted2._matte_layer_id).toBe(matte2.id);
    expect(matte2.enabled).toBe(false);
  });

  test("test_replaces_existing", () => {
    /** Switching matte re-enables the old matte layer. */
    const app = parse_aep(SAMPLES_DIR.div("trackMatteType.aep"));
    const comp = get_comp(app.project, "trackMatteType_ALPHA");
    const matted = as_instance(comp.layers[0], AVLayer);
    const old_matte = as_instance(comp.layers[1], AVLayer);
    expect(old_matte.enabled).toBe(false);

    // Switch to LUMA with the same matte layer (type changes only)
    matted.set_track_matte(old_matte, TrackMatteType.LUMA);
    expect(matted.track_matte_type).toBe(TrackMatteType.LUMA);
    // Matte stays disabled since it's still the matte
    expect(old_matte.enabled).toBe(false);
  });

  test("test_none_clears_ref", () => {
    /** Passing None clears matte_layer_id but preserves the type. */
    const app = parse_aep(SAMPLES_DIR.div("track_matte_yes.aep"));
    const comp = app.project.compositions[0];
    const matted = as_instance(comp.layers[0], AVLayer);
    const matte = as_instance(comp.layers[1], AVLayer);
    expect(matte.enabled).toBe(false);

    matted.set_track_matte(null, TrackMatteType.ALPHA);

    expect(matted.track_matte_type).toBe(TrackMatteType.ALPHA);
    expect(matted._matte_layer_id).toBe(0);
    expect(matted.track_matte_layer == null).toBe(true);
    // Old matte re-enabled
    expect(matte.enabled).toBe(true);
  });

  test("test_noop_with_no_track_matte", () => {
    /** NO_TRACK_MATTE + non-None layer is a no-op. */
    const app = parse_aep(SAMPLES_DIR.div("track_matte_no.aep"));
    const comp = app.project.compositions[0];
    const matted = as_instance(comp.layers[0], AVLayer);
    const matte = as_instance(comp.layers[1], AVLayer);
    const original_type = matted.track_matte_type;

    matted.set_track_matte(matte, TrackMatteType.NO_TRACK_MATTE);

    expect(matted.track_matte_type).toBe(original_type);
    expect(matted._matte_layer_id).toBe(0);
    expect(matte.enabled).toBe(true);
  });

  test("test_pre_ae23_raises", () => {
    /** Files older than AE 23 don't have matte_layer_id. */
    const app = parse_aep(VERSIONS_DIR.div("ae2022", "complete.aep"));
    const comp = app.project.compositions[0];
    const layer = as_instance(comp.layers[0], AVLayer);

    raises(AttributeError, () => {
      layer.set_track_matte(layer, TrackMatteType.ALPHA);
    }, "AE 23");
  });

  test("test_wrong_comp_raises", () => {
    /** Matte layer from a different comp raises ValueError. */
    const app = parse_aep(SAMPLES_DIR.div("trackMatteType.aep"));
    const comp_a = get_comp(app.project, "trackMatteType_ALPHA");
    const comp_l = get_comp(app.project, "trackMatteType_LUMA");
    const matted = as_instance(comp_a.layers[0], AVLayer);
    const foreign = as_instance(comp_l.layers[1], AVLayer);

    raises(ValueError, () => {
      matted.set_track_matte(foreign, TrackMatteType.ALPHA);
    }, "same composition");
  });
});

describe("TestRemoveTrackMatte", () => {
  /** Tests for AVLayer.remove_track_matte(). */

  test("test_basic", () => {
    /** Remove matte reference and re-enable the matte layer. */
    const app = parse_aep(SAMPLES_DIR.div("track_matte_yes.aep"));
    const comp = app.project.compositions[0];
    const matted = as_instance(comp.layers[0], AVLayer);
    const matte = as_instance(comp.layers[1], AVLayer);
    expect(matte.enabled).toBe(false);

    matted.remove_track_matte();

    expect(matted._matte_layer_id).toBe(0);
    expect(matted.track_matte_layer == null).toBe(true);
    expect(matte.enabled).toBe(true);
  });

  test("test_preserves_type", () => {
    /** track_matte_type stays after removing the matte. */
    const app = parse_aep(SAMPLES_DIR.div("track_matte_yes.aep"));
    const comp = app.project.compositions[0];
    const matted = as_instance(comp.layers[0], AVLayer);
    expect(matted.track_matte_type).toBe(TrackMatteType.ALPHA);

    matted.remove_track_matte();

    expect(matted.track_matte_type).toBe(TrackMatteType.ALPHA);
  });

  test("test_roundtrip", () => {
    const tmp_path = make_tmp_path();
    /** Remove matte, save, reparse. */
    const app = parse_aep(SAMPLES_DIR.div("track_matte_yes.aep"));
    const comp = app.project.compositions[0];
    as_instance(comp.layers[0], AVLayer).remove_track_matte();
    app.project.save(tmp_path.div("out.aep"));

    const app2 = parse_aep(tmp_path.div("out.aep"));
    const comp2 = app2.project.compositions[0];
    expect(as_instance(comp2.layers[0], AVLayer)._matte_layer_id).toBe(0);
    expect(comp2.layers[1].enabled).toBe(true);
  });

  test("test_pre_ae23_raises", () => {
    /** Files older than AE 23 raise AttributeError. */
    const app = parse_aep(VERSIONS_DIR.div("ae2022", "complete.aep"));
    const comp = app.project.compositions[0];
    raises(AttributeError, () => {
      as_instance(comp.layers[0], AVLayer).remove_track_matte();
    }, "AE 23");
  });
});

describe("TestReplaceSource", () => {
  /** Tests for AVLayer.replace_source(). */

  test("test_basic", () => {
    /** Swap source and verify the new source is returned. */
    const app = parse_aep(VERSIONS_DIR.div("ae2025", "complete.aep"));
    const comp = get_comp(app.project, "Main_Comp");
    const layer = as_instance(comp.layers[0], AVLayer); // first AVLayer
    const old_source = layer.source;
    // Pick any other footage item as new source
    const new_source = as_instance(app.project.footages.find((item) => item !== old_source), FootageItem);

    layer.replace_source(new_source);

    expect(layer.source).toBe(new_source);
    expect(layer._source_id).toBe(new_source.id);
  });

  test("test_roundtrip", () => {
    const tmp_path = make_tmp_path();
    /** Replace source, save, reparse, verify. */
    const app = parse_aep(VERSIONS_DIR.div("ae2025", "complete.aep"));
    const comp = get_comp(app.project, "Main_Comp");
    const layer = as_instance(comp.layers[0], AVLayer);
    const new_source = as_instance(app.project.footages.find((item) => item !== layer.source), FootageItem);
    const new_id = new_source.id;

    layer.replace_source(new_source);
    app.project.save(tmp_path.div("out.aep"));

    const app2 = parse_aep(tmp_path.div("out.aep"));
    const comp2 = get_comp(app2.project, "Main_Comp");
    expect(as_instance(comp2.layers[0], AVLayer)._source_id).toBe(new_id);
  });

  test("test_updates_used_in", () => {
    /** _used_in back-references are updated. */
    const app = parse_aep(VERSIONS_DIR.div("ae2025", "complete.aep"));
    const comp = get_comp(app.project, "Main_Comp");
    const layer = as_instance(comp.layers[0], AVLayer);
    const old_source = as_instance(layer.source, AVItem);
    const new_source = as_instance(
      app.project.footages.find((item) => item !== old_source && "_used_in" in item),
      FootageItem,
    );

    layer.replace_source(new_source);

    expect(new_source._used_in.has(comp)).toBe(true);
    // old_source removed if no other layer in comp uses it
    const still_used = comp.layers.some(
      (ly) => "_source_id" in ly && ly !== layer && ly._source_id === old_source.id,
    );
    if (!still_used) {
      expect(old_source._used_in.has(comp)).toBe(false);
    }
  });

  test("test_fix_expressions_raises", () => {
    /** fix_expressions=True raises NotImplementedError. */
    const app = parse_aep(VERSIONS_DIR.div("ae2025", "complete.aep"));
    const comp = get_comp(app.project, "Main_Comp");
    const layer = as_instance(comp.layers[0], AVLayer);
    const source = app.project.footages[0];

    raises(NotImplementedError, () => {
      layer.replace_source(source, true);
    }, "fix_expressions");
  });

  test("test_not_in_project_raises", () => {
    /** Source not in project.items raises ValueError. */
    const app = parse_aep(VERSIONS_DIR.div("ae2025", "complete.aep"));
    const comp = get_comp(app.project, "Main_Comp");
    const layer = as_instance(comp.layers[0], AVLayer);

    class _FakeItem {
      id = 999999;
      name = "ghost";
    }

    raises(ValueError, () => {
      // @ts-expect-error a non-AVItem source is deliberately passed to the runtime check
      layer.replace_source(new _FakeItem());
    }, "must be an AVItem");
  });

  test("test_sourceless_layer_raises", () => {
    /** Shape/text layers (source=None) cannot have their source replaced. */
    const project = parse_project_fresh(SAMPLES_DIR.div("type.aep"));
    const layer = as_instance(get_layer(project, "type_shape"), ShapeLayer);
    expect(layer.source == null).toBe(true);

    raises(ValueError, () => {
      layer.replace_source(project.footages[0]);
    }, "does not have a source");
  });

  test("test_3d_model_layer_raises", () => {
    /** ThreeDModelLayer cannot have its source replaced. */
    const project = parse_project_fresh(SAMPLES_DIR.div("three_d_model_layer.aep"));
    const layer = as_instance(get_first_layer(project), ThreeDModelLayer);

    raises(ValueError, () => {
      layer.replace_source(as_instance(layer.source, AVItem));
    }, "3D model layers");
  });

  test("test_direct_cycle_raises", () => {
    /** Replacing a layer's source with its own comp raises ValueError. */
    const app = parse_aep(VERSIONS_DIR.div("ae2025", "complete.aep"));
    const comp = get_comp(app.project, "Main_Comp");
    const layer = as_instance(comp.layers[0], AVLayer);

    raises(ValueError, () => {
      layer.replace_source(comp);
    }, "composition cycle");
  });

  test("test_deep_cycle_raises", () => {
    /** Cycle detection catches indirect chains (A > B > A). */
    const app = parse_aep(VERSIONS_DIR.div("ae2025", "complete.aep"));
    const comp = get_comp(app.project, "Main_Comp");
    // Find a sub-comp used as a source by a layer in Main_Comp
    let sub_comp = null;
    for (const layer of comp.av_layers) {
      const src = layer.source;
      if (src != null && "layers" in src && src !== comp) {
        sub_comp = src;
        break;
      }
    }
    if (sub_comp == null) {
      return skip("No nested comp layer in Main_Comp");
    }
    // Find a layer in sub_comp that has a source (not text/shape)
    let sub_layer = null;
    for (const ly of as_instance(sub_comp, CompItem).av_layers) {
      if (ly.source != null) {
        sub_layer = ly;
        break;
      }
    }
    if (sub_layer == null) {
      return skip("No sourced layer in sub-comp");
    }
    // sub_comp is used inside Main_Comp, so setting a layer
    // in sub_comp to point at Main_Comp would create A > B > A.
    raises(ValueError, () => {
      sub_layer.replace_source(comp);
    }, "composition cycle");
  });
});

describe("TestLayerRemove", () => {
  /** Tests for Layer.remove(). */

  test("test_remove_decreases_count", () => {
    const app = parse_aep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = get_comp(app.project, "crystal");
    expect(len(comp.layers)).toBe(3);
    comp.layers[2].remove();
    expect(len(comp.layers)).toBe(2);
  });

  test("test_remove_cleans_parent_refs", () => {
    const app = parse_aep(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = get_comp(app.project, "parent");
    const child = comp.layers[0]; // ChildLayer, parent_id=57
    expect(child._parent_id).toBe(57);
    comp.layers[1].remove(); // Remove ParentNull (id=57)
    expect(child._parent_id).toBe(0);
  });

  test("test_remove_cleans_matte_refs", () => {
    const app = parse_aep(SAMPLES_DIR.div("track_matte_yes.aep"));
    const comp = app.project.compositions[0];
    const matted = comp.layers[0]; // Gray Solid 2, matte_layer_id=15
    expect(matted._ldta.matte_layer_id).toBe(15);
    comp.layers[1].remove(); // Remove matte source (id=15)
    expect(matted._ldta.matte_layer_id).toBe(0);
  });

  test("test_remove_invalidates_cache", () => {
    const app = parse_aep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = get_comp(app.project, "crystal");
    const last_id = at(comp.layers, -1).id;
    void comp.layers_by_id; // Build cache
    expect(comp.layers_by_id.has(last_id)).toBe(true);
    at(comp.layers, -1).remove();
    expect(comp.layers_by_id.has(last_id)).toBe(false);
  });

  test("test_remove_all_layers", () => {
    const app = parse_aep(SAMPLES_DIR.div("track_matte_no.aep"));
    const comp = app.project.compositions[0];
    const n = len(comp.layers);
    for (const _ of range(n)) {
      comp.layers[0].remove();
    }
    expect(len(comp.layers)).toBe(0);
  });

  test("test_remove_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = get_comp(app.project, "crystal");
    const removed_id = at(comp.layers, -1).id;
    at(comp.layers, -1).remove();
    app.project.save(tmp_path.div("out.aep"));

    const app2 = parse_aep(tmp_path.div("out.aep"));
    const comp2 = get_comp(app2.project, "crystal");
    expect(len(comp2.layers)).toBe(2);
    expect(comp2.layers.map((ly) => ly.id).includes(removed_id)).toBe(false);
  });

  test("test_remove_parent_roundtrip", () => {
    const tmp_path = make_tmp_path();
    /** Remove a parent layer, save, reparse: child is unparented. */
    const app = parse_aep(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = get_comp(app.project, "parent");
    comp.layers[1].remove(); // Remove ParentNull (id=57)
    app.project.save(tmp_path.div("out.aep"));

    const app2 = parse_aep(tmp_path.div("out.aep"));
    const comp2 = get_comp(app2.project, "parent");
    const child = comp2.layers[0];
    expect(child._parent_id).toBe(0);
  });

  test("test_remove_parent_preserves_world_position", () => {
    /** Removing parent recalculates child Position to world coords. */
    const app = parse_aep(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = get_comp(app.project, "parent");
    const child = comp.layers[0]; // ChildLayer
    const parent = comp.layers[1]; // ParentNull
    expect(child.parent).toBe(parent);
    expect(py_eq(child.transform.__getitem__("ADBE Position").value, [0.0, 0.0, 0.0])).toBe(true);
    const parent_pos = parent.transform.__getitem__("ADBE Position").value;

    parent.remove();

    // Child position should now be the parent's former position
    const pos = child.transform.__getitem__("ADBE Position").value;
    expect(Math.abs(pos[0] - parent_pos[0]) < 0.01).toBe(true);
    expect(Math.abs(pos[1] - parent_pos[1]) < 0.01).toBe(true);
    expect(Math.abs(pos[2] - parent_pos[2]) < 0.01).toBe(true);
  });
});

describe("TestParentSetter", () => {
  /** Tests for Layer.parent setter with transform preservation. */

  test("test_unparent_preserves_world_position", () => {
    /** Setting parent=None recalculates child transforms. */
    const app = parse_aep(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = get_comp(app.project, "parent");
    const child = comp.layers[0]; // ChildLayer
    const parent = comp.layers[1]; // ParentNull
    expect(child.parent).toBe(parent);

    const parent_pos = parent.transform.__getitem__("ADBE Position").value;
    child.parent = null;

    const pos = child.transform.__getitem__("ADBE Position").value;
    expect(Math.abs(pos[0] - parent_pos[0]) < 0.01).toBe(true);
    expect(Math.abs(pos[1] - parent_pos[1]) < 0.01).toBe(true);
    expect(Math.abs(pos[2] - parent_pos[2]) < 0.01).toBe(true);
  });

  test("test_unparent_preserves_scale", () => {
    /** Scale stays [100,100,100] when parent has identity scale. */
    const app = parse_aep(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = get_comp(app.project, "parent");
    const child = comp.layers[0];
    child.parent = null;
    expect(py_eq(child.transform.__getitem__("ADBE Scale").value, [100.0, 100.0, 100.0])).toBe(true);
  });

  test("test_unparent_preserves_rotation", () => {
    /** Rotation stays 0 when parent has identity rotation. */
    const app = parse_aep(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = get_comp(app.project, "parent");
    const child = comp.layers[0];
    child.parent = null;
    expect(Math.abs(child.transform.__getitem__("ADBE Rotate Z").value) < 0.01).toBe(true);
  });

  test("test_same_parent_noop", () => {
    /** Setting same parent is a no-op. */
    const app = parse_aep(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = get_comp(app.project, "parent");
    const child = comp.layers[0];
    const parent = comp.layers[1];
    child.parent = parent; // Same parent, no-op
    expect(py_eq(child.transform.__getitem__("ADBE Position").value, [0.0, 0.0, 0.0])).toBe(true);
  });

  test("test_reparent_to_new_parent", () => {
    /** Reparenting from one parent to another preserves world pos. */
    const app = parse_aep(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = get_comp(app.project, "parent");
    const child = comp.layers[0]; // ChildLayer parented to ParentNull
    const parent = comp.layers[1]; // ParentNull at [50, 50, 0]

    // World position of child is parent pos + child local pos
    // = [50, 50, 0] + [0, 0, 0] = [50, 50, 0]

    // Unparent first, then parent to the same layer (round-trip)
    child.parent = null;

    // Re-parent back: child local should become [0,0,0] again
    child.parent = parent;
    const pos_local = child.transform.__getitem__("ADBE Position").value;
    expect(Math.abs(pos_local[0]) < 0.01).toBe(true);
    expect(Math.abs(pos_local[1]) < 0.01).toBe(true);
    expect(Math.abs(pos_local[2]) < 0.01).toBe(true);
  });

  test("test_unparent_roundtrip", () => {
    const tmp_path = make_tmp_path();
    /** Unparent, save, reparse: transforms survive round-trip. */
    const app = parse_aep(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = get_comp(app.project, "parent");
    const child = comp.layers[0];
    const parent = comp.layers[1];
    const parent_pos = parent.transform.__getitem__("ADBE Position").value.slice();

    child.parent = null;
    app.project.save(tmp_path.div("out.aep"));

    const app2 = parse_aep(tmp_path.div("out.aep"));
    const comp2 = get_comp(app2.project, "parent");
    const child2 = comp2.layers[0];
    expect(child2._parent_id).toBe(0);
    const pos = child2.transform.__getitem__("ADBE Position").value;
    expect(Math.abs(pos[0] - parent_pos[0]) < 0.01).toBe(true);
    expect(Math.abs(pos[1] - parent_pos[1]) < 0.01).toBe(true);
  });
});

describe("TestLayerMove", () => {
  /** Tests for Layer.move_to_beginning/end/after/before. */

  test("test_move_to_end", () => {
    const app = parse_aep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = get_comp(app.project, "crystal");
    const first = comp.layers[0];
    const first_id = first.id;
    first.move_to_end();
    expect(comp.layers.at(-1)).toBe(first);
    expect(at(comp.layers, -1).id).toBe(first_id);
  });

  test("test_move_to_beginning", () => {
    const app = parse_aep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = get_comp(app.project, "crystal");
    const last = at(comp.layers, -1);
    const last_id = last.id;
    last.move_to_beginning();
    expect(comp.layers[0]).toBe(last);
    expect(comp.layers[0].id).toBe(last_id);
  });

  test("test_move_after", () => {
    const app = parse_aep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = get_comp(app.project, "crystal");
    const ids_before = comp.layers.map((ly) => ly.id);
    const first = comp.layers[0];
    const target = comp.layers[2];
    first.move_after(target);
    // [0] moved after [2]: new order is [1, 2, 0]
    expect(comp.layers[0].id).toBe(ids_before[1]);
    expect(comp.layers[1].id).toBe(ids_before[2]);
    expect(comp.layers[2].id).toBe(ids_before[0]);
  });

  test("test_move_before", () => {
    const app = parse_aep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = get_comp(app.project, "crystal");
    const ids_before = comp.layers.map((ly) => ly.id);
    const last = comp.layers[2];
    const target = comp.layers[0];
    last.move_before(target);
    // [2] moved before [0]: new order is [2, 0, 1]
    expect(comp.layers[0].id).toBe(ids_before[2]);
    expect(comp.layers[1].id).toBe(ids_before[0]);
    expect(comp.layers[2].id).toBe(ids_before[1]);
  });

  test("test_move_preserves_parent", () => {
    const app = parse_aep(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = get_comp(app.project, "parent");
    const child = comp.layers[0]; // ChildLayer, parent_id=57
    const parent = comp.layers[1]; // ParentNull, id=57
    parent.move_to_beginning();
    expect(child._parent_id).toBe(57);
  });

  test("test_move_preserves_matte", () => {
    const app = parse_aep(SAMPLES_DIR.div("track_matte_yes.aep"));
    const comp = app.project.compositions[0];
    const matted = comp.layers[0]; // Gray Solid 2, matte_layer_id=15
    comp.layers[1].move_to_beginning(); // Move matte source
    expect(matted._ldta.matte_layer_id).toBe(15);
  });

  test("test_move_same_position", () => {
    /** Moving to current position is a no-op. */
    const app = parse_aep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = get_comp(app.project, "crystal");
    const ids_before = comp.layers.map((ly) => ly.id);
    comp.layers[1].move_before(comp.layers[1]);
    expect(py_eq(comp.layers.map((ly) => ly.id), ids_before)).toBe(true);
  });

  test("test_move_wrong_comp_raises", () => {
    const app = parse_aep(VERSIONS_DIR.div("ae2025", "complete.aep"));
    const comps = app.project.compositions;
    if (len(comps) < 2) {
      return skip("Need at least 2 comps");
    }
    const layer_a = comps[0].layers[0];
    const layer_b = comps[1].layers[0];
    raises(ValueError, () => {
      layer_a.move_after(layer_b);
    }, "same composition");
  });

  test("test_move_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = get_comp(app.project, "crystal");
    const names_before = comp.layers.map((ly) => ly.name);
    comp.layers[0].move_to_end();
    const expected = [...names_before.slice(1), names_before[0]];
    expect(py_eq(comp.layers.map((ly) => ly.name), expected)).toBe(true);

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));
    const comp2 = get_comp(app2.project, "crystal");
    expect(py_eq(comp2.layers.map((ly) => ly.name), expected)).toBe(true);
  });

  test("test_move_updates_index", () => {
    const app = parse_aep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = get_comp(app.project, "crystal");
    const layer = comp.layers[0];
    expect(layer.index).toBe(0);
    layer.move_to_end();
    expect(layer.index).toBe(2);
  });
});

describe("TestSetParentWithJump", () => {
  /** Tests for Layer.set_parent_with_jump(). */

  test("test_set_parent", () => {
    /** Setting parent via set_parent_with_jump writes the ID. */
    const app = parse_aep(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = get_comp(app.project, "parent");
    const child = comp.layers[0]; // ChildLayer

    // Unparent without transform compensation
    child.set_parent_with_jump(null);
    expect(child._parent_id).toBe(0);
    expect(child.parent == null).toBe(true);
    // Local position should NOT change (no compensation)
    expect(py_eq(child.transform.__getitem__("ADBE Position").value, [0.0, 0.0, 0.0])).toBe(true);
  });

  test("test_set_parent_assigns_id", () => {
    /** set_parent_with_jump sets the parent ID directly. */
    const app = parse_aep(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = get_comp(app.project, "parent");
    const child = comp.layers[0];
    const parent = comp.layers[1];
    child.set_parent_with_jump(null);
    child.set_parent_with_jump(parent);
    expect(child._parent_id).toBe(parent.id);
    expect(child.parent).toBe(parent);
  });

  test("test_roundtrip", () => {
    const tmp_path = make_tmp_path();
    /** set_parent_with_jump survives save/reparse. */
    const app = parse_aep(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = get_comp(app.project, "parent");
    const child = comp.layers[0];
    child.set_parent_with_jump(null);

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));
    const comp2 = get_comp(app2.project, "parent");
    expect(comp2.layers[0]._parent_id).toBe(0);
  });
});

describe("TestLayerDuplicate", () => {
  /** Tests for Layer.duplicate(). */

  test("test_duplicate_increases_count", () => {
    const app = parse_aep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = get_comp(app.project, "crystal");
    expect(len(comp.layers)).toBe(3);
    comp.layers[0].duplicate();
    expect(len(comp.layers)).toBe(4);
  });

  test("test_duplicate_returns_new_layer", () => {
    const app = parse_aep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = get_comp(app.project, "crystal");
    const original = comp.layers[0];
    const dup = original.duplicate();
    expect(dup).not.toBe(original);
    expect(dup.id).not.toBe(original.id);
  });

  test("test_duplicate_placed_before_original", () => {
    /** Duplicate appears above (before) the original. */
    const app = parse_aep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = get_comp(app.project, "crystal");
    const original = comp.layers[1];
    const original_idx = original.index;
    const dup = original.duplicate();
    expect(dup.index).toBe(original_idx);
    expect(original.index).toBe(original_idx + 1);
  });

  test("test_duplicate_rewrites_owner_tdpi", () => {
    /**
     * Effect internal (-0000) tdpi values point at the duplicate's
     * new id, while layer-reference (-0001) values keep pointing at
     * the originally referenced layer, as AE does.
     */
    const app = parse_aep(
      new Path(import.meta.path).parent.parent.parent.div("samples", "models", "property", "2_gaussian.aep"),
    );
    const layer = app.project.compositions[0].layers[0];
    expect(layer.effects != null).toBe(true);
    if (layer.effects == null) throw new Error("layer has no effects group");
    // Layer Control references the containing layer by default.
    layer.effects.add_property("ADBE Layer Control");
    const original_id = layer.id;

    const dup = layer.duplicate();
    const orig_tdpi = _tdpi_by_param_suffix(layer);
    const dup_tdpi = _tdpi_by_param_suffix(dup);
    expect(py_eq(new Set(getitem(orig_tdpi, "-0000")), new Set([original_id]))).toBe(true);
    expect(py_eq(getitem(orig_tdpi, "-0001"), [original_id])).toBe(true);
    expect(py_eq(new Set(getitem(dup_tdpi, "-0000")), new Set([dup.id]))).toBe(true);
    expect(py_eq(getitem(dup_tdpi, "-0001"), [original_id])).toBe(true);
  });

  test("test_duplicate_owner_tdpi_roundtrip", () => {
    const tmp_path = make_tmp_path();
    /** The rewritten tdpi values survive save/reload. */
    const app = parse_aep(
      new Path(import.meta.path).parent.parent.parent.div("samples", "models", "property", "2_gaussian.aep"),
    );
    const layer = app.project.compositions[0].layers[0];
    expect(layer.effects != null).toBe(true);
    if (layer.effects == null) throw new Error("layer has no effects group");
    layer.effects.add_property("ADBE Layer Control");
    const original_id = layer.id;
    const dup = layer.duplicate();
    const dup_id = dup.id;
    app.project.save(tmp_path.div("out.aep"));
    const comp2 = parse_aep(tmp_path.div("out.aep")).project.compositions[0];
    const dup2 = comp2.layers.find((lyr) => lyr.id === dup_id);
    if (dup2 === undefined) throw new StopIteration();
    const dup2_tdpi = _tdpi_by_param_suffix(dup2);
    expect(py_eq(new Set(getitem(dup2_tdpi, "-0000")), new Set([dup_id]))).toBe(true);
    expect(py_eq(getitem(dup2_tdpi, "-0001"), [original_id])).toBe(true);
  });

  test("test_duplicate_preserves_name_from_source", () => {
    /** Source-derived names are not modified on duplicate. */
    const app = parse_aep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = get_comp(app.project, "crystal");
    const original = comp.layers[1]; // mov_23_976.mov - name from source
    expect(original.is_name_set).toBe(false);
    const dup = original.duplicate();
    expect(dup.name).toBe(original.name);
  });

  test("test_duplicate_increments_user_name", () => {
    /** User-defined names are incremented on duplicate. */
    const app = parse_aep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = get_comp(app.project, "crystal");
    const original = comp.layers[0]; // Environment Light 1 - user-defined
    expect(original.is_name_set).toBe(true);
    const dup = original.duplicate();
    expect(dup.name).toBe("Environment Light 2");
  });

  test("test_duplicate_increments_name_no_number", () => {
    /** User-defined name without trailing number gets ' 2' appended. */
    const app = parse_aep(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = get_comp(app.project, "parent");
    const parent_null = comp.layers[1]; // ParentNull - user-defined
    expect(parent_null.is_name_set).toBe(true);
    const dup = parent_null.duplicate();
    expect(dup.name).toBe("ParentNull 2");
  });

  test("test_duplicate_preserves_parent", () => {
    /** Duplicated layer keeps the same parent reference. */
    const app = parse_aep(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = get_comp(app.project, "parent");
    const child = comp.layers[0]; // ChildLayer, has parent
    expect(child._parent_id).not.toBe(0);
    const dup = child.duplicate();
    expect(dup._parent_id).toBe(child._parent_id);
  });

  test("test_duplicate_preserves_matte", () => {
    /** Duplicated layer keeps the track matte reference. */
    const app = parse_aep(SAMPLES_DIR.div("track_matte_yes.aep"));
    const comp = app.project.compositions[0];
    const matted = comp.layers[0]; // has matte_layer_id
    expect(matted._ldta.matte_layer_id).not.toBe(0);
    const dup = matted.duplicate();
    expect(dup._ldta.matte_layer_id).toBe(matted._ldta.matte_layer_id);
  });

  test("test_duplicate_unique_id", () => {
    /** Each duplicate gets a unique layer ID. */
    const app = parse_aep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = get_comp(app.project, "crystal");
    const ids_before = new Set(comp.layers.map((ly) => ly.id));
    const dup1 = comp.layers[0].duplicate();
    const dup2 = comp.layers[0].duplicate();
    const all_ids = new Set(comp.layers.map((ly) => ly.id));
    expect(ids_before.has(dup1.id)).toBe(false);
    expect(ids_before.has(dup2.id)).toBe(false);
    expect(dup1.id).not.toBe(dup2.id);
    expect(len(all_ids)).toBe(len(comp.layers));
  });

  test("test_duplicate_invalidates_cache", () => {
    const app = parse_aep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = get_comp(app.project, "crystal");
    void comp.layers_by_id; // Build cache
    const dup = comp.layers[0].duplicate();
    expect(comp.layers_by_id.has(dup.id)).toBe(true);
  });

  test("test_duplicate_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = get_comp(app.project, "crystal");
    const dup = comp.layers[0].duplicate();
    const dup_name = dup.name;
    const dup_id = dup.id;

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));
    const comp2 = get_comp(app2.project, "crystal");
    expect(len(comp2.layers)).toBe(4);
    expect(comp2.layers[0].name).toBe(dup_name);
    expect(comp2.layers[0].id).toBe(dup_id);
  });
});

describe("TestDuplicateComplexValueLayers", () => {
  /**
   * Regression: duplicate() re-parses cloned chunks; complex-value
   * properties (text, masks, keyframed transforms) must cache during
   * that re-parse instead of taking the user-write setter paths.
   */

  const PROPERTY_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "property");
  const EG_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "essential_graphics");

  test("test_duplicate_static_text_layer", () => {
    const app = parse_aep(EG_DIR.div("text_source_text.aep"));
    const comp = get_comp(app.project, "primary");
    const original = comp.layers[0];
    expect(original instanceof TextLayer).toBe(true);
    const dup = original.duplicate();
    if (original.text == null) throw new Error("original has no text group");
    if (dup.text == null) throw new Error("duplicate has no text group");
    const src = original.text.property("ADBE Text Document").value;
    const dup_src = dup.text.property("ADBE Text Document").value;
    expect(py_eq(dup_src.text, src.text)).toBe(true);
  });

  test("test_duplicate_masked_layer", () => {
    const app = parse_aep(PROPERTY_DIR.div("shape_basic.aep"));
    const comp = get_comp(app.project, "shape_closed_oval");
    const original = comp.layers[0];
    const dup = original.duplicate();
    if (original.masks == null) throw new Error("original has no masks group");
    if (dup.masks == null) throw new Error("duplicate has no masks group");
    const orig_shape = as_instance(original.masks.__getitem__(0), PropertyGroup).property("ADBE Mask Shape").value;
    const dup_shape = as_instance(dup.masks.__getitem__(0), PropertyGroup).property("ADBE Mask Shape").value;
    expect(py_eq(dup_shape.vertices, orig_shape.vertices)).toBe(true);
  });

  test("test_duplicate_every_layer_kind", () => {
    /** All layers of the animated sample duplicate without error. */
    const app = parse_aep(PROPERTY_DIR.div("all_animated.aep"));
    for (const comp of app.project.compositions) {
      const count = len(comp.layers);
      for (const layer of [...comp.layers]) {
        layer.duplicate();
      }
      expect(len(comp.layers)).toBe(2 * count);
    }
  });
});

describe("TestCopyToComp", () => {
  /** Tests for Layer.copy_to_comp(). */

  test("test_copy_increases_count", () => {
    const app = parse_aep(SAMPLES_DIR.div("layer_misc.aep"));
    const src_comp = get_comp(app.project, "parent");
    const dst_comp = get_comp(app.project, "comment");
    expect(len(dst_comp.layers)).toBe(1);
    src_comp.layers[0].copy_to_comp(dst_comp);
    expect(len(dst_comp.layers)).toBe(2);
  });

  test("test_copy_does_not_remove_from_source", () => {
    const app = parse_aep(SAMPLES_DIR.div("layer_misc.aep"));
    const src_comp = get_comp(app.project, "parent");
    const dst_comp = get_comp(app.project, "comment");
    const n_before = len(src_comp.layers);
    src_comp.layers[0].copy_to_comp(dst_comp);
    expect(len(src_comp.layers)).toBe(n_before);
  });

  test("test_copy_placed_at_top", () => {
    /** Copied layer is at the top (index 0) of target comp. */
    const app = parse_aep(SAMPLES_DIR.div("layer_misc.aep"));
    const src_comp = get_comp(app.project, "parent");
    const dst_comp = get_comp(app.project, "comment");
    const original_name = src_comp.layers[0].name;
    src_comp.layers[0].copy_to_comp(dst_comp);
    expect(dst_comp.layers[0].name).toBe(original_name);
  });

  test("test_copy_clears_parent", () => {
    /** Copied layer has no parent in the target comp. */
    const app = parse_aep(SAMPLES_DIR.div("layer_misc.aep"));
    const src_comp = get_comp(app.project, "parent");
    const dst_comp = get_comp(app.project, "comment");
    const child = src_comp.layers[0]; // ChildLayer, has parent
    expect(child._parent_id).not.toBe(0);
    child.copy_to_comp(dst_comp);
    expect(dst_comp.layers[0]._parent_id).toBe(0);
  });

  test("test_same_comp_duplicates", () => {
    /** Copying to the same comp delegates to duplicate(). */
    const app = parse_aep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = get_comp(app.project, "crystal");
    expect(len(comp.layers)).toBe(3);
    const result = comp.layers[0].copy_to_comp(comp);
    expect(len(comp.layers)).toBe(4);
    expect(result).toBe(comp.layers[0]);
  });

  test("test_copy_returns_layer", () => {
    /** copy_to_comp returns the newly created layer. */
    const app = parse_aep(SAMPLES_DIR.div("layer_misc.aep"));
    const src_comp = get_comp(app.project, "parent");
    const dst_comp = get_comp(app.project, "comment");
    const result = src_comp.layers[0].copy_to_comp(dst_comp);
    expect(result).toBe(dst_comp.layers[0]);
  });

  test("test_copy_unique_id", () => {
    /** Copied layer gets an ID unique within the target comp. */
    const app = parse_aep(SAMPLES_DIR.div("layer_misc.aep"));
    const src_comp = get_comp(app.project, "parent");
    const dst_comp = get_comp(app.project, "comment");
    const existing_ids = new Set(dst_comp.layers.map((ly) => ly.id));
    src_comp.layers[0].copy_to_comp(dst_comp);
    const new_id = dst_comp.layers[0].id;
    expect(existing_ids.has(new_id)).toBe(false);
  });

  test("test_copy_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("layer_misc.aep"));
    const src_comp = get_comp(app.project, "parent");
    const dst_comp = get_comp(app.project, "comment");
    src_comp.layers[0].copy_to_comp(dst_comp);
    const copied_name = dst_comp.layers[0].name;
    const copied_id = dst_comp.layers[0].id;

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));
    const dst2 = get_comp(app2.project, "comment");
    expect(len(dst2.layers)).toBe(2);
    expect(dst2.layers[0].name).toBe(copied_name);
    expect(dst2.layers[0].id).toBe(copied_id);
  });
});

describe("TestLayerReservedBytes", () => {
  /**
   * ldta _reserved_3b/_reserved_3c match AE across layer types.
   *
   * AE writes _reserved_3b=1 / _reserved_3c=0 for every non-camera/light
   * layer (AV, shape, text), and 0/0 for cameras and lights.
   */

  test("test_new_layer_reserved_bytes", () => {
    const comp = py_aep.new().project.root_folder.add_comp("t", 100, 100, 1.0, 1.0, 30.0);
    const av = comp.add_solid([1.0, 0.0, 0.0]);
    const shape = comp.add_shape();
    const camera = comp.add_camera();
    const light = comp.add_light();
    for (const layer of [av, shape]) {
      expect(layer._ldta._reserved_3b).toBe(1);
      expect(layer._ldta._reserved_3c).toBe(0);
    }
    for (const layer of [camera, light]) {
      expect(layer._ldta._reserved_3b).toBe(0);
      expect(layer._ldta._reserved_3c).toBe(0);
    }
  });
});

describe("TestGeometryAutoOrientGuard", () => {
  /**
   * The auto-orientations the transform math does not model still refuse.
   *
   * Mutates auto-orient, so it lives here rather than in read_only/.
   */

  // @staticmethod in Python: a plain helper scoped to this describe block.
  function _probe_layer(project: Project, name: string): AVLayer {
    const comp = project.compositions.find((c) => c.name === "PROBE_MAIN");
    if (comp === undefined) throw new StopIteration();
    const layer = comp.layers.find((ly) => ly.name === name);
    if (layer === undefined) throw new StopIteration();
    return as_instance(layer, AVLayer);
  }

  test("test_along_path_with_separated_position_raises", () => {
    const project = parse_project_fresh(SAMPLES_DIR.div("geometry_probe.aep"));
    const layer = _probe_layer(project, "solid_keyed");
    layer.transform.__getitem__("ADBE Position").dimensions_separated = true;
    layer.auto_orient = AutoOrientType.ALONG_PATH;
    raises(NotImplementedError, () => {
      layer.source_point_to_comp([0.0, 0.0]);
    }, "separated");
  });

  test("test_parented_layer_towards_camera_raises", () => {
    const project = parse_project_fresh(SAMPLES_DIR.div("geometry_probe.aep"));
    const child = _probe_layer(project, "solid_parented");
    child.three_d_layer = true;
    child.auto_orient = AutoOrientType.CAMERA_OR_POINT_OF_INTEREST;
    raises(NotImplementedError, () => {
      child.comp_point_to_source([0.0, 0.0]);
    }, "towards the camera");
  });

  test("test_characters_towards_camera_raises", () => {
    const project = parse_project_fresh(SAMPLES_DIR.div("geometry_probe.aep"));
    const layer = _probe_layer(project, "text_point");
    layer.auto_orient = AutoOrientType.CHARACTERS_TOWARD_CAMERA;
    raises(NotImplementedError, () => {
      layer.source_point_to_comp([0.0, 0.0]);
    }, "characters");
  });
});

describe("TestForwardRayOnly", () => {
  /**
   * `compPointToSource` only casts the FORWARD ray (probed AE 2026).
   *
   * AE returns a literal `[0, 0]` when the layer plane is not hit going
   * forward; py_aep raises instead, because that sentinel cannot be told
   * apart from a real result.
   */

  // @staticmethod in Python: a plain helper scoped to this describe block.
  function _probe_3d_layer(): AVLayer {
    const project = parse_project_fresh(SAMPLES_DIR.div("geometry_probe.aep"));
    const comp = project.compositions.find((c) => c.name === "PROBE_MAIN");
    if (comp === undefined) throw new StopIteration();
    const layer = comp.layers.find((ly) => ly.name === "solid_3d");
    if (layer === undefined) throw new StopIteration();
    return as_instance(layer, AVLayer);
  }

  test("test_layer_in_front_resolves", () => {
    const layer = _probe_3d_layer();
    expect(layer.comp_point_to_source([100.0, 100.0]) != null).toBe(true);
  });

  test("test_layer_behind_camera_raises", () => {
    const layer = _probe_3d_layer();
    // Default comp camera sits at z = -zoom; push the layer behind it.
    layer.transform.__getitem__("ADBE Position").value = [960.0, 540.0, -20000.0];
    raises(ValueError, () => {
      layer.comp_point_to_source([100.0, 100.0]);
    }, "not in front of the camera");
  });
});

describe("TestRoundtripTimeRemapRamp", () => {
  /**
   * Enabling time remapping seeds AE's two-keyframe identity ramp.
   *
   * AE writes exactly two LINEAR keyframes spanning the source from the
   * layer's START (not its in point): `(start_time, 0)` and
   * `(start_time + source.duration, source.duration)`. Measured on AE 2026
   * for comp and footage sources and for a layer offset in time; the single
   * keyframe py-aep used to write left the remap frozen on one value.
   */

  test("test_matches_the_ae_authored_ramp", () => {
    const tmp_path = make_tmp_path();
    /**
     * `outPoint_no_clamp.aep` carries AE's own ramp for a 5 s source:
     * disabling and re-enabling must reproduce it.
     */
    const project = parse_project_fresh(SAMPLES_DIR.div("outPoint_no_clamp.aep"));
    const comp = get_comp(project, "outPoint_no_clamp_timeRemap");
    const layer = as_instance(comp.layers[0], AVLayer);
    const authored = layer.__getitem__("ADBE Time Remapping").keyframes.map((k) => [k.time, k.value]);
    expect(py_eq(authored, [[0.0, 0.0], [5.0, 5.0]])).toBe(true);

    layer.time_remap_enabled = false;
    layer.time_remap_enabled = true;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "outPoint_no_clamp_timeRemap");
    const remap = comp2.layers[0].__getitem__("ADBE Time Remapping");
    expect(py_eq(remap.keyframes.map((k) => [k.time, k.value]), authored)).toBe(true);
  });

  test("test_ramp_is_linear", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("outPoint_no_clamp.aep"));
    const layer = as_instance(get_comp(project, "outPoint_no_clamp_timeRemap").layers[0], AVLayer);
    layer.time_remap_enabled = false;
    layer.time_remap_enabled = true;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "outPoint_no_clamp_timeRemap");
    for (const keyframe of comp2.layers[0].__getitem__("ADBE Time Remapping").keyframes) {
      expect(keyframe.in_interpolation_type).toBe(KeyframeInterpolationType.LINEAR);
      expect(keyframe.out_interpolation_type).toBe(KeyframeInterpolationType.LINEAR);
    }
  });

  test("test_ramp_starts_at_the_layer_start_not_the_in_point", () => {
    /**
     * AE anchors the ramp to `start_time`; an in point trimmed later
     * does not move it.
     */
    const project = parse_project_fresh(SAMPLES_DIR.div("outPoint_no_clamp.aep"));
    const layer = as_instance(get_comp(project, "outPoint_no_clamp_timeRemap").layers[0], AVLayer);
    layer.time_remap_enabled = false;
    layer.start_time = 2.0;
    layer.in_point = 3.0;
    layer.time_remap_enabled = true;

    const source = as_instance(layer.source, AVItem);
    const times = layer.__getitem__("ADBE Time Remapping").keyframes.map((k) => k.time);
    expect(approx(times, [2.0, 2.0 + source.duration])).toBe(true);
  });
});

describe("TestParentToCameraRig", () => {
  /**
   * Parenting to a camera compensates through the camera's rig (its
   * position and look-at toward the point of interest, no anchor point):
   * AE 2026 gave the same layer this Orientation (`auto_orient.aep`).
   */

  test("test_two_node_camera_compensation_matches_ae", () => {
    const project = parse_project_fresh(SAMPLES_DIR.div("auto_orient.aep"));
    const comp = project.compositions.find((c) => c.name === "ORIENT_CAM");
    if (comp === undefined) throw new StopIteration();
    const child = comp.layers.find((ly) => ly.name === "child_of_cam");
    if (child === undefined) throw new StopIteration();
    const camera = child.parent;
    child.parent = null;
    child.transform.__getitem__("ADBE Position").value = [960.0, 540.0, 0.0];
    child.transform.__getitem__("ADBE Orientation").value = [0.0, 0.0, 0.0];
    child.parent = camera;
    const orientation = child.transform.__getitem__("ADBE Orientation").value;
    expect(approx(orientation, [16.8075, 334.9831, 0.0], { abs: 1e-3 })).toBe(true);
  });
});

describe("TestTextSourceRectRefusals", () => {
  /**
   * Text features the ink measurements did not cover refuse rather than
   * guess (mutates the fixture, so it lives in roundtrip/).
   */

  // @staticmethod in Python: a plain helper scoped to this describe block.
  function _hello(project: Project): TextLayer {
    const comp = project.compositions.find((c) => c.name === "TEXT_INK");
    if (comp === undefined) throw new StopIteration();
    const layer = comp.layers.find((ly) => ly.name === "Hello_36");
    if (layer === undefined) throw new StopIteration();
    return as_instance(layer, TextLayer);
  }

  test("test_faux_bold_raises", () => {
    const layer = _hello(parse_project_fresh(SAMPLES_DIR.div("text_ink.aep")));
    py_assert(layer.text != null);
    layer.text.__getitem__("ADBE Text Document").value.faux_bold = true;
    raises(NotImplementedError, () => {
      layer.source_rect_at_time(0.0, false);
    }, "faux bold");
  });

  test("test_text_animator_raises", () => {
    const layer = _hello(parse_project_fresh(SAMPLES_DIR.div("text_ink.aep")));
    py_assert(layer.text != null);
    layer.text.__getitem__("ADBE Text Animators").add_property("ADBE Text Animator");
    raises(NotImplementedError, () => {
      layer.source_rect_at_time(0.0, false);
    }, "animators");
  });
});

describe("TestPointOfInterestDefault", () => {
  /**
   * A camera or light's Point of Interest defaults to the comp centre: on
   * a resize AE 2026 keeps it where it was and reports it modified.
   */

  test.each([
    ["True", true],
    ["False", false],
  ])("test_follows_the_comp_centre[%s]", (_id: string, build_first: boolean) => {
    const comp = get_comp(parse_project_fresh(VERSIONS_DIR.div("ae2024", "complete.aep")), "Main_Comp");
    const light = comp.layers.find((la) => la.name === "Light_Point");
    if (light === undefined) throw new StopIteration();
    if (build_first) {
      void light.properties;
    }
    comp.width += 64;
    const poi = light.transform.property("ADBE Anchor Point");
    expect(py_eq(poi.value, [960.0, 540.0, 0.0])).toBe(true);
    expect(py_eq(poi.default_value, [992.0, 540.0, 0.0])).toBe(true);
    expect(poi.is_modified).toBe(true);
  });
});

describe("TestNullOpacity", () => {
  /**
   * A null's Opacity defaults to 0: left out, it reads 0, while a written
   * value reads back as written (AE 2026 reads 100 from py's file).
   */

  test.each([[100.0], [50.0]])("test_written_opacity_reads_back[%p]", (written: number) => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("auto_orient.aep"));
    const layer = project.compositions[0].layers[1];
    expect(layer.null_layer).toBe(true);
    let opacity = layer.transform.property("ADBE Opacity");
    expect([opacity.value, opacity.is_modified]).toEqual([0.0, false]);
    opacity.value = written;
    const out = tmp_path.div("opacity.aep");
    project.save(out);
    const reopened = parse_project_fresh(out).compositions[0].layers[1];
    opacity = reopened.transform.property("ADBE Opacity");
    expect([opacity.value, opacity.default_value, opacity.is_modified]).toEqual([written, 0.0, true]);
  });
});

describe("TestAnchorFollowsSource", () => {
  /**
   * A footage, solid or precomp layer stores its Anchor Point as a
   * fraction of its source, read against the source's current size: left
   * out, it reads the centre, unmodified (AE 2026).
   */

  test.each([
    ["replace_source", [200.0, 100.0, 0.0], [60.0, 80.0, 0.0]],
    ["solid_resize", [200.0, 50.0, 0.0], [60.0, 40.0, 0.0]],
    ["precomp_resize", [200.0, 50.0, 0.0], [60.0, 40.0, 0.0]],
  ])("test_anchor_follows_its_source[%s]", (change: string, centre: number[], stored: number[]) => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.parent.div("composition", "duplicate.aep"));
    const comp = get_comp(project, "AltSrc");
    const precomp = project.root_folder.add_comp("pc", 200, 100, 1.0, 10.0, 24.0);
    const layers = [0, 1].map((i) =>
      change === "precomp_resize"
        ? comp.add(precomp)
        : comp.add_solid([1.0, 0.0, 0.0], `S${i}`, 200, 100, 1.0),
    );
    layers[1].transform.property("ADBE Anchor Point").value = [30.0, 40.0, 0.0];
    if (change === "replace_source") {
      const big = comp.add_solid([0.0, 0.0, 1.0], "Big", 400, 200, 1.0).source;
      if (big == null) throw new StopIteration();
      for (const layer of layers) {
        layer.replace_source(big);
      }
    } else if (change === "solid_resize") {
      for (const layer of layers) {
        const solid = as_instance(layer.source, FootageItem);
        const main_source = as_instance(solid.main_source, SolidSource);
        solid.replace_with_solid(main_source.color, solid.name, 400, 100);
      }
    } else {
      precomp.width = 400;
    }

    function anchors(layers: Layer[]): [number[], boolean][] {
      const props = layers.map((layer) => layer.transform.property("ADBE Anchor Point"));
      return props.map((p): [number[], boolean] => [[...p.value], p.is_modified]);
    }

    const expected = [
      [centre, false],
      [stored, true],
    ];
    expect(py_eq(anchors(layers), expected)).toBe(true);
    const out = tmp_path.div("changed.aep");
    project.save(out);
    const by_id = new Map(get_comp(parse_project_fresh(out), "AltSrc").layers.map((la): [number, Layer] => [la.id, la]));
    expect(py_eq(anchors(layers.map((layer) => getitem(by_id, layer.id))), expected)).toBe(true);
  });
});

describe("TestLazyPropertyTree", () => {
  /**
   * A layer's properties are decoded and built on first access, so a
   * reader of layer attributes alone never pays for them.
   */

  const SAMPLE = VERSIONS_DIR.div("ae2026", "complete.aep");

  // @staticmethod in Python: a plain helper scoped to this describe block.
  function _layers(project: Project): Layer[] {
    return project.compositions.flatMap((comp) => comp.layers);
  }

  test("test_layer_attributes_leave_the_tree_unbuilt", () => {
    const layers = _layers(parse_project_fresh(SAMPLE));
    expect(layers.length > 0).toBe(true);
    for (const layer of layers) {
      void [layer.name, layer.in_point, layer.out_point, layer.enabled];
      void layer.label;
      if (layer instanceof AVLayer) {
        // (A missing attribute would search the children by name.)
        void layer.source;
      }
      expect(layer._tree_param_defs != null).toBe(true);
      // Times may decode the root tdgp (Time Remapping), not its groups.
      const root = as_instance(layer._tdgp, DeferredListChunk);
      const groups = (root.is_parsed ? root.chunks : []).filter(
        (c) => c instanceof ListChunk && c.list_type === "tdgp",
      );
      expect(groups.every((g) => g instanceof DeferredListChunk && !g.is_parsed)).toBe(true);
    }
  });

  test("test_first_access_builds_the_tree", () => {
    const layer = _layers(parse_project_fresh(SAMPLE))[0];
    expect(layer.transform != null).toBe(true);
    expect(layer._tree_param_defs == null).toBe(true);
    expect(layer.properties.every((p) => p.parent_property === layer)).toBe(true);
  });

  test("test_unbuilt_layers_save_unchanged", () => {
    const project = parse_project_fresh(SAMPLE);
    for (const layer of _layers(project)) {
      void [layer.in_point, layer.out_point];
    }
    expect(py_eq(project_bytes(project), SAMPLE.read_bytes())).toBe(true);
  });

  const mutations: [string, (comp: CompItem, layer: Layer) => void][] = [
    ["width", (comp) => (comp.width = comp.width + 64)],
    ["height", (comp) => (comp.height = comp.height + 64)],
    ["pixel_aspect", (comp) => (comp.pixel_aspect = 2.0)],
    ["three_d_layer", (_comp, layer) => (as_instance(layer, AVLayer).three_d_layer = true)],
    ["stretch", (_comp, layer) => (layer.stretch = 200.0)],
  ];

  test.each(mutations)(
    "test_change_before_first_access_matches_a_built_tree[%s]",
    (_id: string, mutate: (comp: CompItem, layer: Layer) => void) => {
      /**
       * State a built tree depends on, changed before the tree is built,
       * saves what the change on a built tree saves.
       */
      const tmp_path = make_tmp_path();
      const sample = new Path(import.meta.path).parent.parent.parent.div("samples/models/property/2_gaussian.aep");
      const saved: Uint8Array[] = [];
      for (const build_first of [true, false]) {
        const project = parse_project_fresh(sample);
        const comp = project.compositions[0];
        const layer = comp.layers[0];
        if (build_first) {
          for (const each of comp.layers) {
            void each.properties;
          }
        }
        mutate(comp, layer);
        // `save`, which writes out the moved left-out defaults.
        const out = tmp_path.div(`built_${build_first ? "True" : "False"}.aep`);
        project.save(out);
        saved.push(out.read_bytes());
      }
      expect(py_eq(saved[0], saved[1])).toBe(true);
    },
  );

  test.each([
    ["True", true],
    ["False", false],
  ])("test_effect_definitions_do_not_depend_on_build_order[%s]", (_id: string, holder_first: boolean) => {
    /**
     * AE writes an effect's parameter definitions in one of its
     * instances only (this project has no `EfdG`): a layer built before
     * that one still finds them.
     */
    const comps = parse_project_fresh(BUGS_DIR.div("29.97_fps_time_scale_3.125.aep")).compositions;
    const holder = comps[0].layers[0];
    const other = comps[1].layers[0];
    for (const layer of holder_first ? [holder, other] : [other, holder]) {
      void layer.properties;
    }
    const effect = as_instance(other.property("ADBE Effect Parade").property("ADBE Geometry2"), PropertyGroup);
    // As AE 15.1 reports: GPU Rendering is an effect parameter in AE 15,
    // not a Compositing Options one.
    expect(effect.num_properties).toBe(14);
    expect(effect.properties[12].match_name).toBe("ADBE Force CPU GPU");
    expect(as_instance(effect.property("ADBE Effect Built In Params"), PropertyGroup).num_properties).toBe(2);
  });

  test.each([["layer"], ["effect"], ["comp"]])(
    "test_effect_definitions_outlive_their_holder[%s]",
    (removed: string) => {
      /**
       * Removing the instance that holds an effect's definitions hands
       * them to the next one, as AE 15's own save does: the file has no
       * `EfdG` to hold them instead.
       */
      const tmp_path = make_tmp_path();
      const project = parse_project_fresh(BUGS_DIR.div("29.97_fps_time_scale_3.125.aep"));
      const [holder_comp, other_comp] = project.compositions;
      const holder = holder_comp.layers[0];
      if (removed === "layer") {
        holder.remove();
      } else if (removed === "effect") {
        holder.property("ADBE Effect Parade").property("ADBE Geometry2").remove();
      } else {
        holder_comp.remove();
      }
      const other_id = other_comp.id;
      let effect = as_instance(
        other_comp.layers[0].property("ADBE Effect Parade").property("ADBE Geometry2"),
        PropertyGroup,
      );
      expect(effect.num_properties).toBe(14);
      const out = tmp_path.div("removed.aep");
      project.save(out);
      const reopened = parse_project_fresh(out).compositions.find((c) => c.id === other_id);
      if (reopened === undefined) throw new StopIteration();
      effect = as_instance(reopened.layers[0].property("ADBE Effect Parade").property("ADBE Geometry2"), PropertyGroup);
      expect(effect.num_properties).toBe(14);
    },
  );

  test("test_failed_build_raises_again", () => {
    /** A build that fails leaves the layer unbuilt, not half-built. */
    const layer = _layers(parse_project_fresh(SAMPLE))[0];

    // NOTE(port): Python monkeypatches `layer.parse_properties`; ESM bindings are read-only, so the
    // instance's `_build_property_tree` (whose first call is `parse_properties`) fails instead.
    layer._build_property_tree = () => {
      throw new RuntimeError("corrupt layer");
    };
    for (let i = 0; i < 2; i++) {
      raises(RuntimeError, () => {
        void layer.properties;
      }, "corrupt layer");
    }
    Reflect.deleteProperty(layer, "_build_property_tree");
    expect(layer.transform != null).toBe(true);
  });

  test("test_comp_resize_writes_a_moved_left_out_position", () => {
    /**
     * AE 2026 keeps a left-out Position where it was when its comp is
     * resized and writes it (a solid, a text, a shape and a null layer).
     */
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("enabled_false.aep"));
    const comp = get_comp(project, "TestComp");
    expect(comp.layers[0].transform.property("ADBE Position")._tdsb?.synthetic).toBe(true);
    comp.width = 164;
    const out = tmp_path.div("resized.aep");
    project.save(out);
    const position = get_comp(parse_project_fresh(out), "TestComp").layers[0].transform.property("ADBE Position");
    expect(position._tdsb?.synthetic).toBe(false);
    expect(py_eq(position.value, [50.0, 50.0, 0.0])).toBe(true);
    expect(position.is_modified).toBe(true);
  });

  test("test_time_remap_enabled_leaves_the_tree_unbuilt", () => {
    const project = parse_project_fresh(SAMPLE);
    const layers = _layers(project).filter((la) => la instanceof AVLayer);
    const flags = layers.map((la) => la.time_remap_enabled);
    expect(layers.every((la) => la._tree_param_defs != null)).toBe(true);
    // The same answer as the property it is read from.
    expect(flags).toEqual(
      layers.map((la) =>
        la.properties.map((p) => p.match_name).includes("ADBE Time Remapping")
          ? !!la.property("ADBE Time Remapping")._animated
          : false,
      ),
    );
    expect(flags.some((f) => f)).toBe(true);
  });

  test("test_essential_property_uuids_leave_the_tree_unbuilt", () => {
    const project = parse_project_fresh(
      new Path(import.meta.path).parent.parent.parent.div("samples", "models", "essential_graphics", "multiple_controllers.aep"),
    );
    const main = get_comp(project, "main");
    expect(main.layers.filter((la) => la.essential_property_uuids.length === 3).length).toBe(1);
    expect(main.layers.every((la) => la._tree_param_defs != null)).toBe(true);
  });
});
