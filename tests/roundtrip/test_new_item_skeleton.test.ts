/**
 * Regression tests pinning the binary skeleton of newly created items.
 *
 * After Effects 2026 rejects (or crashes on) files whose new layers / comps
 * lack the chunk skeleton it writes itself. These tests assert the WRITTEN
 * bytes (save -> re-read) match the ground-truth structure measured from AE
 */

import { describe, expect, test } from "bun:test";
import { at, BytesIO, bytes_, getattr, Path, py_eq, repr, round, StopIteration, ValueError } from "../../src/pyrt/index.ts";
import { approx, make_tmp_path } from "../../src/pyrt/pytest.ts";
import { parse as parse_aep, type Application } from "../../src/py_aep/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { ListChunk, read_aep } from "../../src/py_aep/binary/chunk.ts";
import type { Chunk } from "../../src/py_aep/binary/chunk.ts";
import { TdmnChunk } from "../../src/py_aep/binary/property_chunks.ts";
import { ClassicPrdaChunk } from "../../src/py_aep/binary/misc_chunks.ts";
import { filter_by_list_type, find_by_list_type, find_by_type, recursive_find } from "../../src/py_aep/binary/utils.ts";
import { get_comp } from "../conftest.ts";
import { as_instance } from "../helpers.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";

const SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models");
// default 3D render-options blob (Classic)
const PRDA_CLASSIC_DEFAULT = bytes_.fromhex("000000010000000000000000");

function _saved_rifx(app: Application, tmp_path: Path): ListChunk {
  const out = tmp_path.div("out.aep");
  app.project.save(out);
  const f = new BytesIO(out.read_bytes());
  const [rifx] = read_aep(f);
  return rifx;
}

function _find_comp_item(rifx: ListChunk, comp_name: string): ListChunk {
  const fold = find_by_list_type(rifx.chunks, "Fold");
  for (const found of recursive_find(fold.chunks, null, "Item")) {
    const ch = as_instance(found, ListChunk);
    const utf8 = find_by_type(ch.chunks, "Utf8");
    const idta = find_by_type(ch.chunks, "idta");
    if (String(utf8.value) === comp_name && idta.item_type === 4) {
      return ch;
    }
  }
  // NOTE(port): pytest.fail raises to fail the test with this message; throwing Error fails the test identically.
  throw new Error(`comp ${repr(comp_name)} not found in saved file`);
}

function _find_prda(rifx: ListChunk, comp_name: string): Chunk {
  const item = _find_comp_item(rifx, comp_name);
  const prin = find_by_list_type(item.chunks, "PRin");
  return find_by_type(prin.chunks, "prda");
}

function _top_layer(rifx: ListChunk, comp_name: string): ListChunk {
  const item = _find_comp_item(rifx, comp_name);
  return filter_by_list_type(item.chunks, "Layr")[0];
}

function _match_name_stream(tdgp: ListChunk): string[] {
  const out: string[] = [];
  for (const ch of tdgp.chunks) {
    if (ch.chunk_type === "tdmn") {
      out.push(as_instance(ch, TdmnChunk).value);
    }
  }
  return out;
}

/** Test class TestNewLayerSkeleton. */
describe("TestNewLayerSkeleton", () => {
  test("test_root_tdgp_ends_with_group_end", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("layer", "type.aep"));
    get_comp(app.project, "type_null").addNull();
    const rifx = _saved_rifx(app, tmp_path);
    const layer = _top_layer(rifx, "type_null");
    const tdgp = find_by_list_type(layer.chunks, "tdgp");
    const stream = _match_name_stream(tdgp);
    expect(String(at(stream, -1))).toBe("ADBE Group End");
  });

  test("test_no_zero_time_base_written", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("layer", "type.aep"));
    const comp = get_comp(app.project, "type_null");
    comp.addNull();
    comp.addCamera("Cam");
    comp.addLight("Light");
    const rifx = _saved_rifx(app, tmp_path);
    const item = _find_comp_item(rifx, "type_null");
    const bases = new Set(recursive_find(item.chunks, "tdb4").map((t) => t._time_base));
    expect(bases.has(0)).toBe(false);
  });

  test("test_time_remapping_has_value_and_bounds", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("layer", "type.aep"));
    get_comp(app.project, "type_null").addNull();
    const rifx = _saved_rifx(app, tmp_path);
    const layer = _top_layer(rifx, "type_null");
    const tdgp = find_by_list_type(layer.chunks, "tdgp");
    const idx = tdgp.chunks.findIndex(
      (c) => c.chunk_type === "tdmn" && String(as_instance(c, TdmnChunk).value) === "ADBE Time Remapping",
    );
    if (idx < 0) throw new StopIteration();
    const tdbs = as_instance(at(tdgp.chunks, idx + 1), ListChunk);
    const kinds = tdbs.chunks.map((c) => getattr(c, "list_type", c.chunk_type));
    expect(kinds).toContain("cdat");
    expect(kinds).toContain("tdum");
    expect(kinds).toContain("tduM");
  });

  test("test_layer_overrides_followed_by_ovg2", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("layer", "type.aep"));
    get_comp(app.project, "type_null").addNull();
    const rifx = _saved_rifx(app, tmp_path);
    const layer = _top_layer(rifx, "type_null");
    const tdgp = find_by_list_type(layer.chunks, "tdgp");
    const idx = tdgp.chunks.findIndex(
      (c) => c.chunk_type === "tdmn" && String(as_instance(c, TdmnChunk).value) === "ADBE Layer Overrides",
    );
    if (idx < 0) throw new StopIteration();
    const nxt = at(tdgp.chunks, idx + 1);
    expect(getattr(nxt, "list_type", null)).toBe("OvG2");
  });

  test("test_source_alternate_blsv_blsi_and_empty_cdat", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("layer", "type.aep"));
    get_comp(app.project, "type_null").addNull();
    const rifx = _saved_rifx(app, tmp_path);
    const layer = _top_layer(rifx, "type_null");
    const root = find_by_list_type(layer.chunks, "tdgp");
    const idx = root.chunks.findIndex(
      (c) => c.chunk_type === "tdmn" && String(as_instance(c, TdmnChunk).value) === "ADBE Source Options Group",
    );
    if (idx < 0) throw new StopIteration();
    const inner = as_instance(at(root.chunks, idx + 1), ListChunk);
    const kinds = inner.chunks.map((c) => getattr(c, "list_type", c.chunk_type));
    const j = kinds.indexOf("blsv");
    if (j < 0) throw new ValueError("'blsv' is not in list");
    expect<string>(at(kinds, j + 1)).toBe("blsi");
    const tdbs = as_instance(at(inner.chunks, j + 2), ListChunk);
    const cdat = find_by_type(tdbs.chunks, "cdat");
    expect(cdat.values.length).toBe(0); // 4-zero-byte no-value marker
  });

  test("test_empty_parade_groups_not_written", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("layer", "type.aep"));
    get_comp(app.project, "type_null").addNull();
    const rifx = _saved_rifx(app, tmp_path);
    const layer = _top_layer(rifx, "type_null");
    const tdgp = find_by_list_type(layer.chunks, "tdgp");
    const stream = _match_name_stream(tdgp);
    for (const omitted of ["ADBE MTrackers", "ADBE Mask Parade", "ADBE Effect Parade"]) {
      expect(stream.some((v) => String(v) === omitted)).toBe(false);
    }
  });

  test("test_static_orientation_written_as_otst", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("layer", "type.aep"));
    get_comp(app.project, "type_null").addNull();
    const rifx = _saved_rifx(app, tmp_path);
    const layer = _top_layer(rifx, "type_null");
    const root = find_by_list_type(layer.chunks, "tdgp");
    const idx = root.chunks.findIndex(
      (c) => c.chunk_type === "tdmn" && String(as_instance(c, TdmnChunk).value) === "ADBE Transform Group",
    );
    if (idx < 0) throw new StopIteration();
    const transform = as_instance(at(root.chunks, idx + 1), ListChunk);
    const j = transform.chunks.findIndex(
      (c) => c.chunk_type === "tdmn" && String(as_instance(c, TdmnChunk).value) === "ADBE Orientation",
    );
    if (j < 0) throw new StopIteration();
    const wrapper = at(transform.chunks, j + 1);
    expect(getattr(wrapper, "list_type", null)).toBe("otst");
  });

  test("test_camera_position_and_poi", () => {
    const app = parse_aep(SAMPLES_DIR.div("layer", "type.aep"));
    const comp = get_comp(app.project, "type_null");
    const cam = comp.addCamera("Cam");
    const pos = as_instance([...cam.transform].find((p) => p.matchName === "ADBE Position"), Property);
    const anchor = as_instance([...cam.transform].find((p) => p.matchName === "ADBE Anchor Point"), Property);
    const zoom = round(comp.width / 0.72, 8);
    expect(py_eq(pos.value, [0.0, 0.0, -zoom])).toBe(true);
    expect(py_eq(anchor.value, [comp.width / 2, comp.height / 2, 0.0])).toBe(true);
  });
});

/** Test class TestNewCompSkeleton. */
describe("TestNewCompSkeleton", () => {
  test("test_full_view_state_skeleton_written", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    app.project.rootFolder.addComp("MinComp", 1280, 720, 1.0, 10.0, 30.0);
    const rifx = _saved_rifx(app, tmp_path);
    const item = _find_comp_item(rifx, "MinComp");
    const kinds = item.chunks.map((c) => getattr(c, "list_type", c.chunk_type));
    for (const required of ["dats", "cdrp", "comr", "DLay", "SecL", "CIFO", "Gide"]) {
      // Python message: f"missing {required} in new comp item"
      expect(kinds).toContain(required);
    }
    expect(kinds.filter((k) => k === "SLay").length).toBe(6);
    expect(kinds.filter((k) => k === "CLay").length).toBe(3);
  });

  test("test_comp_params_patched_into_template", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const comp = app.project.rootFolder.addComp("OtherComp", 1920, 1080, 2.0, 4.5, 23.976);
    const comp_id = comp.id;
    const rifx = _saved_rifx(app, tmp_path);
    const item = _find_comp_item(rifx, "OtherComp");
    const cdta = find_by_type(item.chunks, "cdta");
    expect(cdta.width).toBe(1920);
    expect(cdta.height).toBe(1080);
    expect(cdta.pixel_aspect).toBe(2.0);
    expect(cdta.internal_timebase).toBe(23976);
    const iide = find_by_type(item.chunks, "iide");
    const idta = find_by_type(item.chunks, "idta");
    expect(iide.value).toBe(comp_id);
    expect(idta.item_id).toBe(comp_id);
    // viewer pseudo-layers rebased onto the comp's timebase
    const bases = new Set(recursive_find(item.chunks, "tdb4").map((t) => t._time_base));
    expect(py_eq(bases, new Set([23976]))).toBe(true);
  });

  test("test_reparse_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const comp = app.project.rootFolder.addComp("RT", 1280, 720, 1.0, 10.0, 30.0);
    comp.addSolid([0.5, 0.5, 0.5], "S");
    const out = tmp_path.div("rt.aep");
    app.project.save(out);
    const app2 = parse_aep(out);
    const comp2 = app2.project.compositions.find((c) => c.name === "RT");
    if (comp2 == null) throw new StopIteration();
    expect(approx(comp2.frameRate, 30.0)).toBe(true);
    expect(py_eq(comp2.layers.map((lyr) => lyr.name), ["S"])).toBe(true);
  });
});

/** Test class TestNewCompPrda. */
describe("TestNewCompPrda", () => {
  test("test_new_comp_prda_is_classic_variant", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    app.project.rootFolder.addComp("PrdaComp", 1280, 720, 1.0, 10.0, 30.0);
    const rifx = _saved_rifx(app, tmp_path);
    const prda = _find_prda(rifx, "PrdaComp");
    expect(prda instanceof ClassicPrdaChunk).toBe(true);
    expect(as_instance(prda, ClassicPrdaChunk).shadow_map_resolution).toBe(0);
  });

  test("test_new_comp_prda_bytes_match_after_effects", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    app.project.rootFolder.addComp("PrdaComp", 1280, 720, 1.0, 10.0, 30.0);
    const rifx = _saved_rifx(app, tmp_path);
    const buf = new BytesIO();
    _find_prda(rifx, "PrdaComp").write(buf);
    expect(py_eq(buf.getvalue(), PRDA_CLASSIC_DEFAULT)).toBe(true);
  });
});
