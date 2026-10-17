/** Tests for CompItem model parsing. */

import { describe, expect, test } from "bun:test";
import {
  at,
  AttributeError,
  contains,
  getattr,
  getitem,
  hasattr,
  IndexError,
  isclose,
  len,
  Path,
  py_assert,
  py_bool,
  py_eq,
  round,
  StopIteration,
  TypeError_,
  ValueError,
} from "../../src/pyrt/index.ts";
import { approx, make_tmp_path, raises } from "../../src/pyrt/pytest.ts";
import { AdvancedRendererOptions, AVItem, ClassicRendererOptions, parse as parse_aep } from "../../src/py_aep/index.ts";
import { GuideOrientationType, ShadowMapResolution } from "../../src/py_aep/enums/index.ts";
import { CompItem } from "../../src/py_aep/models/items/composition.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import "../../src/py_aep/binary/_register.ts";
import { LdatChunk, Lhd3Chunk } from "../../src/py_aep/binary/ldat_chunks.ts";
import { as_instance, get_comp, parse_project_fresh } from "../helpers.ts";

const SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models", "composition");
const LAYER_SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models", "layer");
const PROPERTY_SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models", "property");
const MARKER_SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models", "marker");
const FOOTAGE_SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models", "footage");
const EG_SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models", "essential_graphics");

function next_<T>(found: T | undefined): T {
  if (found === undefined) throw new StopIteration();
  return found;
}

describe("TestRoundtripRenderer", () => {
  /** Roundtrip tests for CompItem.renderer. */

  test("test_modify_renderer_to_advanced", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("renderer_classic_3d.aep")).project;
    const comp = at(project.compositions, 0);
    expect(comp.renderer).toBe("ADBE Advanced 3d");

    comp.renderer = "ADBE Calder";
    const out = tmp_path.div("modified_renderer.aep");
    project.save(out);
    const comp2 = at(parse_aep(out).project.compositions, 0);
    expect(comp2.renderer).toBe("ADBE Calder");
  });

  test("test_modify_renderer_to_cinema_4d", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("renderer_classic_3d.aep")).project;
    const comp = at(project.compositions, 0);

    comp.renderer = "ADBE Ernst";
    const out = tmp_path.div("modified_renderer_c4d.aep");
    project.save(out);
    const comp2 = at(parse_aep(out).project.compositions, 0);
    expect(comp2.renderer).toBe("ADBE Ernst");
  });

  test("test_modify_renderer_back_to_classic", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("renderer_advanced_3d.aep")).project;
    const comp = at(project.compositions, 0);
    expect(comp.renderer).toBe("ADBE Calder");

    comp.renderer = "ADBE Advanced 3d";
    const out = tmp_path.div("modified_renderer_classic.aep");
    project.save(out);
    const comp2 = at(parse_aep(out).project.compositions, 0);
    expect(comp2.renderer).toBe("ADBE Advanced 3d");
  });

  test("test_renderer_validation_rejects_invalid", () => {
    const comp = at(parse_project_fresh(SAMPLES_DIR.div("renderer_classic_3d.aep")).compositions, 0);
    raises(ValueError, () => {
      comp.renderer = "Not A Renderer";
    }, "must be one of");
  });

  test("test_renderer_change_swaps_display_name_and_options", () => {
    /**
     * A renderer change must not leave the old renderer's prda behind.
     *
     * Rewriting only prin.match_name produced a file claiming one
     * renderer but storing another's options blob, which AE silently
     * misread field-by-field (a Classic Shadow Map Resolution index
     * came back as Advanced 3D's Quality).
     */
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("renderer_options_classic_3d.aep")).project;
    const comp = at(project.compositions, 0);
    expect(as_instance(comp.renderer_options, ClassicRendererOptions).shadow_map_resolution === ShadowMapResolution.RES_750).toBe(true);

    comp.renderer = "ADBE Calder";
    const out = tmp_path.div("switched_renderer.aep");
    project.save(out);

    const comp2 = at(parse_aep(out).project.compositions, 0);
    expect(py_eq(comp2._prin.display_name, "Advanced 3D")).toBe(true);
    const opts = comp2.renderer_options;
    expect(opts instanceof AdvancedRendererOptions).toBe(true);
    // Advanced 3D defaults, not Classic leftovers read as Quality.
    expect(as_instance(opts, AdvancedRendererOptions).quality).toBe(8);
  });

  test("test_renderer_reassign_same_value_keeps_options", () => {
    const project = parse_aep(SAMPLES_DIR.div("renderer_options_classic_3d.aep")).project;
    const comp = at(project.compositions, 0);

    comp.renderer = "ADBE Advanced 3d"; // already Classic 3D

    expect(as_instance(comp.renderer_options, ClassicRendererOptions).shadow_map_resolution === ShadowMapResolution.RES_750).toBe(true);
  });
});

describe("TestCompItemLazyLayerParsing", () => {
  /** Tests for deferred composition layer parsing. */

  test("test_layers_parsed_on_first_access", () => {
    const comp = get_comp(parse_aep(LAYER_SAMPLES_DIR.div("type.aep")).project, "type_text");

    expect(comp._layers_loaded).toBe(false);
    expect(comp._deferred_layers != null).toBe(true);
    py_assert(comp._deferred_layers != null);
    expect(len(comp._deferred_layers[0])).toBe(1);

    // Non-layer attributes should not trigger layer parsing.
    void comp.width;
    expect(comp._layers_loaded).toBe(false);

    const layers = comp.layers;
    expect(comp._layers_loaded).toBe(true);
    expect(len(layers)).toBe(1);
    expect(comp._deferred_layers == null).toBe(true);
  });

  test("test_markers_are_eager_without_loading_layers", () => {
    const comp = get_comp(parse_aep(LAYER_SAMPLES_DIR.div("type.aep")).project, "type_text");

    expect(comp._layers_loaded).toBe(false);

    const markers = comp.markers;
    expect(py_eq(markers, [])).toBe(true);

    // Reading comp markers must not force regular layer parsing.
    expect(comp._layers_loaded).toBe(false);
  });

  test("test_source_used_in_linking_without_layer_parse", () => {
    const project = parse_aep(FOOTAGE_SAMPLES_DIR.div("footage_not_missing.aep")).project;
    const comp = at(project.compositions, 0);

    expect(comp._layers_loaded).toBe(false);
    expect(comp._deferred_layers != null).toBe(true);

    // Trigger lazy linking via used_in - source IDs are extracted
    // on-demand from DeferredListChunk raw bytes.
    const footage_items = [...project.items.values()].filter((it) => hasattr(it, "_used_in"));
    const linked = footage_items.filter((it) => contains(as_instance(it, AVItem).used_in, comp));
    expect(py_bool(linked)).toBe(true);
    expect(comp._layers_loaded).toBe(false);
  });
});

describe("TestRoundtripBgColor", () => {
  /** Roundtrip tests for CompItem.bg_color. */

  test("test_modify_bg_color", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("bgColor.aep")).project;
    const comp = get_comp(project, "bgColor_red");

    // Modify
    comp.bg_color = [0.1, 0.2, 0.3];

    // Save and re-parse
    const out = tmp_path.div("modified_bg.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "bgColor_red");

    expect(isclose(comp2.bg_color[0], 0.1, 1e-9, 0.005)).toBe(true);
    expect(isclose(comp2.bg_color[1], 0.2, 1e-9, 0.005)).toBe(true);
    expect(isclose(comp2.bg_color[2], 0.3, 1e-9, 0.005)).toBe(true);
  });

  test("test_bg_color_validation_rejects_bad_length", () => {
    const comp = get_comp(parse_project_fresh(SAMPLES_DIR.div("bgColor.aep")), "bgColor_red");
    raises(ValueError, () => {
      comp.bg_color = [0.1, 0.2];
    }, "expected 3 elements");
  });

  test("test_bg_color_validation_rejects_out_of_range", () => {
    const comp = get_comp(parse_project_fresh(SAMPLES_DIR.div("bgColor.aep")), "bgColor_red");
    raises(ValueError, () => {
      comp.bg_color = [1.5, 0.0, 0.0];
    }, "must be <= 1(\\.0)?");
  });
});

describe("TestRoundtripFrameRate", () => {
  /** Roundtrip tests for CompItem.frame_rate. */

  test("test_modify_frame_rate_integer", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("frameRate.aep")).project;
    const comp = get_comp(project, "frameRate_30");
    expect(isclose(comp.frame_rate, 30.0, 0.001)).toBe(true);

    comp.frame_rate = 24.0;
    const out = tmp_path.div("modified_fps.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "frameRate_30");
    expect(isclose(comp2.frame_rate, 24.0, 0.001)).toBe(true);
  });

  test("test_modify_frame_rate_fractional", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("frameRate.aep")).project;
    const comp = get_comp(project, "frameRate_30");

    comp.frame_rate = 29.97;
    const out = tmp_path.div("modified_fps29.97.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "frameRate_30");
    expect(isclose(comp2.frame_rate, 29.97, 0.001)).toBe(true);
  });

  test("test_frame_rate_validation_rejects_zero", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("frameRate.aep")),
      "frameRate_30",
    );
    raises(ValueError, () => {
      comp.frame_rate = 0.0;
    }, "must be >= 1(\\.0)?");
  });

  test("test_frame_rate_validation_rejects_too_high", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("frameRate.aep")),
      "frameRate_30",
    );
    // AE 2026's range is 1 to 999 ("out of range 1 to 999").
    raises(ValueError, () => {
      comp.frame_rate = 1000.0;
    }, "must be <= 999(\\.0)?");
  });
});

describe("TestRoundtripPixelAspect", () => {
  /** Roundtrip tests for CompItem.pixel_aspect. */

  test("test_modify_pixel_aspect", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("pixelAspect.aep")).project;
    const comp = get_comp(project, "pixelAspect_2");
    expect(isclose(comp.pixel_aspect, 2.0, 0.01)).toBe(true);

    comp.pixel_aspect = 1.0;
    const out = tmp_path.div("modified_par.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "pixelAspect_2");
    expect(isclose(comp2.pixel_aspect, 1.0, 0.01)).toBe(true);
  });

  test("test_pixel_aspect_validation_rejects_invalid", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("pixelAspect.aep")),
      "pixelAspect_2",
    );
    raises(ValueError, () => {
      comp.pixel_aspect = -5;
    }, "must be >= 0.01");
  });
});

describe("TestRoundtripSize", () => {
  /** Roundtrip tests for CompItem.width and .height. */

  test("test_modify_width_and_height", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("size.aep")).project;
    const comp = get_comp(project, "size_1920x1080");
    expect(comp.width).toBe(1920);
    expect(comp.height).toBe(1080);

    comp.width = 3840;
    comp.height = 2160;
    const out = tmp_path.div("modified_size.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "size_1920x1080");
    expect(comp2.width).toBe(3840);
    expect(comp2.height).toBe(2160);
  });

  test("test_width_validation_rejects_too_small", () => {
    const comp = get_comp(parse_project_fresh(SAMPLES_DIR.div("size.aep")), "size_1920x1080");
    raises(ValueError, () => {
      comp.width = 3;
    }, "must be >= 4");
  });

  test("test_width_validation_rejects_too_large", () => {
    const comp = get_comp(parse_project_fresh(SAMPLES_DIR.div("size.aep")), "size_1920x1080");
    raises(ValueError, () => {
      comp.width = 30001;
    }, "must be <= 30000");
  });

  test("test_width_validation_rejects_non_int", () => {
    const comp = get_comp(parse_project_fresh(SAMPLES_DIR.div("size.aep")), "size_1920x1080");
    // type: ignore[assignment] in Python; the TS setter receives the float as-is.
    raises(TypeError_, () => {
      comp.width = 1920.5;
    }, "expected an integer");
  });

  test("test_height_validation_rejects_too_small", () => {
    const comp = get_comp(parse_project_fresh(SAMPLES_DIR.div("size.aep")), "size_1920x1080");
    raises(ValueError, () => {
      comp.height = 0;
    }, "must be >= 4");
  });

  test("test_height_validation_rejects_too_large", () => {
    const comp = get_comp(parse_project_fresh(SAMPLES_DIR.div("size.aep")), "size_1920x1080");
    raises(ValueError, () => {
      comp.height = 30001;
    }, "must be <= 30000");
  });
});

describe("TestRoundtripFlags", () => {
  /** Roundtrip tests for boolean CompItem flags. */

  test("test_toggle_motion_blur", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("comp_flags.aep")).project;
    const comp = get_comp(project, "motionBlur_true");
    expect(comp.motion_blur).toBe(true);

    comp.motion_blur = false;
    const out = tmp_path.div("modified_mb.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "motionBlur_true");
    expect(comp2.motion_blur).toBe(false);
  });

  test("test_toggle_frame_blending", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("comp_flags.aep")).project;
    const comp = get_comp(project, "frameBlending_true");
    expect(comp.frame_blending).toBe(true);

    comp.frame_blending = false;
    const out = tmp_path.div("modified_fb.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "frameBlending_true");
    expect(comp2.frame_blending).toBe(false);
  });

  test("test_toggle_hide_shy_layers", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("comp_flags.aep")).project;
    const comp = get_comp(project, "hideShyLayers_true");
    expect(comp.hide_shy_layers).toBe(true);

    comp.hide_shy_layers = false;
    const out = tmp_path.div("modified_shy.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "hideShyLayers_true");
    expect(comp2.hide_shy_layers).toBe(false);
  });
});

describe("TestRoundtripShutter", () => {
  /** Roundtrip tests for shutter settings. */

  test("test_modify_shutter_angle", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("shutterAngle.aep")).project;
    const comp = get_comp(project, "shutterAngle_180");

    comp.shutter_angle = 360;
    const out = tmp_path.div("modified_shutter.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "shutterAngle_180");
    expect(comp2.shutter_angle).toBe(360);
  });

  test("test_shutter_angle_validation_rejects_negative", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("shutterAngle.aep")),
      "shutterAngle_180",
    );
    raises(ValueError, () => {
      comp.shutter_angle = -1;
    }, "must be >= 0");
  });

  test("test_shutter_angle_validation_rejects_too_large", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("shutterAngle.aep")),
      "shutterAngle_180",
    );
    raises(ValueError, () => {
      comp.shutter_angle = 721;
    }, "must be <= 720");
  });

  test("test_shutter_angle_validation_rejects_non_int", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("shutterAngle.aep")),
      "shutterAngle_180",
    );
    // type: ignore[assignment] in Python; the TS setter receives the float as-is.
    raises(TypeError_, () => {
      comp.shutter_angle = 180.5;
    }, "expected an integer");
  });

  test("test_modify_shutter_phase", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("comp_flags.aep")).project;
    const comp = get_comp(project, "shutterPhase_minus90");

    comp.shutter_phase = -180;
    const out = tmp_path.div("modified_phase.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "shutterPhase_minus90");
    expect(comp2.shutter_phase).toBe(-180);
  });

  test("test_shutter_phase_validation_rejects_too_small", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("comp_flags.aep")),
      "shutterPhase_minus90",
    );
    raises(ValueError, () => {
      comp.shutter_phase = -361;
    }, "must be >= -360");
  });

  test("test_shutter_phase_validation_rejects_too_large", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("comp_flags.aep")),
      "shutterPhase_minus90",
    );
    raises(ValueError, () => {
      comp.shutter_phase = 361;
    }, "must be <= 360");
  });

  test("test_shutter_phase_validation_rejects_non_int", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("comp_flags.aep")),
      "shutterPhase_minus90",
    );
    // type: ignore[assignment] in Python; the TS setter receives the float as-is.
    raises(TypeError_, () => {
      comp.shutter_phase = -90.5;
    }, "expected an integer");
  });
});

describe("TestRoundtripResolution", () => {
  /** Roundtrip tests for CompItem.resolution_factor. */

  test("test_modify_resolution_factor", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("resolutionFactor.aep")).project;
    const comp = get_comp(project, "resolutionFactor_half");

    comp.resolution_factor = [1, 1];
    const out = tmp_path.div("modified_res.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "resolutionFactor_half");
    expect(py_eq(comp2.resolution_factor, [1, 1])).toBe(true);
  });
});

describe("TestTimeScaleReadOnly", () => {
  /** Test that time_scale is read-only. */

  test("test_time_scale_is_read_only", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("frameRate.aep")),
      "frameRate_30",
    );
    raises(AttributeError, () => {
      comp.time_scale = 12345;
    }, "read-only");
  });
});

describe("TestRoundtripDerivedTimes", () => {
  /** Roundtrip tests: changing frame_rate affects derived time fields. */

  test("test_frame_rate_change_updates_frame_duration", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("frameRate.aep")).project;
    const comp = get_comp(project, "frameRate_30");
    const original_frame_duration = comp.frame_duration;

    comp.frame_rate = 60.0;
    const out = tmp_path.div("modified_fps60b.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "frameRate_30");

    // Duration in seconds should be the same
    expect(isclose(comp2.duration, comp.duration, 0.01)).toBe(true);
    // Frame duration should be roughly double at 60fps
    expect(comp2.frame_duration > original_frame_duration).toBe(true);
  });
});

describe("TestRoundtripCombined", () => {
  /** Test multiple modifications at once. */

  test("test_multiple_fields_at_once", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("size.aep")).project;
    const comp = get_comp(project, "size_1920x1080");

    comp.width = 1280;
    comp.height = 720;
    comp.bg_color = [0.0, 0.0, 0.0];
    comp.frame_rate = 25.0;

    const out = tmp_path.div("modified_multi.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "size_1920x1080");

    expect(comp2.width).toBe(1280);
    expect(comp2.height).toBe(720);
    expect(isclose(comp2.bg_color[0], 0.0, 1e-9, 0.005)).toBe(true);
    expect(isclose(comp2.bg_color[1], 0.0, 1e-9, 0.005)).toBe(true);
    expect(isclose(comp2.bg_color[2], 0.0, 1e-9, 0.005)).toBe(true);
    expect(isclose(comp2.frame_rate, 25.0, 0.001)).toBe(true);
  });
});

describe("TestRoundtripDisplayStartTime", () => {
  /** Roundtrip tests for CompItem.display_start_time. */

  test("test_modify_display_start_time", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("displayStart.aep")).project;
    const comp = get_comp(project, "displayStartTime_10");

    comp.display_start_time = 5.0;
    const out = tmp_path.div("modified_dst.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "displayStartTime_10");
    expect(isclose(comp2.display_start_time, 5.0, 1e-9, 0.01)).toBe(true);
  });

  test("test_display_start_time_validation_rejects_too_small", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("displayStart.aep")),
      "displayStartTime_10",
    );
    raises(ValueError, () => {
      comp.display_start_time = -10801.0;
    }, "must be >= -10800(\\.0)?");
  });

  test("test_display_start_time_validation_rejects_too_large", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("displayStart.aep")),
      "displayStartTime_10",
    );
    // AE 2026's range is -10800 to 86400.
    raises(ValueError, () => {
      comp.display_start_time = 86400.01;
    }, "must be <= 86400(\\.0)?");
  });
});

describe("TestRoundtripDuration", () => {
  /** Roundtrip tests for CompItem.duration and .frame_duration. */

  test("test_modify_duration", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("comp_misc.aep")).project;
    const comp = get_comp(project, "duration_60");

    comp.duration = 120.0;
    const out = tmp_path.div("modified_dur.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "duration_60");
    expect(isclose(comp2.duration, 120.0, 0.01)).toBe(true);
  });

  test("test_modify_frame_duration", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("comp_misc.aep")).project;
    const comp = get_comp(project, "duration_60");
    const fps = comp.frame_rate;

    comp.frame_duration = 300;
    const out = tmp_path.div("modified_fdur.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "duration_60");
    expect(comp2.frame_duration).toBe(300);
    expect(isclose(comp2.duration, 300 / fps, 0.01)).toBe(true);
  });

  test("test_duration_validation_rejects_negative", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("comp_misc.aep")),
      "duration_60",
    );
    raises(ValueError, () => {
      comp.duration = -1.0;
    }, "must be >= 0(\\.0)?");
  });

  test("test_duration_validation_rejects_too_large", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("comp_misc.aep")),
      "duration_60",
    );
    raises(ValueError, () => {
      comp.duration = 10801.0;
    }, "must be <= 10800(\\.0)?");
  });

  test("test_frame_duration_validation_rejects_zero", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("comp_misc.aep")),
      "duration_60",
    );
    raises(ValueError, () => {
      comp.frame_duration = 0;
    }, "must be >= 1");
  });

  test.each([
    // The cdta duration AE 2026 stores after `comp.duration = frames /
    // fps` on a new comp: the nearest frame, half a frame rounding up,
    // in timebase units.
    [24.0, 52.0479, 53248, 24576],
    [24.0, 52.4, 53248, 24576],
    [24.0, 52.5, 54272, 24576],
    [24.0, 0.5, 1024, 24576],
    [25.0, 52.5, 54272, 25600],
    [29.97, 52.5, 42400, 23976],
    [23.976, 52.0479, 52000, 23976],
    [23.976, 52.5, 53000, 23976],
    [59.94, 52.6, 21200, 23976],
  ])(
    "test_duration_snaps_to_nearest_frame[%#]",
    (fps: number, frames: number, dividend: number, divisor: number) => {
      const tmp_path = make_tmp_path();
      const project = parse_project_fresh(SAMPLES_DIR.div("comp_misc.aep"));
      const comp = project.root_folder.add_comp("snapped", 100, 100, 1.0, 10.0, fps);
      comp.duration = frames / fps;
      const out = tmp_path.div("snapped.aep");
      project.save(out);
      const cdta = get_comp(parse_aep(out).project, "snapped")._cdta;
      expect(py_eq([cdta.duration_dividend, cdta.duration_divisor], [dividend, divisor])).toBe(true);
    },
  );

  test("test_duration_snaps_on_a_parsed_comp", () => {
    /** The reported case: an out point 52.0479 frames in at 24 fps. */
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("comp_misc.aep")),
      "duration_60",
    );
    const fps = comp.frame_rate;
    comp.duration = 52.0479 / fps;
    expect(comp.duration).toBe(52 / fps);
  });

  test("test_duration_under_half_a_frame_keeps_one_frame", () => {
    // AE stores a zero-length composition here; py_aep keeps one frame.
    const project = parse_project_fresh(SAMPLES_DIR.div("comp_misc.aep"));
    const comp = project.root_folder.add_comp("short", 100, 100, 1.0, 10.0, 24.0);
    comp.duration = 0.3 / 24;
    expect(comp.duration).toBe(1 / 24);
  });

  test("test_add_comp_rounds_half_a_frame_up", () => {
    // AE 2026: addComp with 52.5 frames of duration makes a 53-frame comp.
    const project = parse_project_fresh(SAMPLES_DIR.div("comp_misc.aep"));
    const comp = project.root_folder.add_comp("half", 100, 100, 1.0, 52.5 / 24, 24.0);
    expect(py_eq([comp._cdta.duration_dividend, comp._cdta.duration_divisor], [54272, 24576])).toBe(true);
  });

  test("test_frame_duration_validation_rejects_non_int", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("comp_misc.aep")),
      "duration_60",
    );
    // type: ignore[assignment] in Python; the TS setter receives the float as-is.
    raises(TypeError_, () => {
      comp.frame_duration = 300.5;
    }, "expected an integer");
  });

  test("test_frame_duration_validation_rejects_too_large", () => {
    // The bound is the 3-hour duration limit, not the current duration.
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("comp_misc.aep")),
      "duration_60",
    );
    raises(ValueError, () => {
      comp.frame_duration = round(10800 * comp.frame_rate) + 1;
    }, "must be <= 10800(\\.0)?");
  });

  test("test_frame_duration_counts_every_frame_at_ntsc", () => {
    // 52 frames at 23.976 fps: duration x the 16.16 stored rate is
    // 51.999995, which truncation would make 51.
    const project = parse_project_fresh(SAMPLES_DIR.div("comp_misc.aep"));
    const comp = project.root_folder.add_comp("ntsc", 100, 100, 1.0, 10.0, 23.976);
    comp.duration = 52 / 23.976;
    expect(comp.frame_duration).toBe(52);
  });

  test("test_frame_duration_can_grow", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("comp_misc.aep")),
      "duration_60",
    );
    comp.frame_duration = 2000;
    expect(comp.frame_duration).toBe(2000);
    // Stored in timebase units, like AE's own durations.
    expect(py_eq([comp._cdta.duration_dividend, comp._cdta.duration_divisor], [2000 * 1024, 24576])).toBe(true);
  });
});

describe("TestCompTimeWrites", () => {
  /**
   * Work area, current time and display start writes store what AE 2026
   * stores for the same call on a new 24 fps comp (timebase 24576, 1024
   * units a frame): whole timebase units, snapped to the nearest frame with
   * half a frame rounding up.
   */

  // Python @staticmethod `_comp`; a plain function here since the describe block is the class.
  function _comp(fps: number = 24.0): CompItem {
    const project = parse_project_fresh(SAMPLES_DIR.div("comp_misc.aep"));
    return project.root_folder.add_comp("timed", 100, 100, 1.0, 10.0, fps);
  }

  test.each([
    [12.24, 12288],
    [12.5, 13312],
    [12.6, 13312],
    [0.4, 0],
  ])("test_work_area_start[%#]", (frames: number, units: number) => {
    const comp = _comp();
    comp.work_area_start = frames / 24;
    const cdta = comp._cdta;
    expect(py_eq([cdta.work_area_start_dividend, cdta.work_area_start_divisor], [units, 24576])).toBe(true);
    // A work area that ran to the end of the comp still does.
    expect(py_eq([cdta.work_area_end_dividend, cdta.work_area_end_divisor], [0xFFFFFFFF, 24576])).toBe(true);
  });

  test.each([
    [24.24, 36864],
    [24.5, 37888],
    [24.6, 37888],
    [228, 0xFFFFFFFF],
  ])("test_work_area_duration[%#]", (frames: number, end: number) => {
    // From frame 12; 228 frames reach the end, which AE stores as such.
    const comp = _comp();
    comp.work_area_start = 12 / 24;
    comp.work_area_duration = frames / 24;
    const cdta = comp._cdta;
    expect(py_eq([cdta.work_area_end_dividend, cdta.work_area_end_divisor], [end, 24576])).toBe(true);
  });

  test("test_work_area_start_keeps_the_duration", () => {
    const comp = _comp();
    comp.work_area_duration = 5.0;
    comp.work_area_start = 1.0;
    expect(comp.work_area_duration).toBe(5.0);
    expect(comp._cdta.work_area_end_dividend).toBe(6 * 24576);
  });

  test("test_work_area_start_past_the_end", () => {
    // AE 2026 moves the start back (to frame 119, a frame short of what
    // fits); py_aep keeps the start and ends the work area with the comp.
    const comp = _comp();
    comp.work_area_duration = 5.0;
    comp.work_area_start = 8.0;
    expect(comp.work_area_start).toBe(8.0);
    expect(comp._cdta.work_area_end_dividend).toBe(0xFFFFFFFF);
    expect(comp.work_area_duration).toBe(2.0);
  });

  test.each([
    [12.24, 12288],
    [12.5, 13312],
    [12.6, 13312],
  ])("test_time[%#]", (frames: number, units: number) => {
    const comp = _comp();
    comp.time = frames / 24;
    expect(py_eq([comp._cdta.time_dividend, comp._cdta.time_divisor], [units, 24576])).toBe(true);
  });

  test("test_time_may_precede_the_display_start", () => {
    // AE 2026 takes 0 to 10800 s whatever the display start.
    const comp = _comp();
    comp.display_start_time = 0.5;
    comp.time = 0.26;
    expect(comp.time).toBe(0.25);
  });

  test("test_ntsc", () => {
    const comp = _comp(23.976);
    comp.work_area_start = 52.5 / 23.976;
    comp.work_area_duration = 24.5 / 23.976;
    comp.time = 52.5 / 23.976;
    const cdta = comp._cdta;
    expect(
      py_eq(
        [cdta.work_area_start_dividend, cdta.work_area_end_dividend, cdta.time_dividend],
        [53000, 78000, 53000],
      ),
    ).toBe(true);
  });

  test.each([
    // AE 2026's displayStartFrame for the same display start time:
    // away from zero, but 52 frames at 29.97 or 59.94 fps (a hair
    // over 52 once stored as float32) stay 52.
    [24.0, 12.24, 13],
    [24.0, 12.00001, 13],
    [24.0, 11.9999, 12],
    [24.0, -12.24, -13],
    [24.0, -11.9999, -12],
    [24.0, 0.00002, 1],
    [29.97, 52, 52],
    [59.94, 52, 52],
    [23.976, 52, 52],
  ])("test_display_start_frame[%#]", (fps: number, frames: number, expected: number) => {
    const comp = _comp(fps);
    comp.display_start_time = frames / fps;
    expect(comp.display_start_frame).toBe(expected);
  });

  test.each<[number, [number, number]]>([
    [0.51, [2139095, 4194304]],
    [0.5, [1, 2]],
    [0.00002 / 24, [330, 396000001]],
  ])("test_display_start_time_is_stored_as_float32[%#]", (seconds: number, ratio: [number, number]) => {
    const comp = _comp();
    comp.display_start_time = seconds;
    const cdta = comp._cdta;
    expect(
      py_eq([cdta.display_start_time_dividend, cdta.display_start_time_divisor], ratio),
    ).toBe(true);
    // AE re-stores the work area start and current time over the
    // timebase alongside.
    expect(py_eq([cdta.work_area_start_divisor, cdta.time_divisor], [24576, 24576])).toBe(true);
  });

  test.each<[number, number, [number, number]]>([
    [24.0, 13, [13312, 24576]],
    [29.97, 52, [41600, 23976]],
  ])("test_display_start_frame_write[%#]", (fps: number, frames: number, ratio: [number, number]) => {
    const comp = _comp(fps);
    comp.display_start_frame = frames;
    const cdta = comp._cdta;
    expect(
      py_eq([cdta.display_start_time_dividend, cdta.display_start_time_divisor], ratio),
    ).toBe(true);
    expect(comp.display_start_frame).toBe(frames);
  });

  test("test_frame_writes_land_on_their_frame", () => {
    const comp = _comp(23.976);
    comp.work_area_start_frame = 52;
    comp.work_area_duration_frame = 25;
    comp.frame_time = 53;
    expect(
      py_eq(
        [comp.work_area_start_frame, comp.work_area_duration_frame, comp.frame_time],
        [52, 25, 53],
      ),
    ).toBe(true);
    expect(comp._cdta.work_area_start_dividend).toBe(52000);
  });
});

describe("TestRoundtripMotionBlurSamples", () => {
  /** Roundtrip tests for motion blur sample settings. */

  test("test_modify_samples_per_frame", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("comp_flags.aep")).project;
    const comp = get_comp(project, "motionBlurSamplesPerFrame_32");

    comp.motion_blur_samples_per_frame = 16;
    const out = tmp_path.div("modified_spf.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "motionBlurSamplesPerFrame_32");
    expect(comp2.motion_blur_samples_per_frame).toBe(16);
  });

  test("test_samples_per_frame_validation_rejects_too_small", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("comp_flags.aep")),
      "motionBlurSamplesPerFrame_32",
    );
    raises(ValueError, () => {
      comp.motion_blur_samples_per_frame = 1;
    }, "must be >= 2");
  });

  test("test_samples_per_frame_validation_rejects_too_large", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("comp_flags.aep")),
      "motionBlurSamplesPerFrame_32",
    );
    raises(ValueError, () => {
      comp.motion_blur_samples_per_frame = 65;
    }, "must be <= 64");
  });

  test("test_samples_per_frame_validation_rejects_non_int", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("comp_flags.aep")),
      "motionBlurSamplesPerFrame_32",
    );
    // type: ignore[assignment] in Python; the TS setter receives the float as-is.
    raises(TypeError_, () => {
      comp.motion_blur_samples_per_frame = 16.5;
    }, "expected an integer");
  });

  test("test_modify_adaptive_sample_limit", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("comp_flags.aep")).project;
    const comp = get_comp(project, "motionBlurAdaptiveSampleLimit_256");

    comp.motion_blur_adaptive_sample_limit = 128;
    const out = tmp_path.div("modified_asl.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "motionBlurAdaptiveSampleLimit_256");
    expect(comp2.motion_blur_adaptive_sample_limit).toBe(128);
  });

  test("test_adaptive_sample_limit_validation_rejects_too_small", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("comp_flags.aep")),
      "motionBlurAdaptiveSampleLimit_256",
    );
    raises(ValueError, () => {
      comp.motion_blur_adaptive_sample_limit = 1;
    }, /must be >= \d+/);
  });

  test("test_adaptive_sample_limit_validation_rejects_too_large", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("comp_flags.aep")),
      "motionBlurAdaptiveSampleLimit_256",
    );
    raises(ValueError, () => {
      comp.motion_blur_adaptive_sample_limit = 257;
    }, "must be <= 256");
  });

  test("test_adaptive_sample_limit_validation_rejects_non_int", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("comp_flags.aep")),
      "motionBlurAdaptiveSampleLimit_256",
    );
    // type: ignore[assignment] in Python; the TS setter receives the float as-is.
    raises(TypeError_, () => {
      comp.motion_blur_adaptive_sample_limit = 128.5;
    }, "expected an integer");
  });

  test("test_adaptive_sample_limit_rejects_below_samples_per_frame", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("comp_flags.aep")),
      "motionBlurAdaptiveSampleLimit_256",
    );
    // samples_per_frame is 16, so 8 must be rejected
    expect(comp.motion_blur_samples_per_frame).toBe(16);
    raises(ValueError, () => {
      comp.motion_blur_adaptive_sample_limit = 8;
    }, "must be >= 16");
  });
});

describe("TestRoundtripWorkAreaStart", () => {
  /** Roundtrip tests for CompItem.work_area_start. */

  test("test_modify_work_area_start", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("workArea.aep")).project;
    const comp = get_comp(project, "workAreaStart_5");

    comp.work_area_start = 2.0;
    const out = tmp_path.div("modified_was.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "workAreaStart_5");
    expect(isclose(comp2.work_area_start, 2.0, 1e-9, 0.01)).toBe(true);
  });

  test("test_modify_work_area_start_frame", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("workArea.aep")).project;
    const comp = get_comp(project, "workAreaStart_5");

    comp.work_area_start_frame = 48;
    const out = tmp_path.div("modified_wasf.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "workAreaStart_5");
    expect(comp2.work_area_start_frame).toBe(48);
  });

  test("test_work_area_start_validation_rejects_negative", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("workArea.aep")),
      "workAreaStart_5",
    );
    raises(ValueError, () => {
      comp.work_area_start = -1.0;
    }, "must be >= 0");
  });

  test("test_work_area_start_validation_rejects_too_large", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("workArea.aep")),
      "workAreaStart_5",
    );
    raises(ValueError, () => {
      comp.work_area_start = comp.duration;
    }, "must be <=");
  });

  test("test_work_area_start_frame_validation_rejects_negative", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("workArea.aep")),
      "workAreaStart_5",
    );
    raises(ValueError, () => {
      comp.work_area_start_frame = -1;
    }, "must be >= 0");
  });

  test("test_work_area_start_frame_validation_rejects_too_large", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("workArea.aep")),
      "workAreaStart_5",
    );
    raises(ValueError, () => {
      comp.work_area_start_frame = comp.frame_duration;
    }, "must be <=");
  });
});

describe("TestRoundtripWorkAreaDuration", () => {
  /** Roundtrip tests for CompItem.work_area_duration. */

  test("test_modify_work_area_duration", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("workArea.aep")).project;
    const comp = get_comp(project, "workAreaDuration_10");

    comp.work_area_duration = 5.0;
    const out = tmp_path.div("modified_wad.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "workAreaDuration_10");
    expect(isclose(comp2.work_area_duration, 5.0, 1e-9, 0.01)).toBe(true);
  });

  test("test_modify_work_area_duration_frame", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("workArea.aep")).project;
    const comp = get_comp(project, "workAreaDuration_10");

    comp.work_area_duration_frame = 120;
    const out = tmp_path.div("modified_wadf.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "workAreaDuration_10");
    expect(comp2.work_area_duration_frame).toBe(120);
  });

  test("test_work_area_duration_validation_rejects_too_small", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("workArea.aep")),
      "workAreaDuration_10",
    );
    raises(ValueError, () => {
      comp.work_area_duration = 0.0;
    }, "must be >=");
  });

  test("test_work_area_duration_validation_rejects_too_large", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("workArea.aep")),
      "workAreaDuration_10",
    );
    raises(ValueError, () => {
      comp.work_area_duration = comp.duration + 1.0;
    }, "must be <=");
  });

  test("test_work_area_duration_frame_validation_rejects_zero", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("workArea.aep")),
      "workAreaDuration_10",
    );
    raises(ValueError, () => {
      comp.work_area_duration_frame = 0;
    }, "must be >= 1");
  });

  test("test_work_area_duration_frame_validation_rejects_too_large", () => {
    const comp = get_comp(
      parse_project_fresh(SAMPLES_DIR.div("workArea.aep")),
      "workAreaDuration_10",
    );
    raises(ValueError, () => {
      comp.work_area_duration_frame = comp.frame_duration + 1;
    }, "must be <=");
  });
});

describe("TestRoundtripGuides", () => {
  /** Roundtrip tests for CompItem.guides. */

  test("test_modify_guide_position", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("guides.aep")).project;
    const comp = get_comp(project, "guides_horizontal");
    comp.guides[0].position = 100.0;

    const out = tmp_path.div("modified_guide.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "guides_horizontal");
    expect(comp2.guides[0].position).toBe(100.0);
  });

  test("test_modify_guide_orientation", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("guides.aep")).project;
    const comp = get_comp(project, "guides_horizontal");
    expect(comp.guides[0].orientation_type).toBe(0);
    comp.guides[0].orientation_type = 1;

    const out = tmp_path.div("modified_orient.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "guides_horizontal");
    expect(comp2.guides[0].orientation_type).toBe(1);
  });
});

describe("TestValidateGuidePosition", () => {
  /** Validation tests for Guide.position bounds. */

  test("test_position_accepts_negative_and_fractional", () => {
    /**
     * Guides sit anywhere on the ruler, including outside the comp.
     *
     * AE 2026 accepts both through ExtendScript (probed headlessly:
     * `comp.addGuide(0, -100)` -> position -100, `addGuide(0, -0.5)` ->
     * position -0.5), and the backing field is a signed f8, so neither
     * the format nor After Effects justifies a `>= 0` bound.
     */
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("guides.aep")).project;
    const comp = get_comp(project, "guides_horizontal");
    comp.guides[0].position = -100.0;
    const idx = comp.add_guide(1, -0.5);

    const out = tmp_path.div("negative_guides.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "guides_horizontal");
    expect(comp2.guides[0].position).toBe(-100.0);
    expect(comp2.guides[idx].position).toBe(-0.5);
  });

  test("test_position_rejects_non_numeric", () => {
    const comp = get_comp(
      parse_aep(SAMPLES_DIR.div("guides.aep")).project,
      "guides_horizontal",
    );
    // type: ignore[assignment] in Python; the TS setter receives the string as-is.
    raises(TypeError_, () => {
      // @ts-expect-error deliberately assigns a string to a numeric setter
      comp.guides[0].position = "nope";
    });
  });
});

describe("TestAddGuide", () => {
  /** Tests for Item.add_guide(). */

  test("test_add_guide_to_existing", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("guides.aep")).project;
    const comp = get_comp(project, "guides_both");
    const original_count = len(comp.guides);

    const idx = comp.add_guide(0, 500);
    expect(idx).toBe(original_count);
    expect(len(comp.guides)).toBe(original_count + 1);
    expect(comp.guides[idx].orientation_type).toBe(GuideOrientationType.HORIZONTAL);
    expect(comp.guides[idx].position).toBe(500.0);

    const out = tmp_path.div("add_guide.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "guides_both");
    expect(len(comp2.guides)).toBe(original_count + 1);
    expect(comp2.guides[idx].orientation_type).toBe(GuideOrientationType.HORIZONTAL);
    expect(comp2.guides[idx].position).toBe(500.0);
  });

  test("test_add_guide_vertical", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("guides.aep")).project;
    const comp = get_comp(project, "guides_horizontal");

    const idx = comp.add_guide(1, 200);
    expect(comp.guides[idx].orientation_type).toBe(GuideOrientationType.VERTICAL);
    expect(comp.guides[idx].position).toBe(200.0);

    const out = tmp_path.div("add_vert.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "guides_horizontal");
    expect(comp2.guides[idx].orientation_type).toBe(GuideOrientationType.VERTICAL);
    expect(comp2.guides[idx].position).toBe(200.0);
  });

  test("test_add_guide_to_empty_comp", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("guides.aep")).project;
    const comp = get_comp(project, "guides_none");
    expect(py_eq(comp.guides, [])).toBe(true);

    const idx = comp.add_guide(0, 300);
    expect(idx).toBe(0);
    expect(len(comp.guides)).toBe(1);
    expect(comp.guides[0].position).toBe(300.0);

    const out = tmp_path.div("bootstrap_guide.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "guides_none");
    expect(len(comp2.guides)).toBe(1);
    expect(comp2.guides[0].orientation_type).toBe(GuideOrientationType.HORIZONTAL);
    expect(comp2.guides[0].position).toBe(300.0);
  });

  test("test_add_guide_returns_index", () => {
    const project = parse_aep(SAMPLES_DIR.div("guides.aep")).project;
    const comp = get_comp(project, "guides_none");
    expect(comp.add_guide(0, 100)).toBe(0);
    expect(comp.add_guide(1, 200)).toBe(1);
    expect(comp.add_guide(0, 300)).toBe(2);
  });

  test("test_add_guide_invalid_orientation_defaults_horizontal", () => {
    const project = parse_aep(SAMPLES_DIR.div("guides.aep")).project;
    const comp = get_comp(project, "guides_none");
    comp.add_guide(99, 100);
    expect(comp.guides[0].orientation_type).toBe(GuideOrientationType.HORIZONTAL);
  });

  test("test_add_guide_invariant", () => {
    const project = parse_aep(SAMPLES_DIR.div("guides.aep")).project;
    const comp = get_comp(project, "guides_both");
    comp.add_guide(0, 123);
    expect(len(as_instance(comp._ldat, LdatChunk).items)).toBe(as_instance(comp._lhd3, Lhd3Chunk).count);
  });
});

describe("TestRemoveGuide", () => {
  /** Tests for Item.remove_guide(). */

  test("test_remove_guide_first", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("guides.aep")).project;
    const comp = get_comp(project, "guides_both");
    const original_count = len(comp.guides);
    const second_guide_pos = comp.guides[1].position;

    comp.remove_guide(0);
    expect(len(comp.guides)).toBe(original_count - 1);
    expect(comp.guides[0].position).toBe(second_guide_pos);

    const out = tmp_path.div("remove_first.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "guides_both");
    expect(len(comp2.guides)).toBe(original_count - 1);
    expect(comp2.guides[0].position).toBe(second_guide_pos);
  });

  test("test_remove_guide_last_remaining", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("guides.aep")).project;
    const comp = get_comp(project, "guides_horizontal");
    expect(len(comp.guides)).toBe(1);

    comp.remove_guide(0);
    expect(py_eq(comp.guides, [])).toBe(true);
    // After Effects always keeps an (empty) LIST:Gide for an item even with
    // zero guides; deleting the container entirely leaves a project AE opens
    // but cannot re-save. The container stays with count 0 and no ldat.
    expect(comp._gide != null).toBe(true);
    py_assert(comp._lhd3 != null);
    expect(comp._lhd3.count).toBe(0);
    expect(comp._ldat == null).toBe(true);

    const out = tmp_path.div("remove_last.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "guides_horizontal");
    expect(py_eq(comp2.guides, [])).toBe(true);
  });

  test("test_remove_guide_invalid_index_raises", () => {
    const project = parse_aep(SAMPLES_DIR.div("guides.aep")).project;
    const comp = get_comp(project, "guides_horizontal");
    raises(IndexError, () => {
      comp.remove_guide(5);
    });
    raises(IndexError, () => {
      comp.remove_guide(-1);
    });
  });

  test("test_remove_guide_invariant", () => {
    const project = parse_aep(SAMPLES_DIR.div("guides.aep")).project;
    const comp = get_comp(project, "guides_both");
    comp.remove_guide(0);
    expect(len(as_instance(comp._ldat, LdatChunk).items)).toBe(as_instance(comp._lhd3, Lhd3Chunk).count);
  });

  test("test_remove_all_then_add", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("guides.aep")).project;
    const comp = get_comp(project, "guides_horizontal");
    comp.remove_guide(0);
    expect(py_eq(comp.guides, [])).toBe(true);

    const idx = comp.add_guide(1, 400);
    expect(idx).toBe(0);
    expect(comp.guides[0].orientation_type).toBe(GuideOrientationType.VERTICAL);

    const out = tmp_path.div("remove_add.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "guides_horizontal");
    expect(len(comp2.guides)).toBe(1);
    expect(comp2.guides[0].orientation_type).toBe(GuideOrientationType.VERTICAL);
    expect(comp2.guides[0].position).toBe(400.0);
  });
});

describe("TestRemoveAllGuides", () => {
  /** Tests for Item.remove_all_guides(). */

  test("test_remove_all_guides", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("guides.aep")).project;
    const comp = get_comp(project, "guides_both");
    expect(len(comp.guides) > 1).toBe(true);

    comp.remove_all_guides();
    expect(py_eq(comp.guides, [])).toBe(true);
    // Same end state as removing the last guide by index: the empty
    // LIST:Gide stays, its ldat is dropped.
    py_assert(comp._lhd3 != null);
    expect(comp._lhd3.count).toBe(0);
    expect(comp._ldat == null).toBe(true);

    const out = tmp_path.div("remove_all_guides.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "guides_both");
    expect(py_eq(comp2.guides, [])).toBe(true);
  });

  test("test_remove_all_guides_noop", () => {
    const project = parse_aep(SAMPLES_DIR.div("guides.aep")).project;
    const comp = get_comp(project, "guides_none");
    expect(py_eq(comp.guides, [])).toBe(true);
    comp.remove_all_guides();
    expect(py_eq(comp.guides, [])).toBe(true);
  });

  test("test_remove_all_then_add", () => {
    const project = parse_aep(SAMPLES_DIR.div("guides.aep")).project;
    const comp = get_comp(project, "guides_both");
    comp.remove_all_guides();
    expect(comp.add_guide(1, 250)).toBe(0);
    expect(comp.guides[0].position).toBe(250.0);
  });
});

describe("TestRoundtripDraft3d", () => {
  /** Roundtrip tests for CompItem.draft3d. */

  test("test_toggle_draft3d", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("renderer_classic_3d.aep")).project;
    const comp = at(project.compositions, 0);

    comp.draft3d = true;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const comp2 = at(parse_aep(out).project.compositions, 0);
    expect(comp2.draft3d).toBe(true);

    comp2.draft3d = false;
    const out2 = tmp_path.div("toggled.aep");
    parse_aep(out).project.save(out2);
    // Re-parse to check original state preserved
    const project3 = parse_aep(out).project;
    const comp3 = at(project3.compositions, 0);
    comp3.draft3d = false;
    const out3 = tmp_path.div("toggled_back.aep");
    project3.save(out3);
    const comp4 = at(parse_aep(out3).project.compositions, 0);
    expect(comp4.draft3d).toBe(false);
  });
});

describe("TestRoundtripPreserveNested", () => {
  /** Roundtrip tests for CompItem.preserve_nested_*. */

  test("test_toggle_preserve_nested_frame_rate", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("comp_flags.aep")).project;
    const comp = get_comp(project, "preserveNestedFrameRate_true");
    expect(comp.preserve_nested_frame_rate).toBe(true);

    comp.preserve_nested_frame_rate = false;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "preserveNestedFrameRate_true");
    expect(comp2.preserve_nested_frame_rate).toBe(false);
  });

  test("test_toggle_preserve_nested_resolution", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("comp_flags.aep")).project;
    const comp = get_comp(project, "preserveNestedResolution_true");
    expect(comp.preserve_nested_resolution).toBe(true);

    comp.preserve_nested_resolution = false;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "preserveNestedResolution_true");
    expect(comp2.preserve_nested_resolution).toBe(false);
  });
});

describe("TestRoundtripDropFrame", () => {
  /** Roundtrip tests for CompItem.drop_frame. */

  test("test_toggle_drop_frame", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("dropFrame.aep")).project;
    const comp = get_comp(project, "dropFrame_true");
    expect(comp.drop_frame).toBe(true);

    comp.drop_frame = false;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "dropFrame_true");
    expect(comp2.drop_frame).toBe(false);
  });
});

describe("TestRoundtripEssentialGraphics", () => {
  /** Roundtrip tests for Essential Graphics panel. */

  test("test_rename_template", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(EG_SAMPLES_DIR.div("fill_color_added.aep")).project;
    // Python `next(c for c in ... if ...)`; `next_(....find(...))` is the TS twin.
    const comp = next_(project.compositions.find((c) => c.name === "primary"));
    expect(comp.motion_graphics_template_name).toBe("Untitled");

    comp.motion_graphics_template_name = "My New Name";
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const comp2 = next_(parse_aep(out).project.compositions.find((c) => c.name === "primary"));
    expect(comp2.motion_graphics_template_name).toBe("My New Name");
  });

  test("test_rename_controller", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(EG_SAMPLES_DIR.div("fill_color_added.aep")).project;
    const comp = next_(project.compositions.find((c) => c.name === "primary"));
    expect(comp.motion_graphics_controllers[0].name).toBe("Fill Color");

    comp.motion_graphics_controllers[0].name = "New Controller Name";
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const comp2 = next_(parse_aep(out).project.compositions.find((c) => c.name === "primary"));
    expect(comp2.motion_graphics_controllers[0].name).toBe("New Controller Name");
  });

  test("test_rename_multiple_controllers", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(EG_SAMPLES_DIR.div("multiple_controllers.aep")).project;
    const comp = next_(project.compositions.find((c) => c.name === "primary"));

    comp.motion_graphics_controllers[1].name = "Renamed Opacity";
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const comp2 = next_(parse_aep(out).project.compositions.find((c) => c.name === "primary"));
    expect(comp2.motion_graphics_controllers[0].name).toBe("Brightness");
    expect(comp2.motion_graphics_controllers[1].name).toBe("Renamed Opacity");
    expect(comp2.motion_graphics_controllers[2].name).toBe("Background Color");
  });

  test("test_create_template_name", () => {
    /**
     * Setting motion_graphics_template_name on a comp without EG
     * creates the CIF3 chunk structure and roundtrips correctly.
     */
    const tmp_path = make_tmp_path();
    const project = parse_aep(EG_SAMPLES_DIR.div("base.aep")).project;
    const comp = next_(project.compositions.find((c) => c.name === "main"));
    expect(comp.motion_graphics_template_name).toBe("Untitled");

    // Overwrite existing template name
    comp.motion_graphics_template_name = "Brand New Template";
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const comp2 = next_(parse_aep(out).project.compositions.find((c) => c.name === "main"));
    expect(comp2.motion_graphics_template_name).toBe("Brand New Template");
  });

  test("test_create_template_name_from_scratch", () => {
    /**
     * Setting motion_graphics_template_name when _eg_template_name_utf8
     * is None creates a new CIF3 chunk structure in memory.
     */
    const project = parse_aep(EG_SAMPLES_DIR.div("base.aep")).project;
    const comp = next_(project.compositions.find((c) => c.name === "main"));
    // Force deferred EG parsing, then clear to simulate from-scratch.
    comp._ensure_comp_parsed();
    comp._eg_template_name_utf8 = null;
    expect(comp.motion_graphics_template_name == null).toBe(true);

    comp.motion_graphics_template_name = "Created Template";
    expect(comp.motion_graphics_template_name).toBe("Created Template");
    expect(comp.motion_graphics_template_controller_count).toBe(0);
  });
});

describe("TestRoundtripFrameRateRetiming", () => {
  /**
   * Retiming behaviour of CompItem.frame_rate.
   *
   * After Effects keeps keyframe times fixed in SECONDS across a frame-rate
   * change, storing them as an integer count of `internal_timebase` units
   * (`seconds = time_units / internal_timebase`). Every expected value below
   * was measured on AE 2026.
   */

  // Python @staticmethod `_keyed`; plain generator function since the describe block is the class.
  function* _keyed(comp: CompItem): Generator<Property> {
    for (const prop of comp._walk_properties()) {
      if (py_bool(prop.keyframes)) yield prop;
    }
  }

  // Python @staticmethod `_layer_marker`; plain function since the describe block is the class.
  function _layer_marker(comp: CompItem): Property {
    for (const layer of comp.layers) {
      for (const child of layer) {
        if (getattr(child, "match_name", "") === "ADBE Marker") return as_instance(child, Property);
      }
    }
    // Python next(...) with no default raises StopIteration here.
    throw new StopIteration();
  }

  test("test_keyframe_times_hold_in_seconds", () => {
    /**
     * 24 -> 30 fps must not move any keyframe. Before the fix these
     * drifted to [0, 2.4, 4.8, 7.2]: the frame indices were preserved
     * instead of the times.
     */
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(PROPERTY_SAMPLES_DIR.div("keyframe_misc.aep"));
    const comp = at(project.compositions, 0);
    const before = new Map(
      Array.from(_keyed(comp), (p) => [p.match_name, p.keyframes.map((k) => k.time)] as const),
    );
    expect(py_eq(getitem(before, "ADBE Scale"), [0.0, 3.0, 6.0, 9.0])).toBe(true);

    comp.frame_rate = 30.0;
    const out = tmp_path.div("modified.aep");
    project.save(out);

    const comp2 = at(parse_aep(out).project.compositions, 0);
    const after = new Map(
      Array.from(_keyed(comp2), (p) => [p.match_name, p.keyframes.map((k) => k.time)] as const),
    );
    expect(comp2.frame_rate).toBe(30.0);
    expect(py_eq(after, before)).toBe(true);
  });

  test("test_time_units_rescale_by_timebase_ratio", () => {
    /**
     * 25 -> 30 moves internal_timebase 25600 -> 30720, so every stored
     * unit count scales by 1.2.
     */
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(PROPERTY_SAMPLES_DIR.div("effect_point_speed.aep"));
    const comp = at(project.compositions, 0);
    expect(comp.frame_rate).toBe(25.0);
    expect(comp._cdta.internal_timebase).toBe(25600);
    const before = new Map(
      Array.from(_keyed(comp), (p) => [p.match_name, p.keyframes.map((k) => k._ldat_item.time_units)] as const),
    );

    comp.frame_rate = 30.0;
    const out = tmp_path.div("modified.aep");
    project.save(out);

    const comp2 = at(parse_aep(out).project.compositions, 0);
    expect(comp2._cdta.internal_timebase).toBe(30720);
    for (const prop of _keyed(comp2)) {
      const expected = getitem(before, prop.match_name).map((u) => round((u * 30720) / 25600));
      expect(py_eq(prop.keyframes.map((k) => k._ldat_item.time_units), expected)).toBe(true);
    }
  });

  test("test_no_rescale_when_only_time_scale_moves", () => {
    /**
     * 30 -> 60 keeps internal_timebase at 30720 and halves time_scale, so
     * the stored unit counts must NOT change. The seconds must not drift
     * either, which needs the cached conversion factors refreshed.
     */
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(PROPERTY_SAMPLES_DIR.div("keyframe_misc.aep"));
    const comp = at(project.compositions, 0);
    comp.frame_rate = 30.0;
    const units_at_30 = new Map(
      Array.from(_keyed(comp), (p) => [p.match_name, p.keyframes.map((k) => k._ldat_item.time_units)] as const),
    );
    const seconds_at_30 = new Map(
      Array.from(_keyed(comp), (p) => [p.match_name, p.keyframes.map((k) => k.time)] as const),
    );

    comp.frame_rate = 60.0;
    const out = tmp_path.div("modified.aep");
    project.save(out);

    const comp2 = at(parse_aep(out).project.compositions, 0);
    expect(comp2._cdta.internal_timebase).toBe(30720);
    expect(comp2.time_scale).toBe(2.0);
    for (const prop of _keyed(comp2)) {
      const name = prop.match_name;
      expect(py_eq(prop.keyframes.map((k) => k._ldat_item.time_units), getitem(units_at_30, name))).toBe(true);
      expect(py_eq(prop.keyframes.map((k) => k.time), getitem(seconds_at_30, name))).toBe(true);
    }
  });

  test("test_tdb4_time_base_is_restamped", () => {
    /**
     * AE writes cdta.internal_timebase into every property tdb4 and
     * rejects the file when the copy is wrong.
     */
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(PROPERTY_SAMPLES_DIR.div("keyframe_misc.aep"));
    const comp = at(project.compositions, 0);
    comp.frame_rate = 30.0;
    const out = tmp_path.div("modified.aep");
    project.save(out);

    const comp2 = at(parse_aep(out).project.compositions, 0);
    const timebase = comp2._cdta.internal_timebase;
    expect(timebase).toBe(30720);
    const stamps = new Set(
      [...comp2._walk_properties()]
        .filter((p) => p._tdb4 != null && p._is_live())
        .map((p) => p._tdb4._time_base),
    );
    expect(py_eq(stamps, new Set([timebase]))).toBe(true);
  });

  test("test_duration_requantizes_by_rounding", () => {
    /**
     * A 253-frame 24 fps comp is 263.54 frames at 25 fps. AE rounds to
     * 264 (10.56 s); truncating would give 263 (10.52 s).
     */
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(PROPERTY_SAMPLES_DIR.div("keyframe_misc.aep"));
    const comp = at(project.compositions, 0);
    comp.duration = 253.0 / 24.0;

    comp.frame_rate = 25.0;
    const out = tmp_path.div("modified.aep");
    project.save(out);

    const comp2 = at(parse_aep(out).project.compositions, 0);
    expect(approx(comp2.duration, 10.56)).toBe(true);
    expect(round(comp2.duration * 25.0)).toBe(264);
  });

  test.each(["comp_marker.aep", "layer_marker.aep"])(
    "test_marker_times_hold_in_seconds[%#]",
    (sample: string) => {
      /**
       * Markers are keyframes on a marker property, so they ride the same
       * rescale, on the comp and on the layer alike.
       */
      const tmp_path = make_tmp_path();
      const on_comp = sample.startsWith("comp");
      const project = parse_project_fresh(MARKER_SAMPLES_DIR.div(sample));
      const comp = at(project.compositions, 0);
      const marker = on_comp ? comp.marker_property : _layer_marker(comp);
      py_assert(marker != null);
      marker.keyframes[0].time = 3.0;

      comp.frame_rate = 30.0;
      const out = tmp_path.div("modified.aep");
      project.save(out);

      const comp2 = at(parse_aep(out).project.compositions, 0);
      const marker2 = on_comp ? comp2.marker_property : _layer_marker(comp2);
      py_assert(marker2 != null);
      expect(marker2.keyframes[0].time).toBe(3.0);
    },
  );

  test("test_nested_comp_is_untouched", () => {
    /**
     * Changing the outer frame rate leaves a precomp source alone: its
     * own rate, duration and timebase all hold.
     */
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("duplicate.aep"));
    const outer = get_comp(project, "DupSrc");
    const inner = get_comp(project, "Inner");
    const before = [inner.frame_rate, inner.duration, inner._cdta.internal_timebase];

    outer.frame_rate = 60.0;
    const out = tmp_path.div("modified.aep");
    project.save(out);

    const inner2 = get_comp(parse_aep(out).project, "Inner");
    expect(
      py_eq(
        [inner2.frame_rate, inner2.duration, inner2._cdta.internal_timebase],
        before,
      ),
    ).toBe(true);
  });

  test("test_noop_write_changes_nothing", () => {
    /**
     * Writing the frame rate a comp already has must not retime it, or
     * tooling that echoes values back would requantize timings that are
     * legitimately off-grid.
     */
    const project = parse_project_fresh(PROPERTY_SAMPLES_DIR.div("keyframe_misc.aep"));
    const comp = at(project.compositions, 0);
    comp.duration = 253.0 / 24.0;
    const before_duration = comp.duration;
    const before_units = Array.from(_keyed(comp)).flatMap((p) =>
      p.keyframes.map((k) => k._ldat_item.time_units),
    );

    comp.frame_rate = comp.frame_rate;

    expect(comp.duration).toBe(before_duration);
    expect(
      py_eq(
        Array.from(_keyed(comp)).flatMap((p) => p.keyframes.map((k) => k._ldat_item.time_units)),
        before_units,
      ),
    ).toBe(true);
  });

  test.each([
    // The cdta duration AE 2026 stores after the same rate change:
    // the nearest frame, half a frame rounding up, in units of the
    // new timebase.
    [24.0, 12, 25.0, 13312, 25600],
    [24.0, 253, 25.0, 270336, 25600],
    [30.0, 300, 23.976, 240000, 23976],
    [23.976, 52, 24.0, 53248, 24576],
    [24.0, 12, 30.0, 15360, 30720],
  ])(
    "test_duration_snaps_like_ae[%#]",
    (fps: number, frames: number, new_fps: number, dividend: number, divisor: number) => {
      const tmp_path = make_tmp_path();
      const project = parse_project_fresh(SAMPLES_DIR.div("comp_misc.aep"));
      const comp = project.root_folder.add_comp("retimed", 100, 100, 1.0, 10.0, fps);
      comp.duration = frames / fps;
      comp.frame_rate = new_fps;
      const out = tmp_path.div("retimed.aep");
      project.save(out);
      const cdta = get_comp(parse_aep(out).project, "retimed")._cdta;
      expect(py_eq([cdta.duration_dividend, cdta.duration_divisor], [dividend, divisor])).toBe(true);
    },
  );

  test("test_work_area_and_time_snap_like_ae", () => {
    /**
     * AE 2026, 24 -> 25 fps: the work area's start (frame 12) and end
     * (frame 73) snap on their own - 13 and 76, so its 61 frames become 63,
     * not the 64 they would round to alone - and the current time snaps
     * with them. The display start is left alone.
     */
    const project = parse_project_fresh(SAMPLES_DIR.div("comp_misc.aep"));
    const comp = project.root_folder.add_comp("retimed", 100, 100, 1.0, 10.0, 24.0);
    comp.work_area_start = 12 / 24;
    comp.work_area_duration = 61 / 24;
    comp.display_start_time = 12 / 24;
    comp.time = 12 / 24;
    comp.frame_rate = 25.0;
    const cdta = comp._cdta;
    expect(py_eq([cdta.work_area_start_dividend, cdta.work_area_start_divisor], [13312, 25600])).toBe(true);
    expect(py_eq([cdta.work_area_end_dividend, cdta.work_area_end_divisor], [77824, 25600])).toBe(true);
    expect(py_eq([cdta.time_dividend, cdta.time_divisor], [13312, 25600])).toBe(true);
    expect(approx(comp.work_area_duration, 2.52)).toBe(true);
    expect(comp.display_start_time).toBe(0.5);
  });
});
