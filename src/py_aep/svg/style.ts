/**
 * SVG style resolution: CSS cascade + inheritance.
 *
 * Resolves the effective presentation properties for an element by
 * combining (weakest to strongest): inherited values, presentation
 * attributes, matching `<style>` rules ordered by specificity, and the
 * inline `style` attribute.
 */

import { contains, compare } from "../../pyrt/index.ts";

// Presentation properties py_aep tracks (the paintable subset plus the text
// properties needed to outline `<text>`/`<tspan>`).
const _TRACKED: readonly string[] = [
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-opacity",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "color",
  "opacity",
  "display",
  "visibility",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "letter-spacing",
];
// Properties that inherit from parent to child (CSS-defined). Of the tracked
// set, only `opacity` and `display` do NOT inherit (`visibility` does).
const INHERITABLE: ReadonlySet<string> = new Set(_TRACKED.filter((k) => k !== "opacity" && k !== "display"));

/**
 * A parsed CSS rule: one selector with its declarations (`important`:
 * those flagged `!important`, which outrank the inline style).
 */
export class CssRule {
  readonly specificity: [number, number, number];
  readonly order: number;
  readonly selector: string;
  readonly declarations: Map<string, string>;
  readonly important: Map<string, string>;

  constructor(
    specificity: [number, number, number],
    order: number,
    selector: string,
    declarations: Map<string, string>,
    important: Map<string, string>,
  ) {
    this.specificity = specificity;
    this.order = order;
    this.selector = selector;
    this.declarations = declarations;
    this.important = important;
  }

  *[Symbol.iterator]() {
    yield this.specificity;
    yield this.order;
    yield this.selector;
    yield this.declarations;
    yield this.important;
  }
}

const _RULE_RE = /([^{}]+)\{([^{}]*)\}/g;

/** Parse a `<style>` block into rules (comma groups split out).
 *
 * Supports simple selectors: `tag`, `.class`, `#id`, `*`, and chains
 * of those (e.g. `rect.foo`). Combinators and pseudo-classes are not
 * matched (treated as never-matching).
 */
export function parseCss(text: string): CssRule[] {
  const rules: CssRule[] = [];
  text = text.replace(/\/\*.*?\*\//gs, "");
  let order = 0;
  for (const [, selGroup, body] of text.matchAll(_RULE_RE)) {
    const [decls, important] = _splitDeclarations(body);
    if (!decls?.size) continue;
    for (const raw of selGroup.split(",")) {
      const sel = raw.trim();
      if (!sel) continue;
      rules.push(new CssRule(_specificity(sel), order, sel, decls, important));
      order += 1;
    }
  }
  return rules;
}

const _IMPORTANT_RE = /\s*!\s*important\s*$/i;

/** `(declarations, the !important ones)` of a declaration block. */
export function _splitDeclarations(
  body: string,
  tracked: readonly string[] | ReadonlySet<string> = _TRACKED,
): [Map<string, string>, Map<string, string>] {
  const out = new Map<string, string>();
  const important = new Map<string, string>();
  for (const decl of body.split(";")) {
    if (!decl.includes(":")) continue;
    // Python `decl.partition(":")`; the colon is known to be present.
    const colon = decl.indexOf(":");
    const key0 = decl.slice(0, colon);
    const val = decl.slice(colon + 1);
    const key = key0.trim().toLowerCase();
    if (contains(tracked, key)) {
      // Drop the CSS `!important` priority flag so it does not leak into
      // the value and break downstream color/number parsing.
      const flag = _IMPORTANT_RE.exec(val);
      const value = (flag != null ? val.slice(0, flag.index) : val).trim();
      out.set(key, value);
      if (flag != null) important.set(key, value);
    }
  }
  return [out, important];
}

const _SEL_TOKEN_RE = /([#.]?)([A-Za-z0-9_*-]+)/g;

function _specificity(selector: string): [number, number, number] {
  let ids = 0;
  let classes = 0;
  let types = 0;
  for (const [, prefix, name] of selector.matchAll(_SEL_TOKEN_RE)) {
    if (prefix === "#") {
      ids += 1;
    } else if (prefix === ".") {
      classes += 1;
    } else if (name !== "*") {
      types += 1;
    }
  }
  return [ids, classes, types];
}

/** Test a simple selector against an element.
 *
 * Only single compound selectors (no descendant combinators) match;
 * a selector containing whitespace never matches.
 */
function selectorMatches(selector: string, tag: string, elemId: string, classes: ReadonlySet<string>): boolean {
  if (selector.trim().includes(" ") || selector.includes(">") || selector.includes("+") || selector.includes("~")) {
    return false;
  }
  if (selector.includes(":") || selector.includes("[")) return false;
  for (const [, prefix, name] of selector.matchAll(_SEL_TOKEN_RE)) {
    if (prefix === "#") {
      if (name !== elemId) return false;
    } else if (prefix === ".") {
      if (!classes.has(name)) return false;
    } else if (name !== "*") {
      if (name !== tag) return false;
    }
  }
  return true;
}

/**
 * Compute the effective presentation properties for an element.
 *
 * @param parent - The parent element's resolved properties.
 * @param tag - Local element name.
 * @param attrs - Element attributes.
 * @param cssRules - Parsed document CSS rules.
 * @returns The resolved property dict for this element.
 */
export function resolveProperties(
  parent: Map<string, string>,
  tag: string,
  attrs: Map<string, string>,
  cssRules: CssRule[],
): Map<string, string> {
  // Start from inherited properties only.
  const style = new Map<string, string>([...parent].filter(([k]) => INHERITABLE.has(k)));

  // Presentation attributes (weakest author level).
  for (const key of _TRACKED) {
    const value = attrs.get(key);
    if (value !== undefined) style.set(key, value.trim());
  }

  // Matching CSS rules, applied in (specificity, order) ascending so the
  // strongest wins.
  const elemId = attrs.get("id") ?? "";
  const classes = new Set((attrs.get("class") ?? "").split(/\s+/).filter(Boolean));
  const matched = cssRules.filter((r) => selectorMatches(r.selector, tag, elemId, classes));
  const ordered = [...matched].sort((a, b) => compare([a.specificity, a.order], [b.specificity, b.order]));
  for (const rule of ordered) {
    for (const [k, v] of rule.declarations) style.set(k, v);
  }

  // Inline style attribute (strongest normal declarations).
  const [inline, inlineImportant] = _splitDeclarations(attrs.get("style") ?? "");
  for (const [k, v] of inline) style.set(k, v);

  // `!important` declarations outrank every normal one: a stylesheet's
  // over the inline style (AE 2026 imports `rect{fill:red !important}`
  // with `style="fill:blue"` red), and an inline one over all.
  for (const rule of ordered) {
    for (const [k, v] of rule.important) style.set(k, v);
  }
  for (const [k, v] of inlineImportant) style.set(k, v);

  return style;
}
