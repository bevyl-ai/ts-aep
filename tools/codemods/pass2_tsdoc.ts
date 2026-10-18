// CLEANUP.md pass 2: Python (Google-style / mkdocs) docstrings -> TSDoc.
//
//   Args:          -> @param name - …   (keyword-only args: @param kw.name - …)
//   Returns:       -> @returns …
//   Yields:        -> @returns An iterator yielding …
//   Raises:        -> @throws {@link Error} …
//   Example(s):    -> @example
//   See: <url|ref> -> @see …
//   Note:/Warning: -> **Note:** / **Warning:** paragraphs (they stay in the description)
//   [Name][]       -> {@link Name};  [text][Name] -> {@link Name | text}
//
// Comments only: no code token changes. Parameter names come from the TS
// signature the comment documents, so they match after renames (`default_`).
// usage: bun tools/codemods/pass2_tsdoc.ts [--dry] [--report]
import ts from "typescript";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const DRY = process.argv.includes("--dry");
const REPORT = process.argv.includes("--report");

const SECTION = /^(Args|Arguments|Parameters|Returns|Return|Yields|Raises|Attributes|Examples?|Notes?|Warnings?|See(?: also)?)\s*:\s*(.*)$/i;
const report = { comments: 0, changed: 0, params: 0, unmatched: [] as string[], links: 0 };

type Signature = { params: Set<string>; kw: Map<string, string> };

/** Parameter names of the function-like node a doc comment documents. */
function signatureOf(node: ts.Node): Signature | null {
  let fn: ts.SignatureDeclarationBase | undefined;
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isGetAccessorDeclaration(node)) fn = node;
  else if (ts.isVariableStatement(node)) {
    const init = node.declarationList.declarations[0]?.initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) fn = init;
  }
  if (!fn) return null;
  const params = new Set<string>();
  const kw = new Map<string, string>();
  for (const p of fn.parameters) {
    if (!ts.isIdentifier(p.name)) continue;
    const name = p.name.text;
    params.add(name);
    if (p.type && ts.isTypeLiteralNode(p.type)) {
      for (const m of p.type.members) {
        if (m.name && ts.isIdentifier(m.name)) kw.set(m.name.text, `${name}.${m.name.text}`);
      }
    }
  }
  return { params, kw };
}

function tsParam(py: string, sig: Signature | null): string {
  const bare = py.replace(/^\*+/, "");
  if (!sig) return bare;
  if (sig.params.has(bare)) return bare;
  if (sig.params.has(bare + "_")) return bare + "_";
  if (sig.kw.has(bare)) return sig.kw.get(bare)!;
  if (py.startsWith("**") && sig.params.has("kwargs")) return "kwargs";
  if (py.startsWith("*") && sig.params.has("args")) return "args";
  // Keyword-only args behind a named options type (`kw: FmtFieldOptions`, `kw: any`).
  for (const holder of ["kw", "kwargs"]) if (sig.params.has(holder)) return `${holder}.${bare}`;
  return bare;
}

function links(text: string): string {
  return text
    .replace(/\[([^\]\n]+)\]\[([A-Za-z_][\w.]*)\]/g, (_m, label: string, target: string) => {
      report.links++;
      return label.replace(/`/g, "") === target ? `{@link ${target}}` : `{@link ${target} | ${label}}`;
    })
    .replace(/\[([A-Za-z_][\w.]*)\]\[\]/g, (_m, target: string) => {
      report.links++;
      return `{@link ${target}}`;
    });
}

/** Lines of a section body: everything indented deeper than the header, plus blank lines between. */
function takeSection(lines: string[], start: number, indent: number): { body: string[]; next: number } {
  const body: string[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i];
    if (l.trim() === "") {
      const rest = lines.slice(i + 1).find((x) => x.trim() !== "");
      if (rest === undefined || rest.search(/\S/) <= indent) break;
      body.push("");
      i++;
      continue;
    }
    if (l.search(/\S/) <= indent) break;
    body.push(l);
    i++;
  }
  return { body, next: i };
}

/** Split an Args/Raises body into entries: a line at the item indent starts an entry. */
function entries(body: string[]): string[][] {
  const nonblank = body.filter((l) => l.trim());
  if (!nonblank.length) return [];
  const itemIndent = Math.min(...nonblank.map((l) => l.search(/\S/)));
  const out: string[][] = [];
  for (const l of body) {
    if (l.trim() && l.search(/\S/) === itemIndent) out.push([l.trim()]);
    else if (out.length) out.at(-1)!.push(l.trim());
  }
  return out;
}

function join(parts: string[]): string {
  return parts.filter((p) => p !== "").join(" ");
}

/** Greedy word wrap; continuation lines of a block tag get a two-space indent. */
function wrap(text: string, width: number, cont = "  "): string[] {
  // Spaces inside `code spans` and {@link …} are not break points (TSDoc spans cannot cross lines).
  const glued = text.replace(/`[^`]*`|\{@link [^}]*\}/g, (m) => m.replace(/ /g, "\u0000"));
  const words = glued.split(/\s+/).filter(Boolean).map((w) => w.replace(/\u0000/g, " "));
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    const prefix = out.length ? cont : "";
    if (line && (prefix + line + " " + w).length > width) {
      out.push(prefix + line);
      line = w;
    } else line = line ? line + " " + w : w;
  }
  if (line) out.push((out.length ? cont : "") + line);
  return out;
}

function convert(content: string[], sig: Signature | null, where: string): string[] | null {
  const desc: string[] = [];
  const tags: string[] = [];
  let changed = false;
  for (let i = 0; i < content.length; ) {
    const line = content[i];
    const m = SECTION.exec(line.trim());
    if (!m) {
      desc.push(line);
      i++;
      continue;
    }
    const kind = m[1].toLowerCase();
    const indent = line.search(/\S/);
    const { body, next } = takeSection(content, i + 1, indent);
    const inline = m[2].trim();
    i = next;
    changed = true;
    if (kind === "args" || kind === "arguments" || kind === "parameters") {
      const kwItems = new Map<string, string[]>();
      for (const e of entries(body)) {
        const em = /^(\*{0,2}[A-Za-z_]\w*)(?:\s*\(([^)]*)\))?\s*:\s*(.*)$/.exec(e[0]);
        if (!em) {
          tags.push(`@param ${join(e)}`);
          continue;
        }
        const name = tsParam(em[1], sig);
        if (sig && !sig.params.has(name.split(".")[0])) report.unmatched.push(`${where}: ${em[1]}`);
        report.params++;
        const text = join([em[3], ...e.slice(1)]);
        const dot = name.indexOf(".");
        if (dot < 0) tags.push(`@param ${name} - ${text}`);
        else {
          // TSDoc @param names cannot be dotted: keyword-only args become one options param.
          const holder = name.slice(0, dot);
          if (!kwItems.has(holder)) kwItems.set(holder, []);
          kwItems.get(holder)!.push(`- \`${name.slice(dot + 1)}\`: ${text}`);
        }
      }
      for (const [holder, items] of kwItems) tags.push([`@param ${holder} - Keyword arguments:`, ...items].join("\n"));
    } else if (kind === "returns" || kind === "return") {
      tags.push(`@returns ${join([inline, ...body.map((l) => l.trim())])}`);
    } else if (kind === "yields") {
      tags.push(`@returns An iterator yielding ${join([inline, ...body.map((l) => l.trim())])}`);
    } else if (kind === "raises") {
      for (const e of entries(body)) {
        const em = /^([A-Za-z_][\w.]*)\s*:\s*(.*)$/.exec(e[0]);
        tags.push(em ? `@throws {@link ${em[1]}} ${join([em[2], ...e.slice(1)])}` : `@throws ${join(e)}`);
      }
    } else if (kind === "example" || kind === "examples") {
      const dedent = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
      const code = body.map((l) => (l.trim() ? l.slice(dedent) : ""));
      while (code.length && !code.at(-1)!.trim()) code.pop();
      if (inline) code.unshift(inline);
      tags.push(["@example", ...code].join("\n"));
    } else if (kind === "see" || kind === "see also") {
      const refs = [inline, ...body.map((l) => l.trim())].filter(Boolean);
      for (const r of refs) tags.push(`@see ${r}`);
    } else {
      // Note / Warning / Attributes stay prose, marked in bold.
      const label = kind.startsWith("note") ? "Note" : kind.startsWith("warn") ? "Warning" : "Attributes";
      const text = [inline, ...body.map((l) => l.trim())].filter((x, k, a) => x || (k > 0 && a[k - 1]));
      if (label === "Attributes") desc.push(`**${label}:**`, ...body.map((l) => l.replace(/^\s{0,8}/, "")));
      else desc.push(`**${label}:** ${text[0] ?? ""}`, ...text.slice(1));
    }
  }
  const linkedDesc = desc.map(links);
  const linkedTags = tags.map((t) => (t.startsWith("@example") ? t : links(t)));
  if (!changed && linkedDesc.join("\n") === desc.join("\n")) return null;
  while (linkedDesc.length && !linkedDesc.at(-1)!.trim()) linkedDesc.pop();
  const out = [...linkedDesc];
  if (linkedTags.length) {
    if (out.length) out.push("");
    for (const t of linkedTags) out.push(...t.split("\n"));
  }
  return out;
}

const TSDOC_TAGS = new Set([
  "param", "returns", "throws", "example", "see", "link", "remarks", "deprecated", "inheritDoc", "defaultValue",
  "typeParam", "privateRemarks", "internal", "beta", "alpha", "public", "readonly", "override", "virtual",
  "sealed", "eventProperty", "packageDocumentation", "label", "decorator",
]);

/** Dotted `@param kw.x …` lines (TSDoc names cannot be dotted) -> one `@param kw` with a bullet per option. */
function groupDottedParams(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    const m = /^@param\s+([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*(?:-\s*)?(.*)$/.exec(lines[i]);
    if (!m) {
      out.push(lines[i++]);
      continue;
    }
    const holder = m[1];
    const bullets: string[] = [];
    while (i < lines.length) {
      const d = /^@param\s+([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*(?:-\s*)?(.*)$/.exec(lines[i]);
      if (!d || d[1] !== holder) break;
      const text = [d[3]];
      i++;
      while (i < lines.length && lines[i].trim() && !lines[i].trim().startsWith("@")) text.push(lines[i++].trim());
      bullets.push(`- \`${d[2]}\`: ${join(text)}`);
    }
    const existing = out.findIndex((l) => new RegExp(`^@param ${holder.replace("$", "\\$")}\\b`).test(l));
    if (existing >= 0) {
      // A plain `@param kw` line already exists: keep its text, add the bullets after it.
      let k = existing + 1;
      while (k < out.length && out[k].trim() && !out[k].startsWith("@")) k++;
      out.splice(k, 0, ...bullets);
    } else out.push(`@param ${holder} - Keyword arguments:`, ...bullets);
  }
  return out;
}

/** Join a line whose `code span` is left open with the following lines (TSDoc spans cannot cross lines). */
function closeSpans(lines: string[]): string[] {
  const out: string[] = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    if (/^\s*```/.test(l)) fence = !fence;
    if (!fence && !/^\s*```/.test(l)) {
      while ((l.match(/`/g) ?? []).length % 2 === 1 && i + 1 < lines.length && lines[i + 1].trim() && !/^\s*```/.test(lines[i + 1])) {
        l = `${l.trimEnd()} ${lines[++i].trim()}`;
      }
    }
    out.push(l);
  }
  return out;
}

/** TSDoc hygiene for any comment body: hyphens, dotted params, code spans, escapes outside code. */
function normalize(input: string[]): string[] {
  const lines = closeSpans(groupDottedParams(input.map((l) => l.replace(/``([^`\n]+)``/g, "`$1`"))));
  let fence = false;
  return lines.map((l) => {
    if (/^\s*```/.test(l)) {
      fence = !fence;
      return l;
    }
    if (fence) return l;
    const out = l.replace(/^(\s*@param\s+)([A-Za-z_$][\w$]*)\s+(?!-\s)/, "$1$2 - ");
    return out
      .split(/(`[^`]*`|\{@link [^}]*\}|\{@inheritDoc [^}]*\})/)
      .map((part, k) => {
        if (k % 2) return part;
        return part
          .replace(/(?<!\\)([<>{}])/g, "\\$1")
          .replace(/(?<!\\)@([A-Za-z]\w*)?/g, (m, word: string | undefined, off: number, whole: string) => {
            const atLineStart = whole.slice(0, off).trim() === "" && off === whole.indexOf("@");
            return atLineStart && word && TSDOC_TAGS.has(word) ? m : `\\${m}`;
          });
      })
      .join("");
  });
}

function rewriteFile(file: string, sf: ts.SourceFile): number {
  const text = sf.text;
  // Doc comment start -> the declaration it documents.
  const owners = new Map<number, ts.Node>();
  const visit = (n: ts.Node) => {
    for (const r of ts.getLeadingCommentRanges(text, n.getFullStart()) ?? []) {
      if (text.startsWith("/**", r.pos) && !owners.has(r.pos)) owners.set(r.pos, n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const edits: { start: number; end: number; text: string }[] = [];
  const re = /\/\*\*[\s\S]*?\*\//g;
  for (const m of text.matchAll(re)) {
    report.comments++;
    const start = m.index!;
    const raw = m[0];
    const lineStart = text.lastIndexOf("\n", start) + 1;
    const lead = text.slice(lineStart, start);
    if (/\S/.test(lead) || !raw.includes("\n")) {
      // One-line or trailing comments: links and escapes only.
      const l = `/** ${normalize([links(raw.slice(3, -2).trim())])[0]} */`;
      if (l !== raw && raw.slice(3, -2).trim()) edits.push({ start, end: start + raw.length, text: l });
      continue;
    }
    const inner = raw.slice(3, -2).split("\n");
    const content = inner.map((l) => l.replace(/^\s*\* ?/, ""));
    if (content[0].trim() === "") content.shift();
    else content[0] = content[0].trimStart();
    while (content.length && content.at(-1)!.trim() === "") content.pop();
    const owner = owners.get(start);
    const where = `${path.relative(ROOT, file)}:${text.slice(0, start).split("\n").length}`;
    const converted = convert(content, owner ? signatureOf(owner) : null, where);
    const width = Math.max(60, 100 - lead.length - 3);
    const wrapped = (converted ?? content).flatMap((l) =>
      /^@(param|returns|throws) /.test(l) && l.length > width ? wrap(l, width) : /^- `/.test(l) && l.length > width ? wrap(l, width, "    ") : [l],
    );
    const lines = normalize(wrapped);
    if (!converted && lines.join("\n") === content.join("\n")) continue;
    const body = lines.map((l) => (l ? `${lead} * ${l}` : `${lead} *`)).join("\n");
    edits.push({ start, end: start + raw.length, text: `/**\n${body}\n${lead} */` });
  }
  if (!edits.length) return 0;
  let next = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) next = next.slice(0, e.start) + e.text + next.slice(e.end);
  if (!DRY) fs.writeFileSync(file, next);
  report.changed += edits.length;
  return edits.length;
}

const files = (fs.readdirSync(path.join(ROOT, "src/py_aep"), { recursive: true }) as string[])
  .filter((f) => f.endsWith(".ts"))
  .map((f) => path.join(ROOT, "src/py_aep", f));
let touched = 0;
for (const file of files) {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  if (rewriteFile(file, sf)) touched++;
}
console.log(JSON.stringify({ files_touched: touched, comments_seen: report.comments, comments_changed: report.changed, params: report.params, links: report.links, unmatched_params: report.unmatched.length }));
if (REPORT) for (const u of report.unmatched) console.log("unmatched", u);
