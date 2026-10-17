/**
 * Output module resolution logic.
 *
 * Resolves After Effects output filename templates, computes effective
 * render dimensions, and formats timecodes.
 */

import { OutputChannels, OutputColorDepth, TimeSpanSource } from "../enums/index.ts";
import { IndexError, PyException, floordiv, format, int, mod, num_str, py_or, round } from "../../pyrt/index.ts";
import type { CompItem } from "../models/items/composition.ts";
import type { RenderSettingValues } from "../models/renderqueue/render_queue_item.ts";
import type { SettingsView } from "../models/renderqueue/settings.ts";

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
export function _expand_template(template: string, match: string): string {
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
      throw new PyException(`bad escape (end of pattern) at position ${start}`);
    }
    const c = template[i++];
    let this_ = ch + c;
    if (c === "g") {
      if (template[i] !== "<") {
        throw new PyException(`missing < at position ${i}`);
      }
      i++;
      const end = template.indexOf(">", i);
      if (end < 0) {
        throw new PyException(`missing >, unterminated name at position ${i}`);
      }
      const name = template.slice(i, end);
      i = end + 1;
      if (name === "") {
        throw new PyException(`missing group name at position ${end}`);
      }
      if (/^[^\W\d]\w*$/u.test(name)) {
        throw new IndexError(`unknown group name '${name}'`);
      }
      if (!/^[0-9]+$/.test(name)) {
        throw new PyException(`bad character in group name '${name}' at position ${end - name.length}`);
      }
      const index = Number(name);
      if (index > 0) {
        throw new PyException(`invalid group reference ${index} at position ${i - this_.length - name.length - 1}`);
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
            throw new PyException(
              `octal escape value ${this_} outside of range 0-0o377 at position ${start}`,
            );
          }
          out.push(String.fromCharCode(code));
        }
      }
      if (!isoctal) {
        throw new PyException(`invalid group reference ${Number(this_.slice(1))} at position ${start + 1}`);
      }
    } else if (this_ in ESCAPES) {
      out.push(ESCAPES[this_]);
    } else {
      if (/^[A-Za-z]$/.test(c)) {
        throw new PyException(`bad escape ${this_} at position ${start}`);
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
export function calculate_aspect_ratio(width: number, height: number): string {
  const gcd_ = gcd(width, height);
  return `${floordiv(width, gcd_)}x${floordiv(height, gcd_)}`;
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
export function format_frame_number(frame: number, fps: number): string {
  const frames_per_foot = 16; // Standard 35mm film: 16 frames per foot
  const feet = floordiv(frame, frames_per_foot);
  const remaining_frames = mod(frame, frames_per_foot);
  return `${format(feet, "04d")}+${format(remaining_frames, "02d")}`;
}

/**
 * Format time as timecode string with dashes.
 *
 * @param seconds - Time in seconds.
 * @param fps - Frames per second.
 * @param is_duration - If true, uses ceiling for frame calculation (for
 *   durations). If false, uses floor (for absolute times).
 * @returns Timecode string like '0-00-00-00' (hours-minutes-seconds-frames).
 */
export function format_timecode(seconds: number, fps: number, is_duration = false): string {
  const fps_int = fps !== 0 ? int(fps) : 1;
  // Use ceiling for durations, floor for absolute times
  let total_frames: number;
  if (is_duration) {
    total_frames = Math.ceil(seconds * fps_int);
  } else {
    total_frames = int(seconds * fps_int);
  }

  const frames = mod(total_frames, fps_int);
  const total_seconds = floordiv(total_frames, fps_int);
  const secs = mod(total_seconds, 60);
  const total_minutes = floordiv(total_seconds, 60);
  const mins = mod(total_minutes, 60);
  const hours = floordiv(total_minutes, 60);

  return `${hours}-${format(mins, "02d")}-${format(secs, "02d")}-${format(frames, "02d")}`;
}

/**
 * Resolve an After Effects output filename template to the actual filename.
 *
 * After Effects stores output paths with template variables like
 * `[compName]` and `[fileExtension]`. This function resolves those
 * variables to produce the actual filename that would be rendered.
 *
 * @param file_template - The file path containing template variables.
 *   e.g., `C:/Output/[compName].[fileExtension]`
 * @param project_name - The project name (without .aep extension) for
 *   `[projectName]`.
 * @param comp_name - The composition name for `[compName]`.
 * @param render_settings_name - The render settings template name for
 *   `[renderSettingsName]`.
 * @param output_module_name - The output module name for
 *   `[outputModuleName]`.
 * @param width - The composition width for `[width]`.
 * @param height - The composition height for `[height]`.
 * @param frame_rate - The frame rate for `[frameRate]` and timecodes.
 * @param start_frame - The start frame for `[startFrame]`
 *   (feet+frames format).
 * @param end_frame - The end frame for `[endFrame]`
 *   (feet+frames format).
 * @param duration_frames - The duration in frames for `[durationFrames]`
 *   (feet+frames format).
 * @param start_time - The start time in seconds for `[startTimecode]`
 *   (uses floor).
 * @param end_time - The end time in seconds for `[endTimecode]`
 *   (uses floor).
 * @param duration_time - The duration in seconds for `[durationTimecode]`
 *   (uses ceiling).
 * @param channels - The output channels setting for `[channels]`.
 * @param project_color_depth - The project bits per channel (8/16/32) for
 *   `[projectColorDepth]`.
 * @param output_color_depth - The output color depth for
 *   `[outputColorDepth]`.
 * @param compressor - The video codec/compressor name for `[compressor]`.
 * @param field_render - The field render setting for `[fieldOrder]`.
 * @param pulldown_phase - The 3:2 pulldown phase for `[pulldownPhase]`.
 * @param file_extension - The file extension for `[fileExtension]`.
 * @returns The resolved file path, or an empty string if file_template is None.
 */
export function resolve_output_filename(
  file_template: string,
  project_name: string | null = null,
  comp_name: string | null = null,
  render_settings_name: string | null = null,
  output_module_name = "",
  width: number | null = null,
  height: number | null = null,
  frame_rate: number | null = null,
  start_frame: number | null = null,
  end_frame: number | null = null,
  duration_frames: number | null = null,
  start_time: number | null = null,
  end_time: number | null = null,
  duration_time: number | null = null,
  channels: OutputChannels | null = null,
  project_color_depth: number | null = null,
  output_color_depth: OutputColorDepth | null = null,
  compressor: string | null = null,
  field_render: number | null = null,
  pulldown_phase: number | null = null,
  file_extension: string | null = null,
): string {
  if (!file_template) {
    return "";
  }

  const fps: number = py_or(frame_rate, 24.0);

  // Precompute formatted frame rate string
  let frame_rate_str: string | null = null;
  if (frame_rate != null) {
    frame_rate_str = frame_rate === int(frame_rate) ? `${int(frame_rate)}` : num_str(frame_rate);
  }

  // Build substitution map: template_key -> resolved_value
  // Entries with None values are skipped during application
  const substitutions = new Map<string, string | null>([
    ["projectName", project_name],
    ["compName", comp_name],
    ["renderSettingsName", render_settings_name],
    ["outputModuleName", output_module_name],
    ["width", width != null ? `${width}` : null],
    ["height", height != null ? `${height}` : null],
    ["frameRate", frame_rate_str],
    [
      "aspectRatio",
      width != null && height != null ? calculate_aspect_ratio(width, height) : null,
    ],
    ["startFrame", start_frame != null ? format_frame_number(start_frame, fps) : null],
    ["endFrame", end_frame != null ? format_frame_number(end_frame, fps) : null],
    [
      "durationFrames",
      duration_frames != null ? format_frame_number(duration_frames, fps) : null,
    ],
    [
      "startTimecode",
      start_time != null ? format_timecode(start_time, fps, false) : null,
    ],
    ["endTimecode", end_time != null ? format_timecode(end_time, fps, false) : null],
    [
      "durationTimecode",
      duration_time != null ? format_timecode(duration_time, fps, true) : null,
    ],
    [
      "channels",
      channels != null ? OUTPUT_CHANNELS_NAMES.get(channels) ?? "RGB" : null,
    ],
    [
      "projectColorDepth",
      project_color_depth != null ? PROJECT_COLOR_DEPTH_NAMES.get(project_color_depth) ?? "8bit" : null,
    ],
    [
      "outputColorDepth",
      output_color_depth != null ? OUTPUT_COLOR_DEPTH_NAMES.get(output_color_depth) ?? "Millions" : null,
    ],
    ["compressor", compressor],
    [
      "fieldOrder",
      field_render != null ? FIELD_ORDER_NAMES.get(field_render) ?? "Off" : null,
    ],
    [
      "pulldownPhase",
      pulldown_phase != null ? PULLDOWN_PHASE_NAMES.get(pulldown_phase) ?? "Off" : null,
    ],
    ["projectFolder", ""], // Always resolves to empty string
    ["fileExtension", file_extension],
  ]);

  let result = file_template;
  for (const [key, value] of substitutions) {
    if (value != null) {
      _expand_template(value, ""); // re.sub compiles the template eagerly (raises on bad escapes)
      result = result.replace(new RegExp(`\\[${key}\\]`, "gi"), (match: string) =>
        _expand_template(value, match),
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
 * @param rq_settings - The render queue item's settings view.
 * @param effective_frame_rate - The effective frame rate for rendering.
 * @returns Object with keys: start_frame, end_frame, duration_frames,
 *   start_time, end_time, duration_time.
 */
export function resolve_time_span(
  comp: CompItem,
  rq_settings: Pick<SettingsView<RenderSettingValues>, "__getitem__">,
  effective_frame_rate: number,
): {
  start_frame: number;
  end_frame: number;
  duration_frames: number;
  start_time: number;
  end_time: number;
  duration_time: number;
} {
  const time_span_mode = rq_settings.__getitem__("Time Span");

  let time_span_start: number;
  let duration_time: number;
  let time_span_end: number;
  let duration_frames: number;
  let first_rendered_frame: number;
  if (time_span_mode === TimeSpanSource.LENGTH_OF_COMP) {
    time_span_start = 0.0;
    duration_time = comp.duration;
    time_span_end = comp.duration;
    duration_frames = round(comp.duration * effective_frame_rate);
    first_rendered_frame = int(comp.display_start_time * effective_frame_rate);
  } else {
    time_span_start = rq_settings.__getitem__("Time Span Start");
    duration_time = rq_settings.__getitem__("Time Span Duration");
    time_span_end = rq_settings.__getitem__("Time Span End");
    duration_frames = round(duration_time * effective_frame_rate);
    first_rendered_frame =
      int(comp.display_start_time * effective_frame_rate) +
      int(time_span_start * effective_frame_rate);
  }

  const start_frame = first_rendered_frame;
  const end_frame = first_rendered_frame + duration_frames;

  return {
    start_frame,
    end_frame,
    duration_frames,
    start_time: comp.display_start_time + time_span_start,
    end_time: comp.display_start_time + time_span_end,
    duration_time,
  };
}
