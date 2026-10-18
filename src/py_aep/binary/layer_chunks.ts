/**
 * Layer chunk type: ldta (160-164 bytes).
 *
 * The optional `matteLayerId` (AE \>= 23) uses `fmt_field(..., optional=True)`
 * so it reads as `null` from older files and is omitted on write when absent.
 */

import { ZeroDivisionError, define, descriptor } from "../../pyrt/index.ts";
import { LayerType } from "../enums/index.ts";
import { toDividendDivisor, toFloat32Ratio } from "./bin_utils.ts";
import { BitField } from "./bitfield.ts";
import { Chunk } from "./chunk.ts";
import { bytesField, f8Field, s4Field, strField, u1Field, u2Field, u4Field } from "./fmt_field.ts";
import { register } from "./registry.ts";

// Offset of source_id (u4 big-endian) within a LIST:Layr raw body:
// chunk_type "ldta" (4) + body_size (4) + 40 bytes into ldta body = 48.
export const _LDTA_SOURCE_ID_OFFSET = 48;
export const _LDTA_SOURCE_ID_END = 52;

/**
 * Layer descriptor chunk (160-164 bytes).
 *
 * Contains layer identity, timing, flags, and type info. The 32-byte
 * `layerName` is a UTF-8 null-terminated string. The optional
 * `matteLayerId` is present only in AE \>= 23.
 */
export class LdtaChunk extends Chunk {
  declare chunkType: string;

  // -- Identity / timing (bytes 0-35) ------------------------------------
  declare layerId: number;
  declare quality: number;
  declare _reserved06: Uint8Array;
  declare stretchDividend: number;
  declare startTimeDividend: number;
  declare startTimeDivisor: number;
  declare inPointDividend: number;
  declare inPointDivisor: number;
  declare outPointDividend: number;
  declare outPointDivisor: number;

  // -- Flag bytes (bytes 36-39) ------------------------------------------
  declare _reserved24: Uint8Array;
  /** Byte 37: bits for sampling, env, char-toward-cam, 3d-per-char, etc. */
  declare _layerFlags0: number;

  /** Byte 38: bits for null, cam-auto-orient, solo, 3d, adjustment, etc. */
  declare _layerFlags1: number;

  /**
   * Byte 39: bits for collapse, shy, locked, frame-blend, motion-blur, etc.
   * Default 0x07 = enabled + audio_enabled + effects_active.
   */
  declare _layerFlags2: number;

  // -- Source / label (bytes 40-63) --------------------------------------
  declare sourceId: number;
  declare _reserved2c: Uint8Array;
  declare _reserved3b: number;
  declare _reserved3c: number;
  declare label: number;
  declare _reserved3e: Uint8Array;

  // -- Layer name (bytes 64-95, 32-byte UTF-8 strz) ---------------
  /** 32-byte UTF-8 null-terminated string. */
  declare layerName: string;

  // -- Post-name fields (bytes 96-159) -----------------------------------
  declare _reserved60: Uint8Array;
  declare blendingMode: number;
  declare _reserved64: Uint8Array;
  /**
   * Byte 103: transfer-mode flags. bit 0 = preserve underlying transparency,
   * bit 1 = dancing dissolve (Dissolve blend with an animated pattern; AE has no
   * separate transfer-mode value for it).
   */
  declare _transferFlags: number;
  declare _reserved68: Uint8Array;
  declare trackMatteType: number;
  declare stretchDivisor: number;
  // Two doubles, 0.0 in every sample (AE 15-26).
  declare _reserved70: number;
  declare _reserved78: number;
  declare _reserved80: Uint8Array;
  declare layerType: number;
  declare parentId: number;
  declare _reserved88: Uint8Array;
  declare lightAndMeshType: number;
  // Three words (0 / 1, 0 / 0x01000000, 0 / 1 in the samples) and a double
  // (0.0, 36.0 or 102.047...), undecoded.
  declare _reserved8c: number;
  declare _reserved90: number;
  declare _reserved94: number;
  declare _reserved98: number;

  // -- Optional field (bytes 160-163, AE >= 23) --------------------------
  /** Track matte layer ID. `null` = absent (AE \< 23), `0` = no matte. */
  declare matteLayerId: number | null;

  // -- BitField descriptors (not attrs fields) ---------------------------
  // byte 37: _layer_flags_0
  declare samplingQuality: boolean;
  declare environmentLayer: boolean;
  declare charactersTowardCamera: boolean;
  declare threeDPerChar: boolean;
  declare frameBlendingMode: boolean;
  declare guideLayer: boolean;
  // bit 0: a source-backed layer's name was explicitly set (away from the
  // source item's name). Always 0 for sourceless layers (camera/light/text/
  // shape) even when named; NOT equivalent to ExtendScript isNameSet (use the
  // model-level Layer.isNameSet for that).
  declare nameSet: boolean;

  // byte 38: _layer_flags_1
  declare nullLayer: boolean;
  // bit 6: camera/light "orient towards point of interest" (the two-node
  // rig). AE stores the camera variant of CAMERA_OR_POINT_OF_INTEREST here,
  // NOT in bit 5 (probed AE 2026: a default two-node camera has 0x44, a
  // NO_AUTO_ORIENT camera 0x04).
  declare poiAutoOrient: boolean;
  declare cameraOrPoiAutoOrient: boolean;
  declare markersLocked: boolean;
  declare solo: boolean;
  declare threeDLayer: boolean;
  declare adjustmentLayer: boolean;
  declare autoOrientAlongPath: boolean;

  // byte 39: _layer_flags_2
  declare collapseTransformation: boolean;
  declare shy: boolean;
  declare locked: boolean;
  declare frameBlending: boolean;
  declare motionBlurFlag: boolean;
  declare effectsActive: boolean;
  declare audioEnabled: boolean;
  declare enabled: boolean;

  // byte 60: set while the layer has a comment (`cmta`); AE 2026 ignores
  // a `cmta` without it and clears both when the comment is emptied.
  declare hasComment: boolean;

  // byte 103: _transfer_flags
  declare preserveTransparency: boolean;
  declare dancingDissolve: boolean;

  // -- Computed properties -----------------------------------------------

  /** Start time in seconds (dividend / divisor). */
  get startTime(): number {
    if (this.startTimeDivisor === 0) throw new ZeroDivisionError("division by zero");
    return this.startTimeDividend / this.startTimeDivisor;
  }

  /** In point in seconds (dividend / divisor). */
  get inPoint(): number {
    if (this.inPointDivisor === 0) throw new ZeroDivisionError("division by zero");
    return this.inPointDividend / this.inPointDivisor;
  }

  set inPoint(value: number) {
    [this.inPointDividend, this.inPointDivisor] = toDividendDivisor(value);
  }

  /** Out point in seconds (dividend / divisor). */
  get outPoint(): number {
    if (this.outPointDivisor === 0) throw new ZeroDivisionError("division by zero");
    return this.outPointDividend / this.outPointDivisor;
  }

  set outPoint(value: number) {
    [this.outPointDividend, this.outPointDivisor] = toDividendDivisor(value);
  }

  /** Stretch as percentage (100 = no stretch). */
  get stretch(): number {
    if (this.stretchDivisor === 0) {
      return 0.0;
    }
    return (this.stretchDividend * 100.0) / this.stretchDivisor;
  }

  set stretch(value: number) {
    if (value === 0) {
      this.stretchDividend = 0;
      this.stretchDivisor = 0;
    } else {
      // AE stores the factor as a float32, as an exact ratio: 133.33 %
      // is 11184531 / 8388608, not 13333 / 10000.
      [this.stretchDividend, this.stretchDivisor] = toFloat32Ratio(value / 100.0);
    }
  }

  /** Auto-orient type (0=none, 1=path, 2=camera/poi, 3=chars_toward_camera). */
  get autoOrient(): number {
    if (this.autoOrientAlongPath) {
      return 1;
    }
    if (this.cameraOrPoiAutoOrient && this.threeDLayer) {
      return 2;
    }
    // Camera/light layers store their two-node "orient towards point of
    // interest" in bit 6 instead.
    if (this.poiAutoOrient && this.threeDLayer) {
      return 2;
    }
    if (this.charactersTowardCamera && this.threeDPerChar) {
      return 3;
    }
    return 0;
  }

  set autoOrient(value: number) {
    this.autoOrientAlongPath = value === 1;
    const isPoiRig = this.layerType === LayerType.CAMERA || this.layerType === LayerType.LIGHT;
    this.cameraOrPoiAutoOrient = value === 2 && !isPoiRig;
    this.poiAutoOrient = value === 2 && isPoiRig;
    this.charactersTowardCamera = value === 3;
    // Per-character 3D is a precondition of chars_toward_camera (the
    // getter needs both bits), but it is an independent layer switch
    // otherwise - AE ships layers with it on and auto-orient off - so
    // selecting another mode must not clear it.
    if (value === 3) {
      this.threeDPerChar = true;
    }
  }

  /** Frame blending type (0=none, 1=frame_mix, 2=pixel_motion). */
  get frameBlendingType(): number {
    if (!this.frameBlending) {
      return 0;
    }
    return this.frameBlendingMode ? 2 : 1;
  }

  set frameBlendingType(value: number) {
    if (value === 0) {
      this.frameBlending = false;
    } else {
      this.frameBlending = true;
      this.frameBlendingMode = value === 2;
    }
  }

  static {
    // -- BitField descriptors (not attrs fields) -----------------------------
    // byte 37: _layer_flags_0
    descriptor(this, "samplingQuality", new BitField("_layerFlags0", 6));
    descriptor(this, "environmentLayer", new BitField("_layerFlags0", 5));
    descriptor(this, "charactersTowardCamera", new BitField("_layerFlags0", 4));
    descriptor(this, "threeDPerChar", new BitField("_layerFlags0", 3));
    descriptor(this, "frameBlendingMode", new BitField("_layerFlags0", 2));
    descriptor(this, "guideLayer", new BitField("_layerFlags0", 1));
    // bit 0: a source-backed layer's name was explicitly set (away from the
    // source item's name). Always 0 for sourceless layers (camera/light/text/
    // shape) even when named; NOT equivalent to ExtendScript isNameSet (use the
    // model-level Layer.isNameSet for that).
    descriptor(this, "nameSet", new BitField("_layerFlags0", 0));
    // byte 38: _layer_flags_1
    descriptor(this, "nullLayer", new BitField("_layerFlags1", 7));
    // bit 6: camera/light "orient towards point of interest" (the two-node
    // rig). AE stores the camera variant of CAMERA_OR_POINT_OF_INTEREST here,
    // NOT in bit 5 (probed AE 2026: a default two-node camera has 0x44, a
    // NO_AUTO_ORIENT camera 0x04).
    descriptor(this, "poiAutoOrient", new BitField("_layerFlags1", 6));
    descriptor(this, "cameraOrPoiAutoOrient", new BitField("_layerFlags1", 5));
    descriptor(this, "markersLocked", new BitField("_layerFlags1", 4));
    descriptor(this, "solo", new BitField("_layerFlags1", 3));
    descriptor(this, "threeDLayer", new BitField("_layerFlags1", 2));
    descriptor(this, "adjustmentLayer", new BitField("_layerFlags1", 1));
    descriptor(this, "autoOrientAlongPath", new BitField("_layerFlags1", 0));
    // byte 39: _layer_flags_2
    descriptor(this, "collapseTransformation", new BitField("_layerFlags2", 7));
    descriptor(this, "shy", new BitField("_layerFlags2", 6));
    descriptor(this, "locked", new BitField("_layerFlags2", 5));
    descriptor(this, "frameBlending", new BitField("_layerFlags2", 4));
    descriptor(this, "motionBlurFlag", new BitField("_layerFlags2", 3));
    descriptor(this, "effectsActive", new BitField("_layerFlags2", 2));
    descriptor(this, "audioEnabled", new BitField("_layerFlags2", 1));
    descriptor(this, "enabled", new BitField("_layerFlags2", 0));
    // byte 60: set while the layer has a comment (`cmta`); AE 2026 ignores
    // a `cmta` without it and clears both when the comment is emptied.
    descriptor(this, "hasComment", new BitField("_reserved3c", 0));
    // byte 103: _transfer_flags
    descriptor(this, "preserveTransparency", new BitField("_transferFlags", 0));
    descriptor(this, "dancingDissolve", new BitField("_transferFlags", 1));
  }
}

define(LdtaChunk, {
  chunkType: { default: "ldta" },

  // -- Identity / timing (bytes 0-35) ------------------------------------
  layerId: u4Field(),
  quality: u2Field(),
  _reserved06: bytesField(2, { repr: false }),
  stretchDividend: s4Field({ default: 1 }),
  startTimeDividend: s4Field(),
  startTimeDivisor: u4Field({ default: 1 }),
  inPointDividend: s4Field(),
  inPointDivisor: u4Field({ default: 1 }),
  outPointDividend: s4Field(),
  outPointDivisor: u4Field({ default: 1 }),

  // -- Flag bytes (bytes 36-39) ------------------------------------------
  _reserved24: bytesField(1, { repr: false }),
  _layerFlags0: u1Field({ repr: false }),
  _layerFlags1: u1Field({ repr: false }),
  _layerFlags2: u1Field({ default: 0x07, repr: false }),

  // -- Source / label (bytes 40-63) --------------------------------------
  sourceId: u4Field(),
  _reserved2c: bytesField(15, { repr: false }),
  _reserved3b: u1Field({ repr: false }),
  _reserved3c: u1Field({ repr: false }),
  label: u1Field(),
  _reserved3e: bytesField(2, { repr: false }),

  // -- Layer name (bytes 64-95, 32-byte UTF-8 strz) ---------------
  layerName: strField(32, { default: "", encoding: "utf-8" }),

  // -- Post-name fields (bytes 96-159) -----------------------------------
  _reserved60: bytesField(3, { repr: false }),
  blendingMode: u1Field(),
  _reserved64: bytesField(3, { repr: false }),
  _transferFlags: u1Field({ repr: false }),
  _reserved68: bytesField(3, { repr: false }),
  trackMatteType: u1Field(),
  stretchDivisor: u4Field({ default: 1 }),
  _reserved70: f8Field({ repr: false }),
  _reserved78: f8Field({ repr: false }),
  _reserved80: bytesField(3, { repr: false }),
  layerType: u1Field(),
  parentId: u4Field(),
  _reserved88: bytesField(3, { repr: false }),
  lightAndMeshType: u1Field(),
  _reserved8c: u4Field({ repr: false }),
  _reserved90: u4Field({ repr: false }),
  _reserved94: u4Field({ repr: false }),
  _reserved98: f8Field({ repr: false }),

  // -- Optional field (bytes 160-163, AE >= 23) --------------------------
  matteLayerId: u4Field({ default: null, optional: true }),
});

register("ldta")(LdtaChunk);
