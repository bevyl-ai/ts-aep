/**
 * Enumerate the color spaces of an OCIO configuration.
 *
 * Backs `Project.listColorProfiles()` in OCIO mode: given the project's
 * `ocioConfigurationFile` (a `.ocio` path or a built-in config name like
 * `"ACES 1.2"`), return the assignable color-space names.
 *
 * The list is the OCIO *active* color spaces (`colorspaces` +
 * `display_colorspaces`, minus `inactive_colorspaces`) - exactly what
 * `PyOpenColorIO.Config.getColorSpaceNames()` returns (verified set-equal for
 * AE's bundled `ACES 1.2` (353)), so no OCIO runtime dependency is needed.
 */

import * as host from "../../pyrt/host.ts";
import { dep } from "../../pyrt/deps.ts";
import type { DocumentOptions, ParseOptions, SchemaOptions, ToJSOptions } from "yaml";
import {
  Path,
  lruCache,
  AttributeError,
  OSError,
  ValueError,
  getOrThrow,
  truthy,
  typeName,
  truthyOr,
  compositeKey,
  getOrInsert,
  literal,
  concat,
  Bytes,
  compare,
  ascii,
} from "../../pyrt/index.ts";
import { _compact, buildOcioEnvelope } from "./envelope.ts";
import { aeGuid } from "./murmur3.ts";

/**
 * `class _OcioLoader(yaml.SafeLoader)`: a YAML loader that ignores OCIO's custom tags.
 *
 * yaml (npm) has no loader subclasses, so the loader is represented by the
 * parse options PyYAML's `SafeLoader` implies: YAML 1.1 resolution (`yes`/`on`
 * booleans, merge keys), no duplicate-key error and no alias-count cap.
 */
class _OcioLoader {
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
type OcioValue = string | number | boolean | null | Date | Uint8Array | OcioValue[] | Set<OcioValue> | OcioNode;

/** An OCIO mapping. Its keys are YAML values too (`3: x`, `~: x`), not only strings. */
interface OcioNode extends Map<OcioValue, OcioValue> {}

/** A YAML list field (`colorspaces`, `aliases`, `file_rules`, ...); anything else reads as empty. */
function listOf(value: OcioValue | undefined): OcioValue[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Whether `value` holds a list, dict or set as a mapping key or set member.
 *
 * PyYAML refuses one ("found unhashable key", a `YAMLError`), so
 * Python's `_loadConfigCached` returns `null` for such a config; `yaml`
 * (npm) builds it. `seen` guards the cycles anchors can build.
 */
function _hasUnhashableKey(value: OcioValue, seen: Set<OcioValue> = new Set()): boolean {
  if (!(Array.isArray(value) || value instanceof Map || value instanceof Set) || seen.has(value)) return false;
  seen.add(value);
  const unhashable = (x: OcioValue): boolean => Array.isArray(x) || x instanceof Map || x instanceof Set;
  if (value instanceof Map) {
    for (const [k, v] of value) {
      if (unhashable(k) || _hasUnhashableKey(v, seen)) return true;
    }
    return false;
  }
  for (const item of value) {
    if ((value instanceof Set && unhashable(item)) || _hasUnhashableKey(item, seen)) return true;
  }
  return false;
}

/**
 * `@lru_cache(maxsize=8) def _load_config_cached(config_path, _stamp)`.
 *
 * Parses a `.ocio` file and returns its top-level mapping, or `null` if it
 * cannot be read or parsed.
 *
 * Pyrt `lruCache` keys object arguments by identity and never
 * evicts, so the cached functions in this module take primitives
 * (path string, `mtimeNs` bigint, `size`) to get real cache hits. The
 * `maxsize=8` eviction is unobservable: results are pure functions of the key.
 */
const _loadConfigCached = lruCache((configPath: string, _mtimeNs: bigint, _size: number): OcioNode | null => {
  let doc: OcioValue;
  try {
    doc = dep("yaml").parse(new TextDecoder().decode(new Path(configPath).readBytes()), {
      ..._OcioLoader.options,
    });
  } catch (e) {
    // `except (OSError, yaml.YAMLError)`; node fs errors carry a `code`.
    if (
      !(
        e instanceof OSError ||
        e instanceof dep("yaml").YAMLError ||
        (e instanceof Error && "code" in e && truthy(e.code))
      )
    ) {
      throw e;
    }
    return null;
  }
  if (_hasUnhashableKey(doc)) return null;
  return doc instanceof Map ? doc : null;
});

/** `(mtime_ns, size)` cache key for `configPath`, or `null` if unreadable. */
function _configStamp(configPath: Path): [bigint, number] | null {
  let st: host.HostBigStats;
  try {
    st = host.fs.statSync(configPath.path, { bigint: true });
  } catch (e) {
    // `except OSError`: node fs errors carry a `code`.
    if (!(e instanceof Error && "code" in e && truthy(e.code))) throw e;
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
function _loadConfig(configPath: Path): OcioNode | null {
  const stamp = _configStamp(configPath);
  if (stamp == null) return null;
  return _loadConfigCached(configPath.path, stamp[0], stamp[1]);
}

/**
 * Return the active color-space names declared in a `.ocio` config.
 *
 * Collects `colorspaces[].name` and `display_colorspaces[].name`, dropping any
 * listed in `inactive_colorspaces`. Returns `[]` if the file cannot be read or
 * parsed.
 *
 * @param configPath - Path to a `.ocio` configuration file.
 */
export function listConfigColorSpaces(configPath: Path): string[] {
  const doc = _loadConfig(configPath);
  if (doc == null) return [];
  const names: string[] = [];
  for (const key of ["colorspaces", "display_colorspaces"] as const) {
    for (const entry of listOf(doc.get(key))) {
      if (entry instanceof Map) {
        const name = entry.get("name") ?? null;
        if (typeof name === "string") names.push(name);
      }
    }
  }
  // `set(...)`: a list, dict or set member is unhashable.
  const inactive = new Set<OcioValue>();
  for (const n of listOf(doc.get("inactive_colorspaces"))) {
    if (Array.isArray(n) || n instanceof Map || n instanceof Set) {
      throw new TypeError(`unhashable type: '${typeName(n)}'`);
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
 * Resolve an `ocioConfigurationFile` value to a `.ocio` path.
 *
 * Accepts either a filesystem path or a built-in config name (e.g.
 * `"ACES 1.2"`), which After Effects ships under
 * `<install>/Support Files/OpenColorIO-Configs/<name>/`.
 *
 * @param config - The `ocioConfigurationFile` value.
 * @returns The resolved `.ocio` path, or `null` if it cannot be located.
 */
export function resolveOcioConfig(config: string): Path | null {
  if (!config) return null;
  const direct = new Path(config);
  if (direct.isFile()) return direct;
  for (const root of _builtinConfigRoots()) {
    const configDir = root.div(config);
    if (configDir.isDir()) {
      const ocioFiles = [...configDir.glob("*.ocio")].sort((a, b) => compare(a.path, b.path));
      if (ocioFiles.length > 0) return ocioFiles[0];
    }
  }
  return null;
}

/**
 * Resolve an `ocioConfigurationFile` value, raising if that fails.
 *
 * The config is REQUIRED for envelope/id computation: the stored bytes
 * depend on whether the name is a direct colorspace, a role/alias, or a
 * `display/view` pair, and only the config can tell those apart.
 *
 * @param config - The project's `ocioConfigurationFile` value (`null` when
 *   there is no project to read it from).
 * @param purpose - Completes the error message, e.g.
 *   `"build the color-profile envelope for 'ACEScg'"`.
 *
 * @throws InvalidValueError If the configuration cannot be located.
 */
export function requireOcioConfig(config: string | null, purpose: string): Path {
  const resolved = config != null ? resolveOcioConfig(config) : null;
  if (resolved == null) {
    throw new ValueError(
      `Cannot resolve the project's OCIO configuration (${literal(config)}), ` + `which is needed to ${purpose}.`,
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
const _builtinConfigRoots = lruCache((): Path[] => {
  // `platform.system() == "Windows"` -> `host.platform === "win32"`; macOS otherwise.
  const bases =
    host.platform === "win32"
      ? [new Path("C:\\Program Files\\Adobe"), new Path("C:\\Program Files (x86)\\Adobe")]
      : [new Path("/Applications")];
  const roots: Path[] = [];
  for (const base of bases) {
    if (!base.isDir()) continue;
    // Newest install first, by release year: a plain name sort would put
    // "Adobe After Effects CC 2019" before "Adobe After Effects 2026"
    // ("C" > "2"). Year-less installs (CS6, bare CC) sort last.
    for (const aeDir of [...base.glob("Adobe After Effects *")].sort((a, b) =>
      compare(_installYear(b), _installYear(a)),
    )) {
      roots.push(aeDir.div("Support Files", "OpenColorIO-Configs"));
    }
  }
  return roots;
});

/** Sort key for an install directory: its release year, then its name. */
function _installYear(installDir: Path): [number, string] {
  const match = /(\d{4})/.exec(installDir.name);
  return [match ? Number.parseInt(match[1], 10) : 0, installDir.name];
}

/** `baseProfileType` for an OCIO color space (see `color/envelope.py`). */
const _OCIO_PROFILE_TYPE = 3;

/**
 * The 16-byte After Effects `Guid` of an OCIO color space.
 *
 * Two-stage MurmurHash3: the inner `ColorProfile` Guid hashes the display
 * name + the `colorProfileData` JSON; the outer `ColorSpace` Guid wraps that
 * with the `baseProfileType` and a flag byte.
 *
 * @param profileName - The `colorProfileName` (e.g. `"ACES/ACEScg yo"`).
 * @param profileData - The `colorProfileData` JSON (e.g. `{"colorSpace1":"ACEScg yo"}`).
 */
function _colorSpaceGuid(profileName: string, profileData: string): Uint8Array {
  const inner = aeGuid(
    concat(ascii("DVAColorProfile"), new TextEncoder().encode(profileName), new TextEncoder().encode(profileData)),
  );
  return aeGuid(
    concat(ascii("DVAColorSpace"), inner, Bytes.intToBytes(_OCIO_PROFILE_TYPE, 4, "little"), new Uint8Array(1)),
  );
}

/** A `.ocio` config indexed for output-color-space resolution (`NamedTuple`). */
class _ConfigIndex {
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
 * Memoized like `_loadConfig` (same stamp scheme): every color-space read
 * and write needs the index, and rebuilding it walks the whole config. The
 * returned index is shared with every other caller - treat it as read-only.
 */
function _configIndex(configPath: Path): _ConfigIndex {
  const stamp = _configStamp(configPath);
  if (stamp == null) return new _ConfigIndex(new Map(), new Map(), new Map(), new Map());
  return _configIndexCached(configPath.path, stamp[0], stamp[1]);
}

/** Memoized body of `_configIndex` (`@lru_cache(maxsize=8)`; see `_loadConfigCached` TODO). */
const _configIndexCached = lruCache((configPath: string, mtimeNs: bigint, size: number): _ConfigIndex => {
  const doc = _loadConfigCached(configPath, mtimeNs, size);
  if (doc == null) return new _ConfigIndex(new Map(), new Map(), new Map(), new Map());
  const families = new Map<string, OcioValue>();
  const aliases = new Map<string, OcioValue>();
  for (const key of ["colorspaces", "display_colorspaces"] as const) {
    for (const cs of listOf(doc.get(key))) {
      if (!(cs instanceof Map)) continue;
      const name = cs.get("name");
      if (typeof name === "string") {
        const family = truthyOr(cs.get("family"), "");
        families.set(name, family);
        for (const alias of listOf(cs.get("aliases"))) {
          if (typeof alias === "string") aliases.set(alias, family);
        }
      }
    }
  }
  const roles = new Map<OcioValue, string>();
  for (const [r, t] of _items(truthyOr(doc.get("roles"), new Map<OcioValue, OcioValue>()))) {
    if (typeof t === "string") roles.set(r, t);
  }
  const displays = new Map<OcioValue, string[]>();
  for (const [display, items] of _items(truthyOr(doc.get("displays"), new Map<OcioValue, OcioValue>()))) {
    const views: string[] = [];
    for (const item of listOf(items)) {
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
});

/** Python `x.items()` on a config value: `AttributeError` when it is not a dict. */
function _items(x: OcioValue): [OcioValue, OcioValue][] {
  if (x instanceof Map) return [...x];
  throw new AttributeError(`'${typeName(x)}' object has no attribute 'items'`);
}

/**
 * Resolve `colorSpace` to `(colorProfileName, colorProfileData)` - the
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
 * @throws InvalidValueError If `colorSpace` is not found in the config.
 */
function _outputEnvelope(index: _ConfigIndex, colorSpace: OcioValue): [string, string] {
  // Only a string can be a color-space or alias name; any YAML key a role.
  if (typeof colorSpace === "string" && index.families.has(colorSpace)) {
    const family = getOrThrow(index.families, colorSpace);
    const name = truthy(family) ? `${String(family)}/${colorSpace}` : colorSpace;
    return [name, _compact({ colorSpace1: colorSpace })];
  }
  if (index.roles.has(colorSpace)) {
    const target = getOrThrow(index.roles, colorSpace);
    return [target, _compact({ colorSpace1: target, ocioColorSpaceType: 2 })];
  }
  if (typeof colorSpace === "string" && index.aliases.has(colorSpace)) {
    return [colorSpace, _compact({ colorSpace1: colorSpace, ocioColorSpaceType: 2 })];
  }
  if (typeof colorSpace !== "string") {
    // `"/" in color_space`: unreachable (a non-string name is a role key), but it is what Python would raise.
    throw new TypeError(`argument of type '${typeName(colorSpace)}' is not iterable`);
  }
  if (colorSpace.includes("/")) {
    const i = colorSpace.lastIndexOf("/"); // `rsplit("/", 1)`
    const display = colorSpace.slice(0, i);
    const view = colorSpace.slice(i + 1);
    // The view must really be one of that display's: a config can name a
    // display after a family (ACES 1.2's only display is `ACES`, which is
    // also the family of `ACES - ACEScg`), and matching on the display
    // alone would claim the `family/name` form the getters return.
    if ((index.displays.get(display) ?? []).includes(view)) {
      return [colorSpace, _compact({ colorSpace1: display, colorSpace2: view, ocioColorSpaceType: 1 })];
    }
  }
  throw new ValueError(`${literal(colorSpace)} is not a color space in the OCIO config`);
}

/**
 * Yield every assignable OCIO output color-space name (color spaces,
 * aliases, roles, and `display/view` pairs).
 */
function* _iterOutputColorSpaces(index: _ConfigIndex): Generator<OcioValue> {
  yield* index.families.keys();
  yield* index.aliases.keys();
  yield* index.roles.keys();
  for (const [display, views] of index.displays) {
    for (const view of views) yield `${String(display)}/${view}`;
  }
}

/**
 * `Guid` -\> name for every assignable output color space in the config.
 *
 * Keys are `compositeKey(guid)` strings: a `Uint8Array` key would compare by identity
 * in a `Map`, the same way a Python `bytes` key compares by value.
 */
const _guidTableCached = lruCache((configPath: string, mtimeNs: bigint, size: number): Map<string, OcioValue> => {
  const index = _configIndexCached(configPath, mtimeNs, size);
  const table = new Map<string, OcioValue>();
  for (const colorSpace of _iterOutputColorSpaces(index)) {
    const [name, data] = _outputEnvelope(index, colorSpace);
    // Two names can resolve to the same envelope (e.g. two roles sharing
    // a target); keep the first, like the linear scan this table replaces.
    getOrInsert(table, compositeKey(_colorSpaceGuid(name, data)), colorSpace);
  }
  return table;
});

/**
 * Reverse-map a 16-byte `outputProfileId` to its OCIO color-space name.
 *
 * Returns `null` if no assignable color space in the config produces
 * `profileId`. The `Guid` of every candidate (~600 two-stage MurmurHash3
 * computations for AE's bundled ACES 1.2) is memoized per config like
 * `_loadConfig`, so repeated reads are dict lookups.
 *
 * @param configPath - The resolved `.ocio` config path.
 * @param profileId - The 16-byte output profile id from the output module.
 */
export function ocioColorSpaceForProfileId(configPath: Path, profileId: Uint8Array): string | null {
  const stamp = _configStamp(configPath);
  if (stamp == null) return null;
  const name = _guidTableCached(configPath.path, stamp[0], stamp[1]).get(compositeKey(profileId)) ?? null;
  // Python hands back a non-string role key (`roles: {3: x}`) as
  // is; the `str`-typed `OutputModule.outputColorSpace` gets its `str()`.
  if (typeof name === "string") return name;
  return name == null ? null : String(name);
}

/**
 * The color-profile envelope After Effects stores for an OCIO color space.
 *
 * The envelope's `(colorProfileName, colorProfileData)` pair depends on the
 * SELECTION KIND, not on the slot it is stored in nor the AE version: the
 * project working space uses exactly the same four kinds as an output color
 * space (see `_outputEnvelope`). Verified against AE-authored samples: a
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
 * @param configPath - The resolved `.ocio` config path.
 * @param colorSpace - The color-space, role, alias, `display/view`, or
 *   `family/color-space` name.
 *
 * @throws InvalidValueError If `colorSpace` is not found in the config.
 */
export function ocioColorProfileEnvelope(configPath: Path, colorSpace: string): string {
  const index = _configIndex(configPath);
  let name: string;
  let data: string;
  try {
    [name, data] = _outputEnvelope(index, colorSpace);
  } catch (e) {
    if (!(e instanceof ValueError)) throw e;
    // `family, _, bare = color_space.rpartition("/")`: no "/" gives ("", "", whole).
    const i = colorSpace.lastIndexOf("/");
    const family = i >= 0 ? colorSpace.slice(0, i) : "";
    const bare = i >= 0 ? colorSpace.slice(i + 1) : colorSpace;
    if (!family || (index.families.get(bare) ?? null) !== family) throw e;
    [name, data] = _outputEnvelope(index, bare);
  }
  return buildOcioEnvelope(name, data);
}

/**
 * Return the 16-byte `outputProfileId` After Effects stores for an OCIO
 * output color space.
 *
 * Resolves `colorSpace` against the config to build the color-profile
 * envelope AE would hash (see `_outputEnvelope` for the four selection
 * kinds), then computes its `Guid`.
 *
 * @param configPath - The resolved `.ocio` config path.
 * @param colorSpace - The output color-space name to assign.
 *
 * @throws InvalidValueError If `colorSpace` is not found in the config.
 */
export function ocioOutputProfileId(configPath: Path, colorSpace: string): Uint8Array {
  const [name, data] = _outputEnvelope(_configIndex(configPath), colorSpace);
  return _colorSpaceGuid(name, data);
}

/**
 * Whether an OCIO file rule applies to `filePath`: the `Default` rule
 * always, a `regex` rule by search, a `pattern` + `extension` rule by glob
 * (the extension case-insensitively).
 */
function _ruleMatches(rule: OcioNode, filePath: string): boolean {
  if ((rule.get("name") ?? null) === "Default") return true;
  const regex = rule.get("regex") ?? null;
  if (typeof regex === "string") {
    return new RegExp(regex).test(filePath);
  }
  const pattern = rule.get("pattern") ?? null;
  const extension = rule.get("extension");
  if (typeof pattern === "string" && typeof extension === "string") {
    // `stem, dot, ext = file_path.rpartition(".")`: no "." gives ("", "", whole).
    const i = filePath.lastIndexOf(".");
    const stem = i >= 0 ? filePath.slice(0, i) : "";
    const dot = i >= 0 ? "." : "";
    const ext = i >= 0 ? filePath.slice(i + 1) : filePath;
    return !!dot && fnmatchcase(stem, pattern) && fnmatchcase(ext.toLowerCase(), extension.toLowerCase());
  }
  return false;
}

/**
 * `fnmatch.fnmatchcase(name, pat)`.
 *
 * No pyrt shim for `fnmatch` (a shared one is proposed). This is a local translation of
 * `fnmatch.translate` (`*`, `?`, `[seq]`, `[!seq]`, everything else literal)
 * matched against the whole name (CPython 3.12 bracket handling).
 */
function fnmatchcase(name: string, pat: string): boolean {
  let reSrc = "";
  let i = 0;
  while (i < pat.length) {
    const c = pat[i++];
    if (c === "*") {
      reSrc += ".*";
    } else if (c === "?") {
      reSrc += ".";
    } else if (c === "[") {
      let j = i;
      if (j < pat.length && pat[j] === "!") j++;
      if (j < pat.length && pat[j] === "]") j++;
      while (j < pat.length && pat[j] !== "]") j++;
      if (j >= pat.length) {
        reSrc += "\\[";
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
        if (!stuff) reSrc += "(?!)";
        else if (stuff === "!") reSrc += ".";
        else {
          if (stuff[0] === "!") stuff = "^" + stuff.slice(1);
          else if (stuff[0] === "^" || stuff[0] === "[") stuff = "\\" + stuff;
          reSrc += `[${stuff}]`;
        }
      }
    } else {
      reSrc += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^(?:${reSrc})$`, "su").test(name);
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
 * @param configPath - The resolved `.ocio` config path.
 * @param filePath - The imported file's path.
 *
 * @returns The envelope, or `null` when no rule matches and the config has no
 *   `default` role.
 */
export function ocioInputEnvelope(configPath: Path, filePath: string): string | null {
  const doc = _loadConfig(configPath);
  if (doc == null) return null;
  const index = _configIndex(configPath);
  const rules = doc.get("file_rules") ?? null;
  if (truthy(rules)) {
    for (const rule of listOf(rules)) {
      if (!(rule instanceof Map) || !_ruleMatches(rule, filePath)) continue;
      const colorSpace = rule.get("colorspace") ?? null;
      if (typeof colorSpace !== "string") return null;
      const target = index.roles.get(colorSpace) ?? colorSpace;
      const family = truthyOr(truthyOr(index.families.get(target) ?? null, index.aliases.get(target) ?? null), "");
      const name = truthy(family) ? `${String(family)}/${colorSpace}` : colorSpace;
      return buildOcioEnvelope(name, _compact({ colorSpace1: colorSpace }));
    }
    return null;
  }
  if (!index.roles.has("default")) return null;
  return buildOcioEnvelope(..._outputEnvelope(index, "default"));
}
