// The `zlib` / `gzip` subset py_aep uses, over fflate (pure JS, sync).
//
// fflate's raw inflater does not read the zlib wrapper's trailer, so this
// module parses the header and checks the Adler-32 itself, the way CPython's
// zlib does: `decompress` needs the whole stream plus a matching checksum;
// `decompressobj().decompress(data, max_length)` returns what the available
// input yields (a truncated stream is not an error) and stops at max_length.
// Error texts follow CPython's ("Error -3 while decompressing data: ...").

import { Inflate, gunzipSync } from "fflate";
import { errorCode } from "./errors.ts";

/** fflate's private `Inflate.s` decoder state (untyped in its typings). */
type InflateState = { f: number; l: number; p: number };

/** Python's `zlib.error`. */
export class error extends Error {
  override name = "zlib.error";
  /** `str(exc)` is the bare message, as in `f"... ({exc})"`. */
  override toString(): string {
    return this.message;
  }
}

const Z_DATA_ERROR = -3;
const Z_BUF_ERROR = -5;

function _fail(code: number, msg: string | null): never {
  throw new error(
    msg == null ? `Error ${code} while decompressing data` : `Error ${code} while decompressing data: ${msg}`,
  );
}

// fflate error codes from `inflt` -> zlib's messages for the same faults.
const _FFLATE_MESSAGES: Record<number, string> = {
  1: "invalid block type",
  2: "invalid literal/length code",
  3: "invalid distance too far back",
};

function _rethrow(e: unknown): never {
  const code = errorCode(e);
  if (code === 0) _fail(Z_BUF_ERROR, "incomplete or truncated stream");
  if (typeof code === "number" && code in _FFLATE_MESSAGES) _fail(Z_DATA_ERROR, _FFLATE_MESSAGES[code]);
  throw e;
}

/** zlib's header checks (wbits=15); returns the header length (always 2). */
function _checkHeader(data: Uint8Array, truncatedIsError: true): number;
function _checkHeader(data: Uint8Array, truncatedIsError: false): number | null;
function _checkHeader(data: Uint8Array, truncatedIsError: boolean): number | null {
  if (data.length < 2) {
    if (truncatedIsError) _fail(Z_BUF_ERROR, "incomplete or truncated stream");
    return null;
  }
  const cmf = data[0],
    flg = data[1];
  if (((cmf << 8) | flg) % 31) _fail(Z_DATA_ERROR, "incorrect header check");
  if ((cmf & 0x0f) !== 8) _fail(Z_DATA_ERROR, "unknown compression method");
  if ((cmf >> 4) + 8 > 15) _fail(Z_DATA_ERROR, "invalid window size");
  if (flg & 0x20) _fail(2, null); // Z_NEED_DICT
  return 2;
}

function _adler32(data: Uint8Array): number {
  let a = 1,
    b = 0;
  for (let i = 0; i < data.length;) {
    const end = Math.min(i + 5552, data.length);
    for (; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

interface _Inflated {
  out: Uint8Array;
  /** The bytes after the deflate stream's last bit, once the final block ended. */
  rest: Uint8Array | null;
}

function _concat(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Raw-inflate `body` in `step`-byte pushes, stopping once `limit` output bytes
 * exist (`limit < 0`: no limit). `rest` is set when the final block ended.
 */
function _inflate(body: Uint8Array, limit: number, step: number): _Inflated {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let ended = false;
  const inf = new Inflate((chunk: Uint8Array) => {
    if (chunk.length) {
      chunks.push(chunk);
      total += chunk.length;
    }
  });
  let pushed = 0;
  for (let off = 0; ; off += step) {
    const piece = body.subarray(off, off + step);
    try {
      inf.push(piece, false);
    } catch (e) {
      _rethrow(e);
    }
    pushed = off + piece.length;
    // fflate state: `s.f` = last block seen, `s.l` = inside a block's codes.
    const st: InflateState = inf["s"];
    if (st.f && !st.l) {
      ended = true;
      break;
    }
    if ((limit >= 0 && total >= limit) || pushed >= body.length) break;
  }
  const out = _concat(chunks, total);
  if (!ended) return { out, rest: null };
  // `inf.p` holds the unconsumed input from the byte holding bit `s.p`.
  const tail: Uint8Array = inf["p"];
  const st: InflateState = inf["s"];
  const consumed = pushed - tail.length + ((st.p + 7) >> 3);
  return { out, rest: body.subarray(consumed) };
}

/** `zlib.decompress(data)` (wbits=15). */
export function decompress(data: Uint8Array): Uint8Array {
  const start = _checkHeader(data, true);
  const r = _inflate(data.subarray(start), -1, Math.max(data.length, 1));
  if (r.rest == null || r.rest.length < 4) _fail(Z_BUF_ERROR, "incomplete or truncated stream");
  const t = r.rest;
  if (((t[0] << 24) | (t[1] << 16) | (t[2] << 8) | t[3]) >>> 0 !== _adler32(r.out)) {
    _fail(Z_DATA_ERROR, "incorrect data check");
  }
  return r.out;
}

/** `zlib.decompressobj()`; only the one-shot `decompress(data, max_length)` is used. */
export function decompressobj(): { decompress(data: Uint8Array, maxLength?: number): Uint8Array } {
  return {
    decompress(data: Uint8Array, maxLength = 0): Uint8Array {
      const start = _checkHeader(data, false);
      if (start == null) return new Uint8Array(0);
      const limit = maxLength > 0 ? maxLength : -1;
      // One push: fflate's streaming decoder can misread a code cut at a
      // push boundary. Unlike CPython, input past the max_length-th output
      // byte is therefore still decoded, and a fault there still raises.
      const r = _inflate(data.subarray(start), limit, Math.max(data.length, 1));
      if (limit >= 0 && r.out.length > limit) return r.out.slice(0, limit);
      if (r.rest != null && r.rest.length >= 4) {
        const t = r.rest;
        if (((t[0] << 24) | (t[1] << 16) | (t[2] << 8) | t[3]) >>> 0 !== _adler32(r.out)) {
          _fail(Z_DATA_ERROR, "incorrect data check");
        }
      }
      return r.out;
    },
  };
}

/** `gzip.decompress(data)` (single member). */
export function gzipDecompress(data: Uint8Array): Uint8Array {
  return gunzipSync(data);
}
