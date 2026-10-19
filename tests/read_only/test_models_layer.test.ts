/** Tests for Layer model parsing. */

// `from __future__ import annotations` is dropped: no annotation here is
// evaluated at runtime. `math.isclose` is the pyrt `isclose` (num.ts), and the
// keyword-only `abs_tol=` becomes its fourth positional argument.

import { describe, expect, test } from "bun:test";

import {
  AttributeError,
  IndexError,
  KeyError,
  Path,
  StopIteration,
  ValueError,
  isclose,
  len,
  assert,
  truthy,
  valueEquals,
  repr,
  zip,
  getMember,
} from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import {
  getComp,
  getFirstLayer,
  getLayer,
  getLayerFromJson,
  getLayerFromJsonByComp,
  loadExpected,
  parseProject,
} from "../conftest.ts";
import { asInstance, jsonField } from "../helpers.ts";
import { parse as parseAep } from "../../src/py_aep/index.ts";
import {
  AutoOrientType,
  BlendingMode,
  FrameBlendingType,
  LayerQuality,
  LayerSamplingQuality,
  LightType,
  PropertyType,
  TrackMatteType,
} from "../../src/py_aep/enums/index.ts";
import { AVLayer, CameraLayer, LightLayer, ShapeLayer, TextLayer } from "../../src/py_aep/models/layers/index.ts";
import { ThreeDModelLayer } from "../../src/py_aep/models/layers/three_d_model_layer.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { PropertyBase } from "../../src/py_aep/models/properties/property_base.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";
import { raises } from "../support/pytest.ts";

// Python `Path(__file__).parent.parent.parent` is the repo root. A TS file's
// `import.meta.dir` is already its directory, so two `.parent` steps reach it.
const SAMPLES_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "layer");
const BUGS_DIR = new Path(import.meta.dir).parent.parent.div("samples", "bugs");

// NOTE(port): matches `list.index`: first match, ValueError "<repr> is not in list" when absent.
function _listIndex(xs: string[], x: string): number {
  const i = xs.indexOf(x);
  if (i < 0) throw new ValueError(`${repr(x)} is not in list`);
  return i;
}

/** Tests for basic layer attributes. */
describe("TestLayerBasic", () => {
  test("test_enabled_false", () => {
    const expected = loadExpected(SAMPLES_DIR, "layer_switches");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    const layerJson = getLayerFromJsonByComp(expected, "enabled_false");
    expect(layerJson["enabled"]).toBe(false);
    expect(layer.enabled).toBe(layerJson["enabled"]);
  });

  test("test_locked_true", () => {
    const expected = loadExpected(SAMPLES_DIR, "layer_switches");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_switches.aep")), "locked_true");
    const layerJson = getLayerFromJsonByComp(expected, "locked_true");
    expect(layerJson["locked"]).toBe(true);
    expect(layer.locked).toBe(layerJson["locked"]);
  });

  test("test_shy_true", () => {
    const expected = loadExpected(SAMPLES_DIR, "layer_switches");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_switches.aep")), "shy_true");
    const layerJson = getLayerFromJsonByComp(expected, "shy_true");
    expect(layerJson["shy"]).toBe(true);
    expect(layer.shy).toBe(layerJson["shy"]);
  });

  test("test_solo_true", () => {
    const expected = loadExpected(SAMPLES_DIR, "layer_switches");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_switches.aep")), "solo_true");
    const layerJson = getLayerFromJsonByComp(expected, "solo_true");
    expect(layerJson["solo"]).toBe(true);
    expect(layer.solo).toBe(layerJson["solo"]);
  });

  test("test_name_renamed", () => {
    const expected = loadExpected(SAMPLES_DIR, "layer_misc");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_misc.aep")), "name_renamed");
    const layerJson = getLayerFromJsonByComp(expected, "name_renamed");
    expect(layer.name).toBe(layerJson["name"]);
    expect(layerJson["name"]).toBe("RenamedLayer");
  });

  test("test_comment", () => {
    const expected = loadExpected(SAMPLES_DIR, "layer_misc");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_misc.aep")), "comment");
    const layerJson = getLayerFromJsonByComp(expected, "comment");
    expect(layer.comment).toBe(layerJson["comment"]);
    expect(layerJson["comment"]).toBe("Test layer comment");
  });

  test("test_label_3", () => {
    const expected = loadExpected(SAMPLES_DIR, "layer_misc");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_misc.aep")), "label_3");
    const layerJson = getLayerFromJsonByComp(expected, "label_3");
    expect(layerJson["label"]).toBe(3);
    // IntEnum members are plain numbers, so `.value` is the member itself.
    expect(layer.label).toBe(layerJson["label"]);
  });
});

/** Tests for layer timing attributes. */
describe("TestLayerTiming", () => {
  test("test_startTime_5", () => {
    const expected = loadExpected(SAMPLES_DIR, "layer_timing");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_timing.aep")), "startTime_5");
    const layerJson = getLayerFromJsonByComp(expected, "startTime_5");
    expect(layerJson["startTime"]).toBe(5);
    expect(isclose(layer.startTime, layerJson["startTime"])).toBe(true);
  });

  test("test_inPoint_5", () => {
    const expected = loadExpected(SAMPLES_DIR, "inPoint");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("inPoint.aep")), "inPoint_5");
    const layerJson = getLayerFromJsonByComp(expected, "inPoint_5");
    expect(layerJson["inPoint"]).toBe(5);
    expect(isclose(layer.inPoint, layerJson["inPoint"])).toBe(true);
  });

  test("test_outPoint_10", () => {
    const expected = loadExpected(SAMPLES_DIR, "outPoint");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("outPoint.aep")), "outPoint_10");
    const layerJson = getLayerFromJsonByComp(expected, "outPoint_10");
    expect(layerJson["outPoint"]).toBe(10);
    expect(isclose(layer.outPoint, layerJson["outPoint"])).toBe(true);
  });

  test("test_stretch_200", () => {
    const expected = loadExpected(SAMPLES_DIR, "layer_timing");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_timing.aep")), "stretch_200");
    const layerJson = getLayerFromJsonByComp(expected, "stretch_200");
    expect(layerJson["stretch"]).toBe(200);
    expect(isclose(layer.stretch, layerJson["stretch"])).toBe(true);
  });

  test("test_stretch_minus100", () => {
    const expected = loadExpected(SAMPLES_DIR, "layer_timing");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_timing.aep")), "stretch_minus100");
    const layerJson = getLayerFromJsonByComp(expected, "stretch_minus100");
    expect(layerJson["stretch"]).toBe(-100);
    expect(isclose(layer.stretch, layerJson["stretch"])).toBe(true);
  });
});

/** Tests for outPoint/inPoint clamping with precomp sources. */
describe("TestTimingEdgeCases", () => {
  /** Precomp dur=5s, main comp=30s. OutPoint clamped to 5. */
  test("test_outPoint_clamp_precomp", () => {
    const expected = loadExpected(SAMPLES_DIR, "outPoint_clamp");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("outPoint_clamp.aep")), "outPoint_clamp_precomp");
    const layerJson = getLayerFromJsonByComp(expected, "outPoint_clamp_precomp");
    expect(isclose(layer.outPoint, layerJson["outPoint"], 1e-9, 0.001)).toBe(true);
    expect(isclose(layer.outPoint, 5.0, 1e-9, 0.001)).toBe(true);
  });

  /** Precomp dur=5s, stretch=200%. OutPoint clamped to 10. */
  test("test_outPoint_clamp_stretch_200", () => {
    const expected = loadExpected(SAMPLES_DIR, "outPoint_clamp");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("outPoint_clamp.aep")), "outPoint_clamp_stretch_200");
    const layerJson = getLayerFromJsonByComp(expected, "outPoint_clamp_stretch_200");
    expect(isclose(layer.stretch, 200.0)).toBe(true);
    expect(isclose(layer.outPoint, layerJson["outPoint"], 1e-9, 0.001)).toBe(true);
    expect(isclose(layer.outPoint, 10.0, 1e-9, 0.001)).toBe(true);
  });

  /** Precomp dur=5s, stretch=400%. OutPoint clamped to 20. */
  test("test_outPoint_clamp_stretch_400", () => {
    const expected = loadExpected(SAMPLES_DIR, "outPoint_clamp");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("outPoint_clamp.aep")), "outPoint_clamp_stretch_400");
    const layerJson = getLayerFromJsonByComp(expected, "outPoint_clamp_stretch_400");
    expect(isclose(layer.stretch, 400.0)).toBe(true);
    expect(isclose(layer.outPoint, layerJson["outPoint"], 1e-9, 0.001)).toBe(true);
    expect(isclose(layer.outPoint, 20.0, 1e-9, 0.001)).toBe(true);
  });

  /** Precomp dur=5s, collapse=True. AE still clamps to 5. */
  test("test_outPoint_clamp_collapse", () => {
    const expected = loadExpected(SAMPLES_DIR, "outPoint_no_clamp");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("outPoint_no_clamp.aep")), "outPoint_no_clamp_collapse");
    const layerJson = getLayerFromJsonByComp(expected, "outPoint_no_clamp_collapse");
    expect(asInstance(layer, AVLayer).collapseTransformation).toBe(true);
    expect(isclose(layer.outPoint, layerJson["outPoint"], 1e-9, 0.001)).toBe(true);
    expect(isclose(layer.outPoint, 5.0, 1e-9, 0.001)).toBe(true);
  });

  /** Precomp dur=5s, timeRemap=True. OutPoint NOT clamped (stays 30). */
  test("test_outPoint_no_clamp_timeRemap", () => {
    const expected = loadExpected(SAMPLES_DIR, "outPoint_no_clamp");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("outPoint_no_clamp.aep")), "outPoint_no_clamp_timeRemap");
    const layerJson = getLayerFromJsonByComp(expected, "outPoint_no_clamp_timeRemap");
    expect(asInstance(layer, AVLayer).timeRemapEnabled).toBe(true);
    expect(isclose(layer.outPoint, layerJson["outPoint"], 1e-9, 0.001)).toBe(true);
    expect(isclose(layer.outPoint, 30.0, 1e-9, 0.001)).toBe(true);
  });

  /** Precomp dur=5s, stretch=-100%. Clamping skipped. */
  test("test_outPoint_no_clamp_negative_stretch", () => {
    const expected = loadExpected(SAMPLES_DIR, "outPoint_no_clamp");
    const layer = getLayer(
      parseProject(SAMPLES_DIR.div("outPoint_no_clamp.aep")),
      "outPoint_no_clamp_negative_stretch",
    );
    const layerJson = getLayerFromJsonByComp(expected, "outPoint_no_clamp_negative_stretch");
    expect(isclose(layer.stretch, -100.0)).toBe(true);
    expect(isclose(layer.outPoint, layerJson["outPoint"], 1e-9, 0.001)).toBe(true);
  });

  /** Precomp dur=5s, startTime=3s. OutPoint clamped to 3+5=8. */
  test("test_outPoint_clamp_with_startTime", () => {
    const expected = loadExpected(SAMPLES_DIR, "outPoint_clamp");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("outPoint_clamp.aep")), "outPoint_clamp_with_startTime");
    const layerJson = getLayerFromJsonByComp(expected, "outPoint_clamp_with_startTime");
    expect(isclose(layer.startTime, 3.0, 1e-9, 0.001)).toBe(true);
    expect(isclose(layer.outPoint, layerJson["outPoint"], 1e-9, 0.001)).toBe(true);
    expect(isclose(layer.outPoint, 8.0, 1e-9, 0.001)).toBe(true);
  });

  /** Layer with inPoint (5) before startTime (10). */
  test("test_inPoint_before_startTime", () => {
    const expected = loadExpected(SAMPLES_DIR, "inPoint");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("inPoint.aep")), "inPoint_before_startTime");
    const layerJson = getLayerFromJsonByComp(expected, "inPoint_before_startTime");
    expect(isclose(layer.inPoint, layerJson["inPoint"])).toBe(true);
    expect(isclose(layer.inPoint, 5.0)).toBe(true);
    expect(isclose(layer.startTime, layerJson["startTime"])).toBe(true);
    expect(isclose(layer.startTime, 10.0)).toBe(true);
  });

  /** Layer with negative startTime (-5) and outPoint (20). */
  test("test_outPoint_with_negative_startTime", () => {
    const expected = loadExpected(SAMPLES_DIR, "outPoint");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("outPoint.aep")), "outPoint_with_negative_startTime");
    const layerJson = getLayerFromJsonByComp(expected, "outPoint_with_negative_startTime");
    expect(isclose(layer.startTime, layerJson["startTime"])).toBe(true);
    expect(isclose(layer.startTime, -5.0)).toBe(true);
    expect(isclose(layer.inPoint, layerJson["inPoint"])).toBe(true);
    expect(isclose(layer.inPoint, -5.0)).toBe(true);
    expect(isclose(layer.outPoint, layerJson["outPoint"])).toBe(true);
    expect(isclose(layer.outPoint, 20.0)).toBe(true);
  });
});

/** Tests for different layer types. */
describe("TestLayerTypes", () => {
  test("test_type_camera", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("type.aep")), "type_camera");
    expect(layer.layerType).toBe("CameraLayer");
    expect(layer instanceof CameraLayer).toBe(true);
  });

  test("test_type_null", () => {
    const expected = loadExpected(SAMPLES_DIR, "type");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("type.aep")), "type_null");
    const layerJson = getLayerFromJsonByComp(expected, "type_null");
    expect(layerJson["nullLayer"]).toBe(true);
    expect(layer.nullLayer).toBe(layerJson["nullLayer"]);
  });

  test("test_type_shape", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("type.aep")), "type_shape");
    expect(layer.layerType).toBe("Layer");
    expect(layer instanceof ShapeLayer).toBe(true);
  });

  test("test_type_text", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("type.aep")), "type_text");
    expect(layer.layerType).toBe("Layer");
    expect(layer instanceof TextLayer).toBe(true);
  });
});

/** Tests for light layer types. */
describe("TestLightTypes", () => {
  test("test_lightType_AMBIENT", () => {
    const expected = loadExpected(SAMPLES_DIR, "lightType");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("lightType.aep")), "lightType_AMBIENT");
    const layerJson = getLayerFromJsonByComp(expected, "lightType_AMBIENT");
    expect(asInstance(layer, LightLayer).lightType).toBe(layerJson["lightType"]);
    expect(layerJson["lightType"]).toBe(LightType.AMBIENT);
  });

  test("test_lightType_POINT", () => {
    const expected = loadExpected(SAMPLES_DIR, "lightType");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("lightType.aep")), "lightType_POINT");
    const layerJson = getLayerFromJsonByComp(expected, "lightType_POINT");
    expect(asInstance(layer, LightLayer).lightType).toBe(layerJson["lightType"]);
    expect(layerJson["lightType"]).toBe(LightType.POINT);
  });

  test("test_lightType_SPOT", () => {
    const expected = loadExpected(SAMPLES_DIR, "lightType");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("lightType.aep")), "lightType_SPOT");
    const layerJson = getLayerFromJsonByComp(expected, "lightType_SPOT");
    expect(asInstance(layer, LightLayer).lightType).toBe(layerJson["lightType"]);
    expect(layerJson["lightType"]).toBe(LightType.SPOT);
  });

  test("test_lightType_PARALLEL", () => {
    const expected = loadExpected(SAMPLES_DIR, "lightType");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("lightType.aep")), "lightType_PARALLEL");
    const layerJson = getLayerFromJsonByComp(expected, "lightType_PARALLEL");
    expect(asInstance(layer, LightLayer).lightType).toBe(layerJson["lightType"]);
    expect(layerJson["lightType"]).toBe(LightType.PARALLEL);
  });

  test("test_lightType_ENVIRONMENT", () => {
    const project = parseProject(SAMPLES_DIR.div("light_source_default.aep"));
    const layer = getFirstLayer(project);
    expect(layer instanceof LightLayer).toBe(true);
    expect(asInstance(layer, LightLayer).lightType).toBe(LightType.ENVIRONMENT);
  });
});

/** Tests for AVLayer-specific attributes. */
describe("TestAVLayerAttributes", () => {
  test("test_threeDLayer_true", () => {
    const expected = loadExpected(SAMPLES_DIR, "avlayer_flags");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("avlayer_flags.aep")), "threeDLayer_true");
    const layerJson = getLayerFromJsonByComp(expected, "threeDLayer_true");
    expect(layer instanceof AVLayer).toBe(true);
    expect(layerJson["threeDLayer"]).toBe(true);
    expect(asInstance(layer, AVLayer).threeDLayer).toBe(layerJson["threeDLayer"]);
  });

  test("test_adjustmentLayer_true", () => {
    const expected = loadExpected(SAMPLES_DIR, "avlayer_flags");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("avlayer_flags.aep")), "adjustmentLayer_true");
    const layerJson = getLayerFromJsonByComp(expected, "adjustmentLayer_true");
    expect(layer.adjustmentLayer).toBe(layerJson["adjustmentLayer"]);
    expect(layerJson["adjustmentLayer"]).toBe(true);
  });

  test("test_guideLayer_true", () => {
    const expected = loadExpected(SAMPLES_DIR, "avlayer_flags");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("avlayer_flags.aep")), "guideLayer_true");
    const layerJson = getLayerFromJsonByComp(expected, "guideLayer_true");
    expect(asInstance(layer, AVLayer).guideLayer).toBe(layerJson["guideLayer"]);
    expect(layerJson["guideLayer"]).toBe(true);
  });

  test("test_collapseTransformation_true", () => {
    const expected = loadExpected(SAMPLES_DIR, "avlayer_flags");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("avlayer_flags.aep")), "collapseTransformation_true");
    const layerJson = getLayerFromJsonByComp(expected, "collapseTransformation_true");
    expect(asInstance(layer, AVLayer).collapseTransformation).toBe(layerJson["collapseTransformation"]);
    expect(layerJson["collapseTransformation"]).toBe(true);
  });

  test("test_preserveTransparency_true", () => {
    const expected = loadExpected(SAMPLES_DIR, "avlayer_flags");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("avlayer_flags.aep")), "preserveTransparency_true");
    const layerJson = getLayerFromJsonByComp(expected, "preserveTransparency_true");
    expect(asInstance(layer, AVLayer).preserveTransparency).toBe(layerJson["preserveTransparency"]);
    expect(layerJson["preserveTransparency"]).toBe(true);
  });

  test("test_motionBlur_true", () => {
    const expected = loadExpected(SAMPLES_DIR, "avlayer_flags");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("avlayer_flags.aep")), "motionBlur_true");
    const layerJson = getLayerFromJsonByComp(expected, "motionBlur_true");
    expect(asInstance(layer, AVLayer).motionBlur).toBe(layerJson["motionBlur"]);
    expect(layerJson["motionBlur"]).toBe(true);
  });

  test("test_effectsActive_false", () => {
    const expected = loadExpected(SAMPLES_DIR, "avlayer_flags");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("avlayer_flags.aep")), "effectsActive_false");
    const layerJson = getLayerFromJsonByComp(expected, "effectsActive_false");
    expect(layerJson["effectsActive"]).toBe(false);
    expect(asInstance(layer, AVLayer).effectsActive).toBe(layerJson["effectsActive"]);
  });
});

/** Tests for blending mode attributes. */
describe("TestBlendingModes", () => {
  test("test_blendingMode_ADD", () => {
    const expected = loadExpected(SAMPLES_DIR, "blendingMode");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("blendingMode.aep")), "blendingMode_ADD");
    const layerJson = getLayerFromJsonByComp(expected, "blendingMode_ADD");
    expect(asInstance(layer, AVLayer).blendingMode).toBe(layerJson["blendingMode"]);
    expect(layerJson["blendingMode"]).toBe(BlendingMode.ADD);
  });

  test("test_blendingMode_MULTIPLY", () => {
    const expected = loadExpected(SAMPLES_DIR, "blendingMode");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("blendingMode.aep")), "blendingMode_MULTIPLY");
    const layerJson = getLayerFromJsonByComp(expected, "blendingMode_MULTIPLY");
    expect(asInstance(layer, AVLayer).blendingMode).toBe(layerJson["blendingMode"]);
    expect(layerJson["blendingMode"]).toBe(BlendingMode.MULTIPLY);
  });

  test("test_blendingMode_SCREEN", () => {
    const expected = loadExpected(SAMPLES_DIR, "blendingMode");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("blendingMode.aep")), "blendingMode_SCREEN");
    const layerJson = getLayerFromJsonByComp(expected, "blendingMode_SCREEN");
    expect(asInstance(layer, AVLayer).blendingMode).toBe(layerJson["blendingMode"]);
    expect(layerJson["blendingMode"]).toBe(BlendingMode.SCREEN);
  });
});

/** Tests for layer quality settings. */
describe("TestQualitySettings", () => {
  test("test_quality_BEST", () => {
    const expected = loadExpected(SAMPLES_DIR, "quality");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("quality.aep")), "quality_BEST");
    const layerJson = getLayerFromJsonByComp(expected, "quality_BEST");
    expect(asInstance(layer, AVLayer).quality).toBe(layerJson["quality"]);
    expect(layerJson["quality"]).toBe(LayerQuality.BEST);
  });

  test("test_quality_DRAFT", () => {
    const expected = loadExpected(SAMPLES_DIR, "quality");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("quality.aep")), "quality_DRAFT");
    const layerJson = getLayerFromJsonByComp(expected, "quality_DRAFT");
    expect(asInstance(layer, AVLayer).quality).toBe(layerJson["quality"]);
    expect(layerJson["quality"]).toBe(LayerQuality.DRAFT);
  });

  test("test_quality_WIREFRAME", () => {
    const expected = loadExpected(SAMPLES_DIR, "quality");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("quality.aep")), "quality_WIREFRAME");
    const layerJson = getLayerFromJsonByComp(expected, "quality_WIREFRAME");
    expect(asInstance(layer, AVLayer).quality).toBe(layerJson["quality"]);
    expect(layerJson["quality"]).toBe(LayerQuality.WIREFRAME);
  });

  test("test_samplingQuality_BICUBIC", () => {
    const expected = loadExpected(SAMPLES_DIR, "avlayer_flags");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("avlayer_flags.aep")), "samplingQuality_BICUBIC");
    const layerJson = getLayerFromJsonByComp(expected, "samplingQuality_BICUBIC");
    expect(asInstance(layer, AVLayer).samplingQuality).toBe(layerJson["samplingQuality"]);
    expect(layerJson["samplingQuality"]).toBe(LayerSamplingQuality.BICUBIC);
  });
});

/** Tests for frame blending type. */
describe("TestFrameBlending", () => {
  test("test_frameBlendingType_NO_FRAME_BLEND", () => {
    const expected = loadExpected(SAMPLES_DIR, "frameBlendingType");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("frameBlendingType.aep")), "frameBlendingType_NO_FRAME_BLEND");
    const layerJson = getLayerFromJsonByComp(expected, "frameBlendingType_NO_FRAME_BLEND");
    expect(asInstance(layer, AVLayer).frameBlendingType).toBe(layerJson["frameBlendingType"]);
    expect(layerJson["frameBlendingType"]).toBe(FrameBlendingType.NO_FRAME_BLEND);
    expect(asInstance(layer, AVLayer).frameBlending).toBe(false);
  });

  test("test_frameBlendingType_FRAME_MIX", () => {
    const expected = loadExpected(SAMPLES_DIR, "frameBlendingType");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("frameBlendingType.aep")), "frameBlendingType_FRAME_MIX");
    const layerJson = getLayerFromJsonByComp(expected, "frameBlendingType_FRAME_MIX");
    expect(asInstance(layer, AVLayer).frameBlendingType).toBe(layerJson["frameBlendingType"]);
    expect(layerJson["frameBlendingType"]).toBe(FrameBlendingType.FRAME_MIX);
  });

  test("test_frameBlendingType_PIXEL_MOTION", () => {
    const expected = loadExpected(SAMPLES_DIR, "frameBlendingType");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("frameBlendingType.aep")), "frameBlendingType_PIXEL_MOTION");
    const layerJson = getLayerFromJsonByComp(expected, "frameBlendingType_PIXEL_MOTION");
    expect(asInstance(layer, AVLayer).frameBlendingType).toBe(layerJson["frameBlendingType"]);
    expect(layerJson["frameBlendingType"]).toBe(FrameBlendingType.PIXEL_MOTION);
  });
});

/** Tests for auto-orient settings. */
describe("TestAutoOrient", () => {
  test("test_autoOrient_ALONG_PATH", () => {
    const expected = loadExpected(SAMPLES_DIR, "autoOrient");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("autoOrient.aep")), "autoOrient_ALONG_PATH");
    const layerJson = getLayerFromJsonByComp(expected, "autoOrient_ALONG_PATH");
    expect(layer.autoOrient).toBe(layerJson["autoOrient"]);
    expect(layerJson["autoOrient"]).toBe(AutoOrientType.ALONG_PATH);
  });

  test("test_autoOrient_CAMERA", () => {
    const expected = loadExpected(SAMPLES_DIR, "autoOrient");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("autoOrient.aep")), "autoOrient_CAMERA");
    const layerJson = getLayerFromJsonByComp(expected, "autoOrient_CAMERA");
    expect(layer.autoOrient).toBe(layerJson["autoOrient"]);
    expect(layerJson["autoOrient"]).toBe(AutoOrientType.CAMERA_OR_POINT_OF_INTEREST);
    expect(asInstance(layer, AVLayer).threeDLayer).toBe(true);
  });

  test("test_autoOrient_CHARACTERS", () => {
    const expected = loadExpected(SAMPLES_DIR, "autoOrient");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("autoOrient.aep")), "autoOrient_CHARACTERS");
    const layerJson = getLayerFromJsonByComp(expected, "autoOrient_CHARACTERS");
    expect(layer.autoOrient).toBe(layerJson["autoOrient"]);
    expect(layerJson["autoOrient"]).toBe(AutoOrientType.CHARACTERS_TOWARD_CAMERA);
    expect(asInstance(layer, AVLayer).threeDLayer).toBe(true);
  });
});

/** Tests for track matte settings. */
describe("TestTrackMatte", () => {
  test("test_trackMatteType_ALPHA", () => {
    const expected = loadExpected(SAMPLES_DIR, "trackMatteType");
    const project = parseProject(SAMPLES_DIR.div("trackMatteType.aep"));
    const comp = getComp(project, "trackMatteType_ALPHA");
    const mattedLayer =
      comp.layers.find((layer) => asInstance(layer, AVLayer).trackMatteType === TrackMatteType.ALPHA) ?? null;
    let expectedLayer = null;
    for (const item of expected["items"]) {
      if (item["name"] === "trackMatteType_ALPHA" && "layers" in item) {
        for (const lj of item["layers"]) {
          if (lj["trackMatteType"] === TrackMatteType.ALPHA) {
            expectedLayer = lj;
            break;
          }
        }
      }
    }
    expect(mattedLayer != null).toBe(true);
    assert(expectedLayer != null);
    expect(asInstance(mattedLayer, AVLayer).trackMatteType).toBe(expectedLayer["trackMatteType"]);
  });

  test("test_trackMatteType_LUMA", () => {
    const expected = loadExpected(SAMPLES_DIR, "trackMatteType");
    const project = parseProject(SAMPLES_DIR.div("trackMatteType.aep"));
    const comp = getComp(project, "trackMatteType_LUMA");
    const mattedLayer =
      comp.layers.find((layer) => asInstance(layer, AVLayer).trackMatteType === TrackMatteType.LUMA) ?? null;
    let expectedLayer = null;
    for (const item of expected["items"]) {
      if (item["name"] === "trackMatteType_LUMA" && "layers" in item) {
        for (const lj of item["layers"]) {
          if (lj["trackMatteType"] === TrackMatteType.LUMA) {
            expectedLayer = lj;
            break;
          }
        }
      }
    }
    expect(mattedLayer != null).toBe(true);
    assert(expectedLayer != null);
    expect(asInstance(mattedLayer, AVLayer).trackMatteType).toBe(expectedLayer["trackMatteType"]);
  });

  test("test_has_track_matte", () => {
    const expected = loadExpected(SAMPLES_DIR, "track_matte_yes");
    const project = parseProject(SAMPLES_DIR.div("track_matte_yes.aep"));
    const comp = project.compositions[0];
    let expectedLayers = null;
    for (const item of expected["items"]) {
      if ("layers" in item) {
        expectedLayers = item["layers"];
        break;
      }
    }
    assert(expectedLayers != null);
    for (const [layer, exp] of zip(comp.layers, expectedLayers)) {
      expect(asInstance(layer, AVLayer).hasTrackMatte).toBe(exp["hasTrackMatte"]);
    }
  });

  test("test_has_track_matte_false", () => {
    const expected = loadExpected(SAMPLES_DIR, "track_matte_no");
    const project = parseProject(SAMPLES_DIR.div("track_matte_no.aep"));
    const comp = project.compositions[0];
    let expectedLayers = null;
    for (const item of expected["items"]) {
      if ("layers" in item) {
        expectedLayers = item["layers"];
        break;
      }
    }
    expect(expectedLayers != null).toBe(true);
    for (const layer of comp.layers) {
      expect(asInstance(layer, AVLayer).hasTrackMatte).toBe(false);
    }
  });

  test("test_is_track_matte", () => {
    const expected = loadExpected(SAMPLES_DIR, "track_matte_yes");
    const project = parseProject(SAMPLES_DIR.div("track_matte_yes.aep"));
    const comp = project.compositions[0];
    let expectedLayers = null;
    for (const item of expected["items"]) {
      if ("layers" in item) {
        expectedLayers = item["layers"];
        break;
      }
    }
    assert(expectedLayers != null);
    for (const [layer, exp] of zip(comp.layers, expectedLayers)) {
      expect(asInstance(layer, AVLayer).isTrackMatte).toBe(exp["isTrackMatte"]);
    }
  });

  test("test_is_track_matte_false", () => {
    const project = parseProject(SAMPLES_DIR.div("track_matte_no.aep"));
    const comp = project.compositions[0];
    for (const layer of comp.layers) {
      expect(asInstance(layer, AVLayer).isTrackMatte).toBe(false);
    }
  });

  test("test_track_matte_layer", () => {
    const project = parseProject(SAMPLES_DIR.div("track_matte_yes.aep"));
    const comp = project.compositions[0];
    const mattedLayer = comp.layers.find((layer) => asInstance(layer, AVLayer).hasTrackMatte) ?? null;
    expect(mattedLayer != null).toBe(true);
    expect(asInstance(mattedLayer, AVLayer).trackMatteLayer != null).toBe(true);
    expect(asInstance(asInstance(mattedLayer, AVLayer).trackMatteLayer, AVLayer).isTrackMatte).toBe(true);
  });

  test("test_track_matte_layer_none", () => {
    const project = parseProject(SAMPLES_DIR.div("track_matte_no.aep"));
    const comp = project.compositions[0];
    for (const layer of comp.layers) {
      expect(asInstance(layer, AVLayer).trackMatteLayer == null).toBe(true);
    }
  });
});

/** Tests for layer parenting. */
describe("TestParenting", () => {
  test("test_parent", () => {
    const expected = loadExpected(SAMPLES_DIR, "layer_misc");
    const project = parseProject(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = getComp(project, "parent");
    const childLayer = comp.layers.find((layer) => layer._parentId !== 0) ?? null;
    expect(childLayer != null).toBe(true);
    if (childLayer == null) throw new Error("no parented layer in comp 'parent'");
    for (const item of expected["items"]) {
      if (item["name"] === "parent" && "layers" in item) {
        for (const layerJson of item["layers"]) {
          if (layerJson["parent"] != null) {
            expect(childLayer._parentId).toBe(layerJson["parent"]);
          }
        }
      }
    }
  });
});

/** Tests for time remap. */
describe("TestTimeRemap", () => {
  test("test_timeRemapEnabled_true", () => {
    const expected = loadExpected(SAMPLES_DIR, "avlayer_flags");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("avlayer_flags.aep")), "timeRemapEnabled_true");
    const layerJson = getLayerFromJsonByComp(expected, "timeRemapEnabled_true");
    expect(layerJson["timeRemapEnabled"]).toBe(true);
    expect(asInstance(layer, AVLayer).timeRemapEnabled).toBe(layerJson["timeRemapEnabled"]);
  });
});

/** Tests for audio attributes. */
describe("TestAudio", () => {
  test("test_audioEnabled_true", () => {
    const expected = loadExpected(SAMPLES_DIR, "audioEnabled");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("audioEnabled.aep")), "audioEnabled_true");
    const layerJson = getLayerFromJsonByComp(expected, "audioEnabled_true");
    expect(asInstance(layer, AVLayer).audioEnabled).toBe(layerJson["audioEnabled"]);
    expect(layerJson["audioEnabled"]).toBe(true);
  });

  test("test_audioEnabled_false", () => {
    const expected = loadExpected(SAMPLES_DIR, "audioEnabled");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("audioEnabled.aep")), "audioEnabled_false");
    const layerJson = getLayerFromJsonByComp(expected, "audioEnabled_false");
    expect(layerJson["audioEnabled"]).toBe(false);
    expect(asInstance(layer, AVLayer).audioEnabled).toBe(layerJson["audioEnabled"]);
  });

  /** An audio-only layer has no pixels: AE centres its anchor on a 1x1 box. */
  test("test_audio_only_anchor_point", () => {
    const expected = loadExpected(SAMPLES_DIR, "audioEnabled");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("audioEnabled.aep")), "audioEnabled_true");
    const layerJson = getLayerFromJsonByComp(expected, "audioEnabled_true");
    const transformJson = layerJson["properties"].find((p) => p.matchName === "ADBE Transform Group");
    if (transformJson === undefined) throw new StopIteration();
    const anchorJson = jsonField(transformJson, "properties").find((p) => p.matchName === "ADBE Anchor Point");
    if (anchorJson === undefined) throw new StopIteration();
    const anchor = layer.property("ADBE Transform Group").property("ADBE Anchor Point");
    expect(valueEquals(anchor.value, jsonField(anchorJson, "value"))).toBe(true);
    expect(valueEquals(jsonField(anchorJson, "value"), [0.5, 0.5, 0])).toBe(true);
  });
});

/** Regression tests for layer name encoding edge cases. */
describe("TestLayerNameEncoding", () => {
  /**
   * Layer names with non-ASCII characters (e.g. ≈) should parse without error.
   *
   * Regression test for windows-1250 decoding error: byte 0x98 is undefined
   * in windows-1250 but valid in windows-1252.
   */
  test("test_non_ascii_layer_name", () => {
    const expected = loadExpected(BUGS_DIR, "windows-1250_decoding_error");
    const layer = getFirstLayer(parseProject(BUGS_DIR.div("windows-1250_decoding_error.aep")));
    const layerJson = getLayerFromJson(expected);
    expect(layer.name).toBe(layerJson["name"]);
    expect(layer.name).toBe("≈");
  });
});

/** Tests for Layer.activeAtTime() method. */
describe("TestActiveAtTime", () => {
  /** An enabled, non-soloed layer returns True inside its in/out range. */
  test("test_enabled_layer_within_range", () => {
    const project = parseProject(SAMPLES_DIR.div("layer_timing.aep"));
    const layer = getLayer(project, "startTime_5");
    expect(layer.enabled).toBe(true);
    const midpoint = (layer.inPoint + layer.outPoint) / 2;
    expect(layer.activeAtTime(midpoint)).toBe(true);
  });

  /** Layer is active exactly at its in_point (inclusive). */
  test("test_at_in_point", () => {
    const project = parseProject(SAMPLES_DIR.div("inPoint.aep"));
    const layer = getLayer(project, "inPoint_5");
    expect(layer.activeAtTime(layer.inPoint)).toBe(true);
  });

  /** Layer is not active at its out_point (exclusive). */
  test("test_at_out_point", () => {
    const project = parseProject(SAMPLES_DIR.div("inPoint.aep"));
    const layer = getLayer(project, "inPoint_5");
    expect(layer.activeAtTime(layer.outPoint)).toBe(false);
  });

  /** Layer is not active before its in_point. */
  test("test_before_in_point", () => {
    const project = parseProject(SAMPLES_DIR.div("inPoint.aep"));
    const layer = getLayer(project, "inPoint_5");
    expect(layer.activeAtTime(layer.inPoint - 1)).toBe(false);
  });

  /** A disabled layer is never active. */
  test("test_disabled_layer", () => {
    const project = parseProject(SAMPLES_DIR.div("layer_switches.aep"));
    const layer = getLayer(project, "enabled_false");
    expect(layer.enabled).toBe(false);
    const midpoint = (layer.inPoint + layer.outPoint) / 2;
    expect(layer.activeAtTime(midpoint)).toBe(false);
  });

  /** A soloed layer is active within its time range. */
  test("test_solo_layer_active", () => {
    const project = parseProject(SAMPLES_DIR.div("layer_switches.aep"));
    const layer = getLayer(project, "solo_true");
    expect(layer.solo).toBe(true);
    const midpoint = (layer.inPoint + layer.outPoint) / 2;
    expect(layer.activeAtTime(midpoint)).toBe(true);
  });

  /** A non-soloed layer is inactive when another layer in the comp is soloed. */
  test("test_non_solo_layer_inactive_when_other_is_soloed", () => {
    const project = parseProject(SAMPLES_DIR.div("layer_switches.aep"));
    const comp = getComp(project, "solo_true");
    const nonSoloLayers = comp.layers.filter((lyr) => !lyr.solo);
    if (truthy(nonSoloLayers)) {
      const layer = nonSoloLayers[0];
      const midpoint = (layer.inPoint + layer.outPoint) / 2;
      expect(layer.activeAtTime(midpoint)).toBe(false);
    }
  });
});

/** Tests for AVLayer.audioActiveAtTime() method. */
describe("TestAudioActiveAtTime", () => {
  /** Layer with audio enabled returns True inside its time range. */
  test("test_audio_active_within_range", () => {
    const project = parseProject(SAMPLES_DIR.div("audioEnabled.aep"));
    const layer = getLayer(project, "audioEnabled_true");
    expect(layer instanceof AVLayer).toBe(true);
    const midpoint = (layer.inPoint + layer.outPoint) / 2;
    expect(asInstance(layer, AVLayer).audioActiveAtTime(midpoint)).toBe(true);
  });

  /** Layer with audio_enabled=False returns False. */
  test("test_audio_disabled", () => {
    const project = parseProject(SAMPLES_DIR.div("audioEnabled.aep"));
    const layer = getLayer(project, "audioEnabled_false");
    expect(layer instanceof AVLayer).toBe(true);
    const midpoint = (layer.inPoint + layer.outPoint) / 2;
    expect(asInstance(layer, AVLayer).audioActiveAtTime(midpoint)).toBe(false);
  });

  /** Layer is not audio-active before its in_point. */
  test("test_before_in_point", () => {
    const project = parseProject(SAMPLES_DIR.div("audioEnabled.aep"));
    const layer = getLayer(project, "audioEnabled_true");
    expect(layer instanceof AVLayer).toBe(true);
    expect(asInstance(layer, AVLayer).audioActiveAtTime(layer.inPoint - 1)).toBe(false);
  });

  /** Layer is not audio-active at its out_point (exclusive). */
  test("test_at_out_point", () => {
    const project = parseProject(SAMPLES_DIR.div("audioEnabled.aep"));
    const layer = getLayer(project, "audioEnabled_true");
    expect(layer instanceof AVLayer).toBe(true);
    expect(asInstance(layer, AVLayer).audioActiveAtTime(layer.outPoint)).toBe(false);
  });

  /** Layer is audio-active at its in_point (inclusive). */
  test("test_at_in_point", () => {
    const project = parseProject(SAMPLES_DIR.div("audioEnabled.aep"));
    const layer = getLayer(project, "audioEnabled_true");
    expect(layer instanceof AVLayer).toBe(true);
    expect(asInstance(layer, AVLayer).audioActiveAtTime(layer.inPoint)).toBe(true);
  });

  /** audio_active property delegates to audio_active_at_time(time). */
  test("test_audio_active_property", () => {
    const project = parseProject(SAMPLES_DIR.div("audioEnabled.aep"));
    const layer = getLayer(project, "audioEnabled_true");
    expect(layer instanceof AVLayer).toBe(true);
    expect(asInstance(layer, AVLayer).audioActive).toBe(asInstance(layer, AVLayer).audioActiveAtTime(layer.time));
  });
});

/** Tests for Layer's PropertyGroup / PropertyBase inheritance. */
describe("TestLayerPropertyGroupInheritance", () => {
  /** Layer is an instance of PropertyGroup. */
  test("test_layer_is_property_group", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    expect(layer instanceof PropertyGroup).toBe(true);
  });

  /** Layer is an instance of PropertyBase. */
  test("test_layer_is_property_base", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    expect(layer instanceof PropertyBase).toBe(true);
  });

  /** Layers are at depth 0 (root of the property hierarchy). */
  test("test_property_depth_is_zero", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    expect(layer.propertyDepth).toBe(0);
  });

  /** Layer property_type is NAMED_GROUP. */
  test("test_property_type_named_group", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    expect(layer.propertyType).toBe(PropertyType.NAMED_GROUP);
  });

  /** AVLayer has the correct ExtendScript match name. */
  test("test_av_layer_match_name", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    expect(layer instanceof AVLayer).toBe(true);
    expect(layer.matchName).toBe("ADBE AV Layer");
  });

  /** Layer.properties includes the Transform group. */
  test("test_properties_contains_transform", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    const matchNames = layer.properties.map((p) => p.matchName);
    expect(matchNames.includes("ADBE Transform Group")).toBe(true);
  });

  /** Layer.transform returns the Transform PropertyGroup. */
  test("test_transform_accessor", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    expect(layer.transform instanceof PropertyGroup).toBe(true);
    expect(layer.transform.matchName).toBe("ADBE Transform Group");
  });

  /** Layer.effects is an empty (falsy) group when there are no effects. */
  test("test_effects_empty_when_no_effects", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    // Basic layer without effects: the group exists (as in ExtendScript)
    // but holds no children, so it is falsy.
    expect(layer.effects != null).toBe(true);
    expect(len(layer.effects)).toBe(0);
    expect(truthy(layer.effects)).toBe(false);
  });

  /** Layer.numProperties returns the count of top-level property groups. */
  test("test_num_properties_positive", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    expect(layer.numProperties).toBe(len(layer.properties));
    expect(layer.numProperties > 0).toBe(true);
  });

  /** Layer.active reflects active_at_time(time). */
  test("test_active_property", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    expect(layer.active).toBe(layer.activeAtTime(layer.time));
  });

  /** Two Layer objects are only equal when they are the same object. */
  test("test_identity_equality", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    expect(valueEquals(layer, layer)).toBe(true);
    // A copy (different object) should not be equal
    expect(!valueEquals(layer, {})).toBe(true); // Python `object()`
  });

  /** Layer.transform returns the same PropertyGroup as in properties list. */
  test("test_transform_is_same_object_in_properties", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    const transformFromList = layer.properties.find((p) => p.matchName === "ADBE Transform Group");
    if (transformFromList == null) throw new StopIteration();
    expect(layer.transform === transformFromList).toBe(true);
  });

  /** len(layer) equals layer.numProperties. */
  test("test_len_equals_num_properties", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    expect(len(layer)).toBe(layer.numProperties);
    expect(len(layer)).toBe(len(layer.properties));
  });

  /** layer[0] returns the first child property group. */
  test("test_getitem_by_int_index", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    expect(layer.property(0) === layer.properties[0]).toBe(true);
  });

  /** layer['ADBE Transform Group'] returns the Transform group. */
  test("test_getitem_by_match_name", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    const result = layer.property("ADBE Transform Group");
    expect(result instanceof PropertyGroup).toBe(true);
    expect(result.matchName).toBe("ADBE Transform Group");
    expect(result === layer.transform).toBe(true);
  });

  /** layer['Transform'] returns the Transform group by display name. */
  test("test_getitem_by_display_name", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    const result = layer.property("Transform");
    expect(result instanceof PropertyGroup).toBe(true);
    expect(result.matchName).toBe("ADBE Transform Group");
  });

  /** layer['ADBE Transform Group']['ADBE Position'] chains correctly. */
  test("test_getitem_chained", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    const transform = layer.property("ADBE Transform Group");
    const position = transform.property("ADBE Position");
    expect(position.matchName).toBe("ADBE Position");
  });

  /** layer['nonexistent'] raises KeyError. */
  test("test_getitem_key_error", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    raises(KeyError, () => {
      layer.property("nonexistent_match_name");
    });
  });

  /** layer[9999] raises IndexError. */
  test("test_getitem_index_error", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    raises(IndexError, () => {
      layer.property(9999);
    });
  });

  /** layer[1.5] raises TypeError. */
  test("test_getitem_type_error", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    raises(TypeError, () => {
      layer.property(1.5);
    });
  });

  /** layer.transform.position resolves the child by attribute name. */
  test("test_getattr_single_word", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    const position = getMember(layer.transform, "position");
    expect(position.matchName).toBe("ADBE Position");
  });

  /** layer.transform.anchorPoint resolves 'Anchor Point'. */
  test("test_getattr_multi_word", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    const anchor = getMember(layer.transform, "anchorPoint");
    expect(anchor.matchName).toBe("ADBE Anchor Point");
  });

  /** Accessing a nonexistent child raises AttributeError. */
  test("test_getattr_attribute_error", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    raises(AttributeError, () => {
      getMember(layer.transform, "nonexistent");
    });
  });

  /** Class members take priority over the child-name getters. */
  test("test_getattr_does_not_shadow_fields", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    // 'name' is a class attribute, should NOT look in children
    expect(typeof layer.transform.name === "string").toBe(true);
  });
});

/** Tests for ThreeDModelLayer parsing. */
describe("TestThreeDModelLayer", () => {
  /** ThreeDModelLayer inherits from AVLayer. */
  test("test_isinstance", () => {
    const project = parseProject(SAMPLES_DIR.div("three_d_model_layer.aep"));
    const layer = getFirstLayer(project);
    expect(layer instanceof ThreeDModelLayer).toBe(true);
    expect(layer instanceof AVLayer).toBe(true);
  });

  /** ThreeDModelLayer match_name is 'ADBE 3D Model Layer'. */
  test("test_match_name", () => {
    const project = parseProject(SAMPLES_DIR.div("three_d_model_layer.aep"));
    const layer = getFirstLayer(project);
    expect(layer.matchName).toBe("ADBE 3D Model Layer");
  });

  /** ThreeDModelLayer layer_type is 'Layer'. */
  test("test_layer_type", () => {
    const project = parseProject(SAMPLES_DIR.div("three_d_model_layer.aep"));
    const layer = getFirstLayer(project);
    expect(layer.layerType).toBe("Layer");
  });

  /** ThreeDModelLayer always reports three_d_layer=True. */
  test("test_three_d_layer", () => {
    const project = parseProject(SAMPLES_DIR.div("three_d_model_layer.aep"));
    const layer = getFirstLayer(project);
    expect(layer instanceof ThreeDModelLayer).toBe(true);
    expect(asInstance(layer, ThreeDModelLayer).threeDLayer).toBe(true);
  });

  /** ThreeDModelLayer has collapse_transformation=True. */
  test("test_collapse_transformation", () => {
    const project = parseProject(SAMPLES_DIR.div("three_d_model_layer.aep"));
    const layer = getFirstLayer(project);
    expect(layer instanceof ThreeDModelLayer).toBe(true);
    expect(asInstance(layer, ThreeDModelLayer).collapseTransformation).toBe(true);
  });

  /** ThreeDModelLayer source is a FootageItem. */
  test("test_source_is_footage", () => {
    const project = parseProject(SAMPLES_DIR.div("three_d_model_layer.aep"));
    const layer = getFirstLayer(project);
    expect(layer instanceof ThreeDModelLayer).toBe(true);
    const source = asInstance(layer, ThreeDModelLayer).source;
    expect(source != null).toBe(true);
    if (source == null) throw new Error("ThreeDModelLayer has no source");
    expect(source.name).toBe("crystal.fbx");
  });

  /** CompItem.threeDModelLayers filters correctly. */
  test("test_comp_three_d_model_layers", () => {
    const project = parseProject(SAMPLES_DIR.div("three_d_model_layer.aep"));
    const comp = project.compositions[0];
    expect(len(comp.threeDModelLayers)).toBe(1);
    expect(comp.threeDModelLayers[0] instanceof ThreeDModelLayer).toBe(true);
  });

  /** ThreeDModelLayer.canSetCollapseTransformation is always True. */
  test("test_can_set_collapse_transformation", () => {
    const project = parseProject(SAMPLES_DIR.div("three_d_model_layer.aep"));
    const layer = getFirstLayer(project);
    expect(layer instanceof ThreeDModelLayer).toBe(true);
    expect(asInstance(layer, ThreeDModelLayer).canSetCollapseTransformation).toBe(true);
  });

  /** ThreeDModelLayer.canSetTimeRemapEnabled is always False. */
  test("test_can_set_time_remap_enabled", () => {
    const project = parseProject(SAMPLES_DIR.div("three_d_model_layer.aep"));
    const layer = getFirstLayer(project);
    expect(layer instanceof ThreeDModelLayer).toBe(true);
    expect(asInstance(layer, ThreeDModelLayer).canSetTimeRemapEnabled).toBe(false);
  });
});

/** Tests for AVLayer.threeDPerChar attribute. */
describe("TestThreeDPerChar", () => {
  /** three_d_per_char is True when per-character 3D is enabled. */
  test("test_three_d_per_char_on", () => {
    const project = parseProject(SAMPLES_DIR.div("threeDPerChar_on.aep"));
    const layer = getFirstLayer(project);
    expect(layer instanceof AVLayer).toBe(true);
    expect(asInstance(layer, AVLayer).threeDPerChar).toBe(true);
  });

  /** three_d_per_char is False when per-character 3D is disabled. */
  test("test_three_d_per_char_off", () => {
    const project = parseProject(SAMPLES_DIR.div("threeDPerChar_off.aep"));
    const layer = getFirstLayer(project);
    expect(layer instanceof AVLayer).toBe(true);
    expect(asInstance(layer, AVLayer).threeDPerChar).toBe(false);
  });
});

/** Canonical order of top-level property groups per layer type. */
describe("TestTopLevelGroupOrder", () => {
  test("test_camera_layer", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("type.aep")), "type_camera");
    expect(layer instanceof CameraLayer).toBe(true);
    const matchNames = layer.properties.map((p) => p.matchName);
    // Canonical groups first, then non-canonical tail (Camera Options)
    expect(valueEquals(matchNames, ["ADBE Marker", "ADBE Transform Group", "ADBE Camera Options Group"])).toBe(true);
  });

  test("test_light_layer", () => {
    const project = parseProject(SAMPLES_DIR.div("lightType.aep"));
    // Use any light comp
    const layer = getLayer(project, "lightType_PARALLEL");
    expect(layer instanceof LightLayer).toBe(true);
    const matchNames = layer.properties.map((p) => p.matchName);
    expect(valueEquals(matchNames, ["ADBE Marker", "ADBE Transform Group", "ADBE Light Options Group"])).toBe(true);
  });

  test("test_shape_layer", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("type.aep")), "type_shape");
    expect(layer instanceof ShapeLayer).toBe(true);
    const matchNames = layer.properties.map((p) => p.matchName);
    expect(
      valueEquals(matchNames, [
        "ADBE Marker",
        "ADBE Root Vectors Group",
        "ADBE Mask Parade",
        "ADBE Effect Parade",
        "ADBE Transform Group",
        "ADBE Layer Styles",
        "ADBE Extrsn Options Group",
        "ADBE Material Options Group",
        "ADBE Audio Group",
        "ADBE Layer Sets",
      ]),
    ).toBe(true);
  });

  test("test_text_layer", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("type.aep")), "type_text");
    expect(layer instanceof TextLayer).toBe(true);
    const matchNames = layer.properties.map((p) => p.matchName);
    expect(
      valueEquals(matchNames, [
        "ADBE Marker",
        "ADBE Text Properties",
        "ADBE Mask Parade",
        "ADBE Effect Parade",
        "ADBE Transform Group",
        "ADBE Layer Styles",
        "ADBE Extrsn Options Group",
        "ADBE Material Options Group",
        "ADBE Audio Group",
        "ADBE Layer Sets",
      ]),
    ).toBe(true);
  });

  test("test_regular_av_layer", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("avlayer_flags.aep")), "adjustmentLayer_true");
    expect(layer instanceof AVLayer).toBe(true);
    expect(truthy(asInstance(layer, AVLayer).threeDLayer)).toBe(false);
    const matchNames = layer.properties.map((p) => p.matchName);
    expect(
      valueEquals(matchNames, [
        "ADBE Marker",
        "ADBE Time Remapping",
        "ADBE MTrackers",
        "ADBE Mask Parade",
        "ADBE Effect Parade",
        "ADBE Transform Group",
        "ADBE Layer Styles",
        "ADBE Plane Options Group",
        "ADBE Extrsn Options Group",
        "ADBE Material Options Group",
        "ADBE Audio Group",
        "ADBE Data Group",
        "ADBE Layer Overrides",
        "ADBE Layer Sets",
        "ADBE Source Options Group",
      ]),
    ).toBe(true);
  });

  test("test_three_d_av_layer", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("avlayer_flags.aep")), "threeDLayer_true");
    expect(layer instanceof AVLayer).toBe(true);
    expect(truthy(asInstance(layer, AVLayer).threeDLayer)).toBe(true);
    const matchNames = layer.properties.map((p) => p.matchName);
    expect(
      valueEquals(matchNames, [
        "ADBE Marker",
        "ADBE Time Remapping",
        "ADBE MTrackers",
        "ADBE Mask Parade",
        "ADBE Effect Parade",
        "ADBE Transform Group",
        "ADBE Layer Styles",
        "ADBE Plane Options Group",
        "ADBE Extrsn Options Group",
        "ADBE Material Options Group",
        "ADBE Audio Group",
        "ADBE Data Group",
        "ADBE Layer Overrides",
        "ADBE Layer Sets",
        "ADBE Source Options Group",
      ]),
    ).toBe(true);
  });
});

/** Special metadata on specific top-level groups. */
describe("TestTopLevelSpecialCases", () => {
  /** Marker is a Property (leaf), not a PropertyGroup. */
  test("test_marker_is_leaf_property", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("avlayer_flags.aep")), "adjustmentLayer_true");
    const marker = layer.properties.find((p) => p.matchName === "ADBE Marker");
    if (marker == null) throw new StopIteration();
    expect(marker instanceof Property).toBe(true);
    expect(marker instanceof PropertyGroup).toBe(false);
  });

  /** Synthesized Marker has dimensions=0 and empty units_text. */
  test("test_marker_metadata", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("avlayer_flags.aep")), "adjustmentLayer_true");
    const marker = layer.properties.find((p) => p.matchName === "ADBE Marker");
    if (marker == null) throw new StopIteration();
    expect(marker instanceof Property).toBe(true);
    expect(asInstance(marker, Property).dimensions).toBe(0);
    expect(asInstance(marker, Property).unitsText).toBe("");
  });

  /** Layer Sets group has elided=True. */
  test("test_layer_sets_elided", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("avlayer_flags.aep")), "adjustmentLayer_true");
    const layerSets = layer.properties.find((p) => p.matchName === "ADBE Layer Sets");
    if (layerSets == null) throw new StopIteration();
    expect(layerSets instanceof PropertyGroup).toBe(true);
    expect(layerSets.elided).toBe(true);
  });

  /** AE 2026 reports both as indexed groups, empty or not. */
  test("test_trackers_and_layer_sets_are_indexed_groups", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("avlayer_flags.aep")), "adjustmentLayer_true");
    for (const mn of ["ADBE MTrackers", "ADBE Layer Sets"]) {
      expect(layer.property(mn).propertyType).toBe(PropertyType.INDEXED_GROUP);
    }
  });

  /** Every canonical top-level group has property_depth == 1. */
  test("test_all_canonical_groups_depth_one", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("avlayer_flags.aep")), "adjustmentLayer_true");
    for (const prop of layer.properties) {
      assert(prop.propertyDepth === 1, `${prop.matchName} has depth ${prop.propertyDepth}`);
    }
  });

  /** Canonical groups have expected display names. */
  test("test_canonical_names", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("avlayer_flags.aep")), "adjustmentLayer_true");
    const expectedNames = new Map<string, string>([
      ["ADBE Marker", "Marker"],
      ["ADBE Time Remapping", "Time Remap"],
      ["ADBE MTrackers", "Motion Trackers"],
      ["ADBE Mask Parade", "Masks"],
      ["ADBE Effect Parade", "Effects"],
      ["ADBE Transform Group", "Transform"],
      ["ADBE Layer Styles", "Layer Styles"],
      ["ADBE Plane Options Group", "Geometry Options"],
      ["ADBE Extrsn Options Group", "Geometry Options"],
      ["ADBE Material Options Group", "Material Options"],
      ["ADBE Audio Group", "Audio"],
      ["ADBE Data Group", "Data"],
      ["ADBE Layer Overrides", "Essential Properties"],
      ["ADBE Layer Sets", "Sets"],
      ["ADBE Source Options Group", "Replace Source"],
    ]);
    for (const prop of layer.properties) {
      if (expectedNames.has(prop.matchName)) {
        assert(
          prop.name === expectedNames.get(prop.matchName),
          `${prop.matchName}: expected name ${repr(expectedNames.get(prop.matchName))}, ` + `got ${repr(prop.name)}`,
        );
      }
    }
  });
});

/** Layer Styles collapsed enabled state and Blend Options mirroring. */
describe("TestLayerStylesEnabled", () => {
  /** Layer Styles group reports enabled=False when no style is on. */
  test("test_layer_styles_disabled_when_no_style_enabled", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("type.aep")), "type_shape");
    const layerStylesChild = layer.properties.find((p) => p.matchName === "ADBE Layer Styles");
    if (layerStylesChild == null) throw new StopIteration();
    const layerStyles = asInstance(layerStylesChild, PropertyGroup);
    expect(layerStyles instanceof PropertyGroup).toBe(true);
    expect(layerStyles._deferredAeMajor != null).toBe(true);
    expect(layerStyles.enabled).toBe(false);
    expect(layerStyles._deferredAeMajor != null).toBe(true);

    // Blend Options mirrors the parent
    const blendOptions = layerStyles.properties.find((p) => p.matchName === "ADBE Blend Options Group");
    if (blendOptions == null) throw new StopIteration();
    expect(layerStyles._deferredAeMajor == null).toBe(true);
    expect(blendOptions instanceof PropertyGroup).toBe(true);
    expect(blendOptions.enabled).toBe(false);

    // No individual style is enabled
    for (const child of layerStyles.properties) {
      if (child instanceof PropertyGroup && child.matchName !== "ADBE Blend Options Group") {
        assert(child.enabled === false, `${child.matchName} should be disabled`);
      }
    }
  });

  /**
   * With no styles applied, the group and every style report
   * canSetEnabled=False (matching ExtendScript).
   */
  test("test_can_set_enabled_no_styles", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("type.aep")), "type_shape");
    const layerStylesChild = layer.properties.find((p) => p.matchName === "ADBE Layer Styles");
    if (layerStylesChild == null) throw new StopIteration();
    const layerStyles = asInstance(layerStylesChild, PropertyGroup);
    expect(layerStyles instanceof PropertyGroup).toBe(true);
    expect(layerStyles.canSetEnabled).toBe(false);
    for (const child of layerStyles.properties) {
      expect(child.canSetEnabled).toBe(false);
    }
  });

  /**
   * An applied style (and the group) reports canSetEnabled=True;
   * phantom styles and Blending Options report False.
   */
  test("test_can_set_enabled_applied_style", () => {
    const path = new Path(import.meta.dir).parent.parent.div(
      "samples",
      "models",
      "selection",
      "selection_dropshadow_enabled_opacity.aep",
    );
    const layer = parseAep(path).project.compositions[0].layers[0];
    const layerStyles = layer.property("ADBE Layer Styles");
    expect(layerStyles instanceof PropertyGroup).toBe(true);
    expect(layerStyles.canSetEnabled).toBe(true);
    for (const child of layerStyles.properties) {
      const mn = child.matchName;
      if (mn === "dropShadow/enabled") {
        expect(child.canSetEnabled).toBe(true);
      } else {
        // phantom styles + Blending Options
        assert(child.canSetEnabled === false, mn);
      }
    }
  });
});

/** Context-dependent naming on transform properties. */
describe("TestTransformNaming", () => {
  /** 2D layers show Rotate Z as 'Rotation'. */
  test("test_2d_rotate_z_named_rotation", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("avlayer_flags.aep")), "adjustmentLayer_true");
    const rotateZ = layer.transform.property("ADBE Rotate Z");
    expect(rotateZ.name).toBe("Rotation");
  });

  /** 3D layers show Rotate Z as 'Z Rotation'. */
  test("test_3d_rotate_z_named_z_rotation", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("avlayer_flags.aep")), "threeDLayer_true");
    const rotateZ = layer.transform.property("ADBE Rotate Z");
    expect(rotateZ.name).toBe("Z Rotation");
  });

  /** Camera layers show Rotate Z as 'Z Rotation'. */
  test("test_camera_rotate_z_named_z_rotation", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("type.aep")), "type_camera");
    const rotateZ = layer.transform.property("ADBE Rotate Z");
    expect(rotateZ.name).toBe("Z Rotation");
  });

  /** Camera layers show Anchor Point as 'Point of Interest'. */
  test("test_camera_anchor_named_point_of_interest", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("type.aep")), "type_camera");
    const anchor = layer.transform.property("ADBE Anchor Point");
    expect(anchor.name).toBe("Point of Interest");
  });

  /** Light layers show Anchor Point as 'Point of Interest'. */
  test("test_light_anchor_named_point_of_interest", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("lightType.aep")), "lightType_PARALLEL");
    const anchor = layer.transform.property("ADBE Anchor Point");
    expect(anchor.name).toBe("Point of Interest");
  });

  /** 2D layers show Anchor Point as 'Anchor Point'. */
  test("test_2d_anchor_named_anchor_point", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("avlayer_flags.aep")), "adjustmentLayer_true");
    const anchor = layer.transform.property("ADBE Anchor Point");
    expect(anchor.name).toBe("Anchor Point");
  });

  /** Non-canonical groups appear after canonical ones. */
  test("test_non_canonical_tail_preserved", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("type.aep")), "type_camera");
    const matchNames = layer.properties.map((p) => p.matchName);
    // Camera Options is non-canonical, should be last
    expect(matchNames[matchNames.length - 1]).toBe("ADBE Camera Options Group");
    // Marker and Transform are canonical, should come before
    expect(_listIndex(matchNames, "ADBE Marker") < _listIndex(matchNames, "ADBE Camera Options Group")).toBe(true);
    expect(_listIndex(matchNames, "ADBE Transform Group") < _listIndex(matchNames, "ADBE Camera Options Group")).toBe(
      true,
    );
  });
});
