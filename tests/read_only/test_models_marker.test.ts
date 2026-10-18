/** Tests for MarkerValue model parsing. */

// `from __future__ import annotations` is dropped: no annotation here is
// evaluated at runtime, so `Project` and `MarkerValue` are type-only imports.
// `math.isclose` is the pyrt `isclose` (num.ts).

import { describe, expect, test } from "bun:test";
import { isclose, len, pyAssert, Path } from "../../src/pyrt/index.ts";
import { getComp, getCompMarkerFromJsonByName, getLayerMarkerFromJsonByComp, loadExpected, parseProject } from "../conftest.ts";
import type { MarkerValue, Project } from "../../src/py_aep/index.ts";

// Python `Path(__file__).parent.parent.parent` is the repo root. A TS file's
// `import.meta.dir` is already its directory, so two `.parent` steps reach it.
const SAMPLES_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "marker");

/** Get the first marker value from a composition. */
function getFirstCompMarker(project: Project, compName: string | null = null): MarkerValue {
  let comp;
  if (compName) {
    comp = getComp(project, compName);
  } else {
    pyAssert(len(project.compositions) >= 1);
    comp = project.compositions[0];
  }
  pyAssert(len(comp.markers) >= 1);
  return comp.markers[0];
}

/** Get the first marker value from the first layer of a composition. */
function getFirstLayerMarker(project: Project, compName: string | null = null): MarkerValue {
  let comp;
  if (compName) {
    comp = getComp(project, compName);
  } else {
    pyAssert(len(project.compositions) >= 1);
    comp = project.compositions[0];
  }
  pyAssert(len(comp.layers) >= 1);
  const layer = comp.layers[0];
  pyAssert(len(layer.markers) >= 1);
  return layer.markers[0];
}

/** Tests for composition marker label. */
describe("TestCompMarkerLabel", () => {
  test("test_label_0", () => {
    const expected = loadExpected(SAMPLES_DIR, "comp_marker");
    const markerJson = getCompMarkerFromJsonByName(expected, "label_0");
    const marker = getFirstCompMarker(parseProject(SAMPLES_DIR.div("comp_marker.aep")), "label_0");
    expect(marker.label).toBe(markerJson["label"]);
    expect(markerJson["label"]).toBe(0);
  });

  test("test_label_3", () => {
    const expected = loadExpected(SAMPLES_DIR, "comp_marker");
    const markerJson = getCompMarkerFromJsonByName(expected, "label_3");
    const marker = getFirstCompMarker(parseProject(SAMPLES_DIR.div("comp_marker.aep")), "label_3");
    expect(marker.label).toBe(markerJson["label"]);
    expect(markerJson["label"]).toBe(3);
  });

  test("test_label_8", () => {
    const expected = loadExpected(SAMPLES_DIR, "comp_marker");
    const markerJson = getCompMarkerFromJsonByName(expected, "label_8");
    const marker = getFirstCompMarker(parseProject(SAMPLES_DIR.div("comp_marker.aep")), "label_8");
    expect(marker.label).toBe(markerJson["label"]);
    expect(markerJson["label"]).toBe(8);
  });
});

/** Tests for composition marker duration. */
describe("TestCompMarkerDuration", () => {
  test("test_duration_5", () => {
    const expected = loadExpected(SAMPLES_DIR, "comp_marker");
    const markerJson = getCompMarkerFromJsonByName(expected, "duration_5");
    const marker = getFirstCompMarker(parseProject(SAMPLES_DIR.div("comp_marker.aep")), "duration_5");
    expect(markerJson["duration"]).toBe(5);
    expect(isclose(marker.duration, markerJson["duration"])).toBe(true);
  });
});

/** Tests for composition marker comment. */
describe("TestCompMarkerComment", () => {
  test("test_comment", () => {
    const expected = loadExpected(SAMPLES_DIR, "comp_marker");
    const markerJson = getCompMarkerFromJsonByName(expected, "comment");
    const marker = getFirstCompMarker(parseProject(SAMPLES_DIR.div("comp_marker.aep")), "comment");
    expect(marker.comment).toBe(markerJson["comment"]);
    expect(markerJson["comment"]).toBe("Test comment");
  });
});

/** Tests for composition marker chapter. */
describe("TestCompMarkerChapter", () => {
  test("test_chapter", () => {
    const expected = loadExpected(SAMPLES_DIR, "comp_marker");
    const markerJson = getCompMarkerFromJsonByName(expected, "chapter");
    const marker = getFirstCompMarker(parseProject(SAMPLES_DIR.div("comp_marker.aep")), "chapter");
    expect(marker.chapter).toBe(markerJson["chapter"]);
    expect(markerJson["chapter"]).toBe("Chapter 1");
  });
});

/** Tests for composition marker URL. */
describe("TestCompMarkerUrl", () => {
  test("test_url", () => {
    const expected = loadExpected(SAMPLES_DIR, "comp_marker");
    const markerJson = getCompMarkerFromJsonByName(expected, "url");
    const marker = getFirstCompMarker(parseProject(SAMPLES_DIR.div("comp_marker.aep")), "url");
    expect(marker.url).toBe(markerJson["url"]);
    expect(markerJson["url"]).toBe("https://example.com");
  });
});

/** Tests for composition marker frame target. */
describe("TestCompMarkerFrameTarget", () => {
  test("test_frameTarget", () => {
    const expected = loadExpected(SAMPLES_DIR, "comp_marker");
    const markerJson = getCompMarkerFromJsonByName(expected, "frameTarget");
    const marker = getFirstCompMarker(parseProject(SAMPLES_DIR.div("comp_marker.aep")), "frameTarget");
    expect(marker.frameTarget).toBe(markerJson["frameTarget"]);
    expect(markerJson["frameTarget"]).toBe("_blank");
  });
});

/** Tests for composition marker cue point. */
describe("TestCompMarkerCuePoint", () => {
  test("test_cuePointName", () => {
    const expected = loadExpected(SAMPLES_DIR, "comp_marker");
    const markerJson = getCompMarkerFromJsonByName(expected, "cuePointName");
    const marker = getFirstCompMarker(parseProject(SAMPLES_DIR.div("comp_marker.aep")), "cuePointName");
    expect(marker.cuePointName).toBe(markerJson["cuePointName"]);
    expect(markerJson["cuePointName"]).toBe("cue_test");
  });
});

/** Tests for composition marker protected region. */
describe("TestCompMarkerProtectedRegion", () => {
  test("test_protectedRegion_true", () => {
    const expected = loadExpected(SAMPLES_DIR, "comp_marker");
    const markerJson = getCompMarkerFromJsonByName(expected, "protectedRegion_true");
    const marker = getFirstCompMarker(parseProject(SAMPLES_DIR.div("comp_marker.aep")), "protectedRegion_true");
    expect(markerJson["protectedRegion"]).toBe(true);
    expect(marker.protectedRegion).toBe(markerJson["protectedRegion"]);
  });
});

/** Tests for layer markers. */
describe("TestLayerMarker", () => {
  test("test_layer_marker_comment", () => {
    const expected = loadExpected(SAMPLES_DIR, "layer_marker");
    const markerJson = getLayerMarkerFromJsonByComp(expected, "layer_comment");
    const marker = getFirstLayerMarker(parseProject(SAMPLES_DIR.div("layer_marker.aep")), "layer_comment");
    expect(marker.comment).toBe(markerJson["comment"]);
    expect(markerJson["comment"]).toBe("Layer marker comment");
  });

  test("test_layer_marker_duration", () => {
    const expected = loadExpected(SAMPLES_DIR, "layer_marker");
    const markerJson = getLayerMarkerFromJsonByComp(expected, "layer_duration");
    const marker = getFirstLayerMarker(parseProject(SAMPLES_DIR.div("layer_marker.aep")), "layer_duration");
    expect(markerJson["duration"]).toBe(3);
    expect(isclose(marker.duration, markerJson["duration"])).toBe(true);
  });

  test("test_layer_marker_cuePointName", () => {
    const expected = loadExpected(SAMPLES_DIR, "layer_marker");
    const markerJson = getLayerMarkerFromJsonByComp(expected, "layer_cuePointName");
    const marker = getFirstLayerMarker(parseProject(SAMPLES_DIR.div("layer_marker.aep")), "layer_cuePointName");
    expect(marker.cuePointName).toBe(markerJson["cuePointName"]);
    expect(markerJson["cuePointName"]).toBe("layer_cue_1");
  });

  test("test_layer_marker_with_startTime", () => {
    /** Marker time is at comp time 5, layer startTime is 3. */
    const expected = loadExpected(SAMPLES_DIR, "layer_marker");
    const markerJson = getLayerMarkerFromJsonByComp(expected, "layer_marker_with_startTime");
    const marker = getFirstLayerMarker(
      parseProject(SAMPLES_DIR.div("layer_marker.aep")),
      "layer_marker_with_startTime",
    );
    expect(marker.comment).toBe(markerJson["comment"]);
    expect(markerJson["comment"]).toBe("marker at comp time 5");
  });

  test("test_layer_multiple_markers", () => {
    /** Three markers on one layer, parsed in correct order. */
    const project = parseProject(SAMPLES_DIR.div("layer_marker.aep"));
    const comp = getComp(project, "layer_multiple_markers");
    const layer = comp.layers[0];
    expect(len(layer.markers)).toBe(3);
    expect(layer.markers[0].comment).toBe("first marker");
    expect(layer.markers[1].comment).toBe("second marker");
    expect(layer.markers[2].comment).toBe("Third");
  });
});
