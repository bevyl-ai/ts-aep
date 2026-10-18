/** Tests for Layer model parsing. */

import { describe, expect, test } from "bun:test";
import {
  AttributeError,
  len,
  NotImplementedError,
  at,
  Path,
  pyAssert,
  pyEq,
  range,
  getitem,
  setdefault,
  pySlice,
  isclose,
  RuntimeError,
  StopIteration,
  ValueError,
} from "../../src/pyrt/index.ts";
import { approx, makeTmpPath, raises, skip } from "../../src/pyrt/pytest.ts";
import * as py_aep from "../../src/py_aep/index.ts";
import { parse as parseAep } from "../../src/py_aep/index.ts";
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
import { asInstance, getComp, getFirstLayer, getLayer, parseProjectFresh, projectBytes } from "../helpers.ts";

const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "layer");
const BUGS_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "bugs");
const VERSIONS_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "versions");

/**
 * Collect tdpi values in a layer block, keyed by the owning param's
 * tdmn suffix (`-0000` internal vs `-0001` value param).
 */
function _tdpiByParamSuffix(layer: Layer): Map<string, number[]> {
  // Python imports ListChunk locally here; the TS twin imports it at module level.
  const result = new Map<string, number[]>();

  function walk(lst: ListChunk): void {
    const chunks = lst.chunks;
    for (const [i, c] of chunks.entries()) {
      if (c.chunkType === "tdmn" && i + 1 < chunks.length) {
        const body = chunks[i + 1];
        if (body instanceof ListChunk) {
          for (const inner of body.chunks) {
            if (inner.chunkType === "tdpi") {
              setdefault(result, pySlice(asInstance(c, TdmnChunk).value, -5, null), []).push(asInstance(inner, S4Chunk).value);
            }
          }
        }
      }
      if (c instanceof ListChunk) walk(c);
    }
  }

  walk(layer._layerList);
  return result;
}

describe("TestLightSource", () => {
  /** Tests for LightLayer.lightSource. */

  test("test_light_source_default_is_none", () => {
    const project = parseProjectFresh(SAMPLES_DIR.div("light_source_default.aep"));
    const layer = asInstance(getFirstLayer(project), LightLayer);
    expect(layer.lightSource == null).toBe(true);
  });

  test("test_light_source_mov", () => {
    const project = parseProjectFresh(SAMPLES_DIR.div("light_source_mov_23_976.mov.aep"));
    const layer = asInstance(getFirstLayer(project), LightLayer);
    expect(layer.lightSource != null).toBe(true);
    const lightSource = asInstance(layer.lightSource, AVLayer);
    expect(lightSource.name).toBe("mov_23_976.mov");
  });

  test("test_light_source_set_none", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("light_source_mov_23_976.mov.aep"));
    const layer = asInstance(getFirstLayer(project), LightLayer);
    expect(layer.lightSource != null).toBe(true);

    layer.lightSource = null;
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const layer2 = asInstance(getFirstLayer(parseAep(out).project), LightLayer);
    expect(layer2.lightSource == null).toBe(true);
  });

  test("test_light_source_set_none_before_ae_23", () => {
    // AE 22 stores no light source as 0 (0xFFFFFFFF from AE 23).
    const project = py_aep.new("22.5x53").project;
    const comp = project.rootFolder.addComp("Comp", 100, 100, 1.0, 1.0, 24.0);
    const light = comp.addLight("Light", [50, 50]);
    light.lightSource = null;
    expect(light._ldta.sourceId).toBe(0);
  });

  test("test_light_source_rejects_3d_layer", () => {
    const project = parseAep(SAMPLES_DIR.div("light_source_mov_23_976.mov.aep")).project;
    const light = project.compositions[0].lightLayers[0];
    expect(light instanceof LightLayer).toBe(true);
    const source = asInstance(light.lightSource, AVLayer);

    source.threeDLayer = true;
    raises(ValueError, () => {
      light.lightSource = source;
    }, "Invalid light source specified");
  });
});

describe("TestRoundtripLightType", () => {
  /** Roundtrip tests for LightLayer.lightType. */

  test("test_modify_light_type_to_spot", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("lightType.aep"));
    const layer = asInstance(getLayer(project, "lightType_AMBIENT"), LightLayer);
    expect(layer.lightType).toBe(LightType.AMBIENT);

    layer.lightType = LightType.SPOT;
    const out = tmpPath.div("modified_light_type.aep");
    project.save(out);
    const layer2 = asInstance(getLayer(parseAep(out).project, "lightType_AMBIENT"), LightLayer);
    expect(layer2.lightType).toBe(LightType.SPOT);
  });

  test("test_modify_light_type_to_point", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("lightType.aep"));
    const layer = asInstance(getLayer(project, "lightType_SPOT"), LightLayer);
    expect(layer.lightType).toBe(LightType.SPOT);

    layer.lightType = LightType.POINT;
    const out = tmpPath.div("modified_light_type_point.aep");
    project.save(out);
    const layer2 = asInstance(getLayer(parseAep(out).project, "lightType_SPOT"), LightLayer);
    expect(layer2.lightType).toBe(LightType.POINT);
  });

  test("test_modify_light_type_to_parallel", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("lightType.aep"));
    const layer = asInstance(getLayer(project, "lightType_POINT"), LightLayer);
    expect(layer.lightType).toBe(LightType.POINT);

    layer.lightType = LightType.PARALLEL;
    const out = tmpPath.div("modified_light_type_parallel.aep");
    project.save(out);
    const layer2 = asInstance(getLayer(parseAep(out).project, "lightType_POINT"), LightLayer);
    expect(layer2.lightType).toBe(LightType.PARALLEL);
  });

  test("test_light_type_validation_rejects_invalid", () => {
    const project = parseProjectFresh(SAMPLES_DIR.div("lightType.aep"));
    const layer = getLayer(project, "lightType_AMBIENT");
    expect(layer instanceof LightLayer).toBe(true);
    raises(ValueError, () => {
      // @ts-expect-error type: ignore[assignment] in Python: the value is deliberately invalid.
      asInstance(layer, LightLayer).lightType = 9999;
    }, "Invalid value");
  });
});

describe("TestRoundtripLayerFlags", () => {
  /** Roundtrip tests for Layer chunk-backed boolean flags. */

  test("test_modify_locked", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("layer_switches.aep"));
    const layer = getLayer(project, "locked_true");
    expect(layer.locked).toBe(true);

    layer.locked = false;
    const out = tmpPath.div("modified_locked.aep");
    project.save(out);
    const layer2 = getLayer(parseAep(out).project, "locked_true");
    expect(layer2.locked).toBe(false);
  });

  test("test_modify_shy", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("layer_switches.aep"));
    const layer = getLayer(project, "shy_true");
    expect(layer.shy).toBe(true);

    layer.shy = false;
    const out = tmpPath.div("modified_shy.aep");
    project.save(out);
    const layer2 = getLayer(parseAep(out).project, "shy_true");
    expect(layer2.shy).toBe(false);
  });

  test("test_modify_solo", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("layer_switches.aep"));
    const layer = getLayer(project, "solo_true");
    expect(layer.solo).toBe(true);

    layer.solo = false;
    const out = tmpPath.div("modified_solo.aep");
    project.save(out);
    const layer2 = getLayer(parseAep(out).project, "solo_true");
    expect(layer2.solo).toBe(false);
  });
});

describe("TestRoundtripAVLayerFlags", () => {
  /** Roundtrip tests for AVLayer chunk-backed flags. */

  test("test_modify_blending_mode", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("blendingMode.aep"));
    const layer = asInstance(getLayer(project, "blendingMode_ADD"), AVLayer);
    expect(layer.blendingMode).toBe(BlendingMode.ADD);

    layer.blendingMode = BlendingMode.MULTIPLY;
    const out = tmpPath.div("modified_blending.aep");
    project.save(out);
    const layer2 = asInstance(getLayer(parseAep(out).project, "blendingMode_ADD"), AVLayer);
    expect(layer2.blendingMode).toBe(BlendingMode.MULTIPLY);
  });

  test("test_dancing_dissolve_roundtrip", () => {
    // Dancing Dissolve has no transfer-mode value of its own - AE stores it
    // as Dissolve plus a flag bit in the ldta. Round-tripping exercises both
    // the write (set the bit) and read (recover DANCING_DISSOLVE) paths.
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("blendingMode.aep"));
    const layer = asInstance(getLayer(project, "blendingMode_ADD"), AVLayer);

    layer.blendingMode = BlendingMode.DANCING_DISSOLVE;
    const out = tmpPath.div("dancing.aep");
    project.save(out);
    const layer2 = asInstance(getLayer(parseAep(out).project, "blendingMode_ADD"), AVLayer);
    expect(layer2.blendingMode).toBe(BlendingMode.DANCING_DISSOLVE);
  });

  test("test_dancing_dissolve_independent_of_preserve_transparency", () => {
    // The dancing flag and preserve-underlying-transparency share one ldta
    // byte (bits 1 and 0). Setting one must not disturb the other.
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("blendingMode.aep"));
    const layer = asInstance(getLayer(project, "blendingMode_ADD"), AVLayer);
    layer.blendingMode = BlendingMode.DANCING_DISSOLVE;
    layer.preserveTransparency = true;
    const out = tmpPath.div("dancing_pt.aep");
    project.save(out);
    const layer2 = asInstance(getLayer(parseAep(out).project, "blendingMode_ADD"), AVLayer);
    expect(layer2.blendingMode).toBe(BlendingMode.DANCING_DISSOLVE);
    expect(layer2.preserveTransparency).toBe(true);
    // Switching to a non-Dissolve mode clears only the dancing flag.
    layer2.blendingMode = BlendingMode.NORMAL;
    expect(layer2.preserveTransparency).toBe(true);
  });

  test("test_modify_three_d_layer", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("avlayer_flags.aep"));
    const layer = asInstance(getLayer(project, "threeDLayer_true"), AVLayer);
    expect(layer.threeDLayer).toBe(true);

    layer.threeDLayer = false;
    const out = tmpPath.div("modified_3d.aep");
    project.save(out);
    const layer2 = asInstance(getLayer(parseAep(out).project, "threeDLayer_true"), AVLayer);
    expect(layer2.threeDLayer).toBe(false);
  });

  test("test_environment_layer_makes_a_3d_layer_2d", () => {
    /**
     * AE 2026 turns the 3D switch off, as a toggle does (contrary to
     * the Scripting Guide, which says the layer becomes 3D).
     */
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("avlayer_flags.aep"));
    const layer = asInstance(getLayer(project, "threeDLayer_true"), AVLayer);
    expect(layer.environmentLayer).toBe(false);

    layer.environmentLayer = true;
    expect(layer.threeDLayer).toBe(false);
    expect(layer.transform.property("ADBE Rotate Z").name).toBe("Rotation");

    const out = tmpPath.div("modified_env.aep");
    project.save(out);
    const layer2 = asInstance(getLayer(parseAep(out).project, "threeDLayer_true"), AVLayer);
    expect(layer2.environmentLayer).toBe(true);
    expect(layer2.threeDLayer).toBe(false);
  });

  test("test_environment_layer_leaves_a_2d_layer_alone", () => {
    /** AE 2026 keeps a 2D layer 2D and its dead Scale Z in the file. */
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("light_source_default.aep"));
    const layer = asInstance(getComp(project, "crystal").layers[1], AVLayer);
    expect(layer.threeDLayer).toBe(false);
    layer.transform.property("ADBE Scale").value = [50.0, 60.0, 40.0];

    layer.environmentLayer = true;
    expect(layer.threeDLayer).toBe(false);

    const out = tmpPath.div("env_2d.aep");
    project.save(out);
    const scale = getComp(parseAep(out).project, "crystal").layers[1].transform.property("ADBE Scale");
    expect(pyEq(scale.value, [50.0, 60.0, 100.0])).toBe(true);
    const raw = scale._readCdatRaw();
    expect(Array.isArray(raw) && approx(raw[2], 0.4)).toBe(true);
  });

  test("test_three_d_layer_keeps_environment_layer", () => {
    /**
     * AE 2026: both switches on after `environmentLayer` then
     * `threeDLayer`.
     */
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("avlayer_flags.aep"));
    const layer = asInstance(getLayer(project, "threeDLayer_true"), AVLayer);

    layer.environmentLayer = true;
    layer.threeDLayer = true;
    expect(layer.environmentLayer).toBe(true);

    const out = tmpPath.div("modified_3d_env.aep");
    project.save(out);
    const layer2 = asInstance(getLayer(parseAep(out).project, "threeDLayer_true"), AVLayer);
    expect(layer2.threeDLayer).toBe(true);
    expect(layer2.environmentLayer).toBe(true);
  });
});

describe("TestRoundtripAutoOrient", () => {
  /** Roundtrip tests for Layer.autoOrient. */

  test("test_modify_along_path_to_no_auto_orient", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("autoOrient.aep"));
    const layer = getLayer(project, "autoOrient_ALONG_PATH");
    expect(layer.autoOrient).toBe(AutoOrientType.ALONG_PATH);

    layer.autoOrient = AutoOrientType.NO_AUTO_ORIENT;
    const out = tmpPath.div("modified_auto_orient.aep");
    project.save(out);
    const layer2 = getLayer(parseAep(out).project, "autoOrient_ALONG_PATH");
    expect(layer2.autoOrient).toBe(AutoOrientType.NO_AUTO_ORIENT);
  });

  test("test_modify_no_auto_orient_to_along_path", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("inPoint.aep"));
    const layer = getLayer(project, "inPoint_5");
    expect(layer.autoOrient).toBe(AutoOrientType.NO_AUTO_ORIENT);

    layer.autoOrient = AutoOrientType.ALONG_PATH;
    const out = tmpPath.div("modified_auto_orient.aep");
    project.save(out);
    const layer2 = getLayer(parseAep(out).project, "inPoint_5");
    expect(layer2.autoOrient).toBe(AutoOrientType.ALONG_PATH);
  });
});

describe("TestRoundtripComment", () => {
  /** Roundtrip tests for Layer.comment. */

  test("test_modify_comment", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("layer_misc.aep"));
    const layer = getLayer(project, "comment");
    expect(layer.comment).not.toBe("");

    layer.comment = "modified comment";
    const out = tmpPath.div("modified_comment.aep");
    project.save(out);
    const layer2 = getLayer(parseAep(out).project, "comment");
    expect(layer2.comment).toBe("modified comment");
  });
});

describe("TestRoundtripInOutPoint", () => {
  /** Roundtrip tests for Layer.inPoint and Layer.outPoint. */

  test("test_modify_in_point", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("inPoint.aep"));
    const layer = getLayer(project, "inPoint_5");
    const originalIn = layer.inPoint;

    const newIn = originalIn + 1.0;
    layer.inPoint = newIn;
    const out = tmpPath.div("modified_in_point.aep");
    project.save(out);
    const layer2 = getLayer(parseAep(out).project, "inPoint_5");
    expect(Math.abs(layer2.inPoint - newIn) < 0.001).toBe(true);
  });

  test("test_modify_out_point", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("inPoint.aep"));
    const layer = getLayer(project, "inPoint_5");
    const originalOut = layer.outPoint;

    const newOut = originalOut - 1.0;
    layer.outPoint = newOut;
    const out = tmpPath.div("modified_out_point.aep");
    project.save(out);
    const layer2 = getLayer(parseAep(out).project, "inPoint_5");
    expect(Math.abs(layer2.outPoint - newOut) < 0.001).toBe(true);
  });
});

describe("TestRoundtripCommentCreate", () => {
  /** Roundtrip tests for Layer.comment when cmta chunk is absent. */

  test("test_create_comment_from_empty", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("inPoint.aep"));
    const layer = getLayer(project, "inPoint_5");
    expect(layer.comment).toBe("");

    layer.comment = "new comment";
    const out = tmpPath.div("created_comment.aep");
    project.save(out);
    const layer2 = getLayer(parseAep(out).project, "inPoint_5");
    expect(layer2.comment).toBe("new comment");
  });
});

describe("TestRoundtripFramePoints", () => {
  /** Roundtrip tests for frame_in_point, frame_out_point, frame_start_time. */

  test("test_modify_frame_in_point", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("inPoint.aep"));
    const layer = getLayer(project, "inPoint_5");

    layer.frameInPoint = 10;
    const out = tmpPath.div("modified_frame_in_point.aep");
    project.save(out);
    const layer2 = getLayer(parseAep(out).project, "inPoint_5");
    expect(layer2.frameInPoint).toBe(10);
  });

  test("test_modify_frame_out_point", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("inPoint.aep"));
    const layer = getLayer(project, "inPoint_5");

    layer.frameOutPoint = 20;
    const out = tmpPath.div("modified_frame_out_point.aep");
    project.save(out);
    const layer2 = getLayer(parseAep(out).project, "inPoint_5");
    expect(layer2.frameOutPoint).toBe(20);
  });

  test("test_modify_frame_start_time", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("inPoint.aep"));
    const layer = getLayer(project, "inPoint_5");

    layer.frameStartTime = 5;
    const out = tmpPath.div("modified_frame_start_time.aep");
    project.save(out);
    const layer2 = getLayer(parseAep(out).project, "inPoint_5");
    expect(layer2.frameStartTime).toBe(5);
  });
});

describe("TestRoundtripFrameBlendingType", () => {
  /** Roundtrip tests for AVLayer.frameBlendingType. */

  test("test_no_blend_to_frame_mix", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("frameBlendingType.aep"));
    const layer = asInstance(getLayer(project, "frameBlendingType_NO_FRAME_BLEND"), AVLayer);
    expect(layer.frameBlendingType).toBe(FrameBlendingType.NO_FRAME_BLEND);
    expect(layer.frameBlending).toBe(false);

    layer.frameBlendingType = FrameBlendingType.FRAME_MIX;
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const layer2 = asInstance(getLayer(parseAep(out).project, "frameBlendingType_NO_FRAME_BLEND"), AVLayer);
    expect(layer2.frameBlendingType).toBe(FrameBlendingType.FRAME_MIX);
    expect(layer2.frameBlending).toBe(true);
  });

  test("test_frame_mix_to_pixel_motion", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("frameBlendingType.aep"));
    const layer = asInstance(getLayer(project, "frameBlendingType_FRAME_MIX"), AVLayer);
    expect(layer.frameBlendingType).toBe(FrameBlendingType.FRAME_MIX);

    layer.frameBlendingType = FrameBlendingType.PIXEL_MOTION;
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const layer2 = asInstance(getLayer(parseAep(out).project, "frameBlendingType_FRAME_MIX"), AVLayer);
    expect(layer2.frameBlendingType).toBe(FrameBlendingType.PIXEL_MOTION);
  });

  test("test_pixel_motion_to_no_blend", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("frameBlendingType.aep"));
    const layer = asInstance(getLayer(project, "frameBlendingType_PIXEL_MOTION"), AVLayer);
    expect(layer.frameBlendingType).toBe(FrameBlendingType.PIXEL_MOTION);

    layer.frameBlendingType = FrameBlendingType.NO_FRAME_BLEND;
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const layer2 = asInstance(getLayer(parseAep(out).project, "frameBlendingType_PIXEL_MOTION"), AVLayer);
    expect(layer2.frameBlendingType).toBe(FrameBlendingType.NO_FRAME_BLEND);
    expect(layer2.frameBlending).toBe(false);
  });
});

describe("TestRoundtripTimeRemapEnabled", () => {
  /** Roundtrip tests for AVLayer.timeRemapEnabled. */

  test("test_disable_time_remap", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("outPoint_no_clamp.aep"));
    const layer = asInstance(getLayer(project, "outPoint_no_clamp_timeRemap"), AVLayer);
    expect(layer.timeRemapEnabled).toBe(true);

    layer.timeRemapEnabled = false;
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const layer2 = asInstance(getLayer(parseAep(out).project, "outPoint_no_clamp_timeRemap"), AVLayer);
    expect(layer2.timeRemapEnabled).toBe(false);
  });

  test("test_enable_time_remap", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("outPoint_no_clamp.aep"));
    const layer = asInstance(getLayer(project, "outPoint_no_clamp_timeRemap"), AVLayer);

    layer.timeRemapEnabled = false;
    const out = tmpPath.div("disabled.aep");
    project.save(out);

    const project2 = parseAep(out).project;
    const layer2 = asInstance(getLayer(project2, "outPoint_no_clamp_timeRemap"), AVLayer);
    expect(layer2.timeRemapEnabled).toBe(false);

    layer2.timeRemapEnabled = true;
    const out2 = tmpPath.div("re_enabled.aep");
    project2.save(out2);
    const layer3 = asInstance(getLayer(parseAep(out2).project, "outPoint_no_clamp_timeRemap"), AVLayer);
    expect(layer3.timeRemapEnabled).toBe(true);
  });
});

describe("TestRoundtripLayerEnabled", () => {
  /** Roundtrip tests for Layer.enabled. */

  test("test_modify_enabled", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("layer_switches.aep"));
    const layer = getLayer(project, "enabled_false");
    expect(layer.enabled).toBe(false);

    layer.enabled = true;
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const layer2 = getLayer(parseAep(out).project, "enabled_false");
    expect(layer2.enabled).toBe(true);
  });
});

describe("TestRoundtripLayerLabel", () => {
  /** Roundtrip tests for Layer.label. */

  test("test_modify_label", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("layer_misc.aep"));
    const layer = getLayer(project, "label_3");
    expect(layer.label).toBe(Label.AQUA);

    layer.label = Label.RED;
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const layer2 = getLayer(parseAep(out).project, "label_3");
    expect(layer2.label).toBe(Label.RED);
  });
});

describe("TestRoundtripLayerStretch", () => {
  /** Roundtrip tests for Layer.stretch. */

  test("test_modify_stretch", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("layer_timing.aep"));
    const layer = getLayer(project, "stretch_200");
    expect(isclose(layer.stretch, 200.0)).toBe(true);

    layer.stretch = 150.0;
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const layer2 = getLayer(parseAep(out).project, "stretch_200");
    expect(isclose(layer2.stretch, 150.0)).toBe(true);
  });
});

describe("TestRoundtripAVLayerBoolFlags", () => {
  /** Roundtrip tests for remaining AVLayer boolean flags. */

  test("test_modify_adjustment_layer", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("avlayer_flags.aep"));
    const layer = asInstance(getLayer(project, "adjustmentLayer_true"), AVLayer);
    expect(layer.adjustmentLayer).toBe(true);

    layer.adjustmentLayer = false;
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const layer2 = getLayer(parseAep(out).project, "adjustmentLayer_true");
    expect(layer2 instanceof AVLayer).toBe(true);
    expect(layer2.adjustmentLayer).toBe(false);
  });

  test("test_modify_audio_enabled", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("audioEnabled.aep"));
    const layer = asInstance(getLayer(project, "audioEnabled_false"), AVLayer);
    expect(layer.audioEnabled).toBe(false);

    layer.audioEnabled = true;
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const layer2 = asInstance(getLayer(parseAep(out).project, "audioEnabled_false"), AVLayer);
    expect(layer2.audioEnabled).toBe(true);
  });

  test("test_modify_collapse_transformation", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("avlayer_flags.aep"));
    const layer = asInstance(getLayer(project, "collapseTransformation_true"), AVLayer);
    expect(layer.collapseTransformation).toBe(true);

    layer.collapseTransformation = false;
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const layer2 = asInstance(getLayer(parseAep(out).project, "collapseTransformation_true"), AVLayer);
    expect(layer2.collapseTransformation).toBe(false);
  });

  test("test_modify_effects_active", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("avlayer_flags.aep"));
    const layer = asInstance(getLayer(project, "effectsActive_false"), AVLayer);
    expect(layer.effectsActive).toBe(false);

    layer.effectsActive = true;
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const layer2 = asInstance(getLayer(parseAep(out).project, "effectsActive_false"), AVLayer);
    expect(layer2.effectsActive).toBe(true);
  });

  test("test_modify_guide_layer", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("avlayer_flags.aep"));
    const layer = asInstance(getLayer(project, "guideLayer_true"), AVLayer);
    expect(layer.guideLayer).toBe(true);

    layer.guideLayer = false;
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const layer2 = asInstance(getLayer(parseAep(out).project, "guideLayer_true"), AVLayer);
    expect(layer2.guideLayer).toBe(false);
  });

  test("test_modify_motion_blur", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("avlayer_flags.aep"));
    const layer = asInstance(getLayer(project, "motionBlur_true"), AVLayer);
    expect(layer.motionBlur).toBe(true);

    layer.motionBlur = false;
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const layer2 = asInstance(getLayer(parseAep(out).project, "motionBlur_true"), AVLayer);
    expect(layer2.motionBlur).toBe(false);
  });

  test("test_modify_preserve_transparency", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("avlayer_flags.aep"));
    const layer = asInstance(getLayer(project, "preserveTransparency_true"), AVLayer);
    expect(layer.preserveTransparency).toBe(true);

    layer.preserveTransparency = false;
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const layer2 = asInstance(getLayer(parseAep(out).project, "preserveTransparency_true"), AVLayer);
    expect(layer2.preserveTransparency).toBe(false);
  });
});

describe("TestRoundtripAVLayerQuality", () => {
  /** Roundtrip tests for AVLayer.quality and sampling_quality. */

  test("test_modify_quality", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("quality.aep"));
    const layer = asInstance(getLayer(project, "quality_BEST"), AVLayer);
    expect(layer.quality).toBe(LayerQuality.BEST);

    layer.quality = LayerQuality.DRAFT;
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const layer2 = asInstance(getLayer(parseAep(out).project, "quality_BEST"), AVLayer);
    expect(layer2.quality).toBe(LayerQuality.DRAFT);
  });

  test("test_modify_sampling_quality", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("avlayer_flags.aep"));
    const layer = asInstance(getLayer(project, "samplingQuality_BICUBIC"), AVLayer);
    expect(layer.samplingQuality).toBe(LayerSamplingQuality.BICUBIC);

    layer.samplingQuality = LayerSamplingQuality.BILINEAR;
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const layer2 = asInstance(getLayer(parseAep(out).project, "samplingQuality_BICUBIC"), AVLayer);
    expect(layer2.samplingQuality).toBe(LayerSamplingQuality.BILINEAR);
  });
});

describe("TestRoundtripThreeDPerChar", () => {
  /** Roundtrip tests for AVLayer.threeDPerChar. */

  test("test_modify_three_d_per_char", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("threeDPerChar_on.aep"));
    const layer = asInstance(getFirstLayer(project), AVLayer);
    expect(layer.threeDPerChar).toBe(true);

    layer.threeDPerChar = false;
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const layer2 = asInstance(getFirstLayer(parseAep(out).project), AVLayer);
    expect(layer2.threeDPerChar).toBe(false);
  });
});

describe("TestRoundtripTrackMatteType", () => {
  /** Roundtrip tests for AVLayer.trackMatteType. */

  test("test_modify_track_matte_type", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("trackMatteType.aep"));
    const comp = getComp(project, "trackMatteType_ALPHA");
    // Track matte layer is the one with ALPHA matte
    let matteLayer = null;
    for (const layer of comp.layers) {
      if (layer instanceof AVLayer && layer.trackMatteType === TrackMatteType.ALPHA) {
        matteLayer = layer;
        break;
      }
    }
    expect(matteLayer != null).toBe(true);
    if (matteLayer == null) throw new Error("no alpha-matte layer in comp");

    matteLayer.trackMatteType = TrackMatteType.LUMA;
    const out = tmpPath.div("modified.aep");
    project.save(out);

    const comp2 = getComp(parseAep(out).project, "trackMatteType_ALPHA");
    let matteLayer2 = null;
    for (const layer of comp2.layers) {
      if (layer instanceof AVLayer && layer.trackMatteType === TrackMatteType.LUMA) {
        matteLayer2 = layer;
        break;
      }
    }
    expect(matteLayer2 != null).toBe(true);
  });
});

describe("TestRoundtripLayerName", () => {
  /** Roundtrip: modify Layer.name and verify save/reload. */

  test("test_modify_layer_name", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("layer_misc.aep"));
    const layer = getLayer(project, "name_renamed");
    expect(layer.name).toBe("RenamedLayer");

    layer.name = "NewName";
    const out = tmpPath.div("modified_name.aep");
    project.save(out);

    const layer2 = getLayer(parseProjectFresh(out), "name_renamed");
    expect(layer2.name).toBe("NewName");
  });

  test("test_set_name_on_source_layer", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("layer_misc.aep"));
    const layer = getLayer(project, "comment");
    expect(layer.isNameSet).toBe(false);

    layer.name = "CustomName";
    const out = tmpPath.div("set_name.aep");
    project.save(out);

    const layer2 = getLayer(parseProjectFresh(out), "comment");
    expect(layer2.name).toBe("CustomName");
    expect(layer2.isNameSet).toBe(true);
  });
});

describe("TestSetTrackMatte", () => {
  /** Tests for AVLayer.setTrackMatte(). */

  test("test_basic", () => {
    /** Assign ALPHA track matte on a file that has none. */
    const app = parseAep(SAMPLES_DIR.div("track_matte_no.aep"));
    const comp = app.project.compositions[0];
    const matted = asInstance(comp.layers[0], AVLayer);
    const matte = asInstance(comp.layers[1], AVLayer);

    matted.setTrackMatte(matte, TrackMatteType.ALPHA);

    expect(matted.trackMatteType).toBe(TrackMatteType.ALPHA);
    expect(matted._matteLayerId).toBe(matte.id);
    expect(matted.trackMatteLayer).toBe(matte);
    expect(matte.enabled).toBe(false);
  });

  test("test_roundtrip", () => {
    const tmpPath = makeTmpPath();
    /** Set matte, save, reparse, verify persisted. */
    const app = parseAep(SAMPLES_DIR.div("track_matte_no.aep"));
    const comp = app.project.compositions[0];
    const matted = asInstance(comp.layers[0], AVLayer);
    const matte = asInstance(comp.layers[1], AVLayer);

    matted.setTrackMatte(matte, TrackMatteType.LUMA);
    app.project.save(tmpPath.div("out.aep"));

    const app2 = parseAep(tmpPath.div("out.aep"));
    const comp2 = app2.project.compositions[0];
    const matted2 = asInstance(comp2.layers[0], AVLayer);
    const matte2 = comp2.layers[1];

    expect(matted2.trackMatteType).toBe(TrackMatteType.LUMA);
    expect(matted2._matteLayerId).toBe(matte2.id);
    expect(matte2.enabled).toBe(false);
  });

  test("test_replaces_existing", () => {
    /** Switching matte re-enables the old matte layer. */
    const app = parseAep(SAMPLES_DIR.div("trackMatteType.aep"));
    const comp = getComp(app.project, "trackMatteType_ALPHA");
    const matted = asInstance(comp.layers[0], AVLayer);
    const oldMatte = asInstance(comp.layers[1], AVLayer);
    expect(oldMatte.enabled).toBe(false);

    // Switch to LUMA with the same matte layer (type changes only)
    matted.setTrackMatte(oldMatte, TrackMatteType.LUMA);
    expect(matted.trackMatteType).toBe(TrackMatteType.LUMA);
    // Matte stays disabled since it's still the matte
    expect(oldMatte.enabled).toBe(false);
  });

  test("test_none_clears_ref", () => {
    /** Passing None clears matte_layer_id but preserves the type. */
    const app = parseAep(SAMPLES_DIR.div("track_matte_yes.aep"));
    const comp = app.project.compositions[0];
    const matted = asInstance(comp.layers[0], AVLayer);
    const matte = asInstance(comp.layers[1], AVLayer);
    expect(matte.enabled).toBe(false);

    matted.setTrackMatte(null, TrackMatteType.ALPHA);

    expect(matted.trackMatteType).toBe(TrackMatteType.ALPHA);
    expect(matted._matteLayerId).toBe(0);
    expect(matted.trackMatteLayer == null).toBe(true);
    // Old matte re-enabled
    expect(matte.enabled).toBe(true);
  });

  test("test_noop_with_no_track_matte", () => {
    /** NO_TRACK_MATTE + non-None layer is a no-op. */
    const app = parseAep(SAMPLES_DIR.div("track_matte_no.aep"));
    const comp = app.project.compositions[0];
    const matted = asInstance(comp.layers[0], AVLayer);
    const matte = asInstance(comp.layers[1], AVLayer);
    const originalType = matted.trackMatteType;

    matted.setTrackMatte(matte, TrackMatteType.NO_TRACK_MATTE);

    expect(matted.trackMatteType).toBe(originalType);
    expect(matted._matteLayerId).toBe(0);
    expect(matte.enabled).toBe(true);
  });

  test("test_pre_ae23_raises", () => {
    /** Files older than AE 23 don't have matte_layer_id. */
    const app = parseAep(VERSIONS_DIR.div("ae2022", "complete.aep"));
    const comp = app.project.compositions[0];
    const layer = asInstance(comp.layers[0], AVLayer);

    raises(AttributeError, () => {
      layer.setTrackMatte(layer, TrackMatteType.ALPHA);
    }, "AE 23");
  });

  test("test_wrong_comp_raises", () => {
    /** Matte layer from a different comp raises ValueError. */
    const app = parseAep(SAMPLES_DIR.div("trackMatteType.aep"));
    const compA = getComp(app.project, "trackMatteType_ALPHA");
    const compL = getComp(app.project, "trackMatteType_LUMA");
    const matted = asInstance(compA.layers[0], AVLayer);
    const foreign = asInstance(compL.layers[1], AVLayer);

    raises(ValueError, () => {
      matted.setTrackMatte(foreign, TrackMatteType.ALPHA);
    }, "same composition");
  });
});

describe("TestRemoveTrackMatte", () => {
  /** Tests for AVLayer.removeTrackMatte(). */

  test("test_basic", () => {
    /** Remove matte reference and re-enable the matte layer. */
    const app = parseAep(SAMPLES_DIR.div("track_matte_yes.aep"));
    const comp = app.project.compositions[0];
    const matted = asInstance(comp.layers[0], AVLayer);
    const matte = asInstance(comp.layers[1], AVLayer);
    expect(matte.enabled).toBe(false);

    matted.removeTrackMatte();

    expect(matted._matteLayerId).toBe(0);
    expect(matted.trackMatteLayer == null).toBe(true);
    expect(matte.enabled).toBe(true);
  });

  test("test_preserves_type", () => {
    /** track_matte_type stays after removing the matte. */
    const app = parseAep(SAMPLES_DIR.div("track_matte_yes.aep"));
    const comp = app.project.compositions[0];
    const matted = asInstance(comp.layers[0], AVLayer);
    expect(matted.trackMatteType).toBe(TrackMatteType.ALPHA);

    matted.removeTrackMatte();

    expect(matted.trackMatteType).toBe(TrackMatteType.ALPHA);
  });

  test("test_roundtrip", () => {
    const tmpPath = makeTmpPath();
    /** Remove matte, save, reparse. */
    const app = parseAep(SAMPLES_DIR.div("track_matte_yes.aep"));
    const comp = app.project.compositions[0];
    asInstance(comp.layers[0], AVLayer).removeTrackMatte();
    app.project.save(tmpPath.div("out.aep"));

    const app2 = parseAep(tmpPath.div("out.aep"));
    const comp2 = app2.project.compositions[0];
    expect(asInstance(comp2.layers[0], AVLayer)._matteLayerId).toBe(0);
    expect(comp2.layers[1].enabled).toBe(true);
  });

  test("test_pre_ae23_raises", () => {
    /** Files older than AE 23 raise AttributeError. */
    const app = parseAep(VERSIONS_DIR.div("ae2022", "complete.aep"));
    const comp = app.project.compositions[0];
    raises(AttributeError, () => {
      asInstance(comp.layers[0], AVLayer).removeTrackMatte();
    }, "AE 23");
  });
});

describe("TestReplaceSource", () => {
  /** Tests for AVLayer.replaceSource(). */

  test("test_basic", () => {
    /** Swap source and verify the new source is returned. */
    const app = parseAep(VERSIONS_DIR.div("ae2025", "complete.aep"));
    const comp = getComp(app.project, "Main_Comp");
    const layer = asInstance(comp.layers[0], AVLayer); // first AVLayer
    const oldSource = layer.source;
    // Pick any other footage item as new source
    const newSource = asInstance(app.project.footages.find((item) => item !== oldSource), FootageItem);

    layer.replaceSource(newSource);

    expect(layer.source).toBe(newSource);
    expect(layer._sourceId).toBe(newSource.id);
  });

  test("test_roundtrip", () => {
    const tmpPath = makeTmpPath();
    /** Replace source, save, reparse, verify. */
    const app = parseAep(VERSIONS_DIR.div("ae2025", "complete.aep"));
    const comp = getComp(app.project, "Main_Comp");
    const layer = asInstance(comp.layers[0], AVLayer);
    const newSource = asInstance(app.project.footages.find((item) => item !== layer.source), FootageItem);
    const newId = newSource.id;

    layer.replaceSource(newSource);
    app.project.save(tmpPath.div("out.aep"));

    const app2 = parseAep(tmpPath.div("out.aep"));
    const comp2 = getComp(app2.project, "Main_Comp");
    expect(asInstance(comp2.layers[0], AVLayer)._sourceId).toBe(newId);
  });

  test("test_updates_used_in", () => {
    /** _used_in back-references are updated. */
    const app = parseAep(VERSIONS_DIR.div("ae2025", "complete.aep"));
    const comp = getComp(app.project, "Main_Comp");
    const layer = asInstance(comp.layers[0], AVLayer);
    const oldSource = asInstance(layer.source, AVItem);
    const newSource = asInstance(
      app.project.footages.find((item) => item !== oldSource && "_usedIn" in item),
      FootageItem,
    );

    layer.replaceSource(newSource);

    expect(newSource._usedIn.has(comp)).toBe(true);
    // old_source removed if no other layer in comp uses it
    const stillUsed = comp.layers.some(
      (ly) => "_sourceId" in ly && ly !== layer && ly._sourceId === oldSource.id,
    );
    if (!stillUsed) {
      expect(oldSource._usedIn.has(comp)).toBe(false);
    }
  });

  test("test_fix_expressions_raises", () => {
    /** fix_expressions=True raises NotImplementedError. */
    const app = parseAep(VERSIONS_DIR.div("ae2025", "complete.aep"));
    const comp = getComp(app.project, "Main_Comp");
    const layer = asInstance(comp.layers[0], AVLayer);
    const source = app.project.footages[0];

    raises(NotImplementedError, () => {
      layer.replaceSource(source, true);
    }, "fix_expressions");
  });

  test("test_not_in_project_raises", () => {
    /** Source not in project.items raises ValueError. */
    const app = parseAep(VERSIONS_DIR.div("ae2025", "complete.aep"));
    const comp = getComp(app.project, "Main_Comp");
    const layer = asInstance(comp.layers[0], AVLayer);

    class _FakeItem {
      id = 999999;
      name = "ghost";
    }

    raises(ValueError, () => {
      // @ts-expect-error a non-AVItem source is deliberately passed to the runtime check
      layer.replaceSource(new _FakeItem());
    }, "must be an AVItem");
  });

  test("test_sourceless_layer_raises", () => {
    /** Shape/text layers (source=None) cannot have their source replaced. */
    const project = parseProjectFresh(SAMPLES_DIR.div("type.aep"));
    const layer = asInstance(getLayer(project, "type_shape"), ShapeLayer);
    expect(layer.source == null).toBe(true);

    raises(ValueError, () => {
      layer.replaceSource(project.footages[0]);
    }, "does not have a source");
  });

  test("test_3d_model_layer_raises", () => {
    /** ThreeDModelLayer cannot have its source replaced. */
    const project = parseProjectFresh(SAMPLES_DIR.div("three_d_model_layer.aep"));
    const layer = asInstance(getFirstLayer(project), ThreeDModelLayer);

    raises(ValueError, () => {
      layer.replaceSource(asInstance(layer.source, AVItem));
    }, "3D model layers");
  });

  test("test_direct_cycle_raises", () => {
    /** Replacing a layer's source with its own comp raises ValueError. */
    const app = parseAep(VERSIONS_DIR.div("ae2025", "complete.aep"));
    const comp = getComp(app.project, "Main_Comp");
    const layer = asInstance(comp.layers[0], AVLayer);

    raises(ValueError, () => {
      layer.replaceSource(comp);
    }, "composition cycle");
  });

  test("test_deep_cycle_raises", () => {
    /** Cycle detection catches indirect chains (A > B > A). */
    const app = parseAep(VERSIONS_DIR.div("ae2025", "complete.aep"));
    const comp = getComp(app.project, "Main_Comp");
    // Find a sub-comp used as a source by a layer in Main_Comp
    let subComp = null;
    for (const layer of comp.avLayers) {
      const src = layer.source;
      if (src != null && "layers" in src && src !== comp) {
        subComp = src;
        break;
      }
    }
    if (subComp == null) {
      return skip("No nested comp layer in Main_Comp");
    }
    // Find a layer in sub_comp that has a source (not text/shape)
    let subLayer = null;
    for (const ly of asInstance(subComp, CompItem).avLayers) {
      if (ly.source != null) {
        subLayer = ly;
        break;
      }
    }
    if (subLayer == null) {
      return skip("No sourced layer in sub-comp");
    }
    // sub_comp is used inside Main_Comp, so setting a layer
    // in sub_comp to point at Main_Comp would create A > B > A.
    raises(ValueError, () => {
      subLayer.replaceSource(comp);
    }, "composition cycle");
  });
});

describe("TestLayerRemove", () => {
  /** Tests for Layer.remove(). */

  test("test_remove_decreases_count", () => {
    const app = parseAep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = getComp(app.project, "crystal");
    expect(len(comp.layers)).toBe(3);
    comp.layers[2].remove();
    expect(len(comp.layers)).toBe(2);
  });

  test("test_remove_cleans_parent_refs", () => {
    const app = parseAep(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = getComp(app.project, "parent");
    const child = comp.layers[0]; // ChildLayer, parent_id=57
    expect(child._parentId).toBe(57);
    comp.layers[1].remove(); // Remove ParentNull (id=57)
    expect(child._parentId).toBe(0);
  });

  test("test_remove_cleans_matte_refs", () => {
    const app = parseAep(SAMPLES_DIR.div("track_matte_yes.aep"));
    const comp = app.project.compositions[0];
    const matted = comp.layers[0]; // Gray Solid 2, matte_layer_id=15
    expect(matted._ldta.matteLayerId).toBe(15);
    comp.layers[1].remove(); // Remove matte source (id=15)
    expect(matted._ldta.matteLayerId).toBe(0);
  });

  test("test_remove_invalidates_cache", () => {
    const app = parseAep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = getComp(app.project, "crystal");
    const lastId = at(comp.layers, -1).id;
    void comp.layersById; // Build cache
    expect(comp.layersById.has(lastId)).toBe(true);
    at(comp.layers, -1).remove();
    expect(comp.layersById.has(lastId)).toBe(false);
  });

  test("test_remove_all_layers", () => {
    const app = parseAep(SAMPLES_DIR.div("track_matte_no.aep"));
    const comp = app.project.compositions[0];
    const n = len(comp.layers);
    for (const _ of range(n)) {
      comp.layers[0].remove();
    }
    expect(len(comp.layers)).toBe(0);
  });

  test("test_remove_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = getComp(app.project, "crystal");
    const removedId = at(comp.layers, -1).id;
    at(comp.layers, -1).remove();
    app.project.save(tmpPath.div("out.aep"));

    const app2 = parseAep(tmpPath.div("out.aep"));
    const comp2 = getComp(app2.project, "crystal");
    expect(len(comp2.layers)).toBe(2);
    expect(comp2.layers.map((ly) => ly.id).includes(removedId)).toBe(false);
  });

  test("test_remove_parent_roundtrip", () => {
    const tmpPath = makeTmpPath();
    /** Remove a parent layer, save, reparse: child is unparented. */
    const app = parseAep(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = getComp(app.project, "parent");
    comp.layers[1].remove(); // Remove ParentNull (id=57)
    app.project.save(tmpPath.div("out.aep"));

    const app2 = parseAep(tmpPath.div("out.aep"));
    const comp2 = getComp(app2.project, "parent");
    const child = comp2.layers[0];
    expect(child._parentId).toBe(0);
  });

  test("test_remove_parent_preserves_world_position", () => {
    /** Removing parent recalculates child Position to world coords. */
    const app = parseAep(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = getComp(app.project, "parent");
    const child = comp.layers[0]; // ChildLayer
    const parent = comp.layers[1]; // ParentNull
    expect(child.parent).toBe(parent);
    expect(pyEq(child.transform.property("ADBE Position").value, [0.0, 0.0, 0.0])).toBe(true);
    const parentPos = parent.transform.property("ADBE Position").value;

    parent.remove();

    // Child position should now be the parent's former position
    const pos = child.transform.property("ADBE Position").value;
    expect(Math.abs(pos[0] - parentPos[0]) < 0.01).toBe(true);
    expect(Math.abs(pos[1] - parentPos[1]) < 0.01).toBe(true);
    expect(Math.abs(pos[2] - parentPos[2]) < 0.01).toBe(true);
  });
});

describe("TestParentSetter", () => {
  /** Tests for Layer.parent setter with transform preservation. */

  test("test_unparent_preserves_world_position", () => {
    /** Setting parent=None recalculates child transforms. */
    const app = parseAep(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = getComp(app.project, "parent");
    const child = comp.layers[0]; // ChildLayer
    const parent = comp.layers[1]; // ParentNull
    expect(child.parent).toBe(parent);

    const parentPos = parent.transform.property("ADBE Position").value;
    child.parent = null;

    const pos = child.transform.property("ADBE Position").value;
    expect(Math.abs(pos[0] - parentPos[0]) < 0.01).toBe(true);
    expect(Math.abs(pos[1] - parentPos[1]) < 0.01).toBe(true);
    expect(Math.abs(pos[2] - parentPos[2]) < 0.01).toBe(true);
  });

  test("test_unparent_preserves_scale", () => {
    /** Scale stays [100,100,100] when parent has identity scale. */
    const app = parseAep(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = getComp(app.project, "parent");
    const child = comp.layers[0];
    child.parent = null;
    expect(pyEq(child.transform.property("ADBE Scale").value, [100.0, 100.0, 100.0])).toBe(true);
  });

  test("test_unparent_preserves_rotation", () => {
    /** Rotation stays 0 when parent has identity rotation. */
    const app = parseAep(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = getComp(app.project, "parent");
    const child = comp.layers[0];
    child.parent = null;
    expect(Math.abs(child.transform.property("ADBE Rotate Z").value) < 0.01).toBe(true);
  });

  test("test_same_parent_noop", () => {
    /** Setting same parent is a no-op. */
    const app = parseAep(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = getComp(app.project, "parent");
    const child = comp.layers[0];
    const parent = comp.layers[1];
    child.parent = parent; // Same parent, no-op
    expect(pyEq(child.transform.property("ADBE Position").value, [0.0, 0.0, 0.0])).toBe(true);
  });

  test("test_reparent_to_new_parent", () => {
    /** Reparenting from one parent to another preserves world pos. */
    const app = parseAep(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = getComp(app.project, "parent");
    const child = comp.layers[0]; // ChildLayer parented to ParentNull
    const parent = comp.layers[1]; // ParentNull at [50, 50, 0]

    // World position of child is parent pos + child local pos
    // = [50, 50, 0] + [0, 0, 0] = [50, 50, 0]

    // Unparent first, then parent to the same layer (round-trip)
    child.parent = null;

    // Re-parent back: child local should become [0,0,0] again
    child.parent = parent;
    const posLocal = child.transform.property("ADBE Position").value;
    expect(Math.abs(posLocal[0]) < 0.01).toBe(true);
    expect(Math.abs(posLocal[1]) < 0.01).toBe(true);
    expect(Math.abs(posLocal[2]) < 0.01).toBe(true);
  });

  test("test_unparent_roundtrip", () => {
    const tmpPath = makeTmpPath();
    /** Unparent, save, reparse: transforms survive round-trip. */
    const app = parseAep(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = getComp(app.project, "parent");
    const child = comp.layers[0];
    const parent = comp.layers[1];
    const parentPos = parent.transform.property("ADBE Position").value.slice();

    child.parent = null;
    app.project.save(tmpPath.div("out.aep"));

    const app2 = parseAep(tmpPath.div("out.aep"));
    const comp2 = getComp(app2.project, "parent");
    const child2 = comp2.layers[0];
    expect(child2._parentId).toBe(0);
    const pos = child2.transform.property("ADBE Position").value;
    expect(Math.abs(pos[0] - parentPos[0]) < 0.01).toBe(true);
    expect(Math.abs(pos[1] - parentPos[1]) < 0.01).toBe(true);
  });
});

describe("TestLayerMove", () => {
  /** Tests for Layer.moveToBeginning/end/after/before. */

  test("test_move_to_end", () => {
    const app = parseAep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = getComp(app.project, "crystal");
    const first = comp.layers[0];
    const firstId = first.id;
    first.moveToEnd();
    expect(comp.layers.at(-1)).toBe(first);
    expect(at(comp.layers, -1).id).toBe(firstId);
  });

  test("test_move_to_beginning", () => {
    const app = parseAep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = getComp(app.project, "crystal");
    const last = at(comp.layers, -1);
    const lastId = last.id;
    last.moveToBeginning();
    expect(comp.layers[0]).toBe(last);
    expect(comp.layers[0].id).toBe(lastId);
  });

  test("test_move_after", () => {
    const app = parseAep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = getComp(app.project, "crystal");
    const idsBefore = comp.layers.map((ly) => ly.id);
    const first = comp.layers[0];
    const target = comp.layers[2];
    first.moveAfter(target);
    // [0] moved after [2]: new order is [1, 2, 0]
    expect(comp.layers[0].id).toBe(idsBefore[1]);
    expect(comp.layers[1].id).toBe(idsBefore[2]);
    expect(comp.layers[2].id).toBe(idsBefore[0]);
  });

  test("test_move_before", () => {
    const app = parseAep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = getComp(app.project, "crystal");
    const idsBefore = comp.layers.map((ly) => ly.id);
    const last = comp.layers[2];
    const target = comp.layers[0];
    last.moveBefore(target);
    // [2] moved before [0]: new order is [2, 0, 1]
    expect(comp.layers[0].id).toBe(idsBefore[2]);
    expect(comp.layers[1].id).toBe(idsBefore[0]);
    expect(comp.layers[2].id).toBe(idsBefore[1]);
  });

  test("test_move_preserves_parent", () => {
    const app = parseAep(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = getComp(app.project, "parent");
    const child = comp.layers[0]; // ChildLayer, parent_id=57
    const parent = comp.layers[1]; // ParentNull, id=57
    parent.moveToBeginning();
    expect(child._parentId).toBe(57);
  });

  test("test_move_preserves_matte", () => {
    const app = parseAep(SAMPLES_DIR.div("track_matte_yes.aep"));
    const comp = app.project.compositions[0];
    const matted = comp.layers[0]; // Gray Solid 2, matte_layer_id=15
    comp.layers[1].moveToBeginning(); // Move matte source
    expect(matted._ldta.matteLayerId).toBe(15);
  });

  test("test_move_same_position", () => {
    /** Moving to current position is a no-op. */
    const app = parseAep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = getComp(app.project, "crystal");
    const idsBefore = comp.layers.map((ly) => ly.id);
    comp.layers[1].moveBefore(comp.layers[1]);
    expect(pyEq(comp.layers.map((ly) => ly.id), idsBefore)).toBe(true);
  });

  test("test_move_wrong_comp_raises", () => {
    const app = parseAep(VERSIONS_DIR.div("ae2025", "complete.aep"));
    const comps = app.project.compositions;
    if (len(comps) < 2) {
      return skip("Need at least 2 comps");
    }
    const layerA = comps[0].layers[0];
    const layerB = comps[1].layers[0];
    raises(ValueError, () => {
      layerA.moveAfter(layerB);
    }, "same composition");
  });

  test("test_move_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = getComp(app.project, "crystal");
    const namesBefore = comp.layers.map((ly) => ly.name);
    comp.layers[0].moveToEnd();
    const expected = [...namesBefore.slice(1), namesBefore[0]];
    expect(pyEq(comp.layers.map((ly) => ly.name), expected)).toBe(true);

    app.project.save(tmpPath.div("out.aep"));
    const app2 = parseAep(tmpPath.div("out.aep"));
    const comp2 = getComp(app2.project, "crystal");
    expect(pyEq(comp2.layers.map((ly) => ly.name), expected)).toBe(true);
  });

  test("test_move_updates_index", () => {
    const app = parseAep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = getComp(app.project, "crystal");
    const layer = comp.layers[0];
    expect(layer.index).toBe(0);
    layer.moveToEnd();
    expect(layer.index).toBe(2);
  });
});

describe("TestSetParentWithJump", () => {
  /** Tests for Layer.setParentWithJump(). */

  test("test_set_parent", () => {
    /** Setting parent via set_parent_with_jump writes the ID. */
    const app = parseAep(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = getComp(app.project, "parent");
    const child = comp.layers[0]; // ChildLayer

    // Unparent without transform compensation
    child.setParentWithJump(null);
    expect(child._parentId).toBe(0);
    expect(child.parent == null).toBe(true);
    // Local position should NOT change (no compensation)
    expect(pyEq(child.transform.property("ADBE Position").value, [0.0, 0.0, 0.0])).toBe(true);
  });

  test("test_set_parent_assigns_id", () => {
    /** set_parent_with_jump sets the parent ID directly. */
    const app = parseAep(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = getComp(app.project, "parent");
    const child = comp.layers[0];
    const parent = comp.layers[1];
    child.setParentWithJump(null);
    child.setParentWithJump(parent);
    expect(child._parentId).toBe(parent.id);
    expect(child.parent).toBe(parent);
  });

  test("test_roundtrip", () => {
    const tmpPath = makeTmpPath();
    /** set_parent_with_jump survives save/reparse. */
    const app = parseAep(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = getComp(app.project, "parent");
    const child = comp.layers[0];
    child.setParentWithJump(null);

    app.project.save(tmpPath.div("out.aep"));
    const app2 = parseAep(tmpPath.div("out.aep"));
    const comp2 = getComp(app2.project, "parent");
    expect(comp2.layers[0]._parentId).toBe(0);
  });
});

describe("TestLayerDuplicate", () => {
  /** Tests for Layer.duplicate(). */

  test("test_duplicate_increases_count", () => {
    const app = parseAep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = getComp(app.project, "crystal");
    expect(len(comp.layers)).toBe(3);
    comp.layers[0].duplicate();
    expect(len(comp.layers)).toBe(4);
  });

  test("test_duplicate_returns_new_layer", () => {
    const app = parseAep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = getComp(app.project, "crystal");
    const original = comp.layers[0];
    const dup = original.duplicate();
    expect(dup).not.toBe(original);
    expect(dup.id).not.toBe(original.id);
  });

  test("test_duplicate_placed_before_original", () => {
    /** Duplicate appears above (before) the original. */
    const app = parseAep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = getComp(app.project, "crystal");
    const original = comp.layers[1];
    const originalIdx = original.index;
    const dup = original.duplicate();
    expect(dup.index).toBe(originalIdx);
    expect(original.index).toBe(originalIdx + 1);
  });

  test("test_duplicate_rewrites_owner_tdpi", () => {
    /**
     * Effect internal (-0000) tdpi values point at the duplicate's
     * new id, while layer-reference (-0001) values keep pointing at
     * the originally referenced layer, as AE does.
     */
    const app = parseAep(
      new Path(import.meta.path).parent.parent.parent.div("samples", "models", "property", "2_gaussian.aep"),
    );
    const layer = app.project.compositions[0].layers[0];
    expect(layer.effects != null).toBe(true);
    if (layer.effects == null) throw new Error("layer has no effects group");
    // Layer Control references the containing layer by default.
    layer.effects.addProperty("ADBE Layer Control");
    const originalId = layer.id;

    const dup = layer.duplicate();
    const origTdpi = _tdpiByParamSuffix(layer);
    const dupTdpi = _tdpiByParamSuffix(dup);
    expect(pyEq(new Set(getitem(origTdpi, "-0000")), new Set([originalId]))).toBe(true);
    expect(pyEq(getitem(origTdpi, "-0001"), [originalId])).toBe(true);
    expect(pyEq(new Set(getitem(dupTdpi, "-0000")), new Set([dup.id]))).toBe(true);
    expect(pyEq(getitem(dupTdpi, "-0001"), [originalId])).toBe(true);
  });

  test("test_duplicate_owner_tdpi_roundtrip", () => {
    const tmpPath = makeTmpPath();
    /** The rewritten tdpi values survive save/reload. */
    const app = parseAep(
      new Path(import.meta.path).parent.parent.parent.div("samples", "models", "property", "2_gaussian.aep"),
    );
    const layer = app.project.compositions[0].layers[0];
    expect(layer.effects != null).toBe(true);
    if (layer.effects == null) throw new Error("layer has no effects group");
    layer.effects.addProperty("ADBE Layer Control");
    const originalId = layer.id;
    const dup = layer.duplicate();
    const dupId = dup.id;
    app.project.save(tmpPath.div("out.aep"));
    const comp2 = parseAep(tmpPath.div("out.aep")).project.compositions[0];
    const dup2 = comp2.layers.find((lyr) => lyr.id === dupId);
    if (dup2 === undefined) throw new StopIteration();
    const dup2Tdpi = _tdpiByParamSuffix(dup2);
    expect(pyEq(new Set(getitem(dup2Tdpi, "-0000")), new Set([dupId]))).toBe(true);
    expect(pyEq(getitem(dup2Tdpi, "-0001"), [originalId])).toBe(true);
  });

  test("test_duplicate_preserves_name_from_source", () => {
    /** Source-derived names are not modified on duplicate. */
    const app = parseAep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = getComp(app.project, "crystal");
    const original = comp.layers[1]; // mov_23_976.mov - name from source
    expect(original.isNameSet).toBe(false);
    const dup = original.duplicate();
    expect(dup.name).toBe(original.name);
  });

  test("test_duplicate_increments_user_name", () => {
    /** User-defined names are incremented on duplicate. */
    const app = parseAep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = getComp(app.project, "crystal");
    const original = comp.layers[0]; // Environment Light 1 - user-defined
    expect(original.isNameSet).toBe(true);
    const dup = original.duplicate();
    expect(dup.name).toBe("Environment Light 2");
  });

  test("test_duplicate_increments_name_no_number", () => {
    /** User-defined name without trailing number gets ' 2' appended. */
    const app = parseAep(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = getComp(app.project, "parent");
    const parentNull = comp.layers[1]; // ParentNull - user-defined
    expect(parentNull.isNameSet).toBe(true);
    const dup = parentNull.duplicate();
    expect(dup.name).toBe("ParentNull 2");
  });

  test("test_duplicate_preserves_parent", () => {
    /** Duplicated layer keeps the same parent reference. */
    const app = parseAep(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = getComp(app.project, "parent");
    const child = comp.layers[0]; // ChildLayer, has parent
    expect(child._parentId).not.toBe(0);
    const dup = child.duplicate();
    expect(dup._parentId).toBe(child._parentId);
  });

  test("test_duplicate_preserves_matte", () => {
    /** Duplicated layer keeps the track matte reference. */
    const app = parseAep(SAMPLES_DIR.div("track_matte_yes.aep"));
    const comp = app.project.compositions[0];
    const matted = comp.layers[0]; // has matte_layer_id
    expect(matted._ldta.matteLayerId).not.toBe(0);
    const dup = matted.duplicate();
    expect(dup._ldta.matteLayerId).toBe(matted._ldta.matteLayerId);
  });

  test("test_duplicate_unique_id", () => {
    /** Each duplicate gets a unique layer ID. */
    const app = parseAep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = getComp(app.project, "crystal");
    const idsBefore = new Set(comp.layers.map((ly) => ly.id));
    const dup1 = comp.layers[0].duplicate();
    const dup2 = comp.layers[0].duplicate();
    const allIds = new Set(comp.layers.map((ly) => ly.id));
    expect(idsBefore.has(dup1.id)).toBe(false);
    expect(idsBefore.has(dup2.id)).toBe(false);
    expect(dup1.id).not.toBe(dup2.id);
    expect(len(allIds)).toBe(len(comp.layers));
  });

  test("test_duplicate_invalidates_cache", () => {
    const app = parseAep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = getComp(app.project, "crystal");
    void comp.layersById; // Build cache
    const dup = comp.layers[0].duplicate();
    expect(comp.layersById.has(dup.id)).toBe(true);
  });

  test("test_duplicate_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = getComp(app.project, "crystal");
    const dup = comp.layers[0].duplicate();
    const dupName = dup.name;
    const dupId = dup.id;

    app.project.save(tmpPath.div("out.aep"));
    const app2 = parseAep(tmpPath.div("out.aep"));
    const comp2 = getComp(app2.project, "crystal");
    expect(len(comp2.layers)).toBe(4);
    expect(comp2.layers[0].name).toBe(dupName);
    expect(comp2.layers[0].id).toBe(dupId);
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
    const app = parseAep(EG_DIR.div("text_source_text.aep"));
    const comp = getComp(app.project, "primary");
    const original = comp.layers[0];
    expect(original instanceof TextLayer).toBe(true);
    const dup = original.duplicate();
    if (original.text == null) throw new Error("original has no text group");
    if (dup.text == null) throw new Error("duplicate has no text group");
    const src = original.text.property("ADBE Text Document").value;
    const dupSrc = dup.text.property("ADBE Text Document").value;
    expect(pyEq(dupSrc.text, src.text)).toBe(true);
  });

  test("test_duplicate_masked_layer", () => {
    const app = parseAep(PROPERTY_DIR.div("shape_basic.aep"));
    const comp = getComp(app.project, "shape_closed_oval");
    const original = comp.layers[0];
    const dup = original.duplicate();
    if (original.masks == null) throw new Error("original has no masks group");
    if (dup.masks == null) throw new Error("duplicate has no masks group");
    const origShape = asInstance(original.masks.property(0), PropertyGroup).property("ADBE Mask Shape").value;
    const dupShape = asInstance(dup.masks.property(0), PropertyGroup).property("ADBE Mask Shape").value;
    expect(pyEq(dupShape.vertices, origShape.vertices)).toBe(true);
  });

  test("test_duplicate_every_layer_kind", () => {
    /** All layers of the animated sample duplicate without error. */
    const app = parseAep(PROPERTY_DIR.div("all_animated.aep"));
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
  /** Tests for Layer.copyToComp(). */

  test("test_copy_increases_count", () => {
    const app = parseAep(SAMPLES_DIR.div("layer_misc.aep"));
    const srcComp = getComp(app.project, "parent");
    const dstComp = getComp(app.project, "comment");
    expect(len(dstComp.layers)).toBe(1);
    srcComp.layers[0].copyToComp(dstComp);
    expect(len(dstComp.layers)).toBe(2);
  });

  test("test_copy_does_not_remove_from_source", () => {
    const app = parseAep(SAMPLES_DIR.div("layer_misc.aep"));
    const srcComp = getComp(app.project, "parent");
    const dstComp = getComp(app.project, "comment");
    const nBefore = len(srcComp.layers);
    srcComp.layers[0].copyToComp(dstComp);
    expect(len(srcComp.layers)).toBe(nBefore);
  });

  test("test_copy_placed_at_top", () => {
    /** Copied layer is at the top (index 0) of target comp. */
    const app = parseAep(SAMPLES_DIR.div("layer_misc.aep"));
    const srcComp = getComp(app.project, "parent");
    const dstComp = getComp(app.project, "comment");
    const originalName = srcComp.layers[0].name;
    srcComp.layers[0].copyToComp(dstComp);
    expect(dstComp.layers[0].name).toBe(originalName);
  });

  test("test_copy_clears_parent", () => {
    /** Copied layer has no parent in the target comp. */
    const app = parseAep(SAMPLES_DIR.div("layer_misc.aep"));
    const srcComp = getComp(app.project, "parent");
    const dstComp = getComp(app.project, "comment");
    const child = srcComp.layers[0]; // ChildLayer, has parent
    expect(child._parentId).not.toBe(0);
    child.copyToComp(dstComp);
    expect(dstComp.layers[0]._parentId).toBe(0);
  });

  test("test_same_comp_duplicates", () => {
    /** Copying to the same comp delegates to duplicate(). */
    const app = parseAep(SAMPLES_DIR.div("light_source_default.aep"));
    const comp = getComp(app.project, "crystal");
    expect(len(comp.layers)).toBe(3);
    const result = comp.layers[0].copyToComp(comp);
    expect(len(comp.layers)).toBe(4);
    expect(result).toBe(comp.layers[0]);
  });

  test("test_copy_returns_layer", () => {
    /** copy_to_comp returns the newly created layer. */
    const app = parseAep(SAMPLES_DIR.div("layer_misc.aep"));
    const srcComp = getComp(app.project, "parent");
    const dstComp = getComp(app.project, "comment");
    const result = srcComp.layers[0].copyToComp(dstComp);
    expect(result).toBe(dstComp.layers[0]);
  });

  test("test_copy_unique_id", () => {
    /** Copied layer gets an ID unique within the target comp. */
    const app = parseAep(SAMPLES_DIR.div("layer_misc.aep"));
    const srcComp = getComp(app.project, "parent");
    const dstComp = getComp(app.project, "comment");
    const existingIds = new Set(dstComp.layers.map((ly) => ly.id));
    srcComp.layers[0].copyToComp(dstComp);
    const newId = dstComp.layers[0].id;
    expect(existingIds.has(newId)).toBe(false);
  });

  test("test_copy_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("layer_misc.aep"));
    const srcComp = getComp(app.project, "parent");
    const dstComp = getComp(app.project, "comment");
    srcComp.layers[0].copyToComp(dstComp);
    const copiedName = dstComp.layers[0].name;
    const copiedId = dstComp.layers[0].id;

    app.project.save(tmpPath.div("out.aep"));
    const app2 = parseAep(tmpPath.div("out.aep"));
    const dst2 = getComp(app2.project, "comment");
    expect(len(dst2.layers)).toBe(2);
    expect(dst2.layers[0].name).toBe(copiedName);
    expect(dst2.layers[0].id).toBe(copiedId);
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
    const comp = py_aep.new().project.rootFolder.addComp("t", 100, 100, 1.0, 1.0, 30.0);
    const av = comp.addSolid([1.0, 0.0, 0.0]);
    const shape = comp.addShape();
    const camera = comp.addCamera();
    const light = comp.addLight();
    for (const layer of [av, shape]) {
      expect(layer._ldta._reserved3b).toBe(1);
      expect(layer._ldta._reserved3c).toBe(0);
    }
    for (const layer of [camera, light]) {
      expect(layer._ldta._reserved3b).toBe(0);
      expect(layer._ldta._reserved3c).toBe(0);
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
  function _probeLayer(project: Project, name: string): AVLayer {
    const comp = project.compositions.find((c) => c.name === "PROBE_MAIN");
    if (comp === undefined) throw new StopIteration();
    const layer = comp.layers.find((ly) => ly.name === name);
    if (layer === undefined) throw new StopIteration();
    return asInstance(layer, AVLayer);
  }

  test("test_along_path_with_separated_position_raises", () => {
    const project = parseProjectFresh(SAMPLES_DIR.div("geometry_probe.aep"));
    const layer = _probeLayer(project, "solid_keyed");
    layer.transform.property("ADBE Position").dimensionsSeparated = true;
    layer.autoOrient = AutoOrientType.ALONG_PATH;
    raises(NotImplementedError, () => {
      layer.sourcePointToComp([0.0, 0.0]);
    }, "separated");
  });

  test("test_parented_layer_towards_camera_raises", () => {
    const project = parseProjectFresh(SAMPLES_DIR.div("geometry_probe.aep"));
    const child = _probeLayer(project, "solid_parented");
    child.threeDLayer = true;
    child.autoOrient = AutoOrientType.CAMERA_OR_POINT_OF_INTEREST;
    raises(NotImplementedError, () => {
      child.compPointToSource([0.0, 0.0]);
    }, "towards the camera");
  });

  test("test_characters_towards_camera_raises", () => {
    const project = parseProjectFresh(SAMPLES_DIR.div("geometry_probe.aep"));
    const layer = _probeLayer(project, "text_point");
    layer.autoOrient = AutoOrientType.CHARACTERS_TOWARD_CAMERA;
    raises(NotImplementedError, () => {
      layer.sourcePointToComp([0.0, 0.0]);
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
  function _probe3dLayer(): AVLayer {
    const project = parseProjectFresh(SAMPLES_DIR.div("geometry_probe.aep"));
    const comp = project.compositions.find((c) => c.name === "PROBE_MAIN");
    if (comp === undefined) throw new StopIteration();
    const layer = comp.layers.find((ly) => ly.name === "solid_3d");
    if (layer === undefined) throw new StopIteration();
    return asInstance(layer, AVLayer);
  }

  test("test_layer_in_front_resolves", () => {
    const layer = _probe3dLayer();
    expect(layer.compPointToSource([100.0, 100.0]) != null).toBe(true);
  });

  test("test_layer_behind_camera_raises", () => {
    const layer = _probe3dLayer();
    // Default comp camera sits at z = -zoom; push the layer behind it.
    layer.transform.property("ADBE Position").value = [960.0, 540.0, -20000.0];
    raises(ValueError, () => {
      layer.compPointToSource([100.0, 100.0]);
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
    const tmpPath = makeTmpPath();
    /**
     * `outPoint_no_clamp.aep` carries AE's own ramp for a 5 s source:
     * disabling and re-enabling must reproduce it.
     */
    const project = parseProjectFresh(SAMPLES_DIR.div("outPoint_no_clamp.aep"));
    const comp = getComp(project, "outPoint_no_clamp_timeRemap");
    const layer = asInstance(comp.layers[0], AVLayer);
    const authored = layer.property("ADBE Time Remapping").keyframes.map((k) => [k.time, k.value]);
    expect(pyEq(authored, [[0.0, 0.0], [5.0, 5.0]])).toBe(true);

    layer.timeRemapEnabled = false;
    layer.timeRemapEnabled = true;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const comp2 = getComp(parseAep(out).project, "outPoint_no_clamp_timeRemap");
    const remap = comp2.layers[0].property("ADBE Time Remapping");
    expect(pyEq(remap.keyframes.map((k) => [k.time, k.value]), authored)).toBe(true);
  });

  test("test_ramp_is_linear", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("outPoint_no_clamp.aep"));
    const layer = asInstance(getComp(project, "outPoint_no_clamp_timeRemap").layers[0], AVLayer);
    layer.timeRemapEnabled = false;
    layer.timeRemapEnabled = true;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const comp2 = getComp(parseAep(out).project, "outPoint_no_clamp_timeRemap");
    for (const keyframe of comp2.layers[0].property("ADBE Time Remapping").keyframes) {
      expect(keyframe.inInterpolationType).toBe(KeyframeInterpolationType.LINEAR);
      expect(keyframe.outInterpolationType).toBe(KeyframeInterpolationType.LINEAR);
    }
  });

  test("test_ramp_starts_at_the_layer_start_not_the_in_point", () => {
    /**
     * AE anchors the ramp to `start_time`; an in point trimmed later
     * does not move it.
     */
    const project = parseProjectFresh(SAMPLES_DIR.div("outPoint_no_clamp.aep"));
    const layer = asInstance(getComp(project, "outPoint_no_clamp_timeRemap").layers[0], AVLayer);
    layer.timeRemapEnabled = false;
    layer.startTime = 2.0;
    layer.inPoint = 3.0;
    layer.timeRemapEnabled = true;

    const source = asInstance(layer.source, AVItem);
    const times = layer.property("ADBE Time Remapping").keyframes.map((k) => k.time);
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
    const project = parseProjectFresh(SAMPLES_DIR.div("auto_orient.aep"));
    const comp = project.compositions.find((c) => c.name === "ORIENT_CAM");
    if (comp === undefined) throw new StopIteration();
    const child = comp.layers.find((ly) => ly.name === "child_of_cam");
    if (child === undefined) throw new StopIteration();
    const camera = child.parent;
    child.parent = null;
    child.transform.property("ADBE Position").value = [960.0, 540.0, 0.0];
    child.transform.property("ADBE Orientation").value = [0.0, 0.0, 0.0];
    child.parent = camera;
    const orientation = child.transform.property("ADBE Orientation").value;
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
    return asInstance(layer, TextLayer);
  }

  test("test_faux_bold_raises", () => {
    const layer = _hello(parseProjectFresh(SAMPLES_DIR.div("text_ink.aep")));
    pyAssert(layer.text != null);
    layer.text.property("ADBE Text Document").value.fauxBold = true;
    raises(NotImplementedError, () => {
      layer.sourceRectAtTime(0.0, false);
    }, "faux bold");
  });

  test("test_text_animator_raises", () => {
    const layer = _hello(parseProjectFresh(SAMPLES_DIR.div("text_ink.aep")));
    pyAssert(layer.text != null);
    layer.text.property("ADBE Text Animators").addProperty("ADBE Text Animator");
    raises(NotImplementedError, () => {
      layer.sourceRectAtTime(0.0, false);
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
  ])("test_follows_the_comp_centre[%s]", (_id: string, buildFirst: boolean) => {
    const comp = getComp(parseProjectFresh(VERSIONS_DIR.div("ae2024", "complete.aep")), "Main_Comp");
    const light = comp.layers.find((la) => la.name === "Light_Point");
    if (light === undefined) throw new StopIteration();
    if (buildFirst) {
      void light.properties;
    }
    comp.width += 64;
    const poi = light.transform.property("ADBE Anchor Point");
    expect(pyEq(poi.value, [960.0, 540.0, 0.0])).toBe(true);
    expect(pyEq(poi.defaultValue, [992.0, 540.0, 0.0])).toBe(true);
    expect(poi.isModified).toBe(true);
  });
});

describe("TestNullOpacity", () => {
  /**
   * A null's Opacity defaults to 0: left out, it reads 0, while a written
   * value reads back as written (AE 2026 reads 100 from py's file).
   */

  test.each([[100.0], [50.0]])("test_written_opacity_reads_back[%p]", (written: number) => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("auto_orient.aep"));
    const layer = project.compositions[0].layers[1];
    expect(layer.nullLayer).toBe(true);
    let opacity = layer.transform.property("ADBE Opacity");
    expect([opacity.value, opacity.isModified]).toEqual([0.0, false]);
    opacity.value = written;
    const out = tmpPath.div("opacity.aep");
    project.save(out);
    const reopened = parseProjectFresh(out).compositions[0].layers[1];
    opacity = reopened.transform.property("ADBE Opacity");
    expect([opacity.value, opacity.defaultValue, opacity.isModified]).toEqual([written, 0.0, true]);
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
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.parent.div("composition", "duplicate.aep"));
    const comp = getComp(project, "AltSrc");
    const precomp = project.rootFolder.addComp("pc", 200, 100, 1.0, 10.0, 24.0);
    const layers = [0, 1].map((i) =>
      change === "precomp_resize"
        ? comp.add(precomp)
        : comp.addSolid([1.0, 0.0, 0.0], `S${i}`, 200, 100, 1.0),
    );
    layers[1].transform.property("ADBE Anchor Point").value = [30.0, 40.0, 0.0];
    if (change === "replace_source") {
      const big = comp.addSolid([0.0, 0.0, 1.0], "Big", 400, 200, 1.0).source;
      if (big == null) throw new StopIteration();
      for (const layer of layers) {
        layer.replaceSource(big);
      }
    } else if (change === "solid_resize") {
      for (const layer of layers) {
        const solid = asInstance(layer.source, FootageItem);
        const mainSource = asInstance(solid.mainSource, SolidSource);
        solid.replaceWithSolid(mainSource.color, solid.name, 400, 100);
      }
    } else {
      precomp.width = 400;
    }

    function anchors(layers: Layer[]): [number[], boolean][] {
      const props = layers.map((layer) => layer.transform.property("ADBE Anchor Point"));
      return props.map((p): [number[], boolean] => [[...p.value], p.isModified]);
    }

    const expected = [
      [centre, false],
      [stored, true],
    ];
    expect(pyEq(anchors(layers), expected)).toBe(true);
    const out = tmpPath.div("changed.aep");
    project.save(out);
    const byId = new Map(getComp(parseProjectFresh(out), "AltSrc").layers.map((la): [number, Layer] => [la.id, la]));
    expect(pyEq(anchors(layers.map((layer) => getitem(byId, layer.id))), expected)).toBe(true);
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
    const layers = _layers(parseProjectFresh(SAMPLE));
    expect(layers.length > 0).toBe(true);
    for (const layer of layers) {
      void [layer.name, layer.inPoint, layer.outPoint, layer.enabled];
      void layer.label;
      if (layer instanceof AVLayer) {
        // (A missing attribute would search the children by name.)
        void layer.source;
      }
      expect(layer._treeParamDefs != null).toBe(true);
      // Times may decode the root tdgp (Time Remapping), not its groups.
      const root = asInstance(layer._tdgp, DeferredListChunk);
      const groups = (root.isParsed ? root.chunks : []).filter(
        (c) => c instanceof ListChunk && c.listType === "tdgp",
      );
      expect(groups.every((g) => g instanceof DeferredListChunk && !g.isParsed)).toBe(true);
    }
  });

  test("test_first_access_builds_the_tree", () => {
    const layer = _layers(parseProjectFresh(SAMPLE))[0];
    expect(layer.transform != null).toBe(true);
    expect(layer._treeParamDefs == null).toBe(true);
    expect(layer.properties.every((p) => p.parentProperty === layer)).toBe(true);
  });

  test("test_unbuilt_layers_save_unchanged", () => {
    const project = parseProjectFresh(SAMPLE);
    for (const layer of _layers(project)) {
      void [layer.inPoint, layer.outPoint];
    }
    expect(pyEq(projectBytes(project), SAMPLE.readBytes())).toBe(true);
  });

  const mutations: [string, (comp: CompItem, layer: Layer) => void][] = [
    ["width", (comp) => (comp.width = comp.width + 64)],
    ["height", (comp) => (comp.height = comp.height + 64)],
    ["pixelAspect", (comp) => (comp.pixelAspect = 2.0)],
    ["threeDLayer", (_comp, layer) => (asInstance(layer, AVLayer).threeDLayer = true)],
    ["stretch", (_comp, layer) => (layer.stretch = 200.0)],
  ];

  test.each(mutations)(
    "test_change_before_first_access_matches_a_built_tree[%s]",
    (_id: string, mutate: (comp: CompItem, layer: Layer) => void) => {
      /**
       * State a built tree depends on, changed before the tree is built,
       * saves what the change on a built tree saves.
       */
      const tmpPath = makeTmpPath();
      const sample = new Path(import.meta.path).parent.parent.parent.div("samples/models/property/2_gaussian.aep");
      const saved: Uint8Array[] = [];
      for (const buildFirst of [true, false]) {
        const project = parseProjectFresh(sample);
        const comp = project.compositions[0];
        const layer = comp.layers[0];
        if (buildFirst) {
          for (const each of comp.layers) {
            void each.properties;
          }
        }
        mutate(comp, layer);
        // `save`, which writes out the moved left-out defaults.
        const out = tmpPath.div(`built_${buildFirst ? "True" : "False"}.aep`);
        project.save(out);
        saved.push(out.readBytes());
      }
      expect(pyEq(saved[0], saved[1])).toBe(true);
    },
  );

  test.each([
    ["True", true],
    ["False", false],
  ])("test_effect_definitions_do_not_depend_on_build_order[%s]", (_id: string, holderFirst: boolean) => {
    /**
     * AE writes an effect's parameter definitions in one of its
     * instances only (this project has no `EfdG`): a layer built before
     * that one still finds them.
     */
    const comps = parseProjectFresh(BUGS_DIR.div("29.97_fps_time_scale_3.125.aep")).compositions;
    const holder = comps[0].layers[0];
    const other = comps[1].layers[0];
    for (const layer of holderFirst ? [holder, other] : [other, holder]) {
      void layer.properties;
    }
    const effect = asInstance(other.property("ADBE Effect Parade").property("ADBE Geometry2"), PropertyGroup);
    // As AE 15.1 reports: GPU Rendering is an effect parameter in AE 15,
    // not a Compositing Options one.
    expect(effect.numProperties).toBe(14);
    expect(effect.properties[12].matchName).toBe("ADBE Force CPU GPU");
    expect(asInstance(effect.property("ADBE Effect Built In Params"), PropertyGroup).numProperties).toBe(2);
  });

  test.each([["layer"], ["effect"], ["comp"]])(
    "test_effect_definitions_outlive_their_holder[%s]",
    (removed: string) => {
      /**
       * Removing the instance that holds an effect's definitions hands
       * them to the next one, as AE 15's own save does: the file has no
       * `EfdG` to hold them instead.
       */
      const tmpPath = makeTmpPath();
      const project = parseProjectFresh(BUGS_DIR.div("29.97_fps_time_scale_3.125.aep"));
      const [holderComp, otherComp] = project.compositions;
      const holder = holderComp.layers[0];
      if (removed === "layer") {
        holder.remove();
      } else if (removed === "effect") {
        holder.property("ADBE Effect Parade").property("ADBE Geometry2").remove();
      } else {
        holderComp.remove();
      }
      const otherId = otherComp.id;
      let effect = asInstance(
        otherComp.layers[0].property("ADBE Effect Parade").property("ADBE Geometry2"),
        PropertyGroup,
      );
      expect(effect.numProperties).toBe(14);
      const out = tmpPath.div("removed.aep");
      project.save(out);
      const reopened = parseProjectFresh(out).compositions.find((c) => c.id === otherId);
      if (reopened === undefined) throw new StopIteration();
      effect = asInstance(reopened.layers[0].property("ADBE Effect Parade").property("ADBE Geometry2"), PropertyGroup);
      expect(effect.numProperties).toBe(14);
    },
  );

  test("test_failed_build_raises_again", () => {
    /** A build that fails leaves the layer unbuilt, not half-built. */
    const layer = _layers(parseProjectFresh(SAMPLE))[0];

    // NOTE(port): Python monkeypatches `layer.parse_properties`; ESM bindings are read-only, so the
    // instance's `_buildPropertyTree` (whose first call is `parse_properties`) fails instead.
    layer._buildPropertyTree = () => {
      throw new RuntimeError("corrupt layer");
    };
    for (let i = 0; i < 2; i++) {
      raises(RuntimeError, () => {
        void layer.properties;
      }, "corrupt layer");
    }
    Reflect.deleteProperty(layer, "_buildPropertyTree");
    expect(layer.transform != null).toBe(true);
  });

  test("test_comp_resize_writes_a_moved_left_out_position", () => {
    /**
     * AE 2026 keeps a left-out Position where it was when its comp is
     * resized and writes it (a solid, a text, a shape and a null layer).
     */
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("enabled_false.aep"));
    const comp = getComp(project, "TestComp");
    expect(comp.layers[0].transform.property("ADBE Position")._tdsb?.synthetic).toBe(true);
    comp.width = 164;
    const out = tmpPath.div("resized.aep");
    project.save(out);
    const position = getComp(parseProjectFresh(out), "TestComp").layers[0].transform.property("ADBE Position");
    expect(position._tdsb?.synthetic).toBe(false);
    expect(pyEq(position.value, [50.0, 50.0, 0.0])).toBe(true);
    expect(position.isModified).toBe(true);
  });

  test("test_time_remap_enabled_leaves_the_tree_unbuilt", () => {
    const project = parseProjectFresh(SAMPLE);
    const layers = _layers(project).filter((la) => la instanceof AVLayer);
    const flags = layers.map((la) => la.timeRemapEnabled);
    expect(layers.every((la) => la._treeParamDefs != null)).toBe(true);
    // The same answer as the property it is read from.
    expect(flags).toEqual(
      layers.map((la) =>
        la.properties.map((p) => p.matchName).includes("ADBE Time Remapping")
          ? !!la.property("ADBE Time Remapping")._animated
          : false,
      ),
    );
    expect(flags.some((f) => f)).toBe(true);
  });

  test("test_essential_property_uuids_leave_the_tree_unbuilt", () => {
    const project = parseProjectFresh(
      new Path(import.meta.path).parent.parent.parent.div("samples", "models", "essential_graphics", "multiple_controllers.aep"),
    );
    const main = getComp(project, "main");
    expect(main.layers.filter((la) => la.essentialPropertyUuids.length === 3).length).toBe(1);
    expect(main.layers.every((la) => la._treeParamDefs != null)).toBe(true);
  });
});
