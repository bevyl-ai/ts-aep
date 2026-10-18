/**
 * Flatten an SVG file into absolute-coordinate drawables.
 *
 * `readSvg` walks the document depth-first, accumulating transforms and
 * inherited styles, expands `<use>` references, drops SMIL animation and
 * non-rendered content, and emits one {@link SvgDrawable} per leaf shape in
 * document (paint) order - mirroring what After Effects produces for an SVG
 * imported as cropped-comp layers.
 */

import { FLOAT32_MAX } from "../binary/bin_utils.ts";
import { DEFAULT_FONT_SIZE, LengthContext, localName, parseLength, parseNumber, parseRatio } from "./_util.ts";
import { parseColor } from "./colors.ts";
import { canvas, viewportTransform } from "./document.ts";
import { UnsupportedSVGError } from "./errors.ts";
import { resolveFont as _resolveFontImpl } from "./fonts.ts";
/**
 * `monkeypatch.setattr(reader, "resolveFont", fn)` hook: ESM exports are
 * read-only, so the Python module-global lookup goes through this holder.
 */
export let _resolveFontOverride: typeof _resolveFontImpl | null = null;
export function _setResolveFont(fn: typeof _resolveFontImpl | null): void {
  _resolveFontOverride = fn;
}
function resolveFont(...args: Parameters<typeof _resolveFontImpl>): ReturnType<typeof _resolveFontImpl> {
  return (_resolveFontOverride ?? _resolveFontImpl)(...args);
}

import { type GradientDef, collectGradients, resolveGradient } from "./gradients.ts";
import type { RawSubpath } from "./path_data.ts";
import { cubicsToSubpath, elementSubpaths } from "./shapes.ts";
import { type CssRule, parseCss, resolveProperties } from "./style.ts";
import { TextRun, outlineRuns, outlineTextPath } from "./text.ts";
import { Affine, parseTransform } from "./transform.ts";
import { GradientStop, SolidPaint, StrokeStyle, SvgDocument, SvgDrawable, type GradientPaint, type Subpath } from "./types.ts";
import {
  Path,
  encode,
  fspath,
  isdigit,
  warn,
  zip,
  type PathLike,
} from "../../pyrt/index.ts";

import { Element, ParseError, fromstring } from "../../pyrt/etree.ts";

export type Bbox = [number, number, number, number];
export type Paint = SolidPaint | GradientPaint | null;

export const _DRAWABLE_TAGS: ReadonlySet<string> = new Set([
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
]);
export const _CONTAINER_TAGS: ReadonlySet<string> = new Set(["g", "a", "svg"]);
// Non-rendered or definition-only elements skipped without recursing into
// them for drawables (gradients/symbols are resolved on demand elsewhere).
export const _SKIP_TAGS: ReadonlySet<string> = new Set([
  "defs",
  "symbol",
  "title",
  "desc",
  "metadata",
  "style",
  "script",
  "linearGradient",
  "radialGradient",
  "pattern",
  "clipPath",
  "mask",
  "filter",
  "marker",
  "animate",
  "animateTransform",
  "animateMotion",
  "animateColor",
  "set",
  "mpath",
  "switch",
  "foreignObject",
]);
// Unsupported as standalone elements: `<tspan>`/`<textPath>` outside a `<text>`
// (invalid SVG); within a `<text>`, _visit_text renders both. Raster `<image>` is
// handled in _visit (skipped with a warning - it is not yet rendered).
export const _UNSUPPORTED_TAGS: ReadonlySet<string> = new Set(["tspan", "textPath"]);

// Bound on container nesting (<g>/<svg>/<use>) so a pathologically deep
// document raises a clean UnsupportedSVGError instead of a RecursionError.
// Each level costs ~2 Python frames (walk -> _visit -> walk), so this stays
// well under the interpreter's ~1000-frame recursion limit; no real SVG nests
// anywhere near this deep.
export const _MAX_SVG_DEPTH = 250;

// Maps are used (not object literals) so lookups of arbitrary attribute values
// such as "constructor" cannot hit Object.prototype.
export const _CAP: Map<string, number> = new Map([
  ["butt", 1],
  ["round", 2],
  ["square", 3],
]);
export const _JOIN: Map<string, number> = new Map([
  ["miter", 1],
  ["round", 2],
  ["bevel", 3],
]);
// Python `re.match` anchors at the start of the string, hence the `^`.
// `\s` is spelled out: CPython's str `\s` matches \x1c-\x1f and \x85 but not \ufeff.
export const _PY_WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
export const _URL_RE = new RegExp(`^url\\([${_PY_WS}]*#([^)${_PY_WS}]+)[${_PY_WS}]*\\)`);

/**
 * Parse an SVG file into a flattened {@link SvgDocument}.
 *
 * @param source - Path to an `.svg` file, or its raw bytes/markup.
 * @returns The flattened document (canvas size + drawables).
 * @throws UnsupportedSVGError For SVG features py_aep cannot import, and for
 *   a file that is not well-formed XML.
 */
export function readSvg(source: string | PathLike | Uint8Array): SvgDocument {
  let data: Uint8Array;
  if (source instanceof Uint8Array) {
    data = source.slice();
  } else if (typeof source === "string" && source.trimStart().startsWith("<")) {
    data = encode(source, "utf-8");
  } else {
    data = new Path(fspath(source)).readBytes();
  }
  let root: Element;
  try {
    root = fromstring(data);
  } catch (exc) {
    if (!(exc instanceof ParseError)) throw exc;
    throw Object.assign(
      new UnsupportedSVGError(`Malformed SVG (not well-formed XML): ${exc.message}`),
      { cause: exc },
    );
  }
  if (localName(root.tag) !== "svg") {
    throw new UnsupportedSVGError(`Root element is <${localName(root.tag)}>, not <svg>`);
  }

  let [width, height, rootTf] = canvas(root);
  const reader = new _Reader(root);
  // The root <svg>'s own presentation attributes (e.g. fill="none") form
  // the inherited base for all children.
  const rootStyle = resolveProperties(new Map(), "svg", root.attrib, reader._css);
  rootTf = rootTf.multiply(parseTransform(root.get("transform", "")));
  reader._rootCtm = rootTf;
  reader._viewport = [width, height];
  const rootOpacity = parseRatio(rootStyle.get("opacity") ?? null, 1.0);
  const drawables = reader.walk(root, rootTf, rootStyle, rootOpacity);
  return new SvgDocument(width, height, drawables);
}

export class _Reader {
  _gradients: Map<string, GradientDef>;
  _css: CssRule[];
  _byId: Map<string, Element>;
  _root: Element;
  // Child -> parent map for reconstructing a by-id element's accumulated
  // transform (ElementTree has no parent links). Built lazily on first
  // _element_ctm call - only <textPath> needs it, so the common SVG with
  // no text path never pays for the whole-tree walk. `_rootCtm` is the
  // base (viewBox + root transform), set by read_svg before the walk.
  _parents: Map<Element, Element> | null;
  _rootCtm: Affine;
  _viewport: [number, number];
  _useStack: string[];

  constructor(root: Element) {
    this._gradients = collectGradients(root);
    this._css = _Reader._collectCss(root);
    this._byId = new Map();
    for (const elem of root.iter()) {
      const eid = elem.get("id");
      if (eid) this._byId.set(eid, elem);
    }
    this._root = root;
    this._parents = null;
    this._rootCtm = new Affine();
    this._viewport = [0.0, 0.0];
    this._useStack = [];
  }

  static _collectCss(root: Element): CssRule[] {
    const rules: CssRule[] = [];
    for (const elem of root.iter()) {
      if (localName(elem.tag) === "style" && elem.text) {
        rules.push(...parseCss(elem.text));
      }
    }
    return rules;
  }

  /**
   * Accumulated transform of `elem`: the root base (viewBox + root
   * transform) composed with every ancestor's `transform` down to and
   * including `elem`'s own.
   */
  _elementCtm(elem: Element): Affine {
    if (this._parents == null) {
      this._parents = new Map();
      for (const parent of this._root.iter()) {
        for (const child of parent) this._parents.set(child, parent);
      }
    }
    const chain: Element[] = [];
    let cur: Element | null = elem;
    while (cur != null && this._parents.has(cur)) {
      chain.push(cur);
      cur = this._parents.get(cur) ?? null;
    }
    let ctm = this._rootCtm;
    for (const node of [...chain].reverse()) {
      ctm = ctm.multiply(parseTransform(node.get("transform", "")));
    }
    return ctm;
  }

  walk(
    elem: Element,
    ctm: Affine,
    parentStyle: Map<string, string>,
    opacity: number,
    depth = 0,
  ): SvgDrawable[] {
    if (depth > _MAX_SVG_DEPTH) throw new UnsupportedSVGError("SVG container nesting too deep");
    const out: SvgDrawable[] = [];
    for (const child of elem) {
      this._visit(child, ctm, parentStyle, opacity, out, depth);
    }
    return out;
  }

  _visit(
    elem: Element,
    ctm: Affine,
    parentStyle: Map<string, string>,
    opacity: number,
    out: SvgDrawable[],
    depth = 0,
  ): void {
    const tag = localName(elem.tag);
    if (_SKIP_TAGS.has(tag)) return;
    if (tag === "image") {
      // Raster <image> is not rendered (AE drops it too). Unlike the
      // silent _SKIP_TAGS, warn once - it is visible content the author
      // expected to appear.
      warn("SVG <image> elements are not imported (skipped).");
      return;
    }
    if (_UNSUPPORTED_TAGS.has(tag)) throw new UnsupportedSVGError(`Unsupported element: <${tag}>`);

    const style = resolveProperties(parentStyle, tag, elem.attrib, this._css);
    if ((style.get("display") ?? null) === "none") return;
    const localTf = ctm.multiply(parseTransform(elem.get("transform", "")));
    // `opacity` is a non-inherited compositing factor; AE flattens an SVG
    // group/element opacity by multiplying it into the leaf's paint
    // opacity, so accumulate it down the tree and fold it into the leaf.
    const effOpacity = opacity * parseRatio(style.get("opacity") ?? null, 1.0);

    if (tag === "svg") {
      this._visitViewport(elem, localTf, style, effOpacity, out, depth);
      return;
    }
    if (_CONTAINER_TAGS.has(tag)) {
      for (const d of this.walk(elem, localTf, style, effOpacity, depth + 1)) out.push(d);
      return;
    }
    if (tag === "use") {
      this._visitUse(elem, localTf, style, effOpacity, out, depth);
      return;
    }
    if (tag === "text") {
      this._visitText(elem, localTf, style, effOpacity, out);
      return;
    }
    if (_DRAWABLE_TAGS.has(tag)) {
      const drawable = this._buildDrawable(tag, elem, localTf, style, effOpacity);
      if (drawable != null) out.push(drawable);
      return;
    }
    // Unknown element: ignore (forward-compatible) but recurse in case
    // it wraps drawables.
    for (const d of this.walk(elem, localTf, style, effOpacity, depth + 1)) out.push(d);
  }

  /**
   * What this element's percentage and `em` lengths resolve against:
   * the nearest viewport and its font size.
   */
  _ctx(style: Map<string, string>): LengthContext {
    const fontSize = parseLength(
      style.get("font-size") ?? null,
      DEFAULT_FONT_SIZE,
      DEFAULT_FONT_SIZE,
      DEFAULT_FONT_SIZE,
    );
    return new LengthContext(this._viewport[0], this._viewport[1], fontSize);
  }

  /**
   * A nested `<svg>` is a new viewport (SVG 1.1 7.9): `x / y / width / height` place it (100 % of the parent viewport by default)
   * and its viewBox maps onto that box under `preserveAspectRatio`, as
   * AE 2026 imports it. Its content is not clipped (AE clips it).
   */
  _visitViewport(
    elem: Element,
    ctm: Affine,
    style: Map<string, string>,
    opacity: number,
    out: SvgDrawable[],
    depth: number,
  ): void {
    const ctx = this._ctx(style);
    const x = parseLength(elem.get("x"), 0.0, ctx.width, ctx.fontSize);
    const y = parseLength(elem.get("y"), 0.0, ctx.height, ctx.fontSize);
    this._walkViewport(elem, elem, ctm, style, opacity, out, depth, x, y);
  }

  /**
   * Walk the children of a viewport element (a nested `<svg>`, or the
   * `<symbol>` / `<svg>` a `<use>` instantiates), its viewBox mapped
   * onto the `x, y` box sized by `sizing`'s width / height (falling back
   * to the viewport's own, then 100 %).
   */
  _walkViewport(
    viewport: Element,
    sizing: Element,
    ctm: Affine,
    style: Map<string, string>,
    opacity: number,
    out: SvgDrawable[],
    depth: number,
    x: number,
    y: number,
  ): void {
    const ctx = this._ctx(style);
    const width = parseLength(
      sizing.get("width") || viewport.get("width"),
      ctx.width,
      ctx.width,
      ctx.fontSize,
    );
    const height = parseLength(
      sizing.get("height") || viewport.get("height"),
      ctx.height,
      ctx.height,
      ctx.fontSize,
    );
    const [tf, size] = viewportTransform(
      viewport.get("viewBox"),
      viewport.get("preserveAspectRatio"),
      x,
      y,
      width,
      height,
    );
    const parentViewport = this._viewport;
    this._viewport = size;
    try {
      for (const d of this.walk(viewport, ctm.multiply(tf), style, opacity, depth + 1)) out.push(d);
    } finally {
      this._viewport = parentViewport;
    }
  }

  _visitUse(
    elem: Element,
    ctm: Affine,
    style: Map<string, string>,
    opacity: number,
    out: SvgDrawable[],
    depth = 0,
  ): void {
    const ref = elem.get("href") || elem.get("{http://www.w3.org/1999/xlink}href");
    if (!ref || !ref.startsWith("#")) return;
    const targetId = ref.slice(1);
    if (this._useStack.includes(targetId)) {
      throw new UnsupportedSVGError(`Recursive <use> reference: #${targetId}`);
    }
    const target = this._byId.get(targetId) ?? null;
    if (target == null) return;
    const ctx = this._ctx(style);
    const x = parseLength(elem.get("x"), 0.0, ctx.width, ctx.fontSize);
    const y = parseLength(elem.get("y"), 0.0, ctx.height, ctx.fontSize);
    const useTf = ctm.multiply(new Affine(1.0, 0.0, 0.0, 1.0, x, y));
    this._useStack.push(targetId);
    try {
      const tTag = localName(target.tag);
      if (tTag === "symbol" || tTag === "svg") {
        // The instance is a viewport sized by the <use> (AE 2026
        // maps a 10 x 10 symbol viewBox onto `width="50"`).
        this._walkViewport(target, elem, useTf, style, opacity, out, depth, 0.0, 0.0);
      } else {
        this._visit(target, useTf, style, opacity, out, depth);
      }
    } finally {
      this._useStack.pop();
    }
  }

  _visitText(
    elem: Element,
    ctm: Affine,
    style: Map<string, string>,
    opacity: number,
    out: SvgDrawable[],
  ): void {
    // A <text> is outlined into vector shapes: its direct text and each
    // <tspan> become a run (carrying its own font/fill), laid out
    // left-to-right. <textPath> children are dispatched to _add_text_path;
    // a run with an absolute x starts a new anchor chunk (outline_runs).
    if ((style.get("visibility") ?? null) === "hidden") return;
    const runs: [TextRun, Map<string, string>][] = [];
    if (elem.text && elem.text.trim()) {
      const run = this._makeRun(elem.text, style, null);
      if (run != null) runs.push([run, style]);
    }
    for (const child of elem) {
      const ctag = localName(child.tag);
      if (ctag === "tspan") {
        const cstyle = resolveProperties(style, "tspan", child.attrib, this._css);
        if (child.text && child.text.trim()) {
          const run = this._makeRun(child.text, cstyle, child);
          if (run != null) runs.push([run, cstyle]);
        }
      } else if (ctag === "textPath") {
        this._addTextPath(elem, child, style, opacity, out);
      }
      // Text after a child element (its `tail`) belongs to the parent.
      const tail = child.tail;
      if (tail && tail.trim()) {
        const run = this._makeRun(tail, style, null);
        if (run != null) runs.push([run, style]);
      } else if (tail && !tail.trim() && runs.length > 0) {
        // A whitespace-only tail between two runs (e.g.
        // `<tspan>foo</tspan> <tspan>bar</tspan>`) is a significant SVG
        // space that collapses to one space. Fold it into the preceding
        // run so the pen advances by a space glyph before the next run,
        // rather than laying the runs out flush. A leading whitespace-
        // only tail (no prior run) is document-leading and dropped.
        const lastRun = runs[runs.length - 1][0];
        if (!lastRun.text.endsWith(" ")) lastRun.text += " ";
      }
    }
    if (runs.length === 0) return;
    // Trim the whole sequence's leading/trailing whitespace (each run's
    // internal whitespace was already collapsed in _make_run); a single
    // space between runs stays significant.
    runs[0][0].text = runs[0][0].text.replace(/^ +/, "");
    const last = runs[runs.length - 1][0];
    last.text = last.text.replace(/ +$/, "");
    const originX = parseNumber(elem.get("x", "0"));
    const originY = parseNumber(elem.get("y", "0"));
    const anchor = (style.get("text-anchor") || "start").trim();
    const perRun = outlineRuns(
      runs.map(([r]) => r),
      originX,
      originY,
      ctm,
      anchor,
    );
    for (const [[, runStyle], subpaths] of zip(runs, perRun)) {
      if (!subpaths?.length) continue;
      out.push(this._emit(subpaths, runStyle, ctm, elem.get("id"), opacity));
    }
  }

  _makeRun(text: string, style: Map<string, string>, elem: Element | null): TextRun | null {
    // Font is resolved from the cascaded/inherited style; position
    // attributes (x/y/dx/dy) come from the run's own element.
    text = _collapseWs(text);
    const family = style.get("font-family") ?? "sans-serif";
    const weight = (style.get("font-weight") || "").trim();
    const fontStyle = (style.get("font-style") || "").trim();
    const bold = ["bold", "bolder"].includes(weight) || (isdigit(weight) && Number.parseInt(weight, 10) >= 600);
    const italic = ["italic", "oblique"].includes(fontStyle);
    const resolved = resolveFont(family, { bold, italic });
    if (resolved == null) return null;
    const [fontPath, fontNumber] = resolved;
    const absX =
      elem != null && elem.get("x") ? parseNumber(elem.get("x")) : null;
    const absY =
      elem != null && elem.get("y") ? parseNumber(elem.get("y")) : null;
    const dx = elem != null && elem.get("dx") ? parseNumber(elem.get("dx")) : 0.0;
    const dy = elem != null && elem.get("dy") ? parseNumber(elem.get("dy")) : 0.0;
    // TextRun fields in declaration order: text, font_path, font_size,
    // letter_spacing, abs_x, abs_y, dx, dy, anchor, font_number.
    return new TextRun(
      text,
      fontPath,
      parseNumber(style.get("font-size") || "16"),
      parseNumber(style.get("letter-spacing") || "0"),
      absX,
      absY,
      dx,
      dy,
      (style.get("text-anchor") || "").trim() || null,
      fontNumber,
    );
  }

  _addTextPath(
    textElem: Element,
    tpElem: Element,
    parentStyle: Map<string, string>,
    opacity: number,
    out: SvgDrawable[],
  ): void {
    // A <textPath> lays its text along a referenced path's geometry, in the
    // path's own coordinate space (its accumulated transform).
    const href = tpElem.get("href") || tpElem.get("{http://www.w3.org/1999/xlink}href");
    if (!href || !href.startsWith("#")) return;
    const target = this._byId.get(href.slice(1)) ?? null;
    if (target == null || !(tpElem.text && tpElem.text.trim())) {
      return;
    }
    const ctm = this._elementCtm(target);
    const style = resolveProperties(parentStyle, "textPath", tpElem.attrib, this._css);
    const run = this._makeRun(tpElem.text, style, null);
    if (run == null) return;
    let path: RawSubpath[];
    try {
      path = elementSubpaths(localName(target.tag), target.attrib, this._ctx(style));
    } catch (e) {
      if (!(e instanceof UnsupportedSVGError)) throw e;
      return; // referenced element is not a path/basic shape
    }
    const rawOff = (tpElem.get("startOffset") || "0").trim();
    let offAbs: number;
    let offFrac: number | null;
    if (rawOff.endsWith("%")) {
      offAbs = 0.0;
      offFrac = parseNumber(rawOff) / 100.0;
    } else {
      offAbs = parseNumber(rawOff);
      offFrac = null;
    }
    const subpaths = outlineTextPath(
      _collapseWs(tpElem.text).trim(),
      path,
      run.fontPath,
      run.fontSize,
      ctm,
      {
        fontNumber: run.fontNumber,
        startOffset: offAbs,
        startOffsetFrac: offFrac,
        letterSpacing: run.letterSpacing,
      },
    );
    if (!subpaths?.length) return;
    out.push(this._emit(subpaths, style, ctm, textElem.get("id"), opacity));
  }

  _buildDrawable(
    tag: string,
    elem: Element,
    ctm: Affine,
    style: Map<string, string>,
    opacity: number,
  ): SvgDrawable | null {
    const raws = elementSubpaths(tag, elem.attrib, this._ctx(style));
    const subpaths: Subpath[] = [];
    for (const raw of raws) {
      const sp = cubicsToSubpath(raw, ctm);
      if (sp != null) subpaths.push(sp);
    }
    if (subpaths.length === 0) return null;
    if ((style.get("visibility") ?? null) === "hidden") return null;

    // `opacity` already includes this element's own opacity (folded in by
    // the caller alongside every ancestor's), so use it directly.
    const drawable = this._emit(subpaths, style, ctm, elem.get("id"), opacity);
    if (tag === "line") {
      // A line has no interior, so its fill paints nothing; AE 2026
      // adds only the Stroke.
      drawable.fill = null;
    }
    return drawable;
  }

  _emit(
    subpaths: Subpath[],
    style: Map<string, string>,
    ctm: Affine,
    name: string | null,
    opacity: number,
  ): SvgDrawable {
    if (
      !subpaths.every((sp) =>
        [sp.vertices, sp.inTangents, sp.outTangents].every((points) =>
          points.every((point) => point.every((c) => Math.abs(c) <= FLOAT32_MAX)),
        ),
      )
    ) {
      // Shape paths store float32 points; a larger number (or one past
      // the float range, `1e400`, read as infinity) cannot be saved.
      throw new UnsupportedSVGError("SVG coordinate is out of range");
    }
    const bbox = _bbox(subpaths);
    return new SvgDrawable(
      subpaths,
      this._paint(style.get("fill") ?? "black", style.get("fill-opacity") ?? null, bbox, ctm),
      this._stroke(style, bbox, ctm),
      name,
      opacity,
    );
  }

  /**
   * A fill or stroke paint, its `fill-opacity` / `stroke-opacity`
   * (`opacity`) folded into its alpha: a color's own, or every gradient
   * stop's. After Effects' own SVG import ignores both attributes
   * (AE 2026: a 0.5 stroke-opacity imports at 100 %).
   */
  _paint(value: string | null, opacity: string | null, bbox: Bbox, ctm: Affine): Paint {
    if (value == null) return null;
    value = value.trim();
    if (value === "none") return null;
    const alpha = parseRatio(opacity, 1.0);
    const url = _URL_RE.exec(value);
    if (url) {
      const gd = this._gradients.get(url[1]) ?? null;
      if (gd == null || !gd.stops?.length) {
        // Unknown paint server (pattern, missing gradient): no paint.
        return null;
      }
      const gradient = resolveGradient(gd, bbox, ctm, this._viewport);
      gradient.stops = gradient.stops.map(
        (s) =>
          new GradientStop(s.offset, [s.color[0], s.color[1], s.color[2], s.color[3] * alpha]),
      );
      return gradient;
    }
    const color = parseColor(value);
    if (color == null) return null;
    return new SolidPaint([color[0], color[1], color[2], color[3] * alpha]);
  }

  _stroke(style: Map<string, string>, bbox: Bbox, ctm: Affine): StrokeStyle | null {
    const paint = this._paint(
      style.get("stroke") ?? "none",
      style.get("stroke-opacity") ?? null,
      bbox,
      ctm,
    );
    if (paint == null) return null;
    const ctx = this._ctx(style);
    // A percentage width refers to the viewport's normalized diagonal
    // (AE 2026: 5 % of a 200 x 100 viewBox is 7.906).
    const width =
      parseLength(style.get("stroke-width") ?? null, 1.0, ctx.diagonal, ctx.fontSize) *
      ctm.meanScale;
    if (width <= 0) return null;
    if (!Number.isFinite(width)) throw new UnsupportedSVGError("SVG stroke-width is out of range");
    const cap = _CAP.get((style.get("stroke-linecap") || "").trim()) ?? 1;
    const join = _JOIN.get((style.get("stroke-linejoin") || "").trim()) ?? 1;
    // SVG requires a miter limit >= 1 (AE's Miter Limit too); AE 2026
    // imports a smaller one clamped to 1.
    const miter = Math.max(1.0, parseNumber(style.get("stroke-miterlimit") ?? "4"));
    const dashes = (style.get("stroke-dasharray") || "").trim()
      .split(new RegExp(`[,${_PY_WS}]+`))
      .filter((t) => !!t && t !== "none")
      .map((t) => parseNumber(t) * ctm.meanScale);
    return new StrokeStyle(paint, width, cap, join, miter, dashes);
  }
}

export function _bbox(subpaths: Subpath[]): Bbox {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const sp of subpaths) {
    for (const [vx, vy] of sp.vertices) {
      xs.push(vx);
      ys.push(vy);
    }
  }
  if (xs.length === 0) return [0.0, 0.0, 0.0, 0.0];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export const _WS_RE = new RegExp(`[${_PY_WS}]+`, "g");

/**
 * Collapse internal whitespace runs (incl. newlines/tabs) to one space.
 *
 * SVG default white-space handling renders a run of source whitespace as a
 * single space; without this, the indentation of a pretty-printed `<text>`
 * is laid out as leading glyph advances. Edge spaces are kept here and
 * trimmed once across the whole run sequence by the caller.
 */
export function _collapseWs(text: string): string {
  return text.replace(_WS_RE, " ");
}
