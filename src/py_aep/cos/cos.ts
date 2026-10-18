// Port of py_aep/cos/cos.py.
//
// source: https://gitlab.com/mattbas/python-lottie/-/blob/master/lib/lottie/parsers/aep/cos.py
// documentation: https://github.com/hunger-zh/lottie-docs/blob/main/docs/aep.md#list-btdk

import { INSPECT } from "../../pyrt/index.ts";
import {
  at,
  auto,
  b,
  bytes_,
  decode,
  float,
  int,
  is_real,
  unbox,
  IndexError,
  OverflowError,
  py_assert,
  py_enum,
  py_eq,
  pyfloat,
  repr,
  str,
  SyntaxError_,
  TypeError_,
  UnicodeDecodeError,
  ValueError,
} from "../../pyrt/index.ts";
import type { EnumValue, IO, PyFloat } from "../../pyrt/index.ts";
import { is, py_int } from "./kinds.ts";

export { SyntaxError_ };

// io.SEEK_CUR
export const SEEK_CUR = 1 as const;

// Python bytes.isspace() on one byte: ASCII whitespace only (space, \t, \n, \x0b, \x0c, \r).
export function isspace_b(c: number): boolean {
  return c === 0x20 || (c >= 0x09 && c <= 0x0d);
}

// Python bytes.isdigit() on one byte: ASCII digits only.
export function isdigit_b(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

// Python bytes.isalpha() on one byte: ASCII letters only.
export function isalpha_b(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

// Byte values the lexer compares against.
const NEWLINE = 0x0a; // b"\n"
const CR = 0x0d; // b"\r"
const HASH = 0x23; // b"#"
const PERCENT = 0x25; // b"%"
const LPAREN = 0x28; // b"("
const RPAREN = 0x29; // b")"
const PLUS = 0x2b; // b"+"
const MINUS = 0x2d; // b"-"
const DOT = 0x2e; // b"."
const SLASH = 0x2f; // b"/"
const LT = 0x3c; // b"<"
const GT = 0x3e; // b">"
const LBRACKET = 0x5b; // b"["
const BACKSLASH = 0x5c; // b"\\"
const RBRACKET = 0x5d; // b"]"

// `lex_identifier` stops before any of b"()[]<>{}/%".
const IDENTIFIER_DELIMITERS: ReadonlySet<number> = new Set(Array.from("()[]<>{}/%", (c) => c.charCodeAt(0)));

// `\x` string escapes with a fixed byte (octal escapes are handled separately).
const STRING_ESCAPES: ReadonlyMap<number, number> = new Map([
  [0x6e, NEWLINE], // \n
  [0x72, CR], // \r
  [0x62, 0x08], // \b
  [0x66, 0x0c], // \f
  [LPAREN, LPAREN],
  [RPAREN, RPAREN],
  [BACKSLASH, BACKSLASH],
]);

// Python's dataclass repr uses repr() on each field; dicts and lists need to
// recurse so nested Maps print like Python dicts.
export function repr_field(x: CosNode): string {
  if (x instanceof Map) {
    return `{${[...x].map(([k, v]) => `${repr_field(k)}: ${repr_field(v)}`).join(", ")}}`;
  }
  if (Array.isArray(x)) return `[${x.map((y) => repr_field(y)).join(", ")}]`;
  if (x instanceof Uint8Array) return repr_bytes(x);
  return repr(x);
}

// CPython `repr(bytes)`: double quotes when the content has `'` but no `"`.
export function repr_bytes(x: Uint8Array): string {
  let has_single = false;
  let has_double = false;
  for (const c of x) {
    if (c === 0x27) has_single = true;
    else if (c === 0x22) has_double = true;
  }
  const quote = has_single && !has_double ? 0x22 : 0x27;
  let s = "";
  for (const c of x) {
    if (c === quote || c === 0x5c) s += "\\" + String.fromCharCode(c);
    else if (c === 0x09) s += "\\t";
    else if (c === 0x0a) s += "\\n";
    else if (c === 0x0d) s += "\\r";
    else if (c >= 0x20 && c < 0x7f) s += String.fromCharCode(c);
    else s += "\\x" + c.toString(16).padStart(2, "0");
  }
  const q = String.fromCharCode(quote);
  return `b${q}${s}${q}`;
}

/** The enum-helper surface `enum_str` needs (a pyrt `py_enum`). */
interface NamedEnum {
  __name__: string;
  name_of(v: number): string;
}

// `str(member)` / `repr(member)` for an Enum member.
export function enum_str(E: NamedEnum, v: number): string {
  return `${E.__name__}.${E.name_of(v)}`;
}

export function enum_repr(E: NamedEnum, v: number): string {
  return `<${enum_str(E, v)}: ${v}>`;
}

/**
 * Safely traverse parsed COS data by successive keys.
 *
 * Each key is tried as a Map string key first and then as an array
 * index. Returns `null` when any step along the path is missing.
 *
 * @example
 * :
 *
 * cos_get(data, "1", "1", 0, "0", "0")  // -\> text string
 */
export function cos_get(data: CosNode | undefined, ...keys: (string | number)[]): CosNode {
  let cur: CosNode = data ?? null;
  for (const key of keys) {
    if (cur == null) return null;
    if (cur instanceof Map) {
      cur = cur.get(str(key)) ?? null;
    } else if (Array.isArray(cur)) {
      try {
        cur = at(cur, int(key));
      } catch (e) {
        if (e instanceof IndexError || e instanceof ValueError || e instanceof TypeError_) return null;
        throw e;
      }
    } else {
      return null;
    }
  }
  return cur;
}

/**
 * Decode a text document's COS run array into `(start, end, payload)`.
 *
 * Run arrays (`doc["0"]["5"/"6"/"8"]["0"]`) store `{"0": payload, "1": count}` entries whose counts are UTF-16 units over the raw
 * text. `style_key` picks the style sub-dict for paragraph ("5") and
 * character ("6") runs; kerning runs ("8") use their payload directly.
 * Runs with a missing or negative count are skipped. Shared by the
 * range models (models/text/ranges.py) and the composed-line resolver
 * (resolvers/text_composition.py).
 */
export function run_spans(doc: CosNode, doc_key: string, style_key: string | null): [number, number, CosDict][] {
  const runs = cos_get(doc, "0", doc_key, "0");
  const spans: [number, number, CosDict][] = [];
  if (!Array.isArray(runs)) return spans;
  let pos = 0;
  for (const run of runs) {
    const length = run instanceof Map ? run.get("1") ?? null : null;
    // Python `isinstance(True, int)` is True, so booleans count as lengths 1/0.
    if (!is(py_int, length)) continue;
    const n = Number(length);
    if (n < 0) continue;
    const payload = style_key == null ? cos_get(run, "0") : cos_get(run, "0", "0", style_key);
    spans.push([pos, pos + n, payload instanceof Map ? payload : new Map()]);
    pos += n;
  }
  return spans;
}

export const TokenType = py_enum("TokenType", {
  Identifier: auto(), // /foo
  Number: auto(), // 123
  String: auto(), // (foo)
  HexString: auto(), // <f000>
  Boolean: auto(), // true
  ObjectStart: auto(), // <<
  ObjectEnd: auto(), // >>
  ArrayStart: auto(), // [
  ArrayEnd: auto(), // ]
  Null: auto(), // null
  Eof: auto(), // end of file
  IndirectObjectStart: auto(), // obj
  IndirectObjectEnd: auto(), // endobj
  IndirectReference: auto(), // R
  Stream: auto(), // stream...endstream
});
export type TokenType = EnumValue<typeof TokenType>;

/**
 * Any parsed COS value: a number (`PyFloat` when the literal had a
 * decimal point), boolean, null, string (`CosString` as parsed, a plain
 * `string` once written by py_aep; `Uint8Array` for a hex string or
 * undecodable bytes), name, array, dictionary, or an indirect-object
 * wrapper.
 */
export type CosNode =
  | null
  | boolean
  | number
  | PyFloat
  | string
  | CosString
  | Uint8Array
  | CosName
  | IndirectObject
  | IndirectReference
  | Stream
  | CosNode[]
  | CosDict;

/** A parsed COS dictionary. Insertion order is the serialized key order. */
export interface CosDict extends Map<string, CosNode> {}

/** `@dataclass class Token` */
export class Token {
  declare type: TokenType;
  declare value: CosNode;

  constructor(type: TokenType, value: CosNode = null) {
    this.type = type;
    this.value = value;
  }

  [INSPECT](): string {
    return `Token(type=${enum_repr(TokenType, this.type)}, value=${repr_field(this.value)})`;
  }

  equals(other: Token): boolean {
    return other instanceof Token && this.type === other.type && py_eq(this.value, other.value);
  }
}

/** `@dataclass class IndirectObject` */
export class IndirectObject {
  declare object_number: number;
  declare generation_number: number;
  declare data: CosNode;

  constructor(object_number: number, generation_number: number, data: CosNode) {
    this.object_number = object_number;
    this.generation_number = generation_number;
    this.data = data;
  }

  [INSPECT](): string {
    return `IndirectObject(object_number=${repr(this.object_number)}, generation_number=${repr(this.generation_number)}, data=${repr_field(this.data)})`;
  }

  equals(other: IndirectObject): boolean {
    return (
      other instanceof IndirectObject &&
      this.object_number === other.object_number &&
      this.generation_number === other.generation_number &&
      py_eq(this.data, other.data)
    );
  }
}

/** `@dataclass class IndirectReference` */
export class IndirectReference {
  declare object_number: number;
  declare generation_number: number;

  constructor(object_number: number, generation_number: number) {
    this.object_number = object_number;
    this.generation_number = generation_number;
  }

  [INSPECT](): string {
    return `IndirectReference(object_number=${repr(this.object_number)}, generation_number=${repr(this.generation_number)})`;
  }

  equals(other: IndirectReference): boolean {
    return (
      other instanceof IndirectReference &&
      this.object_number === other.object_number &&
      this.generation_number === other.generation_number
    );
  }
}

/**
 * A COS string literal that remembers its on-disk encoding.
 *
 * After Effects writes some string literals as UTF-16 BE (with a BOM,
 * e.g. visible text) and others as raw ASCII / UTF-8 (e.g. bit-flag
 * strings like `00001000...`). The encoding cannot be inferred from
 * the decoded content, so it is preserved here for byte-faithful
 * re-serialization. Behaves exactly like `str` otherwise. New strings
 * created without this wrapper default to UTF-16 on write.
 */
export class CosString extends String {
  /** Whether the literal was UTF-16 BE (the default for new strings). */
  declare cos_utf16: boolean;
  /**
   * The literal's own bytes, kept only when no byte-order mark said how
   * to read them and the lexer fell back to UTF-8. A PDF *text* string
   * with no BOM is PDFDocEncoding instead (PDF 32000-1 7.9.2.2), which
   * only the consumer knows to apply - see `decode_pdf_text_string`.
   * `null` whenever a BOM settled the encoding.
   */
  declare cos_raw: Uint8Array | null;

  constructor(value: string, kw: { utf16?: boolean; raw?: Uint8Array | null } = {}) {
    super(value);
    const { utf16 = true, raw = null } = kw;
    this.cos_utf16 = utf16;
    this.cos_raw = raw;
  }
}

/** A COS name object used as a value (e.g. `/CoolTypeFont`). */
export class CosName {
  /**
   * Distinct from a dict key identifier: when serialized, a CosName
   * writes `/name` while a plain `str` writes `(string)`.
   */
  declare value: string;

  constructor(value: string) {
    this.value = value;
  }

  toString(): string {
    return this.value;
  }

  [INSPECT](): string {
    return `CosName(value=${repr(this.value)})`;
  }

  equals(other: CosName): boolean {
    return other instanceof CosName && this.value === other.value;
  }
}

/** `@dataclass class Stream` */
export class Stream {
  declare dictionary: CosDict;
  declare data: Uint8Array;

  constructor(dictionary: CosDict, data: Uint8Array) {
    this.dictionary = dictionary;
    this.data = data;
  }

  [INSPECT](): string {
    return `Stream(dictionary=${repr_field(this.dictionary)}, data=${repr_bytes(this.data)})`;
  }

  equals(other: Stream): boolean {
    return other instanceof Stream && py_eq(this.dictionary, other.dictionary) && py_eq(this.data, other.data);
  }
}

export class CosParser {
  declare file: IO;
  declare max_pos: number | null;
  declare lookahead: Token;

  constructor(file: IO, max_pos: number | null = null) {
    this.file = file;
    this.max_pos = max_pos;
    this.lookahead = new Token(TokenType.Eof);
  }

  parse(): CosNode {
    this.lex();
    if (this.lookahead.type === TokenType.Identifier) return this.parse_dict_content();

    const val = this.parse_value();
    if (this.lookahead.type === TokenType.Eof) return val;

    return [val, ...this.parse_array_content()];
  }

  parse_value(): CosNode {
    if (this.lookahead.type === TokenType.Identifier) {
      const name = this.lookahead.value;
      py_assert(typeof name === "string");
      const val = new CosName(name);
      this.lex();
      return val;
    }

    if (
      this.lookahead.type === TokenType.String ||
      this.lookahead.type === TokenType.HexString ||
      this.lookahead.type === TokenType.Null ||
      this.lookahead.type === TokenType.Boolean ||
      this.lookahead.type === TokenType.Stream
    ) {
      const val = this.lookahead.value;
      this.lex();
      return val;
    }

    if (this.lookahead.type === TokenType.Number) {
      const val = this.lookahead.value;
      py_assert(is_real(val));
      this.lex();
      if (this.lookahead.type === TokenType.Number) {
        const gen = this.lookahead.value;
        py_assert(is_real(gen));
        const state = this.save_state();
        this.lex();
        if (this.lookahead.type === TokenType.IndirectObjectStart) {
          this.lex();
          const data = this.parse_value();
          this.expect(TokenType.IndirectObjectEnd);
          this.lex();
          // A float object number equals the int it unboxes to (Python `1.0 == 1`, same hash).
          return new IndirectObject(unbox(val), unbox(gen), data);
        } else if (this.lookahead.type === TokenType.IndirectReference) {
          this.lex();
          return new IndirectReference(unbox(val), unbox(gen));
        } else {
          this.restore_state(state);
        }
      }
      return val;
    }

    if (this.lookahead.type === TokenType.ObjectStart) {
      this.lex();
      const dictionary = this.parse_dict_content();
      this.expect(TokenType.ObjectEnd);
      this.lex();
      if (this.lookahead.type === TokenType.Stream) {
        const data = this.lookahead.value;
        py_assert(data instanceof Uint8Array);
        this.lex();
        return new Stream(dictionary, data);
      }
      return dictionary;
    }

    if (this.lookahead.type === TokenType.ArrayStart) {
      this.lex();
      const val = this.parse_array_content();
      this.expect(TokenType.ArrayEnd);
      this.lex();
      return val;
    }

    throw new SyntaxError_(`Expected COS value, got ${str(this.lookahead)}`);
  }

  save_state(): [number | null, number, Token] {
    return [this.max_pos, this.file.tell(), this.lookahead];
  }

  restore_state(state: [number | null, number, Token]): void {
    const [max_pos, pos, lookahead] = state;
    this.max_pos = max_pos;
    this.lookahead = lookahead;
    this.file.seek(pos);
  }

  parse_dict_content(): CosDict {
    const value: CosDict = new Map();
    while (true) {
      if (this.lookahead.type === TokenType.Eof || this.lookahead.type === TokenType.ObjectEnd) {
        break;
      }

      this.expect(TokenType.Identifier);
      const key = this.lookahead.value;
      py_assert(typeof key === "string");
      this.lex();
      const val = this.parse_value();
      value.set(key, val);
    }

    return value;
  }

  parse_array_content(): CosNode[] {
    const value: CosNode[] = [];
    while (true) {
      if (this.lookahead.type === TokenType.Eof || this.lookahead.type === TokenType.ArrayEnd) {
        break;
      }
      value.push(this.parse_value());
    }
    return value;
  }

  expect(token_type: TokenType): void {
    if (this.lookahead.type !== token_type) {
      throw new SyntaxError_(`Expected ${enum_str(TokenType, token_type)}, got ${str(this.lookahead)}`);
    }
  }

  lex(): void {
    this.lookahead = this.lex_token();
  }

  // The lexer works on byte values (`b"x"[0]`) rather than one-byte `bytes`
  // objects: a `read(1)` copy and a `bytes_eq` per character were most of
  // the text-document parse time.
  lex_token(): Token {
    let char: number | null = null;
    while (true) {
      char = this.get_char();
      if (char == null) {
        return new Token(TokenType.Eof);
      } else if (char === PERCENT) {
        this.lex_comment();
      } else if (!isspace_b(char)) {
        break;
      }
    }

    // <<
    if (char === LT) {
      const next_char = this.get_char();
      if (next_char === LT) {
        return new Token(TokenType.ObjectStart);
      } else if (next_char == null) {
        return this.raise_lex(b("<"));
      } else if (this.is_hex(next_char)) {
        return this.lex_hex_string(next_char);
      } else {
        return this.raise_lex(Uint8Array.of(LT, next_char));
      }
    }

    // >>
    if (char === GT) {
      this.expect_char(GT, char);
      return new Token(TokenType.ObjectEnd);
    }

    // [
    if (char === LBRACKET) {
      return new Token(TokenType.ArrayStart);
    }

    // ]
    if (char === RBRACKET) {
      return new Token(TokenType.ArrayEnd);
    }

    // /foo
    if (char === SLASH) {
      return this.lex_identifier();
    }

    // (foo)
    if (char === LPAREN) {
      return this.lex_string();
    }

    // Keyword
    if (isalpha_b(char)) {
      return this.lex_keyword(char);
    }

    // Number
    if (isdigit_b(char) || char === DOT || char === PLUS || char === MINUS) {
      return this.lex_number(char);
    }

    return this.raise_lex(Uint8Array.of(char));
  }

  expect_char(exp: number, head: number): void {
    const char = this.get_char();
    if (char !== exp) {
      this.raise_lex(char == null ? Uint8Array.of(head) : Uint8Array.of(head, char), Uint8Array.of(head, exp));
    }
  }

  raise_lex(token: Uint8Array, exp: Uint8Array | null = null): never {
    let msg = `Unknown COS token ${repr_bytes(token)}`;
    if (exp != null) msg += `, expected ${repr_bytes(exp)}`;
    throw new SyntaxError_(msg);
  }

  get_char(): number | null {
    if (this.max_pos != null) {
      if (this.max_pos <= 0) return null;
      this.max_pos -= 1;
    }
    // `read(1)` gives `b""` at the end of the data. Every lexer loop stops
    // on `None`, so passing `b""` on spun them forever on a truncated
    // document (an empty byte also matched `in b".+-"` as a number start).
    const byte = this.file.read_byte();
    return byte >= 0 ? byte : null;
  }

  unget(): void {
    this.file.seek(-1, SEEK_CUR);
    if (this.max_pos != null) this.max_pos += 1;
  }

  // Skip until newline
  lex_comment(): void {
    while (true) {
      const char = this.get_char();
      if (char === NEWLINE) {
        break;
      } else if (char == null) {
        break;
      }
    }
  }

  lex_number(char: number): Token {
    if (char === DOT) {
      return this.lex_num_fract(this.get_char(), ".");
    } else if (char === PLUS || char === MINUS) {
      return this.lex_num_int(this.get_char(), String.fromCharCode(char));
    } else {
      return this.lex_num_int(char, "");
    }
  }

  lex_num_int(char: number | null, head: string): Token {
    while (true) {
      if (char == null) {
        break;
      } else if (char === DOT) {
        return this.lex_num_fract(this.get_char(), head + ".");
      } else if (isdigit_b(char)) {
        head += String.fromCharCode(char);
        char = this.get_char();
      } else {
        this.unget();
        break;
      }
    }
    // TODO(port): Python's int() is exact; COS integers are JS numbers throughout CosNode,
    // the kinds and the serializer, so a literal beyond 2**53 (e.g. 9007199254740993) rounds
    // to the nearest double and re-serializes rounded.
    // Python's int() gets bytes, so its error message shows b'+' rather than '+'.
    let value: number;
    try {
      value = int(head);
    } catch (e) {
      if (e instanceof ValueError) {
        throw new ValueError(`invalid literal for int() with base 10: b'${head}'`);
      }
      throw e;
    }
    // `+ 0` turns int("-0") from -0 into 0 like Python.
    return new Token(TokenType.Number, value + 0);
  }

  lex_num_fract(char: number | null, head: string): Token {
    while (true) {
      if (char == null) {
        break;
      } else if (isdigit_b(char)) {
        head += String.fromCharCode(char);
        char = this.get_char();
      } else {
        this.unget();
        break;
      }
    }
    // Boxed so an integral float ("2.0") stays a float through copies and re-serialization.
    return new Token(TokenType.Number, pyfloat(float(head)));
  }

  lex_keyword(char: number): Token {
    // Keywords are ASCII letters only (`isalpha_b`), so a latin1 string holds them exactly.
    let kw = String.fromCharCode(char);
    while (true) {
      const next_char = this.get_char();
      if (next_char == null) {
        break;
      } else if (isalpha_b(next_char)) {
        kw += String.fromCharCode(next_char);
      } else {
        this.unget();
        break;
      }
    }

    if (kw === "true") {
      return new Token(TokenType.Boolean, true);
    } else if (kw === "false") {
      return new Token(TokenType.Boolean, false);
    } else if (kw === "null") {
      return new Token(TokenType.Null, null);
    } else if (kw === "obj") {
      return new Token(TokenType.IndirectObjectStart);
    } else if (kw === "endobj") {
      return new Token(TokenType.IndirectObjectEnd);
    } else if (kw === "R") {
      return new Token(TokenType.IndirectReference);
    } else if (kw === "stream") {
      return this.lex_stream();
    } else if (kw === "xref") {
      return new Token(TokenType.Eof);
    } else {
      throw new SyntaxError_(`Unknown keyword ${repr_bytes(b(kw))}`);
    }
  }

  lex_stream(): Token {
    const char = this.get_char();
    if (char === CR) {
      if (this.get_char() !== NEWLINE) throw new SyntaxError_("Invalid newline");
    } else if (char !== NEWLINE) {
      throw new SyntaxError_("Expected newline after `stream`");
    }

    // Read in blocks up to the first `endstream`: a byte at a time (with a
    // growing bytes object) took seconds for a 0.5 MB embedded ICC profile.
    // `stream` is a bytearray: a buffer we own, grown by doubling.
    const marker = b("endstream");
    let stream = new Uint8Array(65536);
    let stream_len = 0;
    while (true) {
      const size = this.max_pos == null ? 65536 : Math.min(65536, this.max_pos);
      const block = size > 0 ? this.file.read(size) : bytes_.EMPTY;
      if (!block.length) throw new SyntaxError_("Unterminated stream");
      if (this.max_pos != null) this.max_pos -= block.length;
      const search_from = Math.max(0, stream_len - marker.length + 1);
      if (stream_len + block.length > stream.length) {
        const grown = new Uint8Array(Math.max(stream_len + block.length, stream.length * 2));
        grown.set(stream.subarray(0, stream_len));
        stream = grown;
      }
      stream.set(block, stream_len);
      stream_len += block.length;
      const end = bytes_.find(stream.subarray(0, stream_len), marker, search_from);
      if (end >= 0) {
        // Give back what was read past the marker.
        const extra = stream_len - end - marker.length;
        this.file.seek(-extra, SEEK_CUR);
        if (this.max_pos != null) this.max_pos += extra;
        return new Token(TokenType.Stream, stream.slice(0, end));
      }
    }
  }

  lex_string(): Token {
    // Read the entire string content first
    const acc: number[] = [];
    while (true) {
      const char = this.lex_string_char();
      if (char == null) break;
      acc.push(char);
    }
    let string: Uint8Array = Uint8Array.from(acc);

    // Default to UTF-8 encoding
    let encoding = "utf-8";
    let no_bom = false;

    // Check for BOM at the start of the string and remove it
    if (bytes_.startswith(string, b("\xef\xbb\xbf"))) {
      // UTF-8 BOM - remove it (3 bytes)
      string = bytes_.slice(string, 3);
    } else if (bytes_.startswith(string, b("\xfe\xff"))) {
      // UTF-16 BE BOM - remove it (2 bytes)
      string = bytes_.slice(string, 2);
      encoding = "utf-16-be";
    } else if (bytes_.startswith(string, b("\xff\xfe"))) {
      // UTF-16 LE BOM - remove it (2 bytes)
      string = bytes_.slice(string, 2);
      encoding = "utf-16-le";
    } else {
      no_bom = true;
    }

    let decoded: string;
    try {
      decoded = decode(string, encoding);
    } catch (e) {
      if (!(e instanceof UnicodeDecodeError)) throw e;
      return new Token(TokenType.String, string);
    }
    return new Token(
      TokenType.String,
      new CosString(decoded, {
        utf16: encoding === "utf-16-be",
        raw: no_bom ? string : null,
      }),
    );
  }

  lex_string_char(): number | null {
    const char = this.get_char();
    if (char == null) {
      throw new SyntaxError_("Unterminated string");
    } else if (char === RPAREN) {
      return null;
    } else if (char === BACKSLASH) {
      return this.lex_string_escape();
    } else {
      // AE's COS strings hold binary UTF-16 data, so a raw 0x0d / 0x0a
      // byte is part of a character (e.g. U+300D), not a line ending.
      // Preserve it verbatim - normalizing CR/CRLF to LF (per the COS
      // spec for text) would corrupt the data and break round-trip.
      return char;
    }
  }

  lex_string_escape(): number {
    const char = this.get_char();
    if (char == null) throw new SyntaxError_("Unterminated string");

    const escaped = STRING_ESCAPES.get(char);
    if (escaped != null) {
      return escaped;
    } else if (this.is_octal(char)) {
      let octal = char - 0x30; // ord(b"0")
      for (let k = 0; k < 2; k++) {
        const next_char = this.get_char();
        if (next_char == null) {
          break;
        } else if (!this.is_octal(next_char)) {
          this.unget();
          break;
        }
        octal = octal * 8 + next_char - 0x30;
      }
      // Python's `octal.to_bytes(1, "big")`: values past one byte overflow.
      if (octal > 255) throw new OverflowError("int too big to convert");
      return octal;
    }

    throw new SyntaxError_("Invalid escape sequence");
  }

  is_octal(char: number): boolean {
    return char >= 0x30 && char <= 0x37; // b"0" <= char <= b"7"
  }

  is_hex(char: number): boolean {
    return isdigit_b(char) || (char >= 0x61 && char <= 0x66) || (char >= 0x41 && char <= 0x46);
  }

  lex_hex_string(hstr_first: number): Token {
    let hstr = String.fromCharCode(hstr_first);
    while (true) {
      const char = this.get_char();
      if (char == null) {
        throw new SyntaxError_("Unterminated hex string");
      } else if (this.is_hex(char)) {
        hstr += String.fromCharCode(char);
      } else if (char === GT) {
        break;
      } else if (!isspace_b(char)) {
        throw new SyntaxError_(`Invalid character in hex string: ${repr_bytes(Uint8Array.of(char))}`);
      }
    }

    if (hstr.length % 2) hstr += "0";

    const data = new Uint8Array(hstr.length / 2);
    for (let i = 0; i < hstr.length; i += 2) {
      data[i / 2] = int(hstr.slice(i, i + 2), 16);
    }
    return new Token(TokenType.HexString, data);
  }

  lex_identifier(): Token {
    let ident = "";
    while (true) {
      let char = this.get_char();
      if (char == null) {
        break;
      } else if (char < 0x21 || char > 0x7e) {
        // char < b"!" or char > b"~"
        this.unget();
        break;
      } else if (char === HASH) {
        let hexstr = "";
        for (let k = 0; k < 2; k++) {
          char = this.get_char();
          if (char == null || !this.is_hex(char)) throw new SyntaxError_("Invalid identifier");
          hexstr += String.fromCharCode(char);
        }
        ident += String.fromCodePoint(int(hexstr, 16));
      } else if (IDENTIFIER_DELIMITERS.has(char)) {
        this.unget();
        break;
      } else {
        ident += String.fromCodePoint(char);
      }
    }

    return new Token(TokenType.Identifier, ident);
  }
}
