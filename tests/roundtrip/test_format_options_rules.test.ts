/**
 * Format-option write rules: member sets, conditionals, clamps, sync.
 *
 * Covers the FO -> OM direction: codec/bitrate/container writes validate
 * against the module's format rules and re-clamp dependent settings, the
 * video codec syncs its Rouu 4cc mirror, and the back-reference that powers
 * it all is wired on every parsed module.
 */

import { expect, test } from "bun:test";

import {
  dict_pop,
  py_assert,
  int,
  Path,
  RuntimeError,
  sorted,
  ValueError,
} from "../../src/pyrt/index.ts";
import { make_tmp_path, raises } from "../../src/pyrt/pytest.ts";
import { AudioChannels, AudioCodec, MPEGAudioFormat, MPEGMultiplexer, OutputChannels, OutputColorDepth, VideoCodec } from "../../src/py_aep/enums/index.ts";
import { parse_format_options } from "../../src/py_aep/parsers/format_options.ts";
import { RenderQueue } from "../../src/py_aep/models/renderqueue/render_queue.ts";
import "../../src/py_aep/binary/_register.ts";
import { as_instance, parse_app, parse_project_fresh, SAMPLES_DIR } from "../helpers.ts";
import type { Project } from "../../src/py_aep/models/project.ts";
import type { OutputModule } from "../../src/py_aep/models/renderqueue/output_module.ts";
import { FormatOptionsBase } from "../../src/py_aep/models/renderqueue/format_options/base.ts";
import { OpenExrFormatOptions } from "../../src/py_aep/models/renderqueue/format_options/openexr.ts";
import { TargaFormatOptions } from "../../src/py_aep/models/renderqueue/format_options/targa.ts";
import { XmlFormatOptions } from "../../src/py_aep/models/renderqueue/format_options/xml.ts";

// `Path(__file__).parent.parent.parent`: `import.meta.dir` is this test's
// directory (tests/roundtrip), so two `.parent` hops reach the package root.
const FORMAT_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "format_options");

function _om(project: Project): OutputModule {
  return as_instance(project.render_queue, RenderQueue).items[0].output_modules[0];
}

// -- back-reference wiring ---------------------------------------------------

// NOTE(port): equals `str(p.relative_to(SAMPLES_DIR))` (test id only) for posix paths; relative_to is not in the pathlib shim.
function _rel_id(p: Path): string {
  return p.parts.slice(SAMPLES_DIR.parts.length).join("/");
}

const _CORPUS = sorted(SAMPLES_DIR.div("models").rglob("*.aep"), (p: Path) => p.parts);

test.each(_CORPUS.map((p) => [_rel_id(p), p]))(
  "test_parent_om_backref_is_wired[%s]",
  (_id: string, aep_path: Path) => {
    const app = parse_app(aep_path);
    for (const rqi of as_instance(app.project.render_queue, RenderQueue).items) {
      for (const om of rqi.output_modules) {
        if (om.format_options != null) {
          expect(om.format_options._parent_om).toBe(om);
        }
      }
    }
  },
);

test("test_parent_om_backref_survives_apply_template", () => {
  // apply_template swaps the Ropt and re-derives format_options; the
  // fresh object must be re-wired. Template parsing needs a prefs dir,
  // so emulate the re-derive path directly (the real one also detaches
  // the outgoing wrapper - see the batch_edit rollback tests below).
  const tmp_path = make_tmp_path();
  const project = parse_project_fresh(FORMAT_DIR.div("targa", "base.aep"));
  const om = _om(project);
  const fo_before = om.format_options;
  const rqi = as_instance(project.render_queue, RenderQueue).items[0];
  om._format_options = parse_format_options(rqi._lom.chunks);
  py_assert(om._format_options != null);
  om._format_options._parent_om = om; // what _apply_output_template does
  expect(om.format_options).not.toBe(fo_before);
  expect(om.format_options?._parent_om).toBe(om);
});

// -- detachment on rebind ----------------------------------------------------

/** Force a batch_edit rollback, returning the now-replaced wrapper. */
function _stale_options(project: Project): [OutputModule, FormatOptionsBase] {
  const om = _om(project);
  const fo = om.format_options;
  raises(
    RuntimeError,
    () =>
      om.batch_edit(() => {
        throw new RuntimeError("force rollback");
      }),
    "force rollback",
  );
  expect(om.format_options).not.toBe(fo);
  return [om, as_instance(fo, FormatOptionsBase)];
}

test("test_rollback_detaches_outgoing_options", () => {
  const project = parse_project_fresh(FORMAT_DIR.div("targa", "base.aep"));
  const [om, fo] = _stale_options(project);
  expect(fo._detached).toBe(true);
  expect(om.format_options?._detached).toBe(false);
});

test("test_stale_options_reject_field_write", () => {
  // A stale wrapper holds an Ropt no longer in the tree: the write would
  // land in an orphaned body, be dropped from the saved file, and still
  // read back as if it had succeeded.
  const project = parse_project_fresh(FORMAT_DIR.div("openexr", "exr_rgba.aep"));
  const [, fo] = _stale_options(project);
  raises(
    RuntimeError,
    () => {
      as_instance(fo, OpenExrFormatOptions).compression = 3;
    },
    "detached",
  );
});

test("test_stale_xml_options_reject_typed_and_raw_writes", () => {
  // Both surfaces, not just the rules-gated params: `frame_rate` writes
  // through `_set_param` and `params` is the raw escape hatch, so neither
  // passes through the format-rule check.
  const project = parse_project_fresh(FORMAT_DIR.div("h.264", "base.aep"));
  const [, stale] = _stale_options(project);
  const fo = as_instance(stale, XmlFormatOptions);
  raises(
    RuntimeError,
    () => {
      fo.audio_codec = AudioCodec.AAC;
    },
    "detached",
  );
  raises(
    RuntimeError,
    () => {
      fo.frame_rate = 30.0;
    },
    "detached",
  );
  raises(
    RuntimeError,
    () => {
      // NOTE(port): `fo.params["k"] = v` is `.set`, which ParamsDict overrides (xml.ts __setitem__) with the detach guard.
      fo.params.set("ADBEVideoCodec", "5");
    },
    "detached",
  );
  raises(
    RuntimeError,
    () => {
      dict_pop(fo.params, "ADBEVideoCodec");
    },
    "detached",
  );
});

test("test_live_options_still_writable_after_rollback", () => {
  // The guard must not leak onto the replacement wrapper.
  const project = parse_project_fresh(FORMAT_DIR.div("openexr", "exr_rgba.aep"));
  const [om] = _stale_options(project);
  as_instance(om.format_options, OpenExrFormatOptions).compression = 3;
  expect(as_instance(om.format_options, OpenExrFormatOptions).compression).toBe(3);
});

// -- member sets --------------------------------------------------------------

test("test_wav_rejects_non_wav_codec", () => {
  const project = parse_project_fresh(FORMAT_DIR.div("wav", "base.aep"));
  raises(ValueError, () => {
    as_instance(_om(project).format_options, XmlFormatOptions).audio_codec = AudioCodec.AAC;
  });
});

test("test_avi_rejects_quicktime_codec", () => {
  const project = parse_project_fresh(FORMAT_DIR.div("avi", "base.aep"));
  raises(ValueError, () => {
    as_instance(_om(project).format_options, XmlFormatOptions).video_codec = VideoCodec.APPLE_PRORES_422;
  });
});

test("test_mp3_rejects_unknown_bitrate", () => {
  const project = parse_project_fresh(FORMAT_DIR.div("mp3", "base.aep"));
  raises(ValueError, () => {
    as_instance(_om(project).format_options, XmlFormatOptions).bitrate = 999;
  });
});

// -- conditionals -------------------------------------------------------------

test("test_pcm_rejected_under_mp4_multiplexer", () => {
  const project = parse_project_fresh(FORMAT_DIR.div("h.264", "base.aep"));
  raises(ValueError, () => {
    as_instance(_om(project).format_options, XmlFormatOptions).mpeg_audio_format = MPEGAudioFormat.PCM;
  });
});

test("test_aac_bitrate_matrix_narrows_by_codec", () => {
  const project = parse_project_fresh(FORMAT_DIR.div("h.264", "base.aep"));
  const fo = as_instance(_om(project).format_options, XmlFormatOptions);
  fo.audio_bitrate = 512; // AAC @ 48 kHz stereo allows it
  fo.audio_codec = AudioCodec.AAC_PLUS_V1;
  raises(ValueError, () => {
    fo.audio_bitrate = 512; // AAC+ v1 tops out at 96
  });
});

// -- clamps and sync ----------------------------------------------------------

test("test_gsm_codec_clamps_mono", () => {
  const tmp_path = make_tmp_path();
  const project = parse_project_fresh(FORMAT_DIR.div("wav", "base.aep"));
  const om = _om(project);
  expect(om.settings.get("Audio Channels")).toBe(AudioChannels.STEREO);
  as_instance(om.format_options, XmlFormatOptions).audio_codec = AudioCodec.GSM_6_10;
  expect(om.settings.get("Audio Channels")).toBe(AudioChannels.MONO);
  project.save(tmp_path.div("out.aep"));
  const om2 = _om(parse_project_fresh(tmp_path.div("out.aep")));
  expect(as_instance(om2.format_options, XmlFormatOptions).audio_codec).toBe(AudioCodec.GSM_6_10);
  expect(om2.settings.get("Audio Channels")).toBe(AudioChannels.MONO);
});

test("test_mp3_bitrate_clamps_rate", () => {
  const tmp_path = make_tmp_path();
  const project = parse_project_fresh(FORMAT_DIR.div("mp3", "base.aep"));
  const om = _om(project);
  as_instance(om.format_options, XmlFormatOptions).bitrate = 320;
  expect(int(om.settings.get("Audio Sample Rate"))).toBe(48000);
  project.save(tmp_path.div("out.aep"));
  const om2 = _om(parse_project_fresh(tmp_path.div("out.aep")));
  expect(as_instance(om2.format_options, XmlFormatOptions).bitrate).toBe(320);
  expect(int(om2.settings.get("Audio Sample Rate"))).toBe(48000);
});

test("test_v210_codec_clamps_depth", () => {
  const tmp_path = make_tmp_path();
  const project = parse_project_fresh(FORMAT_DIR.div("avi", "base.aep"));
  const om = _om(project);
  as_instance(om.format_options, XmlFormatOptions).video_codec = VideoCodec.V210;
  expect(om.settings.get("Depth")).toBe(OutputColorDepth.TRILLIONS_OF_COLORS);
  // Rouu.video_codec stays the constant AVI plugin tag: AE never
  // varies it with the selected codec (corpus-verified).
  expect(om._roou.video_codec).toBe("CTXF");
  project.save(tmp_path.div("out.aep"));
  const om2 = _om(parse_project_fresh(tmp_path.div("out.aep")));
  expect(as_instance(om2.format_options, XmlFormatOptions).video_codec).toBe(VideoCodec.V210);
  expect(om2._roou.video_codec).toBe("CTXF");
  expect(om2.settings.get("Depth")).toBe(OutputColorDepth.TRILLIONS_OF_COLORS);
});

test("test_3gpp_multiplexer_clamps_audio_format", () => {
  const project = parse_project_fresh(FORMAT_DIR.div("h.264", "audio_format_mpeg.aep"));
  const fo = as_instance(_om(project).format_options, XmlFormatOptions);
  expect(fo.mpeg_audio_format).toBe(MPEGAudioFormat.MPEG);
  fo.mpeg_multiplexer = MPEGMultiplexer.THREEGPP;
  expect(fo.mpeg_audio_format).toBe(MPEGAudioFormat.AAC);
});

test("test_targa_bits_not_coupled_to_channels", () => {
  /**
   * bits_per_pixel is a dialog-local byte AE leaves stale: RGB+Alpha
   * with 24 bpp exists in AE-saved files (tga_rgba.aep), so channel
   * writes neither clamp nor gate it.
   */
  const tmp_path = make_tmp_path();
  const project = parse_project_fresh(FORMAT_DIR.div("targa", "24_bits_per_pixel.aep"));
  const om = _om(project);
  om.settings.set("Channels", OutputChannels.RGBA);
  expect(as_instance(om.format_options, TargaFormatOptions).bits_per_pixel).toBe(24); // untouched, like AE
  expect(om.settings.get("Depth")).toBe(OutputColorDepth.MILLIONS_OF_COLORS_PLUS);
  as_instance(om.format_options, TargaFormatOptions).bits_per_pixel = 32; // both values stay writable
  project.save(tmp_path.div("out.aep"));
  const om2 = _om(parse_project_fresh(tmp_path.div("out.aep")));
  expect(as_instance(om2.format_options, TargaFormatOptions).bits_per_pixel).toBe(32);
  expect(om2.settings.get("Depth")).toBe(OutputColorDepth.MILLIONS_OF_COLORS_PLUS);
});

test("test_raw_params_escape_hatch_bypasses_rules", () => {
  // Documented: the params dict is the low-level escape hatch.
  const project = parse_project_fresh(FORMAT_DIR.div("mp3", "base.aep"));
  const fo = as_instance(_om(project).format_options, XmlFormatOptions);
  fo.params.set("BitRate", "999");
  expect(fo.bitrate).toBe(999);
});
