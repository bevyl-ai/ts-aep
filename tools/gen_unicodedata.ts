// Generates src/pyrt/unicodedata_tables.ts from CPython 3.12's unicodedata
// (.upstream's uv env), so `bidirectional` / `combining` follow Python's
// Unicode version rather than the JS engine's.
//
// Each property is stored as runs over U+0000..U+10FFFF: the run lengths and
// the run values, both as comma-separated base-36 numbers.
//
// usage: bun tools/gen_unicodedata.ts          rewrite unicodedata_tables.ts
//        bun tools/gen_unicodedata.ts --check  exit 1 if it is stale

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const OUT = path.join(ROOT, "src", "pyrt", "unicodedata_tables.ts");

const PY = String.raw`
import json, unicodedata as u
def runs(f):
    lengths, values = [], []
    for cp in range(0x110000):
        v = f(chr(cp))
        if values and values[-1] == v:
            lengths[-1] += 1
        else:
            lengths.append(1)
            values.append(v)
    return lengths, values
print(json.dumps({"version": u.unidata_version, "bidirectional": runs(u.bidirectional), "combining": runs(u.combining)}))
`;

const proc = Bun.spawnSync(["uv", "run", "-q", "--project", ".", "python", "-c", PY], {
  cwd: path.join(ROOT, ".upstream"),
  stderr: "inherit",
});
if (proc.exitCode !== 0) throw new Error("CPython dump failed");
const py: { version: string; bidirectional: [number[], string[]]; combining: [number[], number[]] } = JSON.parse(proc.stdout.toString());

const b36 = (xs: number[]): string => xs.map((x) => x.toString(36)).join(",");
const [bidi_lengths, bidi_values] = py.bidirectional;
const classes = [...new Set(bidi_values)];
const [ccc_lengths, ccc_values] = py.combining;

const text = [
  `// Generated from CPython 3.12's unicodedata (Unicode ${py.version}) by tools/gen_unicodedata.ts; do not edit by hand.`,
  "// Runs over U+0000..U+10FFFF: run lengths and run values, comma-separated base 36.",
  `export const UNIDATA_VERSION = ${JSON.stringify(py.version)};`,
  `export const BIDI_CLASSES: readonly string[] = ${JSON.stringify(classes)};`,
  `export const BIDI_LENGTHS = ${JSON.stringify(b36(bidi_lengths))};`,
  `export const BIDI_VALUES = ${JSON.stringify(b36(bidi_values.map((v) => classes.indexOf(v))))};`,
  `export const COMBINING_LENGTHS = ${JSON.stringify(b36(ccc_lengths))};`,
  `export const COMBINING_VALUES = ${JSON.stringify(b36(ccc_values))};`,
  "",
].join("\n");

if (process.argv.includes("--check")) {
  if (fs.readFileSync(OUT, "utf8") !== text) {
    console.error("src/pyrt/unicodedata_tables.ts is stale: run bun tools/gen_unicodedata.ts");
    process.exit(1);
  }
} else {
  fs.writeFileSync(OUT, text);
}
