/**
 * Read-only tests for parametric mesh layers.
 *
 * Validates parsing of `parametric_meshes.aep` (all six mesh types) against
 * the ExtendScript ground-truth JSON, and spot-checks the typed
 * `ParametricMeshLayer` / options API.
 */

// `from __future__ import annotations` is dropped: no annotation here is
// evaluated at runtime. `Path(__file__).parent...` becomes `import.meta.dir`.

import { describe, expect, test } from "bun:test";
import { at, getitem, Path, py_assert, len } from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { parse_project } from "../conftest.ts";
import { as_instance } from "../helpers.ts";
import { validate_aep } from "../../src/py_aep/cli/validate.ts";
import { ParametricMeshType } from "../../src/py_aep/enums/index.ts";
import { CubeMeshOptions, CylinderMeshOptions, ParametricMeshLayer } from "../../src/py_aep/models/layers/parametric_mesh_layer.ts";

const SAMPLE_DIR = new Path(import.meta.dir).div("..", "..", "samples", "models", "layer");
const MESH_AEP = SAMPLE_DIR.div("parametric_meshes.aep");
const MESH_JSON = SAMPLE_DIR.div("parametric_meshes.json");

describe("TestParametricMeshValidation", () => {
  test("test_validates_against_extendscript", () => {
    /** Parsed output matches the ExtendScript export exactly. */
    const result = validate_aep(MESH_AEP, MESH_JSON);
    py_assert(len(result) === 0, result.differences.slice(0, 40).join("\n"));
  });
});

describe("TestParametricMeshModel", () => {
  test("test_layer_types_and_options", () => {
    const project = parse_project(MESH_AEP);
    const comp = project.compositions[0];
    const by_name = new Map(comp.layers.map((layer) => [layer.name, layer] as const));

    const cube = getitem(by_name, "Cube Mesh Layer 1");
    py_assert(cube instanceof ParametricMeshLayer);
    expect(cube.parametricMeshType === ParametricMeshType.CUBE).toBe(true);
    expect(cube.parametricMeshOptions instanceof CubeMeshOptions).toBe(true);

    const cyl = as_instance(getitem(by_name, "Cylinder Mesh Layer 1"), ParametricMeshLayer);
    expect(cyl.parametricMeshType === ParametricMeshType.CYLINDER).toBe(true);
    expect(cyl.parametricMeshOptions instanceof CylinderMeshOptions).toBe(true);
  });

  test("test_layer_type_string_is_parametric_mesh", () => {
    const project = parse_project(MESH_AEP);
    const cube = at(project.compositions[0].layers, -1);
    // AE reports these as their own type, not AVLayer.
    expect(cube.layerType === "ParametricMeshLayer").toBe(true);
  });

  test("test_cannot_set_collapse_transformation", () => {
    const project = parse_project(MESH_AEP);
    const cube = at(project.compositions[0].layers, -1);
    expect(as_instance(cube, ParametricMeshLayer).canSetCollapseTransformation).toBe(false);
  });

  test("test_mesh_type_enum_binary_roundtrip", () => {
    for (const mt of ParametricMeshType.members()) {
      expect(ParametricMeshType.from_binary(ParametricMeshType.to_binary(mt)) === mt).toBe(true);
    }
  });
});
