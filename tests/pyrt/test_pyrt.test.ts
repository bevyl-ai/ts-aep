/** pyrt shims checked against CPython 3.12 results (tests/pyrt/cpython_fixtures.ts). */

import { describe, expect, test } from "bun:test";
import {
  BytesIO,
  JSONDecodeError,
  PurePosixPath,
  PureWindowsPath,
  StringIO,
  bytes_,
  decode,
  dict,
  encode,
  float,
  float_repr,
  hypot,
  int,
  json_dumps,
  json_getitem,
  json_loads,
  list_mul,
  pattern_findall,
  pattern_match,
  py_eq,
  py_re,
  pyfloat,
  re_escape,
  repr,
  struct,
  truediv,
  type_name,
  ZeroDivisionError,
} from "../../src/pyrt/index.ts";
import { raises } from "../../src/pyrt/pytest.ts";
import * as unicodedata from "../../src/pyrt/unicodedata.ts";
import * as datetime from "../../src/pyrt/datetime.ts";
import { CPY } from "./cpython_fixtures.ts";

/** `float.fromhex` for the `float.hex()` strings in the fixtures. */
function fromhex(s: string): number {
  if (s === "inf") return Infinity;
  if (s === "-inf") return -Infinity;
  if (s === "nan") return NaN;
  const m = /^(-?)0x([01])\.([0-9a-f]+)p([+-]\d+)$/.exec(s)!;
  const mant = Number(BigInt("0x" + m[2] + m[3]));
  const e = Number(m[4]) - 4 * m[3].length;
  const v = e >= -1022 ? mant * 2 ** e : mant * 2 ** (e + 600) * 2 ** -600;
  return m[1] ? -v : v;
}

const run = (f: () => string): string => {
  try {
    return f();
  } catch (e: any) {
    return `${e.constructor.name}: ${e.message}`;
  }
};

describe("math", () => {
  test.each(CPY.hypot.map((r) => [...r]))("hypot(%s, %s)", (x, y, r) => {
    expect(Object.is(hypot(fromhex(x), fromhex(y)), fromhex(r)) || (r === "nan" && Number.isNaN(hypot(fromhex(x), fromhex(y))))).toBe(true);
  });
});

describe("json", () => {
  test.each(CPY.dumps.map((r) => [...r]))("dumps(loads(%j), %j)", (text, opts, out) => {
    expect(json_dumps(json_loads(text as string), { ...(opts as any) })).toBe(out as string);
  });

  test.each(CPY.errs.map((r) => [...r]))("loads(%j) error", (text, msg) => {
    expect(raises(JSONDecodeError, () => json_loads(text)).message).toBe(msg);
  });

  test("python types", () => {
    const d = json_loads('{"2": 1.0, "1": 12345678901234567890, "x": -0}');
    if (!(d instanceof Map)) throw new Error("expected a JSON object");
    expect([...d.keys()]).toEqual(["2", "1", "x"]);
    expect(type_name(d.get("2"))).toBe("float");
    expect(d.get("1")).toBe(12345678901234567890n);
    expect(Object.is(d.get("x"), 0)).toBe(true);
    expect(json_getitem(json_loads(encode('{"a": 1}', "utf-32")), "a")).toBe(1);
  });
});

describe("num", () => {
  test.each(CPY.int.map((r) => [...r]))("int(%j, %d)", (s, b, out) => {
    expect(run(() => repr(int(s, b)))).toBe(out);
  });

  test.each(CPY.float.map((r) => [...r]))("float(%j)", (s, out) => {
    expect(run(() => float_repr(float(s)))).toBe(out);
  });

  test("truediv", () => {
    expect(truediv(1, 4)).toBe(0.25);
    expect(raises(ZeroDivisionError, () => truediv(1, 0)).message).toBe("float division by zero");
    expect(raises(ZeroDivisionError, () => truediv(1, 0, "int")).message).toBe("division by zero");
    expect(raises(ZeroDivisionError, () => truediv(pyfloat(1), 0, "int")).message).toBe("float division by zero");
  });
});

describe("re", () => {
  test.each(CPY.re.map((r) => [...r]))("search(%j, %j, %d)", (p, s, f, exp) => {
    const m = py_re(p as string, f as number).exec(s as string);
    const span = m == null ? null : [Array.from((s as string).slice(0, m.index)).length, Array.from((s as string).slice(0, m.index + m[0].length)).length];
    expect(span).toEqual(exp as any);
  });

  test.each(CPY.re_escape.map((r) => [...r]))("escape(%j)", (s, out) => {
    expect(re_escape(s)).toBe(out);
    expect(pattern_match(py_re(re_escape(s)), s)?.[0]).toBe(s);
  });

  test("findall groups", () => {
    expect(pattern_findall(py_re(String.raw`\d+`), "a1b22")).toEqual(["1", "22"]);
    expect(pattern_findall(py_re(String.raw`(\w)=(\d)?`), "a=1 b=")).toEqual([["a", "1"], ["b", ""]]);
  });
});

describe("codecs", () => {
  test.each(CPY.u32.map((r) => [...r]))("decode(%s, %s, %s)", (hex, enc, err, out) => {
    expect(run(() => repr(decode(bytes_.fromhex(hex), enc, err as any)))).toBe(out);
  });

  test.each(CPY.u32_enc.map((r) => [...r]))("encode(%j, %s)", (text, enc, hex) => {
    expect(bytes_.hex(encode(text, enc))).toBe(hex);
  });

  // Code pages, from CPython 3.12 (tools/gen_codepages.ts checks every one- and two-byte sequence).
  test.each<[string, string, Parameters<typeof decode>[2], string]>([
    ["41a0b1fd8140", "cp932", "strict", "'A\\uf8f0ｱ\\uf8f1\\u3000'"],
    ["82a0e0408120", "cp932", "strict", "UnicodeDecodeError: 'cp932' codec can't decode byte 0x81 in position 4: illegal multibyte sequence"],
    ["418281", "cp932", "surrogateescape", "'Aａ'"],
    ["4182", "cp932", "strict", "UnicodeDecodeError: 'cp932' codec can't decode byte 0x82 in position 1: incomplete multibyte sequence"],
    ["80c4e3baf3", "cp936", "strict", "UnicodeDecodeError: 'gbk' codec can't decode byte 0x80 in position 0: illegal multibyte sequence"],
    ["a140", "gbk", "strict", "UnicodeDecodeError: 'gbk' codec can't decode byte 0xa1 in position 0: illegal multibyte sequence"],
    ["8130a1a1", "cp936", "replace", "'�0\\u3000'"],
    ["b0a1c9a1", "cp949", "strict", "UnicodeDecodeError: 'cp949' codec can't decode byte 0xc9 in position 2: illegal multibyte sequence"],
    ["c9a1", "uhc", "strict", "UnicodeDecodeError: 'cp949' codec can't decode byte 0xc9 in position 0: illegal multibyte sequence"],
    ["a440c6a1f9fe", "cp950", "strict", "'一ヾ▓'"],
    ["8740", "cp950", "surrogateescape", "'\\udc87@'"],
    ["8a9e", "cp1250", "strict", "'Šž'"],
    ["81", "windows-1250", "strict", "UnicodeDecodeError: 'charmap' codec can't decode byte 0x81 in position 0: character maps to <undefined>"],
    ["a1db", "cp874", "strict", "UnicodeDecodeError: 'charmap' codec can't decode byte 0xdb in position 1: character maps to <undefined>"],
    ["80", "ascii", "strict", "UnicodeDecodeError: 'ascii' codec can't decode byte 0x80 in position 0: ordinal not in range(128)"],
  ])("decode(%s, %s, %s)", (hex, enc, err, out) => {
    expect(run(() => repr(decode(bytes_.fromhex(hex), enc, err)))).toBe(out);
  });
});

describe("unicodedata", () => {
  // CPython 3.12 (Unicode 15.0.0); U+1C89 is assigned only from Unicode 16.
  test.each<[number, string, number]>([
    [0x61, "L", 0],
    [0x60c, "CS", 0],
    [0x903, "L", 0],
    [0x300, "NSM", 230],
    [0x5d0, "R", 0],
    [0x660, "AN", 0],
    [0x627, "AL", 0],
    [0x378, "", 0],
    [0x1c89, "", 0],
    [0xe48, "NSM", 107],
  ])("code point %d", (cp, bidi, ccc) => {
    const chr = String.fromCodePoint(cp);
    expect([unicodedata.bidirectional(chr), unicodedata.combining(chr)]).toEqual([bidi, ccc]);
  });
});

describe("datetime", () => {
  // CPython 3.12's C fromisoformat, quirks included.
  test.each<[string, string]>([
    ["2020-01-01T12:34W+05", "2020,1,1,12,34,0,0,18000000000"],
    ["2021-02-23-", "ValueError: Invalid isoformat string: '2021-02-23-'"],
    ["2020W0118", "ValueError: Invalid isoformat string: '2020W0118'"],
    [
      "2020-01-01T12:34+75",
      "ValueError: offset must be a timedelta strictly between -timedelta(hours=24) and timedelta(hours=24), not datetime.timedelta(days=3, seconds=10800).",
    ],
    ["2020-01-01T00:00+00:00:00.5", "2020,1,1,0,0,0,0,0"],
    ["2021-02-29", "ValueError: day is out of range for month"],
    ["2020-W53-7", "2021,1,3,0,0,0,0,"],
    ["2021-W53", "ValueError: Invalid isoformat string: '2021-W53'"],
  ])("fromisoformat(%j)", (s, out) => {
    expect(run(() => Object.values(datetime.fromisoformat(s)).join(","))).toBe(out);
  });
});

describe("pathlib", () => {
  test.each(CPY.paths.map((r) => [...r]))("%s(%j)", (cls, t, ...exp) => {
    const p = cls === "PurePosixPath" ? new PurePosixPath(t as string) : new PureWindowsPath(t as string);
    expect([String(p), p.parts, p.drive, p.root, p.name, p.stem, p.suffix, String(p.parent), String(p.div("f.png"))]).toEqual(exp as any);
  });
});

describe("builtins", () => {
  test("repr", () => {
    const values = [
      new Map(),
      new Map([["a", 1]]),
      new Map<string, any>([["a", [1, 2.5, null, true]], ["b", new Map([["c", "d"]])]]),
      new Set(),
      new Set([1]),
      "a﻿b​",
      "it's",
    ];
    expect(values.map(repr)).toEqual([...CPY.repr]);
  });

  test("type_name", () => {
    expect([1, 1.5, pyfloat(1), 1n, "s", new Uint8Array(), [], new Map(), new Set(), null, true, new BytesIO()].map(type_name)).toEqual([
      "int", "float", "float", "int", "str", "bytes", "list", "dict", "set", "NoneType", "bool", "BytesIO",
    ]);
  });

  test("list_mul and dict", () => {
    expect(list_mul([0, 1], 2)).toEqual([0, 1, 0, 1]);
    expect(list_mul([0], -1)).toEqual([]);
    const view = { keys: () => ["a", "b"], __getitem__: (k: string) => k.toUpperCase() };
    expect(py_eq(dict(view), new Map([["a", "A"], ["b", "B"]]))).toBe(true);
    expect(py_eq(dict([["x", 1]]), new Map([["x", 1]]))).toBe(true);
  });
});

describe("bytes and io", () => {
  test.each(CPY.bsplit.map((r) => [...r]))("split(%s, None, %d)", (hex, maxsplit, parts) => {
    expect(bytes_.split(bytes_.fromhex(hex as string), null, maxsplit as number).map((p) => bytes_.hex(p))).toEqual(parts as any);
  });

  test("pack_into", () => {
    const buf = new Uint8Array(8);
    struct.pack_into("<I", buf, -4, 0x01020304);
    expect([...buf.slice(4)]).toEqual([4, 3, 2, 1]);
    const errs = [6, -2, -9].map((off) => run(() => (struct.pack_into("<I", buf, off, 1), "")));
    expect(errs.map((e) => e.replace(/^StructError/, "error"))).toEqual([...CPY.pack_into_err]);
  });

  test("readline", () => {
    const fp = new BytesIO(encode("ab\ncd", "utf-8"));
    expect(bytes_.hex(fp.readline())).toBe("61620a");
    expect(bytes_.hex(fp.readline(1))).toBe("63");
    expect(bytes_.hex(fp.readline())).toBe("64");
    expect(fp.readline().length).toBe(0);
    const sio = new StringIO();
    sio.write("x\u{1f600}\ny");
    sio.seek(0);
    expect(sio.readline()).toBe("x\u{1f600}\n");
    expect(sio.getvalue()).toBe("x\u{1f600}\ny");
  });
});
