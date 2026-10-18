/** Tests for Folder model parsing. */

// `from __future__ import annotations` and the `-> None` return annotations
// are dropped: nothing here is evaluated at runtime. `len` is the pyrt
// builtin, so `len(x)` keeps working for arrays and Maps alike.
// `folder.label` is an int-enum member (a plain number), so `.value` is the member itself.

import { describe, expect, test } from "bun:test";
import "../../src/py_aep/binary/_register.ts";
import { getFolder, getFolderFromJsonByName, loadExpected, parseProject } from "../conftest.ts";
import { Path, len, truthy } from "../../src/pyrt/index.ts";

// Python `Path(__file__).parent.parent.parent` is the repo root. A TS file's
// `import.meta.dir` is already its directory, so two `.parent` steps reach it.
const SAMPLES_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "folder");

/** Tests for basic folder attributes. */
describe("TestFolderBasic", () => {
  test("test_empty", () => {
    const project = parseProject(SAMPLES_DIR.div("folder.aep"));
    const expected = loadExpected(SAMPLES_DIR, "folder");
    const folderJson = getFolderFromJsonByName(expected, "EmptyFolder");
    const folder = getFolder(project, "EmptyFolder");
    expect(folder.name).toBe(folderJson["name"]);
    expect(folderJson["name"]).toBe("EmptyFolder");
  });

  test("test_name_renamed", () => {
    const project = parseProject(SAMPLES_DIR.div("folder.aep"));
    const expected = loadExpected(SAMPLES_DIR, "folder");
    const folderJson = getFolderFromJsonByName(expected, "RenamedFolder");
    const folder = getFolder(project, "RenamedFolder");
    expect(folder.name).toBe(folderJson["name"]);
    expect(folderJson["name"]).toBe("RenamedFolder");
  });

  test("test_comment", () => {
    const project = parseProject(SAMPLES_DIR.div("folder.aep"));
    const expected = loadExpected(SAMPLES_DIR, "folder");
    const folderJson = getFolderFromJsonByName(expected, "comment");
    const folder = getFolder(project, "comment");
    expect(folder.comment).toBe(folderJson["comment"]);
    expect(folderJson["comment"]).toBe("Folder comment");
  });
});

/** Tests for folder label attribute. */
describe("TestFolderLabel", () => {
  test("test_label_1", () => {
    const project = parseProject(SAMPLES_DIR.div("folder.aep"));
    const expected = loadExpected(SAMPLES_DIR, "folder");
    const folderJson = getFolderFromJsonByName(expected, "label_1");
    const folder = getFolder(project, "label_1");
    expect(folder.label).toBe(folderJson["label"]);
    expect(folderJson["label"]).toBe(1);
  });

  test("test_label_5", () => {
    const project = parseProject(SAMPLES_DIR.div("folder.aep"));
    const expected = loadExpected(SAMPLES_DIR, "folder");
    const folderJson = getFolderFromJsonByName(expected, "label_5");
    const folder = getFolder(project, "label_5");
    expect(folder.label).toBe(folderJson["label"]);
    expect(folderJson["label"]).toBe(5);
  });

  test("test_label_10", () => {
    const project = parseProject(SAMPLES_DIR.div("folder.aep"));
    const expected = loadExpected(SAMPLES_DIR, "folder");
    const folderJson = getFolderFromJsonByName(expected, "label_10");
    const folder = getFolder(project, "label_10");
    expect(folder.label).toBe(folderJson["label"]);
    expect(folderJson["label"]).toBe(10);
  });
});

/** Tests for folder nesting. */
describe("TestFolderNesting", () => {
  test("test_parentFolder_nested", () => {
    const project = parseProject(SAMPLES_DIR.div("folder.aep"));
    const nested = project.folders.filter((f) => truthy(f.parentFolder));
    expect(len(nested)).toBeGreaterThanOrEqual(3);
  });

  test("test_numItems_3", () => {
    const project = parseProject(SAMPLES_DIR.div("folder.aep"));
    const expected = loadExpected(SAMPLES_DIR, "folder");
    const folderJson = getFolderFromJsonByName(expected, "FolderWithItems");
    const folder = getFolder(project, "FolderWithItems");
    expect(folderJson["numItems"]).toBe(3);
    expect(len(folder.items)).toBe(folderJson["numItems"]);
    expect(folder.items.every((item) => "id" in item)).toBe(true);
  });
});
