// pytest idioms for the translated suite (bun:test underneath).
//
//   pytest                                  bun:test + this module
//   def test_x(): ...                       test("test_x", () => { ... })
//   class TestFoo: def test_x(self)         describe("TestFoo", () => { test("test_x", ...) })
//   @pytest.mark.parametrize("a,b", rows)   test.each(rows)("test_x[%#]", (a, b) => ...)
//   @pytest.mark.skipif(cond, reason=...)   test.skipIf(cond)("test_x", ...)
//   pytest.skip("why") inside a test        return skip("why")
//   pytest.fail("why")                      fail("why")
//   pytest.importorskip("mod")              if (!importorskip("npm-mod")) return
//   with pytest.raises(E, match="re"):      raises(E, () => { ... }, "re")
//   with pytest.warns(UserWarning, match=)  warns(() => { ... }, "re")
//   x == pytest.approx(y, abs=..., rel=...) expect(approx(x, y, { abs, rel })).toBe(true)
//   tmp_path fixture                        const tmp_path = make_tmp_path()
//   assert a == b                           expect(py_eq(a, b)).toBe(true)  or  expect(a).toBe(b) for primitives

import { fs, path as nodepath, tmpdir } from "../../src/pyrt/host.ts";
import { valueEquals } from "../../src/pyrt/builtins.ts";
import { setWarningHandler } from "../../src/pyrt/errors.ts";
import { Path } from "../../src/pyrt/pathlib.ts";

export function raises<E extends Error>(
  cls: abstract new (...a: never[]) => E,
  fn: () => void,
  match?: string | RegExp,
): E {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof cls)) throw e;
    if (match !== undefined && !new RegExp(match).test(e.message)) {
      throw new Error(`Regex pattern did not match.\n Regex: ${String(match)}\n Input: ${e.message}`);
    }
    return e;
  }
  throw new Error(`DID NOT RAISE ${cls.name}`);
}

export function warns(fn: () => void, match?: string | RegExp): string[] {
  const caught: string[] = [];
  const previous = setWarningHandler((m) => caught.push(m));
  try {
    fn();
  } finally {
    setWarningHandler(previous);
  }
  if (!caught.length) throw new Error("DID NOT WARN");
  if (match !== undefined && !caught.some((m) => new RegExp(match).test(m))) {
    throw new Error(`No warning matched ${String(match)}: ${caught.join(" | ")}`);
  }
  return caught;
}

/** Numbers, (nested) sequences of them, or anything `valueEquals` compares. */
export type ApproxOperand = number | ArrayLike<ApproxOperand> | object | string | boolean | null | undefined;

/** `actual == pytest.approx(expected, rel=1e-6, abs=1e-12)` over numbers or (nested) sequences. */
export function approx(
  actual: ApproxOperand,
  expected: ApproxOperand,
  opts: { rel?: number; abs?: number } = {},
): boolean {
  if (Array.isArray(expected) || ArrayBuffer.isView(expected)) {
    const a = Array.from(actual as ArrayLike<ApproxOperand>);
    const e = Array.from(expected as ArrayLike<ApproxOperand>);
    return a.length === e.length && a.every((x, i) => approx(x, e[i], opts));
  }
  if (typeof expected !== "number" || typeof actual !== "number") return valueEquals(actual, expected);
  if (actual === expected) return true;
  if (Number.isNaN(actual) || Number.isNaN(expected)) return false;
  const rel = opts.rel ?? (opts.abs === undefined ? 1e-6 : 0);
  const abs = opts.abs ?? 1e-12;
  return Math.abs(actual - expected) <= Math.max(rel * Math.abs(expected), abs);
}

/** `pytest.skip(reason)` - throw-free: `return skip("why")` from the test body. */
export function skip(reason = ""): void {
  console.log(`skipped: ${reason}`);
}

/** `pytest.fail.Exception` */
export class Failed extends Error {
  constructor(message = "") {
    super(message);
    this.name = "Failed";
  }
}

/** `pytest.fail(reason)`: fail the running test. */
export function fail(reason = ""): never {
  throw new Failed(reason);
}

/**
 * `pytest.importorskip(name)`: whether the (npm) module resolves; when it
 * does not, reports the skip like `skip()` and the caller returns early.
 */
export function importorskip(name: string): boolean {
  try {
    // `import.meta.resolve` is the host-neutral resolver (Bun, Node 20+, browsers with import maps).
    import.meta.resolve(name);
    return true;
  } catch {
    skip(`could not import '${name}'`);
    return false;
  }
}

export function makeTmpPath(): Path {
  return new Path(fs.mkdtempSync(nodepath.join(tmpdir(), "py_aep-")));
}
