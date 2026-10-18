/**
 * Miscellaneous chunk types: prin, mkif, shph, NmHd, fips, pard, fth5, dwga.
 *
 * Fixed-layout chunks use `fmt_field()` and `BitField`.
 * Fth5Chunk uses `items_field()` for repeating feather points.
 * PardChunk and PrdaChunk use variant subclass dispatch for polymorphic layouts.
 */

import { uuid4Bytes } from "../../pyrt/uuid.ts";
import { define, field, b, bytes_, decode, encode, getattr, len, pyAssert, round, descriptor, TypeError_, ValueError } from "../../pyrt/index.ts";
import type { IO } from "../../pyrt/index.ts";
import { readBytes } from "./bin_utils.ts";
import { BitField } from "./bitfield.ts";
import { Chunk } from "./chunk.ts";
import { FmtItem, asciiField, boolField, bytesField, f4Field, f8Field, itemsField, s2Field, s4Field, u1Field, u2Field, u4Field } from "./fmt_field.ts";
import { register } from "./registry.ts";

// ---------------------------------------------------------------------------
// prin - composition renderer info (104 bytes)
// ---------------------------------------------------------------------------

/**
 * Composition renderer plug-in info (104 bytes).
 *
 * Contains the match name and display name of the active 3D renderer.
 */
export class PrinChunk extends Chunk {
  declare chunk_type: string;
  declare _reserved_00: Uint8Array;
  /** Internal match name (e.g. 'ADBE Advanced 3d'). */
  declare match_name: string;
  /** Human-readable name (e.g. 'Classic 3D'). */
  declare display_name: string;
  declare _reserved_68: Uint8Array;
  declare _end_marker: Uint8Array;
}
define(PrinChunk, {
  chunk_type: field({ default: "prin" }),
  _reserved_00: bytesField(4, { repr: false }),
  match_name: asciiField(48, { default: "ADBE Escher" }),
  display_name: asciiField(48, { default: "Classic 3D" }),
  _reserved_68: bytesField(3, { repr: false }),
  _end_marker: bytesField(1, { default: b("\x01"), repr: false }),
});
register("prin")(PrinChunk);

// ---------------------------------------------------------------------------
// sfdt - subfolder data (4 bytes)
// ---------------------------------------------------------------------------

/** Subfolder data chunk. */
export class SfdtChunk extends Chunk {
  declare chunk_type: string;
  declare value: number;
}
define(SfdtChunk, {
  chunk_type: field({ default: "sfdt" }),
  value: u4Field({ default: 1 }),
});
register("sfdt")(SfdtChunk);

// ---------------------------------------------------------------------------
// pgui - 16-byte GUID
// ---------------------------------------------------------------------------

/** 16-byte GUID chunk. */
export class PguiChunk extends Chunk {
  declare chunk_type: string;
  declare guid: Uint8Array;

  /** Build a pgui with a fresh random GUID. */
  static new_(): PguiChunk {
    // uuid4().bytes: random bits with the version nibble and RFC 4122 variant set.
    return new this({ guid: uuid4Bytes() });
  }
}
define(PguiChunk, {
  chunk_type: field({ default: "pgui" }),
  guid: bytesField(16),
});
register("pgui")(PguiChunk);

// ---------------------------------------------------------------------------
// prda - renderer additional data (variant dispatch)
// ---------------------------------------------------------------------------

/**
 * Renderer additional data (polymorphic).
 *
 * The layout is renderer-specific, so the base class dispatches on the
 * sibling `prin` chunk's match name (resolved by the chunk reader), with
 * the body size as a sanity check. Unknown renderers and unexpected
 * sizes fall back to raw bytes and still round-trip byte-exact.
 *
 * These options are not exposed by ExtendScript.
 */
export class PrdaChunk extends Chunk {
  declare chunk_type: string;

  static read(
    fp: IO,
    size: number,
    kw: { chunk_type?: string; renderer_match_name?: string } = {},
  ): PrdaChunk {
    const { chunk_type = "", renderer_match_name = "" } = kw;
    if (this !== PrdaChunk) {
      const result = super.read(fp, size, { chunk_type });
      pyAssert(result instanceof PrdaChunk);
      return result;
    }
    const variant = _PRDA_VARIANTS.get(renderer_match_name);
    if (variant == null || variant[1] !== size) {
      // preserve unknown raw bytes
      return new this({ chunk_type, data: readBytes(fp, size) });
    }
    return variant[0].read(fp, size, { chunk_type });
  }
}
define(PrdaChunk, {
  chunk_type: field({ default: "prda" }),
});
register("prda")(PrdaChunk);

/** Classic 3D (`ADBE Escher`) options, 12 bytes. */
export class ClassicPrdaChunk extends PrdaChunk {
  declare _version: number;
  // Offset 4 seems likely to be unique per-renderer, but this is not fully proven.
  // Both Classic and RayTraced share the same values (version=1, tag=0), so this
  // works for now as RayTraced is deprecated. If a future renderer shares the same
  // tag value as another existing renderer, we should rename this to `_unknown_04`.
  declare _renderer_tag: number;
  declare shadow_map_resolution: number;
  /** Index into the Shadow Map Resolution dropdown, 0='Comp Size',
   * 1=250, 2=500, 3=750, 4=1000, 5=1500, 6=2000, 7=3000, 8=4000. */
}
define(ClassicPrdaChunk, {
  _version: u4Field({ default: 1, repr: false }),
  _renderer_tag: u4Field({ default: 0, repr: false }),
  shadow_map_resolution: u4Field({ default: 0 }),
});

/**
 * Advanced 3D (`ADBE Calder`) options, 52 bytes.
 *
 * The body is genuinely mixed-endian: the header through `quality` is
 * big-endian like the rest of the format, while everything from offset
 * 20 on is little-endian. That is AE's own layout, not a bug here.
 *
 * The three `casting_box_size_*` fields are written in lockstep by a
 * single dialog control. All six float fields store fractions of the
 * composition's **raw pixel** dimensions - pixel aspect ratio is not
 * applied - rather than the pixel values the dialog displays.
 */
export class AdvancedPrdaChunk extends PrdaChunk {
  declare _version: number;
  declare _renderer_tag: number;
  /** Renderer quality, 1-125. */
  declare quality: number;
  declare _reserved_12: number;
  declare _reserved_16: number;
  /** Environment light shadow resolution:
   * 0='Half (2MB)', 1='Full (16MB)', 2='Double (128MB)'. */
  declare resolution: number;
  /** Environment light shadow smoothness, 1-20. */
  declare smoothness: number;
  /** Casting box size on X, as a fraction of comp width. */
  declare casting_box_size_x: number;
  /** Casting box size on Y, as a fraction of comp width. */
  declare casting_box_size_y: number;
  /** Casting box size on Z, as a fraction of comp width. */
  declare casting_box_size_z: number;
  /** Casting box centre on X, offset from comp centre, fraction of width. */
  declare casting_box_center_x: number;
  /** Casting box centre on Y, offset from comp centre, fraction of height. */
  declare casting_box_center_y: number;
  /** Casting box centre on Z, as a fraction of comp width. */
  declare casting_box_center_z: number;
}
define(AdvancedPrdaChunk, {
  _version: u4Field({ default: 1, repr: false }),
  _renderer_tag: u4Field({ default: 3, repr: false }),
  quality: u4Field({ default: 8 }),
  _reserved_12: u4Field({ default: 1, repr: false }),
  _reserved_16: u4Field({ default: 0, repr: false }),
  resolution: u4Field({ default: 1, endian: "<" }),
  smoothness: u4Field({ default: 3, endian: "<" }),
  casting_box_size_x: f4Field({ default: 1.0, endian: "<" }),
  casting_box_size_y: f4Field({ default: 1.0, endian: "<" }),
  casting_box_size_z: f4Field({ default: 1.0, endian: "<" }),
  casting_box_center_x: f4Field({ default: 0.0, endian: "<" }),
  casting_box_center_y: f4Field({ default: 0.0, endian: "<" }),
  casting_box_center_z: f4Field({ default: 0.0, endian: "<" }),
});

/** Cinema 4D (`ADBE Ernst`) options, 20 bytes. */
export class Cinema4DPrdaChunk extends PrdaChunk {
  declare _version: number;
  declare _renderer_tag: number;
  /** Renderer quality, 1-99. */
  declare quality: number;
  declare _reserved_12: number;
  declare _reserved_16: number;
}
define(Cinema4DPrdaChunk, {
  _version: u4Field({ default: 1, repr: false }),
  _renderer_tag: u4Field({ default: 1, repr: false }),
  quality: u4Field({ default: 25 }),
  _reserved_12: u4Field({ default: 1, repr: false }),
  _reserved_16: u4Field({ default: 0, repr: false }),
});

/**
 * Ray-traced 3D (`ADBE Picasso`) options, 16 bytes.
 *
 * Legacy: this renderer has been removed since AE 17.0.
 * Read-only in practice: files containing it can be parsed
 * and rewritten, but no supported AE version can author one.
 */
export class RayTracedPrdaChunk extends PrdaChunk {
  declare _version: number;
  declare _renderer_tag: number;
  declare _unknown_08: number;
  declare _unknown_12: number;
}
define(RayTracedPrdaChunk, {
  _version: u4Field({ default: 1, repr: false }),
  _renderer_tag: u4Field({ default: 0, repr: false }),
  _unknown_08: u4Field({ default: 3, repr: false }),
  _unknown_12: u4Field({ default: 1, repr: false }),
});

// Body size -> variant. Sizes are distinct per renderer, so size alone
// discriminates without needing the sibling `prin` chunk's match name.
export const _PRDA_VARIANTS = new Map<string, [typeof PrdaChunk, number]>([
  ["ADBE Escher", [ClassicPrdaChunk, 12]],
  ["ADBE Picasso", [RayTracedPrdaChunk, 16]],
  ["ADBE Ernst", [Cinema4DPrdaChunk, 20]],
  ["ADBE Calder", [AdvancedPrdaChunk, 52]],
]);

// ---------------------------------------------------------------------------
// mkif - mask info (48 bytes)
// ---------------------------------------------------------------------------

/**
 * Mask info chunk (48 bytes).
 *
 * Contains mask flags, mode, and color.
 */
export class MkifChunk extends Chunk {
  declare chunk_type: string;
  /** 1 = inverted, 0 = normal. */
  declare inverted: boolean;
  /** 1 = locked, 0 = unlocked. */
  declare locked: boolean;
  /** 0 = Same as Layer, 1 = Off, 2 = On. */
  declare mask_motion_blur: number;
  /** 0 = Smooth, 1 = Linear. */
  declare mask_feather_falloff: number;
  declare _reserved_04: Uint8Array;
  /** SDK `PF_MaskMode`: 0=None, 1=Add, 2=Subtract, 3=Intersect,
   * 4=Lighten, 5=Darken, 6=Difference. */
  declare mode: number;
  /** 1-based id assigned at mask creation (creation order within the
   * layer). */
  declare mask_id: number;
  declare _reserved_0c: Uint8Array;
  declare color_r: number;
  declare color_g: number;
  declare color_b: number;

  /** Mask color as [R, G, B] in 0.0-1.0 range. */
  get color(): number[] {
    return [this.color_r / 255, this.color_g / 255, this.color_b / 255];
  }

  set color(value: number[]) {
    this.color_r = round(value[0] * 255);
    this.color_g = round(value[1] * 255);
    this.color_b = round(value[2] * 255);
  }
}
define(MkifChunk, {
  chunk_type: field({ default: "mkif" }),
  inverted: boolField(),
  locked: boolField(),
  mask_motion_blur: u1Field(),
  mask_feather_falloff: u1Field(),
  _reserved_04: bytesField(2, { repr: false }),
  mode: u2Field(),
  mask_id: u4Field(),
  _reserved_0c: bytesField(33, { repr: false }),
  color_r: u1Field(),
  color_g: u1Field(),
  color_b: u1Field(),
});
register("mkif")(MkifChunk);

// ---------------------------------------------------------------------------
// shph - shape path header (24 bytes)
// ---------------------------------------------------------------------------

/**
 * Shape path header chunk (24 bytes).
 *
 * Contains closed/open flag and bounding box for shape vertices.
 * Vertex coordinates in the associated ldat are normalized to
 * [0, 1] relative to this bounding box.
 */
export class ShphChunk extends Chunk {
  declare chunk_type: string;
  declare _reserved_00: Uint8Array;
  /** Byte 3 bit flags: bit 0 = `normalized`, bit 3 = `open`. Defaults to
   * `1` (normalized, closed). */
  declare _flags: number;
  /** Bounding-box left edge (x minimum). */
  declare top_left_x: number;
  /** Bounding-box top edge (y minimum). */
  declare top_left_y: number;
  /** Bounding-box right edge (x maximum). */
  declare bottom_right_x: number;
  /** Bounding-box bottom edge (y maximum). */
  declare bottom_right_y: number;
  declare _reserved_14: Uint8Array;
  /** True when the ldat points are stored as `[0, 1]` fractions of the
   * bounding box (AE's universal encoding). */
  declare normalized: boolean;
  /** True when the path is open (not closed). */
  declare open: boolean;
}
define(ShphChunk, {
  chunk_type: field({ default: "shph" }),
  _reserved_00: bytesField(3, { default: b("\xb3\xde\x02"), repr: false }),
  _flags: u1Field({ default: 1, repr: false }),
  top_left_x: f4Field(),
  top_left_y: f4Field(),
  bottom_right_x: f4Field(),
  bottom_right_y: f4Field(),
  _reserved_14: bytesField(4, { default: b("\x01\x00\x00\x00"), repr: false }),
});
descriptor(ShphChunk, "normalized", new BitField("_flags", 0));
descriptor(ShphChunk, "open", new BitField("_flags", 3));
register("shph")(ShphChunk);

// ---------------------------------------------------------------------------
// NmHd - marker data (17 bytes)
// ---------------------------------------------------------------------------

/**
 * Marker data chunk (20 bytes).
 *
 * Contains marker flags, duration, and label color.
 */
export class NmhdChunk extends Chunk {
  declare chunk_type: string;
  declare _reserved_00: Uint8Array;
  /** Byte 3: bit 2=unknown, bit 1=protected_region, bit 0=navigation. */
  declare _marker_flags: number;
  /** Number of cue-point parameter key/value pairs.
   *
   * Must match the number of trailing Utf8 pairs in the Nmrd list or
   * AE ignores the parameters entirely. */
  declare num_params: number;
  /** Duration dividend: seconds = `duration_value / duration_scale`. */
  declare duration_value: number;
  /** Duration divisor. 600 on every marker a script creates or whose
   * duration a script sets (AE 2026, any composition frame rate); markers
   * edited in the UI also store 24, 25 or 24576. AE 2026 reads 0 as 600. */
  declare duration_scale: number;
  /** Label color index. */
  declare label: number;
  /** Bytes 17-19: trailing padding. */
  declare _reserved_11: Uint8Array;
  declare protected_region: boolean;
  declare navigation: boolean;

  /** Duration in seconds. */
  get duration_seconds(): number {
    return this.duration_value / (this.duration_scale || 600);
  }

  set duration_seconds(value: number) {
    this.duration_value = round(value * 600);
    this.duration_scale = 600;
  }
}
define(NmhdChunk, {
  chunk_type: field({ default: "NmHd" }),
  _reserved_00: bytesField(3, { repr: false }),
  _marker_flags: u1Field({ repr: false }),
  num_params: u4Field(),
  duration_value: u4Field(),
  duration_scale: u4Field({ default: 600 }),
  label: u1Field(),
  _reserved_11: bytesField(3, { repr: false }),
});
// BitField descriptors
descriptor(NmhdChunk, "protected_region", new BitField("_marker_flags", 1));
descriptor(NmhdChunk, "navigation", new BitField("_marker_flags", 0));
register("NmHd")(NmhdChunk);

// ---------------------------------------------------------------------------
// fips - viewer panel settings (96 bytes)
// ---------------------------------------------------------------------------

/**
 * Viewer panel settings chunk (96 bytes).
 *
 * Contains zoom, exposure, ROI, channel display, and toggle flags
 * for guides, rulers, grid, etc. Bitfield flags are exposed via
 * `BitField` descriptors. The last 9 bytes (0x57-0x5F) are undecoded and
 * kept verbatim as trailing data: zeros except byte 0x59 (0x24 or 0x00 in
 * the samples).
 */
export class FipsChunk extends Chunk {
  declare chunk_type: string;
  declare _pad_00: Uint8Array;
  /** Channel display mode (0=RGB, 1=Red, 2=Green, 3=Blue, 4=Alpha, 8=RGB Straight). */
  declare channels: number;
  declare _pad_08: Uint8Array;
  /** Byte 11: bit 1=proportional_grid, bit 0=title_action_safe. */
  declare _grid_safe_flags: number;
  /** Byte 12: bit 2=draft3d. */
  declare _draft_flags: number;
  /** Byte 13: bit 4=draft, bit 2=fast_draft, bit 0=adaptive. */
  declare _preview_flags: number;
  /** Byte 14: bit 7=region_of_interest, bit 6=rulers, bit 4=wireframe. */
  declare _view_flags: number;
  /** Byte 15: bit 7=checkerboards, bit 4=mask_and_shape_path. */
  declare _display_flags: number;
  declare _pad_10: Uint8Array;
  /** Byte 23: bit 3=grid, bit 2=guides_snap, bit 1=guides_locked, bit 0=guides_visibility. */
  declare _guide_flags: number;
  declare _pad_18: Uint8Array;
  declare roi_top: number;
  declare roi_left: number;
  declare roi_bottom: number;
  declare roi_right: number;
  declare _pad_30: Uint8Array;
  /** Zoom mode (0=custom, 1=fit, 2=fit up to 100%). */
  declare zoom_type: number;
  declare _pad_46: Uint8Array;
  /** Zoom factor (1.0 = 100%). */
  declare zoom: number;
  /** Exposure value in stops (-40.0 to 40.0). */
  declare exposure: number;
  declare _pad_54: number;
  /** Byte 85: bit 0=use_display_color_management. */
  declare _color_mgmt_flags: number;
  /** Byte 86: bit 0=auto_resolution. */
  declare _resolution_flags: number;

  // -- BitField descriptors (not attrs fields) ---------------------------
  declare proportional_grid: boolean;
  declare title_action_safe: boolean;
  declare draft3d: boolean;
  declare fast_preview_draft: boolean;
  declare fast_preview_fast_draft: boolean;
  declare fast_preview_adaptive: boolean;
  declare region_of_interest: boolean;
  declare rulers: boolean;
  declare fast_preview_wireframe: boolean;
  declare checkerboards: boolean;
  declare mask_and_shape_path: boolean;
  declare grid: boolean;
  declare guides_snap: boolean;
  declare guides_locked: boolean;
  declare guides_visibility: boolean;
  declare use_display_color_management: boolean;
  declare auto_resolution: boolean;

  /** Computed fast preview type (0=off, 1=adaptive, 2=draft, 3=fast_draft, 4=wireframe). */
  get fast_preview_type(): number {
    if (this.fast_preview_wireframe) return 4;
    if (this.fast_preview_fast_draft) return 3;
    if (this.fast_preview_draft) return 2;
    if (this.fast_preview_adaptive) return 1;
    return 0;
  }

  set fast_preview_type(value: number) {
    this.fast_preview_adaptive = value === 1;
    this.fast_preview_draft = value === 2;
    this.fast_preview_fast_draft = value === 3;
    this.fast_preview_wireframe = value === 4;
  }
}
define(FipsChunk, {
  chunk_type: field({ default: "fips" }),
  _pad_00: bytesField(7, { repr: false }),
  channels: u1Field(),
  _pad_08: bytesField(3, { repr: false }),
  _grid_safe_flags: u1Field({ repr: false }),
  _draft_flags: u1Field({ repr: false }),
  _preview_flags: u1Field({ repr: false }),
  _view_flags: u1Field({ repr: false }),
  _display_flags: u1Field({ repr: false }),
  _pad_10: bytesField(7, { repr: false }),
  _guide_flags: u1Field({ repr: false }),
  _pad_18: bytesField(16, { repr: false }),
  roi_top: u2Field(),
  roi_left: u2Field(),
  roi_bottom: u2Field(),
  roi_right: u2Field(),
  _pad_30: bytesField(21, { repr: false }),
  zoom_type: u1Field(),
  _pad_46: bytesField(2, { repr: false }),
  zoom: f8Field(),
  exposure: f4Field(),
  _pad_54: u1Field({ repr: false }),
  _color_mgmt_flags: u1Field({ default: 1, repr: false }),
  _resolution_flags: u1Field({ repr: false }),
});
descriptor(FipsChunk, "proportional_grid", new BitField("_grid_safe_flags", 1));
descriptor(FipsChunk, "title_action_safe", new BitField("_grid_safe_flags", 0));
descriptor(FipsChunk, "draft3d", new BitField("_draft_flags", 2));
descriptor(FipsChunk, "fast_preview_draft", new BitField("_preview_flags", 4));
descriptor(FipsChunk, "fast_preview_fast_draft", new BitField("_preview_flags", 2));
descriptor(FipsChunk, "fast_preview_adaptive", new BitField("_preview_flags", 0));
descriptor(FipsChunk, "region_of_interest", new BitField("_view_flags", 7));
descriptor(FipsChunk, "rulers", new BitField("_view_flags", 6));
descriptor(FipsChunk, "fast_preview_wireframe", new BitField("_view_flags", 4));
descriptor(FipsChunk, "checkerboards", new BitField("_display_flags", 7));
descriptor(FipsChunk, "mask_and_shape_path", new BitField("_display_flags", 4));
descriptor(FipsChunk, "grid", new BitField("_guide_flags", 3));
descriptor(FipsChunk, "guides_snap", new BitField("_guide_flags", 2));
descriptor(FipsChunk, "guides_locked", new BitField("_guide_flags", 1));
descriptor(FipsChunk, "guides_visibility", new BitField("_guide_flags", 0));
descriptor(FipsChunk, "use_display_color_management", new BitField("_color_mgmt_flags", 0));
descriptor(FipsChunk, "auto_resolution", new BitField("_resolution_flags", 0));
register("fips")(FipsChunk);

// ---------------------------------------------------------------------------
// pard - effect property parameter definitions (variant dispatch)
// ---------------------------------------------------------------------------

// NOTE(port): Python lets a subclass attrs field replace the base property; attrs `define` assigns
// with `self[name] = v`, so a writable data property on each variant prototype (applied after
// `_PARD_VARIANTS`) gives the same behavior.
export function shadowProperty(cls: Function, name: string): void {
  Object.defineProperty(cls.prototype, name, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: undefined,
  });
}

/**
 * Effect property parameter definition (polymorphic).
 *
 * Serialized form of the AE SDK `PF_ParamDef`. Layout depends on
 * `property_control_type` (the SDK `PF_ParamType`) at byte 15; the base
 * class dispatches to variant subclasses and unknown control types fall
 * back to raw bytes.
 *
 * Common header (56 bytes): 4s pad, u4 ui_flags (`PF_ParamUIFlags`),
 * 7s pad, B property_control_type, 32s name (UTF-8),
 * u4 param_flags (`PF_ParamFlags`), 4s pad.
 */
export class PardChunk extends Chunk {
  declare chunk_type: string;
  declare _raw_name: Uint8Array;

  /** Control type discriminator at byte 15 of the raw data. */
  get property_control_type(): number {
    const data = "data" in this ? this.data : b("");
    if (len(data) > 15) return data[15];
    return 0;
  }

  static read(
    fp: IO,
    size: number,
    kw: { chunk_type?: string } = {},
  ): PardChunk {
    const { chunk_type = "" } = kw;
    if (this !== PardChunk) {
      const result = super.read(fp, size, { chunk_type });
      pyAssert(result instanceof PardChunk);
      return result;
    }
    if (size < 56) return new this({ chunk_type, data: readBytes(fp, size) });
    // Peek at discriminator (byte 15)
    const header = readBytes(fp, 16);
    const controlType = header[15];
    fp.seek(-16, 1);
    const variantCls = _PARD_VARIANTS.get(controlType) ?? PardChunk;
    if (variantCls === PardChunk) return new this({ chunk_type, data: readBytes(fp, size) });
    return variantCls.read(fp, size, { chunk_type });
  }

  /**
   * Low byte of the AE SDK `PF_ParamFlags` (u4 at offsets 48-51).
   *
   * Bit 1 (0x02) is `PF_ParamFlag_CANNOT_TIME_VARY`, bit 6 (0x40) is
   * `PF_ParamFlag_SUPERVISE`. Validated against ExtendScript
   * `canVaryOverTime` ground truth across the sample corpus.
   */
  get param_flags(): number {
    const pad: Uint8Array = getattr(this, "_pad_post", b(""));
    if (pad.length > 3) return pad[3];
    const data = "data" in this ? this.data : b("");
    if (len(data) > 51) return data[51];
    return 0;
  }

  /**
   * `PF_PUI_INVISIBLE` (bit 9 of the `PF_ParamUIFlags` u4 at
   * offsets 4-7): the parameter is hidden from the Effect Controls
   * and the Timeline, and expressions can never be set on it.
   *
   * Empirical: across the sample corpus, ExtendScript reports
   * `canSetExpression = false` for every parameter with this bit set.
   */
  get expressions_disabled(): boolean {
    const pre: Uint8Array = getattr(this, "_pad_pre", b(""));
    if (pre.length > 6) return (pre[6] & 0x02) !== 0;
    const data = "data" in this ? this.data : b("");
    if (len(data) > 6) return (data[6] & 0x02) !== 0;
    return false;
  }

  /** Decoded parameter name (from `_raw_name` up to first NUL). */
  get name(): string {
    const raw: Uint8Array = "_raw_name" in this ? this._raw_name : b("");
    if (!raw.length) return "";
    const nul = bytes_.find(raw, 0x00);
    if (nul >= 0) return decode(bytes_.slice(raw, 0, nul), "utf-8", "surrogateescape");
    return decode(raw, "utf-8", "surrogateescape");
  }

  set name(value: string) {
    const encoded = bytes_.slice(encode(value, "utf-8", "surrogateescape"), 0, 31);
    this._raw_name = bytes_.concat(encoded, bytes_.repeat(b("\x00"), 32 - encoded.length));
  }
}
define(PardChunk, {
  chunk_type: field({ default: "pard" }),
});
register("pard")(PardChunk);

/**
 * Generic pard for control types without specialized body parsing.
 *
 * Covers SDK `PF_ParamType` values 0 (LAYER), 9 (NO_DATA),
 * 11 (ARBITRARY_DATA), 12 (PATH), 13 (GROUP_START), 14 (GROUP_END)
 * and 15 (BUTTON).
 * All are 148 bytes: 56-byte header + 92-byte body.
 */
export class GenericPardChunk extends PardChunk {
  declare _pad_pre: Uint8Array;
  declare _raw_name: Uint8Array;
  declare _pad_post: Uint8Array;
  declare _body: Uint8Array;
}
define(GenericPardChunk, {
  _pad_pre: bytesField(15, { repr: false }),
  property_control_type: u1Field(),
  _raw_name: bytesField(32, { repr: false }),
  _pad_post: bytesField(8, { repr: false }),
  _body: bytesField(92, { repr: false }),
});

/** `bytes(list_of_ints)`: raises like CPython outside 0..255 instead of wrapping. */
export function _bytesFromInts(value: number[]): Uint8Array {
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    const v = value[i];
    if (typeof v !== "number" || !Number.isInteger(v)) throw new TypeError_(`'${typeof v}' object cannot be interpreted as an integer`);
    if (v < 0 || v > 255) throw new ValueError("bytes must be in range(0, 256)");
    out[i] = v;
  }
  return out;
}

/**
 * Color control (type 5, SDK `PF_ColorDef`): 4xB value and 4xB
 * default, both alpha, red, green, blue. The rest of the body is leftover
 * memory, not a field (zeros in most samples, pointer-like patterns and
 * match-name fragments in others), kept as trailing bytes.
 */
export class ColorPardChunk extends PardChunk {
  declare _pad_pre: Uint8Array;
  declare _raw_name: Uint8Array;
  declare _pad_post: Uint8Array;
  declare _last_color: Uint8Array;
  declare _default_color: Uint8Array;

  get last_color(): number[] {
    return Array.from(this._last_color);
  }

  set last_color(value: number[]) {
    this._last_color = _bytesFromInts(value);
  }

  get default_color(): number[] {
    return Array.from(this._default_color);
  }

  set default_color(value: number[]) {
    this._default_color = _bytesFromInts(value);
  }
}
define(ColorPardChunk, {
  _pad_pre: bytesField(15, { repr: false }),
  property_control_type: u1Field({ default: 5 }),
  _raw_name: bytesField(32, { repr: false }),
  _pad_post: bytesField(8, { repr: false }),
  _last_color: bytesField(4, { repr: false }),
  _default_color: bytesField(4, { repr: false }),
});

/**
 * Integer slider (type 1, SDK `PF_Param_SLIDER` / `PF_SliderDef`).
 *
 * Body: s4 value, 32s value_str, 32s value_desc, s4 valid_min,
 * s4 valid_max, s4 slider_min, s4 slider_max, s4 default. The valid
 * range is what ExtendScript reports as `minValue`/`maxValue`;
 * `default` is the parameter's factory default value.
 */
export class IntegerPardChunk extends PardChunk {
  declare _pad_pre: Uint8Array;
  declare _raw_name: Uint8Array;
  declare _pad_post: Uint8Array;
  declare last_value: number;
  declare _value_str: Uint8Array;
  declare _value_desc: Uint8Array;
  declare valid_min: number;
  declare valid_max: number;
  declare slider_min: number | null;
  declare slider_max: number | null;
  declare default_: number | null;
}
define(IntegerPardChunk, {
  _pad_pre: bytesField(15, { repr: false }),
  property_control_type: u1Field({ default: 1 }),
  _raw_name: bytesField(32, { repr: false }),
  _pad_post: bytesField(8, { repr: false }),
  last_value: s4Field(),
  _value_str: bytesField(32, { repr: false }),
  _value_desc: bytesField(32, { repr: false }),
  valid_min: s4Field(),
  valid_max: s4Field(),
  slider_min: s4Field({ optional: true, default: null }),
  slider_max: s4Field({ optional: true, default: null }),
  default_: s4Field({ optional: true, default: null }),
});

/**
 * Fixed-point slider (type 2, SDK `PF_Param_FIX_SLIDER` /
 * `PF_FixedSliderDef`).
 *
 * Body: `PF_Fixed` (16.16 fixed point, `raw / 65536`) value, 32s
 * value_str, 32s value_desc, then PF_Fixed valid_min / valid_max
 * (what ExtendScript reports as `minValue`/`maxValue`), PF_Fixed
 * slider_min / slider_max (the UI slider range) and PF_Fixed
 * default (the parameter's factory default value).
 */
export class ScalarPardChunk extends PardChunk {
  declare _pad_pre: Uint8Array;
  declare _raw_name: Uint8Array;
  declare _pad_post: Uint8Array;
  declare last_value_raw: number;
  declare _value_str: Uint8Array;
  declare _value_desc: Uint8Array;
  declare valid_min_raw: number;
  declare valid_max_raw: number;
  declare slider_min_raw: number;
  declare slider_max_raw: number;
  declare default_raw: number | null;

  get last_value(): number {
    return this.last_value_raw / 65536;
  }

  get valid_min(): number {
    return this.valid_min_raw / 65536;
  }

  get valid_max(): number {
    return this.valid_max_raw / 65536;
  }

  get slider_min(): number {
    return this.slider_min_raw / 65536;
  }

  get slider_max(): number {
    return this.slider_max_raw / 65536;
  }

  get default_(): number | null {
    return this.default_raw == null ? null : this.default_raw / 65536;
  }
}
define(ScalarPardChunk, {
  _pad_pre: bytesField(15, { repr: false }),
  property_control_type: u1Field({ default: 2 }),
  _raw_name: bytesField(32, { repr: false }),
  _pad_post: bytesField(8, { repr: false }),
  last_value_raw: s4Field(),
  _value_str: bytesField(32, { repr: false }),
  _value_desc: bytesField(32, { repr: false }),
  valid_min_raw: s4Field(),
  valid_max_raw: s4Field(),
  slider_min_raw: s4Field(),
  slider_max_raw: s4Field(),
  default_raw: s4Field({ optional: true, default: null }),
});

/**
 * Angle control (type 3, SDK `PF_AngleDef`).
 *
 * Body: `PF_Fixed` (16.16 fixed point, `raw / 65536`) value, then
 * PF_Fixed default (the parameter's factory default value).
 */
export class AnglePardChunk extends PardChunk {
  declare _pad_pre: Uint8Array;
  declare _raw_name: Uint8Array;
  declare _pad_post: Uint8Array;
  declare last_value_raw: number;
  declare default_raw: number | null;

  get last_value(): number {
    return this.last_value_raw / 65536;
  }

  get default_(): number | null {
    return this.default_raw == null ? null : this.default_raw / 65536;
  }
}
define(AnglePardChunk, {
  _pad_pre: bytesField(15, { repr: false }),
  property_control_type: u1Field({ default: 3 }),
  _raw_name: bytesField(32, { repr: false }),
  _pad_post: bytesField(8, { repr: false }),
  last_value_raw: s4Field(),
  default_raw: s4Field({ optional: true, default: null }),
});

/** Boolean control (type 4): u4 last_value, u1 default. */
export class BooleanPardChunk extends PardChunk {
  declare _pad_pre: Uint8Array;
  declare _raw_name: Uint8Array;
  declare _pad_post: Uint8Array;
  declare last_value: number;
  declare default_: number;
}
define(BooleanPardChunk, {
  _pad_pre: bytesField(15, { repr: false }),
  property_control_type: u1Field({ default: 4 }),
  _raw_name: bytesField(32, { repr: false }),
  _pad_post: bytesField(8, { repr: false }),
  last_value: u4Field(),
  default_: u1Field(),
});

/**
 * 2D point control (type 6, SDK `PF_PointDef`).
 *
 * Body: `PF_Fixed` (16.16) value x / y, 3 reserved bytes,
 * `restrict_bounds`, then `PF_Fixed` default x / y in percent of the
 * layer size. The cached value comes in two forms: a fraction of the
 * layer size (0.5 = centre), or equal to the percent default.
 */
export class TwoDPardChunk extends PardChunk {
  declare _pad_pre: Uint8Array;
  declare _raw_name: Uint8Array;
  declare _pad_post: Uint8Array;
  declare last_value_x_raw: number;
  declare last_value_y_raw: number;
  declare _reserved_40: Uint8Array;
  declare restrict_bounds: number;
  declare default_x_raw: number;
  declare default_y_raw: number;

  get last_value_x(): number {
    return this.last_value_x_raw * (1.0 / 128);
  }

  get last_value_y(): number {
    return this.last_value_y_raw * (1.0 / 128);
  }

  /** Default x / y, in percent of the layer width / height. */
  get default_(): number[] {
    return [this.default_x_raw / 65536, this.default_y_raw / 65536];
  }
}
define(TwoDPardChunk, {
  _pad_pre: bytesField(15, { repr: false }),
  property_control_type: u1Field({ default: 6 }),
  _raw_name: bytesField(32, { repr: false }),
  _pad_post: bytesField(8, { repr: false }),
  last_value_x_raw: s4Field(),
  last_value_y_raw: s4Field(),
  _reserved_40: bytesField(3, { repr: false }),
  restrict_bounds: u1Field(),
  default_x_raw: s4Field(),
  default_y_raw: s4Field(),
});

/**
 * Popup control (type 7, SDK `PF_PopupDef`): s4 value, s2 number of
 * choices, s2 default (1-based). The choice-names pointer that follows
 * in the SDK record is leftover memory, kept as trailing bytes.
 */
export class EnumPardChunk extends PardChunk {
  declare _pad_pre: Uint8Array;
  declare _raw_name: Uint8Array;
  declare _pad_post: Uint8Array;
  declare last_value: number;
  declare nb_options: number;
  declare default_: number;
}
define(EnumPardChunk, {
  _pad_pre: bytesField(15, { repr: false }),
  property_control_type: u1Field({ default: 7 }),
  _raw_name: bytesField(32, { repr: false }),
  _pad_post: bytesField(8, { repr: false }),
  last_value: u4Field(),
  nb_options: s2Field(),
  default_: s2Field(),
});

/**
 * Float slider (type 10, SDK `PF_Param_FLOAT_SLIDER` /
 * `PF_FloatSliderDef`).
 *
 * Body: f8 value, f8 phase, 32s value_desc, then f4 valid_min /
 * valid_max (what ExtendScript reports as `minValue`/`maxValue`;
 * non-finite means that side is unbounded), f4 slider_min /
 * slider_max (the UI slider range) and f4 default (the parameter's
 * factory default value).
 */
export class SliderPardChunk extends PardChunk {
  declare _pad_pre: Uint8Array;
  declare _raw_name: Uint8Array;
  declare _pad_post: Uint8Array;
  declare last_value: number;
  declare phase: number;
  declare _value_desc: Uint8Array;
  declare valid_min: number;
  declare valid_max: number;
  declare slider_min: number;
  declare slider_max: number;
  declare default_: number | null;
  declare _precision: number | null;
  /** SDK `PF_ValueDisplayFlags`: bit 0 (PERCENT) is the only flag AE
   * writes reliably for float sliders (fixed-point sliders leave it 0). */
  declare display_flags: number | null;

  /** SDK `PF_ValueDisplayFlag_PERCENT` (bit 0). */
  get displays_percent(): boolean {
    const flags = this.display_flags;
    return flags != null && (flags & 0x01) !== 0;
  }
}
define(SliderPardChunk, {
  _pad_pre: bytesField(15, { repr: false }),
  property_control_type: u1Field({ default: 10 }),
  _raw_name: bytesField(32, { repr: false }),
  _pad_post: bytesField(8, { repr: false }),
  last_value: f8Field(),
  phase: f8Field(),
  _value_desc: bytesField(32, { repr: false }),
  valid_min: f4Field(),
  valid_max: f4Field(),
  slider_min: f4Field(),
  slider_max: f4Field(),
  default_: f4Field({ optional: true, default: null }),
  _precision: u2Field({ optional: true, default: null, repr: false }),
  display_flags: u2Field({ optional: true, default: null }),
});

/**
 * 3D point control (type 18, SDK `PF_Point3DDef`): f8 value x / y /
 * z, then f8 default x / y / z in percent of the layer size. The cached
 * value is a fraction of the layer size or equal to the percent default,
 * as for a 2D point.
 */
export class ThreeDPardChunk extends PardChunk {
  declare _pad_pre: Uint8Array;
  declare _raw_name: Uint8Array;
  declare _pad_post: Uint8Array;
  declare last_value_x_raw: number;
  declare last_value_y_raw: number;
  declare last_value_z_raw: number;
  declare default_x: number;
  declare default_y: number;
  declare default_z: number;

  /** Default x / y / z, in percent of the layer size. */
  get default_(): number[] {
    return [this.default_x, this.default_y, this.default_z];
  }

  get last_value_x(): number {
    return this.last_value_x_raw * 512;
  }

  get last_value_y(): number {
    return this.last_value_y_raw * 512;
  }

  get last_value_z(): number {
    return this.last_value_z_raw * 512;
  }
}
define(ThreeDPardChunk, {
  _pad_pre: bytesField(15, { repr: false }),
  property_control_type: u1Field({ default: 18 }),
  _raw_name: bytesField(32, { repr: false }),
  _pad_post: bytesField(8, { repr: false }),
  last_value_x_raw: f8Field(),
  last_value_y_raw: f8Field(),
  last_value_z_raw: f8Field(),
  default_x: f8Field(),
  default_y: f8Field(),
  default_z: f8Field(),
});

// ---------------------------------------------------------------------------
// dwga - working gamma selector (1 byte)
// ---------------------------------------------------------------------------

/**
 * Working gamma selector chunk (4 bytes).
 *
 * The first byte selects the gamma (0 = 2.2, non-zero = 2.4)
 */
export class DwgaChunk extends Chunk {
  declare chunk_type: string;
  declare working_gamma_selector: number;
  declare _reserved_01: Uint8Array;

  /** Working gamma (2.2 or 2.4). */
  get working_gamma(): number {
    return this.working_gamma_selector === 0 ? 2.2 : 2.4;
  }

  set working_gamma(value: number) {
    this.working_gamma_selector = value === 2.2 ? 0 : 1;
  }
}
define(DwgaChunk, {
  chunk_type: field({ default: "dwga" }),
  working_gamma_selector: u1Field(),
  _reserved_01: bytesField(3, { repr: false }),
});
register("dwga")(DwgaChunk);

// ---------------------------------------------------------------------------
// ewot - effect workspace outline entries
// ---------------------------------------------------------------------------

/**
 * Single effect workspace outline entry (4 bytes).
 *
 * Bit 7 of byte 0 marks child-property entries; bit 6 marks selected.
 */
export class EwotItem extends FmtItem {
  declare _flags: number;
  declare _data: Uint8Array;
  declare is_child_property: boolean;
  declare selected: boolean;
}
define(EwotItem, {
  _flags: u1Field(),
  _data: bytesField(3),
});
descriptor(EwotItem, "is_child_property", new BitField("_flags", 7));
descriptor(EwotItem, "selected", new BitField("_flags", 6));

/**
 * Effect workspace outline entries.
 *
 * 4-byte count header followed by `count` × 4-byte entries.
 */
export class EwotChunk extends Chunk {
  declare chunk_type: string;
  declare num_entries: number;
  declare items: EwotItem[];
}
define(EwotChunk, {
  chunk_type: field({ default: "ewot" }),
  num_entries: u4Field(),
  items: itemsField(EwotItem, 4),
});
register("ewot")(EwotChunk);

// ---------------------------------------------------------------------------
// otln - composition panel outline entries
// ---------------------------------------------------------------------------

/**
 * Single comp panel outline entry (4 bytes).
 *
 * Bit 7 = collapsed, bit 6 = selected, bit 5 = is_property,
 * bit 3 = is_sub_entry.  `entry_type == 68` marks layer boundaries.
 */
export class OtlnItem extends FmtItem {
  declare _flags: number;
  declare _unnamed6: Uint8Array;
  declare entry_type: number;
  declare collapsed: boolean;
  declare selected: boolean;
  declare is_property: boolean;
  declare is_sub_entry: boolean;

  /** True when this entry is a per-layer boundary marker. */
  get is_layer_marker(): boolean {
    return this.entry_type === 68;
  }
}
define(OtlnItem, {
  _flags: u1Field(),
  _unnamed6: bytesField(2),
  entry_type: u1Field(),
});
descriptor(OtlnItem, "collapsed", new BitField("_flags", 7));
descriptor(OtlnItem, "selected", new BitField("_flags", 6));
descriptor(OtlnItem, "is_property", new BitField("_flags", 5));
descriptor(OtlnItem, "is_sub_entry", new BitField("_flags", 3));

/**
 * Comp panel outline entries.
 *
 * 4-byte count header followed by `count` × 4-byte entries.
 */
export class OtlnChunk extends Chunk {
  declare chunk_type: string;
  declare num_entries: number;
  declare items: OtlnItem[];
}
define(OtlnChunk, {
  chunk_type: field({ default: "otln" }),
  num_entries: u4Field(),
  items: itemsField(OtlnItem, 4),
});
register("otln")(OtlnChunk);

export const _PARD_VARIANTS = new Map<number, typeof PardChunk>([
  [0, GenericPardChunk],
  [1, IntegerPardChunk],
  [2, ScalarPardChunk],
  [3, AnglePardChunk],
  [4, BooleanPardChunk],
  [5, ColorPardChunk],
  [6, TwoDPardChunk],
  [7, EnumPardChunk],
  [9, GenericPardChunk],
  [10, SliderPardChunk],
  [11, GenericPardChunk],
  [12, GenericPardChunk],
  [13, GenericPardChunk],
  [14, GenericPardChunk],
  [15, GenericPardChunk],
  [18, ThreeDPardChunk],
]);

// Every variant redeclares `property_control_type` as a field over the base getter.
for (const variant of [
  GenericPardChunk,
  ColorPardChunk,
  IntegerPardChunk,
  ScalarPardChunk,
  AnglePardChunk,
  BooleanPardChunk,
  TwoDPardChunk,
  EnumPardChunk,
  SliderPardChunk,
  ThreeDPardChunk,
]) {
  shadowProperty(variant, "property_control_type");
}

// ---------------------------------------------------------------------------
// fth5 - mask feather points (variable length, mixed endianness)
// ---------------------------------------------------------------------------

/**
 * A single variable-width mask feather point (32 bytes).
 *
 * Integer fields are little-endian; float fields are big-endian.
 */
export class FeatherPointItem extends FmtItem {
  /** Segment index (0-based, LE u4). */
  declare seg_loc: number;
  /** Interpolation type raw value (LE u4). 0=non-Hold, 2=Hold. */
  declare interp_raw: number;
  /** Relative position on the segment (0.0 to 1.0, BE f8). */
  declare rel_seg_loc: number;
  /** Feather radius. Negative=inner, positive=outer (BE f8). */
  declare radius: number;
  /** Corner angle percentage 0-100 (BE f4). */
  declare corner_angle: number;
  /** Feather tension 0.0-1.0 (BE f4). */
  declare tension: number;
}
define(FeatherPointItem, {
  seg_loc: u4Field({ endian: "<" }),
  interp_raw: u4Field({ endian: "<" }),
  rel_seg_loc: f8Field({ default: 0.0 }),
  radius: f8Field({ default: 0.0 }),
  corner_angle: f4Field({ default: 0.0 }),
  tension: f4Field({ default: 0.0 }),
});

export const _FTH5_ITEM_SIZE = 32;

/** Variable-width mask feather points (32 bytes per point). */
export class Fth5Chunk extends Chunk {
  declare chunk_type: string;
  declare points: FeatherPointItem[];
}
define(Fth5Chunk, {
  chunk_type: field({ default: "fth5" }),
  points: itemsField(FeatherPointItem, 32),
});
register("fth5")(Fth5Chunk);

// ---------------------------------------------------------------------------
// omtn - per-vertex RotoBezier tensions of a shape value
// ---------------------------------------------------------------------------

/** One vertex's RotoBezier tension (BE f4). */
export class TensionItem extends FmtItem {
  declare value: number;
}
define(TensionItem, {
  value: f4Field({ default: 0.0 }),
});

/**
 * Per-vertex RotoBezier tensions of a mask shape value, one float per
 * vertex (0 = smoothest, 1 = a corner). Empty when the shape was never
 * given tensions.
 */
export class OmtnChunk extends Chunk {
  declare chunk_type: string;
  declare tensions: TensionItem[];
}
define(OmtnChunk, {
  chunk_type: field({ default: "omtn" }),
  tensions: itemsField(TensionItem, 4),
});
register("omtn")(OmtnChunk);

// ---------------------------------------------------------------------------
// Source / footage utility chunks
// ---------------------------------------------------------------------------
/** Application color profile ID (16 bytes, all 0xff = unmanaged). */
export class ApidChunk extends Chunk {
  declare chunk_type: string;
  declare data: Uint8Array;
}
define(ApidChunk, {
  chunk_type: field({ default: "apid" }),
  data: field({ default: bytes_.repeat(b("\xff"), 16) }),
});
register("apid")(ApidChunk);

/** Embedded color profile ID (16 bytes, all 0xff = unmanaged). */
export class EpidChunk extends Chunk {
  declare chunk_type: string;
  declare data: Uint8Array;
}
define(EpidChunk, {
  chunk_type: field({ default: "epid" }),
  data: field({ default: bytes_.repeat(b("\xff"), 16) }),
});
register("epid")(EpidChunk);

/**
 * Embedded-profile-present flag.
 *
 * AE writes this (value 1) when the source file carries an embedded color
 * profile; the `Utf8` chunk that follows it in `LIST:CLRS` holds the
 * profile's name (e.g. `Coated FOGRA39 (ISO 12647-2:2004)`). Absent when the
 * source has no embedded profile.
 */
export class EmpdChunk extends Chunk {
  declare chunk_type: string;
  declare value: boolean;
}
define(EmpdChunk, {
  chunk_type: field({ default: "empd" }),
  value: boolField({ default: true }),
});
register("empd")(EmpdChunk);

/** Linearization setting (4 bytes little-endian). */
export class LinlChunk extends Chunk {
  declare chunk_type: string;
  declare value: number;
}
define(LinlChunk, {
  chunk_type: field({ default: "linl" }),
  value: u4Field({ endian: "<", default: 2 }),
});
register("linl")(LinlChunk);

/** Embed profile flag. */
export class EmbpChunk extends Chunk {
  declare chunk_type: string;
  declare value: boolean;
}
define(EmbpChunk, {
  chunk_type: field({ default: "embp" }),
  value: boolField({ default: true }),
});
register("embp")(EmbpChunk);

/** Input profile working space. */
export class IpwsChunk extends Chunk {
  declare chunk_type: string;
  declare value: number;
}
define(IpwsChunk, {
  chunk_type: field({ default: "ipws" }),
  value: u1Field({ default: 1 }),
});
register("ipws")(IpwsChunk);

/** Display color UI flag (solid sources only). */
export class DcuiChunk extends Chunk {
  declare chunk_type: string;
  declare value: boolean;
}
define(DcuiChunk, {
  chunk_type: field({ default: "dcui" }),
  value: boolField({ default: true }),
});
register("dcui")(DcuiChunk);

/** Preserve RGB flag (solid sources only). */
export class PrgbChunk extends Chunk {
  declare chunk_type: string;
  declare value: number;
}
define(PrgbChunk, {
  chunk_type: field({ default: "prgb" }),
  value: u1Field({ default: 1 }),
});
register("prgb")(PrgbChunk);

/** Monitor color space flag. */
export class McspChunk extends Chunk {
  declare chunk_type: string;
  declare value: boolean;
}
define(McspChunk, {
  chunk_type: field({ default: "Mcsp" }),
  value: boolField({ default: true }),
});
register("Mcsp")(McspChunk);

/** Output color space flag. */
export class OcspChunk extends Chunk {
  declare chunk_type: string;
  declare value: boolean;
}
define(OcspChunk, {
  chunk_type: field({ default: "ocsp" }),
  value: boolField({ default: true }),
});
register("ocsp")(OcspChunk);

/** HDR mode flag. */
export class HdrmChunk extends Chunk {
  declare chunk_type: string;
  declare value: boolean;
}
define(HdrmChunk, {
  chunk_type: field({ default: "hdrm" }),
  value: boolField({ default: true }),
});
register("hdrm")(HdrmChunk);

/** Media start info (8 bytes). */
export class StrtChunk extends Chunk {
  declare chunk_type: string;
  declare _reserved_00: Uint8Array;
  declare fps_byte: number;
  declare _reserved_05: Uint8Array;
}
define(StrtChunk, {
  chunk_type: field({ default: "strt" }),
  _reserved_00: bytesField(4, { repr: false }),
  fps_byte: u1Field({ default: 1 }),
  _reserved_05: bytesField(3, { repr: false }),
});
register("strt")(StrtChunk);

/** Drop frame flag. */
export class DropChunk extends Chunk {
  declare chunk_type: string;
  declare value: boolean;
}
define(DropChunk, {
  chunk_type: field({ default: "drop" }),
  value: boolField({ default: true }),
});
register("drop")(DropChunk);

/** Footage interpretation global info (16 bytes). */
export class FtgiChunk extends Chunk {
  declare chunk_type: string;
  declare start_offset: number;
  declare frame_rate_num: number;
  declare end_frame: number;
  declare time_base: number;
}
define(FtgiChunk, {
  chunk_type: field({ default: "ftgi" }),
  start_offset: u4Field(),
  frame_rate_num: u4Field({ default: 1 }),
  end_frame: u4Field({ default: 0xffffffff }),
  time_base: u4Field({ default: 600 }),
});
register("ftgi")(FtgiChunk);
