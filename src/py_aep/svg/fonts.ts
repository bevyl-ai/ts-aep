/**
 * Resolve an SVG `font-family` to an installed font file.
 *
 * SVG text is rendered by outlining glyphs (see `svg.text`), which needs the
 * actual font file. This module discovers installed fonts from the standard OS
 * font directories (lazily, cached) and matches a CSS `font-family` plus
 * weight/style to a file, mirroring the discover-at-use pattern in `color.icc`.
 * Fonts are not bundled.
 */

import type * as fontkit from "fontkit";
import { dep } from "../../pyrt/deps.ts";
import * as host from "../../pyrt/host.ts";
import { Path, getOrInsert, StopIteration } from "../../pyrt/index.ts";

const _FONT_SUFFIXES: readonly string[] = [".ttf", ".otf", ".ttc"];

/**
 * family (lowercased) -\> \{subfamily (lowercased): (font file path, face index)\}
 * The face index addresses a face within a TrueType Collection (.ttc); it is
 * 0 for a single-face .ttf/.otf.
 */
let _index: Map<string, Map<string, [Path, number]>> | null = null;

/**
 * CSS generic families mapped to concrete fonts to try, in order. Used when a
 * requested family is not installed (an unknown family falls back to the
 * sans-serif chain, as a user agent would).
 */
const _GENERIC_FALLBACKS = new Map<string, readonly string[]>([
  [
    "sans-serif",
    [
      "arial",
      "helvetica",
      "helvetica neue",
      "liberation sans",
      "dejavu sans",
      "segoe ui",
      "noto sans",
      "verdana",
      "tahoma",
    ],
  ],
  ["serif", ["times new roman", "georgia", "liberation serif", "dejavu serif", "noto serif", "cambria"]],
  ["monospace", ["consolas", "courier new", "liberation mono", "dejavu sans mono", "noto sans mono", "menlo"]],
  ["cursive", ["comic sans ms", "segoe script"]],
  ["fantasy", ["impact"]],
  ["system-ui", ["segoe ui", "arial", "helvetica", "dejavu sans"]],
  ["ui-sans-serif", ["segoe ui", "arial", "helvetica", "dejavu sans"]],
]);

/**
 * NOTE(port): pytest `monkeypatch.setattr(fonts_mod, "_fontDirs"/"_index", ...)`
 * cannot rebind ESM exports; tests use these hooks instead (same effect).
 */
export function _setFontDirs(fn: (() => Path[]) | null): void {
  _fontDirsOverride = fn;
}
export function _setIndex(v: Map<string, Map<string, [Path, number]>> | null): void {
  _index = v;
}
let _fontDirsOverride: (() => Path[]) | null = null;

/** The standard OS font directories that exist on this machine. */
function _fontDirs(): Path[] {
  if (_fontDirsOverride != null) {
    return _fontDirsOverride();
  }
  const dirs: Path[] = [];
  if (host.platform === "win32") {
    const windir = host.env.WINDIR ?? "C:\\Windows";
    dirs.push(new Path(windir).div("Fonts"));
    const local = host.env.LOCALAPPDATA;
    if (local) {
      dirs.push(new Path(local).div("Microsoft", "Windows", "Fonts"));
    }
  } else if (host.platform === "darwin") {
    dirs.push(new Path("/System/Library/Fonts"), new Path("/Library/Fonts"), Path.home().div("Library", "Fonts"));
  } else {
    dirs.push(
      new Path("/usr/share/fonts"),
      new Path("/usr/local/share/fonts"),
      Path.home().div(".fonts"),
      Path.home().div(".local", "share", "fonts"),
    );
  }
  return dirs.filter((d) => d.isDir());
}

/** fontTools name IDs -\> fontkit `getName` keys. */
const NAME_KEYS = new Map<number, string>([
  [1, "fontFamily"],
  [2, "fontSubfamily"],
  [5, "version"],
  [6, "postscriptName"],
  [16, "preferredFamily"],
  [17, "preferredSubfamily"],
]);

/**
 * First non-empty name among the given name IDs, or `null`.
 * TODO(port): fontTools `getDebugName` falls back across platform/language
 * name records (Windows-English, then Mac, then any); fontkit `getName(key)`
 * reads the English record only. Affects fonts whose requested ID exists only
 * under a non-English or non-primary platform record: Python finds it, TS
 * returns null.
 */
function _name(font: fontkit.Font, ...ids: number[]): string | null {
  // `table = font.get("name"); if table is None: return None`
  let table: fontkit.Font["name"] | null;
  try {
    table = font.name;
  } catch (e) {
    table = null;
  }
  if (table == null) {
    return null;
  }
  for (const nid of ids) {
    const nameKey = NAME_KEYS.get(nid);
    if (nameKey === undefined) {
      continue;
    }
    const value = font.getName(nameKey);
    if (value) {
      return value;
    }
  }
  return null;
}

/** Adobe CoreSync (Creative Cloud) font caches, when present.
 *
 * Activated Adobe fonts live here as suffix-less OpenType files; AE
 * resolves text-layer fonts against them.
 */
function _adobeFontDirs(): Path[] {
  const dirs: Path[] = [];
  if (host.platform === "win32") {
    const appdata = host.env.APPDATA;
    if (appdata) {
      dirs.push(new Path(appdata).div("Adobe", "CoreSync", "plugins", "livetype", "r"));
    }
  } else if (host.platform === "darwin") {
    dirs.push(Path.home().div("Library", "Application Support", "Adobe", "CoreSync", "plugins", "livetype", ".r"));
  }
  return dirs.filter((d) => d.isDir());
}

/**
 * PostScript name (name ID 6, lowercased) -\>
 * (font file path, face index, version string from name ID 5 or `null`).
 */
let _psIndex: Map<string, [Path, number, string | null]> | null = null;

/**
 * Yield `(face index, opened font)` for each face in a font file,
 * closing every face afterwards.
 *
 * Corrupt/unsupported files yield nothing rather than fail discovery.
 */
function* _iterFaces(path: Path): Generator<[number, fontkit.Font]> {
  let fonts: fontkit.Font[];
  try {
    const opened = dep("fontkit").create(host.fs.readFileSync(path.toString()));
    if (path.suffix.toLowerCase() === ".ttc") {
      if (opened.fonts == null) {
        return;
      }
      fonts = [...opened.fonts];
    } else {
      // NOTE(port): TTFont(fontNumber=0) on a non-.ttc file; fontkit returns a
      // collection (with `.fonts`) only for collection files, so take face 0.
      fonts = [opened.fonts ? opened.fonts[0] : opened];
    }
  } catch (e) {
    return;
  }
  try {
    yield* fonts.entries();
  } finally {
    // NOTE(port): fontkit has no close(); it reads the whole file eagerly, so
    // no handle is left open and `font.close()` has nothing to release.
  }
}

function _indexPostscript(path: Path, idx: Map<string, [Path, number, string | null]>): void {
  for (const [face, font] of _iterFaces(path)) {
    const psName = _name(font, 6);
    if (!psName) {
      continue;
    }
    const key = psName.toLowerCase();
    const existing = idx.get(key);
    if (existing == null) {
      idx.set(key, [path, face, _name(font, 5)]);
    } else if (existing[2] == null) {
      // The first-seen face resolves the name, but a later
      // duplicate can still supply the version string it lacked
      // (the pre-index code only ever stored truthy versions).
      const version = _name(font, 5);
      if (version) {
        idx.set(key, [existing[0], existing[1], version]);
      }
    }
  }
}

/**
 * Yield every font file under the OS font directories. Both index
 * builders (`_buildIndex`, `_postscriptIndex`) walk the same tree.
 */
function* _walkFontFiles(): Generator<Path> {
  for (const directory of _fontDirs()) {
    for (const path of directory.rglob("*")) {
      if (_FONT_SUFFIXES.includes(path.suffix.toLowerCase())) {
        yield path;
      }
    }
  }
}

/**
 * The lazily built, cached PostScript-name index (one walk over the
 * OS and Adobe CoreSync font directories).
 */
function _postscriptIndex(): Map<string, [Path, number, string | null]> {
  if (_psIndex == null) {
    const idx = new Map<string, [Path, number, string | null]>();
    for (const path of _walkFontFiles()) {
      _indexPostscript(path, idx);
    }
    for (const directory of _adobeFontDirs()) {
      for (const path of directory.rglob("*")) {
        if (path.isFile()) {
          _indexPostscript(path, idx);
        }
      }
    }
    _psIndex = idx;
  }
  return _psIndex;
}

/**
 * Resolve a PostScript name (name ID 6) to an installed font face.
 *
 * Returns `(font file path, face index)` - the index selects a face
 * within a `.ttc` collection - or `null` when no matching font is
 * installed. This mirrors how AE's text engine identifies fonts, so
 * the composed-line resolver uses it for measurement.
 */
export function resolvePostscript(postScriptName: string): [Path, number] | null {
  const entry = _postscriptIndex().get(postScriptName.trim().toLowerCase());
  if (entry == null) {
    return null;
  }
  return [entry[0], entry[1]];
}

/**
 * The installed font's version string (name ID 5) for a PostScript
 * name, or `null` when no matching font is installed.
 *
 * AE stamps this host-resolved string on font entries it registers in
 * a text document and on the used-font records (probed via the
 * `W_FONT` write fixture); matching it keeps py-written files
 * byte-identical to AE's output on the same machine.
 */
export function fontVersionString(postScriptName: string): string | null {
  const entry = _postscriptIndex().get(postScriptName.trim().toLowerCase());
  if (entry == null) {
    return null;
  }
  return entry[2];
}

function _indexFile(path: Path, idx: Map<string, Map<string, [Path, number]>>): void {
  // A .ttc bundles several faces (e.g. cambria.ttc -> Cambria + Cambria
  // Math); index each by its own face number so a family that ships only
  // as a secondary face is still resolvable and loads the right face.
  for (const [face, font] of _iterFaces(path)) {
    // Typographic family (16) preferred over the legacy family (1); same
    // for the subfamily (17 over 2).
    const family = _name(font, 16, 1);
    const subfamily = _name(font, 17, 2) || "Regular";
    if (family) {
      getOrInsert(getOrInsert(idx, family.toLowerCase(), new Map<string, [Path, number]>()), subfamily.toLowerCase(), [
        path,
        face,
      ]);
    }
  }
}

function _buildIndex(): Map<string, Map<string, [Path, number]>> {
  const idx = new Map<string, Map<string, [Path, number]>>();
  for (const path of _walkFontFiles()) {
    _indexFile(path, idx);
  }
  return idx;
}

/** Choose the closest available face for the requested weight/style. */
function _pick(styles: Map<string, [Path, number]>, bold: boolean, italic: boolean): [Path, number] {
  let order: string[];
  if (bold && italic) {
    order = ["bold italic", "bolditalic", "bold oblique", "bold", "italic"];
  } else if (bold) {
    order = ["bold", "bold italic"];
  } else if (italic) {
    order = ["italic", "oblique"];
  } else {
    order = ["regular", "book", "roman"];
  }
  for (const key of order) {
    const face = styles.get(key);
    if (face !== undefined) {
      return face;
    }
  }
  const first = styles.values().next();
  if (first.done) {
    throw new StopIteration();
  }
  return first.value;
}

/**
 * Resolve a single family name to an installed font face, with NO
 * generic fallback.
 *
 * Unlike `resolveFont`, an uninstalled family returns `null` instead
 * of degrading to the sans-serif chain; used where substituting a
 * different font would be wrong (e.g. reading variable-font axes).
 * Returns `(font file path, face index)`.
 */
export function resolveFontExact(family: string): [Path, number] | null {
  if (_index == null) {
    _index = _buildIndex();
  }
  const styles =
    _index.get(
      family
        .trim()
        .replace(/^['"]+|['"]+$/g, "")
        .toLowerCase(),
    ) ?? null;
  if (!styles?.size) {
    return null;
  }
  return _pick(styles, false, false);
}

/**
 * Resolve a CSS `font-family` value to an installed font face.
 *
 * `family` may be a comma-separated list (quotes stripped); the first
 * installed family wins. Returns `(font file path, face index)` - the index
 * selects a face within a `.ttc` collection (0 for a single-face file) - or
 * `null` when no listed family is found.
 */
export function resolveFont(family: string, kw: { bold?: boolean; italic?: boolean } = {}): [Path, number] | null {
  const { bold = false, italic = false } = kw;
  if (_index == null) {
    _index = _buildIndex();
  }
  let generic: string | null = null;
  for (const raw of family.split(",")) {
    const name = raw
      .trim()
      .replace(/^['"]+|['"]+$/g, "")
      .toLowerCase();
    if (!name) {
      continue;
    }
    const styles = _index.get(name) ?? null;
    if (styles != null && styles.size > 0) {
      return _pick(styles, bold, italic);
    }
    if (generic == null && _GENERIC_FALLBACKS.has(name)) {
      generic = name;
    }
  }
  // No requested family is installed: fall back to the generic chain (the
  // requested generic, or sans-serif for an unknown family).
  for (const candidate of _GENERIC_FALLBACKS.get(generic || "sans-serif") ?? ([] satisfies readonly string[])) {
    const styles = _index.get(candidate) ?? null;
    if (styles != null && styles.size > 0) {
      return _pick(styles, bold, italic);
    }
  }
  return null;
}
