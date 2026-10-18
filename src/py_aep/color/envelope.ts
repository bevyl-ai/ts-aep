/**
 * Build and parse the color-profile envelope embedded in `.aep` color chunks.
 *
 * After Effects stores each color space (project working space, display color
 * space, footage media color space) as a compact JSON envelope inside a `Utf8`
 * chunk's `.value`:
 *
 *     \{"baseColorProfile":\{"colorProfileData":"\<base64\>","colorProfileName":"\<name\>"\},"baseProfileType":\<1|2|3\>\}
 *
 * `baseProfileType`:
 *
 * - `2` = Adobe ICC: `colorProfileData` is the raw ICC profile bytes (base64),
 *   `bytes[36:40] == b"acsp"`.
 * - `3` = OCIO: `colorProfileData` is base64 of a small JSON describing the OCIO
 *   color space (single color space, or a display + view pair).
 * - `1` = display-referred tag: an 8-byte `01000000ffffffff` blob (read-only).
 *
 * This module is the single source of truth for that byte format so that
 * round-trips stay byte-identical. It is pure (`json` + `base64`); it performs no
 * I/O and imports nothing from `models/` or `binary/`.
 *
 * AE writes compact JSON (separators `,` and `:`, no whitespace) with a fixed key
 * order; reproducing it exactly is required for byte-identical output.
 */

import { encode, jsonDumps, jsonGet, jsonGetitem, jsonLoads, typeName, type JsonValue } from "../../pyrt/index.ts";
import { b64decode, b64encode } from "../../pyrt/base64.ts";

// baseProfileType values.

/** Display-referred tag (8-byte blob); read-only, not a write target. */
export const PROFILE_TYPE_TAG = 1;
/** Adobe ICC profile; `colorProfileData` is raw ICC bytes. */
export const PROFILE_TYPE_ICC = 2;
/** OCIO color space; `colorProfileData` is a small JSON. */
export const PROFILE_TYPE_OCIO = 3;

// ocioColorSpaceType values inside an OCIO `colorProfileData` JSON.

/** A display + view pair (`colorSpace1` = display, `colorSpace2` = view). */
export const OCIO_TYPE_DISPLAY = 1;
/** A single color space (`colorSpace1` only). */
export const OCIO_TYPE_COLORSPACE = 2;

/**
 * Serialize `obj` exactly as AE does: compact, no whitespace.
 *
 * `ensure_ascii=False` so a non-ASCII profile/color-space name is emitted as
 * raw UTF-8 (matching AE's `Utf8` chunk) rather than `\uXXXX` escapes, which
 * would break the byte-identical round-trip.
 */
export function _compact(obj: object): string {
  return jsonDumps(obj, { separators: [",", ":"], ensureAscii: false });
}

export function _b64(text: string): string {
  return b64encode(encode(text, "utf-8"));
}

/**
 * Wrap pre-encoded `colorProfileData` in the outer envelope.
 *
 * Key order matches AE verbatim: `baseColorProfile` (`colorProfileData` then
 * `colorProfileName`), then `baseProfileType`.
 */
export function _envelope(colorProfileDataB64: string, name: string, profileType: number): string {
  return _compact({
    baseColorProfile: {
      colorProfileData: colorProfileDataB64,
      colorProfileName: name,
    },
    baseProfileType: profileType,
  });
}

/**
 * Envelope for an OCIO color space from a resolved `(name, data)` pair.
 *
 * The pair depends on the selection KIND and so needs the `.ocio` config to
 * resolve; see
 * {@link py_aep.color.ocio.ocio_color_profile_envelope | ocio_color_profile_envelope},
 * which is what callers should use. This function is the pure byte-format
 * half, kept here with the rest of the envelope spec.
 *
 * @param profileName - The `colorProfileName` (e.g. `"ACES/ACEScg yo"`).
 * @param profileData - The `colorProfileData` JSON (e.g. `{"colorSpace1":"ACEScg yo"}`).
 */
export function buildOcioEnvelope(profileName: string, profileData: string): string {
  return _envelope(_b64(profileData), profileName, PROFILE_TYPE_OCIO);
}

/**
 * Envelope for an OCIO color space selected by ROLE or ALIAS.
 *
 * `colorProfileName` is the role's target (or the alias) itself, and the
 * data carries `ocioColorSpaceType: 2`.
 *
 * **Warning:** This is only one of the four selection kinds. A DIRECT colorspace
 * pick uses `colorProfileName = "<family>/<name>"` and omits
 * `ocioColorSpaceType` - passing a direct colorspace name here
 * produces an envelope AE would not write. Prefer
 * {@link py_aep.color.ocio.ocio_color_profile_envelope | ocio_color_profile_envelope},
 * which resolves the kind against the config.
 *
 * @param colorspace - The OCIO role target or alias name.
 */
export function buildOcioColorspaceEnvelope(colorspace: string): string {
  const inner = _compact({ colorSpace1: colorspace, ocioColorSpaceType: OCIO_TYPE_COLORSPACE });
  return _envelope(_b64(inner), colorspace, PROFILE_TYPE_OCIO);
}

/**
 * Envelope for an OCIO display color space (a display + view pair).
 *
 * `colorProfileName` is `"<display>/<view>"`.
 *
 * @param display - The OCIO display name (e.g. `"sRGB - Display"`).
 * @param view - The OCIO view name (e.g. `"ACES 1.0 - SDR Video"`).
 */
export function buildOcioDisplayEnvelope(display: string, view: string): string {
  const inner = _compact({
    colorSpace1: display,
    colorSpace2: view,
    ocioColorSpaceType: OCIO_TYPE_DISPLAY,
  });
  return _envelope(_b64(inner), `${display}/${view}`, PROFILE_TYPE_OCIO);
}

/**
 * Envelope for an Adobe ICC color space.
 *
 * Used for the project working/display space and footage media color space in
 * Adobe CMS mode.
 *
 * @param name - The profile description (e.g. `"ProPhoto RGB"`).
 * @param iccBytes - The raw ICC profile bytes to embed.
 */
export function buildIccEnvelope(name: string, iccBytes: Uint8Array): string {
  return _envelope(b64encode(iccBytes), name, PROFILE_TYPE_ICC);
}

/** A decoded color-profile envelope. */
export class ColorProfile {
  /** `colorProfileName` (e.g. `"ACEScg"`, `"ACES/sRGB"`, `"ProPhoto RGB"`). */
  readonly name: string;

  /** `baseProfileType`: one of `PROFILE_TYPE_TAG/ICC/OCIO`. */
  readonly profileType: number;

  /** Decoded `colorProfileData`: raw ICC bytes, OCIO JSON bytes, or tag blob. */
  readonly data: Uint8Array;

  constructor(name: string, profileType: number, data: Uint8Array) {
    this.name = name;
    this.profileType = profileType;
    this.data = data;
  }

  *[Symbol.iterator](): Generator<string | number | Uint8Array> {
    yield this.name;
    yield this.profileType;
    yield this.data;
  }

  /** Whether this is an OCIO profile (`baseProfileType == 3`). */
  get isOcio(): boolean {
    return this.profileType === PROFILE_TYPE_OCIO;
  }

  /** Whether this is an Adobe ICC profile (`baseProfileType == 2`). */
  get isIcc(): boolean {
    return this.profileType === PROFILE_TYPE_ICC;
  }

  /** The OCIO `(colorSpace1[, colorSpace2])` names, or an empty array if not OCIO. */
  get ocioColorSpaces(): readonly string[] {
    if (!this.isOcio) return [];
    const inner = jsonLoads(this.data);
    const names = [jsonGetitem(inner, "colorSpace1")];
    if (inner instanceof Map && inner.has("colorSpace2")) names.push(jsonGetitem(inner, "colorSpace2"));
    return names.map((name) => _envelopeString(name, "OCIO color space"));
  }
}

/**
 * An envelope field `ColorProfile` holds as text. py_aep stores whatever the
 * JSON holds; a non-string here only comes from a corrupt envelope, and fails
 * at the read instead of later.
 */
function _envelopeString(value: JsonValue, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a str, not '${typeName(value)}'`);
  return value;
}

/**
 * Decode a color-profile envelope `Utf8` value into a `ColorProfile`.
 *
 * @param envelopeJson - The raw `Utf8` chunk value (the outer JSON string).
 */
export function parseEnvelope(envelopeJson: string): ColorProfile {
  const outer = jsonLoads(envelopeJson);
  const base = jsonGetitem(outer, "baseColorProfile");
  const name = jsonGetitem(base, "colorProfileName");
  const profileType = jsonGetitem(outer, "baseProfileType");
  const data = jsonGetitem(base, "colorProfileData");
  if (typeof profileType !== "number") throw new TypeError(`baseProfileType must be an int, not '${typeName(profileType)}'`);
  return new ColorProfile(_envelopeString(name, "colorProfileName"), profileType, b64decode(_envelopeString(data, "colorProfileData")));
}


/**
 * The envelope's `colorProfileName`, or `"None"` when the envelope is
 * empty (`{}`, e.g. an unset `pdvc` display chunk) or carries no name.
 *
 * Unlike `parseEnvelope`, this does not require `colorProfileData`.
 */
export function envelopeProfileName(envelopeJson: string): string {
  const outer = jsonLoads(envelopeJson);
  return String(jsonGet(jsonGet(outer, "baseColorProfile", new Map<string, JsonValue>()), "colorProfileName", "None"));
}
