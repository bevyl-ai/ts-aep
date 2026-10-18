/**
 * Output module resolution logic.
 *
 * Resolves After Effects output filename templates, computes effective
 * render dimensions, and formats timecodes.
 */

import { OutputChannels, OutputColorDepth, TimeSpanSource } from "../enums/index.ts";
import { IndexError, AepError, numStr, truthyOr, round } from "../../pyrt/index.ts";
import type { CompItem } from "../models/items/composition.ts";
import type { RenderSettingValues } from "../models/renderqueue/render_queue_item.ts";
import type { SettingsView } from "../models/renderqueue/settings.ts";

/** A malformed replacement template (Python `re.error`, `re.PatternError` since 3.13). */
export class PatternError extends AepError {}

// Roou format_id (4-char) to file extension.
export const FORMAT_ID_EXTENSIONS: Map<string, string> = new Map<string, string>([
  ["H264", "mp4"],
  [".AVI", "avi"],
  ["MooV", "mov"],
  ["Mp3 ", "mp3"],
  ["wao_", "wav"],
  ["TIF ", "tif"],
  ["8BPS", "psd"],
  ["png!", "png"],
  ["JPEG", "jpg"],
  ["oEXR", "exr"],
  ["AIFF", "aif"],
  ["SGI ", "sgi"],
  ["IFF ", "iff"],
  ["TPIC", "tga"],
  ["RHDR", "hdr"],
]);

export const FIELD_ORDER_NAMES: Map<number, string> = new Map<number, string>([
  [0, "Both"], // Off/Progressive - renders both fields
  [1, "UFF"], // Upper field first
  [2, "LFF"], // Lower field first
]);

export const PULLDOWN_PHASE_NAMES: Map<number, string> = new Map<number, string>([
  [0, ""],
  [1, "WSSWW"],
  [2, "SSWWW"],
  [3, "SWWWS"],
  [4, "WWWSS"],
  [5, "WWSSW"],
]);

export const OUTPUT_CHANNELS_NAMES: Map<OutputChannels, string> = new Map<OutputChannels, string>([
  [OutputChannels.RGB, "RGB"],
  [OutputChannels.RGBA, "RGBA"],
  [OutputChannels.ALPHA, "Alpha"],
]);

export const OUTPUT_COLOR_DEPTH_NAMES: Map<OutputColorDepth, string> = new Map<OutputColorDepth, string>([
  [OutputColorDepth.MILLIONS_OF_COLORS, "Millions"],
  [OutputColorDepth.MILLIONS_OF_COLORS_PLUS, "Millions+"],
  [OutputColorDepth.TRILLIONS_OF_COLORS, "Trillions"],
  [OutputColorDepth.TRILLIONS_OF_COLORS_PLUS, "Trillions+"],
  [OutputColorDepth.FLOATING_POINT, "Floating Point"],
  [OutputColorDepth.FLOATING_POINT_PLUS, "Floating Point+"],
]);

export const PROJECT_COLOR_DEPTH_NAMES: Map<number, string> = new Map<number, string>([
  [8, "8bit"],
  [16, "16bit"],
  [32, "32bit"],
]);

// Mapping of video codec FourCC codes to friendly names
export const VIDEO_CODEC_NAMES: Map<string, string> = new Map<string, string>([
  ["CTXF", "H.264"],
  ["FXTC", "H.264"],
  ["avc1", "H.264"],
  ["ap4h", "ProRes 4444"],
  ["apch", "ProRes 422 HQ"],
  ["apcn", "ProRes 422"],
  ["apcs", "ProRes 422 LT"],
  ["apco", "ProRes 422 Proxy"],
]);

// NOTE(port): local port of CPython 3.12 re._parser.parse_template for a pattern with
// zero capture groups (the only use: re.sub(rf"\[{key}\]", ...)); same escapes and errors.
export function _expandTemplate(template: string, match: string): string {
  if (!template.includes("\\")) {
    return template;
  }
  const OCT = "01234567";
  const DIGITS = "0123456789";
  const out: string[] = [];
  const ESCAPES: Record<string, string> = {
    "\\a": "\x07",
    "\\b": "\b",
    "\\f": "\f",
    "\\n": "\n",
    "\\r": "\r",
    "\\t": "\t",
    "\\v": "\v",
    "\\\\": "\\",
  };
  let i = 0;
  while (i < template.length) {
    const start = i;
    const ch = template[i++];
    if (ch !== "\\") {
      out.push(ch);
      continue;
    }
    if (i >= template.length) {
      throw new PatternError(`bad escape (end of pattern) at position ${start}`);
    }
    const c = template[i++];
    let this_ = ch + c;
    if (c === "g") {
      if (template[i] !== "<") {
        throw new PatternError(`missing < at position ${i}`);
      }
      i++;
      const end = template.indexOf(">", i);
      if (end < 0) {
        throw new PatternError(`missing >, unterminated name at position ${i}`);
      }
      const name = template.slice(i, end);
      i = end + 1;
      if (name === "") {
        throw new PatternError(`missing group name at position ${end}`);
      }
      if (/^[^\W\d]\w*$/u.test(name)) {
        throw new IndexError(`unknown group name '${name}'`);
      }
      if (!/^[0-9]+$/.test(name)) {
        throw new PatternError(`bad character in group name '${name}' at position ${end - name.length}`);
      }
      const index = Number(name);
      if (index > 0) {
        throw new PatternError(`invalid group reference ${index} at position ${i - this_.length - name.length - 1}`);
      }
      out.push(match);
    } else if (c === "0") {
      if (i < template.length && OCT.includes(template[i])) {
        this_ += template[i++];
        if (i < template.length && OCT.includes(template[i])) {
          this_ += template[i++];
        }
      }
      out.push(String.fromCharCode(parseInt(this_.slice(1), 8) & 0xff));
    } else if (DIGITS.includes(c)) {
      let isoctal = false;
      if (i < template.length && DIGITS.includes(template[i])) {
        this_ += template[i++];
        if (OCT.includes(c) && OCT.includes(this_[2]) && i < template.length && OCT.includes(template[i])) {
          this_ += template[i++];
          isoctal = true;
          const code = parseInt(this_.slice(1), 8);
          if (code > 0o377) {
            throw new PatternError(
              `octal escape value ${this_} outside of range 0-0o377 at position ${start}`,
            );
          }
          out.push(String.fromCharCode(code));
        }
      }
      if (!isoctal) {
        throw new PatternError(`invalid group reference ${Number(this_.slice(1))} at position ${start + 1}`);
      }
    } else if (this_ in ESCAPES) {
      out.push(ESCAPES[this_]);
    } else {
      if (/^[A-Za-z]$/.test(c)) {
        throw new PatternError(`bad escape ${this_} at position ${start}`);
      }
      out.push(this_);
    }
  }
  return out.join("");
}

export function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    [x, y] = [y, x % y];
  }
  return x;
}

/**
 * Calculate simplified aspect ratio string (e.g., '16x9').
 *
 * @param width - Frame width in pixels.
 * @param height - Frame height in pixels.
 * @returns Aspect ratio string like '16x9', '4x3', etc.
 */
export function calculateAspectRatio(width: number, height: number): string {
  const gcd_ = gcd(width, height);
  return `${Math.floor(width / gcd_)}x${Math.floor(height / gcd_)}`;
}

/**
 * Format frame number in After Effects feet+frames format.
 *
 * AE uses a feet+frames format where each foot is 16 frames (like 35mm
 * film). Format is FFFF+RR where FFFF is feet and RR is remaining frames.
 *
 * @param frame - Frame number (0-based).
 * @param fps - Frames per second (not used in this format).
 * @returns Formatted frame string like '0045+00' (45 feet, 0 frames).
 */
export function formatFrameNumber(frame: number, fps: number): string {
  const framesPerFoot = 16; // Standard 35mm film: 16 frames per foot
  const feet = Math.floor(frame / framesPerFoot);
  const remainingFrames = ((frame % framesPerFoot) + framesPerFoot) % framesPerFoot;
  return `${String(feet).padStart(4, "0")}+${String(remainingFrames).padStart(2, "0")}`;
}

/**
 * Format time as timecode string with dashes.
 *
 * @param seconds - Time in seconds.
 * @param fps - Frames per second.
 * @param isDuration - If true, uses ceiling for frame calculation (for
 *   durations). If false, uses floor (for absolute times).
 * @returns Timecode string like '0-00-00-00' (hours-minutes-seconds-frames).
 */
export function formatTimecode(seconds: number, fps: number, isDuration = false): string {
  const fpsInt = fps !== 0 ? Math.trunc(fps) : 1;
  // Use ceiling for durations, floor for absolute times
  let totalFrames: number;
  if (isDuration) {
    totalFrames = Math.ceil(seconds * fpsInt);
  } else {
    totalFrames = Math.trunc(seconds * fpsInt);
  }

  const frames = ((totalFrames % fpsInt) + fpsInt) % fpsInt;
  const totalSeconds = Math.floor(totalFrames / fpsInt);
  const secs = ((totalSeconds % 60) + 60) % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const mins = ((totalMinutes % 60) + 60) % 60;
  const hours = Math.floor(totalMinutes / 60);

  return `${hours}-${String(mins).padStart(2, "0")}-${String(secs).padStart(2, "0")}-${String(frames).padStart(2, "0")}`;
}

/**
 * Resolve an After Effects output filename template to the actual filename.
 *
 * After Effects stores output paths with template variables like
 * `[compName]` and `[fileExtension]`. This function resolves those
 * variables to produce the actual filename that would be rendered.
 *
 * @param fileTemplate - The file path containing template variables.
 *   e.g., `C:/Output/[compName].[fileExtension]`
 * @param projectName - The project name (without .aep extension) for
 *   `[projectName]`.
 * @param compName - The composition name for `[compName]`.
 * @param renderSettingsName - The render settings template name for
 *   `[renderSettingsName]`.
 * @param outputModuleName - The output module name for
 *   `[outputModuleName]`.
 * @param width - The composition width for `[width]`.
 * @param height - The composition height for `[height]`.
 * @param frameRate - The frame rate for `[frameRate]` and timecodes.
 * @param startFrame - The start frame for `[startFrame]`
 *   (feet+frames format).
 * @param endFrame - The end frame for `[endFrame]`
 *   (feet+frames format).
 * @param durationFrames - The duration in frames for `[durationFrames]`
 *   (feet+frames format).
 * @param startTime - The start time in seconds for `[startTimecode]`
 *   (uses floor).
 * @param endTime - The end time in seconds for `[endTimecode]`
 *   (uses floor).
 * @param durationTime - The duration in seconds for `[durationTimecode]`
 *   (uses ceiling).
 * @param channels - The output channels setting for `[channels]`.
 * @param projectColorDepth - The project bits per channel (8/16/32) for
 *   `[projectColorDepth]`.
 * @param outputColorDepth - The output color depth for
 *   `[outputColorDepth]`.
 * @param compressor - The video codec/compressor name for `[compressor]`.
 * @param fieldRender - The field render setting for `[fieldOrder]`.
 * @param pulldownPhase - The 3:2 pulldown phase for `[pulldownPhase]`.
 * @param fileExtension - The file extension for `[fileExtension]`.
 * @returns The resolved file path, or an empty string if file_template is None.
 */
export function resolveOutputFilename(
  fileTemplate: string,
  projectName: string | null = null,
  compName: string | null = null,
  renderSettingsName: string | null = null,
  outputModuleName = "",
  width: number | null = null,
  height: number | null = null,
  frameRate: number | null = null,
  startFrame: number | null = null,
  endFrame: number | null = null,
  durationFrames: number | null = null,
  startTime: number | null = null,
  endTime: number | null = null,
  durationTime: number | null = null,
  channels: OutputChannels | null = null,
  projectColorDepth: number | null = null,
  outputColorDepth: OutputColorDepth | null = null,
  compressor: string | null = null,
  fieldRender: number | null = null,
  pulldownPhase: number | null = null,
  fileExtension: string | null = null,
): string {
  if (!fileTemplate) {
    return "";
  }

  const fps: number = truthyOr(frameRate, 24.0);

  // Precompute formatted frame rate string
  let frameRateStr: string | null = null;
  if (frameRate != null) {
    frameRateStr = frameRate === Math.trunc(frameRate) ? `${Math.trunc(frameRate)}` : numStr(frameRate);
  }

  // Build substitution map: template_key -> resolved_value
  // Entries with None values are skipped during application
  const substitutions = new Map<string, string | null>([
    ["projectName", projectName],
    ["compName", compName],
    ["renderSettingsName", renderSettingsName],
    ["outputModuleName", outputModuleName],
    ["width", width != null ? `${width}` : null],
    ["height", height != null ? `${height}` : null],
    ["frameRate", frameRateStr],
    [
      "aspectRatio",
      width != null && height != null ? calculateAspectRatio(width, height) : null,
    ],
    ["startFrame", startFrame != null ? formatFrameNumber(startFrame, fps) : null],
    ["endFrame", endFrame != null ? formatFrameNumber(endFrame, fps) : null],
    [
      "durationFrames",
      durationFrames != null ? formatFrameNumber(durationFrames, fps) : null,
    ],
    [
      "startTimecode",
      startTime != null ? formatTimecode(startTime, fps, false) : null,
    ],
    ["endTimecode", endTime != null ? formatTimecode(endTime, fps, false) : null],
    [
      "durationTimecode",
      durationTime != null ? formatTimecode(durationTime, fps, true) : null,
    ],
    [
      "channels",
      channels != null ? OUTPUT_CHANNELS_NAMES.get(channels) ?? "RGB" : null,
    ],
    [
      "projectColorDepth",
      projectColorDepth != null ? PROJECT_COLOR_DEPTH_NAMES.get(projectColorDepth) ?? "8bit" : null,
    ],
    [
      "outputColorDepth",
      outputColorDepth != null ? OUTPUT_COLOR_DEPTH_NAMES.get(outputColorDepth) ?? "Millions" : null,
    ],
    ["compressor", compressor],
    [
      "fieldOrder",
      fieldRender != null ? FIELD_ORDER_NAMES.get(fieldRender) ?? "Off" : null,
    ],
    [
      "pulldownPhase",
      pulldownPhase != null ? PULLDOWN_PHASE_NAMES.get(pulldownPhase) ?? "Off" : null,
    ],
    ["projectFolder", ""], // Always resolves to empty string
    ["fileExtension", fileExtension],
  ]);

  let result = fileTemplate;
  for (const [key, value] of substitutions) {
    if (value != null) {
      _expandTemplate(value, ""); // re.sub compiles the template eagerly (raises on bad escapes)
      result = result.replace(new RegExp(`\\[${key}\\]`, "gi"), (match: string) =>
        _expandTemplate(value, match),
      );
    }
  }

  return result;
}

/**
 * Compute time span values based on render settings.
 *
 * Determines start/end frames, timecodes, and duration based on the
 * Time Span mode (Work Area, Length of Comp, or Custom).
 *
 * @param comp - The composition being rendered.
 * @param rqSettings - The render queue item's settings view.
 * @param effectiveFrameRate - The effective frame rate for rendering.
 * @returns Object with keys: start_frame, end_frame, duration_frames,
 *   start_time, end_time, duration_time.
 */
export function resolveTimeSpan(
  comp: CompItem,
  rqSettings: Pick<SettingsView<RenderSettingValues>, "get">,
  effectiveFrameRate: number,
): {
  startFrame: number;
  endFrame: number;
  durationFrames: number;
  startTime: number;
  endTime: number;
  durationTime: number;
} {
  const timeSpanMode = rqSettings.get("Time Span");

  let timeSpanStart: number;
  let durationTime: number;
  let timeSpanEnd: number;
  let durationFrames: number;
  let firstRenderedFrame: number;
  if (timeSpanMode === TimeSpanSource.LENGTH_OF_COMP) {
    timeSpanStart = 0.0;
    durationTime = comp.duration;
    timeSpanEnd = comp.duration;
    durationFrames = round(comp.duration * effectiveFrameRate);
    firstRenderedFrame = Math.trunc(comp.displayStartTime * effectiveFrameRate);
  } else {
    timeSpanStart = rqSettings.get("Time Span Start");
    durationTime = rqSettings.get("Time Span Duration");
    timeSpanEnd = rqSettings.get("Time Span End");
    durationFrames = round(durationTime * effectiveFrameRate);
    firstRenderedFrame =
      Math.trunc(comp.displayStartTime * effectiveFrameRate) +
      Math.trunc(timeSpanStart * effectiveFrameRate);
  }

  const startFrame = firstRenderedFrame;
  const endFrame = firstRenderedFrame + durationFrames;

  return {
    startFrame: startFrame,
    endFrame: endFrame,
    durationFrames: durationFrames,
    startTime: comp.displayStartTime + timeSpanStart,
    endTime: comp.displayStartTime + timeSpanEnd,
    durationTime: durationTime,
  };
}
