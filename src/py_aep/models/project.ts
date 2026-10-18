// Port of py_aep/models/project.py.

import { INSPECT } from "../../pyrt/index.ts";
import * as host from "../../pyrt/host.ts";
import { uuid4 } from "../../pyrt/uuid.ts";

import { fromstring, tostring } from "../../pyrt/etree.ts";
import { aeWrites, requiresVersion } from "../ae_version.ts";
import { toF4, truncateUtf8 } from "../binary/bin_utils.ts";
import { writeAep as _writeAep } from "../binary/chunk.ts";
import { Chunk, ListChunk } from "../binary/chunk.ts";
import { buildAiLayerOptiData, buildPsdFlattenedOptiData, buildTextOptiData } from "../binary/footage_chunks.ts";
import { HeadChunk, NhedChunk, NnhdChunk, TimeDisplayPrefItem } from "../binary/item_chunks.ts";
import { DwgaChunk } from "../binary/misc_chunks.ts";
import { CpidChunk, FdtaChunk, SvapChunk, WsnmChunk, WsnsChunk } from "../binary/project_chunks.ts";
import { F8Chunk, U1Chunk, U2Chunk, U4Chunk, U4LeChunk, Utf8Chunk } from "../binary/scalar_chunks.ts";
import { alasFullpath, dumpAlas, filterByType, findByListType, findByListTypeOrNull, findByType, findByTypeOrNull, indexByIdentity, PENDING_ASCENDCOUNT, recursiveFind, toggleFlagChunk } from "../binary/utils.ts";
import type { RenderSettingsItem } from "../binary/render_chunks.ts";
import { buildIccEnvelope, buildOcioDisplayEnvelope, envelopeProfileName } from "../color/envelope.ts";
import { IccProfileLibrary, iccProfileDescription, iccProfileId } from "../color/icc.ts";
import { listConfigColorSpaces, ocioColorProfileEnvelope, requireOcioConfig, resolveOcioConfig } from "../color/ocio.ts";
import { AI_COMP_EXTENSIONS, EPS_COMP_EXTENSIONS, PSD_COMP_EXTENSIONS } from "../data/file_formats.ts";
import { BitsPerChannel, ColorManagementSystem, FeetFramesFilmType, FootageTimecodeDisplayStartType, FramesCountType, GpuAccelType, ImportAsType, LutInterpolationMethod, PREFType, TimeDisplayType } from "../enums/index.ts";
import { adobeColorProfileNames } from "../enums/mappings.ts";
import { EMPTY_BOX, footageSize, readAiLayerBounds } from "../resolvers/ai_bounds.ts";
import { readAiLayerOcgs } from "../resolvers/ai_layers.ts";
import { NORMALIZED_ARC_ACCURACY } from "../resolvers/interpolation.ts";
import { pixelBufferSize, probeMedia } from "../resolvers/media_probe.ts";
import { MediaInfo } from "../resolvers/media_probe.ts";
import { platformPath, relativePathCounts } from "../resolvers/platform_paths.ts";
import { FlattenedPsdError, PsdGroup, PsdLayer, readPsdLayers } from "../resolvers/psd_layers.ts";
import { parseVectorMask } from "../resolvers/psd_paths.ts";
import { hasEnabledStyles, parseLayerStyles, readGlobalLight } from "../resolvers/psd_styles.ts";
import type { PsdLayerStyles } from "../resolvers/psd_styles.ts";
import { LayerGroupSpec, LayerSpec } from "../synthesis/layer.ts";
import { _ADV_BLEND_SPECS, _BLEND_OPTIONS_SPECS, _LAYER_STYLE_CHILD_SPECS, _STYLE_ANGLE_SUFFIXES, _STYLE_ENUM_SUFFIXES, _STYLE_HINT_BOUNDS, _STYLE_HINT_BOUNDS_EXCEPTIONS, PropSpec } from "../synthesis/property.ts";
import { ChunkField, type EffectParamDefs } from "./descriptors.ts";
import { ImportOptions } from "./import_options.ts";
import { CompItem } from "./items/composition.ts";
import { FolderItem } from "./items/folder.ts";
import { FootageItem } from "./items/footage.ts";
import { Item } from "./items/item.ts";
import { AVItem } from "./items/av_item.ts";

import { Preferences, defaultSequenceFps, psdCompLayerStyles, psdFootageDimensions, psdFootageLayerStyles } from "./preferences.ts";
import { Gradient } from "./properties/gradient.ts";
import { Property, _valuesEqual } from "./properties/property.ts";
import { PropertyGroup } from "./properties/property_group.ts";
import { Shape } from "./properties/shape.ts";
import { RenderQueue } from "./renderqueue/render_queue.ts";
import type { Layer } from "./layers/layer.ts";
import { PSD_LAYER_STYLES_C8, FileSource, aiDocumentProfile, checkFootageSize, namedMediaProfile, psdLayerFootage } from "./sources/file.ts";
import { _replaceLayerFont } from "./text/ranges.ts";
import type { FontObject } from "./text/font_object.ts";
import type { TextDocument } from "./text/text_document.ts";
import { _validateNumber, validateBool, validateEnum, validateFontName, validateOneOf, validatePath, validatePathDoesNotExist, validatePathExists, validateString, validateU4 } from "./validators.ts";
import type { OutputModuleTemplate } from "../parsers/templates.ts";

import {
  ValueError,
  TypeError_,
  KeyError,
  NotImplementedError,
  bytes_,
  b,
  BytesIO,
  Path,
  decode,
  dictGet,
  fspath,
  getattr,
  setattr,
  getitem,
  int,
  max,
  pyAssert,
  pyBool,
  pyCmp,
  pyEq,
  pyOr,
  repr,
  rshift,
  round,
  setdefault,
  sorted,
  str,
  strip,
  tkey,
  warn,
  bytesEq,
  descriptor,
  format,
  instanceDict,
  jsonDumps,
  jsonLoads,
  typeName,
  type ClassAttributes,
  AttributeError,
  jsonInt,
  type JsonValue,
} from "../../pyrt/index.ts";
import type { PathLike } from "../../pyrt/index.ts";
import type { Element } from "../../pyrt/etree.ts";
import type { Box } from "../resolvers/ai_bounds.ts";
import type { PsdNode } from "../resolvers/psd_layers.ts";

/**
 * Mutable module globals: ESM exports are read-only, so names that Python
 * tests replace with `monkeypatch.setattr(project_mod, name, ...)` are read
 * through this holder instead.
 */
export const moduleGlobals: { writeAep: typeof _writeAep } = { writeAep: _writeAep };
import { effectDefinitionEntries } from "../parsers/effect.ts";
import { parseOutputTemplates, parseRenderTemplates } from "../parsers/templates.ts";
import { PlaceholderSource } from "./sources/placeholder.ts";
import { UnsupportedSVGError, readSvg } from "../svg/index.ts";
import { buildShapeLayerContents } from "../svg/build.ts";
import type { AVLayer } from "./layers/av_layer.ts";

/** `itertools.count(start)` (the clip-run counter). */
export function* count(start = 0): Generator<number> {
  for (let i = start; ; i++) yield i;
}

export function ET_fromstring(text: string): Element {
  return fromstring(text);
}

export function ET_tostring(el: Element): string {
  return tostring(el, "unicode");
}


/** `isinstance(x, (list, tuple))` as used by the port. */
export function isListOrTuple(x: unknown): x is unknown[] {
  return Array.isArray(x);
}

export const _validateExpressionEngine = validateOneOf(["extendscript", "javascript-1.0"]);

export function _validateGpuAccelType(value: GpuAccelType | string, obj: Project): void {
  /** Accept a `GpuAccelType` or a renderer UUID string (what the getter
   * returns for an id it does not recognise). */
  if (typeof value === "string") {
    GpuAccelType.toBinary(value);
  } else {
    validateEnum(GpuAccelType)(value);
  }
}

export function _fontPostScriptName(font: FontObject | string): string {
  /** The PostScript name of a `replace_font` argument. */
  if (typeof font === "string") {
    validateFontName(font);
    return font;
  }
  const name = font?.postScriptName ?? null;
  if (typeof name !== "string" || !name) {
    throw new TypeError_("expected a FontObject or a PostScript name string");
  }
  return name;
}

// AE's default new-composition import timing for a layered file: a 30-second
// duration rounded to whole frames at 29.97 fps. This is AE's built-in
// factory default, not a preference: verified by deleting every AE pref
// file and cold-starting AE (regenerated factory prefs, "Composition
// Settings7" empty) - a layered PSD still imported at 29.97 fps / 30 s.
export const _LAYERED_COMP_FRAME_RATE = 29.97;
export const _LAYERED_COMP_DURATION_SECONDS = 30.0;

/** Wrap a setter with `@requires_version(N)`: the setter body is passed to the
 * decorator factory once, at module load, and invoked with the project as `this`. */
export const _setLinearizeWorkingSpace = requiresVersion(15)(function linearize_working_space(
  this: Project,
  value: boolean,
): void {
  validateBool(value);
  // `lnrp` sits immediately after `lnrb` (or after `cpid` when linear
  // blending is off), before `dwga`.
  toggleFlagChunk(this._rifx, "lnrp", value, { afterTypes: ["lnrb", "cpid"] });
});

export const _setExpressionEngine = requiresVersion(16)(function expression_engine(
  this: Project,
  value: string,
): void {
  _validateExpressionEngine(value);
  if (this._exenUtf8 != null) {
    this._exenUtf8.value = value;
  } else {
    const utf8 = new Utf8Chunk({ value });
    const exen = new ListChunk({ listType: "ExEn", chunks: [utf8] });
    this._rifx.chunks.push(exen);
    this._exenUtf8 = utf8;
  }
});

export const _setColorManagementSystem = requiresVersion(24)(function color_management_system(
  this: Project,
  value: ColorManagementSystem | number,
): void {
  validateEnum(ColorManagementSystem)(value);
  this._updateCmsSetting("colorManagementSystem", int(value));
});

export const _setLutInterpolationMethod = requiresVersion(24)(function lut_interpolation_method(
  this: Project,
  value: LutInterpolationMethod | number,
): void {
  validateEnum(LutInterpolationMethod)(value);
  this._updateCmsSetting("lutInterpolationMethod", int(value));
});

export const _setOcioConfigurationFile = requiresVersion(24)(function ocio_configuration_file(
  this: Project,
  value: PathLike,
): void {
  validatePath(value);
  this._updateCmsSetting("ocioConfigurationFile", fspath(value));
});

/**
 * The `Project` object represents an After Effects project. Attributes
 * provide access to specific objects within the project, such as imported
 * files or footage and compositions, and also to project settings such as the
 * timecode base.
 *
 * @example
 * ```ts
 * import { parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const project = app.project;
 * console.log(project.file);
 * for (const item of project) {
 *   // ...
 * }
 * ```
 * @see https://ae-scripting.docsforadobe.dev/general/project/
 */
export class Project {
  declare ["constructor"]: ClassAttributes<typeof Project>;
  /**
   * The After Effects platform the project is for, `"windows"` or
   * `"macos"`, which picks a BMP/GIF sequence's importer code (see
   * `py_aep.parse`). The host's by default.
   */
  static _platform: string = host.platform === "win32" ? "windows" : "macos";

  /**
   * The color depth of the current project, either 8, 16, or 32 bits.
   * Read / Write.
   */
  declare bitsPerChannel: BitsPerChannel;

  /**
   * The film type for feet+frames timecode display, either MM16 (16mm) or
   * MM35 (35mm). Read / Write.
   */
  declare feetFramesFilmType: FeetFramesFilmType;

  /**
   * The Footage Start Time setting in the Project Settings dialog box,
   * which is enabled when Timecode is selected as the time display style.
   * Read / Write.
   */
  declare footageTimecodeDisplayStartType: FootageTimecodeDisplayStartType;

  /**
   * The Default Base value in the Time Display Style section of
   * the Project Settings dialog, under Timecode. Read/Write.
   */
  declare _timecodeDefaultBase: number;

  /**
   * The Frame Count menu setting in the Project Settings dialog box.
   * Read / Write.
   */
  declare framesCountType: FramesCountType;

  /**
   * The start frame number for the project display (0 or 1). An alternate
   * way of setting the Frame Count menu setting. Read / Write.
   */
  declare displayStartFrame: number;

  /**
   * When `true`, the Frames field in the UI is displayed as
   * feet+frames. Read / Write.
   */
  declare framesUseFeetFrames: boolean;

  /**
   * The time display style, corresponding to the Time Display Style
   * section in the Project Settings dialog box. Read / Write.
   */
  declare timeDisplayType: TimeDisplayType;

  /**
   * When `true`, thumbnail views use the transparency checkerboard
   * pattern. Read / Write.
   */
  declare transparencyGridThumbnails: boolean;

  /**
   * The current revision of the project. Every user action increases the
   * revision number by one. A new project starts at revision 1. Read / Write.
   *
   * **Note:** This attribute is read-only in ExtendScript.
   */
  declare revision: number;

  /**
   * When True, After Effects compensates for scene-referred profiles when
   * rendering.
   */
  declare compensateForSceneReferredProfiles: boolean;

  /**
   * The project audio sample rate in Hz.
   *
   * Allowed values: 22050, 32000, 44100, 48000, 96000.
   *
   * **Note:** Not exposed in ExtendScript
   */
  declare audioSampleRate: number;

  /**
   * The gamma value used for the working color space, either 2.2 or 2.4.
   * Read / Write.
   */
  declare workingGamma: number;

  /**
   * The GPU acceleration type for the project. A renderer id py_aep does
   * not recognise reads as its UUID string, which can be written back. An
   * AE CC 12.0 project reads SOFTWARE, as AE reports it.
   * Read / Write.
   */
  declare gpuAccelType: GpuAccelType | string;

  // ChunkField needs a chunk_attr that resolves to an object holding the
  // target field.  _xmp lives directly on Project, so we alias _aep = self
  // in __init__ so the descriptor chain is: getattr(self, "_aep") -> self,
  // then getattr(self, "_xmp") -> the raw XMP string.
  /**
   * The XMP packet for the project, containing metadata. `null` when the
   * project has no XMP packet (e.g. projects created via `py_aep.new()`).
   * Read / Write.
   */
  declare xmpPacket: Element | null;

  // Chunk body references for descriptors
  declare _nhed: NhedChunk;
  declare _nnhd: NnhdChunk;
  declare _head: HeadChunk;
  declare _acer: U1Chunk;
  declare _adfr: F8Chunk;
  declare _dwga: DwgaChunk;
  declare _gpugUtf8: Utf8Chunk;
  declare _exenUtf8: Utf8Chunk | null;
  declare _cmsUtf8: Utf8Chunk | null;
  declare _wsUtf8: Utf8Chunk | null;
  declare _dcsUtf8: Utf8Chunk | null;
  declare _rifx: ListChunk;
  declare _xmp: string;
  declare _aep: Project;

  // Read-only attributes
  declare _file: string;
  declare _items: Map<number, Item>;
  declare _renderQueue: RenderQueue | null;
  declare _activeItem: Item | null;
  declare _effectParamDefs: EffectParamDefs;
  declare _effectDefinitionsCache: [string, string, ListChunk][] | null;
  declare _usedInLinked: boolean;
  declare _idCounterReconciled: boolean;
  declare _aePreferencesDir: Path | null;
  declare _preferences: Preferences;
  declare _platform: string;
  // ICC profile discovery for Adobe-CMS working-space writes. `None`
  // dirs = auto-discover the standard Adobe Color directories.
  declare _iccProfileDirs: Path[] | null;
  declare _iccLibrary: IccProfileLibrary | null;
  declare _renderTemplatesCache: RenderSettingsItem[] | null;
  declare _outputTemplatesCache: OutputModuleTemplate[] | null;
  declare _defaultRenderTemplateIndex: number | null;

  constructor(kw: {
    _nhed: NhedChunk;
    _nnhd: NnhdChunk;
    _head: HeadChunk;
    _acer: U1Chunk;
    _adfr: F8Chunk;
    _dwga: DwgaChunk;
    _gpugUtf8: Utf8Chunk;
    _exenUtf8: Utf8Chunk | null;
    _cmsUtf8: Utf8Chunk | null;
    _wsUtf8: Utf8Chunk | null;
    _dcsUtf8: Utf8Chunk | null;
    _rifx: ListChunk;
    _xmp: string;
    file: string;
    items: Map<number, Item>;
    renderQueue: RenderQueue | null;
    aePreferencesDir?: Path | null;
  }) {
    const {
      _nhed,
      _nnhd,
      _head,
      _acer,
      _adfr,
      _dwga,
      _gpugUtf8,
      _exenUtf8,
      _cmsUtf8,
      _wsUtf8,
      _dcsUtf8,
      _rifx,
      _xmp,
      file,
      items,
      renderQueue,
      aePreferencesDir = null,
    } = kw;
    // Chunk body references for descriptors
    this._nhed = _nhed;
    this._nnhd = _nnhd;
    this._head = _head;
    this._acer = _acer;
    this._adfr = _adfr;
    this._dwga = _dwga;
    this._gpugUtf8 = _gpugUtf8;
    this._exenUtf8 = _exenUtf8;
    this._cmsUtf8 = _cmsUtf8;
    this._wsUtf8 = _wsUtf8;
    this._dcsUtf8 = _dcsUtf8;
    this._rifx = _rifx;
    this._xmp = _xmp;
    this._aep = this;

    // Read-only attributes
    this._file = file;
    this._items = items;
    this._renderQueue = renderQueue;
    this._activeItem = null;
    this._effectParamDefs = new Map();
    this._effectDefinitionsCache = null;
    this._usedInLinked = false;

    this._idCounterReconciled = false; // lazily done on first allocation
    this._aePreferencesDir = aePreferencesDir;
    this._preferences = new Preferences(aePreferencesDir);
    // Class attribute read through the instance until `_new` assigns one.
    this._platform = this.constructor._platform;
    // ICC profile discovery for Adobe-CMS working-space writes. `None`
    // dirs = auto-discover the standard Adobe Color directories.
    this._iccProfileDirs = null;
    this._iccLibrary = null;
    this._renderTemplatesCache = null;
    this._outputTemplatesCache = null;
    this._defaultRenderTemplateIndex = null;
  }

  // Color-management settings JSON AE 2026 writes for a new project.
  // Inherited from the empty-project ground truth; callers can override
  // via color_management_system / lut_interpolation_method / etc.
  static _NEW_PROJECT_CMS_JSON: string = '{"lutInterpolationMethod":1}';

  _effectDefinitions(): [string, string, ListChunk][] {
    /**
     * `LIST:EfdG` effect definitions, walked once and cached.
     *
     * EfdG is read-only after parse (adding an installed effect clones
     * its sspc template into the layer rather than editing EfdG), so the
     * walk is computed lazily on first lookup and reused across adds.
     */
    if (this._effectDefinitionsCache == null) {
      this._effectDefinitionsCache = effectDefinitionEntries(this._rifx.chunks);
    }
    return this._effectDefinitionsCache;
  }

  /**
   * Apply the last-used Project Settings preferences to a new project.
   *
   * AE persists the Project Settings dialog into the machine-specific
   * "Project Pref Section" (color depth plus a 16-byte time-display
   * blob mirroring the `nnhd` settings cluster) and File \> New
   * inherits them. Missing or malformed values leave the AE-factory
   * chunk defaults untouched.
   */
  static _applyProjectSettingsPrefs(
    preferences: Preferences,
    nhed: NhedChunk,
    nnhd: NnhdChunk,
  ): void {
    const depth = preferences.getPrefAsNumber("Project Pref Section", "Project Settings Depth", undefined, {
      default: 0,
    });
    if ([1, 2].includes(depth)) {
      // 0 = 8 bpc = the chunk default
      nhed.bitsPerChannel = int(depth);
      nnhd.bitsPerChannel = int(depth);
    }
    const blob = preferences._getBytes(
      "Project Pref Section",
      "Project Settings Time Display Format",
      PREFType.PREF_Type_MACHINE_SPECIFIC,
    );
    if (blob == null || blob.length !== 16) return;
    const item = TimeDisplayPrefItem.frombytes(blob);
    pyAssert(item instanceof TimeDisplayPrefItem);
    for (const chunk of [nhed, nnhd]) {
      chunk.timeDisplayType = item.displayByte & 0x7f;
      chunk.feetFramesFilmType = (item.displayByte & 0x80) !== 0;
      chunk.footageTimecodeDisplayStartType = item.footageTimecodeDisplayStartType;
      chunk.framesUseFeetFrames = (item.feetByte & 0x01) !== 0;
      chunk.timecodeDefaultBase = item.timecodeDefaultBase;
      chunk.framesCountType = item.framesCountType;
    }
  }

  /**
   * Build a new, empty project (mirrors AE's File \> New Project).
   *
   * Constructs the minimal root chunk skeleton AE accepts - the large
   * workspace blobs AE regenerates on open (`LSIf/AFsi`, `PTRE/ftwd`)
   * are omitted - stamps `version` into the head chunk, and wires the
   * model the same way `parse_project` does. `aePreferencesDir` is
   * stored for render-queue template lookup. `platform` (default: the
   * running operating system) selects the header stamps AE writes on
   * that platform. See {@link Application} and `py_aep.new`.
   */
  static _new(
    version: string,
    aePreferencesDir: Path | null = null,
    platform: string | null = null,
  ): Project {
    platform = platform || this._platform;
    const macos = platform === "macos";
    const preferences = new Preferences(aePreferencesDir);
    const head = new HeadChunk();
    // HeadChunk defaults the OS / release / reserved bits AE always writes
    // for a saved Windows release build (see _version_word); the .version
    // setter stamps the version bits while preserving them.
    head.version = version;
    // AE refuses to open a file whose file_format_version exceeds its
    // own; deriving it from the requested version lets new(old_version)
    // open in that AE (validated AE 2022-2026). A release newer than any
    // with a known stamp keeps the AE 2026 one HeadChunk defaults to,
    // matching the AE 2026 skeleton built below.
    head.syncFileFormatVersion();
    const major = head.aeVersionMajor;
    // Saving-platform stamps, constant per platform across the sample
    // corpus (1348 Windows / 7 macOS files): the head OS code, nnhd byte
    // 2, and the system text encoding at the start of nnhd 0x1A - macOS
    // 0x0100, Windows code page 1252 up to AE 25 and 65001 (UTF-8) from
    // AE 26. AE rewrites all three on every save.
    head.aeVersionOs = macos ? 14 : 12;
    const svap = new SvapChunk({ buildNumber: head.aeBuildNumber });
    const nhed = new NhedChunk();
    const nnhd = new NnhdChunk();
    this._applyProjectSettingsPrefs(preferences, nhed, nnhd);
    nnhd._savingPlatform = macos ? 0x08 : 0;
    if (macos) {
      nnhd._systemCodePage = 0x0100;
    } else {
      const utf8 = aeWrites("utf-8 code page", major);
      nnhd._systemCodePage = utf8 ? 65001 : 1252;
    }
    const acer = new U1Chunk({ chunkType: "acer", value: 1 });
    const adfr = new F8Chunk({ chunkType: "adfr", value: 48000.0 });
    const dwga = new DwgaChunk({ workingGammaSelector: 1 });
    // A new project takes the platform's GPU renderer: AE's File > New
    // on Windows writes CUDA (emptier.aep), macOS files carry Metal.
    const gpugUtf8 = new Utf8Chunk({
      value: GpuAccelType.toBinary(macos ? GpuAccelType.METAL : GpuAccelType.CUDA),
    });
    const fold = new ListChunk({ listType: "Fold", chunks: [new FdtaChunk()] });
    // AE stamps the "New Project Solids Folder" preference into the
    // root sfnm chunk at File > New; the stored name is used from
    // then on (see _solids_folder_name).
    const solidsName = preferences.getPrefAsString(
      "Template Project",
      "New Project Solids Folder",
      PREFType.PREF_Type_MACHINE_INDEPENDENT,
      { default: "Solids" },
    );

    // Root chunks in AE's order. Several are version-gated: AE adds them
    // in later releases, and a fresh project from an older AE omits them
    // (boundaries from samples/versions + emptier_2018.aep). The big
    // workspace blobs AE regenerates on open are omitted entirely.
    let cmsUtf8: Utf8Chunk | null = null;
    let exenUtf8: Utf8Chunk | null = null;
    const rootChunks: Chunk[] = [
      svap,
      head,
      nhed,
      nnhd,
      adfr,
      new ListChunk({ listType: "Pefl" }),
      new U1Chunk({ chunkType: "qtlg" }),
      new ListChunk({ listType: "gpuG", chunks: [gpugUtf8] }),
      new ListChunk({
        listType: "sfnm",
        chunks: [
          new Utf8Chunk({ value: solidsName || "Solids" }),
          new U4LeChunk({ chunkType: "sfid" }),
        ],
      }),
    ];
    if (aeWrites("media replacement folder id", major)) {
      rootChunks.push(new U4LeChunk({ chunkType: "mrid" }));
    }
    rootChunks.push(acer, new ListChunk({ listType: "CPPl" }), new CpidChunk(), dwga);
    if (aeWrites("color management", major)) {
      cmsUtf8 = new Utf8Chunk({ value: this._NEW_PROJECT_CMS_JSON });
      rootChunks.push(
        new U1Chunk({ chunkType: "pcms", value: 1 }),
        cmsUtf8,
        new U1Chunk({ chunkType: "PwCs", value: 1 }),
        new Utf8Chunk({ value: "{}" }),
      );
    }
    if (aeWrites("pdvc", major)) {
      rootChunks.push(new U1Chunk({ chunkType: "pdvc", value: 1 }), new Utf8Chunk({ value: "{}" }));
    }
    if (aeWrites("expression engine", major)) {
      exenUtf8 = new Utf8Chunk({ value: "javascript-1.0" });
      rootChunks.push(new ListChunk({ listType: "ExEn", chunks: [exenUtf8] }));
    }
    rootChunks.push(
      fold,
      // Workspace name ("Default"): wsns is the wsnm byte length, wsnm is
      // the name (UTF-16-LE), then a UTF-8 copy. WsnsChunk/WsnmChunk bake
      // the "Default" workspace as their defaults.
      new WsnsChunk(),
      new WsnmChunk(),
      new Utf8Chunk({ value: "Default" }),
      new U4Chunk({ chunkType: "fcid" }),
      new U2Chunk({ chunkType: "oacc" }),
    );
    const rifx = new ListChunk({ chunkType: "RIFX", listType: "Egg!", chunks: rootChunks });

    const project = new this({
      _nhed: nhed,
      _nnhd: nnhd,
      _head: head,
      _acer: acer,
      _adfr: adfr,
      _dwga: dwga,
      _gpugUtf8: gpugUtf8,
      _exenUtf8: exenUtf8,
      _cmsUtf8: cmsUtf8,
      _wsUtf8: null,
      _dcsUtf8: null,
      _rifx: rifx,
      _xmp: "",
      file: "",
      items: new Map(),
      renderQueue: null,
      aePreferencesDir,
    });
    project._platform = platform;

    // Root folder (mirrors parse_folder(is_root=True): no idta/name, the
    // Fold chunk list is its own children container).
    const rootFolder = new FolderItem({
      _idta: null,
      _nameUtf8: null,
      _cmta: null,
      _itemList: fold,
      _gide: null,
      _childrenContainer: fold.chunks,
      project,
      parentFolder: null,
    });
    instanceDict(rootFolder).set("name", "root");
    project.items.set(0, rootFolder);
    project._activeItem = rootFolder;

    // Empty render queue (LIST:LRdr appended after the loose root chunks,
    // matching AE's ordering).
    const renderQueue = RenderQueue._new(project);
    rifx.chunks.push(renderQueue._lrdr);
    project._renderQueue = renderQueue;

    return project;
  }

  [INSPECT](): string {
    return `Project(file=${repr(this._file)})`;
  }

  /**
   * Return an iterator over the project's items.
   *
   * Iterates a snapshot so items can be removed while looping.
   */
  [Symbol.iterator](): Iterator<Item> {
    return [...this.items.values()][Symbol.iterator]();
  }

  /**
   * Populate `AVItem._used_in` sets on first access.
   *
   * Deferred until the first `used_in` read or mutation that
   * needs the back-references for correctness (e.g. cycle detection).
   */
  _ensureUsedInLinked(): void {
    if (this._usedInLinked) return;
    this._usedInLinked = true;
    for (const composition of this.compositions) {
      for (const sourceId of composition._sourceIdsForLinking()) {
        const source = this.items.get(sourceId) ?? null;
        if (source instanceof AVItem) {
          source._usedIn.add(composition);
        }
      }
    }
  }

  /** The full path to the project file. Read-only. */
  get file(): string {
    return this._file;
  }

  /** All the items in the project. Read-only. */
  get items(): Map<number, Item> {
    return this._items;
  }

  /** The Render Queue of the project. Read-only. */
  get renderQueue(): RenderQueue | null {
    return this._renderQueue;
  }

  /**
   * The item that is currently active and is to be acted upon, or
   * `null` if no item is currently selected or if multiple items are
   * selected. Read-only.
   */
  get activeItem(): Item | null {
    return this._activeItem;
  }

  /**
   * Drop the active-item reference when `removed` is the active item.
   *
   * The active item is stored as an item id in the root `fcid` chunk.
   * Leaving a removed item's id there makes the file reference an item
   * that no longer exists: After Effects tolerates it (it shows nothing
   * selected), but `parse()` cannot resolve the id. AE itself writes
   * `fcid = 0` once the active item is deleted.
   */
  _clearActiveItem(removed: Item): void {
    if (this._activeItem !== removed) return;
    this._activeItem = null;
    const fcid = findByTypeOrNull(this._rootChunks, "fcid");
    if (fcid !== null) fcid.value = 0;
  }

  /**
   * The root folder. This is a virtual folder that contains all items
   * in the Project panel, but not items contained inside other folders in
   * the Project panel. Read-only.
   */
  get rootFolder(): FolderItem {
    return getitem(this._items, 0) as FolderItem;
  }

  get _rootChunks(): Chunk[] {
    return this._rifx.chunks;
  }

  _syncNhedField(fieldName: string): void {
    setattr(this._nhed, fieldName, getattr(this._nnhd, fieldName));
  }

  _syncNhedTimecodeDefaultBase(): void {
    // nhed matches nnhd in every sample, none above 255; what AE writes
    // in its u1 for a larger base is unmeasured, so it is left as is.
    if (this._nnhd.timecodeDefaultBase <= 0xff) {
      this._syncNhedField("timecodeDefaultBase");
    }
  }

  _ensureMaterialized(): void {
    /**
     * Keep the stand-ins for root chunks older projects lack synthetic.
     *
     * An AE CC 12.0 project has no nnhd, dwga or gpuG; the parser stands in
     * synthetic ones (see `parse_project`), which `ChunkField` writes land
     * on. They stay out of the file: an nnhd setting persists through the
     * nhed it syncs to, and the settings with no older counterpart
     * (`working_gamma`, `gpu_accel_type`) are gated by `minVersion`
     * instead of being dropped on save.
     */
  }

  /**
   * When True, linear blending is used for the project. When False,
   * the standard blending mode is used. Read / Write.
   */
  get linearBlending(): boolean {
    return this._rootChunks.some((c) => c.chunkType === "lnrb");
  }

  set linearBlending(value: boolean) {
    validateBool(value);
    // AE keeps `lnrb` in a fixed slot right after `cpid` (before `lnrp` /
    // `dwga`); appending it at the tail makes AE report "missing data".
    toggleFlagChunk(this._rifx, "lnrb", value, { afterTypes: ["cpid"] });
  }

  /**
   * When True, the working color space is linearized for blending
   * operations. Read / Write.
   */
  get linearizeWorkingSpace(): boolean {
    return this._rootChunks.some((c) => c.chunkType === "lnrp");
  }

  set linearizeWorkingSpace(value: boolean) {
    _setLinearizeWorkingSpace.call(this, value);
  }

  /**
   * The Expressions Engine setting in the Project Settings dialog box
   * ("extendscript" or "javascript-1.0"). Read / Write.
   */
  get expressionEngine(): string {
    if (this._exenUtf8 != null) return this._exenUtf8.value;
    return "extendscript";
  }

  set expressionEngine(value: string) {
    _setExpressionEngine.call(this, value);
  }

  /** The names of all effects used in the project. Read-only. */
  get effectNames(): string[] {
    return _getEffectNames(this._rootChunks);
  }

  /**
   * The name of the working color space (e.g., "sRGB IEC61966-2.1",
   * "ACEScg", "None"). Read / Write.
   *
   * In OCIO mode, assigning any color space, role, alias, or
   * `display/view` pair of {@link ocioConfigurationFile} rewrites the
   * embedded profile JSON (AE identifies it by name, no ICC data). The
   * config must be resolvable, because the envelope AE writes depends on
   * which of those kinds the name is; `ValueError` is raised if it cannot
   * be located or the name is not in it.
   *
   * In Adobe CMS mode, the matching ICC profile is discovered on disk (see
   * {@link iccProfileDirs}) and embedded; `ColorProfileNotFoundError` is
   * raised if it is not installed. Assigning `"None"` removes the working
   * space.
   *
   * In a project from before After Effects 22, the profile is added to the
   * project's list of ICC profiles; as in After Effects, a profile that is
   * no longer the working space stays in that list.
   */
  get workingSpace(): string {
    if (this._wsUtf8 != null) return envelopeProfileName(this._wsUtf8.value);
    if (!this._rootChunks.some((c) => c.chunkType === "pcms")) {
      // Before AE 22 the working space is the `LIST:CPPl` profile
      // whose ICC profile id `cpid` holds (all 0xFF: None).
      const profileId = this._cpid.data;
      const cppl = findByListType(this._rootChunks, "CPPl");
      for (const pprf of filterByType(cppl.chunks, "pprf")) {
        if (bytesEq(iccProfileId(pprf.data), profileId)) {
          return iccProfileDescription(pprf.data) || "None";
        }
      }
    }
    return "None";
  }

  set workingSpace(value: string) {
    validateString(value);
    if (!this._rootChunks.some((c) => c.chunkType === "pcms")) {
      this._setCpplWorkingSpace(value);
      return;
    }
    let envelope: string;
    let profileId: Uint8Array;
    if (this.colorManagementSystem === ColorManagementSystem.OCIO) {
      envelope = this._ocioEnvelope(value);
      profileId = bytes_.repeat(b("\xff"), 16);
    } else if (value === "None") {
      // No working space, which the getter reports as "None": AE 2026
      // saves `workingSpace = "None"` as an empty `{}` profile after
      // `PwCs` and an all-0xFF `cpid`, like a new project.
      envelope = "{}";
      profileId = bytes_.repeat(b("\xff"), 16);
    } else {
      // bytes_for already raises ColorProfileNotFoundError for an
      // unknown Adobe profile name, so no separate name check is needed.
      const icc = this._iccLib().bytesFor(value);
      envelope = buildIccEnvelope(value, icc);
      profileId = iccProfileId(icc);
    }
    this._wsUtf8 = this._rewriteColorProfile("PwCs", envelope);
    // AE 2026 rewrites `cpid` to the new profile's id when a script sets
    // workingSpace; OCIO projects store all 0xFF.
    this._cpid.data = profileId;
  }

  /**
   * Set the working space of a project from before After Effects 22.
   *
   * These projects keep each ICC profile they use as a `pprf` in
   * `LIST:CPPl`, and `cpid` holds the working space's id. Measured on AE
   * 15.1: it saves the list sorted by ICC profile id and keeps profiles
   * nothing uses anymore, so a new profile is inserted in order and a
   * replaced one stays.
   */
  _setCpplWorkingSpace(value: string): void {
    if (value === "None") {
      this._cpid.data = bytes_.repeat(b("\xff"), 16);
      return;
    }
    const icc = this._iccLib().bytesFor(value);
    const profileId = iccProfileId(icc);
    const cppl = findByListType(this._rootChunks, "CPPl");
    // The first profile whose id is not below the new one: the same
    // profile (reused) or the one the new profile goes before.
    const at = cppl.chunks.findIndex((pprf) => pyCmp(iccProfileId(pprf.data), profileId) >= 0);
    if (at === -1) {
      cppl.chunks.push(new Chunk({ chunkType: "pprf", data: icc }));
    } else if (pyCmp(iccProfileId(cppl.chunks[at].data), profileId) > 0) {
      cppl.chunks.splice(at, 0, new Chunk({ chunkType: "pprf", data: icc }));
    }
    this._cpid.data = profileId;
  }

  get _cpid(): CpidChunk {
    return findByType(this._rootChunks, "cpid");
  }

  /** Whether the project is for After Effects on Windows (`_platform`). */
  get _windows(): boolean {
    return this._platform === "windows";
  }

  /**
   * Build the OCIO color-profile envelope AE writes for `name`.
   *
   * `ocio_color_profile_envelope` raises for a name the config does not
   * contain, so no separate membership check is needed.
   */
  _ocioEnvelope(name: string): string {
    const config = requireOcioConfig(
      this.ocioConfigurationFile,
      `build the color-profile envelope for ${repr(name)}`,
    );
    return ocioColorProfileEnvelope(config, name);
  }

  /**
   * Directories scanned to resolve ICC profiles when writing an
   * Adobe-CMS working space. `null` (default) auto-discovers the standard
   * Adobe Color directories. Assign an array of folders containing `.icc`/
   * `.icm` files to override (e.g. for a non-default install or CI).
   */
  get iccProfileDirs(): Path[] | null {
    return this._iccProfileDirs;
  }

  set iccProfileDirs(value: PathLike[] | null) {
    if (value != null) {
      if (!isListOrTuple(value)) {
        throw new TypeError_(
          "iccProfileDirs must be a list of directories or None, " +
            `got ${typeName(value)}`,
        );
      }
      for (const p of value) validatePathExists(p);
    }
    this._iccProfileDirs = value != null ? value.map((p: PathLike) => new Path(p)) : null;
    this._iccLibrary = null; // rebuild on next use
  }

  _iccLib(): IccProfileLibrary {
    if (this._iccLibrary == null) {
      this._iccLibrary = new IccProfileLibrary(this._iccProfileDirs);
    }
    return this._iccLibrary;
  }

  /**
   * The name of the display color space used for the project (e.g.,
   * "ACES/sRGB"). Only relevant when color_management_system is OCIO.
   * "None" when not set. Read / Write.
   *
   * Assign a `[display, view]` array or a `"display/view"` string. Writable
   * only in OCIO mode (the chunk stores an OCIO display + view by name). In
   * Adobe CMS mode the display uses the operating system's monitor profile,
   * which is not stored in the project (the `pdvc` chunk is an empty `{}`,
   * unlike `PwCs`/`working_space` which embeds the full ICC), so assigning
   * raises {@link NotImplementedError}.
   *
   * **Note:** Not exposed in ExtendScript
   */
  get displayColorSpace(): string {
    if (this._dcsUtf8 != null) return envelopeProfileName(this._dcsUtf8.value);
    return "None";
  }

  set displayColorSpace(value: [string, string] | string) {
    if (this.colorManagementSystem !== ColorManagementSystem.OCIO) {
      throw new NotImplementedError(
        "displayColorSpace is only settable in OCIO mode. In Adobe " +
          "CMS the display uses the operating system's monitor profile, " +
          "which is not stored in the project.",
      );
    }
    let display: string;
    let view: string;
    if (typeof value === "string") {
      // rpartition("/")
      const idx = value.lastIndexOf("/");
      const sep = idx >= 0 ? "/" : "";
      display = idx >= 0 ? value.slice(0, idx) : "";
      view = idx >= 0 ? value.slice(idx + 1) : value;
      if (!sep) {
        throw new ValueError(
          "displayColorSpace string must be 'display/view'; got " +
            `${repr(value)}. Pass a (display, view) tuple to disambiguate.`,
        );
      }
    } else if (Array.isArray(value) && value.length === 2) {
      [display, view] = value;
    } else {
      throw new TypeError_(
        "displayColorSpace expects a 'display/view' string or a " +
          `(display, view) tuple, got ${typeName(value)}`,
      );
    }
    validateString(display);
    validateString(view);
    const envelope = buildOcioDisplayEnvelope(display, view);
    this._dcsUtf8 = this._rewriteColorProfile("pdvc", envelope);
  }

  /**
   * Rewrite the `Utf8` color-profile chunk that follows `marker`.
   *
   * `marker` is the flag chunk (`PwCs` working space, `pdvc` display space)
   * that AE writes immediately before the profile-JSON `Utf8`. The chunk
   * pair exists in every project AE saved in OCIO mode (the `Utf8` is `{}`
   * when unset), so this rewrites in place.
   *
   * @throws {@link ValueError} If the marker chunk is absent - color management is not initialized
   *   in this project (a brand-new project, or one from a pre-2022 After Effects, has no
   *   color-profile chunk to rewrite).
   */
  _rewriteColorProfile(marker: string, envelope: string): Utf8Chunk {
    const root = this._rootChunks;
    for (const [i, chunk] of root.entries()) {
      if (chunk.chunkType === marker) {
        const utf8 = findByTypeOrNull(root.slice(i + 1, i + 2), "Utf8");
        if (utf8 !== null) {
          utf8.value = envelope;
          return utf8;
        }
        break;
      }
    }
    throw new ValueError(
      `No '${marker}' color-profile chunk to write: color management is ` +
        "not initialized in this project. The project must be saved by " +
        "After Effects (2022+) with color management enabled before its " +
        "working/display color space can be set.",
    );
  }

  /**
   * The color management system used by the project (Adobe or OCIO).
   * Available in CC 2024 and later. Read / Write.
   */
  get colorManagementSystem(): ColorManagementSystem {
    const settings = this._getCmsSettings();
    return ColorManagementSystem.of(jsonInt(getitem(settings, "colorManagementSystem")));
  }

  set colorManagementSystem(value: ColorManagementSystem | number) {
    _setColorManagementSystem.call(this, value);
  }

  /**
   * The LUT interpolation method for the project (Trilinear or
   * Tetrahedral). Read / Write.
   */
  get lutInterpolationMethod(): LutInterpolationMethod {
    const settings = this._getCmsSettings();
    return LutInterpolationMethod.of(jsonInt(getitem(settings, "lutInterpolationMethod")));
  }

  set lutInterpolationMethod(value: LutInterpolationMethod | number) {
    _setLutInterpolationMethod.call(this, value);
  }

  /**
   * The OCIO configuration file for the project. Only relevant when
   * color_management_system is OCIO. Read / Write.
   */
  get ocioConfigurationFile(): string {
    const settings = this._getCmsSettings();
    return str(getitem(settings, "ocioConfigurationFile"));
  }

  set ocioConfigurationFile(value: PathLike) {
    _setOcioConfigurationFile.call(this, value);
  }

  /**
   * Return the color-space names assignable in the current CMS mode.
   *
   * These are the names valid for {@link workingSpace} (and, in Adobe mode,
   * [media_color_space][
   * py_aep.models.sources.footage.FootageSource.mediaColorSpace] and the
   * output color space).
   *
   * - Adobe CMS: the catalogued Adobe ICC profile names.
   * - OCIO: the active color spaces of {@link ocioConfigurationFile} (a `.ocio`
   *   path or a built-in name like `"ACES 1.2"`). Returns `[]` if the config
   *   cannot be located or read.
   */
  listColorProfiles(): string[] {
    if (this.colorManagementSystem === ColorManagementSystem.OCIO) {
      const configPath = resolveOcioConfig(this.ocioConfigurationFile);
      if (configPath == null) return [];
      return listConfigColorSpaces(configPath);
    }
    return adobeColorProfileNames();
  }

  /** The name of the project, derived from the file name. */
  get projectName(): string {
    return new Path(this.file).name;
  }

  /**
   * Return the number of items in the project.
   *
   * **Note:** Equivalent to `len(project.items)`
   */
  get numItems(): number {
    return this.items.size;
  }

  /** Get a layer by its unique ID. */
  layerById(layerId: number): Layer {
    for (const comp of this.compositions) {
      const layer = comp.layersById.get(layerId);
      if (layer !== undefined) return layer;
    }
    throw new KeyError(`Layer with ID ${layerId} not found`);
  }

  /** All the compositions in the project. */
  get compositions(): CompItem[] {
    return [...this.items.values()].filter((item): item is CompItem => item instanceof CompItem);
  }

  /** All the folders in the project. */
  get folders(): FolderItem[] {
    return [...this.items.values()].filter((item): item is FolderItem => item instanceof FolderItem);
  }

  /** All the footages in the project. */
  get footages(): FootageItem[] {
    return [...this.items.values()].filter((item): item is FootageItem => item instanceof FootageItem);
  }

  /**
   * Import a placeholder footage item into the project root folder.
   *
   * @param name - The placeholder name. Pass `null` to use `Missing Name`. An empty string becomes
   *   `Placeholder`.
   * @param width - Width in pixels (4-30000).
   * @param height - Height in pixels (4-30000).
   * @param frameRate - Frame rate in fps (1.0-99.0).
   * @param duration - Duration in seconds (\> 0, \<= 10800).
   * @returns The newly created {@link FootageItem}.
   */
  importPlaceholder(
    name: string | null,
    width: number,
    height: number,
    frameRate: number,
    duration: number,
  ): FootageItem {
    if (name == null) {
      name = "Missing Name";
    } else if (name === "") {
      name = "Placeholder";
    }

    const source = PlaceholderSource._new(name, width, height, frameRate, duration);
    const item = FootageItem._new(source, { project: this, parentFolder: this.rootFolder });

    // Insert into root folder's chunk tree and register
    const container = this.rootFolder._childrenContainer;
    container.push(item._itemList);
    container.push(...item._viewData);
    this.items.set(item.id, item);
    this.rootFolder.items.push(item);
    return item;
  }

  /**
   * Imports the file specified in the specified ImportOptions object, using the
   * specified options. Same as the File \> Import File command.
   *
   * For `ImportAsType.FOOTAGE`, creates and returns a new FootageItem.
   * For `ImportAsType.COMP` on a layered Illustrator/PDF (`.ai`, `.pdf`) or
   * Photoshop (`.psd`, `.psb`) file, creates a composition with one footage
   * layer per source layer (each referencing the same file) and returns
   * that {@link CompItem}. `ImportAsType.COMP_CROPPED_LAYERS` on those files
   * crops each layer's footage to its content and places the layer where
   * that content sits. On an SVG, it converts the vector artwork into a
   * new composition holding a single shape layer and returns that
   * {@link CompItem} (unlike ExtendScript, where `importFile` returns `null`
   * for an SVG).
   *
   * @param options - The import settings. `ImportAsType.FOOTAGE`, `COMP` (layered
   *   `.ai`/`.pdf`/`.psd`/`.psb`), and `COMP_CROPPED_LAYERS` (the same files, and SVG) are
   *   supported. With `ImportOptions.layerIndex` set (py_aep extension mirroring the "Choose
   *   Layer" option of AE's import dialog), a FOOTAGE import of a layered file references that
   *   single layer instead of the merged/whole document; see also `ImportOptions.layerDimensions`
   *   and `py_aep.list_layers`.
   * @returns The newly created {@link FootageItem} or {@link CompItem}.
   * @throws {@link ValueError} If `import_as` is unsupported for the file, if the file extension is
   *   not a supported format, if `sequence` is set for a format AE does not import as a sequence
   *   (movies, audio, HEIC, FBX, data files), or if the file has no track After Effects can decode
   *   (e.g. an AV1-only `.mp4`, which AE itself refuses to import).
   * @throws {@link NotImplementedError} If media-header probing is not implemented for the file's
   *   format, or if merged PSD layer styles include a Stroke Emboss bevel, whose rasterized bounds
   *   are not known.
   * @throws {@link UnsupportedSVGError} If the SVG uses features py_aep cannot import.
   * @throws {@link UnsupportedAiLayersError} If a layered `.ai`/`.pdf` import is requested but the
   *   file exposes no PDF Optional Content Groups (e.g. saved without PDF compatibility), or if
   *   `layer_dimensions="layer"` is requested for one whose page content py_aep cannot read (see
   *   `resolvers.ai_bounds`).
   * @throws {@link UnsupportedPsdLayersError} If a `.psd`/`.psb` COMP import is requested but the
   *   file is not a valid Photoshop document.
   */
  importFile(options: ImportOptions): FootageItem | CompItem {
    if (!(options instanceof ImportOptions)) {
      throw new ValueError(`Expected ImportOptions, got ${typeName(options)}`);
    }

    if (options.layerIndex != null) {
      if (options.importAs !== ImportAsType.FOOTAGE) {
        throw new ValueError(
          "layerIndex applies to ImportAsType.FOOTAGE only; COMP " + "imports include every layer",
        );
      }
      if (options.sequence) {
        throw new ValueError("layerIndex cannot be combined with sequence");
      }
    } else if (options.layerDimensions != null) {
      throw new ValueError("layerDimensions requires layerIndex");
    }

    const suffix = options.file.suffix.toLowerCase();
    if (options.layerStyles != null) {
      if (!PSD_COMP_EXTENSIONS.has(suffix)) {
        throw new ValueError("layerStyles applies to Photoshop (.psd/.psb) imports only");
      }
      if (options.importAs === ImportAsType.FOOTAGE) {
        if (options.layerIndex == null) {
          throw new ValueError(
            "layerStyles requires layerIndex for a FOOTAGE " +
              'import: a "Merged Layers" whole-document import ' +
              "always flattens the styles into the composite",
          );
        }
        if (options.layerStyles === "editable") {
          throw new ValueError(
            "editable layer styles require a COMP import; a " +
              'FOOTAGE import offers "merge" or "ignore"',
          );
        }
      } else if (options.layerStyles === "ignore") {
        throw new ValueError(
          'a COMP import offers "editable" or "merge" layer ' +
            "styles (AE's dialog has no Ignore option there)",
        );
      }
    }
    if (options.importAs === ImportAsType.COMP_CROPPED_LAYERS) {
      if (suffix === ".svg") {
        return this._importSvgCropped(options.file);
      }
      if (PSD_COMP_EXTENSIONS.has(suffix)) {
        return this._importPsdLayered(options.file, true, this._resolveCompLayerStyles(options));
      }
      if (AI_COMP_EXTENSIONS.has(suffix)) {
        return this._importAiLayered(options.file, { cropped: true });
      }
      throw new ValueError(
        "importFile supports COMP_CROPPED_LAYERS for SVG and layered " +
          `.ai/.pdf/.psd/.psb; ${suffix} cropped import is not implemented yet`,
      );
    }
    if (options.importAs === ImportAsType.COMP) {
      if (AI_COMP_EXTENSIONS.has(suffix)) {
        return this._importAiLayered(options.file);
      }
      if (EPS_COMP_EXTENSIONS.has(suffix)) {
        return this._importEpsComp(options.file);
      }
      if (PSD_COMP_EXTENSIONS.has(suffix)) {
        return this._importPsdLayered(options.file, false, this._resolveCompLayerStyles(options));
      }
      throw new ValueError(`importFile does not support COMP import for ${repr(suffix)}`);
    }
    if (options.importAs === ImportAsType.PROJECT) {
      throw new ValueError(
        "importFile does not support PROJECT import (importing an " + ".aep/.aet, or an AE project embedded in a .mov/.m4a)",
      );
    }
    if (options.importAs !== ImportAsType.FOOTAGE) {
      throw new ValueError(
        "importFile supports ImportAsType.FOOTAGE, COMP (layered " +
          ".ai/.pdf/.psd/.psb), and COMP_CROPPED_LAYERS (SVG, " +
          ".ai/.pdf/.psd/.psb), " +
          `got ${ImportAsType.nameOf(options.importAs)}`,
      );
    }

    let source: FileSource;
    if (options.layerIndex != null) {
      // Fill unset PSD layer-import choices from the machine's sticky
      // import-dialog preferences, as AE's own importFile does.
      //
      // AI/PDF has an equivalent "AI Dimensions Popup" preference that
      // is deliberately NOT followed. Measured on AE 2026: a scripted
      // importFile of an .ai produces the identical full-document
      // footage at either index, with or without an explicit
      // `importAs`, because a scripted import is always merged-layers
      // and Layer Size means nothing without a chosen layer. That
      // preference only steers the interactive dialog, so honouring it
      // here would diverge from importFile rather than mirror it. An
      // AI/PDF layer import therefore keeps None, its "document"
      // downstream default.
      let dimensions = options.layerDimensions;
      let styles = options.layerStyles;
      if (PSD_COMP_EXTENSIONS.has(suffix)) {
        if (styles == null) styles = psdFootageLayerStyles(this._preferences);
        if (dimensions == null) dimensions = psdFootageDimensions(this._preferences);
      }
      source = FileSource._fromLayer(options.file, options.layerIndex, {
        dimensions,
        layerStyles: styles,
        windows: this._windows,
      });
    } else {
      source = FileSource._fromFile(options.file, {
        sequence: options.sequence,
        forceAlphabetical: options.forceAlphabetical,
        windows: this._windows,
        defaultSequenceFps: defaultSequenceFps(this._preferences),
        rangeStart: options.sequence ? options.rangeStart : 0,
        rangeEnd: options.sequence ? options.rangeEnd : 0,
      });
    }

    const item = FootageItem._new(source, { project: this, parentFolder: this.rootFolder });
    const container = this.rootFolder._childrenContainer;
    container.push(item._itemList);
    container.push(...item._viewData);
    this.items.set(item.id, item);
    this.rootFolder.items.push(item);
    return item;
  }

  /**
   * The COMP-import Layer Options value: the user's explicit choice, or
   * the machine's sticky PSD-comp import preference. `null` (no preference,
   * or no preferences directory) keeps AE's `editable` dialog default.
   */
  _resolveCompLayerStyles(options: ImportOptions): string | null {
    if (options.layerStyles != null) return options.layerStyles;
    return psdCompLayerStyles(this._preferences);
  }

  /** Import an SVG as a cropped comp (one shape layer of its art). */
  _importSvgCropped(file: Path): CompItem {
    const doc = readSvg(file);
    // AE truncates the canvas to whole pixels (2434.9 -> 2434).
    const width = int(doc.width);
    const height = int(doc.height);
    if (!(1 <= width && width <= 30000 && 1 <= height && height <= 30000)) {
      // AE's own import refuses a canvas under 1 px a side ("width and
      // height must be > 0") but builds 1 to 3 px compositions, below
      // the 4 px `addComp` floor (AE 2026).
      throw new UnsupportedSVGError(
        `SVG canvas ${format(doc.width, "g")} x ${format(doc.height, "g")} is outside the ` +
          "1 to 30000 px composition size range (width / height or " +
          "viewBox missing, invalid or out of range)",
      );
    }
    // AE creates a 1-frame, 30 fps comp named after the file.
    // (add_comp front-inserts the comp to match AE's import ordering.)
    const comp = this.rootFolder._addComp(file.name, width, height, 1.0, 1.0 / 30.0, 30.0, {
      minDimension: 1,
    });
    const layer = comp.addShape();
    layer.name = file.name;
    // Vertices are baked in absolute viewBox coordinates, so an identity
    // layer transform (anchor and position at the origin) maps shape
    // local space 1:1 onto the comp. (AE centres the layer instead, but
    // it stores the shape-layer anchor scaled by comp size, which
    // py_aep does not model; the origin avoids that and renders the
    // same.)
    const transform = layer.transform;
    transform.property("ADBE Anchor Point").value = [0.0, 0.0, 0.0];
    transform.property("ADBE Position").value = [0.0, 0.0, 0.0];
    const contents = layer.property("ADBE Root Vectors Group");
    buildShapeLayerContents(contents, doc.drawables);
    return comp;
  }

  /**
   * Create an import composition (full canvas and the file's pixel
   * aspect - AE 2026 gives a 4:3 PSD a 4:3 comp - at AE's default
   * timing).
   */
  _newLayeredComp(
    parentFolder: FolderItem,
    name: string,
    width: number,
    height: number,
    pixelAspect: number,
  ): CompItem {
    const frames = round(_LAYERED_COMP_DURATION_SECONDS * _LAYERED_COMP_FRAME_RATE);
    const comp = parentFolder.addComp(
      name,
      width,
      height,
      pixelAspect,
      frames / _LAYERED_COMP_FRAME_RATE,
      _LAYERED_COMP_FRAME_RATE,
    );
    // AE gives a layered-import comp shutter phase -90 (unlike a
    // script-created comp, which AE leaves at 0 - as add_comp's skeleton
    // does); so set it only here, on the import path.
    comp.shutterPhase = -90;
    return comp;
  }

  /**
   * Build the composition shared by every layered-file import.
   *
   * Mirrors AE's File \> Import as Composition: a `<stem> Layers` folder
   * holding one footage item per leaf layer (each referencing the same file
   * with its layer selected in the opti) and one nested composition per
   * layer group, plus a composition with one layer per top-level spec,
   * stacked in document order (the last layer on top, matching AE).
   *
   * @param file - The source file every per-layer footage item references.
   * @param sourceFormat - The `sspc` source-format code (`TEXT`, `8BPS`, ...).
   * @param layerSpecs - Top-level {@link LayerSpec}/{@link LayerGroupSpec} nodes, in document
   *   order (bottom layer first).
   * @param info - The probed media info for `file` (canvas size, alpha, ...).
   * @param embeddedProfileName - Optional ICC profile name for the sources.
   */
  _importLayeredComp(
    file: Path,
    sourceFormat: string,
    layerSpecs: (LayerSpec | LayerGroupSpec)[],
    info: MediaInfo,
    embeddedProfileName: string | null = null,
  ): CompItem {
    // Before anything is added: every layer's footage spans the canvas.
    checkFootageSize(file.name, info.width, info.height);
    const folder = this.rootFolder.addFolder(`${file.stem} Layers`);
    const comp = this._newLayeredComp(this.rootFolder, file.stem, info.width, info.height, info.pixelAspect);
    this._addLayeredSpecs(comp, folder, layerSpecs, file, sourceFormat, info, embeddedProfileName);
    // AE stores the `<stem> Layers` folder's Sfdr in the Project-panel
    // alphabetical order, not the document order the items are built in
    // (verified against the grouped_layers / layer_bounds AE fixtures).
    folder._sortChildrenByName();
    // AE places the `<stem> Layers` folder immediately after the comp (before
    // the project's pre-existing items); add_folder appended it, so move it
    // into position to match AE's Fold ordering.
    const container = this.rootFolder._childrenContainer;
    container.splice(indexByIdentity(container, folder._itemList), 1);
    const compIdx = indexByIdentity(container, comp._itemList);
    container.splice(compIdx + 1 + comp._viewData.length, 0, folder._itemList);
    return comp;
  }

  /**
   * Add one layer per spec to `comp` (groups become nested comps).
   *
   * Leaf footage items and nested group comps both live in `folder`,
   * matching AE's flat `<stem> Layers` folder.
   */
  _addLayeredSpecs(
    comp: CompItem,
    folder: FolderItem,
    specs: (LayerSpec | LayerGroupSpec)[],
    file: Path,
    sourceFormat: string,
    info: MediaInfo,
    embeddedProfileName: string | null,
  ): void {
    for (const spec of specs) {
      if (spec instanceof LayerGroupSpec) {
        const nested = this._newLayeredComp(
          folder,
          spec.compName != null ? spec.compName : spec.name,
          info.width,
          info.height,
          info.pixelAspect,
        );
        this._addLayeredSpecs(nested, folder, spec.children, file, sourceFormat, info, embeddedProfileName);
        // AE imports a PSD group as a collapsed precomp and leaves the
        // layer name empty (it inherits the nested comp's name), so
        // `name_set` stays off - matching avoids both deltas. A
        // clipping-run precomp instead bakes the base layer's name
        // (still with `name_set` off) and stays uncollapsed.
        const groupLayer = comp.add(nested);
        if (spec.collapsed) groupLayer.collapseTransformation = true;
        if (!spec.enabled) groupLayer.enabled = false;
        if (spec.layerName != null) {
          groupLayer.name = spec.layerName;
          groupLayer._ldta.nameSet = false;
        }
        _serializeImportLayerStyles(groupLayer, null, file.name);
        continue;
      }
      const hasAlpha = spec.hasAlpha == null ? info.hasAlpha : spec.hasAlpha;
      const depth = spec.depth == null ? info.depth : spec.depth;
      const source = FileSource._new(file, {
        sourceFormat,
        width: spec.width,
        height: spec.height,
        duration: 0.0,
        frameRate: 0.0,
        pixelAspect: info.pixelAspect,
        iccProfile: info.iccProfile,
        hasAlpha,
        depth,
        optiData: spec.optiData,
        embeddedProfileName,
        fullFrame: spec.fullFrame,
        layerName: spec.layerIndex != null ? spec.name : "",
        layerId: spec.layerId,
        layerIndex: spec.layerIndex,
        dataSize: spec.dataSize,
        reservedC8: spec.reservedC8,
        colorMode: info.colorMode,
        windows: this._windows,
      });
      const footage = FootageItem._new(source, { project: this, parentFolder: folder });
      folder._childrenContainer.push(footage._itemList);
      folder._childrenContainer.push(...footage._viewData);
      this.items.set(footage.id, footage);
      folder.items.push(footage);
      const layer = comp.add(footage);
      // AE 2026 cuts an imported layer's name to its longest UTF-8
      // prefix of 255 bytes (a 313-byte Photoshop layer name).
      layer.name = decode(truncateUtf8(spec.name, 255), "utf-8");
      if (!spec.enabled) layer.enabled = false;
      if (spec.transform != null) {
        const [[anchorX, anchorY], [positionX, positionY]] = spec.transform;
        const transform = layer.transform;
        transform.property("ADBE Anchor Point").value = [anchorX, anchorY, 0.0];
        transform.property("ADBE Position").value = [positionX, positionY, 0.0];
      }
      if (spec.isAdjustment) layer.adjustmentLayer = true;
      if (spec.preserveTransparency) layer.preserveTransparency = true;
      if (spec.masks?.length > 0) {
        // A PSD vector-mask/shape-layer path: AE creates one mask
        // per subpath (psd_vector_mask* fixtures).
        const parade = layer.property("ADBE Mask Parade");
        for (const shape of spec.masks) {
          const mask = parade.addProperty("ADBE Mask Atom");
          mask.property("ADBE Mask Shape").value = shape;
        }
      }
      _serializeImportLayerStyles(layer, spec.styles, file.name);
    }
  }

  /**
   * Import a layered Illustrator/PDF file as a composition.
   *
   * `cropped` is Composition - Retain Layer Sizes: each layer's footage
   * takes its "Layer Size" artwork box (`resolvers.ai_bounds`) and the
   * comp layer is placed where that box sits on the page.
   */
  _importAiLayered(file: Path, kw: { cropped?: boolean } = {}): CompItem {
    const { cropped = false } = kw;
    // Read once: the probe, the ICC scan and the layer scan all consume
    // the same bytes.
    const data = file.readBytes();
    let info = probeMedia(file, data);
    // The page's RGB profile is embedded like a raster file's; a non-RGB
    // one is recorded by name.
    const [icc, profileName] = aiDocumentProfile(file, data);
    info = new MediaInfo({ ...info, iccProfile: icc }); // info._replace(icc_profile=icc)
    const layers = readAiLayerOcgs(file, data);
    const boxes = cropped ? readAiLayerBounds(file, data) : null;
    const specs: (LayerSpec | LayerGroupSpec)[] = [];
    for (const [index, layer] of layers.entries()) {
      let box: Box | null = null;
      let width = info.width;
      let height = info.height;
      let transform: [[number, number], [number, number]] | null = null;
      if (boxes != null) {
        const measured = boxes[index];
        box = measured == null ? EMPTY_BOX : measured;
        [width, height] = footageSize(measured);
        transform = _aiCroppedTransform(box, info.height);
      }
      specs.push(
        new LayerSpec(
          layer.name,
          buildAiLayerOptiData(info.width, info.height, layer.name, layers.length, box, layer.visible),
          width,
          height,
          transform,
          !cropped,
          undefined,
          undefined,
          index,
          data.length,
          undefined,
          undefined,
          undefined,
          undefined,
          layer.visible,
        ),
      );
    }
    return this._importLayeredComp(file, "TEXT", specs, info, profileName);
  }

  /**
   * Import an EPS as a single-layer composition.
   *
   * EPS is single-stream PostScript with no Optional Content Groups (the
   * layer mechanism `read_ai_layers` relies on for `.ai`/`.pdf`), so AE
   * rasterizes it to one full-canvas layer. Verified against AE 2026:
   * importing `eps.eps` yields a 1-layer comp whose footage carries the
   * bare `TEXT` opti (no per-layer name/index/bbox - those stay zero,
   * unlike a real AI layer), byte-matched against an AE-resaved import.
   *
   * EPS carries no embedded ICC profile (`read_ai_color_info` needs a PDF
   * object structure EPS lacks), so the footage is left untagged. AE instead
   * tags such footage with the project working space (sRGB by default); that
   * is a general color-management-on-import default py_aep does not yet apply
   * to any no-embedded-profile import, not an EPS-specific gap.
   */
  _importEpsComp(file: Path): CompItem {
    const info = probeMedia(file);
    const spec = new LayerSpec(file.name, buildTextOptiData(info.width, info.height), info.width, info.height);
    return this._importLayeredComp(file, "TEXT", [spec], info, null);
  }

  /**
   * Import a layered Photoshop file (`.psd`/`.psb`) as a composition.
   *
   * Layer groups become nested compositions (recursively); adjustment
   * layers are flagged. With `cropped`, each leaf layer is cropped to its
   * content box (`COMP_CROPPED_LAYERS`); otherwise the full canvas is kept
   * (`COMP`). `layerStyles` is the dialog's Layer Options choice
   * (`"editable"`, the default, or `"merge"`; see
   * `ImportOptions.layerStyles`).
   *
   * A flattened file (no layer records) is imported as a one-layer
   * composition of the merged still, matching AE 2026: a `<stem> Layers`
   * folder holding one footage item that references the file, and a comp
   * with a single full-canvas layer named after the file.
   */
  _importPsdLayered(file: Path, cropped = false, layerStyles: string | null = null): CompItem {
    const info = probeMedia(file);
    let nodes: PsdNode[];
    try {
      nodes = readPsdLayers(file);
    } catch (e) {
      if (!(e instanceof FlattenedPsdError)) throw e;
      const spec = new LayerSpec(
        file.name,
        buildPsdFlattenedOptiData(info.width, info.height, info.bitDepth, info.pixelChannels, {
          colorMode: info.colorMode,
        }),
        info.width,
        info.height,
        undefined,
        // AE marks the flattened merged-still layer as not spanning a
        // full frame and caches its actual channel count (both from
        // the flattened_rgb_comp.aep fixture).
        false,
        undefined,
        undefined,
        undefined,
        pixelBufferSize(info.width, info.height, info.pixelChannels, info.bitDepth),
      );
      return this._importLayeredComp(file, "8BPS", [spec], info, namedMediaProfile("8BPS", info));
    }
    const resolvedStyles = layerStyles == null ? "editable" : layerStyles;
    const specs = this._psdLayerSpecs(
      nodes,
      file,
      info,
      cropped,
      resolvedStyles,
      // The global light is a document constant; read it once here
      // rather than per recursion level (one file scan per group).
      readGlobalLight(file),
    );
    return this._importLayeredComp(file, "8BPS", specs, info, namedMediaProfile("8BPS", info));
  }

  /**
   * Convert a PSD layer tree into import specs (recursively).
   *
   * `info` is the probed document (canvas, bit depth, layer count,
   * channels). `clip_counter` numbers the clipping-run precomps
   * document-wide (AE names them `"<stem> (n)"`); `group_clipping=False`
   * disables run detection while building a run's own children.
   */
  _psdLayerSpecs(
    nodes: PsdNode[],
    file: Path,
    info: MediaInfo,
    cropped: boolean,
    layerStyles: string,
    globalLight: [number, number],
    clipCounter: Generator<number> | null = null,
    groupClipping = true,
  ): (LayerSpec | LayerGroupSpec)[] {
    const canvasW = info.width;
    const canvasH = info.height;
    if (clipCounter == null) clipCounter = count(1);
    const reservedC8 = getitem(PSD_LAYER_STYLES_C8, layerStyles);
    const specs: (LayerSpec | LayerGroupSpec)[] = [];
    let index = 0;
    while (index < nodes.length) {
      const node = nodes[index];
      index += 1;
      if (node instanceof PsdGroup) {
        if (hasEnabledStyles(node)) {
          // Photoshop allows styles on a group; applying them to
          // the nested-comp layer is not supported yet.
          warn(
            `${file.name}: styles on layer group ${repr(node.name)} ` +
              "were ignored - importing group layer styles is " +
              "not supported",
          );
        }
        specs.push(
          new LayerGroupSpec(
            node.name,
            this._psdLayerSpecs(node.children, file, info, cropped, layerStyles, globalLight, clipCounter),
            undefined,
            undefined,
            undefined,
            node.visible,
          ),
        );
        continue;
      }
      if (groupClipping && !node.clipped) {
        // A clipping run (this base + the clipped layers above it)
        // is auto-precomposed by AE: nested comp "<stem> (n)", the
        // base's name baked on the uncollapsed parent layer, and
        // preserve-transparency on the clipped members
        // (psd_clipping_mask fixture).
        const run = [node];
        while (index < nodes.length) {
          const next = nodes[index];
          if (!(next instanceof PsdLayer && next.clipped)) break;
          run.push(next);
          index += 1;
        }
        if (run.length > 1) {
          specs.push(
            new LayerGroupSpec(
              node.name,
              this._psdLayerSpecs(run, file, info, cropped, layerStyles, globalLight, clipCounter, false),
              `${file.stem} (${clipCounter.next().value})`,
              node.name,
              false,
              undefined,
            ),
          );
          continue;
        }
      }
      const styles = layerStyles === "editable" ? parseLayerStyles(node, globalLight) : null;
      // AE stores the content box and crops the layer to it.
      const footage = psdLayerFootage(info, node, layerStyles, globalLight[0]);
      const [left, top, right, bottom] = footage.box;
      let masks: Shape[] = [];
      if (node.vectorMask != null) {
        masks = parseVectorMask(node.vectorMask, canvasW, canvasH);
      }
      if (cropped) {
        // An empty layer (degenerate content box) is kept at FULL
        // CANVAS size, centered - not cropped to 1x1 (probed AE 2026:
        // psd_clipping_mask "Layer 1" and grouped_layers "hue/sat adj"
        // both bounds (0,0,0,0) -> full-canvas, centered).
        let box: [number, number, number, number];
        if (right <= left || bottom <= top) {
          box = [0, 0, canvasW, canvasH];
        } else {
          box = [left, top, right, bottom];
        }
        const [bLeft, bTop, bRight, bBottom] = box;
        const cropW = bRight - bLeft;
        const cropH = bBottom - bTop;
        // Anchor at the cropped footage centre; position the layer so the
        // content sits where it was in the document (AE 2026 verified).
        const transform: [[number, number], [number, number]] = [
          [cropW / 2, cropH / 2],
          [(bLeft + bRight) / 2, (bTop + bBottom) / 2],
        ];
        // Mask vertices are canvas coordinates; a cropped layer's
        // source origin is the content box.
        masks = masks.map(
          (shape) =>
            new Shape(
              shape.vertices.map(([x, y]) => [x - bLeft, y - bTop]),
              shape.inTangents,
              shape.outTangents,
              { closed: shape.closed },
            ),
        );
        specs.push(
          new LayerSpec(
            node.name,
            footage.optiData,
            cropW,
            cropH,
            transform,
            false,
            node.isAdjustment,
            node.layerId,
            node.recordIndex,
            // Empty layers have no pixels: data_size stays 0 (from
            // the real bounds), even though the layer is full-canvas.
            footage.dataSize,
            reservedC8,
            styles,
            masks,
            !groupClipping && node.clipped,
            node.visible,
            footage.hasAlpha,
            footage.depth,
          ),
        );
      } else {
        specs.push(
          new LayerSpec(
            node.name,
            footage.optiData,
            canvasW,
            canvasH,
            undefined,
            undefined,
            node.isAdjustment,
            node.layerId,
            node.recordIndex,
            footage.dataSize,
            reservedC8,
            styles,
            masks,
            !groupClipping && node.clipped,
            node.visible,
            footage.hasAlpha,
            footage.depth,
          ),
        );
      }
    }
    return specs;
  }

  *_iterTextSourceProperties(): Generator<[Layer, Property<TextDocument>]> {
    /** Yield `(layer, source_text)` for every text layer in the project. */
    for (const comp of this.compositions) {
      for (const layer of comp.layers) {
        const group = layer.text;
        if (group == null) continue;
        const sourceText = group.property("ADBE Text Document");
        if (sourceText instanceof Property) yield [layer, sourceText];
      }
    }
  }

  /**
   * Returns an Array of Objects containing references to used fonts
   * and the Text Layers and times on which they appear in the current
   * Project. Read-only.
   *
   * Each entry is `{"font": FontObject, "usedAt": [...]}`, where every
   * `usedAt` record is `{"layer_id": int, "layerTime": float}` - one
   * per source-text keyframe whose document references that font (a
   * single record at time 0 for an unanimated document). A document
   * with several fonts contributes one record per distinct font.
   * Entries are sorted by PostScript name, matching After Effects.
   *
   * **Note:** `layerTime` is in LAYER time, not composition time - After
   * Effects names it `layerTimeD` because `Source Text`'s
   * `value_at_time` expects layer time, unlike other properties.
   */
  get usedFonts(): { font: FontObject; usedAt: { layerId: number; layerTime: number }[] }[] {
    const records = new Map<
      string,
      { name: string; font: FontObject; usedAt: { layerId: number; layerTime: number }[] }
    >();
    for (const [layer, sourceText] of this._iterTextSourceProperties()) {
      let entries: [TextDocument, number][];
      if (sourceText.keyframes?.length > 0) {
        entries = sourceText.keyframes.map(
          (kf) => [kf.value, kf.time - layer.startTime],
        );
      } else {
        entries = [[sourceText.value, 0.0]];
      }
      for (const [doc, layerTime] of entries) {
        if (doc == null) continue;
        for (const font of doc._usedFontObjects()) {
          const vector = font.designVector;
          const key = tkey(font.postScriptName, font.version, vector != null ? [...vector] : null);
          let record = records.get(key);
          if (record == null) {
            record = { name: font.postScriptName, font, usedAt: [] };
            records.set(key, record);
          }
          record.usedAt.push({ layerId: layer.id, layerTime });
        }
      }
    }
    return sorted([...records.values()], (r) => r.name).map((r) => ({ font: r.font, usedAt: r.usedAt }));
  }

  /**
   * Replace all usages of `from_font` with `to_font`.
   *
   * A complete and precise replacement, even on text documents with
   * mixed styling: the character ranges `from_font` was applied to are
   * preserved, and every source-text keyframe of every text layer is
   * covered. This operation is not undoable.
   *
   * Each font may be given as a {@link FontObject} (e.g. from
   * {@link Project.usedFonts | used_fonts}) or as a PostScript name.
   *
   * @param fromFont - Font to be replaced.
   * @param toFont - Font to replace it with.
   * @param noFontLocking - Accepted for ExtendScript parity and ignored. After Effects uses it to
   *   suppress the fallback font it picks when `to_font` lacks glyphs for the text; that fallback
   *   is a runtime font-engine decision py_aep does not make, so py_aep always performs the direct
   *   replacement (i.e. it behaves as if this were `true`).
   * @returns `true` if at least one layer was changed.
   */
  replaceFont(fromFont: FontObject | string, toFont: FontObject | string, noFontLocking = false): boolean {
    validateBool(noFontLocking);
    const fromName = _fontPostScriptName(fromFont);
    const toName = _fontPostScriptName(toFont);
    if (fromName === toName) return false;

    let changed = false;
    for (const [, sourceText] of this._iterTextSourceProperties()) {
      let docs = sourceText.keyframes.map((kf) => kf.value);
      if (!docs?.length) docs = [sourceText.value];
      docs = docs.filter((doc) => doc != null);
      if (docs?.length > 0 && _replaceLayerFont(docs, fromName, toName)) changed = true;
    }
    return changed;
  }

  /**
   * Automatically replaces text found in broken expressions in the
   * project, if the new text causes the expression to evaluate without
   * errors.
   *
   * py_aep cannot evaluate expressions, and After Effects' actual gate
   * (is the expression currently erroring) is runtime state that is not
   * stored in the project file. Instead, py_aep replaces the quoted
   * forms `"old_text"` and `'old_text'` in EVERY enabled expression of
   * the project. Divergence from After Effects (probed AE 2026): an
   * expression that evaluates cleanly but contains the quoted text is
   * rewritten here, while After Effects leaves it untouched. Matching
   * After Effects: disabled expressions are never modified, both quote
   * styles are fixed, and quoted occurrences inside comments of a
   * rewritten expression are replaced too.
   *
   * @param oldText - The text to replace.
   * @param newText - The new text.
   */
  autoFixExpressions(oldText: string, newText: string): void {
    validateString(oldText);
    validateString(newText);
    if (!oldText) return;
    const oldDouble = `"${oldText}"`;
    const newDouble = `"${newText}"`;
    const oldSingle = `'${oldText}'`;
    const newSingle = `'${newText}'`;

    for (const comp of this.compositions) {
      for (const layer of comp.layers) {
        for (const prop of layer._leafProperties()) {
          const expression = prop.expression;
          if (!expression || !prop.expressionEnabled) continue;
          // Python `str.replace` replaces every occurrence and takes no
          // replacement escapes, so split/join is the literal equivalent.
          const fixed = expression.split(oldDouble).join(newDouble).split(oldSingle).join(newSingle);
          if (fixed !== expression) prop.expression = fixed;
        }
      }
    }
  }

  /**
   * Remove footage items that are not used in any composition.
   *
   * Same as the File \> Remove Unused Footage command.
   *
   * @returns The total number of footage items removed.
   */
  removeUnusedFootage(): number {
    let removed = 0;
    for (const footage of this.footages) {
      if (!footage.usedIn?.length) {
        footage.remove();
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Remove all items except those specified and the items they use.
   *
   * Same as the File \> Reduce Project command. For each kept composition,
   * the items it uses (and their dependencies, recursively) are also kept.
   * The folders containing kept items are kept as well.
   *
   * @param itemsToKeep - The items to keep in the project.
   * @returns The total number of items removed.
   */
  reduceProject(itemsToKeep: Item[]): number {
    if (!itemsToKeep.every((item) => item instanceof Item)) {
      throw new ValueError("All items_to_keep must be Item instances");
    }
    const keepIds = new Set<number>([0]);
    const queue = [...itemsToKeep];
    for (let item = queue.pop(); item !== undefined; item = queue.pop()) {
      if (keepIds.has(item.id)) continue;
      keepIds.add(item.id);
      let parent = item.parentFolder;
      while (parent != null && !keepIds.has(parent.id)) {
        keepIds.add(parent.id);
        parent = parent.parentFolder;
      }
      if (item instanceof CompItem) {
        for (const sourceId of item._sourceIdsForLinking()) {
          const source = this.items.get(sourceId) ?? null;
          if (source != null) queue.push(source);
        }
      }
    }
    let removed = 0;
    for (const itemId of [...this.items.keys()]) {
      const item = keepIds.has(itemId) ? undefined : this.items.get(itemId);
      if (item === undefined) continue;
      item.remove();
      removed += 1;
    }
    return removed;
  }

  /**
   * Merge duplicate footage items that share the same source.
   *
   * Same as the File \> Consolidate All Footage command. Footage items
   * whose sources are identical (same file and interpretation, or same
   * solid characteristics) are merged: layers referencing a duplicate are
   * retargeted to the kept item, and the duplicate is removed.
   *
   * @returns The total number of footage items removed.
   */
  consolidateFootage(): number {
    const groups = new Map<string, FootageItem[]>();
    for (const footage of this.footages) {
      const key = footage._consolidationKey();
      if (key == null) continue;
      setdefault(groups, key, []).push(footage);
    }
    let removed = 0;
    for (const duplicates of groups.values()) {
      if (duplicates.length < 2) continue;
      const kept = duplicates[0];
      for (const dup of duplicates.slice(1)) {
        for (const comp of dup.usedIn) {
          for (const layer of comp.avLayers) {
            if (layer._sourceId === dup.id) {
              layer._sourceId = kept.id;
              // Refresh the layer's cached source so a prior
              // `layer.source` access doesn't keep returning
              // the removed duplicate.
              layer._source = kept;
              kept._usedIn.add(comp);
            }
          }
        }
        dup.remove();
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Save the project to a new .aep file at the given path.
   *
   * **Warning:** This is highly experimental for now.
   *
   * @throws {@link FileExistsError} If `path` already exists; overwriting is not allowed while
   *   saving is experimental.
   */
  save(path: PathLike): void {
    validatePathDoesNotExist(path);
    for (const comp of this.compositions) {
      // A comp whose layers were never loaded has had nothing moved.
      if (comp._layersLoaded) {
        for (const layer of comp.layers) {
          layer._writeOutMovedDefaults();
        }
      }
    }
    const pathObj = new Path(path);
    pathObj.parent.mkdir({ parents: true, existOk: true });
    const filled = this._fillRelativePathCounts(
      platformPath(host.path.resolve(String(pathObj)), { windows: this._windows }),
    );
    // Serialize in memory: the writer seeks back to fill in each chunk's
    // length, and on a network share every seek is a round trip (a 29 MB
    // project took minutes to write there, under a second in one call).
    const buffer = new BytesIO();
    try {
      moduleGlobals.writeAep(buffer, this._rifx, this._xmp);
    } finally {
      // Back to pending, so a later save computes them for its own
      // location.
      for (const [alas, text] of filled) {
        alas.value = text;
      }
    }
    // Write to a sibling temp file then rename, so a failed write can
    // never leave a truncated .aep at the target path. The temp name is
    // unique and created exclusively: a fixed one would overwrite, then
    // move away, any file of the user's carrying it. A failed rename (a
    // scanner still holding the temp file on Windows) removes it too.
    const tmpPath = pathObj.withName(`${pathObj.name}.${uuid4().replace(/-/g, "")}.tmp`);
    try {
      // `tmp_path.open("xb")`: created exclusively before anything is written.
      const fd = host.fs.openSync(tmpPath.path, "wx");
      try {
        // `getbuffer()`: the written bytes without copying the whole file once more.
        host.fs.writeSync(fd, buffer.getbuffer());
      } finally {
        host.fs.closeSync(fd);
      }
      tmpPath.replace(pathObj);
    } catch (e) {
      if (tmpPath.exists()) tmpPath.unlink(); // missing_ok needs Python 3.8
      throw e;
    }
    this._file = fspath(path);
  }

  /**
   * Fill in the relative-path counts of the `alas` path records
   * py_aep wrote, for a project saved at `project_file`.
   *
   * Records parsed from the file keep the counts After Effects wrote, so
   * parse then save stays byte-identical. Layer lists still deferred are
   * skipped: no layer holds a path record. Returns each filled record
   * with its previous text.
   */
  _fillRelativePathCounts(projectFile: string): [Utf8Chunk, string][] {
    const filled: [Utf8Chunk, string][] = [];
    for (const chunk of recursiveFind(this._rifx.chunks, "alas", undefined, true)) {
      const alas = chunk;
      const text = alas.value;
      const data = text ? jsonLoads(text) : new Map<string, JsonValue>();
      if (!(data instanceof Map)) throw new AttributeError(`'${typeName(data)}' object has no attribute 'get'`);
      if (!pyEq(dictGet(data, "ascendcount_base"), PENDING_ASCENDCOUNT)) continue;
      const counts = relativePathCounts(projectFile, alasFullpath(data), {
        targetIsFolder: pyBool(dictGet(data, "target_is_folder")),
      });
      data.set("ascendcount_base", counts[0]);
      data.set("ascendcount_target", counts[1]);
      filled.push([alas, text]);
      alas.value = dumpAlas(data);
    }
    return filled;
  }

  /** Return the AE preferences directory or raise if none was given. */
  _requirePrefsDir(label: string): Path {
    if (this._aePreferencesDir == null) {
      throw new ValueError(
        "No 'ae_preferences_dir' provided to parse(); " +
          `${label} templates are required for adding items ` +
          "to the render queue. Pass ae_preferences_dir pointing to " +
          "the AE preferences directory (e.g. " +
          "C:/Users/<user>/AppData/Roaming/Adobe/After Effects/26.0)",
      );
    }
    return this._aePreferencesDir;
  }

  /**
   * Lazily parse render settings templates from AE preferences.
   *
   * @throws {@link ValueError} If no preferences directory was provided to `parse()`. Render
   *   settings templates are required for adding items to the render queue.
   */
  _getRenderTemplates(): RenderSettingsItem[] {
    if (this._renderTemplatesCache != null) return this._renderTemplatesCache;

    const prefsDir = this._requirePrefsDir("render settings");
    const [templates, defaultIndex] = parseRenderTemplates(prefsDir);
    this._defaultRenderTemplateIndex = defaultIndex;

    this._renderTemplatesCache = templates;
    return templates;
  }

  /**
   * Lazily parse output module templates from AE preferences.
   *
   * Returns an array of {@link OutputModuleTemplate} objects.
   *
   * @throws {@link ValueError} If no preferences directory was provided to `parse()`. Output module
   *   templates are required for adding items to the render queue.
   */
  _getOutputTemplates(): OutputModuleTemplate[] {
    if (this._outputTemplatesCache != null) return this._outputTemplatesCache;

    const prefsDir = this._requirePrefsDir("output module");
    const [templates] = parseOutputTemplates(prefsDir);

    this._outputTemplatesCache = templates;
    return this._outputTemplatesCache;
  }

  /**
   * Return the next unique id for a new item or layer.
   *
   * After Effects draws item ids AND layer ids (including viewer
   * pseudo-layers in DLay/SLay/CLay/SecL lists) from one project-wide
   * counter persisted in `head.next_item_id`, and TRUSTS that counter
   * on open without rescanning - probed in AE 2026: opening a file
   * whose counter sits below the live ids makes AE itself mint
   * duplicate layer ids. So there is a single allocator, reconciled
   * once against every live id, then
   * strictly counter-driven. ID 0 is reserved for the root folder.
   */
  _allocateId(): number {
    if (!this._idCounterReconciled) {
      const layerIds: number[] = [];
      for (const comp of this.compositions) {
        for (const ldta of recursiveFind(comp._itemList.chunks, "ldta")) {
          layerIds.push(ldta.layerId);
        }
      }
      const maxLayerId = max(layerIds, null, 0);
      const maxItemId = max([...this.items.keys()], null, 0);
      const floor = max([maxLayerId, maxItemId]) + 1;
      if (this._head.nextItemId < floor) {
        this._head.nextItemId = floor;
      }
      this._idCounterReconciled = true;
    }
    const newId = this._head.nextItemId;
    this._head.nextItemId = newId + 1;
    return newId;
  }

  /**
   * The solids folder name stored in the project's root `sfnm` chunk.
   *
   * AE stamps the "New Project Solids Folder" preference into `sfnm`
   * when the project is created and uses the stored name from then on.
   */
  get _solidsFolderName(): string {
    const sfnm = findByListTypeOrNull(this._rifx.chunks, "sfnm");
    const utf8 = sfnm === null ? null : findByTypeOrNull(sfnm.chunks, "Utf8");
    return utf8?.value || "Solids";
  }

  get _sfid(): U4LeChunk | null {
    const sfnm = findByListTypeOrNull(this._rifx.chunks, "sfnm");
    return sfnm === null ? null : findByTypeOrNull(sfnm.chunks, "sfid");
  }

  /** The item id of the Solids folder recorded in `sfid` (0 for none). */
  get _solidsFolderId(): number {
    const sfid = this._sfid;
    return sfid != null ? sfid.value : 0;
  }

  /**
   * The folder new solids go into, creating it if needed.
   *
   * As After Effects 2026 does: the recorded Solids folder wherever it
   * now is and whatever its name; else a root folder with the stored
   * Solids name (the id stays unset); else a new one, whose id is
   * recorded.
   */
  get _solidsFolder(): FolderItem {
    const sfid = this._sfid;
    const recorded = sfid != null ? sfid.value : 0;
    const folder = recorded ? this.items.get(recorded) ?? null : null;
    if (folder instanceof FolderItem) return folder;
    const name = this._solidsFolderName;
    for (const existing of this.rootFolder.folders) {
      if (existing.name === name) return existing;
    }
    const created = this.rootFolder.addFolder(name);
    if (sfid != null) sfid.value = created.id;
    return created;
  }

  static _CMS_DEFAULTS: Record<string, number | string> = {
    colorManagementSystem: 0,
    lutInterpolationMethod: 0,
    ocioConfigurationFile: "",
  };

  /** Return the color profile settings Map. */
  _getCmsSettings(): Map<string, JsonValue> {
    const merged = new Map<string, JsonValue>(Object.entries(this.constructor._CMS_DEFAULTS));
    if (this._cmsUtf8 != null) {
      const cmsData = jsonLoads(this._cmsUtf8.value);
      if (!(cmsData instanceof Map)) throw new TypeError_(`'${typeName(cmsData)}' object is not a mapping`);
      for (const [k, v] of cmsData) merged.set(k, v);
    }
    return merged;
  }

  /** Update a single key in the CMS settings JSON chunk. */
  _updateCmsSetting(key: string, value: number | string): void {
    if (this._cmsUtf8 != null) {
      const data = jsonLoads(this._cmsUtf8.value);
      if (!(data instanceof Map)) throw new TypeError_(`'${typeName(data)}' object does not support item assignment`);
      data.set(key, value);
      this._cmsUtf8.value = jsonDumps(data);
    } else {
      const data = new Map<string, JsonValue>(Object.entries(this.constructor._CMS_DEFAULTS));
      data.set(key, value);
      const chunk = new Utf8Chunk({ value: jsonDumps(data) });
      this._rifx.chunks.push(chunk);
      this._cmsUtf8 = chunk;
    }
  }
}

// Descriptors assigned in the class body: `declare` above, installed here.
descriptor(
  Project,
  "bitsPerChannel",
  ChunkField.enum(BitsPerChannel, "_nnhd", "bitsPerChannel", {
    postSet: (obj: Project) => obj._syncNhedField("bitsPerChannel"),
  }),
);

descriptor(
  Project,
  "feetFramesFilmType",
  ChunkField.enum(FeetFramesFilmType, "_nnhd", "feetFramesFilmType", {
    postSet: (obj: Project) => obj._syncNhedField("_displayByte"),
  }),
);

descriptor(
  Project,
  "footageTimecodeDisplayStartType",
  ChunkField.enum(FootageTimecodeDisplayStartType, "_nnhd", "footageTimecodeDisplayStartType", {
    postSet: (obj: Project) => obj._syncNhedField("footageTimecodeDisplayStartType"),
  }),
);

descriptor(
  Project,
  "_timecodeDefaultBase",
  new ChunkField("_nnhd", "timecodeDefaultBase", {
    // nhed holds it as a u1, so a CC 12.0 project (whose nnhd is a
    // synthetic stand-in) persists at most 255.
    validate: _validateNumber({
      min: 1,
      max: (obj: Project) => (obj._nnhd.synthetic ? 255 : 999),
      integer: true,
    }),
    postSet: (obj: Project) => obj._syncNhedTimecodeDefaultBase(),
  }),
);

descriptor(
  Project,
  "framesCountType",
  ChunkField.enum(FramesCountType, "_nnhd", "framesCountType", {
    postSet: (obj: Project) => obj._syncNhedField("framesCountType"),
  }),
);

descriptor(
  Project,
  "displayStartFrame",
  new ChunkField("_nnhd", "displayStartFrame", {
    validate: validateOneOf([0, 1]),
    postSet: (obj: Project) => obj._syncNhedField("framesCountType"),
  }),
);

descriptor(
  Project,
  "framesUseFeetFrames",
  ChunkField.bool("_nnhd", "framesUseFeetFrames", {
    postSet: (obj: Project) => obj._syncNhedField("_feetByte"),
  }),
);

descriptor(
  Project,
  "timeDisplayType",
  ChunkField.enum(TimeDisplayType, "_nnhd", "timeDisplayType", {
    postSet: (obj: Project) => obj._syncNhedField("_displayByte"),
  }),
);

descriptor(
  Project,
  "transparencyGridThumbnails",
  ChunkField.bool("_nnhd", "transparencyGridThumbnails", {
    postSet: (obj: Project) => obj._syncNhedField("transparencyGridThumbnails"),
  }),
);

descriptor(Project, "revision", new ChunkField("_head", "fileRevision", { validate: validateU4 }));

descriptor(
  Project,
  "compensateForSceneReferredProfiles",
  ChunkField.bool("_acer", "value", {
    transform: (v: number) => v !== 0,
    reverse: (v: boolean) => int(v),
    minVersion: 16,
  }),
);

descriptor(
  Project,
  "audioSampleRate",
  new ChunkField("_adfr", "value", {
    validate: validateOneOf([22050, 32000, 44100, 48000, 96000]),
  }),
);

descriptor(
  Project,
  "workingGamma",
  new ChunkField("_dwga", "workingGamma", {
    validate: validateOneOf([2.2, 2.4]),
    // A CC 12.0 project has no dwga to keep it in.
    minVersion: 13,
  }),
);

descriptor(
  Project,
  "gpuAccelType",
  ChunkField.enum(GpuAccelType, "_gpugUtf8", "value", {
    allowOutOfEnumValues: true,
    validate: _validateGpuAccelType,
    minVersion: 13,
  }),
);

// The XMP packet: `ET.fromstring` / `ET.tostring` (see the TODO above).
descriptor(
  Project,
  "xmpPacket",
  new ChunkField("_aep", "_xmp", {
    transform: (s) => (pyBool(s) && strip(s) ? ET_fromstring(s) : null),
    reverse: (el: Element | null) => (el != null ? ET_tostring(el) : ""),
  }),
);

/**
 * `((anchor), (position))` of a cropped Illustrator/PDF layer.
 *
 * Measured on AE 2026 (`importFile` with `COMP_CROPPED_LAYERS`, every
 * layer of a 22-rule probe PDF and a real `.ai`): the anchor is half the
 * artwork box rounded to float32, and the position is the box centre with
 * the PDF's y axis flipped against the page, counted in the opti's 16.16
 * units with the centre floored. An empty layer's `(0, 0, 1/65536, 1/65536)` box therefore sits at x = 0, not half a unit right of it.
 * AE sums the two 16.16 edges in 32 bits, so artwork near the 32768 pt
 * limit wraps to the far side of the page; py keeps the true centre.
 */
export function _aiCroppedTransform(
  box: [number, number, number, number],
  pageHeight: number,
): [[number, number], [number, number]] {
  const [x0, y0, x1, y1] = box.map((v) => round(v * 65536));
  const anchor: [number, number] = [toF4((x1 - x0) / 131072), toF4((y1 - y0) / 131072)];
  const position: [number, number] = [
    rshift(x0 + x1, 1) / 65536,
    pageHeight - rshift(y0 + y1, 1) / 65536,
  ];
  return [anchor, position];
}

/** Get the array of effect names used in the project. */
export function _getEffectNames(rootChunks: Chunk[]): string[] {
  const peflChunk = findByListType(rootChunks, "Pefl");
  const pjefChunks = filterByType(peflChunk.chunks, "pjef");
  return pjefChunks.map((chunk) => chunk.value);
}

// tdb4 canon AE writes on materialized Layer Styles leaves, keyed by leaf
// suffix or full match name: (value_hint_type, value_hint_flag, cvot_flags,
// type_flags, property_category, pad2a, vector), null leaving the
// materialized value. Byte-diffed from the psd_layer_styles*.aep fixtures;
// stamped after the value write because the static-state tdb4 templates run
// there. The enum/angle/scalar classification is derived from the synthesis
// canon tables so the two mechanisms cannot drift; "gradient" is
// scalar-stamped here although `_style_leaf_canon` leaves the spec
// uncanonized, the 2D point rows come from the psd_styles_offset_phase
// fixture, and the blend-options leaves are keyed by full match name.
/** `[hint, hint_flag, cvot, type_flags, category, pad2a, vector, spatial]`. */
export type Tdb4Row = [number, number | null, number | null, number | null, number | null, number | null, boolean | null, boolean];

export const _STYLE_TDB4_ENUM: Tdb4Row = [0x0001, null, 0x04, 0x04, 0x04, null, null, false];
export const _STYLE_TDB4_SCALAR: Tdb4Row = [0xffff, null, null, null, null, null, null, false];
export const _STYLE_TDB4_ANGLE: Tdb4Row = [0xffff, 0xff, 0xff, 0x04, 0x06, null, null, false];
export const _STYLE_TDB4_TOGGLE: Tdb4Row = [0xffff, null, 0x04, 0x04, 0x04, null, null, false];
export const _STYLE_TDB4_POINT: Tdb4Row = [0xffff, 0xff, 0xff, 0x04, 0x06, 3, false, true];

export const _STYLE_TDB4_CANON = new Map<string, Tdb4Row>();
for (const k of _STYLE_ENUM_SUFFIXES) _STYLE_TDB4_CANON.set(k, _STYLE_TDB4_ENUM);
for (const k of _STYLE_ANGLE_SUFFIXES) _STYLE_TDB4_CANON.set(k, _STYLE_TDB4_ANGLE);
for (const k of _STYLE_HINT_BOUNDS.keys()) _STYLE_TDB4_CANON.set(k, _STYLE_TDB4_SCALAR);
for (const name of _STYLE_HINT_BOUNDS_EXCEPTIONS.keys()) {
  _STYLE_TDB4_CANON.set(name.slice(name.lastIndexOf("/") + 1), _STYLE_TDB4_SCALAR);
}
_STYLE_TDB4_CANON.set("gradient", _STYLE_TDB4_SCALAR);
_STYLE_TDB4_CANON.set("offset", _STYLE_TDB4_POINT);
_STYLE_TDB4_CANON.set("phase", _STYLE_TDB4_POINT);
_STYLE_TDB4_CANON.set("ADBE Global Angle2", [0x0002, null, null, null, null, null, null, false]);
_STYLE_TDB4_CANON.set("ADBE Global Altitude2", [0x0002, null, null, null, null, null, null, false]);
_STYLE_TDB4_CANON.set("ADBE Layer Fill Opacity2", [0xffff, null, null, 0x04, 0x08, null, null, false]);
_STYLE_TDB4_CANON.set("ADBE R Channel Blend", _STYLE_TDB4_TOGGLE);
_STYLE_TDB4_CANON.set("ADBE G Channel Blend", _STYLE_TDB4_TOGGLE);
_STYLE_TDB4_CANON.set("ADBE B Channel Blend", _STYLE_TDB4_TOGGLE);
_STYLE_TDB4_CANON.set("ADBE Blend Interior", _STYLE_TDB4_TOGGLE);

/** Apply the AE tdb4 canon to a just-written Layer Styles leaf. */
export function _stampStyleTdb4(leaf: Property, matchName: string, timebase: number, pointAspect: number): void {
  const tdb4 = leaf._tdb4;
  if (tdb4 == null) return;
  const canon = pyOr(
    _STYLE_TDB4_CANON.get(matchName),
    _STYLE_TDB4_CANON.get(matchName.slice(matchName.lastIndexOf("/") + 1)) ?? null,
  );
  if (canon == null) return;
  const [hint, hintFlag, cvot, typeFlags, category, pad2a, vector, spatial] = canon;
  if (hint != null) tdb4._valueHintType = hint;
  if (hintFlag != null) tdb4._valueHintFlag = hintFlag;
  if (cvot != null) tdb4._cvotFlags = cvot;
  if (typeFlags != null) tdb4._typeFlags = typeFlags;
  if (category != null) tdb4._propertyCategory = category;
  if (pad2a != null) tdb4._pad2a = pad2a;
  if (vector != null) tdb4.vector = vector;
  if (spatial) {
    // AE fills the spatial block on the 2D point leaves: marker + flags
    // 0x0F, its point epsilon, and the LAYER's display aspect
    // (source_width * PAR / source_height; 1.28 in the fixture).
    tdb4._spatialMarker = true;
    tdb4._spatialStaticFlags = 0x0f;
    // The normalized-point accuracy (psd_styles_offset_phase fixture:
    // leaves and layers alike).
    tdb4._arcAccuracy = NORMALIZED_ARC_ACCURACY;
    tdb4.pixelAspect = pointAspect;
  }
  tdb4._timeBase = timebase;
}

// AE default values per Layer Styles leaf match name. Editable imports
// write a parameter leaf only when its value differs from these (AE 2026);
// the synthesis tables are the byte-verified source, and only the Layer
// Styles + Blend Options tables can carry keys the resolver emits.
export const _STYLE_SPEC_DEFAULTS = new Map<string, number | number[]>();
for (const specList of _LAYER_STYLE_CHILD_SPECS.values()) {
  for (const spec of specList) {
    if (spec.value != null) _STYLE_SPEC_DEFAULTS.set(spec.matchName, spec.value);
  }
}
for (const spec of [..._BLEND_OPTIONS_SPECS, ..._ADV_BLEND_SPECS]) {
  if (spec instanceof PropSpec && spec.value != null) _STYLE_SPEC_DEFAULTS.set(spec.matchName, spec.value);
}

/** Map of match name -\> leaf under `group`, first-in-tree-order. */
export function _styleLeafMap(group: PropertyGroup): Map<string, Property> {
  const leaves = new Map<string, Property>();
  for (const child of group.properties) {
    if (child instanceof PropertyGroup) {
      for (const [name, leaf] of _styleLeafMap(child)) {
        setdefault(leaves, name, leaf);
      }
    } else if (!leaves.has(child.matchName)) {
      leaves.set(child.matchName, child);
    }
  }
  return leaves;
}


/**
 * Serialize a comp layer's `ADBE Layer Styles` subtree like AE's imports.
 *
 * AE writes the container, Blend Options (with its Advanced group) and the
 * ten style groups as real chunks on EVERY layer a layered-file import
 * creates (all modes, all formats - the `psd_layer_styles*`, `psd_comp`,
 * `ai_comp` and `grouped_layers_comp` fixtures). With `styles`, the present
 * styles are enabled and their non-default parameter values written; the
 * `tdsb` enable bytes follow AE exactly (styled: container/Blend Options
 * 0x01, enabled style 0x01, absent style 0x02; plain skeleton: 0x03 and
 * 0x02 - functional bits, fixture-pinned).
 */
export function _serializeImportLayerStyles(layer: AVLayer, styles: PsdLayerStyles | null, sourceName: string): void {
  const container = layer.property("ADBE Layer Styles");
  // AE enables the container + Blend Options chain when any style is
  // enabled OR the layer carries blend-options data (a Photoshop Fill
  // slider away from 100% enables the chain with zero styles - the
  // psd_fill_opacity fixture).
  const styled = styles != null && pyBool(styles.enabled?.length > 0 ? styles.enabled : styles.blendOptions);
  const containerFlags = styled ? 1 : 3;
  container._ensureMaterialized();
  pyAssert(container._tdsb != null);
  container._tdsb._enableFlags = containerFlags;
  // The synthesis pass stamped derived `enabled` overrides while every
  // group was still synthetic-disabled; refresh them to the written state
  // (ExtendScript semantics: container/Blend Options = any style enabled).
  instanceDict(container).set("enabled", styled);
  for (const child of container.properties) {
    if (!(child instanceof PropertyGroup)) continue;
    child._ensureMaterialized();
    pyAssert(child._tdsb != null);
    if (child.matchName === "ADBE Blend Options Group") {
      child._tdsb._enableFlags = containerFlags;
      instanceDict(child).set("enabled", styled);
      for (const sub of child.properties) {
        if (sub instanceof PropertyGroup) {
          sub._ensureMaterialized();
          pyAssert(sub._tdsb != null);
          // AE writes the Advanced Blending subgroup enabled on
          // EVERY import, plain skeletons included (pinned by the
          // psd_fill_opacity/psd_layer_styles/ai_comp fixtures).
          sub._tdsb._enableFlags = 1;
        }
      }
    } else {
      const prefix = child.matchName.split("/")[0];
      let flags: number;
      if (styles != null && styles.enabled.includes(prefix)) {
        flags = 1;
      } else if (styles != null && styles.disabled.includes(prefix)) {
        // Present-but-unchecked style: parameters imported, distinct
        // enable byte 0x00 (psd_fill_opacity fixture).
        flags = 0;
      } else {
        flags = 2;
      }
      child._tdsb._enableFlags = flags;
      instanceDict(child).delete("enabled");
    }
  }
  if (styles == null) return;
  for (const prefix of styles.dropped) {
    warn(
      `${sourceName}: layer ${repr(layer.name)} style ${repr(prefix)} was ` +
        "imported as disabled - After Effects drops styles with " +
        "multiple instances or unrepresentable content, and py_aep " +
        "matches its output",
    );
  }
  if (!styles.values?.size) return;
  const timebase = layer.containingComp._cdta.internalTimebase;
  const source = layer.source;
  // Python `cast("AVItem", layer.source)`: an imported layer always has one.
  if (source == null) throw new AttributeError("'NoneType' object has no attribute 'width'");
  const pointAspect = (source.width * source.pixelAspect) / source.height;
  const leaves = _styleLeafMap(container);
  for (const [matchName, value] of styles.values) {
    if (_valuesEqual(value, _STYLE_SPEC_DEFAULTS.get(matchName) ?? null)) continue;
    const leaf = leaves.get(matchName) ?? null;
    if (leaf == null) continue;
    leaf.value = value;
    if (value instanceof Gradient && leaf._tdb4 != null) {
      // AE's style gradient tdb4 is vector-typed (the NO_VALUE-seeded
      // spec builds a bare one).
      leaf._tdb4.vector = true;
    }
    _stampStyleTdb4(leaf, matchName, timebase, pointAspect);
  }
}
