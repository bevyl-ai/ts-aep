/** Tests for CompItem model parsing. */

// `from __future__ import annotations` is dropped: no annotation here is
// evaluated at runtime. `math.isclose` is the pyrt `isclose` (num.ts), and the
// keyword-only `rel_tol=` becomes its third positional argument.

import { describe, expect, test } from "bun:test";
import {
  AssertionError,
  getMember,
  getOrThrow,
  isclose,
  len,
  Path,
  assert,
  truthy,
  valueEquals,
  repr,
  StopIteration,
  zip,
} from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { getComp, getCompFromJsonByName, loadExpected, parseProject } from "../conftest.ts";
import { asInstance } from "../helpers.ts";
import { GuideOrientationType } from "../../src/py_aep/enums/index.ts";
import { AVLayer, CameraLayer, LightLayer, ShapeLayer, TextLayer } from "../../src/py_aep/models/layers/index.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";
import { FootageItem } from "../../src/py_aep/models/items/footage.ts";
import { FileSource } from "../../src/py_aep/models/sources/file.ts";
import { SolidSource } from "../../src/py_aep/models/sources/solid.ts";
import {
  _resolveControllerSourceLayer,
  _walkSourceProperty,
  resolveEssentialPropertyControllers,
} from "../../src/py_aep/resolvers/essential_properties.ts";
import { round } from "../support/python.ts";

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
    const expected = loadExpected(SAMPLES_DIR, "bgColor");
    const compJson = getCompFromJsonByName(expected, "bgColor_red");
    const comp = getComp(parseProject(SAMPLES_DIR.div("bgColor.aep")), "bgColor_red");
    expect(isclose(comp.bgColor[0], compJson["bgColor"][0])).toBe(true);
    expect(isclose(comp.bgColor[1], compJson["bgColor"][1])).toBe(true);
    expect(isclose(comp.bgColor[2], compJson["bgColor"][2])).toBe(true);
  });

  test("test_bgColor_custom", () => {
    const expected = loadExpected(SAMPLES_DIR, "bgColor");
    const compJson = getCompFromJsonByName(expected, "bgColor_custom");
    const comp = getComp(parseProject(SAMPLES_DIR.div("bgColor.aep")), "bgColor_custom");
    expect(isclose(comp.bgColor[0], compJson["bgColor"][0])).toBe(true);
    expect(isclose(comp.bgColor[1], compJson["bgColor"][1])).toBe(true);
    expect(isclose(comp.bgColor[2], compJson["bgColor"][2])).toBe(true);
  });
});

/** Tests for composition size attributes. */
describe("TestCompItemSize", () => {
  test("test_size_1920x1080", () => {
    const expected = loadExpected(SAMPLES_DIR, "size");
    const compJson = getCompFromJsonByName(expected, "size_1920x1080");
    const comp = getComp(parseProject(SAMPLES_DIR.div("size.aep")), "size_1920x1080");
    expect(comp.width).toBe(compJson["width"]);
    expect(compJson["width"]).toBe(1920);
    expect(comp.height).toBe(compJson["height"]);
    expect(compJson["height"]).toBe(1080);
  });

  test("test_size_2048x872", () => {
    const expected = loadExpected(SAMPLES_DIR, "size");
    const compJson = getCompFromJsonByName(expected, "size_2048x872");
    const comp = getComp(parseProject(SAMPLES_DIR.div("size.aep")), "size_2048x872");
    expect(comp.width).toBe(compJson["width"]);
    expect(compJson["width"]).toBe(2048);
    expect(comp.height).toBe(compJson["height"]);
    expect(compJson["height"]).toBe(872);
  });
});

/** Tests for composition frame rate. */
describe("TestCompItemFrameRate", () => {
  test("test_frameRate_23976", () => {
    const expected = loadExpected(SAMPLES_DIR, "frameRate");
    const compJson = getCompFromJsonByName(expected, "frameRate_23976");
    const comp = getComp(parseProject(SAMPLES_DIR.div("frameRate.aep")), "frameRate_23976");
    expect(isclose(comp.frameRate, compJson["frameRate"], 0.001)).toBe(true);
  });

  test("test_frameRate_30", () => {
    const expected = loadExpected(SAMPLES_DIR, "frameRate");
    const compJson = getCompFromJsonByName(expected, "frameRate_30");
    const comp = getComp(parseProject(SAMPLES_DIR.div("frameRate.aep")), "frameRate_30");
    expect(compJson["frameRate"]).toBe(30);
    expect(isclose(comp.frameRate, compJson["frameRate"], 0.001)).toBe(true);
  });
});

/** Tests for composition duration. */
describe("TestCompItemDuration", () => {
  test("test_duration_60", () => {
    const expected = loadExpected(SAMPLES_DIR, "comp_misc");
    const compJson = getCompFromJsonByName(expected, "duration_60");
    const comp = getComp(parseProject(SAMPLES_DIR.div("comp_misc.aep")), "duration_60");
    expect(compJson["duration"]).toBe(60);
    expect(isclose(comp.duration, compJson["duration"])).toBe(true);
  });
});

/** Tests for motion blur attributes. */
describe("TestCompItemMotionBlur", () => {
  test("test_motionBlur_true", () => {
    const expected = loadExpected(SAMPLES_DIR, "comp_flags");
    const compJson = getCompFromJsonByName(expected, "motionBlur_true");
    const comp = getComp(parseProject(SAMPLES_DIR.div("comp_flags.aep")), "motionBlur_true");
    expect(compJson["motionBlur"]).toBe(true);
    expect(comp.motionBlur).toBe(compJson["motionBlur"]);
  });

  test("test_shutterAngle_180", () => {
    const expected = loadExpected(SAMPLES_DIR, "shutterAngle");
    const compJson = getCompFromJsonByName(expected, "shutterAngle_180");
    const comp = getComp(parseProject(SAMPLES_DIR.div("shutterAngle.aep")), "shutterAngle_180");
    expect(comp.shutterAngle).toBe(compJson["shutterAngle"]);
    expect(compJson["shutterAngle"]).toBe(180);
  });

  test("test_shutterAngle_360", () => {
    const expected = loadExpected(SAMPLES_DIR, "shutterAngle");
    const compJson = getCompFromJsonByName(expected, "shutterAngle_360");
    const comp = getComp(parseProject(SAMPLES_DIR.div("shutterAngle.aep")), "shutterAngle_360");
    expect(comp.shutterAngle).toBe(compJson["shutterAngle"]);
    expect(compJson["shutterAngle"]).toBe(360);
  });

  test("test_shutterPhase_minus90", () => {
    const expected = loadExpected(SAMPLES_DIR, "comp_flags");
    const compJson = getCompFromJsonByName(expected, "shutterPhase_minus90");
    const comp = getComp(parseProject(SAMPLES_DIR.div("comp_flags.aep")), "shutterPhase_minus90");
    expect(comp.shutterPhase).toBe(compJson["shutterPhase"]);
    expect(compJson["shutterPhase"]).toBe(-90);
  });

  test("test_motionBlurSamplesPerFrame_32", () => {
    const expected = loadExpected(SAMPLES_DIR, "comp_flags");
    const compJson = getCompFromJsonByName(expected, "motionBlurSamplesPerFrame_32");
    const comp = getComp(parseProject(SAMPLES_DIR.div("comp_flags.aep")), "motionBlurSamplesPerFrame_32");
    expect(comp.motionBlurSamplesPerFrame).toBe(compJson["motionBlurSamplesPerFrame"]);
    expect(compJson["motionBlurSamplesPerFrame"]).toBe(32);
  });

  test("test_motionBlurAdaptiveSampleLimit_256", () => {
    const expected = loadExpected(SAMPLES_DIR, "comp_flags");
    const compJson = getCompFromJsonByName(expected, "motionBlurAdaptiveSampleLimit_256");
    const comp = getComp(parseProject(SAMPLES_DIR.div("comp_flags.aep")), "motionBlurAdaptiveSampleLimit_256");
    expect(comp.motionBlurAdaptiveSampleLimit).toBe(compJson["motionBlurAdaptiveSampleLimit"]);
    expect(compJson["motionBlurAdaptiveSampleLimit"]).toBe(256);
  });
});

/** Tests for resolution attributes. */
describe("TestCompItemResolution", () => {
  test("test_resolutionFactor_half", () => {
    const expected = loadExpected(SAMPLES_DIR, "resolutionFactor");
    const compJson = getCompFromJsonByName(expected, "resolutionFactor_half");
    const comp = getComp(parseProject(SAMPLES_DIR.div("resolutionFactor.aep")), "resolutionFactor_half");
    expect(valueEquals(comp.resolutionFactor, compJson["resolutionFactor"])).toBe(true);
  });

  test("test_resolutionFactor_quarter", () => {
    const expected = loadExpected(SAMPLES_DIR, "resolutionFactor");
    const compJson = getCompFromJsonByName(expected, "resolutionFactor_quarter");
    const comp = getComp(parseProject(SAMPLES_DIR.div("resolutionFactor.aep")), "resolutionFactor_quarter");
    expect(valueEquals(comp.resolutionFactor, compJson["resolutionFactor"])).toBe(true);
  });
});

/** Tests for nested composition options. */
describe("TestCompItemNestedOptions", () => {
  test("test_preserveNestedFrameRate_true", () => {
    const expected = loadExpected(SAMPLES_DIR, "comp_flags");
    const compJson = getCompFromJsonByName(expected, "preserveNestedFrameRate_true");
    const comp = getComp(parseProject(SAMPLES_DIR.div("comp_flags.aep")), "preserveNestedFrameRate_true");
    expect(compJson["preserveNestedFrameRate"]).toBe(true);
    expect(comp.preserveNestedFrameRate).toBe(compJson["preserveNestedFrameRate"]);
  });

  test("test_preserveNestedResolution_true", () => {
    const expected = loadExpected(SAMPLES_DIR, "comp_flags");
    const compJson = getCompFromJsonByName(expected, "preserveNestedResolution_true");
    const comp = getComp(parseProject(SAMPLES_DIR.div("comp_flags.aep")), "preserveNestedResolution_true");
    expect(compJson["preserveNestedResolution"]).toBe(true);
    expect(comp.preserveNestedResolution).toBe(compJson["preserveNestedResolution"]);
  });
});

/** Tests for frame blending attribute. */
describe("TestCompItemFrameBlending", () => {
  test("test_frameBlending_true", () => {
    const expected = loadExpected(SAMPLES_DIR, "comp_flags");
    const compJson = getCompFromJsonByName(expected, "frameBlending_true");
    const comp = getComp(parseProject(SAMPLES_DIR.div("comp_flags.aep")), "frameBlending_true");
    expect(compJson["frameBlending"]).toBe(true);
    expect(comp.frameBlending).toBe(compJson["frameBlending"]);
  });
});

/** Tests for hide shy layers attribute. */
describe("TestCompItemShyLayers", () => {
  test("test_hideShyLayers_true", () => {
    const expected = loadExpected(SAMPLES_DIR, "comp_flags");
    const compJson = getCompFromJsonByName(expected, "hideShyLayers_true");
    const comp = getComp(parseProject(SAMPLES_DIR.div("comp_flags.aep")), "hideShyLayers_true");
    expect(compJson["hideShyLayers"]).toBe(true);
    expect(comp.hideShyLayers).toBe(compJson["hideShyLayers"]);
  });
});

/** Tests for time-related attributes (rel_tol=0.001 for precision). */
describe("TestCompItemTime", () => {
  test("test_time_0", () => {
    const expected = loadExpected(SAMPLES_DIR, "time");
    const compJson = getCompFromJsonByName(expected, "time_0");
    const comp = getComp(parseProject(SAMPLES_DIR.div("time.aep")), "time_0");
    expect(compJson["time"]).toBe(0);
    expect(isclose(comp.time, compJson["time"])).toBe(true);
  });

  test("test_time_5", () => {
    const expected = loadExpected(SAMPLES_DIR, "time");
    const compJson = getCompFromJsonByName(expected, "time_5");
    const comp = getComp(parseProject(SAMPLES_DIR.div("time.aep")), "time_5");
    expect(isclose(comp.time, compJson["time"], 0.001)).toBe(true);
  });

  test("test_time_15", () => {
    const expected = loadExpected(SAMPLES_DIR, "time");
    const compJson = getCompFromJsonByName(expected, "time_15");
    const comp = getComp(parseProject(SAMPLES_DIR.div("time.aep")), "time_15");
    expect(isclose(comp.time, compJson["time"], 0.001)).toBe(true);
  });
});

/** Tests for work area attributes (rel_tol=0.001 for precision). */
describe("TestCompItemWorkArea", () => {
  test("test_workAreaStart_5", () => {
    const expected = loadExpected(SAMPLES_DIR, "workArea");
    const compJson = getCompFromJsonByName(expected, "workAreaStart_5");
    const comp = getComp(parseProject(SAMPLES_DIR.div("workArea.aep")), "workAreaStart_5");
    expect(isclose(comp.workAreaStart, compJson["workAreaStart"], 0.001)).toBe(true);
  });

  test("test_workAreaDuration_10", () => {
    const expected = loadExpected(SAMPLES_DIR, "workArea");
    const compJson = getCompFromJsonByName(expected, "workAreaDuration_10");
    const comp = getComp(parseProject(SAMPLES_DIR.div("workArea.aep")), "workAreaDuration_10");
    expect(isclose(comp.workAreaDuration, compJson["workAreaDuration"], 0.001)).toBe(true);
  });
});

/** Tests for display start attributes. */
describe("TestCompItemDisplayStart", () => {
  test("test_displayStartFrame_100", () => {
    const expected = loadExpected(SAMPLES_DIR, "displayStart");
    const compJson = getCompFromJsonByName(expected, "displayStartFrame_100");
    const comp = getComp(parseProject(SAMPLES_DIR.div("displayStart.aep")), "displayStartFrame_100");
    expect(comp.displayStartFrame).toBe(compJson["displayStartFrame"]);
    expect(compJson["displayStartFrame"]).toBe(100);
  });

  test("test_displayStartTime_10", () => {
    const expected = loadExpected(SAMPLES_DIR, "displayStart");
    const compJson = getCompFromJsonByName(expected, "displayStartTime_10");
    const comp = getComp(parseProject(SAMPLES_DIR.div("displayStart.aep")), "displayStartTime_10");
    expect(compJson["displayStartTime"]).toBe(10);
    expect(isclose(comp.displayStartTime, compJson["displayStartTime"])).toBe(true);
  });
});

/** Tests for pixel aspect ratio. */
describe("TestCompItemPixelAspect", () => {
  test("test_pixelAspect_0_75", () => {
    const expected = loadExpected(SAMPLES_DIR, "pixelAspect");
    const compJson = getCompFromJsonByName(expected, "pixelAspect_0.75");
    const comp = getComp(parseProject(SAMPLES_DIR.div("pixelAspect.aep")), "pixelAspect_0.75");
    expect(isclose(comp.pixelAspect, compJson["pixelAspect"])).toBe(true);
  });

  test("test_pixelAspect_2_0", () => {
    const expected = loadExpected(SAMPLES_DIR, "pixelAspect");
    const compJson = getCompFromJsonByName(expected, "pixelAspect_2");
    const comp = getComp(parseProject(SAMPLES_DIR.div("pixelAspect.aep")), "pixelAspect_2");
    expect(isclose(comp.pixelAspect, compJson["pixelAspect"])).toBe(true);
  });
});

/** Tests for composition name. */
describe("TestCompItemName", () => {
  test("test_name_renamed", () => {
    const expected = loadExpected(SAMPLES_DIR, "comp_misc");
    const compJson = getCompFromJsonByName(expected, "RenamedComp");
    const comp = getComp(parseProject(SAMPLES_DIR.div("comp_misc.aep")), "RenamedComp");
    expect(comp.name).toBe(compJson["name"]);
    expect(compJson["name"]).toBe("RenamedComp");
  });
});

/** Tests for composition comment. */
describe("TestCompItemComment", () => {
  test("test_comment", () => {
    const expected = loadExpected(SAMPLES_DIR, "comp_misc");
    const compJson = getCompFromJsonByName(expected, "comment");
    const comp = getComp(parseProject(SAMPLES_DIR.div("comp_misc.aep")), "comment");
    expect(comp.comment).toBe(compJson["comment"]);
    expect(compJson["comment"]).toBe("Test comment");
  });
});

/** Tests for composition label. */
describe("TestCompItemLabel", () => {
  test("test_label_5", () => {
    const expected = loadExpected(SAMPLES_DIR, "comp_misc");
    const compJson = getCompFromJsonByName(expected, "label_5");
    const comp = getComp(parseProject(SAMPLES_DIR.div("comp_misc.aep")), "label_5");
    expect(compJson["label"]).toBe(5);
    // IntEnum members are plain numbers (RULEBOOK §6): `.value` is the member itself.
    expect(comp.label).toBe(compJson["label"]);
  });
});

/** Tests for composition drop frame. */
describe("TestCompItemDropFrame", () => {
  test("test_dropFrame_true", () => {
    const expected = loadExpected(SAMPLES_DIR, "dropFrame");
    const compJson = getCompFromJsonByName(expected, "dropFrame_true");
    const comp = getComp(parseProject(SAMPLES_DIR.div("dropFrame.aep")), "dropFrame_true");
    expect(compJson["dropFrame"]).toBe(true);
    expect(comp.dropFrame).toBe(compJson["dropFrame"]);
  });

  test("test_dropFrame_false", () => {
    const expected = loadExpected(SAMPLES_DIR, "dropFrame");
    const compJson = getCompFromJsonByName(expected, "dropFrame_false");
    const comp = getComp(parseProject(SAMPLES_DIR.div("dropFrame.aep")), "dropFrame_false");
    expect(compJson["dropFrame"]).toBe(false);
    expect(comp.dropFrame).toBe(compJson["dropFrame"]);
  });
});

/** Tests for composition renderer attribute. */
describe("TestCompItemRenderer", () => {
  test("test_renderers", () => {
    const comp = parseProject(SAMPLES_DIR.div("renderer_classic_3d.aep")).compositions[0];
    expect(valueEquals(comp.renderers, ["ADBE Advanced 3d", "ADBE Calder", "ADBE Ernst", "ADBE Picasso"])).toBe(true);
  });

  test("test_renderer_classic_3d", () => {
    const comp = parseProject(SAMPLES_DIR.div("renderer_classic_3d.aep")).compositions[0];
    expect(comp.renderer).toBe("ADBE Advanced 3d");
  });

  test("test_renderer_advanced_3d", () => {
    const comp = parseProject(SAMPLES_DIR.div("renderer_advanced_3d.aep")).compositions[0];
    expect(comp.renderer).toBe("ADBE Calder");
  });

  test("test_renderer_cinema_4d", () => {
    const comp = parseProject(SAMPLES_DIR.div("renderer_cinema_4d.aep")).compositions[0];
    expect(comp.renderer).toBe("ADBE Ernst");
  });

  test("test_renderer_ray_traced", () => {
    const comp = parseProject(SAMPLES_DIR.div("renderer_ray_traced.aep")).compositions[0];
    expect(comp.renderer).toBe("ADBE Picasso");
  });
});

/** Tests for CompItem layer-type filtering properties. */
describe("TestCompItemLayerFiltering", () => {
  test("test_text_layers", () => {
    const comp = getComp(parseProject(LAYER_SAMPLES_DIR.div("type.aep")), "type_text");
    expect(len(comp.textLayers)).toBe(1);
    expect(comp.textLayers.every((layer) => layer instanceof TextLayer)).toBe(true);
  });

  test("test_shape_layers", () => {
    const comp = getComp(parseProject(LAYER_SAMPLES_DIR.div("type.aep")), "type_shape");
    expect(len(comp.shapeLayers)).toBe(1);
    expect(comp.shapeLayers.every((layer) => layer instanceof ShapeLayer)).toBe(true);
  });

  test("test_camera_layers", () => {
    const comp = getComp(parseProject(LAYER_SAMPLES_DIR.div("type.aep")), "type_camera");
    expect(len(comp.cameraLayers)).toBe(1);
    expect(comp.cameraLayers.every((layer) => layer instanceof CameraLayer)).toBe(true);
  });

  test("test_light_layers", () => {
    const comp = getComp(parseProject(LAYER_SAMPLES_DIR.div("lightType.aep")), "lightType_POINT");
    expect(len(comp.lightLayers)).toBe(1);
    expect(comp.lightLayers.every((layer) => layer instanceof LightLayer)).toBe(true);
  });

  test("test_null_layers", () => {
    const comp = getComp(parseProject(LAYER_SAMPLES_DIR.div("type.aep")), "type_null");
    expect(len(comp.nullLayers)).toBe(1);
    expect(comp.nullLayers.every((layer) => layer.nullLayer)).toBe(true);
  });

  test("test_adjustment_layers", () => {
    const comp = getComp(parseProject(LAYER_SAMPLES_DIR.div("avlayer_flags.aep")), "adjustmentLayer_true");
    expect(len(comp.adjustmentLayers)).toBe(1);
    expect(comp.adjustmentLayers.every((layer) => layer instanceof AVLayer && layer.adjustmentLayer)).toBe(true);
  });

  test("test_three_d_layers", () => {
    const comp = getComp(parseProject(LAYER_SAMPLES_DIR.div("avlayer_flags.aep")), "threeDLayer_true");
    expect(len(comp.threeDLayers)).toBe(1);
    expect(comp.threeDLayers.every((layer) => layer instanceof AVLayer && layer.threeDLayer)).toBe(true);
  });

  test("test_guide_layers", () => {
    const comp = getComp(parseProject(LAYER_SAMPLES_DIR.div("avlayer_flags.aep")), "guideLayer_true");
    expect(len(comp.guideLayers)).toBe(1);
    expect(comp.guideLayers.every((layer) => layer instanceof AVLayer && layer.guideLayer)).toBe(true);
  });

  test("test_solo_layers", () => {
    const comp = getComp(parseProject(LAYER_SAMPLES_DIR.div("layer_switches.aep")), "solo_true");
    expect(len(comp.soloLayers)).toBe(1);
    expect(comp.soloLayers.every((layer) => layer.solo)).toBe(true);
  });

  /** A comp with only a shape layer has no text layers. */
  test("test_empty_text_layers", () => {
    const comp = getComp(parseProject(LAYER_SAMPLES_DIR.div("type.aep")), "type_shape");
    expect(valueEquals(comp.textLayers, [])).toBe(true);
  });

  /** A comp with only a text layer has no camera layers. */
  test("test_empty_camera_layers", () => {
    const comp = getComp(parseProject(LAYER_SAMPLES_DIR.div("type.aep")), "type_text");
    expect(valueEquals(comp.cameraLayers, [])).toBe(true);
  });

  /** A comp with only a text layer has no light layers. */
  test("test_empty_light_layers", () => {
    const comp = getComp(parseProject(LAYER_SAMPLES_DIR.div("type.aep")), "type_text");
    expect(valueEquals(comp.lightLayers, [])).toBe(true);
  });

  test("test_file_layers", () => {
    const comp = parseProject(FOOTAGE_SAMPLES_DIR.div("footage_not_missing.aep")).compositions[0];
    expect(len(comp.fileLayers)).toBe(1);
    for (const layer of comp.fileLayers) {
      expect(layer instanceof AVLayer).toBe(true);
      expect(asInstance(layer.source, FootageItem).mainSource instanceof FileSource).toBe(true);
    }
  });

  test("test_solid_layers", () => {
    const comp = parseProject(LAYER_SAMPLES_DIR.div("gray_solid_1_above.aep")).compositions[0];
    expect(len(comp.solidLayers)).toBe(2);
    for (const layer of comp.solidLayers) {
      expect(layer instanceof AVLayer).toBe(true);
      expect(asInstance(layer.source, FootageItem).mainSource instanceof SolidSource).toBe(true);
    }
  });

  /** A comp with only solid layers has no placeholder layers. */
  test("test_placeholder_layers_empty", () => {
    const comp = parseProject(LAYER_SAMPLES_DIR.div("gray_solid_1_above.aep")).compositions[0];
    expect(valueEquals(comp.placeholderLayers, [])).toBe(true);
  });

  /** A comp with only solid layers has no file layers. */
  test("test_empty_file_layers", () => {
    const comp = parseProject(LAYER_SAMPLES_DIR.div("gray_solid_1_above.aep")).compositions[0];
    expect(valueEquals(comp.fileLayers, [])).toBe(true);
  });
});

/** Tests for CompItem.guides. */
describe("TestCompItemGuides", () => {
  test("test_no_guides", () => {
    const comp = getComp(parseProject(SAMPLES_DIR.div("guides.aep")), "guides_none");
    expect(valueEquals(comp.guides, [])).toBe(true);
  });

  test("test_horizontal_guide", () => {
    const expected = loadExpected(SAMPLES_DIR, "guides");
    const compJson = getCompFromJsonByName(expected, "guides_horizontal");
    const comp = getComp(parseProject(SAMPLES_DIR.div("guides.aep")), "guides_horizontal");
    expect(len(comp.guides)).toBe(1);
    const guide = comp.guides[0];
    const guidesJson = compJson["guides"];
    assert(Array.isArray(guidesJson), "export has no guides list");
    const exp = guidesJson[0];
    expect(guide.orientationType).toBe(exp["orientationType"]);
    expect(guide.position).toBe(exp["position"]);
    expect(guide.positionType).toBe(exp["positionType"]);
  });

  test("test_both_guides", () => {
    const expected = loadExpected(SAMPLES_DIR, "guides");
    const compJson = getCompFromJsonByName(expected, "guides_both");
    const comp = getComp(parseProject(SAMPLES_DIR.div("guides.aep")), "guides_both");
    const guidesJson = compJson["guides"];
    assert(Array.isArray(guidesJson), "export has no guides list");
    expect(len(comp.guides)).toBe(len(guidesJson));
    for (const [guide, exp] of zip(comp.guides, guidesJson)) {
      expect(guide.orientationType).toBe(exp["orientationType"]);
      expect(guide.position).toBe(exp["position"]);
      expect(guide.positionType).toBe(exp["positionType"]);
    }
  });

  test("test_guide_repr", () => {
    const comp = getComp(parseProject(SAMPLES_DIR.div("guides.aep")), "guides_horizontal");
    expect(repr(comp.guides[0]).includes("horizontal")).toBe(true);
  });

  test("test_guide_orientation_horizontal", () => {
    const comp = getComp(parseProject(SAMPLES_DIR.div("guides.aep")), "guides_horizontal");
    expect(comp.guides[0].orientationType).toBe(GuideOrientationType.HORIZONTAL);
  });

  test("test_guide_orientation_vertical", () => {
    const comp = getComp(parseProject(SAMPLES_DIR.div("guides.aep")), "guides_both");
    const verticalGuides = comp.guides.filter((g) => g.orientationType === GuideOrientationType.VERTICAL);
    expect(len(verticalGuides)).toBe(1);
    expect(verticalGuides[0].position).toBe(960.0);
  });
});

/** Tests for Essential Graphics panel parsing. */
describe("TestEssentialGraphics", () => {
  test("test_fill_color_added", () => {
    const project = parseProject(EG_SAMPLES_DIR.div("fill_color_added.aep"));
    const comp = next_(project.compositions.find((c) => c.name === "primary"));
    expect(comp.motionGraphicsTemplateName).toBe("Untitled");
    expect(comp.motionGraphicsTemplateControllerCount).toBe(1);
    expect(comp.motionGraphicsControllers[0].name).toBe("Fill Color");
    expect(valueEquals(comp.motionGraphicsTemplateControllerNames, ["Fill Color"])).toBe(true);
  });

  test("test_custom_template_name", () => {
    const project = parseProject(EG_SAMPLES_DIR.div("custom_template_name.aep"));
    const comp = next_(project.compositions.find((c) => c.name === "primary"));
    expect(comp.motionGraphicsTemplateName).toBe("My Custom Template");
  });

  test("test_multiple_controllers", () => {
    const project = parseProject(EG_SAMPLES_DIR.div("multiple_controllers.aep"));
    const comp = next_(project.compositions.find((c) => c.name === "primary"));
    expect(comp.motionGraphicsTemplateControllerCount).toBe(3);
    expect(
      valueEquals(comp.motionGraphicsTemplateControllerNames, ["Brightness", "Layer Opacity", "Background Color"]),
    ).toBe(true);
  });

  test("test_controller_renamed", () => {
    const project = parseProject(EG_SAMPLES_DIR.div("controller_renamed.aep"));
    const comp = next_(project.compositions.find((c) => c.name === "primary"));
    expect(comp.motionGraphicsControllers[0].name).toBe("Renamed Color");
  });

  test("test_no_essential_properties", () => {
    const project = parseProject(EG_SAMPLES_DIR.div("no_essential_properties.aep"));
    for (const comp of project.compositions) {
      expect(comp.motionGraphicsTemplateControllerCount).toBe(0);
      expect(valueEquals(comp.motionGraphicsTemplateControllerNames, [])).toBe(true);
    }
  });

  test("test_main_comp_has_no_controllers", () => {
    const project = parseProject(EG_SAMPLES_DIR.div("fill_color_added.aep"));
    const comp = next_(project.compositions.find((c) => c.name === "main"));
    expect(comp.motionGraphicsTemplateControllerCount).toBe(0);
  });

  /** Verify controller_type for each controller type sample. */
  test("test_controller_types", () => {
    const typeSamples = new Map<string, number>([
      ["checkbox_controller", 1],
      ["slider_controller", 2],
      ["color_controller", 4],
      ["point_controller", 5],
      ["text_source_text", 6],
      ["dropdown_controller", 13],
    ]);
    for (const [sample, expectedType] of typeSamples) {
      const project = parseProject(EG_SAMPLES_DIR.div(`${sample}.aep`));
      const comp = next_(project.compositions.find((c) => c.name === "primary"));
      const ctrls = comp.motionGraphicsControllers;
      assert(truthy(ctrls), `${sample}: no controllers`);
      const ctrl = ctrls[0];
      assert(
        ctrl.controllerType === expectedType,
        `${sample}: expected type ${expectedType}, got ${ctrl.controllerType}`,
      );
    }
  });

  test("test_essential_property_uuids_resolve_to_controllers", () => {
    // Regression: a precomp layer's OvG2 overrides live under the layer's
    // root tdgp, not the Layr's direct children. _parse_ovg2_uuids used to
    // search the wrong level, so essential_property_uuids returned [] for
    // every populated sample. The override UUIDs are the source comp's
    // controller UUIDs verbatim.
    const project = parseProject(EG_SAMPLES_DIR.div("multiple_controllers.aep"));
    const source = next_(project.compositions.find((c) => c.name === "primary"));
    // NOTE(port): MotionGraphicsController.uuid is a str in Python and a string here, so Set identity matches.
    const controllerUuids = new Set(source.motionGraphicsControllers.map((c) => c.uuid));
    expect(len(controllerUuids)).toBe(3);

    const main = next_(project.compositions.find((c) => c.name === "main"));
    const withOverrides = main.layers.filter((layer) => truthy(layer.essentialPropertyUuids));
    expect(len(withOverrides)).toBe(1);
    const overrides = withOverrides[0].essentialPropertyUuids;
    expect(len(overrides)).toBe(3);
    expect([...new Set(overrides)].every((u) => controllerUuids.has(u))).toBe(true);
  });

  test("test_essential_property_uuids_empty_without_overrides", () => {
    const project = parseProject(EG_SAMPLES_DIR.div("no_essential_properties.aep"));
    for (const comp of project.compositions) {
      for (const layer of comp.layers) {
        expect(valueEquals(layer.essentialPropertyUuids, [])).toBe(true);
      }
    }
  });

  test("test_essential_property_controllers_resolve", () => {
    // The precomp layer's overrides resolve to the source comp's
    // controllers by shared UUID, in override order.
    const project = parseProject(EG_SAMPLES_DIR.div("multiple_controllers.aep"));
    const main = next_(project.compositions.find((c) => c.name === "main"));
    const layer = next_(main.layers.find((la) => truthy(la.essentialPropertyUuids)));
    const controllers = asInstance(layer, AVLayer).essentialPropertyControllers;
    expect(
      valueEquals(
        controllers.map((c) => c.name),
        ["Brightness", "Layer Opacity", "Background Color"],
      ),
    ).toBe(true);
    // Each resolved controller's uuid is the override uuid at that position.
    expect(
      valueEquals(
        controllers.map((c) => c.uuid),
        layer.essentialPropertyUuids,
      ),
    ).toBe(true);
  });

  test("test_essential_property_controllers_single_override", () => {
    const project = parseProject(EG_SAMPLES_DIR.div("text_source_text.aep"));
    const layer = next_(
      project.compositions.flatMap((comp) => comp.layers).find((la) => truthy(la.essentialPropertyUuids)),
    );
    const controllers = asInstance(layer, AVLayer).essentialPropertyControllers;
    expect(len(controllers)).toBe(1);
    expect(controllers[0].name).toBe("Title Text");
  });

  test("test_essential_property_controllers_empty_for_non_precomp", () => {
    // A layer with no overrides (a solid, non-CompItem source) resolves [].
    const project = parseProject(EG_SAMPLES_DIR.div("multiple_controllers.aep"));
    const primary = next_(project.compositions.find((c) => c.name === "primary"));
    const solid = next_(primary.layers.find((layer) => layer.name === "Gray Solid 1"));
    expect(valueEquals(asInstance(solid, AVLayer).essentialPropertyControllers, [])).toBe(true);
  });

  test("test_controller_source_property_path", () => {
    // Each controller records the root-to-leaf path of the source-comp
    // property it exposes (match name + index; None index = match by name).
    const project = parseProject(EG_SAMPLES_DIR.div("multiple_controllers.aep"));
    const comp = next_(project.compositions.find((c) => c.name === "primary"));
    const byName = new Map(comp.motionGraphicsControllers.map((c) => [c.name, c] as const));

    const bg = getOrThrow(byName, "Background Color").sourcePropertyPath;
    expect(
      valueEquals(
        bg.map((n) => n.matchName),
        ["ADBE Effect Parade", "ADBE Fill", "ADBE Fill-0002"],
      ),
    ).toBe(true);
    expect(
      valueEquals(
        bg.map((n) => n.propIndex),
        [null, 0, 3],
      ),
    ).toBe(true);

    // A transform property (not an effect): every node matches by name.
    const opacity = getOrThrow(byName, "Layer Opacity").sourcePropertyPath;
    expect(
      valueEquals(
        opacity.map((n) => n.matchName),
        ["ADBE Transform Group", "ADBE Opacity"],
      ),
    ).toBe(true);
    expect(opacity.every((n) => n.propIndex == null)).toBe(true);
  });

  test("test_group_controller", () => {
    // A type-10 Group controller and its members parse as a flat controller
    // list - group members are SIBLING CCtl, not nested, so the stored ones
    // are not lost. The group itself controls no single source property.
    // (ExtendScript reports a 4th "GropDropZone" drop-zone controller that
    // AE synthesizes at runtime and does not store, so it is absent here.)
    const project = parseProject(EG_SAMPLES_DIR.div("group_controller.aep"));
    const comp = next_(project.compositions.find((c) => c.name === "Comp 1"));
    expect(
      valueEquals(
        comp.motionGraphicsControllers.map((c) => [c.name, c.controllerType]),
        [
          ["Group", 10],
          ["Gaussian Blur Blurriness", 2],
          ["Fill Color", 4],
        ],
      ),
    ).toBe(true);
    expect(valueEquals(comp.motionGraphicsControllers[0].sourcePropertyPath, [])).toBe(true);
    // Pin the deliberate one-lower-than-ExtendScript count (ES reports 4
    // including the unstored runtime "GropDropZone"); guards against drift.
    expect(comp.motionGraphicsTemplateControllerCount).toBe(3);
    expect(comp.motionGraphicsTemplateControllerNames.includes("GropDropZone")).toBe(false);

    // The precomp layer's overrides resolve to all three (incl. the group).
    const main = next_(project.compositions.find((c) => c.name === "main"));
    const layer = next_(main.layers.find((la) => truthy(la.essentialPropertyUuids)));
    expect(
      valueEquals(
        asInstance(layer, AVLayer).essentialPropertyControllers.map((c) => c.name),
        ["Group", "Gaussian Blur Blurriness", "Fill Color"],
      ),
    ).toBe(true);
  });

  test("test_media_replacement_controller", () => {
    // A type-14 Media Replacement controller parses, and (unlike a Group)
    // AE synthesizes no extra drop-zone controller, so the count matches
    // ExtendScript exactly.
    const project = parseProject(EG_SAMPLES_DIR.div("media_replacement.aep"));
    const comp = next_(project.compositions.find((c) => c.name === "image_with_alpha"));
    const ctrls = comp.motionGraphicsControllers;
    expect(comp.motionGraphicsTemplateControllerCount).toBe(1);
    expect(len(ctrls)).toBe(1);
    expect(ctrls[0].controllerType).toBe(14);
    expect(ctrls[0].name).toBe("image_with_alpha.png");
    // The controller records the source comp + layer it controls.
    expect(ctrls[0].sourceCompId).toBe(2);
    expect(ctrls[0].sourceLayerId).toBe(14);
  });

  test("test_media_replacement_override_attributes", () => {
    // The precomp layer's Essential Properties override now exposes its
    // ADBE Layer Source Alternate child, and the media-replacement
    // attributes decode from the blsi slot (AE wraps the replacement
    // footage in a composition, so alternate_source is that comp).
    const project = parseProject(EG_SAMPLES_DIR.div("media_replacement.aep"));
    const host = next_(project.compositions.find((c) => c.name === "image_with_alpha 2"));
    const layer = next_(host.layers.find((la) => truthy(la.essentialPropertyUuids)));

    const overrides = asInstance(
      next_(layer.properties.find((p) => p.matchName === "ADBE Layer Overrides")),
      PropertyGroup,
    );
    expect(overrides.numProperties).toBe(1);
    const alt = asInstance(overrides.properties[0], Property);
    expect(alt.matchName).toBe("ADBE Layer Source Alternate");
    expect(alt.name).toBe("image_with_alpha.png");
    expect(alt.canSetAlternateSource).toBe(true);
    expect(alt.isModified).toBe(true);
    expect(alt.alternateSource != null).toBe(true);
    assert(alt.alternateSource != null);
    expect(alt.alternateSource.name).toBe("image_with_alpha.png_sequence");
    // essential_property_source resolves the override to its source layer
    // in the master comp (matched via the controller's CCId/CLId).
    const src = alt.essentialPropertySource;
    expect(src != null).toBe(true);
    assert(src instanceof AVLayer);
    expect(src.name).toBe("image_with_alpha.png");
    expect(src.containingComp.name).toBe("image_with_alpha");

    // The Source Options copy is an unset slot (blsi == 0).
    const srcGroup = asInstance(
      next_(layer.properties.find((p) => p.matchName === "ADBE Source Options Group")),
      PropertyGroup,
    );
    const srcAlt = asInstance(
      next_(srcGroup.properties.find((c) => c.matchName === "ADBE Layer Source Alternate")),
      Property,
    );
    expect(srcAlt.canSetAlternateSource).toBe(false);
    expect(srcAlt.alternateSource == null).toBe(true);
  });

  test("test_property_source_essential_property_walk", () => {
    // A Property-source controller (created from a Property, not Media
    // Replacement Footage) resolves to its source Property by walking the
    // controller's source-property path BY MATCH NAME - prop_index is
    // AE-internal and ignored, so the hidden `-0001`/`-0002` effect leaves
    // resolve correctly. This drives the resolver helpers directly via the
    // controllers (the public `essential_property_source` path is exercised
    // by test_essential_property_override_metadata).
    const project = parseProject(EG_SAMPLES_DIR.div("group_controller.aep"));
    const layer = next_(
      project.compositions
        .flatMap((comp) => comp.layers)
        .find((la) => la instanceof AVLayer && truthy(resolveEssentialPropertyControllers(la))),
    );
    const ctrls = resolveEssentialPropertyControllers(asInstance(layer, AVLayer));
    const byName = new Map(ctrls.map((c) => [c.name, c] as const));

    const blur = getOrThrow(byName, "Gaussian Blur Blurriness");
    const srcLayer = _resolveControllerSourceLayer(project, blur);
    expect(srcLayer != null).toBe(true);
    if (srcLayer == null) throw new AssertionError("blur controller has no source layer");
    const leafNode = _walkSourceProperty(srcLayer, blur.sourcePropertyPath);
    expect(leafNode != null).toBe(true);
    const leaf = asInstance(leafNode, Property);
    expect(leaf.matchName).toBe("ADBE Gaussian Blur 2-0001");
    expect(leaf.enabled).toBe(true);
    expect(leaf.minValue).toBe(0);
    expect(leaf.maxValue).toBe(30000);
    expect(leaf.value).toBe(25.0);

    // The override leaf carries its OWN value; the source Property here is
    // the effect's source value ([1,0,0,1]), distinct from any override.
    const fill = getOrThrow(byName, "Fill Color");
    const fillSrcLayer = _resolveControllerSourceLayer(project, fill);
    if (fillSrcLayer == null) throw new AssertionError("fill controller has no source layer");
    const fillLeafNode = _walkSourceProperty(fillSrcLayer, fill.sourcePropertyPath);
    expect(fillLeafNode != null).toBe(true);
    const fillLeaf = asInstance(fillLeafNode, Property);
    expect(fillLeaf.matchName).toBe("ADBE Fill-0002");
    expect(valueEquals(Array.from(fillLeaf.value), [1.0, 0.0, 0.0, 1.0])).toBe(true);

    // A Group controller (type 10) stores no source-property path -> no leaf.
    const group = getOrThrow(byName, "Group");
    expect(valueEquals(group.sourcePropertyPath, [])).toBe(true);
  });

  test("test_essential_property_override_metadata", () => {
    // Non-media-replacement override groups are exposed; each leaf's derived
    // metadata (enabled, bounds, is_modified, name) reflects its Essential
    // Graphics SOURCE property, while its value is its own override cdat.
    const project = parseProject(EG_SAMPLES_DIR.div("group_controller.aep"));
    const layer = next_(
      project.compositions
        .flatMap((comp) => comp.layers)
        .find(
          (la) =>
            la.properties.some((p) => p.matchName === "ADBE Layer Overrides") &&
            asInstance(next_(la.properties.find((p) => p.matchName === "ADBE Layer Overrides")), PropertyGroup)
              .numProperties > 0,
        ),
    );
    const overrides = asInstance(
      next_(layer.properties.find((p) => p.matchName === "ADBE Layer Overrides")),
      PropertyGroup,
    );
    expect(overrides.numProperties).toBe(1);
    expect(overrides.isModified).toBe(true); // non-empty override group

    const grp = asInstance(overrides.properties[0], PropertyGroup);
    expect(grp.matchName).toBe("ADBE Layer Overrides Group");
    expect(grp.numProperties).toBe(2);
    expect(grp.isModified).toBe(true);

    const [blur, fill] = grp.properties.map((leaf) => asInstance(leaf, Property));
    // Source-derived bounds/enabled (leaf's own tduM is 50, source is 30000).
    expect(blur.name).toBe("Gaussian Blur Blurriness");
    expect(blur.enabled).toBe(true);
    expect(blur.hasMin && blur.hasMax).toBe(true);
    expect(valueEquals([blur.minValue, blur.maxValue], [0, 30000])).toBe(true);
    expect(blur.value).toBe(25.0); // own override value
    expect(blur.isModified).toBe(false); // equals source value

    // Fill leaf has no tdum/tduM; bounds come from the source Fill Color.
    expect(fill.name).toBe("Fill Color");
    expect(fill.hasMin && fill.hasMax).toBe(true);
    assert(typeof fill.maxValue === "number");
    expect(round(fill.maxValue, 2)).toBe(3921568.63);
    expect(fill.isModified).toBe(true); // override differs from source [1,0,0,1]
    expect(
      valueEquals(
        fill.value.map((c: number) => round(c, 4)),
        [0.2475, 0.7255, 0.6299, 1.0],
      ),
    ).toBe(true);

    // Public essential_property_source resolves the override to its source
    // Property (a different object than the override leaf).
    const src = blur.essentialPropertySource;
    expect(src != null && src !== blur).toBe(true);
    assert(src != null);
    expect(src.matchName).toBe("ADBE Gaussian Blur 2-0001");
  });

  test("test_point_override_value_in_source_pixels", () => {
    // A point-control override leaf borrows its source parameter's pixel
    // denormalization scale, so its value is in source-comp pixels (matching
    // ExtendScript), not the raw 0-1 the leaf stores. is_modified then
    // compares like for like. Source comp is 1000x1000, so 0.5 -> 500.
    const project = parseProject(EG_SAMPLES_DIR.div("point_controller.aep"));
    const layer = next_(
      project.compositions
        .flatMap((comp) => comp.layers)
        .find((la) =>
          la.properties.some(
            (p) => p.matchName === "ADBE Layer Overrides" && asInstance(p, PropertyGroup).numProperties > 0,
          ),
        ),
    );
    const overrides = asInstance(
      next_(layer.properties.find((p) => p.matchName === "ADBE Layer Overrides")),
      PropertyGroup,
    );
    const leaf = asInstance(overrides.properties[0], Property);
    expect(leaf.matchName).toBe("ADBE Point Control-0001");
    expect(valueEquals(leaf.value, [500.0, 500.0])).toBe(true); // pixels, not the stored [0.5, 0.5]
    expect(leaf.isModified).toBe(false); // equals source, once in the same units
    expect(leaf.unitsText).toBe("pixels");
    const src = leaf.essentialPropertySource;
    expect(src != null && valueEquals(getMember(src, "value"), [500.0, 500.0])).toBe(true);
  });

  test("test_essential_property_override_name_from_controller", () => {
    // When an override leaf's own tdsn is empty, its display name comes from
    // the Essential Graphics controller, not the match-name fallback.
    const project = parseProject(EG_SAMPLES_DIR.div("multiple_controllers.aep"));
    const layer = next_(
      project.compositions
        .flatMap((comp) => comp.layers)
        .find((la) =>
          la.properties.some(
            (p) => p.matchName === "ADBE Layer Overrides" && asInstance(p, PropertyGroup).numProperties > 0,
          ),
        ),
    );
    const overrides = asInstance(
      next_(layer.properties.find((p) => p.matchName === "ADBE Layer Overrides")),
      PropertyGroup,
    );
    const names = overrides.properties.map((leaf) => leaf.name);
    expect(valueEquals(names, ["Brightness", "Layer Opacity", "Background Color"])).toBe(true);
  });

  test("test_pre_cif3_falls_back_to_legacy_container", () => {
    // Pre-CIF3 files (AE < 2022) store Essential Graphics in CIF2/CIFO.
    // The parser falls back to them, so the template name still resolves
    // to ExtendScript's "Untitled" instead of None.
    const versions = new Path(import.meta.dir).parent.parent.div("samples", "versions");
    const project = parseProject(versions.div("ae2018", "complete.aep"));
    expect(truthy(project.compositions)).toBe(true);
    for (const comp of project.compositions) {
      expect(comp.motionGraphicsTemplateName).toBe("Untitled");
      expect(comp.motionGraphicsTemplateControllerCount).toBe(0);
    }
  });
});
