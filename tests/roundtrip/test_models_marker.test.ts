/** Tests for MarkerValue model parsing. */

import { describe, expect, test } from "bun:test";
import {
  AssertionError_,
  at,
  bytes_,
  isclose,
  len,
  Path,
  py_assert,
  py_bool,
  py_eq,
  StopIteration,
  TypeError_,
  ValueError,
} from "../../src/pyrt/index.ts";
import { make_tmp_path, raises } from "../../src/pyrt/pytest.ts";
import { MarkerValue, parse as parse_aep } from "../../src/py_aep/index.ts";
import type { Project } from "../../src/py_aep/index.ts";
import { Label } from "../../src/py_aep/enums/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { get_comp, parse_project_fresh } from "../helpers.ts";

const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "marker");

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

describe("TestRoundtripMarkerComment", () => {
  /** Roundtrip tests for MarkerValue.comment. */
  test("test_modify_comment", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("comp_marker.aep"));
    const marker = get_first_comp_marker(project, "comment");
    const original = marker.comment;
    expect(original).not.toBe("");

    marker.comment = "modified comment";
    const out = tmp_path.div("modified_comment.aep");
    project.save(out);
    const marker2 = get_first_comp_marker(parse_project_fresh(out), "comment");
    expect(marker2.comment).toBe("modified comment");
  });
});

describe("TestRoundtripMarkerDuration", () => {
  /** Roundtrip tests for MarkerValue.duration and frame_duration. */
  test("test_modify_frame_duration", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("comp_marker.aep"));
    const marker = get_first_comp_marker(project, "duration_5");
    const original_fd = marker.frameDuration;

    marker.frameDuration = original_fd + 10;
    const out = tmp_path.div("modified_frame_duration.aep");
    project.save(out);
    const marker2 = get_first_comp_marker(parse_project_fresh(out), "duration_5");
    expect(marker2.frameDuration).toBe(original_fd + 10);
  });

  test("test_modify_duration", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("comp_marker.aep"));
    const marker = get_first_comp_marker(project, "duration_5");

    marker.duration = 10.0;
    const out = tmp_path.div("modified_duration.aep");
    project.save(out);
    const marker2 = get_first_comp_marker(parse_project_fresh(out), "duration_5");
    expect(isclose(marker2.duration, 10.0, undefined, 0.01)).toBe(true);
  });

  test("test_frame_duration_is_in_frames", () => {
    // The 5 s marker of a 24 fps composition.
    const project = parse_project_fresh(SAMPLES_DIR.div("comp_marker.aep"));
    const marker = get_first_comp_marker(project, "duration_5");
    expect(marker.duration).toBe(5.0);
    expect(marker.frameDuration).toBe(120);
  });

  test("test_set_frame_duration", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("comp_marker.aep"));
    const marker = get_first_comp_marker(project, "duration_5");
    marker.frameDuration = 36;
    expect(marker.duration).toBe(1.5);
    const out = tmp_path.div("frame_duration.aep");
    project.save(out);
    const marker2 = get_first_comp_marker(parse_project_fresh(out), "duration_5");
    expect(marker2.duration).toBe(1.5);
    expect(marker2.frameDuration).toBe(36);
  });

  test("test_unbound_marker_has_no_frame_duration", () => {
    raises(
      ValueError,
      () => {
        void new MarkerValue("x").frameDuration;
      },
      "frame rate",
    );
  });

  /**
   * A new 2.5 s marker stores 1500 over 600, as AE 2026 writes for
   * `new MarkerValue()` + `duration = 2.5` + `setValueAtTime` (in 24,
   * 25 and 29.97 fps compositions alike).
   */
  test("test_new_marker_duration_bytes_match_ae", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("comp_marker.aep"));
    const comp = get_comp(project, "label_3");
    const marker = new MarkerValue("w_new");
    marker.duration = 2.5;
    if (comp.markerProperty === null) throw new AssertionError_("comp.marker_property is None");
    comp.markerProperty.setValueAtTime(2.0, marker);
    const out = tmp_path.div("new_marker.aep");
    project.save(out);
    const comp2 = get_comp(parse_project_fresh(out), "label_3");
    const new_ = comp2.markers.find((m) => m.comment === "w_new");
    if (new_ === undefined) throw new StopIteration();
    expect(
      py_eq(bytes_.slice(new_._nmhd.tobytes(), 8, 16), bytes_.fromhex("000005dc00000258")),
    ).toBe(true);
    expect(new_.duration).toBe(2.5);
  });
});

describe("TestValidateMarkerFrameDuration", () => {
  /** Validation tests for MarkerValue.frameDuration. */
  test("test_frame_duration_rejects_negative", () => {
    const project = parse_project_fresh(SAMPLES_DIR.div("comp_marker.aep"));
    const marker = get_first_comp_marker(project, "duration_5");
    raises(
      ValueError,
      () => {
        marker.frameDuration = -1;
      },
      "must be >= 0",
    );
  });

  test("test_frame_duration_rejects_float", () => {
    const project = parse_project_fresh(SAMPLES_DIR.div("comp_marker.aep"));
    const marker = get_first_comp_marker(project, "duration_5");
    raises(
      TypeError_,
      () => {
        marker.frameDuration = 1.5;
      },
      "expected an integer",
    );
  });
});

describe("TestRoundtripMarkerLabel", () => {
  /** Roundtrip tests for MarkerValue.label. */
  test("test_modify_label", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("comp_marker.aep"));
    const marker = get_first_comp_marker(project, "label_3");
    expect(marker.label).toBe(Label.AQUA);

    marker.label = Label.RED;
    const out = tmp_path.div("modified_label.aep");
    project.save(out);
    const marker2 = get_first_comp_marker(parse_project_fresh(out), "label_3");
    expect(marker2.label).toBe(Label.RED);
  });
});

describe("TestRoundtripMarkerNavigation", () => {
  /** Roundtrip tests for MarkerValue.navigation. */
  test("test_modify_navigation", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("comp_marker.aep"));
    const marker = get_first_comp_marker(project, "comment");
    const original = marker.navigation;

    marker.navigation = !original;
    const out = tmp_path.div("modified_navigation.aep");
    project.save(out);
    const marker2 = get_first_comp_marker(parse_project_fresh(out), "comment");
    expect(marker2.navigation).toBe(!original);
    expect(marker2.eventCuePoint).toBe(original);
  });
});

describe("TestRoundtripMarkerProtectedRegion", () => {
  /** Roundtrip tests for MarkerValue.protectedRegion. */
  test("test_modify_protected_region", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("comp_marker.aep"));
    const marker = get_first_comp_marker(project, "protectedRegion_true");
    expect(marker.protectedRegion).toBe(true);

    marker.protectedRegion = false;
    const out = tmp_path.div("modified_protected_region.aep");
    project.save(out);
    const marker2 = get_first_comp_marker(parse_project_fresh(out), "protectedRegion_true");
    expect(marker2.protectedRegion).toBe(false);
  });
});

describe("TestRoundtripMarkerChapter", () => {
  /** Roundtrip tests for MarkerValue.chapter. */
  test("test_modify_chapter", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("comp_marker.aep"));
    const marker = get_first_comp_marker(project, "chapter");
    expect(marker.chapter).not.toBe("");

    marker.chapter = "modified chapter";
    const out = tmp_path.div("modified_chapter.aep");
    project.save(out);
    const marker2 = get_first_comp_marker(parse_project_fresh(out), "chapter");
    expect(marker2.chapter).toBe("modified chapter");
  });
});

describe("TestRoundtripMarkerUrl", () => {
  /** Roundtrip tests for MarkerValue.url. */
  test("test_modify_url", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("comp_marker.aep"));
    const marker = get_first_comp_marker(project, "url");
    expect(marker.url).not.toBe("");

    marker.url = "https://example.com/modified";
    const out = tmp_path.div("modified_url.aep");
    project.save(out);
    const marker2 = get_first_comp_marker(parse_project_fresh(out), "url");
    expect(marker2.url).toBe("https://example.com/modified");
  });
});

describe("TestRoundtripMarkerFrameTarget", () => {
  /** Roundtrip tests for MarkerValue.frameTarget. */
  test("test_modify_frame_target", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("comp_marker.aep"));
    const marker = get_first_comp_marker(project, "frameTarget");
    expect(marker.frameTarget).not.toBe("");

    marker.frameTarget = "_blank";
    const out = tmp_path.div("modified_frame_target.aep");
    project.save(out);
    const marker2 = get_first_comp_marker(parse_project_fresh(out), "frameTarget");
    expect(marker2.frameTarget).toBe("_blank");
  });
});

describe("TestRoundtripMarkerCuePointName", () => {
  /** Roundtrip tests for MarkerValue.cuePointName. */
  test("test_modify_cue_point_name", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("comp_marker.aep"));
    const marker = get_first_comp_marker(project, "cuePointName");
    expect(marker.cuePointName).not.toBe("");

    marker.cuePointName = "modified_cue";
    const out = tmp_path.div("modified_cue_point_name.aep");
    project.save(out);
    const marker2 = get_first_comp_marker(parse_project_fresh(out), "cuePointName");
    expect(marker2.cuePointName).toBe("modified_cue");
  });
});

describe("TestMarkerParams", () => {
  /** Tests for MarkerValue cue-point params. */
  test("test_constructor_params", () => {
    const marker = new MarkerValue("c", undefined, undefined, undefined, undefined, new Map([["k1", "v1"], ["k2", "v2"]]));
    expect(py_eq(marker.params, new Map([["k1", "v1"], ["k2", "v2"]]))).toBe(true);
  });

  test("test_constructor_params_default_empty", () => {
    expect(py_eq(new MarkerValue().params, new Map())).toBe(true);
  });

  test("test_constructor_params_invalid", () => {
    raises(
      ValueError,
      () => {
        // @ts-expect-error params values must be strings; the constructor rejects the int at runtime
        new MarkerValue(undefined, undefined, undefined, undefined, undefined, new Map([["k", 1]]));
      },
      "string key-value pairs",
    );
  });

  test("test_constructor_params_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("layer_marker.aep"));
    const comp = get_comp(project, "layer_multiple_markers");
    const mp = comp.layers[0].property("ADBE Marker");
    mp.setValueAtTime(
      at(mp.keyframes, -1).time + 1.0,
      new MarkerValue("with params", undefined, undefined, undefined, undefined, new Map([["k1", "v1"], ["k2", "v2"]])),
    );
    const out = tmp_path.div("marker_params.aep");
    project.save(out);
    const comp2 = get_comp(parse_project_fresh(out), "layer_multiple_markers");
    const mp2 = comp2.layers[0].property("ADBE Marker");
    const kf2 = mp2.keyframes.find((k) => k.value.comment === "with params");
    if (kf2 === undefined) throw new StopIteration();
    const marker2 = kf2.value;
    expect(py_eq(marker2.params, new Map([["k1", "v1"], ["k2", "v2"]]))).toBe(true);
    // AE ignores params unless NmHd carries the pair count.
    expect(marker2._nmhd.num_params).toBe(2);
  });

  test("test_params_grow_and_shrink_on_parsed_marker", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("layer_marker.aep"));
    const marker = get_first_layer_marker(project, "layer_multiple_markers");
    expect(py_eq(marker.params, new Map())).toBe(true);

    marker.params = new Map([["k1", "v1"], ["k2", "v2"]]);
    const out = tmp_path.div("marker_params_grow.aep");
    project.save(out);
    const project2 = parse_project_fresh(out);
    const marker2 = get_first_layer_marker(project2, "layer_multiple_markers");
    expect(py_eq(marker2.params, new Map([["k1", "v1"], ["k2", "v2"]]))).toBe(true);
    // AE ignores params unless NmHd carries the pair count.
    expect(marker2._nmhd.num_params).toBe(2);

    marker2.params = new Map([["k1", "x"]]);
    const out2 = tmp_path.div("marker_params_shrink.aep");
    project2.save(out2);
    const project3 = parse_project_fresh(out2);
    const marker3 = get_first_layer_marker(project3, "layer_multiple_markers");
    expect(py_eq(marker3.params, new Map([["k1", "x"]]))).toBe(true);
    expect(marker3._nmhd.num_params).toBe(1);

    marker3.params = new Map();
    const out3 = tmp_path.div("marker_params_clear.aep");
    project3.save(out3);
    const marker4 = get_first_layer_marker(parse_project_fresh(out3), "layer_multiple_markers");
    expect(py_eq(marker4.params, new Map())).toBe(true);
    expect(marker4._nmhd.num_params).toBe(0);
  });

  test("test_params_set_after_keyframe_binding", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("layer_marker.aep"));
    const comp = get_comp(project, "layer_multiple_markers");
    const mp = comp.layers[0].property("ADBE Marker");
    mp.setValueAtTime(at(mp.keyframes, -1).time + 1.0, new MarkerValue("late"));
    const bound_kf = mp.keyframes.find((k) => k.value.comment === "late");
    if (bound_kf === undefined) throw new StopIteration();
    const bound = bound_kf.value;
    bound.params = new Map([["a", "1"], ["b", "2"]]);
    const out = tmp_path.div("marker_params_late.aep");
    project.save(out);
    const comp2 = get_comp(parse_project_fresh(out), "layer_multiple_markers");
    const mp2 = comp2.layers[0].property("ADBE Marker");
    const kf2 = mp2.keyframes.find((k) => k.value.comment === "late");
    if (kf2 === undefined) throw new StopIteration();
    const marker2 = kf2.value;
    expect(py_eq(marker2.params, new Map([["a", "1"], ["b", "2"]]))).toBe(true);
  });

  test("test_params_set_on_unbound_marker", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("layer_marker.aep"));
    const comp = get_comp(project, "layer_multiple_markers");
    const mp = comp.layers[0].property("ADBE Marker");
    const marker = new MarkerValue("unbound");
    marker.params = new Map([["p", "q"]]);
    expect(py_eq(marker.params, new Map([["p", "q"]]))).toBe(true);
    mp.setValueAtTime(at(mp.keyframes, -1).time + 1.0, marker);
    const out = tmp_path.div("marker_params_unbound.aep");
    project.save(out);
    const comp2 = get_comp(parse_project_fresh(out), "layer_multiple_markers");
    const mp2 = comp2.layers[0].property("ADBE Marker");
    const kf2 = mp2.keyframes.find((k) => k.value.comment === "unbound");
    if (kf2 === undefined) throw new StopIteration();
    const marker2 = kf2.value;
    expect(py_eq(marker2.params, new Map([["p", "q"]]))).toBe(true);
  });
});

describe("TestMarkerLazyParseRoundtrip", () => {
  /**
   * Regression: comp markers parse lazily on first access; that
   * access must not alter the saved bytes.
   */
  test("test_access_then_save_is_byte_identical", () => {
    const tmp_path = make_tmp_path();
    const src = SAMPLES_DIR.div("comp_marker.aep").read_bytes();
    // Parse fresh: the conftest parse_project_fresh cache returns projects
    // other tests may have mutated.
    const project = parse_aep(SAMPLES_DIR.div("comp_marker.aep")).project;
    for (const comp of project.compositions) {
      void comp.markers;
    }
    const out = tmp_path.div("out.aep");
    project.save(out);
    expect(py_eq(out.read_bytes(), src)).toBe(true);
  });
});

describe("TestRemoveAllMarkers", () => {
  /** CompItem.removeAllMarkers and Layer.removeAllMarkers. */
  test("test_comp_remove_all_markers", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("comp_marker.aep"));
    const comp = get_comp(project, "comment");
    expect(py_bool(comp.markers)).toBe(true);

    comp.removeAllMarkers();
    expect(py_eq(comp.markers, [])).toBe(true);
    const out = tmp_path.div("no_comp_markers.aep");
    project.save(out);
    const comp2 = get_comp(parse_project_fresh(out), "comment");
    expect(py_eq(comp2.markers, [])).toBe(true);
  });

  test("test_layer_remove_all_markers", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("layer_marker.aep"));
    const comp = get_comp(project, "layer_multiple_markers");
    const layer = comp.layers[0];
    expect(py_bool(layer.markers)).toBe(true);

    layer.removeAllMarkers();
    expect(py_eq(layer.markers, [])).toBe(true);
    const out = tmp_path.div("no_layer_markers.aep");
    project.save(out);
    const comp2 = get_comp(parse_project_fresh(out), "layer_multiple_markers");
    expect(py_eq(comp2.layers[0].markers, [])).toBe(true);
  });

  test("test_remove_all_markers_noop_without_markers", () => {
    const project = parse_project_fresh(SAMPLES_DIR.div("layer_marker.aep"));
    const comp = get_comp(project, "layer_multiple_markers");
    const layer = comp.layers[0];
    // The comp itself has no markers; layers keep an empty marker
    // property after draining. Both cases must be no-ops.
    comp.removeAllMarkers();
    expect(py_eq(comp.markers, [])).toBe(true);
    layer.removeAllMarkers();
    layer.removeAllMarkers();
    expect(py_eq(layer.markers, [])).toBe(true);
  });
});
