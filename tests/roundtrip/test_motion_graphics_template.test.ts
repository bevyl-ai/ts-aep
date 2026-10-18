/**
 * Tests for adding properties to a composition's Essential Graphics panel
 * (Motion Graphics template controllers).
 */

import { describe, expect, test } from "bun:test";

import {
  AssertionError_,
  BytesIO,
  Path,
  StopIteration,
  getattr,
  getitem,
  len,
  pyAssert,
  pyBool,
  pyEq,
  repr,
  sum,
} from "../../src/pyrt/index.ts";
import { makeTmpPath } from "../../src/pyrt/pytest.ts";
import { asInstance, getComp, parseProjectFresh } from "../helpers.ts";
import { AVLayer } from "../../src/py_aep/models/layers/av_layer.ts";

import { parse as parseAep, type Project } from "../../src/py_aep/index.ts";
import type { CompItem } from "../../src/py_aep/models/items/composition.ts";
import "../../src/py_aep/binary/_register.ts";
import { ListChunk, writeChunk } from "../../src/py_aep/binary/chunk.ts";
import { U4Chunk, Utf8Chunk } from "../../src/py_aep/binary/scalar_chunks.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";
import { PropertyValueType } from "../../src/py_aep/enums/index.ts";
import { buildMediaCctl } from "../../src/py_aep/binary/mutations.ts";
import { _pathJson, _sourcePropertyPath } from "../../src/py_aep/resolvers/motion_graphics.ts";
import { _walkSourceProperty } from "../../src/py_aep/resolvers/essential_properties.ts";

const EG_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "essential_graphics");
const BASE = EG_DIR.div("base.aep");

// NOTE(port): no pyrt `next()` shim; local helper matches Python's `next(gen)`.
// Returns the first element matching `pred`, raising StopIteration when none does.
function next<T>(xs: Iterable<T>, pred: (x: T) => boolean): T {
  for (const x of xs) if (pred(x)) return x;
  throw new StopIteration("");
}

function _primary(project: Project): CompItem {
  // base.aep: comp 'primary' (id 1) holds one solid layer (layer_id 15).
  return getComp(project, "primary");
}

function _opacity(comp: CompItem): Property {
  const layer = comp.layers[0];
  return asInstance(next(layer.transform, (p) => p.matchName === "ADBE Opacity"), Property);
}

function _effectParam(comp: CompItem, effectMn: string, paramMn: string, layerIndex = 0): Property {
  const effects = asInstance(next(comp.layers[layerIndex].properties, (p) => p.matchName === "ADBE Effect Parade"), PropertyGroup);
  const effect = asInstance(next(effects.properties, (p) => p.matchName === effectMn), PropertyGroup);
  return asInstance(next(effect.properties, (p) => p.matchName === paramMn), Property);
}

function _cif3Cctls(comp: CompItem): ListChunk[] {
  const cif3 = asInstance(
    next(comp._itemList.chunks, (c) => c instanceof ListChunk && c.listType === "CIF3"),
    ListChunk,
  );
  return cif3.chunks.filter((c): c is ListChunk => c instanceof ListChunk && c.listType === "CCtl");
}

function _chunkBytes(chunk: ListChunk): Uint8Array {
  const buf = new BytesIO();
  writeChunk(buf, chunk);
  return buf.getvalue();
}

/** Number of CCtl children per CIF container of a comp. */
function _cctlCount(comp: CompItem): Map<string, number> {
  const counts = new Map<string, number>();
  for (const cif of comp._itemList.chunks) {
    if (cif instanceof ListChunk && ["CIFO", "CIF2", "CIF3"].includes(cif.listType)) {
      counts.set(
        cif.listType,
        sum(cif.chunks.map((c) => (c instanceof ListChunk && c.listType === "CCtl" ? 1 : 0))),
      );
    }
  }
  return counts;
}

describe("TestCanAddProperty", () => {
  test("test_opacity_can_be_added", () => {
    const comp = _primary(parseProjectFresh(BASE));
    expect(_opacity(comp).canAddToMotionGraphicsTemplate(comp)).toBe(true);
  });

  test("test_position_cannot_be_added", () => {
    // Position is a 2D/3D point, not a supported controller type.
    const comp = _primary(parseProjectFresh(BASE));
    const pos = asInstance(next(comp.layers[0].transform, (p) => p.matchName === "ADBE Position"), Property);
    expect(pos.canAddToMotionGraphicsTemplate(comp)).toBe(false);
  });

  test("test_wrong_comp_cannot_be_added", () => {
    const project = parseProjectFresh(BASE);
    const comp = _primary(project);
    const other = getComp(project, "main");
    // The property's layer lives in 'primary', not 'main'.
    expect(_opacity(comp).canAddToMotionGraphicsTemplate(other)).toBe(false);
  });

  test("test_already_added_reports_false", () => {
    const comp = _primary(parseProjectFresh(BASE));
    const op = _opacity(comp);
    expect(op.addToMotionGraphicsTemplate(comp)).toBe(true);
    expect(op.canAddToMotionGraphicsTemplate(comp)).toBe(false);
  });

  test("test_mask_property_can_be_added", () => {
    // Mask Opacity lives under ADBE Mask Atom inside the indexed Mask
    // Parade: the mask atom node carries its 0-based parade position
    // (AE 2026 headless run), so the path is unambiguous and addable.
    const project = parseProjectFresh(EG_DIR.parent.div("property", "mask_add.aep"));
    const comp = project.compositions[0];
    const mask = asInstance(asInstance(comp.layers[0].masks, PropertyGroup).property(0), PropertyGroup);
    const maskOpacity = asInstance(next(mask.properties, (p) => p.matchName === "ADBE Mask Opacity"), Property);
    expect(maskOpacity.propertyValueType).toBe(PropertyValueType.OneD);
    expect(maskOpacity.canAddToMotionGraphicsTemplate(comp)).toBe(true);
  });

  test("test_added_effect_param_reports_false", () => {
    // The Slider Control param is already exposed in this fixture; the
    // (match_name, prop_index) pair comparison must catch it.
    const project = parseProjectFresh(EG_DIR.div("slider_controller.aep"));
    const comp = getComp(project, "primary");
    const slider = _effectParam(comp, "ADBE Slider Control", "ADBE Slider Control-0001");
    expect(slider.propertyValueType).toBe(PropertyValueType.OneD);
    expect(slider.canAddToMotionGraphicsTemplate(comp)).toBe(false);
  });

  test("test_dropdown_param_cannot_be_added", () => {
    // A dropdown param is 1-D but AE exposes it as a type-13 Dropdown
    // controller (menu entries included), which py_aep does not build.
    const project = parseProjectFresh(EG_DIR.div("dropdown_controller.aep"));
    const comp = getComp(project, "primary");
    const effects = asInstance(next(comp.layers[0].properties, (p) => p.matchName === "ADBE Effect Parade"), PropertyGroup);
    const pseudo = asInstance(next(effects.properties, (p) => p.matchName.startsWith("Pseudo/")), PropertyGroup);
    const menu = asInstance(pseudo.properties[0], Property);
    expect(menu.canAddToMotionGraphicsTemplate(comp)).toBe(false);
  });
});

describe("TestAddProperty", () => {
  test("test_add_registers_controller", () => {
    const comp = _primary(parseProjectFresh(BASE));
    const op = _opacity(comp);
    expect(op.addToMotionGraphicsTemplateAs(comp, "My Opacity")).toBe(true);
    expect(pyEq(comp.motionGraphicsTemplateControllerNames, ["My Opacity"])).toBe(true);
    const ctrl = comp.motionGraphicsControllers[0];
    expect(ctrl.controllerType).toBe(2); // Slider
    expect(ctrl.sourceCompId).toBe(comp.id);
    expect(ctrl.sourceLayerId).toBe(comp.layers[0]._ldta.layerId);
    expect(
      pyEq(
        ctrl.sourcePropertyPath.map((r) => r.matchName),
        ["ADBE Transform Group", "ADBE Opacity"],
      ),
    ).toBe(true);
  });

  test("test_add_bumps_every_cif_container", () => {
    const comp = _primary(parseProjectFresh(BASE));
    expect(pyEq(new Set(_cctlCount(comp).values()), new Set([0]))).toBe(true);
    _opacity(comp).addToMotionGraphicsTemplate(comp);
    // AE keeps the CIFO/CIF2/CIF3 copies in sync.
    expect(
      pyEq(
        _cctlCount(comp),
        new Map([
          ["CIFO", 1],
          ["CIF2", 1],
          ["CIF3", 1],
        ]),
      ),
    ).toBe(true);
  });

  test("test_add_default_name_is_property_name", () => {
    const comp = _primary(parseProjectFresh(BASE));
    const op = _opacity(comp);
    expect(op.addToMotionGraphicsTemplate(comp)).toBe(true);
    expect(pyEq(comp.motionGraphicsTemplateControllerNames, [op.name])).toBe(true);
  });

  test("test_add_returns_false_when_already_added", () => {
    const comp = _primary(parseProjectFresh(BASE));
    const op = _opacity(comp);
    expect(op.addToMotionGraphicsTemplate(comp)).toBe(true);
    expect(op.addToMotionGraphicsTemplate(comp)).toBe(false);
    expect(len(comp.motionGraphicsControllers)).toBe(1);
  });

  test("test_add_survives_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(BASE);
    const comp = _primary(project);
    _opacity(comp).addToMotionGraphicsTemplateAs(comp, "Fade");
    const out = tmpPath.div("mgt.aep");
    project.save(out);
    const comp2 = _primary(parseAep(out).project);
    expect(pyEq(comp2.motionGraphicsTemplateControllerNames, ["Fade"])).toBe(true);
    const ctrl = comp2.motionGraphicsControllers[0];
    expect(ctrl.controllerType).toBe(2);
    expect(ctrl.sourceCompId).toBe(comp2.id);
    expect(ctrl.sourceLayerId).toBe(comp2.layers[0]._ldta.layerId);
    expect(
      pyEq(
        ctrl.sourcePropertyPath.map((r) => r.matchName),
        ["ADBE Transform Group", "ADBE Opacity"],
      ),
    ).toBe(true);
  });

  test("test_roundtrip_byte_identical", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(BASE);
    const comp = _primary(project);
    _opacity(comp).addToMotionGraphicsTemplateAs(comp, "Fade");
    const out = tmpPath.div("mgt.aep");
    project.save(out);
    const out2 = tmpPath.div("mgt2.aep");
    parseAep(out).project.save(out2);
    expect(pyEq(out.readBytes(), out2.readBytes())).toBe(true);
  });
});

/** The CPrp index model, pinned against AE's own stored path JSONs. */
class TestEffectParamPaths {
  static _stored_json(comp: CompItem, ctrlName: string): string {
    // The CPrp JSON of the named controller, straight from the chunks.
    for (const cctl of _cif3Cctls(comp)) {
      const cps2 = asInstance(next(cctl.chunks, (c) => getattr(c, "listType", "") === "CpS2"), ListChunk);
      const name = asInstance(next(cps2.chunks, (c) => c.chunkType === "Utf8"), Utf8Chunk).value;
      if (!pyEq(name, ctrlName)) continue;
      const cprp = asInstance(next(cctl.chunks, (c) => getattr(c, "listType", "") === "CPrp"), ListChunk);
      return asInstance(next(cprp.chunks, (c) => c.chunkType === "Utf8"), Utf8Chunk).value;
    }
    throw new AssertionError_(`controller ${repr(ctrlName)} not found`);
  }

  static _py_json(prop: Property): string {
    const resolved = _sourcePropertyPath(prop);
    pyAssert(resolved != null);
    return _pathJson(resolved[0]);
  }
}

describe("TestEffectParamPaths", () => {
  /** The CPrp index model, pinned against AE's own stored path JSONs. */

  test("test_second_effect_param_matches_ae", () => {
    // Slider Control is the SECOND effect (after Fill) -> parade index 1;
    // its visible param sits at parT slot 1 (slot 0 is the hidden header).
    const project = parseProjectFresh(EG_DIR.div("slider_controller.aep"));
    const comp = getComp(project, "primary");
    const prop = _effectParam(comp, "ADBE Slider Control", "ADBE Slider Control-0001");
    expect(TestEffectParamPaths._py_json(prop)).toBe(TestEffectParamPaths._stored_json(comp, "Intensity"));
  });

  test("test_first_effect_deep_param_matches_ae", () => {
    // Fill is the only effect -> parade index 0; Fill-0002 sits at parT
    // slot 3 (after the header, -0001 and -0007).
    const project = parseProjectFresh(EG_DIR.div("fill_color_added.aep"));
    const comp = getComp(project, "primary");
    const prop = _effectParam(comp, "ADBE Fill", "ADBE Fill-0002");
    expect(TestEffectParamPaths._py_json(prop)).toBe(TestEffectParamPaths._stored_json(comp, "Fill Color"));
  });

  test("test_both_orders_in_one_stack_match_ae", () => {
    const project = parseProjectFresh(EG_DIR.div("group_controller.aep"));
    const comp = next(project.compositions, (c) => pyBool(c.motionGraphicsControllers));
    const blur = _effectParam(comp, "ADBE Gaussian Blur 2", "ADBE Gaussian Blur 2-0001");
    const fill = _effectParam(comp, "ADBE Fill", "ADBE Fill-0002");
    expect(TestEffectParamPaths._py_json(blur)).toBe(
      TestEffectParamPaths._stored_json(comp, "Gaussian Blur Blurriness"),
    );
    expect(TestEffectParamPaths._py_json(fill)).toBe(TestEffectParamPaths._stored_json(comp, "Fill Color"));
  });

  test("test_effect_param_add_roundtrips", () => {
    const tmpPath = makeTmpPath();
    // Fill-0006 (Fill Opacity) is not exposed in the slider fixture:
    // Fill -> parade index 0, -0006 -> parT slot 4.
    const project = parseProjectFresh(EG_DIR.div("slider_controller.aep"));
    const comp = getComp(project, "primary");
    const prop = _effectParam(comp, "ADBE Fill", "ADBE Fill-0006");
    expect(prop.canAddToMotionGraphicsTemplate(comp)).toBe(true);
    expect(prop.addToMotionGraphicsTemplateAs(comp, "Fill Opacity")).toBe(true);
    const out = tmpPath.div("effect.aep");
    project.save(out);
    const comp2 = getComp(parseAep(out).project, "primary");
    const ctrl = next(comp2.motionGraphicsControllers, (c) => c.name === "Fill Opacity");
    expect(
      pyEq(
        ctrl.sourcePropertyPath.map((r) => [r.matchName, r.propIndex]),
        [
          ["ADBE Effect Parade", null],
          ["ADBE Fill", 0],
          ["ADBE Fill-0006", 4],
        ],
      ),
    ).toBe(true);
  });
});

describe("TestIndexAwareResolution", () => {
  test("test_controller_path_resolves_to_exact_param", () => {
    const project = parseProjectFresh(EG_DIR.div("multiple_controllers.aep"));
    const comp = getComp(project, "primary");
    const layer = comp.layers[0];
    const ctrl = next(comp.motionGraphicsControllers, (c) => c.name === "Background Color");
    const resolved = _walkSourceProperty(asInstance(layer, AVLayer), ctrl.sourcePropertyPath);
    const expected = _effectParam(comp, "ADBE Fill", "ADBE Fill-0002");
    expect(resolved).toBe(expected);
  });
});

/**
 * indexed_group_controllers.aep: 8 controllers AE 2026 created on
 * masks, shape contents, text animators and effect topic-group params.
 * Every stored path must resolve, and py must rebuild it identically.
 */
class TestIndexedGroupControllers {
  static FIXTURE = EG_DIR.div("indexed_group_controllers.aep");

  static _comp(project: Project): CompItem {
    return next(project.compositions, (c) => pyBool(c.motionGraphicsControllers));
  }
}

describe("TestIndexedGroupControllers", () => {
  /**
   * indexed_group_controllers.aep: 8 controllers AE 2026 created on
   * masks, shape contents, text animators and effect topic-group params.
   * Every stored path must resolve, and py must rebuild it identically.
   */

  test("test_every_ae_path_roundtrips_through_py", () => {
    // Bidirectional check per controller: resolve AE's stored path to
    // the source property (read side), then rebuild the path from that
    // property (write side) and compare with what AE stored.
    const project = parseProjectFresh(TestIndexedGroupControllers.FIXTURE);
    const comp = TestIndexedGroupControllers._comp(project);
    expect(len(comp.motionGraphicsControllers)).toBe(8);
    for (const ctrl of comp.motionGraphicsControllers) {
      const layer = getitem(comp.layersById, ctrl.sourceLayerId);
      const resolved = _walkSourceProperty(asInstance(layer, AVLayer), ctrl.sourcePropertyPath);
      pyAssert(resolved != null, ctrl.name);
      const rebuilt = _sourcePropertyPath(asInstance(resolved, Property));
      pyAssert(rebuilt != null, ctrl.name);
      pyAssert(
        pyEq(
          rebuilt[0].map((n) => [n.matchName, n.propIndex]),
          ctrl.sourcePropertyPath.map((r) => [r.matchName, r.propIndex]),
        ),
        ctrl.name,
      );
    }
  });

  test("test_sibling_controllers_resolve_to_distinct_objects", () => {
    // The whole point of the indices: same match names, different
    // siblings. Mask 1/2 opacities, shape fill 1/2, animator 1/2.
    const project = parseProjectFresh(TestIndexedGroupControllers.FIXTURE);
    const comp = TestIndexedGroupControllers._comp(project);
    const byName = new Map(comp.motionGraphicsControllers.map((c) => [c.name, c] as const));
    const pairs: [string, string][] = [
      ["Mask1 Opacity", "Mask2 Opacity"],
      ["Fill Color 1", "Fill Color 2"],
      ["Anim Opacity 1", "Anim Opacity 2"],
    ];
    for (const [aName, bName] of pairs) {
      const aCtrl = getitem(byName, aName);
      const bCtrl = getitem(byName, bName);
      const layer = getitem(comp.layersById, aCtrl.sourceLayerId);
      const a = _walkSourceProperty(asInstance(layer, AVLayer), aCtrl.sourcePropertyPath);
      const b = _walkSourceProperty(asInstance(layer, AVLayer), bCtrl.sourcePropertyPath);
      pyAssert(a != null && b != null);
      expect(a.matchName).toBe(b.matchName);
      expect(a).not.toBe(b);
    }
  });

  test("test_add_indexed_sibling_roundtrips", () => {
    const tmpPath = makeTmpPath();
    // Mask 2's Expansion is not exposed yet: adding it must store the
    // mask atom's positional index and survive a save/reparse.
    const project = parseProjectFresh(TestIndexedGroupControllers.FIXTURE);
    const comp = TestIndexedGroupControllers._comp(project);
    const solid = next(comp.layers, (lyr) => pyBool(lyr.masks));
    const masks = solid.masks;
    pyAssert(masks != null);
    const expansion = asInstance(
      next(asInstance(masks.property(1), PropertyGroup).properties, (p) => p.matchName === "ADBE Mask Offset"),
      Property,
    );
    expect(expansion.canAddToMotionGraphicsTemplate(comp)).toBe(true);
    expect(expansion.addToMotionGraphicsTemplateAs(comp, "Mask2 Expansion")).toBe(true);
    const out = tmpPath.div("indexed.aep");
    project.save(out);
    const comp2 = TestIndexedGroupControllers._comp(parseAep(out).project);
    const ctrl = next(comp2.motionGraphicsControllers, (c) => c.name === "Mask2 Expansion");
    expect(
      pyEq(
        ctrl.sourcePropertyPath.map((r) => [r.matchName, r.propIndex]),
        [
          ["ADBE Mask Parade", null],
          ["ADBE Mask Atom", 1],
          ["ADBE Mask Offset", null],
        ],
      ),
    ).toBe(true);
  });

  test("test_effect_topic_group_param_matches_ae", () => {
    // Fractal Noise's Scale (-0010) sits inside the "Transform" topic
    // group in the UI; AE stores the flat parT slot (10) and no
    // topic-group node - py must rebuild exactly that.
    const project = parseProjectFresh(TestIndexedGroupControllers.FIXTURE);
    const comp = TestIndexedGroupControllers._comp(project);
    const solid = next(comp.layers, (lyr) => pyBool(lyr.masks));
    const effects = asInstance(next(solid.properties, (p) => p.matchName === "ADBE Effect Parade"), PropertyGroup);
    const fx = asInstance(next(effects.properties, (p) => p.matchName === "ADBE Fractal Noise"), PropertyGroup);
    const prop = asInstance(next(fx.properties, (p) => p.matchName === "ADBE Fractal Noise-0010"), Property);
    const resolved = _sourcePropertyPath(prop);
    pyAssert(resolved != null);
    expect(
      pyEq(
        resolved[0].map((n) => [n.matchName, n.propIndex]),
        [
          ["ADBE Effect Parade", null],
          ["ADBE Fractal Noise", 0],
          ["ADBE Fractal Noise-0010", 10],
        ],
      ),
    ).toBe(true);
    // Already exposed by the AE run, so re-adding reports False.
    expect(prop.canAddToMotionGraphicsTemplate(comp)).toBe(false);
  });
});

class TestAddLayerMediaReplacement {
  static MEDIA = EG_DIR.div("media_replacement.aep");
}

describe("TestAddLayerMediaReplacement", () => {
  test("test_solid_layer_cannot_be_added", () => {
    // base.aep's only 'primary' layer is a solid: not a Media Replacement
    // layer, so it is not addable.
    const comp = _primary(parseProjectFresh(BASE));
    const layer = asInstance(comp.layers[0], AVLayer);
    expect(layer.canAddToMotionGraphicsTemplate(comp)).toBe(false);
  });

  test("test_already_exposed_layer_reports_false", () => {
    const project = parseProjectFresh(TestAddLayerMediaReplacement.MEDIA);
    const comp = getComp(project, "image_with_alpha");
    expect(asInstance(comp.layers[0], AVLayer).canAddToMotionGraphicsTemplate(comp)).toBe(false);
  });

  test("test_add_precomp_layer_roundtrips", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(TestAddLayerMediaReplacement.MEDIA);
    const comp = getComp(project, "image_with_alpha 2");
    const layer = asInstance(comp.layers[0], AVLayer);
    expect(layer.canAddToMotionGraphicsTemplate(comp)).toBe(true);
    expect(layer.addToMotionGraphicsTemplate(comp)).toBe(true);
    expect(layer.canAddToMotionGraphicsTemplate(comp)).toBe(false);
    const out = tmpPath.div("media.aep");
    project.save(out);
    const comp2 = getComp(parseAep(out).project, "image_with_alpha 2");
    const ctrl = comp2.motionGraphicsControllers[0];
    expect(ctrl.controllerType).toBe(14);
    expect(ctrl.name).toBe(layer.name);
    expect(ctrl.sourceCompId).toBe(comp2.id);
    expect(ctrl.sourceLayerId).toBe(comp2.layers[0]._ldta.layerId);
    expect(
      pyEq(
        ctrl.sourcePropertyPath.map((r) => r.matchName),
        ["ADBE Source Options Group", "ADBE Layer Source Alternate"],
      ),
    ).toBe(true);
    // The decoded source-media fields survive the round-trip.
    const cctl = _cif3Cctls(comp2)[0];
    const byType = new Map(cctl.chunks.map((c) => [c.chunkType, c] as const));
    expect(asInstance(getitem(byType, "CSMw"), U4Chunk).value).toBe(640);
    expect(asInstance(getitem(byType, "CSMh"), U4Chunk).value).toBe(346);
    expect(asInstance(getitem(byType, "CSMs"), U4Chunk).value).toBe(0);
    expect(asInstance(getitem(byType, "CSMe"), U4Chunk).value).toBe(720000);
    expect(asInstance(getitem(byType, "CSMt"), U4Chunk).value).toBe(23976);
  });

  test("test_builder_matches_fixture_bytes", () => {
    // Byte parity: rebuilding the fixture's own controller from its
    // decoded inputs must reproduce AE's CCtl exactly.
    const project = parseProjectFresh(TestAddLayerMediaReplacement.MEDIA);
    const comp = getComp(project, "image_with_alpha");
    const fixtureCctl = _cif3Cctls(comp)[0];
    const byType = new Map(fixtureCctl.chunks.map((c) => [c.chunkType, c] as const));
    const utf8s = fixtureCctl.chunks.filter((c) => c.chunkType === "Utf8");
    const uuidStr = asInstance(utf8s[0], Utf8Chunk).value;
    const thumbnail = asInstance(utf8s[3], Utf8Chunk).value;
    const cprp = asInstance(next(fixtureCctl.chunks, (c) => getattr(c, "listType", "") === "CPrp"), ListChunk);
    const pathJson = asInstance(next(cprp.chunks, (c) => c.chunkType === "Utf8"), Utf8Chunk).value;

    const [built, _name, _ctyp] = buildMediaCctl(
      "image_with_alpha.png",
      uuidStr,
      640,
      346,
      0,
      720000,
      23976,
      thumbnail,
      2,
      14,
      pathJson,
    );
    expect(pyEq(_chunkBytes(built), _chunkBytes(fixtureCctl))).toBe(true);
    expect(asInstance(getitem(byType, "CSMd"), U4Chunk).value).toBe(2);
  });
});
