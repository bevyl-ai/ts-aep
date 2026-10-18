/** Mutation round-trips for CompItem.rendererOptions. */

import { describe, expect, test } from "bun:test";

import { KeyError, Path, ValueError } from "../../src/pyrt/index.ts";
import { approx, makeTmpPath, raises } from "../../src/pyrt/pytest.ts";
import { asInstance } from "../helpers.ts";
import { parse as parseAep } from "../../src/py_aep/index.ts";
import type { Application } from "../../src/py_aep/models/application.ts";
import type { CompItem } from "../../src/py_aep/models/items/composition.ts";
import {
  AdvancedRendererOptions,
  Cinema4DRendererOptions,
  ClassicRendererOptions,
} from "../../src/py_aep/models/items/renderer_options/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { EnvironmentLightShadowResolution, ShadowMapResolution } from "../../src/py_aep/enums/index.ts";

const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models");
const COMPOSITION_DIR = SAMPLES_DIR.div("composition");

function _reparse(app: Application, tmpPath: Path): CompItem {
  const out = tmpPath.div("modified.aep");
  app.project.save(out);
  return parseAep(out).project.compositions[0];
}

describe("TestRoundtripRendererOptions", () => {
  test("test_classic_shadow_map", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(COMPOSITION_DIR.div("renderer_classic_3d.aep"));
    asInstance(app.project.compositions[0].rendererOptions, ClassicRendererOptions).shadowMapResolution = ShadowMapResolution.RES_4000;

    const comp = _reparse(app, tmpPath);

    expect(asInstance(comp.rendererOptions, ClassicRendererOptions).shadowMapResolution).toBe(ShadowMapResolution.RES_4000);
  });

  test("test_assign_from_another_options_view", () => {
    // Port-only: py_aep's setter takes any Mapping, including another comp's view.
    const tmpPath = makeTmpPath();
    const app = parseAep(COMPOSITION_DIR.div("renderer_cinema_4d.aep"));
    const source = parseAep(COMPOSITION_DIR.div("renderer_cinema_4d.aep")).project.compositions[0];
    asInstance(source.rendererOptions, Cinema4DRendererOptions).quality = 42;
    app.project.compositions[0].rendererOptions = source.rendererOptions;

    expect(asInstance(_reparse(app, tmpPath).rendererOptions, Cinema4DRendererOptions).quality).toBe(42);
  });

  test("test_cinema_4d_quality", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(COMPOSITION_DIR.div("renderer_cinema_4d.aep"));
    asInstance(app.project.compositions[0].rendererOptions, Cinema4DRendererOptions).quality = 99;

    expect(asInstance(_reparse(app, tmpPath).rendererOptions, Cinema4DRendererOptions).quality).toBe(99);
  });

  test("test_advanced_scalars", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(COMPOSITION_DIR.div("renderer_advanced_3d.aep"));
    const opts = asInstance(app.project.compositions[0].rendererOptions, AdvancedRendererOptions);
    opts.quality = 125;
    opts.resolution = EnvironmentLightShadowResolution.HALF;
    opts.smoothness = 20;

    const comp = _reparse(app, tmpPath);

    expect(asInstance(comp.rendererOptions, AdvancedRendererOptions).quality).toBe(125);
    expect(asInstance(comp.rendererOptions, AdvancedRendererOptions).resolution).toBe(EnvironmentLightShadowResolution.HALF);
    expect(asInstance(comp.rendererOptions, AdvancedRendererOptions).smoothness).toBe(20);
  });

  /** Pixel values survive a save, to float32 precision.
   *
   * `approx` is required: the field holds a float64 in memory and narrows
   * to float32 only when packed on save, so a value that crosses disk
   * returns off by ~4e-5 px. A set-then-read without saving would compare
   * exactly equal, which is the trap.
   */
  test("test_advanced_casting_box", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(COMPOSITION_DIR.div("renderer_advanced_3d.aep"));
    const opts = asInstance(app.project.compositions[0].rendererOptions, AdvancedRendererOptions);
    opts.castingBoxSize = 640.0;
    opts.castingBoxCenter = [100.0, 200.0, -300.0];

    const comp = _reparse(app, tmpPath);

    expect(approx(asInstance(comp.rendererOptions, AdvancedRendererOptions).castingBoxSize, 640.0)).toBe(true);
    expect(approx(asInstance(comp.rendererOptions, AdvancedRendererOptions).castingBoxCenter, [100.0, 200.0, -300.0])).toBe(true);
  });

  test("test_mapping_write_round_trips", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(COMPOSITION_DIR.div("renderer_advanced_3d.aep"));
    app.project.compositions[0].rendererOptions.set("Quality", 42);

    expect(_reparse(app, tmpPath).rendererOptions.get("Quality")).toBe(42);
  });

  test("test_bulk_assignment", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(COMPOSITION_DIR.div("renderer_advanced_3d.aep"));
    app.project.compositions[0].rendererOptions = new Map<string, number>([
      ["Quality", 7],
      ["Smoothness", 2],
    ]);

    const comp = _reparse(app, tmpPath);

    expect(asInstance(comp.rendererOptions, AdvancedRendererOptions).quality).toBe(7);
    expect(asInstance(comp.rendererOptions, AdvancedRendererOptions).smoothness).toBe(2);
  });
});

describe("TestRendererOptionsValidation", () => {
  test("test_quality_out_of_range", () => {
    const comp = parseAep(COMPOSITION_DIR.div("renderer_advanced_3d.aep")).project.compositions[0];

    raises(ValueError, () => {
      asInstance(comp.rendererOptions, AdvancedRendererOptions).quality = 126;
    });
  });

  test("test_unknown_key", () => {
    const comp = parseAep(COMPOSITION_DIR.div("renderer_cinema_4d.aep")).project.compositions[0];

    raises(KeyError, () => {
      comp.rendererOptions.set("Nonexistent", 1);
    });
  });

  /** ChunkField.enum validates membership without a separate validator. */
  test("test_enum_rejects_out_of_range", () => {
    const comp = parseAep(COMPOSITION_DIR.div("renderer_classic_3d.aep")).project.compositions[0];

    raises(ValueError, () => {
      // @ts-expect-error 9 is not a ShadowMapResolution member; the write must raise ValueError at runtime
      asInstance(comp.rendererOptions, ClassicRendererOptions).shadowMapResolution = 9;
    });
  });

  test.each([-1, 30001])("test_casting_box_size_out_of_range[%#]", (bad: number) => {
    const comp = parseAep(COMPOSITION_DIR.div("renderer_advanced_3d.aep")).project.compositions[0];

    raises(ValueError, () => {
      asInstance(comp.rendererOptions, AdvancedRendererOptions).castingBoxSize = bad;
    });
  });

  test.each([[[0.0, 0.0]], [[40000.0, 0.0, 0.0]], [[0.0, -40000.0, 0.0]]])(
    "test_casting_box_center_rejected[%#]",
    (bad: number[]) => {
      const comp = parseAep(COMPOSITION_DIR.div("renderer_advanced_3d.aep")).project.compositions[0];

      raises(ValueError, () => {
        asInstance(comp.rendererOptions, AdvancedRendererOptions).castingBoxCenter = bad;
      });
    },
  );

  test("test_smoothness_out_of_range", () => {
    const comp = parseAep(COMPOSITION_DIR.div("renderer_advanced_3d.aep")).project.compositions[0];

    raises(ValueError, () => {
      asInstance(comp.rendererOptions, AdvancedRendererOptions).smoothness = 21;
    });
  });
});
