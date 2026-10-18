/**
 * Tests for keyframe mutation: add_key, remove_key, set_value(s)_at_time(s),
 * Shape creation from scratch, and numeric keyframe value persistence.
 *
 * Mutation tests parse a fresh (uncached) copy so changes do not leak between
 * tests, and assert results survive a save / re-parse round-trip.
 */

// `from __future__ import annotations` is dropped. `Application` and `Property`
// are only used in annotations, so they are `import type`.

import { describe, expect, test } from "bun:test";
import { len, Path, StopIteration, str } from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { parse as parseAep } from "../../src/py_aep/index.ts";
import type { Application } from "../../src/py_aep/index.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { asInstance } from "../helpers.ts";

// Python `Path(__file__).parent.parent.parent` is the repo root. A TS file's
// `import.meta.dir` is already its directory, so two `.parent` steps reach it.
const SAMPLES = new Path(import.meta.dir).parent.parent.div("samples", "models", "property");
const SAMPLES_ROOT = new Path(import.meta.dir).parent.parent.div("samples");

function _fresh(name: string): Application {
  return parseAep(str(SAMPLES.div(name)));
}

function _prop(app: Application, matchName: string, kw: { comp?: number; layer?: number } = {}): Property {
  const { comp = 0, layer = 0 } = kw;
  const lay = app.project.compositions[comp].layers[layer];
  // `next(gen)` without a default raises StopIteration when nothing matches.
  for (const p of lay.transform) {
    if (p.matchName === matchName) return asInstance(p, Property);
  }
  throw new StopIteration();
}

describe("TestNearestKeyIndex", () => {
  test("test_returns_temporally_nearest", () => {
    // Regression: nearest_key_index compared frame_time (frames) against
    // the time argument (seconds); at any fps != 1 querying near a late
    // keyframe wrongly returned the first keyframe. Querying at each
    // keyframe's own time must return that keyframe's index.
    const app = _fresh("keyframe_HOLD.aep");
    const op = _prop(app, "ADBE Opacity");
    expect(len(op.keyframes) >= 2).toBe(true);
    for (const [i, kf] of op.keyframes.entries()) {
      expect(op.nearestKeyIndex(kf.time)).toBe(i);
    }
  });
});
