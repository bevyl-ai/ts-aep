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
 * The ID algorithm (`icc_profile_id`) and `desc` extraction
 * (`icc_profile_description`) are the ISO 15076-1 routines also used by
 * `scripts/dev/generate_color_space_mapping.py`, which imports them from here.
 */

import { md5 } from "../../pyrt/md5.ts";
import * as host from "../../pyrt/host.ts";
import {
  LookupError,
  OSError,
  Path,
  b,
  bytes_,
  bytes_eq,
  decode,
  repr,
  rstrip,
  sorted,
} from "../../pyrt/index.ts";
import { profile_id_for_name } from "../enums/mappings.ts";

/**
 * Compute the 16-byte ICC Profile ID per ISO 15076-1 7.2.18.
 *
 * The MD5 of the profile with the profile-flags (44-47), rendering-intent
 * (64-67) and profile-ID (84-99) fields zeroed. This is the value After
 * Effects stores in footage `apid` and output `output_profile_id`.
 *
 * @param data - Raw ICC profile bytes.
 * @returns The 16-byte digest.
 */
export function icc_profile_id(data: Uint8Array): Uint8Array {
  let buf = new Uint8Array(data);
  // bytearray slice assignment: a short buffer is padded/grown instead of clamped.
  const zero_slice = (start: number, stop: number): void => {
    const s0 = Math.min(start, buf.length);
    const e0 = Math.max(s0, Math.min(stop, buf.length));
    const grown = new Uint8Array(buf.length - (e0 - s0) + (stop - start));
    grown.set(buf.subarray(0, s0), 0);
    grown.set(buf.subarray(e0), s0 + (stop - start));
    buf = grown;
  };
  zero_slice(44, 48);
  zero_slice(64, 68);
  zero_slice(84, 100);
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
export function icc_profile_description(data: Uint8Array): string | null {
  if (data.length < 132) return null;
  const tag_count = bytes_.int_from_bytes(bytes_.slice(data, 128, 132), "big");
  let offset = 132;
  for (let i = 0; i < tag_count; i++) {
    if (offset + 12 > data.length) return null;
    const sig = bytes_.slice(data, offset, offset + 4);
    const tag_offset = bytes_.int_from_bytes(bytes_.slice(data, offset + 4, offset + 8), "big");
    if (bytes_eq(sig, b("desc"))) {
      if (tag_offset + 12 > data.length) return null;
      const type_sig = bytes_.slice(data, tag_offset, tag_offset + 4);
      if (bytes_eq(type_sig, b("desc"))) {
        // ICCv2 textDescriptionType
        const str_len = bytes_.int_from_bytes(bytes_.slice(data, tag_offset + 8, tag_offset + 12), "big");
        const end = Math.min(tag_offset + 12 + str_len, data.length);
        const raw = bytes_.slice(data, tag_offset + 12, end);
        return decode(bytes_.rstrip(raw, b("\x00")), "ascii", "replace");
      }
      if (bytes_eq(type_sig, b("mluc"))) {
        // ICCv4 multiLocalizedUnicodeType
        if (tag_offset + 16 > data.length) return null;
        const rec_count = bytes_.int_from_bytes(bytes_.slice(data, tag_offset + 8, tag_offset + 12), "big");
        if (rec_count === 0) return null;
        const rec_off = tag_offset + 16;
        const s_len = bytes_.int_from_bytes(bytes_.slice(data, rec_off + 4, rec_off + 8), "big");
        const s_offset = bytes_.int_from_bytes(bytes_.slice(data, rec_off + 8, rec_off + 12), "big");
        const abs_off = tag_offset + s_offset;
        const end = Math.min(abs_off + s_len, data.length);
        const raw16 = bytes_.slice(data, abs_off, end);
        // pyrt decode() keeps lone surrogates and drops a trailing odd byte; CPython emits U+FFFD for each.
        const dec16 = decode(raw16, "utf-16-be", "replace");
        const odd_after_high = raw16.length % 2 === 1 && /[\uD800-\uDBFF]$/.test(dec16);
        const text16 =
          dec16.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD") +
          (raw16.length % 2 === 1 && !odd_after_high ? "\uFFFD" : "");
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
export function default_icc_directories(): Path[] {
  if (host.platform === "win32") {
    const base = new Path("C:\\Program Files (x86)\\Common Files\\Adobe\\Color");
    const dirs = [base.div("MPProfiles"), base.div("Profiles"), base.div("Profiles", "Recommended")];
    const local_appdata = host.env.LOCALAPPDATA;
    if (local_appdata) {
      dirs.push(new Path(local_appdata).div("Adobe", "Color", "Profiles"));
    }
    const system_root = host.env.SystemRoot ?? "C:\\Windows";
    dirs.push(new Path(system_root).div("System32", "spool", "drivers", "color"));
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
  declare profile_name: string;

  constructor(name: string, searched: Iterable<Path>) {
    const dirs = [...searched].map((d) => d.toString()).join("\n  ");
    super(
      `ICC profile ${repr(name)} was not found. Writing an Adobe-CMS ` +
        "working/display color space needs the profile's ICC file, which is " +
        "discovered from the installed Adobe Color directories (present " +
        "wherever After Effects is installed). Searched:\n  " +
        `${dirs}\n` +
        "Pass icc_profile_dirs to point at a folder of .icc files, or use " +
        "OCIO color management (which needs no ICC files). Note: 'e-sRGB' " +
        "is generated by the Adobe Color Engine at runtime and has no ICC " +
        "file.",
    );
    this.profile_name = name;
  }
}

/**
 * A lazily-scanned index of installed ICC profiles, keyed by description.
 *
 * Resolves a color-space *name* to its raw ICC bytes (`bytes_for`, for
 * embedding a working/display space) or its 16-byte profile ID (`hash_for`,
 * for a footage/output color space).
 */
export class IccProfileLibrary {
  declare _dirs: Path[];
  declare _by_name: Map<string, Path> | null;

  /**
   * @param dirs - Directories to scan for `.icc`/`.icm` files. When `null`, the
   *   platform's standard Adobe Color directories are used.
   */
  constructor(dirs: Path[] | null = null) {
    this._dirs = dirs != null ? dirs : default_icc_directories();
    this._by_name = null;
  }

  _index(): Map<string, Path> {
    // Indexing reads each file once to extract its description, but keeps
    // only the path: the OS color store commonly holds hundreds of
    // profiles, and the library singleton lives for the whole process.
    if (this._by_name == null) {
      const by_name = new Map<string, Path>();
      for (const directory of this._dirs) {
        if (!directory.is_dir()) continue;
        for (const f of sorted(directory.iterdir())) {
          if (![".icc", ".icm"].includes(f.suffix.toLowerCase())) continue;
          let data: Uint8Array;
          try {
            data = f.read_bytes();
          } catch (e) {
            // pyrt Path.read_bytes rethrows non-ENOENT Node errors (EACCES, EISDIR, ...) unwrapped.
            const has_code = (typeof e === "object" || typeof e === "function") && e !== null && "code" in e;
            if (!(e instanceof OSError || (has_code && typeof e.code === "string"))) throw e;
            continue;
          }
          if (data.length < 132 || !bytes_eq(bytes_.slice(data, 36, 40), b("acsp"))) continue;
          const desc = icc_profile_description(data);
          // First directory wins (MPProfiles is the canonical set).
          if (desc && !by_name.has(desc)) by_name.set(desc, f);
        }
      }
      this._by_name = by_name;
    }
    return this._by_name;
  }

  /**
   * Return the raw ICC bytes for a profile name.
   *
   * @throws ColorProfileNotFoundError If no profile with that description is
   *   found in the searched directories.
   */
  bytes_for(name: string): Uint8Array {
    const path = this._index().get(name);
    if (path == null) throw new ColorProfileNotFoundError(name, this._dirs);
    return path.read_bytes();
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
  hash_for(name: string): Uint8Array {
    const known = profile_id_for_name(name);
    if (known != null) return known;
    const path = this._index().get(name);
    if (path == null) throw new ColorProfileNotFoundError(name, this._dirs);
    return icc_profile_id(path.read_bytes());
  }
}

export let _default_library: IccProfileLibrary | null = null;

/**
 * Return a shared `IccProfileLibrary` over the standard Adobe Color dirs.
 *
 * Used where no per-project `icc_profile_dirs` override is available (e.g.
 * footage sources). Scanned once and cached for the process.
 */
export function default_icc_library(): IccProfileLibrary {
  if (_default_library == null) _default_library = new IccProfileLibrary();
  return _default_library;
}
