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
import { type Chunk, ContainerChunk, ListChunk, read_chunks, write_aep, write_chunk } from "../../src/py_aep/binary/chunk.ts";
import { HeadChunk, NhedChunk } from "../../src/py_aep/binary/item_chunks.ts";
import { DwgaChunk } from "../../src/py_aep/binary/misc_chunks.ts";
import { TDSN_SENTINEL, TdsnChunk } from "../../src/py_aep/binary/property_chunks.ts";
import { Utf8Chunk } from "../../src/py_aep/binary/scalar_chunks.ts";
import { recursive_find } from "../../src/py_aep/binary/utils.ts";
import { BitsPerChannel, GpuAccelType } from "../../src/py_aep/enums/index.ts";
import { RenderQueue } from "../../src/py_aep/models/renderqueue/render_queue.ts";
import { _nnhd_from_nhed } from "../../src/py_aep/parsers/project.ts";
import { as_instance } from "../helpers.ts";
import {
  AttributeError,
  BytesIO,
  ValueError,
  b,
  bytes_,
  concat,
  decode,
  encode,
  len,
  py_bool,
  py_eq,
  range,
  struct,
} from "../../src/pyrt/index.ts";
import { make_tmp_path, raises } from "../../src/pyrt/pytest.ts";

function _chunk(chunk_type: string, body: Uint8Array): Uint8Array {
  const pad = len(body) & 1 ? b("\x00") : b("");
  return concat(encode(chunk_type, "ASCII"), struct.pack(">I", len(body)), body, pad);
}

function _read(data: Uint8Array): Chunk[] {
  return read_chunks(new BytesIO(data), len(data));
}

function _write(chunks: Chunk[]): Uint8Array {
  const out = new BytesIO();
  for (const chunk of chunks) {
    write_chunk(out, chunk);
  }
  return out.getvalue();
}

test("test_a_one_byte_tdsn_does_not_swallow_the_next_chunk", () => {
  const data = concat(
    _chunk("tdsn", b("\x00")),
    _chunk("tdmn", bytes_.ljust(b("ADBE Transform Group"), 40, 0)),
  );
  const chunks = _read(data);
  expect(py_eq(chunks.map((c) => c.chunk_type), ["tdsn", "tdmn"])).toBe(true);
  const tdsn = as_instance(chunks[0], TdsnChunk);
  expect(tdsn instanceof TdsnChunk).toBe(true);
  // An empty legacy name is an unnamed property.
  expect(py_eq(tdsn.utf8.value, TDSN_SENTINEL)).toBe(true);
  expect(tdsn.utf8.synthetic).toBe(true);
  expect(py_eq(_write(chunks), data)).toBe(true);
});

test("test_a_legacy_fnam_reads_its_string", () => {
  const body = bytes_.slice(
    concat(b("Color Control\x00ol\x00\x00"), Uint8Array.from(range(1, 32))),
    0,
    48,
  );
  const data = _chunk("fnam", body);
  const fnam = as_instance(_read(data)[0], ContainerChunk);
  expect(fnam instanceof ContainerChunk).toBe(true);
  const utf8 = as_instance(fnam.chunks[0], Utf8Chunk);
  expect(utf8 instanceof Utf8Chunk).toBe(true);
  expect(py_eq(utf8.value, "Color Control")).toBe(true);
  // Written back byte for byte, stale bytes included.
  expect(py_eq(_write([fnam]), data)).toBe(true);
});

test("test_a_renamed_legacy_fnam_keeps_its_buffer", () => {
  const body = bytes_.ljust(b("Color Control"), 48, 0);
  const fnam = as_instance(_read(_chunk("fnam", body))[0], ContainerChunk);
  as_instance(fnam.chunks[0], Utf8Chunk).value = "Text Color";
  const written = _write([fnam]);
  expect(py_eq(written, _chunk("fnam", bytes_.ljust(b("Text Color"), 48, 0)))).toBe(true);
});

test("test_a_modern_fnam_is_unchanged", () => {
  const utf8 = _chunk("Utf8", b("Glow"));
  const data = _chunk("fnam", utf8);
  const fnam = as_instance(_read(data)[0], ContainerChunk);
  const child = as_instance(fnam.chunks[0], Utf8Chunk);
  expect(py_eq(child.value, "Glow")).toBe(true);
  expect(child.synthetic).toBe(false);
  expect(py_eq(fnam.data, b(""))).toBe(true);
  expect(py_eq(_write([fnam]), data)).toBe(true);
});

test("test_nnhd_stands_in_from_nhed", () => {
  const nhed = new NhedChunk({});
  nhed.bits_per_channel = 1;
  nhed.frames_count_type = 1;
  nhed.timecode_default_base = 25;
  const nnhd = _nnhd_from_nhed(nhed);
  expect(nnhd.synthetic).toBe(true);
  expect(
    py_eq(
      [nnhd.bits_per_channel, nnhd.frames_count_type, nnhd.timecode_default_base],
      [1, 1, 25],
    ),
  ).toBe(true);
});

test("test_a_legacy_fnam_with_a_four_letter_name_reads_its_string", () => {
  // "Fill" then NUL padding also reads as a `Fill` header of length 0; the
  // NUL headers after it are not chunks.
  for (const name of [b("Fill"), b("Glow"), b("Tint"), b("Blur")]) {
    const data = _chunk("fnam", bytes_.ljust(name, 48, 0));
    const fnam = as_instance(_read(data)[0], ContainerChunk);
    const utf8 = as_instance(fnam.chunks[0], Utf8Chunk);
    expect(py_eq(utf8.value, decode(name))).toBe(true);
    expect(utf8.synthetic).toBe(true);
    expect(py_eq(_write([fnam]), data)).toBe(true);
  }
});

test("test_a_renamed_one_byte_tdsn_grows_to_its_name", () => {
  const tdsn = as_instance(_read(_chunk("tdsn", b("\x00")))[0], TdsnChunk);
  tdsn.utf8.value = "My Name";
  expect(py_eq(_write([tdsn]), _chunk("tdsn", b("My Name\x00")))).toBe(true);
});

test("test_a_renamed_legacy_tdsn_keeps_whole_characters", () => {
  const tdsn = as_instance(_read(_chunk("tdsn", b("abc\x00")))[0], TdsnChunk);
  tdsn.utf8.value = "abcdefé";
  expect(
    py_eq(_write([tdsn]), _chunk("tdsn", concat(encode("abcdefé"), b("\x00")))),
  ).toBe(true);
});

test("test_a_legacy_tdsn_reset_to_unnamed_writes_the_empty_name", () => {
  const tdsn = as_instance(_read(_chunk("tdsn", b("Mask 1\x00")))[0], TdsnChunk);
  tdsn.utf8.value = TDSN_SENTINEL;
  expect(py_eq(_write([tdsn]), _chunk("tdsn", b("\x00")))).toBe(true);
});

test("test_a_renamed_legacy_pdnm_grows_to_its_items", () => {
  const pdnm = as_instance(_read(_chunk("pdnm", b("On|Off\x00")))[0], ContainerChunk);
  as_instance(pdnm.chunks[0], Utf8Chunk).value = "On|Off|Auto";
  expect(py_eq(_write([pdnm]), _chunk("pdnm", b("On|Off|Auto\x00")))).toBe(true);
});

test("test_a_legacy_fnam_too_long_for_its_buffer_raises", () => {
  const fnam = as_instance(_read(_chunk("fnam", bytes_.ljust(b("Glow"), 48, 0)))[0], ContainerChunk);
  as_instance(fnam.chunks[0], Utf8Chunk).value = "x".repeat(48);
  raises(ValueError, () => {
    _write([fnam]);
  }, "48-byte fnam");
});

/**
 * A project with the stand-ins a CC 12.0 one parses with: no nnhd or
 * dwga, a head of AE 12.
 */
function _as_cc12_project(): py_aep.Project {
  const project = py_aep.new("15.0x1").project;
  project._nnhd = _nnhd_from_nhed(project._nhed);
  project._dwga = new DwgaChunk({ synthetic: true });
  // @ts-expect-error SimpleNamespace stand-in for the head chunk
  project._head = { ae_version_major: 12 };
  return project;
}

test("test_cc12_settings_synced_to_nhed_write_through", () => {
  const project = _as_cc12_project();
  project.bits_per_channel = BitsPerChannel.SIXTEEN;
  expect(project.bits_per_channel).toBe(BitsPerChannel.SIXTEEN);
  expect(project._nhed.bits_per_channel).toBe(project._nnhd.bits_per_channel);
  expect(project._nnhd.synthetic).toBe(true);
});

test("test_cc12_working_gamma_has_nowhere_to_go_and_raises", () => {
  const project = _as_cc12_project();
  raises(AttributeError, () => {
    project.working_gamma = 2.4;
  }, "requires AE 13");
});

test("test_cc12_timecode_default_base_synced_to_nhed", () => {
  const project = _as_cc12_project();
  project._timecode_default_base = 60;
  expect(project._nhed.timecode_default_base).toBe(60);
});

test("test_cc12_timecode_default_base_above_u1_raises", () => {
  const project = _as_cc12_project();
  raises(ValueError, () => {
    project._timecode_default_base = 300;
  });
  expect(project._nhed.timecode_default_base).toBe(30);
});

test("test_gpu_accel_type_software_without_gpug", () => {
  const project = _as_cc12_project();
  project._gpug_utf8 = new Utf8Chunk({
    value: GpuAccelType.to_binary(GpuAccelType.SOFTWARE),
    synthetic: true,
  });
  expect(project.gpu_accel_type).toBe(GpuAccelType.SOFTWARE);
});

function _older_project_bytes(name_chunks: Chunk[], file_format_version: number): Uint8Array {
  const head = new HeadChunk({ chunk_type: "head" });
  head.file_format_version = file_format_version;
  const rifx = new ListChunk({
    chunk_type: "RIFX",
    list_type: "Egg!",
    chunks: [head, ...name_chunks],
  });
  const out = new BytesIO();
  write_aep(out, rifx, "");
  return out.getvalue();
}

test("test_new_names_in_an_older_project_are_written_as_strings", () => {
  // AE reads a `Utf8` child of a format 91 file as the name "Utf8".
  const names: Chunk[] = [
    ["fnam", "Glow"],
    ["pdnm", "On|Off"],
    ["RCom", "note"],
  ].map(
    ([chunk_type, value]) =>
      new ContainerChunk({ chunk_type, chunks: [new Utf8Chunk({ value })] }),
  );
  names.push(new TdsnChunk({ chunks: [new Utf8Chunk({ value: TDSN_SENTINEL })] }));
  const data = _older_project_bytes(names, 91);
  expect(bytes_.contains(data, b("Utf8"))).toBe(false);
  expect(bytes_.contains(data, _chunk("fnam", bytes_.ljust(b("Glow"), 48, 0)))).toBe(true);
  expect(bytes_.contains(data, _chunk("pdnm", b("On|Off\x00")))).toBe(true);
  expect(bytes_.contains(data, _chunk("RCom", b("note\x00")))).toBe(true);
  expect(bytes_.contains(data, _chunk("tdsn", b("\x00")))).toBe(true);
  // The same containers in a format 92 file keep their `Utf8` children.
  const modern = _older_project_bytes(names, 92);
  expect(bytes_.count(modern, b("Utf8"))).toBe(4);
});

test("test_names_edited_in_an_older_project_read_back", () => {
  const tmp_path = make_tmp_path();
  const project = py_aep.new("15.0x1").project;
  const comp = project.root_folder.add_comp("comp", 100, 100, 1.0, 1.0, 24.0);
  const solid = comp.add_solid([1, 0, 0], "solid", 100, 100, 1.0);
  solid.__getitem__("ADBE Mask Parade").add_property("ADBE Mask Atom").name = "mask";
  solid.__getitem__("ADBE Effect Parade").add_property("ADBE Slider Control").name = "slider";
  solid.__getitem__("ADBE Effect Parade").add_property("ADBE Checkbox Control");
  as_instance(project.render_queue, RenderQueue).add(comp).comment = "note";
  project._head.file_format_version = 91;
  const out = tmp_path.div("older.aep");
  project.save(out);
  const back = py_aep.parse(out).project;
  const names = ["tdsn", "fnam", "pdnm", "RCom"].flatMap((chunk_type) =>
    recursive_find(back._rifx.chunks, chunk_type),
  );
  expect(len(names) > 4).toBe(true);
  expect(names.every((chunk) => py_bool(chunk.data))).toBe(true);
  const [layer] = back.compositions[0].layers;
  expect(
    py_eq(
      layer.__getitem__("ADBE Mask Parade").properties.map((p) => p.name),
      ["mask"],
    ),
  ).toBe(true);
  expect(
    py_eq(
      layer.__getitem__("ADBE Effect Parade").properties.map((p) => p.name),
      ["slider", "Checkbox Control"],
    ),
  ).toBe(true);
  expect(py_eq(as_instance(back.render_queue, RenderQueue).items[0].comment, "note")).toBe(true);
});

test("test_an_older_project_cannot_be_relabelled", () => {
  const app = py_aep.new("15.0x1");
  app._head.file_format_version = 91;
  raises(ValueError, () => {
    app.version = "16.0x1";
  }, "older format");
  expect(py_eq(app.version, "15.0x1")).toBe(true);
});
