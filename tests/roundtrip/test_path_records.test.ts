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
  pyEq,
  type JsonValue,
} from "../../src/pyrt/index.ts";
import { makeTmpPath, skip } from "../../src/pyrt/pytest.ts";
import { FileSource, FootageItem, ImportOptions, parse as parseAep, type Project } from "../../src/py_aep/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { PENDING_ASCENDCOUNT, parseAlasData } from "../../src/py_aep/binary/utils.ts";
import { platformPath } from "../../src/py_aep/resolvers/platform_paths.ts";
import { getRqi, parseProjectFresh } from "../helpers.ts";

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
  const data = parseAlasData(source._pin.chunks);
  return [getitem(data, "ascendcount_base"), getitem(data, "ascendcount_target")];
}

/** File sources by kind: `"file"` or `"sequence"`. */
function _sources(project: Project): Map<string, FileSource> {
  const out = new Map<string, FileSource>();
  for (const item of project.footages) {
    if (item instanceof FootageItem && item.mainSource instanceof FileSource) {
      const kind = item.mainSource._targetIsFolder ? "sequence" : "file";
      out.set(kind, item.mainSource);
    }
  }
  return out;
}

function _projectWithMedia(tmpPath: Path, platform: string | null = null): Project {
  const media = tmpPath.div("media");
  media.div("seq").mkdir({ parents: true });
  copy2(ASSETS.div("image_with_alpha.png"), media.div("img.png"));
  for (const n of [1, 2]) {
    copy2(ASSETS.div("image_with_alpha.png"), media.div("seq", `s_${String(n).padStart(4, "0")}.png`));
  }
  const project = parseAep(BASE, { platform }).project;
  project.importFile(new ImportOptions(media.div("img.png")));
  const opts = new ImportOptions(media.div("seq", "s_0001.png"));
  opts.sequence = true;
  project.importFile(opts);
  return project;
}

describe("TestSaveFillsCounts", () => {
  test("test_counts_for_the_saved_location", () => {
    const tmpPath = makeTmpPath();
    const project = _projectWithMedia(tmpPath);
    const out = tmpPath.div("proj", "shots", "p.aep");
    project.save(out);
    const sources = _sources(parseProjectFresh(out));
    // proj/shots/p.aep vs media/img.png and media/seq/<frame>.
    expect(pyEq(_counts(getitem(sources, "file")), [3, 2])).toBe(true);
    expect(pyEq(_counts(getitem(sources, "sequence")), [3, 3])).toBe(true);
  });

  test("test_each_save_recomputes", () => {
    const tmpPath = makeTmpPath();
    const project = _projectWithMedia(tmpPath);
    project.save(tmpPath.div("a.aep"));
    project.save(tmpPath.div("deep", "b.aep"));
    expect(
      pyEq(_counts(getitem(_sources(parseProjectFresh(tmpPath.div("a.aep"))), "file")), [1, 2]),
    ).toBe(true);
    expect(
      pyEq(_counts(getitem(_sources(parseProjectFresh(tmpPath.div("deep", "b.aep"))), "file")), [2, 2]),
    ).toBe(true);
    // The in-memory records stay pending for the next save.
    for (const source of _sources(project).values()) {
      expect(pyEq(_counts(source), [PENDING_ASCENDCOUNT, PENDING_ASCENDCOUNT])).toBe(true);
    }
  });

  test("test_parsed_records_keep_ae_counts", () => {
    const tmpPath = makeTmpPath();
    // Records parsed from a file keep AE's counts wherever py_aep saves it,
    // so parse then save stays byte-identical.
    const sample = SAMPLES.div("models", "essential_graphics", "media_replacement.aep");
    const before = new Map<string, [JsonValue, JsonValue]>();
    for (const [k, s] of _sources(parseAep(sample).project).entries()) before.set(k, _counts(s));
    const out = tmpPath.div("x.aep");
    parseAep(sample).project.save(out);
    const after = new Map<string, [JsonValue, JsonValue]>();
    for (const [k, s] of _sources(parseProjectFresh(out)).entries()) after.set(k, _counts(s));
    expect(pyEq(after, before)).toBe(true);
    expect(pyEq(out.readBytes(), sample.readBytes())).toBe(true);
  });

  test("test_render_output_path", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SAMPLES.div("models", "renderqueue", "render_settings.aep")).project;
    const om = getRqi(project, "base").outputModules[0];
    om.fileTemplate = fspath(tmpPath.div("renders")) + nodepath.sep + "out.[fileExtension]";
    const out = tmpPath.div("proj", "p.aep");
    project.save(out);
    const data = getRqi(parseAep(out).project, "base").outputModules[0]._alasData;
    // proj/p.aep vs a file inside renders/.
    expect(
      pyEq([getitem(data, "ascendcount_base"), getitem(data, "ascendcount_target")], [2, 2]),
    ).toBe(true);
  });
});

/** A project for the other platform stores its paths in that style. */
describe("TestPathStyleFollowsPlatform", () => {
  test("test_footage_paths", () => {
    const tmpPath = makeTmpPath();
    const project = _projectWithMedia(tmpPath, OTHER);
    const windows = OTHER === "windows";
    const sources = _sources(project);
    for (const [kind, host] of [
      ["file", tmpPath.div("media", "img.png")],
      ["sequence", tmpPath.div("media", "seq")],
    ] as const) {
      const data = parseAlasData(getitem(sources, kind)._pin.chunks);
      expect(getitem(data, "fullpath")).toBe(platformPath(fspath(host), { windows }));
      expect(getitem(data, "platform")).toBe(windows ? 1 : 2);
    }
  });

  test("test_counts_match_the_host_layout", () => {
    const tmpPath = makeTmpPath();
    // The save path is mapped like the footage, so the counts are the
    // ones a save on this machine gets.
    const project = _projectWithMedia(tmpPath, OTHER);
    const out = tmpPath.div("proj", "shots", "p.aep");
    project.save(out);
    const sources = _sources(parseProjectFresh(out));
    expect(pyEq(_counts(getitem(sources, "file")), [3, 2])).toBe(true);
    expect(pyEq(_counts(getitem(sources, "sequence")), [3, 3])).toBe(true);
  });

  test("test_reload_reads_the_host_file", () => {
    const tmpPath = makeTmpPath();
    if (process.platform === "win32" && !fspath(tmpPath).toUpperCase().startsWith("C:")) {
      return skip("only the system drive maps back to a macOS path");
    }
    const source = getitem(_sources(_projectWithMedia(tmpPath, OTHER)), "file");
    source.reload();
    expect(source._sspc.width).toBe(640);
  });
});
