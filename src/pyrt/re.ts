// Python `re` pattern syntax and str-pattern semantics on top of JS RegExp.
//
// `py_re(pattern, flags)` translates a Python regular expression into an
// equivalent `u`-mode RegExp: `(?P<name>...)`, `(?P=name)`, `\A`, `\Z`,
// leading inline flags `(?aimsx)`, `{,n}`, literal `{`/`}`, Python's `^` /
// `$` / `.` line rules (only `\n` ends a line), and the Unicode meaning of
// `\d` (`\p{Nd}`), `\w` (`[\p{L}\p{N}_]`), `\s` (`str.isspace()`) and `\b`
// that Python gives str patterns (ASCII meanings under `re.ASCII`). Syntax
// with no JS equivalent (scoped flags `(?i:...)`, `\W` / `\S` inside a
// class, possessive quantifiers, `\N{...}`) raises `NotImplementedError`;
// a Python syntax error raises `PyReError` (`re.error`).

import { NotImplementedError, ValueError } from "./errors.ts";

/** `re.error` */
class PyReError extends ValueError {}

/** Python `re` flag values. */
export const reFlags = {
  I: 2,
  IGNORECASE: 2,
  M: 8,
  MULTILINE: 8,
  S: 16,
  DOTALL: 16,
  U: 32,
  UNICODE: 32,
  X: 64,
  VERBOSE: 64,
  A: 256,
  ASCII: 256,
} as const;

const INLINE: Record<string, number> = { a: 256, i: 2, L: 4, m: 8, s: 16, u: 32, x: 64 };

// str.isspace() characters.
const U_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const U_WORD = "\\p{L}\\p{N}_";
const A_SPACE = " \\t\\n\\r\\f\\v";
const A_WORD = "A-Za-z0-9_";
const JS_SYNTAX = new Set("^$\\.*+?()[]{}|/");

const cache = new Map<string, RegExp>();

/**
 * The JS RegExp for Python pattern `pattern` with `re` `flags`. `jsFlags`
 * adds JS-only flags (`"g"`, `"y"` for `re.match`-style anchoring at
 * `lastIndex`). Results are cached; a `g`/`y` RegExp is stateful, so those
 * are returned fresh.
 */
export function pyRe(pattern: string, flags = 0, jsFlags = ""): RegExp {
  const key = `${flags}\u0000${jsFlags}\u0000${pattern}`;
  const hit = cache.get(key);
  if (hit && !jsFlags) return hit;
  const [source, finalFlags] = translate(pattern, flags);
  const re = new RegExp(source, "u" + (finalFlags & reFlags.I ? "i" : "") + jsFlags);
  if (!jsFlags) cache.set(key, re);
  return re;
}

/** `re.search(pattern, s, flags)`: the first match anywhere, or `null`. */
export function reSearch(pattern: string, s: string, flags = 0): RegExpExecArray | null {
  return pyRe(pattern, flags).exec(s);
}

/** `re.match(pattern, s, flags)`: a match at the start of `s`, or `null`. */
export function reMatch(pattern: string, s: string, flags = 0): RegExpExecArray | null {
  return patternMatch(pyRe(pattern, flags), s);
}

/** `re.escape(s)`: a backslash before each of `()[]{}?*+-|^$\\.&~#` and ASCII whitespace. */
export function reEscape(s: string): string {
  return s.replace(/[()[\]{}?*+\-|^$\\.&~# \t\n\r\v\f]/g, "\\$&");
}

function translate(p: string, flags: number): [string, number] {
  let i = 0;
  // Leading global inline flags, e.g. `(?i)` or `(?ms)`.
  for (;;) {
    const m = /^\(\?([aiLmsux]+)\)/.exec(p.slice(i));
    if (!m) break;
    for (const f of m[1]) flags |= INLINE[f];
    i += m[0].length;
  }
  const ascii = (flags & reFlags.A) !== 0;
  const verbose = (flags & reFlags.X) !== 0;
  const dotall = (flags & reFlags.S) !== 0;
  const multiline = (flags & reFlags.M) !== 0;
  const word = ascii ? A_WORD : U_WORD;
  const space = ascii ? A_SPACE : U_SPACE;
  const digit = ascii ? "0-9" : "\\p{Nd}";
  const W = `[${word}]`;
  const out: string[] = [];
  const n = p.length;

  const err: (msg: string) => never = (msg) => {
    throw new PyReError(`${msg} at position ${i}`);
  };

  // A literal code point, escaped as needed for u-mode.
  const literal = (ch: string, inClass: boolean): string => {
    if (inClass) return "\\^-]\\[".includes(ch) ? "\\" + ch : ch;
    return JS_SYNTAX.has(ch) ? "\\" + ch : ch;
  };

  // Escape sequence at p[i] === "\\"; returns [js, consumed].
  const escape = (inClass: boolean): string => {
    const c = p[i + 1];
    if (c === undefined) err("bad escape (end of pattern)");
    const two = (js: string): string => {
      i += 2;
      return js;
    };
    switch (c) {
      case "d":
        return two(inClass ? digit : `[${digit}]`);
      case "D":
        if (inClass) return two(ascii ? errNi("\\D inside a class with re.ASCII") : "\\P{Nd}");
        return two(`[^${digit}]`);
      case "w":
        return two(inClass ? word : W);
      case "W":
        if (inClass) errNi("\\W inside a character class");
        return two(`[^${word}]`);
      case "s":
        return two(inClass ? space : `[${space}]`);
      case "S":
        if (inClass) errNi("\\S inside a character class");
        return two(`[^${space}]`);
      case "b":
        if (inClass) return two("\\x08");
        return two(ascii ? "\\b" : `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`);
      case "B":
        if (inClass) err("bad escape \\B");
        return two(ascii ? "\\B" : `(?:(?<=${W})(?=${W})|(?<!${W})(?!${W}))`);
      case "A":
        if (inClass) err("bad escape \\A");
        return two("(?<![\\s\\S])");
      case "Z":
        if (inClass) err("bad escape \\Z");
        return two("(?![\\s\\S])");
      case "n":
      case "t":
      case "r":
      case "f":
      case "v":
        return two("\\" + c);
      case "a":
        return two("\\x07");
      case "x": {
        const h = /^[0-9a-fA-F]{2}/.exec(p.slice(i + 2));
        if (!h) err("incomplete escape \\x");
        i += 4;
        return "\\x" + h[0];
      }
      case "u": {
        const h = /^[0-9a-fA-F]{4}/.exec(p.slice(i + 2));
        if (!h) err("incomplete escape \\u");
        i += 6;
        return "\\u" + h[0];
      }
      case "U": {
        const h = /^[0-9a-fA-F]{8}/.exec(p.slice(i + 2));
        if (!h) err("incomplete escape \\U");
        i += 10;
        const cp = parseInt(h[0], 16);
        if (cp > 0x10ffff) err("bad escape \\U");
        return "\\u{" + cp.toString(16) + "}";
      }
      case "N":
        return errNi("\\N{...} escapes");
    }
    if (c >= "0" && c <= "9") {
      const oct = /^[0-7]{3}/.exec(p.slice(i + 1));
      if (c === "0" || (oct && !inClass) || inClass) {
        // Octal escape: \0, \0oo, \ooo (in a class every digit escape is octal).
        const m = /^[0-7]{1,3}/.exec(p.slice(i + 1));
        if (!m) err(`bad escape \\${c}`);
        const v = parseInt(m[0], 8);
        if (v > 0o377) err("octal escape value outside of range 0-0o377");
        i += 1 + m[0].length;
        return "\\u{" + v.toString(16) + "}";
      }
      const m = /^[1-9][0-9]?/.exec(p.slice(i + 1));
      if (!m) err(`bad escape \\${c}`);
      i += 1 + m[0].length;
      return "\\" + m[0];
    }
    if (/[A-Za-z0-9]/.test(c)) err(`bad escape \\${c}`);
    // Escaped punctuation / non-ASCII: the literal character.
    const [ch] = p.slice(i + 1, i + 3);
    i += 1 + ch.length;
    return literal(ch, inClass);
  };

  const errNi = (what: string): never => {
    throw new NotImplementedError(`py_re: ${what} has no JS RegExp equivalent`);
  };

  while (i < n) {
    const c = p[i];
    if (verbose && /[ \t\n\r\f\v]/.test(c)) {
      i++;
      continue;
    }
    if (verbose && c === "#") {
      while (i < n && p[i] !== "\n") i++;
      continue;
    }
    if (c === "\\") {
      out.push(escape(false));
      continue;
    }
    if (c === "[") {
      i++;
      let cls = "[";
      if (p[i] === "^") {
        cls += "^";
        i++;
      }
      if (p[i] === "]") {
        cls += "\\]";
        i++;
      }
      for (;;) {
        if (i >= n) err("unterminated character set");
        const d = p[i];
        if (d === "]") {
          i++;
          break;
        }
        if (d === "\\") {
          cls += escape(true);
          continue;
        }
        if (d === "[") {
          cls += "\\[";
          i++;
          continue;
        }
        const [ch] = p.slice(i, i + 2);
        cls += ch;
        i += ch.length;
      }
      out.push(cls + "]");
      continue;
    }
    if (c === "(") {
      if (p[i + 1] !== "?") {
        out.push("(");
        i++;
        continue;
      }
      const rest = p.slice(i);
      let m: RegExpExecArray | null;
      if ((m = /^\(\?P<([^>]*)>/.exec(rest))) {
        if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(m[1])) err(`bad character in group name '${m[1]}'`);
        out.push(`(?<${m[1]}>`);
        i += m[0].length;
        continue;
      }
      if ((m = /^\(\?P=([^)]*)\)/.exec(rest))) {
        out.push(`\\k<${m[1]}>`);
        i += m[0].length;
        continue;
      }
      if ((m = /^\(\?#[^)]*\)/.exec(rest))) {
        i += m[0].length;
        continue;
      }
      if ((m = /^\(\?(?::|=|!|<=|<!)/.exec(rest))) {
        out.push(m[0]);
        i += m[0].length;
        continue;
      }
      if (/^\(\?[aiLmsux-]+[:)]/.test(rest)) {
        if (/^\(\?[aiLmsux]+\)/.test(rest)) err("global flags not at the start of the expression");
        errNi("scoped inline flags (?flags:...)");
      }
      err("unknown extension");
    }
    if (c === "{") {
      const m = /^\{(\d*)(,(\d*))?\}/.exec(p.slice(i));
      if (m && (m[1] !== "" || m[2] !== undefined)) {
        out.push(`{${m[1] === "" ? "0" : m[1]}${m[2] !== undefined ? "," + m[3] : ""}}`);
        i += m[0].length;
        if (p[i] === "+") errNi("possessive quantifiers");
        continue;
      }
      out.push("\\{");
      i++;
      continue;
    }
    if (c === "}" || c === "]") {
      out.push("\\" + c);
      i++;
      continue;
    }
    if (c === ".") {
      out.push(dotall ? "[\\s\\S]" : "[^\\n]");
      i++;
      continue;
    }
    if (c === "^") {
      out.push(multiline ? "(?<![^\\n])" : "(?<![\\s\\S])");
      i++;
      continue;
    }
    if (c === "$") {
      out.push(multiline ? "(?![^\\n])" : "(?=\\n?(?![\\s\\S]))");
      i++;
      continue;
    }
    if ((c === "*" || c === "+" || c === "?") && p[i + 1] === "+") errNi("possessive quantifiers");
    const [ch] = p.slice(i, i + 2);
    out.push(ch === "/" ? "\\/" : ch);
    i += ch.length;
  }
  return [out.join(""), flags];
}

// Compiled-pattern methods over a RegExp (from `pyRe` or a literal).

const sticky = new WeakMap<RegExp, RegExp>();

function variant(cache: WeakMap<RegExp, RegExp>, re: RegExp, flag: string): RegExp {
  let v = cache.get(re);
  if (v === undefined) {
    v = new RegExp(re.source, re.flags.replace(/[gy]/g, "") + flag);
    cache.set(re, v);
  }
  return v;
}

/** `pattern.match(s, pos)`: a match starting exactly at `pos`, or `null`. */
export function patternMatch(re: RegExp, s: string, pos = 0): RegExpExecArray | null {
  const y = variant(sticky, re, "y");
  y.lastIndex = pos;
  return y.exec(s);
}
