/**
 * Value types for the parsed SVG document.
 *
 * All coordinates are absolute, in the SVG viewBox coordinate system, with
 * every ancestor transform already applied. Tangents are stored relative to
 * their vertex (After Effects' {@link Shape | Shape}
 * convention).
 */

/**
 * RGBA in 0.0-1.0 range (annotation-only alias; py37-safe).
 * The Python source defines this under `TYPE_CHECKING`; here it is a plain
 * type alias, which has no runtime effect either way.
 */
export type Rgba = [number, number, number, number];

/**
 * A single bezier outline: one `M ... [Z]` run of a path.
 *
 * `inTangents` / `outTangents` are per-vertex offsets relative to the
 * vertex, matching After Effects' Shape model (straight segments have
 * zero tangents).
 */
export class Subpath {
  /** Anchor points as absolute `[x, y]` pairs. */
  declare vertices: number[][];

  /** Incoming tangent offset per vertex (relative to the vertex). */
  declare inTangents: number[][];

  /** Outgoing tangent offset per vertex (relative to the vertex). */
  declare outTangents: number[][];

  /** Whether the subpath closes back to its first vertex. */
  declare closed: boolean;

  constructor(vertices: number[][], inTangents: number[][], outTangents: number[][], closed: boolean) {
    this.vertices = vertices;
    this.inTangents = inTangents;
    this.outTangents = outTangents;
    this.closed = closed;
  }
}

/** A single gradient color stop. */
export class GradientStop {
  /** Stop position along the gradient, 0.0-1.0. */
  declare offset: number;

  /** Stop color (alpha folds in `stop-opacity`). */
  declare color: Rgba;

  constructor(offset: number, color: Rgba) {
    this.offset = offset;
    this.color = color;
  }
}

/** A flat color fill or stroke paint. */
export class SolidPaint {
  /** Paint color in 0.0-1.0 RGBA. */
  declare color: Rgba;

  constructor(color: Rgba) {
    this.color = color;
  }
}

/** A linear or radial gradient paint (resolved to absolute geometry). */
export class GradientPaint {
  /** `"linear"` or `"radial"`. */
  declare kind: string;

  /** Color stops in offset order. */
  declare stops: GradientStop[];

  /** Linear: gradient start point. Radial: focal/center point. */
  declare start: [number, number];

  /**
   * Linear: gradient end point. Radial: a point on the outer circle
   * (center + radius along x), used to derive the highlight/radius.
   */
  declare end: [number, number];

  /**
   * After Effects Grad Scale percentages `(x, y)`. A radial gradient
   * whose `gradientTransform` stretches it into an ellipse encodes the
   * aspect ratio in `y` (e.g. `(100, 200)` for a 2x-tall ellipse); without
   * it the gradient renders as a circle. Linear gradients keep `(100, 100)`.
   */
  declare scale: [number, number];

  /**
   * After Effects Grad Rotation in degrees. A radial gradient's
   * un-rotated baseline is `360` (AE's convention, visually equal to 0);
   * linear gradients use `0`.
   */
  declare rotation: number;

  constructor(
    kind: string,
    stops: GradientStop[],
    start: [number, number],
    end: [number, number],
    scale: [number, number] = [100.0, 100.0],
    rotation: number = 0.0,
  ) {
    this.kind = kind;
    this.stops = stops;
    this.start = start;
    this.end = end;
    this.scale = scale;
    this.rotation = rotation;
  }
}

/** Stroke appearance for a drawable. */
export class StrokeStyle {
  /** SolidPaint or GradientPaint. */
  declare paint: SolidPaint | GradientPaint;

  /** Stroke width in viewBox units (post-transform scaled). */
  declare width: number;

  /** Line cap: 1 butt, 2 round, 3 projecting (AE enum values). */
  declare cap: number;

  /** Line join: 1 miter, 2 round, 3 bevel (AE enum values). */
  declare join: number;

  /** Miter limit. */
  declare miterLimit: number;

  /** Dash array (empty for a solid stroke). */
  declare dashes: number[];

  constructor(
    paint: SolidPaint | GradientPaint,
    width: number,
    cap: number = 1,
    join: number = 1,
    miterLimit: number = 4.0,
    dashes: number[] = [],
  ) {
    this.paint = paint;
    this.width = width;
    this.cap = cap;
    this.join = join;
    this.miterLimit = miterLimit;
    this.dashes = dashes;
  }
}

/**
 * One leaf drawable: its outline(s) plus fill and stroke.
 *
 * Mirrors the single `ADBE Vector Group` After Effects creates per leaf
 * element. `fill` / `stroke` are `null` when the element has no such
 * paint.
 */
export class SvgDrawable {
  /** Outline(s); compound paths produce multiple subpaths. */
  declare subpaths: Subpath[];

  /** SolidPaint, GradientPaint, or null. */
  declare fill: SolidPaint | GradientPaint | null;

  /** Stroke style, or null when unstroked. */
  declare stroke: StrokeStyle | null;

  /**
   * Source element `id`, if any (AE ignores it for naming; kept for
   * debugging / round-trip inspection).
   */
  declare name: string | null;

  /** Element group opacity, 0.0-1.0. */
  declare opacity: number;

  constructor(
    subpaths: Subpath[],
    fill: SolidPaint | GradientPaint | null = null,
    stroke: StrokeStyle | null = null,
    name: string | null = null,
    opacity: number = 1.0,
  ) {
    this.subpaths = subpaths;
    this.fill = fill;
    this.stroke = stroke;
    this.name = name;
    this.opacity = opacity;
  }
}

/** A flattened SVG: canvas size plus drawables in document order. */
export class SvgDocument {
  /** Comp width in pixels (from viewBox or width attribute). */
  declare width: number;

  /** Comp height in pixels. */
  declare height: number;

  /** Leaf drawables in document (paint) order; first painted first. */
  declare drawables: SvgDrawable[];

  constructor(width: number, height: number, drawables: SvgDrawable[]) {
    this.width = width;
    this.height = height;
    this.drawables = drawables;
  }
}
