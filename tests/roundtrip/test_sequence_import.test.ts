/**
 * Image-sequence import details, measured against AE 2026.
 *
 * Alphabetical sequences (`forceAlphabetical`), frame-number padding and the
 * duration a sequence's conform rate rewrites. Every expected value is what
 * AE 2026 wrote for the same folder and call.
 */

import { describe, expect, test } from "bun:test";

import "../../src/py_aep/binary/_register.ts";
import * as py_aep from "../../src/py_aep/index.ts";
import { FileSource, FootageItem, ImportOptions, parse as parseAep, type Project } from "../../src/py_aep/index.ts";
import { asInstance } from "../helpers.ts";
import { U4LeChunk } from "../../src/py_aep/binary/scalar_chunks.ts";
import { UNDEFINED_FRAME, findByListType } from "../../src/py_aep/binary/utils.ts";
import { Path, ValueError, b, assert, valueEquals } from "../../src/pyrt/index.ts";
import { makeTmpPath, raises } from "../support/pytest.ts";

const ASSETS = new Path(import.meta.dir, "..", "..", "samples", "assets");
const BASE = new Path(import.meta.dir, "..", "..", "samples", "models", "folder", "folder.aep");

/** A folder named `shots` holding a copy of one still per name. */
function _folder(tmpPath: Path, ...names: string[]): Path {
  const frame = ASSETS.div("image_with_alpha.png").readBytes();
  const folder = tmpPath.div("shots");
  folder.mkdir();
  for (const name of names) {
    folder.div(name).writeBytes(frame);
  }
  return folder;
}

function _import(file: Path, kw: { alphabetical: boolean }): [Project, FootageItem] {
  const { alphabetical } = kw;
  const project = parseAep(BASE).project;
  const opts = new ImportOptions(file);
  opts.sequence = true;
  opts.forceAlphabetical = alphabetical;
  return [project, asInstance(project.importFile(opts), FootageItem)];
}

function _reparsed(project: Project, item: FootageItem, tmpPath: Path): FootageItem {
  const out = tmpPath.div("sequence.aep");
  project.save(out);
  const found = parseAep(out).project.footages.find((f) => f.id === item.id);
  if (found === undefined) throw new Error("StopIteration");
  return found;
}

class TestAlphabeticalSequence {
  /**
   * `forceAlphabetical` takes every file of the type in the folder.
   *
   * Every .png, case-insensitively by name (n_10 before n_2); x.jpg and the
   * subfolder's file are left out.
   */
  static ORDER = ["a_001.png", "a_002.png", "b.png", "c_010.png", "D.PNG", "n_10.png", "n_2.png"];

  static _mixed(tmpPath: Path): Path {
    const folder = _folder(tmpPath, ...this.ORDER, "x.jpg");
    folder.div("sub").mkdir();
    folder.div("sub").div("z.png").writeBytes(folder.div("b.png").readBytes());
    return folder;
  }
}

describe("TestAlphabeticalSequence", () => {
  test.each(["a_001.png", "b.png", "D.PNG"])("test_takes_every_file_of_the_type[%#]", (picked) => {
    const tmpPath = makeTmpPath();
    const [, item] = _import(TestAlphabeticalSequence._mixed(tmpPath).div(picked), { alphabetical: true });
    expect(valueEquals(asInstance(item.mainSource, FileSource).fileNames, TestAlphabeticalSequence.ORDER)).toBe(true);
    // The first file in order, whichever one was picked.
    expect(new Path(asInstance(item.mainSource, FileSource).file).name).toBe("a_001.png");
    expect(item.name).toBe("shots");
    expect(item.duration).toBe(7 / 30);
  });

  test("test_stored_like_ae", () => {
    const tmpPath = makeTmpPath();
    const [project, item] = _import(TestAlphabeticalSequence._mixed(tmpPath).div("a_001.png"), { alphabetical: true });
    const reparsed = _reparsed(project, item, tmpPath);
    const source = asInstance(reparsed.mainSource, FileSource);
    const sspc = source._sspc;
    expect(
      valueEquals([sspc.startFrame, sspc.endFrame, sspc.framePadding], [UNDEFINED_FRAME, UNDEFINED_FRAME, 0]),
    ).toBe(true);
    expect(
      valueEquals(
        [sspc._reservedA8, sspc._reservedB8, sspc._reservedBa],
        [b("\x00\x00\x00\x01"), b("\x00"), b("\x00\x00")],
      ),
    ).toBe(true);
    expect(sspc._sourceStamp[0]).toBe(1);
    expect(valueEquals([sspc.durationDividend, sspc.durationDivisor], [7, 30])).toBe(true);
    const stvc = findByListType(source._pin.chunks, "StVc");
    const stvs = stvc.chunks[0];
    assert(stvs instanceof U4LeChunk);
    expect(stvs.chunkType).toBe("StVS");
    expect(stvs.value).toBe(7);
    expect(valueEquals(source.fileNames, TestAlphabeticalSequence.ORDER)).toBe(true);
    expect(reparsed.name).toBe("shots");
  });

  test("test_numbered_import_keeps_the_prefix", () => {
    const tmpPath = makeTmpPath();
    const [, item] = _import(TestAlphabeticalSequence._mixed(tmpPath).div("a_001.png"), { alphabetical: false });
    expect(item.name).toBe("a_[001-002].png");
    expect(item.duration).toBe(2 / 30);
  });

  test("test_unnumbered_file_needs_alphabetical_order", () => {
    const tmpPath = makeTmpPath();
    raises(
      ValueError,
      () => _import(TestAlphabeticalSequence._mixed(tmpPath).div("b.png"), { alphabetical: false }),
      "numbered filename",
    );
  });

  test("test_replacing_a_placeholder_keeps_its_rate", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(BASE).project;
    const item = project.importPlaceholder("PH", 640, 480, 24.0, 10.0);
    item.replaceWithSequence(TestAlphabeticalSequence._mixed(tmpPath).div("a_001.png"), true);
    expect(item.name).toBe("shots");
    const sspc = item.mainSource._sspc;
    expect(valueEquals([sspc.durationDividend, sspc.durationDivisor], [7, 24])).toBe(true);
  });

  test("test_reload_relists_the_folder", () => {
    const tmpPath = makeTmpPath();
    const folder = TestAlphabeticalSequence._mixed(tmpPath);
    const [, item] = _import(folder.div("a_001.png"), { alphabetical: true });
    folder.div("zz.png").writeBytes(folder.div("b.png").readBytes());
    asInstance(item.mainSource, FileSource).reload();
    const source = asInstance(item.mainSource, FileSource);
    expect(valueEquals(source.fileNames, [...TestAlphabeticalSequence.ORDER, "zz.png"])).toBe(true);
    expect(item.duration).toBe(8 / 30);
    const stvc = findByListType(source._pin.chunks, "StVc");
    expect(asInstance(stvc.chunks[0], U4LeChunk).value).toBe(8);
  });
});

describe("TestSequencePadding", () => {
  /**
   * The padding is the first frame's digit count, and `sspc` byte 0xB8
   * marks zero-padded frame numbers.
   */

  test.each([
    [Array.from({ length: 12 }, (_, i) => `s${i + 1}.png`), "s12.png", "s[1-12].png", "s1.png", 1, b("\x00")],
    [["p410.png", "p411.png", "p412.png"], "p410.png", "p[410-412].png", "p410.png", 3, b("\x00")],
    [["z_0410.png", "z_0411.png", "z_0412.png"], "z_0411.png", "z_[0410-0412].png", "z_0410.png", 4, b("\x01")],
  ])(
    "test_matches_ae[%#]",
    (names: string[], picked: string, name: string, first: string, padding: number, zeroPadded: Uint8Array) => {
      const tmpPath = makeTmpPath();
      const [project, item] = _import(_folder(tmpPath, ...names).div(picked), { alphabetical: false });
      const reparsed = _reparsed(project, item, tmpPath);
      expect(reparsed.name).toBe(name);
      expect(new Path(asInstance(reparsed.mainSource, FileSource).file).name).toBe(first);
      expect(reparsed.mainSource._sspc.framePadding).toBe(padding);
      expect(valueEquals(reparsed.mainSource._sspc._reservedB8, zeroPadded)).toBe(true);
    },
  );
});

describe("TestSequenceConformFrameRate", () => {
  test.each([
    [24.0, 3, 24],
    [29.97, 300, 2997],
  ])("test_stores_unreduced_frames_over_the_rate[%#]", (rate: number, dividend: number, divisor: number) => {
    /** The frame count over the rate to the nearest thousandth. */
    const tmpPath = makeTmpPath();
    const folder = _folder(tmpPath, "shot_0001.png", "shot_0002.png", "shot_0003.png");
    const [, item] = _import(folder.div("shot_0001.png"), { alphabetical: false });
    item.mainSource.conformFrameRate = rate;
    const sspc = item.mainSource._sspc;
    expect(valueEquals([sspc.durationDividend, sspc.durationDivisor], [dividend, divisor])).toBe(true);
    expect(sspc.conformFrameRate).toBe(0.0);
  });
});

/**
 * A first frame with a timeline of its own (`gif.gif`: 14 frames at
 * 10 fps) sets the sequence's rate and duration, and a replace keeps them
 * (AE 2026).
 */
class TestAnimatedGifSequence {
  static _gifs(tmpPath: Path, first = "gif.gif"): Path {
    const folder = tmpPath.div("gifs");
    folder.mkdir();
    folder.div("m_001.gif").writeBytes(ASSETS.div(first).readBytes());
    folder.div("m_002.gif").writeBytes(ASSETS.div("gif.gif").readBytes());
    return folder.div("m_001.gif");
  }
}

describe("TestAnimatedGifSequence", () => {
  test("test_takes_the_first_files_timeline", () => {
    const tmpPath = makeTmpPath();
    const [, item] = _import(TestAnimatedGifSequence._gifs(tmpPath), { alphabetical: false });
    expect(item.name).toBe("m_[001-002].gif");
    expect(item.frameRate).toBe(10.0);
    expect(item.duration).toBe(1.4);
    const sspc = item.mainSource._sspc;
    expect(valueEquals([sspc.durationDividend, sspc.durationDivisor], [14, 10])).toBe(true);
  });

  test.each(["placeholder", "sequence", "conformed movie"])("test_a_replace_keeps_its_rate[%#]", (old) => {
    const tmpPath = makeTmpPath();
    const project = parseAep(BASE).project;
    let item: FootageItem;
    if (old === "placeholder") {
      item = project.importPlaceholder("PH", 640, 480, 24.0, 10.0);
    } else if (old === "sequence") {
      const opts = new ImportOptions(ASSETS.div("sequence_001.gif"));
      opts.sequence = true;
      item = asInstance(project.importFile(opts), FootageItem);
      item.mainSource.conformFrameRate = 25.0;
    } else {
      item = asInstance(project.importFile(new ImportOptions(ASSETS.div("mov_480.mov"))), FootageItem);
      item.mainSource.conformFrameRate = 25.0;
    }
    item.replaceWithSequence(TestAnimatedGifSequence._gifs(tmpPath), false);
    expect(item.frameRate).toBe(10.0);
    expect(item.duration).toBe(1.4);
  });

  test("test_a_still_first_frame_uses_the_usual_rule", () => {
    const tmpPath = makeTmpPath();
    const [, item] = _import(TestAnimatedGifSequence._gifs(tmpPath, "sequence_001.gif"), {
      alphabetical: false,
    });
    expect(item.frameRate).toBe(30.0);
    expect(item.duration).toBe(2 / 30);
  });
});

describe("TestCachedDataSize", () => {
  /**
   * `sspc` byte 0xD0: the file's size, or for a sequence the first frame's
   * size times the file count (AE 2026 on macOS and Windows).
   */

  test("test_file", () => {
    const project = parseAep(BASE).project;
    const item = asInstance(project.importFile(new ImportOptions(ASSETS.div("image_with_alpha.png"))), FootageItem);
    // Node's fs.Stats exposes the byte count as `size` (Python `st_size`).
    const size = ASSETS.div("image_with_alpha.png").stat().size;
    expect(item.mainSource._sspc.dataSize).toBe(size);
  });

  test("test_sequence", () => {
    // sequence_001..003.gif are 4928, 5332 and 5223 bytes; AE's
    // `imio_sequence.aep` fixture stores 3 x 4928.
    const [, item] = _import(ASSETS.div("sequence_001.gif"), { alphabetical: false });
    expect(item.mainSource._sspc.dataSize).toBe(3 * 4928);
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
    expect(parseAep(BASE).project._platform).toBe(host);
    expect(py_aep.newProject().project._platform).toBe(host);
  });

  test("test_rejects_an_unknown_platform", () => {
    raises(ValueError, () => parseAep(BASE, { platform: "linux" }), "must be one of");
    raises(ValueError, () => py_aep.newProject(undefined, { platform: "linux" }), "must be one of");
  });

  test.each([
    ["windows", "STIL"],
    ["macos", "IMIO"],
  ])("test_gif_sequence_code[%#]", (platform: string, code: string) => {
    const project = parseAep(BASE, { platform }).project;
    const opts = new ImportOptions(ASSETS.div("sequence_001.gif"));
    opts.sequence = true;
    const item = asInstance(project.importFile(opts), FootageItem);
    expect(item.mainSource._sspc.sourceFormatType).toBe(code);
    // Every path that builds a sequence follows the project's platform.
    item.replaceWithSequence(ASSETS.div("sequence_001.gif"));
    expect(item.mainSource._sspc.sourceFormatType).toBe(code);
    item.setProxyWithSequence(ASSETS.div("sequence_001.gif"));
    expect(item.proxySource?._sspc.sourceFormatType).toBe(code);
  });

  test.each([
    ["windows", "STIL", false],
    ["macos", "IMIO", true],
  ])("test_still_paths[%#]", (platform: string, code: string, heicAlpha: boolean) => {
    // Stills take the platform's importer code too, and Windows AE
    // stores HEIC without alpha (windows_stills.aep), on every path.
    const project = parseAep(BASE, { platform }).project;
    const item = asInstance(project.importFile(new ImportOptions(ASSETS.div("bmp.bmp"))), FootageItem);
    expect(item.mainSource._sspc.sourceFormatType).toBe(code);
    item.setProxy(ASSETS.div("gif.gif"));
    expect(item.proxySource?._sspc.sourceFormatType).toBe(code);
    item.replace(ASSETS.div("gif.gif"));
    expect(item.mainSource._sspc.sourceFormatType).toBe(code);
    item.replace(ASSETS.div("heic_alpha.heic"));
    expect(item.mainSource.hasAlpha).toBe(heicAlpha);
  });

  test("test_new_project", () => {
    const project = py_aep.newProject(undefined, { platform: "macos" }).project;
    const opts = new ImportOptions(ASSETS.div("sequence_001.gif"));
    opts.sequence = true;
    expect(asInstance(project.importFile(opts), FootageItem).mainSource._sspc.sourceFormatType).toBe("IMIO");
  });
});
