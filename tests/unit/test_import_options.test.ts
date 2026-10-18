/** Tests for the ImportOptions parameter container. */

import { describe, expect, test } from "bun:test";

import { raises } from "../../src/pyrt/pytest.ts";
import { Path, ValueError, int, valueEquals, repr } from "../../src/pyrt/index.ts";
import { ImportAsType } from "../../src/py_aep/enums/index.ts";
import { CURRENT_VALUE, ImportOptions } from "../../src/py_aep/models/index.ts";
import { COMP_CONVERSION_EXTENSIONS, getFileFormat } from "../../src/py_aep/data/file_formats.ts";

describe("TestImportOptions", () => {
  test("test_constructor", () => {
    const opts = new ImportOptions(new Path("footage/shot.png"));
    expect(opts.file).toBe("footage/shot.png");
    expect(opts.importAs).toBe(ImportAsType.FOOTAGE);
    expect(opts.sequence).toBe(false);
    expect(opts.forceAlphabetical).toBe(false);
  });

  test("test_constructor_accepts_path", () => {
    const opts = new ImportOptions(new Path("footage/shot.png"));
    expect(opts.file).toBe("footage/shot.png");
  });

  test("test_file_setter", () => {
    const opts = new ImportOptions(new Path("a.png"));
    opts.file = new Path("b.psd");
    expect(opts.file).toBe("b.psd");
  });

  test("test_import_as_setter", () => {
    const opts = new ImportOptions(new Path("a.psd"));
    opts.importAs = ImportAsType.COMP;
    expect(opts.importAs).toBe(ImportAsType.COMP);
  });

  test("test_sequence_setter", () => {
    const opts = new ImportOptions(new Path("frame001.png"));
    opts.sequence = true;
    expect(opts.sequence).toBe(true);
  });

  test("test_force_alphabetical_setter", () => {
    const opts = new ImportOptions(new Path("frame001.png"));
    opts.forceAlphabetical = true;
    expect(opts.forceAlphabetical).toBe(true);
  });

  // --- can_import_as ---
  // AE 2026 capability per extension (measured via
  // scripts/jsx/can_import_as_matrix.jsx). can_import_as additionally gates
  // on py_aep's own import support, so an extension that is AE-capable but
  // whose format is unimplemented (absent from data.file_formats, e.g.
  // .svg / .aep / .aet) returns False here for every type.

  const _MATRIX = new Map<string, Set<number>>([
    // Still images / audio / video: footage only.
    [".png", new Set([ImportAsType.FOOTAGE])],
    [".jpg", new Set([ImportAsType.FOOTAGE])],
    [".tif", new Set([ImportAsType.FOOTAGE])],
    [".tga", new Set([ImportAsType.FOOTAGE])],
    [".bmp", new Set([ImportAsType.FOOTAGE])],
    [".gif", new Set([ImportAsType.FOOTAGE])],
    [".dpx", new Set([ImportAsType.FOOTAGE])],
    [".cin", new Set([ImportAsType.FOOTAGE])],
    [".heic", new Set([ImportAsType.FOOTAGE])],
    [".heif", new Set([ImportAsType.FOOTAGE])],
    [".mp3", new Set([ImportAsType.FOOTAGE])],
    [".aif", new Set([ImportAsType.FOOTAGE])],
    [".wav", new Set([ImportAsType.FOOTAGE])],
    // Layered Photoshop: footage, comp, and comp-cropped.
    [
      ".psd",
      new Set([ImportAsType.FOOTAGE, ImportAsType.COMP, ImportAsType.COMP_CROPPED_LAYERS]),
    ],
    [
      ".psb",
      new Set([ImportAsType.FOOTAGE, ImportAsType.COMP, ImportAsType.COMP_CROPPED_LAYERS]),
    ],
    // Multi-channel EXR: footage or comp-cropped, but NOT plain comp.
    [".exr", new Set([ImportAsType.FOOTAGE, ImportAsType.COMP_CROPPED_LAYERS])],
    // SVG: comp-cropped only - not even footage.
    [".svg", new Set([ImportAsType.COMP_CROPPED_LAYERS])],
    // QuickTime: footage or project.
    [".mov", new Set([ImportAsType.FOOTAGE, ImportAsType.PROJECT])],
    // Project / template: project only - not footage.
    [".aep", new Set([ImportAsType.PROJECT])],
    [".aet", new Set([ImportAsType.PROJECT])],
  ]);

  test("test_can_import_as_matches_matrix", () => {
    const allTypes = [
      ImportAsType.FOOTAGE,
      ImportAsType.COMP,
      ImportAsType.COMP_CROPPED_LAYERS,
      ImportAsType.PROJECT,
    ];
    for (const [ext, expected] of _MATRIX.entries()) {
      // can_import_as is gated by what py_aep can actually import, so an
      // AE-capable extension with no implemented format yields False.
      // Comp-conversion formats (e.g. SVG) are implemented without a
      // media-format entry.
      let implemented: boolean;
      if (COMP_CONVERSION_EXTENSIONS.has(ext)) {
        implemented = true;
      } else {
        try {
          getFileFormat(ext);
          implemented = true;
        } catch (e) {
          if (!(e instanceof ValueError)) throw e;
          implemented = false;
        }
      }
      const opts = new ImportOptions(new Path("asset" + ext));
      for (const t of allTypes) {
        // PROJECT import is unimplemented for every format, so
        // can_import_as never returns True for it (even where AE can);
        // a cropped import is implemented for SVG and PSD/PSB only.
        const croppedOk = COMP_CONVERSION_EXTENSIONS.has(ext) || [".psd", ".psb"].includes(ext);
        const want = implemented
          ? expected.has(t) && t !== ImportAsType.PROJECT && (t !== ImportAsType.COMP_CROPPED_LAYERS || croppedOk)
          : false;
        // Labeled so a failing row names its extension and type, as pytest's message does.
        expect({ label: `${ext} / ${ImportAsType.nameOf(t)}`, got: opts.canImportAs(t) }).toEqual({
          label: `${ext} / ${ImportAsType.nameOf(t)}`,
          got: want,
        });
      }
    }
  });

  test("test_can_import_as_unknown_extension_all_false", () => {
    const opts = new ImportOptions(new Path("data.xyz"));
    expect(opts.canImportAs(ImportAsType.FOOTAGE)).toBe(false);
    expect(opts.canImportAs(ImportAsType.COMP)).toBe(false);
    expect(opts.canImportAs(ImportAsType.COMP_CROPPED_LAYERS)).toBe(false);
    expect(opts.canImportAs(ImportAsType.PROJECT)).toBe(false);
  });

  test("test_can_import_as_accepts_int", () => {
    const opts = new ImportOptions(new Path("design.psd"));
    expect(opts.canImportAs(int(ImportAsType.COMP))).toBe(true);
  });

  // --- is_file_name_numbered ---

  test("test_numbered_filename", () => {
    const opts = new ImportOptions(new Path("frame001.png"));
    const [isNumbered, first] = opts.isFileNameNumbered();
    expect(isNumbered).toBe(true);
    expect(first).toBe(1);
  });

  test("test_numbered_filename_large", () => {
    const opts = new ImportOptions(new Path("shot_1234.exr"));
    const [isNumbered, first] = opts.isFileNameNumbered();
    expect(isNumbered).toBe(true);
    expect(first).toBe(1234);
  });

  test("test_not_numbered_filename", () => {
    const opts = new ImportOptions(new Path("background.png"));
    const [isNumbered, first] = opts.isFileNameNumbered();
    expect(isNumbered).toBe(false);
    expect(first).toBe(0);
  });

  test("test_numbered_no_prefix", () => {
    const opts = new ImportOptions(new Path("0042.tiff"));
    const [isNumbered, first] = opts.isFileNameNumbered();
    expect(isNumbered).toBe(true);
    expect(first).toBe(42);
  });

  // --- repr ---

  test("test_repr", () => {
    const opts = new ImportOptions(new Path("shot.png"));
    const r = repr(opts);
    expect(r.includes("ImportOptions")).toBe(true);
    expect(r.includes("shot.png")).toBe(true);
    expect(r.includes("FOOTAGE")).toBe(true);
  });

  // --- case insensitive extension matching ---

  test("test_can_import_as_case_insensitive", () => {
    const opts = new ImportOptions(new Path("FILE.PSD"));
    expect(opts.canImportAs(ImportAsType.COMP)).toBe(true);
  });

  test("test_can_import_as_project_always_false", () => {
    // AE can import a .mov as a project, but py_aep does not implement
    // PROJECT import for any format, so can_import_as gates it out.
    const opts = new ImportOptions(new Path("CLIP.MOV"));
    expect(opts.canImportAs(ImportAsType.PROJECT)).toBe(false);
  });
});

describe("TestImportOptionsLayerSelection", () => {
  /** layer_index / layer_dimensions (py_aep extensions). */

  test("test_defaults", () => {
    const opts = new ImportOptions(new Path("a.psd"));
    expect(opts.layerIndex).toBe(null);
    expect(opts.layerDimensions).toBe(null);
  });

  test("test_layer_index_setter", () => {
    const opts = new ImportOptions(new Path("a.psd"));
    opts.layerIndex = 0;
    expect(opts.layerIndex).toBe(0);
    opts.layerIndex = 3;
    expect(opts.layerIndex).toBe(3);
    opts.layerIndex = null;
    expect(opts.layerIndex).toBe(null);
  });

  test("test_layer_index_rejects_negative", () => {
    const opts = new ImportOptions(new Path("a.psd"));
    raises(ValueError, () => {
      opts.layerIndex = -1;
    });
  });

  test("test_layer_index_rejects_non_int", () => {
    const opts = new ImportOptions(new Path("a.psd"));
    raises(TypeError, () => {
      // @ts-expect-error a layer name is not an index; the setter must reject it at runtime
      opts.layerIndex = "Layer 1";
    });
  });

  test("test_layer_index_rejects_current_value", () => {
    // CURRENT_VALUE only makes sense for replace: an import has no
    // current binding to keep.
    const opts = new ImportOptions(new Path("a.psd"));
    raises(
      ValueError,
      () => {
        opts.layerIndex = CURRENT_VALUE;
      },
      "only valid for FootageItem.replace",
    );
  });

  test("test_current_value_repr", () => {
    expect(repr(CURRENT_VALUE)).toBe("CURRENT_VALUE");
  });

  test("test_layer_dimensions_setter", () => {
    const opts = new ImportOptions(new Path("a.psd"));
    opts.layerDimensions = "layer";
    expect(opts.layerDimensions).toBe("layer");
    opts.layerDimensions = "document";
    expect(opts.layerDimensions).toBe("document");
    opts.layerDimensions = null;
    expect(opts.layerDimensions).toBe(null);
  });

  test("test_layer_dimensions_rejects_unknown", () => {
    const opts = new ImportOptions(new Path("a.psd"));
    raises(ValueError, () => {
      opts.layerDimensions = "canvas";
    });
  });
});

describe("TestImportOptionsRange", () => {
  /** range_start / range_end semantics (probed against AE 2026). */

  test("test_defaults_are_zero", () => {
    const opts = new ImportOptions(new Path("a.png"));
    expect(opts.rangeStart).toBe(0);
    expect(opts.rangeEnd).toBe(0);
  });

  test("test_setters", () => {
    const opts = new ImportOptions(new Path("a.png"));
    opts.rangeStart = 10;
    opts.rangeEnd = 30;
    expect(opts.rangeStart).toBe(10);
    expect(opts.rangeEnd).toBe(30);
  });

  test("test_rejects_negative_and_non_int", () => {
    const opts = new ImportOptions(new Path("a.png"));
    raises(ValueError, () => {
      opts.rangeStart = -1;
    });
    raises(TypeError, () => {
      // @ts-expect-error a str is not an int; the setter must reject it at runtime
      opts.rangeEnd = "5";
    });
  });

  test("test_accepts_the_full_u4_range", () => {
    const opts = new ImportOptions(new Path("a.png"));
    for (const value of [0, 1, 2 ** 31, 0xffffffff]) {
      opts.rangeStart = value;
      opts.rangeEnd = value;
      expect([opts.rangeStart, opts.rangeEnd]).toEqual([value, value]);
    }
  });

  test.each([[0x1_0000_0000], [2 ** 40], [2 ** 63]])("test_rejects_values_wider_than_u4[%#]", (value) => {
    // Both land in an `sspc` u4_field(); a wider value used to be accepted
    // here and then fail at save() as a struct.error from the binary layer.
    // The bound is the field's capacity, NOT AE's 3-hour duration ceiling -
    // AE 2026 opens a ranged sequence well past that.
    const opts = new ImportOptions(new Path("a.png"));
    raises(ValueError, () => {
      opts.rangeStart = value;
    });
    raises(ValueError, () => {
      opts.rangeEnd = value;
    });
  });

  test("test_set_time_error_when_alphabetical", () => {
    // AE: "You cannot set sequence range start for an alphabetical
    // sequence" - thrown at set time.
    const opts = new ImportOptions(new Path("a.png"));
    opts.forceAlphabetical = true;
    raises(
      ValueError,
      () => {
        opts.rangeStart = 2;
      },
      "alphabetical",
    );
    raises(
      ValueError,
      () => {
        opts.rangeEnd = 5;
      },
      "alphabetical",
    );
  });

  test("test_alphabetical_resets_range", () => {
    // AE resets the range (no error) when force_alphabetical is set
    // AFTER a range - probed 2026-07-14.
    const opts = new ImportOptions(new Path("a.png"));
    opts.rangeStart = 2;
    opts.rangeEnd = 5;
    opts.forceAlphabetical = true;
    expect(opts.rangeStart).toBe(0);
    expect(opts.rangeEnd).toBe(0);
  });
});
