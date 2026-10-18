// Prove a pass changed only types and comments: the JavaScript TypeScript
// emits for every changed file must equal the emit at a base revision.
// usage: bun tools/js_equal.ts <base-rev>
import ts from "typescript";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

const base = process.argv[2] ?? "HEAD";
const files = execFileSync("git", ["diff", "--name-only", base, "--", "src"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && fs.existsSync(f));
const emit = (f: string, text: string) =>
  ts.transpileModule(text, {
    fileName: f,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      removeComments: true,
      verbatimModuleSyntax: false,
    },
  }).outputText;
const existed = (f: string) => {
  try {
    execFileSync("git", ["cat-file", "-e", `${base}:${f}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const changed: string[] = [];
for (const f of files) {
  // A file added since `base` must be type-only: it emits nothing but `export {};`.
  const before = existed(f)
    ? emit(f, execFileSync("git", ["show", `${base}:${f}`], { encoding: "utf8", maxBuffer: 1 << 26 }))
    : "export {};\n";
  if (before !== emit(f, fs.readFileSync(f, "utf8"))) changed.push(f);
}
console.log(JSON.stringify({ base, files: files.length, js_changed: changed.length }));
for (const f of changed) console.log("JS CHANGED:", f);
process.exit(changed.length ? 1 : 0);
