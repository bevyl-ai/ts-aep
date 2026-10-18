/** Tests for gradient color property parsing. */

import { expect, test } from "bun:test";

import "../../src/py_aep/binary/_register.ts";
import { Gradient, GradientAlphaStop, GradientColorStop } from "../../src/py_aep/models/properties/gradient.ts";
import { parseGradientXml } from "../../src/py_aep/parsers/gradient.ts";
import { len, assert, valueEquals, pySlice, range, sorted } from "../../src/pyrt/index.ts";

/** Minimal stand-in for Utf8Chunk in parser unit tests. */
class _FakeUtf8 {
  declare value: string;

  constructor(value: string) {
    this.value = value;
  }
}

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

test("test_parse_gradient_xml_color_stops", () => {
  // @ts-expect-error _FakeUtf8 is a structural stand-in, not a Utf8Chunk (type: ignore[arg-type])
  const result = parseGradientXml(new _FakeUtf8(SAMPLE_XML));
  assert(result != null);
  expect(len(result.colorStops)).toBe(2);
  expect(
    valueEquals(
      result.colorStops[0],
      new GradientColorStop(0.0, 0.5, [1.0, 0.0, 0.0]),
    ),
  ).toBe(true);
  expect(
    valueEquals(
      result.colorStops[1],
      new GradientColorStop(1.0, 0.5, [0.0, 0.0, 0.0]),
    ),
  ).toBe(true);
});

test("test_parse_gradient_xml_alpha_stops", () => {
  // @ts-expect-error _FakeUtf8 is a structural stand-in, not a Utf8Chunk (type: ignore[arg-type])
  const result = parseGradientXml(new _FakeUtf8(SAMPLE_XML));
  assert(result != null);
  expect(len(result.alphaStops)).toBe(2);
  expect(valueEquals(result.alphaStops[0], new GradientAlphaStop(0.0, 0.5, 1.0))).toBe(true);
  expect(valueEquals(result.alphaStops[1], new GradientAlphaStop(1.0, 0.5, 1.0))).toBe(true);
});

test("test_parse_gradient_xml_version", () => {
  // @ts-expect-error _FakeUtf8 is a structural stand-in, not a Utf8Chunk (type: ignore[arg-type])
  const result = parseGradientXml(new _FakeUtf8(SAMPLE_XML));
  assert(result != null);
  expect(result.version).toBe("1.0");
});

test("test_parse_gradient_xml_empty", () => {
  // @ts-expect-error _FakeUtf8 is a structural stand-in, not a Utf8Chunk (type: ignore[arg-type])
  expect(parseGradientXml(new _FakeUtf8(""))).toBe(null);
});

test("test_parse_gradient_xml_invalid", () => {
  // @ts-expect-error _FakeUtf8 is a structural stand-in, not a Utf8Chunk (type: ignore[arg-type])
  expect(parseGradientXml(new _FakeUtf8("<not valid/>"))).toBe(null);
});

/** serialize > parse produces identical gradient data. */
test("test_serialize_gradient_xml_roundtrip", () => {
  const original = new Gradient(
    [new GradientColorStop(0.0, 0.5, [1.0, 0.0, 0.0]), new GradientColorStop(1.0, 0.5, [0.0, 0.0, 1.0])],
    [new GradientAlphaStop(0.0, 0.5, 1.0), new GradientAlphaStop(1.0, 0.5, 0.5)],
    "1.0",
  );
  // @ts-expect-error _FakeUtf8 is a structural stand-in, not a Utf8Chunk (type: ignore[arg-type])
  const result = parseGradientXml(new _FakeUtf8(original._utf8.value));
  expect(valueEquals(result, original)).toBe(true);
});

/** Gradient() serializes to AE's default gradient XML, byte for byte. */
test("test_default_gradient_matches_ae_bytes", () => {
  expect(new Gradient()._utf8.value).toBe(DEFAULT_AE_GRADIENT_XML);
});

/**
 * AE serializes gradient stops with keys in lexicographic order
 * (Stop-0, Stop-1, Stop-10, ..., Stop-2, ...), not numeric, for >9
 * stops. The values must stay paired with their (numeric) stop index.
 */
test("test_gradient_stops_serialized_in_lexicographic_key_order", () => {
  const colorStops = Array.from(range(12), (i) => new GradientColorStop(i / 11.0, 0.5, [i / 11.0, 0.0, 0.0]));
  const grad = new Gradient(colorStops);
  const xml = grad._utf8.value;
  // NOTE(port): split("\n") matches str.splitlines() here; the serialized XML uses only "\n" line endings.
  const keys = xml
    .split("\n")
    .filter((ln) => ln.startsWith("<key>Stop-"))
    .map((ln) => pySlice(ln, len("<key>Stop-"), -len("</key>")));
  // XML emits 2 default alpha stops first, then the 12 color stops;
  // check the color block's key ordering.
  const colorKeys = pySlice(keys, -12, null);
  expect(valueEquals(colorKeys, sorted(colorKeys))).toBe(true); // lexicographic, not numeric
  expect(valueEquals(colorKeys.slice(0, 4), ["0", "1", "10", "11"])).toBe(true);
  expect(colorKeys.at(-1)).toBe("9");
});
