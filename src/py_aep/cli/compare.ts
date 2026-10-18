/**
 * AEP File Comparison Tool.
 *
 * Compares After Effects project files (.aep) and reports differences
 * at both the byte level and the structural level:
 * - Byte-level: chunk path, byte position, hex values, bit position
 * - Structural: child count mismatches between containers
 *
 * Modes:
 *     Compare:  aep-compare file1.aep file2.aep
 *     Multi:    aep-compare ref.aep v1.aep v2.aep v3.aep
 *
 * For single-file inspection (tree, dump, list), use `aep-inspect`.
 */

// Python's `from ..binary.chunk import ...` runs py_aep/__init__ first, which
// loads every module. Standalone CLI runs need the same.
import "../index.ts";
import { ListChunk, readAep } from "../binary/chunk.ts";
import type { Chunk } from "../binary/chunk.ts";
import { LdatChunk } from "../binary/ldat_chunks.ts";
import { ShphChunk } from "../binary/misc_chunks.ts";
import { CdatChunk } from "../binary/property_chunks.ts";
import { Utf8Chunk } from "../binary/scalar_chunks.ts";
import { chunkLabel, extractLeafChunks, extractLeafChunksTyped } from "./_chunk_helpers.ts";
import {
  BytesIO,
  Path,
  ValueError,
  b,
  bytesEq,
  deepcopy,
  float,
  format,
  getattr,
  getitem,
  int,
  max,
  pyBool,
  pyEq,
  repr,
  sorted,
  str,
  sum,
  SystemExit,
  jsonDumps,
} from "../../pyrt/index.ts";

export function print(...args: string[]): void {
  console.log(args.join(" "));
}

export function eprint(message: string): void {
  console.error(message);
}

// NOTE(port): int.bit_length(); exact for the integer inputs (xor of two bytes) used here.
export function bitLength(n: number): number {
  return n === 0 ? 0 : Math.abs(n).toString(2).length;
}

// NOTE(port): f"{x:08b}" including Python's sign-inside-width rule for negatives; pyrt format() lacks `b`.
export function bin8(x: number): string {
  const sign = x < 0 ? "-" : "";
  return sign + Math.abs(x).toString(2).padStart(8 - sign.length, "0");
}

// ── Dataclasses ─────────────────────────────────────────────────────────────

/**
 * Sentinel used in {@link ByteDifference} when one chunk is shorter
 * than the other and a byte position doesn't exist. 
 */
export const MISSING_BYTE = -1;

/** Represents a single byte difference between two files. */
export class ByteDifference {
  path: string;
  offset: number;
  byte1: number;
  byte2: number;
  /** 7 to 0 from left to right, null if multiple bits differ */
  bitPosition: number | null;

  constructor(path: string, offset: number, byte1: number, byte2: number, bitPosition: number | null = null) {
    this.path = path;
    this.offset = offset;
    this.byte1 = byte1;
    this.byte2 = byte2;
    this.bitPosition = bitPosition;
    this.__post_init__();
  }

  /** Calculate bit position if only one bit differs. */
  __post_init__(): void {
    const xor = this.byte1 ^ this.byte2;
    if (xor !== 0 && (xor & (xor - 1)) === 0) {
      // Check if only one bit is set
      this.bitPosition = 7 - (bitLength(xor) - 1);
    }
  }

  /** Format the difference for display. */
  formatDiff(): string {
    const bitInfo = this.bitPosition != null ? `, bit ${this.bitPosition}` : "";
    return (
      `  Offset ${format(this.offset, "4d")} (0x${format(this.offset, "04X")}): ` +
      `0x${format(this.byte1, "02X")} (${bin8(this.byte1)}) vs ` +
      `0x${format(this.byte2, "02X")} (${bin8(this.byte2)})${bitInfo}`
    );
  }
}

/** Represents all differences within a specific chunk/element. */
export class ChunkDifference {
  path: string;
  byteDiffs: ByteDifference[];
  size1: number;
  size2: number;

  constructor(path: string, byteDiffs: ByteDifference[], size1: number, size2: number) {
    this.path = path;
    this.byteDiffs = byteDiffs;
    this.size1 = size1;
    this.size2 = size2;
  }

  /** Check if the chunks have different sizes. */
  hasSizeDifference(): boolean {
    return this.size1 !== this.size2;
  }
}

/** A byte offset where files differ, with values from all files. */
export class MultiFileDifference {
  path: string;
  offset: number;
  /** Byte value per file. `-1` if the chunk is missing in that file. */
  values: number[];
  bitPosition: number | null;

  constructor(path: string, offset: number, values: number[], bitPosition: number | null = null) {
    this.path = path;
    this.offset = offset;
    this.values = values;
    this.bitPosition = bitPosition;
    this.__post_init__();
  }

  /** Calculate bit position if exactly two distinct non-missing values
   * differ by one bit. */
  __post_init__(): void {
    const distinct = new Set(this.values.filter((v) => v !== MISSING_BYTE));
    if (distinct.size === 2) {
      const [a, b_] = sorted(distinct);
      const xor = a ^ b_;
      if (xor !== 0 && (xor & (xor - 1)) === 0) {
        this.bitPosition = 7 - (bitLength(xor) - 1);
      }
    }
  }
}

/** All differences within a chunk across multiple files. */
export class MultiChunkDifference {
  path: string;
  diffs: MultiFileDifference[];
  /** Chunk size per file. `0` if missing. */
  sizes: number[];

  constructor(path: string, diffs: MultiFileDifference[], sizes: number[] = []) {
    this.path = path;
    this.diffs = diffs;
    this.sizes = sizes;
  }
}

// ── Binary comparison ───────────────────────────────────────────────────────

/** Compare two byte sequences and yield differences. */
export function* compareBinaryData(data1: Uint8Array, data2: Uint8Array, path: string): Generator<ByteDifference> {
  const minLen = Math.min(data1.length, data2.length);

  // Compare common bytes
  for (let i = 0; i < minLen; i++) {
    if (data1[i] !== data2[i]) {
      yield new ByteDifference(path, i, data1[i], data2[i]);
    }
  }

  // Report extra bytes in longer sequence
  if (data1.length > minLen) {
    for (let i = minLen; i < data1.length; i++) {
      yield new ByteDifference(path, i, data1[i], MISSING_BYTE); // byte doesn't exist in file 2
    }
  } else if (data2.length > minLen) {
    for (let i = minLen; i < data2.length; i++) {
      yield new ByteDifference(path, i, MISSING_BYTE, data2[i]); // byte doesn't exist in file 1
    }
  }
}

// ── Float-tolerant comparison ───────────────────────────────────────────────

/**
 * Default tolerances: floats differing by at most this (relative or
 * absolute) are treated as equal. AE and py_aep encode the same coordinate
 * through different float32/float64 rounding, so tiny deltas are noise.
 */
export const FLOAT_REL_TOL = 1e-4;
export const FLOAT_ABS_TOL = 1e-3;

export function _floatsClose(a: number, b_: number): boolean {
  return Math.abs(a - b_) <= max([FLOAT_ABS_TOL, FLOAT_REL_TOL * max([Math.abs(a), Math.abs(b_)])]);
}

/**
 * Return a chunk's coordinate float fields, or None if it has none.
 *
 * Covers the float-bearing leaf chunks whose values AE and py_aep may
 * encode with slightly different rounding: `cdat` (doubles), `shph`
 * (bounding-box f4), and `ldat` shape-point lists (f4 x/y).
 */
export function _chunkFloats(chunk: Chunk): number[] | null {
  const ct = getattr(chunk, "chunk_type", null);
  if (ct === "cdat" && chunk instanceof CdatChunk) {
    const values = [...chunk.values];
    return values.length > 0 ? values : null;
  }
  if (ct === "shph" && chunk instanceof ShphChunk) {
    return [chunk.top_left_x, chunk.top_left_y, chunk.bottom_right_x, chunk.bottom_right_y];
  }
  if (ct === "ldat" && chunk instanceof LdatChunk) {
    const items = chunk.items;
    if (pyBool(items) && items.every((i: { x: number; y: number }) => "x" in i && "y" in i)) {
      return items.flatMap((i: { x: number; y: number }) => [i.x, i.y]);
    }
  }
  return null;
}

/** Return a copy of `chunk` with its coordinate floats replaced. */
export function _withFloats(chunk: Chunk, floats: number[]): Chunk {
  const clone = deepcopy(chunk);
  const ct = clone.chunk_type;
  if (ct === "cdat" && clone instanceof CdatChunk) {
    clone.values = [...floats];
  } else if (ct === "shph" && clone instanceof ShphChunk) {
    [clone.top_left_x, clone.top_left_y, clone.bottom_right_x, clone.bottom_right_y] = floats;
  } else if (ct === "ldat" && clone instanceof LdatChunk) {
    for (const [idx, item] of clone.items.entries()) {
      item.x = floats[2 * idx];
      item.y = floats[2 * idx + 1];
    }
  }
  return clone;
}

export const _FLOAT_TAG_RE = /<float>([^<]*)<\/float>/g;

/**
 * True when two AE `prop.map` XML strings (gradient color data) differ
 * ONLY in their `<float>` values within tolerance.
 *
 * Gradient colors/offsets are stored as text floats inside a `Utf8`
 * chunk, so the numeric tolerance applied to cdat/shph/ldat cannot reach
 * them; AE and py_aep round an 8-bit colour to adjacent float32 values.
 */
export function _gradientXmlOnlyFloatDiff(s1: string | String, s2: string | String): boolean {
  // `_NulTailStr` (a str subclass) arrives as a String object.
  if (!(typeof s1 === "string" || s1 instanceof String) || !(typeof s2 === "string" || s2 instanceof String)) return false;
  s1 = String(s1);
  s2 = String(s2);
  if (!s1.includes("<prop.map") || !s1.includes("<float>")) return false;
  const f1 = Array.from(s1.matchAll(_FLOAT_TAG_RE), (m) => m[1]);
  const f2 = Array.from(s2.matchAll(_FLOAT_TAG_RE), (m) => m[1]);
  if (f1.length !== f2.length) return false;
  // Everything except the float values must be byte-identical.
  if (s1.replace(_FLOAT_TAG_RE, "<float/>") !== s2.replace(_FLOAT_TAG_RE, "<float/>")) return false;
  for (let i = 0; i < f1.length; i++) {
    const a = f1[i];
    const b_ = f2[i];
    // `<float>` content is normally numeric in AE's prop.map output; an
    // empty/non-numeric tag is not a pure float-precision diff (and must
    // not crash the comparison), so treat it as a real difference.
    let fa: number;
    let fb: number;
    try {
      fa = float(a);
      fb = float(b_);
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
      return false;
    }
    if (!_floatsClose(fa, fb)) return false;
  }
  return true;
}

/**
 * True when `c1` and `c2` differ ONLY in float coordinates within
 * tolerance (so the byte difference is float-precision noise, not a real
 * change). Non-float bytes must still match exactly.
 */
export function _onlyFloatDiff(c1: Chunk, c2: Chunk): boolean {
  const ct = getattr(c1, "chunk_type", null);
  if (ct !== getattr(c2, "chunk_type", null)) return false;
  if (ct === "Utf8" && c1 instanceof Utf8Chunk && c2 instanceof Utf8Chunk) {
    return _gradientXmlOnlyFloatDiff(c1.value, c2.value);
  }
  const f1 = _chunkFloats(c1);
  if (f1 == null) return false;
  const f2 = _chunkFloats(c2);
  if (f2 == null || f1.length !== f2.length) return false;
  if (!f1.every((a, i) => _floatsClose(a, f2[i]))) return false;
  // Rebuild c1 with c2's float values; equal bytes => only the (in-
  // tolerance) floats differed, everything else is byte-identical.
  const rebuilt: Uint8Array = _withFloats(c1, f2).tobytes();
  const original: Uint8Array = c2.tobytes();
  return bytesEq(rebuilt, original);
}

/**
 * True when `path` differs only in float coordinates across every file
 * that contains it (so the multi-file diff is float-precision noise). Files
 * byte-identical to the reference do not count as a difference.
 */
export function _multiOnlyFloatDiff(allTyped: Map<string, Chunk>[], present: number[], path: string): boolean {
  const ref = allTyped[present[0]].get(path) ?? null;
  if (ref == null) return false;
  const refBytes = ref.tobytes();
  for (const i of present.slice(1)) {
    const other = allTyped[i].get(path) ?? null;
    if (other == null) return false;
    if (bytesEq(other.tobytes(), refBytes)) continue;
    if (!_onlyFloatDiff(ref, other)) return false;
  }
  return true;
}

// ── AEP chunk extraction ───────────────────────────────────────────────────

/** Alias for backward compatibility with tests. */
export const parseAepChunks = extractLeafChunks;

// ── Comparison helpers ──────────────────────────────────────────────────────

/**
 * Compare two chunk dictionaries and return differences.
 *
 * @param data1 - Chunk path to bytes mapping from file 1.
 * @param data2 - Chunk path to bytes mapping from file 2.
 * @param typed1 - Optional decoded chunks for file 1 (enables float-tolerant comparison of
 *   coordinate fields).
 * @param typed2 - Optional decoded chunks for file 2.
 * @param exact - When `true`, disable float tolerance (byte-exact).
 * @returns Tuple of (differences, paths only in data1, paths only in data2, paths of the
 *   float-precision-only differences suppressed).
 */
export function _compareChunkDicts(
  data1: Map<string, Uint8Array>,
  data2: Map<string, Uint8Array>,
  typed1: Map<string, Chunk> | null = null,
  typed2: Map<string, Chunk> | null = null,
  exact = false,
): [ChunkDifference[], string[], string[], string[]] {
  const paths1 = new Set(data1.keys());
  const paths2 = new Set(data2.keys());

  const onlyIn1 = sorted([...paths1].filter((p) => !paths2.has(p)));
  const onlyIn2 = sorted([...paths2].filter((p) => !paths1.has(p)));
  const commonPaths = sorted([...paths1].filter((p) => paths2.has(p)));

  const differences: ChunkDifference[] = [];
  const suppressed: string[] = [];
  for (const path of commonPaths) {
    const bytes1 = getitem(data1, path);
    const bytes2 = getitem(data2, path);
    if (bytesEq(bytes1, bytes2)) continue;
    // Suppress float-precision-only differences (same coordinate, just
    // AE-vs-py_aep float rounding) unless an exact comparison was asked.
    if (
      !exact &&
      typed1 != null &&
      typed2 != null &&
      typed1.has(path) &&
      typed2.has(path) &&
      _onlyFloatDiff(getitem(typed1, path), getitem(typed2, path))
    ) {
      suppressed.push(path);
      continue;
    }
    const byteDiffs = [...compareBinaryData(bytes1, bytes2, path)];

    if (byteDiffs.length > 0 || bytes1.length !== bytes2.length) {
      differences.push(new ChunkDifference(path, byteDiffs, bytes1.length, bytes2.length));
    }
  }

  return [differences, onlyIn1, onlyIn2, suppressed];
}

// ── Structural comparison ───────────────────────────────────────────────────

/** A structural mismatch between two chunk trees. */
export class StructuralDifference {
  path: string;
  count1: number;
  count2: number;
  children1: string[];
  children2: string[];

  constructor(path: string, count1: number, count2: number, children1: string[], children2: string[]) {
    this.path = path;
    this.count1 = count1;
    this.count2 = count2;
    this.children1 = children1;
    this.children2 = children2;
  }
}

/** Recursively compare two chunk trees structurally. */
export function _compareStructureRecursive(c1: Chunk, c2: Chunk, path: string, diffs: StructuralDifference[]): void {
  const label1 = chunkLabel(c1);
  const label2 = chunkLabel(c2);
  const current = path ? `${path}/${label1}` : label1;

  if (label1 !== label2) {
    diffs.push(new StructuralDifference(current, -1, -1, [label1], [label2]));
    return;
  }

  if (c1 instanceof ListChunk && c2 instanceof ListChunk) {
    const ch1 = c1.chunks.map((c) => chunkLabel(c));
    const ch2 = c2.chunks.map((c) => chunkLabel(c));
    if (!pyEq(ch1, ch2)) {
      diffs.push(new StructuralDifference(current, ch1.length, ch2.length, ch1, ch2));
    }
    for (let i = 0; i < Math.min(c1.chunks.length, c2.chunks.length); i++) {
      _compareStructureRecursive(c1.chunks[i], c2.chunks[i], current, diffs);
    }
  }
}

/**
 * Compare two AEP files structurally.
 *
 * Detects child count mismatches, missing chunks (including empty ones
 * invisible to byte-level diffing), and ordering differences.
 *
 * @param file1 - First AEP file path.
 * @param file2 - Second AEP file path.
 * @returns List of structural differences.
 */
export function compareStructure(file1: Path, file2: Path): StructuralDifference[] {
  // `with open(file, "rb") as f: read_aep(f)` is modelled by reading the
  // whole file first; read_aep consumes all of it, so the handle can close.
  const [rifx1] = readAep(new BytesIO(file1.readBytes()));
  const [rifx2] = readAep(new BytesIO(file2.readBytes()));
  const diffs: StructuralDifference[] = [];
  _compareStructureRecursive(rifx1, rifx2, "", diffs);
  return diffs;
}

// ── Multi-file comparison ──────────────────────────────────────────────────

/**
 * Compare multiple AEP files and return per-chunk differences.
 *
 * The first file is treated as the reference.
 *
 * @param files - List of AEP file paths (first = reference).
 * @param exact - When `true`, disable float tolerance (byte-exact); otherwise chunks differing only
 *   in float-precision coordinates across all present files are suppressed, matching two-file mode.
 * @returns Tuple of (chunk differences, missing chunk info, parsed data per file, paths of the
 *   float-precision-only chunk differences suppressed).
 */
export function compareMultiAepFiles(
  files: Path[],
  exact = false,
): [MultiChunkDifference[], [string, number[]][], Map<string, Uint8Array>[], string[]] {
  const parsed = files.map((f) => extractLeafChunksTyped(f));
  const allData = parsed.map(([data]) => data);
  const allTyped = parsed.map(([, typed]) => typed);
  const allPaths = new Set<string>();
  for (const d of allData) {
    for (const k of d.keys()) allPaths.add(k);
  }

  const differences: MultiChunkDifference[] = [];
  const missingChunks: [string, number[]][] = [];
  const suppressed: string[] = [];

  for (const path of sorted(allPaths)) {
    const present: number[] = [];
    for (const [i, d] of allData.entries()) {
      if (d.has(path)) present.push(i);
    }
    if (present.length < files.length) {
      missingChunks.push([path, present]);
      if (present.length < 2) continue;
    }

    const dataList = Array.from({ length: files.length }, (_, i) => allData[i].get(path) ?? b(""));
    const sizes = dataList.map((d) => d.length);
    const maxLen = max(sizes);

    const chunkDiffs: MultiFileDifference[] = [];
    for (let offset = 0; offset < maxLen; offset++) {
      const values: number[] = [];
      for (let i = 0, n = files.length; i < n; i++) {
        if (offset < dataList[i].length) {
          values.push(dataList[i][offset]);
        } else {
          values.push(MISSING_BYTE);
        }
      }

      const nonMissing = values.filter((v) => v !== MISSING_BYTE);
      if (new Set(nonMissing).size > 1) {
        chunkDiffs.push(new MultiFileDifference(path, offset, values));
      }
    }

    if (chunkDiffs.length > 0) {
      // Suppress float-precision-only differences (matching two-file mode).
      if (!exact && _multiOnlyFloatDiff(allTyped, present, path)) {
        suppressed.push(path);
        continue;
      }
      differences.push(new MultiChunkDifference(path, chunkDiffs, sizes));
    }
  }

  return [differences, missingChunks, allData, suppressed];
}

// ── Output formatting ──────────────────────────────────────────────────────

/**
 * Format a context line showing bytes around a diff offset.
 *
 * @param label - Label for this line (e.g. `File 1`).
 * @param data - Full chunk data.
 * @param offset - The diff offset to highlight.
 * @param context - Number of bytes before/after to show.
 * @returns Formatted context string with the diff byte in brackets.
 */
export function _formatContextLine(label: string, data: Uint8Array, offset: number, context: number): string {
  const start = Math.max(0, offset - context);
  const end = Math.min(data.length, offset + context + 1);
  const parts: string[] = [];
  for (let j = start; j < end; j++) {
    if (j === offset) {
      parts.push(`[${format(data[j], "02X")}]`);
    } else {
      parts.push(` ${format(data[j], "02X")} `);
    }
  }
  return `    ${label}: ` + parts.join("");
}

/** Print comparison results to stdout. */
export function printResults(
  file1: Path,
  file2: Path,
  differences: ChunkDifference[],
  onlyInFile1: string[],
  onlyInFile2: string[],
  context = 0,
  data1: Map<string, Uint8Array> | null = null,
  data2: Map<string, Uint8Array> | null = null,
  structuralDiffs: StructuralDifference[] | null = null,
): void {
  print(`\n${"=".repeat(80)}`);
  print("Comparing:");
  print(`  File 1: ${file1}`);
  print(`  File 2: ${file2}`);
  print(`${"=".repeat(80)}\n`);

  const hasAny =
    differences?.length > 0 || onlyInFile1?.length > 0 || onlyInFile2?.length > 0 || structuralDiffs != null && structuralDiffs.length > 0;
  if (!hasAny) {
    print("No differences found!");
    return;
  }

  // Print structural differences
  if (structuralDiffs != null && structuralDiffs.length > 0) {
    print(`\n${"─".repeat(40)}`);
    print(`Structural differences (${structuralDiffs.length}):`);
    print(`${"─".repeat(40)}`);
    for (const sd of structuralDiffs) {
      if (sd.count1 === -1) {
        print(`\n[${sd.path}] type mismatch: ${sd.children1[0]} vs ${sd.children2[0]}`);
      } else {
        print(`\n[${sd.path}] child count: ${sd.count1} vs ${sd.count2}`);
        const maxLen = max([sd.children1.length, sd.children2.length]);
        for (let i = 0; i < maxLen; i++) {
          const c1 = i < sd.children1.length ? sd.children1[i] : "<missing>";
          const c2 = i < sd.children2.length ? sd.children2[i] : "<missing>";
          const marker = c1 === c2 ? "  " : "!!";
          print(`  ${marker} [${format(i, "2d")}] ${c1.padEnd(20)}  vs  ${c2}`);
        }
      }
    }
  }

  // Print chunks only in file1
  if (onlyInFile1?.length > 0) {
    print(`\n${"─".repeat(40)}`);
    print(`Chunks only in File 1 (${onlyInFile1.length}):`);
    print(`${"─".repeat(40)}`);
    for (const path of onlyInFile1) {
      print(`  ${path}`);
    }
  }

  // Print chunks only in file2
  if (onlyInFile2?.length > 0) {
    print(`\n${"─".repeat(40)}`);
    print(`Chunks only in File 2 (${onlyInFile2.length}):`);
    print(`${"─".repeat(40)}`);
    for (const path of onlyInFile2) {
      print(`  ${path}`);
    }
  }

  // Print byte differences
  if (differences?.length > 0) {
    print(`\n${"─".repeat(40)}`);
    print(`Byte differences (${differences.length} chunks):`);
    print(`${"─".repeat(40)}`);

    for (const diff of differences) {
      print(`\n[${diff.path}]`);
      if (diff.hasSizeDifference()) {
        print(`  Size: ${diff.size1} bytes vs ${diff.size2} bytes`);
      }

      for (const byteDiff of diff.byteDiffs) {
        if (byteDiff.byte1 === MISSING_BYTE) {
          print(
            `  Offset ${format(byteDiff.offset, "4d")} ` +
              `(0x${format(byteDiff.offset, "04X")}): ` +
              `<missing> vs 0x${format(byteDiff.byte2, "02X")}`,
          );
        } else if (byteDiff.byte2 === MISSING_BYTE) {
          print(
            `  Offset ${format(byteDiff.offset, "4d")} ` +
              `(0x${format(byteDiff.offset, "04X")}): ` +
              `0x${format(byteDiff.byte1, "02X")} vs <missing>`,
          );
        } else {
          print(byteDiff.formatDiff());
        }

        // Context display
        if (context > 0 && data1 != null && data2 != null) {
          const d1 = data1.get(diff.path) ?? b("");
          const d2 = data2.get(diff.path) ?? b("");
          if (d1?.length > 0) {
            print(_formatContextLine("File 1", d1, byteDiff.offset, context));
          }
          if (d2?.length > 0) {
            print(_formatContextLine("File 2", d2, byteDiff.offset, context));
          }
        }
      }
    }
  }

  // Summary
  const totalByteDiffs = sum(differences.map((d) => d.byteDiffs.length));
  print(`\n${"=".repeat(80)}`);
  print("Summary:");
  if (structuralDiffs != null && structuralDiffs.length > 0) {
    print(`  Structural differences: ${structuralDiffs.length}`);
  }
  print(`  Chunks with differences: ${differences.length}`);
  print(`  Total byte differences: ${totalByteDiffs}`);
  print(`  Chunks only in File 1: ${onlyInFile1.length}`);
  print(`  Chunks only in File 2: ${onlyInFile2.length}`);
  print(`${"=".repeat(80)}\n`);
}

/** Print multi-file comparison results. */
export function printMultiResults(
  files: Path[],
  differences: MultiChunkDifference[],
  missingChunks: [string, number[]][],
  context = 0,
  allData: Map<string, Uint8Array>[] | null = null,
): void {
  // Header
  print(`\n${"=".repeat(80)}`);
  print(`Comparing ${files.length} files:`);
  for (const [i, f] of files.entries()) {
    const label = i === 0 ? "ref" : str(i);
    print(`  [${label}] ${f.name}`);
  }
  print(`${"=".repeat(80)}\n`);

  if (!differences?.length && !missingChunks?.length) {
    print("No differences found!");
    return;
  }

  // Chunks not in all files
  if (missingChunks?.length > 0) {
    print(`${"─".repeat(40)}`);
    print(`Chunks not in all files (${missingChunks.length}):`);
    print(`${"─".repeat(40)}`);
    for (const [path, presentIn] of missingChunks) {
      const labels = presentIn.map((i) => (i === 0 ? "ref" : str(i)));
      print(`  ${path}  (in: ${labels.join(", ")})`);
    }
  }

  // Byte differences
  if (differences?.length > 0) {
    print(`\n${"─".repeat(40)}`);
    print(`Byte differences (${differences.length} chunks):`);
    print(`${"─".repeat(40)}`);

    for (const chunkDiff of differences) {
      print(`\n[${chunkDiff.path}]`);

      const uniqueSizes = new Set(chunkDiff.sizes);
      if (uniqueSizes.size > 1) {
        const sizeParts = [...chunkDiff.sizes.entries()].map(([i, s]) => `${i === 0 ? "ref" : str(i)}=${s}`);
        print(`  Size: ${sizeParts.join(", ")}`);
      }

      for (const diff of chunkDiff.diffs) {
        const bitInfo = diff.bitPosition != null ? `, bit ${diff.bitPosition}` : "";
        const valueParts: string[] = [];
        for (const v of diff.values) {
          if (v === MISSING_BYTE) {
            valueParts.push("    --    ");
          } else {
            valueParts.push(`0x${format(v, "02X")} (${bin8(v)})`);
          }
        }
        print(
          `  Offset ${format(diff.offset, "4d")} ` +
            `(0x${format(diff.offset, "04X")}): ` +
            `${valueParts.join(" | ")}${bitInfo}`,
        );

        // Context display
        if (context > 0 && allData != null && allData.length > 0) {
          for (let i = 0, n = files.length; i < n; i++) {
            const label = i === 0 ? "ref" : `[${i}]`;
            const data = allData[i].get(chunkDiff.path) ?? b("");
            if (!data?.length) continue;
            print(_formatContextLine(label, data, diff.offset, context));
          }
        }
      }
    }
  }

  // Summary
  const totalDiffs = sum(differences.map((cd) => cd.diffs.length));
  print(`\n${"=".repeat(80)}`);
  print("Summary:");
  print(`  Files compared: ${files.length}`);
  print(`  Chunks with differences: ${differences.length}`);
  print(`  Total byte differences: ${totalDiffs}`);
  print(`  Chunks not in all files: ${missingChunks.length}`);
  print(`${"=".repeat(80)}\n`);
}

/** Convert comparison results to a JSON-serializable dict. */
export function toJsonOutput(
  file1: Path,
  file2: Path,
  differences: ChunkDifference[],
  onlyInFile1: string[],
  onlyInFile2: string[],
  suppressed = 0,
) {
  return {
    file1: file1.toString(),
    file2: file2.toString(),
    chunks_with_differences: differences.map((diff) => ({
      path: diff.path,
      size1: diff.size1,
      size2: diff.size2,
      byte_differences: diff.byteDiffs.map((bd) => ({
        offset: bd.offset,
        offset_hex: `0x${format(bd.offset, "04X")}`,
        byte1: bd.byte1 !== MISSING_BYTE ? bd.byte1 : null,
        byte1_hex: bd.byte1 !== MISSING_BYTE ? `0x${format(bd.byte1, "02X")}` : null,
        byte1_binary: bd.byte1 !== MISSING_BYTE ? bin8(bd.byte1) : null,
        byte2: bd.byte2 !== MISSING_BYTE ? bd.byte2 : null,
        byte2_hex: bd.byte2 !== MISSING_BYTE ? `0x${format(bd.byte2, "02X")}` : null,
        byte2_binary: bd.byte2 !== MISSING_BYTE ? bin8(bd.byte2) : null,
        bit_position: bd.bitPosition,
      })),
    })),
    only_in_file1: onlyInFile1,
    only_in_file2: onlyInFile2,
    suppressed_float_diffs: suppressed,
    summary: {
      chunks_with_differences: differences.length,
      total_byte_differences: sum(differences.map((d) => d.byteDiffs.length)),
      only_in_file1: onlyInFile1.length,
      only_in_file2: onlyInFile2.length,
      suppressed_float_diffs: suppressed,
    },
  };
}

/** Filter results to only include paths matching the pattern. */
export function filterDifferences(
  differences: ChunkDifference[],
  onlyInFile1: string[],
  onlyInFile2: string[],
  filterPattern: string,
): [ChunkDifference[], string[], string[]] {
  const patternLower = filterPattern.toLowerCase();
  const filteredDiffs = differences.filter((d) => d.path.toLowerCase().includes(patternLower));
  const filteredOnly1 = onlyInFile1.filter((p) => p.toLowerCase().includes(patternLower));
  const filteredOnly2 = onlyInFile2.filter((p) => p.toLowerCase().includes(patternLower));
  return [filteredDiffs, filteredOnly1, filteredOnly2];
}

// ── CLI ─────────────────────────────────────────────────────────────────────

/** Note suppressed float-precision-only diffs so they are never silent. */
export function _reportSuppressed(suppressed: number, exact: boolean): void {
  if (suppressed && !exact) {
    const plural = suppressed !== 1 ? "s" : "";
    eprint(
      `Note: suppressed ${suppressed} float-precision-only chunk ` +
        `difference${plural} (use --exact to show them).`,
    );
  }
}

// TODO(port): no argparse shim; parse_args hand-implements this CLI's options (prefix matching,
// `--opt=value`, `--`, nargs="+" runs, exit-2 errors). HELP/USAGE are argparse's layout for its
// default 80-column (non-tty) width; argparse wraps to COLUMNS or the terminal width instead.
// An unrecognized option errors at once where argparse first reports missing positionals.
export const PROG = "aep-compare";
export const OPTIONS = ["--help", "--json", "--filter", "--context", "--exact"];

export const USAGE =
  `usage: ${PROG} [-h] [--json] [--filter FILTER] [--context N] [--exact]\n` +
  `                   files [files ...]`;

export const HELP = `${USAGE}

Compare After Effects project files (.aep)

positional arguments:
  files            Two or more AEP files to compare

options:
  -h, --help       show this help message and exit
  --json           Output results in JSON format
  --filter FILTER  Filter results to only show chunks matching this pattern
                   (case-insensitive)
  --context N      Show N surrounding bytes around each difference
  --exact          Byte-exact comparison; do not tolerate float-precision
                   differences in cdat/shph/ldat coordinate fields

Examples:
    ${PROG} file1.aep file2.aep
    ${PROG} ref.aep v1.aep v2.aep v3.aep   (multi-file)
    ${PROG} file1.aep file2.aep --context 4
    ${PROG} file1.aep file2.aep --json
    ${PROG} file1.aep file2.aep --filter ldta

For single-file inspection, use aep-inspect.

Output shows for each different byte:
    - The chunk path (hierarchy of elements/chunks)
    - Byte offset (decimal and hex)
    - Byte values (hex and binary)
    - Bit position (7-0) if only one bit differs
        `;

/** argparse's `parser.error`: usage plus message to stderr, exit status 2. */
export function parserError(message: string): never {
  eprint(USAGE);
  eprint(`${PROG}: error: ${message}`);
  throw new SystemExit(2);
}

export function isNegativeNumber(arg: string): boolean {
  return /^-\d+$|^-\d*\.\d+$/.test(arg);
}

/** Long-option prefix matching as argparse does by default (allow_abbrev). */
export function resolveOption(name: string, arg: string = name): string | null {
  if (name === "-h") return "--help";
  if (!name.startsWith("--")) return null;
  if (OPTIONS.includes(name)) return name;
  const hits = OPTIONS.filter((o) => o.startsWith(name));
  if (hits.length > 1) parserError(`ambiguous option: ${arg} could match ${hits.join(", ")}`);
  return hits.length === 1 ? hits[0] : null;
}

export type Args = {
  files: Path[];
  json: boolean;
  filter: string | null;
  context: number;
  exact: boolean;
};

export function parseArgs(argv: string[]): Args {
  const out: Args = { files: [], json: false, filter: null, context: 0, exact: false };
  const positionals: string[] = [];
  const extras: string[] = [];
  // argparse with `files` nargs="+": once an option splits the run of
  // positionals, later positionals are "unrecognized arguments".
  let runClosed = false;
  let onlyPositional = false;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (!onlyPositional && arg === "--") {
      onlyPositional = true;
      i++;
      continue;
    }
    const isOption = !onlyPositional && arg.startsWith("-") && arg !== "-" && !isNegativeNumber(arg);
    if (!isOption) {
      if (runClosed) extras.push(arg);
      else positionals.push(arg);
      i++;
      continue;
    }

    if (positionals.length) runClosed = true;
    let name = arg;
    let value: string | null = null;
    if (arg.startsWith("--") && arg.includes("=")) {
      name = arg.slice(0, arg.indexOf("="));
      value = arg.slice(arg.indexOf("=") + 1);
    }
    const opt = resolveOption(name, arg);
    if (opt === null) {
      extras.push(arg);
      i++;
      continue;
    }

    if (opt === "--help") {
      print(HELP);
      throw new SystemExit(0);
    }
    if (opt === "--json" || opt === "--exact") {
      if (value !== null) parserError(`argument ${opt}: ignored explicit argument '${value}'`);
      if (opt === "--json") out.json = true;
      else out.exact = true;
      i++;
      continue;
    }

    // --filter / --context take exactly one value.
    if (value === null) {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("-") && next !== "-" && !isNegativeNumber(next))) {
        parserError(`argument ${opt}: expected one argument`);
      }
      value = next;
      i += 2;
    } else {
      i += 1;
    }
    if (opt === "--filter") {
      out.filter = value;
    } else {
      try {
        out.context = int(value);
      } catch (e) {
        if (!(e instanceof ValueError)) throw e;
        parserError(`argument --context: invalid int value: ${repr(value)}`);
      }
    }
  }

  if (!positionals.length) parserError("the following arguments are required: files");
  if (extras.length) parserError(`unrecognized arguments: ${extras.join(" ")}`);
  out.files = positionals.map((p) => new Path(p));
  return out;
}

/** CLI entry point for aep-compare command. */
export function main(): number {
  const args = parseArgs(process.argv.slice(2));

  // Validate files exist
  const files: Path[] = args.files;
  for (const f of files) {
    if (!f.exists()) {
      eprint(`Error: File not found: ${f}`);
      return 1;
    }
  }

  // ── Comparison mode ────────────────────────────────────────────────

  if (files.length < 2) {
    eprint("Error: Need at least two files for comparison");
    return 1;
  }

  // ── Multi-file comparison (3+ AEP files) ──────────────────────

  if (files.length > 2) {
    let [multiDiffs, missing, allData, suppressed] = compareMultiAepFiles(files, args.exact);

    if (args.filter) {
      const pattern = args.filter.toLowerCase();
      multiDiffs = multiDiffs.filter((d) => d.path.toLowerCase().includes(pattern));
      missing = missing.filter(([p]) => p.toLowerCase().includes(pattern));
      suppressed = suppressed.filter((p) => p.toLowerCase().includes(pattern));
    }

    printMultiResults(files, multiDiffs, missing, args.context, allData);
    _reportSuppressed(suppressed.length, args.exact);
    return !multiDiffs?.length && !missing?.length ? 0 : 1;
  }

  // ── Two-file comparison ────────────────────────────────────────────

  const file1 = files[0];
  const file2 = files[1];

  // Parse once and reuse for both comparison and context
  const [data1, typed1] = extractLeafChunksTyped(file1);
  const [data2, typed2] = extractLeafChunksTyped(file2);
  let [diffs, only1, only2, suppressed] = _compareChunkDicts(data1, data2, typed1, typed2, args.exact);
  const structDiffs = compareStructure(file1, file2);
  const ctx1 = args.context > 0 ? data1 : null;
  const ctx2 = args.context > 0 ? data2 : null;

  // Apply filter
  if (args.filter) {
    [diffs, only1, only2] = filterDifferences(diffs, only1, only2, args.filter);
    const pattern = args.filter.toLowerCase();
    suppressed = suppressed.filter((p) => p.toLowerCase().includes(pattern));
  }

  // Output results
  if (args.json) {
    const output = toJsonOutput(file1, file2, diffs, only1, only2, suppressed.length);
    print(jsonDumps(output, { indent: 2 }));
  } else {
    printResults(file1, file2, diffs, only1, only2, args.context, ctx1, ctx2, structDiffs);
  }
  _reportSuppressed(suppressed.length, args.exact);

  return !diffs?.length && !only1?.length && !only2?.length ? 0 : 1;
}

// `if __name__ == "__main__": sys.exit(main())`
if (import.meta.main) {
  try {
    process.exit(main());
  } catch (e) {
    if (e instanceof SystemExit) process.exit(typeof e.code === "number" ? e.code : e.code == null ? 0 : 1);
    throw e;
  }
}
