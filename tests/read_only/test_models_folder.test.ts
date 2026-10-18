/** Tests for Folder model parsing. */

// `from __future__ import annotations` and the `-> None` return annotations
// are dropped: nothing here is evaluated at runtime. `len` is the pyrt
// builtin, so `len(x)` keeps working for arrays and Maps alike.
// `folder.label` is an int-enum member (a plain number), so `.value` is the member itself.

import { describe, expect, test } from "bun:test";
import "../../src/py_aep/binary/_register.ts";
import { get_folder, get_folder_from_json_by_name, load_expected, parse_project } from "../conftest.ts";
import { Path, len, py_bool } from "../../src/pyrt/index.ts";

// Python `Path(__file__).parent.parent.parent` is the repo root. A TS file's
// `import.meta.dir` is already its directory, so two `.parent` steps reach it.
const SAMPLES_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "folder");

/** Tests for basic folder attributes. */
describe("TestFolderBasic", () => {
  test("test_empty", () => {
    const project = parse_project(SAMPLES_DIR.div("folder.aep"));
    const expected = load_expected(SAMPLES_DIR, "folder");
    const folder_json = get_folder_from_json_by_name(expected, "EmptyFolder");
    const folder = get_folder(project, "EmptyFolder");
    expect(folder.name).toBe(folder_json["name"]);
    expect(folder_json["name"]).toBe("EmptyFolder");
  });

  test("test_name_renamed", () => {
    const project = parse_project(SAMPLES_DIR.div("folder.aep"));
    const expected = load_expected(SAMPLES_DIR, "folder");
    const folder_json = get_folder_from_json_by_name(expected, "RenamedFolder");
    const folder = get_folder(project, "RenamedFolder");
    expect(folder.name).toBe(folder_json["name"]);
    expect(folder_json["name"]).toBe("RenamedFolder");
  });

  test("test_comment", () => {
    const project = parse_project(SAMPLES_DIR.div("folder.aep"));
    const expected = load_expected(SAMPLES_DIR, "folder");
    const folder_json = get_folder_from_json_by_name(expected, "comment");
    const folder = get_folder(project, "comment");
    expect(folder.comment).toBe(folder_json["comment"]);
    expect(folder_json["comment"]).toBe("Folder comment");
  });
});

/** Tests for folder label attribute. */
describe("TestFolderLabel", () => {
  test("test_label_1", () => {
    const project = parse_project(SAMPLES_DIR.div("folder.aep"));
    const expected = load_expected(SAMPLES_DIR, "folder");
    const folder_json = get_folder_from_json_by_name(expected, "label_1");
    const folder = get_folder(project, "label_1");
    expect(folder.label).toBe(folder_json["label"]);
    expect(folder_json["label"]).toBe(1);
  });

  test("test_label_5", () => {
    const project = parse_project(SAMPLES_DIR.div("folder.aep"));
    const expected = load_expected(SAMPLES_DIR, "folder");
    const folder_json = get_folder_from_json_by_name(expected, "label_5");
    const folder = get_folder(project, "label_5");
    expect(folder.label).toBe(folder_json["label"]);
    expect(folder_json["label"]).toBe(5);
  });

  test("test_label_10", () => {
    const project = parse_project(SAMPLES_DIR.div("folder.aep"));
    const expected = load_expected(SAMPLES_DIR, "folder");
    const folder_json = get_folder_from_json_by_name(expected, "label_10");
    const folder = get_folder(project, "label_10");
    expect(folder.label).toBe(folder_json["label"]);
    expect(folder_json["label"]).toBe(10);
  });
});

/** Tests for folder nesting. */
describe("TestFolderNesting", () => {
  test("test_parentFolder_nested", () => {
    const project = parse_project(SAMPLES_DIR.div("folder.aep"));
    const nested = project.folders.filter((f) => py_bool(f.parentFolder));
    expect(len(nested)).toBeGreaterThanOrEqual(3);
  });

  test("test_numItems_3", () => {
    const project = parse_project(SAMPLES_DIR.div("folder.aep"));
    const expected = load_expected(SAMPLES_DIR, "folder");
    const folder_json = get_folder_from_json_by_name(expected, "FolderWithItems");
    const folder = get_folder(project, "FolderWithItems");
    expect(folder_json["numItems"]).toBe(3);
    expect(len(folder.items)).toBe(folder_json["numItems"]);
    expect(folder.items.every((item) => "id" in item)).toBe(true);
  });
});
