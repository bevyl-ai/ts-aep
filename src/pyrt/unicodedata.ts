// `unicodedata.bidirectional` / `unicodedata.combining` over CPython 3.12's
// Unicode database (JS regexes have no Bidi_Class or Canonical_Combining_Class
// property, and the engine's Unicode version is not Python's).

import {  } from "./errors.ts";
import { BIDI_CLASSES, BIDI_LENGTHS, BIDI_VALUES, COMBINING_LENGTHS, COMBINING_VALUES } from "./unicodedata_tables.ts";

interface Runs {
  /** First code point of each run, ascending. */
  starts: Int32Array;
  values: Int32Array;
}

function runs(lengths: string, values: string): Runs {
  const ls = lengths.split(",");
  const vs = values.split(",");
  const starts = new Int32Array(ls.length);
  const out = new Int32Array(vs.length);
  let cp = 0;
  for (let i = 0; i < ls.length; i++) {
    starts[i] = cp;
    cp += Number.parseInt(ls[i], 36);
    out[i] = Number.parseInt(vs[i], 36);
  }
  return { starts, values: out };
}

let BIDI: Runs | null = null;
let COMBINING: Runs | null = null;

function lookup(table: Runs, chr: string, fn: string): number {
  const cp = chr.codePointAt(0);
  if (cp === undefined || chr.length !== (cp > 0xffff ? 2 : 1)) {
    throw new TypeError(`${fn}() argument must be a unicode character, not str`);
  }
  let lo = 0;
  let hi = table.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (table.starts[mid] <= cp) lo = mid;
    else hi = mid - 1;
  }
  return table.values[lo];
}

/** `unicodedata.bidirectional(chr)`: the bidirectional class (`"L"`, `"R"`, `"AL"`, ..., `""`). */
export function bidirectional(chr: string): string {
  BIDI ??= runs(BIDI_LENGTHS, BIDI_VALUES);
  return BIDI_CLASSES[lookup(BIDI, chr, "bidirectional")];
}

/** `unicodedata.combining(chr)`: the canonical combining class (0 when none). */
export function combining(chr: string): number {
  COMBINING ??= runs(COMBINING_LENGTHS, COMBINING_VALUES);
  return lookup(COMBINING, chr, "combining");
}
