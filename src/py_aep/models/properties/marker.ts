import { ValueError, descriptor, round, py_or } from "../../../pyrt/index.ts";
import { Label } from "../../enums/index.ts";

import { NmhdChunk } from "../../binary/misc_chunks.ts";
import { Utf8Chunk } from "../../binary/scalar_chunks.ts";
import { index_by_identity } from "../../binary/utils.ts";
import { ChunkField } from "../descriptors.ts";
import { validate_int, validate_marker_duration, validate_string, validate_u4 } from "../validators.ts";

import type { ListChunk } from "../../binary/chunk.ts";
import type { Keyframe } from "./keyframe.ts";

export function _validate_params(value: Map<string, string>): void {
  if (!(value instanceof Map)) {
    throw new ValueError("params must be a dictionary of string key-value pairs");
  }
  for (const [key, val] of value) {
    if (typeof key !== "string" || typeof val !== "string") {
      throw new ValueError("params must be a dictionary of string key-value pairs");
    }
  }
}

/**
 * The `MarkerValue` object represents a layer or composition marker, which
 * associates a comment, and optionally a chapter reference point, Web-page
 * link, or Flash Video cue point with a particular point in a layer.
 *
 * @example
 * ```ts
 * import { parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const comp = app.project.compositions[0];
 * const marker = comp.markers[0];
 * console.log(marker.comment);
 * ```
 * @see https://ae-scripting.docsforadobe.dev/other/markervalue/
 */
export class MarkerValue {
  declare _nmhd: NmhdChunk;
  declare _comment_utf8: Utf8Chunk;
  declare _chapter_utf8: Utf8Chunk;
  declare _url_utf8: Utf8Chunk;
  declare _frame_target_utf8: Utf8Chunk;
  declare _cue_point_name_utf8: Utf8Chunk;
  declare _keyframe: Keyframe | null;
  declare _nmrd: ListChunk | null;
  declare _frame_time: number;
  declare _param_utf8s: Utf8Chunk[];

  declare duration: number;
  declare label: Label;
  declare navigation: boolean;
  declare protected_region: boolean;
  declare comment: string;
  declare chapter: string;
  declare url: string;
  declare frame_target: string;
  declare cue_point_name: string;

  constructor(
    comment: string = "",
    chapter: string = "",
    url: string = "",
    frame_target: string = "",
    cue_point_name: string = "",
    params: Map<string, string> | null = null,
  ) {
    for (const arg of [comment, chapter, url, frame_target, cue_point_name]) {
      validate_string(arg);
    }
    if (params != null) _validate_params(params);
    this._nmhd = new NmhdChunk();
    this._comment_utf8 = new Utf8Chunk({ value: comment });
    this._chapter_utf8 = new Utf8Chunk({ value: chapter });
    this._url_utf8 = new Utf8Chunk({ value: url });
    this._frame_target_utf8 = new Utf8Chunk({ value: frame_target });
    this._cue_point_name_utf8 = new Utf8Chunk({ value: cue_point_name });
    this._keyframe = null;
    this._nmrd = null;
    this._frame_time = 0;
    this._param_utf8s = [];
    if (params != null && params.size > 0) {
      for (const [key, val] of params) {
        this._param_utf8s.push(new Utf8Chunk({ value: key }));
        this._param_utf8s.push(new Utf8Chunk({ value: val }));
      }
      this._nmhd.num_params = params.size;
    }
  }

  /** Wrap parsed marker chunks as a `MarkerValue`. */
  static _from_binary(kw: {
    _nmhd: NmhdChunk;
    _comment_utf8: Utf8Chunk;
    _chapter_utf8: Utf8Chunk;
    _url_utf8: Utf8Chunk;
    _frame_target_utf8: Utf8Chunk;
    _cue_point_name_utf8: Utf8Chunk;
    _keyframe?: Keyframe | null;
    frame_time?: number;
    _param_utf8s?: Utf8Chunk[] | null;
    _nmrd?: ListChunk | null;
  }): MarkerValue {
    const {
      _nmhd,
      _comment_utf8,
      _chapter_utf8,
      _url_utf8,
      _frame_target_utf8,
      _cue_point_name_utf8,
      _keyframe = null,
      frame_time = 0,
      _param_utf8s = null,
      _nmrd = null,
    } = kw;
    // `cls.__new__(cls)`: skip the constructor, the chunks are supplied.
    const obj: MarkerValue = Object.create(this.prototype);
    obj._nmhd = _nmhd;
    obj._comment_utf8 = _comment_utf8;
    obj._chapter_utf8 = _chapter_utf8;
    obj._url_utf8 = _url_utf8;
    obj._frame_target_utf8 = _frame_target_utf8;
    obj._cue_point_name_utf8 = _cue_point_name_utf8;
    obj._keyframe = _keyframe;
    obj._nmrd = _nmrd;
    obj._frame_time = frame_time;
    obj._param_utf8s = py_or(_param_utf8s, []);
    return obj;
  }

  /** Key-value pairs for Flash Video cue-point parameters. Read / Write. */
  get params(): Map<string, string> {
    const result = new Map<string, string>();
    for (let i = 0; i < this._param_utf8s.length - 1; i += 2) {
      const key = this._param_utf8s[i].value;
      const val = this._param_utf8s[i + 1].value;
      result.set(key, val);
    }
    return result;
  }

  set params(value: Map<string, string>) {
    _validate_params(value);
    const old = this._param_utf8s;
    const new_: Utf8Chunk[] = [];
    for (const [i, [key, val]] of [...value].entries()) {
      if (2 * i + 1 < old.length) {
        // Reuse existing chunk pairs in place (keeps tree position).
        old[2 * i].value = key;
        old[2 * i + 1].value = val;
        new_.push(old[2 * i], old[2 * i + 1]);
      } else {
        new_.push(new Utf8Chunk({ value: key }), new Utf8Chunk({ value: val }));
      }
    }
    const removed = old.slice(new_.length);
    const added = new_.slice(old.length);
    if (this._nmrd != null && (removed.length > 0 || added.length > 0)) {
      // Splice grown / shrunk pairs into the backing Nmrd list.
      const chunks = this._nmrd.chunks;
      for (const chunk of removed) {
        try {
          chunks.splice(index_by_identity(chunks, chunk), 1);
        } catch (e) {
          if (!(e instanceof ValueError)) throw e;
        }
      }
      if (added.length > 0) {
        const kept = new_.slice(0, new_.length - added.length);
        const anchor = kept.length > 0 ? kept[kept.length - 1] :this._cue_point_name_utf8;
        let pos: number;
        try {
          pos = index_by_identity(chunks, anchor);
        } catch (e) {
          if (!(e instanceof ValueError)) throw e;
          pos = chunks.length - 1;
        }
        chunks.splice(pos + 1, 0, ...added);
      }
    }
    this._param_utf8s = new_;
    this._nmhd.num_params = value.size;
  }

  /** The time of the marker, in frames. */
  get frame_time(): number {
    if (this._keyframe != null) {
      return this._keyframe.frame_time;
    }
    return this._frame_time;
  }

  set frame_time(value: number) {
    validate_int(value);
    if (this._keyframe != null) {
      this._keyframe.frame_time = value;
    } else {
      this._frame_time = value;
    }
  }

  /**
   * The marker's duration, in frames of its composition. Read / Write.
   *
   * @throws {@link ValueError} If the marker is not set on a marker property yet, so it has no
   *   composition frame rate.
   */
  get frame_duration(): number {
    return round(this.duration * this._frame_rate());
  }

  set frame_duration(value: number) {
    validate_u4(value);
    this.duration = value / this._frame_rate();
  }

  _frame_rate(): number {
    if (this._keyframe == null) {
      throw new ValueError(
        "frame_duration needs the composition frame rate: set the " +
          "MarkerValue on a marker property first",
      );
    }
    return this._keyframe._frame_rate;
  }

  /**
   * When `true`, the FlashVideo cue point is for an event; otherwise, it is
   * for navigation.
   */
  get event_cue_point(): boolean {
    return !this.navigation;
  }
}

/** The marker's duration, in seconds. Read / Write. */
descriptor(MarkerValue, "duration", new ChunkField("_nmhd", "duration_seconds", { validate: validate_marker_duration }));

/**
 * The label color. Colors are represented by their number (0 for None, or 1
 * to 16 for one of the preset colors in the Labels preferences).
 * Read / Write.
 */
descriptor(MarkerValue, "label", ChunkField.enum(Label, "_nmhd", "label"));

/** Whether the marker is a navigation marker. Read / Write. */
descriptor(MarkerValue, "navigation", ChunkField.bool("_nmhd", "navigation"));

/**
 * State of the Protected Region option in the Composition Marker dialog box.
 * When `true`, the composition marker behaves as a protected region. Will
 * also return `true` for protected region markers on nested composition
 * layers, but is otherwise not applicable to layer markers. Read / Write.
 */
descriptor(MarkerValue, "protected_region", ChunkField.bool("_nmhd", "protected_region"));

/**
 * A text comment for this marker. This comment appears in the Timeline panel
 * next to the layer marker. Read / Write.
 */
descriptor(MarkerValue, "comment", new ChunkField("_comment_utf8", "value"));

/**
 * A text chapter link for this marker. Chapter links initiate a jump to a
 * chapter in a QuickTime movie or in other formats that support chapter
 * marks. Read / Write.
 */
descriptor(MarkerValue, "chapter", new ChunkField("_chapter_utf8", "value"));

/** A URL for this marker. This URL is an automatic link to a Web page. Read / Write. */
descriptor(MarkerValue, "url", new ChunkField("_url_utf8", "value"));

/**
 * A text frame target for this marker. Together with the URL value, this
 * targets a specific frame within a Web page. Read / Write.
 */
descriptor(MarkerValue, "frame_target", new ChunkField("_frame_target_utf8", "value"));

/** The Flash Video cue point name, as shown in the Marker dialog box. Read / Write. */
descriptor(MarkerValue, "cue_point_name", new ChunkField("_cue_point_name_utf8", "value"));
