/**
 * Regression tests for the v9 fuzz findings on media probing and the layered
 * file readers (area C): malformed input raises only the documented
 * exceptions, never allocates from a corrupt size field, and never hangs.
 */

import { expect, test } from "bun:test";
import { CosParser } from "../../src/py_aep/cos/index.ts";
import { Stream, TokenType } from "../../src/py_aep/cos/cos.ts";
import { UnsupportedAiLayersError, readAiLayers } from "../../src/py_aep/resolvers/ai_layers.ts";
import { probeMedia } from "../../src/py_aep/resolvers/media_probe.ts";
import { UnsupportedPsdLayersError, readPsdLayers } from "../../src/py_aep/resolvers/psd_layers.ts";
import { ByteStream, Path, ValueError, b, Bytes, concat, getOrThrow, assert, valueEquals, struct } from "../../src/pyrt/index.ts";

import { asInstance } from "../helpers.ts";
import { makeTmpPath, raises } from "../support/pytest.ts";
import { sorted } from "../support/python.ts";

// Python: Path(__file__).parent.parent.parent / "samples" / "assets" (file is in tests/unit).
const ASSETS = new Path(import.meta.dir).parent.parent.div("samples").div("assets");

const _PSD_HEADER = concat(
  b("8BPS"),
  struct.pack(">H", 1),
  Bytes.repeat(b("\x00"), 6),
  struct.pack(">HIIHH", 3, 8, 8, 8, 3),
);

/**
 * Run `fn` and return `[exception or result, peak bytes]`.
 *
 * TODO(port): Python runs `fn` in a daemon thread and fails the test if it does
 * not finish in `timeout` seconds. JS is single-threaded: a synchronous hang
 * cannot be interrupted, so the timeout is not enforced here.
 * TODO(port): Python measures the tracemalloc peak inside the thread. No
 * equivalent exists in JS; this reports the growth of `arrayBuffers` memory
 * across the call, which approximates allocation but is not the peak.
 */
function _run(fn: () => unknown, timeout = 20.0): [unknown, number] {
  const before = process.memoryUsage().arrayBuffers;
  let value: unknown;
  try {
    value = fn();
  } catch (exc) {
    // Python: `except BaseException as exc` - classified by the caller.
    value = exc;
  }
  const peak = Math.max(0, process.memoryUsage().arrayBuffers - before);
  return [value, peak];
}

// Malformed files a few bytes long; each used to raise a raw struct.error or
// IndexError from inside a parser (v9 fuzz, area C).
const _TRUNCATED: Map<string, Uint8Array> = new Map<string, Uint8Array>([
  ["psd_header_only.psd", _PSD_HEADER],
  ["png_trunc.png", ASSETS.div("image_with_alpha.png").readBytes().slice(0, 24)],
  ["tif_ifd_past_eof.tif", concat(b("II*\x00"), struct.pack("<I", 1000))],
  ["bmp_short.bmp", concat(b("BM"), Bytes.repeat(b("\x00"), 10))],
  ["gif_short.gif", b("GIF89a\x01")],
  ["jpg_short.jpg", b("\xff\xd8\xff\xc0")],
  ["crw_short.crw", ASSETS.div("crw.crw").readBytes().slice(0, 16)],
  ["aif_short.aif", ASSETS.div("aif.aif").readBytes().slice(0, 26)],
  ["tga_short.tga", b("\x00\x00\x02")],
  ["exr_magic_only.exr", ASSETS.div("exr").div("rgb_full.exr").readBytes().slice(0, 4)],
]);

test.each(sorted(Array.from(_TRUNCATED.keys())).map((n) => [n]))("test_truncated_media_raises_value_error[%#]", (name: string) => {
  const tmpPath = makeTmpPath();
  const path = tmpPath.div(name);
  path.writeBytes(getOrThrow(_TRUNCATED, name));
  for (const data of [null, getOrThrow(_TRUNCATED, name)]) {
    raises(ValueError, () => probeMedia(path, data));
  }
});

test("test_corrupt_exr_attribute_size_does_not_allocate", () => {
  const tmpPath = makeTmpPath();
  // An attribute declaring 0xFFFFFFF0 bytes in a 36-byte file used to make
  // read(size) allocate 4 GB before reading.
  const exr = ASSETS.div("exr").div("rgb_full.exr").readBytes().slice(0, 8);
  const path = tmpPath.div("huge_attr.exr");
  path.writeBytes(concat(exr, b("channels\x00chlist\x00"), struct.pack("<I", 0xFFFFFFF0)));
  const [, peak] = _run(() => probeMedia(path));
  expect(peak).toBeLessThan(50_000_000);
});

test("test_corrupt_psd_resource_length_does_not_allocate", () => {
  const tmpPath = makeTmpPath();
  const path = tmpPath.div("huge_resources.psd");
  path.writeBytes(concat(_PSD_HEADER, struct.pack(">II", 0, 0xFFFFFFF0), b("8BIM")));
  const [, peak] = _run(() => probeMedia(path));
  expect(peak).toBeLessThan(50_000_000);
});

test("test_psd_header_fields_are_validated", () => {
  const tmpPath = makeTmpPath();
  // A bit depth outside 1/8/16/32 used to import and then fail at save
  // (it did not fit the opti byte recording it).
  const header = new Uint8Array(_PSD_HEADER);
  // Python: struct.pack_into(">H", header, 22, 300) - pyrt struct has no pack_into,
  // so the packed bytes are written at offset 22 directly.
  header.set(struct.pack(">H", 300), 22);
  const path = tmpPath.div("bad_depth.psd");
  path.writeBytes(concat(header, struct.pack(">III", 0, 0, 0)));
  raises(ValueError, () => probeMedia(path), "Not a valid PSD/PSB file");
});

test("test_tiff_bits_per_sample_is_validated", () => {
  const tmpPath = makeTmpPath();
  const entries: [number, number, number, number][] = [
    [256, 3, 1, 8],
    [257, 3, 1, 8],
    [258, 3, 1, 9000],
    [262, 3, 1, 1],
  ];
  let ifd = struct.pack("<H", entries.length);
  for (const [tag, typ, count, value] of entries) {
    ifd = concat(ifd, struct.pack("<HHIHH", tag, typ, count, value, 0));
  }
  const path = tmpPath.div("bad_bits.tif");
  path.writeBytes(concat(b("II*\x00"), struct.pack("<I", 8), ifd, b("\x00\x00\x00\x00")));
  raises(ValueError, () => probeMedia(path), "bits per sample");
});

test("test_read_psd_layers_truncated_records_raise_documented_error", () => {
  const tmpPath = makeTmpPath();
  // Cut inside the layer records: an IndexError escaped before.
  const path = tmpPath.div("cut.psd");
  path.writeBytes(ASSETS.div("choose_layer.psd").readBytes().slice(0, 200));
  const [result] = _run(() => readPsdLayers(path));
  expect(result).toBeInstanceOf(UnsupportedPsdLayersError);
});

test("test_read_psd_layers_huge_canvas_is_rejected", () => {
  const tmpPath = makeTmpPath();
  const header = new Uint8Array(ASSETS.div("layer_bounds.psd").readBytes());
  // Python: struct.pack_into(">II", header, 14, ...) - written via set() at offset 14.
  header.set(struct.pack(">II", 0xFFFFFFF0, 0xFFFFFFF0), 14);
  const path = tmpPath.div("huge_canvas.psd");
  path.writeBytes(header);
  const [result, peak] = _run(() => readPsdLayers(path));
  expect(result).toBeInstanceOf(UnsupportedPsdLayersError);
  expect(peak).toBeLessThan(50_000_000);
});

test("test_cos_lexer_stops_at_end_of_data", () => {
  // `read(1)` returns b"" at the end of the data; the lexer treated it as
  // a character and looped forever on a truncated name.
  const parser = new CosParser(new ByteStream(b("<</Order 8 0 R/")));
  const [result] = _run(() => [parser.lex(), parser.parseValue()]);
  expect(Array.isArray(result) || result instanceof SyntaxError).toBe(true);
});

test.each([[null], [10_000_100]])("test_cos_stream_is_read_in_blocks[%#]", (maxPos: number | null) => {
  // A 0.5 MB embedded ICC profile took seconds to lex byte by byte, which
  // the import's colour-profile lookup now does for every .ai/.pdf.
  const body = concat(Bytes.repeat(b("x"), 3_000_000), b("endstrea"), Bytes.repeat(b("y"), 1000));
  const data = concat(b("<</Length 1>>stream\n"), body, b("endstream\nendobj 7"));
  const parser = new CosParser(new ByteStream(data), maxPos);
  const [result] = _run(() => [parser.lex(), parser.parseValue()], 5.0);
  expect(result instanceof Error).toBe(false);
  assert(Array.isArray(result));
  const stream = asInstance(result[1], Stream);
  expect(valueEquals(stream.data, body)).toBe(true);
  expect(TokenType.nameOf(parser.lookahead.type)).toBe("IndirectObjectEnd");
});

test.each([
  [b("%PDF-1.5\n1 0 obj\n<</OCProperties<</D<</Order 8 0 R/")],
  [b('%PDF-1.5\n1 0 obj\n<</OCProperties<</D "x>>>>\n')],
])("test_malformed_ai_layers_raise_documented_error[%#]", (data: Uint8Array) => {
  const tmpPath = makeTmpPath();
  const path = tmpPath.div("bad.ai");
  path.writeBytes(data);
  const [result] = _run(() => readAiLayers(path));
  expect(result).toBeInstanceOf(UnsupportedAiLayersError);
});

test("test_luminance_only_exr_reads_as_float_gray", () => {
  // AE 2026 caches depth -32 for a Y-only EXR (exr/y.exr); Y + A stays
  // RGBA float.
  expect(probeMedia(ASSETS.div("exr").div("y.exr")).depth).toBe(-32);
  expect(probeMedia(ASSETS.div("exr").div("ya.exr")).depth).toBe(128);
  expect(probeMedia(ASSETS.div("exr").div("r_only.exr")).depth).toBe(96);
});
