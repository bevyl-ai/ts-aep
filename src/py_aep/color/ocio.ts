/**
 * Enumerate the color spaces of an OCIO configuration.
 *
 * Backs `Project.listColorProfiles()` in OCIO mode: given the project's
 * `ocio_configuration_file` (a `.ocio` path or a built-in config name like
 * `"ACES 1.2"`), return the assignable color-space names.
 *
 * The list is the OCIO *active* color spaces (`colorspaces` +
 * `display_colorspaces`, minus `inactive_colorspaces`) - exactly what
 * `PyOpenColorIO.Config.getColorSpaceNames()` returns (verified set-equal for
 * AE's bundled `ACES 1.2` (353)), so no OCIO runtime dependency is needed.
 */

// Python's `platform`, `re`, `fnmatch`, `functools`, `typing` and `pathlib`
// imports map to `host.platform`, `RegExp`, `fnmatchcase` (below),
// pyrt `lru_cache`, plain types and pyrt `Path`.

import * as host from "../../pyrt/host.ts";
import { parse, YAMLError, isMap, isSeq, isScalar } from "yaml";
import type { Document, Node, DocumentOptions, ParseOptions, SchemaOptions, ToJSOptions } from "yaml";
import {
  Path,
  lru_cache,
  AttributeError,
  OSError,
  TypeError_,
  ValueError,
  getitem,
  py_bool,
  py_iter,
  str,
  type_name,
  py_or,
  tkey,
  setdefault,
  sorted,
  int,
  repr,
  encode,
  decode,
  b,
  concat,
  bytes_,
  re_search,
} from "../../pyrt/index.ts";
import { _compact, build_ocio_envelope } from "./envelope.ts";
import { ae_guid } from "./murmur3.ts";

/**
 * `class _OcioLoader(yaml.SafeLoader)`: a YAML loader that ignores OCIO's custom tags.
 *
 * yaml (npm) has no loader subclasses, so the loader is represented by the
 * parse options PyYAML's `SafeLoader` implies: YAML 1.1 resolution (`yes`/`on`
 * booleans, merge keys), no duplicate-key error and no alias-count cap.
 */
export class _OcioLoader {
  static readonly options: ParseOptions & DocumentOptions & SchemaOptions & ToJSOptions = {
    version: "1.1",
    mapAsMap: true,
    logLevel: "error",
    uniqueKeys: false,
    maxAliasCount: -1,
  };
}

/**
 * A value `yaml` `parse` yields for an OCIO config under `_OcioLoader`
 * (YAML 1.1, `mapAsMap: true`): a scalar (`!!timestamp` is a `Date`,
 * `!!binary` a `Uint8Array`), a list, a set, or a mapping. Nothing about
 * its shape is checked on load - py_aep never validates the config - so
 * each reader narrows the value where it reads it.
 */
export type OcioValue =
  | string
  | number
  | boolean
  | null
  | Date
  | Uint8Array
  | OcioValue[]
  | Set<OcioValue>
  | OcioNode;

/** An OCIO mapping. Its keys are YAML values too (`3: x`, `~: x`), not only strings. */
export interface OcioNode extends Map<OcioValue, OcioValue> {}

/**
 * Whether `value` holds a list, dict or set as a mapping key or set member.
 *
 * NOTE(port): PyYAML refuses one ("found unhashable key", a `YAMLError`), so
 * Python's `_load_config_cached` returns `None` for such a config; `yaml`
 * (npm) builds it. `seen` guards the cycles anchors can build.
 */
export function _has_unhashable_key(value: OcioValue, seen: Set<OcioValue> = new Set()): boolean {
  if (!(Array.isArray(value) || value instanceof Map || value instanceof Set) || seen.has(value)) return false;
  seen.add(value);
  const unhashable = (x: OcioValue): boolean => Array.isArray(x) || x instanceof Map || x instanceof Set;
  if (value instanceof Map) {
    for (const [k, v] of value) {
      if (unhashable(k) || _has_unhashable_key(v, seen)) return true;
    }
    return false;
  }
  for (const item of value) {
    if ((value instanceof Set && unhashable(item)) || _has_unhashable_key(item, seen)) return true;
  }
  return false;
}

/**
 * `_ignore_tag(loader, suffix, node)`: the empty-prefix multi-constructor.
 *
 * OCIO writes tags as `!<ColorSpace>` etc.; these resolve to BARE tags
 * (`ColorSpace`, `View`, `Rule`, ...), so an empty-prefix multi-constructor
 * is required (a `"!"`-prefix one would not match). Return the underlying
 * value, discarding the tag.
 *
 * NOTE(port): yaml (npm) has no multi-constructors, so this is never
 * registered; `parse` in `_load_config_cached` drops unresolved tags itself
 * (warning silenced by `logLevel: "error"`), which yields the same untagged
 * values as this constructor. `loader` is the yaml `Document`.
 */
export function _ignore_tag(loader: Document, suffix: string, node: Node): OcioValue | null {
  if (isMap(node) || isSeq(node) || isScalar(node)) {
    return node.toJS(loader, { mapAsMap: true });
  }
  return null;
}

/**
 * `@lru_cache(maxsize=8) def _load_config_cached(config_path, _stamp)`.
 *
 * Parses a `.ocio` file and returns its top-level mapping, or `null` if it
 * cannot be read or parsed.
 *
 * NOTE(port): pyrt `lru_cache` keys object arguments by identity and never
 * evicts, so the cached functions in this module take primitives
 * (path string, `mtime_ns` bigint, `size`) to get real cache hits. The
 * `maxsize=8` eviction is unobservable: results are pure functions of the key.
 */
export const _load_config_cached = lru_cache(
  (config_path: string, _mtime_ns: bigint, _size: number): OcioNode | null => {
    let doc: OcioValue;
    try {
      doc = parse(decode(new Path(config_path).read_bytes(), "utf-8"), {
        ..._OcioLoader.options,
      });
    } catch (e) {
      // `except (OSError, yaml.YAMLError)`; node fs errors carry a `code`.
      if (!(e instanceof OSError || e instanceof YAMLError || (e instanceof Error && "code" in e && py_bool(e.code)))) {
        throw e;
      }
      return null;
    }
    if (_has_unhashable_key(doc)) return null;
    return doc instanceof Map ? doc : null;
  },
);

/** `(mtime_ns, size)` cache key for `config_path`, or `null` if unreadable. */
export function _config_stamp(config_path: Path): [bigint, number] | null {
  let st: host.HostBigStats;
  try {
    st = host.fs.statSync(config_path.path, { bigint: true });
  } catch (e) {
    // `except OSError`: node fs errors carry a `code`.
    if (!(e instanceof Error && "code" in e && py_bool(e.code))) throw e;
    return null;
  }
  return [st.mtimeNs, Number(st.size)];
}

/**
 * Parse a `.ocio` config, or `null` if it cannot be read or parsed.
 *
 * Memoized on `(path, mtime, size)`: parsing a real config is expensive
 * (~350ms for AE's bundled ACES 1.2) and every color-space read and write
 * resolves through it, so a project with several output modules would
 * otherwise re-parse the same unchanged file once per access. The stamp
 * keeps an edited config from going stale.
 *
 * The returned Map is shared with every other caller - treat it as
 * read-only.
 */
export function _load_config(config_path: Path): OcioNode | null {
  const stamp = _config_stamp(config_path);
  if (stamp == null) return null;
  return _load_config_cached(config_path.path, stamp[0], stamp[1]);
}

/**
 * Return the active color-space names declared in a `.ocio` config.
 *
 * Collects `colorspaces[].name` and `display_colorspaces[].name`, dropping any
 * listed in `inactive_colorspaces`. Returns `[]` if the file cannot be read or
 * parsed.
 *
 * @param config_path - Path to a `.ocio` configuration file.
 */
export function list_config_color_spaces(config_path: Path): string[] {
  const doc = _load_config(config_path);
  if (doc == null) return [];
  const names: string[] = [];
  for (const key of ["colorspaces", "display_colorspaces"] as const) {
    for (const entry of py_iter(py_or(doc.get(key), []))) {
      if (entry instanceof Map) {
        const name = entry.get("name") ?? null;
        if (typeof name === "string") names.push(name);
      }
    }
  }
  // `set(...)`: a list, dict or set member is unhashable.
  const inactive = new Set<OcioValue>();
  for (const n of py_iter(py_or(doc.get("inactive_colorspaces"), []))) {
    if (Array.isArray(n) || n instanceof Map || n instanceof Set) {
      throw new TypeError_(`unhashable type: '${type_name(n)}'`);
    }
    inactive.add(n);
  }
  // A name may appear in both `colorspaces` and `display_colorspaces`;
  // getColorSpaceNames() returns a unique set, so de-duplicate (order kept).
  const seen = new Set<string>();
  const result: string[] = [];
  for (const n of names) {
    if (inactive.has(n) || seen.has(n)) continue;
    seen.add(n);
    result.push(n);
  }
  return result;
}

/**
 * Resolve an `ocio_configuration_file` value to a `.ocio` path.
 *
 * Accepts either a filesystem path or a built-in config name (e.g.
 * `"ACES 1.2"`), which After Effects ships under
 * `<install>/Support Files/OpenColorIO-Configs/<name>/`.
 *
 * @param config - The `ocio_configuration_file` value.
 * @returns The resolved `.ocio` path, or `null` if it cannot be located.
 */
export function resolve_ocio_config(config: string): Path | null {
  if (!config) return null;
  const direct = new Path(config);
  if (direct.is_file()) return direct;
  for (const root of _builtin_config_roots()) {
    const config_dir = root.div(config);
    if (config_dir.is_dir()) {
      const ocio_files = sorted(config_dir.glob("*.ocio"), (p: Path) => p.path);
      if (ocio_files.length > 0) return ocio_files[0];
    }
  }
  return null;
}

/**
 * Resolve an `ocio_configuration_file` value, raising if that fails.
 *
 * The config is REQUIRED for envelope/id computation: the stored bytes
 * depend on whether the name is a direct colorspace, a role/alias, or a
 * `display/view` pair, and only the config can tell those apart.
 *
 * @param config - The project's `ocio_configuration_file` value (`null` when
 *   there is no project to read it from).
 * @param purpose - Completes the error message, e.g.
 *   `"build the color-profile envelope for 'ACEScg'"`.
 *
 * @throws ValueError If the configuration cannot be located.
 */
export function require_ocio_config(config: string | null, purpose: string): Path {
  const resolved = config != null ? resolve_ocio_config(config) : null;
  if (resolved == null) {
    throw new ValueError(
      `Cannot resolve the project's OCIO configuration (${repr(config)}), ` +
        `which is needed to ${purpose}.`,
    );
  }
  return resolved;
}

/**
 * Candidate `OpenColorIO-Configs` directories in standard AE installs.
 *
 * Cached for the process: listing the installs takes ~2ms, and an import
 * into an OCIO project resolves the config once per file (every layer of
 * a layered PSD), so an install added while it runs goes unseen.
 */
export const _builtin_config_roots = lru_cache((): Path[] => {
  // `platform.system() == "Windows"` -> `host.platform === "win32"`; macOS otherwise.
  const bases =
    host.platform === "win32"
      ? [new Path("C:\\Program Files\\Adobe"), new Path("C:\\Program Files (x86)\\Adobe")]
      : [new Path("/Applications")];
  const roots: Path[] = [];
  for (const base of bases) {
    if (!base.is_dir()) continue;
    // Newest install first, by release year: a plain name sort would put
    // "Adobe After Effects CC 2019" before "Adobe After Effects 2026"
    // ("C" > "2"). Year-less installs (CS6, bare CC) sort last.
    for (const ae_dir of sorted(base.glob("Adobe After Effects *"), _install_year, true)) {
      roots.push(ae_dir.div("Support Files", "OpenColorIO-Configs"));
    }
  }
  return roots;
});

/** Sort key for an install directory: its release year, then its name. */
export function _install_year(install_dir: Path): [number, string] {
  const match = re_search(String.raw`(\d{4})`, install_dir.name);
  return [match ? int(match[1]) : 0, install_dir.name];
}

/** `baseProfileType` for an OCIO color space (see `color/envelope.py`). */
export const _OCIO_PROFILE_TYPE = 3;

/**
 * The 16-byte After Effects `Guid` of an OCIO color space.
 *
 * Two-stage MurmurHash3: the inner `ColorProfile` Guid hashes the display
 * name + the `colorProfileData` JSON; the outer `ColorSpace` Guid wraps that
 * with the `baseProfileType` and a flag byte.
 *
 * @param profile_name - The `colorProfileName` (e.g. `"ACES/ACEScg yo"`).
 * @param profile_data - The `colorProfileData` JSON (e.g. `{"colorSpace1":"ACEScg yo"}`).
 */
export function _color_space_guid(profile_name: string, profile_data: string): Uint8Array {
  const inner = ae_guid(
    concat(b("DVAColorProfile"), encode(profile_name, "utf-8"), encode(profile_data, "utf-8")),
  );
  return ae_guid(
    concat(
      b("DVAColorSpace"),
      inner,
      bytes_.int_to_bytes(_OCIO_PROFILE_TYPE, 4, "little"),
      b("\x00"),
    ),
  );
}

/** A `.ocio` config indexed for output-color-space resolution (`NamedTuple`). */
export class _ConfigIndex {
  // A family is whatever the config gives (`cs.get("family") or ""`), and a
  // role or display is whatever YAML key names it.
  constructor(
    readonly families: Map<string, OcioValue>, // color-space name -> family
    readonly aliases: Map<string, OcioValue>, // alias name -> family of its color space
    readonly roles: Map<OcioValue, string>, // role -> target name
    readonly displays: Map<OcioValue, string[]>, // display -> its view names
  ) {}

  /** Tuple unpacking: `families, aliases, roles, displays = index`. */
  *[Symbol.iterator](): Generator<Map<string, OcioValue> | Map<OcioValue, string> | Map<OcioValue, string[]>> {
    yield this.families;
    yield this.aliases;
    yield this.roles;
    yield this.displays;
  }
}

/**
 * Index a `.ocio` config for output-color-space resolution.
 *
 * Memoized like `_load_config` (same stamp scheme): every color-space read
 * and write needs the index, and rebuilding it walks the whole config. The
 * returned index is shared with every other caller - treat it as read-only.
 */
export function _config_index(config_path: Path): _ConfigIndex {
  const stamp = _config_stamp(config_path);
  if (stamp == null) return new _ConfigIndex(new Map(), new Map(), new Map(), new Map());
  return _config_index_cached(config_path.path, stamp[0], stamp[1]);
}

/** Memoized body of `_config_index` (`@lru_cache(maxsize=8)`; see `_load_config_cached` TODO). */
export const _config_index_cached = lru_cache(
  (config_path: string, mtime_ns: bigint, size: number): _ConfigIndex => {
    const doc = _load_config_cached(config_path, mtime_ns, size);
    if (doc == null) return new _ConfigIndex(new Map(), new Map(), new Map(), new Map());
    const families = new Map<string, OcioValue>();
    const aliases = new Map<string, OcioValue>();
    for (const key of ["colorspaces", "display_colorspaces"] as const) {
      for (const cs of py_iter(py_or(doc.get(key), []))) {
        if (!(cs instanceof Map)) continue;
        const name = cs.get("name");
        if (typeof name === "string") {
          const family = py_or(cs.get("family"), "");
          families.set(name, family);
          for (const alias of py_iter(py_or(cs.get("aliases"), []))) {
            if (typeof alias === "string") aliases.set(alias, family);
          }
        }
      }
    }
    const roles = new Map<OcioValue, string>();
    for (const [r, t] of _items(py_or(doc.get("roles"), new Map<OcioValue, OcioValue>()))) {
      if (typeof t === "string") roles.set(r, t);
    }
    const displays = new Map<OcioValue, string[]>();
    for (const [display, items] of _items(py_or(doc.get("displays"), new Map<OcioValue, OcioValue>()))) {
      const views: string[] = [];
      for (const item of py_iter(py_or(items, []))) {
        // `!<Views> [name, ..]` (shared views) or `!<View> {name: ..}`; the
        // OCIO loader strips the tags to a list or a dict respectively.
        if (Array.isArray(item)) {
          for (const v of item) if (typeof v === "string") views.push(v);
        } else if (item instanceof Map) {
          const view = item.get("name");
          if (typeof view === "string") views.push(view);
        }
      }
      displays.set(display, views);
    }
    return new _ConfigIndex(families, aliases, roles, displays);
  },
);

/** Python `x.items()` on a config value: `AttributeError` when it is not a dict. */
export function _items(x: OcioValue): [OcioValue, OcioValue][] {
  if (x instanceof Map) return [...x];
  throw new AttributeError(`'${type_name(x)}' object has no attribute 'items'`);
}

/**
 * Resolve `color_space` to `(colorProfileName, colorProfileData)` - the
 * envelope After Effects hashes for an OCIO output color space.
 *
 * Handles the four selection kinds (each verified byte-exact against
 * AE-authored samples):
 *
 * - a direct color space (or display color space): `family/name`,
 *   `colorProfileData` = `{"colorSpace1": name}`.
 * - a role: the role's target name, `{"colorSpace1": target, "ocioColorSpaceType": 2}`.
 * - an alias: the alias name, `{"colorSpace1": alias, "ocioColorSpaceType": 2}`.
 * - a `display/view` pair: `{"colorSpace1": display, "colorSpace2": view, "ocioColorSpaceType": 1}`.
 *
 * @throws ValueError If `color_space` is not found in the config.
 */
export function _output_envelope(index: _ConfigIndex, color_space: OcioValue): [string, string] {
  // Only a string can be a color-space or alias name; any YAML key a role.
  if (typeof color_space === "string" && index.families.has(color_space)) {
    const family = getitem(index.families, color_space);
    const name = py_bool(family) ? `${str(family)}/${color_space}` : color_space;
    return [name, _compact({ colorSpace1: color_space })];
  }
  if (index.roles.has(color_space)) {
    const target = getitem(index.roles, color_space);
    return [target, _compact({ colorSpace1: target, ocioColorSpaceType: 2 })];
  }
  if (typeof color_space === "string" && index.aliases.has(color_space)) {
    return [color_space, _compact({ colorSpace1: color_space, ocioColorSpaceType: 2 })];
  }
  if (typeof color_space !== "string") {
    // `"/" in color_space`: unreachable (a non-string name is a role key), but it is what Python would raise.
    throw new TypeError_(`argument of type '${type_name(color_space)}' is not iterable`);
  }
  if (color_space.includes("/")) {
    const i = color_space.lastIndexOf("/"); // `rsplit("/", 1)`
    const display = color_space.slice(0, i);
    const view = color_space.slice(i + 1);
    // The view must really be one of that display's: a config can name a
    // display after a family (ACES 1.2's only display is `ACES`, which is
    // also the family of `ACES - ACEScg`), and matching on the display
    // alone would claim the `family/name` form the getters return.
    if ((index.displays.get(display) ?? []).includes(view)) {
      return [
        color_space,
        _compact({ colorSpace1: display, colorSpace2: view, ocioColorSpaceType: 1 }),
      ];
    }
  }
  throw new ValueError(`${repr(color_space)} is not a color space in the OCIO config`);
}

/**
 * Yield every assignable OCIO output color-space name (color spaces,
 * aliases, roles, and `display/view` pairs).
 */
export function* _iter_output_color_spaces(index: _ConfigIndex): Generator<OcioValue> {
  yield* index.families.keys();
  yield* index.aliases.keys();
  yield* index.roles.keys();
  for (const [display, views] of index.displays) {
    for (const view of views) yield `${str(display)}/${view}`;
  }
}

/**
 * `Guid` -\> name for every assignable output color space in the config.
 *
 * Keys are `tkey(guid)` strings: a `Uint8Array` key would compare by identity
 * in a `Map`, the same way a Python `bytes` key compares by value.
 */
export const _guid_table_cached = lru_cache(
  (config_path: string, mtime_ns: bigint, size: number): Map<string, OcioValue> => {
    const index = _config_index_cached(config_path, mtime_ns, size);
    const table = new Map<string, OcioValue>();
    for (const color_space of _iter_output_color_spaces(index)) {
      const [name, data] = _output_envelope(index, color_space);
      // Two names can resolve to the same envelope (e.g. two roles sharing
      // a target); keep the first, like the linear scan this table replaces.
      setdefault(table, tkey(_color_space_guid(name, data)), color_space);
    }
    return table;
  },
);

/**
 * Reverse-map a 16-byte `output_profile_id` to its OCIO color-space name.
 *
 * Returns `null` if no assignable color space in the config produces
 * `profile_id`. The `Guid` of every candidate (~600 two-stage MurmurHash3
 * computations for AE's bundled ACES 1.2) is memoized per config like
 * `_load_config`, so repeated reads are dict lookups.
 *
 * @param config_path - The resolved `.ocio` config path.
 * @param profile_id - The 16-byte output profile id from the output module.
 */
export function ocio_color_space_for_profile_id(
  config_path: Path,
  profile_id: Uint8Array,
): string | null {
  const stamp = _config_stamp(config_path);
  if (stamp == null) return null;
  const name = _guid_table_cached(config_path.path, stamp[0], stamp[1]).get(tkey(profile_id)) ?? null;
  // NOTE(port): Python hands back a non-string role key (`roles: {3: x}`) as
  // is; the `str`-typed `OutputModule.outputColorSpace` gets its `str()`.
  if (typeof name === "string") return name;
  return name == null ? null : str(name);
}

/**
 * The color-profile envelope After Effects stores for an OCIO color space.
 *
 * The envelope's `(colorProfileName, colorProfileData)` pair depends on the
 * SELECTION KIND, not on the slot it is stored in nor the AE version: the
 * project working space uses exactly the same four kinds as an output color
 * space (see `_output_envelope`). Verified against AE-authored samples: a
 * direct colorspace pick (`ACEScg yo`, family `ACES`) stores
 * `colorProfileName="ACES/ACEScg yo"` with `{"colorSpace1":"ACEScg yo"}`,
 * while a role pick (`mari_int16`) stores `colorProfileName="sRGB (mari_int16)"` with `{...,"ocioColorSpaceType":2}` - and AE 25.6 and
 * 26.3 write byte-identical envelopes for the same pick.
 *
 * Accepts the qualified `"<family>/<name>"` form as well as the bare
 * color-space name, because that qualified form is what AE stores as
 * `colorProfileName` and therefore what `Project.workingSpace` reads back -
 * without this, assigning a project its own working space would raise.
 *
 * @param config_path - The resolved `.ocio` config path.
 * @param color_space - The color-space, role, alias, `display/view`, or
 *   `family/color-space` name.
 *
 * @throws ValueError If `color_space` is not found in the config.
 */
export function ocio_color_profile_envelope(config_path: Path, color_space: string): string {
  const index = _config_index(config_path);
  let name: string;
  let data: string;
  try {
    [name, data] = _output_envelope(index, color_space);
  } catch (e) {
    if (!(e instanceof ValueError)) throw e;
    // `family, _, bare = color_space.rpartition("/")`: no "/" gives ("", "", whole).
    const i = color_space.lastIndexOf("/");
    const family = i >= 0 ? color_space.slice(0, i) : "";
    const bare = i >= 0 ? color_space.slice(i + 1) : color_space;
    if (!family || (index.families.get(bare) ?? null) !== family) throw e;
    [name, data] = _output_envelope(index, bare);
  }
  return build_ocio_envelope(name, data);
}

/**
 * Return the 16-byte `output_profile_id` After Effects stores for an OCIO
 * output color space.
 *
 * Resolves `color_space` against the config to build the color-profile
 * envelope AE would hash (see `_output_envelope` for the four selection
 * kinds), then computes its `Guid`.
 *
 * @param config_path - The resolved `.ocio` config path.
 * @param color_space - The output color-space name to assign.
 *
 * @throws ValueError If `color_space` is not found in the config.
 */
export function ocio_output_profile_id(config_path: Path, color_space: string): Uint8Array {
  const [name, data] = _output_envelope(_config_index(config_path), color_space);
  return _color_space_guid(name, data);
}

/**
 * Whether an OCIO file rule applies to `file_path`: the `Default` rule
 * always, a `regex` rule by search, a `pattern` + `extension` rule by glob
 * (the extension case-insensitively).
 */
export function _rule_matches(rule: OcioNode, file_path: string): boolean {
  if ((rule.get("name") ?? null) === "Default") return true;
  const regex = rule.get("regex") ?? null;
  if (typeof regex === "string") {
    return re_search(regex, file_path) != null;
  }
  const pattern = rule.get("pattern") ?? null;
  const extension = rule.get("extension");
  if (typeof pattern === "string" && typeof extension === "string") {
    // `stem, dot, ext = file_path.rpartition(".")`: no "." gives ("", "", whole).
    const i = file_path.lastIndexOf(".");
    const stem = i >= 0 ? file_path.slice(0, i) : "";
    const dot = i >= 0 ? "." : "";
    const ext = i >= 0 ? file_path.slice(i + 1) : file_path;
    return (
      !!dot &&
      fnmatchcase(stem, pattern) &&
      fnmatchcase(ext.toLowerCase(), extension.toLowerCase())
    );
  }
  return false;
}

/**
 * `fnmatch.fnmatchcase(name, pat)`.
 *
 * NOTE(port): no pyrt shim for `fnmatch` (a shared one is proposed). This is a local translation of
 * `fnmatch.translate` (`*`, `?`, `[seq]`, `[!seq]`, everything else literal)
 * matched against the whole name (CPython 3.12 bracket handling).
 */
export function fnmatchcase(name: string, pat: string): boolean {
  let re_src = "";
  let i = 0;
  while (i < pat.length) {
    const c = pat[i++];
    if (c === "*") {
      re_src += ".*";
    } else if (c === "?") {
      re_src += ".";
    } else if (c === "[") {
      let j = i;
      if (j < pat.length && pat[j] === "!") j++;
      if (j < pat.length && pat[j] === "]") j++;
      while (j < pat.length && pat[j] !== "]") j++;
      if (j >= pat.length) {
        re_src += "\\[";
      } else {
        let stuff: string;
        if (!pat.slice(i, j).includes("-")) {
          stuff = pat.slice(i, j).replace(/\\/g, "\\\\");
        } else {
          const chunks: string[] = [];
          let k = pat[i] === "!" ? i + 2 : i + 1;
          while (true) {
            k = pat.indexOf("-", k);
            if (k < 0 || k >= j) break;
            chunks.push(pat.slice(i, k));
            i = k + 1;
            k = k + 3;
          }
          const chunk = pat.slice(i, j);
          if (chunk) chunks.push(chunk);
          else chunks[chunks.length - 1] += "-";
          // Remove empty ranges -- invalid in RE.
          for (let m = chunks.length - 1; m > 0; m--) {
            if (chunks[m - 1].slice(-1) > chunks[m][0]) {
              chunks[m - 1] = chunks[m - 1].slice(0, -1) + chunks[m].slice(1);
              chunks.splice(m, 1);
            }
          }
          stuff = chunks.map((x) => x.replace(/\\/g, "\\\\").replace(/-/g, "\\-")).join("-");
        }
        i = j + 1;
        if (!stuff) re_src += "(?!)";
        else if (stuff === "!") re_src += ".";
        else {
          if (stuff[0] === "!") stuff = "^" + stuff.slice(1);
          else if (stuff[0] === "^" || stuff[0] === "[") stuff = "\\" + stuff;
          re_src += `[${stuff}]`;
        }
      }
    } else {
      re_src += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^(?:${re_src})$`, "su").test(name);
}

/**
 * The color-profile envelope After Effects assigns a file it imports
 * into a project managed by this OCIO config.
 *
 * Measured on AE 2026 (ACES 1.2, ACES 1.3 CG and a studio config with an
 * extension rule): the first matching file rule decides, its color space
 * recorded as a direct pick named after the family of the color space it
 * resolves to (`"Utility/scene_linear"` with `{"colorSpace1": "scene_linear"}` for a role); a config without file rules gets its
 * `default` role, recorded as a role pick. A `ColorSpaceNamePathSearch`
 * rule is not modelled (it is skipped).
 *
 * @param config_path - The resolved `.ocio` config path.
 * @param file_path - The imported file's path.
 *
 * @returns The envelope, or `null` when no rule matches and the config has no
 *   `default` role.
 */
export function ocio_input_envelope(config_path: Path, file_path: string): string | null {
  const doc = _load_config(config_path);
  if (doc == null) return null;
  const index = _config_index(config_path);
  const rules = doc.get("file_rules") ?? null;
  if (py_bool(rules)) {
    for (const rule of py_iter(rules)) {
      if (!(rule instanceof Map) || !_rule_matches(rule, file_path)) continue;
      const color_space = rule.get("colorspace") ?? null;
      if (typeof color_space !== "string") return null;
      const target = index.roles.get(color_space) ?? color_space;
      const family = py_or(py_or(index.families.get(target) ?? null, index.aliases.get(target) ?? null), "");
      const name = py_bool(family) ? `${str(family)}/${color_space}` : color_space;
      return build_ocio_envelope(name, _compact({ colorSpace1: color_space }));
    }
    return null;
  }
  if (!index.roles.has("default")) return null;
  return build_ocio_envelope(..._output_envelope(index, "default"));
}
