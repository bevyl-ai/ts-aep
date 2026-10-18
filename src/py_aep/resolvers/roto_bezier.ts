/**
 * The tangents After Effects draws a RotoBezier mask path with.
 *
 * A RotoBezier mask ignores its stored direction handles: After Effects
 * derives every vertex's tangents from the vertices and a per-vertex tension
 * (the shape value's `omtn` chunk), and reports those through
 * `Shape.inTangents` / `outTangents`. Rules measured on After Effects 2026
 * by reading back masks with patched tensions and aspects (3-6 vertices, open
 * and closed paths, collinear and repeated vertices, keyed paths):
 *
 * - Tangents are computed in normalized mask space with x scaled by the Mask
 *   Path's stored aspect (`Tdb4Chunk.pixelAspect`: the layer's width /
 *   height, so pixel space, in current files).
 * - With `k = (1 - tension) / 2`, an interior vertex (every vertex of a closed
 *   path) points along `next - prev`: its in tangent is `k` times the distance
 *   to the previous vertex, its out tangent `k` times the distance to the
 *   next one. A zero `next - prev` chord gives zero tangents.
 * - An open path's last vertex aims its in tangent at the previous vertex's
 *   out handle, then its first vertex aims its out tangent at the second
 *   vertex's in handle, each scaled by the end's own `k`; the outer tangents
 *   stay zero.
 * - A shape value without tensions uses 1/3 for every vertex.
 * - Between keyframes, the tensions blend linearly with the path's progress. A
 *   keyframe without tensions contributes 1 at a vertex whose stored handles
 *   are both zero, 1/3 at any other.
 */

import { zip, hypot } from "../../pyrt/index.ts";

export const DEFAULT_TENSION = 1.0 / 3.0;

/**
 * `(in_tangents, out_tangents)` of a RotoBezier path.
 *
 * @param vertices - The path's vertices, in layer pixels.
 * @param closed - Whether the path is closed.
 * @param tensions - One tension per vertex.
 * @param scaleX - Multiplier from layer pixels to the measuring space along x (the stored aspect
 *   over the layer width).
 * @param scaleY - The same along y (one over the layer height).
 */
export function rotoBezierTangents(
  vertices: number[][],
  closed: boolean,
  tensions: number[],
  scaleX: number,
  scaleY: number,
): [number[][], number[][]] {
  const points: [number, number][] = vertices.map(
    ([x, y]): [number, number] => [x * scaleX, y * scaleY],
  );
  const count = points.length;
  const ks = tensions.map((t) => (1.0 - t) * 0.5);
  const ins: number[][] = Array.from({ length: count }, () => [0.0, 0.0]);
  const outs: number[][] = Array.from({ length: count }, () => [0.0, 0.0]);
  const loopStart = closed ? 0 : 1;
  const loopStop = closed ? count : count - 1;
  for (let i = loopStart; i < loopStop; i++) {
    const [vx, vy] = points[i];
    const [px, py] = points[(i + count - 1) % count];
    const [nx, ny] = points[(i + 1) % count];
    const chord = hypot(nx - px, ny - py);
    if (chord < 1e-12) {
      continue;
    }
    const ux = (nx - px) / chord;
    const uy = (ny - py) / chord;
    const before = hypot(vx - px, vy - py) * ks[i];
    const after = hypot(nx - vx, ny - vy) * ks[i];
    ins[i] = [-ux * before, -uy * before];
    outs[i] = [ux * after, uy * after];
  }
  if (!closed && count >= 2) {
    const [lx, ly] = points[count - 1];
    const [bx, by] = points[count - 2];
    ins[count - 1] = [
      (bx + outs[count - 2][0] - lx) * ks[ks.length - 1],
      (by + outs[count - 2][1] - ly) * ks[ks.length - 1],
    ];
    const [fx, fy] = points[0];
    const [sx, sy] = points[1];
    outs[0] = [
      (sx + ins[1][0] - fx) * ks[0],
      (sy + ins[1][1] - fy) * ks[0],
    ];
  }
  return [
    ins.map(([x, y]) => [x / scaleX, y / scaleY]),
    outs.map(([x, y]) => [x / scaleX, y / scaleY]),
  ];
}

/**
 * The tensions a keyframe's path contributes to an in-between value:
 * its own, or, when it has none, 1 at a vertex whose stored handles are
 * both zero and 1/3 at any other.
 */
export function keyframeTensions(
  tensions: number[],
  inTangents: number[][],
  outTangents: number[][],
): number[] {
  if (tensions.length === inTangents.length) {
    return [...tensions];
  }
  return zip(inTangents, outTangents).map(([a, b]) =>
    // Python any() over floats: truthy when any element is nonzero.
    !a.some((v) => v !== 0) && !b.some((v) => v !== 0) ? 1.0 : DEFAULT_TENSION,
  );
}
