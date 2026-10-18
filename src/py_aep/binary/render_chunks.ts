/**
 * Render queue chunk types: Roou, Ropt, Rout.
 *
 * RouuChunk exposes output module settings fields as `fmtField()`.
 * RoptChunk uses variant subclass dispatch by format_code.
 * RoutChunk uses `itemsField()` for repeating render-flag entries.
 */

import { Bytes, decode, define, descriptor, fields, getMember, assert, truthy, setMember, ascii } from "../../pyrt/index.ts";
import type { ClassAttributes, ByteStream } from "../../pyrt/index.ts";
import { readBytes, toDividendDivisor, toFixed1616 } from "./bin_utils.ts";
import { BitField } from "./bitfield.ts";
import { Chunk, type ChunkReadKwargs } from "./chunk.ts";
import { FmtItem, asciiField, boolField, bytesField, f4Field, f8Field, itemsField, s2Field, s4Field, strField, u1Field, u2Field, u4Field } from "./fmt_field.ts";
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
  declare chunkType: string;

  declare _magic: Uint8Array;
  /** Video codec 4-char code. */
  declare videoCodec: string;

  declare _reserved08: Uint8Array;
  /** Starting frame number for image sequence output. */
  declare startingNumber: number;

  declare _reserved14: Uint8Array;
  /** Output format 4-char identifier (e.g. '.AVI', 'H264', 'png!'). */
  declare formatId: string;

  declare _reserved1e: Uint8Array;
  /** Output width (0 when video disabled). */
  declare width: number;
  /** Output height (0 when video disabled). */
  declare height: number;

  declare _reserved2a: Uint8Array;
  /**
   * Set to 1 once AE applies the format header to a render queue item;
   * 0 in prefs-stored output module templates.
   */
  declare appliedMarker: number;

  declare _reserved3a: Uint8Array;
  declare frameRateInteger: number;
  declare frameRateFractional: number;
  /**
   * Color depth in total bits per pixel: 24=Millions/8bpc,
   * 48=Trillions/16bpc, 96=Floating/32bpc, `+` variants with alpha, and -32
   * (`FF E0`) for `Floating Point Gray`.
   */
  declare depth: number;

  declare _reserved48: Uint8Array;
  declare colorPremultiplied: number;
  declare _reserved4e: Uint8Array;
  declare colorMatted: number;
  declare _reserved52: Uint8Array;
  /** Audio sample rate in Hz (e.g. 44100.0, 48000.0); -1 while unset. */
  declare audioSampleRate: number;

  /**
   * Audio sample encoding: 1=unsigned PCM, 2=signed PCM, 3=float;
   * 0xFFFF while unset.
   */
  declare audioEncoding: number;

  /**
   * Audio bytes per sample: 1=8-bit, 2=16-bit, 4=32-bit; 0xFFFF while
   * unset.
   */
  declare audioBitDepth: number;

  /** 1=mono, 2=stereo; 0 while the audio format is unset. */
  declare audioChannels: number;

  // The 40 bytes AE writes after the audio fields (offset 0x72..0x99); carries
  // a few audio-config sub-bytes that vary by codec. The default is the
  // block AE writes for a fresh image-sequence output module. Older
  // writers emit only the first 114 bytes; `optional=True` keeps short
  // bodies parseable (the field reads as None and is skipped on write,
  // so they round-trip), while newly built chunks still write 154 bytes.
  declare _reserved72: Uint8Array | null;

  /**
   * Output frame rate, 16.16 fixed point (integer + fractional/65536):
   * the render frame rate divided by (skip frames + 1).
   */
  get frameRate(): number {
    return this.frameRateInteger + this.frameRateFractional / 65536.0;
  }

  set frameRate(value: number) {
    [this.frameRateInteger, this.frameRateFractional] = toFixed1616(value);
  }
}

define(RouuChunk, {
  chunkType: { default: "Roou" },
  _magic: bytesField(4, { default: ascii("FXTC"), repr: false }),
  videoCodec: asciiField(4, { default: "FXTC" }),
  _reserved08: bytesField(8, { default: ascii("\x0f\x10\x06\x43\x80\x00\x00\x00"), repr: false }),
  startingNumber: u4Field(),
  _reserved14: bytesField(6, { default: Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0x01, 0x00), repr: false }),
  formatId: asciiField(4, { default: "TIF " }),
  _reserved1e: bytesField(4, { repr: false }),
  width: u4Field({ default: 100 }),
  height: u4Field({ default: 100 }),
  _reserved2a: bytesField(15, { repr: false }),
  appliedMarker: u1Field({ default: 1 }),
  _reserved3a: bytesField(8, { repr: false }),
  frameRateInteger: u2Field({ default: 30 }),
  frameRateFractional: u2Field(),
  depth: s2Field({ default: 32 }),
  _reserved48: bytesField(5, { default: Uint8Array.of(0x01, 0x01, 0x00, 0x00, 0x00), repr: false }),
  colorPremultiplied: u1Field({ default: 1 }),
  _reserved4e: bytesField(3, { repr: false }),
  colorMatted: u1Field({ default: 1 }),
  _reserved52: bytesField(18, {
    default: Bytes.concat(ascii("FIEL\x00\x01"), Bytes.repeat(new Uint8Array(1), 12)),
    repr: false,
  }),
  audioSampleRate: f8Field({ default: -1.0 }),
  audioEncoding: u2Field({ default: 0xffff }),
  audioBitDepth: u2Field({ default: 0xffff }),
  audioChannels: u2Field(),
  _reserved72: bytesField(40, {
    default: Bytes.concat(
      Bytes.repeat(new Uint8Array(1), 13),
      Uint8Array.of(0x01),
      Bytes.repeat(new Uint8Array(1), 3),
      Uint8Array.of(0x01),
      Bytes.repeat(new Uint8Array(1), 22),
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
 * Layout depends on `formatCode` (first 4 bytes). The base class
 * dispatches to variant subclasses; unknown format codes fall back
 * to raw bytes.
 */
export class RoptChunk extends Chunk {
  declare chunkType: string;

  /** Format code from the first 4 bytes of raw data (for fallback chunks). */
  get formatCode(): string {
    const data = "data" in this ? this.data : new Uint8Array();
    if (data.length >= 4) return decode(data.slice(0, 4), "ascii");
    return "";
  }

  static read(fp: ByteStream, size: number, kw: ChunkReadKwargs = {}): RoptChunk {
    const { chunkType = "" } = kw;
    if (this !== RoptChunk) {
      // Variant subclass - use standard fmt_field parsing
      const result = super.read(fp, size, { chunkType });
      assert(result instanceof RoptChunk);
      return result;
    }
    if (size < 4) return new this({ chunkType, data: readBytes(fp, size) });
    // Peek at discriminator (first 4 bytes = format_code)
    const discRaw = readBytes(fp, 4);
    const formatCode = decode(discRaw, "ascii");
    fp.seek(-4, 1);
    const variantCls = _ROPT_VARIANTS.get(formatCode) ?? RoptChunk;
    if (variantCls === RoptChunk) return new this({ chunkType, data: readBytes(fp, size) });
    return variantCls.read(fp, size, { chunkType });
  }
}

define(RoptChunk, {
  chunkType: { default: "Ropt" },
});
register("Ropt")(RoptChunk);

// Pad defaults reproducing AE's real `Ropt` bytes per format (oEXR/png! from
// AE preferences, others from sample projects). Long blocks are module-level
// constants so the field declarations stay readable.
export const _JPEG_PAD = Bytes.fromHex(
  "002e0000003a01000000000000000000001c00000000000000004a503634" +
    "000000000000000000000000000000000000",
);
export const _TARGA_PAD = Bytes.concat(
  Bytes.fromHex("002e000000540400"),
  Bytes.repeat(new Uint8Array(1), 9),
  ascii("\x36"),
  Bytes.repeat(new Uint8Array(1), 54),
  Uint8Array.of(0x01),
);

/**
 * Cineon/DPX render options (format_code='sDPX').
 *
 * Field defaults reproduce AE's exact 48-byte DPX `Ropt`, so a default
 * `CineonRoptChunk()` is a valid format-options chunk.
 */
export class CineonRoptChunk extends RoptChunk {
  // `formatCode` is a field here (define() installs a converter accessor that shadows the base getter).
  declare _pad: Uint8Array;
  declare tenBitBlackPoint: number;
  declare tenBitWhitePoint: number;
  declare convertedBlackPoint: number;
  declare convertedWhitePoint: number;
  declare currentGamma: number;
  declare highlightExpansion: number;
  declare logarithmicConversion: boolean;
  declare fileFormat: number;
  declare bitDepth: number;
  declare _padEnd: Uint8Array;
}

define(CineonRoptChunk, {
  formatCode: asciiField(4, { default: "sDPX" }),
  _pad: bytesField(10, { default: Bytes.fromHex("00030000003000000000"), repr: false }),
  tenBitBlackPoint: u2Field(),
  tenBitWhitePoint: u2Field({ default: 1023 }),
  convertedBlackPoint: f8Field({ default: 0.0 }),
  convertedWhitePoint: f8Field({ default: 1.0 }),
  currentGamma: f8Field({ default: 1.0 }),
  highlightExpansion: u2Field(),
  logarithmicConversion: boolField(),
  fileFormat: u1Field({ default: 1 }),
  bitDepth: u1Field({ default: 10 }),
  _padEnd: bytesField(1, { repr: false }),
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
  declare formatType: number;
  declare scans: number;
}

define(JpegRoptChunk, {
  formatCode: asciiField(4, { default: "JPEG" }),
  _pad: bytesField(48, { default: _JPEG_PAD, repr: false }),
  quality: u2Field({ default: 5 }),
  formatType: u2Field(),
  scans: u2Field({ default: 1 }),
});

/**
 * OpenEXR render options (format_code='oEXR').
 *
 * Field defaults reproduce AE's exact 78-byte OpenEXR `Ropt`, so a default
 * `OpenExrRoptChunk()` is a valid format-options chunk.
 */
export class OpenExrRoptChunk extends RoptChunk {
  declare _pad04: Uint8Array;
  declare compression: number;
  declare thirtyTwoBitFloat: boolean;
  declare luminanceChroma: boolean;
  declare _pad11: Uint8Array;
  declare dwaCompressionLevel: number;
  declare _padEnd: Uint8Array;
}

define(OpenExrRoptChunk, {
  formatCode: asciiField(4, { default: "oEXR" }),
  _pad04: bytesField(10, { default: Bytes.fromHex("00010000004e01000000"), repr: false }),
  compression: u1Field({ default: 2 }),
  thirtyTwoBitFloat: boolField(),
  luminanceChroma: boolField(),
  _pad11: bytesField(1, { repr: false }),
  dwaCompressionLevel: f4Field({ default: 45.0, endian: "<" }),
  _padEnd: bytesField(56, { repr: false }),
});

/**
 * Targa render options (format_code='TPIC').
 *
 * Field defaults reproduce AE's exact 84-byte Targa `Ropt`, so a default
 * `TargaRoptChunk()` is a valid format-options chunk.
 */
export class TargaRoptChunk extends RoptChunk {
  declare _pad: Uint8Array;
  declare bitsPerPixel: number;
  declare _pad2: Uint8Array;
  declare rleCompression: boolean;
  declare _padEnd: Uint8Array;
}

define(TargaRoptChunk, {
  formatCode: asciiField(4, { default: "TPIC" }),
  _pad: bytesField(73, { default: _TARGA_PAD, repr: false }),
  bitsPerPixel: u1Field({ default: 24 }),
  _pad2: bytesField(4, { default: ascii("TimS"), repr: false }),
  rleCompression: boolField(),
  _padEnd: bytesField(1, { repr: false }),
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
  declare _pad04: Uint8Array;
  /** Full `Ropt` body size in bytes (AE writes a redundant copy here). */
  declare chunkSize: number;
  declare _pad0a: Uint8Array;
  declare ibmPcByteOrder: boolean;
  declare lzwCompression: boolean;
}

define(TiffRoptChunk, {
  formatCode: asciiField(4, { default: "TIF " }),
  _pad04: bytesField(4, { default: Uint8Array.from([1, 9, 0, 0]), repr: false }),
  chunkSize: u2Field({ default: 602 }),
  _pad0a: bytesField(590, {
    default: Bytes.concat(Uint8Array.from([0, 0, 1, 1]), Bytes.repeat(new Uint8Array(1), 586)),
    repr: false,
  }),
  ibmPcByteOrder: boolField(),
  lzwCompression: boolField(),
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
  declare bitDepth: number;
  declare compression: number;
  declare _flags: number;
  declare _reserved26: Uint8Array;
  /** 3 for RGB, 4 for RGB + Alpha. */
  declare channelCount: number;
  declare _padEnd: Uint8Array;

  /** The output has an alpha channel. */
  declare hasAlpha: boolean;

  static {
    // BitFields read and write bits of an attrs field; they are descriptors, not attrs fields.
    descriptor(this, "hasAlpha", new BitField("_flags", 2));
  }
}

define(PngRoptChunk, {
  formatCode: asciiField(4, { default: "png!" }),
  _pad: bytesField(14, { default: Bytes.fromHex("0001000001420100000000000001"), repr: false }),
  width: u4Field({ default: 320 }),
  height: u4Field({ default: 240 }),
  _pad2: bytesField(2, { repr: false }),
  bitDepth: u2Field({ default: 16 }),
  compression: u4Field(),
  /** Bit 2 = `hasAlpha`; bit 1 is always set. */
  _flags: u4Field({ default: 6, repr: false }),
  _reserved26: bytesField(8, { repr: false }),
  channelCount: u4Field({ default: 4 }),
  _padEnd: bytesField(272, { repr: false }),
});

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

  static {
    descriptor(this, "render", new BitField("_flags", 6));
  }
}

define(RoutItem, {
  _flags: u1Field({ repr: false }),
  _pad: bytesField(2, { default: new Uint8Array(2), repr: false }),
  _state: u1Field({ repr: false }),
});

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
  declare _reserved00: Uint8Array;
  declare _flagByte: number;
  declare queueItemNotify: boolean;
  /**
   * The item's Render box (bit 0 of `_flagByte`): set from Queued on (Queued,
   * stopped, done), clear while it needs an output or is unqueued.
   */
  declare renderChecked: boolean;
  declare compId: number;
  /** RQItemStatus.QUEUED (-1 = WILL_CONTINUE) */
  declare status: number;
  declare _reserved06: Uint8Array;
  declare timeSpanStartDividend: number;
  declare timeSpanStartDivisor: number;
  declare timeSpanDurationDividend: number;
  declare timeSpanDurationDivisor: number;
  declare _reserved11: Uint8Array;
  declare frameRateInteger: number;
  declare frameRateFractional: number;
  declare _reserved14: Uint8Array;
  declare fieldRender: number;
  declare _reserved16: Uint8Array;
  declare pulldown: number;
  /** RenderQuality.BEST */
  declare quality: number;
  declare resolutionX: number;
  declare resolutionY: number;
  declare _reserved21: Uint8Array;
  /** EffectsSetting.CURRENT_SETTINGS */
  declare effects: number;
  declare _reserved23: Uint8Array;
  declare proxyUse: number;
  declare _reserved25: Uint8Array;
  /** MotionBlurSetting.ON_FOR_CHECKED_LAYERS */
  declare motionBlur: number;
  declare _reserved27: Uint8Array;
  /** FrameBlendingSetting.ON_FOR_CHECKED_LAYERS */
  declare frameBlending: number;
  declare _reserved29: Uint8Array;
  declare logType: number;
  declare _reserved31: Uint8Array;
  declare skipExistingFiles: boolean;
  declare _reserved33: Uint8Array;
  // Defaults mirror AE's factory "Best Settings" render template, so a fresh
  // item is valid even when parse() had no ae_preferences_dir to read from.
  declare templateName: string;
  declare _reserved35: Uint8Array;
  /**
   * 1 once a script has written any render setting through
   * `setSettings` (AE 2026 sets it even for an unchanged value; `skipFrames`
   * and the time-span attributes leave it).
   */
  declare settingsWritten: number;

  declare _reserved36: Uint8Array;
  declare useThisFrameRate: number;
  declare _reserved37: Uint8Array;
  declare timeSpanSource: number;
  declare _reserved39: Uint8Array;
  /** SoloSwitchesSetting.CURRENT_SETTINGS */
  declare soloSwitches: number;
  declare _reserved41: Uint8Array;
  declare diskCache: number;
  declare _reserved43: Uint8Array;
  declare guideLayers: number;
  declare _reserved45: Uint8Array;
  /** current/project depth */
  declare colorDepth: number;
  declare _reserved47: Uint8Array;
  declare startTime: number;
  declare elapsedSeconds: number;
  declare _reservedEnd: Uint8Array;
  /**
   * Unique per render-queue item: AE gives a new item (added or
   * duplicated) the highest id of the queue + 1, 2 in an empty queue.
   */
  declare itemId: number;

  declare _remaining: Uint8Array;

  static _TEMPLATE_FIELDS: readonly string[] = [
    "quality",
    "resolutionX",
    "resolutionY",
    "effects",
    "motionBlur",
    "frameBlending",
    "fieldRender",
    "pulldown",
    "proxyUse",
    "soloSwitches",
    "diskCache",
    "guideLayers",
    "colorDepth",
    "logType",
    "skipExistingFiles",
    "templateName",
  ];

  /**
   * Copy template-relevant settings from another item.
   *
   * Only the fields that AE's "Apply Template" dialog sets are
   * copied; identity fields like comp_id, status, and time spans
   * are preserved.
   */
  copySettingsFrom(source: RenderSettingsItem): void {
    for (const field of this.constructor._TEMPLATE_FIELDS) {
      setMember(this, field, getMember(source, field));
    }
  }

  /** Template name with trailing null bytes stripped. */
  get cleanTemplateName(): string {
    return this.templateName.replace(/^\0+|\0+$/g, "");
  }

  // -- Computed properties -----------------------------------------------

  /** Assembled frame rate (integer + fractional/65536). */
  get frameRate(): number {
    return this.frameRateInteger + this.frameRateFractional / 65536.0;
  }

  set frameRate(value: number) {
    [this.frameRateInteger, this.frameRateFractional] = toFixed1616(value);
  }

  /** Time span start in seconds (dividend / divisor). */
  get timeSpanStart(): number {
    if (this.timeSpanStartDivisor === 0) return 0.0;
    return this.timeSpanStartDividend / this.timeSpanStartDivisor;
  }

  set timeSpanStart(value: number) {
    [this.timeSpanStartDividend, this.timeSpanStartDivisor] = toDividendDivisor(value);
  }

  /** Time span duration in seconds (dividend / divisor). */
  get timeSpanDuration(): number {
    if (this.timeSpanDurationDivisor === 0) return 0.0;
    return this.timeSpanDurationDividend / this.timeSpanDurationDivisor;
  }

  set timeSpanDuration(value: number) {
    [this.timeSpanDurationDividend, this.timeSpanDurationDivisor] = toDividendDivisor(value);
  }

  static {
    // BitFields read and write bits of an attrs field; they are descriptors, not attrs fields.
    descriptor(this, "queueItemNotify", new BitField("_flagByte", 2));
    descriptor(this, "renderChecked", new BitField("_flagByte", 0));
  }
}

define(RenderSettingsItem, {
  _reserved00: bytesField(7, { default: Uint8Array.of(0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00), repr: false }),
  _flagByte: u1Field({ repr: false }),
  compId: u4Field(),
  status: s4Field({ default: 2 }), // RQItemStatus.QUEUED (-1 = WILL_CONTINUE)
  _reserved06: bytesField(4, { default: Uint8Array.of(0x00, 0x03, 0x00, 0x00), repr: false }),
  timeSpanStartDividend: s4Field(),
  timeSpanStartDivisor: u4Field({ default: 1 }),
  timeSpanDurationDividend: s4Field(),
  timeSpanDurationDivisor: u4Field({ default: 1 }),
  _reserved11: bytesField(8, { repr: false }),
  frameRateInteger: u2Field(),
  frameRateFractional: u2Field(),
  _reserved14: bytesField(2, { repr: false }),
  fieldRender: u2Field(),
  _reserved16: bytesField(2, { repr: false }),
  pulldown: u2Field(),
  quality: u2Field({ default: 2 }), // RenderQuality.BEST
  resolutionX: u2Field({ default: 1 }),
  resolutionY: u2Field({ default: 1 }),
  _reserved21: bytesField(2, { repr: false }),
  effects: u2Field({ default: 2 }), // EffectsSetting.CURRENT_SETTINGS
  _reserved23: bytesField(2, { repr: false }),
  proxyUse: u2Field(),
  _reserved25: bytesField(2, { repr: false }),
  motionBlur: u2Field({ default: 1 }), // MotionBlurSetting.ON_FOR_CHECKED_LAYERS
  _reserved27: bytesField(2, { repr: false }),
  frameBlending: u2Field({ default: 1 }), // FrameBlendingSetting.ON_FOR_CHECKED_LAYERS
  _reserved29: bytesField(2, { repr: false }),
  logType: u2Field(),
  _reserved31: bytesField(2, { repr: false }),
  skipExistingFiles: u2Field({ coerce: truthy }),
  _reserved33: bytesField(4, { repr: false }),
  // Defaults mirror AE's factory "Best Settings" render template, so a fresh
  // item is valid even when parse() had no ae_preferences_dir to read from.
  templateName: strField(64, { default: "Best Settings", encoding: "windows-1252" }),
  _reserved35: bytesField(1987, { repr: false }),
  settingsWritten: u1Field(),
  _reserved36: bytesField(2, { repr: false }),
  useThisFrameRate: u2Field(),
  _reserved37: bytesField(2, { repr: false }),
  timeSpanSource: u2Field(),
  _reserved39: bytesField(14, {
    default: Bytes.concat(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0x00, 0xb4), Bytes.repeat(new Uint8Array(1), 8)),
    repr: false,
  }),
  soloSwitches: u2Field({ default: 2 }), // SoloSwitchesSetting.CURRENT_SETTINGS
  _reserved41: bytesField(2, { repr: false }),
  diskCache: u2Field(),
  _reserved43: bytesField(2, { repr: false }),
  guideLayers: u2Field(),
  _reserved45: bytesField(6, { default: Uint8Array.of(0x00, 0x00, 0x00, 0x02, 0xff, 0xff), repr: false }),
  colorDepth: u2Field({ default: 0xffff }), // current/project depth
  _reserved47: bytesField(16, { repr: false }),
  startTime: u4Field(),
  elapsedSeconds: u4Field(),
  _reservedEnd: bytesField(16, { repr: false }),
  itemId: u4Field({ default: 2 }),
  _remaining: bytesField(20, {
    default: Bytes.concat(Uint8Array.of(0x00, 0x00, 0x00, 0x0f), Bytes.repeat(new Uint8Array(1), 16)),
    repr: false,
  }),
});

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
  declare _reserved00: Uint8Array;
  /**
   * Byte 7: bit 6=include_source_xmp, bit 5=has_output_file,
   * bit 4=use_region_of_interest, bit 3=use_comp_frame_number.
   */
  declare _flagByte07: number;
  declare postRenderTargetCompId: number;
  declare _reserved08: Uint8Array;
  declare _reserved09: Uint8Array;
  declare channels: number;
  declare _reserved11: Uint8Array;
  declare resizeQuality: number;
  declare _reserved13: Uint8Array;
  declare resize: boolean;
  declare _reserved15: Uint8Array;
  declare lockAspectRatio: boolean;
  declare _reserved17: Uint8Array;
  /** Byte 22: bit 0=crop. */
  declare _flagByte22: number;

  declare cropTop: number;
  declare cropLeft: number;
  declare cropBottom: number;
  declare cropRight: number;
  declare _reserved24: Uint8Array;
  /** 1 when Output Audio is On or Auto. */
  declare outputAudio: number;
  /** 1 for Auto. Switching Output Audio Off leaves it was. */
  declare outputAudioAuto: number;

  declare _reserved26: Uint8Array;
  declare _includeProjectLink: number;
  declare postRenderAction: number;
  declare postRenderUseComp: number;
  declare _reserved30: Uint8Array;
  declare outputProfileId: Uint8Array;
  declare _reserved32: Uint8Array;
  declare convertToLinearLight: number;
  declare _prevByte34: Uint8Array;
  declare outputColorSpaceWorking: number;
  declare preserveRgb: boolean;
  declare _reserved5f: Uint8Array;

  /**
   * Set on every AE-saved module that has an output path record; AE
   * 2026 ignores the record of a module without it.
   */
  declare hasOutputFile: boolean;
  declare includeSourceXmp: boolean;
  declare useRegionOfInterest: boolean;
  declare useCompFrameNumber: boolean;
  declare crop: boolean;
  declare includeProjectLink: boolean;

  static _TEMPLATE_FIELDS: readonly string[] = [
    "_flagByte07",
    "_reserved09",
    "channels",
    "_reserved11",
    "resizeQuality",
    "_reserved13",
    "resize",
    "_reserved15",
    "lockAspectRatio",
    "_reserved17",
    "_flagByte22",
    "cropTop",
    "cropLeft",
    "cropBottom",
    "cropRight",
    "_reserved24",
    "outputAudio",
    "outputAudioAuto",
    "_reserved26",
    "_includeProjectLink",
    "postRenderAction",
    "_reserved30",
    "outputProfileId",
    "_reserved32",
    "convertToLinearLight",
    "_prevByte34",
    "outputColorSpaceWorking",
    "preserveRgb",
    "_reserved5f",
  ];

  /**
   * Copy template-relevant settings from another item.
   *
   * Only the fields that AE's "Apply Template" dialog sets are
   * copied; identity fields like `postRenderTargetCompId` and
   * `postRenderUseComp` are preserved.
   */
  copySettingsFrom(source: OutputModuleSettingsItem): void {
    for (const field of this.constructor._TEMPLATE_FIELDS) {
      setMember(this, field, getMember(source, field));
    }
  }

  /**
   * Copy EVERY field from `source`, keeping this item's identity.
   *
   * Used by `OutputModule.batchEdit` rollback: this item is
   * referenced from the ldat items list, so restoring in place
   * avoids re-wiring references.
   */
  restoreFrom(source: OutputModuleSettingsItem): void {
    for (const field of fields(OutputModuleSettingsItem)) {
      setMember(this, field.name, getMember(source, field.name));
    }
  }

  static {
    // BitFields read and write bits of an attrs field; they are descriptors, not attrs fields.
    descriptor(this, "includeSourceXmp", new BitField("_flagByte07", 6));
    descriptor(this, "hasOutputFile", new BitField("_flagByte07", 5));
    descriptor(this, "useRegionOfInterest", new BitField("_flagByte07", 4));
    descriptor(this, "useCompFrameNumber", new BitField("_flagByte07", 3));
    descriptor(this, "crop", new BitField("_flagByte22", 0));
    descriptor(this, "includeProjectLink", new BitField("_includeProjectLink", 0));
  }
}

define(OutputModuleSettingsItem, {
  _reserved00: bytesField(7, { default: Uint8Array.of(0x00, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00), repr: false }),
  /**
   * Byte 7: bit 6=include_source_xmp, bit 5=has_output_file,
   * bit 4=use_region_of_interest, bit 3=use_comp_frame_number.
   */
  _flagByte07: u1Field({ default: 8, repr: false }),
  postRenderTargetCompId: u4Field(),
  _reserved08: bytesField(4, { default: Uint8Array.of(0x00, 0x00, 0x00, 0x01), repr: false }),
  _reserved09: bytesField(3, { repr: false }),
  channels: u1Field({ default: 1 }),
  _reserved11: bytesField(3, { repr: false }),
  resizeQuality: u1Field({ default: 1 }),
  _reserved13: bytesField(3, { default: Uint8Array.of(0x00, 0x01, 0x00), repr: false }),
  resize: boolField(),
  _reserved15: bytesField(1, { repr: false }),
  lockAspectRatio: boolField({ default: true }),
  _reserved17: bytesField(1, { repr: false }),
  /** Byte 22: bit 0=crop. */
  _flagByte22: u1Field({ repr: false }),
  cropTop: s2Field(),
  cropLeft: s2Field(),
  cropBottom: s2Field(),
  cropRight: s2Field(),
  _reserved24: bytesField(1, { repr: false }),
  /** 1 when Output Audio is On or Auto. */
  outputAudio: u1Field(),
  /** 1 for Auto. Switching Output Audio Off leaves it was. */
  outputAudioAuto: u1Field({ default: 1 }),
  _reserved26: bytesField(4, { repr: false }),
  _includeProjectLink: u1Field({ repr: false }),
  postRenderAction: u4Field(),
  postRenderUseComp: u4Field(),
  _reserved30: bytesField(16, { default: Bytes.repeat(Uint8Array.of(0xff), 16), repr: false }),
  outputProfileId: bytesField(16, { default: Bytes.repeat(Uint8Array.of(0xff), 16) }),
  _reserved32: bytesField(3, { repr: false }),
  convertToLinearLight: u1Field({ default: 2 }),
  _prevByte34: bytesField(1, { default: Uint8Array.of(0x01), repr: false }),
  outputColorSpaceWorking: u1Field({ default: 1 }),
  preserveRgb: boolField(),
  _reserved5f: bytesField(33, { repr: false }),
});

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
  declare chunkType: string;

  declare count: number;
  declare items: RoutItem[];
}

define(RoutChunk, {
  chunkType: { default: "Rout" },
  count: u4Field(),
  items: itemsField(RoutItem, 4),
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
  declare chunkType: string;

  declare _reserved00: Uint8Array;
  /** Offset 3: 1 once the render queue holds at least one item, else 0. */
  declare queueNonempty: number;

  declare _reserved04: Uint8Array;
  /**
   * Offset 379: a slot state byte AE rewrites on the empty -\> first-item
   * transition (set to 0x73). Exact semantics are not fully understood.
   */
  declare activeSlotState: number;

  declare _reserved180: Uint8Array;
}

define(ArsiChunk, {
  chunkType: { default: "ARsi" },
  _reserved00: bytesField(3, { repr: false }),
  queueNonempty: u1Field(),
  _reserved04: bytesField(375, { repr: false }),
  activeSlotState: u1Field(),
  _reserved180: bytesField(1492, { repr: false }),
});
register("ARsi")(ArsiChunk);
