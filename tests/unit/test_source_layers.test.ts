/**
 * Tests for the source-layer enumeration/resolution resolvers.
 */

import { describe, expect, test } from "bun:test";
import "../../src/py_aep/binary/_register.ts";
import { list_layers } from "../../src/py_aep/index.ts";
import { AiLayer } from "../../src/py_aep/resolvers/ai_layers.ts";
import { probe_media } from "../../src/py_aep/resolvers/media_probe.ts";
import { FlattenedPsdError } from "../../src/py_aep/resolvers/psd_layers.ts";
import { psd_leaf_layers, resolve_ai_layer, resolve_psd_layer } from "../../src/py_aep/resolvers/source_layers.ts";
import { Path, py_eq, tkey, ValueError } from "../../src/pyrt/index.ts";
import { raises } from "../../src/pyrt/pytest.ts";

// Python: Path(__file__).parent.parent.parent / "samples" / "assets" (file is in tests/unit).
const ASSETS = new Path(import.meta.dir).parent.parent.div("samples").div("assets");

/** list_layers mirrors AE's "Choose Layer" dropdown (top layer first). */
describe("TestListLayers", () => {
  test("test_psd_order_matches_ae_dropdown", () => {
    // Verified against the AE 2026 dialog for choose_layer.psd: leaf
    // layers only (group `grp` is not listed), top-most first, the
    // nested `inner` shown without a group prefix.
    expect(py_eq(list_layers(ASSETS.div("choose_layer.psd")), ["twin", "inner", "twin", "solo"])).toBe(true);
  });

  test("test_ai_order_is_top_first", () => {
    // Document (OCG) order is bottom-first; the dropdown reverses it.
    expect(py_eq(list_layers(ASSETS.div("ai.ai")), ["Calque 2", "Calque 1"])).toBe(true);
  });

  test("test_non_layered_format_raises", () => {
    raises(ValueError, () => list_layers(ASSETS.div("image_with_alpha.png")), "layered");
  });

  test("test_flattened_psd_raises", () => {
    raises(FlattenedPsdError, () => list_layers(ASSETS.div("flattened.psd")));
  });
});

describe("TestResolvePsdLayer", () => {
  test("test_resolves_leaf_fields", () => {
    // `solo` is the bottom layer: last in the top-first dropdown.
    const leaf = resolve_psd_layer(ASSETS.div("choose_layer.psd"), 3);
    expect(leaf.name).toBe("solo");
    expect(leaf.record_index).toBe(0);
    expect(leaf.layer_id).toBe(2);
    expect(py_eq(leaf.bounds, [4, 6, 24, 20])).toBe(true);
  });

  test("test_nested_leaf_resolves", () => {
    const leaf = resolve_psd_layer(ASSETS.div("choose_layer.psd"), 1);
    // Record index counts the group divider records.
    expect(leaf.name).toBe("inner");
    expect(leaf.record_index).toBe(3);
    expect(leaf.layer_id).toBe(6);
  });

  test("test_duplicate_names_resolve_to_distinct_layers", () => {
    const top = resolve_psd_layer(ASSETS.div("choose_layer.psd"), 0);
    const bottom = resolve_psd_layer(ASSETS.div("choose_layer.psd"), 2);
    expect(top.name).toBe(bottom.name);
    expect(bottom.name).toBe("twin");
    expect(top.layer_id).toBe(4);
    expect(bottom.layer_id).toBe(3);
  });

  test.each([[-1], [4]])("test_out_of_range_lists_available[%#]", (index) => {
    raises(ValueError, () => resolve_psd_layer(ASSETS.div("choose_layer.psd"), index), String.raw`\['twin', 'inner', 'twin', 'solo'\]`);
  });

  test("test_leaves_are_document_order", () => {
    const leaves = psd_leaf_layers(ASSETS.div("choose_layer.psd"));
    expect(py_eq(leaves.map((leaf) => leaf.record_index), [0, 1, 3, 5])).toBe(true);
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
    const leaves = psd_leaf_layers(ASSETS.div(name));
    expect(
      py_eq(
        leaves.map((leaf) => [leaf.name, leaf.layer_id, leaf.record_index]),
        [
          ["Layer 1", 2, 0],
          ["Layer 1 copy", 4, 1],
        ],
      ),
    ).toBe(true);
    expect(leaves.every((leaf) => py_eq(leaf.bounds, [0, 0, 24, 25]))).toBe(true);
  });

  test("test_32bit_leaves_read_from_lr32", () => {
    // A 32-bit document keeps its records in the global Lr32 block.
    const leaves = psd_leaf_layers(ASSETS.div("psd_noise_gradient_32bpc.psd"));
    expect(
      py_eq(
        new Set(leaves.map((leaf) => tkey(leaf.name, leaf.layer_id))),
        new Set([tkey("Layer 1", 2), tkey("Layer 1 copy", 5)]),
      ),
    ).toBe(true);
    expect(py_eq(new Set(leaves.map((leaf) => leaf.record_index)), new Set([0, 1]))).toBe(true);
  });

  test("test_16bit_probe_layer_count", () => {
    const info = probe_media(ASSETS.div("psd_layer_styles.psd"));
    expect(info.layer_count).toBe(2);
    expect(info.has_alpha).toBe(true);
    expect(info.bit_depth).toBe(16);
  });
});

describe("TestResolveAiLayer", () => {
  test("test_resolves_document_index_and_name", () => {
    // Dropdown order is top-first; the document (OCG) order it maps to
    // is bottom-first.
    const layers = [new AiLayer(35, "Calque 1", true), new AiLayer(36, "Calque 2", true)];
    // AiLayer is a NamedTuple (tuple equality); py_eq has no __eq__ on it, so compare as plain tuples.
    const as_tuples = ([ls, i]: [AiLayer[], number]): [(number | string | boolean)[][], number] => [ls.map((l) => [...l]), i];
    expect(py_eq(as_tuples(resolve_ai_layer(ASSETS.div("ai.ai"), 0)), as_tuples([layers, 1]))).toBe(true);
    expect(py_eq(as_tuples(resolve_ai_layer(ASSETS.div("ai.ai"), 1)), as_tuples([layers, 0]))).toBe(true);
  });

  test("test_out_of_range_raises", () => {
    raises(ValueError, () => resolve_ai_layer(ASSETS.div("ai.ai"), 2), "layerIndex 2 out of range");
  });
});
