/**
 * Layer chunk type: ldta (160-164 bytes).
 *
 * The optional `matte_layer_id` (AE \>= 23) uses `fmt_field(..., optional=True)`
 * so it reads as `null` from older files and is omitted on write when absent.
 */

import { ZeroDivisionError, define, descriptor } from "../../pyrt/index.ts";
import { LayerType } from "../enums/index.ts";
import { to_dividend_divisor, to_float32_ratio } from "./bin_utils.ts";
import { BitField } from "./bitfield.ts";
import { Chunk } from "./chunk.ts";
import { bytes_field, f8_field, s4_field, str_field, u1_field, u2_field, u4_field } from "./fmt_field.ts";
import { register } from "./registry.ts";

// Offset of source_id (u4 big-endian) within a LIST:Layr raw body:
// chunk_type "ldta" (4) + body_size (4) + 40 bytes into ldta body = 48.
export const _LDTA_SOURCE_ID_OFFSET = 48;
export const _LDTA_SOURCE_ID_END = 52;

/**
 * Layer descriptor chunk (160-164 bytes).
 *
 * Contains layer identity, timing, flags, and type info. The 32-byte
 * `layer_name` is a UTF-8 null-terminated string. The optional
 * `matte_layer_id` is present only in AE \>= 23.
 */
export class LdtaChunk extends Chunk {
  declare chunk_type: string;

  // -- Identity / timing (bytes 0-35) ------------------------------------
  declare layer_id: number;
  declare quality: number;
  declare _reserved_06: Uint8Array;
  declare stretch_dividend: number;
  declare start_time_dividend: number;
  declare start_time_divisor: number;
  declare in_point_dividend: number;
  declare in_point_divisor: number;
  declare out_point_dividend: number;
  declare out_point_divisor: number;

  // -- Flag bytes (bytes 36-39) ------------------------------------------
  declare _reserved_24: Uint8Array;
  /** Byte 37: bits for sampling, env, char-toward-cam, 3d-per-char, etc. */
  declare _layer_flags_0: number;

  /** Byte 38: bits for null, cam-auto-orient, solo, 3d, adjustment, etc. */
  declare _layer_flags_1: number;

  /**
   * Byte 39: bits for collapse, shy, locked, frame-blend, motion-blur, etc.
   * Default 0x07 = enabled + audio_enabled + effects_active.
   */
  declare _layer_flags_2: number;

  // -- Source / label (bytes 40-63) --------------------------------------
  declare source_id: number;
  declare _reserved_2c: Uint8Array;
  declare _reserved_3b: number;
  declare _reserved_3c: number;
  declare label: number;
  declare _reserved_3e: Uint8Array;

  // -- Layer name (bytes 64-95, 32-byte UTF-8 strz) ---------------
  /** 32-byte UTF-8 null-terminated string. */
  declare layer_name: string;

  // -- Post-name fields (bytes 96-159) -----------------------------------
  declare _reserved_60: Uint8Array;
  declare blending_mode: number;
  declare _reserved_64: Uint8Array;
  /**
   * Byte 103: transfer-mode flags. bit 0 = preserve underlying transparency,
   * bit 1 = dancing dissolve (Dissolve blend with an animated pattern; AE has no
   * separate transfer-mode value for it).
   */
  declare _transfer_flags: number;
  declare _reserved_68: Uint8Array;
  declare track_matte_type: number;
  declare stretch_divisor: number;
  // Two doubles, 0.0 in every sample (AE 15-26).
  declare _reserved_70: number;
  declare _reserved_78: number;
  declare _reserved_80: Uint8Array;
  declare layer_type: number;
  declare parent_id: number;
  declare _reserved_88: Uint8Array;
  declare light_and_mesh_type: number;
  // Three words (0 / 1, 0 / 0x01000000, 0 / 1 in the samples) and a double
  // (0.0, 36.0 or 102.047...), undecoded.
  declare _reserved_8c: number;
  declare _reserved_90: number;
  declare _reserved_94: number;
  declare _reserved_98: number;

  // -- Optional field (bytes 160-163, AE >= 23) --------------------------
  /** Track matte layer ID. `null` = absent (AE \< 23), `0` = no matte. */
  declare matte_layer_id: number | null;

  // -- BitField descriptors (not attrs fields) ---------------------------
  // byte 37: _layer_flags_0
  declare sampling_quality: boolean;
  declare environment_layer: boolean;
  declare characters_toward_camera: boolean;
  declare three_d_per_char: boolean;
  declare frame_blending_mode: boolean;
  declare guide_layer: boolean;
  // bit 0: a source-backed layer's name was explicitly set (away from the
  // source item's name). Always 0 for sourceless layers (camera/light/text/
  // shape) even when named; NOT equivalent to ExtendScript isNameSet (use the
  // model-level Layer.isNameSet for that).
  declare name_set: boolean;

  // byte 38: _layer_flags_1
  declare null_layer: boolean;
  // bit 6: camera/light "orient towards point of interest" (the two-node
  // rig). AE stores the camera variant of CAMERA_OR_POINT_OF_INTEREST here,
  // NOT in bit 5 (probed AE 2026: a default two-node camera has 0x44, a
  // NO_AUTO_ORIENT camera 0x04).
  declare poi_auto_orient: boolean;
  declare camera_or_poi_auto_orient: boolean;
  declare markers_locked: boolean;
  declare solo: boolean;
  declare three_d_layer: boolean;
  declare adjustment_layer: boolean;
  declare auto_orient_along_path: boolean;

  // byte 39: _layer_flags_2
  declare collapse_transformation: boolean;
  declare shy: boolean;
  declare locked: boolean;
  declare frame_blending: boolean;
  declare motion_blur_flag: boolean;
  declare effects_active: boolean;
  declare audio_enabled: boolean;
  declare enabled: boolean;

  // byte 60: set while the layer has a comment (`cmta`); AE 2026 ignores
  // a `cmta` without it and clears both when the comment is emptied.
  declare has_comment: boolean;

  // byte 103: _transfer_flags
  declare preserve_transparency: boolean;
  declare dancing_dissolve: boolean;

  // -- Computed properties -----------------------------------------------

  /** Start time in seconds (dividend / divisor). */
  get start_time(): number {
    if (this.start_time_divisor === 0) throw new ZeroDivisionError("division by zero");
    return this.start_time_dividend / this.start_time_divisor;
  }

  /** In point in seconds (dividend / divisor). */
  get in_point(): number {
    if (this.in_point_divisor === 0) throw new ZeroDivisionError("division by zero");
    return this.in_point_dividend / this.in_point_divisor;
  }

  set in_point(value: number) {
    [this.in_point_dividend, this.in_point_divisor] = to_dividend_divisor(value);
  }

  /** Out point in seconds (dividend / divisor). */
  get out_point(): number {
    if (this.out_point_divisor === 0) throw new ZeroDivisionError("division by zero");
    return this.out_point_dividend / this.out_point_divisor;
  }

  set out_point(value: number) {
    [this.out_point_dividend, this.out_point_divisor] = to_dividend_divisor(value);
  }

  /** Stretch as percentage (100 = no stretch). */
  get stretch(): number {
    if (this.stretch_divisor === 0) {
      return 0.0;
    }
    return (this.stretch_dividend * 100.0) / this.stretch_divisor;
  }

  set stretch(value: number) {
    if (value === 0) {
      this.stretch_dividend = 0;
      this.stretch_divisor = 0;
    } else {
      // AE stores the factor as a float32, as an exact ratio: 133.33 %
      // is 11184531 / 8388608, not 13333 / 10000.
      [this.stretch_dividend, this.stretch_divisor] = to_float32_ratio(value / 100.0);
    }
  }

  /** Auto-orient type (0=none, 1=path, 2=camera/poi, 3=chars_toward_camera). */
  get auto_orient(): number {
    if (this.auto_orient_along_path) {
      return 1;
    }
    if (this.camera_or_poi_auto_orient && this.three_d_layer) {
      return 2;
    }
    // Camera/light layers store their two-node "orient towards point of
    // interest" in bit 6 instead.
    if (this.poi_auto_orient && this.three_d_layer) {
      return 2;
    }
    if (this.characters_toward_camera && this.three_d_per_char) {
      return 3;
    }
    return 0;
  }

  set auto_orient(value: number) {
    this.auto_orient_along_path = value === 1;
    const is_poi_rig = this.layer_type === LayerType.CAMERA || this.layer_type === LayerType.LIGHT;
    this.camera_or_poi_auto_orient = value === 2 && !is_poi_rig;
    this.poi_auto_orient = value === 2 && is_poi_rig;
    this.characters_toward_camera = value === 3;
    // Per-character 3D is a precondition of chars_toward_camera (the
    // getter needs both bits), but it is an independent layer switch
    // otherwise - AE ships layers with it on and auto-orient off - so
    // selecting another mode must not clear it.
    if (value === 3) {
      this.three_d_per_char = true;
    }
  }

  /** Frame blending type (0=none, 1=frame_mix, 2=pixel_motion). */
  get frame_blending_type(): number {
    if (!this.frame_blending) {
      return 0;
    }
    return this.frame_blending_mode ? 2 : 1;
  }

  set frame_blending_type(value: number) {
    if (value === 0) {
      this.frame_blending = false;
    } else {
      this.frame_blending = true;
      this.frame_blending_mode = value === 2;
    }
  }
}

define(LdtaChunk, {
  chunk_type: { default: "ldta" },

  // -- Identity / timing (bytes 0-35) ------------------------------------
  layer_id: u4_field(),
  quality: u2_field(),
  _reserved_06: bytes_field(2, { repr: false }),
  stretch_dividend: s4_field({ default: 1 }),
  start_time_dividend: s4_field(),
  start_time_divisor: u4_field({ default: 1 }),
  in_point_dividend: s4_field(),
  in_point_divisor: u4_field({ default: 1 }),
  out_point_dividend: s4_field(),
  out_point_divisor: u4_field({ default: 1 }),

  // -- Flag bytes (bytes 36-39) ------------------------------------------
  _reserved_24: bytes_field(1, { repr: false }),
  _layer_flags_0: u1_field({ repr: false }),
  _layer_flags_1: u1_field({ repr: false }),
  _layer_flags_2: u1_field({ default: 0x07, repr: false }),

  // -- Source / label (bytes 40-63) --------------------------------------
  source_id: u4_field(),
  _reserved_2c: bytes_field(15, { repr: false }),
  _reserved_3b: u1_field({ repr: false }),
  _reserved_3c: u1_field({ repr: false }),
  label: u1_field(),
  _reserved_3e: bytes_field(2, { repr: false }),

  // -- Layer name (bytes 64-95, 32-byte UTF-8 strz) ---------------
  layer_name: str_field(32, { default: "", encoding: "utf-8" }),

  // -- Post-name fields (bytes 96-159) -----------------------------------
  _reserved_60: bytes_field(3, { repr: false }),
  blending_mode: u1_field(),
  _reserved_64: bytes_field(3, { repr: false }),
  _transfer_flags: u1_field({ repr: false }),
  _reserved_68: bytes_field(3, { repr: false }),
  track_matte_type: u1_field(),
  stretch_divisor: u4_field({ default: 1 }),
  _reserved_70: f8_field({ repr: false }),
  _reserved_78: f8_field({ repr: false }),
  _reserved_80: bytes_field(3, { repr: false }),
  layer_type: u1_field(),
  parent_id: u4_field(),
  _reserved_88: bytes_field(3, { repr: false }),
  light_and_mesh_type: u1_field(),
  _reserved_8c: u4_field({ repr: false }),
  _reserved_90: u4_field({ repr: false }),
  _reserved_94: u4_field({ repr: false }),
  _reserved_98: f8_field({ repr: false }),

  // -- Optional field (bytes 160-163, AE >= 23) --------------------------
  matte_layer_id: u4_field({ default: null, optional: true }),
});

// -- BitField descriptors (not attrs fields) -----------------------------
// byte 37: _layer_flags_0
descriptor(LdtaChunk, "sampling_quality", new BitField("_layer_flags_0", 6));
descriptor(LdtaChunk, "environment_layer", new BitField("_layer_flags_0", 5));
descriptor(LdtaChunk, "characters_toward_camera", new BitField("_layer_flags_0", 4));
descriptor(LdtaChunk, "three_d_per_char", new BitField("_layer_flags_0", 3));
descriptor(LdtaChunk, "frame_blending_mode", new BitField("_layer_flags_0", 2));
descriptor(LdtaChunk, "guide_layer", new BitField("_layer_flags_0", 1));
// bit 0: a source-backed layer's name was explicitly set (away from the
// source item's name). Always 0 for sourceless layers (camera/light/text/
// shape) even when named; NOT equivalent to ExtendScript isNameSet (use the
// model-level Layer.isNameSet for that).
descriptor(LdtaChunk, "name_set", new BitField("_layer_flags_0", 0));

// byte 38: _layer_flags_1
descriptor(LdtaChunk, "null_layer", new BitField("_layer_flags_1", 7));
// bit 6: camera/light "orient towards point of interest" (the two-node
// rig). AE stores the camera variant of CAMERA_OR_POINT_OF_INTEREST here,
// NOT in bit 5 (probed AE 2026: a default two-node camera has 0x44, a
// NO_AUTO_ORIENT camera 0x04).
descriptor(LdtaChunk, "poi_auto_orient", new BitField("_layer_flags_1", 6));
descriptor(LdtaChunk, "camera_or_poi_auto_orient", new BitField("_layer_flags_1", 5));
descriptor(LdtaChunk, "markers_locked", new BitField("_layer_flags_1", 4));
descriptor(LdtaChunk, "solo", new BitField("_layer_flags_1", 3));
descriptor(LdtaChunk, "three_d_layer", new BitField("_layer_flags_1", 2));
descriptor(LdtaChunk, "adjustment_layer", new BitField("_layer_flags_1", 1));
descriptor(LdtaChunk, "auto_orient_along_path", new BitField("_layer_flags_1", 0));

// byte 39: _layer_flags_2
descriptor(LdtaChunk, "collapse_transformation", new BitField("_layer_flags_2", 7));
descriptor(LdtaChunk, "shy", new BitField("_layer_flags_2", 6));
descriptor(LdtaChunk, "locked", new BitField("_layer_flags_2", 5));
descriptor(LdtaChunk, "frame_blending", new BitField("_layer_flags_2", 4));
descriptor(LdtaChunk, "motion_blur_flag", new BitField("_layer_flags_2", 3));
descriptor(LdtaChunk, "effects_active", new BitField("_layer_flags_2", 2));
descriptor(LdtaChunk, "audio_enabled", new BitField("_layer_flags_2", 1));
descriptor(LdtaChunk, "enabled", new BitField("_layer_flags_2", 0));

// byte 60: set while the layer has a comment (`cmta`); AE 2026 ignores
// a `cmta` without it and clears both when the comment is emptied.
descriptor(LdtaChunk, "has_comment", new BitField("_reserved_3c", 0));

// byte 103: _transfer_flags
descriptor(LdtaChunk, "preserve_transparency", new BitField("_transfer_flags", 0));
descriptor(LdtaChunk, "dancing_dissolve", new BitField("_transfer_flags", 1));

register("ldta")(LdtaChunk);
