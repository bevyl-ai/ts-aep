/**
 * A new footage source's `LIST:CLRS` holds the records of the project's
 * file version.
 *
 * `clrs_ae2022.aep` ... `clrs_ae2025.aep` are AE 2022-2025's own scripted
 * imports, each into an empty `py_aep.new` project of its version, of an
 * ICC-tagged PNG, an untagged PNG, a TIFF, a JPEG and an Illustrator file (items
 * named after the keys of `_FILES`); `samples/versions/ae20XX/complete.aep`
 * hold AE's own solids. AE 2025 (file version 96.9) and later end every CLRS
 * with the `hdrm` pair; AE 2022-2024 do not (they open a file that has it and
 * drop it when they save). The `mcsp` pair of an embedded profile is written
 * by all four.
 */

import "../../src/py_aep/binary/_register.ts";
import { expect, test } from "bun:test";
import { as_instance, parse_project } from "../helpers.ts";
import { FootageItem } from "../../src/py_aep/models/items/footage.ts";
import * as py_aep from "../../src/py_aep/index.ts";
import { parse as parse_aep } from "../../src/py_aep/index.ts";
import { ImportOptions } from "../../src/py_aep/models/import_options.ts";
import type { FootageSource } from "../../src/py_aep/models/sources/footage.ts";
import { SolidSource } from "../../src/py_aep/models/sources/solid.ts";
import { getitem, Path, py_assert, py_eq, sorted, StopIteration } from "../../src/pyrt/index.ts";
import { make_tmp_path } from "../../src/pyrt/pytest.ts";

// `Path(__file__).parent.parent.parent / "samples"`: `import.meta.dir` is already
// the directory of this file (tests/roundtrip), so two `.parent` reach the package root.
const SAMPLES = new Path(import.meta.dir).parent.parent.div("samples");
const ASSETS = SAMPLES.div("assets");
const IMPORT_DIR = SAMPLES.div("models", "import");

/** The version each fixture's release stamps (`samples/versions`). */
const _VERSIONS = new Map<number, string>([
  [2022, "22.5x53"],
  [2023, "23.6x62"],
  [2024, "24.6x2"],
  [2025, "25.6x101"],
]);

/**
 * Left out: `ai.ai`, for which AE 2022-2024 also write a `dcui` flag that
 * py_aep does not (they write it back on save).
 */
const _FILES = new Map<string, Path>([
  ["png_icc", ASSETS.div("image_with_alpha.png")],
  ["png_plain", ASSETS.div("depth", "png_rgb8.png")],
  ["tif", ASSETS.div("8bits.tif")],
  ["jpg", ASSETS.div("11_progressive.jpg")],
]);

function _shape(source: FootageSource): string[] {
  py_assert(source._clrs != null);
  return source._clrs.chunks.map((chunk) => chunk.chunk_type);
}

// Stacked `@pytest.mark.parametrize` decorators: the cartesian product of
// years and labels, one `test.each` row per pair.
const import_rows: [number, string][] = [];
for (const year of sorted(_VERSIONS.keys())) {
  for (const label of sorted(_FILES.keys())) {
    import_rows.push([year, label]);
  }
}

test.each(import_rows)("test_import_writes_the_versions_color_records[%#]", (year, label) => {
  const tmp_path = make_tmp_path();
  const ae = new Map(
    parse_project(IMPORT_DIR.div(`clrs_ae${year}.aep`)).footages.map(
      (item) => [item.name, item.main_source] as const,
    ),
  );
  const project = py_aep.new(getitem(_VERSIONS, year), { platform: "windows" }).project;
  const item = project.import_file(new ImportOptions(getitem(_FILES, label)));
  const out = tmp_path.div("clrs.aep");
  project.save(out);
  const ours = as_instance(getitem(parse_aep(out).project.items, item.id), FootageItem).main_source;
  expect(py_eq(_shape(ours), _shape(getitem(ae, label)))).toBe(true);
});

test.each(sorted(_VERSIONS.keys()))("test_new_solid_writes_the_versions_color_records[%#]", (year) => {
  const tmp_path = make_tmp_path();
  // `next(...)` over a generator: the first footage whose source is a solid.
  const ae = parse_project(SAMPLES.div("versions", `ae${year}`, "complete.aep"))
    .footages.map((item) => item.main_source)
    .find((source) => source instanceof SolidSource);
  if (ae === undefined) throw new StopIteration();
  const project = py_aep.new(getitem(_VERSIONS, year), { platform: "windows" }).project;
  const comp = project.root_folder.add_comp("Comp", 100, 100, 1.0, 1.0, 25.0);
  const solid = comp.add_solid([1.0, 0.0, 0.0]).source;
  if (solid == null) throw new Error("solid layer has no source");
  const out = tmp_path.div("solid.aep");
  project.save(out);
  const ours = as_instance(getitem(parse_aep(out).project.items, solid.id), FootageItem).main_source;
  expect(py_eq(_shape(ours), _shape(ae))).toBe(true);
});

test("test_parsed_records_are_kept", () => {
  const tmp_path = make_tmp_path();
  // Only a source built for the project is cut to its version: an AE 2022
  // project's own footage round-trips as AE wrote it.
  const path = IMPORT_DIR.div("clrs_ae2022.aep");
  const project = parse_aep(path).project;
  const out = tmp_path.div("same.aep");
  project.save(out);
  expect(py_eq(out.read_bytes(), path.read_bytes())).toBe(true);
});
