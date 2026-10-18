/** Tests for FootageItem model parsing. */

// `from __future__ import annotations` and the `-> None` return annotations
// are dropped: nothing here is evaluated at runtime. `math.isclose` is the
// pyrt `isclose` (num.ts), and its keyword `rel_tol=` becomes the third
// positional argument.

import { describe, expect, test } from "bun:test";
import { AlphaMode, FieldSeparationType } from "../../src/py_aep/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { find_by_list_type } from "../../src/py_aep/binary/utils.ts";
import { get_comp, get_first_footage, get_footage, get_footage_from_json_by_name, load_expected, parse_project } from "../conftest.ts";
import { AssertionError_, Path, StopIteration, isclose, py_eq } from "../../src/pyrt/index.ts";
import { as_instance } from "../helpers.ts";
import { FootageItem } from "../../src/py_aep/models/items/footage.ts";
import { AVLayer } from "../../src/py_aep/models/layers/index.ts";
import { FileSource } from "../../src/py_aep/models/sources/file.ts";
import { SolidSource } from "../../src/py_aep/models/sources/solid.ts";
import { U4LeChunk } from "../../src/py_aep/binary/scalar_chunks.ts";

// Python `Path(__file__).parent.parent.parent` is the repo root. A TS file's
// `import.meta.dir` is already its directory, so two `.parent` steps reach it.
const SAMPLES_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "footage");

/** Tests for footage size attributes. */
describe("TestFootageSize", () => {
  test("test_size_1920x1080", () => {
    const project = parse_project(SAMPLES_DIR.div("solid_sizes.aep"));
    const comp = get_comp(project, "solid_size_1920x1080");
    const footage = as_instance(as_instance(comp.layers[0], AVLayer).source, FootageItem);
    expect(footage.width).toBe(1920);
    expect(footage.height).toBe(1080);
  });

  test("test_size_3840x2160", () => {
    const project = parse_project(SAMPLES_DIR.div("solid_sizes.aep"));
    const comp = get_comp(project, "solid_size_3840x2160");
    const footage = as_instance(as_instance(comp.layers[0], AVLayer).source, FootageItem);
    expect(footage.width).toBe(3840);
    expect(footage.height).toBe(2160);
  });
});

/** Tests for placeholder footage. */
describe("TestPlaceholders", () => {
  test("test_placeholder_still", () => {
    const expected = load_expected(SAMPLES_DIR, "placeholder");
    const footage_json = get_footage_from_json_by_name(expected, "placeholder_still");
    const footage = get_footage(
      parse_project(SAMPLES_DIR.div("placeholder.aep")),
      "placeholder_still",
    );
    expect(footage_json["mainSource"]["isStill"]).toBe(true);
    expect(footage.main_source.is_still).toBe(footage_json["mainSource"]["isStill"]);
  });

  test("test_placeholder_movie", () => {
    const expected = load_expected(SAMPLES_DIR, "placeholder");
    const footage_json = get_footage_from_json_by_name(expected, "placeholder_movie");
    const footage = get_footage(
      parse_project(SAMPLES_DIR.div("placeholder.aep")),
      "placeholder_movie",
    );
    expect(footage_json["mainSource"]["isStill"]).toBe(false);
    expect(footage.main_source.is_still).toBe(footage_json["mainSource"]["isStill"]);
  });

  test("test_placeholder_720p", () => {
    const expected = load_expected(SAMPLES_DIR, "placeholder");
    const footage_json = get_footage_from_json_by_name(expected, "placeholder_720p");
    const footage = get_footage(
      parse_project(SAMPLES_DIR.div("placeholder.aep")),
      "placeholder_720p",
    );
    expect(footage.width).toBe(footage_json["width"]);
    expect(footage_json["width"]).toBe(1280);
    expect(footage.height).toBe(footage_json["height"]);
    expect(footage_json["height"]).toBe(720);
  });

  test("test_placeholder_4K", () => {
    const expected = load_expected(SAMPLES_DIR, "placeholder");
    const footage_json = get_footage_from_json_by_name(expected, "placeholder_4K");
    const footage = get_footage(
      parse_project(SAMPLES_DIR.div("placeholder.aep")),
      "placeholder_4K",
    );
    expect(footage.width).toBe(footage_json["width"]);
    expect(footage_json["width"]).toBe(3840);
    expect(footage.height).toBe(footage_json["height"]);
    expect(footage_json["height"]).toBe(2160);
  });

  test("test_placeholder_30fps", () => {
    const expected = load_expected(SAMPLES_DIR, "placeholder");
    const footage_json = get_footage_from_json_by_name(expected, "placeholder_30fps");
    const footage = get_footage(
      parse_project(SAMPLES_DIR.div("placeholder.aep")),
      "placeholder_30fps",
    );
    expect(footage_json["frameRate"]).toBe(30);
    expect(isclose(footage.frame_rate, footage_json["frameRate"])).toBe(true);
  });

  test("test_placeholder_60fps", () => {
    const expected = load_expected(SAMPLES_DIR, "placeholder");
    const footage_json = get_footage_from_json_by_name(expected, "placeholder_60fps");
    const footage = get_footage(
      parse_project(SAMPLES_DIR.div("placeholder.aep")),
      "placeholder_60fps",
    );
    expect(footage_json["frameRate"]).toBe(60);
    expect(isclose(footage.frame_rate, footage_json["frameRate"])).toBe(true);
  });

  test("test_frameRate_23976", () => {
    const expected = load_expected(SAMPLES_DIR, "footage_misc");
    const footage_json = get_footage_from_json_by_name(expected, "frameRate_23976");
    const footage = get_footage(
      parse_project(SAMPLES_DIR.div("footage_misc.aep")),
      "frameRate_23976",
    );
    expect(isclose(footage.frame_rate, footage_json["frameRate"], 0.001)).toBe(true);
  });
});

/** Ground truth: isMediaReplacementCompatible from ExtendScript exports. */
describe("TestIsMediaReplacementCompatible", () => {
  const LAYER_SAMPLES_DIR = SAMPLES_DIR.parent.div("layer");

  test("test_comp_is_compatible", () => {
    const project = parse_project(SAMPLES_DIR.div("solid_sizes.aep"));
    const comp = get_comp(project, "solid_size_1920x1080");
    expect(comp.is_media_replacement_compatible).toBe(true);
  });

  test("test_solid_is_not_compatible", () => {
    const project = parse_project(SAMPLES_DIR.div("solid_sizes.aep"));
    const solid = as_instance(as_instance(get_comp(project, "solid_size_1920x1080").layers[0], AVLayer).source, FootageItem);
    expect(solid.is_media_replacement_compatible).toBe(false);
  });

  test("test_placeholder_is_compatible", () => {
    const project = parse_project(SAMPLES_DIR.div("placeholder.aep"));
    expect(get_footage(project, "placeholder_still").is_media_replacement_compatible).toBe(true);
    expect(get_footage(project, "placeholder_movie").is_media_replacement_compatible).toBe(true);
  });

  test("test_audio_only_footage_is_not_compatible", () => {
    const project = parse_project(LAYER_SAMPLES_DIR.div("audioEnabled.aep"));
    const wav = get_footage(project, "wav.wav");
    expect(wav.has_video).toBe(false);
    expect(wav.is_media_replacement_compatible).toBe(false);
  });

  test("test_3d_model_is_not_compatible_but_movie_is", () => {
    const project = parse_project(LAYER_SAMPLES_DIR.div("light_source_default.aep"));
    const fbx = get_footage(project, "crystal.fbx");
    expect(fbx.has_video).toBe(true);
    expect(fbx.is_media_replacement_compatible).toBe(false);
    const mov = get_footage(project, "mov_23_976.mov");
    expect(mov.is_media_replacement_compatible).toBe(true);
  });
});

/** Tests for solid footage colors. */
describe("TestSolidColors", () => {
  test("test_color_red", () => {
    const project = parse_project(SAMPLES_DIR.div("solid_colors.aep"));
    const comp = get_comp(project, "solid_color_red");
    const footage = as_instance(as_instance(comp.layers[0], AVLayer).source, FootageItem);
    expect(py_eq(as_instance(footage.main_source, SolidSource).color.slice(0, 3), [1, 0, 0])).toBe(true);
  });

  test("test_color_green", () => {
    const project = parse_project(SAMPLES_DIR.div("solid_colors.aep"));
    const comp = get_comp(project, "solid_color_green");
    const footage = as_instance(as_instance(comp.layers[0], AVLayer).source, FootageItem);
    expect(py_eq(as_instance(footage.main_source, SolidSource).color.slice(0, 3), [0, 1, 0])).toBe(true);
  });

  test("test_color_blue", () => {
    const project = parse_project(SAMPLES_DIR.div("solid_colors.aep"));
    const comp = get_comp(project, "solid_color_blue");
    const footage = as_instance(as_instance(comp.layers[0], AVLayer).source, FootageItem);
    expect(py_eq(as_instance(footage.main_source, SolidSource).color.slice(0, 3), [0, 0, 1])).toBe(true);
  });
});

/** Tests for alpha mode attribute. */
describe("TestAlphaMode", () => {
  test("test_alphaMode_IGNORE", () => {
    const expected = load_expected(SAMPLES_DIR, "alphaMode");
    const footage_json = get_footage_from_json_by_name(expected, "alphaMode_IGNORE");
    const footage = get_footage(
      parse_project(SAMPLES_DIR.div("alphaMode.aep")),
      "alphaMode_IGNORE",
    );
    expect(footage.main_source.alpha_mode).toBe(footage_json["mainSource"]["alphaMode"]);
    expect(footage_json["mainSource"]["alphaMode"]).toBe(AlphaMode.IGNORE);
  });

  test("test_alphaMode_STRAIGHT", () => {
    const expected = load_expected(SAMPLES_DIR, "alphaMode");
    const footage_json = get_footage_from_json_by_name(expected, "alphaMode_STRAIGHT");
    const footage = get_footage(
      parse_project(SAMPLES_DIR.div("alphaMode.aep")),
      "alphaMode_STRAIGHT",
    );
    expect(footage.main_source.alpha_mode).toBe(footage_json["mainSource"]["alphaMode"]);
    expect(footage_json["mainSource"]["alphaMode"]).toBe(AlphaMode.STRAIGHT);
  });

  test("test_alphaMode_PREMULTIPLIED", () => {
    const expected = load_expected(SAMPLES_DIR, "alphaMode");
    const footage_json = get_footage_from_json_by_name(
      expected,
      "alphaMode_PREMULTIPLIED",
    );
    const footage = get_footage(
      parse_project(SAMPLES_DIR.div("alphaMode.aep")),
      "alphaMode_PREMULTIPLIED",
    );
    expect(footage.main_source.alpha_mode).toBe(footage_json["mainSource"]["alphaMode"]);
    expect(footage_json["mainSource"]["alphaMode"]).toBe(AlphaMode.PREMULTIPLIED);
  });
});

/** Tests for field separation settings. */
describe("TestFieldSeparation", () => {
  test("test_fieldSeparationType_OFF", () => {
    const expected = load_expected(SAMPLES_DIR, "fieldSeparationType");
    const footage_json = get_footage_from_json_by_name(
      expected,
      "fieldSeparationType_OFF",
    );
    const footage = get_footage(
      parse_project(SAMPLES_DIR.div("fieldSeparationType.aep")),
      "fieldSeparationType_OFF",
    );
    expect(footage.main_source.field_separation_type).toBe(
      footage_json["mainSource"]["fieldSeparationType"],
    );
    expect(footage_json["mainSource"]["fieldSeparationType"]).toBe(FieldSeparationType.OFF);
  });

  test("test_fieldSeparationType_UPPER", () => {
    const expected = load_expected(SAMPLES_DIR, "fieldSeparationType");
    const footage_json = get_footage_from_json_by_name(
      expected,
      "fieldSeparationType_UPPER",
    );
    const footage = get_footage(
      parse_project(SAMPLES_DIR.div("fieldSeparationType.aep")),
      "fieldSeparationType_UPPER",
    );
    expect(footage.main_source.field_separation_type).toBe(
      footage_json["mainSource"]["fieldSeparationType"],
    );
    expect(footage_json["mainSource"]["fieldSeparationType"]).toBe(
      FieldSeparationType.UPPER_FIELD_FIRST,
    );
  });

  test("test_fieldSeparationType_LOWER", () => {
    const expected = load_expected(SAMPLES_DIR, "fieldSeparationType");
    const footage_json = get_footage_from_json_by_name(
      expected,
      "fieldSeparationType_LOWER",
    );
    const footage = get_footage(
      parse_project(SAMPLES_DIR.div("fieldSeparationType.aep")),
      "fieldSeparationType_LOWER",
    );
    expect(footage.main_source.field_separation_type).toBe(
      footage_json["mainSource"]["fieldSeparationType"],
    );
    expect(footage_json["mainSource"]["fieldSeparationType"]).toBe(
      FieldSeparationType.LOWER_FIELD_FIRST,
    );
  });

  test("test_highQualityFieldSeparation_true", () => {
    const expected = load_expected(SAMPLES_DIR, "footage_misc");
    const footage_json = get_footage_from_json_by_name(
      expected,
      "highQualityFieldSeparation_true",
    );
    const footage = get_footage(
      parse_project(SAMPLES_DIR.div("footage_misc.aep")),
      "highQualityFieldSeparation_true",
    );
    expect(footage.main_source.high_quality_field_separation).toBe(
      footage_json["mainSource"]["highQualityFieldSeparation"],
    );
    expect(footage_json["mainSource"]["highQualityFieldSeparation"]).toBe(true);
  });
});

/** Tests for various footage settings. */
describe("TestFootageSettings", () => {
  test("test_conformFrameRate_24", () => {
    const expected = load_expected(SAMPLES_DIR, "conformFrameRate");
    const footage_json = get_footage_from_json_by_name(expected, "conformFrameRate_24");
    const footage = get_footage(
      parse_project(SAMPLES_DIR.div("conformFrameRate.aep")),
      "conformFrameRate_24",
    );
    expect(footage.main_source.conform_frame_rate).toBe(
      footage_json["mainSource"]["conformFrameRate"],
    );
    expect(footage_json["mainSource"]["conformFrameRate"]).toBe(24);
  });

  test("test_conformFrameRate_30", () => {
    const expected = load_expected(SAMPLES_DIR, "conformFrameRate");
    const footage_json = get_footage_from_json_by_name(expected, "conformFrameRate_30");
    const footage = get_footage(
      parse_project(SAMPLES_DIR.div("conformFrameRate.aep")),
      "conformFrameRate_30",
    );
    expect(footage.main_source.conform_frame_rate).toBe(
      footage_json["mainSource"]["conformFrameRate"],
    );
    expect(footage_json["mainSource"]["conformFrameRate"]).toBe(30);
  });

  test("test_conform_frame_rate_2_5", () => {
    const footage = get_first_footage(
      parse_project(SAMPLES_DIR.div("conform_frame_rate_2.5.aep")),
    );
    expect(footage != null).toBe(true);
    if (footage == null) throw new AssertionError_("sample has no footage item");
    expect(footage.main_source.conform_frame_rate).toBe(2.5);
  });

  test("test_conformed_duration_is_frame_count_over_rate", () => {
    // A 48-frame 23.976 movie conformed to 2.5 fps lasts exactly 48 / 2.5
    // seconds in AE; rescaling the stored duration by the 16.16 native
    // rate gives 19.1999983.
    const expected = load_expected(SAMPLES_DIR, "conform_frame_rate_2.5");
    const footage_json = get_footage_from_json_by_name(expected, "mov_23_976.mov");
    const footage = get_first_footage(
      parse_project(SAMPLES_DIR.div("conform_frame_rate_2.5.aep")),
    );
    expect(footage != null).toBe(true);
    if (footage == null) throw new AssertionError_("sample has no footage item");
    expect(footage.duration).toBe(footage_json["duration"]);
    expect(footage_json["duration"]).toBe(19.2);
  });

  test("test_loop_3", () => {
    const expected = load_expected(SAMPLES_DIR, "footage_misc");
    const footage_json = get_footage_from_json_by_name(expected, "loop_3");
    const footage = get_footage(parse_project(SAMPLES_DIR.div("footage_misc.aep")), "loop_3");
    expect(footage.main_source.loop).toBe(footage_json["mainSource"]["loop"]);
    expect(footage_json["mainSource"]["loop"]).toBe(3);
  });

  test("test_pixelAspect_2", () => {
    const project = parse_project(SAMPLES_DIR.div("solid_sizes.aep"));
    const comp = get_comp(project, "solid_pixelAspect_2");
    const footage = as_instance(as_instance(comp.layers[0], AVLayer).source, FootageItem);
    expect(isclose(footage.pixel_aspect, 2)).toBe(true);
  });

  test("test_invertAlpha_true", () => {
    const expected = load_expected(SAMPLES_DIR, "footage_misc");
    const footage_json = get_footage_from_json_by_name(expected, "invertAlpha_true");
    const footage = get_footage(
      parse_project(SAMPLES_DIR.div("footage_misc.aep")),
      "invertAlpha_true",
    );
    expect(footage.main_source.invert_alpha).toBe(footage_json["mainSource"]["invertAlpha"]);
    expect(footage_json["mainSource"]["invertAlpha"]).toBe(true);
  });

  test("test_premulColor_black", () => {
    const expected = load_expected(SAMPLES_DIR, "premulColor");
    const footage_json = get_footage_from_json_by_name(expected, "premulColor_black");
    const footage = get_footage(
      parse_project(SAMPLES_DIR.div("premulColor.aep")),
      "premulColor_black",
    );
    expect(py_eq(footage.main_source.premul_color, footage_json["mainSource"]["premulColor"])).toBe(
      true,
    );
    expect(py_eq(footage_json["mainSource"]["premulColor"], [0, 0, 0])).toBe(true);
  });

  test("test_premulColor_red", () => {
    const expected = load_expected(SAMPLES_DIR, "premulColor");
    const footage_json = get_footage_from_json_by_name(expected, "premulColor_red");
    const footage = get_footage(
      parse_project(SAMPLES_DIR.div("premulColor.aep")),
      "premulColor_red",
    );
    expect(py_eq(footage_json["mainSource"]["premulColor"], [1, 0, 0])).toBe(true);
    expect(
      py_eq(footage.main_source.premul_color, footage_json["mainSource"]["premulColor"]),
    ).toBe(true);
  });

  test("test_name_renamed", () => {
    const expected = load_expected(SAMPLES_DIR, "footage_misc");
    const footage_json = get_footage_from_json_by_name(expected, "RenamedFootage");
    const footage = get_footage(
      parse_project(SAMPLES_DIR.div("footage_misc.aep")),
      "RenamedFootage",
    );
    expect(footage.name).toBe(footage_json["name"]);
    expect(footage_json["name"]).toBe("RenamedFootage");
  });
});

/** Read-only tests for FootageSource.native_frame_rate. */
describe("TestNativeFrameRate", () => {
  test("test_native_frame_rate", () => {
    const source = get_footage(
      parse_project(SAMPLES_DIR.div("conformFrameRate.aep")),
      "conformFrameRate_24",
    ).main_source;
    expect(source.native_frame_rate).toBe(30.0);
  });
});

/** Read-only tests for FootageSource.display_frame_rate. */
describe("TestDisplayFrameRate", () => {
  test("test_display_frame_rate_with_conform", () => {
    const source = get_footage(
      parse_project(SAMPLES_DIR.div("conformFrameRate.aep")),
      "conformFrameRate_24",
    ).main_source;
    expect(source.display_frame_rate).toBe(24.0);
  });

  test("test_display_frame_rate_without_conform", () => {
    const source = get_footage(
      parse_project(SAMPLES_DIR.div("footage_misc.aep")),
      "loop_3",
    ).main_source;
    expect(source.conform_frame_rate).toBe(0.0);
    expect(source.display_frame_rate).toBe(30.0);
  });

  test("test_display_frame_rate_with_pulldown", () => {
    const source = as_instance(get_first_footage(
      parse_project(SAMPLES_DIR.div("conform_frame_rate_2.5_uff_wssww.aep")),
    ), FootageItem).main_source;
    expect(source.conform_frame_rate).toBe(2.5);
    expect(source.display_frame_rate).toBe(2.0);
  });

  test("test_display_frame_rate_without_pulldown", () => {
    const source = as_instance(get_first_footage(
      parse_project(SAMPLES_DIR.div("conform_frame_rate_2.5_uff_off.aep")),
    ), FootageItem).main_source;
    expect(source.conform_frame_rate).toBe(2.5);
    expect(source.display_frame_rate).toBe(2.5);
  });
});

/** Tests for FootageSource.media_color_space. */
describe("TestOverrideMediaColorSpace", () => {
  test("test_embedded", () => {
    const source = as_instance(get_first_footage(
      parse_project(SAMPLES_DIR.div("override_media_colorspace_embedded.aep")),
    ), FootageItem).main_source;
    expect(source.media_color_space).toBe("Embedded");
  });

  test("test_custom_profile", () => {
    const source = as_instance(get_first_footage(
      parse_project(SAMPLES_DIR.div("override_media_colorspace_apple_rgb.aep")),
    ), FootageItem).main_source;
    expect(source.media_color_space).toBe("Apple RGB");
  });

  test("test_working_colorspace", () => {
    const source = as_instance(get_first_footage(
      parse_project(
        SAMPLES_DIR.div("override_media_colorspace_working_colorspace_-.aep"),
      ),
    ), FootageItem).main_source;
    expect(source.media_color_space).toBe("Working Color Space");
  });

  test("test_working_colorspace_aces", () => {
    const source = as_instance(get_first_footage(
      parse_project(
        SAMPLES_DIR.div("override_media_colorspace_working_colorspace_-aces_cg_or_cct.aep"),
      ),
    ), FootageItem).main_source;
    expect(source.media_color_space).toBe("Working Color Space");
  });
});

/** Tests for FootageItem.has_audio. */
describe("TestHasAudio", () => {
  test("test_footage_with_audio", () => {
    const project = parse_project(SAMPLES_DIR.div("no_audio.aep"));
    const footage = project.footages.find((f) => f.name === "mov_23_976.mov");
    if (footage === undefined) throw new StopIteration();
    expect(footage.has_audio).toBe(true);
  });

  test("test_footage_without_audio", () => {
    const project = parse_project(SAMPLES_DIR.div("no_audio.aep"));
    const footage = project.footages.find((f) => f.name === "mov_23_976_no_audio.mov");
    if (footage === undefined) throw new StopIteration();
    expect(footage.has_audio).toBe(false);
  });
});

/**
 * An image-sequence source's `file` joins the folder and first frame
 * with the folder's own separator, matching AE's fsName.
 *
 * Regression: the join used PurePosixPath unconditionally, so a Windows
 * folder produced a mixed-separator path (`...\\assets/sequence_001.gif`).
 * That mis-splits under `PurePosixPath.name` on a POSIX host, which broke
 * the media-replacement validation on Linux CI while passing on Windows.
 */
describe("TestImageSequenceSource", () => {
  const EG_DIR = SAMPLES_DIR.parent.div("essential_graphics");

  test("test_sequence_file_matches_ground_truth", () => {
    const project = parse_project(EG_DIR.div("media_replacement.aep"));
    const footage = get_footage(project, "sequence_[001-003].gif");
    const expected = load_expected(EG_DIR, "media_replacement");
    const exp_source = get_footage_from_json_by_name(expected, "sequence_[001-003].gif")[
      "mainSource"
    ];
    // Exact string match against AE's fsName, separators included.
    const main_source = as_instance(footage.main_source, FileSource);
    expect(main_source.file).toBe(exp_source["filePath"]);
    // This sample is Windows-authored: no stray forward slash on any host.
    expect(main_source.file.includes("/")).toBe(false);
  });
});

/**
 * AE 2026 imported `new_exr.0002.exr` with `forceAlphabetical`, which
 * takes every EXR in `samples/assets`, numbered alike or not.
 */
describe("TestAlphabeticalSequence", () => {
  const SAMPLE = SAMPLES_DIR.div("sequence_alphabetical.aep");

  test("test_matches_extendscript", () => {
    const expected = load_expected(SAMPLES_DIR, "sequence_alphabetical");
    const footage_json = get_footage_from_json_by_name(expected, "assets");
    const footage = get_footage(parse_project(SAMPLE), "assets");
    // Named after its folder.
    expect(footage.name).toBe(footage_json["name"]);
    expect(footage_json["name"]).toBe("assets");
    expect(footage.duration).toBe(footage_json["duration"]);
    expect(footage.frame_rate).toBe(footage_json["frameRate"]);
    expect(as_instance(footage.main_source, FileSource).file).toBe(footage_json["mainSource"]["filePath"]);
  });

  test("test_lists_its_files", () => {
    const source = as_instance(get_footage(parse_project(SAMPLE), "assets").main_source, FileSource);
    expect(
      py_eq(source.file_names, [
        "new_exr.0002.exr",
        "new_exr.0003.exr",
        "old_exr.00004.exr",
      ]),
    ).toBe(true);
    // The StVc list's little-endian file count.
    const stvc = find_by_list_type(source._pin.chunks, "StVc");
    expect(as_instance(stvc.chunks[0], U4LeChunk).value).toBe(3);
  });
});
