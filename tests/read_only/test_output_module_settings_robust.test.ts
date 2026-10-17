/**
 * Output module settings must decode on every AE-written sample.
 *
 * Real files can hold values outside our enums (unknown format ids from
 * third-party plugins). The binary is trusted: every read falls back to the
 * raw value instead of raising.
 */

import { expect, test } from "bun:test";
import { as_instance, parse_app, SAMPLES_DIR } from "../helpers.ts";
import { GetSettingsFormat, OutputColorDepth } from "../../src/py_aep/enums/index.ts";
import { RenderQueue } from "../../src/py_aep/models/renderqueue/render_queue.ts";
import { CineonFormatOptions, JpegFormatOptions, OpenExrFormatOptions, PngFormatOptions } from "../../src/py_aep/models/renderqueue/format_options/index.ts";
import { Path, sorted } from "../../src/pyrt/index.ts";

const _CORPUS_ROOTS = [
  SAMPLES_DIR.div("models", "format_options"),
  SAMPLES_DIR.div("models", "renderqueue"),
  SAMPLES_DIR.div("unused", "output_module"),
  SAMPLES_DIR.div("unused", "output_module_settings"),
];

const _CORPUS: Path[] = sorted(
  _CORPUS_ROOTS.filter((root) => root.is_dir()).flatMap((root) => root.rglob("*.aep")),
  (path: Path) => path.parts,
);

/** pytest `ids=[str(p.relative_to(SAMPLES_DIR)) for p in _CORPUS]` */
const _IDS = _CORPUS.map((p) => p.path.slice(SAMPLES_DIR.path.length + 1));

test.each(_CORPUS.map((p, i) => [_IDS[i], p] as const))("test_settings_and_format_options_reads_never_raise[%s]", (_id: string, aep_path: Path) => {
  const app = parse_app(aep_path);
  for (const rqi of as_instance(app.project.render_queue, RenderQueue).items) {
    for (const om of rqi.output_modules) {
      om.get_settings(GetSettingsFormat.STRING);
      om.get_settings(GetSettingsFormat.NUMBER);
      const fo = om.format_options;
      if (fo instanceof CineonFormatOptions) {
        void fo.file_format;
      } else if (fo instanceof JpegFormatOptions) {
        void fo.format_type;
      } else if (fo instanceof OpenExrFormatOptions) {
        void [fo.compression, fo.dwa_compression_level];
      } else if (fo instanceof PngFormatOptions) {
        void [fo.compression, fo.color_primaries];
      }
    }
  }
});

test.each(_CORPUS.map((p, i) => [_IDS[i], p] as const))("test_rouu_depth_and_frame_rate_decode[%s]", (_id: string, aep_path: Path) => {
  // Every AE-written `Rouu` holds a listed depth and a positive output
  // frame rate, including the 29.97 fps modules whose rate fraction sits
  // right before the depth.
  const app = parse_app(aep_path);
  for (const rqi of as_instance(app.project.render_queue, RenderQueue).items) {
    for (const om of rqi.output_modules) {
      expect(OutputColorDepth.has(om._roou.depth)).toBe(true);
      expect(om._roou.frame_rate > 0).toBe(true);
    }
  }
});
