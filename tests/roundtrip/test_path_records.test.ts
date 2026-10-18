/**
 * The `alas` path records py_aep writes: path style and relative counts.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as nodepath from "node:path";
import {
  fspath,
  getitem,
  Path,
  py_eq,
  type JsonValue,
} from "../../src/pyrt/index.ts";
import { make_tmp_path, skip } from "../../src/pyrt/pytest.ts";
import { FileSource, FootageItem, ImportOptions, parse as parse_aep, type Project } from "../../src/py_aep/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { PENDING_ASCENDCOUNT, parse_alas_data } from "../../src/py_aep/binary/utils.ts";
import { platform_path } from "../../src/py_aep/resolvers/platform_paths.ts";
import { get_rqi, parse_project_fresh } from "../helpers.ts";

const SAMPLES = new Path(import.meta.path).parent.parent.parent.div("samples");
const ASSETS = SAMPLES.div("assets");
const BASE = SAMPLES.div("models", "folder", "folder.aep");
/** The platform this machine is not. */
const OTHER = process.platform === "win32" ? "macos" : "windows";

// shutil.copy2: bytes plus atime/mtime.
function copy2(src: Path, dst: Path): void {
  fs.copyFileSync(fspath(src), fspath(dst));
  const st = fs.statSync(fspath(src));
  fs.utimesSync(fspath(dst), st.atime, st.mtime);
}

function _counts(source: FileSource): [JsonValue, JsonValue] {
  const data = parse_alas_data(source._pin.chunks);
  return [getitem(data, "ascendcount_base"), getitem(data, "ascendcount_target")];
}

/** File sources by kind: `"file"` or `"sequence"`. */
function _sources(project: Project): Map<string, FileSource> {
  const out = new Map<string, FileSource>();
  for (const item of project.footages) {
    if (item instanceof FootageItem && item.mainSource instanceof FileSource) {
      const kind = item.mainSource._target_is_folder ? "sequence" : "file";
      out.set(kind, item.mainSource);
    }
  }
  return out;
}

function _project_with_media(tmp_path: Path, platform: string | null = null): Project {
  const media = tmp_path.div("media");
  media.div("seq").mkdir({ parents: true });
  copy2(ASSETS.div("image_with_alpha.png"), media.div("img.png"));
  for (const n of [1, 2]) {
    copy2(ASSETS.div("image_with_alpha.png"), media.div("seq", `s_${String(n).padStart(4, "0")}.png`));
  }
  const project = parse_aep(BASE, { platform }).project;
  project.importFile(new ImportOptions(media.div("img.png")));
  const opts = new ImportOptions(media.div("seq", "s_0001.png"));
  opts.sequence = true;
  project.importFile(opts);
  return project;
}

describe("TestSaveFillsCounts", () => {
  test("test_counts_for_the_saved_location", () => {
    const tmp_path = make_tmp_path();
    const project = _project_with_media(tmp_path);
    const out = tmp_path.div("proj", "shots", "p.aep");
    project.save(out);
    const sources = _sources(parse_project_fresh(out));
    // proj/shots/p.aep vs media/img.png and media/seq/<frame>.
    expect(py_eq(_counts(getitem(sources, "file")), [3, 2])).toBe(true);
    expect(py_eq(_counts(getitem(sources, "sequence")), [3, 3])).toBe(true);
  });

  test("test_each_save_recomputes", () => {
    const tmp_path = make_tmp_path();
    const project = _project_with_media(tmp_path);
    project.save(tmp_path.div("a.aep"));
    project.save(tmp_path.div("deep", "b.aep"));
    expect(
      py_eq(_counts(getitem(_sources(parse_project_fresh(tmp_path.div("a.aep"))), "file")), [1, 2]),
    ).toBe(true);
    expect(
      py_eq(_counts(getitem(_sources(parse_project_fresh(tmp_path.div("deep", "b.aep"))), "file")), [2, 2]),
    ).toBe(true);
    // The in-memory records stay pending for the next save.
    for (const source of _sources(project).values()) {
      expect(py_eq(_counts(source), [PENDING_ASCENDCOUNT, PENDING_ASCENDCOUNT])).toBe(true);
    }
  });

  test("test_parsed_records_keep_ae_counts", () => {
    const tmp_path = make_tmp_path();
    // Records parsed from a file keep AE's counts wherever py_aep saves it,
    // so parse then save stays byte-identical.
    const sample = SAMPLES.div("models", "essential_graphics", "media_replacement.aep");
    const before = new Map<string, [JsonValue, JsonValue]>();
    for (const [k, s] of _sources(parse_aep(sample).project).entries()) before.set(k, _counts(s));
    const out = tmp_path.div("x.aep");
    parse_aep(sample).project.save(out);
    const after = new Map<string, [JsonValue, JsonValue]>();
    for (const [k, s] of _sources(parse_project_fresh(out)).entries()) after.set(k, _counts(s));
    expect(py_eq(after, before)).toBe(true);
    expect(py_eq(out.read_bytes(), sample.read_bytes())).toBe(true);
  });

  test("test_render_output_path", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES.div("models", "renderqueue", "render_settings.aep")).project;
    const om = get_rqi(project, "base").outputModules[0];
    om.fileTemplate = fspath(tmp_path.div("renders")) + nodepath.sep + "out.[fileExtension]";
    const out = tmp_path.div("proj", "p.aep");
    project.save(out);
    const data = get_rqi(parse_aep(out).project, "base").outputModules[0]._alas_data;
    // proj/p.aep vs a file inside renders/.
    expect(
      py_eq([getitem(data, "ascendcount_base"), getitem(data, "ascendcount_target")], [2, 2]),
    ).toBe(true);
  });
});

/** A project for the other platform stores its paths in that style. */
describe("TestPathStyleFollowsPlatform", () => {
  test("test_footage_paths", () => {
    const tmp_path = make_tmp_path();
    const project = _project_with_media(tmp_path, OTHER);
    const windows = OTHER === "windows";
    const sources = _sources(project);
    for (const [kind, host] of [
      ["file", tmp_path.div("media", "img.png")],
      ["sequence", tmp_path.div("media", "seq")],
    ] as const) {
      const data = parse_alas_data(getitem(sources, kind)._pin.chunks);
      expect(getitem(data, "fullpath")).toBe(platform_path(fspath(host), { windows }));
      expect(getitem(data, "platform")).toBe(windows ? 1 : 2);
    }
  });

  test("test_counts_match_the_host_layout", () => {
    const tmp_path = make_tmp_path();
    // The save path is mapped like the footage, so the counts are the
    // ones a save on this machine gets.
    const project = _project_with_media(tmp_path, OTHER);
    const out = tmp_path.div("proj", "shots", "p.aep");
    project.save(out);
    const sources = _sources(parse_project_fresh(out));
    expect(py_eq(_counts(getitem(sources, "file")), [3, 2])).toBe(true);
    expect(py_eq(_counts(getitem(sources, "sequence")), [3, 3])).toBe(true);
  });

  test("test_reload_reads_the_host_file", () => {
    const tmp_path = make_tmp_path();
    if (process.platform === "win32" && !fspath(tmp_path).toUpperCase().startsWith("C:")) {
      return skip("only the system drive maps back to a macOS path");
    }
    const source = getitem(_sources(_project_with_media(tmp_path, OTHER)), "file");
    source.reload();
    expect(source._sspc.width).toBe(640);
  });
});
