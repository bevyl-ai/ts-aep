/**
 * batch_edit(): deferred whole-state validation with rollback.
 */

import { expect, test } from "bun:test";

import { asInstance, parseProjectFresh } from "../helpers.ts";
import {
  AudioChannels,
  AudioCodec,
  OutputChannels,
  OutputColorDepth,
  OutputColorMode,
} from "../../src/py_aep/enums/index.ts";
import type { Project } from "../../src/py_aep/models/project.ts";
import type { OutputModule } from "../../src/py_aep/models/renderqueue/output_module.ts";
import { XmlFormatOptions } from "../../src/py_aep/models/renderqueue/format_options/xml.ts";
import { RenderQueue } from "../../src/py_aep/models/renderqueue/render_queue.ts";
import type { SettingValue } from "../../src/py_aep/models/renderqueue/settings.ts";
import { int, Path, valueEquals, RuntimeError, ValueError } from "../../src/pyrt/index.ts";
import { makeTmpPath, raises } from "../support/pytest.ts";

const FORMAT_DIR = new Path(import.meta.dir).parent.parent.div("samples").div("models").div("format_options");
const RQ_DIR = new Path(import.meta.dir).parent.parent.div("samples").div("models").div("renderqueue");

function _om(project: Project): OutputModule {
  return asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0];
}

function _fo(om: OutputModule): XmlFormatOptions {
  return asInstance(om.formatOptions, XmlFormatOptions);
}

/** The write order that raises outside a batch passes inside one. */
test("test_coupled_writes_succeed_in_any_order", () => {
  const tmpPath = makeTmpPath();
  // Outside: rate-under-old-codec then codec works, codec-then-rate
  // raises. In a batch both orders converge on the same valid state.
  const project = parseProjectFresh(FORMAT_DIR.div("wav", "base.aep"));
  const om = _om(project);
  om.batchEdit(() => {
    om.settings.set("Audio Sample Rate", 22050);
    _fo(om).audioCodec = AudioCodec.GSM_6_10;
    om.settings.set("Audio Channels", AudioChannels.MONO);
  });
  project.save(tmpPath.div("a.aep"));

  const project2 = parseProjectFresh(FORMAT_DIR.div("wav", "base.aep"));
  const om2 = _om(project2);
  om2.batchEdit(() => {
    _fo(om2).audioCodec = AudioCodec.GSM_6_10;
    om2.settings.set("Audio Channels", AudioChannels.MONO);
    om2.settings.set("Audio Sample Rate", 22050);
  });
  project2.save(tmpPath.div("b.aep"));

  for (const name of ["a.aep", "b.aep"]) {
    const om3 = _om(parseProjectFresh(tmpPath.div(name)));
    expect(_fo(om3).audioCodec).toBe(AudioCodec.GSM_6_10);
    expect(om3.settings.get("Audio Channels")).toBe(AudioChannels.MONO);
    expect(int(om3.settings.get("Audio Sample Rate"))).toBe(22050);
  }
});

test("test_invalid_final_state_rolls_back_everything", () => {
  const project = parseProjectFresh(FORMAT_DIR.div("wav", "base.aep"));
  const om = _om(project);
  const before = om.getSettings();
  const beforeCodec = _fo(om).audioCodec;
  const excinfo = raises(ValueError, () => {
    om.batchEdit(() => {
      _fo(om).audioCodec = AudioCodec.GSM_6_10;
      om.settings.set("Audio Sample Rate", 96000); // invalid under GSM
      om.settings.set("Audio Channels", AudioChannels.STEREO); // invalid
    });
  });
  // One error, every violation listed.
  expect(excinfo.message.includes("Audio Sample Rate")).toBe(true);
  expect(excinfo.message.includes("Audio Channels")).toBe(true);
  expect(valueEquals(om.getSettings(), before)).toBe(true);
  expect(_fo(om).audioCodec).toBe(beforeCodec);
});

test("test_body_exception_rolls_back_and_propagates", () => {
  const project = parseProjectFresh(FORMAT_DIR.div("mp3", "base.aep"));
  const om = _om(project);
  raises(RuntimeError, () => {
    om.batchEdit(() => {
      _fo(om).bitrate = 320;
      throw new RuntimeError("boom");
    });
  });
  expect(_fo(om).bitrate).toBe(128);
});

/** A rolled-back batch leaves no trace in the saved bytes. */
test("test_rollback_restores_byte_identical_save", () => {
  const tmpPath = makeTmpPath();
  const sample = FORMAT_DIR.div("wav", "base.aep");
  const project = parseProjectFresh(sample);
  project.save(tmpPath.div("untouched.aep"));

  const project2 = parseProjectFresh(sample);
  const om = _om(project2);
  raises(ValueError, () => {
    om.batchEdit(() => {
      _fo(om).audioCodec = AudioCodec.GSM_6_10;
      om.settings.set("Audio Sample Rate", 96000);
    });
  });
  project2.save(tmpPath.div("rolled_back.aep"));

  const untouched = tmpPath.div("untouched.aep").readBytes();
  const rolledBack = tmpPath.div("rolled_back.aep").readBytes();
  expect(valueEquals(rolledBack, untouched)).toBe(true);
});

test("test_stale_untouched_dependent_is_flagged", () => {
  // v1 has no exit-clamping: the user must set coupled fields
  // explicitly; the aggregated error tells them which one is missing.
  const project = parseProjectFresh(FORMAT_DIR.div("mp3", "base.aep"));
  const om = _om(project);
  const excinfo = raises(ValueError, () => {
    om.batchEdit(() => {
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
    const project = parseProjectFresh(RQ_DIR.div("format_photoshop_sequence.aep"));
    const om = _om(project);
    om.batchEdit(() => {
      for (const step of [first, second]) {
        if (step === "depth") {
          om.settings.set("Depth", OutputColorDepth.TRILLIONS_OF_COLORS);
        } else {
          om.settings.set("Channels", OutputChannels.RGBA);
        }
      }
    });
    results.push(om.settings.get("Depth"));
  }
  // The channels change re-pairs 48 -> 64 at exit in both orders.
  expect(
    valueEquals(results, [OutputColorDepth.TRILLIONS_OF_COLORS_PLUS, OutputColorDepth.TRILLIONS_OF_COLORS_PLUS]),
  ).toBe(true);
});

/**
 * No channels change -> no silent re-pair; the parity rules flag
 * the impossible pair and the batch rolls back.
 */
test("test_unpaired_depth_without_channels_change_raises", () => {
  const project = parseProjectFresh(RQ_DIR.div("format_photoshop_sequence.aep"));
  const om = _om(project);
  om.settings.set("Channels", OutputChannels.RGBA); // depth pairs to 32
  const excinfo = raises(ValueError, () => {
    om.batchEdit(() => {
      om.settings.set("Depth", OutputColorDepth.TRILLIONS_OF_COLORS); // base
    });
  });
  expect(excinfo.message.includes("Depth")).toBe(true);
  expect(om.settings.get("Depth")).toBe(OutputColorDepth.MILLIONS_OF_COLORS_PLUS);
});

test("test_nested_batches_validate_at_outermost", () => {
  const project = parseProjectFresh(RQ_DIR.div("format_png_sequence.aep"));
  const om = _om(project);
  om.batchEdit(() => {
    om.batchEdit(() => {
      om.settings.set("Channels", OutputChannels.RGBA);
    });
    // Inner exit must not validate: Color is still premultiplied-free
    // only after we fix it here, in the outer batch.
    om.settings.set("Color", OutputColorMode.STRAIGHT_UNMATTED);
  });
  expect(om.settings.get("Color")).toBe(OutputColorMode.STRAIGHT_UNMATTED);
  expect(om.settings.get("Depth")).toBe(OutputColorDepth.MILLIONS_OF_COLORS_PLUS);
});

test("test_batch_on_removed_module_raises_clearly", () => {
  const project = parseProjectFresh(FORMAT_DIR.div("wav", "base.aep"));
  const om = _om(project);
  const lomChunks = om._parentRqi._lom.chunks;
  const [start, end] = om._blockSpan(lomChunks);
  lomChunks.splice(start, end - start); // what remove() does to the chunk block
  raises(
    RuntimeError,
    () => {
      om.batchEdit(() => {});
    },
    "removed",
  );
});

test("test_validate_state_clean_on_parsed_sample", () => {
  const project = parseProjectFresh(FORMAT_DIR.div("wav", "audio_codec_gsm_6.10.aep"));
  expect(valueEquals(_om(project).validateState(), [])).toBe(true);
});
