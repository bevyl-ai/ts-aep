/** Roundtrip tests for CompItem.add_parametric_mesh. */

import { describe, expect, test } from "bun:test";

import { getattr, getitem, Path, setattr } from "../../src/pyrt/index.ts";
import { approx, make_tmp_path } from "../../src/pyrt/pytest.ts";
import { parse as parse_aep, type Project } from "../../src/py_aep/index.ts";
import { LayerType, ParametricMeshType } from "../../src/py_aep/enums/index.ts";
import { ParametricMeshLayer } from "../../src/py_aep/models/layers/parametric_mesh_layer.ts";
import { as_instance, parse_project_fresh } from "../helpers.ts";

const SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models");
// comp_misc.aep has an empty Advanced-3D comp named "comment" (100x100, 1s).
const BASE_AEP = SAMPLES_DIR.div("composition", "comp_misc.aep");

// First numeric ParaMeshField per mesh type, for the value-persistence check.
const _FIRST_FIELD: Map<number, string> = new Map<number, string>([
  [ParametricMeshType.CUBE, "width"],
  [ParametricMeshType.SPHERE, "radius"],
  [ParametricMeshType.PLANE, "width"],
  [ParametricMeshType.TORUS, "ring_radius"],
  [ParametricMeshType.CONE, "top_radius"],
  [ParametricMeshType.CYLINDER, "radius"],
]);

function _save_reparse(project: Project, tmp_path: Path) {
  const out = tmp_path.div("mesh.aep");
  project.save(out);
  return parse_project_fresh(out);
}

describe("TestAddParametricMesh", () => {
  test.each(ParametricMeshType.members().map((m) => [m]))("test_creates_correct_type[%#]", (mesh_type: ParametricMeshType) => {
    const project = parse_aep(BASE_AEP).project;
    const comp = project.compositions[0];
    const layer = comp.add_parametric_mesh(undefined, { mesh_type });
    expect(layer instanceof ParametricMeshLayer).toBe(true);
    expect(layer.parametric_mesh_type).toBe(mesh_type);
    expect(layer._ldta.layer_type).toBe(LayerType.PARAMETRIC_MESH);
    expect(layer.three_d_layer).toBe(true);
  });

  test.each(ParametricMeshType.members().map((m) => [m]))("test_type_and_value_persist_through_save[%#]", (mesh_type: ParametricMeshType) => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(BASE_AEP).project;
    const comp = project.compositions[0];
    const layer = comp.add_parametric_mesh(`M ${ParametricMeshType.name_of(mesh_type)}`, { mesh_type });
    const field = getitem(_FIRST_FIELD, mesh_type);
    setattr(layer.parametric_mesh_options, field, 321.0);

    const fresh = _save_reparse(project, tmp_path);
    const fresh_layer = as_instance(
      fresh.compositions[0].layers.find((lyr) => lyr.name === `M ${ParametricMeshType.name_of(mesh_type)}`),
      ParametricMeshLayer,
    );
    expect(fresh_layer.parametric_mesh_type).toBe(mesh_type);
    expect(approx(getattr(fresh_layer.parametric_mesh_options, field), 321.0)).toBe(true);
  });

  test("test_auto_name_clears_name_set", () => {
    const project = parse_aep(BASE_AEP).project;
    const comp = project.compositions[0];
    const layer = comp.add_parametric_mesh(undefined, { mesh_type: ParametricMeshType.CUBE });
    // AE leaves the ldta name bit clear for an auto-generated name.
    expect(layer._ldta.name_set).toBe(false);
  });

  test("test_rename_sets_name_bit", () => {
    const tmp_path = make_tmp_path();
    // AE 2026 (headless rename experiment on parametric_meshes.aep):
    // renaming a mesh layer sets the ldta name bit, and it stays set
    // even when renamed back to the original default name - unlike
    // other sourceless layers, where renames leave the bit clear.
    const sample = SAMPLES_DIR.div("layer", "parametric_meshes.aep");
    const project = parse_aep(sample).project;
    const comp = project.compositions[0];
    comp.layers[0].name = "Renamed Mesh";
    const default_ = comp.layers[1].name;
    comp.layers[1].name = "Temp Name";
    comp.layers[1].name = default_;

    const fresh = _save_reparse(project, tmp_path);
    const fresh_layers = fresh.compositions[0].layers;
    expect(fresh_layers[0]._ldta.name_set).toBe(true);
    expect(fresh_layers[1]._ldta.name_set).toBe(true);
    expect(fresh_layers[2]._ldta.name_set).toBe(false);
  });

  test("test_explicit_name_sets_name_bit", () => {
    const project = parse_aep(BASE_AEP).project;
    const comp = project.compositions[0];
    const layer = comp.add_parametric_mesh("My Cube", { mesh_type: ParametricMeshType.CUBE });
    expect(layer.name).toBe("My Cube");
    expect(layer._ldta.name_set).toBe(true);
  });

  test("test_ldta_uses_comp_timebase", () => {
    const project = parse_aep(BASE_AEP).project;
    const comp = project.compositions[0];
    const layer = comp.add_parametric_mesh(undefined, { mesh_type: ParametricMeshType.CUBE });
    const time_base = comp._cdta.internal_timebase;
    expect(layer._ldta.out_point_divisor).toBe(time_base);
    expect(layer._ldta.in_point_divisor).toBe(time_base);
  });

  test("test_effects_active_cleared", () => {
    const project = parse_aep(BASE_AEP).project;
    const comp = project.compositions[0];
    const layer = comp.add_parametric_mesh(undefined, { mesh_type: ParametricMeshType.CUBE });
    expect(layer._ldta.effects_active).toBe(false);
  });
});
