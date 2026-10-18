/** Typed XML-param accessors on XmlFormatOptions (context accessors).
 *
 * Decode is checked against AE-saved samples; writes are verified through
 * a save + fresh reparse.
 */

import { expect, test } from "bun:test";

import { getattr, Path, assert, setattr, ValueError } from "../../src/pyrt/index.ts";
import { makeTmpPath, raises } from "../../src/pyrt/pytest.ts";
import { asInstance, parseProjectFresh } from "../helpers.ts";
import type { Project } from "../../src/py_aep/models/project.ts";
import { XmlFormatOptions } from "../../src/py_aep/models/renderqueue/format_options/xml.ts";

import { AudioInterleave, MPEGAudioFormat, MPEGAudioLayer } from "../../src/py_aep/enums/index.ts";

// `Path(__file__).parent.parent.parent`: `import.meta.dir` is this file's
// directory (tests/roundtrip), so two `.parent` reach the package root.
const FORMAT_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "format_options");

function _fo(project: Project): XmlFormatOptions {
  assert(project.renderQueue != null);
  return asInstance(project.renderQueue.items[0].outputModules[0].formatOptions, XmlFormatOptions);
}

const DECODES: [string, string, unknown][] = [
  ["mp3/base", "bitrate", 128],
  ["mp3/base", "audioInterleave", null], // MP3 stores no interleave
  ["avi/audio_interleave_1_frame", "audioInterleave", AudioInterleave.ONE_FRAME],
  ["avi/audio_interleave_half_second", "audioInterleave", AudioInterleave.HALF_SECOND],
  ["avi/audio_interleave_1_second", "audioInterleave", AudioInterleave.ONE_SECOND],
  ["avi/audio_interleave2_seconds", "audioInterleave", AudioInterleave.TWO_SECONDS],
  ["avi/audio_interleave_none", "audioInterleave", null], // None = param absent
  ["h.264/base", "mpegAudioFormat", MPEGAudioFormat.AAC],
  ["h.264/audio_format_mpeg", "mpegAudioFormat", MPEGAudioFormat.MPEG],
  ["h.264/audio_format_pcm", "mpegAudioFormat", MPEGAudioFormat.PCM],
  ["h.264/audio_format_mpeg_layer_II", "mpegAudioLayer", MPEGAudioLayer.LAYER_II],
  ["h.264/base", "audioBitrate", 128],
  ["h.264/audio_codec_aac+_version_2", "audioBitrate", 64],
  ["h.264/base", "profile", 1],
  ["h.264/base", "level", 41],
  ["quicktime/dnxhr_dnxhd", "resolution", 1017],
  ["quicktime/base", "resolution", null],
];

for (const [sample, attr, expected] of DECODES) {
  test(`test_decode[${sample}-${attr}]`, () => {
    const project = parseProjectFresh(FORMAT_DIR.div(`${sample}.aep`));
    expect(getattr(_fo(project), attr)).toBe(expected);
  });
}

const WRITES: [string, string, unknown][] = [
  ["mp3/base", "bitrate", 320],
  ["avi/base", "audioInterleave", AudioInterleave.ONE_SECOND],
  ["h.264/base", "audioBitrate", 192],
  ["h.264/base", "level", 32],
];

for (const [sample, attr, value] of WRITES) {
  test(`test_write_survives_roundtrip[${sample}-${attr}]`, () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(FORMAT_DIR.div(`${sample}.aep`));
    setattr(_fo(project), attr, value);
    expect(getattr(_fo(project), attr)).toBe(value);
    project.save(tmpPath.div("out.aep"));
    const reparsed = parseProjectFresh(tmpPath.div("out.aep"));
    expect(getattr(_fo(reparsed), attr)).toBe(value);
  });
}

test("test_scalar_write_rejects_non_int", () => {
  const project = parseProjectFresh(FORMAT_DIR.div("mp3", "base.aep"));
  raises(TypeError, () => {
    _fo(project).bitrate = "320";
  });
});

test("test_scalar_write_rejects_bool", () => {
  // bool is an int subclass; str(True) would corrupt the XML param.
  const project = parseProjectFresh(FORMAT_DIR.div("mp3", "base.aep"));
  raises(TypeError, () => {
    // @ts-expect-error bitrate takes an int; the setter rejects a bool at runtime
    _fo(project).bitrate = true;
  });
});

test("test_enum_param_write_rejects_bad_member", () => {
  const project = parseProjectFresh(FORMAT_DIR.div("avi", "base.aep"));
  raises(ValueError, () => {
    _fo(project).audioInterleave = 99;
  });
});
