/**
 * Footage imported into an OCIO-managed project takes the color space After
 * Effects assigns new files: the config's file rules in order (a rule's color
 * space recorded as a direct pick), or, for a config without file rules, its
 * `default` role (recorded as a role pick). Any profile the file embeds stays
 * recorded as its source profile.
 *
 * `ocio_input_<config>.aep` are AE 2026 imports of five stills into
 * `py_aep.new()` projects set to ACES 1.2, ACES 1.3 CG v1.0 and the sergb.ocio
 * studio config (`EXR` rule -> `scene_linear`, `Default` rule -> `default`).
 *
 * A replace keeps the space the source had - a rule's pick or one the user
 * assigned - while a proxy is a new file and gets the rules' pick.
 * `ocio_replace_sergb.aep` is AE 2026 replacing PNG and EXR footage in a sergb
 * project (`scripts/jsx/generate_ocio_replace_sample.jsx`): its `py_*` items
 * were imported by py_aep (`py_pick` then set to `ACEScg yo`), its `ae_*` items
 * by After Effects.
 */

import { expect, test } from "bun:test";
import { b, getitem, Path, py_bool, py_eq, repr, sorted, StopIteration, str } from "../../src/pyrt/index.ts";
import { skip } from "../../src/pyrt/pytest.ts";
import { new as new_, parse as parse_aep } from "../../src/py_aep/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { find_by_list_type } from "../../src/py_aep/binary/utils.ts";
import { resolve_ocio_config } from "../../src/py_aep/color/ocio.ts";
import { ColorManagementSystem } from "../../src/py_aep/enums/index.ts";
import { ImportOptions } from "../../src/py_aep/models/import_options.ts";
import { FootageItem } from "../../src/py_aep/models/items/footage.ts";
import { FileSource } from "../../src/py_aep/models/sources/file.ts";
import type { FootageSource } from "../../src/py_aep/models/sources/footage.ts";
import { as_instance } from "../helpers.ts";

const SAMPLES = new Path(import.meta.dir, "..", "..", "samples");
const IMPORT_DIR = SAMPLES.div("models", "import");
const SERGB = SAMPLES.div("models", "output_module", "output_color_space_ocio", "sergb.ocio");
const ASSETS = SAMPLES.div("assets");
const FILES = new Map<string, Path>([
  ["rgb_full.exr", ASSETS.div("exr", "rgb_full.exr")],
  ["11_progressive.jpg", ASSETS.div("11_progressive.jpg")],
  ["image_with_alpha.png", ASSETS.div("image_with_alpha.png")],
  ["tga_24.tga", ASSETS.div("tga_24.tga")],
  ["8bits.tif", ASSETS.div("8bits.tif")],
]);
const CONFIGS = new Map<string, string>([
  ["aces12", "ACES 1.2"],
  ["aces13cg", "ACES 1.3 CG v1.0"],
  ["sergb", str(SERGB)],
]);

// NOTE(port): next(gen) with no default raises StopIteration on a miss; next_ throws the same.
function next_<T>(items: Iterable<T>, pred: (item: T) => boolean): T {
  for (const item of items) {
    if (pred(item)) return item;
  }
  throw new StopIteration();
}

/**
 * The CLRS record, the embedded profile's bytes left out: py embeds the
 * sRGB copy installed on this machine for a TIFF, which can differ from
 * After Effects' copy in the advisory rendering-intent byte.
 */
function _clrs(source: FootageSource | null): [string, Uint8Array][] {
  const clrs = find_by_list_type(as_instance(source, FileSource)._pin.chunks, "CLRS");
  const record: [string, Uint8Array][] = [];
  let marker = "";
  for (const chunk of clrs.chunks) {
    let data = chunk.tobytes();
    if (chunk.chunk_type === "Utf8" && ["mcsp", "Mcsp"].includes(marker) && py_bool(data)) {
      data = b("<embedded>");
    }
    record.push([chunk.chunk_type, data]);
    marker = chunk.chunk_type;
  }
  return record;
}

const IMPORT_ROWS: [string, string][] = sorted([...CONFIGS.keys()]).flatMap((tag) =>
  sorted([...FILES.keys()]).map((name): [string, string] => [tag, name]),
);

/** Parametrized over `tag` and `name` (cartesian product, as stacked pytest decorators). */
test.each(IMPORT_ROWS)("test_import_records_the_ocio_input_space[%#]", (tag, name) => {
  const config = getitem(CONFIGS, tag);
  if (resolve_ocio_config(config) == null) {
    return skip(`OCIO config ${repr(config)} is not installed`);
  }
  const ae = next_(
    parse_aep(IMPORT_DIR.div(`ocio_input_${tag}.aep`)).project.footages,
    (item) => item.name === name,
  );
  const project = new_().project;
  project.colorManagementSystem = ColorManagementSystem.OCIO;
  project.ocioConfigurationFile = config;
  const ours = as_instance(project.importFile(new ImportOptions(getitem(FILES, name))), FootageItem);
  expect(py_eq(_clrs(ours.mainSource), _clrs(ae.mainSource))).toBe(true);
});

const PNG = getitem(FILES, "image_with_alpha.png");
const EXR = getitem(FILES, "rgb_full.exr");

/** Parametrized over `name`, `first`, `assigned` and `second`. */
test.each([
  ["py_pick", PNG, "ACEScg yo", EXR],
  ["py_dflt", PNG, null, EXR],
  ["ae_png_to_exr", PNG, null, EXR],
  ["ae_exr_to_png", EXR, null, PNG],
] satisfies [string, Path, string | null, Path][])(
  "test_replace_keeps_the_ocio_input_space[%#]",
  (name, first, assigned, second) => {
    if (resolve_ocio_config(str(SERGB)) == null) {
      return skip("sergb.ocio is not resolvable");
    }
    const ae = next_(
      parse_aep(IMPORT_DIR.div("ocio_replace_sergb.aep")).project.footages,
      (item) => item.name === name,
    );
    const project = new_().project;
    project.colorManagementSystem = ColorManagementSystem.OCIO;
    project.ocioConfigurationFile = str(SERGB);
    const ours = as_instance(project.importFile(new ImportOptions(first)), FootageItem);
    if (assigned != null) {
      as_instance(ours.mainSource, FileSource).mediaColorSpace = assigned;
    }
    ours.replace(second);
    expect(py_eq(_clrs(ours.mainSource), _clrs(ae.mainSource))).toBe(true);
  },
);

test("test_proxy_takes_the_rules_pick", () => {
  if (resolve_ocio_config(str(SERGB)) == null) {
    return skip("sergb.ocio is not resolvable");
  }
  const ae = next_(
    parse_aep(IMPORT_DIR.div("ocio_replace_sergb.aep")).project.footages,
    (item) => item.name === "ae_png_proxy_exr",
  );
  const project = new_().project;
  project.colorManagementSystem = ColorManagementSystem.OCIO;
  project.ocioConfigurationFile = str(SERGB);
  const ours = project.importFile(new ImportOptions(PNG));
  ours.setProxy(EXR);
  expect(py_eq(_clrs(ours.proxySource), _clrs(ae.proxySource))).toBe(true);
});
