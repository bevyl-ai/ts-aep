/** Tests for binary I/O foundation. */

import { describe, expect, test } from "bun:test";

import { approx, makeTmpPath, raises, skip } from "../../src/pyrt/pytest.ts";
import {
  AssertionError,
  BytesIO,
  OSError,
  Path,
  b,
  bytes_,
  define,
  descriptor,
  getOr,
  encode,
  field,
  getOrThrow,
  assert,
  truthy,
  valueEquals,
  repr,
  struct,
} from "../../src/pyrt/index.ts";
import { isReadable, readBytes, readFmt, readPad, writeBytes, writeFmt, writePad } from "../../src/py_aep/binary/bin_utils.ts";
import { _CONTEXT_RESOLVERS, Chunk, ContainerChunk, ListChunk, ReadContext, _resolveCdatContext, _resolveLdatContext, _resolveTdumContext, readAep, readChunks, readHeader, writeAep, writeChunk } from "../../src/py_aep/binary/chunk.ts";
import { CHUNK_TYPES, register } from "../../src/py_aep/binary/registry.ts";
import { _structInfo, asciiField, bytesField, u1Field, u2Field, u4Field } from "../../src/py_aep/binary/fmt_field.ts";
import { U4Chunk } from "../../src/py_aep/binary/scalar_chunks.ts";
import { AnglePardChunk, BooleanPardChunk, ColorPardChunk, EnumPardChunk, FeatherPointItem, FipsChunk, Fth5Chunk, GenericPardChunk, IntegerPardChunk, NmhdChunk, PardChunk, PrinChunk, ScalarPardChunk, SliderPardChunk, ThreeDPardChunk, TwoDPardChunk } from "../../src/py_aep/binary/misc_chunks.ts";
import { LdtaChunk } from "../../src/py_aep/binary/layer_chunks.ts";
import { BitField } from "../../src/py_aep/binary/bitfield.ts";
import { CdatChunk, Tdb4Chunk, TdsbChunk, TdumChunk } from "../../src/py_aep/binary/property_chunks.ts";
import { CineonRoptChunk, JpegRoptChunk, OpenExrRoptChunk, PngRoptChunk, RoptChunk, RouuChunk, RoutChunk, RoutItem, TargaRoptChunk } from "../../src/py_aep/binary/render_chunks.ts";
import { OptiChunk, PlaceholderOptiChunk, PsdOptiChunk, SoliOptiChunk, SspcChunk, TextOptiChunk, buildAiLayerOptiData } from "../../src/py_aep/binary/footage_chunks.ts";
import { GuideItem, KfColor, KfMultiDimensional, KfNoValue, KfPosition, LdatChunk, LdatItem, LdatItemType, Lhd3Chunk, ShapePoint } from "../../src/py_aep/binary/ldat_chunks.ts";
import { ChunkNotFoundError, findByType } from "../../src/py_aep/binary/utils.ts";
import { asInstance } from "../helpers.ts";
import { _unflagMarkers, removeChunksByType, toggleFlagChunk } from "../../src/py_aep/binary/mutations.ts";

// Pull in every chunk registration (Python's `register` side effects).
import "../../src/py_aep/binary/_register.ts";

const SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples");

// -----------------------------------------------------------------------
// Group 1: bin_utils unit tests
// -----------------------------------------------------------------------

describe("TestBinUtils", () => {
  test("test_read_write_fmt_roundtrip", () => {
    const buf = new BytesIO();
    writeFmt(buf, "I H B", 42, 7, 3);
    buf.seek(0);
    const result = readFmt("I H B", buf);
    expect(valueEquals(result, [42, 7, 3])).toBe(true);
  });

  test("test_read_fmt_short_read", () => {
    const buf = new BytesIO(b("\x00\x00"));
    raises(OSError, () => readFmt("I", buf), "Short read");
  });

  test("test_write_fmt_returns_size", () => {
    const buf = new BytesIO();
    const n = writeFmt(buf, "I", 1);
    expect(n).toBe(4);
  });

  test("test_write_bytes_returns_size", () => {
    const buf = new BytesIO();
    const n = writeBytes(buf, b("hello"));
    expect(n).toBe(5);
  });

  test("test_read_bytes_exact", () => {
    const buf = new BytesIO(b("hello world"));
    expect(valueEquals(readBytes(buf, 5), b("hello"))).toBe(true);
  });

  test("test_read_bytes_short_read", () => {
    const buf = new BytesIO(b("\x00"));
    raises(OSError, () => readBytes(buf, 10), "Short read");
  });

  test("test_is_readable_true", () => {
    const buf = new BytesIO(b("\x00\x00\x00\x00"));
    expect(isReadable(buf, 4)).toBe(true);
  });

  test("test_is_readable_false", () => {
    const buf = new BytesIO(b("\x00"));
    expect(isReadable(buf, 4)).toBe(false);
  });

  test("test_is_readable_rewinds", () => {
    const buf = new BytesIO(b("\x00\x00\x00\x00"));
    const pos = buf.tell();
    isReadable(buf, 2);
    expect(buf.tell()).toBe(pos);
  });

  test("test_write_pad_odd", () => {
    const buf = new BytesIO();
    const n = writePad(buf, 5);
    expect(n).toBe(1);
    expect(valueEquals(buf.getvalue(), b("\x00"))).toBe(true);
  });

  test("test_write_pad_even", () => {
    const buf = new BytesIO();
    const n = writePad(buf, 4);
    expect(n).toBe(0);
    expect(valueEquals(buf.getvalue(), b(""))).toBe(true);
  });

  test("test_read_pad_odd", () => {
    const buf = new BytesIO(b("\x00extra"));
    readPad(buf, 5);
    expect(buf.tell()).toBe(1);
  });

  test("test_read_pad_even", () => {
    const buf = new BytesIO(b("\x00extra"));
    readPad(buf, 4);
    expect(buf.tell()).toBe(0);
  });

  test("test_endian_parameter", () => {
    const bufBe = new BytesIO();
    writeFmt(bufBe, "H", 0x0102);
    const bufLe = new BytesIO();
    // NOTE(port): write_fmt(buf_le, "H", 0x0102, endian="<") is struct.pack("<H", ...) (bin_utils.write_fmt body), so the bytes match Python.
    bufLe.write(struct.pack("<H", 0x0102));
    expect(valueEquals(bufBe.getvalue(), bufLe.getvalue())).toBe(false);
    expect(valueEquals(bufBe.getvalue(), b("\x01\x02"))).toBe(true);
    expect(valueEquals(bufLe.getvalue(), b("\x02\x01"))).toBe(true);
  });
});

// -----------------------------------------------------------------------
// Group 2: Chunk tests
// -----------------------------------------------------------------------

describe("TestChunk", () => {
  test("test_read_write_roundtrip", () => {
    const original = b("\x01\x02\x03\x04\x05");
    const buf = new BytesIO(original);
    const chunk = Chunk.read(buf, original.length, { chunkType: "test" });
    const out = new BytesIO();
    chunk.write(out);
    expect(valueEquals(out.getvalue(), original)).toBe(true);
  });

  test("test_chunk_type_preserved", () => {
    const chunk = new Chunk({ chunkType: "abcd", data: b("\xff") });
    expect(chunk.chunkType).toBe("abcd");
    const restored = Chunk.frombytes(chunk.tobytes(), { chunkType: "abcd" });
    expect(restored.chunkType).toBe("abcd");
    expect(valueEquals(restored.data, b("\xff"))).toBe(true);
  });

  test("test_empty_body", () => {
    const chunk = new Chunk({ chunkType: "empt" });
    expect(valueEquals(chunk.tobytes(), b(""))).toBe(true);
    const out = new BytesIO();
    expect(chunk.write(out)).toBe(0);
  });
});

// -----------------------------------------------------------------------
// Group 3: ListChunk tests
// -----------------------------------------------------------------------

describe("TestListChunk", () => {
  test("test_list_read_write_roundtrip", () => {
    // Build a LIST with two Chunk children
    const child1 = new Chunk({ chunkType: "ch1\x00", data: b("\x01\x02") });
    const child2 = new Chunk({ chunkType: "ch2\x00", data: b("\x03") });
    const lst = new ListChunk({ listType: "test", chunks: [child1, child2] });

    const buf = new BytesIO();
    writeChunk(buf, lst);
    const raw = buf.getvalue();

    const buf2 = new BytesIO(raw);
    const [ct, lb] = readHeader(buf2);
    expect(ct).toBe("LIST");
    const ctx = new ReadContext();
    const restored = ListChunk.read(buf2, lb, { ctx });
    expect(restored.listType).toBe("test");
    expect(restored.chunks.length).toBe(2);
    expect(restored.chunks[0] instanceof Chunk).toBe(true);
    expect(valueEquals(restored.chunks[0].data, b("\x01\x02"))).toBe(true);
    // ch2 has odd body (1 byte), pad byte was written/read
    expect(valueEquals(restored.chunks[1].data, b("\x03"))).toBe(true);
  });

  test("test_list_nested", () => {
    const inner = new ListChunk({
      listType: "innr",
      chunks: [new Chunk({ chunkType: "leaf", data: b("\xaa\xbb") })],
    });
    const outer = new ListChunk({ listType: "outr", chunks: [inner] });

    const buf = new BytesIO();
    writeChunk(buf, outer);

    buf.seek(0);
    const [ct, lb] = readHeader(buf);
    const ctx = new ReadContext();
    const restored = ListChunk.read(buf, lb, { ctx });
    expect(restored.listType).toBe("outr");
    expect(restored.chunks.length).toBe(1);
    const innerR = asInstance(restored.chunks[0], ListChunk);
    expect(innerR instanceof ListChunk).toBe(true);
    expect(innerR.listType).toBe("innr");
    expect(innerR.chunks.length).toBe(1);
    expect(valueEquals(innerR.chunks[0].data, b("\xaa\xbb"))).toBe(true);
  });

  test("test_list_btdk_binary_data", () => {
    const rawData = b("\x00\x01\x02\x03\x04\x05\x06\x07");
    const lst = new ListChunk({ listType: "btdk", data: rawData });

    const buf = new BytesIO();
    writeChunk(buf, lst);

    buf.seek(0);
    const [ct, lb] = readHeader(buf);
    const ctx = new ReadContext();
    const restored = ListChunk.read(buf, lb, { ctx });
    expect(restored.listType).toBe("btdk");
    expect(valueEquals(restored.data, rawData)).toBe(true);
    expect(valueEquals(restored.chunks, [])).toBe(true);
  });

  test("test_list_empty_children", () => {
    const lst = new ListChunk({ listType: "empt" });

    const buf = new BytesIO();
    writeChunk(buf, lst);

    buf.seek(0);
    const [ct, lb] = readHeader(buf);
    const ctx = new ReadContext();
    const restored = ListChunk.read(buf, lb, { ctx });
    expect(restored.listType).toBe("empt");
    expect(valueEquals(restored.chunks, [])).toBe(true);
  });

  test("test_rifx_chunk_type", () => {
    const rifx = new ListChunk({ listType: "Egg!", chunkType: "RIFX" });
    expect(rifx.chunkType).toBe("RIFX");
  });
});

// -----------------------------------------------------------------------
// Group 4: Full AEP file round-trip
// -----------------------------------------------------------------------

const ROUNDTRIP_SAMPLES = [
  "versions/ae2018/complete.aep",
  "versions/ae2022/complete.aep",
  "versions/ae2023/complete.aep",
  "versions/ae2024/complete.aep",
  "versions/ae2025/complete.aep",
  "versions/ae2026/complete.aep",
  "models/property/effects.aep",
  "models/property/2_gaussian.aep",
  "models/property/keyframe_spatial.aep",
  "models/property/keyframe_spatial_bezier_3D.aep",
  "models/property/keyframe_1D.aep",
  "models/property/shape_basic.aep",
  "models/property/mask_add.aep",
  "models/essential_graphics/multiple_controllers.aep",
  "models/composition/bgColor_custom.aep",
  "models/composition/renderer_classic_3d.aep",
  "models/composition/renderer_advanced_3d.aep",
  "models/composition/renderer_cinema_4d.aep",
  "models/composition/renderer_ray_traced.aep",
  "models/composition/renderer_options_classic_3d.aep",
  "models/composition/renderer_options_cinema_4d.aep",
  "models/composition/renderer_options_advanced_3d.aep",
  "bugs/29.97_fps_time_scale_3.125.aep",
  "bugs/windows-1250_decoding_error.aep",
  "bugs/outputmodule_path.aep",
];

test.each(ROUNDTRIP_SAMPLES.map((s) => [s.replace(/\//g, "__"), s]))(
  "test_read_write_aep_roundtrip[%s]",
  (_id, sample) => {
    const tmpPath = makeTmpPath();
    const aepPath = SAMPLES_DIR.div(sample);
    if (!aepPath.exists()) return skip(`Sample not found: ${aepPath}`);
    const original = aepPath.readBytes();

    const fp = new BytesIO(original);
    const [rifx, xmp] = readAep(fp);

    const out = tmpPath.div("roundtrip.aep");
    const outFp = new BytesIO();
    writeAep(outFp, rifx, xmp);
    out.writeBytes(outFp.getvalue());

    expect(valueEquals(out.readBytes(), original)).toBe(true);
  },
);

// -----------------------------------------------------------------------
// Group 5: Header and write_chunk tests
// -----------------------------------------------------------------------

describe("TestHeaderAndWriteChunk", () => {
  test("test_write_chunk_backpatch", () => {
    const chunk = new Chunk({ chunkType: "test", data: b("\x01\x02\x03\x04") });
    const buf = new BytesIO();
    writeChunk(buf, chunk);
    buf.seek(0);
    const [ct, lb] = readHeader(buf);
    expect(ct).toBe("test");
    expect(lb).toBe(4);
  });

  test("test_write_chunk_pad_odd", () => {
    const chunk = new Chunk({ chunkType: "test", data: b("\x01\x02\x03") });
    const buf = new BytesIO();
    const total = writeChunk(buf, chunk);
    // 8 header + 3 body + 1 pad = 12
    expect(total).toBe(12);
    expect(buf.getvalue().length).toBe(12);
    // Last byte should be pad
    expect(valueEquals(bytes_.slice(buf.getvalue(), -1), b("\x00"))).toBe(true);
  });

  test("test_write_chunk_pad_even", () => {
    const chunk = new Chunk({ chunkType: "test", data: b("\x01\x02\x03\x04") });
    const buf = new BytesIO();
    const total = writeChunk(buf, chunk);
    // 8 header + 4 body + 0 pad = 12
    expect(total).toBe(12);
    expect(buf.getvalue().length).toBe(12);
  });

  test("test_read_header_values", () => {
    const buf = new BytesIO();
    writeFmt(buf, "4s I", b("abcd"), 42);
    buf.seek(0);
    const [ct, lb] = readHeader(buf);
    expect(ct).toBe("abcd");
    expect(lb).toBe(42);
  });

  test("test_read_chunks_exact_boundary", () => {
    // Build a buffer with two chunks that exactly fill the size
    const buf = new BytesIO();
    writeChunk(buf, new Chunk({ chunkType: "aaa\x00", data: b("\x01\x02") }));
    writeChunk(buf, new Chunk({ chunkType: "bbb\x00", data: b("\x03\x04") }));
    const totalSize = buf.tell();

    buf.seek(0);
    const ctx = new ReadContext();
    const chunks = readChunks(buf, totalSize, { ctx });
    expect(chunks.length).toBe(2);
  });

  test("test_read_chunks_drift_raises", () => {
    // Create a buffer where size doesn't match actual content
    const buf = new BytesIO();
    writeChunk(buf, new Chunk({ chunkType: "aaa\x00", data: b("\x01\x02") }));
    buf.seek(0);
    const ctx = new ReadContext();
    // Claim size is larger than actual content
    raises(OSError, () => readChunks(buf, 100, { ctx }), "Short read");
  });
});

// -----------------------------------------------------------------------
// Group 6: Registry tests
// -----------------------------------------------------------------------

describe("TestRegistry", () => {
  test("test_register_decorator", () => {
    // Save and restore registry state
    const saved = new Map(CHUNK_TYPES);
    try {
      class ZzzzChunk extends Chunk {}
      register("zzzz")(ZzzzChunk);

      expect(CHUNK_TYPES.has("zzzz")).toBe(true);
      expect(getOrThrow(CHUNK_TYPES, "zzzz")).toBe(ZzzzChunk);
    } finally {
      CHUNK_TYPES.clear();
      for (const [k, v] of saved) CHUNK_TYPES.set(k, v);
    }
  });

  test("test_unregistered_falls_to_chunk", () => {
    const cls = getOr(CHUNK_TYPES, "nonexistent", Chunk);
    expect(cls).toBe(Chunk);
  });

  test("test_registered_chunk_dispatched", () => {
    const saved = new Map(CHUNK_TYPES);
    try {
      class DispChunk extends Chunk {}
      register("disp")(DispChunk);

      const buf = new BytesIO();
      writeChunk(buf, new Chunk({ chunkType: "disp", data: b("\xaa") }));

      buf.seek(0);
      const [ct, lb] = readHeader(buf);
      const cls = getOr(CHUNK_TYPES, ct, Chunk);
      expect(cls).toBe(DispChunk);
    } finally {
      CHUNK_TYPES.clear();
      for (const [k, v] of saved) CHUNK_TYPES.set(k, v);
    }
  });
});

// -----------------------------------------------------------------------
// Group 7: Context resolver tests
// -----------------------------------------------------------------------

describe("TestContextResolvers", () => {
  /**
   * `read_chunks` passes a resolver's arguments to leaf chunks only: a
   * nesting chunk (LIST, container) takes the reading context.
   */
  test("test_resolvers_only_target_leaf_chunks", () => {
    for (const chunkType of _CONTEXT_RESOLVERS.keys()) {
      expect([chunkType, (CHUNK_TYPES.get(chunkType) ?? Chunk)._nests]).toEqual([chunkType, false]);
    }
  });

  test("test_nesting_flag_matches_the_container_classes", () => {
    for (const [chunkType, cls] of CHUNK_TYPES) {
      const nests = cls.prototype instanceof ListChunk || cls === ListChunk || cls.prototype instanceof ContainerChunk || cls === ContainerChunk;
      expect([chunkType, cls._nests]).toEqual([chunkType, nests]);
    }
  });

  test("test_cdat_context_otst", () => {
    const ctx = new ReadContext("tdbs", "otst");
    const result = _resolveCdatContext([], ctx);
    expect(result).toEqual({ isLe: true });
  });

  test("test_cdat_context_tdbs", () => {
    const ctx = new ReadContext("tdbs", "tdbs");
    const result = _resolveCdatContext([], ctx);
    expect(result).toEqual({ isLe: false });
  });

  test("test_ldat_context_empty_siblings", () => {
    const ctx = new ReadContext();
    const result = _resolveLdatContext([], ctx);
    expect(result).toEqual({});
  });

  test("test_tdum_context_phase1_empty", () => {
    const ctx = new ReadContext();
    const result = _resolveTdumContext([], ctx);
    expect(result).toEqual({});
  });

  test("test_tdum_context_with_tdb4_sibling", () => {
    const ctx = new ReadContext();
    const tdb4 = new Tdb4Chunk({ chunkType: "tdb4" });
    tdb4.color = true;
    tdb4.integer = false;
    // siblings[2] is the tdb4
    const siblings = [new Chunk({}), new Chunk({}), tdb4];
    const result = _resolveTdumContext(siblings, ctx);
    expect(result).toEqual({ isColor: true, isInteger: false });
  });

  test("test_tdum_context_with_raw_sibling", () => {
    const ctx = new ReadContext();
    const siblings = [new Chunk({}), new Chunk({}), new Chunk({ chunkType: "tdb4", data: b("\x00") })];
    const result = _resolveTdumContext(siblings, ctx);
    expect(result).toEqual({});
  });
});

// -----------------------------------------------------------------------
// Group 8: fmt_field + _struct_info tests
// -----------------------------------------------------------------------

describe("TestFmtField", () => {
  test("test_struct_info_returns_none_for_raw_chunk", () => {
    const result = _structInfo(Chunk);
    expect(result == null).toBe(true);
  });

  test("test_struct_info_returns_format_for_u4", () => {
    const info = _structInfo(U4Chunk);
    expect(info != null).toBe(true);
    if (info == null) throw new AssertionError("U4Chunk has no struct info");
    const [
      fmt,
      dataFields,
      encodings,
      optionalStart,
      endians,
      itemsInfo,
      coerces,
      initNames,
      simple,
      expectedSize,
    ] = info;
    expect(fmt).toBe("I");
    expect(dataFields.length).toBe(1);
    expect(dataFields[0].name).toBe("value");
    expect(valueEquals(encodings, new Map())).toBe(true);
    expect(valueEquals(endians, new Map())).toBe(true);
    expect(itemsInfo == null).toBe(true);
    expect(optionalStart).toBe(1); // no optional fields
    expect(valueEquals(initNames, ["value"])).toBe(true);
    expect(simple).toBe(true); // no encodings/endians/optional/items
  });

  test("test_struct_info_field_count_validation", () => {
    class BadChunk extends Chunk {
      declare a: number;
      declare b: number;
      declare c: number;
      // "IHB" yields 3 values, 3 fields - OK for now.
      // To test mismatch, we'd need a multi-value format with wrong count.
    }
    define(BadChunk, { a: u4Field(), b: u2Field(), c: u1Field() });

    const info = _structInfo(BadChunk);
    expect(info != null).toBe(true);
    if (info == null) throw new AssertionError("BadChunk has no struct info");
    const [fmt, dataFields, encodings, optionalStart, endians, itemsInfo, , , simple] = info;
    expect(fmt).toBe("IHB");
    expect(dataFields.length).toBe(3);
    expect(valueEquals(encodings, new Map())).toBe(true);
    expect(valueEquals(endians, new Map())).toBe(true);
    expect(itemsInfo == null).toBe(true);
    expect(optionalStart).toBe(3); // all required
    expect(simple).toBe(true); // no transforms, no items/optional
  });

  test("test_struct_info_encoding_tracked", () => {
    const info = _structInfo(PrinChunk);
    expect(info != null).toBe(true);
    if (info == null) throw new AssertionError("PrinChunk has no struct info");
    const encodings = info[2];
    const simple = info[8];
    // PrinChunk has match_name (field index 1) and display_name (index 2)
    expect(encodings.has(1)).toBe(true);
    expect(getOrThrow(encodings, 1)).toBe("ascii");
    expect(encodings.has(2)).toBe(true);
    expect(getOrThrow(encodings, 2)).toBe("ascii");
  });

  test("test_encoding_ascii_read_write_roundtrip", () => {
    // PrinChunk reads/writes 48-byte ASCII null-terminated strings.
    // Build raw 104-byte prin body
    const reserved00 = bytes_.zeros(4);
    const matchName = bytes_.concat(b("ADBE Advanced 3d"), bytes_.zeros(32)); // 48 bytes
    const displayName = bytes_.concat(b("Classic 3D"), bytes_.zeros(38)); // 48 bytes
    const reserved68 = bytes_.zeros(3);
    const endMarker = b("\x01");
    const raw = bytes_.concat(reserved00, matchName, displayName, reserved68, endMarker);

    const chunk = asInstance(PrinChunk.read(new BytesIO(raw), raw.length, { chunkType: "prin" }), PrinChunk);
    expect(chunk.matchName).toBe("ADBE Advanced 3d");
    expect(chunk.displayName).toBe("Classic 3D");

    // Round-trip
    const buf = new BytesIO();
    chunk.write(buf);
    expect(valueEquals(buf.getvalue(), raw)).toBe(true);
  });

  test("test_encoding_windows1252_read_write_roundtrip", () => {
    // LdtaChunk reads/writes 32-byte windows-1252 null-terminated layer_name.
    // Use a windows-1252 character: e-acute (0xe9)
    const name = "caf\xe9";
    const chunk = new LdtaChunk({ layerName: name });
    expect(chunk.layerName).toBe(name);

    const buf = new BytesIO();
    const written = chunk.write(buf);
    expect(written).toBe(160); // No matte_layer_id

    // Read back
    buf.seek(0);
    const chunk2 = asInstance(LdtaChunk.read(buf, 160, { chunkType: "ldta" }), LdtaChunk);
    expect(chunk2.layerName).toBe(name);
  });

  test("test_encoding_truncation_on_write", () => {
    // Encoded strings are truncated to fit the fixed field size.
    // 48-byte field: overlong strings are truncated to 48 chars
    const longName = "A".repeat(100);
    const chunk = new PrinChunk({ matchName: longName });

    const buf = new BytesIO();
    chunk.write(buf);
    buf.seek(0);
    const chunk2 = asInstance(PrinChunk.read(buf, 104, { chunkType: "prin" }), PrinChunk);
    expect(chunk2.matchName).toBe("A".repeat(48));
  });

  test("test_ldta_matte_layer_id_from_trailing", () => {
    // LdtaChunk reads matte_layer_id from optional trailing bytes.
    // Build 164-byte ldta (160 fixed + 4 optional matte)
    const chunk = new LdtaChunk({});
    expect(chunk.matteLayerId == null).toBe(true);

    const buf = new BytesIO();
    chunk.write(buf);
    const raw160 = buf.getvalue();
    expect(raw160.length).toBe(160);

    // Append matte_layer_id = 42
    const raw164 = bytes_.concat(raw160, struct.pack(">I", 42));
    const chunk2 = asInstance(LdtaChunk.read(new BytesIO(raw164), 164, { chunkType: "ldta" }), LdtaChunk);
    expect(chunk2.matteLayerId).toBe(42);

    // Round-trip
    const buf2 = new BytesIO();
    chunk2.write(buf2);
    expect(valueEquals(buf2.getvalue(), raw164)).toBe(true);
  });

  test("test_ldta_matte_layer_id_setter", () => {
    // Setting matte_layer_id to a value causes it to be written.
    const chunk = new LdtaChunk({});
    expect(chunk.matteLayerId == null).toBe(true);

    chunk.matteLayerId = 7;
    expect(chunk.matteLayerId).toBe(7);

    // Write includes the optional field
    const buf = new BytesIO();
    const written = chunk.write(buf);
    expect(written).toBe(164);
  });

  test("test_ldta_matte_layer_id_zero_roundtrip", () => {
    // matte_layer_id=0 (present) is distinct from None (absent).
    // 164 bytes: matte_layer_id is 0 (present, not absent)
    const chunk = new LdtaChunk({});
    const buf = new BytesIO();
    chunk.write(buf);
    const raw164 = bytes_.concat(buf.getvalue(), struct.pack(">I", 0));

    const chunk2 = asInstance(LdtaChunk.read(new BytesIO(raw164), 164, { chunkType: "ldta" }), LdtaChunk);
    expect(chunk2.matteLayerId).toBe(0); // present, not None

    // Round-trip preserves the field
    const buf2 = new BytesIO();
    chunk2.write(buf2);
    expect(valueEquals(buf2.getvalue(), raw164)).toBe(true);
  });

  test("test_fmt_field_auto_bytes_default", () => {
    // bytes_field(4) auto-defaults to b"\x00" * 4, not 0.
    class AutoChunk extends Chunk {
      declare chunkType: string;
      declare pad: Uint8Array;
    }
    define(AutoChunk, { chunkType: field({ default: "test" }), pad: bytesField(4) });

    const c = new AutoChunk({});
    expect(valueEquals(c.pad, bytes_.zeros(4))).toBe(true);
    const buf = new BytesIO();
    c.write(buf);
    expect(valueEquals(buf.getvalue(), bytes_.zeros(4))).toBe(true);
  });

  test("test_fmt_field_explicit_bytes_default_preserved", () => {
    // Non-zero explicit defaults survive the auto-default logic.
    class ExplicitChunk extends Chunk {
      declare chunkType: string;
      declare magic: Uint8Array;
    }
    define(ExplicitChunk, {
      chunkType: field({ default: "test" }),
      magic: bytesField(4, { default: b("FXTC") }),
    });

    const c = new ExplicitChunk({});
    expect(valueEquals(c.magic, b("FXTC"))).toBe(true);
  });

  test("test_fmt_field_non_bytes_default_unchanged", () => {
    // u1_field() still defaults to 0.
    class IntChunk extends Chunk {
      declare chunkType: string;
      declare val: number;
    }
    define(IntChunk, { chunkType: field({ default: "test" }), val: u1Field() });

    const c = new IntChunk({});
    expect(c.val).toBe(0);
  });

  test("test_fmt_field_encoding_default_empty_string", () => {
    // ascii_field with encoding defaults to empty string, not bytes.
    class EncChunk extends Chunk {
      declare chunkType: string;
      declare name: string;
    }
    define(EncChunk, { chunkType: field({ default: "test" }), name: asciiField(32) });

    const c = new EncChunk({});
    expect(c.name).toBe("");
  });
});

// -----------------------------------------------------------------------
// Group 9: BitField descriptor tests
// -----------------------------------------------------------------------

describe("TestBitField", () => {
  test("test_get_set_bit", () => {
    class Obj {
      raw = 0;
      declare flag: boolean;
    }
    descriptor(Obj, "flag", new BitField("raw", 3));

    const obj = new Obj();
    expect(obj.flag).toBe(false);
    obj.flag = true;
    expect(obj.flag).toBe(true);
    expect(obj.raw).toBe(0x08);
    obj.flag = false;
    expect(obj.flag).toBe(false);
    expect(obj.raw).toBe(0x00);
  });

  test("test_preserves_other_bits", () => {
    class Obj {
      raw = 0xff;
      declare bit0: boolean;
      declare bit7: boolean;
    }
    descriptor(Obj, "bit0", new BitField("raw", 0));
    descriptor(Obj, "bit7", new BitField("raw", 7));

    const obj = new Obj();
    expect(obj.bit0).toBe(true);
    expect(obj.bit7).toBe(true);
    obj.bit0 = false;
    expect(obj.raw).toBe(0xfe);
    expect(obj.bit7).toBe(true);
  });
});

// -----------------------------------------------------------------------
// Group 10: TdsbChunk tests
// -----------------------------------------------------------------------

describe("TestTdsbChunk", () => {
  test("test_roundtrip", () => {
    const raw = b("\x00\x00\x10\x03");
    const buf = new BytesIO(raw);
    const chunk = asInstance(TdsbChunk.read(buf, 4, { chunkType: "tdsb" }), TdsbChunk);
    expect(chunk instanceof TdsbChunk).toBe(true);
    expect(valueEquals(chunk.rotoBezier, 0)).toBe(true);
    expect(chunk.ratioUnlinked).toBe(false);
    // Separation is lock-byte bit 3; enable-byte bit 1 is the Timeline
    // hidden flag (AE sets it on an UNSEPARATED position that does not
    // apply, e.g. an ambient light's).
    expect(chunk.dimensionsSeparated).toBe(false);
    expect(chunk.hidden).toBe(true);
    expect(chunk.enabled).toBe(true);
    const out = new BytesIO();
    chunk.write(out);
    expect(valueEquals(out.getvalue(), raw)).toBe(true);
  });

  test("test_separated_bit", () => {
    // What AE writes for a separated position: lock 0x08, enable 0x03.
    const raw = b("\x00\x00\x08\x03");
    const chunk = asInstance(TdsbChunk.read(new BytesIO(raw), 4, { chunkType: "tdsb" }), TdsbChunk);
    expect(chunk instanceof TdsbChunk).toBe(true);
    expect(chunk.dimensionsSeparated).toBe(true);
    expect(chunk.ratioUnlinked).toBe(false);
    expect(chunk.hidden).toBe(true);
    const out = new BytesIO();
    chunk.write(out);
    expect(valueEquals(out.getvalue(), raw)).toBe(true);
  });

  test("test_with_trailing", () => {
    const raw = b("\x01\x00\x00\x01\xaa\xbb");
    const buf = new BytesIO(raw);
    const chunk = asInstance(TdsbChunk.read(buf, 6, { chunkType: "tdsb" }), TdsbChunk);
    expect(chunk instanceof TdsbChunk).toBe(true);
    expect(valueEquals(chunk.rotoBezier, 1)).toBe(true);
    expect(chunk.enabled).toBe(true);
    expect(valueEquals(chunk._trailing, b("\xaa\xbb"))).toBe(true);
    const out = new BytesIO();
    chunk.write(out);
    expect(valueEquals(out.getvalue(), raw)).toBe(true);
  });

  test("test_bitfield_write_through", () => {
    const chunk = new TdsbChunk({ chunkType: "tdsb" });
    chunk.enabled = true;
    chunk.hidden = true;
    expect(chunk._enableFlags).toBe(0x03);
    chunk.enabled = false;
    expect(chunk._enableFlags).toBe(0x02);

    chunk.dimensionsSeparated = true;
    expect(chunk._lockFlags).toBe(0x08);
    chunk.dimensionsSeparated = false;
    expect(chunk._lockFlags).toBe(0x00);
  });
});

// -----------------------------------------------------------------------
// Group 11: Tdb4Chunk tests
// -----------------------------------------------------------------------

describe("TestTdb4Chunk", () => {
  test("test_roundtrip_124_bytes", () => {
    // Build a known 124-byte tdb4 body
    const fmt = ">HHBB5sB4s5dBBBB8sB15s32s3sB4s";
    const raw = struct.pack(
      fmt,
      0xdb99, // magic
      3, // dimensions
      0, // pad1
      0x09, // spatial(bit3)=1, static(bit0)=1
      bytes_.zeros(5), // pad2
      0x02, // can_vary_over_time(bit1)=1
      bytes_.zeros(4), // pad3
      0.0001,
      1.777778,
      1.0,
      1.0,
      1.0, // floats
      0, // pad4
      0x00, // no_value=0
      0, // pad5
      0x05, // vector(bit3)=0, integer(bit2)=1, color(bit0)=1
      bytes_.zeros(8), // pad6
      1, // animated
      bytes_.zeros(15), // pad7
      bytes_.zeros(32), // pad8
      bytes_.zeros(3), // pad9
      0x01, // expression_disabled(bit0)=1
      bytes_.zeros(4), // pad10
    );
    expect(raw.length).toBe(124);

    const buf = new BytesIO(raw);
    const chunk = asInstance(Tdb4Chunk.read(buf, 124, { chunkType: "tdb4" }), Tdb4Chunk);
    expect(chunk instanceof Tdb4Chunk).toBe(true);
    expect(chunk.dimensions).toBe(3);
    expect(chunk.isSpatial).toBe(true);
    expect(chunk.static).toBe(true);
    expect(chunk.canVaryOverTime).toBe(true);
    expect(chunk.integer).toBe(true);
    expect(chunk.color).toBe(true);
    expect(chunk.vector).toBe(false);
    expect(valueEquals(chunk.animated, 1)).toBe(true);
    expect(chunk.expressionDisabled).toBe(true);

    const out = new BytesIO();
    chunk.write(out);
    expect(valueEquals(out.getvalue(), raw)).toBe(true);
  });

  test("test_undersize_raises", () => {
    const buf = new BytesIO(bytes_.zeros(50));
    raises(OSError, () => Tdb4Chunk.read(buf, 50, { chunkType: "tdb4" }), "body too short");
  });
});

// -----------------------------------------------------------------------
// Group 12: CdatChunk tests
// -----------------------------------------------------------------------

describe("TestCdatChunk", () => {
  test("test_roundtrip_be", () => {
    const raw = struct.pack(">3d", 1.0, 2.5, -3.0);
    const buf = new BytesIO(raw);
    const chunk = CdatChunk.read(buf, 24, { chunkType: "cdat", isLe: false });
    expect(valueEquals(chunk.values, [1.0, 2.5, -3.0])).toBe(true);
    expect(chunk.isLe).toBe(false);
    const out = new BytesIO();
    chunk.write(out);
    expect(valueEquals(out.getvalue(), raw)).toBe(true);
  });

  test("test_roundtrip_le", () => {
    const raw = struct.pack("<2d", 42.0, -1.5);
    const buf = new BytesIO(raw);
    const chunk = CdatChunk.read(buf, 16, { chunkType: "cdat", isLe: true });
    expect(valueEquals(chunk.values, [42.0, -1.5])).toBe(true);
    expect(chunk.isLe).toBe(true);
    const out = new BytesIO();
    chunk.write(out);
    expect(valueEquals(out.getvalue(), raw)).toBe(true);
  });

  test("test_empty_body", () => {
    const buf = new BytesIO(b(""));
    const chunk = CdatChunk.read(buf, 0, { chunkType: "cdat" });
    expect(valueEquals(chunk.values, [])).toBe(true);
    const out = new BytesIO();
    const written = chunk.write(out);
    expect(written).toBe(0);
  });
});

// -----------------------------------------------------------------------
// Group 13: TdumChunk tests
// -----------------------------------------------------------------------

describe("TestTdumChunk", () => {
  test("test_roundtrip_doubles", () => {
    const raw = struct.pack(">2d", 0.0, 100.0);
    const buf = new BytesIO(raw);
    const chunk = TdumChunk.read(buf, 16, { chunkType: "tdum" });
    expect(valueEquals(chunk.values, [0.0, 100.0])).toBe(true);
    expect(chunk.isColor).toBe(false);
    expect(chunk.isInteger).toBe(false);
    const out = new BytesIO();
    chunk.write(out);
    expect(valueEquals(out.getvalue(), raw)).toBe(true);
  });

  test("test_roundtrip_color", () => {
    const raw = struct.pack(">4f", 0.0, 0.0, 0.0, 1.0);
    const buf = new BytesIO(raw);
    const chunk = TdumChunk.read(buf, 16, { chunkType: "tdum", isColor: true });
    expect(chunk.values.length).toBe(4);
    expect(chunk.isColor).toBe(true);
    const out = new BytesIO();
    chunk.write(out);
    expect(valueEquals(out.getvalue(), raw)).toBe(true);
  });

  test("test_roundtrip_integer", () => {
    const raw = struct.pack(">I", 255);
    const buf = new BytesIO(raw);
    const chunk = TdumChunk.read(buf, 4, { chunkType: "tdum", isInteger: true });
    expect(valueEquals(chunk.values, [255.0])).toBe(true);
    expect(chunk.isInteger).toBe(true);
    const out = new BytesIO();
    chunk.write(out);
    expect(valueEquals(out.getvalue(), raw)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FipsChunk
// ---------------------------------------------------------------------------

describe("TestFipsChunk", () => {
  test("test_roundtrip", () => {
    const chunk = new FipsChunk({
      chunkType: "fips",
      channels: 1,
      zoomType: 1,
      zoom: 0.5,
      exposure: 2.0,
      roiTop: 10,
      roiLeft: 20,
      roiBottom: 100,
      roiRight: 200,
    });
    const buf = new BytesIO();
    chunk.write(buf);
    buf.seek(0);
    const chunk2 = asInstance(FipsChunk.read(buf, buf.getbuffer().length, { chunkType: "fips" }), FipsChunk);
    expect(chunk2.channels).toBe(1);
    expect(chunk2.zoomType).toBe(1);
    expect(chunk2.zoom).toBe(0.5);
    expect(chunk2.exposure).toBe(2.0);
    expect(chunk2.roiTop).toBe(10);
    expect(chunk2.roiLeft).toBe(20);
    expect(chunk2.roiBottom).toBe(100);
    expect(chunk2.roiRight).toBe(200);
  });

  test("test_bitfield_descriptors", () => {
    const chunk = new FipsChunk({ chunkType: "fips" });
    chunk.checkerboards = true;
    chunk.rulers = true;
    chunk.regionOfInterest = true;
    chunk.grid = true;
    expect(chunk.checkerboards).toBe(true);
    expect(chunk.rulers).toBe(true);
    expect(chunk.regionOfInterest).toBe(true);
    expect(chunk.grid).toBe(true);

    const buf = new BytesIO();
    chunk.write(buf);
    buf.seek(0);
    const chunk2 = asInstance(FipsChunk.read(buf, buf.getbuffer().length, { chunkType: "fips" }), FipsChunk);
    expect(chunk2.checkerboards).toBe(true);
    expect(chunk2.rulers).toBe(true);
    expect(chunk2.regionOfInterest).toBe(true);
    expect(chunk2.grid).toBe(true);
  });

  test("test_fast_preview_type", () => {
    const chunk = new FipsChunk({ chunkType: "fips" });
    expect(chunk.fastPreviewType).toBe(0);
    chunk.fastPreviewAdaptive = true;
    expect(chunk.fastPreviewType).toBe(1);
    chunk.fastPreviewAdaptive = false;
    chunk.fastPreviewWireframe = true;
    expect(chunk.fastPreviewType).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Fth5Chunk
// ---------------------------------------------------------------------------

describe("TestFth5Chunk", () => {
  test("test_roundtrip", () => {
    const pts = [
      new FeatherPointItem({
        segLoc: 1,
        interpRaw: 0,
        relSegLoc: 0.5,
        radius: 10.0,
        cornerAngle: 45.0,
        tension: 0.5,
      }),
      new FeatherPointItem({
        segLoc: 2,
        interpRaw: 2,
        relSegLoc: 0.75,
        radius: -5.0,
        cornerAngle: 0.0,
        tension: 1.0,
      }),
    ];
    const chunk = new Fth5Chunk({ chunkType: "fth5", points: pts });
    const buf = new BytesIO();
    chunk.write(buf);
    expect(buf.tell()).toBe(64); // 2 * 32 bytes
    buf.seek(0);
    const chunk2 = asInstance(Fth5Chunk.read(buf, 64, { chunkType: "fth5" }), Fth5Chunk);
    expect(chunk2.points.length).toBe(2);
    expect(chunk2.points[0].segLoc).toBe(1);
    expect(chunk2.points[0].interpRaw).toBe(0);
    expect(chunk2.points[0].relSegLoc).toBe(0.5);
    expect(chunk2.points[0].radius).toBe(10.0);
    expect(chunk2.points[1].segLoc).toBe(2);
    expect(chunk2.points[1].interpRaw).toBe(2);
    expect(chunk2.points[1].radius).toBe(-5.0);
  });

  test("test_empty", () => {
    const chunk = new Fth5Chunk({ chunkType: "fth5", points: [] });
    const buf = new BytesIO();
    const written = chunk.write(buf);
    expect(written).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// RoutChunk
// ---------------------------------------------------------------------------

describe("TestRoutChunk", () => {
  test("test_roundtrip", () => {
    const items = [new RoutItem({ flags: 0x40 }), new RoutItem({ flags: 0x00 })];
    const chunk = new RoutChunk({
      chunkType: "Rout",
      count: 2,
      items: items,
    });
    expect(chunk.items[0].render).toBe(true);
    expect(chunk.items[1].render).toBe(false);

    const buf = new BytesIO();
    chunk.write(buf);
    expect(buf.tell()).toBe(12); // 4 count + 2 * 4
    buf.seek(0);
    const chunk2 = asInstance(RoutChunk.read(buf, 12, { chunkType: "Rout" }), RoutChunk);
    expect(chunk2.items.length).toBe(2);
    expect(chunk2.items[0].render).toBe(true);
    expect(chunk2.items[1].render).toBe(false);
  });

  test("test_render_bitfield", () => {
    const item = new RoutItem({});
    expect(item.render).toBe(false);
    item.render = true;
    expect(item.render).toBe(true);
    expect(item._flags).toBe(0x40);
  });
});

/**
 * Roou bodies: 154 bytes (modern AE) and the legacy 114-byte form
 * without the optional `_reserved_72` tail must both round-trip
 * byte-identically.
 */
describe("TestRouuChunk", () => {
  test("test_fresh_chunk_writes_154_bytes", () => {
    expect(new RouuChunk({}).tobytes().length).toBe(154);
  });

  test("test_154_byte_body_roundtrips", () => {
    const full = new RouuChunk({}).tobytes();
    const chunk = asInstance(RouuChunk.frombytes(full, { chunkType: "Roou" }), RouuChunk);
    expect(chunk._reserved72 != null).toBe(true);
    expect(valueEquals(chunk.tobytes(), full)).toBe(true);
  });

  test("test_114_byte_body_roundtrips", () => {
    const short = bytes_.slice(new RouuChunk({}).tobytes(), null, 114);
    const chunk = asInstance(RouuChunk.frombytes(short, { chunkType: "Roou" }), RouuChunk);
    expect(chunk._reserved72 == null).toBe(true);
    expect(chunk.audioChannels).toBe(0); // last required field still parsed
    expect(valueEquals(chunk.tobytes(), short)).toBe(true);
  });

  test("test_audio_format_is_three_big_endian_words", () => {
    // After Effects stores encoding / bytes per sample / channels as
    // whole words: `ffff ffff 0000` while unset, `0002 0001 0001` for
    // 8-bit mono (audio_settings_matrix.aep, item E9_on_mono_8).
    const chunk = new RouuChunk({});
    expect(valueEquals(bytes_.slice(chunk.tobytes(), 0x6c, 0x72), bytes_.fromhex("ffffffff0000"))).toBe(true);
    expect(chunk.audioEncoding).toBe(0xffff);
    expect(chunk.audioBitDepth).toBe(0xffff);
    expect(chunk.audioChannels).toBe(0);
    chunk.audioEncoding = 2;
    chunk.audioBitDepth = 1;
    chunk.audioChannels = 1;
    expect(valueEquals(bytes_.slice(chunk.tobytes(), 0x6c, 0x72), bytes_.fromhex("000200010001"))).toBe(true);
  });
});

describe("TestLhd3ChunkWordWidths", () => {
  test("test_count_and_item_size_are_32_bit_words", () => {
    // Lists of more than 65535 items (dense baked keyframes) keep their
    // count: the header stores it as one 32-bit word at 0x08, the item
    // size as one at 0x10 (upper halves 0 in every sample).
    const chunk = new Lhd3Chunk({ count: 70_000, itemSize: 0x10000 + 16 });
    const body = chunk.tobytes();
    expect(valueEquals(bytes_.slice(body, 0x08, 0x0c), bytes_.intToBytes(70_000, 4, "big"))).toBe(true);
    expect(valueEquals(bytes_.slice(body, 0x10, 0x14), bytes_.intToBytes(0x10000 + 16, 4, "big"))).toBe(true);
    const reread = asInstance(Lhd3Chunk.frombytes(body, { chunkType: "lhd3" }), Lhd3Chunk);
    expect(valueEquals([reread.count, reread.itemSize], [70_000, 0x10000 + 16])).toBe(true);
    expect(
      valueEquals(
        bytes_.slice(new Lhd3Chunk({ count: 3, itemSize: 16 }).tobytes(), null, 0x14),
        bytes_.fromhex("00d00bee00000000000000030000000100000010"),
      ),
    ).toBe(true);
  });
});

describe("TestTextOptiChunk", () => {
  test("test_layer_count_is_a_32_bit_word_at_0x30", () => {
    // A document with more than 255 layers keeps its count (AE 2026's
    // fixtures store 2 / 8 / 22 / 48 in the low byte, upper bytes 0).
    const data = buildAiLayerOptiData(612, 792, "Layer 300", 300);
    expect(valueEquals(bytes_.slice(data, 0x30, 0x34), bytes_.intToBytes(300, 4, "big"))).toBe(true);
    const chunk = asInstance(TextOptiChunk.frombytes(data, { chunkType: "opti" }), TextOptiChunk);
    expect(chunk.textDocumentLayers).toBe(300);
  });
});

describe("TestSspcChunk", () => {
  test("test_depth_is_a_signed_word_at_0x3e", () => {
    // Grayscale depths are negative (16-bit gray = -16, `ff f0`), as in
    // footage_depth.aep's png_g16.png.
    const chunk = new SspcChunk({});
    expect(chunk.depth).toBe(0);
    expect(valueEquals(bytes_.slice(chunk.tobytes(), 0x3e, 0x45), bytes_.zeros(7))).toBe(true); // solids and placeholders
    chunk.depth = -16;
    expect(valueEquals(bytes_.slice(chunk.tobytes(), 0x3e, 0x40), b("\xff\xf0"))).toBe(true);
    const reread = asInstance(SspcChunk.frombytes(chunk.tobytes(), { chunkType: "sspc" }), SspcChunk);
    expect(reread.depth).toBe(-16);
  });

  test("test_flag_bytes_keep_their_other_bits", () => {
    // The HQ field separation flag is bit 0 of byte 0x9F, which AE also
    // sets bit 3 of for container media (footage_depth.aep: mov_480.mov
    // stores 0x08); the missing flag is bit 0 of byte 0x73.
    const body = new Uint8Array(new SspcChunk({}).tobytes());
    body[0x9f] = 0x08;
    body[0x73] = 0x10;
    const chunk = asInstance(SspcChunk.frombytes(body.slice(), { chunkType: "sspc" }), SspcChunk);
    expect(chunk.highQualityFieldSeparation).toBe(false);
    expect(chunk.footageMissingAtSave).toBe(false);
    chunk.highQualityFieldSeparation = true;
    chunk.footageMissingAtSave = true;
    expect(chunk.tobytes()[0x9f]).toBe(0x09);
    expect(chunk.tobytes()[0x73]).toBe(0x11);
    chunk.highQualityFieldSeparation = false;
    chunk.footageMissingAtSave = false;
    expect(chunk.tobytes()[0x9f]).toBe(0x08);
    expect(chunk.tobytes()[0x73]).toBe(0x10);
  });

  test("test_data_size_is_a_64_bit_word_at_0xcc", () => {
    // AE 2026 caches 14,729,427,240 for a 14.7 GB image sequence.
    const chunk = new SspcChunk({});
    chunk.dataSize = 14_729_427_240;
    expect(valueEquals(bytes_.slice(chunk.tobytes(), 0xcc, 0xd4), bytes_.intToBytes(14_729_427_240, 8, "big"))).toBe(true);
    const reread = asInstance(SspcChunk.frombytes(chunk.tobytes(), { chunkType: "sspc" }), SspcChunk);
    expect(valueEquals(reread.dataSize, 14_729_427_240)).toBe(true); // u8 field unpacks as bigint
  });
});

// ---------------------------------------------------------------------------
// OptiChunk variants
// ---------------------------------------------------------------------------

describe("TestOptiChunk", () => {
  test("test_soli_roundtrip", () => {
    const chunk = new SoliOptiChunk({
      chunkType: "opti",
      assetTypeInt: 9,
      colorR: 1.0,
      colorG: 0.5,
      colorB: 0.0,
      solidName: "Red Solid",
    });
    expect(valueEquals([chunk.colorR, chunk.colorG, chunk.colorB], [1.0, 0.5, 0.0])).toBe(true);

    const buf = new BytesIO();
    chunk.write(buf);
    buf.seek(0);
    const size = buf.getbuffer().length;
    const chunk2 = OptiChunk.read(buf, size, { chunkType: "opti" });
    expect(chunk2 instanceof SoliOptiChunk).toBe(true);
    expect(chunk2.assetType).toBe("Soli");
    expect(chunk2.colorR).toBe(1.0);
    expect(chunk2.colorG).toBe(0.5);
    expect(chunk2.colorB).toBe(0.0);
    expect(chunk2.solidName).toBe("Red Solid");
  });

  test("test_psd_roundtrip", () => {
    const data = new Uint8Array(344);
    data.set(b("8BPS"), 0);
    struct.packInto(">H", data, 4, 7);
    struct.packInto(">H", data, 16, 3);
    data[30] = 4;
    struct.packInto("<H", data, 32, 600);
    struct.packInto("<H", data, 36, 800);
    data[40] = 8;
    data[48] = 5;
    struct.packInto("<iiii", data, 78, 10, 20, 610, 820);

    const buf = new BytesIO(data.slice());
    const chunk = OptiChunk.read(buf, 344, { chunkType: "opti" });
    expect(chunk instanceof PsdOptiChunk).toBe(true);
    expect(chunk.psdLayerIndex).toBe(3);
    expect(chunk.psdCanvasHeight).toBe(600);
    expect(chunk.psdCanvasWidth).toBe(800);
    expect(chunk.psdBitDepth).toBe(8);
    expect(chunk.psdLayerTop).toBe(10);

    const out = new BytesIO();
    chunk.write(out);
    expect(valueEquals(out.getvalue(), data.slice())).toBe(true);
  });

  test("test_placeholder_roundtrip", () => {
    const name = "MyPlaceholder";
    const nameBytes = encode(name, "windows-1252");
    // Build data: 4-byte asset_type + 2-byte asset_type_int + 4-byte pad
    // + 256-byte NUL-padded name
    const nameField = bytes_.concat(nameBytes, bytes_.zeros(256 - nameBytes.length));
    const data = bytes_.concat(
      bytes_.zeros(4),
      struct.pack(">H", 2),
      b("\x00\x00\x01\x0a"),
      nameField,
    );

    const buf = new BytesIO(data);
    const chunk = OptiChunk.read(buf, data.length, { chunkType: "opti" });
    expect(chunk instanceof PlaceholderOptiChunk).toBe(true);
    expect(chunk.placeholderName).toBe("MyPlaceholder");

    const out = new BytesIO();
    chunk.write(out);
    expect(valueEquals(out.getvalue(), data)).toBe(true);
  });

  test("test_unknown_fallback", () => {
    const data = bytes_.concat(b("UNKN"), bytes_.zeros(20));
    const buf = new BytesIO(data);
    const chunk = OptiChunk.read(buf, data.length, { chunkType: "opti" });
    expect(chunk.constructor).toBe(OptiChunk);
    expect(valueEquals(chunk.data, data)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RoptChunk variants
// ---------------------------------------------------------------------------

describe("TestRoptChunk", () => {
  test("test_cineon_roundtrip", () => {
    const chunk = new CineonRoptChunk({
      chunkType: "Ropt",
      tenBitBlackPoint: 95,
      tenBitWhitePoint: 685,
      convertedBlackPoint: 0.0,
      convertedWhitePoint: 1.0,
      currentGamma: 1.7,
      highlightExpansion: 1,
      logarithmicConversion: 1,
      fileFormat: 0,
      bitDepth: 10,
    });
    const buf = new BytesIO();
    chunk.write(buf);
    buf.seek(0);
    const size = buf.getbuffer().length;
    const chunk2 = RoptChunk.read(buf, size, { chunkType: "Ropt" });
    expect(chunk2 instanceof CineonRoptChunk).toBe(true);
    expect(chunk2.tenBitBlackPoint).toBe(95);
    expect(chunk2.tenBitWhitePoint).toBe(685);
    expect(chunk2.currentGamma).toBe(1.7);
    expect(chunk2.bitDepth).toBe(10);
  });

  test("test_jpeg_roundtrip", () => {
    const chunk = new JpegRoptChunk({
      chunkType: "Ropt",
      quality: 80,
      formatType: 1,
      scans: 3,
    });
    const buf = new BytesIO();
    chunk.write(buf);
    buf.seek(0);
    const chunk2 = RoptChunk.read(buf, buf.getbuffer().length, { chunkType: "Ropt" });
    expect(chunk2 instanceof JpegRoptChunk).toBe(true);
    expect(chunk2.quality).toBe(80);
    expect(chunk2.formatType).toBe(1);
  });

  test("test_openexr_roundtrip", () => {
    const chunk = new OpenExrRoptChunk({
      chunkType: "Ropt",
      formatCode: "oEXR",
      compression: 3,
      thirtyTwoBitFloat: 1,
      luminanceChroma: 0,
      dwaCompressionLevel: 45.0,
    });
    const buf = new BytesIO();
    chunk.write(buf);
    buf.seek(0);
    const chunk2 = RoptChunk.read(buf, buf.getbuffer().length, { chunkType: "Ropt" });
    expect(chunk2 instanceof OpenExrRoptChunk).toBe(true);
    expect(chunk2.compression).toBe(3);
    expect(valueEquals(chunk2.thirtyTwoBitFloat, 1)).toBe(true);
    expect(chunk2.dwaCompressionLevel).toBe(45.0);
  });

  test("test_targa_roundtrip", () => {
    const chunk = new TargaRoptChunk({
      chunkType: "Ropt",
      bitsPerPixel: 32,
      rleCompression: 1,
    });
    const buf = new BytesIO();
    chunk.write(buf);
    buf.seek(0);
    const chunk2 = RoptChunk.read(buf, buf.getbuffer().length, { chunkType: "Ropt" });
    expect(chunk2 instanceof TargaRoptChunk).toBe(true);
    expect(chunk2.bitsPerPixel).toBe(32);
    expect(valueEquals(chunk2.rleCompression, 1)).toBe(true);
  });

  test("test_png_roundtrip", () => {
    const chunk = new PngRoptChunk({
      chunkType: "Ropt",
      width: 1920,
      height: 1080,
      bitDepth: 8,
      compression: 0,
    });
    const buf = new BytesIO();
    chunk.write(buf);
    buf.seek(0);
    const chunk2 = RoptChunk.read(buf, buf.getbuffer().length, { chunkType: "Ropt" });
    expect(chunk2 instanceof PngRoptChunk).toBe(true);
    expect(chunk2.width).toBe(1920);
    expect(chunk2.height).toBe(1080);
    expect(chunk2.bitDepth).toBe(8);
  });

  test("test_unknown_fallback", () => {
    const data = bytes_.concat(b("UNKN"), bytes_.zeros(20));
    const buf = new BytesIO(data);
    const chunk = RoptChunk.read(buf, data.length, { chunkType: "Ropt" });
    expect(chunk.constructor).toBe(RoptChunk);
    expect(valueEquals(chunk.data, data)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PardChunk variants
// ---------------------------------------------------------------------------

describe("TestPardChunk", () => {
  function _buildPard(controlType: number, body: Uint8Array, name = "Test"): Uint8Array {
    const padPre = bytes_.zeros(15);
    const ct = struct.pack(">B", controlType);
    let rawName = encode(name, "windows-1252");
    rawName = bytes_.concat(rawName, bytes_.zeros(32 - rawName.length));
    const padPost = bytes_.zeros(8);
    return bytes_.concat(padPre, ct, rawName, padPost, body);
  }

  test("test_color_roundtrip", () => {
    // The SDK colour definition is value + default; AE leaves leftover
    // memory after them (here a pointer-like pattern seen in AE 2022
    // samples), which must round-trip but is not a field.
    const body = bytes_.concat(
      struct.pack(">4B", 255, 0, 0, 255),
      struct.pack(">4B", 128, 128, 128, 255),
      bytes_.zeros(64),
      bytes_.fromhex("ffffffff0000000046696c6c0000000024f70a7e"),
    );
    const data = _buildPard(5, body);
    const buf = new BytesIO(data);
    const chunk = PardChunk.read(buf, data.length, { chunkType: "pard" });
    expect(chunk instanceof ColorPardChunk).toBe(true);
    expect(valueEquals(chunk.lastColor, [255, 0, 0, 255])).toBe(true);
    expect(valueEquals(chunk.defaultColor, [128, 128, 128, 255])).toBe(true);
    expect(!("max_color" in chunk)).toBe(true);
    expect(chunk.name).toBe("Test");

    const out = new BytesIO();
    chunk.write(out);
    expect(valueEquals(out.getvalue(), data)).toBe(true);
  });

  test("test_scalar_roundtrip", () => {
    const body = bytes_.concat(
      struct.pack(">i", 50),
      bytes_.zeros(64),
      struct.pack(">ii", 0, 100 * 65536),
      struct.pack(">ii", 0, 100 * 65536),
    );
    const data = _buildPard(2, body);
    const buf = new BytesIO(data);
    const chunk = PardChunk.read(buf, data.length, { chunkType: "pard" });
    expect(chunk instanceof ScalarPardChunk).toBe(true);
    expect(chunk.lastValueRaw).toBe(50);
    expect(chunk.lastValue).toBe(50 / 65536);
    expect(chunk.validMinRaw).toBe(0);
    expect(chunk.validMaxRaw).toBe(100 * 65536);
    expect(chunk.validMin).toBe(0);
    expect(chunk.validMax).toBe(100);
    expect(chunk.sliderMinRaw).toBe(0);
    expect(chunk.sliderMaxRaw).toBe(100 * 65536);

    const out = new BytesIO();
    chunk.write(out);
    expect(valueEquals(out.getvalue(), data)).toBe(true);
  });

  test("test_integer_roundtrip", () => {
    const body = bytes_.concat(struct.pack(">i", 5), bytes_.zeros(64), struct.pack(">ii", 3, 999));
    const data = _buildPard(1, body);
    const buf = new BytesIO(data);
    const chunk = PardChunk.read(buf, data.length, { chunkType: "pard" });
    expect(chunk instanceof IntegerPardChunk).toBe(true);
    expect(chunk.lastValue).toBe(5);
    expect(chunk.validMin).toBe(3);
    expect(chunk.validMax).toBe(999);

    const out = new BytesIO();
    chunk.write(out);
    expect(valueEquals(out.getvalue(), data)).toBe(true);
  });

  test("test_angle_roundtrip", () => {
    const body = struct.pack(">i", 180);
    const data = _buildPard(3, body);
    const buf = new BytesIO(data);
    const chunk = PardChunk.read(buf, data.length, { chunkType: "pard" });
    expect(chunk instanceof AnglePardChunk).toBe(true);
    expect(chunk.lastValueRaw).toBe(180);
    expect(chunk.lastValue).toBe(180 / 65536);

    const out = new BytesIO();
    chunk.write(out);
    expect(valueEquals(out.getvalue(), data)).toBe(true);
  });

  test("test_boolean_roundtrip", () => {
    const body = bytes_.concat(struct.pack(">I", 1), b("\x01"), bytes_.zeros(3));
    const data = _buildPard(4, body);
    const buf = new BytesIO(data);
    const chunk = asInstance(PardChunk.read(buf, data.length, { chunkType: "pard" }), BooleanPardChunk);
    expect(chunk instanceof BooleanPardChunk).toBe(true);
    expect(chunk.lastValue).toBe(1);
    expect(chunk.default_).toBe(1);

    const out = new BytesIO();
    chunk.write(out);
    expect(valueEquals(out.getvalue(), data)).toBe(true);
  });

  test("test_enum_roundtrip", () => {
    // SDK popup layout: s4 value, s2 choice count, s2 default (1-based),
    // then the choice-names pointer AE leaves as leftover bytes.
    let body = bytes_.concat(struct.pack(">ihh", 2, 5, 4), bytes_.fromhex("e0af37a4d0e2d700"));
    body = bytes_.concat(body, bytes_.zeros(92 - body.length));
    const data = _buildPard(7, body);
    const buf = new BytesIO(data);
    const chunk = asInstance(PardChunk.read(buf, data.length, { chunkType: "pard" }), EnumPardChunk);
    expect(chunk instanceof EnumPardChunk).toBe(true);
    expect(chunk.lastValue).toBe(2);
    expect(chunk.nbOptions).toBe(5);
    expect(chunk.default_).toBe(4);

    const out = new BytesIO();
    chunk.write(out);
    expect(valueEquals(out.getvalue(), data)).toBe(true);
  });

  test("test_enum_ae_edge_mode", () => {
    // The pard bytes of S_BlurDirectional's Edge Mode (sample
    // `29.97_fps_time_scale_3.125.aep`): cached value 1, 3 choices,
    // default 3 - the value ExtendScript reports for the omitted
    // parameter.
    let body = bytes_.fromhex(
      "00000001" + // value
        "0003" + // choice count
        "0003" + // default
        "00000000" +
        "0000000040337cd1" +
        "00000000d0e2d700", // leftovers
    );
    body = bytes_.concat(body, bytes_.zeros(92 - body.length));
    const data = _buildPard(7, body);
    const chunk = asInstance(PardChunk.read(new BytesIO(data), data.length, { chunkType: "pard" }), EnumPardChunk);
    expect(chunk instanceof EnumPardChunk).toBe(true);
    expect(valueEquals([chunk.lastValue, chunk.nbOptions, chunk.default_], [1, 3, 3])).toBe(true);
    expect(valueEquals(chunk.tobytes(), data)).toBe(true);
  });

  test("test_slider_roundtrip", () => {
    const body = bytes_.concat(
      struct.pack(">d", 50.0),
      bytes_.zeros(40),
      struct.pack(">ff", 0.0, 1000.0),
      bytes_.zeros(4),
      struct.pack(">f", 100.0),
    );
    const data = _buildPard(10, body);
    const buf = new BytesIO(data);
    const chunk = asInstance(PardChunk.read(buf, data.length, { chunkType: "pard" }), SliderPardChunk);
    expect(chunk instanceof SliderPardChunk).toBe(true);
    expect(chunk.lastValue).toBe(50.0);
    expect(chunk.phase).toBe(0.0);
    expect(chunk.validMin).toBe(0.0);
    expect(chunk.validMax).toBe(1000.0);
    expect(chunk.sliderMin).toBe(0.0);
    expect(chunk.sliderMax).toBe(100.0);

    const out = new BytesIO();
    chunk.write(out);
    expect(valueEquals(out.getvalue(), data)).toBe(true);
  });

  test("test_twod_roundtrip", () => {
    // SDK point layout (Fixed 16.16): value x/y, 3 reserved bytes,
    // restrict_bounds, then the default x/y in percent of the layer
    // size. Bytes of Bezier Warp's "Tangent 1/Circle Point" in sample
    // `effects_canvary.aep`: value (0.25, 0.4), default (25 %, 40 %).
    let body = bytes_.fromhex("0000400000006666000000000019000000280000");
    body = bytes_.concat(body, bytes_.zeros(92 - body.length));
    const data = _buildPard(6, body);
    const buf = new BytesIO(data);
    const chunk = asInstance(PardChunk.read(buf, data.length, { chunkType: "pard" }), TwoDPardChunk);
    expect(chunk instanceof TwoDPardChunk).toBe(true);
    expect(chunk.lastValueXRaw).toBe(0x4000);
    expect(chunk.lastValueYRaw).toBe(0x6666);
    expect(valueEquals(chunk.default_, [25.0, 40.0])).toBe(true);

    const out = new BytesIO();
    chunk.write(out);
    expect(valueEquals(out.getvalue(), data)).toBe(true);
  });

  test("test_threed_roundtrip", () => {
    // SDK 3D point layout: f8 value x/y/z then f8 default x/y/z in
    // percent of the layer size (sample `geometry_probe.aep`).
    let body = struct.pack(">6d", 0.5, 0.5, 0.0, 50.0, 50.0, 0.0);
    body = bytes_.concat(body, bytes_.zeros(92 - body.length));
    const data = _buildPard(18, body);
    const buf = new BytesIO(data);
    const chunk = asInstance(PardChunk.read(buf, data.length, { chunkType: "pard" }), ThreeDPardChunk);
    expect(chunk instanceof ThreeDPardChunk).toBe(true);
    expect(chunk.lastValueXRaw).toBe(0.5);
    expect(chunk.lastValueYRaw).toBe(0.5);
    expect(chunk.lastValueZRaw).toBe(0.0);
    expect(valueEquals(chunk.default_, [50.0, 50.0, 0.0])).toBe(true);

    const out = new BytesIO();
    chunk.write(out);
    expect(valueEquals(out.getvalue(), data)).toBe(true);
  });

  test("test_raw_name_preserved", () => {
    // Garbage bytes after null terminator in name field are preserved.
    const rawName = bytes_.concat(b("Opacity\x00olor"), bytes_.zeros(20));
    expect(rawName.length).toBe(32);

    const padPre = bytes_.zeros(15);
    const ct = struct.pack(">B", 3);
    const padPost = bytes_.zeros(8);
    const bodyAfter = struct.pack(">i", 90);
    const data = bytes_.concat(padPre, ct, rawName, padPost, bodyAfter);

    const buf = new BytesIO(data);
    const chunk = PardChunk.read(buf, data.length, { chunkType: "pard" });
    expect(chunk instanceof AnglePardChunk).toBe(true);
    expect(chunk.name).toBe("Opacity");

    const out = new BytesIO();
    chunk.write(out);
    expect(valueEquals(out.getvalue(), data)).toBe(true);
  });

  test("test_unknown_control_type_fallback", () => {
    const data = _buildPard(99, bytes_.zeros(10));
    const buf = new BytesIO(data);
    const chunk = PardChunk.read(buf, data.length, { chunkType: "pard" });
    expect(chunk.constructor).toBe(PardChunk);
    expect(valueEquals(chunk.data, data)).toBe(true);
  });

  test("test_generic_pard_roundtrip", () => {
    // All 7 generic control types dispatch to GenericPardChunk and round-trip.
    for (const ct of [0, 9, 11, 12, 13, 14, 15]) {
      const body = Uint8Array.from({ length: 92 }, (_, i) => i); // non-trivial 92-byte body
      const data = _buildPard(ct, body);
      assert(data.length === 148, `type ${ct}: expected 148, got ${data.length}`);

      const buf = new BytesIO(data);
      const chunk = PardChunk.read(buf, data.length, { chunkType: "pard" });
      assert(
        chunk instanceof GenericPardChunk,
        `type ${ct}: expected GenericPardChunk, got ${chunk.constructor.name}`,
      );
      expect(chunk.propertyControlType).toBe(ct);

      const out = new BytesIO();
      chunk.write(out);
      assert(valueEquals(out.getvalue(), data), `type ${ct}: round-trip mismatch`);
    }
  });

  test("test_generic_pard_name_access", () => {
    // GenericPardChunk exposes the name from the raw header.
    const body = bytes_.zeros(92);
    const data = _buildPard(13, body, "Master");
    const buf = new BytesIO(data);
    const chunk = PardChunk.read(buf, data.length, { chunkType: "pard" });
    expect(chunk instanceof GenericPardChunk).toBe(true);
    expect(chunk.name).toBe("Master");
  });
});

/** Marker header: duration = u4 at 0x08 / u4 at 0x0C. */
describe("TestNmhdChunk", () => {
  test("test_duration_divisor", () => {
    // AE 2026 opens a marker storing 36 over 24 with duration 1.5 s.
    const data = bytes_.fromhex("0000000400000000000000240000001800000000");
    const chunk = asInstance(NmhdChunk.frombytes(data, { chunkType: "NmHd" }), NmhdChunk);
    expect(chunk.durationSeconds).toBe(1.5);
    expect(valueEquals(chunk.tobytes(), data)).toBe(true);
  });

  test("test_zero_divisor_reads_as_600ths", () => {
    // AE 2026 opens a marker storing 1500 over 0 with duration 2.5 s.
    const data = bytes_.fromhex("0000000000000000000005dc0000000000000000");
    expect(asInstance(NmhdChunk.frombytes(data, { chunkType: "NmHd" }), NmhdChunk).durationSeconds).toBe(2.5);
  });

  test("test_set_duration_writes_600ths", () => {
    // AE 2026 rewrites a 36-over-24 marker whose duration a script sets
    // to 1.25 s as 750 over 600.
    const data = bytes_.fromhex("0000000400000000000000240000001800000000");
    const chunk = asInstance(NmhdChunk.frombytes(data, { chunkType: "NmHd" }), NmhdChunk);
    chunk.durationSeconds = 1.25;
    expect(valueEquals(bytes_.slice(chunk.tobytes(), 8, 16), bytes_.fromhex("000002ee00000258"))).toBe(true);
  });

  test("test_new_chunk_divisor", () => {
    // Every marker a script creates in AE 2026 stores divisor 600.
    expect(valueEquals(bytes_.slice(new NmhdChunk({}).tobytes(), 12, 16), bytes_.fromhex("00000258"))).toBe(true);
  });
});

// -----------------------------------------------------------------------
// Group 17: ldat_chunks - Lhd3Chunk
// -----------------------------------------------------------------------

describe("TestLhd3Chunk", () => {
  function _buildLhd3(
    count: number,
    itemSize: number,
    itemTypeRaw: number,
    version = 1,
    nextId = 2,
    trailing: Uint8Array = bytes_.zeros(20),
  ): Uint8Array {
    return bytes_.concat(
      bytes_.zeros(10),
      struct.pack(">H", count),
      bytes_.zeros(6),
      struct.pack(">H", itemSize),
      bytes_.zeros(3),
      struct.pack(">B", itemTypeRaw),
      struct.pack(">II", version, nextId),
      trailing,
    );
  }

  test("test_roundtrip_basic", () => {
    const data = _buildLhd3(5, 48, 4);
    const buf = new BytesIO(data);
    const chunk = asInstance(Lhd3Chunk.read(buf, data.length, { chunkType: "lhd3" }), Lhd3Chunk);
    expect(chunk.count).toBe(5);
    expect(chunk.itemSize).toBe(48);
    expect(chunk.itemTypeRaw).toBe(4);
    expect(chunk.itemType).toBe(LdatItemType.one_d);

    const out = new BytesIO();
    chunk.write(out);
    expect(valueEquals(out.getvalue(), data)).toBe(true);
  });

  test("test_item_type_dispatch", () => {
    const cases: [number, number, number][] = [
      [1, 2246, LdatItemType.lrdr],
      [1, 128, LdatItemType.litm],
      [2, 16, LdatItemType.gide],
      [4, 152, LdatItemType.color],
      [4, 128, LdatItemType.three_d],
      [4, 104, LdatItemType.two_d_spatial],
      [4, 88, LdatItemType.two_d],
      [4, 80, LdatItemType.orientation],
      [4, 64, LdatItemType.no_value],
      [4, 48, LdatItemType.one_d],
      [4, 16, LdatItemType.marker],
      [4, 8, LdatItemType.shape],
    ];
    for (const [raw, size, expected] of cases) {
      const data = _buildLhd3(1, size, raw);
      const chunk = asInstance(Lhd3Chunk.frombytes(data, { chunkType: "lhd3" }), Lhd3Chunk);
      assert(chunk.itemType === expected, `(${raw}, ${size})`);
    }
  });

  test("test_unknown_fallback", () => {
    const data = _buildLhd3(1, 999, 99);
    const chunk = asInstance(Lhd3Chunk.frombytes(data, { chunkType: "lhd3" }), Lhd3Chunk);
    expect(chunk.itemType).toBe(LdatItemType.unknown);
  });

  test("test_with_trailing", () => {
    const trailing = b("\xab\xcd");
    const data = _buildLhd3(2, 64, 4, 1, 2, trailing);
    const chunk = asInstance(Lhd3Chunk.frombytes(data, { chunkType: "lhd3" }), Lhd3Chunk);
    expect(valueEquals(chunk._trailing, trailing)).toBe(true);
    expect(valueEquals(chunk.tobytes(), data)).toBe(true);
  });
});

// -----------------------------------------------------------------------
// Group 18: ldat_chunks - ShapePoint / GuideItem
// -----------------------------------------------------------------------

describe("TestShapePoint", () => {
  test("test_roundtrip", () => {
    const data = struct.pack(">ff", 1.5, -2.5);
    const sp = ShapePoint.frombytes(data);
    expect(approx(sp.x, 1.5)).toBe(true);
    expect(approx(sp.y, -2.5)).toBe(true);
    expect(valueEquals(sp.tobytes(), data)).toBe(true);
  });
});

describe("TestGuideItem", () => {
  test("test_roundtrip", () => {
    const data = struct.pack(">IId", 1, 0, 123.456);
    const gi = GuideItem.frombytes(data);
    expect(gi.orientationType).toBe(1);
    expect(gi.positionType).toBe(0);
    expect(approx(gi.position, 123.456)).toBe(true);
    expect(valueEquals(gi.tobytes(), data)).toBe(true);
  });
});

// -----------------------------------------------------------------------
// Group 19: ldat_chunks - KfNoValue
// -----------------------------------------------------------------------

describe("TestKfNoValue", () => {
  test("test_roundtrip", () => {
    const data = struct.pack(">Qddddd", 42, 1.0, 2.0, 33.3, 4.0, 66.6);
    const kf = KfNoValue.frombytes(data);
    expect(approx(kf.inSpeed, 2.0)).toBe(true);
    expect(approx(kf.inInfluence, 33.3)).toBe(true);
    expect(approx(kf.outSpeed, 4.0)).toBe(true);
    expect(approx(kf.outInfluence, 66.6)).toBe(true);
    expect(valueEquals(kf.tobytes(), data)).toBe(true);
  });
});

// -----------------------------------------------------------------------
// Group 20: ldat_chunks - KfColor
// -----------------------------------------------------------------------

describe("TestKfColor", () => {
  test("test_roundtrip", () => {
    let vals: number[] = [0, 0.0, 1.0, 33.3, 2.0, 66.6, 0.5, 0.6, 0.7, 1.0];
    vals = [...vals, ...Array.from({ length: 8 }, () => 0.0)];
    const data = struct.pack(">Qd" + "d".repeat(16), ...vals);
    const kf = KfColor.frombytes(data);
    expect(approx(kf.inSpeed, 1.0)).toBe(true);
    expect(approx(kf.inInfluence, 33.3)).toBe(true);
    expect(approx(kf.outSpeed, 2.0)).toBe(true);
    expect(approx(kf.outInfluence, 66.6)).toBe(true);
    expect(approx(kf.value, [0.5, 0.6, 0.7, 1.0])).toBe(true);
    expect(valueEquals(kf.tobytes(), data)).toBe(true);
  });

  test("test_channels_are_stored_argb", () => {
    // A colour keyframe stores alpha first (0-255 units): the opaque
    // pure blue AE keys on an effect colour reads 255, 0, 0, 255.
    let vals: number[] = [0, 0.0, 0.0, 16.0, 0.0, 16.0, 255.0, 0.0, 0.0, 255.0];
    vals = [...vals, ...Array.from({ length: 8 }, () => 0.0)];
    const data = struct.pack(">Qd" + "d".repeat(16), ...vals);
    const kf = KfColor.frombytes(data);
    expect(valueEquals([kf.a, kf.r, kf.g, kf.b], [255.0, 0.0, 0.0, 255.0])).toBe(true);
  });
});

// -----------------------------------------------------------------------
// Group 21: ldat_chunks - KfMultiDimensional
// -----------------------------------------------------------------------

describe("TestKfMultiDimensional", () => {
  test("test_1d_roundtrip", () => {
    // 5 doubles: value, in_speed, in_influence, out_speed, out_influence
    const data = struct.pack(">ddddd", 100.0, 1.0, 33.3, 2.0, 66.6);
    const kf = KfMultiDimensional.frombytes(data, { numValue: 1 });
    expect(approx(kf.value, [100.0])).toBe(true);
    expect(approx(kf.inSpeed, [1.0])).toBe(true);
    expect(approx(kf.inInfluence, [33.3])).toBe(true);
    expect(approx(kf.outSpeed, [2.0])).toBe(true);
    expect(approx(kf.outInfluence, [66.6])).toBe(true);
    expect(valueEquals(kf.tobytes(), data)).toBe(true);
  });

  test("test_3d_roundtrip", () => {
    // 15 doubles for 3D
    const raw = Array.from({ length: 15 }, (_, x) => x);
    const data = struct.pack(">" + "d".repeat(15), ...raw);
    const kf = KfMultiDimensional.frombytes(data, { numValue: 3 });
    expect(kf.value.length).toBe(3);
    expect(kf.inSpeed.length).toBe(3);
    expect(valueEquals(kf.tobytes(), data)).toBe(true);
  });
});

// -----------------------------------------------------------------------
// Group 22: ldat_chunks - KfPosition
// -----------------------------------------------------------------------

describe("TestKfPosition", () => {
  test("test_2d_roundtrip", () => {
    // 3B pad + 1B flags + 4B pad + (5 + 3*2) f8 = 8 + 88 = 96 bytes
    const flags = 0b00000011; // spatial_auto_bezier + spatial_continuous
    const prefix = bytes_.concat(bytes_.zeros(3), struct.pack(">B", flags), bytes_.zeros(4));
    // 11 doubles: header, in_speed, in_inf, out_speed, out_inf,
    //   val[0], val[1], in_tang[0], in_tang[1], out_tang[0], out_tang[1]
    const doubles = [0.0, 1.0, 33.3, 2.0, 66.6, 10.0, 20.0, 0.1, 0.2, -0.1, -0.2];
    const data = bytes_.concat(prefix, struct.pack(">" + "d".repeat(11), ...doubles));

    const kf = KfPosition.frombytes(data, { numValue: 2 });
    expect(truthy(kf.spatialAutoBezier)).toBe(true);
    expect(truthy(kf.spatialContinuous)).toBe(true);
    expect(approx(kf.inSpeed, 1.0)).toBe(true);
    expect(approx(kf.inInfluence, 33.3)).toBe(true);
    expect(approx(kf.value, [10.0, 20.0])).toBe(true);
    expect(approx(kf.inSpatialTangents, [0.1, 0.2])).toBe(true);
    expect(approx(kf.outSpatialTangents, [-0.1, -0.2])).toBe(true);
    expect(valueEquals(kf.tobytes(), data)).toBe(true);
  });

  test("test_3d_roundtrip", () => {
    const prefix = bytes_.zeros(8);
    // 5 + 3*3 = 14 doubles
    const doubles = Array.from({ length: 14 }, (_, x) => x);
    const data = bytes_.concat(prefix, struct.pack(">" + "d".repeat(14), ...doubles));
    const kf = KfPosition.frombytes(data, { numValue: 3 });
    expect(kf.value.length).toBe(3);
    expect(kf.inSpatialTangents.length).toBe(3);
    expect(kf.outSpatialTangents.length).toBe(3);
    expect(valueEquals(kf.tobytes(), data)).toBe(true);
  });
});

// -----------------------------------------------------------------------
// Group 23: ldat_chunks - LdatItem
// -----------------------------------------------------------------------

describe("TestLdatItem", () => {
  function _buildItem(
    itemType: number,
    timeUnits = 0,
    inInterp = 2,
    outInterp = 2,
    label = 0,
    flags = 0,
    payload: Uint8Array = b(""),
  ): Uint8Array {
    return bytes_.concat(
      struct.pack(">i", timeUnits),
      struct.pack(">BBBB", inInterp, outInterp, label, flags),
      payload,
    );
  }

  test("test_1d_roundtrip", () => {
    // 5 doubles for 1D multidimensional
    const payload = struct.pack(">ddddd", 50.0, 1.0, 33.3, 2.0, 66.6);
    let data = _buildItem(LdatItemType.one_d, 30 * 256, 2, 1);
    data = bytes_.concat(data, payload);
    // total = 8 header + 40 payload = 48

    const item = LdatItem.frombytes(data, { itemType: LdatItemType.one_d });
    expect(item.timeUnits).toBe(30 * 256);
    expect(item.inInterpolationType).toBe(2);
    expect(item.outInterpolationType).toBe(1);
    expect(approx(asInstance(item.kfData, KfMultiDimensional).value, [50.0])).toBe(true);
    expect(valueEquals(item.tobytes(), data)).toBe(true);
  });

  test("test_color_roundtrip", () => {
    // 144 bytes for KfColor (18 doubles)
    const doubles = [0, 0.0, 1.0, 33.3, 2.0, 66.6, 0.5, 0.6, 0.7, 1.0, ...Array.from({ length: 8 }, () => 0.0)];
    const payload = struct.pack(">Qd" + "d".repeat(16), ...doubles);
    const data = bytes_.concat(_buildItem(LdatItemType.color), payload);

    const item = LdatItem.frombytes(data, { itemType: LdatItemType.color });
    expect(approx(asInstance(item.kfData, KfColor).value, [0.5, 0.6, 0.7, 1.0])).toBe(true);
    expect(valueEquals(item.tobytes(), data)).toBe(true);
  });

  test("test_temporal_flags", () => {
    // roving=bit5 (0x20), temporal_auto_bezier=bit4 (0x10)
    const flags = 0x30;
    const payload = struct.pack(">Qddddd", 0, 0.0, 0.0, 0.0, 0.0, 0.0);
    const data = bytes_.concat(_buildItem(LdatItemType.no_value, 0, 2, 2, 0, flags), payload);

    const item = LdatItem.frombytes(data, { itemType: LdatItemType.no_value });
    expect(truthy(item.roving)).toBe(true);
    expect(truthy(item.temporalAutoBezier)).toBe(true);
    expect(!truthy(item.temporalContinuous)).toBe(true);
    expect(valueEquals(item.tobytes(), data)).toBe(true);
  });

  test("test_label_is_bits_6_to_10_of_key_flags", () => {
    // Bytes 6-7 are one big-endian u2 of key flags, the label in bits
    // 6-10: After Effects stores labels 1 / 5 / 16 as 00 40 / 01 40 / 04 00
    // (keyframe_labels.aep).
    const payload = struct.pack(">Qddddd", 0, 0.0, 0.0, 0.0, 0.0, 0.0);
    for (const [raw, label] of [
      [b("\x00\x40"), 1],
      [b("\x01\x40"), 5],
      [b("\x04\x00"), 16],
    ] satisfies [Uint8Array, number][]) {
      const data = bytes_.concat(struct.pack(">iBB", 0, 2, 2), raw, payload);
      const item = LdatItem.frombytes(data, { itemType: LdatItemType.no_value });
      expect(item.label).toBe(label);
      expect(valueEquals(item.tobytes(), data)).toBe(true);
    }
  });

  test("test_label_write_keeps_the_other_flag_bits", () => {
    // bits 0-2 plus continuous / auto-bezier / roving (bits 3-5) set
    const payload = struct.pack(">Qddddd", 0, 0.0, 0.0, 0.0, 0.0, 0.0);
    const data = bytes_.concat(struct.pack(">iBB", 0, 2, 2), b("\x00\x3f"), payload);
    const item = LdatItem.frombytes(data, { itemType: LdatItemType.no_value });

    item.label = 16;
    expect(valueEquals(bytes_.slice(item.tobytes(), 6, 8), b("\x04\x3f"))).toBe(true);
    item.label = 5;
    expect(valueEquals(bytes_.slice(item.tobytes(), 6, 8), b("\x01\x7f"))).toBe(true);
    expect(truthy(item.roving)).toBe(true);
    expect(truthy(item.temporalAutoBezier)).toBe(true);
    expect(truthy(item.temporalContinuous)).toBe(true);
    item.label = 0;
    expect(valueEquals(item.tobytes(), data)).toBe(true);
  });

  test("test_marker_raw_bytes", () => {
    const payload = b("\x01\x02\x03\x04\x05\x06\x07\x08");
    const data = bytes_.concat(_buildItem(LdatItemType.marker), payload);
    const item = LdatItem.frombytes(data, { itemType: LdatItemType.marker });
    expect(valueEquals(item.kfData, payload)).toBe(true);
    expect(valueEquals(item.tobytes(), data)).toBe(true);
  });
});

// -----------------------------------------------------------------------
// Group 24: ldat_chunks - LdatChunk
// -----------------------------------------------------------------------

describe("TestLdatChunk", () => {
  test("test_shape_roundtrip", () => {
    let itemsData: Uint8Array = b("");
    for (let i = 0; i < 3; i++) {
      itemsData = bytes_.concat(itemsData, struct.pack(">ff", i, i + 1));
    }
    const buf = new BytesIO(itemsData);
    const chunk = LdatChunk.read(buf, itemsData.length, {
      chunkType: "ldat",
      itemType: LdatItemType.shape,
      itemSize: 8,
      count: 3,
    });
    expect(chunk.items.length).toBe(3);
    expect(chunk.items[0] instanceof ShapePoint).toBe(true);
    expect(approx(chunk.items[0].x, 0.0)).toBe(true);
    expect(approx(chunk.items[2].y, 3.0)).toBe(true);

    const out = new BytesIO();
    chunk.write(out);
    expect(valueEquals(out.getvalue(), itemsData)).toBe(true);
  });

  test("test_guide_roundtrip", () => {
    const itemsData = bytes_.concat(struct.pack(">IId", 1, 0, 50.0), struct.pack(">IId", 2, 0, 100.0));
    const buf = new BytesIO(itemsData);
    const chunk = LdatChunk.read(buf, itemsData.length, {
      chunkType: "ldat",
      itemType: LdatItemType.gide,
      itemSize: 16,
      count: 2,
    });
    expect(chunk.items.length).toBe(2);
    expect(chunk.items[0] instanceof GuideItem).toBe(true);
    expect(approx(chunk.items[0].position, 50.0)).toBe(true);
    expect(chunk.items[1].orientationType).toBe(2);

    const out = new BytesIO();
    chunk.write(out);
    expect(valueEquals(out.getvalue(), itemsData)).toBe(true);
  });

  test("test_1d_keyframe_roundtrip", () => {
    // Build one item: 8B header + 40B payload = 48B
    const header = bytes_.concat(
      b("\x00"),
      struct.pack(">h", 15),
      b("\x00"),
      struct.pack(">BBBB", 2, 2, 0, 0),
    );
    const payload = struct.pack(">ddddd", 100.0, 1.0, 33.3, 2.0, 66.6);
    const itemData = bytes_.concat(header, payload);
    expect(itemData.length).toBe(48);

    const buf = new BytesIO(itemData);
    const chunk = LdatChunk.read(buf, 48, {
      chunkType: "ldat",
      itemType: LdatItemType.one_d,
      itemSize: 48,
      count: 1,
    });
    expect(chunk.items.length).toBe(1);
    expect(chunk.items[0] instanceof LdatItem).toBe(true);
    expect(chunk.items[0].timeUnits).toBe(15 * 256);
    expect(approx(chunk.items[0].kfData.value, [100.0])).toBe(true);

    const out = new BytesIO();
    chunk.write(out);
    expect(valueEquals(out.getvalue(), itemData)).toBe(true);
  });

  test("test_empty_fallback", () => {
    const data = b("\xaa\xbb\xcc");
    const buf = new BytesIO(data);
    const chunk = LdatChunk.read(buf, 3, {
      chunkType: "ldat",
      itemType: LdatItemType.unknown,
      itemSize: 0,
      count: 0,
    });
    expect(valueEquals(chunk.items, [])).toBe(true);
    expect(valueEquals(chunk.data, data)).toBe(true);

    const out = new BytesIO();
    chunk.write(out);
    expect(valueEquals(out.getvalue(), data)).toBe(true);
  });

  test("test_spatial_promotion", () => {
    // Build one 3D spatial item: 8B header + 8B prefix + (5+3*3)*8 = 128B
    const header = bytes_.concat(b("\x00"), struct.pack(">h", 0), b("\x00"), b("\x02\x02\x00\x00"));
    const prefix = b("\x00\x00\x00\x00\x00\x00\x00\x00");
    const doubles = Array.from({ length: 14 }, (_, x) => x);
    const payload = bytes_.concat(prefix, struct.pack(">" + "d".repeat(14), ...doubles));
    const itemData = bytes_.concat(header, payload);
    expect(itemData.length).toBe(128);

    const buf = new BytesIO(itemData);
    const chunk = LdatChunk.read(buf, 128, {
      chunkType: "ldat",
      itemType: LdatItemType.three_d,
      itemSize: 128,
      count: 1,
      isSpatial: true,
    });
    expect(chunk.itemType).toBe(LdatItemType.three_d_spatial);
    expect(chunk.items[0].kfData.value.length).toBe(3);

    const out = new BytesIO();
    chunk.write(out);
    expect(valueEquals(out.getvalue(), itemData)).toBe(true);
  });
});

// -----------------------------------------------------------------------
// Group 25: ldat context resolver
// -----------------------------------------------------------------------

describe("TestLdatContextResolver", () => {
  test("test_with_lhd3_sibling", () => {
    const lhd3 = new Lhd3Chunk({
      chunkType: "lhd3",
      count: 3,
      countB: 3,
      itemSize: 48,
      gap2: b("\x00\x00\x00"),
      itemTypeRaw: 4,
    });
    const ctx = new ReadContext();
    const result = _resolveLdatContext([lhd3], ctx);
    expect(result.itemType).toBe(LdatItemType.one_d);
    expect(result.itemSize).toBe(48);
    expect(result.count).toBe(3);
  });

  test("test_spatial_promotion_context", () => {
    const lhd3 = new Lhd3Chunk({
      chunkType: "lhd3",
      count: 1,
      countB: 1,
      itemSize: 128,
      gap2: b("\x00\x00\x00"),
      itemTypeRaw: 4,
    });
    const tdb4 = new Tdb4Chunk({ chunkType: "tdb4" });
    tdb4.isSpatial = true;
    const parentSiblings: Chunk[] = [new Chunk({}), new Chunk({}), tdb4];
    const ctx = new ReadContext("", "tdbs", parentSiblings);
    const result = _resolveLdatContext([lhd3], ctx);
    expect(result.isSpatial).toBe(true);
  });

  test("test_raw_sibling_fallback", () => {
    const ctx = new ReadContext();
    const result = _resolveLdatContext([new Chunk({ chunkType: "lhd3", data: bytes_.zeros(24) })], ctx);
    expect(result).toEqual({});
  });
});

// -----------------------------------------------------------------------
// Group 9: Synthetic flag
// -----------------------------------------------------------------------

describe("TestSyntheticFlag", () => {
  test("test_default_false", () => {
    const c = new Chunk({ chunkType: "tdsb" });
    expect(c.synthetic).toBe(false);
  });

  test("test_explicit_true", () => {
    const c = new Chunk({ chunkType: "tdsb", synthetic: true });
    expect(c.synthetic).toBe(true);
  });

  test("test_list_chunk_skips_synthetic_children", () => {
    const real = new Chunk({ chunkType: "aaaa", data: b("\x01") });
    const synth = new Chunk({ chunkType: "bbbb", data: b("\x02"), synthetic: true });
    const lst = new ListChunk({ listType: "test", chunks: [real, synth] });
    const buf = new BytesIO();
    writeChunk(buf, lst);
    const raw = buf.getvalue();
    // Body = list_type (4) + header+body of real child only
    // Real child: header (8) + body (1) + pad (1)
    expect(bytes_.contains(raw, b("\x01"))).toBe(true);
    expect(bytes_.contains(raw, b("\x02"))).toBe(false);
  });

  test("test_container_chunk_skips_synthetic_children", () => {
    const real = new Chunk({ chunkType: "cccc", data: b("\x03") });
    const synth = new Chunk({ chunkType: "dddd", data: b("\x04"), synthetic: true });
    const cont = new ContainerChunk({ chunkType: "tdsn", chunks: [real, synth] });
    const buf = new BytesIO();
    writeChunk(buf, cont);
    const raw = buf.getvalue();
    expect(bytes_.contains(raw, b("\x03"))).toBe(true);
    expect(bytes_.contains(raw, b("\x04"))).toBe(false);
  });

  test("test_synthetic_not_in_repr", () => {
    const c = new Chunk({ chunkType: "test", synthetic: true });
    expect(repr(c).includes("synthetic")).toBe(false);
  });
});

// -----------------------------------------------------------------------
// Group 10: fmt_field defaults on property chunks
// -----------------------------------------------------------------------

describe("TestPropertyChunkDefaults", () => {
  test("test_tdsb_enabled_by_default", () => {
    const tdsb = new TdsbChunk({});
    expect(valueEquals(tdsb.enabled, 1)).toBe(true);
  });

  test("test_tdb4_dimensions_default_one", () => {
    const tdb4 = new Tdb4Chunk({});
    expect(tdb4.dimensions).toBe(1);
  });

  test("test_tdb4_static_default_true", () => {
    const tdb4 = new Tdb4Chunk({});
    expect(valueEquals(tdb4.static, 1)).toBe(true);
  });

  test("test_tdb4_expression_disabled_default_false", () => {
    const tdb4 = new Tdb4Chunk({});
    expect(valueEquals(tdb4.expressionDisabled, 0)).toBe(true);
  });

  test("test_tdb4_bare_constructor_roundtrips", () => {
    const tdb4 = new Tdb4Chunk({});
    const raw = tdb4.tobytes();
    const restored = asInstance(Tdb4Chunk.frombytes(raw, { chunkType: "tdb4" }), Tdb4Chunk);
    expect(valueEquals(restored.dimensions, tdb4.dimensions)).toBe(true);
    expect(valueEquals(restored.static, tdb4.static)).toBe(true);
    expect(valueEquals(restored.expressionDisabled, tdb4.expressionDisabled)).toBe(true);
  });

  test("test_tdsb_bare_constructor_roundtrips", () => {
    const tdsb = new TdsbChunk({});
    const raw = tdsb.tobytes();
    const restored = asInstance(TdsbChunk.frombytes(raw, { chunkType: "tdsb" }), TdsbChunk);
    expect(valueEquals(restored.enabled, tdsb.enabled)).toBe(true);
  });
});

// -----------------------------------------------------------------------
// Group 11: Mutation helpers
// -----------------------------------------------------------------------

describe("TestMutationHelpers", () => {
  test("test_find_by_type_found", () => {
    const a = new Chunk({ chunkType: "aaaa" });
    const b = new Chunk({ chunkType: "bbbb" });
    expect(findByType([a, b], "bbbb")).toBe(b);
  });

  test("test_find_by_type_not_found", () => {
    raises(ChunkNotFoundError, () => findByType([new Chunk({ chunkType: "aaaa" })], "zzzz"));
  });

  test("test_find_by_type_empty", () => {
    raises(ChunkNotFoundError, () => findByType([], "aaaa"));
  });

  test("test_remove_chunks_by_type", () => {
    const chunks: Chunk[] = [
      new Chunk({ chunkType: "aaaa" }),
      new Chunk({ chunkType: "bbbb" }),
      new Chunk({ chunkType: "aaaa" }),
      new Chunk({ chunkType: "cccc" }),
    ];
    removeChunksByType(chunks, "aaaa");
    expect(chunks.length).toBe(2);
    expect(chunks.every((c) => c.chunkType !== "aaaa")).toBe(true);
  });

  test("test_remove_chunks_by_type_none_found", () => {
    const chunks: Chunk[] = [new Chunk({ chunkType: "aaaa" })];
    removeChunksByType(chunks, "zzzz");
    expect(chunks.length).toBe(1);
  });

  test("test_toggle_flag_chunk_enable", () => {
    const chunks: Chunk[] = [];
    toggleFlagChunk(chunks, "lnrb", true, () => new Chunk({ chunkType: "lnrb", data: b("\x01") }));
    expect(chunks.length).toBe(1);
    expect(chunks[0].chunkType).toBe("lnrb");
  });

  test("test_toggle_flag_chunk_disable", () => {
    const chunks: Chunk[] = [new Chunk({ chunkType: "lnrb", data: b("\x01") })];
    toggleFlagChunk(chunks, "lnrb", false, () => new Chunk({ chunkType: "lnrb", data: b("\x01") }));
    expect(chunks.length).toBe(0);
  });

  test("test_toggle_flag_chunk_enable_idempotent", () => {
    const chunks: Chunk[] = [new Chunk({ chunkType: "lnrb", data: b("\x01") })];
    toggleFlagChunk(chunks, "lnrb", true, () => new Chunk({ chunkType: "lnrb", data: b("\x01") }));
    expect(chunks.length).toBe(1);
  });

  test("test_toggle_flag_chunk_disable_idempotent", () => {
    const chunks: Chunk[] = [];
    toggleFlagChunk(chunks, "lnrb", false, () => new Chunk({ chunkType: "lnrb", data: b("\x01") }));
    expect(chunks.length).toBe(0);
  });

  test("test_unflag_markers_both_sides", () => {
    const pre = new Chunk({ chunkType: "tdmn", synthetic: true });
    const target = new ListChunk({ listType: "tdbs", synthetic: true });
    const post = new Chunk({ chunkType: "tdmn", synthetic: true });
    const parentChunks: Chunk[] = [pre, target, post];
    _unflagMarkers(parentChunks, target);
    expect(pre.synthetic).toBe(false);
    expect(post.synthetic).toBe(false);
  });

  test("test_unflag_markers_no_adjacent_tdmn", () => {
    const target = new ListChunk({ listType: "tdbs", synthetic: true });
    const other = new Chunk({ chunkType: "xxxx", synthetic: true });
    const parentChunks: Chunk[] = [other, target];
    _unflagMarkers(parentChunks, target);
    // other is not a tdmn, so its synthetic flag stays unchanged
    expect(other.synthetic).toBe(true);
  });

  test("test_unflag_markers_target_not_found", () => {
    const target = new ListChunk({ listType: "tdbs", synthetic: true });
    const other = new Chunk({ chunkType: "tdmn", synthetic: true });
    _unflagMarkers([other], target);
    // target not in list, nothing should change
    expect(other.synthetic).toBe(true);
  });
});
