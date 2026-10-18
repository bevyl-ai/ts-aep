/** Tests for the Photoshop layer-style descriptor resolver. */

import { describe, expect, test } from "bun:test";

import { raises, warns } from "../../src/pyrt/pytest.ts";
import {
  NotImplementedError,
  Path,
  contains,
  getitem,
  len,
  pyAssert,
  pyEq,
} from "../../src/pyrt/index.ts";
import { Gradient } from "../../src/py_aep/models/properties/gradient.ts";
import { PsdLayer, readPsdLayers, type PsdNode } from "../../src/py_aep/resolvers/psd_layers.ts";
import { asInstance } from "../helpers.ts";
import { type _Value, type PsdLayerStyles, _instanceBox, hasEnabledStyles, mergedStylesBounds, parseLayerStyles, readGlobalLight } from "../../src/py_aep/resolvers/psd_styles.ts";
import "../../src/py_aep/binary/_register.ts";

// Python: Path(__file__).parent.parent.parent / "samples" / "assets"
const ASSETS = new Path(import.meta.path).parent.parent.parent.div("samples", "assets");

const STYLED = ASSETS.div("psd_layer_styles.psd");
const VARIANT = ASSETS.div("psd_layer_styles_variant.psd");
const SINGLE = ASSETS.div("psd_layer_styles_8bits_single.psd");
const NOISE = ASSETS.div("psd_noise_gradient.psd");
const NOISE_32 = ASSETS.div("psd_noise_gradient_32bpc.psd");

function _leaves(psd: Path): Map<string, PsdNode> {
  const out = new Map<string, PsdNode>();
  for (const leaf of readPsdLayers(psd)) out.set(leaf.name, leaf);
  return out;
}

describe("TestReadGlobalLight", () => {
  test("test_document_resources", () => {
    // Resources 1037/1049 of the sample document (AE wrote 49/11 into
    // every layer's Blend Options in the editable fixtures).
    expect(pyEq(readGlobalLight(STYLED), [49.0, 11.0])).toBe(true);
  });

  test("test_defaults_when_absent", () => {
    // choose_layer.psd carries no global-light resources; AE's Layer
    // Styles defaults apply.
    expect(pyEq(readGlobalLight(ASSETS.div("choose_layer.psd")), [120.0, 30.0])).toBe(true);
  });
});

describe("TestParseLayerStyles", () => {
  test("test_values_match_editable_fixture", () => {
    // Spot-check the AE-unit conversion against values AE wrote into
    // psd_layer_styles_single.aep (fixture-decoded ground truth).
    const leaf = asInstance(getitem(_leaves(SINGLE), "Layer 1"), PsdLayer);
    const styles = parseLayerStyles(leaf, readGlobalLight(SINGLE));
    pyAssert(styles != null);
    const values = styles.values;
    expect(getitem(values, "dropShadow/mode2")).toBe(17.0); // softLight
    expect(getitem(values, "innerShadow/mode2")).toBe(4.0); // darken
    expect(getitem(values, "outerGlow/mode2")).toBe(24.0); // difference
    expect(getitem(values, "innerGlow/mode2")).toBe(13.0); // linearDodge
    expect(getitem(values, "frameFX/mode2")).toBe(10.0); // lighten
    expect(getitem(values, "frameFX/style")).toBe(2.0); // InsF = inside
    expect(getitem(values, "frameFX/size")).toBe(6.0);
    expect(getitem(values, "frameFX/opacity")).toBe(91.0);
    // The gradient-paint stroke imports its color verbatim (black).
    expect(pyEq(getitem(values, "frameFX/color"), [0.0, 0.0, 0.0, 1.0])).toBe(true);
    expect(getitem(values, "dropShadow/opacity")).toBe(44.0);
    expect(getitem(values, "dropShadow/localLightingAngle")).toBe(90.0);
    expect(getitem(values, "outerGlow/AEColorChoice")).toBe(2.0); // gradient fill
    expect(getitem(values, "innerGlow/innerGlowSource")).toBe(2.0); // SrcC
    expect(getitem(values, "bevelEmboss/bevelStyle")).toBe(3.0); // Embs
    expect(getitem(values, "bevelEmboss/highlightMode")).toBe(12.0); // colorDodge
    // Blend options: global light + iOpa/brst/infx tagged blocks.
    expect(getitem(values, "ADBE Global Angle2")).toBe(49.0);
    expect(getitem(values, "ADBE Global Altitude2")).toBe(11.0);
    expect(getitem(values, "ADBE Layer Fill Opacity2")).toBe(89.0);
    expect(getitem(values, "ADBE G Channel Blend")).toBe(0.0);
    expect(getitem(values, "ADBE R Channel Blend")).toBe(1.0);
    expect(getitem(values, "ADBE Blend Interior")).toBe(1.0);
    expect(len(styles.enabled)).toBe(10);
    expect(pyEq(styles.dropped, [])).toBe(true);
  });

  test("test_gradient_stops", () => {
    const leaf = asInstance(getitem(_leaves(SINGLE), "Layer 1"), PsdLayer);
    const styles = parseLayerStyles(leaf, readGlobalLight(SINGLE));
    pyAssert(styles != null);
    const gradient = getitem(styles.values, "outerGlow/gradient");
    pyAssert(gradient instanceof Gradient);
    expect(len(gradient.colorStops)).toBe(5);
    expect(len(gradient.alphaStops)).toBe(2);
    // Stop positions are Lctn/4096; colors Rd/255 (write path quantizes
    // to the f4 AE stores).
    const offsets = gradient.colorStops.map((stop) => stop.offset);
    expect(pyEq(offsets, [0.0, 0.25, 0.5, 0.75, 1.0])).toBe(true);
    const first = gradient.colorStops[0].color;
    expect(Math.abs(first[0] - 0.9137255) < 1e-6).toBe(true);
  });

  test("test_multi_instance_styles_drop", () => {
    // The main PSD has TWO stroke instances per layer; AE drops the
    // whole style (even though one instance is a plain solid stroke).
    const leaf = asInstance(getitem(_leaves(STYLED), "Layer 1"), PsdLayer);
    const styles = parseLayerStyles(leaf, readGlobalLight(STYLED));
    pyAssert(styles != null);
    expect(pyEq(styles.dropped, ["frameFX"])).toBe(true);
    expect(contains(styles.enabled, "frameFX")).toBe(false);
    expect(styles.values.has("frameFX/mode2")).toBe(false);
  });

  test("test_two_representable_instances_still_drop", () => {
    // The variant's top layer has two identical inner shadows: the
    // instance COUNT is the trigger, not unrepresentable content.
    const leaf = asInstance(getitem(_leaves(VARIANT), "Layer 1 copy"), PsdLayer);
    const styles = parseLayerStyles(leaf, readGlobalLight(VARIANT));
    pyAssert(styles != null);
    expect(pyEq(styles.dropped, ["innerShadow"])).toBe(true);
    // Its single gradient-paint stroke imports fine.
    expect(contains(styles.enabled, "frameFX")).toBe(true);
  });

  test("test_no_styles_returns_none", () => {
    const leaf = asInstance(getitem(_leaves(ASSETS.div("choose_layer.psd")), "solo"), PsdLayer);
    expect(leaf.style_blocks == null).toBe(true);
    expect(parseLayerStyles(leaf, [120.0, 30.0]) == null).toBe(true);
  });

  test.each([[NOISE], [NOISE_32]])("test_noise_gradient_keeps_style_omits_gradient[%#]", (psd: Path) => {
    // AE imports a style whose gradient is a Noise gradient, dropping only
    // the (unrepresentable) gradient leaf. On 'Layer 1' the gradient fill
    // carries the noise gradient.
    const leaf = asInstance(getitem(_leaves(psd), "Layer 1"), PsdLayer);
    const styles = parseLayerStyles(leaf, readGlobalLight(psd));
    pyAssert(styles != null);
    expect(contains(styles.enabled, "gradientFill")).toBe(true);
    expect(styles.values.has("gradientFill/opacity")).toBe(true);
    expect(styles.values.has("gradientFill/gradient")).toBe(false);
    expect(pyEq(styles.dropped, [])).toBe(true);
  });

  test("test_present_but_disabled_glows_still_import", () => {
    // AE keeps the single-instance glow/bevel/satin parameters even when
    // the style is fully unchecked (present=False); other styles with
    // present=False stay plain skeletons.
    const leaf = asInstance(getitem(_leaves(NOISE), "Layer 1"), PsdLayer);
    const styles = parseLayerStyles(leaf, readGlobalLight(NOISE));
    pyAssert(styles != null);
    // outerGlow is present=False here: imported, neither enabled nor
    // in `disabled` (its tdsb stays the absent-style 0x02).
    expect(styles.values.has("outerGlow/opacity")).toBe(true);
    expect(contains(styles.enabled, "outerGlow")).toBe(false);
    expect(contains(styles.disabled, "outerGlow")).toBe(false);
    // A present=False pattern overlay is a plain skeleton (no params).
    expect(
      [...styles.values.keys()].some((mn: string) => mn.startsWith("patternFill/")),
    ).toBe(false);
  });

  test("test_present_true_disabled_shadow_imports", () => {
    // present=True + enab=False: parameters import and the prefix lands
    // in `disabled` (AE writes tdsb 0x00 - psd_fill_opacity fixture).
    const leaf = asInstance(getitem(_leaves(ASSETS.div("psd_fill_opacity.psd")), "fill plus disabled shadow"), PsdLayer);
    const styles = parseLayerStyles(leaf, [120.0, 30.0]);
    pyAssert(styles != null);
    expect(contains(styles.disabled, "dropShadow")).toBe(true);
    expect(contains(styles.enabled, "dropShadow")).toBe(false);
    expect(getitem(styles.values, "dropShadow/distance")).toBe(7.0);
    expect(getitem(styles.values, "ADBE Layer Fill Opacity2")).toBe(60.0);
    expect(styles.blend_options).toBe(true);
  });

  test("test_fill_opacity_without_styles", () => {
    // A Fill slider away from 100% imports alone: no lfx2 block at all,
    // yet AE enables the blend-options chain and writes the leaf.
    const leaf = asInstance(getitem(_leaves(ASSETS.div("psd_fill_opacity.psd")), "fill only"), PsdLayer);
    pyAssert(leaf.style_blocks != null);
    expect(leaf.style_blocks.effects == null).toBe(true);
    const styles = parseLayerStyles(leaf, [120.0, 30.0]);
    pyAssert(styles != null);
    expect(styles.blend_options).toBe(true);
    expect(pyEq(styles.enabled, [])).toBe(true);
    expect(getitem(styles.values, "ADBE Layer Fill Opacity2")).toBe(40.0);
  });

  test("test_gradient_smoothness_maps_from_intr", () => {
    // Grdn `Intr` is the Smoothness slider; AE maps it onto the
    // gradientSmoothness leaf as Intr/4096*100.
    const leaf = asInstance(getitem(_leaves(ASSETS.div("psd_styles_smoothness.psd")), "Layer 1"), PsdLayer);
    const styles = parseLayerStyles(leaf, [120.0, 30.0]);
    pyAssert(styles != null);
    expect(getitem(styles.values, "gradientFill/gradientSmoothness")).toBe(50.0);
    expect(getitem(styles.values, "outerGlow/gradientSmoothness")).toBe(25.0);
  });

  test("test_legacy_4cc_blend_modes", () => {
    // Zero-length 4-char typeID enum spellings resolve like AE does
    // (spliced psd_blend_4cc fixture: Mltp=multiply, SftL=softLight).
    const leaf = asInstance(getitem(_leaves(ASSETS.div("psd_blend_4cc.psd")), "legacy modes"), PsdLayer);
    const styles = parseLayerStyles(leaf, [120.0, 30.0]);
    pyAssert(styles != null);
    expect(getitem(styles.values, "dropShadow/mode2")).toBe(5.0);
    expect(getitem(styles.values, "innerShadow/mode2")).toBe(17.0);
  });

  test("test_4cc_alias_set_matches_ae", () => {
    // The 27-mode probe (psd_blend_4cc_all.aep): the 16 true-legacy
    // 4CCs resolve; the post-CS ones (lbrn, vLit, fsub, ...) do NOT -
    // AE keeps the default mode, so py skips the leaf (with a warning).
    const leaves = _leaves(ASSETS.div("psd_blend_4cc_all.psd"));
    const resolved = new Map<string, number>([
      ["normal", 1.0],
      ["dissolve", 2.0],
      ["darken", 4.0],
      ["colorBurn", 6.0],
      ["lighten", 10.0],
      ["screen", 11.0],
      ["colorDodge", 12.0],
      ["overlay", 16.0],
      ["hardLight", 18.0],
      ["difference", 24.0],
      ["exclusion", 25.0],
      ["hue", 27.0],
      ["saturation", 28.0],
      ["color", 29.0],
      ["luminosity", 30.0],
    ]);
    const unresolved = [
      "linearBurn",
      "darkerColor",
      "linearDodge",
      "lighterColor",
      "vividLight",
      "linearLight",
      "pinLight",
      "hardMix",
      "blendSubtraction",
      "blendDivide",
    ];
    for (const [name, mode2] of resolved) {
      const styles = parseLayerStyles(asInstance(getitem(leaves, name), PsdLayer), [120.0, 30.0]);
      pyAssert(styles != null);
      pyAssert(getitem(styles.values, "dropShadow/mode2") === mode2, name);
    }
    for (const name of unresolved) {
      let styles: PsdLayerStyles | null | undefined;
      // NOTE(port): every warnings.warn in psd_styles.py uses the default UserWarning, so the message-only match is equivalent
      warns(() => {
        styles = parseLayerStyles(asInstance(getitem(leaves, name), PsdLayer), [120.0, 30.0]);
      }, "mode2");
      pyAssert(styles != null);
      pyAssert(!styles.values.has("dropShadow/mode2"), name);
    }
  });
});

describe("TestHasEnabledStyles", () => {
  test("test_styled_and_multi_instance_layers", () => {
    // Multi-instance styles rasterize in merge mode too, so they count.
    expect(hasEnabledStyles(getitem(_leaves(STYLED), "Layer 1"))).toBe(true);
    expect(hasEnabledStyles(getitem(_leaves(VARIANT), "Layer 1 copy"))).toBe(true);
  });

  test("test_style_less_layer", () => {
    expect(hasEnabledStyles(getitem(_leaves(ASSETS.div("choose_layer.psd")), "solo"))).toBe(false);
  });
});

// Pads (left, top, right, bottom) After Effects 2026 gave a 24x25 layer carrying
// one merged style, measured by importing byte-patched copies of
// psd_layer_styles.psd as COMP_CROPPED_LAYERS.
const _DS = new Map<string, _Value>([
  ["enab", true],
  ["Dstn", 0.0],
  ["Ckmt", 5.0],
  ["uglg", false],
  ["lagl", 90.0],
  ["AntA", true],
]);
const _OG = new Map<string, _Value>([
  ["enab", true],
  ["Ckmt", 0.0],
  ["GlwT", "SfBL"],
  ["AntA", true],
]);
const _BV = new Map<string, _Value>([
  ["enab", true],
  ["Sftn", 0.0],
  ["useShape", true],
  ["AntA", true],
]);

describe("TestMergedStylesBounds", () => {
  test.each([
    ["DrSh", new Map<string, _Value>([..._DS, ["blur", 10.0]]), [12, 12, 12, 12]],
    ["DrSh", new Map<string, _Value>([..._DS, ["blur", 0.0]]), [5, 5, 4, 4]],
    ["DrSh", new Map<string, _Value>([..._DS, ["blur", 1.0], ["Ckmt", 50.0]]), [8, 8, 7, 7]],
    [
      "DrSh",
      new Map<string, _Value>([..._DS, ["blur", 10.0], ["Ckmt", 0.0], ["AntA", false]]),
      [9, 9, 10, 10],
    ],
    // Distance 11 along a 30 degree light: offsets (-9.53, 5.5) round
    // half away from zero to (-10, 6).
    [
      "DrSh",
      new Map<string, _Value>([..._DS, ["blur", 35.0], ["Dstn", 11.0], ["lagl", 30.0]]),
      [47, 31, 27, 43],
    ],
    [
      "OrGl",
      new Map<string, _Value>([..._OG, ["blur", 7.0], ["Ckmt", 8.0], ["GlwT", "PrBL"]]),
      [12, 12, 11, 11],
    ],
    ["OrGl", new Map<string, _Value>([..._OG, ["blur", 43.0], ["Ckmt", 50.0]]), [45, 45, 45, 45]],
    [
      "FrFX",
      new Map<string, _Value>([
        ["enab", true],
        ["Styl", "CtrF"],
        ["Sz  ", 5.0],
      ]),
      [5, 5, 5, 5],
    ],
    [
      "FrFX",
      new Map<string, _Value>([
        ["enab", true],
        ["Styl", "OutF"],
        ["Sz  ", 12.0],
      ]),
      [14, 14, 14, 14],
    ],
    [
      "ebbl",
      new Map<string, _Value>([..._BV, ["bvlS", "Embs"], ["bvlT", "PrBL"], ["blur", 27.0]]),
      [19, 19, 17, 17],
    ],
    [
      "ebbl",
      new Map<string, _Value>([..._BV, ["bvlS", "OtrB"], ["bvlT", "SfBL"], ["blur", 0.0]]),
      [3, 3, 1, 1],
    ],
    [
      "ebbl",
      new Map<string, _Value>([..._BV, ["bvlS", "OtrB"], ["bvlT", "SfBL"], ["blur", 9.0], ["Sftn", 5.0]]),
      [15, 15, 15, 15],
    ],
    [
      "ebbl",
      new Map<string, _Value>([
        ..._BV,
        ["bvlS", "Embs"],
        ["bvlT", "SfBL"],
        ["blur", 9.0],
        ["useShape", false],
      ]),
      [6, 6, 6, 6],
    ],
  ])("test_style_pads_match_ae[%#]", (key: string, instance: Map<string, _Value>, pads: number[]) => {
    const [left, top, right, bottom] = pads;
    const box = _instanceBox(key, instance, [0, 0, 24, 25], 120.0, "Layer 1");
    expect(pyEq(box, [-left, -top, 24 + right, 25 + bottom])).toBe(true);
  });

  test.each([
    ["FrFX", new Map<string, _Value>([["enab", true], ["Styl", "InsF"], ["Sz  ", 6.0]])],
    [
      "ebbl",
      new Map<string, _Value>([..._BV, ["bvlS", "InrB"], ["bvlT", "SfBL"], ["blur", 9.0], ["Sftn", 5.0]]),
    ],
    ["IrSh", new Map<string, _Value>([["enab", true], ["blur", 21.0], ["Dstn", 10.0]])],
    ["ChFX", new Map<string, _Value>([["enab", true], ["blur", 101.0], ["Dstn", 69.0]])],
  ])("test_styles_inside_the_layer_do_not_grow_it[%#]", (key: string, instance: Map<string, _Value>) => {
    expect(_instanceBox(key, instance, [0, 0, 24, 25], 120.0, "Layer 1") == null).toBe(true);
  });

  test("test_global_light_moves_the_shadow", () => {
    const instance = new Map<string, _Value>([..._DS, ["blur", 10.0], ["Dstn", 11.0], ["uglg", true], ["lagl", 0.0]]);
    const box = _instanceBox("DrSh", instance, [0, 0, 24, 25], 90.0, "Layer 1");
    // straight down, as the 90 degree global light
    expect(pyEq(box, [-12, -1, 36, 48])).toBe(true);
  });

  test("test_stroke_emboss_is_refused", () => {
    const instance = new Map<string, _Value>([..._BV, ["bvlS", "strokeEmboss"], ["bvlT", "SfBL"], ["blur", 9.0]]);
    raises(
      NotImplementedError,
      () => _instanceBox("ebbl", instance, [0, 0, 24, 25], 120.0, "Layer 1"),
      "strokeEmboss",
    );
  });

  test("test_sample_document_matches_ae", () => {
    // Every style of the sample at once: AE's merged box (-45, -45, 69, 70)
    // (samples/models/import/psd_layer_styles.aep).
    const angle = readGlobalLight(STYLED)[0];
    for (const name of ["Layer 1", "Layer 1 copy"]) {
      expect(
        pyEq(mergedStylesBounds(asInstance(getitem(_leaves(STYLED), name), PsdLayer), angle), [-45, -45, 69, 70]),
      ).toBe(true);
    }
  });

  test("test_style_less_layer_keeps_its_bounds", () => {
    const leaf = asInstance(getitem(_leaves(ASSETS.div("choose_layer.psd")), "solo"), PsdLayer);
    expect(pyEq(mergedStylesBounds(leaf, 120.0), leaf.bounds)).toBe(true);
  });
});
