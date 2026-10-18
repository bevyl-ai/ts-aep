// Python: src/py_aep/models/items/av_item.py (`from __future__ import annotations`: dropped)

import type { ListChunk } from "../../binary/chunk.ts";
import { buildPinList } from "../../binary/mutations.ts";
import type { CmtaChunk, IdtaChunk } from "../../binary/item_chunks.ts";
import type { Utf8Chunk } from "../../binary/scalar_chunks.ts";
import { findByListType, findByType, indexByIdentity } from "../../binary/utils.ts";
import { ChunkField } from "../descriptors.ts";
import { autoName } from "../naming.ts";
import { defaultSequenceFps } from "../preferences.ts";
import { validateBool } from "../validators.ts";
import { Item } from "./item.ts";
import {
  AttributeError,
  ValueError,
  descriptor,
  int,
  pyAssert,
  type PathLike,
  type ClassAttributes,
} from "../../../pyrt/index.ts";
import type { Project } from "../project.ts";
import type { Viewer } from "../viewer/viewer.ts";
import type { CompItem } from "./composition.ts";
import type { FolderItem } from "./folder.ts";
import { FileSource } from "../sources/file.ts";
import { PlaceholderSource } from "../sources/placeholder.ts";
import { SolidSource } from "../sources/solid.ts";

// NOTE(port): CPython `set` iteration order. `Item.__hash__` is `hash(self.id)`, so
// `set[CompItem]` iterates in open-addressing table order (deterministic, not insertion
// order). This emulates the 3.12 table (linear probes 9, perturb 5, resize at fill*5 >= mask*3)
// for the add / discard / iterate surface that `AVItem._used_in` uses. Exact for ids in
// [0, 2^31) (AE item ids); a generic pyrt set shim would supersede it.
export class _IdHashSet<T extends { id: number }> {
  private _keys: (T | null)[] = new Array(8).fill(null);
  private _hashes: number[] = new Array(8).fill(0); // -1 = dummy
  private _mask = 7;
  private _fill = 0;
  private _used = 0;

  get size(): number {
    return this._used;
  }

  private _lookup(item: T): number {
    const hash = item.id;
    let i = hash & this._mask;
    let perturb = hash;
    for (;;) {
      const probes = i + 9 <= this._mask ? 9 : 0;
      for (let k = 0; k <= probes; k++) {
        const j = i + k;
        const key = this._keys[j];
        if (key == null && this._hashes[j] === 0) return -1;
        if (key != null && this._hashes[j] === hash && key.id === item.id) return j;
      }
      perturb >>>= 5;
      i = (i * 5 + 1 + perturb) & this._mask;
    }
  }

  has(item: T): boolean {
    return this._lookup(item) >= 0;
  }

  add(item: T): this {
    if (this._lookup(item) >= 0) return this;
    const hash = item.id;
    let i = hash & this._mask;
    let perturb = hash;
    let freeslot = -1;
    for (;;) {
      const probes = i + 9 <= this._mask ? 9 : 0;
      for (let k = 0; k <= probes; k++) {
        const j = i + k;
        if (this._keys[j] == null && this._hashes[j] === -1) freeslot = j;
        if (this._keys[j] == null && this._hashes[j] === 0) {
          if (freeslot >= 0) {
            this._keys[freeslot] = item;
            this._hashes[freeslot] = hash;
            this._used++;
            return this;
          }
          this._keys[j] = item;
          this._hashes[j] = hash;
          this._fill++;
          this._used++;
          if (this._fill * 5 >= this._mask * 3) {
            this._resize(this._used > 50000 ? this._used * 2 : this._used * 4);
          }
          return this;
        }
      }
      perturb >>>= 5;
      i = (i * 5 + 1 + perturb) & this._mask;
    }
  }

  delete(item: T): boolean {
    const j = this._lookup(item);
    if (j < 0) return false;
    this._keys[j] = null;
    this._hashes[j] = -1;
    this._used--;
    return true;
  }

  private _resize(minused: number): void {
    let newsize = 8;
    while (newsize <= minused) newsize <<= 1;
    const oldKeys = this._keys;
    const oldHashes = this._hashes;
    this._keys = new Array(newsize).fill(null);
    this._hashes = new Array(newsize).fill(0);
    this._mask = newsize - 1;
    this._fill = this._used;
    for (let n = 0; n < oldKeys.length; n++) {
      const key = oldKeys[n];
      if (key == null) continue;
      const hash = oldHashes[n];
      let i = hash & this._mask;
      let perturb = hash;
      placed: for (;;) {
        const probes = i + 9 <= this._mask ? 9 : 0;
        for (let k = 0; k <= probes; k++) {
          const j = i + k;
          if (this._keys[j] == null) {
            this._keys[j] = key;
            this._hashes[j] = hash;
            break placed;
          }
        }
        perturb >>>= 5;
        i = (i * 5 + 1 + perturb) & this._mask;
      }
    }
  }

  *[Symbol.iterator](): IterableIterator<T> {
    for (const key of this._keys) if (key != null) yield key;
  }
}

export function _validateUseProxy(value: boolean, obj: AVItem): void {
  validateBool(value);
  if (obj.proxySource == null && value) {
    throw new AttributeError(
      "Cannot set useProxy to true when there is no proxy source.",
    );
  }
}

export function _syncProxyActive(obj: AVItem): void {
  // idta 0x38 records that a proxy is assigned, not that it is in use:
  // AE 2026 keeps 1 after `useProxy = false` and writes 0 only on
  // `setProxyToNone()` (as in sample proxy.aep's `proxy_disabled` items).
  pyAssert(obj._idta != null);
  obj._idta._proxyActive = int(obj._proxySource != null);
  obj._syncModifiedTime();
}

/**
 * The `AVItem` object provides access to attributes and methods of
 * audio/visual files imported into After Effects.
 *
 * Info:
 * `AVItem` is a subclass of {@link Item}. All methods and attributes of {@link Item}
 * are available when working with `AVItem`.
 *
 * Info:
 * `AVItem` is the base class for both {@link CompItem} and {@link FootageItem}, so
 * `AVItem` attributes and methods are also available when working with
 * {@link CompItem} and {@link FootageItem} objects. See {@link CompItem} object and
 * {@link FootageItem} object.
 *
 * @see https://ae-scripting.docsforadobe.dev/item/avitem/
 */
// Annotation-only attributes of AVItem.duration/frame_duration/frame_rate (interface merge so subclasses may override them with accessors).
export interface AVItem {
  duration: number;
  frameDuration: number;
  frameRate: number;
  height: number;
  pixelAspect: number;
  width: number;
}
export class AVItem extends Item {
  declare ["constructor"]: ClassAttributes<typeof AVItem>;
  // Python: annotation-only attributes, with `"""…"""` attribute docstrings.
  // NOTE(port): subclasses (composition.ts, footage.ts) override some of these with accessors;
  // `declare` emits no runtime field, so the prototype accessors apply and tsc reports no TS2610.

  /** The duration of the item in seconds. Still footages have a duration of 0. Read-only for a `FootageItem`, otherwise Read / Write. */

  /** The duration of the item in frames. Still footages have a duration of 0. Read-only for a `FootageItem`, otherwise Read / Write. */

  /** The frame rate of the item in frames-per-second. Read-only for a `FootageItem`, otherwise Read / Write. */

  /** The height of the item in pixels. Read / Write. */
  /** The pixel aspect ratio of the item (1.0 is square). Read / Write. */
  /** The width of the item in pixels. Read / Write. */
  declare _pinChunks: ListChunk[];
  declare _proxySource: FileSource | SolidSource | PlaceholderSource | null;
  declare _usedIn: _IdHashSet<CompItem>;
  declare _viewer: Viewer | null;

  /**
   * When `true`, a proxy is used for the item. Read / Write.
   *
   * It is set to `true` by all the `setProxy` methods, and to `false` by
   * the `setProxyToNone()` method.
   */
  declare useProxy: boolean;

  constructor(kw: {
    _idta: IdtaChunk;
    _nameUtf8: Utf8Chunk;
    _cmta: CmtaChunk | null;
    _itemList: ListChunk;
    _gide: ListChunk | null;
    _pinChunks: ListChunk[];
    project: Project;
    parentFolder: FolderItem;
    typeName: string;
    proxySource: FileSource | SolidSource | PlaceholderSource | null;
  }) {
    super({
      _idta: kw._idta,
      _nameUtf8: kw._nameUtf8,
      _cmta: kw._cmta,
      _itemList: kw._itemList,
      _gide: kw._gide,
      project: kw.project,
      parentFolder: kw.parentFolder,
      typeName: kw.typeName,
    });
    this._pinChunks = kw._pinChunks;
    this._proxySource = kw.proxySource;
    if (kw.proxySource != null) {
      kw.proxySource._project = kw.project;
    }
    this._usedIn = new _IdHashSet<CompItem>();
    this._viewer = null;
  }

  /** Remove this AV item, its referencing layers, and viewer. */
  remove(): void {
    const itemId = this.id;
    for (const comp of this.usedIn) {
      for (const layer of [...comp.avLayers]) {
        if (layer._sourceId === itemId) {
          layer.remove();
        }
      }
    }
    if (this._viewer != null) {
      pyAssert(this._parentFolder != null);
      // NOTE(port): Python `list.remove` uses `==`; `Viewer` defines no `__eq__` (viewer.py), so identity matches.
      const idx = this._parentFolder._viewers.indexOf(this._viewer);
      if (idx < 0) {
        throw new ValueError("list.remove(x): x not in list");
      }
      this._parentFolder._viewers.splice(idx, 1);
      this._viewer = null;
    }
    super.remove();
  }

  /**
   * The {@link FootageSource} being used as a proxy. Read-only.
   *
   * To change it, call any of the `AVItem` methods that change the proxy
   * source: `setProxy()`, `setProxyWithSequence()`,
   * `setProxyWithSolid()`, or `setProxyWithPlaceholder()`.
   */
  get proxySource(): FileSource | SolidSource | PlaceholderSource | null {
    return this._proxySource;
  }

  /**
   * When `true`, the AVItem has an audio component.
   *
   * In a {@link CompItem}, the value is linked to the composition.
   * In a {@link FootageItem | FootageItem},
   * the value is linked to the `mainSource` or `proxySource` object.
   */
  get hasAudio(): boolean {
    return false;
  }

  /**
   * `true` if the item has a video component.
   *
   * An AVItem has video when it has non-zero dimensions (`width > 0`
   * and `height > 0`). In a {@link CompItem}, the value is always `true`.
   * In a {@link FootageItem | FootageItem},
   * the value depends on the footage source (e.g. audio-only files
   * return `false`).
   */
  get hasVideo(): boolean {
    return this.width > 0 && this.height > 0;
  }

  /**
   * When `true`, the AVItem is a placeholder, or represents footage
   * with a source file that could not be found when the project was last
   * saved. Read-only.
   *
   * Always `false` for a {@link CompItem}; a
   * {@link FootageItem | FootageItem} reports the
   * state of its `mainSource` (see the `FootageItem` override).
   */
  get footageMissing(): boolean {
    return false;
  }

  /**
   * `true` if the item can be used as an alternate source when setting
   * {@link Property.alternateSource | Property.alternateSource}.
   * Read-only.
   *
   * A {@link CompItem} or a {@link FootageItem | FootageItem}
   * with a video component can be used as an alternate source; see the
   * `FootageItem` override for footage restrictions.
   */
  get isMediaReplacementCompatible(): boolean {
    return this.hasVideo;
  }

  /**
   * The current time of the item when it is being previewed directly
   * from the Project panel. This value is a number of seconds. It is an
   * error to set this value for a {@link FootageItem} whose `mainSource` or
   * `proxySource` is still.
   */
  get time(): number {
    return 0.0;
  }

  /**
   * The current time of the item when it is being previewed directly
   * from the Project panel. This value is a number of frames.
   */
  get frameTime(): number {
    return 0;
  }

  /** All the compositions that use this AVItem. */
  get usedIn(): CompItem[] {
    this._project._ensureUsedInLinked();
    return [...this._usedIn];
  }

  /**
   * Index of the proxy `LIST:Pin` within `_pinChunks`.
   *
   * Footage items carry a main-source pin at index 0 and the proxy at
   * index 1; composition items have no main-source pin, so the proxy
   * lives at index 0. Overridden by {@link CompItem}.
   */
  get _proxyPinIndex(): number {
    return 1;
  }

  /**
   * Keep the `idta` time stamp in step with the source in use.
   *
   * Overridden by {@link FootageItem}. A comp's stamp is the time of its
   * last edit (measured on AE 2026, also with a proxy in use), which
   * py_aep does not track.
   */
  _syncModifiedTime(): void {}

  /** Remove the proxy source from this item. */
  setProxyToNone(): void {
    if (this._proxySource) {
      const proxyPin = this._pinChunks[this._proxyPinIndex];
      this._itemList.chunks.splice(
        indexByIdentity(this._itemList.chunks, proxyPin),
        1,
      );
      this._pinChunks.splice(this._proxyPinIndex, 1);
      this._proxySource = null;
    }
    this.useProxy = false;
  }

  /**
   * Set a placeholder as the proxy source.
   *
   * @param name - The placeholder name. `null` becomes `Missing Name`. An empty string becomes
   *   `Placeholder`.
   * @param width - Width in pixels (4-30000).
   * @param height - Height in pixels (4-30000).
   * @param frameRate - Frame rate in fps (1.0-99.0).
   * @param duration - Duration in seconds (\> 0, \<= 10800).
   */
  setProxyWithPlaceholder(
    name: string | null,
    width: number,
    height: number,
    frameRate: number,
    duration: number,
  ): void {
    if (name == null) {
      name = "Missing Name";
    } else if (name === "") {
      name = "Placeholder";
    }

    const source = PlaceholderSource._new(name, width, height, frameRate, duration);
    this._setProxy(source);
  }

  /**
   * Set a solid as the proxy source.
   *
   * @param color - Solid color as [R, G, B] in 0.0-1.0 range.
   * @param name - The solid name. Pass `null` to auto-generate a name from the color (e.g.
   *   `Red Solid 1`). An empty string becomes `????`.
   * @param width - Width in pixels (1-30000).
   * @param height - Height in pixels (1-30000).
   * @param pixelAspect - Pixel aspect ratio (0.01-100.0).
   */
  setProxyWithSolid(
    color: number[],
    name: string | null,
    width: number,
    height: number,
    pixelAspect: number = 1.0,
  ): void {
    if (name == null) {
      const existing = new Set([...this._project.items.values()].map((item) => item.name));
      const solidName = SolidSource._colorName(color[0], color[1], color[2]);
      name = autoName(solidName, existing);
    } else if (name === "") {
      name = "????";
    }

    const source = SolidSource._new(name, color, width, height, pixelAspect);
    this._setProxy(source);
  }

  /**
   * Sets a file as the proxy of this AVItem.
   *
   * Loads the specified file into a new `FileSource` object, sets this as the value
   * of the `proxySource` attribute, and sets `useProxy` to true.
   *
   * It does not preserve the interpretation parameters, instead using the user
   * preferences.
   *
   * This differs from setting a `FootageItem`'s `mainSource`, but both actions are
   * performed as in the user interface.
   *
   * **Note:** Unlike ExtendScript, if the specified file has an unlabeled alpha channel,
   * this method does not estimate the alpha interpretation.
   *
   * @param file - Path to the proxy source file.
   * @throws {@link ValueError} If the extension is not a supported footage format.
   * @throws {@link NotImplementedError} If After Effects requires a format-specific `opti` header
   *   not implemented for this format.
   */
  setProxy(file: PathLike): void {
    this._setProxy(FileSource._fromFile(file, { windows: this._project._windows }));
  }

  /**
   * Sets a sequence of files as the proxy of this `AVItem`, with the option of
   * forcing alphabetical order. Loads the specified file sequence into a new
   * `FileSource` object, sets this as the value of the `proxySource` attribute, and
   * sets `useProxy` to true.
   *
   * It does not preserve the interpretation parameters, instead using the user
   * preferences.
   *
   * **Note:** Unlike ExtendScript, if the specified file has an unlabeled alpha channel,
   * this method does not estimate the alpha interpretation.
   *
   * @param file - Path to a representative frame; sibling frames in the same folder are gathered
   *   into the sequence.
   * @param forceAlphabetical - Take every file of the same type in the folder, in alphabetical
   *   order, rather than the numbered frames (see `ImportOptions.forceAlphabetical`).
   * @throws {@link ValueError} If the extension is not a supported footage format, or one After
   *   Effects does not import as a sequence (movies, audio, HEIC, FBX, data files).
   * @throws {@link NotImplementedError} If After Effects requires a format-specific `opti` header
   *   not implemented for this format.
   */
  setProxyWithSequence(
    file: PathLike,
    forceAlphabetical: boolean = false,
  ): void {
    this._setProxy(
      FileSource._fromFile(file, {
        sequence: true,
        forceAlphabetical: forceAlphabetical,
        windows: this._project._windows,
        defaultSequenceFps: defaultSequenceFps(this._project._preferences),
      }),
    );
  }

  /**
   * Return the `LIST:Pin` for a footage source.
   *
   * A `FileSource` already carries its complete Pin (with the Als2 path
   * and any sequence prefix/ext); solid/placeholder sources are built
   * from sspc+opti.
   */
  static _pinForSource(
    source: FileSource | SolidSource | PlaceholderSource,
  ): ListChunk {
    if (source instanceof FileSource) {
      return source._pin;
    }
    const pin = buildPinList(source._sspc, source._opti, {
      isSolid: source instanceof SolidSource,
    });
    // Link the source to its color record, as parsing does, so the
    // version fit and the color-management setters reach it.
    source._clrs = findByListType(pin.chunks, "CLRS");
    source._linl = findByType(source._clrs.chunks, "linl");
    return pin;
  }

  /** Replace or append a LIST:Pin chunk at the given index. */
  _replacePin(pinIndex: number, newPin: ListChunk): void {
    if (pinIndex < this._pinChunks.length) {
      const oldPin = this._pinChunks[pinIndex];
      const idx = indexByIdentity(this._itemList.chunks, oldPin);
      this._itemList.chunks[idx] = newPin;
      this._pinChunks[pinIndex] = newPin;
    } else {
      this._itemList.chunks.push(newPin);
      this._pinChunks.push(newPin);
    }
  }

  /** Set a proxy LIST:Pin chunk (add or replace). */
  _setProxy(source: FileSource | SolidSource | PlaceholderSource): void {
    this._replacePin(
      this._proxyPinIndex,
      this.constructor._pinForSource(source),
    );
    this._proxySource = source;
    source._joinProject(this._project);
    this.useProxy = true;
  }
}

descriptor(
  AVItem,
  "useProxy",
  ChunkField.bool("_idta", "useProxy", {
    validate: _validateUseProxy,
    postSet: _syncProxyActive,
  }),
);
