/**
 * Shared low-level helpers for the SVG reader package.
 */

import { float, hypot, patternMatch, pyRe } from "../../pyrt/index.ts";

/** An SVG/CSS number token: optional sign, decimal or integer, optional exponent. */
export const NUMBER_RE = pyRe(String.raw`[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?`, 0, "g");
/** The same token allowing a trailing `%` (CSS color / ratio values). */
export const NUMBER_PCT_RE = pyRe(String.raw`[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?%?`, 0, "g");
/** A length: a number and an optional unit or `%`. */
export const _LENGTH_RE = pyRe(String.raw`([-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)\s*(%|[A-Za-z]+)?`);
/** CSS absolute units in user units (px): CSS Values 3 fixes 1in = 96px. */
export const _ABSOLUTE_UNITS = new Map<string, number>([
  ["px", 1.0],
  ["in", 96.0],
  ["cm", 96.0 / 2.54],
  ["mm", 96.0 / 25.4],
  ["q", 96.0 / 101.6],
  ["pt", 96.0 / 72.0],
  ["pc", 16.0],
]);
// A Map, not a plain object: the unit is arbitrary input, and a plain object
// would answer `constructor` / `toString` as if they were units.
/** The CSS initial font size (`medium`), the `em` reference by default. */
export const DEFAULT_FONT_SIZE = 16.0;

/**
 * What relative SVG lengths resolve against: the nearest viewport's
 * size in user units (its viewBox) and the element's font size.
 */
export class LengthContext {
  readonly width: number;
  readonly height: number;
  readonly fontSize: number;

  constructor(width: number, height: number, fontSize: number = DEFAULT_FONT_SIZE) {
    this.width = width;
    this.height = height;
    this.fontSize = fontSize;
  }

  *[Symbol.iterator](): Generator<number> {
    yield this.width;
    yield this.height;
    yield this.fontSize;
  }

  /**
   * The normalized diagonal a percentage of no particular axis (a
   * radius, a stroke width) refers to: `sqrt((w^2 + h^2) / 2)`.
   */
  get diagonal(): number {
    return hypot(this.width, this.height) / Math.sqrt(2.0);
  }
}

/**
 * Strip an XML namespace, e.g. `{http://...}rect` -\> `rect`.
 */
export function localName(tag: string): string {
  const parts = tag.split("}");
  return parts[parts.length - 1];
}

/**
 * Clamp a float to the `[0.0, 1.0]` range.
 */
export function clamp01(value: number): number {
  return value < 0.0 ? 0.0 : (value > 1.0 ? 1.0 : value);
}

/**
 * Leading numeric value of `text`, ignoring a unit suffix (e.g.
 * `"40px"` -\> `40.0`); `default` when absent or non-numeric.
 */
export function parseNumber(text: string | null, default_: number = 0.0): number {
  if (!text) return default_;
  const m = patternMatch(NUMBER_RE, text.trim());
  return m ? float(m[0]) : default_;
}

/**
 * An SVG length in user units: CSS absolute units (`mm`, `pt`, `in`,
 * ...) at 96 px per inch, `em` / `ex` from `fontSize`, a percentage of
 * `percentOf` (the bare number when `null`); a unitless number or an
 * unknown unit is taken as px. `default` when absent or non-numeric.
 */
export function parseLength(
  text: string | null,
  default_: number = 0.0,
  percentOf: number | null = null,
  fontSize: number = DEFAULT_FONT_SIZE,
): number {
  if (!text) return default_;
  const m = patternMatch(_LENGTH_RE, text.trim());
  if (m == null) return default_;
  const value = float(m[1]);
  const unit = (m[2] ?? "").toLowerCase();
  if (unit === "%") {
    return percentOf != null ? (value * percentOf) / 100.0 : value;
  }
  if (unit === "em") {
    return value * fontSize;
  }
  if (unit === "ex") {
    return (value * fontSize) / 2.0;
  }
  return value * (_ABSOLUTE_UNITS.get(unit) ?? 1.0);
}

/**
 * CSS ratio (`0.5` or `50%`) clamped to `[0, 1]`; `default` when the
 * value is absent or non-numeric (e.g. the keyword `inherit`).
 */
export function parseRatio(text: string | null, default_: number): number {
  if (text == null) return default_;
  text = text.trim();
  const m = patternMatch(NUMBER_RE, text);
  if (m == null) return default_;
  const val = float(m[0]);
  return clamp01(text.endsWith("%") ? val / 100.0 : val);
}
