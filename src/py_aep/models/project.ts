// Port of py_aep/models/project.py.

import * as host from "../../pyrt/host.ts";
import { uuid4 } from "../../pyrt/uuid.ts";

import { fromstring, tostring } from "../../pyrt/etree.ts";
import { ae_writes, requires_version } from "../ae_version.ts";
import { to_f4, truncate_utf8 } from "../binary/bin_utils.ts";
import { write_aep as _write_aep } from "../binary/chunk.ts";
import type { Chunk } from "../binary/chunk.ts";
import { ListChunk } from "../binary/chunk.ts";
import { build_ai_layer_opti_data, build_psd_flattened_opti_data, build_text_opti_data } from "../binary/footage_chunks.ts";
import { HeadChunk, NhedChunk, NnhdChunk, TimeDisplayPrefItem } from "../binary/item_chunks.ts";
import { DwgaChunk } from "../binary/misc_chunks.ts";
import { CpidChunk, FdtaChunk, SvapChunk, WsnmChunk, WsnsChunk } from "../binary/project_chunks.ts";
import { F8Chunk, U1Chunk, U2Chunk, U4Chunk, U4LeChunk, Utf8Chunk } from "../binary/scalar_chunks.ts";
import { alas_fullpath, dump_alas, filter_by_type, find_by_list_type, find_by_list_type_or_null, find_by_type, find_by_type_or_null, index_by_identity, PENDING_ASCENDCOUNT, recursive_find, toggle_flag_chunk } from "../binary/utils.ts";
import type { RenderSettingsItem } from "../binary/render_chunks.ts";
import { build_icc_envelope, build_ocio_display_envelope, envelope_profile_name } from "../color/envelope.ts";
import { IccProfileLibrary, icc_profile_description, icc_profile_id } from "../color/icc.ts";
import { list_config_color_spaces, ocio_color_profile_envelope, require_ocio_config, resolve_ocio_config } from "../color/ocio.ts";
import { AI_COMP_EXTENSIONS, EPS_COMP_EXTENSIONS, PSD_COMP_EXTENSIONS } from "../data/file_formats.ts";
import { BitsPerChannel, ColorManagementSystem, FeetFramesFilmType, FootageTimecodeDisplayStartType, FramesCountType, GpuAccelType, ImportAsType, LutInterpolationMethod, PREFType, TimeDisplayType } from "../enums/index.ts";
import { adobe_color_profile_names } from "../enums/mappings.ts";
import { EMPTY_BOX, footage_size, read_ai_layer_bounds } from "../resolvers/ai_bounds.ts";
import { read_ai_layer_ocgs } from "../resolvers/ai_layers.ts";
import { NORMALIZED_ARC_ACCURACY } from "../resolvers/interpolation.ts";
import { pixel_buffer_size, probe_media } from "../resolvers/media_probe.ts";
import { MediaInfo } from "../resolvers/media_probe.ts";
import { platform_path, relative_path_counts } from "../resolvers/platform_paths.ts";
import { FlattenedPsdError, PsdGroup, PsdLayer, read_psd_layers } from "../resolvers/psd_layers.ts";
import { parse_vector_mask } from "../resolvers/psd_paths.ts";
import { has_enabled_styles, parse_layer_styles, read_global_light } from "../resolvers/psd_styles.ts";
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

import { Preferences, default_sequence_fps, psd_comp_layer_styles, psd_footage_dimensions, psd_footage_layer_styles } from "./preferences.ts";
import { Gradient } from "./properties/gradient.ts";
import { Property, _values_equal } from "./properties/property.ts";
import { PropertyGroup } from "./properties/property_group.ts";
import { Shape } from "./properties/shape.ts";
import { RenderQueue } from "./renderqueue/render_queue.ts";
import type { Layer } from "./layers/layer.ts";
import { PSD_LAYER_STYLES_C8, FileSource, ai_document_profile, check_footage_size, named_media_profile, psd_layer_footage } from "./sources/file.ts";
import { _replace_layer_font } from "./text/ranges.ts";
import type { FontObject } from "./text/font_object.ts";
import type { TextDocument } from "./text/text_document.ts";
import { _validate_number, validate_bool, validate_enum, validate_font_name, validate_one_of, validate_path, validate_path_does_not_exist, validate_path_exists, validate_string, validate_u4 } from "./validators.ts";
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
  dict_get,
  fspath,
  getattr,
  setattr,
  getitem,
  int,
  max,
  py_assert,
  py_bool,
  py_eq,
  py_or,
  repr,
  rshift,
  round,
  setdefault,
  sorted,
  str,
  strip,
  tkey,
  warn,
  bytes_eq,
  descriptor,
  format,
  instance_dict,
  json_dumps,
  json_loads,
  type_name,
  type ClassAttributes,
  AttributeError,
  json_int,
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
export const module_globals: { write_aep: typeof _write_aep } = { write_aep: _write_aep };
import { effect_definition_entries } from "../parsers/effect.ts";
import { parse_output_templates, parse_render_templates } from "../parsers/templates.ts";
import { PlaceholderSource } from "./sources/placeholder.ts";
import { UnsupportedSVGError, read_svg } from "../svg/index.ts";
import { build_shape_layer_contents } from "../svg/build.ts";
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
export function is_list_or_tuple(x: unknown): x is unknown[] {
  return Array.isArray(x);
}

export const _validate_expression_engine = validate_one_of(["extendscript", "javascript-1.0"]);

export function _validate_gpu_accel_type(value: GpuAccelType | string, obj: Project): void {
  /** Accept a `GpuAccelType` or a renderer UUID string (what the getter
   * returns for an id it does not recognise). */
  if (typeof value === "string") {
    GpuAccelType.to_binary(value);
  } else {
    validate_enum(GpuAccelType)(value);
  }
}

export function _font_post_script_name(font: FontObject | string): string {
  /** The PostScript name of a `replace_font` argument. */
  if (typeof font === "string") {
    validate_font_name(font);
    return font;
  }
  const name = font?.post_script_name ?? null;
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
export const _set_linearize_working_space = requires_version(16)(function linearize_working_space(
  this: Project,
  value: boolean,
): void {
  validate_bool(value);
  // `lnrp` sits immediately after `lnrb` (or after `cpid` when linear
  // blending is off), before `dwga`.
  toggle_flag_chunk(this._rifx, "lnrp", value, { after_types: ["lnrb", "cpid"] });
});

export const _set_expression_engine = requires_version(16)(function expression_engine(
  this: Project,
  value: string,
): void {
  _validate_expression_engine(value);
  if (this._exen_utf8 != null) {
    this._exen_utf8.value = value;
  } else {
    const utf8 = new Utf8Chunk({ value });
    const exen = new ListChunk({ list_type: "ExEn", chunks: [utf8] });
    this._rifx.chunks.push(exen);
    this._exen_utf8 = utf8;
  }
});

export const _set_color_management_system = requires_version(24)(function color_management_system(
  this: Project,
  value: ColorManagementSystem | number,
): void {
  validate_enum(ColorManagementSystem)(value);
  this._update_cms_setting("colorManagementSystem", int(value));
});

export const _set_lut_interpolation_method = requires_version(24)(function lut_interpolation_method(
  this: Project,
  value: LutInterpolationMethod | number,
): void {
  validate_enum(LutInterpolationMethod)(value);
  this._update_cms_setting("lutInterpolationMethod", int(value));
});

export const _set_ocio_configuration_file = requires_version(24)(function ocio_configuration_file(
  this: Project,
  value: PathLike,
): void {
  validate_path(value);
  this._update_cms_setting("ocioConfigurationFile", fspath(value));
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
  declare bits_per_channel: BitsPerChannel;

  /**
   * The film type for feet+frames timecode display, either MM16 (16mm) or
   * MM35 (35mm). Read / Write.
   */
  declare feet_frames_film_type: FeetFramesFilmType;

  /**
   * The Footage Start Time setting in the Project Settings dialog box,
   * which is enabled when Timecode is selected as the time display style.
   * Read / Write.
   */
  declare footage_timecode_display_start_type: FootageTimecodeDisplayStartType;

  /**
   * The Default Base value in the Time Display Style section of
   * the Project Settings dialog, under Timecode. Read/Write.
   */
  declare _timecode_default_base: number;

  /**
   * The Frame Count menu setting in the Project Settings dialog box.
   * Read / Write.
   */
  declare frames_count_type: FramesCountType;

  /**
   * The start frame number for the project display (0 or 1). An alternate
   * way of setting the Frame Count menu setting. Read / Write.
   */
  declare display_start_frame: number;

  /**
   * When `true`, the Frames field in the UI is displayed as
   * feet+frames. Read / Write.
   */
  declare frames_use_feet_frames: boolean;

  /**
   * The time display style, corresponding to the Time Display Style
   * section in the Project Settings dialog box. Read / Write.
   */
  declare time_display_type: TimeDisplayType;

  /**
   * When `true`, thumbnail views use the transparency checkerboard
   * pattern. Read / Write.
   */
  declare transparency_grid_thumbnails: boolean;

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
  declare compensate_for_scene_referred_profiles: boolean;

  /**
   * The project audio sample rate in Hz.
   *
   * Allowed values: 22050, 32000, 44100, 48000, 96000.
   *
   * **Note:** Not exposed in ExtendScript
   */
  declare audio_sample_rate: number;

  /**
   * The gamma value used for the working color space, either 2.2 or 2.4.
   * Read / Write.
   */
  declare working_gamma: number;

  /**
   * The GPU acceleration type for the project. A renderer id py_aep does
   * not recognise reads as its UUID string, which can be written back. An
   * AE CC 12.0 project reads SOFTWARE, as AE reports it.
   * Read / Write.
   */
  declare gpu_accel_type: GpuAccelType | string;

  // ChunkField needs a chunk_attr that resolves to an object holding the
  // target field.  _xmp lives directly on Project, so we alias _aep = self
  // in __init__ so the descriptor chain is: getattr(self, "_aep") -> self,
  // then getattr(self, "_xmp") -> the raw XMP string.
  /**
   * The XMP packet for the project, containing metadata. `null` when the
   * project has no XMP packet (e.g. projects created via `py_aep.new()`).
   * Read / Write.
   */
  declare xmp_packet: Element | null;

  // Chunk body references for descriptors
  declare _nhed: NhedChunk;
  declare _nnhd: NnhdChunk;
  declare _head: HeadChunk;
  declare _acer: U1Chunk;
  declare _adfr: F8Chunk;
  declare _dwga: DwgaChunk;
  declare _gpug_utf8: Utf8Chunk;
  declare _exen_utf8: Utf8Chunk | null;
  declare _cms_utf8: Utf8Chunk | null;
  declare _ws_utf8: Utf8Chunk | null;
  declare _dcs_utf8: Utf8Chunk | null;
  declare _rifx: ListChunk;
  declare _xmp: string;
  declare _aep: Project;

  // Read-only attributes
  declare _file: string;
  declare _items: Map<number, Item>;
  declare _render_queue: RenderQueue | null;
  declare _active_item: Item | null;
  declare _effect_param_defs: EffectParamDefs;
  declare _effect_definitions_cache: [string, string, ListChunk][] | null;
  declare _used_in_linked: boolean;
  declare _id_counter_reconciled: boolean;
  declare _ae_preferences_dir: Path | null;
  declare _preferences: Preferences;
  declare _platform: string;
  // ICC profile discovery for Adobe-CMS working-space writes. `None`
  // dirs = auto-discover the standard Adobe Color directories.
  declare _icc_profile_dirs: Path[] | null;
  declare _icc_library: IccProfileLibrary | null;
  declare _render_templates_cache: RenderSettingsItem[] | null;
  declare _output_templates_cache: OutputModuleTemplate[] | null;
  declare _default_render_template_index: number | null;

  constructor(kw: {
    _nhed: NhedChunk;
    _nnhd: NnhdChunk;
    _head: HeadChunk;
    _acer: U1Chunk;
    _adfr: F8Chunk;
    _dwga: DwgaChunk;
    _gpug_utf8: Utf8Chunk;
    _exen_utf8: Utf8Chunk | null;
    _cms_utf8: Utf8Chunk | null;
    _ws_utf8: Utf8Chunk | null;
    _dcs_utf8: Utf8Chunk | null;
    _rifx: ListChunk;
    _xmp: string;
    file: string;
    items: Map<number, Item>;
    render_queue: RenderQueue | null;
    ae_preferences_dir?: Path | null;
  }) {
    const {
      _nhed,
      _nnhd,
      _head,
      _acer,
      _adfr,
      _dwga,
      _gpug_utf8,
      _exen_utf8,
      _cms_utf8,
      _ws_utf8,
      _dcs_utf8,
      _rifx,
      _xmp,
      file,
      items,
      render_queue,
      ae_preferences_dir = null,
    } = kw;
    // Chunk body references for descriptors
    this._nhed = _nhed;
    this._nnhd = _nnhd;
    this._head = _head;
    this._acer = _acer;
    this._adfr = _adfr;
    this._dwga = _dwga;
    this._gpug_utf8 = _gpug_utf8;
    this._exen_utf8 = _exen_utf8;
    this._cms_utf8 = _cms_utf8;
    this._ws_utf8 = _ws_utf8;
    this._dcs_utf8 = _dcs_utf8;
    this._rifx = _rifx;
    this._xmp = _xmp;
    this._aep = this;

    // Read-only attributes
    this._file = file;
    this._items = items;
    this._render_queue = render_queue;
    this._active_item = null;
    this._effect_param_defs = new Map();
    this._effect_definitions_cache = null;
    this._used_in_linked = false;

    this._id_counter_reconciled = false; // lazily done on first allocation
    this._ae_preferences_dir = ae_preferences_dir;
    this._preferences = new Preferences(ae_preferences_dir);
    // Class attribute read through the instance until `_new` assigns one.
    this._platform = this.constructor._platform;
    // ICC profile discovery for Adobe-CMS working-space writes. `None`
    // dirs = auto-discover the standard Adobe Color directories.
    this._icc_profile_dirs = null;
    this._icc_library = null;
    this._render_templates_cache = null;
    this._output_templates_cache = null;
    this._default_render_template_index = null;
  }

  // Color-management settings JSON AE 2026 writes for a new project.
  // Inherited from the empty-project ground truth; callers can override
  // via color_management_system / lut_interpolation_method / etc.
  static _NEW_PROJECT_CMS_JSON: string = '{"lutInterpolationMethod":1}';

  _effect_definitions(): [string, string, ListChunk][] {
    /**
     * `LIST:EfdG` effect definitions, walked once and cached.
     *
     * EfdG is read-only after parse (adding an installed effect clones
     * its sspc template into the layer rather than editing EfdG), so the
     * walk is computed lazily on first lookup and reused across adds.
     */
    if (this._effect_definitions_cache == null) {
      this._effect_definitions_cache = effect_definition_entries(this._rifx.chunks);
    }
    return this._effect_definitions_cache;
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
  static _apply_project_settings_prefs(
    preferences: Preferences,
    nhed: NhedChunk,
    nnhd: NnhdChunk,
  ): void {
    const depth = preferences.get_pref_as_number("Project Pref Section", "Project Settings Depth", undefined, {
      default: 0,
    });
    if ([1, 2].includes(depth)) {
      // 0 = 8 bpc = the chunk default
      nhed.bits_per_channel = int(depth);
      nnhd.bits_per_channel = int(depth);
    }
    const blob = preferences._get_bytes(
      "Project Pref Section",
      "Project Settings Time Display Format",
      PREFType.PREF_Type_MACHINE_SPECIFIC,
    );
    if (blob == null || blob.length !== 16) return;
    const item = TimeDisplayPrefItem.frombytes(blob);
    py_assert(item instanceof TimeDisplayPrefItem);
    for (const chunk of [nhed, nnhd]) {
      chunk.time_display_type = item.display_byte & 0x7f;
      chunk.feet_frames_film_type = (item.display_byte & 0x80) !== 0;
      chunk.footage_timecode_display_start_type = item.footage_timecode_display_start_type;
      chunk.frames_use_feet_frames = (item.feet_byte & 0x01) !== 0;
      chunk.timecode_default_base = item.timecode_default_base;
      chunk.frames_count_type = item.frames_count_type;
    }
  }

  /**
   * Build a new, empty project (mirrors AE's File \> New Project).
   *
   * Constructs the minimal root chunk skeleton AE accepts - the large
   * workspace blobs AE regenerates on open (`LSIf/AFsi`, `PTRE/ftwd`)
   * are omitted - stamps `version` into the head chunk, and wires the
   * model the same way `parse_project` does. `ae_preferences_dir` is
   * stored for render-queue template lookup. `platform` (default: the
   * running operating system) selects the header stamps AE writes on
   * that platform. See {@link Application} and `py_aep.new`.
   */
  static _new(
    version: string,
    ae_preferences_dir: Path | null = null,
    platform: string | null = null,
  ): Project {
    platform = platform || this._platform;
    const macos = platform === "macos";
    const preferences = new Preferences(ae_preferences_dir);
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
    head.sync_file_format_version();
    const major = head.ae_version_major;
    // Saving-platform stamps, constant per platform across the sample
    // corpus (1348 Windows / 7 macOS files): the head OS code, nnhd byte
    // 2, and the system text encoding at the start of nnhd 0x1A - macOS
    // 0x0100, Windows code page 1252 up to AE 25 and 65001 (UTF-8) from
    // AE 26. AE rewrites all three on every save.
    head.ae_version_os = macos ? 14 : 12;
    const svap = new SvapChunk({ build_number: head.ae_build_number });
    const nhed = new NhedChunk();
    const nnhd = new NnhdChunk();
    this._apply_project_settings_prefs(preferences, nhed, nnhd);
    nnhd._saving_platform = macos ? 0x08 : 0;
    if (macos) {
      nnhd._system_code_page = 0x0100;
    } else {
      const utf8 = ae_writes("utf-8 code page", major);
      nnhd._system_code_page = utf8 ? 65001 : 1252;
    }
    const acer = new U1Chunk({ chunk_type: "acer", value: 1 });
    const adfr = new F8Chunk({ chunk_type: "adfr", value: 48000.0 });
    const dwga = new DwgaChunk({ working_gamma_selector: 1 });
    // A new project takes the platform's GPU renderer: AE's File > New
    // on Windows writes CUDA (emptier.aep), macOS files carry Metal.
    const gpug_utf8 = new Utf8Chunk({
      value: GpuAccelType.to_binary(macos ? GpuAccelType.METAL : GpuAccelType.CUDA),
    });
    const fold = new ListChunk({ list_type: "Fold", chunks: [new FdtaChunk()] });
    // AE stamps the "New Project Solids Folder" preference into the
    // root sfnm chunk at File > New; the stored name is used from
    // then on (see _solids_folder_name).
    const solids_name = preferences.get_pref_as_string(
      "Template Project",
      "New Project Solids Folder",
      PREFType.PREF_Type_MACHINE_INDEPENDENT,
      { default: "Solids" },
    );

    // Root chunks in AE's order. Several are version-gated: AE adds them
    // in later releases, and a fresh project from an older AE omits them
    // (boundaries from samples/versions + emptier_2018.aep). The big
    // workspace blobs AE regenerates on open are omitted entirely.
    let cms_utf8: Utf8Chunk | null = null;
    let exen_utf8: Utf8Chunk | null = null;
    const root_chunks: Chunk[] = [
      svap,
      head,
      nhed,
      nnhd,
      adfr,
      new ListChunk({ list_type: "Pefl" }),
      new U1Chunk({ chunk_type: "qtlg" }),
      new ListChunk({ list_type: "gpuG", chunks: [gpug_utf8] }),
      new ListChunk({
        list_type: "sfnm",
        chunks: [
          new Utf8Chunk({ value: solids_name || "Solids" }),
          new U4LeChunk({ chunk_type: "sfid" }),
        ],
      }),
    ];
    if (ae_writes("media replacement folder id", major)) {
      root_chunks.push(new U4LeChunk({ chunk_type: "mrid" }));
    }
    root_chunks.push(acer, new ListChunk({ list_type: "CPPl" }), new CpidChunk(), dwga);
    if (ae_writes("color management", major)) {
      cms_utf8 = new Utf8Chunk({ value: this._NEW_PROJECT_CMS_JSON });
      root_chunks.push(
        new U1Chunk({ chunk_type: "pcms", value: 1 }),
        cms_utf8,
        new U1Chunk({ chunk_type: "PwCs", value: 1 }),
        new Utf8Chunk({ value: "{}" }),
      );
    }
    if (ae_writes("pdvc", major)) {
      root_chunks.push(new U1Chunk({ chunk_type: "pdvc", value: 1 }), new Utf8Chunk({ value: "{}" }));
    }
    if (ae_writes("expression engine", major)) {
      exen_utf8 = new Utf8Chunk({ value: "javascript-1.0" });
      root_chunks.push(new ListChunk({ list_type: "ExEn", chunks: [exen_utf8] }));
    }
    root_chunks.push(
      fold,
      // Workspace name ("Default"): wsns is the wsnm byte length, wsnm is
      // the name (UTF-16-LE), then a UTF-8 copy. WsnsChunk/WsnmChunk bake
      // the "Default" workspace as their defaults.
      new WsnsChunk(),
      new WsnmChunk(),
      new Utf8Chunk({ value: "Default" }),
      new U4Chunk({ chunk_type: "fcid" }),
      new U2Chunk({ chunk_type: "oacc" }),
    );
    const rifx = new ListChunk({ chunk_type: "RIFX", list_type: "Egg!", chunks: root_chunks });

    const project = new this({
      _nhed: nhed,
      _nnhd: nnhd,
      _head: head,
      _acer: acer,
      _adfr: adfr,
      _dwga: dwga,
      _gpug_utf8: gpug_utf8,
      _exen_utf8: exen_utf8,
      _cms_utf8: cms_utf8,
      _ws_utf8: null,
      _dcs_utf8: null,
      _rifx: rifx,
      _xmp: "",
      file: "",
      items: new Map(),
      render_queue: null,
      ae_preferences_dir,
    });
    project._platform = platform;

    // Root folder (mirrors parse_folder(is_root=True): no idta/name, the
    // Fold chunk list is its own children container).
    const root_folder = new FolderItem({
      _idta: null,
      _name_utf8: null,
      _cmta: null,
      _item_list: fold,
      _gide: null,
      _children_container: fold.chunks,
      project,
      parent_folder: null,
    });
    instance_dict(root_folder).set("name", "root");
    project.items.set(0, root_folder);
    project._active_item = root_folder;

    // Empty render queue (LIST:LRdr appended after the loose root chunks,
    // matching AE's ordering).
    const render_queue = RenderQueue._new(project);
    rifx.chunks.push(render_queue._lrdr);
    project._render_queue = render_queue;

    return project;
  }

  __repr__(): string {
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
  _ensure_used_in_linked(): void {
    if (this._used_in_linked) return;
    this._used_in_linked = true;
    for (const composition of this.compositions) {
      for (const source_id of composition._source_ids_for_linking()) {
        const source = this.items.get(source_id) ?? null;
        if (source instanceof AVItem) {
          source._used_in.add(composition);
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
  get render_queue(): RenderQueue | null {
    return this._render_queue;
  }

  /**
   * The item that is currently active and is to be acted upon, or
   * `null` if no item is currently selected or if multiple items are
   * selected. Read-only.
   */
  get active_item(): Item | null {
    return this._active_item;
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
  _clear_active_item(removed: Item): void {
    if (this._active_item !== removed) return;
    this._active_item = null;
    const fcid = find_by_type_or_null(this._root_chunks, "fcid");
    if (fcid !== null) fcid.value = 0;
  }

  /**
   * The root folder. This is a virtual folder that contains all items
   * in the Project panel, but not items contained inside other folders in
   * the Project panel. Read-only.
   */
  get root_folder(): FolderItem {
    return getitem(this._items, 0) as FolderItem;
  }

  get _root_chunks(): Chunk[] {
    return this._rifx.chunks;
  }

  _sync_nhed_field(field_name: string): void {
    setattr(this._nhed, field_name, getattr(this._nnhd, field_name));
  }

  _sync_nhed_timecode_default_base(): void {
    // nhed matches nnhd in every sample, none above 255; what AE writes
    // in its u1 for a larger base is unmeasured, so it is left as is.
    if (this._nnhd.timecode_default_base <= 0xff) {
      this._sync_nhed_field("timecode_default_base");
    }
  }

  _ensure_materialized(): void {
    /**
     * Keep the stand-ins for root chunks older projects lack synthetic.
     *
     * An AE CC 12.0 project has no nnhd, dwga or gpuG; the parser stands in
     * synthetic ones (see `parse_project`), which `ChunkField` writes land
     * on. They stay out of the file: an nnhd setting persists through the
     * nhed it syncs to, and the settings with no older counterpart
     * (`working_gamma`, `gpu_accel_type`) are gated by `min_version`
     * instead of being dropped on save.
     */
  }

  /**
   * When True, linear blending is used for the project. When False,
   * the standard blending mode is used. Read / Write.
   */
  get linear_blending(): boolean {
    return this._root_chunks.some((c) => c.chunk_type === "lnrb");
  }

  set linear_blending(value: boolean) {
    validate_bool(value);
    // AE keeps `lnrb` in a fixed slot right after `cpid` (before `lnrp` /
    // `dwga`); appending it at the tail makes AE report "missing data".
    toggle_flag_chunk(this._rifx, "lnrb", value, { after_types: ["cpid"] });
  }

  /**
   * When True, the working color space is linearized for blending
   * operations. Read / Write.
   */
  get linearize_working_space(): boolean {
    return this._root_chunks.some((c) => c.chunk_type === "lnrp");
  }

  set linearize_working_space(value: boolean) {
    _set_linearize_working_space.call(this, value);
  }

  /**
   * The Expressions Engine setting in the Project Settings dialog box
   * ("extendscript" or "javascript-1.0"). Read / Write.
   */
  get expression_engine(): string {
    if (this._exen_utf8 != null) return this._exen_utf8.value;
    return "extendscript";
  }

  set expression_engine(value: string) {
    _set_expression_engine.call(this, value);
  }

  /** The names of all effects used in the project. Read-only. */
  get effect_names(): string[] {
    return _get_effect_names(this._root_chunks);
  }

  /**
   * The name of the working color space (e.g., "sRGB IEC61966-2.1",
   * "ACEScg", "None"). Read / Write.
   *
   * In OCIO mode, assigning any color space, role, alias, or
   * `display/view` pair of {@link ocio_configuration_file} rewrites the
   * embedded profile JSON (AE identifies it by name, no ICC data). The
   * config must be resolvable, because the envelope AE writes depends on
   * which of those kinds the name is; `ValueError` is raised if it cannot
   * be located or the name is not in it.
   *
   * In Adobe CMS mode, the matching ICC profile is discovered on disk (see
   * {@link icc_profile_dirs}) and embedded; `ColorProfileNotFoundError` is
   * raised if it is not installed. Assigning `"None"` removes the working
   * space.
   */
  get working_space(): string {
    if (this._ws_utf8 != null) return envelope_profile_name(this._ws_utf8.value);
    if (!this._root_chunks.some((c) => c.chunk_type === "pcms")) {
      // Before AE 22 the working space is the `LIST:CPPl` profile
      // whose ICC profile id `cpid` holds (all 0xFF: None).
      const profile_id = this._cpid.data;
      const cppl = find_by_list_type(this._root_chunks, "CPPl");
      for (const pprf of filter_by_type(cppl.chunks, "pprf")) {
        if (bytes_eq(icc_profile_id(pprf.data), profile_id)) {
          return icc_profile_description(pprf.data) || "None";
        }
      }
    }
    return "None";
  }

  set working_space(value: string) {
    validate_string(value);
    let envelope: string;
    let profile_id: Uint8Array;
    if (this.color_management_system === ColorManagementSystem.OCIO) {
      envelope = this._ocio_envelope(value);
      profile_id = bytes_.repeat(b("\xff"), 16);
    } else if (value === "None") {
      // No working space, which the getter reports as "None": AE 2026
      // saves `workingSpace = "None"` as an empty `{}` profile after
      // `PwCs` and an all-0xFF `cpid`, like a new project.
      envelope = "{}";
      profile_id = bytes_.repeat(b("\xff"), 16);
    } else {
      // bytes_for already raises ColorProfileNotFoundError for an
      // unknown Adobe profile name, so no separate name check is needed.
      const icc = this._icc_lib().bytes_for(value);
      envelope = build_icc_envelope(value, icc);
      profile_id = icc_profile_id(icc);
    }
    this._ws_utf8 = this._rewrite_color_profile("PwCs", envelope);
    // AE 2026 rewrites `cpid` to the new profile's id when a script sets
    // workingSpace; OCIO projects store all 0xFF.
    this._cpid.data = profile_id;
  }

  get _cpid(): CpidChunk {
    return find_by_type(this._root_chunks, "cpid");
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
  _ocio_envelope(name: string): string {
    const config = require_ocio_config(
      this.ocio_configuration_file,
      `build the color-profile envelope for ${repr(name)}`,
    );
    return ocio_color_profile_envelope(config, name);
  }

  /**
   * Directories scanned to resolve ICC profiles when writing an
   * Adobe-CMS working space. `null` (default) auto-discovers the standard
   * Adobe Color directories. Assign an array of folders containing `.icc`/
   * `.icm` files to override (e.g. for a non-default install or CI).
   */
  get icc_profile_dirs(): Path[] | null {
    return this._icc_profile_dirs;
  }

  set icc_profile_dirs(value: PathLike[] | null) {
    if (value != null) {
      if (!is_list_or_tuple(value)) {
        throw new TypeError_(
          "icc_profile_dirs must be a list of directories or None, " +
            `got ${type_name(value)}`,
        );
      }
      for (const p of value) validate_path_exists(p);
    }
    this._icc_profile_dirs = value != null ? value.map((p: PathLike) => new Path(p)) : null;
    this._icc_library = null; // rebuild on next use
  }

  _icc_lib(): IccProfileLibrary {
    if (this._icc_library == null) {
      this._icc_library = new IccProfileLibrary(this._icc_profile_dirs);
    }
    return this._icc_library;
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
  get display_color_space(): string {
    if (this._dcs_utf8 != null) return envelope_profile_name(this._dcs_utf8.value);
    return "None";
  }

  set display_color_space(value: [string, string] | string) {
    if (this.color_management_system !== ColorManagementSystem.OCIO) {
      throw new NotImplementedError(
        "display_color_space is only settable in OCIO mode. In Adobe " +
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
          "display_color_space string must be 'display/view'; got " +
            `${repr(value)}. Pass a (display, view) tuple to disambiguate.`,
        );
      }
    } else if (Array.isArray(value) && value.length === 2) {
      [display, view] = value;
    } else {
      throw new TypeError_(
        "display_color_space expects a 'display/view' string or a " +
          `(display, view) tuple, got ${type_name(value)}`,
      );
    }
    validate_string(display);
    validate_string(view);
    const envelope = build_ocio_display_envelope(display, view);
    this._dcs_utf8 = this._rewrite_color_profile("pdvc", envelope);
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
  _rewrite_color_profile(marker: string, envelope: string): Utf8Chunk {
    const root = this._root_chunks;
    for (const [i, chunk] of root.entries()) {
      if (chunk.chunk_type === marker) {
        const utf8 = find_by_type_or_null(root.slice(i + 1, i + 2), "Utf8");
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
  get color_management_system(): ColorManagementSystem {
    const settings = this._get_cms_settings();
    return ColorManagementSystem.of(json_int(getitem(settings, "colorManagementSystem")));
  }

  set color_management_system(value: ColorManagementSystem | number) {
    _set_color_management_system.call(this, value);
  }

  /**
   * The LUT interpolation method for the project (Trilinear or
   * Tetrahedral). Read / Write.
   */
  get lut_interpolation_method(): LutInterpolationMethod {
    const settings = this._get_cms_settings();
    return LutInterpolationMethod.of(json_int(getitem(settings, "lutInterpolationMethod")));
  }

  set lut_interpolation_method(value: LutInterpolationMethod | number) {
    _set_lut_interpolation_method.call(this, value);
  }

  /**
   * The OCIO configuration file for the project. Only relevant when
   * color_management_system is OCIO. Read / Write.
   */
  get ocio_configuration_file(): string {
    const settings = this._get_cms_settings();
    return str(getitem(settings, "ocioConfigurationFile"));
  }

  set ocio_configuration_file(value: PathLike) {
    _set_ocio_configuration_file.call(this, value);
  }

  /**
   * Return the color-space names assignable in the current CMS mode.
   *
   * These are the names valid for {@link working_space} (and, in Adobe mode,
   * [media_color_space][
   * py_aep.models.sources.footage.FootageSource.media_color_space] and the
   * output color space).
   *
   * - Adobe CMS: the catalogued Adobe ICC profile names.
   * - OCIO: the active color spaces of {@link ocio_configuration_file} (a `.ocio`
   *   path or a built-in name like `"ACES 1.2"`). Returns `[]` if the config
   *   cannot be located or read.
   */
  list_color_profiles(): string[] {
    if (this.color_management_system === ColorManagementSystem.OCIO) {
      const config_path = resolve_ocio_config(this.ocio_configuration_file);
      if (config_path == null) return [];
      return list_config_color_spaces(config_path);
    }
    return adobe_color_profile_names();
  }

  /** The name of the project, derived from the file name. */
  get project_name(): string {
    return new Path(this.file).name;
  }

  /**
   * Return the number of items in the project.
   *
   * **Note:** Equivalent to `len(project.items)`
   */
  get num_items(): number {
    return this.items.size;
  }

  /** Get a layer by its unique ID. */
  layer_by_id(layer_id: number): Layer {
    for (const comp of this.compositions) {
      const layer = comp.layers_by_id.get(layer_id);
      if (layer !== undefined) return layer;
    }
    throw new KeyError(`Layer with ID ${layer_id} not found`);
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
   * @param frame_rate - Frame rate in fps (1.0-99.0).
   * @param duration - Duration in seconds (\> 0, \<= 10800).
   * @returns The newly created {@link FootageItem}.
   */
  import_placeholder(
    name: string | null,
    width: number,
    height: number,
    frame_rate: number,
    duration: number,
  ): FootageItem {
    if (name == null) {
      name = "Missing Name";
    } else if (name === "") {
      name = "Placeholder";
    }

    const source = PlaceholderSource._new(name, width, height, frame_rate, duration);
    const item = FootageItem._new(source, { project: this, parent_folder: this.root_folder });

    // Insert into root folder's chunk tree and register
    const container = this.root_folder._children_container;
    container.push(item._item_list);
    container.push(...item._view_data);
    this.items.set(item.id, item);
    this.root_folder.items.push(item);
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
   *   supported. With `ImportOptions.layer_index` set (py_aep extension mirroring the "Choose
   *   Layer" option of AE's import dialog), a FOOTAGE import of a layered file references that
   *   single layer instead of the merged/whole document; see also `ImportOptions.layer_dimensions`
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
  import_file(options: ImportOptions): FootageItem | CompItem {
    if (!(options instanceof ImportOptions)) {
      throw new ValueError(`Expected ImportOptions, got ${type_name(options)}`);
    }

    if (options.layer_index != null) {
      if (options.import_as !== ImportAsType.FOOTAGE) {
        throw new ValueError(
          "layer_index applies to ImportAsType.FOOTAGE only; COMP " + "imports include every layer",
        );
      }
      if (options.sequence) {
        throw new ValueError("layer_index cannot be combined with sequence");
      }
    } else if (options.layer_dimensions != null) {
      throw new ValueError("layer_dimensions requires layer_index");
    }

    const suffix = options.file.suffix.toLowerCase();
    if (options.layer_styles != null) {
      if (!PSD_COMP_EXTENSIONS.has(suffix)) {
        throw new ValueError("layer_styles applies to Photoshop (.psd/.psb) imports only");
      }
      if (options.import_as === ImportAsType.FOOTAGE) {
        if (options.layer_index == null) {
          throw new ValueError(
            "layer_styles requires layer_index for a FOOTAGE " +
              'import: a "Merged Layers" whole-document import ' +
              "always flattens the styles into the composite",
          );
        }
        if (options.layer_styles === "editable") {
          throw new ValueError(
            "editable layer styles require a COMP import; a " +
              'FOOTAGE import offers "merge" or "ignore"',
          );
        }
      } else if (options.layer_styles === "ignore") {
        throw new ValueError(
          'a COMP import offers "editable" or "merge" layer ' +
            "styles (AE's dialog has no Ignore option there)",
        );
      }
    }
    if (options.import_as === ImportAsType.COMP_CROPPED_LAYERS) {
      if (suffix === ".svg") {
        return this._import_svg_cropped(options.file);
      }
      if (PSD_COMP_EXTENSIONS.has(suffix)) {
        return this._import_psd_layered(options.file, true, this._resolve_comp_layer_styles(options));
      }
      if (AI_COMP_EXTENSIONS.has(suffix)) {
        return this._import_ai_layered(options.file, { cropped: true });
      }
      throw new ValueError(
        "import_file supports COMP_CROPPED_LAYERS for SVG and layered " +
          `.ai/.pdf/.psd/.psb; ${suffix} cropped import is not implemented yet`,
      );
    }
    if (options.import_as === ImportAsType.COMP) {
      if (AI_COMP_EXTENSIONS.has(suffix)) {
        return this._import_ai_layered(options.file);
      }
      if (EPS_COMP_EXTENSIONS.has(suffix)) {
        return this._import_eps_comp(options.file);
      }
      if (PSD_COMP_EXTENSIONS.has(suffix)) {
        return this._import_psd_layered(options.file, false, this._resolve_comp_layer_styles(options));
      }
      throw new ValueError(`import_file does not support COMP import for ${repr(suffix)}`);
    }
    if (options.import_as === ImportAsType.PROJECT) {
      throw new ValueError(
        "import_file does not support PROJECT import (importing an " + ".aep/.aet, or an AE project embedded in a .mov/.m4a)",
      );
    }
    if (options.import_as !== ImportAsType.FOOTAGE) {
      throw new ValueError(
        "import_file supports ImportAsType.FOOTAGE, COMP (layered " +
          ".ai/.pdf/.psd/.psb), and COMP_CROPPED_LAYERS (SVG, " +
          ".ai/.pdf/.psd/.psb), " +
          `got ${ImportAsType.name_of(options.import_as)}`,
      );
    }

    let source: FileSource;
    if (options.layer_index != null) {
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
      let dimensions = options.layer_dimensions;
      let styles = options.layer_styles;
      if (PSD_COMP_EXTENSIONS.has(suffix)) {
        if (styles == null) styles = psd_footage_layer_styles(this._preferences);
        if (dimensions == null) dimensions = psd_footage_dimensions(this._preferences);
      }
      source = FileSource._from_layer(options.file, options.layer_index, {
        dimensions,
        layer_styles: styles,
        windows: this._windows,
      });
    } else {
      source = FileSource._from_file(options.file, {
        sequence: options.sequence,
        force_alphabetical: options.force_alphabetical,
        windows: this._windows,
        default_sequence_fps: default_sequence_fps(this._preferences),
        range_start: options.sequence ? options.range_start : 0,
        range_end: options.sequence ? options.range_end : 0,
      });
    }

    const item = FootageItem._new(source, { project: this, parent_folder: this.root_folder });
    const container = this.root_folder._children_container;
    container.push(item._item_list);
    container.push(...item._view_data);
    this.items.set(item.id, item);
    this.root_folder.items.push(item);
    return item;
  }

  /**
   * The COMP-import Layer Options value: the user's explicit choice, or
   * the machine's sticky PSD-comp import preference. `null` (no preference,
   * or no preferences directory) keeps AE's `editable` dialog default.
   */
  _resolve_comp_layer_styles(options: ImportOptions): string | null {
    if (options.layer_styles != null) return options.layer_styles;
    return psd_comp_layer_styles(this._preferences);
  }

  /** Import an SVG as a cropped comp (one shape layer of its art). */
  _import_svg_cropped(file: Path): CompItem {
    const doc = read_svg(file);
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
    const comp = this.root_folder._add_comp(file.name, width, height, 1.0, 1.0 / 30.0, 30.0, {
      min_dimension: 1,
    });
    const layer = comp.add_shape();
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
    build_shape_layer_contents(contents, doc.drawables);
    return comp;
  }

  /**
   * Create an import composition (full canvas and the file's pixel
   * aspect - AE 2026 gives a 4:3 PSD a 4:3 comp - at AE's default
   * timing).
   */
  _new_layered_comp(
    parent_folder: FolderItem,
    name: string,
    width: number,
    height: number,
    pixel_aspect: number,
  ): CompItem {
    const frames = round(_LAYERED_COMP_DURATION_SECONDS * _LAYERED_COMP_FRAME_RATE);
    const comp = parent_folder.add_comp(
      name,
      width,
      height,
      pixel_aspect,
      frames / _LAYERED_COMP_FRAME_RATE,
      _LAYERED_COMP_FRAME_RATE,
    );
    // AE gives a layered-import comp shutter phase -90 (unlike a
    // script-created comp, which AE leaves at 0 - as add_comp's skeleton
    // does); so set it only here, on the import path.
    comp.shutter_phase = -90;
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
   * @param source_format - The `sspc` source-format code (`TEXT`, `8BPS`, ...).
   * @param layer_specs - Top-level {@link LayerSpec}/{@link LayerGroupSpec} nodes, in document
   *   order (bottom layer first).
   * @param info - The probed media info for `file` (canvas size, alpha, ...).
   * @param embedded_profile_name - Optional ICC profile name for the sources.
   */
  _import_layered_comp(
    file: Path,
    source_format: string,
    layer_specs: (LayerSpec | LayerGroupSpec)[],
    info: MediaInfo,
    embedded_profile_name: string | null = null,
  ): CompItem {
    // Before anything is added: every layer's footage spans the canvas.
    check_footage_size(file.name, info.width, info.height);
    const folder = this.root_folder.add_folder(`${file.stem} Layers`);
    const comp = this._new_layered_comp(this.root_folder, file.stem, info.width, info.height, info.pixel_aspect);
    this._add_layered_specs(comp, folder, layer_specs, file, source_format, info, embedded_profile_name);
    // AE stores the `<stem> Layers` folder's Sfdr in the Project-panel
    // alphabetical order, not the document order the items are built in
    // (verified against the grouped_layers / layer_bounds AE fixtures).
    folder._sort_children_by_name();
    // AE places the `<stem> Layers` folder immediately after the comp (before
    // the project's pre-existing items); add_folder appended it, so move it
    // into position to match AE's Fold ordering.
    const container = this.root_folder._children_container;
    container.splice(index_by_identity(container, folder._item_list), 1);
    const comp_idx = index_by_identity(container, comp._item_list);
    container.splice(comp_idx + 1 + comp._view_data.length, 0, folder._item_list);
    return comp;
  }

  /**
   * Add one layer per spec to `comp` (groups become nested comps).
   *
   * Leaf footage items and nested group comps both live in `folder`,
   * matching AE's flat `<stem> Layers` folder.
   */
  _add_layered_specs(
    comp: CompItem,
    folder: FolderItem,
    specs: (LayerSpec | LayerGroupSpec)[],
    file: Path,
    source_format: string,
    info: MediaInfo,
    embedded_profile_name: string | null,
  ): void {
    for (const spec of specs) {
      if (spec instanceof LayerGroupSpec) {
        const nested = this._new_layered_comp(
          folder,
          spec.comp_name != null ? spec.comp_name : spec.name,
          info.width,
          info.height,
          info.pixel_aspect,
        );
        this._add_layered_specs(nested, folder, spec.children, file, source_format, info, embedded_profile_name);
        // AE imports a PSD group as a collapsed precomp and leaves the
        // layer name empty (it inherits the nested comp's name), so
        // `name_set` stays off - matching avoids both deltas. A
        // clipping-run precomp instead bakes the base layer's name
        // (still with `name_set` off) and stays uncollapsed.
        const group_layer = comp.add(nested);
        if (spec.collapsed) group_layer.collapse_transformation = true;
        if (!spec.enabled) group_layer.enabled = false;
        if (spec.layer_name != null) {
          group_layer.name = spec.layer_name;
          group_layer._ldta.name_set = false;
        }
        _serialize_import_layer_styles(group_layer, null, file.name);
        continue;
      }
      const has_alpha = spec.has_alpha == null ? info.has_alpha : spec.has_alpha;
      const depth = spec.depth == null ? info.depth : spec.depth;
      const source = FileSource._new(file, {
        source_format,
        width: spec.width,
        height: spec.height,
        duration: 0.0,
        frame_rate: 0.0,
        pixel_aspect: info.pixel_aspect,
        icc_profile: info.icc_profile,
        has_alpha,
        depth,
        opti_data: spec.opti_data,
        embedded_profile_name,
        full_frame: spec.full_frame,
        layer_name: spec.layer_index != null ? spec.name : "",
        layer_id: spec.layer_id,
        layer_index: spec.layer_index,
        data_size: spec.data_size,
        reserved_c8: spec.reserved_c8,
        color_mode: info.color_mode,
        windows: this._windows,
      });
      const footage = FootageItem._new(source, { project: this, parent_folder: folder });
      folder._children_container.push(footage._item_list);
      folder._children_container.push(...footage._view_data);
      this.items.set(footage.id, footage);
      folder.items.push(footage);
      const layer = comp.add(footage);
      // AE 2026 cuts an imported layer's name to its longest UTF-8
      // prefix of 255 bytes (a 313-byte Photoshop layer name).
      layer.name = decode(truncate_utf8(spec.name, 255), "utf-8");
      if (!spec.enabled) layer.enabled = false;
      if (spec.transform != null) {
        const [[anchor_x, anchor_y], [position_x, position_y]] = spec.transform;
        const transform = layer.transform;
        transform.property("ADBE Anchor Point").value = [anchor_x, anchor_y, 0.0];
        transform.property("ADBE Position").value = [position_x, position_y, 0.0];
      }
      if (spec.is_adjustment) layer.adjustment_layer = true;
      if (spec.preserve_transparency) layer.preserve_transparency = true;
      if (spec.masks?.length > 0) {
        // A PSD vector-mask/shape-layer path: AE creates one mask
        // per subpath (psd_vector_mask* fixtures).
        const parade = layer.property("ADBE Mask Parade");
        for (const shape of spec.masks) {
          const mask = parade.add_property("ADBE Mask Atom");
          mask.property("ADBE Mask Shape").value = shape;
        }
      }
      _serialize_import_layer_styles(layer, spec.styles, file.name);
    }
  }

  /**
   * Import a layered Illustrator/PDF file as a composition.
   *
   * `cropped` is Composition - Retain Layer Sizes: each layer's footage
   * takes its "Layer Size" artwork box (`resolvers.ai_bounds`) and the
   * comp layer is placed where that box sits on the page.
   */
  _import_ai_layered(file: Path, kw: { cropped?: boolean } = {}): CompItem {
    const { cropped = false } = kw;
    // Read once: the probe, the ICC scan and the layer scan all consume
    // the same bytes.
    const data = file.read_bytes();
    let info = probe_media(file, data);
    // The page's RGB profile is embedded like a raster file's; a non-RGB
    // one is recorded by name.
    const [icc, profile_name] = ai_document_profile(file, data);
    info = new MediaInfo({ ...info, icc_profile: icc }); // info._replace(icc_profile=icc)
    const layers = read_ai_layer_ocgs(file, data);
    const boxes = cropped ? read_ai_layer_bounds(file, data) : null;
    const specs: (LayerSpec | LayerGroupSpec)[] = [];
    for (const [index, layer] of layers.entries()) {
      let box: Box | null = null;
      let width = info.width;
      let height = info.height;
      let transform: [[number, number], [number, number]] | null = null;
      if (boxes != null) {
        const measured = boxes[index];
        box = measured == null ? EMPTY_BOX : measured;
        [width, height] = footage_size(measured);
        transform = _ai_cropped_transform(box, info.height);
      }
      specs.push(
        new LayerSpec(
          layer.name,
          build_ai_layer_opti_data(info.width, info.height, layer.name, layers.length, box, layer.visible),
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
    return this._import_layered_comp(file, "TEXT", specs, info, profile_name);
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
  _import_eps_comp(file: Path): CompItem {
    const info = probe_media(file);
    const spec = new LayerSpec(file.name, build_text_opti_data(info.width, info.height), info.width, info.height);
    return this._import_layered_comp(file, "TEXT", [spec], info, null);
  }

  /**
   * Import a layered Photoshop file (`.psd`/`.psb`) as a composition.
   *
   * Layer groups become nested compositions (recursively); adjustment
   * layers are flagged. With `cropped`, each leaf layer is cropped to its
   * content box (`COMP_CROPPED_LAYERS`); otherwise the full canvas is kept
   * (`COMP`). `layer_styles` is the dialog's Layer Options choice
   * (`"editable"`, the default, or `"merge"`; see
   * `ImportOptions.layer_styles`).
   *
   * A flattened file (no layer records) is imported as a one-layer
   * composition of the merged still, matching AE 2026: a `<stem> Layers`
   * folder holding one footage item that references the file, and a comp
   * with a single full-canvas layer named after the file.
   */
  _import_psd_layered(file: Path, cropped = false, layer_styles: string | null = null): CompItem {
    const info = probe_media(file);
    let nodes: PsdNode[];
    try {
      nodes = read_psd_layers(file);
    } catch (e) {
      if (!(e instanceof FlattenedPsdError)) throw e;
      const spec = new LayerSpec(
        file.name,
        build_psd_flattened_opti_data(info.width, info.height, info.bit_depth, info.pixel_channels, {
          color_mode: info.color_mode,
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
        pixel_buffer_size(info.width, info.height, info.pixel_channels, info.bit_depth),
      );
      return this._import_layered_comp(file, "8BPS", [spec], info, named_media_profile("8BPS", info));
    }
    const resolved_styles = layer_styles == null ? "editable" : layer_styles;
    const specs = this._psd_layer_specs(
      nodes,
      file,
      info,
      cropped,
      resolved_styles,
      // The global light is a document constant; read it once here
      // rather than per recursion level (one file scan per group).
      read_global_light(file),
    );
    return this._import_layered_comp(file, "8BPS", specs, info, named_media_profile("8BPS", info));
  }

  /**
   * Convert a PSD layer tree into import specs (recursively).
   *
   * `info` is the probed document (canvas, bit depth, layer count,
   * channels). `clip_counter` numbers the clipping-run precomps
   * document-wide (AE names them `"<stem> (n)"`); `group_clipping=False`
   * disables run detection while building a run's own children.
   */
  _psd_layer_specs(
    nodes: PsdNode[],
    file: Path,
    info: MediaInfo,
    cropped: boolean,
    layer_styles: string,
    global_light: [number, number],
    clip_counter: Generator<number> | null = null,
    group_clipping = true,
  ): (LayerSpec | LayerGroupSpec)[] {
    const canvas_w = info.width;
    const canvas_h = info.height;
    if (clip_counter == null) clip_counter = count(1);
    const reserved_c8 = getitem(PSD_LAYER_STYLES_C8, layer_styles);
    const specs: (LayerSpec | LayerGroupSpec)[] = [];
    let index = 0;
    while (index < nodes.length) {
      const node = nodes[index];
      index += 1;
      if (node instanceof PsdGroup) {
        if (has_enabled_styles(node)) {
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
            this._psd_layer_specs(node.children, file, info, cropped, layer_styles, global_light, clip_counter),
            undefined,
            undefined,
            undefined,
            node.visible,
          ),
        );
        continue;
      }
      if (group_clipping && !node.clipped) {
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
              this._psd_layer_specs(run, file, info, cropped, layer_styles, global_light, clip_counter, false),
              `${file.stem} (${clip_counter.next().value})`,
              node.name,
              false,
              undefined,
            ),
          );
          continue;
        }
      }
      const styles = layer_styles === "editable" ? parse_layer_styles(node, global_light) : null;
      // AE stores the content box and crops the layer to it.
      const footage = psd_layer_footage(info, node, layer_styles, global_light[0]);
      const [left, top, right, bottom] = footage.box;
      let masks: Shape[] = [];
      if (node.vector_mask != null) {
        masks = parse_vector_mask(node.vector_mask, canvas_w, canvas_h);
      }
      if (cropped) {
        // An empty layer (degenerate content box) is kept at FULL
        // CANVAS size, centered - not cropped to 1x1 (probed AE 2026:
        // psd_clipping_mask "Layer 1" and grouped_layers "hue/sat adj"
        // both bounds (0,0,0,0) -> full-canvas, centered).
        let box: [number, number, number, number];
        if (right <= left || bottom <= top) {
          box = [0, 0, canvas_w, canvas_h];
        } else {
          box = [left, top, right, bottom];
        }
        const [b_left, b_top, b_right, b_bottom] = box;
        const crop_w = b_right - b_left;
        const crop_h = b_bottom - b_top;
        // Anchor at the cropped footage centre; position the layer so the
        // content sits where it was in the document (AE 2026 verified).
        const transform: [[number, number], [number, number]] = [
          [crop_w / 2, crop_h / 2],
          [(b_left + b_right) / 2, (b_top + b_bottom) / 2],
        ];
        // Mask vertices are canvas coordinates; a cropped layer's
        // source origin is the content box.
        masks = masks.map(
          (shape) =>
            new Shape(
              shape.vertices.map(([x, y]) => [x - b_left, y - b_top]),
              shape.in_tangents,
              shape.out_tangents,
              { closed: shape.closed },
            ),
        );
        specs.push(
          new LayerSpec(
            node.name,
            footage.opti_data,
            crop_w,
            crop_h,
            transform,
            false,
            node.is_adjustment,
            node.layer_id,
            node.record_index,
            // Empty layers have no pixels: data_size stays 0 (from
            // the real bounds), even though the layer is full-canvas.
            footage.data_size,
            reserved_c8,
            styles,
            masks,
            !group_clipping && node.clipped,
            node.visible,
            footage.has_alpha,
            footage.depth,
          ),
        );
      } else {
        specs.push(
          new LayerSpec(
            node.name,
            footage.opti_data,
            canvas_w,
            canvas_h,
            undefined,
            undefined,
            node.is_adjustment,
            node.layer_id,
            node.record_index,
            footage.data_size,
            reserved_c8,
            styles,
            masks,
            !group_clipping && node.clipped,
            node.visible,
            footage.has_alpha,
            footage.depth,
          ),
        );
      }
    }
    return specs;
  }

  *_iter_text_source_properties(): Generator<[Layer, Property<TextDocument>]> {
    /** Yield `(layer, source_text)` for every text layer in the project. */
    for (const comp of this.compositions) {
      for (const layer of comp.layers) {
        const group = layer.text;
        if (group == null) continue;
        const source_text = group.property("ADBE Text Document");
        if (source_text instanceof Property) yield [layer, source_text];
      }
    }
  }

  /**
   * Returns an Array of Objects containing references to used fonts
   * and the Text Layers and times on which they appear in the current
   * Project. Read-only.
   *
   * Each entry is `{"font": FontObject, "used_at": [...]}`, where every
   * `used_at` record is `{"layer_id": int, "layer_time": float}` - one
   * per source-text keyframe whose document references that font (a
   * single record at time 0 for an unanimated document). A document
   * with several fonts contributes one record per distinct font.
   * Entries are sorted by PostScript name, matching After Effects.
   *
   * **Note:** `layer_time` is in LAYER time, not composition time - After
   * Effects names it `layerTimeD` because `Source Text`'s
   * `value_at_time` expects layer time, unlike other properties.
   */
  get used_fonts(): { font: FontObject; used_at: { layer_id: number; layer_time: number }[] }[] {
    const records = new Map<
      string,
      { name: string; font: FontObject; used_at: { layer_id: number; layer_time: number }[] }
    >();
    for (const [layer, source_text] of this._iter_text_source_properties()) {
      let entries: [TextDocument, number][];
      if (source_text.keyframes?.length > 0) {
        entries = source_text.keyframes.map(
          (kf) => [kf.value, kf.time - layer.start_time],
        );
      } else {
        entries = [[source_text.value, 0.0]];
      }
      for (const [doc, layer_time] of entries) {
        if (doc == null) continue;
        for (const font of doc._used_font_objects()) {
          const vector = font.design_vector;
          const key = tkey(font.post_script_name, font.version, vector != null ? [...vector] : null);
          let record = records.get(key);
          if (record == null) {
            record = { name: font.post_script_name, font, used_at: [] };
            records.set(key, record);
          }
          record.used_at.push({ layer_id: layer.id, layer_time });
        }
      }
    }
    return sorted([...records.values()], (r) => r.name).map((r) => ({ font: r.font, used_at: r.used_at }));
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
   * {@link Project.used_fonts | used_fonts}) or as a PostScript name.
   *
   * @param from_font - Font to be replaced.
   * @param to_font - Font to replace it with.
   * @param no_font_locking - Accepted for ExtendScript parity and ignored. After Effects uses it to
   *   suppress the fallback font it picks when `to_font` lacks glyphs for the text; that fallback
   *   is a runtime font-engine decision py_aep does not make, so py_aep always performs the direct
   *   replacement (i.e. it behaves as if this were `true`).
   * @returns `true` if at least one layer was changed.
   */
  replace_font(from_font: FontObject | string, to_font: FontObject | string, no_font_locking = false): boolean {
    validate_bool(no_font_locking);
    const from_name = _font_post_script_name(from_font);
    const to_name = _font_post_script_name(to_font);
    if (from_name === to_name) return false;

    let changed = false;
    for (const [, source_text] of this._iter_text_source_properties()) {
      let docs = source_text.keyframes.map((kf) => kf.value);
      if (!docs?.length) docs = [source_text.value];
      docs = docs.filter((doc) => doc != null);
      if (docs?.length > 0 && _replace_layer_font(docs, from_name, to_name)) changed = true;
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
   * @param old_text - The text to replace.
   * @param new_text - The new text.
   */
  auto_fix_expressions(old_text: string, new_text: string): void {
    validate_string(old_text);
    validate_string(new_text);
    if (!old_text) return;
    const old_double = `"${old_text}"`;
    const new_double = `"${new_text}"`;
    const old_single = `'${old_text}'`;
    const new_single = `'${new_text}'`;

    for (const comp of this.compositions) {
      for (const layer of comp.layers) {
        for (const prop of layer._leaf_properties()) {
          const expression = prop.expression;
          if (!expression || !prop.expression_enabled) continue;
          // Python `str.replace` replaces every occurrence and takes no
          // replacement escapes, so split/join is the literal equivalent.
          const fixed = expression.split(old_double).join(new_double).split(old_single).join(new_single);
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
  remove_unused_footage(): number {
    let removed = 0;
    for (const footage of this.footages) {
      if (!footage.used_in?.length) {
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
   * @param items_to_keep - The items to keep in the project.
   * @returns The total number of items removed.
   */
  reduce_project(items_to_keep: Item[]): number {
    if (!items_to_keep.every((item) => item instanceof Item)) {
      throw new ValueError("All items_to_keep must be Item instances");
    }
    const keep_ids = new Set<number>([0]);
    const queue = [...items_to_keep];
    for (let item = queue.pop(); item !== undefined; item = queue.pop()) {
      if (keep_ids.has(item.id)) continue;
      keep_ids.add(item.id);
      let parent = item.parent_folder;
      while (parent != null && !keep_ids.has(parent.id)) {
        keep_ids.add(parent.id);
        parent = parent.parent_folder;
      }
      if (item instanceof CompItem) {
        for (const source_id of item._source_ids_for_linking()) {
          const source = this.items.get(source_id) ?? null;
          if (source != null) queue.push(source);
        }
      }
    }
    let removed = 0;
    for (const item_id of [...this.items.keys()]) {
      const item = keep_ids.has(item_id) ? undefined : this.items.get(item_id);
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
  consolidate_footage(): number {
    const groups = new Map<string, FootageItem[]>();
    for (const footage of this.footages) {
      const key = footage._consolidation_key();
      if (key == null) continue;
      setdefault(groups, key, []).push(footage);
    }
    let removed = 0;
    for (const duplicates of groups.values()) {
      if (duplicates.length < 2) continue;
      const kept = duplicates[0];
      for (const dup of duplicates.slice(1)) {
        for (const comp of dup.used_in) {
          for (const layer of comp.av_layers) {
            if (layer._source_id === dup.id) {
              layer._source_id = kept.id;
              // Refresh the layer's cached source so a prior
              // `layer.source` access doesn't keep returning
              // the removed duplicate.
              layer._source = kept;
              kept._used_in.add(comp);
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
    validate_path_does_not_exist(path);
    for (const comp of this.compositions) {
      // A comp whose layers were never loaded has had nothing moved.
      if (comp._layers_loaded) {
        for (const layer of comp.layers) {
          layer._write_out_moved_defaults();
        }
      }
    }
    const path_obj = new Path(path);
    path_obj.parent.mkdir({ parents: true, exist_ok: true });
    const filled = this._fill_relative_path_counts(
      platform_path(host.path.resolve(String(path_obj)), { windows: this._windows }),
    );
    // Write to a sibling temp file then rename, so a serialization
    // error can never leave a truncated .aep at the target path. The
    // temp name is unique and created exclusively: a fixed one would
    // overwrite, then move away, any file of the user's carrying it.
    const tmp_path = path_obj.with_name(`${path_obj.name}.${uuid4().replace(/-/g, "")}.tmp`);
    try {
      // `tmp_path.open("xb")`: created exclusively before anything is written.
      const fd = host.fs.openSync(tmp_path.path, "wx");
      try {
        const buf = new BytesIO();
        module_globals.write_aep(buf, this._rifx, this._xmp);
        host.fs.writeSync(fd, buf.getvalue());
      } finally {
        host.fs.closeSync(fd);
      }
    } catch (e) {
      if (tmp_path.exists()) tmp_path.unlink(); // missing_ok needs Python 3.8
      throw e;
    } finally {
      // Back to pending, so a later save computes them for its own
      // location.
      for (const [alas, text] of filled) {
        alas.value = text;
      }
    }
    tmp_path.replace(path_obj);
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
  _fill_relative_path_counts(project_file: string): [Utf8Chunk, string][] {
    const filled: [Utf8Chunk, string][] = [];
    for (const chunk of recursive_find(this._rifx.chunks, "alas", undefined, true)) {
      const alas = chunk;
      const text = alas.value;
      const data = text ? json_loads(text) : new Map<string, JsonValue>();
      if (!(data instanceof Map)) throw new AttributeError(`'${type_name(data)}' object has no attribute 'get'`);
      if (!py_eq(dict_get(data, "ascendcount_base"), PENDING_ASCENDCOUNT)) continue;
      const counts = relative_path_counts(project_file, alas_fullpath(data), {
        target_is_folder: py_bool(dict_get(data, "target_is_folder")),
      });
      data.set("ascendcount_base", counts[0]);
      data.set("ascendcount_target", counts[1]);
      filled.push([alas, text]);
      alas.value = dump_alas(data);
    }
    return filled;
  }

  /** Return the AE preferences directory or raise if none was given. */
  _require_prefs_dir(label: string): Path {
    if (this._ae_preferences_dir == null) {
      throw new ValueError(
        "No 'ae_preferences_dir' provided to parse(); " +
          `${label} templates are required for adding items ` +
          "to the render queue. Pass ae_preferences_dir pointing to " +
          "the AE preferences directory (e.g. " +
          "C:/Users/<user>/AppData/Roaming/Adobe/After Effects/26.0)",
      );
    }
    return this._ae_preferences_dir;
  }

  /**
   * Lazily parse render settings templates from AE preferences.
   *
   * @throws {@link ValueError} If no preferences directory was provided to `parse()`. Render
   *   settings templates are required for adding items to the render queue.
   */
  _get_render_templates(): RenderSettingsItem[] {
    if (this._render_templates_cache != null) return this._render_templates_cache;

    const prefs_dir = this._require_prefs_dir("render settings");
    const [templates, default_index] = parse_render_templates(prefs_dir);
    this._default_render_template_index = default_index;

    this._render_templates_cache = templates;
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
  _get_output_templates(): OutputModuleTemplate[] {
    if (this._output_templates_cache != null) return this._output_templates_cache;

    const prefs_dir = this._require_prefs_dir("output module");
    const [templates] = parse_output_templates(prefs_dir);

    this._output_templates_cache = templates;
    return this._output_templates_cache;
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
  _allocate_id(): number {
    if (!this._id_counter_reconciled) {
      const layer_ids: number[] = [];
      for (const comp of this.compositions) {
        for (const ldta of recursive_find(comp._item_list.chunks, "ldta")) {
          layer_ids.push(ldta.layer_id);
        }
      }
      const max_layer_id = max(layer_ids, null, 0);
      const max_item_id = max([...this.items.keys()], null, 0);
      const floor = max([max_layer_id, max_item_id]) + 1;
      if (this._head.next_item_id < floor) {
        this._head.next_item_id = floor;
      }
      this._id_counter_reconciled = true;
    }
    const new_id = this._head.next_item_id;
    this._head.next_item_id = new_id + 1;
    return new_id;
  }

  /**
   * The solids folder name stored in the project's root `sfnm` chunk.
   *
   * AE stamps the "New Project Solids Folder" preference into `sfnm`
   * when the project is created and uses the stored name from then on.
   */
  get _solids_folder_name(): string {
    const sfnm = find_by_list_type_or_null(this._rifx.chunks, "sfnm");
    const utf8 = sfnm === null ? null : find_by_type_or_null(sfnm.chunks, "Utf8");
    return utf8?.value || "Solids";
  }

  get _sfid(): U4LeChunk | null {
    const sfnm = find_by_list_type_or_null(this._rifx.chunks, "sfnm");
    return sfnm === null ? null : find_by_type_or_null(sfnm.chunks, "sfid");
  }

  /** The item id of the Solids folder recorded in `sfid` (0 for none). */
  get _solids_folder_id(): number {
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
  get _solids_folder(): FolderItem {
    const sfid = this._sfid;
    const recorded = sfid != null ? sfid.value : 0;
    const folder = recorded ? this.items.get(recorded) ?? null : null;
    if (folder instanceof FolderItem) return folder;
    const name = this._solids_folder_name;
    for (const existing of this.root_folder.folders) {
      if (existing.name === name) return existing;
    }
    const created = this.root_folder.add_folder(name);
    if (sfid != null) sfid.value = created.id;
    return created;
  }

  static _CMS_DEFAULTS: Record<string, number | string> = {
    colorManagementSystem: 0,
    lutInterpolationMethod: 0,
    ocioConfigurationFile: "",
  };

  /** Return the color profile settings Map. */
  _get_cms_settings(): Map<string, JsonValue> {
    const merged = new Map<string, JsonValue>(Object.entries(this.constructor._CMS_DEFAULTS));
    if (this._cms_utf8 != null) {
      const cms_data = json_loads(this._cms_utf8.value);
      if (!(cms_data instanceof Map)) throw new TypeError_(`'${type_name(cms_data)}' object is not a mapping`);
      for (const [k, v] of cms_data) merged.set(k, v);
    }
    return merged;
  }

  /** Update a single key in the CMS settings JSON chunk. */
  _update_cms_setting(key: string, value: number | string): void {
    if (this._cms_utf8 != null) {
      const data = json_loads(this._cms_utf8.value);
      if (!(data instanceof Map)) throw new TypeError_(`'${type_name(data)}' object does not support item assignment`);
      data.set(key, value);
      this._cms_utf8.value = json_dumps(data);
    } else {
      const data = new Map<string, JsonValue>(Object.entries(this.constructor._CMS_DEFAULTS));
      data.set(key, value);
      const chunk = new Utf8Chunk({ value: json_dumps(data) });
      this._rifx.chunks.push(chunk);
      this._cms_utf8 = chunk;
    }
  }
}

// Descriptors assigned in the class body: `declare` above, installed here.
descriptor(
  Project,
  "bits_per_channel",
  ChunkField.enum(BitsPerChannel, "_nnhd", "bits_per_channel", {
    post_set: (obj: Project) => obj._sync_nhed_field("bits_per_channel"),
  }),
);

descriptor(
  Project,
  "feet_frames_film_type",
  ChunkField.enum(FeetFramesFilmType, "_nnhd", "feet_frames_film_type", {
    post_set: (obj: Project) => obj._sync_nhed_field("_display_byte"),
  }),
);

descriptor(
  Project,
  "footage_timecode_display_start_type",
  ChunkField.enum(FootageTimecodeDisplayStartType, "_nnhd", "footage_timecode_display_start_type", {
    post_set: (obj: Project) => obj._sync_nhed_field("footage_timecode_display_start_type"),
  }),
);

descriptor(
  Project,
  "_timecode_default_base",
  new ChunkField("_nnhd", "timecode_default_base", {
    // nhed holds it as a u1, so a CC 12.0 project (whose nnhd is a
    // synthetic stand-in) persists at most 255.
    validate: _validate_number({
      min: 1,
      max: (obj: Project) => (obj._nnhd.synthetic ? 255 : 999),
      integer: true,
    }),
    post_set: (obj: Project) => obj._sync_nhed_timecode_default_base(),
  }),
);

descriptor(
  Project,
  "frames_count_type",
  ChunkField.enum(FramesCountType, "_nnhd", "frames_count_type", {
    post_set: (obj: Project) => obj._sync_nhed_field("frames_count_type"),
  }),
);

descriptor(
  Project,
  "display_start_frame",
  new ChunkField("_nnhd", "display_start_frame", {
    validate: validate_one_of([0, 1]),
    post_set: (obj: Project) => obj._sync_nhed_field("frames_count_type"),
  }),
);

descriptor(
  Project,
  "frames_use_feet_frames",
  ChunkField.bool("_nnhd", "frames_use_feet_frames", {
    post_set: (obj: Project) => obj._sync_nhed_field("_feet_byte"),
  }),
);

descriptor(
  Project,
  "time_display_type",
  ChunkField.enum(TimeDisplayType, "_nnhd", "time_display_type", {
    post_set: (obj: Project) => obj._sync_nhed_field("_display_byte"),
  }),
);

descriptor(
  Project,
  "transparency_grid_thumbnails",
  ChunkField.bool("_nnhd", "transparency_grid_thumbnails", {
    post_set: (obj: Project) => obj._sync_nhed_field("transparency_grid_thumbnails"),
  }),
);

descriptor(Project, "revision", new ChunkField("_head", "file_revision", { validate: validate_u4 }));

descriptor(
  Project,
  "compensate_for_scene_referred_profiles",
  ChunkField.bool("_acer", "value", {
    transform: (v: number) => v !== 0,
    reverse: (v: boolean) => int(v),
    min_version: 16,
  }),
);

descriptor(
  Project,
  "audio_sample_rate",
  new ChunkField("_adfr", "value", {
    validate: validate_one_of([22050, 32000, 44100, 48000, 96000]),
  }),
);

descriptor(
  Project,
  "working_gamma",
  new ChunkField("_dwga", "working_gamma", {
    validate: validate_one_of([2.2, 2.4]),
    // A CC 12.0 project has no dwga to keep it in.
    min_version: 13,
  }),
);

descriptor(
  Project,
  "gpu_accel_type",
  ChunkField.enum(GpuAccelType, "_gpug_utf8", "value", {
    allow_out_of_enum_values: true,
    validate: _validate_gpu_accel_type,
    min_version: 13,
  }),
);

// The XMP packet: `ET.fromstring` / `ET.tostring` (see the TODO above).
descriptor(
  Project,
  "xmp_packet",
  new ChunkField("_aep", "_xmp", {
    transform: (s) => (py_bool(s) && strip(s) ? ET_fromstring(s) : null),
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
export function _ai_cropped_transform(
  box: [number, number, number, number],
  page_height: number,
): [[number, number], [number, number]] {
  const [x0, y0, x1, y1] = box.map((v) => round(v * 65536));
  const anchor: [number, number] = [to_f4((x1 - x0) / 131072), to_f4((y1 - y0) / 131072)];
  const position: [number, number] = [
    rshift(x0 + x1, 1) / 65536,
    page_height - rshift(y0 + y1, 1) / 65536,
  ];
  return [anchor, position];
}

/** Get the array of effect names used in the project. */
export function _get_effect_names(root_chunks: Chunk[]): string[] {
  const pefl_chunk = find_by_list_type(root_chunks, "Pefl");
  const pjef_chunks = filter_by_type(pefl_chunk.chunks, "pjef");
  return pjef_chunks.map((chunk) => chunk.value);
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
export function _stamp_style_tdb4(leaf: Property, match_name: string, timebase: number, point_aspect: number): void {
  const tdb4 = leaf._tdb4;
  if (tdb4 == null) return;
  const canon = py_or(
    _STYLE_TDB4_CANON.get(match_name),
    _STYLE_TDB4_CANON.get(match_name.slice(match_name.lastIndexOf("/") + 1)) ?? null,
  );
  if (canon == null) return;
  const [hint, hint_flag, cvot, type_flags, category, pad2a, vector, spatial] = canon;
  if (hint != null) tdb4._value_hint_type = hint;
  if (hint_flag != null) tdb4._value_hint_flag = hint_flag;
  if (cvot != null) tdb4._cvot_flags = cvot;
  if (type_flags != null) tdb4._type_flags = type_flags;
  if (category != null) tdb4._property_category = category;
  if (pad2a != null) tdb4._pad2a = pad2a;
  if (vector != null) tdb4.vector = vector;
  if (spatial) {
    // AE fills the spatial block on the 2D point leaves: marker + flags
    // 0x0F, its point epsilon, and the LAYER's display aspect
    // (source_width * PAR / source_height; 1.28 in the fixture).
    tdb4._spatial_marker = true;
    tdb4._spatial_static_flags = 0x0f;
    // The normalized-point accuracy (psd_styles_offset_phase fixture:
    // leaves and layers alike).
    tdb4._arc_accuracy = NORMALIZED_ARC_ACCURACY;
    tdb4.pixel_aspect = point_aspect;
  }
  tdb4._time_base = timebase;
}

// AE default values per Layer Styles leaf match name. Editable imports
// write a parameter leaf only when its value differs from these (AE 2026);
// the synthesis tables are the byte-verified source, and only the Layer
// Styles + Blend Options tables can carry keys the resolver emits.
export const _STYLE_SPEC_DEFAULTS = new Map<string, number | number[]>();
for (const spec_list of _LAYER_STYLE_CHILD_SPECS.values()) {
  for (const spec of spec_list) {
    if (spec.value != null) _STYLE_SPEC_DEFAULTS.set(spec.match_name, spec.value);
  }
}
for (const spec of [..._BLEND_OPTIONS_SPECS, ..._ADV_BLEND_SPECS]) {
  if (spec instanceof PropSpec && spec.value != null) _STYLE_SPEC_DEFAULTS.set(spec.match_name, spec.value);
}

/** Map of match name -\> leaf under `group`, first-in-tree-order. */
export function _style_leaf_map(group: PropertyGroup): Map<string, Property> {
  const leaves = new Map<string, Property>();
  for (const child of group.properties) {
    if (child instanceof PropertyGroup) {
      for (const [name, leaf] of _style_leaf_map(child)) {
        setdefault(leaves, name, leaf);
      }
    } else if (!leaves.has(child.match_name)) {
      leaves.set(child.match_name, child);
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
export function _serialize_import_layer_styles(layer: AVLayer, styles: PsdLayerStyles | null, source_name: string): void {
  const container = layer.property("ADBE Layer Styles");
  // AE enables the container + Blend Options chain when any style is
  // enabled OR the layer carries blend-options data (a Photoshop Fill
  // slider away from 100% enables the chain with zero styles - the
  // psd_fill_opacity fixture).
  const styled = styles != null && py_bool(styles.enabled?.length > 0 ? styles.enabled : styles.blend_options);
  const container_flags = styled ? 1 : 3;
  container._ensure_materialized();
  py_assert(container._tdsb != null);
  container._tdsb._enable_flags = container_flags;
  // The synthesis pass stamped derived `enabled` overrides while every
  // group was still synthetic-disabled; refresh them to the written state
  // (ExtendScript semantics: container/Blend Options = any style enabled).
  instance_dict(container).set("enabled", styled);
  for (const child of container.properties) {
    if (!(child instanceof PropertyGroup)) continue;
    child._ensure_materialized();
    py_assert(child._tdsb != null);
    if (child.match_name === "ADBE Blend Options Group") {
      child._tdsb._enable_flags = container_flags;
      instance_dict(child).set("enabled", styled);
      for (const sub of child.properties) {
        if (sub instanceof PropertyGroup) {
          sub._ensure_materialized();
          py_assert(sub._tdsb != null);
          // AE writes the Advanced Blending subgroup enabled on
          // EVERY import, plain skeletons included (pinned by the
          // psd_fill_opacity/psd_layer_styles/ai_comp fixtures).
          sub._tdsb._enable_flags = 1;
        }
      }
    } else {
      const prefix = child.match_name.split("/")[0];
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
      child._tdsb._enable_flags = flags;
      instance_dict(child).delete("enabled");
    }
  }
  if (styles == null) return;
  for (const prefix of styles.dropped) {
    warn(
      `${source_name}: layer ${repr(layer.name)} style ${repr(prefix)} was ` +
        "imported as disabled - After Effects drops styles with " +
        "multiple instances or unrepresentable content, and py_aep " +
        "matches its output",
    );
  }
  if (!styles.values?.size) return;
  const timebase = layer.containing_comp._cdta.internal_timebase;
  const source = layer.source;
  // Python `cast("AVItem", layer.source)`: an imported layer always has one.
  if (source == null) throw new AttributeError("'NoneType' object has no attribute 'width'");
  const point_aspect = (source.width * source.pixel_aspect) / source.height;
  const leaves = _style_leaf_map(container);
  for (const [match_name, value] of styles.values) {
    if (_values_equal(value, _STYLE_SPEC_DEFAULTS.get(match_name) ?? null)) continue;
    const leaf = leaves.get(match_name) ?? null;
    if (leaf == null) continue;
    leaf.value = value;
    if (value instanceof Gradient && leaf._tdb4 != null) {
      // AE's style gradient tdb4 is vector-typed (the NO_VALUE-seeded
      // spec builds a bare one).
      leaf._tdb4.vector = true;
    }
    _stamp_style_tdb4(leaf, match_name, timebase, point_aspect);
  }
}
