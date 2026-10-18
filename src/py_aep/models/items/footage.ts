// Python: src/py_aep/models/items/footage.py (`from __future__ import annotations`: dropped)

import { ListChunk, type Chunk } from "../../binary/chunk.ts";
import { buildItemViewChunks } from "../../binary/comp_skeleton.ts";
import { IdtaChunk, type CmtaChunk } from "../../binary/item_chunks.ts";
import { FtgiChunk } from "../../binary/misc_chunks.ts";
import { buildGideList, buildItemIdChunks } from "../../binary/mutations.ts";
import { Utf8Chunk } from "../../binary/scalar_chunks.ts";
import { AI_COMP_EXTENSIONS, PSD_COMP_EXTENSIONS } from "../../data/file_formats.ts";
import { layerIndexForStored } from "../../resolvers/source_layers.ts";
import { CURRENT_VALUE, _CurrentValue } from "../import_options.ts";
import { autoName } from "../naming.ts";
import { defaultSequenceFps, labelIndex } from "../preferences.ts";
import { FileSource } from "../sources/file.ts";
import { PlaceholderSource } from "../sources/placeholder.ts";
import { SolidSource } from "../sources/solid.ts";
import { validateName, validateOneOf, validatePixelAspect, validatePositiveInt } from "../validators.ts";
import { AVItem } from "./av_item.ts";
import {
  Path,
  ValueError,
  assert,
  literal,
  sorted,
  tkey,
  type PathLike,
} from "../../../pyrt/index.ts";
import type { Project } from "../project.ts";
import type { FolderItem } from "./folder.ts";

/**
 * The `FootageItem` object represents a footage item imported into a project,
 * which appears in the Project panel.
 *
 * ```ts
 * import { parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const footage = app.project.footages[0];
 * console.log(footage.mainSource);
 * ```
 *
 * Info:
 * `FootageItem` is a subclass of {@link AVItem} object, which is a subclass of
 * {@link Item} object. All methods and attributes of {@link AVItem} and {@link Item} are
 * available when working with `FootageItem`.
 *
 * @example
 * @see https://ae-scripting.docsforadobe.dev/item/footageitem/
 */
export class FootageItem extends AVItem {
  declare _mainSource: FileSource | SolidSource | PlaceholderSource;
  declare _viewData: Chunk[];
  // Set in the constructor from the source's resolved name; declared here because the base class does not own it.
  declare _name: string;

  /** The width of the item in pixels. Read-only. */
  get width(): number {
    return this._mainSource._width;
  }

  /** The height of the item in pixels. Read-only. */
  get height(): number {
    return this._mainSource._height;
  }

  /**
   * The duration of the item in seconds. Still footages have a duration
   * of 0. Read-only.
   */
  get duration(): number {
    return this._mainSource._duration;
  }

  /** The frame rate of the item in frames-per-second. Read-only. */
  get frameRate(): number {
    return this._mainSource.displayFrameRate;
  }

  /**
   * The duration of the item in frames. Still footages have a duration
   * of 0. Read-only.
   */
  get frameDuration(): number {
    return this._mainSource._frameDuration;
  }

  /**
   * The pixel aspect ratio of the item (1.0 is square). Read / Write.
   *
   * **Note:** 
   * Unlike After Effects, which snaps a written value to the nearest
   * preset ratio (1.09 becomes the 1.0940 of D1/DV PAL), the value
   * is stored as given.
   */
  get pixelAspect(): number {
    return this._mainSource._pixelAspect;
  }

  set pixelAspect(value: number) {
    validatePixelAspect(value);
    this._mainSource._sspc.pixelAspect = value;
  }

  /**
   * When `true`, the AVItem is a placeholder, or represents footage with a
   * source file that could not be found when the project was last saved.
   *
   * In this case, the path of the missing source file is in the
   * `missingFootagePath` attribute of the footage item's source-file object.
   * See {@link FootageItem.mainSource} and
   * {@link FileSource.missingFootagePath | FileSource.missingFootagePath}.
   * Read-only.
   */
  get footageMissing(): boolean {
    return this._mainSource._footageMissing;
  }

  /**
   * When `true`, the footage has an audio component.
   *
   * When {@link AVItem.useProxy | use_proxy} is
   * `true`, reflects the proxy source rather than the main source.
   * Read-only.
   */
  get hasAudio(): boolean {
    if (this.useProxy && this._proxySource != null) {
      return this._proxySource._hasAudio;
    }
    return this._mainSource._hasAudio;
  }

  /**
   * `true` if the footage can be used as an alternate source when setting
   * {@link Property.alternateSource | Property.alternateSource}.
   * Read-only.
   *
   * `false` for solids, for footage without a video component (audio-only
   * or data files), and for 3D model scenes (AE 2026 reports an imported
   * `.fbx` as incompatible even though it has video).
   */
  get isMediaReplacementCompatible(): boolean {
    const source = this._mainSource;
    if (source instanceof SolidSource) {
      return false;
    }
    if (source instanceof FileSource && source._is3dModelScene) {
      return false;
    }
    return this.hasVideo;
  }

  /** The footage start frame. Read-only. */
  get startFrame(): number {
    return this._mainSource._startFrame;
  }

  /** The footage end frame. Read-only. */
  get endFrame(): number {
    return this._mainSource._endFrame;
  }

  constructor(kw: {
    _idta: IdtaChunk;
    _nameUtf8: Utf8Chunk;
    _cmta: CmtaChunk | null;
    _itemList: ListChunk;
    _gide: ListChunk | null;
    _pinChunks: ListChunk[];
    project: Project;
    parentFolder: FolderItem;
    mainSource: FileSource | SolidSource | PlaceholderSource;
    proxySource: FileSource | SolidSource | PlaceholderSource | null;
  }) {
    const {
      _idta,
      _nameUtf8,
      _cmta,
      _itemList,
      _gide,
      _pinChunks,
      project,
      parentFolder,
      mainSource,
      proxySource,
    } = kw;
    super({
      _idta,
      _nameUtf8,
      _cmta,
      _itemList,
      _gide,
      _pinChunks,
      project,
      parentFolder,
      typeName: "Footage",
      proxySource,
    });
    this._mainSource = mainSource;
    mainSource._project = project;
    this._viewData = [];
    // Cache the resolved display name rather than mutating the binary
    // Utf8 chunk, which for a solid or placeholder AE leaves empty.
    this._name = mainSource._resolveName(_nameUtf8.value);
  }

  /**
   * The name of the item, as shown in the Project panel.
   * Read / Write.
   */
  get name(): string {
    return this._name;
  }

  set name(value: string) {
    validateName(value);
    // A footage item always carries a Utf8 name chunk (see parse_item).
    assert(this._nameUtf8 != null);
    // The display name has to be written where `_resolveName` reads it
    // back from. AE keeps a solid's or placeholder's name in the source
    // `opti` chunk and leaves the item-level Utf8 empty; only file
    // footage is named through the item chunk.
    if (this._mainSource.constructor._ownsName) {
      this._mainSource._storeName(value);
      this._nameUtf8.value = "";
    } else {
      this._nameUtf8.value = value;
    }
    this._name = value;
  }

  /** The footage source. Read-only. */
  get mainSource(): FileSource | SolidSource | PlaceholderSource {
    return this._mainSource;
  }

  /** The footage type (placeholder, solid, file). Read-only. */
  get assetType(): string {
    const mainSource: object | null = this._mainSource;
    if (mainSource instanceof SolidSource) {
      return "solid";
    } else if (mainSource instanceof FileSource) {
      return "file";
    } else if (mainSource instanceof PlaceholderSource) {
      return "placeholder";
    } else {
      // TODO(port): Python formats `type(src)` as `<class 'py_aep.<module>.<Name>'>`; JS has no module path, so only the bare class name is printed. Affects only this unreachable-in-practice error message.
      throw new TypeError(
        `Unexpected source type for ${this.name}: ${mainSource?.constructor?.name}`,
      );
    }
  }

  /** The footage file path if its source is a {@link FileSource}, else `null`. */
  get file(): string | null {
    if (this._mainSource instanceof FileSource) {
      return this._mainSource.file;
    }
    return null;
  }

  /**
   * Identity used by {@link Project.consolidateFootage}.
   *
   * Returns a hashable key for footage that can be merged with other
   * footage sharing the same source file and interpretation, or `null`
   * for sources that are always unique (solids, placeholders).
   *
   * The Python tuple is returned as a `tkey(...)` string because the
   * caller uses it as a Map/Set key.
   */
  _consolidationKey(): string | null {
    const source = this._mainSource;
    if (!(source instanceof FileSource)) {
      return null;
    }
    const attrs = source.fileAttributes;
    return tkey(
      source.file,
      [...source.fileNames],
      source.alphaMode,
      source.invertAlpha,
      [...source.premulColor],
      source.fieldSeparationType,
      source.removePulldown,
      source.loop,
      source.conformFrameRate,
      source.highQualityFieldSeparation,
      source.interpretAsLinearLight,
      source.isStill,
      source.nativeFrameRate,
      source.mediaColorSpace,
      attrs?.size > 0 ? sorted(Array.from(attrs.entries())) : [],
    );
  }

  /**
   * Create a new FootageItem with backing chunks.
   *
   * The item name resolves from the source; like AE, the item-level
   * Utf8 chunk stays empty until the user renames the item.
   *
   * source: The footage source (file, placeholder, or solid).
   * project: The project that owns this item.
   * parent_folder: The folder that will contain this item.
   */
  static _new(
    source: FileSource | PlaceholderSource | SolidSource,
    kw: { project: Project; parentFolder: FolderItem },
  ): FootageItem {
    const { project, parentFolder } = kw;
    const itemId = project._allocateId();

    // AE labels footage items by kind (probed in AE 2026): solids use
    // "Solid Label Index 2" (factory 1), audio-only files "Audio Label
    // Index 2" (7), stills "Still Label Index 2" (5), and video files,
    // sequences, and placeholders "Video Label Index 2" (3).
    let label: number;
    if (source instanceof SolidSource) {
      label = labelIndex(project._preferences, "Solid Label Index 2", 1);
    } else if (source instanceof FileSource && source._hasAudio && source._width === 0) {
      label = labelIndex(project._preferences, "Audio Label Index 2", 7);
    } else if (source instanceof FileSource && source.isStill) {
      label = labelIndex(project._preferences, "Still Label Index 2", 5);
    } else {
      label = labelIndex(project._preferences, "Video Label Index 2", 3);
    }

    const idta = new IdtaChunk({
      itemType: 7,
      itemId,
      label,
    });
    idta.isFootage = true;
    idta.isSolid = source instanceof SolidSource;
    // A file source carries the footage-kind flags; solid/placeholder
    // sources keep the chunk default.
    if (source instanceof FileSource) {
      idta._flags17 = source._idtaFlags17();
    }
    // AE leaves the item-level Utf8 empty; the display name resolves
    // from the source (solid / placeholder / file name).
    const nameUtf8 = new Utf8Chunk({});

    const pinList = AVItem._pinForSource(source);

    const ftgi = new FtgiChunk({});

    const itemList = new ListChunk({
      listType: "Item",
      chunks: [
        ...buildItemIdChunks(itemId, project._head.aeVersionMajor),
        idta,
        nameUtf8,
        pinList,
        ftgi,
        new Utf8Chunk({}),
      ],
    });

    // View data chunks AE expects after LIST:Item in the parent folder
    const viewData: Chunk[] = buildItemViewChunks();

    const item = new this({
      _idta: idta,
      _nameUtf8: nameUtf8,
      _cmta: null,
      _itemList: itemList,
      _gide: null,
      _pinChunks: [pinList],
      project,
      parentFolder,
      mainSource: source,
      proxySource: null,
    });
    source._joinProject(project);
    // AE writes the guide list with no `ldat` until a guide is added.
    [item._gide, item._lhd3, item._inner] = buildGideList();
    item._itemList.chunks.push(item._gide);
    item._viewData = viewData;
    item._syncModifiedTime();
    return item;
  }

  _syncModifiedTime(): void {
    // AE 2026 stamps idta with the last-modified time of the file in use
    // - the proxy's while a file proxy is in use, the main file's
    // otherwise - on import, replace, reload and every proxy change. A
    // solid or placeholder in use leaves the stamp as it is: AE does the
    // same for a placeholder, and writes the time of the edit for a
    // solid, which would make py_aep's output depend on when it ran.
    // AE replaces an unset (0) stamp with the save time without
    // re-reading the media, so leaving one is harmless.
    const source = this.useProxy ? this._proxySource : this._mainSource;
    if (source instanceof FileSource) {
      assert(this._idta != null);
      this._idta.modifiedTime = source._sspc.sourceModified;
    }
  }

  /**
   * Replace the footage source with a placeholder.
   *
   * name: The placeholder name. Pass `null` to use
   * `Missing Name`. An empty string becomes `Placeholder`.
   * width: Width in pixels (4-30000).
   * height: Height in pixels (4-30000).
   * frame_rate: Frame rate in fps (1.0-99.0).
   * duration: Duration in seconds (\> 0, \<= 10800).
   */
  replaceWithPlaceholder(
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
    this._replaceMainSource(source);
  }

  /**
   * Replace the footage source with a solid.
   *
   * color: Solid color as [R, G, B] in 0.0-1.0 range.
   * name: The solid name. Pass `null` to auto-generate
   * a name from the color (e.g. `Red Solid 1`).
   * An empty string becomes `????`.
   * width: Width in pixels (1-30000).
   * height: Height in pixels (1-30000).
   * pixel_aspect: Pixel aspect ratio (0.01-100.0).
   */
  replaceWithSolid(
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
    this._replaceMainSource(source);
  }

  /**
   * Replace the footage source with a file on disk.
   *
   * Changes the source of this `FootageItem` to the specified file.
   *
   * In addition to loading the file, the method creates a new `FileSource` object
   * for the file and sets `mainSource` to that object. In the new source object, it
   * sets the name, width, height, `frameDuration`, and duration attributes (see
   * `AVItem` object) based on the contents of the file.
   *
   * The method preserves interpretation parameters from the previous `mainSource`
   * object.
   *
   * py_aep extension: `layerIndex` binds the new source to a single
   * layer of a layered file, by `listLayers` position (see
   * `ImportOptions.layerIndex`). `null` (the default) always replaces
   * with the merged/whole document, even when the current source references a
   * single layer - consistent with `importFile`, where `layer_index=None`
   * imports merged. Pass `CURRENT_VALUE` to rebind at the current source's
   * stored layer index (the `sspc` layer index: PSD record index / AI document
   * index) in the new file.
   *
   * `layerDimensions` chooses the footage dimensions when a layer is
   * selected (see `ImportOptions.layerDimensions`): `"document"` (the
   * full canvas) or `"layer"` (the layer's content box). `CURRENT_VALUE`
   * (the default) preserves the current single-layer binding's choice.
   * For an AI/PDF target the content box is the artwork box measured from
   * the page content stream (see
   * {@link py_aep.resolvers.ai_bounds.read_ai_layer_bounds | read_ai_layer_bounds}).
   * `layerDimensions` is ignored when `layerIndex` is `null` (a merged
   * document is always document-sized).
   *
   * `layerStyles` chooses how a PSD layer's styles are treated (see
   * `ImportOptions.layerStyles`): `"merge"` (bake them into the raster,
   * AE's dialog default) or `"ignore"`. `CURRENT_VALUE` (the default)
   * preserves the current binding's recorded choice verbatim - including
   * the `"editable"` marker of an editable-comp per-layer footage item,
   * which is not accepted as an explicit argument (AE's footage dialog
   * offers merge/ignore only) - and falls back to `"merge"` when the
   * current source has no PSD layer binding. Like `layerDimensions`, it
   * is ignored when `layerIndex` is `null`.
   *
   * **Note:** 
   * Unlike ExtendScript, if the specified file has an unlabeled alpha channel,
   * this method does not estimate the alpha interpretation.
   *
   * file: Path to the new source file.
   * layer_index: Layer of the new file to reference, as its 0-based
   * `listLayers` position, or `CURRENT_VALUE` (layered files
   * only); `null` replaces with the merged/whole document.
   * layer_dimensions: `"document"`, `"layer"`, or `CURRENT_VALUE` to
   * keep the current binding's choice (the default).
   * layer_styles: `"merge"`, `"ignore"`, or `CURRENT_VALUE` to keep
   * the current binding's choice (the default). PSD targets only.
   *
   * ValueError: If the extension is not a supported footage format,
   * if the file has no track After Effects can decode (e.g. an
   * AV1-only `.mp4`), if `layerIndex` is passed for a
   * non-layered file, if
   * `layerIndex` is out of range for the new file, if
   * `layerDimensions` is not `"document"`/`"layer"`/`CURRENT_VALUE`,
   * if `layerStyles` is not `"merge"`/`"ignore"`/`CURRENT_VALUE`
   * or is passed explicitly for an AI/PDF target, or if
   * `CURRENT_VALUE` is passed while the current source does
   * not reference a single layer (or the new file has no layer at
   * the stored index).
   * NotImplementedError: If After Effects requires a format-specific
   * `opti` header not implemented for this format, or if merged
   * styles include a Stroke Emboss bevel, whose rasterized bounds
   * are not known.
   * UnsupportedAiLayersError: If `layer_dimensions="layer"` is
   * requested for an AI/PDF file whose page content py_aep cannot
   * read (see `resolvers.ai_bounds`).
   */
  replace(
    file: string | PathLike,
    layerIndex: number | _CurrentValue | null = null,
    layerDimensions: string | _CurrentValue = CURRENT_VALUE,
    layerStyles: string | _CurrentValue = CURRENT_VALUE,
  ): void {
    if (layerIndex == null) {
      this._replaceMainSource(
        FileSource._fromFile(file, { windows: this._project._windows }),
      );
      return;
    }
    if (!(layerIndex instanceof _CurrentValue)) {
      validatePositiveInt(layerIndex);
    }
    if (!(layerDimensions instanceof _CurrentValue)) {
      validateOneOf(["document", "layer"])(layerDimensions);
    }
    if (!(layerStyles instanceof _CurrentValue)) {
      validateOneOf(["merge", "ignore"])(layerStyles);
    }
    const suffix = new Path(file).suffix.toLowerCase();
    if (!PSD_COMP_EXTENSIONS.has(suffix) && !AI_COMP_EXTENSIONS.has(suffix)) {
      throw new ValueError(
        `layerIndex requires a layered .psd/.psb/.ai/.pdf ` +
          `file, got ${literal(suffix)}`,
      );
    }
    if (!PSD_COMP_EXTENSIONS.has(suffix) && !(layerStyles instanceof _CurrentValue)) {
      throw new ValueError("layerStyles applies to Photoshop (.psd/.psb) targets only");
    }
    if (layerIndex instanceof _CurrentValue) {
      const current = this._mainSource;
      if (!(current instanceof FileSource && current.layerName)) {
        throw new ValueError(
          "CURRENT_VALUE requires the current source to reference " +
            "a single layer of a layered file",
        );
      }
      layerIndex = layerIndexForStored(file, current._sspc.layerIndex);
    }
    let dimensions: string | null;
    if (layerDimensions instanceof _CurrentValue) {
      // Preserve the Document/Layer Size choice of the current binding.
      dimensions = null;
      const current = this._mainSource;
      if (
        current instanceof FileSource &&
        current.layerName &&
        !current._sspc.fullFrame
      ) {
        dimensions = "layer";
      }
    } else {
      dimensions = layerDimensions;
    }
    let resolvedStyles: string;
    if (layerStyles instanceof _CurrentValue) {
      // Preserve the recorded choice verbatim (00/01/02); "merge" is
      // AE's dialog default when the current source has no binding.
      const current = this._mainSource;
      const styles = current instanceof FileSource ? current.layerStyles : null;
      resolvedStyles = styles ?? "merge";
    } else {
      resolvedStyles = layerStyles;
    }
    this._replaceMainSource(
      FileSource._fromLayer(file, layerIndex, {
        dimensions,
        layerStyles: resolvedStyles,
        windows: this._project._windows,
      }),
    );
  }

  /**
   * Changes the source of this `FootageItem` to the specified image sequence.
   *
   * In addition to loading the file, the method creates a new `FileSource` object
   * for the file and sets `mainSource` to that object. In the new source object, it
   * sets the name, width, height, `frameDuration`, and duration attributes (see
   * `AVItem` object) based on the contents of the file.
   *
   * The method preserves interpretation parameters from the previous `mainSource`
   * object.
   *
   * **Note:** 
   * Unlike ExtendScript, if the specified file has an unlabeled alpha channel,
   * this method does not estimate the alpha interpretation.
   *
   * file: Path to a representative frame; sibling frames in the same
   * folder are gathered into the sequence.
   * force_alphabetical: Take every file of the same type in the
   * folder, in alphabetical order, rather than the numbered
   * frames (see `ImportOptions.forceAlphabetical`).
   *
   * ValueError: If the extension is not a supported footage format,
   * or one After Effects does not import as a sequence (movies,
   * audio, HEIC, FBX, data files).
   * NotImplementedError: If After Effects requires a format-specific
   * `opti` header not implemented for this format.
   */
  replaceWithSequence(file: string | PathLike, forceAlphabetical: boolean = false): void {
    this._replaceMainSource(
      FileSource._fromFile(file, {
        sequence: true,
        forceAlphabetical,
        windows: this._project._windows,
        defaultSequenceFps: defaultSequenceFps(this._project._preferences),
      }),
    );
  }

  /** Replace the first LIST:Pin in _item_list with a new source. */
  _replaceMainSource(source: FileSource | PlaceholderSource | SolidSource): void {
    const isSolid = source instanceof SolidSource;
    if (!isSolid) {
      // AE keeps the Interpret Footage settings across a replace; only
      // a solid starts from scratch (see `_carryInterpretationTo`).
      this._mainSource._carryInterpretationTo(source);
    }
    this._replacePin(0, AVItem._pinForSource(source));

    this._mainSource = source;
    source._joinProject(this._project);

    assert(this._idta != null);
    this._idta.isFootage = true;
    this._idta.isSolid = isSolid;
    if (source instanceof FileSource) {
      this._idta._flags17 = source._idtaFlags17();
    }
    this._syncModifiedTime();

    // AE only ever writes the item-level Utf8 when the user renames the
    // item, so a replace leaves it alone: a default (source-derived) name
    // re-derives from the new source, a user-assigned one survives.
    // A solid or placeholder carries its name in the new `opti` chunk
    // instead, so the Utf8 goes back to empty.
    assert(this._nameUtf8 != null);
    if (source.constructor._ownsName) {
      this._nameUtf8.value = "";
    }
    this._name = source._resolveName(this._nameUtf8.value);
  }
}
