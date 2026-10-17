/**
 * Footage chunk types: sspc (source settings), opti (asset info).
 *
 * SspcChunk uses `fmt_field()` for all fixed-layout fields with `BitField`
 * descriptors for alpha flags.
 * OptiChunk uses variant subclass dispatch: SoliOptiChunk, PsdOptiChunk and
 * TextOptiChunk (fmt_field, some LE), PlaceholderOptiChunk. The `build_*`
 * opti builders serialize the typed variant chunks, so the read and write
 * paths share one layout definition.
 */

import {
  b,
  bytes_,
  concat,
  decode,
  define,
  descriptor,
  encode,
  field,
  int,
  OverflowError,
  round,
  struct,
} from "../../pyrt/index.ts";
import type { IO } from "../../pyrt/index.ts";
import { MAC_EPOCH_OFFSET, read_bytes, to_dividend_divisor, to_fixed_16_16, truncate_utf8 } from "./bin_utils.ts";
import { BitField } from "./bitfield.ts";
import { Chunk, type ChunkReadKwargs } from "./chunk.ts";
import { ascii_field, bool_field, bytes_field, f4_field, f8_field, s2_field, s4_field, str_field, u1_field, u2_field, u4_field, u8_field } from "./fmt_field.ts";
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
  declare chunk_type: string;

  // -- Reserved (bytes 0-21) ---------------------------------------------
  declare _reserved_00: Uint8Array;

  // -- Source format (bytes 22-31) ---------------------------------------
  /** 4-char code: 'png!', '8BPS', 'MOoV', 'Soli', etc. */
  declare source_format_type: string;

  declare _reserved_1a: Uint8Array;

  // -- Dimensions / duration (bytes 32-45) -------------------------------
  declare width: number;
  declare _reserved_22: Uint8Array;
  declare height: number;
  declare duration_dividend: number;
  declare duration_divisor: number;

  // -- Frame rate (bytes 46-68) ------------------------------------------
  declare _reserved_2e: Uint8Array;
  declare _time_base: number;
  declare _reserved_36: Uint8Array;
  declare native_frame_rate_integer: number;
  declare native_frame_rate_fractional: number;
  /**
   * Byte 0x3E: the source's pixel depth in bits per pixel, as the AE SDK's
   * `AEIO_InputDepth`: 24 / 48 / 96 for RGB at 8 / 16 / 32 bpc, 32 / 64 / 128
   * with alpha, 40 / -16 / -32 for grayscale, 8 for indexed color, 0 for
   * media without video. AE does not re-read most formats on open, so a wrong
   * value renders the footage without its alpha (AE 2026).
   */
  declare depth: number;

  /** `01 01` on every file source, `00 00` on solids and placeholders. */
  declare _reserved_40: Uint8Array;

  declare _reserved_42: Uint8Array;

  // -- Alpha flags (byte 69) ---------------------------------------------
  /** Byte 69: bit 1 = invert_alpha, bit 0 = premultiplied. */
  declare _alpha_flags: number;

  // -- Premul color / alpha mode (bytes 70-73) ---------------------------
  declare premul_color_r: number;
  declare premul_color_g: number;
  declare premul_color_b: number;
  /** Alpha interpretation mode. 3 = no alpha channel. */
  declare alpha_mode_raw: number;

  // -- Field separation (bytes 74-87) ------------------------------------
  /**
   * Bytes 0x4A-0x4E: source field information. AE fills the first four
   * with the QuickTime `FIEL` tag for media that declares field handling and
   * leaves them zero otherwise.
   */
  declare _reserved_4a: Uint8Array;

  /**
   * Byte 0x4F: set on every source read from a file, and left clear on a
   * solid or a placeholder (AE 2026, across 527 sample footage items).
   */
  declare from_file: boolean;

  declare _reserved_50: Uint8Array;
  /** 0 = OFF, 1 = enabled (check field_order for upper/lower). */
  declare field_separation_type_raw: number;

  declare _reserved_54: Uint8Array;
  declare field_order: number;

  // -- Reserved / footage state (bytes 88-128) ---------------------------
  declare _reserved_58: Uint8Array;
  declare _is_synthetic_a: number;
  declare _reserved_6b: Uint8Array;
  declare _is_synthetic_b: number;
  declare _reserved_6e: Uint8Array;
  /** Byte 0x70: bit 3 = `media_format`. */
  declare _flags_70: number;

  declare _reserved_71: Uint8Array;
  /** Byte 0x73: bit 0 = `footage_missing_at_save`. */
  declare _flags_73: number;

  /**
   * Bytes 0x74-0x7C: the source's last-modified stamp (see
   * `source_modified`). AE compares it against the file on open to decide
   * whether the cached asset info in this chunk is still current.
   */
  declare _source_stamp: Uint8Array;

  declare _depth_flag: number;

  // -- Loop / pixel ratio (bytes 126-146) --------------------------------
  /**
   * Loop count (1 = no loop, 2+ = loop count). Stored as a 4-byte
   * big-endian field (AE writes e.g. 1000 as 00 00 03 e8); a u1 here read
   * only the low byte and overflowed on save for counts \> 255.
   */
  declare loop: number;

  declare _reserved_82: Uint8Array;
  declare _is_synthetic_c: number;
  declare _reserved_87: Uint8Array;
  declare pixel_aspect_dividend: number;
  declare pixel_aspect_divisor: number;
  declare _reserved_90: Uint8Array;

  // -- Pulldown / conform (bytes 147-158) --------------------------------
  declare _remove_pulldown_value: number;

  /** 0 = no conforming. */
  declare conform_frame_rate_integer: number;

  declare conform_frame_rate_fractional: number;
  declare display_frame_rate_integer: number;
  declare display_frame_rate_fractional: number;
  declare _reserved_9c: Uint8Array;
  /**
   * Byte 0x9F: bit 0 = `high_quality_field_separation`, bit 3 =
   * `media_file`.
   */
  declare _flags_9f: number;

  // -- Audio / sequence (bytes 160-183) ----------------------------------
  /** Sample rate in Hz (0.0 = no audio). */
  declare audio_sample_rate: number;

  declare _reserved_a8: Uint8Array;
  declare start_frame: number;
  declare end_frame: number;
  /** Zero-padded digit count for image sequences (0 for non-sequences). */
  declare frame_padding: number;

  // -- Extended settings (bytes 184-221) ---------------------------------
  declare _reserved_b8: Uint8Array;
  /**
   * Byte 0xB9: `true` when the sequence was imported with a user-set
   * frame range. AE sets it for ranged imports only - a sequence with
   * missing interior frames but no range keeps 0 (probed range fixtures,
   * AE 2026).
   */
  declare frame_range_set: boolean;

  declare _reserved_ba: Uint8Array;
  /**
   * Byte 0xBC: Photoshop layer id (`lyid`) when the footage references a
   * single layer of a layered file; `0xFFFFFFFF` otherwise (merged,
   * whole-file, and AI/PDF layers, which have no ids).
   */
  declare layer_id: number;

  /**
   * Byte 0xC0: 0-based index of the referenced layer (PSD: document
   * record index counting group dividers; AI/PDF: OCG order). `0xFFFFFFFF`
   * for merged/whole-file footage; placeholders store `0xFFFFFFFE`.
   */
  declare layer_index: number;

  declare _reserved_c4: Uint8Array;
  /**
   * Byte 0xC7: `true` when the footage spans its full source frame
   * (including a chosen layer imported at Document Size), `false` for a
   * layer cropped to its content box (`COMP_CROPPED_LAYERS` or a chosen
   * layer imported at Layer Size). Written only for file footage;
   * solids/placeholders leave it `false`.
   */
  declare full_frame: boolean;

  declare _reserved_c8: Uint8Array;
  declare _reserved_ca: Uint8Array;
  /**
   * Byte 0xCC: cached source data size (64-bit). For a PSD layer (chosen
   * or comp-imported) the content box's pixel bytes (`w * h * 4` at 8 bpc);
   * for merged PSD footage and TIFF stills the decoded canvas; for whole
   * files (PNG, AI, ...) and sequences the file sizes on disk. AE re-derives
   * it on a cache miss, so `0` is accepted.
   */
  declare data_size: number | bigint;
  declare _reserved_d4: Uint8Array;

  // -- BitField descriptors (not attrs fields) ---------------------------
  declare invert_alpha: boolean;
  declare premultiplied: boolean;
  /** 0 = found, 1 = missing or placeholder. */
  declare footage_missing_at_save: boolean;
  declare high_quality_field_separation: boolean;
  /**
   * Set by AE's import for JPEG, BMP/GIF, HEIC, movie, audio and data
   * footage, single files and sequences alike (AE 2026).
   */
  declare media_format: boolean;
  /** As `media_format`, for single files only (clear on a sequence). */
  declare media_file: boolean;

  // -- Computed properties -----------------------------------------------

  /** Native frame rate (integer + fractional/65536). */
  get native_frame_rate(): number {
    return this.native_frame_rate_integer + this.native_frame_rate_fractional / 65536.0;
  }

  set native_frame_rate(value: number) {
    [this.native_frame_rate_integer, this.native_frame_rate_fractional] = to_fixed_16_16(value);
    this._update_display_frame_rate();
  }

  /** Conform frame rate (integer + fractional/65536). 0 = no conform. */
  get conform_frame_rate(): number {
    return this.conform_frame_rate_integer + this.conform_frame_rate_fractional / 65536.0;
  }

  set conform_frame_rate(value: number) {
    [this.conform_frame_rate_integer, this.conform_frame_rate_fractional] = to_fixed_16_16(value);
    this._update_display_frame_rate();
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
  get source_modified(): number {
    const stamp = bytes_.int_from_bytes(bytes_.slice(this._source_stamp, 2, 6), "big");
    return stamp ? stamp - MAC_EPOCH_OFFSET : 0;
  }

  set source_modified(value: number) {
    const stamp = value ? int(value) + MAC_EPOCH_OFFSET : 0;
    // int.to_bytes raises OverflowError (not ValueError) when the value does not fit
    if (stamp < 0) throw new OverflowError("can't convert negative int to unsigned");
    if (stamp >= 2 ** 32) throw new OverflowError("int too big to convert");
    this._source_stamp = concat(b("\x00\x00"), bytes_.int_to_bytes(stamp, 4, "big"), bytes_.repeat(b("\x00"), 3));
  }

  /** Duration in seconds (dividend / divisor). */
  get duration(): number {
    if (this.duration_divisor === 0) {
      return 0.0;
    }
    return this.duration_dividend / this.duration_divisor;
  }

  set duration(value: number) {
    [this.duration_dividend, this.duration_divisor] = to_dividend_divisor(value);
  }

  /** Pixel aspect ratio (dividend / divisor). */
  get pixel_aspect(): number {
    if (this.pixel_aspect_divisor === 0) {
      return 1.0;
    }
    return this.pixel_aspect_dividend / this.pixel_aspect_divisor;
  }

  set pixel_aspect(value: number) {
    [this.pixel_aspect_dividend, this.pixel_aspect_divisor] = to_dividend_divisor(value);
  }

  /** Premultiply color as [R, G, B] in 0.0-1.0 range. */
  get premul_color(): number[] {
    return [this.premul_color_r / 255, this.premul_color_g / 255, this.premul_color_b / 255];
  }

  set premul_color(value: number[]) {
    this.premul_color_r = round(value[0] * 255);
    this.premul_color_g = round(value[1] * 255);
    this.premul_color_b = round(value[2] * 255);
  }

  /** Field separation type (0=off, 1=upper_first, 2=lower_first). */
  get field_separation_type(): number {
    if (this.field_separation_type_raw === 0) {
      return 0;
    }
    return this.field_order + 1;
  }

  set field_separation_type(value: number) {
    if (value === 0) {
      this.field_separation_type_raw = 0;
      this.field_order = 0;
    } else {
      this.field_separation_type_raw = 1;
      this.field_order = value - 1;
    }
  }

  /** Whether the footage has an alpha component. */
  get has_alpha(): boolean {
    return this.alpha_mode_raw !== 3;
  }

  /** 0 = OFF, 1-10 = pulldown phase. */
  get remove_pulldown(): number {
    return this._remove_pulldown_value;
  }

  set remove_pulldown(value: number) {
    this._remove_pulldown_value = value;
    this._update_display_frame_rate();
  }

  /** Effective frame rate as displayed. */
  get display_frame_rate(): number {
    const conform = this.conform_frame_rate;
    const base = conform !== 0 ? conform : this.native_frame_rate;
    return base * (this._remove_pulldown_value !== 0 ? 0.8 : 1.0);
  }

  set display_frame_rate(value: number) {
    [this.display_frame_rate_integer, this.display_frame_rate_fractional] = to_fixed_16_16(value);
  }

  /** Recompute and store display_frame_rate from current settings. */
  _update_display_frame_rate(): void {
    const conform = this.conform_frame_rate;
    const base = conform !== 0 ? conform : this.native_frame_rate;
    this.display_frame_rate = base * (this._remove_pulldown_value !== 0 ? 0.8 : 1.0);
  }
}

define(SspcChunk, {
  chunk_type: field({ default: "sspc" }),

  // -- Reserved (bytes 0-21) ---------------------------------------------
  _reserved_00: bytes_field(22, { repr: false }),

  // -- Source format (bytes 22-31) ---------------------------------------
  source_format_type: ascii_field(4),

  _reserved_1a: bytes_field(6, { repr: false }),

  // -- Dimensions / duration (bytes 32-45) -------------------------------
  width: u2_field(),
  _reserved_22: bytes_field(2, { repr: false }),
  height: u2_field(),
  duration_dividend: u4_field({ default: 1 }),
  duration_divisor: u4_field({ default: 1 }),

  // -- Frame rate (bytes 46-68) ------------------------------------------
  _reserved_2e: bytes_field(6, { repr: false }),
  _time_base: u2_field({ default: 600 }),
  _reserved_36: bytes_field(2, { repr: false }),
  native_frame_rate_integer: u4_field(),
  native_frame_rate_fractional: u2_field(),
  depth: s2_field(),

  _reserved_40: bytes_field(2, { repr: false }),

  _reserved_42: bytes_field(3, { repr: false }),

  // -- Alpha flags (byte 69) ---------------------------------------------
  _alpha_flags: u1_field({ repr: false }),

  // -- Premul color / alpha mode (bytes 70-73) ---------------------------
  premul_color_r: u1_field(),
  premul_color_g: u1_field(),
  premul_color_b: u1_field(),
  alpha_mode_raw: u1_field(),

  // -- Field separation (bytes 74-87) ------------------------------------
  _reserved_4a: bytes_field(5, { repr: false }),

  from_file: bool_field(),

  _reserved_50: bytes_field(3, { repr: false }),
  field_separation_type_raw: u1_field(),

  _reserved_54: bytes_field(3, { repr: false }),

  field_order: u1_field(),

  // -- Reserved / footage state (bytes 88-128) ---------------------------
  _reserved_58: bytes_field(17, { repr: false }),
  _is_synthetic_a: u1_field({ default: 1, repr: false }),
  _reserved_6b: bytes_field(3, { repr: false }),
  _is_synthetic_b: u1_field({ default: 1, repr: false }),
  _reserved_6e: bytes_field(2, { repr: false }),
  _flags_70: u1_field({ repr: false }),

  _reserved_71: bytes_field(2, { repr: false }),
  _flags_73: u1_field({ repr: false }),

  _source_stamp: bytes_field(9, { repr: false }),

  _depth_flag: u1_field({ default: 0x0c, repr: false }),

  // -- Loop / pixel ratio (bytes 126-146) --------------------------------
  loop: u4_field({ default: 1 }),

  _reserved_82: bytes_field(4, { repr: false }),
  _is_synthetic_c: u1_field({ default: 1, repr: false }),
  _reserved_87: bytes_field(1, { repr: false }),
  pixel_aspect_dividend: u4_field({ default: 1 }),
  pixel_aspect_divisor: u4_field({ default: 1 }),
  _reserved_90: bytes_field(3, { repr: false }),

  // -- Pulldown / conform (bytes 147-158) --------------------------------
  _remove_pulldown_value: u1_field({ repr: false }),

  conform_frame_rate_integer: u2_field(),

  conform_frame_rate_fractional: u2_field(),
  display_frame_rate_integer: u2_field(),
  display_frame_rate_fractional: u2_field(),
  _reserved_9c: bytes_field(3, { repr: false }),
  _flags_9f: u1_field({ repr: false }),

  // -- Audio / sequence (bytes 160-183) ----------------------------------
  audio_sample_rate: f8_field(),

  _reserved_a8: bytes_field(4, { repr: false }),
  start_frame: u4_field(),
  end_frame: u4_field(),
  frame_padding: u4_field(),

  // -- Extended settings (bytes 184-221) ---------------------------------
  _reserved_b8: bytes_field(1, { repr: false }),
  frame_range_set: bool_field(),

  _reserved_ba: bytes_field(2, { repr: false }),
  layer_id: u4_field({ default: 0xffffffff }),

  layer_index: u4_field({ default: 0xffffffff }),

  _reserved_c4: bytes_field(3, { repr: false }),
  full_frame: bool_field(),

  _reserved_c8: bytes_field(2, { repr: false }),
  _reserved_ca: bytes_field(2, { repr: false }),
  data_size: u8_field(),
  _reserved_d4: bytes_field(10, { default: concat(b("\x01"), bytes_.repeat(b("\x00"), 9)), repr: false }),
});

// -- BitField descriptors (not attrs fields) -------------------------------
descriptor(SspcChunk, "invert_alpha", new BitField("_alpha_flags", 1));
descriptor(SspcChunk, "premultiplied", new BitField("_alpha_flags", 0));
descriptor(SspcChunk, "footage_missing_at_save", new BitField("_flags_73", 0));
descriptor(SspcChunk, "high_quality_field_separation", new BitField("_flags_9f", 0));
descriptor(SspcChunk, "media_format", new BitField("_flags_70", 3));
descriptor(SspcChunk, "media_file", new BitField("_flags_9f", 3));

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
 * **Note:** TIFF sequences use `build_tiff_opti_data` instead (AE 2026
 * measured); PSD sequences use an empty opti via `PsdOptiChunk`.
 *
 * @param source_format - 4-char `sspc` source-format code.
 * @param kw - Keyword arguments:
 * - `sequence`: `true` for an image sequence.
 */
export function build_generic_opti_data(source_format: string, kw: { sequence?: boolean } = {}): Uint8Array {
  const { sequence = false } = kw;
  const code = bytes_.ljust(bytes_.slice(encode(source_format, "ascii"), 0, 4), 4, 0x20);
  let block: Uint8Array;
  if (sequence && ["IMIO", "STIL"].includes(source_format)) {
    block = bytes_.repeat(b("\x00"), 16);
  } else {
    block = concat(Uint8Array.from(code).reverse(), b("\xff\xff\xff\xff"), bytes_.repeat(b("\x00"), 4), b("\x01\x00\x00\x00"));
  }
  return concat(
    code,
    b("\x00\x05"),
    b("\x00\x00\x00\x3a"), // 58 = total length
    bytes_.repeat(b("\x00"), 20),
    block,
    b("\x01"),
    bytes_.repeat(b("\x00"), 11),
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
 * @param bit_depth - Bits per sample (1 for a bilevel image).
 * @param channels - Colour channels, plus one for an alpha sample or Photoshop layer data
 *   (`MediaInfo.pixel_channels`).
 * @param color_mode - The Photoshop colour mode the image reads as (`MediaInfo.color_mode`).
 * @param layer_count - The layer count AE records (see `FileSource`'s `_opti_data`).
 */
export function build_tiff_opti_data(
  width: number,
  height: number,
  bit_depth: number,
  channels: number,
  color_mode: number,
  layer_count: number,
): Uint8Array {
  const chunk = new PsdOptiChunk({
    asset_type: "TIF ",
    pad_12: concat(b(" FIT\x01"), bytes_.repeat(b("\x00"), 7)),
    psd_channels: channels,
    psd_canvas_width: width,
    psd_canvas_height: height,
    psd_bit_depth: bit_depth,
    psd_color_mode: color_mode,
    psd_layer_count: layer_count,
  });
  chunk.psd_group_name = "";
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
 * @param bit_depth - Bits per channel (1, 8, 16, or 32).
 * @param channels - The document's colour channels, plus one when it has alpha
 *   (`MediaInfo.pixel_channels`).
 * @param color_mode - The document's Photoshop colour mode.
 * @param layer_count - Number of layers in the PSD (0 for a flattened one).
 */
export function build_psd_opti_data(
  width: number,
  height: number,
  bit_depth: number,
  channels: number,
  color_mode: number,
  layer_count: number,
): Uint8Array {
  const chunk = new PsdOptiChunk({
    psd_channels: channels,
    psd_canvas_width: width,
    psd_canvas_height: height,
    psd_bit_depth: bit_depth,
    psd_color_mode: color_mode,
    psd_layer_count: layer_count,
  });
  chunk.psd_group_name = "";
  return chunk.tobytes();
}

/**
 * Build the 602-byte `8BPS` `opti` for a FLATTENED PSD/PSB imported as a
 * one-layer composition.
 *
 * The merged `build_psd_opti_data` of the layerless document (0 layers),
 * with 0x0A (`psd_vector_or_merged`) set to 1 - per-layer optis set it only
 * for a layer with a vector mask (AE 2026 byte-verified against a real
 * flattened RGB PSD, flattened_rgb_comp.aep).
 *
 * @param width - Canvas width in pixels.
 * @param height - Canvas height in pixels.
 * @param bit_depth - Bits per channel.
 * @param channels - The document's channel count (3 for RGB).
 * @param kw - Keyword arguments:
 * - `color_mode`: The document's Photoshop colour mode (3 = RGB).
 */
export function build_psd_flattened_opti_data(
  width: number,
  height: number,
  bit_depth: number,
  channels: number,
  kw: { color_mode?: number } = {},
): Uint8Array {
  const { color_mode = 3 } = kw;
  const chunk = new PsdOptiChunk({
    psd_vector_or_merged: true,
    psd_channels: channels,
    psd_canvas_width: width,
    psd_canvas_height: height,
    psd_bit_depth: bit_depth,
    psd_color_mode: color_mode,
    psd_layer_count: 0,
  });
  chunk.psd_group_name = "";
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
 * this opti. It differs from the merged `build_psd_opti_data` (which keeps
 * the `0xFFFFFFFF` layer-index sentinel and an empty trailing name) in:
 *
 * - `psd_vector_or_merged`: 1 for a layer with a vector mask (a shape
 *   layer's included, enabled or not).
 * - `psd_layer_index`: the 0-based layer index, clearing the merged sentinel.
 * - `psd_layer_top/left/bottom/right`: the layer's content bounding box
 *   (LE s32; `resolvers.psd_bounds.psd_layer_box`) - NOT the canvas.
 * - `psd_layer_channels`: the layer's channels for a raster layer - the
 *   document's colour channels plus one for its transparency (4 for an RGB
 *   layer, including a fully transparent one with an empty content box; 3
 *   for an RGB Background layer; 2 for a gray layer) - and 0 for an
 *   adjustment layer (which contributes no pixel channels).
 * - `psd_layer_id`: the Photoshop layer id (`lyid`, LE u32).
 * - the trailing name block (`psd_group_name`): the layer name,
 *   NUL-terminated UTF-8.
 *
 * The `psd_canvas_*` fields keep the full document size, and
 * `psd_channels`/`psd_color_mode` the document's channel count and colour
 * mode (2 and grayscale for every layer of a gray document with
 * transparency, footage_depth.aep). Byte-verified against AE 2026's
 * `COMP`/`COMP_CROPPED_LAYERS` import of `8bits.psd`/`.psb` and a margined
 * 3-layer PSD.
 *
 * @param canvas_width - Full document width in pixels.
 * @param canvas_height - Full document height in pixels.
 * @param bit_depth - Bits per channel.
 * @param layer_count - Total layers in the document.
 * @param layer_index - 0-based document index of this layer (bottom first).
 * @param layer_id - Photoshop layer id (`lyid`).
 * @param layer_name - Layer name.
 * @param bounds - The layer's content box as `(left, top, right, bottom)`.
 * @param is_adjustment - Whether the layer is an adjustment layer.
 * @param has_vector_mask - Whether the layer has a vector mask.
 * @param kw - Keyword arguments:
 * - `channels`: The document's colour channels, plus one when it has alpha
 *     (`MediaInfo.pixel_channels`); 4 for an RGB document with transparency.
 * - `color_mode`: The document's Photoshop colour mode (3 = RGB).
 * - `layer_channels`: The layer's channels when it is a raster layer; 4 for an RGB layer with
 *     transparency.
 */
export function build_psd_layer_opti_data(
  canvas_width: number,
  canvas_height: number,
  bit_depth: number,
  layer_count: number,
  layer_index: number,
  layer_id: number,
  layer_name: string,
  bounds: [number, number, number, number],
  is_adjustment = false,
  has_vector_mask = false,
  kw: { channels?: number; color_mode?: number; layer_channels?: number } = {},
): Uint8Array {
  const { channels = 4, color_mode = 3, layer_channels = 4 } = kw;
  const [left, top, right, bottom] = bounds;
  const chunk = new PsdOptiChunk({
    psd_vector_or_merged: has_vector_mask,
    psd_layer_index: layer_index,
    psd_channels: channels,
    psd_canvas_width: canvas_width,
    psd_canvas_height: canvas_height,
    psd_bit_depth: bit_depth,
    psd_color_mode: color_mode,
    psd_layer_count: Math.max(layer_count, 1),
    psd_layer_top: top,
    psd_layer_left: left,
    psd_layer_bottom: bottom,
    psd_layer_right: right,
    // The raster layer's channels - even for a fully transparent layer
    // whose content box is empty (psd_clipping_mask "Layer 1") - and 0
    // for an adjustment layer, which has no pixel channels
    // (grouped_layers "hue/sat adj"). AE 2026 measured; the empty content
    // box alone does NOT drop the channels.
    psd_layer_channels: is_adjustment ? 0 : layer_channels,
    psd_layer_id: layer_id,
  });
  chunk.psd_group_name = layer_name;
  return chunk.tobytes();
}

/**
 * Build the 48-byte `opti` asset-info body for a DPX / Cineon file or sequence.
 *
 * AE writes an `sDPX` format-options header identical to the `CineonRoptChunk`
 * render-options layout. Verified: AE 2026 media_gap_formats.aep fixture
 * writes this exact 48-byte body for every DPX and Cineon item.
 */
export function build_dpx_opti_data(): Uint8Array {
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
export function build_exr_opti_data(compression: number, channel_names: readonly string[]): Uint8Array {
  const layers = new Set(
    channel_names.filter((name) => name.includes(".")).map((name) => name.slice(0, name.lastIndexOf("."))),
  );
  const body = new Uint8Array(_OEXR_OPTI_SIZE);
  body.set(b("oEXR"), 0);
  struct.pack_into(">HI", body, 4, 1, _OEXR_OPTI_SIZE);
  struct.pack_into("<HHHHH", body, 0x0a, 1, 0, compression, 1, channel_names.length);
  struct.pack_into("<H", body, 0x2e, channel_names.length + layers.size);
  return body;
}

/**
 * Build the 30-byte Radiance HDR (`RHDR`) `opti` asset-info body.
 *
 * AE refuses an empty or generic `opti` for HDR, but the dimensions are
 * stored in `sspc` (not this opti), so the body is a fixed template. The
 * `asset_type_int` is 0x002e (46), distinguishing it from the generic
 * 0x0005 and the still-importer 0x0109. Reverse-engineered from AE 2026;
 * AE's own opti carries a file-system fingerprint in the trailing 8 bytes
 * that AE re-derives on a cache miss, so it is left zero here.
 */
export function build_rhdr_opti_data(): Uint8Array {
  return concat(
    b("RHDR"),
    b("\x00\x2e"),
    struct.pack(">I", 30), // total length (big-endian)
    b("\x02\x00"),
    bytes_.repeat(b("\x00"), 18),
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
export function build_craw_opti_data(): Uint8Array {
  return concat(b("Craw"), b("\x00\x2e"), struct.pack(">I", 30), bytes_.repeat(b("\x00"), 20));
}

/**
 * Build the bare 596-byte `TEXT` `opti` asset-info body of an EPS file.
 *
 * What AE 2026 writes for eps.eps (1921x2881) imported as footage: the
 * page size and nothing else - no layer count, page count or page-size
 * tail, which an Illustrator/PDF document carries
 * (`build_ai_document_opti_data`). The layout lives on `TextOptiChunk`.
 */
export function build_text_opti_data(width: number, height: number): Uint8Array {
  return new TextOptiChunk({ text_width: width, text_height: height }).tobytes();
}

/**
 * Build the 596-byte `TEXT` `opti` of an Illustrator/PDF file imported
 * whole.
 *
 * The bare body (`build_text_opti_data`) plus the document's layer count,
 * a page count of 1 and the page-size tail; no layer is chosen, so the
 * layer name and visibility stay empty. Byte-verified against AE 2026's
 * import of ai.ai, complex.ai, pdf.pdf, ai_no_pdf.ai and two more PDFs
 * (footage_depth.aep).
 *
 * @param width - Page width in points.
 * @param height - Page height in points.
 * @param layer_count - How many layers the document has (0 when it has none py_aep can read, as AE
 *   writes for a file without Optional Content Groups).
 */
export function build_ai_document_opti_data(width: number, height: number, layer_count: number): Uint8Array {
  return build_ai_layer_opti_data(width, height, "", layer_count, undefined, false);
}

/**
 * Build the 596-byte `TEXT` `opti` for one layer of a layered AI/PDF import.
 *
 * When After Effects imports a layered Illustrator/PDF file as a composition,
 * it creates one footage item per layer, each referencing the same file with
 * its source layer selected. The selection is stored entirely in this opti.
 * It extends `build_text_opti_data` with:
 *
 * - `text_document_layers` (0x30): the source document's layer count.
 * - `text_element_count` (0x3C): element/page count (1).
 * - `text_layer_visible` (0x3D): the source layer's visibility in the
 *   Illustrator/PDF document (`false` for a layer the file's default
 *   configuration hides).
 * - `text_layer_name` (0x44): the layer name, NUL-terminated.
 * - `text_page_height`/`text_page_width` (0x248/0x24C): the redundant
 *   page-dimension tail (BE u16).
 *
 * Bytes 0x10-0x1F hold the artwork bounding box as `(x0, y0, x1, y1)` in
 * page points, four signed BE 16.16 values. Document Size keeps the
 * full-page box `(0, 0, width, height)` that `build_text_opti_data`
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
 * @param layer_name - The referenced layer's name.
 * @param layer_count - How many layers the source document has.
 * @param artwork_bounds - The layer's artwork box `(x0, y0, x1, y1)` in page points for a Layer
 *   Size import; `null` keeps the full-page box (Document Size and comp imports).
 * @param visible - The layer's visibility in the source document
 *   (`resolvers.ai_layers.AiLayer.visible`).
 */
export function build_ai_layer_opti_data(
  width: number,
  height: number,
  layer_name: string,
  layer_count: number,
  artwork_bounds: [number, number, number, number] | null = null,
  visible = true,
): Uint8Array {
  const chunk = new TextOptiChunk({
    text_width: width,
    text_height: height,
    text_document_layers: layer_count,
    text_element_count: 1,
    text_layer_visible: visible,
    text_layer_name: decode(truncate_utf8(layer_name, 255), "utf-8"),
    text_page_height: height,
    text_page_width: width,
  });
  const buf = new Uint8Array(chunk.tobytes());
  if (artwork_bounds != null) {
    // Layer Size import: overlay the layer's artwork box as four signed
    // BE 16.16 values, replacing the full-page x0/y0/x1/y1 that the typed
    // fields wrote (the fractional/offset bytes live in TextOptiChunk
    // padding, so a parse round-trip stays byte-faithful).
    struct.pack_into(">4i", buf, 0x10, ...artwork_bounds.map((v) => round(v * 65536)));
  }
  return buf;
}

type _OptiReadKw = ChunkReadKwargs;

/**
 * Footage asset info chunk (polymorphic).
 *
 * Layout depends on `asset_type` (first 4 bytes). The base class
 * dispatches to variant subclasses; unknown asset types fall back
 * to raw bytes.
 */
export class OptiChunk extends Chunk {
  declare chunk_type: string;

  static read(fp: IO, size: number, kw?: _OptiReadKw): OptiChunk;
  static read(fp: IO, size: number, kw: _OptiReadKw = {}): Chunk {
    const { chunk_type = "" } = kw;
    if (this !== OptiChunk) {
      // Variant subclass - use its own read
      return super.read(fp, size, { chunk_type }); // returns Self
    }
    if (size < 6) {
      return new this({ chunk_type, data: read_bytes(fp, size) });
    }
    // Peek at discriminator (first 4 bytes = asset_type)
    const disc_raw = read_bytes(fp, 6);
    const nul = bytes_.find(disc_raw, b("\x00"), 0, 4);
    const asset_type = decode(bytes_.slice(disc_raw, 0, nul >= 0 ? nul : 4), "ascii");
    const asset_type_int = struct.unpack(">H", bytes_.slice(disc_raw, 4, 6))[0];
    fp.seek(-6, 1);
    // Placeholder: asset_type is empty but asset_type_int == 2
    if (!asset_type && asset_type_int === 2) {
      return PlaceholderOptiChunk.read(fp, size, { chunk_type });
    }
    const variant_cls = _OPTI_VARIANTS.get(asset_type) ?? OptiChunk;
    if (variant_cls === OptiChunk) {
      return new this({ chunk_type, data: read_bytes(fp, size) });
    }
    return variant_cls.read(fp, size, { chunk_type });
  }
}

define(OptiChunk, {
  chunk_type: field({ default: "opti" }),
});

register("opti")(OptiChunk);

/**
 * Solid footage asset (asset_type='Soli').
 *
 * All fields are big-endian and fixed-layout -\> fmt_field.
 */
export class SoliOptiChunk extends OptiChunk {
  declare asset_type: string;
  declare asset_type_int: number;
  declare _pad: Uint8Array;
  /** Solid color red component (0.0-1.0). */
  declare color_r: number;
  /** Solid color green component (0.0-1.0). */
  declare color_g: number;
  /** Solid color blue component (0.0-1.0). */
  declare color_b: number;
  /** Solid item name. */
  declare solid_name: string;

  /** Solid color as [R, G, B] in 0.0-1.0 range. */
  get color(): number[] {
    return [this.color_r, this.color_g, this.color_b];
  }

  set color(value: number[]) {
    this.color_r = value[0];
    this.color_g = value[1];
    this.color_b = value[2];
  }
}

define(SoliOptiChunk, {
  asset_type: ascii_field(4, { default: "Soli" }),
  asset_type_int: u2_field({ default: 9 }),
  _pad: bytes_field(8, { default: b("\x00\x00\x01\x1a\x3f\x80\x00\x00"), repr: false }),
  color_r: f4_field(),
  color_g: f4_field(),
  color_b: f4_field(),
  solid_name: str_field(256, { default: "", encoding: "utf-8" }),
});

/**
 * PSD footage asset (asset_type='8BPS').
 *
 * Fixed 602-byte still-importer layout (AE 2026): 344 bytes of typed
 * fields plus the 258-byte trailing layer-name block exposed via
 * `psd_group_name`. Field defaults reproduce AE's merged-import header,
 * so the `build_psd_*_opti_data` builders only set what differs.
 */
export class PsdOptiChunk extends OptiChunk {
  declare asset_type: string;
  declare asset_type_int: number;
  /** Total opti body length AE bakes into the header. */
  declare _total_length: number;

  /**
   * `true` for a layer with a vector mask (a shape layer's included,
   * enabled or disabled) and for the merged still of a flattened (layerless)
   * file imported as a one-layer composition; other per-layer and plain
   * merged optis leave it `false` (measured on AE 2026).
   */
  declare psd_vector_or_merged: boolean;

  declare _pad_0b: Uint8Array;
  /** 0-based layer index. 0xFFFFFFFF = merged/flattened. */
  declare psd_layer_index: number;

  declare _pad_12: Uint8Array;
  /**
   * The document's channel count as AE reads it: its colour channels, plus
   * one when it has alpha (3 RGB, 4 RGB + alpha or CMYK, 1 grayscale, 2
   * grayscale + alpha). Every opti of a document stores the same count, a
   * layer's included (AE 2026).
   */
  declare psd_channels: number;

  declare _pad_1f: Uint8Array;
  /** Full PSD canvas height in pixels (LE u4). */
  declare psd_canvas_height: number;

  /** Full PSD canvas width in pixels (LE u4). */
  declare psd_canvas_width: number;

  /**
   * Bit depth per channel (1, 8, 16, or 32). Low byte of a LE u2 whose
   * high byte stays 0 in `_pad_29`.
   */
  declare psd_bit_depth: number;

  declare _pad_29: Uint8Array;
  /**
   * The document's Photoshop colour mode (0 bitmap, 1 grayscale, 2
   * indexed, 3 RGB, 4 CMYK, 9 Lab); a TIFF stores the mode it reads as. Low
   * byte of a LE u2.
   */
  declare psd_color_mode: number;

  declare _pad_2b: Uint8Array;
  /**
   * Total number of layers in the document; 0 for a flattened one. A
   * 16-bit field: AE 2026 writes 300 as `2c 01` for a 300-layer document.
   */
  declare psd_layer_count: number;

  declare _pad_32: Uint8Array;
  /** Layer bounding box top (LE s4, can be negative). */
  declare psd_layer_top: number;

  /** Layer bounding box left (LE s4, can be negative). */
  declare psd_layer_left: number;

  /** Layer bounding box bottom (LE s4). */
  declare psd_layer_bottom: number;

  /** Layer bounding box right (LE s4). */
  declare psd_layer_right: number;

  /**
   * Channel count of the referenced layer: 4 (RGBA) for pixel content,
   * 0 for an empty content box (e.g. an adjustment layer) and for merged
   * imports.
   */
  declare psd_layer_channels: number;

  declare _pad_5f: Uint8Array;
  /** Photoshop layer id (`lyid`, LE u4); 0 for merged/flattened. */
  declare psd_layer_id: number;

  /**
   * PSD group/folder name (NUL-terminated UTF-8 at end of chunk).
   *
   * Empty for a merged import, where the trailing region is all-NUL.
   */
  get psd_group_name(): string {
    return decode(bytes_.split(this._trailing, b("\x00"), 1)[0], "utf-8");
  }

  set psd_group_name(value: string) {
    // AE writes a fixed 602-byte opti: keep the trailing name block
    // NUL-padded to 258 bytes so the chunk size is preserved.
    this._trailing = bytes_.ljust(truncate_utf8(value, 255), 258, 0);
  }
}

define(PsdOptiChunk, {
  asset_type: ascii_field(4, { default: "8BPS" }),
  asset_type_int: u2_field({ default: 265 }),
  _total_length: u4_field({ default: 602, repr: false }),

  psd_vector_or_merged: bool_field(),

  _pad_0b: bytes_field(3, { default: b("\x00\x01\x01"), repr: false }),
  psd_layer_index: u4_field({ default: 0xffffffff }),

  _pad_12: bytes_field(12, { default: concat(b("SPB8\x01"), bytes_.repeat(b("\x00"), 7)), repr: false }),
  psd_channels: u1_field({ default: 4 }),

  _pad_1f: bytes_field(1, { repr: false }),
  psd_canvas_height: u4_field({ endian: "<" }),

  psd_canvas_width: u4_field({ endian: "<" }),

  psd_bit_depth: u1_field({ default: 8 }),

  _pad_29: bytes_field(1, { repr: false }),
  psd_color_mode: u1_field({ default: 3 }),

  _pad_2b: bytes_field(5, { repr: false }),
  psd_layer_count: u2_field({ default: 1, endian: "<" }),

  _pad_32: bytes_field(28, { repr: false }),
  psd_layer_top: s4_field({ endian: "<" }),

  psd_layer_left: s4_field({ endian: "<" }),

  psd_layer_bottom: s4_field({ endian: "<" }),

  psd_layer_right: s4_field({ endian: "<" }),

  psd_layer_channels: u1_field(),

  _pad_5f: bytes_field(245, { repr: false }),
  psd_layer_id: u4_field({ endian: "<" }),
});

/**
 * AI/EPS/PDF footage asset (asset_type='TEXT').
 *
 * Fixed 596-byte layout (AE 2026). For a layered Illustrator/PDF import
 * each footage item selects its source layer via `text_layer_name`;
 * whole-document footage (and EPS) leaves it empty. Field defaults
 * reproduce AE's whole-document header, so the `build_*_opti_data`
 * builders only set what differs.
 */
export class TextOptiChunk extends OptiChunk {
  declare asset_type: string;
  declare asset_type_int: number;
  /** Total opti body length AE bakes into the header. */
  declare _total_length: number;

  declare _pad_0a: Uint8Array;
  /**
   * Artwork/page width in pixels: the integer part of the BE 16.16
   * artwork-bbox right at 0x18 (the bbox left/top at 0x10/0x14 stay 0 for a
   * full-page import).
   */
  declare text_width: number;

  declare _pad_1a: Uint8Array;
  /**
   * Artwork/page height in pixels (integer part of the 16.16 bbox
   * bottom at 0x1C).
   */
  declare text_height: number;

  declare _pad_1e: Uint8Array;
  declare _pad_28: Uint8Array;
  declare _pad_2c: Uint8Array;
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
  declare text_document_layers: number;

  declare _pad_34: Uint8Array;
  /**
   * Element/page count: 1 for Illustrator/PDF footage (a whole document
   * or one of its layers), 0 for an EPS file.
   */
  declare text_element_count: number;

  /**
   * The source layer's visibility in the Illustrator/PDF document: `false`
   * for a layer listed in the file's `/OCProperties` `/D` `/OFF` array, which
   * AE also imports with its comp-layer video switch off. Zero for
   * whole-document footage, which has no source layer.
   *
   * Not a "references a layer" flag: AE writes 0 here for a hidden layer's
   * footage, which is a layer binding all the same (`text_layer_name` and the
   * `sspc` layer index are both set). Reading it as one made those bindings
   * look like whole-document footage.
   */
  declare text_layer_visible: boolean;

  declare _pad_3e: Uint8Array;
  /** Selected source layer name (NUL-padded UTF-8); empty for whole-document footage. */
  declare text_layer_name: string;

  declare _pad_144: Uint8Array;
  /** Redundant page-dimension tail (height); 0 for an EPS file. */
  declare text_page_height: number;

  declare _pad_24a: Uint8Array;
  /** Redundant page-dimension tail (width); 0 for an EPS file. */
  declare text_page_width: number;

  declare _pad_24e: Uint8Array;
}

define(TextOptiChunk, {
  asset_type: ascii_field(4, { default: "TEXT" }),
  asset_type_int: u2_field({ default: 8 }),
  _total_length: u4_field({ default: 596, repr: false }),

  _pad_0a: bytes_field(14, { repr: false }),
  text_width: u2_field(),

  _pad_1a: bytes_field(2, { repr: false }),
  text_height: u2_field(),

  _pad_1e: bytes_field(10, { repr: false }),
  _pad_28: bytes_field(4, { default: b("\xff\xff\xff\xff"), repr: false }),
  _pad_2c: bytes_field(4, { repr: false }),
  text_document_layers: u4_field(),

  _pad_34: bytes_field(8, { repr: false }),
  text_element_count: u1_field(),

  text_layer_visible: bool_field(),

  _pad_3e: bytes_field(6, { repr: false }),
  text_layer_name: str_field(256),

  _pad_144: bytes_field(260, { repr: false }),
  text_page_height: u2_field(),

  _pad_24a: bytes_field(2, { repr: false }),
  text_page_width: u2_field(),

  _pad_24e: bytes_field(6, { repr: false }),
});

/** Placeholder footage asset (asset_type_int=2). */
export class PlaceholderOptiChunk extends OptiChunk {
  declare asset_type: string;
  declare asset_type_int: number;
  declare _pad: Uint8Array;
  /** Placeholder name (256-byte NUL-padded UTF-8). */
  declare placeholder_name: string;
}

define(PlaceholderOptiChunk, {
  asset_type: ascii_field(4, { default: "" }),
  asset_type_int: u2_field({ default: 2 }),
  _pad: bytes_field(4, { default: b("\x00\x00\x01\x0a"), repr: false }),
  placeholder_name: str_field(256, { default: "", encoding: "utf-8" }),
});

export const _OPTI_VARIANTS = new Map<string, typeof OptiChunk>([
  ["Soli", SoliOptiChunk],
  ["8BPS", PsdOptiChunk],
  ["TEXT", TextOptiChunk],
]);
