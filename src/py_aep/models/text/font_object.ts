/** Font object model for After Effects text layers. */

import { descriptor, split, str, instanceDict } from "../../../pyrt/index.ts";
import type { CosDict, CosNode } from "../../cos/cos.ts";
import { CosField, type InstanceValue } from "../../cos/descriptors.ts";
import { cosIter, cosNum } from "../../cos/kinds.ts";

/** Decode the COS design vector (16.16 fixed-point ints) to floats. */
export function _designVectorFromCos(raw: CosNode): number[] {
  return cosIter(raw).map((v) => cosNum(v) / 65536.0);
}

const isString = (v: InstanceValue): v is string => typeof v === "string";
const isStringOrNull = (v: InstanceValue): v is string | null => v == null || typeof v === "string";
const isNumberList = (v: InstanceValue): v is number[] | null =>
  v == null || (Array.isArray(v) && v.every((x) => typeof x === "number"));

/**
 * Provides information about a specific font.
 *
 * The Font object provides information about a specific font, along with
 * the font technology used, helping disambiguate when multiple fonts
 * sharing the same PostScript name are installed on the system.
 *
 * ```ts
 * import { parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const comp = app.project.compositions[0];
 * const font = comp.textLayers[0].text.sourceText.value.fontObject;
 * console.log(font.postScriptName);
 * ```
 *
 * **Note:** 
 * This functionality was added in After Effects 24.0.
 *
 * @example
 * @see https://ae-scripting.docsforadobe.dev/text/fontobject/
 */
export class FontObject {
  /** The PostScript name of the font. Read-only. */
  declare postScriptName: string;

  /** The version number of the font. Read-only. */
  declare version: string | null;

  /**
   * For variable fonts, an ordered array with a length matching the
   * number of design axes defined by the font. `null` for non-variable
   * fonts. Read-only.
   *
   * Stored in the file as 16.16 fixed-point integers; exposed as floats
   * (e.g. `[700.0, 87.5]`).
   */
  declare designVector: number[] | null;

  declare _font_data: CosDict;
  declare _font_entry: CosDict | null;

  /** Returns `true` if the font is a variable font. Read-only. */
  get hasDesignAxes(): boolean {
    return this.designVector != null;
  }

  /**
   * The family prefix of the variable font. For example, the family
   * of the PostScript name `SFPro-Bold` is `SFPro`. `null` for
   * non-variable fonts. Read-only.
   */
  get familyPrefix(): string | null {
    if (!this.hasDesignAxes) return null;
    return split(this.postScriptName, "-", 1)[0];
  }

  constructor(kw: {
    _font_data: CosDict;
    _font_entry?: CosDict | null;
    post_script_name?: string | null;
    version?: string | null;
  }) {
    const { _font_data, _font_entry = null, post_script_name = null, version = null } = kw;
    this._font_data = _font_data;
    this._font_entry = _font_entry;
    if (post_script_name != null) {
      instanceDict(this).set("postScriptName", post_script_name);
    }
    if (version != null) {
      instanceDict(this).set("version", version);
    }
  }
}

descriptor(
  FontObject,
  "postScriptName",
  new CosField<string, "_font_data", FontObject>("_font_data", "0", {
    transform: str,
    accepts: isString,
    reverse: (x: string) => x,
    default: "",
  }),
);
descriptor(
  FontObject,
  "version",
  new CosField<string | null, "_font_data", FontObject>("_font_data", "5", {
    transform: str,
    accepts: isStringOrNull,
    reverse: (x: string) => x,
    default: null,
  }),
);
descriptor(
  FontObject,
  "designVector",
  new CosField<number[] | null, "_font_data", FontObject>("_font_data", "4", {
    transform: _designVectorFromCos,
    accepts: isNumberList,
    read_only: true,
    default: null,
  }),
);
