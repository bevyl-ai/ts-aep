import { ValueError, descriptor } from "../../../pyrt/index.ts";
import { Label } from "../../enums/index.ts";

import { NmhdChunk } from "../../binary/misc_chunks.ts";
import { Utf8Chunk } from "../../binary/scalar_chunks.ts";
import { indexByIdentity } from "../../binary/utils.ts";
import { ChunkField } from "../descriptors.ts";
import { validateInt, validateMarkerDuration, validateString, validateU4 } from "../validators.ts";

import type { ListChunk } from "../../binary/chunk.ts";
import type { Keyframe } from "./keyframe.ts";

function _validateParams(value: Map<string, string>): void {
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
  declare _commentUtf8: Utf8Chunk;
  declare _chapterUtf8: Utf8Chunk;
  declare _urlUtf8: Utf8Chunk;
  declare _frameTargetUtf8: Utf8Chunk;
  declare _cuePointNameUtf8: Utf8Chunk;
  declare _keyframe: Keyframe | null;
  declare _nmrd: ListChunk | null;
  declare _frameTime: number;
  declare _paramUtf8s: Utf8Chunk[];

  /** The marker's duration, in seconds. Read / Write. */
  declare duration: number;
  /**
   * The label color. Colors are represented by their number (0 for None, or 1
   * to 16 for one of the preset colors in the Labels preferences).
   * Read / Write.
   */
  declare label: Label;
  /** Whether the marker is a navigation marker. Read / Write. */
  declare navigation: boolean;
  /**
   * State of the Protected Region option in the Composition Marker dialog box.
   * When `true`, the composition marker behaves as a protected region. Will
   * also return `true` for protected region markers on nested composition
   * layers, but is otherwise not applicable to layer markers. Read / Write.
   */
  declare protectedRegion: boolean;
  /**
   * A text comment for this marker. This comment appears in the Timeline panel
   * next to the layer marker. Read / Write.
   */
  declare comment: string;
  /**
   * A text chapter link for this marker. Chapter links initiate a jump to a
   * chapter in a QuickTime movie or in other formats that support chapter
   * marks. Read / Write.
   */
  declare chapter: string;
  /** A URL for this marker. This URL is an automatic link to a Web page. Read / Write. */
  declare url: string;
  /**
   * A text frame target for this marker. Together with the URL value, this
   * targets a specific frame within a Web page. Read / Write.
   */
  declare frameTarget: string;
  /** The Flash Video cue point name, as shown in the Marker dialog box. Read / Write. */
  declare cuePointName: string;

  constructor(
    comment: string = "",
    chapter: string = "",
    url: string = "",
    frameTarget: string = "",
    cuePointName: string = "",
    params: Map<string, string> | null = null,
  ) {
    for (const arg of [comment, chapter, url, frameTarget, cuePointName]) {
      validateString(arg);
    }
    if (params != null) _validateParams(params);
    this._nmhd = new NmhdChunk();
    this._commentUtf8 = new Utf8Chunk({ value: comment });
    this._chapterUtf8 = new Utf8Chunk({ value: chapter });
    this._urlUtf8 = new Utf8Chunk({ value: url });
    this._frameTargetUtf8 = new Utf8Chunk({ value: frameTarget });
    this._cuePointNameUtf8 = new Utf8Chunk({ value: cuePointName });
    this._keyframe = null;
    this._nmrd = null;
    this._frameTime = 0;
    this._paramUtf8s = [];
    if (params != null && params.size > 0) {
      for (const [key, val] of params) {
        this._paramUtf8s.push(new Utf8Chunk({ value: key }));
        this._paramUtf8s.push(new Utf8Chunk({ value: val }));
      }
      this._nmhd.numParams = params.size;
    }
  }

  /** Wrap parsed marker chunks as a `MarkerValue`. */
  static _fromBinary(kw: {
    _nmhd: NmhdChunk;
    _commentUtf8: Utf8Chunk;
    _chapterUtf8: Utf8Chunk;
    _urlUtf8: Utf8Chunk;
    _frameTargetUtf8: Utf8Chunk;
    _cuePointNameUtf8: Utf8Chunk;
    _keyframe?: Keyframe | null;
    frameTime?: number;
    _paramUtf8s?: Utf8Chunk[] | null;
    _nmrd?: ListChunk | null;
  }): MarkerValue {
    const {
      _nmhd,
      _commentUtf8,
      _chapterUtf8,
      _urlUtf8,
      _frameTargetUtf8,
      _cuePointNameUtf8,
      _keyframe = null,
      frameTime = 0,
      _paramUtf8s = null,
      _nmrd = null,
    } = kw;
    // `cls.__new__(cls)`: skip the constructor, the chunks are supplied.
    const obj: MarkerValue = Object.create(this.prototype);
    obj._nmhd = _nmhd;
    obj._commentUtf8 = _commentUtf8;
    obj._chapterUtf8 = _chapterUtf8;
    obj._urlUtf8 = _urlUtf8;
    obj._frameTargetUtf8 = _frameTargetUtf8;
    obj._cuePointNameUtf8 = _cuePointNameUtf8;
    obj._keyframe = _keyframe;
    obj._nmrd = _nmrd;
    obj._frameTime = frameTime;
    obj._paramUtf8s = _paramUtf8s ?? [];
    return obj;
  }

  /** Key-value pairs for Flash Video cue-point parameters. Read / Write. */
  get params(): Map<string, string> {
    const result = new Map<string, string>();
    for (let i = 0; i < this._paramUtf8s.length - 1; i += 2) {
      const key = this._paramUtf8s[i].value;
      const val = this._paramUtf8s[i + 1].value;
      result.set(key, val);
    }
    return result;
  }

  set params(value: Map<string, string>) {
    _validateParams(value);
    const old = this._paramUtf8s;
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
          chunks.splice(indexByIdentity(chunks, chunk), 1);
        } catch (e) {
          if (!(e instanceof ValueError)) throw e;
        }
      }
      if (added.length > 0) {
        const kept = new_.slice(0, new_.length - added.length);
        const anchor = kept.length > 0 ? kept[kept.length - 1] : this._cuePointNameUtf8;
        let pos: number;
        try {
          pos = indexByIdentity(chunks, anchor);
        } catch (e) {
          if (!(e instanceof ValueError)) throw e;
          pos = chunks.length - 1;
        }
        chunks.splice(pos + 1, 0, ...added);
      }
    }
    this._paramUtf8s = new_;
    this._nmhd.numParams = value.size;
  }

  /** The time of the marker, in frames. */
  get frameTime(): number {
    if (this._keyframe != null) {
      return this._keyframe.frameTime;
    }
    return this._frameTime;
  }

  set frameTime(value: number) {
    validateInt(value);
    if (this._keyframe != null) {
      this._keyframe.frameTime = value;
    } else {
      this._frameTime = value;
    }
  }

  /**
   * The marker's duration, in frames of its composition. Read / Write.
   *
   * @throws {@link ValueError} If the marker is not set on a marker property yet, so it has no
   *   composition frame rate.
   */
  get frameDuration(): number {
    return Math.round(this.duration * this._frameRate()) + 0;
  }

  set frameDuration(value: number) {
    validateU4(value);
    this.duration = value / this._frameRate();
  }

  private _frameRate(): number {
    if (this._keyframe == null) {
      throw new ValueError(
        "frameDuration needs the composition frame rate: set the " + "MarkerValue on a marker property first",
      );
    }
    return this._keyframe._frameRate;
  }

  /**
   * When `true`, the FlashVideo cue point is for an event; otherwise, it is
   * for navigation.
   */
  get eventCuePoint(): boolean {
    return !this.navigation;
  }

  static {
    descriptor(this, "duration", new ChunkField("_nmhd", "durationSeconds", { validate: validateMarkerDuration }));
    descriptor(this, "label", ChunkField.enum(Label, "_nmhd", "label"));
    descriptor(this, "navigation", ChunkField.bool("_nmhd", "navigation"));
    descriptor(this, "protectedRegion", ChunkField.bool("_nmhd", "protectedRegion"));
    descriptor(this, "comment", new ChunkField("_commentUtf8", "value"));
    descriptor(this, "chapter", new ChunkField("_chapterUtf8", "value"));
    descriptor(this, "url", new ChunkField("_urlUtf8", "value"));
    descriptor(this, "frameTarget", new ChunkField("_frameTargetUtf8", "value"));
    descriptor(this, "cuePointName", new ChunkField("_cuePointNameUtf8", "value"));
  }
}
