// Runs worker.ts in workerd (via miniflare) over N evenly spaced samples and
// checks each save is byte-identical. miniflare is not a dependency:
//
//   bun build src/py_aep/browser.ts --target=browser --outdir=dist/browser
//   bun build tools/browser-smoke/worker.ts --target=browser --outfile=dist/worker.js
//   bun add --no-save miniflare && bun tools/browser-smoke/workers-run.ts [N]

import * as fs from "node:fs";
import * as path from "node:path";

const { Miniflare } = (await import("miniflare" as string)) as any;
const root = path.resolve(import.meta.dir, "../..");
const all = fs.globSync("samples/**/*.aep", { cwd: root }).sort();
const n = Number(process.argv[2] ?? 40);
const samples =
  n > 0 && n < all.length ? Array.from({ length: n }, (_, i) => all[Math.floor((i * all.length) / n)]) : all;

const mf = new Miniflare({
  modules: [
    { type: "ESModule", path: "worker.js", contents: fs.readFileSync(path.join(root, "dist/worker.js"), "utf8") },
  ],
  compatibilityDate: "2025-09-01",
});
let identical = 0;
const problems: string[] = [];
for (const name of samples) {
  const input = fs.readFileSync(path.join(root, name));
  const res = await mf.dispatchFetch("http://smoke/", { method: "POST", body: input });
  const out = Buffer.from(await res.arrayBuffer());
  if (res.status !== 200) problems.push(`FAIL ${name}: ${out.toString()}`);
  else if (out.equals(input)) identical++;
  else problems.push(`DIFF ${name}`);
}
await mf.dispose();
console.log(JSON.stringify({ host: "workerd", total: samples.length, identical, problems: problems.length }));
for (const p of problems) console.log(p);
process.exit(identical === samples.length ? 0 : 1);
