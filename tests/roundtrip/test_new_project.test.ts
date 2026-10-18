/** Tests for newProject() - creating an empty project from scratch. */

import { describe, expect, test } from "bun:test";
import {
  AssertionError,
  Bytes,
  bytesEqual,
  getOrThrow,
  isdigit,
  len,
  Path,
  truthy,
  valueEquals,
  truthyOr,
  getMember,
  StopIteration,
  ValueError,
} from "../../src/pyrt/index.ts";

import * as py_aep from "../../src/py_aep/index.ts";
import { findByType, recursiveFind } from "../../src/py_aep/binary/utils.ts";
import { BitsPerChannel, GpuAccelType } from "../../src/py_aep/enums/index.ts";
import { toDict } from "../../src/py_aep/cli/validate.ts";
import "../../src/py_aep/binary/_register.ts";
import { asInstance, projectBytes } from "../helpers.ts";
import { RenderQueue } from "../../src/py_aep/models/renderqueue/render_queue.ts";
import { makeTmpPath, raises, skip } from "../support/pytest.ts";
import { sorted, split } from "../support/python.ts";

const EMPTIER = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "project", "emptier.aep");
const VERSIONS = new Path(import.meta.path).parent.parent.parent.div("samples", "versions");

describe("TestNewEmpty", () => {
  test("test_structure", () => {
    const app = py_aep.newProject();
    const proj = app.project;
    expect(app.version).toBe("26.0x67");
    expect(app.buildNumber).toBe(67);
    expect(proj.numItems).toBe(1); // only the root folder
    expect(proj.rootFolder.name).toBe("root");
    expect(valueEquals([...proj.items.keys()], [0])).toBe(true);
    expect(proj._head.nextItemId).toBe(1);
    expect(proj.revision).toBe(1);
  });

  test("test_settings_defaults", () => {
    const proj = py_aep.newProject().project;
    expect(proj.bitsPerChannel).toBe(BitsPerChannel.EIGHT);
    expect(proj.audioSampleRate).toBe(48000.0);
    expect(proj.expressionEngine).toBe("javascript-1.0");
  });

  test("test_empty_render_queue", () => {
    const rq = py_aep.newProject().project.renderQueue;
    expect(rq != null).toBe(true);
    if (rq == null) throw new AssertionError("new project has no render queue");
    expect(len(rq.items)).toBe(0);
  });

  test("test_no_xmp_trailer", () => {
    // XMP is optional; new() omits it (AE regenerates it on open).
    expect(py_aep.newProject().project._xmp).toBe("");
  });

  test("test_xmp_packet_none", () => {
    // An empty/blank _xmp must read back as None, not raise ParseError.
    expect(py_aep.newProject().project.xmpPacket == null).toBe(true);
  });

  test("test_set_xmp_packet_none", () => {
    // Clearing the packet (assigning None) must not crash and must read
    // back as None: the getter and setter are symmetric on the empty case.
    const project = py_aep.newProject().project;
    project.xmpPacket = null;
    expect(project.xmpPacket == null).toBe(true);
  });

  test("test_to_dict_no_crash", () => {
    // aep-validate walks every attribute (incl. xmp_packet) via to_dict;
    // it must not crash on a new()-based project with no XMP packet.
    const result = toDict(py_aep.newProject().project);
    expect(getOrThrow(result, "xmpPacket") == null).toBe(true);
  });

  test.each([
    // AE's own File > New on Windows (emptier.aep): CUDA, AE 26
    // writes the UTF-8 code page.
    ["windows", GpuAccelType.CUDA, 12, 0x00, "fde9"],
    ["macos", GpuAccelType.METAL, 14, 0x08, "0100"],
  ])("test_platform_stamps[%#]", (platform, gpu, osCode, nnhdByte, codePage) => {
    const project = py_aep.newProject("26.0x67", { platform }).project;
    expect(project._platform).toBe(platform);
    expect(project.gpuAccelType).toBe(gpu);
    expect(project._head.aeVersionOs).toBe(osCode);
    expect(project._nnhd._savingPlatform).toBe(nnhdByte);
    expect(Bytes.toHex(Bytes.intToBytes(project._nnhd._systemCodePage, 2, "big"))).toBe(codePage);
  });

  test("test_windows_stamps_match_ae_new_project", () => {
    const ae = py_aep.parse(EMPTIER).project;
    const ours = py_aep.newProject(ae._head.version, { platform: "windows" }).project;
    expect(ours.gpuAccelType).toBe(ae.gpuAccelType);
    expect(ae.gpuAccelType).toBe(GpuAccelType.CUDA);
    expect(ours._head.aeVersionOs).toBe(ae._head.aeVersionOs);
    expect(ours._nnhd._savingPlatform).toBe(ae._nnhd._savingPlatform);
    expect(ours._nnhd._systemCodePage).toBe(ae._nnhd._systemCodePage);
  });

  test("test_pre_26_windows_code_page", () => {
    // Windows AE up to 25 writes code page 1252 (every AE 15-25 sample).
    const project = py_aep.newProject("25.6x101", { platform: "windows" }).project;
    expect(project._nnhd._systemCodePage).toBe(1252);
  });
});

describe("TestNewVersion", () => {
  test("test_version_stamped", () => {
    const app = py_aep.newProject("25.6x101");
    expect(app.version).toBe("25.6x101");
    expect(app.buildNumber).toBe(101);
  });

  test("test_svap_build_number", () => {
    // svap's last byte tracks the AE build number.
    const app = py_aep.newProject("25.6x101");
    const svap = findByType(app.project._rifx.chunks, "svap");
    expect(svap.buildNumber).toBe(101);
  });

  test("test_invalid_version_rejected", () => {
    raises(ValueError, () => py_aep.newProject("not-a-version"));
  });

  test.each([
    // version-gated chunks: ExEn (AE16+), mrid/pcms/PwCs (AE22+),
    // pdvc (AE23+). Boundaries from samples/versions + emptier_2018.
    ["26.0x67", new Set(["ExEn", "mrid", "pcms", "PwCs", "pdvc"]), new Set<string>()],
    ["23.0x1", new Set(["ExEn", "mrid", "pcms", "PwCs", "pdvc"]), new Set<string>()],
    ["22.0x1", new Set(["ExEn", "mrid", "pcms", "PwCs"]), new Set(["pdvc"])],
    ["16.0x1", new Set(["ExEn"]), new Set(["mrid", "pcms", "PwCs", "pdvc"])],
    ["15.1x69", new Set<string>(), new Set(["ExEn", "mrid", "pcms", "PwCs", "pdvc"])],
  ])("test_version_gated_chunks[%#]", (version: string, present: Set<string>, absent: Set<string>) => {
    const chunks = py_aep.newProject(version).project._rifx.chunks;
    const types = new Set(chunks.map((c) => truthyOr(getMember(c, "listType", ""), c.chunkType)));
    expect([...present].every((t) => types.has(t))).toBe(true);
    expect([...absent].some((t) => types.has(t))).toBe(false);
  });

  test("test_gated_down_reparses", () => {
    const tmpPath = makeTmpPath();
    // A gated-down skeleton (no ExEn/CMS) must still round-trip.
    const path = tmpPath.div("old.aep");
    py_aep.newProject("15.1x69").project.save(path);
    const proj = py_aep.parse(path).project;
    expect(proj.numItems).toBe(1);
    expect(proj.expressionEngine).toBe("extendscript"); // ExEn absent -> default
  });

  test.each([
    ["26.0x67", [97, 2]],
    ["25.0x1", [96, 9]],
    ["24.0x1", [95, 6]],
    ["23.0x1", [94, 9]],
    ["22.0x1", [93, 43]],
    ["18.0x1", [93, 29]],
    ["17.0x1", [93, 22]],
    ["16.0x1", [93, 5]],
    ["15.1x69", [92, 14]],
  ])("test_format_version_per_release[%#]", (version: string, stamp: number[]) => {
    // AE gates opening on the format version and reads a file with the
    // rules of its (format, minor) pair, so new(version) stamps the pair
    // After Effects writes for that release.
    const head = py_aep.newProject(version).project._head;
    expect(valueEquals([head.fileFormatVersion, head._formatSubversion], stamp)).toBe(true);
  });

  test.each(["ae2018", "ae2023", "ae2024", "ae2025", "ae2026"])(
    "test_format_version_matches_after_effects_samples[%#]",
    (year: string) => {
      const sample = py_aep.parse(VERSIONS.div(year, "complete.aep"));
      const head = py_aep.newProject(sample.version).project._head;
      const saved = sample.project._head;
      expect(
        valueEquals(
          [head.fileFormatVersion, head._formatSubversion],
          [saved.fileFormatVersion, saved._formatSubversion],
        ),
      ).toBe(true);
    },
  );

  test.each([
    ["17.0x1", true],
    ["16.0x1", false],
  ])("test_mrid_from_ae_17[%#]", (version: string, hasMrid: boolean) => {
    const chunks = py_aep.newProject(version).project._rifx.chunks;
    expect(chunks.some((c) => c.chunkType === "mrid")).toBe(hasMrid);
  });

  test.each([
    ["new 22", 160],
    ["ae2022 sample", 160],
    ["new 23", 164],
  ])("test_new_comp_layer_records_fit_the_release[%#]", (source: string, ldtaSize: number) => {
    const tmpPath = makeTmpPath();
    // AE 22 writes 160-byte layer records (samples/versions/ae2022); the
    // matte-layer field that makes them 164 arrived with AE 23. AE refuses
    // a 22-format file holding the longer record ("chunk in file too big").
    const app =
      source === "ae2022 sample"
        ? py_aep.parse(VERSIONS.div("ae2022", "complete.aep"))
        : py_aep.newProject(split(source, null)[1] + ".0x1");
    const comp = app.project.rootFolder.addComp("Depth", 320, 240, 1.0, 2.0, 25.0);
    comp.addSolid([1.0, 0.0, 0.0], "Red", 320, 240);
    const path = tmpPath.div("comp.aep");
    app.project.save(path);
    const reread = py_aep.parse(path).project;
    const newComp = reread.compositions.find((c) => c.name === "Depth");
    if (newComp == null) throw new StopIteration();
    const records = recursiveFind(newComp._itemList.chunks, "ldta");
    expect(valueEquals(new Set(records.map((record) => len(record.tobytes()))), new Set([ldtaSize]))).toBe(true);
  });

  test("test_layer_copied_across_comps_keeps_a_22_record", () => {
    const tmpPath = makeTmpPath();
    const app = py_aep.parse(VERSIONS.div("ae2022", "complete.aep"));
    const source = app.project.rootFolder.addComp("Source", 320, 240, 1.0, 2.0, 25.0);
    const target = app.project.rootFolder.addComp("Target", 320, 240, 1.0, 2.0, 25.0);
    source.addSolid([1.0, 0.0, 0.0], "Red", 320, 240).copyToComp(target);
    const path = tmpPath.div("copy.aep");
    app.project.save(path);
    const reread = py_aep.parse(path).project;
    const targetComp = reread.compositions.find((c) => c.name === "Target");
    if (targetComp == null) throw new StopIteration();
    const copied = targetComp.layers[0];
    expect(len(copied._ldta.tobytes())).toBe(160);
  });
});

describe("TestNewRoundTrip", () => {
  test("test_byte_stable", () => {
    const tmpPath = makeTmpPath();
    const app = py_aep.newProject();
    const original = projectBytes(app.project);
    const path = tmpPath.div("empty.aep");
    app.project.save(path);
    const reparsed = py_aep.parse(path);
    expect(bytesEqual(projectBytes(reparsed.project), original)).toBe(true);
  });

  test("test_reparse_empty", () => {
    const tmpPath = makeTmpPath();
    const path = tmpPath.div("empty.aep");
    py_aep.newProject().project.save(path);
    const proj = py_aep.parse(path).project;
    expect(proj.numItems).toBe(1);
    expect(proj.renderQueue != null).toBe(true);
  });
});

describe("TestNewMutations", () => {
  test("test_add_comp", () => {
    const tmpPath = makeTmpPath();
    const app = py_aep.newProject();
    app.project.rootFolder.addComp("Comp 1", 1920, 1080, 1.0, 10.0, 30.0);
    const path = tmpPath.div("comp.aep");
    app.project.save(path);
    const proj = py_aep.parse(path).project;
    expect(
      valueEquals(
        proj.compositions.map((c) => c.name),
        ["Comp 1"],
      ),
    ).toBe(true);
    const comp = proj.compositions[0];
    expect(valueEquals([comp.width, comp.height], [1920, 1080])).toBe(true);
  });

  test("test_add_folder", () => {
    const tmpPath = makeTmpPath();
    const app = py_aep.newProject();
    app.project.rootFolder.addFolder("Assets");
    const path = tmpPath.div("folder.aep");
    app.project.save(path);
    const proj = py_aep.parse(path).project;
    expect(proj.folders.map((f) => f.name).includes("Assets")).toBe(true);
  });

  test("test_import_placeholder", () => {
    const tmpPath = makeTmpPath();
    const app = py_aep.newProject();
    app.project.importPlaceholder("PH", 640, 480, 25.0, 5.0);
    const path = tmpPath.div("ph.aep");
    app.project.save(path);
    const proj = py_aep.parse(path).project;
    expect(
      valueEquals(
        proj.footages.map((f) => f.name),
        ["PH"],
      ),
    ).toBe(true);
  });

  test("test_ae_preferences_dir_threaded", () => {
    const tmpPath = makeTmpPath();
    const app = py_aep.newProject(undefined, { aePreferencesDir: tmpPath });
    expect(String(app.project._aePreferencesDir)).toBe(String(tmpPath));
  });
});

/** Newest installed AE preferences directory, or None (for CI). */
function _aePrefsDir(): Path | null {
  const base = Path.home().div("AppData", "Roaming", "Adobe", "After Effects");
  if (!base.isDir()) return null;
  // NOTE(port): sibling paths share a parent, so sorting by name matches Path ordering (only Windows case-folding differs; AE version dirs are digits).
  const dirs = sorted(
    base.iterdir().filter((d) => d.isDir() && isdigit(d.name.slice(0, 1))),
    (d) => d.name,
  );
  return truthy(dirs) ? dirs[dirs.length - 1] : null;
}

describe("TestNewRenderQueue", () => {
  test("test_render_queue_add", () => {
    const tmpPath = makeTmpPath();
    const prefs = _aePrefsDir();
    if (prefs == null) return skip("no AE preferences dir (render templates unavailable)");
    const app = py_aep.newProject(undefined, { aePreferencesDir: prefs });
    const comp = app.project.rootFolder.addComp("Comp 1", 1920, 1080, 1.0, 10.0, 30.0);
    asInstance(app.project.renderQueue, RenderQueue).add(comp);
    const path = tmpPath.div("rq.aep");
    app.project.save(path);
    const proj = py_aep.parse(path, { aePreferencesDir: prefs }).project;
    expect(len(asInstance(proj.renderQueue, RenderQueue).items)).toBe(1);
    expect(asInstance(proj.renderQueue, RenderQueue).items[0].comp.name).toBe("Comp 1");
  });
});
