/**
 * Color-to-name resolver for solid footage sources.
 *
 * After Effects auto-generates solid layer names from the solid's color
 * (e.g. "Red Solid 1", "Dark Blue Solid 2"). This module replicates that
 * naming logic using calibrated HSV thresholds.
 */

// -- Hue bands (degrees 0-360) ----------------------------------------

const _HUE_BANDS: [number, string][] = [
  [15, "Red"],
  [45, "Orange"],
  [75, "Yellow"],
  [105, "Lime Green"],
  [135, "Green"],
  [165, "Turquoise"],
  [195, "Cyan"],
  [225, "Royal Blue"],
  [255, "Blue"],
  [285, "Purple"],
  [315, "Magenta"],
  [345, "Magenta-Red"],
  [360, "Red"],
];

/** Map a hue angle (0-360) to a color name. */
function _hueName(hDeg: number): string {
  for (const [upper, name] of _HUE_BANDS) {
    if (hDeg < upper) {
      return name;
    }
  }
  return "Red";
}

// Line-for-line copy of CPython 3.12 colorsys.rgb_to_hsv (same operation order, Python-sign mod), so floats match.
function _rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  const v = maxc;
  if (minc === maxc) {
    return [0.0, 0.0, v];
  }
  const s = (maxc - minc) / maxc;
  const rc = (maxc - r) / (maxc - minc);
  const gc = (maxc - g) / (maxc - minc);
  const bc = (maxc - b) / (maxc - minc);
  let h: number;
  if (r === maxc) {
    h = bc - gc;
  } else if (g === maxc) {
    h = 2.0 + rc - bc;
  } else {
    h = 4.0 + gc - rc;
  }
  h = (((h / 6.0) % 1.0) + 1.0) % 1.0;
  return [h, s, v];
}

/**
 * Derive the base solid name from an RGB color.
 *
 * After Effects names solids by their perceived color category.
 * Returns the base name (e.g. `"Red Solid"`) without a trailing
 * number suffix; the caller is responsible for disambiguation.
 *
 * @param r - Red channel in `[0.0, 1.0]`.
 * @param g - Green channel in `[0.0, 1.0]`.
 * @param b - Blue channel in `[0.0, 1.0]`.
 */
export function solidColorName(r: number, g: number, b: number): string {
  const [hRaw, sRaw, vRaw] = _rgbToHsv(r, g, b);
  const h = hRaw * 360.0;
  const s = sRaw * 100.0;
  const v = vRaw * 100.0;

  let label: string;
  if (s === 0) {
    // Achromatic
    if (v === 0) {
      label = "Black";
    } else if (v < 38) {
      label = "Dark Gray";
    } else if (v < 63) {
      label = "Gray";
    } else if (v < 88) {
      label = "Light Gray";
    } else {
      label = "White";
    }
  } else {
    const hue = _hueName(h);
    if (s < 25) {
      if (v === 0) {
        label = "Black";
      } else if (v < 25) {
        label = `Dark ${hue}`;
      } else if (v < 75) {
        label = `Pale Gray-${hue}`;
      } else {
        label = `Pale ${hue}`;
      }
    } else if (s < 75) {
      if (v === 0) {
        label = "Black";
      } else if (v < 25) {
        label = `Dark ${hue}`;
      } else if (v < 75) {
        label = `Medium Gray-${hue}`;
      } else {
        label = `Medium ${hue}`;
      }
    } else {
      if (v === 0) {
        label = "Black";
      } else if (v < 25) {
        label = `Dark ${hue}`;
      } else if (v < 75) {
        label = `Deep ${hue}`;
      } else {
        label = hue;
      }
    }
  }

  return `${label} Solid`;
}
