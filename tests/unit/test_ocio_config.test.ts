/**
 * Tests for OCIO config color-space enumeration.
 *
 * The active-colorspace counts were verified set-equal to PyOpenColorIO (AE's OCIO
 * backend): samples/assets/config.ocio -> 22, AE's bundled ACES 1.2 -> 353.
 */

import { describe, expect, test } from "bun:test";

import { list_config_color_spaces, resolve_ocio_config } from "../../src/py_aep/color/ocio.ts";
import { Path, len, py_bool, py_eq } from "../../src/pyrt/index.ts";
import { make_tmp_path } from "../../src/pyrt/pytest.ts";

const CONFIG = new Path(import.meta.dir, "..", "..", "samples", "assets", "config.ocio");

const path_eq = (a: Path | null, b: Path): boolean => a != null && a.equals(b);

describe("TestListConfigColorSpaces", () => {
  test("test_active_color_spaces", () => {
    const names = list_config_color_spaces(CONFIG);
    expect(len(names)).toBe(22); // == PyOpenColorIO getColorSpaceNames()
    // colorspaces + display_colorspaces are included
    expect(names.includes("ACEScg")).toBe(true);
    expect(names.includes("ACEScct")).toBe(true);
    expect(names.includes("Raw")).toBe(true);
    expect(names.includes("sRGB - Display")).toBe(true);
    expect(names.includes("Linear Rec.709 (sRGB)")).toBe(true);
  });

  test("test_inactive_color_spaces_excluded", () => {
    const names = list_config_color_spaces(CONFIG);
    // config.ocio lists these two in inactive_colorspaces.
    expect(names.includes("CIE XYZ-D65 - Display-referred")).toBe(false);
    expect(names.includes("CIE XYZ-D65 - Scene-referred")).toBe(false);
  });

  test("test_custom_ocio_tags_do_not_break_parsing", () => {
    // The config is full of `!<ColorSpace>`/`!<View>`/`!<Rule>` tags; a
    // successful non-empty parse proves the tag-ignoring loader works.
    expect(py_bool(list_config_color_spaces(CONFIG))).toBe(true);
  });

  test("test_missing_file_returns_empty", () => {
    const tmp_path = make_tmp_path();
    expect(py_eq(list_config_color_spaces(tmp_path.div("nope.ocio")), [])).toBe(true);
  });
});

describe("TestResolveOcioConfig", () => {
  test("test_existing_path", () => {
    expect(path_eq(resolve_ocio_config(String(CONFIG)), CONFIG)).toBe(true);
  });

  test("test_empty_returns_none", () => {
    expect(resolve_ocio_config("")).toBeNull();
  });

  test("test_unknown_name_returns_none", () => {
    expect(resolve_ocio_config("Not A Real Config Name")).toBeNull();
  });
});
