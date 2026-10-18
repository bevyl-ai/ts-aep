/**
 * MurmurHash3 (x64, 128-bit) - the hash After Effects uses to derive the 16-byte
 * `Guid` (UID) of a color space.
 *
 * After Effects identifies an OCIO output color space by a 16-byte id stored in the
 * render-queue output module (`outputProfileId`). That id is the color space's
 * `Guid`, computed as a two-stage MurmurHash3. The only non-standard detail is the
 * seed: AE initializes both 64-bit accumulators with `0xC29DE5B8264CD69E` instead
 * of 0. Verified against the ids AE itself stores in the `output_color_space_ocio`
 * samples.
 *
 * This module is the standard `MurmurHash3_x64_128` (Austin Appleby), parameterized
 * by that seed.
 */

import { Bytes, concat, floordiv } from "../../pyrt/index.ts";

export const _MASK = (1n << 64n) - 1n;
export const _C1 = 0x87c37b91114253d5n;
export const _C2 = 0x4cf5ad432745937fn;

/** The seed After Effects loads into both accumulators. */
export const GUID_SEED = 0xc29de5b8264cd69en;

export function _rotl64(x: bigint, r: number): bigint {
  const br = BigInt(r);
  return ((x << br) | (x >> (64n - br))) & _MASK;
}

export function _fmix64(k: bigint): bigint {
  k ^= k >> 33n;
  k = (k * 0xff51afd7ed558ccdn) & _MASK;
  k ^= k >> 33n;
  k = (k * 0xc4ceb9fe1a85ec53n) & _MASK;
  k ^= k >> 33n;
  return k;
}

/**
 * Return the 16-byte MurmurHash3 x64 128-bit digest of `data`.
 *
 * `seed` initializes both 64-bit accumulators (After Effects uses
 * {@link GUID_SEED | GUID_SEED}). The output is `h1` then `h2`,
 * each little-endian - the byte order After Effects stores in a `Guid`.
 */
export function murmurhash3X64128(data: Uint8Array, seed: number | bigint = 0): Uint8Array {
  let h1 = BigInt(seed) & _MASK;
  let h2 = BigInt(seed) & _MASK;
  const length = data.length;
  const nblocks = floordiv(length, 16);
  // `int.from_bytes(..., "little")` on each 8-byte half, kept as an unsigned bigint.
  // `intFromBytes` returns a number, which is lossy above 2**53.
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < nblocks; i++) {
    let k1 = dv.getBigUint64(i * 16, true);
    let k2 = dv.getBigUint64(i * 16 + 8, true);
    k1 = (_rotl64((k1 * _C1) & _MASK, 31) * _C2) & _MASK;
    h1 ^= k1;
    h1 = _rotl64(h1, 27);
    h1 = (h1 + h2) & _MASK;
    h1 = (h1 * 5n + 0x52dce729n) & _MASK;
    k2 = (_rotl64((k2 * _C2) & _MASK, 33) * _C1) & _MASK;
    h2 ^= k2;
    h2 = _rotl64(h2, 31);
    h2 = (h2 + h1) & _MASK;
    h2 = (h2 * 5n + 0x38495ab5n) & _MASK;
  }
  const tail = data.slice(nblocks * 16);
  let k1 = 0n;
  let k2 = 0n;
  const tl = tail.length;
  if (tl >= 15) {
    k2 ^= BigInt(tail[14]) << 48n;
  }
  if (tl >= 14) {
    k2 ^= BigInt(tail[13]) << 40n;
  }
  if (tl >= 13) {
    k2 ^= BigInt(tail[12]) << 32n;
  }
  if (tl >= 12) {
    k2 ^= BigInt(tail[11]) << 24n;
  }
  if (tl >= 11) {
    k2 ^= BigInt(tail[10]) << 16n;
  }
  if (tl >= 10) {
    k2 ^= BigInt(tail[9]) << 8n;
  }
  if (tl >= 9) {
    k2 ^= BigInt(tail[8]);
    k2 = (_rotl64((k2 * _C2) & _MASK, 33) * _C1) & _MASK;
    h2 ^= k2;
  }
  if (tl >= 8) {
    k1 ^= BigInt(tail[7]) << 56n;
  }
  if (tl >= 7) {
    k1 ^= BigInt(tail[6]) << 48n;
  }
  if (tl >= 6) {
    k1 ^= BigInt(tail[5]) << 40n;
  }
  if (tl >= 5) {
    k1 ^= BigInt(tail[4]) << 32n;
  }
  if (tl >= 4) {
    k1 ^= BigInt(tail[3]) << 24n;
  }
  if (tl >= 3) {
    k1 ^= BigInt(tail[2]) << 16n;
  }
  if (tl >= 2) {
    k1 ^= BigInt(tail[1]) << 8n;
  }
  if (tl >= 1) {
    k1 ^= BigInt(tail[0]);
    k1 = (_rotl64((k1 * _C1) & _MASK, 31) * _C2) & _MASK;
    h1 ^= k1;
  }
  h1 ^= BigInt(length);
  h2 ^= BigInt(length);
  h1 = (h1 + h2) & _MASK;
  h2 = (h2 + h1) & _MASK;
  h1 = _fmix64(h1);
  h2 = _fmix64(h2);
  h1 = (h1 + h2) & _MASK;
  h2 = (h2 + h1) & _MASK;
  return concat(Bytes.intToBytes(h1, 8, "little"), Bytes.intToBytes(h2, 8, "little"));
}

/**
 * Return the 16-byte After Effects `Guid` for `data` (MurmurHash3 x64 128
 * with After Effects' {@link GUID_SEED | GUID_SEED}).
 */
export function aeGuid(data: Uint8Array): Uint8Array {
  return murmurhash3X64128(data, GUID_SEED);
}
