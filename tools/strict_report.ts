// Bottom-up typing ratchet: strict-mode errors and loose-type counts per layer.
// usage: bun tools/strict_report.ts [--json] [--files <layer>]
import ts from "typescript";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
export const LAYERS: [string, RegExp][] = [
  ["0 pyrt", /^src\/pyrt\//],
  ["1 binary+enums+data", /^src\/py_aep\/(binary|enums|data)\/|^src\/py_aep\/(ae_version|utils)\.ts$/],
  ["2 cos+color", /^src\/py_aep\/(cos|color)\//],
  ["3 parsers+synthesis", /^src\/py_aep\/(parsers|synthesis)\//],
  ["4 models", /^src\/py_aep\/models\//],
  ["5 resolvers+svg", /^src\/py_aep\/(resolvers|svg)\//],
  ["6 cli+entry", /^src\/py_aep\/(cli\/|index\.ts)/],
  ["7 tests", /^tests\//],
];
const layerOf = (f: string) => LAYERS.find(([, re]) => re.test(f))?.[0] ?? "other";

const cfg = ts.getParsedCommandLineOfConfigFile(
  path.join(ROOT, "tsconfig.json"),
  {},
  { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
)!;
const program = ts.createProgram(cfg.fileNames, {
  ...cfg.options,
  strict: true,
  noImplicitAny: true,
  strictNullChecks: true,
});
const rows = new Map<string, { strict: number; any: number; unknown: number; casts: number; files: number }>();
const filesOf = new Map<string, string[]>();
const bump = (l: string) =>
  rows.get(l) ?? (rows.set(l, { strict: 0, any: 0, unknown: 0, casts: 0, files: 0 }), rows.get(l)!);
for (const sf of program.getSourceFiles()) {
  const rel = path.relative(ROOT, sf.fileName);
  if (!rel.startsWith("src/") && !rel.startsWith("tests/")) continue;
  const l = layerOf(rel);
  const r = bump(l);
  r.files++;
  (filesOf.get(l) ?? (filesOf.set(l, []), filesOf.get(l)!)).push(rel);
  r.strict += ts.getPreEmitDiagnostics(program, sf).filter((d) => d.file === sf).length;
  const visit = (n: ts.Node) => {
    if (n.kind === ts.SyntaxKind.AnyKeyword) r.any++;
    if (n.kind === ts.SyntaxKind.UnknownKeyword) r.unknown++;
    if (
      (ts.isAsExpression(n) && !(ts.isTypeReferenceNode(n.type) && n.type.typeName.getText(sf) === "const")) ||
      ts.isTypeAssertionExpression(n)
    )
      r.casts++;
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
if (process.argv.includes("--files")) {
  const want = process.argv[process.argv.indexOf("--files") + 1];
  console.log(JSON.stringify(filesOf.get([...filesOf.keys()].find((k) => k.startsWith(want))!)));
} else if (process.argv.includes("--json")) console.log(JSON.stringify(Object.fromEntries(rows)));
else {
  console.log("layer                   files  strict-errors    any  unknown  casts");
  let t = { strict: 0, any: 0, unknown: 0, casts: 0, files: 0 };
  for (const [l] of LAYERS) {
    const r = rows.get(l)!;
    console.log(
      `${l.padEnd(24)}${String(r.files).padStart(5)}${String(r.strict).padStart(15)}${String(r.any).padStart(7)}${String(r.unknown).padStart(9)}${String(r.casts).padStart(7)}`,
    );
    for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += r[k];
  }
  console.log(
    `${"total".padEnd(24)}${String(t.files).padStart(5)}${String(t.strict).padStart(15)}${String(t.any).padStart(7)}${String(t.unknown).padStart(9)}${String(t.casts).padStart(7)}`,
  );
}
