/** Name generation and incrementing utilities for project items. */

import { ValueError, rstrip } from "../../pyrt/index.ts";

// pyrt isdigit is Nd-only; Python str.isdigit() also accepts superscripts, subscripts and
// circled digits (which then make int() raise ValueError).
// Ranges enumerated from unicodedata: every isdigit() char whose category is not Nd.
export const _NON_ND_DIGIT_RE = /[\u00B2\u00B3\u00B9\u2070\u2074-\u2079\u2080-\u2089\u2460-\u2468\u2474-\u247C\u2488-\u2490\u24EA\u24F5-\u24FD\u24FF\u2776-\u277E\u2780-\u2788\u278A-\u2792\u1369-\u1371\u19DA\u{10A40}-\u{10A43}\u{10E60}-\u{10E68}\u{11052}-\u{1105A}\u{1F100}-\u{1F10A}]/u;
export const _ND_RE = /^\p{Nd}$/u;

export function isdigit(s: string): boolean {
  if (s.length === 0) return false;
  for (const ch of s) {
    if (!_ND_RE.test(ch) && !_NON_ND_DIGIT_RE.test(ch)) return false;
  }
  return true;
}

/** `int(tail)` for a str that passed isdigit(): Unicode Nd digits, arbitrary precision. */
export function _intDigits(tail: string): bigint {
  const cps = Array.from(tail);
  let out = "";
  for (const ch of cps) {
    const cp = ch.codePointAt(0);
    if (cp === undefined || !_ND_RE.test(ch)) throw new ValueError(`invalid literal for int() with base 10: '${tail}'`);
    // Nd digits come in contiguous 0-9 runs starting at a zero.
    let start = cp;
    while (_ND_RE.test(String.fromCodePoint(start - 1))) start--;
    out += String((cp - start) % 10);
  }
  return BigInt(out);
}

// Python `\d` on str patterns matches Unicode Nd digits, hence \p{Nd}. Python `$`
// also matches before one trailing "\n", hence the lookahead.
export const _TRAILING_NUMBER_RE = /(\p{Nd}+)(?=\n?$)/u;

export function _nextSuffix(prefix: string, existingNames: Set<string>): number | bigint {
  /**
   * Return the next available numeric suffix for `{prefix}{N}`.
   *
   * Returns 1 if no name in `existingNames` starts with `prefix`.
   * If any name matches `prefix` (with or without a digit suffix),
   * suffix 1 is skipped - returns at least 2.
   */
  let maxSuffix = 0n;
  for (const name of existingNames) {
    if (name.startsWith(prefix)) {
      const tail = name.slice(prefix.length);
      if (isdigit(tail)) {
        const n = _intDigits(tail);
        const m = n > 0n ? n : 1n;
        maxSuffix = m > maxSuffix ? m : maxSuffix;
      } else {
        maxSuffix = 1n > maxSuffix ? 1n : maxSuffix;
      }
    } else if (name === rstrip(prefix)) {
      maxSuffix = 1n > maxSuffix ? 1n : maxSuffix;
    }
  }
  const result = maxSuffix + 1n;
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : result;
}

export function autoName(name: string, existingNames: Set<string>): string {
  /**
   * Find the next available incremented name.
   *
   * - Removes the number suffix if there is one
   * - Finds the highest number suffix with the same prefix in `existingNames`
   * - Increments it by 1
   * - If no existing name starts with the base name, return `{name} 1`.
   * - If existing names start with the base name but none has a number suffix, skip 1 and
   * return `{name} 2`.
   */
  const match = _TRAILING_NUMBER_RE.exec(name);
  let prefix: string;
  if (match) {
    prefix = name.slice(0, match.index);
  } else {
    prefix = `${name} `;
  }
  const suffix = _nextSuffix(prefix, existingNames);
  return `${prefix}${suffix}`;
}
