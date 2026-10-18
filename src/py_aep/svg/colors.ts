/**
 * CSS/SVG color parsing to 0.0-1.0 RGBA.
 *
 * `parseColor` accepts `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`,
 * `rgba()`, `hsl()`, `hsla()`, the SVG named colors, plus `none`,
 * `transparent` and `currentColor`.
 */

import { float, ValueError, patternMatch, pyRe, reFlags } from "../../pyrt/index.ts";
import { NUMBER_PCT_RE, clamp01 } from "./_util.ts";

// Python: `if TYPE_CHECKING: Rgba = tuple[float, float, float, float]`.
// A type-checker-only name, so it has no runtime value here either.
export type Rgba = readonly [number, number, number, number];

// SVG/CSS named colors (the full set), as 0-255 RGB.
// A Map, not an object: the key is arbitrary user input, so "constructor" and
// "__proto__" must miss rather than hit Object.prototype.
export const _NAMED = new Map<string, readonly [number, number, number]>([
  ["aliceblue", [240, 248, 255]],
  ["antiquewhite", [250, 235, 215]],
  ["aqua", [0, 255, 255]],
  ["aquamarine", [127, 255, 212]],
  ["azure", [240, 255, 255]],
  ["beige", [245, 245, 220]],
  ["bisque", [255, 228, 196]],
  ["black", [0, 0, 0]],
  ["blanchedalmond", [255, 235, 205]],
  ["blue", [0, 0, 255]],
  ["blueviolet", [138, 43, 226]],
  ["brown", [165, 42, 42]],
  ["burlywood", [222, 184, 135]],
  ["cadetblue", [95, 158, 160]],
  ["chartreuse", [127, 255, 0]],
  ["chocolate", [210, 105, 30]],
  ["coral", [255, 127, 80]],
  ["cornflowerblue", [100, 149, 237]],
  ["cornsilk", [255, 248, 220]],
  ["crimson", [220, 20, 60]],
  ["cyan", [0, 255, 255]],
  ["darkblue", [0, 0, 139]],
  ["darkcyan", [0, 139, 139]],
  ["darkgoldenrod", [184, 134, 11]],
  ["darkgray", [169, 169, 169]],
  ["darkgreen", [0, 100, 0]],
  ["darkgrey", [169, 169, 169]],
  ["darkkhaki", [189, 183, 107]],
  ["darkmagenta", [139, 0, 139]],
  ["darkolivegreen", [85, 107, 47]],
  ["darkorange", [255, 140, 0]],
  ["darkorchid", [153, 50, 204]],
  ["darkred", [139, 0, 0]],
  ["darksalmon", [233, 150, 122]],
  ["darkseagreen", [143, 188, 143]],
  ["darkslateblue", [72, 61, 139]],
  ["darkslategray", [47, 79, 79]],
  ["darkslategrey", [47, 79, 79]],
  ["darkturquoise", [0, 206, 209]],
  ["darkviolet", [148, 0, 211]],
  ["deeppink", [255, 20, 147]],
  ["deepskyblue", [0, 191, 255]],
  ["dimgray", [105, 105, 105]],
  ["dimgrey", [105, 105, 105]],
  ["dodgerblue", [30, 144, 255]],
  ["firebrick", [178, 34, 34]],
  ["floralwhite", [255, 250, 240]],
  ["forestgreen", [34, 139, 34]],
  ["fuchsia", [255, 0, 255]],
  ["gainsboro", [220, 220, 220]],
  ["ghostwhite", [248, 248, 255]],
  ["gold", [255, 215, 0]],
  ["goldenrod", [218, 165, 32]],
  ["gray", [128, 128, 128]],
  ["grey", [128, 128, 128]],
  ["green", [0, 128, 0]],
  ["greenyellow", [173, 255, 47]],
  ["honeydew", [240, 255, 240]],
  ["hotpink", [255, 105, 180]],
  ["indianred", [205, 92, 92]],
  ["indigo", [75, 0, 130]],
  ["ivory", [255, 255, 240]],
  ["khaki", [240, 230, 140]],
  ["lavender", [230, 230, 250]],
  ["lavenderblush", [255, 240, 245]],
  ["lawngreen", [124, 252, 0]],
  ["lemonchiffon", [255, 250, 205]],
  ["lightblue", [173, 216, 230]],
  ["lightcoral", [240, 128, 128]],
  ["lightcyan", [224, 255, 255]],
  ["lightgoldenrodyellow", [250, 250, 210]],
  ["lightgray", [211, 211, 211]],
  ["lightgreen", [144, 238, 144]],
  ["lightgrey", [211, 211, 211]],
  ["lightpink", [255, 182, 193]],
  ["lightsalmon", [255, 160, 122]],
  ["lightseagreen", [32, 178, 170]],
  ["lightskyblue", [135, 206, 250]],
  ["lightslategray", [119, 136, 153]],
  ["lightslategrey", [119, 136, 153]],
  ["lightsteelblue", [176, 196, 222]],
  ["lightyellow", [255, 255, 224]],
  ["lime", [0, 255, 0]],
  ["limegreen", [50, 205, 50]],
  ["linen", [250, 240, 230]],
  ["magenta", [255, 0, 255]],
  ["maroon", [128, 0, 0]],
  ["mediumaquamarine", [102, 205, 170]],
  ["mediumblue", [0, 0, 205]],
  ["mediumorchid", [186, 85, 211]],
  ["mediumpurple", [147, 112, 219]],
  ["mediumseagreen", [60, 179, 113]],
  ["mediumslateblue", [123, 104, 238]],
  ["mediumspringgreen", [0, 250, 154]],
  ["mediumturquoise", [72, 209, 204]],
  ["mediumvioletred", [199, 21, 133]],
  ["midnightblue", [25, 25, 112]],
  ["mintcream", [245, 255, 250]],
  ["mistyrose", [255, 228, 225]],
  ["moccasin", [255, 228, 181]],
  ["navajowhite", [255, 222, 173]],
  ["navy", [0, 0, 128]],
  ["oldlace", [253, 245, 230]],
  ["olive", [128, 128, 0]],
  ["olivedrab", [107, 142, 35]],
  ["orange", [255, 165, 0]],
  ["orangered", [255, 69, 0]],
  ["orchid", [218, 112, 214]],
  ["palegoldenrod", [238, 232, 170]],
  ["palegreen", [152, 251, 152]],
  ["paleturquoise", [175, 238, 238]],
  ["palevioletred", [219, 112, 147]],
  ["papayawhip", [255, 239, 213]],
  ["peachpuff", [255, 218, 185]],
  ["peru", [205, 133, 63]],
  ["pink", [255, 192, 203]],
  ["plum", [221, 160, 221]],
  ["powderblue", [176, 224, 230]],
  ["purple", [128, 0, 128]],
  ["rebeccapurple", [102, 51, 153]],
  ["red", [255, 0, 0]],
  ["rosybrown", [188, 143, 143]],
  ["royalblue", [65, 105, 225]],
  ["saddlebrown", [139, 69, 19]],
  ["salmon", [250, 128, 114]],
  ["sandybrown", [244, 164, 96]],
  ["seagreen", [46, 139, 87]],
  ["seashell", [255, 245, 238]],
  ["sienna", [160, 82, 45]],
  ["silver", [192, 192, 192]],
  ["skyblue", [135, 206, 235]],
  ["slateblue", [106, 90, 205]],
  ["slategray", [112, 128, 144]],
  ["slategrey", [112, 128, 144]],
  ["snow", [255, 250, 250]],
  ["springgreen", [0, 255, 127]],
  ["steelblue", [70, 130, 180]],
  ["tan", [210, 180, 140]],
  ["teal", [0, 128, 128]],
  ["thistle", [216, 191, 216]],
  ["tomato", [255, 99, 71]],
  ["turquoise", [64, 224, 208]],
  ["violet", [238, 130, 238]],
  ["wheat", [245, 222, 179]],
  ["white", [255, 255, 255]],
  ["whitesmoke", [245, 245, 245]],
  ["yellow", [255, 255, 0]],
  ["yellowgreen", [154, 205, 50]],
]);

export const _RGB_RE = pyRe(String.raw`rgba?\(([^)]*)\)`, reFlags.IGNORECASE);
export const _HSL_RE = pyRe(String.raw`hsla?\(([^)]*)\)`, reFlags.IGNORECASE);

export function _component(token: string, scale: number = 255.0): number {
  token = token.trim();
  if (token.endsWith("%")) return float(token.slice(0, -1)) / 100.0;
  return float(token) / scale;
}

/**
 * Parse a CSS color string to RGBA in 0.0-1.0.
 *
 * @param value - The color token (e.g. `#ffa619`, `red`, `rgb(255,0,0)`).
 * @param current - Value substituted for `currentColor`.
 * @returns RGBA tuple, or `null` for `none`/`transparent`/unparseable/empty.
 */
export function parseColor(value: string | null, current: Rgba = [0.0, 0.0, 0.0, 1.0]): Rgba | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === "none" || v === "transparent") return null;
  if (v === "currentcolor") return current;
  if (v.startsWith("#")) return _parseHex(v.slice(1));
  if (v.startsWith("rgb")) {
    const m = patternMatch(_RGB_RE, v);
    if (m) {
      const parts = Array.from(m[1].matchAll(NUMBER_PCT_RE), (n) => n[0]);
      if (parts.length >= 3) {
        const r = _component(parts[0]);
        const g = _component(parts[1]);
        const b = _component(parts[2]);
        const a = parts.length > 3 ? float(parts[3].replace(/%+$/, "")) / (parts[3].includes("%") ? 100.0 : 1.0) : 1.0;
        return [clamp01(r), clamp01(g), clamp01(b), clamp01(a)];
      }
    }
    return null;
  }
  if (v.startsWith("hsl")) return _parseHsl(v);
  const rgb = _NAMED.get(v);
  if (rgb != null) return [rgb[0] / 255.0, rgb[1] / 255.0, rgb[2] / 255.0, 1.0];
  return null;
}

export function _parseHex(h: string): Rgba | null {
  // Python `len` and `h[i:j]` count code points, so work on code points here.
  let cps = Array.from(h);
  if (cps.length === 3 || cps.length === 4) cps = cps.flatMap((c) => [c, c]);
  if (cps.length === 6) cps = [...cps, "f", "f"];
  if (cps.length !== 8) return null;
  let r: number;
  let g: number;
  let b: number;
  let a: number;
  try {
    r = Number.parseInt(cps.slice(0, 2).join(""), 16) / 255.0;
    g = Number.parseInt(cps.slice(2, 4).join(""), 16) / 255.0;
    b = Number.parseInt(cps.slice(4, 6).join(""), 16) / 255.0;
    a = Number.parseInt(cps.slice(6, 8).join(""), 16) / 255.0;
  } catch (e) {
    if (!(e instanceof ValueError)) throw e;
    return null;
  }
  return [r, g, b, a];
}

export function _parseHsl(v: string): Rgba | null {
  const m = patternMatch(_HSL_RE, v);
  if (!m) return null;
  const parts = Array.from(m[1].matchAll(NUMBER_PCT_RE), (n) => n[0]);
  if (parts.length < 3) return null;
  const h = (((float(parts[0].replace(/%+$/, "")) % 360.0) + 360.0) % 360.0) / 360.0;
  // CSS clamps saturation and lightness to [0, 100 %] before converting
  // (hsl(400, 150%, -5%) is black), not the converted channels.
  const s = clamp01(float(parts[1].replace(/%+$/, "")) / 100.0);
  const light = clamp01(float(parts[2].replace(/%+$/, "")) / 100.0);
  const a = parts.length > 3 ? float(parts[3].replace(/%+$/, "")) / (parts[3].includes("%") ? 100.0 : 1.0) : 1.0;

  function hue(p: number, q: number, t: number): number {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }

  let r: number;
  let g: number;
  let b: number;
  if (s === 0) {
    r = light;
    g = light;
    b = light;
  } else {
    const q = light < 0.5 ? light * (1 + s) : light + s - light * s;
    const p = 2 * light - q;
    r = hue(p, q, h + 1 / 3);
    g = hue(p, q, h);
    b = hue(p, q, h - 1 / 3);
  }
  return [clamp01(r), clamp01(g), clamp01(b), clamp01(a)];
}
