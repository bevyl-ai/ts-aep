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

import { getMember } from "../../pyrt/index.ts";

/**
 * Descriptor mapping a single bit in a raw-byte attrs field to a bool.
 *
 * The descriptor has no type annotation on the class body, so attrs
 * ignores it (it stays as a class-level data descriptor, not a slot).
 * Unknown bits in the raw byte are preserved implicitly. `F` is the name of
 * the owner's raw-byte field.
 */
export class BitField<F extends string = string> {
  byteField: F;
  mask: number;

  constructor(byteField: F, bit: number) {
    this.byteField = byteField;
    this.mask = 1 << bit;
  }

  get(obj: Record<F, number>, _objtype: Function | null = null): boolean {
    return (getMember(obj, this.byteField) & this.mask) !== 0;
  }

  set(obj: Record<F, number>, value: boolean): void {
    const raw = getMember(obj, this.byteField);
    if (value) {
      obj[this.byteField] = raw | this.mask;
    } else {
      obj[this.byteField] = raw & ~this.mask;
    }
  }
}
