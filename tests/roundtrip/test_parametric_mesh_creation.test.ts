/** Roundtrip tests for CompItem.addParametricMesh. */

import { describe, expect, test } from "bun:test";

import { getMember, getOrThrow, Path, setMember } from "../../src/pyrt/index.ts";
import { approx, makeTmpPath } from "../../src/pyrt/pytest.ts";
import { parse as parseAep, type Project } from "../../src/py_aep/index.ts";
import { LayerType, ParametricMeshType } from "../../src/py_aep/enums/index.ts";
import { ParametricMeshLayer } from "../../src/py_aep/models/layers/parametric_mesh_layer.ts";
import { asInstance, parseProjectFresh } from "../helpers.ts";

const SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models");
// comp_misc.aep has an empty Advanced-3D comp named "comment" (100x100, 1s).
const BASE_AEP = SAMPLES_DIR.div("composition", "comp_misc.aep");

// First numeric ParaMeshField per mesh type, for the value-persistence check.
const _FIRST_FIELD: Map<number, string> = new Map<number, string>([
  [ParametricMeshType.CUBE, "width"],
  [ParametricMeshType.SPHERE, "radius"],
  [ParametricMeshType.PLANE, "width"],
  [ParametricMeshType.TORUS, "ringRadius"],
  [ParametricMeshType.CONE, "topRadius"],
  [ParametricMeshType.CYLINDER, "radius"],
]);

function _saveReparse(project: Project, tmpPath: Path) {
  const out = tmpPath.div("mesh.aep");
  project.save(out);
  return parseProjectFresh(out);
}

describe("TestAddParametricMesh", () => {
  test.each(ParametricMeshType.members().map((m) => [m]))("test_creates_correct_type[%#]", (meshType: ParametricMeshType) => {
    const project = parseAep(BASE_AEP).project;
    const comp = project.compositions[0];
    const layer = comp.addParametricMesh(undefined, { meshType: meshType });
    expect(layer instanceof ParametricMeshLayer).toBe(true);
    expect(layer.parametricMeshType).toBe(meshType);
    expect(layer._ldta.layerType).toBe(LayerType.PARAMETRIC_MESH);
    expect(layer.threeDLayer).toBe(true);
  });

  test.each(ParametricMeshType.members().map((m) => [m]))("test_type_and_value_persist_through_save[%#]", (meshType: ParametricMeshType) => {
    const tmpPath = makeTmpPath();
    const project = parseAep(BASE_AEP).project;
    const comp = project.compositions[0];
    const layer = comp.addParametricMesh(`M ${ParametricMeshType.nameOf(meshType)}`, { meshType: meshType });
    const field = getOrThrow(_FIRST_FIELD, meshType);
    setMember(layer.parametricMeshOptions, field, 321.0);

    const fresh = _saveReparse(project, tmpPath);
    const freshLayer = asInstance(
      fresh.compositions[0].layers.find((lyr) => lyr.name === `M ${ParametricMeshType.nameOf(meshType)}`),
      ParametricMeshLayer,
    );
    expect(freshLayer.parametricMeshType).toBe(meshType);
    expect(approx(getMember(freshLayer.parametricMeshOptions, field), 321.0)).toBe(true);
  });

  test("test_auto_name_clears_name_set", () => {
    const project = parseAep(BASE_AEP).project;
    const comp = project.compositions[0];
    const layer = comp.addParametricMesh(undefined, { meshType: ParametricMeshType.CUBE });
    // AE leaves the ldta name bit clear for an auto-generated name.
    expect(layer._ldta.nameSet).toBe(false);
  });

  test("test_rename_sets_name_bit", () => {
    const tmpPath = makeTmpPath();
    // AE 2026 (headless rename experiment on parametric_meshes.aep):
    // renaming a mesh layer sets the ldta name bit, and it stays set
    // even when renamed back to the original default name - unlike
    // other sourceless layers, where renames leave the bit clear.
    const sample = SAMPLES_DIR.div("layer", "parametric_meshes.aep");
    const project = parseAep(sample).project;
    const comp = project.compositions[0];
    comp.layers[0].name = "Renamed Mesh";
    const default_ = comp.layers[1].name;
    comp.layers[1].name = "Temp Name";
    comp.layers[1].name = default_;

    const fresh = _saveReparse(project, tmpPath);
    const freshLayers = fresh.compositions[0].layers;
    expect(freshLayers[0]._ldta.nameSet).toBe(true);
    expect(freshLayers[1]._ldta.nameSet).toBe(true);
    expect(freshLayers[2]._ldta.nameSet).toBe(false);
  });

  test("test_explicit_name_sets_name_bit", () => {
    const project = parseAep(BASE_AEP).project;
    const comp = project.compositions[0];
    const layer = comp.addParametricMesh("My Cube", { meshType: ParametricMeshType.CUBE });
    expect(layer.name).toBe("My Cube");
    expect(layer._ldta.nameSet).toBe(true);
  });

  test("test_ldta_uses_comp_timebase", () => {
    const project = parseAep(BASE_AEP).project;
    const comp = project.compositions[0];
    const layer = comp.addParametricMesh(undefined, { meshType: ParametricMeshType.CUBE });
    const timeBase = comp._cdta.internalTimebase;
    expect(layer._ldta.outPointDivisor).toBe(timeBase);
    expect(layer._ldta.inPointDivisor).toBe(timeBase);
  });

  test("test_effects_active_cleared", () => {
    const project = parseAep(BASE_AEP).project;
    const comp = project.compositions[0];
    const layer = comp.addParametricMesh(undefined, { meshType: ParametricMeshType.CUBE });
    expect(layer._ldta.effectsActive).toBe(false);
  });
});
