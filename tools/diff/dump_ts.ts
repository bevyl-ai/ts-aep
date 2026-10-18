// Reflective dump of everything the TS port exposes for a project, as JSON
// lines. Twin of dump_py.py: same traversal order, same canonical values.
//
// usage: bun tools/diff/dump_ts.ts OUT_DIR SAMPLE...

import * as fs from "node:fs";
import * as py_aep from "../../src/py_aep/index.ts";
import { Path } from "../../src/pyrt/pathlib.ts";
import { Element } from "../../src/pyrt/etree.ts";

const MAX_DEPTH = 40;

function num(x: number | bigint): any {
  if (typeof x === "bigint") return Math.abs(Number(x)) < 2 ** 53 ? Number(x) : { $big: x.toString() };
  if (Number.isNaN(x)) return { $f: "nan" };
  if (!Number.isFinite(x)) return { $f: x > 0 ? "inf" : "-inf" };
  if (Object.is(x, -0)) return { $f: "-0" };
  return x;
}

function public_names(obj: any): string[] {
  const names = new Set<string>();
  for (let p = Object.getPrototypeOf(obj); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const [name, d] of Object.entries(Object.getOwnPropertyDescriptors(p))) {
      // `length` / `size` getters are the JS spelling of Python's `len()`, not attributes.
      if (name.startsWith("_") || name === "constructor" || name === "length" || name === "size") continue;
      if (d.get) names.add(name);
    }
  }
  for (const k of Object.keys(obj)) if (!k.startsWith("_")) names.add(k);
  // Python class constants are readable through the instance (`self.X`).
  for (let c = obj.constructor; c && c !== Function.prototype; c = Object.getPrototypeOf(c)) {
    for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(c))) {
      if (k.startsWith("_") || ["length", "name", "prototype"].includes(k)) continue;
      if ("value" in d && typeof d.value !== "function") names.add(k);
    }
  }
  return [...names].sort(py_order);
}

/** Python sorts str by code point; JS default sort by UTF-16 unit (same for these ASCII names). */
function py_order(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function is_container(obj: any): boolean {
  return typeof obj?.[Symbol.iterator] === "function" && (typeof obj.length === "number" || typeof obj.size === "number");
}

export function err_name(e: any): string {
  const n: string = e?.constructor?.name ?? "Error";
  return n.endsWith("_") ? n.slice(0, -1) : n;
}

export class Dumper {
  seen = new Map<any, string>();
  constructor(private write: (line: string) => void) {}

  emit(path: string, value: any): void {
    this.write(JSON.stringify([path, value]) + "\n");
  }

  walk(path: string, value: any, depth = 0): void {
    if (value == null) return this.emit(path, null);
    if (typeof value === "boolean") return this.emit(path, value);
    if (typeof value === "string" || value instanceof String) return this.emit(path, String(value));
    if (typeof value === "number" || typeof value === "bigint") return this.emit(path, num(value));
    if (value instanceof Uint8Array) return this.emit(path, { $bytes: Buffer.from(value).toString("hex") });
    if (value instanceof Date) {
      // Twin of a naive Python datetime: UTC fields, isoformat(timespec="microseconds").
      return this.emit(path, { $datetime: value.toISOString().slice(0, -1) + "000" });
    }
    if (value instanceof Path) return this.emit(path, { $path: String(value) });
    if (Array.isArray(value)) {
      this.emit(path, { $list: value.length });
      value.forEach((v, i) => this.walk(`${path}[${i}]`, v, depth + 1));
      return;
    }
    if (value instanceof Map) {
      const keys = [...value.keys()];
      this.emit(path, { $dict: keys.map(String) });
      for (const k of keys) this.walk(`${path}{${String(k)}}`, value.get(k), depth + 1);
      return;
    }
    if (value instanceof Set) return this.emit(path, { $set: [...value].map((v) => JSON.stringify(v)).sort() });
    if (typeof value === "function") return this.emit(path, { $callable: true });
    if (value instanceof Element) {
      this.emit(path, { $el: value.tag, attrib: Object.fromEntries(value.attrib instanceof Map ? value.attrib : Object.entries(value.attrib ?? {})), text: value.text ?? null, tail: value.tail ?? null });
      [...value].forEach((c: any, i: number) => this.walk(`${path}[${i}]`, c, depth + 1));
      return;
    }
    if ("_replace" in value && typeof value[Symbol.iterator] === "function") {
      // A NamedTuple is a tuple in Python.
      return this.walk(path, [...value], depth);
    }
    if (this.seen.has(value)) return this.emit(path, { $ref: this.seen.get(value) });
    this.seen.set(value, path);
    const cls: string = value.constructor?.name ?? "object";
    if (cls === "Object") {
      // A plain object stands for a Python dict (kwargs-style record).
      const keys = Object.keys(value);
      this.emit(path, { $dict: keys });
      for (const k of keys) this.walk(`${path}{${k}}`, value[k], depth + 1);
      return;
    }
    this.emit(path, { $obj: cls });
    if (depth >= MAX_DEPTH) return;
    for (const name of public_names(value)) {
      let v: any;
      try {
        v = value[name];
      } catch (e) {
        this.emit(`${path}.${name}`, { $err: err_name(e) });
        continue;
      }
      if (typeof v === "function" && !/^[A-Z]/.test(v.name ?? "")) continue;
      this.walk(`${path}.${name}`, v, depth + 1);
    }
    if (is_container(value)) {
      let items: any[];
      try {
        items = [...value];
      } catch (e) {
        this.emit(`${path}[*]`, { $err: err_name(e) });
        return;
      }
      this.emit(`${path}[*]`, { $len: items.length });
      items.forEach((v, i) => this.walk(`${path}[${i}]`, v, depth + 1));
    }
  }
}

if (import.meta.main) {
  const [out_dir, ...samples] = process.argv.slice(2);
  fs.mkdirSync(out_dir, { recursive: true });
  for (const sample of samples) {
    const fd = fs.openSync(`${out_dir}/${sample.replaceAll("/", "__")}.jsonl`, "w");
    const d = new Dumper((line) => fs.writeSync(fd, line));
    try {
      let app: any;
      try {
        app = py_aep.parse(sample);
      } catch (e) {
        d.emit("$parse", { $err: err_name(e) });
        continue;
      }
      d.walk("app", app);
    } finally {
      fs.closeSync(fd);
    }
  }
}
