/** Regression tests for the v9 fuzz findings on footage import, reload,
replace and interpretation (area C). Each expectation is AE 2026 ground
truth from an AE import / reload / render of the same file (see the
comments), or an exact law. */

import { expect, test } from "bun:test";
import { copyFileSync, utimesSync } from "node:fs";
import * as nodepath from "node:path";
import { deflateSync } from "node:zlib";
import { AssertionError_, at, b, bytes_, concat, dict_get, encode, floordiv, format, getattr, getitem, len, mod, Path, fspath, py_assert, py_bool, py_eq, py_or, range, sorted, struct, sum, TypeError_, ValueError } from "../../src/pyrt/index.ts";
import { approx, make_tmp_path, raises, skip } from "../../src/pyrt/pytest.ts";
import { ImportAsType, parse as parse_aep } from "../../src/py_aep/index.ts";
import { default_icc_directories, default_icc_library, icc_profile_id } from "../../src/py_aep/color/icc.ts";
import { CURRENT_VALUE, ImportOptions } from "../../src/py_aep/models/import_options.ts";
import { FootageItem } from "../../src/py_aep/models/items/footage.ts";
import { CompItem } from "../../src/py_aep/models/items/composition.ts";
import { AVItem } from "../../src/py_aep/models/items/av_item.ts";
import { Layer } from "../../src/py_aep/models/layers/layer.ts";
import { AVLayer } from "../../src/py_aep/models/layers/av_layer.ts";
import type { Project } from "../../src/py_aep/models/project.ts";
import { FileSource } from "../../src/py_aep/models/sources/file.ts";
import { IpwsChunk } from "../../src/py_aep/binary/misc_chunks.ts";
import { Utf8Chunk } from "../../src/py_aep/binary/scalar_chunks.ts";
import { list_layers } from "../../src/py_aep/resolvers/source_layers.ts";
import "../../src/py_aep/binary/_register.ts";
import { as_instance, parse_project_fresh, project_bytes } from "../helpers.ts";

const SAMPLES = new Path(import.meta.path).parent.parent.parent.div("samples");
const ASSETS = SAMPLES.div("assets");
const BASE = SAMPLES.div("models", "folder", "folder.aep");
// An Adobe-CMS project (no working space), as AE's own imports were probed in.
const ADOBE_BASE = SAMPLES.div("models", "import", "windows_stills.aep");
const _ICC_AVAILABLE = default_icc_directories().some((d) => d.is_dir());

// NOTE(port): shutil.copy(src, dest) copies file bytes and permission bits; copyFileSync does the same for these file-to-file calls
function shutil_copy(src: Path, dest: Path): Path {
  copyFileSync(fspath(src), fspath(dest));
  return dest;
}

function _project(base: Path = BASE): Project {
  return parse_aep(base, { platform: "windows" }).project;
}

type ImportOptionValues = Partial<
  Pick<ImportOptions, "import_as" | "sequence" | "force_alphabetical" | "layer_index" | "layer_dimensions" | "layer_styles" | "range_start" | "range_end">
>;

function _import(project: Project, path: Path, options: ImportOptionValues = {}): FootageItem | CompItem {
  const opts = new ImportOptions(path);
  // setattr(opts, key, value) for each option: Object.assign runs the setters.
  Object.assign(opts, options);
  // NOTE(port): warnings.simplefilter("ignore") only silences output; pyrt warn records without echoing, so import_file behaves the same
  return project.import_file(opts);
}

// The FileSource behind an imported footage item.
function _file_source(item: AVItem): FileSource {
  return as_instance(as_instance(item, FootageItem).main_source, FileSource);
}

function _layer_footage(project: Project, file_name: string): FootageItem[] {
  return project.footages.filter(
    (item) =>
      item.main_source instanceof FileSource &&
      nodepath.win32.basename(fspath(item.main_source.file)) === file_name &&
      py_bool(item.main_source.layer_name),
  );
}

function _pin_bytes(source: FileSource): Map<string, Uint8Array> {
  // Every Pin chunk but the random `pgui` id.
  const out = new Map<string, Uint8Array>();
  for (const [index, c] of source._pin.chunks.entries()) {
    if (c.chunk_type !== "pgui") {
      out.set(`${index}:${py_or(getattr(c, "list_type", null), c.chunk_type)}`, c.tobytes());
    }
  }
  return out;
}

// --- synthetic files -----------------------------------------------------

/** One PSD layer record and its channel data. */
function _psd_record(
  name: string,
  box: [number, number, number, number],
  kw: { hidden?: boolean; lyid?: number | null; lsct?: number | null } = {},
): [Uint8Array, Uint8Array] {
  const { hidden = false, lyid = null, lsct = null } = kw;
  const [top, left, bottom, right] = box;
  const size = Math.max(right - left, 0) * Math.max(bottom - top, 0);
  const channels = [-1, 0, 1, 2];
  let record = struct.pack(">iiiiH", top, left, bottom, right, len(channels));
  for (const channel of channels) {
    record = concat(record, struct.pack(">hI", channel, 2 + size));
  }
  record = concat(record, b("8BIMnorm"), Uint8Array.of(255, 0, hidden ? 0x02 : 0x00, 0));
  const raw_name = encode(name, "latin-1", "replace").slice(0, 255);
  let pascal = concat(Uint8Array.of(len(raw_name)), raw_name);
  pascal = concat(pascal, bytes_.repeat(b("\0"), mod(-len(pascal), 4)));
  let unicode_name = concat(struct.pack(">I", len(Array.from(name))), encode(name, "utf-16-be"));
  unicode_name = concat(unicode_name, bytes_.repeat(b("\0"), mod(-len(unicode_name), 4)));
  let extra = concat(struct.pack(">II", 0, 0), pascal);
  extra = concat(extra, b("8BIMluni"), struct.pack(">I", len(unicode_name)), unicode_name);
  if (lyid != null) extra = concat(extra, b("8BIMlyid"), struct.pack(">II", 4, lyid));
  // 3 = group bounding divider, 1 = open group header
  if (lsct != null) extra = concat(extra, b("8BIMlsct"), struct.pack(">II", 4, lsct));
  record = concat(record, struct.pack(">I", len(extra)), extra);
  const data = bytes_.join(channels.map(() => concat(struct.pack(">H", 0), bytes_.repeat(Uint8Array.of(200), size))));
  return [record, data];
}

/** An 8-bit RGB PSD with raw-coded layer records. */
function _psd(path: Path, size: number, records: [Uint8Array, Uint8Array][]): Path {
  let layer_info = struct.pack(">h", -len(records));
  layer_info = concat(
    layer_info,
    bytes_.join(records.map(([r]) => r)),
    bytes_.join(records.map(([, d]) => d)),
  );
  layer_info = concat(layer_info, bytes_.repeat(b("\0"), mod(len(layer_info), 2)));
  const section = concat(struct.pack(">I", len(layer_info)), layer_info, struct.pack(">I", 0));
  const header = concat(
    b("8BPS"),
    struct.pack(">H", 1),
    bytes_.repeat(b("\0"), 6),
    struct.pack(">HIIHH", 3, size, size, 8, 3),
  );
  let body = concat(struct.pack(">II", 0, 0), struct.pack(">I", len(section)), section);
  body = concat(body, struct.pack(">H", 0), bytes_.repeat(Uint8Array.of(128), size * size * 3));
  path.write_bytes(concat(header, body));
  return path;
}

/** An uncompressed 8x8 little-endian TIFF (palette: a full colour map). */
function _tiff(path: Path, bits: number[], photometric: number, extra: number | null): Path {
  const width = 8;
  const height = 8;
  const row = floordiv(width * sum(bits) + 7, 8);
  const pixels = bytes_.repeat(Uint8Array.of(0x40), row * height);
  let out = concat(b("II*\0\0\0\0\0"), pixels);
  if (mod(len(out), 2) !== 0) out = concat(out, b("\0"));
  const tags: [number, number, number, Uint8Array][] = [
    [256, 3, 1, struct.pack("<HH", width, 0)],
    [257, 3, 1, struct.pack("<HH", height, 0)],
    [259, 3, 1, struct.pack("<HH", 1, 0)],
    [262, 3, 1, struct.pack("<HH", photometric, 0)],
    [273, 4, 1, struct.pack("<I", 8)],
    [277, 3, 1, struct.pack("<HH", len(bits), 0)],
    [278, 4, 1, struct.pack("<I", height)],
    [279, 4, 1, struct.pack("<I", len(pixels))],
  ];
  const bps = bytes_.join(bits.map((b_) => struct.pack("<H", b_)));
  if (len(bps) <= 4) {
    tags.push([258, 3, len(bits), bytes_.ljust(bps, 4, 0)]);
  } else {
    tags.push([258, 3, len(bits), struct.pack("<I", len(out))]);
    out = concat(out, bps);
  }
  if (extra != null) tags.push([338, 3, 1, struct.pack("<HH", extra, 0)]);
  if (photometric === 3) {
    const entries = 1 << bits[0];
    const color_map = bytes_.join(
      Array.from(range(entries), (i) => struct.pack("<H", floordiv(i * 65535, entries - 1))),
    );
    tags.push([320, 3, 3 * entries, struct.pack("<I", len(out))]);
    out = concat(out, bytes_.repeat(color_map, 3));
  }
  tags.splice(0, tags.length, ...sorted(tags));
  const ifd = len(out);
  // struct.pack_into("<I", out, 4, ifd): out is ours and already spans offset 4
  out.set(struct.pack("<I", ifd), 4);
  out = concat(out, struct.pack("<H", len(tags)));
  for (const [tag, kind, count, value] of tags) {
    out = concat(out, struct.pack("<HHI", tag, kind, count), value);
  }
  out = concat(out, b("\0\0\0\0"));
  path.write_bytes(out);
  return path;
}

// NOTE(port): table-driven IEEE CRC-32 (poly 0xedb88320) yields the same values as zlib.crc32
const CRC_TABLE: number[] = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function _png(path: Path, width: number, height: number): Path {
  const raw = bytes_.join(
    Array.from(range(height), () => concat(b("\x00"), bytes_.repeat(b("\x00"), width))),
  );

  const chunk = (kind: Uint8Array, data: Uint8Array): Uint8Array => {
    const crc = crc32(concat(kind, data));
    return concat(struct.pack(">I", len(data)), kind, data, struct.pack(">I", crc));
  };

  const header = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0);
  // NOTE(port): both are zlib deflate at level 9; the tests only read the decoded pixels, never the compressed bytes
  path.write_bytes(
    concat(
      b("\x89PNG\r\n\x1a\n"),
      chunk(b("IHDR"), header),
      chunk(b("IDAT"), deflateSync(raw, { level: 9 })),
      chunk(b("IEND"), b("")),
    ),
  );
  return path;
}

// --- C2: malformed .ai imports as footage --------------------------------

test.each([
  [b("%PDF-1.5\n1 0 obj\n<</OCProperties<</D<</Order 8 0 R/")],
  [b('%PDF-1.5\n1 0 obj\n<</OCProperties<</D "x>>>>\n')],
])("test_malformed_ai_still_imports_as_footage[%#]", (data) => {
  // A truncated or corrupt .ai hung (COS lexer EOF loop) or raised
  // SyntaxError since the import started counting its layers; it imports
  // as whole-document footage, as before.
  const tmp_path = make_tmp_path();
  const path = tmp_path.div("bad.ai");
  path.write_bytes(data);
  const item = _import(_project(), path);
  expect(_file_source(item)._opti.text_document_layers).toBe(0);
});

// --- C1 / C12: reload --------------------------------------------------

test.each([
  ["layer_bounds.psd", { import_as: ImportAsType.COMP_CROPPED_LAYERS }],
  ["layer_bounds.psd", { import_as: ImportAsType.COMP }],
  ["psd_layer_styles.psd", { layer_index: 0, layer_styles: "ignore" }],
  ["layer_bounds.psd", { layer_index: 0, layer_dimensions: "layer" }],
  ["ai.ai", { import_as: ImportAsType.COMP }],
  ["ai.ai", { layer_index: 0, layer_dimensions: "layer" }],
])("test_reload_keeps_the_layer_binding[%#]", (asset: string, options: ImportOptionValues) => {
  const tmp_path = make_tmp_path();
  // AE 2026 reloads a layer-bound source as that same layer (a cropped
  // layer stays 10x12, the name stays "<layer>/<file>"); py_aep used to
  // rebuild it as the merged document.
  const project = _project();
  _import(project, ASSETS.div(asset), options);
  const items = _layer_footage(project, asset);
  expect(py_bool(items)).toBe(true);
  const before = new Map(
    items.map((item) => [item.id, [item.name, _pin_bytes(_file_source(item))]] as const),
  );
  for (const item of items) {
    _file_source(item).reload();
  }
  for (const item of items) {
    const [name, pin] = getitem(before, item.id);
    expect(py_eq(item.name, name)).toBe(true);
    expect(py_eq(_pin_bytes(_file_source(item)), pin)).toBe(true);
  }
  const out = tmp_path.div("reloaded.aep");
  project.save(out);
  const reparsed = parse_project_fresh(out);
  for (const item of items) {
    expect(py_eq(getitem(reparsed.items, item.id).name, getitem(before, item.id)[0])).toBe(true);
  }
});

test("test_reload_restamps_the_source_mtime", () => {
  const tmp_path = make_tmp_path();
  // AE 2026 writes the file's current mtime into the sspc stamp on reload.
  const path = tmp_path.div("frame.png");
  shutil_copy(ASSETS.div("image_with_alpha.png"), path);
  utimesSync(fspath(path), 1_600_000_000, 1_600_000_000);
  const item = _import(_project(), path);
  utimesSync(fspath(path), 1_700_000_000, 1_700_000_000);
  _file_source(item).reload();
  expect(_file_source(item)._sspc.source_modified).toBe(1_700_000_000);
});

test("test_sequence_reload_keeps_the_unreduced_duration", () => {
  // A sequence's duration is frames over rate, unreduced (3/30), as the
  // import and every AE-authored sequence write it.
  const item = _import(_project(), ASSETS.div("dpx_seq.0001.dpx"), { sequence: true });
  const sspc = _file_source(item)._sspc;
  const before = [sspc.duration_dividend, sspc.duration_divisor];
  _file_source(item).reload();
  expect(py_eq([sspc.duration_dividend, sspc.duration_divisor], before)).toBe(true);
  expect(py_eq(before, [3, 30])).toBe(true);
});

// --- C4: conform rates AE cannot open ------------------------------------

test.each([["mov_23_976.mov"], ["dpx_seq.0001.dpx"]])("test_tiny_conform_rate_is_rejected_unmodified[%#]", (asset: string) => {
  // AE 2026 refused to open py's projects holding 0.0004 ("zero denominator
  // in ratio multiply") and opened 0.0005 on a movie and a sequence.
  const project = _project();
  const item = _import(project, ASSETS.div(asset), { sequence: asset.endsWith(".dpx") });
  const before = project_bytes(project);
  raises(ValueError, () => {
    _file_source(item).conform_frame_rate = 0.0004;
  }, "0.0005");
  expect(py_eq(project_bytes(project), before)).toBe(true);
  _file_source(item).conform_frame_rate = 0.0005;
  expect(approx(_file_source(item).conform_frame_rate, 0.0005, { abs: 1e-5 })).toBe(true);
});

// --- C6: footage size ------------------------------------------------------

test("test_footage_wider_than_32767_px_is_rejected_unmodified", () => {
  const tmp_path = make_tmp_path();
  // AE reads the sspc size as signed 16-bit: 65535 px opened as -1, and
  // 65536 did not fit (save failed). Rejected before anything is added.
  const project = _project();
  const before = project_bytes(project);
  for (const path of [
    _png(tmp_path.div("wide.png"), 32768, 1),
    _psd(tmp_path.div("wide.psd"), 1, [_psd_record("a", [0, 0, 1, 1])]),
  ]) {
    if (path.suffix === ".psd") {
      const data = Uint8Array.from(path.read_bytes());
      // struct.pack_into(">I", data, 18, 40000) - canvas width
      data.set(struct.pack(">I", 40000), 18);
      path.write_bytes(data);
    }
    for (const how of [ImportAsType.FOOTAGE, ImportAsType.COMP]) {
      if (how === ImportAsType.COMP && path.suffix !== ".psd") continue;
      raises(ValueError, () => _import(project, path, { import_as: how }), "32767");
      expect(py_eq(project_bytes(project), before)).toBe(true);
    }
  }
  expect(_import(project, _png(tmp_path.div("ok.png"), 32767, 1)).width).toBe(32767);
});

// --- C7 / C10 / C13: synthetic Photoshop documents ------------------------

test.each([[ImportAsType.COMP], [ImportAsType.COMP_CROPPED_LAYERS]])("test_hidden_photoshop_layer_imports_disabled[%#]", (how) => {
  const tmp_path = make_tmp_path();
  // AE 2026 turns the video switch off for a layer hidden in Photoshop
  // (synthetic hidden_layer.psd: frame 0 rendered without it).
  const path = _psd(tmp_path.div("hidden.psd"), 16, [
    _psd_record("visible", [0, 0, 8, 8], { lyid: 2 }),
    _psd_record("hidden", [4, 4, 12, 12], { hidden: true, lyid: 3 }),
  ]);
  const comp = as_instance(_import(_project(), path, { import_as: how }), CompItem);
  const enabled = new Map(comp.layers.map((layer) => [String(layer.name), layer.enabled] as const));
  expect(py_eq(enabled, new Map([["hidden", false], ["visible", true]]))).toBe(true);
});

test.each([[ImportAsType.COMP], [ImportAsType.COMP_CROPPED_LAYERS]])("test_hidden_photoshop_group_imports_disabled[%#]", (how) => {
  const tmp_path = make_tmp_path();
  // AE 2026 turns the group's nested-comp layer off and leaves the
  // children's switches alone (synthetic hidden_group.psd).
  const path = _psd(tmp_path.div("hidden_group.psd"), 16, [
    _psd_record("</Layer group>", [0, 0, 0, 0], { lsct: 3, lyid: 10 }),
    _psd_record("in hidden group", [0, 0, 8, 8], { lyid: 11 }),
    _psd_record("hidden group", [0, 0, 0, 0], { hidden: true, lsct: 1, lyid: 12 }),
    _psd_record("top visible", [8, 8, 16, 16], { lyid: 13 }),
  ]);
  const comp = as_instance(_import(_project(), path, { import_as: how }), CompItem);
  const layers = new Map<string, Layer>(comp.layers.map((layer) => [String(layer.name), layer] as const));
  expect(getitem(layers, "top visible").enabled).toBe(true);
  const group = getitem(layers, "hidden group");
  expect(group.enabled).toBe(false);
  expect(
    py_eq(
      as_instance(as_instance(group, AVLayer).source, CompItem).layers.map((inner) => inner.enabled),
      [true],
    ),
  ).toBe(true);
});

test("test_layer_ids_without_lyid_number_from_two", () => {
  const tmp_path = make_tmp_path();
  // AE 2026 numbers the layers of a PSD without `lyid` blocks from 2 in
  // record order (opti 0x154 and sspc layer_id).
  const path = _psd(tmp_path.div("no_ids.psd"), 16, [
    _psd_record("a", [0, 0, 8, 8]),
    _psd_record("b", [8, 8, 16, 16]),
  ]);
  const project = _project();
  _import(project, path, { import_as: ImportAsType.COMP });
  const ids = new Map(
    _layer_footage(project, path.name).map(
      (item) => [String(_file_source(item).layer_name), _file_source(item)._sspc.layer_id] as const,
    ),
  );
  expect(py_eq(ids, new Map([["a", 2], ["b", 3]]))).toBe(true);
});

test("test_photoshop_layer_count_above_255", () => {
  const tmp_path = make_tmp_path();
  // The opti layer count is 16-bit: AE 2026 writes 300 (`2c 01`) for a
  // 300-layer document, merged and per layer.
  const path = _psd(
    tmp_path.div("many.psd"),
    40,
    Array.from(range(300), (i) =>
      _psd_record(`L${format(i, "03d")}`, [mod(i, 40), mod(i, 39), mod(i, 40) + 1, mod(i, 39) + 1]),
    ),
  );
  const project = _project();
  const merged = _import(project, path);
  expect(_file_source(merged)._opti.psd_layer_count).toBe(300);
  const layer = _import(project, path, { layer_index: 0 });
  expect(_file_source(layer)._opti.psd_layer_count).toBe(300);
});

test("test_long_photoshop_layer_name_is_cut_to_255_bytes", () => {
  const tmp_path = make_tmp_path();
  // AE 2026 keeps the longest UTF-8 prefix of 255 bytes for the comp layer.
  const name = "été 日本 " + "x".repeat(300);
  const path = _psd(tmp_path.div("long.psd"), 16, [_psd_record(name, [0, 0, 8, 8], { lyid: 2 })]);
  const comp = as_instance(_import(_project(), path, { import_as: ImportAsType.COMP }), CompItem);
  const layer_name = String(comp.layers[0].name);
  expect(len(encode(layer_name, "utf-8"))).toBe(255);
  expect(name.startsWith(String(layer_name))).toBe(true);
});

test("test_background_layer_is_named_background", () => {
  // AE 2026 names Photoshop's Background layer "Background" whatever the
  // file stores (a French Photoshop's "Arrière-plan"; footage_depth.aep).
  const asset = ASSETS.div("depth", "psd_rgb8_bg_layer.psd");
  expect(list_layers(asset).at(-1)).toBe("Background");
  const comp = as_instance(_import(_project(), asset, { import_as: ImportAsType.COMP }), CompItem);
  expect(py_eq(comp.layers.map((layer) => String(layer.name)), ["Layer 1", "Background"])).toBe(true);
});

// --- C9: empty content box at Layer Size -------------------------------

test.each([
  ["grouped_layers.psd", "hue/sat adj", [80, 60]],
  ["psd_clipping_mask.psd", "Layer 1", [64, 64]],
])("test_empty_layer_at_layer_size_spans_the_canvas[%#]", (asset: string, layer_name: string, size: number[]) => {
  // As in AE's cropped-comp import of the same layer (fixtures
  // grouped_layers_cropped / psd_clipping_mask_cropped); 0x0 before.
  const index = list_layers(ASSETS.div(asset)).indexOf(layer_name);
  const item = _import(_project(), ASSETS.div(asset), { layer_index: index, layer_dimensions: "layer" });
  expect(py_eq([item.width, item.height], size)).toBe(true);
  expect(_file_source(item)._sspc.full_frame).toBe(false);
});

test("test_replace_current_value_keeps_an_empty_cropped_layer", () => {
  const project = _project();
  _import(project, ASSETS.div("grouped_layers.psd"), {
    import_as: ImportAsType.COMP_CROPPED_LAYERS,
  });
  const item = project.footages.find((f) => String(f.name) === "hue/sat adj/grouped_layers.psd");
  py_assert(item != null, "StopIteration");
  item.replace(ASSETS.div("grouped_layers.psd"), CURRENT_VALUE);
  expect(py_eq([item.width, item.height], [80, 60])).toBe(true);
});

// --- C8: image sequences -----------------------------------------------

function _frames(folder: Path, names: string[]): Path {
  folder.mkdir();
  for (const name of names) {
    shutil_copy(ASSETS.div("depth", "png_g8.png"), folder.div(name));
  }
  return folder;
}

test.each([
  // AE 2026: at most the last 9 digits are the frame number.
  [["f_99999999998.png", "f_99999999999.png"], 1, "f_99[999999998-999999999].png"],
  [["f_4294967294.png", "f_4294967295.png"], 1, "f_4[294967294-294967295].png"],
  // AE 2026 (Windows): prefixes compare case-insensitively, the name
  // takes the first frame's.
  [["F_001.png", "f_002.png"], 1, "F_[001-002].png"],
])("test_sequence_frame_numbers_match_after_effects[%#]", (names: string[], pick: number, expected: string) => {
  const tmp_path = make_tmp_path();
  const folder = _frames(tmp_path.div("seq"), names);
  const project = _project();
  const item = _import(project, folder.div(names[pick]), { sequence: true });
  expect(py_eq(item.name, expected)).toBe(true);
  const out = tmp_path.div("seq.aep");
  project.save(out);
  expect(py_eq(getitem(parse_project_fresh(out).items, item.id).name, expected)).toBe(true);
});

test("test_huge_frame_range_with_a_fractional_rate_saves", () => {
  const tmp_path = make_tmp_path();
  // frames x 100 / 2997 overflowed the u4 duration dividend at save.
  const project = _project();
  const item = _import(project, ASSETS.div("dpx_seq.0001.dpx"), {
    sequence: true,
    range_start: 1,
    range_end: 2 ** 32 - 1,
  });
  _file_source(item).conform_frame_rate = 29.97;
  project.save(tmp_path.div("range.aep"));
  const expected = (2 ** 32 - 1) / 29.97;
  expect(approx(item.duration, expected, { rel: 1e-6 })).toBe(true);
});

test("test_replace_with_sequence_validates_force_alphabetical", () => {
  const item = as_instance(_import(_project(), ASSETS.div("image_with_alpha.png")), FootageItem);
  raises(TypeError_, () =>
    // @ts-expect-error deliberately passes a number force_alphabetical to check runtime validation
    item.replace_with_sequence(ASSETS.div("dpx_seq.0001.dpx"), 1),
  );
});

test("test_invalid_default_sequence_fps_preference_is_rejected", () => {
  const tmp_path = make_tmp_path();
  const prefs = tmp_path.div("prefs");
  prefs.mkdir();
  prefs.div("Adobe After Effects 26.0 Prefs-indep-general.txt").write_text(
    '["Import Options Preference Section"]\n' +
      '\t"Import Options Default Sequence FPS" = "0.000000"\n',
  );
  const project = parse_aep(BASE, { ae_preferences_dir: prefs }).project;
  raises(
    ValueError,
    () => _import(project, ASSETS.div("dpx_seq.0001.dpx"), { sequence: true }),
    "default sequence frame rate",
  );
});

// --- C13: TIFF bit depths below 8 ----------------------------------------

test.each([
  // AE 2026 reads 2/4-bit gray and palette TIFFs as 8 bits.
  [[2], 1, null, 40, 1, 0, 64],
  [[4], 1, null, 40, 1, 0, 64],
  [[4], 3, null, 8, 1, 0, 64],
  // A palette image's alpha sample is not counted in the opti.
  [[8, 8], 3, 2, 32, 1, 0, 64],
])(
  "test_tiff_depth_fields_match_after_effects[%#]",
  (
    bits: number[],
    photometric: number,
    extra: number | null,
    depth: number,
    channels: number,
    layers: number,
    data_size: number,
  ) => {
    const tmp_path = make_tmp_path();
    const item = _import(_project(), _tiff(tmp_path.div("t.tif"), bits, photometric, extra));
    const source = _file_source(item);
    const opti = source._opti.tobytes();
    expect(source._sspc.depth).toBe(depth);
    expect(opti[0x1E]).toBe(channels);
    expect(bytes_.int_from_bytes(opti.slice(0x28, 0x2A), "little")).toBe(8);
    expect(bytes_.int_from_bytes(opti.slice(0x30, 0x32), "little")).toBe(layers);
    expect(source._sspc.data_size).toBe(data_size);
  },
);

// --- C3: colour profiles (Adobe CMS project) -----------------------------

function _clrs(source: FileSource): Map<string, Uint8Array | string | number> {
  const clrs = source._clrs;
  if (clrs == null) throw new AssertionError_("source has no LIST:CLRS");
  const chunks = clrs.chunks;
  const out = new Map<string, Uint8Array | string | number>();
  for (const [index, chunk] of chunks.entries()) {
    if (["epid", "apid"].includes(chunk.chunk_type)) {
      out.set(chunk.chunk_type, chunk.data);
    } else if (chunk.chunk_type === "empd") {
      out.set("empd", as_instance(at(chunks, index + 1), Utf8Chunk).value);
    } else if (chunk.chunk_type === "ipws") {
      out.set("ipws", as_instance(chunk, IpwsChunk).value);
    } else if (["mcsp", "ocsp"].includes(chunk.chunk_type)) {
      out.set(chunk.chunk_type, as_instance(at(chunks, index + 1), Utf8Chunk).value);
    }
  }
  return out;
}

const _UNSET = bytes_.repeat(b("\xff"), 16);

test.each([
  ["depth/psd_cmyk8_flat.psd", "U.S. Web Coated (SWOP) v2"],
  ["depth/tif_cmyk8.tif", "U.S. Web Coated (SWOP) v2"],
  ["depth/psd_gray8_flat.psd", "Dot Gain 20%"],
  ["depth/tif_g8.tif", "Dot Gain 20%"],
  ["depth/tif_gf32.tif", "Linear Grayscale Profile"],
  ["depth/psd_lab8_flat.psd", "Lab D50"],
  ["depth/tif_lab8.tif", "Lab D50"],
  ["depth/psd_indexed8_flat.psd", "sRGB IEC61966-2.1"],
  ["depth/tif_pal8.tif", "sRGB IEC61966-2.1"],
  ["ai.ai", "Coated FOGRA39 (ISO 12647-2:2004)"],
])("test_non_rgb_media_names_its_profile[%#]", (asset: string, name: string) => {
  // AE 2026 records the profile by name only and interprets the footage in
  // the working space (Adobe CMS project, AE's import of the same file).
  const clrs = _clrs(_file_source(_import(_project(ADOBE_BASE), ASSETS.div(asset))));
  expect(py_eq(getitem(clrs, "empd"), name)).toBe(true);
  expect(getitem(clrs, "ipws")).toBe(1);
  expect(py_eq(getitem(clrs, "epid"), getitem(clrs, "apid"))).toBe(true);
  expect(py_eq(getitem(clrs, "apid"), _UNSET)).toBe(true);
  expect(!py_bool(dict_get(clrs, "mcsp")) && !py_bool(dict_get(clrs, "ocsp"))).toBe(true);
});

test("test_dpx_and_cineon_carry_no_profile", () => {
  for (const asset of ["dpx_10bit_be.dpx", "cin.cin"]) {
    const clrs = _clrs(_file_source(_import(_project(ADOBE_BASE), ASSETS.div(asset))));
    expect(py_eq(getitem(clrs, "epid"), getitem(clrs, "apid"))).toBe(true);
    expect(py_eq(getitem(clrs, "apid"), _UNSET)).toBe(true);
    expect(clrs.has("empd")).toBe(false);
    expect(getitem(clrs, "ipws")).toBe(1);
    expect(!py_bool(dict_get(clrs, "ocsp"))).toBe(true);
  }
});

test.each([
  // Bitmap: sRGB assigned, not taken as carried.
  ["depth/psd_bitmap_flat.psd", "apid", "sRGB IEC61966-2.1"],
  ["depth/tif_bilevel.tif", "apid", "sRGB IEC61966-2.1"],
  // Camera Raw develops into ProPhoto RGB, which AE embeds.
  ["crw.crw", "epid", "ProPhoto RGB"],
  // An RGB-profiled .ai embeds the profile like a raster file.
  ["complex.ai", "epid", "sRGB IEC61966-2.1"],
  // An .ai without PDF content draws with no profile: sRGB assigned.
  ["ai_no_pdf.ai", "apid", "sRGB IEC61966-2.1"],
])("test_profile_records_match_after_effects[%#]", (asset: string, slot: string, profile: string) => {
  // skipif(not _ICC_AVAILABLE): runs only when the Adobe ICC profiles are installed
  if (!_ICC_AVAILABLE) return skip("Adobe ICC profiles not installed");
  const clrs = _clrs(_file_source(_import(_project(ADOBE_BASE), ASSETS.div(asset))));
  const other = slot === "epid" ? "apid" : "epid";
  expect(py_eq(getitem(clrs, slot), icc_profile_id(default_icc_library().bytes_for(profile)))).toBe(true);
  expect(py_eq(getitem(clrs, other), _UNSET)).toBe(true);
  expect(clrs.has("empd")).toBe(false);
  expect(getitem(clrs, "ipws")).toBe(0);
});

test.each([
  [ADOBE_BASE, "windows", "heic_alpha.heic"],
  [SAMPLES.div("models/format_options/heic/base.aep"), "macos", "heic.heic"],
  [SAMPLES.div("models/format_options/heic/base.aep"), "macos", "heic_alpha.heic"],
])("test_heic_imports_with_linear_light_off[%#]", (fixture: Path, platform: string, asset: string) => {
  // AE 2026 imports HEIC with Interpret As Linear Light off on both
  // platforms (these fixtures, and a scripted import on Windows).
  const truth = new Map(
    parse_aep(fixture).project.footages.map((f) => [String(f.name), as_instance(f.main_source, FileSource)] as const),
  );
  const project = parse_aep(fixture, { platform }).project;
  const ours = _file_source(_import(project, ASSETS.div(asset)));
  const ours_linl = ours._linl;
  const truth_linl = getitem(truth, asset)._linl;
  py_assert(ours_linl != null && truth_linl != null, "missing linl");
  expect(ours_linl.value).toBe(truth_linl.value);
  expect(truth_linl.value).toBe(0);
});

const _MAC_EPOCH = 2082844800;

function _stamp(item: AVItem): Uint8Array {
  const idta = item._idta;
  py_assert(idta != null, "item has no idta");
  return idta.tobytes().slice(0x50, 0x54); // `item._idta.tobytes()[0x50:0x54]`
}

function _mac(unix_time: number): Uint8Array {
  return bytes_.int_to_bytes(unix_time + _MAC_EPOCH, 4, "big");
}

function _stamped_copy(src: Path, dest: Path, mtime: number): Path {
  shutil_copy(src, dest);
  utimesSync(fspath(dest), mtime, mtime);
  return dest;
}

test("test_idta_stamp_follows_the_file_in_use", () => {
  const tmp_path = make_tmp_path();
  // AE 2026 stamps a footage item's idta (0x50, big-endian Mac-epoch
  // seconds) with the mtime of the file in use: the main file on import,
  // replace and reload, the proxy's while a file proxy is in use, and the
  // main file's again after useProxy = false or setProxyToNone.
  const png = ASSETS.div("image_with_alpha.png");
  const main = _stamped_copy(png, tmp_path.div("main.png"), 1_610_000_000);
  const proxy = _stamped_copy(ASSETS.div("bmp.bmp"), tmp_path.div("proxy.bmp"), 1_610_002_000);
  const other = _stamped_copy(png, tmp_path.div("other.png"), 1_610_003_000);
  const project = _project();
  const item = as_instance(_import(project, main), FootageItem);
  expect(py_eq(_stamp(item), _mac(1_610_000_000))).toBe(true);
  item.set_proxy(proxy);
  expect(py_eq(_stamp(item), _mac(1_610_002_000))).toBe(true);
  item.use_proxy = false;
  expect(py_eq(_stamp(item), _mac(1_610_000_000))).toBe(true);
  item.use_proxy = true;
  expect(py_eq(_stamp(item), _mac(1_610_002_000))).toBe(true);
  item.set_proxy_to_none();
  expect(py_eq(_stamp(item), _mac(1_610_000_000))).toBe(true);
  item.replace(other);
  expect(py_eq(_stamp(item), _mac(1_610_003_000))).toBe(true);
  utimesSync(fspath(other), 1_700_000_000, 1_700_000_000);
  _file_source(item).reload();
  expect(py_eq(_stamp(item), _mac(1_700_000_000))).toBe(true);
  const out = tmp_path.div("out.aep");
  project.save(out);
  expect(
    py_eq(_stamp(as_instance(getitem(parse_project_fresh(out).items, item.id), AVItem)), _mac(1_700_000_000)),
  ).toBe(true);
});

test("test_idta_stamp_of_sequences_placeholders_and_comps", () => {
  const tmp_path = make_tmp_path();
  // AE 2026 stamps a sequence with its folder's mtime, leaves the stamp
  // alone when a placeholder becomes the proxy or the main source, and
  // keeps a comp's own (edit-time) stamp when it gets a file proxy
  // (sample proxy.aep).
  const folder = tmp_path.div("seq");
  folder.mkdir();
  for (const frame of ["s_001.png", "s_002.png"]) {
    _stamped_copy(ASSETS.div("image_with_alpha.png"), folder.div(frame), 1_610_000_000);
  }
  utimesSync(fspath(folder), 1_610_006_000, 1_610_006_000);
  const project = _project();
  const item = as_instance(_import(project, folder.div("s_001.png"), { sequence: true }), FootageItem);
  expect(py_eq(_stamp(item), _mac(1_610_006_000))).toBe(true);
  item.set_proxy_with_placeholder("PP", 10, 10, 25.0, 1.0);
  item.replace_with_placeholder("RP", 10, 10, 25.0, 1.0);
  expect(py_eq(_stamp(item), _mac(1_610_006_000))).toBe(true);
  const comp = project.root_folder.add_comp("C", 100, 100, 1.0, 1.0, 25.0);
  const before = _stamp(comp);
  comp.set_proxy(folder.div("s_001.png"));
  expect(py_eq(_stamp(comp), before)).toBe(true);
});
