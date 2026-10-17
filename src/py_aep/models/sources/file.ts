// Port of py_aep/models/sources/file.py.

import * as host from "../../../pyrt/host.ts";

import { OptiChunk, SspcChunk, TextOptiChunk, build_ai_document_opti_data, build_ai_layer_opti_data, build_craw_opti_data, build_dpx_opti_data, build_exr_opti_data, build_generic_opti_data, build_psd_layer_opti_data, build_psd_opti_data, build_rhdr_opti_data, build_text_opti_data, build_tiff_opti_data } from "../../binary/footage_chunks.ts";
import { EmpdChunk } from "../../binary/misc_chunks.ts";
import { ColorProfileRecord, build_pin_list } from "../../binary/mutations.ts";
import { Utf8Chunk, type U1Chunk } from "../../binary/scalar_chunks.ts";
import { build_als2_list, build_stvc_list, ChunkNotFoundError, filter_by_type, find_by_list_type, find_by_list_type_or_null, find_by_type, find_chunks_before, alas_fullpath, alas_target_is_folder, index_by_identity, parse_alas_data, UNDEFINED_FRAME } from "../../binary/utils.ts";
import type { Chunk, ListChunk } from "../../binary/chunk.ts";
import { build_icc_envelope } from "../../color/envelope.ts";
import { ColorProfileNotFoundError, default_icc_library, icc_profile_description, icc_profile_id } from "../../color/icc.ts";
import { ocio_input_envelope, resolve_ocio_config } from "../../color/ocio.ts";
import { AI_COMP_EXTENSIONS, FORMAT_3D_MODEL_SCENE, PSD_COMP_EXTENSIONS, get_file_format, platform_source_format, type FileFormat } from "../../data/file_formats.ts";
import { ColorManagementSystem, LinearLightMode } from "../../enums/index.ts";
import type { Box } from "../../resolvers/ai_bounds.ts";
import { EMPTY_BOX, footage_size, read_ai_icc_profile, read_ai_layer_bounds } from "../../resolvers/ai_bounds.ts";
import { UnsupportedAiLayersError, read_ai_layer_ocgs } from "../../resolvers/ai_layers.ts";
import { MediaInfo, pixel_buffer_size, probe_media, psd_layer_channels, psd_layer_depth, type MediaInfoFields } from "../../resolvers/media_probe.ts";
import { platform_path } from "../../resolvers/platform_paths.ts";
import { psd_layer_box } from "../../resolvers/psd_bounds.ts";
import { read_global_light } from "../../resolvers/psd_styles.ts";
import { layer_index_for_stored, resolve_ai_layer, resolve_psd_layer } from "../../resolvers/source_layers.ts";
import type { PsdLayer } from "../../resolvers/psd_layers.ts";
import { validate_bool, validate_file_exists } from "../validators.ts";
import { _UNASSIGNED_PROFILE, FootageSource, _store_frames_over_rate } from "./footage.ts";
import type { FootageItem } from "../items/footage.ts";
import type { Project } from "../project.ts";
import {
  Path,
  BytesIO,
  NotImplementedError,
  OSError,
  ValueError,
  at,
  b,
  bytes_,
  bytes_eq,
  concat,
  floordiv,
  format,
  getattr,
  setattr,
  getitem,
  int,
  py_bool,
  py_or,
  repr,
  round,
  sorted,
  str,
  warn,
  type PathLike,
  PurePosixPath,
  PureWindowsPath,
  py_re,
} from "../../../pyrt/index.ts";

/**
 * `NamedTuple._replace(**kw)` for the translated NamedTuples (`MediaInfo`,
 * `FileFormat`) that may not carry a `_replace` method.
 */
export function _replace(obj: MediaInfo, kw: Partial<MediaInfoFields>): MediaInfo;
export function _replace(obj: FileFormat, kw: Partial<FileFormat>): FileFormat;
export function _replace(obj: MediaInfo | FileFormat, kw: Partial<MediaInfoFields> & Partial<FileFormat>): MediaInfo | FileFormat {
  if (obj instanceof MediaInfo) return obj._replace(kw);
  return Object.assign(Object.create(Object.getPrototypeOf(obj)), obj, kw);
}

/** `os.path.splitext(name)[1]` */
export function _splitext_ext(name: string): string {
  // Leading dots belong to the stem, as in os.path.splitext.
  const stripped = name.replace(/^\.+/, "");
  const i = stripped.lastIndexOf(".");
  return i < 0 ? "" : stripped.slice(i);
}

/**
 * Whether a caught Node `fs` error is Python's `OSError`. NOTE(port): pyrt's
 * `Path` lets raw Node errors through, which are not `OSError` instances, so
 * the `errno` check matches Python's `except OSError` for fs failures.
 */
export function _is_os_error(e: unknown): boolean {
  return e instanceof OSError || (typeof e === "object" && e !== null && "errno" in e && typeof e.errno === "number");
}

export function _opti_data(
  fmt: FileFormat,
  info: MediaInfo,
  path: Path,
  kw: { sequence?: boolean; data?: Uint8Array | null } = {},
): Uint8Array {
  /**
   * Select the `opti` asset-info body for a file source (`path`, or a
   * sequence's first frame; `data` is its content, if already read).
   *
   * Rules verified against AE 2026:
   *
   * - TIFF (still or sequence): always needs the 602-byte `TIF ` header;
   *   an empty or generic header crashes AE for TIFF regardless of whether
   *   it is a still or a sequence.
   * - PSD: the 602-byte `8BPS` header of the merged document.
   * - TIFF and PSD record the image as AE reads it: channel count, bit
   *   depth, colour mode and layer count.
   * - EXR (still or sequence): the 9750-byte `oEXR` header AE writes
   *   (`build_exr_opti_data`). AE opens an EXR with an empty or generic opti,
   *   but renders a data window that differs from the display window
   *   misplaced, and crashed rendering one larger than the display window.
   * - FBX singles: empty opti is fine (AE re-reads the located file).
   * - Sequences and all audio/video formats: need the 58-byte generic
   *   header so AE recognises the item as a sequence or media file rather
   *   than missing footage.
   * - PNG (still or sequence): needs the 58-byte generic header; AE opens
   *   a PNG still with an empty opti but crashes as soon as it renders it.
   * - HDR (Radiance): needs the 30-byte format-specific `RHDR` header;
   *   dimensions live in `sspc`, not the opti.
   * - Camera Raw (CRW): the 30-byte `Craw` header AE writes for a raw file
   *   without develop settings; an empty opti crashes AE.
   * - AI/EPS/PDF: need the 596-byte `TEXT` header with width/height
   *   embedded as big-endian u16; an Illustrator/PDF document adds its
   *   layer count, page count and page-size tail, an EPS file does not.
   */
  const { sequence = false, data = null } = kw;
  if (fmt.opti === "tiff") {
    return build_tiff_opti_data(
      info.width,
      info.height,
      info.bit_depth,
      info.pixel_channels,
      info.color_mode,
      info.layer_count,
    );
  }
  if (fmt.opti === "psd") {
    return build_psd_opti_data(
      info.width,
      info.height,
      info.bit_depth,
      info.pixel_channels,
      info.color_mode,
      info.layer_count,
    );
  }
  if (fmt.opti === "hdr") return build_rhdr_opti_data();
  if (fmt.opti === "craw") return build_craw_opti_data();
  if (fmt.opti === "dpx") return build_dpx_opti_data();
  if (fmt.opti === "text") {
    if (AI_COMP_EXTENSIONS.has(path.suffix.toLowerCase())) {
      return build_ai_document_opti_data(info.width, info.height, _ai_layer_count(path, data));
    }
    return build_text_opti_data(info.width, info.height);
  }
  if (fmt.opti === "exr") return build_exr_opti_data(info.compression, info.channel_names);
  if (fmt.opti === "empty" && !sequence) return b("");
  return build_generic_opti_data(fmt.source_format, { sequence });
}

export function _ai_layer_count(path: Path, data: Uint8Array | null = null): number {
  /**
   * How many layers an Illustrator/PDF document has, as AE records it for
   * the whole document: 0 for one without layers (pdf.pdf, ai_no_pdf.ai in
   * footage_depth.aep). A document whose layers cannot be read (malformed or
   * truncated PDF objects) counts 0 as well: the count only annotates the
   * footage, which imports without it.
   */
  try {
    return read_ai_layer_ocgs(path, data).length;
  } catch (e) {
    if (!(e instanceof UnsupportedAiLayersError)) throw e;
    return 0;
  }
}

export function _still_data_size(fmt: FileFormat, info: MediaInfo, path: Path): number {
  /**
   * The source data size AE caches in `sspc` for a single file.
   *
   * The file's size on disk (AE 2026, macOS and Windows), except for merged
   * PSD footage and TIFF stills, whose decoded pixel buffer AE caches
   * instead: `w * h * channels * bytes per channel` (`MediaInfo.pixel_channels`;
   * choose_layer_merged / flattened_rgb_comp / footage_depth.aep fixtures).
   */
  if (!["psd", "tiff"].includes(fmt.opti)) return path.stat().size;
  return pixel_buffer_size(info.width, info.height, info.pixel_channels, info.bit_depth);
}

/** What After Effects records for the footage of one Photoshop layer. */
export class PsdLayerFootage {
  /** The content box `(left, top, right, bottom)` in canvas pixels. */
  readonly box: [number, number, number, number];
  readonly opti_data: Uint8Array;
  readonly data_size: number;
  readonly has_alpha: boolean;
  readonly depth: number;

  constructor(
    box: [number, number, number, number],
    opti_data: Uint8Array,
    data_size: number,
    has_alpha: boolean,
    depth: number,
  ) {
    this.box = box;
    this.opti_data = opti_data;
    this.data_size = data_size;
    this.has_alpha = has_alpha;
    this.depth = depth;
  }

  *[Symbol.iterator](): Generator<unknown> {
    yield this.box;
    yield this.opti_data;
    yield this.data_size;
    yield this.has_alpha;
    yield this.depth;
  }
}

export function psd_layer_footage(
  info: MediaInfo,
  layer: PsdLayer,
  layer_styles: string,
  global_angle: number,
): PsdLayerFootage {
  /**
   * The content box, `opti`, cached data size, alpha and depth AE
   * records for `layer`'s footage - the same on a layered import and on a
   * single-layer import or replace (`resolvers.psd_bounds.psd_layer_box`,
   * `build_psd_layer_opti_data`, AE 2026 fixtures).
   *
   * @param info - The probed document.
   * @param layer - The Photoshop layer.
   * @param layer_styles - The Layer Options choice: `"merge"`, `"editable"` or `"ignore"`.
   * @param global_angle - The document's global light angle.
   */
  const box = psd_layer_box(layer, info.width, info.height, layer_styles, global_angle);
  const [left, top, right, bottom] = box;
  const layer_channels = psd_layer_channels(info, layer.has_transparency);
  const opti_data = build_psd_layer_opti_data(
    info.width,
    info.height,
    info.bit_depth,
    info.layer_count,
    layer.record_index,
    layer.layer_id,
    layer.name,
    box,
    layer.is_adjustment,
    layer.vector_mask != null,
    {
      channels: info.pixel_channels,
      color_mode: info.color_mode,
      layer_channels,
    },
  );
  const data_size = pixel_buffer_size(
    Math.max(right - left, 0),
    Math.max(bottom - top, 0),
    layer_channels,
    info.bit_depth,
  );
  return new PsdLayerFootage(
    box,
    opti_data,
    data_size,
    layer.has_transparency,
    psd_layer_depth(info, layer.has_transparency),
  );
}

export function _platform_media_info(
  info: MediaInfo,
  fmt: FileFormat,
  kw: { windows: boolean },
): MediaInfo {
  /**
   * `info` as After Effects on the target platform reads the file.
   *
   * AE 2026 on Windows stores `heic_alpha.heic` without alpha, whether it is
   * imported by script or through the Import dialog; AE on macOS keeps the
   * alpha channel (`format_options/heic` fixture).
   */
  const { windows } = kw;
  if (windows && fmt.source_format === "AIDE" && info.has_alpha) {
    // The same channels without the alpha one (32 -> 24 on Windows).
    return _replace(info, { has_alpha: false, depth: floordiv(info.depth, 4) * 3 });
  }
  return info;
}

/**
 * The profile AE falls back to for media that carries none of its own.
 */
export const _DEFAULT_PROFILE = "sRGB IEC61966-2.1";

/**
 * What AE assigns instead to video it decodes itself - an animated GIF, an
 * MPEG, a SWF or a WMV. A still or an image sequence of the same format
 * keeps the default, and QuickTime/MP4 name their space instead. STIL and
 * IMIO are BMP/GIF on Windows and macOS (see `GENERIC_STILL_FORMATS`).
 */
export const _VIDEO_PROFILE = "Rec.709 Gamma 2.4";
export const _VIDEO_DECODED_FORMATS = new Set(["STIL", "IMIO", "SWF ", "MPEO", "WMED"]);

/**
 * Formats whose importer embeds After Effects' own catalogued copy of the
 * profile rather than the file's bytes, and treats an untagged RGB file as
 * carrying sRGB (the Photoshop convention). The two copies differ only in
 * the advisory rendering-intent field, so the profile ID still matches.
 * An Illustrator/PDF file's RGB profile is recorded the same way (AE 2026,
 * complex.ai).
 */
export const _CATALOGUED_PROFILE_FORMATS = new Set(["TIF ", "8BPS"]);

/**
 * DPX and Cineon: AE records no profile at all and interprets the footage
 * in the working space (`ipws` 1; AE 2026 on Windows and the macOS
 * media_gap_formats.aep fixture).
 */
export const _UNPROFILED_FORMATS = new Set(["sDPX"]);

/**
 * The profile AE embeds for a Camera Raw file, which carries none: the
 * catalogued ProPhoto RGB Camera Raw develops into (AE 2026, crw.crw).
 */
export const _CAMERA_RAW_PROFILES = new Map<string, string>([["Craw", "ProPhoto RGB"]]);

/**
 * The profile AE records by name only (`empd`, no ICC data, interpreted in
 * the working space) for a TIFF or Photoshop image that carries none and is
 * not RGB, by Photoshop colour mode: grayscale, indexed, CMYK, Lab (AE 2026,
 * depth/*.psd and *.tif). A 32-bit float grayscale TIFF names the linear
 * one; a bitmap (1-bit) image is assigned sRGB like any untagged media.
 */
export const _MODE_PROFILE_NAMES = new Map<number, string>([
  [1, "Dot Gain 20%"],
  [2, "sRGB IEC61966-2.1"],
  [4, "U.S. Web Coated (SWOP) v2"],
  [9, "Lab D50"],
]);
export const _LINEAR_GRAY_PROFILE_NAME = "Linear Grayscale Profile";

/**
 * Formats AE leaves without any profile record when the file carries none:
 * JPEG, and the QuickTime/MP4 containers, whose color space AE names
 * (`empd` + e.g. "Rec. 709") from data py_aep cannot read yet. The record
 * still counts as managed - AE fills the name in when it opens the project.
 */
export const _UNRECORDED_PROFILE_FORMATS = new Set(["ZPEG"]);
export const _VIDEO_CONTAINER_FORMATS = new Set(["MOoV", "XCEX"]);

/**
 * Formats AE imports with Interpret As Linear Light off rather than the
 * "on for 32-bpc files" default: the ones it decodes through its media
 * importers. An audio-only QuickTime and any image sequence keep the
 * default. The setting is inert below 32 bpc either way. HEIC (`AIDE`) is
 * one of them: off in every AE 2026 HEIC import (Windows and macOS).
 */
export const _LINEAR_LIGHT_OFF_FORMATS = new Set([
  "ZPEG",
  "STIL",
  "IMIO",
  "SWF ",
  "MPEO",
  "WMED",
  "MOoV",
  "XCEX",
  "AIDE",
]);

export function _catalogued_profile(name: string): Uint8Array | null {
  /** After Effects' own copy of the named profile, if it is installed. */
  try {
    return default_icc_library().bytes_for(name);
  } catch (e) {
    if (!(e instanceof ColorProfileNotFoundError)) throw e;
    return null;
  }
}

export function _profile_record(blob: Uint8Array): ColorProfileRecord {
  const name = icc_profile_description(blob) || "";
  return new ColorProfileRecord(icc_profile_id(blob), build_icc_envelope(name, blob));
}

export function named_media_profile(source_format: string, info: MediaInfo): string | null {
  /**
   * The profile After Effects records by name only for a TIFF or Photoshop
   * image whose colours are not RGB, or `null` when it records an ICC
   * profile (or none) instead.
   *
   * A file tagged with a non-RGB profile names that profile; an untagged one
   * names AE's default for its colour mode (`_MODE_PROFILE_NAMES`).
   */
  if (!_CATALOGUED_PROFILE_FORMATS.has(source_format)) return null;
  if (info.icc_profile != null) {
    if (bytes_eq(bytes_.slice(info.icc_profile, 16, 20), b("RGB "))) return null;
    return icc_profile_description(info.icc_profile);
  }
  if (info.color_mode === 1 && info.bit_depth === 32) {
    // Measured for a float TIFF only; a 32-bit grayscale PSD keeps the
    // RGB rule until it is measured.
    return source_format === "TIF " ? _LINEAR_GRAY_PROFILE_NAME : null;
  }
  return _MODE_PROFILE_NAMES.get(info.color_mode) ?? null;
}

export function ai_document_profile(
  path: Path,
  data: Uint8Array | null = null,
): [Uint8Array | null, string | null] {
  /**
   * `(icc_profile, profile_name)` for an Illustrator/PDF/EPS file: the RGB
   * profile its page draws with, recorded like a raster file's embedded one,
   * or the name of a non-RGB one, which AE records by name only (AE 2026:
   * complex.ai embeds sRGB, ai.ai names Coated FOGRA39).
   */
  const icc = read_ai_icc_profile(path, data);
  if (icc == null) return [null, null];
  if (bytes_eq(bytes_.slice(icc, 16, 20), b("RGB "))) return [icc, null];
  return [null, icc_profile_description(icc)];
}

export function _media_profile_records(
  icc_profile: Uint8Array | null,
  source_format: string,
  has_video: boolean,
  is_video: boolean,
  embedded_profile_name: string | null,
  color_mode: number = 3,
): [ColorProfileRecord | null, ColorProfileRecord | null] {
  /**
   * The `(embedded, assigned)` CLRS profile records for a source file.
   *
   * AE records the profile the file carries and assigns one to media that
   * carries none, with the per-format exceptions in
   * `_CATALOGUED_PROFILE_FORMATS`, `_UNRECORDED_PROFILE_FORMATS`,
   * `_VIDEO_CONTAINER_FORMATS` and `_VIDEO_DECODED_FORMATS`. Measured across
   * every format py_aep imports (AE 2026), plus untagged JPEG/TIFF/PSB
   * variants.
   *
   * @param icc_profile - The profile the media file embeds, if any (see
   *   {@link MediaInfo | MediaInfo.icc_profile}).
   * @param source_format - Its `sspc` 4-char format code.
   * @param has_video - Whether the media has picture at all (audio-only QuickTime is recorded like
   *   any other audio file).
   * @param is_video - Whether the picture is time-based rather than a still or an image sequence.
   * @param embedded_profile_name - A named media color space, for the formats that carry one (`.ai`
   *   and friends, non-RGB TIFF/PSD).
   * @param color_mode - The Photoshop colour mode the image reads as (see
   *   {@link MediaInfo | MediaInfo.color_mode}); an untagged bitmap
   *   TIFF/PSD is assigned sRGB rather than taken as carrying it.
   */
  if (embedded_profile_name != null || _UNPROFILED_FORMATS.has(source_format)) {
    return [null, null]; // a named space, or none at all (DPX/Cineon)
  }
  let blob = icc_profile;
  const camera_raw_profile = _CAMERA_RAW_PROFILES.get(source_format);
  if (blob == null && camera_raw_profile !== undefined) {
    blob = _catalogued_profile(camera_raw_profile);
  } else if (blob == null && _CATALOGUED_PROFILE_FORMATS.has(source_format) && color_mode !== 0) {
    blob = _catalogued_profile(_DEFAULT_PROFILE);
  } else if (
    blob != null &&
    (_CATALOGUED_PROFILE_FORMATS.has(source_format) || source_format === "TEXT")
  ) {
    const catalogued = _catalogued_profile(icc_profile_description(blob) || "");
    if (catalogued != null && bytes_eq(icc_profile_id(catalogued), icc_profile_id(blob))) {
      blob = catalogued;
    }
  }
  if (blob != null) return [_profile_record(blob), null];
  if (
    _UNRECORDED_PROFILE_FORMATS.has(source_format) ||
    (has_video && _VIDEO_CONTAINER_FORMATS.has(source_format))
  ) {
    return [null, null];
  }
  const name =
    is_video && _VIDEO_DECODED_FORMATS.has(source_format) ? _VIDEO_PROFILE : _DEFAULT_PROFILE;
  const assigned = _catalogued_profile(name);
  if (assigned == null) {
    // Nothing to assign without the profile's bytes; the record stays
    // empty so the import still works with no ICC store on the machine.
    return [null, null];
  }
  return [null, _profile_record(assigned)];
}

export function _alpha_mode_raw(has_alpha: boolean, premultiplied: boolean): number {
  /**
   * The `sspc` alpha byte AE stores: 3 = no alpha, 1 = premultiplied,
   * 0 = straight.
   */
  if (!has_alpha) return 3;
  return premultiplied ? 1 : 0;
}

export function _sync_premultiplied(sspc: SspcChunk): void {
  /**
   * Set the `sspc` premultiplied flag bit AE writes with the alpha byte.
   *
   * AE resets the footage to straight alpha on open when the bit disagrees
   * with a premultiplied alpha byte. An FBX scene is the exception: AE 2026
   * sets the bit while the byte stays straight (the 3D scene renders against
   * a premultiplied black background; measured against an AE-resaved
   * crystal.fbx).
   */
  sspc.premultiplied =
    sspc.alpha_mode_raw === 1 || sspc.source_format_type === FORMAT_3D_MODEL_SCENE;
}

// `sspc` kind bytes (0xC8-0xC9) for a PSD single-layer binding: byte 0xC9
// records the import dialog's Layer Options choice (psd_layer_styles.aep
// fixtures). "editable" is never a user-passable value on the footage
// paths - it only flows through `FootageItem.replace(CURRENT_VALUE)`
// preserving an editable-comp per-layer binding verbatim.
export const PSD_LAYER_STYLES_C8 = new Map<string, Uint8Array>([
  ["ignore", b("\x00\x00")],
  ["merge", b("\x00\x01")],
  ["editable", b("\x00\x02")],
]);
export const _C9_TO_LAYER_STYLES = new Map<number, string>(
  [...PSD_LAYER_STYLES_C8].map(([k, v]): [number, string] => [v[1], k]),
);

// A sequence frame number is at most the last 9 digits of the file stem; any
// digits before them belong to the prefix (AE 2026: f_99999999998.png and
// f_99999999999.png import as `f_99[999999998-999999999].png`).
export const _FRAME_NUMBER_RE = py_re(String.raw`(\d{1,9})$`);

// AE reads the `sspc` width and height as signed 16-bit values: a py_aep file
// holding a 65535-px-wide PNG opens -1 px wide in AE 2026, and 65536 does not
// fit the field at all.
export const _MAX_FOOTAGE_SIZE = 32767;

export function check_footage_size(name: string, width: number, height: number): void {
  /**
   * Reject footage dimensions After Effects cannot store or read back.
   *
   * @throws {@link ValueError} If `width` or `height` is outside 0-32767 px.
   */
  if (!(0 <= width && width <= _MAX_FOOTAGE_SIZE && 0 <= height && height <= _MAX_FOOTAGE_SIZE)) {
    throw new ValueError(
      `${name}: ${width}x${height} px is outside the 0-${_MAX_FOOTAGE_SIZE} px ` +
        "After Effects footage can hold",
    );
  }
}

export function _join_sequence_frame(folder: string, frame_name: string): string {
  /**
   * Join a footage folder with an image-sequence frame filename using the
   * folder's own separator, so the result matches AE's `fsName` (all `\` for
   * a Windows-authored project, all `/` for a POSIX one) rather than mixing
   * the two. A backslash anywhere marks a Windows path; `PureWindowsPath` also
   * splits any embedded `/`, while `PurePosixPath` leaves a native POSIX path
   * intact (`PureWindowsPath` would rewrite its forward slashes to `\`).
   */
  if (folder.includes("\\")) return String(new PureWindowsPath(folder).div(frame_name));
  return String(new PurePosixPath(folder).div(frame_name));
}

export type NewSourceKw = {
  source_format: string;
  width: number;
  height: number;
  duration: number;
  frame_rate: number;
  pixel_aspect?: number;
  has_alpha?: boolean;
  depth?: number;
  media_flag?: boolean;
  alpha_premultiplied?: boolean;
  audio_sample_rate?: number;
  sequence_prefix?: string | null;
  sequence_ext?: string | null;
  sequence_files?: string[] | null;
  start_frame?: number;
  end_frame?: number;
  frame_padding?: number;
  opti_data?: Uint8Array;
  embedded_profile_name?: string | null;
  icc_profile?: Uint8Array | null;
  full_frame?: boolean;
  layer_name?: string;
  layer_id?: number | null;
  layer_index?: number | null;
  data_size?: number;
  reserved_c8?: Uint8Array | null;
  color_mode?: number;
  windows: boolean;
};

/**
 * The `FileSource` object describes footage that comes from a file.
 *
 *
 * Info:
 *     `FileSource` is a subclass of {@link FootageSource} object. All methods and
 *     attributes of {@link FootageSource} are available when working with `FileSource`.
 *
 * @example
 * ```ts
 * import { FileSource, parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const footage = app.project.footages[0];
 * if (footage.main_source instanceof FileSource) {
 *   console.log(footage.main_source.file);
 * }
 * ```
 * @see https://ae-scripting.docsforadobe.dev/sources/filesource/
 */
export class FileSource extends FootageSource {
  declare _pin: ListChunk;
  declare _opti: OptiChunk;
  declare _file: string;
  declare _file_names: string[];
  declare _target_is_folder: boolean;
  declare _file_attributes: Map<string, number | string>;

  /** The full file path. Read-only. */
  get file(): string {
    return this._file;
  }

  /** The filenames if the footage is an image sequence. Read-only. */
  get file_names(): string[] {
    return this._file_names;
  }

  /** `true` if the file is a folder, else `false`. Read-only. */
  get target_is_folder(): boolean {
    return this._target_is_folder;
  }

  get _is_sequence(): boolean {
    return this._target_is_folder;
  }

  /**
   * Whether this is an image sequence listed by file name (imported
   * with `force_alphabetical`) rather than numbered: AE leaves its frame
   * numbers undefined and keeps the file names in the Pin's StVc list.
   */
  get _is_alphabetical(): boolean {
    return (
      this._target_is_folder &&
      this._sspc.start_frame === UNDEFINED_FRAME &&
      this._file_names?.length > 0
    );
  }

  /**
   * Record the color space an OCIO-managed project assigns this new
   * file (`color.ocio.ocio_input_envelope`).
   *
   * After Effects 2026 writes it for every file it imports under OCIO,
   * beside any profile the file embeds, and marks the media color
   * managed - an Illustrator file too. A source that already holds an
   * OCIO space keeps it: a replace carries its predecessor's. Without the
   * project's config at hand the Adobe-mode record built with the source
   * stays. The records are first cut to the project's file version (see
   * `FootageSource._join_project`).
   */
  _join_project(project: Project): void {
    super._join_project(project);
    if (
      this._clrs == null ||
      project.color_management_system !== ColorManagementSystem.OCIO
    ) {
      return;
    }
    const profile = this._ocsp_profile();
    if (profile != null && profile.is_ocio) return;
    const config = resolve_ocio_config(project.ocio_configuration_file);
    const envelope = config == null ? null : ocio_input_envelope(config, this._file);
    if (envelope == null) {
      // TODO(port): Python passes stacklevel=3 so the warning is attributed to the caller of the public API (warning filename/lineno); pyrt warn(message) has no stacklevel and JS has no Python frames, so only that attribution differs, not the message text.
      warn(
        `OCIO configuration ${repr(project.ocio_configuration_file)} not found ` +
          `or without a default color space: ${new Path(this._file).name} keeps ` +
          "an Adobe color profile",
      );
      return;
    }
    const ipws = find_by_type(this._clrs.chunks, "ipws");
    ipws.value = 0;
    find_by_type(this._clrs.chunks, "apid").data = _UNASSIGNED_PROFILE;
    this._write_ocsp(envelope);
  }

  /** `true` for an imported 3D model scene (e.g. an `.fbx`). */
  get _is_3d_model_scene(): boolean {
    return this._sspc.source_format_type === FORMAT_3D_MODEL_SCENE;
  }

  /**
   * The path of the missing source file when the footage was missing
   * at the time the project was last saved, otherwise an empty string.
   * Read-only.
   */
  get missing_footage_path(): string {
    if (this._sspc.footage_missing_at_save) return this._file;
    return "";
  }

  /**
   * Format-specific metadata extracted from the source file header stored
   * in the project.
   *
   * For PSD (Photoshop) sources, the following keys are available:
   *
   * - `psd_layer_index` (`int`): Zero-based index of this layer within
   *   the PSD file. `0xFFFFFFFF` means merged/flattened.
   * - `psd_group_name` (`str`): PSD group/folder that contains this
   *   layer (e.g. `"PAINT 02"`).
   * - `psd_layer_count` (`int`): Total number of layers in the source
   *   PSD.
   * - `psd_canvas_width` (`int`): Full PSD canvas width in pixels.
   * - `psd_canvas_height` (`int`): Full PSD canvas height in pixels.
   * - `psd_bit_depth` (`int`): Bit depth per channel (8, 16, 32).
   * - `psd_channels` (`int`): Number of color channels (3 for RGB,
   *   4 for RGBA/CMYK).
   * - `psd_layer_top` (`int`): Layer bounding-box top (pixels, can be
   *   negative if the layer extends above the canvas).
   * - `psd_layer_left` (`int`): Layer bounding-box left.
   * - `psd_layer_bottom` (`int`): Layer bounding-box bottom.
   * - `psd_layer_right` (`int`): Layer bounding-box right.
   *
   * Read-only.
   */
  get file_attributes(): Map<string, number | string> {
    return this._file_attributes;
  }

  /**
   * First frame of an image sequence.
   *
   * AE leaves the `sspc` field undefined for some sequences (every
   * pre-2019 file in the fixtures); the number is then the last digit
   * group of the first `StVc` filename (`render.0101.exr` \> 101).
   * Derived on read rather than written back, so a parse/save
   * round-trip stays byte-identical.
   */
  get _start_frame(): number {
    return this._derived_frame(this._sspc.start_frame, 0);
  }

  /** Last frame of an image sequence. See `_start_frame`. */
  get _end_frame(): number {
    return this._derived_frame(this._sspc.end_frame, -1);
  }

  _derived_frame(stored: number, index: number): number {
    if (stored !== UNDEFINED_FRAME || !this._file_names?.length) return stored;
    const match = /(\d+)\D*$/.exec(at(this._file_names, index));
    return match != null ? int(match[1]) : stored;
  }

  constructor(kw: {
    _pin: ListChunk;
    _sspc: SspcChunk;
    _opti: OptiChunk;
    _linl?: U1Chunk | null;
    _clrs?: ListChunk | null;
  }) {
    const { _pin, _sspc, _opti, _linl = null, _clrs = null } = kw;
    super({ _sspc, _linl, _clrs });
    this._pin = _pin;
    this._opti = _opti;

    const pin_chunks = _pin.chunks;

    // Derive file_names from StVc LIST
    const stvc_chunk = find_by_list_type_or_null(pin_chunks, "StVc");
    this._file_names = stvc_chunk === null ? [] : filter_by_type(stvc_chunk.chunks, "Utf8").map((chunk) => chunk.value);

    // Derive file path and target_is_folder from Als2/alas JSON
    const alas_data = parse_alas_data(pin_chunks);
    this._target_is_folder = alas_target_is_folder(alas_data);
    if (this._file_names?.length > 0) {
      this._file = _join_sequence_frame(alas_fullpath(alas_data), this._file_names[0]);
    } else {
      this._file = alas_fullpath(alas_data);
    }

    // Old-format AE files lack the StVc LIST that stores per-frame
    // filenames for image sequences.  Construct the first-frame path
    // from the Utf8 prefix/extension chunks stored before opti.
    if (
      !this._file_names?.length &&
      _sspc.frame_padding > 0 &&
      _sspc.start_frame !== UNDEFINED_FRAME
    ) {
      let utf8_before_opti: Utf8Chunk[];
      try {
        utf8_before_opti = find_chunks_before(pin_chunks, "Utf8", "opti");
      } catch (e) {
        if (!(e instanceof ChunkNotFoundError)) throw e;
        utf8_before_opti = [];
      }
      if (utf8_before_opti.length >= 2) {
        const prefix = utf8_before_opti[utf8_before_opti.length - 2].value;
        const extension = utf8_before_opti[utf8_before_opti.length - 1].value;
        if (prefix || extension) {
          const first_frame =
            `${prefix}${format(_sspc.start_frame, `0${_sspc.frame_padding}d`)}` +
            `${extension}`;
          this._file = _join_sequence_frame(this._file, first_frame);
        }
      }
    }

    if (getattr(_opti, "asset_type", "") === "8BPS") {
      const psd_opti = _opti;
      this._file_attributes = new Map<string, number | string>([
        ["psd_layer_index", psd_opti.psd_layer_index],
        ["psd_group_name", psd_opti.psd_group_name || ""],
        ["psd_layer_count", psd_opti.psd_layer_count],
        ["psd_canvas_width", psd_opti.psd_canvas_width],
        ["psd_canvas_height", psd_opti.psd_canvas_height],
        ["psd_bit_depth", psd_opti.psd_bit_depth],
        ["psd_channels", psd_opti.psd_channels],
        ["psd_layer_top", psd_opti.psd_layer_top],
        ["psd_layer_left", psd_opti.psd_layer_left],
        ["psd_layer_bottom", psd_opti.psd_layer_bottom],
        ["psd_layer_right", psd_opti.psd_layer_right],
      ]);
    } else {
      this._file_attributes = new Map();
    }
  }

  static _new(file: PathLike, kw: NewSourceKw): FileSource {
    /**
     * Create a new file footage source with backing chunks.
     *
     * AE caches all of this metadata in `sspc` and does not re-read the
     * media on open, so the caller must supply correct values (see
     * `resolvers.media_probe`). The `opti` asset-info chunk is left empty;
     * AE locates the file via the `alas` path.
     *
     * @param file - Path to the source file (single), or to a representative frame (sequence; the
     *   containing folder is stored).
     * @param windows - Store the path in the style of AE on Windows rather than macOS (see
     *   `resolvers.platform_paths.platform_path`).
     * @param source_format - 4-char `sspc` source-format code (see `data/file_formats.py`).
     * @param width - Pixel width (0 for audio-only media).
     * @param height - Pixel height (0 for audio-only media).
     * @param duration - Duration in seconds (0 for a still image).
     * @param frame_rate - Native frame rate in fps (0 for stills/audio).
     * @param pixel_aspect - Pixel aspect ratio.
     * @param has_alpha - Whether the footage has an alpha channel.
     * @param depth - Pixel depth AE caches for the footage (see
     *   {@link MediaInfo | MediaInfo.depth}).
     * @param media_flag - Mark the footage the way AE marks its media formats
     *   (`FileFormat.media_flag`): `sspc` 0x70 bit 3, and 0x9F bit 3 for a single file.
     * @param alpha_premultiplied - When `has_alpha`, select PREMULTIPLIED rather than the STRAIGHT
     *   default.
     * @param audio_sample_rate - Audio sample rate in Hz (0 = no audio).
     * @param sequence_prefix - Filename text before the frame number. When not `null`, the source
     *   is an image sequence.
     * @param sequence_ext - Filename extension including the dot (sequence only).
     * @param sequence_files - The frame file names of an alphabetical sequence, in order. When not
     *   `null`, the source is an image sequence listed by name rather than numbered, and
     *   `sequence_prefix`, `sequence_ext`, `start_frame`, `end_frame` and `frame_padding` are not
     *   used.
     * @param start_frame - First frame number (sequence only).
     * @param end_frame - Last frame number (sequence only).
     * @param frame_padding - Zero-padded digit width of the frame number (sequence only).
     * @param opti_data - Raw `opti` asset-info bytes. Empty is accepted by AE for single still
     *   images; sequences and audio need the generic header (see `build_generic_opti_data`).
     * @param embedded_profile_name - Name of the source's embedded color profile, recorded in
     *   `LIST:CLRS` (matching AE). `null` for sources with no embedded profile.
     * @param icc_profile - The ICC profile the media file embeds (see
     *   {@link MediaInfo | MediaInfo.icc_profile}). `null` selects the
     *   profile AE assigns to media that carries none - see `_media_profile_records`.
     * @param full_frame - When `true` (default, every standard import), the footage spans its full
     *   source frame. Set `false` for a layer cropped to its content box (`COMP_CROPPED_LAYERS`, or
     *   a chosen layer imported at Layer Size).
     * @param layer_name - Name of the referenced layer when the source is a single layer of a
     *   layered file; stored in the Pin's `Utf8` slot after `sspc` (empty otherwise, matching AE).
     * @param layer_id - Photoshop layer id for a layer-bound source; `null` keeps the `0xFFFFFFFF`
     *   unbound sentinel.
     * @param layer_index - 0-based document index of the referenced layer; `null` keeps the
     *   `0xFFFFFFFF` unbound sentinel.
     * @param data_size - Cached source data size for `sspc` byte 0xD0 (see `SspcChunk.data_size`);
     *   `0` lets AE re-derive it.
     * @param reserved_c8 - Override for the `sspc` 0xC8 kind bytes. `null` applies the whole-file
     *   rule (see below); layer-bound and merged-PSD sources pass AE's observed per-context value.
     * @param color_mode - The Photoshop colour mode the image reads as (see
     *   `_media_profile_records`); 3 (RGB) by default.
     * @throws {@link ValueError} If `width` or `height` is outside 0-32767 px.
     */
    const {
      source_format,
      width,
      height,
      duration,
      frame_rate,
      pixel_aspect = 1.0,
      has_alpha = false,
      depth = 0,
      media_flag = false,
      alpha_premultiplied = false,
      audio_sample_rate = 0.0,
      sequence_prefix = null,
      sequence_ext = null,
      sequence_files = null,
      start_frame = 0,
      end_frame = 0,
      frame_padding = 0,
      opti_data = b(""),
      embedded_profile_name = null,
      icc_profile = null,
      full_frame = true,
      layer_name = "",
      layer_id = null,
      layer_index = null,
      data_size = 0,
      color_mode = 3,
      windows,
    } = kw;
    let reserved_c8: Uint8Array | null = kw.reserved_c8 ?? null;

    check_footage_size(new Path(file).name, width, height);
    const is_sequence = sequence_prefix != null || sequence_files != null;
    // AE locates footage only by an absolute path (a relative one opens
    // as missing), and its scripts' `new File()` resolves a relative path
    // against the current folder: resolve against the working directory.
    const path = new Path(host.path.resolve(String(file)));

    if (reserved_c8 == null) {
      // AE 2026 writes byte 0xC9 = 0x02 for raster/media file footage but
      // 0x00 for the layers of an Illustrator/PDF composition import
      // (ai_comp.aep, complex_comp.aep); solids/placeholders keep the
      // all-zero default. Verified across the AE-resaved import
      // fixtures. Other sources override this (chosen PSD layer = 0x01,
      // chosen AI layer = 0x02, merged PSD = 0x03, a whole AI/EPS/PDF
      // file = 0x02; choose_layer_*.aep, footage_depth.aep).
      reserved_c8 = source_format === "TEXT" ? b("\x00\x00") : b("\x00\x02");
    }
    const sspc = new SspcChunk({
      source_format_type: source_format,
      width,
      height,
      alpha_mode_raw: _alpha_mode_raw(has_alpha, alpha_premultiplied),
      is_synthetic_a: 0,
      is_synthetic_b: 0,
      is_synthetic_c: 0,
      full_frame,
      reserved_c8,
      data_size,
      depth,
      reserved_40: b("\x01\x01"), // every file source (AE 2026)
    });
    _sync_premultiplied(sspc);
    if (media_flag) {
      sspc.media_format = true;
      sspc.media_file = !is_sequence;
    }
    if (layer_id != null) sspc.layer_id = layer_id;
    if (layer_index != null) sspc.layer_index = layer_index;
    sspc.native_frame_rate = frame_rate;
    sspc.duration = duration;
    sspc.pixel_aspect = pixel_aspect;
    sspc.audio_sample_rate = audio_sample_rate;
    // AE stamps the source's last-modified time and re-reads the media
    // whenever it does not match, taking the dimensions from the format
    // plugin instead of the ones cached here. For an OpenEXR frame whose
    // data window differs from its display window that is a different
    // answer (the plugin reports the data window, AE's importer records
    // the display window), so an unstamped sequence silently changes size
    // when AE opens the project. AE stamps a sequence with its folder.
    sspc.from_file = true;
    // Media that is not on this machine stays unstamped, which is the
    // "re-read me" state AE itself writes for missing footage.
    const stamp_target = is_sequence ? path.parent : path;
    try {
      sspc.source_modified = int(stamp_target.stat().mtimeMs / 1000);
    } catch (e) {
      if (!_is_os_error(e)) throw e;
    }
    if (sequence_files != null) {
      // An alphabetical sequence lists its frames by name (in the Pin's
      // StVc list, below) instead of numbering them. AE 2026 writes the
      // frame numbers undefined, no padding, these flags and a set byte
      // 0x74.
      sspc.start_frame = UNDEFINED_FRAME;
      sspc.end_frame = UNDEFINED_FRAME;
      sspc._reserved_a8 = b("\x00\x00\x00\x01");
      sspc._reserved_b8 = b("\x00");
      sspc._reserved_ba = b("\x00\x00");
      sspc._source_stamp = concat(b("\x01"), bytes_.slice(sspc._source_stamp, 1));
    } else if (is_sequence) {
      sspc.start_frame = start_frame;
      sspc.end_frame = end_frame;
      sspc.frame_padding = frame_padding;
      // AE tags image sequences with these flags; without them it
      // treats the folder reference as missing footage on open.
      // (Values reverse-engineered from AE 2026 sequence imports.)
      // Byte 0xB8 marks zero-padded frame numbers: 0 for p410.png
      // or s1.png ... s12.png, 1 for z_0410.png or frame_001.png.
      sspc._reserved_a8 = b("\x00\x00\x00\x02");
      const zero_padded = str(start_frame).length < frame_padding;
      sspc._reserved_b8 = zero_padded ? b("\x01") : b("\x00");
      sspc._reserved_ba = b("\x01\x01");
    }
    if (is_sequence) {
      _store_frames_over_rate(sspc, round(duration * frame_rate), frame_rate);
    }

    // Route through variant dispatch so a recognized asset type (e.g.
    // 8BPS -> PsdOptiChunk) is stored as its typed subclass and exposes
    // file_attributes immediately, not just after a save/reparse.
    let opti: OptiChunk;
    if (opti_data?.length > 0) {
      opti = OptiChunk.read(new BytesIO(opti_data), opti_data.length, { chunk_type: "opti" });
    } else {
      opti = new OptiChunk({ chunk_type: "opti" });
    }

    const fullpath = platform_path(is_sequence ? String(path.parent) : String(path), {
      windows,
    });
    const path_chunks: Chunk[] = [build_als2_list(fullpath, { target_is_folder: is_sequence })];
    if (sequence_files != null) {
      path_chunks.push(build_stvc_list(sequence_files));
    } else if (is_sequence) {
      path_chunks.push(new Utf8Chunk({ value: sequence_prefix || "" }));
      path_chunks.push(new Utf8Chunk({ value: sequence_ext || "" }));
    }

    const [embedded, assigned] = _media_profile_records(
      icc_profile,
      source_format,
      width > 0,
      width > 0 && duration > 0 && !is_sequence,
      embedded_profile_name,
      color_mode,
    );
    const pin = build_pin_list(sspc, opti, {
      path_chunks,
      embedded_profile_name,
      embedded_profile: embedded,
      assigned_profile: assigned,
      // AE color-manages every file it imports; the ones whose space it
      // only names (a CMYK .ai, a grayscale TIFF...) or does not know
      // (DPX/Cineon) keep the working space, and so does a solid.
      color_managed: embedded_profile_name == null && !_UNPROFILED_FORMATS.has(source_format),
      layer_name,
    });
    const clrs = find_by_list_type(pin.chunks, "CLRS");
    const linl = find_by_type(clrs.chunks, "linl");
    if (_LINEAR_LIGHT_OFF_FORMATS.has(source_format) && width > 0 && !is_sequence) {
      linl.value = int(LinearLightMode.OFF);
    }

    return new this({ _pin: pin, _sspc: sspc, _opti: opti, _linl: linl, _clrs: clrs });
  }

  static _from_file(
    file: PathLike,
    kw: {
      sequence?: boolean;
      force_alphabetical?: boolean;
      windows: boolean;
      default_sequence_fps?: number;
      range_start?: number;
      range_end?: number;
    },
  ): FileSource {
    /**
     * Build a `FileSource` by probing a media file's header.
     *
     * Shared by `Project.import_file`, `FootageItem.replace*`, and
     * `AVItem.set_proxy*`.
     *
     * @param file - Path to the source file, or a representative frame for a sequence.
     * @param sequence - When `true`, import as a numbered image sequence.
     * @param force_alphabetical - For a sequence, order frames alphabetically rather than
     *   numerically.
     * @param windows - Write what AE on Windows writes rather than AE on macOS: the BMP/GIF
     *   importer code, and no alpha for HEIC (see `Project._platform`).
     * @param default_sequence_fps - Frame rate for formats with no native rate (AE's "Import
     *   Options Default Sequence FPS" preference; AE's factory value is 30).
     * @param range_start - First frame number of the sequence clipping range (see
     *   `ImportOptions.range_start`). 0 with `range_end` 0 imports every frame.
     * @param range_end - Last frame number of the clipping range, inclusive.
     * @throws {@link ValueError} If the extension is not a supported footage format (or, with
     *   `sequence`, one AE does not import as a sequence), if the frame range is invalid, or if the
     *   file has no track After Effects can decode (e.g. an AV1-only `.mp4`).
     * @throws {@link NotImplementedError} If After Effects requires a format-specific `opti` header
     *   that is not implemented yet, or header probing is unavailable for the format.
     */
    const {
      sequence = false,
      force_alphabetical = false,
      windows,
      default_sequence_fps = 30.0,
      range_start = 0,
      range_end = 0,
    } = kw;
    validate_file_exists(file);
    const path = new Path(file);
    let fmt = get_file_format(path.suffix);
    if (fmt.opti === "unsupported") {
      throw new NotImplementedError(
        `footage import does not yet support ${path.suffix}: After ` +
          "Effects requires a format-specific opti header that has not " +
          "been reverse-engineered yet.",
      );
    }
    if (sequence && !fmt.sequence) {
      throw new ValueError(
        `After Effects cannot import ${path.suffix} files as an image ` +
          "sequence; import the file on its own.",
      );
    }
    if (sequence) {
      return this._build_sequence(path, fmt, force_alphabetical, default_sequence_fps, {
        windows,
        range_start,
        range_end,
      });
    }
    fmt = _replace(fmt, { source_format: platform_source_format(fmt, { windows }) });
    // An AI/EPS/PDF file is read once for its probe, layers and profile.
    const data = fmt.opti === "text" ? path.read_bytes() : null;
    let info = _platform_media_info(probe_media(path, data), fmt, { windows });
    const opti_data = _opti_data(fmt, info, path, { sequence: false, data });
    // The profile AE records in CLRS: an AI/EPS/PDF page's (embedded when
    // RGB, named otherwise), or the name of a non-RGB TIFF/PSD's.
    let icc: Uint8Array | null;
    let profile_name: string | null;
    if (fmt.opti === "text") {
      [icc, profile_name] = ai_document_profile(path, data);
      info = _replace(info, { icc_profile: icc });
    } else {
      profile_name = named_media_profile(fmt.source_format, info);
    }
    // Merged PSD footage: AE writes kind 0x0003. An AI/EPS/PDF file
    // imported whole takes the file-footage 0x0002 (footage_depth.aep),
    // not the 0x0000 of an Illustrator composition's layers.
    const reserved_c8 = (new Map<string, Uint8Array>([
        ["psd", b("\x00\x03")],
        ["text", b("\x00\x02")],
      ])).get(fmt.opti) ?? null;
    const data_size = _still_data_size(fmt, info, path);
    return this._new(path, {
      source_format: fmt.source_format,
      width: info.width,
      height: info.height,
      duration: info.duration,
      frame_rate: info.frame_rate,
      icc_profile: info.icc_profile,
      pixel_aspect: info.pixel_aspect,
      has_alpha: info.has_alpha,
      depth: info.depth,
      media_flag: fmt.media_flag,
      alpha_premultiplied: fmt.alpha_premultiplied,
      audio_sample_rate: info.audio_sample_rate,
      opti_data,
      embedded_profile_name: profile_name,
      data_size,
      reserved_c8,
      color_mode: info.color_mode,
      windows,
    });
  }

  static _from_layer(
    file: PathLike,
    layer_index: number,
    kw: { dimensions?: string | null; layer_styles?: string | null; windows: boolean },
  ): FileSource {
    /**
     * Build a `FileSource` referencing a single layer of a layered file.
     *
     * Mirrors the "Choose Layer" option of AE's import dialog for
     * `.psd`/`.psb` (layer records) and `.ai`/`.pdf` (PDF Optional Content
     * Groups). Shared by `Project.import_file` (`ImportOptions.layer_index`)
     * and `FootageItem.replace`. Byte-verified against the AE 2026
     * `choose_layer_*.aep` / `ai_choose_layer*.aep` fixtures.
     *
     * @param file - Path to the layered source file.
     * @param layer_index - The layer to reference, as its 0-based position in
     *   `resolvers.source_layers.list_layers` order (top first, leaf layers only).
     * @param dimensions - `"document"` (default) sizes the footage to the full canvas; `"layer"` to
     *   the layer's content box - the PSD layer's (`resolvers.psd_bounds.psd_layer_box`), or the
     *   AI/PDF artwork box measured by `resolvers.ai_bounds.read_ai_layer_bounds`.
     * @param layer_styles - PSD only - the Layer Options choice recorded in the `sspc` kind byte:
     *   `"merge"` (default), `"ignore"`, or `"editable"` (reachable only via replace's
     *   CURRENT_VALUE pass-through). Callers validate; ignored for AI/PDF.
     * @param windows - Store the path in the style of AE on Windows rather than macOS (see `_new`).
     * @throws {@link ValueError} If the file is not a layered format, or `layer_index` is out of
     *   range.
     * @throws {@link NotImplementedError} For a merged PSD layer whose styles' rasterized bounds
     *   are not known (see `resolvers.psd_styles.merged_styles_bounds`).
     * @throws {@link UnsupportedAiLayersError} For `dimensions="layer"` on an AI/PDF file whose
     *   page content py_aep cannot read.
     */
    const { dimensions = null, layer_styles = null, windows } = kw;
    validate_file_exists(file);
    const path = new Path(file);
    const suffix = path.suffix.toLowerCase();
    if (PSD_COMP_EXTENSIONS.has(suffix)) {
      const info = probe_media(path);
      const fmt = get_file_format(suffix);
      const leaf = resolve_psd_layer(path, layer_index);
      const styles = layer_styles == null ? "merge" : layer_styles;
      const footage = psd_layer_footage(info, leaf, styles, read_global_light(path)[0]);
      const [left, top, right, bottom] = footage.box;
      let width: number;
      let height: number;
      if (dimensions === "layer" && right > left && bottom > top) {
        width = right - left;
        height = bottom - top;
      } else {
        // Document Size - and a layer with no content box (an
        // adjustment or fully transparent layer), which keeps the
        // full canvas at Layer Size as in a cropped-comp import (AE
        // 2026 reads py's 0x0 footage back as the canvas).
        width = info.width;
        height = info.height;
      }
      return this._new(path, {
        source_format: fmt.source_format,
        width,
        height,
        duration: info.duration,
        frame_rate: info.frame_rate,
        icc_profile: info.icc_profile,
        pixel_aspect: info.pixel_aspect,
        has_alpha: footage.has_alpha,
        depth: footage.depth,
        alpha_premultiplied: fmt.alpha_premultiplied,
        audio_sample_rate: info.audio_sample_rate,
        opti_data: footage.opti_data,
        full_frame: dimensions !== "layer",
        layer_name: leaf.name,
        layer_id: leaf.layer_id,
        layer_index: leaf.record_index,
        data_size: footage.data_size,
        reserved_c8: getitem(PSD_LAYER_STYLES_C8, styles),
        embedded_profile_name: named_media_profile(fmt.source_format, info),
        color_mode: info.color_mode,
        windows,
      });
    }
    if (AI_COMP_EXTENSIONS.has(suffix)) {
      const data = path.read_bytes();
      const info = probe_media(path, data);
      const fmt = get_file_format(suffix);
      const [ai_layers, index] = resolve_ai_layer(path, layer_index, data);
      const ai_layer = at(ai_layers, index);
      const [icc, profile_name] = ai_document_profile(path, data);
      let artwork_bounds: Box | null = null;
      let width = info.width;
      let height = info.height;
      if (dimensions === "layer") {
        // The artwork box is the whole binding for a Layer Size
        // import: After Effects derives the footage pixel size from
        // it and does not recompute it on open.
        const bounds = at(read_ai_layer_bounds(path, data), index);
        artwork_bounds = bounds == null ? EMPTY_BOX : bounds;
        [width, height] = footage_size(bounds);
      }
      const opti_data = build_ai_layer_opti_data(
        info.width,
        info.height,
        ai_layer.name,
        ai_layers.length,
        artwork_bounds,
        ai_layer.visible,
      );
      return this._new(path, {
        source_format: fmt.source_format,
        width,
        height,
        duration: info.duration,
        frame_rate: info.frame_rate,
        icc_profile: icc,
        pixel_aspect: info.pixel_aspect,
        has_alpha: info.has_alpha,
        depth: info.depth,
        alpha_premultiplied: fmt.alpha_premultiplied,
        audio_sample_rate: info.audio_sample_rate,
        opti_data,
        embedded_profile_name: profile_name,
        full_frame: dimensions !== "layer",
        layer_name: ai_layer.name,
        layer_index: index,
        data_size: data.length,
        reserved_c8: b("\x00\x02"),
        windows,
      });
    }
    throw new ValueError(`layer_index requires a layered .psd/.psb/.ai/.pdf file, got ${repr(suffix)}`);
  }

  static _build_sequence(
    file: Path,
    fmt: FileFormat,
    force_alphabetical: boolean,
    default_frame_rate: number,
    kw: { windows: boolean; range_start?: number; range_end?: number },
  ): FileSource {
    /**
     * Build a sequence `FileSource` by scanning sibling frames.
     *
     * With a frame range set, frames are filtered to numbers in
     * `[range_start, range_end]` (inclusive) and the stored
     * `start_frame`/`end_frame` bounds are the RANGE bounds even when
     * files are missing inside or beyond it - AE treats absent frames as
     * implied placeholders and encodes nothing else (verified against
     * AE 2026 range-import fixtures, including interior gaps).
     *
     * `force_alphabetical` takes every file of the same type in the
     * folder, numbered or not, in case-insensitive name order - AE 2026
     * gathers `a_001.png`, `b.png`, `D.PNG`, `n_10.png`, `n_2.png` from a
     * folder that also holds `x.jpg` and a subfolder.
     */
    const { windows, range_start = 0, range_end = 0 } = kw;
    validate_bool(force_alphabetical);
    if (!(0 < default_frame_rate && default_frame_rate <= 999)) {
      // The "Import Options Default Sequence FPS" preference; outside
      // the conform-rate range it cannot time a sequence (0 divided
      // by zero below).
      throw new ValueError(`invalid default sequence frame rate ${repr(default_frame_rate)}`);
    }
    const m = _FRAME_NUMBER_RE.exec(file.stem);
    if (m == null && !force_alphabetical) {
      throw new ValueError(`Sequence import requires a numbered filename, got ${repr(file.name)}`);
    }

    const has_range = range_start > 0 || range_end > 0;
    if (has_range && range_end === 0) {
      // AE errors at import time ("Found no matches for the selected
      // file name") when a start is set without an end.
      throw new ValueError("a sequence range start requires a range end");
    }
    if (has_range && range_end < range_start) {
      throw new ValueError("Range end cannot be less than range start");
    }

    // BMP/GIF sequences take the target platform's importer code. AE
    // refuses the other one (see GENERIC_STILL_FORMATS).
    fmt = _replace(fmt, { source_format: platform_source_format(fmt, { windows }) });

    let file_names: string[] | null = null;
    let prefix: string | null = null;
    let ext: string | null = null;
    let frames: [number, string, number, string][] = [];
    let first_frame: string;
    let start_frame: number;
    let end_frame: number;
    let padding: number;
    if (m == null || force_alphabetical) {
      const suffix = file.suffix.toLowerCase();
      // scandir's entries know their type, and the cheap name test runs
      // first: no stat per file of a large frame folder.
      file_names = sorted(
        host.fs
          .readdirSync(file.parent.path)
          .filter(
            (name) =>
              _splitext_ext(name).toLowerCase() === suffix && file.parent.div(name).is_file(),
          ),
        (name: string) => name.toLowerCase(),
      );
      first_frame = at(file_names, 0);
      start_frame = end_frame = UNDEFINED_FRAME;
      padding = 0;
    } else {
      prefix = file.stem.slice(0, m.index);
      ext = file.suffix;
      const ext_key = ext.toLowerCase();
      const prefix_key = prefix.toLowerCase();
      // (number, name, digit count, own prefix)
      for (const sibling of file.parent.iterdir()) {
        if (sibling.suffix.toLowerCase() !== ext_key) continue;
        // Each file splits into its own prefix and frame number, and
        // the prefixes compare case-insensitively: AE 2026 (Windows)
        // gathers F_001.png and f_002.png into `F_[001-002].png`.
        const stem = sibling.stem;
        const sm = _FRAME_NUMBER_RE.exec(stem);
        if (sm != null && stem.slice(0, sm.index).toLowerCase() === prefix_key) {
          frames.push([int(sm[1]), sibling.name, sm[1].length, stem.slice(0, sm.index)]);
        }
      }
      if (!frames?.length) {
        frames = [[int(m[1]), file.name, m[1].length, prefix]];
      }

      if (has_range) {
        frames = frames.filter((fr) => range_start <= fr[0] && fr[0] <= range_end);
        if (!frames?.length) {
          throw new ValueError(
            `no sequence frames numbered within [${range_start}, ` + `${range_end}]`,
          );
        }
      }

      frames.splice(0, frames.length, ...sorted(frames));
      // The padding is the first frame's digit count, whichever frame
      // was picked: AE 2026 names s1.png ... s12.png `s[1-12].png`
      // even from s12.png. The sequence is named after the first
      // frame's own prefix (the case can differ from the picked file's:
      // `F_[001-002].png`).
      [, first_frame, padding, prefix] = frames[0];
      if (has_range) {
        start_frame = range_start;
        end_frame = range_end;
      } else {
        start_frame = frames[0][0];
        end_frame = frames[frames.length - 1][0];
      }
    }

    const file_count = file_names != null ? file_names.length : frames.length;
    const first_path = file.parent.div(first_frame);
    const info = probe_media(first_path);
    const frame_rate = py_or(info.frame_rate, default_frame_rate);
    let duration: number;
    if (info.duration !== 0) {
      // A first frame with a timeline of its own (an animated GIF) sets
      // the sequence's rate and duration: AE 2026 imports two 14-frame
      // 10 fps GIFs as one 1.4 s sequence at 10 fps.
      duration = info.duration;
    } else if (file_names != null) {
      duration = file_names.length / frame_rate;
    } else {
      // Frame-number span, not file count: AE counts absent interior
      // frames as implied placeholders (probed: a 1-12 sequence with
      // frames 6-7 missing imports with a 12-frame duration).
      duration = (end_frame - start_frame + 1) / frame_rate;
    }

    const source = this._new(file, {
      source_format: fmt.source_format,
      width: info.width,
      height: info.height,
      duration,
      frame_rate,
      pixel_aspect: info.pixel_aspect,
      has_alpha: info.has_alpha,
      depth: info.depth,
      media_flag: fmt.media_flag,
      alpha_premultiplied: fmt.alpha_premultiplied,
      audio_sample_rate: 0.0,
      icc_profile: info.icc_profile,
      sequence_prefix: prefix,
      sequence_ext: ext,
      sequence_files: file_names,
      start_frame,
      end_frame,
      frame_padding: padding,
      opti_data: _opti_data(fmt, info, first_path, { sequence: true }),
      // AE caches the first frame's size times the file count, however
      // large the others are (a 4928-byte first GIF in three files is
      // 14784), on macOS and Windows alike.
      data_size: file_count * first_path.stat().size,
      embedded_profile_name: named_media_profile(fmt.source_format, info),
      color_mode: info.color_mode,
      windows,
    });
    source._rate_from_media = info.duration !== 0;
    if (has_range) {
      source._sspc.frame_range_set = true;
    }
    return source;
  }

  /**
   * Reloads the asset from the file.
   *
   * Re-reads the media at the stored path and updates the cached
   * source metadata in place - dimensions, alpha, frame rate,
   * duration, pixel aspect, audio, cached data size, the format
   * `opti` header and (for AI/EPS/PDF) the embedded color-profile
   * record - like After Effects' File \> Reload Footage (byte-validated
   * against an AE 2026 reload of a still image whose file changed on
   * disk). Image sequences re-scan their sibling frames; the item name
   * is never changed. A source bound to one layer of a layered file
   * re-measures that layer and keeps its binding, Document/Layer Size
   * choice and Layer Options, as After Effects does.
   *
   * **Note:** ExtendScript restricts `reload()` to a `mainSource`; py_aep
   * also allows it on a `proxySource`. Every chunk it refreshes
   * (`sspc`, `opti`, `CLRS`) lives in the source's own `Pin`, so a
   * proxy reload is self-contained. The owning item's `idta`
   * footage-kind flags are only refreshed for a `mainSource` -
   * they describe the main source's kind, and AE keeps them
   * pointing at it while a proxy is attached.
   *
   * @throws {@link ValueError} If the stored path no longer exists or is no longer a file, if its
   *   extension is not a supported footage format, or if a layer-bound source's file no longer has
   *   a layer at the stored index.
   * @throws {@link NotImplementedError} If the format needs a format-specific `opti` header that is
   *   not implemented.
   */
  reload(): void {
    let owner: FootageItem | null = null;
    if (this._project != null) {
      for (const item of this._project.footages) {
        if (item._main_source === this) {
          owner = item;
          break;
        }
      }
    }

    // A path stored for the other platform is read where AE on this one
    // looks for it (`/Users/x` -> `C:\Users\x`).
    const host_file = platform_path(this._file, { windows: host.platform === "win32" });
    validate_file_exists(host_file);
    const path = new Path(host_file);
    let fmt = get_file_format(path.suffix);
    if (fmt.opti === "unsupported") {
      throw new NotImplementedError(
        `footage reload does not support ${path.suffix}: After ` +
          "Effects requires a format-specific opti header that has " +
          "not been reverse-engineered yet.",
      );
    }

    const sspc = this._sspc;
    // AE keeps the source's importer across a reload: the rebuilt `opti`
    // names the stored code (a BMP imported on Windows stays `STIL`).
    fmt = _replace(fmt, { source_format: sspc.source_format_type });
    if (this._target_is_folder) {
      // Sequence: re-scan sibling frames. The stored native rate is
      // kept as the fallback for rate-less formats (reload does not
      // consult the import preferences).
      //
      // A user-set frame range must survive the re-scan: without it
      // the rebuild would widen the sequence to every sibling frame
      // while the marker still claimed a range. The range bounds are
      // the stored start/end frames.
      const range_start = sspc.frame_range_set ? this._start_frame : 0;
      const range_end = sspc.frame_range_set ? this._end_frame : 0;
      const alphabetical = this._is_alphabetical;
      const fresh = FileSource._build_sequence(
        path,
        fmt,
        alphabetical,
        py_or(sspc.native_frame_rate, 30.0),
        { windows: this._windows, range_start, range_end },
      );
      // The duration as frames over rate, unreduced, as the import writes
      // it (the float setter would store 3/30 as 1/10).
      this._adopt_measured(
        fresh,
        "start_frame",
        "end_frame",
        "frame_padding",
        "native_frame_rate",
        "duration_dividend",
        "duration_divisor",
      );
      if (alphabetical) {
        // An alphabetical sequence re-lists its folder by name.
        const stvc = find_by_list_type(this._pin.chunks, "StVc");
        const index = index_by_identity(this._pin.chunks, stvc);
        this._pin.chunks[index] = find_by_list_type(fresh._pin.chunks, "StVc");
        this._file_names = fresh._file_names;
        this._file = fresh._file;
      }
    } else if (this.layer_name) {
      // A single layer of a layered file: re-measure that layer, not the
      // merged document. AE 2026 keeps the binding, its Document/Layer
      // Size choice and its Layer Options across a reload (cropped PSD
      // and AI comp layers keep their names and sizes - ae1 probe). The
      // stored index is rebound the way `replace(..., CURRENT_VALUE)`
      // does, and everything is measured before anything is written.
      const fresh = FileSource._from_layer(
        path,
        layer_index_for_stored(path, sspc.layer_index),
        {
          dimensions: sspc.full_frame ? null : "layer",
          layer_styles: this.layer_styles,
          windows: this._windows,
        },
      );
      this._adopt_measured(fresh, "pixel_aspect", "layer_id");
    } else {
      const data = fmt.opti === "text" ? path.read_bytes() : null;
      const info = _platform_media_info(probe_media(path, data), fmt, {
        windows: this._windows,
      });
      sspc.width = info.width;
      sspc.height = info.height;
      sspc.depth = info.depth;
      sspc.alpha_mode_raw = _alpha_mode_raw(info.has_alpha, fmt.alpha_premultiplied);
      sspc.native_frame_rate = info.frame_rate;
      sspc.duration = info.duration;
      sspc.pixel_aspect = info.pixel_aspect;
      sspc.audio_sample_rate = info.audio_sample_rate;
      // AE refreshes the cached source size (probed on a PNG: the file
      // size, 3614 -> 223874 across the reload fixture pair).
      sspc.data_size = _still_data_size(fmt, info, path);
      const opti_data = _opti_data(fmt, info, path, { sequence: false, data });
      let new_opti: OptiChunk;
      if (opti_data?.length > 0) {
        new_opti = OptiChunk.read(new BytesIO(opti_data), opti_data.length, { chunk_type: "opti" });
      } else {
        new_opti = new OptiChunk({ chunk_type: "opti" });
      }
      this._swap_opti(new_opti);
      // AE 2026 restamps the source with the file's current mtime on a
      // reload; a stale stamp makes it re-read the media at every open.
      sspc.source_modified = int(path.stat().mtimeMs / 1000);
      // Only AI/EPS/PDF carry a re-readable embedded profile. Other
      // formats keep the record they already have: AE writes `empd`
      // for PNG/MOV/MPEG too, and a reload that only re-reads the
      // same pixels must not erase it.
      if (fmt.opti === "text") {
        this._update_embedded_profile(ai_document_profile(path, data)[1]);
      }
    }
    _sync_premultiplied(sspc);

    const idta = getattr(owner, "_idta", null);
    if (owner != null && idta != null) {
      idta._flags_17 = this._idta_flags17();
      // AE 2026 restamps the item with the reloaded file's mtime too.
      owner._sync_modified_time();
    }
  }

  /** Replace the pin's `opti` chunk (and this source's reference). */
  _swap_opti(new_opti: OptiChunk): void {
    const index = index_by_identity(this._pin.chunks, this._opti);
    this._pin.chunks[index] = new_opti;
    this._opti = new_opti;
  }

  /**
   * Take a reloaded source's measurements from `fresh`, the same file
   * measured again: its `opti`, and the `sspc` size, depth, alpha, data
   * size and source stamp (the file's new mtime: AE 2026 restamps the
   * source on reload), plus `fields`.
   */
  _adopt_measured(fresh: FileSource, ...fields: string[]): void {
    const sspc = this._sspc;
    const fresh_sspc = fresh._sspc;
    for (const name of ["width", "height", "depth", "alpha_mode_raw", ...fields]) {
      setattr(sspc, name, getattr(fresh_sspc, name));
    }
    sspc.data_size = fresh_sspc.data_size;
    sspc._source_stamp = fresh_sspc._source_stamp;
    this._swap_opti(fresh._opti);
  }

  /**
   * Set, update or remove the CLRS embedded-profile record (`empd`
   * flag + `Utf8` profile name, in AE's slot right after `apid`).
   */
  _update_embedded_profile(name: string | null): void {
    if (this._clrs == null) return;
    const chunks = this._clrs.chunks;
    for (const [index, chunk] of chunks.entries()) {
      if (chunk.chunk_type === "empd") {
        if (name == null) {
          chunks.splice(index, 2);
        } else {
          (at(chunks, index + 1) as Utf8Chunk).value = name;
        }
        return;
      }
    }
    if (name != null) {
      const apid_index = chunks.findIndex((ch) => ch.chunk_type === "apid");
      const insert_at = apid_index >= 0 ? apid_index + 1 : 0;
      chunks.splice(insert_at, 0, new Utf8Chunk({ value: name }));
      chunks.splice(insert_at, 0, new EmpdChunk());
    }
  }

  /**
   * Footage-kind flags for `IdtaChunk._flags_17`: bit 5 = has video,
   * bit 4 = single still image, bit 2 = has audio. AE rejects an
   * audio-only (0x0) file flagged as video, so this is set from the
   * source's actual kind.
   */
  _idta_flags17(): number {
    let flags = 0;
    if (this._width > 0) flags |= 0x20;
    if (this.is_still) flags |= 0x10;
    if (this._has_audio) flags |= 0x04;
    return flags;
  }

  /**
   * The referenced layer's name when this source is a single layer
   * of a layered file (a chosen-layer import or a member of a layered
   * comp import), or an empty string for merged/whole-file footage.
   * Read-only.
   *
   * py_aep extension: ExtendScript exposes no layer-selection API.
   */
  get layer_name(): string {
    const psd_layer = getattr(this._opti, "psd_group_name", "");
    if (py_bool(psd_layer)) return str(psd_layer);
    // AI/EPS/PDF: a `TEXT` opti carries the layer name as a typed
    // `TextOptiChunk` field (0x44). The name alone marks the binding -
    // the 0x3D byte next to it is the layer's visibility, and AE writes
    // it 0 for a hidden layer's (still layer-bound) footage.
    const opti = this._opti;
    if (opti instanceof TextOptiChunk) return opti.text_layer_name;
    return "";
  }

  /**
   * The layer-styles choice recorded for a Photoshop single-layer
   * binding: `"editable"`, `"merge"` or `"ignore"` (see
   * `ImportOptions.layer_styles`), or `null` when this source is not a
   * PSD single-layer binding (merged/whole-document footage, other
   * formats). Read-only.
   *
   * py_aep extension. `"editable"` appears on the per-layer footage of
   * an Editable-Layer-Styles comp import; `FootageItem.replace` rejects
   * it as an explicit argument (AE's footage dialog offers merge/ignore
   * only) - `CURRENT_VALUE` is the way to preserve it. The byte encoding
   * was pinned on AE 2026 output; on much older projects the reported
   * value is whatever the byte says.
   */
  get layer_styles(): string | null {
    if (this._sspc.source_format_type !== "8BPS" || !this.layer_name) return null;
    return _C9_TO_LAYER_STYLES.get(this._sspc._reserved_c8[1]) ?? null;
  }

  /**
   * Resolve the display name for a file-type footage item.
   *
   * AE writes the item-level Utf8 chunk only when the user renames the
   * item, and then displays that name verbatim - including a name holding
   * a `/`, and including the ` 2` suffix AE appends to disambiguate two
   * imports of the same layer. An empty chunk means the name is derived
   * from the source: a sequence pattern (e.g. `render.[0001-0700].exr`),
   * `layername/filename` for a layer-bound source, else the filename.
   */
  _resolve_name(raw_name: string): string {
    let item_name = raw_name;

    if (!item_name) {
      if (this._duration !== 0 && this._target_is_folder) {
        item_name = this._build_sequence_name();
      }
      if (!item_name) {
        // PureWindowsPath handles both / and \ separators,
        // unlike PurePosixPath which only splits on /.
        const basename = new PureWindowsPath(this._file).name;
        const layer = this.layer_name;
        if (layer) {
          item_name = `${layer}/${basename}`;
        } else {
          item_name = basename;
        }
      }
    }

    return item_name;
  }

  /**
   * Build the display name for an image sequence.
   *
   * Returns the pattern `prefix[start_frame-end_frame]extension`,
   * for example `render.[0001-0700].exr`. The prefix and extension are
   * stored as two consecutive Utf8 chunks immediately before the opti
   * chunk inside the Pin LIST. An alphabetical sequence is named after
   * its folder instead, as AE 2026 does.
   */
  _build_sequence_name(): string {
    if (this._is_alphabetical) return new PureWindowsPath(this._file).parent.name;
    const start_frame = this._start_frame;
    const end_frame = this._end_frame;
    if (start_frame === UNDEFINED_FRAME || end_frame === UNDEFINED_FRAME) return "";

    let utf8_before_opti: Utf8Chunk[];
    try {
      utf8_before_opti = find_chunks_before(this._pin.chunks, "Utf8", "opti");
    } catch (e) {
      if (!(e instanceof ChunkNotFoundError)) throw e;
      utf8_before_opti = [];
    }

    if (utf8_before_opti.length < 2) return "";

    const prefix = utf8_before_opti[utf8_before_opti.length - 2].value;
    const extension = utf8_before_opti[utf8_before_opti.length - 1].value;

    if (!prefix && !extension) return "";

    const frame_padding = this._sspc.frame_padding;
    const frame_range =
      `[${format(start_frame, `0${frame_padding}d`)}` +
      `-${format(end_frame, `0${frame_padding}d`)}]`;
    return `${prefix}${frame_range}${extension}`;
  }
}
