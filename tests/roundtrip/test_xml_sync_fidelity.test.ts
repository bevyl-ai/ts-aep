/**
 * The XML `Ropt` body must stay byte-faithful to what AE writes.
 *
 * The `Ropt` header restates the body's own sizes and **After Effects honours
 * them**: it reads exactly `len(body)` bytes from offset 6 and discards the
 * rest. `_syncXml` used to copy the header verbatim while re-serializing a
 * longer XML, so AE silently truncated the block mid-element on open and
 * re-saved the corruption - no error, no exception (probed on AE 26.3: an
 * 87-byte-longer body was cut back to the stale length, losing the closing
 * `</PremiereData>`).
 *
 * py->py round-trips cannot catch any of this, which is how it survived: py
 * re-reads its own XML happily. These tests compare against AE's own bytes.
 */
import { describe, expect, test } from "bun:test";

import { Path, b, Bytes, len, valueEquals, struct } from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { parse, type Project } from "../../src/py_aep/index.ts";
import { asInstance } from "../helpers.ts";
import { XmlFormatOptions } from "../../src/py_aep/models/renderqueue/format_options/index.ts";
import { RenderQueue } from "../../src/py_aep/models/renderqueue/render_queue.ts";
import {
  _LEN_BODY_OFFSET,
  _LEN_XML_OFFSET,
  _XML_TERMINATOR,
} from "../../src/py_aep/models/renderqueue/format_options/xml.ts";
import { makeTmpPath } from "../support/pytest.ts";

const FORMAT_DIR = new Path(import.meta.filename).parent.parent.parent.div("samples", "models", "format_options");

/**
 * One AE-authored module per XML-backed format code.
 * Row is [sample, format_code]. The pytest ids (h264, avi, mp3, quicktime, wav)
 * are not carried into the test names; they are noted beside each row.
 */
const PER_FORMAT: [Path, string][] = [
  [FORMAT_DIR.div("h.264", "base.aep"), "H264"], // id=h264
  [FORMAT_DIR.div("avi", "base.aep"), ".AVI"], // id=avi
  [FORMAT_DIR.div("mp3", "mp3_mono_320.aep"), "Mp3 "], // id=mp3
  [FORMAT_DIR.div("quicktime", "base.aep"), "MooV"], // id=quicktime
  [FORMAT_DIR.div("wav", "base.aep"), "wao_"], // id=wav
];

function _options(path: Path): [Project, XmlFormatOptions] {
  const project = parse(path).project;
  const opts = asInstance(
    asInstance(project.renderQueue, RenderQueue).items[0].outputModules[0].formatOptions,
    XmlFormatOptions,
  );
  return [project, opts];
}

function _headerLengths(body: Uint8Array): [number, number] {
  return [struct.unpackFrom(">I", body, _LEN_BODY_OFFSET)[0], struct.unpackFrom(">I", body, _LEN_XML_OFFSET)[0]];
}

/**
 * Python 3.7's `ET.tostring` sorts each element's attributes alphabetically;
 * 3.8+ keeps document order, which is what AE writes. A 3.7 write therefore
 * reorders attributes - same length, same semantics, different bytes - so
 * only the byte-identity assertions are version-gated. The length/terminator
 * invariants below (the ones AE actually honours) run everywhere.
 */
// NOTE(port): sys.version_info >= (3, 8) is always true on the CPython 3.12 target; constant kept so the skip gate stays visible.
const _ATTR_ORDER_PRESERVED = true;

/** Re-serializing an untouched tree must reproduce AE's bytes exactly. */
describe("TestNoOpSyncIsIdentity", () => {
  // @pytest.mark.skipif(not _ATTR_ORDER_PRESERVED, reason="py3.7 ET.tostring sorts attributes; bytes differ, semantics do not")
  // NOTE(port): bun's test.skip takes no reason; the reason is the comment above, and the gate is never taken on 3.12.
  // bun types `test.skipIf` without `.each`, so the parametrized rows are spelled out with the same names.
  for (const [index, [sample, formatCode]] of PER_FORMAT.entries()) {
    test.skipIf(!_ATTR_ORDER_PRESERVED)(`test_no_op_sync_is_byte_identical[${index}]`, () => {
      const [, opts] = _options(sample);
      expect(opts instanceof XmlFormatOptions).toBe(true);
      expect(opts.formatCode).toBe(formatCode);
      const before = opts._body.data;
      opts._syncXml(); // no semantic change whatsoever
      expect(valueEquals(opts._body.data, before)).toBe(true);
    });
  }

  test.each(PER_FORMAT)("test_no_op_sync_preserves_length_on_every_python[%#]", (sample, formatCode) => {
    // The part AE honours holds even on 3.7, where attribute reordering
    // costs byte-identity: same length, still self-consistent.
    const [, opts] = _options(sample);
    expect(opts instanceof XmlFormatOptions).toBe(true);
    const before = len(opts._body.data);
    opts._syncXml();
    const body = opts._body.data;
    expect(len(body)).toBe(before);
    expect(_headerLengths(body)[0]).toBe(len(body));
    expect(Bytes.endsWith(body, _XML_TERMINATOR)).toBe(true);
  });

  test.each(PER_FORMAT)("test_ae_body_is_self_consistent[%#]", (sample, formatCode) => {
    // The invariant the fix maintains, as AE itself writes it.
    const [, opts] = _options(sample);
    expect(opts instanceof XmlFormatOptions).toBe(true);
    const body = opts._body.data;
    expect(opts._xmlHeader != null).toBe(true);
    const xmlLen = len(body) - len(opts._xmlHeader);
    const [bodyLenField, xmlLenField] = _headerLengths(body);
    expect(bodyLenField).toBe(len(body));
    expect(xmlLenField).toBe(xmlLen - 2);
    expect(Bytes.endsWith(body, _XML_TERMINATOR)).toBe(true);
  });
});

/** A real param write must repatch the lengths, or AE truncates. */
describe("TestWriteKeepsHeaderConsistent", () => {
  test.each(PER_FORMAT)("test_param_write_updates_length_fields[%#]", (sample, formatCode) => {
    // A param that exists on every XML format and changes the length.
    const [, opts] = _options(sample);
    expect(opts instanceof XmlFormatOptions).toBe(true);
    opts.params.set("ADBEPyAepFidelityProbe", "1234567890");
    const body = opts._body.data;
    expect(opts._xmlHeader != null).toBe(true);
    const xmlLen = len(body) - len(opts._xmlHeader);
    const [bodyLenField, xmlLenField] = _headerLengths(body);
    expect(bodyLenField).toBe(len(body));
    expect(xmlLenField).toBe(xmlLen - 2);
    expect(Bytes.endsWith(body, _XML_TERMINATOR)).toBe(true);
  });

  test("test_growing_write_updates_length", () => {
    const tmpPath = makeTmpPath();
    const [project, opts] = _options(FORMAT_DIR.div("h.264", "base.aep"));
    expect(opts instanceof XmlFormatOptions).toBe(true);
    const original = len(opts._body.data);
    opts.params.set("ADBEPyAepFidelityProbe", "x".repeat(400));
    expect(len(opts._body.data) > original).toBe(true);
    expect(_headerLengths(opts._body.data)[0]).toBe(len(opts._body.data));
    project.save(tmpPath.div("out.aep"));
    const [, reparsed] = _options(tmpPath.div("out.aep"));
    expect(reparsed instanceof XmlFormatOptions).toBe(true);
    expect(_headerLengths(reparsed._body.data)[0]).toBe(len(reparsed._body.data));
  });

  test("test_shrinking_write_updates_length", () => {
    // A stale field that is too LARGE would make AE read past the block.
    const [, opts] = _options(FORMAT_DIR.div("h.264", "base.aep"));
    expect(opts instanceof XmlFormatOptions).toBe(true);
    opts.params.set("ADBEPyAepFidelityProbe", "x".repeat(400));
    const grown = len(opts._body.data);
    opts.params.delete("ADBEPyAepFidelityProbe");
    expect(len(opts._body.data) < grown).toBe(true);
    expect(_headerLengths(opts._body.data)[0]).toBe(len(opts._body.data));
  });
});

/** The specific divergences that made a no-op sync lossy. */
describe("TestSerializerMatchesAeStyle", () => {
  test("test_declaration_is_double_quoted", () => {
    const [, opts] = _options(FORMAT_DIR.div("h.264", "base.aep"));
    expect(opts instanceof XmlFormatOptions).toBe(true);
    opts._syncXml();
    expect(Bytes.includes(opts._body.data, b('<?xml version="1.0" encoding="UTF-8"?>'))).toBe(true);
  });

  test("test_self_closing_tags_have_no_space", () => {
    const [, opts] = _options(FORMAT_DIR.div("h.264", "base.aep"));
    expect(opts instanceof XmlFormatOptions).toBe(true);
    opts._syncXml();
    expect(Bytes.includes(opts._body.data, b(" />"))).toBe(false);
    expect(Bytes.includes(opts._body.data, b("/>"))).toBe(true);
  });

  test("test_attributeless_empty_elements_are_expanded", () => {
    // AE self-closes `<Foo ObjectRef="1"/>` but expands `<ParamName></ParamName>`.
    const [, opts] = _options(FORMAT_DIR.div("h.264", "base.aep"));
    expect(opts instanceof XmlFormatOptions).toBe(true);
    opts._syncXml();
    expect(Bytes.includes(opts._body.data, b("<ParamName></ParamName>"))).toBe(true);
    expect(Bytes.includes(opts._body.data, b("<ParamName/>"))).toBe(false);
  });

  test("test_terminator_survives_a_write", () => {
    const [, opts] = _options(FORMAT_DIR.div("h.264", "base.aep"));
    expect(opts instanceof XmlFormatOptions).toBe(true);
    opts.params.set("ADBEPyAepFidelityProbe", "1");
    expect(Bytes.endsWith(opts._body.data, b(">\n\x00\x00"))).toBe(true);
  });
});
