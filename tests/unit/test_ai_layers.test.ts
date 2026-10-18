/**
 * Layer enumeration of Illustrator/PDF Optional Content Groups.
 *
 * The `.ai` fixtures under `samples/assets/` are well-formed Illustrator
 * output, where `/OCGs` and the default configuration's `/Order` hold the same
 * groups. Real files are not always that tidy - Illustrator can leave the
 * groups of earlier revisions of the artwork behind in `/OCGs` - so the cases
 * here are hand-built PDF bodies that isolate one structure each.
 */

import { describe, expect, test } from "bun:test";

import { raises } from "../../src/pyrt/pytest.ts";
import { encode, pyEq } from "../../src/pyrt/index.ts";
import { AiLayer, UnsupportedAiLayersError, readAiLayerOcgs, readAiLayers } from "../../src/py_aep/resolvers/ai_layers.ts";

/** A minimal PDF body whose catalog carries `oc_properties`. */
function _pdf(ocProperties: string): Uint8Array {
  return encode(
    "%PDF-1.5\n" +
      "1 0 obj\n" +
      "<</Type/Catalog/OCProperties" +
      ocProperties +
      ">>\n" +
      "endobj\n" +
      "10 0 obj\n<</Type/OCG/Name(Stale)>>\nendobj\n" +
      "11 0 obj\n<</Type/OCG/Name(Hidden)>>\nendobj\n" +
      "12 0 obj\n<</Type/OCG/Name(Visible)>>\nendobj\n" +
      // The parser reads one token past an object, so the last group needs
      // something behind it, as it has in a real document.
      "13 0 obj\nnull\nendobj\n",
    "ascii",
  );
}

// NOTE(port): AiLayer is a NamedTuple, so Python's `==` compares its fields; the TS class has no `__eq__`, so compare the iterated fields (same result).
function asFields(layers: AiLayer[]): (number | string | boolean)[][] {
  return layers.map((layer) => [...layer]);
}

/** `/OCGs` can list groups the document no longer has. */
describe("TestStaleGroups", () => {
  test("test_groups_absent_from_order_are_dropped", () => {
    // A 2019-vintage Illustrator file shipped 65 groups for its 25
    // layers, the 40 stale ones first; every layer index After Effects
    // had authored against it only lined up with the /Order members.
    const data = _pdf("<</OCGs[10 0 R 11 0 R 12 0 R]/D<</Order[12 0 R 11 0 R]>>>>");

    expect(
      pyEq(
        asFields(readAiLayerOcgs("probe.ai", data)),
        asFields([new AiLayer(11, "Hidden", true), new AiLayer(12, "Visible", true)]),
      ),
    ).toBe(true);
  });

  /** `/OCGs` stays the document order even where `/Order` reverses it. */
  test("test_order_decides_membership_not_order", () => {
    const data = _pdf("<</OCGs[12 0 R 11 0 R]/D<</Order[11 0 R 12 0 R]>>>>");

    expect(pyEq(readAiLayers("probe.ai", data), ["Visible", "Hidden"])).toBe(true);
  });

  /** Illustrator sublayers nest, with an optional label string first. */
  test("test_nested_order_entries_count_as_members", () => {
    const data = _pdf("<</OCGs[10 0 R 11 0 R 12 0 R]/D<</Order[(Set)[12 0 R] 11 0 R]>>>>");

    expect(pyEq(readAiLayers("probe.ai", data), ["Hidden", "Visible"])).toBe(true);
  });

  test("test_a_file_without_order_keeps_every_group", () => {
    const data = _pdf("<</OCGs[10 0 R 11 0 R 12 0 R]/D<</BaseState/ON>>>>");

    expect(pyEq(readAiLayers("probe.ai", data), ["Stale", "Hidden", "Visible"])).toBe(true);
  });

  test("test_no_group_survives_the_filter_raises", () => {
    const data = _pdf("<</OCGs[10 0 R]/D<</Order[99 0 R]>>>>");

    raises(
      UnsupportedAiLayersError,
      () => {
        readAiLayers("probe.ai", data);
      },
      "no named layers",
    );
  });
});

/** `/D` `/OFF` lists the groups the default configuration hides. */
describe("TestVisibility", () => {
  test("test_a_group_in_off_is_not_visible", () => {
    const data = _pdf("<</OCGs[11 0 R 12 0 R]/D<</Order[12 0 R 11 0 R]/OFF[11 0 R]>>>>");

    expect(
      pyEq(
        asFields(readAiLayerOcgs("probe.ai", data)),
        asFields([new AiLayer(11, "Hidden", false), new AiLayer(12, "Visible", true)]),
      ),
    ).toBe(true);
  });

  test("test_every_group_is_visible_without_off", () => {
    const data = _pdf("<</OCGs[11 0 R 12 0 R]/D<</Order[12 0 R 11 0 R]>>>>");

    expect(
      pyEq(
        readAiLayerOcgs("probe.ai", data).map((layer) => layer.visible),
        [true, true],
      ),
    ).toBe(true);
  });
});
