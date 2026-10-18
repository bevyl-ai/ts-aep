/**
 * Each test pins a validation that prevents writing a .aep After Effects
 * cannot open.
 */

import { describe, expect, test } from "bun:test";
import { at, NotImplementedError, OSError, Path, pyAssert, pyBool, pyEq, RuntimeError, setattr, StopIteration, ValueError, zip } from "../../src/pyrt/index.ts";
import { approx, makeTmpPath, raises } from "../../src/pyrt/pytest.ts";
import { parse as parseAep, Property, type Application } from "../../src/py_aep/index.ts";
import * as project_mod from "../../src/py_aep/models/project.ts";
import { CompItem } from "../../src/py_aep/models/items/composition.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";
import "../../src/py_aep/binary/_register.ts";
import { getComp } from "../conftest.ts";
import { asInstance } from "../helpers.ts";
import { AVLayer } from "../../src/py_aep/models/layers/av_layer.ts";
import { FootageItem } from "../../src/py_aep/models/items/footage.ts";
import type { Layer } from "../../src/py_aep/models/layers/layer.ts";
import type { TextDocument } from "../../src/py_aep/models/text/text_document.ts";

const SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models");

// `monkeypatch.setattr` on a mutable holder (project_mod.module_globals); returns the undo.
const monkeypatchSetattr = <O extends object, K extends keyof O>(obj: O, name: K, value: O[K]): (() => void) => {
  const old = obj[name];
  obj[name] = value;
  return () => {
    obj[name] = old;
  };
};

/** Test class TestValueSetterOnKeyframedProperty. */
describe("TestValueSetterOnKeyframedProperty", () => {
  test("test_set_value_raises_with_keyframes", () => {
    const app = parseAep(SAMPLES_DIR.div("property", "keyframe_1D.aep"));
    const comp = app.project.compositions[0];
    const prop = comp.layers
      .flatMap((lyr) => [...lyr.transform].filter((p) => p instanceof Property))
      .find((p) => pyBool(p.keyframes));
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
    const app = parseAep(SAMPLES_DIR.div("property", "all_animated.aep"));
    const comp = app.project.compositions[0];
    const rot = comp.avLayers[0].transform.property("ADBE Rotate Z");
    expect(pyBool(rot.keyframes)).toBe(false);
    rot.value = 45.0;
    expect(rot.value).toBe(45.0);
  });
});

/** Test class TestSetAlternateSource. */
describe("TestSetAlternateSource", () => {
  const EG = SAMPLES_DIR.div("essential_graphics", "media_replacement.aep");

  const _overrideLeaf = (app: Application): [Layer, Property] => {
    const host = app.project.compositions.find((c) => c.name === "image_with_alpha 2");
    if (host == null) throw new StopIteration();
    const layer = host.layers.find((la) => pyBool(la.essentialPropertyUuids));
    if (layer == null) throw new StopIteration();
    const overrides = asInstance(
      layer.properties.find((p) => p.matchName === "ADBE Layer Overrides"),
      PropertyGroup,
    );
    return [layer, asInstance(overrides.properties[0], Property)];
  };

  test("test_set_alternate_source_roundtrips", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(EG);
    const [, alt] = _overrideLeaf(app);
    const master = app.project.compositions.find((c) => c.name === "image_with_alpha");
    if (master == null) throw new StopIteration();
    alt.alternateSource = master;
    const out = tmpPath.div("media.aep");
    app.project.save(out);
    const app2 = parseAep(out);
    const [, alt2] = _overrideLeaf(app2);
    expect(alt2.alternateSource != null).toBe(true);
    expect(alt2.alternateSource?.id).toBe(master.id);
  });

  test("test_set_alternate_source_footage_autowraps", () => {
    // A FootageItem argument is wrapped in a host-sized comp (named
    // `{leaf name}_{unique footage basename}`) inside a root-level
    // `Media Replacement Comps` folder, matching AE's UI. Verified in AE
    // 2026: the wrapper's cdta clones the host comp and AE opens+resaves it.
    const tmpPath = makeTmpPath();
    const app = parseAep(EG);
    const [, alt] = _overrideLeaf(app);
    const host = app.project.compositions.find((c) => c.name === "image_with_alpha 2");
    if (host == null) throw new StopIteration();
    const gif = asInstance([...app.project.items.values()].find((it) => it.name === "sequence_[001-003].gif"), FootageItem);
    const before = new Set(app.project.items.keys());
    alt.alternateSource = gif;
    const created = [...new Set(app.project.items.keys())].filter((k) => !before.has(k));
    expect(created.length).toBe(1); // only the wrapper comp

    const out = tmpPath.div("media.aep");
    app.project.save(out);
    const app2 = parseAep(out);
    const [, alt2] = _overrideLeaf(app2);
    const wrapper = alt2.alternateSource;
    pyAssert(wrapper instanceof CompItem);
    expect(wrapper.name).toBe("image_with_alpha.png_sequence");
    expect(wrapper.parentFolder?.name).toBe("Media Replacement Comps");
    expect(pyEq([wrapper.width, wrapper.height], [host.width, host.height])).toBe(true);
    expect(wrapper.duration).toBe(host.duration);
    // cdta cloned from the host comp (not add_comp's fresh skeleton).
    expect(wrapper._cdta.shutterPhase).toBe(host._cdta.shutterPhase);
    expect(wrapper._cdta.timeDivisor).toBe(host._cdta.timeDivisor);
    expect(wrapper.numLayers).toBe(1);
    expect(asInstance(wrapper.layers[0], AVLayer).source?.name).toBe("sequence_[001-003].gif");
  });

  test("test_set_alternate_source_reuses_wrapper_folder", () => {
    // The `Media Replacement Comps` folder is reused, not duplicated.
    const app = parseAep(EG);
    const [, alt] = _overrideLeaf(app);
    const gif = asInstance([...app.project.items.values()].find((it) => it.name === "sequence_[001-003].gif"), FootageItem);
    const foldersBefore = [...app.project.items.values()].filter(
      (it) => it.constructor.name === "FolderItem" && it.name === "Media Replacement Comps",
    );
    alt.alternateSource = gif;
    const foldersAfter = [...app.project.items.values()].filter(
      (it) => it.constructor.name === "FolderItem" && it.name === "Media Replacement Comps",
    );
    expect(foldersBefore.length).toBe(1);
    expect(foldersAfter.length).toBe(1); // reused, not a second folder
  });

  test("test_set_alternate_source_on_non_slot_raises", () => {
    const app = parseAep(EG);
    const [layer] = _overrideLeaf(app);
    const master = app.project.compositions.find((c) => c.name === "image_with_alpha");
    if (master == null) throw new StopIteration();
    const pos = layer.transform.property("ADBE Position");
    raises(
      ValueError,
      () => {
        pos.alternateSource = master;
      },
      "media replacement",
    );
  });

  test("test_incompatible_source_raises", () => {
    // AE gates both sides: "The Property object and the input parameters
    // for the AVItem that is being called needs to be Media Replacement
    // compatible for the action to go through." A solid is in the project
    // but isMediaReplacementCompatible is False.
    const app = parseAep(EG);
    const [, alt] = _overrideLeaf(app);
    const host = app.project.compositions.find((c) => c.name === "image_with_alpha 2");
    if (host == null) throw new StopIteration();
    const solid = host.addSolid([1.0, 0.0, 0.0], "Guard Solid").source;
    if (solid == null) throw new Error("solid layer has no source");
    expect(app.project.items.has(solid.id)).toBe(true);
    expect(solid.isMediaReplacementCompatible).toBe(false);
    raises(
      ValueError,
      () => {
        alt.alternateSource = solid;
      },
      "isMediaReplacementCompatible",
    );
  });

  test("test_incompatible_source_leaves_slot_untouched", () => {
    // The check must precede _build_replacement_wrapper, or a rejected
    // assignment would still leak a wrapper comp into the project.
    const app = parseAep(EG);
    const [, alt] = _overrideLeaf(app);
    const host = app.project.compositions.find((c) => c.name === "image_with_alpha 2");
    if (host == null) throw new StopIteration();
    const solid = host.addSolid([0.0, 1.0, 0.0], "Guard Solid 2").source;
    pyAssert(solid != null);
    // Snapshot after add_solid (which legitimately adds the solid and
    // AE's `Solids` folder) so this measures only the failed assignment.
    pyAssert(alt._blsi != null);
    const beforeBlsi = alt._blsi.value;
    const beforeItems = new Set(app.project.items.keys());
    raises(ValueError, () => {
      alt.alternateSource = solid;
    });
    expect(pyEq(alt._blsi?.value, beforeBlsi)).toBe(true);
    expect(pyEq(new Set(app.project.items.keys()), beforeItems)).toBe(true); // no wrapper leaked
  });
});

/** Test class TestParentValidation. */
describe("TestParentValidation", () => {
  const _twoLayers = () => {
    const app = parseAep(SAMPLES_DIR.div("property", "all_animated.aep"));
    const comp = app.project.compositions[0];
    return [app, comp.layers[0], comp.layers[1]] as const;
  };

  test("test_self_parent_raises", () => {
    const [, a] = _twoLayers();
    raises(
      ValueError,
      () => {
        a.parent = a;
      },
      "itself",
    );
  });

  test("test_self_parent_with_jump_raises", () => {
    const [, a] = _twoLayers();
    raises(ValueError, () => a.setParentWithJump(a), "itself");
  });

  test("test_cycle_raises", () => {
    const [, a, b] = _twoLayers();
    a.setParentWithJump(b);
    raises(ValueError, () => b.setParentWithJump(a), "descendants");
  });

  test("test_cycle_via_setter_raises", () => {
    const [, a, b] = _twoLayers();
    a.setParentWithJump(b);
    raises(
      ValueError,
      () => {
        b.parent = a;
      },
      "descendants",
    );
  });

  test("test_cross_comp_parent_raises", () => {
    const app = parseAep(SAMPLES_DIR.div("layer", "type.aep"));
    const src = getComp(app.project, "type_null").layers[0];
    const other = getComp(app.project, "type_camera").layers[0];
    raises(ValueError, () => src.setParentWithJump(other), "same composition");
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
    const app = parseAep(SAMPLES_DIR.div("property", "all_animated.aep"));
    const matches = app.project.compositions.flatMap((c) =>
      c.layers.filter((la) => la.name === "XF").map((la) => [c, la] as const),
    );
    // Python's loop keeps the last match.
    const last = matches.length ? matches[matches.length - 1] : null;
    pyAssert(last != null);
    const [comp, lyr] = last;
    const anchor = lyr.transform.property("ADBE Anchor Point");
    anchor.setValueAtTime(0.0, [10.0, 20.0, 0.0]);
    anchor.setValueAtTime(1.0, [70.0, 80.0, 0.0]);
    const null_ = comp.addNull();
    const nullPos = null_.transform.property("ADBE Position");
    nullPos.value = [10.0, 20.0, 0.0];
    const nullRot = null_.transform.property("ADBE Rotate Z");
    nullRot.value = 30.0;

    lyr.parent = null_;

    // Anchor keyframes are in layer-source space; AE never touches them.
    expect(pyEq(anchor.keyframes.map((k) => k.value), [
      [10.0, 20.0, 0.0],
      [70.0, 80.0, 0.0],
    ])).toBe(true);

    const pos = lyr.transform.property("ADBE Position");
    const expected = [
      [117.942286340599, 24.2820323027551, 0.0],
      [564.352447854375, -2.51288694035714, 50.0],
    ];
    for (const [kf, exp] of zip(pos.keyframes, expected)) {
      expect(approx(kf.value, exp, { abs: 1e-6 })).toBe(true);
    }
    const scale = lyr.transform.property("ADBE Scale");
    const rot = lyr.transform.property("ADBE Rotate Z");
    expect(pyEq(scale.keyframes.map((k) => k.value), [
      [50.0, 50.0, 100.0],
      [150.0, 150.0, 100.0],
    ])).toBe(true);
    expect(pyEq(rot.keyframes.map((k) => k.value), [0.0, 90.0])).toBe(true);
  });
});

/**
 * AE 2026 stores layer / solid names as UTF-8 in the fixed-width
 * legacy fields (measured via gt_unicode_names.aep), so any unicode
 * name round-trips.
 */
describe("TestUnicodeNames", () => {
  test("test_layer_rename_unicode_roundtrips", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("property", "all_animated.aep"));
    const lyr = app.project.compositions[0].layers[0];
    lyr.name = "测试✨layer";
    const out = tmpPath.div("u.aep");
    app.project.save(out);
    const app2 = parseAep(out);
    expect(app2.project.compositions[0].layers[0].name).toBe("测试✨layer");
  });

  test("test_add_text_cjk_roundtrips", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("layer", "type.aep"));
    const comp = getComp(app.project, "type_text");
    comp.addText("你好");
    const out = tmpPath.div("t.aep");
    app.project.save(out);
    const app2 = parseAep(out);
    const comp2 = getComp(app2.project, "type_text");
    expect(comp2.layers[0].name).toBe("你好");
  });

  test("test_add_solid_emoji_name_roundtrips", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("layer", "type.aep"));
    const comp = getComp(app.project, "type_null");
    comp.addSolid([1.0, 0.0, 0.0], "solid \u{1f600}");
    const out = tmpPath.div("s.aep");
    app.project.save(out);
    const app2 = parseAep(out);
    const comp2 = getComp(app2.project, "type_null");
    expect(comp2.layers[0].name).toBe("solid \u{1f600}");
  });

  test("test_text_document_content_supports_unicode", () => {
    /**
     * Text CONTENT goes through the COS layer which handles any
     * unicode; only legacy name fields are restricted.
     */
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("layer", "type.aep"));
    const comp = getComp(app.project, "type_text");
    const text = comp.textLayers[0].text;
    if (text == null) throw new Error("text layer has no Text group");
    const prop = text.property("ADBE Text Document");
    const doc = prop.value;
    doc.text = "你好 \u{1f600}";
    prop.value = doc;
    const out = tmpPath.div("cjk_text.aep");
    app.project.save(out);
    const app2 = parseAep(out);
    const comp2 = getComp(app2.project, "type_text");
    const text2 = comp2.textLayers[0].text;
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
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("property", "keyframe_1D.aep"));
    const comp = app.project.compositions[0];
    const prop = comp.layers
      .flatMap((lyr) => [...lyr.transform].filter((p) => p instanceof Property))
      .find((p) => pyBool(p.keyframes));
    if (prop == null) throw new Error("no keyframed transform property");
    prop.setValueAtTime(9999.0, prop.keyframes[0].value);
    const out = tmpPath.div("far.aep");
    app.project.save(out);
    const app2 = parseAep(out);
    const comp2 = app2.project.compositions[0];
    const prop2 = comp2.layers
      .flatMap((lyr) => [...lyr.transform].filter((p) => p instanceof Property))
      .find((p) => pyBool(p.keyframes));
    if (prop2 == null) throw new Error("no keyframed transform property after save");
    expect(approx(at(prop2.keyframes, -1).time, 9999.0)).toBe(true);
  });

  test("test_nearby_keyframe_still_works", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("property", "keyframe_1D.aep"));
    const comp = app.project.compositions[0];
    const prop = comp.layers
      .flatMap((lyr) => [...lyr.transform].filter((p) => p instanceof Property))
      .find((p) => pyBool(p.keyframes));
    if (prop == null) throw new Error("no keyframed transform property");
    prop.setValueAtTime(2.0, prop.keyframes[0].value);
    app.project.save(tmpPath.div("ok.aep"));
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

  const _doc = (app: Application, name = "RangesPoint"): TextDocument => {
    const comp = app.project.compositions[0];
    const layer = comp.textLayers.find((ly) => ly.name === name);
    if (layer == null) throw new StopIteration();
    const text = layer.text;
    pyAssert(text != null);
    return text.sourceText.value;
  };

  const bads = [NaN, Infinity];
  const charFields = ["baselineShift", "horizontalScale", "verticalScale"];
  const paraFields = ["firstLineIndent", "startIndent", "endIndent", "spaceBefore", "spaceAfter"];
  const docWideFields = ["baselineShift", "horizontalScale", "firstLineIndent"];

  // Parametrize (field x bad), in the decorator order of the Python source.
  const charRows = charFields.flatMap((field) => bads.map((bad) => [field, bad] as const));
  const paraRows = paraFields.flatMap((field) => bads.map((bad) => [field, bad] as const));

  test.each(charRows)("test_char_float_rejects_nonfinite[%#]", (field: string, bad: number) => {
    const rng = _doc(parseAep(SAMPLE)).characterRange(0, 5);
    raises(
      ValueError,
      () => {
        setattr(rng, field, bad);
      },
      "finite",
    );
  });

  test.each(paraRows)("test_para_float_rejects_nonfinite[%#]", (field: string, bad: number) => {
    const rng = _doc(parseAep(SAMPLE), "RangesJust").paragraphRange(0).characterRange();
    raises(
      ValueError,
      () => {
        setattr(rng, field, bad);
      },
      "finite",
    );
  });

  test.each(docWideFields)("test_document_wide_float_rejects_nonfinite[%#]", (field: string) => {
    // Multi-run document: the DocumentWideCosField write path must
    // validate before touching any run.
    const doc = _doc(parseAep(SAMPLE), "RangesTextReset");
    raises(
      ValueError,
      () => {
        setattr(doc, field, NaN);
      },
      "finite",
    );
  });

  test("test_valid_negative_value_roundtrips", () => {
    // A finite (negative) value is still accepted and survives a disk
    // round-trip intact - the pre-fix NaN made source_text.value None.
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLE);
    _doc(app).characterRange(0, 5).baselineShift = -3.5;
    const out = tmpPath.div("bs.aep");
    app.project.save(out);
    const doc2 = _doc(parseAep(out));
    expect(doc2 != null).toBe(true);
    expect(approx(doc2.characterRange(0, 5).baselineShift, -3.5)).toBe(true);
  });

  test("test_range_enum_rejects_out_of_range_int", () => {
    const cr = _doc(parseAep(SAMPLE), "RangesJust").paragraphRange(0).characterRange();
    raises(
      ValueError,
      () => {
        // @ts-expect-error 999 is not a ParagraphJustification; the setter must reject it at runtime
        cr.justification = 999;
      },
      "not a valid",
    );
  });

  test("test_document_wide_enum_rejects_out_of_range_int", () => {
    const doc = _doc(parseAep(SAMPLE), "RangesJust");
    raises(
      ValueError,
      () => {
        // @ts-expect-error 999 is not a ParagraphJustification; the setter must reject it at runtime
        doc.justification = 999;
      },
      "not a valid",
    );
  });

  test.each([10 ** 10, 10 ** 12, -(10 ** 10)])("test_kerning_rejects_out_of_s4_range[%#]", (value: number) => {
    // AE 2026 rejects the whole text layer for kerning/tracking beyond
    // the signed-32-bit range ("Error reading the text layer"; probed
    // 2**31 OK / 10**10 fails).
    const rng = _doc(parseAep(SAMPLE), "RangesKernLead").characterRange(1, 4);
    raises(
      ValueError,
      () => {
        rng.kerning = value;
      },
      "must be",
    );
  });

  test.each([10 ** 10, 10 ** 12])("test_tracking_rejects_out_of_s4_range[%#]", (value: number) => {
    const rng = _doc(parseAep(SAMPLE)).characterRange(0, 5);
    raises(
      ValueError,
      () => {
        rng.tracking = value;
      },
      "must be",
    );
  });

  test("test_document_wide_tracking_rejects_out_of_s4_range", () => {
    const doc = _doc(parseAep(SAMPLE), "RangesTextReset");
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
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLE);
    _doc(app, "RangesKernLead").characterRange(1, 4).kerning = 2 ** 31 - 1;
    _doc(app).characterRange(0, 5).tracking = -5000;
    const out = tmpPath.div("kt.aep");
    app.project.save(out);
    const app2 = parseAep(out);
    expect(_doc(app2, "RangesKernLead").characterRange(1, 4).kerning).toBe(2 ** 31 - 1);
    expect(_doc(app2).characterRange(0, 5).tracking).toBe(-5000);
  });
});

/** Test class TestAtomicSave. */
describe("TestAtomicSave", () => {
  test("test_failed_save_leaves_no_file", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));

    const boom = (..._args: unknown[]): never => {
      throw new RuntimeError("simulated write failure");
    };

    const undo = monkeypatchSetattr(project_mod.moduleGlobals, "writeAep", boom);
    const target = tmpPath.div("out.aep");
    try {
      raises(RuntimeError, () => app.project.save(target));
    } finally {
      undo();
    }
    expect(target.exists()).toBe(false);
    expect(tmpPath.iterdir().length).toBe(0);
  });

  test("test_failed_write_leaves_no_file", () => {
    const tmpPath = makeTmpPath();
    // The temp file is created, then writing it fails part-way (a full
    // disk, a dropped network share): the partial temp file is removed.
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    // `monkeypatch.setattr(Path, "open", ...)`: save opens its temp file
    // through the host's `node:fs`.
    const nodeFs = process.getBuiltinModule("node:fs");
    const realOpen = nodeFs.openSync;

    const openThenFail = (...args: Parameters<typeof realOpen>): never => {
      const fd = realOpen(...args);
      try {
        nodeFs.writeSync(fd, "partial");
      } finally {
        nodeFs.closeSync(fd);
      }
      throw new OSError("simulated write failure");
    };

    nodeFs.openSync = openThenFail;
    try {
      raises(OSError, () => app.project.save(tmpPath.div("out.aep")));
    } finally {
      nodeFs.openSync = realOpen;
    }
    expect(tmpPath.iterdir().length).toBe(0);
  });

  test("test_failed_rename_leaves_no_file", () => {
    const tmpPath = makeTmpPath();
    // The temp file is written, then renaming it fails (a scanner still
    // holding it on Windows): the temp file is removed.
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    // `monkeypatch.setattr(project_mod.os, "replace", boom)`: save renames
    // its temp file through the host's `node:fs`. pyrt has no
    // PermissionError; its base OSError stands in.
    const nodeFs = process.getBuiltinModule("node:fs");
    const realRename = nodeFs.renameSync;

    const boom = (..._args: Parameters<typeof realRename>): never => {
      throw new OSError("simulated rename failure");
    };

    nodeFs.renameSync = boom;
    try {
      raises(OSError, () => app.project.save(tmpPath.div("out.aep")));
    } finally {
      nodeFs.renameSync = realRename;
    }
    expect(tmpPath.iterdir().length).toBe(0);
  });
});
