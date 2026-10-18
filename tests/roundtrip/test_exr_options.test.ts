/**
 * Imported OpenEXR footage carries After Effects' `oEXR` options header.
 *
 * `exr_options.aep` is AE 2026's own scripted import (Windows) of every
 * `samples/assets/exr/*.exr` - tiny uncompressed files that each vary one
 * property: channels, layers, pixel type, data window - plus
 * `samples/assets/exr/seq` as a sequence named "seq_inside"
 * (`scripts/jsx/generate_exr_options_sample.jsx`). `footage_depth.aep` adds the
 * two repo EXRs, one of them multi-part.
 *
 * Without the header AE places a data window that differs from the display
 * window wrongly when it renders, and one larger than the display window
 * crashed AE's render (AE 2026).
 */

import "../../src/py_aep/binary/_register.ts";
import * as fs from "node:fs";
import { expect, test } from "bun:test";
import { bytes_, getitem, len, Path, py_eq, sorted } from "../../src/pyrt/index.ts";
import { make_tmp_path } from "../../src/pyrt/pytest.ts";
import { as_instance, parse_project } from "../helpers.ts";
import { parse as parse_aep } from "../../src/py_aep/index.ts";
import { FootageItem } from "../../src/py_aep/models/items/footage.ts";
import { FileSource } from "../../src/py_aep/models/sources/file.ts";
import { ImportOptions } from "../../src/py_aep/models/import_options.ts";

const SAMPLES = new Path(import.meta.dir, "..", "..", "samples");
const ASSETS = SAMPLES.div("assets");
const BASE = SAMPLES.div("models", "folder", "folder.aep");
const FIXTURES = [
  SAMPLES.div("models", "import", "exr_options.aep"),
  SAMPLES.div("models", "import", "footage_depth.aep"),
];

function _ae_optis(): Map<string, Uint8Array> {
  const optis = new Map<string, Uint8Array>();
  for (const fixture of FIXTURES) {
    for (const item of parse_project(fixture).footages) {
      if (item.name.endsWith(".exr") || item.name === "seq_inside") {
        optis.set(item.name, item.main_source._opti.tobytes());
      }
    }
  }
  return optis;
}

function _import(name: string): Uint8Array {
  const project = parse_aep(BASE, { platform: "windows" }).project;
  let options: ImportOptions;
  if (name === "seq_inside") {
    options = new ImportOptions(ASSETS.div("exr", "seq", "inside.0001.exr"));
    options.sequence = true;
  } else {
    const path = ASSETS.div("exr", name);
    options = new ImportOptions(path.exists() ? path : ASSETS.div(name));
  }
  return as_instance(project.import_file(options), FootageItem).main_source._opti.tobytes();
}

const _NAMES = sorted(_ae_optis().keys());

test.each(_NAMES)("test_import_writes_after_effects_exr_header[%#]", (name: string) => {
  const ae = getitem(_ae_optis(), name);
  const ours = _import(name);
  expect(len(ours)).toBe(len(ae));
  expect(len(ae)).toBe(9750);
  // Magic, length, compression (0x0E), channel count across parts (0x12)
  // and channels + named layers (0x2E).
  expect(py_eq(bytes_.slice(ours, 0, 0x30), bytes_.slice(ae, 0, 0x30))).toBe(true);
  // AE's remaining bytes vary from import to import; zeros render the same.
  expect(py_eq(bytes_.slice(ours, 0x30), new Uint8Array(len(ours) - 0x30))).toBe(true);
});

test("test_alpha_is_premultiplied_with_its_flag", () => {
  /**
   * AE interprets an EXR's alpha as premultiplied and sets the sspc flag
   * bit that goes with that mode; without it AE resets the footage to
   * straight alpha when it opens the project.
   */
  const ae_item = parse_project(FIXTURES[0]).footages.find((item) => item.name === "rgba_full.exr");
  if (ae_item === undefined) throw new Error("StopIteration");
  const ae = ae_item.main_source._sspc;
  const project = parse_aep(BASE, { platform: "windows" }).project;
  const ours = as_instance(project.import_file(new ImportOptions(ASSETS.div("exr", "rgba_full.exr"))), FootageItem);
  const sspc = ours.main_source._sspc;
  expect(py_eq([sspc.alpha_mode_raw, sspc._alpha_flags], [ae.alpha_mode_raw, ae._alpha_flags])).toBe(true);
  expect(py_eq([ae.alpha_mode_raw, ae._alpha_flags], [1, 1])).toBe(true);
});

test("test_reload_refreshes_the_exr_header", () => {
  const tmp_path = make_tmp_path();
  const media = tmp_path.div("frame.exr");
  fs.copyFileSync(ASSETS.div("exr", "rgb_inside.exr").toString(), media.toString());
  const project = parse_aep(BASE, { platform: "windows" }).project;
  const item = as_instance(project.import_file(new ImportOptions(media)), FootageItem);
  fs.copyFileSync(ASSETS.div("exr", "layered.exr").toString(), media.toString());
  as_instance(item.main_source, FileSource).reload();
  expect(
    py_eq(
      bytes_.slice(item.main_source._opti.tobytes(), 0, 0x30),
      bytes_.slice(getitem(_ae_optis(), "layered.exr"), 0, 0x30),
    ),
  ).toBe(true);
});
