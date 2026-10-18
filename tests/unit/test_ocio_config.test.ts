/**
 * Tests for OCIO config color-space enumeration.
 *
 * The active-colorspace counts were verified set-equal to PyOpenColorIO (AE's OCIO
 * backend): samples/assets/config.ocio -> 22, AE's bundled ACES 1.2 -> 353.
 */

import { describe, expect, test } from "bun:test";

import { listConfigColorSpaces, resolveOcioConfig } from "../../src/py_aep/color/ocio.ts";
import { Path, len, truthy, valueEquals } from "../../src/pyrt/index.ts";
import { makeTmpPath } from "../support/pytest.ts";

const CONFIG = new Path(import.meta.dir, "..", "..", "samples", "assets", "config.ocio");

const pathEq = (a: Path | null, b: Path): boolean => a != null && a.equals(b);

describe("TestListConfigColorSpaces", () => {
  test("test_active_color_spaces", () => {
    const names = listConfigColorSpaces(CONFIG);
    expect(len(names)).toBe(22); // == PyOpenColorIO getColorSpaceNames()
    // colorspaces + display_colorspaces are included
    expect(names.includes("ACEScg")).toBe(true);
    expect(names.includes("ACEScct")).toBe(true);
    expect(names.includes("Raw")).toBe(true);
    expect(names.includes("sRGB - Display")).toBe(true);
    expect(names.includes("Linear Rec.709 (sRGB)")).toBe(true);
  });

  test("test_inactive_color_spaces_excluded", () => {
    const names = listConfigColorSpaces(CONFIG);
    // config.ocio lists these two in inactive_colorspaces.
    expect(names.includes("CIE XYZ-D65 - Display-referred")).toBe(false);
    expect(names.includes("CIE XYZ-D65 - Scene-referred")).toBe(false);
  });

  test("test_custom_ocio_tags_do_not_break_parsing", () => {
    // The config is full of `!<ColorSpace>`/`!<View>`/`!<Rule>` tags; a
    // successful non-empty parse proves the tag-ignoring loader works.
    expect(truthy(listConfigColorSpaces(CONFIG))).toBe(true);
  });

  test("test_missing_file_returns_empty", () => {
    const tmpPath = makeTmpPath();
    expect(valueEquals(listConfigColorSpaces(tmpPath.div("nope.ocio")), [])).toBe(true);
  });
});

describe("TestResolveOcioConfig", () => {
  test("test_existing_path", () => {
    expect(pathEq(resolveOcioConfig(String(CONFIG)), CONFIG)).toBe(true);
  });

  test("test_empty_returns_none", () => {
    expect(resolveOcioConfig("")).toBeNull();
  });

  test("test_unknown_name_returns_none", () => {
    expect(resolveOcioConfig("Not A Real Config Name")).toBeNull();
  });
});
