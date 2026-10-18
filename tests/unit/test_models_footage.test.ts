/** Tests for FootageItem model parsing. */

import { describe, expect, test } from "bun:test";

import "../../src/py_aep/binary/_register.ts";
import { AlphaMode, LinearLightMode, parse as parseAep } from "../../src/py_aep/index.ts";
import { ListChunk } from "../../src/py_aep/binary/chunk.ts";
import { IpwsChunk } from "../../src/py_aep/binary/misc_chunks.ts";
import { Utf8Chunk } from "../../src/py_aep/binary/scalar_chunks.ts";
import { UNDEFINED_FRAME, findByType } from "../../src/py_aep/binary/utils.ts";
import { ColorProfileNotFoundError, defaultIccLibrary, iccProfileId } from "../../src/py_aep/color/icc.ts";
import { ImportOptions } from "../../src/py_aep/models/import_options.ts";
import { FootageItem } from "../../src/py_aep/models/items/footage.ts";
// NOTE(port): Python re-imports UNDEFINED_FRAME via models.sources.file; it is the same constant from binary/utils.ts
import { FileSource } from "../../src/py_aep/models/sources/file.ts";
import { probeMedia } from "../../src/py_aep/resolvers/media_probe.ts";
import { AttributeError, ValueError, Path, b, Bytes, int, valueEquals, repr } from "../../src/pyrt/index.ts";

import { asInstance } from "../helpers.ts";
import { approx, raises, skip } from "../support/pytest.ts";

const __file__ = new Path(import.meta.path);
const SAMPLES_DIR = __file__.parent.parent.parent.div("samples", "models", "footage");
const SAMPLES = __file__.parent.parent.parent.div("samples", "models");

/**
 * `pytest.raises(AttributeError)` around an assignment to a read-only property:
 * a getter-only accessor throws a native JS TypeError in strict mode, which is
 * the TS spelling of Python's AttributeError.
 */
function _raisesReadOnly(fn: () => unknown): void {
  raises(AttributeError, () => {
    try {
      fn();
    } catch (e) {
      if (e instanceof globalThis.TypeError) throw new AttributeError(e.message);
      throw e;
    }
  });
}

function _getFirstFootage(aepPath: Path): FootageItem {
  /** Parse an .aep and return the first footage item. */
  const project = parseAep(aepPath).project;
  return project.footages[0];
}

describe("TestFootageReadOnly", () => {
  /** All FootageItem fields backed by source delegation are read-only. */

  test("test_width_is_read_only", () => {
    const footage = _getFirstFootage(SAMPLES_DIR.div("solid_sizes.aep"));
    _raisesReadOnly(() => {
      // @ts-expect-error read-only property (type: ignore[misc])
      footage.width = 100;
    });
  });

  test("test_height_is_read_only", () => {
    const footage = _getFirstFootage(SAMPLES_DIR.div("solid_sizes.aep"));
    _raisesReadOnly(() => {
      // @ts-expect-error read-only property (type: ignore[misc])
      footage.height = 100;
    });
  });

  test("test_duration_is_read_only", () => {
    const footage = _getFirstFootage(SAMPLES_DIR.div("placeholder.aep"));
    _raisesReadOnly(() => {
      // @ts-expect-error read-only property (type: ignore[misc])
      footage.duration = 5.0;
    });
  });

  test("test_frame_rate_is_read_only", () => {
    const footage = _getFirstFootage(SAMPLES_DIR.div("footage_misc.aep"));
    _raisesReadOnly(() => {
      // @ts-expect-error read-only property (type: ignore[misc])
      footage.frameRate = 30.0;
    });
  });

  test("test_frame_duration_is_read_only", () => {
    const footage = _getFirstFootage(SAMPLES_DIR.div("placeholder.aep"));
    _raisesReadOnly(() => {
      // @ts-expect-error read-only property (type: ignore[misc])
      footage.frameDuration = 100;
    });
  });

  test("test_footage_missing_is_read_only", () => {
    const footage = _getFirstFootage(SAMPLES_DIR.div("footage_missing.aep"));
    _raisesReadOnly(() => {
      // @ts-expect-error read-only property (type: ignore[misc])
      footage.footageMissing = false;
    });
  });
});

describe("TestSequenceFrameBoundsDerivation", () => {
  /**
   * AE leaves `sspc.startFrame`/`end_frame` undefined for some image
   * sequences and stores the real numbers only in the `StVc` filenames.
   * py_aep derives them on read; it must NOT write them back, or an
   * untouched parse/save round trip stops being byte-identical (every
   * EXR-sequence footage in a pre-2019 project was affected).
   */

  /**
   * A sequence source whose sspc bounds are undefined and whose
   * frame numbers live only in an `StVc` list of filenames.
   */
  function _sequenceWithStvc(names: string[]): FileSource {
    const source = FileSource._new(new Path("C:/footage/render/render.0101.exr"), {
      sourceFormat: "oEXR",
      width: 1920,
      height: 1080,
      duration: 2.0,
      frameRate: 24.0,
      sequencePrefix: "render.",
      sequenceExt: ".exr",
      startFrame: 101,
      endFrame: 148,
      framePadding: 4,
      windows: true,
    });
    const sspc = source._sspc;
    sspc.startFrame = UNDEFINED_FRAME;
    sspc.endFrame = UNDEFINED_FRAME;
    source._pin.chunks.push(
      new ListChunk({
        chunkType: "LIST",
        listType: "StVc",
        chunks: names.map((name) => new Utf8Chunk({ value: name })),
      }),
    );
    // Re-wrap so __init__ runs against the doctored chunks.
    return new FileSource({
      _pin: source._pin,
      _sspc: sspc,
      _opti: source._opti,
      _linl: source._linl,
      _clrs: source._clrs,
    });
  }

  test("test_bounds_derived_from_stvc_filenames", () => {
    const source = _sequenceWithStvc(["render.0101.exr", "render.0102.exr", "render.0148.exr"]);
    expect(source._startFrame).toBe(101);
    expect(source._endFrame).toBe(148);
  });

  test("test_derivation_does_not_write_the_chunk", () => {
    const source = _sequenceWithStvc(["render.0101.exr", "render.0102.exr", "render.0148.exr"]);
    expect(source._startFrame).toBe(101);
    expect(source._endFrame).toBe(148);
    // The chunk keeps AE's undefined sentinel, so a save reproduces the
    // original bytes.
    expect(source._sspc.startFrame).toBe(UNDEFINED_FRAME);
    expect(source._sspc.endFrame).toBe(UNDEFINED_FRAME);
  });

  test("test_stored_bounds_win_over_derivation", () => {
    const source = _sequenceWithStvc(["render.0101.exr", "render.0148.exr"]);
    source._sspc.startFrame = 7;
    source._sspc.endFrame = 9;
    expect(valueEquals([source._startFrame, source._endFrame], [7, 9])).toBe(true);
  });

  test("test_undefined_without_stvc_stays_undefined", () => {
    const source = FileSource._new(new Path("C:/footage/render/render.0101.exr"), {
      sourceFormat: "oEXR",
      width: 1920,
      height: 1080,
      duration: 2.0,
      frameRate: 24.0,
      sequencePrefix: "render.",
      sequenceExt: ".exr",
      startFrame: 101,
      endFrame: 148,
      framePadding: 4,
      windows: true,
    });
    source._sspc.startFrame = UNDEFINED_FRAME;
    source._sspc.endFrame = UNDEFINED_FRAME;
    expect(source._startFrame).toBe(UNDEFINED_FRAME);
    expect(source._endFrame).toBe(UNDEFINED_FRAME);
  });
});

describe("TestAlphaModeWrites", () => {
  /**
   * Writing `alpha_mode` keeps the `sspc` alpha bytes self-consistent.
   *
   * AE pairs the mode byte with bit 0 of the alpha flags and resets the whole
   * interpretation to straight alpha when it reads a file where the two
   * disagree (AE 2026).
   */

  function _pngSource(): FileSource {
    const project = parseAep(SAMPLES.div("project", "emptier.aep")).project;
    const item = project.importFile(
      new ImportOptions(SAMPLES.parent.div("assets", "image_with_alpha.png")),
    );
    return asInstance(asInstance(item, FootageItem).mainSource, FileSource);
  }

  test.each([
    [AlphaMode.STRAIGHT, 0, false],
    [AlphaMode.PREMULTIPLIED, 1, true],
    [AlphaMode.IGNORE, 2, false],
  ])("test_mode_byte_and_flag_bit_agree[%#]", (mode: AlphaMode, raw: number, premultiplied: boolean) => {
    const source = _pngSource();
    source.alphaMode = mode;
    expect(source._sspc.alphaModeRaw).toBe(raw);
    expect(source._sspc.premultiplied).toBe(premultiplied);
    expect(source.alphaMode).toBe(mode);
  });

  test("test_ignore_keeps_the_flag_bit", () => {
    // AE 2026 leaves the bit as it was on Ignore: set after
    // Premultiplied, clear after Straight (a PNG and an FBX alike).
    const source = _pngSource();
    source.alphaMode = AlphaMode.PREMULTIPLIED;
    source.alphaMode = AlphaMode.IGNORE;
    expect(source._sspc.premultiplied).toBe(true);
    source.alphaMode = AlphaMode.STRAIGHT;
    source.alphaMode = AlphaMode.IGNORE;
    expect(source._sspc.premultiplied).toBe(false);
  });

  test("test_rejected_without_an_alpha_channel", () => {
    const project = parseAep(SAMPLES.div("project", "emptier.aep")).project;
    const item = project.importFile(new ImportOptions(SAMPLES.parent.div("assets", "mov_480.mov")));
    const source = asInstance(item, FootageItem).mainSource;
    expect(source.hasAlpha).toBe(false);
    raises(
      ValueError,
      () => {
        source.alphaMode = AlphaMode.PREMULTIPLIED;
      },
      "no alpha channel",
    );
    // The "no alpha channel" marker survives the rejected write.
    expect(source._sspc.alphaModeRaw).toBe(3);
    expect(source.hasAlpha).toBe(false);
  });
});

describe("TestSourceModifiedStamp", () => {
  /**
   * AE stamps the source's last-modified time and re-reads the media when
   * it does not match - taking an EXR's size from its data window rather than
   * the display window AE's importer recorded.
   */

  test("test_single_file_carries_its_own_mtime", () => {
    const project = parseAep(SAMPLES.div("project", "emptier.aep")).project;
    const path = SAMPLES.parent.div("assets", "new_exr.0002.exr");
    const item = project.importFile(new ImportOptions(path));
    // NOTE(port): int() truncates to whole seconds, so ms-precision mtimeMs/1000 gives the same value as st_mtime
    expect(asInstance(item, FootageItem).mainSource._sspc.sourceModified).toBe(int(path.stat().mtimeMs / 1000));
  });

  test("test_sequence_carries_the_folder_mtime", () => {
    const project = parseAep(SAMPLES.div("project", "emptier.aep")).project;
    const path = SAMPLES.parent.div("assets", "new_exr.0002.exr");
    const opts = new ImportOptions(path);
    opts.sequence = true;
    const item = project.importFile(opts);
    // NOTE(port): int() truncates to whole seconds, so ms-precision mtimeMs/1000 gives the same value as st_mtime
    expect(asInstance(item, FootageItem).mainSource._sspc.sourceModified).toBe(int(path.parent.stat().mtimeMs / 1000));
  });

  test("test_unreadable_media_stays_unstamped", () => {
    const source = FileSource._new(new Path("C:/nowhere/render.0001.exr"), {
      sourceFormat: "oEXR",
      width: 64,
      height: 64,
      duration: 0.0,
      frameRate: 0.0,
      windows: true,
    });
    expect(source._sspc.sourceModified).toBe(0);
  });
});

/**
 * Skip unless the named profile is discoverable on this machine.
 *
 * An assigned media profile is written by embedding the ICC bytes AE
 * itself would embed, discovered from the installed Adobe Color dirs. With
 * no ICC store (a CI runner, any machine without AE) the import records no
 * profile at all, by design - see `_media_profile_records`.
 *
 * Returns false (after `skip`) when the profile is missing; callers `return`
 * on false, which is the TS spelling of Python's `pytest.skip` aborting the test.
 */
function _requireProfile(name: string): boolean {
  try {
    defaultIccLibrary().bytesFor(name);
  } catch (e) {
    if (!(e instanceof ColorProfileNotFoundError)) throw e;
    skip(`ICC profile ${repr(name)} not installed`);
    return false;
  }
  return true;
}

describe("TestMediaColorProfileRecord", () => {
  /**
   * AE records the profile a file embeds, and assigns sRGB when it embeds
   * none (AE 2026, measured across PNG, JPEG, TIFF, PSD, EXR, HDR, TGA and
   * WAV imports).
   */

  function _import(name: string): FileSource {
    const project = parseAep(SAMPLES.div("project", "emptier.aep")).project;
    const item = project.importFile(new ImportOptions(SAMPLES.parent.div("assets", name)));
    return asInstance(asInstance(item, FootageItem).mainSource, FileSource);
  }

  test.each([
    ["image_with_alpha.png", "Embedded"],
    ["11_progressive.jpg", "Embedded"],
    ["8bits.tif", "Embedded"],
    ["8bits.psd", "Embedded"],
    ["8bits_compressed.png", "sRGB IEC61966-2.1"],
    ["new_exr.0002.exr", "sRGB IEC61966-2.1"],
    ["hdr.hdr", "sRGB IEC61966-2.1"],
    ["tga_32.tga", "sRGB IEC61966-2.1"],
  ])("test_media_color_space[%#]", (filename: string, expected: string) => {
    if (expected !== "Embedded") {
      if (!_requireProfile(expected)) return;
    }
    expect(_import(filename).mediaColorSpace).toBe(expected);
  });

  test("test_embedded_profile_is_recorded_by_id", () => {
    const source = _import("image_with_alpha.png");
    const epid = findByType(asInstance(source._clrs, ListChunk).chunks, "epid");
    const blob = probeMedia(SAMPLES.parent.div("assets", "image_with_alpha.png")).iccProfile;
    expect(blob != null).toBe(true);
    if (blob == null) throw new Error("image_with_alpha.png has no ICC profile");
    expect(valueEquals(epid.data, iccProfileId(blob))).toBe(true);
  });

  test("test_quicktime_records_no_profile", () => {
    /**
     * A QuickTime/MP4 names its color space (`empd` + "Rec. 709") from
     * data py_aep cannot read yet, so it records none - which is what AE
     * writes for an untagged JPEG, and AE fills the name in on open.
     */
    const source = _import("mov_480.mov");
    const clrs = asInstance(source._clrs, ListChunk);
    expect(asInstance(findByType(clrs.chunks, "ipws"), IpwsChunk).value).toBe(0);
    expect(valueEquals(findByType(clrs.chunks, "apid").data, Bytes.repeat(b("\xff"), 16))).toBe(true);
    expect(source.mediaColorSpace).toBe("Embedded");
  });

  test("test_untagged_jpeg_records_no_profile", () => {
    const source = _import("11_progressive.jpg");
    expect(source.mediaColorSpace).toBe("Embedded");
  });

  test.each([
    ["gif.gif", "Rec.709 Gamma 2.4"], // animated
    ["mpeg.mpeg", "Rec.709 Gamma 2.4"],
    ["wmv.wmv", "Rec.709 Gamma 2.4"],
    ["swf.swf", "Rec.709 Gamma 2.4"],
    ["sequence_001.gif", "sRGB IEC61966-2.1"], // a still of the same format
    ["bmp.bmp", "sRGB IEC61966-2.1"],
  ])("test_video_gets_rec709[%#]", (filename: string, expected: string) => {
    /**
     * AE assigns Rec.709 to the video it decodes itself, and sRGB to a
     * still or an image sequence of the same format.
     */
    if (!_requireProfile(expected)) return;
    expect(_import(filename).mediaColorSpace).toBe(expected);
  });

  test("test_tiff_and_psd_embed_the_catalogued_copy", () => {
    /**
     * Their importers embed AE's own copy of the profile, not the
     * file's bytes - the two differ in the advisory rendering intent.
     */
    if (!_requireProfile("sRGB IEC61966-2.1")) return;
    const source = _import("8bits.tif");
    const blob = probeMedia(SAMPLES.parent.div("assets", "8bits.tif")).iccProfile;
    expect(blob != null).toBe(true);
    if (blob == null) throw new Error("8bits.tif has no ICC profile");
    const catalogued = defaultIccLibrary().bytesFor("sRGB IEC61966-2.1");
    expect(valueEquals(blob, catalogued)).toBe(false); // the file's copy differs...
    expect(valueEquals(iccProfileId(blob), iccProfileId(catalogued))).toBe(true); // ...but not in id
    const epid = findByType(asInstance(source._clrs, ListChunk).chunks, "epid");
    expect(valueEquals(epid.data, iccProfileId(catalogued))).toBe(true);
  });

  test.each([
    ["11_progressive.jpg", false, LinearLightMode.OFF],
    ["bmp.bmp", false, LinearLightMode.OFF],
    ["gif.gif", false, LinearLightMode.OFF],
    ["mov_480.mov", false, LinearLightMode.OFF],
    ["sequence_001.gif", true, LinearLightMode.ON_FOR_32BPC],
    ["m4a.m4a", false, LinearLightMode.ON_FOR_32BPC],
    ["image_with_alpha.png", false, LinearLightMode.ON_FOR_32BPC],
    ["new_exr.0002.exr", false, LinearLightMode.ON_FOR_32BPC],
  ])(
    "test_interpret_as_linear_light_default[%#]",
    (filename: string, sequence: boolean, expected: LinearLightMode) => {
      /**
       * AE turns it off for the formats it decodes through its media
       * importers - but not for an audio-only movie or an image sequence.
       */
      const project = parseAep(SAMPLES.div("project", "emptier.aep")).project;
      const opts = new ImportOptions(SAMPLES.parent.div("assets", filename));
      if (sequence) {
        opts.sequence = true;
      }
      const item = project.importFile(opts);
      expect(asInstance(item, FootageItem).mainSource.interpretAsLinearLight).toBe(expected);
    },
  );
});

describe("TestWritableInterpretation", () => {
  /** `pixel_aspect` and `conform_frame_rate` write what AE writes. */

  function _import(name: string, sequence = false): FootageItem {
    const project = parseAep(SAMPLES.div("project", "emptier.aep")).project;
    const opts = new ImportOptions(SAMPLES.parent.div("assets", name));
    if (sequence) {
      opts.sequence = true;
    }
    return asInstance(project.importFile(opts), FootageItem);
  }

  test("test_pixel_aspect_is_writable", () => {
    const item = _import("image_with_alpha.png");
    item.pixelAspect = 1.5;
    expect(item.pixelAspect).toBe(1.5);
    expect(item.mainSource._sspc.pixelAspectDividend).toBe(3);
    expect(item.mainSource._sspc.pixelAspectDivisor).toBe(2);
  });

  test.each([0.0, -1.0, 0.001, 1000.0])("test_pixel_aspect_bounds[%#]", (value: number) => {
    /** AE accepts 0.01 to 100. */
    const item = _import("image_with_alpha.png");
    raises(ValueError, () => {
      item.pixelAspect = value;
    });
  });

  test("test_conform_rate_on_a_movie_uses_the_conform_slot", () => {
    const item = _import("mov_480.mov");
    item.mainSource.conformFrameRate = 25.0;
    expect(item.mainSource._sspc.conformFrameRate).toBe(25.0);
    expect(item.mainSource._sspc.nativeFrameRate).toBe(30.0);
    expect(item.mainSource.conformFrameRate).toBe(25.0);
  });

  test("test_conform_rate_on_a_sequence_uses_the_native_slot", () => {
    /**
     * A sequence has no rate of its own: AE keeps the assumed one as the
     * native rate, leaves the conform slot at 0, and rescales the stored
     * duration over the new rate.
     */
    const item = _import("new_exr.0002.exr", true);
    const sspc = item.mainSource._sspc;
    expect(sspc.nativeFrameRate).toBe(30.0);
    expect(approx(sspc.duration, 2 / 30)).toBe(true);
    item.mainSource.conformFrameRate = 25.0;
    expect(sspc.conformFrameRate).toBe(0.0);
    expect(sspc.nativeFrameRate).toBe(25.0);
    expect(approx(sspc.duration, 2 / 25)).toBe(true);
    expect(item.mainSource.conformFrameRate).toBe(25.0);
    expect(item.frameRate).toBe(25.0);
  });

  test("test_zero_conform_rate_is_ignored_on_a_sequence", () => {
    const item = _import("new_exr.0002.exr", true);
    item.mainSource.conformFrameRate = 25.0;
    item.mainSource.conformFrameRate = 0.0;
    expect(item.mainSource.conformFrameRate).toBe(25.0);
  });

  test("test_zero_conform_rate_clears_it_on_a_movie", () => {
    const item = _import("mov_480.mov");
    item.mainSource.conformFrameRate = 25.0;
    item.mainSource.conformFrameRate = 0.0;
    expect(item.mainSource.conformFrameRate).toBe(0.0);
    expect(item.frameRate).toBe(30.0);
  });
});
