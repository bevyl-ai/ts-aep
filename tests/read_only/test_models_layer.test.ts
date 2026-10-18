/** Tests for Layer model parsing. */

// `from __future__ import annotations` is dropped: no annotation here is
// evaluated at runtime. `math.isclose` is the pyrt `isclose` (num.ts), and the
// keyword-only `abs_tol=` becomes its fourth positional argument.

import { describe, expect, test } from "bun:test";
import { raises } from "../../src/pyrt/pytest.ts";
import {
  AttributeError,
  IndexError,
  KeyError,
  Path,
  StopIteration,
  TypeError_,
  ValueError,
  isclose,
  len,
  py_assert,
  py_bool,
  py_eq,
  repr,
  zip,
} from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { get_comp, get_first_layer, get_layer, get_layer_from_json, get_layer_from_json_by_comp, load_expected, parse_project } from "../conftest.ts";
import { as_instance, json_field } from "../helpers.ts";
import { parse as parse_aep } from "../../src/py_aep/index.ts";
import { AutoOrientType, BlendingMode, FrameBlendingType, LayerQuality, LayerSamplingQuality, LightType, PropertyType, TrackMatteType } from "../../src/py_aep/enums/index.ts";
import { AVLayer, CameraLayer, LightLayer, ShapeLayer, TextLayer } from "../../src/py_aep/models/layers/index.ts";
import { ThreeDModelLayer } from "../../src/py_aep/models/layers/three_d_model_layer.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { PropertyBase } from "../../src/py_aep/models/properties/property_base.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";

// Python `Path(__file__).parent.parent.parent` is the repo root. A TS file's
// `import.meta.dir` is already its directory, so two `.parent` steps reach it.
const SAMPLES_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "layer");
const BUGS_DIR = new Path(import.meta.dir).parent.parent.div("samples", "bugs");
const VERSIONS_DIR = new Path(import.meta.dir).parent.parent.div("samples", "versions");

// NOTE(port): matches `list.index`: first match, ValueError "<repr> is not in list" when absent.
function _list_index(xs: string[], x: string): number {
  const i = xs.indexOf(x);
  if (i < 0) throw new ValueError(`${repr(x)} is not in list`);
  return i;
}

/** Tests for basic layer attributes. */
describe("TestLayerBasic", () => {
  test("test_enabled_false", () => {
    const expected = load_expected(SAMPLES_DIR, "layer_switches");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    const layer_json = get_layer_from_json_by_comp(expected, "enabled_false");
    expect(layer_json["enabled"]).toBe(false);
    expect(layer.enabled).toBe(layer_json["enabled"]);
  });

  test("test_locked_true", () => {
    const expected = load_expected(SAMPLES_DIR, "layer_switches");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_switches.aep")), "locked_true");
    const layer_json = get_layer_from_json_by_comp(expected, "locked_true");
    expect(layer_json["locked"]).toBe(true);
    expect(layer.locked).toBe(layer_json["locked"]);
  });

  test("test_shy_true", () => {
    const expected = load_expected(SAMPLES_DIR, "layer_switches");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_switches.aep")), "shy_true");
    const layer_json = get_layer_from_json_by_comp(expected, "shy_true");
    expect(layer_json["shy"]).toBe(true);
    expect(layer.shy).toBe(layer_json["shy"]);
  });

  test("test_solo_true", () => {
    const expected = load_expected(SAMPLES_DIR, "layer_switches");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_switches.aep")), "solo_true");
    const layer_json = get_layer_from_json_by_comp(expected, "solo_true");
    expect(layer_json["solo"]).toBe(true);
    expect(layer.solo).toBe(layer_json["solo"]);
  });

  test("test_name_renamed", () => {
    const expected = load_expected(SAMPLES_DIR, "layer_misc");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_misc.aep")), "name_renamed");
    const layer_json = get_layer_from_json_by_comp(expected, "name_renamed");
    expect(layer.name).toBe(layer_json["name"]);
    expect(layer_json["name"]).toBe("RenamedLayer");
  });

  test("test_comment", () => {
    const expected = load_expected(SAMPLES_DIR, "layer_misc");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_misc.aep")), "comment");
    const layer_json = get_layer_from_json_by_comp(expected, "comment");
    expect(layer.comment).toBe(layer_json["comment"]);
    expect(layer_json["comment"]).toBe("Test layer comment");
  });

  test("test_label_3", () => {
    const expected = load_expected(SAMPLES_DIR, "layer_misc");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_misc.aep")), "label_3");
    const layer_json = get_layer_from_json_by_comp(expected, "label_3");
    expect(layer_json["label"]).toBe(3);
    // IntEnum members are plain numbers, so `.value` is the member itself.
    expect(layer.label).toBe(layer_json["label"]);
  });
});

/** Tests for layer timing attributes. */
describe("TestLayerTiming", () => {
  test("test_startTime_5", () => {
    const expected = load_expected(SAMPLES_DIR, "layer_timing");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_timing.aep")), "startTime_5");
    const layer_json = get_layer_from_json_by_comp(expected, "startTime_5");
    expect(layer_json["startTime"]).toBe(5);
    expect(isclose(layer.start_time, layer_json["startTime"])).toBe(true);
  });

  test("test_inPoint_5", () => {
    const expected = load_expected(SAMPLES_DIR, "inPoint");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("inPoint.aep")), "inPoint_5");
    const layer_json = get_layer_from_json_by_comp(expected, "inPoint_5");
    expect(layer_json["inPoint"]).toBe(5);
    expect(isclose(layer.in_point, layer_json["inPoint"])).toBe(true);
  });

  test("test_outPoint_10", () => {
    const expected = load_expected(SAMPLES_DIR, "outPoint");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("outPoint.aep")), "outPoint_10");
    const layer_json = get_layer_from_json_by_comp(expected, "outPoint_10");
    expect(layer_json["outPoint"]).toBe(10);
    expect(isclose(layer.out_point, layer_json["outPoint"])).toBe(true);
  });

  test("test_stretch_200", () => {
    const expected = load_expected(SAMPLES_DIR, "layer_timing");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_timing.aep")), "stretch_200");
    const layer_json = get_layer_from_json_by_comp(expected, "stretch_200");
    expect(layer_json["stretch"]).toBe(200);
    expect(isclose(layer.stretch, layer_json["stretch"])).toBe(true);
  });

  test("test_stretch_minus100", () => {
    const expected = load_expected(SAMPLES_DIR, "layer_timing");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_timing.aep")), "stretch_minus100");
    const layer_json = get_layer_from_json_by_comp(expected, "stretch_minus100");
    expect(layer_json["stretch"]).toBe(-100);
    expect(isclose(layer.stretch, layer_json["stretch"])).toBe(true);
  });
});

/** Tests for outPoint/inPoint clamping with precomp sources. */
describe("TestTimingEdgeCases", () => {
  /** Precomp dur=5s, main comp=30s. OutPoint clamped to 5. */
  test("test_outPoint_clamp_precomp", () => {
    const expected = load_expected(SAMPLES_DIR, "outPoint_clamp");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("outPoint_clamp.aep")), "outPoint_clamp_precomp");
    const layer_json = get_layer_from_json_by_comp(expected, "outPoint_clamp_precomp");
    expect(isclose(layer.out_point, layer_json["outPoint"], 1e-9, 0.001)).toBe(true);
    expect(isclose(layer.out_point, 5.0, 1e-9, 0.001)).toBe(true);
  });

  /** Precomp dur=5s, stretch=200%. OutPoint clamped to 10. */
  test("test_outPoint_clamp_stretch_200", () => {
    const expected = load_expected(SAMPLES_DIR, "outPoint_clamp");
    const layer = get_layer(
      parse_project(SAMPLES_DIR.div("outPoint_clamp.aep")),
      "outPoint_clamp_stretch_200",
    );
    const layer_json = get_layer_from_json_by_comp(expected, "outPoint_clamp_stretch_200");
    expect(isclose(layer.stretch, 200.0)).toBe(true);
    expect(isclose(layer.out_point, layer_json["outPoint"], 1e-9, 0.001)).toBe(true);
    expect(isclose(layer.out_point, 10.0, 1e-9, 0.001)).toBe(true);
  });

  /** Precomp dur=5s, stretch=400%. OutPoint clamped to 20. */
  test("test_outPoint_clamp_stretch_400", () => {
    const expected = load_expected(SAMPLES_DIR, "outPoint_clamp");
    const layer = get_layer(
      parse_project(SAMPLES_DIR.div("outPoint_clamp.aep")),
      "outPoint_clamp_stretch_400",
    );
    const layer_json = get_layer_from_json_by_comp(expected, "outPoint_clamp_stretch_400");
    expect(isclose(layer.stretch, 400.0)).toBe(true);
    expect(isclose(layer.out_point, layer_json["outPoint"], 1e-9, 0.001)).toBe(true);
    expect(isclose(layer.out_point, 20.0, 1e-9, 0.001)).toBe(true);
  });

  /** Precomp dur=5s, collapse=True. AE still clamps to 5. */
  test("test_outPoint_clamp_collapse", () => {
    const expected = load_expected(SAMPLES_DIR, "outPoint_no_clamp");
    const layer = get_layer(
      parse_project(SAMPLES_DIR.div("outPoint_no_clamp.aep")),
      "outPoint_no_clamp_collapse",
    );
    const layer_json = get_layer_from_json_by_comp(expected, "outPoint_no_clamp_collapse");
    expect(as_instance(layer, AVLayer).collapse_transformation).toBe(true);
    expect(isclose(layer.out_point, layer_json["outPoint"], 1e-9, 0.001)).toBe(true);
    expect(isclose(layer.out_point, 5.0, 1e-9, 0.001)).toBe(true);
  });

  /** Precomp dur=5s, timeRemap=True. OutPoint NOT clamped (stays 30). */
  test("test_outPoint_no_clamp_timeRemap", () => {
    const expected = load_expected(SAMPLES_DIR, "outPoint_no_clamp");
    const layer = get_layer(
      parse_project(SAMPLES_DIR.div("outPoint_no_clamp.aep")),
      "outPoint_no_clamp_timeRemap",
    );
    const layer_json = get_layer_from_json_by_comp(expected, "outPoint_no_clamp_timeRemap");
    expect(as_instance(layer, AVLayer).time_remap_enabled).toBe(true);
    expect(isclose(layer.out_point, layer_json["outPoint"], 1e-9, 0.001)).toBe(true);
    expect(isclose(layer.out_point, 30.0, 1e-9, 0.001)).toBe(true);
  });

  /** Precomp dur=5s, stretch=-100%. Clamping skipped. */
  test("test_outPoint_no_clamp_negative_stretch", () => {
    const expected = load_expected(SAMPLES_DIR, "outPoint_no_clamp");
    const layer = get_layer(
      parse_project(SAMPLES_DIR.div("outPoint_no_clamp.aep")),
      "outPoint_no_clamp_negative_stretch",
    );
    const layer_json = get_layer_from_json_by_comp(expected, "outPoint_no_clamp_negative_stretch");
    expect(isclose(layer.stretch, -100.0)).toBe(true);
    expect(isclose(layer.out_point, layer_json["outPoint"], 1e-9, 0.001)).toBe(true);
  });

  /** Precomp dur=5s, startTime=3s. OutPoint clamped to 3+5=8. */
  test("test_outPoint_clamp_with_startTime", () => {
    const expected = load_expected(SAMPLES_DIR, "outPoint_clamp");
    const layer = get_layer(
      parse_project(SAMPLES_DIR.div("outPoint_clamp.aep")),
      "outPoint_clamp_with_startTime",
    );
    const layer_json = get_layer_from_json_by_comp(expected, "outPoint_clamp_with_startTime");
    expect(isclose(layer.start_time, 3.0, 1e-9, 0.001)).toBe(true);
    expect(isclose(layer.out_point, layer_json["outPoint"], 1e-9, 0.001)).toBe(true);
    expect(isclose(layer.out_point, 8.0, 1e-9, 0.001)).toBe(true);
  });

  /** Layer with inPoint (5) before startTime (10). */
  test("test_inPoint_before_startTime", () => {
    const expected = load_expected(SAMPLES_DIR, "inPoint");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("inPoint.aep")), "inPoint_before_startTime");
    const layer_json = get_layer_from_json_by_comp(expected, "inPoint_before_startTime");
    expect(isclose(layer.in_point, layer_json["inPoint"])).toBe(true);
    expect(isclose(layer.in_point, 5.0)).toBe(true);
    expect(isclose(layer.start_time, layer_json["startTime"])).toBe(true);
    expect(isclose(layer.start_time, 10.0)).toBe(true);
  });

  /** Layer with negative startTime (-5) and outPoint (20). */
  test("test_outPoint_with_negative_startTime", () => {
    const expected = load_expected(SAMPLES_DIR, "outPoint");
    const layer = get_layer(
      parse_project(SAMPLES_DIR.div("outPoint.aep")),
      "outPoint_with_negative_startTime",
    );
    const layer_json = get_layer_from_json_by_comp(expected, "outPoint_with_negative_startTime");
    expect(isclose(layer.start_time, layer_json["startTime"])).toBe(true);
    expect(isclose(layer.start_time, -5.0)).toBe(true);
    expect(isclose(layer.in_point, layer_json["inPoint"])).toBe(true);
    expect(isclose(layer.in_point, -5.0)).toBe(true);
    expect(isclose(layer.out_point, layer_json["outPoint"])).toBe(true);
    expect(isclose(layer.out_point, 20.0)).toBe(true);
  });
});

/** Tests for different layer types. */
describe("TestLayerTypes", () => {
  test("test_type_camera", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("type.aep")), "type_camera");
    expect(layer.layer_type).toBe("CameraLayer");
    expect(layer instanceof CameraLayer).toBe(true);
  });

  test("test_type_null", () => {
    const expected = load_expected(SAMPLES_DIR, "type");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("type.aep")), "type_null");
    const layer_json = get_layer_from_json_by_comp(expected, "type_null");
    expect(layer_json["nullLayer"]).toBe(true);
    expect(layer.null_layer).toBe(layer_json["nullLayer"]);
  });

  test("test_type_shape", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("type.aep")), "type_shape");
    expect(layer.layer_type).toBe("Layer");
    expect(layer instanceof ShapeLayer).toBe(true);
  });

  test("test_type_text", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("type.aep")), "type_text");
    expect(layer.layer_type).toBe("Layer");
    expect(layer instanceof TextLayer).toBe(true);
  });
});

/** Tests for light layer types. */
describe("TestLightTypes", () => {
  test("test_lightType_AMBIENT", () => {
    const expected = load_expected(SAMPLES_DIR, "lightType");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("lightType.aep")), "lightType_AMBIENT");
    const layer_json = get_layer_from_json_by_comp(expected, "lightType_AMBIENT");
    expect(as_instance(layer, LightLayer).light_type).toBe(layer_json["lightType"]);
    expect(layer_json["lightType"]).toBe(LightType.AMBIENT);
  });

  test("test_lightType_POINT", () => {
    const expected = load_expected(SAMPLES_DIR, "lightType");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("lightType.aep")), "lightType_POINT");
    const layer_json = get_layer_from_json_by_comp(expected, "lightType_POINT");
    expect(as_instance(layer, LightLayer).light_type).toBe(layer_json["lightType"]);
    expect(layer_json["lightType"]).toBe(LightType.POINT);
  });

  test("test_lightType_SPOT", () => {
    const expected = load_expected(SAMPLES_DIR, "lightType");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("lightType.aep")), "lightType_SPOT");
    const layer_json = get_layer_from_json_by_comp(expected, "lightType_SPOT");
    expect(as_instance(layer, LightLayer).light_type).toBe(layer_json["lightType"]);
    expect(layer_json["lightType"]).toBe(LightType.SPOT);
  });

  test("test_lightType_PARALLEL", () => {
    const expected = load_expected(SAMPLES_DIR, "lightType");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("lightType.aep")), "lightType_PARALLEL");
    const layer_json = get_layer_from_json_by_comp(expected, "lightType_PARALLEL");
    expect(as_instance(layer, LightLayer).light_type).toBe(layer_json["lightType"]);
    expect(layer_json["lightType"]).toBe(LightType.PARALLEL);
  });

  test("test_lightType_ENVIRONMENT", () => {
    const project = parse_project(SAMPLES_DIR.div("light_source_default.aep"));
    const layer = get_first_layer(project);
    expect(layer instanceof LightLayer).toBe(true);
    expect(as_instance(layer, LightLayer).light_type).toBe(LightType.ENVIRONMENT);
  });
});

/** Tests for AVLayer-specific attributes. */
describe("TestAVLayerAttributes", () => {
  test("test_threeDLayer_true", () => {
    const expected = load_expected(SAMPLES_DIR, "avlayer_flags");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("avlayer_flags.aep")), "threeDLayer_true");
    const layer_json = get_layer_from_json_by_comp(expected, "threeDLayer_true");
    expect(layer instanceof AVLayer).toBe(true);
    expect(layer_json["threeDLayer"]).toBe(true);
    expect(as_instance(layer, AVLayer).three_d_layer).toBe(layer_json["threeDLayer"]);
  });

  test("test_adjustmentLayer_true", () => {
    const expected = load_expected(SAMPLES_DIR, "avlayer_flags");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("avlayer_flags.aep")), "adjustmentLayer_true");
    const layer_json = get_layer_from_json_by_comp(expected, "adjustmentLayer_true");
    expect(layer.adjustment_layer).toBe(layer_json["adjustmentLayer"]);
    expect(layer_json["adjustmentLayer"]).toBe(true);
  });

  test("test_guideLayer_true", () => {
    const expected = load_expected(SAMPLES_DIR, "avlayer_flags");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("avlayer_flags.aep")), "guideLayer_true");
    const layer_json = get_layer_from_json_by_comp(expected, "guideLayer_true");
    expect(as_instance(layer, AVLayer).guide_layer).toBe(layer_json["guideLayer"]);
    expect(layer_json["guideLayer"]).toBe(true);
  });

  test("test_collapseTransformation_true", () => {
    const expected = load_expected(SAMPLES_DIR, "avlayer_flags");
    const layer = get_layer(
      parse_project(SAMPLES_DIR.div("avlayer_flags.aep")),
      "collapseTransformation_true",
    );
    const layer_json = get_layer_from_json_by_comp(expected, "collapseTransformation_true");
    expect(as_instance(layer, AVLayer).collapse_transformation).toBe(layer_json["collapseTransformation"]);
    expect(layer_json["collapseTransformation"]).toBe(true);
  });

  test("test_preserveTransparency_true", () => {
    const expected = load_expected(SAMPLES_DIR, "avlayer_flags");
    const layer = get_layer(
      parse_project(SAMPLES_DIR.div("avlayer_flags.aep")),
      "preserveTransparency_true",
    );
    const layer_json = get_layer_from_json_by_comp(expected, "preserveTransparency_true");
    expect(as_instance(layer, AVLayer).preserve_transparency).toBe(layer_json["preserveTransparency"]);
    expect(layer_json["preserveTransparency"]).toBe(true);
  });

  test("test_motionBlur_true", () => {
    const expected = load_expected(SAMPLES_DIR, "avlayer_flags");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("avlayer_flags.aep")), "motionBlur_true");
    const layer_json = get_layer_from_json_by_comp(expected, "motionBlur_true");
    expect(as_instance(layer, AVLayer).motion_blur).toBe(layer_json["motionBlur"]);
    expect(layer_json["motionBlur"]).toBe(true);
  });

  test("test_effectsActive_false", () => {
    const expected = load_expected(SAMPLES_DIR, "avlayer_flags");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("avlayer_flags.aep")), "effectsActive_false");
    const layer_json = get_layer_from_json_by_comp(expected, "effectsActive_false");
    expect(layer_json["effectsActive"]).toBe(false);
    expect(as_instance(layer, AVLayer).effects_active).toBe(layer_json["effectsActive"]);
  });
});

/** Tests for blending mode attributes. */
describe("TestBlendingModes", () => {
  test("test_blendingMode_ADD", () => {
    const expected = load_expected(SAMPLES_DIR, "blendingMode");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("blendingMode.aep")), "blendingMode_ADD");
    const layer_json = get_layer_from_json_by_comp(expected, "blendingMode_ADD");
    expect(as_instance(layer, AVLayer).blending_mode).toBe(layer_json["blendingMode"]);
    expect(layer_json["blendingMode"]).toBe(BlendingMode.ADD);
  });

  test("test_blendingMode_MULTIPLY", () => {
    const expected = load_expected(SAMPLES_DIR, "blendingMode");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("blendingMode.aep")), "blendingMode_MULTIPLY");
    const layer_json = get_layer_from_json_by_comp(expected, "blendingMode_MULTIPLY");
    expect(as_instance(layer, AVLayer).blending_mode).toBe(layer_json["blendingMode"]);
    expect(layer_json["blendingMode"]).toBe(BlendingMode.MULTIPLY);
  });

  test("test_blendingMode_SCREEN", () => {
    const expected = load_expected(SAMPLES_DIR, "blendingMode");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("blendingMode.aep")), "blendingMode_SCREEN");
    const layer_json = get_layer_from_json_by_comp(expected, "blendingMode_SCREEN");
    expect(as_instance(layer, AVLayer).blending_mode).toBe(layer_json["blendingMode"]);
    expect(layer_json["blendingMode"]).toBe(BlendingMode.SCREEN);
  });
});

/** Tests for layer quality settings. */
describe("TestQualitySettings", () => {
  test("test_quality_BEST", () => {
    const expected = load_expected(SAMPLES_DIR, "quality");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("quality.aep")), "quality_BEST");
    const layer_json = get_layer_from_json_by_comp(expected, "quality_BEST");
    expect(as_instance(layer, AVLayer).quality).toBe(layer_json["quality"]);
    expect(layer_json["quality"]).toBe(LayerQuality.BEST);
  });

  test("test_quality_DRAFT", () => {
    const expected = load_expected(SAMPLES_DIR, "quality");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("quality.aep")), "quality_DRAFT");
    const layer_json = get_layer_from_json_by_comp(expected, "quality_DRAFT");
    expect(as_instance(layer, AVLayer).quality).toBe(layer_json["quality"]);
    expect(layer_json["quality"]).toBe(LayerQuality.DRAFT);
  });

  test("test_quality_WIREFRAME", () => {
    const expected = load_expected(SAMPLES_DIR, "quality");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("quality.aep")), "quality_WIREFRAME");
    const layer_json = get_layer_from_json_by_comp(expected, "quality_WIREFRAME");
    expect(as_instance(layer, AVLayer).quality).toBe(layer_json["quality"]);
    expect(layer_json["quality"]).toBe(LayerQuality.WIREFRAME);
  });

  test("test_samplingQuality_BICUBIC", () => {
    const expected = load_expected(SAMPLES_DIR, "avlayer_flags");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("avlayer_flags.aep")), "samplingQuality_BICUBIC");
    const layer_json = get_layer_from_json_by_comp(expected, "samplingQuality_BICUBIC");
    expect(as_instance(layer, AVLayer).sampling_quality).toBe(layer_json["samplingQuality"]);
    expect(layer_json["samplingQuality"]).toBe(LayerSamplingQuality.BICUBIC);
  });
});

/** Tests for frame blending type. */
describe("TestFrameBlending", () => {
  test("test_frameBlendingType_NO_FRAME_BLEND", () => {
    const expected = load_expected(SAMPLES_DIR, "frameBlendingType");
    const layer = get_layer(
      parse_project(SAMPLES_DIR.div("frameBlendingType.aep")),
      "frameBlendingType_NO_FRAME_BLEND",
    );
    const layer_json = get_layer_from_json_by_comp(expected, "frameBlendingType_NO_FRAME_BLEND");
    expect(as_instance(layer, AVLayer).frame_blending_type).toBe(layer_json["frameBlendingType"]);
    expect(layer_json["frameBlendingType"]).toBe(FrameBlendingType.NO_FRAME_BLEND);
    expect(as_instance(layer, AVLayer).frame_blending).toBe(false);
  });

  test("test_frameBlendingType_FRAME_MIX", () => {
    const expected = load_expected(SAMPLES_DIR, "frameBlendingType");
    const layer = get_layer(
      parse_project(SAMPLES_DIR.div("frameBlendingType.aep")),
      "frameBlendingType_FRAME_MIX",
    );
    const layer_json = get_layer_from_json_by_comp(expected, "frameBlendingType_FRAME_MIX");
    expect(as_instance(layer, AVLayer).frame_blending_type).toBe(layer_json["frameBlendingType"]);
    expect(layer_json["frameBlendingType"]).toBe(FrameBlendingType.FRAME_MIX);
  });

  test("test_frameBlendingType_PIXEL_MOTION", () => {
    const expected = load_expected(SAMPLES_DIR, "frameBlendingType");
    const layer = get_layer(
      parse_project(SAMPLES_DIR.div("frameBlendingType.aep")),
      "frameBlendingType_PIXEL_MOTION",
    );
    const layer_json = get_layer_from_json_by_comp(expected, "frameBlendingType_PIXEL_MOTION");
    expect(as_instance(layer, AVLayer).frame_blending_type).toBe(layer_json["frameBlendingType"]);
    expect(layer_json["frameBlendingType"]).toBe(FrameBlendingType.PIXEL_MOTION);
  });
});

/** Tests for auto-orient settings. */
describe("TestAutoOrient", () => {
  test("test_autoOrient_ALONG_PATH", () => {
    const expected = load_expected(SAMPLES_DIR, "autoOrient");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("autoOrient.aep")), "autoOrient_ALONG_PATH");
    const layer_json = get_layer_from_json_by_comp(expected, "autoOrient_ALONG_PATH");
    expect(layer.auto_orient).toBe(layer_json["autoOrient"]);
    expect(layer_json["autoOrient"]).toBe(AutoOrientType.ALONG_PATH);
  });

  test("test_autoOrient_CAMERA", () => {
    const expected = load_expected(SAMPLES_DIR, "autoOrient");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("autoOrient.aep")), "autoOrient_CAMERA");
    const layer_json = get_layer_from_json_by_comp(expected, "autoOrient_CAMERA");
    expect(layer.auto_orient).toBe(layer_json["autoOrient"]);
    expect(layer_json["autoOrient"]).toBe(AutoOrientType.CAMERA_OR_POINT_OF_INTEREST);
    expect(as_instance(layer, AVLayer).three_d_layer).toBe(true);
  });

  test("test_autoOrient_CHARACTERS", () => {
    const expected = load_expected(SAMPLES_DIR, "autoOrient");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("autoOrient.aep")), "autoOrient_CHARACTERS");
    const layer_json = get_layer_from_json_by_comp(expected, "autoOrient_CHARACTERS");
    expect(layer.auto_orient).toBe(layer_json["autoOrient"]);
    expect(layer_json["autoOrient"]).toBe(AutoOrientType.CHARACTERS_TOWARD_CAMERA);
    expect(as_instance(layer, AVLayer).three_d_layer).toBe(true);
  });
});

/** Tests for track matte settings. */
describe("TestTrackMatte", () => {
  test("test_trackMatteType_ALPHA", () => {
    const expected = load_expected(SAMPLES_DIR, "trackMatteType");
    const project = parse_project(SAMPLES_DIR.div("trackMatteType.aep"));
    const comp = get_comp(project, "trackMatteType_ALPHA");
    const matted_layer = comp.layers.find((layer) => as_instance(layer, AVLayer).track_matte_type === TrackMatteType.ALPHA) ?? null;
    let expected_layer = null;
    for (const item of expected["items"]) {
      if (item["name"] === "trackMatteType_ALPHA" && "layers" in item) {
        for (const lj of item["layers"]) {
          if (lj["trackMatteType"] === TrackMatteType.ALPHA) {
            expected_layer = lj;
            break;
          }
        }
      }
    }
    expect(matted_layer != null).toBe(true);
    py_assert(expected_layer != null);
    expect(as_instance(matted_layer, AVLayer).track_matte_type).toBe(expected_layer["trackMatteType"]);
  });

  test("test_trackMatteType_LUMA", () => {
    const expected = load_expected(SAMPLES_DIR, "trackMatteType");
    const project = parse_project(SAMPLES_DIR.div("trackMatteType.aep"));
    const comp = get_comp(project, "trackMatteType_LUMA");
    const matted_layer = comp.layers.find((layer) => as_instance(layer, AVLayer).track_matte_type === TrackMatteType.LUMA) ?? null;
    let expected_layer = null;
    for (const item of expected["items"]) {
      if (item["name"] === "trackMatteType_LUMA" && "layers" in item) {
        for (const lj of item["layers"]) {
          if (lj["trackMatteType"] === TrackMatteType.LUMA) {
            expected_layer = lj;
            break;
          }
        }
      }
    }
    expect(matted_layer != null).toBe(true);
    py_assert(expected_layer != null);
    expect(as_instance(matted_layer, AVLayer).track_matte_type).toBe(expected_layer["trackMatteType"]);
  });

  test("test_has_track_matte", () => {
    const expected = load_expected(SAMPLES_DIR, "track_matte_yes");
    const project = parse_project(SAMPLES_DIR.div("track_matte_yes.aep"));
    const comp = project.compositions[0];
    let expected_layers = null;
    for (const item of expected["items"]) {
      if ("layers" in item) {
        expected_layers = item["layers"];
        break;
      }
    }
    py_assert(expected_layers != null);
    for (const [layer, exp] of zip(comp.layers, expected_layers)) {
      expect(as_instance(layer, AVLayer).has_track_matte).toBe(exp["hasTrackMatte"]);
    }
  });

  test("test_has_track_matte_false", () => {
    const expected = load_expected(SAMPLES_DIR, "track_matte_no");
    const project = parse_project(SAMPLES_DIR.div("track_matte_no.aep"));
    const comp = project.compositions[0];
    let expected_layers = null;
    for (const item of expected["items"]) {
      if ("layers" in item) {
        expected_layers = item["layers"];
        break;
      }
    }
    expect(expected_layers != null).toBe(true);
    for (const layer of comp.layers) {
      expect(as_instance(layer, AVLayer).has_track_matte).toBe(false);
    }
  });

  test("test_is_track_matte", () => {
    const expected = load_expected(SAMPLES_DIR, "track_matte_yes");
    const project = parse_project(SAMPLES_DIR.div("track_matte_yes.aep"));
    const comp = project.compositions[0];
    let expected_layers = null;
    for (const item of expected["items"]) {
      if ("layers" in item) {
        expected_layers = item["layers"];
        break;
      }
    }
    py_assert(expected_layers != null);
    for (const [layer, exp] of zip(comp.layers, expected_layers)) {
      expect(as_instance(layer, AVLayer).is_track_matte).toBe(exp["isTrackMatte"]);
    }
  });

  test("test_is_track_matte_false", () => {
    const project = parse_project(SAMPLES_DIR.div("track_matte_no.aep"));
    const comp = project.compositions[0];
    for (const layer of comp.layers) {
      expect(as_instance(layer, AVLayer).is_track_matte).toBe(false);
    }
  });

  test("test_track_matte_layer", () => {
    const project = parse_project(SAMPLES_DIR.div("track_matte_yes.aep"));
    const comp = project.compositions[0];
    const matted_layer = comp.layers.find((layer) => as_instance(layer, AVLayer).has_track_matte) ?? null;
    expect(matted_layer != null).toBe(true);
    expect(as_instance(matted_layer, AVLayer).track_matte_layer != null).toBe(true);
    expect(as_instance(as_instance(matted_layer, AVLayer).track_matte_layer, AVLayer).is_track_matte).toBe(true);
  });

  test("test_track_matte_layer_none", () => {
    const project = parse_project(SAMPLES_DIR.div("track_matte_no.aep"));
    const comp = project.compositions[0];
    for (const layer of comp.layers) {
      expect(as_instance(layer, AVLayer).track_matte_layer == null).toBe(true);
    }
  });
});

/** Tests for layer parenting. */
describe("TestParenting", () => {
  test("test_parent", () => {
    const expected = load_expected(SAMPLES_DIR, "layer_misc");
    const project = parse_project(SAMPLES_DIR.div("layer_misc.aep"));
    const comp = get_comp(project, "parent");
    const child_layer = comp.layers.find((layer) => layer._parent_id !== 0) ?? null;
    expect(child_layer != null).toBe(true);
    if (child_layer == null) throw new Error("no parented layer in comp 'parent'");
    for (const item of expected["items"]) {
      if (item["name"] === "parent" && "layers" in item) {
        for (const layer_json of item["layers"]) {
          if (layer_json["parent"] != null) {
            expect(child_layer._parent_id).toBe(layer_json["parent"]);
          }
        }
      }
    }
  });
});

/** Tests for time remap. */
describe("TestTimeRemap", () => {
  test("test_timeRemapEnabled_true", () => {
    const expected = load_expected(SAMPLES_DIR, "avlayer_flags");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("avlayer_flags.aep")), "timeRemapEnabled_true");
    const layer_json = get_layer_from_json_by_comp(expected, "timeRemapEnabled_true");
    expect(layer_json["timeRemapEnabled"]).toBe(true);
    expect(as_instance(layer, AVLayer).time_remap_enabled).toBe(layer_json["timeRemapEnabled"]);
  });
});

/** Tests for audio attributes. */
describe("TestAudio", () => {
  test("test_audioEnabled_true", () => {
    const expected = load_expected(SAMPLES_DIR, "audioEnabled");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("audioEnabled.aep")), "audioEnabled_true");
    const layer_json = get_layer_from_json_by_comp(expected, "audioEnabled_true");
    expect(as_instance(layer, AVLayer).audio_enabled).toBe(layer_json["audioEnabled"]);
    expect(layer_json["audioEnabled"]).toBe(true);
  });

  test("test_audioEnabled_false", () => {
    const expected = load_expected(SAMPLES_DIR, "audioEnabled");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("audioEnabled.aep")), "audioEnabled_false");
    const layer_json = get_layer_from_json_by_comp(expected, "audioEnabled_false");
    expect(layer_json["audioEnabled"]).toBe(false);
    expect(as_instance(layer, AVLayer).audio_enabled).toBe(layer_json["audioEnabled"]);
  });

  /** An audio-only layer has no pixels: AE centres its anchor on a 1x1 box. */
  test("test_audio_only_anchor_point", () => {
    const expected = load_expected(SAMPLES_DIR, "audioEnabled");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("audioEnabled.aep")), "audioEnabled_true");
    const layer_json = get_layer_from_json_by_comp(expected, "audioEnabled_true");
    const transform_json = layer_json["properties"].find((p) => p.matchName === "ADBE Transform Group");
    if (transform_json === undefined) throw new StopIteration();
    const anchor_json = json_field(transform_json, "properties").find((p) => p.matchName === "ADBE Anchor Point");
    if (anchor_json === undefined) throw new StopIteration();
    const anchor = layer.property("ADBE Transform Group").property("ADBE Anchor Point");
    expect(py_eq(anchor.value, json_field(anchor_json, "value"))).toBe(true);
    expect(py_eq(json_field(anchor_json, "value"), [0.5, 0.5, 0])).toBe(true);
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
    const expected = load_expected(BUGS_DIR, "windows-1250_decoding_error");
    const layer = get_first_layer(parse_project(BUGS_DIR.div("windows-1250_decoding_error.aep")));
    const layer_json = get_layer_from_json(expected);
    expect(layer.name).toBe(layer_json["name"]);
    expect(layer.name).toBe("≈");
  });
});

/** Tests for Layer.active_at_time() method. */
describe("TestActiveAtTime", () => {
  /** An enabled, non-soloed layer returns True inside its in/out range. */
  test("test_enabled_layer_within_range", () => {
    const project = parse_project(SAMPLES_DIR.div("layer_timing.aep"));
    const layer = get_layer(project, "startTime_5");
    expect(layer.enabled).toBe(true);
    const midpoint = (layer.in_point + layer.out_point) / 2;
    expect(layer.active_at_time(midpoint)).toBe(true);
  });

  /** Layer is active exactly at its in_point (inclusive). */
  test("test_at_in_point", () => {
    const project = parse_project(SAMPLES_DIR.div("inPoint.aep"));
    const layer = get_layer(project, "inPoint_5");
    expect(layer.active_at_time(layer.in_point)).toBe(true);
  });

  /** Layer is not active at its out_point (exclusive). */
  test("test_at_out_point", () => {
    const project = parse_project(SAMPLES_DIR.div("inPoint.aep"));
    const layer = get_layer(project, "inPoint_5");
    expect(layer.active_at_time(layer.out_point)).toBe(false);
  });

  /** Layer is not active before its in_point. */
  test("test_before_in_point", () => {
    const project = parse_project(SAMPLES_DIR.div("inPoint.aep"));
    const layer = get_layer(project, "inPoint_5");
    expect(layer.active_at_time(layer.in_point - 1)).toBe(false);
  });

  /** A disabled layer is never active. */
  test("test_disabled_layer", () => {
    const project = parse_project(SAMPLES_DIR.div("layer_switches.aep"));
    const layer = get_layer(project, "enabled_false");
    expect(layer.enabled).toBe(false);
    const midpoint = (layer.in_point + layer.out_point) / 2;
    expect(layer.active_at_time(midpoint)).toBe(false);
  });

  /** A soloed layer is active within its time range. */
  test("test_solo_layer_active", () => {
    const project = parse_project(SAMPLES_DIR.div("layer_switches.aep"));
    const layer = get_layer(project, "solo_true");
    expect(layer.solo).toBe(true);
    const midpoint = (layer.in_point + layer.out_point) / 2;
    expect(layer.active_at_time(midpoint)).toBe(true);
  });

  /** A non-soloed layer is inactive when another layer in the comp is soloed. */
  test("test_non_solo_layer_inactive_when_other_is_soloed", () => {
    const project = parse_project(SAMPLES_DIR.div("layer_switches.aep"));
    const comp = get_comp(project, "solo_true");
    const non_solo_layers = comp.layers.filter((lyr) => !lyr.solo);
    if (py_bool(non_solo_layers)) {
      const layer = non_solo_layers[0];
      const midpoint = (layer.in_point + layer.out_point) / 2;
      expect(layer.active_at_time(midpoint)).toBe(false);
    }
  });
});

/** Tests for AVLayer.audio_active_at_time() method. */
describe("TestAudioActiveAtTime", () => {
  /** Layer with audio enabled returns True inside its time range. */
  test("test_audio_active_within_range", () => {
    const project = parse_project(SAMPLES_DIR.div("audioEnabled.aep"));
    const layer = get_layer(project, "audioEnabled_true");
    expect(layer instanceof AVLayer).toBe(true);
    const midpoint = (layer.in_point + layer.out_point) / 2;
    expect(as_instance(layer, AVLayer).audio_active_at_time(midpoint)).toBe(true);
  });

  /** Layer with audio_enabled=False returns False. */
  test("test_audio_disabled", () => {
    const project = parse_project(SAMPLES_DIR.div("audioEnabled.aep"));
    const layer = get_layer(project, "audioEnabled_false");
    expect(layer instanceof AVLayer).toBe(true);
    const midpoint = (layer.in_point + layer.out_point) / 2;
    expect(as_instance(layer, AVLayer).audio_active_at_time(midpoint)).toBe(false);
  });

  /** Layer is not audio-active before its in_point. */
  test("test_before_in_point", () => {
    const project = parse_project(SAMPLES_DIR.div("audioEnabled.aep"));
    const layer = get_layer(project, "audioEnabled_true");
    expect(layer instanceof AVLayer).toBe(true);
    expect(as_instance(layer, AVLayer).audio_active_at_time(layer.in_point - 1)).toBe(false);
  });

  /** Layer is not audio-active at its out_point (exclusive). */
  test("test_at_out_point", () => {
    const project = parse_project(SAMPLES_DIR.div("audioEnabled.aep"));
    const layer = get_layer(project, "audioEnabled_true");
    expect(layer instanceof AVLayer).toBe(true);
    expect(as_instance(layer, AVLayer).audio_active_at_time(layer.out_point)).toBe(false);
  });

  /** Layer is audio-active at its in_point (inclusive). */
  test("test_at_in_point", () => {
    const project = parse_project(SAMPLES_DIR.div("audioEnabled.aep"));
    const layer = get_layer(project, "audioEnabled_true");
    expect(layer instanceof AVLayer).toBe(true);
    expect(as_instance(layer, AVLayer).audio_active_at_time(layer.in_point)).toBe(true);
  });

  /** audio_active property delegates to audio_active_at_time(time). */
  test("test_audio_active_property", () => {
    const project = parse_project(SAMPLES_DIR.div("audioEnabled.aep"));
    const layer = get_layer(project, "audioEnabled_true");
    expect(layer instanceof AVLayer).toBe(true);
    expect(as_instance(layer, AVLayer).audio_active).toBe(as_instance(layer, AVLayer).audio_active_at_time(layer.time));
  });
});

/** Tests for Layer's PropertyGroup / PropertyBase inheritance. */
describe("TestLayerPropertyGroupInheritance", () => {
  /** Layer is an instance of PropertyGroup. */
  test("test_layer_is_property_group", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    expect(layer instanceof PropertyGroup).toBe(true);
  });

  /** Layer is an instance of PropertyBase. */
  test("test_layer_is_property_base", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    expect(layer instanceof PropertyBase).toBe(true);
  });

  /** Layers are at depth 0 (root of the property hierarchy). */
  test("test_property_depth_is_zero", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    expect(layer.property_depth).toBe(0);
  });

  /** Layer property_type is NAMED_GROUP. */
  test("test_property_type_named_group", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    expect(layer.property_type).toBe(PropertyType.NAMED_GROUP);
  });

  /** AVLayer has the correct ExtendScript match name. */
  test("test_av_layer_match_name", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    expect(layer instanceof AVLayer).toBe(true);
    expect(layer.match_name).toBe("ADBE AV Layer");
  });

  /** Layer.properties includes the Transform group. */
  test("test_properties_contains_transform", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    const match_names = layer.properties.map((p) => p.match_name);
    expect(match_names.includes("ADBE Transform Group")).toBe(true);
  });

  /** Layer.transform returns the Transform PropertyGroup. */
  test("test_transform_accessor", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    expect(layer.transform instanceof PropertyGroup).toBe(true);
    expect(layer.transform.match_name).toBe("ADBE Transform Group");
  });

  /** Layer.effects is an empty (falsy) group when there are no effects. */
  test("test_effects_empty_when_no_effects", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    // Basic layer without effects: the group exists (as in ExtendScript)
    // but holds no children, so it is falsy.
    expect(layer.effects != null).toBe(true);
    expect(len(layer.effects)).toBe(0);
    expect(py_bool(layer.effects)).toBe(false);
  });

  /** Layer.num_properties returns the count of top-level property groups. */
  test("test_num_properties_positive", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    expect(layer.num_properties).toBe(len(layer.properties));
    expect(layer.num_properties > 0).toBe(true);
  });

  /** Layer.active reflects active_at_time(time). */
  test("test_active_property", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    expect(layer.active).toBe(layer.active_at_time(layer.time));
  });

  /** Two Layer objects are only equal when they are the same object. */
  test("test_identity_equality", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    expect(py_eq(layer, layer)).toBe(true);
    // A copy (different object) should not be equal
    expect(!py_eq(layer, {})).toBe(true); // Python `object()`
  });

  /** Layer.transform returns the same PropertyGroup as in properties list. */
  test("test_transform_is_same_object_in_properties", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    const transform_from_list = layer.properties.find((p) => p.match_name === "ADBE Transform Group");
    if (transform_from_list == null) throw new StopIteration();
    expect(layer.transform === transform_from_list).toBe(true);
  });

  /** len(layer) equals layer.num_properties. */
  test("test_len_equals_num_properties", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    expect(len(layer)).toBe(layer.num_properties);
    expect(len(layer)).toBe(len(layer.properties));
  });

  /** layer[0] returns the first child property group. */
  test("test_getitem_by_int_index", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    expect(layer.property(0) === layer.properties[0]).toBe(true);
  });

  /** layer['ADBE Transform Group'] returns the Transform group. */
  test("test_getitem_by_match_name", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    const result = layer.property("ADBE Transform Group");
    expect(result instanceof PropertyGroup).toBe(true);
    expect(result.match_name).toBe("ADBE Transform Group");
    expect(result === layer.transform).toBe(true);
  });

  /** layer['Transform'] returns the Transform group by display name. */
  test("test_getitem_by_display_name", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    const result = layer.property("Transform");
    expect(result instanceof PropertyGroup).toBe(true);
    expect(result.match_name).toBe("ADBE Transform Group");
  });

  /** layer['ADBE Transform Group']['ADBE Position'] chains correctly. */
  test("test_getitem_chained", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    const transform = layer.property("ADBE Transform Group");
    const position = transform.property("ADBE Position");
    expect(position.match_name).toBe("ADBE Position");
  });

  /** layer['nonexistent'] raises KeyError. */
  test("test_getitem_key_error", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    raises(KeyError, () => {
      layer.property("nonexistent_match_name");
    });
  });

  /** layer[9999] raises IndexError. */
  test("test_getitem_index_error", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    raises(IndexError, () => {
      layer.property(9999);
    });
  });

  /** layer[1.5] raises TypeError. */
  test("test_getitem_type_error", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    raises(TypeError_, () => {
      layer.property(1.5);
    });
  });

  /** layer.transform.position resolves via __getattr__. */
  test("test_getattr_single_word", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    const position = layer.transform.__getattr__("position");
    expect(position.match_name).toBe("ADBE Position");
  });

  /** layer.transform.anchor_point resolves 'Anchor Point'. */
  test("test_getattr_multi_word", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    const anchor = layer.transform.__getattr__("anchor_point");
    expect(anchor.match_name).toBe("ADBE Anchor Point");
  });

  /** Accessing a nonexistent child raises AttributeError. */
  test("test_getattr_attribute_error", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    raises(AttributeError, () => {
      layer.transform.__getattr__("nonexistent");
    });
  });

  /** Class attributes take priority over __getattr__. */
  test("test_getattr_does_not_shadow_fields", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("layer_switches.aep")), "enabled_false");
    // 'name' is a class attribute, should NOT look in children
    expect(typeof layer.transform.name === "string").toBe(true);
  });
});

/** Tests for ThreeDModelLayer parsing. */
describe("TestThreeDModelLayer", () => {
  /** ThreeDModelLayer inherits from AVLayer. */
  test("test_isinstance", () => {
    const project = parse_project(SAMPLES_DIR.div("three_d_model_layer.aep"));
    const layer = get_first_layer(project);
    expect(layer instanceof ThreeDModelLayer).toBe(true);
    expect(layer instanceof AVLayer).toBe(true);
  });

  /** ThreeDModelLayer match_name is 'ADBE 3D Model Layer'. */
  test("test_match_name", () => {
    const project = parse_project(SAMPLES_DIR.div("three_d_model_layer.aep"));
    const layer = get_first_layer(project);
    expect(layer.match_name).toBe("ADBE 3D Model Layer");
  });

  /** ThreeDModelLayer layer_type is 'Layer'. */
  test("test_layer_type", () => {
    const project = parse_project(SAMPLES_DIR.div("three_d_model_layer.aep"));
    const layer = get_first_layer(project);
    expect(layer.layer_type).toBe("Layer");
  });

  /** ThreeDModelLayer always reports three_d_layer=True. */
  test("test_three_d_layer", () => {
    const project = parse_project(SAMPLES_DIR.div("three_d_model_layer.aep"));
    const layer = get_first_layer(project);
    expect(layer instanceof ThreeDModelLayer).toBe(true);
    expect(as_instance(layer, ThreeDModelLayer).three_d_layer).toBe(true);
  });

  /** ThreeDModelLayer has collapse_transformation=True. */
  test("test_collapse_transformation", () => {
    const project = parse_project(SAMPLES_DIR.div("three_d_model_layer.aep"));
    const layer = get_first_layer(project);
    expect(layer instanceof ThreeDModelLayer).toBe(true);
    expect(as_instance(layer, ThreeDModelLayer).collapse_transformation).toBe(true);
  });

  /** ThreeDModelLayer source is a FootageItem. */
  test("test_source_is_footage", () => {
    const project = parse_project(SAMPLES_DIR.div("three_d_model_layer.aep"));
    const layer = get_first_layer(project);
    expect(layer instanceof ThreeDModelLayer).toBe(true);
    const source = as_instance(layer, ThreeDModelLayer).source;
    expect(source != null).toBe(true);
    if (source == null) throw new Error("ThreeDModelLayer has no source");
    expect(source.name).toBe("crystal.fbx");
  });

  /** CompItem.three_d_model_layers filters correctly. */
  test("test_comp_three_d_model_layers", () => {
    const project = parse_project(SAMPLES_DIR.div("three_d_model_layer.aep"));
    const comp = project.compositions[0];
    expect(len(comp.three_d_model_layers)).toBe(1);
    expect(comp.three_d_model_layers[0] instanceof ThreeDModelLayer).toBe(true);
  });

  /** ThreeDModelLayer.can_set_collapse_transformation is always True. */
  test("test_can_set_collapse_transformation", () => {
    const project = parse_project(SAMPLES_DIR.div("three_d_model_layer.aep"));
    const layer = get_first_layer(project);
    expect(layer instanceof ThreeDModelLayer).toBe(true);
    expect(as_instance(layer, ThreeDModelLayer).can_set_collapse_transformation).toBe(true);
  });

  /** ThreeDModelLayer.can_set_time_remap_enabled is always False. */
  test("test_can_set_time_remap_enabled", () => {
    const project = parse_project(SAMPLES_DIR.div("three_d_model_layer.aep"));
    const layer = get_first_layer(project);
    expect(layer instanceof ThreeDModelLayer).toBe(true);
    expect(as_instance(layer, ThreeDModelLayer).can_set_time_remap_enabled).toBe(false);
  });
});

/** Tests for AVLayer.three_d_per_char attribute. */
describe("TestThreeDPerChar", () => {
  /** three_d_per_char is True when per-character 3D is enabled. */
  test("test_three_d_per_char_on", () => {
    const project = parse_project(SAMPLES_DIR.div("threeDPerChar_on.aep"));
    const layer = get_first_layer(project);
    expect(layer instanceof AVLayer).toBe(true);
    expect(as_instance(layer, AVLayer).three_d_per_char).toBe(true);
  });

  /** three_d_per_char is False when per-character 3D is disabled. */
  test("test_three_d_per_char_off", () => {
    const project = parse_project(SAMPLES_DIR.div("threeDPerChar_off.aep"));
    const layer = get_first_layer(project);
    expect(layer instanceof AVLayer).toBe(true);
    expect(as_instance(layer, AVLayer).three_d_per_char).toBe(false);
  });
});

/** Canonical order of top-level property groups per layer type. */
describe("TestTopLevelGroupOrder", () => {
  test("test_camera_layer", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("type.aep")), "type_camera");
    expect(layer instanceof CameraLayer).toBe(true);
    const match_names = layer.properties.map((p) => p.match_name);
    // Canonical groups first, then non-canonical tail (Camera Options)
    expect(
      py_eq(match_names, ["ADBE Marker", "ADBE Transform Group", "ADBE Camera Options Group"]),
    ).toBe(true);
  });

  test("test_light_layer", () => {
    const project = parse_project(SAMPLES_DIR.div("lightType.aep"));
    // Use any light comp
    const layer = get_layer(project, "lightType_PARALLEL");
    expect(layer instanceof LightLayer).toBe(true);
    const match_names = layer.properties.map((p) => p.match_name);
    expect(
      py_eq(match_names, ["ADBE Marker", "ADBE Transform Group", "ADBE Light Options Group"]),
    ).toBe(true);
  });

  test("test_shape_layer", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("type.aep")), "type_shape");
    expect(layer instanceof ShapeLayer).toBe(true);
    const match_names = layer.properties.map((p) => p.match_name);
    expect(
      py_eq(match_names, [
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
    const layer = get_layer(parse_project(SAMPLES_DIR.div("type.aep")), "type_text");
    expect(layer instanceof TextLayer).toBe(true);
    const match_names = layer.properties.map((p) => p.match_name);
    expect(
      py_eq(match_names, [
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
    const layer = get_layer(parse_project(SAMPLES_DIR.div("avlayer_flags.aep")), "adjustmentLayer_true");
    expect(layer instanceof AVLayer).toBe(true);
    expect(py_bool(as_instance(layer, AVLayer).three_d_layer)).toBe(false);
    const match_names = layer.properties.map((p) => p.match_name);
    expect(
      py_eq(match_names, [
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
    const layer = get_layer(parse_project(SAMPLES_DIR.div("avlayer_flags.aep")), "threeDLayer_true");
    expect(layer instanceof AVLayer).toBe(true);
    expect(py_bool(as_instance(layer, AVLayer).three_d_layer)).toBe(true);
    const match_names = layer.properties.map((p) => p.match_name);
    expect(
      py_eq(match_names, [
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
    const layer = get_layer(parse_project(SAMPLES_DIR.div("avlayer_flags.aep")), "adjustmentLayer_true");
    const marker = layer.properties.find((p) => p.match_name === "ADBE Marker");
    if (marker == null) throw new StopIteration();
    expect(marker instanceof Property).toBe(true);
    expect(marker instanceof PropertyGroup).toBe(false);
  });

  /** Synthesized Marker has dimensions=0 and empty units_text. */
  test("test_marker_metadata", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("avlayer_flags.aep")), "adjustmentLayer_true");
    const marker = layer.properties.find((p) => p.match_name === "ADBE Marker");
    if (marker == null) throw new StopIteration();
    expect(marker instanceof Property).toBe(true);
    expect(as_instance(marker, Property).dimensions).toBe(0);
    expect(as_instance(marker, Property).units_text).toBe("");
  });

  /** Layer Sets group has elided=True. */
  test("test_layer_sets_elided", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("avlayer_flags.aep")), "adjustmentLayer_true");
    const layer_sets = layer.properties.find((p) => p.match_name === "ADBE Layer Sets");
    if (layer_sets == null) throw new StopIteration();
    expect(layer_sets instanceof PropertyGroup).toBe(true);
    expect(layer_sets.elided).toBe(true);
  });

  /** AE 2026 reports both as indexed groups, empty or not. */
  test("test_trackers_and_layer_sets_are_indexed_groups", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("avlayer_flags.aep")), "adjustmentLayer_true");
    for (const mn of ["ADBE MTrackers", "ADBE Layer Sets"]) {
      expect(layer.property(mn).property_type).toBe(PropertyType.INDEXED_GROUP);
    }
  });

  /** Every canonical top-level group has property_depth == 1. */
  test("test_all_canonical_groups_depth_one", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("avlayer_flags.aep")), "adjustmentLayer_true");
    for (const prop of layer.properties) {
      py_assert(prop.property_depth === 1, `${prop.match_name} has depth ${prop.property_depth}`);
    }
  });

  /** Canonical groups have expected display names. */
  test("test_canonical_names", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("avlayer_flags.aep")), "adjustmentLayer_true");
    const expected_names = new Map<string, string>([
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
      if (expected_names.has(prop.match_name)) {
        py_assert(
          prop.name === expected_names.get(prop.match_name),
          `${prop.match_name}: expected name ${repr(expected_names.get(prop.match_name))}, ` +
            `got ${repr(prop.name)}`,
        );
      }
    }
  });
});

/** Layer Styles collapsed enabled state and Blend Options mirroring. */
describe("TestLayerStylesEnabled", () => {
  /** Layer Styles group reports enabled=False when no style is on. */
  test("test_layer_styles_disabled_when_no_style_enabled", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("type.aep")), "type_shape");
    const layer_styles_child = layer.properties.find((p) => p.match_name === "ADBE Layer Styles");
    if (layer_styles_child == null) throw new StopIteration();
    const layer_styles = as_instance(layer_styles_child, PropertyGroup);
    expect(layer_styles instanceof PropertyGroup).toBe(true);
    expect(layer_styles._deferred_ae_major != null).toBe(true);
    expect(layer_styles.enabled).toBe(false);
    expect(layer_styles._deferred_ae_major != null).toBe(true);

    // Blend Options mirrors the parent
    const blend_options = layer_styles.properties.find((p) => p.match_name === "ADBE Blend Options Group");
    if (blend_options == null) throw new StopIteration();
    expect(layer_styles._deferred_ae_major == null).toBe(true);
    expect(blend_options instanceof PropertyGroup).toBe(true);
    expect(blend_options.enabled).toBe(false);

    // No individual style is enabled
    for (const child of layer_styles.properties) {
      if (child instanceof PropertyGroup && child.match_name !== "ADBE Blend Options Group") {
        py_assert(child.enabled === false, `${child.match_name} should be disabled`);
      }
    }
  });

  /**
   * With no styles applied, the group and every style report
   * canSetEnabled=False (matching ExtendScript).
   */
  test("test_can_set_enabled_no_styles", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("type.aep")), "type_shape");
    const layer_styles_child = layer.properties.find((p) => p.match_name === "ADBE Layer Styles");
    if (layer_styles_child == null) throw new StopIteration();
    const layer_styles = as_instance(layer_styles_child, PropertyGroup);
    expect(layer_styles instanceof PropertyGroup).toBe(true);
    expect(layer_styles.can_set_enabled).toBe(false);
    for (const child of layer_styles.properties) {
      expect(child.can_set_enabled).toBe(false);
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
    const layer = parse_aep(path).project.compositions[0].layers[0];
    const layer_styles = layer.property("ADBE Layer Styles");
    expect(layer_styles instanceof PropertyGroup).toBe(true);
    expect(layer_styles.can_set_enabled).toBe(true);
    for (const child of layer_styles.properties) {
      const mn = child.match_name;
      if (mn === "dropShadow/enabled") {
        expect(child.can_set_enabled).toBe(true);
      } else {
        // phantom styles + Blending Options
        py_assert(child.can_set_enabled === false, mn);
      }
    }
  });
});

/** Context-dependent naming on transform properties. */
describe("TestTransformNaming", () => {
  /** 2D layers show Rotate Z as 'Rotation'. */
  test("test_2d_rotate_z_named_rotation", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("avlayer_flags.aep")), "adjustmentLayer_true");
    const rotate_z = layer.transform.property("ADBE Rotate Z");
    expect(rotate_z.name).toBe("Rotation");
  });

  /** 3D layers show Rotate Z as 'Z Rotation'. */
  test("test_3d_rotate_z_named_z_rotation", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("avlayer_flags.aep")), "threeDLayer_true");
    const rotate_z = layer.transform.property("ADBE Rotate Z");
    expect(rotate_z.name).toBe("Z Rotation");
  });

  /** Camera layers show Rotate Z as 'Z Rotation'. */
  test("test_camera_rotate_z_named_z_rotation", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("type.aep")), "type_camera");
    const rotate_z = layer.transform.property("ADBE Rotate Z");
    expect(rotate_z.name).toBe("Z Rotation");
  });

  /** Camera layers show Anchor Point as 'Point of Interest'. */
  test("test_camera_anchor_named_point_of_interest", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("type.aep")), "type_camera");
    const anchor = layer.transform.property("ADBE Anchor Point");
    expect(anchor.name).toBe("Point of Interest");
  });

  /** Light layers show Anchor Point as 'Point of Interest'. */
  test("test_light_anchor_named_point_of_interest", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("lightType.aep")), "lightType_PARALLEL");
    const anchor = layer.transform.property("ADBE Anchor Point");
    expect(anchor.name).toBe("Point of Interest");
  });

  /** 2D layers show Anchor Point as 'Anchor Point'. */
  test("test_2d_anchor_named_anchor_point", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("avlayer_flags.aep")), "adjustmentLayer_true");
    const anchor = layer.transform.property("ADBE Anchor Point");
    expect(anchor.name).toBe("Anchor Point");
  });

  /** Non-canonical groups appear after canonical ones. */
  test("test_non_canonical_tail_preserved", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("type.aep")), "type_camera");
    const match_names = layer.properties.map((p) => p.match_name);
    // Camera Options is non-canonical, should be last
    expect(match_names[match_names.length - 1]).toBe("ADBE Camera Options Group");
    // Marker and Transform are canonical, should come before
    expect(_list_index(match_names, "ADBE Marker") < _list_index(match_names, "ADBE Camera Options Group")).toBe(true);
    expect(
      _list_index(match_names, "ADBE Transform Group") < _list_index(match_names, "ADBE Camera Options Group"),
    ).toBe(true);
  });
});
