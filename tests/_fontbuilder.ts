/**
 * Minimal TS stand-in for the fontTools `FontBuilder` + `TTGlyphPen` subset used by
 * tests/unit/test_svg_text.py: writes a valid TrueType (glyf) font.
 */

import { writeFileSync } from "node:fs";

export type Pt = [number, number];
export type TTGlyph = Pt[][];

/** Mirrors `TTGlyphPen(None)` for line-only contours. */
export class TTGlyphPen {
  private contours: Pt[][] = [];
  private cur: Pt[] | null = null;
  moveTo(pt: Pt): void {
    this.cur = [pt];
  }
  lineTo(pt: Pt): void {
    if (this.cur == null) throw new Error("lineTo without a current contour");
    this.cur.push(pt);
  }
  closePath(): void {
    if (this.cur == null) throw new Error("closePath without a current contour");
    this.contours.push(this.cur);
    this.cur = null;
  }
  glyph(): TTGlyph {
    return this.contours;
  }
}

function pad4(b: Uint8Array): Uint8Array {
  const n = (b.length + 3) & ~3;
  const o = new Uint8Array(n);
  o.set(b);
  return o;
}

function checksum(b: Uint8Array): number {
  const p = pad4(b);
  const dv = new DataView(p.buffer);
  let s = 0;
  for (let i = 0; i < p.length; i += 4) s = (s + dv.getUint32(i)) >>> 0;
  return s;
}

class W {
  bytes: number[] = [];
  u8(v: number) {
    this.bytes.push(v & 0xff);
    return this;
  }
  u16(v: number) {
    this.u8(v >> 8).u8(v);
    return this;
  }
  i16(v: number) {
    return this.u16(v & 0xffff);
  }
  u32(v: number) {
    this.u16(Math.floor(v / 65536) & 0xffff).u16(v & 0xffff);
    return this;
  }
  i32(v: number) {
    return this.u32(v >>> 0);
  }
  tag(t: string) {
    for (const c of t) this.u8(c.charCodeAt(0));
    return this;
  }
  raw(b: ArrayLike<number>) {
    for (let i = 0; i < b.length; i++) this.u8(b[i]);
    return this;
  }
  done() {
    return Uint8Array.from(this.bytes);
  }
}

export class FontBuilder {
  private glyphOrder: string[] = [];
  private cmap = new Map<number, string>();
  private glyphs: Record<string, TTGlyph> = {};
  private hmtx: Record<string, [number, number]> = {};
  private ascent = 0;
  private descent = 0;
  private names: Record<string, string> = {};

  constructor(
    private readonly unitsPerEm: number,
    _opts: { isTTF?: boolean } = {},
  ) {}

  setupGlyphOrder(order: string[]): void {
    this.glyphOrder = [...order];
  }
  setupCharacterMap(m: Record<number, string>): void {
    for (const [k, v] of Object.entries(m)) this.cmap.set(Number(k), v);
  }
  setupGlyf(g: Record<string, TTGlyph>): void {
    this.glyphs = g;
  }
  setupHorizontalMetrics(m: Record<string, [number, number]>): void {
    this.hmtx = m;
  }
  setupHorizontalHeader(o: { ascent: number; descent: number }): void {
    this.ascent = o.ascent;
    this.descent = o.descent;
  }
  setupNameTable(n: { familyName: string; styleName: string }): void {
    this.names = { ...n };
  }
  setupOS2(): void {}
  setupPost(): void {}

  private bbox(): [number, number, number, number] {
    const pts = this.glyphOrder.flatMap((g) => (this.glyphs[g] ?? []).flat());
    if (!pts.length) return [0, 0, 0, 0];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  build(): Uint8Array {
    const n = this.glyphOrder.length;
    const [xMin, yMin, xMax, yMax] = this.bbox();
    // glyf + loca (long)
    const glyfParts: Uint8Array[] = [];
    const loca: number[] = [0];
    let off = 0;
    let maxPts = 0;
    let maxCont = 0;
    for (const g of this.glyphOrder) {
      const contours = this.glyphs[g] ?? [];
      if (contours.length) {
        const pts = contours.flat();
        maxPts = Math.max(maxPts, pts.length);
        maxCont = Math.max(maxCont, contours.length);
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        const w = new W();
        w.i16(contours.length)
          .i16(Math.min(...xs))
          .i16(Math.min(...ys))
          .i16(Math.max(...xs))
          .i16(Math.max(...ys));
        let end = -1;
        for (const c of contours) {
          end += c.length;
          w.u16(end);
        }
        w.u16(0); // instructionLength
        for (let i = 0; i < pts.length; i++) w.u8(1); // on-curve, 16-bit deltas
        let px = 0;
        for (const p of pts) {
          w.i16(p[0] - px);
          px = p[0];
        }
        let py = 0;
        for (const p of pts) {
          w.i16(p[1] - py);
          py = p[1];
        }
        const b = pad4(w.done());
        glyfParts.push(b);
        off += b.length;
      }
      loca.push(off);
    }
    const glyf = new W();
    for (const p of glyfParts) glyf.raw(p);
    const locaW = new W();
    for (const o of loca) locaW.u32(o);

    const head = new W()
      .u32(0x00010000)
      .u32(0x00010000)
      .u32(0)
      .u32(0x5f0f3cf5)
      .u16(0x000b)
      .u16(this.unitsPerEm)
      .u32(0)
      .u32(0)
      .u32(0)
      .u32(0) // created/modified (longdatetime x2)
      .i16(xMin)
      .i16(yMin)
      .i16(xMax)
      .i16(yMax)
      .u16(0)
      .u16(8)
      .i16(2)
      .i16(1)
      .i16(0);

    const hhea = new W()
      .u32(0x00010000)
      .i16(this.ascent)
      .i16(this.descent)
      .i16(0)
      .u16(Math.max(...this.glyphOrder.map((g) => this.hmtx[g][0])))
      .i16(0)
      .i16(0)
      .i16(xMax)
      .i16(1)
      .i16(0)
      .i16(0)
      .i16(0)
      .i16(0)
      .i16(0)
      .i16(0)
      .i16(0)
      .u16(n);

    const hmtx = new W();
    for (const g of this.glyphOrder) hmtx.u16(this.hmtx[g][0]).i16(this.hmtx[g][1]);

    const maxp = new W()
      .u32(0x00010000)
      .u16(n)
      .u16(maxPts)
      .u16(maxCont)
      .u16(0)
      .u16(0)
      .u16(2)
      .u16(0)
      .u16(0)
      .u16(0)
      .u16(0)
      .u16(0)
      .u16(0)
      .u16(0);

    const os2 = new W()
      .u16(4)
      .i16(Math.round(this.unitsPerEm / 2))
      .u16(400)
      .u16(5)
      .u16(0)
      .i16(0)
      .i16(0)
      .i16(0)
      .i16(0)
      .i16(0)
      .i16(0)
      .i16(0)
      .i16(0)
      .i16(0)
      .i16(0)
      .i16(0)
      .i16(0)
      .i16(0)
      .i16(0);
    // sFamilyClass(2) + panose(10) + ulUnicodeRange1-4(16) + achVendID(4)
    os2.u16(0);
    for (let i = 0; i < 10; i++) os2.u8(0);
    for (let i = 0; i < 4; i++) os2.u32(0);
    os2
      .tag("NONE")
      .u16(0x40)
      .u16(Math.min(...[...this.cmap.keys()]))
      .u16(Math.max(...[...this.cmap.keys()]))
      .i16(this.ascent)
      .i16(this.descent)
      .i16(0)
      .u16(this.ascent)
      .u16(-this.descent)
      .u32(0)
      .u32(0)
      .i16(0)
      .i16(0)
      .u16(0)
      .u16(0)
      .u16(0);

    // cmap format 4 (BMP) from codepoints
    const cps = [...this.cmap.keys()].sort((a, b) => a - b);
    const segs: [number, number, number][] = [];
    for (const cp of cps) {
      const glyphName = this.cmap.get(cp);
      if (glyphName == null) throw new Error(`no glyph mapped to ${cp}`);
      const gid = this.glyphOrder.indexOf(glyphName);
      const last = segs[segs.length - 1];
      if (last && last[1] + 1 === cp && (gid - cp) % 65536 === last[2]) last[1] = cp;
      else segs.push([cp, cp, (gid - cp) & 0xffff]);
    }
    segs.push([0xffff, 0xffff, 1]);
    const sc = segs.length;
    const pow = 2 ** Math.floor(Math.log2(sc));
    const f4 = new W()
      .u16(4)
      .u16(16 + sc * 8)
      .u16(0)
      .u16(sc * 2)
      .u16(pow * 2)
      .u16(Math.log2(pow))
      .u16(sc * 2 - pow * 2);
    for (const s of segs) f4.u16(s[1]);
    f4.u16(0);
    for (const s of segs) f4.u16(s[0]);
    for (const s of segs) f4.u16(s[2]);
    for (let i = 0; i < sc; i++) f4.u16(0);
    for (let i = 0; i < sc; i++) f4.u16(0);
    const cmap = new W().u16(0).u16(1).u16(3).u16(1).u32(12).raw(f4.done());

    // name: (3,1,0x409) UTF-16BE; ids 1 family, 2 style, 4 full, 6 postscript
    const fam = this.names.familyName ?? "";
    const sty = this.names.styleName ?? "Regular";
    const recs: [number, string][] = [
      [1, fam],
      [2, sty],
      [4, `${fam} ${sty}`],
      [6, `${fam}-${sty}`.replace(/ /g, "")],
    ];
    const strs = recs.map(([, s]) => {
      const b = new W();
      for (const c of s) b.u16(c.charCodeAt(0));
      return b.done();
    });
    const nameW = new W()
      .u16(0)
      .u16(recs.length)
      .u16(6 + recs.length * 12);
    let so = 0;
    recs.forEach(([id], i) => {
      nameW.u16(3).u16(1).u16(0x409).u16(id).u16(strs[i].length).u16(so);
      so += strs[i].length;
    });
    for (const s of strs) nameW.raw(s);

    const post = new W().u32(0x00030000).u32(0).i16(-100).i16(50).u32(0).u32(0).u32(0).u32(0).u32(0);

    const tables: [string, Uint8Array][] = [
      ["OS/2", os2.done()],
      ["cmap", cmap.done()],
      ["glyf", glyf.done()],
      ["head", head.done()],
      ["hhea", hhea.done()],
      ["hmtx", hmtx.done()],
      ["loca", locaW.done()],
      ["maxp", maxp.done()],
      ["name", nameW.done()],
      ["post", post.done()],
    ];
    const nt = tables.length;
    const out = new W().u32(0x00010000).u16(nt);
    const p2 = 2 ** Math.floor(Math.log2(nt));
    out
      .u16(p2 * 16)
      .u16(Math.log2(p2))
      .u16(nt * 16 - p2 * 16);
    let pos = 12 + nt * 16;
    const headIdx = tables.findIndex((t) => t[0] === "head");
    for (const [t, d] of tables) {
      out.tag(t).u32(checksum(d)).u32(pos).u32(d.length);
      pos += pad4(d).length;
    }
    for (const [, d] of tables) out.raw(pad4(d));
    const bytes = out.done();
    // head.checkSumAdjustment
    const headOff = 12 + nt * 16 + tables.slice(0, headIdx).reduce((a, t) => a + pad4(t[1]).length, 0);
    const adj = (0xb1b0afba - checksum(bytes)) >>> 0;
    new DataView(bytes.buffer).setUint32(headOff + 8, adj);
    return bytes;
  }

  save(path: string): void {
    writeFileSync(path, this.build());
  }
}

/** Stand-in for `TTCollection.save`: concatenates sfnt fonts behind a `ttcf` header, rebasing table offsets. */
export function saveTTC(path: string, fonts: Uint8Array[]): void {
  const headerLen = 12 + 4 * fonts.length;
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = headerLen;
  for (const f of fonts) {
    const copy = pad4(f).slice();
    const dv = new DataView(copy.buffer);
    const numTables = dv.getUint16(4);
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16 + 8;
      dv.setUint32(rec, dv.getUint32(rec) + pos);
    }
    offsets.push(pos);
    parts.push(copy);
    pos += copy.length;
  }
  const h = new W().tag("ttcf").u32(0x00010000).u32(fonts.length);
  for (const o of offsets) h.u32(o);
  const out = new Uint8Array(pos);
  out.set(h.done(), 0);
  let at = headerLen;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  writeFileSync(path, out);
}
