// Typecheck every ```ts example in src doc comments against the real API.
// Examples import from "@bevyl-ai/ts-aep" (mapped to src/py_aep/index.ts).
// usage: bun tools/doc_examples.ts [file...]   (default: all of src/)
import ts from "typescript";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const OUT = path.join(ROOT, ".doccheck");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const only = process.argv.slice(2).map((f) => path.resolve(f));
const files = (fs.readdirSync(path.join(ROOT, "src"), { recursive: true }) as string[])
  .filter((f) => f.endsWith(".ts"))
  .map((f) => path.join(ROOT, "src", f))
  .filter((f) => !only.length || only.includes(f));

const origin = new Map<string, string>();
let python = 0;
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  let n = 0;
  for (const c of text.matchAll(/\/\*\*[\s\S]*?\*\//g)) {
    const lines = c[0].split("\n").map((l) => l.replace(/^\s*\*( |$)/, ""));
    for (let i = 0; i < lines.length; i++) {
      const fence = /^\s*```(\w*)/.exec(lines[i]);
      if (!fence) continue;
      const end = lines.findIndex((l, k) => k > i && /^\s*```\s*$/.test(l));
      if (end < 0) break;
      if (fence[1] === "python" || fence[1] === "py") python++;
      if (fence[1] === "ts" || fence[1] === "typescript") {
        const code = lines
          .slice(i + 1, end)
          .join("\n")
          .replace(/\\([<>{}@])/g, "$1");
        const line = text.slice(0, c.index).split("\n").length + i;
        const name = `${path.relative(ROOT, file).replace(/[/.]/g, "_")}_${n++}.ts`;
        fs.writeFileSync(path.join(OUT, name), `export {};\n${code}\n`);
        origin.set(path.join(OUT, name), `${path.relative(ROOT, file)}:${line}`);
      }
      i = end;
    }
  }
}

const program = ts.createProgram([...origin.keys()], {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  noEmit: true,
  strict: false,
  skipLibCheck: true,
  types: ["bun"],
  baseUrl: ROOT,
  paths: { "@bevyl-ai/ts-aep": ["src/py_aep/index.ts"] },
});
const errors = ts.getPreEmitDiagnostics(program).filter((d) => d.file && origin.has(d.file.fileName));
for (const d of errors) {
  const { line } = d.file!.getLineAndCharacterOfPosition(d.start!);
  console.log(
    `${origin.get(d.file!.fileName)} (example line ${line}): ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`,
  );
}
console.log(JSON.stringify({ ts_examples: origin.size, python_examples: python, errors: errors.length }));
process.exit(errors.length ? 1 : 0);
