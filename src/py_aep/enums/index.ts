/**
 * After Effects enumerations.
 *
 * These enums match the values used in After Effects ExtendScript.
 *
 * Submodules:
 * - {@link py_aep.enums.general | general}: Core layer, footage, project, viewer
 *   and mask enums.
 * - {@link py_aep.enums.property | property}: Property system enums
 *   (control type, value type, keyframe interpolation).
 * - {@link py_aep.enums.rendererOptions | renderer_options}: 3D renderer option enums
 *   (shadow map resolution, environment light shadow resolution).
 * - {@link py_aep.enums.render_settings | render_settings}: Render settings enums
 *   (quality, field render, motion blur, effects, etc.).
 * - {@link py_aep.enums.renderQueue | render_queue}: Render queue item enums
 *   (status, log type, settings format).
 * - {@link py_aep.enums.output_module | output_module}: Output module enums
 *   (channels, depth, color mode, format, audio settings, post-render action).
 * - {@link py_aep.enums.formatOptions | format_options}: Format-specific option
 *   enums (Cineon, JPEG, PNG, OpenEXR, audio/video codecs).
 * - {@link py_aep.enums.text_document | text_document}: Text document enums
 *   (justification, baseline, kerning, font caps, etc.).
 * - {@link py_aep.enums.fontObject | font_object}: Font object enums
 *   (technology, type, script).
 */

// font_object
export { CTFontTechnology, CTFontType, CTScript } from "./font_object.ts";

// format_options
export {
  AudioCodec,
  AudioInterleave,
  CineonFileFormat,
  DnxResolution,
  Hdr10ColorPrimaries,
  JpegFormatType,
  MPEGAudioFormat,
  MPEGAudioLayer,
  MPEGMultiplexer,
  MPEGMuxStreamCompatibility,
  MPEGProfile,
  OpenExrCompression,
  PngCompression,
  VideoCodec,
} from "./format_options.ts";

// general
export {
  AlphaMode,
  AutoOrientType,
  BitsPerChannel,
  BlendingMode,
  ChannelType,
  CloseOptions,
  ColorManagementSystem,
  FastPreviewType,
  FeetFramesFilmType,
  FieldSeparationType,
  FillLightingCorrectionType,
  FillMethodType,
  FillOutputDepthType,
  FillRangeType,
  FootageTimecodeDisplayStartType,
  FrameBlendingType,
  FramesCountType,
  GpuAccelType,
  GuideOrientationType,
  ImportAsType,
  ItemType,
  Label,
  Language,
  LayerQuality,
  LayerSamplingQuality,
  LayerType,
  LightType,
  LinearLightMode,
  LoopMode,
  LutInterpolationMethod,
  MaskFeatherFalloff,
  MaskMode,
  MaskMotionBlur,
  ParametricMeshType,
  PlayMode,
  PREFType,
  ProjectThread,
  PropertyType,
  PulldownMethod,
  PulldownPhase,
  PurgeTarget,
  ResolveType,
  TimeDisplayType,
  ToolType,
  TrackMatteType,
  ViewerType,
} from "./general.ts";

// output_module
export {
  AudioBitDepth,
  AudioChannels,
  AudioSampleRate,
  ConvertToLinearLight,
  FormatKind,
  OutputAudio,
  OutputChannels,
  OutputColorDepth,
  OutputColorMode,
  OutputFormat,
  PostRenderAction,
  ResizeQuality,
} from "./output_module.ts";

// property
export { KeyframeInterpolationType, PropertyControlType, PropertyValueType } from "./property.ts";

// render_queue
export { GetSettingsFormat, LogType, RQItemStatus } from "./render_queue.ts";

// render_settings
export {
  ColorDepthSetting,
  DiskCacheSetting,
  EffectsSetting,
  FieldRender,
  FrameBlendingSetting,
  FrameRateSetting,
  GuideLayers,
  MotionBlurSetting,
  PostRenderActionSetting,
  ProxyUseSetting,
  PulldownSetting,
  RenderQuality,
  SoloSwitchesSetting,
  TimeSpanSource,
} from "./render_settings.ts";

// renderer_options
export { EnvironmentLightShadowResolution, ShadowMapResolution } from "./renderer_options.ts";

// text_document
export {
  AutoKernType,
  BaselineDirection,
  BoxAutoFitPolicy,
  BoxFirstBaselineAlignment,
  BoxVerticalAlignment,
  ComposerEngine,
  DigitSet,
  FontBaselineOption,
  FontCapsOption,
  LeadingType,
  LineJoinType,
  LineOrientation,
  ParagraphDirection,
  ParagraphJustification,
  VariableFontSpacing,
} from "./text_document.ts";
