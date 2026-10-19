// `from __future__ import annotations` and the `typing` imports are dropped:
// annotations are TypeScript types only.
import * as ET from "../../../../pyrt/etree.ts";
import {
  KeyError,
  RuntimeError,
  ValueError,
  Bytes,
  concat,
  decode,
  descriptor,
  getOrThrow,
  isdigit,
  literal,
  typeName,
  ascii,
} from "../../../../pyrt/index.ts";
import { CLAMP_DEPENDENTS } from "../../../data/output_module_rules.ts";
import {
  AudioCodec,
  AudioInterleave,
  DnxResolution,
  MPEGAudioFormat,
  MPEGAudioLayer,
  MPEGMultiplexer,
  MPEGMuxStreamCompatibility,
  MPEGProfile,
  VideoCodec,
} from "../../../enums/index.ts";
import { ChunkField } from "../../descriptors.ts";
import { _validateNumber, validateEnum, validateInt } from "../../validators.ts";
import { FormatOptionsBase } from "./base.ts";
import type { EnumHelpers } from "../../../../pyrt/enum.ts";
import type { RoptChunk } from "../../../binary/render_chunks.ts";
import type { OutputModule } from "../output_module.ts";

/** Adobe stores FPS as ticks-per-frame with a 254016000000 tick base. */
const _ADOBE_TICKS_PER_SECOND = 254016000000;

// -- Ropt body layout -------------------------------------------------------
// The body is a 34-byte header followed by the XML region. Two big-endian
// u32s in the header restate the sizes, and AE HONOURS them: it reads exactly
// `_LEN_BODY_OFFSET` bytes, so a stale value silently truncates the XML.
// Verified on all 129 AE-authored XML modules in the corpus - '.AVI' 15/15,
// 'H264' 31/31, 'MooV' 53/53, 'Mp3 ' 23/23, 'wao_' 7/7 - every one with a
// 34-byte header.
/** Offset of the u32 holding `len(body)`. */
export const _LEN_BODY_OFFSET = 6;
/** Offset of the u32 holding `len(xml region) - 2` (i.e. excluding the NULs). */
export const _LEN_XML_OFFSET = 30;

const _XML_DECLARATION = ascii('<?xml version="1.0" encoding="UTF-8"?>\n');
const _XML_NULS = new Uint8Array(2);
/** Every AE-authored body ends `>\n\x00\x00`. */
export const _XML_TERMINATOR = concat(Uint8Array.of(0x0a), _XML_NULS);

/**
 * An empty element with NO attributes; AE expands these (`<ParamName></ParamName>`)
 * while self-closing the ones that have attributes (`<Foo ObjectRef="1"/>`).
 */
const _EMPTY_ELEMENT_RE = /<([A-Za-z_][\p{L}\p{N}_.-]*)\/>/gu;

// XML param -> rules key: params whose writes are gated by the module's
// format rules (and whose changes re-clamp dependents, see
// CLAMP_DEPENDENTS). Params not listed here (frame rate, VR fields, ...)
// validate locally only.
const _PARAM_RULE_KEYS = new Map<string, string>([
  ["ADBEAudioBitrate", "Audio Bitrate"],
  ["ADBEAudioCodec", "Audio Codec"],
  ["ADBEMPEGAudioFormat", "Audio Format"],
  ["ADBEMPEGMultiplexer", "Multiplexer"],
  ["ADBEVideoCodec", "Video Codec"],
  ["BitRate", "BitRate"],
]);

type ETElement = ET.Element;

/** `dict(*args).items()` for `ParamsDict.update`. */
export type DictSource = Map<string, string> | Iterable<[string, string]> | Record<string, string>;

function _dictItems(args: DictSource[]): Iterable<[string, string]> {
  if (args.length === 0) return [];
  const src = args[0];
  if (src instanceof Map) return src.entries();
  if (Array.isArray(src)) return src;
  return Object.entries(src);
}

/** Descriptor for XML enum parameters (read/write). */
class _EnumParam {
  declare _key: string;
  declare _enumCls: EnumHelpers<number>;
  declare _name: string;

  constructor(key: string, enumCls: EnumHelpers<number>) {
    this._key = key;
    this._enumCls = enumCls;
  }

  attach(owner: Function, name: string): void {
    this._name = name;
  }

  get(obj: XmlFormatOptions | null, _objtype?: Function | null): number | null | this {
    if (obj == null) return this;
    return obj._enumParam(this._key, this._enumCls);
  }

  set(obj: XmlFormatOptions, value: number | null): void {
    obj._setEnumParam(this._key, value, this._enumCls);
  }
}

/**
 * Descriptor for plain integer XML parameters (read/write).
 *
 * Reads return `null` when the parameter is absent and fall back to
 * the raw string when it is non-numeric (the binary is trusted, like
 * `_tryEnumOrInt` for enums). Writes require an `int`.
 */
class _ScalarParam {
  declare _key: string;
  declare _name: string;

  constructor(key: string) {
    this._key = key;
  }

  attach(owner: Function, name: string): void {
    this._name = name;
  }

  get(obj: XmlFormatOptions | null, _objtype?: Function | null): number | string | null | this {
    if (obj == null) return this;
    const raw = obj.params.get(this._key) ?? "";
    if (!raw) return null;
    return /^\s*[+-]?\d+\s*$/.test(raw) ? Number(raw) : raw;
  }

  set(obj: XmlFormatOptions, value: number | null): void {
    if (value == null) return;
    validateInt(value);
    obj._checkParamRule(this._key, value);
    obj._setParam(this._key, String(value));
    obj._clampAfterParam(this._key);
  }
}

/**
 * Extract parameter key-value pairs from a PremiereData XML tree.
 *
 * Parses `ExporterParam` elements regardless of child-tag order and
 * returns a mapping of identifier to value, plus a mapping of identifier
 * to `ParamValue` element for O(1) writes, plus a mapping of identifier
 * to the owning `ExporterParam` element.
 *
 * An `ExporterParam` with no `ParamValue` child is an UNSET parameter -
 * AE's encoding for e.g. the H.264 `Baseline` profile. It is left out of
 * the params dict (so it reads as absent) but kept in the element map, so
 * a later write can restore its value in place instead of appending a
 * duplicate element.
 *
 * @param root - The parsed XML root element.
 * @returns Tuple of (params dict, value-elements dict, param-elements dict).
 */
/**
 * `ET.fromstring(text)` and its params, parsed once per distinct text: output
 * modules mostly share a handful of templates. The cached tree is never
 * mutated; a module copies it on its first XML edit. A malformed text raises
 * every time, as `fromstring` does.
 */
function _parseTemplate(text: string): _XmlTemplate {
  let template = _XML_TEMPLATES.get(text);
  if (template === undefined) {
    const tree = ET.fromstring(text);
    template = { tree, params: _extractParams(tree)[0] };
    if (_XML_TEMPLATES.size >= 64) _XML_TEMPLATES.delete(_XML_TEMPLATES.keys().next().value!);
    _XML_TEMPLATES.set(text, template);
  }
  return template;
}

type _XmlTemplate = { readonly tree: ETElement; readonly params: ReadonlyMap<string, string> };

const _XML_TEMPLATES = new Map<string, _XmlTemplate>();

function _copyTree(e: ETElement): ETElement {
  const copy = new ET.Element(e.tag);
  copy.attrib = new Map(e.attrib);
  copy.text = e.text;
  copy.tail = e.tail;
  copy._children = e._children.map(_copyTree);
  return copy;
}

function _extractParams(root: ETElement): [Map<string, string>, Map<string, ETElement>, Map<string, ETElement>] {
  const params = new Map<string, string>();
  const valueElements = new Map<string, ETElement>();
  const paramElements = new Map<string, ETElement>();
  for (const elem of root.iter("ExporterParam")) {
    const idElem = elem.find("ParamIdentifier");
    if (idElem == null || idElem.text == null) continue;
    const identifier = idElem.text;
    if (isdigit(identifier)) continue;
    paramElements.set(identifier, elem);
    const valElem = elem.find("ParamValue");
    if (valElem == null) continue;
    params.set(identifier, valElem.text || "");
    valueElements.set(identifier, valElem);
  }
  return [params, valueElements, paramElements];
}

/** Try to parse an int, then map to an enum; fall back to int. */
function _tryEnumOrInt(enumCls: EnumHelpers<number>, rawStr: string): number | null {
  if (!/^\s*[+-]?\d+\s*$/.test(rawStr)) return null;
  const rawValue = Number(rawStr);
  return enumCls.ofOrNull(rawValue) ?? rawValue;
}

/**
 * Dict subclass that syncs mutations back to the XML tree.
 *
 * `dict.update` / `setdefault` / `pop` / `clear` / `popitem` / `|=` are
 * C-level and do NOT call `__setitem__` / `__delitem__`, so every one of
 * them is overridden to route through them - otherwise they would mutate
 * the dict (and so the typed accessors' reads) while leaving the XML, and
 * therefore the saved file, unchanged.
 */
export class ParamsDict extends Map<string, string> {
  /**
   * A class default, not a bare annotation: `update` and friends below
   * reach `self._owner` through `__setitem__`, so a `ParamsDict` built
   * before `_owner` is assigned would raise AttributeError.
   */
  _owner: XmlFormatOptions | null = null;

  set(key: string, value: string): this {
    super.set(key, value);
    if (this._owner != null) this._owner._onParamChanged(key, value);
    return this;
  }

  delete(key: string): boolean {
    if (!super.has(key)) throw new KeyError(literal(key));
    super.delete(key);
    if (this._owner != null) this._owner._onParamRemoved(key);
    return true;
  }

  // NOTE(port): `**kwargs` has no TS equivalent; callers pass a mapping as the positional arg.
  update(...args: DictSource[]): void {
    for (const [key, value] of _dictItems(args)) {
      this.set(key, value);
    }
  }

  setdefault(key: string, default_: string = ""): string {
    if (!this.has(key)) this.set(key, default_);
    return getOrThrow(this, key);
  }

  pop(key: string, ...default_: string[]): string {
    if (!this.has(key)) {
      if (default_.length > 0) return default_[0];
      throw new KeyError(literal(key));
    }
    const value = getOrThrow(this, key);
    this.delete(key);
    return value;
  }

  popitem(): [string, string] {
    const keys = [...this.keys()];
    if (keys.length === 0) throw new KeyError(literal("popitem(): dictionary is empty"));
    const key = keys[keys.length - 1];
    const value = getOrThrow(this, key);
    super.delete(key);
    if (this._owner != null) this._owner._onParamRemoved(key);
    return [key, value];
  }

  clear(): void {
    for (const key of [...this.keys()]) {
      this.delete(key);
    }
  }

  // `|` (__or__) needs no override: it returns a new plain dict rather
  // than mutating, so it cannot desync the XML. Only `|=` does.
  /** Python `__ior__` (`|=`) */
  merge(other: DictSource): ParamsDict {
    this.update(other);
    return this;
  }
}

// Module-level descriptor declarations for the class body below; the
// `declare` lines inside the class keep the Python attribute order.
/**
 * XML-based format-specific render options.
 *
 * Shared by output formats that store their settings as a binary header
 * followed by a `PremiereData` XML block containing `ExporterParam`
 * elements. Applicable formats include AVI (`.AVI`), H.264 (`H264`),
 * MP3 (`Mp3 `), QuickTime (`MooV`), and WAV (`wao_`).
 *
 * Individual parameters are stored in the `params` map, keyed by
 * their Adobe parameter identifier (e.g. `"ADBEVideoCodec"`).
 *
 * @example
 * ```ts
 * import { XmlFormatOptions, parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const om = app.project.renderQueue.items[0].outputModules[0];
 * if (om.formatOptions instanceof XmlFormatOptions) {
 *   console.log(om.formatOptions.videoCodec);
 * }
 * ```
 */
export class XmlFormatOptions extends FormatOptionsBase {
  /**
   * All `ExporterParam` key-value pairs extracted from the embedded XML
   * `PremiereData` block. Keys are Adobe parameter identifiers such as
   * `"ADBEVideoCodec"`, `"ADBEVideoQuality"`,
   * `"ADBEAudioInterleave"`, etc. Values are the raw string
   * representations from the XML. Read / Write.
   *
   * Writes through this dict are the documented low-level escape hatch:
   * they bypass the typed accessors' format-rule validation and clamps.
   * Item assignment (`params[key] = value`), `update` and `setdefault`
   * all sync back to the XML. Removal (`pop`/`del`) only mutates the
   * dict: the `ExporterParam` element stays in the file.
   */
  declare params: ParamsDict;
  declare _body: RoptChunk;
  declare _xmlHeader: Uint8Array | null;
  /** The shared, never-mutated template tree, until the first XML edit copies it. */
  declare _template: ETElement | null;
  declare _ownTree: [ETElement, Map<string, ETElement>, Map<string, ETElement>] | null;

  constructor(kw: { _body: RoptChunk }) {
    super();
    const { _body } = kw;
    this._body = _body;

    const raw = _body.data;
    this._xmlHeader = null;
    this._template = null;
    this._ownTree = null;
    this.params = new ParamsDict();
    this.params._owner = null;
    const xmlStart = Bytes.indexOf(raw, ascii("<?xml"));
    if (xmlStart >= 0) {
      this._xmlHeader = raw.slice(0, xmlStart);
      const xmlText = decode(raw.slice(xmlStart), "utf-8", "replace").split("\x00")[0];
      const template = _parseTemplate(xmlText);
      this._template = template.tree;
      this.params.update(template.params);
    }
    this.params._owner = this;
  }

  /** This module's own XML tree (copied from the template on first use), or `null` without XML. */
  get _xmlRoot(): ETElement | null {
    return this._materialize()?.[0] ?? null;
  }

  private get _valElements(): Map<string, ETElement> {
    return this._materialize()?.[1] ?? new Map();
  }

  private get _paramElements(): Map<string, ETElement> {
    return this._materialize()?.[2] ?? new Map();
  }

  private _materialize(): [ETElement, Map<string, ETElement>, Map<string, ETElement>] | null {
    if (this._ownTree == null && this._template != null) {
      const root = _copyTree(this._template);
      const [, valElements, paramElements] = _extractParams(root);
      this._ownTree = [root, valElements, paramElements];
    }
    return this._ownTree;
  }

  /**
   * The 4-character format identifier from the Ropt chunk header
   * (e.g. `".AVI"`, `"H264"`, `"Mp3 "`, `"MooV"`, `"wao_"`).
   * Read-only.
   */
  declare formatCode: string;

  // -- write helpers -----------------------------------------------------

  /** Update a parameter in the XML tree and sync to the raw body. */
  _setParam(key: string, strValue: string): void {
    this.params.set(key, strValue);
  }

  /** Sync a param change to the XML tree and raw body. */
  _onParamChanged(key: string, strValue: string): void {
    // Every `params` mutation funnels through here by design, so this is
    // where a detached wrapper's raw-dict writes are caught - `params`
    // is a map surface, which the descriptors' attach check cannot see.
    this._checkAttached();
    if (this._xmlRoot == null) return;
    const valElem = this._valElements.get(key);
    if (valElem != null) {
      valElem.text = strValue;
      this._syncXml();
      return;
    }
    const paramElem = this._paramElements.get(key);
    if (paramElem != null) {
      // An existing but UNSET param: restore its value in place rather
      // than appending a duplicate element. AE writes `ParamValue` as
      // the element's first child; its tail carries the indentation
      // that used to precede the (currently first) next sibling, which
      // is what the element's own `text` holds.
      const val = new ET.Element("ParamValue");
      val.text = strValue;
      val.tail = paramElem.text;
      paramElem.insert(0, val);
      this._valElements.set(key, val);
    } else {
      const ep = ET.SubElement(this._xmlRoot, "ExporterParam");
      ET.SubElement(ep, "ParamIdentifier").text = key;
      const val = ET.SubElement(ep, "ParamValue");
      val.text = strValue;
      this._valElements.set(key, val);
      this._paramElements.set(key, ep);
    }
    this._syncXml();
  }

  /**
   * Unset a parameter by dropping only its `ParamValue` child.
   *
   * AE encodes an unset parameter (e.g. the H.264 `Baseline` profile)
   * by removing the `ParamValue` and KEEPING the `ExporterParam`
   * element - its `ObjectID` is referenced by the PremiereData object
   * graph. Both encodings decode identically (the param reads as absent
   * either way), so only a raw-XML comparison against an AE-saved
   * `Baseline` module distinguishes them.
   */
  _onParamRemoved(key: string): void {
    this._checkAttached();
    if (this._xmlRoot == null) return;
    this._valElements.delete(key);
    const paramElem = this._paramElements.get(key);
    if (paramElem == null) return;
    const val = paramElem.find("ParamValue");
    if (val != null) paramElem.remove(val);
    this._syncXml();
  }

  /** Set an Adobe parameter from an enum or int value. */
  _setEnumParam(key: string, value: number | null, enumCls: EnumHelpers<number> | null = null): void {
    if (value == null) return;
    // NOTE(port): int/float — integral values are plain numbers by design (RULEBOOK §4); an integral float such as 2.0 is accepted where Python raises TypeError.
    if (!((typeof value === "number" && Number.isInteger(value)) || typeof value === "boolean")) {
      throw new TypeError(`expected an int or IntEnum for ${literal(key)}, got ${typeName(value)}`);
    }
    // A plain number, so the stored text is the numeric form.
    const intValue = Math.trunc(value);
    if (enumCls != null && !enumCls.has(intValue)) {
      const members = enumCls
        .members()
        .map((m: number) => `${enumCls.nameOf(m)} (${m})`)
        .join(", ");
      throw new ValueError(
        `Invalid value ${literal(value)} for ${literal(key)}. ` + `Valid ${enumCls.enumName} values: ${members}`,
      );
    }
    const checked = enumCls != null ? enumCls.of(intValue) : intValue;
    this._checkParamRule(key, checked);
    this._setParam(key, String(intValue));
    // NOTE: Rouu.videoCodec is NOT synced here - it holds a constant
    // per-output-plugin handler tag ('DOVT' for QuickTime, 'CTXF' for
    // AVI/H.264), not the codec 4cc; every corpus sample confirms it
    // never varies with the selected codec.
    this._clampAfterParam(key);
  }

  /**
   * The owning output module. A format options object always belongs
   * to one; a missing back-reference is a wiring bug, not a permissive
   * case. (Detachment is a separate condition, caught by
   * `_checkAttached` on every write path.)
   */
  private _requireOm(): OutputModule {
    const om = this._parentOm;
    if (om == null) {
      // Explicit raise (not assert) so the wiring bug stays loud
      // under `python -O` too.
      throw new RuntimeError("format options have no owning output module");
    }
    return om;
  }

  /**
   * Gate a rules-covered param write on the module's format rules.
   *
   * Params outside `_PARAM_RULE_KEYS` are not format-gated.
   */
  _checkParamRule(paramKey: string, value: number): void {
    const ruleKey = _PARAM_RULE_KEYS.get(paramKey) ?? null;
    if (ruleKey == null) return;
    this._requireOm()._checkFormatRule(ruleKey, value);
  }

  /** Re-resolve dependent settings after a context param write. */
  _clampAfterParam(paramKey: string): void {
    const ruleKey = _PARAM_RULE_KEYS.get(paramKey) ?? null;
    if (ruleKey == null) return;
    this._requireOm()._applySingletonClamps(CLAMP_DEPENDENTS.get(ruleKey) ?? []);
  }

  /**
   * Re-serialize the XML tree back to the raw body, as AE writes it.
   *
   * The `Ropt` header embeds the body's own lengths and **After Effects
   * honours them**: it reads exactly `_LEN_BODY_OFFSET` bytes and
   * discards the rest. Leaving them stale made AE silently truncate the
   * XML mid-element on open and re-save the corruption (probed on AE
   * 26.3: an 87-byte-longer body was cut back to the stale length, losing
   * `</PremiereData>`). So the lengths MUST be repatched here.
   *
   * The rest matches AE's serializer byte-for-byte so that a no-op sync
   * is the identity - see `tests/roundtrip/test_xml_sync_fidelity.py`.
   *
   * **Note:** Byte-identity needs Python 3.8+: 3.7's `ET.tostring` sorts each
   * element's attributes alphabetically instead of keeping document
   * order, so a 3.7 write reorders them. The result is the same
   * length and semantically identical XML that AE reads correctly -
   * only the bytes differ from AE's. Parsing and saving without a
   * write never calls this, so round-trip idempotency is unaffected.
   */
  _syncXml(): void {
    if (this._xmlRoot == null || this._xmlHeader == null) return;
    const text0 = ET.tostring(this._xmlRoot, "unicode");
    // `ET` writes `<Foo a="1" />`; AE writes `<Foo a="1"/>`.
    const text1 = text0.replaceAll(" />", "/>");
    // `ET` self-closes every empty element; AE only does so when the
    // element has attributes, and expands the attribute-less ones.
    const text = text1.replace(_EMPTY_ELEMENT_RE, "<$1></$1>");
    const xmlBytes = concat(_XML_DECLARATION, new TextEncoder().encode(text), _XML_TERMINATOR);
    const body = new Uint8Array(concat(this._xmlHeader, xmlBytes));
    // Back-patch the two self-describing lengths AE honours (a stale one
    // silently truncates the XML). These stay here rather than becoming
    // an `XmlRoptChunk` in `binary/render_chunks.py` alongside the other
    // `_ROPT_VARIANTS`: a typed variant never writes `Chunk.data`, so the
    // variable-length XML payload would have to move to `_trailing`,
    // which is `eq=False` - two modules with different render settings
    // would then compare equal, and any missed `.data` write would drop
    // the payload silently.
    body.set(Bytes.intToBytes(body.length, 4, "big"), _LEN_BODY_OFFSET);
    body.set(Bytes.intToBytes(xmlBytes.length - _XML_NULS.length, 4, "big"), _LEN_XML_OFFSET);
    this._body.data = new Uint8Array(body);
  }

  // -- read helpers ------------------------------------------------------

  /**
   * Look up an Adobe param and convert to an enum or int.
   *
   * Returns `null` when the param is absent or non-numeric.
   */
  _enumParam(key: string, enumCls: EnumHelpers<number>): number | null {
    const raw = this.params.get(key) ?? "";
    if (!raw) return null;
    return _tryEnumOrInt(enumCls, raw);
  }

  /**
   * The video codec as a {@link VideoCodec} FourCC integer value extracted
   * from the `ADBEVideoCodec` parameter, or `null` for audio-only
   * formats (MP3, WAV). Falls back to a plain `int` when the codec is
   * not in the {@link VideoCodec} enum.
   * Read / Write.
   */
  declare videoCodec: VideoCodec | number | null;

  /**
   * The audio codec as an {@link AudioCodec} integer value extracted from
   * the `ADBEAudioCodec` parameter, or `null` when the parameter is
   * absent. Falls back to a plain `int` when the codec is not in the
   * {@link AudioCodec} enum.
   * Read / Write.
   */
  declare audioCodec: AudioCodec | number | null;

  /**
   * The output frame rate in frames per second, derived from the
   * `ADBEVideoFPS` parameter. Adobe stores this as ticks per frame
   * using a time base of 254,016,000,000 ticks/second, so
   * `frame_rate = 254016000000 / ADBEVideoFPS`.
   * `null` for audio-only formats (MP3, WAV).
   * Read / Write.
   */
  get frameRate(): number | null {
    const fpsStr = this.params.get("ADBEVideoFPS") ?? "";
    if (!fpsStr) return null;
    if (/^\s*[+-]?\d+\s*$/.test(fpsStr) && Number(fpsStr) > 0) return _ADOBE_TICKS_PER_SECOND / Number(fpsStr);
    return null;
  }

  set frameRate(value: number | null) {
    if (value == null) return;
    _validateNumber({ min: 1 / _ADOBE_TICKS_PER_SECOND })(value);
    const ticks = Math.round(_ADOBE_TICKS_PER_SECOND / value) + 0;
    // BigInt keeps Python's exact int spelling for ticks >= 1e21.
    this._setParam("ADBEVideoFPS", BigInt(ticks).toString());
  }

  /**
   * The dialog's top-level `Audio Format` (AAC / MPEG / PCM) as an
   * {@link MPEGAudioFormat} FourCC integer value extracted from the
   * `ADBEMPEGAudioFormat` parameter, or `null` when the parameter is
   * absent. Despite the parameter's `MPEG` prefix it selects among all
   * three families. Falls back to a plain `int` when the value is not
   * in the {@link MPEGAudioFormat} enum.
   * Read / Write.
   */
  declare mpegAudioFormat: MPEGAudioFormat | number | null;

  /**
   * The MPEG-1 audio layer as an {@link MPEGAudioLayer} value extracted
   * from the `ADBEMPEGAudioLayer` parameter, or `null` when the
   * parameter is absent. Only meaningful when `mpegAudioFormat` is
   * `MPEGAudioFormat.MPEG`. Read / Write.
   */
  declare mpegAudioLayer: MPEGAudioLayer | number | null;

  /**
   * The AVI audio interleave interval as an {@link AudioInterleave} value
   * extracted from the `ADBEAudioInterleave` parameter. The dialog's
   * `null` choice stores no parameter, so reads return `null` for it.
   * Read / Write.
   */
  declare audioInterleave: AudioInterleave | number | null;

  /**
   * The MP3 audio bitrate in kbps, from the `BitRate` parameter
   * (note: not ADBE-prefixed), or `null` when absent. Read / Write.
   */
  declare bitrate: number | string | null;

  /**
   * The H.264 audio bitrate in kbps, from the `ADBEAudioBitrate`
   * parameter, or `null` when absent. Read / Write.
   */
  declare audioBitrate: number | string | null;

  /**
   * The H.264 encoding profile as an {@link MPEGProfile} value from the
   * `ADBEVideoMPEGProfile` parameter. Read / Write.
   *
   * After Effects stores NO parameter for `Baseline`, so an absent
   * parameter reads back as `MPEGProfile.BASELINE` and assigning
   * `BASELINE` removes the parameter (AE-validated: the result matches
   * an AE-saved Baseline module's parameters exactly). The dropdown's
   * `Auto` is resolved at save time and reads back as `MAIN`. Falls
   * back to a plain `int` when the stored value is not in the
   * {@link MPEGProfile} enum.
   */
  get profile(): MPEGProfile | number {
    const raw = this.params.get("ADBEVideoMPEGProfile") ?? "";
    if (!raw) return MPEGProfile.BASELINE;
    const result = _tryEnumOrInt(MPEGProfile, raw);
    // A non-numeric param is as good as absent.
    if (result == null) return MPEGProfile.BASELINE;
    return result;
  }

  set profile(value: MPEGProfile | number) {
    validateEnum(MPEGProfile)(value);
    if (MPEGProfile.of(value) === MPEGProfile.BASELINE) {
      this.params.pop("ADBEVideoMPEGProfile", "");
      return;
    }
    this._setParam("ADBEVideoMPEGProfile", String(Math.trunc(value)));
  }

  /**
   * The H.264 encoding level as the raw integer from the
   * `ADBEVideoMPEGProfileLevel` parameter (level x 10, e.g. `41` for
   * 4.1; `100` is Unrestricted), or `null` when absent. Read / Write.
   */
  declare level: number | string | null;

  /**
   * The DNxHR/DNxHD resolution preset as a {@link DnxResolution} value
   * extracted from the `ADBEVideoResolution` parameter, or `null` when
   * the parameter is absent. Only meaningful when `videoCodec` is
   * `VideoCodec.DNXHR_DNXHD`; the param survives codec changes (stale
   * under other codecs). Falls back to a plain `int` when the value is
   * not in the {@link DnxResolution} enum. Read / Write.
   */
  declare resolution: DnxResolution | number | null;

  /**
   * The DNxHR/DNxHD `Alpha` choice from the `ADBEDNxHDAlphaType`
   * parameter: `1` = Compressed, `null` (param absent) = None. Only
   * meaningful when `videoCodec` is `VideoCodec.DNXHR_DNXHD`.
   * (`ADBEVideoAlphaType` is unrelated - it reads `true` on every
   * sampled module.) Read / Write.
   */
  declare dnxAlphaType: number | string | null;

  /**
   * The MPEG multiplexer as an {@link MPEGMultiplexer} FourCC integer
   * value extracted from the `ADBEMPEGMultiplexer` parameter, or
   * `null` when the parameter is absent. Falls back to a plain `int`
   * when the value is not in the {@link MPEGMultiplexer} enum.
   * Read / Write.
   */
  declare mpegMultiplexer: MPEGMultiplexer | number | null;

  /**
   * The MPEG mux stream compatibility as an
   * {@link MPEGMuxStreamCompatibility} FourCC integer value extracted from
   * the `ADBEMPEGMuxStreamCompatibility` parameter, or `null` when the
   * parameter is absent. Falls back to a plain `int` when the value
   * is not in the {@link MPEGMuxStreamCompatibility} enum.
   * Read / Write.
   */
  declare mpegMuxStreamCompatibility: MPEGMuxStreamCompatibility | number | null;

  static {
    // Descriptors for the `declare`d fields above.
    descriptor(this, "formatCode", new ChunkField("_body", "formatCode", { readOnly: true }));
    descriptor(this, "videoCodec", new _EnumParam("ADBEVideoCodec", VideoCodec));
    descriptor(this, "audioCodec", new _EnumParam("ADBEAudioCodec", AudioCodec));
    descriptor(this, "mpegAudioFormat", new _EnumParam("ADBEMPEGAudioFormat", MPEGAudioFormat));
    descriptor(this, "mpegAudioLayer", new _EnumParam("ADBEMPEGAudioLayer", MPEGAudioLayer));
    descriptor(this, "audioInterleave", new _EnumParam("ADBEAudioInterleave", AudioInterleave));
    descriptor(this, "bitrate", new _ScalarParam("BitRate"));
    descriptor(this, "audioBitrate", new _ScalarParam("ADBEAudioBitrate"));
    descriptor(this, "level", new _ScalarParam("ADBEVideoMPEGProfileLevel"));
    descriptor(this, "resolution", new _EnumParam("ADBEVideoResolution", DnxResolution));
    descriptor(this, "dnxAlphaType", new _ScalarParam("ADBEDNxHDAlphaType"));
    descriptor(this, "mpegMultiplexer", new _EnumParam("ADBEMPEGMultiplexer", MPEGMultiplexer));
    descriptor(
      this,
      "mpegMuxStreamCompatibility",
      new _EnumParam("ADBEMPEGMuxStreamCompatibility", MPEGMuxStreamCompatibility),
    );
  }
}
