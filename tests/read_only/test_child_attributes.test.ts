/**
 * The attribute-named children the types promise (`CHILD_MATCH_NAMES`) resolve
 * through `__getattr__` to the declared child on every group instance: every
 * layer of every sample, and layers created through the API.
 *
 * Port-only: py-aep has no static types to keep honest.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { parse } from "../../src/py_aep/index.ts";
import { CHILD_MATCH_NAMES } from "../../src/py_aep/data/child_names.ts";
import type { Layer } from "../../src/py_aep/models/layers/layer.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { parseProjectFresh } from "../helpers.ts";

const TABLE: Record<string, Record<string, string>> = CHILD_MATCH_NAMES;

/** `group.attr` misses, as `[group, attr, what it resolved to]`. */
function misses(layer: Layer): [string, string, string][] {
  const out: [string, string, string][] = [];
  const walk = (group: PropertyGroup): void => {
    for (const [attr, matchName] of Object.entries(TABLE[group.matchName] ?? {})) {
      let found: string;
      try {
        const child: unknown = Reflect.get(group, attr);
        found = child instanceof Property || child instanceof PropertyGroup ? child.matchName : String(child);
      } catch (e) {
        found = e instanceof Error ? e.constructor.name : String(e);
      }
      if (found !== matchName) out.push([group.matchName, attr, found]);
    }
    for (const child of group.properties) if (child instanceof PropertyGroup) walk(child);
  };
  walk(layer);
  return out;
}

describe("child attributes", () => {
  test("resolve to the declared child on every sample layer", () => {
    const failures: string[] = [];
    let layers = 0;
    for (const file of fs.globSync("samples/**/*.aep").sort()) {
      for (const comp of parse(file).project.compositions) {
        for (const layer of comp.layers) {
          layers++;
          for (const [g, a, found] of misses(layer)) failures.push(`${file} ${layer.name}: ${g}.${a} -> ${found}`);
        }
      }
    }
    expect(failures).toEqual([]);
    expect(layers).toBeGreaterThan(1500);
  }, 120_000);

  test("resolve on layers created through the API", () => {
    const project = parseProjectFresh("samples/models/composition/renderer_classic_3d.aep");
    const comp = project.compositions[0];
    const created: Layer[] = [
      comp.addNull(),
      comp.addShape(),
      comp.addCamera(),
      comp.addLight(),
      comp.addText("hello"),
      comp.addBoxText([200, 100], "box"),
    ];
    for (const layer of created) expect(misses(layer)).toEqual([]);
  });

  test("typed reads", () => {
    const comp = parseProjectFresh("samples/models/composition/renderer_classic_3d.aep").compositions[0];
    const text = comp.addText("typed").text;
    expect(text?.sourceText.value.text).toBe("typed");
    const position: number[] = comp.addNull().transform.position.value;
    expect(position.length).toBeGreaterThan(1);
  });
});
