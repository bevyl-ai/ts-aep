import { ChannelType, FastPreviewType } from "../../enums/index.ts";
import { ChunkField } from "../descriptors.ts";
import { _validate_number } from "../validators.ts";
import { descriptor } from "../../../pyrt/index.ts";
import type { FipsChunk } from "../../binary/misc_chunks.ts";
import type { AVItem } from "../items/av_item.ts";

/**
 * The `ViewOptions` object represents the options for a given {@link View} object.
 *
 * ```ts
 * import { parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const options = app.activeViewer.views[0].options;
 * console.log(options.zoom);
 * ```
 *
 * @example
 * @see https://ae-scripting.docsforadobe.dev/other/viewoptions/
 */
export class ViewOptions {
  /**
   * The state of the Channels menu. Read / Write.
   */
  declare channels: ChannelType;

  /**
   * When `true`, checkerboards (transparency grid) is enabled in the current view.
   * Read / Write.
   */
  declare checkerboards: boolean;

  /**
   * When `true`, Draft 3D mode is enabled for the Composition panel. This
   * corresponds to the value of the Draft 3D button in the Composition panel.
   * Read / Write.
   */
  declare draft3d: boolean;

  /**
   * The exposure value for the current view. Read / Write.
   */
  declare exposure: number;

  /** When `true`, the grid overlay is visible in the view. Read / Write. */
  declare grid: boolean;

  /** When `true`, indicates guides are locked in the view. Read / Write. */
  declare guidesLocked: boolean;

  /**
   * When `true`, indicates layers snap to guides when dragged in the view.
   * Read / Write.
   */
  declare guidesSnap: boolean;

  /**
   * When `true`, indicates guides are visible in the view. Read / Write.
   */
  declare guidesVisibility: boolean;

  /**
   * When `true`, indicates mask and shape paths are visible in the view.
   * Read / Write.
   */
  declare maskAndShapePath: boolean;

  /**
   * When `true`, indicates the proportional grid overlay is visible in the
   * view. Read / Write.
   */
  declare proportionalGrid: boolean;

  /**
   * When `true`, the region of interest (ROI) selection is active in the view.
   * Read / Write.
   */
  declare regionOfInterest: boolean;

  /** Top coordinate of the region of interest in pixels. Read / Write. */
  declare roiTop: number;

  /** Left coordinate of the region of interest in pixels. Read / Write. */
  declare roiLeft: number;

  /** Bottom coordinate of the region of interest in pixels. Read / Write. */
  declare roiBottom: number;

  /** Right coordinate of the region of interest in pixels. Read / Write. */
  declare roiRight: number;

  /** When `true`, indicates rulers are shown in the view. Read / Write. */
  declare rulers: boolean;

  /**
   * When `true`, indicates title/action safe margin guides are visible in the
   * view. Read / Write.
   */
  declare titleActionSafe: boolean;

  /**
   * When `true`, indicates display color management is enabled for the view.
   * Read / Write.
   */
  declare useDisplayColorManagement: boolean;

  /**
   * The current zoom value for the view, as a normalized percentage between 1%
   * (0.01) and 1600% (16). Read / Write.
   */
  declare zoom: number;

  /** The state of the Fast Previews menu. Read / Write. */
  declare fastPreview: FastPreviewType;

  declare _fips: FipsChunk;
  declare _item: AVItem | null;

  constructor(kw: { _fips: FipsChunk; _item?: AVItem | null }) {
    const { _fips, _item = null } = kw;
    this._fips = _fips;
    this._item = _item;
  }
}

descriptor(ViewOptions, "channels", ChunkField.enum(ChannelType, "_fips", "channels"));

descriptor(ViewOptions, "checkerboards", ChunkField.bool("_fips", "checkerboards"));

descriptor(ViewOptions, "draft3d", ChunkField.bool("_fips", "draft3d"));

descriptor(
  ViewOptions,
  "exposure",
  new ChunkField("_fips", "exposure", {
    validate: _validate_number({ min: -40.0, max: 40.0 }),
  }),
);

descriptor(ViewOptions, "grid", ChunkField.bool("_fips", "grid"));

descriptor(ViewOptions, "guidesLocked", ChunkField.bool("_fips", "guides_locked", { min_version: 16 }));

descriptor(ViewOptions, "guidesSnap", ChunkField.bool("_fips", "guides_snap", { min_version: 16 }));

descriptor(
  ViewOptions,
  "guidesVisibility",
  ChunkField.bool("_fips", "guides_visibility", { min_version: 16 }),
);

descriptor(ViewOptions, "maskAndShapePath", ChunkField.bool("_fips", "mask_and_shape_path"));

descriptor(ViewOptions, "proportionalGrid", ChunkField.bool("_fips", "proportional_grid"));

descriptor(ViewOptions, "regionOfInterest", ChunkField.bool("_fips", "region_of_interest"));

descriptor(
  ViewOptions,
  "roiTop",
  new ChunkField("_fips", "roi_top", {
    validate: _validate_number({
      min: 0,
      max: (self: ViewOptions) => self.roiBottom - 1,
      integer: true,
    }),
  }),
);

descriptor(
  ViewOptions,
  "roiLeft",
  new ChunkField("_fips", "roi_left", {
    validate: _validate_number({
      min: 0,
      max: (self: ViewOptions) => self.roiRight - 1,
      integer: true,
    }),
  }),
);

descriptor(
  ViewOptions,
  "roiBottom",
  new ChunkField("_fips", "roi_bottom", {
    validate: _validate_number({
      min: (self: ViewOptions) => self.roiTop + 1,
      max: (self: ViewOptions) => (self._item ? self._item.height : null),
      integer: true,
    }),
  }),
);

descriptor(
  ViewOptions,
  "roiRight",
  new ChunkField("_fips", "roi_right", {
    validate: _validate_number({
      min: (self: ViewOptions) => self.roiLeft + 1,
      max: (self: ViewOptions) => (self._item ? self._item.width : null),
      integer: true,
    }),
  }),
);

descriptor(ViewOptions, "rulers", ChunkField.bool("_fips", "rulers", { min_version: 16 }));

descriptor(ViewOptions, "titleActionSafe", ChunkField.bool("_fips", "title_action_safe"));

descriptor(
  ViewOptions,
  "useDisplayColorManagement",
  ChunkField.bool("_fips", "use_display_color_management"),
);

descriptor(
  ViewOptions,
  "zoom",
  new ChunkField("_fips", "zoom", {
    validate: _validate_number({ min: 0.01, max: 16.0 }),
  }),
);

descriptor(
  ViewOptions,
  "fastPreview",
  ChunkField.enum(FastPreviewType, "_fips", "fast_preview_type", { min_version: 12 }),
);
