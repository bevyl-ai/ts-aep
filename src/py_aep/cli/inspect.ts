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
import { ByteStream, Path, at, getOrThrow, literal, compare } from "../../pyrt/index.ts";
import { intOption, parseCommandLine, runMain, usageError, type Command } from "./args.ts";

export function print(text: string): void {
  console.log(text);
}

// ── Tree display ────────────────────────────────────────────────────────────

/** Return size or value detail for a leaf chunk. */
export function _chunkDetail(chunk: Chunk): string {
  const val = "value" in chunk ? chunk.value : null;
  if (val != null) {
    let v = literal(val);
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
  const fp = new ByteStream(path.readBytes());
  const [rifx, _] = readAep(fp);

  let fold: ListChunk | null = null;
  for (const c of rifx.chunks) {
    if (c instanceof ListChunk && c.listType === "Fold") {
      fold = c;
      break;
    }
  }
  if (fold == null) {
    console.error("ERROR: No LIST:Fold found");
    return 1;
  }

  const items = filterByListType(fold.chunks, "Item");
  if (index >= items.length) {
    console.error(`ERROR: Item[${index}] out of range (only ${items.length} items)`);
    return 1;
  }

  // Python `items[index]` accepts negative indexes; `at` keeps that and raises IndexError.
  const item = at(items, index);
  print(`=== ${path.name} Item[${index}] (${item.chunks.length} children) ===`);
  for (const [i, c] of item.chunks.entries()) {
    const label = chunkLabel(c);
    if (c instanceof ListChunk) {
      print(`  [${String(i).padStart(2)}] ${label} (${c.chunks.length} children)`);
      for (const [j, cc] of c.chunks.entries()) {
        const cl = chunkLabel(cc);
        if (cc instanceof ListChunk) {
          print(`    [${String(j).padStart(2)}] ${cl} (${cc.chunks.length} children)`);
        } else {
          const detail = _chunkDetail(cc);
          print(`    [${String(j).padStart(2)}] ${cl} (${detail})`);
        }
      }
    } else {
      const detail = _chunkDetail(c);
      print(`  [${String(i).padStart(2)}] ${label} (${detail})`);
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
  const fp = new ByteStream(path.readBytes());
  const [rifx, _] = readAep(fp);

  let fold: ListChunk | null = null;
  for (const c of rifx.chunks) {
    if (c instanceof ListChunk && c.listType === "Fold") {
      fold = c;
      break;
    }
  }
  if (fold == null) {
    console.error("No LIST:Fold found");
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
  const fp = new ByteStream(path.readBytes());
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
    const matches = [...chunks.keys()].sort(compare).filter((p) => p.includes(chunkPath));
    if (matches.length === 0) {
      console.error(`Chunk path not found: ${chunkPath}`);
      console.error("\nAvailable leaf chunk paths:");
      for (const p of [...chunks.keys()].sort(compare)) {
        console.error(`  ${p} (${getOrThrow(chunks, p).length}B)`);
      }
      return 1;
    }
    if (matches.length === 1) {
      chunkPath = matches[0];
    } else {
      console.error(`Ambiguous chunk path '${chunkPath}'. Matches:`);
      for (const m of matches) {
        console.error(`  ${m} (${getOrThrow(chunks, m).length}B)`);
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

const INSPECT: Command = {
  prog: "aep-inspect",
  usage: `usage: aep-inspect [-h] [--tree] [--depth N] [--item N] [--list] [--dump PATH]
                   file`,
  help: `usage: aep-inspect [-h] [--tree] [--depth N] [--item N] [--list] [--dump PATH]
                   file

Inspect After Effects project file (.aep) structure.

positional arguments:
  file         AEP file to inspect

options:
  -h, --help   show this help message and exit
  --tree       Print full chunk tree
  --depth N    Max tree depth (-1 for unlimited, use with --tree)
  --item N     Inspect Item[N] (0-based) in LIST:Fold
  --list       List all chunk paths and sizes
  --dump PATH  Hex-dump a specific chunk (e.g. "LIST:Fold/ftts")

Examples:
    aep-inspect file.aep                        (item summary)
    aep-inspect file.aep --tree                 (full chunk tree)
    aep-inspect file.aep --tree --depth 3       (limited depth)
    aep-inspect file.aep --item 6               (inspect Item[6])
    aep-inspect file.aep --list                 (chunk paths + sizes)
    aep-inspect file.aep --dump "LIST:Fold/ftts"(hex dump)
`,
  options: {
    tree: { type: "boolean" },
    depth: { type: "string" },
    item: { type: "string" },
    list: { type: "boolean" },
    dump: { type: "string" },
  },
};

export function main(argv: string[] = process.argv.slice(2)): number {
  const { values, positionals } = parseCommandLine(INSPECT, argv);
  if (positionals.length !== 1)
    usageError(
      INSPECT,
      positionals.length
        ? `unrecognized arguments: ${positionals.slice(1).join(" ")}`
        : "the following arguments are required: file",
    );
  const args = {
    tree: values.tree === true,
    depth: typeof values.depth === "string" ? intOption(INSPECT, "depth", values.depth) : -1,
    item: typeof values.item === "string" ? intOption(INSPECT, "item", values.item) : null,
    list: values.list === true,
    dump: typeof values.dump === "string" ? values.dump : null,
  };
  const path = new Path(positionals[0]);

  if (!path.exists()) {
    console.error(`Error: File not found: ${path}`);
    return 1;
  }

  if (args.tree) {
    const fp = new ByteStream(path.readBytes());
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

if (import.meta.main) runMain(main);
