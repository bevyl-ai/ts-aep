/** Tests for FootageItem model parsing. */

import { describe, expect, test } from "bun:test";
import { isclose, Path, py_assert, py_eq, ValueError } from "../../src/pyrt/index.ts";
import { make_tmp_path, raises } from "../../src/pyrt/pytest.ts";
import { AlphaMode, AVLayer, FieldSeparationType, FootageItem, LinearLightMode, PulldownPhase, SolidSource, parse as parse_aep } from "../../src/py_aep/index.ts";
import type { Project } from "../../src/py_aep/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { ListChunk } from "../../src/py_aep/binary/chunk.ts";
import { Utf8Chunk } from "../../src/py_aep/binary/scalar_chunks.ts";
import { default_icc_directories } from "../../src/py_aep/color/icc.ts";
import { resolve_ocio_config } from "../../src/py_aep/color/ocio.ts";
import { profile_id_for_name } from "../../src/py_aep/enums/mappings.ts";
import { as_instance, get_comp, get_first_footage, get_footage, parse_project_fresh } from "../helpers.ts";

const SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models", "footage");
// Adobe-CMS ICC embedding needs the installed Adobe Color profiles on disk.
const _ICC_AVAILABLE = Array.from(default_icc_directories()).some((d) => d.is_dir());
// The OCIO byte-fidelity tests below pick color spaces by their ACES 1.2 names
// and compare against AE-authored samples; both need AE's bundled "ACES 1.2"
// config, which is absent on CI (no AE install).
const _ACES12_AVAILABLE = resolve_ocio_config("ACES 1.2") != null;

describe("TestRoundtripLoop", () => {
  /** Roundtrip tests for FootageSource.loop. */

  test("test_modify_loop", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("footage_misc.aep")).project;
    const footage = get_footage(project, "loop_3");
    const source = footage.main_source;
    expect(source.loop).toBe(3);

    source.loop = 5;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = get_footage(parse_aep(out).project, "loop_3").main_source;
    expect(source2.loop).toBe(5);
  });

  test("test_loop_validation_rejects_zero", () => {
    const source = get_footage(
      parse_project_fresh(SAMPLES_DIR.div("footage_misc.aep")),
      "loop_3",
    ).main_source;
    raises(ValueError, () => {
      source.loop = 0;
    }, "must be >= 1");
  });

  test("test_loop_validation_rejects_too_high", () => {
    const source = get_footage(
      parse_project_fresh(SAMPLES_DIR.div("footage_misc.aep")),
      "loop_3",
    ).main_source;
    raises(ValueError, () => {
      source.loop = 10000;
    }, "must be <= 9999");
  });
});

describe("TestRoundtripInvertAlpha", () => {
  /** Roundtrip tests for FootageSource.invert_alpha. */

  test("test_modify_invert_alpha", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("footage_misc.aep")).project;
    const footage = get_footage(project, "invertAlpha_true");
    const source = footage.main_source;
    expect(source.invert_alpha).toBe(true);

    source.invert_alpha = false;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = get_footage(parse_aep(out).project, "invertAlpha_true").main_source;
    expect(source2.invert_alpha).toBe(false);
  });
});

describe("TestRoundtripHighQualityFieldSeparation", () => {
  /** Roundtrip tests for FootageSource.high_quality_field_separation. */

  test("test_modify_high_quality_field_separation", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("footage_misc.aep")).project;
    const footage = get_footage(project, "highQualityFieldSeparation_true");
    const source = footage.main_source;
    expect(source.high_quality_field_separation).toBe(true);

    source.high_quality_field_separation = false;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = get_footage(
      parse_aep(out).project,
      "highQualityFieldSeparation_true",
    ).main_source;
    expect(source2.high_quality_field_separation).toBe(false);
  });
});

describe("TestRoundtripAlphaMode", () => {
  /** Roundtrip tests for FootageSource.alpha_mode. */

  test("test_modify_alpha_mode_straight_to_premultiplied", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("alphaMode.aep")).project;
    const footage = get_footage(project, "alphaMode_STRAIGHT");
    const source = footage.main_source;
    expect(source.alpha_mode).toBe(AlphaMode.STRAIGHT);

    source.alpha_mode = AlphaMode.PREMULTIPLIED;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = get_footage(parse_aep(out).project, "alphaMode_STRAIGHT").main_source;
    expect(source2.alpha_mode).toBe(AlphaMode.PREMULTIPLIED);
  });

  test("test_modify_alpha_mode_to_ignore", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("alphaMode.aep")).project;
    const footage = get_footage(project, "alphaMode_STRAIGHT");
    const source = footage.main_source;

    source.alpha_mode = AlphaMode.IGNORE;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = get_footage(parse_aep(out).project, "alphaMode_STRAIGHT").main_source;
    expect(source2.alpha_mode).toBe(AlphaMode.IGNORE);
  });

  test("test_alpha_mode_validation_rejects_invalid", () => {
    const source = get_footage(
      parse_project_fresh(SAMPLES_DIR.div("alphaMode.aep")),
      "alphaMode_STRAIGHT",
    ).main_source;
    raises(ValueError, () => {
      (source as any).alpha_mode = 999; // deliberately invalid: Python's type-ignored assignment
    }, "Invalid value.*alpha_mode");
  });
});

describe("TestRoundtripFieldSeparationType", () => {
  /** Roundtrip tests for FootageSource.field_separation_type. */

  test("test_modify_field_separation_upper_to_lower", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("fieldSeparationType.aep")).project;
    const footage = get_footage(project, "fieldSeparationType_UPPER");
    const source = footage.main_source;
    expect(source.field_separation_type).toBe(FieldSeparationType.UPPER_FIELD_FIRST);

    source.field_separation_type = FieldSeparationType.LOWER_FIELD_FIRST;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = get_footage(
      parse_aep(out).project,
      "fieldSeparationType_UPPER",
    ).main_source;
    expect(source2.field_separation_type).toBe(FieldSeparationType.LOWER_FIELD_FIRST);
  });

  test("test_modify_field_separation_to_off", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("fieldSeparationType.aep")).project;
    const footage = get_footage(project, "fieldSeparationType_UPPER");
    const source = footage.main_source;

    source.field_separation_type = FieldSeparationType.OFF;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = get_footage(
      parse_aep(out).project,
      "fieldSeparationType_UPPER",
    ).main_source;
    expect(source2.field_separation_type).toBe(FieldSeparationType.OFF);
  });

  test("test_field_separation_type_validation_rejects_invalid", () => {
    const source = get_footage(
      parse_project_fresh(SAMPLES_DIR.div("fieldSeparationType.aep")),
      "fieldSeparationType_UPPER",
    ).main_source;
    raises(ValueError, () => {
      (source as any).field_separation_type = "invalid"; // deliberately invalid: Python's type-ignored assignment
    }, "is not a valid FieldSeparationType");
  });
});

describe("TestRoundtripPremulColor", () => {
  /** Roundtrip tests for FootageSource.premul_color. */

  test("test_modify_premul_color", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("premulColor.aep")).project;
    const footage = get_footage(project, "premulColor_red");
    const source = footage.main_source;

    source.premul_color = [0.0, 1.0, 0.5];
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = get_footage(parse_aep(out).project, "premulColor_red").main_source;
    expect(isclose(source2.premul_color[0], 0.0, 1e-9, 0.005)).toBe(true);
    expect(isclose(source2.premul_color[1], 1.0, 1e-9, 0.005)).toBe(true);
    expect(isclose(source2.premul_color[2], 0.5, 1e-9, 0.02)).toBe(true);
  });

  test("test_premul_color_validation_rejects_bad_length", () => {
    const source = get_footage(
      parse_project_fresh(SAMPLES_DIR.div("premulColor.aep")),
      "premulColor_red",
    ).main_source;
    raises(ValueError, () => {
      source.premul_color = [0.1, 0.2];
    }, "expected 3 elements");
  });

  test("test_premul_color_validation_rejects_out_of_range", () => {
    const source = get_footage(
      parse_project_fresh(SAMPLES_DIR.div("premulColor.aep")),
      "premulColor_red",
    ).main_source;
    raises(ValueError, () => {
      source.premul_color = [1.5, 0.0, 0.0];
    }, "must be <= 1(\\.0)?");
  });
});

describe("TestRoundtripConformFrameRate", () => {
  /** Roundtrip tests for FootageSource.conform_frame_rate. */

  test("test_modify_conform_frame_rate", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("conformFrameRate.aep")).project;
    const footage = get_footage(project, "conformFrameRate_30");
    const source = footage.main_source;
    expect(source.conform_frame_rate).toBe(30.0);

    source.conform_frame_rate = 24.0;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = get_footage(parse_aep(out).project, "conformFrameRate_30").main_source;
    expect(source2.conform_frame_rate).toBe(24.0);
  });

  test("test_modify_conform_frame_rate_to_zero", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("conformFrameRate.aep")).project;
    const footage = get_footage(project, "conformFrameRate_30");
    const source = footage.main_source;

    source.conform_frame_rate = 0.0;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = get_footage(parse_aep(out).project, "conformFrameRate_30").main_source;
    expect(source2.conform_frame_rate).toBe(0.0);
  });

  test("test_modify_conform_frame_rate_fractional", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("conform_frame_rate_2.5.aep")).project;
    const footage = project.footages[0];
    const source = footage.main_source;
    expect(source.conform_frame_rate).toBe(2.5);

    source.conform_frame_rate = 29.97;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = parse_aep(out).project.footages[0].main_source;
    expect(isclose(source2.conform_frame_rate, 29.97, 1e-4)).toBe(true);
  });

  test("test_conform_frame_rate_validation_rejects_negative", () => {
    const source = get_footage(
      parse_project_fresh(SAMPLES_DIR.div("conformFrameRate.aep")),
      "conformFrameRate_30",
    ).main_source;
    raises(ValueError, () => {
      source.conform_frame_rate = -1.0;
    }, "must be >= 0");
  });

  test("test_conform_frame_rate_validation_rejects_too_high", () => {
    const source = get_footage(
      parse_project_fresh(SAMPLES_DIR.div("conformFrameRate.aep")),
      "conformFrameRate_30",
    ).main_source;
    raises(ValueError, () => {
      source.conform_frame_rate = 1000.0;
    }, "must be <= 999");
  });

  test.each([
    [24.0, 2.0],
    [25.0, 1.92],
    [30.0, 1.6],
    [12.5, 3.84],
  ])("test_conformed_duration_is_frame_count_over_rate[%#]", (rate: number, duration: number) => {
    const tmp_path = make_tmp_path();
    /**
     * The sample's 48-frame 23.976 movie plays those 48 frames at the
     * conform rate. The durations are what AE 2026 reports for the same
     * conform.
     */
    const project = parse_aep(SAMPLES_DIR.div("conform_frame_rate_2.5.aep")).project;
    project.footages[0].main_source.conform_frame_rate = rate;
    const out = tmp_path.div("conformed.aep");
    project.save(out);
    expect(parse_aep(out).project.footages[0].duration).toBe(duration);
  });

  test("test_conformed_duration_loops", () => {
    // AE 2026: conformed to 24 fps and looped twice, the movie lasts 4 s.
    const footage = parse_project_fresh(
      SAMPLES_DIR.div("conform_frame_rate_2.5.aep"),
    ).footages[0];
    footage.main_source.conform_frame_rate = 24.0;
    footage.main_source.loop = 2;
    expect(footage.duration).toBe(4.0);
  });

  test("test_frame_duration_counts_every_frame", () => {
    // The 48-frame 23.976 movie: its 16.16 stored rate puts duration x
    // rate at 47.99995, which truncation would make 47 frames.
    const footage = parse_project_fresh(
      SAMPLES_DIR.div("conform_frame_rate_2.5.aep"),
    ).footages[0];
    footage.main_source.conform_frame_rate = 0.0;
    expect(footage.frame_duration).toBe(48);
  });
});

describe("TestPlaceholderConformFrameRate", () => {
  /**
   * A placeholder keeps its rate in the native slot, like a sequence, but
   * its duration stays in seconds (AE 2026).
   */

  const _placeholder = (): [Project, FootageItem] => {
    const project = parse_project_fresh(SAMPLES_DIR.div("placeholder.aep"));
    return [project, project.import_placeholder("PH", 640, 480, 24.0, 10.0)];
  };

  test("test_reads_its_rate", () => {
    const [, item] = _placeholder();
    expect(item.main_source.conform_frame_rate).toBe(24.0);
  });

  test("test_write_keeps_the_duration", () => {
    const tmp_path = make_tmp_path();
    const [project, item] = _placeholder();
    item.main_source.conform_frame_rate = 25.0;
    const out = tmp_path.div("placeholder.aep");
    project.save(out);
    const reparsed = parse_aep(out).project.footages.find((f) => f.id === item.id)!;
    const sspc = reparsed.main_source._sspc;
    expect(py_eq([sspc.native_frame_rate, sspc.conform_frame_rate], [25.0, 0.0])).toBe(true);
    expect(reparsed.main_source.conform_frame_rate).toBe(25.0);
    expect(reparsed.frame_rate).toBe(25.0);
    expect(reparsed.duration).toBe(10.0);
  });

  test("test_zero_is_ignored", () => {
    const [, item] = _placeholder();
    item.main_source.conform_frame_rate = 0.0;
    expect(item.main_source.conform_frame_rate).toBe(24.0);
  });

  test("test_a_stored_conform_reads_like_ae", () => {
    // py_aep used to store a placeholder's conform in the conform slot;
    // AE 2026 opens such a file at the conform rate, still 10 s long.
    const [, item] = _placeholder();
    item.main_source._sspc.conform_frame_rate = 25.0;
    expect(item.main_source.conform_frame_rate).toBe(25.0);
    expect(item.frame_rate).toBe(25.0);
    expect(item.duration).toBe(10.0);
  });
});

describe("TestRemovePulldown", () => {
  /** Roundtrip tests for FootageSource.remove_pulldown. */

  test("test_read_off", () => {
    const source = get_first_footage(
      parse_project_fresh(SAMPLES_DIR.div("conform_frame_rate_2.5_uff_off.aep")),
    )!.main_source;
    expect(source.remove_pulldown).toBe(PulldownPhase.OFF);
  });

  test("test_read_wssww", () => {
    const source = get_first_footage(
      parse_project_fresh(SAMPLES_DIR.div("conform_frame_rate_2.5_uff_wssww.aep")),
    )!.main_source;
    expect(source.remove_pulldown).toBe(PulldownPhase.WSSWW);
  });

  test("test_read_sswww", () => {
    const source = get_first_footage(
      parse_project_fresh(SAMPLES_DIR.div("conform_frame_rate_2.5_uff_sswww.aep")),
    )!.main_source;
    expect(source.remove_pulldown).toBe(PulldownPhase.SSWWW);
  });

  test("test_read_wwwsw_24p", () => {
    const source = get_first_footage(
      parse_project_fresh(SAMPLES_DIR.div("conform_frame_rate_2.5_uff_wwwsw.aep")),
    )!.main_source;
    expect(source.remove_pulldown).toBe(PulldownPhase.WWWSW_24P_ADVANCE);
  });

  test("test_modify_pulldown", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("conform_frame_rate_2.5_uff_off.aep")).project;
    const source = project.footages[0].main_source;
    expect(source.remove_pulldown).toBe(PulldownPhase.OFF);

    source.remove_pulldown = PulldownPhase.WSSWW;
    const out = tmp_path.div("out.aep");
    project.save(out);
    const source2 = parse_aep(out).project.footages[0].main_source;
    expect(source2.remove_pulldown).toBe(PulldownPhase.WSSWW);
  });

  test("test_modify_pulldown_updates_display_frame_rate", () => {
    const source = get_first_footage(
      parse_project_fresh(SAMPLES_DIR.div("conform_frame_rate_2.5_uff_off.aep")),
    )!.main_source;
    expect(source.display_frame_rate).toBe(2.5);
    source.remove_pulldown = PulldownPhase.WSSWW;
    expect(source.display_frame_rate).toBe(2.0);
  });
});

describe("TestInterpretAsLinearLight", () => {
  /** Tests for FootageSource.interpret_as_linear_light. */

  test("test_off", () => {
    const source = get_first_footage(
      parse_project_fresh(SAMPLES_DIR.div("interpret_as_linear_light_off.aep")),
    )!.main_source;
    expect(source.interpret_as_linear_light).toBe(LinearLightMode.OFF);
  });

  test("test_on", () => {
    const source = get_first_footage(
      parse_project_fresh(SAMPLES_DIR.div("interpret_as_linear_light_on.aep")),
    )!.main_source;
    expect(source.interpret_as_linear_light).toBe(LinearLightMode.ON);
  });

  test("test_on_for_32_bpc", () => {
    const source = get_first_footage(
      parse_project_fresh(SAMPLES_DIR.div("interpret_as_linear_light_on_for_32_bpc.aep")),
    )!.main_source;
    expect(source.interpret_as_linear_light).toBe(LinearLightMode.ON_FOR_32BPC);
  });

  test("test_is_writable", () => {
    const source = get_first_footage(
      parse_project_fresh(SAMPLES_DIR.div("interpret_as_linear_light_off.aep")),
    )!.main_source;
    source.interpret_as_linear_light = LinearLightMode.ON;
    expect(source.interpret_as_linear_light).toBe(LinearLightMode.ON);
  });

  test("test_modify_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("interpret_as_linear_light_off.aep")).project;
    const source = get_first_footage(project)!.main_source;
    expect(source.interpret_as_linear_light).toBe(LinearLightMode.OFF);

    source.interpret_as_linear_light = LinearLightMode.ON;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = get_first_footage(parse_aep(out).project)!.main_source;
    expect(source2.interpret_as_linear_light).toBe(LinearLightMode.ON);
  });
});

describe("TestPreserveRgb", () => {
  /** Tests for FootageSource.preserve_rgb. */

  test("test_on", () => {
    const source = get_first_footage(
      parse_project_fresh(SAMPLES_DIR.div("preserve_rgb_on.aep")),
    )!.main_source;
    expect(source.preserve_rgb).toBe(true);
  });

  test("test_off", () => {
    const source = get_first_footage(
      parse_project_fresh(SAMPLES_DIR.div("preserve_rgb_off.aep")),
    )!.main_source;
    expect(source.preserve_rgb).toBe(false);
  });

  test("test_is_writable", () => {
    const source = get_first_footage(
      parse_project_fresh(SAMPLES_DIR.div("preserve_rgb_on.aep")),
    )!.main_source;
    source.preserve_rgb = false;
    expect(source.preserve_rgb).toBe(false);
  });
});

describe("TestRoundtripSolidColor", () => {
  /** Roundtrip tests for SolidSource.color. */

  test("test_modify_color", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("solid_colors.aep")).project;
    const comp = get_comp(project, "solid_color_red");
    const source = as_instance(as_instance(as_instance(comp.layers[0], AVLayer).source, FootageItem).main_source, SolidSource);

    // Modify
    source.color = [0.1, 0.2, 0.3];

    // Save and re-parse
    const out = tmp_path.div("modified_solid.aep");
    project.save(out);
    const re_project = parse_aep(out).project;
    const source2 = as_instance(
      as_instance(as_instance(get_comp(re_project, "solid_color_red").layers[0], AVLayer).source, FootageItem).main_source,
      SolidSource,
    );

    expect(isclose(source2.color[0], 0.1, 1e-9, 0.005)).toBe(true);
    expect(isclose(source2.color[1], 0.2, 1e-9, 0.005)).toBe(true);
    expect(isclose(source2.color[2], 0.3, 1e-9, 0.005)).toBe(true);
  });

  test("test_validation_rejects_bad_length", () => {
    const project = parse_project_fresh(SAMPLES_DIR.div("solid_colors.aep"));
    const source = as_instance(
      as_instance(as_instance(get_comp(project, "solid_color_red").layers[0], AVLayer).source, FootageItem).main_source,
      SolidSource,
    );
    raises(ValueError, () => {
      source.color = [0.1, 0.2];
    }, "expected 3 elements");
  });

  test("test_validation_rejects_out_of_range", () => {
    const project = parse_project_fresh(SAMPLES_DIR.div("solid_colors.aep"));
    const source = as_instance(
      as_instance(as_instance(get_comp(project, "solid_color_red").layers[0], AVLayer).source, FootageItem).main_source,
      SolidSource,
    );
    raises(ValueError, () => {
      source.color = [1.5, 0.0, 0.0];
    }, "must be <= 1(\\.0)?");
  });
});

describe("TestRoundtripMediaColorSpace", () => {
  /** Roundtrip tests for FootageSource.media_color_space. */

  const _first_source = (project: Project) => {
    const item = get_first_footage(project);
    py_assert(item != null);
    return item.main_source;
  };

  test.skipIf(!_ACES12_AVAILABLE)("test_set_ocio_colorspace", () => {
    const tmp_path = make_tmp_path();
    // The project's config is the built-in ACES 1.2, where the color space
    // is named "ACES - ACEScg" (family "ACES"). AE stores a direct pick's
    // colorProfileName as "<family>/<name>", so that is what reads back.
    const project = parse_aep(SAMPLES_DIR.div("override_media_colorspace_embedded.aep")).project;
    _first_source(project).media_color_space = "ACES - ACEScg";

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = _first_source(parse_aep(out).project);
    expect(source2.media_color_space).toBe("ACES/ACES - ACEScg");
    // Byte-exact against AE's own direct-pick sample.
    const ocsp = source2._ocsp_utf8();
    const ae = parse_aep(SAMPLES_DIR.div("cms_acescg_colorspace.aep")).project;
    const ae_ocsp = _first_source(ae)._ocsp_utf8();
    expect(ocsp != null && ae_ocsp != null).toBe(true);
    expect(py_eq(ocsp!.value, ae_ocsp!.value)).toBe(true);
  });

  test.skipIf(!_ACES12_AVAILABLE)("test_set_ocio_name_absent_from_config_raises", () => {
    // "ACEScg" is not in ACES 1.2 (it is "ACES - ACEScg"). py used to
    // fabricate an envelope for it; the config is authoritative.
    const project = parse_aep(SAMPLES_DIR.div("override_media_colorspace_embedded.aep")).project;
    raises(ValueError, () => {
      _first_source(project).media_color_space = "ACEScg";
    }, "not a color space");
  });

  test("test_set_working_color_space", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("override_media_colorspace_embedded.aep")).project;
    _first_source(project).media_color_space = "Working Color Space";

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = _first_source(parse_aep(out).project);
    expect(source2.media_color_space).toBe("Working Color Space");
    // AE-fidelity (verified via aep-compare): the ocsp envelope is emptied.
    const ocsp = source2._ocsp_utf8();
    expect(ocsp != null).toBe(true);
    expect(py_eq(ocsp!.value, "")).toBe(true);
  });

  test("test_set_embedded_reverts_override", () => {
    const tmp_path = make_tmp_path();
    // Start from an Apple RGB override, set back to Embedded.
    const project = parse_aep(SAMPLES_DIR.div("override_media_colorspace_apple_rgb.aep")).project;
    const source = _first_source(project);
    expect(source.media_color_space).toBe("Apple RGB");
    source.media_color_space = "Embedded";

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = _first_source(parse_aep(out).project);
    expect(source2.media_color_space).toBe("Embedded");
  });

  test.skipIf(!_ACES12_AVAILABLE)("test_set_ocio_then_back_to_embedded", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("override_media_colorspace_embedded.aep")).project;
    const source = _first_source(project);
    source.media_color_space = "ACES - ACEScg";
    expect(source.media_color_space).toBe("ACES/ACES - ACEScg");
    source.media_color_space = "Embedded";

    const out = tmp_path.div("modified.aep");
    project.save(out);
    expect(_first_source(parse_aep(out).project).media_color_space).toBe("Embedded");
  });

  test.skipIf(!_ACES12_AVAILABLE)("test_set_ocio_role", () => {
    const tmp_path = make_tmp_path();
    // A role pick stores the role's TARGET with ocioColorSpaceType 2 - a
    // different envelope from a direct pick of that same color space.
    const project = parse_aep(SAMPLES_DIR.div("override_media_colorspace_embedded.aep")).project;
    _first_source(project).media_color_space = "matte_paint";

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = _first_source(parse_aep(out).project);
    expect(source2.media_color_space).toBe("Utility - sRGB - Texture");
    const ocsp = source2._ocsp_utf8();
    const ae = parse_aep(SAMPLES_DIR.div("cms_matte_paint_role.aep")).project;
    const ae_ocsp = _first_source(ae)._ocsp_utf8();
    expect(ocsp != null && ae_ocsp != null).toBe(true);
    expect(py_eq(ocsp!.value, ae_ocsp!.value)).toBe(true);
  });

  test.skipIf(!_ACES12_AVAILABLE)("test_qualified_name_round_trips", () => {
    // The getter returns "<family>/<name>" for a direct pick; assigning
    // that straight back must reproduce the same envelope.
    const project = parse_aep(SAMPLES_DIR.div("cms_acescg_colorspace.aep")).project;
    const source = _first_source(project);
    const before = source._ocsp_utf8();
    expect(before != null).toBe(true);
    const original = before!.value;
    expect(source.media_color_space).toBe("ACES/ACES - ACEScg");
    source.media_color_space = source.media_color_space;
    const after = source._ocsp_utf8();
    expect(after != null).toBe(true);
    expect(py_eq(after!.value, original)).toBe(true);
  });

  test("test_unresolvable_config_raises", () => {
    const project = parse_aep(SAMPLES_DIR.div("cms_acescg_colorspace.aep")).project;
    project.ocio_configuration_file = String.raw`\\nope\missing\nowhere.ocio`;
    raises(ValueError, () => {
      _first_source(project).media_color_space = "ACES - ACEScg";
    }, "Cannot resolve");
  });

  test.skipIf(!_ICC_AVAILABLE)("test_set_adobe_profile", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("override_media_colorspace_embedded.aep")).project;
    _first_source(project).media_color_space = "Apple RGB";

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = _first_source(parse_aep(out).project);
    expect(source2.media_color_space).toBe("Apple RGB");
    // apid is the catalogued ICC profile ID (matches AE ground truth).
    const apid = as_instance(source2._clrs, ListChunk).chunks.find((c) => c.chunk_type === "apid")!;
    expect(py_eq(apid.data, profile_id_for_name("Apple RGB"))).toBe(true);
  });
});

describe("TestRoundtripFootageItemName", () => {
  /**
   * Roundtrip tests for `FootageItem.name`.
   *
   * AE 2026 renames every footage type, but stores the display name in a
   * different place per source: a solid's and a placeholder's name live in
   * the source `opti` chunk (the item-level Utf8 stays empty), while file
   * footage is named through the item Utf8 chunk. `FootageItem.name` has to
   * write wherever `FootageSource._resolve_name` reads it back from, or the
   * rename is silently dropped on save.
   */

  const _first_solid = (project: Project): FootageItem =>
    project.footages.find((f) => f.main_source instanceof SolidSource)!;

  test("test_rename_solid_persists", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("solid_colors.aep")).project;
    const solid = _first_solid(project);
    solid.name = "Renamed Solid Item";

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const reparsed = parse_aep(out).project.footages.find((f) => f.id === solid.id)!;
    expect(py_eq(reparsed.name, "Renamed Solid Item")).toBe(true);
  });

  test("test_rename_solid_stores_name_in_opti_not_item_utf8", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("solid_colors.aep")).project;
    const solid = _first_solid(project);
    solid.name = "Opti Backed";

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const reparsed = parse_aep(out).project.footages.find((f) => f.id === solid.id)!;
    expect(py_eq((reparsed.main_source._opti as any).solid_name, "Opti Backed")).toBe(true);
    expect(py_eq(as_instance(reparsed._name_utf8, Utf8Chunk).value, "")).toBe(true);
  });

  test("test_rename_placeholder_persists", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("placeholder.aep")).project;
    const placeholder = get_footage(project, "placeholder_720p");
    placeholder.name = "Renamed Placeholder";

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const reparsed = parse_aep(out).project.footages.find((f) => f.id === placeholder.id)!;
    expect(py_eq(reparsed.name, "Renamed Placeholder")).toBe(true);
    expect(py_eq((reparsed.main_source._opti as any).placeholder_name, "Renamed Placeholder")).toBe(true);
    expect(py_eq(as_instance(reparsed._name_utf8, Utf8Chunk).value, "")).toBe(true);
  });

  test("test_rename_file_footage_persists", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("footage_misc.aep")).project;
    const footage = get_footage(project, "loop_3");
    footage.name = "Renamed File Item";

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const reparsed = parse_aep(out).project.footages.find((f) => f.id === footage.id)!;
    expect(py_eq(reparsed.name, "Renamed File Item")).toBe(true);
    expect(py_eq(as_instance(reparsed._name_utf8, Utf8Chunk).value, "Renamed File Item")).toBe(true);
  });

  test("test_rename_solid_accepts_255_utf8_bytes", () => {
    const tmp_path = make_tmp_path();
    // 85 three-byte characters exactly fill the usable part of the
    // 256-byte NUL-padded opti field; AE 2026 caps at the same 255 bytes.
    const name = "中".repeat(85);
    const project = parse_aep(SAMPLES_DIR.div("solid_colors.aep")).project;
    const solid = _first_solid(project);
    solid.name = name;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const reparsed = parse_aep(out).project.footages.find((f) => f.id === solid.id)!;
    expect(py_eq(reparsed.name, name)).toBe(true);
  });

  test("test_rename_solid_rejects_oversized_name", () => {
    const solid = _first_solid(parse_project_fresh(SAMPLES_DIR.div("solid_colors.aep")));
    raises(ValueError, () => {
      solid.name = "A".repeat(256);
    }, "at most 255 UTF-8 bytes");
  });

  test("test_rename_solid_rejects_oversized_multibyte_name", () => {
    // 86 three-byte characters = 258 bytes: rejected rather than
    // truncated mid-character by the fixed-width struct field.
    const solid = _first_solid(parse_project_fresh(SAMPLES_DIR.div("solid_colors.aep")));
    raises(ValueError, () => {
      solid.name = "中".repeat(86);
    }, "at most 255 UTF-8 bytes");
  });

  test("test_rename_file_footage_keeps_a_name_holding_a_separator", () => {
    const tmp_path = make_tmp_path();
    // AE accepts `dir/sub.bmp` as a file-footage name and displays it
    // verbatim, so the stored name must not be mistaken for a path and
    // stripped back to the source's basename.
    const project = parse_aep(SAMPLES_DIR.div("footage_misc.aep")).project;
    const footage = get_footage(project, "loop_3");
    footage.name = "dir/sub.mov";

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const reparsed = parse_aep(out).project.footages.find((f) => f.id === footage.id)!;
    expect(py_eq(reparsed.name, "dir/sub.mov")).toBe(true);
  });

  test("test_rename_placeholder_rejects_oversized_name", () => {
    const placeholder = get_footage(
      parse_project_fresh(SAMPLES_DIR.div("placeholder.aep")),
      "placeholder_720p",
    );
    raises(ValueError, () => {
      placeholder.name = "B".repeat(256);
    }, "at most 255 UTF-8 bytes");
  });
});
