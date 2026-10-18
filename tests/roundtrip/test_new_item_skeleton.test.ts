/**
 * Regression tests pinning the binary skeleton of newly created items.
 *
 * After Effects 2026 rejects (or crashes on) files whose new layers / comps
 * lack the chunk skeleton it writes itself. These tests assert the WRITTEN
 * bytes (save -> re-read) match the ground-truth structure measured from AE
 */

import { describe, expect, test } from "bun:test";
import { at, ByteStream, Bytes, getMember, Path, valueEquals, repr, StopIteration, ValueError } from "../../src/pyrt/index.ts";

import { parse as parseAep, type Application } from "../../src/py_aep/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { ListChunk, readAep } from "../../src/py_aep/binary/chunk.ts";
import type { Chunk } from "../../src/py_aep/binary/chunk.ts";
import { TdmnChunk } from "../../src/py_aep/binary/property_chunks.ts";
import { ClassicPrdaChunk } from "../../src/py_aep/binary/misc_chunks.ts";
import { filterByListType, findByListType, findByType, recursiveFind } from "../../src/py_aep/binary/utils.ts";
import { getComp } from "../conftest.ts";
import { asInstance } from "../helpers.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { approx, makeTmpPath } from "../support/pytest.ts";
import { round } from "../support/python.ts";

const SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models");
// default 3D render-options blob (Classic)
const PRDA_CLASSIC_DEFAULT = Bytes.fromHex("000000010000000000000000");

function _savedRifx(app: Application, tmpPath: Path): ListChunk {
  const out = tmpPath.div("out.aep");
  app.project.save(out);
  const f = new ByteStream(out.readBytes());
  const [rifx] = readAep(f);
  return rifx;
}

function _findCompItem(rifx: ListChunk, compName: string): ListChunk {
  const fold = findByListType(rifx.chunks, "Fold");
  for (const found of recursiveFind(fold.chunks, null, "Item")) {
    const ch = asInstance(found, ListChunk);
    const utf8 = findByType(ch.chunks, "Utf8");
    const idta = findByType(ch.chunks, "idta");
    if (String(utf8.value) === compName && idta.itemType === 4) {
      return ch;
    }
  }
  // NOTE(port): pytest.fail raises to fail the test with this message; throwing Error fails the test identically.
  throw new Error(`comp ${repr(compName)} not found in saved file`);
}

function _findPrda(rifx: ListChunk, compName: string): Chunk {
  const item = _findCompItem(rifx, compName);
  const prin = findByListType(item.chunks, "PRin");
  return findByType(prin.chunks, "prda");
}

function _topLayer(rifx: ListChunk, compName: string): ListChunk {
  const item = _findCompItem(rifx, compName);
  return filterByListType(item.chunks, "Layr")[0];
}

function _matchNameStream(tdgp: ListChunk): string[] {
  const out: string[] = [];
  for (const ch of tdgp.chunks) {
    if (ch.chunkType === "tdmn") {
      out.push(asInstance(ch, TdmnChunk).value);
    }
  }
  return out;
}

/** Test class TestNewLayerSkeleton. */
describe("TestNewLayerSkeleton", () => {
  test("test_root_tdgp_ends_with_group_end", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("layer", "type.aep"));
    getComp(app.project, "type_null").addNull();
    const rifx = _savedRifx(app, tmpPath);
    const layer = _topLayer(rifx, "type_null");
    const tdgp = findByListType(layer.chunks, "tdgp");
    const stream = _matchNameStream(tdgp);
    expect(String(at(stream, -1))).toBe("ADBE Group End");
  });

  test("test_no_zero_time_base_written", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("layer", "type.aep"));
    const comp = getComp(app.project, "type_null");
    comp.addNull();
    comp.addCamera("Cam");
    comp.addLight("Light");
    const rifx = _savedRifx(app, tmpPath);
    const item = _findCompItem(rifx, "type_null");
    const bases = new Set(recursiveFind(item.chunks, "tdb4").map((t) => t._timeBase));
    expect(bases.has(0)).toBe(false);
  });

  test("test_time_remapping_has_value_and_bounds", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("layer", "type.aep"));
    getComp(app.project, "type_null").addNull();
    const rifx = _savedRifx(app, tmpPath);
    const layer = _topLayer(rifx, "type_null");
    const tdgp = findByListType(layer.chunks, "tdgp");
    const idx = tdgp.chunks.findIndex(
      (c) => c.chunkType === "tdmn" && String(asInstance(c, TdmnChunk).value) === "ADBE Time Remapping",
    );
    if (idx < 0) throw new StopIteration();
    const tdbs = asInstance(at(tdgp.chunks, idx + 1), ListChunk);
    const kinds = tdbs.chunks.map((c) => getMember(c, "listType", c.chunkType));
    expect(kinds).toContain("cdat");
    expect(kinds).toContain("tdum");
    expect(kinds).toContain("tduM");
  });

  test("test_layer_overrides_followed_by_ovg2", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("layer", "type.aep"));
    getComp(app.project, "type_null").addNull();
    const rifx = _savedRifx(app, tmpPath);
    const layer = _topLayer(rifx, "type_null");
    const tdgp = findByListType(layer.chunks, "tdgp");
    const idx = tdgp.chunks.findIndex(
      (c) => c.chunkType === "tdmn" && String(asInstance(c, TdmnChunk).value) === "ADBE Layer Overrides",
    );
    if (idx < 0) throw new StopIteration();
    const nxt = at(tdgp.chunks, idx + 1);
    expect(getMember(nxt, "listType", null)).toBe("OvG2");
  });

  test("test_source_alternate_blsv_blsi_and_empty_cdat", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("layer", "type.aep"));
    getComp(app.project, "type_null").addNull();
    const rifx = _savedRifx(app, tmpPath);
    const layer = _topLayer(rifx, "type_null");
    const root = findByListType(layer.chunks, "tdgp");
    const idx = root.chunks.findIndex(
      (c) => c.chunkType === "tdmn" && String(asInstance(c, TdmnChunk).value) === "ADBE Source Options Group",
    );
    if (idx < 0) throw new StopIteration();
    const inner = asInstance(at(root.chunks, idx + 1), ListChunk);
    const kinds = inner.chunks.map((c) => getMember(c, "listType", c.chunkType));
    const j = kinds.indexOf("blsv");
    if (j < 0) throw new ValueError("'blsv' is not in list");
    expect<string>(at(kinds, j + 1)).toBe("blsi");
    const tdbs = asInstance(at(inner.chunks, j + 2), ListChunk);
    const cdat = findByType(tdbs.chunks, "cdat");
    expect(cdat.values.length).toBe(0); // 4-zero-byte no-value marker
  });

  test("test_empty_parade_groups_not_written", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("layer", "type.aep"));
    getComp(app.project, "type_null").addNull();
    const rifx = _savedRifx(app, tmpPath);
    const layer = _topLayer(rifx, "type_null");
    const tdgp = findByListType(layer.chunks, "tdgp");
    const stream = _matchNameStream(tdgp);
    for (const omitted of ["ADBE MTrackers", "ADBE Mask Parade", "ADBE Effect Parade"]) {
      expect(stream.some((v) => String(v) === omitted)).toBe(false);
    }
  });

  test("test_static_orientation_written_as_otst", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("layer", "type.aep"));
    getComp(app.project, "type_null").addNull();
    const rifx = _savedRifx(app, tmpPath);
    const layer = _topLayer(rifx, "type_null");
    const root = findByListType(layer.chunks, "tdgp");
    const idx = root.chunks.findIndex(
      (c) => c.chunkType === "tdmn" && String(asInstance(c, TdmnChunk).value) === "ADBE Transform Group",
    );
    if (idx < 0) throw new StopIteration();
    const transform = asInstance(at(root.chunks, idx + 1), ListChunk);
    const j = transform.chunks.findIndex(
      (c) => c.chunkType === "tdmn" && String(asInstance(c, TdmnChunk).value) === "ADBE Orientation",
    );
    if (j < 0) throw new StopIteration();
    const wrapper = at(transform.chunks, j + 1);
    expect(getMember(wrapper, "listType", null)).toBe("otst");
  });

  test("test_camera_position_and_poi", () => {
    const app = parseAep(SAMPLES_DIR.div("layer", "type.aep"));
    const comp = getComp(app.project, "type_null");
    const cam = comp.addCamera("Cam");
    const pos = asInstance([...cam.transform].find((p) => p.matchName === "ADBE Position"), Property);
    const anchor = asInstance([...cam.transform].find((p) => p.matchName === "ADBE Anchor Point"), Property);
    const zoom = round(comp.width / 0.72, 8);
    expect(valueEquals(pos.value, [0.0, 0.0, -zoom])).toBe(true);
    expect(valueEquals(anchor.value, [comp.width / 2, comp.height / 2, 0.0])).toBe(true);
  });
});

/** Test class TestNewCompSkeleton. */
describe("TestNewCompSkeleton", () => {
  test("test_full_view_state_skeleton_written", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    app.project.rootFolder.addComp("MinComp", 1280, 720, 1.0, 10.0, 30.0);
    const rifx = _savedRifx(app, tmpPath);
    const item = _findCompItem(rifx, "MinComp");
    const kinds = item.chunks.map((c) => getMember(c, "listType", c.chunkType));
    for (const required of ["dats", "cdrp", "comr", "DLay", "SecL", "CIFO", "Gide"]) {
      // Python message: f"missing {required} in new comp item"
      expect(kinds).toContain(required);
    }
    expect(kinds.filter((k) => k === "SLay").length).toBe(6);
    expect(kinds.filter((k) => k === "CLay").length).toBe(3);
  });

  test("test_comp_params_patched_into_template", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const comp = app.project.rootFolder.addComp("OtherComp", 1920, 1080, 2.0, 4.5, 23.976);
    const compId = comp.id;
    const rifx = _savedRifx(app, tmpPath);
    const item = _findCompItem(rifx, "OtherComp");
    const cdta = findByType(item.chunks, "cdta");
    expect(cdta.width).toBe(1920);
    expect(cdta.height).toBe(1080);
    expect(cdta.pixelAspect).toBe(2.0);
    expect(cdta.internalTimebase).toBe(23976);
    const iide = findByType(item.chunks, "iide");
    const idta = findByType(item.chunks, "idta");
    expect(iide.value).toBe(compId);
    expect(idta.itemId).toBe(compId);
    // viewer pseudo-layers rebased onto the comp's timebase
    const bases = new Set(recursiveFind(item.chunks, "tdb4").map((t) => t._timeBase));
    expect(valueEquals(bases, new Set([23976]))).toBe(true);
  });

  test("test_reparse_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const comp = app.project.rootFolder.addComp("RT", 1280, 720, 1.0, 10.0, 30.0);
    comp.addSolid([0.5, 0.5, 0.5], "S");
    const out = tmpPath.div("rt.aep");
    app.project.save(out);
    const app2 = parseAep(out);
    const comp2 = app2.project.compositions.find((c) => c.name === "RT");
    if (comp2 == null) throw new StopIteration();
    expect(approx(comp2.frameRate, 30.0)).toBe(true);
    expect(valueEquals(comp2.layers.map((lyr) => lyr.name), ["S"])).toBe(true);
  });
});

/** Test class TestNewCompPrda. */
describe("TestNewCompPrda", () => {
  test("test_new_comp_prda_is_classic_variant", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    app.project.rootFolder.addComp("PrdaComp", 1280, 720, 1.0, 10.0, 30.0);
    const rifx = _savedRifx(app, tmpPath);
    const prda = _findPrda(rifx, "PrdaComp");
    expect(prda instanceof ClassicPrdaChunk).toBe(true);
    expect(asInstance(prda, ClassicPrdaChunk).shadowMapResolution).toBe(0);
  });

  test("test_new_comp_prda_bytes_match_after_effects", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    app.project.rootFolder.addComp("PrdaComp", 1280, 720, 1.0, 10.0, 30.0);
    const rifx = _savedRifx(app, tmpPath);
    const buf = new ByteStream();
    _findPrda(rifx, "PrdaComp").write(buf);
    expect(valueEquals(buf.toBytes(), PRDA_CLASSIC_DEFAULT)).toBe(true);
  });
});
