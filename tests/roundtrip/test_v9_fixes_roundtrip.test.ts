/** Regression tests for the v9 round-trip / read-purity fixes.

- Fixed-size string fields keep the bytes After Effects leaves after the
  NUL terminator (a renamed solid's old name in its `opti`, the NUL-led
  `"\\0vsc"` code of CSV data footage) through parse -> save.
- tdb4 byte 0x4F is stored as the whole byte (AE writes 0x07 on Transform
  effect points of some projects), so reading a layer no longer rewrites it.
- `.csv` / `.txt` imports write the source code AE 2026 writes.
*/

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, b, bytes_, bytesEq, decode, len, Path, pyBool, pyEq, StopIteration, struct } from "../../src/pyrt/index.ts";
import { makeTmpPath } from "../../src/pyrt/pytest.ts";
import { ImportOptions, parse } from "../../src/py_aep/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { OptiChunk, SoliOptiChunk, SspcChunk } from "../../src/py_aep/binary/footage_chunks.ts";
import { Tdb4Chunk } from "../../src/py_aep/binary/property_chunks.ts";
import type { Project } from "../../src/py_aep/models/project.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";
import { asInstance, projectBytes } from "../helpers.ts";

const SAMPLES = new Path(import.meta.path).parent.parent.parent.div("samples");
const ASSETS = SAMPLES.div("assets");

/** `(chunk type, body offset)` of every leaf chunk, by a raw RIFX walk
(only those inside a `LIST:<in_list>` when given). */
function _leaves(data: Uint8Array, inList: Uint8Array = b("")): [string, number][] {
  const out: [string, number][] = [];

  function walk(off: number, end: number, inside: boolean): void {
    while (off + 8 <= end) {
      const ctype = decode(bytes_.slice(data, off, off + 4), "latin-1");
      const [size] = struct.unpack(">I", bytes_.slice(data, off + 4, off + 8));
      const body = off + 8;
      if (["LIST", "RIFX"].includes(ctype)) {
        const listType = bytes_.slice(data, body, body + 4);
        if (!bytesEq(listType, b("btdk"))) {
          walk(body + 4, body + size, inside || bytesEq(listType, inList));
        }
      } else if (inside) {
        out.push([ctype, body]);
      }
      off = body + size + and(size, 1);
    }
  }

  walk(0, len(data), !pyBool(inList));
  return out;
}

/** Iterate every property of every layer (parses the deferred layers). */
function _readEveryLayer(project: Project): void {
  for (const comp of project.compositions) {
    for (const layer of comp.layers) {
      const stack: PropertyGroup[] = [layer];
      while (pyBool(stack)) {
        const group = stack.pop();
        if (group === undefined) break;
        for (const child of group) {
          if (!("keyframes" in child)) {
            stack.push(child);
          }
        }
      }
    }
  }
}

describe("TestFixedStringTail", () => {
  test("test_sspc_source_code_after_nul_round_trips", () => {
    const data = new Uint8Array(new SspcChunk().tobytes());
    data.set(b("\x00vsc"), 0x16);
    const chunk = asInstance(SspcChunk.frombytes(new Uint8Array(data)), SspcChunk);
    expect(String(chunk.sourceFormatType)).toBe("");
    expect(pyEq(chunk.tobytes(), new Uint8Array(data))).toBe(true);
  });

  test("test_assigned_code_with_nul_reads_back_as_reparsed", () => {
    const chunk = new SspcChunk({ sourceFormatType: "\x00vsc" });
    expect(String(chunk.sourceFormatType)).toBe("");
    expect(pyEq(bytes_.slice(chunk.tobytes(), 0x16, 0x1A), b("\x00vsc"))).toBe(true);
  });

  test("test_assigned_plain_string_drops_the_old_tail", () => {
    const data = new Uint8Array(new SspcChunk().tobytes());
    data.set(b("\x00vsc"), 0x16);
    const chunk = asInstance(SspcChunk.frombytes(new Uint8Array(data)), SspcChunk);
    chunk.sourceFormatType = "png!";
    expect(pyEq(bytes_.slice(chunk.tobytes(), 0x16, 0x1A), b("png!"))).toBe(true);
  });

  test("test_solid_name_stale_tail_round_trips", () => {
    const data = new Uint8Array(new SoliOptiChunk({ solidName: "Black Solid 3" }).tobytes());
    const nameAt = bytes_.index(data, b("Black Solid 3"));
    // AE keeps the end of a longer previous name after the terminator.
    const stale = b("Black Solid 3\x00 1\x00id 1");
    data.set(stale, nameAt);
    const chunk = asInstance(OptiChunk.frombytes(new Uint8Array(data)), SoliOptiChunk);
    expect(String(chunk.solidName)).toBe("Black Solid 3");
    expect(pyEq(chunk.tobytes(), new Uint8Array(data))).toBe(true);
  });

  test("test_project_with_stale_tail_saves_byte_identical", () => {
    const tmpPath = makeTmpPath();
    // The NUL-led CSV code in a real project, read and written whole.
    const app = parse(SAMPLES.div("models", "folder", "folder.aep"));
    app.project.importFile(new ImportOptions(ASSETS.div("csv.csv")));
    const first = tmpPath.div("first.aep");
    app.project.save(first);
    const reparsed = parse(first);
    _readEveryLayer(reparsed.project);
    for (const item of reparsed.project.footages) {
      expect(item.mainSource != null).toBe(true);
    }
    const second = tmpPath.div("second.aep");
    reparsed.project.save(second);
    expect(pyEq(second.readBytes(), first.readBytes())).toBe(true);
  });
});

describe("TestTdb4KeyFlagsByte", () => {
  test("test_byte_0x4f_kept_whole", () => {
    const data = new Uint8Array(new Tdb4Chunk().tobytes());
    data[0x4F] = 0x07;
    const chunk = asInstance(Tdb4Chunk.frombytes(new Uint8Array(data)), Tdb4Chunk);
    expect(chunk._spatialMarker).toBe(0x07);
    expect(chunk._spatialMarker).toBeTruthy(); // still reads as a spatial stream
    expect(pyEq(chunk.tobytes(), new Uint8Array(data))).toBe(true);
  });

  test("test_reading_layers_keeps_the_byte", () => {
    const tmpPath = makeTmpPath();
    const source = SAMPLES.div("models", "property", "effect_point_speed.aep");
    const data = new Uint8Array(source.readBytes());
    const targets = _leaves(new Uint8Array(data), b("Layr"))
      .filter(([ctype, body]) => ctype === "tdb4" && data[body + 0x4F] === 1)
      .map(([, body]) => body + 0x4F);
    if (targets.length === 0) throw new StopIteration(); // next() on an empty generator
    const target = targets[0];
    data[target] = 0x07;
    const patched = tmpPath.div("patched.aep");
    patched.writeBytes(new Uint8Array(data));
    const app = parse(patched);
    const before = createHash("sha1").update(projectBytes(app.project)).digest("hex");
    _readEveryLayer(app.project);
    const after = projectBytes(app.project);
    expect(createHash("sha1").update(after).digest("hex")).toBe(before);
    expect(pyEq(after, new Uint8Array(data))).toBe(true);
  });
});

describe("TestDataFootageSourceCode", () => {
  test("test_csv_and_txt_codes_match_after_effects", () => {
    const tmpPath = makeTmpPath();
    // AE 2026 imports a .csv / .txt with the comma- / tab-separated
    // values importer's NUL-led codes, in sspc and in the opti header.
    const app = parse(SAMPLES.div("models", "folder", "folder.aep"));
    for (const name of ["csv.csv", "txt.txt"]) {
      app.project.importFile(new ImportOptions(ASSETS.div(name)));
    }
    const out = tmpPath.div("data.aep");
    app.project.save(out);
    const data = out.readBytes();
    // Byte strings compared by their hex spelling (a JS Set holds bytes by identity).
    const codes = new Set(
      _leaves(data)
        .filter(([ctype]) => ctype === "sspc")
        .map(([, body]) => bytes_.hex(bytes_.slice(data, body + 0x16, body + 0x1A))),
    );
    const expectedCodes = [b("\x00vsc"), b("\x00vst")].map((x) => bytes_.hex(x));
    expect(expectedCodes.every((c) => codes.has(c))).toBe(true);
    const optis = new Set(
      _leaves(data)
        .filter(([ctype]) => ctype === "opti")
        .map(([, body]) => bytes_.hex(bytes_.slice(data, body, body + 4))),
    );
    expect(expectedCodes.every((c) => optis.has(c))).toBe(true);
    for (const item of parse(out).project.footages) {
      if (["csv.csv", "txt.txt"].includes(item.name)) {
        expect(String(item.mainSource._sspc.sourceFormatType)).toBe("");
      }
    }
  });
});
