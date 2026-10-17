/** Tests for Project model parsing. */

import { describe, expect, test } from "bun:test";
import {
  b,
  bytes_,
  contains,
  len,
  lshift,
  Path,
  py_eq,
  split,
  str,
  ValueError,
} from "../../src/pyrt/index.ts";
import { make_tmp_path, raises } from "../../src/pyrt/pytest.ts";
import { type Project, parse as parse_aep } from "../../src/py_aep/index.ts";
import { parse_envelope } from "../../src/py_aep/color/envelope.ts";
import { BitsPerChannel, ColorManagementSystem, FeetFramesFilmType, FootageTimecodeDisplayStartType, FramesCountType, GpuAccelType, LutInterpolationMethod, TimeDisplayType } from "../../src/py_aep/enums/index.ts";
import "../../src/py_aep/binary/_register.ts";

const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "project");
const VIEW_SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "view");
const VERSIONS_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "versions");
const LAYER_SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "layer");
const COMP_SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "composition");

/** Roundtrip tests for Project.linear_blending. */
describe("TestRoundtripLinearBlending", () => {
  test("test_enable_linear_blending", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("linearBlending_false.aep")).project;
    expect(project.linear_blending).toBe(false);

    project.linear_blending = true;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.linear_blending).toBe(true);
  });

  test("test_disable_linear_blending", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("linearBlending_true.aep")).project;
    expect(project.linear_blending).toBe(true);

    project.linear_blending = false;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.linear_blending).toBe(false);
  });

  test("test_set_same_value_is_noop", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("linearBlending_true.aep")).project;
    expect(project.linear_blending).toBe(true);

    project.linear_blending = true; // no change

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.linear_blending).toBe(true);
  });
});

/** Roundtrip tests for Project.linearize_working_space. */
describe("TestRoundtripLinearizeWorkingSpace", () => {
  test("test_enable_linearize_working_space", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("linearizeWorkingSpace_false.aep")).project;
    expect(project.linearize_working_space).toBe(false);

    project.linearize_working_space = true;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.linearize_working_space).toBe(true);
  });

  test("test_disable_linearize_working_space", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("linearizeWorkingSpace_true.aep")).project;
    expect(project.linearize_working_space).toBe(true);

    project.linearize_working_space = false;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.linearize_working_space).toBe(false);
  });

  test("test_set_same_value_is_noop", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("linearizeWorkingSpace_false.aep")).project;
    expect(project.linearize_working_space).toBe(false);

    project.linearize_working_space = false; // no change

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.linearize_working_space).toBe(false);
  });
});

/** Roundtrip tests for Project.expression_engine. */
describe("TestRoundtripExpressionEngine", () => {
  test("test_set_extendscript", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("expressionEngine_javascript.aep")).project;
    expect(project.expression_engine).toBe("javascript-1.0");

    project.expression_engine = "extendscript";

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.expression_engine).toBe("extendscript");
  });

  test("test_set_javascript", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("linearBlending_false.aep")).project;
    expect(project.expression_engine).toBe("extendscript");

    project.expression_engine = "javascript-1.0";

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.expression_engine).toBe("javascript-1.0");
  });

  test("test_set_same_value_is_noop", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("expressionEngine_javascript.aep")).project;
    expect(project.expression_engine).toBe("javascript-1.0");

    project.expression_engine = "javascript-1.0";

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.expression_engine).toBe("javascript-1.0");
  });
});

/** Roundtrip tests for Project.color_management_system. */
describe("TestRoundtripColorManagementSystem", () => {
  test("test_set_ocio", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("colorManagementSystem_adobe.aep")).project;
    expect(project.color_management_system).toBe(ColorManagementSystem.ADOBE);

    project.color_management_system = ColorManagementSystem.OCIO;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.color_management_system).toBe(ColorManagementSystem.OCIO);
  });

  test("test_set_adobe", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("colorManagementSystem_ocio.aep")).project;
    expect(project.color_management_system).toBe(ColorManagementSystem.OCIO);

    project.color_management_system = ColorManagementSystem.ADOBE;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.color_management_system).toBe(ColorManagementSystem.ADOBE);
  });
});

/** Roundtrip tests for Project.lut_interpolation_method. */
describe("TestRoundtripLutInterpolationMethod", () => {
  test("test_set_tetrahedral", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("lutInterpolationMethod_trilinear.aep")).project;
    expect(project.lut_interpolation_method).toBe(LutInterpolationMethod.TRILINEAR);

    project.lut_interpolation_method = LutInterpolationMethod.TETRAHEDRAL;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.lut_interpolation_method).toBe(LutInterpolationMethod.TETRAHEDRAL);
  });

  test("test_set_trilinear", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("lutInterpolationMethod_tetrahedral.aep")).project;
    expect(project.lut_interpolation_method).toBe(LutInterpolationMethod.TETRAHEDRAL);

    project.lut_interpolation_method = LutInterpolationMethod.TRILINEAR;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.lut_interpolation_method).toBe(LutInterpolationMethod.TRILINEAR);
  });
});

/** Roundtrip tests for Project.ocio_configuration_file. */
describe("TestRoundtripOcioConfigurationFile", () => {
  test("test_set_ocio_config", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("colorManagementSystem_ocio.aep")).project;

    project.ocio_configuration_file = "new_config.ocio";

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.ocio_configuration_file).toBe("new_config.ocio");
  });
});

/** Roundtrip tests for Project.bits_per_channel. */
describe("TestRoundtripBitsPerChannel", () => {
  test("test_set_sixteen", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("bitsPerChannel_8.aep")).project;
    expect(project.bits_per_channel).toBe(BitsPerChannel.EIGHT);

    project.bits_per_channel = BitsPerChannel.SIXTEEN;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.bits_per_channel).toBe(BitsPerChannel.SIXTEEN);
  });

  test("test_set_thirty_two", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("bitsPerChannel_8.aep")).project;
    expect(project.bits_per_channel).toBe(BitsPerChannel.EIGHT);

    project.bits_per_channel = BitsPerChannel.THIRTY_TWO;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.bits_per_channel).toBe(BitsPerChannel.THIRTY_TWO);
    expect(project2._nhed.bits_per_channel).toBe(BitsPerChannel.to_binary(BitsPerChannel.THIRTY_TWO));
    expect(project2._nnhd.bits_per_channel).toBe(BitsPerChannel.to_binary(BitsPerChannel.THIRTY_TWO));
  });

  test("test_set_eight", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("bitsPerChannel_32.aep")).project;
    expect(project.bits_per_channel).toBe(BitsPerChannel.THIRTY_TWO);

    project.bits_per_channel = BitsPerChannel.EIGHT;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.bits_per_channel).toBe(BitsPerChannel.EIGHT);
  });
});

/** Roundtrip tests for Project.feet_frames_film_type. */
describe("TestRoundtripFeetFramesFilmType", () => {
  test("test_set_mm16", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("feetFramesFilmType_MM35.aep")).project;
    expect(project.feet_frames_film_type).toBe(FeetFramesFilmType.MM35);

    project.feet_frames_film_type = FeetFramesFilmType.MM16;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.feet_frames_film_type).toBe(FeetFramesFilmType.MM16);
    expect(project2._nhed.feet_frames_film_type).toBe(project2._nnhd.feet_frames_film_type);
  });

  /** Set to MM16 then back to MM35 via chained roundtrip. */
  test("test_set_mm35", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("feetFramesFilmType_MM35.aep")).project;
    project.feet_frames_film_type = FeetFramesFilmType.MM16;
    const mid = tmp_path.div("mid.aep");
    project.save(mid);

    const project2 = parse_aep(mid).project;
    project2.feet_frames_film_type = FeetFramesFilmType.MM35;
    const out = tmp_path.div("modified.aep");
    project2.save(out);
    const project3 = parse_aep(out).project;

    expect(project3.feet_frames_film_type).toBe(FeetFramesFilmType.MM35);
  });
});

/** Roundtrip tests for Project.footage_timecode_display_start_type. */
describe("TestRoundtripFootageTimecodeDisplayStartType", () => {
  test("test_set_start_0", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("footageTimecodeDisplayStartType_source.aep")).project;
    expect(project.footage_timecode_display_start_type).toBe(
      FootageTimecodeDisplayStartType.FTCS_USE_SOURCE_MEDIA,
    );

    project.footage_timecode_display_start_type = FootageTimecodeDisplayStartType.FTCS_START_0;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.footage_timecode_display_start_type).toBe(FootageTimecodeDisplayStartType.FTCS_START_0);
  });

  /** Set to START_0 then back to USE_SOURCE_MEDIA via chained roundtrip. */
  test("test_set_use_source_media", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("footageTimecodeDisplayStartType_source.aep")).project;
    project.footage_timecode_display_start_type = FootageTimecodeDisplayStartType.FTCS_START_0;
    const mid = tmp_path.div("mid.aep");
    project.save(mid);

    const project2 = parse_aep(mid).project;
    project2.footage_timecode_display_start_type = FootageTimecodeDisplayStartType.FTCS_USE_SOURCE_MEDIA;
    const out = tmp_path.div("modified.aep");
    project2.save(out);
    const project3 = parse_aep(out).project;

    expect(project3.footage_timecode_display_start_type).toBe(
      FootageTimecodeDisplayStartType.FTCS_USE_SOURCE_MEDIA,
    );
  });
});

/** Roundtrip tests for Project.frames_count_type. */
describe("TestRoundtripFramesCountType", () => {
  test("test_set_start_1", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("framesCountType_start0.aep")).project;
    expect(project.frames_count_type).toBe(FramesCountType.FC_START_0);

    project.frames_count_type = FramesCountType.FC_START_1;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.frames_count_type).toBe(FramesCountType.FC_START_1);
    expect(project2._nhed.frames_count_type).toBe(project2._nnhd.frames_count_type);
  });

  test("test_set_start_0", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("displayStartFrame_1.aep")).project;
    expect(project.frames_count_type).toBe(FramesCountType.FC_START_1);

    project.frames_count_type = FramesCountType.FC_START_0;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.frames_count_type).toBe(FramesCountType.FC_START_0);
  });
});

/** Roundtrip tests for Project.display_start_frame. */
describe("TestRoundtripDisplayStartFrame", () => {
  test("test_set_1", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("framesCountType_start0.aep")).project;
    expect(project.display_start_frame).toBe(0);

    project.display_start_frame = 1;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.display_start_frame).toBe(1);
    expect(project2._nhed.frames_count_type).toBe(project2._nnhd.frames_count_type);
  });

  test("test_set_0", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("displayStartFrame_1.aep")).project;
    expect(project.display_start_frame).toBe(1);

    project.display_start_frame = 0;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.display_start_frame).toBe(0);
  });
});

/** Roundtrip tests for Project.frames_use_feet_frames. */
describe("TestRoundtripFramesUseFeetFrames", () => {
  test("test_enable", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("framesUseFeetFrames_false.aep")).project;
    expect(project.frames_use_feet_frames).toBe(false);

    project.frames_use_feet_frames = true;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.frames_use_feet_frames).toBe(true);
    expect(project2._nhed.frames_use_feet_frames).toBe(project2._nnhd.frames_use_feet_frames);
  });

  test("test_disable", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("framesUseFeetFrames_true.aep")).project;
    expect(project.frames_use_feet_frames).toBe(true);

    project.frames_use_feet_frames = false;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.frames_use_feet_frames).toBe(false);
    expect(project2._nhed.frames_use_feet_frames).toBe(project2._nnhd.frames_use_feet_frames);
  });
});

/** Roundtrip tests for Project.time_display_type. */
describe("TestRoundtripTimeDisplayType", () => {
  test("test_set_frames", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("timeDisplayType_timecode.aep")).project;
    expect(project.time_display_type).toBe(TimeDisplayType.TIMECODE);

    project.time_display_type = TimeDisplayType.FRAMES;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.time_display_type).toBe(TimeDisplayType.FRAMES);
    expect(project2._nhed.time_display_type).toBe(project2._nnhd.time_display_type);
  });

  test("test_set_timecode", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("timeDisplayType_frames.aep")).project;
    expect(project.time_display_type).toBe(TimeDisplayType.FRAMES);

    project.time_display_type = TimeDisplayType.TIMECODE;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.time_display_type).toBe(TimeDisplayType.TIMECODE);
  });
});

/** Roundtrip tests for Project.transparency_grid_thumbnails. */
describe("TestRoundtripTransparencyGridThumbnails", () => {
  test("test_enable", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("transparencyGridThumbnails_false.aep")).project;
    expect(project.transparency_grid_thumbnails).toBe(false);

    project.transparency_grid_thumbnails = true;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.transparency_grid_thumbnails).toBe(true);
    expect(project2._nhed.transparency_grid_thumbnails).toBe(project2._nnhd.transparency_grid_thumbnails);
  });

  test("test_disable", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("transparencyGridThumbnails_true.aep")).project;
    expect(project.transparency_grid_thumbnails).toBe(true);

    project.transparency_grid_thumbnails = false;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.transparency_grid_thumbnails).toBe(false);
  });
});

/** Roundtrip tests for Project.compensate_for_scene_referred_profiles. */
describe("TestRoundtripCompensateForSceneReferredProfiles", () => {
  test("test_enable", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("compensateForSceneReferredProfiles_false.aep")).project;
    expect(project.compensate_for_scene_referred_profiles).toBe(false);

    project.compensate_for_scene_referred_profiles = true;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.compensate_for_scene_referred_profiles).toBe(true);
  });

  test("test_disable", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("compensateForSceneReferredProfiles_true.aep")).project;
    expect(project.compensate_for_scene_referred_profiles).toBe(true);

    project.compensate_for_scene_referred_profiles = false;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.compensate_for_scene_referred_profiles).toBe(false);
  });
});

/** Roundtrip tests for Project.audio_sample_rate. */
describe("TestRoundtripAudioSampleRate", () => {
  test("test_set_96000", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("Audio_sample_rate_22050.aep")).project;
    expect(project.audio_sample_rate).toBe(22050.0);

    project.audio_sample_rate = 96000.0;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.audio_sample_rate).toBe(96000.0);
  });

  test("test_set_22050", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("Audio_sample_rate_96000.aep")).project;
    expect(project.audio_sample_rate).toBe(96000.0);

    project.audio_sample_rate = 22050.0;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.audio_sample_rate).toBe(22050.0);
  });
});

/** Roundtrip tests for Project.working_gamma. */
describe("TestRoundtripWorkingGamma", () => {
  test("test_set_2_2", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("workingGamma_2.4.aep")).project;
    expect(project.working_gamma).toBe(2.4);

    project.working_gamma = 2.2;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.working_gamma).toBe(2.2);
  });

  test("test_set_2_4", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("workingGamma_2.2.aep")).project;
    expect(project.working_gamma).toBe(2.2);

    project.working_gamma = 2.4;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.working_gamma).toBe(2.4);
  });
});

/** Roundtrip tests for Project.gpu_accel_type. */
describe("TestRoundtripGpuAccelType", () => {
  test("test_set_software", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("gpuAccelType_mercury_gpu_acceleration_CUDA.aep")).project;
    expect(project.gpu_accel_type).toBe(GpuAccelType.CUDA);

    project.gpu_accel_type = GpuAccelType.SOFTWARE;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.gpu_accel_type).toBe(GpuAccelType.SOFTWARE);
  });

  test("test_set_cuda", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("gpuAccelType_mercury_software_only.aep")).project;
    expect(project.gpu_accel_type).toBe(GpuAccelType.SOFTWARE);

    project.gpu_accel_type = GpuAccelType.CUDA;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.gpu_accel_type).toBe(GpuAccelType.CUDA);
  });

  /**
   * A renderer id py_aep does not map reads back as its UUID string,
   * and that string can be written back.
   */
  test("test_unrecognized_uuid_roundtrips", () => {
    const tmp_path = make_tmp_path();
    const uuid = "01234567-89ab-cdef-0123-456789abcdef";
    const project = parse_aep(SAMPLES_DIR.div("gpuAccelType_mercury_software_only.aep")).project;
    (project as any).gpu_accel_type = uuid;
    expect(project.gpu_accel_type).toBe(uuid);
    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;
    expect(project2.gpu_accel_type).toBe(uuid);
    project2.gpu_accel_type = project2.gpu_accel_type;
  });

  test("test_rejects_malformed_uuid", () => {
    const project = parse_aep(SAMPLES_DIR.div("gpuAccelType_mercury_software_only.aep")).project;
    raises(
      ValueError,
      () => {
        (project as any).gpu_accel_type = "not-a-uuid";
      },
      "UUID",
    );
    expect(project.gpu_accel_type).toBe(GpuAccelType.SOFTWARE);
  });
});

/**
 * `cpid` holds the ICC profile id of the working space.
 *
 * AE 2026 rewrites it when a script sets `workingSpace` (the id of the
 * new profile; all 0xFF for "None"), and every AE-saved project whose
 * working space is an ICC profile has `cpid` equal to that profile's id.
 * OCIO projects store all 0xFF.
 */
class TestRoundtripWorkingSpaceProfileId {
  static ACESCCT_DONOR = new Path(import.meta.path).parent.parent.parent.div(
    "samples",
    "models",
    "footage",
    "override_media_colorspace_working_colorspace_-aces_cg_or_cct.aep",
  );

  static _cpid(project: Project): Uint8Array {
    return project._rifx.chunks.find((c) => c.chunk_type === "cpid")!.tobytes();
  }
}

describe("TestRoundtripWorkingSpaceProfileId", () => {
  test("test_adobe_working_space_writes_profile_id", () => {
    const tmp_path = make_tmp_path();
    // The ACEScct ICC exactly as AE embedded it, next to the cpid AE
    // wrote for it.
    const donor = parse_aep(TestRoundtripWorkingSpaceProfileId.ACESCCT_DONOR).project;
    expect(donor._ws_utf8 != null).toBe(true);
    const icc = parse_envelope(donor._ws_utf8!.value).data;
    expect(bytes_.hex(TestRoundtripWorkingSpaceProfileId._cpid(donor))).toBe("ae27d1e66d65c5a0a50fe0ec149a24fa");
    const icc_dir = tmp_path.div("icc");
    icc_dir.mkdir();
    icc_dir.div("ACEScct.icc").write_bytes(icc);

    const project = parse_aep(SAMPLES_DIR.div("workingSpace_sRGB.aep")).project;
    project.icc_profile_dirs = [icc_dir];
    project.working_space = "ACEScct";
    const out = tmp_path.div("ws.aep");
    project.save(out);
    const project2 = parse_aep(out).project;
    expect(project2.working_space).toBe("ACEScct");
    expect(py_eq(TestRoundtripWorkingSpaceProfileId._cpid(project2), TestRoundtripWorkingSpaceProfileId._cpid(donor))).toBe(true);
  });

  test("test_ocio_working_space_writes_no_profile_id", () => {
    const config = new Path(import.meta.path).parent.parent.parent.div("samples", "assets", "config.ocio");
    const project = parse_aep(SAMPLES_DIR.div("workingSpace_sRGB.aep")).project;
    expect(py_eq(TestRoundtripWorkingSpaceProfileId._cpid(project), bytes_.repeat(b("\xff"), 16))).toBe(false);
    project.color_management_system = ColorManagementSystem.OCIO;
    project.ocio_configuration_file = str(config);
    project.working_space = "ACEScg";
    expect(py_eq(TestRoundtripWorkingSpaceProfileId._cpid(project), bytes_.repeat(b("\xff"), 16))).toBe(true);
  });
});

/** Roundtrip tests for Project.revision. */
describe("TestRoundtripRevision", () => {
  test("test_set_revision", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("save_01.aep")).project;
    const original = project.revision;

    project.revision = original + 10;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.revision).toBe(original + 10);
  });

  test("test_set_revision_above_16_bits", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("save_01.aep")).project;
    project.revision = 70_000;
    const out = tmp_path.div("modified.aep");
    project.save(out);
    expect(parse_aep(out).project.revision).toBe(70_000);
    raises(ValueError, () => {
      project.revision = lshift(1, 32);
    });
  });

  // Roundtrip tests for Project.xmp_packet.

  test("test_set_xmp_packet", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("linearBlending_false.aep")).project;

    // NOTE(port): models/project.ts parses xmp_packet via pyrt etree (ET_fromstring), whose Element has the same get/set API.
    const xmp_packet = project.xmp_packet;
    if (xmp_packet == null) throw new Error("project has no XMP packet");
    xmp_packet.set("py_aep_test_marker", "1");
    project.xmp_packet = xmp_packet;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    const xmp_packet2 = project2.xmp_packet;
    if (xmp_packet2 == null) throw new Error("saved project has no XMP packet");
    expect(xmp_packet2.get("py_aep_test_marker")).toBe("1");
  });
});

/** Parse then save must produce identical bytes. */
describe("TestIdempotency", () => {
  test("test_roundtrip_complete", () => {
    const tmp_path = make_tmp_path();
    const aep_path = VERSIONS_DIR.div("ae2025", "complete.aep");
    const original_bytes = aep_path.read_bytes();

    const app = parse_aep(aep_path);
    const out = tmp_path.div("roundtrip.aep");
    app.project.save(out);
    const roundtrip_bytes = out.read_bytes();

    expect(py_eq(original_bytes, roundtrip_bytes)).toBe(true);
  });
});

/** Project.list_color_profiles() in OCIO mode with a resolvable config. */
class TestListColorProfilesOcio {
  static CONFIG = new Path(import.meta.path).parent.parent.parent.div("samples", "assets", "config.ocio");
}

describe("TestListColorProfilesOcio", () => {
  test("test_resolvable_config_lists_colorspaces", () => {
    const project = parse_aep(SAMPLES_DIR.div("colorManagementSystem_ocio.aep")).project;
    project.ocio_configuration_file = str(TestListColorProfilesOcio.CONFIG);
    const profiles = project.list_color_profiles();
    expect(len(profiles)).toBe(22); // == PyOpenColorIO
    expect(contains(profiles, "ACEScg")).toBe(true);
  });

  test("test_listed_names_are_assignable_as_working_space", () => {
    // Every listed OCIO name is a valid working_space, and what it reads
    // back as can be assigned again (read -> write -> read is stable).
    //
    // It does NOT read back as the name assigned: AE stores a direct
    // colorspace pick's `colorProfileName` as "<family>/<name>", and the
    // getter is AE-faithful (ExtendScript's workingSpace echoes the same
    // qualified string). That asymmetry is AE's, not py_aep's.
    const project = parse_aep(SAMPLES_DIR.div("colorManagementSystem_ocio.aep")).project;
    project.ocio_configuration_file = str(TestListColorProfilesOcio.CONFIG);
    for (const name of project.list_color_profiles()) {
      project.working_space = name;
      const stored = project.working_space;
      expect(split(stored, "/").at(-1)).toBe(name);
      project.working_space = stored;
      expect(project.working_space).toBe(stored);
    }
  });
});

/**
 * The `PwCs` (working) and `pdvc` (display) color-profile slots must not
 * be confused for one another.
 *
 * Both slots hold a `Utf8` whose unset value is the literal `{}`, so binding
 * them by the ORDER the envelopes appear in reads a display space as the
 * working space whenever the working space is unset. They are bound by their
 * marker chunk instead, on both the read and the write side.
 *
 * AE 2026 authenticates the shape: it opens a py_aep file written this way
 * and re-saves it keeping the envelope under `pdvc` with `PwCs` still `{}`.
 */
class TestColorProfileSlotBinding {
  // An AE-authored OCIO project whose working space is unset (`PwCs` == {}).
  static UNSET_WS = LAYER_SAMPLES_DIR.div("geometry_probe.aep");
}

describe("TestColorProfileSlotBinding", () => {
  test("test_display_space_roundtrips_with_working_space_unset", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(TestColorProfileSlotBinding.UNSET_WS).project;
    expect(project.working_space).toBe("None");
    expect(project.display_color_space).toBe("None");

    project.display_color_space = ["ACES", "sRGB"];

    const out = tmp_path.div("display.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    expect(project2.display_color_space).toBe("ACES/sRGB");
  });

  test("test_display_space_write_does_not_leak_into_working_space", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(TestColorProfileSlotBinding.UNSET_WS).project;
    project.display_color_space = ["ACES", "sRGB"];

    const out = tmp_path.div("display.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    // Writing only the DISPLAY space must not give the project a working
    // space it never had.
    expect(project2.working_space).toBe("None");
  });

  test("test_both_slots_roundtrip_together", () => {
    const tmp_path = make_tmp_path();
    const config = new Path(import.meta.path).parent.parent.parent.div("samples", "assets", "config.ocio");
    const project = parse_aep(TestColorProfileSlotBinding.UNSET_WS).project;
    project.ocio_configuration_file = str(config);
    project.working_space = "ACEScg";
    project.display_color_space = ["ACES", "sRGB"];

    const out = tmp_path.div("both.aep");
    project.save(out);
    const project2 = parse_aep(out).project;

    // A direct colorspace pick reads back qualified as "<family>/<name>"
    // (AE's stored colorProfileName) - see
    // TestListColorProfilesOcio::test_listed_names_are_assignable_as_working_space.
    expect(project2.working_space).toBe("ACES/ACEScg");
    expect(project2.display_color_space).toBe("ACES/sRGB");
  });
});
