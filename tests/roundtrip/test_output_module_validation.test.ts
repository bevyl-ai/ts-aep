/**
 * Format-dependent validation of output-module settings writes.
 *
 * Reject cases assert `ValueError` on values AE's dialog never offers for
 * the format; accept cases write an allowed value and verify it survives a
 * save + fresh reparse (including the clamp side effects).
 */

import { expect, test } from "bun:test";

import { asInstance, parseProjectFresh } from "../helpers.ts";
import { OutputAudio, OutputChannels, OutputColorDepth, OutputColorMode } from "../../src/py_aep/enums/index.ts";
import type { Project } from "../../src/py_aep/models/project.ts";
import type { OutputModule } from "../../src/py_aep/models/renderqueue/output_module.ts";
import { RenderQueue } from "../../src/py_aep/models/renderqueue/render_queue.ts";
import type { SettingValue } from "../../src/py_aep/models/renderqueue/settings.ts";
import { Path, assert, valueEquals, ValueError } from "../../src/pyrt/index.ts";
import { makeTmpPath, raises } from "../support/pytest.ts";


const RQ_DIR = new Path(import.meta.dir).parent.parent.div("samples").div("models").div("renderqueue");

function _om(project: Project): OutputModule {
  return asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0];
}

const REJECTS: [string, string, SettingValue][] = [
  // (sample, key, value) - corruption-preventing rows first: turning
  // video on for an audio format writes comp dimensions into the Rouu.
  ["format_mp3", "Video Output", true],
  ["format_wav", "Video Output", true],
  ["format_aiff", "Output Audio", OutputAudio.OFF],
  ["format_mp3", "Output Audio", OutputAudio.AUTO],
  ["format_tiff_sequence", "Video Output", false],
  ["format_png_sequence", "Output Audio", OutputAudio.ON],
  ["format_png_sequence", "Depth", OutputColorDepth.FLOATING_POINT],
  ["format_openexr_sequence", "Depth", OutputColorDepth.MILLIONS_OF_COLORS],
  ["format_jpeg_sequence", "Channels", OutputChannels.RGBA],
  ["format_jpeg_sequence", "Depth", OutputColorDepth.TRILLIONS_OF_COLORS],
  ["format_radiance_sequence", "Channels", OutputChannels.RGBA],
  ["format_radiance_sequence", "Depth", OutputColorDepth.MILLIONS_OF_COLORS],
  ["format_targa_sequence", "Depth", OutputColorDepth.TRILLIONS_OF_COLORS],
  ["format_dpx_cineon_sequence", "Depth", OutputColorDepth.MILLIONS_OF_COLORS],
  ["format_sgi_sequence", "Depth", OutputColorDepth.FLOATING_POINT],
  ["format_h264", "Channels", OutputChannels.RGBA],
  ["format_h264", "Depth", OutputColorDepth.TRILLIONS_OF_COLORS],
  ["format_h264", "Audio Sample Rate", 8000],
  ["format_quicktime", "Depth", OutputColorDepth.FLOATING_POINT],
  ["format_aiff", "Audio Sample Rate", 24000],
  ["format_mp3", "Audio Sample Rate", 88200],
  ["format_mp3", "Audio Bit Depth", 4], // 32-bit; MP3 is locked to 16
];

// `pytest.mark.parametrize(..., ids=[...])`: bun's `%#` row index stands in
// for the Python ids (`f"{s}-{k}-{v}"`).
// NOTE(port): ids only name the test row; the parametrized rows and assertions are identical to Python.
test.each(REJECTS)("test_disallowed_write_raises[%#]", (sample: string, key: string, value: SettingValue) => {
  const project = parseProjectFresh(RQ_DIR.div(`${sample}.aep`));
  const om = _om(project);
  const before = om.getSettings();
  raises(ValueError, () => {
    om.settings.set(key, value);
  });
  // NOTE(port): py_assert carries the same assert message as the Python original.
  assert(valueEquals(om.getSettings(), before), "rejected write must not mutate");
});

// NOTE: the samples store RGB channels, so only base (non-`+`) depths
// are writable - the channels<->depth parity rows mirror AE's dialog,
// which offers `+` depths only under RGB+Alpha.
const ACCEPTS: [string, string, SettingValue][] = [
  ["format_tiff_sequence", "Depth", OutputColorDepth.FLOATING_POINT],
  ["format_sgi_sequence", "Depth", OutputColorDepth.TRILLIONS_OF_COLORS],
  ["format_iff_sequence", "Depth", OutputColorDepth.TRILLIONS_OF_COLORS],
  ["format_aiff", "Audio Sample Rate", 96000],
  ["format_wav", "Audio Sample Rate", 8000],
  ["format_avi", "Audio Sample Rate", 96000],
  ["format_h264", "Audio Sample Rate", 44100],
  // The sample stores bitrate 128 + stereo, which resolves 44100.
  ["format_mp3", "Audio Sample Rate", 44100],
  ["format_quicktime", "Depth", OutputColorDepth.TRILLIONS_OF_COLORS],
  ["format_photoshop_sequence", "Depth", OutputColorDepth.FLOATING_POINT],
];

/** QT alpha is AE-legal: the factory template "High Quality with
 * Alpha" writes a QT Rouu with depth 32 (millions+). */
test("test_quicktime_supports_alpha", () => {
  const tmpPath = makeTmpPath();
  const project = parseProjectFresh(
    new Path(import.meta.dir)
      .parent.parent.div("samples")
      .div("models")
      .div("format_options")
      .div("quicktime")
      .div("apple_prores_4444.aep"),
  );
  const om = asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0];
  om.settings.set("Channels", OutputChannels.RGBA);
  expect(om.settings.get("Depth")).toBe(OutputColorDepth.MILLIONS_OF_COLORS_PLUS);
  project.save(tmpPath.div("out.aep"));
  const om2 = _om(parseProjectFresh(tmpPath.div("out.aep")));
  expect(om2.settings.get("Channels")).toBe(OutputChannels.RGBA);
  expect(om2.settings.get("Depth")).toBe(OutputColorDepth.MILLIONS_OF_COLORS_PLUS);
  expect(valueEquals(om2.validateState(), [])).toBe(true);
});

/** AE offers `+` depths only under RGB+Alpha (parity rows). */
test("test_plus_depth_requires_rgba_channels", () => {
  const project = parseProjectFresh(RQ_DIR.div("format_photoshop_sequence.aep"));
  const om = _om(project);
  raises(ValueError, () => {
    om.settings.set("Depth", OutputColorDepth.FLOATING_POINT_PLUS); // RGB module
  });
  om.settings.set("Channels", OutputChannels.RGBA);
  om.settings.set("Depth", OutputColorDepth.FLOATING_POINT_PLUS);
  raises(ValueError, () => {
    om.settings.set("Depth", OutputColorDepth.FLOATING_POINT); // base under RGBA
  });
});

test.each(ACCEPTS)("test_allowed_write_survives_roundtrip[%#]", (sample: string, key: string, value: SettingValue) => {
  const tmpPath = makeTmpPath();
  const project = parseProjectFresh(RQ_DIR.div(`${sample}.aep`));
  const om = _om(project);
  om.settings.set(key, value);
  expect(om.settings.get(key)).toBe(value);
  project.save(tmpPath.div("out.aep"));
  const reparsed = parseProjectFresh(tmpPath.div("out.aep"));
  expect(_om(reparsed).settings.get(key)).toBe(value);
});

/** Switching PNG to RGB+Alpha forces Straight and the +alpha depth. */
test("test_png_rgba_clamps_color_straight", () => {
  const tmpPath = makeTmpPath();
  const project = parseProjectFresh(RQ_DIR.div("format_png_sequence.aep"));
  const om = _om(project);
  om.settings.set("Color", OutputColorMode.PREMULTIPLIED); // inert while RGB
  om.settings.set("Channels", OutputChannels.RGBA);
  expect(om.settings.get("Color")).toBe(OutputColorMode.STRAIGHT_UNMATTED);
  expect(om.settings.get("Depth")).toBe(OutputColorDepth.MILLIONS_OF_COLORS_PLUS);
  project.save(tmpPath.div("out.aep"));
  const om2 = _om(parseProjectFresh(tmpPath.div("out.aep")));
  expect(om2.settings.get("Channels")).toBe(OutputChannels.RGBA);
  expect(om2.settings.get("Color")).toBe(OutputColorMode.STRAIGHT_UNMATTED);
  expect(om2.settings.get("Depth")).toBe(OutputColorDepth.MILLIONS_OF_COLORS_PLUS);
});

test("test_exr_rgba_clamps_color_premultiplied", () => {
  const tmpPath = makeTmpPath();
  const project = parseProjectFresh(RQ_DIR.div("format_openexr_sequence.aep"));
  const om = _om(project);
  om.settings.set("Color", OutputColorMode.STRAIGHT_UNMATTED); // inert while RGB
  om.settings.set("Channels", OutputChannels.RGBA);
  expect(om.settings.get("Color")).toBe(OutputColorMode.PREMULTIPLIED);
  expect(om.settings.get("Depth")).toBe(OutputColorDepth.FLOATING_POINT_PLUS);
  project.save(tmpPath.div("out.aep"));
  const om2 = _om(parseProjectFresh(tmpPath.div("out.aep")));
  expect(om2.settings.get("Color")).toBe(OutputColorMode.PREMULTIPLIED);
  expect(om2.settings.get("Depth")).toBe(OutputColorDepth.FLOATING_POINT_PLUS);
});

test("test_rgba_color_write_rejected_after_clamp", () => {
  const project = parseProjectFresh(RQ_DIR.div("format_png_sequence.aep"));
  const om = _om(project);
  om.settings.set("Channels", OutputChannels.RGBA);
  raises(ValueError, () => {
    om.settings.set("Color", OutputColorMode.PREMULTIPLIED);
  });
});

/**
 * Video-section side effects must not write dims into an audio Rouu.
 *
 * The Video Output gate blocks the direct write; the crop/resize/ROI
 * post_set hooks used to bypass it by writing comp dimensions (which
 * ARE the video-output flag) into the audio-only Rouu.
 */
test("test_crop_resize_roi_writes_keep_audio_module_audio_only", () => {
  const project = parseProjectFresh(RQ_DIR.div("format_mp3.aep"));
  const om = _om(project);
  om.settings.set("Crop", true);
  om.settings.set("Crop Left", 10);
  om.settings.set("Use Region of Interest", true);
  om.settings.set("Resize", false);
  expect(om.settings.get("Video Output")).toBe(false);
  expect(valueEquals([om._roou.width, om._roou.height], [0, 0])).toBe(true);
  expect(valueEquals(om.validateState(), [])).toBe(true);
  raises(ValueError, () => {
    om.settings.set("Resize to", [1280, 720]);
  });
});

/**
 * An out-of-enum stored byte degrades permissively, never raises.
 *
 * OutputChannels has no from_binary fallback, so a garbage channels
 * byte makes the descriptor read raise; the context builder, clamps
 * and validate_state must treat that as "unclean -> skip" instead of
 * propagating (permissive-degradation contract).
 */
test("test_garbage_channels_byte_stays_permissive", () => {
  const project = parseProjectFresh(RQ_DIR.div("format_png_sequence.aep"));
  const om = _om(project);
  om._omLdat.channels = 7; // not a valid OutputChannels member
  om.settings.set("Depth", OutputColorDepth.TRILLIONS_OF_COLORS); // no raise
  om.settings.set("Audio Channels", om.settings.get("Audio Channels")); // clamp path
  expect(valueEquals(om.validateState(), [])).toBe(true);
});
