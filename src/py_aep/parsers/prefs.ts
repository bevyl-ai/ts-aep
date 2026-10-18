/**
 * Generic reader for After Effects preference text files.
 *
 * AE persists its preferences as INI-like text files under the user's
 * AppData directory (e.g.
 * `~/AppData/Roaming/Adobe/After Effects/26.0/`), one file per
 * {@link PREFType} category:
 *
 * - `Adobe After Effects <ver> Prefs.txt` - machine specific
 * - `... Prefs-indep-general.txt` - machine independent
 * - `... Prefs-indep-render.txt` - render settings templates
 * - `... Prefs-indep-output.txt` - output module templates
 * - `... Prefs-indep-composition.txt` - new-composition presets
 * - `... Prefs-text.txt` - text style defaults
 * - `... Prefs-paint.txt` - paint tool defaults
 *
 * File format:
 *
 * - section headers: `["Section Name"]`
 * - keys: one tab of indent, `"Key Name" = value`
 * - values: AE's mixed hex/ASCII encoding - quoted ASCII runs with bare
 *   hex bytes outside the quotes (e.g. `"HD  "E280A2"  1920x1080"`), or
 *   raw hex bytes (`01`), or quoted decimal strings (`"30.000000"`)
 * - long values continue on following lines (double-tab indent, trailing
 *   backslash); backslashes sit outside quoted runs and decode to nothing
 *
 * This module is read-only: py_aep never writes AE preference files.
 */

import { PREFType } from "../enums/general.ts";
import { Bytes, decode, encode, getOrInsert, ValueError, compare } from "../../pyrt/index.ts";
import type { Path } from "../../pyrt/index.ts";

// One glob per preference file category; file names embed the AE version.
export const _PREF_FILE_GLOBS: Readonly<Record<PREFType, string>> = {
  [PREFType.PREF_Type_MACHINE_SPECIFIC]: "* Prefs.txt",
  [PREFType.PREF_Type_MACHINE_INDEPENDENT]: "*Prefs-indep-general.txt",
  [PREFType.PREF_Type_MACHINE_INDEPENDENT_RENDER]: "*Prefs-indep-render.txt",
  [PREFType.PREF_Type_MACHINE_INDEPENDENT_OUTPUT]: "*Prefs-indep-output.txt",
  [PREFType.PREF_Type_MACHINE_INDEPENDENT_COMPOSITION]: "*Prefs-indep-composition.txt",
  [PREFType.PREF_Type_MACHINE_SPECIFIC_TEXT]: "*Prefs-text.txt",
  [PREFType.PREF_Type_MACHINE_SPECIFIC_PAINT]: "*Prefs-paint.txt",
};

// Python's `.` matches everything except "\n" (JS `.` also excludes "\r", U+2028, U+2029), so use [^\n].
export const _SECTION_RE = /^\["([^\n]*)"\]/;
export const _KEY_RE = /^\t"([^\n]+?)" = ([^\n]*)$/;

/** Locate the preference file for `prefType` under `prefsDir`. */
export function findPrefsFile(prefsDir: Path, prefType: PREFType): Path | null {
  // Path ordering in Python compares parts; all matches share one parent, so the string form orders the same.
  const matches = [...prefsDir.glob(_PREF_FILE_GLOBS[prefType])].sort((a, b) => compare(a.toString(), b.toString()));
  return matches?.length > 0 ? matches[0] : null;
}

/**
 * Collapse AE preference continuation lines into logical lines.
 *
 * Key lines start with a single tab followed by a quote; continuation
 * lines are indented further (or start with a tab but no quote) and
 * are appended to the previous logical line.
 */
export function collapseContinuationLines(text: string): string[] {
  const lines = text.split("\n");
  const result: string[] = [];
  for (const line of lines) {
    const stripped = line.trimEnd();
    if (!stripped) continue;
    // Continuation lines start with tab and contain hex data
    if (result.length > 0 && stripped.startsWith("\t") && !stripped.startsWith('\t"')) {
      result[result.length - 1] += stripped.trim();
    } else {
      result.push(stripped);
    }
  }
  return result;
}

/**
 * Decode a mixed hex/ASCII value from AE preferences.
 *
 * The value contains hex digits and quoted ASCII strings like:
 * `00D00BEE..."Best Settings"0000...`
 */
export function parseHexValue(value: string): Uint8Array {
  const raw: number[] = [];
  let i = 0;
  while (i < value.length) {
    if (value[i] === '"') {
      const end = value.indexOf('"', i + 1);
      if (end < 0) throw new ValueError("substring not found");
      for (const c of encode(value.slice(i + 1, end), "ascii")) raw.push(c);
      i = end + 1;
    } else if ("0123456789ABCDEFabcdef".includes(value[i])) {
      const pair = value.slice(i, i + 2);
      raw.push(Number.parseInt(pair, 16));
      i += 2;
    } else {
      i += 1;
    }
  }
  return Uint8Array.from(raw);
}

/** Parse decimal text into an int when integral, else a float. */
export function parseNumberText(text: string): number {
  const stripped = text.trim();
  // "30.0" and "30" both read as 30: integral values are plain numbers. `+ 0` turns "-0" into 0.
  return /^[+-]?\d+$/.test(stripped) ? Number(stripped) + 0 : Number(stripped);
}

/** Decode a preference value as text (hex escapes become UTF-8). */
export function decodePrefString(raw: string): string {
  return decode(parseHexValue(raw), "utf-8", "replace");
}

/**
 * Decode a preference value as a number.
 *
 * Quoted values parse as decimal text (`"30.000000"` -\> 30.0,
 * `"999"` -\> 999); unquoted values are raw hex bytes interpreted as a
 * big-endian unsigned integer (`01` -\> 1).
 *
 * @throws {@link ValueError} If a quoted value is not numeric text.
 */
export function decodePrefNumber(raw: string): number {
  if (raw.includes('"')) return parseNumberText(decodePrefString(raw));
  const data = parseHexValue(raw);
  // TODO(port): Python's int is exact; get_pref_as_number's public return type is number, so an
  // unquoted hex value of 7+ significant bytes (or quoted integer text) beyond 2^53 rounds to the
  // nearest double. decode_pref_bool stays exact: no nonzero integer rounds to 0.
  return Bytes.intFromBytes(data, "big");
}

/** Decode a preference value as a boolean (`01`, `"1"`, `00`, `"0"`). */
export function decodePrefBool(raw: string): boolean {
  return decodePrefNumber(raw) !== 0;
}

/**
 * Parsed section/key view of one AE preference text file.
 *
 * Values are kept in their raw text form; decode on demand with
 * `decodePrefString` / `decodePrefNumber` / `decodePrefBool` or
 * `parseHexValue` for binary blobs.
 */
export class PrefsFile {
  declare _sections: Map<string, Map<string, string>>;

  constructor(sections: Map<string, Map<string, string>>) {
    this._sections = sections;
  }

  /** Parse preference file text into a `PrefsFile`. */
  static fromText(text: string): PrefsFile {
    const sections: Map<string, Map<string, string>> = new Map();
    let current: Map<string, string> | null = null;
    for (const line of collapseContinuationLines(text)) {
      const sectionMatch = _SECTION_RE.exec(line);
      if (sectionMatch) {
        current = getOrInsert(sections, sectionMatch[1], new Map<string, string>());
        continue;
      }
      const keyMatch = _KEY_RE.exec(line);
      if (keyMatch && current != null) {
        current.set(keyMatch[1], keyMatch[2]);
      }
    }
    return new this(sections);
  }

  /** Read and parse a preference file from disk. */
  static fromPath(path: Path): PrefsFile {
    // Python text mode reads with universal newlines: `\r\n` and lone `\r` both become `\n`.
    const text = decode(path.readBytes(), "utf-8", "replace").replace(/\r\n?/g, "\n");
    return this.fromText(text);
  }

  /** Return the raw text value for `section`/`key`, or None. */
  getRaw(section: string, key: string): string | null {
    return (this._sections.get(section) ?? new Map<string, string>()).get(key) ?? null;
  }

  /**
   * Return a copy of the raw key -\> value mapping for a section
   * (empty if the section is absent).
   */
  section(name: string): Map<string, string> {
    return new Map(this._sections.get(name) ?? new Map<string, string>());
  }
}
