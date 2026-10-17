/**
 * Each test pins a validation that prevents writing a .aep After Effects
 * cannot open.
 */

import { describe, expect, test } from "bun:test";
import { NotImplementedError, Path, py_bool, py_eq, RuntimeError, ValueError, zip } from "../../src/pyrt/index.ts";
import { approx, make_tmp_path, raises } from "../../src/pyrt/pytest.ts";
import { parse as parse_aep, Property } from "../../src/py_aep/index.ts";
import * as project_mod from "../../src/py_aep/models/project.ts";
import { CompItem } from "../../src/py_aep/models/items/composition.ts";
import "../../src/py_aep/binary/_register.ts";
import { get_comp } from "../conftest.ts";

const SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models");

// `monkeypatch.setattr` on a mutable holder (project_mod.module_globals); returns the undo.
const monkeypatch_setattr = (obj: any, name: string, value: unknown): (() => void) => {
  const old = obj[name];
  obj[name] = value;
  return () => {
    obj[name] = old;
  };
};

/** Test class TestValueSetterOnKeyframedProperty. */
describe("TestValueSetterOnKeyframedProperty", () => {
  test("test_set_value_raises_with_keyframes", () => {
    const app = parse_aep(SAMPLES_DIR.div("property", "keyframe_1D.aep"));
    const comp = app.project.compositions[0];
    const prop = comp.layers
      .flatMap((lyr) => [...lyr.transform].filter((p) => p instanceof Property))
      .find((p) => py_bool(p.keyframes));
    if (prop == null) throw new Error("no keyframed transform property");
    raises(
      ValueError,
      () => {
        prop.value = 12.0;
      },
      "keyframes",
    );
  });

  test("test_set_value_on_static_property_still_works", () => {
    const app = parse_aep(SAMPLES_DIR.div("property", "all_animated.aep"));
    const comp = app.project.compositions[0];
    const rot = comp.av_layers[0].transform.property("ADBE Rotate Z");
    expect(py_bool(rot.keyframes)).toBe(false);
    rot.value = 45.0;
    expect(rot.value).toBe(45.0);
  });
});

/** Test class TestSetAlternateSource. */
describe("TestSetAlternateSource", () => {
  const EG = SAMPLES_DIR.div("essential_graphics", "media_replacement.aep");

  const _override_leaf = (app: any): [any, any] => {
    const host = app.project.compositions.find((c: any) => c.name === "image_with_alpha 2")!;
    const layer = host.layers.find((la: any) => py_bool(la.essential_property_uuids))!;
    const overrides = layer.properties.find((p: any) => p.match_name === "ADBE Layer Overrides")!;
    return [layer, overrides.properties[0]];
  };

  test("test_set_alternate_source_roundtrips", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(EG);
    const [, alt] = _override_leaf(app);
    const master = app.project.compositions.find((c) => c.name === "image_with_alpha")!;
    alt.alternate_source = master;
    const out = tmp_path.div("media.aep");
    app.project.save(out);
    const app2 = parse_aep(out);
    const [, alt2] = _override_leaf(app2);
    expect(alt2.alternate_source != null).toBe(true);
    expect(alt2.alternate_source!.id).toBe(master.id);
  });

  test("test_set_alternate_source_footage_autowraps", () => {
    // A FootageItem argument is wrapped in a host-sized comp (named
    // `{leaf name}_{unique footage basename}`) inside a root-level
    // `Media Replacement Comps` folder, matching AE's UI. Verified in AE
    // 2026: the wrapper's cdta clones the host comp and AE opens+resaves it.
    const tmp_path = make_tmp_path();
    const app = parse_aep(EG);
    const [, alt] = _override_leaf(app);
    const host = app.project.compositions.find((c) => c.name === "image_with_alpha 2")!;
    const gif = [...app.project.items.values()].find((it) => it.name === "sequence_[001-003].gif")!;
    const before = new Set(app.project.items.keys());
    alt.alternate_source = gif;
    const created = [...new Set(app.project.items.keys())].filter((k) => !before.has(k));
    expect(created.length).toBe(1); // only the wrapper comp

    const out = tmp_path.div("media.aep");
    app.project.save(out);
    const app2 = parse_aep(out);
    const [, alt2] = _override_leaf(app2);
    const wrapper = alt2.alternate_source;
    expect(wrapper instanceof CompItem).toBe(true);
    expect(wrapper.name).toBe("image_with_alpha.png_sequence");
    expect(wrapper.parent_folder.name).toBe("Media Replacement Comps");
    expect(py_eq([wrapper.width, wrapper.height], [host.width, host.height])).toBe(true);
    expect(wrapper.duration).toBe(host.duration);
    // cdta cloned from the host comp (not add_comp's fresh skeleton).
    expect(wrapper._cdta.shutter_phase).toBe(host._cdta.shutter_phase);
    expect(wrapper._cdta.time_divisor).toBe(host._cdta.time_divisor);
    expect(wrapper.num_layers).toBe(1);
    expect(wrapper.layers[0].source.name).toBe("sequence_[001-003].gif");
  });

  test("test_set_alternate_source_reuses_wrapper_folder", () => {
    // The `Media Replacement Comps` folder is reused, not duplicated.
    const app = parse_aep(EG);
    const [, alt] = _override_leaf(app);
    const gif = [...app.project.items.values()].find((it) => it.name === "sequence_[001-003].gif")!;
    const folders_before = [...app.project.items.values()].filter(
      (it) => it.constructor.name === "FolderItem" && it.name === "Media Replacement Comps",
    );
    alt.alternate_source = gif;
    const folders_after = [...app.project.items.values()].filter(
      (it) => it.constructor.name === "FolderItem" && it.name === "Media Replacement Comps",
    );
    expect(folders_before.length).toBe(1);
    expect(folders_after.length).toBe(1); // reused, not a second folder
  });

  test("test_set_alternate_source_on_non_slot_raises", () => {
    const app = parse_aep(EG);
    const [layer] = _override_leaf(app);
    const master = app.project.compositions.find((c) => c.name === "image_with_alpha")!;
    const pos = layer.transform.property("ADBE Position");
    raises(
      ValueError,
      () => {
        pos.alternate_source = master;
      },
      "media replacement",
    );
  });

  test("test_incompatible_source_raises", () => {
    // AE gates both sides: "The Property object and the input parameters
    // for the AVItem that is being called needs to be Media Replacement
    // compatible for the action to go through." A solid is in the project
    // but is_media_replacement_compatible is False.
    const app = parse_aep(EG);
    const [, alt] = _override_leaf(app);
    const host = app.project.compositions.find((c) => c.name === "image_with_alpha 2")!;
    const solid = host.add_solid([1.0, 0.0, 0.0], "Guard Solid").source;
    if (solid == null) throw new Error("solid layer has no source");
    expect(app.project.items.has(solid.id)).toBe(true);
    expect(solid.is_media_replacement_compatible).toBe(false);
    raises(
      ValueError,
      () => {
        alt.alternate_source = solid;
      },
      "is_media_replacement_compatible",
    );
  });

  test("test_incompatible_source_leaves_slot_untouched", () => {
    // The check must precede _build_replacement_wrapper, or a rejected
    // assignment would still leak a wrapper comp into the project.
    const app = parse_aep(EG);
    const [, alt] = _override_leaf(app);
    const host = app.project.compositions.find((c) => c.name === "image_with_alpha 2")!;
    const solid = host.add_solid([0.0, 1.0, 0.0], "Guard Solid 2").source;
    // Snapshot after add_solid (which legitimately adds the solid and
    // AE's `Solids` folder) so this measures only the failed assignment.
    const before_blsi = alt._blsi.value;
    const before_items = new Set(app.project.items.keys());
    raises(ValueError, () => {
      alt.alternate_source = solid;
    });
    expect(py_eq(alt._blsi.value, before_blsi)).toBe(true);
    expect(py_eq(new Set(app.project.items.keys()), before_items)).toBe(true); // no wrapper leaked
  });
});

/** Test class TestParentValidation. */
describe("TestParentValidation", () => {
  const _two_layers = () => {
    const app = parse_aep(SAMPLES_DIR.div("property", "all_animated.aep"));
    const comp = app.project.compositions[0];
    return [app, comp.layers[0], comp.layers[1]] as const;
  };

  test("test_self_parent_raises", () => {
    const [, a] = _two_layers();
    raises(
      ValueError,
      () => {
        a.parent = a;
      },
      "itself",
    );
  });

  test("test_self_parent_with_jump_raises", () => {
    const [, a] = _two_layers();
    raises(ValueError, () => a.set_parent_with_jump(a), "itself");
  });

  test("test_cycle_raises", () => {
    const [, a, b] = _two_layers();
    a.set_parent_with_jump(b);
    raises(ValueError, () => b.set_parent_with_jump(a), "descendants");
  });

  test("test_cycle_via_setter_raises", () => {
    const [, a, b] = _two_layers();
    a.set_parent_with_jump(b);
    raises(
      ValueError,
      () => {
        b.parent = a;
      },
      "descendants",
    );
  });

  test("test_cross_comp_parent_raises", () => {
    const app = parse_aep(SAMPLES_DIR.div("layer", "type.aep"));
    const src = get_comp(app.project, "type_null").layers[0];
    const other = get_comp(app.project, "type_camera").layers[0];
    raises(ValueError, () => src.set_parent_with_jump(other), "same composition");
    raises(
      ValueError,
      () => {
        src.parent = other;
      },
      "same composition",
    );
  });

  test("test_parenting_animated_layer_matches_extendscript", () => {
    /**
     * ExtendScript remaps every position keyframe into the new
     * parent's space and leaves keyframed anchor / scale / rotation
     * untouched. Expected values measured live in AE 2026 (gt_probe1
     * and gt_probe_anchor).
     */
    const app = parse_aep(SAMPLES_DIR.div("property", "all_animated.aep"));
    const matches = app.project.compositions.flatMap((c) =>
      c.layers.filter((la) => la.name === "XF").map((la) => [c, la] as const),
    );
    // Python's loop keeps the last match.
    const [comp, lyr] = matches.length ? matches[matches.length - 1] : [null, null];
    expect(lyr != null).toBe(true);
    const anchor = lyr!.transform.property("ADBE Anchor Point");
    anchor.set_value_at_time(0.0, [10.0, 20.0, 0.0]);
    anchor.set_value_at_time(1.0, [70.0, 80.0, 0.0]);
    const null_ = comp!.add_null();
    const null_pos = null_.transform.property("ADBE Position");
    null_pos.value = [10.0, 20.0, 0.0];
    const null_rot = null_.transform.property("ADBE Rotate Z");
    null_rot.value = 30.0;

    lyr!.parent = null_;

    // Anchor keyframes are in layer-source space; AE never touches them.
    expect(py_eq(anchor.keyframes.map((k) => k.value), [
      [10.0, 20.0, 0.0],
      [70.0, 80.0, 0.0],
    ])).toBe(true);

    const pos = lyr!.transform.property("ADBE Position");
    const expected = [
      [117.942286340599, 24.2820323027551, 0.0],
      [564.352447854375, -2.51288694035714, 50.0],
    ];
    for (const [kf, exp] of zip(pos.keyframes as any[], expected)) {
      expect(approx(kf.value, exp, { abs: 1e-6 })).toBe(true);
    }
    const scale = lyr!.transform.property("ADBE Scale");
    const rot = lyr!.transform.property("ADBE Rotate Z");
    expect(py_eq(scale.keyframes.map((k) => k.value), [
      [50.0, 50.0, 100.0],
      [150.0, 150.0, 100.0],
    ])).toBe(true);
    expect(py_eq(rot.keyframes.map((k) => k.value), [0.0, 90.0])).toBe(true);
  });
});

/**
 * AE 2026 stores layer / solid names as UTF-8 in the fixed-width
 * legacy fields (measured via gt_unicode_names.aep), so any unicode
 * name round-trips.
 */
describe("TestUnicodeNames", () => {
  test("test_layer_rename_unicode_roundtrips", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("property", "all_animated.aep"));
    const lyr = app.project.compositions[0].layers[0];
    lyr.name = "测试✨layer";
    const out = tmp_path.div("u.aep");
    app.project.save(out);
    const app2 = parse_aep(out);
    expect(app2.project.compositions[0].layers[0].name).toBe("测试✨layer");
  });

  test("test_add_text_cjk_roundtrips", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("layer", "type.aep"));
    const comp = get_comp(app.project, "type_text");
    comp.add_text("你好");
    const out = tmp_path.div("t.aep");
    app.project.save(out);
    const app2 = parse_aep(out);
    const comp2 = get_comp(app2.project, "type_text");
    expect(comp2.layers[0].name).toBe("你好");
  });

  test("test_add_solid_emoji_name_roundtrips", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("layer", "type.aep"));
    const comp = get_comp(app.project, "type_null");
    comp.add_solid([1.0, 0.0, 0.0], "solid \u{1f600}");
    const out = tmp_path.div("s.aep");
    app.project.save(out);
    const app2 = parse_aep(out);
    const comp2 = get_comp(app2.project, "type_null");
    expect(comp2.layers[0].name).toBe("solid \u{1f600}");
  });

  test("test_text_document_content_supports_unicode", () => {
    /**
     * Text CONTENT goes through the COS layer which handles any
     * unicode; only legacy name fields are restricted.
     */
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("layer", "type.aep"));
    const comp = get_comp(app.project, "type_text");
    const text = comp.text_layers[0].text;
    if (text == null) throw new Error("text layer has no Text group");
    const prop = text.property("ADBE Text Document");
    const doc = prop.value;
    doc.text = "你好 \u{1f600}";
    prop.value = doc;
    const out = tmp_path.div("cjk_text.aep");
    app.project.save(out);
    const app2 = parse_aep(out);
    const comp2 = get_comp(app2.project, "type_text");
    const text2 = comp2.text_layers[0].text;
    if (text2 == null) throw new Error("text layer has no Text group");
    const prop2 = text2.property("ADBE Text Document");
    expect(prop2.value.text).toBe("你好 \u{1f600}");
  });
});

/**
 * Keyframe times are a signed 32-bit count of internal-timebase
 * units (measured via gt_long_keys.aep), so hour-range times work.
 */
describe("TestLongKeyframeTimes", () => {
  test("test_far_keyframe_roundtrips", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("property", "keyframe_1D.aep"));
    const comp = app.project.compositions[0];
    const prop = comp.layers
      .flatMap((lyr) => [...lyr.transform].filter((p) => p instanceof Property))
      .find((p) => py_bool(p.keyframes));
    if (prop == null) throw new Error("no keyframed transform property");
    prop.set_value_at_time(9999.0, prop.keyframes[0].value);
    const out = tmp_path.div("far.aep");
    app.project.save(out);
    const app2 = parse_aep(out);
    const comp2 = app2.project.compositions[0];
    const prop2 = comp2.layers
      .flatMap((lyr) => [...lyr.transform].filter((p) => p instanceof Property))
      .find((p) => py_bool(p.keyframes));
    if (prop2 == null) throw new Error("no keyframed transform property after save");
    expect(approx(prop2.keyframes.at(-1)!.time, 9999.0)).toBe(true);
  });

  test("test_nearby_keyframe_still_works", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("property", "keyframe_1D.aep"));
    const comp = app.project.compositions[0];
    const prop = comp.layers
      .flatMap((lyr) => [...lyr.transform].filter((p) => p instanceof Property))
      .find((p) => py_bool(p.keyframes));
    if (prop == null) throw new Error("no keyframed transform property");
    prop.set_value_at_time(2.0, prop.keyframes[0].value);
    app.project.save(tmp_path.div("ok.aep"));
  });
});

/**
 * v3 fuzz campaign (text-range writes). A non-finite value written to a
 * text style float serialized a bare `nan`/`inf` COS token, which is not
 * valid COS syntax: on re-parse the TextDocument came back `None` - py_aep
 * could not read its own output. Out-of-enum ints wrote a value that read
 * back as undefined. Both are now rejected at the API boundary, at the
 * range level and document-wide.
 */
describe("TestTextRangeNumericValidation", () => {
  const SAMPLE = SAMPLES_DIR.div("text", "text_ranges.aep");

  const _doc = (app: any, name = "RangesPoint"): any => {
    const comp = app.project.compositions[0];
    const layer = comp.text_layers.find((ly: any) => ly.name === name)!;
    return layer.text.source_text.value;
  };

  const bads = [NaN, Infinity];
  const char_fields = ["baseline_shift", "horizontal_scale", "vertical_scale"];
  const para_fields = ["first_line_indent", "start_indent", "end_indent", "space_before", "space_after"];
  const doc_wide_fields = ["baseline_shift", "horizontal_scale", "first_line_indent"];

  // Parametrize (field x bad), in the decorator order of the Python source.
  const char_rows = char_fields.flatMap((field) => bads.map((bad) => [field, bad] as const));
  const para_rows = para_fields.flatMap((field) => bads.map((bad) => [field, bad] as const));

  test.each(char_rows)("test_char_float_rejects_nonfinite[%#]", (field: string, bad: number) => {
    const rng = _doc(parse_aep(SAMPLE)).character_range(0, 5);
    raises(
      ValueError,
      () => {
        (rng as any)[field] = bad;
      },
      "finite",
    );
  });

  test.each(para_rows)("test_para_float_rejects_nonfinite[%#]", (field: string, bad: number) => {
    const rng = _doc(parse_aep(SAMPLE), "RangesJust").paragraph_range(0).character_range();
    raises(
      ValueError,
      () => {
        (rng as any)[field] = bad;
      },
      "finite",
    );
  });

  test.each(doc_wide_fields)("test_document_wide_float_rejects_nonfinite[%#]", (field: string) => {
    // Multi-run document: the DocumentWideCosField write path must
    // validate before touching any run.
    const doc = _doc(parse_aep(SAMPLE), "RangesTextReset");
    raises(
      ValueError,
      () => {
        (doc as any)[field] = NaN;
      },
      "finite",
    );
  });

  test("test_valid_negative_value_roundtrips", () => {
    // A finite (negative) value is still accepted and survives a disk
    // round-trip intact - the pre-fix NaN made source_text.value None.
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLE);
    _doc(app).character_range(0, 5).baseline_shift = -3.5;
    const out = tmp_path.div("bs.aep");
    app.project.save(out);
    const doc2 = _doc(parse_aep(out));
    expect(doc2 != null).toBe(true);
    expect(approx(doc2.character_range(0, 5).baseline_shift, -3.5)).toBe(true);
  });

  test("test_range_enum_rejects_out_of_range_int", () => {
    const cr = _doc(parse_aep(SAMPLE), "RangesJust").paragraph_range(0).character_range();
    raises(
      ValueError,
      () => {
        cr.justification = 999;
      },
      "not a valid",
    );
  });

  test("test_document_wide_enum_rejects_out_of_range_int", () => {
    const doc = _doc(parse_aep(SAMPLE), "RangesJust");
    raises(
      ValueError,
      () => {
        doc.justification = 999;
      },
      "not a valid",
    );
  });

  test.each([10 ** 10, 10 ** 12, -(10 ** 10)])("test_kerning_rejects_out_of_s4_range[%#]", (value: number) => {
    // AE 2026 rejects the whole text layer for kerning/tracking beyond
    // the signed-32-bit range ("Error reading the text layer"; probed
    // 2**31 OK / 10**10 fails).
    const rng = _doc(parse_aep(SAMPLE), "RangesKernLead").character_range(1, 4);
    raises(
      ValueError,
      () => {
        rng.kerning = value;
      },
      "must be",
    );
  });

  test.each([10 ** 10, 10 ** 12])("test_tracking_rejects_out_of_s4_range[%#]", (value: number) => {
    const rng = _doc(parse_aep(SAMPLE)).character_range(0, 5);
    raises(
      ValueError,
      () => {
        rng.tracking = value;
      },
      "must be",
    );
  });

  test("test_document_wide_tracking_rejects_out_of_s4_range", () => {
    const doc = _doc(parse_aep(SAMPLE), "RangesTextReset");
    raises(
      ValueError,
      () => {
        doc.tracking = 10 ** 10;
      },
      "must be",
    );
  });

  test("test_kerning_tracking_accept_int32_extremes", () => {
    // The bound stays inside AE's tolerance: int32max and a negative
    // value are accepted and survive a disk round-trip.
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLE);
    _doc(app, "RangesKernLead").character_range(1, 4).kerning = 2 ** 31 - 1;
    _doc(app).character_range(0, 5).tracking = -5000;
    const out = tmp_path.div("kt.aep");
    app.project.save(out);
    const app2 = parse_aep(out);
    expect(_doc(app2, "RangesKernLead").character_range(1, 4).kerning).toBe(2 ** 31 - 1);
    expect(_doc(app2).character_range(0, 5).tracking).toBe(-5000);
  });
});

/** Test class TestAtomicSave. */
describe("TestAtomicSave", () => {
  test("test_failed_save_leaves_no_file", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));

    const boom = (..._args: unknown[]): never => {
      throw new RuntimeError("simulated write failure");
    };

    const undo = monkeypatch_setattr(project_mod.module_globals, "write_aep", boom);
    const target = tmp_path.div("out.aep");
    try {
      raises(RuntimeError, () => app.project.save(target));
    } finally {
      undo();
    }
    expect(target.exists()).toBe(false);
    expect(tmp_path.iterdir().length).toBe(0);
  });
});
