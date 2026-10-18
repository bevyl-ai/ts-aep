/**
 * Tests for platform path styles and the `alas` relative-path counts.
 */

import { expect, test } from "bun:test";

import { pyEq } from "../../src/pyrt/index.ts";
import { PENDING_ASCENDCOUNT, alasPlatform, buildAls2List } from "../../src/py_aep/binary/utils.ts";
import { Utf8Chunk } from "../../src/py_aep/binary/scalar_chunks.ts";
import { asInstance } from "../helpers.ts";
import { platformPath, relativePathCounts } from "../../src/py_aep/resolvers/platform_paths.ts";

const SHOT = "\\\\serge\\as_serie\\fabrication\\episodes\\e203\\final_compo\\s030";

test.each([
  // Windows AE opens /Users/x as C:\Users\x (measured); the inverse.
  ["C:\\Users\\x\\a.png", "/Users/x/a.png"],
  ["c:\\Users\\x\\a.png", "/Users/x/a.png"],
  ["C:/Users/x/a.png", "/Users/x/a.png"],
  ["C:\\", "/"],
  ["D:\\media\\a.png", "/Volumes/D/media/a.png"],
  ["D:\\", "/Volumes/D"],
  ["\\\\serge\\as_serie\\shot\\a.png", "/Volumes/as_serie/shot/a.png"],
  ["\\\\serge\\as_serie", "/Volumes/as_serie"],
  ["/Users/x/a.png", "/Users/x/a.png"],
  ["relative/a.png", "relative/a.png"],
])("test_platform_path_macos[%#]", (path: string, macos: string) => {
  expect(platformPath(path, { windows: false })).toBe(macos);
});

test.each([
  // What Windows AE resolves a macOS path to (measured on AE 2026).
  ["/Users/x/a.png", "C:\\Users\\x\\a.png"],
  ["/Volumes/v/a.png", "C:\\Volumes\\v\\a.png"],
  ["C:\\Users\\x\\a.png", "C:\\Users\\x\\a.png"],
  ["\\\\server\\share\\a.png", "\\\\server\\share\\a.png"],
  ["relative/a.png", "relative/a.png"],
])("test_platform_path_windows[%#]", (path: string, windows: string) => {
  expect(platformPath(path, { windows: true })).toBe(windows);
});

test.each<[string, string, boolean, [number, number]]>([
  // AE 2026 Windows saves of samples/models/import/*.aep.
  [
    "C:\\repo\\samples\\models\\import\\x.aep",
    "C:\\repo\\samples\\assets\\aif.aif",
    false,
    [3, 2],
  ],
  // A sequence folder counts one level inside it.
  [
    "C:\\repo\\samples\\models\\import\\x.aep",
    "C:\\repo\\samples\\assets",
    true,
    [3, 2],
  ],
  // A render output folder too (samples/models/output_module).
  [
    "C:\\Users\\a\\git\\py-aep\\samples\\models\\output_module\\o.aep",
    "C:\\Users\\a\\Downloads",
    true,
    [6, 2],
  ],
  // Production projects saved on a UNC share.
  [
    SHOT + "\\work\\p.aep",
    SHOT + "\\preview\\interne\\20230313\\x.mov",
    false,
    [2, 4],
  ],
  [
    SHOT + "\\work\\p.aep",
    "\\\\serge\\as_serie\\lab\\compo\\SEQ_SPE\\BANK\\TEXTURES\\PAPER",
    true,
    [7, 7],
  ],
  // Same folder; Windows paths compare case-insensitively.
  ["C:\\Repo\\a.aep", "c:\\repo\\b.png", false, [1, 1]],
  // A macOS save (media_gap_formats.aep).
  [
    "/Volumes/O/overlay/samples/models/import/media_gap_formats.aep",
    "/Volumes/O/overlay/samples/assets/aif.aif",
    false,
    [3, 2],
  ],
  ["/Users/a/proj/p.aep", "/Users/a/media/b.png", false, [2, 2]],
])(
  "test_counts[%#]",
  (project: string, target: string, isFolder: boolean, expected: [number, number]) => {
    expect(
      pyEq(relativePathCounts(project, target, { targetIsFolder: isFolder }), expected),
    ).toBe(true);
  },
);

test.each([
  ["C:\\p\\a.aep", "D:\\p\\b.png"], // another drive
  ["C:\\p\\a.aep", "\\\\server\\share\\b.png"], // a UNC share
  ["\\\\server\\one\\a.aep", "\\\\server\\two\\b.png"], // another share
  ["/Users/a/a.aep", "/Volumes/D/b.png"], // another macOS volume
  ["/Volumes/C/a.aep", "/Volumes/D/b.png"],
  ["/Users/a/a.aep", "C:\\p\\b.png"], // another path style
  ["C:\\p\\a.aep", "relative\\b.png"],
])("test_no_relative_path[%#]", (project: string, target: string) => {
  expect(
    pyEq(relativePathCounts(project, target, { targetIsFolder: false }), [0, 0]),
  ).toBe(true);
});

test("test_counts_survive_the_platform_mapping", () => {
  // Mapping the project and the target alike keeps the host's counts.
  const pairs: [string, string][] = [
    ["C:\\p\\shots\\a.aep", "C:\\media\\b.png"],
    ["C:\\p\\a.aep", "D:\\media\\b.png"],
    [SHOT + "\\work\\p.aep", SHOT + "\\preview\\x.mov"],
  ];
  for (const [project, target] of pairs) {
    const host = relativePathCounts(project, target, { targetIsFolder: false });
    const mapped = relativePathCounts(
      platformPath(project, { windows: false }),
      platformPath(target, { windows: false }),
      { targetIsFolder: false },
    );
    expect(pyEq(mapped, host)).toBe(true);
  }
});

test.each([
  ["/Users/a/b.png", 2],
  ["C:\\a\\b.png", 1],
  ["\\\\server\\share\\b.png", 1],
])("test_alas_platform_follows_path_style[%#]", (path: string, code: number) => {
  expect(alasPlatform(path)).toBe(code);
  const alas = buildAls2List(path, { target_is_folder: false }).chunks[0];
  const data = JSON.parse(asInstance(alas, Utf8Chunk).value);
  expect(data["platform"]).toBe(code);
  expect(data["ascendcount_base"]).toBe(PENDING_ASCENDCOUNT);
  expect(data["ascendcount_target"]).toBe(PENDING_ASCENDCOUNT);
});
