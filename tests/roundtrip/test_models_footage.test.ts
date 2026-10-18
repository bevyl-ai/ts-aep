/** Tests for FootageItem model parsing. */

import { describe, expect, test } from "bun:test";
import { isclose, Path, pyAssert, pyEq, StopIteration, ValueError } from "../../src/pyrt/index.ts";
import { makeTmpPath, raises } from "../../src/pyrt/pytest.ts";
import { AlphaMode, AVLayer, FieldSeparationType, FootageItem, LinearLightMode, PulldownPhase, SolidSource, parse as parseAep } from "../../src/py_aep/index.ts";
import type { Project } from "../../src/py_aep/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { ListChunk } from "../../src/py_aep/binary/chunk.ts";
import { Utf8Chunk } from "../../src/py_aep/binary/scalar_chunks.ts";
import { defaultIccDirectories } from "../../src/py_aep/color/icc.ts";
import { resolveOcioConfig } from "../../src/py_aep/color/ocio.ts";
import { profileIdForName } from "../../src/py_aep/enums/mappings.ts";
import { asInstance, getComp, getFirstFootage, getFootage, parseProjectFresh } from "../helpers.ts";

const SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models", "footage");
// Adobe-CMS ICC embedding needs the installed Adobe Color profiles on disk.
const _ICC_AVAILABLE = Array.from(defaultIccDirectories()).some((d) => d.is_dir());
// The OCIO byte-fidelity tests below pick color spaces by their ACES 1.2 names
// and compare against AE-authored samples; both need AE's bundled "ACES 1.2"
// config, which is absent on CI (no AE install).
const _ACES12_AVAILABLE = resolveOcioConfig("ACES 1.2") != null;

describe("TestRoundtripLoop", () => {
  /** Roundtrip tests for FootageSource.loop. */

  test("test_modify_loop", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("footage_misc.aep")).project;
    const footage = getFootage(project, "loop_3");
    const source = footage.mainSource;
    expect(source.loop).toBe(3);

    source.loop = 5;
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const source2 = getFootage(parseAep(out).project, "loop_3").mainSource;
    expect(source2.loop).toBe(5);
  });

  test("test_loop_validation_rejects_zero", () => {
    const source = getFootage(
      parseProjectFresh(SAMPLES_DIR.div("footage_misc.aep")),
      "loop_3",
    ).mainSource;
    raises(ValueError, () => {
      source.loop = 0;
    }, "must be >= 1");
  });

  test("test_loop_validation_rejects_too_high", () => {
    const source = getFootage(
      parseProjectFresh(SAMPLES_DIR.div("footage_misc.aep")),
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
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("footage_misc.aep")).project;
    const footage = getFootage(project, "invertAlpha_true");
    const source = footage.mainSource;
    expect(source.invertAlpha).toBe(true);

    source.invertAlpha = false;
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const source2 = getFootage(parseAep(out).project, "invertAlpha_true").mainSource;
    expect(source2.invertAlpha).toBe(false);
  });
});

describe("TestRoundtripHighQualityFieldSeparation", () => {
  /** Roundtrip tests for FootageSource.highQualityFieldSeparation. */

  test("test_modify_high_quality_field_separation", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("footage_misc.aep")).project;
    const footage = getFootage(project, "highQualityFieldSeparation_true");
    const source = footage.mainSource;
    expect(source.highQualityFieldSeparation).toBe(true);

    source.highQualityFieldSeparation = false;
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const source2 = getFootage(
      parseAep(out).project,
      "highQualityFieldSeparation_true",
    ).mainSource;
    expect(source2.highQualityFieldSeparation).toBe(false);
  });
});

describe("TestRoundtripAlphaMode", () => {
  /** Roundtrip tests for FootageSource.alphaMode. */

  test("test_modify_alpha_mode_straight_to_premultiplied", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("alphaMode.aep")).project;
    const footage = getFootage(project, "alphaMode_STRAIGHT");
    const source = footage.mainSource;
    expect(source.alphaMode).toBe(AlphaMode.STRAIGHT);

    source.alphaMode = AlphaMode.PREMULTIPLIED;
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const source2 = getFootage(parseAep(out).project, "alphaMode_STRAIGHT").mainSource;
    expect(source2.alphaMode).toBe(AlphaMode.PREMULTIPLIED);
  });

  test("test_modify_alpha_mode_to_ignore", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("alphaMode.aep")).project;
    const footage = getFootage(project, "alphaMode_STRAIGHT");
    const source = footage.mainSource;

    source.alphaMode = AlphaMode.IGNORE;
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const source2 = getFootage(parseAep(out).project, "alphaMode_STRAIGHT").mainSource;
    expect(source2.alphaMode).toBe(AlphaMode.IGNORE);
  });

  test("test_alpha_mode_validation_rejects_invalid", () => {
    const source = getFootage(
      parseProjectFresh(SAMPLES_DIR.div("alphaMode.aep")),
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
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("fieldSeparationType.aep")).project;
    const footage = getFootage(project, "fieldSeparationType_UPPER");
    const source = footage.mainSource;
    expect(source.fieldSeparationType).toBe(FieldSeparationType.UPPER_FIELD_FIRST);

    source.fieldSeparationType = FieldSeparationType.LOWER_FIELD_FIRST;
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const source2 = getFootage(
      parseAep(out).project,
      "fieldSeparationType_UPPER",
    ).mainSource;
    expect(source2.fieldSeparationType).toBe(FieldSeparationType.LOWER_FIELD_FIRST);
  });

  test("test_modify_field_separation_to_off", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("fieldSeparationType.aep")).project;
    const footage = getFootage(project, "fieldSeparationType_UPPER");
    const source = footage.mainSource;

    source.fieldSeparationType = FieldSeparationType.OFF;
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const source2 = getFootage(
      parseAep(out).project,
      "fieldSeparationType_UPPER",
    ).mainSource;
    expect(source2.fieldSeparationType).toBe(FieldSeparationType.OFF);
  });

  test("test_field_separation_type_validation_rejects_invalid", () => {
    const source = getFootage(
      parseProjectFresh(SAMPLES_DIR.div("fieldSeparationType.aep")),
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
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("premulColor.aep")).project;
    const footage = getFootage(project, "premulColor_red");
    const source = footage.mainSource;

    source.premulColor = [0.0, 1.0, 0.5];
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const source2 = getFootage(parseAep(out).project, "premulColor_red").mainSource;
    expect(isclose(source2.premulColor[0], 0.0, 1e-9, 0.005)).toBe(true);
    expect(isclose(source2.premulColor[1], 1.0, 1e-9, 0.005)).toBe(true);
    expect(isclose(source2.premulColor[2], 0.5, 1e-9, 0.02)).toBe(true);
  });

  test("test_premul_color_validation_rejects_bad_length", () => {
    const source = getFootage(
      parseProjectFresh(SAMPLES_DIR.div("premulColor.aep")),
      "premulColor_red",
    ).mainSource;
    raises(ValueError, () => {
      source.premulColor = [0.1, 0.2];
    }, "expected 3 elements");
  });

  test("test_premul_color_validation_rejects_out_of_range", () => {
    const source = getFootage(
      parseProjectFresh(SAMPLES_DIR.div("premulColor.aep")),
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
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("conformFrameRate.aep")).project;
    const footage = getFootage(project, "conformFrameRate_30");
    const source = footage.mainSource;
    expect(source.conformFrameRate).toBe(30.0);

    source.conformFrameRate = 24.0;
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const source2 = getFootage(parseAep(out).project, "conformFrameRate_30").mainSource;
    expect(source2.conformFrameRate).toBe(24.0);
  });

  test("test_modify_conform_frame_rate_to_zero", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("conformFrameRate.aep")).project;
    const footage = getFootage(project, "conformFrameRate_30");
    const source = footage.mainSource;

    source.conformFrameRate = 0.0;
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const source2 = getFootage(parseAep(out).project, "conformFrameRate_30").mainSource;
    expect(source2.conformFrameRate).toBe(0.0);
  });

  test("test_modify_conform_frame_rate_fractional", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("conform_frame_rate_2.5.aep")).project;
    const footage = project.footages[0];
    const source = footage.mainSource;
    expect(source.conformFrameRate).toBe(2.5);

    source.conformFrameRate = 29.97;
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const source2 = parseAep(out).project.footages[0].mainSource;
    expect(isclose(source2.conformFrameRate, 29.97, 1e-4)).toBe(true);
  });

  test("test_conform_frame_rate_validation_rejects_negative", () => {
    const source = getFootage(
      parseProjectFresh(SAMPLES_DIR.div("conformFrameRate.aep")),
      "conformFrameRate_30",
    ).mainSource;
    raises(ValueError, () => {
      source.conformFrameRate = -1.0;
    }, "must be >= 0");
  });

  test("test_conform_frame_rate_validation_rejects_too_high", () => {
    const source = getFootage(
      parseProjectFresh(SAMPLES_DIR.div("conformFrameRate.aep")),
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
    const tmpPath = makeTmpPath();
    /**
     * The sample's 48-frame 23.976 movie plays those 48 frames at the
     * conform rate. The durations are what AE 2026 reports for the same
     * conform.
     */
    const project = parseAep(SAMPLES_DIR.div("conform_frame_rate_2.5.aep")).project;
    project.footages[0].mainSource.conformFrameRate = rate;
    const out = tmpPath.div("conformed.aep");
    project.save(out);
    expect(parseAep(out).project.footages[0].duration).toBe(duration);
  });

  test("test_conformed_duration_loops", () => {
    // AE 2026: conformed to 24 fps and looped twice, the movie lasts 4 s.
    const footage = parseProjectFresh(
      SAMPLES_DIR.div("conform_frame_rate_2.5.aep"),
    ).footages[0];
    footage.mainSource.conformFrameRate = 24.0;
    footage.mainSource.loop = 2;
    expect(footage.duration).toBe(4.0);
  });

  test("test_frame_duration_counts_every_frame", () => {
    // The 48-frame 23.976 movie: its 16.16 stored rate puts duration x
    // rate at 47.99995, which truncation would make 47 frames.
    const footage = parseProjectFresh(
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
    const project = parseProjectFresh(SAMPLES_DIR.div("placeholder.aep"));
    return [project, project.importPlaceholder("PH", 640, 480, 24.0, 10.0)];
  };

  test("test_reads_its_rate", () => {
    const [, item] = _placeholder();
    expect(item.mainSource.conformFrameRate).toBe(24.0);
  });

  test("test_write_keeps_the_duration", () => {
    const tmpPath = makeTmpPath();
    const [project, item] = _placeholder();
    item.mainSource.conformFrameRate = 25.0;
    const out = tmpPath.div("placeholder.aep");
    project.save(out);
    const reparsed = parseAep(out).project.footages.find((f) => f.id === item.id);
    if (reparsed == null) throw new StopIteration();
    const sspc = reparsed.mainSource._sspc;
    expect(pyEq([sspc.native_frame_rate, sspc.conform_frame_rate], [25.0, 0.0])).toBe(true);
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
    const source = asInstance(getFirstFootage(
      parseProjectFresh(SAMPLES_DIR.div("conform_frame_rate_2.5_uff_off.aep")),
    ), FootageItem).mainSource;
    expect(source.removePulldown).toBe(PulldownPhase.OFF);
  });

  test("test_read_wssww", () => {
    const source = asInstance(getFirstFootage(
      parseProjectFresh(SAMPLES_DIR.div("conform_frame_rate_2.5_uff_wssww.aep")),
    ), FootageItem).mainSource;
    expect(source.removePulldown).toBe(PulldownPhase.WSSWW);
  });

  test("test_read_sswww", () => {
    const source = asInstance(getFirstFootage(
      parseProjectFresh(SAMPLES_DIR.div("conform_frame_rate_2.5_uff_sswww.aep")),
    ), FootageItem).mainSource;
    expect(source.removePulldown).toBe(PulldownPhase.SSWWW);
  });

  test("test_read_wwwsw_24p", () => {
    const source = asInstance(getFirstFootage(
      parseProjectFresh(SAMPLES_DIR.div("conform_frame_rate_2.5_uff_wwwsw.aep")),
    ), FootageItem).mainSource;
    expect(source.removePulldown).toBe(PulldownPhase.WWWSW_24P_ADVANCE);
  });

  test("test_modify_pulldown", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("conform_frame_rate_2.5_uff_off.aep")).project;
    const source = project.footages[0].mainSource;
    expect(source.removePulldown).toBe(PulldownPhase.OFF);

    source.removePulldown = PulldownPhase.WSSWW;
    const out = tmpPath.div("out.aep");
    project.save(out);
    const source2 = parseAep(out).project.footages[0].mainSource;
    expect(source2.removePulldown).toBe(PulldownPhase.WSSWW);
  });

  test("test_modify_pulldown_updates_display_frame_rate", () => {
    const source = asInstance(getFirstFootage(
      parseProjectFresh(SAMPLES_DIR.div("conform_frame_rate_2.5_uff_off.aep")),
    ), FootageItem).mainSource;
    expect(source.displayFrameRate).toBe(2.5);
    source.removePulldown = PulldownPhase.WSSWW;
    expect(source.displayFrameRate).toBe(2.0);
  });
});

describe("TestInterpretAsLinearLight", () => {
  /** Tests for FootageSource.interpretAsLinearLight. */

  test("test_off", () => {
    const source = asInstance(getFirstFootage(
      parseProjectFresh(SAMPLES_DIR.div("interpret_as_linear_light_off.aep")),
    ), FootageItem).mainSource;
    expect(source.interpretAsLinearLight).toBe(LinearLightMode.OFF);
  });

  test("test_on", () => {
    const source = asInstance(getFirstFootage(
      parseProjectFresh(SAMPLES_DIR.div("interpret_as_linear_light_on.aep")),
    ), FootageItem).mainSource;
    expect(source.interpretAsLinearLight).toBe(LinearLightMode.ON);
  });

  test("test_on_for_32_bpc", () => {
    const source = asInstance(getFirstFootage(
      parseProjectFresh(SAMPLES_DIR.div("interpret_as_linear_light_on_for_32_bpc.aep")),
    ), FootageItem).mainSource;
    expect(source.interpretAsLinearLight).toBe(LinearLightMode.ON_FOR_32BPC);
  });

  test("test_is_writable", () => {
    const source = asInstance(getFirstFootage(
      parseProjectFresh(SAMPLES_DIR.div("interpret_as_linear_light_off.aep")),
    ), FootageItem).mainSource;
    source.interpretAsLinearLight = LinearLightMode.ON;
    expect(source.interpretAsLinearLight).toBe(LinearLightMode.ON);
  });

  test("test_modify_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("interpret_as_linear_light_off.aep")).project;
    const source = asInstance(getFirstFootage(project), FootageItem).mainSource;
    expect(source.interpretAsLinearLight).toBe(LinearLightMode.OFF);

    source.interpretAsLinearLight = LinearLightMode.ON;
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const source2 = asInstance(getFirstFootage(parseAep(out).project), FootageItem).mainSource;
    expect(source2.interpretAsLinearLight).toBe(LinearLightMode.ON);
  });
});

describe("TestPreserveRgb", () => {
  /** Tests for FootageSource.preserveRgb. */

  test("test_on", () => {
    const source = asInstance(getFirstFootage(
      parseProjectFresh(SAMPLES_DIR.div("preserve_rgb_on.aep")),
    ), FootageItem).mainSource;
    expect(source.preserveRgb).toBe(true);
  });

  test("test_off", () => {
    const source = asInstance(getFirstFootage(
      parseProjectFresh(SAMPLES_DIR.div("preserve_rgb_off.aep")),
    ), FootageItem).mainSource;
    expect(source.preserveRgb).toBe(false);
  });

  test("test_is_writable", () => {
    const source = asInstance(getFirstFootage(
      parseProjectFresh(SAMPLES_DIR.div("preserve_rgb_on.aep")),
    ), FootageItem).mainSource;
    source.preserveRgb = false;
    expect(source.preserveRgb).toBe(false);
  });
});

describe("TestRoundtripSolidColor", () => {
  /** Roundtrip tests for SolidSource.color. */

  test("test_modify_color", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("solid_colors.aep")).project;
    const comp = getComp(project, "solid_color_red");
    const source = asInstance(asInstance(asInstance(comp.layers[0], AVLayer).source, FootageItem).mainSource, SolidSource);

    // Modify
    source.color = [0.1, 0.2, 0.3];

    // Save and re-parse
    const out = tmpPath.div("modified_solid.aep");
    project.save(out);
    const reProject = parseAep(out).project;
    const source2 = asInstance(
      asInstance(asInstance(getComp(reProject, "solid_color_red").layers[0], AVLayer).source, FootageItem).mainSource,
      SolidSource,
    );

    expect(isclose(source2.color[0], 0.1, 1e-9, 0.005)).toBe(true);
    expect(isclose(source2.color[1], 0.2, 1e-9, 0.005)).toBe(true);
    expect(isclose(source2.color[2], 0.3, 1e-9, 0.005)).toBe(true);
  });

  test("test_validation_rejects_bad_length", () => {
    const project = parseProjectFresh(SAMPLES_DIR.div("solid_colors.aep"));
    const source = asInstance(
      asInstance(asInstance(getComp(project, "solid_color_red").layers[0], AVLayer).source, FootageItem).mainSource,
      SolidSource,
    );
    raises(ValueError, () => {
      source.color = [0.1, 0.2];
    }, "expected 3 elements");
  });

  test("test_validation_rejects_out_of_range", () => {
    const project = parseProjectFresh(SAMPLES_DIR.div("solid_colors.aep"));
    const source = asInstance(
      asInstance(asInstance(getComp(project, "solid_color_red").layers[0], AVLayer).source, FootageItem).mainSource,
      SolidSource,
    );
    raises(ValueError, () => {
      source.color = [1.5, 0.0, 0.0];
    }, "must be <= 1(\\.0)?");
  });
});

describe("TestRoundtripMediaColorSpace", () => {
  /** Roundtrip tests for FootageSource.mediaColorSpace. */

  const _firstSource = (project: Project) => {
    const item = getFirstFootage(project);
    pyAssert(item != null);
    return item.mainSource;
  };

  test.skipIf(!_ACES12_AVAILABLE)("test_set_ocio_colorspace", () => {
    const tmpPath = makeTmpPath();
    // The project's config is the built-in ACES 1.2, where the color space
    // is named "ACES - ACEScg" (family "ACES"). AE stores a direct pick's
    // colorProfileName as "<family>/<name>", so that is what reads back.
    const project = parseAep(SAMPLES_DIR.div("override_media_colorspace_embedded.aep")).project;
    _firstSource(project).mediaColorSpace = "ACES - ACEScg";

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const source2 = _firstSource(parseAep(out).project);
    expect(source2.mediaColorSpace).toBe("ACES/ACES - ACEScg");
    // Byte-exact against AE's own direct-pick sample.
    const ocsp = source2._ocsp_utf8();
    const ae = parseAep(SAMPLES_DIR.div("cms_acescg_colorspace.aep")).project;
    const aeOcsp = _firstSource(ae)._ocsp_utf8();
    pyAssert(ocsp != null && aeOcsp != null);
    expect(pyEq(ocsp.value, aeOcsp.value)).toBe(true);
  });

  test.skipIf(!_ACES12_AVAILABLE)("test_set_ocio_name_absent_from_config_raises", () => {
    // "ACEScg" is not in ACES 1.2 (it is "ACES - ACEScg"). py used to
    // fabricate an envelope for it; the config is authoritative.
    const project = parseAep(SAMPLES_DIR.div("override_media_colorspace_embedded.aep")).project;
    raises(ValueError, () => {
      _firstSource(project).mediaColorSpace = "ACEScg";
    }, "not a color space");
  });

  test("test_set_working_color_space", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("override_media_colorspace_embedded.aep")).project;
    _firstSource(project).mediaColorSpace = "Working Color Space";

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const source2 = _firstSource(parseAep(out).project);
    expect(source2.mediaColorSpace).toBe("Working Color Space");
    // AE-fidelity (verified via aep-compare): the ocsp envelope is emptied.
    const ocsp = source2._ocsp_utf8();
    pyAssert(ocsp != null);
    expect(pyEq(ocsp.value, "")).toBe(true);
  });

  test("test_set_embedded_reverts_override", () => {
    const tmpPath = makeTmpPath();
    // Start from an Apple RGB override, set back to Embedded.
    const project = parseAep(SAMPLES_DIR.div("override_media_colorspace_apple_rgb.aep")).project;
    const source = _firstSource(project);
    expect(source.mediaColorSpace).toBe("Apple RGB");
    source.mediaColorSpace = "Embedded";

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const source2 = _firstSource(parseAep(out).project);
    expect(source2.mediaColorSpace).toBe("Embedded");
  });

  test.skipIf(!_ACES12_AVAILABLE)("test_set_ocio_then_back_to_embedded", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("override_media_colorspace_embedded.aep")).project;
    const source = _firstSource(project);
    source.mediaColorSpace = "ACES - ACEScg";
    expect(source.mediaColorSpace).toBe("ACES/ACES - ACEScg");
    source.mediaColorSpace = "Embedded";

    const out = tmpPath.div("modified.aep");
    project.save(out);
    expect(_firstSource(parseAep(out).project).mediaColorSpace).toBe("Embedded");
  });

  test.skipIf(!_ACES12_AVAILABLE)("test_set_ocio_role", () => {
    const tmpPath = makeTmpPath();
    // A role pick stores the role's TARGET with ocioColorSpaceType 2 - a
    // different envelope from a direct pick of that same color space.
    const project = parseAep(SAMPLES_DIR.div("override_media_colorspace_embedded.aep")).project;
    _firstSource(project).mediaColorSpace = "matte_paint";

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const source2 = _firstSource(parseAep(out).project);
    expect(source2.mediaColorSpace).toBe("Utility - sRGB - Texture");
    const ocsp = source2._ocsp_utf8();
    const ae = parseAep(SAMPLES_DIR.div("cms_matte_paint_role.aep")).project;
    const aeOcsp = _firstSource(ae)._ocsp_utf8();
    pyAssert(ocsp != null && aeOcsp != null);
    expect(pyEq(ocsp.value, aeOcsp.value)).toBe(true);
  });

  test.skipIf(!_ACES12_AVAILABLE)("test_qualified_name_round_trips", () => {
    // The getter returns "<family>/<name>" for a direct pick; assigning
    // that straight back must reproduce the same envelope.
    const project = parseAep(SAMPLES_DIR.div("cms_acescg_colorspace.aep")).project;
    const source = _firstSource(project);
    const before = source._ocsp_utf8();
    pyAssert(before != null);
    const original = before.value;
    expect(source.mediaColorSpace).toBe("ACES/ACES - ACEScg");
    source.mediaColorSpace = source.mediaColorSpace;
    const after = source._ocsp_utf8();
    pyAssert(after != null);
    expect(pyEq(after.value, original)).toBe(true);
  });

  test("test_unresolvable_config_raises", () => {
    const project = parseAep(SAMPLES_DIR.div("cms_acescg_colorspace.aep")).project;
    project.ocioConfigurationFile = String.raw`\\nope\missing\nowhere.ocio`;
    raises(ValueError, () => {
      _firstSource(project).mediaColorSpace = "ACES - ACEScg";
    }, "Cannot resolve");
  });

  test.skipIf(!_ICC_AVAILABLE)("test_set_adobe_profile", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("override_media_colorspace_embedded.aep")).project;
    _firstSource(project).mediaColorSpace = "Apple RGB";

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const source2 = _firstSource(parseAep(out).project);
    expect(source2.mediaColorSpace).toBe("Apple RGB");
    // apid is the catalogued ICC profile ID (matches AE ground truth).
    const apid = asInstance(source2._clrs, ListChunk).chunks.find((c) => c.chunk_type === "apid");
    if (apid == null) throw new StopIteration();
    expect(pyEq(apid.data, profileIdForName("Apple RGB"))).toBe(true);
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

  const _firstSolid = (project: Project): FootageItem => {
    const solid = project.footages.find((f) => f.mainSource instanceof SolidSource);
    if (solid == null) throw new StopIteration();
    return solid;
  };

  test("test_rename_solid_persists", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("solid_colors.aep")).project;
    const solid = _firstSolid(project);
    solid.name = "Renamed Solid Item";

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const reparsed = parseAep(out).project.footages.find((f) => f.id === solid.id);
    if (reparsed == null) throw new StopIteration();
    expect(pyEq(reparsed.name, "Renamed Solid Item")).toBe(true);
  });

  test("test_rename_solid_stores_name_in_opti_not_item_utf8", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("solid_colors.aep")).project;
    const solid = _firstSolid(project);
    solid.name = "Opti Backed";

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const reparsed = parseAep(out).project.footages.find((f) => f.id === solid.id);
    if (reparsed == null) throw new StopIteration();
    expect(pyEq(reparsed.mainSource._opti.solid_name, "Opti Backed")).toBe(true);
    expect(pyEq(asInstance(reparsed._name_utf8, Utf8Chunk).value, "")).toBe(true);
  });

  test("test_rename_placeholder_persists", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("placeholder.aep")).project;
    const placeholder = getFootage(project, "placeholder_720p");
    placeholder.name = "Renamed Placeholder";

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const reparsed = parseAep(out).project.footages.find((f) => f.id === placeholder.id);
    if (reparsed == null) throw new StopIteration();
    expect(pyEq(reparsed.name, "Renamed Placeholder")).toBe(true);
    expect(pyEq(reparsed.mainSource._opti.placeholder_name, "Renamed Placeholder")).toBe(true);
    expect(pyEq(asInstance(reparsed._name_utf8, Utf8Chunk).value, "")).toBe(true);
  });

  test("test_rename_file_footage_persists", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("footage_misc.aep")).project;
    const footage = getFootage(project, "loop_3");
    footage.name = "Renamed File Item";

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const reparsed = parseAep(out).project.footages.find((f) => f.id === footage.id);
    if (reparsed == null) throw new StopIteration();
    expect(pyEq(reparsed.name, "Renamed File Item")).toBe(true);
    expect(pyEq(asInstance(reparsed._name_utf8, Utf8Chunk).value, "Renamed File Item")).toBe(true);
  });

  test("test_rename_solid_accepts_255_utf8_bytes", () => {
    const tmpPath = makeTmpPath();
    // 85 three-byte characters exactly fill the usable part of the
    // 256-byte NUL-padded opti field; AE 2026 caps at the same 255 bytes.
    const name = "中".repeat(85);
    const project = parseAep(SAMPLES_DIR.div("solid_colors.aep")).project;
    const solid = _firstSolid(project);
    solid.name = name;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const reparsed = parseAep(out).project.footages.find((f) => f.id === solid.id);
    if (reparsed == null) throw new StopIteration();
    expect(pyEq(reparsed.name, name)).toBe(true);
  });

  test("test_rename_solid_rejects_oversized_name", () => {
    const solid = _firstSolid(parseProjectFresh(SAMPLES_DIR.div("solid_colors.aep")));
    raises(ValueError, () => {
      solid.name = "A".repeat(256);
    }, "at most 255 UTF-8 bytes");
  });

  test("test_rename_solid_rejects_oversized_multibyte_name", () => {
    // 86 three-byte characters = 258 bytes: rejected rather than
    // truncated mid-character by the fixed-width struct field.
    const solid = _firstSolid(parseProjectFresh(SAMPLES_DIR.div("solid_colors.aep")));
    raises(ValueError, () => {
      solid.name = "中".repeat(86);
    }, "at most 255 UTF-8 bytes");
  });

  test("test_rename_file_footage_keeps_a_name_holding_a_separator", () => {
    const tmpPath = makeTmpPath();
    // AE accepts `dir/sub.bmp` as a file-footage name and displays it
    // verbatim, so the stored name must not be mistaken for a path and
    // stripped back to the source's basename.
    const project = parseAep(SAMPLES_DIR.div("footage_misc.aep")).project;
    const footage = getFootage(project, "loop_3");
    footage.name = "dir/sub.mov";

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const reparsed = parseAep(out).project.footages.find((f) => f.id === footage.id);
    if (reparsed == null) throw new StopIteration();
    expect(pyEq(reparsed.name, "dir/sub.mov")).toBe(true);
  });

  test("test_rename_placeholder_rejects_oversized_name", () => {
    const placeholder = getFootage(
      parseProjectFresh(SAMPLES_DIR.div("placeholder.aep")),
      "placeholder_720p",
    );
    raises(ValueError, () => {
      placeholder.name = "B".repeat(256);
    }, "at most 255 UTF-8 bytes");
  });
});
