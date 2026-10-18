// Strict-mode diagnostics for given files (whole program is checked, only these files are printed).
// usage: bun tools/strict_file.ts <file...>
import ts from "typescript";
import * as path from "node:path";
const ROOT = path.resolve(import.meta.dir, "..");
const want = new Set(process.argv.slice(2).map((f) => path.resolve(f)));
const cfg = ts.getParsedCommandLineOfConfigFile(
  path.join(ROOT, "tsconfig.json"),
  {},
  { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
)!;
const program = ts.createProgram(cfg.fileNames, { ...cfg.options, strict: true, noImplicitAny: true });
let n = 0;
for (const sf of program.getSourceFiles()) {
  if (!want.has(path.resolve(sf.fileName))) continue;
  for (const d of ts.getPreEmitDiagnostics(program, sf).filter((d) => d.file === sf)) {
    n++;
    const { line } = sf.getLineAndCharacterOfPosition(d.start ?? 0);
    console.log(
      `${path.relative(ROOT, sf.fileName)}:${line + 1} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`,
    );
  }
}
console.log(JSON.stringify({ files: want.size, strict_errors: n }));
