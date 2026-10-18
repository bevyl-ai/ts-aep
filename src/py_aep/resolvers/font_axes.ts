/** Variable-font design-axis reading via fontTools. */

import { dep } from "../../pyrt/deps.ts";
import * as host from "../../pyrt/host.ts";

import { ValueError } from "../../pyrt/index.ts";
import type { PathLike } from "../../pyrt/index.ts";

export type _PathLike = PathLike;

/** One design axis of a variable font (an `fvar` table entry). */
export class FontDesignAxis {
  /** The 4-character axis tag (e.g. `wght`). */
  readonly tag: string;

  /** The axis display name from the font's name table (e.g. `Weight`). */
  readonly name: string;

  readonly minValue: number;
  readonly defaultValue: number;
  readonly maxValue: number;

  constructor(tag: string, name: string, minValue: number, defaultValue: number, maxValue: number) {
    this.tag = tag;
    this.name = name;
    this.minValue = minValue;
    this.defaultValue = defaultValue;
    this.maxValue = maxValue;
  }

  *[Symbol.iterator](): Generator<string | number> {
    yield this.tag;
    yield this.name;
    yield this.minValue;
    yield this.defaultValue;
    yield this.maxValue;
  }
}

/**
 * Read the design axes of a variable font file.
 *
 * @param fontFile - Path to the variable font file (`.ttf` / `.otf` / `.ttc`).
 * @param fontNumber - Face index within a TrueType Collection (0 for
 *   single-face files).
 *
 * @throws ValueError If the font has no `fvar` table (not a variable font).
 */
export function readDesignAxes(fontFile: _PathLike, fontNumber: number = 0): FontDesignAxis[] {
  // NOTE(port): fontTools lazy=True defers table reads; fontkit reads eagerly. Results are identical, only I/O cost differs.
  const opened = dep("fontkit").create(host.fs.readFileSync(String(fontFile)));
  const faces = opened.fonts;
  if (faces != null && faces[fontNumber] == null) {
    throw new Error(`specify a font number between 0 and ${faces.length - 1} (inclusive)`);
  }
  const font = faces != null ? faces[fontNumber] : opened;
  try {
    if (!("fvar" in font.directory.tables)) {
      throw new ValueError(`${String(fontFile)} is not a variable font (it has no fvar table).`);
    }
    const nameTable = "name" in font.directory.tables ? font.name : null;
    const axes: FontDesignAxis[] = [];
    // TODO(port): fontkit exposes variationAxes as an object keyed by tag, so
    // order follows JS key order; only a font whose fvar tag is an integer-like
    // string (e.g. "1234") would be reordered vs fvar table order.
    for (const [axisTag, info] of Object.entries(font.variationAxes)) {
      let axisName: string | null | undefined = null;
      if (nameTable != null) {
        // TODO(port): fontTools getDebugName(axis.axisNameID) falls back across
        // name records and languages; fontkit's variationAxes name reads the
        // English record only. Differs for fonts lacking an English name record
        // for the axis (Python picks another language, fontkit gives no name).
        axisName = info.name;
      }
      axes.push(new FontDesignAxis(axisTag, axisName || axisTag, info.min, info.default, info.max));
    }
    return axes;
  } finally {
    // NOTE(port): font.close() has no twin; fontkit.openSync reads the whole file and holds no handle.
  }
}
