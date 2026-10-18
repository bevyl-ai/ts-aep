/**
 * File paths in the `alas` records After Effects stores, per platform.
 *
 * After Effects locates footage and render output by an absolute path written
 * in its own platform's style (POSIX on macOS, drive letter or UNC on Windows),
 * and falls back to a path relative to the project file when that is gone (a
 * moved project folder, another machine). The fallback is stored as two
 * counts: `ascendcount_base`, the path components from the common folder down
 * to the project file, and `ascendcount_target`, the same down to the target.
 */

import { pyEq, PurePath, PurePosixPath, PureWindowsPath } from "../../pyrt/index.ts";

export const _DRIVE = /^([A-Za-z]):[\\\/]?(.*)$/s;
export const _UNC = /^(?:\\\\|\/\/)[^\\\/]+[\\\/]([^\\\/]+)[\\\/]?(.*)$/s;

export function _isPosix(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//");
}

/**
 * `path` in the style of After Effects on the target platform.
 *
 * After Effects on Windows opens a macOS path `/Users/x/a.png` as
 * `C:\Users\x\a.png` (and `/Volumes/v/a.png` as
 * `C:\Volumes\v\a.png`), measured on AE 2026; the reverse is the
 * inverse of that. A Windows path on another drive or on a UNC share has no
 * such counterpart, so it maps to a macOS mount point - `D:\x` to
 * `/Volumes/D/x`, `\\server\share\x` to `/Volumes/share/x` (the
 * usual macOS mount of a share, not measured). A path already in the target
 * style, or a relative one, is returned unchanged.
 *
 * @param path - An absolute path in either style.
 * @param kw - Keyword arguments:
 * - `windows`: `true` for After Effects on Windows, `false` for macOS.
 */
export function platformPath(path: string, kw: { windows: boolean }): string {
  const { windows } = kw;
  if (windows) {
    if (_isPosix(path)) {
      return "C:" + path.replace(/\//g, "\\");
    }
    return path;
  }
  if (_isPosix(path)) {
    return path;
  }
  const drive = _DRIVE.exec(path);
  const unc = drive ? null : _UNC.exec(path);
  let root: string;
  let rest: string;
  if (drive) {
    const letter = drive[1].toUpperCase();
    root = letter === "C" ? "" : "/Volumes/" + letter;
    rest = drive[2];
  } else if (unc) {
    root = "/Volumes/" + unc[1];
    rest = unc[2];
  } else {
    return path;
  }
  rest = rest.replace(/\\/g, "/");
  // `f"{root}/{rest}" if rest or not root else root`
  return rest !== "" || root === "" ? `${root}/${rest}` : root;
}

export function _purePath(path: string): PurePath | null {
  if (_isPosix(path)) {
    return new PurePosixPath(path);
  }
  if (_DRIVE.test(path) || _UNC.test(path)) {
    return new PureWindowsPath(path);
  }
  return null;
}

/** How many leading parts name the volume: the drive or UNC share, or
 * on macOS `/Volumes/<name>` (else the root). */
export function _volumeParts(path: PurePath): number {
  if (path instanceof PurePosixPath) {
    return path.parts.length > 2 && path.parts[1] === "Volumes" ? 3 : 1;
  }
  return 1;
}

/**
 * The `(ascendcount_base, ascendcount_target)` pair After Effects stores.
 *
 * Each count is the number of path components below the deepest folder
 * the project file and the target share. A folder target (an image
 * sequence's folder, a render output folder) counts one component more, as
 * for a file inside it. Paths on different volumes or in different path
 * styles have no relative path: `(0, 0)`.
 *
 * Matches the counts After Effects writes on Windows - AE 2026 saves on a
 * local drive, and production projects saved on a UNC share - for footage
 * files, sequence folders and render output folders. On macOS a
 * `/Volumes/<name>` mount is taken as its own volume, like a drive or share
 * (not measured).
 *
 * @param projectFile - Absolute path of the saved `.aep` file, in the same style as `target` (see
 *   `platform_path`).
 * @param target - The record's absolute `fullpath`.
 * @param kw - Keyword arguments:
 * - `target_is_folder`: The record's `target_is_folder`.
 */
export function relativePathCounts(
  projectFile: string,
  target: string,
  kw: { targetIsFolder: boolean },
): [number, number] {
  const { targetIsFolder } = kw;
  const base = _purePath(projectFile);
  let goal = _purePath(target);
  // `type(base) is type(goal)`
  if (base == null || goal == null || base.constructor !== goal.constructor) {
    return [0, 0];
  }
  if (targetIsFolder) {
    goal = goal.div("_");
  }
  // Windows paths compare case-insensitively.
  const fold = base instanceof PureWindowsPath;
  const a = base.parts.map((p) => (fold ? p.toLowerCase() : p));
  const b = goal.parts.map((p) => (fold ? p.toLowerCase() : p));
  const volume = _volumeParts(base);
  if (!pyEq(a.slice(0, volume), b.slice(0, _volumeParts(goal)))) {
    return [0, 0];
  }
  let common = 0;
  while (common < Math.min(a.length, b.length) && a[common] === b[common]) {
    common += 1;
  }
  return [a.length - common, b.length - common];
}
