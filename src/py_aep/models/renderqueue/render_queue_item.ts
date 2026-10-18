// Port of py_aep/models/renderqueue/render_queue_item.py

import { INSPECT } from "../../../pyrt/index.ts";
import { ColorDepthSetting, DiskCacheSetting, EffectsSetting, FieldRender, FrameBlendingSetting, FrameRateSetting, GetSettingsFormat, GuideLayers, LogType, MotionBlurSetting, ProxyUseSetting, PulldownSetting, RenderQuality, RQItemStatus, SoloSwitchesSetting, TimeSpanSource } from "../../enums/index.ts";
import { ContainerChunk, ListChunk } from "../../binary/chunk.ts";
import { LHD3_BLOCK_SINGLE, setLhd3Count } from "../../binary/ldat_chunks.ts";
import { buildOmContainer, buildRoutBlock, cloneChunkTree } from "../../binary/mutations.ts";
import { RenderSettingsItem, type RoutItem } from "../../binary/render_chunks.ts";
import { Utf8Chunk } from "../../binary/scalar_chunks.ts";
import { findByType, indexByIdentity, splitOnType } from "../../binary/utils.ts";
import { ChunkField } from "../descriptors.ts";
import type { CompItem } from "../items/composition.ts";
import type { Project } from "../project.ts";
import { _validateNumber, validateBool, validatePositiveInt, validatePositiveNumber, validateSequence, validateString } from "../validators.ts";
import { SettingsView, type SettingsSpec, type SettingValue, type SettingValues, settingsToNumber, settingsToString } from "./settings.ts";
import type { RenderQueue } from "./render_queue.ts";
import {
  deepcopy,
  descriptor,
  floatRepr,
  format,
  getitem,
  int,
  max,
  repr,
  round,
  StopIteration,
  ValueError,
  type ClassAttributes,
} from "../../../pyrt/index.ts";
import { OutputModule } from "./output_module.ts";
import { parseOutputModule } from "../../parsers/output_module.ts";

// NOTE(port): the epoch is a UTC `Date`; Python's naive datetime(1904, 1, 1) is the same wall-clock instant.
export const _AEP_EPOCH = new Date(Date.UTC(1904, 0, 1));

/** Convert Mac HFS+ epoch timestamp to datetime, or None if 0. */
export function _startTimeFromBinary(value: number): Date | null {
  if (!value) return null;
  return new Date(_AEP_EPOCH.getTime() + value * 1000);
}

/**
 * The id AE gives a new render-queue item: the queue's highest + 1, and
 * 2 in an empty queue (AE 2026: ids 9 and 3 -\> an added item gets 10, a
 * duplicate after it 11).
 */
export function _nextItemId(rq: RenderQueue): number {
  return max(
    rq.items.map((item) => item._ldat.itemId),
    null,
    1,
  ) + 1;
}

/**
 * The render settings view: AE marks the item's render settings as
 * written by a script on every `setSettings` (AE 2026).
 */
export class _RenderSettingsView extends SettingsView<RenderSettingValues> {
  declare _owner: RenderQueueItem;
  set(key: string, value: SettingValue | null): void {
    super.set(key, value);
    this._owner._ldat.settingsWritten = 1;
  }
}

/** The value each render setting reads as: its {@link RenderQueueItem} attribute's type. */
export type RenderSettingValues = SettingValues & {
  "3:2 Pulldown": RenderQueueItem["_pulldown"];
  "Color Depth": RenderQueueItem["_colorDepth"];
  "Disk Cache": RenderQueueItem["_diskCache"];
  "Effects": RenderQueueItem["_effects"];
  "Field Render": RenderQueueItem["_fieldRender"];
  "Frame Blending": RenderQueueItem["_frameBlending"];
  "Frame Rate": RenderQueueItem["_frameRateSetting"];
  "Guide Layers": RenderQueueItem["_guideLayers"];
  "Motion Blur": RenderQueueItem["_motionBlur"];
  "Proxy Use": RenderQueueItem["_proxyUse"];
  "Quality": RenderQueueItem["_quality"];
  "Resolution": RenderQueueItem["_resolution"];
  "Skip Existing Files": RenderQueueItem["_skipExistingFiles"];
  "Solo Switches": RenderQueueItem["_soloSwitches"];
  "Time Span Duration": RenderQueueItem["timeSpanDuration"];
  "Time Span End": RenderQueueItem["timeSpanEnd"];
  "Time Span Start": RenderQueueItem["timeSpanStart"];
  "Time Span": RenderQueueItem["_timeSpanSource"];
  "Use comp's frame rate": RenderQueueItem["_compFrameRate"];
  "Use this frame rate": RenderQueueItem["_useThisFrameRate"];
};

// ---------------------------------------------------------------------------
// RENDER_SETTINGS: ExtendScript key -> (attribute, optional enum class)
// ---------------------------------------------------------------------------

export const RENDER_SETTINGS: SettingsSpec = new Map([
  ["3:2 Pulldown", ["_pulldown", PulldownSetting]],
  ["Color Depth", ["_colorDepth", ColorDepthSetting]],
  ["Disk Cache", ["_diskCache", DiskCacheSetting]],
  ["Effects", ["_effects", EffectsSetting]],
  ["Field Render", ["_fieldRender", FieldRender]],
  ["Frame Blending", ["_frameBlending", FrameBlendingSetting]],
  ["Frame Rate", ["_frameRateSetting", FrameRateSetting]],
  ["Guide Layers", ["_guideLayers", GuideLayers]],
  ["Motion Blur", ["_motionBlur", MotionBlurSetting]],
  ["Proxy Use", ["_proxyUse", ProxyUseSetting]],
  ["Quality", ["_quality", RenderQuality]],
  ["Resolution", ["_resolution", null]],
  ["Skip Existing Files", ["_skipExistingFiles", null]],
  ["Solo Switches", ["_soloSwitches", SoloSwitchesSetting]],
  ["Time Span Duration", ["timeSpanDuration", null]],
  ["Time Span End", ["timeSpanEnd", null]],
  ["Time Span Start", ["timeSpanStart", null]],
  ["Time Span", ["_timeSpanSource", TimeSpanSource]],
  ["Use comp's frame rate", ["_compFrameRate", null]],
  ["Use this frame rate", ["_useThisFrameRate", null]],
]);

/**
 * The `RenderQueueItem` object represents an individual item in the render
 * queue. It provides access to the specific settings for an item to be
 * rendered.
 *
 * ```ts
 * import { parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const rq_item = app.project.renderQueue.items[0];
 * console.log(rq_item.status);
 * for (const output_module of rq_item) {
 *   // ...
 * }
 * ```
 *
 * @example
 * @see https://ae-scripting.docsforadobe.dev/renderqueue/renderqueueitem/
 */
export class RenderQueueItem {
  declare ["constructor"]: ClassAttributes<typeof RenderQueueItem>;
  /**
   * The number of seconds that have elapsed in rendering this item.
   * Read-only.
   */
  declare elapsedSeconds: number;

  /**
   * A log type for this item, indicating which events should be logged
   * while this item is being rendered. Read / Write.
   */
  declare logType: LogType;

  /**
   * The name of the render settings template used for this item.
   * Read / Write.
   */
  declare name: string;

  /**
   * When `true`, a user notification is enabled for this render queue
   * item, signaling the user upon render completion. Read / Write.
   */
  declare queueItemNotify: boolean;

  /**
   * The date and time when rendering of this item started, or `null` if
   * the item has not started rendering. Read-only.
   */
  declare startTime: Date | null;

  /** The current render status of the item. Read / Write. */
  declare status: RQItemStatus;

  declare _colorDepth: ColorDepthSetting;
  declare _diskCache: DiskCacheSetting;
  declare _effects: EffectsSetting;
  declare _fieldRender: FieldRender;
  declare _frameBlending: FrameBlendingSetting;
  declare _guideLayers: GuideLayers;
  declare _motionBlur: MotionBlurSetting;
  declare _proxyUse: ProxyUseSetting;
  declare _pulldown: PulldownSetting;
  declare _quality: RenderQuality;
  declare _skipExistingFiles: boolean;
  declare _soloSwitches: SoloSwitchesSetting;
  declare _timeSpanSource: TimeSpanSource;
  declare _frameRateSetting: FrameRateSetting;

  declare _ldat: RenderSettingsItem;
  declare _litm: ListChunk;
  declare _listChunk: ListChunk;
  declare _lom: ListChunk;
  declare _rcom: ContainerChunk | null;
  declare _rcomUtf8: Utf8Chunk | null;
  declare _routItems: RoutItem[];
  declare _parentRq: RenderQueue;
  declare _comp: CompItem;
  declare _outputModules: OutputModule[];
  declare _skipFrames: number;

  constructor(kw: {
    _ldat: RenderSettingsItem;
    _litm: ListChunk;
    _listChunk: ListChunk;
    _lom: ListChunk;
    _rcom?: ContainerChunk | null;
    _rcomUtf8?: Utf8Chunk | null;
    _routItems: RoutItem[];
    parent: RenderQueue;
    comp: CompItem;
    outputModules: OutputModule[];
  }) {
    const {
      _ldat,
      _litm,
      _listChunk: _list_chunk,
      _lom,
      _rcom = null,
      _rcomUtf8: _rcom_utf8 = null,
      _routItems: _rout_items,
      parent,
      comp,
      outputModules: output_modules,
    } = kw;
    this._ldat = _ldat;
    this._litm = _litm;
    this._listChunk = _list_chunk;
    this._lom = _lom;
    this._rcom = _rcom;
    this._rcomUtf8 = _rcom_utf8;
    this._routItems = _rout_items;
    this._parentRq = parent;
    this._comp = comp;
    this._outputModules = output_modules;
    this._skipFrames = 0;
  }

  /**
   * Create a new RenderQueueItem for a composition.
   *
   * Constructs all backing chunks from scratch with default render
   * settings and a single output module. If default templates are
   * available from AE preferences, their settings are applied.
   *
   * @param comp - The composition to render.
   * @param kw - Keyword arguments:
   * - `parent`: The parent RenderQueue.
   * @returns The new RenderQueueItem model.
   */
  static _new(comp: CompItem, kw: { parent: RenderQueue }): RenderQueueItem {
    const { parent } = kw;
    const project = parent.parent;

    // Create render settings with comp-specific values; the remaining
    // fields default to AE's factory "Best Settings" render template.
    const rsItem = new RenderSettingsItem({ compId: comp.id });
    // AE writes a fixed 30 in this "use this frame rate" slot for a fresh
    // item (the active setting is "use comp's frame rate", so it's an
    // unused placeholder); the real rate comes from the comp.
    rsItem.frameRateInteger = 30;
    // Match a freshly-added AE item: status NEEDS_OUTPUT (no output file
    // yet) and time span = work area (the source stores zero dividend/
    // divisor; the span is derived from the comp's work area).
    rsItem.status = RQItemStatus.toBinary(RQItemStatus.NEEDS_OUTPUT);
    rsItem.timeSpanSource = int(TimeSpanSource.WORK_AREA_ONLY);
    rsItem.timeSpanStartDivisor = 0;
    rsItem.timeSpanDurationDivisor = 0;
    rsItem.itemId = _nextItemId(parent);

    // When ae_preferences_dir was supplied, overlay the user's configured
    // default render-settings template. Only _TEMPLATE_FIELDS are copied,
    // so status / time-span / reserved defaults above are preserved.
    if (project._aePreferencesDir != null) {
      const templates = project._getRenderTemplates();
      const defaultIdx = project._defaultRenderTemplateIndex;
      if (defaultIdx != null && defaultIdx < templates.length) {
        rsItem.copySettingsFrom(templates[defaultIdx]);
      }
    }

    const rqi = new this({
      _ldat: rsItem,
      _litm: parent._litm,
      _listChunk: buildOmContainer(),
      _lom: new ListChunk({ listType: "LOm ", chunks: [] }),
      _rcom: null,
      _rcomUtf8: null,
      _routItems: buildRoutBlock(),
      parent,
      comp,
      outputModules: [],
    });

    rqi.add();

    return rqi;
  }

  /**
   * Add an output module to this render queue item.
   *
   * Creates a new {@link OutputModule} with default settings (or the
   * default template if `aePreferencesDir` was passed to `parse()`).
   *
   * @returns The newly created {@link OutputModule}.
   */
  add(): OutputModule {
    const [om, lomChunks] = OutputModule._new({
      renderSettingsLdat: this._ldat,
      parent: this,
    });

    // A render queue item stores all its output modules in one LOm (split
    // by Roou) and one OM-metadata list. Keep the list's lhd3 capacity
    // counters in sync with the module count (block 1: _count_b /
    // _counter_a / _counter_b all equal `count`), or AE rejects the file
    // with "Invalid read length".
    this._lom.chunks.push(...lomChunks);

    const omLdat = findByType(this._listChunk.chunks, "ldat");
    omLdat.items.push(om._omLdat);

    const omLhd3 = findByType(this._listChunk.chunks, "lhd3");
    setLhd3Count(omLhd3, omLhd3.count + 1, LHD3_BLOCK_SINGLE);

    this._outputModules.push(om);
    return om;
  }

  /**
   * Allow iteration over Output Modules.
   *
   * Iterates a snapshot so modules can be removed while looping.
   */
  [Symbol.iterator](): Iterator<OutputModule> {
    return [...this.outputModules][Symbol.iterator]();
  }

  [INSPECT](): string {
    // Python's repr of an IntEnum member is `<RQItemStatus.X: n>` (members are plain numbers here).
    const status = this.status;
    const statusRepr = RQItemStatus.has(status)
      ? `<RQItemStatus.${RQItemStatus.nameOf(status)}: ${status}>`
      : repr(status);
    return `RenderQueueItem(name=${repr(this.name)}, status=${statusRepr}, comp_name=${repr(this.compName)})`;
  }

  /** The composition that will be rendered by this render-queue item. Read-only. */
  get comp(): CompItem {
    return this._comp;
  }

  /** The list of Output Modules for the item. Read-only. */
  get outputModules(): OutputModule[] {
    return this._outputModules;
  }

  /** The {@link RenderQueue} containing this item. Read-only. */
  get parent(): RenderQueue {
    return this._parentRq;
  }

  /** The project this render queue item belongs to. */
  get _project(): Project {
    return this.parent.parent;
  }

  static _RESET_STATUSES: ReadonlySet<number> = new Set<number>([
    RQItemStatus.QUEUED,
    RQItemStatus.UNQUEUED,
    RQItemStatus.NEEDS_OUTPUT,
    RQItemStatus.WILL_CONTINUE,
  ]);

  /**
   * Reset start_time and elapsed_seconds for non-terminal statuses,
   * and keep the Render box in step: AE-saved items have it checked
   * from Queued on and clear while they need an output or are unqueued.
   */
  _onStatusChanged(): void {
    const status = this.status;
    if (this.constructor._RESET_STATUSES.has(status)) {
      this._ldat.startTime = 0;
      this._ldat.elapsedSeconds = 0;
    }
    if (status === RQItemStatus.NEEDS_OUTPUT || status === RQItemStatus.UNQUEUED) {
      this._ldat.renderChecked = false;
    } else if (status !== RQItemStatus.WILL_CONTINUE) {
      this._ldat.renderChecked = true;
    }
  }

  /**
   * When `true`, the item will be rendered when the render queue is
   * started. Read / Write.
   */
  get render(): boolean {
    return this.status !== RQItemStatus.UNQUEUED;
  }

  set render(value: boolean) {
    validateBool(value);
    this.status = value ? RQItemStatus.QUEUED : RQItemStatus.UNQUEUED;
  }

  /**
   * A comment that describes the render queue item. This shows in the
   * Render Queue panel. Read / Write.
   */
  get comment(): string {
    if (this._rcomUtf8 == null) return "";
    return this._rcomUtf8.value;
  }

  set comment(value: string) {
    validateString(value);
    if (this._rcomUtf8 != null) {
      this._rcomUtf8.value = value;
    } else if (value) {
      const utf8Chunk = new Utf8Chunk({ value });
      const rcomChunk = new ContainerChunk({
        chunkType: "RCom",
        chunks: [utf8Chunk],
      });
      const idx = this._litm.chunks.findIndex((c) => c === this._listChunk);
      if (idx === -1) throw new StopIteration();
      this._litm.chunks.splice(idx, 0, rcomChunk);
      this._rcomUtf8 = utf8Chunk;
      this._rcom = rcomChunk;
    }
  }

  /**
   * The number of frames to skip when rendering this item. Use this to
   * do rendering tests that are faster than a full render. A value of 0
   * skip no frames, and results in regular rendering of all frames. A
   * value of 1 skips every other frame. This is equivalent to "rendering
   * on twos." Higher values skip a larger number of frames. The total
   * length of time remains unchanged. For example, if skip has a value of
   * 1, a sequence output would have half the number of frames and in movie
   * output, each frame would be double the duration.
   *
   * Read / Write.
   *
   * **Note:** After Effects does not save the value: it reads 0 for every
   * item of a project it opens and renders all frames, whatever
   * output frame rate the output modules store (AE 2026, rendered).
   * py_aep keeps it in memory the same way - a parsed project starts
   * at 0. Writing it still stores each output module's frame rate
   * (the render frame rate divided by skip + 1), as AE does once an
   * item is prepared for output.
   */
  get skipFrames(): number {
    return this._skipFrames;
  }

  set skipFrames(value: number) {
    _validateNumber({ min: 0, max: 99, integer: true })(value);
    this._skipFrames = value;
    this._setOutputFrameRates();
  }

  /** Store the output frame rate of every output module. */
  _setOutputFrameRates(): void {
    for (const om of this.outputModules) {
      om._setFrameRate();
    }
  }

  /**
   * Return the number of output modules for this render queue item. Read-only.
   *
   * **Note:** Equivalent to `len(item.outputModules)`
   */
  get numOutputModules(): number {
    return this.outputModules.length;
  }

  /** Resolution as [x, y] divisors. */
  get _resolution(): number[] {
    return [this._ldat.resolutionX, this._ldat.resolutionY];
  }

  set _resolution(value: number[]) {
    // [0, 0] is a legal value meaning "Current Settings".
    validateSequence({ length: 2, min: 0, max: 99, integer: true })(value);
    // A HALF-zero pair is not: zero is only meaningful as the both-axes
    // "Current Settings" sentinel. AE's own dialog can only ever produce
    // [0, 0] or a pair with both axes >= 1, and `setSettings` on a
    // half-zero pair NATIVE-CRASHES AE 2026 (probed: [0, 5] and [5, 0]
    // crash; [0, 0], [3, 7] and [99, 99] are all fine). py_aep has no
    // coherent reading for it either - `_effectiveDimensions` degrades
    // the 0 to 1, silently rendering full width at a fraction of the
    // height.
    if ((value[0] === 0) !== (value[1] === 0)) {
      throw new ValueError(
        `Resolution divisors must both be zero ("Current Settings") ` +
          `or both be positive, got [${value[0]}, ${value[1]}]`,
      );
    }
    this._ldat.resolutionX = value[0];
    this._ldat.resolutionY = value[1];
    for (const om of this.outputModules) {
      om._updateOutputDimensions();
    }
  }

  /** Custom frame rate value. */
  get _useThisFrameRate(): number {
    return this._ldat.frameRate;
  }

  set _useThisFrameRate(value: number) {
    _validateNumber({ min: 0.1, max: 999 })(value);
    this._ldat.frameRate = value;
    this._setOutputFrameRates();
  }

  /** The composition's frame rate (read-only). */
  get _compFrameRate(): number {
    return this.comp.frameRate;
  }

  /**
   * SettingsView map
   * built live from the binary chunk, with ExtendScript-compatible keys
   * matching `get_settings()` output.
   *
   * Supports item assignment:
   *
   * ```ts
   * import { parse, RenderQuality } from "@bevyl-ai/ts-aep";
   * const rqi = parse("project.aep").project.renderQueue.items[0];
   * rqi.settings.set("Quality", RenderQuality.BEST);
   * ```
   *
   * @example
   */
  get settings(): SettingsView<RenderSettingValues> {
    return new _RenderSettingsView(this, RENDER_SETTINGS);
  }

  set settings(value: Map<string, SettingValue> | SettingsView) {
    if (!(value instanceof Map || value instanceof SettingsView)) {
      throw new ValueError("Settings must be a dictionary of key-value pairs");
    }
    const view = this.settings;
    // SettingsView exposes Python's Mapping `items()` as an array of pairs; a dict is a Map.
    const entries = value instanceof Map ? value.entries() : value.items();
    for (const [k, v] of entries) {
      view.set(k, v);
    }
  }

  /** Return (start, duration) in seconds based on time span source. */
  _resolvedTimeSpan(): [number, number] {
    const source = TimeSpanSource.fromBinary(this._ldat.timeSpanSource);
    if (source === TimeSpanSource.LENGTH_OF_COMP) {
      return [0.0, this.comp.duration];
    }
    if (source === TimeSpanSource.WORK_AREA_ONLY) {
      return [this.comp.workAreaStart, this.comp.workAreaDuration];
    }
    return [this._ldat.timeSpanStart, this._ldat.timeSpanDuration];
  }

  /** Return (start, duration) in frames based on time span source. */
  _resolvedTimeSpanFrames(): [number, number] {
    const source = TimeSpanSource.fromBinary(this._ldat.timeSpanSource);
    const fr = this.comp.frameRate;
    if (source === TimeSpanSource.LENGTH_OF_COMP) {
      return [0, round(this.comp.duration * fr)];
    }
    if (source === TimeSpanSource.WORK_AREA_ONLY) {
      return [
        round(this.comp.workAreaStart * fr),
        round(this.comp.workAreaDuration * fr),
      ];
    }
    const [startSec, durSec] = this._resolvedTimeSpan();
    return [round(startSec * fr), round(durSec * fr)];
  }

  /**
   * Write a time span value, switching to CUSTOM.
   *
   * Setting the duration keeps the start. Setting the start keeps the
   * end when the span still follows the work area or the comp, and keeps
   * the duration once it is CUSTOM (measured on AE 2026: 0..10 s -\>
   * start 1.03 gives 1.03 / 8.97; a custom 0 / 2.51 span -\> start 1.03
   * gives 1.03 / 2.51). Unlike AE scripting which accepts degenerate
   * spans and silently renders garbage (a start before 0 renders void
   * lead-in frames, an end before the start renders a single frame) -
   * py_aep validates the values like AE's own dialog.
   *
   * @param value - Time in seconds, or frame count if `is_frames` is True.
   * @param field - Either "start" or "duration".
   * @param isFrames - When True, `value` is a frame count and is converted to seconds via the
   *   composition frame rate before writing.
   * @throws {@link ValueError} If a start is negative, if either field would leave a duration
   *   shorter than one frame (AE's own scripting bound), or if a value does not fit the stored
   *   ratio.
   * @throws {@link TypeError} If the value is not a number.
   */
  _setTimeSpan(value: number, field: string, isFrames = false): void {
    const frameDuration = 1.0 / this.comp.frameRate;
    // A signed 32-bit dividend over a divisor of at least 1.
    _validateNumber({ min: 0.0, max: 2 ** 31 - 1 })(value);
    const seconds = isFrames ? value / this.comp.frameRate : value;
    // Both fields resolve the span BEFORE switching the source to
    // CUSTOM: a WORK_AREA_ONLY / LENGTH_OF_COMP item takes its span
    // from the comp, so CUSTOM has to carry the resolved values over
    // or the untouched field silently jumps to a stale ldat value.
    const [oldStart, oldDuration] = this._resolvedTimeSpan();
    let newStart: number;
    let newDuration: number;
    if (field === "duration") {
      if (seconds < frameDuration - 1e-9) {
        throw new ValueError(
          `Duration must be at least one frame ` +
            `(${format(frameDuration, ".6g")}s), got ${floatRepr(seconds)}`,
        );
      }
      newStart = oldStart;
      newDuration = seconds;
    } else {
      const custom = this._timeSpanSource === TimeSpanSource.CUSTOM;
      newStart = seconds;
      newDuration = custom ? oldDuration : oldStart + oldDuration - seconds;
      if (newDuration <= 0) {
        throw new ValueError(
          `Start time ${floatRepr(seconds)} is at or past the span end ` +
            `(${floatRepr(oldStart + oldDuration)})`,
        );
      }
      // The same one-frame floor the duration path enforces: reaching it
      // through the start must not be a back door to a degenerate span.
      if (newDuration < frameDuration - 1e-9) {
        throw new ValueError(
          `Start time ${floatRepr(seconds)} leaves a duration shorter than one ` +
            `frame (${format(frameDuration, ".6g")}s), got ${floatRepr(newDuration)}`,
        );
      }
    }
    this._ldat.timeSpanSource = int(TimeSpanSource.CUSTOM);
    this._ldat.timeSpanStart = newStart;
    this._ldat.timeSpanDuration = newDuration;
  }

  /**
   * The time in the composition, in seconds, at which rendering will
   * begin. Read / Write.
   *
   * Setting this keeps the span END fixed - the duration is
   * recomputed - and switches the time span source to CUSTOM.
   */
  get timeSpanStart(): number {
    return this._resolvedTimeSpan()[0];
  }

  set timeSpanStart(value: number) {
    this._setTimeSpan(value, "start");
  }

  /**
   * The duration in seconds of the composition to be rendered. The
   * duration is determined by subtracting the start time from the end
   * time. Read / Write.
   *
   * Setting this switches the time span source to CUSTOM.
   */
  get timeSpanDuration(): number {
    return this._resolvedTimeSpan()[1];
  }

  set timeSpanDuration(value: number) {
    this._setTimeSpan(value, "duration");
  }

  /**
   * The time in the composition, in frames, at which rendering will
   * begin. Read / Write.
   *
   * Setting this keeps the span END fixed - the duration is
   * recomputed - and switches the time span source to CUSTOM.
   */
  get timeSpanStartFrame(): number {
    return this._resolvedTimeSpanFrames()[0];
  }

  set timeSpanStartFrame(value: number) {
    this._setTimeSpan(value, "start", true);
  }

  /**
   * The duration in frames of the composition to be rendered. The
   * duration is determined by subtracting the start time from the end
   * time. Read / Write.
   *
   * Setting this switches the time span source to CUSTOM.
   */
  get timeSpanDurationFrames(): number {
    return this._resolvedTimeSpanFrames()[1];
  }

  set timeSpanDurationFrames(value: number) {
    this._setTimeSpan(value, "duration", true);
  }

  /**
   * The time in the composition, in seconds, at which rendering will
   * end. Read / Write.
   *
   * Setting this adjusts the duration, keeping the start unchanged,
   * and switches the time span source to CUSTOM.
   */
  get timeSpanEnd(): number {
    const [tsStart, tsDuration] = this._resolvedTimeSpan();
    return tsStart + tsDuration;
  }

  set timeSpanEnd(value: number) {
    validatePositiveNumber(value);
    this.timeSpanDuration = value - this.timeSpanStart;
  }

  /**
   * The time in the composition, in frames, at which rendering will
   * end. Read / Write.
   *
   * Setting this adjusts the duration in frames, keeping the start
   * unchanged, and switches the time span source to CUSTOM.
   */
  get timeSpanEndFrame(): number {
    return this.timeSpanStartFrame + this.timeSpanDurationFrames;
  }

  set timeSpanEndFrame(value: number) {
    validatePositiveInt(value);
    this.timeSpanDurationFrames = value - this.timeSpanStartFrame;
  }

  /** The name of the composition being rendered. */
  get compName(): string {
    return this.comp.name;
  }

  /**
   * Return render settings in the specified format.
   *
   * @param format_ - The output format. `GetSettingsFormat.NUMBER` returns numeric values (enums
   *   unwrapped to ints). `GetSettingsFormat.STRING` returns all values as strings
   */
  getSettings(format_: GetSettingsFormat = GetSettingsFormat.STRING): Map<string, SettingValue> {
    if (format_ === GetSettingsFormat.STRING) {
      return settingsToString(this.settings);
    }
    if (format_ === GetSettingsFormat.NUMBER) {
      return settingsToNumber(this.settings);
    }
    // Python's repr of an IntEnum member is `<GetSettingsFormat.X: n>` (members are plain numbers here).
    const formatRepr = GetSettingsFormat.has(format_)
      ? `<GetSettingsFormat.${GetSettingsFormat.nameOf(format_)}: ${format_}>`
      : repr(format_);
    throw new ValueError(`Unsupported format: ${formatRepr}`);
  }

  /**
   * Return a single render setting in the specified format.
   *
   * @param key - The setting key (e.g. `"Quality"`, `"Frame Rate"`).
   * @param format_ - The output format.
   */
  getSetting(key: string, format_: GetSettingsFormat = GetSettingsFormat.STRING): SettingValue {
    return getitem(this.getSettings(format_), key);
  }

  /**
   * Available render settings template names.
   *
   * Requires `aePreferencesDir` to have been passed to `parse()`.
   * Returns an empty list if no preferences directory was provided.
   */
  get templates(): string[] {
    try {
      return this._project._getRenderTemplates().map((t) => t.cleanTemplateName);
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
      return [];
    }
  }

  /**
   * Apply a render settings template by name.
   *
   * Looks up the template from the AE preferences data (requires
   * `aePreferencesDir` in `parse()`) and copies its settings to
   * this render queue item.
   *
   * @param name - Template name (e.g. `"Best Settings"`, `"Draft Settings"`).
   * @throws {@link ValueError} If the template name is not found.
   */
  applyTemplate(name: string): void {
    const rsItems = this._project._getRenderTemplates();
    for (const t of rsItems) {
      if (t.cleanTemplateName === name) {
        this._ldat.copySettingsFrom(t);
        for (const om of this._outputModules) {
          om._updateOutputDimensions();
        }
        return;
      }
    }
    const names = rsItems.map((t) => t.cleanTemplateName);
    throw new ValueError(`Template ${repr(name)} not found. Available: ${repr(names)}`);
  }

  /** Remove this item from the render queue. */
  remove(): void {
    const rq = this._parentRq;
    const idx = indexByIdentity(rq._items, this);

    rq._rsLdat.items.splice(idx, 1);
    setLhd3Count(rq._rsLhd3, rq._rsLhd3.count - 1, LHD3_BLOCK_SINGLE);

    // AE stores a fixed block of Rout items per RQ item. Delete the whole
    // contiguous block (located by identity of its first entry) and refresh
    // the count, mirroring RenderQueue.add.
    const routStart = indexByIdentity(rq._rout.items, this._routItems[0]);
    rq._rout.items.splice(routStart, this._routItems.length);
    rq._rout.count = rq._rout.items.length;

    // RCom, list, LOm chunks removed from LItm by identity
    const chunks = this._litm.chunks;
    if (this._rcom != null) {
      chunks.splice(indexByIdentity(chunks, this._rcom), 1);
    }
    chunks.splice(indexByIdentity(chunks, this._listChunk), 1);
    chunks.splice(indexByIdentity(chunks, this._lom), 1);

    rq._items.splice(idx, 1);

    // Removing the last item empties the queue: clear the LSIf/ARsi
    // non-empty marker AE set (the inverse of RenderQueue.add). Verified
    // in AE 2026: it writes 0 here for an empty queue (and normalizes a
    // stale 1 back to 0 on save). The other ARsi state bytes are session
    // UI state with no fixed empty value, so they are left as-is.
    if (!rq._items?.length) {
      rq._arsi.queueNonempty = 0;
      // An empty queue's settings 'list' holds only an lhd3 (AE writes no
      // ldat). Re-hide the now-empty ldat so the written shape matches a
      // freshly-empty AE queue. add() flips it back on the next add.
      rq._rsLdat.synthetic = true;
    }
  }

  /**
   * Create a duplicate of this item in the render queue.
   *
   * Returns the new {@link RenderQueueItem}. If the original item's status is
   * `DONE` or `ERR_STOPPED`, the duplicate's status is set to `QUEUED`.
   */
  duplicate(): RenderQueueItem {
    const rq = this._parentRq;
    const idx = indexByIdentity(rq._items, this);

    const newRsi = deepcopy(this._ldat);

    // status holds the raw binary value (ExtendScript value minus 3013),
    // so compare and assign in that encoding via to_binary().
    const status = RQItemStatus.fromBinary(newRsi.status);
    if (status === RQItemStatus.DONE || status === RQItemStatus.ERR_STOPPED) {
      newRsi.status = RQItemStatus.toBinary(RQItemStatus.QUEUED);
    }
    newRsi.itemId = _nextItemId(rq);

    const newRoutItems = this._routItems.map((ri) => deepcopy(ri));

    const newListChunk = cloneChunkTree(this._listChunk);
    const newLom = cloneChunkTree(this._lom);

    let newRcom: ContainerChunk | null = null;
    let newRcomUtf8: Utf8Chunk | null = null;
    if (this._rcom != null) {
      newRcom = cloneChunkTree(this._rcom);
      if (newRcom.chunks?.length > 0) {
        newRcomUtf8 = newRcom.chunks[0] as Utf8Chunk;
      }
    }

    rq._rsLdat.items.splice(idx + 1, 0, newRsi);
    setLhd3Count(rq._rsLhd3, rq._rsLhd3.count + 1, LHD3_BLOCK_SINGLE);

    // Insert the duplicated Rout block right after this item's block
    // (located by identity of its first entry) and refresh the count.
    const routStart = indexByIdentity(rq._rout.items, this._routItems[0]);
    let insertAt = routStart + this._routItems.length;
    rq._rout.items.splice(insertAt, 0, ...newRoutItems);
    rq._rout.count = rq._rout.items.length;

    // Insert chunks into LItm after this item's chunks (by identity)
    const lomIdx = indexByIdentity(this._litm.chunks, this._lom);
    insertAt = lomIdx + 1;
    if (newRcom != null) {
      this._litm.chunks.splice(insertAt, 0, newRcom);
      insertAt += 1;
    }
    this._litm.chunks.splice(insertAt, 0, newListChunk);
    insertAt += 1;
    this._litm.chunks.splice(insertAt, 0, newLom);

    const newOmLdat = findByType(newListChunk.chunks, "ldat");
    const omGroups = splitOnType(newLom.chunks, "Roou");

    // Build model first (OMs need parent ref)
    const newItem = new RenderQueueItem({
      _ldat: newRsi,
      _litm: this._litm,
      _listChunk: newListChunk,
      _lom: newLom,
      _rcom: newRcom,
      _rcomUtf8: newRcomUtf8,
      _routItems: newRoutItems,
      parent: rq,
      comp: this._comp,
      outputModules: [],
    });

    const outputModules: OutputModule[] = [];
    for (const [i, omGroup] of omGroups.entries()) {
      const om = parseOutputModule(omGroup, newOmLdat.items[i], newItem);
      outputModules.push(om);
    }
    newItem._outputModules = outputModules;
    newItem._skipFrames = this._skipFrames;

    // Insert into model list after original
    rq._items.splice(idx + 1, 0, newItem);

    return newItem;
  }
}

// Field descriptors: each ChunkField assigned in the Python class body is installed on the
// prototype after the class, so the `declare`d fields above read and write through it.
descriptor(RenderQueueItem, "elapsedSeconds", new ChunkField("_ldat", "elapsedSeconds", { readOnly: true }));

descriptor(RenderQueueItem, "logType", ChunkField.enum(LogType, "_ldat", "logType"));

descriptor(RenderQueueItem, "name", new ChunkField("_ldat", "templateName"));

descriptor(
  RenderQueueItem,
  "queueItemNotify",
  ChunkField.bool("_ldat", "queueItemNotify", { minVersion: 22 }),
);

descriptor(
  RenderQueueItem,
  "startTime",
  new ChunkField("_ldat", "startTime", {
    transform: _startTimeFromBinary,
    readOnly: true,
  }),
);

descriptor(
  RenderQueueItem,
  "status",
  ChunkField.enum(RQItemStatus, "_ldat", "status", { postSet: "_onStatusChanged" }),
);

descriptor(RenderQueueItem, "_colorDepth", ChunkField.enum(ColorDepthSetting, "_ldat", "colorDepth"));

descriptor(RenderQueueItem, "_diskCache", ChunkField.enum(DiskCacheSetting, "_ldat", "diskCache"));

descriptor(RenderQueueItem, "_effects", ChunkField.enum(EffectsSetting, "_ldat", "effects"));

descriptor(RenderQueueItem, "_fieldRender", ChunkField.enum(FieldRender, "_ldat", "fieldRender"));

descriptor(RenderQueueItem, "_frameBlending", ChunkField.enum(FrameBlendingSetting, "_ldat", "frameBlending"));

descriptor(RenderQueueItem, "_guideLayers", ChunkField.enum(GuideLayers, "_ldat", "guideLayers"));

descriptor(RenderQueueItem, "_motionBlur", ChunkField.enum(MotionBlurSetting, "_ldat", "motionBlur"));

descriptor(RenderQueueItem, "_proxyUse", ChunkField.enum(ProxyUseSetting, "_ldat", "proxyUse"));

descriptor(RenderQueueItem, "_pulldown", ChunkField.enum(PulldownSetting, "_ldat", "pulldown"));

descriptor(RenderQueueItem, "_quality", ChunkField.enum(RenderQuality, "_ldat", "quality"));

descriptor(RenderQueueItem, "_skipExistingFiles", ChunkField.bool("_ldat", "skipExistingFiles"));

descriptor(RenderQueueItem, "_soloSwitches", ChunkField.enum(SoloSwitchesSetting, "_ldat", "soloSwitches"));

descriptor(RenderQueueItem, "_timeSpanSource", ChunkField.enum(TimeSpanSource, "_ldat", "timeSpanSource"));

descriptor(
  RenderQueueItem,
  "_frameRateSetting",
  ChunkField.enum(FrameRateSetting, "_ldat", "useThisFrameRate", {
    postSet: "_setOutputFrameRates",
  }),
);
