// What ts-aep throws. Catch the exported classes: `AepError` for anything, or
// one of its five kinds. Inside the library each kind is split further by the
// py-aep exception it mirrors (`KeyError` is a `NotFoundError`), which keeps
// internal `catch` logic and the py-aep differential exact; `name` reports the
// exported kind. Wrong-type arguments throw JS's own `TypeError`.

export class AepError extends Error {
  constructor(message = "") {
    super(message);
    let kind: Function = new.target;
    while (!PUBLIC.has(kind)) kind = Object.getPrototypeOf(kind);
    this.name = kind.name;
  }
}

/** A value outside what After Effects accepts, or bytes that do not decode. */
export class InvalidValueError extends AepError {}
/** No item, property, key or index by that name or position. */
export class NotFoundError extends AepError {}
/** Not supported for this file, layer or property type (or not ported yet). */
export class UnsupportedError extends AepError {}
/** A file could not be read or written. */
export class FileSystemError extends AepError {}

const PUBLIC = new Set<Function>([AepError, InvalidValueError, NotFoundError, UnsupportedError, FileSystemError]);

export class ValueError extends InvalidValueError {}
class UnicodeError extends ValueError {}
export class UnicodeDecodeError extends UnicodeError {}
export class UnicodeEncodeError extends UnicodeError {}
export class OverflowError extends InvalidValueError {}
export class ZeroDivisionError extends InvalidValueError {}
/** `struct.error` */
export class StructError extends InvalidValueError {}
export class LookupError extends NotFoundError {}
export class KeyError extends LookupError {}
export class IndexError extends LookupError {}
export class AttributeError extends NotFoundError {}
export class NotImplementedError extends UnsupportedError {}
export class OSError extends FileSystemError {}
export class FileNotFoundError extends OSError {}
export class FileExistsError extends OSError {}
export class RuntimeError extends AepError {}
export class AssertionError extends AepError {}
export class StopIteration extends AepError {}

/**
 * `SystemExit` (a `BaseException`, so not an `AepError`: translated
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

function emitWarning(message: string): void {
  const proc = (globalThis as { process?: { emitWarning?: (message: string, type: string) => void } }).process;
  if (typeof proc?.emitWarning === "function") proc.emitWarning(message, "AepWarning");
  else console.warn(`AepWarning: ${message}`);
}

let warningHandler: (message: string) => void = emitWarning;

/**
 * Route ts-aep's warnings (skipped content, fallbacks, deprecations) to `handler`,
 * or back to the default with `null`: `process.emitWarning` where it exists,
 * `console.warn` elsewhere. Pass `() => {}` to silence them. Returns the
 * handler it replaces.
 */
export function setWarningHandler(handler: ((message: string) => void) | null): (message: string) => void {
  const previous = warningHandler;
  warningHandler = handler ?? emitWarning;
  return previous;
}

/** Raise a warning through the warning handler (see `setWarningHandler`). */
export function warn(message: string): void {
  warningHandler(message);
}
