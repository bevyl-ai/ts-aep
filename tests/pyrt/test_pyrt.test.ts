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
  py_assert,
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
import { CPY } from "./cpython_fixtures.ts";

/** `float.fromhex` for the `float.hex()` strings in the fixtures. */
function fromhex(s: string): number {
  if (s === "inf") return Infinity;
  if (s === "-inf") return -Infinity;
  if (s === "nan") return NaN;
  const m = /^(-?)0x([01])\.([0-9a-f]+)p([+-]\d+)$/.exec(s);
  py_assert(m != null);
  const mant = Number(BigInt("0x" + m[2] + m[3]));
  const e = Number(m[4]) - 4 * m[3].length;
  const v = e >= -1022 ? mant * 2 ** e : mant * 2 ** (e + 600) * 2 ** -600;
  return m[1] ? -v : v;
}

const run = (f: () => string): string => {
  try {
    return f();
  } catch (e) {
    if (!(e instanceof Error)) throw e;
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
    expect(json_dumps(json_loads(text), { ...opts })).toBe(out);
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
    const m = py_re(p, f).exec(s);
    const span: readonly number[] | null = m == null ? null : [Array.from(s.slice(0, m.index)).length, Array.from(s.slice(0, m.index + m[0].length)).length];
    expect(span).toEqual(exp);
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
    expect(run(() => repr(decode(bytes_.fromhex(hex), enc, err)))).toBe(out);
  });

  test.each(CPY.u32_enc.map((r) => [...r]))("encode(%j, %s)", (text, enc, hex) => {
    expect(bytes_.hex(encode(text, enc))).toBe(hex);
  });
});

describe("pathlib", () => {
  test.each(CPY.paths.map((r) => [...r]))("%s(%j)", (cls, t, ...exp) => {
    const p = cls === "PurePosixPath" ? new PurePosixPath(t) : new PureWindowsPath(t);
    const got: readonly (string | readonly string[])[] = [String(p), p.parts, p.drive, p.root, p.name, p.stem, p.suffix, String(p.parent), String(p.div("f.png"))];
    expect(got).toEqual(exp);
  });
});

describe("builtins", () => {
  test("repr", () => {
    const values = [
      new Map(),
      new Map([["a", 1]]),
      new Map<string, unknown>([["a", [1, 2.5, null, true]], ["b", new Map([["c", "d"]])]]),
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
    expect(bytes_.split(bytes_.fromhex(hex), null, maxsplit).map((p) => bytes_.hex(p))).toEqual([...parts]);
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
