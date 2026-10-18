/**
 * TextDocument model for After Effects text layers.
 */

import {
  deepcopy,
  descriptor,
  float,
  int,
  pyAssert,
  pyBool,
  pyEq,
  rstrip,
  sorted,
  str,
  ValueError,
  zip,
  pyfloat,
  PyFloat,
  instanceDict,
} from "../../../pyrt/index.ts";
import { ListChunk } from "../../binary/chunk.ts";
import type { HeadChunk } from "../../binary/item_chunks.ts";
import { getCosTemplate, cosGet, serialize } from "../../cos/index.ts";
import type { CosDict, CosNode } from "../../cos/cos.ts";
import { enumFromCos, type InstanceValue } from "../../cos/descriptors.ts";
import { cosAppend, cosAt, cosDict, cosFloat, cosGetOr, cosItem, cosIter, cosNum, cosPop, cosSetdefault, cosSetitem, cosUnbox, is, pyInt, pyNumber, type CosUnboxed } from "../../cos/kinds.ts";
import { charStyle, firstBaseline, read } from "../../cos/schema.ts";
import { AutoKernType, BaselineDirection, BoxAutoFitPolicy, BoxFirstBaselineAlignment, BoxVerticalAlignment, ComposerEngine, DigitSet, FontBaselineOption, FontCapsOption, LeadingType, LineJoinType, LineOrientation, ParagraphDirection, ParagraphJustification } from "../../enums/index.ts";
import { calibrate as calibrateComposition } from "../../resolvers/text_composition.ts";
import { requiresVersion } from "../../ae_version.ts";
import { Preferences, defaultCharacterStyle, defaultParagraphStyle } from "../preferences.ts";
import { validateBool, validateBoxSize, validateEnum, validateFontName, validateInt, validateNormalizedFloat, validateNumber, validatePositiveInt, validatePositiveNonzeroNumber, validatePositiveNumber, validateRgbColor, validateS4, validateText, validateVector2 } from "../validators.ts";
import { FontObject } from "./font_object.ts";
import { CHARACTER_RANGE_OOB, NOT_ASSOCIATED, CharacterRange, ComposedLineRange, DocumentWideCosField, ParagraphRange, _applyCharKey, _buildColorPaint, _cachedLineData, _cachedLineNodes, _charRunSpans, _composedLineSpans, _freshComposedSpans, _lineAdvances, _lineDataFromNodes, _lineOrigin, _paraRunSpans, _parseColor, _rawText, _rebuildKernRuns, _registerFontAt, _visibleLength, u16Len, u16Slice } from "./ranges.ts";

/**
 * `baseline_locs` entry for a line with no visible characters: the
 * maximum 32-bit float, as After Effects reports (`3.402823466e+38`).
 */
export const _EMPTY_LINE_LOC = 3.4028234663852886e38;

/**
 * Build the 16-vertex box outline AE stores for paragraph text.
 *
 * Coordinates trace the rectangle corners (each corner duplicated, AE's
 * bezier vertex layout), anchored at the top-left `(left, top)`.
 */
export function _boxCoords(left: number, top: number, width: number, height: number): PyFloat[] {
  const right = left + width;
  const bottom = top + height;
  const coords: PyFloat[] = [];
  for (const [x, y] of [
    [left, top],
    [left, top],
    [right, top],
    [right, top],
    [right, top],
    [right, top],
    [right, bottom],
    [right, bottom],
    [right, bottom],
    [right, bottom],
    [left, bottom],
    [left, bottom],
    [left, bottom],
    [left, bottom],
    [left, top],
    [left, top],
  ]) {
    coords.push(pyfloat(x), pyfloat(y));
  }
  return coords;
}

/**
 * Reorder a COS sub-dict's keys numerically in place.
 *
 * AE stores the box-frame metadata keys in ascending numeric order;
 * matching that order keeps serialized output byte-identical.
 */
export function _numericSort(d: CosDict): void {
  const items = sorted([...d.entries()], (kv) => int(kv[0]));
  d.clear();
  for (const [k, v] of items) d.set(k, v);
}

/**
 * Update a frame's `2` sub-dict for the point-to-box conversion.
 *
 * AE flips these metadata values when a point text layer becomes a box
 * (paragraph) text layer; other keys in the sub-dict are preserved.
 */
export function _applyBoxConversion(meta: CosNode): void {
  cosSetitem(meta, "0", 1);
  cosSetitem(meta, "6", [pyfloat(-2.0), pyfloat(-2.0)]);
  const eleven = cosSetdefault(meta, "11", new Map());
  cosSetitem(eleven, "4", -2);
  cosSetitem(eleven, "18", pyfloat(-2.0));
  _numericSort(cosDict(meta, "items"));
}

/** The `__new__` token: constructs a `TextDocument` without running `__init__`. */
const _NEW: unique symbol = Symbol("TextDocument.__new__");

const isStr = (v: InstanceValue): v is string => typeof v === "string";
const isNum = (v: InstanceValue): v is number => typeof v === "number";
const isBool = (v: InstanceValue): v is boolean => typeof v === "boolean";
const isFontObject = (v: InstanceValue): v is FontObject => v instanceof FontObject;
const isRgb = (v: InstanceValue): v is number[] => Array.isArray(v) && v.every((x) => typeof x === "number");

export class TextDocument {
  /**
   * Stores a value for a TextLayer's Source Text property.
   *
   * ```ts
   * import { parse } from "@bevyl-ai/ts-aep";
   *
   * const app = parse("project.aep");
   * const comp = app.project.compositions[0];
   * const text_doc = comp.textLayers[0].text.sourceText.value;
   * console.log(text_doc.text);
   * ```
   *
   * @example
   * @see https://ae-scripting.docsforadobe.dev/text/textdocument/
   */

  // `text` is an accessor below; Python's `text: str` annotation exists so
  // to_dict serializes it (bypassing SKIP_PROPERTIES).

  // Back-reference to the project HeadChunk for version gating. Wired
  // lazily by the owning Property when the document is handed out (and at
  // parse time); `None` until then. Underscore-prefixed, so to_dict skips it.
  _head: HeadChunk | null = null;

  // Back-reference to the project's AE preferences, wired at parse time.
  // Holds the Character/Paragraph panel defaults the reset methods restore;
  // `None` falls back to AE's factory values.
  _preferences: Preferences | null = null;

  // `True` for documents parsed from a layer's btdk data. The range API
  // (AE 24.3+) refuses documents never associated with a layer, exactly
  // as ExtendScript does for an unapplied `new TextDocument()`.
  _associated: boolean = false;

  // Set by the first layout-affecting py-side write; while `False` the
  // persisted composed-line cache is authoritative. Underscore-prefixed,
  // so to_dict skips both.
  _layout_dirty: boolean = false;

  // Verdict of calibrating the composed-line resolver against this
  // document's own AE cache: `None` = never attempted, `True` = the
  // composer reproduces AE for this document (post-mutation
  // recomposition is trusted), `False` = refused or mismatched.
  _composition_calibrated: boolean | null = null;

  // Wrappers sharing this layer's btdk COS data (one per keyframe,
  // including self); `None` for template-constructed documents. Frame
  // writes live in the shared layer data, so they must dirty-mark
  // every sibling, not just the document written through.
  _siblings: TextDocument[] | null = null;

  // Python instance `__dict__`: overrides for fields without COS backing.
  // `_override` reads it directly, so it must stay separate from accessors.
  // Shared with CosField.__get__ via instance_dict, so CosField-backed `_from_binary` kwargs are read back.
  __dict__: Map<string, InstanceValue> = instanceDict(this);

  // COS backing, assigned by `__init__` / `_from_binary`. The style dicts
  // alias the first runs' styles (`null` when a run carries none); `_doc`
  // is whatever the document array holds (py_aep reads it lazily).
  declare _char_style: CosDict | null;
  declare _para_style: CosDict | null;
  declare _doc: CosNode;
  declare _fonts: FontObject[];
  declare _cos_data: CosDict;
  declare _btdk_body: ListChunk;

  _mark_frame_layout_dirty(): void {
    /**
     * Mark a frame-level write (box meta, orientation) on ALL
     * documents sharing this layer's frame.
     *
     * Runs before the mutation lands so each sibling still calibrates
     * against its own clean cache + text.
     */
    const siblings = this._siblings;
    for (const doc of siblings != null && siblings.length > 0 ? siblings : [this]) {
      doc._mark_layout_dirty();
    }
  }

  _mark_layout_dirty(): void {
    /**
     * Record a layout-affecting write, calibrating the composer first.
     *
     * The write engine calls this BEFORE serializing any mutation that
     * can change line composition, so the first call still sees the
     * clean cache + text: composing them and comparing spans AND
     * baselines against what AE persisted proves (or refutes) the
     * composer + installed fonts for this document.
     */
    // Every layout write invalidates the memoized composition.
    this.__dict__.delete("_composed_cache");
    if (this._layout_dirty) return;
    if (this.boxText && this._composition_calibrated == null) {
      const cached = _cachedLineData(this);
      if (cached != null) {
        this._composition_calibrated = calibrateComposition(this, cached[0], cached[1]);
      }
    }
    this._layout_dirty = true;
  }

  /**
   * `true` when the composed-line APIs may not reflect this
   * document's current content. Read-only.
   *
   * Point text is never stale (its composed lines are the
   * paragraphs). Box text goes stale after a layout-affecting
   * py-side write unless the composed-line resolver calibrated
   * against this document's own persisted cache and can recompose
   * its current state (see the `resolvers.text_composition`
   * module).
   *
   * The flag tracks writes made through THIS document object: a
   * document re-parsed from a py-written file, or minted by
   * `Layer.duplicate`, starts clean even when its persisted cache
   * no longer matches its text.
   */
  get compositionStale(): boolean {
    if (!this.boxText || !this._layout_dirty) return false;
    return _freshComposedSpans(this) == null;
  }

  // -- Character-style CosField descriptors (_char_style dict) -----------

  /** The Text layer's font size in pixels. Read / Write. */
  declare fontSize: number | null;

  /** `true` if a Text layer has faux bold enabled. Read / Write. */
  declare fauxBold: boolean | null;

  /** `true` if a Text layer has faux italic enabled. Read / Write. */
  declare fauxItalic: boolean | null;

  /** The Text layer's spacing between characters. Read / Write. */
  declare tracking: number | null;

  /**
   * The Text layer's auto kern type option. Read / Write.
   *
   * Setting a non-manual kern type also clears the manual kerning
   * values document-wide, dropping the kern-run array and the
   * leading-edge value like the range setter (probed `X_AKT_SET`).
   */
  get autoKernType(): AutoKernType | null {
    const override = this._override_of("autoKernType", (v): v is AutoKernType => AutoKernType.has(v));
    if (override != null) return override;
    if (this._char_style == null) return AutoKernType.NO_AUTO_KERN;
    const raw = this._char_style.get("11");
    if (raw == null) return AutoKernType.NO_AUTO_KERN;
    return enumFromCos(AutoKernType, raw);
  }

  set autoKernType(value: AutoKernType) {
    validateEnum(AutoKernType)(value);
    this.__dict__.delete("autoKernType");
    if (this._char_style == null) {
      this._set_override("autoKernType", AutoKernType.of(value));
      return;
    }
    const total = u16Len(_rawText(this));
    _applyCharKey(this, 0, total, "11", AutoKernType.to_binary(AutoKernType.of(value)));
    if (value !== AutoKernType.NO_AUTO_KERN) {
      // Drops the kern-run array and leading-edge value with it.
      _rebuildKernRuns(this, Array<null>(total).fill(null));
    }
    this._propagate_cos();
  }

  /** This Text layer's horizontal scale in pixels. Read / Write. */
  declare horizontalScale: number | null;

  /** This Text layer's vertical scale in pixels. Read / Write. */
  declare verticalScale: number | null;

  /** This Text layer's baseline shift in pixels. Read / Write. */
  declare baselineShift: number | null;

  /** The Text layer's font caps option. Read / Write. */
  declare fontCapsOption: FontCapsOption | null;

  /** The Text layer's font baseline option. Read / Write. */
  declare fontBaselineOption: FontBaselineOption | null;

  /** This Text layer's tsume value (0.0 to 1.0). Read / Write. */
  declare tsume: number;

  /** When `true`, the Text layer shows a fill. Read / Write. */
  declare applyFill: boolean | null;

  /** When `true`, the Text layer shows a stroke. Read / Write. */
  declare applyStroke: boolean;

  /** When `true`, the stroke appears over the fill. Read / Write. */
  declare strokeOverFill: boolean;

  /** The Text layer's stroke thickness in pixels. Read / Write. */
  declare strokeWidth: number;

  // -- Paragraph-style CosField descriptors (_para_style dict) -----------

  /** The paragraph justification for the Text layer. Read / Write. */
  declare justification: ParagraphJustification | null;

  /** The Text layer's paragraph first line indent. Read / Write. */
  declare firstLineIndent: number;

  /** The Text layer's paragraph start indent. Read / Write. */
  declare startIndent: number;

  /** The Text layer's paragraph end indent. Read / Write. */
  declare endIndent: number;

  /** The Text layer's paragraph space before. Read / Write. */
  declare spaceBefore: number;

  /** The Text layer's paragraph space after. Read / Write. */
  declare spaceAfter: number;

  /**
   * The Text layer's auto leading option. Read / Write.
   *
   * Enabling auto-leading also resets the explicit leading key to
   * AE's sentinel across the document (probed `X_AL_SET`).
   */
  get autoLeading(): boolean | null {
    const override = this._override_of("autoLeading", isBool);
    if (override != null) return override;
    if (this._char_style == null) return true;
    return pyBool(cosGetOr(this._char_style, "4", true));
  }

  set autoLeading(value: boolean) {
    validateBool(value);
    this.__dict__.delete("autoLeading");
    if (this._char_style == null) {
      this._set_override("autoLeading", value);
      return;
    }
    const total = u16Len(_rawText(this));
    _applyCharKey(this, 0, total, "4", value);
    if (value) {
      _applyCharKey(this, 0, total, "5", pyfloat(0.01));
    }
    this._propagate_cos();
  }

  /** The Text layer's paragraph leading type. Read / Write. */
  declare leadingType: LeadingType;

  /** The Text layer's auto hyphenate option. Read / Write. */
  declare autoHyphenate: boolean | null;

  /** The Text layer's Roman Hanging Punctuation. Read / Write. */
  declare hangingRoman: boolean;

  /**
   * The Text layer's Every-Line Composer option. Read / Write.
   *
   * `true` when Every-Line Composer is used, `false` for Single-Line.
   */
  declare everyLineComposer: boolean;

  /** The Text layer's baseline direction. Read / Write. */
  declare baselineDirection: BaselineDirection;

  /** When `true`, ligature is used. Read / Write. */
  declare ligature: boolean;

  /** When `true`, the no-break attribute is applied. Read / Write. */
  declare noBreak: boolean;

  /** The Text layer's digit set option. Read / Write. */
  declare digitSet: DigitSet;

  /** The Text layer's line join type for strokes. Read / Write. */
  declare lineJoinType: LineJoinType;

  /** The Text layer's paragraph direction. Read / Write. */
  declare direction: ParagraphDirection;

  // -- Constructor -------------------------------------------------------

  /**
   * Build a {@link TextDocument} from the point-text COS template.
   *
   * Creates a document whose `_cos_data` and `_btdk_body` are wired
   * together so that descriptor / setter writes propagate to the
   * backing `btdk` chunk.
   *
   * @param text - Initial text content. When empty, the template's placeholder text is left
   *   unchanged.
   * @param boxSize - `[width, height]` for box (paragraph) text. When given, converts the document
   *   to box text; `null` leaves it as point text.
   * @param lineOrientation - Text {@link LineOrientation}. When given, sets the layer's
   *   orientation (e.g. vertical); `null` leaves the template's horizontal default.
   */
  constructor(text?: string, boxSize?: number[] | null, lineOrientation?: LineOrientation | null);
  /** `cls.__new__(cls)`: an uninitialized instance for {@link TextDocument._from_binary}. */
  constructor(token: typeof _NEW);
  constructor(
    text: string | typeof _NEW = "",
    boxSize: number[] | null = null,
    lineOrientation: LineOrientation | null = null,
  ) {
    if (text === _NEW) return;
    validateText(text);
    if (boxSize != null) validateBoxSize(boxSize);
    if (lineOrientation != null) validateEnum(LineOrientation)(lineOrientation);
    const cos = deepcopy(getCosTemplate());
    const btdk = new ListChunk({ list_type: "btdk", data: serialize(cos) });
    const doc = cosAt(cosItem(cosItem(cos, "1"), "1"), 0);
    const charStyle = cosItem(cosItem(cosItem(cosAt(cosItem(cosItem(cosItem(doc, "0"), "6"), "0"), 0), "0"), "0"), "6");
    const paraStyle = cosItem(cosItem(cosItem(cosAt(cosItem(cosItem(cosItem(doc, "0"), "5"), "0"), 0), "0"), "0"), "5");
    // The template is fixed: every dict it is read as is one.
    pyAssert(charStyle instanceof Map && paraStyle instanceof Map);
    const fonts = cosIter(cosItem(cosItem(cosItem(cos, "0"), "1"), "0")).map((entry) => {
      const fontEntry = cosItem(entry, "0");
      const fontData = cosItem(fontEntry, "0");
      pyAssert(fontEntry instanceof Map && fontData instanceof Map);
      return new FontObject({ _font_data: fontData, _font_entry: fontEntry });
    });
    this._char_style = charStyle;
    this._para_style = paraStyle;
    this._doc = doc;
    this._fonts = fonts;
    this._cos_data = cos;
    this._btdk_body = btdk;
    if (text) this.text = text;
    if (boxSize != null) this.boxTextSize = boxSize;
    if (lineOrientation != null) this.lineOrientation = lineOrientation;
  }

  static _from_binary(kw: {
    _char_style?: CosDict | null;
    _para_style?: CosDict | null;
    _doc: CosNode;
    _fonts: FontObject[];
    _cos_data: CosDict;
    _btdk_body: ListChunk;
    // Fallback kwargs for fields without COS backing
    text?: string | null;
    font?: string | null;
    font_object?: FontObject | null;
    fill_color?: number[] | null;
    stroke_color?: number[] | null;
    paragraph_count?: number | null;
    [key: string]: InstanceValue | undefined;
  }): TextDocument {
    /** Wrap parsed COS data as a `TextDocument`. */
    const {
      _char_style = null,
      _para_style = null,
      _doc,
      _fonts,
      _cos_data,
      _btdk_body,
      text = null,
      font = null,
      font_object = null,
      fill_color = null,
      stroke_color = null,
      paragraph_count = null,
      ...kwargs
    } = kw;
    // `cls.__new__(cls)` skips `__init__`; the field initializers restate
    // the class-level defaults.
    const obj = new TextDocument(_NEW);
    obj._char_style = _char_style;
    obj._para_style = _para_style;
    obj._doc = _doc;
    obj._fonts = _fonts;
    obj._cos_data = _cos_data;
    obj._btdk_body = _btdk_body;
    obj._associated = true;
    // Instance overrides for non-descriptor fields, plus any
    // CosField-backed kwargs
    const overrides = new Map<string, InstanceValue | undefined>([
      ["text", text],
      ["font", font],
      ["fontObject", font_object],
      ["fillColor", fill_color],
      ["strokeColor", stroke_color],
      ["paragraphCount", paragraph_count],
    ]);
    for (const [k, v] of Object.entries(kwargs)) overrides.set(k, v);
    for (const [key, val] of overrides) {
      if (val != null) obj.__dict__.set(key, val);
    }
    return obj;
  }

  _override(name: string): InstanceValue {
    /**
     * Instance override stored when a field has no COS backing.
     *
     * Set by `_from_binary` fallback kwargs and by setters when the
     * backing style dict is `null`. Returns `null` when absent.
     */
    return this.__dict__.get(name) ?? null;
  }

  /** {@link TextDocument._override} when it holds a `T` (the setters only store their own type). */
  _override_of<T extends InstanceValue>(name: string, accepts: (v: InstanceValue) => v is T): T | null {
    const value = this._override(name);
    return value != null && accepts(value) ? value : null;
  }

  _set_override(name: string, value: InstanceValue): void {
    /** Store an instance override for a field without COS backing. */
    this.__dict__.set(name, value);
  }

  // -- Computed properties -----------------------------------------------

  /** The text value for the Source Text property. Read / Write. */
  get text(): string {
    const override = this._override_of("text", isStr);
    if (override != null) return override;
    const val = cosGet(this._doc, "0", "0");
    if (val != null) {
      // AE stores line breaks as CR; present them as LF to callers.
      // Strip exactly the one terminator CR - further trailing CRs
      // are real line breaks (trailing empty paragraphs).
      const raw0 = str(val);
      const raw = raw0.endsWith("\r") ? raw0.slice(0, -1) : raw0;
      return raw.replaceAll("\r", "\n");
    }
    return "";
  }

  set text(value: string) {
    validateText(value);
    this.__dict__.delete("text");
    this._mark_layout_dirty();
    const inner = cosSetdefault(this._doc, "0", new Map());
    // AE stores every line break and the run terminator as CR (\r);
    // without a trailing CR terminator AE fails to read the layer.
    const normalized = value.replaceAll("\r\n", "\r").replaceAll("\n", "\r");
    const raw = normalized + "\r";
    this._rebuild_runs_for_text(raw);
    cosSetitem(inner, "0", raw);
    this._propagate_cos();
  }

  _rebuild_runs_for_text(raw: string): void {
    /**
     * Collapse the style runs for newly assigned text.
     *
     * AE resets styling on text assignment (probed via the
     * `RangesTextReset` fixture): the character runs collapse to a
     * single run carrying the first run's style over the whole text,
     * the paragraph runs become one clone of the first paragraph's
     * run per new paragraph, and manual-kerning runs are dropped.
     *
     * @param raw - The new stored text, including the terminator `\r`.
     */
    const inner = cosGetOr(this._doc, "0", new Map());
    const charRuns = cosGet(inner, "6", "0");
    if (Array.isArray(charRuns) && charRuns.length > 0) {
      cosSetitem(charRuns[0], "1", u16Len(raw));
      charRuns.splice(1);
    }
    const paraRuns = cosGet(inner, "5", "0");
    if (Array.isArray(paraRuns) && paraRuns.length > 0) {
      // One paragraph per CR; the final CR is the terminator, which
      // belongs to the last paragraph rather than opening a new one.
      let parts = raw.split("\r");
      if (parts.at(-1) === "") parts = parts.slice(0, -1);
      // Keep the first run object itself: `_para_style` (and the
      // parser's back-references) alias its style dict.
      const template = paraRuns[0];
      const rebuilt: CosNode[] = [template, ...parts.slice(1).map(() => deepcopy(template))];
      for (const [run, part] of zip(rebuilt, parts)) {
        cosSetitem(run, "1", u16Len(part) + 1);
      }
      paraRuns.splice(0, paraRuns.length, ...rebuilt);
      this._rebuild_line_count_runs(parts);
    }
    cosPop(inner, "8");
    cosPop(inner, "7");
  }

  _rebuild_line_count_runs(parts: string[]): void {
    /**
     * Keep `doc["1"]["1"]` (per-paragraph composed-line counts)
     * structurally consistent with the paragraphs.
     *
     * AE stores this cache-family array exactly when a document has
     * more than one paragraph (probed across all text fixtures) and
     * omits it otherwise. Counts of 1 are correct for point text
     * (paragraphs never wrap); for box text AE recomputes the real
     * counts when it next opens the file, like the `/PC` cache.
     */
    const state = cosDict(this._doc, "get").get("1");
    if (!(state instanceof Map)) return;
    if (parts.length <= 1) {
      state.delete("1");
      return;
    }
    const runs: CosNode[] = parts.map((part): CosDict => new Map<string, CosNode>([["0", new Map([["1", 1]])], ["1", u16Len(part) + 1]]));
    const lineCounts = (): CosDict => new Map([["0", runs]]);
    if (state.has("1")) {
      state.set("1", lineCounts());
      return;
    }
    // Fresh key: AE orders it between "0" and the /PC cache "2";
    // rebuild the dict to splice it in place (insertion order is
    // what the serializer emits).
    const items = [...state.entries()];
    state.clear();
    let inserted = false;
    for (const [key, value] of items) {
      if (key === "2" && !inserted) {
        state.set("1", lineCounts());
        inserted = true;
      }
      state.set(key, value);
    }
    if (!inserted) state.set("1", lineCounts());
  }

  // `fontFamily`, `fontStyle`, and `fontLocation` (deprecated ExtendScript
  // TextDocument fields) are deliberately not exposed: AE does not store them
  // in the .aep. It resolves them at runtime from the host font engine
  // (CoolType) given the stored PostScript name below, so their values are
  // host-dependent and not decodable from the binary. Use `font_object`.

  /** The Text layer's font PostScript name. Read / Write. */
  get font(): string | null {
    const override = this._override_of("font", isStr);
    if (override != null) return override;
    return this._font_at_style_index()?.postScriptName ?? null;
  }

  /** The font the first character style's index (`isinstance(.., int)`) points at, if in range. */
  _font_at_style_index(): FontObject | null {
    if (this._char_style == null) return null;
    const fontIdx = read(charStyle, this._char_style, "0");
    if (fontIdx == null) return null;
    const index = Number(fontIdx);
    return 0 <= index && index < this._fonts.length ? this._fonts[index] : null;
  }

  set font(value: string) {
    validateFontName(value);
    if (this._char_style == null) {
      this._set_override("font", value);
      return;
    }
    let idx = this._font_index(value);
    if (idx == null) idx = this._register_font(value);
    _applyCharKey(this, 0, u16Len(_rawText(this)), "0", idx);
    this.__dict__.delete("font");
    this.__dict__.delete("fontObject");
    this._propagate_cos();
  }

  _font_index(postScriptName: string): number | null {
    /** Return the index of a font in `_fonts`, or `null` if absent. */
    for (const [idx, fo] of this._fonts.entries()) {
      if (fo.postScriptName === postScriptName) return idx;
    }
    return null;
  }

  _register_font(postScriptName: string): number {
    /**
     * Prepend a new font to the COS font array and `_fonts`.
     *
     * AE inserts new fonts at index 0 and reindexes every existing
     * font reference (probed via the `W_FONT` / `W_PASTE_XDOC` write
     * fixtures). Returns the new font's index (always 0).
     */
    return _registerFontAt(this, postScriptName);
  }

  _used_font_objects(): FontObject[] {
    /**
     * The distinct fonts this document's character runs reference, in
     * first-appearance order.
     *
     * The document's `_fonts` table can hold entries no run points at
     * (AE keeps them after an edit), so the runs - not the table - are
     * authoritative for "used". An empty text layer still references a
     * font through its terminator run, which is what AE reports.
     */
    const used: FontObject[] = [];
    const seen = new Set<number>();
    for (const [, , style] of _charRunSpans(this)) {
      const fontIdx = read(charStyle, style, "0");
      if (fontIdx == null) continue;
      const index = Number(fontIdx);
      if (seen.has(index)) continue;
      if (0 <= index && index < this._fonts.length) {
        seen.add(index);
        used.push(this._fonts[index]);
      }
    }
    return used;
  }

  /** The Text layer's {@link FontObject}. Read-only. */
  get fontObject(): FontObject | null {
    const override = this._override_of("fontObject", isFontObject);
    if (override != null) return override;
    return this._font_at_style_index();
  }

  /** The Text layer's fill color as `[r, g, b]`. Read / Write. */
  get fillColor(): number[] | null {
    const override = this._override_of("fillColor", isRgb);
    if (override != null) return override;
    if (this._char_style != null) {
      return _parseColor(this._char_style.get("53") ?? null);
    }
    return null;
  }

  set fillColor(value: number[] | null) {
    if (value != null) validateRgbColor(value);
    this.__dict__.delete("fillColor");
    if (this._char_style != null) {
      const payload = value != null ? _buildColorPaint(value) : null;
      _applyCharKey(this, 0, u16Len(_rawText(this)), "53", payload);
      this._propagate_cos();
    } else {
      this._set_override("fillColor", value);
    }
  }

  /** The Text layer's stroke color as `[r, g, b]`. Read / Write. */
  get strokeColor(): number[] | null {
    const override = this._override_of("strokeColor", isRgb);
    if (override != null) return override;
    if (this._char_style != null) {
      return _parseColor(this._char_style.get("54") ?? null);
    }
    return null;
  }

  set strokeColor(value: number[] | null) {
    if (value != null) validateRgbColor(value);
    this.__dict__.delete("strokeColor");
    if (this._char_style != null) {
      const payload = value != null ? _buildColorPaint(value) : null;
      _applyCharKey(this, 0, u16Len(_rawText(this)), "54", payload);
      this._propagate_cos();
    } else {
      this._set_override("strokeColor", value);
    }
  }

  /**
   * The Text layer's spacing between lines. Read / Write.
   *
   * When auto-leading is enabled, returns font_size * auto_leading_factor.
   */
  get leading(): number | null {
    const override = this._override_of("leading", isNum);
    if (override != null) return override;
    if (this._char_style != null) {
      const raw = read(charStyle, this._char_style, "5");
      if (raw != null) {
        // When auto-leading is on, AE stores a sentinel in key "5"
        // and displays font_size * auto_leading_factor (para "7").
        if (this.autoLeading && this._para_style != null) {
          const factor = cosGetOr(this._para_style, "7", 1.2);
          const fs = this.fontSize;
          if (fs != null) return fs * cosFloat(factor);
        }
        return float(raw);
      }
    }
    return null;
  }

  set leading(value: number | null) {
    if (value != null) validatePositiveNumber(value);
    this.__dict__.delete("leading");
    if (this._char_style != null && value != null) {
      // Setting an explicit leading turns auto-leading off, matching AE.
      const total = u16Len(_rawText(this));
      _applyCharKey(this, 0, total, "5", pyfloat(value));
      _applyCharKey(this, 0, total, "4", false);
      this._propagate_cos();
    } else {
      this._set_override("leading", value);
    }
  }

  /** The number of paragraphs in the text layer. Read-only. */
  get paragraphCount(): number | null {
    const override = this._override_of("paragraphCount", isNum);
    if (override != null) return override;
    const paraRuns = cosGet(this._doc, "0", "5", "0");
    if (Array.isArray(paraRuns)) return paraRuns.length;
    return null;
  }

  /** `true` if a Text layer has All Caps enabled. Read-only. */
  get allCaps(): boolean | null {
    const caps = this.fontCapsOption;
    if (caps == null) return null;
    return caps === FontCapsOption.FONT_ALL_CAPS;
  }

  /** `true` if a Text layer has Small Caps enabled. Read-only. */
  get smallCaps(): boolean | null {
    const caps = this.fontCapsOption;
    if (caps == null) return null;
    return caps === FontCapsOption.FONT_SMALL_CAPS;
  }

  /** `true` if a Text layer has superscript enabled. Read-only. */
  get superscript(): boolean | null {
    const baseline = this.fontBaselineOption;
    if (baseline == null) return null;
    return baseline === FontBaselineOption.FONT_FAUXED_SUPERSCRIPT;
  }

  /** `true` if a Text layer has subscript enabled. Read-only. */
  get subscript(): boolean | null {
    const baseline = this.fontBaselineOption;
    if (baseline == null) return null;
    return baseline === FontBaselineOption.FONT_FAUXED_SUBSCRIPT;
  }

  /** The Text layer's composer engine type. Read-only. */
  get composerEngine(): ComposerEngine | null {
    const engineInfo = cosGet(this._cos_data, "1", "4");
    if (engineInfo instanceof Map) {
      const engineName = engineInfo.get("3");
      if (pyEq(engineName, "DVA")) return ComposerEngine.LATIN_CJK_ENGINE;
      if (pyEq(engineName, "Universal")) return ComposerEngine.UNIVERSAL_TYPE_ENGINE;
    }
    return null;
  }

  /**
   * The Text layer's kerning value. Read-only.
   *
   * Reads the leading-edge manual kern value AE stores at
   * `doc["0"]["7"]` - written only when a kerning set includes pair
   * position 0 (probed `W_KERN_START`). Documents without one read
   * `0`, which is also what ExtendScript exports for every probed
   * document-level read; per-character values live in the kerning
   * runs via `character_range(...).kerning`.
   */
  get kerning(): number | boolean {
    // `isinstance(val, int)`: a stored boolean reads back as itself.
    const val = cosGet(this._doc, "0", "7");
    return is(pyInt, val) ? val : 0;
  }

  /** The Text layer's line orientation. Read / Write. */
  get lineOrientation(): LineOrientation {
    const val = cosGet(this._cos_data, "0", "8", "0", 0, "0", "2", "1");
    if (is(pyInt, val)) return enumFromCos(LineOrientation, val);
    return LineOrientation.HORIZONTAL;
  }

  set lineOrientation(value: LineOrientation) {
    const frameMeta = cosGet(this._cos_data, "0", "8", "0", 0, "0", "2");
    if (!(frameMeta instanceof Map)) {
      throw new ValueError("text layer has no orientation frame to set");
    }
    this._mark_frame_layout_dirty();
    frameMeta.set("1", LineOrientation.to_binary(value));
    this._propagate_cos();
  }

  _box_frame(): CosDict | null {
    /** Return the COS box-frame dict, or `null` if absent. */
    const frame = cosGet(this._cos_data, "0", "8", "0", 0, "0");
    return frame instanceof Map ? frame : null;
  }

  _ensure_frame(): CosNode {
    /**
     * Return the box-frame dict, creating the COS path if needed.
     *
     * Marks the layout dirty first (on every sibling document - the
     * frame is layer-shared): every caller is a frame-meta setter
     * whose write can change line composition, and the mark (with
     * its calibration) must run before the mutation lands.
     */
    this._mark_frame_layout_dirty();
    const eight = cosSetdefault(cosSetdefault(this._cos_data, "0", new Map()), "8", new Map());
    const slot = cosSetdefault(eight, "0", [new Map()]);
    if (!pyBool(slot)) cosAppend(slot, new Map());
    return cosSetdefault(cosAt(slot, 0), "0", new Map());
  }

  _box_outline(): CosNode[] | null {
    /** Return the box's 16-vertex outline coordinates, or `null`. */
    const frame = this._box_frame();
    const coords = frame != null ? cosGet(frame, "1", "0") : null;
    if (Array.isArray(coords) && coords.length >= 14) return coords;
    return null;
  }

  /**
   * `true` if this is a box (paragraph) text layer. Read-only.
   *
   * Box text stores the bounding-box vertex array in the frame; point
   * text omits it.
   */
  get boxText(): boolean {
    const frame = this._box_frame();
    return frame instanceof Map && frame.get("1") instanceof Map;
  }

  /** `true` if this is a point text layer. Read-only. */
  get pointText(): boolean {
    return !this.boxText;
  }

  /**
   * The size of the text box as `[width, height]`. Read / Write.
   *
   * `null` for point text. Setting dimensions on point text converts
   * it into a box (paragraph) text layer; on box text it resizes the
   * box while keeping its top-left corner fixed.
   */
  get boxTextSize(): number[] | null {
    const coords = this._box_outline();
    if (coords == null) return null;
    return [Math.abs(cosNum(coords[12]) - cosNum(coords[0])), Math.abs(cosNum(coords[13]) - cosNum(coords[1]))];
  }

  set boxTextSize(value: number[]) {
    validateBoxSize(value);
    const width = value[0];
    const height = value[1];
    const frame = this._ensure_frame();
    const coords = this._box_outline();
    let left: number;
    let top: number;
    if (coords != null) {
      left = cosNum(coords[0]);
      top = cosNum(coords[1]);
    } else {
      // Point -> box conversion: AE centers the new box on the origin.
      left = -width / 2.0;
      top = -height / 2.0;
      _applyBoxConversion(cosSetdefault(frame, "2", new Map()));
    }
    cosSetitem(cosSetdefault(frame, "1", new Map()), "0", _boxCoords(left, top, width, height));
    this._propagate_cos();
  }

  /**
   * The top-left position of the text box as `[x, y]`. Read / Write.
   *
   * `null` for point text. Setting moves the box while keeping its
   * size; requires box (paragraph) text. Reads the stored coordinates
   * as they are (numbers in every file AE writes).
   */
  get boxTextPos(): CosUnboxed[] | null {
    const coords = this._box_outline();
    if (coords == null) return null;
    return [cosUnbox(coords[0]), cosUnbox(coords[1])];
  }

  set boxTextPos(value: number[]) {
    validateVector2(value);
    const coords = this._box_outline();
    if (coords == null) {
      throw new ValueError("boxTextPos requires box text; set boxTextSize first");
    }
    const width = Math.abs(cosNum(coords[12]) - cosNum(coords[0]));
    const height = Math.abs(cosNum(coords[13]) - cosNum(coords[1]));
    const frame = this._box_frame();
    pyAssert(frame != null);
    cosSetitem(cosItem(frame, "1"), "0", _boxCoords(value[0], value[1], width, height));
    this._propagate_cos();
  }

  /** The box's inset (padding) spacing in pixels. Read / Write. */
  get boxInsetSpacing(): number {
    const val = cosGet(this._box_frame(), "2", "9");
    return is(pyNumber, val) ? float(val) : 0.0;
  }

  set boxInsetSpacing(value: number) {
    _boxInsetSpacingSet.call(this, value);
  }

  /** The box's vertical text alignment. Read / Write. */
  get boxVerticalAlignment(): BoxVerticalAlignment {
    const raw = cosGet(this._box_frame(), "2", "13");
    if (is(pyInt, raw)) return enumFromCos(BoxVerticalAlignment, raw);
    return BoxVerticalAlignment.TOP;
  }

  set boxVerticalAlignment(value: BoxVerticalAlignment) {
    _boxVerticalAlignmentSet.call(this, value);
  }

  /** The box's auto-fit policy. Read / Write. */
  get boxAutoFitPolicy(): BoxAutoFitPolicy {
    const raw = cosGet(this._box_frame(), "2", "14");
    if (is(pyInt, raw)) return enumFromCos(BoxAutoFitPolicy, raw);
    return BoxAutoFitPolicy.NONE;
  }

  set boxAutoFitPolicy(value: BoxAutoFitPolicy) {
    _boxAutoFitPolicySet.call(this, value);
  }

  /** The box's first-baseline alignment. Read / Write. */
  get boxFirstBaselineAlignment(): BoxFirstBaselineAlignment {
    const sub = cosGet(this._box_frame(), "2", "10");
    const raw = sub instanceof Map ? read(firstBaseline, sub, "0") : undefined;
    if (raw != null) return enumFromCos(BoxFirstBaselineAlignment, raw);
    return BoxFirstBaselineAlignment.ASCENT;
  }

  set boxFirstBaselineAlignment(value: BoxFirstBaselineAlignment) {
    _boxFirstBaselineAlignmentSet.call(this, value);
  }

  /** The minimum for `MINIMUM_VALUE_*` first-baseline alignment. R/W. */
  get boxFirstBaselineAlignmentMinimum(): number {
    const sub = cosGet(this._box_frame(), "2", "10");
    const minimum = sub instanceof Map ? read(firstBaseline, sub, "1") : undefined;
    return minimum != null ? float(minimum) : 0.0;
  }

  set boxFirstBaselineAlignmentMinimum(value: number) {
    _boxFirstBaselineAlignmentMinimumSet.call(this, value);
  }

  /**
   * `true` if the text overflows the box. Read-only.
   *
   * A composition covers fewer characters than the stored text
   * exactly when the text overflows (probed via
   * `samples/models/text/box_overflow.aep`). Reads the persisted AE
   * cache while the document is untouched and the calibrated
   * composer after layout-affecting py-side writes (see
   * `composition_stale`). `null` for point text (ExtendScript reads
   * undefined there) and for documents without a cache.
   */
  get boxOverflow(): boolean | null {
    if (!this._associated || !this.boxText) return null;
    const spans = _composedLineSpans(this);
    if (spans == null) return null;
    if (spans.length === 0) {
      // The calibrated composer clipped every line (box shorter
      // than the first baseline): all stored text overflows. The
      // cached path never yields an empty list.
      return true;
    }
    return spans[spans.length - 1][1] < u16Len(_rawText(this));
  }

  /**
   * The number of composed lines in the Text layer. Read-only.
   *
   * Point text derives its lines from the paragraphs (always
   * fresh). Box text reads the layout cache AE persisted at save
   * time; after a layout-affecting py-side write the calibrated
   * composed-line resolver recomposes it, otherwise the cached
   * count stays (matching ExtendScript's un-reapplied values - see
   * `composition_stale`). `null` for documents never parsed from a
   * layer.
   */
  get composedLineCount(): number | null {
    if (!this._associated) return null;
    const spans = _composedLineSpans(this);
    if (spans == null) return null;
    return spans.length;
  }

  /**
   * The baseline (x,y) locations for a Text layer. Line wraps in a
   * paragraph text box are treated as multiple lines. Read-only.
   *
   * Four floats per composed line - `line.start_x, line.start_y, line.end_x, line.end_y` - in layer coordinates. Empty for
   * documents never parsed from a layer or without a layout cache.
   *
   * Tip:
   *     If a line has no characters, the x and y values for start and
   *     end are the maximum float value (`3.402823466e+38`).
   *
   * **Note:** Unlike {@link TextDocument.composedLineCount | composed_line_count},
   * this always reports the layout After Effects persisted: the
   * per-line pen origins and glyph advances only exist in that
   * cache, and the composed-line resolver does not reproduce them.
   * After a layout-affecting py-side write the values therefore
   * stay at the persisted layout even when the resolver could
   * recompose the line spans (see `composition_stale`).
   */
  get baselineLocs(): number[] {
    if (!this._associated) return [];
    const nodes = _cachedLineNodes(this);
    const data = _lineDataFromNodes(nodes);
    if (data == null) return [];
    const [spans] = data;
    const raw = _rawText(this);
    const visible = _visibleLength(this);
    // A box's cache origins are box-relative; box_text_pos is the
    // box's top-left corner in layer coordinates (probed AE 2026:
    // a 220x140 centered box reports -110/-70).
    const boxPos = this.boxText ? this.boxTextPos : null;
    const offsetX = boxPos != null ? cosFloat(boxPos[0]) : 0.0;
    const offsetY = boxPos != null ? cosFloat(boxPos[1]) : 0.0;
    const out: number[] = [];
    for (const [i, [start, end]] of spans.entries()) {
      const node = nodes[i];
      const advances = _lineAdvances(node);
      let lineText = u16Slice(raw, start, end);
      // The stored advances carry one entry per GLYPH, not per
      // character - a ligature ("ffi") merges several characters into
      // one. Rather than map characters to glyphs, count the glyphs to
      // drop from the END: a terminator, a character clipped past the
      // visible text and a trailing space are each exactly one glyph
      // (none of them ever joins a ligature), so this stays correct on
      // ligated text.
      let tail = 0;
      if (lineText.endsWith("\r")) {
        lineText = lineText.slice(0, -1);
        tail += 1;
      }
      const overshoot = Math.max(0, u16Len(lineText) - Math.max(0, visible - start));
      if (overshoot) {
        tail += overshoot;
        lineText = u16Slice(lineText, 0, u16Len(lineText) - overshoot);
      }
      if (lineText.length === 0 || advances.length === 0) {
        out.push(_EMPTY_LINE_LOC, _EMPTY_LINE_LOC, _EMPTY_LINE_LOC, _EMPTY_LINE_LOC);
        continue;
      }
      // A wrapped line keeps the space group it broke on, but that
      // group sits outside the reported extent (probed AE 2026).
      tail += u16Len(lineText) - u16Len(rstrip(lineText, " "));
      const index = advances.length - tail - 1;
      const advance = 0 <= index && index < advances.length ? advances[index] : 0.0;
      const [originX, originY] = _lineOrigin(node);
      const startX = originX + offsetX;
      const startY = originY + offsetY;
      out.push(startX, startY, startX + advance, startY);
    }
    return out;
  }

  /**
   * Character bounds of every paragraph as `{"start", "end"}`
   * records. Read-only.
   *
   * Matches {@link TextDocument.paragraphRange | paragraph_range} bounds
   * (paragraph spans clamped to the visible text) from one pass
   * over the paragraph runs; empty for documents never parsed from
   * a layer. Ground-truth validation compares this against
   * ExtendScript's per-paragraph dump.
   */
  get paragraphRanges(): { start: number; end: number }[] {
    if (!this._associated) return [];
    const visible = _visibleLength(this);
    return _paraRunSpans(this).map(([start, end]) => ({
      start: Math.min(start, visible),
      end: Math.min(end, visible),
    }));
  }

  /**
   * Character bounds of every composed line as `{"start", "end"}`
   * records. Read-only.
   *
   * Matches {@link TextDocument.composedLineRange | composed_line_range}
   * bounds (ends clamped to the visible text, stale cached lines
   * beyond it dropped) from one span derivation; empty for
   * documents never parsed from a layer or without a layout cache.
   * Like the other composed-line APIs, recomposes freshly when the
   * calibrated composer covers the document, otherwise reflects the
   * composition AE last persisted.
   */
  get composedLineRanges(): { start: number; end: number }[] {
    if (!this._associated) return [];
    const spans = _composedLineSpans(this);
    if (spans == null) return [];
    const visible = _visibleLength(this);
    const out: { start: number; end: number }[] = [];
    for (const [start, end] of spans) {
      if (start > visible) break; // stale cache: lines wholly beyond the current text
      out.push({ start, end: Math.min(end, visible) });
    }
    return out;
  }

  // -- Style resets --------------------------------------------------------

  /**
   * Restores all characters in the Text layer to the default text
   * character characteristics in the Character panel.
   *
   * After Effects applies its Character-panel defaults, which live in
   * the AE preferences rather than the project file (the
   * `["Text Style Sheet"]` section - the same values `addText` gives a
   * new layer). py_aep reads them from the preferences directory the
   * project was parsed with, and falls back to AE's factory values when
   * no preference file is available.
   *
   * **Note:** Attributes the Character panel does not carry are left alone,
   * matching After Effects.
   *
   * @throws {@link ValueError} If the document was never associated with a layer.
   */
  resetCharStyle(): void {
    this._require_association();
    const style = defaultCharacterStyle(this._effective_preferences());
    this.font = style.font;
    this.fontSize = style.font_size;
    this.fauxBold = style.faux_bold;
    this.fauxItalic = style.faux_italic;
    this.applyFill = style.apply_fill;
    this.fillColor = style.fill_color;
    // Set the stroke colour and width before the toggle: AE refuses to
    // read strokeColor once applyStroke is off, and py mirrors that.
    this.strokeColor = style.stroke_color;
    this.strokeWidth = style.stroke_width;
    this.strokeOverFill = style.stroke_over_fill;
    this.applyStroke = style.apply_stroke;
    this.tracking = style.tracking;
    this.tsume = style.tsume;
    this.horizontalScale = style.horizontal_scale;
    this.verticalScale = style.vertical_scale;
    this.baselineShift = style.baseline_shift;
    this.autoLeading = style.auto_leading;
    // Last: the panel's kerning mode also clears any MANUAL kerning
    // (probed AE 2026 - a reset takes autoKernType back to Metric and
    // the per-pair values become undefined).
    this.autoKernType = style.auto_kern_type;
  }

  /**
   * Restores all paragraphs in the Text layer to the default text
   * paragraph characteristics in the Paragraph panel.
   *
   * After Effects applies its Paragraph-panel defaults, which live in
   * the AE preferences rather than the project file (the
   * `["Text Paragraph Sheet"]` section). py_aep reads them from the
   * preferences directory the project was parsed with, and falls back to
   * AE's factory values when no preference file is available.
   *
   * **Note:** Hyphenation has no entry in that sheet, so - like After Effects -
   * this leaves {@link TextDocument.autoHyphenate | auto_hyphenate}
   * untouched.
   *
   * @throws {@link ValueError} If the document was never associated with a layer.
   */
  resetParagraphStyle(): void {
    this._require_association();
    const style = defaultParagraphStyle(this._effective_preferences());
    this.justification = style.justification;
    this.firstLineIndent = style.first_line_indent;
    this.startIndent = style.start_indent;
    this.endIndent = style.end_indent;
    this.spaceBefore = style.space_before;
    this.spaceAfter = style.space_after;
    this.hangingRoman = style.hanging_roman;
    this.everyLineComposer = style.every_line_composer;
  }

  _effective_preferences(): Preferences {
    /**
     * The project's AE preferences, or an empty set (AE factory
     * defaults) for a document parsed without a preferences directory.
     */
    if (this._preferences == null) return new Preferences();
    return this._preferences;
  }

  // -- Text ranges (AE 24.3+ ExtendScript API) -----------------------------

  _require_association(): void {
    /**
     * Raise unless this document was parsed from a layer's data.
     *
     * AE refuses every range API on a `new TextDocument()` never
     * fetched from a layer ("Unable to set value as it is not
     * associated with a layer."); template-constructed documents
     * behave identically here.
     */
    if (!this._associated) throw new ValueError(NOT_ASSOCIATED);
  }

  characterRange(
    characterStart: number,
    signedCharacterEnd: number | null = null,
  ): CharacterRange {
    /**
     * A {@link CharacterRange} over part of this document.
     *
     * @param character_start - First character index (UTF-16 units,
     *   `0 <= character_start <= text length`).
     * @param signed_character_end - Index past the last character. `-1` resolves dynamically to the
     *   text length; when omitted, defaults to `character_start + 1`.
     * @throws {@link ValueError} When the indices are outside the document bounds (AE raises at
     *   creation time).
     */
    this._require_association();
    validatePositiveInt(characterStart, this);
    if (signedCharacterEnd == null) {
      signedCharacterEnd = characterStart + 1;
    } else {
      validateInt(signedCharacterEnd, this);
    }
    return new CharacterRange(this, characterStart, signedCharacterEnd);
  }

  paragraphRange(
    paragraphIndexStart: number,
    signedParagraphIndexEnd: number | null = null,
  ): ParagraphRange {
    /**
     * A {@link ParagraphRange} over part of this document.
     *
     * @param paragraph_index_start - First paragraph index
     *   (`0 <= paragraph_index_start < paragraph count`).
     * @param signed_paragraph_index_end - Index past the last paragraph. `-1` resolves dynamically
     *   to the paragraph count; when omitted, defaults to `paragraph_index_start + 1`.
     * @throws {@link ValueError} When the indices are outside the document bounds (AE raises at
     *   creation time).
     */
    this._require_association();
    validatePositiveInt(paragraphIndexStart, this);
    if (signedParagraphIndexEnd == null) {
      signedParagraphIndexEnd = paragraphIndexStart + 1;
    } else {
      validateInt(signedParagraphIndexEnd, this);
    }
    return new ParagraphRange(this, paragraphIndexStart, signedParagraphIndexEnd);
  }

  composedLineRange(
    composedLineIndexStart: number,
    signedComposedLineIndexEnd: number | null = null,
  ): ComposedLineRange {
    /**
     * A {@link ComposedLineRange} over part of this document.
     *
     * Composed lines come from the layout cache AE persisted at save
     * time, or from the calibrated composed-line resolver after
     * py-side edits; see {@link ComposedLineRange} for the semantics.
     *
     * @param composed_line_index_start - First composed-line index
     *   (`0 <= composed_line_index_start < composed line count`).
     * @param signed_composed_line_index_end - Index past the last line. `-1` resolves dynamically
     *   to the line count; when omitted, defaults to `composed_line_index_start + 1`.
     * @throws {@link ValueError} When the indices are outside the cached composed lines (AE raises
     *   at creation time).
     */
    this._require_association();
    validatePositiveInt(composedLineIndexStart, this);
    if (signedComposedLineIndexEnd == null) {
      signedComposedLineIndexEnd = composedLineIndexStart + 1;
    } else {
      validateInt(signedComposedLineIndexEnd, this);
    }
    return new ComposedLineRange(this, composedLineIndexStart, signedComposedLineIndexEnd);
  }

  paragraphCharacterIndexesAt(characterIndex: number): { start: number; end: number } {
    /**
     * The character bounds of the paragraph containing an index.
     *
     * @param character_index - A character index (UTF-16 units) within the text.
     * @returns `{"start": int, "end": int}` for the containing paragraph.
     * @throws {@link ValueError} When `character_index` is outside the text.
     */
    this._require_association();
    validatePositiveInt(characterIndex, this);
    const visible = _visibleLength(this);
    for (const [start, end] of _paraRunSpans(this)) {
      if (start <= characterIndex && characterIndex < end) {
        return { start, end: Math.min(end, visible) };
      }
    }
    throw new ValueError(CHARACTER_RANGE_OOB);
  }

  composedLineCharacterIndexesAt(characterIndex: number): { start: number; end: number } {
    /**
     * The character bounds of the composed line containing an index.
     *
     * @param character_index - A character index (UTF-16 units) within the text.
     * @returns `{"start": int, "end": int}` for the containing composed line.
     * @throws {@link ValueError} When `character_index` is outside the text or the document has no
     *   composed-line cache.
     */
    this._require_association();
    validatePositiveInt(characterIndex, this);
    const visible = _visibleLength(this);
    const spans = _composedLineSpans(this);
    if (spans != null) {
      for (const [start, end] of spans) {
        if (start <= characterIndex && characterIndex < end) {
          return { start, end: Math.min(end, visible) };
        }
      }
    }
    throw new ValueError(CHARACTER_RANGE_OOB);
  }

  // -- COS write-back ----------------------------------------------------

  _propagate_cos(): void {
    /** Serialize COS data back to the btdk chunk's binary_data. */
    this._btdk_body.data = serialize(this._cos_data);
  }

}

// -- Class-body descriptors (`x = DocumentWideCosField.float(...)`) ------------
// Each `declare` above has its descriptor installed on the prototype here, in
// source order (pyrt `descriptor`, which also runs `__set_name__`).

descriptor(TextDocument, "fontSize", DocumentWideCosField.float("_char_style", "1", { default: null, validate: validatePositiveNonzeroNumber }));
descriptor(TextDocument, "fauxBold", DocumentWideCosField.bool("_char_style", "2", { default: null }));
descriptor(TextDocument, "fauxItalic", DocumentWideCosField.bool("_char_style", "3", { default: null }));
descriptor(TextDocument, "tracking", DocumentWideCosField.int("_char_style", "8", { default: null, validate: validateS4 }));
descriptor(TextDocument, "horizontalScale", DocumentWideCosField.float("_char_style", "6", { default: null, validate: validateNumber }));
descriptor(TextDocument, "verticalScale", DocumentWideCosField.float("_char_style", "7", { default: null, validate: validateNumber }));
descriptor(TextDocument, "baselineShift", DocumentWideCosField.float("_char_style", "9", { default: null, validate: validateNumber }));
descriptor(TextDocument, "fontCapsOption", DocumentWideCosField.enum(FontCapsOption, "_char_style", "12", { default: null }));
descriptor(TextDocument, "fontBaselineOption", DocumentWideCosField.enum(FontBaselineOption, "_char_style", "13", { default: null }));
descriptor(TextDocument, "tsume", DocumentWideCosField.float("_char_style", "36", { default: 0.0, validate: validateNormalizedFloat }));
descriptor(TextDocument, "applyFill", DocumentWideCosField.bool("_char_style", "56", { default: null }));
descriptor(TextDocument, "applyStroke", DocumentWideCosField.bool("_char_style", "57", { default: false }));
descriptor(TextDocument, "strokeOverFill", DocumentWideCosField.bool("_char_style", "58", { default: true }));
descriptor(TextDocument, "strokeWidth", DocumentWideCosField.float("_char_style", "63", { default: 1.0, validate: validatePositiveNonzeroNumber }));

descriptor(TextDocument, "justification", DocumentWideCosField.enum(ParagraphJustification, "_para_style", "0", { default: null }));
descriptor(TextDocument, "firstLineIndent", DocumentWideCosField.float("_para_style", "1", { default: 0.0, validate: validateNumber }));
descriptor(TextDocument, "startIndent", DocumentWideCosField.float("_para_style", "2", { default: 0.0, validate: validateNumber }));
descriptor(TextDocument, "endIndent", DocumentWideCosField.float("_para_style", "3", { default: 0.0, validate: validateNumber }));
descriptor(TextDocument, "spaceBefore", DocumentWideCosField.float("_para_style", "4", { default: 0.0, validate: validateNumber }));
descriptor(TextDocument, "spaceAfter", DocumentWideCosField.float("_para_style", "5", { default: 0.0, validate: validateNumber }));
descriptor(TextDocument, "leadingType", DocumentWideCosField.enum(LeadingType, "_para_style", "8", { default: LeadingType.ROMAN_LEADING_TYPE }));
descriptor(TextDocument, "autoHyphenate", DocumentWideCosField.bool("_para_style", "9", { default: null }));
descriptor(TextDocument, "hangingRoman", DocumentWideCosField.bool("_para_style", "21", { default: false }));
descriptor(TextDocument, "everyLineComposer", DocumentWideCosField.bool("_para_style", "29", { default: false }));
descriptor(TextDocument, "baselineDirection", DocumentWideCosField.enum(BaselineDirection, "_char_style", "35", { default: BaselineDirection.BASELINE_WITH_STREAM }));
descriptor(TextDocument, "ligature", DocumentWideCosField.bool("_char_style", "18", { default: false }));
descriptor(TextDocument, "noBreak", DocumentWideCosField.bool("_char_style", "52", { default: false }));
descriptor(TextDocument, "digitSet", DocumentWideCosField.enum(DigitSet, "_char_style", "70", { default: DigitSet.DEFAULT_DIGITS }));
descriptor(TextDocument, "lineJoinType", DocumentWideCosField.enum(LineJoinType, "_char_style", "62", { default: LineJoinType.LINE_JOIN_MITER }));
descriptor(TextDocument, "direction", DocumentWideCosField.enum(ParagraphDirection, "_para_style", "33", { default: ParagraphDirection.DIRECTION_LEFT_TO_RIGHT }));

// -- `@requires_version(24)` setter bodies --------------------------------
// The Python decorator wraps each setter; the gate runs before the body. The
// setters above forward to these wrappers.

export const _boxInsetSpacingSet = requiresVersion(24)(function box_inset_spacing(this: TextDocument, value: number): void {
  /** Setter body for `box_inset_spacing`. */
  validatePositiveNumber(value);
  const meta = cosSetdefault(this._ensure_frame(), "2", new Map());
  cosSetitem(meta, "9", pyfloat(value));
  _numericSort(cosDict(meta, "items"));
  this._propagate_cos();
});

export const _boxVerticalAlignmentSet = requiresVersion(24)(function box_vertical_alignment(this: TextDocument, value: BoxVerticalAlignment): void {
  /** Setter body for `box_vertical_alignment`. */
  const meta = cosSetdefault(this._ensure_frame(), "2", new Map());
  cosSetitem(meta, "13", BoxVerticalAlignment.to_binary(value));
  _numericSort(cosDict(meta, "items"));
  this._propagate_cos();
});

export const _boxAutoFitPolicySet = requiresVersion(24)(function box_auto_fit_policy(this: TextDocument, value: BoxAutoFitPolicy): void {
  /** Setter body for `box_auto_fit_policy`. */
  const meta = cosSetdefault(this._ensure_frame(), "2", new Map());
  cosSetitem(meta, "14", BoxAutoFitPolicy.to_binary(value));
  _numericSort(cosDict(meta, "items"));
  this._propagate_cos();
});

export const _boxFirstBaselineAlignmentSet = requiresVersion(24)(function box_first_baseline_alignment(
  this: TextDocument,
  value: BoxFirstBaselineAlignment,
): void {
  /** Setter body for `box_first_baseline_alignment`. */
  const meta = cosSetdefault(this._ensure_frame(), "2", new Map());
  const sub = cosSetdefault(meta, "10", new Map());
  cosSetitem(sub, "0", BoxFirstBaselineAlignment.to_binary(value));
  // AE always stores the minimum alongside the alignment.
  cosSetdefault(sub, "1", pyfloat(0.0));
  _numericSort(cosDict(meta, "items"));
  this._propagate_cos();
});

export const _boxFirstBaselineAlignmentMinimumSet = requiresVersion(24)(function box_first_baseline_alignment_minimum(this: TextDocument, value: number): void {
  /** Setter body for `box_first_baseline_alignment_minimum`. */
  const meta = cosSetdefault(this._ensure_frame(), "2", new Map());
  const sub = cosSetdefault(meta, "10", new Map());
  cosSetdefault(sub, "0", BoxFirstBaselineAlignment.to_binary(BoxFirstBaselineAlignment.ASCENT));
  cosSetitem(sub, "1", pyfloat(value));
  _numericSort(cosDict(meta, "items"));
  this._propagate_cos();
});
