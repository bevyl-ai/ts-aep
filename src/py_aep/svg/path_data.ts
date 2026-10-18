/**
 * SVG path `d` attribute parser.
 *
 * Parses a path data string into subpaths of cubic bezier segments. Every
 * segment is represented as `(x0, y0, x1, y1, x2, y2, x3, y3)` so straight
 * lines, quadratics, and arcs all reduce to a single uniform form that the
 * shape converter turns into After Effects vertices + tangents.
 */

import { NUMBER_RE } from "./_util.ts";
import { UnsupportedSVGError } from "./errors.ts";
import {
  float,
  islower,
  isspace,
  max,
  min,
  mod,
  valueEquals,
  radians,
  literal,
  hypot,
  patternMatch,
} from "../../pyrt/index.ts";

/** A cubic segment: start, control 1, control 2, end. */
export type CubicSeg = [number, number, number, number, number, number, number, number];

/** A run of cubic segments from one `M ... [Z]` group. */
export class RawSubpath {
  readonly segments: CubicSeg[];
  readonly closed: boolean;

  constructor(segments: CubicSeg[], closed: boolean) {
    this.segments = segments;
    this.closed = closed;
  }

  *[Symbol.iterator]() {
    yield this.segments;
    yield this.closed;
  }
}

export const _COMMANDS = new Set("MmLlHhVvCcSsQqTtAaZz");
export const _CMD_RE = /^[MmLlHhVvCcSsQqTtAaZz]/;
// Argument count per command (per coordinate-set repetition).
export const _ARGC: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 };

/**
 * Split a path `d` string into command and argument tokens.
 *
 * The elliptical-arc large-arc-flag and sweep-flag are single-character
 * flags (`0`/`1`) in the W3C path grammar, so they may be written with no
 * separator from each other or the following coordinate (e.g.
 * `A5 5 0 11 0,10`). A context-free scan would misread `11` as the single
 * number 11; this scanner tracks the active command and per-repetition
 * argument index and peels off exactly one flag character at the two flag
 * positions of an `A`/`a` command. Every other token matches the same
 * number grammar as before, so non-arc paths tokenize identically.
 */
export function _tokenize(d: string): string[] {
  const tokens: string[] = [];
  // Python indexes code points; `i` is the UTF-16 offset of the current code
  // point and advances by its width, so the scan visits the same characters.
  let i = 0;
  let cmd = "";
  let arg = 0;
  while (i < d.length) {
    const c = String.fromCodePoint(d.codePointAt(i) ?? 0);
    if (c === "," || isspace(c)) {
      i += c.length;
      continue;
    }
    if (_CMD_RE.test(c)) {
      tokens.push(c);
      cmd = c === "Z" || c === "z" ? "" : c;
      arg = 0;
      i += c.length;
      continue;
    }
    const argc = _ARGC[cmd.toUpperCase()] ?? 0;
    // large-arc-flag (index 3) and sweep-flag (index 4) of each arc
    // repetition are single chars; peel one off so `11`/`110` split.
    if (cmd.toUpperCase() === "A" && argc !== 0 && [3, 4].includes(arg % argc) && (c === "0" || c === "1")) {
      tokens.push(c);
      arg += 1;
      i += c.length;
      continue;
    }
    const m = patternMatch(NUMBER_RE, d, i);
    if (m && m[0]) {
      tokens.push(m[0]);
      if (argc !== 0) arg += 1;
      i = m.index + m[0].length;
      continue;
    }
    // Unrecognized character: skip it, matching the prior findall scan
    // which silently ignored anything outside the command/number grammar.
    i += c.length;
  }
  return tokens;
}

/**
 * Parse an SVG path `d` string into cubic-bezier subpaths.
 *
 * @param d - The path data string.
 * @returns Subpaths in document order; each holds cubic segments and a
 *   closed flag.
 * @throws UnsupportedSVGError For malformed data or unknown commands.
 */
export function parsePath(d: string): RawSubpath[] {
  const tokens = _tokenize(d);
  const parser = new _PathParser(tokens);
  return parser.run();
}

export class _PathParser {
  _tokens: string[];
  _i: number;
  cx: number;
  cy: number;
  sx: number;
  sy: number;
  _prevCmd: string;
  // Last cubic control point (for S) and quadratic control (for T).
  _prevCubicCtrl: [number, number] | null;
  _prevQuadCtrl: [number, number] | null;
  _segs: CubicSeg[];
  _subpaths: RawSubpath[];

  constructor(tokens: string[]) {
    this._tokens = tokens;
    this._i = 0;
    this.cx = 0.0;
    this.cy = 0.0;
    this.sx = 0.0;
    this.sy = 0.0;
    this._prevCmd = "";
    this._prevCubicCtrl = null;
    this._prevQuadCtrl = null;
    this._segs = [];
    this._subpaths = [];
  }

  run(): RawSubpath[] {
    let cmd = "";
    while (this._i < this._tokens.length) {
      const tok = this._tokens[this._i];
      if (_COMMANDS.has(tok)) {
        cmd = tok;
        this._i += 1;
        if (cmd === "Z" || cmd === "z") {
          this._close();
          cmd = "";
          continue;
        }
      } else if (cmd === "") {
        throw new UnsupportedSVGError(`Path data starts with a number: ${literal(tok)}`);
      } else {
        // Implicit repeat: a subsequent M/m becomes L/l.
        if (cmd === "M") {
          cmd = "L";
        } else if (cmd === "m") {
          cmd = "l";
        }
      }
      this._exec(cmd);
    }
    this._flush(false);
    return this._subpaths;
  }

  _readArgs(n: number): number[] {
    const args: number[] = [];
    for (let i = 0; i < n; i++) {
      if (this._i >= this._tokens.length || _COMMANDS.has(this._tokens[this._i])) {
        throw new UnsupportedSVGError("Path data ended mid-command");
      }
      args.push(float(this._tokens[this._i]));
      this._i += 1;
    }
    return args;
  }

  _flush(closed: boolean): void {
    if (this._segs?.length > 0) {
      this._subpaths.push(new RawSubpath(this._segs, closed));
      this._segs = [];
    }
  }

  _close(): void {
    if (this._segs?.length > 0) {
      // Add the closing straight segment back to the subpath start.
      if (!valueEquals([this.cx, this.cy], [this.sx, this.sy])) {
        this._segs.push([this.cx, this.cy, this.cx, this.cy, this.sx, this.sy, this.sx, this.sy]);
      }
      this._subpaths.push(new RawSubpath(this._segs, true));
      this._segs = [];
    }
    this.cx = this.sx;
    this.cy = this.sy;
    this._prevCubicCtrl = null;
    this._prevQuadCtrl = null;
    this._prevCmd = "Z";
  }

  _lineTo(x: number, y: number): void {
    this._segs.push([this.cx, this.cy, this.cx, this.cy, x, y, x, y]);
    this.cx = x;
    this.cy = y;
  }

  _cubicTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
    this._segs.push([this.cx, this.cy, x1, y1, x2, y2, x, y]);
    this._prevCubicCtrl = [x2, y2];
    this.cx = x;
    this.cy = y;
  }

  _quadTo(qx: number, qy: number, x: number, y: number): void {
    // Elevate quadratic to cubic.
    const c1x = this.cx + (2.0 / 3.0) * (qx - this.cx);
    const c1y = this.cy + (2.0 / 3.0) * (qy - this.cy);
    const c2x = x + (2.0 / 3.0) * (qx - x);
    const c2y = y + (2.0 / 3.0) * (qy - y);
    this._segs.push([this.cx, this.cy, c1x, c1y, c2x, c2y, x, y]);
    this._prevQuadCtrl = [qx, qy];
    this.cx = x;
    this.cy = y;
  }

  _exec(cmd: string): void {
    // flat command dispatch
    const rel = islower(cmd);
    const up = cmd.toUpperCase();
    const a = this._readArgs(_ARGC[up]);
    const [ox, oy] = rel ? [this.cx, this.cy] : [0.0, 0.0];

    if (up === "M") {
      this._flush(false);
      this.cx = a[0] + ox;
      this.cy = a[1] + oy;
      this.sx = this.cx;
      this.sy = this.cy;
    } else if (up === "L") {
      this._lineTo(a[0] + ox, a[1] + oy);
    } else if (up === "H") {
      this._lineTo(a[0] + (rel ? this.cx : 0.0), this.cy);
    } else if (up === "V") {
      this._lineTo(this.cx, a[0] + (rel ? this.cy : 0.0));
    } else if (up === "C") {
      this._cubicTo(a[0] + ox, a[1] + oy, a[2] + ox, a[3] + oy, a[4] + ox, a[5] + oy);
    } else if (up === "S") {
      let rx: number, ry: number;
      if (["C", "S"].includes(this._prevCmd) && this._prevCubicCtrl != null) {
        rx = 2 * this.cx - this._prevCubicCtrl[0];
        ry = 2 * this.cy - this._prevCubicCtrl[1];
      } else {
        rx = this.cx;
        ry = this.cy;
      }
      this._cubicTo(rx, ry, a[0] + ox, a[1] + oy, a[2] + ox, a[3] + oy);
    } else if (up === "Q") {
      this._quadTo(a[0] + ox, a[1] + oy, a[2] + ox, a[3] + oy);
    } else if (up === "T") {
      let qx: number, qy: number;
      if (["Q", "T"].includes(this._prevCmd) && this._prevQuadCtrl != null) {
        qx = 2 * this.cx - this._prevQuadCtrl[0];
        qy = 2 * this.cy - this._prevQuadCtrl[1];
      } else {
        qx = this.cx;
        qy = this.cy;
      }
      this._quadTo(qx, qy, a[0] + ox, a[1] + oy);
    } else if (up === "A") {
      this._arcTo(a[0], a[1], a[2], a[3] !== 0, a[4] !== 0, a[5] + ox, a[6] + oy);
    }

    if (up !== "C" && up !== "S") {
      this._prevCubicCtrl = null;
    }
    if (up !== "Q" && up !== "T") {
      this._prevQuadCtrl = null;
    }
    this._prevCmd = up;
  }

  /** Convert an SVG elliptical arc to cubic segments (W3C algorithm). */
  _arcTo(
    rx: number,
    ry: number,
    phiDeg: number,
    large: boolean,
    sweep: boolean,
    x: number,
    y: number,
  ): void {
    const x1 = this.cx;
    const y1 = this.cy;
    if (rx === 0 || ry === 0) {
      this._lineTo(x, y);
      return;
    }
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    const phi = radians(mod(phiDeg, 360.0));
    const cosP = Math.cos(phi);
    const sinP = Math.sin(phi);
    const dx = (x1 - x) / 2.0;
    const dy = (y1 - y) / 2.0;
    const x1p = cosP * dx + sinP * dy;
    const y1p = -sinP * dx + cosP * dy;
    // Correct out-of-range radii. hypot of the ratios, not a sum of
    // squares over rx * rx: a tiny radius (1e-200) would underflow the
    // square to 0.
    const s = hypot(x1p / rx, y1p / ry);
    let co: number;
    if (s > 1) {
      // The scaled ellipse just reaches the end point, so its centre is
      // the chord midpoint. The square root below would instead read a
      // rounding remainder (1e-16) as an offset and shift the centre.
      rx = rx * s;
      ry = ry * s;
      co = 0.0;
    } else {
      const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
      const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
      co = den !== 0 ? Math.sqrt(max([0.0, num / den])) : 0.0;
    }
    if (large === sweep) {
      co = -co;
    }
    const cxp = (co * rx * y1p) / ry;
    const cyp = (-co * ry * x1p) / rx;
    const cx_ = cosP * cxp - sinP * cyp + (x1 + x) / 2.0;
    const cy_ = sinP * cxp + cosP * cyp + (y1 + y) / 2.0;

    const angle = (ux: number, uy: number, vx: number, vy: number): number => {
      const dot = ux * vx + uy * vy;
      const ln = hypot(ux, uy) * hypot(vx, vy);
      const ang = ln !== 0 ? Math.acos(max([-1.0, min([1.0, dot / ln])])) : 0.0;
      return (ux * vy - uy * vx) < 0 ? -ang : ang;
    };

    const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dtheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!sweep && dtheta > 0) {
      dtheta -= 2 * Math.PI;
    } else if (sweep && dtheta < 0) {
      dtheta += 2 * Math.PI;
    }

    const nSegs = max([1, Math.trunc(Math.ceil(Math.abs(dtheta) / (Math.PI / 2.0)))]);
    const delta = dtheta / nSegs;
    const t = (4.0 / 3.0) * Math.tan(delta / 4.0);
    let theta = theta1;
    for (let i = 0; i < nSegs; i++) {
      const cos1 = Math.cos(theta);
      const sin1 = Math.sin(theta);
      const cos2 = Math.cos(theta + delta);
      const sin2 = Math.sin(theta + delta);
      let epX: number, epY: number;
      if (i === nSegs - 1) {
        // The arc ends on the given end point, not on its evaluation.
        epX = x;
        epY = y;
      } else {
        epX = cosP * rx * cos2 - sinP * ry * sin2 + cx_;
        epY = sinP * rx * cos2 + cosP * ry * sin2 + cy_;
      }
      const d1x = -rx * sin1;
      const d1y = ry * cos1;
      const d2x = -rx * sin2;
      const d2y = ry * cos2;
      const c1x = this.cx + t * (cosP * d1x - sinP * d1y);
      const c1y = this.cy + t * (sinP * d1x + cosP * d1y);
      const c2x = epX - t * (cosP * d2x - sinP * d2y);
      const c2y = epY - t * (sinP * d2x + cosP * d2y);
      this._segs.push([this.cx, this.cy, c1x, c1y, c2x, c2y, epX, epY]);
      this.cx = epX;
      this.cy = epY;
      theta += delta;
    }
  }
}
