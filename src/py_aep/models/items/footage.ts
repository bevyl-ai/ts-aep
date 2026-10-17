// Python: src/py_aep/models/items/footage.py (`from __future__ import annotations`: dropped)

import { ListChunk, type Chunk } from "../../binary/chunk.ts";
import { build_item_view_chunks } from "../../binary/comp_skeleton.ts";
import { IdtaChunk, type CmtaChunk } from "../../binary/item_chunks.ts";
import { FtgiChunk } from "../../binary/misc_chunks.ts";
import { build_gide_list, build_item_id_chunks } from "../../binary/mutations.ts";
import { Utf8Chunk } from "../../binary/scalar_chunks.ts";
import { AI_COMP_EXTENSIONS, PSD_COMP_EXTENSIONS } from "../../data/file_formats.ts";
import { layer_index_for_stored } from "../../resolvers/source_layers.ts";
import { CURRENT_VALUE, _CurrentValue } from "../import_options.ts";
import { auto_name } from "../naming.ts";
import { default_sequence_fps, label_index } from "../preferences.ts";
import { FileSource } from "../sources/file.ts";
import { PlaceholderSource } from "../sources/placeholder.ts";
import { SolidSource } from "../sources/solid.ts";
import { validate_name, validate_one_of, validate_pixel_aspect, validate_positive_int } from "../validators.ts";
import { AVItem } from "./av_item.ts";
import {
  Path,
  TypeError_,
  ValueError,
  py_assert,
  repr,
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
 * console.log(footage.main_source);
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
  declare _main_source: FileSource | SolidSource | PlaceholderSource;
  declare _view_data: Chunk[];
  // Set in the constructor from the source's resolved name; declared here because the base class does not own it.
  declare _name: string;

  /** The width of the item in pixels. Read-only. */
  get width(): number {
    return this._main_source._width;
  }

  /** The height of the item in pixels. Read-only. */
  get height(): number {
    return this._main_source._height;
  }

  /**
   * The duration of the item in seconds. Still footages have a duration
   * of 0. Read-only.
   */
  get duration(): number {
    return this._main_source._duration;
  }

  /** The frame rate of the item in frames-per-second. Read-only. */
  get frame_rate(): number {
    return this._main_source.display_frame_rate;
  }

  /**
   * The duration of the item in frames. Still footages have a duration
   * of 0. Read-only.
   */
  get frame_duration(): number {
    return this._main_source._frame_duration;
  }

  /**
   * The pixel aspect ratio of the item (1.0 is square). Read / Write.
   *
   * **Note:** 
   * Unlike After Effects, which snaps a written value to the nearest
   * preset ratio (1.09 becomes the 1.0940 of D1/DV PAL), the value
   * is stored as given.
   */
  get pixel_aspect(): number {
    return this._main_source._pixel_aspect;
  }

  set pixel_aspect(value: number) {
    validate_pixel_aspect(value);
    this._main_source._sspc.pixel_aspect = value;
  }

  /**
   * When `true`, the AVItem is a placeholder, or represents footage with a
   * source file that could not be found when the project was last saved.
   *
   * In this case, the path of the missing source file is in the
   * `missing_footage_path` attribute of the footage item's source-file object.
   * See {@link FootageItem.main_source} and
   * {@link FileSource.missing_footage_path | FileSource.missing_footage_path}.
   * Read-only.
   */
  get footage_missing(): boolean {
    return this._main_source._footage_missing;
  }

  /**
   * When `true`, the footage has an audio component.
   *
   * When {@link AVItem.use_proxy | use_proxy} is
   * `true`, reflects the proxy source rather than the main source.
   * Read-only.
   */
  get has_audio(): boolean {
    if (this.use_proxy && this._proxy_source != null) {
      return this._proxy_source._has_audio;
    }
    return this._main_source._has_audio;
  }

  /**
   * `true` if the footage can be used as an alternate source when setting
   * {@link Property.alternate_source | Property.alternate_source}.
   * Read-only.
   *
   * `false` for solids, for footage without a video component (audio-only
   * or data files), and for 3D model scenes (AE 2026 reports an imported
   * `.fbx` as incompatible even though it has video).
   */
  get is_media_replacement_compatible(): boolean {
    const source = this._main_source;
    if (source instanceof SolidSource) {
      return false;
    }
    if (source instanceof FileSource && source._is_3d_model_scene) {
      return false;
    }
    return this.has_video;
  }

  /** The footage start frame. Read-only. */
  get start_frame(): number {
    return this._main_source._start_frame;
  }

  /** The footage end frame. Read-only. */
  get end_frame(): number {
    return this._main_source._end_frame;
  }

  constructor(kw: {
    _idta: IdtaChunk;
    _name_utf8: Utf8Chunk;
    _cmta: CmtaChunk | null;
    _item_list: ListChunk;
    _gide: ListChunk | null;
    _pin_chunks: ListChunk[];
    project: Project;
    parent_folder: FolderItem;
    main_source: FileSource | SolidSource | PlaceholderSource;
    proxy_source: FileSource | SolidSource | PlaceholderSource | null;
  }) {
    const {
      _idta,
      _name_utf8,
      _cmta,
      _item_list,
      _gide,
      _pin_chunks,
      project,
      parent_folder,
      main_source,
      proxy_source,
    } = kw;
    super({
      _idta,
      _name_utf8,
      _cmta,
      _item_list,
      _gide,
      _pin_chunks,
      project,
      parent_folder,
      type_name: "Footage",
      proxy_source,
    });
    this._main_source = main_source;
    main_source._project = project;
    this._view_data = [];
    // Cache the resolved display name rather than mutating the binary
    // Utf8 chunk, which for a solid or placeholder AE leaves empty.
    this._name = main_source._resolve_name(_name_utf8.value);
  }

  /**
   * The name of the item, as shown in the Project panel.
   * Read / Write.
   */
  get name(): string {
    return this._name;
  }

  set name(value: string) {
    validate_name(value);
    // A footage item always carries a Utf8 name chunk (see parse_item).
    py_assert(this._name_utf8 != null);
    // The display name has to be written where `_resolve_name` reads it
    // back from. AE keeps a solid's or placeholder's name in the source
    // `opti` chunk and leaves the item-level Utf8 empty; only file
    // footage is named through the item chunk.
    if (this._main_source.constructor._owns_name) {
      this._main_source._store_name(value);
      this._name_utf8.value = "";
    } else {
      this._name_utf8.value = value;
    }
    this._name = value;
  }

  /** The footage source. Read-only. */
  get main_source(): FileSource | SolidSource | PlaceholderSource {
    return this._main_source;
  }

  /** The footage type (placeholder, solid, file). Read-only. */
  get asset_type(): string {
    const main_source: object | null = this._main_source;
    if (main_source instanceof SolidSource) {
      return "solid";
    } else if (main_source instanceof FileSource) {
      return "file";
    } else if (main_source instanceof PlaceholderSource) {
      return "placeholder";
    } else {
      // TODO(port): Python formats `type(src)` as `<class 'py_aep.<module>.<Name>'>`; JS has no module path, so only the bare class name is printed. Affects only this unreachable-in-practice error message.
      throw new TypeError_(
        `Unexpected source type for ${this.name}: ${main_source?.constructor?.name}`,
      );
    }
  }

  /** The footage file path if its source is a {@link FileSource}, else `null`. */
  get file(): string | null {
    if (this._main_source instanceof FileSource) {
      return this._main_source.file;
    }
    return null;
  }

  /**
   * Identity used by {@link Project.consolidate_footage}.
   *
   * Returns a hashable key for footage that can be merged with other
   * footage sharing the same source file and interpretation, or `null`
   * for sources that are always unique (solids, placeholders).
   *
   * The Python tuple is returned as a `tkey(...)` string because the
   * caller uses it as a Map/Set key.
   */
  _consolidation_key(): string | null {
    const source = this._main_source;
    if (!(source instanceof FileSource)) {
      return null;
    }
    const attrs = source.file_attributes;
    return tkey(
      source.file,
      [...source.file_names],
      source.alpha_mode,
      source.invert_alpha,
      [...source.premul_color],
      source.field_separation_type,
      source.remove_pulldown,
      source.loop,
      source.conform_frame_rate,
      source.high_quality_field_separation,
      source.interpret_as_linear_light,
      source.is_still,
      source.native_frame_rate,
      source.media_color_space,
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
    kw: { project: Project; parent_folder: FolderItem },
  ): FootageItem {
    const { project, parent_folder } = kw;
    const item_id = project._allocate_id();

    // AE labels footage items by kind (probed in AE 2026): solids use
    // "Solid Label Index 2" (factory 1), audio-only files "Audio Label
    // Index 2" (7), stills "Still Label Index 2" (5), and video files,
    // sequences, and placeholders "Video Label Index 2" (3).
    let label: number;
    if (source instanceof SolidSource) {
      label = label_index(project._preferences, "Solid Label Index 2", 1);
    } else if (source instanceof FileSource && source._has_audio && source._width === 0) {
      label = label_index(project._preferences, "Audio Label Index 2", 7);
    } else if (source instanceof FileSource && source.is_still) {
      label = label_index(project._preferences, "Still Label Index 2", 5);
    } else {
      label = label_index(project._preferences, "Video Label Index 2", 3);
    }

    const idta = new IdtaChunk({
      item_type: 7,
      item_id,
      label,
    });
    idta.is_footage = true;
    idta.is_solid = source instanceof SolidSource;
    // A file source carries the footage-kind flags; solid/placeholder
    // sources keep the chunk default.
    if (source instanceof FileSource) {
      idta._flags_17 = source._idta_flags17();
    }
    // AE leaves the item-level Utf8 empty; the display name resolves
    // from the source (solid / placeholder / file name).
    const name_utf8 = new Utf8Chunk({});

    const pin_list = AVItem._pin_for_source(source);

    const ftgi = new FtgiChunk({});

    const item_list = new ListChunk({
      list_type: "Item",
      chunks: [
        ...build_item_id_chunks(item_id, project._head.ae_version_major),
        idta,
        name_utf8,
        pin_list,
        ftgi,
        new Utf8Chunk({}),
      ],
    });

    // View data chunks AE expects after LIST:Item in the parent folder
    const view_data: Chunk[] = build_item_view_chunks();

    const item = new this({
      _idta: idta,
      _name_utf8: name_utf8,
      _cmta: null,
      _item_list: item_list,
      _gide: null,
      _pin_chunks: [pin_list],
      project,
      parent_folder,
      main_source: source,
      proxy_source: null,
    });
    source._join_project(project);
    // AE writes the guide list with no `ldat` until a guide is added.
    [item._gide, item._lhd3, item._inner] = build_gide_list();
    item._item_list.chunks.push(item._gide);
    item._view_data = view_data;
    item._sync_modified_time();
    return item;
  }

  _sync_modified_time(): void {
    // AE 2026 stamps idta with the last-modified time of the file in use
    // - the proxy's while a file proxy is in use, the main file's
    // otherwise - on import, replace, reload and every proxy change. A
    // solid or placeholder in use leaves the stamp as it is: AE does the
    // same for a placeholder, and writes the time of the edit for a
    // solid, which would make py_aep's output depend on when it ran.
    // AE replaces an unset (0) stamp with the save time without
    // re-reading the media, so leaving one is harmless.
    const source = this.use_proxy ? this._proxy_source : this._main_source;
    if (source instanceof FileSource) {
      py_assert(this._idta != null);
      this._idta.modified_time = source._sspc.source_modified;
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
  replace_with_placeholder(
    name: string | null,
    width: number,
    height: number,
    frame_rate: number,
    duration: number,
  ): void {
    if (name == null) {
      name = "Missing Name";
    } else if (name === "") {
      name = "Placeholder";
    }

    const source = PlaceholderSource._new(name, width, height, frame_rate, duration);
    this._replace_main_source(source);
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
  replace_with_solid(
    color: number[],
    name: string | null,
    width: number,
    height: number,
    pixel_aspect: number = 1.0,
  ): void {
    if (name == null) {
      const existing = new Set([...this._project.items.values()].map((item) => item.name));
      const solid_name = SolidSource._color_name(color[0], color[1], color[2]);
      name = auto_name(solid_name, existing);
    } else if (name === "") {
      name = "????";
    }

    const source = SolidSource._new(name, color, width, height, pixel_aspect);
    this._replace_main_source(source);
  }

  /**
   * Replace the footage source with a file on disk.
   *
   * Changes the source of this `FootageItem` to the specified file.
   *
   * In addition to loading the file, the method creates a new `FileSource` object
   * for the file and sets `main_source` to that object. In the new source object, it
   * sets the name, width, height, `frame_duration`, and duration attributes (see
   * `AVItem` object) based on the contents of the file.
   *
   * The method preserves interpretation parameters from the previous `main_source`
   * object.
   *
   * py_aep extension: `layer_index` binds the new source to a single
   * layer of a layered file, by `list_layers` position (see
   * `ImportOptions.layer_index`). `null` (the default) always replaces
   * with the merged/whole document, even when the current source references a
   * single layer - consistent with `import_file`, where `layer_index=None`
   * imports merged. Pass `CURRENT_VALUE` to rebind at the current source's
   * stored layer index (the `sspc` layer index: PSD record index / AI document
   * index) in the new file.
   *
   * `layer_dimensions` chooses the footage dimensions when a layer is
   * selected (see `ImportOptions.layer_dimensions`): `"document"` (the
   * full canvas) or `"layer"` (the layer's content box). `CURRENT_VALUE`
   * (the default) preserves the current single-layer binding's choice.
   * For an AI/PDF target the content box is the artwork box measured from
   * the page content stream (see
   * {@link py_aep.resolvers.ai_bounds.read_ai_layer_bounds | read_ai_layer_bounds}).
   * `layer_dimensions` is ignored when `layer_index` is `null` (a merged
   * document is always document-sized).
   *
   * `layer_styles` chooses how a PSD layer's styles are treated (see
   * `ImportOptions.layer_styles`): `"merge"` (bake them into the raster,
   * AE's dialog default) or `"ignore"`. `CURRENT_VALUE` (the default)
   * preserves the current binding's recorded choice verbatim - including
   * the `"editable"` marker of an editable-comp per-layer footage item,
   * which is not accepted as an explicit argument (AE's footage dialog
   * offers merge/ignore only) - and falls back to `"merge"` when the
   * current source has no PSD layer binding. Like `layer_dimensions`, it
   * is ignored when `layer_index` is `null`.
   *
   * **Note:** 
   * Unlike ExtendScript, if the specified file has an unlabeled alpha channel,
   * this method does not estimate the alpha interpretation.
   *
   * file: Path to the new source file.
   * layer_index: Layer of the new file to reference, as its 0-based
   * `list_layers` position, or `CURRENT_VALUE` (layered files
   * only); `null` replaces with the merged/whole document.
   * layer_dimensions: `"document"`, `"layer"`, or `CURRENT_VALUE` to
   * keep the current binding's choice (the default).
   * layer_styles: `"merge"`, `"ignore"`, or `CURRENT_VALUE` to keep
   * the current binding's choice (the default). PSD targets only.
   *
   * ValueError: If the extension is not a supported footage format,
   * if the file has no track After Effects can decode (e.g. an
   * AV1-only `.mp4`), if `layer_index` is passed for a
   * non-layered file, if
   * `layer_index` is out of range for the new file, if
   * `layer_dimensions` is not `"document"`/`"layer"`/`CURRENT_VALUE`,
   * if `layer_styles` is not `"merge"`/`"ignore"`/`CURRENT_VALUE`
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
    layer_index: number | _CurrentValue | null = null,
    layer_dimensions: string | _CurrentValue = CURRENT_VALUE,
    layer_styles: string | _CurrentValue = CURRENT_VALUE,
  ): void {
    if (layer_index == null) {
      this._replace_main_source(
        FileSource._from_file(file, { windows: this._project._windows }),
      );
      return;
    }
    if (!(layer_index instanceof _CurrentValue)) {
      validate_positive_int(layer_index);
    }
    if (!(layer_dimensions instanceof _CurrentValue)) {
      validate_one_of(["document", "layer"])(layer_dimensions);
    }
    if (!(layer_styles instanceof _CurrentValue)) {
      validate_one_of(["merge", "ignore"])(layer_styles);
    }
    const suffix = new Path(file).suffix.toLowerCase();
    if (!PSD_COMP_EXTENSIONS.has(suffix) && !AI_COMP_EXTENSIONS.has(suffix)) {
      throw new ValueError(
        `layer_index requires a layered .psd/.psb/.ai/.pdf ` +
          `file, got ${repr(suffix)}`,
      );
    }
    if (!PSD_COMP_EXTENSIONS.has(suffix) && !(layer_styles instanceof _CurrentValue)) {
      throw new ValueError("layer_styles applies to Photoshop (.psd/.psb) targets only");
    }
    if (layer_index instanceof _CurrentValue) {
      const current = this._main_source;
      if (!(current instanceof FileSource && current.layer_name)) {
        throw new ValueError(
          "CURRENT_VALUE requires the current source to reference " +
            "a single layer of a layered file",
        );
      }
      layer_index = layer_index_for_stored(file, current._sspc.layer_index);
    }
    let dimensions: string | null;
    if (layer_dimensions instanceof _CurrentValue) {
      // Preserve the Document/Layer Size choice of the current binding.
      dimensions = null;
      const current = this._main_source;
      if (
        current instanceof FileSource &&
        current.layer_name &&
        !current._sspc.full_frame
      ) {
        dimensions = "layer";
      }
    } else {
      dimensions = layer_dimensions;
    }
    let resolved_styles: string;
    if (layer_styles instanceof _CurrentValue) {
      // Preserve the recorded choice verbatim (00/01/02); "merge" is
      // AE's dialog default when the current source has no binding.
      const current = this._main_source;
      const styles = current instanceof FileSource ? current.layer_styles : null;
      resolved_styles = styles ?? "merge";
    } else {
      resolved_styles = layer_styles;
    }
    this._replace_main_source(
      FileSource._from_layer(file, layer_index, {
        dimensions,
        layer_styles: resolved_styles,
        windows: this._project._windows,
      }),
    );
  }

  /**
   * Changes the source of this `FootageItem` to the specified image sequence.
   *
   * In addition to loading the file, the method creates a new `FileSource` object
   * for the file and sets `main_source` to that object. In the new source object, it
   * sets the name, width, height, `frame_duration`, and duration attributes (see
   * `AVItem` object) based on the contents of the file.
   *
   * The method preserves interpretation parameters from the previous `main_source`
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
   * frames (see `ImportOptions.force_alphabetical`).
   *
   * ValueError: If the extension is not a supported footage format,
   * or one After Effects does not import as a sequence (movies,
   * audio, HEIC, FBX, data files).
   * NotImplementedError: If After Effects requires a format-specific
   * `opti` header not implemented for this format.
   */
  replace_with_sequence(file: string | PathLike, force_alphabetical: boolean = false): void {
    this._replace_main_source(
      FileSource._from_file(file, {
        sequence: true,
        force_alphabetical,
        windows: this._project._windows,
        default_sequence_fps: default_sequence_fps(this._project._preferences),
      }),
    );
  }

  /** Replace the first LIST:Pin in _item_list with a new source. */
  _replace_main_source(source: FileSource | PlaceholderSource | SolidSource): void {
    const is_solid = source instanceof SolidSource;
    if (!is_solid) {
      // AE keeps the Interpret Footage settings across a replace; only
      // a solid starts from scratch (see `_carry_interpretation_to`).
      this._main_source._carry_interpretation_to(source);
    }
    this._replace_pin(0, AVItem._pin_for_source(source));

    this._main_source = source;
    source._join_project(this._project);

    py_assert(this._idta != null);
    this._idta.is_footage = true;
    this._idta.is_solid = is_solid;
    if (source instanceof FileSource) {
      this._idta._flags_17 = source._idta_flags17();
    }
    this._sync_modified_time();

    // AE only ever writes the item-level Utf8 when the user renames the
    // item, so a replace leaves it alone: a default (source-derived) name
    // re-derives from the new source, a user-assigned one survives.
    // A solid or placeholder carries its name in the new `opti` chunk
    // instead, so the Utf8 goes back to empty.
    py_assert(this._name_utf8 != null);
    if (source.constructor._owns_name) {
      this._name_utf8.value = "";
    }
    this._name = source._resolve_name(this._name_utf8.value);
  }
}
