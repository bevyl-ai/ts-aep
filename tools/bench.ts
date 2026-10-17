// Parse every sample, then save every parsed project to memory; report total ms and the
// slowest files. Files are read up front so disk time stays out of the numbers.
// usage: bun tools/bench.ts [--runs N] [--top N] [--filter substr]
import * as fs from "node:fs";
import * as py_aep from "../src/py_aep/index.ts";
import { write_aep } from "../src/py_aep/binary/chunk.ts";
import { BytesIO } from "../src/pyrt/bytesio.ts";
import { CosParser } from "../src/py_aep/cos/cos.ts";
import { serialize } from "../src/py_aep/cos/serializer.ts";
import { recursive_find } from "../src/py_aep/binary/utils.ts";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const runs = Number(opt("--runs", "3"));
const top = Number(opt("--top", "8"));
const filter = opt("--filter", "");

const files = fs.globSync("samples/**/*.aep").filter((f) => f.includes(filter)).sort();
// `parse` takes a path; one warm-up read puts every file in the page cache.
for (const f of files) fs.readFileSync(f);

function save_to_memory(app: py_aep.Application): Uint8Array {
  const project = app.project;
  for (const comp of project.compositions) {
    if (comp._layers_loaded) {
      for (const layer of comp.layers) layer._write_out_moved_defaults();
    }
  }
  const buf = new BytesIO();
  write_aep(buf, project._rifx, project._xmp);
  return buf.getvalue();
}

const PHASES = ["parse", "save", "load", "save_loaded", "cos"] as const;
type Phase = (typeof PHASES)[number];
const best = new Map<string, Record<Phase, number>>();
const totals: Record<Phase, number>[] = [];
for (let run = 0; run < runs; run++) {
  const total: Record<Phase, number> = { parse: 0, save: 0, load: 0, save_loaded: 0, cos: 0 };
  for (const f of files) {
    // parse; save as parsed (deferred layer lists written raw); build every comp's
    // layers and property trees; save again with everything built; serialize every
    // text document's COS tree (what a text edit writes back).
    const t0 = performance.now();
    const app = py_aep.parse(f);
    const t1 = performance.now();
    save_to_memory(app);
    const t2 = performance.now();
    for (const comp of app.project.compositions) void comp.layers;
    const t3 = performance.now();
    save_to_memory(app);
    const t4 = performance.now();
    const trees = recursive_find(app.project._rifx.chunks, null, "btdk").map((c) =>
      new CosParser(new BytesIO(c.data), c.data.length).parse(),
    );
    const t5 = performance.now();
    for (const tree of trees) serialize(tree);
    const t6 = performance.now();
    const took: Record<Phase, number> = { parse: t1 - t0, save: t2 - t1, load: t3 - t2, save_loaded: t4 - t3, cos: t6 - t5 };
    const prev = best.get(f);
    for (const k of PHASES) total[k] += took[k];
    best.set(f, Object.fromEntries(PHASES.map((k) => [k, Math.min(prev?.[k] ?? Infinity, took[k])])) as Record<Phase, number>);
  }
  totals.push(total);
  console.log(`run ${run + 1}: ${PHASES.map((k) => `${k} ${total[k].toFixed(0)}`).join(", ")} ms`);
}
console.log(`best of ${runs} (${files.length} files): ${PHASES.map((k) => `${k} ${Math.min(...totals.map((t) => t[k])).toFixed(0)}`).join(", ")} ms`);
for (const k of PHASES) {
  console.log(`top ${k}:`);
  for (const [f, r] of [...best].sort((a, b) => b[1][k] - a[1][k]).slice(0, top)) {
    console.log(`  ${r[k].toFixed(1).padStart(8)} ms  ${f}`);
  }
}
