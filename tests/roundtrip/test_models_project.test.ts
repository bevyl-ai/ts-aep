/** Tests for Project model parsing. */

import { describe, expect, test } from "bun:test";
import {
  b,
  Bytes,
  contains,
  len,
  lshift,
  Path,
  assert,
  valueEquals,
  split,
  StopIteration,
  str,
  ValueError,
} from "../../src/pyrt/index.ts";
import { makeTmpPath, raises } from "../../src/pyrt/pytest.ts";
import { projectBytes } from "../helpers.ts";
import * as py_aep from "../../src/py_aep/index.ts";
import { type Project, parse as parseAep } from "../../src/py_aep/index.ts";
import { findByListType } from "../../src/py_aep/binary/utils.ts";
import { parseEnvelope } from "../../src/py_aep/color/envelope.ts";
import { ColorProfileNotFoundError, iccProfileId } from "../../src/py_aep/color/icc.ts";
import { BitsPerChannel, ColorManagementSystem, FeetFramesFilmType, FootageTimecodeDisplayStartType, FramesCountType, GpuAccelType, LutInterpolationMethod, TimeDisplayType } from "../../src/py_aep/enums/index.ts";
import "../../src/py_aep/binary/_register.ts";
import type { Chunk } from "../../src/py_aep/binary/chunk.ts";

const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "project");
const VIEW_SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "view");
const VERSIONS_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "versions");
const LAYER_SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "layer");
const COMP_SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "composition");

/** Roundtrip tests for Project.linearBlending. */
describe("TestRoundtripLinearBlending", () => {
  test("test_enable_linear_blending", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("linearBlending_false.aep")).project;
    expect(project.linearBlending).toBe(false);

    project.linearBlending = true;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.linearBlending).toBe(true);
  });

  test("test_disable_linear_blending", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("linearBlending_true.aep")).project;
    expect(project.linearBlending).toBe(true);

    project.linearBlending = false;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.linearBlending).toBe(false);
  });

  test("test_set_same_value_is_noop", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("linearBlending_true.aep")).project;
    expect(project.linearBlending).toBe(true);

    project.linearBlending = true; // no change

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.linearBlending).toBe(true);
  });
});

/** Roundtrip tests for Project.linearizeWorkingSpace. */
describe("TestRoundtripLinearizeWorkingSpace", () => {
  test("test_enable_linearize_working_space", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("linearizeWorkingSpace_false.aep")).project;
    expect(project.linearizeWorkingSpace).toBe(false);

    project.linearizeWorkingSpace = true;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.linearizeWorkingSpace).toBe(true);
  });

  test("test_disable_linearize_working_space", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("linearizeWorkingSpace_true.aep")).project;
    expect(project.linearizeWorkingSpace).toBe(true);

    project.linearizeWorkingSpace = false;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.linearizeWorkingSpace).toBe(false);
  });

  test("test_set_same_value_is_noop", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("linearizeWorkingSpace_false.aep")).project;
    expect(project.linearizeWorkingSpace).toBe(false);

    project.linearizeWorkingSpace = false; // no change

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.linearizeWorkingSpace).toBe(false);
  });
});

/** Roundtrip tests for Project.expressionEngine. */
describe("TestRoundtripExpressionEngine", () => {
  test("test_set_extendscript", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("expressionEngine_javascript.aep")).project;
    expect(project.expressionEngine).toBe("javascript-1.0");

    project.expressionEngine = "extendscript";

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.expressionEngine).toBe("extendscript");
  });

  test("test_set_javascript", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("linearBlending_false.aep")).project;
    expect(project.expressionEngine).toBe("extendscript");

    project.expressionEngine = "javascript-1.0";

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.expressionEngine).toBe("javascript-1.0");
  });

  test("test_set_same_value_is_noop", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("expressionEngine_javascript.aep")).project;
    expect(project.expressionEngine).toBe("javascript-1.0");

    project.expressionEngine = "javascript-1.0";

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.expressionEngine).toBe("javascript-1.0");
  });
});

/** Roundtrip tests for Project.colorManagementSystem. */
describe("TestRoundtripColorManagementSystem", () => {
  test("test_set_ocio", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("colorManagementSystem_adobe.aep")).project;
    expect(project.colorManagementSystem).toBe(ColorManagementSystem.ADOBE);

    project.colorManagementSystem = ColorManagementSystem.OCIO;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.colorManagementSystem).toBe(ColorManagementSystem.OCIO);
  });

  test("test_set_adobe", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("colorManagementSystem_ocio.aep")).project;
    expect(project.colorManagementSystem).toBe(ColorManagementSystem.OCIO);

    project.colorManagementSystem = ColorManagementSystem.ADOBE;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.colorManagementSystem).toBe(ColorManagementSystem.ADOBE);
  });
});

/** Roundtrip tests for Project.lutInterpolationMethod. */
describe("TestRoundtripLutInterpolationMethod", () => {
  test("test_set_tetrahedral", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("lutInterpolationMethod_trilinear.aep")).project;
    expect(project.lutInterpolationMethod).toBe(LutInterpolationMethod.TRILINEAR);

    project.lutInterpolationMethod = LutInterpolationMethod.TETRAHEDRAL;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.lutInterpolationMethod).toBe(LutInterpolationMethod.TETRAHEDRAL);
  });

  test("test_set_trilinear", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("lutInterpolationMethod_tetrahedral.aep")).project;
    expect(project.lutInterpolationMethod).toBe(LutInterpolationMethod.TETRAHEDRAL);

    project.lutInterpolationMethod = LutInterpolationMethod.TRILINEAR;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.lutInterpolationMethod).toBe(LutInterpolationMethod.TRILINEAR);
  });
});

/** Roundtrip tests for Project.ocioConfigurationFile. */
describe("TestRoundtripOcioConfigurationFile", () => {
  test("test_set_ocio_config", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("colorManagementSystem_ocio.aep")).project;

    project.ocioConfigurationFile = "new_config.ocio";

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.ocioConfigurationFile).toBe("new_config.ocio");
  });
});

/** Roundtrip tests for Project.bitsPerChannel. */
describe("TestRoundtripBitsPerChannel", () => {
  test("test_set_sixteen", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("bitsPerChannel_8.aep")).project;
    expect(project.bitsPerChannel).toBe(BitsPerChannel.EIGHT);

    project.bitsPerChannel = BitsPerChannel.SIXTEEN;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.bitsPerChannel).toBe(BitsPerChannel.SIXTEEN);
  });

  test("test_set_thirty_two", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("bitsPerChannel_8.aep")).project;
    expect(project.bitsPerChannel).toBe(BitsPerChannel.EIGHT);

    project.bitsPerChannel = BitsPerChannel.THIRTY_TWO;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.bitsPerChannel).toBe(BitsPerChannel.THIRTY_TWO);
    expect(project2._nhed.bitsPerChannel).toBe(BitsPerChannel.toBinary(BitsPerChannel.THIRTY_TWO));
    expect(project2._nnhd.bitsPerChannel).toBe(BitsPerChannel.toBinary(BitsPerChannel.THIRTY_TWO));
  });

  test("test_set_eight", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("bitsPerChannel_32.aep")).project;
    expect(project.bitsPerChannel).toBe(BitsPerChannel.THIRTY_TWO);

    project.bitsPerChannel = BitsPerChannel.EIGHT;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.bitsPerChannel).toBe(BitsPerChannel.EIGHT);
  });
});

/** Roundtrip tests for Project.feetFramesFilmType. */
describe("TestRoundtripFeetFramesFilmType", () => {
  test("test_set_mm16", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("feetFramesFilmType_MM35.aep")).project;
    expect(project.feetFramesFilmType).toBe(FeetFramesFilmType.MM35);

    project.feetFramesFilmType = FeetFramesFilmType.MM16;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.feetFramesFilmType).toBe(FeetFramesFilmType.MM16);
    expect(project2._nhed.feetFramesFilmType).toBe(project2._nnhd.feetFramesFilmType);
  });

  /** Set to MM16 then back to MM35 via chained roundtrip. */
  test("test_set_mm35", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("feetFramesFilmType_MM35.aep")).project;
    project.feetFramesFilmType = FeetFramesFilmType.MM16;
    const mid = tmpPath.div("mid.aep");
    project.save(mid);

    const project2 = parseAep(mid).project;
    project2.feetFramesFilmType = FeetFramesFilmType.MM35;
    const out = tmpPath.div("modified.aep");
    project2.save(out);
    const project3 = parseAep(out).project;

    expect(project3.feetFramesFilmType).toBe(FeetFramesFilmType.MM35);
  });
});

/** Roundtrip tests for Project.footageTimecodeDisplayStartType. */
describe("TestRoundtripFootageTimecodeDisplayStartType", () => {
  test("test_set_start_0", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("footageTimecodeDisplayStartType_source.aep")).project;
    expect(project.footageTimecodeDisplayStartType).toBe(
      FootageTimecodeDisplayStartType.FTCS_USE_SOURCE_MEDIA,
    );

    project.footageTimecodeDisplayStartType = FootageTimecodeDisplayStartType.FTCS_START_0;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.footageTimecodeDisplayStartType).toBe(FootageTimecodeDisplayStartType.FTCS_START_0);
  });

  /** Set to START_0 then back to USE_SOURCE_MEDIA via chained roundtrip. */
  test("test_set_use_source_media", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("footageTimecodeDisplayStartType_source.aep")).project;
    project.footageTimecodeDisplayStartType = FootageTimecodeDisplayStartType.FTCS_START_0;
    const mid = tmpPath.div("mid.aep");
    project.save(mid);

    const project2 = parseAep(mid).project;
    project2.footageTimecodeDisplayStartType = FootageTimecodeDisplayStartType.FTCS_USE_SOURCE_MEDIA;
    const out = tmpPath.div("modified.aep");
    project2.save(out);
    const project3 = parseAep(out).project;

    expect(project3.footageTimecodeDisplayStartType).toBe(
      FootageTimecodeDisplayStartType.FTCS_USE_SOURCE_MEDIA,
    );
  });
});

/** Roundtrip tests for Project.framesCountType. */
describe("TestRoundtripFramesCountType", () => {
  test("test_set_start_1", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("framesCountType_start0.aep")).project;
    expect(project.framesCountType).toBe(FramesCountType.FC_START_0);

    project.framesCountType = FramesCountType.FC_START_1;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.framesCountType).toBe(FramesCountType.FC_START_1);
    expect(project2._nhed.framesCountType).toBe(project2._nnhd.framesCountType);
  });

  test("test_set_start_0", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("displayStartFrame_1.aep")).project;
    expect(project.framesCountType).toBe(FramesCountType.FC_START_1);

    project.framesCountType = FramesCountType.FC_START_0;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.framesCountType).toBe(FramesCountType.FC_START_0);
  });
});

/** Roundtrip tests for Project.displayStartFrame. */
describe("TestRoundtripDisplayStartFrame", () => {
  test("test_set_1", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("framesCountType_start0.aep")).project;
    expect(project.displayStartFrame).toBe(0);

    project.displayStartFrame = 1;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.displayStartFrame).toBe(1);
    expect(project2._nhed.framesCountType).toBe(project2._nnhd.framesCountType);
  });

  test("test_set_0", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("displayStartFrame_1.aep")).project;
    expect(project.displayStartFrame).toBe(1);

    project.displayStartFrame = 0;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.displayStartFrame).toBe(0);
  });
});

/** Roundtrip tests for Project.framesUseFeetFrames. */
describe("TestRoundtripFramesUseFeetFrames", () => {
  test("test_enable", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("framesUseFeetFrames_false.aep")).project;
    expect(project.framesUseFeetFrames).toBe(false);

    project.framesUseFeetFrames = true;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.framesUseFeetFrames).toBe(true);
    expect(project2._nhed.framesUseFeetFrames).toBe(project2._nnhd.framesUseFeetFrames);
  });

  test("test_disable", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("framesUseFeetFrames_true.aep")).project;
    expect(project.framesUseFeetFrames).toBe(true);

    project.framesUseFeetFrames = false;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.framesUseFeetFrames).toBe(false);
    expect(project2._nhed.framesUseFeetFrames).toBe(project2._nnhd.framesUseFeetFrames);
  });
});

/** Roundtrip tests for Project.timeDisplayType. */
describe("TestRoundtripTimeDisplayType", () => {
  test("test_set_frames", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("timeDisplayType_timecode.aep")).project;
    expect(project.timeDisplayType).toBe(TimeDisplayType.TIMECODE);

    project.timeDisplayType = TimeDisplayType.FRAMES;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.timeDisplayType).toBe(TimeDisplayType.FRAMES);
    expect(project2._nhed.timeDisplayType).toBe(project2._nnhd.timeDisplayType);
  });

  test("test_set_timecode", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("timeDisplayType_frames.aep")).project;
    expect(project.timeDisplayType).toBe(TimeDisplayType.FRAMES);

    project.timeDisplayType = TimeDisplayType.TIMECODE;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.timeDisplayType).toBe(TimeDisplayType.TIMECODE);
  });
});

/** Roundtrip tests for Project.transparencyGridThumbnails. */
describe("TestRoundtripTransparencyGridThumbnails", () => {
  test("test_enable", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("transparencyGridThumbnails_false.aep")).project;
    expect(project.transparencyGridThumbnails).toBe(false);

    project.transparencyGridThumbnails = true;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.transparencyGridThumbnails).toBe(true);
    expect(project2._nhed.transparencyGridThumbnails).toBe(project2._nnhd.transparencyGridThumbnails);
  });

  test("test_disable", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("transparencyGridThumbnails_true.aep")).project;
    expect(project.transparencyGridThumbnails).toBe(true);

    project.transparencyGridThumbnails = false;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.transparencyGridThumbnails).toBe(false);
  });
});

/** Roundtrip tests for Project.compensateForSceneReferredProfiles. */
describe("TestRoundtripCompensateForSceneReferredProfiles", () => {
  test("test_enable", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("compensateForSceneReferredProfiles_false.aep")).project;
    expect(project.compensateForSceneReferredProfiles).toBe(false);

    project.compensateForSceneReferredProfiles = true;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.compensateForSceneReferredProfiles).toBe(true);
  });

  test("test_disable", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("compensateForSceneReferredProfiles_true.aep")).project;
    expect(project.compensateForSceneReferredProfiles).toBe(true);

    project.compensateForSceneReferredProfiles = false;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.compensateForSceneReferredProfiles).toBe(false);
  });
});

/** Roundtrip tests for Project.audioSampleRate. */
describe("TestRoundtripAudioSampleRate", () => {
  test("test_set_96000", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("Audio_sample_rate_22050.aep")).project;
    expect(project.audioSampleRate).toBe(22050.0);

    project.audioSampleRate = 96000.0;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.audioSampleRate).toBe(96000.0);
  });

  test("test_set_22050", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("Audio_sample_rate_96000.aep")).project;
    expect(project.audioSampleRate).toBe(96000.0);

    project.audioSampleRate = 22050.0;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.audioSampleRate).toBe(22050.0);
  });
});

/** Roundtrip tests for Project.workingGamma. */
describe("TestRoundtripWorkingGamma", () => {
  test("test_set_2_2", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("workingGamma_2.4.aep")).project;
    expect(project.workingGamma).toBe(2.4);

    project.workingGamma = 2.2;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.workingGamma).toBe(2.2);
  });

  test("test_set_2_4", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("workingGamma_2.2.aep")).project;
    expect(project.workingGamma).toBe(2.2);

    project.workingGamma = 2.4;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.workingGamma).toBe(2.4);
  });
});

/** Roundtrip tests for Project.gpuAccelType. */
describe("TestRoundtripGpuAccelType", () => {
  test("test_set_software", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("gpuAccelType_mercury_gpu_acceleration_CUDA.aep")).project;
    expect(project.gpuAccelType).toBe(GpuAccelType.CUDA);

    project.gpuAccelType = GpuAccelType.SOFTWARE;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.gpuAccelType).toBe(GpuAccelType.SOFTWARE);
  });

  test("test_set_cuda", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("gpuAccelType_mercury_software_only.aep")).project;
    expect(project.gpuAccelType).toBe(GpuAccelType.SOFTWARE);

    project.gpuAccelType = GpuAccelType.CUDA;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.gpuAccelType).toBe(GpuAccelType.CUDA);
  });

  /**
   * A renderer id py_aep does not map reads back as its UUID string,
   * and that string can be written back.
   */
  test("test_unrecognized_uuid_roundtrips", () => {
    const tmpPath = makeTmpPath();
    const uuid = "01234567-89ab-cdef-0123-456789abcdef";
    const project = parseAep(SAMPLES_DIR.div("gpuAccelType_mercury_software_only.aep")).project;
    project.gpuAccelType = uuid;
    expect(project.gpuAccelType).toBe(uuid);
    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;
    expect(project2.gpuAccelType).toBe(uuid);
    project2.gpuAccelType = project2.gpuAccelType;
  });

  test("test_rejects_malformed_uuid", () => {
    const project = parseAep(SAMPLES_DIR.div("gpuAccelType_mercury_software_only.aep")).project;
    raises(
      ValueError,
      () => {
        project.gpuAccelType = "not-a-uuid";
      },
      "UUID",
    );
    expect(project.gpuAccelType).toBe(GpuAccelType.SOFTWARE);
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
    const cpid = project._rifx.chunks.find((c) => c.chunkType === "cpid");
    if (cpid == null) throw new StopIteration();
    return cpid.tobytes();
  }
}

describe("TestRoundtripWorkingSpaceProfileId", () => {
  test("test_adobe_working_space_writes_profile_id", () => {
    const tmpPath = makeTmpPath();
    // The ACEScct ICC exactly as AE embedded it, next to the cpid AE
    // wrote for it.
    const donor = parseAep(TestRoundtripWorkingSpaceProfileId.ACESCCT_DONOR).project;
    assert(donor._wsUtf8 != null);
    const icc = parseEnvelope(donor._wsUtf8.value).data;
    expect(Bytes.toHex(TestRoundtripWorkingSpaceProfileId._cpid(donor))).toBe("ae27d1e66d65c5a0a50fe0ec149a24fa");
    const iccDir = tmpPath.div("icc");
    iccDir.mkdir();
    iccDir.div("ACEScct.icc").writeBytes(icc);

    const project = parseAep(SAMPLES_DIR.div("workingSpace_sRGB.aep")).project;
    project.iccProfileDirs = [iccDir];
    project.workingSpace = "ACEScct";
    const out = tmpPath.div("ws.aep");
    project.save(out);
    const project2 = parseAep(out).project;
    expect(project2.workingSpace).toBe("ACEScct");
    expect(valueEquals(TestRoundtripWorkingSpaceProfileId._cpid(project2), TestRoundtripWorkingSpaceProfileId._cpid(donor))).toBe(true);
  });

  test("test_ocio_working_space_writes_no_profile_id", () => {
    const config = new Path(import.meta.path).parent.parent.parent.div("samples", "assets", "config.ocio");
    const project = parseAep(SAMPLES_DIR.div("workingSpace_sRGB.aep")).project;
    expect(valueEquals(TestRoundtripWorkingSpaceProfileId._cpid(project), Bytes.repeat(b("\xff"), 16))).toBe(false);
    project.colorManagementSystem = ColorManagementSystem.OCIO;
    project.ocioConfigurationFile = str(config);
    project.workingSpace = "ACEScg";
    expect(valueEquals(TestRoundtripWorkingSpaceProfileId._cpid(project), Bytes.repeat(b("\xff"), 16))).toBe(true);
  });
});

function _profilePool(project: Project): Chunk[] {
  return findByListType(project._rifx.chunks, "CPPl").chunks;
}

/**
 * Before AE 22 the working space is a `pprf` ICC in `LIST:CPPl`, named
 * by its profile id in `cpid`.
 *
 * Measured on AE 15.1: it re-saves this pool as py_aep writes it, keeps a
 * profile nothing refers to anymore, sorts the pool by profile id, and
 * renders a new 15.1 project with an sRGB working space like its own
 * template.
 */
class TestRoundtripPre22WorkingSpace {
  // An AE 15 pool: sRGB IEC61966-2.1 (the working space), then SDTV NTSC.
  static DONOR = VERSIONS_DIR.div("ae2018", "complete.aep");
  static SRGB = "sRGB IEC61966-2.1";
  static SRGB_ID = Bytes.fromHex("1d3fda2edb4a89ab60a23c5f7c7d81dd");
  static NTSC_ID = Bytes.fromHex("2734184f30e0dfca20be1a95a0a65519");

  static _icc_dir(tmpPath: Path): Path {
    // The ICCs exactly as AE stored them, so no installed profile is needed.
    const iccDir = tmpPath.div("icc");
    iccDir.mkdir();
    for (const [i, pprf] of _profilePool(parseAep(this.DONOR).project).entries()) {
      iccDir.div(`${i}.icc`).writeBytes(pprf.data);
    }
    return iccDir;
  }
}

describe("TestRoundtripPre22WorkingSpace", () => {
  const C = TestRoundtripPre22WorkingSpace;

  test("test_new_15_project_settings_round_trip", () => {
    const tmpPath = makeTmpPath();
    const project = py_aep.newProject("15.1x69").project;
    project.iccProfileDirs = [C._icc_dir(tmpPath)];
    project.bitsPerChannel = BitsPerChannel.THIRTY_TWO;
    project.timeDisplayType = TimeDisplayType.FRAMES;
    project.gpuAccelType = GpuAccelType.SOFTWARE;
    project.linearizeWorkingSpace = true;
    project.workingSpace = C.SRGB;

    const out = tmpPath.div("new15.aep");
    project.save(out);
    const app2 = parseAep(out);
    const project2 = app2.project;

    expect(app2.version).toBe("15.1x69");
    expect(project2.workingSpace).toBe(C.SRGB);
    expect(project2.linearizeWorkingSpace).toBe(true);
    expect(project2.bitsPerChannel).toBe(BitsPerChannel.THIRTY_TWO);
    expect(project2.timeDisplayType).toBe(TimeDisplayType.FRAMES);
    expect(project2.gpuAccelType).toBe(GpuAccelType.SOFTWARE);
    // AE 15.1's own template: the pool holds just the working space's
    // ICC, and `lnrp` sits between `cpid` and `dwga`.
    const donorIcc = _profilePool(parseAep(C.DONOR).project)[0].data;
    expect(valueEquals(_profilePool(project2).map((c) => c.data), [donorIcc])).toBe(true);
    expect(valueEquals(project2._cpid.data, C.SRGB_ID)).toBe(true);
    const types = project2._rifx.chunks.map((c) => c.chunkType);
    const i = types.indexOf("cpid");
    expect(types.slice(i, i + 3)).toEqual(["cpid", "lnrp", "dwga"]);
  });

  test("test_new_profile_is_inserted_in_id_order", () => {
    const tmpPath = makeTmpPath();
    const project = py_aep.newProject("15.1x69").project;
    project.iccProfileDirs = [C._icc_dir(tmpPath)];
    project.workingSpace = "SDTV NTSC";
    project.workingSpace = C.SRGB;

    const out = tmpPath.div("ws.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.workingSpace).toBe(C.SRGB);
    expect(valueEquals(project2._cpid.data, C.SRGB_ID)).toBe(true);
    // The replaced SDTV NTSC stays, after the lower sRGB id.
    const poolIds = _profilePool(project2).map((c) => iccProfileId(c.data));
    expect(valueEquals(poolIds, [C.SRGB_ID, C.NTSC_ID])).toBe(true);
  });

  test("test_pooled_profile_is_reused", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(C.DONOR).project;
    project.iccProfileDirs = [C._icc_dir(tmpPath)];
    const before = projectBytes(project);
    project.workingSpace = project.workingSpace;
    expect(valueEquals(projectBytes(project), before)).toBe(true);

    project.workingSpace = "SDTV NTSC";
    const out = tmpPath.div("ws.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.workingSpace).toBe("SDTV NTSC");
    expect(valueEquals(project2._cpid.data, C.NTSC_ID)).toBe(true);
    expect(_profilePool(project2).length).toBe(2);
  });

  test("test_none_keeps_the_pool", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(C.DONOR).project;
    const pool = _profilePool(project).map((c) => c.data);
    project.workingSpace = "None";

    const out = tmpPath.div("ws.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.workingSpace).toBe("None");
    expect(valueEquals(project2._cpid.data, Bytes.repeat(b("\xff"), 16))).toBe(true);
    expect(valueEquals(_profilePool(project2).map((c) => c.data), pool)).toBe(true);
  });

  test("test_unknown_profile_leaves_project_unchanged", () => {
    const tmpPath = makeTmpPath();
    const project = py_aep.newProject("15.1x69").project;
    project.iccProfileDirs = [C._icc_dir(tmpPath)];
    const before = projectBytes(project);
    raises(ColorProfileNotFoundError, () => {
      project.workingSpace = "Not A Profile";
    });
    expect(valueEquals(projectBytes(project), before)).toBe(true);
  });
});

/** Roundtrip tests for Project.revision. */
describe("TestRoundtripRevision", () => {
  test("test_set_revision", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("save_01.aep")).project;
    const original = project.revision;

    project.revision = original + 10;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.revision).toBe(original + 10);
  });

  test("test_set_revision_above_16_bits", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("save_01.aep")).project;
    project.revision = 70_000;
    const out = tmpPath.div("modified.aep");
    project.save(out);
    expect(parseAep(out).project.revision).toBe(70_000);
    raises(ValueError, () => {
      project.revision = lshift(1, 32);
    });
  });

  // Roundtrip tests for Project.xmpPacket.

  test("test_set_xmp_packet", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES_DIR.div("linearBlending_false.aep")).project;

    // NOTE(port): models/project.ts parses xmp_packet via pyrt etree (ET_fromstring), whose Element has the same get/set API.
    const xmpPacket = project.xmpPacket;
    if (xmpPacket == null) throw new Error("project has no XMP packet");
    xmpPacket.set("py_aep_test_marker", "1");
    project.xmpPacket = xmpPacket;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    const xmpPacket2 = project2.xmpPacket;
    if (xmpPacket2 == null) throw new Error("saved project has no XMP packet");
    expect(xmpPacket2.get("py_aep_test_marker")).toBe("1");
  });
});

/** Parse then save must produce identical bytes. */
describe("TestIdempotency", () => {
  test("test_roundtrip_complete", () => {
    const tmpPath = makeTmpPath();
    const aepPath = VERSIONS_DIR.div("ae2025", "complete.aep");
    const originalBytes = aepPath.readBytes();

    const app = parseAep(aepPath);
    const out = tmpPath.div("roundtrip.aep");
    app.project.save(out);
    const roundtripBytes = out.readBytes();

    expect(valueEquals(originalBytes, roundtripBytes)).toBe(true);
  });
});

/** Project.listColorProfiles() in OCIO mode with a resolvable config. */
class TestListColorProfilesOcio {
  static CONFIG = new Path(import.meta.path).parent.parent.parent.div("samples", "assets", "config.ocio");
}

describe("TestListColorProfilesOcio", () => {
  test("test_resolvable_config_lists_colorspaces", () => {
    const project = parseAep(SAMPLES_DIR.div("colorManagementSystem_ocio.aep")).project;
    project.ocioConfigurationFile = str(TestListColorProfilesOcio.CONFIG);
    const profiles = project.listColorProfiles();
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
    const project = parseAep(SAMPLES_DIR.div("colorManagementSystem_ocio.aep")).project;
    project.ocioConfigurationFile = str(TestListColorProfilesOcio.CONFIG);
    for (const name of project.listColorProfiles()) {
      project.workingSpace = name;
      const stored = project.workingSpace;
      expect(split(stored, "/").at(-1)).toBe(name);
      project.workingSpace = stored;
      expect(project.workingSpace).toBe(stored);
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
    const tmpPath = makeTmpPath();
    const project = parseAep(TestColorProfileSlotBinding.UNSET_WS).project;
    expect(project.workingSpace).toBe("None");
    expect(project.displayColorSpace).toBe("None");

    project.displayColorSpace = ["ACES", "sRGB"];

    const out = tmpPath.div("display.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    expect(project2.displayColorSpace).toBe("ACES/sRGB");
  });

  test("test_display_space_write_does_not_leak_into_working_space", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(TestColorProfileSlotBinding.UNSET_WS).project;
    project.displayColorSpace = ["ACES", "sRGB"];

    const out = tmpPath.div("display.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    // Writing only the DISPLAY space must not give the project a working
    // space it never had.
    expect(project2.workingSpace).toBe("None");
  });

  test("test_both_slots_roundtrip_together", () => {
    const tmpPath = makeTmpPath();
    const config = new Path(import.meta.path).parent.parent.parent.div("samples", "assets", "config.ocio");
    const project = parseAep(TestColorProfileSlotBinding.UNSET_WS).project;
    project.ocioConfigurationFile = str(config);
    project.workingSpace = "ACEScg";
    project.displayColorSpace = ["ACES", "sRGB"];

    const out = tmpPath.div("both.aep");
    project.save(out);
    const project2 = parseAep(out).project;

    // A direct colorspace pick reads back qualified as "<family>/<name>"
    // (AE's stored colorProfileName) - see
    // TestListColorProfilesOcio::test_listed_names_are_assignable_as_working_space.
    expect(project2.workingSpace).toBe("ACES/ACEScg");
    expect(project2.displayColorSpace).toBe("ACES/sRGB");
  });
});
