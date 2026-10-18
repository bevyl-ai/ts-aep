// `fractions.Fraction`, exact over bigint. `numerator` / `denominator`
// come back as numbers (py_aep only ever stores them in 32-bit fields).

import { ValueError, ZeroDivisionError } from "./errors.ts";
import { floatAsRatio } from "./num.ts";

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
}

export class Fraction {
  readonly n: bigint;
  readonly d: bigint;

  constructor(numerator: number | bigint | Fraction = 0, denominator?: number | bigint) {
    if (numerator instanceof Fraction) {
      this.n = numerator.n;
      this.d = numerator.d;
      return;
    }
    let n: bigint;
    let d: bigint;
    if (denominator === undefined) {
      if (typeof numerator === "bigint") [n, d] = [numerator, 1n];
      else if (Number.isInteger(numerator)) [n, d] = [BigInt(numerator), 1n];
      else {
        if (!Number.isFinite(numerator)) throw new ValueError(`cannot convert ${numerator} to Fraction`);
        [n, d] = floatAsRatio(numerator);
      }
    } else {
      n = BigInt(numerator);
      d = BigInt(denominator);
    }
    if (d === 0n) throw new ZeroDivisionError(`Fraction(${n}, 0)`);
    const g = gcd(n, d);
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    this.n = n / g;
    this.d = d / g;
  }

  get numerator(): number {
    return Number(this.n);
  }

  get denominator(): number {
    return Number(this.d);
  }

  /** CPython's `Fraction.limit_denominator`. */
  limitDenominator(maxDenominator: number | bigint = 1000000): Fraction {
    const max = BigInt(maxDenominator);
    if (max < 1n) throw new ValueError("max_denominator should be at least 1");
    if (this.d <= max) return new Fraction(this.n, this.d);
    let [p0, q0, p1, q1] = [0n, 1n, 1n, 0n];
    let [n, d] = [this.n, this.d];
    for (;;) {
      const a = n / d - (n % d !== 0n && n < 0n ? 1n : 0n);
      const q2 = q0 + a * q1;
      if (q2 > max) break;
      [p0, q0, p1, q1] = [p1, q1, p0 + a * p1, q2];
      [n, d] = [d, n - a * d];
    }
    const k = (max - q0) / q1;
    // CPython 3.12: bound2 = p1/q1 unless bound1 is strictly closer.
    if (2n * d * (q0 + k * q1) <= this.d) return new Fraction(p1, q1);
    return new Fraction(p0 + k * p1, q0 + k * q1);
  }

  valueOf(): number {
    return Number(this.n) / Number(this.d);
  }

  toString(): string {
    return this.d === 1n ? `${this.n}` : `${this.n}/${this.d}`;
  }
}
