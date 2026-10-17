/** Tests for RenderQueue model parsing. */

// `from __future__ import annotations` is dropped: no annotation here is
// evaluated at runtime. `os.getenv` becomes `process.env` (None → null), and
// `pytest.mark.parametrize` becomes `test.each` (see src/pyrt/pytest.ts). The
// Python package registers every chunk type on import, so the TS test imports
// `_register.ts` to do the same.

import { describe, expect, test } from "bun:test";
import { approx, raises } from "../../src/pyrt/pytest.ts";
import { Path, contains, enumerate, getitem, KeyError, len, py_eq, ValueError } from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { get_rqi, load_expected, parse_project } from "../conftest.ts";
import { ConvertToLinearLight, GetSettingsFormat } from "../../src/py_aep/enums/index.ts";
import { OutputModule, RenderQueue } from "../../src/py_aep/models/renderqueue/index.ts";
import { as_instance } from "../helpers.ts";

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
  ])("test_num_items[%#]", (sample_name: string, expected_count: number) => {
    const expected = load_expected(SAMPLES_DIR, sample_name);
    const project = parse_project(SAMPLES_DIR.div(`${sample_name}.aep`));
    expect(expected["renderQueue"]["numItems"]).toBe(expected_count);
    expect(len(as_instance(project.render_queue, RenderQueue).items)).toBe(expected_count);
  });
});

describe("TestOutputModule", () => {
  /** Tests for output module attributes. */

  test("test_outputModule_file", () => {
    load_expected(OM_SAMPLES_DIR, "file");
    const project = parse_project(OM_SAMPLES_DIR.div("file.aep"));
    const rqi = as_instance(project.render_queue, RenderQueue).items[0];
    expect(len(rqi.output_modules) >= 1).toBe(true);
    const om = rqi.output_modules[0];
    expect(om instanceof OutputModule).toBe(true);
    expect(om.file != null).toBe(true);
  });

  test("test_outputModule_template", () => {
    load_expected(OM_SAMPLES_DIR, "template");
    const project = parse_project(OM_SAMPLES_DIR.div("template.aep"));
    const rqi = as_instance(project.render_queue, RenderQueue).items[0];
    expect(len(rqi.output_modules) >= 1).toBe(true);
    const om = rqi.output_modules[0];
    expect(om.name != null).toBe(true);
  });

  test("test_outputModule_no_hdrm_chunk", () => {
    /**
     * Files without hdrm chunk should still parse name/file_template/file
     * correctly (Utf8 chunks identified by position relative to Als2).
     */
    const project = parse_project(BUGS_DIR.div("outputmodule_path.aep"));
    const rqi = as_instance(project.render_queue, RenderQueue).items[0];
    const om = rqi.output_modules[0];
    expect(om.name).toBe("H.264 - Match Render Settings - 15 Mbps");
    expect(contains(String(om.file_template), "[compName]")).toBe(true);
    expect(contains(String(om.file), "[compName]")).toBe(false);
  });

  test("test_numOutputModules_2", () => {
    const expected = load_expected(OM_SAMPLES_DIR, "numOutputModules_2");
    const project = parse_project(OM_SAMPLES_DIR.div("numOutputModules_2.aep"));
    const rqi = as_instance(project.render_queue, RenderQueue).items[0];
    const exp_oms = expected["renderQueue"]["items"][0]["outputModules"];
    expect(len(rqi.output_modules)).toBe(len(exp_oms));
    expect(len(exp_oms)).toBe(2);
  });

  test("test_include_source_xmp_on", () => {
    const project = parse_project(OM_SAMPLES_DIR.div("om_misc.aep"));
    const rqi = get_rqi(project, "include_source_xmp_data_on");
    const om = rqi.output_modules[0];
    expect(om.include_source_xmp).toBe(true);
  });

  test("test_include_source_xmp_off", () => {
    const project = parse_project(OM_SAMPLES_DIR.div("include_source_xmp_data_off.aep"));
    const om = as_instance(project.render_queue, RenderQueue).items[0].output_modules[0];
    expect(om.include_source_xmp).toBe(false);
  });

  test("test_crop_checked", () => {
    const project = parse_project(OM_SAMPLES_DIR.div("om_crop.aep"));
    const rqi = get_rqi(project, "crop_checked");
    const om = rqi.output_modules[0];
    expect(om.settings.__getitem__("Crop")).toBe(true);
  });

  test("test_crop_unchecked", () => {
    const project = parse_project(OM_SAMPLES_DIR.div("crop_unchecked.aep"));
    const om = as_instance(project.render_queue, RenderQueue).items[0].output_modules[0];
    expect(om.settings.__getitem__("Crop")).toBe(false);
  });

  test("test_crop_bottom_10", () => {
    const expected = load_expected(OM_SAMPLES_DIR, "crop_bottom_10");
    const project = parse_project(OM_SAMPLES_DIR.div("crop_bottom_10.aep"));
    const om = as_instance(project.render_queue, RenderQueue).items[0].output_modules[0];
    const exp_om = expected["renderQueue"]["items"][0]["outputModules"][0];
    expect(om.settings.__getitem__("Crop")).toBe(true);
    expect(om.settings.__getitem__("Crop Bottom")).toBe(exp_om["settings"]["Crop Bottom"]);
    expect(exp_om["settings"]["Crop Bottom"]).toBe(10);
    expect(om.settings.__getitem__("Crop Top")).toBe(0);
  });

  test("test_crop_top_10", () => {
    const expected = load_expected(OM_SAMPLES_DIR, "crop_top_10");
    const project = parse_project(OM_SAMPLES_DIR.div("crop_top_10.aep"));
    const om = as_instance(project.render_queue, RenderQueue).items[0].output_modules[0];
    const exp_om = expected["renderQueue"]["items"][0]["outputModules"][0];
    expect(om.settings.__getitem__("Crop")).toBe(true);
    expect(om.settings.__getitem__("Crop Top")).toBe(exp_om["settings"]["Crop Top"]);
    expect(exp_om["settings"]["Crop Top"]).toBe(10);
    expect(om.settings.__getitem__("Crop Bottom")).toBe(0);
  });

  test.each([
    ["convert_to_linear_light_off", ConvertToLinearLight.OFF],
    ["convert_to_linear_light_on", ConvertToLinearLight.ON],
    ["convert_to_linear_light_on_for_32_bpc", ConvertToLinearLight.ON_FOR_32_BPC],
  ])("test_convert_to_linear_light[%#]", (sample_name: string, expected_value: ConvertToLinearLight) => {
    const project = parse_project(OM_SAMPLES_DIR.div(`${sample_name}.aep`));
    const om = as_instance(project.render_queue, RenderQueue).items[0].output_modules[0];
    expect(om.settings.__getitem__("Convert to Linear Light")).toBe(expected_value);
  });

  test.each([
    ["preserve_rgb_off", false],
    ["preserve_rgb_on", true],
  ])("test_preserve_rgb[%#]", (sample_name: string, expected_value: boolean) => {
    // The two AE samples differ in one byte of the settings record, 0x5E.
    const project = parse_project(OM_SAMPLES_DIR.div(`${sample_name}.aep`));
    const om = as_instance(project.render_queue, RenderQueue).items[0].output_modules[0];
    expect(om.settings.__getitem__("Preserve RGB")).toBe(expected_value);
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
  ])("test_frame_rate_and_depth[%#]", (sample_name: string, item_index: number, frame_rate: number) => {
    const expected = load_expected(SAMPLES_DIR, sample_name);
    const project = parse_project(SAMPLES_DIR.div(`${sample_name}.aep`));
    const om = as_instance(project.render_queue, RenderQueue).items[item_index].output_modules[0];
    const exp_om = expected["renderQueue"]["items"][item_index]["outputModules"][0];
    expect(approx(om._roou.frame_rate, frame_rate, { abs: 1e-4 })).toBe(true);
    expect(om._roou.depth).toBe(exp_om["settings"]["Depth"]);
    expect(exp_om["settings"]["Depth"]).toBe(24);
    expect(getitem(om.get_settings(GetSettingsFormat.NUMBER), "Depth")).toBe(24);
  });
});

describe("TestCompLinking", () => {
  /** Tests for render queue item composition linking. */

  test("test_comp_name_matches", () => {
    const expected = load_expected(SAMPLES_DIR, "render_settings");
    const project = parse_project(SAMPLES_DIR.div("render_settings.aep"));
    const rqi = get_rqi(project, "base");
    const exp_rqi = expected["renderQueue"]["items"].find((item: any) => item["compName"] === "base");
    expect(rqi.comp_name).toBe(exp_rqi["compName"]);
  });

  test("test_2_rqitems_comp_linking", () => {
    const expected = load_expected(SAMPLES_DIR, "2_rqitems");
    const project = parse_project(SAMPLES_DIR.div("2_rqitems.aep"));
    expect(len(as_instance(project.render_queue, RenderQueue).items)).toBe(2);
    for (const [i, rqi] of enumerate(as_instance(project.render_queue, RenderQueue).items)) {
      const exp_name = expected["renderQueue"]["items"][i]["compName"];
      expect(rqi.comp_name).toBe(exp_name);
    }
  });
});

describe("TestRenderQueueItemAttributes", () => {
  /** Tests for render queue item attributes. */

  test("test_render_unchecked", () => {
    const expected = load_expected(SAMPLES_DIR, "render_unchecked");
    const project = parse_project(SAMPLES_DIR.div("render_unchecked.aep"));
    const rqi = as_instance(project.render_queue, RenderQueue).items[0];
    const exp_rqi = expected["renderQueue"]["items"][0];
    expect(rqi.render).toBe(false);
    expect(exp_rqi["render"]).toBe(false);
  });

  test("test_comment", () => {
    const project = parse_project(SAMPLES_DIR.div("comment_aaaaa.aep"));
    const rqi = as_instance(project.render_queue, RenderQueue).items[0];
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
    const project = parse_project(SAMPLES_DIR.div("skip_frames.aep"));
    expect(get_rqi(project, `skip_frames_${n}`).skip_frames).toBe(0);
  });
});

describe("TestOutputModuleSettings", () => {
  /** Tests for output module settings values. */

  test.each([
    ["starting_0", 0],
    ["starting_101", 101],
    ["starting_9999999", 9999999],
  ])("test_starting_number[%#]", (sample_name: string, expected_value: number) => {
    const expected = load_expected(SAMPLES_DIR, sample_name);
    const project = parse_project(SAMPLES_DIR.div(`${sample_name}.aep`));
    const om = as_instance(project.render_queue, RenderQueue).items[0].output_modules[0];
    const exp_om = expected["renderQueue"]["items"][0]["outputModules"][0];
    expect(om.settings.__getitem__("Starting #")).toBe(exp_om["settings"]["Starting #"]);
    expect(om.settings.__getitem__("Starting #")).toBe(expected_value);
  });

  test.each([
    ["use_comp_frame_number_off", false],
    ["use_comp_frame_number_on", true],
  ])("test_use_comp_frame_number[%#]", (sample_name: string, expected_value: boolean) => {
    const expected = load_expected(SAMPLES_DIR, sample_name);
    const project = parse_project(SAMPLES_DIR.div(`${sample_name}.aep`));
    const om = as_instance(project.render_queue, RenderQueue).items[0].output_modules[0];
    const exp_om = expected["renderQueue"]["items"][0]["outputModules"][0];
    expect(om.settings.__getitem__("Use Comp Frame Number")).toBe(expected_value);
    expect(exp_om["settings"]["Use Comp Frame Number"]).toBe(expected_value);
  });
});

describe("TestOutputColorSpace", () => {
  /** Tests for OutputModule.output_color_space parsing. */

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
  ])("test_output_color_space[%#]", (sample_name: string, expected_value: string) => {
    const project = parse_project(OCS_SAMPLES_DIR.div(`${sample_name}.aep`));
    const om = as_instance(project.render_queue, RenderQueue).items[0].output_modules[0];
    expect(om.output_color_space).toBe(expected_value);
  });

  test("test_output_color_space_working", () => {
    /** Working Color Space should resolve to the project's working space. */
    const project = parse_project(OCS_SAMPLES_DIR.div("working_color_space.aep"));
    const om = as_instance(project.render_queue, RenderQueue).items[0].output_modules[0];
    expect(om.output_color_space).toBe(project.working_space);
  });
});

describe("TestGetSettings", () => {
  /** Tests for RenderQueueItem.get_settings/get_setting and OutputModule.get_settings/get_setting. */

  test("test_rqi_get_settings_string", () => {
    /** get_settings(STRING) returns all string values. */
    const project = parse_project(SAMPLES_DIR.div("render_settings.aep"));
    const rqi = get_rqi(project, "base");
    const result = rqi.get_settings(GetSettingsFormat.STRING);
    expect(result instanceof Map).toBe(true);
    expect([...result.values()].every((v) => typeof v === "string")).toBe(true);
  });

  test("test_rqi_get_settings_number", () => {
    /** get_settings(NUMBER) returns numeric values. */
    const project = parse_project(SAMPLES_DIR.div("render_settings.aep"));
    const rqi = get_rqi(project, "base");
    const result = rqi.get_settings(GetSettingsFormat.NUMBER);
    expect(result instanceof Map).toBe(true);
    expect(len(result) > 0).toBe(true);
  });

  test("test_rqi_get_settings_default_is_string", () => {
    /** get_settings() defaults to STRING format. */
    const project = parse_project(SAMPLES_DIR.div("render_settings.aep"));
    const rqi = get_rqi(project, "base");
    const default_result = rqi.get_settings();
    const string_result = rqi.get_settings(GetSettingsFormat.STRING);
    expect(py_eq(default_result, string_result)).toBe(true);
  });

  test("test_rqi_get_setting_string", () => {
    /** get_setting returns a single string value. */
    const project = parse_project(SAMPLES_DIR.div("render_settings.aep"));
    const rqi = get_rqi(project, "base");
    const result = rqi.get_setting("Quality");
    expect(typeof result === "string").toBe(true);
  });

  test("test_rqi_get_setting_number", () => {
    /** get_setting with NUMBER format returns the numeric value. */
    const project = parse_project(SAMPLES_DIR.div("render_settings.aep"));
    const rqi = get_rqi(project, "base");
    const result = rqi.get_setting("Quality", GetSettingsFormat.NUMBER);
    expect(typeof result === "number" || typeof result === "boolean").toBe(true); // bool is an int in Python
  });

  test("test_rqi_get_setting_invalid_key", () => {
    /** get_setting with unknown key raises KeyError. */
    const project = parse_project(SAMPLES_DIR.div("render_settings.aep"));
    const rqi = get_rqi(project, "base");
    raises(KeyError, () => {
      rqi.get_setting("NonExistentKey12345");
    });
  });

  test("test_rqi_get_settings_invalid_format", () => {
    /** get_settings with invalid format raises ValueError. */
    const project = parse_project(SAMPLES_DIR.div("render_settings.aep"));
    const rqi = get_rqi(project, "base");
    raises(ValueError, () => {
      rqi.get_settings(9999 as any); // intentionally invalid format
    });
  });

  test("test_om_get_settings_string", () => {
    /** get_settings(STRING) returns string values (except nested dicts). */
    const project = parse_project(SAMPLES_DIR.div("render_settings.aep"));
    const rqi = get_rqi(project, "base");
    const om = rqi.output_modules[0];
    const result = om.get_settings(GetSettingsFormat.STRING);
    expect(result instanceof Map).toBe(true);
    // All values are strings except 'Output File Info' which is a dict
    for (const [key, val] of result.entries()) {
      if (key !== "Output File Info") {
        expect(typeof val === "string" ? "" : `${key} is ${typeof val}, expected str`).toBe("");
      }
    }
  });

  test("test_om_get_settings_number", () => {
    /** OutputModule.get_settings(NUMBER) returns numeric values. */
    const project = parse_project(SAMPLES_DIR.div("render_settings.aep"));
    const rqi = get_rqi(project, "base");
    const om = rqi.output_modules[0];
    const result = om.get_settings(GetSettingsFormat.NUMBER);
    expect(result instanceof Map).toBe(true);
    expect(len(result) > 0).toBe(true);
  });

  test("test_om_get_setting_string", () => {
    /** OutputModule.get_setting returns a single string value. */
    const project = parse_project(SAMPLES_DIR.div("render_settings.aep"));
    const rqi = get_rqi(project, "base");
    const om = rqi.output_modules[0];
    const result = om.get_setting("Channels");
    expect(typeof result === "string").toBe(true);
  });

  test("test_om_get_setting_number", () => {
    /** OutputModule.get_setting with NUMBER format. */
    const project = parse_project(SAMPLES_DIR.div("render_settings.aep"));
    const rqi = get_rqi(project, "base");
    const om = rqi.output_modules[0];
    const result = om.get_setting("Channels", GetSettingsFormat.NUMBER);
    expect(typeof result === "number" || typeof result === "boolean").toBe(true); // bool is an int in Python
  });

  test("test_om_get_setting_invalid_key", () => {
    /** OutputModule.get_setting with unknown key raises KeyError. */
    const project = parse_project(SAMPLES_DIR.div("render_settings.aep"));
    const rqi = get_rqi(project, "base");
    const om = rqi.output_modules[0];
    raises(KeyError, () => {
      om.get_setting("NonExistentKey12345");
    });
  });

  test("test_om_get_settings_invalid_format", () => {
    /** OutputModule.get_settings with invalid format raises ValueError. */
    const project = parse_project(SAMPLES_DIR.div("render_settings.aep"));
    const rqi = get_rqi(project, "base");
    const om = rqi.output_modules[0];
    raises(ValueError, () => {
      om.get_settings(9999 as any); // intentionally invalid format
    });
  });
});
