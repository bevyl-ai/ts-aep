import "../../src/py_aep/binary/_register.ts";
import { realpathSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import {
  AssertionError_,
  b,
  BytesIO,
  bytes_,
  concat,
  encode,
  enumerate,
  getattr,
  getitem,
  len,
  Path,
  py_assert,
  py_bool,
  py_eq,
  py_or,
  repr,
  round,
  sorted,
  struct,
  StopIteration,
  ValueError,
  zip,
} from "../../src/pyrt/index.ts";
import { approx, make_tmp_path, raises, warns } from "../../src/pyrt/pytest.ts";
import { AlphaMode, FieldSeparationType, ImportAsType, PulldownPhase, parse as parse_aep } from "../../src/py_aep/index.ts";
import { ListChunk, write_chunk, type Chunk } from "../../src/py_aep/binary/chunk.ts";
import { build_ai_layer_opti_data, build_generic_opti_data, build_psd_flattened_opti_data, build_psd_layer_opti_data, build_text_opti_data, PlaceholderOptiChunk, PsdOptiChunk, SoliOptiChunk, TextOptiChunk } from "../../src/py_aep/binary/footage_chunks.ts";
import { CURRENT_VALUE, ImportOptions } from "../../src/py_aep/models/import_options.ts";
import { CompItem } from "../../src/py_aep/models/items/composition.ts";
import { FolderItem } from "../../src/py_aep/models/items/folder.ts";
import { FootageItem } from "../../src/py_aep/models/items/footage.ts";
import { _ai_cropped_transform } from "../../src/py_aep/models/project.ts";
import type { Project } from "../../src/py_aep/models/project.ts";
import { FileSource, ai_document_profile } from "../../src/py_aep/models/sources/file.ts";
import { read_ai_layers, UnsupportedAiLayersError } from "../../src/py_aep/resolvers/ai_layers.ts";
import { probe_media } from "../../src/py_aep/resolvers/media_probe.ts";
import { FlattenedPsdError, PsdGroup, PsdLayer, UnsupportedPsdLayersError, _build_layer_tree, _Record, read_psd_layers } from "../../src/py_aep/resolvers/psd_layers.ts";
import { get_file_format, platform_source_format } from "../../src/py_aep/data/file_formats.ts";
import { Label } from "../../src/py_aep/enums/index.ts";
import { ai_layer_opti_boxes, as_instance, parse_project_fresh } from "../helpers.ts";
import { AVLayer } from "../../src/py_aep/models/layers/av_layer.ts";
import type { Layer } from "../../src/py_aep/models/layers/layer.ts";
import { AVItem } from "../../src/py_aep/models/items/av_item.ts";
import { IdtaChunk } from "../../src/py_aep/binary/item_chunks.ts";
import { TdsbChunk } from "../../src/py_aep/binary/property_chunks.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";
import { MaskPropertyGroup } from "../../src/py_aep/models/properties/mask_property_group.ts";
import { Utf8Chunk } from "../../src/py_aep/binary/scalar_chunks.ts";

/** Tests for media-file probing and file-source creation via import_file. */

const ASSETS = new Path(import.meta.dir, "..", "..", "samples", "assets");
const BASE = new Path(import.meta.dir, "..", "..", "samples", "models", "folder", "folder.aep");
const IMPORT_DIR = new Path(import.meta.dir, "..", "..", "samples", "models", "import");

/** Python's `next(x for x in xs if pred(x))`: the first match, else StopIteration. */
function _next<T, S extends T>(xs: Iterable<T>, pred: (x: T) => x is S): S;
function _next<T>(xs: Iterable<T>, pred: (x: T) => boolean): T;
function _next<T>(xs: Iterable<T>, pred: (x: T) => boolean): T {
  for (const x of xs) if (pred(x)) return x;
  throw new StopIteration();
}

function _ae_layer_opti(project: Project, layer_name: string): Uint8Array | null {
  for (const item of project.items.values()) {
    const source = getattr(item, "main_source", null);
    if (source instanceof FileSource) {
      if (getattr(source._opti, "text_layer_name", null) === layer_name) {
        return source._opti.tobytes();
      }
    }
  }
  return null;
}

/** The footage item a footage layer shows (`layer.source`). */
function _footage_source(layer: Layer): FootageItem {
  return as_instance(as_instance(layer, AVLayer).source, FootageItem);
}

function _comp_opts(file: Path): ImportOptions {
  const opts = new ImportOptions(file);
  opts.import_as = ImportAsType.COMP;
  return opts;
}

/** The embedded-profile name from a FileSource's CLRS (Utf8 after empd). */
function _embedded_profile(source: FileSource): string | null {
  if (source._clrs == null) throw new Error("source has no CLRS chunk");
  const chunks = source._clrs.chunks;
  const types = chunks.map((c) => c.chunk_type);
  if (!types.includes("empd")) return null;
  return as_instance(chunks[types.indexOf("empd") + 1], Utf8Chunk).value;
}

/** Extract AE's per-layer 8BPS opti for `group_name` from a parsed fixture. */
function _ae_psd_layer_opti(project: Project, group_name: string): Uint8Array | null {
  for (const item of project.items.values()) {
    const source = getattr(item, "main_source", null);
    if (source instanceof FileSource && getattr(source._opti, "asset_type", "") === "8BPS") {
      if (as_instance(source._opti, PsdOptiChunk).psd_group_name === group_name) {
        const buffer = new BytesIO();
        source._opti.write(buffer);
        return buffer.getvalue();
      }
    }
  }
  return null;
}

function _opti_bytes(source: FileSource): Uint8Array {
  const buffer = new BytesIO();
  source._opti.write(buffer);
  return buffer.getvalue();
}

function _sspc_bytes(source: FileSource): Uint8Array {
  const buffer = new BytesIO();
  source._sspc.write(buffer);
  return buffer.getvalue();
}

/** Map layer group-name -> the per-layer 8BPS footage item. */
function _psd_footage(project: Project): Map<string, FootageItem> {
  const out = new Map<string, FootageItem>();
  for (const item of project.items.values()) {
    if (item instanceof FootageItem && item.main_source instanceof FileSource) {
      const opti = item.main_source._opti;
      if (getattr(opti, "asset_type", "") === "8BPS") {
        out.set(as_instance(opti, PsdOptiChunk).psd_group_name, item);
      }
    }
  }
  return out;
}

function _cropped_opts(file: Path): ImportOptions {
  const opts = new ImportOptions(file);
  opts.import_as = ImportAsType.COMP_CROPPED_LAYERS;
  return opts;
}

/** The chunk types inside a footage item's `LIST:Gide` (and its list). */
function _gide_tree(item: FootageItem): string[][] {
  const gide = as_instance(
    _next(item._item_list.chunks, (c) => getattr(c, "list_type", null) === "Gide"),
    ListChunk,
  );
  return gide.chunks.map((child) => {
    const grandchildren: Chunk[] = getattr(child, "chunks", []);
    return py_or(
      grandchildren.map((c) => c.chunk_type),
      [child.chunk_type],
    );
  });
}

test("test_new_footage_guides_container_matches_after_effects", () => {
  /**
   * A new footage item's guide list holds no `ldat` until it has guides,
   * as in After Effects' own import (`ocio_replace_sergb.aep`).
   */
  const tmp_path = make_tmp_path();
  const ae = _next(
    parse_aep(IMPORT_DIR.div("ocio_replace_sergb.aep")).project.footages,
    (item) => item.name === "ae_png_unchanged",
  );
  const project = parse_aep(BASE).project;
  project.import_file(new ImportOptions(ASSETS.div("image_with_alpha.png")));
  const out = tmp_path.div("imported.aep");
  project.save(out);
  const ours = _next(parse_aep(out).project.footages, (item) => item.name === "image_with_alpha.png");
  expect(py_eq(_gide_tree(ours), _gide_tree(ae))).toBe(true);
  expect(py_eq(_gide_tree(ae), [["gdta"], ["lhd3"]])).toBe(true);
});

/**
 * Each layer of a layered PSD imported as a composition records the
 * document's channels and colour mode and its own channel count, as After
 * Effects does (`footage_depth.aep`): a gray document counts 1 colour
 * channel, a document with a Background layer 3 for that layer. The layer
 * name (from 0x158) is left out: AE names a Background layer in its own UI
 * language.
 */
test.each(["psd_gray8_layered.psd", "psd_rgb8_bg_layer.psd", "psd_rgb16_bg_layer.psd"])(
  "test_comp_import_layer_optis_match_after_effects[%#]",
  (name: string) => {
    const ae = new Map<number, Uint8Array>();
    for (const item of parse_aep(IMPORT_DIR.div("footage_depth.aep")).project.footages) {
      if (
        item.main_source instanceof FileSource &&
        new Path(String(item.main_source._file).replace(/\\/g, "/")).name === name &&
        item.main_source._sspc.layer_index !== 0xffffffff
      ) {
        ae.set(item.main_source._sspc.layer_index, item.main_source._opti.tobytes().slice(0, 0x158));
      }
    }
    const project = parse_aep(BASE, { platform: "windows" }).project;
    project.import_file(_comp_opts(ASSETS.div("depth", name)));
    const ours = new Map<number, Uint8Array>();
    for (const item of project.footages) {
      if (item.main_source instanceof FileSource && item.main_source._sspc.layer_index !== 0xffffffff) {
        ours.set(item.main_source._sspc.layer_index, item.main_source._opti.tobytes().slice(0, 0x158));
      }
    }
    expect(py_bool(ae) && py_eq(ours, ae)).toBe(true);
  },
);

describe("TestImportFileSingle", () => {
  /** Project.import_file for single files. */

  test("test_import_png", () => {
    const project = parse_aep(BASE).project;
    const opts = new ImportOptions(ASSETS.div("image_with_alpha.png"));
    const item = as_instance(project.import_file(opts), FootageItem);

    py_assert(item.main_source instanceof FileSource);
    expect(item.name).toBe("image_with_alpha.png");
    expect(py_eq([item.width, item.height], [640, 346])).toBe(true);
    expect(item.main_source.is_still).toBe(true);
    expect(item.main_source.has_alpha).toBe(true);
    expect(item.main_source.alpha_mode).toBe(AlphaMode.STRAIGHT);
    expect(item.main_source.file).toBe(String(ASSETS.div("image_with_alpha.png")));
  });

  test("test_import_png_writes_generic_opti", () => {
    // AE 2026 opens a PNG still with an empty opti but crashes as soon as
    // it renders it; with the generic header it renders like AE's own
    // import of the same file.
    const tmp_path = make_tmp_path();
    const project = parse_aep(BASE).project;
    project.import_file(new ImportOptions(ASSETS.div("image_with_alpha.png")));
    const out = tmp_path.div("png.aep");
    project.save(out);
    const item = as_instance(
      _next(parse_project_fresh(out).items.values(), (i) => i.name === "image_with_alpha.png"),
      FootageItem,
    );
    py_assert(item.main_source instanceof FileSource);
    expect(py_eq(item.main_source._opti.tobytes(), build_generic_opti_data("png!", { sequence: false }))).toBe(true);
  });

  test("test_import_wav", () => {
    const project = parse_aep(BASE).project;
    const item = as_instance(project.import_file(new ImportOptions(ASSETS.div("wav.wav"))), FootageItem);
    expect(item.has_audio).toBe(true);
    expect(item.has_video).toBe(false);
    expect(item.main_source.is_still).toBe(false);
    expect(approx(item.duration, 5.9431746, { abs: 1e-3 })).toBe(true);
  });

  test("test_import_mov_with_audio", () => {
    const project = parse_aep(BASE).project;
    const item = project.import_file(new ImportOptions(ASSETS.div("mov_480.mov")));
    expect(py_eq([item.width, item.height], [480, 270])).toBe(true);
    expect(item.has_audio).toBe(true);
    expect(approx(item.frame_rate, 30.0, { abs: 1e-3 })).toBe(true);
  });

  test("test_import_m4v", () => {
    const project = parse_aep(BASE).project;
    const item = as_instance(project.import_file(new ImportOptions(ASSETS.div("m4v.m4v"))), FootageItem);
    py_assert(item.main_source instanceof FileSource);
    expect(item.name).toBe("m4v.m4v");
    expect(py_eq([item.width, item.height], [640, 360])).toBe(true);
    expect(item.has_video).toBe(true);
    expect(item.has_audio).toBe(false);
    expect(approx(item.frame_rate, 29.97, { abs: 1e-3 })).toBe(true);
  });

  test("test_import_mp4", () => {
    const project = parse_aep(BASE).project;
    const item = as_instance(project.import_file(new ImportOptions(ASSETS.div("mp4_5s-360p.mp4"))), FootageItem);
    py_assert(item.main_source instanceof FileSource);
    expect(item.name).toBe("mp4_5s-360p.mp4");
    expect(py_eq([item.width, item.height], [640, 360])).toBe(true);
    expect(item.has_video).toBe(true);
    expect(item.has_audio).toBe(true);
    expect(approx(item.frame_rate, 30.0, { abs: 1e-3 })).toBe(true);
    // AE 2026 routes .mp4 through its Media Core importer, not QuickTime.
    expect(item.main_source._sspc.source_format_type).toBe("XCEX");
  });

  test("test_import_mp4_undecodable_codec", () => {
    // AE imports an mp4 whose video codec it cannot decode as audio only;
    // claiming the video makes AE report the footage missing on open.
    const project = parse_aep(BASE).project;
    const item = project.import_file(new ImportOptions(ASSETS.div("mp4_av1_with_audio.mp4")));
    expect(py_eq([item.width, item.height], [0, 0])).toBe(true);
    expect(item.has_video).toBe(false);
    expect(item.has_audio).toBe(true);
    expect(approx(item.duration, 1.0, { abs: 1e-3 })).toBe(true);
  });

  test("test_import_mp4_with_nothing_decodable_raises", () => {
    // With no audio to fall back on AE refuses the file itself, so import
    // must raise rather than write a footage item AE would call missing.
    const project = parse_aep(BASE).project;
    raises(
      ValueError,
      () => {
        project.import_file(new ImportOptions(ASSETS.div("mp4_vp9_no_audio.mp4")));
      },
      "no video track",
    );
  });

  test("test_import_aiff", () => {
    const project = parse_aep(BASE).project;
    const item = as_instance(project.import_file(new ImportOptions(ASSETS.div("click.aiff"))), FootageItem);
    expect(item.has_audio).toBe(true);
    expect(item.has_video).toBe(false);
    expect(item.main_source.is_still).toBe(false);
    expect(approx(item.duration, 0.1274376, { abs: 1e-5 })).toBe(true);
  });

  test("test_import_dpx", () => {
    const project = parse_aep(BASE).project;
    const item = as_instance(project.import_file(new ImportOptions(ASSETS.div("dpx_8bit_rgb.dpx"))), FootageItem);
    py_assert(item.main_source instanceof FileSource);
    expect(item.main_source.is_still).toBe(true);
    expect(item.main_source._sspc.source_format_type).toBe("sDPX");
    expect(item.main_source._opti.data.length).toBe(48);
  });

  test("test_import_cin", () => {
    const project = parse_aep(BASE).project;
    const item = as_instance(project.import_file(new ImportOptions(ASSETS.div("cin.cin"))), FootageItem);
    py_assert(item.main_source instanceof FileSource);
    expect(item.main_source.is_still).toBe(true);
    expect(item.main_source._sspc.source_format_type).toBe("sDPX");
    expect(item.main_source._opti.data.length).toBe(48);
  });

  test("test_import_heic", () => {
    const project = parse_aep(BASE).project;
    const item = as_instance(project.import_file(new ImportOptions(ASSETS.div("heic.heic"))), FootageItem);
    py_assert(item.main_source instanceof FileSource);
    expect(item.main_source.is_still).toBe(true);
    expect(item.main_source._sspc.source_format_type).toBe("AIDE");
    expect(item.main_source._opti.data.length).toBe(58);
    expect(item.main_source.has_alpha).toBe(false);
  });

  test("test_import_heic_alpha", () => {
    const project = parse_aep(BASE, { platform: "macos" }).project;
    const item = as_instance(project.import_file(new ImportOptions(ASSETS.div("heic_alpha.heic"))), FootageItem);
    py_assert(item.main_source instanceof FileSource);
    expect(item.main_source.is_still).toBe(true);
    expect(item.main_source._sspc.source_format_type).toBe("AIDE");
    expect(item.main_source.has_alpha).toBe(true);
    expect(item.main_source.alpha_mode).toBe(AlphaMode.STRAIGHT);
  });

  test("test_import_heic_alpha_windows", () => {
    // AE on Windows stores a HEIC without alpha (windows_stills.aep).
    const project = parse_aep(BASE, { platform: "windows" }).project;
    const item = as_instance(project.import_file(new ImportOptions(ASSETS.div("heic_alpha.heic"))), FootageItem);
    py_assert(item.main_source instanceof FileSource);
    expect(item.main_source.has_alpha).toBe(false);
  });

  test("test_roundtrip_m4v_aiff", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(BASE).project;
    for (const name of ["m4v.m4v", "click.aiff", "mp4_5s-360p.mp4", "mp4_av1_with_audio.mp4"]) {
      project.import_file(new ImportOptions(ASSETS.div(name)));
    }
    const out1 = tmp_path.div("a.aep");
    project.save(out1);
    const out2 = tmp_path.div("b.aep");
    parse_aep(out1).project.save(out2);
    expect(py_eq(out1.read_bytes(), out2.read_bytes())).toBe(true);
  });

  test("test_import_exr_premultiplied", () => {
    const project = parse_aep(BASE).project;
    const item = as_instance(project.import_file(new ImportOptions(ASSETS.div("old_exr.00004.exr"))), FootageItem);
    expect(item.main_source.has_alpha).toBe(true);
    expect(item.main_source.alpha_mode).toBe(AlphaMode.PREMULTIPLIED);
  });

  test("test_import_tiff", () => {
    const project = parse_aep(BASE).project;
    const item = as_instance(project.import_file(new ImportOptions(ASSETS.div("8bits.tif"))), FootageItem);
    py_assert(item.main_source instanceof FileSource);
    expect(item.name).toBe("8bits.tif");
    expect(py_eq([item.width, item.height], [25, 26])).toBe(true);
    // TIFF carries the 602-byte format-specific opti header.
    expect(item.main_source._opti.data.length).toBe(602);
  });

  test.each(["8bits.psd", "8bits.psb"])("test_import_psd[%#]", (name: string) => {
    const project = parse_aep(BASE).project;
    const item = as_instance(project.import_file(new ImportOptions(ASSETS.div(name))), FootageItem);
    py_assert(item.main_source instanceof FileSource);
    expect(item.name).toBe(name);
    expect(py_eq([item.width, item.height], [25, 26])).toBe(true);
    expect(item.main_source.is_still).toBe(true);
    // AE composites a merged PSD to RGBA -> STRAIGHT alpha.
    expect(item.main_source.has_alpha).toBe(true);
    expect(item.main_source.alpha_mode).toBe(AlphaMode.STRAIGHT);
    // The merged-layer opti is exposed via file_attributes.
    const attrs = item.main_source.file_attributes;
    expect(getitem(attrs, "psd_layer_index")).toBe(0xffffffff);
    expect(getitem(attrs, "psd_bit_depth")).toBe(8);
    expect(getitem(attrs, "psd_channels")).toBe(4);
    expect(getitem(attrs, "psd_layer_count")).toBe(2);
    expect(py_eq([getitem(attrs, "psd_canvas_width"), getitem(attrs, "psd_canvas_height")], [25, 26])).toBe(true);
  });

  test("test_roundtrip_psd", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(BASE).project;
    project.import_file(new ImportOptions(ASSETS.div("8bits.psd")));
    const out1 = tmp_path.div("a.aep");
    project.save(out1);
    const out2 = tmp_path.div("b.aep");
    parse_aep(out1).project.save(out2);
    expect(py_eq(out1.read_bytes(), out2.read_bytes())).toBe(true);
  });

  test("test_roundtrip_png", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(BASE).project;
    project.import_file(new ImportOptions(ASSETS.div("image_with_alpha.png")));
    const out = tmp_path.div("out.aep");
    project.save(out);
    const reparsed = parse_aep(out).project;

    const files = Array.from(reparsed.items.values()).filter(
      (it) => getattr(it, "main_source", null) instanceof FileSource,
    );
    expect(files.some((it) => it.name === "image_with_alpha.png")).toBe(true);
  });

  test("test_roundtrip_is_idempotent", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(BASE).project;
    for (const name of ["image_with_alpha.png", "wav.wav", "mov_480.mov"]) {
      project.import_file(new ImportOptions(ASSETS.div(name)));
    }
    const out1 = tmp_path.div("a.aep");
    project.save(out1);
    const out2 = tmp_path.div("b.aep");
    parse_aep(out1).project.save(out2);
    expect(py_eq(out1.read_bytes(), out2.read_bytes())).toBe(true);
  });
});

describe("TestImportFileSequence", () => {
  /** Project.import_file for image sequences. */

  test("test_import_exr_sequence", () => {
    const project = parse_aep(BASE).project;
    const opts = new ImportOptions(ASSETS.div("new_exr.0002.exr"));
    opts.sequence = true;
    const item = as_instance(project.import_file(opts), FootageItem);

    expect(item.name).toBe("new_exr.[0002-0003].exr");
    expect(item.main_source.is_still).toBe(false);
    expect(approx(item.frame_rate, 30.0)).toBe(true);
    // two frames at 30 fps
    expect(approx(item.duration, 2 / 30, { abs: 1e-4 })).toBe(true);
  });

  test("test_import_gif_sequence", () => {
    const project = parse_aep(BASE).project;
    const opts = new ImportOptions(ASSETS.div("sequence_001.gif"));
    opts.sequence = true;
    const item = as_instance(project.import_file(opts), FootageItem);
    expect(item.name).toBe("sequence_[001-003].gif");
    expect(item.main_source.is_still).toBe(false);
  });

  test("test_import_dpx_sequence", () => {
    const project = parse_aep(BASE).project;
    const opts = new ImportOptions(ASSETS.div("dpx_seq.0001.dpx"));
    opts.sequence = true;
    const item = as_instance(project.import_file(opts), FootageItem);
    expect(item.name).toBe("dpx_seq.[0001-0003].dpx");
    expect(item.main_source.is_still).toBe(false);
    expect(item.main_source._sspc.source_format_type).toBe("sDPX");
    expect(as_instance(item.main_source, FileSource)._opti.data.length).toBe(48);
  });

  test("test_item_labels_by_kind", () => {
    // AE 2026 probed: still=5, audio=7, video=3 (Label Preference
    // Indices Section 5 factory values).
    const project = parse_aep(BASE).project;
    const png = project.import_file(new ImportOptions(ASSETS.div("image_with_alpha.png")));
    expect(as_instance(png._idta, IdtaChunk).label).toBe(5);
    const wav = project.import_file(new ImportOptions(ASSETS.div("wav.wav")));
    expect(as_instance(wav._idta, IdtaChunk).label).toBe(7);
    const mov = project.import_file(new ImportOptions(ASSETS.div("mov_480.mov")));
    expect(as_instance(mov._idta, IdtaChunk).label).toBe(3);
  });

  test("test_add_layer_spans_and_labels", () => {
    // AE 2026 probed: layers.add() spans the source duration for timed
    // footage, the still default (comp duration) for stills with the
    // explicit duration honored, and the layer label mirrors the
    // item's label at add time.
    const project = parse_aep(BASE).project;
    const comp = project.root_folder.add_comp("C", 100, 100, 1.0, 5.0, 25.0);
    const png = project.import_file(new ImportOptions(ASSETS.div("image_with_alpha.png")));
    const mov = project.import_file(new ImportOptions(ASSETS.div("mov_480.mov")));
    const wav = project.import_file(new ImportOptions(ASSETS.div("wav.wav")));

    const still_layer = comp.add(png);
    expect(approx(still_layer.out_point, comp.duration)).toBe(true);
    expect(still_layer._ldta.label).toBe(5);
    const mov_layer = comp.add(mov);
    expect(approx(mov_layer.out_point, mov.duration)).toBe(true);
    expect(mov.duration > comp.duration).toBe(true); // source, not comp, duration
    expect(mov_layer._ldta.label).toBe(3);
    const wav_layer = comp.add(wav);
    expect(approx(wav_layer.out_point, wav.duration)).toBe(true);
    expect(wav_layer._ldta.label).toBe(7);

    const still_3s = comp.add(png, 3.0);
    expect(approx(still_3s.out_point, 3.0)).toBe(true);

    png.label = Label.BROWN; // 12: the layer mirrors the item label
    expect(comp.add(png)._ldta.label).toBe(12);
  });

  test("test_add_nested_comp_spans_its_duration", () => {
    const project = parse_aep(BASE).project;
    const outer = project.root_folder.add_comp("Outer", 100, 100, 1.0, 5.0, 25.0);
    const inner = project.root_folder.add_comp("Inner", 100, 100, 1.0, 2.0, 25.0);
    const layer = outer.add(inner);
    expect(approx(layer.out_point, 2.0)).toBe(true);
  });

  test("test_import_sequence_fps_pref", () => {
    // "Import Options Default Sequence FPS" drives the rate of
    // sequences with no native frame rate (30 fps without prefs).
    const tmp_path = make_tmp_path();
    const prefs_dir = tmp_path.div("prefs");
    prefs_dir.mkdir();
    prefs_dir
      .div("Adobe After Effects 26.0 Prefs-indep-general.txt")
      .write_text(
        '["Import Options Preference Section"]\n' +
          '\t"Import Options Default Sequence FPS" = "25.000000"\n',
      );
    const project = parse_aep(BASE, { ae_preferences_dir: prefs_dir }).project;
    const opts = new ImportOptions(ASSETS.div("new_exr.0002.exr"));
    opts.sequence = true;
    const item = project.import_file(opts);
    expect(approx(item.frame_rate, 25.0)).toBe(true);
    expect(approx(item.duration, 2 / 25, { abs: 1e-4 })).toBe(true);
  });

  test("test_sequence_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(BASE).project;
    const opts = new ImportOptions(ASSETS.div("new_exr.0002.exr"));
    opts.sequence = true;
    project.import_file(opts);
    const out = tmp_path.div("seq.aep");
    project.save(out);
    const reparsed = parse_aep(out).project;
    const names = Array.from(reparsed.items.values())
      .filter((it) => getattr(it, "main_source", null) instanceof FileSource)
      .map((it) => it.name);
    expect(names.includes("new_exr.[0002-0003].exr")).toBe(true);
  });

  test("test_sequence_sspc_necessary_fields", () => {
    // Sequence sspc fields AE writes and does not recompute on open:
    // full_frame True, 0xC8 kept at the still-import 0x0002, from_file
    // set (every AE-authored sequence fixture: STIL, oEXR, sDPX).
    const project = parse_aep(BASE).project;
    const opts = new ImportOptions(ASSETS.div("new_exr.0002.exr"));
    opts.sequence = true;
    const item = as_instance(project.import_file(opts), FootageItem);
    const sspc = item.main_source._sspc;
    expect(sspc.full_frame).toBe(true);
    expect(py_eq(sspc._reserved_c8, b("\x00\x02"))).toBe(true);
    expect(sspc.from_file).toBe(true);
  });
});

describe("TestReplaceAndProxy", () => {
  /** FootageItem.replace* and AVItem.set_proxy* (variations of import_file). */

  const _png_footage = (): [Project, FootageItem] => {
    const project = parse_aep(BASE).project;
    const item = project.import_file(new ImportOptions(ASSETS.div("image_with_alpha.png")));
    return [project, as_instance(item, FootageItem)];
  };

  test("test_replace_with_file", () => {
    const [, item] = _png_footage();
    item.replace(ASSETS.div("mov_480.mov"));
    expect(item.main_source instanceof FileSource).toBe(true);
    expect(item.name).toBe("mov_480.mov");
    expect(py_eq([item.width, item.height], [480, 270])).toBe(true);
    expect(item.has_audio).toBe(true);
  });

  test("test_replace_with_mp4", () => {
    const [, item] = _png_footage();
    item.replace(ASSETS.div("mp4_640x360.mp4"));
    expect(item.main_source instanceof FileSource).toBe(true);
    expect(item.name).toBe("mp4_640x360.mp4");
    expect(py_eq([item.width, item.height], [640, 360])).toBe(true);
    expect(item.has_audio).toBe(false);
    expect(approx(item.frame_rate, 29.97, { abs: 1e-3 })).toBe(true);
    expect(item.main_source._sspc.source_format_type).toBe("XCEX");
  });

  test("test_replace_with_undecodable_mp4_raises_and_keeps_source", () => {
    // The new FileSource is built before it is swapped in, so a refused
    // replace must leave the existing source untouched.
    const [, item] = _png_footage();
    raises(
      ValueError,
      () => {
        item.replace(ASSETS.div("mp4_vp9_no_audio.mp4"));
      },
      "no video track",
    );
    expect(item.name).toBe("image_with_alpha.png");
    expect(py_eq([item.width, item.height], [640, 346])).toBe(true);
  });

  test("test_replace_with_sequence", () => {
    const [, item] = _png_footage();
    item.replace_with_sequence(ASSETS.div("new_exr.0002.exr"));
    expect(item.name).toBe("new_exr.[0002-0003].exr");
    expect(item.main_source.is_still).toBe(false);
  });

  test("test_replace_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const [project, item] = _png_footage();
    item.replace(ASSETS.div("wav.wav"));
    const out = tmp_path.div("r.aep");
    project.save(out);
    const out2 = tmp_path.div("r2.aep");
    parse_aep(out).project.save(out2);
    expect(py_eq(out.read_bytes(), out2.read_bytes())).toBe(true);
  });

  // AE only writes the item-level Utf8 name chunk when the user renames the
  // item, so a replace leaves it alone: a default (source-derived) name
  // re-derives from the new source while a user-assigned one survives. A
  // solid or placeholder instead carries its name in the new opti chunk, so
  // the Utf8 goes back to empty and the new source's name always wins.
  // Every expectation below was taken from AE 2026 performing the same call.

  test("test_replace_keeps_user_assigned_name", () => {
    const [, item] = _png_footage();
    item.name = "Custom Name";
    item.replace(ASSETS.div("mov_480.mov"));
    expect(item.name).toBe("Custom Name");
    expect(as_instance(item._name_utf8, Utf8Chunk).value).toBe("Custom Name");
  });

  test("test_replace_leaves_default_name_derived", () => {
    const [, item] = _png_footage();
    item.replace(ASSETS.div("mov_480.mov"));
    expect(item.name).toBe("mov_480.mov");
    // AE derives the name from the source rather than storing it.
    expect(as_instance(item._name_utf8, Utf8Chunk).value).toBe("");
  });

  test("test_replace_with_sequence_keeps_user_assigned_name", () => {
    const [, item] = _png_footage();
    item.name = "Custom Name";
    item.replace_with_sequence(ASSETS.div("new_exr.0002.exr"));
    expect(item.name).toBe("Custom Name");
  });

  test("test_replace_with_sequence_leaves_default_name_derived", () => {
    const [, item] = _png_footage();
    item.replace_with_sequence(ASSETS.div("new_exr.0002.exr"));
    expect(item.name).toBe("new_exr.[0002-0003].exr");
    expect(as_instance(item._name_utf8, Utf8Chunk).value).toBe("");
  });

  test("test_replace_with_solid_overrides_user_assigned_name", () => {
    const [, item] = _png_footage();
    item.name = "Custom Name";
    item.replace_with_solid([0.0, 1.0, 0.0], "Solid D", 50, 50);
    expect(item.name).toBe("Solid D");
    expect(as_instance(item._name_utf8, Utf8Chunk).value).toBe("");
    expect(as_instance(item.main_source._opti, SoliOptiChunk).solid_name).toBe("Solid D");
  });

  test("test_replace_with_placeholder_overrides_user_assigned_name", () => {
    const [, item] = _png_footage();
    item.name = "Custom Name";
    item.replace_with_placeholder("PH C", 120, 120, 25.0, 5.0);
    expect(item.name).toBe("PH C");
    expect(as_instance(item._name_utf8, Utf8Chunk).value).toBe("");
    expect(as_instance(item.main_source._opti, PlaceholderOptiChunk).placeholder_name).toBe("PH C");
  });

  test("test_replace_naming_survives_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const [project, item] = _png_footage();
    item.name = "Custom Name";
    item.replace(ASSETS.div("mov_480.mov"));
    const out = tmp_path.div("r.aep");
    project.save(out);
    const reparsed = _next(parse_aep(out).project.footages, (f) => f.id === item.id);
    expect(reparsed.name).toBe("Custom Name");
  });

  test("test_set_proxy_with_file", () => {
    const [, item] = _png_footage();
    item.set_proxy(ASSETS.div("new_exr.0002.exr"));
    py_assert(item.proxy_source instanceof FileSource);
    expect(item.use_proxy).toBe(true);
    expect(item.proxy_source.file).toBe(String(ASSETS.div("new_exr.0002.exr")));
  });

  test("test_set_proxy_with_sequence", () => {
    const [, item] = _png_footage();
    item.set_proxy_with_sequence(ASSETS.div("new_exr.0002.exr"));
    expect(item.proxy_source instanceof FileSource).toBe(true);
    expect(as_instance(item.proxy_source, FileSource).is_still).toBe(false);
  });

  test("test_set_proxy_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const [project, item] = _png_footage();
    item.set_proxy(ASSETS.div("mov_480.mov"));
    const out = tmp_path.div("p.aep");
    project.save(out);
    const out2 = tmp_path.div("p2.aep");
    parse_aep(out).project.save(out2);
    expect(py_eq(out.read_bytes(), out2.read_bytes())).toBe(true);
  });

  test("test_replace_with_psd", () => {
    const [, item] = _png_footage();
    item.replace(ASSETS.div("8bits.psd"));
    py_assert(item.main_source instanceof FileSource);
    expect(item.name).toBe("8bits.psd");
    expect(py_eq([item.width, item.height], [25, 26])).toBe(true);
    expect(getitem(item.main_source.file_attributes, "psd_layer_index")).toBe(0xffffffff);
  });
});

/**
 * A relative footage path is stored absolute, resolved against the
 * working directory - as ExtendScript's `new File()` resolves one against
 * the current folder. AE 2026 opens a project storing a relative path
 * with the footage missing.
 */
describe("TestRelativePaths", () => {
  // NOTE(port): pytest monkeypatch.chdir restores the cwd at test teardown; afterEach(process.chdir(original)) does the same.
  const _cwd_original = process.cwd();
  afterEach(() => process.chdir(_cwd_original));
  const monkeypatch_chdir = (dir: Path): void => process.chdir(dir.path);

  // `samples/` is a symlink in this checkout and getcwd() reports the real path after chdir.
  const _absolute = (path: Path): string => realpathSync(String(path));

  test("test_import_file_stores_absolute_path", () => {
    const tmp_path = make_tmp_path();
    monkeypatch_chdir(ASSETS);
    const project = parse_aep(BASE).project;
    const item = as_instance(project.import_file(new ImportOptions(new Path("image_with_alpha.png"))), FootageItem);
    const expected = _absolute(ASSETS.div("image_with_alpha.png"));
    expect(as_instance(item.main_source, FileSource).file).toBe(expected);
    const out = tmp_path.div("relative.aep");
    project.save(out);
    const reparsed = as_instance(
      _next(parse_aep(out).project.items.values(), (it) => it instanceof FootageItem && it.name === "image_with_alpha.png"),
      FootageItem,
    );
    expect(as_instance(reparsed.main_source, FileSource).file).toBe(expected);
  });

  test("test_dot_dot_is_normalized", () => {
    monkeypatch_chdir(ASSETS);
    const project = parse_aep(BASE).project;
    const item = as_instance(
      project.import_file(new ImportOptions(new Path("..").div("assets", "image_with_alpha.png"))),
      FootageItem,
    );
    expect(as_instance(item.main_source, FileSource).file).toBe(_absolute(ASSETS.div("image_with_alpha.png")));
  });

  test("test_replace_and_proxy_store_absolute_paths", () => {
    const project = parse_aep(BASE).project;
    const item = as_instance(project.import_file(new ImportOptions(ASSETS.div("image_with_alpha.png"))), FootageItem);
    monkeypatch_chdir(ASSETS);
    item.replace(new Path("wav.wav"));
    expect(as_instance(item.main_source, FileSource).file).toBe(_absolute(ASSETS.div("wav.wav")));
    item.replace_with_sequence(new Path("new_exr.0002.exr"));
    expect(as_instance(item.main_source, FileSource).file).toBe(_absolute(ASSETS.div("new_exr.0002.exr")));
    item.set_proxy(new Path("image_with_alpha.png"));
    expect(as_instance(item.proxy_source, FileSource).file).toBe(_absolute(ASSETS.div("image_with_alpha.png")));
  });

  test("test_layered_comp_import_stores_absolute_paths", () => {
    monkeypatch_chdir(ASSETS);
    const project = parse_aep(BASE).project;
    const opts = new ImportOptions(new Path("choose_layer.psd"));
    opts.import_as = ImportAsType.COMP;
    project.import_file(opts);
    const expected = _absolute(ASSETS.div("choose_layer.psd"));
    const files = new Set<string>();
    for (const it of project.items.values()) {
      if (it instanceof FootageItem && it.main_source instanceof FileSource && it.main_source.file.endsWith("choose_layer.psd")) {
        files.add(it.main_source.file);
      }
    }
    expect(py_eq(files, new Set([expected]))).toBe(true);
  });
});

/**
 * A replace keeps the Interpret Footage settings (issue #223).
 *
 * Expected values are AE 2026 ground truth: AE carries the settings the
 * user chose and takes the measured facts - dimensions, duration, native
 * rate, alpha - from the new file.
 */
describe("TestReplaceKeepsInterpretation", () => {
  const _interpreted_movie = () => {
    const project = parse_aep(BASE).project;
    const item = as_instance(project.import_file(new ImportOptions(ASSETS.div("mov_480.mov"))), FootageItem);
    const source = item.main_source;
    source.conform_frame_rate = 25.0;
    source.field_separation_type = FieldSeparationType.UPPER_FIELD_FIRST;
    source.high_quality_field_separation = true;
    source.remove_pulldown = PulldownPhase.WSSWW;
    source.loop = 3;
    source._sspc.pixel_aspect = 2.0; // AVItem.pixel_aspect is read-only
    return [project, item] as const;
  };

  test("test_replace_keeps_interpretation", () => {
    const [, item] = _interpreted_movie();
    item.replace(ASSETS.div("mov_23_976.mov"));
    const source = item.main_source;
    expect(source.conform_frame_rate).toBe(25.0);
    expect(source.field_separation_type).toBe(FieldSeparationType.UPPER_FIELD_FIRST);
    expect(source.high_quality_field_separation).toBe(true);
    expect(source.remove_pulldown).toBe(PulldownPhase.WSSWW);
    expect(source.loop).toBe(3);
    expect(item.pixel_aspect).toBe(2.0);
  });

  test("test_replace_takes_alpha_from_the_new_file", () => {
    const project = parse_aep(BASE).project;
    const item = as_instance(project.import_file(new ImportOptions(ASSETS.div("image_with_alpha.png"))), FootageItem);
    item.main_source.alpha_mode = AlphaMode.PREMULTIPLIED;
    item.main_source.invert_alpha = true;
    item.replace(ASSETS.div("mov_480.mov"));
    // The movie has no alpha channel, so neither has the item.
    expect(item.main_source.has_alpha).toBe(false);
    expect(item.main_source.invert_alpha).toBe(false);
  });

  /**
   * A sequence assumed to run at 25 fps, stored the way AE stores it.
   *
   * A sequence of stills has no rate of its own, so AE keeps the assumed
   * one in the native slot and leaves the conform slot at 0.
   */
  const _sequence_assumed_25 = () => {
    const project = parse_aep(BASE).project;
    const opts = new ImportOptions(ASSETS.div("new_exr.0002.exr"));
    opts.sequence = true;
    const item = as_instance(project.import_file(opts), FootageItem);
    item.main_source.conform_frame_rate = 25.0;
    return [project, item] as const;
  };

  test("test_replace_with_sequence_keeps_the_assumed_frame_rate", () => {
    /** The reported bug: a sequence's rate reset to the preference. */
    const [, item] = _sequence_assumed_25();
    item.replace_with_sequence(ASSETS.div("sequence_001.gif"));
    // A sequence has no rate of its own: AE keeps the assumed one as the
    // native rate, and the stored duration follows it.
    expect(item.main_source.native_frame_rate).toBe(25.0);
    expect(item.frame_rate).toBe(25.0);
    expect(approx(item.main_source._sspc.duration, 3 / 25)).toBe(true);
  });

  test("test_sequence_rate_does_not_carry_to_a_movie", () => {
    /** An assumed rate is not a conform - a movie keeps its own rate. */
    const [, item] = _sequence_assumed_25();
    item.replace(ASSETS.div("mov_480.mov"));
    expect(item.main_source.conform_frame_rate).toBe(0.0);
    expect(item.frame_rate).toBe(30.0);
  });

  test("test_replace_with_solid_keeps_nothing", () => {
    const [, item] = _interpreted_movie();
    item.replace_with_solid([1.0, 0.0, 0.0], "Solid", 40, 40);
    expect(item.main_source.loop).toBe(1);
    expect(item.main_source.field_separation_type).toBe(FieldSeparationType.OFF);
  });

  test("test_interpretation_survives_a_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const [project, item] = _interpreted_movie();
    item.replace(ASSETS.div("mov_23_976.mov"));
    const out = tmp_path.div("interpretation.aep");
    project.save(out);
    const reparsed = _next(parse_aep(out).project.footages, (f) => f.id === item.id);
    const source = reparsed.main_source;
    expect(source.conform_frame_rate).toBe(25.0);
    expect(source.remove_pulldown).toBe(PulldownPhase.WSSWW);
    expect(source.loop).toBe(3);
  });

  /**
   * A folder holding only a 12-frame sequence, so `force_alphabetical`
   * gathers the same frames as AE (which takes every file of the type).
   */
  const _twelve_frame_sequence = (folder: Path): Path => {
    folder.mkdir();
    const frame = (ASSETS.div("image_with_alpha.png")).read_bytes();
    for (let number = 1; number <= 12; number++) {
      folder.div(`frame_${String(number).padStart(4, "0")}.png`).write_bytes(frame);
    }
    return folder.div("frame_0001.png");
  };

  /**
   * A placeholder's rate is assumed like a sequence's, so the sequence
   * replacing it plays at that rate. The stored durations are AE 2026's
   * for the same replace: 12 frames over the rate to the nearest
   * thousandth, unreduced.
   */
  test.each([
    [24.0, 12, 24],
    [29.97, 1200, 2997],
    [23.976, 1500, 2997],
    [12.5, 24, 25],
  ])("test_placeholder_rate_carries_to_a_sequence[%#]", (rate: number, dividend: number, divisor: number) => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(BASE).project;
    const item = project.import_placeholder("PH", 640, 480, rate, 10.0);
    item.replace_with_sequence(_twelve_frame_sequence(tmp_path.div("seq")), true);
    const out = tmp_path.div("placeholder.aep");
    project.save(out);
    const reparsed = _next(parse_aep(out).project.footages, (f) => f.id === item.id);
    const sspc = reparsed.main_source._sspc;
    expect(approx(reparsed.frame_rate, rate, { abs: 1e-4 })).toBe(true);
    expect(sspc.conform_frame_rate).toBe(0.0);
    expect(py_eq([sspc.duration_dividend, sspc.duration_divisor], [dividend, divisor])).toBe(true);
  });

  test("test_placeholder_conform_carries_to_a_sequence", () => {
    const tmp_path = make_tmp_path();
    // AE 2026: a 24 fps placeholder conformed to 25 fps hands 25 fps on.
    const project = parse_aep(BASE).project;
    const item = project.import_placeholder("PH", 640, 480, 24.0, 10.0);
    item.main_source.conform_frame_rate = 25.0;
    item.replace_with_sequence(_twelve_frame_sequence(tmp_path.div("seq")), true);
    expect(item.frame_rate).toBe(25.0);
    expect(item.duration).toBe(0.48);
  });

  /**
   * A movie with no conform hands its own rate to the sequence that
   * replaces it. AE 2026 gives the sequence the movie's rate, not the
   * 24 fps of the placeholder the movie replaced, stored like a
   * placeholder's carried rate.
   */
  test.each([
    ["mov_23_976.mov", 23.976, 1500, 2997],
    ["mov_alpha_small.mov", 25.0, 12, 25],
  ])("test_movie_rate_carries_to_a_sequence[%#]", (movie: string, rate: number, dividend: number, divisor: number) => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(BASE).project;
    const item = project.import_placeholder("PH", 2356, 1002, 24.0, 10.0);
    item.replace(ASSETS.div(movie));
    item.replace_with_sequence(_twelve_frame_sequence(tmp_path.div("seq")), true);
    const out = tmp_path.div("movie.aep");
    project.save(out);
    const reparsed = _next(parse_aep(out).project.footages, (f) => f.id === item.id);
    const sspc = reparsed.main_source._sspc;
    expect(approx(reparsed.frame_rate, rate, { abs: 1e-4 })).toBe(true);
    expect(sspc.conform_frame_rate).toBe(0.0);
    expect(py_eq([sspc.duration_dividend, sspc.duration_divisor], [dividend, divisor])).toBe(true);
  });

  // AE 2026: audio and stills have no frame rate, so the sequence
  // replacing them runs at the default sequence rate - even when a
  // movie came before the still.
  test.each([
    [["wav.wav"]],
    [["mov_23_976.mov", "image_with_alpha.png"]],
  ])("test_no_rate_to_carry_to_a_sequence[%#]", (steps: string[]) => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(BASE).project;
    const item = as_instance(project.import_file(new ImportOptions(ASSETS.div(steps[0]))), FootageItem);
    for (const name of steps.slice(1)) {
      item.replace(ASSETS.div(name));
    }
    item.replace_with_sequence(_twelve_frame_sequence(tmp_path.div("seq")), true);
    expect(item.frame_rate).toBe(30.0);
    expect(item.duration).toBe(0.4);
  });

  /**
   * A sequence proxy keeps its rate like a main sequence: setting it
   * writes the native slot and rescales the duration, as AE 2026 does,
   * and `0` is ignored. ExtendScript would read 0 here, because the
   * item's main source is a movie.
   */
  test("test_sequence_proxy_reads_its_own_assumed_rate", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(BASE).project;
    const item = project.import_file(new ImportOptions(ASSETS.div("mov_23_976.mov")));
    item.set_proxy_with_sequence(_twelve_frame_sequence(tmp_path.div("seq")));
    if (item.proxy_source == null) throw new Error("item has no proxy source");
    expect(item.proxy_source.conform_frame_rate).toBe(30.0);
    item.proxy_source.conform_frame_rate = 25.0;
    item.proxy_source.conform_frame_rate = 0.0;
    const out = tmp_path.div("proxy.aep");
    project.save(out);
    const reparsed = _next(parse_aep(out).project.footages, (f) => f.id === item.id);
    const proxy = reparsed.proxy_source;
    if (proxy == null) throw new Error("reparsed item has no proxy source");
    const sspc = proxy._sspc;
    expect(proxy.conform_frame_rate).toBe(25.0);
    expect(py_eq([sspc.native_frame_rate, sspc.conform_frame_rate], [25.0, 0.0])).toBe(true);
    expect(py_eq([sspc.duration_dividend, sspc.duration_divisor], [12, 25])).toBe(true);
  });

  /**
   * Like a sequence's assumed rate, a placeholder's is not a conform,
   * even one set through `conform_frame_rate`.
   */
  test.each([[null], [25.0]])("test_placeholder_rate_does_not_carry_to_a_movie[%#]", (conform: number | null) => {
    const project = parse_aep(BASE).project;
    const item = project.import_placeholder("PH", 640, 480, 24.0, 10.0);
    if (conform != null) {
      item.main_source.conform_frame_rate = conform;
    }
    item.replace(ASSETS.div("mov_480.mov"));
    expect(item.main_source.conform_frame_rate).toBe(0.0);
    expect(item.frame_rate).toBe(30.0);
  });

  test("test_conform_does_not_carry_to_a_placeholder", () => {
    // AE 2026: a movie conformed to 25 fps, replaced with a 30 fps
    // placeholder, plays at the placeholder's 30 fps.
    const project = parse_aep(BASE).project;
    const item = as_instance(project.import_file(new ImportOptions(ASSETS.div("mov_480.mov"))), FootageItem);
    item.main_source.conform_frame_rate = 25.0;
    item.replace_with_placeholder("PH", 100, 100, 30.0, 5.0);
    const sspc = item.main_source._sspc;
    expect(py_eq([sspc.native_frame_rate, sspc.conform_frame_rate], [30.0, 0.0])).toBe(true);
    expect(item.frame_rate).toBe(30.0);
    expect(item.duration).toBe(5.0);
  });
});

/**
 * import_file for formats AE handles that py-aep newly supports.
 *
 * Expected values are AE 2026 ground truth.
 */
describe("TestImportGapFormats", () => {
  test.each([
    ["crystal.fbx", "LDOM", 1920, 1080],
    ["txt.txt", "", 0, 0],
    ["csv.csv", "", 0, 0],
    ["json.json", "nosj", 0, 0],
    ["m4a.m4a", "MOoV", 0, 0],
    ["mgjson.mgjson", "sjgm", 0, 0],
    ["mp3.mp3", "MP3A", 0, 0],
    ["aac.aac", "MPEG", 0, 0],
    ["swf.swf", "SWF ", 640, 360],
    ["mpeg.mpeg", "MPEO", 640, 360],
    ["hdr.hdr", "RHDR", 640, 426],
    ["crw.crw", "Craw", 1536, 1024],
    ["ai.ai", "TEXT", 612, 792],
    ["eps.eps", "TEXT", 1921, 2881],
    ["pdf.pdf", "TEXT", 595, 842],
    ["wmv.wmv", "WMED", 640, 360],
    ["aif.aif", "AIFC", 0, 0],
    ["cin.cin", "sDPX", 16, 16],
    ["dpx_8bit_rgb.dpx", "sDPX", 16, 16],
    ["dpx_8bit_rgba.dpx", "sDPX", 16, 16],
    ["dpx_10bit_be.dpx", "sDPX", 16, 16],
    ["dpx_12bit_be.dpx", "sDPX", 16, 16],
    ["dpx_16bit_rgba_be.dpx", "sDPX", 16, 16],
    ["heic.heic", "AIDE", 16, 16],
    ["heic_alpha.heic", "AIDE", 16, 16],
  ])(
    "test_import_source_format_and_dims[%#]",
    (filename: string, source_format: string, width: number, height: number) => {
      const project = parse_aep(BASE).project;
      const item = as_instance(project.import_file(new ImportOptions(ASSETS.div(filename))), FootageItem);
      py_assert(item.main_source instanceof FileSource);
      expect(py_eq(item.main_source._sspc.source_format_type, source_format)).toBe(true);
      expect(py_eq([item.width, item.height], [width, height])).toBe(true);
    },
  );

  test("test_m4a_duration_uses_edit_list", () => {
    // AAC pre-roll makes the raw mdhd duration ~46ms too long; the elst
    // edit-list correction yields AE's 13.839s.
    const project = parse_aep(BASE).project;
    const item = as_instance(project.import_file(new ImportOptions(ASSETS.div("m4a.m4a"))), FootageItem);
    expect(approx(item.duration, 13.839, { abs: 0.01 })).toBe(true);
    expect(item.main_source._sspc.audio_sample_rate).toBe(44100.0);
  });

  test("test_aac_duration_and_audio", () => {
    // ADTS frame-scan duration; AE 2026 decodes to 105.790s (the ~0.02s
    // delta is decoder priming, which AE re-derives from the file on open).
    const project = parse_aep(BASE).project;
    const item = as_instance(project.import_file(new ImportOptions(ASSETS.div("aac.aac"))), FootageItem);
    expect(item.main_source._sspc.source_format_type).toBe("MPEG");
    expect(approx(item.duration, 105.79, { abs: 0.05 })).toBe(true);
    expect(item.main_source._sspc.audio_sample_rate).toBe(44100.0);
    expect(item.has_audio).toBe(true);
    expect(py_eq([item.width, item.height], [0, 0])).toBe(true);
  });

  test("test_mgjson_duration_from_samples", () => {
    const project = parse_aep(BASE).project;
    const item = project.import_file(new ImportOptions(ASSETS.div("mgjson.mgjson")));
    expect(approx(item.duration, 468.033, { abs: 0.01 })).toBe(true);
  });

  test("test_swf_has_alpha_and_frame_rate", () => {
    const project = parse_aep(BASE).project;
    const item = as_instance(project.import_file(new ImportOptions(ASSETS.div("swf.swf"))), FootageItem);
    expect(item.main_source.has_alpha).toBe(true);
    expect(approx(item.frame_rate, 29.96, { abs: 0.05 })).toBe(true);
  });

  test("test_text_format_has_alpha", () => {
    const project = parse_aep(BASE).project;
    const item = as_instance(project.import_file(new ImportOptions(ASSETS.div("ai.ai"))), FootageItem);
    expect(item.main_source.has_alpha).toBe(true);
  });

  test("test_fbx_sets_premultiplied_alpha_flag", () => {
    // AE 2026 sets the sspc premultiplied bit for an imported FBX scene
    // even though alpha_mode_raw stays 0 (straight). Verified against an
    // AE-resaved crystal.fbx.
    const project = parse_aep(BASE).project;
    const item = as_instance(project.import_file(new ImportOptions(ASSETS.div("crystal.fbx"))), FootageItem);
    const sspc = item.main_source._sspc;
    expect(sspc.premultiplied).toBe(true);
    expect(sspc.alpha_mode_raw).toBe(0);
  });

  test("test_import_roundtrip_is_byte_identical", () => {
    // A newly supported format (custom RHDR opti) must survive
    // parse -> save -> reparse byte-identically.
    const tmp_path = make_tmp_path();
    const project = parse_aep(BASE).project;
    project.import_file(new ImportOptions(ASSETS.div("hdr.hdr")));
    const out = tmp_path.div("g.aep");
    project.save(out);
    const out2 = tmp_path.div("g2.aep");
    parse_aep(out).project.save(out2);
    expect(py_eq(out.read_bytes(), out2.read_bytes())).toBe(true);
  });

  test("test_heic_roundtrip_is_byte_identical", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(BASE).project;
    project.import_file(new ImportOptions(ASSETS.div("heic.heic")));
    project.import_file(new ImportOptions(ASSETS.div("heic_alpha.heic")));
    const out = tmp_path.div("heic_test.aep");
    project.save(out);
    const out2 = tmp_path.div("heic_test2.aep");
    parse_aep(out).project.save(out2);
    expect(py_eq(out.read_bytes(), out2.read_bytes())).toBe(true);
  });

  test("test_heic_matches_ae_fixture", () => {
    const fixture_dir = new Path(import.meta.dir, "..", "..", "samples", "models", "format_options", "heic");
    const truth_project = parse_aep(fixture_dir.div("base.aep")).project;
    const truth_items = new Map(truth_project.footages.map((f) => [f.name, f] as const));

    // The fixture was saved by AE on macOS.
    const project = parse_aep(BASE, { platform: "macos" }).project;
    for (const filename of ["heic.heic", "heic_alpha.heic"]) {
      const item = as_instance(project.import_file(new ImportOptions(ASSETS.div(filename))), FootageItem);
      const truth = getitem(truth_items, item.name);
      expect(py_eq([item.width, item.height], [truth.width, truth.height])).toBe(true);
      expect(item.main_source._sspc.source_format_type).toBe(truth.main_source._sspc.source_format_type);
      expect(item.main_source._opti.data.length).toBe(truth.main_source._opti.data.length);
      expect(item.main_source.has_alpha).toBe(truth.main_source.has_alpha);
      expect(item.main_source._sspc.alpha_mode_raw).toBe(truth.main_source._sspc.alpha_mode_raw);
    }
  });

  test("test_dpx_cineon_roundtrip_is_byte_identical", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(BASE).project;
    project.import_file(new ImportOptions(ASSETS.div("dpx_8bit_rgb.dpx")));
    const opts = new ImportOptions(ASSETS.div("dpx_seq.0001.dpx"));
    opts.sequence = true;
    project.import_file(opts);
    const out = tmp_path.div("dpx_test.aep");
    project.save(out);
    const out2 = tmp_path.div("dpx_test2.aep");
    parse_aep(out).project.save(out2);
    expect(py_eq(out.read_bytes(), out2.read_bytes())).toBe(true);
  });

  test("test_generic_still_imports_match_ae_fixtures", () => {
    // AE 2026 macOS tags BMP/GIF stills and sequences IMIO
    // (imio_stills.aep, imio_sequence.aep).
    const truth_items = new Map<string, FootageItem>();
    for (const fixture of ["imio_stills.aep", "imio_sequence.aep"]) {
      for (const f of parse_aep(IMPORT_DIR.div(fixture)).project.footages) {
        truth_items.set(f.name, f);
      }
    }

    const project = parse_aep(BASE, { platform: "macos" }).project;
    const cases: [string, boolean][] = [
      ["bmp.bmp", false],
      ["sequence_001.gif", false],
      ["sequence_001.gif", true],
    ];
    for (const [filename, seq] of cases) {
      const opts = new ImportOptions(ASSETS.div(filename));
      opts.sequence = seq;
      const item = as_instance(project.import_file(opts), FootageItem);
      const truth = getitem(truth_items, item.name);
      const ours = item.main_source;
      const ae = truth.main_source;
      expect(ours._sspc.source_format_type === ae._sspc.source_format_type && ae._sspc.source_format_type === "IMIO").toBe(true);
      expect(py_eq([item.width, item.height], [truth.width, truth.height])).toBe(true);
      expect(ours._opti.data.length === ae._opti.data.length && ae._opti.data.length === 58).toBe(true);
      expect(py_eq(ours._opti.data.slice(0, 4), b("IMIO"))).toBe(true);
      if (seq) {
        // AE zeroes the importer block for a generic-still sequence.
        expect(py_eq(ours._opti.data, ae._opti.data)).toBe(true);
        expect(
          py_eq(
            [ours._sspc.duration_dividend, ours._sspc.duration_divisor],
            [ae._sspc.duration_dividend, ae._sspc.duration_divisor],
          ) && py_eq([ae._sspc.duration_dividend, ae._sspc.duration_divisor], [3, 30]),
        ).toBe(true);
      }
    }
  });

  test("test_windows_stills_match_ae_fixture", () => {
    // windows_stills.aep: AE 2026 on Windows imports BMP/GIF stills with
    // its STIL importer, and HEIC without alpha (macOS keeps it).
    const truth_items = new Map(
      parse_aep(IMPORT_DIR.div("windows_stills.aep")).project.footages.map((f) => [f.name, f] as const),
    );
    const project = parse_aep(BASE, { platform: "windows" }).project;
    for (const filename of ["bmp.bmp", "sequence_001.gif", "heic_alpha.heic"]) {
      const item = as_instance(project.import_file(new ImportOptions(ASSETS.div(filename))), FootageItem);
      const ours = item.main_source;
      const ae = getitem(truth_items, item.name).main_source;
      expect(ours._sspc.source_format_type).toBe(ae._sspc.source_format_type);
      expect(py_eq(ours._opti.data.slice(0, 4), ae._opti.data.slice(0, 4))).toBe(true);
      expect(ours.has_alpha).toBe(ae.has_alpha);
      expect(ours._sspc.alpha_mode_raw).toBe(ae._sspc.alpha_mode_raw);
      expect(ours._sspc._alpha_flags).toBe(ae._sspc._alpha_flags);
    }
  });

  test("test_generic_still_code_follows_platform", () => {
    // The generic still importer is the only platform-specific code:
    // STIL on Windows (windows_stills.aep, media_replacement.aep), IMIO
    // on macOS, for stills and sequences alike.
    for (const ext of [".bmp", ".gif"]) {
      const fmt = get_file_format(ext);
      expect(platform_source_format(fmt, { windows: false })).toBe("IMIO");
      expect(platform_source_format(fmt, { windows: true })).toBe("STIL");
    }
    const png = get_file_format(".png");
    expect(platform_source_format(png, { windows: true })).toBe("png!");
  });

  test("test_media_gap_formats_matches_ae_fixture", () => {
    const truth_project = parse_aep(IMPORT_DIR.div("media_gap_formats.aep")).project;
    const truth_items = new Map(truth_project.footages.map((f) => [f.name, f] as const));

    const project = parse_aep(BASE).project;
    const cases: [string, boolean][] = [
      ["aif.aif", false],
      ["cin.cin", false],
      ["dpx_8bit_rgb.dpx", false],
      ["dpx_8bit_rgba.dpx", false],
      ["dpx_10bit_be.dpx", false],
      ["dpx_12bit_be.dpx", false],
      ["dpx_16bit_rgba_be.dpx", false],
      ["dpx_seq.0001.dpx", true],
    ];
    for (const [filename, seq] of cases) {
      const opts = new ImportOptions(ASSETS.div(filename));
      opts.sequence = seq;
      const item = as_instance(project.import_file(opts), FootageItem);
      const truth = getitem(truth_items, item.name);
      expect(py_eq([item.width, item.height], [truth.width, truth.height])).toBe(true);
      expect(Math.abs(item.duration - truth.duration) < 1e-5).toBe(true);
      expect(Math.abs(item.frame_rate - truth.frame_rate) < 1e-5).toBe(true);
      expect(item.main_source._sspc.source_format_type).toBe(truth.main_source._sspc.source_format_type);
      expect(item.main_source._opti.data.length).toBe(truth.main_source._opti.data.length);
      if (item.main_source._sspc.source_format_type === "sDPX") {
        expect(py_eq(item.main_source._opti.data, truth.main_source._opti.data)).toBe(true);
      }
      expect(item.main_source.has_alpha).toBe(truth.main_source.has_alpha);
      expect(as_instance(item._idta, IdtaChunk).label).toBe(as_instance(truth._idta, IdtaChunk).label);
    }
  });
});

/** Layered Illustrator (.ai) import as a composition, vs AE ground truth. */
describe("TestImportAiComp", () => {
  test("test_read_ai_layers_document_order", () => {
    expect(py_eq(read_ai_layers(ASSETS.div("ai.ai")), ["Calque 1", "Calque 2"])).toBe(true);
  });

  test("test_read_ai_layers_non_pdf_raises", () => {
    // Saved without PDF compatibility: artwork is a compressed PGF block
    // with no Optional Content Groups, so layers cannot be enumerated.
    raises(UnsupportedAiLayersError, () => {
      read_ai_layers(ASSETS.div("ai_no_pdf.ai"));
    });
  });

  test("test_import_structure", () => {
    const project = parse_aep(BASE).project;
    const comp = as_instance(project.import_file(_comp_opts(ASSETS.div("ai.ai"))), CompItem);
    expect(comp.name).toBe("ai");
    expect(py_eq([comp.width, comp.height], [612, 792])).toBe(true);
    // Footage layers (not shape layers), stacked in reverse document order.
    expect(py_eq(comp.layers.map((layer) => layer.name), ["Calque 2", "Calque 1"])).toBe(true);
    const folders = Array.from(project.items.values()).filter(
      (it) => it instanceof FolderItem && it.name === "ai Layers",
    );
    expect(folders.length).toBe(1);
    const footage = as_instance(folders[0], FolderItem).items;
    expect(footage.length).toBe(2);
    for (const item of footage) {
      const source = as_instance(item, FootageItem).main_source;
      py_assert(source instanceof FileSource);
      expect(source.file.endsWith("ai.ai")).toBe(true);
    }
  });

  test("test_per_layer_opti_matches_ae", () => {
    const fixture = parse_aep(IMPORT_DIR.div("ai_comp.aep")).project;
    const project = parse_aep(BASE).project;
    const comp = as_instance(project.import_file(_comp_opts(ASSETS.div("ai.ai"))), CompItem);
    for (const layer of comp.layers) {
      const source = _footage_source(layer).main_source;
      py_assert(source instanceof FileSource);
      const mine = source._opti.tobytes();
      expect(py_eq(mine, build_ai_layer_opti_data(612, 792, layer.name, 2))).toBe(true);
      expect(py_eq(mine, _ae_layer_opti(fixture, layer.name))).toBe(true);
    }
  });


  test("test_per_layer_sspc_byte_c9_is_text_zero", () => {
    // Byte 0xC9 of the sspc reserved template is 0x00 for TEXT (AI/EPS/PDF)
    // footage, not the 0x02 that raster/media writes. Regression guard: it
    // was hardcoded 0x02 for all formats - a divergence invisible to the
    // opti-only check above (verified against ai_comp.aep: 0xC9 = 0x00).
    const project = parse_aep(BASE).project;
    const comp = as_instance(project.import_file(_comp_opts(ASSETS.div("ai.ai"))), CompItem);
    for (const layer of comp.layers) {
      const source = _footage_source(layer).main_source;
      py_assert(source instanceof FileSource);
      expect(source._sspc.source_format_type).toBe("TEXT");
      expect(py_eq(_sspc_bytes(source).slice(0xc4, 0xca), b("\x00\x00\x00\x01\x00\x00"))).toBe(true);
    }
  });

  test("test_roundtrip_byte_identical", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(BASE).project;
    project.import_file(_comp_opts(ASSETS.div("ai.ai")));
    const out = tmp_path.div("ai_comp.aep");
    project.save(out);
    const out2 = tmp_path.div("ai_comp2.aep");
    parse_aep(out).project.save(out2);
    expect(py_eq(out.read_bytes(), out2.read_bytes())).toBe(true);
  });

  test("test_comp_and_layer_metadata_matches_ae", () => {
    // Comp shutter phase and per-layer ldta flags match AE's import (the
    // only remaining delta is `label`, which is preference-driven).
    const fixture = parse_aep(IMPORT_DIR.div("ai_comp.aep")).project;
    const ae_comp = as_instance(
      _next(fixture.items.values(), (it) => it instanceof CompItem && it.name === "ai"),
      CompItem,
    );
    const comp = as_instance(parse_aep(BASE).project.import_file(_comp_opts(ASSETS.div("ai.ai"))), CompItem);
    expect(comp.shutter_phase).toBe(-90);
    expect(ae_comp.shutter_phase).toBe(-90);
    for (const [layer, ae_layer] of zip(comp.layers, ae_comp.layers)) {
      expect(layer._ldta._reserved_3b).toBe(1);
      expect(ae_layer._ldta._reserved_3b).toBe(1);
      expect(layer._ldta._reserved_3c).toBe(0);
      expect(ae_layer._ldta._reserved_3c).toBe(0);
      expect(layer._ldta.name_set).toBe(true);
      expect(ae_layer._ldta.name_set).toBe(true);
    }
  });

  test("test_embedded_profile_name_extraction", () => {
    expect(
      py_eq(ai_document_profile(ASSETS.div("ai.ai")), [null, "Coated FOGRA39 (ISO 12647-2:2004)"]),
    ).toBe(true);
    // A non-PDF file has no extractable embedded profile.
    expect(py_eq(ai_document_profile(ASSETS.div("txt.txt")), [null, null])).toBe(true);
  });

  test("test_comp_footage_records_embedded_profile", () => {
    const comp = as_instance(parse_aep(BASE).project.import_file(_comp_opts(ASSETS.div("ai.ai"))), CompItem);
    for (const layer of comp.layers) {
      const profile = _embedded_profile(as_instance(_footage_source(layer).main_source, FileSource));
      expect(profile).toBe("Coated FOGRA39 (ISO 12647-2:2004)");
    }
  });

  test("test_footage_import_records_embedded_profile", () => {
    const item = as_instance(parse_aep(BASE).project.import_file(new ImportOptions(ASSETS.div("ai.ai"))), FootageItem);
    expect(_embedded_profile(as_instance(item.main_source, FileSource))).toBe("Coated FOGRA39 (ISO 12647-2:2004)");
  });

  test("test_complex_multiartboard_comp", () => {
    // A complex multi-artboard .ai (groups, text, effects, 2 artboards)
    // imports as ONE comp at the document/first-artboard size, with one
    // flat footage layer per Illustrator layer. Nested sublayers are
    // flattened into their parent's layer (no nested comps), and the extra
    // artboard does not create extra comps (AE 2026-verified).
    const comp = as_instance(parse_aep(BASE).project.import_file(_comp_opts(ASSETS.div("complex.ai"))), CompItem);
    expect(py_eq([comp.width, comp.height], [400, 300])).toBe(true);
    expect(
      py_eq(
        comp.layers.map((layer) => layer.name),
        [
          "Empty Layer",
          "Artboard 2 Layer",
          "Parent Layer",
          "Effects Layer",
          "Text Layer",
          "Shapes",
          "Background",
          "Calque 1",
        ],
      ),
    ).toBe(true);
    for (const layer of comp.layers) {
      expect(_footage_source(layer).main_source instanceof FileSource).toBe(true);
    }
  });

  test("test_complex_comp_per_layer_opti_matches_ae", () => {
    // Full per-layer opti byte-match for a multi-artboard file
    // (exercises byte 0x33, the document's layer count).
    const fixture = parse_aep(IMPORT_DIR.div("complex_comp.aep")).project;
    const ae = new Map<string, Uint8Array>();
    const sources: FileSource[] = [];
    for (const it of fixture.items.values()) {
      const source = getattr(it, "main_source", null);
      if (source instanceof FileSource) sources.push(source);
    }
    for (const s of sources) {
      if (getattr(s._opti, "asset_type", "") === "TEXT") {
        ae.set(as_instance(s._opti, TextOptiChunk).text_layer_name, s._opti.tobytes());
      }
    }
    const comp = as_instance(parse_aep(BASE).project.import_file(_comp_opts(ASSETS.div("complex.ai"))), CompItem);
    for (const layer of comp.layers) {
      const mine = _footage_source(layer).main_source._opti.tobytes();
      expect(py_eq(mine, getitem(ae, layer.name))).toBe(true);
    }
  });
});

/**
 * A PDF with OCGs A, B, C (in `/OCGs` order) listed in `/D /Order` as
 * `order` (indices into A, B, C), one filled rect per layer.
 */
function _three_layer_pdf(path: Path, order: number[]): void {
  const objs = new Map<number, string>();
  objs.set(
    1,
    "<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [5 0 R 6 0 R " +
      "7 0 R] /D << /Order [" +
      order.map((i) => `${5 + i} 0 R`).join(" ") +
      "] /ON [5 0 R 6 0 R 7 0 R] >> >> >>",
  );
  objs.set(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  objs.set(
    3,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Contents 4 0 R " +
      "/Resources << /Properties << /MC0 5 0 R /MC1 6 0 R /MC2 7 0 R >> >> >>",
  );
  const content = [0, 1, 2].map((i) => `/OC /MC${i} BDC 1 0 0 rg ${20 + 100 * i} 50 40 40 re f EMC\n`).join("");
  objs.set(4, `<< /Length ${content.length} >>\nstream\n${content}endstream`);
  for (const [i, name] of enumerate("ABC")) {
    objs.set(5 + i, `<< /Type /OCG /Name (${name}) >>`);
  }
  let out = b("%PDF-1.5\n");
  const offsets = new Map<number, number>();
  for (const number of sorted([...objs.keys()])) {
    offsets.set(number, out.length);
    out = concat(out, encode(`${number} 0 obj\n${getitem(objs, number)}\nendobj\n`, "latin-1"));
  }
  const xref = out.length;
  out = concat(out, b("xref\n0 8\n0000000000 65535 f \n"));
  out = concat(
    out,
    bytes_.join([1, 2, 3, 4, 5, 6, 7].map((n) => encode(`${String(getitem(offsets, n)).padStart(10, "0")} 00000 n \n`))),
  );
  out = concat(out, encode(`trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  path.write_bytes(out);
}

/**
 * AE 2026 stacks a layered PDF's layers top-down in `/D /Order`
 * sequence and stores each footage's layer index counted from the bottom
 * of that stack, whatever the `/OCGs` and paint order (measured with
 * `/Order` permutations that are neither `/OCGs` nor its reverse).
 */
describe("TestImportAiLayerOrder", () => {
  const rows: [number[], string[], Map<string, number>][] = [
    [[1, 2, 0], ["B", "C", "A"], new Map([["B", 2], ["C", 1], ["A", 0]])],
    [[2, 0, 1], ["C", "A", "B"], new Map([["C", 2], ["A", 1], ["B", 0]])],
  ];
  test.each(
    rows.flatMap((row): [number[], string[], Map<string, number>, ImportAsType][] => [
      [...row, ImportAsType.COMP],
      [...row, ImportAsType.COMP_CROPPED_LAYERS],
    ]),
  )(
    "test_order_decides_stacking_and_layer_index[%#]",
    (order, stack, indices, import_as) => {
      const tmp_path = make_tmp_path();
      const path = tmp_path.div("order.pdf");
      _three_layer_pdf(path, order);
      const options = new ImportOptions(path);
      options.import_as = import_as;
      const comp = as_instance(parse_aep(BASE).project.import_file(options), CompItem);
      expect(py_eq(comp.layers.map((layer) => layer.name), stack)).toBe(true);
      expect(
        py_eq(
          new Map(comp.layers.map((layer) => [layer.name, _footage_source(layer).main_source._sspc.layer_index] as const)),
          indices,
        ),
      ).toBe(true);
    },
  );
});

// NOTE(port): pytest.approx over a dict (ApproxMapping) requires equal key sets and compares values with ApproxScalar,
// which falls back to exact `==` for tuple values, so exact value comparison matches.
function approx_map<K, V>(actual: Map<K, V>, expected: Map<K, V>): boolean {
  return actual.size === expected.size && [...expected].every(([k, v]) => actual.has(k) && py_eq(actual.get(k), v));
}

/**
 * Layered Illustrator / PDF import as Composition - Retain Layer Sizes.
 *
 * Expected values are AE 2026's own `importFile(COMP_CROPPED_LAYERS)` of
 * the same files, read back through ExtendScript (15 significant digits):
 * `{layer: ((source w, h), (anchor x, y), (position x, y))}`.
 */
describe("TestImportAiCroppedComp", () => {
  const AE_AI = new Map<string, [number[], number[], number[]]>([
    ["Calque 2", [[1, 1], [7.62939453e-06, 7.62939453e-06], [0, 792]]],
    [
      "Calque 1",
      [
        [482, 437],
        [240.591522216797, 218.245864868164],
        [353.339508056641, 334.246841430664],
      ],
    ],
  ]);
  const AE_PROBE = new Map<string, [number[], number[], number[]]>([
    ["q_ctm_uniform2x", [[80, 20], [40, 10], [50, 40]]],
    ["q_ctm_nonuniform", [[160, 10], [80, 5], [80, 100]]],
    ["q_miter_m4", [[80, 60], [40, 30], [70, 180]]],
    ["q_evenodd", [[101, 61], [50.25, 30.25], [250, 170]]],
    [
      "q_font_no_descriptor",
      [[31, 28], [15.3359985351562, 13.8719940185547], [55.3359985351562, 291.52799987793]],
    ],
    [
      "q_font_widths_only",
      [[29, 28], [14.4000015258789, 13.8719940185547], [214.399993896484, 291.52799987793]],
    ],
    [
      "q_tz200",
      [[58, 28], [28.8000030517578, 13.8719940185547], [68.8000030517578, 341.52799987793]],
    ],
    [
      "q_tw20",
      [[127, 28], [63.1999969482422, 13.8719940185547], [263.199996948242, 341.52799987793]],
    ],
    [
      "q_tr3_invisible",
      [[58, 28], [28.8000030517578, 13.8719940185547], [68.8000030517578, 391.52799987793]],
    ],
    [
      "q_tr1_stroke",
      [[68, 38], [33.8000030517578, 18.8719940185547], [228.800003051758, 391.52799987793]],
    ],
    [
      "q_huge_coords",
      [[1, 1], [0.12500762939453, 0.12500762939453], [-0.12501525878906, 600.125015258789]],
    ],
    [
      "q_fill_stroke_thin",
      [[61, 61], [30.0399780273438, 30.0399780273438], [430, 370]],
    ],
    [
      "q_ascent_vs_fontbbox",
      [[58, 34], [28.8200073242188, 16.8200073242188], [68.8000030517578, 492.800003051758]],
    ],
    ["q_open_fill", [[61, 61], [30.25, 30.25], [430, 270]]],
    [
      "q_stroke_re",
      [[75, 55], [37.0710754394531, 27.0710754394531], [510, 540]],
    ],
    ["q_wild_cubic", [[301, 151], [150.25, 75.25], [90, 45]]],
    ["q_form_bbox", [[80, 60], [40, 30], [60, 550]]],
    ["q_image", [[50, 40], [25, 20], [225, 540]]],
    ["q_shading", [[81, 61], [40.25, 30.25], [340, 530]]],
    ["q_two_islands", [[211, 431], [105.25, 215.25], [125, 225]]],
    ["q_mixed_regimes", [[281, 261], [140.125, 130.125], [239.875, 370.125]]],
    ["q_empty", [[1, 1], [7.62939453e-06, 7.62939453e-06], [0, 600]]],
  ]);

  const _import = (path: Path): CompItem => {
    const options = new ImportOptions(path);
    options.import_as = ImportAsType.COMP_CROPPED_LAYERS;
    return as_instance(parse_aep(BASE).project.import_file(options), CompItem);
  };

  const _measure = (comp: CompItem): Map<string, [number[], number[], number[]]> => {
    const out = new Map<string, [number[], number[], number[]]>();
    for (const layer of comp.layers) {
      const anchor = layer.transform.__getitem__("ADBE Anchor Point").value;
      const position = layer.transform.__getitem__("ADBE Position").value;
      out.set(layer.name, [
        [as_instance(as_instance(layer, AVLayer).source, AVItem).width, as_instance(as_instance(layer, AVLayer).source, AVItem).height],
        [anchor[0], anchor[1]],
        [position[0], position[1]],
      ]);
    }
    return out;
  };

  test.each<[[number, number, number, number], number, number[], number[]]>([
    [
      [0, 0, 1, 1],
      792,
      [7.62939453125e-06, 7.62939453125e-06],
      [0.0, 792.0],
    ],
    [
      [7389053, 15696350, 38923864, 44302272],
      792,
      [240.59152221679688, 218.24586486816406],
      [353.3395080566406, 334.24684143066406],
    ],
    [
      [2621440, 19306906, 4631560, 21125136],
      600,
      [15.33599853515625, 13.871994018554688],
      [55.33599853515625, 291.5279998779297],
    ],
    [
      [30993870, 2158030, 35852850, 5706290],
      600,
      [37.071075439453125, 27.071075439453125],
      [510.0, 540.0],
    ],
    [
      [6537216, 6537216, 24903680, 23592960],
      600,
      [140.125, 130.125],
      [239.875, 370.125],
    ],
  ])(
    // AE's own stored opti box (16.16 edges) and the anchor / position
    // it gave the layer (read from AE's saved project, full precision).
    "test_placement_rule_on_after_effects_boxes[%#]",
    (raw_box, page_height, anchor, position) => {
      const [x0, y0, x1, y1] = raw_box;
      const box: [number, number, number, number] = [x0 / 65536, y0 / 65536, x1 / 65536, y1 / 65536];
      expect(py_eq(_ai_cropped_transform(box, page_height), [anchor, position])).toBe(true);
    },
  );

  test.each([
    ["ai.ai", AE_AI],
    ["ai_bounds_probe.pdf", AE_PROBE],
  ])("test_layers_match_after_effects[%#]", (asset: string, expected: Map<string, [number[], number[], number[]]>) => {
    const options = new ImportOptions(ASSETS.div(asset));
    expect(options.can_import_as(ImportAsType.COMP_CROPPED_LAYERS)).toBe(true);
    const got = _measure(_import(ASSETS.div(asset)));
    expect(py_eq([...got.keys()], [...expected.keys()])).toBe(true);
    for (const [name, [size, anchor, position]] of expected) {
      expect(py_eq(getitem(got, name)[0], size)).toBe(true);
      // py's measured artwork box can sit up to 2 16.16 quanta off AE's
      // (see `resolvers.ai_bounds`), hence the 4e-5 tolerance.
      expect(approx(getitem(got, name)[1], anchor, { abs: 4e-5 })).toBe(true);
      if (name === "q_huge_coords") {
        // AE sums the box edges near 32768 pt in 32 bits and wraps the
        // centre to (-0.125, 600.125); py keeps the true centre.
        continue;
      }
      expect(approx(getitem(got, name)[2], position, { abs: 4e-5 })).toBe(true);
    }
  });

  test("test_cropped_import_round_trips", () => {
    const tmp_path = make_tmp_path();
    const comp = _import(ASSETS.div("ai.ai"));
    const out = tmp_path.div("ai_cropped.aep");
    comp._project.save(out);
    const reparsed = as_instance(
      _next(parse_aep(out).project.items.values(), (item) => item instanceof CompItem && item.name === "ai"),
      CompItem,
    );
    expect(approx_map(_measure(reparsed), _measure(comp))).toBe(true);
    expect(
      py_eq(
        new Map(
          reparsed.layers.map(
            (layer) => [layer.name, as_instance(_footage_source(layer).main_source, FileSource).layer_name] as const,
          ),
        ),
        new Map([
          ["Calque 2", "Calque 2"],
          ["Calque 1", "Calque 1"],
        ]),
      ),
    ).toBe(true);
  });
});

/**
 * A layered .ai whose middle layer the document hides, vs AE ground truth.
 *
 * `ai_hidden_layer.ai` is a three-layer Illustrator file with `Hidden`
 * listed in `/OCProperties` `/D` `/OFF`; `ai_hidden_layer_comp.aep` is AE
 * 2026's own Import as Composition of it.
 */
describe("TestImportAiHiddenLayerComp", () => {
  const ASSET = "ai_hidden_layer.ai";
  const FIXTURE = "ai_hidden_layer_comp.aep";

  test("test_ae_gives_the_hidden_layer_its_video_switch_off", () => {
    // The ground truth this class is measured against.
    const fixture = parse_aep(IMPORT_DIR.div(FIXTURE)).project;
    const comp = as_instance(
      _next(fixture.items.values(), (it) => it instanceof CompItem && it.name === "ai_hidden_layer"),
      CompItem,
    );
    expect(py_eq(comp.layers.map((layer) => [layer.name, layer.enabled]), [
      ["Top", true],
      ["Hidden", false],
      ["Bottom", true],
    ])).toBe(true);
  });

  test("test_import_matches_that", () => {
    const project = parse_aep(BASE).project;
    const comp = as_instance(project.import_file(_comp_opts(ASSETS.div(ASSET))), CompItem);
    expect(py_eq(comp.layers.map((layer) => [layer.name, layer.enabled]), [
      ["Top", true],
      ["Hidden", false],
      ["Bottom", true],
    ])).toBe(true);
  });

  test("test_per_layer_opti_matches_ae", () => {
    const fixture = parse_aep(IMPORT_DIR.div(FIXTURE)).project;
    const project = parse_aep(BASE).project;
    const comp = as_instance(project.import_file(_comp_opts(ASSETS.div(ASSET))), CompItem);
    for (const layer of comp.layers) {
      const source = _footage_source(layer).main_source;
      py_assert(source instanceof FileSource);
      const mine = source._opti.tobytes();
      expect(py_eq(mine, _ae_layer_opti(fixture, layer.name))).toBe(true);
      expect(
        py_eq(mine, build_ai_layer_opti_data(200, 150, layer.name, 3, undefined, layer.name !== "Hidden")),
      ).toBe(true);
    }
  });

  test("test_a_hidden_layers_footage_is_still_a_layer_binding", () => {
    // Byte 0x3D of the opti is 0 for a hidden layer. Reading it as a
    // "references a layer" flag made the binding invisible: the item
    // reported no layer name, was named after the file instead of
    // `Hidden/<file>`, and a CURRENT_VALUE replace rejected it as
    // whole-document footage.
    const project = parse_aep(BASE).project;
    const comp = as_instance(project.import_file(_comp_opts(ASSETS.div(ASSET))), CompItem);
    const item = _footage_source(_next(comp.layers, (layer) => layer.name === "Hidden"));
    const source = item.main_source;
    py_assert(source instanceof FileSource);
    expect(source._opti.tobytes()[0x3d]).toBe(0);
    expect(source.layer_name).toBe("Hidden");
    expect(item.name).toBe("Hidden/ai_hidden_layer.ai");
  });

  test("test_replacing_a_hidden_binding_keeps_the_layer", () => {
    const project = parse_aep(BASE).project;
    const comp = as_instance(project.import_file(_comp_opts(ASSETS.div(ASSET))), CompItem);
    const item = _footage_source(_next(comp.layers, (layer) => layer.name === "Hidden"));

    item.replace(ASSETS.div(ASSET), CURRENT_VALUE, CURRENT_VALUE);

    const source = item.main_source;
    py_assert(source instanceof FileSource);
    expect(source.layer_name).toBe("Hidden");
    expect(source._sspc.layer_index).toBe(1);
    expect(source._opti.tobytes()[0x3d]).toBe(0);
  });

  test("test_roundtrip_byte_identical", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(BASE).project;
    project.import_file(_comp_opts(ASSETS.div(ASSET)));
    const out = tmp_path.div("hidden.aep");
    project.save(out);
    const out2 = tmp_path.div("hidden2.aep");
    parse_aep(out).project.save(out2);
    expect(py_eq(out.read_bytes(), out2.read_bytes())).toBe(true);
  });
});

/**
 * EPS import as a composition, vs AE 2026 ground truth.
 *
 * EPS is single-stream PostScript with no Optional Content Groups, so AE
 * rasterizes it to a one-layer comp (confirmed: AE 2026 imports eps.eps as a
 * 1-layer comp). Unlike a real AI layer, the footage carries the bare TEXT
 * opti (no per-layer name/index/bbox).
 */
describe("TestImportEpsComp", () => {
  test("test_import_structure", () => {
    const project = parse_aep(BASE).project;
    const comp = project.import_file(_comp_opts(ASSETS.div("eps.eps")));
    py_assert(comp instanceof CompItem);
    expect(comp.name).toBe("eps");
    expect(py_eq([comp.width, comp.height], [1921, 2881])).toBe(true);
    expect(py_eq(comp.layers.map((layer) => layer.name), ["eps.eps"])).toBe(true);
    const folders = Array.from(project.items.values()).filter(
      (it) => it instanceof FolderItem && it.name === "eps Layers",
    );
    expect(folders.length).toBe(1);
    const footage = as_instance(folders[0], FolderItem).items;
    expect(footage.length).toBe(1);
    const source = as_instance(footage[0], FootageItem).main_source;
    py_assert(source instanceof FileSource);
    expect(source.file.endsWith("eps.eps")).toBe(true);
  });

  test("test_opti_is_bare_text", () => {
    // The footage opti is the plain TEXT body (dimensions only); the
    // per-layer name/index/bbox an AI layer carries stay zero. Byte-matched
    // against AE 2026's eps.eps comp import.
    const project = parse_aep(BASE).project;
    const comp = as_instance(project.import_file(_comp_opts(ASSETS.div("eps.eps"))), CompItem);
    const source = _footage_source(comp.layers[0]).main_source;
    py_assert(source instanceof FileSource);
    expect(source._sspc.source_format_type).toBe("TEXT");
    expect(py_eq(source._opti.tobytes(), build_text_opti_data(1921, 2881))).toBe(true);
  });

  test("test_layer_name_not_set", () => {
    // The single layer is named after the source item, so AE leaves the
    // ldta name_set bit off (verified against AE's import).
    const comp = as_instance(parse_aep(BASE).project.import_file(_comp_opts(ASSETS.div("eps.eps"))), CompItem);
    expect(comp.layers[0]._ldta.name_set).toBe(false);
  });

  test("test_roundtrip_byte_identical", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(BASE).project;
    project.import_file(_comp_opts(ASSETS.div("eps.eps")));
    const out = tmp_path.div("eps_comp.aep");
    project.save(out);
    const out2 = tmp_path.div("eps_comp2.aep");
    parse_aep(out).project.save(out2);
    expect(py_eq(out.read_bytes(), out2.read_bytes())).toBe(true);
  });
});

/**
 * Layered Photoshop (.psd/.psb) import as a composition, vs AE ground truth.
 *
 * `8bits.psd`/`.psb` both have two layers: "black" (lyid 3, bottom) and
 * "white with mask" (lyid 4, top), on a 25x26 canvas.
 */
describe("TestImportPsdComp", () => {
  test.each(["8bits.psd", "8bits.psb"])("test_read_psd_layers_document_order[%#]", (name: string) => {
    const layers = read_psd_layers(ASSETS.div(name));
    expect(py_eq(layers.map((layer) => [layer.name, layer.layer_id]), [
      ["black", 3],
      ["white with mask", 4],
    ])).toBe(true);
  });

  test("test_read_psd_layers_bad_signature_raises", () => {
    raises(UnsupportedPsdLayersError, () => {
      read_psd_layers(ASSETS.div("image_with_alpha.png"));
    });
  });

  test.each(["8bits.psd", "8bits.psb"])("test_import_structure[%#]", (name: string) => {
    const project = parse_aep(BASE).project;
    const comp = as_instance(project.import_file(_comp_opts(ASSETS.div(name))), CompItem);
    expect(comp.name).toBe("8bits");
    expect(py_eq([comp.width, comp.height], [25, 26])).toBe(true);
    // Footage layers, stacked top layer first (reverse document order).
    expect(py_eq(comp.layers.map((layer) => layer.name), ["white with mask", "black"])).toBe(true);
    const folders = Array.from(project.items.values()).filter(
      (it) => it instanceof FolderItem && it.name === "8bits Layers",
    );
    expect(folders.length).toBe(1);
    const footage = as_instance(folders[0], FolderItem).items;
    expect(footage.length).toBe(2);
    for (const item of footage) {
      const source = as_instance(item, FootageItem).main_source;
      py_assert(source instanceof FileSource);
      expect(source.file.endsWith(name)).toBe(true);
    }
  });

  test.each([
    ["8bits.psd", "psd_comp.aep"],
    ["8bits.psb", "psb_comp.aep"],
  ])("test_per_layer_opti_matches_ae[%#]", (name: string, fixture: string) => {
    const info = probe_media(ASSETS.div(name));
    const layers = read_psd_layers(ASSETS.div(name));
    const fixture_project = parse_aep(IMPORT_DIR.div(fixture)).project;
    const project = parse_aep(BASE).project;
    const comp = as_instance(project.import_file(_comp_opts(ASSETS.div(name))), CompItem);
    const index_by_name = new Map<string, number>(layers.map((layer, i) => [layer.name, i]));
    for (const comp_layer of comp.layers) {
      const source = _footage_source(comp_layer).main_source;
      py_assert(source instanceof FileSource);
      const buffer = new BytesIO();
      source._opti.write(buffer);
      const mine = buffer.getvalue();
      const psd_layer = layers[getitem(index_by_name, comp_layer.name)];
      expect(
        py_eq(
          mine,
          build_psd_layer_opti_data(
            info.width,
            info.height,
            info.bit_depth,
            layers.length,
            getitem(index_by_name, comp_layer.name),
            psd_layer.layer_id,
            comp_layer.name,
            as_instance(psd_layer, PsdLayer).bounds,
          ),
        ),
      ).toBe(true);
      expect(py_eq(mine, _ae_psd_layer_opti(fixture_project, comp_layer.name))).toBe(true);
    }
  });

  test.each(["8bits.psd", "8bits.psb"])("test_roundtrip_byte_identical[%#]", (name: string) => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(BASE).project;
    project.import_file(_comp_opts(ASSETS.div(name)));
    const out = tmp_path.div("comp.aep");
    project.save(out);
    const out2 = tmp_path.div("comp2.aep");
    parse_aep(out).project.save(out2);
    expect(py_eq(out.read_bytes(), out2.read_bytes())).toBe(true);
  });


  test("test_comp_and_layer_metadata_matches_ae", () => {
    // Comp shutter phase and per-layer ldta flags match AE's import (these
    // come from the shared AVLayer/add_comp path the .ai import also uses).
    const fixture = parse_aep(IMPORT_DIR.div("psd_comp.aep")).project;
    const ae_comp = as_instance(
      _next(fixture.items.values(), (it) => it instanceof CompItem && it.name === "8bits"),
      CompItem,
    );
    const comp = as_instance(parse_aep(BASE).project.import_file(_comp_opts(ASSETS.div("8bits.psd"))), CompItem);
    expect(comp.shutter_phase).toBe(-90);
    expect(ae_comp.shutter_phase).toBe(-90);
    for (const [layer, ae_layer] of zip(comp.layers, ae_comp.layers)) {
      expect(layer._ldta._reserved_3b).toBe(1);
      expect(ae_layer._ldta._reserved_3b).toBe(1);
      expect(layer._ldta._reserved_3c).toBe(0);
      expect(ae_layer._ldta._reserved_3c).toBe(0);
      expect(layer._ldta.name_set).toBe(true);
      expect(ae_layer._ldta.name_set).toBe(true);
    }
  });
});

/** Serialized opti of the single merged 8BPS footage in a flattened import. */
function _flattened_footage_opti(project: Project): Uint8Array {
  for (const item of project.items.values()) {
    const source = getattr(item, "main_source", null);
    if (source instanceof FileSource && getattr(source._opti, "asset_type", "") === "8BPS") {
      return _opti_bytes(source);
    }
  }
  throw new AssertionError_("no 8BPS footage found");
}

/**
 * Flattened (layerless) PSD import as a one-layer composition.
 *
 * AE 2026 imports a flattened `.psd`/`.psb` as COMP by creating a one-layer
 * composition of the merged still: a `<stem> Layers` folder with one footage
 * item and a comp with a single full-canvas layer named after the file
 * (verified headless against AE 2026; fixture `flattened_rgb_comp.aep`).
 * `flattened_rgb.psd` is a real 25x26 RGB Photoshop flatten (present
 * layer/mask section, layer count 0); `flattened.psd` is the other flavor (a
 * 0-length layer/mask section) that the parser must not crash on.
 */
describe("TestImportPsdFlattened", () => {
  test.each(["flattened.psd", "flattened_rgb.psd"])("test_read_psd_layers_flattened_raises[%#]", (name: string) => {
    // Both flattened encodings must raise cleanly (not crash on 0-length).
    raises(FlattenedPsdError, () => {
      read_psd_layers(ASSETS.div(name));
    });
    expect(FlattenedPsdError.prototype instanceof UnsupportedPsdLayersError).toBe(true);
  });

  test("test_import_structure", () => {
    const project = parse_aep(BASE).project;
    const comp = as_instance(project.import_file(_comp_opts(ASSETS.div("flattened_rgb.psd"))), CompItem);
    expect(comp.name).toBe("flattened_rgb");
    expect(py_eq([comp.width, comp.height], [25, 26])).toBe(true);
    expect(comp.shutter_phase).toBe(-90);
    expect(py_eq(comp.layers.map((layer) => layer.name), ["flattened_rgb.psd"])).toBe(true);
    const folders = Array.from(project.items.values()).filter(
      (it) => it instanceof FolderItem && it.name === "flattened_rgb Layers",
    );
    expect(folders.length).toBe(1);
    const footage = as_instance(folders[0], FolderItem).items;
    expect(footage.length).toBe(1);
    const source = as_instance(footage[0], FootageItem).main_source;
    py_assert(source instanceof FileSource);
    expect(source.file.endsWith("flattened_rgb.psd")).toBe(true);
  });

  test("test_cropped_import_also_one_layer", () => {
    // A flattened file has a single full-canvas layer, so COMP_CROPPED_LAYERS
    // yields the same one-layer comp as COMP (AE 2026 verified).
    const project = parse_aep(BASE).project;
    const comp = as_instance(project.import_file(_cropped_opts(ASSETS.div("flattened_rgb.psd"))), CompItem);
    expect(py_eq(comp.layers.map((layer) => layer.name), ["flattened_rgb.psd"])).toBe(true);
    expect(py_eq([comp.width, comp.height], [25, 26])).toBe(true);
  });

  test("test_opti_matches_ae", () => {
    const info = probe_media(ASSETS.div("flattened_rgb.psd"));
    const project = parse_aep(BASE).project;
    const comp = as_instance(project.import_file(_comp_opts(ASSETS.div("flattened_rgb.psd"))), CompItem);
    const source = _footage_source(comp.layers[0]).main_source;
    py_assert(source instanceof FileSource);
    const mine = _opti_bytes(source);
    expect(
      py_eq(mine, build_psd_flattened_opti_data(info.width, info.height, info.bit_depth, info.pixel_channels)),
    ).toBe(true);
    // Gold standard: byte-identical to AE 2026's own flattened-import opti.
    const fixture = parse_aep(IMPORT_DIR.div("flattened_rgb_comp.aep")).project;
    expect(py_eq(mine, _flattened_footage_opti(fixture))).toBe(true);
  });

  test("test_roundtrip_byte_identical", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(BASE).project;
    project.import_file(_comp_opts(ASSETS.div("flattened_rgb.psd")));
    const out = tmp_path.div("comp.aep");
    project.save(out);
    const out2 = tmp_path.div("comp2.aep");
    parse_aep(out).project.save(out2);
    expect(py_eq(out.read_bytes(), out2.read_bytes())).toBe(true);
  });
});

/**
 * COMP_CROPPED_LAYERS for layered PSD, vs AE ground truth.
 *
 * `layer_bounds.psd` is a 60x40 doc whose three layers occupy distinct content
 * boxes: "red box" (lyid 2, L4 T6 R24 B20), "green box" (lyid 3, L30 T10 R55
 * B34), "blue dot" (lyid 4, L12 T24 R22 B36).
 */
describe("TestImportPsdCropped", () => {
  test("test_read_layer_bounds", () => {
    const layers = read_psd_layers(ASSETS.div("layer_bounds.psd"));
    expect(
      py_eq(layers.map((layer) => [layer.name, layer.layer_id, as_instance(layer, PsdLayer).bounds]), [
        ["red box", 2, [4, 6, 24, 20]],
        ["green box", 3, [30, 10, 55, 34]],
        ["blue dot", 4, [12, 24, 22, 36]],
      ]),
    ).toBe(true);
  });

  test("test_cropped_structure", () => {
    const project = parse_aep(BASE).project;
    const comp = as_instance(project.import_file(_cropped_opts(ASSETS.div("layer_bounds.psd"))), CompItem);
    expect(comp.name).toBe("layer_bounds");
    expect(py_eq([comp.width, comp.height], [60, 40])).toBe(true);
    expect(py_eq(comp.layers.map((layer) => layer.name), ["blue dot", "green box", "red box"])).toBe(true);
    const footage = _psd_footage(project);
    // Each footage item is cropped to its layer's content box.
    expect(py_eq([getitem(footage, "red box").width, getitem(footage, "red box").height], [20, 14])).toBe(true);
    expect(py_eq([getitem(footage, "green box").width, getitem(footage, "green box").height], [25, 24])).toBe(true);
    expect(py_eq([getitem(footage, "blue dot").width, getitem(footage, "blue dot").height], [10, 12])).toBe(true);
  });

  test("test_cropped_matches_ae", () => {
    // Per-layer opti, footage dims, and layer anchor/position match AE.
    const fixture = parse_aep(IMPORT_DIR.div("layer_bounds_cropped.aep")).project;
    const ae_footage = _psd_footage(fixture);
    const ae_comp = as_instance(
      _next(fixture.items.values(), (it) => it instanceof CompItem && it.name === "layer_bounds"),
      CompItem,
    );
    const ae_xform = new Map(ae_comp.layers.map((layer) => [layer.name, layer.transform] as const));

    const project = parse_aep(BASE).project;
    const comp = as_instance(project.import_file(_cropped_opts(ASSETS.div("layer_bounds.psd"))), CompItem);
    for (const layer of comp.layers) {
      const source = _footage_source(layer).main_source;
      py_assert(source instanceof FileSource);
      expect(py_eq(_opti_bytes(source), _opti_bytes(as_instance(getitem(ae_footage, layer.name).main_source, FileSource)))).toBe(true);
      expect(
        py_eq(
          [source._sspc.width, source._sspc.height],
          [
            getitem(ae_footage, layer.name).main_source._sspc.width,
            getitem(ae_footage, layer.name).main_source._sspc.height,
          ],
        ),
      ).toBe(true);
      for (const prop of ["ADBE Anchor Point", "ADBE Position"] as const) {
        expect(
          py_eq(layer.transform.__getitem__(prop).value, getitem(ae_xform, layer.name).__getitem__(prop).value),
        ).toBe(true);
      }
    }
  });

  test("test_cropped_roundtrip_byte_identical", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(BASE).project;
    project.import_file(_cropped_opts(ASSETS.div("layer_bounds.psd")));
    const out = tmp_path.div("cropped.aep");
    project.save(out);
    const out2 = tmp_path.div("cropped2.aep");
    parse_aep(out).project.save(out2);
    expect(py_eq(out.read_bytes(), out2.read_bytes())).toBe(true);
  });

  test("test_margined_comp_opti_uses_content_bounds", () => {
    // A whole-canvas (COMP) import of margined layers keeps full-size footage
    // but stores each layer's content box in the opti (guards the bbox fix).
    const fixture = parse_aep(IMPORT_DIR.div("layer_bounds_comp.aep")).project;
    const ae_footage = _psd_footage(fixture);
    const project = parse_aep(BASE).project;
    const comp = as_instance(project.import_file(_comp_opts(ASSETS.div("layer_bounds.psd"))), CompItem);
    for (const layer of comp.layers) {
      const source = _footage_source(layer).main_source;
      py_assert(source instanceof FileSource);
      expect(py_eq([source._sspc.width, source._sspc.height], [60, 40])).toBe(true);
      expect(py_eq(_opti_bytes(source), _opti_bytes(as_instance(getitem(ae_footage, layer.name).main_source, FileSource)))).toBe(true);
    }
  });

  test("test_sspc_full_frame_flag_matches_ae", () => {
    // AE tags file footage with a reserved template at 0xC4:0xCA; byte 0xC7
    // is 1 for full-frame footage and 0 for a cropped layer region.
    const project = parse_aep(BASE).project;
    const item = as_instance(project.import_file(new ImportOptions(ASSETS.div("image_with_alpha.png"))), FootageItem);
    py_assert(item.main_source instanceof FileSource);
    expect(py_eq(_sspc_bytes(item.main_source).slice(0xc4, 0xca), b("\x00\x00\x00\x01\x00\x02"))).toBe(true);

    const cropped = as_instance(parse_aep(BASE).project.import_file(_cropped_opts(ASSETS.div("layer_bounds.psd"))), CompItem);
    for (const layer of cropped.layers) {
      const source = _footage_source(layer).main_source;
      py_assert(source instanceof FileSource);
      expect(py_eq(_sspc_bytes(source).slice(0xc4, 0xca), b("\x00\x00\x00\x00\x00\x02"))).toBe(true);
    }
  });
});

/**
 * Grouped/complex PSDs. AE imports a layer group as a nested composition
 * and flags adjustment layers. `grouped_layers.psd` has a group ("MyGroup"
 * with "in group A"/"in group B"), plus text, smart-object, adjustment,
 * masked, and plain raster layers and an alpha channel.
 */
describe("TestImportPsdGroups", () => {
  test("test_read_layers_returns_group_tree", () => {
    const nodes = read_psd_layers(ASSETS.div("grouped_layers.psd"));
    // Top level, bottom first: plain, masked, text, smart, adjustment, then
    // the "MyGroup" group on top.
    expect(py_eq(nodes.map((n) => n.name), ["plain raster", "masked raster", "my text", "smart obj", "hue/sat adj", "MyGroup"])).toBe(true);
    const group = nodes[nodes.length - 1];
    py_assert(group instanceof PsdGroup);
    expect(py_eq(group.children.map((child) => child.name), ["in group A", "in group B"])).toBe(true);
    // Adjustment detection.
    const adj = _next(nodes, (n) => n.name === "hue/sat adj");
    py_assert(adj instanceof PsdLayer);
    expect(adj.is_adjustment).toBe(true);
  });

  test("test_build_layer_tree_nested", () => {
    // Pure tree builder on a synthetic nested-group record list (bottom
    // first): bg, [Outer: [Inner: x], y], top.
    const rec = (name: string, lsct = 0, idx = 0) => new _Record(name, idx, [0, 0, 0, 0], idx, lsct, false);

    const records = [
      rec("bg", 0, 0),
      rec("<outer>", 3, 1),
      rec("<inner>", 3, 2),
      rec("x", 0, 3),
      rec("Inner", 1, 4),
      rec("y", 0, 5),
      rec("Outer", 1, 6),
      rec("top", 0, 7),
    ];
    const tree = _build_layer_tree(records);
    expect(py_eq(tree.map((n) => n.name), ["bg", "Outer", "top"])).toBe(true);
    const outer = tree[1];
    py_assert(outer instanceof PsdGroup);
    expect(py_eq(outer.children.map((n) => n.name), ["Inner", "y"])).toBe(true);
    const inner = outer.children[0];
    py_assert(inner instanceof PsdGroup);
    expect(py_eq(inner.children.map((n) => n.name), ["x"])).toBe(true);
  });

  test("test_group_becomes_nested_comp", () => {
    const project = parse_aep(BASE).project;
    const comp = as_instance(project.import_file(_comp_opts(ASSETS.div("grouped_layers.psd"))), CompItem);
    expect(comp.name).toBe("grouped_layers");
    // MyGroup is a nested-comp layer; the adjustment layer is flagged.
    const info = new Map(comp.layers.map((layer) => [layer.name, layer] as const));
    const my_group = as_instance(getitem(info, "MyGroup"), AVLayer);
    py_assert(my_group.source instanceof CompItem);
    expect(py_eq(my_group.source.layers.map((layer) => layer.name), ["in group B", "in group A"])).toBe(true);
    expect(getitem(info, "hue/sat adj").adjustment_layer).toBe(true);
    expect(getitem(info, "plain raster").adjustment_layer).toBe(false);
  });

  test("test_group_matches_ae", () => {
    // Main + nested comp layer structure and per-leaf opti match AE.
    const fixture = parse_aep(IMPORT_DIR.div("grouped_layers_comp.aep")).project;
    const ae_main = as_instance(
      _next(fixture.items.values(), (it) => it instanceof CompItem && it.name === "grouped_layers"),
      CompItem,
    );
    const project = parse_aep(BASE).project;
    const comp = as_instance(project.import_file(_comp_opts(ASSETS.div("grouped_layers.psd"))), CompItem);
    expect(py_eq(comp.layers.map((layer) => layer.name), ae_main.layers.map((layer) => layer.name))).toBe(true);
    for (const [layer, ae_layer] of zip(comp.layers, ae_main.layers)) {
      expect(layer.adjustment_layer).toBe(ae_layer.adjustment_layer);
      // AE collapses the group precomp and leaves its layer name unset.
      expect(as_instance(layer, AVLayer).collapse_transformation).toBe(as_instance(ae_layer, AVLayer).collapse_transformation);
      expect(layer._ldta.name_set).toBe(ae_layer._ldta.name_set);
    }
    const ae_footage = _psd_footage(fixture);
    const mine_footage = _psd_footage(project);
    for (const [name, source] of mine_footage) {
      expect(py_eq(_opti_bytes(as_instance(source.main_source, FileSource)), _opti_bytes(as_instance(getitem(ae_footage, name).main_source, FileSource)))).toBe(true);
    }
  });

  test("test_grouped_roundtrip_byte_identical", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(BASE).project;
    project.import_file(_comp_opts(ASSETS.div("grouped_layers.psd")));
    const out = tmp_path.div("g.aep");
    project.save(out);
    const out2 = tmp_path.div("g2.aep");
    parse_aep(out).project.save(out2);
    expect(py_eq(out.read_bytes(), out2.read_bytes())).toBe(true);
  });

  test("test_grouped_cropped_import", () => {
    // COMP_CROPPED_LAYERS on a grouped PSD: still builds the nested comp.
    const project = parse_aep(BASE).project;
    const comp = as_instance(project.import_file(_cropped_opts(ASSETS.div("grouped_layers.psd"))), CompItem);
    const my_group = as_instance(_next(comp.layers, (layer) => layer.name === "MyGroup"), AVLayer);
    expect(my_group.source instanceof CompItem).toBe(true);
  });

  test("test_grouped_cropped_matches_ae", () => {
    // Every per-layer footage of a grouped cropped import matches AE
    // byte-for-byte (opti + sspc modulo noise). This pins the empty
    // ADJUSTMENT layer "hue/sat adj": full-canvas (80x60, not 1x1) with
    // opti channels 0 (no pixels), distinct from an empty raster.
    const ae_project = parse_aep(IMPORT_DIR.div("grouped_layers_cropped.aep")).project;
    const project = parse_aep(BASE).project;
    project.import_file(_cropped_opts(ASSETS.div("grouped_layers.psd")));
    const ae_foot = new Map<string, FileSource>();
    for (const i of ae_project.items.values()) {
      if (i instanceof FootageItem && i.main_source instanceof FileSource) ae_foot.set(i.name, i.main_source);
    }
    const py_foot = new Map<string, FileSource>();
    for (const i of project.items.values()) {
      if (i instanceof FootageItem && i.main_source instanceof FileSource) py_foot.set(i.name, i.main_source);
    }
    expect(py_eq(new Set(ae_foot.keys()), new Set(py_foot.keys()))).toBe(true);
    for (const [name, ae_src] of ae_foot) {
      const py_src = getitem(py_foot, name);
      expect(py_eq(py_src._opti.tobytes(), ae_src._opti.tobytes())).toBe(true);
      _assert_sspc_matches(_sspc_bytes(ae_src), _sspc_bytes(py_src));
    }
    const adj = getitem(py_foot, "hue/sat adj/grouped_layers.psd");
    expect(py_eq([adj._width, adj._height], [80, 60])).toBe(true);
    expect(as_instance(adj._opti, PsdOptiChunk).psd_layer_channels).toBe(0);
  });
});

/**
 * The `<stem> Layers` folder is stored case-insensitive alphabetically by
 * item name (the AE Project-panel order), not the document order py_aep builds
 * the items in. Verified against the grouped_layers / layer_bounds AE fixtures
 * (whose stored Sfdr order matches the alphabetical sort, not the item ids).
 */
describe("TestLayeredImportFolderOrder", () => {
  const _folder_order = (project: Project): string[] => {
    const folder = as_instance(
      _next(project.items.values(), (it) => it instanceof FolderItem && it.name.endsWith(" Layers")),
      FolderItem,
    );
    return folder.items.map((it) => it.name);
  };

  test("test_grouped_layers_matches_ae", () => {
    // The "MyGroup" nested comp is interleaved alphabetically among the
    // footage ("my text" < "MyGroup" because space < "g"), not front-inserted.
    const fixture = parse_aep(IMPORT_DIR.div("grouped_layers_comp.aep")).project;
    const project = parse_aep(BASE).project;
    project.import_file(_comp_opts(ASSETS.div("grouped_layers.psd")));
    expect(py_eq(_folder_order(project), _folder_order(fixture))).toBe(true);
    expect(
      py_eq(_folder_order(project), [
        "hue/sat adj/grouped_layers.psd",
        "in group A/grouped_layers.psd",
        "in group B/grouped_layers.psd",
        "masked raster/grouped_layers.psd",
        "my text/grouped_layers.psd",
        "MyGroup",
        "plain raster/grouped_layers.psd",
        "smart obj/grouped_layers.psd",
      ]),
    ).toBe(true);
  });

  test("test_layer_bounds_is_alphabetical_not_document_order", () => {
    // Document order is red, green, blue; AE stores blue, green, red - so
    // this pins the alphabetical sort rather than document/append order.
    const fixture = parse_aep(IMPORT_DIR.div("layer_bounds_comp.aep")).project;
    const project = parse_aep(BASE).project;
    project.import_file(_comp_opts(ASSETS.div("layer_bounds.psd")));
    expect(
      py_eq(_folder_order(project), [
        "blue dot/layer_bounds.psd",
        "green box/layer_bounds.psd",
        "red box/layer_bounds.psd",
      ]),
    ).toBe(true);
    expect(py_eq(_folder_order(project), _folder_order(fixture))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Chosen-layer footage import ("Choose Layer" in AE's import dialog)
// ---------------------------------------------------------------------------

// sspc byte offsets where py's still-image imports are known to diverge from
// AE 2026: time divisors (0x2C-0x2D), an undecoded still-import flag byte
// (0x4F), an unknown byte AE moves between 0x71 and 0x72 across
// import/replace, and the source-modified stamp (0x74-0x7C). The depth
// (0x3E-0x41), the media flag (0x70) and the layer-binding region (0xBC-0xD3)
// are deliberately NOT masked.
const _SSPC_NOISE = new Set<number>([0x2c, 0x2d, 0x4f, 0x71, 0x72, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x7b, 0x7c]);

function _layer_opts(file: Path, layer: number | null = null, dims: string | null = null): ImportOptions {
  const opts = new ImportOptions(file);
  if (layer != null) opts.layer_index = layer;
  if (dims != null) opts.layer_dimensions = dims;
  return opts;
}

/** (item name, sspc bytes, opti bytes, post-sspc Pin Utf8) of the single file footage item. */
function _footage_parts(project: Project): [string, Uint8Array, Uint8Array, string] {
  for (const item of project.items.values()) {
    if (item instanceof FootageItem && item.main_source instanceof FileSource) {
      const src = item.main_source;
      const pin = src._pin.chunks;
      const sspc_i = pin.findIndex((c) => c.chunk_type === "sspc");
      return [item.name, _sspc_bytes(src), src._opti.tobytes(), as_instance(pin[sspc_i + 1], Utf8Chunk).value];
    }
  }
  throw new AssertionError_("no file footage item in project");
}

function _assert_sspc_matches(ae: Uint8Array, mine: Uint8Array, extra_noise: Set<number> = new Set()): void {
  expect(ae.length).toBe(mine.length);
  const noise = new Set([..._SSPC_NOISE, ...extra_noise]);
  const diffs = Array.from({ length: ae.length }, (_, off) => off)
    .filter((off) => !noise.has(off) && ae[off] !== mine[off])
    .map(
      (off) =>
        `0x${off.toString(16).padStart(3, "0")}: ae=${ae[off].toString(16).padStart(2, "0")} py=${mine[off].toString(16).padStart(2, "0")}`,
    );
  expect(diffs).toEqual([]);
}

/**
 * FOOTAGE import of a single layer, vs AE 2026 chooser fixtures.
 *
 * `choose_layer.psd` is a 60x40 RGB/8 doc; bottom-to-top: `solo` (lyid 2,
 * L4 T6 R24 B20), `twin` (lyid 3), group `grp` holding `inner` (lyid 6),
 * `twin` (lyid 4). The duplicate `twin` names are intentional.
 * `list_layers` (top first): `["twin", "inner", "twin", "solo"]`, so
 * `solo` is index 3 and `inner` index 1.
 */
describe("TestChooseLayerImport", () => {
  test.each([
    ["choose_layer_merged.aep", "choose_layer.psd", null, null],
    ["choose_layer_solo_doc.aep", "choose_layer.psd", 3, null],
    ["choose_layer_solo_doc.aep", "choose_layer.psd", 3, "document"],
    ["choose_layer_solo_layer.aep", "choose_layer.psd", 3, "layer"],
    ["choose_layer_inner.aep", "choose_layer.psd", 1, null],
    ["ai_choose_layer.aep", "ai.ai", 0, null],
  ])(
    "test_matches_ae_fixture[%#]",
    (fixture: string, asset: string, layer: number | null, dims: string | null) => {
      // Name-matched byte parity of the necessary chunks: opti and the
      // post-sspc Utf8 exactly, sspc outside the known still-import noise.
      const [ae_name, ae_sspc, ae_opti, ae_utf8] = _footage_parts(parse_aep(IMPORT_DIR.div(fixture)).project);
      const project = parse_aep(BASE).project;
      project.import_file(_layer_opts(ASSETS.div(asset), layer, dims));
      const [name, sspc, opti, utf8] = _footage_parts(project);
      expect(name).toBe(ae_name);
      expect(py_eq(opti, ae_opti)).toBe(true);
      expect(utf8).toBe(ae_utf8);
      _assert_sspc_matches(ae_sspc, sspc);
    },
  );

  test("test_layer_size_dimensions", () => {
    const project = parse_aep(BASE).project;
    const item = project.import_file(_layer_opts(ASSETS.div("choose_layer.psd"), 3, "layer"));
    // solo content box is L4 T6 R24 B20 -> 20x14.
    expect(py_eq([item.width, item.height], [20, 14])).toBe(true);
  });

  test("test_source_layer_name_property", () => {
    const project = parse_aep(BASE).project;
    const item = project.import_file(_layer_opts(ASSETS.div("choose_layer.psd"), 3));
    py_assert(item instanceof FootageItem);
    const source = item.main_source;
    py_assert(source instanceof FileSource);
    expect(source.layer_name).toBe("solo");
    const merged = project.import_file(_layer_opts(ASSETS.div("choose_layer.psd")));
    py_assert(merged instanceof FootageItem);
    const merged_source = merged.main_source;
    py_assert(merged_source instanceof FileSource);
    expect(merged_source.layer_name).toBe("");
  });

  test("test_duplicate_names_disambiguated_by_index", () => {
    // Both `twin` layers (indices 0 and 2, lyid 4 and 3) are
    // individually addressable - the reason selection is by index.
    const project = parse_aep(BASE).project;
    const top = project.import_file(_layer_opts(ASSETS.div("choose_layer.psd"), 0));
    const bottom = project.import_file(_layer_opts(ASSETS.div("choose_layer.psd"), 2));
    py_assert(top instanceof FootageItem && bottom instanceof FootageItem);
    const top_source = top.main_source;
    const bottom_source = bottom.main_source;
    py_assert(top_source instanceof FileSource);
    py_assert(bottom_source instanceof FileSource);
    expect(top_source.layer_name).toBe("twin");
    expect(bottom_source.layer_name).toBe("twin");
    expect(top_source._sspc.layer_id).toBe(4);
    expect(bottom_source._sspc.layer_id).toBe(3);
  });

  test("test_out_of_range_layer_index_raises", () => {
    const project = parse_aep(BASE).project;
    raises(
      ValueError,
      () => {
        project.import_file(_layer_opts(ASSETS.div("choose_layer.psd"), 4));
      },
      "layer_index 4 out of range",
    );
  });

  test("test_layer_index_with_comp_import_raises", () => {
    const opts = _layer_opts(ASSETS.div("choose_layer.psd"), 3);
    opts.import_as = ImportAsType.COMP;
    raises(
      ValueError,
      () => {
        parse_aep(BASE).project.import_file(opts);
      },
      "FOOTAGE only",
    );
  });

  test("test_layer_index_with_sequence_raises", () => {
    const opts = _layer_opts(ASSETS.div("choose_layer.psd"), 3);
    opts.sequence = true;
    raises(
      ValueError,
      () => {
        parse_aep(BASE).project.import_file(opts);
      },
      "sequence",
    );
  });

  test("test_layer_dimensions_without_layer_index_raises", () => {
    const opts = new ImportOptions(ASSETS.div("choose_layer.psd"));
    opts.layer_dimensions = "layer";
    raises(
      ValueError,
      () => {
        parse_aep(BASE).project.import_file(opts);
      },
      "requires layer_index",
    );
  });

  test("test_layer_index_non_layered_file_raises", () => {
    const project = parse_aep(BASE).project;
    raises(
      ValueError,
      () => {
        project.import_file(_layer_opts(ASSETS.div("image_with_alpha.png"), 0));
      },
      "layered",
    );
  });

  test("test_ai_layer_size_reproduces_the_ae_import", () => {
    // `ai.ai`'s Calque 1 is `list_layers` index 1 (top layer first). The
    // whole binding lives in the opti box, which AE never recomputes, so
    // compare against AE's own bytes rather than against our own maths.
    const [ae_name, ae_sspc, ae_opti] = _footage_parts(parse_aep(IMPORT_DIR.div("ai_choose_layer1_size.aep")).project);
    const project = parse_aep(BASE).project;
    const item = as_instance(project.import_file(_layer_opts(ASSETS.div("ai.ai"), 1, "layer")), FootageItem);
    const source = item.main_source;
    py_assert(source instanceof FileSource);
    const my_opti = source._opti.tobytes();
    // The box lands within a couple of 1/65536 quanta of AE's; the
    // derived footage dimensions and the Layer Size marker are exact.
    const ae_box = struct.unpack(">4i", ae_opti.slice(0x10, 0x20));
    const my_box = struct.unpack(">4i", my_opti.slice(0x10, 0x20));
    expect(approx(my_box, ae_box, { abs: 3 })).toBe(true);
    expect(py_eq([item.width, item.height], [482, 437])).toBe(true);
    expect(source._sspc.full_frame).toBe(false);
    // Everything outside the box is byte-identical.
    expect(py_eq(my_opti.slice(0, 0x10), ae_opti.slice(0, 0x10))).toBe(true);
    expect(py_eq(my_opti.slice(0x20), ae_opti.slice(0x20))).toBe(true);
    expect(ae_name).toBe("Calque 1/ai.ai");
  });

  test("test_ai_layer_size_empty_layer_floors_at_one_pixel", () => {
    const project = parse_aep(BASE).project;
    // Calque 2 has no artwork on the page.
    const item = as_instance(project.import_file(_layer_opts(ASSETS.div("ai.ai"), 0, "layer")), FootageItem);
    const source = item.main_source;
    py_assert(source instanceof FileSource);
    const box = struct.unpack(">4i", source._opti.tobytes().slice(0x10, 0x20));
    expect(py_eq(box, [0, 0, 1, 1])).toBe(true);
    expect(py_eq([item.width, item.height], [1, 1])).toBe(true);
  });

  test("test_ai_layer_size_survives_a_disk_roundtrip", () => {
    // The opti is synthesized in memory; re-parsing the saved file reads
    // the bytes that actually landed on disk.
    const tmp_path = make_tmp_path();
    const project = parse_aep(BASE).project;
    project.import_file(_layer_opts(ASSETS.div("ai.ai"), 1, "layer"));
    const out = tmp_path.div("ai_layer_size.aep");
    project.save(out);
    const [_name, _sspc, opti, _utf8] = _footage_parts(parse_project_fresh(out));
    const box = struct.unpack(">4i", opti.slice(0x10, 0x20)).map((v: number) => v / 65536);
    expect(approx(box, [112.748, 239.5073, 593.931, 675.999], { abs: 1e-3 })).toBe(true);
    const item = as_instance(
      _next(parse_project_fresh(out).items.values(), (i) => i instanceof FootageItem && i.main_source instanceof FileSource),
      FootageItem,
    );
    expect(py_eq([item.width, item.height], [482, 437])).toBe(true);
  });

  test("test_ai_layer_size_document_default_keeps_the_full_page", () => {
    const project = parse_aep(BASE).project;
    const item = as_instance(project.import_file(_layer_opts(ASSETS.div("ai.ai"), 1)), FootageItem);
    const source = item.main_source;
    py_assert(source instanceof FileSource);
    const box = struct.unpack(">4i", source._opti.tobytes().slice(0x10, 0x20)).map((v: number) => v / 65536);
    expect(approx(box, [0.0, 0.0, 612.0, 792.0])).toBe(true);
    expect(py_eq([item.width, item.height], [612, 792])).toBe(true);
    expect(source._sspc.full_frame).toBe(true);
  });

  test("test_ai_layer_size_replace_keeps_the_binding", () => {
    // CURRENT_VALUE used to downgrade an AI target to Document Size
    // because Layer Size was unrepresentable; it now round-trips.
    const project = parse_aep(BASE).project;
    const item = as_instance(project.import_file(_layer_opts(ASSETS.div("ai.ai"), 1, "layer")), FootageItem);
    item.replace(ASSETS.div("ai.ai"), CURRENT_VALUE, CURRENT_VALUE);
    const source = item.main_source;
    py_assert(source instanceof FileSource);
    expect(source._sspc.full_frame).toBe(false);
    expect(py_eq([item.width, item.height], [482, 437])).toBe(true);
  });

  test("test_pdf_layer_size_measures_every_construct", () => {
    // The probe PDF carries one layer per measuring rule; its AE fixture
    // is the ground truth (see tests/read_only/test_ai_bounds.py). Here
    // we only check the import path threads the box through end to end.
    const ae = ai_layer_opti_boxes(parse_aep(IMPORT_DIR.div("ai_bounds_probe.aep")).project);
    const probe = ASSETS.div("ai_bounds_probe.pdf");
    const names = read_ai_layers(probe);
    for (const [index, name] of enumerate([...names].reverse())) {
      const project = parse_aep(BASE).project;
      const item = as_instance(project.import_file(_layer_opts(probe, index, "layer")), FootageItem);
      const source = item.main_source;
      py_assert(source instanceof FileSource);
      const box = struct.unpack(">4i", source._opti.tobytes().slice(0x10, 0x20)).map((v: number) => v / 65536);
      const [expected_box, width, height] = getitem(ae, name);
      expect(approx(box, expected_box, { abs: 3 / 65536 })).toBe(true);
      expect(py_eq([item.width, item.height], [width, height])).toBe(true);
    }
  });

  // An AI Layer Size import stores the layer's artwork bounding box
  // (4x signed BE 16.16 at 0x10, page points) in place of the
  // full-page box. This pins the 16.16 layout against AE's own bytes;
  // the measuring pass that derives the box is covered by
  // tests/read_only/test_ai_bounds.py.
  test.each([
    [
      "ai_choose_layer1_size.aep",
      "Calque 1",
      [112.748, 239.5073, 593.931, 675.999],
      [482, 437],
    ],
    // Calque 2 is empty: AE stores a 1/65536-epsilon box and floors
    // the footage at 1x1.
    [
      "ai_choose_layer_size.aep",
      "Calque 2",
      [0.0, 0.0, 1 / 65536, 1 / 65536],
      [1, 1],
    ],
  ])(
    "test_ai_layer_size_opti_stores_artwork_bounds[%#]",
    (fixture: string, layer: string, expected_box: number[], expected_size: number[]) => {
      // Calque 1 has artwork: its box is fractional and offset from
      // the page origin; AE ceils the box size to 482x437 footage px.
      // Calque 2 is empty: AE stores a 1/65536-epsilon box and floors
      // the footage at 1x1.
      const [_name, sspc, ae_opti, _utf8] = _footage_parts(parse_aep(IMPORT_DIR.div(fixture)).project);
      const [x0, y0, x1, y1] = struct.unpack(">4i", ae_opti.slice(0x10, 0x20));
      const box: [number, number, number, number] = [x0 / 65536, y0 / 65536, x1 / 65536, y1 / 65536];
      expect(approx(box, expected_box, { abs: 1e-4 })).toBe(true);
      expect(py_eq(ae_opti, build_ai_layer_opti_data(612, 792, layer, 2, box))).toBe(true);
      // sspc holds the derived integer dims and the Layer Size markers.
      expect(struct.unpack(">H", sspc.slice(0x20, 0x22))[0]).toBe(expected_size[0]);
      expect(struct.unpack(">H", sspc.slice(0x24, 0x26))[0]).toBe(expected_size[1]);
      expect(sspc[0xc7]).toBe(0); // full_frame off, like a PSD Layer Size
    },
  );

  test("test_roundtrip_byte_identical", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(BASE).project;
    project.import_file(_layer_opts(ASSETS.div("choose_layer.psd"), 3));
    project.import_file(_layer_opts(ASSETS.div("ai.ai"), 0));
    const out = tmp_path.div("chooser.aep");
    project.save(out);
    const out2 = tmp_path.div("chooser2.aep");
    parse_aep(out).project.save(out2);
    expect(py_eq(out.read_bytes(), out2.read_bytes())).toBe(true);
  });

  test("test_reparse_keeps_binding", () => {
    // Disk round-trip, not in-memory: the saved bytes must decode back
    // to the same layer binding.
    const tmp_path = make_tmp_path();
    const project = parse_aep(BASE).project;
    project.import_file(_layer_opts(ASSETS.div("choose_layer.psd"), 1));
    const out = tmp_path.div("chooser.aep");
    project.save(out);
    const [name, sspc, _opti, utf8] = _footage_parts(parse_aep(out).project);
    expect(name).toBe("inner/choose_layer.psd");
    expect(utf8).toBe("inner");
    expect(py_eq(sspc.slice(0xbc, 0xc4), bytes_.fromhex("0000000600000003"))).toBe(true);
  });
});

/**
 * FootageItem.replace layer rebinding, vs the AE replace fixtures.
 *
 * `choose_layer_v2.psd` `list_layers` (top first):
 * `["extra", "twin", "solo"]`, so `extra` is index 0 and `solo` index 2.
 */
describe("TestChooseLayerReplace", () => {
  const _import = (layer: number | null, dims: string | null = null): [Project, FootageItem] => {
    const project = parse_aep(BASE).project;
    const item = project.import_file(_layer_opts(ASSETS.div("choose_layer.psd"), layer, dims));
    expect(item instanceof FootageItem).toBe(true);
    return [project, as_instance(item, FootageItem)];
  };

  test("test_replace_explicit_index_rebinds", () => {
    // AE re-derives index/lyid/bounds/layer_count from the new file.
    const [project, item] = _import(3);
    item.replace(ASSETS.div("choose_layer_v2.psd"), 2);
    const ae = _footage_parts(parse_aep(IMPORT_DIR.div("choose_layer_replace_same.aep")).project);
    const [name, sspc, opti, utf8] = _footage_parts(project);
    expect(name).toBe("solo/choose_layer_v2.psd");
    expect(name).toBe(ae[0]);
    expect(py_eq(opti, ae[2])).toBe(true);
    expect(utf8).toBe(ae[3]);
    _assert_sspc_matches(ae[1], sspc);
  });

  test("test_replace_with_flat_file_drops_binding", () => {
    const [project, item] = _import(3);
    item.replace(ASSETS.div("image_with_alpha.png"));
    const ae = _footage_parts(parse_aep(IMPORT_DIR.div("choose_layer_replace_flat.aep")).project);
    const [name, sspc, _opti, utf8] = _footage_parts(project);
    expect(name).toBe("image_with_alpha.png");
    expect(name).toBe(ae[0]);
    expect(utf8).toBe("");
    expect(ae[3]).toBe("");
    // py writes the generic opti header, not AE's PNG-specific one (an
    // accepted divergence); the 0xD0 cache size matches (the file's size).
    _assert_sspc_matches(ae[1], sspc);
    const source = item.main_source;
    py_assert(source instanceof FileSource);
    expect(source.layer_name).toBe("");
    expect(source._sspc.layer_id).toBe(0xffffffff);
    expect(source._sspc.layer_index).toBe(0xffffffff);
  });

  test.each([[null], [3]])("test_replace_without_index_goes_merged[%#]", (initial_layer: number | null) => {
    // layer_index=None always replaces with the merged document -
    // consistent with import_file - whether the current source was
    // merged or bound to a single layer.
    const [project, item] = _import(initial_layer);
    item.replace(ASSETS.div("choose_layer_v2.psd"));
    const ae = _footage_parts(parse_aep(IMPORT_DIR.div("choose_layer_replace_from_merged.aep")).project);
    const [name, sspc, opti, utf8] = _footage_parts(project);
    expect(name).toBe("choose_layer_v2.psd");
    expect(name).toBe(ae[0]);
    expect(py_eq(opti, ae[2])).toBe(true);
    expect(utf8).toBe("");
    expect(ae[3]).toBe("");
    _assert_sspc_matches(ae[1], sspc);
  });

  test("test_replace_current_value_rebinds_same_record", () => {
    // `solo` has record index 0 in both files, so CURRENT_VALUE lands on
    // the same layer AE's Replace Footage dialog preselects - the
    // replace_same fixture applies unchanged.
    const [project, item] = _import(3);
    item.replace(ASSETS.div("choose_layer_v2.psd"), CURRENT_VALUE);
    const ae = _footage_parts(parse_aep(IMPORT_DIR.div("choose_layer_replace_same.aep")).project);
    const [name, sspc, opti, utf8] = _footage_parts(project);
    expect(name).toBe("solo/choose_layer_v2.psd");
    expect(name).toBe(ae[0]);
    expect(py_eq(opti, ae[2])).toBe(true);
    expect(utf8).toBe(ae[3]);
    _assert_sspc_matches(ae[1], sspc);
  });

  test("test_replace_current_value_from_merged_raises", () => {
    const [, item] = _import(null);
    raises(
      ValueError,
      () => {
        item.replace(ASSETS.div("choose_layer_v2.psd"), CURRENT_VALUE);
      },
      "CURRENT_VALUE requires",
    );
  });

  test("test_replace_current_value_missing_record_raises", () => {
    // `inner` is record index 3 in choose_layer.psd; v2's leaf records
    // are [0, 1, 2], so the stored index does not resolve.
    const [, item] = _import(1);
    raises(
      ValueError,
      () => {
        item.replace(ASSETS.div("choose_layer_v2.psd"), CURRENT_VALUE);
      },
      "stored index 3",
    );
  });

  test("test_replace_current_value_flat_file_raises", () => {
    const [, item] = _import(3);
    raises(
      ValueError,
      () => {
        item.replace(ASSETS.div("image_with_alpha.png"), CURRENT_VALUE);
      },
      "layered",
    );
  });

  test("test_replace_out_of_range_index_raises", () => {
    const [, item] = _import(1);
    raises(
      ValueError,
      () => {
        item.replace(ASSETS.div("choose_layer_v2.psd"), 3);
      },
      "layer_index 3 out of range",
    );
  });

  test("test_replace_flat_with_explicit_layer_raises", () => {
    const [, item] = _import(3);
    raises(
      ValueError,
      () => {
        item.replace(ASSETS.div("image_with_alpha.png"), 0);
      },
      "layered",
    );
  });

  test("test_replace_explicit_layer_binds", () => {
    // An explicit layer_index binds even from a merged source.
    const [, item] = _import(null);
    item.replace(ASSETS.div("choose_layer_v2.psd"), 0);
    expect(item.name).toBe("extra/choose_layer_v2.psd");
    const source = item.main_source;
    py_assert(source instanceof FileSource);
    expect(source.layer_name).toBe("extra");
  });

  test("test_replace_preserves_layer_size", () => {
    const [, item] = _import(3, "layer");
    item.replace(ASSETS.div("choose_layer_v2.psd"), 2);
    // v2 solo content box is L10 T10 R40 B30 -> 30x20, still Layer Size.
    expect(py_eq([item.width, item.height], [30, 20])).toBe(true);
    const source = item.main_source;
    expect(source instanceof FileSource).toBe(true);
    expect(!source._sspc.full_frame).toBe(true);
  });

  test("test_replace_layer_dimensions_document_overrides_current", () => {
    // Current binding is Layer Size; an explicit "document" forces the
    // full canvas instead of preserving it.
    const [, item] = _import(3, "layer");
    item.replace(ASSETS.div("choose_layer_v2.psd"), 2, "document");
    expect(py_eq([item.width, item.height], [30, 20])).toBe(false);
    const source = item.main_source;
    expect(source instanceof FileSource).toBe(true);
    expect(source._sspc.full_frame).toBe(true);
  });

  test("test_replace_layer_dimensions_layer_overrides_current", () => {
    // Current binding is Document Size; an explicit "layer" forces the
    // layer content box (v2 solo box L10 T10 R40 B30 -> 30x20).
    const [, item] = _import(3);
    item.replace(ASSETS.div("choose_layer_v2.psd"), 2, "layer");
    expect(py_eq([item.width, item.height], [30, 20])).toBe(true);
    const source = item.main_source;
    expect(source instanceof FileSource).toBe(true);
    expect(!source._sspc.full_frame).toBe(true);
  });

  test("test_replace_invalid_layer_dimensions_raises", () => {
    const [, item] = _import(3);
    raises(
      ValueError,
      () => {
        item.replace(ASSETS.div("choose_layer_v2.psd"), 2, "huge");
      },
      "must be one of",
    );
  });
});

/** COMP imports write the same per-layer sspc binding + Pin Utf8 as AE. */
describe("TestCompImportLayerBinding", () => {
  test.each([
    ["layer_bounds_comp.aep", "layer_bounds.psd"],
    ["grouped_layers_comp.aep", "grouped_layers.psd"],
    ["flattened_rgb_comp.aep", "flattened_rgb.psd"],
    ["ai_comp.aep", "ai.ai"],
  ])("test_per_layer_binding_matches_ae[%#]", (fixture: string, asset: string) => {
    const by_name = (project: Project): Map<string, [Uint8Array, string]> => {
      const out = new Map<string, [Uint8Array, string]>();
      for (const item of project.items.values()) {
        if (item instanceof FootageItem && item.main_source instanceof FileSource) {
          const src = item.main_source;
          const pin = src._pin.chunks;
          const sspc_i = pin.findIndex((c) => c.chunk_type === "sspc");
          out.set(item.name, [_sspc_bytes(src), as_instance(pin[sspc_i + 1], Utf8Chunk).value]);
        }
      }
      return out;
    };

    const ae = by_name(parse_aep(IMPORT_DIR.div(fixture)).project);
    const project = parse_aep(BASE).project;
    project.import_file(_comp_opts(ASSETS.div(asset)));
    const mine = by_name(project);
    expect([...ae.keys()].every((k) => mine.has(k))).toBe(true);
    for (const [name, [ae_sspc, ae_utf8]] of ae) {
      const [sspc, utf8] = getitem(mine, name);
      expect(utf8).toBe(ae_utf8);
      _assert_sspc_matches(ae_sspc, sspc);
    }
  });
});

/**
 * ImportOptions.range_start/range_end sequence imports.
 *
 * Semantics probed against AE 2026 (2026-07-14): the range is
 * frame-NUMBER based and inclusive on both ends; the stored
 * `start_frame`/`end_frame` are the range bounds even when files are
 * missing inside or beyond the range (absent frames are implied
 * placeholders); duration spans the bounds.
 */
describe("TestImportFileSequenceRange", () => {
  const TWELVE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

  const _make_seq = (tmp_path: Path, numbers: number[], prefix = "range_"): Path => {
    const data = ASSETS.div("8bits_compressed.png").read_bytes();
    for (const n of numbers) {
      tmp_path.div(`${prefix}${String(n).padStart(4, "0")}.png`).write_bytes(data);
    }
    return tmp_path.div(`${prefix}${String(numbers[0]).padStart(4, "0")}.png`);
  };

  const _import = (first: Path, start = 0, end = 0): FootageItem => {
    const project = parse_aep(BASE).project;
    const opts = new ImportOptions(first);
    opts.sequence = true;
    opts.range_start = start;
    opts.range_end = end;
    const item = project.import_file(opts);
    py_assert(item instanceof FootageItem);
    return item;
  };

  test("test_clip_range", () => {
    const tmp_path = make_tmp_path();
    const first = _make_seq(tmp_path, TWELVE);
    const item = _import(first, 3, 8);
    const sspc = item.main_source._sspc;
    expect(py_eq([sspc.start_frame, sspc.end_frame], [3, 8])).toBe(true);
    // AE probed duration: 0.2 s (6 frames at 30 fps).
    expect(approx(item.duration, 0.2, { abs: 1e-4 })).toBe(true);
    expect(item.name).toBe("range_[0003-0008].png");
  });

  test("test_over_range_keeps_bounds", () => {
    const tmp_path = make_tmp_path();
    const first = _make_seq(tmp_path, TWELVE);
    const item = _import(first, 10, 20);
    const sspc = item.main_source._sspc;
    expect(py_eq([sspc.start_frame, sspc.end_frame], [10, 20])).toBe(true);
    // AE probed duration: 11 frames at 30 fps even though only
    // frames 10-12 exist on disk.
    expect(approx(item.duration, 11 / 30, { abs: 1e-4 })).toBe(true);
  });

  test("test_interior_gap", () => {
    const tmp_path = make_tmp_path();
    const first = _make_seq(tmp_path, [1, 2, 3, 4, 5, 8, 9, 10, 11, 12]);
    const item = _import(first, 3, 8);
    const sspc = item.main_source._sspc;
    expect(py_eq([sspc.start_frame, sspc.end_frame], [3, 8])).toBe(true);
    expect(approx(item.duration, 0.2, { abs: 1e-4 })).toBe(true);
  });

  test("test_gapped_full_import_spans_bounds", () => {
    // No range: AE's duration is the frame-number span, not the file
    // count (probed: 1-12 with 6-7 missing -> 0.4 s at 30 fps).
    const tmp_path = make_tmp_path();
    const first = _make_seq(tmp_path, [1, 2, 3, 4, 5, 8, 9, 10, 11, 12]);
    const item = _import(first);
    expect(approx(item.duration, 0.4, { abs: 1e-4 })).toBe(true);
  });

  test("test_start_without_end_raises", () => {
    const tmp_path = make_tmp_path();
    const first = _make_seq(tmp_path, TWELVE);
    raises(
      ValueError,
      () => {
        _import(first, 5, 0);
      },
      "range end",
    );
  });

  test("test_end_before_start_raises", () => {
    const tmp_path = make_tmp_path();
    const first = _make_seq(tmp_path, TWELVE);
    raises(
      ValueError,
      () => {
        _import(first, 9, 4);
      },
      "less than",
    );
  });

  test("test_range_outside_files_raises", () => {
    const tmp_path = make_tmp_path();
    const first = _make_seq(tmp_path, TWELVE);
    raises(
      ValueError,
      () => {
        _import(first, 20, 30);
      },
      "no sequence frames",
    );
  });

  test("test_range_ignored_for_non_sequence", () => {
    // AE parity: a range on a non-sequence import is silently ignored.
    const project = parse_aep(BASE).project;
    const opts = new ImportOptions(ASSETS.div("image_with_alpha.png"));
    opts.range_start = 2;
    opts.range_end = 5;
    const item = project.import_file(opts);
    expect(item instanceof FootageItem).toBe(true);
    expect(item.name).toBe("image_with_alpha.png");
  });

  test("test_range_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const first = _make_seq(tmp_path, TWELVE);
    const project = parse_aep(BASE).project;
    const opts = new ImportOptions(first);
    opts.sequence = true;
    opts.range_start = 3;
    opts.range_end = 8;
    project.import_file(opts);
    const out = tmp_path.div("ranged.aep");
    project.save(out);
    const reparsed = parse_aep(out).project;
    const item = as_instance(
      _next(reparsed.items.values(), (it) => it.name === "range_[0003-0008].png"),
      FootageItem,
    );
    const sspc = item.main_source._sspc;
    expect(py_eq([sspc.start_frame, sspc.end_frame], [3, 8])).toBe(true);
    expect(approx(item.duration, 0.2, { abs: 1e-4 })).toBe(true);
  });
});

/**
 * FileSource.reload() - AE 2026 semantics: re-probe the file at the
 * stored path and update the cached sspc metadata in place (byte-validated
 * against an AE reload fixture pair: width/height/data_size refresh, item
 * identity and name unchanged).
 */
describe("TestFileSourceReload", () => {
  const _import_png = (tmp_path: Path): [Project, FootageItem, Path] => {
    const target = tmp_path.div("reload_src.png");
    target.write_bytes(ASSETS.div("8bits_compressed.png").read_bytes());
    const project = parse_aep(BASE).project;
    const item = as_instance(project.import_file(new ImportOptions(target)), FootageItem);
    return [project, item, target];
  };

  test("test_reload_updates_dimensions", () => {
    const tmp_path = make_tmp_path();
    const [project, item, target] = _import_png(tmp_path);
    expect(py_eq([item.width, item.height], [25, 26])).toBe(true);
    const new_content = ASSETS.div("image_with_alpha.png").read_bytes();
    target.write_bytes(new_content);
    as_instance(item.main_source, FileSource).reload();
    // The AE fixture values for the same file swap.
    expect(py_eq([item.width, item.height], [640, 346])).toBe(true);
    expect(item.main_source._sspc.data_size).toBe(new_content.length);
    expect(item.name).toBe("reload_src.png"); // reload never renames
  });

  test("test_reload_keeps_the_stored_importer_code", () => {
    // AE 2026 on Windows keeps a BMP's STIL code in the reloaded opti;
    // re-deriving it from the extension wrote the macOS IMIO.
    const project = parse_aep(BASE, { platform: "windows" }).project;
    const source = as_instance(
      as_instance(project.import_file(new ImportOptions(ASSETS.div("bmp.bmp"))), FootageItem).main_source,
      FileSource,
    );
    expect(source._sspc.source_format_type).toBe("STIL");
    source.reload();
    expect(py_eq(source._opti.tobytes().slice(0, 4), b("STIL"))).toBe(true);
  });

  test("test_reload_survives_save_and_reparse", () => {
    const tmp_path = make_tmp_path();
    const [project, item, target] = _import_png(tmp_path);
    target.write_bytes(ASSETS.div("image_with_alpha.png").read_bytes());
    as_instance(item.main_source, FileSource).reload();
    const out = tmp_path.div("reloaded.aep");
    project.save(out);
    const reparsed = parse_aep(out).project;
    const item2 = _next(reparsed.footages, (i) => i.name === "reload_src.png");
    expect(py_eq([item2.width, item2.height], [640, 346])).toBe(true);
  });

  test("test_reload_proxy_source", () => {
    // ExtendScript forbids this; py_aep allows it. Every chunk reload
    // touches lives in the source's own Pin, so it is self-contained.
    const tmp_path = make_tmp_path();
    const [project, item] = _import_png(tmp_path);
    const proxy = tmp_path.div("proxy.png");
    proxy.write_bytes(ASSETS.div("8bits_compressed.png").read_bytes());
    item.set_proxy(proxy);
    py_assert(item.proxy_source instanceof FileSource);
    expect(py_eq([item.proxy_source._width, item.proxy_source._height], [25, 26])).toBe(true);

    // Swap the proxy file on disk for one with different dimensions.
    // (item.width is not asserted here: AE reports the MAIN source's
    // dimensions even while use_proxy is on - see proxy.json.)
    proxy.write_bytes(ASSETS.div("image_with_alpha.png").read_bytes());
    item.proxy_source.reload();
    expect(py_eq([item.proxy_source._width, item.proxy_source._height], [640, 346])).toBe(true);

    const out = tmp_path.div("proxy_reloaded.aep");
    project.save(out);
    const reparsed = parse_aep(out).project;
    const item2 = _next(reparsed.footages, (i) => i.name === "reload_src.png");
    expect(item2.proxy_source instanceof FileSource).toBe(true);
    expect(py_eq([as_instance(item2.proxy_source, FileSource)._width, as_instance(item2.proxy_source, FileSource)._height], [640, 346])).toBe(true);
  });

  test("test_reload_proxy_leaves_main_source_alone", () => {
    // The proxy and main sources own separate Pins: reloading one must
    // not disturb the other, nor the item's idta footage-kind flags.
    const tmp_path = make_tmp_path();
    const [, item] = _import_png(tmp_path);
    const proxy = tmp_path.div("proxy.png");
    proxy.write_bytes(ASSETS.div("8bits_compressed.png").read_bytes());
    item.set_proxy(proxy);
    const main_dims = [item.main_source._width, item.main_source._height];
    const flags_before = as_instance(item._idta, IdtaChunk)._flags_17;

    proxy.write_bytes(ASSETS.div("image_with_alpha.png").read_bytes());
    py_assert(item.proxy_source instanceof FileSource);
    item.proxy_source.reload();

    expect(py_eq([item.main_source._width, item.main_source._height], main_dims)).toBe(true);
    expect(as_instance(item._idta, IdtaChunk)._flags_17).toBe(flags_before);
  });

  test("test_reload_missing_file_raises", () => {
    const tmp_path = make_tmp_path();
    const [, item, target] = _import_png(tmp_path);
    target.unlink();
    raises(ValueError, () => {
      as_instance(item.main_source, FileSource).reload();
    });
  });

  test("test_reload_path_replaced_by_directory_raises", () => {
    // A directory exists, so an existence check alone passes it through to
    // the format reader, which fails with an OS-specific error
    // (PermissionError on Windows, IsADirectoryError elsewhere) instead of
    // refusing cleanly at the API boundary.
    const tmp_path = make_tmp_path();
    const [, item, target] = _import_png(tmp_path);
    target.unlink();
    target.mkdir();
    raises(
      ValueError,
      () => {
        as_instance(item.main_source, FileSource).reload();
      },
      "not a file",
    );
  });

  test("test_import_a_directory_raises", () => {
    // Same class as the reload case, on the import path.
    const tmp_path = make_tmp_path();
    const folder = tmp_path.div("looks_like.png");
    folder.mkdir();
    const project = parse_aep(BASE).project;
    raises(
      ValueError,
      () => {
        project.import_file(new ImportOptions(folder));
      },
      "not a file",
    );
  });

  test("test_reload_sequence_rescans_frames", () => {
    const tmp_path = make_tmp_path();
    const data = ASSETS.div("8bits_compressed.png").read_bytes();
    for (let n = 1; n < 4; n++) {
      tmp_path.div(`seq_${String(n).padStart(4, "0")}.png`).write_bytes(data);
    }
    const project = parse_aep(BASE).project;
    const opts = new ImportOptions(tmp_path.div("seq_0001.png"));
    opts.sequence = true;
    const item = as_instance(project.import_file(opts), FootageItem);
    const sspc = item.main_source._sspc;
    expect(py_eq([sspc.start_frame, sspc.end_frame], [1, 3])).toBe(true);

    for (let n = 4; n < 7; n++) {
      tmp_path.div(`seq_${String(n).padStart(4, "0")}.png`).write_bytes(data);
    }
    as_instance(item.main_source, FileSource).reload();
    expect(py_eq([sspc.start_frame, sspc.end_frame], [1, 6])).toBe(true);
    expect(approx(item.duration, 6 / 30, { abs: 1e-4 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PSD layer styles (ImportOptions.layer_styles / FootageItem.replace)
// ---------------------------------------------------------------------------

const STYLED_PSD = ASSETS.div("psd_layer_styles.psd");
const VARIANT_PSD = ASSETS.div("psd_layer_styles_variant.psd");
const SINGLE_PSD = ASSETS.div("psd_layer_styles_8bits_single.psd");

/** Serialize a chunk subtree exactly as write_aep would (skip synthetic). */
function _serialize_tree(chunk: Chunk | null): Uint8Array {
  py_assert(chunk != null);
  const buffer = new BytesIO();
  write_chunk(buffer, chunk);
  return buffer.getvalue();
}

function _styles_tdgp(project: Project, comp_name: string, layer_name: string): ListChunk | null {
  const comp = as_instance(
    _next(project.items.values(), (item) => item instanceof CompItem && item.name === comp_name),
    CompItem,
  );
  const layer = comp.layer(layer_name);
  return layer.property("ADBE Layer Styles")._tdgp;
}

function _styles_import(psd: Path, import_as: ImportAsType, layer_styles: string | null = null): [Project, FootageItem | CompItem] {
  const project = parse_aep(BASE).project;
  const opts = new ImportOptions(psd);
  opts.import_as = import_as;
  if (layer_styles != null) opts.layer_styles = layer_styles;
  return [project, project.import_file(opts)];
}

function _psd_footage_source(project: Project, name: string): FileSource {
  for (const item of project.items.values()) {
    if (item instanceof FootageItem && item.name === name) {
      const source = item.main_source;
      py_assert(source instanceof FileSource);
      return source;
    }
  }
  throw new AssertionError_(`footage ${repr(name)} not found`);
}


/**
 * COMP + editable layer styles vs the AE 2026 dialog fixtures.
 *
 * The whole `ADBE Layer Styles` subtree must serialize byte-identically
 * to AE for every layer of all three sample documents (values, enable
 * bytes, tdb4 canon, bounds, gradient GCst containers).
 */
describe("TestLayerStylesEditableImport", () => {
  const _TWO_LAYERS = ["Layer 1", "Layer 1 copy"];

  test.each([
    [STYLED_PSD, "psd_layer_styles.aep", "COMP Editable layer styles", _TWO_LAYERS],
    [VARIANT_PSD, "psd_layer_styles_variant.aep", null, _TWO_LAYERS],
    [SINGLE_PSD, "psd_layer_styles_single.aep", null, _TWO_LAYERS],
    // Noise-type gradients: the style imports without its gradient
    // leaf. The 32-bit sibling also exercises the Lr32 layer records.
    [ASSETS.div("psd_noise_gradient.psd"), "psd_noise_gradient.aep", null, _TWO_LAYERS],
    [ASSETS.div("psd_noise_gradient_32bpc.psd"), "psd_noise_gradient.aep", null, _TWO_LAYERS],
    // 2D point leaves: dragged Gradient Overlay offset + Pattern
    // Overlay phase (the only 2D-spatial style leaves).
    [ASSETS.div("psd_styles_offset_phase.psd"), "psd_styles_offset_phase.aep", null, _TWO_LAYERS],
    // Gradient smoothness: Intr 2048/1024 -> gradientSmoothness 50/25.
    [ASSETS.div("psd_styles_smoothness.psd"), "psd_styles_smoothness.aep", null, _TWO_LAYERS],
    // Blend options without styles (iOpa alone enables the chain)
    // and a present-but-disabled drop shadow (tdsb 0x00 + values).
    [ASSETS.div("psd_fill_opacity.psd"), "psd_fill_opacity.aep", null, ["fill only", "fill plus disabled shadow", "Layer 1"]],
    // Legacy 4CC blend-mode enum spellings (spliced Mltp/SftL).
    [ASSETS.div("psd_blend_4cc.psd"), "psd_blend_4cc.aep", null, ["legacy modes", "Layer 1"]],
    // The full 27-mode 4CC probe: AE resolves the 16 true-legacy
    // typeIDs and silently defaults the post-CS ones; py must
    // match both behaviors byte-for-byte on every layer.
    [
      ASSETS.div("psd_blend_4cc_all.psd"),
      "psd_blend_4cc_all.aep",
      null,
      [
        "normal",
        "dissolve",
        "darken",
        "multiply",
        "colorBurn",
        "linearBurn",
        "darkerColor",
        "lighten",
        "screen",
        "colorDodge",
        "linearDodge",
        "lighterColor",
        "overlay",
        "softLight",
        "hardLight",
        "vividLight",
        "linearLight",
        "pinLight",
        "hardMix",
        "difference",
        "exclusion",
        "hue",
        "saturation",
        "color",
        "luminosity",
        "blendSubtraction",
        "blendDivide",
        "Layer 1",
      ],
    ],
    // Styles on a layer GROUP: AE drops them (plain skeleton on the
    // precomp layer); the child's own style still imports.
    [ASSETS.div("psd_group_styles.psd"), "psd_group_styles.aep", null, ["styled group", "outside", "Layer 1"]],
    [ASSETS.div("psd_group_styles.psd"), "psd_group_styles.aep", "styled group", ["inner bottom", "inner top"]],
  ])(
    "test_styles_subtree_matches_ae[%#]",
    (psd: Path, fixture: string, fixture_comp: string | null, layers: string[]) => {
      const ae_project = parse_aep(IMPORT_DIR.div(fixture)).project;
      // NOTE(port): warnings.catch_warnings + simplefilter("ignore") - pyrt warn() never echoes, so nothing needs silencing.
      const [project, comp] = _styles_import(psd, ImportAsType.COMP);
      // A named fixture_comp that exists in the py project too (the nested
      // group comp) targets that comp on both sides; otherwise the py side
      // is the freshly imported main comp.
      let py_comp = comp.name;
      if (fixture_comp != null && Array.from(project.items.values()).some((item) => item.name === fixture_comp)) {
        py_comp = fixture_comp;
      }
      const ae_comp = fixture_comp != null ? fixture_comp : comp.name;
      for (const layer_name of layers) {
        const ae_tree = _serialize_tree(_styles_tdgp(ae_project, ae_comp, layer_name));
        const py_tree = _serialize_tree(_styles_tdgp(project, py_comp, layer_name));
        expect(py_eq(py_tree, ae_tree)).toBe(true);
      }
    },
  );

  test("test_survives_disk_roundtrip", () => {
    // Enable/flag bytes are validated through a real save + re-parse:
    // a forgiving reader can mask a wrong written byte.
    const tmp_path = make_tmp_path();
    const ae_project = parse_aep(IMPORT_DIR.div("psd_layer_styles_single.aep")).project;
    const [project, comp] = _styles_import(SINGLE_PSD, ImportAsType.COMP);
    const out = tmp_path.div("editable.aep");
    project.save(out);
    const reparsed = parse_project_fresh(out);
    const ae_tree = _serialize_tree(_styles_tdgp(ae_project, comp.name, "Layer 1"));
    const re_tree = _serialize_tree(_styles_tdgp(reparsed, comp.name, "Layer 1"));
    expect(py_eq(re_tree, ae_tree)).toBe(true);
    const layer = as_instance(
      _next(reparsed.items.values(), (item) => item instanceof CompItem && item.name === comp.name),
      CompItem,
    ).layer("Layer 1");
    const styles = layer.property("ADBE Layer Styles");
    expect(styles.enabled).toBe(true);
    expect(styles.__getitem__("dropShadow/enabled").enabled).toBe(true);
    expect(
      as_instance(as_instance(styles.__getitem__("dropShadow/enabled"), PropertyGroup).__getitem__("dropShadow/mode2"), Property).value,
    ).toBe(17.0);
  });

  test("test_new_enable_states_survive_disk_roundtrip", () => {
    // The blend-only chain (tdsb 0x01 with zero styles), the
    // present-but-disabled 0x00 state, and the always-enabled Adv Blend
    // subgroup, re-read from an actual save (synthetic chunks flip real).
    const tmp_path = make_tmp_path();
    const ae_project = parse_aep(IMPORT_DIR.div("psd_fill_opacity.aep")).project;
    const [project, comp] = _styles_import(ASSETS.div("psd_fill_opacity.psd"), ImportAsType.COMP);
    const out = tmp_path.div("fill_opacity.aep");
    project.save(out);
    const reparsed = parse_project_fresh(out);
    for (const layer_name of ["fill only", "fill plus disabled shadow", "Layer 1"]) {
      const ae_tree = _serialize_tree(_styles_tdgp(ae_project, comp.name, layer_name));
      const re_tree = _serialize_tree(_styles_tdgp(reparsed, comp.name, layer_name));
      expect(py_eq(re_tree, ae_tree)).toBe(true);
    }
    const comp_item = as_instance(
      _next(reparsed.items.values(), (item) => item instanceof CompItem && item.name === comp.name),
      CompItem,
    );
    const styles = comp_item.layer("fill plus disabled shadow").property("ADBE Layer Styles");
    expect(styles.__getitem__("dropShadow/enabled").enabled).toBe(false);
    expect(as_instance(styles.__getitem__("dropShadow/enabled")._tdsb, TdsbChunk)._enable_flags).toBe(0);
    const adv = as_instance(
      as_instance(styles.__getitem__("ADBE Blend Options Group"), PropertyGroup).__getitem__("ADBE Adv Blend Group"),
      PropertyGroup,
    );
    expect(as_instance(adv.__getitem__("ADBE Layer Fill Opacity2"), Property).value).toBe(60.0);
  });

  test("test_per_layer_footage_matches_ae", () => {
    // sspc parity (modulo the documented still-import noise) + opti
    // byte-equality for the editable per-layer footage, including the
    // document pixel-aspect resource (4/3) and the mode byte 0x02.
    const ae_project = parse_aep(IMPORT_DIR.div("psd_layer_styles_single.aep")).project;
    const [project] = _styles_import(SINGLE_PSD, ImportAsType.COMP);
    for (const name of [
      "Layer 1/psd_layer_styles_8bits_single.psd",
      "Layer 1 copy/psd_layer_styles_8bits_single.psd",
    ]) {
      const ae_source = _psd_footage_source(ae_project, name);
      const py_source = _psd_footage_source(project, name);
      _assert_sspc_matches(_sspc_bytes(ae_source), _sspc_bytes(py_source));
      expect(py_eq(py_source._opti.tobytes(), ae_source._opti.tobytes())).toBe(true);
      expect(py_source.layer_styles).toBe("editable");
    }
  });

  test("test_multi_instance_styles_warn_and_disable", () => {
    let project: Project | null = null;
    let comp: FootageItem | CompItem | null = null;
    warns(() => {
      [project, comp] = _styles_import(STYLED_PSD, ImportAsType.COMP);
    }, "frameFX");
    const layer = as_instance(comp, CompItem).layer("Layer 1");
    const styles = layer.property("ADBE Layer Styles");
    expect(styles.__getitem__("frameFX/enabled").enabled).toBe(false);
    expect(styles.__getitem__("dropShadow/enabled").enabled).toBe(true);
  });
});

describe("TestLayerStylesModes", () => {
  test("test_comp_merge_writes_skeleton_and_mode_byte", () => {
    const [project, comp] = _styles_import(SINGLE_PSD, ImportAsType.COMP, "merge");
    const source = _psd_footage_source(project, "Layer 1/psd_layer_styles_8bits_single.psd");
    expect(py_eq(source._sspc._reserved_c8, b("\x00\x01"))).toBe(true);
    expect(source.layer_styles).toBe("merge");
    const layer = as_instance(comp, CompItem).layer("Layer 1");
    const styles = layer.property("ADBE Layer Styles");
    expect(styles.enabled).toBe(false);
    expect(
      styles.properties
        .filter((child) => child.match_name.endsWith("/enabled"))
        .every((child) => !child.enabled),
    ).toBe(true);
  });

  test.each([
    [ImportAsType.COMP_CROPPED_LAYERS, "COMP_CROPPED_LAYERS Merge layer styles into footage"],
    [ImportAsType.COMP, "COMP Merge layer styles into footage"],
  ])(
    "test_merged_styles_box_matches_ae[%#]",
    (import_as: ImportAsType, fixture_comp: string) => {
      // Merged styles grow each layer's footage to their rasterized box:
      // AE stores it in the opti (with the matching data_size) and, cropped,
      // sizes and places the layer from it (24x25 layer -> 114x115).
      const ae_project = parse_aep(IMPORT_DIR.div("psd_layer_styles.aep")).project;
      const ae_comp = as_instance(
        _next(ae_project.items.values(), (item) => item instanceof CompItem && item.name === fixture_comp),
        CompItem,
      );
      const [, comp] = _styles_import(STYLED_PSD, import_as, "merge");
      py_assert(comp instanceof CompItem);
      for (const name of ["Layer 1", "Layer 1 copy"]) {
        const ae_layer = ae_comp.layer(name);
        const py_layer = comp.layer(name);
        const ae_source = as_instance(_footage_source(ae_layer).main_source, FileSource);
        const py_source = as_instance(_footage_source(py_layer).main_source, FileSource);
        _assert_sspc_matches(_sspc_bytes(ae_source), _sspc_bytes(py_source));
        expect(py_eq(py_source._opti.tobytes(), ae_source._opti.tobytes())).toBe(true);
        expect(
          py_eq(
            [_footage_source(py_layer).width, _footage_source(py_layer).height],
            [_footage_source(ae_layer).width, _footage_source(ae_layer).height],
          ),
        ).toBe(true);
        for (const match_name of ["ADBE Anchor Point", "ADBE Position"] as const) {
          expect(
            py_eq(py_layer.transform.property(match_name).value, ae_layer.transform.property(match_name).value),
          ).toBe(true); // (name, match_name)
        }
      }
    },
  );

  test("test_cropped_merge_on_style_less_psd_works", () => {
    const [, comp] = _styles_import(ASSETS.div("choose_layer.psd"), ImportAsType.COMP_CROPPED_LAYERS, "merge");
    expect(comp instanceof CompItem).toBe(true);
  });

  test("test_footage_ignore_matches_ae_fixture_item", () => {
    const ae_project = parse_aep(IMPORT_DIR.div("psd_layer_styles.aep")).project;
    const ae_item = as_instance(
      _next(ae_project.items.values(), (item) => item instanceof FootageItem && item.name === "FOOTAGE Layer 1 Ignore layer styles"),
      FootageItem,
    );
    const project = parse_aep(BASE).project;
    const opts = new ImportOptions(STYLED_PSD);
    opts.layer_index = 1; // "Layer 1" (bottom) in top-first dropdown order
    opts.layer_styles = "ignore";
    const item = as_instance(project.import_file(opts), FootageItem);
    const ae_source = as_instance(ae_item.main_source, FileSource);
    const py_source = item.main_source;
    py_assert(py_source instanceof FileSource);
    _assert_sspc_matches(_sspc_bytes(ae_source), _sspc_bytes(py_source));
    expect(py_eq(py_source._opti.tobytes(), ae_source._opti.tobytes())).toBe(true);
    expect(py_source.layer_styles).toBe("ignore");
  });

  test("test_footage_merge_matches_ae_fixture_item", () => {
    const ae_project = parse_aep(IMPORT_DIR.div("psd_layer_styles.aep")).project;
    const ae_item = as_instance(
      _next(
        ae_project.items.values(),
        (item) => item instanceof FootageItem && item.name === "FOOTAGE Layer 1 Merge layer styles into footage",
      ),
      FootageItem,
    );
    const project = parse_aep(BASE).project;
    const opts = new ImportOptions(STYLED_PSD);
    opts.layer_index = 1;
    const item = as_instance(project.import_file(opts), FootageItem); // merge is the FOOTAGE default
    const ae_source = as_instance(ae_item.main_source, FileSource);
    const py_source = item.main_source;
    py_assert(py_source instanceof FileSource);
    _assert_sspc_matches(_sspc_bytes(ae_source), _sspc_bytes(py_source));
    expect(py_eq(py_source._opti.tobytes(), ae_source._opti.tobytes())).toBe(true);
    expect(py_source.layer_styles).toBe("merge");
  });

  test("test_layer_size_merge_takes_the_merged_box", () => {
    const project = parse_aep(BASE).project;
    const opts = new ImportOptions(STYLED_PSD);
    opts.layer_index = 1;
    opts.layer_dimensions = "layer";
    const item = as_instance(project.import_file(opts), FootageItem);
    // The cropped-layer footage AE writes for the same layer (fixture).
    expect(py_eq([item.width, item.height], [114, 115])).toBe(true);
    const opti = as_instance(item.main_source._opti, PsdOptiChunk);
    expect(py_eq([opti.psd_layer_left, opti.psd_layer_top, opti.psd_layer_right, opti.psd_layer_bottom], [-45, -45, 69, 70])).toBe(true);
    expect(item.main_source._sspc.data_size).toBe(114 * 115 * 4 * 2);
  });

  test("test_layer_size_ignore_on_styled_layer_works", () => {
    const project = parse_aep(BASE).project;
    const opts = new ImportOptions(STYLED_PSD);
    opts.layer_index = 1;
    opts.layer_dimensions = "layer";
    opts.layer_styles = "ignore";
    const item = project.import_file(opts);
    expect(py_eq([item.width, item.height], [24, 25])).toBe(true);
  });
});

describe("TestLayerStylesValidation", () => {
  test("test_setter_rejects_bad_values", () => {
    const opts = new ImportOptions(STYLED_PSD);
    raises(ValueError, () => {
      opts.layer_styles = "bake";
    });
    raises(
      ValueError,
      () => {
        opts.layer_styles = CURRENT_VALUE;
      },
      "CURRENT_VALUE",
    );
  });

  test.each([
    [ImportAsType.FOOTAGE, 1, "editable", "COMP import"],
    [ImportAsType.FOOTAGE, null, "merge", "requires layer_index"],
    [ImportAsType.COMP, null, "ignore", "no Ignore option"],
  ])("test_import_context_rules[%#]", (import_as: ImportAsType, layer_index: number | null, layer_styles: string, match: string) => {
    const project = parse_aep(BASE).project;
    const opts = new ImportOptions(STYLED_PSD);
    opts.import_as = import_as;
    if (layer_index != null) opts.layer_index = layer_index;
    opts.layer_styles = layer_styles;
    raises(
      ValueError,
      () => {
        project.import_file(opts);
      },
      match,
    );
  });

  test("test_non_psd_rejected", () => {
    const project = parse_aep(BASE).project;
    const opts = new ImportOptions(ASSETS.div("ai.ai"));
    opts.import_as = ImportAsType.COMP;
    opts.layer_styles = "merge";
    raises(
      ValueError,
      () => {
        project.import_file(opts);
      },
      "Photoshop",
    );
  });
});

describe("TestLayerStylesReplace", () => {
  const _ignore_item = (): FootageItem => {
    const project = parse_aep(BASE).project;
    const opts = new ImportOptions(STYLED_PSD);
    opts.layer_index = 1;
    opts.layer_styles = "ignore";
    const item = project.import_file(opts);
    py_assert(item instanceof FootageItem);
    return item;
  };

  test("test_current_value_preserves_recorded_choice", () => {
    const item = _ignore_item();
    item.replace(VARIANT_PSD, CURRENT_VALUE);
    const source = item.main_source;
    py_assert(source instanceof FileSource);
    expect(source.layer_styles).toBe("ignore");
  });

  test("test_current_value_preserves_editable_byte", () => {
    // Per-layer footage of an editable comp records mode 0x02; replace
    // keeps the byte verbatim (editable state lives on comp layers).
    const [project] = _styles_import(SINGLE_PSD, ImportAsType.COMP);
    const item = as_instance(
      _next(project.items.values(), (it) => it instanceof FootageItem && it.name === "Layer 1/psd_layer_styles_8bits_single.psd"),
      FootageItem,
    );
    item.replace(VARIANT_PSD, CURRENT_VALUE);
    const source = item.main_source;
    py_assert(source instanceof FileSource);
    expect(source.layer_styles).toBe("editable");
    expect(py_eq(source._sspc._reserved_c8, b("\x00\x02"))).toBe(true);
  });

  test("test_explicit_values_and_rejections", () => {
    const item = _ignore_item();
    item.replace(STYLED_PSD, CURRENT_VALUE, CURRENT_VALUE, "merge");
    const source = item.main_source;
    py_assert(source instanceof FileSource);
    expect(source.layer_styles).toBe("merge");
    raises(ValueError, () => {
      item.replace(STYLED_PSD, CURRENT_VALUE, CURRENT_VALUE, "editable");
    });
    raises(
      ValueError,
      () => {
        item.replace(ASSETS.div("ai.ai"), 0, CURRENT_VALUE, "ignore");
      },
      "Photoshop",
    );
  });

  test("test_merged_current_falls_back_to_merge", () => {
    const project = parse_aep(BASE).project;
    const item = project.import_file(new ImportOptions(STYLED_PSD));
    py_assert(item instanceof FootageItem);
    item.replace(STYLED_PSD, 1);
    const source = item.main_source;
    py_assert(source instanceof FileSource);
    expect(source.layer_styles).toBe("merge");
  });
});

// ---------------------------------------------------------------------------
// PSD vector masks / shape layers (imported as AE masks)
// ---------------------------------------------------------------------------

/**
 * Serialize a layer's Mask Parade with the per-machine mkif noise
 * normalized: `_reserved_0c` carries an app-global counter + timestamp
 * fingerprint, and the outline color follows AE's non-reproducible
 * global mask-color cycle (see MaskPropertyGroup._MASK_COLOR_CYCLE).
 */
function _mask_parade_bytes(project: Project, comp_name: string, layer_name: string): Uint8Array {
  const comp = as_instance(
    _next(project.items.values(), (item) => item instanceof CompItem && item.name === comp_name),
    CompItem,
  );
  const parade = comp.layer(layer_name).property("ADBE Mask Parade");
  for (const mask of parade.properties) {
    const mkif = as_instance(mask, MaskPropertyGroup)._mkif;
    if (mkif != null && !mkif.synthetic) {
      mkif._reserved_0c = new Uint8Array(33);
      mkif.color_r = mkif.color_g = mkif.color_b = 0;
    }
  }
  return _serialize_tree(parade._tdgp);
}

const _PSD_MASK_BASES = ["psd_raster_mask", "psd_shape_layer", "psd_vector_mask", "psd_vector_mask_curves", "psd_vector_mask_multi"];
const _PSD_MASK_PROBES = sorted(ASSETS.glob("psd_mask_*.psd").map((p) => p.stem));
const _PSD_MASK_CASES: [string, string, string][] = [
  ..._PSD_MASK_BASES.concat(_PSD_MASK_PROBES).map((s): [string, string, string] => ["editable", s, "cropped"]),
  ..._PSD_MASK_BASES.concat(_PSD_MASK_PROBES).map((s): [string, string, string] => ["merge", s, "cropped"]),
  ..._PSD_MASK_BASES.map((s): [string, string, string] => ["merge", s, "comp"]),
];

/** A comp layer's size, anchor, position and mask vertices. */
function _layer_geometry(layer: Layer): [number, number, number[], number[], number[][][]] {
  const transform = layer.transform;
  const parade = layer.masks;
  return [
    as_instance(layer, AVLayer).width,
    as_instance(layer, AVLayer).height,
    transform.property("ADBE Anchor Point").value.slice(0, 2).map((v) => round(v, 3)),
    transform.property("ADBE Position").value.slice(0, 2).map((v) => round(v, 3)),
    (parade != null && py_bool(parade) ? parade.properties : []).map((mask) =>
      as_instance(mask, PropertyGroup)
        .property("ADBE Mask Shape")
        .value.vertices.map((vertex) => vertex.map((c) => round(c, 3))),
    ),
  ];
}

/**
 * Per-layer footage content boxes of masked, fill and styled PSD layers
 * (`resolvers.psd_bounds`) vs AE 2026 importing the same files
 * (`psd_mask_crops_<mode>.aep`, one comp per import named
 * `<stem>|<cropped or comp>`). The `psd_mask_*` assets are byte-patched
 * probes, one per rule. Compares the opti and sspc bytes of every
 * per-layer footage, and each comp layer's size, anchor, position and
 * masks.
 */
describe("TestPsdMaskContentBoxes", () => {
  // Class-scoped fixture: parsed once, shared by every case.
  let _fixtures: Map<string, Project> | null = null;
  const fixtures = (): Map<string, Project> => {
    if (_fixtures == null) {
      _fixtures = new Map(["editable", "merge"].map((mode) => [mode, parse_aep(IMPORT_DIR.div(`psd_mask_crops_${mode}.aep`)).project]));
    }
    return _fixtures;
  };

  test.each(_PSD_MASK_CASES)("test_matches_ae[%#]", (mode: string, stem: string, how: string) => {
    const ae_comp = as_instance(
      _next(getitem(fixtures(), mode).items.values(), (item) => item instanceof CompItem && item.name === `${stem}|${how}`),
      CompItem,
    );
    const project = parse_aep(BASE).project;
    const opts = new ImportOptions(ASSETS.div(`${stem}.psd`));
    opts.import_as = how === "cropped" ? ImportAsType.COMP_CROPPED_LAYERS : ImportAsType.COMP;
    opts.layer_styles = mode;
    const comp = as_instance(project.import_file(opts), CompItem);
    const layers = new Map(comp.layers.map((layer) => [layer.name, layer] as const));
    expect(py_eq(new Set(layers.keys()), new Set(ae_comp.layers.map((layer) => layer.name)))).toBe(true);
    for (const ae_layer of ae_comp.layers) {
      const layer = getitem(layers, ae_layer.name);
      const ae_source = as_instance(_footage_source(ae_layer).main_source, FileSource);
      const source = as_instance(_footage_source(layer).main_source, FileSource);
      expect(py_eq(source._opti.tobytes(), ae_source._opti.tobytes())).toBe(true);
      _assert_sspc_matches(_sspc_bytes(ae_source), _sspc_bytes(source));
      expect(py_eq(_layer_geometry(layer), _layer_geometry(ae_layer))).toBe(true);
    }
  });
});

/**
 * PSD vector masks and shape-layer paths become AE masks, one per
 * subpath, byte-matched (modulo the documented mkif noise) against the
 * AE 2026 fixtures.
 */
describe("TestVectorMaskImport", () => {
  test.each([
    ["psd_vector_mask", "vector masked", 1],
    ["psd_shape_layer", "rect shape", 1],
    // Smooth knots: tangent decode fidelity.
    ["psd_vector_mask_curves", "curved", 1],
    // Two subpaths: AE creates Mask 1 + Mask 2.
    ["psd_vector_mask_multi", "two rects", 2],
  ])("test_mask_parade_matches_ae[%#]", (name: string, layer_name: string, mask_count: number) => {
    const ae_project = parse_aep(IMPORT_DIR.div(`${name}.aep`)).project;
    const [project, comp] = _styles_import(ASSETS.div(`${name}.psd`), ImportAsType.COMP);
    const py_parade = as_instance(
      _next(project.items.values(), (item) => item instanceof CompItem && item.name === comp.name),
      CompItem,
    )
      .layer(layer_name)
      .property("ADBE Mask Parade");
    expect(py_parade.properties.length).toBe(mask_count);
    expect(py_parade.properties.every((m) => as_instance(m, MaskPropertyGroup).roto_bezier === false)).toBe(true);
    const ae_tree = _mask_parade_bytes(ae_project, name, layer_name);
    const py_tree = _mask_parade_bytes(project, comp.name, layer_name);
    expect(py_eq(py_tree, ae_tree)).toBe(true);
  });


  test("test_cropped_import_offsets_mask_to_content_box", () => {
    // Mask vertices are canvas coordinates; a COMP_CROPPED_LAYERS layer
    // is cropped to its content box, so AE shifts the mask by the crop
    // origin ((20,12)-(52,44) minus origin (4,4), AE 2026 fixture).
    const ae_project = parse_aep(IMPORT_DIR.div("psd_vector_mask_cropped.aep")).project;
    const [project, comp] = _styles_import(ASSETS.div("psd_vector_mask.psd"), ImportAsType.COMP_CROPPED_LAYERS);
    const py_comp = as_instance(
      _next(project.items.values(), (item) => item instanceof CompItem && item.name === comp.name),
      CompItem,
    );
    const parade = py_comp.layer("vector masked").property("ADBE Mask Parade");
    const shape = as_instance(parade.properties[0], PropertyGroup).property("ADBE Mask Shape").value;
    expect(py_eq(shape.vertices, [[16.0, 8.0], [48.0, 8.0], [48.0, 40.0], [16.0, 40.0]])).toBe(true);
    const ae_tree = _mask_parade_bytes(ae_project, "psd_vector_mask", "vector masked");
    const py_tree = _mask_parade_bytes(project, comp.name, "vector masked");
    expect(py_eq(py_tree, ae_tree)).toBe(true);
  });

  test("test_cropped_mask_vertices_survive_reparse", () => {
    // Mask space is LAYER space: after save + reparse, the cached parse
    // Shape must still denormalize by the (56px cropped) layer size, not
    // the 64px comp - reading vertices must return the same layer-space
    // coordinates as before the round-trip.
    const tmp_path = make_tmp_path();
    const [project, comp] = _styles_import(ASSETS.div("psd_vector_mask.psd"), ImportAsType.COMP_CROPPED_LAYERS);
    const out = tmp_path.div("cropped_mask.aep");
    project.save(out);
    const reparsed = parse_project_fresh(out);
    const layer = as_instance(
      as_instance(
        _next(reparsed.items.values(), (item) => item instanceof CompItem && item.name === comp.name),
        CompItem,
      ).layer("vector masked"),
      AVLayer,
    );
    expect(py_eq([layer.width, layer.height], [56, 56])).toBe(true);
    const shape = as_instance(layer.property("ADBE Mask Parade").properties[0], PropertyGroup).property("ADBE Mask Shape").value;
    // f4 shph precision loss on the round-trip; the scale basis is what
    // matters (layer 56, not comp 64 which would give ~18.3/9.1).
    const flat = shape.vertices.flatMap((vertex) => vertex);
    expect(approx(flat, [16.0, 8.0, 48.0, 8.0, 48.0, 40.0, 16.0, 40.0], { abs: 1e-3 })).toBe(true);
  });

  /**
   * A PSD clipping pair (base + clipped-to-base layer) imports like
   * AE: a nested comp named "<stem> (1)", the base's name baked on the
   * uncollapsed parent layer with name_set off, and preserve
   * transparency on the clipped member (psd_clipping_mask fixture) -
   * verified through a disk round-trip.
   */
  test("test_clipping_run_auto_precomposes", () => {
    const tmp_path = make_tmp_path();
    const [project, comp] = _styles_import(ASSETS.div("psd_clipping_mask.psd"), ImportAsType.COMP);
    const out = tmp_path.div("clipping.aep");
    project.save(out);
    const reparsed = parse_project_fresh(out);
    const main = as_instance(
      _next(reparsed.items.values(), (item) => item instanceof CompItem && item.name === comp.name),
      CompItem,
    );
    const base_layer = as_instance(main.layer("base"), AVLayer);
    py_assert(base_layer.source instanceof CompItem);
    expect(base_layer.source.name).toBe(`${comp.name} (1)`);
    expect(base_layer._ldta.name_set).toBe(false);
    expect(base_layer.label).toBe(15);
    expect(base_layer.collapse_transformation).toBe(false);
    const nested = base_layer.source;
    expect(py_eq(nested.layers.map((layer) => layer.name), ["clipped", "base"])).toBe(true);
    expect(as_instance(nested.layer("clipped"), AVLayer).preserve_transparency).toBe(true);
    expect(as_instance(nested.layer("base"), AVLayer).preserve_transparency).toBe(false);
    expect(as_instance(nested.parent_folder, FolderItem).name).toBe(`${comp.name} Layers`);
  });

  test("test_cropped_clipping_matches_ae", () => {
    // COMP_CROPPED_LAYERS + a clipping run: AE still auto-precomposes,
    // the base crops to its content box (40x40), the clipped layer keeps
    // its full-canvas content box, and every per-layer footage matches
    // AE byte-for-byte (opti + sspc modulo the still-import noise).
    const ae_project = parse_aep(IMPORT_DIR.div("psd_clipping_mask_cropped.aep")).project;
    const project = parse_aep(BASE).project;
    project.import_file(_cropped_opts(ASSETS.div("psd_clipping_mask.psd")));
    const ae_foot = new Map<string, FileSource>();
    for (const i of ae_project.items.values()) {
      if (i instanceof FootageItem && i.main_source instanceof FileSource) ae_foot.set(i.name, i.main_source);
    }
    const py_foot = new Map<string, FileSource>();
    for (const i of project.items.values()) {
      if (i instanceof FootageItem && i.main_source instanceof FileSource) py_foot.set(i.name, i.main_source);
    }
    expect(py_eq(new Set(ae_foot.keys()), new Set(py_foot.keys()))).toBe(true);
    for (const [name, ae_src] of ae_foot) {
      const py_src = getitem(py_foot, name);
      expect(py_eq(py_src._opti.tobytes(), ae_src._opti.tobytes())).toBe(true);
      _assert_sspc_matches(_sspc_bytes(ae_src), _sspc_bytes(py_src));
    }
    // The empty background "Layer 1" is full-canvas (64x64), not 1x1, and
    // keeps its raster channel count (4) despite the empty content box.
    const empty = getitem(py_foot, "Layer 1/psd_clipping_mask.psd");
    expect(py_eq([empty._width, empty._height], [64, 64])).toBe(true);
    expect(empty._sspc.data_size).toBe(0);
    expect(as_instance(empty._opti, PsdOptiChunk).psd_layer_channels).toBe(4);
  });

  test("test_layers_without_vector_masks_get_none", () => {
    // Raster layer masks are baked into the footage by AE (masks=0);
    // the disk round-trip also re-reads the created mask chunks.
    const tmp_path = make_tmp_path();
    const [project, comp] = _styles_import(ASSETS.div("psd_raster_mask.psd"), ImportAsType.COMP);
    const comp_item = as_instance(
      _next(project.items.values(), (item) => item instanceof CompItem && item.name === comp.name),
      CompItem,
    );
    const parade = comp_item.layer("masked").property("ADBE Mask Parade");
    expect(parade.properties.length).toBe(0);

    const [project2, comp2] = _styles_import(ASSETS.div("psd_vector_mask.psd"), ImportAsType.COMP);
    const out = tmp_path.div("vector_mask.aep");
    project2.save(out);
    const reparsed = parse_project_fresh(out);
    const ae_project = parse_aep(IMPORT_DIR.div("psd_vector_mask.aep")).project;
    const ae_tree = _mask_parade_bytes(ae_project, "psd_vector_mask", "vector masked");
    const re_tree = _mask_parade_bytes(reparsed, comp2.name, "vector masked");
    expect(py_eq(re_tree, ae_tree)).toBe(true);
  });
});

/**
 * import_file fills an unset layer_styles/layer_dimensions from the
 * machine's sticky PSD import-dialog preferences (AE's own importFile does
 * the same). Factory fallbacks are covered by the merge/editable tests
 * above; these cover the pref-driven path and its PSD-only gating.
 */
describe("TestImportChoicePrefsWiring", () => {
  const _SECTION = "Choose Layer Dialog";

  test("test_footage_layer_styles_from_pref", () => {
    const project = parse_aep(BASE).project;
    // PSD Footage Layer Styles Option: 1 = ignore.
    project._preferences.set_pref_as_number(_SECTION, "PSD Footage Layer Styles Option", 1);
    const source = as_instance(project.import_file(_layer_opts(STYLED_PSD, 1)), FootageItem).main_source;
    py_assert(source instanceof FileSource);
    expect(source.layer_styles).toBe("ignore");
  });

  test("test_explicit_layer_styles_overrides_pref", () => {
    const project = parse_aep(BASE).project;
    project._preferences.set_pref_as_number(
      _SECTION,
      "PSD Footage Layer Styles Option",
      1, // ignore
    );
    const opts = _layer_opts(STYLED_PSD, 1);
    opts.layer_styles = "merge";
    const source = as_instance(project.import_file(opts), FootageItem).main_source;
    py_assert(source instanceof FileSource);
    expect(source.layer_styles).toBe("merge");
  });

  test("test_footage_dimensions_from_pref", () => {
    const project = parse_aep(BASE).project;
    // PSD Dimensions Popup: 0 = layer (style-less solo layer, no expansion).
    project._preferences.set_pref_as_number(_SECTION, "PSD Dimensions Popup", 0);
    const source = as_instance(project.import_file(_layer_opts(ASSETS.div("choose_layer.psd"), 3)), FootageItem).main_source;
    py_assert(source instanceof FileSource);
    expect(source._sspc.full_frame).toBe(false);
  });

  test("test_comp_layer_styles_from_pref", () => {
    const project = parse_aep(BASE).project;
    // PSD Comp Layer Styles Option v2: 1 = merge (bakes the styles in).
    project._preferences.set_pref_as_number(_SECTION, "PSD Comp Layer Styles Option v2", 1);
    const opts = new ImportOptions(SINGLE_PSD);
    opts.import_as = ImportAsType.COMP;
    project.import_file(opts);
    const source = _psd_footage_source(project, "Layer 1/psd_layer_styles_8bits_single.psd");
    expect(source.layer_styles).toBe("merge");
  });

  test("test_ai_layer_import_ignores_psd_dimensions_pref", () => {
    // The dimensions pref is PSD-only. AI/PDF has its own sticky
    // "AI Dimensions Popup", but AE's scripted importFile ignores it
    // (measured on AE 2026: both indices give identical full-document
    // footage), so py_aep does not follow it either and an AI/PDF layer
    // import keeps its document-size default.
    const project = parse_aep(BASE).project;
    project._preferences.set_pref_as_number(
      _SECTION,
      "PSD Dimensions Popup",
      0, // layer
    );
    const source = as_instance(project.import_file(_layer_opts(ASSETS.div("ai.ai"), 0)), FootageItem).main_source;
    py_assert(source instanceof FileSource);
    expect(source._sspc.full_frame).toBe(true);
  });
});

test.each([ImportAsType.COMP, ImportAsType.COMP_CROPPED_LAYERS])(
  "test_layered_comp_takes_the_file_pixel_aspect[%#]",
  (import_as: ImportAsType) => {
    // psd_layer_styles.psd is 4:3; AE 2026 gives the import comp that aspect
    // (footage_depth.aep "comp:psd_layer_styles.psd"; the render matrix shows
    // the same for COMP_CROPPED_LAYERS).
    const truth = _next(parse_aep(IMPORT_DIR.div("footage_depth.aep")).project.compositions, (c) => c.name === "comp:psd_layer_styles.psd");
    const project = parse_aep(BASE).project;
    const options = new ImportOptions(ASSETS.div("psd_layer_styles.psd"));
    options.import_as = import_as;
    const comp = project.import_file(options);
    expect(comp instanceof CompItem).toBe(true);
    expect(approx(comp.pixel_aspect, truth.pixel_aspect)).toBe(true);
    expect(approx(truth.pixel_aspect, 4 / 3)).toBe(true);
  },
);

// AE 2026 refuses these as an image sequence ("files of type ... cannot be
// used as sequences"); it accepts exr png tif dpx cin jpg tga bmp gif hdr crw
// eps pdf psd psb ai.
const _NO_SEQUENCE_ASSETS = [
  "mov_480.mov",
  "m4v.m4v",
  "mp4_640x360.mp4",
  "wmv.wmv",
  "mpeg.mpeg",
  "swf.swf",
  "click.aiff",
  "aif.aif",
  "wav.wav",
  "mp3.mp3",
  "aac.aac",
  "m4a.m4a",
  "heic.heic",
  "crystal.fbx",
  "txt.txt",
  "csv.csv",
  "json.json",
  "mgjson.mgjson",
];

describe("TestSequenceRefusedFormats", () => {
  test.each(_NO_SEQUENCE_ASSETS)("test_import_as_sequence_raises[%#]", (name: string) => {
    const project = parse_aep(BASE).project;
    const options = new ImportOptions(ASSETS.div(name));
    options.sequence = true;
    const count = len(project.items);
    raises(
      ValueError,
      () => {
        project.import_file(options);
      },
      "sequence",
    );
    expect(len(project.items)).toBe(count);
  });

  test.each(["mov_480.mov", "wav.wav", "json.json"])("test_replace_and_proxy_with_sequence_raise[%#]", (name: string) => {
    const project = parse_aep(BASE).project;
    const item = as_instance(project.import_file(new ImportOptions(ASSETS.div("tga_24.tga"))), FootageItem);
    raises(
      ValueError,
      () => {
        item.replace_with_sequence(ASSETS.div(name));
      },
      "sequence",
    );
    raises(
      ValueError,
      () => {
        item.set_proxy_with_sequence(ASSETS.div(name));
      },
      "sequence",
    );
    expect(String(as_instance(item.main_source, FileSource).file).endsWith("tga_24.tga")).toBe(true);
    expect(item.proxy_source == null).toBe(true);
  });
});
