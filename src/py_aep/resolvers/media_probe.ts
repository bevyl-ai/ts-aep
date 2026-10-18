/**
 * Read footage metadata from media-file headers.
 *
 * After Effects caches footage metadata (dimensions, duration, frame rate, alpha,
 * audio) in the `.aep` `sspc` chunk and does NOT re-read the media on open. So a
 * newly created `FileSource` must carry correct values; this module extracts them
 * from the source file's header. Parsers are added per format.
 *
 * This reads external media files (not `.aep` chunks), so `struct` is used here.
 */

import * as datetime from "../../pyrt/datetime.ts";
import * as zlib from "../../pyrt/zlib.ts";
import {
  AttributeError,
  BytesIO,
  Fraction,
  IndexError,
  NotImplementedError,
  StructError,
  TypeError_,
  ValueError,
  b,
  bytes_,
  bytesEq,
  concat,
  decode,
  float,
  floordiv,
  getitem,
  int,
  max,
  min,
  mod,
  pyBool,
  pyEq,
  repr,
  round,
  rshift,
  rstrip,
  sorted,
  strip,
  struct,
  tkey,
  type FileReader,
  jsonGet,
  jsonLoads,
  type JsonValue,
  openRb,
  typeName,
} from "../../pyrt/index.ts";
import type { Path } from "../../pyrt/index.ts";

/** Read/seek surface shared by `BytesIO` and `_BoundedReader`. */
export interface ProbeStream {
  read(size?: number | null): Uint8Array;
  readline(size?: number | null): Uint8Array;
  seek(offset: number, whence?: number): number;
  tell(): number;
}

/** `data[i]` on bytes: negative indexes count from the end; IndexError text is CPython's bytes message. */
export function _byteAt(data: Uint8Array, i: number): number {
  const j = i < 0 ? data.length + i : i;
  if (j < 0 || j >= data.length) throw new IndexError("index out of range");
  return data[j];
}

/** `io.SEEK_SET` / `io.SEEK_CUR` / `io.SEEK_END` */
export const SEEK_SET = 0;
export const SEEK_CUR = 1;
export const SEEK_END = 2;

/** Footage metadata read from a media-file header (a NamedTuple; keyword construction). */
export interface MediaInfoFields {
  width: number;
  height: number;
  /** Raw media duration in seconds (0 for a still image). */
  duration: number;
  /** Native frame rate in fps (0 for stills and audio-only media). */
  frameRate: number;
  hasAlpha: boolean;
  hasAudio: boolean;
  audioSampleRate: number;
  pixelAspect: number;
  /**
   * Bits per channel (8, 16, 32). Read for PSD/PSB, TIFF, DPX/Cineon and
   * HEIF.
   */
  bitDepth: number;
  /**
   * Number of layers as After Effects counts them: a PSD/PSB's layer
   * records (0 for a flattened document); for a TIFF the layers of its
   * Photoshop layer data (tag 37724), else 1 when it has an alpha sample and
   * 0 when it has none (AE 2026).
   */
  layerCount: number;
  /**
   * The Photoshop colour mode of a PSD/PSB, or the one a TIFF reads as
   * (PSD/PSB and TIFF only): 0 bitmap, 1 grayscale, 2 indexed, 3 RGB,
   * 4 CMYK, 9 Lab.
   */
  colorMode: number;
  /**
   * Channels in the pixel buffer whose size AE caches (PSD/PSB and TIFF):
   * the colour channels, plus one for the transparency of a PSD's layers, or
   * a TIFF's alpha sample or Photoshop layer data (AE 2026: 2 for a layered
   * gray PSD, 4 for CMYK; a flattened PSD's alpha channel does not count).
   * 0 for other formats.
   */
  pixelChannels: number;
  /**
   * The ICC color profile the file embeds, for the formats that can carry
   * one (PNG, JPEG, TIFF, PSD/PSB). After Effects records it in the footage
   * `LIST:CLRS` and shows it as "Embedded"; `null` means the file carries
   * none, and AE assigns a profile instead.
   */
  iccProfile: Uint8Array | null;
  /**
   * The pixel depth After Effects caches for the footage (`sspc` byte 0x3E,
   * see `SspcChunk.depth`); 0 for media without video.
   */
  depth: number;
  /** OpenEXR only: the (first part's) compression code. */
  compression: number;
  /**
   * OpenEXR only: every channel, those of a named part of a multi-part
   * file prefixed with the part's name (`"Z.A"`).
   */
  channelNames: readonly string[];
}

export const MEDIA_INFO_DEFAULTS: MediaInfoFields = {
  width: 0,
  height: 0,
  duration: 0.0,
  frameRate: 0.0,
  hasAlpha: false,
  hasAudio: false,
  audioSampleRate: 0.0,
  pixelAspect: 1.0,
  bitDepth: 8,
  layerCount: 0,
  colorMode: 0,
  pixelChannels: 0,
  iccProfile: null,
  depth: 0,
  compression: 0,
  channelNames: [],
};

/** Footage metadata read from a media-file header. Built from keyword fields, defaults as in Python. */
export class MediaInfo implements MediaInfoFields {
  declare readonly width: number;
  declare readonly height: number;
  declare readonly duration: number;
  declare readonly frameRate: number;
  declare readonly hasAlpha: boolean;
  declare readonly hasAudio: boolean;
  declare readonly audioSampleRate: number;
  declare readonly pixelAspect: number;
  declare readonly bitDepth: number;
  declare readonly layerCount: number;
  declare readonly colorMode: number;
  declare readonly pixelChannels: number;
  declare readonly iccProfile: Uint8Array | null;
  declare readonly depth: number;
  declare readonly compression: number;
  declare readonly channelNames: readonly string[];

  constructor(kw: Partial<MediaInfoFields> = {}) {
    Object.assign(this, MEDIA_INFO_DEFAULTS, kw);
  }

  /** `NamedTuple._replace(**kw)`: a copy with the given fields swapped. */
  _replace(kw: Partial<MediaInfoFields>): MediaInfo {
    return new MediaInfo({ ...this, ...kw });
  }

  /** Tuple equality: field-wise, in declaration order. */
  equals(other: unknown): boolean {
    return other instanceof MediaInfo && pyEq([...this], [...other]);
  }

  /** NamedTuple unpacking: the fields in declaration order. */
  *[Symbol.iterator](): Generator<number | boolean | Uint8Array | null | readonly string[]> {
    yield this.width;
    yield this.height;
    yield this.duration;
    yield this.frameRate;
    yield this.hasAlpha;
    yield this.hasAudio;
    yield this.audioSampleRate;
    yield this.pixelAspect;
    yield this.bitDepth;
    yield this.layerCount;
    yield this.colorMode;
    yield this.pixelChannels;
    yield this.iccProfile;
    yield this.depth;
    yield this.compression;
    yield this.channelNames;
  }
}

/** AE's depth for grayscale pixels by bits per sample (AE 2026 imports of grayscale PNG, TIFF and PSD files). */
export const _GRAY_DEPTHS: Map<number, number> = new Map([
  [1, 1],
  [2, 34],
  [4, 36],
  [8, 40],
  [16, -16],
  [32, -32],
]);

/** AE's depth for RGB pixels, or RGBA when `has_alpha` (24 / 48 / 96 and 32 / 64 / 128 at 8 / 16 / 32 bits per channel). */
export function _colorDepth(hasAlpha: boolean, bitsPerChannel: number): number {
  return (hasAlpha ? 4 : 3) * bitsPerChannel;
}

/**
 * AE's depth for a TIFF or Photoshop image: RGB(A), except that without
 * alpha a grayscale one stays gray (bilevel: 0) and an indexed one keeps
 * its bits per sample (AE 2026).
 */
export function _imageDepth(hasAlpha: boolean, bits: number, kw: { gray?: boolean; indexed?: boolean } = {}): number {
  const { gray = false, indexed = false } = kw;
  if (hasAlpha || !(gray || indexed)) return _colorDepth(hasAlpha, bits);
  if (indexed) return bits;
  return bits === 1 ? 0 : _GRAY_DEPTHS.get(bits) ?? 0;
}

export class _BoundedReader {
  private readonly _fp: FileReader;
  private readonly _size: number;

  /**
   * A read-only binary file whose reads never ask for more than the bytes
   * left in it.
   *
   * A file object allocates the size it is asked for before reading, so a
   * corrupt size field (`0xFFFFFFF0` in a 36-byte EXR) made `read(size)`
   * allocate 4 GB. Clamped, every probe's memory stays proportional to the
   * file. A seek before the start raises `ValueError`, as `io.BytesIO` does.
   */
  constructor(fp: FileReader) {
    this._fp = fp;
    this._size = fp.seek(0, SEEK_END);
    fp.seek(0);
  }

  read(size: number | null = -1): Uint8Array {
    const left = Math.max(this._size - this._fp.tell(), 0);
    if (size == null || size < 0 || size > left) size = left;
    return this._fp.read(size);
  }

  readline(size: number | null = -1): Uint8Array {
    return this._fp.readline(size == null ? -1 : size);
  }

  *[Symbol.iterator](): Generator<Uint8Array> {
    yield* this._fp;
  }

  seek(offset: number, whence = SEEK_SET): number {
    const base = whence === SEEK_SET ? 0 : whence === SEEK_CUR ? this._fp.tell() : this._size;
    if (base + offset < 0) throw new ValueError(`negative seek position ${base + offset}`);
    return this._fp.seek(offset, whence);
  }

  tell(): number {
    return this._fp.tell();
  }
}

/**
 * `fp.read(size)`, never asking for more than the bytes left after the
 * stream position (see `_BoundedReader` for why).
 */
export function readBounded(fp: ProbeStream, size: number): Uint8Array {
  const here = fp.tell();
  const end = fp.seek(0, SEEK_END);
  fp.seek(here);
  return fp.read(Math.max(Math.min(size, end - here), 0));
}

/**
 * Read footage metadata from a media file's header.
 *
 * @param file - Path to the source media file (drives the format dispatch).
 * @param data - The file's bytes, if the caller already read them; probed
 *   in memory instead of re-reading `file`.
 *
 * @throws NotImplementedError If header probing is not implemented for the
 *   file's extension.
 * @throws ValueError If the file is not a valid file of its format, or is
 *   truncated or malformed.
 */
export function probeMedia(file: Path, data: Uint8Array | null = null): MediaInfo {
  const suffix = file.suffix.toLowerCase();
  const parser = _PARSERS.get(suffix);
  if (parser == null) {
    throw new NotImplementedError(
      `Media-header probing is not implemented for ${repr(suffix)}. ` +
        `Supported: ${sorted([..._PARSERS.keys()]).join(", ")}.`,
    );
  }
  // The parsers trust the header layout; a truncated or corrupt file would
  // otherwise surface as a raw struct.error / IndexError from deep inside
  // one of them.
  try {
    if (data != null) return parser(new BytesIO(data));
    const fp = openRb(file.path);
    try {
      return parser(new _BoundedReader(fp));
    } finally {
      fp.close();
    }
  } catch (exc: unknown) {
    if (!(exc instanceof StructError || exc instanceof IndexError)) throw exc;
    throw Object.assign(
      new ValueError(`${file.name}: truncated or malformed ${suffix} file (${exc.message})`),
      { cause: exc },
    );
  }
}

// ---------------------------------------------------------------------------
// PNG - IHDR (still image)
// ---------------------------------------------------------------------------

export const _PNG_SIGNATURE = b("\x89PNG\r\n\x1a\n");

export function _probePng(fp: ProbeStream): MediaInfo {
  const sig = fp.read(8);
  if (!bytesEq(sig, _PNG_SIGNATURE)) throw new ValueError("Not a valid PNG file (bad signature)");
  // First chunk must be IHDR: length(4) "IHDR"(4) width(4) height(4) bitdepth(1) colortype(1)
  fp.read(4); // IHDR length
  if (!bytesEq(fp.read(4), b("IHDR"))) throw new ValueError("PNG missing IHDR chunk");
  const [width, height] = struct.unpack(">II", fp.read(8));
  const bitDepth = _byteAt(fp.read(1), 0);
  const colorType = _byteAt(fp.read(1), 0);
  // color_type bit 2 (value 4) means an alpha channel (types 4 and 6).
  const hasAlpha = (colorType & 4) !== 0;
  fp.seek(7, SEEK_CUR); // rest of IHDR (compression/filter/interlace) + its CRC
  const [hasTrns, iccProfile] = _pngColorChunks(fp);
  // AE keeps grayscale gray and expands a palette to RGBA at any bit depth;
  // a `tRNS` chunk adds alpha without changing the depth (AE 2026).
  let depth: number;
  if (colorType === 0) depth = _GRAY_DEPTHS.get(bitDepth) ?? 0;
  else if (colorType === 3) depth = _colorDepth(true, 8);
  else depth = _colorDepth(hasAlpha, bitDepth);
  return new MediaInfo({
    width,
    height,
    hasAlpha: hasAlpha || hasTrns,
    iccProfile: iccProfile,
    depth,
  });
}

/**
 * The `tRNS` presence and `iCCP` profile of a PNG, if any.
 *
 * AE reports alpha for a `tRNS`-carrying PNG of colour type 0, 2 and 3 alike:
 * the chunk names a transparent colour, or per-palette-entry alpha, for the
 * types that have no alpha channel of their own. `fp` must be positioned at
 * the first chunk after IHDR. Both chunks precede the image data, so the
 * scan stops there.
 */
export function _pngColorChunks(fp: ProbeStream): [boolean, Uint8Array | null] {
  let hasTrns = false;
  let iccProfile: Uint8Array | null = null;
  for (;;) {
    const header = fp.read(8);
    if (header.length < 8) break;
    const [length, chunkType] = struct.unpack(">I4s", header);
    if (bytesEq(chunkType, b("IDAT")) || bytesEq(chunkType, b("IEND"))) break;
    if (bytesEq(chunkType, b("tRNS"))) {
      hasTrns = true;
    } else if (bytesEq(chunkType, b("iCCP"))) {
      iccProfile = _pngIccp(fp.read(length));
      fp.seek(4, SEEK_CUR); // CRC
      continue;
    }
    fp.seek(length + 4, SEEK_CUR); // chunk body + CRC
  }
  return [hasTrns, iccProfile];
}

/**
 * The profile in an `iCCP` chunk: a name, NUL, compression method, then
 * the deflated profile. An unreadable one counts as absent, the way AE
 * treats it.
 */
export function _pngIccp(body: Uint8Array): Uint8Array | null {
  const split = bytes_.find(body, 0); // body.find(b"\x00")
  if (split < 0 || !bytesEq(bytes_.slice(body, split + 1, split + 2), b("\x00"))) return null; // 0 = deflate
  try {
    return zlib.decompress(body.slice(split + 2));
  } catch (e) {
    // zlib.error: an unreadable profile counts as absent.
    if (e instanceof zlib.error) return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// WAV - RIFF fmt + data (audio only)
// ---------------------------------------------------------------------------

/**
 * `RF64` and `BW64` carry the same WAVE payload as `RIFF` but move the 64-bit
 * sizes into a `ds64` chunk, which lets them exceed 4 GB. AE imports both.
 */
export const _WAV_RIFF_IDS = [b("RIFF"), b("RF64"), b("BW64")];

export function _probeWav(fp: ProbeStream): MediaInfo {
  const riffId = fp.read(4);
  if (!_WAV_RIFF_IDS.some((id) => bytesEq(riffId, id))) throw new ValueError("Not a valid WAV file (missing RIFF)");
  fp.read(4); // RIFF chunk size (0xFFFFFFFF for RF64; the real one is in ds64)
  if (!bytesEq(fp.read(4), b("WAVE"))) throw new ValueError("Not a valid WAV file (missing WAVE)");
  fp.seek(0, SEEK_END);
  const fileSize = fp.tell();
  fp.seek(12);
  let sampleRate = 0;
  let byteRate = 0;
  let dataSize = 0;
  let ds64DataSize = 0;
  for (;;) {
    const header = fp.read(8);
    if (header.length < 8) break;
    const [chunkId, chunkSize] = struct.unpack("<4sI", header);
    if (bytesEq(chunkId, b("fmt "))) {
      const fmt = fp.read(chunkSize);
      // audio_format(2) channels(2) sample_rate(4) byte_rate(4) ...
      [sampleRate, byteRate] = struct.unpack("<II", fmt.slice(4, 12));
    } else if (bytesEq(chunkId, b("ds64"))) {
      // riffSize(8) dataSize(8) sampleCount(8) tableLength(4) ...
      const body = fp.read(chunkSize);
      if (body.length >= 16) ds64DataSize = Number(struct.unpack("<Q", body.slice(8, 16))[0]);
    } else if (bytesEq(chunkId, b("data"))) {
      dataSize = ds64DataSize || chunkSize;
      // A writer streaming to a pipe cannot seek back to patch the size,
      // so it leaves 0xFFFFFFFF behind. Trust the bytes that are actually
      // present instead - AE takes the declared size at face value and
      // reports a 6-hour duration, which is not worth reproducing.
      const start = fp.tell();
      if (dataSize === 0xffffffff || start + dataSize > fileSize) dataSize = fileSize - start;
      break;
    } else {
      fp.seek(chunkSize + (chunkSize & 1), SEEK_CUR); // chunks are word-aligned
    }
  }
  const duration = byteRate ? dataSize / byteRate : 0.0;
  return new MediaInfo({
    duration,
    hasAudio: true,
    audioSampleRate: sampleRate,
  });
}

// ---------------------------------------------------------------------------
// AIFF / AIFC - IFF COMM chunk (audio only)
// ---------------------------------------------------------------------------

/** Decode an 80-bit IEEE-754 extended float (big-endian, AIFF sampleRate). */
export function _readExtended(b_: Uint8Array): number {
  const exp = ((_byteAt(b_, 0) << 8) | _byteAt(b_, 1)) & 0x7fff;
  const mant = bytes_.intFromBytes(b_.slice(2, 10), "big");
  if (exp === 0 && mant === 0) return 0.0;
  const sign = _byteAt(b_, 0) & 0x80 ? -1.0 : 1.0;
  // The 64-bit mantissa carries an explicit integer bit (bit 63).
  return sign * mant * 2.0 ** (exp - 16383 - 63);
}

export function _probeAiff(fp: ProbeStream): MediaInfo {
  if (!bytesEq(fp.read(4), b("FORM"))) throw new ValueError("Not a valid AIFF/AIFC file (missing FORM)");
  fp.read(4); // FORM chunk size
  const formType = fp.read(4);
  if (!(bytesEq(formType, b("AIFF")) || bytesEq(formType, b("AIFC")))) {
    throw new ValueError("Not a valid AIFF/AIFC file (bad form type)");
  }
  for (;;) {
    const header = fp.read(8);
    if (header.length < 8) break;
    const [chunkId, chunkSize] = struct.unpack(">4sI", header);
    if (bytesEq(chunkId, b("COMM"))) {
      const body = fp.read(chunkSize);
      // numChannels(2) numSampleFrames(4) sampleSize(2) sampleRate(10)
      const numFrames = struct.unpack(">I", body.slice(2, 6))[0];
      const sampleRate = _readExtended(body.slice(8, 18));
      const duration = sampleRate ? numFrames / sampleRate : 0.0;
      return new MediaInfo({
        duration,
        hasAudio: true,
        audioSampleRate: sampleRate,
      });
    }
    // AIFF chunks are word-aligned (an odd size has a trailing pad byte).
    fp.seek(chunkSize + (chunkSize & 1), SEEK_CUR);
  }
  return new MediaInfo({ hasAudio: true });
}

// ---------------------------------------------------------------------------
// EXR - header attributes (still image; sequences handled by the caller)
// ---------------------------------------------------------------------------

export const _EXR_MAGIC = b("\x76\x2f\x31\x01");

export function _readCstr(fp: ProbeStream): Uint8Array {
  const out: number[] = [];
  for (;;) {
    const c = fp.read(1);
    if (c.length === 0 || c[0] === 0) return Uint8Array.from(out);
    out.push(c[0]);
  }
}

/** Version-field flag of a multi-part EXR (one header per part, then a 0 byte). */
export const _EXR_MULTIPART = 0x1000;

export function _probeExr(fp: ProbeStream): MediaInfo {
  if (!bytesEq(fp.read(4), _EXR_MAGIC)) throw new ValueError("Not a valid EXR file (bad magic)");
  const multipart = (struct.unpack("<I", fp.read(4))[0] & _EXR_MULTIPART) !== 0;
  const parts: ExrHeader[] = [_readExrHeader(fp)];
  while (multipart) {
    const c = fp.read(1);
    if (c.length === 0 || c[0] === 0) break; // the empty header ends the list
    fp.seek(-1, SEEK_CUR);
    parts.push(_readExrHeader(fp));
  }
  const first = parts[0];
  const firstList = first.channels ?? [];
  const hasAlpha = firstList.some((c) => c === "A" || c === "a");
  const channelNames = parts.flatMap((part) =>
    (part.channels ?? []).map((c) => (part.name ? `${part.name}.${c}` : c)),
  );
  // AE reads OpenEXR as 32-bit float, half-float channels included. Its
  // footage size and alpha come from the first part. A luminance-only part
  // (a lone Y channel) reads as float grayscale (AE 2026: exr/y.exr caches
  // depth -32; Y + A reads as RGBA float, 128).
  const firstChannels = new Set(firstList);
  const luminanceOnly = !hasAlpha && firstChannels.has("Y") && !(firstChannels.has("R") || firstChannels.has("G") || firstChannels.has("B"));
  return new MediaInfo({
    width: first.width ?? 0,
    height: first.height ?? 0,
    hasAlpha: hasAlpha,
    pixelAspect: first.pixelAspect ?? 1.0,
    frameRate: first.frameRate ?? 0.0,
    depth: luminanceOnly ? getitem(_GRAY_DEPTHS, 32) : _colorDepth(hasAlpha, 32),
    compression: first.compression ?? 0,
    channelNames: channelNames,
  });
}

/** The attributes `_probe_exr` uses from one EXR part header; each is absent when the header lacks it. */
export interface ExrHeader {
  width?: number;
  height?: number;
  compression?: number;
  channels?: string[];
  name?: string;
  pixelAspect?: number;
  frameRate?: number;
}

/** The attributes `_probe_exr` uses from one EXR part header. */
export function _readExrHeader(fp: ProbeStream): ExrHeader {
  const out: ExrHeader = {};
  for (;;) {
    const name = _readCstr(fp);
    if (name.length === 0) return out; // empty name terminates the header
    _readCstr(fp); // attribute type
    const size = struct.unpack("<I", fp.read(4))[0];
    const value = fp.read(size);
    // AE sizes EXR footage by the displayWindow (canvas), not the
    // dataWindow (actual pixel-data extent, which may be cropped/oversized).
    if (bytesEq(name, b("displayWindow"))) {
      const [xMin, yMin, xMax, yMax] = struct.unpack("<iiii", value);
      out.width = xMax - xMin + 1;
      out.height = yMax - yMin + 1;
    } else if (bytesEq(name, b("channels"))) {
      out.channels = _exrChannelNames(value);
    } else if (bytesEq(name, b("compression"))) {
      out.compression = _byteAt(value, 0);
    } else if (bytesEq(name, b("name"))) {
      out.name = decode(bytes_.rstrip(value, b("\x00")), "utf-8", "replace");
    } else if (bytesEq(name, b("pixelAspectRatio"))) {
      out.pixelAspect = struct.unpack("<f", value)[0];
    } else if (bytesEq(name, b("framesPerSecond"))) {
      const [num, den] = struct.unpack("<ii", value);
      out.frameRate = den ? num / den : 0.0;
    }
  }
}

/**
 * A chlist is a sequence of null-terminated channel names, each followed
 * by 16 bytes of channel data, terminated by an empty name.
 */
export function _exrChannelNames(value: Uint8Array): string[] {
  const names: string[] = [];
  let pos = 0;
  while (pos < value.length) {
    const end = bytes_.find(value, 0, pos); // value.find(b"\x00", pos)
    if (end <= pos) break; // empty name -> end of list
    names.push(decode(value.slice(pos, end), "utf-8", "replace"));
    pos = end + 1 + 16; // skip name terminator + 16-byte channel descriptor
  }
  return names;
}

// ---------------------------------------------------------------------------
// TIFF - IFD tags (still image)
// ---------------------------------------------------------------------------

/**
 * Colour channels per TIFF PhotometricInterpretation; a sample beyond them is
 * alpha. Modes: 0/1 bilevel+greyscale, 2 RGB, 3 palette, 5 CMYK, 6 YCbCr.
 */
export const _TIFF_BASE_CHANNELS: Map<number, number> = new Map([
  [0, 1],
  [1, 1],
  [2, 3],
  [3, 1],
  [5, 4],
  [6, 3],
]);

/** Struct codes for the IFD value types BigTIFF stores dimensions in. */
export const _BIGTIFF_VALUE_FMT: Map<number, "H" | "I" | "Q"> = new Map([
  [3, "H"],
  [4, "I"],
  [16, "Q"],
]);

/** TIFF tag 34675: the embedded ICC profile. */
export const _TIFF_ICC_TAG = 0x8773;

/** TIFF tag 37724: Photoshop's layer data (a layered TIFF saved by Photoshop). */
export const _TIFF_PHOTOSHOP_LAYERS_TAG = 0x935c;

/** The signature tag 37724 opens with, ahead of PSD additional-info blocks. */
export const _PHOTOSHOP_DATA_HEADER = b("Adobe Photoshop Document Data Block\x00");

/**
 * The Photoshop colour mode a TIFF reads as, per PhotometricInterpretation
 * (a 1-bit grayscale TIFF is bitmap; CIELab is Lab). Measured on AE 2026
 * (footage_depth.aep, photoshop_modes.aep).
 */
export const _TIFF_COLOR_MODES: Map<number, number> = new Map([
  [0, 1],
  [1, 1],
  [2, 3],
  [3, 2],
  [5, 4],
  [8, 9],
]);

/**
 * The layer count of a TIFF's Photoshop layer data (tag 37724).
 *
 * The tag holds PSD additional-information blocks in the TIFF's byte order
 * (a little-endian file reverses every 4-character code: `MIB8ryaL`). The
 * `Layr` block (`Lr16`/`Lr32` at 16/32 bits) opens with the signed layer
 * count. 0 when no such block is found.
 */
export function _tiffPhotoshopLayerCount(fp: ProbeStream, en: "<" | ">", offset: number, length: number): number {
  if (length < _PHOTOSHOP_DATA_HEADER.length) return 0;
  const end = offset + length;
  fp.seek(offset);
  if (!bytesEq(fp.read(_PHOTOSHOP_DATA_HEADER.length), _PHOTOSHOP_DATA_HEADER)) return 0;
  while (fp.tell() + 12 <= end) {
    const head = fp.read(12);
    let signature = head.slice(0, 4);
    let key = head.slice(4, 8);
    if (en === "<") {
      signature = signature.reverse();
      key = key.reverse();
    }
    if (!bytesEq(signature, b("8BIM"))) break;
    const blockLen = struct.unpack(`${en}I`, head.slice(8, 12))[0];
    if (_LAYER_RECORD_KEYS.some((k) => bytesEq(key, k))) {
      const countRaw = fp.read(2);
      if (countRaw.length < 2) return 0;
      const count: number = struct.unpack(`${en}h`, countRaw)[0];
      return Math.abs(count);
    }
    fp.seek(blockLen + ((4 - (blockLen % 4)) % 4), SEEK_CUR); // blocks are padded to 4 bytes
  }
  return 0;
}

/**
 * `MediaInfo` of a classic TIFF or a BigTIFF, from its first IFD's tags;
 * the values stored by offset (`bits_offset`, and the `(offset, length)`
 * spans of the ICC profile and the Photoshop layer data) are read here.
 *
 * AE 2026 gives a TIFF alpha for a sample beyond its colour channels, or for
 * Photoshop layer data (whose layers can be transparent), and not otherwise.
 * Without alpha a grayscale TIFF stays gray (bilevel: depth 0) and a palette
 * stays indexed; CMYK and YCbCr read as RGB. `pixelChannels` counts the
 * colour channels plus one for an extra sample marked as alpha
 * (`extra_alpha`: ExtraSamples 1 or 2, not 0 = unspecified) or for
 * Photoshop layer data. `photoshop_layers` is the layer count of that data
 * (tag 37724), `null` when the file has none; without it AE counts an
 * image with an alpha sample as one layer.
 */
export function _tiffMediaInfo(
  fp: ProbeStream,
  en: "<" | ">",
  width: number,
  height: number,
  samples: number,
  bits: number,
  bitsOffset: number | null,
  photometric: number,
  extraAlpha: boolean,
  iccSpan: [number, number] | null,
  photoshopSpan: [number, number] | null,
): MediaInfo {
  if (bitsOffset != null) {
    fp.seek(bitsOffset);
    bits = struct.unpack(`${en}H`, fp.read(2))[0];
  }
  let iccProfile: Uint8Array | null = null;
  if (iccSpan != null) {
    fp.seek(iccSpan[0]);
    iccProfile = fp.read(iccSpan[1]);
  }
  let photoshopLayers: number | null = null;
  if (photoshopSpan != null) photoshopLayers = _tiffPhotoshopLayerCount(fp, en, ...photoshopSpan);
  if (!(1 <= bits && bits <= 64)) throw new ValueError(`Not a valid TIFF file (${bits} bits per sample)`);
  if ([0, 1, 3].includes(photometric) && 1 < bits && bits < 8) {
    // AE 2026 reads a 2- or 4-bit grayscale or palette TIFF as 8 bits:
    // depth 40 (gray) / 8 (palette), an 8-bit opti and a byte-per-pixel
    // cached size (synthetic tif_g2/g4/pal4 vs AE's import). Bilevel
    // (1-bit) stays as it is.
    bits = 8;
  }
  const layered = photoshopLayers != null;
  const base = _TIFF_BASE_CHANNELS.get(photometric) ?? 3;
  const hasAlpha = samples > base || layered;
  const depth = _imageDepth(hasAlpha, bits, { gray: photometric === 0 || photometric === 1, indexed: photometric === 3 });
  // A palette image's alpha sample is not counted in the opti channels,
  // layer count or cached size, unlike a grayscale or RGB one (AE 2026:
  // an 8-bit palette TIFF with an ExtraSamples alpha records 1 channel,
  // 0 layers and w * h bytes; gray + alpha records 2 channels, 1 layer).
  const countedAlpha = extraAlpha && photometric !== 3;
  return new MediaInfo({
    width,
    height,
    hasAlpha: hasAlpha,
    iccProfile: iccProfile,
    depth,
    bitDepth: bits,
    layerCount: photoshopLayers || (countedAlpha ? 1 : 0),
    colorMode: bits === 1 ? 0 : _TIFF_COLOR_MODES.get(photometric) ?? 3,
    pixelChannels: countedAlpha || layered ? base + 1 : base,
  });
}

/**
 * Probe a BigTIFF (magic 43): 8-byte offsets and 20-byte IFD entries.
 *
 * AE reads BigTIFF, so returning 0x0 would write an unusable footage item.
 */
export function _probeBigtiff(fp: ProbeStream, en: "<" | ">"): MediaInfo {
  if (struct.unpack(`${en}H`, fp.read(2))[0] !== 8) throw new ValueError("Unsupported BigTIFF offset size (expected 8)");
  fp.read(2); // reserved, always 0
  fp.seek(Number(struct.unpack(`${en}Q`, fp.read(8))[0]));
  let width = 0;
  let height = 0;
  let samples = 1;
  let bits = 1;
  let photometric = 2;
  let extraAlpha = false;
  let bitsOffset: number | null = null;
  let iccSpan: [number, number] | null = null;
  let photoshopSpan: [number, number] | null = null;
  for (let i = 0, n = Number(struct.unpack(`${en}Q`, fp.read(8))[0]); i < n; i++) {
    const entry = fp.read(20);
    if (entry.length < 20) break;
    const [tag, typ] = struct.unpack(`${en}HH`, entry.slice(0, 4));
    const length = Number(struct.unpackFrom(`${en}Q`, entry, 4)[0]);
    if (tag === _TIFF_ICC_TAG) {
      if (length > 8) iccSpan = [Number(struct.unpackFrom(`${en}Q`, entry, 12)[0]), length]; // values this long are stored by offset
      continue;
    }
    if (tag === _TIFF_PHOTOSHOP_LAYERS_TAG) {
      photoshopSpan = [Number(struct.unpackFrom(`${en}Q`, entry, 12)[0]), length];
      continue;
    }
    const fmt = _BIGTIFF_VALUE_FMT.get(typ) ?? null;
    if (fmt == null) continue;
    // A value of 8 bytes or fewer is stored inline in the value field.
    const val = Number(struct.unpackFrom(`${en}${fmt}`, entry, 12)[0]);
    if (tag === 0x0100) {
      width = val;
    } else if (tag === 0x0101) {
      height = val;
    } else if (tag === 0x0102) {
      // BitsPerSample, one SHORT per sample
      if (length > 4) bitsOffset = Number(struct.unpackFrom(`${en}Q`, entry, 12)[0]);
      else bits = val;
    } else if (tag === 0x0106) {
      photometric = val;
    } else if (tag === 0x0115) {
      samples = val;
    } else if (tag === 0x0152) {
      // ExtraSamples: 1 / 2 = (un)associated alpha
      extraAlpha = length <= 4 && (val === 1 || val === 2);
    }
  }
  return _tiffMediaInfo(fp, en, width, height, samples, bits, bitsOffset, photometric, extraAlpha, iccSpan, photoshopSpan);
}

export function _probeTiff(fp: ProbeStream): MediaInfo {
  const bo = fp.read(2);
  if (!(bytesEq(bo, b("II")) || bytesEq(bo, b("MM")))) throw new ValueError(`Not a valid TIFF file (bad byte order ${repr(bo)})`);
  const en = bytesEq(bo, b("II")) ? "<" : ">";
  const version = struct.unpack(`${en}H`, fp.read(2))[0];
  if (version === 43) return _probeBigtiff(fp, en);
  if (version !== 42) throw new ValueError(`Not a valid TIFF file (bad magic ${version})`);
  const ifdOffset = struct.unpack(`${en}I`, fp.read(4))[0];
  fp.seek(ifdOffset);
  const count = struct.unpack(`${en}H`, fp.read(2))[0];
  let width = 0;
  let height = 0;
  let samples = 1;
  let bits = 1;
  let photometric = 2;
  let extraAlpha = false;
  let bitsOffset: number | null = null;
  let iccSpan: [number, number] | null = null;
  let photoshopSpan: [number, number] | null = null;
  for (let i = 0; i < count; i++) {
    const entry = fp.read(12);
    const [tag, typ] = struct.unpack(`${en}HH`, entry.slice(0, 4));
    const length = struct.unpack(`${en}I`, entry.slice(4, 8))[0];
    const val = typ === 3 ? struct.unpack(`${en}H`, entry.slice(8, 10))[0] : struct.unpack(`${en}I`, entry.slice(8, 12))[0];
    if (tag === 0x0100) {
      width = val;
    } else if (tag === 0x0101) {
      height = val;
    } else if (tag === 0x0102) {
      // BitsPerSample, one SHORT per sample
      if (length > 2) bitsOffset = struct.unpack(`${en}I`, entry.slice(8, 12))[0];
      else bits = val;
    } else if (tag === 0x0106) {
      photometric = val;
    } else if (tag === 0x0115) {
      samples = val;
    } else if (tag === 0x0152) {
      // ExtraSamples: 1 / 2 = (un)associated alpha
      extraAlpha = length <= 2 && (val === 1 || val === 2);
    } else if (tag === _TIFF_PHOTOSHOP_LAYERS_TAG) {
      photoshopSpan = [val, length]; // stored by offset (> 4 bytes)
    } else if (tag === _TIFF_ICC_TAG && length > 4) {
      iccSpan = [val, length]; // values this long are stored by offset
    }
  }
  return _tiffMediaInfo(fp, en, width, height, samples, bits, bitsOffset, photometric, extraAlpha, iccSpan, photoshopSpan);
}

// ---------------------------------------------------------------------------
// JPEG - SOF marker (still image, never alpha)
// ---------------------------------------------------------------------------

export function _probeJpeg(fp: ProbeStream): MediaInfo {
  fp.read(2); // SOI
  let width = 0;
  let height = 0;
  // An ICC profile too large for one segment is split over numbered APP2
  // chunks that have to be concatenated in order.
  const iccChunks: Map<number, Uint8Array> = new Map();
  for (;;) {
    const c = fp.read(1);
    if (c.length === 0) break;
    if (!bytesEq(c, b("\xff"))) continue;
    let marker = fp.read(1);
    while (bytesEq(marker, b("\xff"))) marker = fp.read(1); // skip fill bytes
    const m = _byteAt(marker, 0);
    if (m === 0xda) break; // start of scan: no metadata past here
    // SOF0..SOF15 carry the frame size, except DHT(C4)/JPG(C8)/DAC(CC).
    if (0xc0 <= m && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) {
      fp.read(3); // length(2) + precision(1)
      [height, width] = struct.unpack(">HH", fp.read(4));
      continue;
    }
    const length = struct.unpack(">H", fp.read(2))[0];
    if (m === 0xe2) {
      // APP2, where an ICC profile lives
      const body = fp.read(length - 2);
      if (bytes_.startswith(body, b("ICC_PROFILE\x00"))) iccChunks.set(_byteAt(body, 12), body.slice(14));
      continue;
    }
    fp.seek(length - 2, SEEK_CUR);
  }
  const iccBytes = bytes_.join(sorted([...iccChunks.keys()]).map((key) => getitem(iccChunks, key)));
  const iccProfile = iccBytes.length > 0 ? iccBytes : null;
  return new MediaInfo({
    width,
    height,
    hasAlpha: false,
    iccProfile: iccProfile,
    depth: _colorDepth(false, 8),
  });
}

// ---------------------------------------------------------------------------
// TGA - 18-byte header (still image)
// ---------------------------------------------------------------------------

export function _probeTga(fp: ProbeStream): MediaInfo {
  const header = fp.read(18);
  const [width, height] = struct.unpack("<HH", header.slice(12, 16));
  const imageType = _byteAt(header, 2);
  const bitsPerPixel = _byteAt(header, 16);
  // AE treats only 32-bit TGA as having alpha (16-bit's single attribute
  // bit and 24-bit are reported as no-alpha). A colour-mapped image stays
  // indexed and a grayscale one gray (AE 2026; image types 9-11 are the
  // run-length encoded 1-3).
  const hasAlpha = bitsPerPixel === 32;
  let depth: number;
  if (imageType === 1 || imageType === 9) depth = bitsPerPixel;
  else if (imageType === 3 || imageType === 11) depth = _GRAY_DEPTHS.get(bitsPerPixel) ?? 0;
  else depth = _colorDepth(hasAlpha, 8);
  return new MediaInfo({ width, height, hasAlpha: hasAlpha, depth });
}

export function _probeBmp(fp: ProbeStream): MediaInfo {
  fp.read(14); // BITMAPFILEHEADER
  const dibSize = struct.unpack("<I", fp.read(4))[0];
  let width: number;
  let height: number;
  if (dibSize === 12) {
    // Legacy OS/2 BITMAPCOREHEADER stores width/height as u2.
    [width, height] = struct.unpack("<HH", fp.read(4));
  } else {
    // BITMAPINFOHEADER (or later): width u4, height s4 (negative = top-down).
    width = struct.unpack("<I", fp.read(4))[0];
    height = Math.abs(struct.unpack("<i", fp.read(4))[0]);
  }
  // AE allocates an alpha channel for BMP regardless of bit depth.
  return new MediaInfo({ width, height, hasAlpha: true, depth: _colorDepth(true, 8) });
}

// ---------------------------------------------------------------------------
// GIF - logical screen descriptor (still image; AE treats GIF as alpha)
// ---------------------------------------------------------------------------

/** Seek past a chain of GIF data sub-blocks, up to its 0-length terminator. */
export function _skipGifSubBlocks(fp: ProbeStream): void {
  for (;;) {
    const size = fp.read(1);
    if (size.length === 0 || size[0] === 0) return;
    fp.seek(size[0], SEEK_CUR);
  }
}

/**
 * Return `(image count, summed delay in hundredths of a second)`.
 *
 * `fp` must be positioned after the logical screen descriptor and any global
 * colour table. AE plays an animated GIF at the rate the Graphic Control
 * Extension delays imply, so they decide both duration and frame rate.
 */
export function _gifFrameTiming(fp: ProbeStream): [number, number] {
  let frames = 0;
  let delay = 0;
  for (;;) {
    const block = fp.read(1);
    if (block.length === 0 || block[0] === 0x3b) return [frames, delay]; // trailer
    if (block[0] === 0x21) {
      // extension
      if (bytesEq(fp.read(1), b("\xf9"))) {
        // graphic control
        const size = fp.read(1);
        if (size.length === 0) return [frames, delay];
        const body = fp.read(size[0]);
        if (body.length >= 3) delay += struct.unpackFrom("<H", body, 1)[0];
      }
      _skipGifSubBlocks(fp);
    } else if (block[0] === 0x2c) {
      // image descriptor
      frames += 1;
      fp.seek(8, SEEK_CUR); // left, top, width, height
      const packed = fp.read(1);
      if (packed.length === 0) return [frames, delay];
      if (packed[0] & 0x80) fp.seek(3 * (1 << ((packed[0] & 0x07) + 1)), SEEK_CUR); // local colour table
      fp.read(1); // LZW minimum code size
      _skipGifSubBlocks(fp);
    } else {
      // not a block introducer: the stream is not walkable
      return [frames, delay];
    }
  }
}

export function _probeGif(fp: ProbeStream): MediaInfo {
  const sig = fp.read(6);
  if (!bytesEq(sig.slice(0, 3), b("GIF")) || !(bytesEq(sig.slice(3), b("87a")) || bytesEq(sig.slice(3), b("89a")))) {
    throw new ValueError("Not a valid GIF file (bad signature)");
  }
  const [width, height] = struct.unpack("<HH", fp.read(4));
  const packed = _byteAt(fp.read(1), 0);
  fp.read(2); // background colour index + pixel aspect ratio
  if (packed & 0x80) fp.seek(3 * (1 << ((packed & 0x07) + 1)), SEEK_CUR); // global colour table
  let [frames, delay] = _gifFrameTiming(fp);
  const depth = _colorDepth(true, 8); // AE reads every GIF as RGBA
  if (frames < 2) return new MediaInfo({ width, height, hasAlpha: true, depth }); // a still
  if (delay === 0) {
    // Nothing in the file says how fast an all-zero-delay GIF should run.
    // AE stretches it to roughly two seconds, giving every frame the same
    // floor(200 / frames) hundredths - measured at 3, 5, 7, 9 and 14
    // frames. (ffmpeg instead substitutes a flat 10 hundredths.)
    delay = frames * Math.max(1, floordiv(200, frames));
  }
  const duration = delay / 100.0;
  return new MediaInfo({
    width,
    height,
    duration,
    frameRate: round(frames / duration, 3),
    hasAlpha: true,
    depth,
  });
}

// ---------------------------------------------------------------------------
// PSD / PSB - file header (still image)
// ---------------------------------------------------------------------------

/**
 * Additional-layer-info keys whose length field is 8 bytes (not 4) in PSB.
 * `luni`/`lyid`/`lsct` and the adjustment keys are not among them.
 */
export const PSB_8BYTE_KEYS: ReadonlySet<string> = new Set(
  [
    b("LMsk"),
    b("Lr16"),
    b("Lr32"),
    b("Layr"),
    b("Mt16"),
    b("Mt32"),
    b("Mtrn"),
    b("Alph"),
    b("FMsk"),
    b("lnk2"),
    b("FEid"),
    b("FXid"),
    b("PxSD"),
    b("cinf"),
  ].map((k) => bytes_.hex(k)),
);

/**
 * Global additional-info blocks that hold the layer records when the classic
 * Layer Info block is empty: 16/32-bit documents use Lr16/Lr32, and some
 * writers use Layr.
 */
export const _LAYER_RECORD_KEYS: readonly Uint8Array[] = [b("Lr16"), b("Lr32"), b("Layr")];

/**
 * Walk a PSD/PSB stream to its layer records.
 *
 * `fp` must be positioned right after the 26-byte header. Skips the Color
 * Mode Data and Image Resources sections and steps into the Layer and Mask
 * Information section's nested Layer Info block. 16/32-bit documents keep
 * that block empty and store the records inside a global `Lr16`/`Lr32`
 * additional-info block instead; the walk continues there.
 *
 *
 * Shared by `_probe_psd` and `resolvers.psd_layers.read_psd_layers` so the
 * two agree on which files count as flattened.
 *
 * @returns `(record_count, remaining)` - the layer record count (`0` for a flattened document: an
 *   empty or truncated Layer-and-Mask or Layer Info section, and no `Lr16`/`Lr32`/`Layr` block) and
 *   the record bytes left after the count. On a non-zero count, `fp` is positioned at the first
 *   layer record.
 */
export function psdLayerRecordCount(fp: ProbeStream, isPsb: boolean): [number, number] {
  // Color Mode Data and Image Resources sections (4-byte lengths in both).
  fp.seek(struct.unpack(">I", fp.read(4))[0], SEEK_CUR);
  fp.seek(struct.unpack(">I", fp.read(4))[0], SEEK_CUR);
  // The section length and the nested layer-info length are 8 bytes in PSB,
  // 4 in PSD. The signed record count follows; a negative value flags
  // merged-transparency in the first alpha channel.
  const lenFmt = isPsb ? ">Q" : ">I";
  const lenSize = isPsb ? 8 : 4;
  const raw = fp.read(lenSize);
  if (raw.length < lenSize || Number(struct.unpack(lenFmt, raw)[0]) === 0) return [0, 0];
  const sectionEnd = fp.tell() + Number(struct.unpack(lenFmt, raw)[0]);
  const layerInfoLen = Number(struct.unpack(lenFmt, fp.read(lenSize))[0]);
  if (layerInfoLen) return [Math.abs(struct.unpack(">h", fp.read(2))[0]), layerInfoLen - 2];
  // Empty Layer Info: walk the global additional-info blocks that follow
  // the Global Layer Mask Info for the record container block.
  const glmRaw = fp.read(4);
  if (glmRaw.length < 4) return [0, 0];
  fp.seek(struct.unpack(">I", glmRaw)[0], SEEK_CUR);
  while (fp.tell() + 12 <= sectionEnd) {
    const sig = fp.read(4);
    if (!(bytesEq(sig, b("8BIM")) || bytesEq(sig, b("8B64")))) break;
    const key = fp.read(4);
    let blockLen: number;
    if (isPsb && PSB_8BYTE_KEYS.has(bytes_.hex(key))) blockLen = Number(struct.unpack(">Q", fp.read(8))[0]);
    else blockLen = struct.unpack(">I", fp.read(4))[0];
    if (_LAYER_RECORD_KEYS.some((k) => bytesEq(key, k))) {
      const countRaw = fp.read(2);
      if (countRaw.length < 2) return [0, 0];
      return [Math.abs(struct.unpack(">h", countRaw)[0]), blockLen - 2];
    }
    // Global blocks are padded to a multiple of 4.
    fp.seek(blockLen + ((4 - (blockLen % 4)) % 4), SEEK_CUR);
  }
  return [0, 0];
}

/**
 * Color-channel count per PSD color mode. A channel beyond the mode's
 * color-channel count is alpha: 4 channels mean alpha for RGB but are all
 * color for CMYK.
 * Modes: 0 Bitmap, 1 Grayscale, 2 Indexed, 3 RGB, 4 CMYK, 8 Duotone, 9 Lab.
 */
export const _PSD_BASE_CHANNELS: Map<number, number> = new Map([
  [0, 1],
  [1, 1],
  [2, 1],
  [3, 3],
  [4, 4],
  [8, 1],
  [9, 3],
]);

/**
 * Yield `(resource_id, body)` for each PSD image resource, in file order.
 *
 * `fp` must be positioned right after the 26-byte header (the walker skips
 * the color-mode-data section itself); the position is NOT restored. A
 * truncated or malformed section ends the iteration silently - callers keep
 * their defaults for resources that never arrive.
 */
export function* iterImageResources(fp: ProbeStream): Generator<[number, Uint8Array]> {
  let section: Uint8Array;
  try {
    fp.seek(struct.unpack(">I", fp.read(4))[0], SEEK_CUR); // color mode data
    section = readBounded(fp, struct.unpack(">I", fp.read(4))[0]);
  } catch (e) {
    if (e instanceof StructError) return;
    throw e;
  }
  let pos = 0;
  while (pos + 10 <= section.length) {
    if (!bytesEq(section.slice(pos, pos + 4), b("8BIM"))) break;
    const resourceId = struct.unpack(">H", section.slice(pos + 4, pos + 6))[0];
    const nameLen = section[pos + 6];
    pos += 6 + ((nameLen + 2) & ~1);
    if (pos + 4 > section.length) break;
    const size = struct.unpack(">I", section.slice(pos, pos + 4))[0];
    yield [resourceId, section.slice(pos + 4, pos + 4 + size)];
    pos += 4 + size + (size & 1);
  }
}

/**
 * The document pixel aspect (resource 1064, 1.0 when absent) and the
 * embedded ICC profile (resource 1039, `null` when absent).
 *
 * `fp` must be positioned right after the 26-byte header; the position is
 * restored before returning. Photoshop stores the ratio as a truncated
 * decimal (a user-typed 4/3 becomes 1.333); AE snaps it to the simple
 * fraction when it imports (sspc 4/3, psd_layer_styles_single fixture),
 * so the ratio is re-rationalized the same way here.
 */
export function _psdImageResources(fp: ProbeStream): [number, Uint8Array | null] {
  const start = fp.tell();
  let ratio = 1.0;
  let iccProfile: Uint8Array | null = null;
  for (const [resourceId, body] of iterImageResources(fp)) {
    if (resourceId === 1064 && body.length >= 12) {
      // u4 version + f8 ratio (x/y of a pixel).
      ratio = struct.unpack(">d", body.slice(4, 12))[0];
    } else if (resourceId === 1039) {
      iccProfile = body;
    }
  }
  fp.seek(start);
  // A corrupt resource can decode to NaN/inf, which Fraction() rejects.
  if (ratio <= 0 || !Number.isFinite(ratio)) return [1.0, iccProfile];
  return [new Fraction(ratio).limitDenominator(100).valueOf(), iccProfile];
}

export function _probePsd(fp: ProbeStream): MediaInfo {
  if (!bytesEq(fp.read(4), b("8BPS"))) throw new ValueError("Not a valid PSD/PSB file (bad signature)");
  const version = struct.unpack(">H", fp.read(2))[0]; // 1=PSD, 2=PSB
  fp.read(6); // reserved
  const channels = struct.unpack(">H", fp.read(2))[0];
  const [height, width] = struct.unpack(">II", fp.read(8));
  const bitDepth = struct.unpack(">H", fp.read(2))[0];
  const colorMode = struct.unpack(">H", fp.read(2))[0];
  // The PSD/PSB specification bounds these header fields; anything else is
  // a corrupt file (and would not fit the `opti` bytes recording them).
  if (
    ![1, 2].includes(version) ||
    !(1 <= channels && channels <= 56) ||
    ![1, 8, 16, 32].includes(bitDepth) ||
    ![0, 1, 2, 3, 4, 7, 8, 9].includes(colorMode)
  ) {
    throw new ValueError(
      `Not a valid PSD/PSB file (version ${version}, ${channels} channels, ` +
        `${bitDepth} bits, colour mode ${colorMode})`,
    );
  }
  const [pixelAspect, iccProfile] = _psdImageResources(fp);
  const [layerCount] = psdLayerRecordCount(fp, version === 2);
  // AE composites a layered PSD to RGBA (alpha from layer transparency)
  // unless its bottom layer is Photoshop's Background, which has no
  // transparency channel; a flattened document is opaque unless it carries
  // an alpha channel (AE 2026: psd_rgb8_bg_layer.psd imports opaque,
  // flattened_rgb_comp.aep writes alpha_mode 3 = no alpha).
  const bottomTransparent = layerCount > 0 && _psdRecordHasTransparency(fp, version === 2);
  const baseChannels = _PSD_BASE_CHANNELS.get(colorMode) ?? 3;
  const hasAlpha = bottomTransparent || channels > baseChannels;
  // Without alpha a bitmap document has depth 0 and an indexed one stays
  // indexed, as for TIFF (AE 2026, photoshop_modes.aep).
  const depth = _imageDepth(hasAlpha, bitDepth, { gray: colorMode === 0 || colorMode === 1, indexed: colorMode === 2 });
  return new MediaInfo({
    width,
    height,
    hasAlpha: hasAlpha,
    bitDepth: bitDepth,
    layerCount: layerCount,
    colorMode: colorMode,
    // The alpha channel of a flattened document is not counted (AE 2026,
    // photoshop_modes.aep: psd_rgb8_flat_alpha.psd caches 3 channels).
    pixelChannels: bottomTransparent ? baseChannels + 1 : baseChannels,
    pixelAspect: pixelAspect,
    iccProfile: iccProfile,
    depth,
  });
}

/** Whether the layer record at `fp` has a transparency channel (id -1). */
export function _psdRecordHasTransparency(fp: ProbeStream, isPsb: boolean): boolean {
  fp.seek(16, SEEK_CUR); // the record's bounds
  const count = struct.unpack(">H", fp.read(2))[0];
  const entry = 2 + (isPsb ? 8 : 4); // channel id + data length
  const ids = fp.read(count * entry);
  for (let i = 0; i < count; i++) {
    if (struct.unpackFrom(">h", ids, i * entry)[0] === -1) return true;
  }
  return false;
}

/**
 * After Effects' depth for one layer of a layered PSD/PSB.
 *
 * A layer with transparency imports as RGBA at the document's bit depth;
 * Photoshop's Background layer (no transparency) as the opaque document
 * does (AE 2026: `psd_rgb8_bg_layer.psd` / `psd_rgb16_bg_layer.psd`).
 */
export function psdLayerDepth(info: MediaInfo, hasTransparency: boolean): number {
  if (hasTransparency) return _colorDepth(true, info.bitDepth);
  if (info.hasAlpha) return _colorDepth(false, info.bitDepth);
  return info.depth;
}

/**
 * The channels After Effects counts for one raster layer of a layered
 * PSD/PSB: the document's colour channels, plus one when the layer has
 * transparency (AE 2026: a Background layer counts 3 channels, a gray
 * layer 2).
 */
export function psdLayerChannels(info: MediaInfo, hasTransparency: boolean): number {
  const colour = _PSD_BASE_CHANNELS.get(info.colorMode) ?? 3;
  return colour + (hasTransparency ? 1 : 0);
}

/**
 * The decoded pixel buffer After Effects caches as the data size of a
 * merged PSD/PSB, a TIFF still or one Photoshop layer:
 * `width * height * channels * bytes per channel`.
 */
export function pixelBufferSize(width: number, height: number, channels: number, bitDepth: number): number {
  return width * height * channels * floordiv(bitDepth, 8);
}

// ---------------------------------------------------------------------------
// MOV / QuickTime - atom tree (video and/or audio)
// ---------------------------------------------------------------------------

/** Yield (type, body_start, atom_end) for each atom in [start, end). */
export function* _atoms(data: Uint8Array, start: number, end: number): Generator<[Uint8Array, number, number]> {
  let pos = start;
  while (pos + 8 <= end) {
    let size = bytes_.intFromBytes(bytes_.slice(data, pos, pos + 4), "big");
    const atype = bytes_.slice(data, pos + 4, pos + 8);
    let body = pos + 8;
    if (size === 1) {
      // 64-bit extended size
      size = bytes_.intFromBytes(bytes_.slice(data, pos + 8, pos + 16), "big");
      body = pos + 16;
    } else if (size === 0) {
      // extends to end
      size = end - pos;
    }
    if (size < 8 || pos + size > end) return;
    yield [atype, body, pos + size];
    pos += size;
  }
}

// TODO(port): an n == 8 field above 2^53 rounds to a double where Python's int is exact. Atom
// sizes are unaffected (any size >= 2^53 exceeds the file either way); the v1 mvhd/mdhd
// durations and elst segment duration are not: `dur / ts` can differ in the last bit, and an
// elst value within 1024 of the 2^64-1 empty-edit sentinel reads as the sentinel. Only
// durations >= 2^53 ticks (285 years at a 1 MHz timescale) reach this.
export function _u(data: Uint8Array, off: number, n: number): number {
  return bytes_.intFromBytes(bytes_.slice(data, off, off + n), "big");
}

export function _s(data: Uint8Array, off: number, n: number): number {
  return bytes_.intFromBytes(bytes_.slice(data, off, off + n), "big", true);
}

/**
 * Yield the body of each top-level atom of type `wanted`.
 *
 * Other bodies are seeked over, so the bulk of the file (`mdat`, often
 * gigabytes) is never read into memory.
 */
export function* _topLevelAtoms(fp: ProbeStream, wanted: Uint8Array): Generator<Uint8Array> {
  fp.seek(0, SEEK_END);
  const fileEnd = fp.tell();
  fp.seek(0);
  let pos = 0;
  while (pos + 8 <= fileEnd) {
    const header = fp.read(8);
    if (header.length < 8) return;
    let size = bytes_.intFromBytes(bytes_.slice(header, 0, 4), "big");
    const atype = bytes_.slice(header, 4, 8);
    let body = pos + 8;
    if (size === 1) {
      // 64-bit extended size
      size = bytes_.intFromBytes(fp.read(8), "big");
      body = pos + 16;
    } else if (size === 0) {
      // extends to end
      size = fileEnd - pos;
    }
    if (size < 8 || pos + size > fileEnd) return;
    if (bytesEq(atype, wanted)) yield fp.read(pos + size - body);
    pos += size;
    fp.seek(pos);
  }
}

/** Return the body of the top-level `moov` atom, or `b""` if absent. */
export function _readMoov(fp: ProbeStream): Uint8Array {
  const r = _topLevelAtoms(fp, b("moov")).next();
  return r.done ? new Uint8Array(0) : r.value;
}

/**
 * Whether the `tkhd` display matrix turns the track a quarter turn.
 *
 * AE honours the matrix: a 640x360 track carrying a 90-degree rotation
 * imports as 360x640. The 3x3 matrix sits immediately before the 16.16
 * width/height pair, so it ends 8 bytes before the atom does (which holds
 * for both `tkhd` versions). Only the a/b/c/d terms decide whether x maps
 * onto y; a half turn leaves them on the diagonal and needs no swap.
 */
export function _tkhdAxesSwapped(data: Uint8Array, end: number): boolean {
  const matrix = end - 44;
  if (matrix < 0) return false;
  const a = _s(data, matrix, 4);
  const b_ = _s(data, matrix + 4, 4);
  const c = _s(data, matrix + 12, 4);
  const d = _s(data, matrix + 16, 4);
  return Math.abs(b_) > Math.abs(a) && Math.abs(c) > Math.abs(d);
}

/**
 * Return `(sample_count, total_ticks)` summed over every `stts` run.
 *
 * AE follows these sums rather than the `mdhd` duration - a rotated fixture
 * whose `mdhd` claimed one frame too many imported at the `stts` length.
 * Reading only the first run also reports the wrong rate for variable frame
 * rate media, where the runs alternate.
 */
export function _sttsTotals(data: Uint8Array, body: number, end: number): [number, number] {
  let samples = 0;
  let ticks = 0;
  for (let i = 0, n = _u(data, body + 4, 4); i < n; i++) {
    const off = body + 8 + 8 * i;
    if (off + 8 > end) break;
    const count = _u(data, off, 4);
    samples += count;
    ticks += count * _u(data, off + 4, 4);
  }
  return [samples, ticks];
}

/** `tfhd` / `trun` flag bits naming the fields that are actually present. */
export const _TFHD_BASE_OFFSET = 0x000001;
export const _TFHD_SAMPLE_DESC = 0x000002;
export const _TFHD_DEFAULT_DURATION = 0x000008;
export const _TRUN_DATA_OFFSET = 0x000001;
export const _TRUN_FIRST_SAMPLE_FLAGS = 0x000004;
/** Per-sample `trun` fields, in the order they are stored. */
export const _TRUN_SAMPLE_FIELDS: readonly number[] = [0x000100, 0x000200, 0x000400, 0x000800];

/**
 * Return `(sample_count, total_ticks)` from one track's movie fragments.
 *
 * A fragmented file (an `empty_moov` stream) carries no `stts`; each sample's
 * duration lives in its `traf`, either as the `tfhd` default or per sample in
 * the `trun`. AE reads these, so a fragmented `.mp4` that py_aep reported as
 * 0 s / 0 fps imports in AE with its real duration and rate.
 */
export function _fragmentTotals(fp: ProbeStream, trackId: number): [number, number] {
  let samples = 0;
  let ticks = 0;
  for (const moof of _topLevelAtoms(fp, b("moof"))) {
    for (const [a1, b1, e1] of _atoms(moof, 0, moof.length)) {
      if (!bytesEq(a1, b("traf"))) continue;
      let defaultDuration = 0;
      let trafTrack = -1;
      for (const [a2, b2, e2] of _atoms(moof, b1, e1)) {
        if (bytesEq(a2, b("tfhd"))) {
          const flags = _u(moof, b2 + 1, 3);
          trafTrack = _u(moof, b2 + 4, 4);
          let off = b2 + 8;
          if (flags & _TFHD_BASE_OFFSET) off += 8;
          if (flags & _TFHD_SAMPLE_DESC) off += 4;
          if (flags & _TFHD_DEFAULT_DURATION && off + 4 <= e2) defaultDuration = _u(moof, off, 4);
        } else if (bytesEq(a2, b("trun")) && trafTrack === trackId) {
          const flags = _u(moof, b2 + 1, 3);
          const count = _u(moof, b2 + 4, 4);
          samples += count;
          let off = b2 + 8;
          if (flags & _TRUN_DATA_OFFSET) off += 4;
          if (flags & _TRUN_FIRST_SAMPLE_FLAGS) off += 4;
          const row = 4 * _TRUN_SAMPLE_FIELDS.filter((f) => flags & f).length;
          if (flags & _TRUN_SAMPLE_FIELDS[0]) {
            for (let i = 0; i < count; i++) {
              if (off + row * i + 4 > e2) break;
              ticks += _u(moof, off + row * i, 4);
            }
          } else {
            ticks += count * defaultDuration;
          }
        }
      }
    }
  }
  return [samples, ticks];
}

/**
 * Probe a QuickTime-family container (`.mov`, `.m4v`, `.m4a`, `.mp4`).
 *
 * @param fp - The open media file.
 * @param undecodable - Video sample-entry codes whose track AE's importer
 *   cannot decode, so it must be reported as absent (see
 *   `_MP4_UNDECODABLE_CODECS`). Keys are `bytes_.hex` of the code.
 */
export function _probeMov(fp: ProbeStream, undecodable: ReadonlySet<string> = new Set()): MediaInfo {
  const data = _readMoov(fp);
  let width = 0;
  let height = 0;
  let duration = 0.0;
  let frameRate = 0.0;
  let pixelAspect = 1.0;
  let audioSampleRate = 0.0;
  let hasAudio = false;
  let hasAlpha = false;
  let videoBits = 8;
  let movieTs = 0;
  let audioElstDur = 0.0;

  for (const [a2, b2, e2] of _atoms(data, 0, data.length)) {
    if (bytesEq(a2, b("mvhd"))) {
      const v = _byteAt(data, b2);
      const ts = _u(data, b2 + (v === 1 ? 20 : 12), 4);
      movieTs = ts;
      const dur = v === 1 ? _u(data, b2 + 24, 8) : _u(data, b2 + 16, 4);
      duration = ts ? dur / ts : 0.0;
    } else if (bytesEq(a2, b("trak"))) {
      let handler: Uint8Array = new Uint8Array(0);
      let tw = 0;
      let th = 0;
      let trackId = 0;
      let swapAxes = false;
      let mts = 0;
      let mdur = 0;
      let samples = 0;
      let ticks = 0;
      let elstSegDur = 0;
      let elstSentinel = 0xffffffff;
      let entry = new _VideoSampleEntry();
      for (const [a3, b3, e3] of _atoms(data, b2, e2)) {
        if (bytesEq(a3, b("tkhd"))) {
          const v = _byteAt(data, b3);
          trackId = _u(data, b3 + (v === 1 ? 20 : 12), 4);
          tw = rshift(_u(data, e3 - 8, 4), 16);
          th = rshift(_u(data, e3 - 4, 4), 16);
          swapAxes = _tkhdAxesSwapped(data, e3);
        } else if (bytesEq(a3, b("edts"))) {
          for (const [ae, be, ee] of _atoms(data, b3, e3)) {
            if (bytesEq(ae, b("elst")) && ee - be >= 16) {
              // Entries follow version/flags(4) + entry_count(4);
              // segment_duration is u32 (v0) or u64 (v1) in the
              // movie timescale; the all-ones value is an empty edit.
              const ev = _byteAt(data, be);
              elstSegDur = _u(data, be + 8, ev === 1 ? 8 : 4);
              elstSentinel = 2 ** (ev === 1 ? 64 : 32) - 1;
            }
          }
        } else if (bytesEq(a3, b("mdia"))) {
          for (const [a4, b4, e4] of _atoms(data, b3, e3)) {
            if (bytesEq(a4, b("mdhd"))) {
              const v = _byteAt(data, b4);
              mts = _u(data, b4 + (v === 1 ? 20 : 12), 4);
              mdur = v === 1 ? _u(data, b4 + 24, 8) : _u(data, b4 + 16, 4);
            } else if (bytesEq(a4, b("hdlr"))) {
              handler = bytes_.slice(data, b4 + 8, b4 + 12);
            } else if (bytesEq(a4, b("minf"))) {
              for (const [a5, b5, e5] of _atoms(data, b4, e4)) {
                if (!bytesEq(a5, b("stbl"))) continue;
                for (const [a6, b6, e6] of _atoms(data, b5, e5)) {
                  if (bytesEq(a6, b("stsd"))) {
                    entry = _parseStsd(data, b6, e6);
                  } else if (bytesEq(a6, b("stts")) && e6 - b6 >= 16) {
                    [samples, ticks] = _sttsTotals(data, b6, e6);
                  }
                }
              }
            }
          }
        }
      }
      if (bytesEq(handler, b("vide")) && !undecodable.has(bytes_.hex(entry.codec))) {
        // AE sizes footage by the stsd coded dimensions, not tkhd:
        // tkhd holds the *display* size (coded width x pixel aspect),
        // so trusting it counts an anamorphic file's aspect twice.
        width = entry.width || tw;
        height = entry.height || th;
        if (swapAxes) [width, height] = [height, width];
        // depth and pixel aspect are only meaningful for a visual
        // sample entry (reading them from an audio stsd gives garbage).
        if (entry.depth === 32) hasAlpha = true;
        videoBits = entry.bitsPerChannel;
        if (entry.pixelAspect) {
          // A quarter turn maps x onto y, so the sample aspect
          // turns with the axes.
          pixelAspect = swapAxes ? 1 / entry.pixelAspect : entry.pixelAspect;
        }
        if (!samples) {
          // fragmented: the durations live in the moofs
          [samples, ticks] = _fragmentTotals(fp, trackId);
        }
        if (mts && ticks) {
          frameRate = round((mts * samples) / ticks, 3);
          duration = ticks / mts; // AE uses the video track's duration
        } else if (mts && mdur) {
          duration = mdur / mts;
        }
      } else if (bytesEq(handler, b("soun"))) {
        hasAudio = true;
        // An audio track's media timescale is its sample rate.
        audioSampleRate = mts;
        // AAC encoder pre-roll makes the mdhd/mvhd duration about one
        // edit-list media_time too long; the elst segment_duration (in
        // the movie timescale) is the playable length AE reports.
        if (elstSegDur !== 0 && elstSegDur !== elstSentinel && movieTs) {
          audioElstDur = elstSegDur / movieTs;
        }
      }
    }
  }
  // For audio-only media (no video track sets width), prefer the edit-list
  // duration over the raw mdhd/mvhd duration.
  if (width === 0 && audioElstDur) duration = audioElstDur;
  return new MediaInfo({
    width,
    height,
    duration,
    frameRate: frameRate,
    hasAlpha: hasAlpha,
    hasAudio: hasAudio,
    audioSampleRate: audioSampleRate,
    pixelAspect: pixelAspect,
    depth: width ? _colorDepth(hasAlpha, videoBits) : 0,
  });
}

/** The fields a video `stsd` sample entry contributes to `MediaInfo`. */
export class _VideoSampleEntry {
  declare readonly codec: Uint8Array;
  declare readonly width: number;
  declare readonly height: number;
  declare readonly depth: number;
  declare readonly pixelAspect: number;
  /** The bits per channel AE decodes the codec at. */
  declare readonly bitsPerChannel: number;

  constructor(kw: Partial<{ codec: Uint8Array; width: number; height: number; depth: number; pixelAspect: number; bitsPerChannel: number }> = {}) {
    Object.assign(
      this,
      { codec: new Uint8Array(0), width: 0, height: 0, depth: 0, pixel_aspect: 0.0, bits_per_channel: 8 },
      kw,
    );
  }
}

/** Apple ProRes sample-entry codes. AE decodes ProRes at 16 bits per channel (AE 2026 imports of its own ProRes 422 and 4444 renders). */
export const _PRORES_CODECS: ReadonlySet<string> = new Set(
  [b("apco"), b("apcs"), b("apcn"), b("apch"), b("ap4h"), b("ap4x")].map((k) => bytes_.hex(k)),
);

/** H.264 profiles whose sequence parameter set carries the bit depth. */
export const _AVC_HIGH_PROFILES: ReadonlySet<number> = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

/**
 * Luma bit depth of the first sequence parameter set of an `avcC` box.
 *
 * AE decodes H.264 above 8 bits at 16 bits per channel (a High 10
 * `mov_23_976.mov` caches depth 48, 8-bit High profile files 24).
 */
export function _avcBitDepth(data: Uint8Array, body: number, end: number): number {
  if (body + 8 > end || !(_byteAt(data, body + 5) & 0x1f)) return 8;
  const spsEnd = Math.min(body + 8 + _u(data, body + 6, 2), end);
  // Drop the NAL header byte and the emulation-prevention bytes.
  const rbsp = bytes_.replace(bytes_.slice(data, body + 9, spsEnd), b("\x00\x00\x03"), b("\x00\x00"));
  if (rbsp.length < 4 || !_AVC_HIGH_PROFILES.has(rbsp[0])) return 8;
  const bits = Array.from(bytes_.slice(rbsp, 3, 16), (byte) => byte.toString(2).padStart(8, "0")).join("");
  let [, pos] = _expGolomb(bits, 0); // seq_parameter_set_id
  const [chromaFormat, pos2] = _expGolomb(bits, pos);
  pos = pos2;
  if (chromaFormat === 3) pos += 1; // 4:4:4 adds the separate-colour-plane flag
  const [lumaMinus8] = _expGolomb(bits, pos);
  return 8 + lumaMinus8;
}

/** Read one unsigned Exp-Golomb code from a bit string: `(value, end)`. */
export function _expGolomb(bits: string, pos: number): [number, number] {
  let zeros = 0;
  while (pos + zeros < bits.length && bits[pos + zeros] === "0") zeros += 1;
  const start = pos + zeros;
  return [Number.parseInt(bits.slice(start, start + zeros + 1) || "1", 2) - 1, start + zeros + 1];
}

/** Decode the first sample description as a video sample entry. */
export function _parseStsd(data: Uint8Array, body: number, end: number): _VideoSampleEntry {
  const entry = body + 8; // skip version/flags(4) + entry_count(4)
  if (entry + 16 > end) return new _VideoSampleEntry();
  const entrySize = _u(data, entry, 4);
  const codec = bytes_.slice(data, entry + 4, entry + 8);
  // The visual sample entry is 86 bytes: a 16-byte base, then 16 bytes of
  // version/vendor/quality, then the coded width/height pair at +32.
  const width = entry + 36 <= end ? _u(data, entry + 32, 2) : 0;
  const height = entry + 36 <= end ? _u(data, entry + 34, 2) : 0;
  const depth = entry + 84 <= end ? _u(data, entry + 82, 2) : 0;
  let pixelAspect = 0.0;
  let bitsPerChannel = _PRORES_CODECS.has(bytes_.hex(codec)) ? 16 : 8;
  // Extension atoms (pasp, avcC) live after the 86-byte base video entry.
  for (const [atype, b_, e] of _atoms(data, entry + 86, Math.min(entry + entrySize, end))) {
    if (bytesEq(atype, b("pasp"))) {
      const hSpacing = _u(data, b_, 4);
      const vSpacing = _u(data, b_ + 4, 4);
      if (vSpacing) {
        // Unrounded: AE stores the exact ratio (4:3 -> 4/3).
        pixelAspect = hSpacing / vSpacing;
      }
    } else if (bytesEq(atype, b("avcC")) && _avcBitDepth(data, b_, e) > 8) {
      bitsPerChannel = 16;
    }
  }
  return new _VideoSampleEntry({ codec, width, height, depth, pixelAspect: pixelAspect, bitsPerChannel: bitsPerChannel });
}

/**
 * Video sample-entry codes AE 2026's Media Core `.mp4` importer cannot
 * decode. AE drops such a track and imports whatever is left, so an `.aep`
 * that claims the real video track instead makes AE report the footage
 * MISSING on open - the track must be reported as absent. Codecs are listed
 * only once verified, since under-claiming a codec AE *can* decode breaks
 * the footage too (AE warns and renders nothing).
 */
export const _MP4_UNDECODABLE_CODECS: ReadonlySet<string> = new Set([b("vp09"), b("av01")].map((k) => bytes_.hex(k)));

/**
 * Probe an `.mp4`.
 *
 * MP4 shares the QuickTime atom tree, but AE routes `.mp4` through its
 * Media Core importer, which decodes fewer video codecs than the
 * QuickTime importer used for `.mov`/`.m4v`.
 *
 * @throws ValueError If the file has no track AE can decode. AE refuses such a
 *   file outright ("The source compression type is not supported"),
 *   so there is no import for py-aep to reproduce.
 *
 * Whether AE refuses depends on what survives dropping the undecodable
 * video, not on which codec it was. All four cells were measured in AE
 * 2026; the two kept fixtures cover one codec and one outcome each:
 *
 *   video | audio | AE 2026            | fixture
 *   av01  | AAC   | imports audio only | `mp4_av1_with_audio.mp4`
 *   vp09  | none  | refused            | `mp4_vp9_no_audio.mp4`
 *   vp09  | AAC   | imports audio only | (measured, file not kept)
 *   av01  | none  | refused            | (measured, file not kept)
 */
export function _probeMp4(fp: ProbeStream): MediaInfo {
  const info = _probeMov(fp, _MP4_UNDECODABLE_CODECS);
  if (info.width || info.hasAudio) return info;
  // Nothing survived. Re-probe ungated to tell an undecodable codec (AE
  // refuses the file) from a file whose atom tree we simply could not read,
  // so the error names the right problem.
  if (_probeMov(fp).width === 0) {
    throw new ValueError("Could not read a video or audio track from this .mp4 (no readable moov atom).");
  }
  throw new ValueError(
    "After Effects cannot import this .mp4: it has no video track in " +
      "a codec AE decodes, and no audio track either. AE refuses the " +
      'file with "The source compression type is not supported".',
  );
}

// ---------------------------------------------------------------------------
// FBX - 3D scene (AE renders at fixed defaults; dims are not in the file)
// ---------------------------------------------------------------------------

export const _FBX_MAGIC = b("Kaydara FBX Binary  \x00\x1a\x00");

export function _probeFbx(fp: ProbeStream): MediaInfo {
  if (!bytesEq(fp.read(_FBX_MAGIC.length), _FBX_MAGIC)) throw new ValueError("Not a binary FBX file (bad magic)");
  // AE imports an FBX as a 1920x1080, 30 fps, 30 s 3D scene regardless of the
  // scene's authored render settings, and re-reads the geometry on open.
  return new MediaInfo({
    width: 1920,
    height: 1080,
    duration: 30.0,
    frameRate: 30.0,
    hasAlpha: true,
    depth: _colorDepth(true, 8),
  });
}

// ---------------------------------------------------------------------------
// Data footage (txt/csv/json) - AE imports as a 0x0 data item
// ---------------------------------------------------------------------------

/** Text/CSV/JSON data footage: no dimensions, duration, or audio. */
export function _probeData(fp: ProbeStream): MediaInfo {
  return new MediaInfo();
}

// ---------------------------------------------------------------------------
// mgjson - After Effects motion-graphics data stream (duration from samples)
// ---------------------------------------------------------------------------

/**
 * Naive (zoneless) calendar datetime as microseconds since 1970-01-01, or
 * `null` when the fields are not a valid datetime (`datetime()` raises).
 */
export function _naiveDatetimeUs(y: number, mo: number, d: number, h: number, mi: number, s: number, us: number): number | null {
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!(1 <= y && y <= 9999) || !(1 <= mo && mo <= 12) || !(1 <= d && d <= dim[mo - 1])) return null;
  if (!(0 <= h && h <= 23) || !(0 <= mi && mi <= 59) || !(0 <= s && s <= 59)) return null;
  // Howard Hinnant's days_from_civil: exact proleptic Gregorian day count.
  const yy = mo <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (mo > 2 ? mo - 3 : mo + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  const days = era * 146097 + doe - 719468;
  return (days * 86400 + h * 3600 + mi * 60 + s) * 1e6 + us;
}

/**
 * Parse an mgjson ISO-8601 sample time, tolerating fractional-second
 * precision and timezone offsets that Python 3.7's strict
 * `datetime.fromisoformat` rejects.
 *
 * Returns a naive `datetime` (any timezone offset is dropped - all samples
 * in a stream share one offset, so the inter-sample span is unaffected) or
 * `null` if the value cannot be parsed. Here a datetime is its microseconds
 * since the epoch (UTC for the aware datetimes `fromisoformat` can return),
 * which keeps differences exact.
 */
export function _parseMgjsonTime(t: JsonValue): { us: number; aware: boolean } | null {
  if (typeof t !== "string") throw new AttributeError(`'${typeName(t)}' object has no attribute 'strip'`);
  let s = strip(t);
  // Drop a trailing 'Z' or numeric UTC offset (+HH:MM / +HHMM); the span
  // between samples is offset-independent.
  s = s.replace(/(Z|[+-]\p{Nd}{2}:?\p{Nd}{2})$/u, "");
  // Clamp over-long fractional seconds to 6 digits (strptime %f accepts 1-6).
  s = s.replace(/(\.\p{Nd}{6})\p{Nd}+/gu, "$1");
  // strptime formats "%Y-%m-%dT%H:%M:%S.%f" and "%Y-%m-%dT%H:%M:%S": the
  // whole string must match, fraction right-padded to microseconds.
  const strp =
    /^(\p{Nd}{4})-(1[0-2]|0[1-9]|[1-9])-(3[01]|[12]\p{Nd}|0[1-9]|[1-9]| [1-9])[Tt](2[0-3]|[0-1]\p{Nd}|\p{Nd}):([0-5]\p{Nd}|\p{Nd}):(6[0-1]|[0-5]\p{Nd}|\p{Nd})(?:\.([0-9]{1,6}))?$/u;
  const m = strp.exec(s);
  if (m) {
    const frac = m[7] === undefined ? "" : m[7].padEnd(6, "0");
    const us = _naiveDatetimeUs(int(m[1]), int(m[2]), int(m[3]), int(m[4]), int(m[5]), int(m[6]), int(frac || "0"));
    if (us !== null) return { us, aware: false };
  }
  try {
    const d = datetime.fromisoformat(s);
    const us = _naiveDatetimeUs(d.year, d.month, d.day, d.hour, d.minute, d.second, d.microsecond);
    if (us === null) return null;
    return d.utcoffset === null ? { us, aware: false } : { us: us - d.utcoffset, aware: true };
  } catch (e) {
    if (!(e instanceof ValueError)) throw e;
    return null;
  }
}

/** `iter(x)` on a parsed JSON value: list items, str characters, dict keys. */
export function _jsonIter(x: JsonValue): JsonValue[] {
  if (Array.isArray(x)) return x;
  if (typeof x === "string") return Array.from(x);
  if (x instanceof Map) return [...x.keys()];
  throw new TypeError_(`'${typeName(x)}' object is not iterable`);
}

export function _probeMgjson(fp: ProbeStream): MediaInfo {
  const doc = jsonLoads(fp.read());
  const times: { us: number; aware: boolean }[] = [];
  for (const stream of _jsonIter(jsonGet(doc, "dataDynamicSamples", []))) {
    for (const sample of _jsonIter(jsonGet(stream, "samples", []))) {
      const t = jsonGet(sample, "time", null);
      if (pyBool(t)) {
        const parsed = _parseMgjsonTime(t);
        if (parsed !== null) times.push(parsed);
      }
    }
  }
  if (!times.length) return new MediaInfo({ frameRate: 30.0 });
  // Ordering a naive and an aware datetime raises, as max()/min() do.
  if (times.some((x) => x.aware !== times[0].aware)) {
    throw new TypeError_("can't compare offset-naive and offset-aware datetimes");
  }
  const us = times.map((x) => x.us);
  const span = (max(us) - min(us)) / 1e6;
  // AE imports mgjson at a fixed 30 fps and reports the span plus one frame.
  return new MediaInfo({ duration: span + 1.0 / 30.0, frameRate: 30.0 });
}

// ---------------------------------------------------------------------------
// MP3 - MPEG audio frame header (audio only)
// ---------------------------------------------------------------------------

export const _MP3_SR: Map<number, number[]> = new Map([
  [3, [44100, 48000, 32000]],
  [2, [22050, 24000, 16000]],
  [0, [11025, 12000, 8000]],
]);
export const _MP3_BR_M1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
export const _MP3_BR_M2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];

/**
 * Byte offset of the audio data after a leading ID3v2 tag (0 if absent).
 *
 * The tag length is a 28-bit syncsafe integer in header bytes 6-9, and it
 * covers neither the 10-byte header nor the optional 10-byte ID3v2.4 footer
 * that flag bit 4 announces.
 */
export function _skipId3v2(raw: Uint8Array): number {
  if (bytesEq(bytes_.slice(raw, 0, 3), b("ID3")) && raw.length >= 10) {
    const s = bytes_.slice(raw, 6, 10);
    const size = ((s[0] & 0x7f) << 21) | ((s[1] & 0x7f) << 14) | ((s[2] & 0x7f) << 7) | (s[3] & 0x7f);
    return 10 + size + (raw[5] & 0x10 ? 10 : 0);
  }
  return 0;
}

/**
 * Length in bytes of the Layer III frame `header` describes (0 if bogus).
 *
 * The frame-size coefficient is samples-per-frame/8 (1152/8=144 for MPEG-1,
 * 576/8=72 for MPEG-2/2.5).
 */
export function _mp3FrameSize(header: number): number {
  const version = (header >>> 19) & 0x3; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
  const layer = (header >>> 17) & 0x3; // 1 = Layer III
  const bitrateI = (header >>> 12) & 0xf;
  const srI = (header >>> 10) & 0x3;
  if (version === 1 || layer !== 1 || bitrateI === 0 || bitrateI === 0xf || srI === 3) return 0;
  const bitrate = (version === 3 ? _MP3_BR_M1_L3 : _MP3_BR_M2_L3)[bitrateI] * 1000;
  const spf = version === 3 ? 1152 : 576;
  return floordiv((spf / 8) * bitrate, getitem(_MP3_SR, version)[srI]) + ((header >>> 9) & 0x1);
}

/**
 * Offset of the first MPEG audio frame in `window`, or -1 if none syncs.
 *
 * A well-formed file starts its audio exactly where the tag ended, so offset
 * 0 is taken on its own. Past that the search needs corroboration: a
 * candidate counts only when the frame its own length points at also syncs,
 * which rejects a stray 0xFF pair inside tag or junk bytes. Scanning at all
 * is what keeps a footer-bearing or sloppily tagged file - where the audio
 * does not begin at the tag boundary - from reporting a zero duration.
 */
export function _findMp3Frame(window: Uint8Array): number {
  const n = window.length;
  if (n >= 4 && window[0] === 0xff && (window[1] & 0xe0) === 0xe0 && _mp3FrameSize(Number(struct.unpackFrom(">I", window, 0)[0]))) {
    return 0;
  }
  let pos = 1;
  while (pos + 4 <= n) {
    if (window[pos] === 0xff && (window[pos + 1] & 0xe0) === 0xe0) {
      const size = _mp3FrameSize(Number(struct.unpackFrom(">I", window, pos)[0]));
      const nxt = pos + size;
      if (
        size &&
        (nxt + 2 > n || // this frame runs to the end of the window
          (window[nxt] === 0xff && (window[nxt + 1] & 0xe0) === 0xe0))
      ) {
        return pos;
      }
    }
    pos += 1;
  }
  return -1;
}

export function _probeMp3(fp: ProbeStream): MediaInfo {
  // The duration math needs only the file size, the first frame header and
  // the fixed-offset Xing/Info tag - never the audio payload, so read a
  // bounded window instead of the whole file.
  let audioStart = _skipId3v2(fp.read(10));
  fp.seek(0, SEEK_END);
  const fileSize = fp.tell();
  fp.seek(audioStart);
  // A 64 KiB window holds several max-size frames, so only a pathological
  // amount of leading garbage escapes the search.
  const window = fp.read(65536);
  const offset = _findMp3Frame(window);
  if (offset < 0) return new MediaInfo({ hasAudio: true });
  audioStart += offset;
  // Frame header (4) + max side info (32) + a Xing or VBRI tag; VBRI's frame
  // count is the furthest field, ending 54 bytes into the frame.
  const raw = bytes_.slice(window, offset, offset + 64);
  const h = Number(struct.unpackFrom(">I", raw, 0)[0]);
  const mpegVer = (h >>> 19) & 0x3; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
  const srI = (h >>> 10) & 0x3;
  const mono = ((h >>> 6) & 0x3) === 3;
  const sr = srI < 3 ? (_MP3_SR.get(mpegVer) ?? [0, 0, 0])[srI] : 0;
  const spf = mpegVer === 3 ? 1152 : 576;
  // A Xing/Info header (VBR) carries the exact frame count; else assume CBR.
  const side = mpegVer === 3 ? (mono ? 17 : 32) : mono ? 9 : 17;
  let duration = 0.0;
  const tagAt = 4 + side;
  const tag = bytes_.slice(raw, tagAt, tagAt + 4);
  if (bytesEq(tag, b("Xing")) || bytesEq(tag, b("Info"))) {
    const flags = struct.unpackFrom(">I", raw, tagAt + 4)[0];
    if (flags & 0x1 && sr) {
      const frames = struct.unpackFrom(">I", raw, tagAt + 8)[0];
      duration = (frames * spf) / sr;
    }
  } else if (bytesEq(bytes_.slice(raw, 36, 40), b("VBRI")) && sr && raw.length >= 54) {
    // Fraunhofer's VBR tag sits at a fixed offset (frame start + 4 + 32)
    // rather than after the side info: tag(4) version(2) delay(2)
    // quality(2) bytes(4) frames(4). AE ignores it and falls back to a
    // bitrate estimate that is wrong for a variable-rate file (4.91 s for
    // an 8.05 s fixture), so this reports the true length instead.
    if (struct.unpackFrom(">H", raw, 40)[0] === 1) {
      // tag version
      const frames = struct.unpackFrom(">I", raw, 50)[0];
      duration = (frames * spf) / sr;
    }
  } else if (sr) {
    // _find_mp3_frame already rejected the reserved bitrate/rate codes, so
    // the frame size here is always > 0.
    const frameSize = _mp3FrameSize(h);
    duration = (floordiv(fileSize - audioStart, frameSize) * spf) / sr;
  }
  return new MediaInfo({ duration, hasAudio: true, audioSampleRate: sr });
}

// ---------------------------------------------------------------------------
// AAC - ADTS frame stream (audio only)
// ---------------------------------------------------------------------------

/** ADTS sampling-frequency index -\> Hz (indices 13-15 are reserved/explicit). */
export const _AAC_SR: readonly number[] = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/**
 * 13-bit ADTS frame length: low 2 bits of byte 3, all of byte 4, high 3
 * bits of byte 5.
 */
export function _adtsFrameLen(raw: Uint8Array, pos: number): number {
  return ((raw[pos + 3] & 0x03) << 11) | (raw[pos + 4] << 3) | (raw[pos + 5] >> 5);
}

/**
 * Whether `pos` begins a plausible ADTS frame header.
 *
 * Beyond the 12-bit sync word this checks the layer bits (always 0 for ADTS)
 * and the sampling-frequency index (\< 13), and that the frame length is at
 * least a full header - enough to reject a coincidental `0xFF 0xFx` byte pair
 * in non-ADTS data.
 */
export function _isAdtsHeader(raw: Uint8Array, pos: number, n: number): boolean {
  return (
    pos + 7 <= n &&
    raw[pos] === 0xff &&
    (raw[pos + 1] & 0xf0) === 0xf0 &&
    ((raw[pos + 1] >> 1) & 0x3) === 0 &&
    ((raw[pos + 2] >> 2) & 0xf) < 13 &&
    _adtsFrameLen(raw, pos) >= 7
  );
}

/**
 * AAC in a raw ADTS stream (audio only).
 *
 * Each ADTS frame carries 1024 samples per raw-data-block; the duration is
 * the summed sample count divided by the sampling rate. After Effects
 * decodes the file via Windows Media Foundation and may report a slightly
 * different duration (decoder priming), but it re-derives the value from
 * the located file on open, so the header estimate never affects playback.
 */
export function _probeAac(fp: ProbeStream): MediaInfo {
  const audioStart = _skipId3v2(fp.read(10));
  fp.seek(0, SEEK_END);
  const fileSize = fp.tell();
  fp.seek(audioStart);
  // Locate the first real ADTS frame: a valid header whose successor also
  // syncs (or which ends the file). Requiring the next frame guards against
  // locking onto a coincidental sync word in leading non-ADTS bytes. A
  // 64 KiB window holds several max-size (8191-byte) frames, so only a
  // pathological amount of leading garbage escapes it.
  const window = fp.read(65536);
  const n = window.length;
  let pos = 0;
  let found = false;
  while (pos + 7 <= n) {
    if (_isAdtsHeader(window, pos, n)) {
      const nxt = pos + _adtsFrameLen(window, pos);
      if (audioStart + nxt >= fileSize || _isAdtsHeader(window, nxt, n)) {
        found = true;
        break;
      }
    }
    pos += 1;
  }
  if (!found) return new MediaInfo({ hasAudio: true });
  const srI = (window[pos + 2] >> 2) & 0xf;
  const sr = srI < _AAC_SR.length ? _AAC_SR[srI] : 0;
  // Walk the stream header-to-header, seeking over the audio payloads so
  // the file is never loaded whole.
  let totalSamples = 0;
  fp.seek(audioStart + pos);
  for (;;) {
    const hdr = fp.read(7);
    if (hdr.length < 7 || hdr[0] !== 0xff || (hdr[1] & 0xf0) !== 0xf0) break;
    const frameLen = _adtsFrameLen(hdr, 0);
    if (frameLen < 7) break; // shorter than the header: corrupt, stop scanning
    totalSamples += 1024 * ((hdr[6] & 0x03) + 1);
    fp.seek(frameLen - 7, SEEK_CUR);
  }
  const duration = sr ? totalSamples / sr : 0.0;
  return new MediaInfo({ duration, hasAudio: true, audioSampleRate: sr });
}

// ---------------------------------------------------------------------------
// SWF - file header (AE rasterizes the movie to video)
// ---------------------------------------------------------------------------

// TODO(port): no LZMA decoder, so ZWS (LZMA) SWF files raise NotImplementedError where Python's
// lzma.decompress(format=FORMAT_ALONE) returns the header. The pure-JS packages are a global
// script whose decompress returns a string for UTF-8 output (lzma 2.3.2) or ship the encoder
// with the decoder (lzma1);
// a port needs a FORMAT_ALONE decoder with CPython's end-marker, trailing-data and LZMAError behavior.
export function _lzmaAloneDecompress(data: Uint8Array): Uint8Array {
  throw new NotImplementedError(`LZMA (FORMAT_ALONE) decoding is not ported yet (${data.length} bytes)`);
}

export function _probeSwf(fp: ProbeStream): MediaInfo {
  const sig = fp.read(3);
  fp.read(5); // version (1 byte) + file length (LE u32)
  let body: Uint8Array;
  if (bytesEq(sig, b("FWS"))) {
    body = fp.read(21);
  } else if (bytesEq(sig, b("CWS"))) {
    body = zlib.decompress(fp.read()).slice(0, 21);
  } else if (bytesEq(sig, b("ZWS"))) {
    fp.read(4); // uncompressed length precedes the LZMA stream
    const stream = fp.read();
    // A SWF LZMA body is 5 props bytes then the raw stream, with no 8-byte
    // uncompressed-size field; splice one in (unknown = all ones) so the
    // FORMAT_ALONE decoder accepts it.
    body = _lzmaAloneDecompress(concat(bytes_.slice(stream, 0, 5), new Uint8Array(8).fill(0xff), bytes_.slice(stream, 5))).slice(0, 21);
  } else {
    throw new ValueError("Not a valid SWF file (bad signature)");
  }
  // Frame size is a bit-packed RECT (twips): nbits in the top 5 bits, then
  // four nbits-wide fields (xmin, xmax, ymin, ymax). The stage is non-negative.
  const nbits = _byteAt(body, 0) >> 3;
  const rectBytes = floordiv(5 + 4 * nbits + 7, 8);
  const bits = Array.from(bytes_.slice(body, 0, rectBytes), (x) => x.toString(2).padStart(8, "0")).join("");
  const vals: number[] = [];
  let pos = 5;
  for (let i = 0; i < 4; i++) {
    vals.push(int(bits.slice(pos, pos + nbits), 2));
    pos += nbits;
  }
  const width = floordiv(vals[1] - vals[0], 20);
  const height = floordiv(vals[3] - vals[2], 20);
  const frRaw = struct.unpackFrom("<H", body, rectBytes)[0];
  const frameRate = frRaw / 256.0; // 8.8 fixed-point
  const frameCount = struct.unpackFrom("<H", body, rectBytes + 2)[0];
  const duration = frameRate ? frameCount / frameRate : 0.0;
  return new MediaInfo({
    width,
    height,
    duration,
    frameRate: frameRate,
    hasAlpha: true,
    depth: _colorDepth(true, 8),
  });
}

// ---------------------------------------------------------------------------
// MPEG-1/2 program stream - sequence header + picture-start-code count
// ---------------------------------------------------------------------------

export const _MPEG_FR: Map<number, number> = new Map([
  [1, 24000 / 1001],
  [2, 24.0],
  [3, 25.0],
  [4, 30000 / 1001],
  [5, 30.0],
  [6, 50.0],
  [7, 60000 / 1001],
  [8, 60.0],
]);

/**
 * AE's pixel aspect for the D1/DV frame sizes, keyed by
 * `(width, height, aspect_ratio_information)` (`tkey`). AE applies its own named
 * presets here instead of the arithmetic the sequence header implies:
 * 720x480 flagged 16:9 imports as D1/DV NTSC Widescreen (40/33 = 1.2121),
 * not the (16/9)/(720/480) = 1.1852 the frame size alone would give. Every
 * other frame size measured square. Values verified against AE 2026.
 */
export const _MPEG_D1_PIXEL_ASPECT: Map<string, number> = new Map([
  [tkey(720, 480, 2), 10 / 11],
  [tkey(720, 480, 3), 40 / 33],
  [tkey(720, 576, 2), 128 / 117],
  [tkey(720, 576, 3), 512 / 351],
]);

/** Offset of a PES packet's payload, skipping its variable-length header. */
export function _pesPayloadStart(data: Uint8Array, pos: number, end: number): number {
  let p = pos + 6;
  if (p < end && (data[p] & 0xc0) === 0x80) {
    // MPEG-2 PES: flags(2) + header len
    return Math.min(p + 3 + (p + 3 <= end ? data[p + 2] : 0), end);
  }
  while (p < end && data[p] === 0xff) p += 1; // MPEG-1 PES: stuffing bytes
  if (p + 1 < end && (data[p] & 0xc0) === 0x40) p += 2; // STD buffer scale/size
  if (p < end) {
    if ((data[p] & 0xf0) === 0x20) {
      // PTS only
      p += 5;
    } else if ((data[p] & 0xf0) === 0x30) {
      // PTS + DTS
      p += 10;
    } else if (data[p] === 0x0f) {
      // neither
      p += 1;
    }
  }
  return Math.min(p, end);
}

/**
 * Return `(video elementary stream, has_audio)` from a program stream.
 *
 * The elementary stream has to be reassembled before its picture start codes
 * can be counted: a start code routinely straddles a PES packet boundary, so
 * scanning the muxed file both misses real pictures and matches the zero
 * padding that precedes a pack or PES header. Counting the raw file was off
 * by one in both directions on the measured fixtures.
 */
export function _mpegVideoEs(data: Uint8Array): [Uint8Array, boolean] {
  const parts: Uint8Array[] = [];
  let hasAudio = false;
  let pos = 0;
  const n = data.length;
  while (pos + 4 <= n) {
    if (!bytesEq(bytes_.slice(data, pos, pos + 3), b("\x00\x00\x01"))) {
      pos += 1;
      continue;
    }
    const streamId = data[pos + 3];
    if (streamId === 0xba) {
      // pack header
      if (pos + 5 > n) break;
      if ((data[pos + 4] & 0xc0) === 0x40) {
        // MPEG-2: 14 bytes + stuffing
        if (pos + 14 > n) break;
        pos += 14 + (data[pos + 13] & 0x07);
      } else {
        // MPEG-1: a flat 12 bytes
        pos += 12;
      }
      continue;
    }
    if (streamId === 0xb9) break; // program end
    if (pos + 6 > n) break;
    const length = bytes_.intFromBytes(bytes_.slice(data, pos + 4, pos + 6), "big");
    const end = length ? Math.min(pos + 6 + length, n) : n;
    if ((0xc0 <= streamId && streamId <= 0xdf) || streamId === 0xbd) {
      hasAudio = true;
    } else if (0xe0 <= streamId && streamId <= 0xef) {
      parts.push(bytes_.slice(data, _pesPayloadStart(data, pos, end), end));
    }
    pos = end;
  }
  // Join the payloads without spreading them into call arguments.
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return [out, hasAudio];
}

export function _probeMpeg(fp: ProbeStream): MediaInfo {
  // Program streams carry no global duration and the SCR timeline stops short
  // of the final frames, so the frames have to be counted. This reads the
  // whole file, which is acceptable for the sizes py_aep handles.
  const [video, hasAudio] = _mpegVideoEs(fp.read());
  const seq = bytes_.find(video, b("\x00\x00\x01\xb3"));
  if (seq < 0) throw new ValueError("Not a valid MPEG file (no sequence header)");
  const val = Number(struct.unpackFrom(">I", video, seq + 4)[0]);
  const width = (val >>> 20) & 0xfff;
  const height = (val >>> 8) & 0xfff;
  const fps = _MPEG_FR.get(val & 0xf) ?? 0.0;
  const frames = bytes_.count(video, b("\x00\x00\x01\x00"));
  const duration = fps ? frames / fps : 0.0;
  const pixelAspect = _MPEG_D1_PIXEL_ASPECT.get(tkey(width, height, (val >>> 4) & 0xf)) ?? 1.0;
  return new MediaInfo({
    width,
    height,
    duration,
    frameRate: fps,
    hasAudio: hasAudio,
    pixelAspect: pixelAspect,
    depth: _colorDepth(false, 8),
  });
}

// ---------------------------------------------------------------------------
// Line and byte-split helpers shared by the text formats
// ---------------------------------------------------------------------------

/** `for raw in fp:` - each line of the stream, newline included. */
export function* _iterLines(fp: ProbeStream): Generator<Uint8Array> {
  for (;;) {
    const line = fp.readline();
    if (line.length === 0) return;
    yield line;
  }
}

/** Latin-1 view of bytes, so a byte regex runs as a string regex. */
export function _latin1(data: Uint8Array): string {
  return bytes_.latin1Str(data);
}

/** Radiance HDR (RGBE) - text header with a resolution line (still image). */
export function _probeHdr(fp: ProbeStream): MediaInfo {
  if (!bytes_.startswith(fp.readline(), b("#?"))) {
    throw new ValueError("Not a Radiance HDR file (missing '#?' identifier)");
  }
  for (;;) {
    const line = fp.readline();
    if (line.length === 0) throw new ValueError("Unexpected EOF in Radiance HDR header");
    if (bytes_.strip(line).length === 0) break; // blank line separates header from resolution
  }
  // Resolution line is two axis specifiers, e.g. "-Y 426 +X 640"; the X
  // specifier gives width and the Y specifier gives height. Radiance allows
  // either order (and either sign), so key off the axis letter, not position.
  const parts = bytes_.split(fp.readline());
  if (parts.length < 4) throw new ValueError("Cannot parse HDR resolution line");
  const dims = new Map<string, number>();
  dims.set(bytes_.hex(parts[0].slice(-1)), int(decode(parts[1], "ascii")));
  dims.set(bytes_.hex(parts[2].slice(-1)), int(decode(parts[3], "ascii")));
  const X = bytes_.hex(b("X"));
  const Y = bytes_.hex(b("Y"));
  if (!dims.has(X) || !dims.has(Y)) {
    throw new ValueError("Cannot parse HDR resolution line (missing X or Y axis)");
  }
  // Radiance RGBE is floating-point RGB.
  return new MediaInfo({ width: dims.get(X), height: dims.get(Y), depth: _colorDepth(false, 32) });
}

// ---------------------------------------------------------------------------
// Canon CRW (CIFF) - Camera Raw still
// ---------------------------------------------------------------------------

export const _CIFF_IMAGE_INFO = 0x1810;

export function _probeCrw(fp: ProbeStream): MediaInfo {
  const data = fp.read();
  const head = bytes_.slice(data, 0, 2);
  const order = bytesEq(head, b("II")) ? "<" : bytesEq(head, b("MM")) ? ">" : null;
  if (order == null || !bytesEq(bytes_.slice(data, 6, 14), b("HEAPCCDR"))) {
    throw new ValueError("Not a Canon CRW file (missing CIFF heap header)");
  }
  const [headerLength] = struct.unpack(`${order}I`, bytes_.slice(data, 2, 6));
  const info = _ciffRecord(data, order, headerLength, data.length, _CIFF_IMAGE_INFO);
  if (info == null) throw new ValueError("CRW file has no ImageInfo record");
  // Camera Raw develops the image at the ImageInfo size, turned by its
  // rotation (AE 2026 reports a CRW marked 90 or 270 degrees upright).
  let [width, height, , rotation] = struct.unpack(`${order}IIfi`, info.slice(0, 16));
  if (mod(rotation, 180) === 90) [width, height] = [height, width];
  // AE 2026 caches a developed raw as 16-bit RGB (crw.crw: depth 48).
  return new MediaInfo({ width, height, depth: _colorDepth(false, 16) });
}

/** The body of the first `wanted` record in the CIFF heap `[start, end)`. */
export function _ciffRecord(data: Uint8Array, order: "<" | ">", start: number, end: number, wanted: number): Uint8Array | null {
  const [tableRel] = struct.unpack(`${order}I`, bytes_.slice(data, end - 4, end));
  const table = tableRel + start;
  const [count] = struct.unpack(`${order}H`, bytes_.slice(data, table, table + 2));
  for (let i = 0, n = count; i < n; i++) {
    const entry = table + 2 + i * 10;
    const [tag, size, offset] = struct.unpack(`${order}HII`, bytes_.slice(data, entry, entry + 10));
    if (tag & 0xc000) continue; // value stored in the entry itself: not a heap
    const body = start + offset;
    if ([0x2800, 0x3000].includes(tag & 0x3800)) {
      // a sub-heap
      if (size >= end - start) {
        // A sub-heap lies inside its parent; one that does not would
        // recurse forever on a malformed file.
        throw new ValueError("CRW file has a malformed CIFF heap");
      }
      const found = _ciffRecord(data, order, body, body + size, wanted);
      if (found != null) return found;
    } else if ((tag & 0x3fff) === wanted) {
      return bytes_.slice(data, body, body + size);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// AI / EPS / PDF - vector page dimensions (still image, TEXT source format)
// ---------------------------------------------------------------------------

export const _MEDIABOX_RE =
  /\/MediaBox[ \t\n\r\f\v]*\[[ \t\n\r\f\v]*([\d.+-]+)[ \t\n\r\f\v]+([\d.+-]+)[ \t\n\r\f\v]+([\d.+-]+)[ \t\n\r\f\v]+([\d.+-]+)[ \t\n\r\f\v]*\]/;

/** AE 2026 caches AI/EPS/PDF footage, and each of its layers, as 8-bit RGBA. */
export const _VECTOR_DEPTH = _colorDepth(true, 8);

export function _probePdf(fp: ProbeStream): MediaInfo {
  const m = _MEDIABOX_RE.exec(_latin1(fp.read()));
  if (m == null) return new MediaInfo({ hasAlpha: true, depth: _VECTOR_DEPTH });
  const x0 = float(m[1]);
  const y0 = float(m[2]);
  const x1 = float(m[3]);
  const y1 = float(m[4]);
  return new MediaInfo({
    width: round(x1 - x0),
    height: round(y1 - y0),
    hasAlpha: true,
    depth: _VECTOR_DEPTH,
  });
}

export function _probeEps(fp: ProbeStream): MediaInfo {
  let width = 0;
  let height = 0;
  let hires = false;
  for (const raw of _iterLines(fp)) {
    const line = bytes_.strip(raw);
    if (bytes_.startswith(line, b("%%HiResBoundingBox:"))) {
      const nums = bytes_.split(bytes_.split(line, b(":"), 1)[1]);
      if (nums.length >= 4) {
        const [llx, lly, urx, ury] = nums.slice(0, 4).map((n) => float(decode(n, "ascii")));
        width = round(urx - llx);
        height = round(ury - lly);
        hires = true;
      }
    } else if (!hires && bytes_.startswith(line, b("%%BoundingBox:"))) {
      const rest = bytes_.strip(bytes_.split(line, b(":"), 1)[1]);
      if (!bytesEq(rest, b("(atend)"))) {
        const nums = bytes_.split(rest);
        if (nums.length >= 4) {
          const [llx, lly, urx, ury] = nums.slice(0, 4).map((n) => float(decode(n, "ascii")));
          width = round(urx - llx);
          height = round(ury - lly);
        }
      }
    } else if (bytes_.startswith(line, b("%%EndComments"))) {
      break;
    }
  }
  return new MediaInfo({ width, height, hasAlpha: true, depth: _VECTOR_DEPTH });
}

/** AI/EPS/PDF dimensions: PDF uses /MediaBox, EPS/PostScript %%BoundingBox. */
export function _probeText(fp: ProbeStream): MediaInfo {
  const sig = fp.read(4);
  fp.seek(0);
  if (bytesEq(sig, b("%PDF"))) return _probePdf(fp);
  return _probeEps(fp);
}

// ---------------------------------------------------------------------------
// WMV / ASF - header objects (dims exact; duration/fps are decoder-derived)
// ---------------------------------------------------------------------------

export const _ASF_HEADER = bytes_.fromhex("3026B2758E66CF11A6D900AA0062CE6C");
export const _ASF_FILE_PROPS = bytes_.fromhex("A1DCAB8C47A9CF118EE400C00C205365");
export const _ASF_STREAM_PROPS = bytes_.fromhex("9107DCB7B7A9CF118EE600C00C205365");
export const _ASF_HEADER_EXTENSION = bytes_.fromhex("B503BF5F2EA9CF118EE300C00C205365");
export const _ASF_EXT_STREAM_PROPS = bytes_.fromhex("CBA5E61472C632438399A96952065B5A");
export const _ASF_METADATA = bytes_.fromhex("EACBF8C5AF5B77488467AA8C44FA4CCA");
export const _ASF_VIDEO_PREFIX = bytes_.fromhex("C0EF19BC"); // first 4 LE bytes of the video GUID
export const _ASF_AUDIO_PREFIX = bytes_.fromhex("409E69F8"); // first 4 LE bytes of the audio GUID

/**
 * Yield `(guid, payload_start, payload_end)` for each ASF header object.
 *
 * Descends into the Header Extension Object, which AE reads: the stream's
 * frame rate and pixel aspect live in objects nested inside it, invisible to
 * a walk that only steps over the top-level objects. Its nested objects begin
 * 46 bytes in - object GUID(16) + size(8) + a reserved GUID(16) + a reserved
 * u2 + the extension data size u4.
 */
export function* _asfObjects(body: Uint8Array, start: number, end: number): Generator<[Uint8Array, number, number]> {
  let pos = start;
  while (pos + 24 <= end) {
    const guid = bytes_.slice(body, pos, pos + 16);
    const size = Number(struct.unpackFrom("<Q", body, pos + 16)[0]);
    if (size < 24 || pos + size > end) return;
    yield [guid, pos + 24, pos + size];
    if (bytesEq(guid, _ASF_HEADER_EXTENSION)) yield* _asfObjects(body, pos + 46, pos + size);
    pos += size;
  }
}

/**
 * Metadata Object value types that carry an integer, and their struct codes.
 * BOOL is 16-bit here (only the Extended Content Description Object widens
 * it to 32), so 2 and 5 share a code.
 */
export const _ASF_INT_TYPES: Map<number, "<H" | "<I" | "<Q"> = new Map([
  [2, "<H"],
  [3, "<I"],
  [4, "<Q"],
  [5, "<H"],
]);

/**
 * Decode the Metadata Object's integer records, keyed by `(stream, name)`
 * (`tkey`).
 *
 * This is where AE finds a WMV's pixel aspect (`AspectRatioX`/`AspectRatioY`)
 * and its frame count (`NumberOfFrames`).
 */
export function _asfMetadata(body: Uint8Array, start: number, end: number): Map<string, number> {
  const out = new Map<string, number>();
  if (start + 2 > end) return out;
  let pos = start + 2;
  for (let i = 0, n = struct.unpackFrom("<H", body, start)[0]; i < n; i++) {
    if (pos + 12 > end) break;
    const [, stream, nameLen, valueType] = struct.unpackFrom("<4H", body, pos);
    const valueLen = struct.unpackFrom("<I", body, pos + 8)[0];
    const nameAt = pos + 12;
    const valueAt = nameAt + nameLen;
    if (valueAt + valueLen > end) break;
    const fmt = _ASF_INT_TYPES.get(valueType) ?? null;
    if (fmt != null && valueLen >= struct.calcsize(fmt)) {
      const name = rstrip(decode(bytes_.slice(body, nameAt, valueAt), "utf-16-le", "replace"), "\x00");
      out.set(tkey(stream, name), Number(struct.unpackFrom(fmt, body, valueAt)[0]));
    }
    pos = valueAt + valueLen;
  }
  return out;
}

export function _probeWmv(fp: ProbeStream): MediaInfo {
  if (!bytesEq(fp.read(16), _ASF_HEADER)) throw new ValueError("Not a valid ASF/WMV file (bad header GUID)");
  const headerSize = Number(struct.unpack("<Q", fp.read(8))[0]);
  fp.read(6); // object count (u32) + 2 reserved bytes
  const body = fp.read(Math.max(0, headerSize - 30));
  let width = 0;
  let height = 0;
  let sendDuration = 0.0;
  let playDuration = 0.0;
  let preroll = 0.0;
  let frameRate = 0.0;
  let audioSampleRate = 0.0;
  let hasAudio = false;
  let videoStream = -1;
  let metadata = new Map<string, number>();
  const avgFrameTime = new Map<number, number>();

  for (const [guid, start, end] of _asfObjects(body, 0, body.length)) {
    const size = end - start;
    if (bytesEq(guid, _ASF_FILE_PROPS) && size >= 64) {
      playDuration = Number(struct.unpackFrom("<Q", body, start + 40)[0]) / 1e7;
      sendDuration = Number(struct.unpackFrom("<Q", body, start + 48)[0]) / 1e7;
      preroll = Number(struct.unpackFrom("<Q", body, start + 56)[0]) / 1e3;
    } else if (bytesEq(guid, _ASF_STREAM_PROPS) && size >= 62) {
      const stream = struct.unpackFrom("<H", body, start + 48)[0] & 0x7f;
      if (bytesEq(bytes_.slice(body, start, start + 4), _ASF_VIDEO_PREFIX)) {
        videoStream = stream;
        // Type-specific data at +54 begins with enc_width/height.
        width = struct.unpackFrom("<I", body, start + 54)[0];
        height = struct.unpackFrom("<I", body, start + 58)[0];
      } else if (bytesEq(bytes_.slice(body, start, start + 4), _ASF_AUDIO_PREFIX)) {
        hasAudio = true;
        // Type-specific data at +54 is a WAVEFORMATEX; its
        // nSamplesPerSec follows wFormatTag(2) and nChannels(2).
        audioSampleRate = Number(struct.unpackFrom("<I", body, start + 58)[0]);
      }
    } else if (bytesEq(guid, _ASF_EXT_STREAM_PROPS) && size >= 64) {
      const stream = struct.unpackFrom("<H", body, start + 48)[0];
      avgFrameTime.set(stream, Number(struct.unpackFrom("<Q", body, start + 52)[0]));
    } else if (bytesEq(guid, _ASF_METADATA)) {
      metadata = _asfMetadata(body, start, end);
    }
  }

  // Average Time Per Frame (100 ns units) is authoritative for AE: a 25 fps
  // file whose header claims 29.97 imports at 29.97. Without it, invert AE's
  // own duration rule below against the Metadata Object's frame count.
  const avg = avgFrameTime.get(videoStream) ?? 0;
  const frames = metadata.get(tkey(videoStream, "NumberOfFrames")) ?? 0;
  if (avg) {
    frameRate = round(1e7 / avg, 3);
  } else if (frames > 1 && sendDuration) {
    frameRate = round((frames - 1) / sendDuration, 3);
  }

  const aspectX = metadata.get(tkey(videoStream, "AspectRatioX")) ?? 0;
  const aspectY = metadata.get(tkey(videoStream, "AspectRatioY")) ?? 0;
  const pixelAspect = aspectX && aspectY ? round(aspectX / aspectY, 5) : 1.0;

  // AE reports the Send Duration rounded out to a whole frame, plus one:
  // a 1.96 s / 25 fps stream imports as 50 frames = 2.0 s, and the same
  // stream relabelled 29.97 fps imports as 60 frames = 2.002002 s.
  let duration: number;
  if (frameRate && sendDuration) duration = (round(sendDuration * frameRate) + 1) / frameRate;
  else if (sendDuration) duration = sendDuration;
  else duration = max([0.0, playDuration - preroll]);
  return new MediaInfo({
    width,
    height,
    duration,
    frameRate: frameRate,
    hasAudio: hasAudio,
    audioSampleRate: audioSampleRate,
    pixelAspect: pixelAspect,
    depth: width ? _colorDepth(false, 8) : 0,
  });
}

/** `_colorDepth` for a file of `bit_depth` bits per channel: AE decodes anything deeper than 8 bits at 16 (AE 2026: 10- and 12-bit DPX are 48). */
export function _deepColorDepth(hasAlpha: boolean, bitDepth: number): number {
  return _colorDepth(hasAlpha, bitDepth <= 8 ? 8 : 16);
}

/**
 * Probe a DPX (SMPTE 268M) or Cineon (SMPTE V4.5) file header.
 *
 * Handles both byte orders for each format: DPX big-endian (`SDPX`) and
 * little-endian (`XPDS`), Cineon big-endian (`0x802A5FD7`) and
 * little-endian (`0xD75F2A80`).
 *
 * @param fp - Readable binary stream positioned at the start of the file.
 * @returns A `MediaInfo` with width, height, bit_depth, and has_alpha filled in.
 *   Duration is 0 (still frame); pixel_aspect defaults to 1.0.
 * @throws ValueError If the file is too short or has an unrecognised magic number.
 */
export function _probeDpxCineon(fp: ProbeStream): MediaInfo {
  const header = fp.read(1408); // 768-byte file info + 640-byte image info
  if (header.length < 1024) throw new ValueError("Not a valid DPX/Cineon file (header too short)");

  const magic = bytes_.slice(header, 0, 4);

  // --- DPX (SMPTE 268M) ---
  if (bytesEq(magic, b("SDPX")) || bytesEq(magic, b("XPDS"))) {
    const endian = bytesEq(magic, b("SDPX")) ? ">" : "<";
    const nElem = struct.unpack(`${endian}H`, bytes_.slice(header, 770, 772))[0];
    const [width, height] = struct.unpack(`${endian}II`, bytes_.slice(header, 772, 780));
    let hasAlpha = false;
    let bitDepth = 8;
    for (let i = 0, n = Math.min(nElem, 8); i < n; i++) {
      const offset = 780 + i * 72;
      if (offset + 24 > header.length) break;
      const [desc, , , bits] = struct.unpack("BBBB", bytes_.slice(header, offset + 20, offset + 24));
      if (i === 0) bitDepth = bits;
      // Descriptor 4 = alpha-only, 51 = RGBA, 52 = ABGR.
      if ([4, 51, 52].includes(desc)) hasAlpha = true;
    }
    return new MediaInfo({
      width,
      height,
      bitDepth: bitDepth,
      hasAlpha: hasAlpha,
      depth: _deepColorDepth(hasAlpha, bitDepth),
    });
  }

  // --- Cineon (SMPTE V4.5) ---
  if (bytesEq(magic, b("\x80\x2a\x5f\xd7")) || bytesEq(magic, b("\xd7\x5f\x2a\x80"))) {
    const endian = bytesEq(magic, b("\x80\x2a\x5f\xd7")) ? ">" : "<";
    // Byte 192 = orientation (u1), byte 193 = number_of_elements (u1).
    const nElem = header[193];
    const hasAlpha = nElem > 3;
    let bitDepth = 8;
    let width = 0;
    let height = 0;
    for (let i = 0, n = Math.min(nElem, 8); i < n; i++) {
      const offset = 196 + i * 28;
      if (offset + 12 > header.length) break;
      const [, , bits] = struct.unpack("BBBB", bytes_.slice(header, offset, offset + 4));
      const [w, h] = struct.unpack(`${endian}II`, bytes_.slice(header, offset + 4, offset + 12));
      if (i === 0) {
        bitDepth = bits;
        width = w;
        height = h;
      }
    }
    return new MediaInfo({
      width,
      height,
      bitDepth: bitDepth,
      hasAlpha: hasAlpha,
      depth: _deepColorDepth(hasAlpha, bitDepth),
    });
  }

  throw new ValueError("Not a valid DPX/Cineon file (bad magic number)");
}

/** HEIF brands `_probe_heif` accepts in `ftyp`, as `bytes_.hex` keys. */
export const _HEIF_BRANDS: ReadonlySet<string> = new Set([b("heic"), b("heix"), b("mif1"), b("heif")].map((k) => bytes_.hex(k)));

/**
 * Probe a HEIF/HEIC (ISO/IEC 23008-12) still image.
 *
 * Walks the ISOBMFF box tree (`meta` -\> `iprp` -\> `ipco`) for `ispe`
 * (dimensions), `pixi` (bit depth) and an `auxC` alpha item. Accepts any
 * `ftyp` whose major or compatible brands include `heic`, `heix`, `mif1`
 * or `heif`.
 *
 * @throws ValueError If the file is too short, has no HEIF brand, or no `ispe`.
 */
export function _probeHeif(fp: ProbeStream): MediaInfo {
  const data = fp.read();
  if (data.length < 12) throw new ValueError("Not a valid HEIF file (too short)");

  const ftypSize = _u(data, 0, 4);
  if (!bytesEq(bytes_.slice(data, 4, 8), b("ftyp")) || ftypSize < 16 || ftypSize > data.length) {
    throw new ValueError("Not a valid HEIF file (missing ftyp box)");
  }
  const major = bytes_.slice(data, 8, 12);
  const compat = new Set<string>();
  for (let i = 16; i < ftypSize; i += 4) compat.add(bytes_.hex(bytes_.slice(data, i, i + 4)));
  const compatBrand = [...compat].some((c) => _HEIF_BRANDS.has(c));
  if (!_HEIF_BRANDS.has(bytes_.hex(major)) && !compatBrand) {
    throw new ValueError("Not a valid HEIF file (no HEIF brand in ftyp)");
  }

  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let hasAlpha = false;
  for (const [a1, b1, e1] of _atoms(data, 0, data.length)) {
    if (!bytesEq(a1, b("meta"))) continue;
    // meta is a full box: version(1) + flags(3) precede its children.
    for (const [a2, b2, e2] of _atoms(data, b1 + 4, e1)) {
      if (!bytesEq(a2, b("iprp"))) continue;
      for (const [a3, b3, e3] of _atoms(data, b2, e2)) {
        if (!bytesEq(a3, b("ipco"))) continue;
        for (const [a4, b4, e4] of _atoms(data, b3, e3)) {
          if (bytesEq(a4, b("ispe")) && width === 0) {
            // ispe is a full box: version(4) + width(4) + height(4).
            width = _u(data, b4 + 4, 4);
            height = _u(data, b4 + 8, 4);
          } else if (bytesEq(a4, b("pixi")) && bitDepth === 8) {
            const nc = b4 + 5 <= e4 ? data[b4 + 4] : 0;
            if (nc && b4 + 5 + nc <= e4) bitDepth = data[b4 + 5];
          } else if (bytesEq(a4, b("auxC"))) {
            // Null-terminated URN after version+flags; the alpha
            // plane's is urn:mpeg:hevc:2015:auxid:1.
            const urn = bytes_.split(bytes_.slice(data, b4 + 4, e4), b("\x00"), 1)[0];
            if (bytes_.contains(urn, b("auxid"))) hasAlpha = true;
          }
        }
      }
    }
  }
  if (width === 0) throw new ValueError("Not a valid HEIF file (no ispe box found)");
  return new MediaInfo({
    width,
    height,
    bitDepth: bitDepth,
    hasAlpha: hasAlpha,
    depth: _deepColorDepth(hasAlpha, bitDepth),
  });
}

/** Parsers by lower-cased file suffix (dispatch order as in the Python table). */
export const _PARSERS: Map<string, (fp: ProbeStream) => MediaInfo> = new Map<string, (fp: ProbeStream) => MediaInfo>([
  [".png", _probePng],
  [".mov", _probeMov],
  [".m4v", _probeMov],
  [".mp4", _probeMp4],
  [".m4a", _probeMov],
  [".fbx", _probeFbx],
  [".txt", _probeData],
  [".csv", _probeData],
  [".json", _probeData],
  [".mgjson", _probeMgjson],
  [".mp3", _probeMp3],
  [".aac", _probeAac],
  [".swf", _probeSwf],
  [".mpeg", _probeMpeg],
  [".mpg", _probeMpeg],
  [".hdr", _probeHdr],
  [".crw", _probeCrw],
  [".ai", _probeText],
  [".eps", _probeText],
  [".pdf", _probeText],
  [".wmv", _probeWmv],
  [".aiff", _probeAiff],
  [".aif", _probeAiff],
  [".wav", _probeWav],
  [".exr", _probeExr],
  [".tif", _probeTiff],
  [".tiff", _probeTiff],
  [".jpg", _probeJpeg],
  [".jpeg", _probeJpeg],
  [".tga", _probeTga],
  [".bmp", _probeBmp],
  [".gif", _probeGif],
  [".psd", _probePsd],
  [".psb", _probePsd],
  [".dpx", _probeDpxCineon],
  [".cin", _probeDpxCineon],
  [".heic", _probeHeif],
  [".heif", _probeHeif],
]);
