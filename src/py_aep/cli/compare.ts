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
// registers every chunk type. Standalone CLI runs need the same registration.
import "../binary/_register.ts";
import { ListChunk, read_aep } from "../binary/chunk.ts";
import type { Chunk } from "../binary/chunk.ts";
import { LdatChunk } from "../binary/ldat_chunks.ts";
import { ShphChunk } from "../binary/misc_chunks.ts";
import { CdatChunk } from "../binary/property_chunks.ts";
import { Utf8Chunk } from "../binary/scalar_chunks.ts";
import { chunk_label, extract_leaf_chunks, extract_leaf_chunks_typed } from "./_chunk_helpers.ts";
import {
  BytesIO,
  Path,
  ValueError,
  b,
  bytes_eq,
  deepcopy,
  float,
  format,
  getattr,
  getitem,
  int,
  max,
  py_bool,
  py_eq,
  repr,
  sorted,
  str,
  sum,
  SystemExit,
  json_dumps,
} from "../../pyrt/index.ts";

export function print(...args: string[]): void {
  console.log(args.join(" "));
}

export function eprint(message: string): void {
  console.error(message);
}

// NOTE(port): int.bit_length(); exact for the integer inputs (xor of two bytes) used here.
export function bit_length(n: number): number {
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
  bit_position: number | null;

  constructor(path: string, offset: number, byte1: number, byte2: number, bit_position: number | null = null) {
    this.path = path;
    this.offset = offset;
    this.byte1 = byte1;
    this.byte2 = byte2;
    this.bit_position = bit_position;
    this.__post_init__();
  }

  /** Calculate bit position if only one bit differs. */
  __post_init__(): void {
    const xor = this.byte1 ^ this.byte2;
    if (xor !== 0 && (xor & (xor - 1)) === 0) {
      // Check if only one bit is set
      this.bit_position = 7 - (bit_length(xor) - 1);
    }
  }

  /** Format the difference for display. */
  format_diff(): string {
    const bit_info = this.bit_position != null ? `, bit ${this.bit_position}` : "";
    return (
      `  Offset ${format(this.offset, "4d")} (0x${format(this.offset, "04X")}): ` +
      `0x${format(this.byte1, "02X")} (${bin8(this.byte1)}) vs ` +
      `0x${format(this.byte2, "02X")} (${bin8(this.byte2)})${bit_info}`
    );
  }
}

/** Represents all differences within a specific chunk/element. */
export class ChunkDifference {
  path: string;
  byte_diffs: ByteDifference[];
  size1: number;
  size2: number;

  constructor(path: string, byte_diffs: ByteDifference[], size1: number, size2: number) {
    this.path = path;
    this.byte_diffs = byte_diffs;
    this.size1 = size1;
    this.size2 = size2;
  }

  /** Check if the chunks have different sizes. */
  has_size_difference(): boolean {
    return this.size1 !== this.size2;
  }
}

/** A byte offset where files differ, with values from all files. */
export class MultiFileDifference {
  path: string;
  offset: number;
  /** Byte value per file. `-1` if the chunk is missing in that file. */
  values: number[];
  bit_position: number | null;

  constructor(path: string, offset: number, values: number[], bit_position: number | null = null) {
    this.path = path;
    this.offset = offset;
    this.values = values;
    this.bit_position = bit_position;
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
        this.bit_position = 7 - (bit_length(xor) - 1);
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
export function* compare_binary_data(data1: Uint8Array, data2: Uint8Array, path: string): Generator<ByteDifference> {
  const min_len = Math.min(data1.length, data2.length);

  // Compare common bytes
  for (let i = 0; i < min_len; i++) {
    if (data1[i] !== data2[i]) {
      yield new ByteDifference(path, i, data1[i], data2[i]);
    }
  }

  // Report extra bytes in longer sequence
  if (data1.length > min_len) {
    for (let i = min_len; i < data1.length; i++) {
      yield new ByteDifference(path, i, data1[i], MISSING_BYTE); // byte doesn't exist in file 2
    }
  } else if (data2.length > min_len) {
    for (let i = min_len; i < data2.length; i++) {
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

export function _floats_close(a: number, b_: number): boolean {
  return Math.abs(a - b_) <= max([FLOAT_ABS_TOL, FLOAT_REL_TOL * max([Math.abs(a), Math.abs(b_)])]);
}

/**
 * Return a chunk's coordinate float fields, or None if it has none.
 *
 * Covers the float-bearing leaf chunks whose values AE and py_aep may
 * encode with slightly different rounding: `cdat` (doubles), `shph`
 * (bounding-box f4), and `ldat` shape-point lists (f4 x/y).
 */
export function _chunk_floats(chunk: Chunk): number[] | null {
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
    if (py_bool(items) && items.every((i: { x: number; y: number }) => "x" in i && "y" in i)) {
      return items.flatMap((i: { x: number; y: number }) => [i.x, i.y]);
    }
  }
  return null;
}

/** Return a copy of `chunk` with its coordinate floats replaced. */
export function _with_floats(chunk: Chunk, floats: number[]): Chunk {
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
export function _gradient_xml_only_float_diff(s1: string | String, s2: string | String): boolean {
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
    if (!_floats_close(fa, fb)) return false;
  }
  return true;
}

/**
 * True when `c1` and `c2` differ ONLY in float coordinates within
 * tolerance (so the byte difference is float-precision noise, not a real
 * change). Non-float bytes must still match exactly.
 */
export function _only_float_diff(c1: Chunk, c2: Chunk): boolean {
  const ct = getattr(c1, "chunk_type", null);
  if (ct !== getattr(c2, "chunk_type", null)) return false;
  if (ct === "Utf8" && c1 instanceof Utf8Chunk && c2 instanceof Utf8Chunk) {
    return _gradient_xml_only_float_diff(c1.value, c2.value);
  }
  const f1 = _chunk_floats(c1);
  if (f1 == null) return false;
  const f2 = _chunk_floats(c2);
  if (f2 == null || f1.length !== f2.length) return false;
  if (!f1.every((a, i) => _floats_close(a, f2[i]))) return false;
  // Rebuild c1 with c2's float values; equal bytes => only the (in-
  // tolerance) floats differed, everything else is byte-identical.
  const rebuilt: Uint8Array = _with_floats(c1, f2).tobytes();
  const original: Uint8Array = c2.tobytes();
  return bytes_eq(rebuilt, original);
}

/**
 * True when `path` differs only in float coordinates across every file
 * that contains it (so the multi-file diff is float-precision noise). Files
 * byte-identical to the reference do not count as a difference.
 */
export function _multi_only_float_diff(all_typed: Map<string, Chunk>[], present: number[], path: string): boolean {
  const ref = all_typed[present[0]].get(path) ?? null;
  if (ref == null) return false;
  const ref_bytes = ref.tobytes();
  for (const i of present.slice(1)) {
    const other = all_typed[i].get(path) ?? null;
    if (other == null) return false;
    if (bytes_eq(other.tobytes(), ref_bytes)) continue;
    if (!_only_float_diff(ref, other)) return false;
  }
  return true;
}

// ── AEP chunk extraction ───────────────────────────────────────────────────

/** Alias for backward compatibility with tests. */
export const parse_aep_chunks = extract_leaf_chunks;

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
export function _compare_chunk_dicts(
  data1: Map<string, Uint8Array>,
  data2: Map<string, Uint8Array>,
  typed1: Map<string, Chunk> | null = null,
  typed2: Map<string, Chunk> | null = null,
  exact = false,
): [ChunkDifference[], string[], string[], string[]] {
  const paths1 = new Set(data1.keys());
  const paths2 = new Set(data2.keys());

  const only_in_1 = sorted([...paths1].filter((p) => !paths2.has(p)));
  const only_in_2 = sorted([...paths2].filter((p) => !paths1.has(p)));
  const common_paths = sorted([...paths1].filter((p) => paths2.has(p)));

  const differences: ChunkDifference[] = [];
  const suppressed: string[] = [];
  for (const path of common_paths) {
    const bytes1 = getitem(data1, path);
    const bytes2 = getitem(data2, path);
    if (bytes_eq(bytes1, bytes2)) continue;
    // Suppress float-precision-only differences (same coordinate, just
    // AE-vs-py_aep float rounding) unless an exact comparison was asked.
    if (
      !exact &&
      typed1 != null &&
      typed2 != null &&
      typed1.has(path) &&
      typed2.has(path) &&
      _only_float_diff(getitem(typed1, path), getitem(typed2, path))
    ) {
      suppressed.push(path);
      continue;
    }
    const byte_diffs = [...compare_binary_data(bytes1, bytes2, path)];

    if (byte_diffs.length > 0 || bytes1.length !== bytes2.length) {
      differences.push(new ChunkDifference(path, byte_diffs, bytes1.length, bytes2.length));
    }
  }

  return [differences, only_in_1, only_in_2, suppressed];
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
export function _compare_structure_recursive(c1: Chunk, c2: Chunk, path: string, diffs: StructuralDifference[]): void {
  const label1 = chunk_label(c1);
  const label2 = chunk_label(c2);
  const current = path ? `${path}/${label1}` : label1;

  if (label1 !== label2) {
    diffs.push(new StructuralDifference(current, -1, -1, [label1], [label2]));
    return;
  }

  if (c1 instanceof ListChunk && c2 instanceof ListChunk) {
    const ch1 = c1.chunks.map((c) => chunk_label(c));
    const ch2 = c2.chunks.map((c) => chunk_label(c));
    if (!py_eq(ch1, ch2)) {
      diffs.push(new StructuralDifference(current, ch1.length, ch2.length, ch1, ch2));
    }
    for (let i = 0; i < Math.min(c1.chunks.length, c2.chunks.length); i++) {
      _compare_structure_recursive(c1.chunks[i], c2.chunks[i], current, diffs);
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
export function compare_structure(file1: Path, file2: Path): StructuralDifference[] {
  // `with open(file, "rb") as f: read_aep(f)` is modelled by reading the
  // whole file first; read_aep consumes all of it, so the handle can close.
  const [rifx1] = read_aep(new BytesIO(file1.read_bytes()));
  const [rifx2] = read_aep(new BytesIO(file2.read_bytes()));
  const diffs: StructuralDifference[] = [];
  _compare_structure_recursive(rifx1, rifx2, "", diffs);
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
export function compare_multi_aep_files(
  files: Path[],
  exact = false,
): [MultiChunkDifference[], [string, number[]][], Map<string, Uint8Array>[], string[]] {
  const parsed = files.map((f) => extract_leaf_chunks_typed(f));
  const all_data = parsed.map(([data]) => data);
  const all_typed = parsed.map(([, typed]) => typed);
  const all_paths = new Set<string>();
  for (const d of all_data) {
    for (const k of d.keys()) all_paths.add(k);
  }

  const differences: MultiChunkDifference[] = [];
  const missing_chunks: [string, number[]][] = [];
  const suppressed: string[] = [];

  for (const path of sorted(all_paths)) {
    const present: number[] = [];
    for (const [i, d] of all_data.entries()) {
      if (d.has(path)) present.push(i);
    }
    if (present.length < files.length) {
      missing_chunks.push([path, present]);
      if (present.length < 2) continue;
    }

    const data_list = Array.from({ length: files.length }, (_, i) => all_data[i].get(path) ?? b(""));
    const sizes = data_list.map((d) => d.length);
    const max_len = max(sizes);

    const chunk_diffs: MultiFileDifference[] = [];
    for (let offset = 0; offset < max_len; offset++) {
      const values: number[] = [];
      for (let i = 0, n = files.length; i < n; i++) {
        if (offset < data_list[i].length) {
          values.push(data_list[i][offset]);
        } else {
          values.push(MISSING_BYTE);
        }
      }

      const non_missing = values.filter((v) => v !== MISSING_BYTE);
      if (new Set(non_missing).size > 1) {
        chunk_diffs.push(new MultiFileDifference(path, offset, values));
      }
    }

    if (chunk_diffs.length > 0) {
      // Suppress float-precision-only differences (matching two-file mode).
      if (!exact && _multi_only_float_diff(all_typed, present, path)) {
        suppressed.push(path);
        continue;
      }
      differences.push(new MultiChunkDifference(path, chunk_diffs, sizes));
    }
  }

  return [differences, missing_chunks, all_data, suppressed];
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
export function _format_context_line(label: string, data: Uint8Array, offset: number, context: number): string {
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
export function print_results(
  file1: Path,
  file2: Path,
  differences: ChunkDifference[],
  only_in_file1: string[],
  only_in_file2: string[],
  context = 0,
  data1: Map<string, Uint8Array> | null = null,
  data2: Map<string, Uint8Array> | null = null,
  structural_diffs: StructuralDifference[] | null = null,
): void {
  print(`\n${"=".repeat(80)}`);
  print("Comparing:");
  print(`  File 1: ${file1}`);
  print(`  File 2: ${file2}`);
  print(`${"=".repeat(80)}\n`);

  const has_any =
    differences?.length > 0 || only_in_file1?.length > 0 || only_in_file2?.length > 0 || structural_diffs != null && structural_diffs.length > 0;
  if (!has_any) {
    print("No differences found!");
    return;
  }

  // Print structural differences
  if (structural_diffs != null && structural_diffs.length > 0) {
    print(`\n${"─".repeat(40)}`);
    print(`Structural differences (${structural_diffs.length}):`);
    print(`${"─".repeat(40)}`);
    for (const sd of structural_diffs) {
      if (sd.count1 === -1) {
        print(`\n[${sd.path}] type mismatch: ${sd.children1[0]} vs ${sd.children2[0]}`);
      } else {
        print(`\n[${sd.path}] child count: ${sd.count1} vs ${sd.count2}`);
        const max_len = max([sd.children1.length, sd.children2.length]);
        for (let i = 0; i < max_len; i++) {
          const c1 = i < sd.children1.length ? sd.children1[i] : "<missing>";
          const c2 = i < sd.children2.length ? sd.children2[i] : "<missing>";
          const marker = c1 === c2 ? "  " : "!!";
          print(`  ${marker} [${format(i, "2d")}] ${c1.padEnd(20)}  vs  ${c2}`);
        }
      }
    }
  }

  // Print chunks only in file1
  if (only_in_file1?.length > 0) {
    print(`\n${"─".repeat(40)}`);
    print(`Chunks only in File 1 (${only_in_file1.length}):`);
    print(`${"─".repeat(40)}`);
    for (const path of only_in_file1) {
      print(`  ${path}`);
    }
  }

  // Print chunks only in file2
  if (only_in_file2?.length > 0) {
    print(`\n${"─".repeat(40)}`);
    print(`Chunks only in File 2 (${only_in_file2.length}):`);
    print(`${"─".repeat(40)}`);
    for (const path of only_in_file2) {
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
      if (diff.has_size_difference()) {
        print(`  Size: ${diff.size1} bytes vs ${diff.size2} bytes`);
      }

      for (const byte_diff of diff.byte_diffs) {
        if (byte_diff.byte1 === MISSING_BYTE) {
          print(
            `  Offset ${format(byte_diff.offset, "4d")} ` +
              `(0x${format(byte_diff.offset, "04X")}): ` +
              `<missing> vs 0x${format(byte_diff.byte2, "02X")}`,
          );
        } else if (byte_diff.byte2 === MISSING_BYTE) {
          print(
            `  Offset ${format(byte_diff.offset, "4d")} ` +
              `(0x${format(byte_diff.offset, "04X")}): ` +
              `0x${format(byte_diff.byte1, "02X")} vs <missing>`,
          );
        } else {
          print(byte_diff.format_diff());
        }

        // Context display
        if (context > 0 && data1 != null && data2 != null) {
          const d1 = data1.get(diff.path) ?? b("");
          const d2 = data2.get(diff.path) ?? b("");
          if (d1?.length > 0) {
            print(_format_context_line("File 1", d1, byte_diff.offset, context));
          }
          if (d2?.length > 0) {
            print(_format_context_line("File 2", d2, byte_diff.offset, context));
          }
        }
      }
    }
  }

  // Summary
  const total_byte_diffs = sum(differences.map((d) => d.byte_diffs.length));
  print(`\n${"=".repeat(80)}`);
  print("Summary:");
  if (structural_diffs != null && structural_diffs.length > 0) {
    print(`  Structural differences: ${structural_diffs.length}`);
  }
  print(`  Chunks with differences: ${differences.length}`);
  print(`  Total byte differences: ${total_byte_diffs}`);
  print(`  Chunks only in File 1: ${only_in_file1.length}`);
  print(`  Chunks only in File 2: ${only_in_file2.length}`);
  print(`${"=".repeat(80)}\n`);
}

/** Print multi-file comparison results. */
export function print_multi_results(
  files: Path[],
  differences: MultiChunkDifference[],
  missing_chunks: [string, number[]][],
  context = 0,
  all_data: Map<string, Uint8Array>[] | null = null,
): void {
  // Header
  print(`\n${"=".repeat(80)}`);
  print(`Comparing ${files.length} files:`);
  for (const [i, f] of files.entries()) {
    const label = i === 0 ? "ref" : str(i);
    print(`  [${label}] ${f.name}`);
  }
  print(`${"=".repeat(80)}\n`);

  if (!differences?.length && !missing_chunks?.length) {
    print("No differences found!");
    return;
  }

  // Chunks not in all files
  if (missing_chunks?.length > 0) {
    print(`${"─".repeat(40)}`);
    print(`Chunks not in all files (${missing_chunks.length}):`);
    print(`${"─".repeat(40)}`);
    for (const [path, present_in] of missing_chunks) {
      const labels = present_in.map((i) => (i === 0 ? "ref" : str(i)));
      print(`  ${path}  (in: ${labels.join(", ")})`);
    }
  }

  // Byte differences
  if (differences?.length > 0) {
    print(`\n${"─".repeat(40)}`);
    print(`Byte differences (${differences.length} chunks):`);
    print(`${"─".repeat(40)}`);

    for (const chunk_diff of differences) {
      print(`\n[${chunk_diff.path}]`);

      const unique_sizes = new Set(chunk_diff.sizes);
      if (unique_sizes.size > 1) {
        const size_parts = [...chunk_diff.sizes.entries()].map(([i, s]) => `${i === 0 ? "ref" : str(i)}=${s}`);
        print(`  Size: ${size_parts.join(", ")}`);
      }

      for (const diff of chunk_diff.diffs) {
        const bit_info = diff.bit_position != null ? `, bit ${diff.bit_position}` : "";
        const value_parts: string[] = [];
        for (const v of diff.values) {
          if (v === MISSING_BYTE) {
            value_parts.push("    --    ");
          } else {
            value_parts.push(`0x${format(v, "02X")} (${bin8(v)})`);
          }
        }
        print(
          `  Offset ${format(diff.offset, "4d")} ` +
            `(0x${format(diff.offset, "04X")}): ` +
            `${value_parts.join(" | ")}${bit_info}`,
        );

        // Context display
        if (context > 0 && all_data != null && all_data.length > 0) {
          for (let i = 0, n = files.length; i < n; i++) {
            const label = i === 0 ? "ref" : `[${i}]`;
            const data = all_data[i].get(chunk_diff.path) ?? b("");
            if (!data?.length) continue;
            print(_format_context_line(label, data, diff.offset, context));
          }
        }
      }
    }
  }

  // Summary
  const total_diffs = sum(differences.map((cd) => cd.diffs.length));
  print(`\n${"=".repeat(80)}`);
  print("Summary:");
  print(`  Files compared: ${files.length}`);
  print(`  Chunks with differences: ${differences.length}`);
  print(`  Total byte differences: ${total_diffs}`);
  print(`  Chunks not in all files: ${missing_chunks.length}`);
  print(`${"=".repeat(80)}\n`);
}

/** Convert comparison results to a JSON-serializable dict. */
export function to_json_output(
  file1: Path,
  file2: Path,
  differences: ChunkDifference[],
  only_in_file1: string[],
  only_in_file2: string[],
  suppressed = 0,
) {
  return {
    file1: file1.toString(),
    file2: file2.toString(),
    chunks_with_differences: differences.map((diff) => ({
      path: diff.path,
      size1: diff.size1,
      size2: diff.size2,
      byte_differences: diff.byte_diffs.map((bd) => ({
        offset: bd.offset,
        offset_hex: `0x${format(bd.offset, "04X")}`,
        byte1: bd.byte1 !== MISSING_BYTE ? bd.byte1 : null,
        byte1_hex: bd.byte1 !== MISSING_BYTE ? `0x${format(bd.byte1, "02X")}` : null,
        byte1_binary: bd.byte1 !== MISSING_BYTE ? bin8(bd.byte1) : null,
        byte2: bd.byte2 !== MISSING_BYTE ? bd.byte2 : null,
        byte2_hex: bd.byte2 !== MISSING_BYTE ? `0x${format(bd.byte2, "02X")}` : null,
        byte2_binary: bd.byte2 !== MISSING_BYTE ? bin8(bd.byte2) : null,
        bit_position: bd.bit_position,
      })),
    })),
    only_in_file1,
    only_in_file2,
    suppressed_float_diffs: suppressed,
    summary: {
      chunks_with_differences: differences.length,
      total_byte_differences: sum(differences.map((d) => d.byte_diffs.length)),
      only_in_file1: only_in_file1.length,
      only_in_file2: only_in_file2.length,
      suppressed_float_diffs: suppressed,
    },
  };
}

/** Filter results to only include paths matching the pattern. */
export function filter_differences(
  differences: ChunkDifference[],
  only_in_file1: string[],
  only_in_file2: string[],
  filter_pattern: string,
): [ChunkDifference[], string[], string[]] {
  const pattern_lower = filter_pattern.toLowerCase();
  const filtered_diffs = differences.filter((d) => d.path.toLowerCase().includes(pattern_lower));
  const filtered_only1 = only_in_file1.filter((p) => p.toLowerCase().includes(pattern_lower));
  const filtered_only2 = only_in_file2.filter((p) => p.toLowerCase().includes(pattern_lower));
  return [filtered_diffs, filtered_only1, filtered_only2];
}

// ── CLI ─────────────────────────────────────────────────────────────────────

/** Note suppressed float-precision-only diffs so they are never silent. */
export function _report_suppressed(suppressed: number, exact: boolean): void {
  if (suppressed && !exact) {
    const plural = suppressed !== 1 ? "s" : "";
    eprint(
      `Note: suppressed ${suppressed} float-precision-only chunk ` +
        `difference${plural} (use --exact to show them).`,
    );
  }
}

// TODO(port): argparse has no TS equivalent. parse_args below hand-implements only this CLI's
// option set (prefix matching, `--opt=value`, `--`, exit-2 errors, "unrecognized arguments");
// HELP/USAGE are hand-written literals, so help wrapping differs from argparse only if the
// option set or terminal width (COLUMNS) changes, and argparse edge cases (e.g. `-c4` short
// clustering, `type=int` error text for odd inputs) outside those paths are not generated.
export const PROG = "aep-compare";
export const OPTIONS = ["--help", "--json", "--filter", "--context", "--exact"];

export const USAGE =
  `usage: ${PROG} [-h] [--json] [--filter FILTER] [--context N] [--exact]\n` +
  `                   files [files ...]`;

export const HELP = `${USAGE}

Compare After Effects project files (.aep)

positional arguments:
  files                 Two or more AEP files to compare

options:
  -h, --help            show this help message and exit
  --json                Output results in JSON format
  --filter FILTER       Filter results to only show chunks matching this
                        pattern (case-insensitive)
  --context N           Show N surrounding bytes around each difference
  --exact               Byte-exact comparison; do not tolerate float-precision
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
export function parser_error(message: string): never {
  eprint(USAGE);
  eprint(`${PROG}: error: ${message}`);
  throw new SystemExit(2);
}

export function is_negative_number(arg: string): boolean {
  return /^-\d+$|^-\d*\.\d+$/.test(arg);
}

/** Long-option prefix matching as argparse does by default (allow_abbrev). */
export function resolve_option(name: string): string | null {
  if (name === "-h") return "--help";
  if (!name.startsWith("--")) return null;
  if (OPTIONS.includes(name)) return name;
  const hits = OPTIONS.filter((o) => o.startsWith(name));
  if (hits.length > 1) parser_error(`ambiguous option: ${name} could match ${hits.join(", ")}`);
  return hits.length === 1 ? hits[0] : null;
}

export type Args = {
  files: Path[];
  json: boolean;
  filter: string | null;
  context: number;
  exact: boolean;
};

export function parse_args(argv: string[]): Args {
  const out: Args = { files: [], json: false, filter: null, context: 0, exact: false };
  const positionals: string[] = [];
  const extras: string[] = [];
  // argparse with `files` nargs="+": once an option splits the run of
  // positionals, later positionals are "unrecognized arguments".
  let run_closed = false;
  let only_positional = false;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (!only_positional && arg === "--") {
      only_positional = true;
      i++;
      continue;
    }
    const is_option = !only_positional && arg.startsWith("-") && arg !== "-" && !is_negative_number(arg);
    if (!is_option) {
      if (run_closed) extras.push(arg);
      else positionals.push(arg);
      i++;
      continue;
    }

    if (positionals.length) run_closed = true;
    let name = arg;
    let value: string | null = null;
    if (arg.startsWith("--") && arg.includes("=")) {
      name = arg.slice(0, arg.indexOf("="));
      value = arg.slice(arg.indexOf("=") + 1);
    }
    const opt = resolve_option(name);
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
      if (value !== null) parser_error(`argument ${opt}: ignored explicit argument '${value}'`);
      if (opt === "--json") out.json = true;
      else out.exact = true;
      i++;
      continue;
    }

    // --filter / --context take exactly one value.
    if (value === null) {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("-") && next !== "-" && !is_negative_number(next))) {
        parser_error(`argument ${opt}: expected one argument`);
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
        parser_error(`argument --context: invalid int value: ${repr(value)}`);
      }
    }
  }

  if (!positionals.length) parser_error("the following arguments are required: files");
  if (extras.length) parser_error(`unrecognized arguments: ${extras.join(" ")}`);
  out.files = positionals.map((p) => new Path(p));
  return out;
}

/** CLI entry point for aep-compare command. */
export function main(): number {
  const args = parse_args(process.argv.slice(2));

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
    let [multi_diffs, missing, all_data, suppressed] = compare_multi_aep_files(files, args.exact);

    if (args.filter) {
      const pattern = args.filter.toLowerCase();
      multi_diffs = multi_diffs.filter((d) => d.path.toLowerCase().includes(pattern));
      missing = missing.filter(([p]) => p.toLowerCase().includes(pattern));
      suppressed = suppressed.filter((p) => p.toLowerCase().includes(pattern));
    }

    print_multi_results(files, multi_diffs, missing, args.context, all_data);
    _report_suppressed(suppressed.length, args.exact);
    return !multi_diffs?.length && !missing?.length ? 0 : 1;
  }

  // ── Two-file comparison ────────────────────────────────────────────

  const file1 = files[0];
  const file2 = files[1];

  // Parse once and reuse for both comparison and context
  const [data1, typed1] = extract_leaf_chunks_typed(file1);
  const [data2, typed2] = extract_leaf_chunks_typed(file2);
  let [diffs, only1, only2, suppressed] = _compare_chunk_dicts(data1, data2, typed1, typed2, args.exact);
  const struct_diffs = compare_structure(file1, file2);
  const ctx1 = args.context > 0 ? data1 : null;
  const ctx2 = args.context > 0 ? data2 : null;

  // Apply filter
  if (args.filter) {
    [diffs, only1, only2] = filter_differences(diffs, only1, only2, args.filter);
    const pattern = args.filter.toLowerCase();
    suppressed = suppressed.filter((p) => p.toLowerCase().includes(pattern));
  }

  // Output results
  if (args.json) {
    const output = to_json_output(file1, file2, diffs, only1, only2, suppressed.length);
    print(json_dumps(output, { indent: 2 }));
  } else {
    print_results(file1, file2, diffs, only1, only2, args.context, ctx1, ctx2, struct_diffs);
  }
  _report_suppressed(suppressed.length, args.exact);

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
