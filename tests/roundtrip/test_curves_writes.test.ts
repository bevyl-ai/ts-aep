/**
 * Writes around the Curves effect's curves (AE 2026 ground truth).
 *
 * `curves.aep` holds four solids with a Curves effect each: `untouched`, and
 * `keyed`, whose curves are keyed at 0 s, 0.96 s and 2.04 s. The project's
 * stored definition of the effect mirrors the keyed instance.
 */

import { expect, test } from "bun:test";
import { at, BytesIO, getitem, Path, py_assert, py_bool, py_eq } from "../../src/pyrt/index.ts";
import { make_tmp_path } from "../../src/pyrt/pytest.ts";
import { parse as parse_aep } from "../../src/py_aep/index.ts";
import { type Chunk, write_chunk } from "../../src/py_aep/binary/chunk.ts";
import "../../src/py_aep/binary/_register.ts";
import type { Layer } from "../../src/py_aep/models/layers/index.ts";
import type { Project } from "../../src/py_aep/models/project.ts";
import { Curves } from "../../src/py_aep/models/properties/curves.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";
import { as_instance, parse_project_fresh } from "../helpers.ts";

const SAMPLE = new Path(import.meta.path)
  .parent.parent.parent.div("samples", "models", "property", "curves.aep");

function _layer(project: Project, name: string): Layer {
  const found = project.compositions[0].layers.find((ly) => ly.name === name);
  if (found === undefined) throw new Error("StopIteration");
  return found;
}

function _curves(layer: Layer, index = 0): Property {
  const prop = as_instance(layer.property("ADBE Effect Parade").properties[index], PropertyGroup).property(
    "ADBE CurvesCustom-0001",
  );
  py_assert(prop instanceof Property);
  return prop;
}

function _bytes(...chunks: (Chunk | null)[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const chunk of chunks) {
    py_assert(chunk != null);
    const buf = new BytesIO();
    write_chunk(buf, chunk);
    out.push(buf.getvalue());
  }
  return out;
}

function _stream(prop: Property): Uint8Array[] {
  return _bytes(prop._tdsb, prop._tdb4, prop._cdat, prop._arbs);
}

test("test_add_property_writes_an_untouched_curves", () => {
  const tmp_path = make_tmp_path();
  // AE 2026's addProperty("ADBE CurvesCustom") writes an untouched
  // instance's bytes here, although the stored definition is keyed.
  const project = parse_project_fresh(SAMPLE);
  _layer(project, "keyed").property("ADBE Effect Parade").addProperty("ADBE CurvesCustom");
  const out = tmp_path.div("out.aep");
  project.save(out);

  const reopened = parse_aep(out).project;
  const added = _curves(_layer(reopened, "keyed"), 1);
  const untouched = _curves(_layer(reopened, "untouched"));

  expect(py_bool(added.keyframes)).toBe(false);
  expect(added.isModified).toBe(false);
  const curves = added.value;
  expect(curves instanceof Curves).toBe(true);
  expect(curves.isIdentity).toBe(true);
  expect(py_eq(_stream(added), _stream(untouched))).toBe(true);
});

test("test_moving_a_key_moves_its_curves", () => {
  const tmp_path = make_tmp_path();
  // AE pairs a keyed Curves' aRbps with its keys by position: rendered in
  // AE 2026, the key moved last shows its own curves only when its aRbp
  // moved with it.
  const project = parse_project_fresh(SAMPLE);
  const prop = _curves(_layer(project, "keyed"));
  const first = prop.keyframes[0].value;
  py_assert(first instanceof Curves);
  prop.keyframes[0].time = 3.0;
  const out = tmp_path.div("out.aep");
  project.save(out);

  const keys = _curves(_layer(parse_aep(out).project, "keyed")).keyframes;
  const moved = at(keys, -1).value;
  expect(at(keys, -1).time).toBe(3.0);
  py_assert(moved instanceof Curves);
  expect(py_eq(getitem(moved.channels, "rgb").points, getitem(first.channels, "rgb").points)).toBe(true);
});
