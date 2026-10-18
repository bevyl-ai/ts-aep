/**
 * Parse render queue templates from After Effects preferences files.
 *
 * AE stores render settings and output module templates in text-based
 * preference files under the user's AppData directory:
 *
 * - `Adobe After Effects <ver> Prefs-indep-render.txt` - render settings
 * - `Adobe After Effects <ver> Prefs-indep-output.txt` - output module templates
 *
 * The output file also contains the "Output File Info Preference Section" with
 * Rouu chunk data (154 bytes per entry) for each output module template.
 */

import {
  b,
  Bytes,
  concat,
  decode,
  int,
  assert,
  rstrip,
  split,
  strip,
  patternMatch,
  pyRe,
  reEscape,
  reMatch,
} from "../../pyrt/index.ts";
import type { Path } from "../../pyrt/index.ts";
import { OutputModuleSettingsItem, RenderSettingsItem } from "../binary/render_chunks.ts";
import { collapseContinuationLines, parseHexValue } from "./prefs.ts";

// Render settings prefs format:
// RenderSettingsItem is 2182 bytes in prefs (2246 in AEP, difference = 64).
export const _RS_PREFS_ITEM_SIZE = 2182;
export const _RS_AEP_ITEM_SIZE = 2246;
export const _RS_ITEM_SIZE_DIFF = _RS_AEP_ITEM_SIZE - _RS_PREFS_ITEM_SIZE;
export const _HEADER_SIZE = 32; // bytes before first item

// Output module prefs format:
// OutputModuleSettingsItem is 128 bytes (same in prefs and AEP).
export const _OM_PREFS_ITEM_SIZE = 128;

/**
 * An output module template parsed from AE preferences.
 *
 * **Attributes:**
 * settings: The binary settings for this template.
 * name: The template name from the prefs spec strings section.
 * format_info: Raw bytes of the `Rouu` chunk (output format header),
 * or None if no format info was found.
 * format_options: Raw bytes of the format-specific `Ropt` chunk (codec
 * / image-sequence options), from the "Output File Options
 * Preference Section". None if absent.
 * format_options_xml: The XML format options string, or None.
 */
export class OutputModuleTemplate {
  settings: OutputModuleSettingsItem;
  name: string;
  formatInfo: Uint8Array | null;
  formatOptions: Uint8Array | null;
  formatOptionsXml: string | null;

  constructor(
    settings: OutputModuleSettingsItem,
    name: string,
    formatInfo: Uint8Array | null = null,
    formatOptions: Uint8Array | null = null,
    formatOptionsXml: string | null = null,
  ) {
    this.settings = settings;
    this.name = name;
    this.formatInfo = formatInfo;
    this.formatOptions = formatOptions;
    this.formatOptionsXml = formatOptionsXml;
  }
}

/** Extract a hex/ASCII value from a preference section. */
export function _extractSectionValue(lines: string[], key: string): Uint8Array | null {
  for (const [i, line] of lines.entries()) {
    if (!line.includes(key)) continue;
    const m = reMatch(String.raw`\s*"` + reEscape(key) + String.raw`"\s*=\s*(.+)`, line);
    if (!m) continue;
    const valueParts: string[] = [strip(m[1])];
    for (let j = i + 1; j < lines.length; j++) {
      const nextLine = strip(lines[j]);
      if (!nextLine || nextLine.startsWith("#") || nextLine.startsWith("[")) break;
      if (nextLine.startsWith('"')) break;
      valueParts.push(nextLine);
    }
    return parseHexValue(valueParts.join(""));
  }
  return null;
}

/**
 * Parse render settings templates from AE preferences.
 *
 * @param prefsDir - Path to the AE version preferences directory (e.g.
 *   `~/AppData/Roaming/Adobe/After Effects/25.6`).
 * @returns A tuple of (templates, default_index). Templates is a list of parsed
 *   {@link RenderSettingsItem} objects. Default_index is the index of the default render settings
 *   template in the returned list, or None if not found (or the default entry was filtered out).
 */
export function parseRenderTemplates(prefsDir: Path): [RenderSettingsItem[], number | null] {
  const renderFiles = prefsDir.glob("*-indep-render.txt");
  if (!renderFiles?.length) {
    return [[], null];
  }

  // Python read_text(errors="replace"); pathlib shim has no errors= parameter.
  const text = decode(renderFiles[0].readBytes(), "utf-8", "replace");
  const lines = collapseContinuationLines(text);

  const raw = _extractSectionValue(lines, "Render Settings List");
  if (raw == null) {
    return [[], null];
  }

  // The prefs format omits the last 64 bytes (_remaining field).
  // Pad to match the aep format.
  const remaining = raw.length - _HEADER_SIZE;

  const rawDefaultIndex = _extractIntValue(lines, "Default RS Index");

  const count = Math.floor(remaining / _RS_PREFS_ITEM_SIZE);
  const templates: RenderSettingsItem[] = [];
  let defaultIndex: number | null = null;
  for (let idx = 0; idx < count; idx++) {
    const offset = _HEADER_SIZE + idx * _RS_PREFS_ITEM_SIZE;
    const itemData = raw.slice(offset, offset + _RS_PREFS_ITEM_SIZE);
    const item = RenderSettingsItem.frombytes(
      concat(itemData, Bytes.repeat(b("\x00"), _RS_ITEM_SIZE_DIFF)),
    );
    assert(item instanceof RenderSettingsItem);
    if (!item.cleanTemplateName) {
      continue;
    }
    // The prefs default index counts raw entries; remap it to the
    // filtered list. A filtered-out default yields None (no default).
    if (idx === rawDefaultIndex) {
      defaultIndex = templates.length;
    }
    templates.push(item);
  }

  return [templates, defaultIndex];
}

/** Extract an integer value from a preference line like `"Key" = 42`. */
export function _extractIntValue(lines: string[], key: string): number | null {
  for (const line of lines) {
    const m = reMatch(String.raw`\s*"` + reEscape(key) + String.raw`"\s*=\s*"?(\d+)"?`, line);
    if (m) {
      return int(m[1]);
    }
  }
  return null;
}

/**
 * Parse output module templates from AE preferences.
 *
 * @param prefsDir - Path to the AE version preferences directory (e.g.
 *   `~/AppData/Roaming/Adobe/After Effects/25.6`).
 * @returns A tuple of (templates, default_index). Templates is a list of
 *   {@link OutputModuleTemplate} objects. Default_index is the index of the default output module
 *   template in the returned list, or None if not found (or the default entry was filtered out).
 *   Templates whose name starts with `_HIDDEN` are excluded.
 */
export function parseOutputTemplates(prefsDir: Path): [OutputModuleTemplate[], number | null] {
  const outputFiles = prefsDir.glob("*-indep-output.txt");
  if (!outputFiles?.length) {
    return [[], null];
  }

  // Python read_text(errors="replace"); pathlib shim has no errors= parameter.
  const text = decode(outputFiles[0].readBytes(), "utf-8", "replace");
  const lines = collapseContinuationLines(text);

  const raw = _extractSectionValue(lines, "Output Module List v28");
  if (raw == null) {
    return [[], null];
  }

  const names = _extractTemplateNames(lines);

  // Rouu header bytes ("Output File Info") and the format-specific Ropt
  // bytes ("Output File Options"), both keyed by the same template index.
  const formatInfos = _parseIdHexSection(
    text,
    "Output File Info Preference Section",
    "Output File Info",
  );
  const formatOpts = _parseIdHexSection(
    text,
    "Output File Options Preference Section",
    "Output File Options",
  );

  const rawDefaultIndex = _extractIntValue(lines, "Default OM Index");

  const remaining = raw.length - _HEADER_SIZE;
  const count = Math.floor(remaining / _OM_PREFS_ITEM_SIZE);
  const templates: OutputModuleTemplate[] = [];
  let defaultIndex: number | null = null;
  for (let idx = 0; idx < count; idx++) {
    const offset = _HEADER_SIZE + idx * _OM_PREFS_ITEM_SIZE;
    const itemData = raw.slice(offset, offset + _OM_PREFS_ITEM_SIZE);
    const item = OutputModuleSettingsItem.frombytes(itemData);
    assert(item instanceof OutputModuleSettingsItem);
    const name = names.get(idx) ?? "";
    if (!name || name.startsWith("_HIDDEN")) {
      continue;
    }
    // The prefs default index counts raw entries; remap it to the
    // filtered list. A filtered-out default yields None (no default).
    if (idx === rawDefaultIndex) {
      defaultIndex = templates.length;
    }
    templates.push(
      new OutputModuleTemplate(
        item,
        name,
        formatInfos.get(idx) ?? null,
        formatOpts.get(idx) ?? null,
      ),
    );
  }

  return [templates, defaultIndex];
}

/**
 * Parse a `"<id_prefix> ID # N" = <hex/ascii>` preferences section.
 *
 * Used for both "Output File Info" (the `Rouu` header) and "Output File
 * Options" (the `Ropt` format options). Values span continuation lines
 * (double-tab indented, trailing backslash) and use AE's mixed hex/ASCII
 * encoding decoded by `parseHexValue`. Parsing is bounded to the named
 * section so continuation lines never leak across section boundaries.
 *
 * @param text - Full preferences file text.
 * @param section - Substring identifying the section header line (e.g. "Output File Info Preference
 *   Section").
 * @param idPrefix - The per-entry key prefix (e.g. "Output File Info").
 * @returns A dict mapping template index to decoded raw bytes.
 */
export function _parseIdHexSection(text: string, section: string, idPrefix: string): Map<number, Uint8Array> {
  const entries = new Map<number, Uint8Array>();
  let currentIdx: number | null = null;
  let currentValue = "";
  let inSection = false;
  const entryRe = pyRe(String.raw`\s*"` + reEscape(idPrefix) + String.raw` ID #\s*(\d+)"\s*=\s*(.+)`);

  // Python `nonlocal current_idx`: the closure writes the enclosing `let`.
  function _flush(): void {
    if (currentIdx != null) {
      entries.set(currentIdx, parseHexValue(currentValue));
      currentIdx = null;
    }
  }

  for (const line of split(text, "\n")) {
    const stripped = rstrip(line);
    if (!stripped) {
      continue;
    }
    if (stripped.startsWith("[")) {
      // section boundary
      _flush();
      inSection = stripped.includes(section);
      continue;
    }
    if (!inSection) {
      continue;
    }
    const m = patternMatch(entryRe, stripped);
    if (m) {
      _flush();
      currentIdx = int(m[1]);
      const value = strip(m[2]);
      currentValue = value.endsWith("\\") ? value.slice(0, -1) : value;
      continue;
    }
    if (currentIdx != null && stripped.startsWith("\t\t")) {
      const value = strip(stripped);
      currentValue += value.endsWith("\\") ? value.slice(0, -1) : value;
    }
  }

  _flush();
  return entries;
}

/** Extract template names from Output Module Spec Strings section. */
export function _extractTemplateNames(lines: string[]): Map<number, string> {
  const names = new Map<number, string>();
  for (const line of lines) {
    const m = reMatch(String.raw`\s*"Output Module Spec Strings Name #?(\d+)"\s*=\s*"(.*)"`, line);
    if (m) {
      const idx = int(m[1]);
      names.set(idx, m[2]);
    }
  }
  return names;
}
