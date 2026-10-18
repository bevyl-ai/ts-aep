/** Parser and serializer for After Effects gradient XML in GCky Utf8 chunks. */

import { Element, ParseError, fromstring } from "../../pyrt/etree.ts";
import {
  ValueError,
  float,
  warn,
} from "../../pyrt/index.ts";
import { Gradient, GradientAlphaStop, GradientColorStop } from "../models/properties/gradient.ts";
import type { Utf8Chunk } from "../binary/scalar_chunks.ts";

export const logger = {
  debug() {},
  info() {},
  warning: (m: string) => warn(m),
};

export { Element, ParseError, fromstring };

/**
 * Parse AE gradient XML into a `Gradient` instance.
 *
 * The XML uses a `prop.map` / `prop.list` / `prop.pair` structure with
 * nested arrays of floats for color and alpha stops.
 *
 * @param utf8 - The Utf8 chunk containing the gradient XML.
 * @returns Parsed gradient data, or null if parsing fails.
 */
export function parseGradientXml(utf8: Utf8Chunk): Gradient | null {
  // String(): the value may be a `_NulTailStr` (String object), whose truthiness py_bool cannot see.
  const xmlText = String(utf8.value);
  if (!xmlText) return null;
  let root: Element;
  try {
    root = fromstring(xmlText);
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    logger.warning("Invalid gradient XML");
    return null;
  }

  // Navigate: prop.map > prop.list
  const propList = root.find("prop.list");
  if (propList == null) return null;

  const pairs = _getPairs(propList);
  const gradientData = pairs.get("Gradient Color Data") ?? null;
  const versionStr = _getStringValue(pairs.get("Gradient Colors") ?? null);

  if (gradientData == null) return null;

  const dataPairs = _getPairs(gradientData);
  const colorStops = _parseColorStops(dataPairs.get("Color Stops") ?? null);
  const alphaStops = _parseAlphaStops(dataPairs.get("Alpha Stops") ?? null);

  return Gradient._from_binary({
    color_stops: colorStops,
    alpha_stops: alphaStops,
    version: versionStr || "1.0",
    _utf8: utf8,
  });
}

/**
 * Extract key-value pairs from a prop.list element.
 *
 * Returns a dict mapping key text to the value element (the second
 * child of each prop.pair).
 */
export function _getPairs(propListElem: Element): Map<string, Element> {
  const pairs = new Map<string, Element>();
  for (const pair of propListElem.findall("prop.pair")) {
    const keyElem = pair.find("key");
    if (keyElem == null || keyElem.text == null) continue;
    // Value is the second child (after key)
    const children = [...pair];
    if (children.length >= 2) {
      pairs.set(keyElem.text, children[1]);
    }
  }
  return pairs;
}

/** Get text content from a \<string\> element. */
export function _getStringValue(elem: Element | null): string | null {
  if (elem == null) return null;
  if (elem.tag === "string") return elem.text;
  return null;
}

/** Parse the 'Color Stops' prop.list into GradientColorStop objects. */
export function _parseColorStops(colorStopsElem: Element | null): GradientColorStop[] {
  if (colorStopsElem == null) return [];

  const pairs = _getPairs(colorStopsElem);
  const stopsListElem = pairs.get("Stops List") ?? null;
  if (stopsListElem == null) return [];

  const stops: GradientColorStop[] = [];
  // Each stop is a prop.pair with key "Stop-N"
  const stopPairs = _getPairs(stopsListElem);
  for (let i = 0, n = stopPairs.size; i < n; i++) {
    const key = `Stop-${i}`;
    const stopElem = stopPairs.get(key) ?? null;
    if (stopElem == null) break;
    const stopInner = _getPairs(stopElem);
    const arrayElem = stopInner.get("Stops Color") ?? null;
    if (arrayElem == null) continue;
    const floats = _parseFloatArray(arrayElem);
    if (floats.length >= 5) {
      stops.push(
        new GradientColorStop(floats[0], floats[1], [floats[2], floats[3], floats[4]]),
      );
    }
  }
  return stops;
}

/** Parse the 'Alpha Stops' prop.list into GradientAlphaStop objects. */
export function _parseAlphaStops(alphaStopsElem: Element | null): GradientAlphaStop[] {
  if (alphaStopsElem == null) return [];

  const pairs = _getPairs(alphaStopsElem);
  const stopsListElem = pairs.get("Stops List") ?? null;
  if (stopsListElem == null) return [];

  const stops: GradientAlphaStop[] = [];
  const stopPairs = _getPairs(stopsListElem);
  for (let i = 0, n = stopPairs.size; i < n; i++) {
    const key = `Stop-${i}`;
    const stopElem = stopPairs.get(key) ?? null;
    if (stopElem == null) break;
    const stopInner = _getPairs(stopElem);
    const arrayElem = stopInner.get("Stops Alpha") ?? null;
    if (arrayElem == null) continue;
    const floats = _parseFloatArray(arrayElem);
    if (floats.length >= 3) {
      stops.push(new GradientAlphaStop(floats[0], floats[1], floats[2]));
    }
  }
  return stops;
}

/** Parse an \<array\> element containing \<float\> children. */
export function _parseFloatArray(arrayElem: Element): number[] {
  const floats: number[] = [];
  for (const child of arrayElem) {
    if (child.tag === "float" && child.text != null) {
      try {
        floats.push(float(child.text));
      } catch (e) {
        if (!(e instanceof ValueError)) throw e;
        continue;
      }
    }
  }
  return floats;
}
