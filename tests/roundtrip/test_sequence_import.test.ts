/**
 * Image-sequence import details, measured against AE 2026.
 *
 * Alphabetical sequences (`force_alphabetical`), frame-number padding and the
 * duration a sequence's conform rate rewrites. Every expected value is what
 * AE 2026 wrote for the same folder and call.
 */

import { describe, expect, test } from "bun:test";

import "../../src/py_aep/binary/_register.ts";
import * as py_aep from "../../src/py_aep/index.ts";
import { FileSource, FootageItem, ImportOptions, parse as parse_aep, type Project } from "../../src/py_aep/index.ts";
import { as_instance } from "../helpers.ts";
import { U4LeChunk } from "../../src/py_aep/binary/scalar_chunks.ts";
import { UNDEFINED_FRAME, find_by_list_type } from "../../src/py_aep/binary/utils.ts";
import { Path, ValueError, b, py_assert, py_eq } from "../../src/pyrt/index.ts";
import { make_tmp_path, raises } from "../../src/pyrt/pytest.ts";

const ASSETS = new Path(import.meta.dir, "..", "..", "samples", "assets");
const BASE = new Path(import.meta.dir, "..", "..", "samples", "models", "folder", "folder.aep");

/** A folder named `shots` holding a copy of one still per name. */
function _folder(tmp_path: Path, ...names: string[]): Path {
  const frame = ASSETS.div("image_with_alpha.png").read_bytes();
  const folder = tmp_path.div("shots");
  folder.mkdir();
  for (const name of names) {
    folder.div(name).write_bytes(frame);
  }
  return folder;
}

function _import(file: Path, kw: { alphabetical: boolean }): [Project, FootageItem] {
  const { alphabetical } = kw;
  const project = parse_aep(BASE).project;
  const opts = new ImportOptions(file);
  opts.sequence = true;
  opts.force_alphabetical = alphabetical;
  return [project, as_instance(project.import_file(opts), FootageItem)];
}

function _reparsed(project: Project, item: FootageItem, tmp_path: Path): FootageItem {
  const out = tmp_path.div("sequence.aep");
  project.save(out);
  const found = parse_aep(out).project.footages.find((f) => f.id === item.id);
  if (found === undefined) throw new Error("StopIteration");
  return found;
}

class TestAlphabeticalSequence {
  /**
   * `force_alphabetical` takes every file of the type in the folder.
   *
   * Every .png, case-insensitively by name (n_10 before n_2); x.jpg and the
   * subfolder's file are left out.
   */
  static ORDER = [
    "a_001.png",
    "a_002.png",
    "b.png",
    "c_010.png",
    "D.PNG",
    "n_10.png",
    "n_2.png",
  ];

  static _mixed(tmp_path: Path): Path {
    const folder = _folder(tmp_path, ...this.ORDER, "x.jpg");
    folder.div("sub").mkdir();
    folder.div("sub").div("z.png").write_bytes(folder.div("b.png").read_bytes());
    return folder;
  }
}

describe("TestAlphabeticalSequence", () => {
  test.each(["a_001.png", "b.png", "D.PNG"])("test_takes_every_file_of_the_type[%#]", (picked) => {
    const tmp_path = make_tmp_path();
    const [, item] = _import(TestAlphabeticalSequence._mixed(tmp_path).div(picked), { alphabetical: true });
    expect(py_eq(as_instance(item.main_source, FileSource).file_names, TestAlphabeticalSequence.ORDER)).toBe(true);
    // The first file in order, whichever one was picked.
    expect(new Path(as_instance(item.main_source, FileSource).file).name).toBe("a_001.png");
    expect(item.name).toBe("shots");
    expect(item.duration).toBe(7 / 30);
  });

  test("test_stored_like_ae", () => {
    const tmp_path = make_tmp_path();
    const [project, item] = _import(TestAlphabeticalSequence._mixed(tmp_path).div("a_001.png"), { alphabetical: true });
    const reparsed = _reparsed(project, item, tmp_path);
    const source = as_instance(reparsed.main_source, FileSource);
    const sspc = source._sspc;
    expect(
      py_eq([sspc.start_frame, sspc.end_frame, sspc.frame_padding], [UNDEFINED_FRAME, UNDEFINED_FRAME, 0]),
    ).toBe(true);
    expect(
      py_eq(
        [sspc._reserved_a8, sspc._reserved_b8, sspc._reserved_ba],
        [b("\x00\x00\x00\x01"), b("\x00"), b("\x00\x00")],
      ),
    ).toBe(true);
    expect(sspc._source_stamp[0]).toBe(1);
    expect(py_eq([sspc.duration_dividend, sspc.duration_divisor], [7, 30])).toBe(true);
    const stvc = find_by_list_type(source._pin.chunks, "StVc");
    const stvs = stvc.chunks[0];
    py_assert(stvs instanceof U4LeChunk);
    expect(stvs.chunk_type).toBe("StVS");
    expect(stvs.value).toBe(7);
    expect(py_eq(source.file_names, TestAlphabeticalSequence.ORDER)).toBe(true);
    expect(reparsed.name).toBe("shots");
  });

  test("test_numbered_import_keeps_the_prefix", () => {
    const tmp_path = make_tmp_path();
    const [, item] = _import(TestAlphabeticalSequence._mixed(tmp_path).div("a_001.png"), { alphabetical: false });
    expect(item.name).toBe("a_[001-002].png");
    expect(item.duration).toBe(2 / 30);
  });

  test("test_unnumbered_file_needs_alphabetical_order", () => {
    const tmp_path = make_tmp_path();
    raises(
      ValueError,
      () => _import(TestAlphabeticalSequence._mixed(tmp_path).div("b.png"), { alphabetical: false }),
      "numbered filename",
    );
  });

  test("test_replacing_a_placeholder_keeps_its_rate", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(BASE).project;
    const item = project.import_placeholder("PH", 640, 480, 24.0, 10.0);
    item.replace_with_sequence(TestAlphabeticalSequence._mixed(tmp_path).div("a_001.png"), true);
    expect(item.name).toBe("shots");
    const sspc = item.main_source._sspc;
    expect(py_eq([sspc.duration_dividend, sspc.duration_divisor], [7, 24])).toBe(true);
  });

  test("test_reload_relists_the_folder", () => {
    const tmp_path = make_tmp_path();
    const folder = TestAlphabeticalSequence._mixed(tmp_path);
    const [, item] = _import(folder.div("a_001.png"), { alphabetical: true });
    folder.div("zz.png").write_bytes(folder.div("b.png").read_bytes());
    as_instance(item.main_source, FileSource).reload();
    const source = as_instance(item.main_source, FileSource);
    expect(py_eq(source.file_names, [...TestAlphabeticalSequence.ORDER, "zz.png"])).toBe(true);
    expect(item.duration).toBe(8 / 30);
    const stvc = find_by_list_type(source._pin.chunks, "StVc");
    expect(as_instance(stvc.chunks[0], U4LeChunk).value).toBe(8);
  });
});

describe("TestSequencePadding", () => {
  /**
   * The padding is the first frame's digit count, and `sspc` byte 0xB8
   * marks zero-padded frame numbers.
   */

  test.each([
    [
      Array.from({ length: 12 }, (_, i) => `s${i + 1}.png`),
      "s12.png",
      "s[1-12].png",
      "s1.png",
      1,
      b("\x00"),
    ],
    [
      ["p410.png", "p411.png", "p412.png"],
      "p410.png",
      "p[410-412].png",
      "p410.png",
      3,
      b("\x00"),
    ],
    [
      ["z_0410.png", "z_0411.png", "z_0412.png"],
      "z_0411.png",
      "z_[0410-0412].png",
      "z_0410.png",
      4,
      b("\x01"),
    ],
  ])(
    "test_matches_ae[%#]",
    (
      names: string[],
      picked: string,
      name: string,
      first: string,
      padding: number,
      zero_padded: Uint8Array,
    ) => {
      const tmp_path = make_tmp_path();
      const [project, item] = _import(_folder(tmp_path, ...names).div(picked), { alphabetical: false });
      const reparsed = _reparsed(project, item, tmp_path);
      expect(reparsed.name).toBe(name);
      expect(new Path(as_instance(reparsed.main_source, FileSource).file).name).toBe(first);
      expect(reparsed.main_source._sspc.frame_padding).toBe(padding);
      expect(py_eq(reparsed.main_source._sspc._reserved_b8, zero_padded)).toBe(true);
    },
  );
});

describe("TestSequenceConformFrameRate", () => {
  test.each([
    [24.0, 3, 24],
    [29.97, 300, 2997],
  ])(
    "test_stores_unreduced_frames_over_the_rate[%#]",
    (rate: number, dividend: number, divisor: number) => {
      /** The frame count over the rate to the nearest thousandth. */
      const tmp_path = make_tmp_path();
      const folder = _folder(tmp_path, "shot_0001.png", "shot_0002.png", "shot_0003.png");
      const [, item] = _import(folder.div("shot_0001.png"), { alphabetical: false });
      item.main_source.conform_frame_rate = rate;
      const sspc = item.main_source._sspc;
      expect(py_eq([sspc.duration_dividend, sspc.duration_divisor], [dividend, divisor])).toBe(true);
      expect(sspc.conform_frame_rate).toBe(0.0);
    },
  );
});

/**
 * A first frame with a timeline of its own (`gif.gif`: 14 frames at
 * 10 fps) sets the sequence's rate and duration, and a replace keeps them
 * (AE 2026).
 */
class TestAnimatedGifSequence {
  static _gifs(tmp_path: Path, first = "gif.gif"): Path {
    const folder = tmp_path.div("gifs");
    folder.mkdir();
    folder.div("m_001.gif").write_bytes(ASSETS.div(first).read_bytes());
    folder.div("m_002.gif").write_bytes(ASSETS.div("gif.gif").read_bytes());
    return folder.div("m_001.gif");
  }
}

describe("TestAnimatedGifSequence", () => {
  test("test_takes_the_first_files_timeline", () => {
    const tmp_path = make_tmp_path();
    const [, item] = _import(TestAnimatedGifSequence._gifs(tmp_path), { alphabetical: false });
    expect(item.name).toBe("m_[001-002].gif");
    expect(item.frame_rate).toBe(10.0);
    expect(item.duration).toBe(1.4);
    const sspc = item.main_source._sspc;
    expect(py_eq([sspc.duration_dividend, sspc.duration_divisor], [14, 10])).toBe(true);
  });

  test.each(["placeholder", "sequence", "conformed movie"])("test_a_replace_keeps_its_rate[%#]", (old) => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(BASE).project;
    let item: FootageItem;
    if (old === "placeholder") {
      item = project.import_placeholder("PH", 640, 480, 24.0, 10.0);
    } else if (old === "sequence") {
      const opts = new ImportOptions(ASSETS.div("sequence_001.gif"));
      opts.sequence = true;
      item = as_instance(project.import_file(opts), FootageItem);
      item.main_source.conform_frame_rate = 25.0;
    } else {
      item = as_instance(project.import_file(new ImportOptions(ASSETS.div("mov_480.mov"))), FootageItem);
      item.main_source.conform_frame_rate = 25.0;
    }
    item.replace_with_sequence(TestAnimatedGifSequence._gifs(tmp_path), false);
    expect(item.frame_rate).toBe(10.0);
    expect(item.duration).toBe(1.4);
  });

  test("test_a_still_first_frame_uses_the_usual_rule", () => {
    const tmp_path = make_tmp_path();
    const [, item] = _import(TestAnimatedGifSequence._gifs(tmp_path, "sequence_001.gif"), {
      alphabetical: false,
    });
    expect(item.frame_rate).toBe(30.0);
    expect(item.duration).toBe(2 / 30);
  });
});

describe("TestCachedDataSize", () => {
  /**
   * `sspc` byte 0xD0: the file's size, or for a sequence the first frame's
   * size times the file count (AE 2026 on macOS and Windows).
   */

  test("test_file", () => {
    const project = parse_aep(BASE).project;
    const item = as_instance(project.import_file(new ImportOptions(ASSETS.div("image_with_alpha.png"))), FootageItem);
    // Node's fs.Stats exposes the byte count as `size` (Python `st_size`).
    const size = ASSETS.div("image_with_alpha.png").stat().size;
    expect(item.main_source._sspc.data_size).toBe(size);
  });

  test("test_sequence", () => {
    // sequence_001..003.gif are 4928, 5332 and 5223 bytes; AE's
    // `imio_sequence.aep` fixture stores 3 x 4928.
    const [, item] = _import(ASSETS.div("sequence_001.gif"), { alphabetical: false });
    expect(item.main_source._sspc.data_size).toBe(3 * 4928);
  });
});

describe("TestPlatform", () => {
  /**
   * `parse` / `new` take the After Effects platform the project is for; a
   * BMP/GIF sequence gets that platform's importer code (AE refuses the
   * other one).
   */

  test("test_defaults_to_the_host", () => {
    // Python `os.name == "nt"` is Windows.
    const host = process.platform === "win32" ? "windows" : "macos";
    expect(parse_aep(BASE).project._platform).toBe(host);
    expect(py_aep.new().project._platform).toBe(host);
  });

  test("test_rejects_an_unknown_platform", () => {
    raises(ValueError, () => parse_aep(BASE, { platform: "linux" }), "must be one of");
    raises(ValueError, () => py_aep.new(undefined, { platform: "linux" }), "must be one of");
  });

  test.each([
    ["windows", "STIL"],
    ["macos", "IMIO"],
  ])("test_gif_sequence_code[%#]", (platform: string, code: string) => {
    const project = parse_aep(BASE, { platform }).project;
    const opts = new ImportOptions(ASSETS.div("sequence_001.gif"));
    opts.sequence = true;
    const item = as_instance(project.import_file(opts), FootageItem);
    expect(item.main_source._sspc.source_format_type).toBe(code);
    // Every path that builds a sequence follows the project's platform.
    item.replace_with_sequence(ASSETS.div("sequence_001.gif"));
    expect(item.main_source._sspc.source_format_type).toBe(code);
    item.set_proxy_with_sequence(ASSETS.div("sequence_001.gif"));
    expect(item.proxy_source?._sspc.source_format_type).toBe(code);
  });

  test.each([
    ["windows", "STIL", false],
    ["macos", "IMIO", true],
  ])("test_still_paths[%#]", (platform: string, code: string, heic_alpha: boolean) => {
    // Stills take the platform's importer code too, and Windows AE
    // stores HEIC without alpha (windows_stills.aep), on every path.
    const project = parse_aep(BASE, { platform }).project;
    const item = as_instance(project.import_file(new ImportOptions(ASSETS.div("bmp.bmp"))), FootageItem);
    expect(item.main_source._sspc.source_format_type).toBe(code);
    item.set_proxy(ASSETS.div("gif.gif"));
    expect(item.proxy_source?._sspc.source_format_type).toBe(code);
    item.replace(ASSETS.div("gif.gif"));
    expect(item.main_source._sspc.source_format_type).toBe(code);
    item.replace(ASSETS.div("heic_alpha.heic"));
    expect(item.main_source.has_alpha).toBe(heic_alpha);
  });

  test("test_new_project", () => {
    const project = py_aep.new(undefined, { platform: "macos" }).project;
    const opts = new ImportOptions(ASSETS.div("sequence_001.gif"));
    opts.sequence = true;
    expect(as_instance(project.import_file(opts), FootageItem).main_source._sspc.source_format_type).toBe("IMIO");
  });
});
