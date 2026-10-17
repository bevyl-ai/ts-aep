// Port of py_aep/models/renderqueue/render_queue_item.py

import { ColorDepthSetting, DiskCacheSetting, EffectsSetting, FieldRender, FrameBlendingSetting, FrameRateSetting, GetSettingsFormat, GuideLayers, LogType, MotionBlurSetting, ProxyUseSetting, PulldownSetting, RenderQuality, RQItemStatus, SoloSwitchesSetting, TimeSpanSource } from "../../enums/index.ts";
import { ContainerChunk, ListChunk } from "../../binary/chunk.ts";
import { LHD3_BLOCK_SINGLE, set_lhd3_count, type LdatChunk, type Lhd3Chunk } from "../../binary/ldat_chunks.ts";
import { build_om_container, build_rout_block, clone_chunk_tree } from "../../binary/mutations.ts";
import { RenderSettingsItem, type RoutItem } from "../../binary/render_chunks.ts";
import { Utf8Chunk } from "../../binary/scalar_chunks.ts";
import { find_by_type, index_by_identity, split_on_type } from "../../binary/utils.ts";
import { ChunkField } from "../descriptors.ts";
import type { CompItem } from "../items/composition.ts";
import type { Project } from "../project.ts";
import { _validate_number, validate_bool, validate_positive_int, validate_positive_number, validate_sequence, validate_string } from "../validators.ts";
import { SettingsView, type SettingsSpec, type SettingValue, type SettingValues, settings_to_number, settings_to_string } from "./settings.ts";
import type { RenderQueue } from "./render_queue.ts";
import {
  deepcopy,
  descriptor,
  float_repr,
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
import { parse_output_module } from "../../parsers/output_module.ts";

// NOTE(port): the epoch is a UTC `Date`; Python's naive datetime(1904, 1, 1) is the same wall-clock instant.
export const _AEP_EPOCH = new Date(Date.UTC(1904, 0, 1));

/** Convert Mac HFS+ epoch timestamp to datetime, or None if 0. */
export function _start_time_from_binary(value: number): Date | null {
  if (!value) return null;
  return new Date(_AEP_EPOCH.getTime() + value * 1000);
}

/**
 * The id AE gives a new render-queue item: the queue's highest + 1, and
 * 2 in an empty queue (AE 2026: ids 9 and 3 -\> an added item gets 10, a
 * duplicate after it 11).
 */
export function _next_item_id(rq: RenderQueue): number {
  return max(
    rq.items.map((item) => item._ldat.item_id),
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
  __setitem__(key: string, value: unknown): void {
    super.__setitem__(key, value);
    this._owner._ldat.settings_written = 1;
  }
}

/** The value each render setting reads as: its {@link RenderQueueItem} attribute's type. */
export type RenderSettingValues = SettingValues & {
  "3:2 Pulldown": RenderQueueItem["_pulldown"];
  "Color Depth": RenderQueueItem["_color_depth"];
  "Disk Cache": RenderQueueItem["_disk_cache"];
  "Effects": RenderQueueItem["_effects"];
  "Field Render": RenderQueueItem["_field_render"];
  "Frame Blending": RenderQueueItem["_frame_blending"];
  "Frame Rate": RenderQueueItem["_frame_rate_setting"];
  "Guide Layers": RenderQueueItem["_guide_layers"];
  "Motion Blur": RenderQueueItem["_motion_blur"];
  "Proxy Use": RenderQueueItem["_proxy_use"];
  "Quality": RenderQueueItem["_quality"];
  "Resolution": RenderQueueItem["_resolution"];
  "Skip Existing Files": RenderQueueItem["_skip_existing_files"];
  "Solo Switches": RenderQueueItem["_solo_switches"];
  "Time Span Duration": RenderQueueItem["time_span_duration"];
  "Time Span End": RenderQueueItem["time_span_end"];
  "Time Span Start": RenderQueueItem["time_span_start"];
  "Time Span": RenderQueueItem["_time_span_source"];
  "Use comp's frame rate": RenderQueueItem["_comp_frame_rate"];
  "Use this frame rate": RenderQueueItem["_use_this_frame_rate"];
};

// ---------------------------------------------------------------------------
// RENDER_SETTINGS: ExtendScript key -> (attribute, optional enum class)
// ---------------------------------------------------------------------------

export const RENDER_SETTINGS: SettingsSpec = new Map([
  ["3:2 Pulldown", ["_pulldown", PulldownSetting]],
  ["Color Depth", ["_color_depth", ColorDepthSetting]],
  ["Disk Cache", ["_disk_cache", DiskCacheSetting]],
  ["Effects", ["_effects", EffectsSetting]],
  ["Field Render", ["_field_render", FieldRender]],
  ["Frame Blending", ["_frame_blending", FrameBlendingSetting]],
  ["Frame Rate", ["_frame_rate_setting", FrameRateSetting]],
  ["Guide Layers", ["_guide_layers", GuideLayers]],
  ["Motion Blur", ["_motion_blur", MotionBlurSetting]],
  ["Proxy Use", ["_proxy_use", ProxyUseSetting]],
  ["Quality", ["_quality", RenderQuality]],
  ["Resolution", ["_resolution", null]],
  ["Skip Existing Files", ["_skip_existing_files", null]],
  ["Solo Switches", ["_solo_switches", SoloSwitchesSetting]],
  ["Time Span Duration", ["time_span_duration", null]],
  ["Time Span End", ["time_span_end", null]],
  ["Time Span Start", ["time_span_start", null]],
  ["Time Span", ["_time_span_source", TimeSpanSource]],
  ["Use comp's frame rate", ["_comp_frame_rate", null]],
  ["Use this frame rate", ["_use_this_frame_rate", null]],
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
 * const rq_item = app.project.render_queue.items[0];
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
  declare elapsed_seconds: number;

  /**
   * A log type for this item, indicating which events should be logged
   * while this item is being rendered. Read / Write.
   */
  declare log_type: LogType;

  /**
   * The name of the render settings template used for this item.
   * Read / Write.
   */
  declare name: string;

  /**
   * When `true`, a user notification is enabled for this render queue
   * item, signaling the user upon render completion. Read / Write.
   */
  declare queue_item_notify: boolean;

  /**
   * The date and time when rendering of this item started, or `null` if
   * the item has not started rendering. Read-only.
   */
  declare start_time: Date | null;

  /** The current render status of the item. Read / Write. */
  declare status: RQItemStatus;

  declare _color_depth: ColorDepthSetting;
  declare _disk_cache: DiskCacheSetting;
  declare _effects: EffectsSetting;
  declare _field_render: FieldRender;
  declare _frame_blending: FrameBlendingSetting;
  declare _guide_layers: GuideLayers;
  declare _motion_blur: MotionBlurSetting;
  declare _proxy_use: ProxyUseSetting;
  declare _pulldown: PulldownSetting;
  declare _quality: RenderQuality;
  declare _skip_existing_files: boolean;
  declare _solo_switches: SoloSwitchesSetting;
  declare _time_span_source: TimeSpanSource;
  declare _frame_rate_setting: FrameRateSetting;

  declare _ldat: RenderSettingsItem;
  declare _litm: ListChunk;
  declare _list_chunk: ListChunk;
  declare _lom: ListChunk;
  declare _rcom: ContainerChunk | null;
  declare _rcom_utf8: Utf8Chunk | null;
  declare _rout_items: RoutItem[];
  declare _parent_rq: RenderQueue;
  declare _comp: CompItem;
  declare _output_modules: OutputModule[];
  declare _skip_frames: number;

  constructor(kw: {
    _ldat: RenderSettingsItem;
    _litm: ListChunk;
    _list_chunk: ListChunk;
    _lom: ListChunk;
    _rcom?: ContainerChunk | null;
    _rcom_utf8?: Utf8Chunk | null;
    _rout_items: RoutItem[];
    parent: RenderQueue;
    comp: CompItem;
    output_modules: OutputModule[];
  }) {
    const {
      _ldat,
      _litm,
      _list_chunk,
      _lom,
      _rcom = null,
      _rcom_utf8 = null,
      _rout_items,
      parent,
      comp,
      output_modules,
    } = kw;
    this._ldat = _ldat;
    this._litm = _litm;
    this._list_chunk = _list_chunk;
    this._lom = _lom;
    this._rcom = _rcom;
    this._rcom_utf8 = _rcom_utf8;
    this._rout_items = _rout_items;
    this._parent_rq = parent;
    this._comp = comp;
    this._output_modules = output_modules;
    this._skip_frames = 0;
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
    const rs_item = new RenderSettingsItem({ comp_id: comp.id });
    // AE writes a fixed 30 in this "use this frame rate" slot for a fresh
    // item (the active setting is "use comp's frame rate", so it's an
    // unused placeholder); the real rate comes from the comp.
    rs_item.frame_rate_integer = 30;
    // Match a freshly-added AE item: status NEEDS_OUTPUT (no output file
    // yet) and time span = work area (the source stores zero dividend/
    // divisor; the span is derived from the comp's work area).
    rs_item.status = RQItemStatus.to_binary(RQItemStatus.NEEDS_OUTPUT);
    rs_item.time_span_source = int(TimeSpanSource.WORK_AREA_ONLY);
    rs_item.time_span_start_divisor = 0;
    rs_item.time_span_duration_divisor = 0;
    rs_item.item_id = _next_item_id(parent);

    // When ae_preferences_dir was supplied, overlay the user's configured
    // default render-settings template. Only _TEMPLATE_FIELDS are copied,
    // so status / time-span / reserved defaults above are preserved.
    if (project._ae_preferences_dir != null) {
      const templates = project._get_render_templates();
      const default_idx = project._default_render_template_index;
      if (default_idx != null && default_idx < templates.length) {
        rs_item.copy_settings_from(templates[default_idx]);
      }
    }

    const rqi = new this({
      _ldat: rs_item,
      _litm: parent._litm,
      _list_chunk: build_om_container(),
      _lom: new ListChunk({ list_type: "LOm ", chunks: [] }),
      _rcom: null,
      _rcom_utf8: null,
      _rout_items: build_rout_block(),
      parent,
      comp,
      output_modules: [],
    });

    rqi.add();

    return rqi;
  }

  /**
   * Add an output module to this render queue item.
   *
   * Creates a new {@link OutputModule} with default settings (or the
   * default template if `ae_preferences_dir` was passed to `parse()`).
   *
   * @returns The newly created {@link OutputModule}.
   */
  add(): OutputModule {
    const [om, lom_chunks] = OutputModule._new({
      render_settings_ldat: this._ldat,
      parent: this,
    });

    // A render queue item stores all its output modules in one LOm (split
    // by Roou) and one OM-metadata list. Keep the list's lhd3 capacity
    // counters in sync with the module count (block 1: _count_b /
    // _counter_a / _counter_b all equal `count`), or AE rejects the file
    // with "Invalid read length".
    this._lom.chunks.push(...lom_chunks);

    const om_ldat = find_by_type(this._list_chunk.chunks, "ldat");
    om_ldat.items.push(om._om_ldat);

    const om_lhd3 = find_by_type(this._list_chunk.chunks, "lhd3");
    set_lhd3_count(om_lhd3, om_lhd3.count + 1, LHD3_BLOCK_SINGLE);

    this._output_modules.push(om);
    return om;
  }

  /**
   * Allow iteration over Output Modules.
   *
   * Iterates a snapshot so modules can be removed while looping.
   */
  [Symbol.iterator](): Iterator<OutputModule> {
    return [...this.output_modules][Symbol.iterator]();
  }

  __repr__(): string {
    // Python's repr of an IntEnum member is `<RQItemStatus.X: n>` (members are plain numbers here).
    const status = this.status;
    const status_repr = RQItemStatus.has(status)
      ? `<RQItemStatus.${RQItemStatus.name_of(status)}: ${status}>`
      : repr(status);
    return `RenderQueueItem(name=${repr(this.name)}, status=${status_repr}, comp_name=${repr(this.comp_name)})`;
  }

  /** The composition that will be rendered by this render-queue item. Read-only. */
  get comp(): CompItem {
    return this._comp;
  }

  /** The list of Output Modules for the item. Read-only. */
  get output_modules(): OutputModule[] {
    return this._output_modules;
  }

  /** The {@link RenderQueue} containing this item. Read-only. */
  get parent(): RenderQueue {
    return this._parent_rq;
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
  _on_status_changed(): void {
    const status = this.status;
    if (this.constructor._RESET_STATUSES.has(status)) {
      this._ldat.start_time = 0;
      this._ldat.elapsed_seconds = 0;
    }
    if (status === RQItemStatus.NEEDS_OUTPUT || status === RQItemStatus.UNQUEUED) {
      this._ldat.render_checked = false;
    } else if (status !== RQItemStatus.WILL_CONTINUE) {
      this._ldat.render_checked = true;
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
    validate_bool(value);
    this.status = value ? RQItemStatus.QUEUED : RQItemStatus.UNQUEUED;
  }

  /**
   * A comment that describes the render queue item. This shows in the
   * Render Queue panel. Read / Write.
   */
  get comment(): string {
    if (this._rcom_utf8 == null) return "";
    return this._rcom_utf8.value;
  }

  set comment(value: string) {
    validate_string(value);
    if (this._rcom_utf8 != null) {
      this._rcom_utf8.value = value;
    } else if (value) {
      const utf8_chunk = new Utf8Chunk({ value });
      const rcom_chunk = new ContainerChunk({
        chunk_type: "RCom",
        chunks: [utf8_chunk],
      });
      const idx = this._litm.chunks.findIndex((c) => c === this._list_chunk);
      if (idx === -1) throw new StopIteration();
      this._litm.chunks.splice(idx, 0, rcom_chunk);
      this._rcom_utf8 = utf8_chunk;
      this._rcom = rcom_chunk;
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
  get skip_frames(): number {
    return this._skip_frames;
  }

  set skip_frames(value: number) {
    _validate_number({ min: 0, max: 99, integer: true })(value);
    this._skip_frames = value;
    this._set_output_frame_rates();
  }

  /** Store the output frame rate of every output module. */
  _set_output_frame_rates(): void {
    for (const om of this.output_modules) {
      om._set_frame_rate();
    }
  }

  /**
   * Return the number of output modules for this render queue item. Read-only.
   *
   * **Note:** Equivalent to `len(item.output_modules)`
   */
  get num_output_modules(): number {
    return this.output_modules.length;
  }

  /** Resolution as [x, y] divisors. */
  get _resolution(): number[] {
    return [this._ldat.resolution_x, this._ldat.resolution_y];
  }

  set _resolution(value: number[]) {
    // [0, 0] is a legal value meaning "Current Settings".
    validate_sequence({ length: 2, min: 0, max: 99, integer: true })(value);
    // A HALF-zero pair is not: zero is only meaningful as the both-axes
    // "Current Settings" sentinel. AE's own dialog can only ever produce
    // [0, 0] or a pair with both axes >= 1, and `setSettings` on a
    // half-zero pair NATIVE-CRASHES AE 2026 (probed: [0, 5] and [5, 0]
    // crash; [0, 0], [3, 7] and [99, 99] are all fine). py_aep has no
    // coherent reading for it either - `_effective_dimensions` degrades
    // the 0 to 1, silently rendering full width at a fraction of the
    // height.
    if ((value[0] === 0) !== (value[1] === 0)) {
      throw new ValueError(
        `Resolution divisors must both be zero ("Current Settings") ` +
          `or both be positive, got [${value[0]}, ${value[1]}]`,
      );
    }
    this._ldat.resolution_x = value[0];
    this._ldat.resolution_y = value[1];
    for (const om of this.output_modules) {
      om._update_output_dimensions();
    }
  }

  /** Custom frame rate value. */
  get _use_this_frame_rate(): number {
    return this._ldat.frame_rate;
  }

  set _use_this_frame_rate(value: number) {
    _validate_number({ min: 0.1, max: 999 })(value);
    this._ldat.frame_rate = value;
    this._set_output_frame_rates();
  }

  /** The composition's frame rate (read-only). */
  get _comp_frame_rate(): number {
    return this.comp.frame_rate;
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
   * const rqi = parse("project.aep").project.render_queue.items[0];
   * rqi.settings.__setitem__("Quality", RenderQuality.BEST);
   * ```
   *
   * @example
   */
  get settings(): SettingsView<RenderSettingValues> {
    return new _RenderSettingsView(this, RENDER_SETTINGS);
  }

  set settings(value: Map<string, unknown> | SettingsView) {
    if (!(value instanceof Map || value instanceof SettingsView)) {
      throw new ValueError("Settings must be a dictionary of key-value pairs");
    }
    const view = this.settings;
    // SettingsView exposes Python's Mapping `items()` as an array of pairs; a dict is a Map.
    const entries = value instanceof Map ? value.entries() : value.items();
    for (const [k, v] of entries) {
      view.__setitem__(k, v);
    }
  }

  /** Return (start, duration) in seconds based on time span source. */
  _resolved_time_span(): [number, number] {
    const source = TimeSpanSource.from_binary(this._ldat.time_span_source);
    if (source === TimeSpanSource.LENGTH_OF_COMP) {
      return [0.0, this.comp.duration];
    }
    if (source === TimeSpanSource.WORK_AREA_ONLY) {
      return [this.comp.work_area_start, this.comp.work_area_duration];
    }
    return [this._ldat.time_span_start, this._ldat.time_span_duration];
  }

  /** Return (start, duration) in frames based on time span source. */
  _resolved_time_span_frames(): [number, number] {
    const source = TimeSpanSource.from_binary(this._ldat.time_span_source);
    const fr = this.comp.frame_rate;
    if (source === TimeSpanSource.LENGTH_OF_COMP) {
      return [0, round(this.comp.duration * fr)];
    }
    if (source === TimeSpanSource.WORK_AREA_ONLY) {
      return [
        round(this.comp.work_area_start * fr),
        round(this.comp.work_area_duration * fr),
      ];
    }
    const [start_sec, dur_sec] = this._resolved_time_span();
    return [round(start_sec * fr), round(dur_sec * fr)];
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
   * @param is_frames - When True, `value` is a frame count and is converted to seconds via the
   *   composition frame rate before writing.
   * @throws {@link ValueError} If a start is negative, if either field would leave a duration
   *   shorter than one frame (AE's own scripting bound), or if a value does not fit the stored
   *   ratio.
   * @throws {@link TypeError} If the value is not a number.
   */
  _set_time_span(value: number, field: string, is_frames = false): void {
    const frame_duration = 1.0 / this.comp.frame_rate;
    // A signed 32-bit dividend over a divisor of at least 1.
    _validate_number({ min: 0.0, max: 2 ** 31 - 1 })(value);
    const seconds = is_frames ? value / this.comp.frame_rate : value;
    // Both fields resolve the span BEFORE switching the source to
    // CUSTOM: a WORK_AREA_ONLY / LENGTH_OF_COMP item takes its span
    // from the comp, so CUSTOM has to carry the resolved values over
    // or the untouched field silently jumps to a stale ldat value.
    const [old_start, old_duration] = this._resolved_time_span();
    let new_start: number;
    let new_duration: number;
    if (field === "duration") {
      if (seconds < frame_duration - 1e-9) {
        throw new ValueError(
          `Duration must be at least one frame ` +
            `(${format(frame_duration, ".6g")}s), got ${float_repr(seconds)}`,
        );
      }
      new_start = old_start;
      new_duration = seconds;
    } else {
      const custom = this._time_span_source === TimeSpanSource.CUSTOM;
      new_start = seconds;
      new_duration = custom ? old_duration : old_start + old_duration - seconds;
      if (new_duration <= 0) {
        throw new ValueError(
          `Start time ${float_repr(seconds)} is at or past the span end ` +
            `(${float_repr(old_start + old_duration)})`,
        );
      }
      // The same one-frame floor the duration path enforces: reaching it
      // through the start must not be a back door to a degenerate span.
      if (new_duration < frame_duration - 1e-9) {
        throw new ValueError(
          `Start time ${float_repr(seconds)} leaves a duration shorter than one ` +
            `frame (${format(frame_duration, ".6g")}s), got ${float_repr(new_duration)}`,
        );
      }
    }
    this._ldat.time_span_source = int(TimeSpanSource.CUSTOM);
    this._ldat.time_span_start = new_start;
    this._ldat.time_span_duration = new_duration;
  }

  /**
   * The time in the composition, in seconds, at which rendering will
   * begin. Read / Write.
   *
   * Setting this keeps the span END fixed - the duration is
   * recomputed - and switches the time span source to CUSTOM.
   */
  get time_span_start(): number {
    return this._resolved_time_span()[0];
  }

  set time_span_start(value: number) {
    this._set_time_span(value, "start");
  }

  /**
   * The duration in seconds of the composition to be rendered. The
   * duration is determined by subtracting the start time from the end
   * time. Read / Write.
   *
   * Setting this switches the time span source to CUSTOM.
   */
  get time_span_duration(): number {
    return this._resolved_time_span()[1];
  }

  set time_span_duration(value: number) {
    this._set_time_span(value, "duration");
  }

  /**
   * The time in the composition, in frames, at which rendering will
   * begin. Read / Write.
   *
   * Setting this keeps the span END fixed - the duration is
   * recomputed - and switches the time span source to CUSTOM.
   */
  get time_span_start_frame(): number {
    return this._resolved_time_span_frames()[0];
  }

  set time_span_start_frame(value: number) {
    this._set_time_span(value, "start", true);
  }

  /**
   * The duration in frames of the composition to be rendered. The
   * duration is determined by subtracting the start time from the end
   * time. Read / Write.
   *
   * Setting this switches the time span source to CUSTOM.
   */
  get time_span_duration_frames(): number {
    return this._resolved_time_span_frames()[1];
  }

  set time_span_duration_frames(value: number) {
    this._set_time_span(value, "duration", true);
  }

  /**
   * The time in the composition, in seconds, at which rendering will
   * end. Read / Write.
   *
   * Setting this adjusts the duration, keeping the start unchanged,
   * and switches the time span source to CUSTOM.
   */
  get time_span_end(): number {
    const [ts_start, ts_duration] = this._resolved_time_span();
    return ts_start + ts_duration;
  }

  set time_span_end(value: number) {
    validate_positive_number(value);
    this.time_span_duration = value - this.time_span_start;
  }

  /**
   * The time in the composition, in frames, at which rendering will
   * end. Read / Write.
   *
   * Setting this adjusts the duration in frames, keeping the start
   * unchanged, and switches the time span source to CUSTOM.
   */
  get time_span_end_frame(): number {
    return this.time_span_start_frame + this.time_span_duration_frames;
  }

  set time_span_end_frame(value: number) {
    validate_positive_int(value);
    this.time_span_duration_frames = value - this.time_span_start_frame;
  }

  /** The name of the composition being rendered. */
  get comp_name(): string {
    return this.comp.name;
  }

  /**
   * Return render settings in the specified format.
   *
   * @param format_ - The output format. `GetSettingsFormat.NUMBER` returns numeric values (enums
   *   unwrapped to ints). `GetSettingsFormat.STRING` returns all values as strings
   */
  get_settings(format_: GetSettingsFormat = GetSettingsFormat.STRING): Map<string, SettingValue> {
    if (format_ === GetSettingsFormat.STRING) {
      return settings_to_string(this.settings);
    }
    if (format_ === GetSettingsFormat.NUMBER) {
      return settings_to_number(this.settings);
    }
    // Python's repr of an IntEnum member is `<GetSettingsFormat.X: n>` (members are plain numbers here).
    const format_repr = GetSettingsFormat.has(format_)
      ? `<GetSettingsFormat.${GetSettingsFormat.name_of(format_)}: ${format_}>`
      : repr(format_);
    throw new ValueError(`Unsupported format: ${format_repr}`);
  }

  /**
   * Return a single render setting in the specified format.
   *
   * @param key - The setting key (e.g. `"Quality"`, `"Frame Rate"`).
   * @param format_ - The output format.
   */
  get_setting(key: string, format_: GetSettingsFormat = GetSettingsFormat.STRING): SettingValue {
    return getitem(this.get_settings(format_), key);
  }

  /**
   * Available render settings template names.
   *
   * Requires `ae_preferences_dir` to have been passed to `parse()`.
   * Returns an empty list if no preferences directory was provided.
   */
  get templates(): string[] {
    try {
      return this._project._get_render_templates().map((t) => t.clean_template_name);
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
      return [];
    }
  }

  /**
   * Apply a render settings template by name.
   *
   * Looks up the template from the AE preferences data (requires
   * `ae_preferences_dir` in `parse()`) and copies its settings to
   * this render queue item.
   *
   * @param name - Template name (e.g. `"Best Settings"`, `"Draft Settings"`).
   * @throws {@link ValueError} If the template name is not found.
   */
  apply_template(name: string): void {
    const rs_items = this._project._get_render_templates();
    for (const t of rs_items) {
      if (t.clean_template_name === name) {
        this._ldat.copy_settings_from(t);
        for (const om of this._output_modules) {
          om._update_output_dimensions();
        }
        return;
      }
    }
    const names = rs_items.map((t) => t.clean_template_name);
    throw new ValueError(`Template ${repr(name)} not found. Available: ${repr(names)}`);
  }

  /** Remove this item from the render queue. */
  remove(): void {
    const rq = this._parent_rq;
    const idx = index_by_identity(rq._items, this);

    rq._rs_ldat.items.splice(idx, 1);
    set_lhd3_count(rq._rs_lhd3, rq._rs_lhd3.count - 1, LHD3_BLOCK_SINGLE);

    // AE stores a fixed block of Rout items per RQ item. Delete the whole
    // contiguous block (located by identity of its first entry) and refresh
    // the count, mirroring RenderQueue.add.
    const rout_start = index_by_identity(rq._rout.items, this._rout_items[0]);
    rq._rout.items.splice(rout_start, this._rout_items.length);
    rq._rout.count = rq._rout.items.length;

    // RCom, list, LOm chunks removed from LItm by identity
    const chunks = this._litm.chunks;
    if (this._rcom != null) {
      chunks.splice(index_by_identity(chunks, this._rcom), 1);
    }
    chunks.splice(index_by_identity(chunks, this._list_chunk), 1);
    chunks.splice(index_by_identity(chunks, this._lom), 1);

    rq._items.splice(idx, 1);

    // Removing the last item empties the queue: clear the LSIf/ARsi
    // non-empty marker AE set (the inverse of RenderQueue.add). Verified
    // in AE 2026: it writes 0 here for an empty queue (and normalizes a
    // stale 1 back to 0 on save). The other ARsi state bytes are session
    // UI state with no fixed empty value, so they are left as-is.
    if (!rq._items?.length) {
      rq._arsi.queue_nonempty = 0;
      // An empty queue's settings 'list' holds only an lhd3 (AE writes no
      // ldat). Re-hide the now-empty ldat so the written shape matches a
      // freshly-empty AE queue. add() flips it back on the next add.
      rq._rs_ldat.synthetic = true;
    }
  }

  /**
   * Create a duplicate of this item in the render queue.
   *
   * Returns the new {@link RenderQueueItem}. If the original item's status is
   * `DONE` or `ERR_STOPPED`, the duplicate's status is set to `QUEUED`.
   */
  duplicate(): RenderQueueItem {
    const rq = this._parent_rq;
    const idx = index_by_identity(rq._items, this);

    const new_rsi = deepcopy(this._ldat);

    // status holds the raw binary value (ExtendScript value minus 3013),
    // so compare and assign in that encoding via to_binary().
    const status = RQItemStatus.from_binary(new_rsi.status);
    if (status === RQItemStatus.DONE || status === RQItemStatus.ERR_STOPPED) {
      new_rsi.status = RQItemStatus.to_binary(RQItemStatus.QUEUED);
    }
    new_rsi.item_id = _next_item_id(rq);

    const new_rout_items = this._rout_items.map((ri) => deepcopy(ri));

    const new_list_chunk = clone_chunk_tree(this._list_chunk);
    const new_lom = clone_chunk_tree(this._lom);

    let new_rcom: ContainerChunk | null = null;
    let new_rcom_utf8: Utf8Chunk | null = null;
    if (this._rcom != null) {
      new_rcom = clone_chunk_tree(this._rcom);
      if (new_rcom.chunks?.length > 0) {
        new_rcom_utf8 = new_rcom.chunks[0] as Utf8Chunk;
      }
    }

    rq._rs_ldat.items.splice(idx + 1, 0, new_rsi);
    set_lhd3_count(rq._rs_lhd3, rq._rs_lhd3.count + 1, LHD3_BLOCK_SINGLE);

    // Insert the duplicated Rout block right after this item's block
    // (located by identity of its first entry) and refresh the count.
    const rout_start = index_by_identity(rq._rout.items, this._rout_items[0]);
    let insert_at = rout_start + this._rout_items.length;
    rq._rout.items.splice(insert_at, 0, ...new_rout_items);
    rq._rout.count = rq._rout.items.length;

    // Insert chunks into LItm after this item's chunks (by identity)
    const lom_idx = index_by_identity(this._litm.chunks, this._lom);
    insert_at = lom_idx + 1;
    if (new_rcom != null) {
      this._litm.chunks.splice(insert_at, 0, new_rcom);
      insert_at += 1;
    }
    this._litm.chunks.splice(insert_at, 0, new_list_chunk);
    insert_at += 1;
    this._litm.chunks.splice(insert_at, 0, new_lom);

    const new_om_ldat = find_by_type(new_list_chunk.chunks, "ldat");
    const om_groups = split_on_type(new_lom.chunks, "Roou");

    // Build model first (OMs need parent ref)
    const new_item = new RenderQueueItem({
      _ldat: new_rsi,
      _litm: this._litm,
      _list_chunk: new_list_chunk,
      _lom: new_lom,
      _rcom: new_rcom,
      _rcom_utf8: new_rcom_utf8,
      _rout_items: new_rout_items,
      parent: rq,
      comp: this._comp,
      output_modules: [],
    });

    const output_modules: OutputModule[] = [];
    for (const [i, om_group] of om_groups.entries()) {
      const om = parse_output_module(om_group, new_om_ldat.items[i], new_item);
      output_modules.push(om);
    }
    new_item._output_modules = output_modules;
    new_item._skip_frames = this._skip_frames;

    // Insert into model list after original
    rq._items.splice(idx + 1, 0, new_item);

    return new_item;
  }
}

// Field descriptors: each ChunkField assigned in the Python class body is installed on the
// prototype after the class, so the `declare`d fields above read and write through it.
descriptor(RenderQueueItem, "elapsed_seconds", new ChunkField("_ldat", "elapsed_seconds", { read_only: true }));

descriptor(RenderQueueItem, "log_type", ChunkField.enum(LogType, "_ldat", "log_type"));

descriptor(RenderQueueItem, "name", new ChunkField("_ldat", "template_name"));

descriptor(
  RenderQueueItem,
  "queue_item_notify",
  ChunkField.bool("_ldat", "queue_item_notify", { min_version: 22 }),
);

descriptor(
  RenderQueueItem,
  "start_time",
  new ChunkField("_ldat", "start_time", {
    transform: _start_time_from_binary,
    read_only: true,
  }),
);

descriptor(
  RenderQueueItem,
  "status",
  ChunkField.enum(RQItemStatus, "_ldat", "status", { post_set: "_on_status_changed" }),
);

descriptor(RenderQueueItem, "_color_depth", ChunkField.enum(ColorDepthSetting, "_ldat", "color_depth"));

descriptor(RenderQueueItem, "_disk_cache", ChunkField.enum(DiskCacheSetting, "_ldat", "disk_cache"));

descriptor(RenderQueueItem, "_effects", ChunkField.enum(EffectsSetting, "_ldat", "effects"));

descriptor(RenderQueueItem, "_field_render", ChunkField.enum(FieldRender, "_ldat", "field_render"));

descriptor(RenderQueueItem, "_frame_blending", ChunkField.enum(FrameBlendingSetting, "_ldat", "frame_blending"));

descriptor(RenderQueueItem, "_guide_layers", ChunkField.enum(GuideLayers, "_ldat", "guide_layers"));

descriptor(RenderQueueItem, "_motion_blur", ChunkField.enum(MotionBlurSetting, "_ldat", "motion_blur"));

descriptor(RenderQueueItem, "_proxy_use", ChunkField.enum(ProxyUseSetting, "_ldat", "proxy_use"));

descriptor(RenderQueueItem, "_pulldown", ChunkField.enum(PulldownSetting, "_ldat", "pulldown"));

descriptor(RenderQueueItem, "_quality", ChunkField.enum(RenderQuality, "_ldat", "quality"));

descriptor(RenderQueueItem, "_skip_existing_files", ChunkField.bool("_ldat", "skip_existing_files"));

descriptor(RenderQueueItem, "_solo_switches", ChunkField.enum(SoloSwitchesSetting, "_ldat", "solo_switches"));

descriptor(RenderQueueItem, "_time_span_source", ChunkField.enum(TimeSpanSource, "_ldat", "time_span_source"));

descriptor(
  RenderQueueItem,
  "_frame_rate_setting",
  ChunkField.enum(FrameRateSetting, "_ldat", "use_this_frame_rate", {
    post_set: "_set_output_frame_rates",
  }),
);
