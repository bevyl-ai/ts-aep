/** Tests for FootageItem model parsing. */

// `from __future__ import annotations` and the `-> None` return annotations
// are dropped: nothing here is evaluated at runtime. `math.isclose` is the
// pyrt `isclose` (num.ts), and its keyword `rel_tol=` becomes the third
// positional argument.

import { describe, expect, test } from "bun:test";
import { AlphaMode, FieldSeparationType } from "../../src/py_aep/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { findByListType } from "../../src/py_aep/binary/utils.ts";
import { getComp, getFirstFootage, getFootage, getFootageFromJsonByName, loadExpected, parseProject } from "../conftest.ts";
import { AssertionError_, Path, StopIteration, isclose, pyEq } from "../../src/pyrt/index.ts";
import { asInstance } from "../helpers.ts";
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
    const project = parseProject(SAMPLES_DIR.div("solid_sizes.aep"));
    const comp = getComp(project, "solid_size_1920x1080");
    const footage = asInstance(asInstance(comp.layers[0], AVLayer).source, FootageItem);
    expect(footage.width).toBe(1920);
    expect(footage.height).toBe(1080);
  });

  test("test_size_3840x2160", () => {
    const project = parseProject(SAMPLES_DIR.div("solid_sizes.aep"));
    const comp = getComp(project, "solid_size_3840x2160");
    const footage = asInstance(asInstance(comp.layers[0], AVLayer).source, FootageItem);
    expect(footage.width).toBe(3840);
    expect(footage.height).toBe(2160);
  });
});

/** Tests for placeholder footage. */
describe("TestPlaceholders", () => {
  test("test_placeholder_still", () => {
    const expected = loadExpected(SAMPLES_DIR, "placeholder");
    const footageJson = getFootageFromJsonByName(expected, "placeholder_still");
    const footage = getFootage(
      parseProject(SAMPLES_DIR.div("placeholder.aep")),
      "placeholder_still",
    );
    expect(footageJson["mainSource"]["isStill"]).toBe(true);
    expect(footage.mainSource.isStill).toBe(footageJson["mainSource"]["isStill"]);
  });

  test("test_placeholder_movie", () => {
    const expected = loadExpected(SAMPLES_DIR, "placeholder");
    const footageJson = getFootageFromJsonByName(expected, "placeholder_movie");
    const footage = getFootage(
      parseProject(SAMPLES_DIR.div("placeholder.aep")),
      "placeholder_movie",
    );
    expect(footageJson["mainSource"]["isStill"]).toBe(false);
    expect(footage.mainSource.isStill).toBe(footageJson["mainSource"]["isStill"]);
  });

  test("test_placeholder_720p", () => {
    const expected = loadExpected(SAMPLES_DIR, "placeholder");
    const footageJson = getFootageFromJsonByName(expected, "placeholder_720p");
    const footage = getFootage(
      parseProject(SAMPLES_DIR.div("placeholder.aep")),
      "placeholder_720p",
    );
    expect(footage.width).toBe(footageJson["width"]);
    expect(footageJson["width"]).toBe(1280);
    expect(footage.height).toBe(footageJson["height"]);
    expect(footageJson["height"]).toBe(720);
  });

  test("test_placeholder_4K", () => {
    const expected = loadExpected(SAMPLES_DIR, "placeholder");
    const footageJson = getFootageFromJsonByName(expected, "placeholder_4K");
    const footage = getFootage(
      parseProject(SAMPLES_DIR.div("placeholder.aep")),
      "placeholder_4K",
    );
    expect(footage.width).toBe(footageJson["width"]);
    expect(footageJson["width"]).toBe(3840);
    expect(footage.height).toBe(footageJson["height"]);
    expect(footageJson["height"]).toBe(2160);
  });

  test("test_placeholder_30fps", () => {
    const expected = loadExpected(SAMPLES_DIR, "placeholder");
    const footageJson = getFootageFromJsonByName(expected, "placeholder_30fps");
    const footage = getFootage(
      parseProject(SAMPLES_DIR.div("placeholder.aep")),
      "placeholder_30fps",
    );
    expect(footageJson["frameRate"]).toBe(30);
    expect(isclose(footage.frameRate, footageJson["frameRate"])).toBe(true);
  });

  test("test_placeholder_60fps", () => {
    const expected = loadExpected(SAMPLES_DIR, "placeholder");
    const footageJson = getFootageFromJsonByName(expected, "placeholder_60fps");
    const footage = getFootage(
      parseProject(SAMPLES_DIR.div("placeholder.aep")),
      "placeholder_60fps",
    );
    expect(footageJson["frameRate"]).toBe(60);
    expect(isclose(footage.frameRate, footageJson["frameRate"])).toBe(true);
  });

  test("test_frameRate_23976", () => {
    const expected = loadExpected(SAMPLES_DIR, "footage_misc");
    const footageJson = getFootageFromJsonByName(expected, "frameRate_23976");
    const footage = getFootage(
      parseProject(SAMPLES_DIR.div("footage_misc.aep")),
      "frameRate_23976",
    );
    expect(isclose(footage.frameRate, footageJson["frameRate"], 0.001)).toBe(true);
  });
});

/** Ground truth: isMediaReplacementCompatible from ExtendScript exports. */
describe("TestIsMediaReplacementCompatible", () => {
  const LAYER_SAMPLES_DIR = SAMPLES_DIR.parent.div("layer");

  test("test_comp_is_compatible", () => {
    const project = parseProject(SAMPLES_DIR.div("solid_sizes.aep"));
    const comp = getComp(project, "solid_size_1920x1080");
    expect(comp.isMediaReplacementCompatible).toBe(true);
  });

  test("test_solid_is_not_compatible", () => {
    const project = parseProject(SAMPLES_DIR.div("solid_sizes.aep"));
    const solid = asInstance(asInstance(getComp(project, "solid_size_1920x1080").layers[0], AVLayer).source, FootageItem);
    expect(solid.isMediaReplacementCompatible).toBe(false);
  });

  test("test_placeholder_is_compatible", () => {
    const project = parseProject(SAMPLES_DIR.div("placeholder.aep"));
    expect(getFootage(project, "placeholder_still").isMediaReplacementCompatible).toBe(true);
    expect(getFootage(project, "placeholder_movie").isMediaReplacementCompatible).toBe(true);
  });

  test("test_audio_only_footage_is_not_compatible", () => {
    const project = parseProject(LAYER_SAMPLES_DIR.div("audioEnabled.aep"));
    const wav = getFootage(project, "wav.wav");
    expect(wav.hasVideo).toBe(false);
    expect(wav.isMediaReplacementCompatible).toBe(false);
  });

  test("test_3d_model_is_not_compatible_but_movie_is", () => {
    const project = parseProject(LAYER_SAMPLES_DIR.div("light_source_default.aep"));
    const fbx = getFootage(project, "crystal.fbx");
    expect(fbx.hasVideo).toBe(true);
    expect(fbx.isMediaReplacementCompatible).toBe(false);
    const mov = getFootage(project, "mov_23_976.mov");
    expect(mov.isMediaReplacementCompatible).toBe(true);
  });
});

/** Tests for solid footage colors. */
describe("TestSolidColors", () => {
  test("test_color_red", () => {
    const project = parseProject(SAMPLES_DIR.div("solid_colors.aep"));
    const comp = getComp(project, "solid_color_red");
    const footage = asInstance(asInstance(comp.layers[0], AVLayer).source, FootageItem);
    expect(pyEq(asInstance(footage.mainSource, SolidSource).color.slice(0, 3), [1, 0, 0])).toBe(true);
  });

  test("test_color_green", () => {
    const project = parseProject(SAMPLES_DIR.div("solid_colors.aep"));
    const comp = getComp(project, "solid_color_green");
    const footage = asInstance(asInstance(comp.layers[0], AVLayer).source, FootageItem);
    expect(pyEq(asInstance(footage.mainSource, SolidSource).color.slice(0, 3), [0, 1, 0])).toBe(true);
  });

  test("test_color_blue", () => {
    const project = parseProject(SAMPLES_DIR.div("solid_colors.aep"));
    const comp = getComp(project, "solid_color_blue");
    const footage = asInstance(asInstance(comp.layers[0], AVLayer).source, FootageItem);
    expect(pyEq(asInstance(footage.mainSource, SolidSource).color.slice(0, 3), [0, 0, 1])).toBe(true);
  });
});

/** Tests for alpha mode attribute. */
describe("TestAlphaMode", () => {
  test("test_alphaMode_IGNORE", () => {
    const expected = loadExpected(SAMPLES_DIR, "alphaMode");
    const footageJson = getFootageFromJsonByName(expected, "alphaMode_IGNORE");
    const footage = getFootage(
      parseProject(SAMPLES_DIR.div("alphaMode.aep")),
      "alphaMode_IGNORE",
    );
    expect(footage.mainSource.alphaMode).toBe(footageJson["mainSource"]["alphaMode"]);
    expect(footageJson["mainSource"]["alphaMode"]).toBe(AlphaMode.IGNORE);
  });

  test("test_alphaMode_STRAIGHT", () => {
    const expected = loadExpected(SAMPLES_DIR, "alphaMode");
    const footageJson = getFootageFromJsonByName(expected, "alphaMode_STRAIGHT");
    const footage = getFootage(
      parseProject(SAMPLES_DIR.div("alphaMode.aep")),
      "alphaMode_STRAIGHT",
    );
    expect(footage.mainSource.alphaMode).toBe(footageJson["mainSource"]["alphaMode"]);
    expect(footageJson["mainSource"]["alphaMode"]).toBe(AlphaMode.STRAIGHT);
  });

  test("test_alphaMode_PREMULTIPLIED", () => {
    const expected = loadExpected(SAMPLES_DIR, "alphaMode");
    const footageJson = getFootageFromJsonByName(
      expected,
      "alphaMode_PREMULTIPLIED",
    );
    const footage = getFootage(
      parseProject(SAMPLES_DIR.div("alphaMode.aep")),
      "alphaMode_PREMULTIPLIED",
    );
    expect(footage.mainSource.alphaMode).toBe(footageJson["mainSource"]["alphaMode"]);
    expect(footageJson["mainSource"]["alphaMode"]).toBe(AlphaMode.PREMULTIPLIED);
  });
});

/** Tests for field separation settings. */
describe("TestFieldSeparation", () => {
  test("test_fieldSeparationType_OFF", () => {
    const expected = loadExpected(SAMPLES_DIR, "fieldSeparationType");
    const footageJson = getFootageFromJsonByName(
      expected,
      "fieldSeparationType_OFF",
    );
    const footage = getFootage(
      parseProject(SAMPLES_DIR.div("fieldSeparationType.aep")),
      "fieldSeparationType_OFF",
    );
    expect(footage.mainSource.fieldSeparationType).toBe(
      footageJson["mainSource"]["fieldSeparationType"],
    );
    expect(footageJson["mainSource"]["fieldSeparationType"]).toBe(FieldSeparationType.OFF);
  });

  test("test_fieldSeparationType_UPPER", () => {
    const expected = loadExpected(SAMPLES_DIR, "fieldSeparationType");
    const footageJson = getFootageFromJsonByName(
      expected,
      "fieldSeparationType_UPPER",
    );
    const footage = getFootage(
      parseProject(SAMPLES_DIR.div("fieldSeparationType.aep")),
      "fieldSeparationType_UPPER",
    );
    expect(footage.mainSource.fieldSeparationType).toBe(
      footageJson["mainSource"]["fieldSeparationType"],
    );
    expect(footageJson["mainSource"]["fieldSeparationType"]).toBe(
      FieldSeparationType.UPPER_FIELD_FIRST,
    );
  });

  test("test_fieldSeparationType_LOWER", () => {
    const expected = loadExpected(SAMPLES_DIR, "fieldSeparationType");
    const footageJson = getFootageFromJsonByName(
      expected,
      "fieldSeparationType_LOWER",
    );
    const footage = getFootage(
      parseProject(SAMPLES_DIR.div("fieldSeparationType.aep")),
      "fieldSeparationType_LOWER",
    );
    expect(footage.mainSource.fieldSeparationType).toBe(
      footageJson["mainSource"]["fieldSeparationType"],
    );
    expect(footageJson["mainSource"]["fieldSeparationType"]).toBe(
      FieldSeparationType.LOWER_FIELD_FIRST,
    );
  });

  test("test_highQualityFieldSeparation_true", () => {
    const expected = loadExpected(SAMPLES_DIR, "footage_misc");
    const footageJson = getFootageFromJsonByName(
      expected,
      "highQualityFieldSeparation_true",
    );
    const footage = getFootage(
      parseProject(SAMPLES_DIR.div("footage_misc.aep")),
      "highQualityFieldSeparation_true",
    );
    expect(footage.mainSource.highQualityFieldSeparation).toBe(
      footageJson["mainSource"]["highQualityFieldSeparation"],
    );
    expect(footageJson["mainSource"]["highQualityFieldSeparation"]).toBe(true);
  });
});

/** Tests for various footage settings. */
describe("TestFootageSettings", () => {
  test("test_conformFrameRate_24", () => {
    const expected = loadExpected(SAMPLES_DIR, "conformFrameRate");
    const footageJson = getFootageFromJsonByName(expected, "conformFrameRate_24");
    const footage = getFootage(
      parseProject(SAMPLES_DIR.div("conformFrameRate.aep")),
      "conformFrameRate_24",
    );
    expect(footage.mainSource.conformFrameRate).toBe(
      footageJson["mainSource"]["conformFrameRate"],
    );
    expect(footageJson["mainSource"]["conformFrameRate"]).toBe(24);
  });

  test("test_conformFrameRate_30", () => {
    const expected = loadExpected(SAMPLES_DIR, "conformFrameRate");
    const footageJson = getFootageFromJsonByName(expected, "conformFrameRate_30");
    const footage = getFootage(
      parseProject(SAMPLES_DIR.div("conformFrameRate.aep")),
      "conformFrameRate_30",
    );
    expect(footage.mainSource.conformFrameRate).toBe(
      footageJson["mainSource"]["conformFrameRate"],
    );
    expect(footageJson["mainSource"]["conformFrameRate"]).toBe(30);
  });

  test("test_conform_frame_rate_2_5", () => {
    const footage = getFirstFootage(
      parseProject(SAMPLES_DIR.div("conform_frame_rate_2.5.aep")),
    );
    expect(footage != null).toBe(true);
    if (footage == null) throw new AssertionError_("sample has no footage item");
    expect(footage.mainSource.conformFrameRate).toBe(2.5);
  });

  test("test_conformed_duration_is_frame_count_over_rate", () => {
    // A 48-frame 23.976 movie conformed to 2.5 fps lasts exactly 48 / 2.5
    // seconds in AE; rescaling the stored duration by the 16.16 native
    // rate gives 19.1999983.
    const expected = loadExpected(SAMPLES_DIR, "conform_frame_rate_2.5");
    const footageJson = getFootageFromJsonByName(expected, "mov_23_976.mov");
    const footage = getFirstFootage(
      parseProject(SAMPLES_DIR.div("conform_frame_rate_2.5.aep")),
    );
    expect(footage != null).toBe(true);
    if (footage == null) throw new AssertionError_("sample has no footage item");
    expect(footage.duration).toBe(footageJson["duration"]);
    expect(footageJson["duration"]).toBe(19.2);
  });

  test("test_loop_3", () => {
    const expected = loadExpected(SAMPLES_DIR, "footage_misc");
    const footageJson = getFootageFromJsonByName(expected, "loop_3");
    const footage = getFootage(parseProject(SAMPLES_DIR.div("footage_misc.aep")), "loop_3");
    expect(footage.mainSource.loop).toBe(footageJson["mainSource"]["loop"]);
    expect(footageJson["mainSource"]["loop"]).toBe(3);
  });

  test("test_pixelAspect_2", () => {
    const project = parseProject(SAMPLES_DIR.div("solid_sizes.aep"));
    const comp = getComp(project, "solid_pixelAspect_2");
    const footage = asInstance(asInstance(comp.layers[0], AVLayer).source, FootageItem);
    expect(isclose(footage.pixelAspect, 2)).toBe(true);
  });

  test("test_invertAlpha_true", () => {
    const expected = loadExpected(SAMPLES_DIR, "footage_misc");
    const footageJson = getFootageFromJsonByName(expected, "invertAlpha_true");
    const footage = getFootage(
      parseProject(SAMPLES_DIR.div("footage_misc.aep")),
      "invertAlpha_true",
    );
    expect(footage.mainSource.invertAlpha).toBe(footageJson["mainSource"]["invertAlpha"]);
    expect(footageJson["mainSource"]["invertAlpha"]).toBe(true);
  });

  test("test_premulColor_black", () => {
    const expected = loadExpected(SAMPLES_DIR, "premulColor");
    const footageJson = getFootageFromJsonByName(expected, "premulColor_black");
    const footage = getFootage(
      parseProject(SAMPLES_DIR.div("premulColor.aep")),
      "premulColor_black",
    );
    expect(pyEq(footage.mainSource.premulColor, footageJson["mainSource"]["premulColor"])).toBe(
      true,
    );
    expect(pyEq(footageJson["mainSource"]["premulColor"], [0, 0, 0])).toBe(true);
  });

  test("test_premulColor_red", () => {
    const expected = loadExpected(SAMPLES_DIR, "premulColor");
    const footageJson = getFootageFromJsonByName(expected, "premulColor_red");
    const footage = getFootage(
      parseProject(SAMPLES_DIR.div("premulColor.aep")),
      "premulColor_red",
    );
    expect(pyEq(footageJson["mainSource"]["premulColor"], [1, 0, 0])).toBe(true);
    expect(
      pyEq(footage.mainSource.premulColor, footageJson["mainSource"]["premulColor"]),
    ).toBe(true);
  });

  test("test_name_renamed", () => {
    const expected = loadExpected(SAMPLES_DIR, "footage_misc");
    const footageJson = getFootageFromJsonByName(expected, "RenamedFootage");
    const footage = getFootage(
      parseProject(SAMPLES_DIR.div("footage_misc.aep")),
      "RenamedFootage",
    );
    expect(footage.name).toBe(footageJson["name"]);
    expect(footageJson["name"]).toBe("RenamedFootage");
  });
});

/** Read-only tests for FootageSource.nativeFrameRate. */
describe("TestNativeFrameRate", () => {
  test("test_native_frame_rate", () => {
    const source = getFootage(
      parseProject(SAMPLES_DIR.div("conformFrameRate.aep")),
      "conformFrameRate_24",
    ).mainSource;
    expect(source.nativeFrameRate).toBe(30.0);
  });
});

/** Read-only tests for FootageSource.displayFrameRate. */
describe("TestDisplayFrameRate", () => {
  test("test_display_frame_rate_with_conform", () => {
    const source = getFootage(
      parseProject(SAMPLES_DIR.div("conformFrameRate.aep")),
      "conformFrameRate_24",
    ).mainSource;
    expect(source.displayFrameRate).toBe(24.0);
  });

  test("test_display_frame_rate_without_conform", () => {
    const source = getFootage(
      parseProject(SAMPLES_DIR.div("footage_misc.aep")),
      "loop_3",
    ).mainSource;
    expect(source.conformFrameRate).toBe(0.0);
    expect(source.displayFrameRate).toBe(30.0);
  });

  test("test_display_frame_rate_with_pulldown", () => {
    const source = asInstance(getFirstFootage(
      parseProject(SAMPLES_DIR.div("conform_frame_rate_2.5_uff_wssww.aep")),
    ), FootageItem).mainSource;
    expect(source.conformFrameRate).toBe(2.5);
    expect(source.displayFrameRate).toBe(2.0);
  });

  test("test_display_frame_rate_without_pulldown", () => {
    const source = asInstance(getFirstFootage(
      parseProject(SAMPLES_DIR.div("conform_frame_rate_2.5_uff_off.aep")),
    ), FootageItem).mainSource;
    expect(source.conformFrameRate).toBe(2.5);
    expect(source.displayFrameRate).toBe(2.5);
  });
});

/** Tests for FootageSource.mediaColorSpace. */
describe("TestOverrideMediaColorSpace", () => {
  test("test_embedded", () => {
    const source = asInstance(getFirstFootage(
      parseProject(SAMPLES_DIR.div("override_media_colorspace_embedded.aep")),
    ), FootageItem).mainSource;
    expect(source.mediaColorSpace).toBe("Embedded");
  });

  test("test_custom_profile", () => {
    const source = asInstance(getFirstFootage(
      parseProject(SAMPLES_DIR.div("override_media_colorspace_apple_rgb.aep")),
    ), FootageItem).mainSource;
    expect(source.mediaColorSpace).toBe("Apple RGB");
  });

  test("test_working_colorspace", () => {
    const source = asInstance(getFirstFootage(
      parseProject(
        SAMPLES_DIR.div("override_media_colorspace_working_colorspace_-.aep"),
      ),
    ), FootageItem).mainSource;
    expect(source.mediaColorSpace).toBe("Working Color Space");
  });

  test("test_working_colorspace_aces", () => {
    const source = asInstance(getFirstFootage(
      parseProject(
        SAMPLES_DIR.div("override_media_colorspace_working_colorspace_-aces_cg_or_cct.aep"),
      ),
    ), FootageItem).mainSource;
    expect(source.mediaColorSpace).toBe("Working Color Space");
  });
});

/** Tests for FootageItem.hasAudio. */
describe("TestHasAudio", () => {
  test("test_footage_with_audio", () => {
    const project = parseProject(SAMPLES_DIR.div("no_audio.aep"));
    const footage = project.footages.find((f) => f.name === "mov_23_976.mov");
    if (footage === undefined) throw new StopIteration();
    expect(footage.hasAudio).toBe(true);
  });

  test("test_footage_without_audio", () => {
    const project = parseProject(SAMPLES_DIR.div("no_audio.aep"));
    const footage = project.footages.find((f) => f.name === "mov_23_976_no_audio.mov");
    if (footage === undefined) throw new StopIteration();
    expect(footage.hasAudio).toBe(false);
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
    const project = parseProject(EG_DIR.div("media_replacement.aep"));
    const footage = getFootage(project, "sequence_[001-003].gif");
    const expected = loadExpected(EG_DIR, "media_replacement");
    const expSource = getFootageFromJsonByName(expected, "sequence_[001-003].gif")[
      "mainSource"
    ];
    // Exact string match against AE's fsName, separators included.
    const mainSource = asInstance(footage.mainSource, FileSource);
    expect(mainSource.file).toBe(expSource["filePath"]);
    // This sample is Windows-authored: no stray forward slash on any host.
    expect(mainSource.file.includes("/")).toBe(false);
  });
});

/**
 * AE 2026 imported `new_exr.0002.exr` with `forceAlphabetical`, which
 * takes every EXR in `samples/assets`, numbered alike or not.
 */
describe("TestAlphabeticalSequence", () => {
  const SAMPLE = SAMPLES_DIR.div("sequence_alphabetical.aep");

  test("test_matches_extendscript", () => {
    const expected = loadExpected(SAMPLES_DIR, "sequence_alphabetical");
    const footageJson = getFootageFromJsonByName(expected, "assets");
    const footage = getFootage(parseProject(SAMPLE), "assets");
    // Named after its folder.
    expect(footage.name).toBe(footageJson["name"]);
    expect(footageJson["name"]).toBe("assets");
    expect(footage.duration).toBe(footageJson["duration"]);
    expect(footage.frameRate).toBe(footageJson["frameRate"]);
    expect(asInstance(footage.mainSource, FileSource).file).toBe(footageJson["mainSource"]["filePath"]);
  });

  test("test_lists_its_files", () => {
    const source = asInstance(getFootage(parseProject(SAMPLE), "assets").mainSource, FileSource);
    expect(
      pyEq(source.fileNames, [
        "new_exr.0002.exr",
        "new_exr.0003.exr",
        "old_exr.00004.exr",
      ]),
    ).toBe(true);
    // The StVc list's little-endian file count.
    const stvc = findByListType(source._pin.chunks, "StVc");
    expect(asInstance(stvc.chunks[0], U4LeChunk).value).toBe(3);
  });
});
