/**
 * Tests for name containers as older projects write them (AE CC 12.0).
 *
 * Newer projects wrap a `tdsn`, `fnam`, `pdnm` or `RCom` string in a `Utf8`
 * child; older ones write the NUL-terminated string itself, in a buffer of
 * its own size (a `tdsn` of a lone zero byte, a 48-byte `fnam`).
 */

import { expect, test } from "bun:test";
import "../../src/py_aep/binary/_register.ts";
import * as py_aep from "../../src/py_aep/index.ts";
import { type Chunk, ContainerChunk, ListChunk, readChunks, writeAep, writeChunk } from "../../src/py_aep/binary/chunk.ts";
import { HeadChunk, NhedChunk } from "../../src/py_aep/binary/item_chunks.ts";
import { DwgaChunk } from "../../src/py_aep/binary/misc_chunks.ts";
import { TDSN_SENTINEL, TdsnChunk } from "../../src/py_aep/binary/property_chunks.ts";
import { Utf8Chunk } from "../../src/py_aep/binary/scalar_chunks.ts";
import { recursiveFind } from "../../src/py_aep/binary/utils.ts";
import { BitsPerChannel, GpuAccelType } from "../../src/py_aep/enums/index.ts";
import { RenderQueue } from "../../src/py_aep/models/renderqueue/render_queue.ts";
import { _nnhdFromNhed } from "../../src/py_aep/parsers/project.ts";
import { asInstance } from "../helpers.ts";
import {
  AttributeError,
  BytesIO,
  ValueError,
  b,
  Bytes,
  concat,
  decode,
  encode,
  len,
  truthy,
  valueEquals,
  range,
  struct,
} from "../../src/pyrt/index.ts";
import { makeTmpPath, raises } from "../../src/pyrt/pytest.ts";

function _chunk(chunkType: string, body: Uint8Array): Uint8Array {
  const pad = len(body) & 1 ? b("\x00") : b("");
  return concat(encode(chunkType, "ASCII"), struct.pack(">I", len(body)), body, pad);
}

function _read(data: Uint8Array): Chunk[] {
  return readChunks(new BytesIO(data), len(data));
}

function _write(chunks: Chunk[]): Uint8Array {
  const out = new BytesIO();
  for (const chunk of chunks) {
    writeChunk(out, chunk);
  }
  return out.getvalue();
}

test("test_a_one_byte_tdsn_does_not_swallow_the_next_chunk", () => {
  const data = concat(
    _chunk("tdsn", b("\x00")),
    _chunk("tdmn", Bytes.padEnd(b("ADBE Transform Group"), 40, 0)),
  );
  const chunks = _read(data);
  expect(valueEquals(chunks.map((c) => c.chunkType), ["tdsn", "tdmn"])).toBe(true);
  const tdsn = asInstance(chunks[0], TdsnChunk);
  expect(tdsn instanceof TdsnChunk).toBe(true);
  // An empty legacy name is an unnamed property.
  expect(valueEquals(tdsn.utf8.value, TDSN_SENTINEL)).toBe(true);
  expect(tdsn.utf8.synthetic).toBe(true);
  expect(valueEquals(_write(chunks), data)).toBe(true);
});

test("test_a_legacy_fnam_reads_its_string", () => {
  const body = Bytes.slice(
    concat(b("Color Control\x00ol\x00\x00"), Uint8Array.from(range(1, 32))),
    0,
    48,
  );
  const data = _chunk("fnam", body);
  const fnam = asInstance(_read(data)[0], ContainerChunk);
  expect(fnam instanceof ContainerChunk).toBe(true);
  const utf8 = asInstance(fnam.chunks[0], Utf8Chunk);
  expect(utf8 instanceof Utf8Chunk).toBe(true);
  expect(valueEquals(utf8.value, "Color Control")).toBe(true);
  // Written back byte for byte, stale bytes included.
  expect(valueEquals(_write([fnam]), data)).toBe(true);
});

test("test_a_renamed_legacy_fnam_keeps_its_buffer", () => {
  const body = Bytes.padEnd(b("Color Control"), 48, 0);
  const fnam = asInstance(_read(_chunk("fnam", body))[0], ContainerChunk);
  asInstance(fnam.chunks[0], Utf8Chunk).value = "Text Color";
  const written = _write([fnam]);
  expect(valueEquals(written, _chunk("fnam", Bytes.padEnd(b("Text Color"), 48, 0)))).toBe(true);
});

test("test_a_modern_fnam_is_unchanged", () => {
  const utf8 = _chunk("Utf8", b("Glow"));
  const data = _chunk("fnam", utf8);
  const fnam = asInstance(_read(data)[0], ContainerChunk);
  const child = asInstance(fnam.chunks[0], Utf8Chunk);
  expect(valueEquals(child.value, "Glow")).toBe(true);
  expect(child.synthetic).toBe(false);
  expect(valueEquals(fnam.data, b(""))).toBe(true);
  expect(valueEquals(_write([fnam]), data)).toBe(true);
});

test("test_nnhd_stands_in_from_nhed", () => {
  const nhed = new NhedChunk({});
  nhed.bitsPerChannel = 1;
  nhed.framesCountType = 1;
  nhed.timecodeDefaultBase = 25;
  const nnhd = _nnhdFromNhed(nhed);
  expect(nnhd.synthetic).toBe(true);
  expect(
    valueEquals(
      [nnhd.bitsPerChannel, nnhd.framesCountType, nnhd.timecodeDefaultBase],
      [1, 1, 25],
    ),
  ).toBe(true);
});

test("test_a_legacy_fnam_with_a_four_letter_name_reads_its_string", () => {
  // "Fill" then NUL padding also reads as a `Fill` header of length 0; the
  // NUL headers after it are not chunks.
  for (const name of [b("Fill"), b("Glow"), b("Tint"), b("Blur")]) {
    const data = _chunk("fnam", Bytes.padEnd(name, 48, 0));
    const fnam = asInstance(_read(data)[0], ContainerChunk);
    const utf8 = asInstance(fnam.chunks[0], Utf8Chunk);
    expect(valueEquals(utf8.value, decode(name))).toBe(true);
    expect(utf8.synthetic).toBe(true);
    expect(valueEquals(_write([fnam]), data)).toBe(true);
  }
});

test("test_a_renamed_one_byte_tdsn_grows_to_its_name", () => {
  const tdsn = asInstance(_read(_chunk("tdsn", b("\x00")))[0], TdsnChunk);
  tdsn.utf8.value = "My Name";
  expect(valueEquals(_write([tdsn]), _chunk("tdsn", b("My Name\x00")))).toBe(true);
});

test("test_a_renamed_legacy_tdsn_keeps_whole_characters", () => {
  const tdsn = asInstance(_read(_chunk("tdsn", b("abc\x00")))[0], TdsnChunk);
  tdsn.utf8.value = "abcdefé";
  expect(
    valueEquals(_write([tdsn]), _chunk("tdsn", concat(encode("abcdefé"), b("\x00")))),
  ).toBe(true);
});

test("test_a_legacy_tdsn_reset_to_unnamed_writes_the_empty_name", () => {
  const tdsn = asInstance(_read(_chunk("tdsn", b("Mask 1\x00")))[0], TdsnChunk);
  tdsn.utf8.value = TDSN_SENTINEL;
  expect(valueEquals(_write([tdsn]), _chunk("tdsn", b("\x00")))).toBe(true);
});

test("test_a_renamed_legacy_pdnm_grows_to_its_items", () => {
  const pdnm = asInstance(_read(_chunk("pdnm", b("On|Off\x00")))[0], ContainerChunk);
  asInstance(pdnm.chunks[0], Utf8Chunk).value = "On|Off|Auto";
  expect(valueEquals(_write([pdnm]), _chunk("pdnm", b("On|Off|Auto\x00")))).toBe(true);
});

test("test_a_legacy_fnam_too_long_for_its_buffer_raises", () => {
  const fnam = asInstance(_read(_chunk("fnam", Bytes.padEnd(b("Glow"), 48, 0)))[0], ContainerChunk);
  asInstance(fnam.chunks[0], Utf8Chunk).value = "x".repeat(48);
  raises(ValueError, () => {
    _write([fnam]);
  }, "48-byte fnam");
});

/**
 * A project with the stand-ins a CC 12.0 one parses with: no nnhd or
 * dwga, a head of AE 12.
 */
function _asCc12Project(): py_aep.Project {
  const project = py_aep.newProject("15.0x1").project;
  project._nnhd = _nnhdFromNhed(project._nhed);
  project._dwga = new DwgaChunk({ synthetic: true });
  // @ts-expect-error SimpleNamespace stand-in for the head chunk
  project._head = { aeVersionMajor: 12 };
  return project;
}

test("test_cc12_settings_synced_to_nhed_write_through", () => {
  const project = _asCc12Project();
  project.bitsPerChannel = BitsPerChannel.SIXTEEN;
  expect(project.bitsPerChannel).toBe(BitsPerChannel.SIXTEEN);
  expect(project._nhed.bitsPerChannel).toBe(project._nnhd.bitsPerChannel);
  expect(project._nnhd.synthetic).toBe(true);
});

test("test_cc12_working_gamma_has_nowhere_to_go_and_raises", () => {
  const project = _asCc12Project();
  raises(AttributeError, () => {
    project.workingGamma = 2.4;
  }, "requires AE 13");
});

test("test_cc12_timecode_default_base_synced_to_nhed", () => {
  const project = _asCc12Project();
  project._timecodeDefaultBase = 60;
  expect(project._nhed.timecodeDefaultBase).toBe(60);
});

test("test_cc12_timecode_default_base_above_u1_raises", () => {
  const project = _asCc12Project();
  raises(ValueError, () => {
    project._timecodeDefaultBase = 300;
  });
  expect(project._nhed.timecodeDefaultBase).toBe(30);
});

test("test_gpu_accel_type_software_without_gpug", () => {
  const project = _asCc12Project();
  project._gpugUtf8 = new Utf8Chunk({
    value: GpuAccelType.toBinary(GpuAccelType.SOFTWARE),
    synthetic: true,
  });
  expect(project.gpuAccelType).toBe(GpuAccelType.SOFTWARE);
});

function _olderProjectBytes(nameChunks: Chunk[], fileFormatVersion: number): Uint8Array {
  const head = new HeadChunk({ chunkType: "head" });
  head.fileFormatVersion = fileFormatVersion;
  const rifx = new ListChunk({
    chunkType: "RIFX",
    listType: "Egg!",
    chunks: [head, ...nameChunks],
  });
  const out = new BytesIO();
  writeAep(out, rifx, "");
  return out.getvalue();
}

test("test_new_names_in_an_older_project_are_written_as_strings", () => {
  // AE reads a `Utf8` child of a format 91 file as the name "Utf8".
  const names: Chunk[] = [
    ["fnam", "Glow"],
    ["pdnm", "On|Off"],
    ["RCom", "note"],
  ].map(
    ([chunkType, value]) =>
      new ContainerChunk({ chunkType: chunkType, chunks: [new Utf8Chunk({ value })] }),
  );
  names.push(new TdsnChunk({ chunks: [new Utf8Chunk({ value: TDSN_SENTINEL })] }));
  const data = _olderProjectBytes(names, 91);
  expect(Bytes.includes(data, b("Utf8"))).toBe(false);
  expect(Bytes.includes(data, _chunk("fnam", Bytes.padEnd(b("Glow"), 48, 0)))).toBe(true);
  expect(Bytes.includes(data, _chunk("pdnm", b("On|Off\x00")))).toBe(true);
  expect(Bytes.includes(data, _chunk("RCom", b("note\x00")))).toBe(true);
  expect(Bytes.includes(data, _chunk("tdsn", b("\x00")))).toBe(true);
  // The same containers in a format 92 file keep their `Utf8` children.
  const modern = _olderProjectBytes(names, 92);
  expect(Bytes.count(modern, b("Utf8"))).toBe(4);
});

test("test_names_edited_in_an_older_project_read_back", () => {
  const tmpPath = makeTmpPath();
  const project = py_aep.newProject("15.0x1").project;
  const comp = project.rootFolder.addComp("comp", 100, 100, 1.0, 1.0, 24.0);
  const solid = comp.addSolid([1, 0, 0], "solid", 100, 100, 1.0);
  solid.property("ADBE Mask Parade").addProperty("ADBE Mask Atom").name = "mask";
  solid.property("ADBE Effect Parade").addProperty("ADBE Slider Control").name = "slider";
  solid.property("ADBE Effect Parade").addProperty("ADBE Checkbox Control");
  asInstance(project.renderQueue, RenderQueue).add(comp).comment = "note";
  project._head.fileFormatVersion = 91;
  const out = tmpPath.div("older.aep");
  project.save(out);
  const back = py_aep.parse(out).project;
  const names = ["tdsn", "fnam", "pdnm", "RCom"].flatMap((chunkType) =>
    recursiveFind(back._rifx.chunks, chunkType),
  );
  expect(len(names) > 4).toBe(true);
  expect(names.every((chunk) => truthy(chunk.data))).toBe(true);
  const [layer] = back.compositions[0].layers;
  expect(
    valueEquals(
      layer.property("ADBE Mask Parade").properties.map((p) => p.name),
      ["mask"],
    ),
  ).toBe(true);
  expect(
    valueEquals(
      layer.property("ADBE Effect Parade").properties.map((p) => p.name),
      ["slider", "Checkbox Control"],
    ),
  ).toBe(true);
  expect(valueEquals(asInstance(back.renderQueue, RenderQueue).items[0].comment, "note")).toBe(true);
});

test("test_an_older_project_cannot_be_relabelled", () => {
  const app = py_aep.newProject("15.0x1");
  app._head.fileFormatVersion = 91;
  raises(ValueError, () => {
    app.version = "16.0x1";
  }, "older format");
  expect(valueEquals(app.version, "15.0x1")).toBe(true);
});
