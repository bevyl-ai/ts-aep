/**
 * Tests for the source-layer enumeration/resolution resolvers.
 */

import { describe, expect, test } from "bun:test";
import "../../src/py_aep/binary/_register.ts";
import { listLayers } from "../../src/py_aep/index.ts";
import { AiLayer } from "../../src/py_aep/resolvers/ai_layers.ts";
import { probeMedia } from "../../src/py_aep/resolvers/media_probe.ts";
import { FlattenedPsdError } from "../../src/py_aep/resolvers/psd_layers.ts";
import { psdLeafLayers, resolveAiLayer, resolvePsdLayer } from "../../src/py_aep/resolvers/source_layers.ts";
import { Path, valueEquals, tkey, ValueError } from "../../src/pyrt/index.ts";
import { raises } from "../../src/pyrt/pytest.ts";

// Python: Path(__file__).parent.parent.parent / "samples" / "assets" (file is in tests/unit).
const ASSETS = new Path(import.meta.dir).parent.parent.div("samples").div("assets");

/** listLayers mirrors AE's "Choose Layer" dropdown (top layer first). */
describe("TestListLayers", () => {
  test("test_psd_order_matches_ae_dropdown", () => {
    // Verified against the AE 2026 dialog for choose_layer.psd: leaf
    // layers only (group `grp` is not listed), top-most first, the
    // nested `inner` shown without a group prefix.
    expect(valueEquals(listLayers(ASSETS.div("choose_layer.psd")), ["twin", "inner", "twin", "solo"])).toBe(true);
  });

  test("test_ai_order_is_top_first", () => {
    // Document (OCG) order is bottom-first; the dropdown reverses it.
    expect(valueEquals(listLayers(ASSETS.div("ai.ai")), ["Calque 2", "Calque 1"])).toBe(true);
  });

  test("test_non_layered_format_raises", () => {
    raises(ValueError, () => listLayers(ASSETS.div("image_with_alpha.png")), "layered");
  });

  test("test_flattened_psd_raises", () => {
    raises(FlattenedPsdError, () => listLayers(ASSETS.div("flattened.psd")));
  });
});

describe("TestResolvePsdLayer", () => {
  test("test_resolves_leaf_fields", () => {
    // `solo` is the bottom layer: last in the top-first dropdown.
    const leaf = resolvePsdLayer(ASSETS.div("choose_layer.psd"), 3);
    expect(leaf.name).toBe("solo");
    expect(leaf.recordIndex).toBe(0);
    expect(leaf.layerId).toBe(2);
    expect(valueEquals(leaf.bounds, [4, 6, 24, 20])).toBe(true);
  });

  test("test_nested_leaf_resolves", () => {
    const leaf = resolvePsdLayer(ASSETS.div("choose_layer.psd"), 1);
    // Record index counts the group divider records.
    expect(leaf.name).toBe("inner");
    expect(leaf.recordIndex).toBe(3);
    expect(leaf.layerId).toBe(6);
  });

  test("test_duplicate_names_resolve_to_distinct_layers", () => {
    const top = resolvePsdLayer(ASSETS.div("choose_layer.psd"), 0);
    const bottom = resolvePsdLayer(ASSETS.div("choose_layer.psd"), 2);
    expect(top.name).toBe(bottom.name);
    expect(bottom.name).toBe("twin");
    expect(top.layerId).toBe(4);
    expect(bottom.layerId).toBe(3);
  });

  test.each([[-1], [4]])("test_out_of_range_lists_available[%#]", (index) => {
    raises(ValueError, () => resolvePsdLayer(ASSETS.div("choose_layer.psd"), index), String.raw`\['twin', 'inner', 'twin', 'solo'\]`);
  });

  test("test_leaves_are_document_order", () => {
    const leaves = psdLeafLayers(ASSETS.div("choose_layer.psd"));
    expect(valueEquals(leaves.map((leaf) => leaf.recordIndex), [0, 1, 3, 5])).toBe(true);
  });
});

/**
 * 16/32-bit documents store their records in the global Lr16/Lr32 block.
 *
 * The classic Layer Info section is empty there; misreading it used to
 * surface every 16-bit layered PSD as FlattenedPsdError.
 */
describe("TestPsd16BitLayers", () => {
  test.each([["psd_layer_styles.psd"], ["psd_layer_styles_variant.psd"]])("test_16bit_leaves_read_from_lr16[%#]", (name) => {
    const leaves = psdLeafLayers(ASSETS.div(name));
    expect(
      valueEquals(
        leaves.map((leaf) => [leaf.name, leaf.layerId, leaf.recordIndex]),
        [
          ["Layer 1", 2, 0],
          ["Layer 1 copy", 4, 1],
        ],
      ),
    ).toBe(true);
    expect(leaves.every((leaf) => valueEquals(leaf.bounds, [0, 0, 24, 25]))).toBe(true);
  });

  test("test_32bit_leaves_read_from_lr32", () => {
    // A 32-bit document keeps its records in the global Lr32 block.
    const leaves = psdLeafLayers(ASSETS.div("psd_noise_gradient_32bpc.psd"));
    expect(
      valueEquals(
        new Set(leaves.map((leaf) => tkey(leaf.name, leaf.layerId))),
        new Set([tkey("Layer 1", 2), tkey("Layer 1 copy", 5)]),
      ),
    ).toBe(true);
    expect(valueEquals(new Set(leaves.map((leaf) => leaf.recordIndex)), new Set([0, 1]))).toBe(true);
  });

  test("test_16bit_probe_layer_count", () => {
    const info = probeMedia(ASSETS.div("psd_layer_styles.psd"));
    expect(info.layerCount).toBe(2);
    expect(info.hasAlpha).toBe(true);
    expect(info.bitDepth).toBe(16);
  });
});

describe("TestResolveAiLayer", () => {
  test("test_resolves_document_index_and_name", () => {
    // Dropdown order is top-first; the document (OCG) order it maps to
    // is bottom-first.
    const layers = [new AiLayer(35, "Calque 1", true), new AiLayer(36, "Calque 2", true)];
    // AiLayer is a NamedTuple (tuple equality); py_eq has no __eq__ on it, so compare as plain tuples.
    const asTuples = ([ls, i]: [AiLayer[], number]): [(number | string | boolean)[][], number] => [ls.map((l) => [...l]), i];
    expect(valueEquals(asTuples(resolveAiLayer(ASSETS.div("ai.ai"), 0)), asTuples([layers, 1]))).toBe(true);
    expect(valueEquals(asTuples(resolveAiLayer(ASSETS.div("ai.ai"), 1)), asTuples([layers, 0]))).toBe(true);
  });

  test("test_out_of_range_raises", () => {
    raises(ValueError, () => resolveAiLayer(ASSETS.div("ai.ai"), 2), "layerIndex 2 out of range");
  });
});
