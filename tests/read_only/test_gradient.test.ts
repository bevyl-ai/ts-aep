/** Tests for gradient color property parsing. */

import { expect, test } from "bun:test";
import { approx } from "../../src/pyrt/pytest.ts";
import { Path, StopIteration, hasMember, len, valueEquals } from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { parse } from "../../src/py_aep/index.ts";
import { CompItem } from "../../src/py_aep/models/items/composition.ts";
import { Gradient } from "../../src/py_aep/models/properties/gradient.ts";
import { asInstance } from "../helpers.ts";

// Python's SAMPLE is cwd-relative ("samples/..."); resolved from this file so
// the test does not depend on where bun is started.
const SAMPLE = new Path(import.meta.dir).parent.parent.div("samples", "models", "property", "gradient.aep");
const SAMPLE_XML = `<prop.map version="4">
  <prop.list>
    <prop.pair>
      <key>Gradient Color Data</key>
      <prop.list>
        <prop.pair>
          <key>Color Stops</key>
          <prop.list>
            <prop.pair>
              <key>Stops List</key>
              <prop.list>
                <prop.pair>
                  <key>Stop-0</key>
                  <prop.list>
                    <prop.pair>
                      <key>Stops Color</key>
                      <array>
                        <float>0</float>
                        <float>0.5</float>
                        <float>1</float>
                        <float>0</float>
                        <float>0</float>
                        <float>1</float>
                      </array>
                    </prop.pair>
                  </prop.list>
                </prop.pair>
                <prop.pair>
                  <key>Stop-1</key>
                  <prop.list>
                    <prop.pair>
                      <key>Stops Color</key>
                      <array>
                        <float>1</float>
                        <float>0.5</float>
                        <float>0</float>
                        <float>0</float>
                        <float>0</float>
                        <float>1</float>
                      </array>
                    </prop.pair>
                  </prop.list>
                </prop.pair>
              </prop.list>
            </prop.pair>
          </prop.list>
        </prop.pair>
        <prop.pair>
          <key>Alpha Stops</key>
          <prop.list>
            <prop.pair>
              <key>Stops List</key>
              <prop.list>
                <prop.pair>
                  <key>Stop-0</key>
                  <prop.list>
                    <prop.pair>
                      <key>Stops Alpha</key>
                      <array>
                        <float>0</float>
                        <float>0.5</float>
                        <float>1</float>
                      </array>
                    </prop.pair>
                  </prop.list>
                </prop.pair>
                <prop.pair>
                  <key>Stop-1</key>
                  <prop.list>
                    <prop.pair>
                      <key>Stops Alpha</key>
                      <array>
                        <float>1</float>
                        <float>0.5</float>
                        <float>1</float>
                      </array>
                    </prop.pair>
                  </prop.list>
                </prop.pair>
              </prop.list>
            </prop.pair>
          </prop.list>
        </prop.pair>
      </prop.list>
    </prop.pair>
    <prop.pair>
      <key>Gradient Colors</key>
      <string>1.0</string>
    </prop.pair>
  </prop.list>
</prop.map>
`;
const DEFAULT_AE_GRADIENT_XML =
  "<?xml version='1.0'?>\n" +
  "<prop.map version='4'>\n" +
  "<prop.list>\n" +
  "<prop.pair>\n" +
  "<key>Gradient Color Data</key>\n" +
  "<prop.list>\n" +
  "<prop.pair>\n" +
  "<key>Alpha Stops</key>\n" +
  "<prop.list>\n" +
  "<prop.pair>\n" +
  "<key>Stops List</key>\n" +
  "<prop.list>\n" +
  "<prop.pair>\n" +
  "<key>Stop-0</key>\n" +
  "<prop.list>\n" +
  "<prop.pair>\n" +
  "<key>Stops Alpha</key>\n" +
  "<array>\n" +
  "<array.type><float/></array.type>\n" +
  "<float>0</float>\n" +
  "<float>0.5</float>\n" +
  "<float>1</float>\n" +
  "</array>\n" +
  "</prop.pair>\n" +
  "</prop.list>\n" +
  "</prop.pair>\n" +
  "<prop.pair>\n" +
  "<key>Stop-1</key>\n" +
  "<prop.list>\n" +
  "<prop.pair>\n" +
  "<key>Stops Alpha</key>\n" +
  "<array>\n" +
  "<array.type><float/></array.type>\n" +
  "<float>1</float>\n" +
  "<float>0.5</float>\n" +
  "<float>1</float>\n" +
  "</array>\n" +
  "</prop.pair>\n" +
  "</prop.list>\n" +
  "</prop.pair>\n" +
  "</prop.list>\n" +
  "</prop.pair>\n" +
  "<prop.pair>\n" +
  "<key>Stops Size</key>\n" +
  "<int type='unsigned' size='32'>2</int>\n" +
  "</prop.pair>\n" +
  "</prop.list>\n" +
  "</prop.pair>\n" +
  "<prop.pair>\n" +
  "<key>Color Stops</key>\n" +
  "<prop.list>\n" +
  "<prop.pair>\n" +
  "<key>Stops List</key>\n" +
  "<prop.list>\n" +
  "<prop.pair>\n" +
  "<key>Stop-0</key>\n" +
  "<prop.list>\n" +
  "<prop.pair>\n" +
  "<key>Stops Color</key>\n" +
  "<array>\n" +
  "<array.type><float/></array.type>\n" +
  "<float>0</float>\n" +
  "<float>0.5</float>\n" +
  "<float>1</float>\n" +
  "<float>1</float>\n" +
  "<float>1</float>\n" +
  "<float>1</float>\n" +
  "</array>\n" +
  "</prop.pair>\n" +
  "</prop.list>\n" +
  "</prop.pair>\n" +
  "<prop.pair>\n" +
  "<key>Stop-1</key>\n" +
  "<prop.list>\n" +
  "<prop.pair>\n" +
  "<key>Stops Color</key>\n" +
  "<array>\n" +
  "<array.type><float/></array.type>\n" +
  "<float>1</float>\n" +
  "<float>0.5</float>\n" +
  "<float>0</float>\n" +
  "<float>0</float>\n" +
  "<float>0</float>\n" +
  "<float>1</float>\n" +
  "</array>\n" +
  "</prop.pair>\n" +
  "</prop.list>\n" +
  "</prop.pair>\n" +
  "</prop.list>\n" +
  "</prop.pair>\n" +
  "<prop.pair>\n" +
  "<key>Stops Size</key>\n" +
  "<int type='unsigned' size='32'>2</int>\n" +
  "</prop.pair>\n" +
  "</prop.list>\n" +
  "</prop.pair>\n" +
  "</prop.list>\n" +
  "</prop.pair>\n" +
  "<prop.pair>\n" +
  "<key>Gradient Colors</key>\n" +
  "<string>1.0</string>\n" +
  "</prop.pair>\n" +
  "</prop.list>\n" +
  "</prop.map>\n";

/** `@pytest.fixture()` gradient_comp: each test calls this in place of taking the fixture as a parameter. */
function gradientCompFixture(): CompItem {
  const app = parse(SAMPLE);
  for (const v of app.project.items.values()) {
    if (hasMember(v, "layers")) return asInstance(v, CompItem);
  }
  throw new StopIteration();
}

test("test_g_fill_gradient_colors", () => {
  const gradientComp = gradientCompFixture();
  const layer = gradientComp.layers[0];
  const contents = layer.property("ADBE Root Vectors Group");
  const gfill = contents.property("ADBE Vector Graphic - G-Fill");
  const colors = gfill.property("ADBE Vector Grad Colors");

  expect(colors.matchName).toBe("ADBE Vector Grad Colors");
  expect(colors.name).toBe("Colors");

  const gd = colors.value;
  expect(gd instanceof Gradient).toBe(true);
  expect(len(gd.colorStops)).toBe(2);
  expect(len(gd.alphaStops)).toBe(2);
  // Non-default values set in the sample
  expect(approx(gd.colorStops[0].offset, 0.065, { abs: 0.001 })).toBe(true);
  expect(approx(gd.alphaStops[0].alpha, 0.83, { abs: 0.01 })).toBe(true);
});

test("test_g_stroke_gradient_colors", () => {
  const gradientComp = gradientCompFixture();
  const layer = gradientComp.layers[0];
  const contents = layer.property("ADBE Root Vectors Group");
  const gstroke = contents.property("ADBE Vector Graphic - G-Stroke");
  const colors = gstroke.property("ADBE Vector Grad Colors");

  const gd = colors.value;
  expect(gd instanceof Gradient).toBe(true);
  expect(len(gd.colorStops)).toBeGreaterThanOrEqual(2);
});

/** G-Fill has all expected properties from synthesis specs. */
test("test_g_fill_synthesized_properties", () => {
  const gradientComp = gradientCompFixture();
  const layer = gradientComp.layers[0];
  const contents = layer.property("ADBE Root Vectors Group");
  const gfill = contents.property("ADBE Vector Graphic - G-Fill");

  const expectedMatchNames = [
    "ADBE Vector Blend Mode",
    "ADBE Vector Composite Order",
    "ADBE Vector Fill Rule",
    "ADBE Vector Grad Type",
    "ADBE Vector Grad Start Pt",
    "ADBE Vector Grad End Pt",
    "ADBE Vector Grad HiLite Length",
    "ADBE Vector Grad HiLite Angle",
    // Grad Scale / Grad Rotation were added in AE 2026 (major 26);
    // gradient.aep is AE 25.6, so synthesis must NOT add them here (the
    // ExtendScript gradient.json lists neither - over-reporting them is
    // exactly the version-gate bug this guards against).
    "ADBE Vector Grad Colors",
    "ADBE Vector Fill Opacity",
  ];
  const actual = gfill.properties.map((p) => p.matchName);
  expect(valueEquals(actual, expectedMatchNames)).toBe(true);
});

/** G-Stroke has all expected properties from synthesis specs. */
test("test_g_stroke_synthesized_properties", () => {
  const gradientComp = gradientCompFixture();
  const layer = gradientComp.layers[0];
  const contents = layer.property("ADBE Root Vectors Group");
  const gstroke = contents.property("ADBE Vector Graphic - G-Stroke");

  const expectedMatchNames = [
    "ADBE Vector Blend Mode",
    "ADBE Vector Composite Order",
    "ADBE Vector Grad Type",
    "ADBE Vector Grad Start Pt",
    "ADBE Vector Grad End Pt",
    "ADBE Vector Grad HiLite Length",
    "ADBE Vector Grad HiLite Angle",
    // Grad Scale / Grad Rotation are AE 2026+ only; gradient.aep is AE 25.6
    // (gradient.json lists neither), so synthesis must not add them.
    "ADBE Vector Grad Colors",
    "ADBE Vector Stroke Opacity",
    "ADBE Vector Stroke Width",
    "ADBE Vector Stroke Line Cap",
    "ADBE Vector Stroke Line Join",
    "ADBE Vector Stroke Miter Limit",
    "ADBE Vector Stroke Dashes",
    "ADBE Vector Stroke Taper",
    "ADBE Vector Stroke Wave",
  ];
  const actual = gstroke.properties.map((p) => p.matchName);
  expect(valueEquals(actual, expectedMatchNames)).toBe(true);
});

/** Re-serializing a parsed (AE-written) gradient reproduces its bytes. */
test("test_reserialize_matches_ae_bytes", () => {
  const gradientComp = gradientCompFixture();
  const layer = gradientComp.layers[0];
  const contents = layer.property("ADBE Root Vectors Group");
  const gfill = contents.property("ADBE Vector Graphic - G-Fill");
  const colors = gfill.property("ADBE Vector Grad Colors");
  const gradient = colors.value;
  expect(gradient instanceof Gradient).toBe(true);

  const original = gradient._utf8.value;
  gradient._serialize();
  expect(valueEquals(gradient._utf8.value, original)).toBe(true);
});
