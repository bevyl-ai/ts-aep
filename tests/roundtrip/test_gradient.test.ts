/** Tests for gradient color property parsing. */

import { expect, test } from "bun:test";

import { parse } from "../../src/py_aep/index.ts";
import { Gradient, GradientAlphaStop, GradientColorStop } from "../../src/py_aep/models/properties/gradient.ts";
import { parse_gradient_xml } from "../../src/py_aep/parsers/gradient.ts";
import { approx, make_tmp_path } from "../../src/pyrt/pytest.ts";
import { hasattr, py_eq } from "../../src/pyrt/index.ts";

const SAMPLE = "samples/models/property/gradient.aep";
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

/**
 * `@pytest.fixture()` - renamed `gradient_comp_fixture` because each test
 * takes a local `gradient_comp` holding this fixture's return value.
 * Tests call it at the top instead of receiving it as a parameter.
 */
function gradient_comp_fixture(): any {
  const app = parse(SAMPLE);
  return next_with_layers(app.project.items.values());
}

/** `next(v for v in items if hasattr(v, "layers"))`; StopIteration becomes a thrown Error. */
function next_with_layers(values: Iterable<any>): any {
  for (const v of values) {
    if (hasattr(v, "layers")) return v;
  }
  throw new Error("StopIteration");
}

test("test_gradient_value_write_through", () => {
  /** Mutating a Gradient auto-serializes to the Utf8 chunk. */
  const gradient_comp = gradient_comp_fixture();

  const layer = gradient_comp.layers[0];
  const contents = layer.property("ADBE Root Vectors Group");
  const gfill = contents.property("ADBE Vector Graphic - G-Fill");
  const colors = gfill.property("ADBE Vector Grad Colors");

  const gradient = colors.value;
  expect(gradient instanceof Gradient).toBe(true);
  expect(gradient._utf8 != null).toBe(true);

  // Mutate via descriptor - auto-serializes
  gradient.color_stops = [
    new GradientColorStop(0.0, 0.5, [0.0, 1.0, 0.0]),
    new GradientColorStop(0.5, 0.5, [1.0, 1.0, 0.0]),
    new GradientColorStop(1.0, 0.5, [0.0, 0.0, 1.0]),
  ];
  gradient.alpha_stops = [
    new GradientAlphaStop(0.0, 0.5, 1.0),
    new GradientAlphaStop(1.0, 0.5, 1.0),
  ];

  // Re-read from the Utf8 chunk to confirm write-through
  const reparsed = parse_gradient_xml(gradient._utf8);
  expect(py_eq(reparsed, gradient)).toBe(true);
});

test("test_gradient_binary_roundtrip", () => {
  /** Modified gradient survives a full binary roundtrip. */
  const tmp_path = make_tmp_path();
  const app = parse(SAMPLE);
  const comp = next_with_layers(app.project.items.values());
  const layer = comp.layers[0];
  const contents = layer.property("ADBE Root Vectors Group");
  const gfill = contents.property("ADBE Vector Graphic - G-Fill");
  const colors = gfill.property("ADBE Vector Grad Colors");

  const gradient = colors.value;
  expect(gradient instanceof Gradient).toBe(true);

  gradient.color_stops = [
    new GradientColorStop(0.0, 0.5, [0.25, 0.75, 0.5]),
    new GradientColorStop(1.0, 0.5, [0.75, 0.25, 0.5]),
  ];
  gradient.alpha_stops = [
    new GradientAlphaStop(0.0, 0.5, 0.8),
    new GradientAlphaStop(1.0, 0.5, 0.2),
  ];

  // Save and re-parse
  const out = tmp_path.div("roundtrip.aep");
  app.project.save(out);

  const app2 = parse(out);
  const comp2 = next_with_layers(app2.project.items.values());
  const layer2 = comp2.layers[0];
  const contents2 = layer2.property("ADBE Root Vectors Group");
  const gfill2 = contents2.property("ADBE Vector Graphic - G-Fill");
  const colors2 = gfill2.property("ADBE Vector Grad Colors");
  expect(colors2.value instanceof Gradient).toBe(true);
  expect(colors2.value.color_stops.length).toBe(2);
  expect(approx(colors2.value.color_stops[0].color[0], 0.25)).toBe(true);
});

test("test_gradient_add_color_stop_serializes", () => {
  /** Adding a stop via add_color_stop auto-serializes. */
  const gradient_comp = gradient_comp_fixture();
  const layer = gradient_comp.layers[0];
  const contents = layer.property("ADBE Root Vectors Group");
  const gfill = contents.property("ADBE Vector Graphic - G-Fill");
  const colors = gfill.property("ADBE Vector Grad Colors");

  const gradient = colors.value;
  expect(gradient instanceof Gradient).toBe(true);
  const original_count = gradient.color_stops.length;

  gradient.add_color_stop(0.5, 0.5, [1.0, 1.0, 0.0]);

  // Re-parse from utf8 to confirm serialization
  const reparsed = parse_gradient_xml(gradient._utf8);
  expect(reparsed != null).toBe(true);
  if (reparsed == null) throw new Error("gradient XML did not reparse");
  expect(reparsed.color_stops.length).toBe(original_count + 1);
});

test("test_gradient_remove_color_stop_serializes", () => {
  /** Removing a stop via remove_color_stop auto-serializes. */
  const gradient_comp = gradient_comp_fixture();
  const layer = gradient_comp.layers[0];
  const contents = layer.property("ADBE Root Vectors Group");
  const gfill = contents.property("ADBE Vector Graphic - G-Fill");
  const colors = gfill.property("ADBE Vector Grad Colors");

  const gradient = colors.value;
  expect(gradient instanceof Gradient).toBe(true);
  const original_count = gradient.color_stops.length;

  gradient.remove_color_stop(0);

  expect(gradient.color_stops.length).toBe(original_count - 1);
  const reparsed = parse_gradient_xml(gradient._utf8);
  expect(reparsed != null).toBe(true);
  if (reparsed == null) throw new Error("gradient XML did not reparse");
  expect(reparsed.color_stops.length).toBe(original_count - 1);
});
