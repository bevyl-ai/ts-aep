// Generates src/pyrt/codepages.ts from CPython 3.12's codecs (.upstream's uv env).
//
// Single-byte code pages are full tables. A multibyte code page is CPython's
// validity map (one-byte characters, lead bytes, valid trail ranges per lead)
// plus the code points where the WHATWG TextDecoder for `label` disagrees with
// CPython on a sequence CPython accepts. The script checks every one- and
// two-byte sequence, so decoding through the map and the decoder is CPython's
// decode for any input (these codecs are stateless and at most two bytes wide).
//
// usage: bun tools/gen_codepages.ts          rewrite codepages.ts
//        bun tools/gen_codepages.ts --check  exit 1 if it is stale

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const OUT = path.join(ROOT, "src", "pyrt", "codepages.ts");

const SINGLE: [string, string][] = [
  ["CP1252", "cp1252"],
  ["MAC_ROMAN", "mac_roman"],
  ["CP874", "cp874"],
  ["CP1250", "cp1250"],
  ["CP1251", "cp1251"],
  ["CP1253", "cp1253"],
  ["CP1254", "cp1254"],
  ["CP1255", "cp1255"],
  ["CP1256", "cp1256"],
  ["CP1257", "cp1257"],
  ["CP1258", "cp1258"],
];
const CJK: [string, string, string][] = [
  ["CP932", "cp932", "shift_jis"],
  ["CP936", "cp936", "gbk"],
  ["CP949", "cp949", "euc-kr"],
  ["CP950", "cp950", "big5"],
];

// For each codec: name, single[b] = code point | null (undefined / lead), lead[b] = reason,
// pair["b,t"] = code point | null.
const PY = String.raw`
import codecs, json, sys
out = {}
for codec in sys.argv[1:]:
    single, pairs, leads = [], {}, []
    for b in range(256):
        try:
            s = bytes([b]).decode(codec)
            assert len(s) == 1
            single.append(ord(s))
        except UnicodeDecodeError as e:
            single.append(None)
            if e.reason == "incomplete multibyte sequence":
                leads.append(b)
    for b in leads:
        for t in range(256):
            try:
                s = bytes([b, t]).decode(codec)
                assert len(s) == 1
                pairs[f"{b},{t}"] = ord(s)
            except UnicodeDecodeError as e:
                assert (e.start, e.end, e.reason) in ((0, 1, "illegal multibyte sequence"), (1, 2, "incomplete multibyte sequence")), (codec, b, t, e)
    out[codec] = {"name": codecs.lookup(codec).name, "single": single, "leads": leads, "pairs": pairs}
print(json.dumps(out))
`;

const proc = Bun.spawnSync(
  ["uv", "run", "-q", "--project", ".", "python", "-c", PY, ...SINGLE.map((s) => s[1]), ...CJK.map((c) => c[1])],
  { cwd: path.join(ROOT, ".upstream"), stderr: "inherit" },
);
if (proc.exitCode !== 0) throw new Error("CPython dump failed");
const py: Record<string, { name: string; single: (number | null)[]; leads: number[]; pairs: Record<string, number> }> = JSON.parse(
  proc.stdout.toString(),
);

function decodeJs(label: string, bytes: number[]): number[] | null {
  try {
    const decoder: TextDecoder = Reflect.construct(TextDecoder, [label, { fatal: true }]);
    return Array.from(decoder.decode(new Uint8Array(bytes)), (c) => c.codePointAt(0) ?? -1);
  } catch {
    return null;
  }
}

const lines = [
  "// Generated from CPython 3.12 codec tables by tools/gen_codepages.ts; do not edit by hand.",
  "// Single-byte tables: the high half 0x80-0xFF; -1 = undefined.",
];
for (const [name, codec] of SINGLE) {
  const { single, leads } = py[codec];
  if (leads.length) throw new Error(`${codec} is not single-byte`);
  lines.push(`export const ${name}: readonly number[] = [${single.slice(0x80).map((c) => c ?? -1).join(", ")}];`);
}
lines.push(
  "",
  "/**",
  " * A CPython multibyte code page decoded through the WHATWG `TextDecoder` for `label`.",
  " *",
  " * `leads[b - 0x80]` is -1 when byte `b` is a character on its own, else the index in",
  " * `trails` of the trail-byte ranges (`[lo, hi, lo, hi, ...]`) that complete lead `b`.",
  " * The decoder decodes every sequence these accept as CPython does, except the code",
  " * points in `singles` (by byte) and `pairs` (by `lead << 8 | trail`).",
  " */",
  "export interface CjkCodepage {",
  "  readonly name: string;",
  "  readonly label: string;",
  "  readonly leads: readonly number[];",
  "  readonly trails: readonly (readonly number[])[];",
  "  readonly singles: ReadonlyMap<number, number>;",
  "  readonly pairs: ReadonlyMap<number, number>;",
  "}",
);
for (const [name, codec, label] of CJK) {
  const { name: pyName, single, leads, pairs } = py[codec];
  const leadSet = new Set(leads);
  const leadIndex: number[] = [];
  const trails: number[][] = [];
  const singles: [number, number][] = [];
  const overrides: [number, number][] = [];
  for (let b = 0; b < 0x100; b++) {
    const cp = single[b];
    if (cp != null) {
      const js = decodeJs(label, [b]);
      if (js?.length !== 1 || js[0] !== cp) {
        if (b < 0x80) throw new Error(`${codec}: ASCII byte ${b} differs`);
        singles.push([b, cp]);
      }
      if (b >= 0x80) leadIndex.push(-1);
      continue;
    }
    if (!leadSet.has(b)) throw new Error(`${codec}: byte ${b} is neither a character nor a lead`);
    const ranges: number[] = [];
    for (let t = 0; t <= 0x100; t++) {
      const valid = t < 0x100 && pairs[`${b},${t}`] !== undefined;
      const open = ranges.length % 2 === 1;
      if (valid && !open) ranges.push(t);
      else if (!valid && open) ranges.push(t - 1);
      if (valid) {
        const js = decodeJs(label, [b, t]);
        if (js?.length !== 1 || js[0] !== pairs[`${b},${t}`]) overrides.push([(b << 8) | t, pairs[`${b},${t}`]]);
      }
    }
    let k = trails.findIndex((r) => r.length === ranges.length && r.every((x, i) => x === ranges[i]));
    if (k < 0) k = trails.push(ranges) - 1;
    leadIndex.push(k);
  }
  lines.push(
    `export const ${name}: CjkCodepage = {`,
    `  name: ${JSON.stringify(pyName)},`,
    `  label: ${JSON.stringify(label)},`,
    `  leads: ${JSON.stringify(leadIndex)},`,
    `  trails: ${JSON.stringify(trails)},`,
    `  singles: new Map(${JSON.stringify(singles)}),`,
    `  pairs: new Map(${JSON.stringify(overrides)}),`,
    "};",
  );
}
const text = lines.join("\n") + "\n";

if (process.argv.includes("--check")) {
  if (fs.readFileSync(OUT, "utf8") !== text) {
    console.error("src/pyrt/codepages.ts is stale: run bun tools/gen_codepages.ts");
    process.exit(1);
  }
} else {
  fs.writeFileSync(OUT, text);
}
