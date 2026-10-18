/**
 * Footage chunk types: sspc (source settings), opti (asset info).
 *
 * SspcChunk uses `fmtField()` for all fixed-layout fields with `BitField`
 * descriptors for alpha flags.
 * OptiChunk uses variant subclass dispatch: SoliOptiChunk, PsdOptiChunk and
 * TextOptiChunk (fmt_field, some LE), PlaceholderOptiChunk. The `build_*`
 * opti builders serialize the typed variant chunks, so the read and write
 * paths share one layout definition.
 */

import {
  Bytes,
  concat,
  decode,
  define,
  descriptor,
  encode,
  field,
  OverflowError,
  round,
  struct, ascii } from "../../pyrt/index.ts";
import type { IO } from "../../pyrt/index.ts";
import { MAC_EPOCH_OFFSET, readBytes, toDividendDivisor, toFixed1616, truncateUtf8 } from "./bin_utils.ts";
import { BitField } from "./bitfield.ts";
import { Chunk, type ChunkReadKwargs } from "./chunk.ts";
import { asciiField, boolField, bytesField, f4Field, f8Field, s2Field, s4Field, strField, u1Field, u2Field, u4Field, u8Field } from "./fmt_field.ts";
import { register } from "./registry.ts";
import { CineonRoptChunk } from "./render_chunks.ts";

// ---------------------------------------------------------------------------
// sspc - source footage settings (184+ bytes)
// ---------------------------------------------------------------------------

/**
 * Source footage settings chunk.
 *
 * Contains dimensions, timing, alpha/field settings, pixel ratio,
 * audio sample rate, and sequence info. A variable-length trailing
 * section is preserved for round-trip fidelity.
 */
export class SspcChunk extends Chunk {
  declare chunkType: string;

  // -- Reserved (bytes 0-21) ---------------------------------------------
  declare _reserved00: Uint8Array;

  // -- Source format (bytes 22-31) ---------------------------------------
  /** 4-char code: 'png!', '8BPS', 'MOoV', 'Soli', etc. */
  declare sourceFormatType: string;

  declare _reserved1a: Uint8Array;

  // -- Dimensions / duration (bytes 32-45) -------------------------------
  declare width: number;
  declare _reserved22: Uint8Array;
  declare height: number;
  declare durationDividend: number;
  declare durationDivisor: number;

  // -- Frame rate (bytes 46-68) ------------------------------------------
  declare _reserved2e: Uint8Array;
  declare _timeBase: number;
  declare _reserved36: Uint8Array;
  declare nativeFrameRateInteger: number;
  declare nativeFrameRateFractional: number;
  /**
   * Byte 0x3E: the source's pixel depth in bits per pixel, as the AE SDK's
   * `AEIO_InputDepth`: 24 / 48 / 96 for RGB at 8 / 16 / 32 bpc, 32 / 64 / 128
   * with alpha, 40 / -16 / -32 for grayscale, 8 for indexed color, 0 for
   * media without video. AE does not re-read most formats on open, so a wrong
   * value renders the footage without its alpha (AE 2026).
   */
  declare depth: number;

  /** `01 01` on every file source, `00 00` on solids and placeholders. */
  declare _reserved40: Uint8Array;

  declare _reserved42: Uint8Array;

  // -- Alpha flags (byte 69) ---------------------------------------------
  /** Byte 69: bit 1 = invert_alpha, bit 0 = premultiplied. */
  declare _alphaFlags: number;

  // -- Premul color / alpha mode (bytes 70-73) ---------------------------
  declare premulColorR: number;
  declare premulColorG: number;
  declare premulColorB: number;
  /** Alpha interpretation mode. 3 = no alpha channel. */
  declare alphaModeRaw: number;

  // -- Field separation (bytes 74-87) ------------------------------------
  /**
   * Bytes 0x4A-0x4E: source field information. AE fills the first four
   * with the QuickTime `FIEL` tag for media that declares field handling and
   * leaves them zero otherwise.
   */
  declare _reserved4a: Uint8Array;

  /**
   * Byte 0x4F: set on every source read from a file, and left clear on a
   * solid or a placeholder (AE 2026, across 527 sample footage items).
   */
  declare fromFile: boolean;

  declare _reserved50: Uint8Array;
  /** 0 = OFF, 1 = enabled (check field_order for upper/lower). */
  declare fieldSeparationTypeRaw: number;

  declare _reserved54: Uint8Array;
  declare fieldOrder: number;

  // -- Reserved / footage state (bytes 88-128) ---------------------------
  declare _reserved58: Uint8Array;
  declare _isSyntheticA: number;
  declare _reserved6b: Uint8Array;
  declare _isSyntheticB: number;
  declare _reserved6e: Uint8Array;
  /** Byte 0x70: bit 3 = `mediaFormat`. */
  declare _flags70: number;

  declare _reserved71: Uint8Array;
  /** Byte 0x73: bit 0 = `footageMissingAtSave`. */
  declare _flags73: number;

  /**
   * Bytes 0x74-0x7C: the source's last-modified stamp (see
   * `sourceModified`). AE compares it against the file on open to decide
   * whether the cached asset info in this chunk is still current.
   */
  declare _sourceStamp: Uint8Array;

  declare _depthFlag: number;

  // -- Loop / pixel ratio (bytes 126-146) --------------------------------
  /**
   * Loop count (1 = no loop, 2+ = loop count). Stored as a 4-byte
   * big-endian field (AE writes e.g. 1000 as 00 00 03 e8); a u1 here read
   * only the low byte and overflowed on save for counts \> 255.
   */
  declare loop: number;

  declare _reserved82: Uint8Array;
  declare _isSyntheticC: number;
  declare _reserved87: Uint8Array;
  declare pixelAspectDividend: number;
  declare pixelAspectDivisor: number;
  declare _reserved90: Uint8Array;

  // -- Pulldown / conform (bytes 147-158) --------------------------------
  declare _removePulldownValue: number;

  /** 0 = no conforming. */
  declare conformFrameRateInteger: number;

  declare conformFrameRateFractional: number;
  declare displayFrameRateInteger: number;
  declare displayFrameRateFractional: number;
  declare _reserved9c: Uint8Array;
  /**
   * Byte 0x9F: bit 0 = `highQualityFieldSeparation`, bit 3 =
   * `mediaFile`.
   */
  declare _flags9f: number;

  // -- Audio / sequence (bytes 160-183) ----------------------------------
  /** Sample rate in Hz (0.0 = no audio). */
  declare audioSampleRate: number;

  declare _reservedA8: Uint8Array;
  declare startFrame: number;
  declare endFrame: number;
  /** Zero-padded digit count for image sequences (0 for non-sequences). */
  declare framePadding: number;

  // -- Extended settings (bytes 184-221) ---------------------------------
  declare _reservedB8: Uint8Array;
  /**
   * Byte 0xB9: `true` when the sequence was imported with a user-set
   * frame range. AE sets it for ranged imports only - a sequence with
   * missing interior frames but no range keeps 0 (probed range fixtures,
   * AE 2026).
   */
  declare frameRangeSet: boolean;

  declare _reservedBa: Uint8Array;
  /**
   * Byte 0xBC: Photoshop layer id (`lyid`) when the footage references a
   * single layer of a layered file; `0xFFFFFFFF` otherwise (merged,
   * whole-file, and AI/PDF layers, which have no ids).
   */
  declare layerId: number;

  /**
   * Byte 0xC0: 0-based index of the referenced layer (PSD: document
   * record index counting group dividers; AI/PDF: OCG order). `0xFFFFFFFF`
   * for merged/whole-file footage; placeholders store `0xFFFFFFFE`.
   */
  declare layerIndex: number;

  declare _reservedC4: Uint8Array;
  /**
   * Byte 0xC7: `true` when the footage spans its full source frame
   * (including a chosen layer imported at Document Size), `false` for a
   * layer cropped to its content box (`COMP_CROPPED_LAYERS` or a chosen
   * layer imported at Layer Size). Written only for file footage;
   * solids/placeholders leave it `false`.
   */
  declare fullFrame: boolean;

  declare _reservedC8: Uint8Array;
  declare _reservedCa: Uint8Array;
  /**
   * Byte 0xCC: cached source data size (64-bit). For a PSD layer (chosen
   * or comp-imported) the content box's pixel bytes (`w * h * 4` at 8 bpc);
   * for merged PSD footage and TIFF stills the decoded canvas; for whole
   * files (PNG, AI, ...) and sequences the file sizes on disk. AE re-derives
   * it on a cache miss, so `0` is accepted.
   */
  declare dataSize: number | bigint;
  declare _reservedD4: Uint8Array;

  // -- BitField descriptors (not attrs fields) ---------------------------
  declare invertAlpha: boolean;
  declare premultiplied: boolean;
  /** 0 = found, 1 = missing or placeholder. */
  declare footageMissingAtSave: boolean;
  declare highQualityFieldSeparation: boolean;
  /**
   * Set by AE's import for JPEG, BMP/GIF, HEIC, movie, audio and data
   * footage, single files and sequences alike (AE 2026).
   */
  declare mediaFormat: boolean;
  /** As `mediaFormat`, for single files only (clear on a sequence). */
  declare mediaFile: boolean;

  // -- Computed properties -----------------------------------------------

  /** Native frame rate (integer + fractional/65536). */
  get nativeFrameRate(): number {
    return this.nativeFrameRateInteger + this.nativeFrameRateFractional / 65536.0;
  }

  set nativeFrameRate(value: number) {
    [this.nativeFrameRateInteger, this.nativeFrameRateFractional] = toFixed1616(value);
    this._updateDisplayFrameRate();
  }

  /** Conform frame rate (integer + fractional/65536). 0 = no conform. */
  get conformFrameRate(): number {
    return this.conformFrameRateInteger + this.conformFrameRateFractional / 65536.0;
  }

  set conformFrameRate(value: number) {
    [this.conformFrameRateInteger, this.conformFrameRateFractional] = toFixed1616(value);
    this._updateDisplayFrameRate();
  }

  /**
   * Last-modified time AE cached for the source, as a Unix timestamp.
   *
   * `0` when unstamped. AE re-reads the media whenever this does not
   * match the file on disk, and then takes the dimensions from the
   * format plugin rather than from this chunk - which is not always the
   * same answer (an OpenEXR plugin reports the data window, while the
   * importer records the display window).
   */
  get sourceModified(): number {
    const stamp = Bytes.intFromBytes(this._sourceStamp.slice(2, 6), "big");
    return stamp ? stamp - MAC_EPOCH_OFFSET : 0;
  }

  set sourceModified(value: number) {
    const stamp = value ? Math.trunc(value) + MAC_EPOCH_OFFSET : 0;
    // int.to_bytes raises OverflowError (not ValueError) when the value does not fit
    if (stamp < 0) throw new OverflowError("can't convert negative int to unsigned");
    if (stamp >= 2 ** 32) throw new OverflowError("int too big to convert");
    this._sourceStamp = concat(new Uint8Array(2), Bytes.intToBytes(stamp, 4, "big"), Bytes.repeat(new Uint8Array(1), 3));
  }

  /** Duration in seconds (dividend / divisor). */
  get duration(): number {
    if (this.durationDivisor === 0) {
      return 0.0;
    }
    return this.durationDividend / this.durationDivisor;
  }

  set duration(value: number) {
    [this.durationDividend, this.durationDivisor] = toDividendDivisor(value);
  }

  /** Pixel aspect ratio (dividend / divisor). */
  get pixelAspect(): number {
    if (this.pixelAspectDivisor === 0) {
      return 1.0;
    }
    return this.pixelAspectDividend / this.pixelAspectDivisor;
  }

  set pixelAspect(value: number) {
    [this.pixelAspectDividend, this.pixelAspectDivisor] = toDividendDivisor(value);
  }

  /** Premultiply color as [R, G, B] in 0.0-1.0 range. */
  get premulColor(): number[] {
    return [this.premulColorR / 255, this.premulColorG / 255, this.premulColorB / 255];
  }

  set premulColor(value: number[]) {
    this.premulColorR = round(value[0] * 255);
    this.premulColorG = round(value[1] * 255);
    this.premulColorB = round(value[2] * 255);
  }

  /** Field separation type (0=off, 1=upper_first, 2=lower_first). */
  get fieldSeparationType(): number {
    if (this.fieldSeparationTypeRaw === 0) {
      return 0;
    }
    return this.fieldOrder + 1;
  }

  set fieldSeparationType(value: number) {
    if (value === 0) {
      this.fieldSeparationTypeRaw = 0;
      this.fieldOrder = 0;
    } else {
      this.fieldSeparationTypeRaw = 1;
      this.fieldOrder = value - 1;
    }
  }

  /** Whether the footage has an alpha component. */
  get hasAlpha(): boolean {
    return this.alphaModeRaw !== 3;
  }

  /** 0 = OFF, 1-10 = pulldown phase. */
  get removePulldown(): number {
    return this._removePulldownValue;
  }

  set removePulldown(value: number) {
    this._removePulldownValue = value;
    this._updateDisplayFrameRate();
  }

  /** Effective frame rate as displayed. */
  get displayFrameRate(): number {
    const conform = this.conformFrameRate;
    const base = conform !== 0 ? conform : this.nativeFrameRate;
    return base * (this._removePulldownValue !== 0 ? 0.8 : 1.0);
  }

  set displayFrameRate(value: number) {
    [this.displayFrameRateInteger, this.displayFrameRateFractional] = toFixed1616(value);
  }

  /** Recompute and store display_frame_rate from current settings. */
  _updateDisplayFrameRate(): void {
    const conform = this.conformFrameRate;
    const base = conform !== 0 ? conform : this.nativeFrameRate;
    this.displayFrameRate = base * (this._removePulldownValue !== 0 ? 0.8 : 1.0);
  }

  static {
    // -- BitField descriptors (not attrs fields) -------------------------------
    descriptor(this, "invertAlpha", new BitField("_alphaFlags", 1));
    descriptor(this, "premultiplied", new BitField("_alphaFlags", 0));
    descriptor(this, "footageMissingAtSave", new BitField("_flags73", 0));
    descriptor(this, "highQualityFieldSeparation", new BitField("_flags9f", 0));
    descriptor(this, "mediaFormat", new BitField("_flags70", 3));
    descriptor(this, "mediaFile", new BitField("_flags9f", 3));
  }
}

define(SspcChunk, {
  chunkType: field({ default: "sspc" }),

  // -- Reserved (bytes 0-21) ---------------------------------------------
  _reserved00: bytesField(22, { repr: false }),

  // -- Source format (bytes 22-31) ---------------------------------------
  sourceFormatType: asciiField(4),

  _reserved1a: bytesField(6, { repr: false }),

  // -- Dimensions / duration (bytes 32-45) -------------------------------
  width: u2Field(),
  _reserved22: bytesField(2, { repr: false }),
  height: u2Field(),
  durationDividend: u4Field({ default: 1 }),
  durationDivisor: u4Field({ default: 1 }),

  // -- Frame rate (bytes 46-68) ------------------------------------------
  _reserved2e: bytesField(6, { repr: false }),
  _timeBase: u2Field({ default: 600 }),
  _reserved36: bytesField(2, { repr: false }),
  nativeFrameRateInteger: u4Field(),
  nativeFrameRateFractional: u2Field(),
  depth: s2Field(),

  _reserved40: bytesField(2, { repr: false }),

  _reserved42: bytesField(3, { repr: false }),

  // -- Alpha flags (byte 69) ---------------------------------------------
  _alphaFlags: u1Field({ repr: false }),

  // -- Premul color / alpha mode (bytes 70-73) ---------------------------
  premulColorR: u1Field(),
  premulColorG: u1Field(),
  premulColorB: u1Field(),
  alphaModeRaw: u1Field(),

  // -- Field separation (bytes 74-87) ------------------------------------
  _reserved4a: bytesField(5, { repr: false }),

  fromFile: boolField(),

  _reserved50: bytesField(3, { repr: false }),
  fieldSeparationTypeRaw: u1Field(),

  _reserved54: bytesField(3, { repr: false }),

  fieldOrder: u1Field(),

  // -- Reserved / footage state (bytes 88-128) ---------------------------
  _reserved58: bytesField(17, { repr: false }),
  _isSyntheticA: u1Field({ default: 1, repr: false }),
  _reserved6b: bytesField(3, { repr: false }),
  _isSyntheticB: u1Field({ default: 1, repr: false }),
  _reserved6e: bytesField(2, { repr: false }),
  _flags70: u1Field({ repr: false }),

  _reserved71: bytesField(2, { repr: false }),
  _flags73: u1Field({ repr: false }),

  _sourceStamp: bytesField(9, { repr: false }),

  _depthFlag: u1Field({ default: 0x0c, repr: false }),

  // -- Loop / pixel ratio (bytes 126-146) --------------------------------
  loop: u4Field({ default: 1 }),

  _reserved82: bytesField(4, { repr: false }),
  _isSyntheticC: u1Field({ default: 1, repr: false }),
  _reserved87: bytesField(1, { repr: false }),
  pixelAspectDividend: u4Field({ default: 1 }),
  pixelAspectDivisor: u4Field({ default: 1 }),
  _reserved90: bytesField(3, { repr: false }),

  // -- Pulldown / conform (bytes 147-158) --------------------------------
  _removePulldownValue: u1Field({ repr: false }),

  conformFrameRateInteger: u2Field(),

  conformFrameRateFractional: u2Field(),
  displayFrameRateInteger: u2Field(),
  displayFrameRateFractional: u2Field(),
  _reserved9c: bytesField(3, { repr: false }),
  _flags9f: u1Field({ repr: false }),

  // -- Audio / sequence (bytes 160-183) ----------------------------------
  audioSampleRate: f8Field(),

  _reservedA8: bytesField(4, { repr: false }),
  startFrame: u4Field(),
  endFrame: u4Field(),
  framePadding: u4Field(),

  // -- Extended settings (bytes 184-221) ---------------------------------
  _reservedB8: bytesField(1, { repr: false }),
  frameRangeSet: boolField(),

  _reservedBa: bytesField(2, { repr: false }),
  layerId: u4Field({ default: 0xffffffff }),

  layerIndex: u4Field({ default: 0xffffffff }),

  _reservedC4: bytesField(3, { repr: false }),
  fullFrame: boolField(),

  _reservedC8: bytesField(2, { repr: false }),
  _reservedCa: bytesField(2, { repr: false }),
  dataSize: u8Field(),
  _reservedD4: bytesField(10, { default: concat(Uint8Array.of(0x01), Bytes.repeat(new Uint8Array(1), 9)), repr: false }),
});

register("sspc")(SspcChunk);

// ---------------------------------------------------------------------------
// opti - footage asset info (variant dispatch by asset_type)
// ---------------------------------------------------------------------------

/**
 * Build the 58-byte generic `opti` asset-info body for a file source.
 *
 * AE accepts an empty `opti` for single still images (it re-reads the
 * located file), but requires this header to recognize non-TIFF/PSD
 * image sequences and audio/video. The layout is the format 4-char code,
 * a version word, the chunk length, then a 16-byte importer block: the
 * reversed code, an `0xFFFFFFFF` marker, and codec bytes AE re-derives
 * on open. AE zeroes the block for a BMP/GIF sequence through its generic
 * still importer (`IMIO` on macOS, `STIL` on Windows; imio_sequence.aep
 * and media_replacement.aep are byte-exact).
 *
 * **Note:** TIFF sequences use `buildTiffOptiData` instead (AE 2026
 * measured); PSD sequences use an empty opti via `PsdOptiChunk`.
 *
 * @param sourceFormat - 4-char `sspc` source-format code.
 * @param kw - Keyword arguments:
 * - `sequence`: `true` for an image sequence.
 */
export function buildGenericOptiData(sourceFormat: string, kw: { sequence?: boolean } = {}): Uint8Array {
  const { sequence = false } = kw;
  const code = Bytes.padEnd(encode(sourceFormat, "ascii").slice(0, 4), 4, 0x20);
  let block: Uint8Array;
  if (sequence && ["IMIO", "STIL"].includes(sourceFormat)) {
    block = Bytes.repeat(new Uint8Array(1), 16);
  } else {
    block = concat(Uint8Array.from(code).reverse(), Uint8Array.of(0xff, 0xff, 0xff, 0xff), Bytes.repeat(new Uint8Array(1), 4), Uint8Array.of(0x01, 0x00, 0x00, 0x00));
  }
  return concat(
    code,
    Uint8Array.of(0x00, 0x05),
    ascii("\x00\x00\x00\x3a"), // 58 = total length
    Bytes.repeat(new Uint8Array(1), 20),
    block,
    Uint8Array.of(0x01),
    Bytes.repeat(new Uint8Array(1), 11),
  );
}

/**
 * Build the 602-byte still-importer TIFF `opti` asset-info body.
 *
 * Unlike PNG/EXR, AE does not re-read a TIFF from the located file, so it
 * needs this header for both stills and image sequences (an empty or generic
 * header crashes AE in both cases - AE 2026 measured). It is the
 * `PsdOptiChunk` header under the `TIF ` code, describing the image the
 * way AE reads it (AE 2026, footage_depth.aep).
 *
 * @param width - Image width in pixels.
 * @param height - Image height in pixels.
 * @param bitDepth - Bits per sample (1 for a bilevel image).
 * @param channels - Colour channels, plus one for an alpha sample or Photoshop layer data
 *   (`MediaInfo.pixel_channels`).
 * @param colorMode - The Photoshop colour mode the image reads as (`MediaInfo.color_mode`).
 * @param layerCount - The layer count AE records (see `FileSource`'s `_optiData`).
 */
export function buildTiffOptiData(
  width: number,
  height: number,
  bitDepth: number,
  channels: number,
  colorMode: number,
  layerCount: number,
): Uint8Array {
  const chunk = new PsdOptiChunk({
    assetType: "TIF ",
    pad12: concat(ascii(" FIT\x01"), Bytes.repeat(new Uint8Array(1), 7)),
    psdChannels: channels,
    psdCanvasWidth: width,
    psdCanvasHeight: height,
    psdBitDepth: bitDepth,
    psdColorMode: colorMode,
    psdLayerCount: layerCount,
  });
  chunk.psdGroupName = "";
  return chunk.tobytes();
}

/**
 * Build the 602-byte merged-PSD/PSB `opti` asset-info body.
 *
 * What AE 2026 writes for a Photoshop file imported as merged footage
 * (footage_depth.aep): the document's size, bit depth, channel count,
 * colour mode and layer count, the `0xFFFFFFFF` layer-index sentinel and
 * an empty trailing name. The layout lives on `PsdOptiChunk`.
 *
 * @param width - Full PSD canvas width in pixels.
 * @param height - Full PSD canvas height in pixels.
 * @param bitDepth - Bits per channel (1, 8, 16, or 32).
 * @param channels - The document's colour channels, plus one when it has alpha
 *   (`MediaInfo.pixel_channels`).
 * @param colorMode - The document's Photoshop colour mode.
 * @param layerCount - Number of layers in the PSD (0 for a flattened one).
 */
export function buildPsdOptiData(
  width: number,
  height: number,
  bitDepth: number,
  channels: number,
  colorMode: number,
  layerCount: number,
): Uint8Array {
  const chunk = new PsdOptiChunk({
    psdChannels: channels,
    psdCanvasWidth: width,
    psdCanvasHeight: height,
    psdBitDepth: bitDepth,
    psdColorMode: colorMode,
    psdLayerCount: layerCount,
  });
  chunk.psdGroupName = "";
  return chunk.tobytes();
}

/**
 * Build the 602-byte `8BPS` `opti` for a FLATTENED PSD/PSB imported as a
 * one-layer composition.
 *
 * The merged `buildPsdOptiData` of the layerless document (0 layers),
 * with 0x0A (`psdVectorOrMerged`) set to 1 - per-layer optis set it only
 * for a layer with a vector mask (AE 2026 byte-verified against a real
 * flattened RGB PSD, flattened_rgb_comp.aep).
 *
 * @param width - Canvas width in pixels.
 * @param height - Canvas height in pixels.
 * @param bitDepth - Bits per channel.
 * @param channels - The document's channel count (3 for RGB).
 * @param kw - Keyword arguments:
 * - `colorMode`: The document's Photoshop colour mode (3 = RGB).
 */
export function buildPsdFlattenedOptiData(
  width: number,
  height: number,
  bitDepth: number,
  channels: number,
  kw: { colorMode?: number } = {},
): Uint8Array {
  const { colorMode = 3 } = kw;
  const chunk = new PsdOptiChunk({
    psdVectorOrMerged: true,
    psdChannels: channels,
    psdCanvasWidth: width,
    psdCanvasHeight: height,
    psdBitDepth: bitDepth,
    psdColorMode: colorMode,
    psdLayerCount: 0,
  });
  chunk.psdGroupName = "";
  return chunk.tobytes();
}

/**
 * Build the 602-byte `8BPS` `opti` for one layer of a layered PSD import.
 *
 * When After Effects imports a layered Photoshop file as a composition, it
 * creates one footage item per layer, each referencing the same file with the
 * source layer selected. The selection is stored in this opti, identically for
 * a whole-canvas (`COMP`) or cropped (`COMP_CROPPED_LAYERS`) import - the crop
 * only changes the footage `sspc` dimensions and the comp-layer transform, not
 * this opti. It differs from the merged `buildPsdOptiData` (which keeps
 * the `0xFFFFFFFF` layer-index sentinel and an empty trailing name) in:
 *
 * - `psdVectorOrMerged`: 1 for a layer with a vector mask (a shape
 *   layer's included, enabled or not).
 * - `psdLayerIndex`: the 0-based layer index, clearing the merged sentinel.
 * - `psd_layer_top/left/bottom/right`: the layer's content bounding box
 *   (LE s32; `resolvers.psd_bounds.psd_layer_box`) - NOT the canvas.
 * - `psdLayerChannels`: the layer's channels for a raster layer - the
 *   document's colour channels plus one for its transparency (4 for an RGB
 *   layer, including a fully transparent one with an empty content box; 3
 *   for an RGB Background layer; 2 for a gray layer) - and 0 for an
 *   adjustment layer (which contributes no pixel channels).
 * - `psdLayerId`: the Photoshop layer id (`lyid`, LE u32).
 * - the trailing name block (`psdGroupName`): the layer name,
 *   NUL-terminated UTF-8.
 *
 * The `psd_canvas_*` fields keep the full document size, and
 * `psdChannels`/`psdColorMode` the document's channel count and colour
 * mode (2 and grayscale for every layer of a gray document with
 * transparency, footage_depth.aep). Byte-verified against AE 2026's
 * `COMP`/`COMP_CROPPED_LAYERS` import of `8bits.psd`/`.psb` and a margined
 * 3-layer PSD.
 *
 * @param canvasWidth - Full document width in pixels.
 * @param canvasHeight - Full document height in pixels.
 * @param bitDepth - Bits per channel.
 * @param layerCount - Total layers in the document.
 * @param layerIndex - 0-based document index of this layer (bottom first).
 * @param layerId - Photoshop layer id (`lyid`).
 * @param layerName - Layer name.
 * @param bounds - The layer's content box as `(left, top, right, bottom)`.
 * @param isAdjustment - Whether the layer is an adjustment layer.
 * @param hasVectorMask - Whether the layer has a vector mask.
 * @param kw - Keyword arguments:
 * - `channels`: The document's colour channels, plus one when it has alpha
 *     (`MediaInfo.pixel_channels`); 4 for an RGB document with transparency.
 * - `colorMode`: The document's Photoshop colour mode (3 = RGB).
 * - `layerChannels`: The layer's channels when it is a raster layer; 4 for an RGB layer with
 *     transparency.
 */
export function buildPsdLayerOptiData(
  canvasWidth: number,
  canvasHeight: number,
  bitDepth: number,
  layerCount: number,
  layerIndex: number,
  layerId: number,
  layerName: string,
  bounds: [number, number, number, number],
  isAdjustment = false,
  hasVectorMask = false,
  kw: { channels?: number; colorMode?: number; layerChannels?: number } = {},
): Uint8Array {
  const { channels = 4, colorMode = 3, layerChannels = 4 } = kw;
  const [left, top, right, bottom] = bounds;
  const chunk = new PsdOptiChunk({
    psdVectorOrMerged: hasVectorMask,
    psdLayerIndex: layerIndex,
    psdChannels: channels,
    psdCanvasWidth: canvasWidth,
    psdCanvasHeight: canvasHeight,
    psdBitDepth: bitDepth,
    psdColorMode: colorMode,
    psdLayerCount: Math.max(layerCount, 1),
    psdLayerTop: top,
    psdLayerLeft: left,
    psdLayerBottom: bottom,
    psdLayerRight: right,
    // The raster layer's channels - even for a fully transparent layer
    // whose content box is empty (psd_clipping_mask "Layer 1") - and 0
    // for an adjustment layer, which has no pixel channels
    // (grouped_layers "hue/sat adj"). AE 2026 measured; the empty content
    // box alone does NOT drop the channels.
    psdLayerChannels: isAdjustment ? 0 : layerChannels,
    psdLayerId: layerId,
  });
  chunk.psdGroupName = layerName;
  return chunk.tobytes();
}

/**
 * Build the 48-byte `opti` asset-info body for a DPX / Cineon file or sequence.
 *
 * AE writes an `sDPX` format-options header identical to the `CineonRoptChunk`
 * render-options layout. Verified: AE 2026 media_gap_formats.aep fixture
 * writes this exact 48-byte body for every DPX and Cineon item.
 */
export function buildDpxOptiData(): Uint8Array {
  return new CineonRoptChunk().tobytes();
}

/** Length of the `oEXR` opti body AE 2026 writes for every OpenEXR file. */
export const _OEXR_OPTI_SIZE = 9750;

/**
 * Build the 9750-byte OpenEXR (`oEXR`) `opti` asset-info body.
 *
 * AE writes it for EXR stills and sequences. Without it AE renders a data
 * window that differs from the display window misplaced, and crashed
 * rendering one larger than the display window (AE 2026). The header
 * (bytes 0x00-0x2F, little-endian after the length) carries the compression
 * code at 0x0E, the channel count of all parts at 0x12, and at 0x2E that
 * count plus one per named layer (a part name, or the prefix of a
 * `layer.channel` name). The rest of AE's bytes vary from import to
 * import; zeros render the same (verified against AE's own imports,
 * exr_options.aep).
 */
export function buildExrOptiData(compression: number, channelNames: readonly string[]): Uint8Array {
  const layers = new Set(
    channelNames.filter((name) => name.includes(".")).map((name) => name.slice(0, name.lastIndexOf("."))),
  );
  const body = new Uint8Array(_OEXR_OPTI_SIZE);
  body.set(ascii("oEXR"), 0);
  struct.packInto(">HI", body, 4, 1, _OEXR_OPTI_SIZE);
  struct.packInto("<HHHHH", body, 0x0a, 1, 0, compression, 1, channelNames.length);
  struct.packInto("<H", body, 0x2e, channelNames.length + layers.size);
  return body;
}

/**
 * Build the 30-byte Radiance HDR (`RHDR`) `opti` asset-info body.
 *
 * AE refuses an empty or generic `opti` for HDR, but the dimensions are
 * stored in `sspc` (not this opti), so the body is a fixed template. The
 * `assetTypeInt` is 0x002e (46), distinguishing it from the generic
 * 0x0005 and the still-importer 0x0109. Reverse-engineered from AE 2026;
 * AE's own opti carries a file-system fingerprint in the trailing 8 bytes
 * that AE re-derives on a cache miss, so it is left zero here.
 */
export function buildRhdrOptiData(): Uint8Array {
  return concat(
    ascii("RHDR"),
    Uint8Array.of(0x00, 0x2e),
    struct.pack(">I", 30), // total length (big-endian)
    Uint8Array.of(0x02, 0x00),
    Bytes.repeat(new Uint8Array(1), 18),
  );
}

/**
 * Build the 30-byte Camera Raw (`Craw`) `opti` asset-info body.
 *
 * The `RHDR` layout with a zero flag word: what AE 2026 writes for a
 * camera raw file it holds no develop settings for (it rewrites a generic
 * `opti` into this on resave). An import carries its default settings as
 * base64 XMP after the header instead, which renders the same image
 * (compared frame by frame). The dimensions live in `sspc`.
 */
export function buildCrawOptiData(): Uint8Array {
  return concat(ascii("Craw"), Uint8Array.of(0x00, 0x2e), struct.pack(">I", 30), Bytes.repeat(new Uint8Array(1), 20));
}

/**
 * Build the bare 596-byte `TEXT` `opti` asset-info body of an EPS file.
 *
 * What AE 2026 writes for eps.eps (1921x2881) imported as footage: the
 * page size and nothing else - no layer count, page count or page-size
 * tail, which an Illustrator/PDF document carries
 * (`buildAiDocumentOptiData`). The layout lives on `TextOptiChunk`.
 */
export function buildTextOptiData(width: number, height: number): Uint8Array {
  return new TextOptiChunk({ textWidth: width, textHeight: height }).tobytes();
}

/**
 * Build the 596-byte `TEXT` `opti` of an Illustrator/PDF file imported
 * whole.
 *
 * The bare body (`buildTextOptiData`) plus the document's layer count,
 * a page count of 1 and the page-size tail; no layer is chosen, so the
 * layer name and visibility stay empty. Byte-verified against AE 2026's
 * import of ai.ai, complex.ai, pdf.pdf, ai_no_pdf.ai and two more PDFs
 * (footage_depth.aep).
 *
 * @param width - Page width in points.
 * @param height - Page height in points.
 * @param layerCount - How many layers the document has (0 when it has none py_aep can read, as AE
 *   writes for a file without Optional Content Groups).
 */
export function buildAiDocumentOptiData(width: number, height: number, layerCount: number): Uint8Array {
  return buildAiLayerOptiData(width, height, "", layerCount, undefined, false);
}

/**
 * Build the 596-byte `TEXT` `opti` for one layer of a layered AI/PDF import.
 *
 * When After Effects imports a layered Illustrator/PDF file as a composition,
 * it creates one footage item per layer, each referencing the same file with
 * its source layer selected. The selection is stored entirely in this opti.
 * It extends `buildTextOptiData` with:
 *
 * - `textDocumentLayers` (0x30): the source document's layer count.
 * - `textElementCount` (0x3C): element/page count (1).
 * - `textLayerVisible` (0x3D): the source layer's visibility in the
 *   Illustrator/PDF document (`false` for a layer the file's default
 *   configuration hides).
 * - `textLayerName` (0x44): the layer name, NUL-terminated.
 * - `textPageHeight`/`textPageWidth` (0x248/0x24C): the redundant
 *   page-dimension tail (BE u16).
 *
 * Bytes 0x10-0x1F hold the artwork bounding box as `(x0, y0, x1, y1)` in
 * page points, four signed BE 16.16 values. Document Size keeps the
 * full-page box `(0, 0, width, height)` that `buildTextOptiData`
 * already writes (its "dimensions at 24/28" are that box's integral x1/y1
 * parts). A chosen layer imported at Layer Size stores the layer's actual
 * artwork box - fractional, and offset from the page origin - from which
 * AE derives the integer footage pixel dimensions by ceiling the box size
 * with a 1px floor (an empty layer stores a `1/65536` epsilon box).
 * Byte-verified against AE 2026's import of ai.ai ("Calque 1"/"Calque 2",
 * 612x792) and its Choose Layer footage imports at both Footage
 * Dimensions settings (`ai_choose_layer*.aep`: Calque 1 artwork box
 * 112.748, 239.507, 593.931, 675.999 -\> 482x437 footage).
 *
 * @param width - Document width in points.
 * @param height - Document height in points.
 * @param layerName - The referenced layer's name.
 * @param layerCount - How many layers the source document has.
 * @param artworkBounds - The layer's artwork box `(x0, y0, x1, y1)` in page points for a Layer
 *   Size import; `null` keeps the full-page box (Document Size and comp imports).
 * @param visible - The layer's visibility in the source document
 *   (`resolvers.ai_layers.AiLayer.visible`).
 */
export function buildAiLayerOptiData(
  width: number,
  height: number,
  layerName: string,
  layerCount: number,
  artworkBounds: [number, number, number, number] | null = null,
  visible = true,
): Uint8Array {
  const chunk = new TextOptiChunk({
    textWidth: width,
    textHeight: height,
    textDocumentLayers: layerCount,
    textElementCount: 1,
    textLayerVisible: visible,
    textLayerName: decode(truncateUtf8(layerName, 255), "utf-8"),
    textPageHeight: height,
    textPageWidth: width,
  });
  const buf = new Uint8Array(chunk.tobytes());
  if (artworkBounds != null) {
    // Layer Size import: overlay the layer's artwork box as four signed
    // BE 16.16 values, replacing the full-page x0/y0/x1/y1 that the typed
    // fields wrote (the fractional/offset bytes live in TextOptiChunk
    // padding, so a parse round-trip stays byte-faithful).
    struct.packInto(">4i", buf, 0x10, ...artworkBounds.map((v) => round(v * 65536)));
  }
  return buf;
}

type _OptiReadKw = ChunkReadKwargs;

/**
 * Footage asset info chunk (polymorphic).
 *
 * Layout depends on `assetType` (first 4 bytes). The base class
 * dispatches to variant subclasses; unknown asset types fall back
 * to raw bytes.
 */
export class OptiChunk extends Chunk {
  declare chunkType: string;

  static read(fp: IO, size: number, kw?: _OptiReadKw): OptiChunk;
  static read(fp: IO, size: number, kw: _OptiReadKw = {}): Chunk {
    const { chunkType = "" } = kw;
    if (this !== OptiChunk) {
      // Variant subclass - use its own read
      return super.read(fp, size, { chunkType }); // returns Self
    }
    if (size < 6) {
      return new this({ chunkType, data: readBytes(fp, size) });
    }
    // Peek at discriminator (first 4 bytes = asset_type)
    const discRaw = readBytes(fp, 6);
    const nul = Bytes.indexOf(discRaw, new Uint8Array(1), 0, 4);
    const assetType = decode(discRaw.slice(0, nul >= 0 ? nul : 4), "ascii");
    const assetTypeInt = struct.unpack(">H", discRaw.slice(4, 6))[0];
    fp.seek(-6, 1);
    // Placeholder: asset_type is empty but asset_type_int == 2
    if (!assetType && assetTypeInt === 2) {
      return PlaceholderOptiChunk.read(fp, size, { chunkType });
    }
    const variantCls = _OPTI_VARIANTS.get(assetType) ?? OptiChunk;
    if (variantCls === OptiChunk) {
      return new this({ chunkType, data: readBytes(fp, size) });
    }
    return variantCls.read(fp, size, { chunkType });
  }
}

define(OptiChunk, {
  chunkType: field({ default: "opti" }),
});

register("opti")(OptiChunk);

/**
 * Solid footage asset (asset_type='Soli').
 *
 * All fields are big-endian and fixed-layout -\> fmt_field.
 */
export class SoliOptiChunk extends OptiChunk {
  declare assetType: string;
  declare assetTypeInt: number;
  declare _pad: Uint8Array;
  /** Solid color red component (0.0-1.0). */
  declare colorR: number;
  /** Solid color green component (0.0-1.0). */
  declare colorG: number;
  /** Solid color blue component (0.0-1.0). */
  declare colorB: number;
  /** Solid item name. */
  declare solidName: string;

  /** Solid color as [R, G, B] in 0.0-1.0 range. */
  get color(): number[] {
    return [this.colorR, this.colorG, this.colorB];
  }

  set color(value: number[]) {
    this.colorR = value[0];
    this.colorG = value[1];
    this.colorB = value[2];
  }
}

define(SoliOptiChunk, {
  assetType: asciiField(4, { default: "Soli" }),
  assetTypeInt: u2Field({ default: 9 }),
  _pad: bytesField(8, { default: ascii("\x00\x00\x01\x1a\x3f\x80\x00\x00"), repr: false }),
  colorR: f4Field(),
  colorG: f4Field(),
  colorB: f4Field(),
  solidName: strField(256, { default: "", encoding: "utf-8" }),
});

/**
 * PSD footage asset (asset_type='8BPS').
 *
 * Fixed 602-byte still-importer layout (AE 2026): 344 bytes of typed
 * fields plus the 258-byte trailing layer-name block exposed via
 * `psdGroupName`. Field defaults reproduce AE's merged-import header,
 * so the `build_psd_*_opti_data` builders only set what differs.
 */
export class PsdOptiChunk extends OptiChunk {
  declare assetType: string;
  declare assetTypeInt: number;
  /** Total opti body length AE bakes into the header. */
  declare _totalLength: number;

  /**
   * `true` for a layer with a vector mask (a shape layer's included,
   * enabled or disabled) and for the merged still of a flattened (layerless)
   * file imported as a one-layer composition; other per-layer and plain
   * merged optis leave it `false` (measured on AE 2026).
   */
  declare psdVectorOrMerged: boolean;

  declare _pad0b: Uint8Array;
  /** 0-based layer index. 0xFFFFFFFF = merged/flattened. */
  declare psdLayerIndex: number;

  declare _pad12: Uint8Array;
  /**
   * The document's channel count as AE reads it: its colour channels, plus
   * one when it has alpha (3 RGB, 4 RGB + alpha or CMYK, 1 grayscale, 2
   * grayscale + alpha). Every opti of a document stores the same count, a
   * layer's included (AE 2026).
   */
  declare psdChannels: number;

  declare _pad1f: Uint8Array;
  /** Full PSD canvas height in pixels (LE u4). */
  declare psdCanvasHeight: number;

  /** Full PSD canvas width in pixels (LE u4). */
  declare psdCanvasWidth: number;

  /**
   * Bit depth per channel (1, 8, 16, or 32). Low byte of a LE u2 whose
   * high byte stays 0 in `_pad29`.
   */
  declare psdBitDepth: number;

  declare _pad29: Uint8Array;
  /**
   * The document's Photoshop colour mode (0 bitmap, 1 grayscale, 2
   * indexed, 3 RGB, 4 CMYK, 9 Lab); a TIFF stores the mode it reads as. Low
   * byte of a LE u2.
   */
  declare psdColorMode: number;

  declare _pad2b: Uint8Array;
  /**
   * Total number of layers in the document; 0 for a flattened one. A
   * 16-bit field: AE 2026 writes 300 as `2c 01` for a 300-layer document.
   */
  declare psdLayerCount: number;

  declare _pad32: Uint8Array;
  /** Layer bounding box top (LE s4, can be negative). */
  declare psdLayerTop: number;

  /** Layer bounding box left (LE s4, can be negative). */
  declare psdLayerLeft: number;

  /** Layer bounding box bottom (LE s4). */
  declare psdLayerBottom: number;

  /** Layer bounding box right (LE s4). */
  declare psdLayerRight: number;

  /**
   * Channel count of the referenced layer: 4 (RGBA) for pixel content,
   * 0 for an empty content box (e.g. an adjustment layer) and for merged
   * imports.
   */
  declare psdLayerChannels: number;

  declare _pad5f: Uint8Array;
  /** Photoshop layer id (`lyid`, LE u4); 0 for merged/flattened. */
  declare psdLayerId: number;

  /**
   * PSD group/folder name (NUL-terminated UTF-8 at end of chunk).
   *
   * Empty for a merged import, where the trailing region is all-NUL.
   */
  get psdGroupName(): string {
    return decode(Bytes.split(this._trailing, new Uint8Array(1), 1)[0], "utf-8");
  }

  set psdGroupName(value: string) {
    // AE writes a fixed 602-byte opti: keep the trailing name block
    // NUL-padded to 258 bytes so the chunk size is preserved.
    this._trailing = Bytes.padEnd(truncateUtf8(value, 255), 258, 0);
  }
}

define(PsdOptiChunk, {
  assetType: asciiField(4, { default: "8BPS" }),
  assetTypeInt: u2Field({ default: 265 }),
  _totalLength: u4Field({ default: 602, repr: false }),

  psdVectorOrMerged: boolField(),

  _pad0b: bytesField(3, { default: Uint8Array.of(0x00, 0x01, 0x01), repr: false }),
  psdLayerIndex: u4Field({ default: 0xffffffff }),

  _pad12: bytesField(12, { default: concat(ascii("SPB8\x01"), Bytes.repeat(new Uint8Array(1), 7)), repr: false }),
  psdChannels: u1Field({ default: 4 }),

  _pad1f: bytesField(1, { repr: false }),
  psdCanvasHeight: u4Field({ endian: "<" }),

  psdCanvasWidth: u4Field({ endian: "<" }),

  psdBitDepth: u1Field({ default: 8 }),

  _pad29: bytesField(1, { repr: false }),
  psdColorMode: u1Field({ default: 3 }),

  _pad2b: bytesField(5, { repr: false }),
  psdLayerCount: u2Field({ default: 1, endian: "<" }),

  _pad32: bytesField(28, { repr: false }),
  psdLayerTop: s4Field({ endian: "<" }),

  psdLayerLeft: s4Field({ endian: "<" }),

  psdLayerBottom: s4Field({ endian: "<" }),

  psdLayerRight: s4Field({ endian: "<" }),

  psdLayerChannels: u1Field(),

  _pad5f: bytesField(245, { repr: false }),
  psdLayerId: u4Field({ endian: "<" }),
});

/**
 * AI/EPS/PDF footage asset (asset_type='TEXT').
 *
 * Fixed 596-byte layout (AE 2026). For a layered Illustrator/PDF import
 * each footage item selects its source layer via `textLayerName`;
 * whole-document footage (and EPS) leaves it empty. Field defaults
 * reproduce AE's whole-document header, so the `build_*_opti_data`
 * builders only set what differs.
 */
export class TextOptiChunk extends OptiChunk {
  declare assetType: string;
  declare assetTypeInt: number;
  /** Total opti body length AE bakes into the header. */
  declare _totalLength: number;

  declare _pad0a: Uint8Array;
  /**
   * Artwork/page width in pixels: the integer part of the BE 16.16
   * artwork-bbox right at 0x18 (the bbox left/top at 0x10/0x14 stay 0 for a
   * full-page import).
   */
  declare textWidth: number;

  declare _pad1a: Uint8Array;
  /**
   * Artwork/page height in pixels (integer part of the 16.16 bbox
   * bottom at 0x1C).
   */
  declare textHeight: number;

  declare _pad1e: Uint8Array;
  declare _pad28: Uint8Array;
  declare _pad2c: Uint8Array;
  /**
   * How many layers the source document has (not this binding's index), a
   * 32-bit word, written for whole-document footage too. Zero for an EPS
   * file and for a document without layers.
   *
   * Read as a color-space flag until AE 2026 fixtures with more than eight
   * layers turned up: ai.ai (CMYK) writes 2 and complex.ai (RGB) writes 8,
   * which happen to look like color codes, but ai_bounds_probe.pdf writes 22
   * and std14_probe.pdf 48 - their layer counts.
   */
  declare textDocumentLayers: number;

  declare _pad34: Uint8Array;
  /**
   * Element/page count: 1 for Illustrator/PDF footage (a whole document
   * or one of its layers), 0 for an EPS file.
   */
  declare textElementCount: number;

  /**
   * The source layer's visibility in the Illustrator/PDF document: `false`
   * for a layer listed in the file's `/OCProperties` `/D` `/OFF` array, which
   * AE also imports with its comp-layer video switch off. Zero for
   * whole-document footage, which has no source layer.
   *
   * Not a "references a layer" flag: AE writes 0 here for a hidden layer's
   * footage, which is a layer binding all the same (`textLayerName` and the
   * `sspc` layer index are both set). Reading it as one made those bindings
   * look like whole-document footage.
   */
  declare textLayerVisible: boolean;

  declare _pad3e: Uint8Array;
  /** Selected source layer name (NUL-padded UTF-8); empty for whole-document footage. */
  declare textLayerName: string;

  declare _pad144: Uint8Array;
  /** Redundant page-dimension tail (height); 0 for an EPS file. */
  declare textPageHeight: number;

  declare _pad24a: Uint8Array;
  /** Redundant page-dimension tail (width); 0 for an EPS file. */
  declare textPageWidth: number;

  declare _pad24e: Uint8Array;
}

define(TextOptiChunk, {
  assetType: asciiField(4, { default: "TEXT" }),
  assetTypeInt: u2Field({ default: 8 }),
  _totalLength: u4Field({ default: 596, repr: false }),

  _pad0a: bytesField(14, { repr: false }),
  textWidth: u2Field(),

  _pad1a: bytesField(2, { repr: false }),
  textHeight: u2Field(),

  _pad1e: bytesField(10, { repr: false }),
  _pad28: bytesField(4, { default: Uint8Array.of(0xff, 0xff, 0xff, 0xff), repr: false }),
  _pad2c: bytesField(4, { repr: false }),
  textDocumentLayers: u4Field(),

  _pad34: bytesField(8, { repr: false }),
  textElementCount: u1Field(),

  textLayerVisible: boolField(),

  _pad3e: bytesField(6, { repr: false }),
  textLayerName: strField(256),

  _pad144: bytesField(260, { repr: false }),
  textPageHeight: u2Field(),

  _pad24a: bytesField(2, { repr: false }),
  textPageWidth: u2Field(),

  _pad24e: bytesField(6, { repr: false }),
});

/** Placeholder footage asset (asset_type_int=2). */
export class PlaceholderOptiChunk extends OptiChunk {
  declare assetType: string;
  declare assetTypeInt: number;
  declare _pad: Uint8Array;
  /** Placeholder name (256-byte NUL-padded UTF-8). */
  declare placeholderName: string;
}

define(PlaceholderOptiChunk, {
  assetType: asciiField(4, { default: "" }),
  assetTypeInt: u2Field({ default: 2 }),
  _pad: bytesField(4, { default: Uint8Array.of(0x00, 0x00, 0x01, 0x0a), repr: false }),
  placeholderName: strField(256, { default: "", encoding: "utf-8" }),
});

export const _OPTI_VARIANTS = new Map<string, typeof OptiChunk>([
  ["Soli", SoliOptiChunk],
  ["8BPS", PsdOptiChunk],
  ["TEXT", TextOptiChunk],
]);
