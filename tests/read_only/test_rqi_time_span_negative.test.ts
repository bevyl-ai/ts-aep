/**
 * Signed decode of render-queue time-span fields.
 *
 * `samples/models/renderqueue/time_span_negative.aep` was produced by AE 2026
 * scripting (which accepts degenerate spans): item 0 has `timeSpanStart = -5`
 * (end kept at 10 -> duration 15), item 1 has start 110 with the end kept at
 * 10 (duration -100). AE stores the negative values as two's-complement
 * dividends; decoding them as unsigned read -5s as ~139805s.
 */

import { describe, expect, test } from "bun:test";

import { asInstance, parseProject, parseProjectFresh } from "../helpers.ts";
import { RenderQueue } from "../../src/py_aep/models/renderqueue/render_queue.ts";
import { Path, valueEquals } from "../../src/pyrt/index.ts";
import { makeTmpPath } from "../../src/pyrt/pytest.ts";

// `Path(__file__).parent.parent.parent`: `import.meta.dir` is the directory of
// this file (`__file__.parent`), so two more `.parent` reach the package root.
const SAMPLE = new Path(import.meta.dir)
  .parent.parent.div("samples", "models", "renderqueue", "time_span_negative.aep");

describe("TestNegativeTimeSpanDecode", () => {
  test("test_negative_start_decodes_signed", () => {
    const project = parseProject(SAMPLE);
    const rqi = asInstance(project.renderQueue, RenderQueue).items[0];
    expect(rqi.timeSpanStart).toBe(-5.0);
    expect(rqi.timeSpanDuration).toBe(15.0);
  });

  test("test_negative_duration_decodes_signed", () => {
    const project = parseProject(SAMPLE);
    const rqi = asInstance(project.renderQueue, RenderQueue).items[1];
    expect(rqi.timeSpanStart).toBe(110.0);
    expect(rqi.timeSpanDuration).toBe(-100.0);
  });

  test("test_roundtrip_stays_byte_identical", () => {
    const tmpPath = makeTmpPath();
    const out = tmpPath.div("time_span_negative.aep");
    const out2 = tmpPath.div("time_span_negative_2.aep");

    parseProjectFresh(SAMPLE).save(out);
    parseProjectFresh(out).save(out2);

    expect(valueEquals(out.readBytes(), out2.readBytes())).toBe(true);
  });
});
