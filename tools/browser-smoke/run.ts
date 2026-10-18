// Runs the browser bundle with no host: `globalThis.process` is hidden while
// the bundle loads, so pyrt/host picks the in-memory fs, POSIX paths and the
// "browser" platform, as in a page or a Worker without nodejs_compat.
//
// usage: bun build src/py_aep/browser.ts --target=browser --outdir=dist/browser
//        bun tools/browser-smoke/run.ts [N]   # N evenly spaced samples (default 40, 0 = all)

import * as fs from "node:fs";
import * as path from "node:path";
import { smoke } from "./smoke.js";

const root = path.resolve(import.meta.dir, "../..");
const all = fs.globSync("samples/**/*.aep", { cwd: root }).sort();
const n = Number(process.argv[2] ?? 40);
const samples =
  n > 0 && n < all.length ? Array.from({ length: n }, (_, i) => all[Math.floor((i * all.length) / n)]) : all;

const saved = globalThis.process;
(globalThis as any).process = undefined;
let pyAep: any;
try {
  pyAep = await import(path.join(root, "dist/browser/browser.js"));
} finally {
  (globalThis as any).process = saved;
}
if (pyAep.fsBackend() !== "memory") throw new Error("bundle did not pick the memory fs");

const read = async (name: string) => new Uint8Array(fs.readFileSync(path.join(root, name)));
const result = await smoke(pyAep, read, samples, () => {});
console.log(JSON.stringify({ ...result, problems: result.problems.length }));
for (const p of result.problems) console.log(p);
process.exit(result.identical === result.total ? 0 : 1);
