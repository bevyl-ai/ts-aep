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
import { Path, assert } from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { ChannelType, FastPreviewType, ViewerType } from "../../src/py_aep/index.ts";
import type { ViewOptions } from "../../src/py_aep/index.ts";
import { parseApp } from "../conftest.ts";

// `from __future__ import annotations` and the `TYPE_CHECKING: pass` block are
// Python-only and dropped.

const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "view");

/** Parse a project and return the ViewOptions of the active viewer's first view. */
function _getActiveViewOptions(aepPath: Path): ViewOptions {
  const app = parseApp(aepPath);
  assert(app.activeViewer != null);
  expect(app.activeViewer.type === ViewerType.VIEWER_COMPOSITION).toBe(true);
  expect(app.activeViewer.views.length >= 1).toBe(true);
  return app.activeViewer.views[0].options;
}

/** Tests for ViewOptions.channels attribute. */
describe("TestViewOptionsChannels", () => {
  test("test_channels_rgb", () => {
    /** Test RGB channel display mode (default). */
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("channels_rgb.aep"));
    expect(opts.channels).toBe(ChannelType.CHANNEL_RGB);
  });

  test("test_channels_alpha", () => {
    /** Test Alpha channel display mode. */
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("channels_alpha.aep"));
    expect(opts.channels).toBe(ChannelType.CHANNEL_ALPHA);
  });
});

/** Tests for ViewOptions.checkerboards (transparency grid) attribute. */
describe("TestViewOptionsCheckerboards", () => {
  test("test_transparency_grid_on", () => {
    /** Test transparency grid enabled. */
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("transparency_grid_on.aep"));
    expect(opts.checkerboards).toBe(true);
  });

  test("test_transparency_grid_off", () => {
    /** Test transparency grid disabled. */
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("transparency_grid_off.aep"));
    expect(opts.checkerboards).toBe(false);
  });
});

/** Tests for ViewOptions.exposure attribute. */
describe("TestViewOptionsExposure", () => {
  test("test_exposure_zero", () => {
    /** Test exposure of 0.0 (no adjustment). */
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("exposure_0.0.aep"));
    expect(opts.exposure).toBe(0.0);
  });

  test("test_exposure_min", () => {
    /** Test minimum exposure of -40.0. */
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("exposure_-40.0.aep"));
    expect(opts.exposure).toBe(-40.0);
  });
});

/** Tests for ViewOptions.fastPreview attribute. */
describe("TestViewOptionsFastPreview", () => {
  test("test_fast_preview_off", () => {
    /** Test fast preview off. */
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("fast_preview_off.aep"));
    expect(opts.fastPreview).toBe(FastPreviewType.FP_OFF);
  });

  test("test_fast_preview_wireframe", () => {
    /** Test wireframe fast preview mode. */
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("fast_preview_wireframe.aep"));
    expect(opts.fastPreview).toBe(FastPreviewType.FP_WIREFRAME);
  });
});

/** Tests for ViewOptions.grid attribute. */
describe("TestViewOptionsGrid", () => {
  test("test_grid_on", () => {
    /** Test grid overlay enabled. */
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("grid_on.aep"));
    expect(opts.grid).toBe(true);
  });

  test("test_grid_off", () => {
    /** Test grid overlay disabled. */
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("grid_off.aep"));
    expect(opts.grid).toBe(false);
  });
});

/** Tests for ViewOptions.guidesVisibility attribute. */
describe("TestViewOptionsGuidesVisibility", () => {
  test("test_guides_on", () => {
    /** Test guides visible. */
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("guides_on.aep"));
    expect(opts.guidesVisibility).toBe(true);
  });

  test("test_guides_off", () => {
    /** Test guides hidden. */
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("guides_off.aep"));
    expect(opts.guidesVisibility).toBe(false);
  });
});

/** Tests for ViewOptions.maskAndShapePath attribute. */
describe("TestViewOptionsMaskAndShapePath", () => {
  test("test_mask_and_shape_path_on", () => {
    /** Test mask and shape path visibility enabled. */
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("mask_and_shape_path_on.aep"));
    expect(opts.maskAndShapePath).toBe(true);
  });

  test("test_mask_and_shape_path_off", () => {
    /** Test mask and shape path visibility disabled. */
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("mask_and_shape_path_off.aep"));
    expect(opts.maskAndShapePath).toBe(false);
  });
});

/** Tests for ViewOptions.proportionalGrid attribute. */
describe("TestViewOptionsProportionalGrid", () => {
  test("test_proportional_grid_on", () => {
    /** Test proportional grid enabled. */
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("proportional_grid_on.aep"));
    expect(opts.proportionalGrid).toBe(true);
  });

  test("test_proportional_grid_off", () => {
    /** Test proportional grid disabled. */
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("proportional_grid_off.aep"));
    expect(opts.proportionalGrid).toBe(false);
  });
});

/** Tests for ViewOptions.rulers attribute. */
describe("TestViewOptionsRulers", () => {
  test("test_rulers_on", () => {
    /** Test rulers displayed. */
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("rulers_on.aep"));
    expect(opts.rulers).toBe(true);
  });

  test("test_rulers_off", () => {
    /** Test rulers hidden. */
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("rulers_off.aep"));
    expect(opts.rulers).toBe(false);
  });
});

/** Tests for ViewOptions.titleActionSafe attribute. */
describe("TestViewOptionsTitleActionSafe", () => {
  test("test_title_action_safe_on", () => {
    /** Test title/action safe guides displayed. */
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("title_action_safe_on.aep"));
    expect(opts.titleActionSafe).toBe(true);
  });

  test("test_title_action_safe_off", () => {
    /** Test title/action safe guides hidden. */
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("title_action_safe_off.aep"));
    expect(opts.titleActionSafe).toBe(false);
  });
});

/** Tests for ViewOptions.useDisplayColorManagement attribute. */
describe("TestViewOptionsUseDisplayColorManagement", () => {
  test("test_display_color_management_on", () => {
    /** Test display color management enabled (default). */
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("channels_rgb.aep"));
    expect(opts.useDisplayColorManagement).toBe(true);
  });

  test("test_display_color_management_off", () => {
    /** Test display color management disabled. */
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("channels_use_display_color_management_off.aep"));
    expect(opts.useDisplayColorManagement).toBe(false);
  });
});

/** Tests for ViewOptions.zoom attribute. */
describe("TestViewOptionsZoom", () => {
  test("test_zoom_25", () => {
    /** Test 25% zoom level. */
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("zoom_25.aep"));
    expect(opts.zoom).toBe(0.25);
  });

  test("test_zoom_100", () => {
    /** Test 100% zoom level. */
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("zoom_100.aep"));
    expect(opts.zoom).toBe(1.0);
  });
});

/** Tests for ViewOptions ROI coordinate attributes. */
describe("TestViewOptionsRoi", () => {
  test("test_roi_base", () => {
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("roi_base.aep"));
    expect(opts.roiTop).toBe(111);
    expect(opts.roiLeft).toBe(123);
    expect(opts.roiBottom).toBe(339);
    expect(opts.roiRight).toBe(366);
  });

  test("test_roi_right_extended", () => {
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("roi_right.aep"));
    expect(opts.roiTop).toBe(111);
    expect(opts.roiLeft).toBe(123);
    expect(opts.roiBottom).toBe(339);
    expect(opts.roiRight).toBe(438);
  });

  test("test_roi_left_extended", () => {
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("roi_left.aep"));
    expect(opts.roiTop).toBe(111);
    expect(opts.roiLeft).toBe(60);
    expect(opts.roiBottom).toBe(339);
    expect(opts.roiRight).toBe(366);
  });

  test("test_roi_down_extended", () => {
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("roi_down.aep"));
    expect(opts.roiTop).toBe(111);
    expect(opts.roiLeft).toBe(123);
    expect(opts.roiBottom).toBe(393);
    expect(opts.roiRight).toBe(366);
  });

  test("test_roi_full", () => {
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("roi_full.aep"));
    expect(opts.roiTop).toBe(9);
    expect(opts.roiLeft).toBe(6);
    expect(opts.roiBottom).toBe(498);
    expect(opts.roiRight).toBe(495);
  });

  test("test_roi_on_zeroed", () => {
    /** ROI enabled but coordinates are all zero. */
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("roi_on.aep"));
    expect(opts.regionOfInterest).toBe(true);
    expect(opts.roiTop).toBe(0);
    expect(opts.roiLeft).toBe(0);
    expect(opts.roiBottom).toBe(0);
    expect(opts.roiRight).toBe(0);
  });

  test("test_roi_off_zeroed", () => {
    /** ROI disabled, coordinates are all zero. */
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("roi_off.aep"));
    expect(opts.regionOfInterest).toBe(false);
    expect(opts.roiTop).toBe(0);
    expect(opts.roiLeft).toBe(0);
    expect(opts.roiBottom).toBe(0);
    expect(opts.roiRight).toBe(0);
  });
});

/** Tests for ViewOptions.guidesSnap attribute. */
describe("TestViewOptionsGuidesSnap", () => {
  test("test_snap_to_guides_on", () => {
    /** Test snap to guides enabled. */
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("snap_to_guides_on.aep"));
    expect(opts.guidesSnap).toBe(true);
  });

  test("test_snap_to_guides_off", () => {
    /** Test snap to guides disabled. */
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("snap_to_guides_off.aep"));
    expect(opts.guidesSnap).toBe(false);
  });
});

/** Tests for ViewOptions.guidesLocked attribute. */
describe("TestViewOptionsGuidesLocked", () => {
  test("test_lock_guides_on", () => {
    /** Test lock guides enabled. */
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("lock_guides_on.aep"));
    expect(opts.guidesLocked).toBe(true);
  });

  test("test_lock_guides_off", () => {
    /** Test lock guides disabled. */
    const opts = _getActiveViewOptions(SAMPLES_DIR.div("lock_guides_off.aep"));
    expect(opts.guidesLocked).toBe(false);
  });
});
