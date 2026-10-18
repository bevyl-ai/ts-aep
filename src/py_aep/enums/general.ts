/**
 * General After Effects enumerations.
 *
 * These enums match the values used in After Effects ExtendScript.
 */

import { ValueError, getitem, int, intEnum, repr, type EnumValue } from "../../pyrt/index.ts";
import type { EnumHelpers } from "../../pyrt/enum.ts";

/**
 * Label color for items, layers, keyframes and markers.
 *
 * Colors are represented by their number (0 for None, or 1 to 16 for one
 * of the preset colors in the Labels preferences).
 *
 * @see https://ae-scripting.docsforadobe.dev/item/item/#itemlabel
 */
export const Label = intEnum("Label", {
  NONE: 0,
  RED: 1,
  YELLOW: 2,
  AQUA: 3,
  PINK: 4,
  LAVENDER: 5,
  PEACH: 6,
  SEA_FOAM: 7,
  BLUE: 8,
  GREEN: 9,
  PURPLE: 10,
  ORANGE: 11,
  BROWN: 12,
  FUCHSIA: 13,
  CYAN: 14,
  SANDSTONE: 15,
  DARK_GREEN: 16,
}, {
  /** Convert binary value to Label. */
  fromBinary(value: number) {
    return this.of(int(value));
  },
});
export type Label = EnumValue<typeof Label>;

/**
 * Type of project item, as stored in the idta chunk.
 *
 * Does not exist in ExtendScript.
 */
export const ItemType = intEnum("ItemType", {
  FOLDER: 1,
  COMPOSITION: 4,
  FOOTAGE: 7,
});
export type ItemType = EnumValue<typeof ItemType>;

/**
 * Type of composition layer, as stored in the ldta chunk.
 *
 * Does not exist in ExtendScript.
 */
export const LayerType = intEnum("LayerType", {
  AV: 0,
  LIGHT: 1,
  CAMERA: 2,
  TEXT: 3,
  SHAPE: 4,
  THREE_D_MODEL: 5,
  PARAMETRIC_MESH: 7,
});
export type LayerType = EnumValue<typeof LayerType>;

/** Type of parametric mesh. */
export const ParametricMeshType = intEnum("ParametricMeshType", {
  CUBE: 14612,
  SPHERE: 14613,
  PLANE: 14614,
  TORUS: 14615,
  CONE: 14616,
  CYLINDER: 14617,
}, {
  /** Convert the ldta value (0-5) to ParametricMeshType. */
  fromBinary(value: number) {
    return this.of(value + 14612);
  },
  /** Convert ParametricMeshType to the ldta value (0-5). */
  toBinary(self: number): number {
    return int(self) - 14612;
  },
});
export type ParametricMeshType = EnumValue<typeof ParametricMeshType>;

/**
 * Defines how alpha information in footage is interpreted.
 *
 * @see https://ae-scripting.docsforadobe.dev/sources/footagesource/#footagesourcealphamode
 */
export const AlphaMode = intEnum("AlphaMode", {
  STRAIGHT: 5412,
  IGNORE: 5413,
  PREMULTIPLIED: 5414,
}, {
  /** Convert binary value to AlphaMode. */
  fromBinary(value: number) {
    return _ALPHA_MODE_BINARY_MAP.get(value) ?? this.IGNORE;
  },
  /** Convert AlphaMode to binary value. */
  toBinary(self: number): number {
    return getitem(_ALPHA_MODE_TO_BINARY, self);
  },
});
export type AlphaMode = EnumValue<typeof AlphaMode>;

export const _ALPHA_MODE_BINARY_MAP: Map<number, number> = new Map<number, number>([
  [0, AlphaMode.STRAIGHT],
  [1, AlphaMode.PREMULTIPLIED],
  [2, AlphaMode.IGNORE],
]);
export const _ALPHA_MODE_TO_BINARY: Map<number, number> = new Map<number, number>(
  [..._ALPHA_MODE_BINARY_MAP].map(([k, v]) => [v, k] as const),
);

/**
 * The color depth of the project.
 *
 * @see https://ae-scripting.docsforadobe.dev/general/project/#projectbitsperchannel
 */
export const BitsPerChannel = intEnum("BitsPerChannel", {
  EIGHT: 8,
  SIXTEEN: 16,
  THIRTY_TWO: 32,
}, {
  /** Convert binary value to BitsPerChannel. */
  fromBinary(value: number) {
    return _BITS_PER_CHANNEL_BINARY_MAP.get(value) ?? this.EIGHT;
  },
  /** Convert BitsPerChannel to binary value. */
  toBinary(self: number): number {
    return getitem(_BITS_PER_CHANNEL_TO_BINARY, self);
  },
});
export type BitsPerChannel = EnumValue<typeof BitsPerChannel>;

export const _BITS_PER_CHANNEL_BINARY_MAP: Map<number, number> = new Map<number, number>([
  [0, BitsPerChannel.EIGHT],
  [1, BitsPerChannel.SIXTEEN],
  [2, BitsPerChannel.THIRTY_TWO],
]);
export const _BITS_PER_CHANNEL_TO_BINARY: Map<number, number> = new Map<number, number>(
  [..._BITS_PER_CHANNEL_BINARY_MAP].map(([k, v]) => [v, k] as const),
);

/**
 * Auto-orientation mode for a layer.
 *
 * @see https://ae-scripting.docsforadobe.dev/layer/layer/#layerautoorient
 */
export const AutoOrientType = intEnum("AutoOrientType", {
  NO_AUTO_ORIENT: 4212,
  ALONG_PATH: 4213,
  CAMERA_OR_POINT_OF_INTEREST: 4214,
  CHARACTERS_TOWARD_CAMERA: 4215,
}, {
  /** Convert binary value (0-3) to AutoOrientType. */
  fromBinary(value: number) {
    return this.of(int(value) + 4212);
  },
  /** Convert AutoOrientType to binary value (0-3). */
  toBinary(self: number): number {
    return int(self) - 4212;
  },
});
export type AutoOrientType = EnumValue<typeof AutoOrientType>;

/**
 * Blending mode for a layer.
 *
 * @see https://ae-scripting.docsforadobe.dev/layer/avlayer/#avlayerblendingmode
 */
export const BlendingMode = intEnum("BlendingMode", {
  NORMAL: 5212,
  DISSOLVE: 5213,
  DANCING_DISSOLVE: 5214,
  DARKEN: 5215,
  MULTIPLY: 5216,
  LINEAR_BURN: 5217,
  COLOR_BURN: 5218,
  CLASSIC_COLOR_BURN: 5219,
  ADD: 5220,
  LIGHTEN: 5221,
  SCREEN: 5222,
  LINEAR_DODGE: 5223,
  COLOR_DODGE: 5224,
  CLASSIC_COLOR_DODGE: 5225,
  OVERLAY: 5226,
  SOFT_LIGHT: 5227,
  HARD_LIGHT: 5228,
  LINEAR_LIGHT: 5229,
  VIVID_LIGHT: 5230,
  PIN_LIGHT: 5231,
  HARD_MIX: 5232,
  DIFFERENCE: 5233,
  CLASSIC_DIFFERENCE: 5234,
  EXCLUSION: 5235,
  HUE: 5236,
  SATURATION: 5237,
  COLOR: 5238,
  LUMINOSITY: 5239,
  STENCIL_ALPHA: 5240,
  STENCIL_LUMA: 5241,
  SILHOUETE_ALPHA: 5242, // The typo is in the ExtendScript API
  SILHOUETTE_LUMA: 5243,
  ALPHA_ADD: 5244,
  LUMINESCENT_PREMUL: 5245,
  LIGHTER_COLOR: 5246,
  DARKER_COLOR: 5247,
  SUBTRACT: 5248,
  DIVIDE: 5249,
}, {
  /** Convert binary blending mode value to BlendingMode. */
  fromBinary(value: number) {
    return _BLENDING_MODE_BINARY_MAP.get(value) ?? this.NORMAL;
  },
  /**
   * Convert BlendingMode to its binary transfer-mode value.
   *
   * Dancing Dissolve shares Dissolve's transfer value (3); the two are
   * distinguished by a flag bit in the layer's `ldta`, set by
   * `AVLayer.blendingMode`, not by this value.
   */
  toBinary(self: number): number {
    return getitem(_BLENDING_MODE_TO_BINARY, self);
  },
});
export type BlendingMode = EnumValue<typeof BlendingMode>;

// Binary values match the AE SDK `PF_Xfer` transfer-mode enum
// (AE_EffectCB.h): 17-22 are MULTIPLY_(NOT_)ALPHA(_LUMA)/ADDITIVE_PREMUL
// (= stencil/silhouette/luminescent premul), 12/23/24 the classic
// (< PS 5.5) difference/dodge/burn and 26-28 their PS >= 6.0 variants.
export const _BLENDING_MODE_BINARY_MAP: Map<number, BlendingMode> = new Map<number, BlendingMode>([
  [0, BlendingMode.NORMAL], // cameras and lights (null layers store 2)
  [2, BlendingMode.NORMAL],
  [3, BlendingMode.DISSOLVE],
  [4, BlendingMode.ADD],
  [5, BlendingMode.MULTIPLY],
  [6, BlendingMode.SCREEN],
  [7, BlendingMode.OVERLAY],
  [8, BlendingMode.SOFT_LIGHT],
  [9, BlendingMode.HARD_LIGHT],
  [10, BlendingMode.DARKEN],
  [11, BlendingMode.LIGHTEN],
  [12, BlendingMode.CLASSIC_DIFFERENCE],
  [13, BlendingMode.HUE],
  [14, BlendingMode.SATURATION],
  [15, BlendingMode.COLOR],
  [16, BlendingMode.LUMINOSITY],
  [17, BlendingMode.STENCIL_ALPHA],
  [18, BlendingMode.STENCIL_LUMA],
  [19, BlendingMode.SILHOUETE_ALPHA],
  [20, BlendingMode.SILHOUETTE_LUMA],
  [21, BlendingMode.LUMINESCENT_PREMUL],
  [22, BlendingMode.ALPHA_ADD],
  [23, BlendingMode.CLASSIC_COLOR_DODGE],
  [24, BlendingMode.CLASSIC_COLOR_BURN],
  [25, BlendingMode.EXCLUSION],
  [26, BlendingMode.DIFFERENCE],
  [27, BlendingMode.COLOR_DODGE],
  [28, BlendingMode.COLOR_BURN],
  [29, BlendingMode.LINEAR_DODGE],
  [30, BlendingMode.LINEAR_BURN],
  [31, BlendingMode.LINEAR_LIGHT],
  [32, BlendingMode.VIVID_LIGHT],
  [33, BlendingMode.PIN_LIGHT],
  [34, BlendingMode.HARD_MIX],
  [35, BlendingMode.LIGHTER_COLOR],
  [36, BlendingMode.DARKER_COLOR],
  [37, BlendingMode.SUBTRACT],
  [38, BlendingMode.DIVIDE],
]);
// Reversed map: last key wins, so NORMAL -> 2 (not 0).
export const _BLENDING_MODE_TO_BINARY: Map<number, number> = new Map<number, number>(
  [..._BLENDING_MODE_BINARY_MAP].map(([k, v]) => [v, k] as const),
);
// Dancing Dissolve has no transfer-mode value of its own - it is Dissolve plus
// a flag bit in the layer's ldta. Map it to Dissolve's value so to_binary()
// never fails; AVLayer.blendingMode sets the distinguishing flag separately.
_BLENDING_MODE_TO_BINARY.set(BlendingMode.DANCING_DISSOLVE, 3);


/**
 * Channel display type for a viewer.
 *
 * @see https://ae-scripting.docsforadobe.dev/other/viewoptions/#attributes
 */
export const ChannelType = intEnum("ChannelType", {
  CHANNEL_RGB: 7812,
  CHANNEL_RED: 7813,
  CHANNEL_GREEN: 7814,
  CHANNEL_BLUE: 7815,
  CHANNEL_ALPHA: 7816,
  CHANNEL_RED_COLORIZE: 7817,
  CHANNEL_GREEN_COLORIZE: 7818,
  CHANNEL_BLUE_COLORIZE: 7819,
  CHANNEL_RGB_STRAIGHT: 7820,
  CHANNEL_ALPHA_OVERLAY: 7821,
  CHANNEL_ALPHA_BOUNDARY: 7822,
}, {
  /** Convert binary value to ChannelType. */
  fromBinary(value: number) {
    return this.ofOrNull(value + 7812) ?? this.CHANNEL_RGB;
  },
  /** Convert ChannelType to binary value. */
  toBinary(self: number): number {
    return int(self) - 7812;
  },
});
export type ChannelType = EnumValue<typeof ChannelType>;

/** Color management system for the project. */
export const ColorManagementSystem = intEnum("ColorManagementSystem", {
  ADOBE: 0,
  OCIO: 1,
});
export type ColorManagementSystem = EnumValue<typeof ColorManagementSystem>;

/** LUT interpolation method for the project. */
export const LutInterpolationMethod = intEnum("LutInterpolationMethod", {
  TRILINEAR: 0,
  TETRAHEDRAL: 1,
});
export type LutInterpolationMethod = EnumValue<typeof LutInterpolationMethod>;

/**
 * Options for closing a project.
 *
 * @see https://ae-scripting.docsforadobe.dev/general/project/#projectclose
 */
export const CloseOptions = intEnum("CloseOptions", {
  DO_NOT_SAVE_CHANGES: 1212,
  PROMPT_TO_SAVE_CHANGES: 1213,
  SAVE_CHANGES: 1214,
});
export type CloseOptions = EnumValue<typeof CloseOptions>;

/**
 * Fast preview mode for a composition.
 *
 * @see https://ae-scripting.docsforadobe.dev/other/viewoptions/#viewoptionsfastpreview
 */
export const FastPreviewType = intEnum("FastPreviewType", {
  FP_OFF: 8012,
  FP_ADAPTIVE_RESOLUTION: 8013,
  FP_DRAFT: 8014,
  FP_FAST_DRAFT: 8015,
  FP_WIREFRAME: 8016,
}, {
  /** Convert binary value to FastPreviewType. */
  fromBinary(value: number) {
    try {
      return this.of(int(value) + 8012);
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
      return this.FP_OFF;
    }
  },
  /** Convert FastPreviewType to binary value. */
  toBinary(self: number): number {
    return int(self) - 8012;
  },
});
export type FastPreviewType = EnumValue<typeof FastPreviewType>;

/**
 * Film type for feet+frames timecode display.
 *
 * @see https://ae-scripting.docsforadobe.dev/general/project/#projectfeetframesfilmtype
 */
export const FeetFramesFilmType = intEnum("FeetFramesFilmType", {
  MM16: 2412,
  MM35: 2413,
}, {
  /** Convert binary value (0-1) to FeetFramesFilmType. */
  fromBinary(value: number) {
    // Binary 0 = MM35 (2413), Binary 1 = MM16 (2412)
    return this.of(2413 - value);
  },
  /** Convert FeetFramesFilmType to binary value. */
  toBinary(self: number): number {
    return 2413 - int(self);
  },
});
export type FeetFramesFilmType = EnumValue<typeof FeetFramesFilmType>;

/**
 * How fields are separated in interlaced footage.
 *
 * @see https://ae-scripting.docsforadobe.dev/sources/footagesource/#footagesourcefieldseparationtype
 */
export const FieldSeparationType = intEnum("FieldSeparationType", {
  UPPER_FIELD_FIRST: 5612,
  OFF: 5613,
  LOWER_FIELD_FIRST: 5614,
}, {
  /** Convert binary value to FieldSeparationType. */
  fromBinary(value: number) {
    return _FIELD_SEP_BINARY_MAP.get(value) ?? this.OFF;
  },
  /** Convert FieldSeparationType to binary value. */
  toBinary(self: number): number {
    return getitem(_FIELD_SEP_TO_BINARY, self);
  },
});
export type FieldSeparationType = EnumValue<typeof FieldSeparationType>;

export const _FIELD_SEP_BINARY_MAP: Map<number, number> = new Map<number, number>([
  [0, FieldSeparationType.OFF],
  [1, FieldSeparationType.UPPER_FIELD_FIRST],
  [2, FieldSeparationType.LOWER_FIELD_FIRST],
]);
export const _FIELD_SEP_TO_BINARY: Map<number, number> = new Map<number, number>(
  [..._FIELD_SEP_BINARY_MAP].map(([k, v]) => [v, k] as const),
);

/**
 * How timecode is displayed for footage.
 *
 * @see https://ae-scripting.docsforadobe.dev/general/project/#projectfootagetimecodedisplaystarttype
 */
export const FootageTimecodeDisplayStartType = intEnum("FootageTimecodeDisplayStartType", {
  FTCS_USE_SOURCE_MEDIA: 2212,
  FTCS_START_0: 2213,
}, {
  /** Convert binary value to FootageTimecodeDisplayStartType. */
  fromBinary(value: number) {
    return _FOOTAGE_TIMECODE_BINARY_MAP.get(value) ?? this.FTCS_START_0;
  },
  /** Convert FootageTimecodeDisplayStartType to binary value. */
  toBinary(self: number): number {
    return getitem(_FOOTAGE_TIMECODE_TO_BINARY, self);
  },
});
export type FootageTimecodeDisplayStartType = EnumValue<typeof FootageTimecodeDisplayStartType>;

export const _FOOTAGE_TIMECODE_BINARY_MAP: Map<number, number> = new Map<number, number>([
  [0, FootageTimecodeDisplayStartType.FTCS_START_0],
  [1, FootageTimecodeDisplayStartType.FTCS_USE_SOURCE_MEDIA],
]);
export const _FOOTAGE_TIMECODE_TO_BINARY: Map<number, number> = new Map<number, number>(
  [..._FOOTAGE_TIMECODE_BINARY_MAP].map(([k, v]) => [v, k] as const),
);

/**
 * Frame blending mode for a layer.
 *
 * @see https://ae-scripting.docsforadobe.dev/layer/avlayer/#avlayerframeblendingtype
 */
export const FrameBlendingType = intEnum("FrameBlendingType", {
  NO_FRAME_BLEND: 4012,
  FRAME_MIX: 4013,
  PIXEL_MOTION: 4014,
}, {
  /** Convert binary value (0-2) to FrameBlendingType. */
  fromBinary(value: number) {
    return this.of(int(value) + 4012);
  },
  /** Convert FrameBlendingType to binary value (0-2). */
  toBinary(self: number): number {
    return int(self) - 4012;
  },
});
export type FrameBlendingType = EnumValue<typeof FrameBlendingType>;

/**
 * How frames are counted in the project.
 *
 * @see https://ae-scripting.docsforadobe.dev/general/project/#projectframescounttype
 */
export const FramesCountType = intEnum("FramesCountType", {
  FC_START_0: 2612,
  FC_START_1: 2613,
  FC_TIMECODE_CONVERSION: 2614,
}, {
  /** Convert binary value to FramesCountType. */
  fromBinary(value: number) {
    return this.ofOrNull(value + 2612) ?? this.FC_START_0;
  },
  /** Convert FramesCountType to binary value. */
  toBinary(self: number): number {
    return int(self) - 2612;
  },
});
export type FramesCountType = EnumValue<typeof FramesCountType>;

/**
 * GPU acceleration type.
 *
 * @see https://ae-scripting.docsforadobe.dev/general/project/#projectgpuacceltype
 */
export const GpuAccelType = intEnum("GpuAccelType", {
  OPENCL: 1812,
  CUDA: 1813,
  METAL: 1814,
  VULKAN: 1815,
  SOFTWARE: 1816,
  DIRECTX: 1817,
}, {
  /**
   * Map a gpuG UUID string to a GpuAccelType enum value.
   *
   * Returns the UUID string itself if the UUID is not recognized.
   */
  fromBinary(uuid: string): number | string {
    const result = _GPU_UUID_TO_ENUM.get(uuid) ?? null;
    return result != null ? result : uuid;
  },
  /**
   * Map a GpuAccelType enum value back to its UUID string.
   *
   * If value is already a UUID string, validates its format and
   * returns it as-is.
   *
   * @throws {@link ValueError} If the enum member has no known UUID mapping, or if a string value
   *   is not a valid UUID.
   */
  toBinary(this: EnumHelpers<GpuAccelType>, value: number | string): string {
    if (this.has(value)) {
      const uuid = _GPU_ENUM_TO_UUID.get(value) ?? null;
      if (uuid == null) {
        const known = [..._GPU_UUID_TO_ENUM]
          .map(([u, e]) => `${this.nameOf(e)} (${u})`)
          .join(", ");
        throw new ValueError(
          `no known UUID for GpuAccelType.${this.nameOf(value)}. ` +
            `Known values: ${known}. ` +
            `Set a UUID string directly if you know it.`,
        );
      }
      return uuid;
    }
    // re.match raises TypeError on non-str input
    if (typeof value !== "string") {
      throw new TypeError("expected string or bytes-like object, got '" + (value == null ? "NoneType" : typeof value) + "'");
    }
    // Python's `$` also matches before one trailing "\n"
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\n?$/i.test(value)) {
      throw new ValueError(
        `expected a valid UUID string ` +
          `(xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx), got ${repr(value)}`,
      );
    }
    return value;
  },
});
export type GpuAccelType = EnumValue<typeof GpuAccelType>;

export const _GPU_UUID_TO_ENUM: Map<string, GpuAccelType> = new Map<string, GpuAccelType>([
  ["7ee0ab59-822d-44cc-ac10-16279d041016", GpuAccelType.CUDA],
  ["f33089e2-1ede-47c1-8a9e-b232bb1cc1a4", GpuAccelType.SOFTWARE],
  ["6ed1497e-17ad-4a5b-846f-52bb81e20104", GpuAccelType.METAL],
  ["be93941a-7488-4117-8a46-7e3596950307", GpuAccelType.OPENCL],
  ["c4471277-d5d1-4ea7-a36c-b93ac76dfd41", GpuAccelType.VULKAN],
  ["cd99cfc1-bf65-4cb7-ab70-a8f5ea50e8f4", GpuAccelType.DIRECTX],
]);
export const _GPU_ENUM_TO_UUID: Map<GpuAccelType, string> = new Map<GpuAccelType, string>(
  [..._GPU_UUID_TO_ENUM].map(([k, v]) => [v, k] as const),
);

/**
 * Orientation type for a composition guide.
 *
 * **Note:** There is no ExtendScript equivalent for this enum.
 */
export const GuideOrientationType = intEnum("GuideOrientationType", {
  HORIZONTAL: 0,
  VERTICAL: 1,
}, {
  /** Convert binary value to GuideOrientationType. */
  fromBinary(value: number) {
    return _GUIDE_ORIENTATION_BINARY_MAP.get(value) ?? this.HORIZONTAL;
  },
  /** Convert GuideOrientationType to binary value. */
  toBinary(self: number): number {
    return getitem(_GUIDE_ORIENTATION_TO_BINARY, self);
  },
});
export type GuideOrientationType = EnumValue<typeof GuideOrientationType>;

export const _GUIDE_ORIENTATION_BINARY_MAP: Map<number, number> = new Map<number, number>([
  [2, GuideOrientationType.HORIZONTAL],
  [1, GuideOrientationType.VERTICAL],
]);
export const _GUIDE_ORIENTATION_TO_BINARY: Map<number, number> = new Map<number, number>(
  [..._GUIDE_ORIENTATION_BINARY_MAP].map(([k, v]) => [v, k] as const),
);

/**
 * How to import a file.
 *
 * @see https://ae-scripting.docsforadobe.dev/other/importoptions/#importoptionsimportas
 */
export const ImportAsType = intEnum("ImportAsType", {
  COMP_CROPPED_LAYERS: 3812,
  FOOTAGE: 3813,
  COMP: 3814,
  PROJECT: 3815,
});
export type ImportAsType = EnumValue<typeof ImportAsType>;

/**
 * Application language.
 *
 * @see https://ae-scripting.docsforadobe.dev/general/application/#appisolanguage
 */
export const Language = intEnum("Language", {
  ENGLISH: 1612,
  JAPANESE: 1613,
  GERMAN: 1614,
  FRENCH: 1615,
  ITALIAN: 1616,
  SPANISH: 1617,
  KOREAN: 1618,
  CHINESE: 1619,
  RUSSIAN: 1620,
  PORTUGUESE: 1621,
});
export type Language = EnumValue<typeof Language>;

/**
 * Render quality for a layer.
 *
 * @see https://ae-scripting.docsforadobe.dev/layer/avlayer/#avlayerquality
 */
export const LayerQuality = intEnum("LayerQuality", {
  WIREFRAME: 4612,
  DRAFT: 4613,
  BEST: 4614,
}, {
  /** Convert binary value to LayerQuality. */
  fromBinary(value: number) {
    return this.ofOrNull(value + 4612) ?? this.BEST;
  },
  /** Convert LayerQuality to binary value. */
  toBinary(self: number): number {
    return int(self) - 4612;
  },
});
export type LayerQuality = EnumValue<typeof LayerQuality>;

/**
 * Sampling quality for a layer.
 *
 * @see https://ae-scripting.docsforadobe.dev/layer/avlayer/#avlayersamplingquality
 */
export const LayerSamplingQuality = intEnum("LayerSamplingQuality", {
  BILINEAR: 4812,
  BICUBIC: 4813,
}, {
  /** Convert binary value to LayerSamplingQuality. */
  fromBinary(value: number) {
    return this.ofOrNull(value + 4812) ?? this.BILINEAR;
  },
  /** Convert LayerSamplingQuality to binary value. */
  toBinary(self: number): number {
    return int(self) - 4812;
  },
});
export type LayerSamplingQuality = EnumValue<typeof LayerSamplingQuality>;

/**
 * Type of light layer.
 *
 * @see https://ae-scripting.docsforadobe.dev/layer/lightlayer/#lightlayerlighttype
 */
export const LightType = intEnum("LightType", {
  PARALLEL: 4412,
  SPOT: 4413,
  POINT: 4414,
  AMBIENT: 4415,
  ENVIRONMENT: 4416,
}, {
  /** Convert binary value to LightType. */
  fromBinary(value: number) {
    return this.ofOrNull(value + 4412) ?? this.PARALLEL;
  },
  /** Convert LightType to binary value. */
  toBinary(self: number): number {
    return int(self) - 4412;
  },
});
export type LightType = EnumValue<typeof LightType>;

/**
 * Interpret As Linear Light setting for footage color management.
 *
 * Controls whether footage is treated as having linear gamma in the
 * Interpret Footage \> Color Management tab.
 *
 * **Note:** Not exposed in ExtendScript.
 */
export const LinearLightMode = intEnum("LinearLightMode", {
  OFF: 0,
  ON: 1,
  ON_FOR_32BPC: 2,
}, {
  /** Convert binary value to LinearLightMode. */
  fromBinary(value: number) {
    return this.ofOrNull(value) ?? this.OFF;
  },
  /** Convert LinearLightMode to binary value. */
  toBinary(self: number): number {
    return int(self);
  },
});
export type LinearLightMode = EnumValue<typeof LinearLightMode>;

/** Loop mode for preview playback. */
export const LoopMode = intEnum("LoopMode", {
  LOOP: 8412,
  PLAY_ONCE: 8413,
  PING_PONG: 8414,
});
export type LoopMode = EnumValue<typeof LoopMode>;

/**
 * Feather falloff type for masks.
 *
 * @see https://ae-scripting.docsforadobe.dev/property/maskpropertygroup/#maskpropertygroupmaskfeatherfalloff
 */
export const MaskFeatherFalloff = intEnum("MaskFeatherFalloff", {
  FFO_SMOOTH: 7212,
  FFO_LINEAR: 7213,
}, {
  /** Convert binary value to MaskFeatherFalloff. */
  fromBinary(value: number) {
    return this.ofOrNull(value + 7212) ?? this.FFO_SMOOTH;
  },
  /** Convert MaskFeatherFalloff to binary value. */
  toBinary(self: number): number {
    return self - 7212;
  },
});
export type MaskFeatherFalloff = EnumValue<typeof MaskFeatherFalloff>;

/**
 * Blending mode for masks.
 *
 * @see https://ae-scripting.docsforadobe.dev/property/maskpropertygroup/#maskpropertygroupmaskmode
 */
export const MaskMode = intEnum("MaskMode", {
  NONE: 6812,
  ADD: 6813,
  SUBTRACT: 6814,
  INTERSECT: 6815,
  LIGHTEN: 6816,
  DARKEN: 6817,
  DIFFERENCE: 6818,
}, {
  /** Convert binary mask mode value to MaskMode. */
  fromBinary(value: number) {
    return this.ofOrNull(value + 6812) ?? this.NONE;
  },
  /** Convert MaskMode to binary value. */
  toBinary(self: number): number {
    return self - 6812;
  },
});
export type MaskMode = EnumValue<typeof MaskMode>;

/**
 * Motion blur setting for masks.
 *
 * @see https://ae-scripting.docsforadobe.dev/property/maskpropertygroup/#maskpropertygroupmaskmotionblur
 */
export const MaskMotionBlur = intEnum("MaskMotionBlur", {
  SAME_AS_LAYER: 7012,
  ON: 7013,
  OFF: 7014,
}, {
  /**
   * Convert binary value to MaskMotionBlur.
   *
   * **Note:** binary 1 = Off and binary 2 = On (swapped relative
   * to enum integer order where ON = 7013 \< OFF = 7014).
   */
  fromBinary(value: number) {
    return _MASK_MOTION_BLUR_BINARY_MAP.get(value) ?? this.SAME_AS_LAYER;
  },
  /** Convert MaskMotionBlur to binary value. */
  toBinary(self: number): number {
    return getitem(_MASK_MOTION_BLUR_TO_BINARY, self);
  },
});
export type MaskMotionBlur = EnumValue<typeof MaskMotionBlur>;

export const _MASK_MOTION_BLUR_BINARY_MAP: Map<number, number> = new Map<number, number>([
  [0, MaskMotionBlur.SAME_AS_LAYER],
  [1, MaskMotionBlur.OFF],
  [2, MaskMotionBlur.ON],
]);
export const _MASK_MOTION_BLUR_TO_BINARY: Map<number, number> = new Map<number, number>(
  [..._MASK_MOTION_BLUR_BINARY_MAP].map(([k, v]) => [v, k] as const),
);

/**
 * Playback mode for preview.
 *
 * Not documented in AE scripting reference.
 */
export const PlayMode = intEnum("PlayMode", {
  SPACEBAR: 8212,
  RAM_PREVIEW: 8213,
});
export type PlayMode = EnumValue<typeof PlayMode>;

/**
 * Preference file types.
 *
 * @see https://ae-scripting.docsforadobe.dev/other/preferences/#preferences-object
 */
export const PREFType = intEnum("PREFType", {
  PREF_Type_MACHINE_SPECIFIC: 8812,
  PREF_Type_MACHINE_INDEPENDENT: 8813,
  PREF_Type_MACHINE_INDEPENDENT_RENDER: 8814,
  PREF_Type_MACHINE_INDEPENDENT_OUTPUT: 8815,
  PREF_Type_MACHINE_INDEPENDENT_COMPOSITION: 8816,
  PREF_Type_MACHINE_SPECIFIC_TEXT: 8817,
  PREF_Type_MACHINE_SPECIFIC_PAINT: 8818,
});
export type PREFType = EnumValue<typeof PREFType>;

/**
 * Type of a property.
 *
 * @see https://ae-scripting.docsforadobe.dev/property/propertybase/#propertybasepropertytype
 */
export const PropertyType = intEnum("PropertyType", {
  PROPERTY: 6212,
  NAMED_GROUP: 6213,
  INDEXED_GROUP: 6214,
});
export type PropertyType = EnumValue<typeof PropertyType>;

/**
 * Pulldown method for footage.
 *
 * @see https://ae-scripting.docsforadobe.dev/sources/footagesource/#footagesourceguesspulldown
 */
export const PulldownMethod = intEnum("PulldownMethod", {
  PULLDOWN_3_2: 6012,
  ADVANCE_24P: 6013,
});
export type PulldownMethod = EnumValue<typeof PulldownMethod>;

/**
 * Pulldown phase for footage.
 *
 * @see https://ae-scripting.docsforadobe.dev/sources/footagesource/#footagesourceremovepulldown
 */
export const PulldownPhase = intEnum("PulldownPhase", {
  WSSWW: 5812,
  OFF: 5813,
  SSWWW: 5814,
  SWWWS: 5815,
  WWWSS: 5816,
  WWSSW: 5817,
  WWWSW_24P_ADVANCE: 5818,
  WWSWW_24P_ADVANCE: 5819,
  WSWWW_24P_ADVANCE: 5820,
  SWWWW_24P_ADVANCE: 5821,
  WWWWS_24P_ADVANCE: 5822,
}, {
  /** Convert binary value to PulldownPhase. */
  fromBinary(value: number) {
    return _PULLDOWN_BINARY_MAP.get(value) ?? this.OFF;
  },
  /** Convert PulldownPhase to binary value. */
  toBinary(self: number): number {
    return getitem(_PULLDOWN_TO_BINARY, self);
  },
});
export type PulldownPhase = EnumValue<typeof PulldownPhase>;

export const _PULLDOWN_BINARY_MAP: Map<number, number> = new Map<number, number>([
  [0, PulldownPhase.OFF],
  [1, PulldownPhase.WSSWW],
  [2, PulldownPhase.SSWWW],
  [3, PulldownPhase.SWWWS],
  [4, PulldownPhase.WWWSS],
  [5, PulldownPhase.WWSSW],
  [6, PulldownPhase.WWWSW_24P_ADVANCE],
  [7, PulldownPhase.WWSWW_24P_ADVANCE],
  [8, PulldownPhase.WSWWW_24P_ADVANCE],
  [9, PulldownPhase.SWWWW_24P_ADVANCE],
  [10, PulldownPhase.WWWWS_24P_ADVANCE],
]);
export const _PULLDOWN_TO_BINARY: Map<number, number> = new Map<number, number>(
  [..._PULLDOWN_BINARY_MAP].map(([k, v]) => [v, k] as const),
);

/**
 * Target for purging caches.
 *
 * @see https://ae-scripting.docsforadobe.dev/general/application/#apppurge
 */
export const PurgeTarget = intEnum("PurgeTarget", {
  ALL_CACHES: 1412,
  UNDO_CACHES: 1413,
  SNAPSHOT_CACHES: 1414,
  IMAGE_CACHES: 1415,
});
export type PurgeTarget = EnumValue<typeof PurgeTarget>;

/**
 * Conflict resolution type for team projects.
 *
 * @see https://ae-scripting.docsforadobe.dev/general/project/#projectresolveconflict
 */
export const ResolveType = intEnum("ResolveType", {
  ACCEPT_THEIRS: 8612,
  ACCEPT_THEIRS_AND_COPY: 8613,
  ACCEPT_YOURS: 8614,
});
export type ResolveType = EnumValue<typeof ResolveType>;

/**
 * How time is displayed in the project.
 *
 * @see https://ae-scripting.docsforadobe.dev/general/project/#projecttimedisplaytype
 */
export const TimeDisplayType = intEnum("TimeDisplayType", {
  TIMECODE: 2012,
  FRAMES: 2013,
}, {
  /** Convert binary value to TimeDisplayType. */
  fromBinary(value: number) {
    return this.ofOrNull(value + 2012) ?? this.TIMECODE;
  },
  /** Convert TimeDisplayType to binary value. */
  toBinary(self: number): number {
    return int(self) - 2012;
  },
});
export type TimeDisplayType = EnumValue<typeof TimeDisplayType>;

/**
 * Tool type in the application.
 *
 * @see https://ae-scripting.docsforadobe.dev/general/project/#projecttooltype
 */
export const ToolType = intEnum("ToolType", {
  Tool_Arrow: 9012,
  Tool_Rotate: 9013,
  Tool_CameraMaya: 9014,
  Tool_CameraOrbit: 9015,
  Tool_CameraOrbitCamera: 9015,
  Tool_CameraPanCamera: 9016,
  Tool_CameraTrackXY: 9016,
  Tool_CameraDollyCamera: 9017,
  Tool_CameraTrackZ: 9017,
  Tool_Paintbrush: 9018,
  Tool_CloneStamp: 9019,
  Tool_Eraser: 9020,
  Tool_Hand: 9021,
  Tool_Magnify: 9022,
  Tool_PanBehind: 9023,
  Tool_Rect: 9024,
  Tool_RoundedRect: 9025,
  Tool_Oval: 9026,
  Tool_Polygon: 9027,
  Tool_Star: 9028,
  Tool_TextH: 9029,
  Tool_TextV: 9030,
  Tool_Pen: 9031,
  Tool_Feather: 9032,
  Tool_PenPlus: 9033,
  Tool_PenMinus: 9034,
  Tool_PenConvert: 9035,
  Tool_Pin: 9036,
  Tool_PinStarch: 9037,
  Tool_PinBend: 9038,
  Tool_PinDepth: 9040,
  Tool_Quickselect: 9041,
  Tool_Hairbrush: 9042,
  Tool_PinAdvanced: 9043,
  Tool_CameraOrbitCursor: 9044,
  Tool_CameraOrbitScene: 9045,
  Tool_CameraPanCursor: 9046,
  Tool_CameraDollyTowardsCursor: 9047,
  Tool_CameraDollyToCursor: 9048,
});
export type ToolType = EnumValue<typeof ToolType>;

/**
 * Track matte type for a layer.
 *
 * @see https://ae-scripting.docsforadobe.dev/layer/avlayer/#avlayertrackmattetype
 */
export const TrackMatteType = intEnum("TrackMatteType", {
  NO_TRACK_MATTE: 5012,
  ALPHA: 5013,
  ALPHA_INVERTED: 5014,
  LUMA: 5015,
  LUMA_INVERTED: 5016,
}, {
  /** Convert binary value to TrackMatteType. */
  fromBinary(value: number) {
    return this.ofOrNull(value + 5012) ?? this.NO_TRACK_MATTE;
  },
  /** Convert TrackMatteType to binary value. */
  toBinary(self: number): number {
    return int(self) - 5012;
  },
});
export type TrackMatteType = EnumValue<typeof TrackMatteType>;

/**
 * Type of viewer panel.
 *
 * @see https://ae-scripting.docsforadobe.dev/other/viewer/#viewertype
 */
export const ViewerType = intEnum("ViewerType", {
  VIEWER_COMPOSITION: 7612,
  VIEWER_LAYER: 7613,
  VIEWER_FOOTAGE: 7614,
}, {
  /**
   * Map a viewer panel type label string to a ViewerType enum.
   *
   * The `fitt` chunk stores the inner tab type as an ASCII string
   * (e.g. `"AE Composition"`). This converts that string to the
   * corresponding ViewerType value. Handles null-terminated strings
   * and empty input.
   *
   * @throws {@link ValueError} If the label is not recognized.
   */
  fromString(label: string | null): ViewerType {
    if (!label) label = "";
    const viewerType = _VIEWER_STRING_MAP.get(label);
    if (viewerType === undefined) throw new ValueError(`Unknown viewer type label: ${repr(label)}`);
    return viewerType;
  },
});
export type ViewerType = EnumValue<typeof ViewerType>;

export const _VIEWER_STRING_MAP: Map<string, ViewerType> = new Map<string, ViewerType>([
  ["AE Composition", ViewerType.VIEWER_COMPOSITION],
  ["AE Layer", ViewerType.VIEWER_LAYER],
  ["AE Footage", ViewerType.VIEWER_FOOTAGE],
]);

/**
 * Lighting correction for Content-Aware Fill.
 *
 * Not documented in AE scripting reference.
 */
export const FillLightingCorrectionType = intEnum("FillLightingCorrectionType", {
  LightingCorrection_NONE: 9812,
  LightingCorrection_SUBTLE: 9813,
  LightingCorrection_MODERATE: 9814,
  LightingCorrection_STRONG: 9815,
});
export type FillLightingCorrectionType = EnumValue<typeof FillLightingCorrectionType>;

/**
 * Fill method for Content-Aware Fill.
 *
 * Not documented in AE scripting reference.
 */
export const FillMethodType = intEnum("FillMethodType", {
  Method_OBJECT: 9412,
  Method_SURFACE: 9413,
  Method_EDGEBLEND: 9414,
});
export type FillMethodType = EnumValue<typeof FillMethodType>;

/**
 * Output depth for Content-Aware Fill.
 *
 * Not documented in AE scripting reference.
 */
export const FillOutputDepthType = intEnum("FillOutputDepthType", {
  OutputDepth_PROJECT: 9612,
  OutputDepth_EIGHT: 9613,
  OutputDepth_SIXTEEN: 9614,
  OutputDepth_FLOAT: 9615,
});
export type FillOutputDepthType = EnumValue<typeof FillOutputDepthType>;

/**
 * Range for Content-Aware Fill.
 *
 * Not documented in AE scripting reference.
 */
export const FillRangeType = intEnum("FillRangeType", {
  Range_ENTIRE: 9212,
  Range_WORKAREA: 9213,
});
export type FillRangeType = EnumValue<typeof FillRangeType>;

/**
 * Thread type for project operations.
 *
 * Not documented in AE scripting reference.
 */
export const ProjectThread = intEnum("ProjectThread", {
  MainThread: 2812,
  RQThread: 2813,
  WorkQueueThread: 2814,
});
export type ProjectThread = EnumValue<typeof ProjectThread>;
