/**
 * New items and layers carry the chunk set of the project's AE version.
 *
 * Each AE release writes a slightly different chunk set for a new comp,
 * folder, footage item or layer. These tests build `py_aep.new(<version>)`
 * plus one item / layer of each kind and compare what py writes against the
 * `samples/versions/aeYYYY/complete.aep` project that same After Effects
 * release saved. AE 2022-2026 write the same structures for freshly created
 * items and layers (measured headlessly: `addComp`, `addFolder`, `addSolid`,
 * `addNull`, `addCamera`, `addLight`, `addText`, `addShape`, `importFile` +
 * `layers.add` on an opened `py_aep.new()` project). AE 15 (CC 2018) cannot
 * run scripts headless; its resave of a `py_aep.new("15.1x69")` composition
 * agrees with its sample on the item and layer chunk lists.
 */

import { describe, expect, test } from "bun:test";
import {
  BytesIO,
  bytes_,
  getitem,
  len,
  lru_cache,
  Path,
  py_assert,
  py_bool,
  py_eq,
  setdefault,
  sorted,
  tkey,
} from "../../src/pyrt/index.ts";
import { make_tmp_path } from "../../src/pyrt/pytest.ts";
import * as py_aep from "../../src/py_aep/index.ts";
import { ImportOptions } from "../../src/py_aep/index.ts";
import { ListChunk, read_aep, type Chunk } from "../../src/py_aep/binary/chunk.ts";
import type { LdtaChunk } from "../../src/py_aep/binary/layer_chunks.ts";
import "../../src/py_aep/binary/_register.ts";

const SAMPLES = new Path(import.meta.path).parent.parent.parent.div("samples");
const VERSIONS = SAMPLES.div("versions");
const PNG = SAMPLES.div("assets", "image_with_alpha.png");

/** samples/versions folder -> the version its complete.aep was saved with. */
const RELEASES: Record<string, string> = {
  ae2018: "15.1x69",
  ae2022: "22.5x53",
  ae2023: "23.6x62",
  ae2024: "24.6x2",
  ae2025: "25.6x101",
  ae2026: "26.0x67",
};

const _VIEW_LISTS = ["DLay", "SLay", "CLay", "SecL"];
const _VIEW_SEPTET = ["fvdv", "fiop", "ftts", "foac", "fiac", "fipc", "fifl"];

// Parametrize rows: the `year` fixture (module scope, one value per release)
// crossed with the other parametrize arguments, as pytest does.
const YEARS = sorted(Object.keys(RELEASES));
const YEAR_ROWS = YEARS.map((year) => [year]);
const ITEM_ROWS = YEARS.flatMap((year): [string, number, string][] => [
  [year, 1, "folder"],
  [year, 4, "comp"],
  [year, 7, "footage"],
]);
const RELEASE_VERSIONS = sorted(Object.values(RELEASES));

function _tag(chunk: Chunk): string {
  if (chunk instanceof ListChunk) {
    return `LIST:${chunk.list_type}`;
  }
  if (chunk.chunk_type === "tdmn") {
    // `value` exists only on the tdmn chunk subclass.
    return `tdmn=${(chunk as any).value}`;
  }
  return chunk.chunk_type;
}

/** Nested chunk tags with byte sizes (match names for `tdmn`). */
function _signature(chunk: Chunk): string[] {
  if (chunk instanceof ListChunk) {
    const lines = [_tag(chunk)];
    for (const child of chunk.chunks) {
      lines.push(..._signature(child).map((line) => "  " + line));
    }
    return lines;
  }
  if (chunk.chunk_type === "tdmn") {
    return [_tag(chunk)];
  }
  return [`${chunk.chunk_type}(${len(chunk.tobytes())})`];
}

function* _walk(chunk: ListChunk): Generator<[ListChunk, number, Chunk]> {
  for (const [i, child] of chunk.chunks.entries()) {
    yield [chunk, i, child];
    if (child instanceof ListChunk && child.list_type !== "btdk") {
      yield* _walk(child);
    }
  }
}

/** Python `a <= b` on sets: every member of `a` is in `b`. */
function set_le(a: Set<any>, b: Set<any>): boolean {
  return [...a].every((x) => b.has(x));
}

/**
 * The version-sensitive structure of a saved project, by kind.
 *
 * Byte strings are kept as hex text so that Set membership compares by value,
 * as Python's set of bytes does.
 */
class _Structure {
  declare items: Map<number, Set<string>>;
  declare fee: Set<string>;
  declare view_layers: Map<string, string[]>;
  declare view_ldta_tails: Set<string>;
  declare shadow_colors: Set<string>;
  declare layers: Set<string>;
  declare groups: Map<number, Set<string>>;
  declare source_options: Set<string>;
  declare light_source_ids: Set<number>;

  constructor(rifx: ListChunk) {
    this.items = new Map();
    this.fee = new Set();
    this.view_layers = new Map();
    this.view_ldta_tails = new Set();
    this.shadow_colors = new Set();
    this.layers = new Set();
    this.groups = new Map();
    this.source_options = new Set();
    this.light_source_ids = new Set();
    for (const [parent, i, chunk] of _walk(rifx)) {
      if (!(chunk instanceof ListChunk)) {
        continue;
      }
      if (chunk.list_type === "Item") {
        this._add_item(chunk);
      } else if (chunk.list_type === "FEE ") {
        this.fee.add(chunk.chunks.map((c) => _tag(c)).join(" "));
      } else if (_VIEW_LISTS.includes(chunk.list_type)) {
        this._add_view_layer(chunk);
      } else if (chunk.list_type === "Layr") {
        this._add_layer(chunk);
      } else if (chunk.list_type === "tdgp" && i > 0) {
        const previous = parent.chunks[i - 1];
        if (_tag(previous) === "tdmn=ADBE Source Options Group") {
          this.source_options.add(chunk.chunks.map((c) => _tag(c)).join(" "));
        }
      } else if (chunk.list_type === "tdbs" && i > 0) {
        if (_tag(parent.chunks[i - 1]) === "tdmn=ADBE Shadow Color") {
          const cdat = chunk.chunks.find((c) => c.chunk_type === "cdat")!;
          this.shadow_colors.add(bytes_.hex(cdat.tobytes()));
        }
      }
    }
  }

  _add_item(item: ListChunk): void {
    const idta = item.chunks.find((c) => c.chunk_type === "idta")!;
    const tags: string[] = [];
    for (const child of item.chunks) {
      const tag = _tag(child);
      if (["LIST:Layr", "LIST:Ewst"].includes(tag) || _VIEW_SEPTET.includes(tag)) {
        continue;
      }
      if (!py_bool(tags) || tags.at(-1) !== tag) {
        tags.push(tag);
      }
    }
    const item_type = (idta as any).item_type;
    setdefault(this.items, item_type, new Set<string>()).add(tags.join(" "));
  }

  _add_view_layer(view: ListChunk): void {
    const ldta = view.chunks[0];
    const name = (view.chunks[1] as any).value;
    this.view_layers.set(tkey(view.list_type, name), _signature(view));
    this.view_ldta_tails.add(
      tkey(view.list_type, bytes_.hex(bytes_.slice(ldta.tobytes(), 147, 160))),
    );
  }

  _add_layer(layer: ListChunk): void {
    const ldta = layer.chunks[0] as LdtaChunk;
    this.layers.add(
      layer.chunks
        .filter((c) => c.chunk_type !== "cmta")
        .map((c) => _tag(c))
        .join(" "),
    );
    const tdgp = layer.chunks.find((c) => _tag(c) === "LIST:tdgp")!;
    const groups = (tdgp as ListChunk).chunks
      // A new shape layer has no contents yet; AE's samples have some.
      .filter((c) => c.chunk_type === "tdmn" && _tag(c) !== "tdmn=ADBE Root Vectors Group")
      .map((c) => _tag(c));
    setdefault(this.groups, ldta.layer_type, new Set<string>()).add(groups.join(" "));
    if (ldta.layer_type === 1) {
      // light
      this.light_source_ids.add(ldta.source_id);
    }
  }
}

function _read(path: Path): ListChunk {
  const [rifx, _xmp] = read_aep(new BytesIO(path.read_bytes()));
  return rifx;
}

const _after_effects = lru_cache(
  (year: string): _Structure => new _Structure(_read(VERSIONS.div(year, "complete.aep"))),
);

/**
 * `new(version)` plus one new item / layer of each kind, as the AE
 * probe built them.
 */
function _new_project(version: string): py_aep.Application {
  const app = py_aep.new(version);
  const project = app.project;
  const comp = project.root_folder.add_comp("Comp 1", 320, 240, 1.0, 2.0, 25.0);
  project.root_folder.add_folder("Folder 1");
  comp.add_solid([1.0, 0.0, 0.0], "Red", 320, 240);
  comp.add_null();
  comp.add_camera("Camera 1", [160.0, 120.0]);
  comp.add_light("Light 1", [160.0, 120.0]);
  comp.add_text("Hello");
  comp.add_shape();
  comp.add(project.import_file(new ImportOptions(PNG)));
  return app;
}

// Module-scoped fixture `written`: one saved-and-reread project per year.
const written = lru_cache((year: string): _Structure => {
  const dir = make_tmp_path().div(year);
  dir.mkdir({ parents: true, exist_ok: true });
  const path = dir.div("new.aep");
  _new_project(RELEASES[year]).project.save(path);
  return new _Structure(_read(path));
});

describe("TestNewItemsMatchTheRelease", () => {
  test.each(ITEM_ROWS)("test_item_chunks[%#]", (year, item_type, kind) => {
    // iide / idpc (all items) and comr, CIF3 and the Default view layer
    // (comps) are absent from AE 15 files.
    py_assert(
      set_le(getitem(written(year).items, item_type), getitem(_after_effects(year).items, item_type)),
      kind,
    );
  });

  test.each(YEAR_ROWS)("test_comp_view_data[%#]", (year) => {
    // The FEE list after a comp item holds ppSn, except in AE 15.
    expect(py_eq(written(year).fee, _after_effects(year).fee)).toBe(true);
  });

  test.each(YEAR_ROWS)("test_view_layers[%#]", (year) => {
    // Same viewer pseudo-layers, each with the chunk tree that release
    // writes (AE 15 adds a layer-level OvdG and lacks Layer Sets; AE 15-23
    // leave 11 Material Options properties out of the Markers layer).
    const expected = _after_effects(year).view_layers;
    const actual = written(year).view_layers;
    expect(py_eq(new Set(actual.keys()), new Set(expected.keys()))).toBe(true);
    for (const [key, signature] of actual) {
      py_assert(py_eq(signature, getitem(expected, key)), key);
    }
  });

  test.each(YEAR_ROWS)("test_view_layer_ldta_tail[%#]", (year) => {
    // Only AE 26 stamps 1 / 102.047... at 0x94 / 0x98 of the viewer
    // layers' records.
    expect(py_eq(written(year).view_ldta_tails, _after_effects(year).view_ldta_tails)).toBe(true);
  });

  test.each(YEAR_ROWS)("test_markers_shadow_color[%#]", (year) => {
    // AE 24 writes the Markers layer's Shadow Color alpha as 0, AE 25+
    // as 255; earlier releases do not write the property.
    expect(py_eq(written(year).shadow_colors, _after_effects(year).shadow_colors)).toBe(true);
  });

  test.each(YEAR_ROWS)("test_layer_chunks[%#]", (year) => {
    // AE 15 closes every layer with a LIST:OvdG.
    py_assert(set_le(written(year).layers, _after_effects(year).layers));
  });

  test.each(YEAR_ROWS)("test_layer_groups[%#]", (year) => {
    // AE 15 layers have no Layer Sets and no Source Options group.
    const expected = _after_effects(year).groups;
    for (const [layer_type, groups] of written(year).groups) {
      py_assert(set_le(groups, getitem(expected, layer_type)), String(layer_type));
    }
  });

  test.each(YEAR_ROWS)("test_source_alternate[%#]", (year) => {
    // AE 22 writes the Layer Source Alternate match name and its
    // blsv/blsi pair but no value (tdbs); AE 23+ write the value.
    py_assert(set_le(written(year).source_options, _after_effects(year).source_options));
  });

  test.each(YEAR_ROWS)("test_light_source_id[%#]", (year) => {
    // AE 15-22 store 0 as a light layer's source id, AE 23+ 0xFFFFFFFF.
    expect(py_eq(written(year).light_source_ids, _after_effects(year).light_source_ids)).toBe(true);
  });
});

test.each(RELEASE_VERSIONS)("test_gated_project_round_trips[%#]", (version) => {
  const tmp_path = make_tmp_path();
  const first = tmp_path.div("first.aep");
  const second = tmp_path.div("second.aep");
  _new_project(version).project.save(first);
  py_aep.parse(first).project.save(second);
  expect(py_eq(first.read_bytes(), second.read_bytes())).toBe(true);
});

test("test_layer_comment_written_before_ovdg", () => {
  const tmp_path = make_tmp_path();
  // AE 15 keeps a layer's comment ahead of the LIST:OvdG closing the layer.
  const sample = _read(VERSIONS.div("ae2018", "complete.aep"));
  const commented = new Set<string>();
  for (const [_parent, _i, chunk] of _walk(sample)) {
    if (
      chunk instanceof ListChunk &&
      chunk.list_type === "Layr" &&
      chunk.chunks.some((c) => c.chunk_type === "cmta")
    ) {
      commented.add(chunk.chunks.map((c) => _tag(c)).join(" "));
    }
  }
  const app = py_aep.new(RELEASES.ae2018);
  const comp = app.project.root_folder.add_comp("Comp 1", 320, 240, 1.0, 2.0, 25.0);
  comp.add_solid([1.0, 0.0, 0.0], "Red", 320, 240).comment = "note";
  const path = tmp_path.div("comment.aep");
  app.project.save(path);
  const saved = new Set<string>();
  for (const [_parent, _i, chunk] of _walk(_read(path))) {
    if (chunk instanceof ListChunk && chunk.list_type === "Layr") {
      saved.add(chunk.chunks.map((c) => _tag(c)).join(" "));
    }
  }
  expect(py_eq(saved, commented)).toBe(true);
});
