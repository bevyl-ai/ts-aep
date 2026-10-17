/**
 * Tests for ViewOptions model parsing using samples from models/view/.
 *
 * These tests verify that py_aep correctly reads viewer panel settings
 * (channels, exposure, zoom, fast preview, toggle flags, etc.) from the
 * `fips` chunks in the binary AEP format.
 *
 * The viewer panel data is accessed via `project.active_viewer`, which
 * represents the focused Composition/Layer/Footage panel. Each panel has
 * one or more `View` objects containing `ViewOptions`.
 */

import { describe, expect, test } from "bun:test";
import { Path, TypeError_, ValueError, isclose, py_assert } from "../../src/pyrt/index.ts";
import { make_tmp_path, raises } from "../../src/pyrt/pytest.ts";
import { parse_app_fresh } from "../helpers.ts";

import "../../src/py_aep/binary/_register.ts";
import { ChannelType, FastPreviewType, ViewerType, type ViewOptions } from "../../src/py_aep/index.ts";
import { parse as parse_aep } from "../../src/py_aep/index.ts";
import type { Application } from "../../src/py_aep/index.ts";

// `Path(__file__).parent.parent.parent / ...` in the Python source.
const SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models", "view");

/** Parse a project and return the ViewOptions of the active viewer's first view. */
function _get_active_view_options(aep_path: Path): ViewOptions {
  const app = parse_app_fresh(aep_path);
  py_assert(app.active_viewer != null);
  expect(app.active_viewer.type).toBe(ViewerType.VIEWER_COMPOSITION);
  expect(app.active_viewer.views.length >= 1).toBe(true);
  return app.active_viewer.views[0].options;
}

/** Parse a non-cached app and return (app, active view options). */
function _get_active_app_and_options(aep_path: Path): [Application, ViewOptions] {
  const app = parse_aep(aep_path);
  py_assert(app.active_viewer != null);
  expect(app.active_viewer.views.length >= 1).toBe(true);
  return [app, app.active_viewer.views[0].options];
}

/** Save the project, re-parse, and return the active view options. */
function _roundtrip_options(app: Application, tmp_path: Path): ViewOptions {
  const out = tmp_path.div("modified.aep");
  app.project.save(out);
  const app2 = parse_aep(out);
  py_assert(app2.active_viewer != null);
  expect(app2.active_viewer.views.length >= 1).toBe(true);
  return app2.active_viewer.views[0].options;
}

describe("TestViewActive", () => {
  /** The first view should be active by default. */
  test("test_first_view_active_by_default", () => {
    const app = parse_app_fresh(SAMPLES_DIR.div("roi_base.aep"));
    py_assert(app.active_viewer != null);
    expect(app.active_viewer.views[0].active).toBe(true);
  });

  /** set_active() should update the viewer's active_view_index. */
  test("test_set_active_changes_index", () => {
    const app = parse_app_fresh(SAMPLES_DIR.div("roi_left_viewer.aep"));
    py_assert(app.active_viewer != null);
    const viewer = app.active_viewer;
    expect(viewer.views.length).toBe(2);
    expect(viewer.active_view_index).toBe(0);
    expect(viewer.views[0].active).toBe(true);
    expect(viewer.views[1].active).toBe(false);

    viewer.views[1].set_active();
    expect(viewer.active_view_index).toBe(1);
    expect(viewer.views[0].active).toBe(false);
    expect(viewer.views[1].active).toBe(true);
  });

  /** Setting an invalid active_view_index should raise ValueError. */
  test("test_active_view_index_setter_validation", () => {
    const app = parse_app_fresh(SAMPLES_DIR.div("roi_base.aep"));
    py_assert(app.active_viewer != null);
    const viewer = app.active_viewer;
    raises(ValueError, () => {
      viewer.active_view_index = 99;
    });
  });
});

describe("TestRoundtripChannels", () => {
  /** Roundtrip tests for ViewOptions.channels. */
  test("test_modify_channels", () => {
    const tmp_path = make_tmp_path();
    const [app, opts] = _get_active_app_and_options(SAMPLES_DIR.div("channels_rgb.aep"));
    expect(opts.channels).toBe(ChannelType.CHANNEL_RGB);

    opts.channels = ChannelType.CHANNEL_ALPHA;
    const opts2 = _roundtrip_options(app, tmp_path);
    expect(opts2.channels).toBe(ChannelType.CHANNEL_ALPHA);
  });
});

describe("TestRoundtripCheckerboards", () => {
  /** Roundtrip tests for ViewOptions.checkerboards. */
  test("test_toggle_checkerboards", () => {
    const tmp_path = make_tmp_path();
    const [app, opts] = _get_active_app_and_options(SAMPLES_DIR.div("transparency_grid_off.aep"));
    expect(opts.checkerboards).toBe(false);

    opts.checkerboards = true;
    const opts2 = _roundtrip_options(app, tmp_path);
    expect(opts2.checkerboards).toBe(true);
  });
});

describe("TestRoundtripDraft3d", () => {
  /** Roundtrip tests for ViewOptions.draft3d. */
  test("test_toggle_draft3d", () => {
    const tmp_path = make_tmp_path();
    const [app, opts] = _get_active_app_and_options(SAMPLES_DIR.div("draft3d_false.aep"));
    expect(opts.draft3d).toBe(false);

    opts.draft3d = true;
    const opts2 = _roundtrip_options(app, tmp_path);
    expect(opts2.draft3d).toBe(true);
  });
});

describe("TestRoundtripExposure", () => {
  /** Roundtrip tests for ViewOptions.exposure. */
  test("test_modify_exposure", () => {
    const tmp_path = make_tmp_path();
    const [app, opts] = _get_active_app_and_options(SAMPLES_DIR.div("exposure_0.0.aep"));
    expect(opts.exposure).toBe(0.0);

    opts.exposure = 5.5;
    const opts2 = _roundtrip_options(app, tmp_path);
    expect(isclose(opts2.exposure, 5.5, undefined, 0.01)).toBe(true);
  });

  test("test_exposure_validation_rejects_too_high", () => {
    const [_, opts] = _get_active_app_and_options(SAMPLES_DIR.div("exposure_0.0.aep"));
    raises(
      ValueError,
      () => {
        opts.exposure = 41.0;
      },
      "must be <= 40(\\.0)?",
    );
  });

  test("test_exposure_validation_rejects_too_low", () => {
    const [_, opts] = _get_active_app_and_options(SAMPLES_DIR.div("exposure_0.0.aep"));
    raises(
      ValueError,
      () => {
        opts.exposure = -41.0;
      },
      "must be >= -40(\\.0)?",
    );
  });
});

describe("TestRoundtripFastPreview", () => {
  /** Roundtrip tests for ViewOptions.fast_preview. */
  test("test_modify_fast_preview_to_wireframe", () => {
    const tmp_path = make_tmp_path();
    const [app, opts] = _get_active_app_and_options(SAMPLES_DIR.div("fast_preview_off.aep"));
    expect(opts.fast_preview).toBe(FastPreviewType.FP_OFF);

    opts.fast_preview = FastPreviewType.FP_WIREFRAME;
    const opts2 = _roundtrip_options(app, tmp_path);
    expect(opts2.fast_preview).toBe(FastPreviewType.FP_WIREFRAME);
  });

  test("test_modify_fast_preview_to_adaptive", () => {
    const tmp_path = make_tmp_path();
    const [app, opts] = _get_active_app_and_options(SAMPLES_DIR.div("fast_preview_off.aep"));
    opts.fast_preview = FastPreviewType.FP_ADAPTIVE_RESOLUTION;
    const opts2 = _roundtrip_options(app, tmp_path);
    expect(opts2.fast_preview).toBe(FastPreviewType.FP_ADAPTIVE_RESOLUTION);
  });

  test("test_modify_fast_preview_to_off", () => {
    const tmp_path = make_tmp_path();
    const [app, opts] = _get_active_app_and_options(SAMPLES_DIR.div("fast_preview_wireframe.aep"));
    expect(opts.fast_preview).toBe(FastPreviewType.FP_WIREFRAME);

    opts.fast_preview = FastPreviewType.FP_OFF;
    const opts2 = _roundtrip_options(app, tmp_path);
    expect(opts2.fast_preview).toBe(FastPreviewType.FP_OFF);
  });

  test("test_modify_fast_preview_to_draft", () => {
    const tmp_path = make_tmp_path();
    const [app, opts] = _get_active_app_and_options(SAMPLES_DIR.div("fast_preview_off.aep"));
    opts.fast_preview = FastPreviewType.FP_DRAFT;
    const opts2 = _roundtrip_options(app, tmp_path);
    expect(opts2.fast_preview).toBe(FastPreviewType.FP_DRAFT);
  });

  test("test_modify_fast_preview_to_fast_draft", () => {
    const tmp_path = make_tmp_path();
    const [app, opts] = _get_active_app_and_options(SAMPLES_DIR.div("fast_preview_off.aep"));
    opts.fast_preview = FastPreviewType.FP_FAST_DRAFT;
    const opts2 = _roundtrip_options(app, tmp_path);
    expect(opts2.fast_preview).toBe(FastPreviewType.FP_FAST_DRAFT);
  });
});

describe("TestRoundtripGrid", () => {
  /** Roundtrip tests for ViewOptions.grid. */
  test("test_toggle_grid", () => {
    const tmp_path = make_tmp_path();
    const [app, opts] = _get_active_app_and_options(SAMPLES_DIR.div("grid_off.aep"));
    expect(opts.grid).toBe(false);

    opts.grid = true;
    const opts2 = _roundtrip_options(app, tmp_path);
    expect(opts2.grid).toBe(true);
  });
});

describe("TestRoundtripGuidesLocked", () => {
  /** Roundtrip tests for ViewOptions.guides_locked. */
  test("test_toggle_guides_locked", () => {
    const tmp_path = make_tmp_path();
    const [app, opts] = _get_active_app_and_options(SAMPLES_DIR.div("lock_guides_off.aep"));
    expect(opts.guides_locked).toBe(false);

    opts.guides_locked = true;
    const opts2 = _roundtrip_options(app, tmp_path);
    expect(opts2.guides_locked).toBe(true);
  });
});

describe("TestRoundtripGuidesSnap", () => {
  /** Roundtrip tests for ViewOptions.guides_snap. */
  test("test_toggle_guides_snap", () => {
    const tmp_path = make_tmp_path();
    const [app, opts] = _get_active_app_and_options(SAMPLES_DIR.div("snap_to_guides_off.aep"));
    expect(opts.guides_snap).toBe(false);

    opts.guides_snap = true;
    const opts2 = _roundtrip_options(app, tmp_path);
    expect(opts2.guides_snap).toBe(true);
  });
});

describe("TestRoundtripGuidesVisibility", () => {
  /** Roundtrip tests for ViewOptions.guides_visibility. */
  test("test_toggle_guides_visibility", () => {
    const tmp_path = make_tmp_path();
    const [app, opts] = _get_active_app_and_options(SAMPLES_DIR.div("guides_off.aep"));
    expect(opts.guides_visibility).toBe(false);

    opts.guides_visibility = true;
    const opts2 = _roundtrip_options(app, tmp_path);
    expect(opts2.guides_visibility).toBe(true);
  });
});

describe("TestRoundtripMaskAndShapePath", () => {
  /** Roundtrip tests for ViewOptions.mask_and_shape_path. */
  test("test_toggle_mask_and_shape_path", () => {
    const tmp_path = make_tmp_path();
    const [app, opts] = _get_active_app_and_options(SAMPLES_DIR.div("mask_and_shape_path_off.aep"));
    expect(opts.mask_and_shape_path).toBe(false);

    opts.mask_and_shape_path = true;
    const opts2 = _roundtrip_options(app, tmp_path);
    expect(opts2.mask_and_shape_path).toBe(true);
  });
});

describe("TestRoundtripProportionalGrid", () => {
  /** Roundtrip tests for ViewOptions.proportional_grid. */
  test("test_toggle_proportional_grid", () => {
    const tmp_path = make_tmp_path();
    const [app, opts] = _get_active_app_and_options(SAMPLES_DIR.div("proportional_grid_off.aep"));
    expect(opts.proportional_grid).toBe(false);

    opts.proportional_grid = true;
    const opts2 = _roundtrip_options(app, tmp_path);
    expect(opts2.proportional_grid).toBe(true);
  });
});

describe("TestRoundtripRegionOfInterest", () => {
  /** Roundtrip tests for ViewOptions.region_of_interest. */
  test("test_toggle_region_of_interest", () => {
    const tmp_path = make_tmp_path();
    const [app, opts] = _get_active_app_and_options(SAMPLES_DIR.div("roi_off.aep"));
    expect(opts.region_of_interest).toBe(false);

    opts.region_of_interest = true;
    const opts2 = _roundtrip_options(app, tmp_path);
    expect(opts2.region_of_interest).toBe(true);
  });
});

describe("TestRoundtripRulers", () => {
  /** Roundtrip tests for ViewOptions.rulers. */
  test("test_toggle_rulers", () => {
    const tmp_path = make_tmp_path();
    const [app, opts] = _get_active_app_and_options(SAMPLES_DIR.div("rulers_off.aep"));
    expect(opts.rulers).toBe(false);

    opts.rulers = true;
    const opts2 = _roundtrip_options(app, tmp_path);
    expect(opts2.rulers).toBe(true);
  });
});

describe("TestRoundtripTitleActionSafe", () => {
  /** Roundtrip tests for ViewOptions.title_action_safe. */
  test("test_toggle_title_action_safe", () => {
    const tmp_path = make_tmp_path();
    const [app, opts] = _get_active_app_and_options(SAMPLES_DIR.div("title_action_safe_off.aep"));
    expect(opts.title_action_safe).toBe(false);

    opts.title_action_safe = true;
    const opts2 = _roundtrip_options(app, tmp_path);
    expect(opts2.title_action_safe).toBe(true);
  });
});

describe("TestRoundtripUseDisplayColorManagement", () => {
  /** Roundtrip tests for ViewOptions.use_display_color_management. */
  test("test_toggle_display_color_management", () => {
    const tmp_path = make_tmp_path();
    const [app, opts] = _get_active_app_and_options(
      SAMPLES_DIR.div("channels_use_display_color_management_off.aep"),
    );
    expect(opts.use_display_color_management).toBe(false);

    opts.use_display_color_management = true;
    const opts2 = _roundtrip_options(app, tmp_path);
    expect(opts2.use_display_color_management).toBe(true);
  });
});

describe("TestRoundtripZoom", () => {
  /** Roundtrip tests for ViewOptions.zoom. */
  test("test_modify_zoom", () => {
    const tmp_path = make_tmp_path();
    const [app, opts] = _get_active_app_and_options(SAMPLES_DIR.div("zoom_100.aep"));
    expect(opts.zoom).toBe(1.0);

    opts.zoom = 0.5;
    const opts2 = _roundtrip_options(app, tmp_path);
    expect(isclose(opts2.zoom, 0.5, 0.001)).toBe(true);
  });

  test("test_zoom_validation_rejects_too_high", () => {
    const [_, opts] = _get_active_app_and_options(SAMPLES_DIR.div("zoom_100.aep"));
    raises(
      ValueError,
      () => {
        opts.zoom = 17.0;
      },
      "must be <= 16(\\.0)?",
    );
  });

  test("test_zoom_validation_rejects_too_low", () => {
    const [_, opts] = _get_active_app_and_options(SAMPLES_DIR.div("zoom_100.aep"));
    raises(
      ValueError,
      () => {
        opts.zoom = 0.0;
      },
      "must be >= 0.01",
    );
  });
});

describe("TestRoundtripRoi", () => {
  /** Roundtrip tests for ViewOptions ROI coordinates. */
  test("test_modify_roi_coordinates", () => {
    const tmp_path = make_tmp_path();
    const [app, opts] = _get_active_app_and_options(SAMPLES_DIR.div("roi_base.aep"));
    expect(opts.roi_top).toBe(111);

    opts.roi_top = 50;
    opts.roi_left = 60;
    opts.roi_bottom = 400;
    opts.roi_right = 450;
    const opts2 = _roundtrip_options(app, tmp_path);
    expect(opts2.roi_top).toBe(50);
    expect(opts2.roi_left).toBe(60);
    expect(opts2.roi_bottom).toBe(400);
    expect(opts2.roi_right).toBe(450);
  });
});

describe("TestRoiValidation", () => {
  /** Tests for ROI coordinate validation. */
  test("test_roi_top_rejects_negative", () => {
    const opts = _get_active_view_options(SAMPLES_DIR.div("roi_base.aep"));
    raises(
      ValueError,
      () => {
        opts.roi_top = -1;
      },
      "must be >= 0",
    );
  });

  test("test_roi_left_rejects_negative", () => {
    const opts = _get_active_view_options(SAMPLES_DIR.div("roi_base.aep"));
    raises(
      ValueError,
      () => {
        opts.roi_left = -1;
      },
      "must be >= 0",
    );
  });

  test("test_roi_top_rejects_above_bottom", () => {
    const opts = _get_active_view_options(SAMPLES_DIR.div("roi_base.aep"));
    // roi_bottom is 339, so roi_top must be <= 338
    raises(
      ValueError,
      () => {
        opts.roi_top = 339;
      },
      "must be <= 338",
    );
  });

  test("test_roi_left_rejects_above_right", () => {
    const opts = _get_active_view_options(SAMPLES_DIR.div("roi_base.aep"));
    // roi_right is 366, so roi_left must be <= 365
    raises(
      ValueError,
      () => {
        opts.roi_left = 366;
      },
      "must be <= 365",
    );
  });

  test("test_roi_bottom_rejects_below_top", () => {
    const opts = _get_active_view_options(SAMPLES_DIR.div("roi_base.aep"));
    // roi_top is 111, so roi_bottom must be >= 112
    raises(
      ValueError,
      () => {
        opts.roi_bottom = 111;
      },
      "must be >= 112",
    );
  });

  test("test_roi_right_rejects_below_left", () => {
    const opts = _get_active_view_options(SAMPLES_DIR.div("roi_base.aep"));
    // roi_left is 123, so roi_right must be >= 124
    raises(
      ValueError,
      () => {
        opts.roi_right = 123;
      },
      "must be >= 124",
    );
  });

  test("test_roi_bottom_rejects_above_comp_height", () => {
    const opts = _get_active_view_options(SAMPLES_DIR.div("roi_base.aep"));
    // Comp height is 500
    raises(
      ValueError,
      () => {
        opts.roi_bottom = 501;
      },
      "must be <= 500",
    );
  });

  test("test_roi_right_rejects_above_comp_width", () => {
    const opts = _get_active_view_options(SAMPLES_DIR.div("roi_base.aep"));
    // Comp width is 500
    raises(
      ValueError,
      () => {
        opts.roi_right = 501;
      },
      "must be <= 500",
    );
  });

  test("test_roi_rejects_float", () => {
    const opts = _get_active_view_options(SAMPLES_DIR.div("roi_base.aep"));
    raises(
      TypeError_,
      () => {
        opts.roi_top = 50.5;
      },
      "an integer",
    );
  });

  test("test_roi_accepts_valid_values", () => {
    // Must parse a fresh (uncached) copy: this test writes valid ROI
    // values, and parse_app_fresh is lru_cached for the session, so mutating
    // the shared roi_base.aep app would corrupt the read-only ROI tests
    // (e.g. test_roi_base) when they land on the same xdist worker.
    const [_, opts] = _get_active_app_and_options(SAMPLES_DIR.div("roi_base.aep"));
    opts.roi_top = 0;
    opts.roi_left = 0;
    opts.roi_bottom = 500;
    opts.roi_right = 500;
    expect(opts.roi_top).toBe(0);
    expect(opts.roi_left).toBe(0);
    expect(opts.roi_bottom).toBe(500);
    expect(opts.roi_right).toBe(500);
  });
});
