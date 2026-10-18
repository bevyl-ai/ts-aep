/** Tests for render queue settings parsing. */

// `from __future__ import annotations` is dropped: no annotation here is
// evaluated at runtime. `pytest.mark.parametrize` becomes `test.each` (see
// src/pyrt/pytest.ts). The Python package registers every chunk type on import,
// so the TS test imports `_register.ts` to do the same.

import { describe, expect, test } from "bun:test";
import { Path, getitem, int, py_bool, py_eq, zip } from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { load_expected, parse_project } from "../conftest.ts";
import { as_instance } from "../helpers.ts";
import { PostRenderAction } from "../../src/py_aep/enums/index.ts";
import { RenderQueue } from "../../src/py_aep/models/renderqueue/render_queue.ts";

const SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models", "renderqueue");
const OM_SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models", "output_module");

describe("TestRenderSettings", () => {
  /** Tests for render settings parsing as dict. */

  test("test_base_settings", () => {
    /** Test base render settings template. */
    const project = parse_project(SAMPLES_DIR.div("base.aep"));
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(rs != null).toBe(true);
    expect(rs.get("Quality")).toBe(2); // Best
    expect(py_eq(rs.get("Resolution"), [1, 1])).toBe(true); // Full
    expect(rs.get("Frame Rate")).toBe(0);
    expect(rs.get("3:2 Pulldown")).toBe(0); // Off
  });

  test("test_quality_draft", () => {
    /** Test draft quality setting. */
    const project = parse_project(SAMPLES_DIR.div("custom_quality_draft.aep"));
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(rs.get("Quality")).toBe(1); // Draft
  });

  test("test_quality_wireframe", () => {
    /** Test wireframe quality setting. */
    const project = parse_project(SAMPLES_DIR.div("custom_quality_wireframe.aep"));
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(rs.get("Quality")).toBe(0); // Wireframe
  });

  test("test_resolution_half", () => {
    /** Test half resolution setting. */
    const project = parse_project(SAMPLES_DIR.div("custom_resolution_half.aep"));
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(py_eq(rs.get("Resolution"), [2, 2])).toBe(true); // Half
  });

  test("test_resolution_third", () => {
    /** Test third resolution setting. */
    const project = parse_project(SAMPLES_DIR.div("custom_resolution_third.aep"));
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(py_eq(rs.get("Resolution"), [3, 3])).toBe(true); // Third
  });

  test("test_resolution_quarter", () => {
    /** Test quarter resolution setting. */
    const project = parse_project(SAMPLES_DIR.div("custom_resolution_quarter.aep"));
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(py_eq(rs.get("Resolution"), [4, 4])).toBe(true); // Quarter
  });

  test("test_resolution_custom", () => {
    /** Test custom resolution setting. */
    const project = parse_project(
      SAMPLES_DIR.div("custom_resolution_custom_7_horizontal_3_vertical.aep"),
    );
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(py_eq(rs.get("Resolution"), [7, 3])).toBe(true); // Custom 7x3
  });

  test("test_color_depth_8bit", () => {
    /** Test 8-bit color depth setting. */
    const project = parse_project(SAMPLES_DIR.div("color_depth_8.aep"));
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(rs.get("Color Depth")).toBe(0); // 8-bit
  });

  test("test_color_depth_16bit", () => {
    /** Test 16-bit color depth setting. */
    const project = parse_project(SAMPLES_DIR.div("color_depth_16.aep"));
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(rs.get("Color Depth")).toBe(1); // 16-bit
  });

  test("test_color_depth_32bit", () => {
    /** Test 32-bit color depth setting. */
    const project = parse_project(SAMPLES_DIR.div("color_depth_32.aep"));
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(rs.get("Color Depth")).toBe(2); // 32-bit
  });

  test("test_field_render_lower_first", () => {
    /** Test lower field first setting. */
    const project = parse_project(SAMPLES_DIR.div("field_render_lower_field_first.aep"));
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(rs.get("Field Render")).toBe(2); // Lower Field First
  });

  test("test_field_render_upper_first", () => {
    /** Test upper field first setting. */
    const project = parse_project(SAMPLES_DIR.div("field_render_upper_field_first.aep"));
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(rs.get("Field Render")).toBe(1); // Upper Field First
  });

  test("test_pulldown_wssww", () => {
    /** Test 3:2 pulldown WSSWW setting. */
    const project = parse_project(
      SAMPLES_DIR.div("field_render_upper_field_first_pulldown_wssww.aep"),
    );
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(rs.get("3:2 Pulldown")).toBe(1); // WSSWW
  });

  test("test_pulldown_sswww", () => {
    /** Test 3:2 pulldown SSWWW setting. */
    const project = parse_project(
      SAMPLES_DIR.div("field_render_upper_field_first_pulldown_sswww.aep"),
    );
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(rs.get("3:2 Pulldown")).toBe(2); // SSWWW
  });

  test("test_pulldown_swwws", () => {
    /** Test 3:2 pulldown SWWWS setting. */
    const project = parse_project(
      SAMPLES_DIR.div("field_render_upper_field_first_pulldown_swwws.aep"),
    );
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(rs.get("3:2 Pulldown")).toBe(3); // SWWWS
  });

  test("test_pulldown_wwwss", () => {
    /** Test 3:2 pulldown WWWSS setting. */
    const project = parse_project(
      SAMPLES_DIR.div("field_render_upper_field_first_pulldown_wwwss.aep"),
    );
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(rs.get("3:2 Pulldown")).toBe(4); // WWWSS
  });

  test("test_pulldown_wwssw", () => {
    /** Test 3:2 pulldown WWSSW setting. */
    const project = parse_project(
      SAMPLES_DIR.div("field_render_upper_field_first_pulldown_wwssw.aep"),
    );
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(rs.get("3:2 Pulldown")).toBe(5); // WWSSW
  });

  test("test_frame_blending_current", () => {
    /** Test frame blending current settings. */
    const project = parse_project(SAMPLES_DIR.div("frame_blending_current.aep"));
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(rs.get("Frame Blending")).toBe(2); // Current Settings
  });

  test("test_frame_blending_off", () => {
    /** Test frame blending off for all layers. */
    const project = parse_project(SAMPLES_DIR.div("frame_blending_off_for_all_layers.aep"));
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(rs.get("Frame Blending")).toBe(0); // Off for All Layers
  });

  test("test_motion_blur_current", () => {
    /** Test motion blur current settings. */
    const project = parse_project(SAMPLES_DIR.div("motion_blur_current.aep"));
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(rs.get("Motion Blur")).toBe(2); // Current Settings
  });

  test("test_motion_blur_off", () => {
    /** Test motion blur off for all layers. */
    const project = parse_project(SAMPLES_DIR.div("motion_blur_off_for_all_layers.aep"));
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(rs.get("Motion Blur")).toBe(0); // Off for All Layers
  });

  test("test_use_this_frame_rate_24", () => {
    /** Test custom frame rate 24fps. */
    const project = parse_project(SAMPLES_DIR.div("use_this_frame_rate_24.aep"));
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(py_bool(rs.get("Frame Rate"))).toBe(true);
    expect(rs.get("Use this frame rate")).toBe(24.0);
  });

  test("test_use_this_frame_rate_30", () => {
    /** Test custom frame rate 30fps. */
    const project = parse_project(SAMPLES_DIR.div("use_this_frame_rate_30.aep"));
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(py_bool(rs.get("Frame Rate"))).toBe(true);
    expect(rs.get("Use this frame rate")).toBe(30.0);
  });

  test("test_proxy_use_all_proxies", () => {
    /** Test use all proxies setting. */
    const project = parse_project(SAMPLES_DIR.div("custom_proxy_use_use_all_proxies.aep"));
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(rs.get("Proxy Use")).toBe(1); // Use All Proxies
  });

  test("test_proxy_use_comp_proxies_only", () => {
    /** Test use comp proxies only setting. */
    const project = parse_project(
      SAMPLES_DIR.div("custom_proxy_use_use_comp_proxies_only.aep"),
    );
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(rs.get("Proxy Use")).toBe(3); // Use Comp Proxies Only
  });

  test("test_effects_all_on", () => {
    /** Test effects all on setting. */
    const project = parse_project(SAMPLES_DIR.div("custom_effects_all_on.aep"));
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(rs.get("Effects")).toBe(1); // All On
  });

  test("test_effects_all_off", () => {
    /** Test effects all off setting. */
    const project = parse_project(SAMPLES_DIR.div("custom_effects_all_off.aep"));
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(rs.get("Effects")).toBe(0); // All Off
  });

  test("test_solo_switches_all_off", () => {
    /** Test solo switches all off setting. */
    const project = parse_project(SAMPLES_DIR.div("custom_solo_switches_all_off.aep"));
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(rs.get("Solo Switches")).toBe(0); // All Off
  });

  test("test_guide_layers_current", () => {
    /** Test guide layers current settings. */
    const project = parse_project(SAMPLES_DIR.div("guide_layers_current.aep"));
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(rs.get("Guide Layers")).toBe(2); // Current Settings
  });

  test("test_disk_cache_read_only", () => {
    /** Test disk cache read only (default). */
    const project = parse_project(SAMPLES_DIR.div("custom.aep"));
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(rs.get("Disk Cache")).toBe(0); // Read Only
  });

  test("test_disk_cache_current_settings", () => {
    /** Test disk cache current settings. */
    const project = parse_project(SAMPLES_DIR.div("custom_disk_cache_current.aep"));
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(rs.get("Disk Cache")).toBe(2); // Current Settings
  });

  test("test_time_span_length_of_comp", () => {
    /** Test time span length of comp. */
    const project = parse_project(SAMPLES_DIR.div("time_span_length_of_comp.aep"));
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(rs.get("Time Span")).toBe(0); // Length of Comp
  });

  test("test_time_span_start_zero", () => {
    /** Test time span start of zero. */
    const project = parse_project(
      SAMPLES_DIR.div("time_span_custom_start_00_duration_24s13f.aep"),
    );
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(rs.get("Time Span Start")).toBe(0.0);
  });

  test("test_time_span_start_custom", () => {
    /** Test custom time span start (1s 23f at 24fps). */
    const project = parse_project(
      SAMPLES_DIR.div("time_span_custom_start_01s_23f_duration_24s13f.aep"),
    );
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    // 1s + 23 frames at 24fps = 1 + 23/24 = 1.9583... seconds
    expect(Math.abs(rs.get("Time Span Start") - (1 + 23 / 24)) < 0.0001).toBe(true);
  });

  test("test_time_span_duration", () => {
    /** Test time span duration (24s 13f at 24fps). */
    const project = parse_project(
      SAMPLES_DIR.div("time_span_custom_start_00_duration_24s13f.aep"),
    );
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    // 24s + 13 frames at 24fps = 24 + 13/24 = 24.5416... seconds
    expect(Math.abs(rs.get("Time Span Duration") - (24 + 13 / 24)) < 0.0001).toBe(true);
  });

  test("test_time_span_duration_30s", () => {
    /** Test time span duration of 719 frames at 24fps. */
    const project = parse_project(
      SAMPLES_DIR.div("time_span_custom_start_01_duration_29.9583s.aep"),
    );
    const rs = as_instance(project.renderQueue, RenderQueue).items[0].settings;

    expect(Math.abs(rs.get("Time Span Duration") - 29.9583333333333) < 0.0001).toBe(true);
  });
});

describe("TestOutputModuleSettings", () => {
  /** Tests for OutputModuleSettings parsing. */

  test("test_base_output_module", () => {
    /** Test base output module settings. */
    const project = parse_project(SAMPLES_DIR.div("base.aep"));
    const om = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0];

    expect(om.settings != null).toBe(true);
    expect(om.settings.get("Audio Channels")).toBe(2); // Stereo
    expect(om.settings.get("Audio Bit Depth")).toBe(2); // 16-bit
    expect(om.settings.get("Audio Sample Rate")).toBe(48000);
    expect(om.settings.get("Channels")).toBe(0); // RGB
    expect(om.settings.get("Depth")).toBe(24); // Millions of Colors (8 bpc)
    expect(om.settings.get("Format")).toBe(3); // H.264
    expect(om.settings.get("Color")).toBe(1); // Premultiplied
    expect(om.settings.get("Include Project Link")).toBe(true);
    expect(om.settings.get("Lock Aspect Ratio")).toBe(true);
    expect(om.settings.get("Resize")).toBe(false);
    expect(om.settings.get("Resize Quality")).toBe(1); // High
    expect(om.settings.get("Starting #")).toBe(0);
    expect(om.settings.get("Use Comp Frame Number")).toBe(true);
  });

  test.each([
    ["audio_output_off.aep", 1],
    ["audio_output_on.aep", 2],
    ["audio_output_auto.aep", 3],
  ])("test_audio_output[%#]", (filename: string, expected_output_audio: number) => {
    /** Test audio output settings. */
    const project = parse_project(OM_SAMPLES_DIR.div(filename));
    const settings = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0].settings;

    expect<number>(settings.get("Output Audio")).toBe(expected_output_audio);
  });

  test("test_audio_settings_match_after_effects", () => {
    // One render queue item per audio edit chain, made by After Effects
    // (scripts/jsx/generate_audio_settings_matrix.jsx); the JSON holds
    // AE's own getSettings() for each item.
    const project = parse_project(OM_SAMPLES_DIR.div("audio_settings_matrix.aep"));
    const expected = load_expected(OM_SAMPLES_DIR, "audio_settings_matrix");
    const keys = ["Output Audio", "Audio Bit Depth", "Audio Channels", "Audio Sample Rate"] as const;
    const items = expected["renderQueue"]["items"];
    expect(items.length).toBe(as_instance(project.renderQueue, RenderQueue).items.length);
    for (const [rqi, rqi_json] of zip(as_instance(project.renderQueue, RenderQueue).items, items)) {
      const settings = rqi.outputModules[0].settings;
      const want = rqi_json["outputModules"][0]["settings"];
      const got = new Map(keys.map((k) => [k, int(settings.get(k))] as const));
      const want_map = new Map(keys.map((k) => [k, want[k]] as const));
      // Python's assertion message was `rqi_json["outputModules"][0]`, shown on failure.
      expect(py_eq(got, want_map)).toBe(true);
    }
  });

  test("test_audio_mono", () => {
    /** Test mono audio channel. */
    const project = parse_project(OM_SAMPLES_DIR.div("audio_mono.aep"));
    const settings = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0].settings;

    expect(settings.get("Audio Channels")).toBe(1); // Mono
  });

  test("test_audio_8bit", () => {
    /** Test 8-bit audio depth. */
    const project = parse_project(OM_SAMPLES_DIR.div("audio_8bit.aep"));
    const settings = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0].settings;

    expect(settings.get("Audio Bit Depth")).toBe(1); // 8-bit
  });

  test("test_audio_32bit", () => {
    /** Test 32-bit audio depth. */
    const project = parse_project(OM_SAMPLES_DIR.div("audio_32bit.aep"));
    const settings = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0].settings;

    expect(settings.get("Audio Bit Depth")).toBe(4); // 32-bit
  });

  test.each([
    ["audio_8000hz.aep", 8000],
    ["audio_16000hz.aep", 16000],
    ["audio_22050hz.aep", 22050],
    ["audio_32000hz.aep", 32000],
    ["audio_96000hz.aep", 96000],
  ])("test_audio_sample_rate[%#]", (filename: string, expected_rate: number) => {
    /** Test audio sample rate parsing. */
    const project = parse_project(OM_SAMPLES_DIR.div(filename));
    const settings = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0].settings;

    expect<number>(settings.get("Audio Sample Rate")).toBe(expected_rate);
  });

  test.each([
    ["channels_rgb.aep", 0],
    ["channels_rgba.aep", 1],
    ["channels_alpha.aep", 2],
  ])("test_channels[%#]", (filename: string, expected_channels: number) => {
    /** Test output channels parsing. */
    const project = parse_project(OM_SAMPLES_DIR.div(filename));
    const settings = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0].settings;

    expect<number>(settings.get("Channels")).toBe(expected_channels);
  });

  test.each([
    ["depth_millions.aep", 24],
    ["depth_millions+.aep", 32],
    ["depth_trillions.aep", 48],
    ["depth_trillions+.aep", 64],
    ["depth_floating.aep", 96],
    ["depth_floating+.aep", 128],
  ])("test_depth[%#]", (filename: string, expected_depth: number) => {
    /** Test output color depth parsing. */
    const project = parse_project(OM_SAMPLES_DIR.div(filename));
    const settings = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0].settings;

    expect<number>(settings.get("Depth")).toBe(expected_depth);
  });

  test.each([
    ["format_aiff.aep", 0],
    ["format_avi.aep", 1],
    ["format_dpx_cineon_sequence.aep", 2],
    ["format_h264.aep", 3],
    ["format_iff_sequence.aep", 4],
    ["format_jpeg_sequence.aep", 5],
    ["format_mp3.aep", 6],
    ["format_openexr_sequence.aep", 7],
    ["format_png_sequence.aep", 8],
    ["format_photoshop_sequence.aep", 9],
    ["format_quicktime.aep", 10],
    ["format_radiance_sequence.aep", 11],
    ["format_sgi_sequence.aep", 12],
    ["format_tiff_sequence.aep", 13],
    ["format_targa_sequence.aep", 14],
    ["format_wav.aep", 15],
  ])("test_format[%#]", (filename: string, expected_format: number) => {
    /** Test output format parsing. */
    const project = parse_project(SAMPLES_DIR.div(filename));
    const settings = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0].settings;

    expect<number>(settings.get("Format")).toBe(expected_format);
  });

  test("test_color_straight_unmatted", () => {
    /** Test straight (unmatted) color mode. */
    const project = parse_project(OM_SAMPLES_DIR.div("color_straight_unmatted.aep"));
    const settings = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0].settings;

    expect(settings.get("Color")).toBe(0); // Straight (Unmatted)
  });

  test("test_include_project_link_off", () => {
    /** Test include project link is False when disabled. */
    const project = parse_project(OM_SAMPLES_DIR.div("include_project_link_off.aep"));
    const settings = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0].settings;

    expect(settings.get("Include Project Link")).toBe(false);
  });

  test("test_include_project_link_on", () => {
    /** Test include project link is True when enabled. */
    const project = parse_project(OM_SAMPLES_DIR.div("include_project_link_on.aep"));
    const settings = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0].settings;

    expect(settings.get("Include Project Link")).toBe(true);
  });

  test("test_use_region_of_interest_unchecked", () => {
    /** Test Use Region of Interest is False when unchecked. */
    const project = parse_project(OM_SAMPLES_DIR.div("crop_use_roi_unchecked.aep"));
    const settings = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0].settings;

    expect(settings.get("Use Region of Interest")).toBe(false);
  });

  test("test_use_region_of_interest_checked", () => {
    /** Test Use Region of Interest is True when checked. */
    const project = parse_project(OM_SAMPLES_DIR.div("crop_use_roi_checked.aep"));
    const settings = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0].settings;

    expect(settings.get("Use Region of Interest")).toBe(true);
  });

  test("test_lock_aspect_ratio_off", () => {
    /** Test Lock Aspect Ratio is False when disabled. */
    const project = parse_project(SAMPLES_DIR.div("lock_aspect_ratio_off.aep"));
    const settings = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0].settings;

    expect(settings.get("Lock Aspect Ratio")).toBe(false);
  });

  test("test_lock_aspect_ratio_on", () => {
    /** Test Lock Aspect Ratio is True when enabled. */
    const project = parse_project(SAMPLES_DIR.div("lock_aspect_ratio_on.aep"));
    const settings = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0].settings;

    expect(settings.get("Lock Aspect Ratio")).toBe(true);
  });

  test("test_resize_unchecked", () => {
    /** Test Resize is False when unchecked. */
    const project = parse_project(OM_SAMPLES_DIR.div("resize_unchecked.aep"));
    const settings = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0].settings;

    expect(settings.get("Resize")).toBe(false);
  });

  test("test_resize_checked", () => {
    /** Test Resize is True when checked. */
    const project = parse_project(OM_SAMPLES_DIR.div("resize_checked.aep"));
    const settings = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0].settings;

    expect(settings.get("Resize")).toBe(true);
  });

  test("test_resize_quality_low", () => {
    /** Test Resize Quality is 0 when set to low. */
    const project = parse_project(OM_SAMPLES_DIR.div("resize_quality_low.aep"));
    const settings = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0].settings;

    expect(settings.get("Resize Quality")).toBe(0);
  });

  test("test_resize_quality_high", () => {
    /** Test Resize Quality is 1 when set to high. */
    const project = parse_project(OM_SAMPLES_DIR.div("resize_quality_high.aep"));
    const settings = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0].settings;

    expect(settings.get("Resize Quality")).toBe(1);
  });

  test("test_resize_to_hd", () => {
    /** Test Resize to HD 1920x1080. */
    const project = parse_project(OM_SAMPLES_DIR.div("resize_hd_1920x1080_29.97_fps.aep"));
    const settings = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0].settings;

    expect(py_eq(settings.get("Resize to"), [1920, 1080])).toBe(true);
  });

  test("test_resize_to_dvcpro_hd", () => {
    /** Test Resize to DVCPRO HD 960x720. */
    const project = parse_project(
      OM_SAMPLES_DIR.div("resize_dvcpro_hd_960x720_1.33_23.976_fps.aep"),
    );
    const settings = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0].settings;

    expect(py_eq(settings.get("Resize to"), [960, 720])).toBe(true);
  });

  test("test_resize_to_custom", () => {
    /** Test Resize to custom 960x540. */
    const project = parse_project(OM_SAMPLES_DIR.div("resize_custom_960x540.aep"));
    const settings = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0].settings;

    expect(py_eq(settings.get("Resize to"), [960, 540])).toBe(true);
  });

  test("test_output_file_info_default", () => {
    /** Test Output File Info with default [compName].[fileExtension]. */
    const project = parse_project(SAMPLES_DIR.div("output_to_comp_and_frame_range.aep"));
    const info = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0].settings.get("Output File Info");

    expect(getitem(info, "File Template")).toBe("[compName].[fileExtension]");
    expect(getitem(info, "Subfolder Path")).toBe("");
    expect(getitem(info, "Base Path")).not.toBe("");
    expect(getitem(info, "Full Flat Path")).not.toBe("");
    expect(getitem(info, "File Name")).toBe("[compName].[fileExtension]");
  });

  test("test_output_file_info_comp_folder", () => {
    /** Test Output File Info with [compName] subfolder in base path. */
    const project = parse_project(SAMPLES_DIR.div("output_to_comp_folder_and_name.aep"));
    const info = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0].settings.get("Output File Info");

    expect((getitem(info, "Base Path") as string).includes("[compName]")).toBe(true);
    expect(getitem(info, "File Template")).toBe("[compName].[fileExtension]");
    expect(getitem(info, "File Name")).toBe("[compName].[fileExtension]");
    expect(getitem(info, "Subfolder Path")).toBe("");
  });

  test("test_output_file_info_custom_all_fields", () => {
    /** Test Output File Info with all available template tokens. */
    const project = parse_project(SAMPLES_DIR.div("output_to_custom_all_fields.aep"));
    const info = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0].settings.get("Output File Info");

    const template = getitem(info, "File Template") as string;
    expect(template.includes("[projectFolder]")).toBe(true);
    expect(template.includes("[projectName]")).toBe(true);
    expect(template.includes("[compName]")).toBe(true);
    expect(template.includes("[width]")).toBe(true);
    expect(template.includes("[height]")).toBe(true);
    expect(template.includes("[fileExtension]")).toBe(true);
    expect(getitem(info, "Base Path")).not.toBe("");
    expect((getitem(info, "Full Flat Path") as string).endsWith(".[fileExtension]")).toBe(true);
  });

  test("test_output_file_info_project_and_comp", () => {
    /** Test Output File Info with project and comp name template. */
    const project = parse_project(SAMPLES_DIR.div("output_to_project_and_comp_name.aep"));
    const info = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0].settings.get("Output File Info");

    expect(getitem(info, "File Template")).toBe("[projectName]_[compName].[fileExtension]");
  });

  test("test_output_file_info_subfolder", () => {
    /** Test Output File Info with subfolder in file name template. */
    const project = parse_project(SAMPLES_DIR.div("save_in_subfolder_toto.aep"));
    const om = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0];
    const info = om.settings.get("Output File Info");

    expect(getitem(info, "Subfolder Path")).toBe("toto");
    expect(getitem(info, "File Name")).toBe("Comp 1.[fileExtension]");
    expect(getitem(info, "File Template")).toBe("toto\\Comp 1.[fileExtension]");
    expect(getitem(info, "Base Path")).toBe("C:\\Users\\aurore.delaunay\\Downloads");
    expect(getitem(info, "Full Flat Path")).toBe(
      "C:\\Users\\aurore.delaunay\\Downloads\\toto\\Comp 1.[fileExtension]",
    );
  });

  test("test_video_output_on", () => {
    /** Test video output is enabled (default). */
    const project = parse_project(OM_SAMPLES_DIR.div("custom_h264.aep"));
    const om = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0];

    expect(om.settings.get("Video Output")).toBe(true);
  });

  test("test_video_output_off", () => {
    /** Test video output is disabled. */
    const project = parse_project(OM_SAMPLES_DIR.div("custom_has_video_off.aep"));
    const om = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0];

    expect(om.settings.get("Video Output")).toBe(false);
  });
});

describe("TestOutputModule", () => {
  /** Tests for OutputModule parsing. */

  test("test_post_render_action_none", () => {
    /** Test post_render_action is NONE by default. */
    const project = parse_project(SAMPLES_DIR.div("base.aep"));
    const om = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0];

    expect(om.postRenderAction).toBe(PostRenderAction.NONE);
  });

  test("test_post_render_action_import", () => {
    /** Test post_render_action is IMPORT. */
    const project = parse_project(SAMPLES_DIR.div("post_render_import.aep"));
    const om = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0];

    expect(om.postRenderAction).toBe(PostRenderAction.IMPORT);
  });

  test("test_post_render_action_import_and_replace", () => {
    /** Test post_render_action is IMPORT_AND_REPLACE_USAGE. */
    const project = parse_project(
      SAMPLES_DIR.div("post_render_import_and_replace_this_comp.aep"),
    );
    const om = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0];

    expect(om.postRenderAction).toBe(PostRenderAction.IMPORT_AND_REPLACE_USAGE);
  });

  test("test_post_render_action_set_proxy", () => {
    /** Test post_render_action is SET_PROXY. */
    const project = parse_project(SAMPLES_DIR.div("post_render_set_proxy_this_comp.aep"));
    const om = as_instance(project.renderQueue, RenderQueue).items[0].outputModules[0];

    expect(om.postRenderAction).toBe(PostRenderAction.SET_PROXY);
  });
});

describe("TestRenderQueueItem", () => {
  /** Tests for RenderQueueItem parsing. */

  test("test_render_enabled", () => {
    /** Test render flag is True when item is queued. */
    const project = parse_project(SAMPLES_DIR.div("base.aep"));
    const item = as_instance(project.renderQueue, RenderQueue).items[0];

    expect(item.render).toBe(true);
  });

  test("test_item_time_span_start", () => {
    /** Test RenderQueueItem.timeSpanStart property. */
    const project = parse_project(
      SAMPLES_DIR.div("time_span_custom_start_01s_23f_duration_24s13f.aep"),
    );
    const item = as_instance(project.renderQueue, RenderQueue).items[0];

    expect(Math.abs(item.timeSpanStart - (1 + 23 / 24)) < 0.0001).toBe(true);
  });

  test("test_item_time_span_duration", () => {
    /** Test RenderQueueItem.timeSpanDuration property. */
    const project = parse_project(
      SAMPLES_DIR.div("time_span_custom_start_01_duration_29.9583s.aep"),
    );
    const item = as_instance(project.renderQueue, RenderQueue).items[0];

    expect(Math.abs(item.timeSpanDuration - 29.9583333333333) < 0.0001).toBe(true);
  });

  test("test_default_comment", () => {
    /** Test RenderQueueItem.comment is None when no comment set. */
    const project = parse_project(SAMPLES_DIR.div("base.aep"));
    const item = as_instance(project.renderQueue, RenderQueue).items[0];

    expect(item.comment).toBe("");
  });
});
