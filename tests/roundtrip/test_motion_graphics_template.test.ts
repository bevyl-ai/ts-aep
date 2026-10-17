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

import { parse as parse_aep } from "../../src/py_aep/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { ListChunk, write_chunk } from "../../src/py_aep/binary/chunk.ts";
import { Utf8Chunk } from "../../src/py_aep/binary/scalar_chunks.ts";
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

function _primary(project: any): any {
  // base.aep: comp 'primary' (id 1) holds one solid layer (layer_id 15).
  return get_comp(project, "primary");
}

function _opacity(comp: any): any {
  const layer = comp.layers[0];
  return next(layer.transform, (p: any) => p.match_name === "ADBE Opacity");
}

function _effect_param(comp: any, effect_mn: string, param_mn: string, layer_index = 0): any {
  const effects = next(comp.layers[layer_index].properties, (p: any) => p.match_name === "ADBE Effect Parade");
  const effect = next(effects.properties, (p: any) => p.match_name === effect_mn);
  return next(effect.properties, (p: any) => p.match_name === param_mn);
}

function _cif3_cctls(comp: any): ListChunk[] {
  const cif3 = next(
    comp._item_list.chunks,
    (c: any) => c instanceof ListChunk && c.list_type === "CIF3",
  );
  return cif3.chunks.filter((c: any) => c instanceof ListChunk && c.list_type === "CCtl");
}

function _chunk_bytes(chunk: any): Uint8Array {
  const buf = new BytesIO();
  write_chunk(buf, chunk);
  return buf.getvalue();
}

/** Number of CCtl children per CIF container of a comp. */
function _cctl_count(comp: any): Map<string, number> {
  const counts = new Map<string, number>();
  for (const cif of comp._item_list.chunks) {
    if (cif instanceof ListChunk && ["CIFO", "CIF2", "CIF3"].includes(cif.list_type)) {
      counts.set(
        cif.list_type,
        sum(cif.chunks.map((c: any) => (c instanceof ListChunk && c.list_type === "CCtl" ? 1 : 0))),
      );
    }
  }
  return counts;
}

describe("TestCanAddProperty", () => {
  test("test_opacity_can_be_added", () => {
    const comp = _primary(parse_project_fresh(BASE));
    expect(_opacity(comp).can_add_to_motion_graphics_template(comp)).toBe(true);
  });

  test("test_position_cannot_be_added", () => {
    // Position is a 2D/3D point, not a supported controller type.
    const comp = _primary(parse_project_fresh(BASE));
    const pos = next(comp.layers[0].transform, (p: any) => p.match_name === "ADBE Position");
    expect(pos.can_add_to_motion_graphics_template(comp)).toBe(false);
  });

  test("test_wrong_comp_cannot_be_added", () => {
    const project = parse_project_fresh(BASE);
    const comp = _primary(project);
    const other = get_comp(project, "main");
    // The property's layer lives in 'primary', not 'main'.
    expect(_opacity(comp).can_add_to_motion_graphics_template(other)).toBe(false);
  });

  test("test_already_added_reports_false", () => {
    const comp = _primary(parse_project_fresh(BASE));
    const op = _opacity(comp);
    expect(op.add_to_motion_graphics_template(comp)).toBe(true);
    expect(op.can_add_to_motion_graphics_template(comp)).toBe(false);
  });

  test("test_mask_property_can_be_added", () => {
    // Mask Opacity lives under ADBE Mask Atom inside the indexed Mask
    // Parade: the mask atom node carries its 0-based parade position
    // (AE 2026 headless run), so the path is unambiguous and addable.
    const project = parse_project_fresh(EG_DIR.parent.div("property", "mask_add.aep"));
    const comp = project.compositions[0];
    const mask = as_instance(comp.layers[0].masks, PropertyGroup).__getitem__(0);
    const mask_opacity = next((mask as any).properties, (p: any) => p.match_name === "ADBE Mask Opacity");
    expect(mask_opacity.property_value_type).toBe(PropertyValueType.OneD);
    expect(mask_opacity.can_add_to_motion_graphics_template(comp)).toBe(true);
  });

  test("test_added_effect_param_reports_false", () => {
    // The Slider Control param is already exposed in this fixture; the
    // (match_name, prop_index) pair comparison must catch it.
    const project = parse_project_fresh(EG_DIR.div("slider_controller.aep"));
    const comp = get_comp(project, "primary");
    const slider = _effect_param(comp, "ADBE Slider Control", "ADBE Slider Control-0001");
    expect(slider.property_value_type).toBe(PropertyValueType.OneD);
    expect(slider.can_add_to_motion_graphics_template(comp)).toBe(false);
  });

  test("test_dropdown_param_cannot_be_added", () => {
    // A dropdown param is 1-D but AE exposes it as a type-13 Dropdown
    // controller (menu entries included), which py_aep does not build.
    const project = parse_project_fresh(EG_DIR.div("dropdown_controller.aep"));
    const comp = get_comp(project, "primary");
    const effects = as_instance(next(comp.layers[0].properties, (p: any) => p.match_name === "ADBE Effect Parade"), PropertyGroup);
    const pseudo = as_instance(next(effects.properties, (p: any) => p.match_name.startsWith("Pseudo/")), PropertyGroup);
    const menu = as_instance(pseudo.properties[0], Property);
    expect(menu.can_add_to_motion_graphics_template(comp)).toBe(false);
  });
});

describe("TestAddProperty", () => {
  test("test_add_registers_controller", () => {
    const comp = _primary(parse_project_fresh(BASE));
    const op = _opacity(comp);
    expect(op.add_to_motion_graphics_template_as(comp, "My Opacity")).toBe(true);
    expect(py_eq(comp.motion_graphics_template_controller_names, ["My Opacity"])).toBe(true);
    const ctrl = comp.motion_graphics_controllers[0];
    expect(ctrl.controller_type).toBe(2); // Slider
    expect(ctrl.source_comp_id).toBe(comp.id);
    expect(ctrl.source_layer_id).toBe(comp.layers[0]._ldta.layer_id);
    expect(
      py_eq(
        ctrl.source_property_path.map((r: any) => r.match_name),
        ["ADBE Transform Group", "ADBE Opacity"],
      ),
    ).toBe(true);
  });

  test("test_add_bumps_every_cif_container", () => {
    const comp = _primary(parse_project_fresh(BASE));
    expect(py_eq(new Set(_cctl_count(comp).values()), new Set([0]))).toBe(true);
    _opacity(comp).add_to_motion_graphics_template(comp);
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
    expect(op.add_to_motion_graphics_template(comp)).toBe(true);
    expect(py_eq(comp.motion_graphics_template_controller_names, [op.name])).toBe(true);
  });

  test("test_add_returns_false_when_already_added", () => {
    const comp = _primary(parse_project_fresh(BASE));
    const op = _opacity(comp);
    expect(op.add_to_motion_graphics_template(comp)).toBe(true);
    expect(op.add_to_motion_graphics_template(comp)).toBe(false);
    expect(len(comp.motion_graphics_controllers)).toBe(1);
  });

  test("test_add_survives_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(BASE);
    const comp = _primary(project);
    _opacity(comp).add_to_motion_graphics_template_as(comp, "Fade");
    const out = tmp_path.div("mgt.aep");
    project.save(out);
    const comp2 = _primary(parse_aep(out).project);
    expect(py_eq(comp2.motion_graphics_template_controller_names, ["Fade"])).toBe(true);
    const ctrl = comp2.motion_graphics_controllers[0];
    expect(ctrl.controller_type).toBe(2);
    expect(ctrl.source_comp_id).toBe(comp2.id);
    expect(ctrl.source_layer_id).toBe(comp2.layers[0]._ldta.layer_id);
    expect(
      py_eq(
        ctrl.source_property_path.map((r: any) => r.match_name),
        ["ADBE Transform Group", "ADBE Opacity"],
      ),
    ).toBe(true);
  });

  test("test_roundtrip_byte_identical", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(BASE);
    const comp = _primary(project);
    _opacity(comp).add_to_motion_graphics_template_as(comp, "Fade");
    const out = tmp_path.div("mgt.aep");
    project.save(out);
    const out2 = tmp_path.div("mgt2.aep");
    parse_aep(out).project.save(out2);
    expect(py_eq(out.read_bytes(), out2.read_bytes())).toBe(true);
  });
});

/** The CPrp index model, pinned against AE's own stored path JSONs. */
class TestEffectParamPaths {
  static _stored_json(comp: any, ctrl_name: string): string {
    // The CPrp JSON of the named controller, straight from the chunks.
    for (const cctl of _cif3_cctls(comp)) {
      const cps2 = as_instance(next(cctl.chunks, (c: any) => getattr(c, "list_type", "") === "CpS2"), ListChunk);
      const name = as_instance(next(cps2.chunks, (c: any) => c.chunk_type === "Utf8"), Utf8Chunk).value;
      if (!py_eq(name, ctrl_name)) continue;
      const cprp = as_instance(next(cctl.chunks, (c: any) => getattr(c, "list_type", "") === "CPrp"), ListChunk);
      return as_instance(next(cprp.chunks, (c: any) => c.chunk_type === "Utf8"), Utf8Chunk).value;
    }
    throw new AssertionError_(`controller ${repr(ctrl_name)} not found`);
  }

  static _py_json(prop: any): string {
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
    const comp = next(project.compositions, (c: any) => py_bool(c.motion_graphics_controllers));
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
    expect(prop.can_add_to_motion_graphics_template(comp)).toBe(true);
    expect(prop.add_to_motion_graphics_template_as(comp, "Fill Opacity")).toBe(true);
    const out = tmp_path.div("effect.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "primary");
    const ctrl = next(comp2.motion_graphics_controllers, (c: any) => c.name === "Fill Opacity");
    expect(
      py_eq(
        ctrl.source_property_path.map((r: any) => [r.match_name, r.prop_index]),
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
    const ctrl = next(comp.motion_graphics_controllers, (c: any) => c.name === "Background Color");
    const resolved = _walk_source_property(layer as any, ctrl.source_property_path);
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

  static _comp(project: any): any {
    return next(project.compositions, (c: any) => py_bool(c.motion_graphics_controllers));
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
    expect(len(comp.motion_graphics_controllers)).toBe(8);
    for (const ctrl of comp.motion_graphics_controllers) {
      const layer = getitem(comp.layers_by_id, ctrl.source_layer_id);
      const resolved = _walk_source_property(layer as any, ctrl.source_property_path);
      py_assert(resolved != null, ctrl.name);
      const rebuilt = _source_property_path(resolved as any);
      py_assert(rebuilt != null, ctrl.name);
      py_assert(
        py_eq(
          rebuilt[0].map((n: any) => [n.match_name, n.prop_index]),
          ctrl.source_property_path.map((r: any) => [r.match_name, r.prop_index]),
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
    const by_name = new Map<string, any>(comp.motion_graphics_controllers.map((c: any): [string, any] => [c.name, c]));
    const pairs: [string, string][] = [
      ["Mask1 Opacity", "Mask2 Opacity"],
      ["Fill Color 1", "Fill Color 2"],
      ["Anim Opacity 1", "Anim Opacity 2"],
    ];
    for (const [a_name, b_name] of pairs) {
      const a_ctrl = getitem(by_name, a_name);
      const b_ctrl = getitem(by_name, b_name);
      const layer = getitem(comp.layers_by_id, a_ctrl.source_layer_id);
      const a = _walk_source_property(layer as any, a_ctrl.source_property_path);
      const b = _walk_source_property(layer as any, b_ctrl.source_property_path);
      py_assert(a != null && b != null);
      expect(a.match_name).toBe(b.match_name);
      expect(a).not.toBe(b);
    }
  });

  test("test_add_indexed_sibling_roundtrips", () => {
    const tmp_path = make_tmp_path();
    // Mask 2's Expansion is not exposed yet: adding it must store the
    // mask atom's positional index and survive a save/reparse.
    const project = parse_project_fresh(TestIndexedGroupControllers.FIXTURE);
    const comp = TestIndexedGroupControllers._comp(project);
    const solid = next(comp.layers, (lyr: any) => py_bool(lyr.masks));
    const expansion = next(solid.masks.__getitem__(1).properties, (p: any) => p.match_name === "ADBE Mask Offset");
    expect(expansion.can_add_to_motion_graphics_template(comp)).toBe(true);
    expect(expansion.add_to_motion_graphics_template_as(comp, "Mask2 Expansion")).toBe(true);
    const out = tmp_path.div("indexed.aep");
    project.save(out);
    const comp2 = TestIndexedGroupControllers._comp(parse_aep(out).project);
    const ctrl = next(comp2.motion_graphics_controllers, (c: any) => c.name === "Mask2 Expansion");
    expect(
      py_eq(
        ctrl.source_property_path.map((r: any) => [r.match_name, r.prop_index]),
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
    const solid = next(comp.layers, (lyr: any) => py_bool(lyr.masks));
    const effects = next(solid.properties, (p: any) => p.match_name === "ADBE Effect Parade");
    const fx = next(effects.properties, (p: any) => p.match_name === "ADBE Fractal Noise");
    const prop = next(fx.properties, (p: any) => p.match_name === "ADBE Fractal Noise-0010");
    const resolved = _source_property_path(prop);
    py_assert(resolved != null);
    expect(
      py_eq(
        resolved[0].map((n: any) => [n.match_name, n.prop_index]),
        [
          ["ADBE Effect Parade", null],
          ["ADBE Fractal Noise", 0],
          ["ADBE Fractal Noise-0010", 10],
        ],
      ),
    ).toBe(true);
    // Already exposed by the AE run, so re-adding reports False.
    expect(prop.can_add_to_motion_graphics_template(comp)).toBe(false);
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
    const layer = comp.layers[0];
    expect(layer.can_add_to_motion_graphics_template(comp)).toBe(false);
  });

  test("test_already_exposed_layer_reports_false", () => {
    const project = parse_project_fresh(TestAddLayerMediaReplacement.MEDIA);
    const comp = get_comp(project, "image_with_alpha");
    expect(as_instance(comp.layers[0], AVLayer).can_add_to_motion_graphics_template(comp)).toBe(false);
  });

  test("test_add_precomp_layer_roundtrips", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(TestAddLayerMediaReplacement.MEDIA);
    const comp = get_comp(project, "image_with_alpha 2");
    const layer = as_instance(comp.layers[0], AVLayer);
    expect(layer.can_add_to_motion_graphics_template(comp)).toBe(true);
    expect(layer.add_to_motion_graphics_template(comp)).toBe(true);
    expect(layer.can_add_to_motion_graphics_template(comp)).toBe(false);
    const out = tmp_path.div("media.aep");
    project.save(out);
    const comp2 = get_comp(parse_aep(out).project, "image_with_alpha 2");
    const ctrl = comp2.motion_graphics_controllers[0];
    expect(ctrl.controller_type).toBe(14);
    expect(ctrl.name).toBe(layer.name);
    expect(ctrl.source_comp_id).toBe(comp2.id);
    expect(ctrl.source_layer_id).toBe(comp2.layers[0]._ldta.layer_id);
    expect(
      py_eq(
        ctrl.source_property_path.map((r: any) => r.match_name),
        ["ADBE Source Options Group", "ADBE Layer Source Alternate"],
      ),
    ).toBe(true);
    // The decoded source-media fields survive the round-trip.
    const cctl = _cif3_cctls(comp2)[0];
    const by_type = new Map<string, any>(cctl.chunks.map((c: any): [string, any] => [c.chunk_type, c]));
    expect(getitem(by_type, "CSMw").value).toBe(640);
    expect(getitem(by_type, "CSMh").value).toBe(346);
    expect(getitem(by_type, "CSMs").value).toBe(0);
    expect(getitem(by_type, "CSMe").value).toBe(720000);
    expect(getitem(by_type, "CSMt").value).toBe(23976);
  });

  test("test_builder_matches_fixture_bytes", () => {
    // Byte parity: rebuilding the fixture's own controller from its
    // decoded inputs must reproduce AE's CCtl exactly.
    const project = parse_project_fresh(TestAddLayerMediaReplacement.MEDIA);
    const comp = get_comp(project, "image_with_alpha");
    const fixture_cctl = _cif3_cctls(comp)[0];
    const by_type = new Map<string, any>(fixture_cctl.chunks.map((c: any): [string, any] => [c.chunk_type, c]));
    const utf8s = fixture_cctl.chunks.filter((c: any) => c.chunk_type === "Utf8");
    const uuid_str = (utf8s[0] as any).value;
    const thumbnail = (utf8s[3] as any).value;
    const cprp = as_instance(next(fixture_cctl.chunks, (c: any) => getattr(c, "list_type", "") === "CPrp"), ListChunk);
    const path_json = as_instance(next(cprp.chunks, (c: any) => c.chunk_type === "Utf8"), Utf8Chunk).value;

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
    expect(getitem(by_type, "CSMd").value).toBe(2);
  });
});
