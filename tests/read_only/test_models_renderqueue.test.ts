/** Tests for RenderQueue model parsing. */

// `from __future__ import annotations` is dropped: no annotation here is
// evaluated at runtime. `os.getenv` becomes `process.env` (None → null), and
// `pytest.mark.parametrize` becomes `test.each` (see src/pyrt/pytest.ts). The
// Python package registers every chunk type on import, so the TS test imports
// `_register.ts` to do the same.

import { describe, expect, test } from "bun:test";
import { approx, raises } from "../../src/pyrt/pytest.ts";
import { Path, contains, enumerate, getOrThrow, KeyError, len, valueEquals, StopIteration, ValueError } from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { getRqi, loadExpected, parseProject } from "../conftest.ts";
import { ConvertToLinearLight, GetSettingsFormat } from "../../src/py_aep/enums/index.ts";
import { OutputModule, RenderQueue } from "../../src/py_aep/models/renderqueue/index.ts";
import { asInstance } from "../helpers.ts";

const SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models", "renderqueue");
const OM_SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models", "output_module");
const BUGS_DIR = new Path(import.meta.dir, "..", "..", "samples", "bugs");
const AE_PREFS_DIR = process.env.AE_PREFS_DIR ?? null;
const OCS_SAMPLES_DIR = new Path(
  import.meta.dir,
  "..",
  "..",
  "samples",
  "models",
  "output_module",
  "output_color_space",
);

describe("TestRenderQueueBasic", () => {
  /** Tests for basic render queue attributes. */

  test.each([
    ["empty", 0],
    ["numItems_1", 1],
    ["numItems_2", 2],
  ])("test_num_items[%#]", (sampleName: string, expectedCount: number) => {
    const expected = loadExpected(SAMPLES_DIR, sampleName);
    const project = parseProject(SAMPLES_DIR.div(`${sampleName}.aep`));
    expect(expected["renderQueue"]["numItems"]).toBe(expectedCount);
    expect(len(asInstance(project.renderQueue, RenderQueue).items)).toBe(expectedCount);
  });
});

describe("TestOutputModule", () => {
  /** Tests for output module attributes. */

  test("test_outputModule_file", () => {
    loadExpected(OM_SAMPLES_DIR, "file");
    const project = parseProject(OM_SAMPLES_DIR.div("file.aep"));
    const rqi = asInstance(project.renderQueue, RenderQueue).items[0];
    expect(len(rqi.outputModules) >= 1).toBe(true);
    const om = rqi.outputModules[0];
    expect(om instanceof OutputModule).toBe(true);
    expect(om.file != null).toBe(true);
  });

  test("test_outputModule_template", () => {
    loadExpected(OM_SAMPLES_DIR, "template");
    const project = parseProject(OM_SAMPLES_DIR.div("template.aep"));
    const rqi = asInstance(project.renderQueue, RenderQueue).items[0];
    expect(len(rqi.outputModules) >= 1).toBe(true);
    const om = rqi.outputModules[0];
    expect(om.name != null).toBe(true);
  });

  test("test_outputModule_no_hdrm_chunk", () => {
    /**
     * Files without hdrm chunk should still parse name/file_template/file
     * correctly (Utf8 chunks identified by position relative to Als2).
     */
    const project = parseProject(BUGS_DIR.div("outputmodule_path.aep"));
    const rqi = asInstance(project.renderQueue, RenderQueue).items[0];
    const om = rqi.outputModules[0];
    expect(om.name).toBe("H.264 - Match Render Settings - 15 Mbps");
    expect(contains(String(om.fileTemplate), "[compName]")).toBe(true);
    expect(contains(String(om.file), "[compName]")).toBe(false);
  });

  test("test_numOutputModules_2", () => {
    const expected = loadExpected(OM_SAMPLES_DIR, "numOutputModules_2");
    const project = parseProject(OM_SAMPLES_DIR.div("numOutputModules_2.aep"));
    const rqi = asInstance(project.renderQueue, RenderQueue).items[0];
    const expOms = expected["renderQueue"]["items"][0]["outputModules"];
    expect(len(rqi.outputModules)).toBe(len(expOms));
    expect(len(expOms)).toBe(2);
  });

  test("test_include_source_xmp_on", () => {
    const project = parseProject(OM_SAMPLES_DIR.div("om_misc.aep"));
    const rqi = getRqi(project, "include_source_xmp_data_on");
    const om = rqi.outputModules[0];
    expect(om.includeSourceXmp).toBe(true);
  });

  test("test_include_source_xmp_off", () => {
    const project = parseProject(OM_SAMPLES_DIR.div("include_source_xmp_data_off.aep"));
    const om = asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0];
    expect(om.includeSourceXmp).toBe(false);
  });

  test("test_crop_checked", () => {
    const project = parseProject(OM_SAMPLES_DIR.div("om_crop.aep"));
    const rqi = getRqi(project, "crop_checked");
    const om = rqi.outputModules[0];
    expect(om.settings.get("Crop")).toBe(true);
  });

  test("test_crop_unchecked", () => {
    const project = parseProject(OM_SAMPLES_DIR.div("crop_unchecked.aep"));
    const om = asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0];
    expect(om.settings.get("Crop")).toBe(false);
  });

  test("test_crop_bottom_10", () => {
    const expected = loadExpected(OM_SAMPLES_DIR, "crop_bottom_10");
    const project = parseProject(OM_SAMPLES_DIR.div("crop_bottom_10.aep"));
    const om = asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0];
    const expOm = expected["renderQueue"]["items"][0]["outputModules"][0];
    expect(om.settings.get("Crop")).toBe(true);
    expect(om.settings.get("Crop Bottom")).toBe(expOm["settings"]["Crop Bottom"]);
    expect(expOm["settings"]["Crop Bottom"]).toBe(10);
    expect(om.settings.get("Crop Top")).toBe(0);
  });

  test("test_crop_top_10", () => {
    const expected = loadExpected(OM_SAMPLES_DIR, "crop_top_10");
    const project = parseProject(OM_SAMPLES_DIR.div("crop_top_10.aep"));
    const om = asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0];
    const expOm = expected["renderQueue"]["items"][0]["outputModules"][0];
    expect(om.settings.get("Crop")).toBe(true);
    expect(om.settings.get("Crop Top")).toBe(expOm["settings"]["Crop Top"]);
    expect(expOm["settings"]["Crop Top"]).toBe(10);
    expect(om.settings.get("Crop Bottom")).toBe(0);
  });

  test.each([
    ["convert_to_linear_light_off", ConvertToLinearLight.OFF],
    ["convert_to_linear_light_on", ConvertToLinearLight.ON],
    ["convert_to_linear_light_on_for_32_bpc", ConvertToLinearLight.ON_FOR_32_BPC],
  ])("test_convert_to_linear_light[%#]", (sampleName: string, expectedValue: ConvertToLinearLight) => {
    const project = parseProject(OM_SAMPLES_DIR.div(`${sampleName}.aep`));
    const om = asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0];
    expect(om.settings.get("Convert to Linear Light")).toBe(expectedValue);
  });

  test.each([
    ["preserve_rgb_off", false],
    ["preserve_rgb_on", true],
  ])("test_preserve_rgb[%#]", (sampleName: string, expectedValue: boolean) => {
    // The two AE samples differ in one byte of the settings record, 0x5E.
    const project = parseProject(OM_SAMPLES_DIR.div(`${sampleName}.aep`));
    const om = asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0];
    expect(om.settings.get("Preserve RGB")).toBe(expectedValue);
  });
});

describe("TestRouuFrameRateAndDepth", () => {
  /**
   * `Rouu` holds the output frame rate as 16.16 fixed point at 0x42 and the
   * depth as a signed 2-byte value at 0x46.
   */

  test.each([
    ["frame_rate", 2, 29.97], // 00 1D F8 52
    ["skip_frames", 1, 15.0], // 00 0F 00 00
    ["skip_frames", 3, 7.5], // 00 07 80 00
  ])("test_frame_rate_and_depth[%#]", (sampleName: string, itemIndex: number, frameRate: number) => {
    const expected = loadExpected(SAMPLES_DIR, sampleName);
    const project = parseProject(SAMPLES_DIR.div(`${sampleName}.aep`));
    const om = asInstance(project.renderQueue, RenderQueue).items[itemIndex].outputModules[0];
    const expOm = expected["renderQueue"]["items"][itemIndex]["outputModules"][0];
    expect(approx(om._roou.frameRate, frameRate, { abs: 1e-4 })).toBe(true);
    expect(om._roou.depth).toBe(expOm["settings"]["Depth"]);
    expect(expOm["settings"]["Depth"]).toBe(24);
    expect(getOrThrow(om.getSettings(GetSettingsFormat.NUMBER), "Depth")).toBe(24);
  });
});

describe("TestCompLinking", () => {
  /** Tests for render queue item composition linking. */

  test("test_comp_name_matches", () => {
    const expected = loadExpected(SAMPLES_DIR, "render_settings");
    const project = parseProject(SAMPLES_DIR.div("render_settings.aep"));
    const rqi = getRqi(project, "base");
    const expRqi = (() => {
      for (const item of expected["renderQueue"]["items"]) {
        if (item["compName"] === "base") return item;
      }
      throw new StopIteration();
    })();
    expect(rqi.compName).toBe(expRqi["compName"]);
  });

  test("test_2_rqitems_comp_linking", () => {
    const expected = loadExpected(SAMPLES_DIR, "2_rqitems");
    const project = parseProject(SAMPLES_DIR.div("2_rqitems.aep"));
    expect(len(asInstance(project.renderQueue, RenderQueue).items)).toBe(2);
    for (const [i, rqi] of enumerate(asInstance(project.renderQueue, RenderQueue).items)) {
      const expName = expected["renderQueue"]["items"][i]["compName"];
      expect(rqi.compName).toBe(expName);
    }
  });
});

describe("TestRenderQueueItemAttributes", () => {
  /** Tests for render queue item attributes. */

  test("test_render_unchecked", () => {
    const expected = loadExpected(SAMPLES_DIR, "render_unchecked");
    const project = parseProject(SAMPLES_DIR.div("render_unchecked.aep"));
    const rqi = asInstance(project.renderQueue, RenderQueue).items[0];
    const expRqi = expected["renderQueue"]["items"][0];
    expect(rqi.render).toBe(false);
    expect(expRqi["render"]).toBe(false);
  });

  test("test_comment", () => {
    const project = parseProject(SAMPLES_DIR.div("comment_aaaaa.aep"));
    const rqi = asInstance(project.renderQueue, RenderQueue).items[0];
    expect(rqi.comment).toBe("aaaaa");
  });
});

describe("TestSkipFrames", () => {
  /**
   * skip_frames of a parsed project.
   *
   * The sample's items render at 30 fps ("Use this frame rate") and their
   * output modules store 30 / (n + 1) fps; its JSON was exported in the
   * session that set the skip. After Effects does not save the value: it
   * reads 0 for every item of a project it opens (`skip_frames_1.json`,
   * exported after reopening) and renders all frames whatever output rate
   * is stored (AE 2026, rendered), so a parsed item reads 0 too.
   */

  test.each([0, 1, 2, 3])("test_skip_frames[%#]", (n: number) => {
    const project = parseProject(SAMPLES_DIR.div("skip_frames.aep"));
    expect(getRqi(project, `skip_frames_${n}`).skipFrames).toBe(0);
  });
});

describe("TestOutputModuleSettings", () => {
  /** Tests for output module settings values. */

  test.each([
    ["starting_0", 0],
    ["starting_101", 101],
    ["starting_9999999", 9999999],
  ])("test_starting_number[%#]", (sampleName: string, expectedValue: number) => {
    const expected = loadExpected(SAMPLES_DIR, sampleName);
    const project = parseProject(SAMPLES_DIR.div(`${sampleName}.aep`));
    const om = asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0];
    const expOm = expected["renderQueue"]["items"][0]["outputModules"][0];
    expect(om.settings.get("Starting #")).toBe(expOm["settings"]["Starting #"]);
    expect(om.settings.get("Starting #")).toBe(expectedValue);
  });

  test.each([
    ["use_comp_frame_number_off", false],
    ["use_comp_frame_number_on", true],
  ])("test_use_comp_frame_number[%#]", (sampleName: string, expectedValue: boolean) => {
    const expected = loadExpected(SAMPLES_DIR, sampleName);
    const project = parseProject(SAMPLES_DIR.div(`${sampleName}.aep`));
    const om = asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0];
    const expOm = expected["renderQueue"]["items"][0]["outputModules"][0];
    expect(om.settings.get("Use Comp Frame Number")).toBe(expectedValue);
    expect(expOm["settings"]["Use Comp Frame Number"]).toBe(expectedValue);
  });
});

describe("TestOutputColorSpace", () => {
  /** Tests for OutputModule.outputColorSpace parsing. */

  test.each([
    ["srgb", "sRGB IEC61966-2.1"],
    ["adobe_rgb", "Adobe RGB (1998)"],
    ["acescg", "ACEScg ACES Working Space AMPAS S-2014-004"],
    ["acescct", "ACEScct"],
    ["aces_2065-1", "ACES Academy Color Encoding Specification SMPTE ST 2065-1"],
    ["prophoto_rgb", "ProPhoto RGB"],
    ["cie_rgb", "CIE RGB"],
    ["colormatch_rgb", "ColorMatch RGB"],
    ["apple_rgb", "Apple RGB"],
    ["image_p3", "image P3"],
    ["arri_logc3_800", "ARRI LogC3 Wide Color Gamut - EI 800"],
    ["canon_cinema_clog2", "Canon Cinema CLog2"],
    ["arriflex_daylight", "ARRIFLEX D-20 Daylight Log (by Adobe)"],
  ])("test_output_color_space[%#]", (sampleName: string, expectedValue: string) => {
    const project = parseProject(OCS_SAMPLES_DIR.div(`${sampleName}.aep`));
    const om = asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0];
    expect(om.outputColorSpace).toBe(expectedValue);
  });

  test("test_output_color_space_working", () => {
    /** Working Color Space should resolve to the project's working space. */
    const project = parseProject(OCS_SAMPLES_DIR.div("working_color_space.aep"));
    const om = asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0];
    expect(om.outputColorSpace).toBe(project.workingSpace);
  });
});

describe("TestGetSettings", () => {
  /** Tests for RenderQueueItem.getSettings/get_setting and OutputModule.getSettings/get_setting. */

  test("test_rqi_get_settings_string", () => {
    /** get_settings(STRING) returns all string values. */
    const project = parseProject(SAMPLES_DIR.div("render_settings.aep"));
    const rqi = getRqi(project, "base");
    const result = rqi.getSettings(GetSettingsFormat.STRING);
    expect(result instanceof Map).toBe(true);
    expect([...result.values()].every((v) => typeof v === "string")).toBe(true);
  });

  test("test_rqi_get_settings_number", () => {
    /** get_settings(NUMBER) returns numeric values. */
    const project = parseProject(SAMPLES_DIR.div("render_settings.aep"));
    const rqi = getRqi(project, "base");
    const result = rqi.getSettings(GetSettingsFormat.NUMBER);
    expect(result instanceof Map).toBe(true);
    expect(len(result) > 0).toBe(true);
  });

  test("test_rqi_get_settings_default_is_string", () => {
    /** get_settings() defaults to STRING format. */
    const project = parseProject(SAMPLES_DIR.div("render_settings.aep"));
    const rqi = getRqi(project, "base");
    const defaultResult = rqi.getSettings();
    const stringResult = rqi.getSettings(GetSettingsFormat.STRING);
    expect(valueEquals(defaultResult, stringResult)).toBe(true);
  });

  test("test_rqi_get_setting_string", () => {
    /** get_setting returns a single string value. */
    const project = parseProject(SAMPLES_DIR.div("render_settings.aep"));
    const rqi = getRqi(project, "base");
    const result = rqi.getSetting("Quality");
    expect(typeof result === "string").toBe(true);
  });

  test("test_rqi_get_setting_number", () => {
    /** get_setting with NUMBER format returns the numeric value. */
    const project = parseProject(SAMPLES_DIR.div("render_settings.aep"));
    const rqi = getRqi(project, "base");
    const result = rqi.getSetting("Quality", GetSettingsFormat.NUMBER);
    expect(typeof result === "number" || typeof result === "boolean").toBe(true); // bool is an int in Python
  });

  test("test_rqi_get_setting_invalid_key", () => {
    /** get_setting with unknown key raises KeyError. */
    const project = parseProject(SAMPLES_DIR.div("render_settings.aep"));
    const rqi = getRqi(project, "base");
    raises(KeyError, () => {
      rqi.getSetting("NonExistentKey12345");
    });
  });

  test("test_rqi_get_settings_invalid_format", () => {
    /** get_settings with invalid format raises ValueError. */
    const project = parseProject(SAMPLES_DIR.div("render_settings.aep"));
    const rqi = getRqi(project, "base");
    raises(ValueError, () => {
      // @ts-expect-error intentionally invalid format
      rqi.getSettings(9999);
    });
  });

  test("test_om_get_settings_string", () => {
    /** get_settings(STRING) returns string values (except nested dicts). */
    const project = parseProject(SAMPLES_DIR.div("render_settings.aep"));
    const rqi = getRqi(project, "base");
    const om = rqi.outputModules[0];
    const result = om.getSettings(GetSettingsFormat.STRING);
    expect(result instanceof Map).toBe(true);
    // All values are strings except 'Output File Info' which is a dict
    for (const [key, val] of result.entries()) {
      if (key !== "Output File Info") {
        expect(typeof val === "string" ? "" : `${key} is ${typeof val}, expected str`).toBe("");
      }
    }
  });

  test("test_om_get_settings_number", () => {
    /** OutputModule.getSettings(NUMBER) returns numeric values. */
    const project = parseProject(SAMPLES_DIR.div("render_settings.aep"));
    const rqi = getRqi(project, "base");
    const om = rqi.outputModules[0];
    const result = om.getSettings(GetSettingsFormat.NUMBER);
    expect(result instanceof Map).toBe(true);
    expect(len(result) > 0).toBe(true);
  });

  test("test_om_get_setting_string", () => {
    /** OutputModule.getSetting returns a single string value. */
    const project = parseProject(SAMPLES_DIR.div("render_settings.aep"));
    const rqi = getRqi(project, "base");
    const om = rqi.outputModules[0];
    const result = om.getSetting("Channels");
    expect(typeof result === "string").toBe(true);
  });

  test("test_om_get_setting_number", () => {
    /** OutputModule.getSetting with NUMBER format. */
    const project = parseProject(SAMPLES_DIR.div("render_settings.aep"));
    const rqi = getRqi(project, "base");
    const om = rqi.outputModules[0];
    const result = om.getSetting("Channels", GetSettingsFormat.NUMBER);
    expect(typeof result === "number" || typeof result === "boolean").toBe(true); // bool is an int in Python
  });

  test("test_om_get_setting_invalid_key", () => {
    /** OutputModule.getSetting with unknown key raises KeyError. */
    const project = parseProject(SAMPLES_DIR.div("render_settings.aep"));
    const rqi = getRqi(project, "base");
    const om = rqi.outputModules[0];
    raises(KeyError, () => {
      om.getSetting("NonExistentKey12345");
    });
  });

  test("test_om_get_settings_invalid_format", () => {
    /** OutputModule.getSettings with invalid format raises ValueError. */
    const project = parseProject(SAMPLES_DIR.div("render_settings.aep"));
    const rqi = getRqi(project, "base");
    const om = rqi.outputModules[0];
    raises(ValueError, () => {
      // @ts-expect-error intentionally invalid format
      om.getSettings(9999);
    });
  });
});
