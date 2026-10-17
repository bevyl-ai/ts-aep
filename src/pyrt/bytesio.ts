// `io.BytesIO`, the `IO[bytes]` every chunk reader/writer takes, plus
// `io.StringIO` and a read-only `open(path, "rb")`.

import { fs } from "./host.ts";
import { error_code, FileNotFoundError, OSError } from "./errors.ts";
import type { PackValue, Struct, Unpacked } from "./struct.ts";

const PACK_SCRATCH = new Uint8Array(64);

export class BytesIO {
  private buf: Uint8Array;
  private len: number;
  private pos = 0;
  /** `buf` is still the caller's `initial`; copied before the first mutation, as CPython does. */
  private shared: boolean;

  constructor(initial?: Uint8Array) {
    this.buf = initial ?? new Uint8Array(256);
    this.len = initial ? initial.length : 0;
    this.shared = initial !== undefined;
  }

  private own(): void {
    if (this.shared) {
      this.buf = this.buf.slice();
      this.shared = false;
    }
  }

  /** `fp.read(n)`; `n` omitted or negative reads to the end. */
  read(n?: number): Uint8Array {
    const end = n == null || n < 0 ? this.len : Math.min(this.len, this.pos + n);
    const out = this.buf.slice(Math.min(this.pos, end), end);
    this.pos = Math.max(this.pos, end);
    return out;
  }

  /** `fp.read(1)[0]` without allocating, or -1 at the end of the data. */
  read_byte(): number {
    return this.pos < this.len ? this.buf[this.pos++] : -1;
  }

  /**
   * `s.unpack(fp.read(s.size))` without the intermediate copy. Returns null,
   * leaving the position alone, when fewer than `s.size` bytes remain.
   */
  unpack<F extends string>(s: Struct<F>): Unpacked<F> | null {
    if (this.pos + s.size > this.len) return null;
    const out = s.unpack_from(this.buf, this.pos);
    this.pos += s.size;
    return out;
  }

  /** `fp.readline(size)`: up to and including the next `\n` (or `size` bytes, or EOF). */
  readline(size?: number | null): Uint8Array {
    const start = Math.min(this.pos, this.len);
    let end = this.len;
    if (size != null && size >= 0) end = Math.min(end, start + size);
    const nl = this.buf.subarray(start, end).indexOf(0x0a);
    if (nl !== -1) end = start + nl + 1;
    const out = this.buf.slice(start, end);
    this.pos = Math.max(this.pos, end);
    return out;
  }

  write(data: Uint8Array): number {
    const end = this.pos + data.length;
    this.reserve(end);
    this.buf.set(data, this.pos);
    this.pos = end;
    if (end > this.len) this.len = end;
    return data.length;
  }

  /** `fp.write(s.pack(*values))` without allocating the packed bytes. */
  pack<F extends string>(s: Struct<F>, values: PackValue[]): number {
    const end = this.pos + s.size;
    if (this.pos < this.len) {
      if (end > this.len || s.size > PACK_SCRATCH.length) return this.write(s.pack(...values));
      // Overwrite via scratch: a failed pack must leave the visible bytes alone.
      s.pack_to(PACK_SCRATCH, 0, values);
      this.own();
      for (let i = 0; i < s.size; i++) this.buf[this.pos + i] = PACK_SCRATCH[i];
      this.pos = end;
      return s.size;
    }
    // Bytes past `len` are never observable, so a failed pack leaves no trace.
    this.reserve(end);
    s.pack_to(this.buf, this.pos, values);
    this.pos = this.len = end;
    return s.size;
  }

  /** Make room for a write ending at `end`, zeroing any gap a seek past the end left. */
  private reserve(end: number): void {
    this.own();
    if (end > this.buf.length) {
      const grown = new Uint8Array(Math.max(end, this.buf.length * 2));
      grown.set(this.buf.subarray(0, this.len));
      this.buf = grown;
    }
    // A native `fill` costs more than a loop for the 4-byte length placeholder.
    if (this.pos - this.len > 16) this.buf.fill(0, this.len, this.pos);
    else for (let i = this.len; i < this.pos; i++) this.buf[i] = 0;
  }

  tell(): number {
    return this.pos;
  }

  /** `fp.seek(offset, whence)`; whence 0 = start, 1 = current, 2 = end. */
  seek(offset: number, whence: 0 | 1 | 2 = 0): number {
    const base = whence === 0 ? 0 : whence === 1 ? this.pos : this.len;
    this.pos = Math.max(0, base + offset);
    return this.pos;
  }

  getvalue(): Uint8Array {
    return this.buf.slice(0, this.len);
  }

  /** `getbuffer()` - a view without copying. */
  getbuffer(): Uint8Array {
    this.own();
    return this.buf.subarray(0, this.len);
  }

  truncate(size?: number): number {
    this.len = Math.min(this.len, size ?? this.pos);
    return this.len;
  }

  close(): void {}
}

export type IO = BytesIO;

/**
 * `io.StringIO` (newline=None translation is not modelled: text is stored
 * as written). Positions count code points, as in Python.
 */
export class StringIO {
  private chars: string[];
  private pos = 0;

  constructor(initial_value = "") {
    this.chars = Array.from(initial_value);
  }

  /** `write(s)`: overwrite/extend at the position; returns the code points written. */
  write(s: string): number {
    const cs = Array.from(s);
    if (this.pos > this.chars.length) this.chars.push(...new Array(this.pos - this.chars.length).fill("\0"));
    this.chars.splice(this.pos, cs.length, ...cs);
    this.pos += cs.length;
    return cs.length;
  }

  /** `read(size)`; `size` omitted or negative reads to the end. */
  read(size?: number | null): string {
    const end = size == null || size < 0 ? this.chars.length : Math.min(this.chars.length, this.pos + size);
    const out = this.chars.slice(this.pos, end).join("");
    this.pos = Math.max(this.pos, end);
    return out;
  }

  /** `readline(size)`: through the next `\n`. */
  readline(size?: number | null): string {
    let end = this.chars.length;
    if (size != null && size >= 0) end = Math.min(end, this.pos + size);
    let i = this.pos;
    while (i < end && this.chars[i] !== "\n") i++;
    if (i < end) i++;
    const out = this.chars.slice(this.pos, i).join("");
    this.pos = Math.max(this.pos, i);
    return out;
  }

  getvalue(): string {
    return this.chars.join("");
  }

  tell(): number {
    return this.pos;
  }

  seek(offset: number, whence: 0 | 1 | 2 = 0): number {
    this.pos = whence === 0 ? offset : whence === 1 ? this.pos + offset : this.chars.length + offset;
    return this.pos;
  }

  truncate(size?: number | null): number {
    this.chars.length = Math.min(this.chars.length, size ?? this.pos);
    return this.chars.length;
  }

  close(): void {}
}

/**
 * `open(path, "rb")`: a read-only binary file over `node:fs` with the
 * `BufferedReader` methods the port uses (read, readline, iteration, seek,
 * tell, close). Missing files raise `FileNotFoundError` with CPython's text;
 * other OS failures raise `OSError`.
 */
export class FileReader {
  private readonly fd: number;
  private pos = 0;
  private readonly _size: number;

  constructor(readonly path: string) {
    try {
      this.fd = fs.openSync(path, "r");
    } catch (e: unknown) {
      const code = error_code(e);
      if (code === "ENOENT") throw new FileNotFoundError(`[Errno 2] No such file or directory: '${path}'`);
      if (typeof code === "string" && e instanceof Error) throw new OSError(e.message);
      throw e;
    }
    this._size = fs.fstatSync(this.fd).size;
  }

  /** `read(size)`; `size` omitted or negative reads to the end. */
  read(size: number | null = -1): Uint8Array {
    const remaining = Math.max(this._size - this.pos, 0);
    const n = size == null || size < 0 ? remaining : Math.min(size, remaining);
    const out = new Uint8Array(n);
    let got = 0;
    while (got < n) {
      const r = fs.readSync(this.fd, out, got, n - got, this.pos + got);
      if (r === 0) break;
      got += r;
    }
    this.pos += got;
    return got === n ? out : out.slice(0, got);
  }

  /** `readline(size)`: through the next `\n`, at most `size` bytes. */
  readline(size: number | null = -1): Uint8Array {
    const limit = size == null || size < 0 ? Infinity : size;
    const parts: Uint8Array[] = [];
    let total = 0;
    while (total < limit) {
      const block = this.read(Math.min(256, limit - total));
      if (block.length === 0) break;
      const nl = block.indexOf(0x0a);
      if (nl !== -1) {
        // Give back the bytes after the newline.
        this.pos -= block.length - (nl + 1);
        parts.push(block.subarray(0, nl + 1));
        total += nl + 1;
        break;
      }
      parts.push(block);
      total += block.length;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }

  *[Symbol.iterator](): Generator<Uint8Array> {
    for (;;) {
      const line = this.readline();
      if (line.length === 0) return;
      yield line;
    }
  }

  /** `seek(offset, whence)`; whence 0 = start, 1 = current, 2 = end. */
  seek(offset: number, whence: number = 0): number {
    const base = whence === 0 ? 0 : whence === 1 ? this.pos : this._size;
    this.pos = base + offset;
    return this.pos;
  }

  tell(): number {
    return this.pos;
  }

  close(): void {
    fs.closeSync(this.fd);
  }
}

/** `open(path, "rb")` */
export function open_rb(path: string | { toString(): string }): FileReader {
  return new FileReader(String(path));
}
