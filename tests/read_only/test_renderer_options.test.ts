/** Tests for CompItem.rendererOptions (3D renderer options). */

import { describe, expect, test } from "bun:test";

import { KeyError, Path, len, assert, valueEquals } from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import {
  AdvancedRendererOptions,
  Cinema4DRendererOptions,
  ClassicRendererOptions,
  RayTracedRendererOptions,
  parse as parseAep,
} from "../../src/py_aep/index.ts";
import { asInstance } from "../helpers.ts";
import { EnvironmentLightShadowResolution, ShadowMapResolution } from "../../src/py_aep/enums/index.ts";
import { approx, raises } from "../support/pytest.ts";
import { dict } from "../support/python.ts";

// `Path(__file__).parent.parent.parent / "samples" / "models"` in the Python source.
// A TS file's `import.meta.dir` is already its directory, so two `.parent` steps reach the root.
const SAMPLES_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models");
const COMPOSITION_DIR = SAMPLES_DIR.div("composition");

describe("TestRenderOptionEnums", () => {
  /** Index into AE's dropdown, confirmed at 0, 1 and 8. */
  test("test_shadow_map_resolution_is_positional", () => {
    expect(ShadowMapResolution.COMP_SIZE).toBe(0);
    expect(ShadowMapResolution.RES_250).toBe(1);
    expect(ShadowMapResolution.RES_4000).toBe(8);
    expect(len(ShadowMapResolution.members())).toBe(9);
  });

  test("test_shadow_map_resolution_labels", () => {
    // `member.label` is a method taking the member in the TS enum (see enums/renderer_options.ts).
    expect(ShadowMapResolution.label(ShadowMapResolution.COMP_SIZE)).toBe("Comp Size");
    expect(ShadowMapResolution.label(ShadowMapResolution.RES_750)).toBe("750");
  });

  test("test_environment_light_shadow_resolution", () => {
    expect(EnvironmentLightShadowResolution.HALF).toBe(0);
    expect(EnvironmentLightShadowResolution.FULL).toBe(1);
    expect(EnvironmentLightShadowResolution.DOUBLE).toBe(2);
  });

  test("test_environment_light_shadow_resolution_labels", () => {
    expect(EnvironmentLightShadowResolution.label(EnvironmentLightShadowResolution.HALF)).toBe("Half (2MB)");
    expect(EnvironmentLightShadowResolution.label(EnvironmentLightShadowResolution.DOUBLE)).toBe("Double (128MB)");
  });
});

describe("TestRendererOptionsReads", () => {
  test("test_classic_defaults", () => {
    const comp = parseAep(COMPOSITION_DIR.div("renderer_classic_3d.aep")).project.compositions[0];
    const opts = asInstance(comp.rendererOptions, ClassicRendererOptions);

    expect(opts.shadowMapResolution).toBe(ShadowMapResolution.COMP_SIZE);
    expect(opts.get("Shadow Map Resolution")).toBe(ShadowMapResolution.COMP_SIZE);
  });

  test("test_advanced_defaults", () => {
    const comp = parseAep(COMPOSITION_DIR.div("renderer_advanced_3d.aep")).project.compositions[0];
    const opts = asInstance(comp.rendererOptions, AdvancedRendererOptions);

    expect(opts.quality).toBe(8);
    expect(opts.resolution).toBe(EnvironmentLightShadowResolution.FULL);
    expect(opts.smoothness).toBe(3);
    // Comp-relative: stored 1.0 / 0.0 render as comp width and centre.
    expect(approx(opts.castingBoxSize, comp.width)).toBe(true);
    expect(approx(opts.castingBoxCenter, [comp.width / 2, comp.height / 2, 0.0])).toBe(true);
  });

  test("test_cinema_4d_defaults", () => {
    const comp = parseAep(COMPOSITION_DIR.div("renderer_cinema_4d.aep")).project.compositions[0];

    expect(asInstance(comp.rendererOptions, Cinema4DRendererOptions).quality).toBe(25);
  });

  /** renderer_options returns a Mapping. */
  test("test_is_a_mapping", () => {
    const comp = parseAep(COMPOSITION_DIR.div("renderer_cinema_4d.aep")).project.compositions[0];
    const opts = comp.rendererOptions;

    expect(new Map(opts)).toEqual(new Map([["Quality", 25]]));
    expect([...opts.keys()]).toEqual(["Quality"]);
  });

  /** AE 26.3 cannot author this renderer, so we do not let anyone edit it. */
  test("test_ray_traced_is_read_only", () => {
    const comp = parseAep(COMPOSITION_DIR.div("renderer_ray_traced.aep")).project.compositions[0];
    const opts = comp.rendererOptions;

    assert(opts instanceof RayTracedRendererOptions);
    expect(valueEquals(dict(opts), new Map())).toBe(true);
    raises(KeyError, () => {
      opts.set("Quality", 1);
    });
    raises(TypeError, () => {
      // @ts-expect-error a ray-traced renderer has no quality; the sealed wrapper refuses the write
      opts.quality = 1;
    });
  });
});

/** Values set by hand in After Effects 26.3, on 1920x1080 comps. */
describe("TestRendererOptionsNonDefaults", () => {
  test("test_classic_non_default", () => {
    const comp = parseAep(COMPOSITION_DIR.div("renderer_options_classic_3d.aep")).project.compositions[0];

    expect(asInstance(comp.rendererOptions, ClassicRendererOptions).shadowMapResolution).toBe(
      ShadowMapResolution.RES_750,
    );
  });

  test("test_cinema_4d_non_default", () => {
    const comp = parseAep(COMPOSITION_DIR.div("renderer_options_cinema_4d.aep")).project.compositions[0];

    expect(asInstance(comp.rendererOptions, Cinema4DRendererOptions).quality).toBe(44);
  });

  test("test_advanced_non_default", () => {
    const comp = parseAep(COMPOSITION_DIR.div("renderer_options_advanced_3d.aep")).project.compositions[0];

    expect(asInstance(comp.rendererOptions, AdvancedRendererOptions).quality).toBe(61);
    expect(asInstance(comp.rendererOptions, AdvancedRendererOptions).resolution).toBe(
      EnvironmentLightShadowResolution.DOUBLE,
    );
    expect(asInstance(comp.rendererOptions, AdvancedRendererOptions).smoothness).toBe(6);
    expect(approx(asInstance(comp.rendererOptions, AdvancedRendererOptions).castingBoxSize, 600.0)).toBe(true);
    expect(
      approx(asInstance(comp.rendererOptions, AdvancedRendererOptions).castingBoxCenter, [400.0, 600.0, -100.0]),
    ).toBe(true);
  });
});
