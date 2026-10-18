/** Tests for media-file probing and file-source creation via import_file. */

import { describe, test } from "bun:test";
import "../../src/py_aep/binary/_register.ts";
import { ImportAsType, parse as parseAep } from "../../src/py_aep/index.ts";
import { ImportOptions } from "../../src/py_aep/models/import_options.ts";
import { Path, ValueError } from "../../src/pyrt/index.ts";
import { raises } from "../support/pytest.ts";


// Python: Path(__file__).parent.parent.parent / "samples" / ...
const ASSETS = new Path(import.meta.path).parent.parent.parent.div("samples", "assets");
const BASE = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "folder", "folder.aep");
const IMPORT_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "import");

describe("TestImportFileErrors", () => {
  /** Validation and error handling. */

  test("test_non_footage_import_type_raises", () => {
    const project = parseAep(BASE).project;
    const opts = new ImportOptions(ASSETS.div("image_with_alpha.png"));
    opts.importAs = ImportAsType.PROJECT;
    raises(ValueError, () => project.importFile(opts), "PROJECT import");
  });

  test("test_comp_import_unsupported_format_raises", () => {
    const project = parseAep(BASE).project;
    const opts = new ImportOptions(ASSETS.div("image_with_alpha.png"));
    opts.importAs = ImportAsType.COMP;
    raises(ValueError, () => project.importFile(opts), "COMP import");
  });

  test("test_eps_cropped_layers_not_implemented", () => {
    const project = parseAep(BASE).project;
    const opts = new ImportOptions(ASSETS.div("eps.eps"));
    opts.importAs = ImportAsType.COMP_CROPPED_LAYERS;
    raises(ValueError, () => project.importFile(opts), "COMP_CROPPED_LAYERS");
  });

  test("test_unsupported_format_raises", () => {
    const project = parseAep(BASE).project;
    raises(ValueError, () => project.importFile(new ImportOptions(ASSETS.div("config.ocio"))), "Unsupported");
  });

  test("test_deferred_format_rejected_early_with_value_error", () => {
    // .c4d import is deferred; import must fail with a clear ValueError
    // naming the extension, not NotImplementedError mid-probe.
    const project = parseAep(BASE).project;
    raises(ValueError, () => project.importFile(new ImportOptions(ASSETS.div("c4d.c4d"))), "\\.c4d");
  });
});
