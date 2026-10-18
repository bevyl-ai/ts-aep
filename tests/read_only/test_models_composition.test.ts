/** Tests for CompItem model parsing. */

// `from __future__ import annotations` is dropped: no annotation here is
// evaluated at runtime. `math.isclose` is the pyrt `isclose` (num.ts), and the
// keyword-only `rel_tol=` becomes its third positional argument.

import { describe, expect, test } from "bun:test";
import {
  AssertionError_,
  getattr,
  getitem,
  isclose,
  len,
  Path,
  py_assert,
  py_bool,
  py_eq,
  repr,
  round,
  StopIteration,
  zip,
} from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { get_comp, get_comp_from_json_by_name, load_expected, parse_project } from "../conftest.ts";
import { as_instance } from "../helpers.ts";
import { GuideOrientationType } from "../../src/py_aep/enums/index.ts";
import { AVLayer, CameraLayer, LightLayer, ShapeLayer, TextLayer } from "../../src/py_aep/models/layers/index.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";
import { FootageItem } from "../../src/py_aep/models/items/footage.ts";
import { FileSource } from "../../src/py_aep/models/sources/file.ts";
import { SolidSource } from "../../src/py_aep/models/sources/solid.ts";
import { _resolve_controller_source_layer, _walk_source_property, resolve_essential_property_controllers } from "../../src/py_aep/resolvers/essential_properties.ts";

// Python `Path(__file__).parent.parent.parent` is the repo root. A TS file's
// `import.meta.dir` is already its directory, so two `.parent` steps reach it.
const SAMPLES_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "composition");
const LAYER_SAMPLES_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "layer");
const FOOTAGE_SAMPLES_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "footage");
const EG_SAMPLES_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "essential_graphics");

// NOTE(port): local stand-in for next(gen) without default. `find` keeps the
// first-match laziness; a miss throws StopIteration as Python's next() does.
function next_<T>(found: T | undefined): T {
  if (found === undefined) throw new StopIteration();
  return found;
}

/** Tests for basic composition attributes. */
describe("TestCompItemBasic", () => {
  test("test_bgColor_red", () => {
    const expected = load_expected(SAMPLES_DIR, "bgColor");
    const comp_json = get_comp_from_json_by_name(expected, "bgColor_red");
    const comp = get_comp(parse_project(SAMPLES_DIR.div("bgColor.aep")), "bgColor_red");
    expect(isclose(comp.bg_color[0], comp_json["bgColor"][0])).toBe(true);
    expect(isclose(comp.bg_color[1], comp_json["bgColor"][1])).toBe(true);
    expect(isclose(comp.bg_color[2], comp_json["bgColor"][2])).toBe(true);
  });

  test("test_bgColor_custom", () => {
    const expected = load_expected(SAMPLES_DIR, "bgColor");
    const comp_json = get_comp_from_json_by_name(expected, "bgColor_custom");
    const comp = get_comp(parse_project(SAMPLES_DIR.div("bgColor.aep")), "bgColor_custom");
    expect(isclose(comp.bg_color[0], comp_json["bgColor"][0])).toBe(true);
    expect(isclose(comp.bg_color[1], comp_json["bgColor"][1])).toBe(true);
    expect(isclose(comp.bg_color[2], comp_json["bgColor"][2])).toBe(true);
  });
});

/** Tests for composition size attributes. */
describe("TestCompItemSize", () => {
  test("test_size_1920x1080", () => {
    const expected = load_expected(SAMPLES_DIR, "size");
    const comp_json = get_comp_from_json_by_name(expected, "size_1920x1080");
    const comp = get_comp(parse_project(SAMPLES_DIR.div("size.aep")), "size_1920x1080");
    expect(comp.width).toBe(comp_json["width"]);
    expect(comp_json["width"]).toBe(1920);
    expect(comp.height).toBe(comp_json["height"]);
    expect(comp_json["height"]).toBe(1080);
  });

  test("test_size_2048x872", () => {
    const expected = load_expected(SAMPLES_DIR, "size");
    const comp_json = get_comp_from_json_by_name(expected, "size_2048x872");
    const comp = get_comp(parse_project(SAMPLES_DIR.div("size.aep")), "size_2048x872");
    expect(comp.width).toBe(comp_json["width"]);
    expect(comp_json["width"]).toBe(2048);
    expect(comp.height).toBe(comp_json["height"]);
    expect(comp_json["height"]).toBe(872);
  });
});

/** Tests for composition frame rate. */
describe("TestCompItemFrameRate", () => {
  test("test_frameRate_23976", () => {
    const expected = load_expected(SAMPLES_DIR, "frameRate");
    const comp_json = get_comp_from_json_by_name(expected, "frameRate_23976");
    const comp = get_comp(parse_project(SAMPLES_DIR.div("frameRate.aep")), "frameRate_23976");
    expect(isclose(comp.frame_rate, comp_json["frameRate"], 0.001)).toBe(true);
  });

  test("test_frameRate_30", () => {
    const expected = load_expected(SAMPLES_DIR, "frameRate");
    const comp_json = get_comp_from_json_by_name(expected, "frameRate_30");
    const comp = get_comp(parse_project(SAMPLES_DIR.div("frameRate.aep")), "frameRate_30");
    expect(comp_json["frameRate"]).toBe(30);
    expect(isclose(comp.frame_rate, comp_json["frameRate"], 0.001)).toBe(true);
  });
});

/** Tests for composition duration. */
describe("TestCompItemDuration", () => {
  test("test_duration_60", () => {
    const expected = load_expected(SAMPLES_DIR, "comp_misc");
    const comp_json = get_comp_from_json_by_name(expected, "duration_60");
    const comp = get_comp(parse_project(SAMPLES_DIR.div("comp_misc.aep")), "duration_60");
    expect(comp_json["duration"]).toBe(60);
    expect(isclose(comp.duration, comp_json["duration"])).toBe(true);
  });
});

/** Tests for motion blur attributes. */
describe("TestCompItemMotionBlur", () => {
  test("test_motionBlur_true", () => {
    const expected = load_expected(SAMPLES_DIR, "comp_flags");
    const comp_json = get_comp_from_json_by_name(expected, "motionBlur_true");
    const comp = get_comp(parse_project(SAMPLES_DIR.div("comp_flags.aep")), "motionBlur_true");
    expect(comp_json["motionBlur"]).toBe(true);
    expect(comp.motion_blur).toBe(comp_json["motionBlur"]);
  });

  test("test_shutterAngle_180", () => {
    const expected = load_expected(SAMPLES_DIR, "shutterAngle");
    const comp_json = get_comp_from_json_by_name(expected, "shutterAngle_180");
    const comp = get_comp(parse_project(SAMPLES_DIR.div("shutterAngle.aep")), "shutterAngle_180");
    expect(comp.shutter_angle).toBe(comp_json["shutterAngle"]);
    expect(comp_json["shutterAngle"]).toBe(180);
  });

  test("test_shutterAngle_360", () => {
    const expected = load_expected(SAMPLES_DIR, "shutterAngle");
    const comp_json = get_comp_from_json_by_name(expected, "shutterAngle_360");
    const comp = get_comp(parse_project(SAMPLES_DIR.div("shutterAngle.aep")), "shutterAngle_360");
    expect(comp.shutter_angle).toBe(comp_json["shutterAngle"]);
    expect(comp_json["shutterAngle"]).toBe(360);
  });

  test("test_shutterPhase_minus90", () => {
    const expected = load_expected(SAMPLES_DIR, "comp_flags");
    const comp_json = get_comp_from_json_by_name(expected, "shutterPhase_minus90");
    const comp = get_comp(parse_project(SAMPLES_DIR.div("comp_flags.aep")), "shutterPhase_minus90");
    expect(comp.shutter_phase).toBe(comp_json["shutterPhase"]);
    expect(comp_json["shutterPhase"]).toBe(-90);
  });

  test("test_motionBlurSamplesPerFrame_32", () => {
    const expected = load_expected(SAMPLES_DIR, "comp_flags");
    const comp_json = get_comp_from_json_by_name(expected, "motionBlurSamplesPerFrame_32");
    const comp = get_comp(
      parse_project(SAMPLES_DIR.div("comp_flags.aep")),
      "motionBlurSamplesPerFrame_32",
    );
    expect(comp.motion_blur_samples_per_frame).toBe(comp_json["motionBlurSamplesPerFrame"]);
    expect(comp_json["motionBlurSamplesPerFrame"]).toBe(32);
  });

  test("test_motionBlurAdaptiveSampleLimit_256", () => {
    const expected = load_expected(SAMPLES_DIR, "comp_flags");
    const comp_json = get_comp_from_json_by_name(expected, "motionBlurAdaptiveSampleLimit_256");
    const comp = get_comp(
      parse_project(SAMPLES_DIR.div("comp_flags.aep")),
      "motionBlurAdaptiveSampleLimit_256",
    );
    expect(comp.motion_blur_adaptive_sample_limit).toBe(comp_json["motionBlurAdaptiveSampleLimit"]);
    expect(comp_json["motionBlurAdaptiveSampleLimit"]).toBe(256);
  });
});

/** Tests for resolution attributes. */
describe("TestCompItemResolution", () => {
  test("test_resolutionFactor_half", () => {
    const expected = load_expected(SAMPLES_DIR, "resolutionFactor");
    const comp_json = get_comp_from_json_by_name(expected, "resolutionFactor_half");
    const comp = get_comp(
      parse_project(SAMPLES_DIR.div("resolutionFactor.aep")),
      "resolutionFactor_half",
    );
    expect(py_eq(comp.resolution_factor, comp_json["resolutionFactor"])).toBe(true);
  });

  test("test_resolutionFactor_quarter", () => {
    const expected = load_expected(SAMPLES_DIR, "resolutionFactor");
    const comp_json = get_comp_from_json_by_name(expected, "resolutionFactor_quarter");
    const comp = get_comp(
      parse_project(SAMPLES_DIR.div("resolutionFactor.aep")),
      "resolutionFactor_quarter",
    );
    expect(py_eq(comp.resolution_factor, comp_json["resolutionFactor"])).toBe(true);
  });
});

/** Tests for nested composition options. */
describe("TestCompItemNestedOptions", () => {
  test("test_preserveNestedFrameRate_true", () => {
    const expected = load_expected(SAMPLES_DIR, "comp_flags");
    const comp_json = get_comp_from_json_by_name(expected, "preserveNestedFrameRate_true");
    const comp = get_comp(
      parse_project(SAMPLES_DIR.div("comp_flags.aep")),
      "preserveNestedFrameRate_true",
    );
    expect(comp_json["preserveNestedFrameRate"]).toBe(true);
    expect(comp.preserve_nested_frame_rate).toBe(comp_json["preserveNestedFrameRate"]);
  });

  test("test_preserveNestedResolution_true", () => {
    const expected = load_expected(SAMPLES_DIR, "comp_flags");
    const comp_json = get_comp_from_json_by_name(expected, "preserveNestedResolution_true");
    const comp = get_comp(
      parse_project(SAMPLES_DIR.div("comp_flags.aep")),
      "preserveNestedResolution_true",
    );
    expect(comp_json["preserveNestedResolution"]).toBe(true);
    expect(comp.preserve_nested_resolution).toBe(comp_json["preserveNestedResolution"]);
  });
});

/** Tests for frame blending attribute. */
describe("TestCompItemFrameBlending", () => {
  test("test_frameBlending_true", () => {
    const expected = load_expected(SAMPLES_DIR, "comp_flags");
    const comp_json = get_comp_from_json_by_name(expected, "frameBlending_true");
    const comp = get_comp(parse_project(SAMPLES_DIR.div("comp_flags.aep")), "frameBlending_true");
    expect(comp_json["frameBlending"]).toBe(true);
    expect(comp.frame_blending).toBe(comp_json["frameBlending"]);
  });
});

/** Tests for hide shy layers attribute. */
describe("TestCompItemShyLayers", () => {
  test("test_hideShyLayers_true", () => {
    const expected = load_expected(SAMPLES_DIR, "comp_flags");
    const comp_json = get_comp_from_json_by_name(expected, "hideShyLayers_true");
    const comp = get_comp(parse_project(SAMPLES_DIR.div("comp_flags.aep")), "hideShyLayers_true");
    expect(comp_json["hideShyLayers"]).toBe(true);
    expect(comp.hide_shy_layers).toBe(comp_json["hideShyLayers"]);
  });
});

/** Tests for time-related attributes (rel_tol=0.001 for precision). */
describe("TestCompItemTime", () => {
  test("test_time_0", () => {
    const expected = load_expected(SAMPLES_DIR, "time");
    const comp_json = get_comp_from_json_by_name(expected, "time_0");
    const comp = get_comp(parse_project(SAMPLES_DIR.div("time.aep")), "time_0");
    expect(comp_json["time"]).toBe(0);
    expect(isclose(comp.time, comp_json["time"])).toBe(true);
  });

  test("test_time_5", () => {
    const expected = load_expected(SAMPLES_DIR, "time");
    const comp_json = get_comp_from_json_by_name(expected, "time_5");
    const comp = get_comp(parse_project(SAMPLES_DIR.div("time.aep")), "time_5");
    expect(isclose(comp.time, comp_json["time"], 0.001)).toBe(true);
  });

  test("test_time_15", () => {
    const expected = load_expected(SAMPLES_DIR, "time");
    const comp_json = get_comp_from_json_by_name(expected, "time_15");
    const comp = get_comp(parse_project(SAMPLES_DIR.div("time.aep")), "time_15");
    expect(isclose(comp.time, comp_json["time"], 0.001)).toBe(true);
  });
});

/** Tests for work area attributes (rel_tol=0.001 for precision). */
describe("TestCompItemWorkArea", () => {
  test("test_workAreaStart_5", () => {
    const expected = load_expected(SAMPLES_DIR, "workArea");
    const comp_json = get_comp_from_json_by_name(expected, "workAreaStart_5");
    const comp = get_comp(parse_project(SAMPLES_DIR.div("workArea.aep")), "workAreaStart_5");
    expect(isclose(comp.work_area_start, comp_json["workAreaStart"], 0.001)).toBe(true);
  });

  test("test_workAreaDuration_10", () => {
    const expected = load_expected(SAMPLES_DIR, "workArea");
    const comp_json = get_comp_from_json_by_name(expected, "workAreaDuration_10");
    const comp = get_comp(parse_project(SAMPLES_DIR.div("workArea.aep")), "workAreaDuration_10");
    expect(isclose(comp.work_area_duration, comp_json["workAreaDuration"], 0.001)).toBe(true);
  });
});

/** Tests for display start attributes. */
describe("TestCompItemDisplayStart", () => {
  test("test_displayStartFrame_100", () => {
    const expected = load_expected(SAMPLES_DIR, "displayStart");
    const comp_json = get_comp_from_json_by_name(expected, "displayStartFrame_100");
    const comp = get_comp(parse_project(SAMPLES_DIR.div("displayStart.aep")), "displayStartFrame_100");
    expect(comp.display_start_frame).toBe(comp_json["displayStartFrame"]);
    expect(comp_json["displayStartFrame"]).toBe(100);
  });

  test("test_displayStartTime_10", () => {
    const expected = load_expected(SAMPLES_DIR, "displayStart");
    const comp_json = get_comp_from_json_by_name(expected, "displayStartTime_10");
    const comp = get_comp(parse_project(SAMPLES_DIR.div("displayStart.aep")), "displayStartTime_10");
    expect(comp_json["displayStartTime"]).toBe(10);
    expect(isclose(comp.display_start_time, comp_json["displayStartTime"])).toBe(true);
  });
});

/** Tests for pixel aspect ratio. */
describe("TestCompItemPixelAspect", () => {
  test("test_pixelAspect_0_75", () => {
    const expected = load_expected(SAMPLES_DIR, "pixelAspect");
    const comp_json = get_comp_from_json_by_name(expected, "pixelAspect_0.75");
    const comp = get_comp(parse_project(SAMPLES_DIR.div("pixelAspect.aep")), "pixelAspect_0.75");
    expect(isclose(comp.pixel_aspect, comp_json["pixelAspect"])).toBe(true);
  });

  test("test_pixelAspect_2_0", () => {
    const expected = load_expected(SAMPLES_DIR, "pixelAspect");
    const comp_json = get_comp_from_json_by_name(expected, "pixelAspect_2");
    const comp = get_comp(parse_project(SAMPLES_DIR.div("pixelAspect.aep")), "pixelAspect_2");
    expect(isclose(comp.pixel_aspect, comp_json["pixelAspect"])).toBe(true);
  });
});

/** Tests for composition name. */
describe("TestCompItemName", () => {
  test("test_name_renamed", () => {
    const expected = load_expected(SAMPLES_DIR, "comp_misc");
    const comp_json = get_comp_from_json_by_name(expected, "RenamedComp");
    const comp = get_comp(parse_project(SAMPLES_DIR.div("comp_misc.aep")), "RenamedComp");
    expect(comp.name).toBe(comp_json["name"]);
    expect(comp_json["name"]).toBe("RenamedComp");
  });
});

/** Tests for composition comment. */
describe("TestCompItemComment", () => {
  test("test_comment", () => {
    const expected = load_expected(SAMPLES_DIR, "comp_misc");
    const comp_json = get_comp_from_json_by_name(expected, "comment");
    const comp = get_comp(parse_project(SAMPLES_DIR.div("comp_misc.aep")), "comment");
    expect(comp.comment).toBe(comp_json["comment"]);
    expect(comp_json["comment"]).toBe("Test comment");
  });
});

/** Tests for composition label. */
describe("TestCompItemLabel", () => {
  test("test_label_5", () => {
    const expected = load_expected(SAMPLES_DIR, "comp_misc");
    const comp_json = get_comp_from_json_by_name(expected, "label_5");
    const comp = get_comp(parse_project(SAMPLES_DIR.div("comp_misc.aep")), "label_5");
    expect(comp_json["label"]).toBe(5);
    // IntEnum members are plain numbers (RULEBOOK §6): `.value` is the member itself.
    expect(comp.label).toBe(comp_json["label"]);
  });
});

/** Tests for composition drop frame. */
describe("TestCompItemDropFrame", () => {
  test("test_dropFrame_true", () => {
    const expected = load_expected(SAMPLES_DIR, "dropFrame");
    const comp_json = get_comp_from_json_by_name(expected, "dropFrame_true");
    const comp = get_comp(parse_project(SAMPLES_DIR.div("dropFrame.aep")), "dropFrame_true");
    expect(comp_json["dropFrame"]).toBe(true);
    expect(comp.drop_frame).toBe(comp_json["dropFrame"]);
  });

  test("test_dropFrame_false", () => {
    const expected = load_expected(SAMPLES_DIR, "dropFrame");
    const comp_json = get_comp_from_json_by_name(expected, "dropFrame_false");
    const comp = get_comp(parse_project(SAMPLES_DIR.div("dropFrame.aep")), "dropFrame_false");
    expect(comp_json["dropFrame"]).toBe(false);
    expect(comp.drop_frame).toBe(comp_json["dropFrame"]);
  });
});

/** Tests for composition renderer attribute. */
describe("TestCompItemRenderer", () => {
  test("test_renderers", () => {
    const comp = parse_project(SAMPLES_DIR.div("renderer_classic_3d.aep")).compositions[0];
    expect(
      py_eq(comp.renderers, ["ADBE Advanced 3d", "ADBE Calder", "ADBE Ernst", "ADBE Picasso"]),
    ).toBe(true);
  });

  test("test_renderer_classic_3d", () => {
    const comp = parse_project(SAMPLES_DIR.div("renderer_classic_3d.aep")).compositions[0];
    expect(comp.renderer).toBe("ADBE Advanced 3d");
  });

  test("test_renderer_advanced_3d", () => {
    const comp = parse_project(SAMPLES_DIR.div("renderer_advanced_3d.aep")).compositions[0];
    expect(comp.renderer).toBe("ADBE Calder");
  });

  test("test_renderer_cinema_4d", () => {
    const comp = parse_project(SAMPLES_DIR.div("renderer_cinema_4d.aep")).compositions[0];
    expect(comp.renderer).toBe("ADBE Ernst");
  });

  test("test_renderer_ray_traced", () => {
    const comp = parse_project(SAMPLES_DIR.div("renderer_ray_traced.aep")).compositions[0];
    expect(comp.renderer).toBe("ADBE Picasso");
  });
});

/** Tests for CompItem layer-type filtering properties. */
describe("TestCompItemLayerFiltering", () => {
  test("test_text_layers", () => {
    const comp = get_comp(parse_project(LAYER_SAMPLES_DIR.div("type.aep")), "type_text");
    expect(len(comp.text_layers)).toBe(1);
    expect(comp.text_layers.every((layer) => layer instanceof TextLayer)).toBe(true);
  });

  test("test_shape_layers", () => {
    const comp = get_comp(parse_project(LAYER_SAMPLES_DIR.div("type.aep")), "type_shape");
    expect(len(comp.shape_layers)).toBe(1);
    expect(comp.shape_layers.every((layer) => layer instanceof ShapeLayer)).toBe(true);
  });

  test("test_camera_layers", () => {
    const comp = get_comp(parse_project(LAYER_SAMPLES_DIR.div("type.aep")), "type_camera");
    expect(len(comp.camera_layers)).toBe(1);
    expect(comp.camera_layers.every((layer) => layer instanceof CameraLayer)).toBe(true);
  });

  test("test_light_layers", () => {
    const comp = get_comp(
      parse_project(LAYER_SAMPLES_DIR.div("lightType.aep")),
      "lightType_POINT",
    );
    expect(len(comp.light_layers)).toBe(1);
    expect(comp.light_layers.every((layer) => layer instanceof LightLayer)).toBe(true);
  });

  test("test_null_layers", () => {
    const comp = get_comp(parse_project(LAYER_SAMPLES_DIR.div("type.aep")), "type_null");
    expect(len(comp.null_layers)).toBe(1);
    expect(comp.null_layers.every((layer) => layer.null_layer)).toBe(true);
  });

  test("test_adjustment_layers", () => {
    const comp = get_comp(
      parse_project(LAYER_SAMPLES_DIR.div("avlayer_flags.aep")),
      "adjustmentLayer_true",
    );
    expect(len(comp.adjustment_layers)).toBe(1);
    expect(
      comp.adjustment_layers.every((layer) => layer instanceof AVLayer && layer.adjustment_layer),
    ).toBe(true);
  });

  test("test_three_d_layers", () => {
    const comp = get_comp(
      parse_project(LAYER_SAMPLES_DIR.div("avlayer_flags.aep")),
      "threeDLayer_true",
    );
    expect(len(comp.three_d_layers)).toBe(1);
    expect(
      comp.three_d_layers.every((layer) => layer instanceof AVLayer && layer.three_d_layer),
    ).toBe(true);
  });

  test("test_guide_layers", () => {
    const comp = get_comp(
      parse_project(LAYER_SAMPLES_DIR.div("avlayer_flags.aep")),
      "guideLayer_true",
    );
    expect(len(comp.guide_layers)).toBe(1);
    expect(
      comp.guide_layers.every((layer) => layer instanceof AVLayer && layer.guide_layer),
    ).toBe(true);
  });

  test("test_solo_layers", () => {
    const comp = get_comp(
      parse_project(LAYER_SAMPLES_DIR.div("layer_switches.aep")),
      "solo_true",
    );
    expect(len(comp.solo_layers)).toBe(1);
    expect(comp.solo_layers.every((layer) => layer.solo)).toBe(true);
  });

  /** A comp with only a shape layer has no text layers. */
  test("test_empty_text_layers", () => {
    const comp = get_comp(parse_project(LAYER_SAMPLES_DIR.div("type.aep")), "type_shape");
    expect(py_eq(comp.text_layers, [])).toBe(true);
  });

  /** A comp with only a text layer has no camera layers. */
  test("test_empty_camera_layers", () => {
    const comp = get_comp(parse_project(LAYER_SAMPLES_DIR.div("type.aep")), "type_text");
    expect(py_eq(comp.camera_layers, [])).toBe(true);
  });

  /** A comp with only a text layer has no light layers. */
  test("test_empty_light_layers", () => {
    const comp = get_comp(parse_project(LAYER_SAMPLES_DIR.div("type.aep")), "type_text");
    expect(py_eq(comp.light_layers, [])).toBe(true);
  });

  test("test_file_layers", () => {
    const comp = parse_project(FOOTAGE_SAMPLES_DIR.div("footage_not_missing.aep")).compositions[0];
    expect(len(comp.file_layers)).toBe(1);
    for (const layer of comp.file_layers) {
      expect(layer instanceof AVLayer).toBe(true);
      expect(as_instance(layer.source, FootageItem).main_source instanceof FileSource).toBe(true);
    }
  });

  test("test_solid_layers", () => {
    const comp = parse_project(LAYER_SAMPLES_DIR.div("gray_solid_1_above.aep")).compositions[0];
    expect(len(comp.solid_layers)).toBe(2);
    for (const layer of comp.solid_layers) {
      expect(layer instanceof AVLayer).toBe(true);
      expect(as_instance(layer.source, FootageItem).main_source instanceof SolidSource).toBe(true);
    }
  });

  /** A comp with only solid layers has no placeholder layers. */
  test("test_placeholder_layers_empty", () => {
    const comp = parse_project(LAYER_SAMPLES_DIR.div("gray_solid_1_above.aep")).compositions[0];
    expect(py_eq(comp.placeholder_layers, [])).toBe(true);
  });

  /** A comp with only solid layers has no file layers. */
  test("test_empty_file_layers", () => {
    const comp = parse_project(LAYER_SAMPLES_DIR.div("gray_solid_1_above.aep")).compositions[0];
    expect(py_eq(comp.file_layers, [])).toBe(true);
  });
});

/** Tests for CompItem.guides. */
describe("TestCompItemGuides", () => {
  test("test_no_guides", () => {
    const comp = get_comp(parse_project(SAMPLES_DIR.div("guides.aep")), "guides_none");
    expect(py_eq(comp.guides, [])).toBe(true);
  });

  test("test_horizontal_guide", () => {
    const expected = load_expected(SAMPLES_DIR, "guides");
    const comp_json = get_comp_from_json_by_name(expected, "guides_horizontal");
    const comp = get_comp(parse_project(SAMPLES_DIR.div("guides.aep")), "guides_horizontal");
    expect(len(comp.guides)).toBe(1);
    const guide = comp.guides[0];
    const guides_json = comp_json["guides"];
    py_assert(Array.isArray(guides_json), "export has no guides list");
    const exp = guides_json[0];
    expect(guide.orientation_type).toBe(exp["orientationType"]);
    expect(guide.position).toBe(exp["position"]);
    expect(guide.position_type).toBe(exp["positionType"]);
  });

  test("test_both_guides", () => {
    const expected = load_expected(SAMPLES_DIR, "guides");
    const comp_json = get_comp_from_json_by_name(expected, "guides_both");
    const comp = get_comp(parse_project(SAMPLES_DIR.div("guides.aep")), "guides_both");
    const guides_json = comp_json["guides"];
    py_assert(Array.isArray(guides_json), "export has no guides list");
    expect(len(comp.guides)).toBe(len(guides_json));
    for (const [guide, exp] of zip(comp.guides, guides_json)) {
      expect(guide.orientation_type).toBe(exp["orientationType"]);
      expect(guide.position).toBe(exp["position"]);
      expect(guide.position_type).toBe(exp["positionType"]);
    }
  });

  test("test_guide_repr", () => {
    const comp = get_comp(parse_project(SAMPLES_DIR.div("guides.aep")), "guides_horizontal");
    expect(repr(comp.guides[0]).includes("horizontal")).toBe(true);
  });

  test("test_guide_orientation_horizontal", () => {
    const comp = get_comp(parse_project(SAMPLES_DIR.div("guides.aep")), "guides_horizontal");
    expect(comp.guides[0].orientation_type).toBe(GuideOrientationType.HORIZONTAL);
  });

  test("test_guide_orientation_vertical", () => {
    const comp = get_comp(parse_project(SAMPLES_DIR.div("guides.aep")), "guides_both");
    const vertical_guides = comp.guides.filter(
      (g) => g.orientation_type === GuideOrientationType.VERTICAL,
    );
    expect(len(vertical_guides)).toBe(1);
    expect(vertical_guides[0].position).toBe(960.0);
  });
});

/** Tests for Essential Graphics panel parsing. */
describe("TestEssentialGraphics", () => {
  test("test_fill_color_added", () => {
    const project = parse_project(EG_SAMPLES_DIR.div("fill_color_added.aep"));
    const comp = next_(project.compositions.find((c) => c.name === "primary"));
    expect(comp.motion_graphics_template_name).toBe("Untitled");
    expect(comp.motion_graphics_template_controller_count).toBe(1);
    expect(comp.motion_graphics_controllers[0].name).toBe("Fill Color");
    expect(py_eq(comp.motion_graphics_template_controller_names, ["Fill Color"])).toBe(true);
  });

  test("test_custom_template_name", () => {
    const project = parse_project(EG_SAMPLES_DIR.div("custom_template_name.aep"));
    const comp = next_(project.compositions.find((c) => c.name === "primary"));
    expect(comp.motion_graphics_template_name).toBe("My Custom Template");
  });

  test("test_multiple_controllers", () => {
    const project = parse_project(EG_SAMPLES_DIR.div("multiple_controllers.aep"));
    const comp = next_(project.compositions.find((c) => c.name === "primary"));
    expect(comp.motion_graphics_template_controller_count).toBe(3);
    expect(
      py_eq(comp.motion_graphics_template_controller_names, [
        "Brightness",
        "Layer Opacity",
        "Background Color",
      ]),
    ).toBe(true);
  });

  test("test_controller_renamed", () => {
    const project = parse_project(EG_SAMPLES_DIR.div("controller_renamed.aep"));
    const comp = next_(project.compositions.find((c) => c.name === "primary"));
    expect(comp.motion_graphics_controllers[0].name).toBe("Renamed Color");
  });

  test("test_no_essential_properties", () => {
    const project = parse_project(EG_SAMPLES_DIR.div("no_essential_properties.aep"));
    for (const comp of project.compositions) {
      expect(comp.motion_graphics_template_controller_count).toBe(0);
      expect(py_eq(comp.motion_graphics_template_controller_names, [])).toBe(true);
    }
  });

  test("test_main_comp_has_no_controllers", () => {
    const project = parse_project(EG_SAMPLES_DIR.div("fill_color_added.aep"));
    const comp = next_(project.compositions.find((c) => c.name === "main"));
    expect(comp.motion_graphics_template_controller_count).toBe(0);
  });

  /** Verify controller_type for each controller type sample. */
  test("test_controller_types", () => {
    const type_samples = new Map<string, number>([
      ["checkbox_controller", 1],
      ["slider_controller", 2],
      ["color_controller", 4],
      ["point_controller", 5],
      ["text_source_text", 6],
      ["dropdown_controller", 13],
    ]);
    for (const [sample, expected_type] of type_samples) {
      const project = parse_project(EG_SAMPLES_DIR.div(`${sample}.aep`));
      const comp = next_(project.compositions.find((c) => c.name === "primary"));
      const ctrls = comp.motion_graphics_controllers;
      py_assert(py_bool(ctrls), `${sample}: no controllers`);
      const ctrl = ctrls[0];
      py_assert(
        ctrl.controller_type === expected_type,
        `${sample}: expected type ${expected_type}, got ${ctrl.controller_type}`,
      );
    }
  });

  test("test_essential_property_uuids_resolve_to_controllers", () => {
    // Regression: a precomp layer's OvG2 overrides live under the layer's
    // root tdgp, not the Layr's direct children. _parse_ovg2_uuids used to
    // search the wrong level, so essential_property_uuids returned [] for
    // every populated sample. The override UUIDs are the source comp's
    // controller UUIDs verbatim.
    const project = parse_project(EG_SAMPLES_DIR.div("multiple_controllers.aep"));
    const source = next_(project.compositions.find((c) => c.name === "primary"));
    // NOTE(port): MotionGraphicsController.uuid is a str in Python and a string here, so Set identity matches.
    const controller_uuids = new Set(source.motion_graphics_controllers.map((c) => c.uuid));
    expect(len(controller_uuids)).toBe(3);

    const main = next_(project.compositions.find((c) => c.name === "main"));
    const with_overrides = main.layers.filter((layer) => py_bool(layer.essential_property_uuids));
    expect(len(with_overrides)).toBe(1);
    const overrides = with_overrides[0].essential_property_uuids;
    expect(len(overrides)).toBe(3);
    expect([...new Set(overrides)].every((u) => controller_uuids.has(u))).toBe(true);
  });

  test("test_essential_property_uuids_empty_without_overrides", () => {
    const project = parse_project(EG_SAMPLES_DIR.div("no_essential_properties.aep"));
    for (const comp of project.compositions) {
      for (const layer of comp.layers) {
        expect(py_eq(layer.essential_property_uuids, [])).toBe(true);
      }
    }
  });

  test("test_essential_property_controllers_resolve", () => {
    // The precomp layer's overrides resolve to the source comp's
    // controllers by shared UUID, in override order.
    const project = parse_project(EG_SAMPLES_DIR.div("multiple_controllers.aep"));
    const main = next_(project.compositions.find((c) => c.name === "main"));
    const layer = next_(main.layers.find((la) => py_bool(la.essential_property_uuids)));
    const controllers = as_instance(layer, AVLayer).essential_property_controllers;
    expect(py_eq(controllers.map((c) => c.name), ["Brightness", "Layer Opacity", "Background Color"])).toBe(true);
    // Each resolved controller's uuid is the override uuid at that position.
    expect(py_eq(controllers.map((c) => c.uuid), layer.essential_property_uuids)).toBe(true);
  });

  test("test_essential_property_controllers_single_override", () => {
    const project = parse_project(EG_SAMPLES_DIR.div("text_source_text.aep"));
    const layer = next_(
      project.compositions
        .flatMap((comp) => comp.layers)
        .find((la) => py_bool(la.essential_property_uuids)),
    );
    const controllers = as_instance(layer, AVLayer).essential_property_controllers;
    expect(len(controllers)).toBe(1);
    expect(controllers[0].name).toBe("Title Text");
  });

  test("test_essential_property_controllers_empty_for_non_precomp", () => {
    // A layer with no overrides (a solid, non-CompItem source) resolves [].
    const project = parse_project(EG_SAMPLES_DIR.div("multiple_controllers.aep"));
    const primary = next_(project.compositions.find((c) => c.name === "primary"));
    const solid = next_(primary.layers.find((layer) => layer.name === "Gray Solid 1"));
    expect(py_eq(as_instance(solid, AVLayer).essential_property_controllers, [])).toBe(true);
  });

  test("test_controller_source_property_path", () => {
    // Each controller records the root-to-leaf path of the source-comp
    // property it exposes (match name + index; None index = match by name).
    const project = parse_project(EG_SAMPLES_DIR.div("multiple_controllers.aep"));
    const comp = next_(project.compositions.find((c) => c.name === "primary"));
    const by_name = new Map(comp.motion_graphics_controllers.map((c) => [c.name, c] as const));

    const bg = getitem(by_name, "Background Color").source_property_path;
    expect(py_eq(bg.map((n) => n.match_name), ["ADBE Effect Parade", "ADBE Fill", "ADBE Fill-0002"])).toBe(true);
    expect(py_eq(bg.map((n) => n.prop_index), [null, 0, 3])).toBe(true);

    // A transform property (not an effect): every node matches by name.
    const opacity = getitem(by_name, "Layer Opacity").source_property_path;
    expect(py_eq(opacity.map((n) => n.match_name), ["ADBE Transform Group", "ADBE Opacity"])).toBe(true);
    expect(opacity.every((n) => n.prop_index == null)).toBe(true);
  });

  test("test_group_controller", () => {
    // A type-10 Group controller and its members parse as a flat controller
    // list - group members are SIBLING CCtl, not nested, so the stored ones
    // are not lost. The group itself controls no single source property.
    // (ExtendScript reports a 4th "GropDropZone" drop-zone controller that
    // AE synthesizes at runtime and does not store, so it is absent here.)
    const project = parse_project(EG_SAMPLES_DIR.div("group_controller.aep"));
    const comp = next_(project.compositions.find((c) => c.name === "Comp 1"));
    expect(
      py_eq(
        comp.motion_graphics_controllers.map((c) => [c.name, c.controller_type]),
        [
          ["Group", 10],
          ["Gaussian Blur Blurriness", 2],
          ["Fill Color", 4],
        ],
      ),
    ).toBe(true);
    expect(py_eq(comp.motion_graphics_controllers[0].source_property_path, [])).toBe(true);
    // Pin the deliberate one-lower-than-ExtendScript count (ES reports 4
    // including the unstored runtime "GropDropZone"); guards against drift.
    expect(comp.motion_graphics_template_controller_count).toBe(3);
    expect(comp.motion_graphics_template_controller_names.includes("GropDropZone")).toBe(false);

    // The precomp layer's overrides resolve to all three (incl. the group).
    const main = next_(project.compositions.find((c) => c.name === "main"));
    const layer = next_(main.layers.find((la) => py_bool(la.essential_property_uuids)));
    expect(
      py_eq(as_instance(layer, AVLayer).essential_property_controllers.map((c) => c.name), ["Group", "Gaussian Blur Blurriness", "Fill Color"]),
    ).toBe(true);
  });

  test("test_media_replacement_controller", () => {
    // A type-14 Media Replacement controller parses, and (unlike a Group)
    // AE synthesizes no extra drop-zone controller, so the count matches
    // ExtendScript exactly.
    const project = parse_project(EG_SAMPLES_DIR.div("media_replacement.aep"));
    const comp = next_(project.compositions.find((c) => c.name === "image_with_alpha"));
    const ctrls = comp.motion_graphics_controllers;
    expect(comp.motion_graphics_template_controller_count).toBe(1);
    expect(len(ctrls)).toBe(1);
    expect(ctrls[0].controller_type).toBe(14);
    expect(ctrls[0].name).toBe("image_with_alpha.png");
    // The controller records the source comp + layer it controls.
    expect(ctrls[0].source_comp_id).toBe(2);
    expect(ctrls[0].source_layer_id).toBe(14);
  });

  test("test_media_replacement_override_attributes", () => {
    // The precomp layer's Essential Properties override now exposes its
    // ADBE Layer Source Alternate child, and the media-replacement
    // attributes decode from the blsi slot (AE wraps the replacement
    // footage in a composition, so alternate_source is that comp).
    const project = parse_project(EG_SAMPLES_DIR.div("media_replacement.aep"));
    const host = next_(project.compositions.find((c) => c.name === "image_with_alpha 2"));
    const layer = next_(host.layers.find((la) => py_bool(la.essential_property_uuids)));

    const overrides = as_instance(next_(layer.properties.find((p) => p.match_name === "ADBE Layer Overrides")), PropertyGroup);
    expect(overrides.num_properties).toBe(1);
    const alt = as_instance(overrides.properties[0], Property);
    expect(alt.match_name).toBe("ADBE Layer Source Alternate");
    expect(alt.name).toBe("image_with_alpha.png");
    expect(alt.can_set_alternate_source).toBe(true);
    expect(alt.is_modified).toBe(true);
    expect(alt.alternate_source != null).toBe(true);
    py_assert(alt.alternate_source != null);
    expect(alt.alternate_source.name).toBe("image_with_alpha.png_sequence");
    // essential_property_source resolves the override to its source layer
    // in the master comp (matched via the controller's CCId/CLId).
    const src = alt.essential_property_source;
    expect(src != null).toBe(true);
    py_assert(src instanceof AVLayer);
    expect(src.name).toBe("image_with_alpha.png");
    expect(src.containing_comp.name).toBe("image_with_alpha");

    // The Source Options copy is an unset slot (blsi == 0).
    const src_group = as_instance(next_(layer.properties.find((p) => p.match_name === "ADBE Source Options Group")), PropertyGroup);
    const src_alt = as_instance(
      next_(src_group.properties.find((c) => c.match_name === "ADBE Layer Source Alternate")),
      Property,
    );
    expect(src_alt.can_set_alternate_source).toBe(false);
    expect(src_alt.alternate_source == null).toBe(true);
  });

  test("test_property_source_essential_property_walk", () => {
    // A Property-source controller (created from a Property, not Media
    // Replacement Footage) resolves to its source Property by walking the
    // controller's source-property path BY MATCH NAME - prop_index is
    // AE-internal and ignored, so the hidden `-0001`/`-0002` effect leaves
    // resolve correctly. This drives the resolver helpers directly via the
    // controllers (the public `essential_property_source` path is exercised
    // by test_essential_property_override_metadata).
    const project = parse_project(EG_SAMPLES_DIR.div("group_controller.aep"));
    const layer = next_(
      project.compositions
        .flatMap((comp) => comp.layers)
        .find((la) => la instanceof AVLayer && py_bool(resolve_essential_property_controllers(la))),
    );
    const ctrls = resolve_essential_property_controllers(as_instance(layer, AVLayer));
    const by_name = new Map(ctrls.map((c) => [c.name, c] as const));

    const blur = getitem(by_name, "Gaussian Blur Blurriness");
    const src_layer = _resolve_controller_source_layer(project, blur);
    expect(src_layer != null).toBe(true);
    if (src_layer == null) throw new AssertionError_("blur controller has no source layer");
    const leaf_node = _walk_source_property(src_layer, blur.source_property_path);
    expect(leaf_node != null).toBe(true);
    const leaf = as_instance(leaf_node, Property);
    expect(leaf.match_name).toBe("ADBE Gaussian Blur 2-0001");
    expect(leaf.enabled).toBe(true);
    expect(leaf.min_value).toBe(0);
    expect(leaf.max_value).toBe(30000);
    expect(leaf.value).toBe(25.0);

    // The override leaf carries its OWN value; the source Property here is
    // the effect's source value ([1,0,0,1]), distinct from any override.
    const fill = getitem(by_name, "Fill Color");
    const fill_src_layer = _resolve_controller_source_layer(project, fill);
    if (fill_src_layer == null) throw new AssertionError_("fill controller has no source layer");
    const fill_leaf_node = _walk_source_property(fill_src_layer, fill.source_property_path);
    expect(fill_leaf_node != null).toBe(true);
    const fill_leaf = as_instance(fill_leaf_node, Property);
    expect(fill_leaf.match_name).toBe("ADBE Fill-0002");
    expect(py_eq(Array.from(fill_leaf.value), [1.0, 0.0, 0.0, 1.0])).toBe(true);

    // A Group controller (type 10) stores no source-property path -> no leaf.
    const group = getitem(by_name, "Group");
    expect(py_eq(group.source_property_path, [])).toBe(true);
  });

  test("test_essential_property_override_metadata", () => {
    // Non-media-replacement override groups are exposed; each leaf's derived
    // metadata (enabled, bounds, is_modified, name) reflects its Essential
    // Graphics SOURCE property, while its value is its own override cdat.
    const project = parse_project(EG_SAMPLES_DIR.div("group_controller.aep"));
    const layer = next_(
      project.compositions
        .flatMap((comp) => comp.layers)
        .find(
          (la) =>
            la.properties.some((p) => p.match_name === "ADBE Layer Overrides") &&
            as_instance(next_(la.properties.find((p) => p.match_name === "ADBE Layer Overrides")), PropertyGroup).num_properties > 0,
        ),
    );
    const overrides = as_instance(next_(layer.properties.find((p) => p.match_name === "ADBE Layer Overrides")), PropertyGroup);
    expect(overrides.num_properties).toBe(1);
    expect(overrides.is_modified).toBe(true); // non-empty override group

    const grp = as_instance(overrides.properties[0], PropertyGroup);
    expect(grp.match_name).toBe("ADBE Layer Overrides Group");
    expect(grp.num_properties).toBe(2);
    expect(grp.is_modified).toBe(true);

    const [blur, fill] = grp.properties.map((leaf) => as_instance(leaf, Property));
    // Source-derived bounds/enabled (leaf's own tduM is 50, source is 30000).
    expect(blur.name).toBe("Gaussian Blur Blurriness");
    expect(blur.enabled).toBe(true);
    expect(blur.has_min && blur.has_max).toBe(true);
    expect(py_eq([blur.min_value, blur.max_value], [0, 30000])).toBe(true);
    expect(blur.value).toBe(25.0); // own override value
    expect(blur.is_modified).toBe(false); // equals source value

    // Fill leaf has no tdum/tduM; bounds come from the source Fill Color.
    expect(fill.name).toBe("Fill Color");
    expect(fill.has_min && fill.has_max).toBe(true);
    py_assert(typeof fill.max_value === "number");
    expect(round(fill.max_value, 2)).toBe(3921568.63);
    expect(fill.is_modified).toBe(true); // override differs from source [1,0,0,1]
    expect(py_eq(fill.value.map((c: number) => round(c, 4)), [0.2475, 0.7255, 0.6299, 1.0])).toBe(true);

    // Public essential_property_source resolves the override to its source
    // Property (a different object than the override leaf).
    const src = blur.essential_property_source;
    expect(src != null && src !== blur).toBe(true);
    py_assert(src != null);
    expect(src.match_name).toBe("ADBE Gaussian Blur 2-0001");
  });

  test("test_point_override_value_in_source_pixels", () => {
    // A point-control override leaf borrows its source parameter's pixel
    // denormalization scale, so its value is in source-comp pixels (matching
    // ExtendScript), not the raw 0-1 the leaf stores. is_modified then
    // compares like for like. Source comp is 1000x1000, so 0.5 -> 500.
    const project = parse_project(EG_SAMPLES_DIR.div("point_controller.aep"));
    const layer = next_(
      project.compositions
        .flatMap((comp) => comp.layers)
        .find((la) =>
          la.properties.some((p) => p.match_name === "ADBE Layer Overrides" && as_instance(p, PropertyGroup).num_properties > 0),
        ),
    );
    const overrides = as_instance(next_(layer.properties.find((p) => p.match_name === "ADBE Layer Overrides")), PropertyGroup);
    const leaf = as_instance(overrides.properties[0], Property);
    expect(leaf.match_name).toBe("ADBE Point Control-0001");
    expect(py_eq(leaf.value, [500.0, 500.0])).toBe(true); // pixels, not the stored [0.5, 0.5]
    expect(leaf.is_modified).toBe(false); // equals source, once in the same units
    expect(leaf.units_text).toBe("pixels");
    const src = leaf.essential_property_source;
    expect(src != null && py_eq(getattr(src, "value"), [500.0, 500.0])).toBe(true);
  });

  test("test_essential_property_override_name_from_controller", () => {
    // When an override leaf's own tdsn is empty, its display name comes from
    // the Essential Graphics controller, not the match-name fallback.
    const project = parse_project(EG_SAMPLES_DIR.div("multiple_controllers.aep"));
    const layer = next_(
      project.compositions
        .flatMap((comp) => comp.layers)
        .find((la) =>
          la.properties.some((p) => p.match_name === "ADBE Layer Overrides" && as_instance(p, PropertyGroup).num_properties > 0),
        ),
    );
    const overrides = as_instance(next_(layer.properties.find((p) => p.match_name === "ADBE Layer Overrides")), PropertyGroup);
    const names = overrides.properties.map((leaf) => leaf.name);
    expect(py_eq(names, ["Brightness", "Layer Opacity", "Background Color"])).toBe(true);
  });

  test("test_pre_cif3_falls_back_to_legacy_container", () => {
    // Pre-CIF3 files (AE < 2022) store Essential Graphics in CIF2/CIFO.
    // The parser falls back to them, so the template name still resolves
    // to ExtendScript's "Untitled" instead of None.
    const versions = new Path(import.meta.dir).parent.parent.div("samples", "versions");
    const project = parse_project(versions.div("ae2018", "complete.aep"));
    expect(py_bool(project.compositions)).toBe(true);
    for (const comp of project.compositions) {
      expect(comp.motion_graphics_template_name).toBe("Untitled");
      expect(comp.motion_graphics_template_controller_count).toBe(0);
    }
  });
});
