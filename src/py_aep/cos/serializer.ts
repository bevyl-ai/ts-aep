/**
 * Serialize objects back to COS (Carousel Object Syntax) binary.
 *
 * This is the inverse of `CosParser.parse`: it takes a nested
 * structure (Maps, arrays, strings, numbers, bools, `null`,
 * `IndirectObject`, `IndirectReference`, `Stream`) and emits COS-format
 * bytes suitable for writing back into a btdk chunk's `binary_data`.
 */

import { BytesIO, b, bytes_, concat, encode, format, PyFloat, TypeError_, typeName, unbox } from "../../pyrt/index.ts";
import { CosName, CosString, IndirectObject, IndirectReference, Stream, type CosDict, type CosNode } from "./cos.ts";

// Literals written per token, built once (`BytesIO.write` copies them).
const SPACE = b(" ");
const TRUE = b("true");
const FALSE = b("false");
const NULL = b("null");
const SLASH = b("/");
const LPAREN = b("(");
const RPAREN = b(")");

/**
 * Serialize a parsed COS value tree back to binary.
 *
 * @param data - The object tree to serialize. May be a Map, array,
 *   string, number, boolean, `null`, `bytes`,
 *   `IndirectObject`, `IndirectReference`, or `Stream`.
 * @returns The COS binary representation.
 */
export function serialize(data: CosNode): Uint8Array {
  const buf = new BytesIO();
  // AE's btdk blob begins with a leading space before the first token.
  buf.write(SPACE);
  _writeValue(buf, data, { topLevel: true });
  return buf.getvalue();
}

/** Write a space separator unless the buffer already ends with whitespace. */
export function _space(buf: BytesIO): void {
  const pos = buf.tell();
  if (pos === 0) return;
  buf.seek(pos - 1);
  const last = buf.readByte();
  // b" \t\n\r"
  if (!(last === 0x20 || last === 0x09 || last === 0x0a || last === 0x0d)) buf.write(SPACE);
}

/** Dispatch `value` to the appropriate serialization handler. */
export function _writeValue(buf: BytesIO, value: CosNode, kw: { topLevel?: boolean } = {}): void {
  const { topLevel: top_level = false } = kw;
  if (value instanceof Map) {
    if (top_level) {
      _writeDictContent(buf, value);
    } else {
      _space(buf);
      _writeDict(buf, value);
    }
  } else if (Array.isArray(value)) {
    if (top_level) {
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
    // A plain integral JS number is a Python int; a Python float reaches here boxed as `PyFloat`.
    _space(buf);
    buf.write(encode(String(value), "ascii"));
  } else if (typeof value === "number" || value instanceof PyFloat) {
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
    throw new TypeError_(`Cannot serialize COS value of type ${typeName(value)}`);
  }
}

/**
 * Format a float matching After Effects' COS conventions.
 *
 * Whole-valued floats keep a trailing `.0` (AE writes `0.0` / `9.0`,
 * not `0` / `9`), which distinguishes them from COS integers and keeps
 * the serialized blob byte-faithful.
 */
export function _formatFloat(value: number): Uint8Array {
  let text = format(value, ".10g");
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
export function _writeDict(buf: BytesIO, d: CosDict): void {
  buf.write(b("<<"));
  _writeDictContent(buf, d);
  _space(buf);
  buf.write(b(">>"));
}

/** Write Map key/value pairs without the `<<`/`>>` delimiters. */
export function _writeDictContent(buf: BytesIO, d: CosDict): void {
  for (const [key, val] of d) {
    _space(buf);
    _writeIdentifier(buf, key);
    _writeValue(buf, val);
  }
}

/** Write a COS array: `[ val val val ]`. */
export function _writeArray(buf: BytesIO, lst: CosNode[]): void {
  buf.write(b("["));
  _writeArrayContent(buf, lst);
  _space(buf);
  buf.write(b("]"));
}

/** Write array elements without `[`/`]` delimiters. */
export function _writeArrayContent(buf: BytesIO, lst: CosNode[]): void {
  for (const item of lst) {
    _writeValue(buf, item);
  }
}

// A name of printable ASCII without delimiters or `#` is written as is.
const PRINTABLE_ASCII = /^[!-~]*$/;
const IDENTIFIER_ESCAPED = /[()[\]<>{}/%#]/;

/** Write a COS identifier (name object): `/foo`. */
export function _writeIdentifier(buf: BytesIO, name: string): void {
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
export function _writeString(buf: BytesIO, s: string | CosString): void {
  let raw: Uint8Array;
  if (!(s instanceof CosString) || s.cosUtf16) {
    raw = concat(b("\xfe\xff"), encode(String(s), "utf-16-be"));
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
export function _escapeString(raw: Uint8Array): Uint8Array {
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
export function _writeHexString(buf: BytesIO, data: Uint8Array): void {
  buf.write(b("<"));
  buf.write(encode(bytes_.hex(data), "ascii"));
  buf.write(b(">"));
}

/** Write `N G obj <data> endobj`. */
export function _writeIndirectObject(buf: BytesIO, obj: IndirectObject): void {
  buf.write(encode(`${obj.objectNumber}`, "ascii"));
  buf.write(b(" "));
  buf.write(encode(`${obj.generationNumber}`, "ascii"));
  buf.write(b(" obj"));
  _writeValue(buf, obj.data);
  buf.write(b(" endobj"));
}

/** Write `N G R`. */
export function _writeIndirectReference(buf: BytesIO, ref: IndirectReference): void {
  buf.write(encode(`${ref.objectNumber}`, "ascii"));
  buf.write(b(" "));
  buf.write(encode(`${ref.generationNumber}`, "ascii"));
  buf.write(b(" R"));
}

/** Write `<< dict >> stream\n<bytes>endstream`. */
export function _writeStream(buf: BytesIO, stream: Stream): void {
  _writeDict(buf, stream.dictionary);
  buf.write(b("stream\n"));
  buf.write(stream.data);
  buf.write(b("endstream"));
}
