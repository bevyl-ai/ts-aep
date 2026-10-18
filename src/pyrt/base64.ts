// The `base64` subset py_aep uses, with CPython's (non-strict) semantics.

import { ValueError } from "./errors.ts";

const _ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const _TABLE = new Int16Array(256).fill(-1);
for (let i = 0; i < 64; i++) _TABLE[_ALPHABET.charCodeAt(i)] = i;

/** `base64.b64encode(data).decode("ascii")` */
export function b64encode(data: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < data.length; i += 3) {
    const n = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    out += _ALPHABET[n >> 18] + _ALPHABET[(n >> 12) & 63] + _ALPHABET[(n >> 6) & 63] + _ALPHABET[n & 63];
  }
  if (i < data.length) {
    const n = (data[i] << 16) | ((i + 1 < data.length ? data[i + 1] : 0) << 8);
    out += _ALPHABET[n >> 18] + _ALPHABET[(n >> 12) & 63];
    out += i + 1 < data.length ? _ALPHABET[(n >> 6) & 63] + "=" : "==";
  }
  return out;
}

/** binascii.Error (a ValueError subclass). */
class BinasciiError extends ValueError {}

/**
 * `base64.b64decode(s)` (validate=False): characters outside the alphabet
 * are skipped, decoding stops at completed padding, and a dangling partial
 * quad raises `binascii.Error`. Port of CPython 3.12 `binascii.a2b_base64`.
 */
export function b64decode(s: string | Uint8Array): Uint8Array {
  if (typeof s === "string") {
    for (let i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) > 0x7f) throw new ValueError("string argument should contain only ASCII characters");
    }
  }
  const at = typeof s === "string" ? (i: number) => s.charCodeAt(i) : (i: number) => s[i];
  const n = s.length;
  const out = new Uint8Array(Math.floor((n * 3) / 4) + 3);
  let o = 0,
    quadPos = 0,
    leftchar = 0,
    pads = 0;
  for (let i = 0; i < n; i++) {
    const ch = at(i);
    if (ch === 0x3d) {
      if (quadPos >= 2 && quadPos + ++pads >= 4) return out.slice(0, o);
      continue;
    }
    const v = _TABLE[ch];
    if (v < 0) continue;
    pads = 0;
    switch (quadPos) {
      case 0:
        quadPos = 1;
        leftchar = v;
        break;
      case 1:
        quadPos = 2;
        out[o++] = (leftchar << 2) | (v >> 4);
        leftchar = v & 0x0f;
        break;
      case 2:
        quadPos = 3;
        out[o++] = ((leftchar << 4) | (v >> 2)) & 0xff;
        leftchar = v & 0x03;
        break;
      default:
        quadPos = 0;
        out[o++] = ((leftchar << 6) | v) & 0xff;
        leftchar = 0;
    }
  }
  if (quadPos !== 0) {
    if (quadPos === 1) {
      throw new BinasciiError(
        `Invalid base64-encoded string: number of data characters (${Math.floor(o / 3) * 4 + 1}) cannot be 1 more than a multiple of 4`,
      );
    }
    throw new BinasciiError("Incorrect padding");
  }
  return out.slice(0, o);
}
