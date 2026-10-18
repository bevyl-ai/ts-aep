/**
 * Layer specifications for layered-file composition imports.
 *
 * When importing an Illustrator/PDF or Photoshop file as a composition, each
 * source layer becomes a footage item and a comp layer (layer groups become
 * nested compositions). These specs describe that structure as it is discovered
 * from the file, before the chunk tree is built. They are pure data carriers and
 * do not touch the binary layer.
 */

import { pyEq } from "../../pyrt/index.ts";
import type { Shape } from "../models/properties/shape.ts";
import type { PsdLayerStyles } from "../resolvers/psd_styles.ts";

/** One per-layer footage item for a layered-file composition import. */
export class LayerSpec {
  /** Layer name (becomes the footage item and comp-layer name). */
  readonly name: string;

  /** The per-layer `opti` asset-info bytes. */
  readonly opti_data: Uint8Array;

  /** Footage pixel width (full canvas for COMP, content box for cropped). */
  readonly width: number;

  /** Footage pixel height (full canvas for COMP, content box for cropped). */
  readonly height: number;

  /**
   * `((anchor_x, anchor_y), (position_x, position_y))`, or `null` to leave
   * the layer centered by `CompItem.add` (whole-canvas layers).
   */
  readonly transform: readonly [readonly [number, number], readonly [number, number]] | null;

  /**
   * `true` when the footage spans the full source frame; `false` for a layer
   * cropped to its content box.
   */
  readonly full_frame: boolean;

  /** `true` when the comp layer should be marked as an adjustment layer. */
  readonly is_adjustment: boolean;

  /**
   * Photoshop layer id (`lyid`) for the `sspc` layer binding; `null` for
   * sources without one (AI/PDF layers, EPS, flattened documents).
   */
  readonly layer_id: number | null;

  /**
   * 0-based document index of the layer for the `sspc` layer binding;
   * `null` for single-layer documents (EPS, flattened PSD).
   */
  readonly layer_index: number | null;

  /**
   * Cached source data size for `sspc` byte 0xD0 (PSD: content-box pixel
   * bytes; AI/PDF: file size). `0` lets AE re-derive it.
   */
  readonly data_size: number;

  /**
   * Override for the `sspc` 0xC8 kind bytes (PSD layer-styles mode);
   * `null` applies `FileSource._new`'s whole-file rule.
   */
  readonly reserved_c8: Uint8Array | null;

  /**
   * Resolved layer styles to serialize on the comp layer (an
   * editable-layer-styles PSD import); `null` writes the plain skeleton.
   */
  readonly styles: PsdLayerStyles | null;

  /**
   * Mask shapes to create on the comp layer, one mask per shape (a PSD
   * vector mask / shape layer path, one subpath each - AE creates `Mask N`
   * per subpath).
   */
  readonly masks: readonly Shape[];

  /**
   * Set the layer's preserve-transparency switch (a clipped PSD layer
   * inside its auto-precomposed clipping run).
   */
  readonly preserve_transparency: boolean;

  /**
   * The comp layer's video switch. `false` for a source layer the document
   * hides (an Illustrator layer in the file's `/D` `/OFF` array), which AE
   * imports as a layer with its eyeball off.
   */
  readonly enabled: boolean;

  /**
   * A PSD layer's own alpha: `false` for Photoshop's Background layer,
   * which has no transparency. `null` for the layers of other files, which
   * take the file's alpha and depth.
   */
  readonly has_alpha: boolean | null;

  /**
   * A PSD layer's own pixel depth (`sspc` byte 0x3E); `null` with
   * `has_alpha`.
   */
  readonly depth: number | null;

  constructor(
    name: string,
    optiData: Uint8Array,
    width: number,
    height: number,
    transform: readonly [readonly [number, number], readonly [number, number]] | null = null,
    fullFrame: boolean = true,
    isAdjustment: boolean = false,
    layerId: number | null = null,
    layerIndex: number | null = null,
    dataSize: number = 0,
    reservedC8: Uint8Array | null = null,
    styles: PsdLayerStyles | null = null,
    masks: readonly Shape[] = [],
    preserveTransparency: boolean = false,
    enabled: boolean = true,
    hasAlpha: boolean | null = null,
    depth: number | null = null,
  ) {
    this.name = name;
    this.opti_data = optiData;
    this.width = width;
    this.height = height;
    this.transform = transform;
    this.full_frame = fullFrame;
    this.is_adjustment = isAdjustment;
    this.layer_id = layerId;
    this.layer_index = layerIndex;
    this.data_size = dataSize;
    this.reserved_c8 = reservedC8;
    this.styles = styles;
    this.masks = masks;
    this.preserve_transparency = preserveTransparency;
    this.enabled = enabled;
    this.has_alpha = hasAlpha;
    this.depth = depth;
  }

  /** NamedTuple equality: field-wise. */
  equals(other: object | null): boolean {
    return other instanceof LayerSpec && pyEq([...this], [...other]);
  }

  *[Symbol.iterator](): Generator<
    LayerSpec[
      | 'name'
      | 'opti_data'
      | 'width'
      | 'transform'
      | 'full_frame'
      | 'layer_id'
      | 'reserved_c8'
      | 'styles'
      | 'masks'
      | 'has_alpha'
    ]
  > {
    yield this.name;
    yield this.opti_data;
    yield this.width;
    yield this.height;
    yield this.transform;
    yield this.full_frame;
    yield this.is_adjustment;
    yield this.layer_id;
    yield this.layer_index;
    yield this.data_size;
    yield this.reserved_c8;
    yield this.styles;
    yield this.masks;
    yield this.preserve_transparency;
    yield this.enabled;
    yield this.has_alpha;
    yield this.depth;
  }
}

/**
 * A layer group, imported as a nested composition of its children.
 *
 * Also models a PSD clipping run (base layer + the clipped layers above
 * it), which AE auto-precomposes: the run differs from a group only in
 * naming, the uncollapsed parent layer, and the clipped children's
 * preserve-transparency flag (psd_clipping_mask fixture).
 */
export class LayerGroupSpec {
  /** Group name (becomes the nested comp + parent-layer name). */
  readonly name: string;

  /** The group's contents, bottom layer first. */
  readonly children: Array<LayerSpec | LayerGroupSpec>;

  /** Override for the nested comp's item name; `null` uses `name`. A clipping run's precomp is named `"<main comp> (n)"` by AE. */
  readonly comp_name: string | null;

  /**
   * Baked parent-layer display name with `name_set` kept OFF (a
   * clipping run bakes the base layer's name); `null` leaves the name
   * empty so it inherits the nested comp's name (groups).
   */
  readonly layer_name: string | null;

  /** Collapse transformations on the parent layer (groups); clipping precomps stay uncollapsed. */
  readonly collapsed: boolean;

  /**
   * `false` for a group hidden in Photoshop: AE 2026 turns the parent
   * layer's video switch off and leaves the children's own switches as they
   * are (synthetic hidden_group.psd).
   */
  readonly enabled: boolean;

  constructor(
    name: string,
    children: Array<LayerSpec | LayerGroupSpec>,
    compName: string | null = null,
    layerName: string | null = null,
    collapsed: boolean = true,
    enabled: boolean = true,
  ) {
    this.name = name;
    this.children = children;
    this.comp_name = compName;
    this.layer_name = layerName;
    this.collapsed = collapsed;
    this.enabled = enabled;
  }

  /** NamedTuple equality: field-wise. */
  equals(other: object | null): boolean {
    return other instanceof LayerGroupSpec && pyEq([...this], [...other]);
  }

  *[Symbol.iterator](): Generator<
    LayerGroupSpec['name' | 'children' | 'comp_name' | 'collapsed']
  > {
    yield this.name;
    yield this.children;
    yield this.comp_name;
    yield this.layer_name;
    yield this.collapsed;
    yield this.enabled;
  }
}
