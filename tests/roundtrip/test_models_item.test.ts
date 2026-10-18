/** Tests for Item model parsing. */

import { describe, expect, test } from "bun:test";
import { getMember, Path, StopIteration } from "../../src/pyrt/index.ts";

import { parse as parseAep } from "../../src/py_aep/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { IdtaChunk } from "../../src/py_aep/binary/item_chunks.ts";
import { Label } from "../../src/py_aep/enums/index.ts";
import { CompItem } from "../../src/py_aep/models/items/composition.ts";
import { FootageItem } from "../../src/py_aep/models/items/footage.ts";
import type { Project } from "../../src/py_aep/models/project.ts";
import { FileSource } from "../../src/py_aep/models/sources/file.ts";
import { getComp } from "../conftest.ts";
import { asInstance } from "../helpers.ts";
import { makeTmpPath } from "../support/pytest.ts";

const SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models", "item");
const COMP_SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models", "composition");

describe("TestRoundtripItemLabel", () => {
  /** Roundtrip tests for Item.label. */

  test("test_modify_item_label", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(COMP_SAMPLES_DIR.div("bgColor.aep")).project;
    const comp = getComp(project, "bgColor_custom");
    const originalLabel = comp.label;

    comp.label = Label.FUCHSIA;
    expect(comp.label).not.toBe(originalLabel);
    const out = tmpPath.div("modified_label.aep");
    project.save(out);

    const project2 = parseAep(out).project;
    const comp2 = getComp(project2, "bgColor_custom");
    expect(comp2.label).toBe(Label.FUCHSIA);
  });
});

describe("TestRoundtripItemComment", () => {
  /** Roundtrip tests for Item.comment. */

  test("test_modify_item_comment", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(COMP_SAMPLES_DIR.div("bgColor.aep")).project;
    const comp = getComp(project, "bgColor_custom");

    comp.comment = "roundtrip item comment";
    const out = tmpPath.div("modified_comment.aep");
    project.save(out);

    const project2 = parseAep(out).project;
    const comp2 = getComp(project2, "bgColor_custom");
    expect(comp2.comment).toBe("roundtrip item comment");
  });
});

describe("TestRoundtripItemName", () => {
  /** Roundtrip tests for Item.name. */

  test("test_modify_item_name", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(COMP_SAMPLES_DIR.div("bgColor.aep")).project;
    const comp = getComp(project, "bgColor_custom");

    comp.name = "Renamed Composition";
    const out = tmpPath.div("modified_name.aep");
    project.save(out);

    const project2 = parseAep(out).project;
    const comp2 = getComp(project2, "Renamed Composition");
    expect(comp2.name).toBe("Renamed Composition");
  });
});

describe("TestProxySource", () => {
  /** Tests for AVItem.useProxy and AVItem.proxySource. */

  /** `@pytest.fixture()`: a fresh project per test (function scope). */
  function proxyProject(): Project {
    return parseAep(SAMPLES_DIR.div("proxy.aep")).project;
  }

  function _find<T>(project: Project, name: string, cls: abstract new (...args: never[]) => T): T {
    for (const i of project.items.values()) {
      if (getMember(i, "name", "") === name && i instanceof cls) return i;
    }
    throw new StopIteration();
  }

  test("test_footage_use_proxy_false", () => {
    const proxyProject_ = proxyProject();
    const item = _find(proxyProject_, "proxy_disabled", FootageItem);
    expect(item.useProxy).toBe(false);
  });

  test("test_footage_use_proxy_true", () => {
    const proxyProject_ = proxyProject();
    const item = _find(proxyProject_, "proxy_enabled", FootageItem);
    expect(item.useProxy).toBe(true);
  });

  test("test_footage_proxy_source_exists", () => {
    const proxyProject_ = proxyProject();
    for (const name of ["proxy_disabled", "proxy_enabled"]) {
      const item = _find(proxyProject_, name, FootageItem);
      expect(item.proxySource != null).toBe(true);
      expect(item.proxySource instanceof FileSource).toBe(true);
    }
  });

  test("test_footage_no_proxy_source", () => {
    const proxyProject_ = proxyProject();
    const item = _find(proxyProject_, "no_proxy", FootageItem);
    expect(item.useProxy).toBe(false);
    expect(item.proxySource == null).toBe(true);
  });

  test("test_comp_use_proxy_true", () => {
    const proxyProject_ = proxyProject();
    const item = _find(proxyProject_, "proxy_enabled", CompItem);
    expect(item.useProxy).toBe(true);
  });

  test("test_comp_proxy_source_exists", () => {
    const proxyProject_ = proxyProject();
    const item = _find(proxyProject_, "proxy_disabled", CompItem);
    expect(item.proxySource != null).toBe(true);
    expect(item.proxySource instanceof FileSource).toBe(true);
  });

  test("test_comp_no_proxy_source", () => {
    const proxyProject_ = proxyProject();
    for (const name of ["layers", "no_proxy"]) {
      const item = _find(proxyProject_, name, CompItem);
      expect(item.useProxy).toBe(false);
      expect(item.proxySource == null).toBe(true);
    }
  });

  test("test_roundtrip_use_proxy", () => {
    const tmpPath = makeTmpPath();
    const proxyProject_ = proxyProject();
    const item = _find(proxyProject_, "proxy_enabled", FootageItem);
    item.useProxy = false;
    const out = tmpPath.div("proxy_modified.aep");
    proxyProject_.save(out);

    const project2 = parseAep(out).project;
    const item2 = _find(project2, "proxy_enabled", FootageItem);
    expect(item2.useProxy).toBe(false);
  });

  test("test_proxy_assigned_byte_matches_ae", () => {
    /**
     * idta 0x38 is 1 whenever a proxy is assigned, in use or not:
     * AE's `proxy_disabled` items store 1 with `use_proxy` False.
     */
    const proxyProject_ = proxyProject();
    for (const cls of [FootageItem, CompItem]) {
      const rows: [string, number][] = [
        ["proxy_enabled", 1],
        ["proxy_disabled", 1],
        ["no_proxy", 0],
      ];
      for (const [name, assigned] of rows) {
        const item = _find<FootageItem | CompItem>(proxyProject_, name, cls);
        expect([name, cls.name, asInstance(item._idta, IdtaChunk).tobytes()[0x38]]).toEqual([name, cls.name, assigned]);
      }
    }
  });

  test("test_disable_proxy_keeps_assigned_byte", () => {
    const tmpPath = makeTmpPath();
    // AE 2026: `useProxy = false` on an item with a proxy keeps 0x38 = 1.
    const proxyProject_ = proxyProject();
    const item = _find(proxyProject_, "proxy_enabled", FootageItem);
    item.useProxy = false;
    const out = tmpPath.div("proxy_disabled.aep");
    proxyProject_.save(out);
    const item2 = _find(parseAep(out).project, "proxy_enabled", FootageItem);
    expect(item2.useProxy).toBe(false);
    expect(asInstance(item2._idta, IdtaChunk).tobytes()[0x38]).toBe(1);
  });

  test("test_set_proxy_then_disable", () => {
    // AE 2026: `setProxy(file)` then `useProxy = false` stores 0x38 = 1.
    const proxyProject_ = proxyProject();
    const item = _find(proxyProject_, "no_proxy", CompItem);
    item.setProxy(SAMPLES_DIR.parent.parent.div("assets", "image_with_alpha.png"));
    item.useProxy = false;
    expect(asInstance(item._idta, IdtaChunk).tobytes()[0x38]).toBe(1);
  });

  test("test_set_proxy_to_none_clears_assigned_byte", () => {
    // AE 2026: `setProxyToNone()` stores 0x38 = 0.
    const proxyProject_ = proxyProject();
    const item = _find(proxyProject_, "proxy_disabled", FootageItem);
    item.setProxyToNone();
    expect(asInstance(item._idta, IdtaChunk).tobytes()[0x38]).toBe(0);
  });
});
