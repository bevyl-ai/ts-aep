// Edit-and-save differential, TS side: replay each plan edit_py.py wrote on
// a fresh TS parse, record outcomes, and save (OUT/<name>.ts.aep).
//
// usage: bun tools/diff/edit_ts.ts OUT_DIR SAMPLE...

import * as fs from "node:fs";
import * as py_aep from "../../src/py_aep/index.ts";
import { ts_name } from "./dump_ts.ts";

function err_name(e: any): string {
  const n: string = e?.constructor?.name ?? "Error";
  return n.endsWith("_") ? n.slice(0, -1) : n;
}

function decode(spec: Record<string, any>): any {
  const [[, v]] = Object.entries(spec);
  return v;
}

/** The TS member for a py-aep name on `obj`: camelCase on models, the raw name on binary chunks. */
function member(obj: any, py: string): string {
  const name = ts_name(py);
  return obj != null && name !== py && !(name in Object(obj)) ? py : name;
}

function resolve(app: any, path: string): [any, string] {
  const steps = [...path.slice(3).matchAll(/\.(\w+)|\[(\d+)\]/g)];
  let obj = app;
  for (const m of steps.slice(0, -1)) {
    if (m[1] !== undefined) obj = obj[member(obj, m[1])];
    else obj = Array.isArray(obj) ? obj[Number(m[2])] : [...obj][Number(m[2])];
  }
  return [obj, member(obj, steps.at(-1)![1])];
}

const [out, ...samples] = process.argv.slice(2);
for (const sample of samples) {
  const name = sample.replaceAll("/", "__");
  const plan = JSON.parse(fs.readFileSync(`${out}/${name}.plan.json`, "utf8"));
  if (!plan.edits) continue;
  const app: any = py_aep.parse(sample);
  const outcomes: string[] = [];
  for (const e of plan.edits) {
    try {
      const [obj, attr] = resolve(app, e.path);
      obj[attr] = decode(e.value);
      outcomes.push("ok");
    } catch (ex) {
      outcomes.push(err_name(ex));
    }
  }
  let save = "ok";
  try {
    app.project.save(`${out}/${name}.ts.aep`);
  } catch (ex) {
    save = err_name(ex);
  }
  fs.writeFileSync(`${out}/${name}.ts.json`, JSON.stringify({ outcomes, save }));
}
