// Error classes named after the Python exceptions py-aep raises, so callers and the
// py-aep differential see the same class names. Catch `AepError` for any of them.
// Python's `TypeError` and `SyntaxError` are JS's own (built-in) errors.

export class AepError extends Error {
  constructor(message = "") {
    super(message);
    this.name = new.target.name;
  }
}

export class ValueError extends AepError {}
export class AttributeError extends AepError {}
export class NotImplementedError extends AepError {}
export class RuntimeError extends AepError {}
export class AssertionError extends AepError {}
export class ZeroDivisionError extends AepError {}
export class OverflowError extends AepError {}
export class StopIteration extends AepError {}
export class LookupError extends AepError {}
export class KeyError extends LookupError {}
export class IndexError extends LookupError {}
/** Python's `OSError` (alias `IOError`). */
export class OSError extends AepError {}
export class FileNotFoundError extends OSError {}
export class FileExistsError extends OSError {}
export class UnicodeError extends ValueError {}
export class UnicodeDecodeError extends UnicodeError {}
export class UnicodeEncodeError extends UnicodeError {}
/** `struct.error` */
export class StructError extends AepError {}

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
export function errorCode(e: unknown): unknown {
  return typeof e === "object" && e !== null && "code" in e ? e.code : undefined;
}

/** Python's `assert cond, msg`. */
export function assert(cond: unknown, message = ""): asserts cond {
  if (!cond) throw new AssertionError(message);
}

export function warn(message: string): void {
  warnings.push(message);
}

/** Captured `warnings.warn` messages, for `pytest.warns` translations. */
export const warnings: string[] = [];
