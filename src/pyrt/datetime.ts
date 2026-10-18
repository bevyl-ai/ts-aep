// `datetime.datetime.fromisoformat`: a port of CPython 3.12's C parser
// (Modules/_datetimemodule.c), which reads the UTF-8 bytes of the string up to
// its NUL terminator and may look past the end of a component; the quirks that
// follow from that are kept.

import { ValueError } from "./errors.ts";
import { repr } from "./builtins.ts";

/** A parsed `datetime`; `utcoffset` is in microseconds, `null` for a naive datetime. */
export interface DatetimeFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  microsecond: number;
  utcoffset: number | null;
}

/** A NUL-terminated byte string: reads past the end see NUL, as C's do. */
type Buf = Uint8Array;
const at = (b: Buf, i: number): number => b[i] ?? 0;
const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
const C = (ch: string): number => ch.charCodeAt(0);

/** C `parse_digits`: `n` ASCII digits at `p`, or null. */
function parseDigits(b: Buf, p: number, n: number): [number, number] | null {
  let v = 0;
  for (let i = 0; i < n; i++) {
    const c = at(b, p++);
    if (!isDigit(c)) return null;
    v = v * 10 + (c - 0x30);
  }
  return [p, v];
}

const isLeap = (y: number): boolean => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
const DAYS_BEFORE_MONTH = [0, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const daysInMonth = (y: number, m: number): number => (m === 2 && isLeap(y) ? 29 : [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m]);

/** Proleptic Gregorian ordinal, 0001-01-01 = 1. */
function ymd2ord(y: number, m: number, d: number): number {
  const y1 = y - 1;
  return y1 * 365 + Math.floor(y1 / 4) - Math.floor(y1 / 100) + Math.floor(y1 / 400) + DAYS_BEFORE_MONTH[m] + (m > 2 && isLeap(y) ? 1 : 0) + d;
}

function ord2ymd(ordinal: number): [number, number, number] {
  let n = ordinal - 1;
  const n400 = Math.floor(n / 146097);
  n %= 146097;
  const n100 = Math.floor(n / 36524);
  n %= 36524;
  const n4 = Math.floor(n / 1461);
  n %= 1461;
  const n1 = Math.floor(n / 365);
  n %= 365;
  const year = n400 * 400 + 1 + n100 * 100 + n4 * 4 + n1;
  if (n1 === 4 || n100 === 4) return [year - 1, 12, 31];
  let month = (n + 50) >> 5;
  let preceding = DAYS_BEFORE_MONTH[month] + (month > 2 && isLeap(year) ? 1 : 0);
  if (preceding > n) {
    month -= 1;
    preceding -= daysInMonth(year, month);
  }
  return [year, month, n - preceding + 1];
}

/** C `iso_to_ymd`, or null where C returns an error code. */
function isoToYmd(isoYear: number, isoWeek: number, isoDay: number): [number, number, number] | null {
  if (isoYear < 1 || isoYear > 9999) return null;
  if (isoWeek <= 0 || isoWeek >= 53) {
    const firstWeekday = (ymd2ord(isoYear, 1, 1) + 6) % 7;
    if (!(isoWeek === 53 && (firstWeekday === 3 || (firstWeekday === 2 && isLeap(isoYear))))) return null;
  }
  if (isoDay <= 0 || isoDay >= 8) return null;
  const firstDay = ymd2ord(isoYear, 1, 1);
  const firstWeekday = (firstDay + 6) % 7;
  let week1Monday = firstDay - firstWeekday;
  if (firstWeekday > 3) week1Monday += 7;
  return ord2ymd(week1Monday + (isoWeek - 1) * 7 + isoDay - 1);
}

/** C `parse_isoformat_date`: [year, month, day], or null on any failure. */
function parseIsoformatDate(b: Buf, len: number): [number, number, number] | null {
  let p = 0;
  const y = parseDigits(b, p, 4);
  if (y === null) return null;
  p = y[0];
  const usesSeparator = at(b, p) === C("-");
  if (usesSeparator) p += 1;
  if (at(b, p) === C("W")) {
    p += 1;
    const w = parseDigits(b, p, 2);
    if (w === null) return null;
    p = w[0];
    let isoDay = 1;
    // A -1 separator location is SIZE_MAX to C.
    if (len < 0 || p < len) {
      if (usesSeparator && at(b, p++) !== C("-")) return null;
      const d = parseDigits(b, p, 1);
      if (d === null) return null;
      isoDay = d[1];
    }
    return isoToYmd(y[1], w[1], isoDay);
  }
  const m = parseDigits(b, p, 2);
  if (m === null) return null;
  p = m[0];
  if (usesSeparator && at(b, p++) !== C("-")) return null;
  const d = parseDigits(b, p, 2);
  if (d === null) return null;
  return [y[1], m[1], d[1]];
}

/**
 * C `parse_hh_mm_ss_ff` over `b[p:end]`: [rv, hour, minute, second, microsecond],
 * rv 0 at the NUL, 1 when other bytes follow, negative on failure.
 */
function parseHhMmSsFf(b: Buf, p: number, end: number): [number, number, number, number, number] {
  const vals = [0, 0, 0];
  let us = 0;
  let hasSeparator = true;
  const done = (rv: number): [number, number, number, number, number] => [rv, vals[0], vals[1], vals[2], us];
  for (let i = 0; i < 3; i++) {
    const r = parseDigits(b, p, 2);
    if (r === null) return done(-3);
    p = r[0];
    vals[i] = r[1];
    const c = at(b, p++);
    if (i === 0) hasSeparator = c === C(":");
    if (p >= end) return done(c !== 0 ? 1 : 0);
    if (hasSeparator && c === C(":")) continue;
    if (c === C(".") || c === C(",")) break;
    if (!hasSeparator) p -= 1;
    else return done(-4);
  }
  const toParse = Math.min(end - p, 6);
  const r = parseDigits(b, p, toParse);
  if (r === null) return done(-3);
  p = r[0];
  us = toParse < 6 ? r[1] * [100000, 10000, 1000, 100, 10][toParse - 1] : r[1];
  while (isDigit(at(b, p))) p += 1;
  return done(at(b, p) !== 0 ? 1 : 0);
}

/** C `parse_isoformat_time` over `b[p:p + len]`: [rv, h, m, s, us, tz seconds, tz microseconds]. */
function parseIsoformatTime(b: Buf, p: number, len: number): number[] {
  const end = p + len;
  let tz = p;
  do {
    const c = at(b, tz);
    if (c === C("Z") || c === C("+") || c === C("-")) break;
  } while (++tz < end);
  const [rv, hour, minute, second, us] = parseHhMmSsFf(b, p, tz);
  if (rv < 0) return [rv];
  if (tz === end) return [rv === 1 ? -5 : 0, hour, minute, second, us, 0, 0];
  if (at(b, tz) === C("Z")) return [at(b, tz + 1) !== 0 ? -5 : 1, hour, minute, second, us, 0, 0];
  const sign = at(b, tz) === C("-") ? -1 : 1;
  const [tzRv, tzh, tzm, tzs, tzus] = parseHhMmSsFf(b, tz + 1, end);
  return [tzRv !== 0 ? -5 : 1, hour, minute, second, us, sign * (tzh * 3600 + tzm * 60 + tzs), sign * tzus];
}

/** C `_find_isoformat_datetime_separator` (byte offsets). */
function findSeparator(b: Buf, len: number): number {
  if (len === 7) return 7;
  if (at(b, 4) === C("-")) {
    if (at(b, 5) === C("W")) {
      if (len < 8) return -1;
      if (len > 8 && at(b, 8) === C("-")) {
        if (len === 9) return -1;
        if (len > 10 && isDigit(at(b, 10))) return 8;
        return 10;
      }
      return 8;
    }
    return 10;
  }
  if (at(b, 4) === C("W")) {
    let idx = 7;
    while (idx < len && isDigit(at(b, idx))) idx += 1;
    if (idx < 9) return idx;
    return idx % 2 === 0 ? 7 : 8;
  }
  return 8;
}

/** `repr(timedelta(microseconds=us))` */
function timedeltaRepr(us: number): string {
  const days = Math.floor(us / 86400e6);
  const rest = us - days * 86400e6;
  const seconds = Math.floor(rest / 1e6);
  const micro = rest - seconds * 1e6;
  const parts: string[] = [];
  if (days) parts.push(`days=${days}`);
  if (seconds) parts.push(`seconds=${seconds}`);
  if (micro) parts.push(`microseconds=${micro}`);
  return `datetime.timedelta(${parts.length ? parts.join(", ") : "0"})`;
}

/** `datetime.fromisoformat(date_string)` */
export function fromisoformat(dateString: string): DatetimeFields {
  const invalid = (): ValueError => new ValueError(`Invalid isoformat string: ${repr(dateString)}`);
  // _sanitize_isoformat_str: a surrogate separator (code point 7, 8 or 10) becomes "T".
  const chars = Array.from(dateString);
  if (chars.length < 7) throw invalid();
  for (const pos of [7, 8, 10]) {
    if (pos > chars.length) break;
    const cp = chars[pos]?.codePointAt(0) ?? 0;
    if (cp >= 0xd800 && cp <= 0xdfff) {
      chars[pos] = "T";
      break;
    }
  }
  // PyUnicode_AsUTF8AndSize: any other surrogate cannot be encoded.
  if (chars.some((ch) => ch.length === 1 && ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdfff)) throw invalid();
  const b: Buf = new TextEncoder().encode(chars.join(""));
  let len = b.length;
  const sep = findSeparator(b, len);
  const date = parseIsoformatDate(b, sep);
  let time: number[] = [0, 0, 0, 0, 0, 0, 0];
  if (date !== null && len > sep) {
    // Skip the separator, a UTF-8 sequence of 1-4 bytes.
    const lead = at(b, sep);
    const p = sep + ((lead & 0x80) === 0 ? 1 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf0) === 0xf0 ? 4 : 2);
    len -= p;
    time = parseIsoformatTime(b, p, len);
  }
  if (date === null || time[0] < 0) throw invalid();
  const [rv, hour, minute, second, microsecond, tzoffset, tzusec] = time;
  let utcoffset: number | null = null;
  if (rv === 1) {
    // A zero second offset is UTC, whatever its microseconds.
    utcoffset = tzoffset === 0 ? 0 : tzoffset * 1e6 + tzusec;
    if (utcoffset <= -86400e6 || utcoffset >= 86400e6) {
      throw new ValueError(
        `offset must be a timedelta strictly between -timedelta(hours=24) and timedelta(hours=24), not ${timedeltaRepr(utcoffset)}.`,
      );
    }
  }
  const [year, month, day] = date;
  if (year < 1 || year > 9999) throw new ValueError(`year ${year} is out of range`);
  if (month < 1 || month > 12) throw new ValueError("month must be in 1..12");
  if (day < 1 || day > daysInMonth(year, month)) throw new ValueError("day is out of range for month");
  if (hour < 0 || hour > 23) throw new ValueError("hour must be in 0..23");
  if (minute < 0 || minute > 59) throw new ValueError("minute must be in 0..59");
  if (second < 0 || second > 59) throw new ValueError("second must be in 0..59");
  return { year, month, day, hour, minute, second, microsecond, utcoffset };
}
