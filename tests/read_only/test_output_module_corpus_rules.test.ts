/**
 * Corpus self-validation: AE-written files must satisfy our own tables.
 *
 * This is the independent oracle for the rules data: every value AE itself
 * stored must be inside the allowed set our tables claim for it. A failure
 * here means a wrong or too-narrow table row, not a bad file (this is how
 * the MP3 mono/stereo column swap and the Targa RGB+32bpp case were
 * caught).
 */

import { expect, test } from "bun:test";
import { asInstance, parseApp, SAMPLES_DIR } from "../helpers.ts";
import { RenderQueue } from "../../src/py_aep/models/renderqueue/render_queue.ts";
import { Path, pyEq, sorted } from "../../src/pyrt/index.ts";

const _CORPUS_ROOTS = [
  SAMPLES_DIR.div("models", "format_options"),
  SAMPLES_DIR.div("models", "renderqueue"),
  SAMPLES_DIR.div("unused", "output_module"),
  SAMPLES_DIR.div("unused", "output_module_settings"),
  SAMPLES_DIR.div("unused", "renderqueue"),
  SAMPLES_DIR.div("unused", "models", "renderqueue"),
];

const _CORPUS: Path[] = sorted(
  _CORPUS_ROOTS.filter((root) => root.isDir()).flatMap((root) => root.rglob("*.aep")),
  (path: Path) => path.parts,
);

// pytest `ids=` are sample paths relative to SAMPLES_DIR; carried as the `%s` row label.
const _SAMPLES_PREFIX = `${String(SAMPLES_DIR)}/`;
test.each(_CORPUS.map((p) => [String(p).slice(_SAMPLES_PREFIX.length), p] as const))("test_ae_written_state_passes_our_tables[%s]", (_id: string, aepPath: Path) => {
  const app = parseApp(aepPath);
  for (const rqi of asInstance(app.project.renderQueue, RenderQueue).items) {
    for (const om of rqi.outputModules) {
      expect(pyEq(om.validateState(), [])).toBe(true);
    }
  }
});
