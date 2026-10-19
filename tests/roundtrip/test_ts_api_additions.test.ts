/**
 * API ts-aep adds beyond py-aep: parsing bytes, importing effect
 * definitions, writable font identity and shape bounds. Each is checked through a
 * save and a parse of the saved bytes.
 */

import { describe, expect, test } from "bun:test";

import { ListChunk, writeChunk } from "../../src/py_aep/binary/chunk.ts";
import {
  CTFontTechnology,
  newProject,
  parse,
  Shape,
  type Property,
  type PropertyGroup,
} from "../../src/py_aep/index.ts";
import { ByteStream } from "../../src/pyrt/index.ts";
import { projectBytes } from "../helpers.ts";

const SAMPLE = "samples/versions/ae2025/complete.aep";

function textLayerProject() {
  const app = newProject();
  const comp = app.project.rootFolder.addComp("c", 1920, 1080, 1, 5, 30);
  return { app, comp, layer: comp.addBoxText([400, 200], "hi") };
}

const reparsed = (app: ReturnType<typeof newProject>) => parse(projectBytes(app.project)).project;

describe("Project.addEffectDefinitions", () => {
  const definitions = () => {
    const efdg = parse(SAMPLE).project._rifx.chunks.find(
      (chunk): chunk is ListChunk => chunk instanceof ListChunk && chunk.listType === "EfdG",
    )!;
    const buffer = new ByteStream();
    writeChunk(buffer, efdg);
    return buffer.toBytes();
  };

  test("makes another project's effects addable", () => {
    const { app, layer } = textLayerProject();
    expect(layer.effects.canAddProperty("ADBE Gaussian Blur 2")).toBe(false);
    app.project.addEffectDefinitions(definitions());
    const blur = layer.effects.addProperty("ADBE Gaussian Blur 2") as PropertyGroup;
    (blur.property("ADBE Gaussian Blur 2-0001") as Property).value = 12;
    const restored = reparsed(app);
    expect(restored._effectDefinitions().map(([matchName]) => matchName)).toContain("ADBE Gaussian Blur 2");
    const effect = restored.compositions[0]!.layers[0]!.effects!.properties[0] as PropertyGroup;
    expect((effect.property("ADBE Gaussian Blur 2-0001") as Property).value).toBe(12);
  });

  test("skips definitions the project already has", () => {
    const { app } = textLayerProject();
    app.project.addEffectDefinitions(definitions());
    const before = app.project._effectDefinitions().length;
    app.project.addEffectDefinitions(definitions());
    expect(app.project._effectDefinitions().length).toBe(before);
  });
});

describe("FontObject writes", () => {
  test("technology and designVector survive a save", () => {
    const { app, layer } = textLayerProject();
    const prop = layer.text.property("ADBE Text Document");
    const document = prop.value;
    document.font = "ModernMTPro-Extended";
    prop.value = document;
    const font = prop.value._fonts.find((entry) => entry.postScriptName === "ModernMTPro-Extended")!;
    expect(font.technology).toBe(CTFontTechnology.CT_TRUETYPE_FONT);
    font.technology = CTFontTechnology.CT_TYPE1_FONT;
    font.designVector = [700, 87.5];
    const restored = (
      reparsed(app).compositions[0]!.layers[0]!.text!.property("ADBE Text Document") as Property
    ).value._fonts.find((entry: { postScriptName: string }) => entry.postScriptName === "ModernMTPro-Extended");
    expect(restored.technology).toBe(CTFontTechnology.CT_TYPE1_FONT);
    expect(restored.designVector).toEqual([700, 87.5]);
  });
});

describe("COS reals", () => {
  test("tiny values serialize without an exponent", () => {
    const { app, layer } = textLayerProject();
    const prop = layer.text.property("ADBE Text Document");
    prop.value.characterRange(0, 1).baselineShift = -3.552713678800501e-15;
    prop.value.characterRange(1, 2).baselineShift = 1.5e-7;
    const text = Buffer.from(projectBytes(app.project)).toString("latin1");
    expect(text).not.toContain("e-15");
    expect(text).not.toContain("e-07");
    const restored = (reparsed(app).compositions[0]!.layers[0]!.text!.property("ADBE Text Document") as Property).value;
    expect(restored.characterRange(0, 1).baselineShift).toBe(0);
    expect(restored.characterRange(1, 2).baselineShift).toBe(1.5e-7);
  });
});

describe("Shape.bounds", () => {
  test("is the box the shape's points are stored in", () => {
    const { app, comp } = textLayerProject();
    const shape = new Shape(
      [
        [10, 20],
        [110, 20],
        [110, 70],
      ],
      null,
      null,
      { closed: true },
    );
    expect(shape.bounds).toEqual([10, 20, 110, 70]);
    const layer = comp.addShape();
    const path = (
      layer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Shape - Group") as PropertyGroup
    ).property("ADBE Vector Shape") as Property;
    path.value = shape;
    const restored = (
      (reparsed(app).compositions[0]!.layers[0]!.property("ADBE Root Vectors Group") as PropertyGroup)
        .properties[0] as PropertyGroup
    ).property("ADBE Vector Shape") as Property;
    expect(restored.value.bounds).toEqual([10, 20, 110, 70]);
  });
});
