// Build the published package: dist/index.js (Node, Bun), dist/browser.js
// (bundled hosts, which import fontkit/yaml up front) and dist/svg.js, sharing one chunk, with
// dependencies external, + dist/types (declarations from tsc, `.ts` specifiers -> `.js`).
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

import * as esbuild from "esbuild";

fs.rmSync("dist", { recursive: true, force: true });

// esbuild, not Bun.build: Bun renames the classes a shared chunk exports
// (`ValueError2`), and the library prints constructor names.
const out = await esbuild.build({
  entryPoints: ["src/py_aep/index.ts", "src/py_aep/browser.ts", "src/py_aep/svg.ts"],
  outdir: "dist",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "neutral",
  packages: "external",
  keepNames: true,
  sourcemap: "linked",
  logLevel: "warning",
});
if (out.errors.length > 0) process.exit(1);

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
// Ambient declarations for untyped dependencies ship with the types; fontkit's
// stays source-only, as consumers may declare fontkit themselves.
fs.mkdirSync("dist/types/types", { recursive: true });
for (const f of fs.readdirSync("src/types").filter((f) => f !== "fontkit.d.ts")) {
  const src = fs.readFileSync(path.join("src/types", f), "utf8");
  fs.writeFileSync(
    path.join("dist/types/types", f),
    src.replace(/(import\(\s*)(["'])(\.{1,2}\/[^"']+)\.ts\2/g, (_, pre, q, spec) => `${pre}${q}${spec}.js${q}`),
  );
}
const refs = fs
  .readdirSync("dist/types/types")
  .map((f) => `/// <reference path="../types/${f}" />`)
  .join("\n");
for (const entry of ["dist/types/py_aep/index.d.ts", "dist/types/py_aep/svg.d.ts"]) {
  fs.writeFileSync(entry, `${refs}\n${fs.readFileSync(entry, "utf8")}`);
}

console.log(`dist/index.js + dist/types (${rewritten} declaration files rewritten to .js specifiers)`);
