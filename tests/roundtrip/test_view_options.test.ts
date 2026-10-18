/**
 * Tests for ViewOptions model parsing using samples from models/view/.
 *
 * These tests verify that py_aep correctly reads viewer panel settings
 * (channels, exposure, zoom, fast preview, toggle flags, etc.) from the
 * `fips` chunks in the binary AEP format.
 *
 * The viewer panel data is accessed via `project.activeViewer`, which
 * represents the focused Composition/Layer/Footage panel. Each panel has
 * one or more `View` objects containing `ViewOptions`.
 */

import { describe, expect, test } from "bun:test";
import { Path, ValueError, isclose, assert } from "../../src/pyrt/index.ts";

import { parseAppFresh } from "../helpers.ts";

import "../../src/py_aep/binary/_register.ts";
import { ChannelType, FastPreviewType, ViewerType, type ViewOptions } from "../../src/py_aep/index.ts";
import { parse as parseAep } from "../../src/py_aep/index.ts";
import type { Application } from "../../src/py_aep/index.ts";
import { makeTmpPath, raises } from "../support/pytest.ts";

// `Path(__file__).parent.parent.parent / ...` in the Python source.
const SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models", "view");

/** Parse a project and return the ViewOptions of the active viewer's first view. */
function _getActiveViewOptions(aepPath: Path): ViewOptions {
  const app = parseAppFresh(aepPath);
  assert(app.activeViewer != null);
  expect(app.activeViewer.type).toBe(ViewerType.VIEWER_COMPOSITION);
  expect(app.activeViewer.views.length >= 1).toBe(true);
  return app.activeViewer.views[0].options;
}

/** Parse a non-cached app and return (app, active view options). */
function _getActiveAppAndOptions(aepPath: Path): [Application, ViewOptions] {
  const app = parseAep(aepPath);
  assert(app.activeViewer != null);
  expect(app.activeViewer.views.length >= 1).toBe(true);
  return [app, app.activeViewer.views[0].options];
}

/** Save the project, re-parse, and return the active view options. */
function _roundtripOptions(app: Application, tmpPath: Path): ViewOptions {
  const out = tmpPath.div("modified.aep");
  app.project.save(out);
  const app2 = parseAep(out);
  assert(app2.activeViewer != null);
  expect(app2.activeViewer.views.length >= 1).toBe(true);
  return app2.activeViewer.views[0].options;
}

describe("TestViewActive", () => {
  /** The first view should be active by default. */
  test("test_first_view_active_by_default", () => {
    const app = parseAppFresh(SAMPLES_DIR.div("roi_base.aep"));
    assert(app.activeViewer != null);
    expect(app.activeViewer.views[0].active).toBe(true);
  });

  /** set_active() should update the viewer's active_view_index. */
  test("test_set_active_changes_index", () => {
    const app = parseAppFresh(SAMPLES_DIR.div("roi_left_viewer.aep"));
    assert(app.activeViewer != null);
    const viewer = app.activeViewer;
    expect(viewer.views.length).toBe(2);
    expect(viewer.activeViewIndex).toBe(0);
    expect(viewer.views[0].active).toBe(true);
    expect(viewer.views[1].active).toBe(false);

    viewer.views[1].setActive();
    expect(viewer.activeViewIndex).toBe(1);
    expect(viewer.views[0].active).toBe(false);
    expect(viewer.views[1].active).toBe(true);
  });

  /** Setting an invalid active_view_index should raise ValueError. */
  test("test_active_view_index_setter_validation", () => {
    const app = parseAppFresh(SAMPLES_DIR.div("roi_base.aep"));
    assert(app.activeViewer != null);
    const viewer = app.activeViewer;
    raises(ValueError, () => {
      viewer.activeViewIndex = 99;
    });
  });
});

describe("TestRoundtripChannels", () => {
  /** Roundtrip tests for ViewOptions.channels. */
  test("test_modify_channels", () => {
    const tmpPath = makeTmpPath();
    const [app, opts] = _getActiveAppAndOptions(SAMPLES_DIR.div("channels_rgb.aep"));
    expect(opts.channels).toBe(ChannelType.CHANNEL_RGB);

    opts.channels = ChannelType.CHANNEL_ALPHA;
    const opts2 = _roundtripOptions(app, tmpPath);
    expect(opts2.channels).toBe(ChannelType.CHANNEL_ALPHA);
  });
});

describe("TestRoundtripCheckerboards", () => {
  /** Roundtrip tests for ViewOptions.checkerboards. */
  test("test_toggle_checkerboards", () => {
    const tmpPath = makeTmpPath();
    const [app, opts] = _getActiveAppAndOptions(SAMPLES_DIR.div("transparency_grid_off.aep"));
    expect(opts.checkerboards).toBe(false);

    opts.checkerboards = true;
    const opts2 = _roundtripOptions(app, tmpPath);
    expect(opts2.checkerboards).toBe(true);
  });
});

describe("TestRoundtripDraft3d", () => {
  /** Roundtrip tests for ViewOptions.draft3d. */
  test("test_toggle_draft3d", () => {
    const tmpPath = makeTmpPath();
    const [app, opts] = _getActiveAppAndOptions(SAMPLES_DIR.div("draft3d_false.aep"));
    expect(opts.draft3d).toBe(false);

    opts.draft3d = true;
    const opts2 = _roundtripOptions(app, tmpPath);
    expect(opts2.draft3d).toBe(true);
  });
});

describe("TestRoundtripExposure", () => {
  /** Roundtrip tests for ViewOptions.exposure. */
  test("test_modify_exposure", () => {
    const tmpPath = makeTmpPath();
    const [app, opts] = _getActiveAppAndOptions(SAMPLES_DIR.div("exposure_0.0.aep"));
    expect(opts.exposure).toBe(0.0);

    opts.exposure = 5.5;
    const opts2 = _roundtripOptions(app, tmpPath);
    expect(isclose(opts2.exposure, 5.5, undefined, 0.01)).toBe(true);
  });

  test("test_exposure_validation_rejects_too_high", () => {
    const [_, opts] = _getActiveAppAndOptions(SAMPLES_DIR.div("exposure_0.0.aep"));
    raises(
      ValueError,
      () => {
        opts.exposure = 41.0;
      },
      "must be <= 40(\\.0)?",
    );
  });

  test("test_exposure_validation_rejects_too_low", () => {
    const [_, opts] = _getActiveAppAndOptions(SAMPLES_DIR.div("exposure_0.0.aep"));
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
  /** Roundtrip tests for ViewOptions.fastPreview. */
  test("test_modify_fast_preview_to_wireframe", () => {
    const tmpPath = makeTmpPath();
    const [app, opts] = _getActiveAppAndOptions(SAMPLES_DIR.div("fast_preview_off.aep"));
    expect(opts.fastPreview).toBe(FastPreviewType.FP_OFF);

    opts.fastPreview = FastPreviewType.FP_WIREFRAME;
    const opts2 = _roundtripOptions(app, tmpPath);
    expect(opts2.fastPreview).toBe(FastPreviewType.FP_WIREFRAME);
  });

  test("test_modify_fast_preview_to_adaptive", () => {
    const tmpPath = makeTmpPath();
    const [app, opts] = _getActiveAppAndOptions(SAMPLES_DIR.div("fast_preview_off.aep"));
    opts.fastPreview = FastPreviewType.FP_ADAPTIVE_RESOLUTION;
    const opts2 = _roundtripOptions(app, tmpPath);
    expect(opts2.fastPreview).toBe(FastPreviewType.FP_ADAPTIVE_RESOLUTION);
  });

  test("test_modify_fast_preview_to_off", () => {
    const tmpPath = makeTmpPath();
    const [app, opts] = _getActiveAppAndOptions(SAMPLES_DIR.div("fast_preview_wireframe.aep"));
    expect(opts.fastPreview).toBe(FastPreviewType.FP_WIREFRAME);

    opts.fastPreview = FastPreviewType.FP_OFF;
    const opts2 = _roundtripOptions(app, tmpPath);
    expect(opts2.fastPreview).toBe(FastPreviewType.FP_OFF);
  });

  test("test_modify_fast_preview_to_draft", () => {
    const tmpPath = makeTmpPath();
    const [app, opts] = _getActiveAppAndOptions(SAMPLES_DIR.div("fast_preview_off.aep"));
    opts.fastPreview = FastPreviewType.FP_DRAFT;
    const opts2 = _roundtripOptions(app, tmpPath);
    expect(opts2.fastPreview).toBe(FastPreviewType.FP_DRAFT);
  });

  test("test_modify_fast_preview_to_fast_draft", () => {
    const tmpPath = makeTmpPath();
    const [app, opts] = _getActiveAppAndOptions(SAMPLES_DIR.div("fast_preview_off.aep"));
    opts.fastPreview = FastPreviewType.FP_FAST_DRAFT;
    const opts2 = _roundtripOptions(app, tmpPath);
    expect(opts2.fastPreview).toBe(FastPreviewType.FP_FAST_DRAFT);
  });
});

describe("TestRoundtripGrid", () => {
  /** Roundtrip tests for ViewOptions.grid. */
  test("test_toggle_grid", () => {
    const tmpPath = makeTmpPath();
    const [app, opts] = _getActiveAppAndOptions(SAMPLES_DIR.div("grid_off.aep"));
    expect(opts.grid).toBe(false);

    opts.grid = true;
    const opts2 = _roundtripOptions(app, tmpPath);
    expect(opts2.grid).toBe(true);
  });
});

describe("TestRoundtripGuidesLocked", () => {
  /** Roundtrip tests for ViewOptions.guidesLocked. */
  test("test_toggle_guides_locked", () => {
    const tmpPath = makeTmpPath();
    const [app, opts] = _getActiveAppAndOptions(SAMPLES_DIR.div("lock_guides_off.aep"));
    expect(opts.guidesLocked).toBe(false);

    opts.guidesLocked = true;
    const opts2 = _roundtripOptions(app, tmpPath);
    expect(opts2.guidesLocked).toBe(true);
  });
});

describe("TestRoundtripGuidesSnap", () => {
  /** Roundtrip tests for ViewOptions.guidesSnap. */
  test("test_toggle_guides_snap", () => {
    const tmpPath = makeTmpPath();
    const [app, opts] = _getActiveAppAndOptions(SAMPLES_DIR.div("snap_to_guides_off.aep"));
    expect(opts.guidesSnap).toBe(false);

    opts.guidesSnap = true;
    const opts2 = _roundtripOptions(app, tmpPath);
    expect(opts2.guidesSnap).toBe(true);
  });
});

describe("TestRoundtripGuidesVisibility", () => {
  /** Roundtrip tests for ViewOptions.guidesVisibility. */
  test("test_toggle_guides_visibility", () => {
    const tmpPath = makeTmpPath();
    const [app, opts] = _getActiveAppAndOptions(SAMPLES_DIR.div("guides_off.aep"));
    expect(opts.guidesVisibility).toBe(false);

    opts.guidesVisibility = true;
    const opts2 = _roundtripOptions(app, tmpPath);
    expect(opts2.guidesVisibility).toBe(true);
  });
});

describe("TestRoundtripMaskAndShapePath", () => {
  /** Roundtrip tests for ViewOptions.maskAndShapePath. */
  test("test_toggle_mask_and_shape_path", () => {
    const tmpPath = makeTmpPath();
    const [app, opts] = _getActiveAppAndOptions(SAMPLES_DIR.div("mask_and_shape_path_off.aep"));
    expect(opts.maskAndShapePath).toBe(false);

    opts.maskAndShapePath = true;
    const opts2 = _roundtripOptions(app, tmpPath);
    expect(opts2.maskAndShapePath).toBe(true);
  });
});

describe("TestRoundtripProportionalGrid", () => {
  /** Roundtrip tests for ViewOptions.proportionalGrid. */
  test("test_toggle_proportional_grid", () => {
    const tmpPath = makeTmpPath();
    const [app, opts] = _getActiveAppAndOptions(SAMPLES_DIR.div("proportional_grid_off.aep"));
    expect(opts.proportionalGrid).toBe(false);

    opts.proportionalGrid = true;
    const opts2 = _roundtripOptions(app, tmpPath);
    expect(opts2.proportionalGrid).toBe(true);
  });
});

describe("TestRoundtripRegionOfInterest", () => {
  /** Roundtrip tests for ViewOptions.regionOfInterest. */
  test("test_toggle_region_of_interest", () => {
    const tmpPath = makeTmpPath();
    const [app, opts] = _getActiveAppAndOptions(SAMPLES_DIR.div("roi_off.aep"));
    expect(opts.regionOfInterest).toBe(false);

    opts.regionOfInterest = true;
    const opts2 = _roundtripOptions(app, tmpPath);
    expect(opts2.regionOfInterest).toBe(true);
  });
});

describe("TestRoundtripRulers", () => {
  /** Roundtrip tests for ViewOptions.rulers. */
  test("test_toggle_rulers", () => {
    const tmpPath = makeTmpPath();
    const [app, opts] = _getActiveAppAndOptions(SAMPLES_DIR.div("rulers_off.aep"));
    expect(opts.rulers).toBe(false);

    opts.rulers = true;
    const opts2 = _roundtripOptions(app, tmpPath);
    expect(opts2.rulers).toBe(true);
  });
});

describe("TestRoundtripTitleActionSafe", () => {
  /** Roundtrip tests for ViewOptions.titleActionSafe. */
  test("test_toggle_title_action_safe", () => {
    const tmpPath = makeTmpPath();
    const [app, opts] = _getActiveAppAndOptions(SAMPLES_DIR.div("title_action_safe_off.aep"));
    expect(opts.titleActionSafe).toBe(false);

    opts.titleActionSafe = true;
    const opts2 = _roundtripOptions(app, tmpPath);
    expect(opts2.titleActionSafe).toBe(true);
  });
});

describe("TestRoundtripUseDisplayColorManagement", () => {
  /** Roundtrip tests for ViewOptions.useDisplayColorManagement. */
  test("test_toggle_display_color_management", () => {
    const tmpPath = makeTmpPath();
    const [app, opts] = _getActiveAppAndOptions(SAMPLES_DIR.div("channels_use_display_color_management_off.aep"));
    expect(opts.useDisplayColorManagement).toBe(false);

    opts.useDisplayColorManagement = true;
    const opts2 = _roundtripOptions(app, tmpPath);
    expect(opts2.useDisplayColorManagement).toBe(true);
  });
});

describe("TestRoundtripZoom", () => {
  /** Roundtrip tests for ViewOptions.zoom. */
  test("test_modify_zoom", () => {
    const tmpPath = makeTmpPath();
    const [app, opts] = _getActiveAppAndOptions(SAMPLES_DIR.div("zoom_100.aep"));
    expect(opts.zoom).toBe(1.0);

    opts.zoom = 0.5;
    const opts2 = _roundtripOptions(app, tmpPath);
    expect(isclose(opts2.zoom, 0.5, 0.001)).toBe(true);
  });

  test("test_zoom_validation_rejects_too_high", () => {
    const [_, opts] = _getActiveAppAndOptions(SAMPLES_DIR.div("zoom_100.aep"));
    raises(
      ValueError,
      () => {
        opts.zoom = 17.0;
      },
      "must be <= 16(\\.0)?",
    );
  });

  test("test_zoom_validation_rejects_too_low", () => {
    const [_, opts] = _getActiveAppAndOptions(SAMPLES_DIR.div("zoom_100.aep"));
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
    const tmpPath = makeTmpPath();
    const [app, opts] = _getActiveAppAndOptions(SAMPLES_DIR.div("roi_base.aep"));
    expect(opts.roiTop).toBe(111);

    opts.roiTop = 50;
    opts.roiLeft = 60;
    opts.roiBottom = 400;
    opts.roiRight = 450;
    const opts2 = _roundtripOptions(app, tmpPath);
    expect(opts2.roiTop).toBe(50);
    expect(opts2.roiLeft).toBe(60);
    expect(opts2.roiBottom).toBe(400);
    expect(opts2.roiRight).toBe(450);
  });
});

describe("TestRoiValidation", () => {
  /** Tests for ROI coordinate validation. */
  test("test_roi_top_rejects_negative", () => {
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("roi_base.aep"));
    raises(
      ValueError,
      () => {
        opts.roiTop = -1;
      },
      "must be >= 0",
    );
  });

  test("test_roi_left_rejects_negative", () => {
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("roi_base.aep"));
    raises(
      ValueError,
      () => {
        opts.roiLeft = -1;
      },
      "must be >= 0",
    );
  });

  test("test_roi_top_rejects_above_bottom", () => {
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("roi_base.aep"));
    // roi_bottom is 339, so roi_top must be <= 338
    raises(
      ValueError,
      () => {
        opts.roiTop = 339;
      },
      "must be <= 338",
    );
  });

  test("test_roi_left_rejects_above_right", () => {
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("roi_base.aep"));
    // roi_right is 366, so roi_left must be <= 365
    raises(
      ValueError,
      () => {
        opts.roiLeft = 366;
      },
      "must be <= 365",
    );
  });

  test("test_roi_bottom_rejects_below_top", () => {
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("roi_base.aep"));
    // roi_top is 111, so roi_bottom must be >= 112
    raises(
      ValueError,
      () => {
        opts.roiBottom = 111;
      },
      "must be >= 112",
    );
  });

  test("test_roi_right_rejects_below_left", () => {
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("roi_base.aep"));
    // roi_left is 123, so roi_right must be >= 124
    raises(
      ValueError,
      () => {
        opts.roiRight = 123;
      },
      "must be >= 124",
    );
  });

  test("test_roi_bottom_rejects_above_comp_height", () => {
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("roi_base.aep"));
    // Comp height is 500
    raises(
      ValueError,
      () => {
        opts.roiBottom = 501;
      },
      "must be <= 500",
    );
  });

  test("test_roi_right_rejects_above_comp_width", () => {
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("roi_base.aep"));
    // Comp width is 500
    raises(
      ValueError,
      () => {
        opts.roiRight = 501;
      },
      "must be <= 500",
    );
  });

  test("test_roi_rejects_float", () => {
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("roi_base.aep"));
    raises(
      TypeError,
      () => {
        opts.roiTop = 50.5;
      },
      "an integer",
    );
  });

  test("test_roi_accepts_valid_values", () => {
    // Must parse a fresh (uncached) copy: this test writes valid ROI
    // values, and parse_app_fresh is lru_cached for the session, so mutating
    // the shared roi_base.aep app would corrupt the read-only ROI tests
    // (e.g. test_roi_base) when they land on the same xdist worker.
    const [_, opts] = _getActiveAppAndOptions(SAMPLES_DIR.div("roi_base.aep"));
    opts.roiTop = 0;
    opts.roiLeft = 0;
    opts.roiBottom = 500;
    opts.roiRight = 500;
    expect(opts.roiTop).toBe(0);
    expect(opts.roiLeft).toBe(0);
    expect(opts.roiBottom).toBe(500);
    expect(opts.roiRight).toBe(500);
  });
});
