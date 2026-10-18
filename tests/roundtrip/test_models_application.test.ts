/** Tests for Application model. */

import "../../src/py_aep/binary/_register.ts";
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { Path, py_eq, ValueError } from "../../src/pyrt/index.ts";
import { make_tmp_path, raises } from "../../src/pyrt/pytest.ts";
import { parse as parse_aep } from "../../src/py_aep/index.ts";

const SAMPLE = new Path(fileURLToPath(import.meta.url))
  .resolve()
  .parent.parent.parent.div("samples", "versions", "ae2025", "complete.aep");

describe("TestBuildName", () => {
  /** build_name is an alias for version. */

  test("test_build_name_equals_version", () => {
    const app = parse_aep(SAMPLE);
    expect(app.buildName).toBe(app.version);
  });

  test("test_set_build_name_updates_version", () => {
    const app = parse_aep(SAMPLE);
    app.buildName = "25.0x100";
    expect(app.version).toBe("25.0x100");
  });

  test("test_set_version_updates_build_name", () => {
    const app = parse_aep(SAMPLE);
    app.version = "24.3x50";
    expect(app.buildName).toBe("24.3x50");
  });
});

describe("TestVersionUpdatesFormatGate", () => {
  /** Setting version also updates the file-format open gate. */

  test("test_version_setter_syncs_format_version", () => {
    const app = parse_aep(SAMPLE); // AE 2025 -> format 96.9
    const head = app._head;
    expect(py_eq([head.file_format_version, head._format_subversion], [96, 9])).toBe(true);
    app.version = "24.0x1";
    expect(py_eq([head.file_format_version, head._format_subversion], [95, 6])).toBe(true);
    app.version = "26.0x67";
    expect(py_eq([head.file_format_version, head._format_subversion], [97, 2])).toBe(true);
  });

  test("test_build_name_setter_syncs_format_version", () => {
    const app = parse_aep(SAMPLE);
    app.buildName = "23.0x1";
    const head = app._head;
    expect(py_eq([head.file_format_version, head._format_subversion], [94, 9])).toBe(true);
  });

  test.each(["27.0x1", "255.15x255"])("test_unknown_release_keeps_the_format_stamp[%#]", (version) => {
    const tmp_path = make_tmp_path();
    // No After Effects release to take a stamp from: only the version
    // changes. AE 2026 opens such a relabel; it misreads a stamp derived
    // from the major instead.
    const app = parse_aep(SAMPLE);
    app.version = version;
    const out = tmp_path.div("relabelled.aep");
    app.project.save(out);
    const head = parse_aep(out)._head;
    expect(head.version).toBe(version);
    expect(py_eq([head.file_format_version, head._format_subversion], [96, 9])).toBe(true);
  });

  test("test_relabel_across_the_layer_record_change_rejected", () => {
    // AE 2026 refuses an AE 2026 project relabelled 22 ("chunk in file
    // too big"): AE 23 lengthened the layer record.
    const app = parse_aep(SAMPLE);
    raises(ValueError, () => {
      app.version = "22.0x1";
    });
    expect(app.version).toBe("25.6x101");
  });
});

describe("TestRoundtripBuildName", () => {
  /** Roundtrip tests for build_name (alias for version). */

  test("test_roundtrip_build_name", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLE);
    const original = app.buildName;

    app.buildName = "24.1x42";
    expect(app.buildName).toBe("24.1x42");

    const out = tmp_path.div("modified.aep");
    app.project.save(out);
    const app2 = parse_aep(out);

    expect(app2.buildName).toBe("24.1x42");
    expect(app2.version).toBe("24.1x42");
    expect(app2.buildName).not.toBe(original);
  });
});
