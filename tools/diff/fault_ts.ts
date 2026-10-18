// Fault-injection differential, TS side: twin of `fault_py.py run`. Parse
// each corrupted case, dump its text documents, apply the same writes, save,
// and record OUT/ts/<id>.json.
//
// usage: bun tools/diff/fault_ts.ts OUT [ID...]

import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as py_aep from "../../src/py_aep/index.ts";
import { Dumper, errName, tsName } from "./dump_ts.ts";
import { AttributeError } from "../../src/pyrt/index.ts";

const WRITES: [string, string, any][] = [
  ["doc", "text", "Hi\nthere"],
  ["doc", "font_size", 20.0],
  ["doc", "tracking", 5],
  ["doc", "fill_color", [0.25, 0.5, 0.75]],
  ["doc", "apply_stroke", true],
  ["doc", "leading", 30.0],
  ["doc", "justification", 7414],
  ["doc", "font", "NoSuchFont-Regular"],
  ["doc", "box_text_size", [200.0, 100.0]],
  ["doc", "box_inset_spacing", 4.0],
  ["range", "font_size", 12.0],
  ["range", "kerning", 25],
  ["range", "text", "ab"],
  ["doc", "auto_kern_type", 11413],
];

/** `obj.name` with Python's AttributeError on `None` (the TS twin would raise a JS TypeError). */
function attrOf(obj: any, name: string): any {
  if (obj == null) throw new AttributeError(`'NoneType' object has no attribute '${name}'`);
  const ts = tsName(name);
  return obj[ts in Object(obj) ? ts : name].bind(obj);
}

function textDocuments(app: any): [string, any][] {
  const out: [string, any][] = [];
  app.project.compositions.forEach((comp: any, ci: number) => {
    comp.textLayers.forEach((layer: any, li: number) => {
      const st = layer.text.sourceText;
      const kfs = st.keyframes;
      if (kfs.length) kfs.forEach((kf: any, ki: number) => out.push([`c${ci}.l${li}.k${ki}`, kf]));
      else out.push([`c${ci}.l${li}`, st]);
    });
  });
  return out;
}

function runCase(out: string, id: string): any {
  const lines: string[] = [];
  const d = new Dumper((line) => lines.push(line.replace(/\n$/, "")));
  let app: any;
  try {
    app = py_aep.parse(`${out}/cases/${id}.aep`);
  } catch (e) {
    return { parse: errName(e) };
  }
  const docs = textDocuments(app);
  const writes: string[] = [];
  for (const [path, holder] of docs) {
    let doc: any;
    try {
      doc = holder.value;
    } catch (e) {
      d.emit(path, { $err: errName(e) });
      continue;
    }
    d.walk(path, doc);
    for (const [name, args] of [["character_range", [0, -1]], ["paragraph_range", [0]], ["composed_line_range", [0]]] as const) {
      let r: any;
      try {
        r = attrOf(doc, name)(...args);
      } catch (e) {
        d.emit(`${path}.${name}()`, { $err: errName(e) });
        continue;
      }
      d.walk(`${path}.${name}()`, r);
    }
  }
  if (docs.length) {
    const [, holder] = docs[0];
    for (const [target, name, value] of WRITES) {
      try {
        const doc = holder.value;
        const obj = target === "doc" ? doc : attrOf(doc, "character_range")(0, 1);
        if (obj == null) throw new AttributeError(`'NoneType' object has no attribute '${name}'`);
        obj[name] = value;
        writes.push("ok");
      } catch (e) {
        writes.push(errName(e));
      }
    }
  }
  const result: any = { dump: lines, writes };
  const buf = `${out}/ts/${id}.aep`;
  try {
    app.project.save(buf);
    result.save = createHash("sha1").update(fs.readFileSync(buf)).digest("hex");
    fs.unlinkSync(buf);
  } catch (e) {
    result.save = { $err: errName(e) };
  }
  return result;
}

const [out, ...ids] = process.argv.slice(2);
fs.mkdirSync(`${out}/ts`, { recursive: true });
const want = new Set(ids);
for (const line of fs.readFileSync(`${out}/cases.jsonl`, "utf8").split("\n")) {
  if (!line) continue;
  const { id } = JSON.parse(line);
  if (want.size && !want.has(id)) continue;
  fs.writeFileSync(`${out}/ts/${id}.json`, JSON.stringify(runCase(out, id)));
}
