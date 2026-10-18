/**
 * Tests for ViewOptions model parsing using samples from models/view/.
 *
 * These tests verify that py_aep correctly reads viewer panel settings
 * (channels, exposure, zoom, fast preview, toggle flags, etc.) from the
 * `fips` chunks in the binary AEP format.
 *
 * The viewer panel data is accessed via `project.activeViewer`, which
 * represents the focused Composition/Layer/Footage panel. Each panel has
 * one or more `View` objects containing `ViewOptions`.
 */

import { describe, expect, test } from "bun:test";
import "../../src/py_aep/binary/_register.ts";
import { Path } from "../../src/pyrt/index.ts";
import { FastPreviewType, ViewOptions } from "../../src/py_aep/index.ts";
import { FipsChunk } from "../../src/py_aep/binary/misc_chunks.ts";

// `if TYPE_CHECKING: pass` block dropped (type-only, no runtime effect).

// Python: Path(__file__).parent.parent.parent; import.meta.dir is already the file's parent.
const SAMPLES_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "view");

describe("TestViewOptionsWithoutItem", () => {
  /**
   * Version-gated fields work when the viewer's item is no AVItem.
   *
   * parsers/view.py creates `ViewOptions(_item=None)` for such viewers;
   * the `minVersion` gate must be skipped (write allowed) when no AE
   * version can be determined, instead of raising TypeError.
   */

  test("test_set_and_read_gated_fields_with_item_none", () => {
    const opts = new ViewOptions({ _fips: new FipsChunk(), _item: null });

    opts.rulers = true;
    expect(opts.rulers).toBe(true);
    opts.guidesLocked = true;
    expect(opts.guidesLocked).toBe(true);
    opts.guidesSnap = true;
    expect(opts.guidesSnap).toBe(true);
    opts.guidesVisibility = true;
    expect(opts.guidesVisibility).toBe(true);
  });

  test("test_gated_enum_field_with_item_none", () => {
    const opts = new ViewOptions({ _fips: new FipsChunk(), _item: null });

    opts.fastPreview = FastPreviewType.FP_WIREFRAME;
    expect(opts.fastPreview).toBe(FastPreviewType.FP_WIREFRAME);
  });
});
