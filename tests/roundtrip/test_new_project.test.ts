/** Tests for py_aep.new() - creating an empty project from scratch. */

import { describe, expect, test } from "bun:test";
import {
  AssertionError_,
  bytes_,
  bytes_eq,
  getitem,
  isdigit,
  len,
  Path,
  py_bool,
  py_eq,
  py_or,
  getattr,
  sorted,
  split,
  StopIteration,
  ValueError,
} from "../../src/pyrt/index.ts";
import { make_tmp_path, raises, skip } from "../../src/pyrt/pytest.ts";
import * as py_aep from "../../src/py_aep/index.ts";
import { find_by_type, recursive_find } from "../../src/py_aep/binary/utils.ts";
import { BitsPerChannel, GpuAccelType } from "../../src/py_aep/enums/index.ts";
import { to_dict } from "../../src/py_aep/cli/validate.ts";
import "../../src/py_aep/binary/_register.ts";
import { as_instance, project_bytes } from "../helpers.ts";
import { RenderQueue } from "../../src/py_aep/models/renderqueue/render_queue.ts";

const EMPTIER = new Path(import.meta.path).parent.parent.parent.div(
  "samples",
  "models",
  "project",
  "emptier.aep",
);
const VERSIONS = new Path(import.meta.path).parent.parent.parent.div("samples", "versions");

describe("TestNewEmpty", () => {
  test("test_structure", () => {
    const app = py_aep.new();
    const proj = app.project;
    expect(app.version).toBe("26.0x67");
    expect(app.buildNumber).toBe(67);
    expect(proj.numItems).toBe(1); // only the root folder
    expect(proj.rootFolder.name).toBe("root");
    expect(py_eq([...proj.items.keys()], [0])).toBe(true);
    expect(proj._head.next_item_id).toBe(1);
    expect(proj.revision).toBe(1);
  });

  test("test_settings_defaults", () => {
    const proj = py_aep.new().project;
    expect(proj.bitsPerChannel).toBe(BitsPerChannel.EIGHT);
    expect(proj.audioSampleRate).toBe(48000.0);
    expect(proj.expressionEngine).toBe("javascript-1.0");
  });

  test("test_empty_render_queue", () => {
    const rq = py_aep.new().project.renderQueue;
    expect(rq != null).toBe(true);
    if (rq == null) throw new AssertionError_("new project has no render queue");
    expect(len(rq.items)).toBe(0);
  });

  test("test_no_xmp_trailer", () => {
    // XMP is optional; new() omits it (AE regenerates it on open).
    expect(py_aep.new().project._xmp).toBe("");
  });

  test("test_xmp_packet_none", () => {
    // An empty/blank _xmp must read back as None, not raise ParseError.
    expect(py_aep.new().project.xmpPacket == null).toBe(true);
  });

  test("test_set_xmp_packet_none", () => {
    // Clearing the packet (assigning None) must not crash and must read
    // back as None: the getter and setter are symmetric on the empty case.
    const project = py_aep.new().project;
    project.xmpPacket = null;
    expect(project.xmpPacket == null).toBe(true);
  });

  test("test_to_dict_no_crash", () => {
    // aep-validate walks every attribute (incl. xmp_packet) via to_dict;
    // it must not crash on a new()-based project with no XMP packet.
    const result = to_dict(py_aep.new().project);
    expect(getitem(result, "xmpPacket") == null).toBe(true);
  });

  test.each([
    // AE's own File > New on Windows (emptier.aep): CUDA, AE 26
    // writes the UTF-8 code page.
    ["windows", GpuAccelType.CUDA, 12, 0x00, "fde9"],
    ["macos", GpuAccelType.METAL, 14, 0x08, "0100"],
  ])(
    "test_platform_stamps[%#]",
    (platform, gpu, os_code, nnhd_byte, code_page) => {
      const project = py_aep.new("26.0x67", { platform }).project;
      expect(project._platform).toBe(platform);
      expect(project.gpuAccelType).toBe(gpu);
      expect(project._head.ae_version_os).toBe(os_code);
      expect(project._nnhd._saving_platform).toBe(nnhd_byte);
      expect(bytes_.hex(bytes_.int_to_bytes(project._nnhd._system_code_page, 2, "big"))).toBe(
        code_page,
      );
    },
  );

  test("test_windows_stamps_match_ae_new_project", () => {
    const ae = py_aep.parse(EMPTIER).project;
    const ours = py_aep.new(ae._head.version, { platform: "windows" }).project;
    expect(ours.gpuAccelType).toBe(ae.gpuAccelType);
    expect(ae.gpuAccelType).toBe(GpuAccelType.CUDA);
    expect(ours._head.ae_version_os).toBe(ae._head.ae_version_os);
    expect(ours._nnhd._saving_platform).toBe(ae._nnhd._saving_platform);
    expect(ours._nnhd._system_code_page).toBe(ae._nnhd._system_code_page);
  });

  test("test_pre_26_windows_code_page", () => {
    // Windows AE up to 25 writes code page 1252 (every AE 15-25 sample).
    const project = py_aep.new("25.6x101", { platform: "windows" }).project;
    expect(project._nnhd._system_code_page).toBe(1252);
  });
});

describe("TestNewVersion", () => {
  test("test_version_stamped", () => {
    const app = py_aep.new("25.6x101");
    expect(app.version).toBe("25.6x101");
    expect(app.buildNumber).toBe(101);
  });

  test("test_svap_build_number", () => {
    // svap's last byte tracks the AE build number.
    const app = py_aep.new("25.6x101");
    const svap = find_by_type(app.project._rifx.chunks, "svap");
    expect(svap.build_number).toBe(101);
  });

  test("test_invalid_version_rejected", () => {
    raises(ValueError, () => py_aep.new("not-a-version"));
  });

  test.each([
    // version-gated chunks: ExEn (AE16+), mrid/pcms/PwCs (AE22+),
    // pdvc (AE23+). Boundaries from samples/versions + emptier_2018.
    ["26.0x67", new Set(["ExEn", "mrid", "pcms", "PwCs", "pdvc"]), new Set<string>()],
    ["23.0x1", new Set(["ExEn", "mrid", "pcms", "PwCs", "pdvc"]), new Set<string>()],
    ["22.0x1", new Set(["ExEn", "mrid", "pcms", "PwCs"]), new Set(["pdvc"])],
    ["16.0x1", new Set(["ExEn"]), new Set(["mrid", "pcms", "PwCs", "pdvc"])],
    ["15.1x69", new Set<string>(), new Set(["ExEn", "mrid", "pcms", "PwCs", "pdvc"])],
  ])(
    "test_version_gated_chunks[%#]",
    (version: string, present: Set<string>, absent: Set<string>) => {
      const chunks = py_aep.new(version).project._rifx.chunks;
      const types = new Set(
        chunks.map((c) => py_or(getattr(c, "list_type", ""), c.chunk_type)),
      );
      expect([...present].every((t) => types.has(t))).toBe(true);
      expect([...absent].some((t) => types.has(t))).toBe(false);
    },
  );

  test("test_gated_down_reparses", () => {
    const tmp_path = make_tmp_path();
    // A gated-down skeleton (no ExEn/CMS) must still round-trip.
    const path = tmp_path.div("old.aep");
    py_aep.new("15.1x69").project.save(path);
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
    const head = py_aep.new(version).project._head;
    expect(py_eq([head.file_format_version, head._format_subversion], stamp)).toBe(true);
  });

  test.each(["ae2018", "ae2023", "ae2024", "ae2025", "ae2026"])(
    "test_format_version_matches_after_effects_samples[%#]",
    (year: string) => {
      const sample = py_aep.parse(VERSIONS.div(year, "complete.aep"));
      const head = py_aep.new(sample.version).project._head;
      const saved = sample.project._head;
      expect(
        py_eq(
          [head.file_format_version, head._format_subversion],
          [saved.file_format_version, saved._format_subversion],
        ),
      ).toBe(true);
    },
  );

  test.each([
    ["17.0x1", true],
    ["16.0x1", false],
  ])("test_mrid_from_ae_17[%#]", (version: string, has_mrid: boolean) => {
    const chunks = py_aep.new(version).project._rifx.chunks;
    expect(chunks.some((c) => c.chunk_type === "mrid")).toBe(has_mrid);
  });

  test.each([
    ["new 22", 160],
    ["ae2022 sample", 160],
    ["new 23", 164],
  ])("test_new_comp_layer_records_fit_the_release[%#]", (source: string, ldta_size: number) => {
    const tmp_path = make_tmp_path();
    // AE 22 writes 160-byte layer records (samples/versions/ae2022); the
    // matte-layer field that makes them 164 arrived with AE 23. AE refuses
    // a 22-format file holding the longer record ("chunk in file too big").
    const app =
      source === "ae2022 sample"
        ? py_aep.parse(VERSIONS.div("ae2022", "complete.aep"))
        : py_aep.new(split(source, null)[1] + ".0x1");
    const comp = app.project.rootFolder.addComp("Depth", 320, 240, 1.0, 2.0, 25.0);
    comp.addSolid([1.0, 0.0, 0.0], "Red", 320, 240);
    const path = tmp_path.div("comp.aep");
    app.project.save(path);
    const reread = py_aep.parse(path).project;
    const new_comp = reread.compositions.find((c) => c.name === "Depth");
    if (new_comp == null) throw new StopIteration();
    const records = recursive_find(new_comp._item_list.chunks, "ldta");
    expect(
      py_eq(new Set(records.map((record) => len(record.tobytes()))), new Set([ldta_size])),
    ).toBe(true);
  });

  test("test_layer_copied_across_comps_keeps_a_22_record", () => {
    const tmp_path = make_tmp_path();
    const app = py_aep.parse(VERSIONS.div("ae2022", "complete.aep"));
    const source = app.project.rootFolder.addComp("Source", 320, 240, 1.0, 2.0, 25.0);
    const target = app.project.rootFolder.addComp("Target", 320, 240, 1.0, 2.0, 25.0);
    source.addSolid([1.0, 0.0, 0.0], "Red", 320, 240).copyToComp(target);
    const path = tmp_path.div("copy.aep");
    app.project.save(path);
    const reread = py_aep.parse(path).project;
    const target_comp = reread.compositions.find((c) => c.name === "Target");
    if (target_comp == null) throw new StopIteration();
    const copied = target_comp.layers[0];
    expect(len(copied._ldta.tobytes())).toBe(160);
  });
});

describe("TestNewRoundTrip", () => {
  test("test_byte_stable", () => {
    const tmp_path = make_tmp_path();
    const app = py_aep.new();
    const original = project_bytes(app.project);
    const path = tmp_path.div("empty.aep");
    app.project.save(path);
    const reparsed = py_aep.parse(path);
    expect(bytes_eq(project_bytes(reparsed.project), original)).toBe(true);
  });

  test("test_reparse_empty", () => {
    const tmp_path = make_tmp_path();
    const path = tmp_path.div("empty.aep");
    py_aep.new().project.save(path);
    const proj = py_aep.parse(path).project;
    expect(proj.numItems).toBe(1);
    expect(proj.renderQueue != null).toBe(true);
  });
});

describe("TestNewMutations", () => {
  test("test_add_comp", () => {
    const tmp_path = make_tmp_path();
    const app = py_aep.new();
    app.project.rootFolder.addComp("Comp 1", 1920, 1080, 1.0, 10.0, 30.0);
    const path = tmp_path.div("comp.aep");
    app.project.save(path);
    const proj = py_aep.parse(path).project;
    expect(py_eq(proj.compositions.map((c) => c.name), ["Comp 1"])).toBe(true);
    const comp = proj.compositions[0];
    expect(py_eq([comp.width, comp.height], [1920, 1080])).toBe(true);
  });

  test("test_add_folder", () => {
    const tmp_path = make_tmp_path();
    const app = py_aep.new();
    app.project.rootFolder.addFolder("Assets");
    const path = tmp_path.div("folder.aep");
    app.project.save(path);
    const proj = py_aep.parse(path).project;
    expect(proj.folders.map((f) => f.name).includes("Assets")).toBe(true);
  });

  test("test_import_placeholder", () => {
    const tmp_path = make_tmp_path();
    const app = py_aep.new();
    app.project.importPlaceholder("PH", 640, 480, 25.0, 5.0);
    const path = tmp_path.div("ph.aep");
    app.project.save(path);
    const proj = py_aep.parse(path).project;
    expect(py_eq(proj.footages.map((f) => f.name), ["PH"])).toBe(true);
  });

  test("test_ae_preferences_dir_threaded", () => {
    const tmp_path = make_tmp_path();
    const app = py_aep.new(undefined, { ae_preferences_dir: tmp_path });
    expect(String(app.project._ae_preferences_dir)).toBe(String(tmp_path));
  });
});

/** Newest installed AE preferences directory, or None (for CI). */
function _ae_prefs_dir(): Path | null {
  const base = Path.home().div("AppData", "Roaming", "Adobe", "After Effects");
  if (!base.is_dir()) return null;
  // NOTE(port): sibling paths share a parent, so sorting by name matches Path ordering (only Windows case-folding differs; AE version dirs are digits).
  const dirs = sorted(
    base.iterdir().filter((d) => d.is_dir() && isdigit(d.name.slice(0, 1))),
    (d) => d.name,
  );
  return py_bool(dirs) ? dirs[dirs.length - 1] : null;
}

describe("TestNewRenderQueue", () => {
  test("test_render_queue_add", () => {
    const tmp_path = make_tmp_path();
    const prefs = _ae_prefs_dir();
    if (prefs == null) return skip("no AE preferences dir (render templates unavailable)");
    const app = py_aep.new(undefined, { ae_preferences_dir: prefs });
    const comp = app.project.rootFolder.addComp("Comp 1", 1920, 1080, 1.0, 10.0, 30.0);
    as_instance(app.project.renderQueue, RenderQueue).add(comp);
    const path = tmp_path.div("rq.aep");
    app.project.save(path);
    const proj = py_aep.parse(path, { ae_preferences_dir: prefs }).project;
    expect(len(as_instance(proj.renderQueue, RenderQueue).items)).toBe(1);
    expect(as_instance(proj.renderQueue, RenderQueue).items[0].comp.name).toBe("Comp 1");
  });
});
