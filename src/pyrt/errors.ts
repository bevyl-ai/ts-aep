// Python's builtin exception hierarchy, so `except X` maps to `instanceof X`.

export class PyException extends Error {
  constructor(message = "") {
    super(message);
    this.name = new.target.name;
  }
}

export class ValueError extends PyException {}
export class TypeError_ extends PyException {}
export class KeyError extends PyException {}
export class IndexError extends PyException {}
export class AttributeError extends PyException {}
export class NotImplementedError extends PyException {}
export class RuntimeError extends PyException {}
export class AssertionError_ extends PyException {}
export class ZeroDivisionError extends PyException {}
export class OverflowError extends PyException {}
export class StopIteration extends PyException {}
export class LookupError extends PyException {}
/** Python's `OSError` (alias `IOError`). */
export class OSError extends PyException {}
export class FileNotFoundError extends OSError {}
export class FileExistsError extends OSError {}
export class UnicodeError extends ValueError {}
export class UnicodeDecodeError extends UnicodeError {}
export class UnicodeEncodeError extends UnicodeError {}
/** `struct.error` */
export class StructError extends PyException {}
/** Python `SyntaxError` (raised by parsers such as the COS reader). */
export class SyntaxError_ extends PyException {}

/**
 * `SystemExit` (a `BaseException`, so not a `PyException`: translated
 * `except Exception` handlers do not catch it). `code` is the exit status.
 */
export class SystemExit extends Error {
  declare code: number | string | null;
  constructor(code: number | string | null = null) {
    super(code == null ? "" : String(code));
    this.name = "SystemExit";
    this.code = code;
  }
}

/** `e.code` of a thrown host error (`"ENOENT"`, fflate's number), or undefined. */
export function error_code(e: unknown): unknown {
  return typeof e === "object" && e !== null && "code" in e ? e.code : undefined;
}

/** Python's `assert cond, msg`. */
export function py_assert(cond: unknown, message = ""): asserts cond {
  if (!cond) throw new AssertionError_(message);
}

export function warn(message: string): void {
  warnings.push(message);
}

/** Captured `warnings.warn` messages, for `pytest.warns` translations. */
export const warnings: string[] = [];
