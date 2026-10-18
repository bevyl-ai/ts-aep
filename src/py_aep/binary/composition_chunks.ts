/**
 * Composition chunk type: cdta (204 bytes).
 *
 * Uses `fmt_field()` for all fixed-layout fields, `BitField` descriptors
 * for two flag bytes and sentinel-aware helpers for work-area end
 * interpretation.
 */

import { define, descriptor, divmod, field, floordiv, Fraction, round } from "../../pyrt/index.ts";
import { toDividendDivisor, toFixed1616, toFloat32Ratio } from "./bin_utils.ts";
import { BitField } from "./bitfield.ts";
import { Chunk } from "./chunk.ts";
import { FmtItem, bytesField, s4Field, u1Field, u2Field, u4Field } from "./fmt_field.ts";
import { register } from "./registry.ts";

// The largest internal timebase AE picks a units-per-frame for: 99.99 fps
// gets 39996 (400 units a frame), 78.125 fps 20000 rather than 40000.
export const _TIMEBASE_LIMIT = 40000;

// The finest timebase AE counts a composition's or a layer's time in.
export const _MAX_TIMEBASE = 115200;

/**
 * `work_area_end_dividend` of a work area that runs to the end of the
 * composition.
 */
export const WORK_AREA_TO_END = 0xffffffff;

// NOTE(port): the Fraction shim has no operators; these exact bigint n/d helpers (reduced by the constructor) equal Python's Fraction *, /, <, >, floor in frame_grid.
export function fracMul(a: Fraction, b: Fraction): Fraction {
  return new Fraction(a.n * b.n, a.d * b.d);
}

export function fracDiv(a: Fraction, k: number): Fraction {
  return new Fraction(a.n, a.d * BigInt(k));
}

export function fracLt(a: Fraction, k: number): boolean {
  return a.n < BigInt(k) * a.d;
}

export function fracGt(a: Fraction, k: number): boolean {
  return a.n > BigInt(k) * a.d;
}

export function fracFloor(a: Fraction): number {
  let q = a.n / a.d;
  if (a.n < 0n && q * a.d !== a.n) q -= 1n;
  return Number(q);
}

/**
 * The `(internal timebase, timebase units per frame)` After Effects
 * derives from a composition frame rate.
 *
 * AE reads the rate to the thousandth (half up) as a reduced fraction
 * p/q, and gives a frame q * 2**k timebase units with the largest k (at
 * least 0) keeping the timebase under 40000. Measured on AE 2026 over 90
 * rates and matching every AE-saved composition in the samples: 24 fps -\>
 * (24576, 1024), 29.97 -\> (23976, 800), 23.98 -\> (38368, 1600), 7.3 -\>
 * (37376, 5120), 12.3456 -\> (24692, 2000), 99.123 -\> (99123, 1000), 999 -\>
 * (31968, 32). AE derives it again on open, so it also gives the frame grid
 * of a file whose stored timebase disagrees with its rate.
 *
 * When even k = 0 lands past 115200, AE halves the units per frame until
 * the timebase fits, rounds the timebase down and keeps the whole units
 * per frame, so the grid runs a hair off the rate: 120.001 fps -\> (60000,
 * 500), a 120 fps grid; 333.333 -\> (83333, 250); 998.999 -\> (62437, 62),
 * from 62.5 units a frame (measured on AE 2026 over 12 such rates).
 */
export function frameGrid(fps: number): [number, number] {
  const rate = new Fraction(Math.floor(fps * 1000 + 0.5), 1000);
  let unitsPerFrame = new Fraction(rate.denominator);
  while (fracLt(fracMul(fracMul(rate, unitsPerFrame), new Fraction(2)), _TIMEBASE_LIMIT)) {
    unitsPerFrame = fracMul(unitsPerFrame, new Fraction(2));
  }
  while (fracGt(fracMul(rate, unitsPerFrame), _MAX_TIMEBASE)) {
    unitsPerFrame = fracDiv(unitsPerFrame, 2);
  }
  return [fracFloor(fracMul(rate, unitsPerFrame)), fracFloor(unitsPerFrame)];
}

/**
 * Keyframe ticks per second of a layer's own time, in a composition
 * of `internal_timebase` for a layer stretch factor `stretch` (the
 * percentage / 100, sign ignored).
 *
 * Up to 100 % the layer uses the composition timebase. Past it, After
 * Effects scales the timebase by the stretch read as 16.16 fixed point,
 * rounds down, and caps the result at 115200 ticks a second. Measured on
 * AE 2026 on 142 layers over 10 frame rates: 150 % at 24 fps gives
 * 36864, 116 % at 99.123 fps 114983 (114982 with the exact stretch), and
 * 500 % at 24 fps 115200 rather than 122880, like every stretch past the
 * cap. The layer's start time and keyframe ticks use this timebase.
 */
export function layerTimebase(internalTimebase: number, stretch: number): number {
  const fixed = Math.floor(Math.abs(stretch) * 65536 + 0.5);
  if (fixed <= 65536) return internalTimebase;
  return Math.min(floordiv(internalTimebase * fixed, 65536), _MAX_TIMEBASE);
}

/**
 * `ticks` of an `old` timebase in a `new` one, at the same time; a tie
 * rounds up, as After Effects does (measured on AE 2026: ticks 15 and -13
 * become 23 and -19 going from 100 to 150 %, 12 and -84 become 13 and -87
 * going from 24 to 25 fps).
 */
export function rescaleTicks(ticks: number, old: number, new_: number): number {
  return floordiv(2 * ticks * new_ + old, 2 * old);
}

/**
 * Composition data chunk (204 bytes).
 *
 * Holds timing, dimensions, motion blur, and composition flags.
 * Binary fields stay raw except for sentinel-aware work-area end helpers.
 */
export class CdtaChunk extends Chunk {
  declare chunk_type: string;

  // -- Resolution (bytes 0-3) --------------------------------------------

  /** Horizontal resolution factor. */
  declare resolution_factor_h: number;

  /** Vertical resolution factor. */
  declare resolution_factor_v: number;

  // -- Time scale (bytes 4-7) --------------------------------------------
  declare _reserved_04: Uint8Array;

  /** Integer part of time scale. */
  declare time_scale_integer: number;

  /** Fractional part (1/256th units). Non-zero for NTSC-style rates. */
  declare time_scale_fractional: number;

  // -- Timebase (bytes 8-19) ---------------------------------------------

  /** frame_rate * 256 * time_scale. E.g. 24576 for 24fps/ts=4. */
  declare internal_timebase: number;
  declare _reserved_0c: Uint8Array;

  /** Always 600. */
  declare standard_timebase: number;

  // -- Time / work area / duration (bytes 20-51) -------------------------
  declare time_dividend: number;
  declare time_divisor: number;

  /** Signed: AE 2026 stores -1 frame for a zero-length composition. */
  declare work_area_start_dividend: number;
  declare work_area_start_divisor: number;
  declare work_area_end_dividend: number;
  declare work_area_end_divisor: number;
  declare duration_dividend: number;
  declare duration_divisor: number;

  // -- Background color (bytes 52-54) ------------------------------------
  declare bg_color_r: number;
  declare bg_color_g: number;
  declare bg_color_b: number;

  // -- Reserved (bytes 55-137, 83 bytes) ---------------------------------
  declare _reserved_37: Uint8Array;

  // -- Comp flags (bytes 138-139, 2 flag bytes) --------------------------

  /** Byte 138: bit 7 = draft3d. */
  declare _comp_flags_0: number;

  /** Byte 139: composition toggle flags. */
  declare _comp_flags_1: number;

  // -- Dimensions (bytes 140-143) ----------------------------------------
  declare width: number;
  declare height: number;

  // -- Pixel ratio (bytes 144-155) ---------------------------------------
  declare pixel_aspect_dividend: number;
  declare pixel_aspect_divisor: number;
  declare _reserved_98: Uint8Array;

  // -- Frame rate (bytes 156-163) ----------------------------------------
  declare frame_rate_integer: number;

  /** Fractional part (1/65536th units). */
  declare frame_rate_fractional: number;
  declare _reserved_a0: Uint8Array;

  // -- Display start time (bytes 164-171) --------------------------------

  /** Signed. Negative = timeline starts before frame 0. */
  declare display_start_time_dividend: number;
  declare display_start_time_divisor: number;

  // -- Shutter (bytes 172-187) -------------------------------------------
  declare _reserved_ac: Uint8Array;
  declare shutter_angle: number;

  /** Always 360 (0x0168) big-endian. */
  declare _reserved_b0: number;
  declare shutter_phase: number;

  /** Always 360 (0x0168) big-endian. */
  declare _reserved_b8: number;

  // -- Trailing reserved (bytes 188-203) ---------------------------------
  declare _reserved_bc: Uint8Array;
  declare motion_blur_adaptive_sample_limit: number;
  declare motion_blur_samples_per_frame: number;

  // -- BitField descriptors (not attrs fields) ---------------------------
  declare draft3d: boolean;
  declare preserve_nested_resolution: boolean;
  declare preserve_nested_frame_rate: boolean;
  declare frame_blending: boolean;
  declare motion_blur: boolean;
  declare hide_shy_layers: boolean;

  // -- Assembled properties ----------------------------------------------
  // Combine raw integer+fractional or dividend/divisor pairs into floats.
  // Used by model ChunkField descriptors for direct read/write.

  /** Frame rate assembled from integer + fractional/65536. */
  get frame_rate(): number {
    return this.frame_rate_integer + this.frame_rate_fractional / 65536.0;
  }

  set frame_rate(value: number) {
    [this.frame_rate_integer, this.frame_rate_fractional] = toFixed1616(value);
    this._update_timebase(value);
  }

  /** Time scale assembled from integer + fractional/256. */
  get time_scale(): number {
    return this.time_scale_integer + this.time_scale_fractional / 256.0;
  }

  /**
   * Recalculate internal_timebase and time_scale (units per frame /
   * 256) for a new frame rate (see `frame_grid`).
   */
  _update_timebase(fps: number): void {
    const [internalTimebase, unitsPerFrame] = frameGrid(fps);
    this.internal_timebase = internalTimebase;
    [this.time_scale_integer, this.time_scale_fractional] = divmod(unitsPerFrame, 256);
  }

  /** Pixel aspect ratio from dividend/divisor. */
  get pixel_aspect(): number {
    return this.pixel_aspect_dividend / this.pixel_aspect_divisor;
  }

  set pixel_aspect(value: number) {
    [this.pixel_aspect_dividend, this.pixel_aspect_divisor] = toDividendDivisor(value);
  }

  /** Duration in seconds from dividend/divisor. */
  get duration(): number {
    return this.duration_dividend / this.duration_divisor;
  }

  /** Display start time in seconds from dividend/divisor. */
  get display_start_time(): number {
    return this.display_start_time_dividend / this.display_start_time_divisor;
  }

  set display_start_time(value: number) {
    [this.display_start_time_dividend, this.display_start_time_divisor] = toFloat32Ratio(value);
  }

  /** Work area start in seconds from dividend/divisor. */
  get work_area_start(): number {
    return this.work_area_start_dividend / this.work_area_start_divisor;
  }

  /** Current time in seconds from dividend/divisor. */
  get time_seconds(): number {
    return this.time_dividend / this.time_divisor;
  }

  /** Absolute work area end in seconds. */
  get work_area_end_absolute(): number {
    if (this.work_area_end_dividend === WORK_AREA_TO_END) {
      return this.display_start_time + this.duration;
    }
    return this.display_start_time + this.work_area_end_dividend / this.work_area_end_divisor;
  }

  /** Absolute work area end in frames. */
  get frame_work_area_end_absolute(): number {
    if (this.work_area_end_dividend === WORK_AREA_TO_END) {
      return (this.display_start_time + this.duration) * this.frame_rate;
    }
    return this.work_area_end_absolute * this.frame_rate;
  }

  /** Background color as [R, G, B] in 0.0-1.0 range. */
  get bg_color(): number[] {
    return [this.bg_color_r / 255, this.bg_color_g / 255, this.bg_color_b / 255];
  }

  set bg_color(value: number[]) {
    this.bg_color_r = round(value[0] * 255);
    this.bg_color_g = round(value[1] * 255);
    this.bg_color_b = round(value[2] * 255);
  }

  /** Resolution factor as [horizontal, vertical]. */
  get resolution_factor(): number[] {
    return [this.resolution_factor_h, this.resolution_factor_v];
  }

  set resolution_factor(value: number[]) {
    this.resolution_factor_h = value[0];
    this.resolution_factor_v = value[1];
  }

  /**
   * Duration in frames. A duration is a whole number of frames, so the
   * product is rounded: truncating it loses a frame at 23.976 fps, where
   * the stored rate is only 16.16-accurate (51.999995 for 52 frames).
   */
  get frame_duration(): number {
    return round(this.duration * this.frame_rate);
  }

  /** Work area duration in seconds. */
  get work_area_duration(): number {
    if (this.work_area_end_dividend === WORK_AREA_TO_END) {
      return this.duration - this.work_area_start;
    }
    return this.work_area_end_dividend / this.work_area_end_divisor - this.work_area_start;
  }

  /** Work area duration in frames, rounded like `frame_duration`. */
  get work_area_duration_frame(): number {
    return round(this.work_area_duration * this.frame_rate);
  }
}
define(CdtaChunk, {
  chunk_type: field({ default: "cdta" }),
  resolution_factor_h: u2Field({ default: 1 }),
  resolution_factor_v: u2Field({ default: 1 }),
  _reserved_04: bytesField(1, { repr: false }),
  time_scale_integer: u2Field({ default: 4 }),
  time_scale_fractional: u1Field(),
  internal_timebase: u4Field({ default: 24576 }),
  _reserved_0c: bytesField(4, { repr: false }),
  standard_timebase: u4Field({ default: 600 }),
  time_dividend: s4Field({ default: 1 }),
  time_divisor: u4Field({ default: 1 }),
  work_area_start_dividend: s4Field({ default: 1 }),
  work_area_start_divisor: u4Field({ default: 1 }),
  work_area_end_dividend: u4Field({ default: WORK_AREA_TO_END }),
  work_area_end_divisor: u4Field({ default: 1 }),
  duration_dividend: u4Field({ default: 1 }),
  duration_divisor: u4Field({ default: 1 }),
  bg_color_r: u1Field(),
  bg_color_g: u1Field(),
  bg_color_b: u1Field(),
  _reserved_37: bytesField(83, { repr: false }),
  _comp_flags_0: u1Field({ repr: false }),
  _comp_flags_1: u1Field({ repr: false }),
  width: u2Field(),
  height: u2Field(),
  pixel_aspect_dividend: u4Field({ default: 1 }),
  pixel_aspect_divisor: u4Field({ default: 1 }),
  _reserved_98: bytesField(4, { repr: false }),
  frame_rate_integer: u2Field(),
  frame_rate_fractional: u2Field(),
  _reserved_a0: bytesField(4, { repr: false }),
  display_start_time_dividend: s4Field({ default: 1 }),
  display_start_time_divisor: u4Field({ default: 1 }),
  _reserved_ac: bytesField(2, { repr: false }),
  shutter_angle: u2Field({ default: 180 }),
  _reserved_b0: u4Field({ default: 360, repr: false }),
  shutter_phase: s4Field(),
  _reserved_b8: u4Field({ default: 360, repr: false }),
  _reserved_bc: bytesField(8, { repr: false }),
  motion_blur_adaptive_sample_limit: s4Field({ default: 128 }),
  motion_blur_samples_per_frame: s4Field({ default: 16 }),
});
descriptor(CdtaChunk, "draft3d", new BitField("_comp_flags_0", 7));
descriptor(CdtaChunk, "preserve_nested_resolution", new BitField("_comp_flags_1", 7));
descriptor(CdtaChunk, "preserve_nested_frame_rate", new BitField("_comp_flags_1", 5));
descriptor(CdtaChunk, "frame_blending", new BitField("_comp_flags_1", 4));
descriptor(CdtaChunk, "motion_blur", new BitField("_comp_flags_1", 3));
descriptor(CdtaChunk, "hide_shy_layers", new BitField("_comp_flags_1", 0));
register("cdta")(CdtaChunk);

// ---------------------------------------------------------------------------
// CsCt - CpS2 entry count
// ---------------------------------------------------------------------------

/** CpS2 entry count chunk, little-endian inside the big-endian file. */
export class CsctChunk extends Chunk {
  declare chunk_type: string;
  declare value: number;
}
define(CsctChunk, {
  chunk_type: field({ default: "CsCt" }),
  value: u4Field({ default: 1, endian: "<" }),
});
register("CsCt")(CsctChunk);

// ---------------------------------------------------------------------------
// Composition preset entry (preferences only, not stored in .aep files)
// ---------------------------------------------------------------------------

/**
 * One "Composition Presets Section v11" preferences entry (16 bytes).
 *
 * Format/frame-rate/pixel-aspect of a New Composition preset; the
 * display name lives in the adjacent preset-names section. Frame rate
 * and pixel aspect use the same encodings as `CdtaChunk`.
 */
export class CompPresetItem extends FmtItem {
  declare width: number;
  declare height: number;
  declare frame_rate_integer: number;

  /** Fractional part (1/65536th units). */
  declare frame_rate_fractional: number;
  declare pixel_aspect_dividend: number;
  declare pixel_aspect_divisor: number;

  /** Frame rate assembled from integer + fractional/65536. */
  get frame_rate(): number {
    return this.frame_rate_integer + this.frame_rate_fractional / 65536.0;
  }

  /** Pixel aspect ratio assembled from dividend/divisor. */
  get pixel_aspect(): number {
    return this.pixel_aspect_dividend / this.pixel_aspect_divisor;
  }
}
define(CompPresetItem, {
  width: u2Field(),
  height: u2Field(),
  frame_rate_integer: u2Field(),
  frame_rate_fractional: u2Field(),
  pixel_aspect_dividend: u4Field({ default: 1 }),
  pixel_aspect_divisor: u4Field({ default: 1 }),
});
