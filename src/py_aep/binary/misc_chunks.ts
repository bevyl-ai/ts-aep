/**
 * Miscellaneous chunk types: prin, mkif, shph, NmHd, fips, pard, fth5, dwga.
 *
 * Fixed-layout chunks use `fmtField()` and `BitField`.
 * Fth5Chunk uses `itemsField()` for repeating feather points.
 * PardChunk and PrdaChunk use variant subclass dispatch for polymorphic layouts.
 */

import { uuid4Bytes } from "../../pyrt/uuid.ts";
import { define, field, b, bytes_, decode, encode, assert, round, descriptor, ValueError } from "../../pyrt/index.ts";
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
  declare chunkType: string;
  declare _reserved00: Uint8Array;
  /** Internal match name (e.g. 'ADBE Advanced 3d'). */
  declare matchName: string;
  /** Human-readable name (e.g. 'Classic 3D'). */
  declare displayName: string;
  declare _reserved68: Uint8Array;
  declare _endMarker: Uint8Array;
}
define(PrinChunk, {
  chunkType: field({ default: "prin" }),
  _reserved00: bytesField(4, { repr: false }),
  matchName: asciiField(48, { default: "ADBE Escher" }),
  displayName: asciiField(48, { default: "Classic 3D" }),
  _reserved68: bytesField(3, { repr: false }),
  _endMarker: bytesField(1, { default: b("\x01"), repr: false }),
});
register("prin")(PrinChunk);

// ---------------------------------------------------------------------------
// sfdt - subfolder data (4 bytes)
// ---------------------------------------------------------------------------

/** Subfolder data chunk. */
export class SfdtChunk extends Chunk {
  declare chunkType: string;
  declare value: number;
}
define(SfdtChunk, {
  chunkType: field({ default: "sfdt" }),
  value: u4Field({ default: 1 }),
});
register("sfdt")(SfdtChunk);

// ---------------------------------------------------------------------------
// pgui - 16-byte GUID
// ---------------------------------------------------------------------------

/** 16-byte GUID chunk. */
export class PguiChunk extends Chunk {
  declare chunkType: string;
  declare guid: Uint8Array;

  /** Build a pgui with a fresh random GUID. */
  static new_(): PguiChunk {
    // uuid4().bytes: random bits with the version nibble and RFC 4122 variant set.
    return new this({ guid: uuid4Bytes() });
  }
}
define(PguiChunk, {
  chunkType: field({ default: "pgui" }),
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
  declare chunkType: string;

  static read(
    fp: IO,
    size: number,
    kw: { chunkType?: string; rendererMatchName?: string } = {},
  ): PrdaChunk {
    const { chunkType = "", rendererMatchName = "" } = kw;
    if (this !== PrdaChunk) {
      const result = super.read(fp, size, { chunkType });
      assert(result instanceof PrdaChunk);
      return result;
    }
    const variant = _PRDA_VARIANTS.get(rendererMatchName);
    if (variant == null || variant[1] !== size) {
      // preserve unknown raw bytes
      return new this({ chunkType, data: readBytes(fp, size) });
    }
    return variant[0].read(fp, size, { chunkType });
  }
}
define(PrdaChunk, {
  chunkType: field({ default: "prda" }),
});
register("prda")(PrdaChunk);

/** Classic 3D (`ADBE Escher`) options, 12 bytes. */
export class ClassicPrdaChunk extends PrdaChunk {
  declare _version: number;
  // Offset 4 seems likely to be unique per-renderer, but this is not fully proven.
  // Both Classic and RayTraced share the same values (version=1, tag=0), so this
  // works for now as RayTraced is deprecated. If a future renderer shares the same
  // tag value as another existing renderer, we should rename this to `_unknown_04`.
  declare _rendererTag: number;
  declare shadowMapResolution: number;
  /** Index into the Shadow Map Resolution dropdown, 0='Comp Size',
   * 1=250, 2=500, 3=750, 4=1000, 5=1500, 6=2000, 7=3000, 8=4000. */
}
define(ClassicPrdaChunk, {
  _version: u4Field({ default: 1, repr: false }),
  _rendererTag: u4Field({ default: 0, repr: false }),
  shadowMapResolution: u4Field({ default: 0 }),
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
  declare _rendererTag: number;
  /** Renderer quality, 1-125. */
  declare quality: number;
  declare _reserved12: number;
  declare _reserved16: number;
  /** Environment light shadow resolution:
   * 0='Half (2MB)', 1='Full (16MB)', 2='Double (128MB)'. */
  declare resolution: number;
  /** Environment light shadow smoothness, 1-20. */
  declare smoothness: number;
  /** Casting box size on X, as a fraction of comp width. */
  declare castingBoxSizeX: number;
  /** Casting box size on Y, as a fraction of comp width. */
  declare castingBoxSizeY: number;
  /** Casting box size on Z, as a fraction of comp width. */
  declare castingBoxSizeZ: number;
  /** Casting box centre on X, offset from comp centre, fraction of width. */
  declare castingBoxCenterX: number;
  /** Casting box centre on Y, offset from comp centre, fraction of height. */
  declare castingBoxCenterY: number;
  /** Casting box centre on Z, as a fraction of comp width. */
  declare castingBoxCenterZ: number;
}
define(AdvancedPrdaChunk, {
  _version: u4Field({ default: 1, repr: false }),
  _rendererTag: u4Field({ default: 3, repr: false }),
  quality: u4Field({ default: 8 }),
  _reserved12: u4Field({ default: 1, repr: false }),
  _reserved16: u4Field({ default: 0, repr: false }),
  resolution: u4Field({ default: 1, endian: "<" }),
  smoothness: u4Field({ default: 3, endian: "<" }),
  castingBoxSizeX: f4Field({ default: 1.0, endian: "<" }),
  castingBoxSizeY: f4Field({ default: 1.0, endian: "<" }),
  castingBoxSizeZ: f4Field({ default: 1.0, endian: "<" }),
  castingBoxCenterX: f4Field({ default: 0.0, endian: "<" }),
  castingBoxCenterY: f4Field({ default: 0.0, endian: "<" }),
  castingBoxCenterZ: f4Field({ default: 0.0, endian: "<" }),
});

/** Cinema 4D (`ADBE Ernst`) options, 20 bytes. */
export class Cinema4DPrdaChunk extends PrdaChunk {
  declare _version: number;
  declare _rendererTag: number;
  /** Renderer quality, 1-99. */
  declare quality: number;
  declare _reserved12: number;
  declare _reserved16: number;
}
define(Cinema4DPrdaChunk, {
  _version: u4Field({ default: 1, repr: false }),
  _rendererTag: u4Field({ default: 1, repr: false }),
  quality: u4Field({ default: 25 }),
  _reserved12: u4Field({ default: 1, repr: false }),
  _reserved16: u4Field({ default: 0, repr: false }),
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
  declare _rendererTag: number;
  declare _unknown08: number;
  declare _unknown12: number;
}
define(RayTracedPrdaChunk, {
  _version: u4Field({ default: 1, repr: false }),
  _rendererTag: u4Field({ default: 0, repr: false }),
  _unknown08: u4Field({ default: 3, repr: false }),
  _unknown12: u4Field({ default: 1, repr: false }),
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
  declare chunkType: string;
  /** 1 = inverted, 0 = normal. */
  declare inverted: boolean;
  /** 1 = locked, 0 = unlocked. */
  declare locked: boolean;
  /** 0 = Same as Layer, 1 = Off, 2 = On. */
  declare maskMotionBlur: number;
  /** 0 = Smooth, 1 = Linear. */
  declare maskFeatherFalloff: number;
  declare _reserved04: Uint8Array;
  /** SDK `PF_MaskMode`: 0=None, 1=Add, 2=Subtract, 3=Intersect,
   * 4=Lighten, 5=Darken, 6=Difference. */
  declare mode: number;
  /** 1-based id assigned at mask creation (creation order within the
   * layer). */
  declare maskId: number;
  declare _reserved0c: Uint8Array;
  declare colorR: number;
  declare colorG: number;
  declare colorB: number;

  /** Mask color as [R, G, B] in 0.0-1.0 range. */
  get color(): number[] {
    return [this.colorR / 255, this.colorG / 255, this.colorB / 255];
  }

  set color(value: number[]) {
    this.colorR = round(value[0] * 255);
    this.colorG = round(value[1] * 255);
    this.colorB = round(value[2] * 255);
  }
}
define(MkifChunk, {
  chunkType: field({ default: "mkif" }),
  inverted: boolField(),
  locked: boolField(),
  maskMotionBlur: u1Field(),
  maskFeatherFalloff: u1Field(),
  _reserved04: bytesField(2, { repr: false }),
  mode: u2Field(),
  maskId: u4Field(),
  _reserved0c: bytesField(33, { repr: false }),
  colorR: u1Field(),
  colorG: u1Field(),
  colorB: u1Field(),
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
  declare chunkType: string;
  declare _reserved00: Uint8Array;
  /** Byte 3 bit flags: bit 0 = `normalized`, bit 3 = `open`. Defaults to
   * `1` (normalized, closed). */
  declare _flags: number;
  /** Bounding-box left edge (x minimum). */
  declare topLeftX: number;
  /** Bounding-box top edge (y minimum). */
  declare topLeftY: number;
  /** Bounding-box right edge (x maximum). */
  declare bottomRightX: number;
  /** Bounding-box bottom edge (y maximum). */
  declare bottomRightY: number;
  declare _reserved14: Uint8Array;
  /** True when the ldat points are stored as `[0, 1]` fractions of the
   * bounding box (AE's universal encoding). */
  declare normalized: boolean;
  /** True when the path is open (not closed). */
  declare open: boolean;

  static {
    descriptor(this, "normalized", new BitField("_flags", 0));
    descriptor(this, "open", new BitField("_flags", 3));
  }
}
define(ShphChunk, {
  chunkType: field({ default: "shph" }),
  _reserved00: bytesField(3, { default: b("\xb3\xde\x02"), repr: false }),
  _flags: u1Field({ default: 1, repr: false }),
  topLeftX: f4Field(),
  topLeftY: f4Field(),
  bottomRightX: f4Field(),
  bottomRightY: f4Field(),
  _reserved14: bytesField(4, { default: b("\x01\x00\x00\x00"), repr: false }),
});
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
  declare chunkType: string;
  declare _reserved00: Uint8Array;
  /** Byte 3: bit 2=unknown, bit 1=protected_region, bit 0=navigation. */
  declare _markerFlags: number;
  /** Number of cue-point parameter key/value pairs.
   *
   * Must match the number of trailing Utf8 pairs in the Nmrd list or
   * AE ignores the parameters entirely. */
  declare numParams: number;
  /** Duration dividend: seconds = `duration_value / duration_scale`. */
  declare durationValue: number;
  /** Duration divisor. 600 on every marker a script creates or whose
   * duration a script sets (AE 2026, any composition frame rate); markers
   * edited in the UI also store 24, 25 or 24576. AE 2026 reads 0 as 600. */
  declare durationScale: number;
  /** Label color index. */
  declare label: number;
  /** Bytes 17-19: trailing padding. */
  declare _reserved11: Uint8Array;
  declare protectedRegion: boolean;
  declare navigation: boolean;

  /** Duration in seconds. */
  get durationSeconds(): number {
    return this.durationValue / (this.durationScale || 600);
  }

  set durationSeconds(value: number) {
    this.durationValue = round(value * 600);
    this.durationScale = 600;
  }

  static {
    // BitField descriptors
    descriptor(this, "protectedRegion", new BitField("_markerFlags", 1));
    descriptor(this, "navigation", new BitField("_markerFlags", 0));
  }
}
define(NmhdChunk, {
  chunkType: field({ default: "NmHd" }),
  _reserved00: bytesField(3, { repr: false }),
  _markerFlags: u1Field({ repr: false }),
  numParams: u4Field(),
  durationValue: u4Field(),
  durationScale: u4Field({ default: 600 }),
  label: u1Field(),
  _reserved11: bytesField(3, { repr: false }),
});
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
  declare chunkType: string;
  declare _pad00: Uint8Array;
  /** Channel display mode (0=RGB, 1=Red, 2=Green, 3=Blue, 4=Alpha, 8=RGB Straight). */
  declare channels: number;
  declare _pad08: Uint8Array;
  /** Byte 11: bit 1=proportional_grid, bit 0=title_action_safe. */
  declare _gridSafeFlags: number;
  /** Byte 12: bit 2=draft3d. */
  declare _draftFlags: number;
  /** Byte 13: bit 4=draft, bit 2=fast_draft, bit 0=adaptive. */
  declare _previewFlags: number;
  /** Byte 14: bit 7=region_of_interest, bit 6=rulers, bit 4=wireframe. */
  declare _viewFlags: number;
  /** Byte 15: bit 7=checkerboards, bit 4=mask_and_shape_path. */
  declare _displayFlags: number;
  declare _pad10: Uint8Array;
  /** Byte 23: bit 3=grid, bit 2=guides_snap, bit 1=guides_locked, bit 0=guides_visibility. */
  declare _guideFlags: number;
  declare _pad18: Uint8Array;
  declare roiTop: number;
  declare roiLeft: number;
  declare roiBottom: number;
  declare roiRight: number;
  declare _pad30: Uint8Array;
  /** Zoom mode (0=custom, 1=fit, 2=fit up to 100%). */
  declare zoomType: number;
  declare _pad46: Uint8Array;
  /** Zoom factor (1.0 = 100%). */
  declare zoom: number;
  /** Exposure value in stops (-40.0 to 40.0). */
  declare exposure: number;
  declare _pad54: number;
  /** Byte 85: bit 0=use_display_color_management. */
  declare _colorMgmtFlags: number;
  /** Byte 86: bit 0=auto_resolution. */
  declare _resolutionFlags: number;

  // -- BitField descriptors (not attrs fields) ---------------------------
  declare proportionalGrid: boolean;
  declare titleActionSafe: boolean;
  declare draft3d: boolean;
  declare fastPreviewDraft: boolean;
  declare fastPreviewFastDraft: boolean;
  declare fastPreviewAdaptive: boolean;
  declare regionOfInterest: boolean;
  declare rulers: boolean;
  declare fastPreviewWireframe: boolean;
  declare checkerboards: boolean;
  declare maskAndShapePath: boolean;
  declare grid: boolean;
  declare guidesSnap: boolean;
  declare guidesLocked: boolean;
  declare guidesVisibility: boolean;
  declare useDisplayColorManagement: boolean;
  declare autoResolution: boolean;

  /** Computed fast preview type (0=off, 1=adaptive, 2=draft, 3=fast_draft, 4=wireframe). */
  get fastPreviewType(): number {
    if (this.fastPreviewWireframe) return 4;
    if (this.fastPreviewFastDraft) return 3;
    if (this.fastPreviewDraft) return 2;
    if (this.fastPreviewAdaptive) return 1;
    return 0;
  }

  set fastPreviewType(value: number) {
    this.fastPreviewAdaptive = value === 1;
    this.fastPreviewDraft = value === 2;
    this.fastPreviewFastDraft = value === 3;
    this.fastPreviewWireframe = value === 4;
  }

  static {
    descriptor(this, "proportionalGrid", new BitField("_gridSafeFlags", 1));
    descriptor(this, "titleActionSafe", new BitField("_gridSafeFlags", 0));
    descriptor(this, "draft3d", new BitField("_draftFlags", 2));
    descriptor(this, "fastPreviewDraft", new BitField("_previewFlags", 4));
    descriptor(this, "fastPreviewFastDraft", new BitField("_previewFlags", 2));
    descriptor(this, "fastPreviewAdaptive", new BitField("_previewFlags", 0));
    descriptor(this, "regionOfInterest", new BitField("_viewFlags", 7));
    descriptor(this, "rulers", new BitField("_viewFlags", 6));
    descriptor(this, "fastPreviewWireframe", new BitField("_viewFlags", 4));
    descriptor(this, "checkerboards", new BitField("_displayFlags", 7));
    descriptor(this, "maskAndShapePath", new BitField("_displayFlags", 4));
    descriptor(this, "grid", new BitField("_guideFlags", 3));
    descriptor(this, "guidesSnap", new BitField("_guideFlags", 2));
    descriptor(this, "guidesLocked", new BitField("_guideFlags", 1));
    descriptor(this, "guidesVisibility", new BitField("_guideFlags", 0));
    descriptor(this, "useDisplayColorManagement", new BitField("_colorMgmtFlags", 0));
    descriptor(this, "autoResolution", new BitField("_resolutionFlags", 0));
  }
}
define(FipsChunk, {
  chunkType: field({ default: "fips" }),
  _pad00: bytesField(7, { repr: false }),
  channels: u1Field(),
  _pad08: bytesField(3, { repr: false }),
  _gridSafeFlags: u1Field({ repr: false }),
  _draftFlags: u1Field({ repr: false }),
  _previewFlags: u1Field({ repr: false }),
  _viewFlags: u1Field({ repr: false }),
  _displayFlags: u1Field({ repr: false }),
  _pad10: bytesField(7, { repr: false }),
  _guideFlags: u1Field({ repr: false }),
  _pad18: bytesField(16, { repr: false }),
  roiTop: u2Field(),
  roiLeft: u2Field(),
  roiBottom: u2Field(),
  roiRight: u2Field(),
  _pad30: bytesField(21, { repr: false }),
  zoomType: u1Field(),
  _pad46: bytesField(2, { repr: false }),
  zoom: f8Field(),
  exposure: f4Field(),
  _pad54: u1Field({ repr: false }),
  _colorMgmtFlags: u1Field({ default: 1, repr: false }),
  _resolutionFlags: u1Field({ repr: false }),
});
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
 * `propertyControlType` (the SDK `PF_ParamType`) at byte 15; the base
 * class dispatches to variant subclasses and unknown control types fall
 * back to raw bytes.
 *
 * Common header (56 bytes): 4s pad, u4 ui_flags (`PF_ParamUIFlags`),
 * 7s pad, B property_control_type, 32s name (UTF-8),
 * u4 param_flags (`PF_ParamFlags`), 4s pad.
 */
export class PardChunk extends Chunk {
  declare chunkType: string;
  declare _rawName: Uint8Array;

  /** Control type discriminator at byte 15 of the raw data. */
  get propertyControlType(): number {
    const data = "data" in this ? this.data : b("");
    if (data.length > 15) return data[15];
    return 0;
  }

  static read(
    fp: IO,
    size: number,
    kw: { chunkType?: string } = {},
  ): PardChunk {
    const { chunkType = "" } = kw;
    if (this !== PardChunk) {
      const result = super.read(fp, size, { chunkType });
      assert(result instanceof PardChunk);
      return result;
    }
    if (size < 56) return new this({ chunkType, data: readBytes(fp, size) });
    // Peek at discriminator (byte 15)
    const header = readBytes(fp, 16);
    const controlType = header[15];
    fp.seek(-16, 1);
    const variantCls = _PARD_VARIANTS.get(controlType) ?? PardChunk;
    if (variantCls === PardChunk) return new this({ chunkType, data: readBytes(fp, size) });
    return variantCls.read(fp, size, { chunkType });
  }

  /**
   * Low byte of the AE SDK `PF_ParamFlags` (u4 at offsets 48-51).
   *
   * Bit 1 (0x02) is `PF_ParamFlag_CANNOT_TIME_VARY`, bit 6 (0x40) is
   * `PF_ParamFlag_SUPERVISE`. Validated against ExtendScript
   * `canVaryOverTime` ground truth across the sample corpus.
   */
  get paramFlags(): number {
    const pad: Uint8Array = this._padPost ?? b("");
    if (pad.length > 3) return pad[3];
    const data = "data" in this ? this.data : b("");
    if (data.length > 51) return data[51];
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
  get expressionsDisabled(): boolean {
    const pre: Uint8Array = this._padPre ?? b("");
    if (pre.length > 6) return (pre[6] & 0x02) !== 0;
    const data = "data" in this ? this.data : b("");
    if (data.length > 6) return (data[6] & 0x02) !== 0;
    return false;
  }

  /** Decoded parameter name (from `_rawName` up to first NUL). */
  get name(): string {
    const raw: Uint8Array = "_rawName" in this ? this._rawName : b("");
    if (!raw.length) return "";
    const nul = bytes_.find(raw, 0x00);
    if (nul >= 0) return decode(bytes_.slice(raw, 0, nul), "utf-8", "surrogateescape");
    return decode(raw, "utf-8", "surrogateescape");
  }

  set name(value: string) {
    const encoded = bytes_.slice(encode(value, "utf-8", "surrogateescape"), 0, 31);
    this._rawName = bytes_.concat(encoded, bytes_.repeat(b("\x00"), 32 - encoded.length));
  }
}
define(PardChunk, {
  chunkType: field({ default: "pard" }),
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
  declare _padPre: Uint8Array;
  declare _rawName: Uint8Array;
  declare _padPost: Uint8Array;
  declare _body: Uint8Array;
}
define(GenericPardChunk, {
  _padPre: bytesField(15, { repr: false }),
  propertyControlType: u1Field(),
  _rawName: bytesField(32, { repr: false }),
  _padPost: bytesField(8, { repr: false }),
  _body: bytesField(92, { repr: false }),
});

/** `bytes(list_of_ints)`: raises like CPython outside 0..255 instead of wrapping. */
export function _bytesFromInts(value: number[]): Uint8Array {
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    const v = value[i];
    if (typeof v !== "number" || !Number.isInteger(v)) throw new TypeError(`'${typeof v}' object cannot be interpreted as an integer`);
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
  declare _padPre: Uint8Array;
  declare _rawName: Uint8Array;
  declare _padPost: Uint8Array;
  declare _lastColor: Uint8Array;
  declare _defaultColor: Uint8Array;

  get lastColor(): number[] {
    return Array.from(this._lastColor);
  }

  set lastColor(value: number[]) {
    this._lastColor = _bytesFromInts(value);
  }

  get defaultColor(): number[] {
    return Array.from(this._defaultColor);
  }

  set defaultColor(value: number[]) {
    this._defaultColor = _bytesFromInts(value);
  }
}
define(ColorPardChunk, {
  _padPre: bytesField(15, { repr: false }),
  propertyControlType: u1Field({ default: 5 }),
  _rawName: bytesField(32, { repr: false }),
  _padPost: bytesField(8, { repr: false }),
  _lastColor: bytesField(4, { repr: false }),
  _defaultColor: bytesField(4, { repr: false }),
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
  declare _padPre: Uint8Array;
  declare _rawName: Uint8Array;
  declare _padPost: Uint8Array;
  declare lastValue: number;
  declare _valueStr: Uint8Array;
  declare _valueDesc: Uint8Array;
  declare validMin: number;
  declare validMax: number;
  declare sliderMin: number | null;
  declare sliderMax: number | null;
  declare default_: number | null;
}
define(IntegerPardChunk, {
  _padPre: bytesField(15, { repr: false }),
  propertyControlType: u1Field({ default: 1 }),
  _rawName: bytesField(32, { repr: false }),
  _padPost: bytesField(8, { repr: false }),
  lastValue: s4Field(),
  _valueStr: bytesField(32, { repr: false }),
  _valueDesc: bytesField(32, { repr: false }),
  validMin: s4Field(),
  validMax: s4Field(),
  sliderMin: s4Field({ optional: true, default: null }),
  sliderMax: s4Field({ optional: true, default: null }),
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
  declare _padPre: Uint8Array;
  declare _rawName: Uint8Array;
  declare _padPost: Uint8Array;
  declare lastValueRaw: number;
  declare _valueStr: Uint8Array;
  declare _valueDesc: Uint8Array;
  declare validMinRaw: number;
  declare validMaxRaw: number;
  declare sliderMinRaw: number;
  declare sliderMaxRaw: number;
  declare defaultRaw: number | null;

  get lastValue(): number {
    return this.lastValueRaw / 65536;
  }

  get validMin(): number {
    return this.validMinRaw / 65536;
  }

  get validMax(): number {
    return this.validMaxRaw / 65536;
  }

  get sliderMin(): number {
    return this.sliderMinRaw / 65536;
  }

  get sliderMax(): number {
    return this.sliderMaxRaw / 65536;
  }

  get default_(): number | null {
    return this.defaultRaw == null ? null : this.defaultRaw / 65536;
  }
}
define(ScalarPardChunk, {
  _padPre: bytesField(15, { repr: false }),
  propertyControlType: u1Field({ default: 2 }),
  _rawName: bytesField(32, { repr: false }),
  _padPost: bytesField(8, { repr: false }),
  lastValueRaw: s4Field(),
  _valueStr: bytesField(32, { repr: false }),
  _valueDesc: bytesField(32, { repr: false }),
  validMinRaw: s4Field(),
  validMaxRaw: s4Field(),
  sliderMinRaw: s4Field(),
  sliderMaxRaw: s4Field(),
  defaultRaw: s4Field({ optional: true, default: null }),
});

/**
 * Angle control (type 3, SDK `PF_AngleDef`).
 *
 * Body: `PF_Fixed` (16.16 fixed point, `raw / 65536`) value, then
 * PF_Fixed default (the parameter's factory default value).
 */
export class AnglePardChunk extends PardChunk {
  declare _padPre: Uint8Array;
  declare _rawName: Uint8Array;
  declare _padPost: Uint8Array;
  declare lastValueRaw: number;
  declare defaultRaw: number | null;

  get lastValue(): number {
    return this.lastValueRaw / 65536;
  }

  get default_(): number | null {
    return this.defaultRaw == null ? null : this.defaultRaw / 65536;
  }
}
define(AnglePardChunk, {
  _padPre: bytesField(15, { repr: false }),
  propertyControlType: u1Field({ default: 3 }),
  _rawName: bytesField(32, { repr: false }),
  _padPost: bytesField(8, { repr: false }),
  lastValueRaw: s4Field(),
  defaultRaw: s4Field({ optional: true, default: null }),
});

/** Boolean control (type 4): u4 last_value, u1 default. */
export class BooleanPardChunk extends PardChunk {
  declare _padPre: Uint8Array;
  declare _rawName: Uint8Array;
  declare _padPost: Uint8Array;
  declare lastValue: number;
  declare default_: number;
}
define(BooleanPardChunk, {
  _padPre: bytesField(15, { repr: false }),
  propertyControlType: u1Field({ default: 4 }),
  _rawName: bytesField(32, { repr: false }),
  _padPost: bytesField(8, { repr: false }),
  lastValue: u4Field(),
  default_: u1Field(),
});

/**
 * 2D point control (type 6, SDK `PF_PointDef`).
 *
 * Body: `PF_Fixed` (16.16) value x / y, 3 reserved bytes,
 * `restrictBounds`, then `PF_Fixed` default x / y in percent of the
 * layer size. The cached value comes in two forms: a fraction of the
 * layer size (0.5 = centre), or equal to the percent default.
 */
export class TwoDPardChunk extends PardChunk {
  declare _padPre: Uint8Array;
  declare _rawName: Uint8Array;
  declare _padPost: Uint8Array;
  declare lastValueXRaw: number;
  declare lastValueYRaw: number;
  declare _reserved40: Uint8Array;
  declare restrictBounds: number;
  declare defaultXRaw: number;
  declare defaultYRaw: number;

  get lastValueX(): number {
    return this.lastValueXRaw * (1.0 / 128);
  }

  get lastValueY(): number {
    return this.lastValueYRaw * (1.0 / 128);
  }

  /** Default x / y, in percent of the layer width / height. */
  get default_(): number[] {
    return [this.defaultXRaw / 65536, this.defaultYRaw / 65536];
  }
}
define(TwoDPardChunk, {
  _padPre: bytesField(15, { repr: false }),
  propertyControlType: u1Field({ default: 6 }),
  _rawName: bytesField(32, { repr: false }),
  _padPost: bytesField(8, { repr: false }),
  lastValueXRaw: s4Field(),
  lastValueYRaw: s4Field(),
  _reserved40: bytesField(3, { repr: false }),
  restrictBounds: u1Field(),
  defaultXRaw: s4Field(),
  defaultYRaw: s4Field(),
});

/**
 * Popup control (type 7, SDK `PF_PopupDef`): s4 value, s2 number of
 * choices, s2 default (1-based). The choice-names pointer that follows
 * in the SDK record is leftover memory, kept as trailing bytes.
 */
export class EnumPardChunk extends PardChunk {
  declare _padPre: Uint8Array;
  declare _rawName: Uint8Array;
  declare _padPost: Uint8Array;
  declare lastValue: number;
  declare nbOptions: number;
  declare default_: number;
}
define(EnumPardChunk, {
  _padPre: bytesField(15, { repr: false }),
  propertyControlType: u1Field({ default: 7 }),
  _rawName: bytesField(32, { repr: false }),
  _padPost: bytesField(8, { repr: false }),
  lastValue: u4Field(),
  nbOptions: s2Field(),
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
  declare _padPre: Uint8Array;
  declare _rawName: Uint8Array;
  declare _padPost: Uint8Array;
  declare lastValue: number;
  declare phase: number;
  declare _valueDesc: Uint8Array;
  declare validMin: number;
  declare validMax: number;
  declare sliderMin: number;
  declare sliderMax: number;
  declare default_: number | null;
  declare _precision: number | null;
  /** SDK `PF_ValueDisplayFlags`: bit 0 (PERCENT) is the only flag AE
   * writes reliably for float sliders (fixed-point sliders leave it 0). */
  declare displayFlags: number | null;

  /** SDK `PF_ValueDisplayFlag_PERCENT` (bit 0). */
  get displaysPercent(): boolean {
    const flags = this.displayFlags;
    return flags != null && (flags & 0x01) !== 0;
  }
}
define(SliderPardChunk, {
  _padPre: bytesField(15, { repr: false }),
  propertyControlType: u1Field({ default: 10 }),
  _rawName: bytesField(32, { repr: false }),
  _padPost: bytesField(8, { repr: false }),
  lastValue: f8Field(),
  phase: f8Field(),
  _valueDesc: bytesField(32, { repr: false }),
  validMin: f4Field(),
  validMax: f4Field(),
  sliderMin: f4Field(),
  sliderMax: f4Field(),
  default_: f4Field({ optional: true, default: null }),
  _precision: u2Field({ optional: true, default: null, repr: false }),
  displayFlags: u2Field({ optional: true, default: null }),
});

/**
 * 3D point control (type 18, SDK `PF_Point3DDef`): f8 value x / y /
 * z, then f8 default x / y / z in percent of the layer size. The cached
 * value is a fraction of the layer size or equal to the percent default,
 * as for a 2D point.
 */
export class ThreeDPardChunk extends PardChunk {
  declare _padPre: Uint8Array;
  declare _rawName: Uint8Array;
  declare _padPost: Uint8Array;
  declare lastValueXRaw: number;
  declare lastValueYRaw: number;
  declare lastValueZRaw: number;
  declare defaultX: number;
  declare defaultY: number;
  declare defaultZ: number;

  /** Default x / y / z, in percent of the layer size. */
  get default_(): number[] {
    return [this.defaultX, this.defaultY, this.defaultZ];
  }

  get lastValueX(): number {
    return this.lastValueXRaw * 512;
  }

  get lastValueY(): number {
    return this.lastValueYRaw * 512;
  }

  get lastValueZ(): number {
    return this.lastValueZRaw * 512;
  }
}
define(ThreeDPardChunk, {
  _padPre: bytesField(15, { repr: false }),
  propertyControlType: u1Field({ default: 18 }),
  _rawName: bytesField(32, { repr: false }),
  _padPost: bytesField(8, { repr: false }),
  lastValueXRaw: f8Field(),
  lastValueYRaw: f8Field(),
  lastValueZRaw: f8Field(),
  defaultX: f8Field(),
  defaultY: f8Field(),
  defaultZ: f8Field(),
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
  declare chunkType: string;
  declare workingGammaSelector: number;
  declare _reserved01: Uint8Array;

  /** Working gamma (2.2 or 2.4). */
  get workingGamma(): number {
    return this.workingGammaSelector === 0 ? 2.2 : 2.4;
  }

  set workingGamma(value: number) {
    this.workingGammaSelector = value === 2.2 ? 0 : 1;
  }
}
define(DwgaChunk, {
  chunkType: field({ default: "dwga" }),
  workingGammaSelector: u1Field(),
  _reserved01: bytesField(3, { repr: false }),
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
  declare isChildProperty: boolean;
  declare selected: boolean;

  static {
    descriptor(this, "isChildProperty", new BitField("_flags", 7));
    descriptor(this, "selected", new BitField("_flags", 6));
  }
}
define(EwotItem, {
  _flags: u1Field(),
  _data: bytesField(3),
});

/**
 * Effect workspace outline entries.
 *
 * 4-byte count header followed by `count` × 4-byte entries.
 */
export class EwotChunk extends Chunk {
  declare chunkType: string;
  declare numEntries: number;
  declare items: EwotItem[];
}
define(EwotChunk, {
  chunkType: field({ default: "ewot" }),
  numEntries: u4Field(),
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
  declare entryType: number;
  declare collapsed: boolean;
  declare selected: boolean;
  declare isProperty: boolean;
  declare isSubEntry: boolean;

  /** True when this entry is a per-layer boundary marker. */
  get isLayerMarker(): boolean {
    return this.entryType === 68;
  }

  static {
    descriptor(this, "collapsed", new BitField("_flags", 7));
    descriptor(this, "selected", new BitField("_flags", 6));
    descriptor(this, "isProperty", new BitField("_flags", 5));
    descriptor(this, "isSubEntry", new BitField("_flags", 3));
  }
}
define(OtlnItem, {
  _flags: u1Field(),
  _unnamed6: bytesField(2),
  entryType: u1Field(),
});

/**
 * Comp panel outline entries.
 *
 * 4-byte count header followed by `count` × 4-byte entries.
 */
export class OtlnChunk extends Chunk {
  declare chunkType: string;
  declare numEntries: number;
  declare items: OtlnItem[];
}
define(OtlnChunk, {
  chunkType: field({ default: "otln" }),
  numEntries: u4Field(),
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

// Every variant redeclares `propertyControlType` as a field over the base getter.
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
  shadowProperty(variant, "propertyControlType");
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
  declare segLoc: number;
  /** Interpolation type raw value (LE u4). 0=non-Hold, 2=Hold. */
  declare interpRaw: number;
  /** Relative position on the segment (0.0 to 1.0, BE f8). */
  declare relSegLoc: number;
  /** Feather radius. Negative=inner, positive=outer (BE f8). */
  declare radius: number;
  /** Corner angle percentage 0-100 (BE f4). */
  declare cornerAngle: number;
  /** Feather tension 0.0-1.0 (BE f4). */
  declare tension: number;
}
define(FeatherPointItem, {
  segLoc: u4Field({ endian: "<" }),
  interpRaw: u4Field({ endian: "<" }),
  relSegLoc: f8Field({ default: 0.0 }),
  radius: f8Field({ default: 0.0 }),
  cornerAngle: f4Field({ default: 0.0 }),
  tension: f4Field({ default: 0.0 }),
});

export const _FTH5_ITEM_SIZE = 32;

/** Variable-width mask feather points (32 bytes per point). */
export class Fth5Chunk extends Chunk {
  declare chunkType: string;
  declare points: FeatherPointItem[];
}
define(Fth5Chunk, {
  chunkType: field({ default: "fth5" }),
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
  declare chunkType: string;
  declare tensions: TensionItem[];
}
define(OmtnChunk, {
  chunkType: field({ default: "omtn" }),
  tensions: itemsField(TensionItem, 4),
});
register("omtn")(OmtnChunk);

// ---------------------------------------------------------------------------
// Source / footage utility chunks
// ---------------------------------------------------------------------------
/** Application color profile ID (16 bytes, all 0xff = unmanaged). */
export class ApidChunk extends Chunk {
  declare chunkType: string;
  declare data: Uint8Array;
}
define(ApidChunk, {
  chunkType: field({ default: "apid" }),
  data: field({ default: bytes_.repeat(b("\xff"), 16) }),
});
register("apid")(ApidChunk);

/** Embedded color profile ID (16 bytes, all 0xff = unmanaged). */
export class EpidChunk extends Chunk {
  declare chunkType: string;
  declare data: Uint8Array;
}
define(EpidChunk, {
  chunkType: field({ default: "epid" }),
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
  declare chunkType: string;
  declare value: boolean;
}
define(EmpdChunk, {
  chunkType: field({ default: "empd" }),
  value: boolField({ default: true }),
});
register("empd")(EmpdChunk);

/** Linearization setting (4 bytes little-endian). */
export class LinlChunk extends Chunk {
  declare chunkType: string;
  declare value: number;
}
define(LinlChunk, {
  chunkType: field({ default: "linl" }),
  value: u4Field({ endian: "<", default: 2 }),
});
register("linl")(LinlChunk);

/** Embed profile flag. */
export class EmbpChunk extends Chunk {
  declare chunkType: string;
  declare value: boolean;
}
define(EmbpChunk, {
  chunkType: field({ default: "embp" }),
  value: boolField({ default: true }),
});
register("embp")(EmbpChunk);

/** Input profile working space. */
export class IpwsChunk extends Chunk {
  declare chunkType: string;
  declare value: number;
}
define(IpwsChunk, {
  chunkType: field({ default: "ipws" }),
  value: u1Field({ default: 1 }),
});
register("ipws")(IpwsChunk);

/** Display color UI flag (solid sources only). */
export class DcuiChunk extends Chunk {
  declare chunkType: string;
  declare value: boolean;
}
define(DcuiChunk, {
  chunkType: field({ default: "dcui" }),
  value: boolField({ default: true }),
});
register("dcui")(DcuiChunk);

/** Preserve RGB flag (solid sources only). */
export class PrgbChunk extends Chunk {
  declare chunkType: string;
  declare value: number;
}
define(PrgbChunk, {
  chunkType: field({ default: "prgb" }),
  value: u1Field({ default: 1 }),
});
register("prgb")(PrgbChunk);

/** Monitor color space flag. */
export class McspChunk extends Chunk {
  declare chunkType: string;
  declare value: boolean;
}
define(McspChunk, {
  chunkType: field({ default: "Mcsp" }),
  value: boolField({ default: true }),
});
register("Mcsp")(McspChunk);

/** Output color space flag. */
export class OcspChunk extends Chunk {
  declare chunkType: string;
  declare value: boolean;
}
define(OcspChunk, {
  chunkType: field({ default: "ocsp" }),
  value: boolField({ default: true }),
});
register("ocsp")(OcspChunk);

/** HDR mode flag. */
export class HdrmChunk extends Chunk {
  declare chunkType: string;
  declare value: boolean;
}
define(HdrmChunk, {
  chunkType: field({ default: "hdrm" }),
  value: boolField({ default: true }),
});
register("hdrm")(HdrmChunk);

/** Media start info (8 bytes). */
export class StrtChunk extends Chunk {
  declare chunkType: string;
  declare _reserved00: Uint8Array;
  declare fpsByte: number;
  declare _reserved05: Uint8Array;
}
define(StrtChunk, {
  chunkType: field({ default: "strt" }),
  _reserved00: bytesField(4, { repr: false }),
  fpsByte: u1Field({ default: 1 }),
  _reserved05: bytesField(3, { repr: false }),
});
register("strt")(StrtChunk);

/** Drop frame flag. */
export class DropChunk extends Chunk {
  declare chunkType: string;
  declare value: boolean;
}
define(DropChunk, {
  chunkType: field({ default: "drop" }),
  value: boolField({ default: true }),
});
register("drop")(DropChunk);

/** Footage interpretation global info (16 bytes). */
export class FtgiChunk extends Chunk {
  declare chunkType: string;
  declare startOffset: number;
  declare frameRateNum: number;
  declare endFrame: number;
  declare timeBase: number;
}
define(FtgiChunk, {
  chunkType: field({ default: "ftgi" }),
  startOffset: u4Field(),
  frameRateNum: u4Field({ default: 1 }),
  endFrame: u4Field({ default: 0xffffffff }),
  timeBase: u4Field({ default: 600 }),
});
register("ftgi")(FtgiChunk);
