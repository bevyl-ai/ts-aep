/**
 * Render queue chunk types: Roou, Ropt, Rout.
 *
 * RouuChunk exposes output module settings fields as `fmt_field()`.
 * RoptChunk uses variant subclass dispatch by format_code.
 * RoutChunk uses `items_field()` for repeating render-flag entries.
 */

import { b, bytes_, decode, define, descriptor, fields, getattr, len, py_assert, py_bool, setattr, strip } from "../../pyrt/index.ts";
import type { ClassAttributes, IO } from "../../pyrt/index.ts";
import { read_bytes, to_dividend_divisor, to_fixed_16_16 } from "./bin_utils.ts";
import { BitField } from "./bitfield.ts";
import { Chunk, type ChunkReadKwargs } from "./chunk.ts";
import { FmtItem, ascii_field, bool_field, bytes_field, f4_field, f8_field, items_field, s2_field, s4_field, str_field, u1_field, u2_field, u4_field } from "./fmt_field.ts";
import { register } from "./registry.ts";

// ---------------------------------------------------------------------------
// Roou - output module settings (154+ bytes)
// ---------------------------------------------------------------------------

/**
 * Output module settings chunk.
 *
 * Contains video/audio codec, format, dimensions, frame rate, depth,
 * and channel settings.
 *
 * Field defaults reproduce the full 154-byte `Rouu` body AE writes for a
 * fresh "TIFF Sequence with Alpha" output module (a simple image sequence
 * with an empty `Ropt` and no audio), so a freshly created `RouuChunk()` is
 * a valid output format with no preferences needed. The placeholder
 * `width`/`height` are overwritten once output dimensions are resolved.
 */
export class RouuChunk extends Chunk {
  declare chunk_type: string;

  declare _magic: Uint8Array;
  /** Video codec 4-char code. */
  declare video_codec: string;

  declare _reserved_08: Uint8Array;
  /** Starting frame number for image sequence output. */
  declare starting_number: number;

  declare _reserved_14: Uint8Array;
  /** Output format 4-char identifier (e.g. '.AVI', 'H264', 'png!'). */
  declare format_id: string;

  declare _reserved_1e: Uint8Array;
  /** Output width (0 when video disabled). */
  declare width: number;
  /** Output height (0 when video disabled). */
  declare height: number;

  declare _reserved_2a: Uint8Array;
  /**
   * Set to 1 once AE applies the format header to a render queue item;
   * 0 in prefs-stored output module templates.
   */
  declare applied_marker: number;

  declare _reserved_3a: Uint8Array;
  declare frame_rate_integer: number;
  declare frame_rate_fractional: number;
  /**
   * Color depth in total bits per pixel: 24=Millions/8bpc,
   * 48=Trillions/16bpc, 96=Floating/32bpc, `+` variants with alpha, and -32
   * (`FF E0`) for `Floating Point Gray`.
   */
  declare depth: number;

  declare _reserved_48: Uint8Array;
  declare color_premultiplied: number;
  declare _reserved_4e: Uint8Array;
  declare color_matted: number;
  declare _reserved_52: Uint8Array;
  /** Audio sample rate in Hz (e.g. 44100.0, 48000.0); -1 while unset. */
  declare audio_sample_rate: number;

  /**
   * Audio sample encoding: 1=unsigned PCM, 2=signed PCM, 3=float;
   * 0xFFFF while unset.
   */
  declare audio_encoding: number;

  /**
   * Audio bytes per sample: 1=8-bit, 2=16-bit, 4=32-bit; 0xFFFF while
   * unset.
   */
  declare audio_bit_depth: number;

  /** 1=mono, 2=stereo; 0 while the audio format is unset. */
  declare audio_channels: number;

  // The 40 bytes AE writes after the audio fields (offset 0x72..0x99); carries
  // a few audio-config sub-bytes that vary by codec. The default is the
  // block AE writes for a fresh image-sequence output module. Older
  // writers emit only the first 114 bytes; `optional=True` keeps short
  // bodies parseable (the field reads as None and is skipped on write,
  // so they round-trip), while newly built chunks still write 154 bytes.
  declare _reserved_72: Uint8Array | null;

  /**
   * Output frame rate, 16.16 fixed point (integer + fractional/65536):
   * the render frame rate divided by (skip frames + 1).
   */
  get frame_rate(): number {
    return this.frame_rate_integer + this.frame_rate_fractional / 65536.0;
  }

  set frame_rate(value: number) {
    [this.frame_rate_integer, this.frame_rate_fractional] = to_fixed_16_16(value);
  }
}

define(RouuChunk, {
  chunk_type: { default: "Roou" },
  _magic: bytes_field(4, { default: b("FXTC"), repr: false }),
  video_codec: ascii_field(4, { default: "FXTC" }),
  _reserved_08: bytes_field(8, { default: b("\x0f\x10\x06\x43\x80\x00\x00\x00"), repr: false }),
  starting_number: u4_field(),
  _reserved_14: bytes_field(6, { default: b("\xff\xff\xff\xff\x01\x00"), repr: false }),
  format_id: ascii_field(4, { default: "TIF " }),
  _reserved_1e: bytes_field(4, { repr: false }),
  width: u4_field({ default: 100 }),
  height: u4_field({ default: 100 }),
  _reserved_2a: bytes_field(15, { repr: false }),
  applied_marker: u1_field({ default: 1 }),
  _reserved_3a: bytes_field(8, { repr: false }),
  frame_rate_integer: u2_field({ default: 30 }),
  frame_rate_fractional: u2_field(),
  depth: s2_field({ default: 32 }),
  _reserved_48: bytes_field(5, { default: b("\x01\x01\x00\x00\x00"), repr: false }),
  color_premultiplied: u1_field({ default: 1 }),
  _reserved_4e: bytes_field(3, { repr: false }),
  color_matted: u1_field({ default: 1 }),
  _reserved_52: bytes_field(18, {
    default: bytes_.concat(b("FIEL\x00\x01"), bytes_.repeat(b("\x00"), 12)),
    repr: false,
  }),
  audio_sample_rate: f8_field({ default: -1.0 }),
  audio_encoding: u2_field({ default: 0xffff }),
  audio_bit_depth: u2_field({ default: 0xffff }),
  audio_channels: u2_field(),
  _reserved_72: bytes_field(40, {
    default: bytes_.concat(
      bytes_.repeat(b("\x00"), 13),
      b("\x01"),
      bytes_.repeat(b("\x00"), 3),
      b("\x01"),
      bytes_.repeat(b("\x00"), 22),
    ),
    optional: true,
    repr: false,
  }),
});
register("Roou")(RouuChunk);

// ---------------------------------------------------------------------------
// Ropt - format-specific render options (variant dispatch by format_code)
// ---------------------------------------------------------------------------

/**
 * Format-specific render options (polymorphic).
 *
 * Layout depends on `format_code` (first 4 bytes). The base class
 * dispatches to variant subclasses; unknown format codes fall back
 * to raw bytes.
 */
export class RoptChunk extends Chunk {
  declare chunk_type: string;

  /** Format code from the first 4 bytes of raw data (for fallback chunks). */
  get format_code(): string {
    const data = "data" in this ? this.data : b("");
    if (len(data) >= 4) return decode(bytes_.slice(data, 0, 4), "ascii");
    return "";
  }

  static read(fp: IO, size: number, kw: ChunkReadKwargs = {}): RoptChunk {
    const { chunk_type = "" } = kw;
    if (this !== RoptChunk) {
      // Variant subclass - use standard fmt_field parsing
      const result = super.read(fp, size, { chunk_type });
      py_assert(result instanceof RoptChunk);
      return result;
    }
    if (size < 4) return new this({ chunk_type, data: read_bytes(fp, size) });
    // Peek at discriminator (first 4 bytes = format_code)
    const disc_raw = read_bytes(fp, 4);
    const format_code = decode(disc_raw, "ascii");
    fp.seek(-4, 1);
    const variant_cls = _ROPT_VARIANTS.get(format_code) ?? RoptChunk;
    if (variant_cls === RoptChunk) return new this({ chunk_type, data: read_bytes(fp, size) });
    return variant_cls.read(fp, size, { chunk_type });
  }
}

define(RoptChunk, {
  chunk_type: { default: "Ropt" },
});
register("Ropt")(RoptChunk);

// Pad defaults reproducing AE's real `Ropt` bytes per format (oEXR/png! from
// AE preferences, others from sample projects). Long blocks are module-level
// constants so the field declarations stay readable.
export const _JPEG_PAD = bytes_.fromhex(
  "002e0000003a01000000000000000000001c00000000000000004a503634" +
    "000000000000000000000000000000000000",
);
export const _TARGA_PAD = bytes_.concat(
  bytes_.fromhex("002e000000540400"),
  bytes_.repeat(b("\x00"), 9),
  b("\x36"),
  bytes_.repeat(b("\x00"), 54),
  b("\x01"),
);

/**
 * Cineon/DPX render options (format_code='sDPX').
 *
 * Field defaults reproduce AE's exact 48-byte DPX `Ropt`, so a default
 * `CineonRoptChunk()` is a valid format-options chunk.
 */
export class CineonRoptChunk extends RoptChunk {
  // `format_code` is a field here (define() installs a converter accessor that shadows the base getter).
  declare _pad: Uint8Array;
  declare ten_bit_black_point: number;
  declare ten_bit_white_point: number;
  declare converted_black_point: number;
  declare converted_white_point: number;
  declare current_gamma: number;
  declare highlight_expansion: number;
  declare logarithmic_conversion: boolean;
  declare file_format: number;
  declare bit_depth: number;
  declare _pad_end: Uint8Array;
}

define(CineonRoptChunk, {
  format_code: ascii_field(4, { default: "sDPX" }),
  _pad: bytes_field(10, { default: bytes_.fromhex("00030000003000000000"), repr: false }),
  ten_bit_black_point: u2_field(),
  ten_bit_white_point: u2_field({ default: 1023 }),
  converted_black_point: f8_field({ default: 0.0 }),
  converted_white_point: f8_field({ default: 1.0 }),
  current_gamma: f8_field({ default: 1.0 }),
  highlight_expansion: u2_field(),
  logarithmic_conversion: bool_field(),
  file_format: u1_field({ default: 1 }),
  bit_depth: u1_field({ default: 10 }),
  _pad_end: bytes_field(1, { repr: false }),
});

/**
 * JPEG render options (format_code='JPEG').
 *
 * Field defaults reproduce AE's exact 58-byte JPEG `Ropt`, so a default
 * `JpegRoptChunk()` is a valid format-options chunk.
 */
export class JpegRoptChunk extends RoptChunk {
  declare _pad: Uint8Array;
  declare quality: number;
  declare format_type: number;
  declare scans: number;
}

define(JpegRoptChunk, {
  format_code: ascii_field(4, { default: "JPEG" }),
  _pad: bytes_field(48, { default: _JPEG_PAD, repr: false }),
  quality: u2_field({ default: 5 }),
  format_type: u2_field(),
  scans: u2_field({ default: 1 }),
});

/**
 * OpenEXR render options (format_code='oEXR').
 *
 * Field defaults reproduce AE's exact 78-byte OpenEXR `Ropt`, so a default
 * `OpenExrRoptChunk()` is a valid format-options chunk.
 */
export class OpenExrRoptChunk extends RoptChunk {
  declare _pad_04: Uint8Array;
  declare compression: number;
  declare thirty_two_bit_float: boolean;
  declare luminance_chroma: boolean;
  declare _pad_11: Uint8Array;
  declare dwa_compression_level: number;
  declare _pad_end: Uint8Array;
}

define(OpenExrRoptChunk, {
  format_code: ascii_field(4, { default: "oEXR" }),
  _pad_04: bytes_field(10, { default: bytes_.fromhex("00010000004e01000000"), repr: false }),
  compression: u1_field({ default: 2 }),
  thirty_two_bit_float: bool_field(),
  luminance_chroma: bool_field(),
  _pad_11: bytes_field(1, { repr: false }),
  dwa_compression_level: f4_field({ default: 45.0, endian: "<" }),
  _pad_end: bytes_field(56, { repr: false }),
});

/**
 * Targa render options (format_code='TPIC').
 *
 * Field defaults reproduce AE's exact 84-byte Targa `Ropt`, so a default
 * `TargaRoptChunk()` is a valid format-options chunk.
 */
export class TargaRoptChunk extends RoptChunk {
  declare _pad: Uint8Array;
  declare bits_per_pixel: number;
  declare _pad2: Uint8Array;
  declare rle_compression: boolean;
  declare _pad_end: Uint8Array;
}

define(TargaRoptChunk, {
  format_code: ascii_field(4, { default: "TPIC" }),
  _pad: bytes_field(73, { default: _TARGA_PAD, repr: false }),
  bits_per_pixel: u1_field({ default: 24 }),
  _pad2: bytes_field(4, { default: b("TimS"), repr: false }),
  rle_compression: bool_field(),
  _pad_end: bytes_field(1, { repr: false }),
});

/**
 * TIFF render options (format_code='TIF ').
 *
 * The pad defaults carry the fixed markers AE writes for a TIFF sequence,
 * so a default `TiffRoptChunk()` is the exact `Ropt` AE writes for "TIFF
 * Sequence with Alpha" - used as the format options for a freshly created
 * output module.
 */
export class TiffRoptChunk extends RoptChunk {
  declare _pad_04: Uint8Array;
  /** Full `Ropt` body size in bytes (AE writes a redundant copy here). */
  declare chunk_size: number;
  declare _pad_0a: Uint8Array;
  declare ibm_pc_byte_order: boolean;
  declare lzw_compression: boolean;
}

define(TiffRoptChunk, {
  format_code: ascii_field(4, { default: "TIF " }),
  _pad_04: bytes_field(4, { default: Uint8Array.from([1, 9, 0, 0]), repr: false }),
  chunk_size: u2_field({ default: 602 }),
  _pad_0a: bytes_field(590, {
    default: bytes_.concat(Uint8Array.from([0, 0, 1, 1]), bytes_.repeat(b("\x00"), 586)),
    repr: false,
  }),
  ibm_pc_byte_order: bool_field(),
  lzw_compression: bool_field(),
});

/**
 * PNG render options (format_code='png!').
 *
 * Field defaults reproduce AE's exact 322-byte PNG `Ropt`, so a default
 * `PngRoptChunk()` is a valid format-options chunk. The placeholder
 * `width`/`height` come from the reference template.
 */
export class PngRoptChunk extends RoptChunk {
  declare _pad: Uint8Array;
  declare width: number;
  declare height: number;
  declare _pad2: Uint8Array;
  declare bit_depth: number;
  declare compression: number;
  declare _flags: number;
  declare _reserved_26: Uint8Array;
  /** 3 for RGB, 4 for RGB + Alpha. */
  declare channel_count: number;
  declare _pad_end: Uint8Array;

  /** The output has an alpha channel. */
  declare has_alpha: boolean;
}

define(PngRoptChunk, {
  format_code: ascii_field(4, { default: "png!" }),
  _pad: bytes_field(14, { default: bytes_.fromhex("0001000001420100000000000001"), repr: false }),
  width: u4_field({ default: 320 }),
  height: u4_field({ default: 240 }),
  _pad2: bytes_field(2, { repr: false }),
  bit_depth: u2_field({ default: 16 }),
  compression: u4_field(),
  /** Bit 2 = `has_alpha`; bit 1 is always set. */
  _flags: u4_field({ default: 6, repr: false }),
  _reserved_26: bytes_field(8, { repr: false }),
  channel_count: u4_field({ default: 4 }),
  _pad_end: bytes_field(272, { repr: false }),
});
/** Python `BitField` descriptors are class attributes with no annotation, so attrs skips them. */
descriptor(PngRoptChunk, "has_alpha", new BitField("_flags", 2));

export const _ROPT_VARIANTS: Map<string, typeof RoptChunk> = new Map<string, typeof RoptChunk>([
  ["sDPX", CineonRoptChunk],
  ["JPEG", JpegRoptChunk],
  ["oEXR", OpenExrRoptChunk],
  ["TPIC", TargaRoptChunk],
  ["TIF ", TiffRoptChunk],
  ["png!", PngRoptChunk],
]);

// ---------------------------------------------------------------------------
// Rout - render queue item flags (variable length, repeating items)
// ---------------------------------------------------------------------------

/**
 * A single render queue item entry (4 bytes).
 *
 * Contains a render flag at bit 6 of the first byte.
 * The last byte holds a position-dependent slot type code:
 * 0x11 for slots 0/1/3, 0x7B for slot 2, 0x88 for slot 4.
 */
export class RoutItem extends FmtItem {
  declare _flags: number;
  declare _pad: Uint8Array;
  declare _state: number;

  declare render: boolean;
}

define(RoutItem, {
  _flags: u1_field({ repr: false }),
  _pad: bytes_field(2, { default: b("\x00\x00"), repr: false }),
  _state: u1_field({ repr: false }),
});
descriptor(RoutItem, "render", new BitField("_flags", 6));

// ---------------------------------------------------------------------------
// Render settings ldat item (2246 bytes per item)
// ---------------------------------------------------------------------------

/**
 * Per-render-queue-item settings (2246 bytes).
 *
 * Stored as ldat items in the LIST:list under LIST:LRdr.
 */
export class RenderSettingsItem extends FmtItem {
  declare ["constructor"]: ClassAttributes<typeof RenderSettingsItem>;
  // Reserved-region defaults reproduce the constant bytes AE writes for a
  // render-queue item (verified identical across real items). Without them
  // AE reports "missing data in file" when opening a py_aep-created item.
  declare _reserved_00: Uint8Array;
  declare _flag_byte: number;
  declare queue_item_notify: boolean;
  /** BitField over `_flag_byte` bit 0. */
  declare render_checked: boolean;
  declare comp_id: number;
  /** RQItemStatus.QUEUED (-1 = WILL_CONTINUE) */
  declare status: number;
  declare _reserved_06: Uint8Array;
  declare time_span_start_dividend: number;
  declare time_span_start_divisor: number;
  declare time_span_duration_dividend: number;
  declare time_span_duration_divisor: number;
  declare _reserved_11: Uint8Array;
  declare frame_rate_integer: number;
  declare frame_rate_fractional: number;
  declare _reserved_14: Uint8Array;
  declare field_render: number;
  declare _reserved_16: Uint8Array;
  declare pulldown: number;
  /** RenderQuality.BEST */
  declare quality: number;
  declare resolution_x: number;
  declare resolution_y: number;
  declare _reserved_21: Uint8Array;
  /** EffectsSetting.CURRENT_SETTINGS */
  declare effects: number;
  declare _reserved_23: Uint8Array;
  declare proxy_use: number;
  declare _reserved_25: Uint8Array;
  /** MotionBlurSetting.ON_FOR_CHECKED_LAYERS */
  declare motion_blur: number;
  declare _reserved_27: Uint8Array;
  /** FrameBlendingSetting.ON_FOR_CHECKED_LAYERS */
  declare frame_blending: number;
  declare _reserved_29: Uint8Array;
  declare log_type: number;
  declare _reserved_31: Uint8Array;
  declare skip_existing_files: boolean;
  declare _reserved_33: Uint8Array;
  // Defaults mirror AE's factory "Best Settings" render template, so a fresh
  // item is valid even when parse() had no ae_preferences_dir to read from.
  declare template_name: string;
  declare _reserved_35: Uint8Array;
  /**
   * 1 once a script has written any render setting through
   * `setSettings` (AE 2026 sets it even for an unchanged value; `skipFrames`
   * and the time-span attributes leave it).
   */
  declare settings_written: number;

  declare _reserved_36: Uint8Array;
  declare use_this_frame_rate: number;
  declare _reserved_37: Uint8Array;
  declare time_span_source: number;
  declare _reserved_39: Uint8Array;
  /** SoloSwitchesSetting.CURRENT_SETTINGS */
  declare solo_switches: number;
  declare _reserved_41: Uint8Array;
  declare disk_cache: number;
  declare _reserved_43: Uint8Array;
  declare guide_layers: number;
  declare _reserved_45: Uint8Array;
  /** current/project depth */
  declare color_depth: number;
  declare _reserved_47: Uint8Array;
  declare start_time: number;
  declare elapsed_seconds: number;
  declare _reserved_end: Uint8Array;
  /**
   * Unique per render-queue item: AE gives a new item (added or
   * duplicated) the highest id of the queue + 1, 2 in an empty queue.
   */
  declare item_id: number;

  declare _remaining: Uint8Array;

  static _TEMPLATE_FIELDS: readonly string[] = [
    "quality",
    "resolution_x",
    "resolution_y",
    "effects",
    "motion_blur",
    "frame_blending",
    "field_render",
    "pulldown",
    "proxy_use",
    "solo_switches",
    "disk_cache",
    "guide_layers",
    "color_depth",
    "log_type",
    "skip_existing_files",
    "template_name",
  ];

  /**
   * Copy template-relevant settings from another item.
   *
   * Only the fields that AE's "Apply Template" dialog sets are
   * copied; identity fields like comp_id, status, and time spans
   * are preserved.
   */
  copy_settings_from(source: RenderSettingsItem): void {
    for (const field of this.constructor._TEMPLATE_FIELDS) {
      setattr(this, field, getattr(source, field));
    }
  }

  /** Template name with trailing null bytes stripped. */
  get clean_template_name(): string {
    return strip(this.template_name, "\x00");
  }

  // -- Computed properties -----------------------------------------------

  /** Assembled frame rate (integer + fractional/65536). */
  get frame_rate(): number {
    return this.frame_rate_integer + this.frame_rate_fractional / 65536.0;
  }

  set frame_rate(value: number) {
    [this.frame_rate_integer, this.frame_rate_fractional] = to_fixed_16_16(value);
  }

  /** Time span start in seconds (dividend / divisor). */
  get time_span_start(): number {
    if (this.time_span_start_divisor === 0) return 0.0;
    return this.time_span_start_dividend / this.time_span_start_divisor;
  }

  set time_span_start(value: number) {
    [this.time_span_start_dividend, this.time_span_start_divisor] = to_dividend_divisor(value);
  }

  /** Time span duration in seconds (dividend / divisor). */
  get time_span_duration(): number {
    if (this.time_span_duration_divisor === 0) return 0.0;
    return this.time_span_duration_dividend / this.time_span_duration_divisor;
  }

  set time_span_duration(value: number) {
    [this.time_span_duration_dividend, this.time_span_duration_divisor] = to_dividend_divisor(value);
  }
}

define(RenderSettingsItem, {
  _reserved_00: bytes_field(7, { default: b("\x00\x01\x00\x00\x00\x00\x00"), repr: false }),
  _flag_byte: u1_field({ repr: false }),
  comp_id: u4_field(),
  status: s4_field({ default: 2 }), // RQItemStatus.QUEUED (-1 = WILL_CONTINUE)
  _reserved_06: bytes_field(4, { default: b("\x00\x03\x00\x00"), repr: false }),
  time_span_start_dividend: s4_field(),
  time_span_start_divisor: u4_field({ default: 1 }),
  time_span_duration_dividend: s4_field(),
  time_span_duration_divisor: u4_field({ default: 1 }),
  _reserved_11: bytes_field(8, { repr: false }),
  frame_rate_integer: u2_field(),
  frame_rate_fractional: u2_field(),
  _reserved_14: bytes_field(2, { repr: false }),
  field_render: u2_field(),
  _reserved_16: bytes_field(2, { repr: false }),
  pulldown: u2_field(),
  quality: u2_field({ default: 2 }), // RenderQuality.BEST
  resolution_x: u2_field({ default: 1 }),
  resolution_y: u2_field({ default: 1 }),
  _reserved_21: bytes_field(2, { repr: false }),
  effects: u2_field({ default: 2 }), // EffectsSetting.CURRENT_SETTINGS
  _reserved_23: bytes_field(2, { repr: false }),
  proxy_use: u2_field(),
  _reserved_25: bytes_field(2, { repr: false }),
  motion_blur: u2_field({ default: 1 }), // MotionBlurSetting.ON_FOR_CHECKED_LAYERS
  _reserved_27: bytes_field(2, { repr: false }),
  frame_blending: u2_field({ default: 1 }), // FrameBlendingSetting.ON_FOR_CHECKED_LAYERS
  _reserved_29: bytes_field(2, { repr: false }),
  log_type: u2_field(),
  _reserved_31: bytes_field(2, { repr: false }),
  skip_existing_files: u2_field({ coerce: py_bool }),
  _reserved_33: bytes_field(4, { repr: false }),
  // Defaults mirror AE's factory "Best Settings" render template, so a fresh
  // item is valid even when parse() had no ae_preferences_dir to read from.
  template_name: str_field(64, { default: "Best Settings", encoding: "windows-1252" }),
  _reserved_35: bytes_field(1987, { repr: false }),
  settings_written: u1_field(),
  _reserved_36: bytes_field(2, { repr: false }),
  use_this_frame_rate: u2_field(),
  _reserved_37: bytes_field(2, { repr: false }),
  time_span_source: u2_field(),
  _reserved_39: bytes_field(14, {
    default: bytes_.concat(b("\xff\xff\xff\xff\x00\xb4"), bytes_.repeat(b("\x00"), 8)),
    repr: false,
  }),
  solo_switches: u2_field({ default: 2 }), // SoloSwitchesSetting.CURRENT_SETTINGS
  _reserved_41: bytes_field(2, { repr: false }),
  disk_cache: u2_field(),
  _reserved_43: bytes_field(2, { repr: false }),
  guide_layers: u2_field(),
  _reserved_45: bytes_field(6, { default: b("\x00\x00\x00\x02\xff\xff"), repr: false }),
  color_depth: u2_field({ default: 0xffff }), // current/project depth
  _reserved_47: bytes_field(16, { repr: false }),
  start_time: u4_field(),
  elapsed_seconds: u4_field(),
  _reserved_end: bytes_field(16, { repr: false }),
  item_id: u4_field({ default: 2 }),
  _remaining: bytes_field(20, {
    default: bytes_.concat(b("\x00\x00\x00\x0f"), bytes_.repeat(b("\x00"), 16)),
    repr: false,
  }),
});
/** Python `BitField` descriptors are class attributes with no annotation, so attrs skips them. */
descriptor(RenderSettingsItem, "queue_item_notify", new BitField("_flag_byte", 2));
/**
 * The item's Render box: set from Queued on (Queued, stopped, done),
 * clear while it needs an output or is unqueued.
 */
descriptor(RenderSettingsItem, "render_checked", new BitField("_flag_byte", 0));

// ---------------------------------------------------------------------------
// Output module settings ldat item (128 bytes per item)
// ---------------------------------------------------------------------------

/**
 * Per-output-module settings (128 bytes).
 *
 * Stored as ldat items in the LIST:list within each render queue item.
 *
 * Field defaults reproduce the settings AE writes for a fresh
 * "TIFF Sequence with Alpha" output module, so a freshly created
 * `OutputModuleSettingsItem()` is valid with no preferences needed.
 */
export class OutputModuleSettingsItem extends FmtItem {
  declare ["constructor"]: ClassAttributes<typeof OutputModuleSettingsItem>;
  declare _reserved_00: Uint8Array;
  /**
   * Byte 7: bit 6=include_source_xmp, bit 5=has_output_file,
   * bit 4=use_region_of_interest, bit 3=use_comp_frame_number.
   */
  declare _flag_byte_07: number;
  declare post_render_target_comp_id: number;
  declare _reserved_08: Uint8Array;
  declare _reserved_09: Uint8Array;
  declare channels: number;
  declare _reserved_11: Uint8Array;
  declare resize_quality: number;
  declare _reserved_13: Uint8Array;
  declare resize: boolean;
  declare _reserved_15: Uint8Array;
  declare lock_aspect_ratio: boolean;
  declare _reserved_17: Uint8Array;
  /** Byte 22: bit 0=crop. */
  declare _flag_byte_22: number;

  declare crop_top: number;
  declare crop_left: number;
  declare crop_bottom: number;
  declare crop_right: number;
  declare _reserved_24: Uint8Array;
  /** 1 when Output Audio is On or Auto. */
  declare output_audio: number;
  /** 1 for Auto. Switching Output Audio Off leaves it as it was. */
  declare output_audio_auto: number;

  declare _reserved_26: Uint8Array;
  declare _include_project_link: number;
  declare post_render_action: number;
  declare post_render_use_comp: number;
  declare _reserved_30: Uint8Array;
  declare output_profile_id: Uint8Array;
  declare _reserved_32: Uint8Array;
  declare convert_to_linear_light: number;
  declare _prev_byte_34: Uint8Array;
  declare output_color_space_working: number;
  declare preserve_rgb: boolean;
  declare _reserved_5f: Uint8Array;

  /**
   * Set on every AE-saved module that has an output path record; AE
   * 2026 ignores the record of a module without it.
   */
  declare has_output_file: boolean;
  declare include_source_xmp: boolean;
  declare use_region_of_interest: boolean;
  declare use_comp_frame_number: boolean;
  declare crop: boolean;
  declare include_project_link: boolean;

  static _TEMPLATE_FIELDS: readonly string[] = [
    "_flag_byte_07",
    "_reserved_09",
    "channels",
    "_reserved_11",
    "resize_quality",
    "_reserved_13",
    "resize",
    "_reserved_15",
    "lock_aspect_ratio",
    "_reserved_17",
    "_flag_byte_22",
    "crop_top",
    "crop_left",
    "crop_bottom",
    "crop_right",
    "_reserved_24",
    "output_audio",
    "output_audio_auto",
    "_reserved_26",
    "_include_project_link",
    "post_render_action",
    "_reserved_30",
    "output_profile_id",
    "_reserved_32",
    "convert_to_linear_light",
    "_prev_byte_34",
    "output_color_space_working",
    "preserve_rgb",
    "_reserved_5f",
  ];

  /**
   * Copy template-relevant settings from another item.
   *
   * Only the fields that AE's "Apply Template" dialog sets are
   * copied; identity fields like `post_render_target_comp_id` and
   * `post_render_use_comp` are preserved.
   */
  copy_settings_from(source: OutputModuleSettingsItem): void {
    for (const field of this.constructor._TEMPLATE_FIELDS) {
      setattr(this, field, getattr(source, field));
    }
  }

  /**
   * Copy EVERY field from `source`, keeping this item's identity.
   *
   * Used by `OutputModule.batch_edit` rollback: this item is
   * referenced from the ldat items list, so restoring in place
   * avoids re-wiring references.
   */
  restore_from(source: OutputModuleSettingsItem): void {
    for (const field of fields(OutputModuleSettingsItem)) {
      setattr(this, field.name, getattr(source, field.name));
    }
  }
}

define(OutputModuleSettingsItem, {
  _reserved_00: bytes_field(7, { default: b("\x00\x05\x00\x00\x00\x00\x00"), repr: false }),
  /**
   * Byte 7: bit 6=include_source_xmp, bit 5=has_output_file,
   * bit 4=use_region_of_interest, bit 3=use_comp_frame_number.
   */
  _flag_byte_07: u1_field({ default: 8, repr: false }),
  post_render_target_comp_id: u4_field(),
  _reserved_08: bytes_field(4, { default: b("\x00\x00\x00\x01"), repr: false }),
  _reserved_09: bytes_field(3, { repr: false }),
  channels: u1_field({ default: 1 }),
  _reserved_11: bytes_field(3, { repr: false }),
  resize_quality: u1_field({ default: 1 }),
  _reserved_13: bytes_field(3, { default: b("\x00\x01\x00"), repr: false }),
  resize: bool_field(),
  _reserved_15: bytes_field(1, { repr: false }),
  lock_aspect_ratio: bool_field({ default: true }),
  _reserved_17: bytes_field(1, { repr: false }),
  /** Byte 22: bit 0=crop. */
  _flag_byte_22: u1_field({ repr: false }),
  crop_top: s2_field(),
  crop_left: s2_field(),
  crop_bottom: s2_field(),
  crop_right: s2_field(),
  _reserved_24: bytes_field(1, { repr: false }),
  /** 1 when Output Audio is On or Auto. */
  output_audio: u1_field(),
  /** 1 for Auto. Switching Output Audio Off leaves it as it was. */
  output_audio_auto: u1_field({ default: 1 }),
  _reserved_26: bytes_field(4, { repr: false }),
  _include_project_link: u1_field({ repr: false }),
  post_render_action: u4_field(),
  post_render_use_comp: u4_field(),
  _reserved_30: bytes_field(16, { default: bytes_.repeat(b("\xff"), 16), repr: false }),
  output_profile_id: bytes_field(16, { default: bytes_.repeat(b("\xff"), 16) }),
  _reserved_32: bytes_field(3, { repr: false }),
  convert_to_linear_light: u1_field({ default: 2 }),
  _prev_byte_34: bytes_field(1, { default: b("\x01"), repr: false }),
  output_color_space_working: u1_field({ default: 1 }),
  preserve_rgb: bool_field(),
  _reserved_5f: bytes_field(33, { repr: false }),
});
/** Python `BitField` descriptors are class attributes with no annotation, so attrs skips them. */
descriptor(OutputModuleSettingsItem, "include_source_xmp", new BitField("_flag_byte_07", 6));
/**
 * Set on every AE-saved module that has an output path record; AE
 * 2026 ignores the record of a module without it.
 */
descriptor(OutputModuleSettingsItem, "has_output_file", new BitField("_flag_byte_07", 5));
descriptor(OutputModuleSettingsItem, "use_region_of_interest", new BitField("_flag_byte_07", 4));
descriptor(OutputModuleSettingsItem, "use_comp_frame_number", new BitField("_flag_byte_07", 3));
descriptor(OutputModuleSettingsItem, "crop", new BitField("_flag_byte_22", 0));
descriptor(OutputModuleSettingsItem, "include_project_link", new BitField("_include_project_link", 0));

/** `_ROUT_ITEM_SIZE` */
export const _ROUT_ITEM_SIZE = 4;

// AE writes a fixed block of 5 Rout items per render queue item (1 render-flag
// entry followed by 4 position-dependent slot entries), independent of the
// number of output modules.
export const ROUT_ITEMS_PER_RQ_ITEM = 5;

/**
 * Render queue item flags chunk.
 *
 * 4-byte header followed by 4 bytes per item, each with a render
 * flag at bit 6 of the first byte.
 */
export class RoutChunk extends Chunk {
  declare chunk_type: string;

  declare count: number;
  declare items: RoutItem[];
}

define(RoutChunk, {
  chunk_type: { default: "Rout" },
  count: u4_field(),
  items: items_field(RoutItem, 4),
});
register("Rout")(RoutChunk);

// ---------------------------------------------------------------------------
// ARsi - render queue state (fixed 1872 bytes, mostly opaque)
// ---------------------------------------------------------------------------

/**
 * Render queue state chunk (`LRdr/LSIf`), a fixed 1872 bytes.
 *
 * The body is a 7-byte header followed by 88-byte slot records; most of
 * it is opaque to py_aep. Only the two bytes AE rewrites when the render
 * queue goes from empty to non-empty are named, so callers can set them
 * by name instead of poking raw offsets. The remaining bytes are kept as
 * reserved blocks that round-trip verbatim.
 */
export class ArsiChunk extends Chunk {
  declare chunk_type: string;

  declare _reserved_00: Uint8Array;
  /** Offset 3: 1 once the render queue holds at least one item, else 0. */
  declare queue_nonempty: number;

  declare _reserved_04: Uint8Array;
  /**
   * Offset 379: a slot state byte AE rewrites on the empty -\> first-item
   * transition (set to 0x73). Exact semantics are not fully understood.
   */
  declare active_slot_state: number;

  declare _reserved_180: Uint8Array;
}

define(ArsiChunk, {
  chunk_type: { default: "ARsi" },
  _reserved_00: bytes_field(3, { repr: false }),
  queue_nonempty: u1_field(),
  _reserved_04: bytes_field(375, { repr: false }),
  active_slot_state: u1_field(),
  _reserved_180: bytes_field(1492, { repr: false }),
});
register("ARsi")(ArsiChunk);
