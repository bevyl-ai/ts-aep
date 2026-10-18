/**
 * Roundtrip tests for variable-font mutations.
 *
 * `add_variable_font_axis` reads the axis metadata from the installed font
 * file with fontTools; tests needing the Bahnschrift variable font skip
 * when it is not installed (e.g. non-Windows CI).
 */

import { describe, expect, test } from "bun:test";
import { float, Path, pyAssert, pyEq, ValueError } from "../../src/pyrt/index.ts";
import { makeTmpPath, raises } from "../../src/pyrt/pytest.ts";
import { parse as parseAep, type Application } from "../../src/py_aep/index.ts";
import { resolveFontExact } from "../../src/py_aep/svg/fonts.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";
import { asInstance, getComp } from "../helpers.ts";

const SAMPLES = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "layer");

const _BAHNSCHRIFT = resolveFontExact("Bahnschrift");

// pytest.mark.skipif(_BAHNSCHRIFT is None, reason="Bahnschrift variable font not installed")
const needsBahnschrift = _BAHNSCHRIFT == null;

function _freshVf(): [Application, PropertyGroup] {
  const app = parseAep(String(SAMPLES.div("variable_font_static.aep")));
  const layer = getComp(app.project, "vf").layers[0];
  const animators = layer.property("ADBE Text Properties").property("ADBE Text Animators");
  const animator = animators.addProperty("ADBE Text Animator");
  return [app, animator.property("ADBE Text Animator Properties")];
}

describe("TestAddVariableFontAxis", () => {
  test.skipIf(needsBahnschrift)("test_add_axis_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const [app, props] = _freshVf();
    const axis = props.addVariableFontAxis("wght");
    // Bounds, default value and display name come from the font file.
    expect(axis.axisTag).toBe("wght");
    expect(axis.name).toBe("Font Axis Weight");
    expect(axis.value).toBe(400.0);
    expect(axis.minValue).toBe(300.0);
    expect(axis.maxValue).toBe(700.0);
    axis.value = 700.0;

    const out = tmpPath.div("axis.aep");
    app.project.save(out);
    const app2 = parseAep(String(out));
    const props2 = asInstance(
      getComp(app2.project, "vf").layers[0].property("ADBE Text Properties").property("ADBE Text Animators")
        .properties[0],
      PropertyGroup,
    ).property("ADBE Text Animator Properties");
    const axis2 = asInstance(props2.property("ADBE Text VF Axis 1"), Property);
    expect(axis2.axisTag).toBe("wght");
    expect(axis2.name).toBe("Font Axis Weight");
    expect(axis2.value).toBe(700.0);
    expect(pyEq([axis2.minValue, axis2.maxValue], [300.0, 700.0])).toBe(true);
  });

  test.skipIf(needsBahnschrift)("test_add_axis_animated_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const [app, props] = _freshVf();
    const wght = props.addVariableFontAxis("wght");
    wght.setValueAtTime(0.0, 300.0);
    wght.setValueAtTime(2.0, 700.0);
    const wdth = props.addVariableFontAxis("wdth");
    wdth.value = 80.0;

    const out = tmpPath.div("axis_anim.aep");
    app.project.save(out);
    const app2 = parseAep(String(out));
    const props2 = asInstance(
      getComp(app2.project, "vf").layers[0].property("ADBE Text Properties").property("ADBE Text Animators")
        .properties[0],
      PropertyGroup,
    ).property("ADBE Text Animator Properties");
    const wght2 = asInstance(props2.property("ADBE Text VF Axis 1"), Property);
    expect(pyEq(wght2.keyframes.map((kf) => kf.value), [300.0, 700.0])).toBe(true);
    expect(wght2.axisTag).toBe("wght");
    const wdth2 = asInstance(props2.property("ADBE Text VF Axis 2"), Property);
    expect(wdth2.value).toBe(80.0);
    expect(wdth2.axisTag).toBe("wdth");
  });

  test.skipIf(needsBahnschrift)("test_remove_all_keys_restores_static", () => {
    const tmpPath = makeTmpPath();
    const [app, props] = _freshVf();
    const wght = props.addVariableFontAxis("wght");
    wght.setValueAtTime(0.0, 300.0);
    wght.setValueAtTime(2.0, 700.0);
    wght.removeAllKeys();
    expect(pyEq(wght.keyframes, [])).toBe(true);
    expect(wght.axisTag).toBe("wght");

    const out = tmpPath.div("deanimated.aep");
    app.project.save(out);
    const app2 = parseAep(String(out));
    const props2 = asInstance(
      getComp(app2.project, "vf").layers[0].property("ADBE Text Properties").property("ADBE Text Animators")
        .properties[0],
      PropertyGroup,
    ).property("ADBE Text Animator Properties");
    const wght2 = asInstance(props2.property("ADBE Text VF Axis 1"), Property);
    expect(pyEq(wght2.keyframes, [])).toBe(true);
    expect(wght2.axisTag).toBe("wght");
    expect(wght2.value).toBe(300.0);
  });

  test.skipIf(needsBahnschrift)("test_same_tag_returns_existing_slot", () => {
    const [, props] = _freshVf();
    const first = props.addVariableFontAxis("wght");
    const again = props.addVariableFontAxis("wght");
    expect(again).toBe(first);
  });

  test.skipIf(needsBahnschrift)("test_unknown_tag_raises", () => {
    const [, props] = _freshVf();
    raises(ValueError, () => {
      props.addVariableFontAxis("XXXX");
    }, "no 'XXXX' axis");
  });

  test("test_bad_tag_length_raises", () => {
    const [, props] = _freshVf();
    raises(ValueError, () => {
      props.addVariableFontAxis("weight");
    });
  });

  test("test_wrong_group_raises", () => {
    const app = parseAep(String(SAMPLES.div("variable_font_static.aep")));
    const layer = getComp(app.project, "vf").layers[0];
    raises(ValueError, () => {
      layer.transform.addVariableFontAxis("wght");
    });
  });

  test.skipIf(needsBahnschrift)("test_setting_value_preserves_tag", () => {
    const tmpPath = makeTmpPath();
    const [app, props] = _freshVf();
    const axis = props.addVariableFontAxis("wdth");
    axis.value = 90.0;
    const out = tmpPath.div("tag_kept.aep");
    app.project.save(out);
    const app2 = parseAep(String(out));
    const props2 = asInstance(
      getComp(app2.project, "vf").layers[0].property("ADBE Text Properties").property("ADBE Text Animators")
        .properties[0],
      PropertyGroup,
    ).property("ADBE Text Animator Properties");
    const axis2 = asInstance(props2.property("ADBE Text VF Axis 1"), Property);
    expect(axis2.value).toBe(90.0);
    expect(axis2.axisTag).toBe("wdth");
  });

  test.skipIf(needsBahnschrift)("test_axis_value_rejects_invalid", () => {
    // The VARIABLE_FONT_AXIS value type is not numeric, so validation
    // used to be skipped and NaN/inf/out-of-range weights were written.
    const [, props] = _freshVf();
    const axis = props.addVariableFontAxis("wght"); // font bounds 300..700
    for (const bad of [float("nan"), float("inf"), 100000.0, -9999.0]) {
      raises(ValueError, () => {
        axis.value = bad;
      });
    }
    axis.value = 650.0; // in range still accepted
    expect(axis.value).toBe(650.0);
  });
});

describe("TestValueTextDropdown", () => {
  test("test_value_text_for_custom_dropdown", () => {
    const app = parseAep(String(SAMPLES.parent.div("property", "2_gaussian.aep")));
    const layer = app.project.compositions[0].layers[0];
    pyAssert(layer.effects != null);
    const fx = asInstance(layer.effects.addProperty("ADBE Dropdown Control"), PropertyGroup);
    const menu = asInstance(fx.property("Menu"), Property);
    expect(pyEq(menu.propertyParameters, ["Item 1", "Item 2", "Item 3"])).toBe(true);
    expect(menu.valueText).toBe("Item 1");
    menu.value = 3;
    expect(menu.valueText).toBe("Item 3");
  });
});
