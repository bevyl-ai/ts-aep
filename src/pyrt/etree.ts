// xml.etree.ElementTree: the subset py_aep uses, with CPython 3.12 / expat semantics.
//
// Element (tag, attrib, text, tail, children), SubElement, fromstring, tostring,
// ParseError, and the ElementPath subset (find / findall / findtext /
// iterfind: child, `*`, `.`, `..`, `//`, `[@a]`, `[@a='v']`, `[@a!='v']`, `[tag]`,
// `[tag='v']`, `[.='v']`, `[n]`, `[last()]`, `[last()-n]`, `{ns}tag`, `{*}tag`, `{ns}*`).
//
// TODO(port): internal general entities follow expat only for plain-text replacement text.
// expat expands character references in an entity value at declaration and parses replacement
// text holding markup (`<!ENTITY e "<a/>">`, or `"&#60;"`) as content: nested elements, else
// "unclosed token" / "asynchronous entity"; in an attribute value such text is "not
// well-formed". Here a literal `<` raises "not well-formed" in both contexts and a char-ref
// `<` stays text. Error positions also differ: expat reports a fault inside an entity at the
// reference in content and at the start tag in an attribute value; here it is the reference
// (attribute) or the offset within the replacement text (nested reference). Fixing it needs
// declaration-time char-ref expansion and a re-entrant content parser over replacement text.
// External and parameter entities are ignored (expat without a resolver also skips them).

import { latin1Bytes, latin1Str } from "./bytes.ts";
import { decode, ord } from "./codecs.ts";
import { IndexError, KeyError, ValueError } from "./errors.ts";

export class ParseError extends SyntaxError {
  code = 0;
  position: [number, number] = [1, 0];
}

type AttribInit = Map<string, string> | Record<string, string> | null | undefined;

function toAttribMap(attrib: AttribInit, extra?: Record<string, string>): Map<string, string> {
  const m = new Map<string, string>();
  if (attrib instanceof Map) for (const [k, v] of attrib) m.set(k, v);
  else if (attrib != null) for (const [k, v] of Object.entries(attrib)) m.set(k, v);
  if (extra) for (const [k, v] of Object.entries(extra)) m.set(k, v);
  return m;
}

export class Element {
  tag: string;
  attrib: Map<string, string>;
  text: string | null = null;
  tail: string | null = null;
  _children: Element[] = [];

  constructor(tag: string, attrib: AttribInit = null, extra?: Record<string, string>) {
    this.tag = tag;
    this.attrib = toAttribMap(attrib, extra);
  }

  /** Direct children (the live list). */
  get children(): Element[] {
    return this._children;
  }

  get length(): number {
    return this._children.length;
  }

  at(i: number): Element {
    const n = this._children.length;
    const j = i < 0 ? i + n : i;
    if (j < 0 || j >= n) throw new IndexError("child index out of range");
    return this._children[j];
  }

  [Symbol.iterator](): Iterator<Element> {
    return this._children[Symbol.iterator]();
  }

  append(subelement: Element): void {
    this._children.push(subelement);
  }

  extend(elements: Iterable<Element>): void {
    for (const e of elements) this._children.push(e);
  }

  insert(index: number, subelement: Element): void {
    this._children.splice(index, 0, subelement);
  }

  remove(subelement: Element): void {
    const i = this._children.indexOf(subelement);
    if (i < 0) throw new ValueError("list.remove(x): x not in list");
    this._children.splice(i, 1);
  }

  clear(): void {
    this.attrib.clear();
    this._children = [];
    this.text = this.tail = null;
  }

  get(key: string, default_: string): string;
  get(key: string, default_?: string | null): string | null;
  get(key: string, default_: string | null = null): string | null {
    const v = this.attrib.get(key);
    return v === undefined ? default_ : v;
  }

  set(key: string, value: string): void {
    this.attrib.set(key, value);
  }

  keys(): string[] {
    return [...this.attrib.keys()];
  }

  items(): [string, string][] {
    return [...this.attrib.entries()];
  }

  *iter(tag: string | null = null): Generator<Element> {
    if (tag === "*") tag = null;
    if (tag === null || this.tag === tag) yield this;
    // Depth-first with an explicit stack; each level keeps the children array
    // it started on, as nested `for...of` loops would.
    const lists: Element[][] = [this._children];
    const at: number[] = [0];
    while (lists.length) {
      const top = lists.length - 1;
      const kids = lists[top];
      if (at[top] >= kids.length) {
        lists.pop();
        at.pop();
        continue;
      }
      const e = kids[at[top]++];
      if (tag === null || e.tag === tag) yield e;
      lists.push(e._children);
      at.push(0);
    }
  }

  *itertext(): Generator<string> {
    if (typeof this.tag !== "string") return;
    const t = this.text;
    if (t) yield t;
    for (const e of this._children) {
      yield* e.itertext();
      const tl = e.tail;
      if (tl) yield tl;
    }
  }

  find(path: string, namespaces: NsMap = null): Element | null {
    if (namespaces === null && PLAIN_TAG.test(path)) {
      for (const e of this._children) if (e.tag === path) return e;
      return null;
    }
    const r = iterfind(this, path, namespaces).next();
    return r.done ? null : r.value;
  }

  findall(path: string, namespaces: NsMap = null): Element[] {
    return [...iterfind(this, path, namespaces)];
  }

  findtext(path: string, default_: string | null = null, namespaces: NsMap = null): string | null {
    const r = iterfind(this, path, namespaces).next();
    if (r.done) return default_;
    return r.value.text || "";
  }

  iterfind(path: string, namespaces: NsMap = null): Generator<Element> {
    return iterfind(this, path, namespaces);
  }
}

export function SubElement(
  parent: Element,
  tag: string,
  attrib: AttribInit = null,
  extra?: Record<string, string>,
): Element {
  const e = new Element(tag, attrib, extra);
  parent.append(e);
  return e;
}

// ---------------------------------------------------------------------------
// ElementPath
// ---------------------------------------------------------------------------

export type NsMap = Map<string | null, string> | Record<string, string> | null | undefined;

function nsGet(ns: NsMap, key: string | null): string | undefined {
  if (!ns) return undefined;
  if (ns instanceof Map) return ns.get(key);
  return key === null ? undefined : ns[key];
}

type Token = [string, string];
type Select = (context: SelectorContext, result: Iterable<Element>) => Iterable<Element>;

class SelectorContext {
  parentMap: Map<Element, Element> | null = null;
  root: Element;
  constructor(root: Element) {
    this.root = root;
  }
}

function getParentMap(context: SelectorContext): Map<Element, Element> {
  if (context.parentMap === null) {
    const pm = new Map<Element, Element>();
    for (const p of context.root.iter()) for (const c of p) pm.set(c, p);
    context.parentMap = pm;
  }
  return context.parentMap;
}

const xpathTokenizerRe =
  /('[^']*'|"[^"]*"|::|\/\/?|\.\.|\(\)|!=|[/.*:[\]()@=])|((?:\{[^}]+\})?[^/[\]()@!=\s]+)|\s+/g;

function xpathTokenizer(pattern: string, namespaces: NsMap): Token[] {
  const out: Token[] = [];
  const defaultNamespace = nsGet(namespaces, null);
  let parsingAttribute = false;
  for (const m of pattern.matchAll(xpathTokenizerRe)) {
    const ttype = m[1] ?? "";
    const tag = m[2] ?? "";
    if (tag && tag[0] !== "{") {
      if (tag.includes(":")) {
        const i = tag.indexOf(":");
        const prefix = tag.slice(0, i);
        const uri = tag.slice(i + 1);
        const ns = namespaces ? nsGet(namespaces, prefix) : undefined;
        if (ns === undefined) throw new SyntaxError(`prefix '${prefix}' not found in prefix map`);
        out.push([ttype, `{${ns}}${uri}`]);
      } else if (defaultNamespace && !parsingAttribute) {
        out.push([ttype, `{${defaultNamespace}}${tag}`]);
      } else {
        out.push([ttype, tag]);
      }
      parsingAttribute = false;
    } else {
      out.push([ttype, tag]);
      parsingAttribute = ttype === "@";
    }
  }
  return out;
}

class TokenStream {
  i = 0;
  constructor(readonly tokens: Token[]) {}
  next(): Token {
    if (this.i >= this.tokens.length) throw new StopIter();
    return this.tokens[this.i++];
  }
}
class StopIter extends Error {}

function _prepareTag(tag: string): (t: string) => boolean {
  if (tag === "{*}*") return () => true;
  if (tag === "{}*") return (t) => !t.startsWith("{");
  if (tag.startsWith("{*}")) {
    const suffix = tag.slice(2);
    return (t) => t.endsWith(suffix);
  }
  if (tag.endsWith("}*")) {
    const ns = tag.slice(0, -1);
    return (t) => t.startsWith(ns);
  }
  if (tag.startsWith("{}")) {
    const plain = tag.slice(2);
    return (t) => t === plain;
  }
  return (t) => t === tag;
}

function prepareChild(_next: () => Token, token: Token): Select {
  const match = _prepareTag(token[1]);
  return function* (_c, result) {
    for (const elem of result) for (const e of elem) if (match(e.tag)) yield e;
  };
}

function prepareStar(): Select {
  return function* (_c, result) {
    for (const elem of result) yield* elem;
  };
}

function prepareSelf(): Select {
  return function* (_c, result) {
    yield* result;
  };
}

function prepareDescendant(next: () => Token): Select {
  let token: Token;
  try {
    token = next();
  } catch (e) {
    if (e instanceof StopIter) throw e;
    throw e;
  }
  let tag: string;
  if (token[0] === "*") tag = "*";
  else if (!token[0]) tag = token[1];
  else throw new SyntaxError("invalid descendant");
  if (tag === "*" || tag === "{*}*") {
    return function* (_c, result) {
      for (const elem of result) for (const e of elem.iter()) if (e !== elem) yield e;
    };
  }
  const match = _prepareTag(tag);
  return function* (_c, result) {
    for (const elem of result) for (const e of elem.iter()) if (e !== elem && match(e.tag)) yield e;
  };
}

function prepareParent(): Select {
  return function* (context, result) {
    const parentMap = getParentMap(context);
    const seen = new Set<Element>();
    for (const elem of result) {
      const parent = parentMap.get(elem);
      if (parent !== undefined && !seen.has(parent)) {
        seen.add(parent);
        yield parent;
      }
    }
  };
}

const INT_RE = /^-?\d+$/;

function preparePredicate(next: () => Token): Select {
  const signatureParts: string[] = [];
  const predicate: string[] = [];
  for (;;) {
    let token = next();
    if (token[0] === "]") break;
    if (token[0] === "" && token[1] === "") continue;
    if (token[0] && "'\"".includes(token[0][0])) token = ["'", token[0].slice(1, -1)];
    signatureParts.push(token[0] || "-");
    predicate.push(token[1]);
  }
  const signature = signatureParts.join("");
  if (signature === "@-") {
    const key = predicate[1];
    return function* (_c, result) {
      for (const elem of result) if (elem.get(key) !== null) yield elem;
    };
  }
  if (signature === "@-='") {
    const key = predicate[1];
    const value = predicate[predicate.length - 1];
    return function* (_c, result) {
      for (const elem of result) if (elem.get(key) === value) yield elem;
    };
  }
  if (signature === "@-!='") {
    const key = predicate[1];
    const value = predicate[predicate.length - 1];
    return function* (_c, result) {
      for (const elem of result) if (elem.get(key) !== value) yield elem;
    };
  }
  if (signature === "-" && !INT_RE.test(predicate[0])) {
    const tag = predicate[0];
    return function* (_c, result) {
      for (const elem of result) if (elem.find(tag) !== null) yield elem;
    };
  }
  if (
    signature === ".='" ||
    signature === ".!='" ||
    ((signature === "-='" || signature === "-!='") && !INT_RE.test(predicate[0]))
  ) {
    const tag = predicate[0];
    const value = predicate[predicate.length - 1];
    const negate = signature.includes("!");
    if (tag !== "." && tag !== "") {
      return function* (_c, result) {
        for (const elem of result) {
          let hit = false;
          for (const e of elem.findall(tag)) {
            if (([...e.itertext()].join("") === value) !== negate) {
              hit = true;
              break;
            }
          }
          if (hit) yield elem;
        }
      };
    }
    return function* (_c, result) {
      for (const elem of result) if (([...elem.itertext()].join("") === value) !== negate) yield elem;
    };
  }
  if (signature === "-" || signature === "-()" || signature === "-()-") {
    let index: number;
    if (signature === "-") {
      index = parseInt(predicate[0], 10) - 1;
      if (index < 0) throw new SyntaxError("XPath position >= 1 expected");
    } else {
      if (predicate[0] !== "last") throw new SyntaxError("unsupported function");
      if (signature === "-()-") {
        if (!INT_RE.test(predicate[2])) throw new SyntaxError("unsupported expression");
        index = parseInt(predicate[2], 10) - 1;
        if (index > -2) throw new SyntaxError("XPath offset from last() must be negative");
      } else {
        index = -1;
      }
    }
    return function* (context, result) {
      const parentMap = getParentMap(context);
      for (const elem of result) {
        const parent = parentMap.get(elem);
        if (parent === undefined) continue;
        const elems = [...iterfind(parent, elem.tag, null)];
        const j = index < 0 ? elems.length + index : index;
        if (j >= 0 && j < elems.length && elems[j] === elem) yield elem;
      }
    };
  }
  throw new SyntaxError("invalid predicate");
}

const ops: Record<string, (next: () => Token, token: Token) => Select> = {
  "": prepareChild,
  "*": prepareStar,
  ".": prepareSelf,
  "..": prepareParent,
  "//": prepareDescendant,
  "[": preparePredicate,
};

const _cache = new Map<string, Select[]>();

// A path that selects children by one literal tag (`xpathTokenizer` yields one tag token).
const PLAIN_TAG = /^[A-Za-z_][\w.-]*$/;

export function* iterfind(elem: Element, path: string, namespaces: NsMap = null): Generator<Element> {
  if (path.slice(-1) === "/") path = path + "*";
  const nsKey =
    namespaces instanceof Map
      ? JSON.stringify([...namespaces.entries()])
      : namespaces
        ? JSON.stringify(Object.entries(namespaces))
        : "";
  const cacheKey = path + "\u0000" + nsKey;
  let selector = _cache.get(cacheKey);
  if (selector === undefined) {
    if (path.slice(0, 1) === "/") throw new SyntaxError("cannot use absolute path on element");
    const stream = new TokenStream(xpathTokenizer(path, namespaces));
    const next = () => stream.next();
    let token: Token;
    try {
      token = next();
    } catch (e) {
      if (e instanceof StopIter) return;
      throw e;
    }
    selector = [];
    for (;;) {
      const op = ops[token[0]];
      if (op === undefined) throw new KeyError(token[0]);
      try {
        selector.push(op(next, token));
      } catch (e) {
        if (e instanceof StopIter) throw new SyntaxError("invalid path");
        throw e;
      }
      try {
        token = next();
        if (token[0] === "/") token = next();
      } catch (e) {
        if (e instanceof StopIter) break;
        throw e;
      }
    }
    if (_cache.size > 100) _cache.clear();
    _cache.set(cacheKey, selector);
  }
  let result: Iterable<Element> = [elem];
  const context = new SelectorContext(elem);
  for (const select of selector) result = select(context, result);
  yield* result;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

const _namespaceMap = new Map<string, string>([
  ["http://www.w3.org/XML/1998/namespace", "xml"],
  ["http://www.w3.org/1999/xhtml", "html"],
  ["http://www.w3.org/1999/02/22-rdf-syntax-ns#", "rdf"],
  ["http://schemas.xmlsoap.org/wsdl/", "wsdl"],
  ["http://www.w3.org/2001/XMLSchema", "xs"],
  ["http://www.w3.org/2001/XMLSchema-instance", "xsi"],
  ["http://purl.org/dc/elements/1.1/", "dc"],
]);

function _escapeCdata(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function _escapeAttrib(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, "&#10;")
    .replace(/\t/g, "&#09;");
}

function _namespaces(elem: Element, defaultNamespace: string | null): [Map<string, string | null>, Map<string, string>] {
  const qnames = new Map<string, string | null>();
  const namespaces = new Map<string, string>();
  if (defaultNamespace) namespaces.set(defaultNamespace, "");
  const addQname = (qname: string): void => {
    if (qname[0] === "{") {
      const close = qname.lastIndexOf("}");
      const uri = qname.slice(1, close);
      const tag = qname.slice(close + 1);
      let prefix = namespaces.get(uri);
      if (prefix === undefined) {
        prefix = _namespaceMap.get(uri);
        if (prefix === undefined) prefix = `ns${namespaces.size}`;
        if (prefix !== "xml") namespaces.set(uri, prefix);
      }
      qnames.set(qname, prefix ? `${prefix}:${tag}` : tag);
    } else {
      if (defaultNamespace) {
        throw new ValueError("cannot use non-qualified names with default_namespace option");
      }
      qnames.set(qname, qname);
    }
  };
  for (const e of elem.iter()) {
    if (typeof e.tag !== "string") throw new TypeError(`cannot serialize ${String(e.tag)} (type ${typeof e.tag})`);
    if (!qnames.has(e.tag)) addQname(e.tag);
    for (const key of e.attrib.keys()) if (!qnames.has(key)) addQname(key);
  }
  return [qnames, namespaces];
}

function _serializeXml(
  write: (s: string) => void,
  elem: Element,
  qnames: Map<string, string | null>,
  namespaces: Map<string, string> | null,
  shortEmptyElements: boolean,
): void {
  const tag = qnames.get(elem.tag) ?? null;
  const text = elem.text;
  if (tag === null) {
    if (text) write(_escapeCdata(text));
    for (const e of elem) _serializeXml(write, e, qnames, null, shortEmptyElements);
  } else {
    write("<" + tag);
    const items = elem.items();
    if (items.length || (namespaces && namespaces.size)) {
      if (namespaces) {
        const sorted = [...namespaces.entries()].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
        for (const [v, k0] of sorted) {
          const k = k0 ? ":" + k0 : "";
          write(` xmlns${k}="${_escapeAttrib(v)}"`);
        }
      }
      for (const [k, v] of items) write(` ${qnames.get(k)}="${_escapeAttrib(v)}"`);
    }
    if (text || elem.length || !shortEmptyElements) {
      write(">");
      if (text) write(_escapeCdata(text));
      for (const e of elem) _serializeXml(write, e, qnames, null, shortEmptyElements);
      write("</" + tag + ">");
    } else {
      write(" />");
    }
  }
  if (elem.tail) write(_escapeCdata(elem.tail));
}

function _serializeText(write: (s: string) => void, elem: Element): void {
  if (elem.text) write(elem.text);
  for (const e of elem) _serializeText(write, e);
  if (elem.tail) write(elem.tail);
}

export interface ToStringOptions {
  xmlDeclaration?: boolean | null;
  defaultNamespace?: string | null;
  method?: "xml" | "text" | null;
  shortEmptyElements?: boolean;
}

function _tostringUnicode(element: Element, opts: ToStringOptions): string {
  const method = opts.method ?? "xml";
  const out: string[] = [];
  const write = (s: string): void => {
    out.push(s);
  };
  if (method === "text") {
    _serializeText(write, element);
  } else if (method === "xml") {
    const [qnames, namespaces] = _namespaces(element, opts.defaultNamespace ?? null);
    _serializeXml(write, element, qnames, namespaces, opts.shortEmptyElements ?? true);
  } else {
    throw new ValueError(`unknown serialization method '${method}'`);
  }
  return out.join("");
}

export function tostring(element: Element, encoding: "unicode", opts?: ToStringOptions): string;
export function tostring(element: Element, encoding?: string | null, opts?: ToStringOptions): Uint8Array;
export function tostring(
  element: Element,
  encoding: string | null = null,
  opts: ToStringOptions = {},
): string | Uint8Array {
  const enc = encoding ?? "us-ascii";
  const body = _tostringUnicode(element, opts);
  if (enc === "unicode") {
    const decl = opts.xmlDeclaration === true ? "<?xml version='1.0'?>\n" : "";
    return decl + body;
  }
  const lower = enc.toLowerCase();
  const declare =
    opts.xmlDeclaration === true ||
    (opts.xmlDeclaration == null && !["utf-8", "us-ascii", "unicode"].includes(lower));
  const decl = declare ? `<?xml version='1.0' encoding='${enc}'?>\n` : "";
  const text = decl + body;
  if (lower === "us-ascii" || lower === "ascii") {
    let s = "";
    for (const ch of text) {
      const cp = ord(ch);
      s += cp < 128 ? ch : `&#${cp};`;
    }
    return latin1Bytes(s);
  }
  if (lower === "utf-8" || lower === "utf8") return new TextEncoder().encode(text); // lone surrogates -> U+FFFD (unchanged from the node encoder used before)
  throw new ValueError(`unsupported tostring encoding ${enc}`);
}

// ---------------------------------------------------------------------------
// Parser (expat-compatible subset)
// ---------------------------------------------------------------------------

const NAME_START =
  ":A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}";
const NAME_CHAR = NAME_START + "\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040";
const NAME_RE = new RegExp(`[${NAME_START}][${NAME_CHAR}]*`, "uy");
// ASCII name characters: 1 = may start a name, 2 = may only continue one.
const ASCII_NAME = new Uint8Array(128);
for (let c = 0; c < 128; c++) {
  const ch = String.fromCharCode(c);
  if (/[:A-Z_a-z]/.test(ch)) ASCII_NAME[c] = 1;
  else if (/[-.0-9]/.test(ch)) ASCII_NAME[c] = 2;
}
// Attribute-value characters that need the per-character path.
const ATTR_SLOW_RE = /[<&\t\n]/;
const BAD_CHAR_RE = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/u;
const PREDEFINED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const EXPANSION_LIMIT = 10_000_000;

function isWs(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}

function isWsCode(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

class _Parser {
  readonly s: string;
  pos = 0;
  entities = new Map<string, string>();
  expanded = 0;

  constructor(s: string) {
    this.s = s;
  }

  err(msg: string, at: number = this.pos): never {
    const upto = this.s.slice(0, at);
    const line = (upto.match(/\n/g)?.length ?? 0) + 1;
    const column = at - (upto.lastIndexOf("\n") + 1);
    const e = new ParseError(`${msg}: line ${line}, column ${column}`);
    e.position = [line, column];
    throw e;
  }

  skipWs(): boolean {
    const start = this.pos;
    while (this.pos < this.s.length && isWsCode(this.s.charCodeAt(this.pos))) this.pos++;
    return this.pos > start;
  }

  readName(): string {
    const s = this.s;
    const start = this.pos;
    if (ASCII_NAME[s.charCodeAt(start)] === 1) {
      let p = start + 1;
      let c = s.charCodeAt(p);
      while (c < 0x80 && ASCII_NAME[c] !== 0) c = s.charCodeAt(++p);
      // NaN past the end; a non-ASCII character goes to the full regex.
      if (!(c >= 0x80)) {
        this.pos = p;
        return s.slice(start, p);
      }
    }
    NAME_RE.lastIndex = this.pos;
    const m = NAME_RE.exec(this.s);
    if (m === null) {
      if (this.pos >= this.s.length) this.err("unclosed token");
      this.err("not well-formed (invalid token)");
    }
    this.pos = NAME_RE.lastIndex;
    return m[0];
  }

  checkChars(text: string, at: number): void {
    const m = BAD_CHAR_RE.exec(text);
    if (m !== null) this.err("not well-formed (invalid token)", at + m.index);
  }

  /** Expand one reference starting at s[pos] === "&"; returns replacement text. */
  reference(depth: number): string {
    const s = this.s;
    const start = this.pos;
    const semi = s.indexOf(";", start);
    const bad = semi < 0 ? -1 : s.slice(start + 1, semi).search(/[&<\s]/);
    if (semi < 0 || bad >= 0) {
      this.err(semi < 0 && s.slice(start + 1).search(/[<\s]/) < 0 ? "unclosed token" : "not well-formed (invalid token)", start);
    }
    const body = s.slice(start + 1, semi);
    this.pos = semi + 1;
    if (body[0] === "#") {
      const hex = body[1] === "x";
      const digits = hex ? body.slice(2) : body.slice(1);
      if (!(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) this.err("not well-formed (invalid token)", start);
      const cp = parseInt(digits, hex ? 16 : 10);
      if (!(cp === 9 || cp === 10 || cp === 13 || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff))) {
        this.err("reference to invalid character number", start);
      }
      return String.fromCodePoint(cp);
    }
    NAME_RE.lastIndex = 0;
    const nm = NAME_RE.exec(body);
    if (nm === null || nm[0].length !== body.length) this.err("not well-formed (invalid token)", start + 1);
    if (Object.hasOwn(PREDEFINED, body)) return PREDEFINED[body];
    const val = this.entities.get(body);
    if (val === undefined) this.err("undefined entity", start);
    if (depth > 40) this.err("recursive entity reference", start);
    const out = this.expandEntityValue(val, depth + 1, start);
    this.expanded += out.length;
    if (this.expanded > EXPANSION_LIMIT) {
      this.err("limit on input amplification factor (from DTD and entities) breached", start);
    }
    return out;
  }

  expandEntityValue(val: string, depth: number, at: number): string {
    if (val.includes("<")) this.err("not well-formed (invalid token)", at);
    if (!val.includes("&")) return val;
    const sub = new _Parser(val);
    sub.entities = this.entities;
    sub.expanded = this.expanded;
    let out = "";
    while (sub.pos < val.length) {
      const amp = val.indexOf("&", sub.pos);
      if (amp < 0) {
        out += val.slice(sub.pos);
        break;
      }
      out += val.slice(sub.pos, amp);
      sub.pos = amp;
      out += sub.reference(depth);
    }
    this.expanded = sub.expanded;
    return out;
  }

  parseDoctype(): void {
    const s = this.s;
    this.pos += "<!DOCTYPE".length;
    this.skipWs();
    this.readName();
    // external id and internal subset
    for (;;) {
      if (this.pos >= s.length) this.err("unclosed token");
      const c = s[this.pos];
      if (c === ">") {
        this.pos++;
        return;
      }
      if (c === '"' || c === "'") {
        const e = s.indexOf(c, this.pos + 1);
        if (e < 0) this.err("unclosed token");
        this.pos = e + 1;
      } else if (c === "[") {
        this.pos++;
        this.parseInternalSubset();
      } else {
        this.pos++;
      }
    }
  }

  parseInternalSubset(): void {
    const s = this.s;
    const entityRe = new RegExp(`<!ENTITY\\s+(%\\s+)?([${NAME_START}][${NAME_CHAR}]*)\\s+(?:"([^"]*)"|'([^']*)')\\s*>`, "uy");
    for (;;) {
      this.skipWs();
      if (this.pos >= s.length) this.err("unclosed token");
      if (s[this.pos] === "]") {
        this.pos++;
        return;
      }
      if (s.startsWith("<!--", this.pos)) {
        const e = s.indexOf("-->", this.pos + 4);
        if (e < 0) this.err("unclosed token");
        this.pos = e + 3;
      } else if (s.startsWith("<?", this.pos)) {
        const e = s.indexOf("?>", this.pos + 2);
        if (e < 0) this.err("unclosed token");
        this.pos = e + 2;
      } else if (s.startsWith("<!ENTITY", this.pos)) {
        entityRe.lastIndex = this.pos;
        const m = entityRe.exec(s);
        if (m !== null) {
          if (!m[1] && !this.entities.has(m[2])) this.entities.set(m[2], m[3] ?? m[4]);
          this.pos = entityRe.lastIndex;
        } else {
          this.skipDecl();
        }
      } else if (s.startsWith("<!", this.pos)) {
        this.skipDecl();
      } else if (s[this.pos] === "%") {
        const e = s.indexOf(";", this.pos);
        if (e < 0) this.err("unclosed token");
        this.pos = e + 1;
      } else {
        this.err("syntax error");
      }
    }
  }

  skipDecl(): void {
    const s = this.s;
    for (;;) {
      if (this.pos >= s.length) this.err("unclosed token");
      const c = s[this.pos];
      if (c === '"' || c === "'") {
        const e = s.indexOf(c, this.pos + 1);
        if (e < 0) this.err("unclosed token");
        this.pos = e + 1;
      } else if (c === ">") {
        this.pos++;
        return;
      } else {
        this.pos++;
      }
    }
  }

  skipMiscToken(): boolean {
    const s = this.s;
    if (s.startsWith("<!--", this.pos)) {
      const e = s.indexOf("-->", this.pos + 4);
      if (e < 0) this.err("unclosed token");
      if (s.slice(this.pos + 4, e).includes("--")) this.err("not well-formed (invalid token)");
      this.checkChars(s.slice(this.pos, e), this.pos);
      this.pos = e + 3;
      return true;
    }
    if (s.startsWith("<?", this.pos)) {
      this.skipPi();
      return true;
    }
    return false;
  }

  skipPi(): void {
    const s = this.s;
    const start = this.pos;
    this.pos += 2;
    const target = this.readName();
    if (target.toLowerCase() === "xml") {
      this.err("XML or text declaration not at start of entity", start);
    }
    const e = s.indexOf("?>", this.pos);
    if (e < 0) this.err("unclosed token");
    if (this.pos < e && !isWs(s[this.pos])) this.err("processing instruction not well-formed", this.pos);
    this.checkChars(s.slice(this.pos, e), this.pos);
    this.pos = e + 2;
  }

  parseAttrValue(quote: string): string {
    const s = this.s;
    this.pos++;
    const close = s.indexOf(quote, this.pos);
    if (close >= 0) {
      const value = s.slice(this.pos, close);
      if (!ATTR_SLOW_RE.test(value)) {
        this.checkChars(value, this.pos);
        this.pos = close + 1;
        return value;
      }
    }
    let out = "";
    for (;;) {
      if (this.pos >= s.length) this.err("unclosed token");
      const c = s[this.pos];
      if (c === quote) {
        this.pos++;
        return out;
      }
      if (c === "<") this.err("not well-formed (invalid token)");
      if (c === "&") {
        out += this.reference(0);
        continue;
      }
      const start = this.pos;
      while (this.pos < s.length && s[this.pos] !== quote && s[this.pos] !== "<" && s[this.pos] !== "&") this.pos++;
      const chunk = s.slice(start, this.pos);
      this.checkChars(chunk, start);
      out += chunk.replace(/[\t\n]/g, " ");
    }
  }

  parse(): Element {
    const s = this.s;
    // XML declaration
    if (/^<\?xml[ \t\r\n]/.test(s)) {
      const e = s.indexOf("?>");
      if (e < 0) this.err("unclosed token");
      this.pos = e + 2;
    }
    // prolog
    for (;;) {
      this.skipWs();
      if (this.pos >= s.length) this.err("no element found");
      if (s[this.pos] !== "<") this.err("syntax error");
      if (this.skipMiscToken()) continue;
      if (s.startsWith("<!DOCTYPE", this.pos)) {
        this.parseDoctype();
        continue;
      }
      break;
    }

    type Frame = { el: Element; raw: string; scope: Map<string, string> };
    const stack: Frame[] = [];
    let scope = new Map<string, string>([["xml", XML_NS]]);
    let pending = "";
    const flush = (): void => {
      if (!pending) return;
      const text = pending;
      pending = "";
      const top = stack[stack.length - 1].el;
      if (top._children.length === 0) top.text = text;
      else top._children[top._children.length - 1].tail = text;
    };

    const resolve = (raw: string, isAttr: boolean, sc: Map<string, string>, at: number): string => {
      const i = raw.indexOf(":");
      if (i < 0) {
        if (!isAttr) {
          const d = sc.get("");
          if (d) return `{${d}}${raw}`;
        }
        return raw;
      }
      const prefix = raw.slice(0, i);
      const local = raw.slice(i + 1);
      if (!local || local.includes(":") || !prefix) this.err("not well-formed (invalid token)", at);
      const uri = sc.get(prefix);
      if (uri === undefined) this.err("unbound prefix", at);
      return `{${uri}}${local}`;
    };

    const startTag = (): Element => {
      const tagAt = this.pos;
      this.pos++;
      const raw = this.readName();
      const rawAttrs: [string, string][] = [];
      let hasDecls = false;
      let selfClose = false;
      for (;;) {
        const hadWs = this.skipWs();
        if (this.pos >= s.length) this.err("unclosed token");
        const c = s[this.pos];
        if (c === ">") {
          this.pos++;
          break;
        }
        if (c === "/") {
          if (this.pos + 1 >= s.length) this.err("unclosed token");
          if (s[this.pos + 1] !== ">") this.err("not well-formed (invalid token)");
          this.pos += 2;
          selfClose = true;
          break;
        }
        if (!hadWs) this.err("not well-formed (invalid token)");
        const at = this.pos;
        const name = this.readName();
        this.skipWs();
        if (this.pos >= s.length) this.err("unclosed token");
        if (s[this.pos] !== "=") this.err("not well-formed (invalid token)");
        this.pos++;
        this.skipWs();
        if (this.pos >= s.length) this.err("unclosed token");
        const q = s[this.pos];
        if (q !== '"' && q !== "'") this.err("not well-formed (invalid token)");
        const value = this.parseAttrValue(q);
        for (const [n] of rawAttrs) if (n === name) this.err("duplicate attribute", at);
        if (name === "xmlns" || name.startsWith("xmlns:")) hasDecls = true;
        rawAttrs.push([name, value]);
      }
      let sc = stack.length ? stack[stack.length - 1].scope : scope;
      if (hasDecls) {
        sc = new Map(sc);
        for (const [n, v] of rawAttrs) {
          if (n === "xmlns" || n.startsWith("xmlns:")) sc.set(n === "xmlns" ? "" : n.slice(6), v);
        }
      }
      const tag = resolve(raw, false, sc, tagAt + 1);
      const el = new Element(tag);
      for (const [n, v] of rawAttrs) {
        if (n === "xmlns" || n.startsWith("xmlns:")) continue;
        const k = resolve(n, true, sc, tagAt);
        if (el.attrib.has(k)) this.err("duplicate attribute", tagAt);
        el.attrib.set(k, v);
      }
      if (stack.length) {
        flush();
        stack[stack.length - 1].el._children.push(el);
      }
      // an empty element: nothing pending belongs to it
      if (!selfClose) stack.push({ el, raw, scope: sc });
      return el;
    };

    const root = startTag();
    if (stack.length === 0) return this.epilog(root);

    while (stack.length) {
      if (this.pos >= s.length) this.err("no element found");
      const c = s.charCodeAt(this.pos);
      if (c === 0x3c) {
        const next = s.charCodeAt(this.pos + 1);
        if (next === 0x2f) {
          this.pos += 2;
          const name = this.readName();
          const at = this.pos;
          this.skipWs();
          if (this.pos >= s.length) this.err("unclosed token");
          if (s[this.pos] !== ">") this.err("not well-formed (invalid token)");
          if (name !== stack[stack.length - 1].raw) this.err("mismatched tag", at);
          this.pos++;
          flush();
          stack.pop();
        } else if (next === 0x21 && s.startsWith("<![CDATA[", this.pos)) {
          const e = s.indexOf("]]>", this.pos + 9);
          if (e < 0) this.err("unclosed CDATA section");
          const data = s.slice(this.pos + 9, e);
          this.checkChars(data, this.pos + 9);
          pending += data;
          this.pos = e + 3;
        } else if (next === 0x3f || (next === 0x21 && s.startsWith("<!--", this.pos))) {
          this.skipMiscToken();
        } else if (next === 0x21) {
          this.err("not well-formed (invalid token)");
        } else {
          startTag();
        }
      } else if (c === 0x26) {
        pending += this.reference(0);
      } else {
        const start = this.pos;
        let c = s.charCodeAt(this.pos);
        while (c !== 0x3c && c !== 0x26 && this.pos < s.length) c = s.charCodeAt(++this.pos);
        const chunk = s.slice(start, this.pos);
        this.checkChars(chunk, start);
        const cd = chunk.indexOf("]]>");
        if (cd >= 0) this.err("not well-formed (invalid token)", start + cd + 2);
        pending += chunk;
      }
    }
    return this.epilog(root);
  }

  epilog(root: Element): Element {
    const s = this.s;
    for (;;) {
      this.skipWs();
      if (this.pos >= s.length) return root;
      if (s[this.pos] === "<" && this.skipMiscToken()) continue;
      this.err("junk after document element");
    }
  }
}

function decodeXmlBytes(data: Uint8Array): string {
  let enc = "utf-8";
  let start = 0;
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    start = 3;
  } else if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
    enc = "utf-16-le";
    start = 2;
  } else if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
    enc = "utf-16-be";
    start = 2;
  } else {
    const head = latin1Str(data.subarray(0, 200));
    const m = /^<\?xml[^>]*?encoding\s*=\s*["']([A-Za-z][A-Za-z0-9._-]*)["']/.exec(head);
    if (m !== null) enc = m[1];
  }
  const lower = enc.toLowerCase().replace(/_/g, "-");
  const known: Record<string, string> = {
    "utf-8": "utf-8",
    utf8: "utf-8",
    "us-ascii": "ascii",
    ascii: "ascii",
    "iso-8859-1": "latin-1",
    latin1: "latin-1",
    "latin-1": "latin-1",
    "utf-16": "utf-16-le",
    "utf-16le": "utf-16-le",
    "utf-16-le": "utf-16-le",
    "utf-16be": "utf-16-be",
    "utf-16-be": "utf-16-be",
    "windows-1252": "cp1252",
    cp1252: "cp1252",
  };
  const pyEnc = known[lower];
  if (pyEnc === undefined) throw new ParseError("unknown encoding: line 1, column 0");
  try {
    return decode(data.subarray(start), pyEnc, "strict");
  } catch (e) {
    if (e instanceof ParseError) throw e;
    throw new ParseError("not well-formed (invalid token): line 1, column 0");
  }
}

export function fromstring(text: string | Uint8Array): Element {
  let s = typeof text === "string" ? text : decodeXmlBytes(text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  s = s.replace(/\r\n?/g, "\n");
  return new _Parser(s).parse();
}
