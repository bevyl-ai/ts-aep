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
  dictGet,
  enumerate,
  getitem,
  len,
  max,
  Path,
  pyAssert,
  pyBool,
  pyEq,
  StopIteration,
  zip,
} from "../../src/pyrt/index.ts";
import { makeTmpPath } from "../../src/pyrt/pytest.ts";
import { ListChunk } from "../../src/py_aep/binary/chunk.ts";
import type { Chunk } from "../../src/py_aep/binary/chunk.ts";
import "../../src/py_aep/binary/_register.ts";
import type { LdtaChunk } from "../../src/py_aep/binary/layer_chunks.ts";
import { U4Chunk, U4LeChunk } from "../../src/py_aep/binary/scalar_chunks.ts";
import { filterByListType, filterByType, findByListType, recursiveFind } from "../../src/py_aep/binary/utils.ts";
import type { CompItem } from "../../src/py_aep/models/items/composition.ts";
import { FolderItem } from "../../src/py_aep/models/items/folder.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";
import type { Project } from "../../src/py_aep/index.ts";
import { asInstance, parseProjectFresh } from "../helpers.ts";

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

function _ldtaInOrder(comp: CompItem): LdtaChunk[] {
  return recursiveFind(comp._item_list.chunks, "ldta");
}

function _allIds(project: Project): number[] {
  return [
    ...project.compositions.flatMap((comp) => _ldtaInOrder(comp).map((ld) => ld.layer_id)),
    ...project.items.keys(),
  ];
}

/** Reference graph with layer ids as free variables (ldta positions). */
function _graph(comp: CompItem): Map<string, unknown> {
  const pos = new Map<number, number>(
    _ldtaInOrder(comp).map((ld, i): [number, number] => [ld.layer_id, i]),
  );
  const layers: Map<string, unknown>[] = [];
  for (const layer of comp.layers) {
    const ld = layer._ldta;
    const matte = ld.matte_layer_id;
    layers.push(
      new Map<string, unknown>([
        ["name", layer.name],
        ["parent", ld.parent_id ? dictGet(pos, ld.parent_id) : null],
        ["matte", matte ? dictGet(pos, matte) : null],
        ["source", ld.source_id],
        ["override_uuids", [...layer.essentialPropertyUuids]],
      ]),
    );
  }
  const tdpi = recursiveFind(comp._item_list.chunks, "tdpi").map((c) => {
    const v = c.value;
    return dictGet(pos, v, ["ext", v]);
  });
  const eg = comp.motionGraphicsControllers.map(
    (ctrl) =>
      new Map<string, unknown>([
        ["name", ctrl.name],
        ["comp_is_self", ctrl.sourceCompId === comp.id],
        ["layer_pos", dictGet(pos, ctrl.sourceLayerId || -1)],
      ]),
  );
  return new Map<string, unknown>([
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
      out.push(...filterByListType(cif.chunks, "CCtl"));
    }
  }
  return out;
}

function _chunkBytes(chunk: Chunk): Uint8Array {
  const buf = new BytesIO();
  chunk.write(buf);
  return buf.getvalue();
}

describe("TestDuplicateAgainstAE", () => {
  test("test_reference_graph_isomorphic_to_ae", () => {
    const project = parseProjectFresh(SAMPLE);
    const pyDup = _comp(project, "DupSrc").duplicate();
    const aeDup = _comp(project, "DupSrc 2");
    expect(pyEq(_graph(pyDup), _graph(aeDup))).toBe(true);
  });

  test("test_id_uniqueness_and_counter_invariant", () => {
    const project = parseProjectFresh(SAMPLE);
    _comp(project, "DupSrc").duplicate();
    const ids = _allIds(project);
    expect(len(ids)).toBe(len(new Set(ids)));
    // AE trusts head.next_item_id on open without rescanning (probed in
    // AE 2026): a counter at or below a live id makes AE mint duplicate
    // ids, so the invariant is necessary.
    expect(project._head.next_item_id > max(ids)).toBe(true);
  });

  test("test_name_and_placement", () => {
    const project = parseProjectFresh(SAMPLE);
    const src = _comp(project, "DupSrc");
    const dup = src.duplicate();
    // AE numbering: "DupSrc 2" is taken by AE's own duplicate.
    expect(dup.name).toBe("DupSrc 3");
    const folderItems = asInstance(src.parentFolder, FolderItem).items;
    expect(folderItems.indexOf(dup)).toBe(folderItems.indexOf(src) + 1);
    expect(getitem(project.items, dup.id)).toBe(dup);
  });

  test("test_eg_controller_identity", () => {
    const project = parseProjectFresh(SAMPLE);
    const src = _comp(project, "DupSrc");
    const dup = src.duplicate();
    const srcUuids = new Set(src.motionGraphicsControllers.map((c) => c.uuid));
    const dupCtrls = dup.motionGraphicsControllers;
    expect(len(dupCtrls)).toBe(len(src.motionGraphicsControllers));
    const shared = [...new Set(dupCtrls.map((c) => c.uuid))].filter((u) => srcUuids.has(u));
    expect(pyBool(shared)).toBe(false);
    // The three CIF containers must carry the SAME fresh uuid per
    // controller (AE keeps them in sync; matched by old uuid).
    const uuidsPerContainer = _cctls(dup).map(
      (c) => at(filterByType(c.chunks, "Utf8"), 0).value,
    );
    expect(len(new Set(uuidsPerContainer))).toBe(len(dupCtrls));
    // CCId retargeted at the duplicate; CVal/CDef zeroed like AE (the
    // cached controller value is re-derived by AE at runtime).
    for (const cctl of _cctls(dup)) {
      const cprp = findByListType(cctl.chunks, "CPrp");
      const ccid = next(filterByType(cprp.chunks, "CCId"));
      expect(ccid.value).toBe(dup.id);
      for (const chunk of cctl.chunks) {
        if (["CVal", "CDef"].includes(chunk.chunk_type)) {
          expect(pyEq(chunk.data, bytes_.repeat(b("\x00"), len(chunk.data)))).toBe(true);
        }
      }
    }
  });

  test("test_sources_and_overrides_shared", () => {
    const project = parseProjectFresh(SAMPLE);
    const src = _comp(project, "DupSrc");
    const dup = src.duplicate();
    // Layer sources (solid footage, the Inner precomp) are shared.
    expect(pyEq(dup.layers.map((la) => la._ldta.source_id), src.layers.map((la) => la._ldta.source_id))).toBe(true);
    // Layer-side Essential Properties override uuids reference the
    // SOURCE comp's controllers and must stay verbatim.
    expect(
      pyEq(
        dup.layers.map((la) => la.essentialPropertyUuids),
        src.layers.map((la) => la.essentialPropertyUuids),
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
    const project = parseProjectFresh(SAMPLE);
    const src = _comp(project, "DupSrc");
    const aeDup = _comp(project, "DupSrc 2");
    const pyDup = src.duplicate();

    const pyLdta = _ldtaInOrder(pyDup);
    const aeLdta = _ldtaInOrder(aeDup);
    expect(len(pyLdta)).toBe(len(aeLdta));
    // Both duplicates are clones of the same original, so ldta chunk
    // order is the exact pairing between their id spaces.
    const idMap = new Map<number, number>(
      zip(pyLdta, aeLdta).map(([p, a]): [number, number] => [p.layer_id, a.layer_id]),
    );
    idMap.set(pyDup.id, aeDup.id);

    for (const ld of pyLdta) {
      ld.layer_id = getitem(idMap, ld.layer_id);
      if (idMap.has(ld.parent_id)) {
        ld.parent_id = getitem(idMap, ld.parent_id);
      }
      const matte = ld.matte_layer_id;
      if (matte != null && idMap.has(matte)) {
        ld.matte_layer_id = getitem(idMap, matte);
      }
    }
    for (const tdpi of recursiveFind(pyDup._item_list.chunks, "tdpi")) {
      if (idMap.has(tdpi.value)) {
        tdpi.value = getitem(idMap, tdpi.value);
      }
    }
    const pyIdta = pyDup._idta;
    if (pyIdta == null) throw new AssertionError_("duplicate has no idta chunk");
    pyIdta.item_id = aeDup.id;
    for (const chunk of pyDup._item_list.chunks) {
      if (chunk.chunk_type === "iide") {
        asInstance(chunk, U4LeChunk).value = aeDup.id;
      }
    }
    for (const [pyC, aeC] of zip(_cctls(pyDup), _cctls(aeDup))) {
      const pyU = filterByType(pyC.chunks, "Utf8");
      const aeU = filterByType(aeC.chunks, "Utf8");
      at(pyU, 0).value = at(aeU, 0).value;
      // CCId/CLId map through the same id pairing - a semantic remap,
      // not a copy from AE.
      const cprp = findByListType(pyC.chunks, "CPrp");
      for (const chunk of cprp.chunks) {
        if (["CCId", "CLId"].includes(chunk.chunk_type)) {
          const ref = asInstance(chunk, U4Chunk);
          if (idMap.has(ref.value)) {
            ref.value = getitem(idMap, ref.value);
          }
        }
      }
    }
    pyDup.name = aeDup.name;
    // Documented family 1: AE re-derives the comp's time divisor; AE
    // accepts either value (its resave keeps py's).
    pyDup._cdta.time_divisor = aeDup._cdta.time_divisor;
    // Documented family 2: AE zeroes the stale viewer-pseudo-layer
    // expression-flags byte; AE's own resave zeroes it everywhere.
    const aeFlags = recursiveFind(aeDup._item_list.chunks, "tdb4").map(
      (t) => t._expr_flags,
    )[Symbol.iterator]();
    for (const t of recursiveFind(pyDup._item_list.chunks, "tdb4")) {
      t._expr_flags = next(aeFlags);
    }
    // Documented family 3: AE strips layer-level parT effect param
    // defs (redundant with EfdG); py keeps them - they are the only
    // param source for uninstalled effects. Align for the comparison.
    const pyPart = recursiveFind(pyDup._item_list.chunks, null, "parT");
    const aePart = recursiveFind(aeDup._item_list.chunks, null, "parT");
    expect(len(pyPart)).toBe(len(aePart));
    for (const [pyP, aeP] of zip(pyPart, aePart)) {
      asInstance(pyP, ListChunk).chunks = [...asInstance(aeP, ListChunk).chunks];
    }

    const aeChildren = aeDup._item_list.chunks;
    const pyChildren = pyDup._item_list.chunks;
    expect(len(aeChildren)).toBe(len(pyChildren));
    for (const [i, [a, p]] of enumerate(zip(aeChildren, pyChildren))) {
      pyAssert(pyEq(_chunkBytes(a), _chunkBytes(p)), `child ${i} differs`);
    }
  });

  test("test_roundtrip_reparse", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLE);
    const dupName = _comp(project, "DupSrc").duplicate().name;
    const out = tmpPath.div("dup.aep");
    project.save(out);

    const project2 = parseProjectFresh(out);
    const dup = _comp(project2, dupName);
    const a = next(dup.layers, (la) => la.name === "A");
    const b_ = next(dup.layers, (la) => la.name === "B");
    expect(b_.parent).toBe(a);
    expect(a._ldta.matte_layer_id).toBe(b_.id);
    expect(pyBool(a.transform.property("ADBE Opacity").expressionEnabled)).toBe(true);
    const innerLayer = next(dup.layers, (la) => la.name === "Inner");
    const overrides = asInstance(
      next(innerLayer.properties, (p) => p.matchName === "ADBE Layer Overrides"),
      PropertyGroup,
    );
    expect(pyEq(overrides.properties.map((p) => asInstance(p, Property).value), [42.0])).toBe(true);
    expect(pyEq(dup.motionGraphicsControllers.map((c) => c.sourceCompId), [dup.id])).toBe(true);
    const ids = _allIds(project2);
    expect(len(ids)).toBe(len(new Set(ids)));
    expect(project2._head.next_item_id > max(ids)).toBe(true);
  });
});

describe("TestDuplicateEdgeCases", () => {
  test("test_media_replacement_blsi_kept", () => {
    const tmpPath = makeTmpPath();
    // The alternate-source slot's blsi holds an ITEM id (the wrapper
    // comp) - shared with the original, never remapped.
    const project = parseProjectFresh(EG_SAMPLE);
    const host = _comp(project, "image_with_alpha 2");
    const original = next(host.layers, (la) => pyBool(la.essentialPropertyUuids));
    const origAlt = asInstance(
      at(
        asInstance(next(original.properties, (p) => p.matchName === "ADBE Layer Overrides"), PropertyGroup).properties,
        0,
      ),
      Property,
    );
    pyAssert(origAlt.alternateSource != null);

    const dup = host.duplicate();
    const out = tmpPath.div("dup.aep");
    project.save(out);

    const project2 = parseProjectFresh(out);
    const dup2 = _comp(project2, dup.name);
    const layer = next(dup2.layers, (la) => pyBool(la.essentialPropertyUuids));
    expect(pyEq(layer.essentialPropertyUuids, original.essentialPropertyUuids)).toBe(true);
    const alt = asInstance(
      at(asInstance(next(layer.properties, (p) => p.matchName === "ADBE Layer Overrides"), PropertyGroup).properties, 0),
      Property,
    );
    expect(alt.canSetAlternateSource).toBe(true);
    pyAssert(alt.alternateSource != null);
    expect(alt.alternateSource.id).toBe(origAlt.alternateSource.id);
  });

  test("test_pre_ae23_no_matte_field", () => {
    // Pre-AE23 ldta has no matte_layer_id (None) - duplicate must not
    // materialize the optional field.
    const project = parseProjectFresh(AE2018_SAMPLE);
    const src = next(project.compositions, (c) => pyBool(c.layers));
    const dup = src.duplicate();
    expect(dup.numLayers).toBe(src.numLayers);
    expect(_ldtaInOrder(dup).every((ld) => ld.matte_layer_id == null)).toBe(true);
    const ids = _allIds(project);
    expect(len(ids)).toBe(len(new Set(ids)));
  });
});
