/**
 * Footage file-format table: extension -\> AE source-format code and defaults.
 *
 * Derived empirically by importing `samples/assets/` in AE 2026 and decoding the
 * resulting `sspc` chunks (see the `filesource-aep-format` notes). `sourceFormat`
 * is the 4-char code stored in `SspcChunk.source_format_type`.
 */

import { ValueError, repr } from "../../pyrt/index.ts";
import { ImportAsType } from "../enums/index.ts";

/** Static per-format defaults for footage import. */
export class FileFormat {
  /** 4-char `sspc.source_format_type` code (e.g. `png!`, `oEXR`). */
  readonly sourceFormat: string;

  /** When the footage has alpha, `true` selects PREMULTIPLIED, else STRAIGHT. */
  readonly alphaPremultiplied: boolean;

  /**
   * `opti` asset-info strategy, verified against AE 2026:
   *
   * - `"empty"`: AE re-reads the located file (FBX); an empty `opti` works.
   * - `"exr"`: AE needs the `oEXR` header (see `build_exr_opti_data`) to
   *   place an EXR's data window.
   * - `"generic"`: AE's generic media importer needs the 58-byte `opti` header
   *   (PNG, JPEG, TGA, MOV, WAV, HEIC). AE opens a PNG still with an empty
   *   `opti` but crashes as soon as it renders it.
   * - `"tiff"`: AE needs the 602-byte TIFF-specific header (see
   *   `build_tiff_opti_data`).
   * - `"psd"`: the 602-byte Photoshop header AE writes for the merged
   *   document (see `build_psd_opti_data`).
   * - `"text"`: the 596-byte Illustrator/PDF/EPS header (see
   *   `build_ai_document_opti_data` and `build_text_opti_data`).
   * - `"dpx"`: AE needs the 48-byte DPX/Cineon format-options header (see
   *   `build_dpx_opti_data`).
   * - `"unsupported"`: AE requires a format-specific `opti` not yet
   *   reverse-engineered; import is refused rather than crashing AE.
   */
  readonly opti: string;

  /**
   * `false` for formats AE 2026 refuses to import as an image sequence
   * ("files of type ... cannot be used as sequences"): movies, audio, HEIC,
   * 3D scenes and data files.
   */
  readonly sequence: boolean;

  /**
   * `true` for the formats whose footage AE 2026's import marks in `sspc`
   * (`SspcChunk.media_format`, and `media_file` for a single file): JPEG,
   * BMP/GIF, HEIC, movies, audio and data files.
   */
  readonly mediaFlag: boolean;

  constructor(
    sourceFormat: string,
    alphaPremultiplied: boolean,
    opti: string,
    sequence: boolean = true,
    mediaFlag: boolean = false,
  ) {
    this.sourceFormat = sourceFormat;
    this.alphaPremultiplied = alphaPremultiplied;
    this.opti = opti;
    this.sequence = sequence;
    this.mediaFlag = mediaFlag;
  }

  *[Symbol.iterator]() {
    yield this.sourceFormat;
    yield this.alphaPremultiplied;
    yield this.opti;
    yield this.sequence;
    yield this.mediaFlag;
  }
}

/** `sspc.source_format_type` of a 3D model scene (`.fbx`). */
export const FORMAT_3D_MODEL_SCENE = "LDOM";

/**
 * BMP/GIF have no dedicated importer; AE tags them with the platform's
 * generic still importer: AE 2026 macOS writes IMIO, Windows STIL, for
 * stills and sequences alike (imio_*.aep vs media_replacement.aep
 * fixtures, plus a Windows import of bmp.bmp/gif.gif). An IMIO still opens
 * on either platform, but an IMIO sequence never opens on Windows and a
 * STIL sequence never opens on macOS.
 */
export const GENERIC_STILL_FORMATS = { macos: "IMIO", windows: "STIL" } as const;

/**
 * The `sspc` code AE on the target platform writes for `fmt`.
 *
 * @param fmt - The file's format (a still or a sequence frame).
 * @param kw - Keyword arguments:
 * - `windows`: `true` to tag the source for AE on Windows (see `GENERIC_STILL_FORMATS`).
 */
export function platformSourceFormat(fmt: FileFormat, kw: { windows: boolean }): string {
  const { windows } = kw;
  if (windows && fmt.sourceFormat === GENERIC_STILL_FORMATS["macos"]) {
    return GENERIC_STILL_FORMATS["windows"];
  }
  return fmt.sourceFormat;
}

export const _FILE_FORMATS: Map<string, FileFormat> = new Map<string, FileFormat>([
  [".exr", new FileFormat("oEXR", true, "exr")],
  [".mov", new FileFormat("MOoV", false, "generic", false, true)],
  [".m4v", new FileFormat("MOoV", false, "generic", false, true)],
  // AE 2026 imports .mp4 through its Media Core importer, which stamps
  // "XCEX" rather than the QuickTime family's "MOoV" (older AE releases
  // wrote "MPEG"/"MOoV" for the same files).
  [".mp4", new FileFormat("XCEX", false, "generic", false, true)],
  [".aiff", new FileFormat("AIFC", false, "generic", false, true)],
  // AIFF alias; verified: AE 2026 imports aif.aif as AIFC footage
  // (media_gap_formats.aep fixture).
  [".aif", new FileFormat("AIFC", false, "generic", false, true)],
  [".wav", new FileFormat("WAVE", false, "generic", false, true)],
  [".png", new FileFormat("png!", false, "generic")],
  [".tif", new FileFormat("TIF ", false, "tiff")],
  [".tiff", new FileFormat("TIF ", false, "tiff")],
  // DPX and Cineon still frames and sequences; verified: AE 2026 imports
  // both as sDPX footage with a 48-byte format-options header
  // (media_gap_formats.aep fixture).
  [".dpx", new FileFormat("sDPX", false, "dpx")],
  [".cin", new FileFormat("sDPX", false, "dpx")],
  [".heic", new FileFormat("AIDE", false, "generic", false, true)],
  [".heif", new FileFormat("AIDE", false, "generic", false, true)],
  [".jpg", new FileFormat("ZPEG", false, "generic", true, true)],
  [".jpeg", new FileFormat("ZPEG", false, "generic", true, true)],
  [".tga", new FileFormat("TPIC", false, "generic")],
  // Platform-specific generic still importer; see GENERIC_STILL_FORMATS.
  [".bmp", new FileFormat(GENERIC_STILL_FORMATS["macos"], false, "generic", true, true)],
  [".gif", new FileFormat(GENERIC_STILL_FORMATS["macos"], false, "generic", true, true)],
  [".psd", new FileFormat("8BPS", false, "psd")],
  [".psb", new FileFormat("8BPS", false, "psd")],
  // Video/audio containers (generic opti; codec bytes re-derived by AE).
  [".m4a", new FileFormat("MOoV", false, "generic", false, true)],
  [".mp3", new FileFormat("MP3A", false, "generic", false, true)],
  // AAC in an ADTS stream (audio only); source code confirmed against an
  // AE 2026 import of samples/assets/aac.aac.
  [".aac", new FileFormat("MPEG", false, "generic", false, true)],
  [".swf", new FileFormat("SWF ", false, "generic", false, true)],
  [".mpeg", new FileFormat("MPEO", false, "generic", false, true)],
  [".mpg", new FileFormat("MPEO", false, "generic", false, true)],
  // Motion-graphics data stream (duration from the sampled time range).
  [".mgjson", new FileFormat("sjgm", false, "generic", false, true)],
  // 3D scene - empty opti; AE re-reads the scene and uses default render dims.
  [".fbx", new FileFormat(FORMAT_3D_MODEL_SCENE, false, "empty", false)],
  // Data footage - 0x0 items; a reversed code: "nosj" for json, and for
  // txt / csv the tab- / comma-separated-values importer's NUL-led
  // "\0vst" / "\0vsc" (AE 2026 import; it reads back as "" - the text
  // before the NUL).
  [".txt", new FileFormat("\x00vst", false, "generic", false, true)],
  [".csv", new FileFormat("\x00vsc", false, "generic", false, true)],
  [".json", new FileFormat("nosj", false, "generic", false, true)],
  [".wmv", new FileFormat("WMED", false, "generic", false, true)],
  // Radiance HDR - format-specific 30-byte opti.
  [".hdr", new FileFormat("RHDR", false, "hdr")],
  // Canon CRW, developed by Camera Raw - format-specific 30-byte opti.
  [".crw", new FileFormat("Craw", false, "craw")],
  // Vector / PostScript / PDF - shared 596-byte TEXT opti.
  [".ai", new FileFormat("TEXT", false, "text")],
  [".eps", new FileFormat("TEXT", false, "text")],
  [".pdf", new FileFormat("TEXT", false, "text")],
]);

// Formats AE imports as footage but py-aep does NOT support, with reasons:
//   .c4d  -> "C4DC" - AE accepts the generic opti (it rebuilds its own on
//            save), but the footage size, frame rate and duration come from the
//            scene's render settings and document timeline, which need a Cinema
//            4D scene parser
//   .nef  -> "Craw" - Camera Raw develops it at a per-camera crop the file
//            does not record (a Nikon D1's 2012x1324 sensor opens 2000x1312)
// AE refuses .avi (codec), .flv/.ps (invalid type) on import. .ma imports
// only as a cropped comp (not footage) - a separate comp-conversion feature.

// Which `ImportAsType` values `ImportOptions.canImportAs()` accepts per
// extension. Values for the asset extensions present in `samples/assets/` were
// measured empirically in AE 2026 via `scripts/jsx/can_import_as_matrix.jsx`
// (the matrix lives at `scripts/jsx/can_import_as_matrix.json`). Note the
// non-obvious cases that the empirical run surfaced:
//   - FOOTAGE is NOT universal: `.svg` and `.aep` reject it.
//   - COMP and COMP_CROPPED_LAYERS differ: `.exr`/`.svg` allow the cropped
//     variant but not plain COMP.
//   - `.mov` accepts PROJECT (a QuickTime file may carry an AE project).
// Extensions not in `samples/assets/` (`.ai`, `.pdf`, `.aet`, `.jpeg`, `.tiff`)
// follow documented AE behavior / format aliases and are marked below.
export const _FOOTAGE = ImportAsType.FOOTAGE;
export const _COMP = ImportAsType.COMP;
export const _CROPPED = ImportAsType.COMP_CROPPED_LAYERS;
export const _PROJECT = ImportAsType.PROJECT;

export const _IMPORT_AS_TYPES: Map<string, ReadonlySet<ImportAsType>> = new Map<
  string,
  ReadonlySet<ImportAsType>
>([
  // Layered Photoshop - footage, comp, or comp-cropped.
  [".psd", new Set([_FOOTAGE, _COMP, _CROPPED])],
  [".psb", new Set([_FOOTAGE, _COMP, _CROPPED])],
  // Vector / PostScript / PDF - footage, comp, or comp-cropped (AE-measured).
  [".ai", new Set([_FOOTAGE, _COMP, _CROPPED])],
  [".eps", new Set([_FOOTAGE, _COMP, _CROPPED])],
  [".pdf", new Set([_FOOTAGE, _COMP, _CROPPED])],
  // Multi-channel EXR - footage or comp-cropped, but not plain comp.
  [".exr", new Set([_FOOTAGE, _CROPPED])],
  // SVG - comp-cropped only; cannot import as plain footage.
  [".svg", new Set([_CROPPED])],
  // Still images - footage only.
  [".png", new Set([_FOOTAGE])],
  [".jpg", new Set([_FOOTAGE])],
  [".jpeg", new Set([_FOOTAGE])], // alias of .jpg
  [".tif", new Set([_FOOTAGE])],
  [".tiff", new Set([_FOOTAGE])], // alias of .tif
  [".dpx", new Set([_FOOTAGE])],
  [".cin", new Set([_FOOTAGE])],
  [".heic", new Set([_FOOTAGE])],
  [".heif", new Set([_FOOTAGE])],
  [".tga", new Set([_FOOTAGE])],
  [".bmp", new Set([_FOOTAGE])],
  [".gif", new Set([_FOOTAGE])],
  [".hdr", new Set([_FOOTAGE])],
  [".crw", new Set([_FOOTAGE])],
  // Video - footage or project.
  [".mov", new Set([_FOOTAGE, _PROJECT])],
  [".m4v", new Set([_FOOTAGE])],
  [".mp4", new Set([_FOOTAGE])],
  [".wmv", new Set([_FOOTAGE])],
  // Audio - footage only (m4a may also carry an AE project).
  [".aiff", new Set([_FOOTAGE])],
  [".aif", new Set([_FOOTAGE])],
  [".wav", new Set([_FOOTAGE])],
  [".m4a", new Set([_FOOTAGE, _PROJECT])],
  // AE still reports these importable as footage.
  [".fbx", new Set([_FOOTAGE])],
  [".txt", new Set([_FOOTAGE])],
  [".csv", new Set([_FOOTAGE])],
  [".json", new Set([_FOOTAGE])],
  [".mgjson", new Set([_FOOTAGE])],
  [".mp3", new Set([_FOOTAGE])],
  [".aac", new Set([_FOOTAGE])],
  [".swf", new Set([_FOOTAGE])],
  [".mpeg", new Set([_FOOTAGE])],
  [".mpg", new Set([_FOOTAGE])],
  // Project / template - project only (.aet not in samples/assets).
  [".aep", new Set([_PROJECT])],
  [".aet", new Set([_PROJECT])],
]);

// Extensions imported by converting the file directly into a composition
// (no FileSource/footage item), so they are absent from `_FILE_FORMATS` yet
// are still importable. `can_import_as` gates these on `_IMPORT_AS_TYPES`
// alone (no media-format lookup).
export const COMP_CONVERSION_EXTENSIONS: ReadonlySet<string> = new Set<string>([".svg"]);

// Layered formats AE imports as a composition of per-layer footage. Illustrator
// /PDF layers are PDF Optional Content Groups (see resolvers.ai_layers);
// Photoshop layers come from the file's layer records (see resolvers.psd_layers).
export const AI_COMP_EXTENSIONS: ReadonlySet<string> = new Set<string>([".ai", ".pdf"]);
export const PSD_COMP_EXTENSIONS: ReadonlySet<string> = new Set<string>([".psd", ".psb"]);
// EPS is single-stream PostScript with no layer structure, so AE rasterizes it
// to a one-layer composition (verified: AE 2026 imports eps.eps as a 1-layer
// comp). Handled separately from AI_COMP_EXTENSIONS, which needs PDF OCGs.
export const EPS_COMP_EXTENSIONS: ReadonlySet<string> = new Set<string>([".eps"]);

/**
 * Return the `ImportAsType` values valid for a file extension.
 *
 * @param suffix - The file extension including the leading dot (e.g. `.psd`).
 * @returns The set of accepted import types, or an empty set for an extension with no recorded
 *   import support.
 */
export function getImportAsTypes(suffix: string): ReadonlySet<ImportAsType> {
  return _IMPORT_AS_TYPES.get(suffix.toLowerCase()) ?? new Set<ImportAsType>();
}

/**
 * Return the `FileFormat` for a file extension (e.g. `.png`).
 *
 * @param suffix - The file extension including the leading dot.
 * @throws {@link ValueError} If the extension is not a supported footage format.
 */
export function getFileFormat(suffix: string): FileFormat {
  const fmt = _FILE_FORMATS.get(suffix.toLowerCase()) ?? null;
  if (fmt == null) throw new ValueError(`Unsupported footage format: ${repr(suffix)}`);
  return fmt;
}
