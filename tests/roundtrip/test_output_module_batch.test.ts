/**
 * batch_edit(): deferred whole-state validation with rollback.
 */

import { expect, test } from "bun:test";

import { as_instance, parse_project_fresh } from "../helpers.ts";
import { AudioChannels, AudioCodec, OutputChannels, OutputColorDepth, OutputColorMode } from "../../src/py_aep/enums/index.ts";
import type { Project } from "../../src/py_aep/models/project.ts";
import type { OutputModule } from "../../src/py_aep/models/renderqueue/output_module.ts";
import { XmlFormatOptions } from "../../src/py_aep/models/renderqueue/format_options/xml.ts";
import { RenderQueue } from "../../src/py_aep/models/renderqueue/render_queue.ts";
import type { SettingValue } from "../../src/py_aep/models/renderqueue/settings.ts";
import { int, Path, py_eq, RuntimeError, ValueError } from "../../src/pyrt/index.ts";
import { make_tmp_path, raises } from "../../src/pyrt/pytest.ts";

const FORMAT_DIR = new Path(import.meta.dir).parent.parent.div("samples").div("models").div("format_options");
const RQ_DIR = new Path(import.meta.dir).parent.parent.div("samples").div("models").div("renderqueue");

function _om(project: Project): OutputModule {
  return as_instance(project.render_queue, RenderQueue).items[0].output_modules[0];
}

function _fo(om: OutputModule): XmlFormatOptions {
  return as_instance(om.format_options, XmlFormatOptions);
}

/** The write order that raises outside a batch passes inside one. */
test("test_coupled_writes_succeed_in_any_order", () => {
  const tmp_path = make_tmp_path();
  // Outside: rate-under-old-codec then codec works, codec-then-rate
  // raises. In a batch both orders converge on the same valid state.
  const project = parse_project_fresh(FORMAT_DIR.div("wav", "base.aep"));
  const om = _om(project);
  om.batch_edit(() => {
    om.settings.__setitem__("Audio Sample Rate", 22050);
    _fo(om).audio_codec = AudioCodec.GSM_6_10;
    om.settings.__setitem__("Audio Channels", AudioChannels.MONO);
  });
  project.save(tmp_path.div("a.aep"));

  const project2 = parse_project_fresh(FORMAT_DIR.div("wav", "base.aep"));
  const om2 = _om(project2);
  om2.batch_edit(() => {
    _fo(om2).audio_codec = AudioCodec.GSM_6_10;
    om2.settings.__setitem__("Audio Channels", AudioChannels.MONO);
    om2.settings.__setitem__("Audio Sample Rate", 22050);
  });
  project2.save(tmp_path.div("b.aep"));

  for (const name of ["a.aep", "b.aep"]) {
    const om3 = _om(parse_project_fresh(tmp_path.div(name)));
    expect(_fo(om3).audio_codec).toBe(AudioCodec.GSM_6_10);
    expect(om3.settings.__getitem__("Audio Channels")).toBe(AudioChannels.MONO);
    expect(int(om3.settings.__getitem__("Audio Sample Rate"))).toBe(22050);
  }
});

test("test_invalid_final_state_rolls_back_everything", () => {
  const project = parse_project_fresh(FORMAT_DIR.div("wav", "base.aep"));
  const om = _om(project);
  const before = om.get_settings();
  const before_codec = _fo(om).audio_codec;
  const excinfo = raises(ValueError, () => {
    om.batch_edit(() => {
      _fo(om).audio_codec = AudioCodec.GSM_6_10;
      om.settings.__setitem__("Audio Sample Rate", 96000); // invalid under GSM
      om.settings.__setitem__("Audio Channels", AudioChannels.STEREO); // invalid
    });
  });
  // One error, every violation listed.
  expect(excinfo.message.includes("Audio Sample Rate")).toBe(true);
  expect(excinfo.message.includes("Audio Channels")).toBe(true);
  expect(py_eq(om.get_settings(), before)).toBe(true);
  expect(_fo(om).audio_codec).toBe(before_codec);
});

test("test_body_exception_rolls_back_and_propagates", () => {
  const project = parse_project_fresh(FORMAT_DIR.div("mp3", "base.aep"));
  const om = _om(project);
  raises(RuntimeError, () => {
    om.batch_edit(() => {
      _fo(om).bitrate = 320;
      throw new RuntimeError("boom");
    });
  });
  expect(_fo(om).bitrate).toBe(128);
});

/** A rolled-back batch leaves no trace in the saved bytes. */
test("test_rollback_restores_byte_identical_save", () => {
  const tmp_path = make_tmp_path();
  const sample = FORMAT_DIR.div("wav", "base.aep");
  const project = parse_project_fresh(sample);
  project.save(tmp_path.div("untouched.aep"));

  const project2 = parse_project_fresh(sample);
  const om = _om(project2);
  raises(ValueError, () => {
    om.batch_edit(() => {
      _fo(om).audio_codec = AudioCodec.GSM_6_10;
      om.settings.__setitem__("Audio Sample Rate", 96000);
    });
  });
  project2.save(tmp_path.div("rolled_back.aep"));

  const untouched = tmp_path.div("untouched.aep").read_bytes();
  const rolled_back = tmp_path.div("rolled_back.aep").read_bytes();
  expect(py_eq(rolled_back, untouched)).toBe(true);
});

test("test_stale_untouched_dependent_is_flagged", () => {
  // v1 has no exit-clamping: the user must set coupled fields
  // explicitly; the aggregated error tells them which one is missing.
  const project = parse_project_fresh(FORMAT_DIR.div("mp3", "base.aep"));
  const om = _om(project);
  const excinfo = raises(ValueError, () => {
    om.batch_edit(() => {
      _fo(om).bitrate = 320; // stored rate stays 44100
    });
  });
  expect(excinfo.message.includes("Audio Sample Rate")).toBe(true);
  expect(_fo(om).bitrate).toBe(128); // rolled back
});

/**
 * A channels change re-pairs depth once, at exit - both orders
 * converge on the same final state (no in-batch pairing flips).
 */
test("test_depth_and_channels_converge_in_any_order", () => {
  const results: SettingValue[] = [];
  for (const [first, second] of [
    ["depth", "channels"],
    ["channels", "depth"],
  ]) {
    const project = parse_project_fresh(RQ_DIR.div("format_photoshop_sequence.aep"));
    const om = _om(project);
    om.batch_edit(() => {
      for (const step of [first, second]) {
        if (step === "depth") {
          om.settings.__setitem__("Depth", OutputColorDepth.TRILLIONS_OF_COLORS);
        } else {
          om.settings.__setitem__("Channels", OutputChannels.RGBA);
        }
      }
    });
    results.push(om.settings.__getitem__("Depth"));
  }
  // The channels change re-pairs 48 -> 64 at exit in both orders.
  expect(
    py_eq(results, [OutputColorDepth.TRILLIONS_OF_COLORS_PLUS, OutputColorDepth.TRILLIONS_OF_COLORS_PLUS]),
  ).toBe(true);
});

/**
 * No channels change -> no silent re-pair; the parity rules flag
 * the impossible pair and the batch rolls back.
 */
test("test_unpaired_depth_without_channels_change_raises", () => {
  const project = parse_project_fresh(RQ_DIR.div("format_photoshop_sequence.aep"));
  const om = _om(project);
  om.settings.__setitem__("Channels", OutputChannels.RGBA); // depth pairs to 32
  const excinfo = raises(ValueError, () => {
    om.batch_edit(() => {
      om.settings.__setitem__("Depth", OutputColorDepth.TRILLIONS_OF_COLORS); // base
    });
  });
  expect(excinfo.message.includes("Depth")).toBe(true);
  expect(om.settings.__getitem__("Depth")).toBe(OutputColorDepth.MILLIONS_OF_COLORS_PLUS);
});

test("test_nested_batches_validate_at_outermost", () => {
  const project = parse_project_fresh(RQ_DIR.div("format_png_sequence.aep"));
  const om = _om(project);
  om.batch_edit(() => {
    om.batch_edit(() => {
      om.settings.__setitem__("Channels", OutputChannels.RGBA);
    });
    // Inner exit must not validate: Color is still premultiplied-free
    // only after we fix it here, in the outer batch.
    om.settings.__setitem__("Color", OutputColorMode.STRAIGHT_UNMATTED);
  });
  expect(om.settings.__getitem__("Color")).toBe(OutputColorMode.STRAIGHT_UNMATTED);
  expect(om.settings.__getitem__("Depth")).toBe(OutputColorDepth.MILLIONS_OF_COLORS_PLUS);
});

test("test_batch_on_removed_module_raises_clearly", () => {
  const project = parse_project_fresh(FORMAT_DIR.div("wav", "base.aep"));
  const om = _om(project);
  const lom_chunks = om._parent_rqi._lom.chunks;
  const [start, end] = om._block_span(lom_chunks);
  lom_chunks.splice(start, end - start); // what remove() does to the chunk block
  raises(
    RuntimeError,
    () => {
      om.batch_edit(() => {});
    },
    "removed",
  );
});

test("test_validate_state_clean_on_parsed_sample", () => {
  const project = parse_project_fresh(FORMAT_DIR.div("wav", "audio_codec_gsm_6.10.aep"));
  expect(py_eq(_om(project).validate_state(), [])).toBe(true);
});
