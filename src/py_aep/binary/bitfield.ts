/**
 * BitField descriptor for single-bit flags on raw byte fields.
 *
 * Usage::
 *
 *     \@define
 *     class MyChunk(Chunk):
 *         _flags: int = u1_field(repr=False)
 *
 *         my_flag = BitField("_flags", 3)  # bit 3 (no annotation)
 */

import { and, andNot, getattr, lshift, or } from "../../pyrt/index.ts";

/**
 * Descriptor mapping a single bit in a raw-byte attrs field to a bool.
 *
 * The descriptor has no type annotation on the class body, so attrs
 * ignores it (it stays as a class-level data descriptor, not a slot).
 * Unknown bits in the raw byte are preserved implicitly. `F` is the name of
 * the owner's raw-byte field.
 */
export class BitField<F extends string = string> {
  byte_field: F;
  mask: number;

  constructor(byteField: F, bit: number) {
    this.byte_field = byteField;
    this.mask = lshift(1, bit);
  }

  __get__(obj: Record<F, number>, objtype: Function | null = null): boolean {
    return and(getattr(obj, this.byte_field), this.mask) !== 0;
  }

  __set__(obj: Record<F, number>, value: boolean): void {
    const raw = getattr(obj, this.byte_field);
    if (value) {
      obj[this.byte_field] = or(raw, this.mask);
    } else {
      obj[this.byte_field] = andNot(raw, this.mask);
    }
  }
}
