/** Import options for importing files into an After Effects project. */

import { INSPECT, describe } from "../../pyrt/index.ts";
import { AI_COMP_EXTENSIONS, COMP_CONVERSION_EXTENSIONS, PSD_COMP_EXTENSIONS, getFileFormat, getImportAsTypes, type FileFormat } from "../data/file_formats.ts";
import { ImportAsType } from "../enums/index.ts";
import { validateBool, validateEnum, validateOneOf, validatePath, validatePositiveInt, validateU4 } from "./validators.ts";
import { Path, ValueError, type PathLike, pyRe } from "../../pyrt/index.ts";

// Pattern to match trailing digits in a filename stem (e.g. "frame001").
export const _NUMBERED_RE = pyRe(String.raw`(\d+)$`);

/** Type of the `CURRENT_VALUE` sentinel. */
export class _CurrentValue {
  [INSPECT](): string {
    return "CURRENT_VALUE";
  }
}

/**
 * Sentinel for `FootageItem.replace`: keep the current source's choice for the
 * argument it is passed to.
 *
 * For `layerIndex`, binds the new file at the layer whose stored binary index
 * (the `sspc` layer index: PSD record index / AI document index) matches the
 * current source's. For `layerDimensions`, preserves the current single-layer
 * binding's Document/Layer Size choice.
 *
 * Not valid for `ImportOptions.layerIndex` - an import has no current binding.
 */
export const CURRENT_VALUE = new _CurrentValue();

/**
 * Options for importing a file into an After Effects project.
 *
 * This is a parameter container used by `Project.importFile()`. It
 * validates the import settings before the actual import operation.
 *
 * Unlike most py_aep classes, `ImportOptions` has no chunk backing -
 * import settings are not stored in the `.aep` binary format.
 *
 * ```ts
 * import { ImportOptions, ImportAsType } from "@bevyl-ai/ts-aep";
 *
 * const opts = new ImportOptions("footage/shot_001.png");
 * opts.sequence = true;
 * opts.importAs = ImportAsType.FOOTAGE;
 * ```
 *
 * @example
 * @see https://ae-scripting.docsforadobe.dev/other/importoptions/
 */
export class ImportOptions {
  _file: Path;
  private _importAs: ImportAsType;
  private _sequence: boolean;
  private _forceAlphabetical: boolean;
  private _layerIndex: number | null;
  private _layerDimensions: string | null;
  private _layerStyles: string | null;
  private _rangeStart: number;
  private _rangeEnd: number;

  constructor(file: string | PathLike) {
    validatePath(file);
    this._file = new Path(file);
    this._importAs = ImportAsType.FOOTAGE;
    this._sequence = false;
    this._forceAlphabetical = false;
    this._layerIndex = null;
    this._layerDimensions = null;
    this._layerStyles = null;
    this._rangeStart = 0;
    this._rangeEnd = 0;
  }

  /**
   * The single layer to import from a layered file (`.psd`/`.psb`/
   * `.ai`/`.pdf`), as its 0-based position in the list returned by
   * `listLayers` (top layer first - the order of the "Choose Layer"
   * dropdown of AE's import dialog). `null` (the default) imports the
   * file like AE's "Merged Layers" / whole-document option. Only valid
   * with `ImportAsType.FOOTAGE`. Read / Write.
   *
   * py_aep extension: ExtendScript exposes no layer-selection API. An
   * index (not a name) selects the layer because layered files may
   * contain several layers with the same name; AE's own dialog
   * disambiguates duplicates by dropdown position.
   *
   * @throws {@link ValueError} On import, if the index is out of range for the file's selectable
   *   layers (see `listLayers`).
   */
  get layerIndex(): number | null {
    return this._layerIndex;
  }

  set layerIndex(value: number | null | _CurrentValue) {
    if (value instanceof _CurrentValue) {
      throw new ValueError(
        "CURRENT_VALUE is only valid for FootageItem.replace; an " +
          "import has no current binding to keep",
      );
    }
    if (value != null) validatePositiveInt(value);
    this._layerIndex = value;
  }

  /**
   * Footage dimensions for a `layerIndex` import: `"document"` (the
   * full canvas) or `"layer"` (the layer's content box), matching the
   * "Footage Dimensions" option of AE's import dialog. `null` (the
   * default) follows the machine's sticky "Footage Dimensions" preference
   * for a `.psd`/`.psb` import when the project was parsed with an
   * `aePreferencesDir`, and imports at document size otherwise (always,
   * for `.ai`/`.pdf`). Read / Write.
   *
   * py_aep extension: ExtendScript exposes no layer-selection API.
   *
   * **Note:** For `.ai`/`.pdf`, `"layer"` measures the layer's artwork box from
   * the page content stream (see
   * {@link py_aep.resolvers.ai_bounds.read_ai_layer_bounds | read_ai_layer_bounds}).
   * On a document with more than one artboard the stored box will
   * differ from After Effects', which measures the second artboard and
   * treats first-artboard layers as empty; py_aep measures the first
   * and emits a `UserWarning`.
   */
  get layerDimensions(): string | null {
    return this._layerDimensions;
  }

  set layerDimensions(value: string | null) {
    if (value != null) validateOneOf(["document", "layer"])(value);
    this._layerDimensions = value;
  }

  /**
   * How a Photoshop (`.psd`/`.psb`) import treats the source layer
   * styles, matching the "Layer Options" of AE's import dialog:
   * `"editable"` (Editable Layer Styles), `"merge"` (Merge Layer Styles
   * into Footage) or `"ignore"` (Ignore Layer Styles). `null` (the
   * default) follows the machine's sticky "Layer Options" preference when
   * the project was parsed with an `aePreferencesDir`, falling back to
   * AE's dialog default for the context: `"editable"` for a COMP /
   * COMP_CROPPED_LAYERS import, `"merge"` for a FOOTAGE import of a single
   * layer. Read / Write.
   *
   * py_aep extension: ExtendScript exposes no layer-styles API. AE's own
   * `importFile` silently follows the sticky preference; py_aep mirrors
   * that when a preferences directory is available. Pass an explicit value
   * for behavior that does not depend on the machine.
   *
   * Valid combinations (checked at import time): a FOOTAGE import
   * accepts `"merge"`/`"ignore"` and requires
   * {@link ImportOptions.layerIndex | layer_index} (AE's "Merged Layers"
   * whole-document import - `layer_index=None` - always flattens the
   * styles into the composite and offers no choice); a COMP import
   * accepts `"editable"`/`"merge"`. Note the naming collision in AE's
   * dialog: "Merged Layers" (flatten the whole document, expressed as
   * `layer_index=None`) is unrelated to `"merge"` (bake the styles into
   * one layer's raster).
   *
   * @throws {@link ValueError} On import, if the value is not offered for the import context (see
   *   above), or if the file is not `.psd`/`.psb`.
   */
  get layerStyles(): string | null {
    return this._layerStyles;
  }

  set layerStyles(value: string | null | _CurrentValue) {
    if (value instanceof _CurrentValue) {
      throw new ValueError(
        "CURRENT_VALUE is only valid for FootageItem.replace; an " +
          "import has no current binding to keep",
      );
    }
    if (value != null) validateOneOf(["editable", "merge", "ignore"])(value);
    this._layerStyles = value;
  }

  /**
   * The file to be imported. If a file is set in the constructor, you can access
   * it through this attribute. Read / Write.
   */
  get file(): string {
    return this._file.toString();
  }

  set file(value: string | PathLike) {
    validatePath(value);
    this._file = new Path(value);
  }

  /** How to import the file. Read / Write. */
  get importAs(): ImportAsType {
    return this._importAs;
  }

  set importAs(value: ImportAsType) {
    validateEnum(ImportAsType)(value);
    this._importAs = ImportAsType.of(value);
  }

  /**
   * When `true`, import the file as part of a numbered image
   * sequence. Read / Write.
   */
  get sequence(): boolean {
    return this._sequence;
  }

  set sequence(value: boolean) {
    validateBool(value);
    this._sequence = value;
  }

  /**
   * When `true` and `sequence` is also `true`, use alphabetical
   * order for sequence frame numbering. Read / Write.
   *
   * Like After Effects, the sequence then takes every file of the
   * imported file's type in its folder, numbered or not, in
   * case-insensitive name order, and is named after the folder.
   *
   * Setting `true` resets {@link ImportOptions.rangeStart | range_start} and
   * {@link ImportOptions.rangeEnd | range_end} to 0 (matching After Effects:
   * an alphabetical sequence cannot carry a frame range).
   */
  get forceAlphabetical(): boolean {
    return this._forceAlphabetical;
  }

  set forceAlphabetical(value: boolean) {
    validateBool(value);
    this._forceAlphabetical = value;
    if (value) {
      this._rangeStart = 0;
      this._rangeEnd = 0;
    }
  }

  /**
   * The first frame number of the clipping range for a numbered
   * image sequence import, inclusive. 0 (with `rangeEnd` 0) imports
   * every frame. Read / Write.
   *
   * Frame numbers refer to the digits in the filenames, not ordinal
   * positions. Has no effect unless {@link ImportOptions.sequence | sequence}
   * is `true`. A `rangeEnd` of 0 with a non-zero `rangeStart` is
   * rejected at import time, as is `range_end < range_start` (both
   * matching After Effects).
   *
   * @throws {@link ValueError} If set while `forceAlphabetical` is `true` (After Effects: "You
   *   cannot set sequence range start for an alphabetical sequence"), or if the value does not fit
   *   the `sspc` `startFrame` field (a `u4`: 0..4294967295).
   */
  get rangeStart(): number {
    return this._rangeStart;
  }

  set rangeStart(value: number) {
    validateU4(value);
    if (this._forceAlphabetical) {
      throw new ValueError("cannot set a sequence range start for an alphabetical sequence");
    }
    this._rangeStart = value;
  }

  /**
   * The last frame number of the clipping range for a numbered
   * image sequence import, inclusive. 0 (with `rangeStart` 0) imports
   * every frame. Read / Write.
   *
   * A `rangeEnd` beyond the last existing frame keeps the range:
   * After Effects treats the missing tail frames as implied (rendered
   * as placeholder bars), and py_aep writes the same
   * `startFrame`/`endFrame` bounds. The resulting footage duration is
   * not clamped to After Effects' 3-hour ceiling - AE 2026 opens a
   * longer ranged sequence without complaint.
   *
   * @throws {@link ValueError} If set while `forceAlphabetical` is `true`, or if the value does
   *   not fit the `sspc` `endFrame` field (a `u4`: 0..4294967295).
   */
  get rangeEnd(): number {
    return this._rangeEnd;
  }

  set rangeEnd(value: number) {
    validateU4(value);
    if (this._forceAlphabetical) {
      throw new ValueError("cannot set a sequence range end for an alphabetical sequence");
    }
    this._rangeEnd = value;
  }

  /**
   * Check whether the file can be imported as the given type.
   *
   * Gates on what py_aep can actually import: the per-extension
   * capability table (`getImportAsTypes`) reflects After Effects,
   * while a file whose format py_aep does not implement (absent from
   * `data.file_formats`, or marked unsupported) returns `false` for
   * every type. `ImportAsType.PROJECT` is never importable (py_aep does
   * not implement project import for any format), so it always returns
   * `false` even though AE can import `.mov`/`.m4a`/`.aep`/`.aet` as a
   * project. Likewise `ImportAsType.COMP_CROPPED_LAYERS` is `true` only
   * for SVG, `.ai`/`.pdf` and `.psd`/`.psb`, the formats py_aep crops
   * (AE also crops `.eps` and multi-layer `.exr`).
   *
   * @param type - The import type to check.
   * @returns `true` if the file can be imported as `type`.
   */
  canImportAs(type: number): boolean {
    validateEnum(ImportAsType)(type);
    const asType = ImportAsType.of(type);
    if (asType === ImportAsType.PROJECT) return false;
    const suffix = this._file.suffix.toLowerCase();
    if (COMP_CONVERSION_EXTENSIONS.has(suffix)) {
      // Comp-conversion formats (e.g. SVG) have no media-format entry;
      // gate on the import-type table alone.
      return getImportAsTypes(suffix).has(asType);
    }
    let fmt: FileFormat;
    try {
      fmt = getFileFormat(suffix);
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
      return false;
    }
    if (fmt.opti === "unsupported") return false;
    if (
      asType === ImportAsType.COMP_CROPPED_LAYERS &&
      !PSD_COMP_EXTENSIONS.has(suffix) &&
      !AI_COMP_EXTENSIONS.has(suffix)
    ) {
      // AE offers a cropped import for `.eps`/`.exr` too, but
      // `importFile` implements it for SVG, Illustrator/PDF and
      // Photoshop only.
      return false;
    }
    return getImportAsTypes(suffix).has(asType);
  }

  /**
   * Check whether the filename ends with a number.
   *
   * @returns A tuple of `(is_numbered, first_number)` where `is_numbered` is `true` when the
   *   filename stem ends with digits and `first_number` is the parsed integer value (or `0` when
   *   not numbered).
   */
  isFileNameNumbered(): [boolean, number] {
    const stem = this._file.stem;
    const m = _NUMBERED_RE.exec(stem);
    if (m != null) return [true, Number.parseInt(m[1], 10)];
    return [false, 0];
  }

  [INSPECT](): string {
    return describe("ImportOptions", {
      file: this._file.toString(),
      importAs: ImportAsType.nameOf(this._importAs),
      sequence: this._sequence,
    });
  }
}
