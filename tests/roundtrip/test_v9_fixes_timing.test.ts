/** Composition timing, markers and render-queue writes (v9 fuzz fixes).

The expected values are After Effects 2026 measurements (headless probes on
the same writes) unless a comment says otherwise.
*/

import { describe, expect, test } from "bun:test";
import { getattr, getitem, len, Path, py_bool, py_eq, round, setattr, sorted, TypeError_, ValueError } from "../../src/pyrt/index.ts";
import { approx, make_tmp_path, raises } from "../../src/pyrt/pytest.ts";
import * as py_aep from "../../src/py_aep/index.ts";
import { MarkerValue } from "../../src/py_aep/index.ts";
import type { Project } from "../../src/py_aep/index.ts";
import type { CompItem } from "../../src/py_aep/models/items/composition.ts";
import { RQItemStatus, TimeSpanSource } from "../../src/py_aep/enums/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { as_instance, parse_project_fresh, project_bytes } from "../helpers.ts";
import { RenderQueue } from "../../src/py_aep/models/renderqueue/render_queue.ts";
import type { Layer } from "../../src/py_aep/models/layers/layer.ts";
import type { Keyframe } from "../../src/py_aep/models/properties/keyframe.ts";

const SAMPLES = new Path(import.meta.path).parent.parent.parent.div("samples");

function _new_comp(rate: number = 24.0, duration: number = 10.0, platform: string | null = null): [Project, CompItem] {
  const project = py_aep.new(undefined, { platform }).project;
  return [project, project.root_folder.add_comp("c", 640, 360, 1.0, duration, rate)];
}

function _reparse(project: Project, tmp_path: Path, name: string = "out.aep"): Project {
  const out = tmp_path.div(name);
  project.save(out);
  return parse_project_fresh(out);
}

describe("TestFrameNumbers", () => {
  test.each([29.97, 59.94])("test_frames_read_back_at_ntsc_rates[%#]", (rate: number) => {
    const tmp_path = make_tmp_path();
    const [project, comp] = _new_comp(rate, 3600.0);
    comp.frame_time = 246;
    comp.display_start_frame = 1221;
    comp.work_area_start_frame = 10000;
    for (const c of [comp, _reparse(project, tmp_path).compositions.at(0)!]) {
      expect(c.frame_time).toBe(246);
      expect(c.display_start_frame).toBe(1221);
      expect(c.work_area_start_frame).toBe(10000);
    }
  });

  test("test_negative_times_match_extendscript_json", () => {
    // frameTime from the ExtendScript export of this AE-saved sample.
    const project = parse_project_fresh(SAMPLES.div("bugs", "29.97_fps_time_scale_3.125.aep"));
    const frame_times = new Map<number, number>(
      project.compositions.map((c): [number, number] => [c.id, c.frame_time]),
    );
    expect(getitem(frame_times, 11516)).toBe(-1244);
    expect(getitem(frame_times, 155)).toBe(-1221);
  });
});

describe("TestFrameRateChangeRetimesCompMarkers", () => {
  test("test_unread_comp_markers_keep_their_seconds", () => {
    const tmp_path = make_tmp_path();
    const [project, comp] = _new_comp();
    if (comp.marker_property == null) throw new Error("comp has no marker property");
    comp.marker_property.set_value_at_time(3.0, new MarkerValue("m"));
    const fresh = _reparse(project, tmp_path, "a.aep").compositions.at(0)!;
    fresh.frame_rate = 25; // the markers have not been read since parse
    const again = _reparse(fresh._project, tmp_path, "b.aep").compositions.at(0)!;
    for (const c of [fresh, again]) {
      if (c.marker_property == null) throw new Error("comp has no marker property");
      expect(py_eq(c.marker_property.keyframes.map((k) => k.time), [3.0])).toBe(true);
      expect(c.marker_property._tdb4._time_base).toBe(25600);
    }
  });

  test("test_duplicate_markers_keep_their_seconds", () => {
    const [_, comp] = _new_comp();
    if (comp.marker_property == null) throw new Error("comp has no marker property");
    comp.marker_property.set_value_at_time(3.0, new MarkerValue("m"));
    const dup = comp.duplicate();
    dup.frame_rate = 25;
    if (dup.marker_property == null) throw new Error("duplicate has no marker property");
    expect(py_eq(dup.marker_property.keyframes.map((k) => k.time), [3.0])).toBe(true);
  });
});

describe("TestDurationKeepsTimesInside", () => {
  /** AE 2026 `comp.duration = d` on a 10 s 24 fps comp. */

  test("test_pinned_end_past_new_end", () => {
    const [_, comp] = _new_comp();
    comp.work_area_start = 5;
    comp.work_area_duration = 3;
    comp.duration = 7;
    expect(py_eq([comp.work_area_start, comp.work_area_duration], [5.0, 2.0])).toBe(true);
    expect(comp._cdta.work_area_end_dividend).toBe(0xffffffff);
  });

  test.each([true, false])("test_start_past_new_end_moves_to_last_frame[%#]", (pinned: boolean) => {
    const [_, comp] = _new_comp();
    comp.work_area_start = 5;
    if (pinned) {
      comp.work_area_duration = 3;
    }
    comp.duration = 4;
    expect(approx(comp.work_area_start, 95 / 24)).toBe(true);
    expect(approx(comp.work_area_duration, 1 / 24)).toBe(true);
  });

  test.each([9.0, 5.0])("test_time_moves_to_last_frame[%#]", (time: number) => {
    const [_, comp] = _new_comp();
    comp.time = time;
    comp.duration = time === 9.0 ? 4 : 5;
    expect(approx(comp.time, comp.duration - 1 / 24)).toBe(true);
  });

  test("test_end_at_new_end_runs_to_end", () => {
    const [_, comp] = _new_comp();
    comp.work_area_start = 2;
    comp.work_area_duration = 3;
    comp.duration = 5;
    expect(py_eq([comp.work_area_start, comp.work_area_duration], [2.0, 3.0])).toBe(true);
    expect(comp._cdta.work_area_end_dividend).toBe(0xffffffff);
  });

  test("test_time_restored_over_timebase", () => {
    const [_, comp] = _new_comp();
    comp.duration = 20;
    expect(comp._cdta.time_divisor).toBe(comp._cdta.internal_timebase);
  });
});

describe("TestFrameRateChangeKeepsTimesInside", () => {
  test("test_work_area_start_on_the_end", () => {
    const [_, comp] = _new_comp();
    comp.work_area_start = 9.9;
    comp.frame_rate = 1;
    expect(py_eq([comp.work_area_start, comp.work_area_duration], [9.0, 1.0])).toBe(true);
  });

  test("test_work_area_start_rounding_to_the_end", () => {
    const [_, comp] = _new_comp();
    comp.frame_rate = 99;
    comp.duration = 1;
    comp.work_area_start = 98 / 99;
    comp.frame_rate = 1;
    expect(py_eq([comp.work_area_start, comp.work_area_duration], [0.0, 1.0])).toBe(true);
  });

  test("test_time_and_pinned_end_on_the_end", () => {
    const [_, comp] = _new_comp();
    comp.work_area_start = 1;
    comp.work_area_duration = 239 / 24 - 1;
    comp.time = 239 / 24;
    comp.frame_rate = 1;
    expect(comp.time).toBe(9.0);
    expect(comp._cdta.work_area_end_dividend).toBe(0xffffffff);
  });
});

describe("TestDecimalRates", () => {
  test.each([
    [23.98, 10.0083402835696],
    [29.98, 10.0066711140761],
    [7.3, 10.0],
    [44.1, 10.0],
    [99.99, 10.00100010001],
  ])("test_add_comp_duration[%#]", (rate: number, duration: number) => {
    const [_, comp] = _new_comp(rate);
    expect(approx(comp.duration, duration, { abs: 1e-9 })).toBe(true);
  });

  test("test_rate_change_keeps_keyframe_seconds", () => {
    const tmp_path = make_tmp_path();
    const [project, comp] = _new_comp();
    const layer = comp.add_solid([1.0, 0.0, 0.0], "s", 64, 64);
    const opacity = (layer.property("ADBE Transform Group") as any).property("ADBE Opacity");
    opacity.set_value_at_time(1.0, 0.0);
    opacity.set_value_at_time(5.5, 100.0);
    comp.frame_rate = 7.3;
    const again = _reparse(project, tmp_path).compositions.at(0)!;
    const times = ((again.layers.at(0)!.property("ADBE Transform Group") as any).property("ADBE Opacity") as any)
      .keyframes.map((k: any) => k.time);
    expect(approx(times, [1.0, 5.5], { abs: 1e-9 })).toBe(true);
    expect(approx(again.duration, 10.0)).toBe(true);
  });
});

describe("TestRateRoundingSaves", () => {
  test("test_comp_rate", () => {
    const tmp_path = make_tmp_path();
    const [project, comp] = _new_comp();
    comp.frame_rate = 23.99999999;
    expect(_reparse(project, tmp_path).compositions.at(0)!.frame_rate).toBe(24.0);
  });

  test("test_use_this_frame_rate", () => {
    const tmp_path = make_tmp_path();
    const [project, comp] = _new_comp();
    as_instance(project.render_queue, RenderQueue).add(comp).settings.__setitem__("Use this frame rate", 29.9999999);
    const rqi = as_instance(_reparse(project, tmp_path).render_queue, RenderQueue).items.at(0)!;
    expect(rqi.settings.__getitem__("Use this frame rate")).toBe(30.0);
  });
});

describe("TestNewItemOutputPath", () => {
  test("test_file_template_on_added_item", () => {
    const tmp_path = make_tmp_path();
    // A Windows path: on a macOS project (the default off Windows) it
    // would be stored as `/out/...`.
    const [project, comp] = _new_comp(undefined, undefined, "windows");
    const rqi = as_instance(project.render_queue, RenderQueue).add(comp);
    expect(rqi.status).toBe(RQItemStatus.NEEDS_OUTPUT);
    const template = "C:\\out\\[compName]_[#####].[fileExtension]";
    rqi.output_modules.at(0)!.file_template = template;
    const again = as_instance(_reparse(project, tmp_path).render_queue, RenderQueue).items.at(0)!;
    for (const item of [rqi, again]) {
      expect(item.output_modules.at(0)!.file_template).toBe(template);
      expect(item.output_modules.at(0)!.file).toBe("C:\\out\\c_[#####].tif");
      expect(item.status).toBe(RQItemStatus.QUEUED);
      expect(py_bool(item._ldat.render_checked)).toBe(true);
      // AE ignores an output path record without this bit.
      expect(py_bool(item.output_modules.at(0)!._om_ldat.has_output_file)).toBe(true);
    }
  });
});

describe("TestTimeSpanWrites", () => {
  test.each([Infinity, NaN, 1e300, 2.0 ** 31])("test_rejected_duration_mutates_nothing[%#]", (bad: number) => {
    const project = parse_project_fresh(SAMPLES.div("models", "renderqueue", "skip_frames.aep"));
    const rqi = as_instance(project.render_queue, RenderQueue).items.at(0)!;
    const before = project_bytes(project);
    raises(ValueError, () => {
      rqi.time_span_duration = bad;
    });
    expect(py_eq(project_bytes(project), before)).toBe(true);
  });

  test("test_string_rejected", () => {
    const [project, comp] = _new_comp();
    const rqi = as_instance(project.render_queue, RenderQueue).add(comp);
    raises(TypeError_, () => {
      // deliberately mistyped: the setter must reject a str
      rqi.time_span_start = "1" as any;
    });
  });

  test.each<[[number, number] | null, [string, number][], [number, number]]>([
    [null, [["start", 1.03]], [1.03, 8.97]],
    [null, [["duration", 2.51], ["start", 1.03]], [1.03, 2.51]],
    [null, [["start", 1], ["duration", 5], ["start", 3]], [3.0, 5.0]],
    [[2, 3], [["start", 2.5]], [2.5, 2.5]],
    [null, [["start", 9]], [9.0, 1.0]],
    [null, [["duration", 2.51], ["start", 9]], [9.0, 2.51]],
    [null, [["start", 2], ["start", 1]], [1.0, 8.0]],
  ])("test_start_keeps_end_then_duration[%#]", (work_area: [number, number] | null, steps: [string, number][], expected: [number, number]) => {
    // AE 2026: the first start write from the work area / comp keeps the
    // end, a start write on a CUSTOM span keeps the duration.
    const [project, comp] = _new_comp();
    if (work_area != null) {
      [comp.work_area_start, comp.work_area_duration] = work_area;
    }
    const rqi = as_instance(project.render_queue, RenderQueue).add(comp);
    for (const [field, value] of steps) {
      setattr(rqi, "time_span_" + field, value);
    }
    expect(rqi.settings.__getitem__("Time Span")).toBe(TimeSpanSource.CUSTOM);
    expect(approx([rqi.time_span_start, rqi.time_span_duration], expected)).toBe(true);
  });
});

describe("TestBounds", () => {
  test("test_comp_frame_rate_up_to_999", () => {
    const [project, comp] = _new_comp();
    comp.frame_rate = 999;
    expect(comp.frame_rate).toBe(999);
    expect(project.root_folder.add_comp("x", 64, 64, 1.0, 10.0, 120).frame_rate).toBe(120);
    raises(ValueError, () => {
      comp.frame_rate = 999.5;
    });
  });

  test.each([
    [24, -259200, 2072160],
    [29.97, -323676, 2587609],
    [23.976, -258940, 2070087],
  ])("test_display_start_bounds[%#]", (rate: number, lowest: number, highest: number) => {
    // AE 2026 bisected: frames from -10800 s to 86340 s; displayStartTime
    // itself goes to 86400 s.
    const [_, comp] = _new_comp(rate);
    comp.display_start_time = 86400;
    comp.display_start_frame = lowest;
    comp.display_start_frame = highest;
    expect(comp.display_start_frame).toBe(highest);
    raises(ValueError, () => {
      comp.display_start_frame = highest + 1;
    });
    raises(ValueError, () => {
      comp.display_start_frame = lowest - 1;
    });
  });
});

describe("TestNullNaming", () => {
  test("test_numbered_across_the_project", () => {
    // AE 2026: nulls take the next "Null N" over every project item
    // (solids, comps, folders), whatever comp they are added to.
    const project = py_aep.new().project;
    const a = project.root_folder.add_comp("A", 64, 64, 1.0, 10.0, 24);
    const b = project.root_folder.add_comp("B", 64, 64, 1.0, 10.0, 24);
    expect(py_eq([a.add_null().name, b.add_null().name], ["Null 1", "Null 2"])).toBe(true);
    project.root_folder.add_folder("Null 20");
    expect(a.add_null().name).toBe("Null 21");
  });
});

describe("TestRenderQueueItemIds", () => {
  test("test_added_and_duplicated_items_get_new_ids", () => {
    const tmp_path = make_tmp_path();
    const [project, comp] = _new_comp();
    const rq = as_instance(project.render_queue, RenderQueue);
    const first = rq.add(comp);
    const second = rq.add(comp);
    const dup = first.duplicate();
    expect(py_eq([first._ldat.item_id, second._ldat.item_id, dup._ldat.item_id], [2, 3, 4])).toBe(true);
    expect(
      py_eq(
        sorted(as_instance(_reparse(project, tmp_path).render_queue, RenderQueue).items.map((i) => i._ldat.item_id)),
        [2, 3, 4],
      ),
    ).toBe(true);
  });

  test("test_next_id_follows_the_highest", () => {
    const project = parse_project_fresh(SAMPLES.div("models", "renderqueue", "2_rqitems.aep"));
    const rq = as_instance(project.render_queue, RenderQueue);
    rq.items.at(0)!._ldat.item_id = 9;
    rq.items.at(1)!._ldat.item_id = 3;
    expect(rq.add(project.compositions.at(0)!)._ldat.item_id).toBe(10);
    expect(rq.items.at(0)!.duplicate()._ldat.item_id).toBe(11);
  });
});

describe("TestSettingsWritten", () => {
  test("test_set_by_settings_writes_only", () => {
    const [project, comp] = _new_comp();
    const rq = as_instance(project.render_queue, RenderQueue);
    const item = rq.add(comp);
    item.skip_frames = 1;
    item.time_span_start = 1;
    expect(item._ldat.settings_written).toBe(0);
    item.settings.__setitem__("Quality", item.settings.__getitem__("Quality"));
    expect(item._ldat.settings_written).toBe(1);
  });
});

describe("TestDuplicateTime", () => {
  test("test_duplicate_starts_at_time_zero", () => {
    const [_, comp] = _new_comp();
    comp.time = 2.5;
    const dup = comp.duplicate();
    expect(comp.time).toBe(2.5);
    expect(dup.time).toBe(0.0);
  });
});

describe("TestRatesWithMoreDecimals", () => {
  test.each([
    [3.3333, 9.9009900990099],
    [12.3456, 9.96274096873481],
    [39.0625, 10.00947187876],
    [1.001, 9.99000999000999],
    [99.123, 9.99767965053519],
    [78.125, 9.9968],
  ])("test_new_comp_duration[%#]", (rate: number, duration: number) => {
    // AE 2026 addComp(..., 10 s, rate): the duration snaps on the grid
    // of the rate read to the thousandth (3.333 fps: 8000 units a frame).
    const [_, comp] = _new_comp(rate);
    expect(approx(comp.duration, duration, { abs: 1e-9 })).toBe(true);
  });
});

const _SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';

describe("TestTinySvgCanvas", () => {
  test.each<[string, [number, number]]>([
    ['viewBox="0 0 3 100"', [3, 100]],
    ['viewBox="0 0 1 1"', [1, 1]],
    ['width="2" height="5"', [2, 5]],
  ])("test_imports_comp_below_add_comp_floor[%#]", (attrs: string, size: [number, number]) => {
    const tmp_path = make_tmp_path();
    // AE 2026 imports these as 3x100, 1x1 and 2x5 comps (1 frame, 30 fps,
    // one shape layer), although its addComp refuses under 4 px.
    const svg = tmp_path.div("tiny.svg");
    svg.write_text(`<svg ${_SVG_NS} ${attrs}><rect width='1' height='1'/></svg>`);
    const project = py_aep.new().project;
    const opts = new py_aep.ImportOptions(svg);
    opts.import_as = py_aep.ImportAsType.COMP_CROPPED_LAYERS;
    const comp = project.import_file(opts);
    const again = _reparse(project, tmp_path).compositions.find((c) => c.name === "tiny.svg")! as CompItem;
    for (const c of [comp as CompItem, again]) {
      expect(py_eq([c.width, c.height], size)).toBe(true);
      expect(len(c.layers)).toBe(1);
      expect(c.frame_rate).toBe(30.0);
    }
  });

  test("test_add_comp_keeps_its_floor", () => {
    // AE 2026 addComp: "Value 3 out of range 4 to 30000".
    const project = py_aep.new().project;
    raises(
      ValueError,
      () => {
        project.root_folder.add_comp("x", 3, 100, 1.0, 1.0, 30.0);
      },
      "must be >= 4",
    );
  });
});

const _KEY_TIMES = [4.0, 2.0, 0.5, 1.3, 7.25];

/** A solid set up like the AE probe: stretch, then start, then keys. */
function _stretched_layer(comp: CompItem, stretch: number, start: number, times: number[] = _KEY_TIMES): any {
  const layer = comp.add_solid([0.5, 0.5, 0.5], "L", 10, 10, 1.0, 10.0);
  layer.stretch = stretch;
  layer.start_time = start;
  for (const [i, t] of times.entries()) {
    layer.transform.__getitem__("ADBE Opacity").set_value_at_time(t, 10.0 * (i + 1));
  }
  return layer;
}

function _ticks(layer: Layer): number[] {
  return sorted(layer.transform.__getitem__("ADBE Opacity").keyframes.map((kf) => kf.time_units));
}

function _start_ratio(layer: any): [number, number] {
  return [layer._ldta.start_time_dividend, layer._ldta.start_time_divisor];
}


describe("TestStretchedLayerKeyTimes", () => {
  // Key times and stored ticks AE 2026 reported / saved for the same
  // setValueAtTime calls on a new layer (stretch, then startTime 1.3).
  test.each<[number, [number, number], number[], number[]]>([
    [
      24.0,
      [47923, 36864],
      [-146240, -66368, -17216, -12, 19648],
      [7.25001540798611, 4.00001540798611, 2.00001540798611, 1.29998285590278, 0.50001540798611],
    ],
    [
      29.97,
      [46753, 35964],
      [-142669, -64747, -16795, -12, 19169],
      [7.24998659770882, 3.99998659770882, 1.99998659770882, 1.29999493938383, 0.49998659770882],
    ],
  ])(
    "test_reversed_layer_with_start_matches_ae[%#]",
    (rate: number, start_ratio: [number, number], ticks: number[], times: number[]) => {
      const tmp_path = make_tmp_path();
      const [project, comp] = _new_comp(rate);
      const layer = _stretched_layer(comp, -150.0, 1.3);
      const again = _reparse(project, tmp_path).compositions.at(0)!.layers.at(0)!;
      for (const lyr of [layer, again]) {
        expect(py_eq(_start_ratio(lyr), start_ratio)).toBe(true);
        expect(py_eq(_ticks(lyr), ticks)).toBe(true);
        const got = lyr.transform.opacity.keyframes.map((kf: Keyframe) => kf.time);
        expect(approx(got, times, { abs: 1e-12 })).toBe(true);
      }
    },
  );

  test.each([
    [500.0, 4.0],
    [9900.0, 4.00015625],
    [-500.0, 3.99998263888889],
  ])("test_timebase_is_capped[%#]", (stretch: number, key_time: number) => {
    const tmp_path = make_tmp_path();
    // 24 fps x 5 would be 122880: AE counts these layers' ticks against
    // 115200, and reads a key it set at 4.0 back at these times.
    const [project, comp] = _new_comp(24.0);
    const layer = _stretched_layer(comp, stretch, 1.3, [4.0]);
    const again = _reparse(project, tmp_path).compositions.at(0)!.layers.at(0)!;
    for (const lyr of [layer, again]) {
      const prop = lyr.transform.opacity;
      expect(prop._tdb4._time_base).toBe(115200);
      expect(py_eq(_start_ratio(lyr), [149760, 115200])).toBe(true);
      expect(approx(prop.keyframes.at(0)!.time, key_time, { abs: 1e-12 })).toBe(true);
    }
  });

  test("test_key_lands_where_ae_evaluates_the_time", () => {
    // 77.777 fps, 100 %: 0.5 s is 38888.5 comp ticks; AE snaps it up
    // and keys tick -62221 (the nearest tick to the exact layer time is
    // a tie, which round-half-even sent to -62222).
    const [_project, comp] = _new_comp(77.777);
    expect(py_eq(_ticks(_stretched_layer(comp, 100.0, 1.3)), [-62221, 0, 54444, 209998, 462773])).toBe(true);
    // -50 %: AE keyed 124416 at 0.5 s, one tick off the nearest.
    expect(py_eq(_ticks(_stretched_layer(comp, -50.0, 1.3)), [-925572, -420022, -108914, -26, 124416])).toBe(true);
  });
});

describe("TestLayerStartTime", () => {
  test.each<[number, number, number, [number, number]]>([
    [24.0, 100.0, 1.3, [31949, 24576]],
    [24.0, 150.0, 1.3, [47923, 36864]],
    [24.0, -200.0, 0.7, [34406, 49152]],
    [24.0, -50.0, 1.3, [31949, 24576]],
    [24.0, 100.0, -1.3, [-31949, 24576]],
    [25.0, 150.0, 1.3, [49920, 38400]],
    [29.97, 100.0, 1.3, [31169, 23976]],
    [24.0, 300.0, 10800.0, [796262400, 73728]],
  ])("test_snaps_to_layer_ticks[%#]", (rate: number, stretch: number, start: number, ratio: [number, number]) => {
    const tmp_path = make_tmp_path();
    const [project, comp] = _new_comp(rate);
    const layer = comp.add_solid([0.5, 0.5, 0.5], "L", 10, 10, 1.0, 10.0);
    layer.stretch = stretch;
    layer.start_time = start;
    const again = _reparse(project, tmp_path).compositions.at(0)!.layers.at(0)!;
    for (const lyr of [layer, again]) {
      expect(py_eq(_start_ratio(lyr), ratio)).toBe(true);
      expect(lyr.start_time).toBe(ratio[0] / ratio[1]);
    }
  });

  test.each([
    [100.0, 0.5, 1],
    [100.0, 1.5, 2],
    [100.0, 2.5, 3],
    [100.0, -0.5, 0],
    [100.0, -1.5, -1],
    [100.0, -2.5, -2],
    [200.0, 0.5, 1],
    [200.0, 2.5, 3],
    [200.0, -2.5, -2],
  ])("test_tie_rounds_up[%#]", (stretch: number, ticks: number, expected: number) => {
    // 32 fps: 32768 ticks a second (65536 at 200 %), so these are exact.
    const [_project, comp] = _new_comp(32.0);
    const layer = comp.add_solid([0.5, 0.5, 0.5], "L", 10, 10, 1.0, 10.0);
    layer.stretch = stretch;
    const base = layer.transform.__getitem__("ADBE Opacity")._layer_timebase;
    layer.start_time = ticks / base;
    expect(layer._ldta.start_time_dividend).toBe(expected);
  });

  test("test_stretch_change_keeps_the_stored_start", () => {
    const [_project, comp] = _new_comp(24.0);
    const layer = comp.add_solid([0.5, 0.5, 0.5], "L", 10, 10, 1.0, 10.0);
    layer.start_time = 1.3;
    layer.stretch = 150.0;
    expect(py_eq(_start_ratio(layer), [31949, 24576])).toBe(true);
    layer.stretch = 100.0;
    layer.start_time = 1.3;
    layer.stretch = -150.0;
    expect(py_eq(_start_ratio(layer), [31949, 24576])).toBe(true);
  });

  test("test_start_past_the_field_is_rejected", () => {
    // At 115200 ticks a second the signed 32-bit start holds 18641 s.
    const [_project, comp] = _new_comp(24.0);
    const layer = comp.add_solid([0.5, 0.5, 0.5], "L", 10, 10, 1.0, 10.0);
    layer.stretch = 500.0;
    layer.start_time = 18641.0;
    const before = _start_ratio(layer);
    raises(
      ValueError,
      () => {
        layer.start_time = 18642.0;
      },
      "must be <=",
    );
    raises(
      ValueError,
      () => {
        layer.start_time = -18642.0;
      },
      "must be >=",
    );
    expect(py_eq(_start_ratio(layer), before)).toBe(true);
  });
});

describe("TestRetimeRoundsHalfUp", () => {
  test("test_stretch_change", () => {
    // Keys at ticks 15, -13, -15, 13 (24 fps, 100 %); AE 2026 at 150 %.
    const [_project, comp] = _new_comp(24.0);
    const layer = _stretched_layer(
      comp,
      100.0,
      0.0,
      [15, -13, -15, 13].map((u) => u / 24576),
    );
    layer.stretch = 150.0;
    expect(py_eq(_ticks(layer), [-22, -19, 20, 23])).toBe(true);
  });

  test("test_frame_rate_change", () => {
    // 24 -> 25 fps scales ticks by 25 / 24, ties up; a 500 % layer sits
    // at the 115200 cap at both rates, so its ticks stay (AE 2026).
    const [_project, comp] = _new_comp(24.0);
    const times = [12, 60, -36, -84, 24576].map((u) => u / 24576);
    const plain = _stretched_layer(comp, 100.0, 0.0, times);
    const capped = _stretched_layer(comp, 100.0, 0.0, times);
    capped.stretch = 500.0;
    expect(py_eq(_ticks(capped), [-394, -169, 56, 281, 115200])).toBe(true);
    comp.frame_rate = 25.0;
    expect(py_eq(_ticks(plain), [-87, -37, 13, 63, 25600])).toBe(true);
    expect(py_eq(_ticks(capped), [-394, -169, 56, 281, 115200])).toBe(true);
  });
});

function _stretch_ratio(layer: any): [number, number] {
  return [layer._ldta.stretch_dividend, layer._ldta.stretch_divisor];
}

describe("TestStretchStorage", () => {
  test("test_float32_ratio_survives_a_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const [project, comp] = _new_comp(24.0);
    const layer = comp.add_solid([0.5, 0.5, 0.5], "L", 10, 10, 1.0, 10.0);
    layer.stretch = 133.33;
    const again = _reparse(project, tmp_path).compositions.at(0)!.layers.at(0)!;
    for (const lyr of [layer, again]) {
      expect(py_eq(_stretch_ratio(lyr), [11184531, 8388608])).toBe(true);
      expect(lyr.stretch).toBe((11184531 * 100) / 8388608);
    }
  });

  test("test_near_tie_key_matches_ae", () => {
    // 133.33 % at 77.777 fps: with the stretch stored as 13333 / 10000 the
    // key set at 4.0 s landed one tick short of AE's 209996.
    const [_project, comp] = _new_comp(77.777);
    const layer = _stretched_layer(comp, 133.33, 1.3);
    expect(py_eq(_start_ratio(layer), [134809, 103699])).toBe(true);
    expect(py_eq(_ticks(layer), [-62221, 0, 54443, 209996, 462768])).toBe(true);
    const got = sorted(layer.transform.__getitem__("ADBE Opacity").keyframes.map((kf: Keyframe) => kf.time));
    expect(
      approx(
        got,
        [
          0.50000232458115, 1.30000289298836, 1.99999856948853, 4.00000667572021, 7.24999856948853,
        ],
        { abs: 1e-6 },
      ),
    ).toBe(true);
  });

  test.each<[number, [number, number]]>([
    [0.5, [655, 65536]],
    [0.0001, [655, 65536]],
    [0.0, [655, 65536]],
    [-0.5, [-655, 65536]],
  ])("test_under_one_percent[%#]", (percent: number, ratio: [number, number]) => {
    // AE 2026 sets them all to 655 / 65536, read back as 0.99945068359375.
    const [_project, comp] = _new_comp(24.0);
    const layer = comp.add_solid([0.5, 0.5, 0.5], "L", 10, 10, 1.0, 10.0);
    layer.stretch = percent;
    expect(py_eq(_stretch_ratio(layer), ratio)).toBe(true);
    expect(Math.abs(layer.stretch)).toBe(0.99945068359375);
  });

  test("test_bound_is_the_field_width", () => {
    const tmp_path = make_tmp_path();
    // AE refuses 10000 % from a script but opens a file holding 1e6 %.
    const [project, comp] = _new_comp(24.0);
    const layer = comp.add_solid([0.5, 0.5, 0.5], "L", 10, 10, 1.0, 10.0);
    layer.stretch = 1e6;
    expect(py_eq(_stretch_ratio(layer), [10000, 1])).toBe(true);
    layer.stretch = 2147483520 * 100.0;
    expect(py_eq(_stretch_ratio(layer), [2147483520, 1])).toBe(true);
    raises(
      ValueError,
      () => {
        layer.stretch = 2147483600 * 100.0;
      },
      "must be <=",
    );
    raises(
      ValueError,
      () => {
        layer.stretch = -2147483600 * 100.0;
      },
      "must be >=",
    );
    expect(py_eq(_stretch_ratio(layer), [2147483520, 1])).toBe(true);
    _reparse(project, tmp_path);
  });
});

describe("TestFrameGridPastTheCap", () => {
  // AE 2026 addComp(..., 3.3 s, rate), then duration = 1.0001,
  // time = 0.5041, workAreaStart = 0.2004, workAreaDuration = 0.5,
  // displayStartTime = 0.1234, and keys set at 0.5041 and 0.25 s.
  test.each<[number, [number, number], Map<string, unknown>]>([
    [
      120.001,
      [60000, 500],
      new Map<string, any>([
        ["dur0", 3.3],
        ["dur", 1.0],
        ["time", 0.5],
        ["was", 0.2],
        ["wad", 0.5],
        ["dsf", 15],
        ["keys", [0.25, 0.5041]],
      ]),
    ],
    [
      333.333,
      [83333, 250],
      new Map<string, any>([
        ["dur0", 3.3000132000528],
        ["dur", 0.99900399601598],
        ["time", 0.50400201600806],
        ["was", 0.20100080400322],
        ["wad", 0.50100200400802],
        ["dsf", 42],
        ["keys", [0.249996999988, 0.50409801639207]],
      ]),
    ],
    [
      750.001,
      [93750, 125],
      new Map<string, any>([
        ["dur0", 3.3],
        ["dur", 1.0],
        ["time", 0.504],
        ["was", 0.2],
        ["wad", 0.5],
        ["dsf", 93],
        ["keys", [0.25000533333333, 0.504096]],
      ]),
    ],
    [
      998.999,
      [62437, 62],
      // AE's duration setter counts this grid's frames differently
      // (999 frames for 1.0001 s); not compared.
      new Map<string, any>([
        ["dur0", 3.2997421400772],
        ["time", 0.50444448003588],
        ["was", 0.20058619088041],
        ["wad", 0.50047247625607],
        ["dsf", 125],
        ["keys", [0.24999599596393, 0.50409212486186]],
      ]),
    ],
  ])("test_comp_times_match_ae[%#]", (rate: number, grid: [number, number], expected: Map<string, any>) => {
    const tmp_path = make_tmp_path();
    const [project, comp] = _new_comp(rate, 3.3);
    const cdta = comp._cdta;
    expect(py_eq([cdta.internal_timebase, round(cdta.time_scale * 256)], grid)).toBe(true);
    const got = new Map<string, any>([["dur0", comp.duration]]);
    comp.duration = 1.0001;
    got.set("dur", comp.duration);
    comp.time = 0.5041;
    got.set("time", comp.time);
    comp.work_area_start = 0.2004;
    got.set("was", comp.work_area_start);
    comp.work_area_duration = 0.5;
    got.set("wad", comp.work_area_duration);
    comp.display_start_time = 0.1234;
    got.set("dsf", comp.display_start_frame);
    const layer = comp.add_solid([0.5, 0.5, 0.5], "k", 10, 10, 1.0, 1.0);
    layer.transform.__getitem__("ADBE Opacity").set_value_at_time(0.5041, 10.0);
    layer.transform.__getitem__("ADBE Opacity").set_value_at_time(0.25, 20.0);
    got.set(
      "keys",
      layer.transform.__getitem__("ADBE Opacity").keyframes.map((kf) => kf.time),
    );
    for (const [key, value] of expected.entries()) {
      // The Python assertion message names the key; bun's expect takes no message.
      expect(approx(getitem(got, key), value, { abs: 1e-11 })).toBe(true);
    }
    const again = _reparse(project, tmp_path).compositions.at(0)!;
    expect(again.time).toBe(comp.time);
    expect(again.work_area_start).toBe(comp.work_area_start);
  });
});

describe("TestReversedInOutPoints", () => {
  // AE 2026: 10 s null, stretch then startTime; inPoint / outPoint read.
  test.each([
    [-150.0, 1.3, 1.29949457465278, -13.7005054253472],
    [-150.0, -0.7, -0.70050542534722, -15.7005054253472],
    [-100.0, 1.3, 1.2996748046875, -8.7003251953125],
    [-50.0, -0.7, -0.70015852864583, -5.70015852864583],
    [-200.0, 1.3, 1.29934147135417, -18.7006585286458],
    [150.0, 1.3, 1.29999457465278, 16.2999945746528],
  ])(
    "test_defaults_match_ae[%#]",
    (stretch: number, start: number, in_point: number, out_point: number) => {
      const tmp_path = make_tmp_path();
      const [project, comp] = _new_comp(24.0, 30.0);
      const layer = comp.add_null(10.0);
      layer.stretch = stretch;
      layer.start_time = start;
      const again = _reparse(project, tmp_path).compositions.at(0)!.layers.at(0)!;
      for (const lyr of [layer, again]) {
        expect(approx(lyr.in_point, in_point, { abs: 1e-11 })).toBe(true);
        expect(approx(lyr.out_point, out_point, { abs: 1e-11 })).toBe(true);
      }
    },
  );

  test("test_writes_read_back", () => {
    // AE 2026, -150 % from 1.3 s: inPoint = 1 then outPoint = -3 read
    // back as written.
    const [_project, comp] = _new_comp(24.0, 30.0);
    const layer = comp.add_null(10.0);
    layer.stretch = -150.0;
    layer.start_time = 1.3;
    layer.in_point = 1.0;
    layer.out_point = -3.0;
    expect(approx(layer.in_point, 1.0, { abs: 1e-9 })).toBe(true);
    expect(approx(layer.out_point, -3.0, { abs: 1e-9 })).toBe(true);
  });

  test.each([
    [100.0, "in", 2.5 / 24576, 3 / 24576],
    [100.0, "in", -1.5 / 24576, -1 / 24576],
    [100.0, "out", 3 + 2.5 / 24576, 3 + 3 / 24576],
    [150.0, "in", 1 / 36864, 1 / 36864],
    [150.0, "in", 0.5 / 24576, 1 / 36864],
    [-100.0, "in", -2.5 / 24576, -2 / 24576],
    [-150.0, "in", -1 / 36864, -1 / 36864],
  ])("test_writes_snap_to_layer_ticks[%#]", (stretch: number, which: string, value: number, expected: number) => {
    // The times AE 2026 read back for the same writes at 24 fps.
    const [_project, comp] = _new_comp(24.0, 30.0);
    const layer = comp.add_solid([0.5, 0.5, 0.5], "L", 10, 10, 1.0, 30.0);
    layer.stretch = stretch;
    setattr(layer, which + "_point", value);
    expect(approx(getattr(layer, which + "_point"), expected, { abs: 1e-12 })).toBe(true);
  });

  test("test_ae_sample_matches_extendscript", () => {
    // layer_timing.json: the -100 % layer reads in -0.000333333333,
    // out -60.000333333333.
    const project = py_aep.parse(SAMPLES.div("models", "layer", "layer_timing.aep")).project;
    const reversed_layers = project.compositions
      .flatMap((c) => c.layers)
      .filter((lyr) => lyr.stretch < 0);
    expect(py_bool(reversed_layers)).toBe(true);
    for (const lyr of reversed_layers) {
      expect(approx(lyr.in_point, -1 / 3000, { abs: 1e-12 })).toBe(true);
      expect(approx(lyr.out_point, -60 - 1 / 3000, { abs: 1e-12 })).toBe(true);
    }
  });
});
