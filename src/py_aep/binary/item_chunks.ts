/**
 * Item and project-level chunk types: idta, head, nhed, nnhd.
 *
 * All three use `fmtField()` for fixed-layout I/O.
 * HeadChunk packs version info into a 32-bit bitfield word with \@property
 * accessors. NnhdChunk uses `BitField` for scattered flag bits.
 */

import {
  Bytes,
  decode,
  define,
  descriptor,
  encode,
  field,
  objectSetattr,
  literal,
  ValueError,
} from "../../pyrt/index.ts";
import { MAC_EPOCH_OFFSET } from "./bin_utils.ts";
import { BitField } from "./bitfield.ts";
import { Chunk } from "./chunk.ts";
import { FmtItem, boolField, bytesField, u1Field, u2Field, u4Field } from "./fmt_field.ts";
import { register } from "./registry.ts";

// ---------------------------------------------------------------------------
// idta - item descriptor (56 bytes + trailing)
// ---------------------------------------------------------------------------

/**
 * Item descriptor chunk.
 *
 * Contains item type, ID, and label. Most of the 84-byte body is
 * reserved/unknown and preserved for round-trip fidelity.
 */
export class IdtaChunk extends Chunk {
  declare chunkType: string;
  /** Item type enum: 1=folder, 4=composition, 7=footage. */
  declare itemType: number;
  declare _reserved02: Uint8Array;
  /** Unique item identifier within the project. */
  declare itemId: number;
  declare _flags14: Uint8Array;
  declare _proxyFlags: number;
  declare _flags17: number;
  declare _reserved18: Uint8Array;
  declare _proxyActive: number;
  declare _reserved39: Uint8Array;
  /** Label color index. */
  declare label: number;
  declare _reserved3c: Uint8Array;
  /** Bytes 0x50-0x53: big-endian Mac-epoch seconds (see `modifiedTime`). */
  declare _modifiedStamp: number;

  // -- BitField descriptors (not attrs fields) ---------------------------
  declare useProxy: boolean;
  declare isSolid: boolean;
  declare isFootage: boolean;

  /**
   * Item time stamp, as a Unix timestamp (`0` when unstamped).
   *
   * For file footage AE stores the last-modified time of the file in
   * use (the proxy's while a file proxy is active); for other items it
   * stores the time of the item's last edit.
   */
  get modifiedTime(): number {
    const stamp = this._modifiedStamp;
    return stamp ? stamp - MAC_EPOCH_OFFSET : 0;
  }

  set modifiedTime(value: number) {
    this._modifiedStamp = value ? value + MAC_EPOCH_OFFSET : 0;
  }

  static {
    // -- BitField descriptors (not attrs fields) ---------------------------
    descriptor(this, "useProxy", new BitField("_proxyFlags", 0));
    descriptor(this, "isSolid", new BitField("_flags17", 4));
    descriptor(this, "isFootage", new BitField("_flags17", 5));
  }
}
define(IdtaChunk, {
  chunkType: field({ default: "idta" }),
  itemType: u2Field(),
  _reserved02: bytesField(14, { repr: false }),
  itemId: u4Field(),
  _flags14: bytesField(2, { repr: false }),
  _proxyFlags: u1Field({ repr: false }),
  _flags17: u1Field({ repr: false }),
  _reserved18: bytesField(32, { repr: false }),
  _proxyActive: u1Field({ repr: false }),
  _reserved39: bytesField(1, { repr: false }),
  label: u1Field(),
  _reserved3c: bytesField(21, { repr: false }),
  _modifiedStamp: u4Field({ repr: false }),
});
register("idta")(IdtaChunk);

// ---------------------------------------------------------------------------
// idpc - item project context (8 bytes)
// ---------------------------------------------------------------------------

/** Item project context chunk (8 bytes). */
export class IdpcChunk extends Chunk {
  declare chunkType: string;
  declare data: Uint8Array;
}
define(IdpcChunk, {
  chunkType: field({ default: "idpc" }),
  data: field({ default: Bytes.repeat(new Uint8Array(1), 8) }),
});
register("idpc")(IdpcChunk);

// ---------------------------------------------------------------------------
// head - file header / version (28 bytes)
// ---------------------------------------------------------------------------
//
// Version bitfield layout (32 bits, MSB first):
//   bit  31      : reserved
//   bits 30-26   : ae_version_major_a  (5 bits)
//   bits 25-22   : ae_version_os       (4 bits)
//   bits 21-19   : ae_version_major_b  (3 bits)
//   bits 18-15   : ae_version_minor    (4 bits)
//   bits 14-11   : ae_version_patch    (4 bits)
//   bit  10      : reserved
//   bit   9      : ae_version_beta_flag (0=beta, 1=release)
//   bit   8      : reserved
//   bits  7-0    : ae_build_number     (8 bits)

/**
 * The (file format version, minor) pair After Effects stamps when saving a
 * project for each release. 15 and 23-26 match projects those releases saved
 * (samples/versions); 16-18 and 22 are the pairs AE writes when it saves for
 * them (an early 22.x build saved samples/versions/ae2022 as 93.40). Its keys
 * are the majors py_aep can write a project for (there was no AE 19-21).
 */
export const FORMAT_VERSIONS: Map<number, [number, number]> = new Map<number, [number, number]>([
  [15, [92, 14]],
  [16, [93, 5]],
  [17, [93, 22]],
  [18, [93, 29]],
  [22, [93, 43]],
  [23, [94, 9]],
  [24, [95, 6]],
  [25, [96, 9]],
  [26, [97, 2]],
]);

/** An After Effects version string, `"{major}.{minor}x{build}"`. */
export const AE_VERSION_RE = /^(\d+)\.(\d+)x(\d+)$/;

export class HeadChunk extends Chunk {
  declare chunkType: string;
  declare _reserved00a: Uint8Array;
  /**
   * Project file-format version AE checks when opening: it refuses files
   * whose value exceeds the running app's own. Equals the AE major version
   * plus 71 for AE 2022+ (e.g. 0x61=97 for AE 26).
   */
  declare fileFormatVersion: number;
  declare _reserved00c: Uint8Array;
  declare _formatSubversion: number;
  // Fresh-project default: OS=12 (Windows, bits 25-22), the reserved bit 10
  // AE always sets on save, and bit 9=1 (release, not beta). The version
  // bits (major/minor/build) are stamped by the `version` setter, which
  // preserves these.
  declare _versionWord: number;
  declare _reserved08: Uint8Array;
  /** Next item ID to allocate, always \> max existing item ID. */
  declare nextItemId: number;
  /** File revision counter (32-bit), incremented on each user action. */
  declare fileRevision: number;

  get aeVersionMajorA(): number {
    return (this._versionWord >>> 26) & 0x1f;
  }

  set aeVersionMajorA(value: number) {
    this._versionWord = ((this._versionWord & ~(0x1f << 26)) | ((value & 0x1f) << 26)) >>> 0;
  }

  get aeVersionMajorB(): number {
    return (this._versionWord >>> 19) & 0x07;
  }

  set aeVersionMajorB(value: number) {
    this._versionWord = ((this._versionWord & ~(0x07 << 19)) | ((value & 0x07) << 19)) >>> 0;
  }

  get aeVersionMinor(): number {
    return (this._versionWord >>> 15) & 0x0f;
  }

  set aeVersionMinor(value: number) {
    this._versionWord = ((this._versionWord & ~(0x0f << 15)) | ((value & 0x0f) << 15)) >>> 0;
  }

  /** Raw flag: False=beta, True=release. */
  get aeVersionBetaFlag(): boolean {
    return ((this._versionWord >>> 9) & 1) !== 0;
  }

  set aeVersionBetaFlag(value: boolean | number) {
    if (value) {
      this._versionWord = (this._versionWord | (1 << 9)) >>> 0;
    } else {
      this._versionWord = (this._versionWord & ~(1 << 9)) >>> 0;
    }
  }

  get aeBuildNumber(): number {
    return this._versionWord & 0xff;
  }

  set aeBuildNumber(value: number) {
    this._versionWord = ((this._versionWord & ~0xff) | (value & 0xff)) >>> 0;
  }

  /** OS code (bits 25-22); 12 for Windows in saved files. */
  get aeVersionOs(): number {
    return (this._versionWord >>> 22) & 0x0f;
  }

  set aeVersionOs(value: number) {
    this._versionWord = ((this._versionWord & ~(0x0f << 22)) | ((value & 0x0f) << 22)) >>> 0;
  }

  /** Full major version (e.g. 25). */
  get aeVersionMajor(): number {
    return this.aeVersionMajorA * 8 + this.aeVersionMajorB;
  }

  /** AE version as `major.minorxbuild` (e.g. '25.6x101'). */
  get version(): string {
    return `${this.aeVersionMajor}.${this.aeVersionMinor}x${this.aeBuildNumber}`;
  }

  set version(value: string) {
    const m = AE_VERSION_RE.exec(value);
    if (!m) {
      throw new ValueError(`Invalid version format: ${literal(value)}`);
    }
    const [major, minor, build] = [Number.parseInt(m[1], 10), Number.parseInt(m[2], 10), Number.parseInt(m[3], 10)];
    this.aeVersionMajorA = Math.floor(major / 8);
    this.aeVersionMajorB = major % 8;
    this.aeVersionMinor = minor;
    this.aeBuildNumber = build;
  }

  /**
   * Stamp `fileFormatVersion` (the open-compatibility gate) and its
   * minor for the current major version, as After Effects saves for that
   * release (`FORMAT_VERSIONS`). AE opens a file whose format version is
   * at most its own and reads it with the rules of the (format, minor)
   * pair, so a major with no release to take a stamp from (a newer AE,
   * or one that never existed) keeps the current pair: a derived pair
   * (AE 2026 measured on `py_aep.new` 12-14 and 19-21) makes AE misread
   * every property name or reject the file, while the version word
   * alone does not matter to it (AE 2026 opens projects relabelled 0,
   * 12, 20, 21, 27, 99 and 255 with their own pair kept).
   */
  syncFileFormatVersion(): void {
    const pair = FORMAT_VERSIONS.get(this.aeVersionMajor) ?? null;
    if (pair != null) {
      [this.fileFormatVersion, this._formatSubversion] = pair;
    }
  }
}
define(HeadChunk, {
  chunkType: field({ default: "head" }),
  // Defaults capture a fresh AE 2026 project (see project_chunks.py).
  _reserved00a: bytesField(1, { repr: false }),
  fileFormatVersion: u1Field({ default: 0x61 }),
  _reserved00c: bytesField(1, { repr: false }),
  _formatSubversion: u1Field({ default: 0x02, repr: false }),
  _versionWord: u4Field({ default: (12 << 22) | (1 << 10) | (1 << 9), repr: false }),
  _reserved08: bytesField(4, { default: Uint8Array.of(0x80, 0x00, 0x00, 0x00), repr: false }),
  nextItemId: u4Field({ default: 1, repr: false }),
  fileRevision: u4Field({ default: 1 }),
});
register("head")(HeadChunk);

// ---------------------------------------------------------------------------
// nhed - compact project settings mirror (32 bytes)
// ---------------------------------------------------------------------------

/**
 * Compact root-level mirror for selected project settings.
 *
 * Sample comparisons show that several `nnhd` display settings are
 * mirrored here at more compact offsets. Some bytes still have
 * unknown semantics and are preserved exactly.
 */
export class NhedChunk extends Chunk {
  declare chunkType: string;
  declare _reserved00: Uint8Array;
  declare _displayByte: number;
  declare footageTimecodeDisplayStartType: number;
  declare _reserved0a: Uint8Array;
  declare _feetByte: number;
  declare timecodeDefaultBase: number;
  declare _reserved0d: Uint8Array;
  declare framesCountType: number;
  declare bitsPerChannel: number;
  declare transparencyGridThumbnails: boolean;
  declare _reserved11: Uint8Array;

  declare feetFramesFilmType: boolean;
  declare framesUseFeetFrames: boolean;

  /** Time display type (0=TIMECODE, 1=FRAMES). */
  get timeDisplayType(): number {
    return this._displayByte & 0x7f;
  }

  set timeDisplayType(value: number) {
    this._displayByte = (this._displayByte & 0x80) | (value & 0x7f);
  }

  get displayStartFrame(): number {
    return ((this.framesCountType % 2) + 2) % 2;
  }

  set displayStartFrame(value: number) {
    this.framesCountType = value;
  }

  static {
    descriptor(this, "feetFramesFilmType", new BitField("_displayByte", 7));
    descriptor(this, "framesUseFeetFrames", new BitField("_feetByte", 0));
  }
}
define(NhedChunk, {
  chunkType: field({ default: "nhed" }),
  // Defaults capture a fresh AE 2026 project (see project_chunks.py).
  _reserved00: bytesField(8, {
    default: Bytes.concat(Bytes.repeat(new Uint8Array(1), 7), Uint8Array.of(0x05)),
    repr: false,
  }),
  _displayByte: u1Field({ repr: false }),
  footageTimecodeDisplayStartType: u1Field({ default: 1 }),
  _reserved0a: bytesField(1, { default: Uint8Array.of(0x01), repr: false }),
  _feetByte: u1Field({ repr: false }),
  timecodeDefaultBase: u1Field({ default: 30 }),
  _reserved0d: bytesField(1, { default: Uint8Array.of(0x10), repr: false }),
  framesCountType: u1Field({ default: 2 }),
  bitsPerChannel: u1Field(),
  transparencyGridThumbnails: boolField(),
  _reserved11: bytesField(15, { repr: false }),
});
register("nhed")(NhedChunk);

// ---------------------------------------------------------------------------
// nnhd - project display settings (40 bytes)
// ---------------------------------------------------------------------------

/**
 * Project display settings.
 *
 * Contains time display format, frame count settings, color depth,
 * and various toggle flags.
 */
export class NnhdChunk extends Chunk {
  declare chunkType: string;
  declare _reserved00: Uint8Array;
  /**
   * Byte 2: 0x08 when After Effects on macOS saved the project, 0 on
   * Windows (AE rewrites it on every save).
   */
  declare _savingPlatform: number;
  declare _reserved03: Uint8Array;
  /** Byte 8: bit 7 = feet_frames_film_type, bits 6-0 = time_display_type. */
  declare _displayByte: number;
  declare footageTimecodeDisplayStartType: number;
  declare _reserved0a: number;
  /** Byte 11: bit 0 = frames_use_feet_frames. */
  declare _feetByte: number;
  declare _reserved0c: Uint8Array;
  declare timecodeDefaultBase: number;
  declare _unknown10: Uint8Array;
  declare framesCountType: number;
  declare _reserved15: Uint8Array;
  declare bitsPerChannel: number;
  declare transparencyGridThumbnails: boolean;
  /**
   * Bytes 0x1A-0x1B: the saving system's text encoding - Windows code
   * page 1252 up to AE 25 and 65001 (UTF-8) from AE 26, 0x0100 on macOS
   * (AE rewrites it on every save).
   */
  declare _systemCodePage: number;
  declare _unknown1c: Uint8Array;

  // -- Bit-level accessors (not attrs fields) ----------------------------
  declare feetFramesFilmType: boolean;
  declare framesUseFeetFrames: boolean;

  /** Time display type (0=TIMECODE, 1=FRAMES). */
  get timeDisplayType(): number {
    return this._displayByte & 0x7f;
  }

  set timeDisplayType(value: number) {
    this._displayByte = (this._displayByte & 0x80) | (value & 0x7f);
  }

  get displayStartFrame(): number {
    return ((this.framesCountType % 2) + 2) % 2;
  }

  set displayStartFrame(value: number) {
    this.framesCountType = value;
  }

  static {
    // -- Bit-level accessors (not attrs fields) ----------------------------
    descriptor(this, "feetFramesFilmType", new BitField("_displayByte", 7));
    descriptor(this, "framesUseFeetFrames", new BitField("_feetByte", 0));
  }
}
define(NnhdChunk, {
  chunkType: field({ default: "nnhd" }),
  // Defaults capture a fresh AE 2026 project (see project_chunks.py).
  _reserved00: bytesField(2, { repr: false }),
  _savingPlatform: u1Field({ repr: false }),
  _reserved03: bytesField(5, {
    default: Bytes.concat(Bytes.repeat(new Uint8Array(1), 4), Uint8Array.of(0x05)),
    repr: false,
  }),
  _displayByte: u1Field({ repr: false }),
  footageTimecodeDisplayStartType: u1Field({ default: 1 }),
  _reserved0a: u1Field({ default: 1, repr: false }),
  _feetByte: u1Field({ repr: false }),
  _reserved0c: bytesField(2, { repr: false }),
  timecodeDefaultBase: u2Field({ default: 30 }),
  _unknown10: bytesField(4, { default: Uint8Array.of(0x00, 0x00, 0x00, 0x10), repr: false }),
  framesCountType: u1Field({ default: 2 }),
  _reserved15: bytesField(3, { repr: false }),
  bitsPerChannel: u1Field(),
  transparencyGridThumbnails: boolField(),
  _systemCodePage: u2Field({ repr: false }),
  _unknown1c: bytesField(12, { repr: false }),
});
register("nnhd")(NnhdChunk);

// ---------------------------------------------------------------------------
// Project time-display preference blob (preferences only, not in .aep files)
// ---------------------------------------------------------------------------

/**
 * The "Project Settings Time Display Format" preferences value (16 bytes).
 *
 * Mirrors the `nnhd` time-display settings cluster (AE stamps the
 * last-used Project Settings into this machine-specific preference and
 * new projects inherit it). Field defaults reproduce a factory AE 2026
 * preferences file.
 */
export class TimeDisplayPrefItem extends FmtItem {
  /** Bit 7 = feet_frames_film_type, bits 6-0 = time_display_type. */
  declare displayByte: number;
  declare footageTimecodeDisplayStartType: number;
  declare _reserved02: number;
  /** Bit 0 = frames_use_feet_frames. */
  declare feetByte: number;
  declare timecodeDefaultBase: number;
  declare _reserved08: number;
  declare framesCountType: number;
}
define(TimeDisplayPrefItem, {
  displayByte: u1Field(),
  footageTimecodeDisplayStartType: u1Field({ default: 1 }),
  _reserved02: u1Field({ default: 1, repr: false }),
  feetByte: u1Field(),
  timecodeDefaultBase: u4Field({ default: 30, endian: "<" }),
  _reserved08: u4Field({ default: 16, endian: "<", repr: false }),
  framesCountType: u4Field({ default: 2, endian: "<" }),
});

// ---------------------------------------------------------------------------
// cmta - item comment (variable-length, null-terminated UTF-8)
// ---------------------------------------------------------------------------

/**
 * Comment chunk: null-terminated UTF-8, CRLF line endings.
 *
 * `data` holds the raw bytes (roundtrip-safe). The `value` property
 * decodes to normalised text (LF, no null). Setting `value` encodes
 * back with CRLF and a double-null terminator, matching AE's convention.
 */
export class CmtaChunk extends Chunk {
  declare chunkType: string;

  /** Decoded comment text, LF line endings, no trailing null. */
  get value(): string {
    return decode(this.data, "UTF-8").split("\x00")[0].replaceAll("\r\n", "\n");
  }

  set value(text: string) {
    // AE always writes a double-null terminator inside the chunk data.
    const encoded = encode(text.replaceAll("\n", "\r\n") + "\x00\x00", "UTF-8");
    objectSetattr(this, "data", encoded);
  }
}
define(CmtaChunk, {
  chunkType: field({ default: "cmta" }),
});
register("cmta")(CmtaChunk);
