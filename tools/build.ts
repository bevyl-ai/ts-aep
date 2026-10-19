// Build the published package: dist/index.js (Node, Bun) and dist/browser.js
// (bundled hosts, which import fontkit/yaml up front), sharing one chunk, with
// dependencies external, + dist/types (declarations from tsc, `.ts` specifiers -> `.js`).
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

fs.rmSync("dist", { recursive: true, force: true });

// `splitting` is missing from this bun-types release; spread, it skips the excess-property check.
const splitting = { splitting: true };
const out = await Bun.build({
  entrypoints: ["src/py_aep/index.ts", "src/py_aep/browser.ts"],
  outdir: "dist",
  ...splitting,
  format: "esm",
  target: "browser",
  packages: "external",
  sourcemap: "linked",
});
if (!out.success) {
  for (const log of out.logs) console.error(log);
  process.exit(1);
}

// Declarations leave out underscore members: they are internal to the library.
const config = ts.getParsedCommandLineOfConfigFile(
  "tsconfig.build.json",
  {},
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => console.error(ts.flattenDiagnosticMessageText(d.messageText, "\n")),
  },
);
if (!config) process.exit(1);
const program = ts.createProgram(config.fileNames, config.options);
const isInternal = (m: ts.ClassElement): boolean =>
  m.name !== undefined && (ts.isIdentifier(m.name) || ts.isPrivateIdentifier(m.name)) && m.name.text.startsWith("_");
const hideInternals: ts.TransformerFactory<ts.SourceFile | ts.Bundle> = (context) => (root) => {
  const visit = (node: ts.Node): ts.Node => {
    if (ts.isClassDeclaration(node)) {
      return context.factory.updateClassDeclaration(
        node,
        node.modifiers,
        node.name,
        node.typeParameters,
        node.heritageClauses,
        node.members.filter((m) => !isInternal(m)),
      );
    }
    return ts.visitEachChild(node, visit, context);
  };
  return ts.visitNode(root, visit) as ts.SourceFile | ts.Bundle;
};
const emitted = program.emit(undefined, undefined, undefined, true, { afterDeclarations: [hideInternals] });
const diagnostics = [...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics];
if (diagnostics.length) {
  console.error(
    ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getNewLine: () => "\n",
    }),
  );
  process.exit(1);
}

let rewritten = 0;
for (const file of fs.readdirSync("dist/types", { recursive: true }) as string[]) {
  if (!file.endsWith(".d.ts")) continue;
  const p = path.join("dist/types", file);
  const src = fs.readFileSync(p, "utf8");
  const next = src.replace(
    /(from\s+|import\s+|import\(\s*)(["'])(\.{1,2}\/[^"']+)\.ts\2/g,
    (_, pre, q, spec) => `${pre}${q}${spec}.js${q}`,
  );
  if (next !== src) {
    fs.writeFileSync(p, next);
    rewritten++;
  }
}
// Ambient declarations for untyped dependencies (fontkit, harfbuzzjs) ship with the types.
fs.mkdirSync("dist/types/types", { recursive: true });
for (const f of fs.readdirSync("src/types")) {
  const src = fs.readFileSync(path.join("src/types", f), "utf8");
  fs.writeFileSync(
    path.join("dist/types/types", f),
    src.replace(/(import\(\s*)(["'])(\.{1,2}\/[^"']+)\.ts\2/g, (_, pre, q, spec) => `${pre}${q}${spec}.js${q}`),
  );
}
const entry = "dist/types/py_aep/index.d.ts";
const refs = fs
  .readdirSync("dist/types/types")
  .map((f) => `/// <reference path="../types/${f}" />`)
  .join("\n");
fs.writeFileSync(entry, `${refs}\n${fs.readFileSync(entry, "utf8")}`);

console.log(`dist/index.js + dist/types (${rewritten} declaration files rewritten to .js specifiers)`);
