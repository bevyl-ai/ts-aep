/** Tests for RenderQueue model parsing. */

import { describe, expect, test } from "bun:test";
import {
  AssertionError_,
  AttributeError,
  BytesIO,
  KeyError,
  NotImplementedError,
  Path,
  TypeError_,
  ValueError,
  b,
  bytes_,
  concat,
  contains,
  dict_pop,
  fields,
  fspath,
  getattr,
  getitem,
  int,
  len,
  py_assert,
  py_bool,
  py_eq,
  py_or,
  repr,
  sorted,
  StopIteration,
  PureWindowsPath,
} from "../../src/pyrt/index.ts";
import { approx, make_tmp_path, raises } from "../../src/pyrt/pytest.ts";
import { parse as parse_aep, type Application } from "../../src/py_aep/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { ListChunk, read_aep, write_aep } from "../../src/py_aep/binary/chunk.ts";
import { ArsiChunk, CineonRoptChunk, JpegRoptChunk, OpenExrRoptChunk, OutputModuleSettingsItem, PngRoptChunk, ROUT_ITEMS_PER_RQ_ITEM, RenderSettingsItem, RoptChunk, RouuChunk, TargaRoptChunk, TiffRoptChunk } from "../../src/py_aep/binary/render_chunks.ts";
import { find_by_list_type, recursive_find } from "../../src/py_aep/binary/utils.ts";
import { AudioBitDepth, AudioChannels, ColorManagementSystem, FieldRender, FrameRateSetting, GetSettingsFormat, LogType, MotionBlurSetting, OutputAudio, OutputColorDepth, PostRenderAction, RenderQuality, ResizeQuality, RQItemStatus, TimeSpanSource } from "../../src/py_aep/enums/index.ts";
import { profile_id_for_name } from "../../src/py_aep/enums/mappings.ts";
import { RenderQueueItem } from "../../src/py_aep/models/renderqueue/render_queue_item.ts";
import { _parse_id_hex_section } from "../../src/py_aep/parsers/templates.ts";
import type { Project } from "../../src/py_aep/models/project.ts";
import type { OutputModule } from "../../src/py_aep/models/renderqueue/output_module.ts";
import type { RenderQueue } from "../../src/py_aep/models/renderqueue/render_queue.ts";
import type { SettingValue } from "../../src/py_aep/models/renderqueue/settings.ts";
import { TiffFormatOptions } from "../../src/py_aep/models/renderqueue/format_options/tiff.ts";
import { as_instance, get_rqi } from "../helpers.ts";

const TEST_FILE = new Path(import.meta.path);
const SAMPLES_DIR = TEST_FILE.parent.parent.parent.div("samples", "models", "renderqueue");
const OM_SAMPLES_DIR = TEST_FILE.parent.parent.parent.div("samples", "models", "output_module");
const FO_SAMPLES_DIR = TEST_FILE.parent.parent.parent.div("samples", "models", "format_options");
const BUGS_DIR = TEST_FILE.parent.parent.parent.div("samples", "bugs");
const AE_PREFS_DIR: string | null = process.env.AE_PREFS_DIR ?? null;
const OCS_SAMPLES_DIR = TEST_FILE.parent.parent.parent.div(
  "samples",
  "models",
  "output_module",
  "output_color_space",
);

/** `attrs.asdict(inst)` - field name to value, in field order. */
// NOTE(port): no pyrt attrs.asdict; OutputModuleSettingsItem fields are flat (ints, bools, bytes), so Python's recursive asdict equals this shallow copy.
function asdict(inst: OutputModuleSettingsItem): Map<string, SettingValue> {
  const out = new Map<string, SettingValue>();
  for (const a of fields(inst.constructor)) out.set(a.name, getattr(inst, a.name));
  return out;
}

/** `project.render_queue`, failing the test when the project has none. */
function render_queue_of(project: Project): RenderQueue {
  const rq = project.render_queue;
  if (rq == null) throw new AssertionError_("project has no render queue");
  return rq;
}

/** The Rout chunk holds a fixed block of items per RQ item.

AE writes `ROUT_ITEMS_PER_RQ_ITEM` Rout entries per render queue item and
the `count` field must match the number of entries. Parse/remove/duplicate
must keep this invariant (otherwise AE reports "missing data in file").
 */
function _assert_rout_consistent(app: Application): void {
  const rq = render_queue_of(app.project); // type: ignore[attr-defined]
  const rout = rq._rout;
  const expected = len(rq.items) * ROUT_ITEMS_PER_RQ_ITEM;
  py_assert(
    len(rout.items) === expected,
    `expected ${expected} Rout items for ${len(rq.items)} RQ items, got ${len(rout.items)}`,
  );
  py_assert(
    rout.count === len(rout.items),
    `Rout.count=${rout.count} != len(items)=${len(rout.items)}`,
  );
}

/** Roundtrip tests for RenderQueueItem.log_type. */
describe("TestRoundtripLogType", () => {
  test("test_modify_log_type", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    rqi.log_type = LogType.ERRORS_AND_PER_FRAME_INFO;

    const out = tmp_path.div("modified_log_type.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "base");
    expect(rqi2.log_type).toBe(LogType.ERRORS_AND_PER_FRAME_INFO);
  });

  test("test_log_type_validation_rejects_invalid", () => {
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    raises(ValueError, () => {
      // @ts-expect-error 9999 is not a LogType; the setter must reject it at runtime
      rqi.log_type = 9999;
    }, "Invalid value");
  });
});

/** Roundtrip tests for RenderQueueItem.queue_item_notify. */
describe("TestRoundtripQueueItemNotify", () => {
  test("test_modify_queue_item_notify", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    const original = rqi.queue_item_notify;
    rqi.queue_item_notify = !original;

    const out = tmp_path.div("modified_notify.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "base");
    expect(rqi2.queue_item_notify).toBe(!original);
  });
});

/** Roundtrip tests for RenderQueueItem.status. */
describe("TestRoundtripStatus", () => {
  test("test_set_status_directly", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    rqi.status = RQItemStatus.UNQUEUED;

    const out = tmp_path.div("modified_status.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "base");
    expect(rqi2.status).toBe(RQItemStatus.UNQUEUED);
  });

  test("test_modify_status_via_render", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    rqi.render = false;

    const out = tmp_path.div("modified_status.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "base");
    expect(rqi2.status).toBe(RQItemStatus.UNQUEUED);
    expect(rqi2.render).toBe(false);
  });

  /** Setting render resets start_time and elapsed_seconds
  for QUEUED/UNQUEUED statuses. */
  test("test_status_resets_start_time_and_elapsed", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    // Prime with non-zero values via underlying chunk body
    rqi._ldat.start_time = 1000000;
    rqi._ldat.elapsed_seconds = 42;

    rqi.status = RQItemStatus.QUEUED;
    expect(rqi.start_time == null).toBe(true);
    expect(rqi.elapsed_seconds).toBe(0);

    const out = tmp_path.div("status_reset.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "base");
    expect(rqi2.start_time == null).toBe(true);
    expect(rqi2.elapsed_seconds).toBe(0);
    expect(rqi2.status).toBe(RQItemStatus.QUEUED);
  });
});

/** Roundtrip tests for RenderQueueItem.render setter. */
describe("TestRoundtripRender", () => {
  test("test_set_render_false", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    rqi.render = false;

    const out = tmp_path.div("render_false.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "base");
    expect(rqi2.render).toBe(false);
    expect(rqi2.status).toBe(RQItemStatus.UNQUEUED);
  });

  test("test_set_render_true", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    rqi.render = false;
    rqi.render = true;

    const out = tmp_path.div("render_true.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "base");
    expect(rqi2.render).toBe(true);
    expect(rqi2.status).toBe(RQItemStatus.QUEUED);
  });
});

/** Roundtrip tests for RenderQueueItem.name (template name). */
describe("TestRoundtripName", () => {
  test("test_modify_name", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    rqi.name = "Custom Template";

    const out = tmp_path.div("modified_name.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "base");
    expect(rqi2.name).toBe("Custom Template");
  });
});

/** Roundtrip tests for time span frame fields. */
describe("TestRoundtripTimeSpan", () => {
  test("test_modify_time_span_start_frame", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    rqi.time_span_start_frame = 10;

    const out = tmp_path.div("modified_ts_start.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "base");
    expect(rqi2.time_span_start_frame).toBe(10);
  });

  test("test_modify_time_span_duration_frames", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    rqi.time_span_duration_frames = 48;

    const out = tmp_path.div("modified_ts_dur.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "base");
    expect(rqi2.time_span_duration_frames).toBe(48);
  });
});

/** Tests for RenderQueueItem.start_time (read-only). */
describe("TestRoundtripStartTime", () => {
  test("test_start_time_is_read_only", () => {
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    raises(AttributeError, () => {
      // NOTE(port): Date months are 0-based, so month 5 is Python's datetime(2025, 6, 15, 12, 0, 0).
      rqi.start_time = new Date(2025, 5, 15, 12, 0, 0);
    }, "read-only");
  });

  test("test_start_time_default_is_none", () => {
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    expect(rqi.start_time == null).toBe(true);
  });
});

/** Tests that read-only fields raise on write. */
describe("TestReadOnlyFields", () => {
  test("test_elapsed_seconds_is_read_only", () => {
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    raises(AttributeError, () => {
      rqi.elapsed_seconds = 999;
    }, "read-only");
  });
});

/** Tests for setting RenderQueueItem.settings. */
describe("TestSetSetting", () => {
  test("test_set_enum_value", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    rqi.settings.set("Quality", RenderQuality.DRAFT);

    const out = tmp_path.div("quality_enum.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "base");
    expect(rqi2.settings.get("Quality")).toBe(RenderQuality.DRAFT);
  });

  test("test_set_int_value", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    rqi.settings.set("Quality", 1); // DRAFT

    const out = tmp_path.div("quality_int.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "base");
    expect(rqi2.settings.get("Quality")).toBe(RenderQuality.DRAFT);
  });

  test("test_set_string_value", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    rqi.settings.set("Motion Blur", "On for Checked Layers");

    const out = tmp_path.div("mblur_str.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "base");
    expect(rqi2.settings.get("Motion Blur")).toBe(MotionBlurSetting.ON_FOR_CHECKED_LAYERS);
  });

  test("test_set_resolution", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    rqi.settings.set("Resolution", [2, 2]);

    const out = tmp_path.div("resolution.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "base");
    expect(py_eq(rqi2.settings.get("Resolution"), [2, 2])).toBe(true);
  });

  test("test_set_skip_existing_files", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    rqi.settings.set("Skip Existing Files", true);

    const out = tmp_path.div("skip_existing.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "base");
    expect(rqi2.settings.get("Skip Existing Files")).toBe(true);
  });

  test("test_set_frame_rate", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    rqi.settings.set("Use this frame rate", 30.0);

    const out = tmp_path.div("frame_rate.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "base");
    expect(approx(rqi2.settings.get("Use this frame rate"), 30.0)).toBe(true);
  });

  test("test_unknown_key_raises", () => {
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    raises(KeyError, () => {
      rqi.settings.set("Nonexistent", 42);
    }, "Unknown setting");
  });

  test("test_read_only_key_raises", () => {
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    raises(AttributeError, () => {
      rqi.settings.set("Use comp's frame rate", 30.0);
    }, "read-only");
  });

  test("test_invalid_enum_int_raises", () => {
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    raises(ValueError, () => {
      rqi.settings.set("Quality", 9999);
    }, "Invalid int value");
  });

  test("test_invalid_enum_str_raises", () => {
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    raises(ValueError, () => {
      rqi.settings.set("Quality", "SuperHD");
    }, "Invalid string");
  });

  test("test_invalid_type_raises", () => {
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    raises(TypeError_, () => {
      rqi.settings.set("Quality", [1, 2, 3]);
    }, "Expected");
  });
});

/** Roundtrip tests for the comment property. */
describe("TestRoundtripComment", () => {
  test("test_modify_existing_comment", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("comment_aaaaa.aep")).project;
    const rqi = render_queue_of(project).items[0];
    expect(rqi.comment).toBe("aaaaa");
    rqi.comment = "new comment";

    const out = tmp_path.div("comment_modified.aep");
    project.save(out);
    const rqi2 = render_queue_of(parse_aep(out).project).items[0];
    expect(rqi2.comment).toBe("new comment");
  });

  test("test_create_comment_from_none", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("2_rqitems.aep")).project;
    const items = render_queue_of(project).items;
    expect(len(items)).toBe(2);
    for (const rqi of items) {
      expect(rqi._rcom_utf8 == null).toBe(true);
      expect(rqi.comment).toBe("");
    }

    items[0].comment = "first comment";
    items[1].comment = "second comment";

    const out = tmp_path.div("comment_created.aep");
    project.save(out);
    const items2 = render_queue_of(parse_aep(out).project).items;
    expect(items2[0].comment).toBe("first comment");
    expect(items2[1].comment).toBe("second comment");
  });
});

/** Roundtrip tests for OutputModule.include_source_xmp. */
describe("TestRoundtripOutputModuleIncludeSourceXmp", () => {
  test("test_modify_include_source_xmp", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(OM_SAMPLES_DIR.div("om_misc.aep")).project;
    const rqi = get_rqi(project, "include_source_xmp_data_on");
    const om = rqi.output_modules[0];
    expect(om.include_source_xmp).toBe(true);
    om.include_source_xmp = false;

    const out = tmp_path.div("xmp_off.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "include_source_xmp_data_on");
    const om2 = rqi2.output_modules[0];
    expect(om2.include_source_xmp).toBe(false);
  });

  test("test_enable_include_source_xmp", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(OM_SAMPLES_DIR.div("include_source_xmp_data_off.aep")).project;
    const om = render_queue_of(project).items[0].output_modules[0];
    expect(om.include_source_xmp).toBe(false);
    om.include_source_xmp = true;

    const out = tmp_path.div("xmp_on.aep");
    project.save(out);
    const om2 = render_queue_of(parse_aep(out).project).items[0].output_modules[0];
    expect(om2.include_source_xmp).toBe(true);
  });
});

/** Roundtrip tests for OutputModule.post_render_action. */
describe("TestRoundtripOutputModulePostRenderAction", () => {
  test("test_modify_post_render_action", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    const om = rqi.output_modules[0];
    om.post_render_action = PostRenderAction.IMPORT;

    const out = tmp_path.div("pra_import.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "base");
    const om2 = rqi2.output_modules[0];
    expect(om2.post_render_action).toBe(PostRenderAction.IMPORT);
  });

  test("test_post_render_action_validation_rejects_invalid", () => {
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    const om = rqi.output_modules[0];
    raises(ValueError, () => {
      // @ts-expect-error 9999 is not a PostRenderAction; the setter must reject it at runtime
      om.post_render_action = 9999;
    }, "Invalid value");
  });
});

/** Roundtrip tests for OutputModule.file_template property. */
describe("TestRoundtripFileTemplate", () => {
  test("test_file_template_read", () => {
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    const om = rqi.output_modules[0];
    expect(py_bool(om.file_template)).toBe(true); // should be non-empty
  });

  test("test_file_template_roundtrip", () => {
    const tmp_path = make_tmp_path();
    // The sample's output path is a Windows one; a project for macOS
    // would store a set path in macOS style.
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep"), { platform: "windows" }).project;
    const rqi = get_rqi(project, "base");
    const om = rqi.output_modules[0];
    const original = om.file_template;
    expect(py_bool(original)).toBe(true); // non-empty

    // Replace the filename portion with a custom template
    const sep = original.includes("\\") ? "\\" : "/";
    const last_sep = original.lastIndexOf(sep);
    const new_template = original.slice(0, last_sep + 1) + "custom_output.[fileExtension]";
    om.file_template = new_template;

    const out = tmp_path.div("ft_roundtrip.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "base");
    const om2 = rqi2.output_modules[0];
    expect(om2.file_template).toBe(new_template);
  });
});

/** Roundtrip tests for RenderQueueItem.skip_frames setter. */
describe("TestRoundtripSkipFrames", () => {
  test("test_set_skip_frames", () => {
    const tmp_path = make_tmp_path();
    // Kept in memory only: AE 2026 reads 0 for every item of a project it
    // opens and renders all frames, so a re-parsed item reads 0.
    const project = parse_aep(SAMPLES_DIR.div("skip_frames.aep")).project;
    const rqi = get_rqi(project, "skip_frames_0");
    expect(rqi.skip_frames).toBe(0);
    rqi.skip_frames = 1;
    expect(rqi.skip_frames).toBe(1);
    expect(rqi.output_modules[0]._roou.frame_rate).toBe(15.0);

    const out = tmp_path.div("skip1.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "skip_frames_0");
    expect(rqi2.skip_frames).toBe(0);
    expect(rqi2.output_modules[0]._roou.frame_rate).toBe(15.0);
  });

  test("test_set_skip_frames_back_to_0", () => {
    const project = parse_aep(SAMPLES_DIR.div("skip_frames.aep")).project;
    const rqi = get_rqi(project, "skip_frames_1");
    rqi.skip_frames = 1;
    rqi.skip_frames = 0;
    expect(rqi.output_modules[0]._roou.frame_rate).toBe(30.0);
  });

  test.each([1, 2, 3].map((n) => [n]))("test_set_skip_frames_writes_after_effects_bytes[%#]", (n: number) => {
    const tmp_path = make_tmp_path();
    // Every item of the sample renders at 30 fps; AE stored 30 / (n + 1)
    // fps in the output module of `skip_frames_n` (7.5 = 00 07 80 00).
    const project = parse_aep(SAMPLES_DIR.div("skip_frames.aep")).project;
    get_rqi(project, "skip_frames_0").skip_frames = n;

    const out = tmp_path.div("skip.aep");
    project.save(out);
    const saved = parse_aep(out).project;
    const got = get_rqi(saved, "skip_frames_0");
    const want = get_rqi(saved, `skip_frames_${n}`);
    expect(
      py_eq(got.output_modules[0]._roou.tobytes(), want.output_modules[0]._roou.tobytes()),
    ).toBe(true);
    expect(got.skip_frames).toBe(0);
  });

  test("test_comp_frame_rate_change_keeps_skip_frames", () => {
    // AE 2026 keeps skipFrames (1) when the comp goes from 24 to 60 fps,
    // and leaves the 12 fps output rate stored in the module as it is.
    const project = parse_aep(SAMPLES_DIR.div("skip_frames.aep")).project;
    const rqi = get_rqi(project, "skip_frames_1");
    rqi.skip_frames = 1;
    const stored = rqi.output_modules[0]._roou.frame_rate;
    rqi.comp.frame_rate = rqi.comp.frame_rate * 2.5;
    expect(rqi.skip_frames).toBe(1);
    expect(rqi.output_modules[0]._roou.frame_rate).toBe(stored);
  });

  test("test_use_this_frame_rate_keeps_skip_frames", () => {
    // AE 2026 keeps skipFrames when "Use this frame rate" changes.
    const project = parse_aep(SAMPLES_DIR.div("skip_frames.aep")).project;
    const rqi = get_rqi(project, "skip_frames_2");
    rqi.skip_frames = 2;
    rqi.settings.set("Use this frame rate", 24);
    expect(rqi.skip_frames).toBe(2);
    expect(rqi.output_modules[0]._roou.frame_rate).toBe(8.0);
  });

  test("test_frame_rate_setting_keeps_skip_frames", () => {
    const project = parse_aep(SAMPLES_DIR.div("skip_frames.aep")).project;
    const rqi = get_rqi(project, "skip_frames_2");
    rqi.skip_frames = 2;
    rqi.settings.set("Frame Rate", FrameRateSetting.USE_COMP_FRAME_RATE);
    expect(rqi.skip_frames).toBe(2);
    expect(rqi.output_modules[0]._roou.frame_rate).toBe(8.0); // 24 fps comp
  });

  test.each([12.5, 29.97, 60.0].map((fps) => [fps]))("test_new_item_stores_render_frame_rate[%#]", (fps: number) => {
    // Once AE prepares an item for output, its output module holds the
    // render frame rate (AE 2026: 60 and 12.5 fps comps store 60 and
    // 12.5), so a new item reads skip_frames 0 at any comp rate.
    const app = parse_aep(SAMPLES_DIR.div("custom.aep"));
    const comp = app.project.root_folder.add_comp("C", 64, 36, 1.0, 1.0, fps);
    const rqi = render_queue_of(app.project).add(comp);
    expect(approx(rqi.output_modules[0]._roou.frame_rate, fps, { abs: 1 / 65536 })).toBe(true);
    expect(rqi.skip_frames).toBe(0);
    expect(rqi.add()._roou.frame_rate).toBe(rqi.output_modules[0]._roou.frame_rate);
  });
});

/** The `Rouu` output frame rate (16.16 fixed point at 0x42) and depth
(signed 2 bytes at 0x46) are separate fields. */
describe("TestRoundtripRouuFrameRateAndDepth", () => {
  test("test_depth_write_keeps_29_97_frame_rate", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(FO_SAMPLES_DIR.div("png", "png_rgba.aep")).project;
    const om = render_queue_of(project).items[0].output_modules[0];
    expect(py_eq(bytes_.slice(om._roou.tobytes(), 0x42, 0x48), bytes_.fromhex("001DF8520020"))).toBe(true);
    om.settings.set("Depth", OutputColorDepth.TRILLIONS_OF_COLORS_PLUS);

    const out = tmp_path.div("depth.aep");
    project.save(out);
    const om2 = render_queue_of(parse_aep(out).project).items[0].output_modules[0];
    expect(py_eq(bytes_.slice(om2._roou.tobytes(), 0x42, 0x48), bytes_.fromhex("001DF8520040"))).toBe(true);
    expect(om2.settings.get("Depth")).toBe(OutputColorDepth.TRILLIONS_OF_COLORS_PLUS);
  });

  test("test_floating_point_gray_is_signed", () => {
    // AE 2026 reads `FF E0` at 0x46 as -32 ("Floating Point Gray") and
    // keeps the bytes when it saves.
    const body = new Uint8Array(new RouuChunk().tobytes());
    body.set(b("\xff\xe0"), 0x46);
    const rouu = as_instance(RouuChunk.frombytes(new Uint8Array(body), { chunk_type: "Roou" }), RouuChunk);
    expect(rouu instanceof RouuChunk).toBe(true);
    expect(rouu.depth).toBe(OutputColorDepth.FLOATING_POINT_GRAY);
    expect(OutputColorDepth.FLOATING_POINT_GRAY).toBe(-32);
    expect(py_eq(rouu.tobytes(), new Uint8Array(body))).toBe(true);
  });

  test("test_frame_rate_setter_writes_16_16", () => {
    const rouu = new RouuChunk();
    rouu.frame_rate = 29.97;
    expect(py_eq(bytes_.slice(rouu.tobytes(), 0x42, 0x48), bytes_.fromhex("001DF8520020"))).toBe(true);
    rouu.frame_rate = 7.5;
    expect(py_eq(bytes_.slice(rouu.tobytes(), 0x42, 0x46), bytes_.fromhex("00078000"))).toBe(true);
  });

  test("test_width_and_height_are_4_bytes", () => {
    // AE 2026 opens resize_checked.aep, but not the same file with 1 in
    // the upper two bytes of 0x22 and 0x26 (a 2-byte read at 0x24/0x28
    // would see a valid 4464 x 1080): the size fields are 4 bytes.
    const body = new Uint8Array(new RouuChunk().tobytes());
    body.set(
      concat(bytes_.int_to_bytes(70000, 4, "big"), bytes_.int_to_bytes(66616, 4, "big")),
      0x22,
    );
    const rouu = as_instance(RouuChunk.frombytes(new Uint8Array(body), { chunk_type: "Roou" }), RouuChunk);
    expect(rouu instanceof RouuChunk).toBe(true);
    expect(rouu.width).toBe(70000);
    expect(rouu.height).toBe(66616);
  });
});

/** Preserve RGB is byte 0x5E of the output-module settings record. */
describe("TestRoundtripPreserveRgb", () => {
  test("test_set_preserve_rgb_writes_after_effects_bytes", () => {
    const tmp_path = make_tmp_path();
    // preserve_rgb_off/on differ only in that byte.
    const project = parse_aep(OM_SAMPLES_DIR.div("preserve_rgb_off.aep")).project;
    render_queue_of(project).items[0].output_modules[0].settings.set("Preserve RGB", true);
    const out = tmp_path.div("prgb.aep");
    project.save(out);
    const got = render_queue_of(parse_aep(out).project).items[0].output_modules[0];
    const want = render_queue_of(parse_aep(OM_SAMPLES_DIR.div("preserve_rgb_on.aep")).project).items[0]
      .output_modules[0];
    expect(py_eq(got._om_ldat.tobytes(), want._om_ldat.tobytes())).toBe(true);
    expect(got.settings.get("Preserve RGB")).toBe(true);
  });
});

/** Roundtrip tests for RenderQueueItem.time_span_start setter. */
describe("TestRoundtripTimeSpanStart", () => {
  test("test_set_time_span_start", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("time_span.aep")).project;
    const rqi = get_rqi(project, "time_span_custom_start_1s23f");
    rqi.time_span_start = 2.0;

    const out = tmp_path.div("ts_start.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "time_span_custom_start_1s23f");
    expect(approx(rqi2.time_span_start, 2.0, { abs: 0.04 })).toBe(true);
  });

  test("test_set_time_span_start_switches_to_custom", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("time_span.aep")).project;
    const rqi = get_rqi(project, "time_span_length_of_comp");
    rqi.time_span_start = 1.0;

    const out = tmp_path.div("ts_custom.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "time_span_length_of_comp");
    expect(approx(rqi2.time_span_start, 1.0, { abs: 0.04 })).toBe(true);
  });
});

/** Roundtrip tests for RenderQueueItem.time_span_duration setter. */
describe("TestRoundtripTimeSpanDuration", () => {
  test("test_set_time_span_duration", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("time_span.aep")).project;
    const rqi = get_rqi(project, "time_span_custom_24s13f");
    rqi.time_span_duration = 5.0;

    const out = tmp_path.div("ts_dur.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "time_span_custom_24s13f");
    expect(approx(rqi2.time_span_duration, 5.0, { abs: 0.04 })).toBe(true);
  });
});

/** Roundtrip tests for time_span_end and time_span_end_frame setters. */
describe("TestRoundtripTimeSpanEnd", () => {
  test("test_set_time_span_end", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("time_span.aep")).project;
    const rqi = get_rqi(project, "time_span_custom_start_1s23f");
    const start = rqi.time_span_start;
    rqi.time_span_end = start + 3.0;

    const out = tmp_path.div("ts_end.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "time_span_custom_start_1s23f");
    expect(approx(rqi2.time_span_duration, 3.0, { abs: 0.04 })).toBe(true);
    expect(approx(rqi2.time_span_end, start + 3.0, { abs: 0.04 })).toBe(true);
  });

  test("test_set_time_span_end_frame", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    rqi.time_span_start_frame = 5;
    rqi.time_span_end_frame = 30;

    const out = tmp_path.div("ts_end_frame.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "base");
    expect(rqi2.time_span_start_frame).toBe(5);
    expect(rqi2.time_span_duration_frames).toBe(25);
    expect(rqi2.time_span_end_frame).toBe(30);
  });
});

/** Roundtrip tests for Resolution via SettingsView dict access. */
describe("TestRoundtripSettingsResolution", () => {
  test("test_asymmetric_resolution", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    rqi.settings.set("Resolution", [7, 3]);

    const out = tmp_path.div("res_asymmetric.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "base");
    expect(py_eq(rqi2.settings.get("Resolution"), [7, 3])).toBe(true);
  });

  test("test_resolution_full_to_custom_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("resolution.aep")).project;
    const rqi = get_rqi(project, "resolution_custom_7x3");
    expect(py_eq(rqi.settings.get("Resolution"), [7, 3])).toBe(true);

    rqi.settings.set("Resolution", [1, 1]);
    const out = tmp_path.div("res_full.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "resolution_custom_7x3");
    expect(py_eq(rqi2.settings.get("Resolution"), [1, 1])).toBe(true);

    // And back to a different custom value
    rqi2.settings.set("Resolution", [8, 3]);
    const out2 = tmp_path.div("res_custom_again.aep");
    rqi2._project.save(out2);
    const rqi3 = get_rqi(parse_aep(out2).project, "resolution_custom_7x3");
    expect(py_eq(rqi3.settings.get("Resolution"), [8, 3])).toBe(true);
  });
});

/** Roundtrip tests for Use this frame rate (integer+fractional split). */
describe("TestRoundtripSettingsFrameRate", () => {
  test("test_fractional_frame_rate_29_97", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    rqi.settings.set("Frame Rate", FrameRateSetting.USE_THIS_FRAME_RATE);
    rqi.settings.set("Use this frame rate", 29.97);

    const out = tmp_path.div("fr_29_97.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "base");
    expect(rqi2.settings.get("Frame Rate")).toBe(FrameRateSetting.USE_THIS_FRAME_RATE);
    expect(approx(rqi2.settings.get("Use this frame rate"), 29.97, { abs: 0.01 })).toBe(true);
  });

  test("test_integer_frame_rate_24", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("frame_rate.aep")).project;
    const rqi = get_rqi(project, "frame_rate_24");
    expect(approx(rqi.settings.get("Use this frame rate"), 24.0)).toBe(true);

    rqi.settings.set("Use this frame rate", 60.0);
    const out = tmp_path.div("fr_60.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "frame_rate_24");
    expect(approx(rqi2.settings.get("Use this frame rate"), 60.0)).toBe(true);
  });

  /** Parse and save 29.97 without modification preserves the value. */
  test("test_existing_fractional_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("frame_rate.aep")).project;
    const rqi = get_rqi(project, "frame_rate_29_97");
    const original = rqi.settings.get("Use this frame rate");
    expect(approx(original, 29.97, { abs: 0.01 })).toBe(true);

    const out = tmp_path.div("fr_29_97_unchanged.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "frame_rate_29_97");
    expect(approx(rqi2.settings.get("Use this frame rate"), original, { abs: 0.001 })).toBe(true);
  });
});

/** Roundtrip tests for multiple settings writes with save/reparse. */
describe("TestRoundtripSettingsMultiWrite", () => {
  test("test_multiple_settings", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");

    rqi.settings.set("Quality", RenderQuality.DRAFT);
    rqi.settings.set("Resolution", [3, 3]);
    rqi.settings.set("Motion Blur", MotionBlurSetting.ON_FOR_CHECKED_LAYERS);
    rqi.settings.set("Field Render", FieldRender.UPPER_FIELD_FIRST);

    const out = tmp_path.div("batch_multi.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "base");
    expect(rqi2.settings.get("Quality")).toBe(RenderQuality.DRAFT);
    expect(py_eq(rqi2.settings.get("Resolution"), [3, 3])).toBe(true);
    expect(rqi2.settings.get("Motion Blur")).toBe(MotionBlurSetting.ON_FOR_CHECKED_LAYERS);
    expect(rqi2.settings.get("Field Render")).toBe(FieldRender.UPPER_FIELD_FIRST);
  });

  /** Set the frame rate toggle and value together. */
  test("test_frame_rate_pair", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");

    rqi.settings.set("Frame Rate", FrameRateSetting.USE_THIS_FRAME_RATE);
    rqi.settings.set("Use this frame rate", 23.976);

    const out = tmp_path.div("batch_fr.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "base");
    expect(rqi2.settings.get("Frame Rate")).toBe(FrameRateSetting.USE_THIS_FRAME_RATE);
    expect(approx(rqi2.settings.get("Use this frame rate"), 23.976, { abs: 0.01 })).toBe(true);
  });
});

/** Roundtrip tests for bulk settings assignment via .settings setter. */
describe("TestRoundtripSettingsBulkAssign", () => {
  test("test_assign_settings_dict", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    rqi.settings = new Map<string, SettingValue>([
      ["Quality", RenderQuality.WIREFRAME],
      ["Resolution", [4, 4]],
      ["Skip Existing Files", true],
    ]);

    const out = tmp_path.div("bulk_assign.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "base");
    expect(rqi2.settings.get("Quality")).toBe(RenderQuality.WIREFRAME);
    expect(py_eq(rqi2.settings.get("Resolution"), [4, 4])).toBe(true);
    expect(rqi2.settings.get("Skip Existing Files")).toBe(true);
  });

  /** Copy settings from one RQI to another via .settings setter. */
  test("test_assign_from_another_rqi", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("2_rqitems.aep")).project;
    const items = render_queue_of(project).items;
    expect(len(items)).toBe(2);

    items[0].settings.set("Quality", RenderQuality.DRAFT);
    items[0].settings.set("Resolution", [2, 2]);
    const copied_settings = new Map(
      [...items[0].settings].map((k: string): [string, SettingValue] => [k, items[0].settings.get(k)]),
    );
    expect(copied_settings.has("Use comp's frame rate")).toBe(true);
    dict_pop(copied_settings, "Use comp's frame rate");
    items[1].settings = copied_settings;

    const out = tmp_path.div("copy_settings.aep");
    project.save(out);
    const items2 = render_queue_of(parse_aep(out).project).items;
    expect(items2[1].settings.get("Quality")).toBe(RenderQuality.DRAFT);
    expect(py_eq(items2[1].settings.get("Resolution"), [2, 2])).toBe(true);
  });

  /** Bulk assignment should surface read-only setting errors. */
  test("test_assign_settings_with_read_only_key_raises", () => {
    const project = parse_aep(SAMPLES_DIR.div("2_rqitems.aep")).project;
    const items = render_queue_of(project).items;
    expect(len(items)).toBe(2);

    raises(AttributeError, () => {
      items[1].settings = items[0].settings;
    }, "read-only");
  });
});

/** Tests that read-only settings raise on dict-style write. */
describe("TestRoundtripSettingsReadOnly", () => {
  test("test_time_span_start_writable", () => {
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    // Time Span Start is now writable - verify no error
    rqi.settings.set("Time Span Start", 1.0);
  });

  test("test_time_span_duration_writable", () => {
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    // Time Span Duration is now writable - verify no error
    rqi.settings.set("Time Span Duration", 5.0);
  });

  test("test_comps_frame_rate_read_only", () => {
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    raises(AttributeError, () => {
      rqi.settings.set("Use comp's frame rate", 30.0);
    }, "read-only");
  });

  test("test_unknown_key_via_dict_raises", () => {
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    raises(KeyError, () => {
      rqi.settings.get("Nonexistent");
    });
    raises(KeyError, () => {
      rqi.settings.set("Nonexistent", 42);
    }, "Unknown setting");
  });
});

/** Roundtrip tests for OutputModule Resize to (2-field getter/setter). */
describe("TestRoundtripOutputModuleResize", () => {
  test("test_set_resize_to", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(OM_SAMPLES_DIR.div("resize_custom_960x540.aep")).project;
    const om = render_queue_of(project).items[0].output_modules[0];
    expect(py_eq(om.settings.get("Resize to"), [960, 540])).toBe(true);

    om.settings.set("Resize to", [1280, 720]);
    const out = tmp_path.div("resize_720p.aep");
    project.save(out);
    const om2 = render_queue_of(parse_aep(out).project).items[0].output_modules[0];
    expect(py_eq(om2.settings.get("Resize to"), [1280, 720])).toBe(true);
  });

  test("test_resize_roundtrip_back", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(OM_SAMPLES_DIR.div("resize_custom_960x540.aep")).project;
    const om = render_queue_of(project).items[0].output_modules[0];
    om.settings.set("Resize to", [3840, 2160]);

    const out = tmp_path.div("resize_4k.aep");
    project.save(out);
    const om2 = render_queue_of(parse_aep(out).project).items[0].output_modules[0];
    expect(py_eq(om2.settings.get("Resize to"), [3840, 2160])).toBe(true);

    om2.settings.set("Resize to", [640, 480]);
    const out2 = tmp_path.div("resize_vga.aep");
    om2._project.save(out2);
    const om3 = render_queue_of(parse_aep(out2).project).items[0].output_modules[0];
    expect(py_eq(om3.settings.get("Resize to"), [640, 480])).toBe(true);
  });

  test("test_resize_string_form_fallback", () => {
    // With no ae_preferences_dir, get_settings(STRING) labels "Resize
    // to" from the AE-verified factory fallback table; a non-preset
    // resolution reads "Custom".
    const project = parse_aep(OM_SAMPLES_DIR.div("resize_custom_960x540.aep")).project;
    const om = render_queue_of(project).items[0].output_modules[0];

    om.settings.set("Resize to", [1920, 1080]);
    expect(getitem(om.get_settings(GetSettingsFormat.STRING), "Resize to")).toBe(
      "HD  •  1920x1080 • 24 fps",
    );
    expect(om.get_setting("Resize to")).toBe("HD  •  1920x1080 • 24 fps");

    om.settings.set("Resize to", [960, 540]);
    expect(getitem(om.get_settings(GetSettingsFormat.STRING), "Resize to")).toBe("Custom");
  });
});

/** Roundtrip tests for OutputModule crop settings. */
describe("TestRoundtripOutputModuleCrop", () => {
  test("test_set_all_crop_values", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(OM_SAMPLES_DIR.div("om_crop.aep")).project;
    const rqi = get_rqi(project, "crop_checked");
    const om = rqi.output_modules[0];

    om.settings.set("Crop Top", 20);
    om.settings.set("Crop Left", 30);
    om.settings.set("Crop Bottom", 40);
    om.settings.set("Crop Right", 50);

    const out = tmp_path.div("crop_all.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "crop_checked");
    const om2 = rqi2.output_modules[0];
    expect(om2.settings.get("Crop Top")).toBe(20);
    expect(om2.settings.get("Crop Left")).toBe(30);
    expect(om2.settings.get("Crop Bottom")).toBe(40);
    expect(om2.settings.get("Crop Right")).toBe(50);
  });

  test("test_toggle_crop_and_set_values", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(OM_SAMPLES_DIR.div("crop_unchecked.aep")).project;
    const om = render_queue_of(project).items[0].output_modules[0];
    expect(om.settings.get("Crop")).toBe(false);

    om.settings.set("Crop", true);
    om.settings.set("Crop Top", 10);
    om.settings.set("Crop Bottom", 10);

    const out = tmp_path.div("crop_enabled.aep");
    project.save(out);
    const om2 = render_queue_of(parse_aep(out).project).items[0].output_modules[0];
    expect(om2.settings.get("Crop")).toBe(true);
    expect(om2.settings.get("Crop Top")).toBe(10);
    expect(om2.settings.get("Crop Bottom")).toBe(10);
  });
});

/** Roundtrip tests for various OutputModule settings via dict access. */
describe("TestRoundtripOutputModuleSettings", () => {
  test("test_set_resize_quality", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(OM_SAMPLES_DIR.div("om_resize.aep")).project;
    const rqi = get_rqi(project, "resize_quality_low");
    const om = rqi.output_modules[0];
    expect(om.settings.get("Resize Quality")).toBe(ResizeQuality.LOW);

    om.settings.set("Resize Quality", ResizeQuality.HIGH);
    const out = tmp_path.div("rq_high.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "resize_quality_low");
    const om2 = rqi2.output_modules[0];
    expect(om2.settings.get("Resize Quality")).toBe(ResizeQuality.HIGH);
  });

  test("test_read_only_om_settings", () => {
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    const om = rqi.output_modules[0];
    raises(AttributeError, () => {
      om.settings.set("Output File Info", new Map());
    }, "read-only");
    // "Output Color Space" is not a settings key - it is a KeyError, not
    // a read-only setting (use the OutputModule.output_color_space
    // property to read/write it).
    raises(KeyError, () => {
      om.settings.set("Output Color Space", "sRGB");
    });
  });

  test("test_om_settings_contain_required_keys", () => {
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    const om = rqi.output_modules[0];
    const settings = om.settings;
    expect(contains(settings, "Channels")).toBe(true);
    expect(contains(settings, "Depth")).toBe(true);
    expect(contains(settings, "Crop")).toBe(true);
    expect(contains(settings, "Resize")).toBe(true);
    expect(contains(settings, "Format")).toBe(true);
    expect(contains(settings, "Output File Info")).toBe(true);
  });

  /** Time Span key in RQI settings roundtrips correctly. */
  test("test_time_span_via_settings", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("render_settings.aep")).project;
    const rqi = get_rqi(project, "base");
    rqi.settings.set("Time Span", TimeSpanSource.WORK_AREA_ONLY);

    const out = tmp_path.div("ts_work_area.aep");
    project.save(out);
    const rqi2 = get_rqi(parse_aep(out).project, "base");
    expect(rqi2.settings.get("Time Span")).toBe(TimeSpanSource.WORK_AREA_ONLY);
  });
});

/**
 * Regression tests: the Rout chunk stays consistent across mutations.
 *
 * These guard the 5-items-per-RQ-item invariant; len(items)-only checks
 * miss a corrupt Rout chunk because the item count comes from the render
 * settings ldat, not from Rout.
 */
describe("TestRoutChunkIntegrity", () => {
  test("test_parse_associates_per_item_block", () => {
    // Each RQ item owns its own contiguous, non-shared Rout block.
    const app = parse_aep(SAMPLES_DIR.div("2_rqitems.aep"));
    const rq = render_queue_of(app.project);
    _assert_rout_consistent(app);
    const block0 = rq.items[0]._rout_items;
    const block1 = rq.items[1]._rout_items;
    expect(len(block0)).toBe(ROUT_ITEMS_PER_RQ_ITEM);
    expect(len(block1)).toBe(ROUT_ITEMS_PER_RQ_ITEM);
    expect(block0.some((a) => block1.some((b) => a === b))).toBe(false);
  });

  test("test_remove_keeps_rout_consistent", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("2_rqitems.aep"));
    render_queue_of(app.project).items[0].remove();
    _assert_rout_consistent(app);
    const out = tmp_path.div("out.aep");
    app.project.save(out);
    _assert_rout_consistent(parse_aep(out));
  });

  test("test_duplicate_keeps_rout_consistent", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("base.aep"));
    render_queue_of(app.project).items[0].duplicate();
    _assert_rout_consistent(app);
    const out = tmp_path.div("out.aep");
    app.project.save(out);
    _assert_rout_consistent(parse_aep(out));
  });
});

/** Issue #230: emptying a collection by looping over it must work. */
describe("TestIterationWhileRemoving", () => {
  test("test_removing_every_rq_item_while_iterating", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("2_rqitems.aep"));
    const rq = render_queue_of(app.project);
    expect(len(rq.items)).toBe(2);

    for (const rq_item of rq) {
      rq_item.remove();
    }

    expect(py_eq([...rq], [])).toBe(true);
    expect(rq.num_items).toBe(0);

    const out = tmp_path.div("out.aep");
    app.project.save(out);
    expect(render_queue_of(parse_aep(out).project).num_items).toBe(0);
  });

  test("test_removing_every_layer_while_iterating", () => {
    const layer_sample = TEST_FILE.parent.parent.parent.div("samples", "models", "layer", "parametric_meshes.aep");
    const comp = parse_aep(layer_sample).project.compositions[0];
    expect(len(comp.layers) > 1).toBe(true);

    for (const layer of comp) {
      layer.remove();
    }

    expect(py_eq([...comp], [])).toBe(true);
    expect(len(comp.layers)).toBe(0);
  });
});

/** Tests for RenderQueueItem.remove(). */
describe("TestRQItemRemove", () => {
  test("test_remove_first_item", () => {
    const tmp_path = make_tmp_path();
    /** Removing the first RQ item leaves one item, roundtrips. */
    const app = parse_aep(SAMPLES_DIR.div("2_rqitems.aep"));
    const rq = render_queue_of(app.project);
    expect(len(rq.items)).toBe(2);
    const _comp0 = rq.items[0].comp;
    const comp1 = rq.items[1].comp;

    rq.items[0].remove();
    expect(len(rq.items)).toBe(1);
    expect(rq.items[0].comp).toBe(comp1);

    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const app2 = parse_aep(out);
    expect(len(render_queue_of(app2.project).items)).toBe(1);
  });

  test("test_remove_second_item", () => {
    const tmp_path = make_tmp_path();
    /** Removing the second RQ item leaves one item, roundtrips. */
    const app = parse_aep(SAMPLES_DIR.div("2_rqitems.aep"));
    const rq = render_queue_of(app.project);
    const comp0 = rq.items[0].comp;

    rq.items[1].remove();
    expect(len(rq.items)).toBe(1);
    expect(rq.items[0].comp).toBe(comp0);

    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const app2 = parse_aep(out);
    expect(len(render_queue_of(app2.project).items)).toBe(1);
  });

  test("test_remove_all_items", () => {
    const tmp_path = make_tmp_path();
    /** Removing all items empties the render queue, roundtrips. */
    const app = parse_aep(SAMPLES_DIR.div("2_rqitems.aep"));
    const rq = render_queue_of(app.project);
    expect(rq._arsi.queue_nonempty).toBe(1);

    rq.items[1].remove();
    rq.items[0].remove();
    expect(len(rq.items)).toBe(0);
    // Emptying the queue clears the ARsi non-empty marker AE set.
    expect(rq._arsi.queue_nonempty).toBe(0);

    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const app2 = parse_aep(out);
    const rq2 = render_queue_of(app2.project);
    expect(len(rq2.items)).toBe(0);
    expect(rq2._arsi.queue_nonempty).toBe(0);
  });

  test("test_remove_item_with_comment", () => {
    const tmp_path = make_tmp_path();
    /** Removing an item with a comment works correctly. */
    const app = parse_aep(SAMPLES_DIR.div("comment_aaaaa.aep"));
    const rq = render_queue_of(app.project);
    expect(len(rq.items)).toBe(1);
    expect(rq.items[0].comment).toBe("aaaaa");

    rq.items[0].remove();
    expect(len(rq.items)).toBe(0);

    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const app2 = parse_aep(out);
    expect(len(render_queue_of(app2.project).items)).toBe(0);
  });
});

/** Tests for RenderQueueItem.duplicate(). */
describe("TestRQItemDuplicate", () => {
  test("test_duplicate_basic", () => {
    const tmp_path = make_tmp_path();
    /** Duplicating an item increases count by one, roundtrips. */
    const app = parse_aep(SAMPLES_DIR.div("base.aep"));
    const rq = render_queue_of(app.project);
    const orig_count = len(rq.items);
    const orig_comp = rq.items[0].comp;

    const new_item = rq.items[0].duplicate();
    expect(len(rq.items)).toBe(orig_count + 1);
    expect(new_item.comp).toBe(orig_comp);
    expect(new_item).toBe(rq.items[1]);

    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const app2 = parse_aep(out);
    expect(len(render_queue_of(app2.project).items)).toBe(orig_count + 1);
  });

  test("test_duplicate_preserves_output_modules", () => {
    const tmp_path = make_tmp_path();
    /** Duplicated item has the same number of output modules. */
    const app = parse_aep(SAMPLES_DIR.div("base.aep"));
    const rq = render_queue_of(app.project);
    const orig_om_count = len(rq.items[0].output_modules);

    const new_item = rq.items[0].duplicate();
    expect(len(new_item.output_modules)).toBe(orig_om_count);

    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const app2 = parse_aep(out);
    expect(len(render_queue_of(app2.project).items[1].output_modules)).toBe(orig_om_count);
  });

  test("test_duplicate_from_two_items", () => {
    const tmp_path = make_tmp_path();
    /** Duplicating from a file with 2 items produces 3 items, roundtrips. */
    const app = parse_aep(SAMPLES_DIR.div("2_rqitems.aep"));
    const rq = render_queue_of(app.project);
    expect(len(rq.items)).toBe(2);

    rq.items[0].duplicate();
    expect(len(rq.items)).toBe(3);

    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const app2 = parse_aep(out);
    expect(len(render_queue_of(app2.project).items)).toBe(3);
  });

  test("test_duplicate_then_remove", () => {
    const tmp_path = make_tmp_path();
    /** Duplicate then remove the original leaves the duplicate. */
    const app = parse_aep(SAMPLES_DIR.div("base.aep"));
    const rq = render_queue_of(app.project);

    const new_item = rq.items[0].duplicate();
    rq.items[0].remove();
    expect(len(rq.items)).toBe(1);
    expect(rq.items[0]).toBe(new_item);

    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const app2 = parse_aep(out);
    expect(len(render_queue_of(app2.project).items)).toBe(1);
  });
});

/** Tests for RenderQueue.add(). */
describe.skipIf(!py_bool(AE_PREFS_DIR))("TestRQAdd", () => {
  test("test_add_to_existing", () => {
    const tmp_path = make_tmp_path();
    /** Adding a comp to RQ with existing items increases count. */
    const app = parse_aep(SAMPLES_DIR.div("base.aep"), { ae_preferences_dir: AE_PREFS_DIR });
    const rq = render_queue_of(app.project);
    const comp = rq.items[0].comp;
    const orig_count = len(rq.items);

    const new_item = rq.add(comp);
    expect(len(rq.items)).toBe(orig_count + 1);
    expect(new_item.comp).toBe(comp);
    expect(len(new_item.output_modules)).toBe(1);

    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const app2 = parse_aep(out);
    expect(len(render_queue_of(app2.project).items)).toBe(orig_count + 1);
  });

  /** add() returns a RenderQueueItem. */
  test("test_add_returns_rqitem", () => {
    const app = parse_aep(SAMPLES_DIR.div("base.aep"), { ae_preferences_dir: AE_PREFS_DIR });
    const rq = render_queue_of(app.project);
    const comp = rq.items[0].comp;
    const new_item = rq.add(comp);
    expect(new_item instanceof RenderQueueItem).toBe(true);
  });

  /** Adding to an emptied queue works and roundtrips. */
  test("test_add_after_remove_all", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("base.aep"), { ae_preferences_dir: AE_PREFS_DIR });
    const rq = render_queue_of(app.project);
    const comp = rq.items[0].comp;

    rq.items[0].remove();
    expect(len(rq.items)).toBe(0);

    rq.add(comp);
    expect(len(rq.items)).toBe(1);

    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const app2 = parse_aep(out);
    expect(len(render_queue_of(app2.project).items)).toBe(1);
  });
});

/**
 * RenderQueue.add() builds a valid TIFF image-sequence item with no prefs.
 *
 * These run in CI (no AE_PREFS_DIR needed): add() no longer raises or warns
 * without ae_preferences_dir - it builds a fresh "TIFF Sequence with Alpha"
 * output module whose chunks match what After Effects writes for a freshly
 * added item.
 */
describe("TestRQAddWithoutPreferences", () => {
  test("test_add_without_prefs_builds_tiff_item", () => {
    const app = parse_aep(SAMPLES_DIR.div("custom.aep")); // no ae_preferences_dir
    const rq = render_queue_of(app.project);
    const comp = app.project.compositions[0];
    const orig = rq.num_items;

    const rqi = rq.add(comp);

    expect(rq.num_items).toBe(orig + 1);
    expect(rqi.name).toBe("Best Settings");
    // Fresh item has no output file set yet -> NEEDS_OUTPUT, like AE.
    expect(rqi.status).toBe(RQItemStatus.NEEDS_OUTPUT);
    expect(rqi.num_output_modules).toBe(1);
    expect(rqi.output_modules[0].name).toBe("TIFF Sequence with Alpha");
  });

  test("test_fresh_om_structure_matches_ae", () => {
    // AE's freshly added OM has no Als2 alias; its LOm is Roou, Ropt,
    // hdrm, Utf8x3. The Ropt is the 602-byte TIFF format options.
    const app = parse_aep(SAMPLES_DIR.div("custom.aep"));
    const rqi = render_queue_of(app.project).add(app.project.compositions[0]);
    const lom_types = rqi._lom.chunks.map((c) => py_or(getattr(c, "list_type", null), c.chunk_type));
    expect(contains(lom_types, "Als2")).toBe(false);
    expect(py_eq(lom_types, ["Roou", "Ropt", "hdrm", "Utf8", "Utf8", "Utf8"])).toBe(true);
    const ropt = rqi._lom.chunks.find((c) => c.chunk_type === "Ropt");
    if (ropt === undefined) throw new StopIteration();
    expect(ropt instanceof TiffRoptChunk).toBe(true);
    const buf = new BytesIO();
    ropt.write(buf);
    expect(len(buf.getvalue())).toBe(602);
  });

  test("test_add_without_prefs_roundtrips", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("custom.aep"));
    const rq = render_queue_of(app.project);
    const comp = app.project.compositions[0];
    const orig = rq.num_items;

    rq.add(comp);

    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const app2 = parse_aep(out);
    const rq2 = render_queue_of(app2.project);
    expect(rq2.num_items).toBe(orig + 1);
    expect(rq2.items[len(rq2.items) - 1].output_modules[0].name).toBe("TIFF Sequence with Alpha");
  });

  test("test_add_to_empty_queue_roundtrips", () => {
    const tmp_path = make_tmp_path();
    // A project whose render queue starts empty: the settings 'list' has
    // only an lhd3 and a synthetic (unwritten) ldat. add() materializes
    // the ldat so the new settings get written.
    const app = parse_aep(SAMPLES_DIR.div("empty.aep"));
    const rq = render_queue_of(app.project);
    expect(rq.num_items).toBe(0);
    const comp = app.project.compositions[0];

    rq.add(comp);
    expect(rq.num_items).toBe(1);

    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const app2 = parse_aep(out);
    const rq2 = render_queue_of(app2.project);
    expect(rq2.num_items).toBe(1);
    expect(rq2.items[0].output_modules[0].name).toBe("TIFF Sequence with Alpha");
  });

  test("test_empty_queue_unchanged_roundtrip_is_byte_identical", () => {
    const tmp_path = make_tmp_path();
    // The synthetic ldat attached by the parser must be skipped on write,
    // so parsing then saving an untouched empty queue is byte-identical.
    const src = SAMPLES_DIR.div("empty.aep");
    const app = parse_aep(src);
    expect(render_queue_of(app.project).num_items).toBe(0);

    const out = tmp_path.div("roundtrip.aep");
    app.project.save(out);
    expect(py_eq(out.read_bytes(), src.read_bytes())).toBe(true);
  });

  test("test_add_to_empty_queue_reparse_links_comp", () => {
    const tmp_path = make_tmp_path();
    // Regression: adding to a queue-less project, saving, then reparsing
    // must yield exactly one item linked to the original comp.
    const app = parse_aep(SAMPLES_DIR.div("empty.aep"));
    const rq = render_queue_of(app.project);
    expect(rq.num_items).toBe(0);
    const comp = app.project.compositions[0];

    rq.add(comp);

    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const app2 = parse_aep(out);
    const rq2 = render_queue_of(app2.project);
    expect(rq2.num_items).toBe(1);
    expect(rq2.items[0].comp.name).toBe(comp.name);
    expect(rq2.items[0].comp.id).toBe(comp.id);
  });

  test("test_image_sequence_chunk_defaults", () => {
    // Field defaults reproduce AE's fresh "TIFF Sequence with Alpha" item
    // (values captured from After Effects 26). The reserved-region values
    // are the bytes AE writes; without them AE reports "missing data".
    const rouu = new RouuChunk();
    expect(rouu.format_id).toBe("TIF ");
    expect(rouu.depth).toBe(32);
    expect(rouu.audio_encoding).toBe(0xffff);
    expect(rouu.audio_channels).toBe(0);
    // The full image-sequence body is 154 bytes (114 typed + 40 trailing).
    expect(len(rouu.tobytes())).toBe(154);

    const rs = new RenderSettingsItem();
    expect(py_eq(rs._reserved_00, b("\x00\x01\x00\x00\x00\x00\x00"))).toBe(true);
    expect(py_eq(rs._reserved_06, b("\x00\x03\x00\x00"))).toBe(true);
    expect(
      py_eq(rs._reserved_39, concat(b("\xff\xff\xff\xff\x00\xb4"), bytes_.repeat(b("\x00"), 8))),
    ).toBe(true);
    expect(py_eq(rs._reserved_45, b("\x00\x00\x00\x02\xff\xff"))).toBe(true);
    expect(py_eq(rs._reserved_end, bytes_.repeat(b("\x00"), 16))).toBe(true);
    expect(rs.item_id).toBe(2);
    expect(py_eq(rs._remaining, concat(b("\x00\x00\x00\x0f"), bytes_.repeat(b("\x00"), 16)))).toBe(true);

    const om = new OutputModuleSettingsItem();
    expect(om.convert_to_linear_light).toBe(2);
    expect(om.output_color_space_working).toBe(1);
    expect(om.channels).toBe(1);
  });

  test("test_tiff_ropt_default_is_602_bytes", () => {
    // A default TiffRoptChunk reproduces AE's exact 602-byte TIFF Ropt
    // (the markers, incl. 0x025A = 602, are split across _pad + chunk_size).
    const buf = new BytesIO();
    new TiffRoptChunk().write(buf);
    const data = buf.getvalue();
    expect(len(data)).toBe(602);
    expect(py_eq(bytes_.slice(data, 0, 4), b("TIF "))).toBe(true);
    expect(new TiffRoptChunk().chunk_size).toBe(602);
  });

  test("test_ropt_variant_defaults_are_valid_chunks", () => {
    // Each variant's field defaults reproduce AE's real Ropt for that
    // format: correct full length, format code, and a construct -> parse
    // round-trip back to the same variant and bytes.
    const cases: [new () => RoptChunk, Uint8Array, number][] = [
      [CineonRoptChunk, b("sDPX"), 48],
      [JpegRoptChunk, b("JPEG"), 58],
      [OpenExrRoptChunk, b("oEXR"), 78],
      [PngRoptChunk, b("png!"), 322],
      [TargaRoptChunk, b("TPIC"), 84],
    ];
    for (const [cls, code, size] of cases) {
      const data = new cls().tobytes();
      py_assert(len(data) === size, repr(code));
      py_assert(py_eq(bytes_.slice(data, 0, 4), code), repr(code));
      // RoptChunk dispatch re-parses the bytes to the same variant + bytes
      const parsed = RoptChunk.frombytes(data, { chunk_type: "Ropt" });
      py_assert(parsed instanceof cls, repr(code));
      py_assert(py_eq(parsed.tobytes(), data), repr(code));
    }
  });

  test("test_arsi_chunk_named_fields", () => {
    // The ARsi state chunk parses to a typed ArsiChunk (fixed 1872 bytes)
    // whose queue_nonempty flag (offset 3) tracks whether the queue has
    // items.
    const app = parse_aep(SAMPLES_DIR.div("field_render.aep"));
    const rq = render_queue_of(app.project);
    const arsi = as_instance(recursive_find(rq._lrdr.chunks, "ARsi")[0], ArsiChunk);
    expect(arsi instanceof ArsiChunk).toBe(true);
    expect(len(arsi.tobytes())).toBe(1872);
    expect(arsi.queue_nonempty).toBe(rq.num_items ? 1 : 0);
  });

  test("test_parse_id_hex_section_is_bounded", () => {
    // The section parser must decode AE's hex/ASCII encoding and never
    // leak continuation lines across section boundaries.
    const text =
      '["Output File Info Preference Section v28"]\n' +
      '\t"Output File Info ID # 0" = "AB"00"CD"\\\n' +
      '\t\t01"EF"\n' +
      '["Output File Options Preference Section v28"]\n' +
      '\t"Output File Options ID # 0" = "XY"FF\n';
    const info = _parse_id_hex_section(text, "Output File Info Preference Section", "Output File Info");
    const opts = _parse_id_hex_section(text, "Output File Options Preference Section", "Output File Options");
    // Info entry stops at the section boundary (no Options bytes leak in).
    expect(py_eq(getitem(info, 0), b("AB\x00CD\x01EF"))).toBe(true);
    expect(py_eq(getitem(opts, 0), b("XY\xff"))).toBe(true);
  });
});

/** Tests for OutputModule.remove(). */
describe("TestOMRemove", () => {
  test("test_remove_last_om_raises", () => {
    // Cannot remove the only output module.
    const app = parse_aep(SAMPLES_DIR.div("base.aep"));
    const rq = render_queue_of(app.project);
    const rqi = rq.items[0];
    expect(len(rqi.output_modules)).toBe(1);

    raises(ValueError, () => {
      rqi.output_modules[0].remove();
    }, "last output module");
  });
});

/** Tests for RenderQueue.add(). */
describe.skipIf(!py_bool(AE_PREFS_DIR))("TestRenderQueueAdd", () => {
  test("test_add_returns_rq_item", () => {
    // RenderQueue.add() returns a RenderQueueItem.
    const app = parse_aep(SAMPLES_DIR.div("custom.aep"), { ae_preferences_dir: AE_PREFS_DIR });
    const rq = render_queue_of(app.project);
    const comp = app.project.compositions[0];
    const rqi = rq.add(comp);
    expect(rqi instanceof RenderQueueItem).toBe(true);
  });

  test("test_add_increments_num_items", () => {
    // Adding a comp increases num_items by 1.
    const app = parse_aep(SAMPLES_DIR.div("custom.aep"), { ae_preferences_dir: AE_PREFS_DIR });
    const rq = render_queue_of(app.project);
    const comp = app.project.compositions[0];
    const n = rq.num_items;
    rq.add(comp);
    expect(rq.num_items).toBe(n + 1);
  });

  test("test_add_sets_comp_reference", () => {
    // The new RQ item references the correct comp.
    const app = parse_aep(SAMPLES_DIR.div("custom.aep"), { ae_preferences_dir: AE_PREFS_DIR });
    const rq = render_queue_of(app.project);
    const comp = app.project.compositions[0];
    const rqi = rq.add(comp);
    expect(rqi.comp).toBe(comp);
  });

  test("test_add_default_status_needs_output", () => {
    // New item has NEEDS_OUTPUT status (no output file path set yet).
    const app = parse_aep(SAMPLES_DIR.div("custom.aep"), { ae_preferences_dir: AE_PREFS_DIR });
    const rq = render_queue_of(app.project);
    const comp = app.project.compositions[0];
    const rqi = rq.add(comp);
    expect(rqi.status).toBe(RQItemStatus.NEEDS_OUTPUT);
  });

  test("test_add_default_time_span", () => {
    // New item has WORK_AREA_ONLY time span source (matches AE add()).
    const app = parse_aep(SAMPLES_DIR.div("custom.aep"), { ae_preferences_dir: AE_PREFS_DIR });
    const rq = render_queue_of(app.project);
    const comp = app.project.compositions[0];
    const rqi = rq.add(comp);
    expect(rqi._ldat.time_span_source).toBe(int(TimeSpanSource.WORK_AREA_ONLY));
  });

  test("test_add_has_one_output_module", () => {
    // New item has exactly 1 output module.
    const app = parse_aep(SAMPLES_DIR.div("custom.aep"), { ae_preferences_dir: AE_PREFS_DIR });
    const rq = render_queue_of(app.project);
    const comp = app.project.compositions[0];
    const rqi = rq.add(comp);
    expect(len(rqi.output_modules)).toBe(1);
  });

  test("test_add_to_empty_queue", () => {
    // Adding to an empty render queue works.
    const app = parse_aep(SAMPLES_DIR.div("empty.aep"), { ae_preferences_dir: AE_PREFS_DIR });
    const rq = render_queue_of(app.project);
    expect(rq.num_items).toBe(0);
    const comp = app.project.compositions[0];
    const rqi = rq.add(comp);
    expect(rq.num_items).toBe(1);
    expect(rqi.comp).toBe(comp);
  });

  test("test_add_to_existing_queue", () => {
    // Adding to a queue that already has items works.
    const app = parse_aep(SAMPLES_DIR.div("custom.aep"), { ae_preferences_dir: AE_PREFS_DIR });
    const rq = render_queue_of(app.project);
    const n = rq.num_items;
    const comp = app.project.compositions[0];
    const rqi = rq.add(comp);
    expect(rq.num_items).toBe(n + 1);
    expect(rq.items.at(-1)).toBe(rqi);
  });

  test("test_add_roundtrip", () => {
    // Save + reparse preserves the new RQ item.
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("custom.aep"), { ae_preferences_dir: AE_PREFS_DIR });
    const rq = render_queue_of(app.project);
    const comp = app.project.compositions[0];
    rq.add(comp);

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));
    const rq2 = render_queue_of(app2.project);
    expect(rq2.num_items).toBe(2);
    expect(rq2.items[len(rq2.items) - 1].comp.name).toBe(comp.name);
  });

  test("test_add_then_remove", () => {
    // Add then remove leaves RQ in original state.
    const app = parse_aep(SAMPLES_DIR.div("custom.aep"), { ae_preferences_dir: AE_PREFS_DIR });
    const rq = render_queue_of(app.project);
    const original_count = rq.num_items;
    const comp = app.project.compositions[0];
    const rqi = rq.add(comp);
    expect(rq.num_items).toBe(original_count + 1);
    rqi.remove();
    expect(rq.num_items).toBe(original_count);
  });
});

/** Removing one of two byte-identical output modules hits the right block. */
describe("TestOMRemoveIdenticalModules", () => {
  test("test_remove_second_of_identical_modules", () => {
    const tmp_path = make_tmp_path();
    // numOutputModules_2 has two structurally-equal H.264 modules; with a
    // value-based lookup remove() would delete the first module's chunks.
    const app = parse_aep(OM_SAMPLES_DIR.div("numOutputModules_2.aep"));
    const rqi = render_queue_of(app.project).items[0];
    const [om0, om1] = rqi.output_modules;
    // Distinguish the two modules by a per-module Roou value.
    om0._roou.starting_number = 7;
    om1._roou.starting_number = 99;

    om1.remove();
    expect(len(rqi.output_modules)).toBe(1);
    // The surviving module is module 0, with its chunks intact.
    expect(rqi.output_modules[0]).toBe(om0);
    expect(rqi.output_modules[0]._roou.starting_number).toBe(7);

    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const rqi2 = render_queue_of(parse_aep(out).project).items[0];
    expect(len(rqi2.output_modules)).toBe(1);
    expect(rqi2.output_modules[0]._roou.starting_number).toBe(7);
  });
});

/** apply_template targets only the module it is called on. */
describe.skipIf(!py_bool(AE_PREFS_DIR))("TestOMApplyTemplate", () => {
  test("test_apply_template_leaves_sibling_untouched", () => {
    // Applying a template to module 1 must not rewrite module 0's Ropt
    // (the shared LOm list holds both modules' chunks back to back).
    const app = parse_aep(OM_SAMPLES_DIR.div("numOutputModules_2.aep"), { ae_preferences_dir: AE_PREFS_DIR });
    const rqi = render_queue_of(app.project).items[0];
    const [om0, om1] = rqi.output_modules;
    const om0_fo_before = om0.format_options;
    if (om0_fo_before == null) throw new AssertionError_("output module 0 has no format_options");
    const om0_ropt_before = om0_fo_before._body.tobytes();
    const om0_format_before = om0._roou.format_id;

    om1.apply_template("TIFF Sequence with Alpha");

    // Module 1 switched to TIFF; module 0 still H.264 with the same Ropt.
    expect(om1._roou.format_id).toBe("TIF ");
    expect(om0._roou.format_id).toBe(om0_format_before);
    const om0_fo_after = om0.format_options;
    if (om0_fo_after == null) throw new AssertionError_("output module 0 has no format_options");
    expect(py_eq(om0_fo_after._body.tobytes(), om0_ropt_before)).toBe(true);
  });

  test("test_apply_template_refreshes_format_options", () => {
    const tmp_path = make_tmp_path();
    // After apply_template the format_options must wrap the NEW Ropt, so
    // an edit through it serializes (the old chunk was detached/unwritten).
    const app = parse_aep(OM_SAMPLES_DIR.div("numOutputModules_2.aep"), { ae_preferences_dir: AE_PREFS_DIR });
    const rqi = render_queue_of(app.project).items[0];
    const om1 = rqi.output_modules[1];
    om1.apply_template("TIFF Sequence with Alpha");

    const fo = as_instance(om1.format_options, TiffFormatOptions);
    expect(fo.constructor.name).toBe("TiffFormatOptions");
    const new_value = !fo.lzw_compression;
    fo.lzw_compression = new_value;

    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const rqi2 = render_queue_of(parse_aep(out, { ae_preferences_dir: AE_PREFS_DIR }).project).items[0];
    expect(as_instance(rqi2.output_modules[1].format_options, TiffFormatOptions).lzw_compression).toBe(new_value);
  });
});

/** duplicate() resets a finished item's status to QUEUED. */
describe("TestRQItemDuplicateStatus", () => {
  test.each([RQItemStatus.DONE, RQItemStatus.ERR_STOPPED].map((s) => [s]))(
    "test_duplicate_resets_finished_status[%#]",
    (done_status: number) => {
      const app = parse_aep(SAMPLES_DIR.div("base.aep"));
      const rqi = render_queue_of(app.project).items[0];
      // status stores the raw binary value, so set it via to_binary().
      rqi._ldat.status = RQItemStatus.to_binary(done_status);

      const dup = rqi.duplicate();

      expect(RQItemStatus.from_binary(dup._ldat.status)).toBe(RQItemStatus.QUEUED);
    },
  );
});

/** Removing a comp also removes its render-queue items (chunks and all). */
describe("TestCompRemoveWithRenderQueue", () => {
  test("test_remove_comp_clears_its_rq_item", () => {
    const tmp_path = make_tmp_path();
    // numItems_2 renders two distinct comps; the active item is neither,
    // so removing one rendered comp leaves a parseable project.
    const app = parse_aep(SAMPLES_DIR.div("numItems_2.aep"));
    const rq = render_queue_of(app.project);
    expect(len(rq.items)).toBe(2);
    const comp0 = rq.items[0].comp;
    const comp1 = rq.items[1].comp;
    expect(comp0).not.toBe(comp1);

    comp0.remove();

    expect(len(rq.items)).toBe(1);
    expect(rq.items[0].comp).toBe(comp1);
    // Chunk-level bookkeeping stays in sync (no orphaned settings entry).
    expect(rq._rs_lhd3.count).toBe(1);
    expect(rq._rout.count).toBe(ROUT_ITEMS_PER_RQ_ITEM);

    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const rq2 = render_queue_of(parse_aep(out).project);
    expect(len(rq2.items)).toBe(1);
    expect(rq2._rs_lhd3.count).toBe(1);
  });

  test("test_remove_comp_keeps_remaining_item_removable", () => {
    const tmp_path = make_tmp_path();
    // After comp.remove(), the rs_ldat index bookkeeping must still line up
    // so a later rqi.remove() deletes the correct settings entry.
    const app = parse_aep(SAMPLES_DIR.div("numItems_2.aep"));
    render_queue_of(app.project).items[0].comp.remove();

    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const app2 = parse_aep(out);
    const rq2 = render_queue_of(app2.project);
    expect(len(rq2.items)).toBe(1);

    rq2.items[0].remove();
    expect(len(rq2.items)).toBe(0);
    expect(rq2._rs_lhd3.count).toBe(0);
    expect(rq2._rout.count).toBe(0);
  });
});

/**
 * An LRdr lacking Rout/LItm/LSIf still parses as an empty queue.
 *
 * Regression: parse_render_queue required those chunks unconditionally,
 * so a legacy/minimal file failed the entire parse() with
 * ChunkNotFoundError instead of yielding an empty RenderQueue.
 */
describe("TestRenderQueueMissingScaffolding", () => {
  function _strip_scaffolding(tmp_path: Path): Path {
    const src = SAMPLES_DIR.div("empty.aep");
    const [rifx, xmp] = read_aep(new BytesIO(src.read_bytes()));
    const lrdr = find_by_list_type(rifx.chunks, "LRdr");
    lrdr.chunks = lrdr.chunks.filter(
      (c) =>
        c.chunk_type !== "Rout" &&
        !(c instanceof ListChunk && ["LItm", "LSIf"].includes(c.list_type)),
    );
    const out = tmp_path.div("stripped.aep");
    const f = new BytesIO();
    write_aep(f, rifx, xmp);
    out.write_bytes(f.getvalue());
    return out;
  }

  test("test_parse_yields_empty_queue", () => {
    const tmp_path = make_tmp_path();
    const stripped = _strip_scaffolding(tmp_path);
    const app = parse_aep(stripped);
    const rq = render_queue_of(app.project);
    expect(rq.num_items).toBe(0);
    expect(py_eq([...rq], [])).toBe(true);
  });

  test("test_untouched_roundtrip_is_byte_identical", () => {
    const tmp_path = make_tmp_path();
    // The synthetic placeholder chunks must be skipped on write.
    const stripped = _strip_scaffolding(tmp_path);
    const app = parse_aep(stripped);
    const out = tmp_path.div("roundtrip.aep");
    app.project.save(out);
    expect(py_eq(out.read_bytes(), stripped.read_bytes())).toBe(true);
  });
});

/**
 * A project with NO top-level LRdr chunk parses as an empty queue, and
 * add() then attaches a writable queue that survives a reparse.
 *
 * Regression: parse_render_queue required a top-level LRdr unconditionally
 * (so a legacy/hand-built file lacking it failed parse() entirely), and a
 * freshly-added queue was never attached to the root so it was lost on save.
 */
describe("TestRenderQueueNoLRdr", () => {
  function _strip_lrdr(tmp_path: Path): Path {
    const src = SAMPLES_DIR.div("empty.aep");
    const [rifx, xmp] = read_aep(new BytesIO(src.read_bytes()));
    rifx.chunks = rifx.chunks.filter((c) => !(c instanceof ListChunk && c.list_type === "LRdr"));
    const out = tmp_path.div("no_lrdr.aep");
    const f = new BytesIO();
    write_aep(f, rifx, xmp);
    out.write_bytes(f.getvalue());
    return out;
  }

  test("test_parse_yields_empty_queue", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(_strip_lrdr(tmp_path));
    const rq = render_queue_of(app.project);
    expect(rq.num_items).toBe(0);
    expect(py_eq([...rq], [])).toBe(true);
  });

  test("test_untouched_roundtrip_is_byte_identical", () => {
    const tmp_path = make_tmp_path();
    // The synthesized LRdr is synthetic, so write_aep skips it entirely.
    const stripped = _strip_lrdr(tmp_path);
    const app = parse_aep(stripped);
    const out = tmp_path.div("roundtrip.aep");
    app.project.save(out);
    expect(py_eq(out.read_bytes(), stripped.read_bytes())).toBe(true);
  });

  test("test_add_reparse_links_comp", () => {
    const tmp_path = make_tmp_path();
    const stripped = _strip_lrdr(tmp_path);
    const app = parse_aep(stripped);
    const rq = render_queue_of(app.project);
    const comp = app.project.compositions[0];
    rq.add(comp);
    expect(rq.num_items).toBe(1);

    const out = tmp_path.div("added.aep");
    app.project.save(out);
    const app2 = parse_aep(out);
    const rq2 = render_queue_of(app2.project);
    expect(rq2.num_items).toBe(1);
    expect(rq2.items[0].comp.id).toBe(comp.id);
  });
});

/** Roundtrip tests for OutputModule.output_color_space. */
describe("TestRoundtripOutputColorSpace", () => {
  const _ROOT = TEST_FILE.parent.parent.parent;
  /** Adobe-CMS project (output color space = a catalogued Adobe ICC profile). */
  const ADOBE_SAMPLE = _ROOT.div("samples/models/output_module/output_color_space/srgb.aep");
  /** OCIO-CMS project generated from `sergb.ocio` (its committed output id is
  the AE-computed `Guid` of "ACEScg yo"). */
  const OCIO_SAMPLE = _ROOT.div("samples/models/output_module/output_color_space_ocio/aces_acescg_yo.aep");
  const OCIO_CONFIG = _ROOT.div("samples/models/output_module/output_color_space_ocio/sergb.ocio");

  test("test_set_adobe_profile", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(ADOBE_SAMPLE).project;
    const om = render_queue_of(project).items[0].output_modules[0];
    const name = "ARRI LogC3 Wide Color Gamut - EI 800";
    om.output_color_space = name;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const om2 = render_queue_of(parse_aep(out).project).items[0].output_modules[0];
    expect(om2.output_color_space).toBe(name);
    // output_profile_id is the catalogued ID (matches AE ground truth).
    expect(py_eq(om2._om_ldat.output_profile_id, profile_id_for_name(name))).toBe(true);
    expect(om2._om_ldat.output_color_space_working).toBe(0);
  });

  test("test_set_working_color_space", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(ADOBE_SAMPLE).project;
    const om = render_queue_of(project).items[0].output_modules[0];
    om.output_color_space = "ARRI LogC3 Wide Color Gamut - EI 800";
    expect(om._om_ldat.output_color_space_working).toBe(0);
    om.output_color_space = "Working Color Space";

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const project2 = parse_aep(out).project;
    const om2 = render_queue_of(project2).items[0].output_modules[0];
    expect(om2._om_ldat.output_color_space_working).toBe(1);
    // "Working Color Space" resolves to the project's working space name.
    expect(om2.output_color_space).toBe(project2.working_space);
  });

  test("test_unknown_adobe_name_not_supported", () => {
    const project = parse_aep(ADOBE_SAMPLE).project;
    expect(project.color_management_system).toBe(ColorManagementSystem.ADOBE);
    const om = render_queue_of(project).items[0].output_modules[0];
    raises(NotImplementedError, () => {
      om.output_color_space = "not a catalogued ICC profile";
    });
  });

  test("test_set_ocio_color_space", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(OCIO_SAMPLE).project;
    expect(project.color_management_system).toBe(ColorManagementSystem.OCIO);
    project.ocio_configuration_file = fspath(OCIO_CONFIG);
    const om = render_queue_of(project).items[0].output_modules[0];
    // "ACEScc yo" - AE's own Guid for it is the committed aces_acescc_yo id.
    om.output_color_space = "ACEScc yo";
    const expected = bytes_.fromhex("596cbde737d61ec5a84b8008888dd03f");
    expect(py_eq(om._om_ldat.output_profile_id, expected)).toBe(true);
    expect(om._om_ldat.output_color_space_working).toBe(0);
    // the id reverse-maps back to the color-space name (read/write symmetry).
    expect(om.output_color_space).toBe("ACEScc yo");

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const om2 = render_queue_of(parse_aep(out).project).items[0].output_modules[0];
    expect(py_eq(om2._om_ldat.output_profile_id, expected)).toBe(true);
    expect(om2.output_color_space).toBe("ACEScc yo");
  });

  test("test_ocio_unknown_color_space_raises", () => {
    const project = parse_aep(OCIO_SAMPLE).project;
    project.ocio_configuration_file = fspath(OCIO_CONFIG);
    const om = render_queue_of(project).items[0].output_modules[0];
    raises(ValueError, () => {
      om.output_color_space = "NotAColorSpaceInThisConfig";
    }, "not a color space");
  });
});

// Audio edit chains After Effects applied in audio_settings_matrix.aep: each
// case names its starting item and the setSettings calls AE made on a
// duplicate of it (items are named by their output file stem). U = Output
// Audio Off with an unset audio format, S = On + Stereo, A = Auto + Stereo,
// Z = A switched Off.
const _ON = OutputAudio.ON;
const _OFF = OutputAudio.OFF;
const _AUTO = OutputAudio.AUTO;
const _8 = AudioBitDepth.EIGHT_BIT;
const _16 = AudioBitDepth.SIXTEEN_BIT;
const _32 = AudioBitDepth.THIRTY_TWO_BIT;
const _AUDIO_CHAINS = new Map<string, [string, Map<string, SettingValue>[]]>([
  ["E0_on", ["U", [new Map<string, SettingValue>([["Output Audio", _ON]])]]],
  ["E1_on_8", ["U", [new Map<string, SettingValue>([["Output Audio", _ON]]), new Map<string, SettingValue>([["Audio Bit Depth", _8]])]]],
  ["E2_on_16", ["U", [new Map<string, SettingValue>([["Output Audio", _ON]]), new Map<string, SettingValue>([["Audio Bit Depth", _16]])]]],
  ["E3_on_32", ["U", [new Map<string, SettingValue>([["Output Audio", _ON]]), new Map<string, SettingValue>([["Audio Bit Depth", _32]])]]],
  [
    "E5_on_mono",
    ["U", [new Map<string, SettingValue>([["Output Audio", _ON]]), new Map<string, SettingValue>([["Audio Channels", AudioChannels.MONO]])]],
  ],
  [
    "E7_on_rate",
    ["U", [new Map<string, SettingValue>([["Output Audio", _ON]]), new Map<string, SettingValue>([["Audio Sample Rate", 44100]])]],
  ],
  ["E8_auto", ["U", [new Map<string, SettingValue>([["Output Audio", _AUTO]])]]],
  [
    "E9_on_mono_8",
    [
      "U",
      [
        new Map<string, SettingValue>([["Output Audio", _ON]]),
        new Map<string, SettingValue>([["Audio Channels", AudioChannels.MONO]]),
        new Map<string, SettingValue>([["Audio Bit Depth", _8]]),
      ],
    ],
  ],
  [
    "E10_on_8_rate",
    [
      "U",
      [
        new Map<string, SettingValue>([["Output Audio", _ON]]),
        new Map<string, SettingValue>([["Audio Bit Depth", _8]]),
        new Map<string, SettingValue>([["Audio Sample Rate", 22050]]),
      ],
    ],
  ],
  [
    "E11_on_all",
    [
      "U",
      [
        new Map<string, SettingValue>([
          ["Output Audio", _ON],
          ["Audio Bit Depth", _8],
          ["Audio Channels", AudioChannels.MONO],
          ["Audio Sample Rate", 22050],
        ]),
      ],
    ],
  ],
  ["E12_off_8", ["U", [new Map<string, SettingValue>([["Audio Bit Depth", _8]])]]],
  ["F1_8", ["S", [new Map<string, SettingValue>([["Audio Bit Depth", _8]])]]],
  ["F2_32", ["S", [new Map<string, SettingValue>([["Audio Bit Depth", _32]])]]],
  [
    "F3_32_16",
    ["S", [new Map<string, SettingValue>([["Audio Bit Depth", _32]]), new Map<string, SettingValue>([["Audio Bit Depth", _16]])]],
  ],
  [
    "F4_32_8",
    ["S", [new Map<string, SettingValue>([["Audio Bit Depth", _32]]), new Map<string, SettingValue>([["Audio Bit Depth", _8]])]],
  ],
  ["F5_mono", ["S", [new Map<string, SettingValue>([["Audio Channels", AudioChannels.MONO]])]]],
  ["F6_rate", ["S", [new Map<string, SettingValue>([["Audio Sample Rate", 22050]])]]],
  ["F7_off", ["S", [new Map<string, SettingValue>([["Output Audio", _OFF]])]]],
  ["F8_auto", ["S", [new Map<string, SettingValue>([["Output Audio", _AUTO]])]]],
  [
    "F9_off_on",
    ["S", [new Map<string, SettingValue>([["Output Audio", _OFF]]), new Map<string, SettingValue>([["Output Audio", _ON]])]],
  ],
  ["G4_auto_on", ["A", [new Map<string, SettingValue>([["Output Audio", _ON]])]]],
  [
    "G5_auto_off_on",
    ["A", [new Map<string, SettingValue>([["Output Audio", _OFF]]), new Map<string, SettingValue>([["Output Audio", _ON]])]],
  ],
  ["G2_offauto_on", ["Z", [new Map<string, SettingValue>([["Output Audio", _ON]])]]],
  ["G3_offauto_auto", ["Z", [new Map<string, SettingValue>([["Output Audio", _AUTO]])]]],
  // The starting states themselves, rebuilt from U.
  [
    "S",
    ["U", [new Map<string, SettingValue>([["Output Audio", _ON]]), new Map<string, SettingValue>([["Audio Channels", AudioChannels.STEREO]])]],
  ],
  [
    "A",
    ["U", [new Map<string, SettingValue>([["Output Audio", _AUTO]]), new Map<string, SettingValue>([["Audio Channels", AudioChannels.STEREO]])]],
  ],
  ["Z", ["A", [new Map<string, SettingValue>([["Output Audio", _OFF]])]]],
]);

function _om_by_file_stem(project: Project, stem: string): OutputModule {
  for (const rqi of render_queue_of(project).items) {
    const om = rqi.output_modules[0];
    if (new PureWindowsPath(om.file).stem === stem) return om;
  }
  throw new KeyError(repr(stem));
}

/**
 * Audio settings writes produce the bytes After Effects writes for the
 * same `setSettings` calls (audio_settings_matrix.aep).
 */
describe("TestOutputModuleAudioMatchesAfterEffects", () => {
  const MATRIX = OM_SAMPLES_DIR.div("audio_settings_matrix.aep");

  test.each(sorted(_AUDIO_CHAINS.keys()).map((c) => [c]))(
    "test_audio_edit_writes_after_effects_bytes[%#]",
    (case_: string) => {
      const tmp_path = make_tmp_path();
      const [start, steps] = getitem(_AUDIO_CHAINS, case_);
      const project = parse_aep(MATRIX).project;
      const om = _om_by_file_stem(project, start);
      for (const step of steps) {
        // Single keys go through `settings[key]`: a `settings` dict skips
        // a key whose read value is unchanged, and an unset audio format
        // reads Stereo / 32 Bit (AE's fallbacks).
        if (len(step) === 1) {
          const [[key, value]] = [...step];
          om.settings.set(key, value);
        } else {
          om.settings = step;
        }
      }

      const out = tmp_path.div("audio.aep");
      project.save(out);
      const saved = parse_aep(out).project;
      const got = _om_by_file_stem(saved, start);
      const want = _om_by_file_stem(saved, case_);
      expect(py_eq(got._roou.tobytes(), want._roou.tobytes())).toBe(true);
      expect(py_eq(asdict(got._om_ldat), asdict(want._om_ldat))).toBe(true);
    },
  );

  test.each(["U", "S"].map((s) => [s]))("test_24_bit_audio_is_rejected[%#]", (start: string) => {
    // AE 2026 has no 24-bit audio output: a script setting it crashes
    // AE, and a stored 24-bit format reads back as 16 Bit.
    const project = parse_aep(MATRIX).project;
    const om = _om_by_file_stem(project, start);
    const before = om._roou.tobytes();
    raises(ValueError, () => {
      om.settings.set("Audio Bit Depth", AudioBitDepth.TWENTY_FOUR_BIT);
    }, "24-bit");
    raises(ValueError, () => {
      om.settings = new Map<string, SettingValue>([["Audio Bit Depth", AudioBitDepth.TWENTY_FOUR_BIT]]);
    }, "24-bit");
    expect(py_eq(om._roou.tobytes(), before)).toBe(true);
  });
});
