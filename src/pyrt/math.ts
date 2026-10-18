// `math` functions whose JS counterparts round differently from CPython.

const _f64 = new Float64Array(1);
const _u64 = new BigUint64Array(_f64.buffer);

/** `math.frexp(x)[1]` for a finite non-zero `x`. */
function frexpExp(x: number): number {
  _f64[0] = x;
  const e = Number((_u64[0] >> 52n) & 0x7ffn);
  if (e !== 0) return e - 1022;
  // Subnormal: the exponent of the leading set bit.
  const frac = _u64[0] & ((1n << 52n) - 1n);
  return frac.toString(2).length - 1074;
}

/** `ldexp(1.0, e)` exactly (`e` in [-1074, 1023]). */
function pow2(e: number): number {
  if (e >= -1022) _u64[0] = BigInt(e + 1023) << 52n;
  else _u64[0] = 1n << BigInt(e + 1074);
  return _f64[0];
}

/** Exact `(mantissa, exponent)` with `x == mantissa * 2**exponent`. */
function exact(x: number): [bigint, number] {
  _f64[0] = x;
  const bits = _u64[0];
  const sign = bits >> 63n ? -1n : 1n;
  const e = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & ((1n << 52n) - 1n);
  return e === 0 ? [sign * frac, -1074] : [sign * (frac | (1n << 52n)), e - 1075];
}

/** The double nearest `m * 2**e` (ties to even), for an exact BigInt `m`. */
function roundExact(m: bigint, e: number): number {
  if (m === 0n) return 0;
  const neg = m < 0n;
  let q = neg ? -m : m;
  const lead = q.toString(2).length - 1 + e;
  if (lead > 1023) return neg ? -Infinity : Infinity;
  // Exponent of the result's last mantissa bit (subnormals stop at 2**-1074).
  let lsb = Math.max(lead - 52, -1074);
  if (lsb > e) {
    const shift = BigInt(lsb - e);
    const rem = q & ((1n << shift) - 1n);
    q >>= shift;
    const half = 1n << (shift - 1n);
    if (rem > half || (rem === half && (q & 1n) === 1n)) q += 1n;
  } else {
    lsb = e;
  }
  // q has at most 54 bits and lsb is in [-1074, 1023], so the product is exact (or overflows like C).
  const r = Number(q) * pow2(lsb);
  return neg ? -r : r;
}

/** C `fma(x, y, z)`: `x * y + z` with a single rounding. */
function fma(x: number, y: number, z: number): number {
  const [mx, ex] = exact(x);
  const [my, ey] = exact(y);
  const [mz, ez] = exact(z);
  const ep = ex + ey;
  const e = Math.min(ep, ez);
  const sum = ((mx * my) << BigInt(ep - e)) + (mz << BigInt(ez - e));
  if (sum === 0n) return x * y + z;
  return roundExact(sum, e);
}

/** Error-free `x * y` (`dlMul`): `[hi, lo]` with `hi + lo == x * y`. */
function dlMul(x: number, y: number): [number, number] {
  const z = x * y;
  // Dekker's product equals fma(x, y, -z) whenever no partial product underflows.
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  if (ax >= 2 ** -480 && ay >= 2 ** -480 && Number.isFinite(z)) {
    const c = 134217729; // 2**27 + 1
    let t = c * x;
    const xh = t - (t - x);
    const xl = x - xh;
    t = c * y;
    const yh = t - (t - y);
    const yl = y - yh;
    return [z, xh * yh - z + xh * yl + xl * yh + xl * yl];
  }
  return [z, fma(x, y, -z)];
}

const DBL_MIN = 2.2250738585072014e-308;

/** CPython 3.12 `vectorNorm` (Modules/mathmodule.c) over |coordinates|. */
function vectorNorm(vec: number[], max: number, foundNan: boolean): number {
  if (max === Infinity) return max;
  if (foundNan) return NaN;
  if (max === 0.0 || vec.length <= 1) return max;
  const maxE = frexpExp(max);
  if (maxE < -1023) {
    // When max_e < -1023, ldexp(1.0, -max_e) would overflow.
    return (
      DBL_MIN *
      vectorNorm(
        vec.map((v) => v / DBL_MIN),
        max / DBL_MIN,
        foundNan,
      )
    );
  }
  const scale = pow2(-maxE);
  let csum = 1.0;
  let frac1 = 0.0;
  let frac2 = 0.0;
  for (const v of vec) {
    const x = v * scale; // lossless scaling
    const [hi, lo] = dlMul(x, x); // lossless squaring
    const s = csum + hi; // dl_fast_sum(csum, hi), lossless
    const sLo = hi - (s - csum);
    csum = s;
    frac1 += lo;
    frac2 += sLo;
  }
  let h = Math.sqrt(csum - 1.0 + (frac1 + frac2));
  const [phi, plo] = dlMul(-h, h);
  const s = csum + phi;
  const sLo = phi - (s - csum);
  csum = s;
  frac1 += plo;
  frac2 += sLo;
  const x = csum - 1.0 + (frac1 + frac2);
  h += x / (2.0 * h); // differential correction
  return h / scale;
}

/** `math.hypot(*coordinates)` with CPython 3.12's rounding (not `Math.hypot`'s). */
export function hypot(...coordinates: number[]): number {
  let max = 0.0;
  let foundNan = false;
  const vec = coordinates.map((c) => {
    const x = Math.abs(+c);
    if (Number.isNaN(x)) foundNan = true;
    else if (x > max) max = x;
    return x;
  });
  return vectorNorm(vec, max, foundNan);
}
