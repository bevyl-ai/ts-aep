/** Composition timing, markers and render-queue writes (v9 fuzz fixes).

The expected values are After Effects 2026 measurements (headless probes on
the same writes) unless a comment says otherwise.
*/

import { describe, expect, test } from "bun:test";
import { at, getattr, getitem, len, Path, pyBool, pyEq, round, setattr, sorted, StopIteration, TypeError_, ValueError } from "../../src/pyrt/index.ts";
import { approx, makeTmpPath, raises } from "../../src/pyrt/pytest.ts";
import * as py_aep from "../../src/py_aep/index.ts";
import { MarkerValue } from "../../src/py_aep/index.ts";
import type { Project } from "../../src/py_aep/index.ts";
import { CompItem } from "../../src/py_aep/models/items/composition.ts";
import { RQItemStatus, TimeSpanSource } from "../../src/py_aep/enums/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { asInstance, parseProjectFresh, projectBytes } from "../helpers.ts";
import { RenderQueue } from "../../src/py_aep/models/renderqueue/render_queue.ts";
import type { Layer } from "../../src/py_aep/models/layers/layer.ts";
import type { AVLayer } from "../../src/py_aep/models/layers/av_layer.ts";
import type { Keyframe } from "../../src/py_aep/models/properties/keyframe.ts";

const SAMPLES = new Path(import.meta.path).parent.parent.parent.div("samples");

function _newComp(rate: number = 24.0, duration: number = 10.0, platform: string | null = null): [Project, CompItem] {
  const project = py_aep.newProject(undefined, { platform }).project;
  return [project, project.rootFolder.addComp("c", 640, 360, 1.0, duration, rate)];
}

function _reparse(project: Project, tmpPath: Path, name: string = "out.aep"): Project {
  const out = tmpPath.div(name);
  project.save(out);
  return parseProjectFresh(out);
}

describe("TestFrameNumbers", () => {
  test.each([29.97, 59.94])("test_frames_read_back_at_ntsc_rates[%#]", (rate: number) => {
    const tmpPath = makeTmpPath();
    const [project, comp] = _newComp(rate, 3600.0);
    comp.frameTime = 246;
    comp.displayStartFrame = 1221;
    comp.workAreaStartFrame = 10000;
    for (const c of [comp, at(_reparse(project, tmpPath).compositions, 0)]) {
      expect(c.frameTime).toBe(246);
      expect(c.displayStartFrame).toBe(1221);
      expect(c.workAreaStartFrame).toBe(10000);
    }
  });

  test("test_negative_times_match_extendscript_json", () => {
    // frameTime from the ExtendScript export of this AE-saved sample.
    const project = parseProjectFresh(SAMPLES.div("bugs", "29.97_fps_time_scale_3.125.aep"));
    const frameTimes = new Map<number, number>(
      project.compositions.map((c): [number, number] => [c.id, c.frameTime]),
    );
    expect(getitem(frameTimes, 11516)).toBe(-1244);
    expect(getitem(frameTimes, 155)).toBe(-1221);
  });
});

describe("TestFrameRateChangeRetimesCompMarkers", () => {
  test("test_unread_comp_markers_keep_their_seconds", () => {
    const tmpPath = makeTmpPath();
    const [project, comp] = _newComp();
    if (comp.markerProperty == null) throw new Error("comp has no marker property");
    comp.markerProperty.setValueAtTime(3.0, new MarkerValue("m"));
    const fresh = at(_reparse(project, tmpPath, "a.aep").compositions, 0);
    fresh.frameRate = 25; // the markers have not been read since parse
    const again = at(_reparse(fresh._project, tmpPath, "b.aep").compositions, 0);
    for (const c of [fresh, again]) {
      if (c.markerProperty == null) throw new Error("comp has no marker property");
      expect(pyEq(c.markerProperty.keyframes.map((k) => k.time), [3.0])).toBe(true);
      expect(c.markerProperty._tdb4._timeBase).toBe(25600);
    }
  });

  test("test_duplicate_markers_keep_their_seconds", () => {
    const [_, comp] = _newComp();
    if (comp.markerProperty == null) throw new Error("comp has no marker property");
    comp.markerProperty.setValueAtTime(3.0, new MarkerValue("m"));
    const dup = comp.duplicate();
    dup.frameRate = 25;
    if (dup.markerProperty == null) throw new Error("duplicate has no marker property");
    expect(pyEq(dup.markerProperty.keyframes.map((k) => k.time), [3.0])).toBe(true);
  });
});

describe("TestDurationKeepsTimesInside", () => {
  /** AE 2026 `comp.duration = d` on a 10 s 24 fps comp. */

  test("test_pinned_end_past_new_end", () => {
    const [_, comp] = _newComp();
    comp.workAreaStart = 5;
    comp.workAreaDuration = 3;
    comp.duration = 7;
    expect(pyEq([comp.workAreaStart, comp.workAreaDuration], [5.0, 2.0])).toBe(true);
    expect(comp._cdta.workAreaEndDividend).toBe(0xffffffff);
  });

  test.each([true, false])("test_start_past_new_end_moves_to_last_frame[%#]", (pinned: boolean) => {
    const [_, comp] = _newComp();
    comp.workAreaStart = 5;
    if (pinned) {
      comp.workAreaDuration = 3;
    }
    comp.duration = 4;
    expect(approx(comp.workAreaStart, 95 / 24)).toBe(true);
    expect(approx(comp.workAreaDuration, 1 / 24)).toBe(true);
  });

  test.each([9.0, 5.0])("test_time_moves_to_last_frame[%#]", (time: number) => {
    const [_, comp] = _newComp();
    comp.time = time;
    comp.duration = time === 9.0 ? 4 : 5;
    expect(approx(comp.time, comp.duration - 1 / 24)).toBe(true);
  });

  test("test_end_at_new_end_runs_to_end", () => {
    const [_, comp] = _newComp();
    comp.workAreaStart = 2;
    comp.workAreaDuration = 3;
    comp.duration = 5;
    expect(pyEq([comp.workAreaStart, comp.workAreaDuration], [2.0, 3.0])).toBe(true);
    expect(comp._cdta.workAreaEndDividend).toBe(0xffffffff);
  });

  test("test_time_restored_over_timebase", () => {
    const [_, comp] = _newComp();
    comp.duration = 20;
    expect(comp._cdta.timeDivisor).toBe(comp._cdta.internalTimebase);
  });
});

describe("TestFrameRateChangeKeepsTimesInside", () => {
  test("test_work_area_start_on_the_end", () => {
    const [_, comp] = _newComp();
    comp.workAreaStart = 9.9;
    comp.frameRate = 1;
    expect(pyEq([comp.workAreaStart, comp.workAreaDuration], [9.0, 1.0])).toBe(true);
  });

  test("test_work_area_start_rounding_to_the_end", () => {
    const [_, comp] = _newComp();
    comp.frameRate = 99;
    comp.duration = 1;
    comp.workAreaStart = 98 / 99;
    comp.frameRate = 1;
    expect(pyEq([comp.workAreaStart, comp.workAreaDuration], [0.0, 1.0])).toBe(true);
  });

  test("test_time_and_pinned_end_on_the_end", () => {
    const [_, comp] = _newComp();
    comp.workAreaStart = 1;
    comp.workAreaDuration = 239 / 24 - 1;
    comp.time = 239 / 24;
    comp.frameRate = 1;
    expect(comp.time).toBe(9.0);
    expect(comp._cdta.workAreaEndDividend).toBe(0xffffffff);
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
    const [_, comp] = _newComp(rate);
    expect(approx(comp.duration, duration, { abs: 1e-9 })).toBe(true);
  });

  test("test_rate_change_keeps_keyframe_seconds", () => {
    const tmpPath = makeTmpPath();
    const [project, comp] = _newComp();
    const layer = comp.addSolid([1.0, 0.0, 0.0], "s", 64, 64);
    const opacity = layer.property("ADBE Transform Group").property("ADBE Opacity");
    opacity.setValueAtTime(1.0, 0.0);
    opacity.setValueAtTime(5.5, 100.0);
    comp.frameRate = 7.3;
    const again = at(_reparse(project, tmpPath).compositions, 0);
    const times = at(again.layers, 0)
      .property("ADBE Transform Group")
      .property("ADBE Opacity")
      .keyframes.map((k) => k.time);
    expect(approx(times, [1.0, 5.5], { abs: 1e-9 })).toBe(true);
    expect(approx(again.duration, 10.0)).toBe(true);
  });
});

describe("TestRateRoundingSaves", () => {
  test("test_comp_rate", () => {
    const tmpPath = makeTmpPath();
    const [project, comp] = _newComp();
    comp.frameRate = 23.99999999;
    expect(at(_reparse(project, tmpPath).compositions, 0).frameRate).toBe(24.0);
  });

  test("test_use_this_frame_rate", () => {
    const tmpPath = makeTmpPath();
    const [project, comp] = _newComp();
    asInstance(project.renderQueue, RenderQueue).add(comp).settings.set("Use this frame rate", 29.9999999);
    const rqi = at(asInstance(_reparse(project, tmpPath).renderQueue, RenderQueue).items, 0);
    expect(rqi.settings.get("Use this frame rate")).toBe(30.0);
  });
});

describe("TestNewItemOutputPath", () => {
  test("test_file_template_on_added_item", () => {
    const tmpPath = makeTmpPath();
    // A Windows path: on a macOS project (the default off Windows) it
    // would be stored as `/out/...`.
    const [project, comp] = _newComp(undefined, undefined, "windows");
    const rqi = asInstance(project.renderQueue, RenderQueue).add(comp);
    expect(rqi.status).toBe(RQItemStatus.NEEDS_OUTPUT);
    const template = "C:\\out\\[compName]_[#####].[fileExtension]";
    at(rqi.outputModules, 0).fileTemplate = template;
    const again = at(asInstance(_reparse(project, tmpPath).renderQueue, RenderQueue).items, 0);
    for (const item of [rqi, again]) {
      expect(at(item.outputModules, 0).fileTemplate).toBe(template);
      expect(at(item.outputModules, 0).file).toBe("C:\\out\\c_[#####].tif");
      expect(item.status).toBe(RQItemStatus.QUEUED);
      expect(pyBool(item._ldat.renderChecked)).toBe(true);
      // AE ignores an output path record without this bit.
      expect(pyBool(at(item.outputModules, 0)._omLdat.hasOutputFile)).toBe(true);
    }
  });
});

describe("TestTimeSpanWrites", () => {
  test.each([Infinity, NaN, 1e300, 2.0 ** 31])("test_rejected_duration_mutates_nothing[%#]", (bad: number) => {
    const project = parseProjectFresh(SAMPLES.div("models", "renderqueue", "skip_frames.aep"));
    const rqi = at(asInstance(project.renderQueue, RenderQueue).items, 0);
    const before = projectBytes(project);
    raises(ValueError, () => {
      rqi.timeSpanDuration = bad;
    });
    expect(pyEq(projectBytes(project), before)).toBe(true);
  });

  test("test_string_rejected", () => {
    const [project, comp] = _newComp();
    const rqi = asInstance(project.renderQueue, RenderQueue).add(comp);
    raises(TypeError_, () => {
      // @ts-expect-error deliberately mistyped: the setter must reject a str
      rqi.timeSpanStart = "1";
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
  ])("test_start_keeps_end_then_duration[%#]", (workArea: [number, number] | null, steps: [string, number][], expected: [number, number]) => {
    // AE 2026: the first start write from the work area / comp keeps the
    // end, a start write on a CUSTOM span keeps the duration.
    const [project, comp] = _newComp();
    if (workArea != null) {
      [comp.workAreaStart, comp.workAreaDuration] = workArea;
    }
    const rqi = asInstance(project.renderQueue, RenderQueue).add(comp);
    for (const [field, value] of steps) {
      setattr(rqi, field === "start" ? "timeSpanStart" : "timeSpanDuration", value);
    }
    expect(rqi.settings.get("Time Span")).toBe(TimeSpanSource.CUSTOM);
    expect(approx([rqi.timeSpanStart, rqi.timeSpanDuration], expected)).toBe(true);
  });
});

describe("TestBounds", () => {
  test("test_comp_frame_rate_up_to_999", () => {
    const [project, comp] = _newComp();
    comp.frameRate = 999;
    expect(comp.frameRate).toBe(999);
    expect(project.rootFolder.addComp("x", 64, 64, 1.0, 10.0, 120).frameRate).toBe(120);
    raises(ValueError, () => {
      comp.frameRate = 999.5;
    });
  });

  test.each([
    [24, -259200, 2072160],
    [29.97, -323676, 2587609],
    [23.976, -258940, 2070087],
  ])("test_display_start_bounds[%#]", (rate: number, lowest: number, highest: number) => {
    // AE 2026 bisected: frames from -10800 s to 86340 s; displayStartTime
    // itself goes to 86400 s.
    const [_, comp] = _newComp(rate);
    comp.displayStartTime = 86400;
    comp.displayStartFrame = lowest;
    comp.displayStartFrame = highest;
    expect(comp.displayStartFrame).toBe(highest);
    raises(ValueError, () => {
      comp.displayStartFrame = highest + 1;
    });
    raises(ValueError, () => {
      comp.displayStartFrame = lowest - 1;
    });
  });
});

describe("TestNullNaming", () => {
  test("test_numbered_across_the_project", () => {
    // AE 2026: nulls take the next "Null N" over every project item
    // (solids, comps, folders), whatever comp they are added to.
    const project = py_aep.newProject().project;
    const a = project.rootFolder.addComp("A", 64, 64, 1.0, 10.0, 24);
    const b = project.rootFolder.addComp("B", 64, 64, 1.0, 10.0, 24);
    expect(pyEq([a.addNull().name, b.addNull().name], ["Null 1", "Null 2"])).toBe(true);
    project.rootFolder.addFolder("Null 20");
    expect(a.addNull().name).toBe("Null 21");
  });
});

describe("TestRenderQueueItemIds", () => {
  test("test_added_and_duplicated_items_get_new_ids", () => {
    const tmpPath = makeTmpPath();
    const [project, comp] = _newComp();
    const rq = asInstance(project.renderQueue, RenderQueue);
    const first = rq.add(comp);
    const second = rq.add(comp);
    const dup = first.duplicate();
    expect(pyEq([first._ldat.itemId, second._ldat.itemId, dup._ldat.itemId], [2, 3, 4])).toBe(true);
    expect(
      pyEq(
        sorted(asInstance(_reparse(project, tmpPath).renderQueue, RenderQueue).items.map((i) => i._ldat.itemId)),
        [2, 3, 4],
      ),
    ).toBe(true);
  });

  test("test_next_id_follows_the_highest", () => {
    const project = parseProjectFresh(SAMPLES.div("models", "renderqueue", "2_rqitems.aep"));
    const rq = asInstance(project.renderQueue, RenderQueue);
    at(rq.items, 0)._ldat.itemId = 9;
    at(rq.items, 1)._ldat.itemId = 3;
    expect(rq.add(at(project.compositions, 0))._ldat.itemId).toBe(10);
    expect(at(rq.items, 0).duplicate()._ldat.itemId).toBe(11);
  });
});

describe("TestSettingsWritten", () => {
  test("test_set_by_settings_writes_only", () => {
    const [project, comp] = _newComp();
    const rq = asInstance(project.renderQueue, RenderQueue);
    const item = rq.add(comp);
    item.skipFrames = 1;
    item.timeSpanStart = 1;
    expect(item._ldat.settingsWritten).toBe(0);
    item.settings.set("Quality", item.settings.get("Quality"));
    expect(item._ldat.settingsWritten).toBe(1);
  });
});

describe("TestDuplicateTime", () => {
  test("test_duplicate_starts_at_time_zero", () => {
    const [_, comp] = _newComp();
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
    const [_, comp] = _newComp(rate);
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
    const tmpPath = makeTmpPath();
    // AE 2026 imports these as 3x100, 1x1 and 2x5 comps (1 frame, 30 fps,
    // one shape layer), although its addComp refuses under 4 px.
    const svg = tmpPath.div("tiny.svg");
    svg.writeText(`<svg ${_SVG_NS} ${attrs}><rect width='1' height='1'/></svg>`);
    const project = py_aep.newProject().project;
    const opts = new py_aep.ImportOptions(svg);
    opts.importAs = py_aep.ImportAsType.COMP_CROPPED_LAYERS;
    const comp = project.importFile(opts);
    const again = _reparse(project, tmpPath).compositions.find((c) => c.name === "tiny.svg");
    if (again == null) throw new StopIteration();
    for (const c of [asInstance(comp, CompItem), again]) {
      expect(pyEq([c.width, c.height], size)).toBe(true);
      expect(len(c.layers)).toBe(1);
      expect(c.frameRate).toBe(30.0);
    }
  });

  test("test_add_comp_keeps_its_floor", () => {
    // AE 2026 addComp: "Value 3 out of range 4 to 30000".
    const project = py_aep.newProject().project;
    raises(
      ValueError,
      () => {
        project.rootFolder.addComp("x", 3, 100, 1.0, 1.0, 30.0);
      },
      "must be >= 4",
    );
  });
});

const _KEY_TIMES = [4.0, 2.0, 0.5, 1.3, 7.25];

/** A solid set up like the AE probe: stretch, then start, then keys. */
function _stretchedLayer(comp: CompItem, stretch: number, start: number, times: number[] = _KEY_TIMES): AVLayer {
  const layer = comp.addSolid([0.5, 0.5, 0.5], "L", 10, 10, 1.0, 10.0);
  layer.stretch = stretch;
  layer.startTime = start;
  for (const [i, t] of times.entries()) {
    layer.transform.property("ADBE Opacity").setValueAtTime(t, 10.0 * (i + 1));
  }
  return layer;
}

function _ticks(layer: Layer): number[] {
  return sorted(layer.transform.property("ADBE Opacity").keyframes.map((kf) => kf.timeUnits));
}

function _startRatio(layer: Layer): [number, number] {
  return [layer._ldta.startTimeDividend, layer._ldta.startTimeDivisor];
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
    (rate: number, startRatio: [number, number], ticks: number[], times: number[]) => {
      const tmpPath = makeTmpPath();
      const [project, comp] = _newComp(rate);
      const layer = _stretchedLayer(comp, -150.0, 1.3);
      const again = at(at(_reparse(project, tmpPath).compositions, 0).layers, 0);
      for (const lyr of [layer, again]) {
        expect(pyEq(_startRatio(lyr), startRatio)).toBe(true);
        expect(pyEq(_ticks(lyr), ticks)).toBe(true);
        const got = lyr.transform.opacity.keyframes.map((kf: Keyframe) => kf.time);
        expect(approx(got, times, { abs: 1e-12 })).toBe(true);
      }
    },
  );

  test.each([
    [500.0, 4.0],
    [9900.0, 4.00015625],
    [-500.0, 3.99998263888889],
  ])("test_timebase_is_capped[%#]", (stretch: number, keyTime: number) => {
    const tmpPath = makeTmpPath();
    // 24 fps x 5 would be 122880: AE counts these layers' ticks against
    // 115200, and reads a key it set at 4.0 back at these times.
    const [project, comp] = _newComp(24.0);
    const layer = _stretchedLayer(comp, stretch, 1.3, [4.0]);
    const again = at(at(_reparse(project, tmpPath).compositions, 0).layers, 0);
    for (const lyr of [layer, again]) {
      const prop = lyr.transform.opacity;
      expect(prop._tdb4._timeBase).toBe(115200);
      expect(pyEq(_startRatio(lyr), [149760, 115200])).toBe(true);
      expect(approx(at(prop.keyframes, 0).time, keyTime, { abs: 1e-12 })).toBe(true);
    }
  });

  test("test_key_lands_where_ae_evaluates_the_time", () => {
    // 77.777 fps, 100 %: 0.5 s is 38888.5 comp ticks; AE snaps it up
    // and keys tick -62221 (the nearest tick to the exact layer time is
    // a tie, which round-half-even sent to -62222).
    const [_project, comp] = _newComp(77.777);
    expect(pyEq(_ticks(_stretchedLayer(comp, 100.0, 1.3)), [-62221, 0, 54444, 209998, 462773])).toBe(true);
    // -50 %: AE keyed 124416 at 0.5 s, one tick off the nearest.
    expect(pyEq(_ticks(_stretchedLayer(comp, -50.0, 1.3)), [-925572, -420022, -108914, -26, 124416])).toBe(true);
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
    const tmpPath = makeTmpPath();
    const [project, comp] = _newComp(rate);
    const layer = comp.addSolid([0.5, 0.5, 0.5], "L", 10, 10, 1.0, 10.0);
    layer.stretch = stretch;
    layer.startTime = start;
    const again = at(at(_reparse(project, tmpPath).compositions, 0).layers, 0);
    for (const lyr of [layer, again]) {
      expect(pyEq(_startRatio(lyr), ratio)).toBe(true);
      expect(lyr.startTime).toBe(ratio[0] / ratio[1]);
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
    const [_project, comp] = _newComp(32.0);
    const layer = comp.addSolid([0.5, 0.5, 0.5], "L", 10, 10, 1.0, 10.0);
    layer.stretch = stretch;
    const base = layer.transform.property("ADBE Opacity")._layerTimebase;
    layer.startTime = ticks / base;
    expect(layer._ldta.startTimeDividend).toBe(expected);
  });

  test("test_stretch_change_keeps_the_stored_start", () => {
    const [_project, comp] = _newComp(24.0);
    const layer = comp.addSolid([0.5, 0.5, 0.5], "L", 10, 10, 1.0, 10.0);
    layer.startTime = 1.3;
    layer.stretch = 150.0;
    expect(pyEq(_startRatio(layer), [31949, 24576])).toBe(true);
    layer.stretch = 100.0;
    layer.startTime = 1.3;
    layer.stretch = -150.0;
    expect(pyEq(_startRatio(layer), [31949, 24576])).toBe(true);
  });

  test("test_start_past_the_field_is_rejected", () => {
    // At 115200 ticks a second the signed 32-bit start holds 18641 s.
    const [_project, comp] = _newComp(24.0);
    const layer = comp.addSolid([0.5, 0.5, 0.5], "L", 10, 10, 1.0, 10.0);
    layer.stretch = 500.0;
    layer.startTime = 18641.0;
    const before = _startRatio(layer);
    raises(
      ValueError,
      () => {
        layer.startTime = 18642.0;
      },
      "must be <=",
    );
    raises(
      ValueError,
      () => {
        layer.startTime = -18642.0;
      },
      "must be >=",
    );
    expect(pyEq(_startRatio(layer), before)).toBe(true);
  });
});

describe("TestRetimeRoundsHalfUp", () => {
  test("test_stretch_change", () => {
    // Keys at ticks 15, -13, -15, 13 (24 fps, 100 %); AE 2026 at 150 %.
    const [_project, comp] = _newComp(24.0);
    const layer = _stretchedLayer(
      comp,
      100.0,
      0.0,
      [15, -13, -15, 13].map((u) => u / 24576),
    );
    layer.stretch = 150.0;
    expect(pyEq(_ticks(layer), [-22, -19, 20, 23])).toBe(true);
  });

  test("test_frame_rate_change", () => {
    // 24 -> 25 fps scales ticks by 25 / 24, ties up; a 500 % layer sits
    // at the 115200 cap at both rates, so its ticks stay (AE 2026).
    const [_project, comp] = _newComp(24.0);
    const times = [12, 60, -36, -84, 24576].map((u) => u / 24576);
    const plain = _stretchedLayer(comp, 100.0, 0.0, times);
    const capped = _stretchedLayer(comp, 100.0, 0.0, times);
    capped.stretch = 500.0;
    expect(pyEq(_ticks(capped), [-394, -169, 56, 281, 115200])).toBe(true);
    comp.frameRate = 25.0;
    expect(pyEq(_ticks(plain), [-87, -37, 13, 63, 25600])).toBe(true);
    expect(pyEq(_ticks(capped), [-394, -169, 56, 281, 115200])).toBe(true);
  });
});

function _stretchRatio(layer: Layer): [number, number] {
  return [layer._ldta.stretchDividend, layer._ldta.stretchDivisor];
}

describe("TestStretchStorage", () => {
  test("test_float32_ratio_survives_a_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const [project, comp] = _newComp(24.0);
    const layer = comp.addSolid([0.5, 0.5, 0.5], "L", 10, 10, 1.0, 10.0);
    layer.stretch = 133.33;
    const again = at(at(_reparse(project, tmpPath).compositions, 0).layers, 0);
    for (const lyr of [layer, again]) {
      expect(pyEq(_stretchRatio(lyr), [11184531, 8388608])).toBe(true);
      expect(lyr.stretch).toBe((11184531 * 100) / 8388608);
    }
  });

  test("test_near_tie_key_matches_ae", () => {
    // 133.33 % at 77.777 fps: with the stretch stored as 13333 / 10000 the
    // key set at 4.0 s landed one tick short of AE's 209996.
    const [_project, comp] = _newComp(77.777);
    const layer = _stretchedLayer(comp, 133.33, 1.3);
    expect(pyEq(_startRatio(layer), [134809, 103699])).toBe(true);
    expect(pyEq(_ticks(layer), [-62221, 0, 54443, 209996, 462768])).toBe(true);
    const got = sorted(layer.transform.property("ADBE Opacity").keyframes.map((kf: Keyframe) => kf.time));
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
    const [_project, comp] = _newComp(24.0);
    const layer = comp.addSolid([0.5, 0.5, 0.5], "L", 10, 10, 1.0, 10.0);
    layer.stretch = percent;
    expect(pyEq(_stretchRatio(layer), ratio)).toBe(true);
    expect(Math.abs(layer.stretch)).toBe(0.99945068359375);
  });

  test("test_bound_is_the_field_width", () => {
    const tmpPath = makeTmpPath();
    // AE refuses 10000 % from a script but opens a file holding 1e6 %.
    const [project, comp] = _newComp(24.0);
    const layer = comp.addSolid([0.5, 0.5, 0.5], "L", 10, 10, 1.0, 10.0);
    layer.stretch = 1e6;
    expect(pyEq(_stretchRatio(layer), [10000, 1])).toBe(true);
    layer.stretch = 2147483520 * 100.0;
    expect(pyEq(_stretchRatio(layer), [2147483520, 1])).toBe(true);
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
    expect(pyEq(_stretchRatio(layer), [2147483520, 1])).toBe(true);
    _reparse(project, tmpPath);
  });
});

describe("TestFrameGridPastTheCap", () => {
  // AE 2026 addComp(..., 3.3 s, rate), then duration = 1.0001,
  // time = 0.5041, workAreaStart = 0.2004, workAreaDuration = 0.5,
  // displayStartTime = 0.1234, and keys set at 0.5041 and 0.25 s.
  test.each<[number, [number, number], Map<string, number | number[]>]>([
    [
      120.001,
      [60000, 500],
      new Map<string, number | number[]>([
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
      new Map<string, number | number[]>([
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
      new Map<string, number | number[]>([
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
      new Map<string, number | number[]>([
        ["dur0", 3.2997421400772],
        ["time", 0.50444448003588],
        ["was", 0.20058619088041],
        ["wad", 0.50047247625607],
        ["dsf", 125],
        ["keys", [0.24999599596393, 0.50409212486186]],
      ]),
    ],
  ])("test_comp_times_match_ae[%#]", (rate: number, grid: [number, number], expected: Map<string, number | number[]>) => {
    const tmpPath = makeTmpPath();
    const [project, comp] = _newComp(rate, 3.3);
    const cdta = comp._cdta;
    expect(pyEq([cdta.internalTimebase, round(cdta.timeScale * 256)], grid)).toBe(true);
    const got = new Map<string, number | number[]>([["dur0", comp.duration]]);
    comp.duration = 1.0001;
    got.set("dur", comp.duration);
    comp.time = 0.5041;
    got.set("time", comp.time);
    comp.workAreaStart = 0.2004;
    got.set("was", comp.workAreaStart);
    comp.workAreaDuration = 0.5;
    got.set("wad", comp.workAreaDuration);
    comp.displayStartTime = 0.1234;
    got.set("dsf", comp.displayStartFrame);
    const layer = comp.addSolid([0.5, 0.5, 0.5], "k", 10, 10, 1.0, 1.0);
    layer.transform.property("ADBE Opacity").setValueAtTime(0.5041, 10.0);
    layer.transform.property("ADBE Opacity").setValueAtTime(0.25, 20.0);
    got.set(
      "keys",
      layer.transform.property("ADBE Opacity").keyframes.map((kf) => kf.time),
    );
    for (const [key, value] of expected.entries()) {
      // The Python assertion message names the key; bun's expect takes no message.
      expect(approx(getitem(got, key), value, { abs: 1e-11 })).toBe(true);
    }
    const again = at(_reparse(project, tmpPath).compositions, 0);
    expect(again.time).toBe(comp.time);
    expect(again.workAreaStart).toBe(comp.workAreaStart);
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
    (stretch: number, start: number, inPoint: number, outPoint: number) => {
      const tmpPath = makeTmpPath();
      const [project, comp] = _newComp(24.0, 30.0);
      const layer = comp.addNull(10.0);
      layer.stretch = stretch;
      layer.startTime = start;
      const again = at(at(_reparse(project, tmpPath).compositions, 0).layers, 0);
      for (const lyr of [layer, again]) {
        expect(approx(lyr.inPoint, inPoint, { abs: 1e-11 })).toBe(true);
        expect(approx(lyr.outPoint, outPoint, { abs: 1e-11 })).toBe(true);
      }
    },
  );

  test("test_writes_read_back", () => {
    // AE 2026, -150 % from 1.3 s: inPoint = 1 then outPoint = -3 read
    // back as written.
    const [_project, comp] = _newComp(24.0, 30.0);
    const layer = comp.addNull(10.0);
    layer.stretch = -150.0;
    layer.startTime = 1.3;
    layer.inPoint = 1.0;
    layer.outPoint = -3.0;
    expect(approx(layer.inPoint, 1.0, { abs: 1e-9 })).toBe(true);
    expect(approx(layer.outPoint, -3.0, { abs: 1e-9 })).toBe(true);
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
    const [_project, comp] = _newComp(24.0, 30.0);
    const layer = comp.addSolid([0.5, 0.5, 0.5], "L", 10, 10, 1.0, 30.0);
    layer.stretch = stretch;
    setattr(layer, which + "Point", value);
    expect(approx(getattr(layer, which + "Point"), expected, { abs: 1e-12 })).toBe(true);
  });

  test("test_ae_sample_matches_extendscript", () => {
    // layer_timing.json: the -100 % layer reads in -0.000333333333,
    // out -60.000333333333.
    const project = py_aep.parse(SAMPLES.div("models", "layer", "layer_timing.aep")).project;
    const reversedLayers = project.compositions
      .flatMap((c) => c.layers)
      .filter((lyr) => lyr.stretch < 0);
    expect(pyBool(reversedLayers)).toBe(true);
    for (const lyr of reversedLayers) {
      expect(approx(lyr.inPoint, -1 / 3000, { abs: 1e-12 })).toBe(true);
      expect(approx(lyr.outPoint, -60 - 1 / 3000, { abs: 1e-12 })).toBe(true);
    }
  });
});
