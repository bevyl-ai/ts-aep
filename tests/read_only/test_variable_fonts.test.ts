/** Read-only tests for variable-font support (AE 2026 fixtures). */

// `from __future__ import annotations` is dropped: no annotation here is
// evaluated at runtime. Python test classes become `describe` blocks; the
// module-level helpers stay module-level functions.

import { describe, expect, test } from "bun:test";
import { Path, pyAssert, pyEq } from "../../src/pyrt/index.ts";
import { VariableFontSpacing } from "../../src/py_aep/enums/index.ts";
import "../../src/py_aep/binary/_register.ts";
import type { Layer } from "../../src/py_aep/models/layers/layer.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";
import type { FontObject } from "../../src/py_aep/models/text/font_object.ts";
import { asInstance, getComp, parseProject } from "../helpers.ts";

// Path(__file__).parent x3 is the TS root (this file lives in tests/read_only).
const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "layer");

function _vfLayer(name: string): Layer {
  const project = parseProject(SAMPLES_DIR.div(name));
  return getComp(project, "vf").layers[0];
}

function _animatorProps(layer: Layer): PropertyGroup {
  const animators = layer.property("ADBE Text Properties").property("ADBE Text Animators");
  return asInstance(animators.properties[0], PropertyGroup).property("ADBE Text Animator Properties");
}

/** The font of a text layer's Source Text. */
function _fontObject(layer: Layer): FontObject | null {
  const text = layer.text;
  pyAssert(text != null);
  return text.sourceText.value.fontObject;
}

describe("TestFontObjectVariable", () => {
  test("test_design_vector_default_instance", () => {
    const font = _fontObject(_vfLayer("variable_font_static.aep"));
    pyAssert(font != null);
    expect(pyEq(font.designVector, [400.0, 100.0])).toBe(true);
    expect(font.hasDesignAxes).toBe(true);
    expect(font.familyPrefix).toBe("Bahnschrift");
  });

  test("test_design_vector_named_instance", () => {
    const font = _fontObject(_vfLayer("variable_font_instance.aep"));
    pyAssert(font != null);
    expect(font.postScriptName).toBe("Bahnschrift-BoldSemiCondensed");
    expect(pyEq(font.designVector, [700.0, 87.5])).toBe(true);
    expect(font.familyPrefix).toBe("Bahnschrift");
  });

  test("test_non_variable_font", () => {
    const project = parseProject(SAMPLES_DIR.div("threeDPerChar_on.aep"));
    const font = _fontObject(project.compositions[0].layers[0]);
    pyAssert(font != null);
    expect(font.designVector).toBe(null);
    expect(font.hasDesignAxes).toBe(false);
    expect(font.familyPrefix).toBe(null);
  });
});

describe("TestVariableFontAxisProperty", () => {
  test("test_static_axis", () => {
    const props = _animatorProps(_vfLayer("variable_font_axis_static.aep"));
    const axis = asInstance(props.property("ADBE Text VF Axis 1"), Property);
    expect(axis.value).toBe(700.0);
    expect(axis.axisTag).toBe("wght");
    expect(axis.name).toBe("Font Axis Weight");
    expect(axis.minValue).toBe(300.0);
    expect(axis.maxValue).toBe(700.0);
  });

  test("test_animated_axis_scalar_keyframes", () => {
    const props = _animatorProps(_vfLayer("variable_font_axis_animated.aep"));
    const wght = asInstance(props.property("ADBE Text VF Axis 1"), Property);
    expect(pyEq(wght.keyframes.map((kf) => kf.value), [300.0, 700.0])).toBe(true);
    expect(wght.axisTag).toBe("wght");
    const wdth = asInstance(props.property("ADBE Text VF Axis 2"), Property);
    expect(wdth.value).toBe(80.0);
    expect(wdth.axisTag).toBe("wdth");
    expect(wdth.name).toBe("Font Axis Width");
  });

  test("test_unused_slot", () => {
    const props = _animatorProps(_vfLayer("variable_font_axis_animated.aep"));
    const slot = asInstance(props.property("ADBE Text VF Axis 3"), Property);
    expect(slot.axisTag).toBe(null);
    expect(slot.name).toBe("");
  });

  test("test_axis_tag_none_for_regular_property", () => {
    const layer = _vfLayer("variable_font_axis_static.aep");
    const opacity = layer.transform.property("ADBE Opacity");
    expect(opacity.axisTag).toBe(null);
  });
});

describe("TestVariableFontSpacing", () => {
  test("test_spacing_value_enum", () => {
    const layer = _vfLayer("variable_font_spacing.aep");
    const prop = asInstance(
      layer
        .property("ADBE Text Properties")
        .property("ADBE Text More Options")
        .property("ADBE Text Variable Font Spacing"),
      Property,
    );
    expect(prop.name).toBe("Variable Font Spacing");
    expect(VariableFontSpacing.of(prop.value)).toBe(VariableFontSpacing.PER_CHARACTER);
  });

  test("test_spacing_default", () => {
    const layer = _vfLayer("variable_font_axis_static.aep");
    const prop = asInstance(
      layer
        .property("ADBE Text Properties")
        .property("ADBE Text More Options")
        .property("ADBE Text Variable Font Spacing"),
      Property,
    );
    expect(VariableFontSpacing.of(prop.value)).toBe(VariableFontSpacing.ADAPTIVE);
  });
});

describe("TestValueText", () => {
  test("test_value_text_none_without_dropdown_parameters", () => {
    const layer = _vfLayer("variable_font_axis_static.aep");
    const opacity = layer.transform.property("ADBE Opacity");
    expect(opacity.valueText).toBe(null);
  });
});
