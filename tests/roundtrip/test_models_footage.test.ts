/** Tests for FootageItem model parsing. */

import { describe, expect, test } from "bun:test";
import { isclose, Path, py_assert, py_eq, StopIteration, ValueError } from "../../src/pyrt/index.ts";
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
    const source = footage.mainSource;
    expect(source.loop).toBe(3);

    source.loop = 5;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = get_footage(parse_aep(out).project, "loop_3").mainSource;
    expect(source2.loop).toBe(5);
  });

  test("test_loop_validation_rejects_zero", () => {
    const source = get_footage(
      parse_project_fresh(SAMPLES_DIR.div("footage_misc.aep")),
      "loop_3",
    ).mainSource;
    raises(ValueError, () => {
      source.loop = 0;
    }, "must be >= 1");
  });

  test("test_loop_validation_rejects_too_high", () => {
    const source = get_footage(
      parse_project_fresh(SAMPLES_DIR.div("footage_misc.aep")),
      "loop_3",
    ).mainSource;
    raises(ValueError, () => {
      source.loop = 10000;
    }, "must be <= 9999");
  });
});

describe("TestRoundtripInvertAlpha", () => {
  /** Roundtrip tests for FootageSource.invertAlpha. */

  test("test_modify_invert_alpha", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("footage_misc.aep")).project;
    const footage = get_footage(project, "invertAlpha_true");
    const source = footage.mainSource;
    expect(source.invertAlpha).toBe(true);

    source.invertAlpha = false;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = get_footage(parse_aep(out).project, "invertAlpha_true").mainSource;
    expect(source2.invertAlpha).toBe(false);
  });
});

describe("TestRoundtripHighQualityFieldSeparation", () => {
  /** Roundtrip tests for FootageSource.highQualityFieldSeparation. */

  test("test_modify_high_quality_field_separation", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("footage_misc.aep")).project;
    const footage = get_footage(project, "highQualityFieldSeparation_true");
    const source = footage.mainSource;
    expect(source.highQualityFieldSeparation).toBe(true);

    source.highQualityFieldSeparation = false;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = get_footage(
      parse_aep(out).project,
      "highQualityFieldSeparation_true",
    ).mainSource;
    expect(source2.highQualityFieldSeparation).toBe(false);
  });
});

describe("TestRoundtripAlphaMode", () => {
  /** Roundtrip tests for FootageSource.alphaMode. */

  test("test_modify_alpha_mode_straight_to_premultiplied", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("alphaMode.aep")).project;
    const footage = get_footage(project, "alphaMode_STRAIGHT");
    const source = footage.mainSource;
    expect(source.alphaMode).toBe(AlphaMode.STRAIGHT);

    source.alphaMode = AlphaMode.PREMULTIPLIED;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = get_footage(parse_aep(out).project, "alphaMode_STRAIGHT").mainSource;
    expect(source2.alphaMode).toBe(AlphaMode.PREMULTIPLIED);
  });

  test("test_modify_alpha_mode_to_ignore", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("alphaMode.aep")).project;
    const footage = get_footage(project, "alphaMode_STRAIGHT");
    const source = footage.mainSource;

    source.alphaMode = AlphaMode.IGNORE;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = get_footage(parse_aep(out).project, "alphaMode_STRAIGHT").mainSource;
    expect(source2.alphaMode).toBe(AlphaMode.IGNORE);
  });

  test("test_alpha_mode_validation_rejects_invalid", () => {
    const source = get_footage(
      parse_project_fresh(SAMPLES_DIR.div("alphaMode.aep")),
      "alphaMode_STRAIGHT",
    ).mainSource;
    raises(ValueError, () => {
      // @ts-expect-error deliberately invalid: Python's type-ignored assignment
      source.alphaMode = 999;
    }, "Invalid value.*alphaMode");
  });
});

describe("TestRoundtripFieldSeparationType", () => {
  /** Roundtrip tests for FootageSource.fieldSeparationType. */

  test("test_modify_field_separation_upper_to_lower", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("fieldSeparationType.aep")).project;
    const footage = get_footage(project, "fieldSeparationType_UPPER");
    const source = footage.mainSource;
    expect(source.fieldSeparationType).toBe(FieldSeparationType.UPPER_FIELD_FIRST);

    source.fieldSeparationType = FieldSeparationType.LOWER_FIELD_FIRST;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = get_footage(
      parse_aep(out).project,
      "fieldSeparationType_UPPER",
    ).mainSource;
    expect(source2.fieldSeparationType).toBe(FieldSeparationType.LOWER_FIELD_FIRST);
  });

  test("test_modify_field_separation_to_off", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("fieldSeparationType.aep")).project;
    const footage = get_footage(project, "fieldSeparationType_UPPER");
    const source = footage.mainSource;

    source.fieldSeparationType = FieldSeparationType.OFF;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = get_footage(
      parse_aep(out).project,
      "fieldSeparationType_UPPER",
    ).mainSource;
    expect(source2.fieldSeparationType).toBe(FieldSeparationType.OFF);
  });

  test("test_field_separation_type_validation_rejects_invalid", () => {
    const source = get_footage(
      parse_project_fresh(SAMPLES_DIR.div("fieldSeparationType.aep")),
      "fieldSeparationType_UPPER",
    ).mainSource;
    raises(ValueError, () => {
      // @ts-expect-error deliberately invalid: Python's type-ignored assignment
      source.fieldSeparationType = "invalid";
    }, "is not a valid FieldSeparationType");
  });
});

describe("TestRoundtripPremulColor", () => {
  /** Roundtrip tests for FootageSource.premulColor. */

  test("test_modify_premul_color", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("premulColor.aep")).project;
    const footage = get_footage(project, "premulColor_red");
    const source = footage.mainSource;

    source.premulColor = [0.0, 1.0, 0.5];
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = get_footage(parse_aep(out).project, "premulColor_red").mainSource;
    expect(isclose(source2.premulColor[0], 0.0, 1e-9, 0.005)).toBe(true);
    expect(isclose(source2.premulColor[1], 1.0, 1e-9, 0.005)).toBe(true);
    expect(isclose(source2.premulColor[2], 0.5, 1e-9, 0.02)).toBe(true);
  });

  test("test_premul_color_validation_rejects_bad_length", () => {
    const source = get_footage(
      parse_project_fresh(SAMPLES_DIR.div("premulColor.aep")),
      "premulColor_red",
    ).mainSource;
    raises(ValueError, () => {
      source.premulColor = [0.1, 0.2];
    }, "expected 3 elements");
  });

  test("test_premul_color_validation_rejects_out_of_range", () => {
    const source = get_footage(
      parse_project_fresh(SAMPLES_DIR.div("premulColor.aep")),
      "premulColor_red",
    ).mainSource;
    raises(ValueError, () => {
      source.premulColor = [1.5, 0.0, 0.0];
    }, "must be <= 1(\\.0)?");
  });
});

describe("TestRoundtripConformFrameRate", () => {
  /** Roundtrip tests for FootageSource.conformFrameRate. */

  test("test_modify_conform_frame_rate", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("conformFrameRate.aep")).project;
    const footage = get_footage(project, "conformFrameRate_30");
    const source = footage.mainSource;
    expect(source.conformFrameRate).toBe(30.0);

    source.conformFrameRate = 24.0;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = get_footage(parse_aep(out).project, "conformFrameRate_30").mainSource;
    expect(source2.conformFrameRate).toBe(24.0);
  });

  test("test_modify_conform_frame_rate_to_zero", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("conformFrameRate.aep")).project;
    const footage = get_footage(project, "conformFrameRate_30");
    const source = footage.mainSource;

    source.conformFrameRate = 0.0;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = get_footage(parse_aep(out).project, "conformFrameRate_30").mainSource;
    expect(source2.conformFrameRate).toBe(0.0);
  });

  test("test_modify_conform_frame_rate_fractional", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("conform_frame_rate_2.5.aep")).project;
    const footage = project.footages[0];
    const source = footage.mainSource;
    expect(source.conformFrameRate).toBe(2.5);

    source.conformFrameRate = 29.97;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = parse_aep(out).project.footages[0].mainSource;
    expect(isclose(source2.conformFrameRate, 29.97, 1e-4)).toBe(true);
  });

  test("test_conform_frame_rate_validation_rejects_negative", () => {
    const source = get_footage(
      parse_project_fresh(SAMPLES_DIR.div("conformFrameRate.aep")),
      "conformFrameRate_30",
    ).mainSource;
    raises(ValueError, () => {
      source.conformFrameRate = -1.0;
    }, "must be >= 0");
  });

  test("test_conform_frame_rate_validation_rejects_too_high", () => {
    const source = get_footage(
      parse_project_fresh(SAMPLES_DIR.div("conformFrameRate.aep")),
      "conformFrameRate_30",
    ).mainSource;
    raises(ValueError, () => {
      source.conformFrameRate = 1000.0;
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
    project.footages[0].mainSource.conformFrameRate = rate;
    const out = tmp_path.div("conformed.aep");
    project.save(out);
    expect(parse_aep(out).project.footages[0].duration).toBe(duration);
  });

  test("test_conformed_duration_loops", () => {
    // AE 2026: conformed to 24 fps and looped twice, the movie lasts 4 s.
    const footage = parse_project_fresh(
      SAMPLES_DIR.div("conform_frame_rate_2.5.aep"),
    ).footages[0];
    footage.mainSource.conformFrameRate = 24.0;
    footage.mainSource.loop = 2;
    expect(footage.duration).toBe(4.0);
  });

  test("test_frame_duration_counts_every_frame", () => {
    // The 48-frame 23.976 movie: its 16.16 stored rate puts duration x
    // rate at 47.99995, which truncation would make 47 frames.
    const footage = parse_project_fresh(
      SAMPLES_DIR.div("conform_frame_rate_2.5.aep"),
    ).footages[0];
    footage.mainSource.conformFrameRate = 0.0;
    expect(footage.frameDuration).toBe(48);
  });
});

describe("TestPlaceholderConformFrameRate", () => {
  /**
   * A placeholder keeps its rate in the native slot, like a sequence, but
   * its duration stays in seconds (AE 2026).
   */

  const _placeholder = (): [Project, FootageItem] => {
    const project = parse_project_fresh(SAMPLES_DIR.div("placeholder.aep"));
    return [project, project.importPlaceholder("PH", 640, 480, 24.0, 10.0)];
  };

  test("test_reads_its_rate", () => {
    const [, item] = _placeholder();
    expect(item.mainSource.conformFrameRate).toBe(24.0);
  });

  test("test_write_keeps_the_duration", () => {
    const tmp_path = make_tmp_path();
    const [project, item] = _placeholder();
    item.mainSource.conformFrameRate = 25.0;
    const out = tmp_path.div("placeholder.aep");
    project.save(out);
    const reparsed = parse_aep(out).project.footages.find((f) => f.id === item.id);
    if (reparsed == null) throw new StopIteration();
    const sspc = reparsed.mainSource._sspc;
    expect(py_eq([sspc.native_frame_rate, sspc.conform_frame_rate], [25.0, 0.0])).toBe(true);
    expect(reparsed.mainSource.conformFrameRate).toBe(25.0);
    expect(reparsed.frameRate).toBe(25.0);
    expect(reparsed.duration).toBe(10.0);
  });

  test("test_zero_is_ignored", () => {
    const [, item] = _placeholder();
    item.mainSource.conformFrameRate = 0.0;
    expect(item.mainSource.conformFrameRate).toBe(24.0);
  });

  test("test_a_stored_conform_reads_like_ae", () => {
    // py_aep used to store a placeholder's conform in the conform slot;
    // AE 2026 opens such a file at the conform rate, still 10 s long.
    const [, item] = _placeholder();
    item.mainSource._sspc.conform_frame_rate = 25.0;
    expect(item.mainSource.conformFrameRate).toBe(25.0);
    expect(item.frameRate).toBe(25.0);
    expect(item.duration).toBe(10.0);
  });
});

describe("TestRemovePulldown", () => {
  /** Roundtrip tests for FootageSource.removePulldown. */

  test("test_read_off", () => {
    const source = as_instance(get_first_footage(
      parse_project_fresh(SAMPLES_DIR.div("conform_frame_rate_2.5_uff_off.aep")),
    ), FootageItem).mainSource;
    expect(source.removePulldown).toBe(PulldownPhase.OFF);
  });

  test("test_read_wssww", () => {
    const source = as_instance(get_first_footage(
      parse_project_fresh(SAMPLES_DIR.div("conform_frame_rate_2.5_uff_wssww.aep")),
    ), FootageItem).mainSource;
    expect(source.removePulldown).toBe(PulldownPhase.WSSWW);
  });

  test("test_read_sswww", () => {
    const source = as_instance(get_first_footage(
      parse_project_fresh(SAMPLES_DIR.div("conform_frame_rate_2.5_uff_sswww.aep")),
    ), FootageItem).mainSource;
    expect(source.removePulldown).toBe(PulldownPhase.SSWWW);
  });

  test("test_read_wwwsw_24p", () => {
    const source = as_instance(get_first_footage(
      parse_project_fresh(SAMPLES_DIR.div("conform_frame_rate_2.5_uff_wwwsw.aep")),
    ), FootageItem).mainSource;
    expect(source.removePulldown).toBe(PulldownPhase.WWWSW_24P_ADVANCE);
  });

  test("test_modify_pulldown", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("conform_frame_rate_2.5_uff_off.aep")).project;
    const source = project.footages[0].mainSource;
    expect(source.removePulldown).toBe(PulldownPhase.OFF);

    source.removePulldown = PulldownPhase.WSSWW;
    const out = tmp_path.div("out.aep");
    project.save(out);
    const source2 = parse_aep(out).project.footages[0].mainSource;
    expect(source2.removePulldown).toBe(PulldownPhase.WSSWW);
  });

  test("test_modify_pulldown_updates_display_frame_rate", () => {
    const source = as_instance(get_first_footage(
      parse_project_fresh(SAMPLES_DIR.div("conform_frame_rate_2.5_uff_off.aep")),
    ), FootageItem).mainSource;
    expect(source.displayFrameRate).toBe(2.5);
    source.removePulldown = PulldownPhase.WSSWW;
    expect(source.displayFrameRate).toBe(2.0);
  });
});

describe("TestInterpretAsLinearLight", () => {
  /** Tests for FootageSource.interpretAsLinearLight. */

  test("test_off", () => {
    const source = as_instance(get_first_footage(
      parse_project_fresh(SAMPLES_DIR.div("interpret_as_linear_light_off.aep")),
    ), FootageItem).mainSource;
    expect(source.interpretAsLinearLight).toBe(LinearLightMode.OFF);
  });

  test("test_on", () => {
    const source = as_instance(get_first_footage(
      parse_project_fresh(SAMPLES_DIR.div("interpret_as_linear_light_on.aep")),
    ), FootageItem).mainSource;
    expect(source.interpretAsLinearLight).toBe(LinearLightMode.ON);
  });

  test("test_on_for_32_bpc", () => {
    const source = as_instance(get_first_footage(
      parse_project_fresh(SAMPLES_DIR.div("interpret_as_linear_light_on_for_32_bpc.aep")),
    ), FootageItem).mainSource;
    expect(source.interpretAsLinearLight).toBe(LinearLightMode.ON_FOR_32BPC);
  });

  test("test_is_writable", () => {
    const source = as_instance(get_first_footage(
      parse_project_fresh(SAMPLES_DIR.div("interpret_as_linear_light_off.aep")),
    ), FootageItem).mainSource;
    source.interpretAsLinearLight = LinearLightMode.ON;
    expect(source.interpretAsLinearLight).toBe(LinearLightMode.ON);
  });

  test("test_modify_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("interpret_as_linear_light_off.aep")).project;
    const source = as_instance(get_first_footage(project), FootageItem).mainSource;
    expect(source.interpretAsLinearLight).toBe(LinearLightMode.OFF);

    source.interpretAsLinearLight = LinearLightMode.ON;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = as_instance(get_first_footage(parse_aep(out).project), FootageItem).mainSource;
    expect(source2.interpretAsLinearLight).toBe(LinearLightMode.ON);
  });
});

describe("TestPreserveRgb", () => {
  /** Tests for FootageSource.preserveRgb. */

  test("test_on", () => {
    const source = as_instance(get_first_footage(
      parse_project_fresh(SAMPLES_DIR.div("preserve_rgb_on.aep")),
    ), FootageItem).mainSource;
    expect(source.preserveRgb).toBe(true);
  });

  test("test_off", () => {
    const source = as_instance(get_first_footage(
      parse_project_fresh(SAMPLES_DIR.div("preserve_rgb_off.aep")),
    ), FootageItem).mainSource;
    expect(source.preserveRgb).toBe(false);
  });

  test("test_is_writable", () => {
    const source = as_instance(get_first_footage(
      parse_project_fresh(SAMPLES_DIR.div("preserve_rgb_on.aep")),
    ), FootageItem).mainSource;
    source.preserveRgb = false;
    expect(source.preserveRgb).toBe(false);
  });
});

describe("TestRoundtripSolidColor", () => {
  /** Roundtrip tests for SolidSource.color. */

  test("test_modify_color", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("solid_colors.aep")).project;
    const comp = get_comp(project, "solid_color_red");
    const source = as_instance(as_instance(as_instance(comp.layers[0], AVLayer).source, FootageItem).mainSource, SolidSource);

    // Modify
    source.color = [0.1, 0.2, 0.3];

    // Save and re-parse
    const out = tmp_path.div("modified_solid.aep");
    project.save(out);
    const re_project = parse_aep(out).project;
    const source2 = as_instance(
      as_instance(as_instance(get_comp(re_project, "solid_color_red").layers[0], AVLayer).source, FootageItem).mainSource,
      SolidSource,
    );

    expect(isclose(source2.color[0], 0.1, 1e-9, 0.005)).toBe(true);
    expect(isclose(source2.color[1], 0.2, 1e-9, 0.005)).toBe(true);
    expect(isclose(source2.color[2], 0.3, 1e-9, 0.005)).toBe(true);
  });

  test("test_validation_rejects_bad_length", () => {
    const project = parse_project_fresh(SAMPLES_DIR.div("solid_colors.aep"));
    const source = as_instance(
      as_instance(as_instance(get_comp(project, "solid_color_red").layers[0], AVLayer).source, FootageItem).mainSource,
      SolidSource,
    );
    raises(ValueError, () => {
      source.color = [0.1, 0.2];
    }, "expected 3 elements");
  });

  test("test_validation_rejects_out_of_range", () => {
    const project = parse_project_fresh(SAMPLES_DIR.div("solid_colors.aep"));
    const source = as_instance(
      as_instance(as_instance(get_comp(project, "solid_color_red").layers[0], AVLayer).source, FootageItem).mainSource,
      SolidSource,
    );
    raises(ValueError, () => {
      source.color = [1.5, 0.0, 0.0];
    }, "must be <= 1(\\.0)?");
  });
});

describe("TestRoundtripMediaColorSpace", () => {
  /** Roundtrip tests for FootageSource.mediaColorSpace. */

  const _first_source = (project: Project) => {
    const item = get_first_footage(project);
    py_assert(item != null);
    return item.mainSource;
  };

  test.skipIf(!_ACES12_AVAILABLE)("test_set_ocio_colorspace", () => {
    const tmp_path = make_tmp_path();
    // The project's config is the built-in ACES 1.2, where the color space
    // is named "ACES - ACEScg" (family "ACES"). AE stores a direct pick's
    // colorProfileName as "<family>/<name>", so that is what reads back.
    const project = parse_aep(SAMPLES_DIR.div("override_media_colorspace_embedded.aep")).project;
    _first_source(project).mediaColorSpace = "ACES - ACEScg";

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = _first_source(parse_aep(out).project);
    expect(source2.mediaColorSpace).toBe("ACES/ACES - ACEScg");
    // Byte-exact against AE's own direct-pick sample.
    const ocsp = source2._ocsp_utf8();
    const ae = parse_aep(SAMPLES_DIR.div("cms_acescg_colorspace.aep")).project;
    const ae_ocsp = _first_source(ae)._ocsp_utf8();
    py_assert(ocsp != null && ae_ocsp != null);
    expect(py_eq(ocsp.value, ae_ocsp.value)).toBe(true);
  });

  test.skipIf(!_ACES12_AVAILABLE)("test_set_ocio_name_absent_from_config_raises", () => {
    // "ACEScg" is not in ACES 1.2 (it is "ACES - ACEScg"). py used to
    // fabricate an envelope for it; the config is authoritative.
    const project = parse_aep(SAMPLES_DIR.div("override_media_colorspace_embedded.aep")).project;
    raises(ValueError, () => {
      _first_source(project).mediaColorSpace = "ACEScg";
    }, "not a color space");
  });

  test("test_set_working_color_space", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("override_media_colorspace_embedded.aep")).project;
    _first_source(project).mediaColorSpace = "Working Color Space";

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = _first_source(parse_aep(out).project);
    expect(source2.mediaColorSpace).toBe("Working Color Space");
    // AE-fidelity (verified via aep-compare): the ocsp envelope is emptied.
    const ocsp = source2._ocsp_utf8();
    py_assert(ocsp != null);
    expect(py_eq(ocsp.value, "")).toBe(true);
  });

  test("test_set_embedded_reverts_override", () => {
    const tmp_path = make_tmp_path();
    // Start from an Apple RGB override, set back to Embedded.
    const project = parse_aep(SAMPLES_DIR.div("override_media_colorspace_apple_rgb.aep")).project;
    const source = _first_source(project);
    expect(source.mediaColorSpace).toBe("Apple RGB");
    source.mediaColorSpace = "Embedded";

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = _first_source(parse_aep(out).project);
    expect(source2.mediaColorSpace).toBe("Embedded");
  });

  test.skipIf(!_ACES12_AVAILABLE)("test_set_ocio_then_back_to_embedded", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("override_media_colorspace_embedded.aep")).project;
    const source = _first_source(project);
    source.mediaColorSpace = "ACES - ACEScg";
    expect(source.mediaColorSpace).toBe("ACES/ACES - ACEScg");
    source.mediaColorSpace = "Embedded";

    const out = tmp_path.div("modified.aep");
    project.save(out);
    expect(_first_source(parse_aep(out).project).mediaColorSpace).toBe("Embedded");
  });

  test.skipIf(!_ACES12_AVAILABLE)("test_set_ocio_role", () => {
    const tmp_path = make_tmp_path();
    // A role pick stores the role's TARGET with ocioColorSpaceType 2 - a
    // different envelope from a direct pick of that same color space.
    const project = parse_aep(SAMPLES_DIR.div("override_media_colorspace_embedded.aep")).project;
    _first_source(project).mediaColorSpace = "matte_paint";

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = _first_source(parse_aep(out).project);
    expect(source2.mediaColorSpace).toBe("Utility - sRGB - Texture");
    const ocsp = source2._ocsp_utf8();
    const ae = parse_aep(SAMPLES_DIR.div("cms_matte_paint_role.aep")).project;
    const ae_ocsp = _first_source(ae)._ocsp_utf8();
    py_assert(ocsp != null && ae_ocsp != null);
    expect(py_eq(ocsp.value, ae_ocsp.value)).toBe(true);
  });

  test.skipIf(!_ACES12_AVAILABLE)("test_qualified_name_round_trips", () => {
    // The getter returns "<family>/<name>" for a direct pick; assigning
    // that straight back must reproduce the same envelope.
    const project = parse_aep(SAMPLES_DIR.div("cms_acescg_colorspace.aep")).project;
    const source = _first_source(project);
    const before = source._ocsp_utf8();
    py_assert(before != null);
    const original = before.value;
    expect(source.mediaColorSpace).toBe("ACES/ACES - ACEScg");
    source.mediaColorSpace = source.mediaColorSpace;
    const after = source._ocsp_utf8();
    py_assert(after != null);
    expect(py_eq(after.value, original)).toBe(true);
  });

  test("test_unresolvable_config_raises", () => {
    const project = parse_aep(SAMPLES_DIR.div("cms_acescg_colorspace.aep")).project;
    project.ocioConfigurationFile = String.raw`\\nope\missing\nowhere.ocio`;
    raises(ValueError, () => {
      _first_source(project).mediaColorSpace = "ACES - ACEScg";
    }, "Cannot resolve");
  });

  test.skipIf(!_ICC_AVAILABLE)("test_set_adobe_profile", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("override_media_colorspace_embedded.aep")).project;
    _first_source(project).mediaColorSpace = "Apple RGB";

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const source2 = _first_source(parse_aep(out).project);
    expect(source2.mediaColorSpace).toBe("Apple RGB");
    // apid is the catalogued ICC profile ID (matches AE ground truth).
    const apid = as_instance(source2._clrs, ListChunk).chunks.find((c) => c.chunk_type === "apid");
    if (apid == null) throw new StopIteration();
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

  const _first_solid = (project: Project): FootageItem => {
    const solid = project.footages.find((f) => f.mainSource instanceof SolidSource);
    if (solid == null) throw new StopIteration();
    return solid;
  };

  test("test_rename_solid_persists", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("solid_colors.aep")).project;
    const solid = _first_solid(project);
    solid.name = "Renamed Solid Item";

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const reparsed = parse_aep(out).project.footages.find((f) => f.id === solid.id);
    if (reparsed == null) throw new StopIteration();
    expect(py_eq(reparsed.name, "Renamed Solid Item")).toBe(true);
  });

  test("test_rename_solid_stores_name_in_opti_not_item_utf8", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("solid_colors.aep")).project;
    const solid = _first_solid(project);
    solid.name = "Opti Backed";

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const reparsed = parse_aep(out).project.footages.find((f) => f.id === solid.id);
    if (reparsed == null) throw new StopIteration();
    expect(py_eq(reparsed.mainSource._opti.solid_name, "Opti Backed")).toBe(true);
    expect(py_eq(as_instance(reparsed._name_utf8, Utf8Chunk).value, "")).toBe(true);
  });

  test("test_rename_placeholder_persists", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("placeholder.aep")).project;
    const placeholder = get_footage(project, "placeholder_720p");
    placeholder.name = "Renamed Placeholder";

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const reparsed = parse_aep(out).project.footages.find((f) => f.id === placeholder.id);
    if (reparsed == null) throw new StopIteration();
    expect(py_eq(reparsed.name, "Renamed Placeholder")).toBe(true);
    expect(py_eq(reparsed.mainSource._opti.placeholder_name, "Renamed Placeholder")).toBe(true);
    expect(py_eq(as_instance(reparsed._name_utf8, Utf8Chunk).value, "")).toBe(true);
  });

  test("test_rename_file_footage_persists", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("footage_misc.aep")).project;
    const footage = get_footage(project, "loop_3");
    footage.name = "Renamed File Item";

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const reparsed = parse_aep(out).project.footages.find((f) => f.id === footage.id);
    if (reparsed == null) throw new StopIteration();
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
    const reparsed = parse_aep(out).project.footages.find((f) => f.id === solid.id);
    if (reparsed == null) throw new StopIteration();
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
    const reparsed = parse_aep(out).project.footages.find((f) => f.id === footage.id);
    if (reparsed == null) throw new StopIteration();
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
