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
  py_assert,
  py_bool,
  py_eq,
  repr,
  sum,
} from "../../src/pyrt/index.ts";
import { make_tmp_path } from "../../src/pyrt/pytest.ts";
import { as_instance, get_comp, parse_project_fresh } from "../helpers.ts";
import { AVLayer } from "../../src/py_aep/models/layers/av_layer.ts";

import { parse as parse_aep, type Project } from "../../src/py_aep/index.ts";
import type { CompItem } from "../../src/py_aep/models/items/composition.ts";
import "../../src/py_aep/binary/_register.ts";
import { ListChunk, write_chunk } from "../../src/py_aep/binary/chunk.ts";
import { U4Chunk, Utf8Chunk } from "../../src/py_aep/binary/scalar_chunks.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";
import { PropertyValueType } from "../../src/py_aep/enums/index.ts";
import { build_media_cctl } from "../../src/py_aep/binary/mutations.ts";
import { _path_json, _source_property_path } from "../../src/py_aep/resolvers/motion_graphics.ts";
import { _walk_source_property } from "../../src/py_aep/resolvers/essential_properties.ts";

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
  return get_comp(project, "primary");
}

function _opacity(comp: CompItem): Property {
  const layer = comp.layers[0];
  return as_instance(next(layer.transform, (p) => p.matchName === "ADBE Opacity"), Property);
}

function _effect_param(comp: CompItem, effect_mn: string, param_mn: string, layer_index = 0): Property {
  const effects = as_instance(next(comp.layers[layer_index].properties, (p) => p.matchName === "ADBE Effect Parade"), PropertyGroup);
  const effect = as_instance(next(effects.properties, (p) => p.matchName === effect_mn), PropertyGroup);
  return as_instance(next(effect.properties, (p) => p.matchName === param_mn), Property);
}

function _cif3_cctls(comp: CompItem): ListChunk[] {
  const cif3 = as_instance(
    next(comp._item_list.chunks, (c) => c instanceof ListChunk && c.list_type === "CIF3"),
    ListChunk,
  );
  return cif3.chunks.filter((c): c is ListChunk => c instanceof ListChunk && c.list_type === "CCtl");
}

function _chunk_bytes(chunk: ListChunk): Uint8Array {
  const buf = new BytesIO();
  write_chunk(buf, chunk);
  return buf.getvalue();
}

/** Number of CCtl children per CIF container of a comp. */
function _cctl_count(comp: CompItem): Map<string, number> {
  const counts = new Map<string, number>();
  for (const cif of comp._item_list.chunks) {
    if (cif instanceof ListChunk && ["CIFO", "CIF2", "CIF3"].includes(cif.list_type)) {
      counts.set(
        cif.list_type,
        sum(cif.chunks.map((c) => (c instanceof ListChunk && c.list_type === "CCtl" ? 1 : 0))),
      );
    }
  }
  return counts;
}

describe("TestCanAddProperty", () => {
  test("test_opacity_can_be_added", () => {
    const comp = _primary(parse_project_fresh(BASE));
    expect(_opacity(comp).canAddToMotionGraphicsTemplate(comp)).toBe(true);
  });

  test("test_position_cannot_be_added", () => {
    // Position is a 2D/3D point, not a supported controller type.
    const comp = _primary(parse_project_fresh(BASE));
    const pos = as_instance(next(comp.layers[0].transform, (p) => p.matchName === "ADBE Position"), Property);
    expect(pos.canAddToMotionGraphicsTemplate(comp)).toBe(false);
  });

  test("test_wrong_comp_cannot_be_added", () => {
    const project = parse_project_fresh(BASE);
    const comp = _primary(project);
    const other = get_comp(project, "main");
    // The property's layer lives in 'primary', not 'main'.
    expect(_opacity(comp).canAddToMotionGraphicsTemplate(other)).toBe(false);
  });

  test("test_already_added_reports_false", () => {
    const comp = _primary(parse_project_fresh(BASE));
    const op = _opacity(comp);
    expect(op.addToMotionGraphicsTemplate(comp)).toBe(true);
    expect(op.canAddToMotionGraphicsTemplate(comp)).toBe(false);
  });

  test("test_mask_property_can_be_added", () => {
    // Mask Opacity lives under ADBE Mask Atom inside the indexed Mask
    // Parade: the mask atom node carries its 0-based parade position
    // (AE 2026 headless run), so the path is unambiguous and addable.
    const project = parse_project_fresh(EG_DIR.parent.div("property", "mask_add.aep"));
    const comp = project.compositions[0];
    const mask = as_instance(as_instance(comp.layers[0].masks, PropertyGroup).property(0), PropertyGroup);
    const mask_opacity = as_instance(next(mask.properties, (p) => p.matchName === "ADBE Mask Opacity"), Property);
    expect(mask_opacity.propertyValueType).toBe(PropertyValueType.OneD);
    expect(mask_opacity.canAddToMotionGraphicsTemplate(comp)).toBe(true);
  });

  test("test_added_effect_param_reports_false", () => {
    // The Slider Control param is already exposed in this fixture; the
    // (match_name, prop_index) pair comparison must catch it.
    const project = parse_project_fresh(EG_DIR.div("slider_controller.aep"));
    const comp = get_comp(project, "primary");
    const slider = _effect_param(comp, "ADBE Slider Control", "ADBE Slider Control-0001");
    expect(slider.propertyValueType).toBe(PropertyValueType.OneD);
    expect(slider.canAddToMotionGraphicsTemplate(comp)).toBe(false);
  });

  test("test_dropdown_param_cannot_be_added", () => {
    // A dropdown param is 1-D but AE exposes it as a type-13 Dropdown
    // controller (menu entries included), which py_aep does not build.
    const project = parse_project_fresh(EG_DIR.div("dropdown_controller.aep"));
    const comp = get_comp(project, "primary");
    const effects = as_instance(next(comp.layers[0].properties, (p) => p.matchName === "ADBE Effect Parade"), PropertyGroup);
    const pseudo = as_instance(next(effects.properties, (p) => p.matchName.startsWith("Pseudo/")), PropertyGroup);
    const menu = as_instance(pseudo.properties[0], Property);
    expect(menu.canAddToMotionGraphicsTemplate(comp)).toBe(false);
  });
});

describe("TestAddProperty", () => {
  test("test_add_registers_controller", () => {
    const comp = _primary(parse_project_fresh(BASE));
    const op = _opacity(comp);
    expect(op.addToMotionGraphicsTemplateAs(comp, "My Opacity")).toBe(true);
    expect(py_eq(comp.motionGraphicsTemplateControllerNames, ["My Opacity"])).toBe(true);
    const ctrl = comp.motionGraphicsControllers[0];
    expect(ctrl.controllerType).toBe(2); // Slider
    expect(ctrl.sourceCompId).toBe(comp.id);
    expect(ctrl.sourceLayerId).toBe(comp.layers[0]._ldta.layer_id);
    expect(
      py_eq(
        ctrl.sourcePropertyPath.map((r) => r.matchName),
        ["ADBE Transform Group", "ADBE Opacity"],
      ),
    ).toBe(true);
  });

  test("test_add_bumps_every_cif_container", () => {
    const comp = _primary(parse_project_fresh(BASE));
    expect(py_eq(new Set(_cctl_count(comp).values()), new Set([0]))).toBe(true);
    _opacity(comp).addToMotionGraphicsTemplate(comp);
    // AE keeps the CIFO/CIF2/CIF3 copies in sync.
    expect(
      py_eq(
        _cctl_count(comp),
        new Map([
          ["CIFO", 1],
          ["CIF2", 1],
          ["CIF3", 1],
        ]),
      ),
    ).toBe(true);
  });

  test("test_add_default_name_is_property_name", () => {
    const comp = _primary(parse_project_fresh(BASE));
    const op = _opacity(comp);
    expect(op.addToMotionGraphicsTemplate(comp)).toBe(true);
    expect(py_eq(comp.motionGraphicsTemplateControllerNames, [op.name])).toBe(true);
  });

  test("test_add_returns_false_when_already_added", () => {
    const comp = _primary(parse_project_fresh(BASE));
    const op = _opacity(comp);
    expect(op.addToMotionGraphicsTemplate(comp)).toBe(true);
    expect(op.addToMotionGraphicsTemplate(comp)).toBe(false);
    expect(len(comp.motionGraphicsControllers)).toBe(1);
  });

  test("test_add_survives_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(BASE);
    const comp = _primary(project);
    _opacity(comp).addToMotionGraphicsTemplateAs(comp, "Fade");
    const out = tmp_path.div("mgt.aep");
    project.save(out);
    const comp2 = _primary(parse_aep(out).project);
    expect(py_eq(comp2.motionGraphicsTemplateControllerNames, ["Fade"])).toBe(true);
    const ctrl = comp2.motionGraphicsControllers[0];
    expect(ctrl.controllerType).toBe(2);
    expect(ctrl.sourceCompId).toBe(comp2.id);
    expect(ctrl.sourceLayerId).toBe(comp2.layers[0]._ldta.layer_id);
    expect(
      py_eq(
        ctrl.sourcePropertyPath.map((r) => r.matchName),
        ["ADBE Transform Group", "ADBE Opacity"],
      ),
    ).toBe(true);
  });

  test("test_roundtrip_byte_identical", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(BASE);
    const comp = _primary(project);
    _opacity(comp).addToMotionGraphicsTemplateAs(comp, "Fade");
    const out = tmp_path.div("mgt.aep");
    project.save(out);
    const out2 = tmp_path.div("mgt2.aep");
    parse_aep(out).project.save(out2);
    expect(py_eq(out.read_bytes(), out2.read_bytes())).toBe(true);
  });
});

/** The CPrp index model, pinned against AE's own stored path JSONs. */
class TestEffectParamPaths {
  static _stored_json(comp: CompItem, ctrl_name: string): string {
    // The CPrp JSON of the named controller, straight from the chunks.
    for (const cctl of _cif3_cctls(comp)) {
      const cps2 = as_instance(next(cctl.chunks, (c) => getattr(c, "list_type", "") === "CpS2"), ListChunk);
      const name = as_instance(next(cps2.chunks, (c) => c.chunk_type === "Utf8"), Utf8Chunk).value;
      if (!py_eq(name, ctrl_name)) continue;
      const cprp = as_instance(next(cctl.chunks, (c) => getattr(c, "list_type", "") === "CPrp"), ListChunk);
      return as_instance(next(cprp.chunks, (c) => c.chunk_type === "Utf8"), Utf8Chunk).value;
    }
    throw new AssertionError_(`controller ${repr(ctrl_name)} not found`);
  }

  static _py_json(prop: Property): string {
    const resolved = _source_property_path(prop);
    py_assert(resolved != null);
    return _path_json(resolved[0]);
  }
}

describe("TestEffectParamPaths", () => {
  /** The CPrp index model, pinned against AE's own stored path JSONs. */

  test("test_second_effect_param_matches_ae", () => {
    // Slider Control is the SECOND effect (after Fill) -> parade index 1;
    // its visible param sits at parT slot 1 (slot 0 is the hidden header).
    const project = parse_project_fresh(EG_DIR.div("slider_controller.aep"));
    const comp = get_comp(project, "primary");
    const prop = _effect_param(comp, "ADBE Slider Control", "ADBE Slider Control-0001");
    expect(TestEffectParamPaths._py_json(prop)).toBe(TestEffectParamPaths._stored_json(comp, "Intensity"));
  });

  test("test_first_effect_deep_param_matches_ae", () => {
    // Fill is the only effect -> parade index 0; Fill-0002 sits at parT
    // slot 3 (after the header, -0001 and -0007).
    const project = parse_project_fresh(EG_DIR.div("fill_color_added.aep"));
    const comp = get_comp(project, "primary");
    const prop = _effect_param(comp, "ADBE Fill", "ADBE Fill-0002");
    expect(TestEffectParamPaths._py_json(prop)).toBe(TestEffectParamPaths._stored_json(comp, "Fill Color"));
  });

  test("test_both_orders_in_one_stack_match_ae", () => {
    const project = parse_project_fresh(EG_DIR.div("group_controller.aep"));
    const comp = next(project.compositions, (c) => py_bool(c.motionGraphicsControllers));
    const blur = _effect_param(comp, "ADBE Gaussian Blur 2", "ADBE Gaussian Blur 2-0001");
    const fill = _effect_param(comp, "ADBE Fill", "ADBE Fill-0002");
    expect(TestEffectParamPaths._py_json(blur)).toBe(
      TestEffectParamPaths._stored_json(comp, "Gaussian Blur Blurriness"),
    );
    expect(TestEffectParamPaths._py_json(fill)).toBe(TestEffectParamPaths._stored_json(comp, "Fill Color"));
  });

  test("test_effect_param_add_roundtrips", () => {
    const tmp_path = make_tmp_path();
    // Fill-0006 (Fill Opacity) is not exposed in the slider fixture:
    // Fill -> parade index 0, -0006 -> parT slot 4.
    const project = parse_project_fresh(EG_DIR.div("slider_controller.aep"));
    const comp = get_comp(project, "primary");
    const prop = _effect_param(comp, "ADBE Fill", "ADBE Fill-0006");
    expect(prop.canAddToMotionGraphicsTemplate(comp)).toBe(true);
    expect(prop.addToMotionGraphicsTemplateAs(comp, "Fill Opacity")).toBe(true);
    const out = tmp_path.div("effect.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "primary");
    const ctrl = next(comp2.motionGraphicsControllers, (c) => c.name === "Fill Opacity");
    expect(
      py_eq(
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
    const project = parse_project_fresh(EG_DIR.div("multiple_controllers.aep"));
    const comp = get_comp(project, "primary");
    const layer = comp.layers[0];
    const ctrl = next(comp.motionGraphicsControllers, (c) => c.name === "Background Color");
    const resolved = _walk_source_property(as_instance(layer, AVLayer), ctrl.sourcePropertyPath);
    const expected = _effect_param(comp, "ADBE Fill", "ADBE Fill-0002");
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
    return next(project.compositions, (c) => py_bool(c.motionGraphicsControllers));
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
    const project = parse_project_fresh(TestIndexedGroupControllers.FIXTURE);
    const comp = TestIndexedGroupControllers._comp(project);
    expect(len(comp.motionGraphicsControllers)).toBe(8);
    for (const ctrl of comp.motionGraphicsControllers) {
      const layer = getitem(comp.layersById, ctrl.sourceLayerId);
      const resolved = _walk_source_property(as_instance(layer, AVLayer), ctrl.sourcePropertyPath);
      py_assert(resolved != null, ctrl.name);
      const rebuilt = _source_property_path(as_instance(resolved, Property));
      py_assert(rebuilt != null, ctrl.name);
      py_assert(
        py_eq(
          rebuilt[0].map((n) => [n.match_name, n.prop_index]),
          ctrl.sourcePropertyPath.map((r) => [r.matchName, r.propIndex]),
        ),
        ctrl.name,
      );
    }
  });

  test("test_sibling_controllers_resolve_to_distinct_objects", () => {
    // The whole point of the indices: same match names, different
    // siblings. Mask 1/2 opacities, shape fill 1/2, animator 1/2.
    const project = parse_project_fresh(TestIndexedGroupControllers.FIXTURE);
    const comp = TestIndexedGroupControllers._comp(project);
    const by_name = new Map(comp.motionGraphicsControllers.map((c) => [c.name, c] as const));
    const pairs: [string, string][] = [
      ["Mask1 Opacity", "Mask2 Opacity"],
      ["Fill Color 1", "Fill Color 2"],
      ["Anim Opacity 1", "Anim Opacity 2"],
    ];
    for (const [a_name, b_name] of pairs) {
      const a_ctrl = getitem(by_name, a_name);
      const b_ctrl = getitem(by_name, b_name);
      const layer = getitem(comp.layersById, a_ctrl.sourceLayerId);
      const a = _walk_source_property(as_instance(layer, AVLayer), a_ctrl.sourcePropertyPath);
      const b = _walk_source_property(as_instance(layer, AVLayer), b_ctrl.sourcePropertyPath);
      py_assert(a != null && b != null);
      expect(a.matchName).toBe(b.matchName);
      expect(a).not.toBe(b);
    }
  });

  test("test_add_indexed_sibling_roundtrips", () => {
    const tmp_path = make_tmp_path();
    // Mask 2's Expansion is not exposed yet: adding it must store the
    // mask atom's positional index and survive a save/reparse.
    const project = parse_project_fresh(TestIndexedGroupControllers.FIXTURE);
    const comp = TestIndexedGroupControllers._comp(project);
    const solid = next(comp.layers, (lyr) => py_bool(lyr.masks));
    const masks = solid.masks;
    py_assert(masks != null);
    const expansion = as_instance(
      next(as_instance(masks.property(1), PropertyGroup).properties, (p) => p.matchName === "ADBE Mask Offset"),
      Property,
    );
    expect(expansion.canAddToMotionGraphicsTemplate(comp)).toBe(true);
    expect(expansion.addToMotionGraphicsTemplateAs(comp, "Mask2 Expansion")).toBe(true);
    const out = tmp_path.div("indexed.aep");
    project.save(out);
    const comp2 = TestIndexedGroupControllers._comp(parse_aep(out).project);
    const ctrl = next(comp2.motionGraphicsControllers, (c) => c.name === "Mask2 Expansion");
    expect(
      py_eq(
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
    const project = parse_project_fresh(TestIndexedGroupControllers.FIXTURE);
    const comp = TestIndexedGroupControllers._comp(project);
    const solid = next(comp.layers, (lyr) => py_bool(lyr.masks));
    const effects = as_instance(next(solid.properties, (p) => p.matchName === "ADBE Effect Parade"), PropertyGroup);
    const fx = as_instance(next(effects.properties, (p) => p.matchName === "ADBE Fractal Noise"), PropertyGroup);
    const prop = as_instance(next(fx.properties, (p) => p.matchName === "ADBE Fractal Noise-0010"), Property);
    const resolved = _source_property_path(prop);
    py_assert(resolved != null);
    expect(
      py_eq(
        resolved[0].map((n) => [n.match_name, n.prop_index]),
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
    const comp = _primary(parse_project_fresh(BASE));
    const layer = as_instance(comp.layers[0], AVLayer);
    expect(layer.canAddToMotionGraphicsTemplate(comp)).toBe(false);
  });

  test("test_already_exposed_layer_reports_false", () => {
    const project = parse_project_fresh(TestAddLayerMediaReplacement.MEDIA);
    const comp = get_comp(project, "image_with_alpha");
    expect(as_instance(comp.layers[0], AVLayer).canAddToMotionGraphicsTemplate(comp)).toBe(false);
  });

  test("test_add_precomp_layer_roundtrips", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(TestAddLayerMediaReplacement.MEDIA);
    const comp = get_comp(project, "image_with_alpha 2");
    const layer = as_instance(comp.layers[0], AVLayer);
    expect(layer.canAddToMotionGraphicsTemplate(comp)).toBe(true);
    expect(layer.addToMotionGraphicsTemplate(comp)).toBe(true);
    expect(layer.canAddToMotionGraphicsTemplate(comp)).toBe(false);
    const out = tmp_path.div("media.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "image_with_alpha 2");
    const ctrl = comp2.motionGraphicsControllers[0];
    expect(ctrl.controllerType).toBe(14);
    expect(ctrl.name).toBe(layer.name);
    expect(ctrl.sourceCompId).toBe(comp2.id);
    expect(ctrl.sourceLayerId).toBe(comp2.layers[0]._ldta.layer_id);
    expect(
      py_eq(
        ctrl.sourcePropertyPath.map((r) => r.matchName),
        ["ADBE Source Options Group", "ADBE Layer Source Alternate"],
      ),
    ).toBe(true);
    // The decoded source-media fields survive the round-trip.
    const cctl = _cif3_cctls(comp2)[0];
    const by_type = new Map(cctl.chunks.map((c) => [c.chunk_type, c] as const));
    expect(as_instance(getitem(by_type, "CSMw"), U4Chunk).value).toBe(640);
    expect(as_instance(getitem(by_type, "CSMh"), U4Chunk).value).toBe(346);
    expect(as_instance(getitem(by_type, "CSMs"), U4Chunk).value).toBe(0);
    expect(as_instance(getitem(by_type, "CSMe"), U4Chunk).value).toBe(720000);
    expect(as_instance(getitem(by_type, "CSMt"), U4Chunk).value).toBe(23976);
  });

  test("test_builder_matches_fixture_bytes", () => {
    // Byte parity: rebuilding the fixture's own controller from its
    // decoded inputs must reproduce AE's CCtl exactly.
    const project = parse_project_fresh(TestAddLayerMediaReplacement.MEDIA);
    const comp = get_comp(project, "image_with_alpha");
    const fixture_cctl = _cif3_cctls(comp)[0];
    const by_type = new Map(fixture_cctl.chunks.map((c) => [c.chunk_type, c] as const));
    const utf8s = fixture_cctl.chunks.filter((c) => c.chunk_type === "Utf8");
    const uuid_str = as_instance(utf8s[0], Utf8Chunk).value;
    const thumbnail = as_instance(utf8s[3], Utf8Chunk).value;
    const cprp = as_instance(next(fixture_cctl.chunks, (c) => getattr(c, "list_type", "") === "CPrp"), ListChunk);
    const path_json = as_instance(next(cprp.chunks, (c) => c.chunk_type === "Utf8"), Utf8Chunk).value;

    const [built, _name, _ctyp] = build_media_cctl(
      "image_with_alpha.png",
      uuid_str,
      640,
      346,
      0,
      720000,
      23976,
      thumbnail,
      2,
      14,
      path_json,
    );
    expect(py_eq(_chunk_bytes(built), _chunk_bytes(fixture_cctl))).toBe(true);
    expect(as_instance(getitem(by_type, "CSMd"), U4Chunk).value).toBe(2);
  });
});
