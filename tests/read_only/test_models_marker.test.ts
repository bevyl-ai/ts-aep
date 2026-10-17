/** Tests for MarkerValue model parsing. */

// `from __future__ import annotations` is dropped: no annotation here is
// evaluated at runtime, so `Project` and `MarkerValue` are type-only imports.
// `math.isclose` is the pyrt `isclose` (num.ts).

import { describe, expect, test } from "bun:test";
import { isclose, len, py_assert, Path } from "../../src/pyrt/index.ts";
import { get_comp, get_comp_marker_from_json_by_name, get_layer_marker_from_json_by_comp, load_expected, parse_project } from "../conftest.ts";
import type { MarkerValue, Project } from "../../src/py_aep/index.ts";

// Python `Path(__file__).parent.parent.parent` is the repo root. A TS file's
// `import.meta.dir` is already its directory, so two `.parent` steps reach it.
const SAMPLES_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "marker");

/** Get the first marker value from a composition. */
function get_first_comp_marker(project: Project, comp_name: string | null = null): MarkerValue {
  let comp;
  if (comp_name) {
    comp = get_comp(project, comp_name);
  } else {
    py_assert(len(project.compositions) >= 1);
    comp = project.compositions[0];
  }
  py_assert(len(comp.markers) >= 1);
  return comp.markers[0];
}

/** Get the first marker value from the first layer of a composition. */
function get_first_layer_marker(project: Project, comp_name: string | null = null): MarkerValue {
  let comp;
  if (comp_name) {
    comp = get_comp(project, comp_name);
  } else {
    py_assert(len(project.compositions) >= 1);
    comp = project.compositions[0];
  }
  py_assert(len(comp.layers) >= 1);
  const layer = comp.layers[0];
  py_assert(len(layer.markers) >= 1);
  return layer.markers[0];
}

/** Tests for composition marker label. */
describe("TestCompMarkerLabel", () => {
  test("test_label_0", () => {
    const expected = load_expected(SAMPLES_DIR, "comp_marker");
    const marker_json = get_comp_marker_from_json_by_name(expected, "label_0");
    const marker = get_first_comp_marker(parse_project(SAMPLES_DIR.div("comp_marker.aep")), "label_0");
    expect(marker.label).toBe(marker_json["label"]);
    expect(marker_json["label"]).toBe(0);
  });

  test("test_label_3", () => {
    const expected = load_expected(SAMPLES_DIR, "comp_marker");
    const marker_json = get_comp_marker_from_json_by_name(expected, "label_3");
    const marker = get_first_comp_marker(parse_project(SAMPLES_DIR.div("comp_marker.aep")), "label_3");
    expect(marker.label).toBe(marker_json["label"]);
    expect(marker_json["label"]).toBe(3);
  });

  test("test_label_8", () => {
    const expected = load_expected(SAMPLES_DIR, "comp_marker");
    const marker_json = get_comp_marker_from_json_by_name(expected, "label_8");
    const marker = get_first_comp_marker(parse_project(SAMPLES_DIR.div("comp_marker.aep")), "label_8");
    expect(marker.label).toBe(marker_json["label"]);
    expect(marker_json["label"]).toBe(8);
  });
});

/** Tests for composition marker duration. */
describe("TestCompMarkerDuration", () => {
  test("test_duration_5", () => {
    const expected = load_expected(SAMPLES_DIR, "comp_marker");
    const marker_json = get_comp_marker_from_json_by_name(expected, "duration_5");
    const marker = get_first_comp_marker(parse_project(SAMPLES_DIR.div("comp_marker.aep")), "duration_5");
    expect(marker_json["duration"]).toBe(5);
    expect(isclose(marker.duration, marker_json["duration"])).toBe(true);
  });
});

/** Tests for composition marker comment. */
describe("TestCompMarkerComment", () => {
  test("test_comment", () => {
    const expected = load_expected(SAMPLES_DIR, "comp_marker");
    const marker_json = get_comp_marker_from_json_by_name(expected, "comment");
    const marker = get_first_comp_marker(parse_project(SAMPLES_DIR.div("comp_marker.aep")), "comment");
    expect(marker.comment).toBe(marker_json["comment"]);
    expect(marker_json["comment"]).toBe("Test comment");
  });
});

/** Tests for composition marker chapter. */
describe("TestCompMarkerChapter", () => {
  test("test_chapter", () => {
    const expected = load_expected(SAMPLES_DIR, "comp_marker");
    const marker_json = get_comp_marker_from_json_by_name(expected, "chapter");
    const marker = get_first_comp_marker(parse_project(SAMPLES_DIR.div("comp_marker.aep")), "chapter");
    expect(marker.chapter).toBe(marker_json["chapter"]);
    expect(marker_json["chapter"]).toBe("Chapter 1");
  });
});

/** Tests for composition marker URL. */
describe("TestCompMarkerUrl", () => {
  test("test_url", () => {
    const expected = load_expected(SAMPLES_DIR, "comp_marker");
    const marker_json = get_comp_marker_from_json_by_name(expected, "url");
    const marker = get_first_comp_marker(parse_project(SAMPLES_DIR.div("comp_marker.aep")), "url");
    expect(marker.url).toBe(marker_json["url"]);
    expect(marker_json["url"]).toBe("https://example.com");
  });
});

/** Tests for composition marker frame target. */
describe("TestCompMarkerFrameTarget", () => {
  test("test_frameTarget", () => {
    const expected = load_expected(SAMPLES_DIR, "comp_marker");
    const marker_json = get_comp_marker_from_json_by_name(expected, "frameTarget");
    const marker = get_first_comp_marker(parse_project(SAMPLES_DIR.div("comp_marker.aep")), "frameTarget");
    expect(marker.frame_target).toBe(marker_json["frameTarget"]);
    expect(marker_json["frameTarget"]).toBe("_blank");
  });
});

/** Tests for composition marker cue point. */
describe("TestCompMarkerCuePoint", () => {
  test("test_cuePointName", () => {
    const expected = load_expected(SAMPLES_DIR, "comp_marker");
    const marker_json = get_comp_marker_from_json_by_name(expected, "cuePointName");
    const marker = get_first_comp_marker(parse_project(SAMPLES_DIR.div("comp_marker.aep")), "cuePointName");
    expect(marker.cue_point_name).toBe(marker_json["cuePointName"]);
    expect(marker_json["cuePointName"]).toBe("cue_test");
  });
});

/** Tests for composition marker protected region. */
describe("TestCompMarkerProtectedRegion", () => {
  test("test_protectedRegion_true", () => {
    const expected = load_expected(SAMPLES_DIR, "comp_marker");
    const marker_json = get_comp_marker_from_json_by_name(expected, "protectedRegion_true");
    const marker = get_first_comp_marker(parse_project(SAMPLES_DIR.div("comp_marker.aep")), "protectedRegion_true");
    expect(marker_json["protectedRegion"]).toBe(true);
    expect(marker.protected_region).toBe(marker_json["protectedRegion"]);
  });
});

/** Tests for layer markers. */
describe("TestLayerMarker", () => {
  test("test_layer_marker_comment", () => {
    const expected = load_expected(SAMPLES_DIR, "layer_marker");
    const marker_json = get_layer_marker_from_json_by_comp(expected, "layer_comment");
    const marker = get_first_layer_marker(parse_project(SAMPLES_DIR.div("layer_marker.aep")), "layer_comment");
    expect(marker.comment).toBe(marker_json["comment"]);
    expect(marker_json["comment"]).toBe("Layer marker comment");
  });

  test("test_layer_marker_duration", () => {
    const expected = load_expected(SAMPLES_DIR, "layer_marker");
    const marker_json = get_layer_marker_from_json_by_comp(expected, "layer_duration");
    const marker = get_first_layer_marker(parse_project(SAMPLES_DIR.div("layer_marker.aep")), "layer_duration");
    expect(marker_json["duration"]).toBe(3);
    expect(isclose(marker.duration, marker_json["duration"])).toBe(true);
  });

  test("test_layer_marker_cuePointName", () => {
    const expected = load_expected(SAMPLES_DIR, "layer_marker");
    const marker_json = get_layer_marker_from_json_by_comp(expected, "layer_cuePointName");
    const marker = get_first_layer_marker(parse_project(SAMPLES_DIR.div("layer_marker.aep")), "layer_cuePointName");
    expect(marker.cue_point_name).toBe(marker_json["cuePointName"]);
    expect(marker_json["cuePointName"]).toBe("layer_cue_1");
  });

  test("test_layer_marker_with_startTime", () => {
    /** Marker time is at comp time 5, layer startTime is 3. */
    const expected = load_expected(SAMPLES_DIR, "layer_marker");
    const marker_json = get_layer_marker_from_json_by_comp(expected, "layer_marker_with_startTime");
    const marker = get_first_layer_marker(
      parse_project(SAMPLES_DIR.div("layer_marker.aep")),
      "layer_marker_with_startTime",
    );
    expect(marker.comment).toBe(marker_json["comment"]);
    expect(marker_json["comment"]).toBe("marker at comp time 5");
  });

  test("test_layer_multiple_markers", () => {
    /** Three markers on one layer, parsed in correct order. */
    const project = parse_project(SAMPLES_DIR.div("layer_marker.aep"));
    const comp = get_comp(project, "layer_multiple_markers");
    const layer = comp.layers[0];
    expect(len(layer.markers)).toBe(3);
    expect(layer.markers[0].comment).toBe("first marker");
    expect(layer.markers[1].comment).toBe("second marker");
    expect(layer.markers[2].comment).toBe("Third");
  });
});
