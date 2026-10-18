/**
 * Serialize objects back to COS (Carousel Object Syntax) binary.
 *
 * This is the inverse of `CosParser.parse`: it takes a nested
 * structure (Maps, arrays, strings, numbers, bools, `null`,
 * `IndirectObject`, `IndirectReference`, `Stream`) and emits COS-format
 * bytes suitable for writing back into a btdk chunk's `binary_data`.
 */

import { ByteStream, Bytes, concat, encode, BoxedFloat, typeName, unbox, ascii } from "../../pyrt/index.ts";
import { CosName, CosString, IndirectObject, IndirectReference, Stream, type CosDict, type CosNode } from "./cos.ts";

// Literals written per token, built once (`ByteStream.write` copies them).
const SPACE = ascii(" ");
const TRUE = ascii("true");
const FALSE = ascii("false");
const NULL = ascii("null");
const SLASH = ascii("/");
const LPAREN = ascii("(");
const RPAREN = ascii(")");

/**
 * Serialize a parsed COS value tree back to binary.
 *
 * @param data - The object tree to serialize. May be a Map, array,
 *   string, number, boolean, `null`, `bytes`,
 *   `IndirectObject`, `IndirectReference`, or `Stream`.
 * @returns The COS binary representation.
 */
export function serialize(data: CosNode): Uint8Array {
  const buf = new ByteStream();
  // AE's btdk blob begins with a leading space before the first token.
  buf.write(SPACE);
  _writeValue(buf, data, { topLevel: true });
  return buf.toBytes();
}

/** Write a space separator unless the buffer already ends with whitespace. */
function _space(buf: ByteStream): void {
  const pos = buf.tell();
  if (pos === 0) return;
  buf.seek(pos - 1);
  const last = buf.readByte();
  // b" \t\n\r"
  if (!(last === 0x20 || last === 0x09 || last === 0x0a || last === 0x0d)) buf.write(SPACE);
}

/** Dispatch `value` to the appropriate serialization handler. */
function _writeValue(buf: ByteStream, value: CosNode, kw: { topLevel?: boolean } = {}): void {
  const { topLevel = false } = kw;
  if (value instanceof Map) {
    if (topLevel) {
      _writeDictContent(buf, value);
    } else {
      _space(buf);
      _writeDict(buf, value);
    }
  } else if (Array.isArray(value)) {
    if (topLevel) {
      _writeArrayContent(buf, value);
    } else {
      _space(buf);
      _writeArray(buf, value);
    }
  } else if (typeof value === "boolean") {
    // Must come before int check since bool is a subclass of int
    _space(buf);
    buf.write(value ? TRUE : FALSE);
  } else if (typeof value === "number" && Number.isInteger(value) && !Object.is(value, -0)) {
    // A plain integral JS number is a Python int; a Python float reaches here boxed as `BoxedFloat`.
    _space(buf);
    buf.write(encode(String(value), "ascii"));
  } else if (typeof value === "number" || value instanceof BoxedFloat) {
    _space(buf);
    buf.write(_formatFloat(unbox(value)));
  } else if (value instanceof CosName) {
    _space(buf);
    _writeIdentifier(buf, value.value);
  } else if (typeof value === "string" || value instanceof String) {
    // A CosString is a String object in TS (a str subclass in Python), so a
    // typeof check alone would miss it.
    _space(buf);
    _writeString(buf, value);
  } else if (value instanceof Uint8Array) {
    _space(buf);
    _writeHexString(buf, value);
  } else if (value == null) {
    _space(buf);
    buf.write(NULL);
  } else if (value instanceof IndirectObject) {
    _space(buf);
    _writeIndirectObject(buf, value);
  } else if (value instanceof IndirectReference) {
    _space(buf);
    _writeIndirectReference(buf, value);
  } else if (value instanceof Stream) {
    _space(buf);
    _writeStream(buf, value);
  } else {
    throw new TypeError(`Cannot serialize COS value of type ${typeName(value)}`);
  }
}

/**
 * Format a float matching After Effects' COS conventions.
 *
 * Whole-valued floats keep a trailing `.0` (AE writes `0.0` / `9.0`,
 * not `0` / `9`), which distinguishes them from COS integers and keeps
 * the serialized blob byte-faithful.
 */
function _formatFloat(value: number): Uint8Array {
  let text = String(Number(value.toPrecision(10)));
  // no '.', exponent, 'nan'/'inf'
  if (![".", "e", "E", "n", "i"].some((c) => text.includes(c))) text += ".0";
  // AE omits the leading zero for |v| < 1 (".5", "-.5") but keeps "0.0".
  if (text.startsWith("0.") && text !== "0.0") {
    text = text.slice(1);
  } else if (text.startsWith("-0.") && text !== "-0.0") {
    text = "-" + text.slice(2);
  }
  return encode(text, "ascii");
}

/** Write a COS dictionary: `<< /key value /key value >>`. */
function _writeDict(buf: ByteStream, d: CosDict): void {
  buf.write(ascii("<<"));
  _writeDictContent(buf, d);
  _space(buf);
  buf.write(ascii(">>"));
}

/** Write Map key/value pairs without the `<<`/`>>` delimiters. */
function _writeDictContent(buf: ByteStream, d: CosDict): void {
  for (const [key, val] of d) {
    _space(buf);
    _writeIdentifier(buf, key);
    _writeValue(buf, val);
  }
}

/** Write a COS array: `[ val val val ]`. */
function _writeArray(buf: ByteStream, lst: CosNode[]): void {
  buf.write(ascii("["));
  _writeArrayContent(buf, lst);
  _space(buf);
  buf.write(ascii("]"));
}

/** Write array elements without `[`/`]` delimiters. */
function _writeArrayContent(buf: ByteStream, lst: CosNode[]): void {
  for (const item of lst) {
    _writeValue(buf, item);
  }
}

// A name of printable ASCII without delimiters or `#` is written as is.
const PRINTABLE_ASCII = /^[!-~]*$/;
const IDENTIFIER_ESCAPED = /[()[\]<>{}/%#]/;

/** Write a COS identifier (name object): `/foo`. */
function _writeIdentifier(buf: ByteStream, name: string): void {
  buf.write(SLASH);
  if (PRINTABLE_ASCII.test(name) && !IDENTIFIER_ESCAPED.test(name)) {
    buf.write(encode(name, "ascii"));
    return;
  }
  let escaped = "";
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x21 || code > 0x7e || "()[]<>{}/%#".includes(ch)) {
      escaped += `#${code.toString(16).padStart(2, "0")}`;
    } else {
      escaped += ch;
    }
  }
  buf.write(encode(escaped, "ascii"));
}

/**
 * Write a COS string literal: `(escaped content)`.
 *
 * Strings are encoded as UTF-16 BE with a BOM prefix (AE's convention
 * for text data) unless the value is a `CosString` that was parsed as
 * raw ASCII / UTF-8 (e.g. bit-flag strings), in which case the original
 * single-byte encoding is reproduced for byte fidelity.
 */
function _writeString(buf: ByteStream, s: string | CosString): void {
  let raw: Uint8Array;
  if (!(s instanceof CosString) || s.cosUtf16) {
    raw = concat(Uint8Array.of(0xfe, 0xff), encode(String(s), "utf-16-be"));
  } else {
    raw = encode(String(s), "utf-8");
  }
  buf.write(LPAREN);
  buf.write(_escapeString(raw));
  buf.write(RPAREN);
}

/**
 * Escape bytes for a COS string literal.
 *
 * Only the characters that affect COS string parsing are escaped:
 * the delimiters `(` / `)` and the escape character `\`. After
 * Effects writes control bytes (newline, CR, backspace, form-feed)
 * raw inside string literals, so they are left unescaped to keep the
 * serialized blob byte-faithful.
 */
function _escapeString(raw: Uint8Array): Uint8Array {
  // `raw` is always freshly encoded, so with nothing to escape it is the result.
  if (!raw.some((byte) => byte === 0x28 || byte === 0x29 || byte === 0x5c)) return raw;
  const out: number[] = [];
  for (const byte of raw) {
    // b"(" / b")" / b"\\" get a backslash.
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out.push(0x5c);
    out.push(byte);
  }
  return Uint8Array.from(out);
}

/** Write a COS hex string: `<hexdata>`. */
function _writeHexString(buf: ByteStream, data: Uint8Array): void {
  buf.write(ascii("<"));
  buf.write(encode(Bytes.toHex(data), "ascii"));
  buf.write(ascii(">"));
}

/** Write `N G obj <data> endobj`. */
function _writeIndirectObject(buf: ByteStream, obj: IndirectObject): void {
  buf.write(encode(`${obj.objectNumber}`, "ascii"));
  buf.write(ascii(" "));
  buf.write(encode(`${obj.generationNumber}`, "ascii"));
  buf.write(ascii(" obj"));
  _writeValue(buf, obj.data);
  buf.write(ascii(" endobj"));
}

/** Write `N G R`. */
function _writeIndirectReference(buf: ByteStream, ref: IndirectReference): void {
  buf.write(encode(`${ref.objectNumber}`, "ascii"));
  buf.write(ascii(" "));
  buf.write(encode(`${ref.generationNumber}`, "ascii"));
  buf.write(ascii(" R"));
}

/** Write `<< dict >> stream\n<bytes>endstream`. */
function _writeStream(buf: ByteStream, stream: Stream): void {
  _writeDict(buf, stream.dictionary);
  buf.write(ascii("stream\n"));
  buf.write(stream.data);
  buf.write(ascii("endstream"));
}
