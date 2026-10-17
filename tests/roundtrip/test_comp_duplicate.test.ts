/**
 * CompItem.duplicate() validated against After Effects' own duplicate.
 *
 * `samples/models/composition/duplicate.aep` carries the ground truth: comp
 * `DupSrc` (parenting, track matte, expression pick-whip, a Set Matte
 * layer-param effect, an Essential Graphics slider controller, and a precomp
 * layer `Inner` with an Essential Properties override) together with AE
 * 2026's own `comp.duplicate()` result `DupSrc 2` of that same comp. py's
 * duplicate of `DupSrc` must be reference-graph-isomorphic to AE's (ids are
 * free variables) and byte-identical after id/uuid normalization, up to
 * three AE-confirmed non-necessary families that AE's own resave also
 * normalizes: `cdta.time_divisor` (re-derived), viewer-pseudo-layer
 * `tdb4._expr_flags` (zeroed), and the layer-level `LIST:parT` effect param
 * defs (stripped as redundant with project-level `EfdG`; py keeps the clone
 * since it is necessary for uninstalled effects).
 *
 * Regenerate the fixture with `scripts/jsx/generate_duplicate_sample.jsx`.
 */

import { describe, expect, test } from "bun:test";
import {
  AssertionError_,
  at,
  b,
  BytesIO,
  bytes_,
  contains,
  dict_get,
  enumerate,
  getitem,
  len,
  max,
  Path,
  py_assert,
  py_bool,
  py_eq,
  StopIteration,
  zip,
} from "../../src/pyrt/index.ts";
import { make_tmp_path } from "../../src/pyrt/pytest.ts";
import { ListChunk } from "../../src/py_aep/binary/chunk.ts";
import type { Chunk } from "../../src/py_aep/binary/chunk.ts";
import "../../src/py_aep/binary/_register.ts";
import type { LdtaChunk } from "../../src/py_aep/binary/layer_chunks.ts";
import type { S4Chunk, Utf8Chunk } from "../../src/py_aep/binary/scalar_chunks.ts";
import { filter_by_list_type, filter_by_type, find_by_list_type, recursive_find } from "../../src/py_aep/binary/utils.ts";
import type { CompItem } from "../../src/py_aep/models/items/composition.ts";
import { FolderItem } from "../../src/py_aep/models/items/folder.ts";
import type { Property } from "../../src/py_aep/models/properties/property.ts";
import type { Project } from "../../src/py_aep/index.ts";
import { as_instance, parse_project_fresh } from "../helpers.ts";

const SAMPLE = new Path(import.meta.path).parent.parent.parent.div(
  "samples",
  "models",
  "composition",
  "duplicate.aep",
);
const EG_SAMPLE = new Path(import.meta.path).parent.parent.parent.div(
  "samples",
  "models",
  "essential_graphics",
  "media_replacement.aep",
);
const AE2018_SAMPLE = new Path(import.meta.path).parent.parent.parent.div(
  "samples",
  "versions",
  "ae2018",
  "complete.aep",
);

// NOTE(port): local stand-in for Python `next(genexpr)`; first match or StopIteration, as in CPython.
function next<T>(xs: Iterable<T>, pred: ((x: T) => boolean) | null = null): T {
  const it = xs[Symbol.iterator]();
  for (let r = it.next(); !r.done; r = it.next()) {
    if (pred === null || pred(r.value)) return r.value;
  }
  throw new StopIteration();
}

function _comp(project: Project, name: string): CompItem {
  return next(project.compositions, (c) => c.name === name);
}

function _ldta_in_order(comp: CompItem): LdtaChunk[] {
  return recursive_find(comp._item_list.chunks, "ldta").map((c) => c as LdtaChunk);
}

function _all_ids(project: Project): number[] {
  return [
    ...project.compositions.flatMap((comp) => _ldta_in_order(comp).map((ld) => ld.layer_id)),
    ...project.items.keys(),
  ];
}

/** Reference graph with layer ids as free variables (ldta positions). */
function _graph(comp: CompItem): Map<string, any> {
  const pos = new Map<number, number>(
    _ldta_in_order(comp).map((ld, i) => [ld.layer_id, i] as [number, number]),
  );
  const layers: Map<string, any>[] = [];
  for (const layer of comp.layers) {
    const ld = layer._ldta;
    const matte = ld.matte_layer_id;
    layers.push(
      new Map<string, any>([
        ["name", layer.name],
        ["parent", ld.parent_id ? dict_get(pos, ld.parent_id) : null],
        ["matte", matte ? dict_get(pos, matte) : null],
        ["source", ld.source_id],
        ["override_uuids", [...layer.essential_property_uuids]],
      ]),
    );
  }
  const tdpi = recursive_find(comp._item_list.chunks, "tdpi").map((c) => {
    const v = (c as S4Chunk).value;
    return dict_get(pos, v, ["ext", v]);
  });
  const eg = comp.motion_graphics_controllers.map(
    (ctrl) =>
      new Map<string, any>([
        ["name", ctrl.name],
        ["comp_is_self", ctrl.source_comp_id === comp.id],
        ["layer_pos", dict_get(pos, ctrl.source_layer_id || -1)],
      ]),
  );
  return new Map<string, any>([
    ["layers", layers],
    ["tdpi", tdpi],
    ["eg", eg],
  ]);
}

/** Every LIST:CCtl across the CIFO/CIF2/CIF3 containers, in order. */
function _cctls(comp: CompItem): ListChunk[] {
  const out: ListChunk[] = [];
  for (const cif of comp._item_list.chunks) {
    if (cif instanceof ListChunk && ["CIFO", "CIF2", "CIF3"].includes(cif.list_type)) {
      out.push(...filter_by_list_type(cif.chunks, "CCtl"));
    }
  }
  return out;
}

function _chunk_bytes(chunk: Chunk): Uint8Array {
  const buf = new BytesIO();
  chunk.write(buf);
  return buf.getvalue();
}

describe("TestDuplicateAgainstAE", () => {
  test("test_reference_graph_isomorphic_to_ae", () => {
    const project = parse_project_fresh(SAMPLE);
    const py_dup = _comp(project, "DupSrc").duplicate();
    const ae_dup = _comp(project, "DupSrc 2");
    expect(py_eq(_graph(py_dup), _graph(ae_dup))).toBe(true);
  });

  test("test_id_uniqueness_and_counter_invariant", () => {
    const project = parse_project_fresh(SAMPLE);
    _comp(project, "DupSrc").duplicate();
    const ids = _all_ids(project);
    expect(len(ids)).toBe(len(new Set(ids)));
    // AE trusts head.next_item_id on open without rescanning (probed in
    // AE 2026): a counter at or below a live id makes AE mint duplicate
    // ids, so the invariant is necessary.
    expect(project._head.next_item_id > max(ids)).toBe(true);
  });

  test("test_name_and_placement", () => {
    const project = parse_project_fresh(SAMPLE);
    const src = _comp(project, "DupSrc");
    const dup = src.duplicate();
    // AE numbering: "DupSrc 2" is taken by AE's own duplicate.
    expect(dup.name).toBe("DupSrc 3");
    const folder_items = as_instance(src.parent_folder, FolderItem).items;
    expect(folder_items.indexOf(dup)).toBe(folder_items.indexOf(src) + 1);
    expect(getitem(project.items, dup.id)).toBe(dup);
  });

  test("test_eg_controller_identity", () => {
    const project = parse_project_fresh(SAMPLE);
    const src = _comp(project, "DupSrc");
    const dup = src.duplicate();
    const src_uuids = new Set(src.motion_graphics_controllers.map((c) => c.uuid));
    const dup_ctrls = dup.motion_graphics_controllers;
    expect(len(dup_ctrls)).toBe(len(src.motion_graphics_controllers));
    const shared = [...new Set(dup_ctrls.map((c) => c.uuid))].filter((u) => src_uuids.has(u));
    expect(py_bool(shared)).toBe(false);
    // The three CIF containers must carry the SAME fresh uuid per
    // controller (AE keeps them in sync; matched by old uuid).
    const uuids_per_container = _cctls(dup).map(
      (c) => (at(filter_by_type(c.chunks, "Utf8"), 0) as Utf8Chunk).value,
    );
    expect(len(new Set(uuids_per_container))).toBe(len(dup_ctrls));
    // CCId retargeted at the duplicate; CVal/CDef zeroed like AE (the
    // cached controller value is re-derived by AE at runtime).
    for (const cctl of _cctls(dup)) {
      const cprp = find_by_list_type(cctl.chunks, "CPrp");
      const ccid = next(cprp.chunks, (c) => c.chunk_type === "CCId");
      expect((ccid as any).value).toBe(dup.id);
      for (const chunk of cctl.chunks) {
        if (["CVal", "CDef"].includes(chunk.chunk_type)) {
          expect(py_eq(chunk.data, bytes_.repeat(b("\x00"), len(chunk.data)))).toBe(true);
        }
      }
    }
  });

  test("test_sources_and_overrides_shared", () => {
    const project = parse_project_fresh(SAMPLE);
    const src = _comp(project, "DupSrc");
    const dup = src.duplicate();
    // Layer sources (solid footage, the Inner precomp) are shared.
    expect(py_eq(dup.layers.map((la) => la._ldta.source_id), src.layers.map((la) => la._ldta.source_id))).toBe(true);
    // Layer-side Essential Properties override uuids reference the
    // SOURCE comp's controllers and must stay verbatim.
    expect(
      py_eq(
        dup.layers.map((la) => la.essential_property_uuids),
        src.layers.map((la) => la.essential_property_uuids),
      ),
    ).toBe(true);
    // used_in gains the duplicate on every shared source.
    project._ensure_used_in_linked();
    const inner = _comp(project, "Inner");
    const dup2 = src.duplicate();
    expect(contains(inner._used_in, dup2)).toBe(true);
  });

  test("test_normalized_byte_parity_with_ae", () => {
    /**
     * After id/uuid/name normalization plus the three documented
     * AE-normalization families, every direct child chunk of the item
     * block is byte-identical to AE's own duplicate.
     */
    const project = parse_project_fresh(SAMPLE);
    const src = _comp(project, "DupSrc");
    const ae_dup = _comp(project, "DupSrc 2");
    const py_dup = src.duplicate();

    const py_ldta = _ldta_in_order(py_dup);
    const ae_ldta = _ldta_in_order(ae_dup);
    expect(len(py_ldta)).toBe(len(ae_ldta));
    // Both duplicates are clones of the same original, so ldta chunk
    // order is the exact pairing between their id spaces.
    const id_map = new Map<number, number>(
      zip(py_ldta, ae_ldta).map(([p, a]) => [p.layer_id, a.layer_id] as [number, number]),
    );
    id_map.set(py_dup.id, ae_dup.id);

    for (const ld of py_ldta) {
      ld.layer_id = getitem(id_map, ld.layer_id);
      if (id_map.has(ld.parent_id)) {
        ld.parent_id = getitem(id_map, ld.parent_id);
      }
      const matte = ld.matte_layer_id;
      if (matte != null && id_map.has(matte)) {
        ld.matte_layer_id = getitem(id_map, matte);
      }
    }
    for (const c of recursive_find(py_dup._item_list.chunks, "tdpi")) {
      const tdpi = c as S4Chunk;
      if (id_map.has(tdpi.value)) {
        tdpi.value = getitem(id_map, tdpi.value);
      }
    }
    const py_idta = py_dup._idta;
    if (py_idta == null) throw new AssertionError_("duplicate has no idta chunk");
    py_idta.item_id = ae_dup.id;
    for (const chunk of py_dup._item_list.chunks) {
      if (chunk.chunk_type === "iide") {
        (chunk as any).value = ae_dup.id;
      }
    }
    for (const [py_c, ae_c] of zip(_cctls(py_dup), _cctls(ae_dup))) {
      const py_u = filter_by_type(py_c.chunks, "Utf8");
      const ae_u = filter_by_type(ae_c.chunks, "Utf8");
      (at(py_u, 0) as Utf8Chunk).value = (at(ae_u, 0) as Utf8Chunk).value;
      // CCId/CLId map through the same id pairing - a semantic remap,
      // not a copy from AE.
      const cprp = find_by_list_type(py_c.chunks, "CPrp");
      for (const chunk of cprp.chunks) {
        if (["CCId", "CLId"].includes(chunk.chunk_type)) {
          const ref = chunk as any;
          if (id_map.has(ref.value)) {
            ref.value = getitem(id_map, ref.value);
          }
        }
      }
    }
    py_dup.name = ae_dup.name;
    // Documented family 1: AE re-derives the comp's time divisor; AE
    // accepts either value (its resave keeps py's).
    py_dup._cdta.time_divisor = ae_dup._cdta.time_divisor;
    // Documented family 2: AE zeroes the stale viewer-pseudo-layer
    // expression-flags byte; AE's own resave zeroes it everywhere.
    const ae_flags = recursive_find(ae_dup._item_list.chunks, "tdb4").map(
      (t) => (t as any)._expr_flags,
    )[Symbol.iterator]();
    for (const t of recursive_find(py_dup._item_list.chunks, "tdb4")) {
      (t as any)._expr_flags = next(ae_flags);
    }
    // Documented family 3: AE strips layer-level parT effect param
    // defs (redundant with EfdG); py keeps them - they are the only
    // param source for uninstalled effects. Align for the comparison.
    const py_part = recursive_find(py_dup._item_list.chunks, null, "parT");
    const ae_part = recursive_find(ae_dup._item_list.chunks, null, "parT");
    expect(len(py_part)).toBe(len(ae_part));
    for (const [py_p, ae_p] of zip(py_part, ae_part)) {
      (py_p as ListChunk).chunks = [...(ae_p as ListChunk).chunks];
    }

    const ae_children = ae_dup._item_list.chunks;
    const py_children = py_dup._item_list.chunks;
    expect(len(ae_children)).toBe(len(py_children));
    for (const [i, [a, p]] of enumerate(zip(ae_children, py_children))) {
      py_assert(py_eq(_chunk_bytes(a), _chunk_bytes(p)), `child ${i} differs`);
    }
  });

  test("test_roundtrip_reparse", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLE);
    const dup_name = _comp(project, "DupSrc").duplicate().name;
    const out = tmp_path.div("dup.aep");
    project.save(out);

    const project2 = parse_project_fresh(out);
    const dup = _comp(project2, dup_name);
    const a = next(dup.layers, (la) => la.name === "A");
    const b_ = next(dup.layers, (la) => la.name === "B");
    expect(b_.parent).toBe(a);
    expect(a._ldta.matte_layer_id).toBe(b_.id);
    expect(py_bool(a.transform.property("ADBE Opacity").expression_enabled)).toBe(true);
    const inner_layer = next(dup.layers, (la) => la.name === "Inner");
    const overrides: any = next(
      inner_layer.properties,
      (p) => p.match_name === "ADBE Layer Overrides",
    );
    expect(py_eq(overrides.properties.map((p: Property) => p.value), [42.0])).toBe(true);
    expect(py_eq(dup.motion_graphics_controllers.map((c) => c.source_comp_id), [dup.id])).toBe(true);
    const ids = _all_ids(project2);
    expect(len(ids)).toBe(len(new Set(ids)));
    expect(project2._head.next_item_id > max(ids)).toBe(true);
  });
});

describe("TestDuplicateEdgeCases", () => {
  test("test_media_replacement_blsi_kept", () => {
    const tmp_path = make_tmp_path();
    // The alternate-source slot's blsi holds an ITEM id (the wrapper
    // comp) - shared with the original, never remapped.
    const project = parse_project_fresh(EG_SAMPLE);
    const host = _comp(project, "image_with_alpha 2");
    const original = next(host.layers, (la) => py_bool(la.essential_property_uuids));
    const orig_alt: any = at(
      (next(original.properties, (p) => p.match_name === "ADBE Layer Overrides") as any).properties,
      0,
    );
    expect(orig_alt.alternate_source != null).toBe(true);

    const dup = host.duplicate();
    const out = tmp_path.div("dup.aep");
    project.save(out);

    const project2 = parse_project_fresh(out);
    const dup2 = _comp(project2, dup.name);
    const layer = next(dup2.layers, (la) => py_bool(la.essential_property_uuids));
    expect(py_eq(layer.essential_property_uuids, original.essential_property_uuids)).toBe(true);
    const alt: any = at(
      (next(layer.properties, (p) => p.match_name === "ADBE Layer Overrides") as any).properties,
      0,
    );
    expect(alt.can_set_alternate_source).toBe(true);
    expect(alt.alternate_source != null).toBe(true);
    expect(alt.alternate_source.id).toBe(orig_alt.alternate_source.id);
  });

  test("test_pre_ae23_no_matte_field", () => {
    // Pre-AE23 ldta has no matte_layer_id (None) - duplicate must not
    // materialize the optional field.
    const project = parse_project_fresh(AE2018_SAMPLE);
    const src = next(project.compositions, (c) => py_bool(c.layers));
    const dup = src.duplicate();
    expect(dup.num_layers).toBe(src.num_layers);
    expect(_ldta_in_order(dup).every((ld) => ld.matte_layer_id == null)).toBe(true);
    const ids = _all_ids(project);
    expect(len(ids)).toBe(len(new Set(ids)));
  });
});
