/**
 * Property-level chunk types: tdsb, tdb4, cdat, tdum/tduM, and the Curves
 * effect's aRbp layout.
 *
 * TdsbChunk and Tdb4Chunk use `fmt_field()` with `BitField` descriptors.
 * CdatChunk and TdumChunk override `read()` / `write()` because they
 * have variable-length or context-dependent layouts.
 */

import {
  BytesIO,
  Factory,
  ValueError,
  b,
  bytes_,
  decode,
  define,
  descriptor,
  encode,
  field,
  floordiv,
  int,
  objectSetattr,
  pyAssert,
  struct,
  type IO,
} from "../../pyrt/index.ts";
import { readBytes, writeBytes } from "./bin_utils.ts";
import { BitField } from "./bitfield.ts";
import { Chunk, ContainerChunk, type ChunkReadKwargs } from "./chunk.ts";
import { FmtItem, boolField, bytesField, f8Field, itemsField, s4Field, u1Field, u2Field, u4Field } from "./fmt_field.ts";
import { register } from "./registry.ts";
import { Utf8Chunk, _StringChunkBase } from "./scalar_chunks.ts";
import { findByType } from "./utils.ts";

// ---------------------------------------------------------------------------
// tdsb - property flags (4 bytes, always inside LIST:tdbs at index 0)
// ---------------------------------------------------------------------------

/**
 * Property flags chunk (4 bytes).
 *
 * Bit-level flags are exposed via `BitField` descriptors that read/write
 * through the raw byte fields.
 */
export class TdsbChunk extends Chunk {
  declare chunk_type: string;
  /** RotoBezier flag for mask shapes (byte 0). 1 = enabled. */
  declare roto_bezier: boolean;
  declare _pad1: number;
  declare _lock_flags: number;
  declare _enable_flags: number;

  // -- Bit-level accessors (not attrs fields) ----------------------------
  /**
   * Set when a Scale or Mask Feather's dimensions are unlinked (its
   * constrain-proportions switch off). Clear on new layers; in AE-saved
   * projects only those two streams carry it, mostly on non-uniform
   * values.
   */
  declare ratio_unlinked: boolean;
  /**
   * Whether a separation leader's dimensions are split.
   *
   * Bit 3 of the lock byte, NOT bit 1 of the enable byte: that one is the
   * Timeline `hidden` flag, and it is also set on an UNSEPARATED position
   * that does not apply (an ambient light, an environment light). Checked
   * against every AE-exported `dimensionsSeparated` in the sample corpus -
   * the lock bit agrees 288/288, the enable bit 285/288.
   */
  declare dimensions_separated: boolean;
  declare enabled: boolean;
  /**
   * The stream is hidden in the Timeline because it does not apply to
   * the layer as it is: a 3D-only property on a 2D layer, an option of
   * another light type, a separated position's leader, an effect parameter
   * its plugin hides. AE refuses an expression on a hidden stream, and
   * recomputes the flag from the layer's state when it opens a project, so
   * it never changes what renders.
   */
  declare hidden: boolean;
}
define(TdsbChunk, {
  chunk_type: field({ default: "tdsb" }),
  roto_bezier: boolField(),
  _pad1: u1Field({ repr: false }),
  _lock_flags: u1Field({ repr: false }),
  _enable_flags: u1Field({ default: 1, repr: false }),
});
descriptor(TdsbChunk, "ratio_unlinked", new BitField("_lock_flags", 5));
descriptor(TdsbChunk, "dimensions_separated", new BitField("_lock_flags", 3));
descriptor(TdsbChunk, "enabled", new BitField("_enable_flags", 0));
descriptor(TdsbChunk, "hidden", new BitField("_enable_flags", 1));
register("tdsb")(TdsbChunk);

// ---------------------------------------------------------------------------
// tdb4 - property metadata (124 bytes, inside LIST:tdbs at index 2)
// ---------------------------------------------------------------------------
//
// Struct layout (big-endian, 124 bytes):
//   H   magic (0xdb99)
//   H   dimensions
//   B   pad1
//   B   spatial/static flags
//   H   pad2a
//   H   value_hint_type
//   B   value_hint_flag
//   B   can_vary_over_time flags
//   H   pad3a
//   H   time_base (0x7800 when has_time_base, else 0)
//   5d  unknown floats (threshold, aspect, 1.0, 1.0, 1.0)
//   B   pad4
//   B   no_value flags
//   B   pad5
//   B   type flags (vector, integer, color)
//   B   property_category
//   I   pad6a
//   H   pad6b
//   B   pad6c
//   B   animated
//   3s  pad
//   I   reserved_48
//   B   reserved_4c
//   B   reserved_4d
//   B   pad
//   B   spatial_marker
//   I   pad
//   4d  reserved_54 / 5c / 64 / 6c
//   H   pad9a
//   B   pad9b
//   B   expression_disabled flags
//   I   pad10

/**
 * Property metadata chunk (124 bytes).
 */
export class Tdb4Chunk extends Chunk {
  declare chunk_type: string;
  declare _magic: number;
  declare dimensions: number;
  declare _pad1: number;
  declare _spatial_static_flags: number;
  declare _pad2a: number;
  declare _value_hint_type: number;
  declare _value_hint_flag: number;
  declare _cvot_flags: number;
  /**
   * Keyframe time units per second for the OWNING LAYER.
   *
   * `layer_timebase(cdta.internal_timebase, layer.stretch / 100)` (see
   * `composition_chunks.layer_timebase`) - a full
   * 32-bit field, not a 16-bit one: a 300 % stretched layer at 24 fps stores
   * 73728 (0x00012000), which does not fit in two bytes (measured on AE 2026
   * across 50 / 101 / 150 / 300 / -150 % stretch).
   */
  declare _time_base: number;
  /**
   * Tolerance AE fits a spatial segment's arc-length spline to, as a
   * squared distance in the measured space: 1e-4 for a value stored in
   * pixels, 6.25e-12 for a point stored normalized to its layer.
   */
  declare _arc_accuracy: number;
  /**
   * X multiplier AE measures a motion path with (the first of four,
   * one per dimension): the containing comp's pixel aspect ratio for a
   * layer's spatial property, the layer's display aspect (width / height)
   * for a normalized point; 1.0 elsewhere.
   */
  declare pixel_aspect: number;
  declare _arc_multiplier_y: number;
  declare _arc_multiplier_z: number;
  declare _arc_multiplier_w: number;
  declare _pad4: number;
  declare _no_value_flags: number;
  declare _pad5: number;
  declare _type_flags: number;
  declare _property_category: number;
  declare _pad6a: number;
  declare _pad6b: number;
  declare _pad6c: number;
  declare animated: boolean;
  declare _pad_45: Uint8Array;
  /** A time in timebase units, or 0x80000000, in the samples. */
  declare _reserved_48: number;
  declare _reserved_4c: number;
  declare _reserved_4d: number;
  declare _pad_4e: number;
  /**
   * Byte 0x4F, the keyframe record's key flags: non-zero (bit 0) on a
   * spatial stream. Kept as the whole byte, not a `bool`: After Effects
   * writes 0x07 on the Transform effect's points in some production
   * projects, and coercing it to 1 changed those bytes as soon as their
   * layer was read.
   */
  declare _spatial_marker: number | boolean;
  declare _pad_50: number;
  // Four doubles: 0.0 in the samples, 0x5C / 0x6C sometimes 0.16666666667.
  declare _reserved_54: number;
  declare _reserved_5c: number;
  declare _reserved_64: number;
  declare _reserved_6c: number;
  declare _pad9a: number;
  declare _pad9b: number;
  declare _expr_flags: number;
  declare _pad10: number;

  // -- Bit-level accessors (not attrs fields) ----------------------------
  declare is_spatial: boolean;
  // `static` is a reserved word as a class member name, so the declaration
  // is quoted; `t.static` reads and writes it like any other property.
  declare "static": boolean;
  declare can_vary_over_time: boolean;
  declare no_value: boolean;
  declare vector: boolean;
  declare integer: boolean;
  declare color: boolean;
  declare expression_disabled: boolean;
  // AE's expression-present marker: the high byte of `_pad10` (0x01000000),
  // set whenever an expression Utf8 is present (independent of enabled/
  // disabled). AE rejects a file with the marker set but no expression Utf8
  // as "missing data in file".
  declare has_expression: boolean;

  get has_time_base(): boolean {
    return this._time_base !== 0;
  }
}
define(Tdb4Chunk, {
  chunk_type: field({ default: "tdb4" }),
  _magic: u2Field({ default: 0xdb99, repr: false }),
  dimensions: u2Field({ default: 1 }),
  _pad1: u1Field({ repr: false }),
  _spatial_static_flags: u1Field({ default: 1, repr: false }),
  _pad2a: u2Field({ repr: false }),
  _value_hint_type: u2Field({ repr: false }),
  _value_hint_flag: u1Field({ repr: false }),
  _cvot_flags: u1Field({ repr: false }),
  _time_base: u4Field({ repr: false }),
  _arc_accuracy: f8Field({ default: 0.0001, repr: false }),
  pixel_aspect: f8Field({ default: 1.0, repr: false }),
  _arc_multiplier_y: f8Field({ default: 1.0, repr: false }),
  _arc_multiplier_z: f8Field({ default: 1.0, repr: false }),
  _arc_multiplier_w: f8Field({ default: 1.0, repr: false }),
  _pad4: u1Field({ repr: false }),
  _no_value_flags: u1Field({ repr: false }),
  _pad5: u1Field({ repr: false }),
  _type_flags: u1Field({ repr: false }),
  _property_category: u1Field({ repr: false }),
  _pad6a: u4Field({ repr: false }),
  _pad6b: u2Field({ repr: false }),
  _pad6c: u1Field({ repr: false }),
  animated: boolField(),
  _pad_45: bytesField(3, { repr: false }),
  _reserved_48: u4Field({ repr: false }),
  _reserved_4c: u1Field({ repr: false }),
  _reserved_4d: u1Field({ repr: false }),
  _pad_4e: u1Field({ repr: false }),
  _spatial_marker: u1Field({ repr: false }),
  _pad_50: u4Field({ repr: false }),
  _reserved_54: f8Field({ repr: false }),
  _reserved_5c: f8Field({ repr: false }),
  _reserved_64: f8Field({ repr: false }),
  _reserved_6c: f8Field({ repr: false }),
  _pad9a: u2Field({ repr: false }),
  _pad9b: u1Field({ repr: false }),
  _expr_flags: u1Field({ repr: false }),
  _pad10: u4Field({ repr: false }),
});
descriptor(Tdb4Chunk, "is_spatial", new BitField("_spatial_static_flags", 3));
descriptor(Tdb4Chunk, "static", new BitField("_spatial_static_flags", 0));
descriptor(Tdb4Chunk, "can_vary_over_time", new BitField("_cvot_flags", 1));
descriptor(Tdb4Chunk, "no_value", new BitField("_no_value_flags", 0));
descriptor(Tdb4Chunk, "vector", new BitField("_type_flags", 3));
descriptor(Tdb4Chunk, "integer", new BitField("_type_flags", 2));
descriptor(Tdb4Chunk, "color", new BitField("_type_flags", 0));
descriptor(Tdb4Chunk, "expression_disabled", new BitField("_expr_flags", 0));
// AE's expression-present marker: the high byte of `_pad10` (0x01000000),
// set whenever an expression Utf8 is present (independent of enabled/
// disabled). AE rejects a file with the marker set but no expression Utf8
// as "missing data in file".
descriptor(Tdb4Chunk, "has_expression", new BitField("_pad10", 24));
register("tdb4")(Tdb4Chunk);

// ---------------------------------------------------------------------------
// tdb4 state-template helpers
//
// The animated helper encodes AE's animated field sets for the three
// property classes (color / spatial / plain numeric); the static helper
// encodes AE's animated -> static transition. They are free functions
// rather than methods because the business logic lives in the model layer;
// chunk classes are data containers.
//
// Both were measured on AE 2026 output across 1D / 2D / 3D / spatial /
// color properties; `_animate_tdb4` and `_static_tdb4` in property.py are
// the callers.
// ---------------------------------------------------------------------------

/**
 * Apply AE's animated-property tdb4 field set in-place.
 *
 * Sets the fields that differ between static and animated state for the
 * three property classes:
 * - color  (`color=True, spatial=False`)
 * - spatial (`color=False, spatial=True`)
 * - plain numeric / vector (`color=False, spatial=False`)
 *
 * @param t - The `Tdb4Chunk` to mutate.
 * @param kw - Keyword arguments:
 * - `color`: `true` for color properties.
 * - `spatial`: `true` for spatial (position / point) properties.
 */
export function tdb4ApplyAnimatedTemplate(t: Tdb4Chunk, kw: { color: boolean; spatial: boolean }): void {
  const { color, spatial } = kw;
  t.animated = true;
  t._cvot_flags = 0xff;
  t._value_hint_flag = 0xff;
  // Do NOT set _time_base here: it is the containing comp's
  // internal_timebase, which this layer cannot know. The caller stamps it
  // (Property._ensure_time_base). Hard-coding 24576 here wrote a 24 fps
  // timebase into every animated property of every non-24 fps comp.
  if (color) {
    t._property_category = 0x01;
    t._value_hint_type = 2;
    t._spatial_static_flags = 6;
    t._pad2a = 1;
  } else if (spatial) {
    t._property_category = 0x09;
    t._type_flags |= 0x08;
    t._value_hint_type = 0xffff;
    t._spatial_static_flags = 14;
    t._pad2a = 3;
  } else {
    t._property_category = 0x09;
    t._type_flags |= 0x08;
    t._value_hint_type = 1;
    t._spatial_static_flags = 0;
    t._pad2a = 0;
  }
}

/** Zero the keyframe record a static stream keeps (0x48-0x73), as AE does on every animated stream. */
export function tdb4ClearKeyframeRecord(t: Tdb4Chunk): void {
  t._reserved_48 = t._reserved_4c = t._reserved_4d = t._pad_4e = 0;
  t._spatial_marker = false;
  t._pad_50 = 0;
  t._reserved_54 = t._reserved_5c = t._reserved_64 = t._reserved_6c = 0;
}

/**
 * Apply AE's animated -\> static transition in-place (the last keyframe
 * was removed).
 *
 * AE sets the static bit, clears the animated flag, sets the record's
 * key-flag bit 0 (0x4F) when the stream flags have bit 1, and stores the
 * removed keyframe's in/out interpolation (0x4C/0x4D) and spatial flags
 * (0x50); every other byte keeps its animated value - category,
 * value-hint and cvot bytes and time base included (measured on AE 2026
 * for Position, Scale, Rotation, Opacity, an effect colour, a mask path
 * and a shape group's Position and Fill Color). Restoring the bytes of a
 * never-animated stream instead makes AE ignore the static value: a layer
 * or shape Position reads back at its default and a shape Fill Color
 * fails to evaluate.
 *
 * @param t - The `Tdb4Chunk` to mutate.
 * @param kw - Keyword arguments:
 * - `in_interpolation`: The removed keyframe's in interpolation code.
 * - `out_interpolation`: The removed keyframe's out interpolation code.
 * - `spatial_flags`: The removed keyframe's spatial flags (0 for a non-spatial keyframe).
 */
export function tdb4ApplyStaticTemplate(
  t: Tdb4Chunk,
  kw: { in_interpolation: number; out_interpolation: number; spatial_flags: number },
): void {
  const { in_interpolation, out_interpolation, spatial_flags } = kw;
  t.static = true;
  t.animated = false;
  t._spatial_marker = (t._spatial_static_flags & 0x02) !== 0;
  t._reserved_4c = in_interpolation;
  t._reserved_4d = out_interpolation;
  t._pad_50 = spatial_flags;
}

/**
 * Apply AE's active variable-font-axis tdb4 field set in-place.
 *
 * AE 2026 canon for an active `ADBE Text VF Axis` slot (byte-diffed
 * against the variable_font_axis_static fixture).
 *
 * @param t - The `Tdb4Chunk` to mutate.
 */
export function tdb4ApplyVfAxisTemplate(t: Tdb4Chunk): void {
  t.dimensions = 2;
  t._value_hint_type = 1;
  t._cvot_flags = 7;
  t._type_flags = 8;
  t._property_category = 9;
}

// ---------------------------------------------------------------------------
// cdat - property value doubles (variable length, optional LE for OTST)
// ---------------------------------------------------------------------------

/**
 * Property value chunk storing one or more doubles.
 *
 * Normally big-endian.  When `is_le` is true (inside an OTST
 * orientation list), values are stored little-endian.
 */
export class CdatChunk extends Chunk {
  declare chunk_type: string;
  declare values: number[];
  declare is_le: boolean;
  /**
   * Trailing bytes after the values: empty, or 4 zero bytes for the empty
   * cdat AE writes in a text-document `tdbs`. Settable at construction.
   */
  declare pad: Uint8Array;

  static read(
    fp: IO,
    size: number,
    kw: ChunkReadKwargs = {},
  ): CdatChunk {
    const { chunk_type = "", is_le = false } = kw;
    const count = floordiv(size, 8);
    if (count === 0) {
      const pad = size > 0 ? readBytes(fp, size) : b("");
      return new this({ chunk_type, is_le, pad });
    }
    const fmt = `${is_le ? "<" : ">"}${count}d`;
    const raw = readBytes(fp, count * 8);
    const vals = struct.unpack(fmt, raw);
    const rest = size - count * 8;
    const pad = rest > 0 ? readBytes(fp, rest) : b("");
    return new this({ chunk_type, values: vals, is_le, pad });
  }

  write(fp: IO): number {
    let written = 0;
    if (this.values?.length > 0) {
      const count = this.values.length;
      const fmt = `${this.is_le ? "<" : ">"}${count}d`;
      const raw = struct.pack(fmt, ...this.values);
      written += writeBytes(fp, raw);
    }
    if (this.pad?.length > 0) {
      written += writeBytes(fp, this.pad);
    }
    return written;
  }
}
define(CdatChunk, {
  chunk_type: field({ default: "cdat" }),
  values: field({ default: Factory(() => []) }),
  is_le: field({ default: false }),
  pad: field({ default: b("") }),
});
register("cdat")(CdatChunk);

// ---------------------------------------------------------------------------
// tdum / tduM - property min/max value (variable, context-dependent)
// ---------------------------------------------------------------------------

/**
 * Property min/max value chunk.
 *
 * Layout depends on sibling tdb4 flags:
 * - color: 4 x f4 (big-endian floats)
 * - integer with a 4-byte body: 1 x u4 (big-endian uint32)
 * - otherwise: N x f8 (big-endian doubles, N = size / 8). After Effects
 *   writes integer-flagged bounds as doubles too: every one of the 47652
 *   in the sample corpus is 8 bytes.
 */
export class TdumChunk extends Chunk {
  /** Stored values (floats for color/scalar, int cast to float for integer). */
  declare values: number[];
  declare is_color: boolean;
  declare is_integer: boolean;

  static read(
    fp: IO,
    size: number,
    kw: ChunkReadKwargs = {},
  ): TdumChunk {
    const { chunk_type = "", is_color = false } = kw;
    let { is_integer = false } = kw;
    const raw = readBytes(fp, size);
    let vals: number[];
    let trailing: Uint8Array;
    if (is_color) {
      vals = struct.unpack(">4f", raw.slice(0, 16));
      trailing = raw.slice(16);
    } else if (is_integer && size < 8) {
      const [v] = struct.unpack(">I", raw.slice(0, 4));
      vals = [v];
      trailing = raw.slice(4);
    } else {
      // Read as a u4, a double's high word turned 100.0 into 1079574528.
      is_integer = false;
      const count = floordiv(size, 8);
      vals = struct.unpack(`>${count}d`, raw.slice(0, count * 8));
      trailing = raw.slice(count * 8);
    }
    const instance = new this({
      chunk_type,
      values: vals,
      is_color,
      is_integer,
    });
    if (trailing?.length > 0) {
      objectSetattr(instance, "_trailing", trailing);
    }
    return instance;
  }

  write(fp: IO): number {
    let raw: Uint8Array;
    if (this.is_color) {
      raw = struct.pack(">4f", ...this.values);
    } else if (this.is_integer) {
      raw = struct.pack(">I", int(this.values[0]));
    } else {
      raw = struct.pack(`>${this.values.length}d`, ...this.values);
    }
    let written = writeBytes(fp, raw);
    if (this._trailing?.length > 0) {
      written += writeBytes(fp, this._trailing);
    }
    return written;
  }
}
define(TdumChunk, {
  values: field({ default: Factory(() => []) }),
  is_color: field({ default: false }),
  is_integer: field({ default: false }),
});
register("tdum", "tduM")(TdumChunk);

// ---------------------------------------------------------------------------
// otda - orientation keyframe data (N big-endian doubles)
// ---------------------------------------------------------------------------

/** Orientation keyframe data: N big-endian doubles (typically 3 for XYZ). */
export class OtdaChunk extends Chunk {
  declare chunk_type: string;
  declare values: number[];

  static read(fp: IO, size: number, kw: ChunkReadKwargs = {}): OtdaChunk {
    const { chunk_type = "" } = kw;
    const raw = readBytes(fp, size);
    const n = floordiv(size, 8);
    const vals = struct.unpack(`>${n}d`, raw.slice(0, n * 8));
    const trailing = raw.slice(n * 8);
    const instance = new this({ chunk_type, values: vals });
    if (trailing.length > 0) {
      objectSetattr(instance, "_trailing", trailing);
    }
    return instance;
  }

  write(fp: IO): number {
    const raw = struct.pack(`>${this.values.length}d`, ...this.values);
    let written = writeBytes(fp, raw);
    if (this._trailing?.length > 0) {
      written += writeBytes(fp, this._trailing);
    }
    return written;
  }
}
define(OtdaChunk, {
  chunk_type: field({ default: "otda" }),
  values: field({ default: Factory(() => []) }),
});
register("otda")(OtdaChunk);

// ---------------------------------------------------------------------------
// tdmn - match name (40 bytes, null-padded)
// ---------------------------------------------------------------------------

/** Fixed-width 40-byte null-padded match name chunk. */
export class TdmnChunk extends _StringChunkBase {
  declare chunk_type: string;
  static _ENCODING = "UTF-8";

  static read(fp: IO, size: number, kw: ChunkReadKwargs = {}): TdmnChunk {
    const { chunk_type = "" } = kw;
    const raw = readBytes(fp, size);
    return new this({ chunk_type, value: decode(bytes_.rstrip(raw, b("\x00")), "UTF-8") });
  }

  write(fp: IO): number {
    const encoded = encode(this.value, "UTF-8").slice(0, 40);
    const padded = bytes_.ljust(encoded, 40);
    return writeBytes(fp, padded);
  }
}
define(TdmnChunk, {
  chunk_type: field({ default: "tdmn" }),
});
register("tdmn")(TdmnChunk);

// Sentinel AE writes as the tdsn display name for unnamed properties;
// the name then resolves from the auto-name.
export const TDSN_SENTINEL = "-_0_/-";

/**
 * Display-name container (`tdsn`) wrapping a single `Utf8` child.
 *
 * AE writes the `-_0_/-` sentinel for unnamed properties; the display
 * name then resolves from the match name.
 */
export class TdsnChunk extends ContainerChunk {
  declare chunk_type: string;

  /** Build a tdsn wrapping `name`. */
  static new_(name = "", kw: { synthetic?: boolean } = {}): TdsnChunk {
    const { synthetic = false } = kw;
    return new this({
      chunks: [new Utf8Chunk({ value: name, synthetic })],
      synthetic,
    });
  }

  static _legacy_value(text: string): string {
    // An empty legacy name is an unnamed property: the name resolves from
    // the match name, as for the sentinel.
    return text || TDSN_SENTINEL;
  }

  static _legacy_string(value: string): string {
    // And an unnamed property is written back as the empty name.
    return value === TDSN_SENTINEL ? "" : value;
  }

  /**
   * The `Utf8` child holding the display name.
   *
   * @throws {@link ChunkNotFoundError} If the tdsn has no Utf8 child, so callers can degrade to the
   *   auto-name like any missing chunk.
   */
  get utf8(): Utf8Chunk {
    const chunk = findByType(this.chunks, "Utf8");
    pyAssert(chunk instanceof Utf8Chunk);
    return chunk;
  }
}
define(TdsnChunk, {
  chunk_type: field({ default: "tdsn" }),
});
register("tdsn")(TdsnChunk);

/**
 * Variable-font axis display-name container (`vfdn`) wrapping a
 * single `Utf8` child (e.g. `Font Axis Weight`).
 *
 * AE 26+ writes one after each active `ADBE Text VF Axis` slot's tdbs
 * inside a text animator's Properties group; the name comes from the
 * font's own axis name table. Structurally a `tdsn`; a missing Utf8
 * child degrades to the tag-derived name.
 */
export class VfdnChunk extends TdsnChunk {
  declare chunk_type: string;
}
define(VfdnChunk, {
  chunk_type: field({ default: "vfdn" }),
});
register("vfdn")(VfdnChunk);

// ---------------------------------------------------------------------------
// aRbp - the Curves effect's curves (ADBE CurvesCustom-0001)
// ---------------------------------------------------------------------------

export const _CURVES_SLOTS = 16;
export const _CURVES_RECORD_SIZE = 72;
/** The size of a Curves effect's aRbp, in bytes. */
export const CURVES_ARBP_SIZE = 4 + 5 * 256 + 5 * _CURVES_RECORD_SIZE;

/**
 * One channel's points in a Curves aRbp (72 bytes).
 *
 * 16 `(i16 x, i16 y)` point slots, input then output in 0..255, then a
 * `u32` count of the live slots (the ones past it hold stale points or
 * junk) and an `i32` selected point (-1 for none).
 */
export class CurvesRecordItem extends FmtItem {
  declare _point_slots: Uint8Array;
  declare count: number;
  declare selected: number;

  /** The live `(input, output)` points. */
  get points(): [number, number][] {
    const values = struct.unpack(`>${2 * _CURVES_SLOTS}h`, this._point_slots);
    const count = Math.min(this.count, _CURVES_SLOTS);
    return Array.from({ length: count }, (_, i): [number, number] => [values[2 * i], values[2 * i + 1]]);
  }
}
define(CurvesRecordItem, {
  _point_slots: bytesField(4 * _CURVES_SLOTS, { repr: false }),
  count: u4Field(),
  selected: s4Field(),
});

/**
 * The Curves effect's arbitrary data: an aRbp of 1644 big-endian bytes
 * in a LIST:aRbs beside the property's tdbs.
 *
 * - `u16` version (1), then `u16` mode: 1 when the curves are drawn with
 *   points, 0 when drawn with the pencil (the maps are then the curves and
 *   the points are stale).
 * - Five 256-entry `u8` maps, in the channel order RGB (the master), red,
 *   green, blue, alpha. With points, each is its curve rounded to the
 *   nearest level and clamped to 0..255; 8 bpc renders these maps.
 * - Five `CurvesRecordItem`s, in the same order.
 *
 * Not registered: an aRbp holds whatever arbitrary data its effect
 * defines, so the tree keeps the raw chunk (and its bytes) and this layout
 * is read from it on demand, by `from_arbp`.
 */
export class CurvesArbpChunk extends Chunk {
  declare chunk_type: string;
  declare version: number;
  declare mode: number;
  declare maps: Uint8Array;
  declare records: CurvesRecordItem[];

  /**
   * Read a raw aRbp chunk's data as the Curves layout.
   *
   * @throws {@link ValueError} If the data is not 1644 bytes long.
   */
  static from_arbp(arbp: Chunk): CurvesArbpChunk {
    if (arbp.data.length !== CURVES_ARBP_SIZE) {
      throw new ValueError(`a Curves aRbp is ${CURVES_ARBP_SIZE} bytes, not ${arbp.data.length}`);
    }
    const chunk = this.read(new BytesIO(arbp.data), arbp.data.length, { chunk_type: "aRbp" });
    pyAssert(chunk instanceof this);
    return chunk;
  }
}
define(CurvesArbpChunk, {
  chunk_type: field({ default: "aRbp" }),
  version: u2Field(),
  mode: u2Field(),
  maps: bytesField(5 * 256, { repr: false }),
  records: itemsField(CurvesRecordItem, _CURVES_RECORD_SIZE),
});
