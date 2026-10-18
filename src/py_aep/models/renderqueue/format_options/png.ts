// `from __future__ import annotations` and the `typing` imports are dropped:
// annotations are TypeScript types only.
import {
  ValueError,
  descriptor,
  dictGet,
  int,
  jsonDumps,
  jsonLoads,
  pyBool,
  jsonFloat,
  jsonInt,
  type JsonValue,
} from "../../../../pyrt/index.ts";
import { Hdr10ColorPrimaries, PngCompression } from "../../../enums/index.ts";
import { ChunkField, enumOrRaw } from "../../descriptors.ts";
import { validateEnum, validateOneOf, validatePositiveNumber } from "../../validators.ts";
import { FormatOptionsBase } from "./base.ts";
import type { PngRoptChunk } from "../../../binary/render_chunks.ts";
import type { Utf8Chunk } from "../../../binary/scalar_chunks.ts";

/**
 * HDR10 metadata JSON as AE stores it. It is re-dumped without sorting, so
 * the Map keeps the file's key order and any keys py_aep does not read.
 */
type Hdr10Meta = Map<string, JsonValue>;

/**
 * PNG format-specific render options.
 *
 * These settings correspond to the PNG Options dialog in After Effects,
 * accessible when the output format is set to PNG Sequence.
 *
 * The Ropt body for PNG contains a fixed-size binary block (typically 318
 * bytes) with width, height, and bit depth at known offsets. HDR10 metadata
 * is stored separately in a JSON `Utf8` chunk alongside the Ropt chunk.
 *
 * @example
 * ```ts
 * import { PngFormatOptions, parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const om = app.project.renderQueue.items[0].outputModules[0];
 * if (om.formatOptions instanceof PngFormatOptions) {
 *   console.log(om.formatOptions.compression);
 * }
 * ```
 */
export class PngFormatOptions extends FormatOptionsBase {
  declare _body: PngRoptChunk;
  declare _hdr10Utf8: Utf8Chunk | null;
  declare _hdr10Meta: Hdr10Meta;

  constructor(kw: { _body: PngRoptChunk; _hdr10Utf8?: Utf8Chunk | null }) {
    super();
    const { _body, _hdr10Utf8 = null } = kw;
    this._body = _body;
    this._hdr10Utf8 = _hdr10Utf8;
    this._hdr10Meta = new Map();
    if (_hdr10Utf8 != null) {
      try {
        const parsed = jsonLoads(_hdr10Utf8.value);
        if (parsed instanceof Map) this._hdr10Meta = parsed;
      } catch (e) {
        // Python: `except (json.JSONDecodeError, ValueError): pass`
        if (!(e instanceof ValueError)) throw e;
      }
    }
  }

  /** The output width in pixels. Read-only. */
  declare width: number;

  /** The output height in pixels. Read-only. */
  declare height: number;

  /**
   * The output bit depth per channel: `8` or `16`, kept in step with the
   * output module's `Depth` setting. After Effects renders the module's
   * `Depth` (AE 2026), so change that rather than this field. Read / Write.
   */
  declare bitDepth: number;

  /**
   * The PNG compression / interlace mode. Corresponds to the
   * `Compression` dropdown in the PNG Options dialog. An out-of-enum
   * stored value reads back as a raw `int` (the binary is trusted).
   * Read / Write.
   */
  declare compression: PngCompression | number;

  /** Serialize `_hdr10Meta` back to the Utf8 chunk body. */
  _syncHdr10(): void {
    if (this._hdr10Utf8 != null) {
      this._hdr10Utf8.value = jsonDumps(this._hdr10Meta, { separators: [",", ":"] });
    }
  }

  /**
   * Whether HDR10 metadata is embedded in the PNG output.
   * Corresponds to the `Include HDR10 Metadata` checkbox in the PNG
   * Options dialog. Only available for 16-bit output. Read / Write.
   */
  get includeHdr10Metadata(): boolean {
    return pyBool(dictGet(this._hdr10Meta, "colorMetadataPresent", false));
  }

  set includeHdr10Metadata(value: boolean) {
    this._hdr10Meta.set("colorMetadataPresent", !!value);
    this._syncHdr10();
  }

  /**
   * The color primaries used for HDR10 metadata. Corresponds to the
   * `Color Primaries` dropdown in the PNG Options dialog.
   * Only meaningful when `includeHdr10Metadata` is `true`. An
   * out-of-enum stored value reads back as a raw `int` (the binary
   * is trusted). Read / Write.
   */
  get colorPrimaries(): Hdr10ColorPrimaries | JsonValue {
    const raw = this._hdr10Meta.get("displayPrimaries") ?? null;
    if (raw == null) return Hdr10ColorPrimaries.P3_D65;
    return enumOrRaw((v: JsonValue) => Hdr10ColorPrimaries.of(jsonInt(v)))(raw);
  }

  set colorPrimaries(value: Hdr10ColorPrimaries) {
    validateEnum(Hdr10ColorPrimaries)(value);
    this._hdr10Meta.set("displayPrimaries", int(value));
    this._syncHdr10();
  }

  /**
   * The minimum display luminance in nits for HDR10 metadata, or
   * `null` if not explicitly set. Corresponds to the
   * `Luminance Minimum` field in the PNG Options dialog. Read / Write.
   */
  get luminanceMin(): number | null {
    const raw = this._hdr10Meta.get("minLuminance") ?? null;
    return raw != null ? jsonFloat(raw) : null;
  }

  set luminanceMin(value: number | null) {
    if (value == null) {
      this._hdr10Meta.delete("minLuminance");
    } else {
      validatePositiveNumber(value);
      this._hdr10Meta.set("minLuminance", value);
    }
    this._syncHdr10();
  }

  /**
   * The maximum display luminance in nits for HDR10 metadata, or
   * `null` if not explicitly set. Corresponds to the
   * `Luminance Maximum` field in the PNG Options dialog. Read / Write.
   */
  get luminanceMax(): number | null {
    const raw = this._hdr10Meta.get("maxLuminance") ?? null;
    return raw != null ? jsonFloat(raw) : null;
  }

  set luminanceMax(value: number | null) {
    if (value == null) {
      this._hdr10Meta.delete("maxLuminance");
    } else {
      validatePositiveNumber(value);
      this._hdr10Meta.set("maxLuminance", value);
    }
    this._syncHdr10();
  }

  /**
   * The maximum content light level in nits for HDR10 metadata, or
   * `null` if not explicitly set. Corresponds to the
   * `Content Light Maximum` field in the PNG Options dialog. Read / Write.
   */
  get contentLightMax(): number | null {
    const raw = this._hdr10Meta.get("maxContentLightLevel") ?? null;
    return raw != null ? jsonFloat(raw) : null;
  }

  set contentLightMax(value: number | null) {
    if (value == null) {
      this._hdr10Meta.delete("maxContentLightLevel");
    } else {
      validatePositiveNumber(value);
      this._hdr10Meta.set("maxContentLightLevel", value);
    }
    this._syncHdr10();
  }

  /**
   * The maximum frame average light level in nits for HDR10 metadata,
   * or `null` if not explicitly set. Corresponds to the
   * `Content Light Average` field in the PNG Options dialog. Read / Write.
   */
  get contentLightAverage(): number | null {
    const raw = this._hdr10Meta.get("maxFrameAverageLightLevel") ?? null;
    return raw != null ? jsonFloat(raw) : null;
  }

  set contentLightAverage(value: number | null) {
    if (value == null) {
      this._hdr10Meta.delete("maxFrameAverageLightLevel");
    } else {
      validatePositiveNumber(value);
      this._hdr10Meta.set("maxFrameAverageLightLevel", value);
    }
    this._syncHdr10();
  }
}

descriptor(PngFormatOptions, "width", new ChunkField("_body", "width", { readOnly: true }));
descriptor(PngFormatOptions, "height", new ChunkField("_body", "height", { readOnly: true }));
descriptor(
  PngFormatOptions,
  "bitDepth",
  new ChunkField("_body", "bitDepth", { validate: validateOneOf([8, 16]) }),
);
descriptor(
  PngFormatOptions,
  "compression",
  ChunkField.enum(PngCompression, "_body", "compression", { allowOutOfEnumValues: true }),
);
