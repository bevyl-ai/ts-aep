/**
 * Roundtrip tests for variable-font mutations.
 *
 * `add_variable_font_axis` reads the axis metadata from the installed font
 * file with fontTools; tests needing the Bahnschrift variable font skip
 * when it is not installed (e.g. non-Windows CI).
 */

import { describe, expect, test } from "bun:test";
import { float, Path, py_assert, py_eq, ValueError } from "../../src/pyrt/index.ts";
import { make_tmp_path, raises } from "../../src/pyrt/pytest.ts";
import { parse as parse_aep, type Application } from "../../src/py_aep/index.ts";
import { resolve_font_exact } from "../../src/py_aep/svg/fonts.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";
import { as_instance, get_comp } from "../helpers.ts";

const SAMPLES = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "layer");

const _BAHNSCHRIFT = resolve_font_exact("Bahnschrift");

// pytest.mark.skipif(_BAHNSCHRIFT is None, reason="Bahnschrift variable font not installed")
const needs_bahnschrift = _BAHNSCHRIFT == null;

function _fresh_vf(): [Application, PropertyGroup] {
  const app = parse_aep(String(SAMPLES.div("variable_font_static.aep")));
  const layer = get_comp(app.project, "vf").layers[0];
  const animators = layer.property("ADBE Text Properties").property("ADBE Text Animators");
  const animator = animators.addProperty("ADBE Text Animator");
  return [app, animator.property("ADBE Text Animator Properties")];
}

describe("TestAddVariableFontAxis", () => {
  test.skipIf(needs_bahnschrift)("test_add_axis_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const [app, props] = _fresh_vf();
    const axis = props.addVariableFontAxis("wght");
    // Bounds, default value and display name come from the font file.
    expect(axis.axisTag).toBe("wght");
    expect(axis.name).toBe("Font Axis Weight");
    expect(axis.value).toBe(400.0);
    expect(axis.minValue).toBe(300.0);
    expect(axis.maxValue).toBe(700.0);
    axis.value = 700.0;

    const out = tmp_path.div("axis.aep");
    app.project.save(out);
    const app2 = parse_aep(String(out));
    const props2 = as_instance(
      get_comp(app2.project, "vf").layers[0].property("ADBE Text Properties").property("ADBE Text Animators")
        .properties[0],
      PropertyGroup,
    ).property("ADBE Text Animator Properties");
    const axis2 = as_instance(props2.property("ADBE Text VF Axis 1"), Property);
    expect(axis2.axisTag).toBe("wght");
    expect(axis2.name).toBe("Font Axis Weight");
    expect(axis2.value).toBe(700.0);
    expect(py_eq([axis2.minValue, axis2.maxValue], [300.0, 700.0])).toBe(true);
  });

  test.skipIf(needs_bahnschrift)("test_add_axis_animated_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const [app, props] = _fresh_vf();
    const wght = props.addVariableFontAxis("wght");
    wght.setValueAtTime(0.0, 300.0);
    wght.setValueAtTime(2.0, 700.0);
    const wdth = props.addVariableFontAxis("wdth");
    wdth.value = 80.0;

    const out = tmp_path.div("axis_anim.aep");
    app.project.save(out);
    const app2 = parse_aep(String(out));
    const props2 = as_instance(
      get_comp(app2.project, "vf").layers[0].property("ADBE Text Properties").property("ADBE Text Animators")
        .properties[0],
      PropertyGroup,
    ).property("ADBE Text Animator Properties");
    const wght2 = as_instance(props2.property("ADBE Text VF Axis 1"), Property);
    expect(py_eq(wght2.keyframes.map((kf) => kf.value), [300.0, 700.0])).toBe(true);
    expect(wght2.axisTag).toBe("wght");
    const wdth2 = as_instance(props2.property("ADBE Text VF Axis 2"), Property);
    expect(wdth2.value).toBe(80.0);
    expect(wdth2.axisTag).toBe("wdth");
  });

  test.skipIf(needs_bahnschrift)("test_remove_all_keys_restores_static", () => {
    const tmp_path = make_tmp_path();
    const [app, props] = _fresh_vf();
    const wght = props.addVariableFontAxis("wght");
    wght.setValueAtTime(0.0, 300.0);
    wght.setValueAtTime(2.0, 700.0);
    wght.removeAllKeys();
    expect(py_eq(wght.keyframes, [])).toBe(true);
    expect(wght.axisTag).toBe("wght");

    const out = tmp_path.div("deanimated.aep");
    app.project.save(out);
    const app2 = parse_aep(String(out));
    const props2 = as_instance(
      get_comp(app2.project, "vf").layers[0].property("ADBE Text Properties").property("ADBE Text Animators")
        .properties[0],
      PropertyGroup,
    ).property("ADBE Text Animator Properties");
    const wght2 = as_instance(props2.property("ADBE Text VF Axis 1"), Property);
    expect(py_eq(wght2.keyframes, [])).toBe(true);
    expect(wght2.axisTag).toBe("wght");
    expect(wght2.value).toBe(300.0);
  });

  test.skipIf(needs_bahnschrift)("test_same_tag_returns_existing_slot", () => {
    const [, props] = _fresh_vf();
    const first = props.addVariableFontAxis("wght");
    const again = props.addVariableFontAxis("wght");
    expect(again).toBe(first);
  });

  test.skipIf(needs_bahnschrift)("test_unknown_tag_raises", () => {
    const [, props] = _fresh_vf();
    raises(ValueError, () => {
      props.addVariableFontAxis("XXXX");
    }, "no 'XXXX' axis");
  });

  test("test_bad_tag_length_raises", () => {
    const [, props] = _fresh_vf();
    raises(ValueError, () => {
      props.addVariableFontAxis("weight");
    });
  });

  test("test_wrong_group_raises", () => {
    const app = parse_aep(String(SAMPLES.div("variable_font_static.aep")));
    const layer = get_comp(app.project, "vf").layers[0];
    raises(ValueError, () => {
      layer.transform.addVariableFontAxis("wght");
    });
  });

  test.skipIf(needs_bahnschrift)("test_setting_value_preserves_tag", () => {
    const tmp_path = make_tmp_path();
    const [app, props] = _fresh_vf();
    const axis = props.addVariableFontAxis("wdth");
    axis.value = 90.0;
    const out = tmp_path.div("tag_kept.aep");
    app.project.save(out);
    const app2 = parse_aep(String(out));
    const props2 = as_instance(
      get_comp(app2.project, "vf").layers[0].property("ADBE Text Properties").property("ADBE Text Animators")
        .properties[0],
      PropertyGroup,
    ).property("ADBE Text Animator Properties");
    const axis2 = as_instance(props2.property("ADBE Text VF Axis 1"), Property);
    expect(axis2.value).toBe(90.0);
    expect(axis2.axisTag).toBe("wdth");
  });

  test.skipIf(needs_bahnschrift)("test_axis_value_rejects_invalid", () => {
    // The VARIABLE_FONT_AXIS value type is not numeric, so validation
    // used to be skipped and NaN/inf/out-of-range weights were written.
    const [, props] = _fresh_vf();
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
    const app = parse_aep(String(SAMPLES.parent.div("property", "2_gaussian.aep")));
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.effects != null);
    const fx = as_instance(layer.effects.addProperty("ADBE Dropdown Control"), PropertyGroup);
    const menu = as_instance(fx.property("Menu"), Property);
    expect(py_eq(menu.propertyParameters, ["Item 1", "Item 2", "Item 3"])).toBe(true);
    expect(menu.valueText).toBe("Item 1");
    menu.value = 3;
    expect(menu.valueText).toBe("Item 3");
  });
});
