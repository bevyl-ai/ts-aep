// Port of py_aep/cos/cos.py.
//
// source: https://gitlab.com/mattbas/python-lottie/-/blob/master/lib/lottie/parsers/aep/cos.py
// documentation: https://github.com/hunger-zh/lottie-docs/blob/main/docs/aep.md#list-btdk

import { INSPECT, describe } from "../../pyrt/index.ts";
import {
  at,
  auto,
  b,
  Bytes,
  decode,
  float,
  int,
  isReal,
  unbox,
  IndexError,
  OverflowError,
  assert,
  defineEnum,
  valueEquals,
  boxFloat,
  str,
  UnicodeDecodeError,
  ValueError,
} from "../../pyrt/index.ts";
import type { EnumValue, IO, BoxedFloat } from "../../pyrt/index.ts";
import { is, pyInt } from "./kinds.ts";

// io.SEEK_CUR
export const SEEK_CUR = 1 as const;

// Python bytes.isspace() on one byte: ASCII whitespace only (space, \t, \n, \x0b, \x0c, \r).
export function isspaceB(c: number): boolean {
  return c === 0x20 || (c >= 0x09 && c <= 0x0d);
}

// Python bytes.isdigit() on one byte: ASCII digits only.
export function isdigitB(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

// Python bytes.isalpha() on one byte: ASCII letters only.
export function isalphaB(c: number): boolean {
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

// `lexIdentifier` stops before any of b"()[]<>{}/%".
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
// CPython `repr(bytes)`: double quotes when the content has `'` but no `"`.
export function reprBytes(x: Uint8Array): string {
  let hasSingle = false;
  let hasDouble = false;
  for (const c of x) {
    if (c === 0x27) hasSingle = true;
    else if (c === 0x22) hasDouble = true;
  }
  const quote = hasSingle && !hasDouble ? 0x22 : 0x27;
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

/** The enum-helper surface `enumStr` needs (a pyrt `defineEnum`). */
interface NamedEnum {
  enumName: string;
  nameOf(v: number): string;
}

// `str(member)` / `repr(member)` for an Enum member.
export function enumStr(E: NamedEnum, v: number): string {
  return `${E.enumName}.${E.nameOf(v)}`;
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
export function cosGet(data: CosNode | undefined, ...keys: (string | number)[]): CosNode {
  let cur: CosNode = data ?? null;
  for (const key of keys) {
    if (cur == null) return null;
    if (cur instanceof Map) {
      cur = cur.get(str(key)) ?? null;
    } else if (Array.isArray(cur)) {
      try {
        cur = at(cur, int(key));
      } catch (e) {
        if (e instanceof IndexError || e instanceof ValueError || e instanceof TypeError) return null;
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
 * text. `styleKey` picks the style sub-dict for paragraph ("5") and
 * character ("6") runs; kerning runs ("8") use their payload directly.
 * Runs with a missing or negative count are skipped. Shared by the
 * range models (models/text/ranges.py) and the composed-line resolver
 * (resolvers/text_composition.py).
 */
export function runSpans(doc: CosNode, docKey: string, styleKey: string | null): [number, number, CosDict][] {
  const runs = cosGet(doc, "0", docKey, "0");
  const spans: [number, number, CosDict][] = [];
  if (!Array.isArray(runs)) return spans;
  let pos = 0;
  for (const run of runs) {
    const length = run instanceof Map ? run.get("1") ?? null : null;
    // Python `isinstance(True, int)` is True, so booleans count as lengths 1/0.
    if (!is(pyInt, length)) continue;
    const n = Number(length);
    if (n < 0) continue;
    const payload = styleKey == null ? cosGet(run, "0") : cosGet(run, "0", "0", styleKey);
    spans.push([pos, pos + n, payload instanceof Map ? payload : new Map()]);
    pos += n;
  }
  return spans;
}

export const TokenType = defineEnum("TokenType", {
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
 * Any parsed COS value: a number (`BoxedFloat` when the literal had a
 * decimal point), boolean, null, string (`CosString` as parsed, a plain
 * `string` once written by py_aep; `Uint8Array` for a hex string or
 * undecodable bytes), name, array, dictionary, or an indirect-object
 * wrapper.
 */
export type CosNode =
  | null
  | boolean
  | number
  | BoxedFloat
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
    return describe("Token", { type: TokenType.nameOf(this.type), value: this.value });
  }

  equals(other: Token): boolean {
    return other instanceof Token && this.type === other.type && valueEquals(this.value, other.value);
  }
}

/** `@dataclass class IndirectObject` */
export class IndirectObject {
  declare objectNumber: number;
  declare generationNumber: number;
  declare data: CosNode;

  constructor(objectNumber: number, generationNumber: number, data: CosNode) {
    this.objectNumber = objectNumber;
    this.generationNumber = generationNumber;
    this.data = data;
  }

  [INSPECT](): string {
    return describe("IndirectObject", { objectNumber: this.objectNumber, generationNumber: this.generationNumber, data: this.data });
  }

  equals(other: IndirectObject): boolean {
    return (
      other instanceof IndirectObject &&
      this.objectNumber === other.objectNumber &&
      this.generationNumber === other.generationNumber &&
      valueEquals(this.data, other.data)
    );
  }
}

/** `@dataclass class IndirectReference` */
export class IndirectReference {
  declare objectNumber: number;
  declare generationNumber: number;

  constructor(objectNumber: number, generationNumber: number) {
    this.objectNumber = objectNumber;
    this.generationNumber = generationNumber;
  }

  [INSPECT](): string {
    return describe("IndirectReference", { objectNumber: this.objectNumber, generationNumber: this.generationNumber });
  }

  equals(other: IndirectReference): boolean {
    return (
      other instanceof IndirectReference &&
      this.objectNumber === other.objectNumber &&
      this.generationNumber === other.generationNumber
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
  declare cosUtf16: boolean;
  /**
   * The literal's own bytes, kept only when no byte-order mark said how
   * to read them and the lexer fell back to UTF-8. A PDF *text* string
   * with no BOM is PDFDocEncoding instead (PDF 32000-1 7.9.2.2), which
   * only the consumer knows to apply - see `decodePdfTextString`.
   * `null` whenever a BOM settled the encoding.
   */
  declare cosRaw: Uint8Array | null;

  constructor(value: string, kw: { utf16?: boolean; raw?: Uint8Array | null } = {}) {
    super(value);
    const { utf16 = true, raw = null } = kw;
    this.cosUtf16 = utf16;
    this.cosRaw = raw;
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
    return describe("CosName", { value: this.value });
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
    return describe("Stream", { dictionary: this.dictionary, data: this.data });
  }

  equals(other: Stream): boolean {
    return other instanceof Stream && valueEquals(this.dictionary, other.dictionary) && valueEquals(this.data, other.data);
  }
}

export class CosParser {
  declare file: IO;
  declare maxPos: number | null;
  declare lookahead: Token;

  constructor(file: IO, maxPos: number | null = null) {
    this.file = file;
    this.maxPos = maxPos;
    this.lookahead = new Token(TokenType.Eof);
  }

  parse(): CosNode {
    this.lex();
    if (this.lookahead.type === TokenType.Identifier) return this.parseDictContent();

    const val = this.parseValue();
    if (this.lookahead.type === TokenType.Eof) return val;

    return [val, ...this.parseArrayContent()];
  }

  parseValue(): CosNode {
    if (this.lookahead.type === TokenType.Identifier) {
      const name = this.lookahead.value;
      assert(typeof name === "string");
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
      assert(isReal(val));
      this.lex();
      if (this.lookahead.type === TokenType.Number) {
        const gen = this.lookahead.value;
        assert(isReal(gen));
        const state = this.saveState();
        this.lex();
        if (this.lookahead.type === TokenType.IndirectObjectStart) {
          this.lex();
          const data = this.parseValue();
          this.expect(TokenType.IndirectObjectEnd);
          this.lex();
          // A float object number equals the int it unboxes to (Python `1.0 == 1`, same hash).
          return new IndirectObject(unbox(val), unbox(gen), data);
        } else if (this.lookahead.type === TokenType.IndirectReference) {
          this.lex();
          return new IndirectReference(unbox(val), unbox(gen));
        } else {
          this.restoreState(state);
        }
      }
      return val;
    }

    if (this.lookahead.type === TokenType.ObjectStart) {
      this.lex();
      const dictionary = this.parseDictContent();
      this.expect(TokenType.ObjectEnd);
      this.lex();
      if (this.lookahead.type === TokenType.Stream) {
        const data = this.lookahead.value;
        assert(data instanceof Uint8Array);
        this.lex();
        return new Stream(dictionary, data);
      }
      return dictionary;
    }

    if (this.lookahead.type === TokenType.ArrayStart) {
      this.lex();
      const val = this.parseArrayContent();
      this.expect(TokenType.ArrayEnd);
      this.lex();
      return val;
    }

    throw new SyntaxError(`Expected COS value, got ${str(this.lookahead)}`);
  }

  saveState(): [number | null, number, Token] {
    return [this.maxPos, this.file.tell(), this.lookahead];
  }

  restoreState(state: [number | null, number, Token]): void {
    const [maxPos, pos, lookahead] = state;
    this.maxPos = maxPos;
    this.lookahead = lookahead;
    this.file.seek(pos);
  }

  parseDictContent(): CosDict {
    const value: CosDict = new Map();
    while (true) {
      if (this.lookahead.type === TokenType.Eof || this.lookahead.type === TokenType.ObjectEnd) {
        break;
      }

      this.expect(TokenType.Identifier);
      const key = this.lookahead.value;
      assert(typeof key === "string");
      this.lex();
      const val = this.parseValue();
      value.set(key, val);
    }

    return value;
  }

  parseArrayContent(): CosNode[] {
    const value: CosNode[] = [];
    while (true) {
      if (this.lookahead.type === TokenType.Eof || this.lookahead.type === TokenType.ArrayEnd) {
        break;
      }
      value.push(this.parseValue());
    }
    return value;
  }

  expect(tokenType: TokenType): void {
    if (this.lookahead.type !== tokenType) {
      throw new SyntaxError(`Expected ${enumStr(TokenType, tokenType)}, got ${str(this.lookahead)}`);
    }
  }

  lex(): void {
    this.lookahead = this.lexToken();
  }

  // The lexer works on byte values (`b"x"[0]`) rather than one-byte `bytes`
  // objects: a `read(1)` copy and a `bytesEq` per character were most of
  // the text-document parse time.
  lexToken(): Token {
    let char: number | null = null;
    while (true) {
      char = this.getChar();
      if (char == null) {
        return new Token(TokenType.Eof);
      } else if (char === PERCENT) {
        this.lexComment();
      } else if (!isspaceB(char)) {
        break;
      }
    }

    // <<
    if (char === LT) {
      const nextChar = this.getChar();
      if (nextChar === LT) {
        return new Token(TokenType.ObjectStart);
      } else if (nextChar == null) {
        return this.raiseLex(b("<"));
      } else if (this.isHex(nextChar)) {
        return this.lexHexString(nextChar);
      } else {
        return this.raiseLex(Uint8Array.of(LT, nextChar));
      }
    }

    // >>
    if (char === GT) {
      this.expectChar(GT, char);
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
      return this.lexIdentifier();
    }

    // (foo)
    if (char === LPAREN) {
      return this.lexString();
    }

    // Keyword
    if (isalphaB(char)) {
      return this.lexKeyword(char);
    }

    // Number
    if (isdigitB(char) || char === DOT || char === PLUS || char === MINUS) {
      return this.lexNumber(char);
    }

    return this.raiseLex(Uint8Array.of(char));
  }

  expectChar(exp: number, head: number): void {
    const char = this.getChar();
    if (char !== exp) {
      this.raiseLex(char == null ? Uint8Array.of(head) : Uint8Array.of(head, char), Uint8Array.of(head, exp));
    }
  }

  raiseLex(token: Uint8Array, exp: Uint8Array | null = null): never {
    let msg = `Unknown COS token ${reprBytes(token)}`;
    if (exp != null) msg += `, expected ${reprBytes(exp)}`;
    throw new SyntaxError(msg);
  }

  getChar(): number | null {
    if (this.maxPos != null) {
      if (this.maxPos <= 0) return null;
      this.maxPos -= 1;
    }
    // `read(1)` gives `b""` at the end of the data. Every lexer loop stops
    // on `None`, so passing `b""` on spun them forever on a truncated
    // document (an empty byte also matched `in b".+-"` as a number start).
    const byte = this.file.readByte();
    return byte >= 0 ? byte : null;
  }

  unget(): void {
    this.file.seek(-1, SEEK_CUR);
    if (this.maxPos != null) this.maxPos += 1;
  }

  // Skip until newline
  lexComment(): void {
    while (true) {
      const char = this.getChar();
      if (char === NEWLINE) {
        break;
      } else if (char == null) {
        break;
      }
    }
  }

  lexNumber(char: number): Token {
    if (char === DOT) {
      return this.lexNumFract(this.getChar(), ".");
    } else if (char === PLUS || char === MINUS) {
      return this.lexNumInt(this.getChar(), String.fromCharCode(char));
    } else {
      return this.lexNumInt(char, "");
    }
  }

  lexNumInt(char: number | null, head: string): Token {
    while (true) {
      if (char == null) {
        break;
      } else if (char === DOT) {
        return this.lexNumFract(this.getChar(), head + ".");
      } else if (isdigitB(char)) {
        head += String.fromCharCode(char);
        char = this.getChar();
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

  lexNumFract(char: number | null, head: string): Token {
    while (true) {
      if (char == null) {
        break;
      } else if (isdigitB(char)) {
        head += String.fromCharCode(char);
        char = this.getChar();
      } else {
        this.unget();
        break;
      }
    }
    // Boxed so an integral float ("2.0") stays a float through copies and re-serialization.
    return new Token(TokenType.Number, boxFloat(float(head)));
  }

  lexKeyword(char: number): Token {
    // Keywords are ASCII letters only (`isalphaB`), so a latin1 string holds them exactly.
    let kw = String.fromCharCode(char);
    while (true) {
      const nextChar = this.getChar();
      if (nextChar == null) {
        break;
      } else if (isalphaB(nextChar)) {
        kw += String.fromCharCode(nextChar);
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
      return this.lexStream();
    } else if (kw === "xref") {
      return new Token(TokenType.Eof);
    } else {
      throw new SyntaxError(`Unknown keyword ${reprBytes(b(kw))}`);
    }
  }

  lexStream(): Token {
    const char = this.getChar();
    if (char === CR) {
      if (this.getChar() !== NEWLINE) throw new SyntaxError("Invalid newline");
    } else if (char !== NEWLINE) {
      throw new SyntaxError("Expected newline after `stream`");
    }

    // Read in blocks up to the first `endstream`: a byte at a time (with a
    // growing bytes object) took seconds for a 0.5 MB embedded ICC profile.
    // `stream` is a bytearray: a buffer we own, grown by doubling.
    const marker = b("endstream");
    let stream = new Uint8Array(65536);
    let streamLen = 0;
    while (true) {
      const size = this.maxPos == null ? 65536 : Math.min(65536, this.maxPos);
      const block = size > 0 ? this.file.read(size) : Bytes.EMPTY;
      if (!block.length) throw new SyntaxError("Unterminated stream");
      if (this.maxPos != null) this.maxPos -= block.length;
      const searchFrom = Math.max(0, streamLen - marker.length + 1);
      if (streamLen + block.length > stream.length) {
        const grown = new Uint8Array(Math.max(streamLen + block.length, stream.length * 2));
        grown.set(stream.subarray(0, streamLen));
        stream = grown;
      }
      stream.set(block, streamLen);
      streamLen += block.length;
      const end = Bytes.indexOf(stream.subarray(0, streamLen), marker, searchFrom);
      if (end >= 0) {
        // Give back what was read past the marker.
        const extra = streamLen - end - marker.length;
        this.file.seek(-extra, SEEK_CUR);
        if (this.maxPos != null) this.maxPos += extra;
        return new Token(TokenType.Stream, stream.slice(0, end));
      }
    }
  }

  lexString(): Token {
    // Read the entire string content first
    const acc: number[] = [];
    while (true) {
      const char = this.lexStringChar();
      if (char == null) break;
      acc.push(char);
    }
    let string: Uint8Array = Uint8Array.from(acc);

    // Default to UTF-8 encoding
    let encoding = "utf-8";
    let noBom = false;

    // Check for BOM at the start of the string and remove it
    if (Bytes.startsWith(string, b("\xef\xbb\xbf"))) {
      // UTF-8 BOM - remove it (3 bytes)
      string = string.slice(3);
    } else if (Bytes.startsWith(string, b("\xfe\xff"))) {
      // UTF-16 BE BOM - remove it (2 bytes)
      string = string.slice(2);
      encoding = "utf-16-be";
    } else if (Bytes.startsWith(string, b("\xff\xfe"))) {
      // UTF-16 LE BOM - remove it (2 bytes)
      string = string.slice(2);
      encoding = "utf-16-le";
    } else {
      noBom = true;
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
        raw: noBom ? string : null,
      }),
    );
  }

  lexStringChar(): number | null {
    const char = this.getChar();
    if (char == null) {
      throw new SyntaxError("Unterminated string");
    } else if (char === RPAREN) {
      return null;
    } else if (char === BACKSLASH) {
      return this.lexStringEscape();
    } else {
      // AE's COS strings hold binary UTF-16 data, so a raw 0x0d / 0x0a
      // byte is part of a character (e.g. U+300D), not a line ending.
      // Preserve it verbatim - normalizing CR/CRLF to LF (per the COS
      // spec for text) would corrupt the data and break round-trip.
      return char;
    }
  }

  lexStringEscape(): number {
    const char = this.getChar();
    if (char == null) throw new SyntaxError("Unterminated string");

    const escaped = STRING_ESCAPES.get(char);
    if (escaped != null) {
      return escaped;
    } else if (this.isOctal(char)) {
      let octal = char - 0x30; // ord(b"0")
      for (let k = 0; k < 2; k++) {
        const nextChar = this.getChar();
        if (nextChar == null) {
          break;
        } else if (!this.isOctal(nextChar)) {
          this.unget();
          break;
        }
        octal = octal * 8 + nextChar - 0x30;
      }
      // Python's `octal.to_bytes(1, "big")`: values past one byte overflow.
      if (octal > 255) throw new OverflowError("int too big to convert");
      return octal;
    }

    throw new SyntaxError("Invalid escape sequence");
  }

  isOctal(char: number): boolean {
    return char >= 0x30 && char <= 0x37; // b"0" <= char <= b"7"
  }

  isHex(char: number): boolean {
    return isdigitB(char) || (char >= 0x61 && char <= 0x66) || (char >= 0x41 && char <= 0x46);
  }

  lexHexString(hstrFirst: number): Token {
    let hstr = String.fromCharCode(hstrFirst);
    while (true) {
      const char = this.getChar();
      if (char == null) {
        throw new SyntaxError("Unterminated hex string");
      } else if (this.isHex(char)) {
        hstr += String.fromCharCode(char);
      } else if (char === GT) {
        break;
      } else if (!isspaceB(char)) {
        throw new SyntaxError(`Invalid character in hex string: ${reprBytes(Uint8Array.of(char))}`);
      }
    }

    if (hstr.length % 2) hstr += "0";

    const data = new Uint8Array(hstr.length / 2);
    for (let i = 0; i < hstr.length; i += 2) {
      data[i / 2] = int(hstr.slice(i, i + 2), 16);
    }
    return new Token(TokenType.HexString, data);
  }

  lexIdentifier(): Token {
    let ident = "";
    while (true) {
      let char = this.getChar();
      if (char == null) {
        break;
      } else if (char < 0x21 || char > 0x7e) {
        // char < b"!" or char > b"~"
        this.unget();
        break;
      } else if (char === HASH) {
        let hexstr = "";
        for (let k = 0; k < 2; k++) {
          char = this.getChar();
          if (char == null || !this.isHex(char)) throw new SyntaxError("Invalid identifier");
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
