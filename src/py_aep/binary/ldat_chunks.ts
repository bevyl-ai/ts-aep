/**
 * Keyframe system chunks (lhd3, ldat) and their item types.
 */

import {
  AttrsBase,
  Factory,
  Bytes,
  concat,
  define,
  descriptor,
  defineEnum,
  assert,
  struct,
  compositeKey,
  ValueError,
} from "../../pyrt/index.ts";
import type { EnumValue, ByteStream } from "../../pyrt/index.ts";
import { readBytes, writeBytes } from "./bin_utils.ts";
import { BitField } from "./bitfield.ts";
import { Chunk, type ChunkReadKwargs } from "./chunk.ts";
import { FmtItem, bytesField, f4Field, f8Field, u1Field, u4Field, u8Field } from "./fmt_field.ts";
import { register } from "./registry.ts";
import { OutputModuleSettingsItem, RenderSettingsItem } from "./render_chunks.ts";

// ---------------------------------------------------------------------------
// LdatItemType enum
// ---------------------------------------------------------------------------

/** Keyframe / list data item type, derived from lhd3 raw type + size. */
export const LdatItemType = defineEnum("LdatItemType", {
  unknown: 0,
  color: 1,
  three_d_spatial: 2,
  three_d: 3,
  two_d_spatial: 4,
  two_d: 5,
  one_d: 6,
  no_value: 7,
  // 8 is unused
  orientation: 9,
  shape: 10,
  marker: 11,
  lrdr: 12,
  litm: 13,
  gide: 14,
});
export type LdatItemType = EnumValue<typeof LdatItemType>;

// Dispatch table: (item_type_raw, item_size) -> LdatItemType
const _ITEM_TYPE_MAP = new Map<string, LdatItemType>([
  [compositeKey(1, 2246), LdatItemType.lrdr],
  [compositeKey(1, 128), LdatItemType.litm],
  [compositeKey(2, 16), LdatItemType.gide],
  [compositeKey(4, 152), LdatItemType.color],
  [compositeKey(4, 128), LdatItemType.three_d],
  [compositeKey(4, 104), LdatItemType.two_d_spatial],
  [compositeKey(4, 88), LdatItemType.two_d],
  [compositeKey(4, 80), LdatItemType.orientation],
  [compositeKey(4, 64), LdatItemType.no_value],
  [compositeKey(4, 48), LdatItemType.one_d],
  [compositeKey(4, 16), LdatItemType.marker],
  [compositeKey(4, 8), LdatItemType.shape],
]);

// num_value for multi-dimensional / spatial keyframe types
const _NUM_VALUE = new Map<number, number>([
  [LdatItemType.three_d, 3],
  [LdatItemType.three_d_spatial, 3],
  [LdatItemType.two_d, 2],
  [LdatItemType.two_d_spatial, 2],
  [LdatItemType.one_d, 1],
]);

// ---------------------------------------------------------------------------
// Lhd3Chunk - keyframe list header
// ---------------------------------------------------------------------------

/**
 * Keyframe / list header. Stores item count, size, and raw type.
 *
 * The three `u4` counters after `itemTypeRaw` (`_countB`,
 * `_counterA`, `_counterB`) are opaque values AE maintains per list.
 * Their meaning is list-type dependent: for `LIST:LRdr` they track the
 * item count (with a floor of 1 when empty), but for `LIST:Gide` they
 * do not - an empty guide list seeds them to `(1, 1, 2)` and three
 * guides yields `(2, 1, 4)`, so they are neither a copy of `count` nor
 * a simple version/id derived from it. They are kept private and set
 * explicitly by mutation code rather than computed from `count`.
 */
export class Lhd3Chunk extends Chunk {
  declare chunkType: string;
  declare _prefix: Uint8Array;
  declare count: number;
  declare _countB: number;
  declare itemSize: number;
  declare _gap2: Uint8Array;
  declare itemTypeRaw: number;
  declare _counterA: number;
  declare _counterB: number;
  declare _trailingPad: Uint8Array | null;

  /** Effective item type derived from raw type and item size. */
  get itemType(): LdatItemType {
    return _ITEM_TYPE_MAP.get(compositeKey(this.itemTypeRaw, this.itemSize)) ?? LdatItemType.unknown;
  }
}
define(Lhd3Chunk, {
  chunkType: { default: "lhd3" },
  _prefix: bytesField(8, { default: Uint8Array.of(0x00, 0xd0, 0x0b, 0xee, 0x00, 0x00, 0x00, 0x00), repr: false }),
  count: u4Field(),
  _countB: u4Field({ default: 1, repr: false }),
  itemSize: u4Field(),
  _gap2: bytesField(3, { default: new Uint8Array(3), repr: false }),
  itemTypeRaw: u1Field(),
  _counterA: u4Field({ default: 1, repr: false }),
  _counterB: u4Field({ default: 2, repr: false }),
  _trailingPad: bytesField(20, { default: Bytes.repeat(new Uint8Array(1), 20), optional: true, repr: false }),
});
register("lhd3")(Lhd3Chunk);

// Block sizes for the lhd3 capacity counters, per list-container type. AE
// keeps a "block allocation" header alongside `count` that it validates on
// load; mutation code must keep it in sync or AE reports "Invalid read length".
// Verified against AE-authored samples (scan over 530 sample files):
//   keyframes (tdbs/list): block 4
//   guides (Gide/list): block 2
//   render-queue items (LRdr/list) and output modules (LItm/list): block 1
export const LHD3_BLOCK_KEYFRAMES = 4;
export const LHD3_BLOCK_GUIDES = 2;
export const LHD3_BLOCK_SINGLE = 1;

/**
 * Set `lhd3.count` and recompute the capacity counters from it.
 *
 * AE keeps `_count_b = ceil(count / block)` (minimum 1), `_counter_b = _count_b * block`, and `_counter_a = _count_b` for single-item blocks
 * (render queue / output modules) else 1. Count and counters are set in
 * one step because AE validates them together on load; a count written
 * without the derived counters makes AE reject the file.
 */
export function setLhd3Count(lhd3: Lhd3Chunk, count: number, block: number): void {
  lhd3.count = count;
  const n = Math.max(1, Math.ceil(count / block));
  lhd3._countB = n;
  lhd3._counterB = n * block;
  lhd3._counterA = block === 1 ? n : 1;
}

// ---------------------------------------------------------------------------
// Simple item types (not Chunk subclasses)
// ---------------------------------------------------------------------------

/** A single shape vertex (x, y) in big-endian float32. */
export class ShapePoint extends FmtItem {
  declare x: number;
  declare y: number;
}
define(ShapePoint, {
  x: f4Field(),
  y: f4Field(),
});

/** A single composition guide (ruler line). */
export class GuideItem extends FmtItem {
  declare orientationType: number;
  declare positionType: number;
  declare position: number;
}
define(GuideItem, {
  orientationType: u4Field(),
  positionType: u4Field(),
  position: f8Field(),
});

/** Guide container data chunk (8 bytes, all zeros). */
export class GdtaChunk extends Chunk {
  declare chunkType: string;
  declare data: Uint8Array;
}
define(GdtaChunk, {
  chunkType: { default: "gdta" },
  data: { default: Bytes.repeat(new Uint8Array(1), 8) },
});
register("gdta")(GdtaChunk);

// ---------------------------------------------------------------------------
// Keyframe data types
// ---------------------------------------------------------------------------

/** Keyframe data for valueless properties (e.g. paint stroke). */
export class KfNoValue extends FmtItem {
  declare _unknown1: number | bigint;
  declare _unknown2: number;
  declare inSpeed: number;
  declare inInfluence: number;
  declare outSpeed: number;
  declare outInfluence: number;
}
define(KfNoValue, {
  _unknown1: u8Field(),
  _unknown2: f8Field(),
  inSpeed: f8Field(),
  inInfluence: f8Field(),
  outSpeed: f8Field(),
  outInfluence: f8Field(),
});

/**
 * Keyframe data for color properties: alpha, red, green, blue in
 * 0-255 units (the model reorders them to RGBA 0-1).
 */
export class KfColor extends FmtItem {
  declare _unknown1: number | bigint;
  declare _unknown2: number;
  declare inSpeed: number;
  declare inInfluence: number;
  declare outSpeed: number;
  declare outInfluence: number;
  declare a: number;
  declare r: number;
  declare g: number;
  declare b: number;
  declare _uf0: number;
  declare _uf1: number;
  declare _uf2: number;
  declare _uf3: number;
  declare _uf4: number;
  declare _uf5: number;
  declare _uf6: number;
  declare _uf7: number;

  /** The four channels in storage order: alpha, red, green, blue. */
  get value(): number[] {
    return [this.a, this.r, this.g, this.b];
  }

  set value(v: number[]) {
    if (v.length > 4) throw new ValueError("too many values to unpack (expected 4)");
    if (v.length < 4) throw new ValueError(`not enough values to unpack (expected 4, got ${v.length})`);
    [this.a, this.r, this.g, this.b] = v;
  }
}
define(KfColor, {
  _unknown1: u8Field(),
  _unknown2: f8Field(),
  inSpeed: f8Field(),
  inInfluence: f8Field(),
  outSpeed: f8Field(),
  outInfluence: f8Field(),
  a: f8Field(),
  r: f8Field(),
  g: f8Field(),
  b: f8Field(),
  _uf0: f8Field(),
  _uf1: f8Field(),
  _uf2: f8Field(),
  _uf3: f8Field(),
  _uf4: f8Field(),
  _uf5: f8Field(),
  _uf6: f8Field(),
  _uf7: f8Field(),
});

/** Keyframe data for non-spatial multi-dimensional properties. */
export class KfMultiDimensional extends AttrsBase {
  declare value: number[];
  declare inSpeed: number[];
  declare inInfluence: number[];
  declare outSpeed: number[];
  declare outInfluence: number[];

  static frombytes(data: Uint8Array, kw: { numValue: number }): KfMultiDimensional {
    const { numValue } = kw;
    const count = 5 * numValue;
    const vals = struct.unpack(">" + "d".repeat(count), data.slice(0, count * 8));
    const n = numValue;
    return new this({
      value: vals.slice(0, n),
      inSpeed: vals.slice(n, 2 * n),
      inInfluence: vals.slice(2 * n, 3 * n),
      outSpeed: vals.slice(3 * n, 4 * n),
      outInfluence: vals.slice(4 * n, 5 * n),
    });
  }

  tobytes(): Uint8Array {
    const allVals = [...this.value, ...this.inSpeed, ...this.inInfluence, ...this.outSpeed, ...this.outInfluence];
    return struct.pack(">" + "d".repeat(allVals.length), ...allVals);
  }
}
define(KfMultiDimensional, {
  value: { default: Factory(() => []) },
  inSpeed: { default: Factory(() => []) },
  inInfluence: { default: Factory(() => []) },
  outSpeed: { default: Factory(() => []) },
  outInfluence: { default: Factory(() => []) },
});

/** Keyframe data for spatial properties (position, anchor point). */
export class KfPosition extends AttrsBase {
  declare _pad1: Uint8Array;
  declare _spatialFlags: number;
  declare _pad2: Uint8Array;
  declare _unknownHeader: number;
  declare inSpeed: number;
  declare inInfluence: number;
  declare outSpeed: number;
  declare outInfluence: number;
  declare value: number[];
  declare inSpatialTangents: number[];
  declare outSpatialTangents: number[];
  declare spatialAutoBezier: boolean;
  declare spatialContinuous: boolean;

  static frombytes(data: Uint8Array, kw: { numValue: number }): KfPosition {
    const { numValue } = kw;
    const pad1 = data.slice(0, 3);
    const flags = data[3];
    const pad2 = data.slice(4, 8);
    // 5 fixed doubles + 3*num_value array doubles
    const totalDoubles = 5 + 3 * numValue;
    const vals = struct.unpack(">" + "d".repeat(totalDoubles), data.slice(8, 8 + totalDoubles * 8));
    return new this({
      pad1,
      spatialFlags: flags,
      pad2,
      unknownHeader: vals[0],
      inSpeed: vals[1],
      inInfluence: vals[2],
      outSpeed: vals[3],
      outInfluence: vals[4],
      value: vals.slice(5, 5 + numValue),
      inSpatialTangents: vals.slice(5 + numValue, 5 + 2 * numValue),
      outSpatialTangents: vals.slice(5 + 2 * numValue, 5 + 3 * numValue),
    });
  }

  tobytes(): Uint8Array {
    const allVals = [
      this._unknownHeader,
      this.inSpeed,
      this.inInfluence,
      this.outSpeed,
      this.outInfluence,
      ...this.value,
      ...this.inSpatialTangents,
      ...this.outSpatialTangents,
    ];
    return concat(
      this._pad1,
      struct.pack(">B", this._spatialFlags),
      this._pad2,
      struct.pack(">" + "d".repeat(allVals.length), ...allVals),
    );
  }

  static {
    descriptor(this, "spatialAutoBezier", new BitField("_spatialFlags", 1));
    descriptor(this, "spatialContinuous", new BitField("_spatialFlags", 0));
  }
}
define(KfPosition, {
  _pad1: { default: new Uint8Array(3) },
  _spatialFlags: { default: 0 },
  _pad2: { default: new Uint8Array(4) },
  _unknownHeader: { default: 0.0 },
  inSpeed: { default: 0.0 },
  inInfluence: { default: 0.0 },
  outSpeed: { default: 0.0 },
  outInfluence: { default: 0.0 },
  value: { default: Factory(() => []) },
  inSpatialTangents: { default: Factory(() => []) },
  outSpatialTangents: { default: Factory(() => []) },
});

/**
 * An `LdatItem` payload: the `Kf*` body its item type selects, or the raw
 * bytes of a marker / unknown item. Narrow with `in` or `instanceof`.
 */
export type KfData = KfNoValue | KfColor | KfPosition | KfMultiDimensional | Uint8Array;

// ---------------------------------------------------------------------------
// LdatItem - generic keyframe with header + typed payload
// ---------------------------------------------------------------------------

/**
 * A single keyframe item with 8-byte header and typed payload.
 *
 * `timeUnits` is the keyframe time as a signed 32-bit count of the
 * comp's `internalTimebase` units per second (e.g. 24576 for 24 fps;
 * measured on AE 2026 keyframes up to 10000 s).
 *
 * Header bytes 6-7 are one big-endian word of key flags: bits 3-5 are
 * the temporal continuous / auto-bezier / roving flags and bits 6-10 the
 * label (After Effects stores labels 1 / 5 / 16 as `00 40` / `01 40` /
 * `04 00`); the other bits are preserved as read.
 */
export class LdatItem extends AttrsBase {
  declare timeUnits: number;
  declare inInterpolationType: number;
  declare outInterpolationType: number;
  declare _keyFlags: number;
  declare kfData: KfData;
  declare _trailing: Uint8Array;
  declare roving: boolean;
  declare temporalAutoBezier: boolean;
  declare temporalContinuous: boolean;

  /** Label color index (0-16), bits 6-10 of the key flags. */
  get label(): number {
    return (this._keyFlags >> 6) & 0x1f;
  }

  set label(value: number) {
    this._keyFlags = (this._keyFlags & ~(0x1f << 6)) | ((value & 0x1f) << 6);
  }

  static frombytes(data: Uint8Array, kw: { itemType: LdatItemType }): LdatItem {
    const { itemType } = kw;
    // 8-byte header
    const [timeUnits, inInterp, outInterp, keyFlags] = struct.unpack(">iBBH", data.slice(0, 8));

    const payload = data.slice(8);
    const numValue = _NUM_VALUE.get(itemType) ?? null;
    let kfData: KfData;
    let trailing: Uint8Array;

    if (itemType === LdatItemType.color) {
      kfData = KfColor.frombytes(payload);
      trailing = payload.slice(144);
    } else if (itemType === LdatItemType.no_value || itemType === LdatItemType.orientation) {
      // An orientation keyframe keeps its angles in the sibling
      // `otky` container, so its item carries the same valueless
      // 48-byte ease prefix as a shape or gradient key - measured on
      // AE 2026: the nine doubles read 0, out-segment duration, in
      // speed, in influence, out speed, out influence, then padding.
      // Reading it as a 1-D value item shifted every ease field by
      // one slot, so `in/out_temporal_ease` reported the duration as
      // a speed and lost the influence entirely.
      kfData = KfNoValue.frombytes(payload);
      trailing = payload.slice(48);
    } else if (itemType === LdatItemType.three_d_spatial || itemType === LdatItemType.two_d_spatial) {
      assert(numValue != null);
      kfData = KfPosition.frombytes(payload, { numValue });
      // prefix(8) + fixed_doubles(5*8) + arrays(3*num_value*8)
      const expected = 8 + 5 * 8 + 3 * numValue * 8;
      trailing = payload.slice(expected);
    } else if (numValue != null) {
      // three_d, two_d, one_d
      kfData = KfMultiDimensional.frombytes(payload, { numValue });
      const expected = 5 * numValue * 8;
      trailing = payload.slice(expected);
    } else {
      // marker, unknown - raw bytes
      kfData = payload;
      trailing = new Uint8Array();
    }

    return new this({
      timeUnits,
      inInterpolationType: inInterp,
      outInterpolationType: outInterp,
      keyFlags,
      kfData,
      trailing,
    });
  }

  tobytes(): Uint8Array {
    const header = struct.pack(
      ">iBBH",
      this.timeUnits,
      this.inInterpolationType,
      this.outInterpolationType,
      this._keyFlags,
    );
    let payload: Uint8Array;
    if (this.kfData instanceof Uint8Array) {
      payload = this.kfData;
    } else {
      payload = this.kfData.tobytes();
    }
    return concat(header, payload, this._trailing);
  }

  static {
    descriptor(this, "roving", new BitField("_keyFlags", 5));
    descriptor(this, "temporalAutoBezier", new BitField("_keyFlags", 4));
    descriptor(this, "temporalContinuous", new BitField("_keyFlags", 3));
  }
}
define(LdatItem, {
  timeUnits: { default: 0 },
  inInterpolationType: { default: 0 },
  outInterpolationType: { default: 0 },
  _keyFlags: { default: 0 },
  kfData: { default: new Uint8Array() },
  _trailing: { default: new Uint8Array() },
});

// ---------------------------------------------------------------------------
// LdatChunk - registered chunk
// ---------------------------------------------------------------------------

/** Dispatch item reading by type. */
function _readItem(data: Uint8Array, itemType: LdatItemType): FmtItem | LdatItem {
  if (itemType === LdatItemType.lrdr) return RenderSettingsItem.frombytes(data);
  if (itemType === LdatItemType.litm) return OutputModuleSettingsItem.frombytes(data);
  if (itemType === LdatItemType.shape) return ShapePoint.frombytes(data);
  if (itemType === LdatItemType.gide) return GuideItem.frombytes(data);
  return LdatItem.frombytes(data, { itemType });
}

/** Keyframe / shape / settings data items. */
export class LdatChunk extends Chunk {
  declare chunkType: string;
  declare items: any[];
  declare itemType: LdatItemType;
  declare itemSize: number;

  static read(fp: ByteStream, size: number, kw: ChunkReadKwargs = {}): LdatChunk {
    let { chunkType = "", itemType = LdatItemType.unknown, itemSize = 0, count = 0, isSpatial = false } = kw;
    // Spatial promotion: three_d -> three_d_spatial
    if (itemType === LdatItemType.three_d && isSpatial) {
      itemType = LdatItemType.three_d_spatial;
    }

    if (itemSize === 0 || count === 0) {
      const data = readBytes(fp, size);
      return new this({
        chunkType,
        data,
        itemType,
        itemSize,
      });
    }
    const items: (FmtItem | LdatItem)[] = [];
    for (let i = 0, n = count; i < n; i++) {
      const itemData = readBytes(fp, itemSize);
      items.push(_readItem(itemData, itemType));
    }
    const remaining = size - count * itemSize;
    const trailing = remaining > 0 ? readBytes(fp, remaining) : new Uint8Array();
    const instance = new this({
      chunkType,
      items,
      itemType,
      itemSize,
    });
    if (trailing?.length > 0) {
      instance._trailing = trailing;
    }
    return instance;
  }

  write(fp: ByteStream): number {
    if (!this.items?.length) {
      return writeBytes(fp, this.data);
    }
    let written = 0;
    for (const item of this.items) {
      if (item instanceof Uint8Array) {
        written += writeBytes(fp, item);
      } else {
        written += writeBytes(fp, item.tobytes());
      }
    }
    if (this._trailing?.length > 0) {
      written += writeBytes(fp, this._trailing);
    }
    return written;
  }
}
define(LdatChunk, {
  chunkType: { default: "ldat" },
  items: { default: Factory(() => []) },
  itemType: { default: LdatItemType.unknown },
  itemSize: { default: 0 },
});
register("ldat")(LdatChunk);
