/**
 * Enumerate the layers of a Photoshop (PSD/PSB) file as a group tree.
 *
 * After Effects imports a layered `.psd`/`.psb` as a composition with one footage
 * layer per Photoshop layer, and each layer group as a nested composition. The
 * layers come from the file's Layer and Mask Information section, stored bottom
 * layer first. A group spans a hidden bounding divider (`lsct` 3) at its bottom
 * and an open/closed folder header (`lsct` 1/2, carrying the group name) at its
 * top. `read_psd_layers` returns the reconstructed tree of leaf layers and groups.
 */

import * as zlib from "../../pyrt/zlib.ts";

import {
  BytesIO,
  Path,
  and,
  at,
  b,
  bytes_,
  bytes_eq,
  decode,
  floordiv,
  IndexError,
  py_eq,
  py_slice,
  repr,
  rstrip,
  struct,
  StructError,
  sum,
  UnicodeDecodeError,
  ValueError,
  warn,
  type PathLike,
} from "../../pyrt/index.ts";
import { PSB_8BYTE_KEYS as _PSB_8BYTE_KEYS, psd_layer_record_count, read_bounded } from "./media_probe.ts";

/** Raised when a `.psd`/`.psb` file's layers cannot be enumerated. */
export class UnsupportedPsdLayersError extends ValueError {}

/**
 * Raised when a `.psd`/`.psb` is flattened (has no layer records).
 *
 * A subclass of {@link UnsupportedPsdLayersError} so callers can tell a flattened
 * document (which can still be imported as a single-layer composition) apart
 * from an invalid file.
 */
export class FlattenedPsdError extends UnsupportedPsdLayersError {}

/**
 * Raw per-layer style-related tagged blocks, for `resolvers.psd_styles`.
 *
 * Kept as raw bytes so enumerating layers stays cheap; the effects
 * descriptor is only parsed when styles are actually imported.
 */
export class PsdStyleBlocks {
  /**
   * The effects descriptor block body (`lmfx` when present, else `lfx2`;
   * `lfxs` for a group header). `null` when the layer carries blend-options
   * blocks (`iOpa`/`infx`/`brst`) but no styles - Photoshop's Fill slider
   * is independent of layer styles, and AE imports it either way.
   */
  readonly effects: Uint8Array | null;

  /** `iOpa` fill opacity byte (0-255), or `null` when absent. */
  readonly fill_opacity: number | null;

  /** `infx` "Blend Interior Effects as Group" flag, or `null` when absent. */
  readonly blend_interior: boolean | null;

  /** `brst` channel-restrictions block body (empty when absent). */
  readonly channel_restrictions: Uint8Array;

  constructor(
    effects: Uint8Array | null,
    fill_opacity: number | null,
    blend_interior: boolean | null,
    channel_restrictions: Uint8Array,
  ) {
    this.effects = effects;
    this.fill_opacity = fill_opacity;
    this.blend_interior = blend_interior;
    this.channel_restrictions = channel_restrictions;
  }

  *[Symbol.iterator]() {
    yield this.effects;
    yield this.fill_opacity;
    yield this.blend_interior;
    yield this.channel_restrictions;
  }

  static readonly _fields = ["effects", "fill_opacity", "blend_interior", "channel_restrictions"] as const satisfies readonly (keyof PsdStyleBlocks)[];

  /** `t._replace(field=...)`: a copy with the given fields replaced. */
  _replace(kw: Partial<PsdStyleBlocks>): PsdStyleBlocks {
    const f = { ...this, ...kw };
    return new PsdStyleBlocks(f.effects, f.fill_opacity, f.blend_interior, f.channel_restrictions);
  }

  _asdict(): Record<string, PsdStyleBlocks[(typeof PsdStyleBlocks._fields)[number]]> {
    return Object.fromEntries(PsdStyleBlocks._fields.map((f) => [f, this[f]]));
  }

  /** NamedTuple equality: tuple-wise comparison of the fields. */
  __eq__(other: Iterable<unknown> | null | undefined): boolean {
    if (other == null || typeof other[Symbol.iterator] !== "function") return false;
    return py_eq([...this], [...other]);
  }
}

/** A leaf layer of a Photoshop document, in the order AE imports it. */
export class PsdLayer {
  /** Layer name (Unicode `luni` name if present, else the Pascal name). */
  readonly name: string;

  /**
   * Photoshop layer id (`lyid`); when the file stores none, the record
   * index + 2, as After Effects numbers such layers.
   */
  readonly layer_id: number;

  /** Content bounding box as `(left, top, right, bottom)` in canvas pixels. */
  readonly bounds: [number, number, number, number];

  /**
   * Zero-based position of this layer's record in the full document layer
   * list (counting group divider/header records), used as AE's opti layer
   * index.
   */
  readonly record_index: number;

  /**
   * `true` when the layer is an adjustment layer (Levels, Hue/Saturation,
   * ...).
   */
  readonly is_adjustment: boolean;

  /**
   * Raw layer-style tagged blocks, or `null` when the record carries no
   * effects descriptor.
   */
  readonly style_blocks: PsdStyleBlocks | null;

  /**
   * Raw `vmsk`/`vsms` vector-mask block body (path records), or `null`
   * when the layer has no vector mask. Shape layers carry one too - AE
   * imports both as an AE mask on the comp layer. Decoded by
   * `resolvers.psd_paths`.
   */
  readonly vector_mask: Uint8Array | null;

  /**
   * `true` when the layer is clipped to the layer below (the record's
   * clipping byte). AE auto-precomposes a base + its clipped layers into
   * a nested comp, with preserve-transparency on the clipped ones.
   */
  readonly clipped: boolean;

  /**
   * `true` for a fill layer (solid color, gradient or pattern - the
   * `SoCo`/`GdFl`/`PtFl` blocks; a shape layer is one). Its content is
   * unbounded: the record's pixels are only Photoshop's rasterized preview.
   */
  readonly is_fill: boolean;

  /**
   * Where the layer shows through its enabled raster layer mask, as
   * `(left, top, right, bottom)` canvas pixels: the bounds of the pixels
   * whose alpha and mask are both non-zero, over the record bounds (over the
   * canvas for a fill layer). `null` when the layer has no such mask.
   */
  readonly mask_box: [number, number, number, number] | null;

  /**
   * `false` when the record has no transparency channel: Photoshop's
   * Background layer, which After Effects imports without alpha.
   */
  readonly has_transparency: boolean;

  /**
   * `false` when the layer is hidden in Photoshop; After Effects imports
   * it with the comp layer's video switch off.
   */
  readonly visible: boolean;

  constructor(
    name: string,
    layer_id: number,
    bounds: [number, number, number, number],
    record_index: number,
    is_adjustment: boolean,
    style_blocks: PsdStyleBlocks | null = null,
    vector_mask: Uint8Array | null = null,
    clipped: boolean = false,
    is_fill: boolean = false,
    mask_box: [number, number, number, number] | null = null,
    has_transparency: boolean = true,
    visible: boolean = true,
  ) {
    this.name = name;
    this.layer_id = layer_id;
    this.bounds = bounds;
    this.record_index = record_index;
    this.is_adjustment = is_adjustment;
    this.style_blocks = style_blocks;
    this.vector_mask = vector_mask;
    this.clipped = clipped;
    this.is_fill = is_fill;
    this.mask_box = mask_box;
    this.has_transparency = has_transparency;
    this.visible = visible;
  }

  *[Symbol.iterator]() {
    yield this.name;
    yield this.layer_id;
    yield this.bounds;
    yield this.record_index;
    yield this.is_adjustment;
    yield this.style_blocks;
    yield this.vector_mask;
    yield this.clipped;
    yield this.is_fill;
    yield this.mask_box;
    yield this.has_transparency;
    yield this.visible;
  }

  static readonly _fields = ["name", "layer_id", "bounds", "record_index", "is_adjustment", "style_blocks", "vector_mask", "clipped", "is_fill", "mask_box", "has_transparency", "visible"] as const satisfies readonly (keyof PsdLayer)[];

  /** `t._replace(field=...)`: a copy with the given fields replaced. */
  _replace(kw: Partial<PsdLayer>): PsdLayer {
    const f = { ...this, ...kw };
    return new PsdLayer(
      f.name,
      f.layer_id,
      f.bounds,
      f.record_index,
      f.is_adjustment,
      f.style_blocks,
      f.vector_mask,
      f.clipped,
      f.is_fill,
      f.mask_box,
      f.has_transparency,
      f.visible,
    );
  }

  _asdict(): Record<string, PsdLayer[(typeof PsdLayer._fields)[number]]> {
    return Object.fromEntries(PsdLayer._fields.map((f) => [f, this[f]]));
  }

  /** NamedTuple equality: tuple-wise comparison of the fields. */
  __eq__(other: Iterable<unknown> | null | undefined): boolean {
    if (other == null || typeof other[Symbol.iterator] !== "function") return false;
    return py_eq([...this], [...other]);
  }
}

/**
 * A layer group; AE imports it as a nested composition.
 *
 * `style_blocks` carries the styles Photoshop allows on the GROUP itself;
 * the import does not apply them (a warning surfaces the drop).
 */
export class PsdGroup {
  /** Group name (from the folder header record). */
  readonly name: string;

  /** Photoshop layer id (`lyid`) of the group header. */
  readonly layer_id: number;

  /** The group's contents, bottom layer first. */
  readonly children: PsdNode[];

  /**
   * Raw layer-style tagged blocks of the group header record, or `null`
   * when the group carries no effects descriptor.
   */
  readonly style_blocks: PsdStyleBlocks | null;

  /** `false` when the group is hidden in Photoshop. */
  readonly visible: boolean;

  constructor(
    name: string,
    layer_id: number,
    children: PsdNode[],
    style_blocks: PsdStyleBlocks | null = null,
    visible: boolean = true,
  ) {
    this.name = name;
    this.layer_id = layer_id;
    this.children = children;
    this.style_blocks = style_blocks;
    this.visible = visible;
  }

  *[Symbol.iterator]() {
    yield this.name;
    yield this.layer_id;
    yield this.children;
    yield this.style_blocks;
    yield this.visible;
  }

  static readonly _fields = ["name", "layer_id", "children", "style_blocks", "visible"] as const satisfies readonly (keyof PsdGroup)[];

  /** `t._replace(field=...)`: a copy with the given fields replaced. */
  _replace(kw: Partial<PsdGroup>): PsdGroup {
    const f = { ...this, ...kw };
    return new PsdGroup(f.name, f.layer_id, f.children, f.style_blocks, f.visible);
  }

  _asdict(): Record<string, PsdGroup[(typeof PsdGroup._fields)[number]]> {
    return Object.fromEntries(PsdGroup._fields.map((f) => [f, this[f]]));
  }

  /** NamedTuple equality: tuple-wise comparison of the fields. */
  __eq__(other: Iterable<unknown> | null | undefined): boolean {
    if (other == null || typeof other[Symbol.iterator] !== "function") return false;
    return py_eq([...this], [...other]);
  }
}

export type PsdNode = PsdLayer | PsdGroup;

// Adjustment-layer additional-info keys (one is present per adjustment type).
// Bytes keys are held as their hex spelling, since a JS Set cannot hash a
// Uint8Array by value.
export const _ADJUSTMENT_KEYS: ReadonlySet<string> = new Set(
  [
    "brit",
    "levl",
    "curv",
    "expA",
    "vibA",
    "hue ",
    "hue2",
    "blnc",
    "blwh",
    "phfl",
    "mixr",
    "clrL",
    "nvrt",
    "post",
    "thrs",
    "grdm",
    "selc",
  ].map((k) => bytes_.hex(b(k))),
);

// Fill-layer additional-info keys: solid color, gradient and pattern fills.
export const _FILL_KEYS: ReadonlySet<string> = new Set(["SoCo", "GdFl", "PtFl"].map((k) => bytes_.hex(b(k))));

// Maps every byte to 0 (zero) or 1 (non-zero), so rows of samples can be
// combined with integer AND / OR.
export const _NONZERO = Uint8Array.from([0, ...new Array<number>(255).fill(1)]);

// The largest document the PSB format allows (PSD: 30,000 px). No canvas,
// layer or mask Photoshop writes is wider or taller, so a larger rectangle is
// a corrupt record - decoding it would allocate rows of absurd size.
export const _MAX_EXTENT = 300_000;

// The most a channel's bytes can inflate when decoded: deflate's 1032:1
// limit (raw data is 1:1, PackBits at most 64:1). A rectangle whose decoded
// size would need more than that from its bytes is a corrupt record.
export const _MAX_INFLATION = 1032;

/** One raw layer record, before the group tree is rebuilt. */
export class _Record {
  readonly name: string;
  readonly layer_id: number;
  readonly bounds: [number, number, number, number];
  readonly record_index: number;
  readonly section_divider: number;
  readonly is_adjustment: boolean;
  readonly style_blocks: PsdStyleBlocks | null;
  readonly vector_mask: Uint8Array | null;
  readonly clipped: boolean;
  readonly is_fill: boolean;
  readonly mask_box: [number, number, number, number] | null;
  readonly has_transparency: boolean;
  readonly visible: boolean;

  constructor(
    name: string,
    layer_id: number,
    bounds: [number, number, number, number],
    record_index: number,
    section_divider: number,
    is_adjustment: boolean,
    style_blocks: PsdStyleBlocks | null = null,
    vector_mask: Uint8Array | null = null,
    clipped: boolean = false,
    is_fill: boolean = false,
    mask_box: [number, number, number, number] | null = null,
    has_transparency: boolean = true,
    visible: boolean = true,
  ) {
    this.name = name;
    this.layer_id = layer_id;
    this.bounds = bounds;
    this.record_index = record_index;
    this.section_divider = section_divider;
    this.is_adjustment = is_adjustment;
    this.style_blocks = style_blocks;
    this.vector_mask = vector_mask;
    this.clipped = clipped;
    this.is_fill = is_fill;
    this.mask_box = mask_box;
    this.has_transparency = has_transparency;
    this.visible = visible;
  }

  /** `rec._replace(field=...)`: a copy with the given fields replaced. */
  _replace(kw: Partial<_Record>): _Record {
    const f = { ...this, ...kw };
    return new _Record(
      f.name,
      f.layer_id,
      f.bounds,
      f.record_index,
      f.section_divider,
      f.is_adjustment,
      f.style_blocks,
      f.vector_mask,
      f.clipped,
      f.is_fill,
      f.mask_box,
      f.has_transparency,
      f.visible,
    );
  }

  *[Symbol.iterator]() {
    yield this.name;
    yield this.layer_id;
    yield this.bounds;
    yield this.record_index;
    yield this.section_divider;
    yield this.is_adjustment;
    yield this.style_blocks;
    yield this.vector_mask;
    yield this.clipped;
    yield this.is_fill;
    yield this.mask_box;
    yield this.has_transparency;
    yield this.visible;
  }
}

/**
 * An enabled raster layer mask painted by the user (not the one
 * Photoshop renders from a vector mask).
 */
export class _UserMask {
  readonly channel_id: number;
  readonly bounds: [number, number, number, number];
  // `default` is a reserved word in TS; the field keeps Python's name with a suffix.
  readonly default_: number;

  constructor(channel_id: number, bounds: [number, number, number, number], default_: number) {
    this.channel_id = channel_id;
    this.bounds = bounds;
    this.default_ = default_;
  }

  *[Symbol.iterator]() {
    yield this.channel_id;
    yield this.bounds;
    yield this.default_;
  }
}

/**
 * Return the layer tree of a Photoshop file (bottom layer first).
 *
 * @param file - Path to a `.psd` or `.psb` file.
 * @param kw - Keyword arguments:
 * - `mask_boxes`: Decode each raster layer mask's channel data for `PsdLayer.mask_box` (a full
 *     decode of the masked layers' pixels). `false` leaves it `null`, for callers that only need
 *     names and indices.
 * @returns Top-level nodes bottom-first: {@link PsdLayer} leaves and {@link PsdGroup} groups
 *   (groups nest recursively).
 * @throws {@link UnsupportedPsdLayersError} If the file is not a valid PSD/PSB.
 * @throws {@link FlattenedPsdError} If the file has no layer records (a flattened document) - a
 *   subclass of `UnsupportedPsdLayersError`.
 */
export function read_psd_layers(file: PathLike, kw: { mask_boxes?: boolean } = {}): PsdNode[] {
  const { mask_boxes = true } = kw;
  const name = new Path(file).name;
  const flattened = new FlattenedPsdError(`${name}: flattened document (no layer records).`);
  // Declared out here because the parse fills them and the tree is built after the try.
  let records: _Record[] = [];
  let channel_lists: [number, number][][] = [];
  let user_masks: (_UserMask | null)[] = [];
  let data: Uint8Array = new Uint8Array(0);
  let off = 0;
  // The byte-level parse below trusts the file layout; a truncated or
  // corrupt PSD would otherwise surface a raw struct.error/UnicodeDecodeError.
  // Convert those to the documented domain exception (FlattenedPsdError, a
  // subclass, still propagates since it is neither of the caught types).
  try {
    // Read only up to the Layer Info block: the layer records precede the
    // channel image data, which dominates a PSD's size.
    // NOTE(port): Python opens the file and reads only the header and Layer Info; the whole file is read into a BytesIO here, so parsed results are identical (only peak memory differs).
    const fp = new BytesIO(new Path(file).read_bytes());
    const header = fp.read(26);
    if (!bytes_eq(bytes_.slice(header, 0, 4), b("8BPS"))) {
      throw new UnsupportedPsdLayersError(`${name}: not a valid PSD/PSB file.`);
    }
    const is_psb = struct.unpack(">H", bytes_.slice(header, 4, 6))[0] === 2;
    const [canvas_h, canvas_w] = struct.unpack(">II", bytes_.slice(header, 14, 22));
    const depth = struct.unpack(">H", bytes_.slice(header, 22, 24))[0];
    if (!(0 < canvas_w && canvas_w <= _MAX_EXTENT && 0 < canvas_h && canvas_h <= _MAX_EXTENT)) {
      throw new UnsupportedPsdLayersError(`${name}: invalid canvas size ${canvas_w}x${canvas_h}.`);
    }
    const [record_count, remaining] = psd_layer_record_count(fp, is_psb);
    if (record_count === 0) {
      throw flattened;
    }
    data = read_bounded(fp, remaining);
    off = 0;

    const chan_len_size = is_psb ? 8 : 4;
    records = [];
    channel_lists = [];
    user_masks = [];
    for (let index = 0; index < record_count; index++) {
      let [top, left, bottom, right] = struct.unpack(">iiii", bytes_.slice(data, off, off + 16));
      off += 16;
      const num_channels = struct.unpack(">H", bytes_.slice(data, off, off + 2))[0];
      off += 2;
      const channels: [number, number][] = [];
      for (let _ = 0; _ < num_channels; _++) {
        const channel_id = struct.unpack(">h", bytes_.slice(data, off, off + 2))[0];
        const length = bytes_.int_from_bytes(bytes_.slice(data, off + 2, off + 2 + chan_len_size), "big");
        channels.push([channel_id, length]);
        off += 2 + chan_len_size;
      }
      channel_lists.push(channels);
      off += 8; // blend mode signature (4) + key (4)
      const clipped = at(data, off + 1) !== 0; // opacity, CLIPPING, flags, filler
      // Flags bit 1 marks a layer hidden in Photoshop; AE 2026 imports
      // it with the comp layer's video switch off (synthetic
      // hidden_layer.psd, COMP and COMP_CROPPED_LAYERS).
      const visible = !(at(data, off + 2) & 0x02);
      off += 4;
      const extra_len = struct.unpack(">I", bytes_.slice(data, off, off + 4))[0];
      off += 4;
      const extra = bytes_.slice(data, off, off + extra_len);
      off += extra_len;
      let [
        layer_name,
        layer_id,
        section_divider,
        is_adjustment,
        style_blocks,
        vector_mask,
        is_fill,
        mask_data,
      ] = _parse_layer_extra(extra, is_psb);
      user_masks.push(mask_boxes ? _user_mask(mask_data, name, layer_name) : null);
      const has_transparency = channels.some(([cid]) => cid === -1);
      if (index === 0 && !has_transparency && !section_divider) {
        // Photoshop's Background layer (the bottom record, with no
        // transparency channel): AE 2026 names it "Background"
        // whatever the file stores - a French Photoshop's
        // "Arrière-plan" imports as "Background" (footage_depth.aep,
        // psd_rgb8_bg_layer.psd / psd_rgb16_bg_layer.psd).
        layer_name = "Background";
      }
      records.push(
        new _Record(
          layer_name,
          // Without an `lyid` block AE 2026 numbers the layers from
          // 2 in record order (synthetic PSDs with no ids).
          layer_id == null ? index + 2 : layer_id,
          [left, top, right, bottom],
          index,
          section_divider,
          is_adjustment,
          style_blocks,
          vector_mask,
          clipped,
          is_fill,
          undefined,
          has_transparency,
          visible,
        ),
      );
    }
    // The channel image data follows the records, each record's channels
    // in its channel-list order.
    for (const [index, channels] of channel_lists.entries()) {
      const rec = records[index];
      const mask = user_masks[index];
      // Where each channel's data lies: only a masked record's alpha
      // and mask channels are read, so nothing else is copied.
      const spans = new Map<number, [number, number]>();
      for (const [channel_id, length] of channels) {
        spans.set(channel_id, [off, off + length]);
        off += length;
      }
      if (mask == null || rec.is_adjustment || rec.section_divider) continue;
      const region: [number, number, number, number] = rec.is_fill ? [0, 0, canvas_w, canvas_h] : rec.bounds;
      if (region[2] <= region[0] || region[3] <= region[1]) continue;
      const area = (region[2] - region[0]) * (region[3] - region[1]);
      const source = rec.is_fill ? data.length : sum(channels.map(([, n]) => n));
      if (area > _MAX_INFLATION * source) {
        throw new UnsupportedPsdLayersError(`${name}: layer ${repr(rec.name)} is larger than its pixel data.`);
      }
      const alpha = rec.is_fill ? null : spans.get(-1) ?? null;
      const mask_span = spans.get(mask.channel_id);
      records[index] = rec._replace({
        mask_box: _visible_box(
          region,
          alpha == null ? null : bytes_.slice(data, alpha[0], alpha[1]),
          mask,
          mask_span == null ? null : bytes_.slice(data, mask_span[0], mask_span[1]),
          depth,
          is_psb,
        ),
      });
    }
  } catch (exc) {
    if (!(exc instanceof StructError || exc instanceof UnicodeDecodeError || is_zlib_error(exc) || exc instanceof IndexError)) {
      throw exc;
    }
    throw Object.assign(new UnsupportedPsdLayersError(`${name}: malformed PSD/PSB layer data.`), { cause: exc });
  }
  return _build_layer_tree(records);
}

/**
 * The enabled, user-painted raster mask described by a record's layer
 * mask data, or `null`.
 *
 * Photoshop also renders a vector mask into the mask channel (flags bit
 * 3); AE ignores that copy and applies the path itself. When a layer has
 * both, the painted mask is the "real" one (channel -3).
 */
export function _user_mask(mask: Uint8Array, file_name: string, layer_name: string): _UserMask | null {
  if (mask.length < 18) return null;
  let [top, left, bottom, right] = struct.unpack(">iiii", bytes_.slice(mask, 0, 16));
  const default_ = mask[16];
  const flags = mask[17];
  let pos = 18;
  if (flags & 0x10) {
    const parameters = at(mask, pos);
    pos += 1;
    if (parameters & 0x03) {
      // NOTE(port): message and category match warnings.warn; stacklevel=3 only picks the reported source location, which has no JS equivalent.
      warn(
        `${file_name}: the density / feather of layer ${repr(layer_name)}'s ` +
          "mask is not modeled; its footage is sized as if unmasked",
      );
      return null;
    }
    pos += (parameters & 0x04 ? 1 : 0) + (parameters & 0x08 ? 8 : 0);
  }
  if (mask.length - pos >= 18) {
    const real_flags = mask[pos];
    const real_default = mask[pos + 1];
    [top, left, bottom, right] = struct.unpack(">iiii", bytes_.slice(mask, pos + 2, pos + 18));
    if (real_flags & 0x02) return null;
    return new _UserMask(-3, [left, top, right, bottom], real_default);
  }
  if (flags & 0x0a) {
    // Disabled (bit 1), or rendered from the vector mask (bit 3).
    return null;
  }
  return new _UserMask(-2, [left, top, right, bottom], default_);
}

/**
 * The bounds of the pixels of `region` where the layer's alpha (fully
 * opaque when `alpha` is `null`) and its mask are both non-zero, as AE
 * crops a masked layer (measured on AE 2026 with alpha holes under the
 * mask). An empty result is `(0, 0, 0, 0)`.
 */
export function _visible_box(
  region: [number, number, number, number],
  alpha: Uint8Array | null,
  mask: _UserMask,
  mask_data: Uint8Array | null,
  depth: number,
  is_psb: boolean,
): [number, number, number, number] {
  const [rl, rt, rr, rb] = region;
  const width = rr - rl;
  const [ml, mt, mr, mb] = mask.bounds;
  const mask_rows: Uint8Array[] =
    mask_data != null && mr > ml && mb > mt ? _channel_flags(mask_data, mr - ml, mb - mt, depth, is_psb) : [];
  const alpha_rows: Uint8Array[] | null =
    alpha != null ? _channel_flags(alpha, width, rb - rt, depth, is_psb) : null;
  const default_row = bytes_.repeat(b(mask.default_ ? "\x01" : "\x00"), width);
  // Outside its rectangle the mask takes its default color, so with a black
  // default only the rectangle's rows can show.
  const [y0, y1] = mask.default_ ? [rt, rb] : [Math.max(rt, mt), Math.min(rb, mb)];
  const x0 = Math.max(ml, rl);
  const x1 = Math.min(mr, rr);
  let min_x: number | null = null;
  let min_y: number | null = null;
  let max_x: number | null = null;
  let max_y: number | null = null;
  for (let y = y0; y < y1; y++) {
    const row = default_row.slice();
    if (mask_rows.length > 0 && mt <= y && y < mb && x0 < x1) {
      row.set(bytes_.slice(mask_rows[y - mt], x0 - ml, x1 - ml), x0 - rl);
    }
    let visible = int_from_bytes_big(row);
    if (alpha_rows != null) {
      visible &= int_from_bytes_big(alpha_rows[y - rt]);
    }
    if (visible === 0n) continue;
    // Column of the most / least significant set byte.
    const first = width - 1 - floordiv(bit_length(visible) - 1, 8);
    const last = width - 1 - floordiv(bit_length(visible & -visible) - 1, 8);
    min_x = min_x == null ? first : Math.min(min_x, first);
    max_x = max_x == null ? last : Math.max(max_x, last);
    if (min_y == null) min_y = y;
    max_y = y;
  }
  if (min_x == null || max_x == null || min_y == null || max_y == null) {
    return [0, 0, 0, 0];
  }
  return [rl + min_x, min_y, rl + max_x + 1, max_y + 1];
}

/**
 * Decode one channel's image data to rows of 0 / 1 bytes, 1 where a
 * sample is non-zero.
 *
 * Handles the four PSD compressions: raw, PackBits RLE (8-bit and 16-bit
 * documents), and zlib with or without prediction (written for 16/32-bit).
 */
export function _channel_flags(
  chunk: Uint8Array,
  width: number,
  height: number,
  depth: number,
  is_psb: boolean,
): Uint8Array[] {
  const compression = struct.unpack(">H", bytes_.slice(chunk, 0, 2))[0];
  const sample = Math.max(floordiv(depth, 8), 1);
  const row_len = width * sample;
  if (width > _MAX_EXTENT || height > _MAX_EXTENT || row_len * height > _MAX_INFLATION * chunk.length) {
    throw new UnsupportedPsdLayersError(`channel data (${chunk.length} bytes) too short for ${width}x${height}`);
  }
  const body = bytes_.slice(chunk, 2);
  let raw: Uint8Array;
  if (compression === 1) {
    const count_size = is_psb ? 4 : 2;
    const counts_end = height * count_size;
    let pos = counts_end;
    const parts: Uint8Array[] = [];
    for (let y = 0; y < height; y++) {
      const n = bytes_.int_from_bytes(bytes_.slice(body, y * count_size, (y + 1) * count_size), "big");
      parts.push(_unpack_bits(bytes_.slice(body, pos, pos + n), row_len));
      pos += n;
    }
    raw = join_all(parts);
  } else if (compression === 2 || compression === 3) {
    // Bounded by the rectangle, not by whatever the stream inflates to.
    raw = inflate_bounded(body, Math.max(row_len * height, 1));
  } else {
    raw = body.slice();
  }
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    let row = bytes_.slice(raw, y * row_len, (y + 1) * row_len);
    if (compression === 3) row = _undo_prediction(row, width, sample);
    if (sample === 1) {
      rows.push(translate(row, _NONZERO));
      continue;
    }
    // A sample is non-zero when any of its bytes is: interleaved bytes
    // for 16-bit, byte planes (after prediction) for 32-bit.
    const planes: Uint8Array[] =
      compression === 3 && sample === 4
        ? Array.from({ length: sample }, (_, i) => bytes_.slice(row, i * width, (i + 1) * width))
        : Array.from({ length: sample }, (_, i) => strided(row, i, sample));
    let combined = 0n;
    for (const plane of planes) {
      combined |= int_from_bytes_big(translate(plane, _NONZERO));
    }
    rows.push(bytes_.int_to_bytes(combined, width, "big"));
  }
  return rows;
}

export function _unpack_bits(data: Uint8Array, size: number): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (out.length < size && i < data.length) {
    const n = data[i];
    i += 1;
    if (n < 128) {
      for (const c of bytes_.slice(data, i, i + n + 1)) out.push(c);
      i += n + 1;
    } else if (n > 128) {
      const v = bytes_.slice(data, i, i + 1);
      for (let k = 0; k < 257 - n; k++) {
        for (const c of v) out.push(c);
      }
      i += 1;
    }
  }
  return bytes_.ljust(Uint8Array.from(out.slice(0, size)), size, 0);
}

/**
 * Undo the zlib-with-prediction delta coding of one row: per 16-bit
 * sample for 16-bit documents, over the whole row's bytes (stored as byte
 * planes) for 8 and 32-bit ones.
 */
export function _undo_prediction(row: Uint8Array, width: number, sample: number): Uint8Array {
  if (sample === 2) {
    const values = struct.unpack(`>${width}H`, row);
    // NOTE(port): equals struct.pack(">{width}H", *(acc & 0xFFFF)) (Python's running sum masked to u16); written via DataView because pyrt struct.pack spreads args and overflows on wide rows.
    const out = new Uint8Array(2 * width);
    const dv = new DataView(out.buffer);
    let acc = 0;
    for (let i = 0; i < values.length; i++) {
      acc += values[i];
      dv.setUint16(2 * i, and(acc, 0xffff), false);
    }
    return out;
  }
  const out = new Uint8Array(row.length);
  let acc = 0;
  for (let i = 0; i < row.length; i++) {
    acc += row[i];
    out[i] = and(acc, 0xff);
  }
  return out;
}

/**
 * Rebuild the group tree from a flat, bottom-first record list.
 *
 * A bounding divider (`lsct` 3) opens a group scope; the matching folder
 * header (`lsct` 1/2) closes it and names the group. Groups nest via a stack.
 */
export function _build_layer_tree(records: _Record[]): PsdNode[] {
  const root: PsdNode[] = [];
  const stack: PsdNode[][] = [root];
  for (const rec of records) {
    if (rec.section_divider === 3) {
      stack.push([]);
    } else if (rec.section_divider === 1 || rec.section_divider === 2) {
      const children = stack.length > 1 ? stack.splice(-1)[0] : [];
      stack[stack.length - 1].push(
        new PsdGroup(rec.name, rec.layer_id, children, rec.style_blocks, rec.visible),
      );
    } else {
      stack[stack.length - 1].push(
        new PsdLayer(
          rec.name,
          rec.layer_id,
          rec.bounds,
          rec.record_index,
          rec.is_adjustment,
          rec.style_blocks,
          rec.vector_mask,
          rec.clipped,
          rec.is_fill,
          rec.mask_box,
          rec.has_transparency,
          rec.visible,
        ),
      );
    }
  }
  // Defensive: an unbalanced file leaves open scopes; surface their contents.
  while (stack.length > 1) {
    const [orphans] = stack.splice(-1);
    for (const o of orphans) stack[stack.length - 1].push(o);
  }
  return root;
}

/**
 * Extract `(name, layer_id, section_divider, is_adjustment, style_blocks, vector_mask, is_fill, mask_data)`; `layer_id` is `null` without an `lyid`
 * block.
 *
 * `section_divider` is the `lsct` value: 0 (or absent) for a normal layer,
 * 1/2 for an open/closed group header, 3 for the hidden bounding divider that
 * ends a group. `is_adjustment` is `true` when an adjustment-type key is
 * present. `style_blocks` carries the raw layer-style tagged blocks, `null`
 * when the record has no effects descriptor. `vector_mask` is the raw
 * `vmsk`/`vsms` block body, `null` when the layer has no vector mask.
 * `is_fill` is `true` when a fill-layer key is present. `mask_data` is the
 * layer mask data sub-block body (empty when the layer has no mask).
 */
export function _parse_layer_extra(
  extra: Uint8Array,
  is_psb: boolean,
): [string, number | null, number, boolean, PsdStyleBlocks | null, Uint8Array | null, boolean, Uint8Array] {
  let pos = 0;
  // Layer mask data and blending-ranges sub-blocks (4-byte lengths in both).
  const mask_len = struct.unpack(">I", bytes_.slice(extra, pos, pos + 4))[0];
  const mask_data = bytes_.slice(extra, pos + 4, pos + 4 + mask_len);
  pos += 4 + mask_len;
  pos += 4 + struct.unpack(">I", bytes_.slice(extra, pos, pos + 4))[0];
  // Legacy Pascal name, padded so (1 + length) is a multiple of 4.
  const pascal_len = at(extra, pos);
  const pascal = decode(bytes_.slice(extra, pos + 1, pos + 1 + pascal_len), "latin-1");
  pos += 1 + pascal_len;
  pos += (4 - ((1 + pascal_len) % 4)) % 4;
  // Remaining bytes are additional layer info blocks.
  let unicode_name: string | null = null;
  let layer_id: number | null = null;
  let section_divider = 0;
  let is_adjustment = false;
  let is_fill = false;
  let lfx2: Uint8Array | null = null;
  let lmfx: Uint8Array | null = null;
  let lfxs: Uint8Array | null = null;
  let fill_opacity: number | null = null;
  let blend_interior: boolean | null = null;
  let channel_restrictions: Uint8Array = b("");
  let vmsk: Uint8Array | null = null;
  let vsms: Uint8Array | null = null;
  while (pos + 12 <= extra.length) {
    const signature = bytes_.slice(extra, pos, pos + 4);
    if (!bytes_eq(signature, b("8BIM")) && !bytes_eq(signature, b("8B64"))) break;
    const key = bytes_.slice(extra, pos + 4, pos + 8);
    let block_len: number;
    let block_start: number;
    if (is_psb && _PSB_8BYTE_KEYS.has(bytes_.hex(key))) {
      block_len = Number(struct.unpack(">Q", bytes_.slice(extra, pos + 8, pos + 16))[0]);
      block_start = pos + 16;
    } else {
      block_len = struct.unpack(">I", bytes_.slice(extra, pos + 8, pos + 12))[0];
      block_start = pos + 12;
    }
    const block = bytes_.slice(extra, block_start, block_start + block_len);
    if (bytes_eq(key, b("luni"))) {
      const char_count = struct.unpack(">I", bytes_.slice(block, 0, 4))[0];
      unicode_name = rstrip(decode(bytes_.slice(block, 4, 4 + char_count * 2), "utf-16-be"), "\x00");
    } else if (bytes_eq(key, b("lyid"))) {
      layer_id = struct.unpack(">I", bytes_.slice(block, 0, 4))[0];
    } else if (bytes_eq(key, b("lsct")) && block_len >= 4) {
      section_divider = struct.unpack(">I", bytes_.slice(block, 0, 4))[0];
    } else if (_ADJUSTMENT_KEYS.has(bytes_.hex(key))) {
      is_adjustment = true;
    } else if (_FILL_KEYS.has(bytes_.hex(key))) {
      is_fill = true;
    } else if (bytes_eq(key, b("lfx2"))) {
      lfx2 = block;
    } else if (bytes_eq(key, b("lmfx"))) {
      lmfx = block;
    } else if (bytes_eq(key, b("lfxs"))) {
      // Group headers store their styles under `lfxs` (same descriptor
      // layout as `lfx2`; probed Photoshop 2026, psd_group_styles.psd).
      lfxs = block;
    } else if (bytes_eq(key, b("vmsk"))) {
      vmsk = block;
    } else if (bytes_eq(key, b("vsms"))) {
      // CS6+ variant of vmsk (written when the mask needs the newer
      // feature set); same path-record layout.
      vsms = block;
    } else if (bytes_eq(key, b("iOpa")) && block_len >= 1) {
      fill_opacity = at(block, 0);
    } else if (bytes_eq(key, b("infx")) && block_len >= 1) {
      blend_interior = at(block, 0) !== 0;
    } else if (bytes_eq(key, b("brst"))) {
      channel_restrictions = block;
    }
    pos = block_start + block_len + (block_len % 2); // blocks padded to even
  }
  // Photoshop writes lmfx (and drops lfx2) when any style has multiple
  // instances; prefer it when both somehow exist. Groups carry lfxs
  // instead (a group record never has lfx2/lmfx).
  let effects = lmfx != null ? lmfx : lfx2;
  if (effects == null) {
    effects = lfxs;
  }
  // Photoshop writes an `infx` block (False) on every ordinary layer, so
  // only a user deviation counts: Fill away from 100% (`iOpa` present),
  // Blend Interior checked, or a channel restriction.
  const has_blend_data =
    fill_opacity != null || !!blend_interior || channel_restrictions?.length > 0;
  const style_blocks =
    effects != null || has_blend_data
      ? new PsdStyleBlocks(effects, fill_opacity, blend_interior, channel_restrictions)
      : null;
  return [
    unicode_name != null ? unicode_name : pascal,
    layer_id,
    section_divider,
    is_adjustment,
    style_blocks,
    vsms != null ? vsms : vmsk,
    is_fill,
    mask_data,
  ];
}

// NOTE(port): bytes.translate(table) for a 256-entry table; pyrt/bytes.ts has no translate shim.
export function translate(data: Uint8Array, table: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = table[data[i]];
  return out;
}

// NOTE(port): bytes[start::step] via py_slice (which returns a plain array for bytes), re-wrapped as Uint8Array.
export function strided(row: Uint8Array, start: number, step: number): Uint8Array {
  return Uint8Array.from(py_slice(row, start, null, step));
}

// NOTE(port): int.from_bytes(data, "big") as an exact bigint; pyrt's int_from_bytes returns a Number and loses bits past 2^53.
export function int_from_bytes_big(data: Uint8Array): bigint {
  return data.length ? BigInt("0x" + bytes_.hex(data)) : 0n;
}

// Only called on positive values.
export function bit_length(x: bigint): number {
  return x.toString(2).length;
}

// NOTE(port): b"".join(parts); pyrt concat spreads its parts as call arguments and overflows with tens of thousands of rows.
export function join_all(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * `zlib.decompressobj().decompress(body, max_length)`: the inflated stream,
 * at most `max_length` bytes. Z_SYNC_FLUSH keeps a truncated stream from
 * throwing, as Python's partial decompress does.
 */
// TODO(port): Python's decompressobj stops inflating at max_length; node:zlib inflateSync has no partial-output cap (maxOutputLength throws instead), so a stream that expands far beyond max_length is fully inflated before being truncated. Output bytes are identical; only memory/time on hostile streams differs (the caller bounds only the declared rectangle, not the stream).
export function inflate_bounded(body: Uint8Array, max_length: number): Uint8Array {
  return zlib.decompressobj().decompress(body, max_length);
}

/** `except zlib.error` */
export function is_zlib_error(e: unknown): boolean {
  return e instanceof zlib.error;
}
