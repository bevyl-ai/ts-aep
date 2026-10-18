// Zero-cast ratchet for the typed text-document COS stack.
//
// In the directories below there must be no `as` cast (`as const` aside), no
// `<T>x` assertion, no non-null `!` assertion and no `any`; `unknown` is
// allowed only at the single decode entry point (`cos/schema.ts`) and as the
// `other` parameter of an `__eq__` dunder (Python's `object`). Prints
// every offence with its location and exits 1 when there is one.
//
// usage: bun tools/type_ratchet.ts [--json]
import ts from "typescript";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const DIRS = [/^src\/py_aep\/cos\//, /^src\/py_aep\/models\/text\//, /^src\/py_aep\/resolvers\/text_[^/]*\.ts$/];
/** Files allowed to say `unknown`, and how often: the decode entry point. */
const UNKNOWN_BUDGET = new Map([["src/py_aep/cos/schema.ts", 2]]);

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (p.endsWith(".ts")) yield p;
  }
}

/** `__eq__(other: unknown)`: the dunder compares against any object, like Python's `object`. */
function isEqParam(node: ts.Node): boolean {
  const param = node.parent;
  return ts.isParameter(param) && ts.isMethodDeclaration(param.parent) && param.parent.name.getText() === "__eq__";
}

type Kind = "cast" | "non-null" | "any" | "unknown";
const found: { file: string; line: number; kind: Kind; text: string }[] = [];
const counts = new Map<string, Record<Kind, number>>();

for (const abs of walk(path.join(ROOT, "src"))) {
  const rel = path.relative(ROOT, abs);
  if (!DIRS.some((re) => re.test(rel))) continue;
  const sf = ts.createSourceFile(abs, fs.readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, true);
  const c: Record<Kind, number> = { cast: 0, "non-null": 0, any: 0, unknown: 0 };
  counts.set(rel, c);
  const hit = (node: ts.Node, kind: Kind) => {
    c[kind]++;
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    found.push({ file: rel, line, kind, text: node.getText(sf).split("\n")[0].slice(0, 100) });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) && !(ts.isTypeReferenceNode(node.type) && node.type.typeName.getText(sf) === "const")) {
      hit(node, "cast");
    } else if (ts.isTypeAssertionExpression(node)) {
      hit(node, "cast");
    } else if (ts.isNonNullExpression(node)) {
      hit(node, "non-null");
    } else if (node.kind === ts.SyntaxKind.AnyKeyword) {
      hit(node, "any");
    } else if (node.kind === ts.SyntaxKind.UnknownKeyword && !isEqParam(node)) {
      c.unknown++;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (c.unknown > (UNKNOWN_BUDGET.get(rel) ?? 0)) {
    found.push({ file: rel, line: 0, kind: "unknown", text: `${c.unknown} uses (budget ${UNKNOWN_BUDGET.get(rel) ?? 0})` });
  }
}

const total = { files: counts.size, cast: 0, "non-null": 0, any: 0, unknown: 0 };
for (const c of counts.values()) for (const k of ["cast", "non-null", "any", "unknown"] as const) total[k] += c[k];
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ ...total, offences: found.length }));
} else {
  console.log(JSON.stringify({ ...total, offences: found.length }));
  for (const f of found) console.log(`${f.file}:${f.line}  ${f.kind}  ${f.text}`);
}
process.exit(found.length ? 1 : 0);
