/**
 * Regression tests for the v9 fuzz findings on new projects, versions,
 * working space and saving.
 *
 * After Effects 2026 (26.0x67) evidence: `py_aep.new()` projects stamped with a
 * major that was never an AE release opened as "missing data in file"
 * (21.0x1), "internal verification failure" (0.0x0), or with every mask,
 * effect and shape-element name read as "Utf8" (12, 13, 14, 19 and 20).
 */

import { describe, expect, test } from "bun:test";
import * as py_aep from "../../src/py_aep/index.ts";
import { parse } from "../../src/py_aep/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { project_bytes } from "../helpers.ts";
import { b, bytes_, bytes_eq, py_eq, sorted, TypeError_, ValueError } from "../../src/pyrt/index.ts";
import { make_tmp_path, raises } from "../../src/pyrt/pytest.ts";

// NOTE(port): `raises()` takes a single class; this local helper implements the
// Python `pytest.raises((A, B))` tuple form (isinstance any-match, rethrow otherwise).
function _raises_any(classes: Array<abstract new (...a: never[]) => Error>, fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    for (const c of classes) if (e instanceof c) return e;
    throw e;
  }
  throw new Error("DID NOT RAISE");
}

describe("TestVersionValidation", () => {
  test.each([
    "15.1x69",
    "16.0x1",
    "17.0x1",
    "18.0x1",
    "22.6x60",
    "23.0x1",
    "24.0x1",
    "25.6x101",
    "26.0x67",
    "26.15x255",
  ])("test_releases_accepted[%#]", (version: string) => {
    expect(py_aep.new(version).version).toBe(version);
  });

  test.each([
    "0.0x0",
    "12.0x1",
    "14.0x1",
    "19.0x1",
    "20.0x1",
    "21.0x1",
    "256.0x1",
  ])("test_unknown_major_rejected[%#]", (version: string) => {
    raises(ValueError, () => py_aep.new(version));
  });

  test.each(["27.0x67", "185.0x67", "255.0x67"])(
    "test_newer_major_takes_the_ae_2026_project[%#]",
    (version: string) => {
      // No stamp to take for a release after 26: the AE 2026 project and
      // stamp, which AE 2026 opens. Only the version differs.
      const app = py_aep.new(version);
      expect(app.version).toBe(version);
      const head = app._head;
      expect(py_eq([head.file_format_version, head._format_subversion], [97, 2])).toBe(true);
      app.version = "26.0x67";
      expect(bytes_eq(project_bytes(app.project), project_bytes(py_aep.new().project))).toBe(true);
    },
  );

  test.each(["26.16x1", "26.0x256", "26.99x1"])("test_field_overflow_rejected[%#]", (version: string) => {
    // The head chunk holds the minor in 4 bits and the build in 8: these
    // used to wrap to 26.0x1, 26.0x0 and 26.3x1.
    raises(ValueError, () => py_aep.new(version));
  });

  test.each([26, null, "26.0", " 26.0x67"])("test_malformed_rejected[%#]", (version) => {
    _raises_any([TypeError_, ValueError], () =>
      // @ts-expect-error deliberately passes non-string versions to check runtime validation
      py_aep.new(version),
    );
  });

  test.each(["21.0x1", "26.16x3", "300.0x1"])("test_setter_rejects_without_mutation[%#]", (version: string) => {
    const app = py_aep.new();
    const before = project_bytes(app.project);
    raises(ValueError, () => {
      app.version = version;
    });
    expect(bytes_eq(project_bytes(app.project), before)).toBe(true);
    expect(app.version).toBe("26.0x67");
  });

  test.each([
    // AE 2026 opened each of these relabelled projects unchanged.
    ["15.1x2", "16.0x1"],
    ["16.0x1", "15.1x2"],
    ["17.0x1", "18.0x1"],
    ["18.0x1", "22.6x60"],
    ["22.6x60", "18.0x1"],
    ["23.0x1", "26.0x67"],
    ["26.0x67", "23.0x1"],
  ])("test_relabel_within_a_layout[%#]", (source: string, target: string) => {
    const app = py_aep.new(source);
    app.version = target;
    expect(app.version).toBe(target);
  });

  test.each([
    // AE 2026: "chunk in file too big" (26 as 22), "file is damaged" or no
    // answer (22 as 23), no answer (16 as 22).
    ["26.0x67", "22.6x60"],
    ["22.6x60", "23.0x1"],
    ["16.0x1", "22.6x60"],
    ["26.0x67", "15.1x2"],
    ["18.0x1", "26.0x67"],
  ])("test_relabel_across_a_layout_rejected[%#]", (source: string, target: string) => {
    const app = py_aep.new(source);
    const before = project_bytes(app.project);
    raises(ValueError, () => {
      app.version = target;
    });
    expect(bytes_eq(project_bytes(app.project), before)).toBe(true);
  });

  test.each([256, -1, "67"])("test_build_number_range[%#]", (build) => {
    const app = py_aep.new();
    _raises_any([TypeError_, ValueError], () => {
      // @ts-expect-error deliberately assigns a string build number to check runtime validation
      app.build_number = build;
    });
    expect(app.build_number).toBe(67);
  });
});

describe("TestWorkingSpaceNone", () => {
  test("test_none_round_trips", () => {
    const tmp_path = make_tmp_path();
    // AE 2026 accepts workingSpace = "None": `PwCs` keeps `{}` and `cpid`
    // is all 0xFF, as in a new project.
    const app = py_aep.new();
    const before = project_bytes(app.project);
    app.project.working_space = app.project.working_space;
    expect(app.project.working_space).toBe("None");
    expect(bytes_eq(project_bytes(app.project), before)).toBe(true);
  });

  test("test_none_after_a_profile", () => {
    const tmp_path = make_tmp_path();
    const app = py_aep.new();
    const cpid = app.project._cpid.data;
    const utf8 = app.project._ws_utf8;
    app.project._ws_utf8 = app.project._rewrite_color_profile(
      "PwCs",
      '{"baseColorProfile":{"colorProfileName":"X"}}',
    );
    app.project._cpid.data = bytes_.repeat(b("\x01"), 16);
    app.project.working_space = "None";
    expect(app.project.working_space).toBe("None");
    expect(bytes_eq(app.project._cpid.data, cpid)).toBe(true);
    expect(bytes_eq(cpid, bytes_.repeat(b("\xff"), 16))).toBe(true);
    expect(app.project._ws_utf8 != null && String(app.project._ws_utf8.value) === "{}").toBe(true);
    expect(utf8 == null).toBe(true);
    const path = tmp_path.div("ws.aep");
    app.project.save(path);
    expect(parse(path).project.working_space).toBe("None");
  });
});

describe("TestSaveTempFile", () => {
  test("test_unrelated_tmp_file_survives", () => {
    const tmp_path = make_tmp_path();
    const keep = tmp_path.div("out.aep.tmp");
    keep.write_bytes(b("user data"));
    py_aep.new().project.save(tmp_path.div("out.aep"));
    expect(bytes_eq(keep.read_bytes(), b("user data"))).toBe(true);
    expect(parse(tmp_path.div("out.aep")).version).toBe("26.0x67");
    expect(py_eq(sorted(tmp_path.iterdir().map((p) => p.name)), ["out.aep", "out.aep.tmp"])).toBe(true);
  });
});
