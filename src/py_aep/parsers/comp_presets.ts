/**
 * Parse New Composition presets from After Effects preferences.
 *
 * AE stores the Composition Settings dialog's preset dropdown in the
 * machine-independent composition preferences file:
 *
 * - `Composition Preset Names Section v11` - display names, `"-"` entries
 *   are menu separators
 * - `Composition Presets Section v11` - 16-byte binary entries decoded by
 *   `CompPresetItem` (width, height, frame rate, pixel aspect)
 *
 * Entries are matched by their shared 3-digit key (`"000"`, `"001"`, ...).
 */

import { CompPresetItem } from "../binary/composition_chunks.ts";
import { PrefsFile, decodePrefString, parseHexValue } from "./prefs.ts";
import { getitem, pyAssert, sorted } from "../../pyrt/index.ts";

export const _NAMES_SECTION = "Composition Preset Names Section v11";
export const _PRESETS_SECTION = "Composition Presets Section v11";
export const _PRESET_SIZE = 16;

/**
 * A New Composition preset from the AE preferences.
 *
 * **Attributes:**
 * name: Display name (e.g. `HD . 1920x1080 . 25 fps`, with
 * bullet separators).
 * width: Width in pixels.
 * height: Height in pixels.
 * pixel_aspect: Pixel aspect ratio.
 * frame_rate: Frame rate in frames per second.
 */
export class CompPreset {
  name: string;
  width: number;
  height: number;
  pixelAspect: number;
  frameRate: number;

  constructor(name: string, width: number, height: number, pixelAspect: number, frameRate: number) {
    this.name = name;
    this.width = width;
    this.height = height;
    this.pixelAspect = pixelAspect;
    this.frameRate = frameRate;
  }
}

/**
 * Parse New Composition presets from a composition preferences file.
 *
 * Menu separators (`"-"` names, all-zero entries) are skipped.
 */
export function parseCompPresets(prefsFile: PrefsFile): CompPreset[] {
  const names = prefsFile.section(_NAMES_SECTION);
  const entries = prefsFile.section(_PRESETS_SECTION);
  const presets: CompPreset[] = [];
  for (const key of sorted(entries.keys())) {
    const rawName = names.get(key) ?? null;
    if (rawName == null) continue;
    const name = decodePrefString(rawName);
    const data = parseHexValue(getitem(entries, key));
    if (name === "-" || data.length !== _PRESET_SIZE) continue;
    const item = CompPresetItem.frombytes(data);
    pyAssert(item instanceof CompPresetItem);
    if (item.width === 0 || item.pixel_aspect_divisor === 0) continue;
    presets.push(
      new CompPreset(
        name,
        item.width,
        item.height,
        item.pixel_aspect,
        item.frame_rate,
      ),
    );
  }
  return presets;
}
