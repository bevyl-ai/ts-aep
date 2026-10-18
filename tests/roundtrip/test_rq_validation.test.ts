/**
 * Write-side validation of RenderQueueItem / OutputModule values.
 *
 * Ground truth probed in AE 2026 scripting:
 * - `skipFrames` raises out of range 0..99.
 * - Resolution components raise outside 0..99; `[0, 0]` is legal ("Current
 *   Settings").
 * - `timeSpanStart` keeps the span END fixed (duration recomputed);
 *   `timeSpanDuration` keeps the start and enforces a one-frame minimum.
 *   AE accepts degenerate spans (negative start, end before start) and
 *   silently renders garbage, so py_aep validates those instead.
 * - Boolean settings/attributes are strict-bool in py_aep: AE's binary layer
 *   would silently coerce truthy values (`"no"` -> True).
 */

import { describe, expect, test } from "bun:test";
import { Path, ValueError, valueEquals } from "../../src/pyrt/index.ts";
import { approx, makeTmpPath, raises } from "../../src/pyrt/pytest.ts";
import { asInstance, parseProjectFresh } from "../helpers.ts";
import type { Project } from "../../src/py_aep/models/project.ts";
import { RenderQueue } from "../../src/py_aep/models/renderqueue/render_queue.ts";
import type { RenderQueueItem } from "../../src/py_aep/models/renderqueue/render_queue_item.ts";

const SAMPLE = new Path(import.meta.path)
  .parent.parent.parent.div("samples", "models", "output_module", "file.aep");

function _rqi(project: Project): RenderQueueItem {
  return asInstance(project.renderQueue, RenderQueue).items[0];
}

describe("TestStrictBools", () => {
  test("test_rqi_bool_settings_reject_non_bool", () => {
    const rqi = _rqi(parseProjectFresh(SAMPLE));
    // NOTE(port): Python `settings[k] = v` is SettingsView.__setitem__ (item assignment on a __setitem__ class).
    raises(TypeError, () => {
      rqi.settings.set("Skip Existing Files", "no");
    });
    raises(TypeError, () => {
      // @ts-expect-error render is boolean; a non-bool write must raise TypeError at runtime
      rqi.render = 1;
    });
    rqi.settings.set("Skip Existing Files", true);
    expect(rqi.settings.get("Skip Existing Files")).toBe(true);
  });

  test("test_om_bool_settings_reject_non_bool", () => {
    const rqi = _rqi(parseProjectFresh(SAMPLE));
    const om = rqi.outputModules[0];
    for (const key of [
      "Crop",
      "Resize",
      "Lock Aspect Ratio",
      "Include Project Link",
      "Preserve RGB",
      "Use Comp Frame Number",
      "Use Region of Interest",
      "Include Source XMP Metadata",
      "Video Output",
    ]) {
      // NOTE(port): Python `settings[k] = v` is SettingsView.__setitem__.
      raises(TypeError, () => {
        om.settings.set(key, "no");
      });
    }
    om.settings.set("Preserve RGB", true);
    expect(om.settings.get("Preserve RGB")).toBe(true);
  });
});

describe("TestSkipFramesBounds", () => {
  test("test_ae_range_0_to_99", () => {
    const rqi = _rqi(parseProjectFresh(SAMPLE));
    rqi.skipFrames = 0;
    raises(ValueError, () => {
      rqi.skipFrames = 100;
    });
    raises(ValueError, () => {
      rqi.skipFrames = -1;
    });
  });
});

describe("TestResolutionBounds", () => {
  test("test_zero_is_current_settings", () => {
    const rqi = _rqi(parseProjectFresh(SAMPLE));
    rqi.settings.set("Resolution", [0, 0]);
    expect(valueEquals(rqi.settings.get("Resolution"), [0, 0])).toBe(true);
  });

  test("test_components_0_to_99", () => {
    const rqi = _rqi(parseProjectFresh(SAMPLE));
    rqi.settings.set("Resolution", [99, 99]);
    raises(ValueError, () => {
      rqi.settings.set("Resolution", [100, 100]);
    });
    raises(ValueError, () => {
      rqi.settings.set("Resolution", [-2, -2]);
    });
  });
});

describe("TestTimeSpanSemantics", () => {
  test("test_start_keeps_end", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLE);
    const rqi = _rqi(project);
    const end = rqi.timeSpanStart + rqi.timeSpanDuration;
    const newStart = end / 2;
    rqi.timeSpanStart = newStart;
    expect(approx(rqi.timeSpanStart, newStart)).toBe(true);
    expect(approx(rqi.timeSpanStart + rqi.timeSpanDuration, end)).toBe(true);

    const out = tmpPath.div("span.aep");
    project.save(out);
    const rqi2 = _rqi(parseProjectFresh(out));
    expect(approx(rqi2.timeSpanStart, newStart)).toBe(true);
    expect(approx(rqi2.timeSpanStart + rqi2.timeSpanDuration, end)).toBe(true);
  });

  test("test_duration_keeps_start", () => {
    const rqi = _rqi(parseProjectFresh(SAMPLE));
    rqi.timeSpanStart = 0.5;
    const start = rqi.timeSpanStart;
    rqi.timeSpanDuration = 1.0;
    expect(approx(rqi.timeSpanStart, start)).toBe(true);
    expect(approx(rqi.timeSpanDuration, 1.0)).toBe(true);
  });

  test("test_degenerate_spans_rejected", () => {
    const rqi = _rqi(parseProjectFresh(SAMPLE));
    const end = rqi.timeSpanStart + rqi.timeSpanDuration;
    raises(ValueError, () => {
      rqi.timeSpanStart = -5;
    });
    raises(ValueError, () => {
      rqi.timeSpanStart = end + 1; // would leave a negative duration
    });
    const oneFrame = 1.0 / rqi.comp.frameRate;
    raises(ValueError, () => {
      rqi.timeSpanDuration = oneFrame / 2; // below AE's one-frame bound
    });
    rqi.timeSpanDuration = oneFrame; // exactly one frame is legal
  });
});
