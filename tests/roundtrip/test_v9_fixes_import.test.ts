/** Regression tests for the v9 fuzz findings on footage import, reload,
replace and interpretation (area C). Each expectation is AE 2026 ground
truth from an AE import / reload / render of the same file (see the
comments), or an exact law. */

import { expect, test } from "bun:test";
import { copyFileSync, utimesSync } from "node:fs";
import * as nodepath from "node:path";
import { deflateSync } from "node:zlib";
import { AssertionError, at, b, Bytes, concat, getOr, encode, floordiv, getMember, getOrThrow, len, mod, Path, fspath, assert, truthy, valueEquals, truthyOr, struct, ValueError } from "../../src/pyrt/index.ts";

import { ImportAsType, parse as parseAep } from "../../src/py_aep/index.ts";
import { defaultIccDirectories, defaultIccLibrary, iccProfileId } from "../../src/py_aep/color/icc.ts";
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
import { listLayers } from "../../src/py_aep/resolvers/source_layers.ts";
import "../../src/py_aep/binary/_register.ts";
import { asInstance, parseProjectFresh, projectBytes } from "../helpers.ts";
import { approx, makeTmpPath, raises, skip } from "../support/pytest.ts";
import { format, range, sorted, sum } from "../support/python.ts";

const SAMPLES = new Path(import.meta.path).parent.parent.parent.div("samples");
const ASSETS = SAMPLES.div("assets");
const BASE = SAMPLES.div("models", "folder", "folder.aep");
// An Adobe-CMS project (no working space), as AE's own imports were probed in.
const ADOBE_BASE = SAMPLES.div("models", "import", "windows_stills.aep");
const _ICC_AVAILABLE = defaultIccDirectories().some((d) => d.isDir());

// NOTE(port): shutil.copy(src, dest) copies file bytes and permission bits; copyFileSync does the same for these file-to-file calls
function shutilCopy(src: Path, dest: Path): Path {
  copyFileSync(fspath(src), fspath(dest));
  return dest;
}

function _project(base: Path = BASE): Project {
  return parseAep(base, { platform: "windows" }).project;
}

type ImportOptionValues = Partial<
  Pick<ImportOptions, "importAs" | "sequence" | "forceAlphabetical" | "layerIndex" | "layerDimensions" | "layerStyles" | "rangeStart" | "rangeEnd">
>;

function _import(project: Project, path: Path, options: ImportOptionValues = {}): FootageItem | CompItem {
  const opts = new ImportOptions(path);
  // setattr(opts, key, value) for each option: Object.assign runs the setters.
  Object.assign(opts, options);
  // NOTE(port): warnings.simplefilter("ignore") only silences output; tests/setup.ts already silences warnings, so import_file behaves the same
  return project.importFile(opts);
}

// The FileSource behind an imported footage item.
function _fileSource(item: AVItem): FileSource {
  return asInstance(asInstance(item, FootageItem).mainSource, FileSource);
}

function _layerFootage(project: Project, fileName: string): FootageItem[] {
  return project.footages.filter(
    (item) =>
      item.mainSource instanceof FileSource &&
      nodepath.win32.basename(fspath(item.mainSource.file)) === fileName &&
      truthy(item.mainSource.layerName),
  );
}

function _pinBytes(source: FileSource): Map<string, Uint8Array> {
  // Every Pin chunk but the random `pgui` id.
  const out = new Map<string, Uint8Array>();
  for (const [index, c] of source._pin.chunks.entries()) {
    if (c.chunkType !== "pgui") {
      out.set(`${index}:${truthyOr(getMember(c, "listType", null), c.chunkType)}`, c.tobytes());
    }
  }
  return out;
}

// --- synthetic files -----------------------------------------------------

/** One PSD layer record and its channel data. */
function _psdRecord(
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
  const rawName = encode(name, "latin-1", "replace").slice(0, 255);
  let pascal = concat(Uint8Array.of(len(rawName)), rawName);
  pascal = concat(pascal, Bytes.repeat(b("\0"), mod(-len(pascal), 4)));
  let unicodeName = concat(struct.pack(">I", len(Array.from(name))), encode(name, "utf-16-be"));
  unicodeName = concat(unicodeName, Bytes.repeat(b("\0"), mod(-len(unicodeName), 4)));
  let extra = concat(struct.pack(">II", 0, 0), pascal);
  extra = concat(extra, b("8BIMluni"), struct.pack(">I", len(unicodeName)), unicodeName);
  if (lyid != null) extra = concat(extra, b("8BIMlyid"), struct.pack(">II", 4, lyid));
  // 3 = group bounding divider, 1 = open group header
  if (lsct != null) extra = concat(extra, b("8BIMlsct"), struct.pack(">II", 4, lsct));
  record = concat(record, struct.pack(">I", len(extra)), extra);
  const data = Bytes.join(channels.map(() => concat(struct.pack(">H", 0), Bytes.repeat(Uint8Array.of(200), size))));
  return [record, data];
}

/** An 8-bit RGB PSD with raw-coded layer records. */
function _psd(path: Path, size: number, records: [Uint8Array, Uint8Array][]): Path {
  let layerInfo = struct.pack(">h", -len(records));
  layerInfo = concat(
    layerInfo,
    Bytes.join(records.map(([r]) => r)),
    Bytes.join(records.map(([, d]) => d)),
  );
  layerInfo = concat(layerInfo, Bytes.repeat(b("\0"), mod(len(layerInfo), 2)));
  const section = concat(struct.pack(">I", len(layerInfo)), layerInfo, struct.pack(">I", 0));
  const header = concat(
    b("8BPS"),
    struct.pack(">H", 1),
    Bytes.repeat(b("\0"), 6),
    struct.pack(">HIIHH", 3, size, size, 8, 3),
  );
  let body = concat(struct.pack(">II", 0, 0), struct.pack(">I", len(section)), section);
  body = concat(body, struct.pack(">H", 0), Bytes.repeat(Uint8Array.of(128), size * size * 3));
  path.writeBytes(concat(header, body));
  return path;
}

/** An uncompressed 8x8 little-endian TIFF (palette: a full colour map). */
function _tiff(path: Path, bits: number[], photometric: number, extra: number | null): Path {
  const width = 8;
  const height = 8;
  const row = floordiv(width * sum(bits) + 7, 8);
  const pixels = Bytes.repeat(Uint8Array.of(0x40), row * height);
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
  const bps = Bytes.join(bits.map((b_) => struct.pack("<H", b_)));
  if (len(bps) <= 4) {
    tags.push([258, 3, len(bits), Bytes.padEnd(bps, 4, 0)]);
  } else {
    tags.push([258, 3, len(bits), struct.pack("<I", len(out))]);
    out = concat(out, bps);
  }
  if (extra != null) tags.push([338, 3, 1, struct.pack("<HH", extra, 0)]);
  if (photometric === 3) {
    const entries = 1 << bits[0];
    const colorMap = Bytes.join(
      Array.from(range(entries), (i) => struct.pack("<H", floordiv(i * 65535, entries - 1))),
    );
    tags.push([320, 3, 3 * entries, struct.pack("<I", len(out))]);
    out = concat(out, Bytes.repeat(colorMap, 3));
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
  path.writeBytes(out);
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
  const raw = Bytes.join(
    Array.from(range(height), () => concat(b("\x00"), Bytes.repeat(b("\x00"), width))),
  );

  const chunk = (kind: Uint8Array, data: Uint8Array): Uint8Array => {
    const crc = crc32(concat(kind, data));
    return concat(struct.pack(">I", len(data)), kind, data, struct.pack(">I", crc));
  };

  const header = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0);
  // NOTE(port): both are zlib deflate at level 9; the tests only read the decoded pixels, never the compressed bytes
  path.writeBytes(
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
  const tmpPath = makeTmpPath();
  const path = tmpPath.div("bad.ai");
  path.writeBytes(data);
  const item = _import(_project(), path);
  expect(_fileSource(item)._opti.textDocumentLayers).toBe(0);
});

// --- C1 / C12: reload --------------------------------------------------

test.each([
  ["layer_bounds.psd", { importAs: ImportAsType.COMP_CROPPED_LAYERS }],
  ["layer_bounds.psd", { importAs: ImportAsType.COMP }],
  ["psd_layer_styles.psd", { layerIndex: 0, layerStyles: "ignore" }],
  ["layer_bounds.psd", { layerIndex: 0, layerDimensions: "layer" }],
  ["ai.ai", { importAs: ImportAsType.COMP }],
  ["ai.ai", { layerIndex: 0, layerDimensions: "layer" }],
])("test_reload_keeps_the_layer_binding[%#]", (asset: string, options: ImportOptionValues) => {
  const tmpPath = makeTmpPath();
  // AE 2026 reloads a layer-bound source as that same layer (a cropped
  // layer stays 10x12, the name stays "<layer>/<file>"); py_aep used to
  // rebuild it as the merged document.
  const project = _project();
  _import(project, ASSETS.div(asset), options);
  const items = _layerFootage(project, asset);
  expect(truthy(items)).toBe(true);
  const before = new Map(
    items.map((item) => [item.id, [item.name, _pinBytes(_fileSource(item))]] as const),
  );
  for (const item of items) {
    _fileSource(item).reload();
  }
  for (const item of items) {
    const [name, pin] = getOrThrow(before, item.id);
    expect(valueEquals(item.name, name)).toBe(true);
    expect(valueEquals(_pinBytes(_fileSource(item)), pin)).toBe(true);
  }
  const out = tmpPath.div("reloaded.aep");
  project.save(out);
  const reparsed = parseProjectFresh(out);
  for (const item of items) {
    expect(valueEquals(getOrThrow(reparsed.items, item.id).name, getOrThrow(before, item.id)[0])).toBe(true);
  }
});

test("test_reload_restamps_the_source_mtime", () => {
  const tmpPath = makeTmpPath();
  // AE 2026 writes the file's current mtime into the sspc stamp on reload.
  const path = tmpPath.div("frame.png");
  shutilCopy(ASSETS.div("image_with_alpha.png"), path);
  utimesSync(fspath(path), 1_600_000_000, 1_600_000_000);
  const item = _import(_project(), path);
  utimesSync(fspath(path), 1_700_000_000, 1_700_000_000);
  _fileSource(item).reload();
  expect(_fileSource(item)._sspc.sourceModified).toBe(1_700_000_000);
});

test("test_sequence_reload_keeps_the_unreduced_duration", () => {
  // A sequence's duration is frames over rate, unreduced (3/30), as the
  // import and every AE-authored sequence write it.
  const item = _import(_project(), ASSETS.div("dpx_seq.0001.dpx"), { sequence: true });
  const sspc = _fileSource(item)._sspc;
  const before = [sspc.durationDividend, sspc.durationDivisor];
  _fileSource(item).reload();
  expect(valueEquals([sspc.durationDividend, sspc.durationDivisor], before)).toBe(true);
  expect(valueEquals(before, [3, 30])).toBe(true);
});

// --- C4: conform rates AE cannot open ------------------------------------

test.each([["mov_23_976.mov"], ["dpx_seq.0001.dpx"]])("test_tiny_conform_rate_is_rejected_unmodified[%#]", (asset: string) => {
  // AE 2026 refused to open py's projects holding 0.0004 ("zero denominator
  // in ratio multiply") and opened 0.0005 on a movie and a sequence.
  const project = _project();
  const item = _import(project, ASSETS.div(asset), { sequence: asset.endsWith(".dpx") });
  const before = projectBytes(project);
  raises(ValueError, () => {
    _fileSource(item).conformFrameRate = 0.0004;
  }, "0.0005");
  expect(valueEquals(projectBytes(project), before)).toBe(true);
  _fileSource(item).conformFrameRate = 0.0005;
  expect(approx(_fileSource(item).conformFrameRate, 0.0005, { abs: 1e-5 })).toBe(true);
});

// --- C6: footage size ------------------------------------------------------

test("test_footage_wider_than_32767_px_is_rejected_unmodified", () => {
  const tmpPath = makeTmpPath();
  // AE reads the sspc size as signed 16-bit: 65535 px opened as -1, and
  // 65536 did not fit (save failed). Rejected before anything is added.
  const project = _project();
  const before = projectBytes(project);
  for (const path of [
    _png(tmpPath.div("wide.png"), 32768, 1),
    _psd(tmpPath.div("wide.psd"), 1, [_psdRecord("a", [0, 0, 1, 1])]),
  ]) {
    if (path.suffix === ".psd") {
      const data = Uint8Array.from(path.readBytes());
      // struct.pack_into(">I", data, 18, 40000) - canvas width
      data.set(struct.pack(">I", 40000), 18);
      path.writeBytes(data);
    }
    for (const how of [ImportAsType.FOOTAGE, ImportAsType.COMP]) {
      if (how === ImportAsType.COMP && path.suffix !== ".psd") continue;
      raises(ValueError, () => _import(project, path, { importAs: how }), "32767");
      expect(valueEquals(projectBytes(project), before)).toBe(true);
    }
  }
  expect(_import(project, _png(tmpPath.div("ok.png"), 32767, 1)).width).toBe(32767);
});

// --- C7 / C10 / C13: synthetic Photoshop documents ------------------------

test.each([[ImportAsType.COMP], [ImportAsType.COMP_CROPPED_LAYERS]])("test_hidden_photoshop_layer_imports_disabled[%#]", (how) => {
  const tmpPath = makeTmpPath();
  // AE 2026 turns the video switch off for a layer hidden in Photoshop
  // (synthetic hidden_layer.psd: frame 0 rendered without it).
  const path = _psd(tmpPath.div("hidden.psd"), 16, [
    _psdRecord("visible", [0, 0, 8, 8], { lyid: 2 }),
    _psdRecord("hidden", [4, 4, 12, 12], { hidden: true, lyid: 3 }),
  ]);
  const comp = asInstance(_import(_project(), path, { importAs: how }), CompItem);
  const enabled = new Map(comp.layers.map((layer) => [String(layer.name), layer.enabled] as const));
  expect(valueEquals(enabled, new Map([["hidden", false], ["visible", true]]))).toBe(true);
});

test.each([[ImportAsType.COMP], [ImportAsType.COMP_CROPPED_LAYERS]])("test_hidden_photoshop_group_imports_disabled[%#]", (how) => {
  const tmpPath = makeTmpPath();
  // AE 2026 turns the group's nested-comp layer off and leaves the
  // children's switches alone (synthetic hidden_group.psd).
  const path = _psd(tmpPath.div("hidden_group.psd"), 16, [
    _psdRecord("</Layer group>", [0, 0, 0, 0], { lsct: 3, lyid: 10 }),
    _psdRecord("in hidden group", [0, 0, 8, 8], { lyid: 11 }),
    _psdRecord("hidden group", [0, 0, 0, 0], { hidden: true, lsct: 1, lyid: 12 }),
    _psdRecord("top visible", [8, 8, 16, 16], { lyid: 13 }),
  ]);
  const comp = asInstance(_import(_project(), path, { importAs: how }), CompItem);
  const layers = new Map<string, Layer>(comp.layers.map((layer) => [String(layer.name), layer] as const));
  expect(getOrThrow(layers, "top visible").enabled).toBe(true);
  const group = getOrThrow(layers, "hidden group");
  expect(group.enabled).toBe(false);
  expect(
    valueEquals(
      asInstance(asInstance(group, AVLayer).source, CompItem).layers.map((inner) => inner.enabled),
      [true],
    ),
  ).toBe(true);
});

test("test_layer_ids_without_lyid_number_from_two", () => {
  const tmpPath = makeTmpPath();
  // AE 2026 numbers the layers of a PSD without `lyid` blocks from 2 in
  // record order (opti 0x154 and sspc layer_id).
  const path = _psd(tmpPath.div("no_ids.psd"), 16, [
    _psdRecord("a", [0, 0, 8, 8]),
    _psdRecord("b", [8, 8, 16, 16]),
  ]);
  const project = _project();
  _import(project, path, { importAs: ImportAsType.COMP });
  const ids = new Map(
    _layerFootage(project, path.name).map(
      (item) => [String(_fileSource(item).layerName), _fileSource(item)._sspc.layerId] as const,
    ),
  );
  expect(valueEquals(ids, new Map([["a", 2], ["b", 3]]))).toBe(true);
});

test("test_photoshop_layer_count_above_255", () => {
  const tmpPath = makeTmpPath();
  // The opti layer count is 16-bit: AE 2026 writes 300 (`2c 01`) for a
  // 300-layer document, merged and per layer.
  const path = _psd(
    tmpPath.div("many.psd"),
    40,
    Array.from(range(300), (i) =>
      _psdRecord(`L${format(i, "03d")}`, [mod(i, 40), mod(i, 39), mod(i, 40) + 1, mod(i, 39) + 1]),
    ),
  );
  const project = _project();
  const merged = _import(project, path);
  expect(_fileSource(merged)._opti.psdLayerCount).toBe(300);
  const layer = _import(project, path, { layerIndex: 0 });
  expect(_fileSource(layer)._opti.psdLayerCount).toBe(300);
});

test("test_long_photoshop_layer_name_is_cut_to_255_bytes", () => {
  const tmpPath = makeTmpPath();
  // AE 2026 keeps the longest UTF-8 prefix of 255 bytes for the comp layer.
  const name = "été 日本 " + "x".repeat(300);
  const path = _psd(tmpPath.div("long.psd"), 16, [_psdRecord(name, [0, 0, 8, 8], { lyid: 2 })]);
  const comp = asInstance(_import(_project(), path, { importAs: ImportAsType.COMP }), CompItem);
  const layerName = String(comp.layers[0].name);
  expect(len(encode(layerName, "utf-8"))).toBe(255);
  expect(name.startsWith(String(layerName))).toBe(true);
});

test("test_background_layer_is_named_background", () => {
  // AE 2026 names Photoshop's Background layer "Background" whatever the
  // file stores (a French Photoshop's "Arrière-plan"; footage_depth.aep).
  const asset = ASSETS.div("depth", "psd_rgb8_bg_layer.psd");
  expect(listLayers(asset).at(-1)).toBe("Background");
  const comp = asInstance(_import(_project(), asset, { importAs: ImportAsType.COMP }), CompItem);
  expect(valueEquals(comp.layers.map((layer) => String(layer.name)), ["Layer 1", "Background"])).toBe(true);
});

// --- C9: empty content box at Layer Size -------------------------------

test.each([
  ["grouped_layers.psd", "hue/sat adj", [80, 60]],
  ["psd_clipping_mask.psd", "Layer 1", [64, 64]],
])("test_empty_layer_at_layer_size_spans_the_canvas[%#]", (asset: string, layerName: string, size: number[]) => {
  // As in AE's cropped-comp import of the same layer (fixtures
  // grouped_layers_cropped / psd_clipping_mask_cropped); 0x0 before.
  const index = listLayers(ASSETS.div(asset)).indexOf(layerName);
  const item = _import(_project(), ASSETS.div(asset), { layerIndex: index, layerDimensions: "layer" });
  expect(valueEquals([item.width, item.height], size)).toBe(true);
  expect(_fileSource(item)._sspc.fullFrame).toBe(false);
});

test("test_replace_current_value_keeps_an_empty_cropped_layer", () => {
  const project = _project();
  _import(project, ASSETS.div("grouped_layers.psd"), {
    importAs: ImportAsType.COMP_CROPPED_LAYERS,
  });
  const item = project.footages.find((f) => String(f.name) === "hue/sat adj/grouped_layers.psd");
  assert(item != null, "StopIteration");
  item.replace(ASSETS.div("grouped_layers.psd"), CURRENT_VALUE);
  expect(valueEquals([item.width, item.height], [80, 60])).toBe(true);
});

// --- C8: image sequences -----------------------------------------------

function _frames(folder: Path, names: string[]): Path {
  folder.mkdir();
  for (const name of names) {
    shutilCopy(ASSETS.div("depth", "png_g8.png"), folder.div(name));
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
  const tmpPath = makeTmpPath();
  const folder = _frames(tmpPath.div("seq"), names);
  const project = _project();
  const item = _import(project, folder.div(names[pick]), { sequence: true });
  expect(valueEquals(item.name, expected)).toBe(true);
  const out = tmpPath.div("seq.aep");
  project.save(out);
  expect(valueEquals(getOrThrow(parseProjectFresh(out).items, item.id).name, expected)).toBe(true);
});

test("test_huge_frame_range_with_a_fractional_rate_saves", () => {
  const tmpPath = makeTmpPath();
  // frames x 100 / 2997 overflowed the u4 duration dividend at save.
  const project = _project();
  const item = _import(project, ASSETS.div("dpx_seq.0001.dpx"), {
    sequence: true,
    rangeStart: 1,
    rangeEnd: 2 ** 32 - 1,
  });
  _fileSource(item).conformFrameRate = 29.97;
  project.save(tmpPath.div("range.aep"));
  const expected = (2 ** 32 - 1) / 29.97;
  expect(approx(item.duration, expected, { rel: 1e-6 })).toBe(true);
});

test("test_replace_with_sequence_validates_force_alphabetical", () => {
  const item = asInstance(_import(_project(), ASSETS.div("image_with_alpha.png")), FootageItem);
  raises(TypeError, () =>
    // @ts-expect-error deliberately passes a number force_alphabetical to check runtime validation
    item.replaceWithSequence(ASSETS.div("dpx_seq.0001.dpx"), 1),
  );
});

test("test_invalid_default_sequence_fps_preference_is_rejected", () => {
  const tmpPath = makeTmpPath();
  const prefs = tmpPath.div("prefs");
  prefs.mkdir();
  prefs.div("Adobe After Effects 26.0 Prefs-indep-general.txt").writeText(
    '["Import Options Preference Section"]\n' +
      '\t"Import Options Default Sequence FPS" = "0.000000"\n',
  );
  const project = parseAep(BASE, { aePreferencesDir: prefs }).project;
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
    dataSize: number,
  ) => {
    const tmpPath = makeTmpPath();
    const item = _import(_project(), _tiff(tmpPath.div("t.tif"), bits, photometric, extra));
    const source = _fileSource(item);
    const opti = source._opti.tobytes();
    expect(source._sspc.depth).toBe(depth);
    expect(opti[0x1E]).toBe(channels);
    expect(Bytes.intFromBytes(opti.slice(0x28, 0x2A), "little")).toBe(8);
    expect(Bytes.intFromBytes(opti.slice(0x30, 0x32), "little")).toBe(layers);
    expect(source._sspc.dataSize).toBe(dataSize);
  },
);

// --- C3: colour profiles (Adobe CMS project) -----------------------------

function _clrs(source: FileSource): Map<string, Uint8Array | string | number> {
  const clrs = source._clrs;
  if (clrs == null) throw new AssertionError("source has no LIST:CLRS");
  const chunks = clrs.chunks;
  const out = new Map<string, Uint8Array | string | number>();
  for (const [index, chunk] of chunks.entries()) {
    if (["epid", "apid"].includes(chunk.chunkType)) {
      out.set(chunk.chunkType, chunk.data);
    } else if (chunk.chunkType === "empd") {
      out.set("empd", asInstance(at(chunks, index + 1), Utf8Chunk).value);
    } else if (chunk.chunkType === "ipws") {
      out.set("ipws", asInstance(chunk, IpwsChunk).value);
    } else if (["mcsp", "ocsp"].includes(chunk.chunkType)) {
      out.set(chunk.chunkType, asInstance(at(chunks, index + 1), Utf8Chunk).value);
    }
  }
  return out;
}

const _UNSET = Bytes.repeat(b("\xff"), 16);

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
  const clrs = _clrs(_fileSource(_import(_project(ADOBE_BASE), ASSETS.div(asset))));
  expect(valueEquals(getOrThrow(clrs, "empd"), name)).toBe(true);
  expect(getOrThrow(clrs, "ipws")).toBe(1);
  expect(valueEquals(getOrThrow(clrs, "epid"), getOrThrow(clrs, "apid"))).toBe(true);
  expect(valueEquals(getOrThrow(clrs, "apid"), _UNSET)).toBe(true);
  expect(!truthy(getOr(clrs, "mcsp")) && !truthy(getOr(clrs, "ocsp"))).toBe(true);
});

test("test_dpx_and_cineon_carry_no_profile", () => {
  for (const asset of ["dpx_10bit_be.dpx", "cin.cin"]) {
    const clrs = _clrs(_fileSource(_import(_project(ADOBE_BASE), ASSETS.div(asset))));
    expect(valueEquals(getOrThrow(clrs, "epid"), getOrThrow(clrs, "apid"))).toBe(true);
    expect(valueEquals(getOrThrow(clrs, "apid"), _UNSET)).toBe(true);
    expect(clrs.has("empd")).toBe(false);
    expect(getOrThrow(clrs, "ipws")).toBe(1);
    expect(!truthy(getOr(clrs, "ocsp"))).toBe(true);
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
  const clrs = _clrs(_fileSource(_import(_project(ADOBE_BASE), ASSETS.div(asset))));
  const other = slot === "epid" ? "apid" : "epid";
  expect(valueEquals(getOrThrow(clrs, slot), iccProfileId(defaultIccLibrary().bytesFor(profile)))).toBe(true);
  expect(valueEquals(getOrThrow(clrs, other), _UNSET)).toBe(true);
  expect(clrs.has("empd")).toBe(false);
  expect(getOrThrow(clrs, "ipws")).toBe(0);
});

test.each([
  [ADOBE_BASE, "windows", "heic_alpha.heic"],
  [SAMPLES.div("models/format_options/heic/base.aep"), "macos", "heic.heic"],
  [SAMPLES.div("models/format_options/heic/base.aep"), "macos", "heic_alpha.heic"],
])("test_heic_imports_with_linear_light_off[%#]", (fixture: Path, platform: string, asset: string) => {
  // AE 2026 imports HEIC with Interpret As Linear Light off on both
  // platforms (these fixtures, and a scripted import on Windows).
  const truth = new Map(
    parseAep(fixture).project.footages.map((f) => [String(f.name), asInstance(f.mainSource, FileSource)] as const),
  );
  const project = parseAep(fixture, { platform }).project;
  const ours = _fileSource(_import(project, ASSETS.div(asset)));
  const oursLinl = ours._linl;
  const truthLinl = getOrThrow(truth, asset)._linl;
  assert(oursLinl != null && truthLinl != null, "missing linl");
  expect(oursLinl.value).toBe(truthLinl.value);
  expect(truthLinl.value).toBe(0);
});

const _MAC_EPOCH = 2082844800;

function _stamp(item: AVItem): Uint8Array {
  const idta = item._idta;
  assert(idta != null, "item has no idta");
  return idta.tobytes().slice(0x50, 0x54); // `item._idta.tobytes()[0x50:0x54]`
}

function _mac(unixTime: number): Uint8Array {
  return Bytes.intToBytes(unixTime + _MAC_EPOCH, 4, "big");
}

function _stampedCopy(src: Path, dest: Path, mtime: number): Path {
  shutilCopy(src, dest);
  utimesSync(fspath(dest), mtime, mtime);
  return dest;
}

test("test_idta_stamp_follows_the_file_in_use", () => {
  const tmpPath = makeTmpPath();
  // AE 2026 stamps a footage item's idta (0x50, big-endian Mac-epoch
  // seconds) with the mtime of the file in use: the main file on import,
  // replace and reload, the proxy's while a file proxy is in use, and the
  // main file's again after useProxy = false or setProxyToNone.
  const png = ASSETS.div("image_with_alpha.png");
  const main = _stampedCopy(png, tmpPath.div("main.png"), 1_610_000_000);
  const proxy = _stampedCopy(ASSETS.div("bmp.bmp"), tmpPath.div("proxy.bmp"), 1_610_002_000);
  const other = _stampedCopy(png, tmpPath.div("other.png"), 1_610_003_000);
  const project = _project();
  const item = asInstance(_import(project, main), FootageItem);
  expect(valueEquals(_stamp(item), _mac(1_610_000_000))).toBe(true);
  item.setProxy(proxy);
  expect(valueEquals(_stamp(item), _mac(1_610_002_000))).toBe(true);
  item.useProxy = false;
  expect(valueEquals(_stamp(item), _mac(1_610_000_000))).toBe(true);
  item.useProxy = true;
  expect(valueEquals(_stamp(item), _mac(1_610_002_000))).toBe(true);
  item.setProxyToNone();
  expect(valueEquals(_stamp(item), _mac(1_610_000_000))).toBe(true);
  item.replace(other);
  expect(valueEquals(_stamp(item), _mac(1_610_003_000))).toBe(true);
  utimesSync(fspath(other), 1_700_000_000, 1_700_000_000);
  _fileSource(item).reload();
  expect(valueEquals(_stamp(item), _mac(1_700_000_000))).toBe(true);
  const out = tmpPath.div("out.aep");
  project.save(out);
  expect(
    valueEquals(_stamp(asInstance(getOrThrow(parseProjectFresh(out).items, item.id), AVItem)), _mac(1_700_000_000)),
  ).toBe(true);
});

test("test_idta_stamp_of_sequences_placeholders_and_comps", () => {
  const tmpPath = makeTmpPath();
  // AE 2026 stamps a sequence with its folder's mtime, leaves the stamp
  // alone when a placeholder becomes the proxy or the main source, and
  // keeps a comp's own (edit-time) stamp when it gets a file proxy
  // (sample proxy.aep).
  const folder = tmpPath.div("seq");
  folder.mkdir();
  for (const frame of ["s_001.png", "s_002.png"]) {
    _stampedCopy(ASSETS.div("image_with_alpha.png"), folder.div(frame), 1_610_000_000);
  }
  utimesSync(fspath(folder), 1_610_006_000, 1_610_006_000);
  const project = _project();
  const item = asInstance(_import(project, folder.div("s_001.png"), { sequence: true }), FootageItem);
  expect(valueEquals(_stamp(item), _mac(1_610_006_000))).toBe(true);
  item.setProxyWithPlaceholder("PP", 10, 10, 25.0, 1.0);
  item.replaceWithPlaceholder("RP", 10, 10, 25.0, 1.0);
  expect(valueEquals(_stamp(item), _mac(1_610_006_000))).toBe(true);
  const comp = project.rootFolder.addComp("C", 100, 100, 1.0, 1.0, 25.0);
  const before = _stamp(comp);
  comp.setProxy(folder.div("s_001.png"));
  expect(valueEquals(_stamp(comp), before)).toBe(true);
});
