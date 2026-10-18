/**
 * AEP File Inspection Tool.
 *
 * Inspect After Effects project files (.aep) structure:
 * - Item summary with children types and counts
 * - Full chunk tree visualization
 * - Detailed item children inspection
 * - Chunk path listing with sizes
 * - Hex dump of specific chunks
 *
 * Modes:
 *     Default:  aep-inspect file.aep              (item summary)
 *     Tree:     aep-inspect file.aep --tree        (full chunk tree)
 *     Item:     aep-inspect file.aep --item 6      (inspect Item[6])
 *     List:     aep-inspect file.aep --list        (chunk paths + sizes)
 *     Dump:     aep-inspect file.aep --dump "path" (hex dump)
 */

// Python's `from ..binary.chunk import ...` runs py_aep/__init__ first, which
// loads every module. Standalone CLI runs need the same.
import "../index.ts";
import { ListChunk, readAep } from "../binary/chunk.ts";
import type { Chunk } from "../binary/chunk.ts";
import { filterByListType } from "../binary/utils.ts";
import { chunkLabel, extractLeafChunks, formatHexDump, walkChunks } from "./_chunk_helpers.ts";
import {
  BytesIO,
  Path,
  ValueError,
  at,
  format,
  getOrThrow,
  int,
  repr,
  sorted,
  str,
} from "../../pyrt/index.ts";

export const sys = { stderr: process.stderr };
export function print(text: string, kw: { file?: typeof sys.stderr } = {}): void {
  if (kw.file === sys.stderr) console.error(text);
  else console.log(text);
}

// ── Tree display ────────────────────────────────────────────────────────────


/** Return size or value detail for a leaf chunk. */
export function _chunkDetail(chunk: Chunk): string {
  const val = "value" in chunk ? chunk.value : null;
  if (val != null) {
    let v = repr(val);
    // Python len() and slicing count code points, not UTF-16 units.
    const cps = Array.from(v);
    if (cps.length > 60) v = cps.slice(0, 57).join("") + "...";
    return `value=${v}`;
  }
  const data = chunk?.data ?? null;
  if (data != null) return `${data.length}B`;
  return "";
}

/**
 * Print a chunk tree with types and sizes.
 *
 * @param chunk - Root chunk to print.
 * @param depth - Current depth (for indentation).
 * @param maxDepth - Maximum depth to recurse (-1 for unlimited).
 */
export function printTree(chunk: Chunk, depth: number = 0, maxDepth: number = -1): void {
  if (maxDepth >= 0 && depth > maxDepth) return;
  const label = chunkLabel(chunk);
  if (chunk instanceof ListChunk) {
    const n = chunk.chunks.length;
    print(`${"  ".repeat(depth)}${label} (${n} children)`);
    for (const c of chunk.chunks) printTree(c, depth + 1, maxDepth);
  } else {
    const detail = _chunkDetail(chunk);
    print(`${"  ".repeat(depth)}${label} (${detail})`);
  }
}

// ── Item inspection ─────────────────────────────────────────────────────────

/**
 * Show detailed children of a specific Item by 0-based index.
 *
 * @param path - Path to the `.aep` file.
 * @param index - 0-based item index within `LIST:Fold`.
 * @returns Exit code (0 on success, 1 on error).
 */
export function _inspectItem(path: Path, index: number): number {
  const fp = new BytesIO(path.readBytes());
  const [rifx, _] = readAep(fp);

  let fold: ListChunk | null = null;
  for (const c of rifx.chunks) {
    if (c instanceof ListChunk && c.listType === "Fold") {
      fold = c;
      break;
    }
  }
  if (fold == null) {
    print("ERROR: No LIST:Fold found", { file: sys.stderr });
    return 1;
  }

  const items = filterByListType(fold.chunks, "Item");
  if (index >= items.length) {
    print(`ERROR: Item[${index}] out of range (only ${items.length} items)`, { file: sys.stderr });
    return 1;
  }

  // Python `items[index]` accepts negative indexes; `at` keeps that and raises IndexError.
  const item = at(items, index);
  print(`=== ${path.name} Item[${index}] (${item.chunks.length} children) ===`);
  for (const [i, c] of item.chunks.entries()) {
    const label = chunkLabel(c);
    if (c instanceof ListChunk) {
      print(`  [${format(i, "2d")}] ${label} (${c.chunks.length} children)`);
      for (const [j, cc] of c.chunks.entries()) {
        const cl = chunkLabel(cc);
        if (cc instanceof ListChunk) {
          print(`    [${format(j, "2d")}] ${cl} (${cc.chunks.length} children)`);
        } else {
          const detail = _chunkDetail(cc);
          print(`    [${format(j, "2d")}] ${cl} (${detail})`);
        }
      }
    } else {
      const detail = _chunkDetail(c);
      print(`  [${format(i, "2d")}] ${label} (${detail})`);
    }
  }
  return 0;
}

// ── Item summary ────────────────────────────────────────────────────────────

/**
 * Show item summary with children types for each item in Fold.
 *
 * @param path - Path to the `.aep` file.
 * @returns Exit code.
 */
export function _itemSummary(path: Path): number {
  const fp = new BytesIO(path.readBytes());
  const [rifx, _] = readAep(fp);

  let fold: ListChunk | null = null;
  for (const c of rifx.chunks) {
    if (c instanceof ListChunk && c.listType === "Fold") {
      fold = c;
      break;
    }
  }
  if (fold == null) {
    print("No LIST:Fold found", { file: sys.stderr });
    return 1;
  }

  const items = filterByListType(fold.chunks, "Item");
  print(`${path.name}: ${items.length} items in Fold`);
  for (const [i, item] of items.entries()) {
    const children = item.chunks.map((c) => chunkLabel(c));
    print(`  Item[${i}]: ${children.length} children - ${children.join(", ")}`);
  }
  return 0;
}

// ── Chunk listing ───────────────────────────────────────────────────────────

/**
 * Print a tree of all chunk paths and sizes in an AEP file.
 *
 * @param path - Path to the `.aep` file.
 * @returns Exit code.
 */
export function _listChunks(path: Path): number {
  const fp = new BytesIO(path.readBytes());
  const [rifx, _xmp] = readAep(fp);

  print(`\nChunk tree: ${path.name}\n`);
  for (const [_path, identifier, size, depth, isList] of walkChunks(rifx.chunks)) {
    const indent = "  ".repeat(depth);
    if (isList) {
      print(`${indent}${identifier}/`);
    } else {
      print(`${indent}${identifier} (${size}B)`);
    }
  }
  return 0;
}

// ── Hex dump ────────────────────────────────────────────────────────────────

/**
 * Hex-dump a specific chunk from an AEP file.
 *
 * If the path does not match exactly, a partial (substring) match is
 * attempted. Prints available paths on failure.
 *
 * @param path - Path to the `.aep` file.
 * @param chunkPath - Full or partial chunk path (e.g. `LIST:Fold/ftts`).
 * @returns Exit code.
 */
export function _dumpChunk(path: Path, chunkPath: string): number {
  const chunks = extractLeafChunks(path);

  if (!chunks.has(chunkPath)) {
    const matches = sorted(chunks.keys()).filter((p) => p.includes(chunkPath));
    if (matches.length === 0) {
      print(`Chunk path not found: ${chunkPath}`, { file: sys.stderr });
      print("\nAvailable leaf chunk paths:", { file: sys.stderr });
      for (const p of sorted(chunks.keys())) {
        print(`  ${p} (${getOrThrow(chunks, p).length}B)`, { file: sys.stderr });
      }
      return 1;
    }
    if (matches.length === 1) {
      chunkPath = matches[0];
    } else {
      print(`Ambiguous chunk path '${chunkPath}'. Matches:`, { file: sys.stderr });
      for (const m of matches) {
        print(`  ${m} (${getOrThrow(chunks, m).length}B)`, { file: sys.stderr });
      }
      return 1;
    }
  }

  const data = getOrThrow(chunks, chunkPath);
  print(`\n[${chunkPath}] (${data.length} bytes)\n`);
  print(formatHexDump(data));
  return 0;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

// TODO(port): no argparse shim; this subset covers what main() declares (one positional,
// store_true flags, typed value options, long-option prefixes, exit status 2 on error). Help and
// usage follow argparse's layout for its default 80-column (non-tty) width only (argparse wraps to
// COLUMNS or the terminal width), `--help=x` is "unrecognized" rather than "ignored explicit
// argument", and an unrecognized option errors before missing positionals are reported.
export const NEGATIVE_NUMBER = /^-\d+$|^-\d*\.\d+$/;

/** A parsed-argument value: what an argument converter returns or defaults to
 * (`aep-inspect` arguments parse to a string, an int, a boolean or a Path). */
export type ArgValue = string | number | boolean | null | Path;

export type ArgSpec = {
  dest: string;
  flag: string | null;
  positional: boolean;
  storeTrue: boolean;
  type_: ((s: string) => ArgValue) | null;
  default_: ArgValue;
  metavar: string | null;
  help: string;
};

export type ArgumentOptions = {
  action?: string;
  type?: (s: string) => ArgValue;
  default?: ArgValue;
  metavar?: string;
  help?: string;
};

/** argparse's `Namespace`: dest name to parsed value. */
export type Namespace = Record<string, ArgValue>;

/**
 * `T` is the namespace of one command (`InspectArgs`): the `parseArgs`
 * result, whose keys and value types the `addArgument` calls declare at
 * runtime.
 */
export class ArgumentParser<T extends Namespace = Namespace> {
  private readonly prog: string;
  private readonly description: string;
  private readonly epilog: string;
  private readonly specs: ArgSpec[] = [];

  constructor(kwargs: { prog?: string; description?: string; epilog?: string; formatterClass?: string } = {}) {
    this.prog = kwargs.prog ?? "";
    this.description = kwargs.description ?? "";
    this.epilog = kwargs.epilog ?? "";
  }

  addArgument(name: string, kwargs: ArgumentOptions = {}): void {
    const positional = !name.startsWith("-");
    const storeTrue = kwargs.action === "storeTrue";
    this.specs.push({
      dest: positional ? name : name.replace(/^--/, "").replace(/-/g, "_"),
      flag: positional ? null : name,
      positional,
      storeTrue: storeTrue,
      type_: kwargs.type ?? null,
      default_: kwargs.default ?? (storeTrue ? false : null),
      metavar: kwargs.metavar ?? null,
      help: kwargs.help ?? "",
    });
  }

  error(message: string): never {
    print(this.formatUsage(), { file: sys.stderr });
    print(`${this.prog}: error: ${message}`, { file: sys.stderr });
    process.exit(2);
  }

  /** argparse's usage at its default 78-column width: wrapped options, then positionals. */
  formatUsage(): string {
    const width = 78;
    const prefix = "usage: ";
    const optParts = [
      "[-h]",
      ...this.specs
        .filter((s) => !s.positional)
        .map((s) => (s.storeTrue ? `[${s.flag}]` : `[${s.flag} ${s.metavar ?? s.dest.toUpperCase()}]`)),
    ];
    const posParts = this.specs.filter((s) => s.positional).map((s) => s.dest);
    const oneLine = [this.prog, ...optParts, ...posParts].join(" ");
    if (prefix.length + oneLine.length <= width) return prefix + oneLine;
    // HelpFormatter._format_usage's get_lines, with the parts indented under the prog.
    const indent = " ".repeat(prefix.length + this.prog.length + 1);
    const getLines = (parts: string[], firstLen: number | null): string[] => {
      const lines: string[] = [];
      let line: string[] = [];
      let lineLen = firstLen ?? indent.length - 1;
      for (const part of parts) {
        if (lineLen + 1 + part.length > width && line.length) {
          lines.push(indent + line.join(" "));
          line = [];
          lineLen = indent.length - 1;
        }
        line.push(part);
        lineLen += part.length + 1;
      }
      if (line.length) lines.push(indent + line.join(" "));
      if (firstLen !== null) lines[0] = lines[0].slice(indent.length);
      return lines;
    };
    const lines = [...getLines([this.prog, ...optParts], prefix.length - 1), ...getLines(posParts, null)];
    return prefix + lines.join("\n");
  }

  /** argparse's help: each invocation padded to the help column (help texts fit the width). */
  formatHelp(): string {
    const invocation = (s: ArgSpec): string =>
      s.positional ? s.dest : s.storeTrue ? (s.flag ?? "") : `${s.flag} ${s.metavar ?? s.dest.toUpperCase()}`;
    const rows: [string, string][] = [["-h, --help", "show this help message and exit"]];
    for (const s of this.specs) if (!s.positional) rows.push([invocation(s), s.help]);
    const positionals: [string, string][] = this.specs.filter((s) => s.positional).map((s) => [invocation(s), s.help]);
    const helpPosition = Math.min(Math.max(...[...rows, ...positionals].map(([inv]) => inv.length + 2)) + 2, 24);
    const row = ([inv, help]: [string, string]): string =>
      inv.length + 2 <= helpPosition - 2 ? `  ${inv.padEnd(helpPosition - 4)}  ${help}` : `  ${inv}\n${" ".repeat(helpPosition)}${help}`;
    const lines = [this.formatUsage(), "", this.description, "", "positional arguments:", ...positionals.map(row)];
    lines.push("", "options:", ...rows.map(row));
    return lines.join("\n") + "\n" + this.epilog.replaceAll("%(prog)s", this.prog);
  }

  /** argparse's allow_abbrev: an unambiguous prefix of a long option names it. */
  resolve(arg: string, name: string): string {
    const flags = ["--help", ...this.specs.filter((s) => !s.positional).map((s) => s.flag ?? "")];
    if (!name.startsWith("--") || flags.includes(name)) return name;
    const hits = flags.filter((f) => f.startsWith(name));
    if (hits.length > 1) this.error(`ambiguous option: ${arg} could match ${hits.join(", ")}`);
    return hits.length === 1 ? hits[0] : name;
  }

  parseArgs(argv?: string[]): T;
  parseArgs(argv: string[] = process.argv.slice(2)): Namespace {
    const out: Namespace = {};
    for (const s of this.specs) out[s.dest] = s.default_;
    const rest: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      const eq = a.indexOf("=");
      const name = this.resolve(a, a.startsWith("--") && eq >= 0 ? a.slice(0, eq) : a);
      if (name === "-h" || (name === "--help" && eq < 0)) {
        print(this.formatHelp());
        process.exit(0);
      }
      const spec = this.specs.find((s) => !s.positional && s.flag === name);
      if (spec == null) {
        if (a.startsWith("-") && a !== "-" && !NEGATIVE_NUMBER.test(a)) this.error(`unrecognized arguments: ${a}`);
        rest.push(a);
        continue;
      }
      if (spec.storeTrue) {
        if (eq >= 0) this.error(`argument ${spec.flag}: ignored explicit argument ${repr(a.slice(eq + 1))}`);
        out[spec.dest] = true;
        continue;
      }
      let value: string;
      if (eq >= 0 && a.startsWith("--")) {
        value = a.slice(eq + 1);
      } else if (i + 1 < argv.length && (!argv[i + 1].startsWith("-") || NEGATIVE_NUMBER.test(argv[i + 1]))) {
        value = argv[++i];
      } else {
        this.error(`argument ${spec.flag}: expected one argument`);
      }
      if (spec.type_ == null) {
        out[spec.dest] = value;
      } else {
        try {
          out[spec.dest] = spec.type_(value);
        } catch (e) {
          if (!(e instanceof ValueError)) throw e;
          this.error(`argument ${spec.flag}: invalid ${spec.type_.name} value: ${repr(value)}`);
        }
      }
    }

    const positionals = this.specs.filter((s) => s.positional);
    if (rest.length < positionals.length) {
      const missing = positionals.slice(rest.length).map((s) => s.dest);
      this.error(`the following arguments are required: ${missing.join(", ")}`);
    }
    if (rest.length > positionals.length) {
      this.error(`unrecognized arguments: ${rest.slice(positionals.length).join(" ")}`);
    }
    for (let k = 0; k < positionals.length; k++) {
      const s = positionals[k];
      out[s.dest] = s.type_ == null ? rest[k] : s.type_(rest[k]);
    }
    return out;
  }
}

export const argparse = { ArgumentParser, RawDescriptionHelpFormatter: "RawDescriptionHelpFormatter" };

/** CLI entry point for aep-inspect command. */
export function main(): number {
  // The argparse Namespace of this subcommand (one type per subcommand,
  // declared where its arguments are): `file` is the positional the
  // `(s: string) => new Path(s)` converter produces; `--depth`/`--item` parse
  // via `int` (defaults -1/null), `--dump` via `str` (default null), and
  // `--tree`/`--list` are store_true flags (default false).
  type InspectArgs = {
    file: Path;
    tree: boolean;
    depth: number;
    item: number | null;
    list: boolean;
    dump: string | null;
  };
  const parser = new argparse.ArgumentParser<InspectArgs>({
    prog: "aep-inspect",
    description: "Inspect After Effects project file (.aep) structure.",
    formatterClass: argparse.RawDescriptionHelpFormatter,
    epilog: [
      "",
      "Examples:",
      "    %(prog)s file.aep                        (item summary)",
      "    %(prog)s file.aep --tree                 (full chunk tree)",
      "    %(prog)s file.aep --tree --depth 3       (limited depth)",
      "    %(prog)s file.aep --item 6               (inspect Item[6])",
      "    %(prog)s file.aep --list                 (chunk paths + sizes)",
      '    %(prog)s file.aep --dump "LIST:Fold/ftts"(hex dump)',
      "        ",
    ].join("\n"),
  });
  parser.addArgument("file", { type: (s: string) => new Path(s), help: "AEP file to inspect" });
  parser.addArgument("--tree", { action: "storeTrue", help: "Print full chunk tree" });
  parser.addArgument("--depth", {
    type: int,
    default: -1,
    metavar: "N",
    help: "Max tree depth (-1 for unlimited, use with --tree)",
  });
  parser.addArgument("--item", {
    type: int,
    default: null,
    metavar: "N",
    help: "Inspect Item[N] (0-based) in LIST:Fold",
  });
  parser.addArgument("--list", { action: "storeTrue", help: "List all chunk paths and sizes" });
  parser.addArgument("--dump", {
    type: str,
    default: null,
    metavar: "PATH",
    help: 'Hex-dump a specific chunk (e.g. "LIST:Fold/ftts")',
  });

  const args = parser.parseArgs();
  const path: Path = args.file;

  if (!path.exists()) {
    print(`Error: File not found: ${path}`, { file: sys.stderr });
    return 1;
  }

  if (args.tree) {
    const fp = new BytesIO(path.readBytes());
    const [rifx, _] = readAep(fp);
    printTree(rifx, undefined, args.depth);
    return 0;
  }

  if (args.item != null) {
    return _inspectItem(path, args.item);
  }

  if (args.list) {
    return _listChunks(path);
  }

  if (args.dump != null) {
    return _dumpChunk(path, args.dump);
  }

  // Default: item summary
  return _itemSummary(path);
}

// Python's `if __name__ == "__main__": sys.exit(main())`.
if (import.meta.main) process.exit(main());
