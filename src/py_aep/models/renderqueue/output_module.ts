// Port of py_aep/models/renderqueue/output_module.py

import { AudioBitDepth, AudioChannels, AudioCodec, AudioSampleRate, CineonFileFormat, ColorManagementSystem, ConvertToLinearLight, GetSettingsFormat, MPEGAudioFormat, MPEGAudioLayer, MPEGMultiplexer, OutputAudio, OutputChannels, OutputColorDepth, OutputColorMode, OutputFormat, PostRenderAction, PostRenderActionSetting, ResizeQuality, RQItemStatus, VideoCodec } from "../../enums/index.ts";
// NOTE(port): AudioCodec, VideoCodec, MPEGAudioFormat, MPEGAudioLayer and MPEGMultiplexer are
// not imported by the Python module. They are imported here because `_rules_context` and
// `validate_state` check `isinstance(value, IntEnum)` on values read from the XML format options,
// and an enum-class membership test is the only way to tell a decoded member from a raw fallback.
import { mapOutputAudio, mapOutputColorSpace, profileIdForName } from "../../enums/mappings.ts";
import { ocioColorSpaceForProfileId, ocioOutputProfileId, requireOcioConfig, resolveOcioConfig } from "../../color/ocio.ts";
import { allowedValues, constrainedKeys, type RuleValue } from "../../data/output_module_rules.ts";
import { parseFormatOptions } from "../../parsers/format_options.ts";
import { FORMAT_ID_EXTENSIONS, VIDEO_CODEC_NAMES, resolveOutputFilename, resolveTimeSpan } from "../../resolvers/output.ts";
import { platformPath } from "../../resolvers/platform_paths.ts";
import { ChunkField } from "../descriptors.ts";
import { CompItem } from "../items/composition.ts";
import { _validateNumber, validateBool, validateEnum, validateSequence, validateString } from "../validators.ts";
import { CineonFormatOptions, PngFormatOptions, XmlFormatOptions, type JpegFormatOptions, type OpenExrFormatOptions, type TargaFormatOptions, type TiffFormatOptions } from "./format_options/index.ts";
import { SettingsView, buildResizeToStrings, settingsToNumber, settingsToString, type SettingsSpec, type SettingValue, type SettingValues } from "./settings.ts";
import { LHD3_BLOCK_SINGLE, setLhd3Count } from "../../binary/ldat_chunks.ts";
import { HdrmChunk } from "../../binary/misc_chunks.ts";
import { OutputModuleSettingsItem, RoptChunk, RouuChunk, TiffRoptChunk, type RenderSettingsItem } from "../../binary/render_chunks.ts";
import { Utf8Chunk } from "../../binary/scalar_chunks.ts";
import { PENDING_ASCENDCOUNT, alasPlatform, type AlasData, buildAls2List, dumpAlas, findByType, indexByIdentity } from "../../binary/utils.ts";
import type { Chunk } from "../../binary/chunk.ts";
import type { EnumHelpers } from "../../../pyrt/enum.ts";
import type { OutputModuleTemplate } from "../../parsers/templates.ts";
import type { Project } from "../project.ts";
import type { RenderQueueItem } from "./render_queue_item.ts";
import {
  at,
  b,
  bytes_,
  descriptor,
  dictGet,
  getattr,
  getitem,
  int,
  pyAssert,
  pyBool,
  pyEq,
  pyOr,
  repr,
  round,
  rstrip,
  sorted,
  str,
  Path,
  RuntimeError,
  ValueError,
  NotImplementedError,
  jsonLoads,
  type ClassAttributes,
} from "../../../pyrt/index.ts";

// NOTE(port): Python's `isinstance(x, bool) or isinstance(x, int)` accepts bools as ints.
// `is_int` keeps that so raw bool fields still count as ints in the checks below.
export function isInt(v: RuleValue | null): v is number | boolean {
  return (typeof v === "number" && Number.isInteger(v)) || typeof v === "boolean";
}


/**
 * `isinstance(value, IntEnum)` per key: TS enum members are plain numbers, so a value counts
 * as a decoded enum member only when it belongs to the enum class that owns its key. A raw
 * out-of-enum fallback fails the membership test, as it does in Python.
 */
type KeyEnum = EnumHelpers<number> & { label?(v: number): string | null };

export const _KEY_ENUM = new Map<string, KeyEnum>([
  ["Channels", OutputChannels],
  ["Audio Channels", AudioChannels],
  ["Audio Sample Rate", AudioSampleRate],
  ["Audio Codec", AudioCodec],
  ["Video Codec", VideoCodec],
  ["Audio Format", MPEGAudioFormat],
  ["Audio Layer", MPEGAudioLayer],
  ["Multiplexer", MPEGMultiplexer],
  ["File Format", CineonFileFormat],
  ["Output Audio", OutputAudio],
  ["Depth", OutputColorDepth],
  ["Color", OutputColorMode],
  ["Audio Bit Depth", AudioBitDepth],
]);

export function _isEnumMember(key: string, value: RuleValue | null): value is RuleValue {
  return getitem(_KEY_ENUM, key).has(value);
}

/**
 * Python `getattr(v, "label", None) or getattr(v, "name", None) or str(v)`: enum members are plain
 * numbers here, so the owning enum is found through the setting `key` (`label` is an enum method
 * taking the member, `name` is `name_of`). Values that are not members of the key's enum
 * (ints, strings, bools) fall through to `str(v)`.
 */
export function _labelOrName(key: string | null, v: RuleValue): string {
  const E = key == null ? null : _KEY_ENUM.get(key);
  if (E != null && E.has(v)) {
    const label = typeof E.label === "function" ? E.label(v) : null;
    if (label) return label;
    return E.name_of(v);
  }
  return str(v);
}

/** Python `getattr(v, "name", None) or str(v)` (see `_label_or_name`). */
export function _nameOrStr(key: string | null, v: RuleValue): string {
  const E = key == null ? null : _KEY_ENUM.get(key);
  if (E != null && E.has(v)) return E.name_of(v);
  return str(v);
}

// NOTE(port): `{value!r}` of an IntEnum member is `<Cls.NAME: n>` in Python but a raw int stays
// `n`; both are the same number here, so a member of the key's enum always reprs as a member.
export function _valueRepr(key: string, v: RuleValue): string {
  const E = _KEY_ENUM.get(key);
  if (E != null && E.has(v)) return `<${E.__name__}.${E.name_of(v)}: ${v}>`;
  return repr(v);
}

/** Factory for crop validators that check range and final dimension. */
export function _validateCrop(peerField: string, dimension: string): (value: number, obj: OutputModule) => void {
  const rangeCheck = _validateNumber({ min: -30000, max: 30000, integer: true });

  return (value: number, obj: OutputModule): void => {
    rangeCheck(value, obj);
    const peer: number = getattr(obj, peerField);
    const parentRqi = obj._parent_rqi;
    const compDim: number = getattr(parentRqi.comp, dimension);
    const resAttr = dimension === "width" ? "resolution_x" : "resolution_y";
    const divisor = pyOr(getattr(parentRqi._ldat, resAttr), 1);
    const dim = Math.ceil(compDim / divisor);
    const remaining = dim - value - peer;
    if (remaining < 1) {
      throw new ValueError(`Crop would reduce ${dimension} to ${remaining}px (must be >= 1)`);
    }
  };
}

// Depth pairs: no-alpha <-> alpha
export const _DEPTH_PLUS = new Map<number, number>([
  [24, 32],
  [48, 64],
  [96, 128],
]);
export const _DEPTH_MINUS = new Map<number, number>([
  [32, 24],
  [64, 48],
  [128, 96],
]);

// Audio sample encoding (1=unsigned PCM, 2=signed PCM, 3=float) AE stores
// for each bytes-per-sample while the audio format has no channel count yet.
export const _AUDIO_ENCODINGS = new Map<number, number>([
  [1, 1],
  [2, 2],
  [4, 3],
]);

/**
 * After Effects has no 24-bit audio output: AE 2026 crashes when a
 * script sets it and reads a stored 24-bit format back as 16 Bit.
 */
export function _reject24BitAudio(value: RuleValue, obj: OutputModule): void {
  if (value === AudioBitDepth.TWENTY_FOUR_BIT) {
    throw new ValueError(
      "Audio Bit Depth 24 Bit is not available: After Effects has no " +
        "24-bit audio output. Use 8, 16 or 32 Bit.",
    );
  }
}

/**
 * Factory for validators gating a setting on the module's format
 * rules (see `OutputModule._check_format_rule`).
 *
 * `pre` is an optional validator run first (e.g. enum membership for
 * fields whose forgiving read transform hides the enum class from
 * `ChunkField`).
 */
export function _validateForFormat(
  key: string,
  pre: ((value: RuleValue, obj: OutputModule) => void) | null = null,
): (value: RuleValue, obj: OutputModule) => void {
  return (value: RuleValue, obj: OutputModule): void => {
    if (pre != null) pre(value, obj);
    obj._check_format_rule(key, value);
  };
}

// -- Clamp helpers for format-option-backed keys ----------------------------
// Reading/writing through the module keeps _CLAMP_ACCESSORS free of
// isinstance lambdas; every writer is a raw write (validation bypass).

export function _xmlOptionsOf<K extends "audioBitrate" | "audioCodec" | "bitrate" | "mpegAudioFormat" | "mpegMultiplexer" | "videoCodec">(
  om: OutputModule,
  attr: K,
): XmlFormatOptions[K] | null {
  const fo = om._format_options;
  if (fo instanceof XmlFormatOptions) {
    return getattr(fo, attr);
  }
  return null;
}

export function _setXmlParamRaw(om: OutputModule, paramKey: string, value: number): void {
  const fo = om._format_options;
  if (fo instanceof XmlFormatOptions) {
    fo._set_param(paramKey, str(value));
  }
}

/** The value each output module setting reads as: its {@link OutputModule} attribute's type. */
export type OutputModuleSettingValues = SettingValues & {
  "Audio Bit Depth": OutputModule["_audio_bit_depth"];
  "Audio Channels": OutputModule["_audio_channels"];
  "Audio Sample Rate": OutputModule["_audio_sample_rate"];
  "Channels": OutputModule["_channels"];
  "Color": OutputModule["_color_mode"];
  "Convert to Linear Light": OutputModule["_convert_to_linear_light"];
  "Crop Bottom": OutputModule["_crop_bottom"];
  "Crop Left": OutputModule["_crop_left"];
  "Crop Right": OutputModule["_crop_right"];
  "Crop Top": OutputModule["_crop_top"];
  "Crop": OutputModule["_crop"];
  "Depth": OutputModule["_depth"];
  "Format": OutputModule["_format"];
  "Include Project Link": OutputModule["_include_project_link"];
  "Include Source XMP Metadata": OutputModule["includeSourceXmp"];
  "Lock Aspect Ratio": OutputModule["_lock_aspect_ratio"];
  "Output Audio": OutputModule["_output_audio"];
  "Output File Info": OutputModule["_output_file_info"];
  "Post-Render Action": OutputModule["_post_render_action_setting"];
  "Preserve RGB": OutputModule["_preserve_rgb"];
  "Resize Quality": OutputModule["_resize_quality"];
  "Resize to": OutputModule["_resize_to"];
  "Resize": OutputModule["_resize"];
  "Starting #": OutputModule["_starting_number"];
  "Use Comp Frame Number": OutputModule["_use_comp_frame_number"];
  "Use Region of Interest": OutputModule["_use_region_of_interest"];
  "Video Output": OutputModule["_video_output"];
};

// ---------------------------------------------------------------------------
// OM_SETTINGS: ExtendScript key -> (attribute, optional enum class)
// ---------------------------------------------------------------------------

export const OM_SETTINGS: SettingsSpec = new Map([
  ["Audio Bit Depth", ["_audio_bit_depth", AudioBitDepth]],
  ["Audio Channels", ["_audio_channels", AudioChannels]],
  ["Audio Sample Rate", ["_audio_sample_rate", AudioSampleRate]],
  ["Channels", ["_channels", OutputChannels]],
  ["Color", ["_color_mode", OutputColorMode]],
  ["Convert to Linear Light", ["_convert_to_linear_light", ConvertToLinearLight]],
  ["Crop Bottom", ["_crop_bottom", null]],
  ["Crop Left", ["_crop_left", null]],
  ["Crop Right", ["_crop_right", null]],
  ["Crop Top", ["_crop_top", null]],
  ["Crop", ["_crop", null]],
  ["Depth", ["_depth", OutputColorDepth]],
  ["Format", ["_format", OutputFormat]],
  ["Include Project Link", ["_include_project_link", null]],
  ["Include Source XMP Metadata", ["includeSourceXmp", null]],
  ["Lock Aspect Ratio", ["_lock_aspect_ratio", null]],
  ["Output Audio", ["_output_audio", OutputAudio]],
  ["Output File Info", ["_output_file_info", null]],
  ["Post-Render Action", ["_post_render_action_setting", PostRenderActionSetting]],
  ["Preserve RGB", ["_preserve_rgb", null]],
  ["Resize Quality", ["_resize_quality", ResizeQuality]],
  ["Resize to", ["_resize_to", null]],
  ["Resize", ["_resize", null]],
  ["Starting #", ["_starting_number", null]],
  ["Use Comp Frame Number", ["_use_comp_frame_number", null]],
  ["Use Region of Interest", ["_use_region_of_interest", null]],
  ["Video Output", ["_video_output", null]],
]);

/**
 * An `OutputModule` object of a {@link RenderQueueItem} generates a single file or
 * sequence via a render operation, and contains attributes and methods
 * relating to the file to be rendered.
 *
 * @example
 * ```ts
 * import { parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const om = app.project.renderQueue.items[0].outputModules[0];
 * console.log(om.file);
 * ```
 * @see https://ae-scripting.docsforadobe.dev/renderqueue/outputmodule/
 */
export class OutputModule {
  declare ["constructor"]: ClassAttributes<typeof OutputModule>;
  /**
   * When `true`, writes all source footage XMP metadata to the output file.
   * Read / Write.
   */
  declare includeSourceXmp: boolean;

  /**
   * An action to perform when rendering is complete.
   * Read / Write.
   */
  declare postRenderAction: PostRenderAction;

  declare _audio_bit_depth: AudioBitDepth;
  declare _audio_channels: AudioChannels;
  declare _audio_sample_rate: AudioSampleRate;
  declare _channels: OutputChannels;
  declare _color_mode: OutputColorMode;
  declare _convert_to_linear_light: ConvertToLinearLight;
  declare _crop: boolean;
  declare _crop_bottom: number;
  declare _crop_left: number;
  declare _crop_right: number;
  declare _crop_top: number;

  // Forgiving read transforms: a file can hold an out-of-enum depth (AE
  // 2026 loads a stored -16 and reports it with an empty label) or an
  // unknown format id (third-party output plugins); reads fall back to
  // the raw value, writes stay strict via validate_enum.
  declare _depth: OutputColorDepth;

  /** Read-only for now as a lot of things must be updated when changing format */
  declare _format: OutputFormat;

  declare _include_project_link: boolean;
  declare _lock_aspect_ratio: boolean;
  declare _post_render_action_setting: PostRenderActionSetting;
  declare _preserve_rgb: boolean;
  declare _resize: boolean;
  declare _resize_quality: ResizeQuality;
  declare _use_comp_frame_number: boolean;
  declare _use_region_of_interest: boolean;

  declare _om_ldat: OutputModuleSettingsItem;
  declare _roou: RouuChunk;
  declare _alas_utf8: Utf8Chunk | null;
  declare _file_name_utf8: Utf8Chunk | null;
  declare _name_utf8: Utf8Chunk | null;
  declare _render_settings_ldat: RenderSettingsItem;
  declare _parent_rqi: RenderQueueItem;
  declare _format_options: CineonFormatOptions | JpegFormatOptions | OpenExrFormatOptions | PngFormatOptions | TargaFormatOptions | TiffFormatOptions | XmlFormatOptions | null;
  declare _batch_depth: number;

  /** Bypass accessors used by `_apply_singleton_clamps`: clamps write the
   * chunk field / raw param directly (never through the descriptor) so a
   * clamp can never recurse into validation. Table invariants in
   * tests/unit/test_output_module_rules.py prove clamped values are
   * always inside the format's own allowed sets. */
  static _CLAMP_ACCESSORS = new Map<string, [(om: OutputModule) => RuleValue | null, (om: OutputModule, v: RuleValue) => void]>([
    [
      "Color",
      [
        (om) => om._color_mode,
        (om, v) => {
          om._roou.color_premultiplied = int(v);
        },
      ],
    ],
    [
      "Depth",
      [
        (om) => om._depth,
        (om, v) => {
          om._roou.depth = int(v);
        },
      ],
    ],
    [
      "Audio Sample Rate",
      [
        (om) => om._audio_sample_rate,
        (om, v) => {
          om._roou.audio_sample_rate = AudioSampleRate.to_binary(v as number);
        },
      ],
    ],
    [
      "Audio Channels",
      [
        (om) => om._audio_channels,
        (om, v) => {
          om._write_audio_format_raw("audio_channels", int(v));
        },
      ],
    ],
    [
      "Audio Bit Depth",
      [
        (om) => om._audio_bit_depth,
        (om, v) => {
          om._write_audio_format_raw("audio_bit_depth", int(v));
        },
      ],
    ],
    [
      "Audio Format",
      [
        (om) => _xmlOptionsOf(om, "mpegAudioFormat"),
        (om, v) => {
          _setXmlParamRaw(om, "ADBEMPEGAudioFormat", int(v));
        },
      ],
    ],
  ]);

  /**
   * Current-value getters for whole-state validation. Enum-backed OM
   * reads can raise on out-of-enum stored bytes; `validate_state`
   * treats that (and raw fallbacks) as "unclean context -\> skip". 
   */
  static _STATE_GETTERS = new Map<string, (om: OutputModule) => RuleValue | null>([
    ["Video Output", (om) => om._video_output],
    ["Output Audio", (om) => om._output_audio],
    ["Channels", (om) => om._channels],
    ["Depth", (om) => om._depth],
    ["Color", (om) => om._color_mode],
    ["Audio Sample Rate", (om) => om._audio_sample_rate],
    ["Audio Channels", (om) => om._audio_channels],
    ["Audio Bit Depth", (om) => om._audio_bit_depth],
    ["Audio Codec", (om) => _xmlOptionsOf(om, "audioCodec")],
    ["Video Codec", (om) => _xmlOptionsOf(om, "videoCodec")],
    ["Audio Format", (om) => _xmlOptionsOf(om, "mpegAudioFormat")],
    ["Multiplexer", (om) => _xmlOptionsOf(om, "mpegMultiplexer")],
    ["BitRate", (om) => _xmlOptionsOf(om, "bitrate")],
    ["Audio Bitrate", (om) => _xmlOptionsOf(om, "audioBitrate")],
  ]);

  /** Keys whose stored value is a plain int/bool by design (everything
   * else must decode to an enum member to be checked). */
  static _RAW_VALUE_KEYS: ReadonlySet<string> = new Set(["Video Output", "BitRate", "Audio Bitrate"]);

  /** Keys inert while the corresponding output stream is disabled: AE
   * leaves stale bytes there and so do we. */
  static _AUDIO_STATE_KEYS: ReadonlySet<string> = new Set([
    "Audio Sample Rate",
    "Audio Channels",
    "Audio Bit Depth",
    "Audio Bitrate",
    "BitRate",
  ]);
  static _VIDEO_STATE_KEYS: ReadonlySet<string> = new Set(["Channels", "Depth", "Color", "Video Codec"]);

  constructor(kw: {
    _om_ldat: OutputModuleSettingsItem;
    _roou: RouuChunk;
    _alas_utf8: Utf8Chunk | null;
    _file_name_utf8: Utf8Chunk | null;
    _name_utf8: Utf8Chunk | null;
    _render_settings_ldat: RenderSettingsItem;
    parent: RenderQueueItem;
    format_options: OutputModule["_format_options"];
  }) {
    const { _om_ldat, _roou, _alas_utf8, _file_name_utf8, _name_utf8, _render_settings_ldat, parent, format_options } = kw;
    this._om_ldat = _om_ldat;
    this._roou = _roou;
    this._alas_utf8 = _alas_utf8;
    this._file_name_utf8 = _file_name_utf8;
    this._name_utf8 = _name_utf8;
    this._render_settings_ldat = _render_settings_ldat;
    this._parent_rqi = parent;
    this._format_options = format_options;
    // Format options validate their writes against this module's
    // format rules; the back-reference is (re)assigned here and in
    // _apply_output_template - the only two places an OM gains a
    // format-options object.
    if (format_options != null) {
      format_options._parent_om = this;
    }
    // Non-zero while inside batch_edit(): per-write format rules and
    // clamps are deferred to the batch exit.
    this._batch_depth = 0;
  }

  /**
   * Create a new output module: a fresh TIFF image sequence.
   *
   * Builds the chunks After Effects writes for a freshly added output
   * module - a simple image sequence with an empty `Ropt` and no output
   * file set yet (so no `Als2` alias and an empty file name). This needs
   * no preferences. Codec-based formats (H.264/AVI) are not reproduced
   * because their format options are not available without an open AE.
   *
   * @param kw - Keyword arguments:
   * - `render_settings_ldat`: The render settings item for the parent render queue item (used for
   *     dimension resolution).
   * - `parent`: The parent RenderQueueItem.
   * @returns A tuple of (OutputModule model, list of chunks for LIST:LOm).
   */
  static _new(kw: { render_settings_ldat: RenderSettingsItem; parent: RenderQueueItem }): [OutputModule, Chunk[]] {
    const { render_settings_ldat, parent } = kw;
    const omLdatItem = new OutputModuleSettingsItem();
    const roou = new RouuChunk(); // defaults reproduce AE's fresh image-sequence Rouu
    const ropt = new TiffRoptChunk(); // AE's exact 602-byte TIFF format options
    const hdrm = new HdrmChunk();
    const hdrJson = new Utf8Chunk({ value: "{}" });
    const nameUtf8 = new Utf8Chunk({ value: "TIFF Sequence with Alpha" });
    // A freshly added module has no output file: AE leaves the file name
    // empty and writes no Als2 alias (it is created when a path is set).
    const fileNameUtf8 = new Utf8Chunk();

    const lomChunks: Chunk[] = [roou, ropt, hdrm, hdrJson, nameUtf8, fileNameUtf8];

    const om = new this({
      _om_ldat: omLdatItem,
      _roou: roou,
      _alas_utf8: null,
      _file_name_utf8: fileNameUtf8,
      _name_utf8: nameUtf8,
      _render_settings_ldat: render_settings_ldat,
      parent,
      format_options: null,
    });
    // Resolve the output rate and dimensions; a module added next to
    // others keeps the item's skip frames.
    om._finalize_roou();

    return [om, lomChunks];
  }

  /**
   * Format-specific render options for this output module. The concrete
   * type depends on the output format:
   *
   * - {@link CineonFormatOptions} for Cineon/DPX sequences
   * - {@link JpegFormatOptions} for JPEG sequences
   * - {@link OpenExrFormatOptions} for OpenEXR sequences
   * - {@link PngFormatOptions} for PNG sequences
   * - {@link TargaFormatOptions} for Targa sequences
   * - {@link TiffFormatOptions} for TIFF sequences
   * - {@link XmlFormatOptions} for XML-based formats (AVI, H.264, MP3,
   *   QuickTime, WAV)
   * - `null` for formats without parsed format options
   *
   * Read-only.
   */
  get formatOptions(): CineonFormatOptions | JpegFormatOptions | OpenExrFormatOptions | PngFormatOptions | TargaFormatOptions | TiffFormatOptions | XmlFormatOptions | null {
    return this._format_options;
  }

  /**
   * The name of the output module, as shown in the user interface.
   * Read-only.
   */
  get name(): string {
    if (this._name_utf8 == null) {
      return "";
    }
    return this._name_utf8.value;
  }

  /**
   * Reference to parent RenderQueueItem, used for resolving file paths
   * and accessing comp and render settings. Read-only.
   */
  get parent(): RenderQueueItem {
    return this._parent_rqi;
  }

  /**
   * The {@link CompItem} to use for post-render actions that require a comp.
   * Only used when `post_render_action` is `IMPORT_AND_REPLACE` or
   * `SET_PROXY`. Read-only.
   */
  get postRenderTargetComp(): CompItem {
    const compId = this._om_ldat.post_render_target_comp_id || null;
    if (compId == null || this.postRenderAction === PostRenderAction.NONE || this.postRenderAction === PostRenderAction.IMPORT) {
      return this._parent_rqi.comp;
    }
    return getitem(this._project.items, compId) as CompItem;
  }

  set postRenderTargetComp(comp: CompItem) {
    if (!(comp instanceof CompItem)) {
      throw new ValueError("postRenderTargetComp must be a CompItem");
    }
    if (!this._project.items.has(comp.id)) {
      throw new ValueError("postRenderTargetComp must be an item in the project");
    }
    this._om_ldat.post_render_target_comp_id = comp.id;
  }

  /**
   * {@link SettingsView} dict with
   * ExtendScript-compatible keys. Includes `"Video Output"`,
   * `"Audio Bit Depth"`, `"Preserve RGB"`, `"Convert to Linear Light"`,
   * etc. Matches the format from
   * `OutputModule.getSettings(GetSettingsFormat.NUMBER)`.
   */
  get settings(): SettingsView<OutputModuleSettingValues> {
    return new SettingsView(this, OM_SETTINGS);
  }

  set settings(value: Map<string, SettingValue> | SettingsView) {
    if (!(value instanceof Map || value instanceof SettingsView)) {
      throw new ValueError("Settings must be a dictionary of key-value pairs");
    }
    const view = this.settings;
    // One transaction: the keys of a settings dict are coupled, so they
    // must apply in any order, and a key that raises has to roll the
    // whole dict back - an earlier key's `post_set` clamp may already
    // have moved its dependents, leaving neither the old state nor the
    // requested one.
    this.batchEdit(() => {
      for (const [k, v] of value instanceof Map ? [...value] : value.items()) {
        // A full `settings` dict includes read-only keys (e.g.
        // "Format", "Channels"); skip any key whose value is
        // unchanged so a round-tripped dict applies cleanly, while a
        // real write to a read-only key still raises. An unknown key
        // short-circuits to `__setitem__`, which names the valid keys
        // (reading it here would raise a bare KeyError).
        if (OM_SETTINGS.has(k) && pyEq(view.get(k), v)) {
          continue;
        }
        view.set(k, v);
      }
    });
  }

  get _video_output(): boolean {
    return this._roou.width > 0 || this._roou.height > 0;
  }

  set _video_output(value: boolean) {
    validateBool(value);
    // Format gate is necessary: turning video on for an audio
    // format would write comp dimensions into an audio-only Rouu.
    _validateForFormat("Video Output")(value, this);
    if (value) {
      const [w, h] = this._effective_dimensions;
      this._roou.width = w;
      this._roou.height = h;
    } else {
      this._roou.width = 0;
      this._roou.height = 0;
    }
  }

  /** Output audio setting (the On and Auto flags of the settings). */
  get _output_audio(): OutputAudio {
    const ldat = this._om_ldat;
    return mapOutputAudio(ldat.output_audio !== 0, ldat.output_audio_auto !== 0);
  }

  set _output_audio(value: OutputAudio) {
    _validateForFormat("Output Audio")(value, this);
    if (value === OutputAudio.OFF) {
      // AE keeps the Auto flag when audio is switched off.
      this._om_ldat.output_audio = 0;
    } else if (value === OutputAudio.AUTO) {
      this._om_ldat.output_audio = 1;
      this._om_ldat.output_audio_auto = 1;
    } else if (value === OutputAudio.ON) {
      this._om_ldat.output_audio = 1;
      this._om_ldat.output_audio_auto = 0;
    } else {
      throw new ValueError(
        `Unsupported OutputAudio value: ${str(value)}. Expected ` + "OutputAudio.OFF, OutputAudio.AUTO, or OutputAudio.ON.",
      );
    }
  }

  /**
   * Current setting values used to match conditional rules.
   *
   * Only cleanly-decoded values enter the context: a raw fallback
   * (an out-of-enum byte or param from a real file), an absent
   * format-option param, or a missing format-options object leaves
   * its key absent, so the rules that condition on it simply do not
   * apply (permissive degradation).
   */
  _rules_context(): Map<string, RuleValue> {
    const context = new Map<string, RuleValue>();
    for (const key of ["Channels", "Audio Channels", "Audio Sample Rate"]) {
      let value: number;
      try {
        value = getattr(this, getitem(OM_SETTINGS, key)[0]);
      } catch (e) {
        // Enum transform without a from_binary fallback (e.g.
        // OutputChannels) raises on an out-of-enum stored byte.
        if (!(e instanceof ValueError)) throw e;
        continue;
      }
      if (_isEnumMember(key, value)) {
        context.set(key, value);
      }
    }
    const fo = this._format_options;
    if (fo instanceof XmlFormatOptions) {
      const pairs: [string, RuleValue | null][] = [
        ["Audio Codec", fo.audioCodec],
        ["Video Codec", fo.videoCodec],
        ["Audio Format", fo.mpegAudioFormat],
        ["Audio Layer", fo.mpegAudioLayer],
        ["Multiplexer", fo.mpegMultiplexer],
      ];
      for (const [key, value] of pairs) {
        if (_isEnumMember(key, value)) {
          context.set(key, value);
        }
      }
      if (isInt(fo.bitrate)) {
        context.set("BitRate", fo.bitrate);
      }
    } else if (fo instanceof CineonFormatOptions) {
      if (_isEnumMember("File Format", fo.fileFormat)) {
        context.set("File Format", fo.fileFormat);
      }
    }
    return context;
  }

  /**
   * Raise if `value` violates `allowed_values(format, key)` right now
   * (write-time semantics: the other fields are read as they are now).
   *
   * Batch mode defers to the batch_edit exit validation. Unknown format
   * ids - third-party output plugins whose 4cc is not in `OutputFormat` -
   * skip the check entirely.
   */
  _check_format_rule(key: string, value: RuleValue): void {
    if (this._batch_depth) {
      return;
    }
    const fmt = this._format;
    if (!OutputFormat.has(fmt)) {
      return;
    }
    const allowed = allowedValues(fmt, key, this._rules_context());
    if (allowed == null || allowed.has(value)) {
      return;
    }
    // `label` (output-module enums) > `name` (plain IntEnums, which
    // str() to their bare value on 3.11+) > str (ints, strings).
    const labels = sorted(allowed, (v) => [typeof v === "string", v])
      .map((v) => _labelOrName(key, v))
      .join(", ");
    throw new ValueError(
      `${key} ${_valueRepr(key, value)} is not available for format ${repr(OutputFormat.label(fmt))}. ` + `Allowed: ${labels}`,
    );
  }

  /**
   * Force dependent settings whose allowed set became a singleton.
   *
   * Mirrors AE's dialog re-resolving dependent dropdowns after a
   * context change (codec, bitrate, channels). Only fires when the
   * rules leave exactly one legal value; multi-valued sets are left
   * alone (the stored value may be stale until the user writes it,
   * per the write-time validation contract). The context is rebuilt
   * per key so an earlier clamp (e.g. GSM forcing mono) feeds the
   * later ones.
   */
  _apply_singleton_clamps(keys: readonly string[]): void {
    if (this._batch_depth) {
      return; // deferred to the batch_edit exit validation
    }
    const fmt = this._format;
    if (!OutputFormat.has(fmt)) {
      return;
    }
    for (const key of keys) {
      const allowed = allowedValues(fmt, key, this._rules_context());
      if (allowed == null || allowed.size !== 1) {
        continue;
      }
      const forced = [...allowed][0];
      const [getter, setter] = getitem(this.constructor._CLAMP_ACCESSORS, key);
      let current: RuleValue | null;
      try {
        current = getter(this);
      } catch (e) {
        if (!(e instanceof ValueError)) throw e;
        continue; // out-of-enum stored byte: leave it alone
      }
      if (current !== forced) {
        setter(this, forced);
      }
    }
  }

  /**
   * Check every rule-covered setting against the current context.
   *
   * Returns a list of `(key, value, allowed)` violations (empty when
   * the state is consistent). Used by `batch_edit` on exit and by the
   * corpus self-validation test; also useful to lint a parsed file.
   *
   * Stale-by-design values are skipped: settings of a disabled
   * audio/video stream, absent format-option params, and raw
   * fallbacks from out-of-enum stored bytes (the binary is trusted).
   */
  validateState(): [string, RuleValue, ReadonlySet<RuleValue>][] {
    const cls = this.constructor;
    const violations: [string, RuleValue, ReadonlySet<RuleValue>][] = [];
    const fmt = this._format;
    if (!OutputFormat.has(fmt)) {
      return violations;
    }
    const context = this._rules_context();
    const audioOn = this._output_audio !== OutputAudio.OFF;
    const videoOn = this._video_output;
    for (const key of sorted(constrainedKeys(fmt))) {
      if (!audioOn && cls._AUDIO_STATE_KEYS.has(key)) {
        continue;
      }
      if (!videoOn && cls._VIDEO_STATE_KEYS.has(key)) {
        continue;
      }
      const allowed = allowedValues(fmt, key, context);
      if (allowed == null) {
        continue;
      }
      let value: RuleValue | null;
      try {
        value = getitem(cls._STATE_GETTERS, key)(this);
      } catch (e) {
        if (!(e instanceof ValueError)) throw e;
        continue; // out-of-enum stored byte: unclean, skip
      }
      if (value == null) {
        continue;
      }
      if (cls._RAW_VALUE_KEYS.has(key)) {
        if (!isInt(value)) {
          continue; // raw string fallback (garbage param): skip
        }
      } else if (!_isEnumMember(key, value)) {
        continue; // raw fallback: unclean, skip
      }
      if (key === "Audio Sample Rate" && value === AudioSampleRate.OFF) {
        // from_binary maps any unknown stored rate to OFF, so OFF
        // under enabled audio is an unclean legacy value, not a
        // user choice (OFF is never in an allowed set).
        continue;
      }
      if (!allowed.has(value)) {
        violations.push([key, value, allowed]);
      }
    }
    return violations;
  }

  /** Capture the batch rollback state (settings + format header/options). */
  _snapshot_state(): [Uint8Array, Uint8Array, Uint8Array | null, string | null, boolean] {
    const lomChunks = this._parent_rqi._lom.chunks;
    let start: number;
    let end: number;
    try {
      [start, end] = this._block_span(lomChunks);
    } catch (e) {
      // _block_span locates this module's Roou by identity; it is
      // gone exactly when the module was removed.
      if (!(e instanceof ValueError)) throw e;
      throw new RuntimeError("This output module was removed from its render queue item; it can no longer be edited.");
    }
    let roptBytes: Uint8Array | null = null;
    for (let i = start; i < end; i++) {
      if (lomChunks[i].chunk_type === "Ropt") {
        roptBytes = lomChunks[i].tobytes();
        break;
      }
    }
    let hdr10Value: string | null = null;
    const fo = this._format_options;
    if (fo instanceof PngFormatOptions && fo._hdr10_utf8 != null) {
      hdr10Value = fo._hdr10_utf8.value;
    }
    return [this._om_ldat.tobytes(), this._roou.tobytes(), roptBytes, hdr10Value, fo != null];
  }

  /** Roll the module back to a `_snapshot_state` capture. */
  _restore_state(snapshot: [Uint8Array, Uint8Array, Uint8Array | null, string | null, boolean]): void {
    const [ldatBytes, roouBytes, roptBytes, hdr10Value, hadOptions] = snapshot;
    // In-place field copy keeps the item's identity in the ldat list.
    const restoredItem = OutputModuleSettingsItem.frombytes(ldatBytes);
    pyAssert(restoredItem instanceof OutputModuleSettingsItem);
    this._om_ldat.restore_from(restoredItem);
    const lomChunks = this._parent_rqi._lom.chunks;
    const [start, end] = this._block_span(lomChunks);
    const newRoou = RouuChunk.frombytes(roouBytes, { chunk_type: "Roou" });
    pyAssert(newRoou instanceof RouuChunk);
    lomChunks[start] = newRoou;
    this._roou = newRoou;
    if (roptBytes != null) {
      for (let i = start; i < end; i++) {
        if (lomChunks[i].chunk_type === "Ropt") {
          lomChunks[i] = RoptChunk.frombytes(roptBytes, { chunk_type: "Ropt" });
          break;
        }
      }
    }
    // Restore the PNG HDR10 sidecar before re-deriving the wrapper
    // (the wrapper caches the parsed JSON).
    const fo = this._format_options;
    if (hdr10Value != null && fo instanceof PngFormatOptions && fo._hdr10_utf8 != null) {
      fo._hdr10_utf8.value = hdr10Value;
    }
    // Detach the outgoing wrapper. A reference the caller fetched
    // before the rollback wraps an Ropt that is no longer in the tree,
    // so its writes must hit the "detached" guard rather than land in
    // an orphaned body and be silently dropped from the saved file.
    if (fo != null) {
      fo._detached = true;
    }
    // A module built without a format-options wrapper (_new) must
    // come out of a rollback the same way.
    if (hadOptions) {
      this._format_options = parseFormatOptions(lomChunks.slice(start, end));
      if (this._format_options != null) {
        this._format_options._parent_om = this;
      }
    } else {
      this._format_options = null;
    }
  }

  /**
   * Edit several coupled settings as one transaction.
   *
   * Inside the block, per-write format validation and clamps are
   * deferred, so coupled settings can be written in any order. On
   * exit the final state is validated as a whole: any violation (or
   * an exception in the block) rolls the module back to its state at
   * entry and raises a single `ValueError` listing every violation.
   *
   * Covers the output-module settings, the format header (`Rouu`)
   * and the format options (`Ropt` + PNG HDR10 sidecar). File path
   * and module name writes are not rolled back. References held to
   * `format_options` across a failed batch are stale - re-fetch.
   * Nested batches are reentrant; the outermost one validates.
   *
   * @example
   * ```ts
   * import { parse, AudioChannels } from "@bevyl-ai/ts-aep";
   *
   * const om = parse("project.aep").project.renderQueue.items[0].outputModules[0];
   * om.batchEdit(() => {
   *   om.settings.set("Audio Channels", AudioChannels.MONO);
   *   om.settings.set("Audio Sample Rate", 22050);
   * });
   * ```
   */
  // NOTE(port): Python's `@contextmanager` + `with` has no TS equivalent; the block is passed
  // as `body`, which runs inside the same transaction as the `with` body would.
  batchEdit(body: (om: OutputModule) => void): OutputModule {
    if (this._batch_depth) {
      this._batch_depth += 1;
      try {
        body(this);
      } finally {
        this._batch_depth -= 1;
      }
      return this;
    }
    const snapshot = this._snapshot_state();
    const oldChannels = this._om_ldat.channels;
    this._batch_depth = 1;
    try {
      body(this);
    } catch (e) {
      this._restore_state(snapshot);
      throw e;
    } finally {
      this._batch_depth = 0;
    }
    // A channels change re-resolves exactly once, at exit (AE
    // re-resolves when the dropdown changes) - the same work
    // `_sync_after_channels` does for a bare write, which defers to
    // here. Both halves must run: clamping Color only on the bare path
    // would make a batch REJECT a write that succeeds outside one. A
    // batch that never changed channels keeps explicit Depth writes
    // as-is; the parity rules then decide whether the pair is legal.
    if (this._om_ldat.channels !== oldChannels) {
      this._pair_depth_to_channels();
      this._apply_singleton_clamps(["Color"]);
    }
    this._sync_png_options();
    const violations = this.validateState();
    if (violations.length) {
      this._restore_state(snapshot);

      const details = violations
        .map(
          ([key, value, allowed]) =>
            `${key}: ${_nameOrStr(key, value)} not in ` + `{${sorted([...allowed].map((v) => _nameOrStr(key, v))).join(", ")}}`,
        )
        .join("; ");
      throw new ValueError(`batchEdit rolled back, invalid final state: ${details}`);
    }
    return this;
  }

  /** Re-pair the depth to the alpha choice (RGBA \<-\> `+` depths). */
  _pair_depth_to_channels(): void {
    const depthVal = int(this._depth);
    const isRgba = this._om_ldat.channels === int(OutputChannels.RGBA);
    const target = isRgba ? _DEPTH_PLUS : _DEPTH_MINUS;
    const paired = target.get(depthVal);
    if (paired !== undefined) {
      this._roou.depth = paired;
    }
  }

  /**
   * Re-resolve depth and color after a `_channels` write.
   *
   * Depth keeps its alpha pairing (RGBA \<-\> `+` depth variants); the
   * Color mode is clamped when the new channels leave a single legal
   * value (EXR forces premultiplied, PNG forces straight - only
   * meaningful when alpha is included). Inside a batch the whole
   * re-resolution is deferred to the exit (an in-batch pairing flip
   * would make the batch outcome order-dependent).
   */
  _sync_after_channels(): void {
    if (this._batch_depth) {
      return;
    }
    this._pair_depth_to_channels();
    this._apply_singleton_clamps(["Color"]);
    this._sync_png_options();
  }

  /**
   * Keep the PNG options' alpha flag, channel count and bits per
   * channel in step with the module's Channels / Depth, as AE stores them
   * (format_options/png samples). AE 2026 renders the module's choice
   * either way. An Alpha-only module is left alone (no AE sample).
   */
  _sync_png_options(): void {
    const fo = this._format_options;
    if (!(fo instanceof PngFormatOptions)) {
      return;
    }
    const channels = this._om_ldat.channels;
    const body = fo._body;
    if ([int(OutputChannels.RGB), int(OutputChannels.RGBA)].includes(channels)) {
      body.has_alpha = channels === int(OutputChannels.RGBA);
      body.channel_count = body.has_alpha ? 4 : 3;
    }
    const depth = this._roou.depth;
    if ([24, 32].includes(depth)) {
      body.bit_depth = 8;
    } else if ([48, 64].includes(depth)) {
      body.bit_depth = 16;
    }
  }

  /** Re-resolve audio settings after an `_audio_channels` write. */
  _clamp_audio_dependents(): void {
    this._sync_audio_format();
    this._apply_singleton_clamps(["Audio Sample Rate", "Audio Bit Depth"]);
  }

  /**
   * Fill in the `Rouu` audio-format fields AE derives from the others.
   *
   * Measured on AE 2026: the format is complete once it has a channel
   * count; setting one fills an unset sample rate (48 kHz) and sample
   * size (16 Bit), and the encoding then follows the size (float for
   * 32 Bit, signed PCM otherwise). Without a channel count, writing a
   * bit depth stores its encoding alone (8 Bit -\> unsigned PCM).
   */
  _sync_audio_format(): void {
    const roou = this._roou;
    if (roou.audio_channels) {
      if (roou.audio_sample_rate === -1.0) {
        roou.audio_sample_rate = 48000.0;
      }
      if (!_AUDIO_ENCODINGS.has(roou.audio_bit_depth)) {
        roou.audio_bit_depth = int(AudioBitDepth.SIXTEEN_BIT);
      }
      roou.audio_encoding = roou.audio_bit_depth === 4 ? 3 : 2;
    } else {
      const encoding = _AUDIO_ENCODINGS.get(roou.audio_bit_depth);
      if (encoding !== undefined) {
        roou.audio_encoding = encoding;
      }
    }
  }

  /** Clamp writer for a `Rouu` audio-format field (no validation). */
  _write_audio_format_raw(field: "audio_channels" | "audio_bit_depth", value: number): void {
    this._roou[field] = value;
    this._sync_audio_format();
  }

  /**
   * Effective render dimensions after resolution, resize, crop/ROI.
   *
   * AE order: resolution -\> resize -\> crop/ROI.
   */
  get _effective_dimensions(): [number, number] {
    const comp = this._parent_rqi.comp;
    const resX = this._parent_rqi._ldat.resolution_x || 1;
    const resY = this._parent_rqi._ldat.resolution_y || 1;

    let w = Math.ceil(comp.width / resX);
    let h = Math.ceil(comp.height / resY);

    if (this._om_ldat.resize) {
      [w, h] = [this._roou.width, this._roou.height];
    }

    if (this._om_ldat.use_region_of_interest && comp._viewer != null && comp._viewer.views?.length > 0) {
      const viewer = comp._viewer;
      const opts = at(viewer.views, viewer.activeViewIndex).options;
      w = opts.roiRight - opts.roiLeft;
      h = opts.roiBottom - opts.roiTop;
    } else if (this._om_ldat.crop) {
      w -= this._om_ldat.crop_left + this._om_ldat.crop_right;
      h -= this._om_ldat.crop_top + this._om_ldat.crop_bottom;
    }

    return [Math.max(w, 1), Math.max(h, 1)];
  }

  /** Effective frame rate: custom if enabled, else comp frame rate. */
  get _effective_frame_rate(): number {
    const rqi = this._parent_rqi;
    if (rqi._ldat.use_this_frame_rate) {
      return rqi._use_this_frame_rate;
    }
    return rqi.comp.frameRate;
  }

  /**
   * Recompute _roou.width and _roou.height from current settings.
   *
   * When resize is enabled, _roou.width/height hold the resize targets
   * and must not be overwritten. When video output is off (audio
   * formats, audio-only movies) the dimensions must stay 0: writing
   * comp dimensions here would flip video output on - the exact
   * corruption the `Video Output` format gate exists to prevent -
   * via a mundane crop/resize/ROI write.
   */
  _update_output_dimensions(): void {
    if (!this._video_output) {
      return;
    }
    if (this._om_ldat.resize) {
      return;
    }

    [this._roou.width, this._roou.height] = this._effective_dimensions;
  }

  /**
   * Store the output frame rate: the render frame rate divided by
   * (the item's skip frames + 1).
   */
  _set_frame_rate(): void {
    const skip = this._parent_rqi.skipFrames;
    this._roou.frame_rate = this._effective_frame_rate / (skip + 1);
  }

  /**
   * Apply the runtime touches AE adds to a freshly built/applied Rouu.
   *
   * After Effects writes these on top of the stored format header: the
   * `applied_marker` byte, the output frame rate once the item is
   * prepared for output (AE 2026 then stores the comp rate of a 60 or
   * 12.5 fps comp), and the comp-resolved output dimensions for video
   * formats (audio-only formats keep width/height=0).
   */
  _finalize_roou(): void {
    this._roou.applied_marker = 1;
    this._set_frame_rate();
    if (this._roou.width > 0) {
      // video format; audio keeps 0
      this._update_output_dimensions();
    }
  }

  /** Output color space derived from ICC profile and working space. */
  get _output_color_space(): string | null {
    return mapOutputColorSpace(
      this._om_ldat.output_profile_id,
      this._om_ldat.output_color_space_working !== 0,
      this._project.workingSpace,
    );
  }

  /**
   * The output color space (Output Module Settings \> Color Management).
   * Read / Write.
   *
   * Reading returns the name of an Adobe ICC profile (e.g. `"ARRI LogC3 Wide Color Gamut - EI 800"`), the OCIO color-space name (reverse-mapped
   * from the id via the project's OCIO configuration), or - when set to the
   * working color space - the project's working-space name (mirroring AE).
   *
   * Writable as `"Working Color Space"`, a catalogued Adobe ICC profile name
   * (Adobe CMS mode; the 16-byte profile ID is written, no ICC bytes needed),
   * or - in OCIO mode - any color space, role, alias, or `display/view` pair
   * of the project's OCIO configuration (the 16-byte id is computed from the
   * config; see `py_aep.color.ocio.ocio_output_profile_id`).
   *
   * **Note:** Not exposed in ExtendScript.
   */
  get outputColorSpace(): string {
    const project = this._project;
    const ldat = this._om_ldat;
    if (project.colorManagementSystem === ColorManagementSystem.OCIO && !ldat.output_color_space_working) {
      const config = resolveOcioConfig(project.ocioConfigurationFile);
      if (config != null) {
        const name = ocioColorSpaceForProfileId(config, new Uint8Array(ldat.output_profile_id));
        if (name != null) {
          return name;
        }
      }
    }
    return this._output_color_space || "";
  }

  set outputColorSpace(value: string) {
    validateString(value);
    const ldat = this._om_ldat;
    if (value === "Working Color Space") {
      ldat.output_color_space_working = 1;
      ldat.output_profile_id = bytes_.repeat(b("\xff"), 16);
      return;
    }
    const project = this._project;
    if (project.colorManagementSystem === ColorManagementSystem.OCIO) {
      const config = requireOcioConfig(project.ocioConfigurationFile, `compute the output color space id for ${repr(value)}`);
      ldat.output_color_space_working = 0;
      ldat.output_profile_id = ocioOutputProfileId(config, value);
      return;
    }
    const profileId = profileIdForName(value);
    if (profileId == null) {
      throw new NotImplementedError(`Output color space ${repr(value)} is not a known Adobe ICC profile.`);
    }
    ldat.output_color_space_working = 0;
    ldat.output_profile_id = profileId;
  }

  /** Output file info (read-only). */
  get _output_file_info(): Map<string, string> {
    const fileTemplate = this.fileTemplate;
    const folderPath = this._folder_path;
    const fileNameTemplate = this._file_name_template;
    let subfolderPath: string;
    let fileName: string;
    if (fileNameTemplate.includes("\\") || fileNameTemplate.includes("/")) {
      const sep = fileNameTemplate.includes("\\") ? "\\" : "/";
      const lastSepIdx = fileNameTemplate.lastIndexOf(sep);
      subfolderPath = fileNameTemplate.slice(0, lastSepIdx);
      fileName = fileNameTemplate.slice(lastSepIdx + 1);
    } else {
      subfolderPath = "";
      fileName = fileNameTemplate;
    }
    return new Map<string, string>([
      ["Full Flat Path", fileTemplate],
      ["Base Path", folderPath],
      ["Subfolder Path", subfolderPath],
      ["File Name", fileName],
      ["File Template", fileNameTemplate],
    ]);
  }

  /** Starting frame number. */
  get _starting_number(): number {
    if (!this._om_ldat.use_comp_frame_number) {
      return this._roou.starting_number;
    }
    const rqi = this._parent_rqi;
    const startSeconds = rqi.timeSpanStart;
    const frameRate = rqi.comp.frameRate;
    return int(round(startSeconds * frameRate));
  }

  set _starting_number(value: number) {
    _validateNumber({ min: 0, max: 9999999, integer: true })(value);
    this._roou.starting_number = value;
  }

  /** Resize dimensions as [width, height]. */
  get _resize_to(): [number, number] {
    return [this._roou.width, this._roou.height];
  }

  set _resize_to(value: [number, number]) {
    validateSequence({ min: 1, max: 30000, length: 2, integer: true })(value);
    if (!this._video_output) {
      // Writing resize targets into the Rouu would flip video
      // output on (dimensions ARE the video-output flag).
      throw new ValueError("'Resize to' requires video output, which is off " + "(and unavailable for audio formats).");
    }
    [this._roou.width, this._roou.height] = value;
  }

  /**
   * Build the full output file template path from components.
   *
   * Combines the output folder path and file name template into a single
   * path string, using the path separator found in the folder path.
   *
   * @param folderPath - The output folder path from alas data.
   * @param fileNameTemplate - The file name template (e.g., `[compName].[fileExtension]`).
   * @param isFolder - Whether the alas path points to a folder.
   * @returns The complete file template path.
   */
  static _build_file_template(folderPath: string, fileNameTemplate: string, isFolder: boolean): string {
    if (!folderPath) {
      return "";
    }

    if (!fileNameTemplate) {
      return folderPath;
    }

    if (isFolder) {
      const pathSep = folderPath.includes("\\") ? "\\" : "/";
      const cleanedPath = rstrip(folderPath, pathSep);
      return `${cleanedPath}${pathSep}${fileNameTemplate}`;
    }

    return folderPath;
  }

  /** Parsed JSON from the alas chunk. */
  get _alas_data(): AlasData {
    if (this._alas_utf8 == null) {
      return new Map();
    }
    const text = this._alas_utf8.value;
    if (!text) {
      return new Map();
    }
    const data = jsonLoads(text);
    return data instanceof Map ? data : new Map();
  }

  /** Whether the alas path points to a folder. */
  get _is_folder(): boolean {
    return pyBool(dictGet(this._alas_data, "target_is_folder", false));
  }

  /** The four-character video codec identifier. */
  get _video_codec(): string | null {
    return this._roou.video_codec || null;
  }

  /** Derive file extension from format_id, with Cineon special case. */
  get _resolve_extension(): string | null {
    const formatId = this._roou.format_id;
    if (formatId === "sDPX") {
      const fo = this._format_options;
      if (fo instanceof CineonFormatOptions) {
        return fo.fileFormat === CineonFileFormat.DPX ? "dpx" : "cin";
      }
      return "dpx";
    }
    return FORMAT_ID_EXTENSIONS.get(formatId) ?? null;
  }

  /** The output folder path from the alas chunk. */
  get _folder_path(): string {
    return str(dictGet(this._alas_data, "fullpath", ""));
  }

  /** The file name template from the Utf8 chunk. */
  get _file_name_template(): string {
    if (this._file_name_utf8 == null) {
      return "";
    }
    return this._file_name_utf8.value;
  }

  /**
   * The raw file path template, may contain `[compName]` and
   * `[fileExtension]` variables. Read / Write.
   *
   * py_aep extension: a folder path set here is stored in the style of
   * the project's platform (see {@link py_aep.parse | parse}).
   */
  get fileTemplate(): string {
    return this.constructor._build_file_template(this._folder_path, this._file_name_template, this._is_folder);
  }

  set fileTemplate(value: string) {
    validateString(value);
    let alas = this._alas_utf8;
    if (alas == null) {
      alas = this._add_output_path_record();
    }
    let folderPath: string;
    let fileName: string;
    if (this._is_folder) {
      const pathSep = value.includes("\\") ? "\\" : "/";
      const lastSep = value.lastIndexOf(pathSep);
      if (lastSep >= 0) {
        folderPath = value.slice(0, lastSep + 1);
        fileName = value.slice(lastSep + 1);
      } else {
        folderPath = this._folder_path;
        fileName = value;
      }
    } else {
      folderPath = value;
      fileName = "";
    }

    const data = this._alas_data;
    folderPath = platformPath(folderPath, { windows: this._project._windows });
    data.set("fullpath", folderPath);
    data.set("platform", alasPlatform(folderPath));
    data.set("ascendcount_base", PENDING_ASCENDCOUNT);
    data.set("ascendcount_target", PENDING_ASCENDCOUNT);
    alas.value = dumpAlas(data);

    if (this._file_name_utf8 != null) {
      this._file_name_utf8.value = fileName;
    }
  }

  /**
   * Give a module that has no output path yet (a fresh
   * `RenderQueue.add()` item) the folder `alas` record AE writes when a
   * script sets its file: a `LIST:Als2` just before the module name, the
   * settings' has-output-file bit (AE ignores the record without it), and
   * the item leaves "Needs Output" for "Queued" (measured on AE 2026).
   */
  _add_output_path_record(): Utf8Chunk {
    const lomChunks = this._parent_rqi._lom.chunks;
    const als2 = buildAls2List("", { target_is_folder: true });
    let position: number;
    if (this._name_utf8 != null) {
      position = indexByIdentity(lomChunks, this._name_utf8);
    } else {
      position = this._block_span(lomChunks)[1];
    }
    lomChunks.splice(position, 0, als2);
    const alas = (this._alas_utf8 = findByType(als2.chunks, "alas"));
    this._om_ldat.has_output_file = true;
    if (this._parent_rqi.status === RQItemStatus.NEEDS_OUTPUT) {
      this._parent_rqi.status = RQItemStatus.QUEUED;
    }
    return alas;
  }

  /** The project this output module belongs to. */
  get _project(): Project {
    return this.parent._project;
  }

  /**
   * The full path for the file this output module is set to render.
   *
   * Resolves template variables like `[compName]`, `[width]`, `[frameRate]`,
   * etc. to their actual values based on the composition and render settings.
   * Read / Write.
   */
  get file(): string {
    const comp = this.parent.comp;
    const rqSettings = this.parent.settings;

    const extension = this._resolve_extension;
    const omChannels = this.settings.get("Channels");
    const omDepth = this.settings.get("Depth");
    const compressor = this._video_codec ? VIDEO_CODEC_NAMES.get(this._video_codec) ?? this._video_codec : null;

    const [effectiveWidth, effectiveHeight] = this._effective_dimensions;
    const effectiveFrameRate = this._effective_frame_rate;
    const timeSpan = resolveTimeSpan(comp, rqSettings, effectiveFrameRate);

    const project = this._project;
    const projectName = project.file ? new Path(project.file).stem : "Untitled Project";

    return resolveOutputFilename(
      this.fileTemplate,
      projectName,
      comp.name,
      this.parent.name,
      this.name,
      effectiveWidth,
      effectiveHeight,
      effectiveFrameRate,
      timeSpan.start_frame,
      timeSpan.end_frame,
      timeSpan.duration_frames,
      timeSpan.start_time,
      timeSpan.end_time,
      timeSpan.duration_time,
      omChannels,
      int(project.bitsPerChannel),
      omDepth,
      compressor,
      rqSettings.get("Field Render"),
      rqSettings.get("3:2 Pulldown"),
      extension,
    );
  }

  set file(value: string) {
    this.fileTemplate = value;
  }

  /**
   * Return output module settings in the specified format.
   *
   * @param format - The output format. `GetSettingsFormat.NUMBER` returns numeric values (enums
   *   unwrapped to ints). `GetSettingsFormat.STRING` returns all values as strings
   */
  getSettings(format: GetSettingsFormat = GetSettingsFormat.STRING): Map<string, SettingValue> {
    if (format === GetSettingsFormat.STRING) {
      return settingsToString(this.settings, buildResizeToStrings(this._project._preferences));
    }
    if (format === GetSettingsFormat.NUMBER) {
      return settingsToNumber(this.settings);
    }
    throw new ValueError(`Unsupported format: ${repr(format)}`);
  }

  /**
   * Return a single output module setting in the specified format.
   *
   * @param key - The setting key (e.g. `"Video Output"`, `"Audio Bit Depth"`).
   * @param format - The output format.
   */
  getSetting(key: string, format: GetSettingsFormat = GetSettingsFormat.STRING): SettingValue {
    return getitem(this.getSettings(format), key);
  }

  /**
   * Available output module template names.
   *
   * Requires `ae_preferences_dir` to have been passed to `parse()`.
   * Returns an empty list if no preferences directory was provided.
   */
  get templates(): string[] {
    try {
      return this._project._get_output_templates().map((t) => t.name);
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
      return [];
    }
  }

  /**
   * Apply an output module template by name.
   *
   * Copies the template's settings (channels, resize, crop, audio,
   * post-render action, etc.) and format info (Rouu data) to this
   * output module.
   *
   * The `format_options` object is rebuilt for the new format:
   * references held to the previous one are stale afterwards -
   * re-fetch `om.formatOptions`.
   *
   * Requires `ae_preferences_dir` to have been passed to `parse()`.
   *
   * @param name - Template name (e.g. `"Lossless"`, `"H.264 - Match Render Settings - 15 Mbps"`).
   * @throws {@link ValueError} If the template name is not found.
   */
  applyTemplate(name: string): void {
    const templates = this._project._get_output_templates();
    for (const template of templates) {
      if (template.name === name) {
        this._apply_output_template(template);
        return;
      }
    }
    const names = templates.map((t) => t.name);
    throw new ValueError(`Template ${repr(name)} not found. Available: ${repr(names)}`);
  }

  /**
   * Return `[start, end)` indices of this module's chunk block in LOm.
   *
   * The block starts at this module's `Roou` (located by identity, as
   * attrs `__eq__` is structural) and runs to the next `Roou` or the
   * end of the list - the same span the parser builds with
   * `split_on_type(lom_chunks, "Roou")`.
   */
  _block_span(lomChunks: Chunk[]): [number, number] {
    const start = indexByIdentity(lomChunks, this._roou);
    let end = lomChunks.length;
    for (let i = start + 1; i < lomChunks.length; i++) {
      if (lomChunks[i].chunk_type === "Roou") {
        end = i;
        break;
      }
    }
    return [start, end];
  }

  /**
   * Apply a parsed output-module template to this module's chunks.
   *
   * Sets the per-module settings, the format header (`Rouu`), the format
   * options (`Ropt`, from the prefs "Output File Options" section), and
   * the module name.
   *
   * **Note:** The `Ropt` and name match After Effects byte-for-byte, but the
   * `Rouu` header and the settings come from the on-disk preferences
   * representation, which AE transforms when it applies a template -
   * so those two are not yet byte-identical to AE's runtime output.
   */
  _apply_output_template(template: OutputModuleTemplate): void {
    const lomChunks = this._parent_rqi._lom.chunks;
    this._om_ldat.copy_settings_from(template.settings);

    // The LOm list holds every output module of the RQ item back to back.
    // Locate this module's own block (its Roou up to the next Roou) by
    // identity so edits below never touch a sibling module.
    const [roouIdx, blockEnd] = this._block_span(lomChunks);

    if (template.format_info != null) {
      const newRoou = RouuChunk.frombytes(template.format_info, { chunk_type: "Roou" });
      pyAssert(newRoou instanceof RouuChunk);
      lomChunks[roouIdx] = newRoou;
      this._roou = newRoou;
      this._finalize_roou();
    }

    // Replace the Ropt with the template's format options (or an empty
    // Ropt for formats that have none, e.g. AIFF). Scope the search to
    // this module's block so a sibling module's Ropt is never hit.
    const newRopt: Chunk =
      template.format_options != null
        ? RoptChunk.frombytes(template.format_options, { chunk_type: "Ropt" })
        : new RoptChunk();
    for (let i = roouIdx; i < blockEnd; i++) {
      if (lomChunks[i].chunk_type === "Ropt") {
        lomChunks[i] = newRopt;
        break;
      }
    }

    // The new Ropt may be a different format from the one _format_options
    // wrapped at parse time, so re-derive it from this module's block the
    // same way parsing does. Detach the outgoing wrapper first: a
    // reference the caller fetched before this call wraps the replaced
    // Ropt, so its writes must hit the "detached" guard rather than land
    // in an orphaned body and be silently dropped from the saved file.
    if (this._format_options != null) {
      this._format_options._detached = true;
    }
    this._format_options = parseFormatOptions(lomChunks.slice(roouIdx, blockEnd));
    if (this._format_options != null) {
      this._format_options._parent_om = this;
    }

    if (this._name_utf8 != null) {
      this._name_utf8.value = template.name;
    }
  }

  /**
   * Remove this output module from the render queue item.
   *
   * @throws {@link ValueError} If this is the last output module (AE requires at least one).
   */
  remove(): void {
    if (this._parent_rqi._output_modules.length <= 1) {
      throw new ValueError("Cannot remove the last output module");
    }

    const rqi = this._parent_rqi;
    const omIdx = rqi._output_modules.indexOf(this);

    // Remove this module's chunk block from LOm (its Roou to the next Roou
    // or end). Located by identity and bounded the same way the parser
    // splits modules, so byte-equal sibling modules are never hit.
    const lomChunks = rqi._lom.chunks;
    const [roouIdx, endIdx] = this._block_span(lomChunks);
    lomChunks.splice(roouIdx, endIdx - roouIdx);

    const omLdat = findByType(rqi._list_chunk.chunks, "ldat");
    omLdat.items.splice(omIdx, 1);

    const omLhd3 = findByType(rqi._list_chunk.chunks, "lhd3");
    setLhd3Count(omLhd3, omLhd3.count - 1, LHD3_BLOCK_SINGLE);

    rqi._output_modules.splice(omIdx, 1);
  }
}

// Field descriptors: each ChunkField assigned in the Python class body is installed on the
// prototype after the class, so the `declare`d fields above read and write through it.
descriptor(OutputModule, "includeSourceXmp", ChunkField.bool("_om_ldat", "include_source_xmp"));

descriptor(OutputModule, "postRenderAction", ChunkField.enum(PostRenderAction, "_om_ldat", "post_render_action"));

descriptor(
  OutputModule,
  "_audio_bit_depth",
  ChunkField.enum(AudioBitDepth, "_roou", "audio_bit_depth", {
    validate: _validateForFormat("Audio Bit Depth", _reject24BitAudio),
    post_set: "_sync_audio_format",
  }),
);

descriptor(
  OutputModule,
  "_audio_channels",
  ChunkField.enum(AudioChannels, "_roou", "audio_channels", {
    validate: _validateForFormat("Audio Channels"),
    post_set: "_clamp_audio_dependents",
  }),
);

descriptor(
  OutputModule,
  "_audio_sample_rate",
  ChunkField.enum(AudioSampleRate, "_roou", "audio_sample_rate", {
    validate: _validateForFormat("Audio Sample Rate"),
  }),
);

descriptor(
  OutputModule,
  "_channels",
  ChunkField.enum(OutputChannels, "_om_ldat", "channels", {
    validate: _validateForFormat("Channels"),
    post_set: "_sync_after_channels",
  }),
);

descriptor(
  OutputModule,
  "_color_mode",
  ChunkField.enum(OutputColorMode, "_roou", "color_premultiplied", {
    validate: _validateForFormat("Color"),
  }),
);

descriptor(OutputModule, "_convert_to_linear_light", ChunkField.enum(ConvertToLinearLight, "_om_ldat", "convert_to_linear_light"));

descriptor(OutputModule, "_crop", ChunkField.bool("_om_ldat", "crop", { post_set: "_update_output_dimensions" }));

descriptor(
  OutputModule,
  "_crop_bottom",
  new ChunkField("_om_ldat", "crop_bottom", {
    validate: _validateCrop("_crop_top", "height"),
    post_set: "_update_output_dimensions",
  }),
);

descriptor(
  OutputModule,
  "_crop_left",
  new ChunkField("_om_ldat", "crop_left", {
    validate: _validateCrop("_crop_right", "width"),
    post_set: "_update_output_dimensions",
  }),
);

descriptor(
  OutputModule,
  "_crop_right",
  new ChunkField("_om_ldat", "crop_right", {
    validate: _validateCrop("_crop_left", "width"),
    post_set: "_update_output_dimensions",
  }),
);

descriptor(
  OutputModule,
  "_crop_top",
  new ChunkField("_om_ldat", "crop_top", {
    validate: _validateCrop("_crop_bottom", "height"),
    post_set: "_update_output_dimensions",
  }),
);

descriptor(
  OutputModule,
  "_depth",
  ChunkField.enum(OutputColorDepth, "_roou", "depth", {
    allow_out_of_enum_values: true,
    validate: _validateForFormat("Depth", validateEnum(OutputColorDepth)),
    post_set: "_sync_png_options",
  }),
);

descriptor(
  OutputModule,
  "_format",
  ChunkField.enum(OutputFormat, "_roou", "format_id", {
    allow_out_of_enum_values: true,
    reverse: (v: number) => OutputFormat.to_format_id(v),
    transform: (v: string | Uint8Array) => OutputFormat.from_format_id(v),
    read_only: true,
  }),
);

descriptor(OutputModule, "_include_project_link", ChunkField.bool("_om_ldat", "include_project_link"));

descriptor(OutputModule, "_lock_aspect_ratio", ChunkField.bool("_om_ldat", "lock_aspect_ratio"));

descriptor(OutputModule, "_post_render_action_setting", ChunkField.enum(PostRenderActionSetting, "_om_ldat", "post_render_action"));

descriptor(OutputModule, "_preserve_rgb", ChunkField.bool("_om_ldat", "preserve_rgb"));

descriptor(OutputModule, "_resize", ChunkField.bool("_om_ldat", "resize", { post_set: "_update_output_dimensions" }));

descriptor(OutputModule, "_resize_quality", ChunkField.enum(ResizeQuality, "_om_ldat", "resize_quality"));

descriptor(OutputModule, "_use_comp_frame_number", ChunkField.bool("_om_ldat", "use_comp_frame_number"));

descriptor(
  OutputModule,
  "_use_region_of_interest",
  ChunkField.bool("_om_ldat", "use_region_of_interest", { post_set: "_update_output_dimensions" }),
);
