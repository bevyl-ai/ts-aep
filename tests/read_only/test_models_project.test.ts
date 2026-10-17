/** Tests for Project model parsing. */

// `from __future__ import annotations` is dropped: no annotation here is
// evaluated at runtime. `Path(__file__)` is `import.meta.dir` in this module,
// so the three `.parent` steps of the Python source become two here.
// Enum members are plain numbers in the port, so `member.value` is `member`
// and `member.name` is `E.name_of(member)`.

import { describe, expect, test } from "bun:test";
import { contains, format, len, Path, py_bool, py_eq, split } from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { load_expected, parse_project } from "../conftest.ts";
import { ColorManagementSystem, GpuAccelType, LutInterpolationMethod } from "../../src/py_aep/enums/index.ts";

const SAMPLES_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "project");
const VIEW_SAMPLES_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "view");
const VERSIONS_DIR = new Path(import.meta.dir).parent.parent.div("samples", "versions");
const LAYER_SAMPLES_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "layer");
const COMP_SAMPLES_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "composition");

describe("TestBitsPerChannel", () => {
  /** Tests for bitsPerChannel attribute. */

  test("test_8bpc", () => {
    const expected = load_expected(SAMPLES_DIR, "bitsPerChannel_8");
    const project = parse_project(SAMPLES_DIR.div("bitsPerChannel_8.aep"));
    expect(expected["bitsPerChannel"]).toBe(8);
    expect(project.bits_per_channel).toBe(expected["bitsPerChannel"]);
  });

  test("test_16bpc", () => {
    const expected = load_expected(SAMPLES_DIR, "bitsPerChannel_16");
    const project = parse_project(SAMPLES_DIR.div("bitsPerChannel_16.aep"));
    expect(expected["bitsPerChannel"]).toBe(16);
    expect(project.bits_per_channel).toBe(expected["bitsPerChannel"]);
  });

  test("test_32bpc", () => {
    const expected = load_expected(SAMPLES_DIR, "bitsPerChannel_32");
    const project = parse_project(SAMPLES_DIR.div("bitsPerChannel_32.aep"));
    expect(expected["bitsPerChannel"]).toBe(32);
    expect(project.bits_per_channel).toBe(expected["bitsPerChannel"]);
  });
});

describe("TestExpressionEngine", () => {
  /** Tests for expressionEngine attribute. */

  test("test_javascript", () => {
    const expected = load_expected(SAMPLES_DIR, "expressionEngine_javascript");
    const project = parse_project(SAMPLES_DIR.div("expressionEngine_javascript.aep"));
    expect(expected["expressionEngine"]).toBe("javascript-1.0");
    expect(project.expression_engine).toBe(expected["expressionEngine"]);
  });
});

describe("TestDisplayStartFrame", () => {
  /** Tests for displayStartFrame attribute. */

  test("test_displayStartFrame_1", () => {
    const expected = load_expected(SAMPLES_DIR, "displayStartFrame_1");
    const project = parse_project(SAMPLES_DIR.div("displayStartFrame_1.aep"));
    expect(expected["displayStartFrame"]).toBe(1);
    expect(project.display_start_frame).toBe(expected["displayStartFrame"]);
  });
});

describe("TestFramesCountType", () => {
  /** Tests for framesCountType attribute. */

  test("test_start0", () => {
    load_expected(SAMPLES_DIR, "framesCountType_start0");
    const project = parse_project(SAMPLES_DIR.div("framesCountType_start0.aep"));
    expect(project.display_start_frame).toBe(0);
  });
});

describe("TestWorkingGamma", () => {
  /** Tests for workingGamma attribute. */

  test("test_workingGamma_2_4", () => {
    const project = parse_project(SAMPLES_DIR.div("workingGamma_2.4.aep"));
    expect(project.working_gamma).toBe(2.4);
  });

  test("test_workingGamma_2_2", () => {
    const project = parse_project(SAMPLES_DIR.div("workingGamma_2.2.aep"));
    expect(project.working_gamma).toBe(2.2);
  });
});

describe("TestWorkingSpace", () => {
  /** Tests for workingSpace attribute. */

  test("test_workingSpace_sRGB", () => {
    const expected = load_expected(SAMPLES_DIR, "workingSpace_sRGB");
    const project = parse_project(SAMPLES_DIR.div("workingSpace_sRGB.aep"));
    expect(expected["workingSpace"]).toBe("sRGB IEC61966-2.1");
    expect(project.working_space).toBe(expected["workingSpace"]);
  });

  /**
   * A CC 2018 project names its working space only by the `cpid`
   * profile id, whose ICC sits in `LIST:CPPl`.
   */
  test("test_pre_color_management_profile_id", () => {
    const expected = load_expected(VERSIONS_DIR.div("ae2018"), "complete");
    const project = parse_project(VERSIONS_DIR.div("ae2018", "complete.aep"));
    expect(expected["workingSpace"]).toBe("sRGB IEC61966-2.1");
    expect(project.working_space).toBe(expected["workingSpace"]);
  });

  test("test_pre_color_management_no_working_space", () => {
    // The all-0xFF `cpid` of an empty CC 2018 project: AE 2026 reports
    // workingSpace "None" for it.
    const project = parse_project(SAMPLES_DIR.div("emptier_2018.aep"));
    expect(project.working_space).toBe("None");
  });
});

describe("TestDisplayColorSpace", () => {
  /** Tests for display_color_space attribute. */

  test("test_none", () => {
    const project = parse_project(SAMPLES_DIR.div("display_color_space_ACES_None.aep"));
    expect(project.display_color_space).toBe("None");
  });

  test("test_srgb", () => {
    const project = parse_project(SAMPLES_DIR.div("display_color_space_ACES_sRGB.aep"));
    expect(project.display_color_space).toBe("ACES/sRGB");
  });

  test("test_dcdm", () => {
    const project = parse_project(SAMPLES_DIR.div("display_color_space_ACES_DCDM.aep"));
    expect(project.display_color_space).toBe("ACES/DCDM");
  });
});

describe("TestAudioSampleRate", () => {
  /** Tests for audio_sample_rate attribute. */

  test("test_96000", () => {
    const project = parse_project(SAMPLES_DIR.div("Audio_sample_rate_96000.aep"));
    expect(project.audio_sample_rate).toBe(96000.0);
  });

  test("test_22050", () => {
    const project = parse_project(SAMPLES_DIR.div("Audio_sample_rate_22050.aep"));
    expect(project.audio_sample_rate).toBe(22050.0);
  });
});

describe("TestGpuAccelType", () => {
  /** Tests for gpu_accel_type attribute. */

  test("test_cuda", () => {
    const expected = load_expected(SAMPLES_DIR, "gpuAccelType_mercury_gpu_acceleration_CUDA");
    const project = parse_project(SAMPLES_DIR.div("gpuAccelType_mercury_gpu_acceleration_CUDA.aep"));
    expect(expected["gpuAccelType"]).toBe(1813);
    expect(project.gpu_accel_type).toBe(expected["gpuAccelType"]);
  });

  test("test_software", () => {
    const expected = load_expected(SAMPLES_DIR, "gpuAccelType_mercury_software_only");
    const project = parse_project(SAMPLES_DIR.div("gpuAccelType_mercury_software_only.aep"));
    expect(expected["gpuAccelType"]).toBe(1816);
    expect(project.gpu_accel_type).toBe(expected["gpuAccelType"]);
  });

  test("test_opencl", () => {
    // Saved by AE 25.3 (Windows); AE 2026 reports gpuAccelType 1812 for it.
    const project = parse_project(SAMPLES_DIR.parent.parent.div("bugs", "outputmodule_path.aep"));
    expect(project.gpu_accel_type).toBe(GpuAccelType.OPENCL);
  });

  test("test_renderer_ids", () => {
    // What AE 2026 reports as `gpuAccelType` for a project holding each id.
    const ids = new Map<string, number>([
      ["7ee0ab59-822d-44cc-ac10-16279d041016", GpuAccelType.CUDA],
      ["be93941a-7488-4117-8a46-7e3596950307", GpuAccelType.OPENCL],
      ["6ed1497e-17ad-4a5b-846f-52bb81e20104", GpuAccelType.METAL],
      ["c4471277-d5d1-4ea7-a36c-b93ac76dfd41", GpuAccelType.VULKAN],
      ["f33089e2-1ede-47c1-8a9e-b232bb1cc1a4", GpuAccelType.SOFTWARE],
      ["cd99cfc1-bf65-4cb7-ab70-a8f5ea50e8f4", GpuAccelType.DIRECTX],
    ]);
    for (const [guid, accel] of ids) {
      expect(GpuAccelType.from_binary(guid)).toBe(accel);
      expect(GpuAccelType.to_binary(accel)).toBe(guid);
    }
  });
});

describe("TestLinearBlending", () => {
  /** Tests for linearBlending attribute. */

  test("test_linearBlending_false", () => {
    const project = parse_project(SAMPLES_DIR.div("linearBlending_false.aep"));
    expect(!py_bool(project.linear_blending)).toBe(true);
  });

  test("test_linearBlending_true", () => {
    const project = parse_project(SAMPLES_DIR.div("linearBlending_true.aep"));
    expect(py_bool(project.linear_blending)).toBe(true);
  });
});

describe("TestTransparencyGridThumbnails", () => {
  /** Tests for transparencyGridThumbnails attribute. */

  test("test_true", () => {
    const project = parse_project(SAMPLES_DIR.div("transparencyGridThumbnails_true.aep"));
    expect(project.transparency_grid_thumbnails).toBe(true);
  });

  test("test_false", () => {
    const project = parse_project(SAMPLES_DIR.div("transparencyGridThumbnails_false.aep"));
    expect(project.transparency_grid_thumbnails).toBe(false);
  });
});

describe("TestColorManagement", () => {
  /** Tests for CC 2024+ color management attributes. */

  test("test_colorManagementSystem_adobe", () => {
    const project = parse_project(SAMPLES_DIR.div("colorManagementSystem_adobe.aep"));
    expect(ColorManagementSystem.name_of(project.color_management_system)).toBe("ADOBE");
  });

  test("test_colorManagementSystem_ocio", () => {
    const project = parse_project(SAMPLES_DIR.div("colorManagementSystem_ocio.aep"));
    expect(ColorManagementSystem.name_of(project.color_management_system)).toBe("OCIO");
  });

  // `project.lut_interpolation_method.TRILINEAR` is a class attribute read
  // through an instance in Python; the port reads it from the enum itself.
  test("test_lutInterpolationMethod_trilinear", () => {
    const project = parse_project(SAMPLES_DIR.div("lutInterpolationMethod_trilinear.aep"));
    expect(project.lut_interpolation_method).toBe(LutInterpolationMethod.TRILINEAR);
  });

  test("test_lutInterpolationMethod_tetrahedral", () => {
    const project = parse_project(SAMPLES_DIR.div("lutInterpolationMethod_tetrahedral.aep"));
    expect(project.lut_interpolation_method).toBe(LutInterpolationMethod.TETRAHEDRAL);
  });
});

describe("TestRevision", () => {
  /** Tests for revision attribute. */

  /** A new project saved once has revision 1. */
  test("test_revision_save_01", () => {
    const project = parse_project(SAMPLES_DIR.div("save_01.aep"));
    expect(project.revision).toBe(1);
  });

  /** Projects with more user actions have higher revision numbers. */
  test("test_revision_increases_with_changes", () => {
    const project_simple = parse_project(SAMPLES_DIR.div("save_01.aep"));
    const project_changed = parse_project(SAMPLES_DIR.div("bitsPerChannel_16.aep"));
    expect(project_changed.revision).toBeGreaterThan(project_simple.revision);
  });

  test("test_revision_is_a_32_bit_counter", () => {
    // The stored counter exceeds 16 bits. AE 2026 reports 23,113,386 for
    // this file: the stored value plus the 13 edits AE makes on open.
    const project = parse_project(SAMPLES_DIR.parent.parent.div("bugs", "windows-1250_decoding_error.aep"));
    expect(project.revision).toBe(23_113_373);
  });
});

describe("TestActiveItem", () => {
  /** Tests for active_item attribute. */

  test("test_comp1_active", () => {
    const project = parse_project(VIEW_SAMPLES_DIR.div("comp1_active.aep"));
    const active_item = project.active_item;
    expect(active_item != null).toBe(true);
    if (active_item == null) throw new Error("project has no active item");
    expect(active_item.name).toBe("Comp 1");
  });

  test("test_comp2_active", () => {
    const project = parse_project(VIEW_SAMPLES_DIR.div("comp2_active.aep"));
    const active_item = project.active_item;
    expect(active_item != null).toBe(true);
    if (active_item == null) throw new Error("project has no active item");
    expect(active_item.name).toBe("Comp 2");
  });
});

describe("TestListColorProfiles", () => {
  /** Tests for Project.list_color_profiles(). */

  test("test_adobe_mode_matches_catalogue", () => {
    // Validated set-equal to AE listColorProfiles() (102 names, AE 2026).
    const project = parse_project(SAMPLES_DIR.div("workingSpace_sRGB.aep"));
    const profiles = project.list_color_profiles();
    expect(len(profiles)).toBe(102);
    for (const expected of ["sRGB IEC61966-2.1", "ProPhoto RGB", "Apple RGB"]) {
      expect(contains(profiles, expected)).toBe(true);
    }
  });

  test("test_ocio_mode_missing_config_returns_empty", () => {
    // This sample's stored ocioConfigurationFile path no longer exists; the
    // method degrades gracefully to an empty list.
    const project = parse_project(SAMPLES_DIR.div("colorManagementSystem_ocio.aep"));
    expect(ColorManagementSystem.name_of(project.color_management_system)).toBe("OCIO");
    expect(py_eq(project.list_color_profiles(), [])).toBe(true);
  });
});

describe("TestDynamicLinkGUID", () => {
  /**
   * Tests for Item.dynamic_link_guid.
   *
   * The id-derived formula was validated against AE 2026 (2026-07-14 probe:
   * all 11 items of a generated project matched, stable across re-open, and
   * reading the attribute left the chunk tree byte-identical).
   */

  test("test_derived_from_item_id", () => {
    const project = parse_project(SAMPLES_DIR.div("bitsPerChannel_8.aep"));
    expect(py_bool(project.items)).toBe(true);
    for (const [item_id, item] of project.items) {
      expect(item.dynamic_link_guid).toBe(`${format(item_id, "08x")}-0000-0000-0000-000000000000`);
    }
  });

  test("test_guid_shape", () => {
    const project = parse_project(SAMPLES_DIR.div("bitsPerChannel_8.aep"));
    const guid = project.items.values().next().value!.dynamic_link_guid;
    const groups = split(guid, "-");
    expect(py_eq(groups.map((g) => len(g)), [8, 4, 4, 4, 12])).toBe(true);
    expect(guid).toBe(guid.toLowerCase());
  });
});
