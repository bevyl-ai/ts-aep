/**
 * Discover installed Adobe ICC profiles for writing Adobe-CMS color spaces.
 *
 * Writing an Adobe-CMS working/display color space requires embedding the full
 * ICC profile bytes; writing a footage/output color space requires only the
 * 16-byte ICC Profile ID (masked-MD5). This module resolves a color-space *name*
 * to either, discovering profiles at write time from the standard Adobe Color
 * directories (or caller-supplied dirs).
 *
 * Profiles are NOT bundled - the camera/film/log profiles are vendor/Adobe
 * proprietary. They are discovered from the user's installation (present whenever
 * After Effects is). See the `color-management-write-rev-eng` notes.
 *
 * The ID algorithm (`iccProfileId`) and `desc` extraction
 * (`iccProfileDescription`) are the ISO 15076-1 routines also used by
 * `scripts/dev/generate_color_space_mapping.py`, which imports them from here.
 */

import { md5 } from "../../pyrt/md5.ts";
import * as host from "../../pyrt/host.ts";
import {
  LookupError,
  OSError,
  Path,
  Bytes,
  bytesEqual,
  decode,
  literal,
  rstrip,
  compare, ascii } from "../../pyrt/index.ts";
import { profileIdForName } from "../enums/mappings.ts";

/**
 * Compute the 16-byte ICC Profile ID per ISO 15076-1 7.2.18.
 *
 * The MD5 of the profile with the profile-flags (44-47), rendering-intent
 * (64-67) and profile-ID (84-99) fields zeroed. This is the value After
 * Effects stores in footage `apid` and output `outputProfileId`.
 *
 * @param data - Raw ICC profile bytes.
 * @returns The 16-byte digest.
 */
export function iccProfileId(data: Uint8Array): Uint8Array {
  let buf = new Uint8Array(data);
  // bytearray slice assignment: a short buffer is padded/grown instead of clamped.
  const zeroSlice = (start: number, stop: number): void => {
    const s0 = Math.min(start, buf.length);
    const e0 = Math.max(s0, Math.min(stop, buf.length));
    const grown = new Uint8Array(buf.length - (e0 - s0) + (stop - start));
    grown.set(buf.subarray(0, s0), 0);
    grown.set(buf.subarray(e0), s0 + (stop - start));
    buf = grown;
  };
  zeroSlice(44, 48);
  zeroSlice(64, 68);
  zeroSlice(84, 100);
  return md5(buf);
}

/**
 * Extract the `desc` tag text from an ICC profile.
 *
 * Supports both the ICCv2 `textDescriptionType` and ICCv4
 * `multiLocalizedUnicodeType` tag formats.
 *
 * @param data - Raw ICC profile bytes.
 * @returns The profile description string, or `null` if not found.
 */
export function iccProfileDescription(data: Uint8Array): string | null {
  if (data.length < 132) return null;
  const tagCount = Bytes.intFromBytes(data.slice(128, 132), "big");
  let offset = 132;
  for (let i = 0; i < tagCount; i++) {
    if (offset + 12 > data.length) return null;
    const sig = data.slice(offset, offset + 4);
    const tagOffset = Bytes.intFromBytes(data.slice(offset + 4, offset + 8), "big");
    if (bytesEqual(sig, ascii("desc"))) {
      if (tagOffset + 12 > data.length) return null;
      const typeSig = data.slice(tagOffset, tagOffset + 4);
      if (bytesEqual(typeSig, ascii("desc"))) {
        // ICCv2 textDescriptionType
        const strLen = Bytes.intFromBytes(data.slice(tagOffset + 8, tagOffset + 12), "big");
        const end = Math.min(tagOffset + 12 + strLen, data.length);
        const raw = data.slice(tagOffset + 12, end);
        return decode(Bytes.trimEnd(raw, new Uint8Array(1)), "ascii", "replace");
      }
      if (bytesEqual(typeSig, ascii("mluc"))) {
        // ICCv4 multiLocalizedUnicodeType
        if (tagOffset + 16 > data.length) return null;
        const recCount = Bytes.intFromBytes(data.slice(tagOffset + 8, tagOffset + 12), "big");
        if (recCount === 0) return null;
        const recOff = tagOffset + 16;
        const sLen = Bytes.intFromBytes(data.slice(recOff + 4, recOff + 8), "big");
        const sOffset = Bytes.intFromBytes(data.slice(recOff + 8, recOff + 12), "big");
        const absOff = tagOffset + sOffset;
        const end = Math.min(absOff + sLen, data.length);
        const raw16 = data.slice(absOff, end);
        // pyrt decode() keeps lone surrogates and drops a trailing odd byte; CPython emits U+FFFD for each.
        const dec16 = decode(raw16, "utf-16-be", "replace");
        const oddAfterHigh = raw16.length % 2 === 1 && /[\uD800-\uDBFF]$/.test(dec16);
        const text16 =
          dec16.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD") +
          (raw16.length % 2 === 1 && !oddAfterHigh ? "\uFFFD" : "");
        return rstrip(text16, "\x00");
      }
    }
    offset += 12;
  }
  return null;
}

/**
 * Return the platform's standard ICC profile directories.
 *
 * The canonical Adobe "Media Production" set comes first (`MPProfiles`, then
 * `Profiles` and `Profiles/Recommended`); it supplies the working/display
 * catalog and wins on name collisions because the index keeps the first
 * match. The per-user Adobe Color cache and the OS color-profile store follow
 * as fallbacks: the cache holds the Windows Color System profiles
 * (`* wsRGB`, `* wscRGB`) that After Effects generates at runtime and caches
 * nowhere else on disk.
 */
export function defaultIccDirectories(): Path[] {
  if (host.platform === "win32") {
    const base = new Path("C:\\Program Files (x86)\\Common Files\\Adobe\\Color");
    const dirs = [base.div("MPProfiles"), base.div("Profiles"), base.div("Profiles", "Recommended")];
    const localAppdata = host.env.LOCALAPPDATA;
    if (localAppdata) {
      dirs.push(new Path(localAppdata).div("Adobe", "Color", "Profiles"));
    }
    const systemRoot = host.env.SystemRoot ?? "C:\\Windows";
    dirs.push(new Path(systemRoot).div("System32", "spool", "drivers", "color"));
    return dirs;
  }
  // macOS
  const base = new Path("/Library/Application Support/Adobe/Color");
  const home = Path.home();
  return [
    base.div("MPProfiles"),
    base.div("Profiles"),
    base.div("Profiles", "Recommended"),
    home.div("Library", "Application Support", "Adobe", "Color", "Profiles"),
    home.div("Library", "ColorSync", "Profiles"),
    new Path("/Library/ColorSync/Profiles"),
    new Path("/System/Library/ColorSync/Profiles"),
  ];
}

/** Raised when a named ICC profile cannot be found on disk. */
export class ColorProfileNotFoundError extends LookupError {
  declare profileName: string;

  constructor(name: string, searched: Iterable<Path>) {
    const dirs = [...searched].map((d) => d.toString()).join("\n  ");
    super(
      `ICC profile ${literal(name)} was not found. Writing an Adobe-CMS ` +
        "working/display color space needs the profile's ICC file, which is " +
        "discovered from the installed Adobe Color directories (present " +
        "wherever After Effects is installed). Searched:\n  " +
        `${dirs}\n` +
        "Pass icc_profile_dirs to point at a folder of .icc files, or use " +
        "OCIO color management (which needs no ICC files). Note: 'e-sRGB' " +
        "is generated by the Adobe Color Engine at runtime and has no ICC " +
        "file.",
    );
    this.profileName = name;
  }
}

/**
 * A lazily-scanned index of installed ICC profiles, keyed by description.
 *
 * Resolves a color-space *name* to its raw ICC bytes (`bytesFor`, for
 * embedding a working/display space) or its 16-byte profile ID (`hashFor`,
 * for a footage/output color space).
 */
export class IccProfileLibrary {
  declare _dirs: Path[];
  declare _byName: Map<string, Path> | null;

  /**
   * @param dirs - Directories to scan for `.icc`/`.icm` files. When `null`, the
   *   platform's standard Adobe Color directories are used.
   */
  constructor(dirs: Path[] | null = null) {
    this._dirs = dirs != null ? dirs : defaultIccDirectories();
    this._byName = null;
  }

  _index(): Map<string, Path> {
    // Indexing reads each file once to extract its description, but keeps
    // only the path: the OS color store commonly holds hundreds of
    // profiles, and the library singleton lives for the whole process.
    if (this._byName == null) {
      const byName = new Map<string, Path>();
      for (const directory of this._dirs) {
        if (!directory.isDir()) continue;
        for (const f of [...directory.iterdir()].sort(compare)) {
          if (![".icc", ".icm"].includes(f.suffix.toLowerCase())) continue;
          let data: Uint8Array;
          try {
            data = f.readBytes();
          } catch (e) {
            // pyrt Path.read_bytes rethrows non-ENOENT Node errors (EACCES, EISDIR, ...) unwrapped.
            const hasCode = (typeof e === "object" || typeof e === "function") && e !== null && "code" in e;
            if (!(e instanceof OSError || (hasCode && typeof e.code === "string"))) throw e;
            continue;
          }
          if (data.length < 132 || !bytesEqual(data.slice(36, 40), ascii("acsp"))) continue;
          const desc = iccProfileDescription(data);
          // First directory wins (MPProfiles is the canonical set).
          if (desc && !byName.has(desc)) byName.set(desc, f);
        }
      }
      this._byName = byName;
    }
    return this._byName;
  }

  /**
   * Return the raw ICC bytes for a profile name.
   *
   * @throws ColorProfileNotFoundError If no profile with that description is
   *   found in the searched directories.
   */
  bytesFor(name: string): Uint8Array {
    const path = this._index().get(name);
    if (path == null) throw new ColorProfileNotFoundError(name, this._dirs);
    return path.readBytes();
  }

  /**
   * Return the 16-byte ICC Profile ID for a profile name.
   *
   * Prefers the catalogued ID (no disk access needed); falls back to hashing
   * a discovered ICC file.
   *
   * @throws ColorProfileNotFoundError If the name is neither catalogued nor
   *   found on disk.
   */
  hashFor(name: string): Uint8Array {
    const known = profileIdForName(name);
    if (known != null) return known;
    const path = this._index().get(name);
    if (path == null) throw new ColorProfileNotFoundError(name, this._dirs);
    return iccProfileId(path.readBytes());
  }
}

export let _defaultLibrary: IccProfileLibrary | null = null;

/**
 * Return a shared `IccProfileLibrary` over the standard Adobe Color dirs.
 *
 * Used where no per-project `iccProfileDirs` override is available (e.g.
 * footage sources). Scanned once and cached for the process.
 */
export function defaultIccLibrary(): IccProfileLibrary {
  if (_defaultLibrary == null) _defaultLibrary = new IccProfileLibrary();
  return _defaultLibrary;
}
