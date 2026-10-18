/** py_aep - A .aep (After Effects Project) parser. */

// Registers every chunk type before any parsing starts (Python: the trailing
// registration imports at the end of binary/chunk.py).
import "./binary/_register.ts";

import { BytesIO, Path, fspath, type PathLike } from "../pyrt/index.ts";
import { AlphaMode, AudioBitDepth, AudioChannels, AudioSampleRate, AutoKernType, AutoOrientType, BaselineDirection, BitsPerChannel, BlendingMode, BoxAutoFitPolicy, BoxFirstBaselineAlignment, BoxVerticalAlignment, ChannelType, CloseOptions, ColorDepthSetting, ColorManagementSystem, ComposerEngine, CTFontTechnology, CTFontType, CTScript, DigitSet, DiskCacheSetting, EffectsSetting, EnvironmentLightShadowResolution, FastPreviewType, FeetFramesFilmType, FieldRender, FieldSeparationType, FillLightingCorrectionType, FillMethodType, FillOutputDepthType, FillRangeType, FontBaselineOption, FontCapsOption, FootageTimecodeDisplayStartType, FrameBlendingSetting, FrameBlendingType, FrameRateSetting, FramesCountType, GetSettingsFormat, GpuAccelType, GuideLayers, GuideOrientationType, ImportAsType, KeyframeInterpolationType, Label, Language, LayerQuality, LayerSamplingQuality, LeadingType, LightType, LinearLightMode, LineJoinType, LineOrientation, LogType, LoopMode, LutInterpolationMethod, MaskFeatherFalloff, MaskMode, MaskMotionBlur, MotionBlurSetting, OutputAudio, OutputChannels, OutputColorDepth, OutputColorMode, OutputFormat, ParagraphDirection, ParagraphJustification, ParametricMeshType, PlayMode, PostRenderAction, PREFType, ProjectThread, PropertyControlType, PropertyType, PropertyValueType, ProxyUseSetting, PulldownMethod, PulldownPhase, PulldownSetting, PurgeTarget, RenderQuality, ResizeQuality, ResolveType, RQItemStatus, ShadowMapResolution, SoloSwitchesSetting, TimeDisplayType, TimeSpanSource, ToolType, TrackMatteType, ViewerType } from "./enums/index.ts";
import { CURRENT_VALUE, AdvancedRendererOptions, Application, AVItem, AVLayer, CameraLayer, Cinema4DRendererOptions, CineonFormatOptions, ClassicRendererOptions, CompItem, FeatherPoint, FileSource, FolderItem, FontObject, FootageItem, FootageSource, Guide, ImportOptions, Item, JpegFormatOptions, Keyframe, KeyframeEase, Layer, LightLayer, MarkerValue, MaskPropertyGroup, OpenExrFormatOptions, OutputModule, ParametricMeshLayer, PlaceholderSource, PngFormatOptions, Preferences, Project, Property, PropertyBase, PropertyGroup, RayTracedRendererOptions, RendererOptionsBase, RenderQueue, RenderQueueItem, SettingsView, Shape, ShapeLayer, SolidSource, TargaFormatOptions, TextDocument, TextLayer, ThreeDModelLayer, TiffFormatOptions, View, Viewer, ViewOptions, XmlFormatOptions } from "./models/index.ts";
import { validateAeRelease, validatePlatform } from "./models/validators.ts";
import { CompPreset } from "./parsers/comp_presets.ts";
import { listLayers } from "./resolvers/source_layers.ts";
import { readAep } from "./binary/chunk.ts";
import { parseApp } from "./parsers/application.ts";
import { parseProject } from "./parsers/project.ts";

// NOTE(port): Python falls back to "0.0.0" when package metadata is absent; this port has no installed py_aep distribution (package.json is also 0.0.0), so the fallback is the Python value.
export const __version__ = "0.0.0";

/**
 * Parse an After Effects (.aep) project file and return an {@link Application} instance.
 *
 * This is the main entry point for the library. It parses the binary
 * RIFX data and returns an {@link Application} object whose
 * {@link Application.project | project} attribute
 * holds the full project tree.
 *
 * @param aepFilePath - Path to the `.aep` file.
 * @param kw - Options:
 * - `aePreferencesDir`: Optional path to the AE preferences directory (e.g. `C:/Users/<user>/AppData/Roaming/Adobe/After Effects/25.6`). When provided, render settings and output module templates are parsed lazily when needed.
 * - `platform`: The After Effects platform the project is for: `"windows"` or `"macos"`. Footage and render output paths py_aep writes are stored in that platform's style (`C:\\x` \<-\> `/x`, see {@link py_aep.resolvers.platform_paths.platform_path | platform_path}), and imported footage is recorded the way After Effects on that platform records it: BMP and GIF files take the platform's importer code (After Effects on the other platform refuses an image sequence tagged for it), and on Windows a HEIC file has no alpha channel. Defaults to the running operating system.
 *
 * @example
 * ```ts
 * import { parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const project = app.project;
 * console.log(app.version);
 * ```
 */
export function parse(
  aepFilePath: string | PathLike,
  kw: { aePreferencesDir?: string | PathLike | null; platform?: string | null } = {},
): Application {
  const { aePreferencesDir = null, platform = null } = kw;
  // NOTE(port): py-aep defers only Layr. tdgp also covers the property trees
  // of the comp-level SLay/CLay/SecL/DLay lists and effect definitions, which
  // parsing never reads.
  const _DEFERRED_LIST_TYPES: ReadonlySet<string> = new Set(["Layr", "tdgp"]);

  if (platform != null) {
    validatePlatform(platform);
  }
  const filePath = fspath(aepFilePath);
  const prefsPath = aePreferencesDir ? new Path(aePreferencesDir) : null;
  // `with open(file_path, "rb") as f:`
  const f = new BytesIO(new Path(filePath).readBytes());
  const [rifx, xmp] = readAep(f, { deferListTypes: _DEFERRED_LIST_TYPES });
  const project = parseProject(rifx, xmp, filePath, prefsPath);
  if (platform != null) {
    project._platform = platform;
  }
  return parseApp(rifx, project);
}

// Default target version: the AE build the empty-project skeleton was
// captured from (AE 2026).
export const _DEFAULT_NEW_VERSION = "26.0x67";

/**
 * Creates a new project in After Effects, replicating the File \> New \> New Project
 * menu command.
 *
 * Returns an {@link Application} wrapping an empty {@link Project} (containing
 * only the root folder and an empty render queue).
 *
 * @param version - The After Effects version to stamp into the file,
 *   formatted as `"{major}.{minor}x{build}"` (e.g. `"26.0x67"`).
 *   A file stamped at version N opens in After Effects N and later.
 *   The major must be an After Effects release: 15 (CC 2018) to 18,
 *   or 22 and later. A release newer than 26 gets the After Effects
 *   2026 project and file-format stamp, so the file also opens in
 *   After Effects 2026.
 * @param kw - Options:
 * - `aePreferencesDir`: Optional path to the AE preferences directory (e.g. `C:/Users/<user>/AppData/Roaming/Adobe/After Effects/26.0`), required only for adding items to the render queue.
 * - `platform`: The After Effects platform the project is for, as in {@link py_aep.parse | parse}. It also selects the header stamps and the GPU renderer (Metal on macOS, CUDA on Windows) a project created on that platform carries. Defaults to the running operating system.
 *
 * @throws ValueError If `version` is malformed, names a major before 26 that
 *   py_aep has no file-format stamp for (before 15, or 19 to 21), or
 *   has a major or build above 255 or a minor above 15 (the head
 *   chunk's field widths).
 *
 * @example
 * ```ts
 * import { new as new_project } from "@bevyl-ai/ts-aep";
 *
 * const app = new_project();
 * const comp = app.project.rootFolder.addComp("Comp 1", 1920, 1080, 1.0, 10.0, 30.0);
 * app.project.save("new_project.aep");
 * ```
 */
export function new_(
  version: string = _DEFAULT_NEW_VERSION,
  kw: { aePreferencesDir?: string | PathLike | null; platform?: string | null } = {},
): Application {
  const { aePreferencesDir = null, platform = null } = kw;
  validateAeRelease(version);
  if (platform != null) {
    validatePlatform(platform);
  }
  const prefsPath = aePreferencesDir ? new Path(aePreferencesDir) : null;
  return Application._new(version, prefsPath, platform);
}

export { AdvancedRendererOptions, AlphaMode, Application, AudioBitDepth, AudioChannels, AudioSampleRate, AutoKernType, AutoOrientType, AVItem, AVLayer, BaselineDirection, BitsPerChannel, BlendingMode, BoxAutoFitPolicy, BoxFirstBaselineAlignment, BoxVerticalAlignment, CameraLayer, ChannelType, Cinema4DRendererOptions, CineonFormatOptions, ClassicRendererOptions, CloseOptions, ColorDepthSetting, ColorManagementSystem, CompPreset, CompItem, ComposerEngine, CTFontTechnology, CTFontType, CTScript, DigitSet, DiskCacheSetting, EffectsSetting, EnvironmentLightShadowResolution, FastPreviewType, FeatherPoint, FeetFramesFilmType, FieldRender, FieldSeparationType, FileSource, FillLightingCorrectionType, FillMethodType, FillOutputDepthType, FillRangeType, FolderItem, FontBaselineOption, FontCapsOption, FontObject, FootageItem, FootageSource, FootageTimecodeDisplayStartType, FrameBlendingSetting, FrameBlendingType, FrameRateSetting, FramesCountType, GetSettingsFormat, GpuAccelType, GuideOrientationType, GuideLayers, Guide, ImportAsType, ImportOptions, Item, CURRENT_VALUE, JpegFormatOptions, Keyframe, KeyframeEase, KeyframeInterpolationType, Label, Language, Layer, LayerQuality, LayerSamplingQuality, LeadingType, LightLayer, LightType, LinearLightMode, LineJoinType, LineOrientation, listLayers, LogType, LoopMode, LutInterpolationMethod, MarkerValue, MaskFeatherFalloff, MaskMode, MaskMotionBlur, MaskPropertyGroup, MotionBlurSetting, new_ as new, OpenExrFormatOptions, OutputAudio, OutputChannels, OutputColorDepth, OutputColorMode, OutputFormat, OutputModule, ParametricMeshLayer, ParametricMeshType, ParagraphDirection, ParagraphJustification, PlaceholderSource, PlayMode, PngFormatOptions, PostRenderAction, Preferences, PREFType, Project, ProjectThread, Property, PropertyBase, PropertyControlType, PropertyGroup, PropertyType, PropertyValueType, ProxyUseSetting, PulldownMethod, PulldownPhase, PulldownSetting, PurgeTarget, RayTracedRendererOptions, RendererOptionsBase, RenderQuality, RenderQueue, RenderQueueItem, ResizeQuality, ResolveType, RQItemStatus, SettingsView, ShadowMapResolution, Shape, ShapeLayer, SolidSource, SoloSwitchesSetting, TargaFormatOptions, TextDocument, TextLayer, ThreeDModelLayer, TiffFormatOptions, TimeDisplayType, TimeSpanSource, ToolType, TrackMatteType, View, Viewer, ViewerType, ViewOptions, XmlFormatOptions };

// Host file system controls (not part of py_aep's Python API): browsers and
// Workers read and write through the in-memory fs; see README "Use".
export { memfs, useMemoryFs, useHostFs, fsBackend } from "../pyrt/host.ts";

// Last import: registers every `deferred()` target (pyrt/deferred.ts).
import "./_modules.ts";
