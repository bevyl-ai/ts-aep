/** Tests for RenderQueue model parsing. */

// `from __future__ import annotations` is dropped: no annotation here is
// evaluated at runtime. `os.getenv` becomes `process.env` (None → null), and
// `pytest.mark.parametrize` becomes `test.each` (see src/pyrt/pytest.ts). The
// Python package registers every chunk type on import, so the TS test imports
// `_register.ts` to do the same.

import { describe, expect, test } from "bun:test";

import { Path, b, Bytes, len, valueEquals } from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { OutputModuleSettingsItem, RenderSettingsItem } from "../../src/py_aep/binary/render_chunks.ts";
import { OutputChannels, OutputColorDepth } from "../../src/py_aep/enums/index.ts";
import { parseOutputTemplates, parseRenderTemplates } from "../../src/py_aep/parsers/templates.ts";
import { resolveOutputFilename } from "../../src/py_aep/resolvers/output.ts";
import { makeTmpPath } from "../support/pytest.ts";

const SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models", "renderqueue");
const OM_SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models", "output_module");
const BUGS_DIR = new Path(import.meta.dir, "..", "..", "samples", "bugs");
const AE_PREFS_DIR = process.env.AE_PREFS_DIR ?? null;
const OCS_SAMPLES_DIR = new Path(
  import.meta.dir,
  "..",
  "..",
  "samples",
  "models",
  "output_module",
  "output_color_space",
);

/**
 * The keyword arguments of `resolve_output_filename` after `file_template`, in
 * Python signature order. The Python tests pass these as `**kwargs`; TS takes them
 * positionally, so each one is placed at its signature slot. A missing key is
 * `undefined`, which triggers the TS default exactly like omitting the argument.
 */
type ResolveOutputFilenameParams = Parameters<typeof resolveOutputFilename>;
interface ResolveOutputFilenameKwargs {
  project_name?: ResolveOutputFilenameParams[1];
  comp_name?: ResolveOutputFilenameParams[2];
  render_settings_name?: ResolveOutputFilenameParams[3];
  output_module_name?: ResolveOutputFilenameParams[4];
  width?: ResolveOutputFilenameParams[5];
  height?: ResolveOutputFilenameParams[6];
  frame_rate?: ResolveOutputFilenameParams[7];
  start_frame?: ResolveOutputFilenameParams[8];
  end_frame?: ResolveOutputFilenameParams[9];
  duration_frames?: ResolveOutputFilenameParams[10];
  start_time?: ResolveOutputFilenameParams[11];
  end_time?: ResolveOutputFilenameParams[12];
  duration_time?: ResolveOutputFilenameParams[13];
  channels?: ResolveOutputFilenameParams[14];
  project_color_depth?: ResolveOutputFilenameParams[15];
  output_color_depth?: ResolveOutputFilenameParams[16];
  compressor?: ResolveOutputFilenameParams[17];
  field_render?: ResolveOutputFilenameParams[18];
  pulldown_phase?: ResolveOutputFilenameParams[19];
  file_extension?: ResolveOutputFilenameParams[20];
}

/** `resolve_output_filename(template, **kwargs)` */
function resolveOutputFilenameKw(fileTemplate: string, kwargs: ResolveOutputFilenameKwargs): string {
  return resolveOutputFilename(
    fileTemplate,
    kwargs.project_name,
    kwargs.comp_name,
    kwargs.render_settings_name,
    kwargs.output_module_name,
    kwargs.width,
    kwargs.height,
    kwargs.frame_rate,
    kwargs.start_frame,
    kwargs.end_frame,
    kwargs.duration_frames,
    kwargs.start_time,
    kwargs.end_time,
    kwargs.duration_time,
    kwargs.channels,
    kwargs.project_color_depth,
    kwargs.output_color_depth,
    kwargs.compressor,
    kwargs.field_render,
    kwargs.pulldown_phase,
    kwargs.file_extension,
  );
}

test("test_output_module_preserves_noncanonical_true_byte", () => {
  const raw = new Uint8Array(new OutputModuleSettingsItem().tobytes());
  raw[47] = 0x03;

  const settings = OutputModuleSettingsItem.frombytes(new Uint8Array(raw));

  expect(settings.includeProjectLink).toBe(true);
  expect(valueEquals(settings.tobytes(), raw)).toBe(true);
});

test("test_output_module_template_copy_preserves_include_project_link_byte", () => {
  const source = new OutputModuleSettingsItem();
  source._includeProjectLink = 0x03;
  const target = new OutputModuleSettingsItem();
  target._includeProjectLink = 0x00;

  target.copySettingsFrom(source);

  expect(target._includeProjectLink).toBe(0x03);
});

describe("TestResolveOutputFilename", () => {
  /** Unit tests for resolve_output_filename(). */

  test("test_empty_template", () => {
    expect(resolveOutputFilename("")).toBe("");
  });

  test.each([
    ["[projectName]", { project_name: "MyProject" }, "MyProject"],
    ["[compName]", { comp_name: "Comp 1" }, "Comp 1"],
    [
      "[renderSettingsName]",
      { render_settings_name: "Best Settings" },
      "Best Settings",
    ],
    ["[outputModuleName]", { output_module_name: "Lossless" }, "Lossless"],
    ["[width]", { width: 1920 }, "1920"],
    ["[height]", { height: 1080 }, "1080"],
    ["[frameRate]", { frame_rate: 30.0 }, "30"],
    ["[frameRate]", { frame_rate: 29.97 }, "29.97"],
    ["[compressor]", { compressor: "H.264" }, "H.264"],
    ["[COMPNAME]", { comp_name: "MyComp" }, "MyComp"],
  ])("test_single_token[%#]", (template: string, kwargs: ResolveOutputFilenameKwargs, expected: string) => {
    expect(resolveOutputFilenameKw(template, kwargs)).toBe(expected);
  });

  test("test_aspect_ratio", () => {
    const result = resolveOutputFilenameKw("[aspectRatio]", { width: 1920, height: 1080 });
    expect(result).toBe("16x9");
  });

  test.each([
    [OutputChannels.RGB, "RGB"],
    [OutputChannels.RGBA, "RGBA"],
    [OutputChannels.ALPHA, "Alpha"],
  ])("test_channels[%#]", (channels: OutputChannels, expected: string) => {
    expect(resolveOutputFilenameKw("[channels]", { channels })).toBe(expected);
  });

  test.each([
    [8, "8bit"],
    [16, "16bit"],
    [32, "32bit"],
  ])("test_project_color_depth[%#]", (depth: number, expected: string) => {
    expect(resolveOutputFilenameKw("[projectColorDepth]", { project_color_depth: depth })).toBe(expected);
  });

  test.each([
    [OutputColorDepth.MILLIONS_OF_COLORS, "Millions"],
    [OutputColorDepth.MILLIONS_OF_COLORS_PLUS, "Millions+"],
    [OutputColorDepth.TRILLIONS_OF_COLORS, "Trillions"],
    [OutputColorDepth.TRILLIONS_OF_COLORS_PLUS, "Trillions+"],
    [OutputColorDepth.FLOATING_POINT, "Floating Point"],
    [OutputColorDepth.FLOATING_POINT_PLUS, "Floating Point+"],
  ])("test_output_color_depth[%#]", (colorDepth: OutputColorDepth, expected: string) => {
    expect(resolveOutputFilenameKw("[outputColorDepth]", { output_color_depth: colorDepth })).toBe(expected);
  });

  test("test_file_extension", () => {
    const result = resolveOutputFilenameKw("[compName].[fileExtension]", {
      comp_name: "MyComp",
      file_extension: "mp4",
    });
    expect(result).toBe("MyComp.mp4");
  });

  test("test_combined_template", () => {
    const result = resolveOutputFilenameKw("[projectName]_[compName]_[width]x[height].[fileExtension]", {
      project_name: "Proj",
      comp_name: "Comp1",
      width: 1920,
      height: 1080,
      file_extension: "mov",
    });
    expect(result).toBe("Proj_Comp1_1920x1080.mov");
  });

  test.each([
    ["[startTimecode]", { start_time: 0.0, frame_rate: 24.0 }, "0-00-00-00"],
    ["[endTimecode]", { end_time: 10.0, frame_rate: 24.0 }, "0-00-10-00"],
    ["[durationTimecode]", { duration_time: 5.0, frame_rate: 24.0 }, "0-00-05-00"],
  ])("test_timecode[%#]", (template: string, kwargs: ResolveOutputFilenameKwargs, expected: string) => {
    expect(resolveOutputFilenameKw(template, kwargs)).toBe(expected);
  });

  test("test_project_folder_empty", () => {
    const result = resolveOutputFilenameKw("[projectFolder][compName]", { comp_name: "MyComp" });
    expect(result).toBe("MyComp");
  });
});

class TestRenderTemplatesDefaultIndex {
  /**
   * The prefs default index is remapped to the filtered template list.
   *
   * Regression: parse_render_templates filtered out empty-named entries
   * but returned the raw "Default RS Index", so any skipped entry before
   * the default shifted the selection to the wrong template.
   */

  static _write_render_prefs(prefsDir: Path, defaultIdx: number, names: string[]): void {
    // The prefs item is the 2246-byte AEP layout minus the last 64 bytes.
    let raw = Bytes.repeat(b("\x00"), 32);
    for (const name of names) {
      raw = Bytes.concat(raw, Bytes.slice(new RenderSettingsItem({ templateName: name }).tobytes(), 0, 2182));
    }
    prefsDir
      .div("Adobe After Effects 26.0 Prefs-indep-render.txt")
      .writeText(
        '["Render Settings Preference Section"]\n' +
          '\t"Render Settings List" = ' +
          Bytes.toHex(raw) +
          "\n" +
          '\t"Default RS Index" = "' +
          String(defaultIdx) +
          '"\n',
      );
  }

  static _write_output_prefs(prefsDir: Path, defaultIdx: number, names: string[]): void {
    const raw = Bytes.concat(
      Bytes.repeat(b("\x00"), 32),
      Bytes.repeat(new OutputModuleSettingsItem().tobytes(), len(names)),
    );
    const lines = [
      '["Output Module Preference Section"]',
      '\t"Output Module List v28" = ' + Bytes.toHex(raw),
      '\t"Default OM Index" = "' + String(defaultIdx) + '"',
    ];
    for (const [i, name] of names.entries()) {
      lines.push(`\t"Output Module Spec Strings Name #${i}" = "${name}"`);
    }
    prefsDir.div("Adobe After Effects 26.0 Prefs-indep-output.txt").writeText(lines.join("\n") + "\n");
  }
}

describe("TestRenderTemplatesDefaultIndex", () => {
  /**
   * The prefs default index is remapped to the filtered template list.
   *
   * Regression: parse_render_templates filtered out empty-named entries
   * but returned the raw "Default RS Index", so any skipped entry before
   * the default shifted the selection to the wrong template.
   */

  test("test_render_default_shifts_past_filtered_entry", () => {
    const tmpPath = makeTmpPath();
    // Empty-named entry at raw index 0; raw default index 2 ("Best").
    TestRenderTemplatesDefaultIndex._write_render_prefs(tmpPath, 2, ["", "Draft", "Best"]);
    const [templates, default_] = parseRenderTemplates(tmpPath);
    expect(valueEquals(templates.map((t) => t.cleanTemplateName), ["Draft", "Best"])).toBe(true);
    expect(default_).toBe(1);
    if (default_ == null) throw new Error("no default render template");
    expect(templates[default_].cleanTemplateName).toBe("Best");
  });

  test("test_render_default_filtered_out_yields_none", () => {
    const tmpPath = makeTmpPath();
    // The default entry itself has an empty name -> no default.
    TestRenderTemplatesDefaultIndex._write_render_prefs(tmpPath, 0, ["", "Draft", "Best"]);
    const [_templates, default_] = parseRenderTemplates(tmpPath);
    expect(default_ == null).toBe(true);
  });

  test("test_output_default_shifts_past_hidden_entry", () => {
    const tmpPath = makeTmpPath();
    // _HIDDEN entry at raw index 0; raw default index 1 ("Lossless").
    TestRenderTemplatesDefaultIndex._write_output_prefs(tmpPath, 1, ["_HIDDEN X", "Lossless", "TIFF"]);
    const [templates, default_] = parseOutputTemplates(tmpPath);
    expect(valueEquals(templates.map((t) => t.name), ["Lossless", "TIFF"])).toBe(true);
    expect(default_).toBe(0);
    if (default_ == null) throw new Error("no default output template");
    expect(templates[default_].name).toBe("Lossless");
  });
});
