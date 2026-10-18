// Parse every /** */ comment under src/py_aep with Microsoft's TSDoc parser and
// count syntax messages. usage: bun tools/tsdoc_lint.ts [--rev <git-rev>] [--list]
import { TSDocParser, TSDocConfiguration } from "@microsoft/tsdoc";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dir, "..");
const rev = process.argv.includes("--rev") ? process.argv[process.argv.indexOf("--rev") + 1] : null;
const LIST = process.argv.includes("--list");
const parser = new TSDocParser(new TSDocConfiguration());
const files = rev
  ? execFileSync("git", ["ls-tree", "-r", "--name-only", rev, "src/py_aep"], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter((f) => f.endsWith(".ts"))
  : (fs.readdirSync(path.join(ROOT, "src/py_aep"), { recursive: true }) as string[])
      .filter((f) => f.endsWith(".ts"))
      .map((f) => `src/py_aep/${f}`);
const counts = new Map<string, number>();
let comments = 0;
for (const f of files) {
  const text = rev
    ? execFileSync("git", ["show", `${rev}:${f}`], { cwd: ROOT, encoding: "utf8" })
    : fs.readFileSync(path.join(ROOT, f), "utf8");
  for (const m of text.matchAll(/\/\*\*[\s\S]*?\*\//g)) {
    comments++;
    for (const msg of parser.parseString(m[0]).log.messages) {
      counts.set(msg.messageId, (counts.get(msg.messageId) ?? 0) + 1);
      if (LIST)
        console.log(`${f}:${text.slice(0, m.index).split("\n").length} ${msg.messageId} ${msg.unformattedText}`);
    }
  }
}
const total = [...counts.values()].reduce((a, b) => a + b, 0);
console.log(
  JSON.stringify({
    rev: rev ?? "worktree",
    comments,
    messages: total,
    by_id: Object.fromEntries([...counts].sort((a, b) => b[1] - a[1])),
  }),
);
