/** Tests for COS (Carousel Object Syntax) parser and serializer. */

import { describe, expect, test } from "bun:test";

import { approx, raises } from "../../src/pyrt/pytest.ts";
import { BytesIO, b, bytes_, pyAssert, pyEq } from "../../src/pyrt/index.ts";
// NOTE(port): SyntaxError_ is pyrt's shim for Python's builtin SyntaxError, re-exported by cos.ts
import { CosParser, IndirectObject, IndirectReference, Stream, SyntaxError_, type CosNode } from "../../src/py_aep/cos/cos.ts";
import { serialize } from "../../src/py_aep/cos/serializer.ts";

describe("TestCosParserPrimitives", () => {
  /** Tests for parsing individual COS value types. */

  test("test_parse_integer", () => {
    const result = _parse(b("42"));
    expect(result).toBe(42);
  });

  test("test_parse_negative_integer", () => {
    const result = _parse(b("-7"));
    expect(result).toBe(-7);
  });

  test("test_parse_positive_sign", () => {
    const result = _parse(b("+3"));
    expect(result).toBe(3);
  });

  test("test_parse_float", () => {
    const result = _parse(b("3.14"));
    expect(approx(result, 3.14)).toBe(true);
  });

  test("test_parse_float_no_integer_part", () => {
    const result = _parse(b(".5"));
    expect(approx(result, 0.5)).toBe(true);
  });

  test("test_parse_negative_float", () => {
    const result = _parse(b("-2.5"));
    expect(approx(result, -2.5)).toBe(true);
  });

  test("test_parse_true", () => {
    expect(_parse(b("true"))).toBe(true);
  });

  test("test_parse_false", () => {
    expect(_parse(b("false"))).toBe(false);
  });

  test("test_parse_null", () => {
    expect(_parse(b("null"))).toBeNull();
  });

  test("test_parse_string", () => {
    expect(pyEq(_parse(b("(hello)")), "hello")).toBe(true);
  });

  test("test_parse_string_with_escape", () => {
    expect(pyEq(_parse(b("(line1\\nline2)")), "line1\nline2")).toBe(true);
  });

  test("test_parse_string_with_parentheses_escape", () => {
    expect(pyEq(_parse(b("(a\\(b\\)c)")), "a(b)c")).toBe(true);
  });

  test("test_parse_string_with_backslash_escape", () => {
    expect(pyEq(_parse(b("(a\\\\b)")), "a\\b")).toBe(true);
  });

  test("test_parse_string_with_octal_escape", () => {
    expect(pyEq(_parse(b("(\\101)")), "A")).toBe(true); // octal 101 = 65 = 'A'
  });

  test("test_parse_string_with_carriage_return", () => {
    expect(pyEq(_parse(b("(a\\rb)")), "a\rb")).toBe(true);
  });

  test("test_parse_string_utf8_bom", () => {
    expect(pyEq(_parse(b("(\xef\xbb\xbfhello)")), "hello")).toBe(true);
  });

  test("test_parse_string_utf16be_bom", () => {
    const data = b("(\xfe\xff\x00h\x00i)");
    expect(pyEq(_parse(data), "hi")).toBe(true);
  });

  test("test_parse_string_utf16le_bom", () => {
    const data = b("(\xff\xfeh\x00i\x00)");
    expect(pyEq(_parse(data), "hi")).toBe(true);
  });

  test("test_parse_hex_string", () => {
    const result = _parse(b("<48656C6C6F>"));
    expect(pyEq(result, b("Hello"))).toBe(true);
  });

  test("test_parse_hex_string_odd_length", () => {
    // Odd-length hex string gets padded with 0
    const result = _parse(b("<ABC>"));
    expect(pyEq(result, new Uint8Array([0xab, 0xc0]))).toBe(true);
  });

  test("test_parse_hex_string_with_spaces", () => {
    const result = _parse(b("<48 65 6C>"));
    expect(pyEq(result, b("Hel"))).toBe(true);
  });

  test("test_parse_identifier", () => {
    // Top-level identifier triggers dict-content mode
    const result = _parse(b("/Name 42"));
    expect(pyEq(result, new Map<string, CosNode>([["Name", 42]]))).toBe(true);
  });

  test("test_parse_identifier_hex_escape", () => {
    const result = _parse(b("/Name#20Here 1"));
    expect(pyEq(result, new Map<string, CosNode>([["Name Here", 1]]))).toBe(true);
  });
});

describe("TestCosParserComposite", () => {
  /** Tests for parsing composite COS structures. */

  test("test_parse_dict", () => {
    const result = _parse(b("<< /Key1 42 /Key2 (hello) >>"));
    expect(pyEq(result, new Map<string, CosNode>([["Key1", 42], ["Key2", "hello"]]))).toBe(true);
  });

  test("test_parse_empty_dict", () => {
    const result = _parse(b("<< >>"));
    expect(pyEq(result, new Map<string, CosNode>())).toBe(true);
  });

  test("test_parse_nested_dict", () => {
    const result = _parse(b("<< /outer << /inner 1 >> >>"));
    expect(pyEq(result, new Map<string, CosNode>([["outer", new Map<string, CosNode>([["inner", 1]])]]))).toBe(true);
  });

  test("test_parse_array", () => {
    const result = _parse(b("[1 2 3]"));
    expect(pyEq(result, [1, 2, 3])).toBe(true);
  });

  test("test_parse_empty_array", () => {
    const result = _parse(b("[]"));
    expect(pyEq(result, [])).toBe(true);
  });

  test("test_parse_mixed_array", () => {
    const result = _parse(b("[1 (two) true null]"));
    expect(pyEq(result, [1, "two", true, null])).toBe(true);
  });

  test("test_parse_nested_array", () => {
    const result = _parse(b("[[1 2] [3 4]]"));
    expect(pyEq(result, [[1, 2], [3, 4]])).toBe(true);
  });

  test("test_parse_dict_in_array", () => {
    const result = _parse(b("[<< /a 1 >>]"));
    expect(pyEq(result, [new Map<string, CosNode>([["a", 1]])])).toBe(true);
  });

  test("test_parse_bare_values_as_array", () => {
    // Multiple bare number values become a list
    const result = _parse(b("1 2 3"));
    expect(pyEq(result, [1, 2, 3])).toBe(true);
  });
});

describe("TestCosParserIndirect", () => {
  /** Tests for indirect object / reference parsing. */

  test("test_parse_indirect_object", () => {
    const result = _parse(b("1 0 obj 42 endobj"));
    pyAssert(result instanceof IndirectObject);
    expect(result.objectNumber).toBe(1);
    expect(result.generationNumber).toBe(0);
    expect(result.data).toBe(42);
  });

  test("test_parse_indirect_reference", () => {
    const result = _parse(b("<< /Ref 5 0 R >>"));
    expect(pyEq(result, new Map<string, CosNode>([["Ref", new IndirectReference(5, 0)]]))).toBe(true);
  });
});

describe("TestCosParserStream", () => {
  /** Tests for stream parsing. */

  test("test_parse_stream", () => {
    const data = b("<< /Length 5 >>\nstream\nhelloendstream");
    const f = new BytesIO(data);
    const parser = new CosParser(f, data.length);
    const result = parser.parse();
    pyAssert(result instanceof Stream);
    expect(pyEq(result.dictionary, new Map<string, CosNode>([["Length", 5]]))).toBe(true);
    expect(pyEq(result.data, b("hello"))).toBe(true);
  });
});

describe("TestCosParserComments", () => {
  /** Tests for comment handling. */

  test("test_comment_skipped", () => {
    const result = _parse(b("% this is a comment\n42"));
    expect(result).toBe(42);
  });

  test("test_inline_comment", () => {
    const result = _parse(b("[1 % mid-array comment\n2]"));
    expect(pyEq(result, [1, 2])).toBe(true);
  });
});

describe("TestCosParserErrors", () => {
  /** Tests for parser error handling. */

  test("test_unterminated_string", () => {
    raises(SyntaxError_, () => _parse(b("(unterminated")));
  });

  test("test_unterminated_hex_string", () => {
    raises(SyntaxError_, () => _parse(b("<48656C6C6F")));
  });

  test("test_unknown_keyword", () => {
    raises(SyntaxError_, () => _parse(b("badkeyword")));
  });

  test("test_unexpected_token", () => {
    raises(SyntaxError_, () => _parse(b("<< 42 >>"))); // dict expects /identifier first
  });

  test("test_invalid_escape_sequence", () => {
    raises(SyntaxError_, () => _parse(b("(\\z)")));
  });
});

describe("TestCosParserMaxPos", () => {
  /** Tests for max_pos limit. */

  test("test_max_pos_truncates", () => {
    const f = new BytesIO(b("42 99"));
    const parser = new CosParser(f, 2);
    const result = parser.parse();
    expect(result).toBe(42);
  });

  test("test_max_pos_none_reads_all", () => {
    const f = new BytesIO(b("[1 2]"));
    const parser = new CosParser(f, 5);
    const result = parser.parse();
    expect(pyEq(result, [1, 2])).toBe(true);
  });
});

describe("TestCosParserSaveRestore", () => {
  /** Tests for save_state / restore_state. */

  test("test_save_restore_rewinds", () => {
    const f = new BytesIO(b("42 99"));
    const parser = new CosParser(f);
    parser.lex();
    const state = parser.saveState();
    parser.lex();
    expect(parser.lookahead.value).toBe(99);
    parser.restoreState(state);
    expect(parser.lookahead.value).toBe(42);
  });
});

describe("TestCosSerializer", () => {
  /** Tests for COS serializer roundtrip. */

  test("test_roundtrip_dict", () => {
    const original = b("/Key1 42 /Key2 (hello)");
    const parsed = _parse(original);
    const serialized = serialize(parsed);
    const reparsed = _parse(serialized);
    expect(pyEq(reparsed, parsed)).toBe(true);
  });

  test("test_roundtrip_array", () => {
    const original = b("[1 2.5 (text) true null]");
    const parsed = _parse(original);
    const serialized = serialize(parsed);
    const reparsed = _parse(serialized);
    expect(pyEq(reparsed, parsed)).toBe(true);
  });

  test("test_roundtrip_nested", () => {
    const original = b("<< /a << /b [1 2] >> /c (str) >>");
    const parsed = _parse(original);
    const serialized = serialize(parsed);
    const reparsed = _parse(serialized);
    expect(pyEq(reparsed, parsed)).toBe(true);
  });

  test("test_serialize_none", () => {
    expect(bytes_.contains(serialize(null), b("null"))).toBe(true);
  });

  test("test_serialize_bool", () => {
    expect(bytes_.contains(serialize(true), b("true"))).toBe(true);
    expect(bytes_.contains(serialize(false), b("false"))).toBe(true);
  });

  test("test_serialize_int", () => {
    expect(bytes_.contains(serialize(42), b("42"))).toBe(true);
  });

  test("test_serialize_float", () => {
    const result = serialize(3.14);
    expect(bytes_.contains(result, b("3.14"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/** Parse COS data from bytes. */
function _parse(data: Uint8Array): CosNode {
  const f = new BytesIO(data);
  const parser = new CosParser(f, data.length);
  return parser.parse();
}
