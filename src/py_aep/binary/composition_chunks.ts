/**
 * Composition chunk type: cdta (204 bytes).
 *
 * Uses `fmtField()` for all fixed-layout fields, `BitField` descriptors
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
 * `workAreaEndDividend` of a work area that runs to the end of the
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
 * of `internalTimebase` for a layer stretch factor `stretch` (the
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
  declare chunkType: string;

  // -- Resolution (bytes 0-3) --------------------------------------------

  /** Horizontal resolution factor. */
  declare resolutionFactorH: number;

  /** Vertical resolution factor. */
  declare resolutionFactorV: number;

  // -- Time scale (bytes 4-7) --------------------------------------------
  declare _reserved04: Uint8Array;

  /** Integer part of time scale. */
  declare timeScaleInteger: number;

  /** Fractional part (1/256th units). Non-zero for NTSC-style rates. */
  declare timeScaleFractional: number;

  // -- Timebase (bytes 8-19) ---------------------------------------------

  /** frame_rate * 256 * time_scale. E.g. 24576 for 24fps/ts=4. */
  declare internalTimebase: number;
  declare _reserved0c: Uint8Array;

  /** Always 600. */
  declare standardTimebase: number;

  // -- Time / work area / duration (bytes 20-51) -------------------------
  declare timeDividend: number;
  declare timeDivisor: number;

  /** Signed: AE 2026 stores -1 frame for a zero-length composition. */
  declare workAreaStartDividend: number;
  declare workAreaStartDivisor: number;
  declare workAreaEndDividend: number;
  declare workAreaEndDivisor: number;
  declare durationDividend: number;
  declare durationDivisor: number;

  // -- Background color (bytes 52-54) ------------------------------------
  declare bgColorR: number;
  declare bgColorG: number;
  declare bgColorB: number;

  // -- Reserved (bytes 55-137, 83 bytes) ---------------------------------
  declare _reserved37: Uint8Array;

  // -- Comp flags (bytes 138-139, 2 flag bytes) --------------------------

  /** Byte 138: bit 7 = draft3d. */
  declare _compFlags0: number;

  /** Byte 139: composition toggle flags. */
  declare _compFlags1: number;

  // -- Dimensions (bytes 140-143) ----------------------------------------
  declare width: number;
  declare height: number;

  // -- Pixel ratio (bytes 144-155) ---------------------------------------
  declare pixelAspectDividend: number;
  declare pixelAspectDivisor: number;
  declare _reserved98: Uint8Array;

  // -- Frame rate (bytes 156-163) ----------------------------------------
  declare frameRateInteger: number;

  /** Fractional part (1/65536th units). */
  declare frameRateFractional: number;
  declare _reservedA0: Uint8Array;

  // -- Display start time (bytes 164-171) --------------------------------

  /** Signed. Negative = timeline starts before frame 0. */
  declare displayStartTimeDividend: number;
  declare displayStartTimeDivisor: number;

  // -- Shutter (bytes 172-187) -------------------------------------------
  declare _reservedAc: Uint8Array;
  declare shutterAngle: number;

  /** Always 360 (0x0168) big-endian. */
  declare _reservedB0: number;
  declare shutterPhase: number;

  /** Always 360 (0x0168) big-endian. */
  declare _reservedB8: number;

  // -- Trailing reserved (bytes 188-203) ---------------------------------
  declare _reservedBc: Uint8Array;
  declare motionBlurAdaptiveSampleLimit: number;
  declare motionBlurSamplesPerFrame: number;

  // -- BitField descriptors (not attrs fields) ---------------------------
  declare draft3d: boolean;
  declare preserveNestedResolution: boolean;
  declare preserveNestedFrameRate: boolean;
  declare frameBlending: boolean;
  declare motionBlur: boolean;
  declare hideShyLayers: boolean;

  // -- Assembled properties ----------------------------------------------
  // Combine raw integer+fractional or dividend/divisor pairs into floats.
  // Used by model ChunkField descriptors for direct read/write.

  /** Frame rate assembled from integer + fractional/65536. */
  get frameRate(): number {
    return this.frameRateInteger + this.frameRateFractional / 65536.0;
  }

  set frameRate(value: number) {
    [this.frameRateInteger, this.frameRateFractional] = toFixed1616(value);
    this._updateTimebase(value);
  }

  /** Time scale assembled from integer + fractional/256. */
  get timeScale(): number {
    return this.timeScaleInteger + this.timeScaleFractional / 256.0;
  }

  /**
   * Recalculate internal_timebase and time_scale (units per frame /
   * 256) for a new frame rate (see `frameGrid`).
   */
  _updateTimebase(fps: number): void {
    const [internalTimebase, unitsPerFrame] = frameGrid(fps);
    this.internalTimebase = internalTimebase;
    [this.timeScaleInteger, this.timeScaleFractional] = divmod(unitsPerFrame, 256);
  }

  /** Pixel aspect ratio from dividend/divisor. */
  get pixelAspect(): number {
    return this.pixelAspectDividend / this.pixelAspectDivisor;
  }

  set pixelAspect(value: number) {
    [this.pixelAspectDividend, this.pixelAspectDivisor] = toDividendDivisor(value);
  }

  /** Duration in seconds from dividend/divisor. */
  get duration(): number {
    return this.durationDividend / this.durationDivisor;
  }

  /** Display start time in seconds from dividend/divisor. */
  get displayStartTime(): number {
    return this.displayStartTimeDividend / this.displayStartTimeDivisor;
  }

  set displayStartTime(value: number) {
    [this.displayStartTimeDividend, this.displayStartTimeDivisor] = toFloat32Ratio(value);
  }

  /** Work area start in seconds from dividend/divisor. */
  get workAreaStart(): number {
    return this.workAreaStartDividend / this.workAreaStartDivisor;
  }

  /** Current time in seconds from dividend/divisor. */
  get timeSeconds(): number {
    return this.timeDividend / this.timeDivisor;
  }

  /** Absolute work area end in seconds. */
  get workAreaEndAbsolute(): number {
    if (this.workAreaEndDividend === WORK_AREA_TO_END) {
      return this.displayStartTime + this.duration;
    }
    return this.displayStartTime + this.workAreaEndDividend / this.workAreaEndDivisor;
  }

  /** Absolute work area end in frames. */
  get frameWorkAreaEndAbsolute(): number {
    if (this.workAreaEndDividend === WORK_AREA_TO_END) {
      return (this.displayStartTime + this.duration) * this.frameRate;
    }
    return this.workAreaEndAbsolute * this.frameRate;
  }

  /** Background color as [R, G, B] in 0.0-1.0 range. */
  get bgColor(): number[] {
    return [this.bgColorR / 255, this.bgColorG / 255, this.bgColorB / 255];
  }

  set bgColor(value: number[]) {
    this.bgColorR = round(value[0] * 255);
    this.bgColorG = round(value[1] * 255);
    this.bgColorB = round(value[2] * 255);
  }

  /** Resolution factor as [horizontal, vertical]. */
  get resolutionFactor(): number[] {
    return [this.resolutionFactorH, this.resolutionFactorV];
  }

  set resolutionFactor(value: number[]) {
    this.resolutionFactorH = value[0];
    this.resolutionFactorV = value[1];
  }

  /**
   * Duration in frames. A duration is a whole number of frames, so the
   * product is rounded: truncating it loses a frame at 23.976 fps, where
   * the stored rate is only 16.16-accurate (51.999995 for 52 frames).
   */
  get frameDuration(): number {
    return round(this.duration * this.frameRate);
  }

  /** Work area duration in seconds. */
  get workAreaDuration(): number {
    if (this.workAreaEndDividend === WORK_AREA_TO_END) {
      return this.duration - this.workAreaStart;
    }
    return this.workAreaEndDividend / this.workAreaEndDivisor - this.workAreaStart;
  }

  /** Work area duration in frames, rounded like `frameDuration`. */
  get workAreaDurationFrame(): number {
    return round(this.workAreaDuration * this.frameRate);
  }
}
define(CdtaChunk, {
  chunkType: field({ default: "cdta" }),
  resolutionFactorH: u2Field({ default: 1 }),
  resolutionFactorV: u2Field({ default: 1 }),
  _reserved04: bytesField(1, { repr: false }),
  timeScaleInteger: u2Field({ default: 4 }),
  timeScaleFractional: u1Field(),
  internalTimebase: u4Field({ default: 24576 }),
  _reserved0c: bytesField(4, { repr: false }),
  standardTimebase: u4Field({ default: 600 }),
  timeDividend: s4Field({ default: 1 }),
  timeDivisor: u4Field({ default: 1 }),
  workAreaStartDividend: s4Field({ default: 1 }),
  workAreaStartDivisor: u4Field({ default: 1 }),
  workAreaEndDividend: u4Field({ default: WORK_AREA_TO_END }),
  workAreaEndDivisor: u4Field({ default: 1 }),
  durationDividend: u4Field({ default: 1 }),
  durationDivisor: u4Field({ default: 1 }),
  bgColorR: u1Field(),
  bgColorG: u1Field(),
  bgColorB: u1Field(),
  _reserved37: bytesField(83, { repr: false }),
  _compFlags0: u1Field({ repr: false }),
  _compFlags1: u1Field({ repr: false }),
  width: u2Field(),
  height: u2Field(),
  pixelAspectDividend: u4Field({ default: 1 }),
  pixelAspectDivisor: u4Field({ default: 1 }),
  _reserved98: bytesField(4, { repr: false }),
  frameRateInteger: u2Field(),
  frameRateFractional: u2Field(),
  _reservedA0: bytesField(4, { repr: false }),
  displayStartTimeDividend: s4Field({ default: 1 }),
  displayStartTimeDivisor: u4Field({ default: 1 }),
  _reservedAc: bytesField(2, { repr: false }),
  shutterAngle: u2Field({ default: 180 }),
  _reservedB0: u4Field({ default: 360, repr: false }),
  shutterPhase: s4Field(),
  _reservedB8: u4Field({ default: 360, repr: false }),
  _reservedBc: bytesField(8, { repr: false }),
  motionBlurAdaptiveSampleLimit: s4Field({ default: 128 }),
  motionBlurSamplesPerFrame: s4Field({ default: 16 }),
});
descriptor(CdtaChunk, "draft3d", new BitField("_compFlags0", 7));
descriptor(CdtaChunk, "preserveNestedResolution", new BitField("_compFlags1", 7));
descriptor(CdtaChunk, "preserveNestedFrameRate", new BitField("_compFlags1", 5));
descriptor(CdtaChunk, "frameBlending", new BitField("_compFlags1", 4));
descriptor(CdtaChunk, "motionBlur", new BitField("_compFlags1", 3));
descriptor(CdtaChunk, "hideShyLayers", new BitField("_compFlags1", 0));
register("cdta")(CdtaChunk);

// ---------------------------------------------------------------------------
// CsCt - CpS2 entry count
// ---------------------------------------------------------------------------

/** CpS2 entry count chunk, little-endian inside the big-endian file. */
export class CsctChunk extends Chunk {
  declare chunkType: string;
  declare value: number;
}
define(CsctChunk, {
  chunkType: field({ default: "CsCt" }),
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
  declare frameRateInteger: number;

  /** Fractional part (1/65536th units). */
  declare frameRateFractional: number;
  declare pixelAspectDividend: number;
  declare pixelAspectDivisor: number;

  /** Frame rate assembled from integer + fractional/65536. */
  get frameRate(): number {
    return this.frameRateInteger + this.frameRateFractional / 65536.0;
  }

  /** Pixel aspect ratio assembled from dividend/divisor. */
  get pixelAspect(): number {
    return this.pixelAspectDividend / this.pixelAspectDivisor;
  }
}
define(CompPresetItem, {
  width: u2Field(),
  height: u2Field(),
  frameRateInteger: u2Field(),
  frameRateFractional: u2Field(),
  pixelAspectDividend: u4Field({ default: 1 }),
  pixelAspectDivisor: u4Field({ default: 1 }),
});
