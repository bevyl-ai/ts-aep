/**
 * The zod schemas of the text-document COS tree (`src/py_aep/cos/schema.ts`)
 * against real data: every `btdk` blob in the upstream samples, the
 * point-text template, and trees py_aep itself wrote.
 *
 * The library runs these schemas at the decode boundary (`decode_btdk`) and
 * at every keyed `isinstance` read (`read`). This checks that real files take
 * the typed path everywhere: each tree decodes, and every key a layout names
 * holds the layout's kind wherever that layout sits in the tree.
 *
 * Port-only: py-aep has no schemas.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { parse } from "../../src/py_aep/index.ts";
import { ListChunk, read_aep, type Chunk } from "../../src/py_aep/binary/chunk.ts";
import { CosParser, type CosDict, type CosNode } from "../../src/py_aep/cos/cos.ts";
import {
  cache_line,
  char_style,
  decode_btdk,
  first_baseline,
  font_ref,
  read,
  type Layout,
} from "../../src/py_aep/cos/schema.ts";
import { get_cos_template } from "../../src/py_aep/cos/text.ts";
import { BytesIO, py_assert } from "../../src/pyrt/index.ts";
import { TextDocument } from "../../src/py_aep/models/text/text_document.ts";
import { LineOrientation, ParagraphJustification } from "../../src/py_aep/enums/index.ts";

function* btdk_chunks(chunk: Chunk): Generator<ListChunk> {
  if (!(chunk instanceof ListChunk)) return;
  if (chunk.list_type === "btdk") yield chunk;
  for (const child of chunk.chunks ?? []) yield* btdk_chunks(child);
}

const dict = (x: CosNode | undefined): CosDict | null => (x instanceof Map ? x : null);
const list = (x: CosNode | undefined): CosNode[] => (Array.isArray(x) ? x : []);

/** Every (layout, dict, where) the readers apply a layout to. */
function* positions(root: CosDict): Generator<[string, Layout, CosDict]> {
  const res = dict(root.get("0"));
  const state = dict(root.get("1"));
  for (const preset of list(dict(res?.get("5"))?.get("0"))) {
    const style = dict(dict(dict(preset)?.get("0"))?.get("6"));
    if (style) yield ["char_style (preset)", char_style, style];
  }
  for (const slot of list(dict(res?.get("8"))?.get("0"))) {
    const meta = dict(dict(dict(slot)?.get("0"))?.get("2"));
    const sub = dict(meta?.get("10"));
    if (sub) yield ["first_baseline", first_baseline, sub];
  }
  const typography = dict(dict(state?.get("0"))?.get("0"));
  if (typography) yield ["font_ref (typography)", font_ref, typography];
  const default_style = dict(state?.get("2"));
  if (default_style) yield ["char_style (default)", char_style, default_style];
  for (const session of list(state?.get("5"))) {
    for (const record of list(dict(session)?.get("4"))) {
      const r = dict(record);
      if (r) yield ["font_ref (used font)", font_ref, r];
    }
  }
  for (const doc of list(state?.get("1"))) {
    const text = dict(dict(doc)?.get("0"));
    for (const entry of list(dict(text?.get("6"))?.get("0"))) {
      const style = dict(dict(dict(dict(entry)?.get("0"))?.get("0"))?.get("6"));
      if (style) yield ["char_style", char_style, style];
    }
    const walk = function* (node: CosNode): Generator<[string, Layout, CosDict]> {
      const d = dict(node);
      if (!d) return;
      if (String(d.get("99")) === "L") yield ["cache_line", cache_line, d];
      for (const child of list(d.get("6"))) yield* walk(child);
    };
    for (const node of list(dict(dict(doc)?.get("1"))?.get("2"))) yield* walk(node);
  }
}

/** Keys a layout names whose value is present but of another kind. */
function mismatches(root: CosDict): string[] {
  const out: string[] = [];
  for (const [where, layout, d] of positions(root)) {
    for (const key of Object.keys(layout)) {
      if (d.has(key) && read(layout, d, key) === undefined) out.push(`${where}["${key}"] = ${String(d.get(key))}`);
    }
  }
  return out;
}

describe("btdk schema", () => {
  test("every sample's btdk tree decodes and takes the typed path", () => {
    const files = fs.globSync("samples/**/*.aep").sort();
    expect(files.length).toBe(645);
    let trees = 0;
    let checked = 0;
    const failures: string[] = [];
    for (const file of files) {
      const [rifx] = read_aep(new BytesIO(new Uint8Array(fs.readFileSync(file))));
      for (const chunk of btdk_chunks(rifx)) {
        const root = decode_btdk(new CosParser(new BytesIO(chunk.data), chunk.data.length).parse());
        trees++;
        if (root == null) {
          failures.push(`${file}: does not decode`);
          continue;
        }
        checked += [...positions(root)].length;
        for (const m of mismatches(root)) failures.push(`${file}: ${m}`);
      }
    }
    expect(failures).toEqual([]);
    expect(trees).toBe(242);
    expect(checked).toBe(1902);
  }, 120_000);

  test("the point-text template conforms", () => {
    expect(mismatches(get_cos_template())).toEqual([]);
  });

  test("trees py_aep writes conform", () => {
    const app = parse("samples/models/text/text_writes.aep");
    const docs = app.project.compositions[0].text_layers.map((layer) => {
      py_assert(layer.text != null);
      return layer.text.__getitem__("ADBE Text Document").value;
    });
    expect(docs.length).toBeGreaterThan(0);
    for (const doc of docs) {
      if (!(doc instanceof TextDocument)) continue;
      doc.text = "Hello\nwide world";
      doc.font = "Georgia";
      doc.fill_color = [0.25, 0.5, 0.75];
      doc.stroke_color = [1, 0, 0];
      doc.leading = 40;
      const range = doc.character_range(1, 4);
      range.kerning = 25;
      range.font_size = 18;
      doc.character_range(7, 9).justification = ParagraphJustification.CENTER_JUSTIFY;
      doc.character_range(0, 2).paste_from(doc.character_range(6, 9));
      doc.box_text_size = [300, 120];
      doc.box_inset_spacing = 4;
      expect(mismatches(doc._cos_data)).toEqual([]);
    }
    const fresh = new TextDocument("New\ntext", [200, 100], LineOrientation.VERTICAL_RIGHT_TO_LEFT);
    expect(mismatches(fresh._cos_data)).toEqual([]);
  });
});
