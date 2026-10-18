import "../../src/py_aep/binary/_register.ts";
import * as fs from "node:fs";
import { expect, test } from "bun:test";
import { bytes_, fspath, getitem, lshift, Path, py_eq, sorted, StopIteration, PureWindowsPath } from "../../src/pyrt/index.ts";
import { make_tmp_path } from "../../src/pyrt/pytest.ts";
import { as_instance, parse_project } from "../helpers.ts";
import { ImportAsType, parse as parse_aep } from "../../src/py_aep/index.ts";
import { ImportOptions } from "../../src/py_aep/models/import_options.ts";
import { FileSource } from "../../src/py_aep/models/sources/file.ts";
import type { Project } from "../../src/py_aep/models/project.ts";
import { FootageItem } from "../../src/py_aep/models/items/footage.ts";

/**
 * Imported footage caches After Effects' input depth and alpha in `sspc`.
 *
 * `footage_depth.aep` is AE 2026's own scripted import (Windows) of every asset
 * under `samples/assets` and `samples/assets/depth`, each item named after its
 * file, plus the layered-file comps of `_COMP_FILES`
 * (`scripts/jsx/generate_footage_depth_sample.jsx`). py_aep imports the same
 * files and must cache the same depth (`sspc` 0x3E), the `01 01` that follows
 * it, and the same alpha interpretation - AE does not re-read most formats on
 * open, so a wrong cached depth renders without alpha.
 */

const SAMPLES = new Path(import.meta.dir, "..", "..", "samples");
const ASSETS = SAMPLES.div("assets");
const BASE = SAMPLES.div("models", "folder", "folder.aep");
const FIXTURE = SAMPLES.div("models", "import", "footage_depth.aep");

const _COMP_FILES = [
  "depth/psd_rgb8_bg_layer.psd",
  "depth/psd_rgb16_bg_layer.psd",
  "depth/psd_gray8_layered.psd",
  "layer_bounds.psd",
  "psd_layer_styles.psd",
  "psd_noise_gradient_32bpc.psd",
  "ai.ai",
];

/** AE's whole-file footage, by file name (layer items carry a `/`). */
function _ae_sources(): Map<string, FileSource> {
  const sources = new Map<string, FileSource>();
  for (const item of parse_project(FIXTURE).footages) {
    if (!item.name.includes("/") && item.mainSource instanceof FileSource) {
      sources.set(item.name, item.mainSource);
    }
  }
  return sources;
}

/** AE's layer-bound footage of `file_name`, by layer index. */
function _ae_layer_sources(file_name: string): Map<number, FileSource> {
  const sources = new Map<number, FileSource>();
  for (const item of parse_project(FIXTURE).footages) {
    const source = item.mainSource;
    if (
      item.name.endsWith("/" + file_name) &&
      source instanceof FileSource &&
      source._sspc.layer_index !== 0xffffffff
    ) {
      sources.set(source._sspc.layer_index, source);
    }
  }
  return sources;
}

/** A fresh project that imports the way AE on Windows (the fixture's) does. */
function _windows_project(): Project {
  return parse_aep(BASE, { platform: "windows" }).project;
}

function _asset(name: string): Path {
  const path = ASSETS.div(name);
  return path.exists() ? path : ASSETS.div("depth", name);
}

/**
 * `sspc` 0x3E-0x44 (depth, `01 01`, 3 zero bytes) and whether the source
 * has alpha. (The alpha *mode* AE picks for an RGBA DPX differs between AE
 * on macOS and on Windows, so it is not compared here.)
 */
function _depth_bytes(source: FileSource): [Uint8Array, boolean] {
  return [bytes_.slice(source._sspc.tobytes(), 0x3e, 0x45), source.hasAlpha];
}

test.each(sorted(_ae_sources().keys()))("test_import_caches_after_effects_depth[%#]", (name) => {
  const project = _windows_project();
  const item = as_instance(project.importFile(new ImportOptions(_asset(name))), FootageItem);
  const ae = getitem(_ae_sources(), name);
  expect(as_instance(item.mainSource, FileSource)._sspc.depth).toBe(ae._sspc.depth);
  expect(py_eq(_depth_bytes(as_instance(item.mainSource, FileSource)), _depth_bytes(ae))).toBe(true);
});

test.each(_COMP_FILES)("test_layered_comp_import_caches_after_effects_depth[%#]", (comp_file) => {
  const project = _windows_project();
  const options = new ImportOptions(ASSETS.div(comp_file));
  options.importAs = ImportAsType.COMP;
  project.importFile(options);
  const file_name = new Path(comp_file).name;
  const ours = new Map<number, FileSource>();
  for (const item of project.footages) {
    const source = item.mainSource;
    if (
      source instanceof FileSource &&
      new PureWindowsPath(source.file).name === file_name &&
      source._sspc.layer_index !== 0xffffffff
    ) {
      ours.set(source._sspc.layer_index, source);
    }
  }
  const ae = _ae_layer_sources(file_name);
  expect(py_eq(sorted(ours.keys()), sorted(ae.keys()))).toBe(true);
  for (const [index, source] of ours.entries()) {
    expect(py_eq(_depth_bytes(source), _depth_bytes(getitem(ae, index)))).toBe(true);
    // The layer's content box at its own channel count (colour channels,
    // plus one when it has transparency - not for a Background layer).
    expect(py_eq(source._sspc.data_size, getitem(ae, index)._sspc.data_size)).toBe(true);
  }
});

test("test_chosen_background_layer_is_opaque", () => {
  // A "Choose Layer" import binds the same layer source as a comp import.
  const ae = _ae_layer_sources("psd_rgb8_bg_layer.psd");
  const project = _windows_project();
  const options = new ImportOptions(ASSETS.div("depth", "psd_rgb8_bg_layer.psd"));
  options.layerIndex = 1; // list_layers order is top first: the Background
  const item = as_instance(project.importFile(options), FootageItem);
  const source = as_instance(item.mainSource, FileSource);
  expect(py_eq(_depth_bytes(source), _depth_bytes(getitem(ae, source._sspc.layer_index)))).toBe(true);
  expect(py_eq(source._sspc.data_size, getitem(ae, source._sspc.layer_index)._sspc.data_size)).toBe(true);
  expect(source.hasAlpha).toBe(false);
});

test("test_sequence_caches_the_frame_depth", () => {
  // AE stores a sequence with its frames' depth (media_gap_formats.aep,
  // AE 2026 macOS: the 10-bit DPX sequence is 48 like its frames).
  const truth = new Map(
    parse_project(SAMPLES.div("models", "import", "media_gap_formats.aep")).footages.map(
      (f) => [f.name, f.mainSource] as const,
    ),
  );
  const project = _windows_project();
  const options = new ImportOptions(ASSETS.div("dpx_seq.0001.dpx"));
  options.sequence = true;
  const item = as_instance(project.importFile(options), FootageItem);
  const main_source = as_instance(item.mainSource, FileSource);
  expect(py_eq(_depth_bytes(main_source), _depth_bytes(as_instance(getitem(truth, item.name), FileSource)))).toBe(true);
  expect(main_source._sspc.depth).toBe(48);
});

test("test_reload_refreshes_the_depth", () => {
  const tmp_path = make_tmp_path();
  const media = tmp_path.div("frame.png");
  fs.copyFileSync(fspath(ASSETS.div("depth", "png_rgb8.png")), fspath(media));
  const project = _windows_project();
  const item = as_instance(project.importFile(new ImportOptions(media)), FootageItem);
  const main_source = as_instance(item.mainSource, FileSource);
  expect(main_source._sspc.depth).toBe(24);
  fs.copyFileSync(fspath(ASSETS.div("depth", "png_rgba16.png")), fspath(media));
  main_source.reload();
  expect(main_source._sspc.depth).toBe(64);
  expect(main_source.hasAlpha).toBe(true);
});

test.each(sorted(_ae_sources().keys()))("test_import_sets_after_effects_media_flags[%#]", (name) => {
  // Bit 3 of sspc 0x70 and 0x9F: AE sets both for JPEG, BMP/GIF, HEIC,
  // movie, audio and data files, neither for the other formats.
  const project = _windows_project();
  const ours = as_instance(project.importFile(new ImportOptions(_asset(name))), FootageItem).mainSource._sspc.tobytes();
  const ae = getitem(_ae_sources(), name)._sspc.tobytes();
  expect(py_eq([ours[0x70], ours[0x9f]], [ae[0x70], ae[0x9f]])).toBe(true);
});

test("test_sequence_sets_only_the_first_media_flag", () => {
  // AE 2026 (macOS) imports a GIF sequence with 0x70 bit 3 set and 0x9F
  // bit 3 clear (imio_sequence.aep).
  const truth = parse_project(SAMPLES.div("models", "import", "imio_sequence.aep"));
  const ae_item = truth.footages.find((f) => as_instance(f.mainSource, FileSource)._target_is_folder);
  if (ae_item == null) throw new StopIteration();
  const ae = as_instance(ae_item.mainSource, FileSource);
  const project = parse_aep(BASE, { platform: "macos" }).project;
  const options = new ImportOptions(ASSETS.div("sequence_001.gif"));
  options.sequence = true;
  const ours = as_instance(project.importFile(options), FootageItem).mainSource._sspc.tobytes();
  expect(py_eq([ours[0x70], ours[0x9f]], [0x08, 0x00])).toBe(true);
  expect(py_eq([ours[0x70], ours[0x9f]], [ae._sspc.tobytes()[0x70], ae._sspc.tobytes()[0x9f]])).toBe(true);
});

test.each(sorted(_ae_sources().keys()))("test_import_caches_after_effects_data_size[%#]", (name) => {
  // The file size for most formats; the decoded pixel buffer for TIFF
  // stills and merged PSD footage (w * h * channels * bytes per channel,
  // counting alpha only when the image has it: 2 for gray + alpha).
  const project = _windows_project();
  const item = as_instance(project.importFile(new ImportOptions(_asset(name))), FootageItem);
  expect(py_eq(item.mainSource._sspc.data_size, getitem(_ae_sources(), name)._sspc.data_size)).toBe(true);
});

test("test_data_size_above_32_bits_round_trips", () => {
  const tmp_path = make_tmp_path();
  const project = _windows_project();
  const item = as_instance(project.importFile(new ImportOptions(ASSETS.div("depth", "png_rgb8.png"))), FootageItem);
  item.mainSource._sspc.data_size = lshift(5, 30);
  const out = tmp_path.div("big.aep");
  project.save(out);
  const reread = as_instance(getitem(parse_aep(out).project.items, item.id), FootageItem);
  expect(py_eq(reread.mainSource._sspc.data_size, lshift(5, 30))).toBe(true);
});

test("test_hq_field_separation_keeps_the_container_media_bit", () => {
  // AE sets bit 3 of sspc 0x9F on container media; the HQ flag is bit 0.
  const tmp_path = make_tmp_path();
  const project = parse_aep(FIXTURE).project;
  const item = project.footages.find((f) => f.name === "mov_480.mov");
  if (item == null) throw new StopIteration();
  expect(item.mainSource._sspc.tobytes()[0x9f]).toBe(0x08);
  item.mainSource.highQualityFieldSeparation = true;
  const out = tmp_path.div("hq.aep");
  project.save(out);
  const reread = as_instance(as_instance(getitem(parse_aep(out).project.items, item.id), FootageItem).mainSource, FileSource);
  expect(reread.highQualityFieldSeparation).toBe(true);
  expect(reread._sspc.tobytes()[0x9f]).toBe(0x09);
});

test("test_movie_pixel_aspect_is_the_exact_pasp_ratio", () => {
  // mov_alpha_small.mov declares pasp 4:3; AE stores the ratio 4/3.
  const project = _windows_project();
  const item = as_instance(project.importFile(new ImportOptions(ASSETS.div("mov_alpha_small.mov"))), FootageItem);
  const sspc = item.mainSource._sspc;
  const ae = getitem(_ae_sources(), "mov_alpha_small.mov")._sspc;
  expect(py_eq([sspc.pixel_aspect_dividend, sspc.pixel_aspect_divisor], [4, 3])).toBe(true);
  expect(py_eq([ae.pixel_aspect_dividend, ae.pixel_aspect_divisor], [4, 3])).toBe(true);
});

/**
 * Formats whose `opti` header AE fills from the file: the Photoshop-family
 * still importer (PSD/PSB and TIFF) and the Illustrator/PDF/EPS one.
 */
const _HEADER_FORMATS = ["8BPS", "TIF ", "TEXT"] as const;

function _header_names(...formats: string[]): string[] {
  return sorted(
    Array.from(_ae_sources().entries())
      .filter(([, source]) => formats.includes(source._sspc.source_format_type))
      .map(([name]) => name),
  );
}

test.each(_header_names(..._HEADER_FORMATS))("test_import_writes_after_effects_opti_header[%#]", (name) => {
  // The whole opti body, read back from disk: the channel count (colour
  // channels plus alpha), bit depth, colour mode and layer count of a
  // PSD/TIFF; the document layer count, page count and page size of an
  // Illustrator/PDF document (an EPS keeps the bare body).
  const tmp_path = make_tmp_path();
  const project = _windows_project();
  const item = as_instance(project.importFile(new ImportOptions(_asset(name))), FootageItem);
  const out = tmp_path.div("opti.aep");
  project.save(out);
  const ours = as_instance(getitem(parse_aep(out).project.items, item.id), FootageItem).mainSource;
  expect(py_eq(ours._opti.tobytes(), getitem(_ae_sources(), name)._opti.tobytes())).toBe(true);
});

test.each(_header_names("TEXT"))("test_document_footage_writes_after_effects_kind_bytes[%#]", (name) => {
  // sspc 0xC8-0xC9: AE 2026 writes 00 02 for an Illustrator/PDF/EPS file
  // imported whole, like any other file footage (00 00 is for the layers
  // of an Illustrator composition import).
  const tmp_path = make_tmp_path();
  const project = _windows_project();
  const item = as_instance(project.importFile(new ImportOptions(_asset(name))), FootageItem);
  const out = tmp_path.div("kind.aep");
  project.save(out);
  const ours = as_instance(getitem(parse_aep(out).project.items, item.id), FootageItem).mainSource;
  expect(py_eq(ours._sspc._reserved_c8, getitem(_ae_sources(), name)._sspc._reserved_c8)).toBe(true);
  expect(py_eq(ours._sspc._reserved_c8, new Uint8Array([0x00, 0x02]))).toBe(true);
});

test.each([0, 1])("test_chosen_layer_records_the_document_channels_and_mode[%#]", (layer_index) => {
  // Every opti of a document carries the document's channel count and
  // colour mode, a layer's too: 2 channels (gray + alpha) and mode 1
  // (grayscale) for psd_gray8_layered.psd, whose layers AE imported as a
  // composition in the fixture; the layer's own channel count at 0x5E is
  // gray + transparency = 2. A chosen layer's opti is the one AE writes
  // for that layer in a composition import.
  const tmp_path = make_tmp_path();
  const ae = _ae_layer_sources("psd_gray8_layered.psd");
  const project = _windows_project();
  const options = new ImportOptions(ASSETS.div("depth", "psd_gray8_layered.psd"));
  options.layerIndex = layer_index;
  const item = as_instance(project.importFile(options), FootageItem);
  const out = tmp_path.div("layer.aep");
  project.save(out);
  const source = as_instance(getitem(parse_aep(out).project.items, item.id), FootageItem).mainSource;
  const ours = source._opti.tobytes();
  expect(py_eq([ours[0x1e], ours[0x2a], ours[0x30], ours[0x5e]], [2, 1, 2, 2])).toBe(true);
  expect(py_eq(ours, getitem(ae, source._sspc.layer_index)._opti.tobytes())).toBe(true);
});

test.each([
  // Background layer: RGB, no transparency.
  ["psd_rgb8_bg_layer.psd", 1, 3],
  ["psd_rgb16_bg_layer.psd", 1, 3],
  // The layer above it: RGB + transparency.
  ["psd_rgb8_bg_layer.psd", 0, 4],
])("test_chosen_layer_records_its_own_channels[%#]", (file_name, layer_index, channels) => {
  // opti 0x5E: the document's colour channels plus one when the layer
  // has transparency (the document channel count at 0x1E stays 3).
  const ae = _ae_layer_sources(file_name);
  const project = _windows_project();
  const options = new ImportOptions(ASSETS.div("depth", file_name));
  options.layerIndex = layer_index;
  const source = as_instance(project.importFile(options), FootageItem).mainSource;
  const ours = source._opti.tobytes();
  const theirs = getitem(ae, source._sspc.layer_index)._opti.tobytes();
  expect(py_eq([ours[0x1e], ours[0x5e]], [3, channels])).toBe(true);
  expect(py_eq([ours[0x1e], ours[0x5e]], [theirs[0x1e], theirs[0x5e]])).toBe(true);
});

/**
 * AE 2026's scripted import (Windows) of the hand-written colour-mode files
 * in `samples/assets/depth`: flattened PSDs with an alpha channel, bitmap,
 * indexed and Lab PSDs, and Lab, CMYK + alpha, WhiteIsZero and
 * two-extra-sample TIFFs. Items are named after their files.
 */
const MODES_FIXTURE = SAMPLES.div("models", "import", "photoshop_modes.aep");

function _mode_sources(): Map<string, FileSource> {
  const sources = new Map<string, FileSource>();
  for (const item of parse_project(MODES_FIXTURE).footages) {
    if (item.mainSource instanceof FileSource) {
      sources.set(item.name, item.mainSource);
    }
  }
  return sources;
}

test.each(sorted(_mode_sources().keys()))("test_color_mode_import_matches_after_effects[%#]", (name) => {
  // The opti header (channels: a flattened PSD's alpha channel is not
  // counted; colour mode: Lab = 9, a TIFF's CIELab too; layers: a TIFF's
  // alpha sample counts as one), the cached depth (bitmap 0, indexed 8)
  // and data size, read back from disk.
  const tmp_path = make_tmp_path();
  const project = _windows_project();
  const item = as_instance(project.importFile(new ImportOptions(ASSETS.div("depth", name))), FootageItem);
  const out = tmp_path.div("modes.aep");
  project.save(out);
  const ours = as_instance(as_instance(getitem(parse_aep(out).project.items, item.id), FootageItem).mainSource, FileSource);
  const ae = getitem(_mode_sources(), name);
  expect(py_eq(ours._opti.tobytes(), ae._opti.tobytes())).toBe(true);
  expect(py_eq(_depth_bytes(ours), _depth_bytes(ae))).toBe(true);
  expect(py_eq(ours._sspc.data_size, ae._sspc.data_size)).toBe(true);
});

test("test_audio_and_data_files_have_no_depth", () => {
  const sources = _ae_sources();
  for (const name of ["wav.wav", "mp3.mp3", "csv.csv", "mp4_av1_with_audio.mp4"]) {
    expect(getitem(sources, name)._sspc.depth).toBe(0);
    expect(py_eq(bytes_.slice(getitem(sources, name)._sspc.tobytes(), 0x40, 0x42), new Uint8Array([0x01, 0x01]))).toBe(true);
  }
});
