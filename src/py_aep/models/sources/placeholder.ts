import { ValueError, numStr } from "../../../pyrt/index.ts";
import { PlaceholderOptiChunk, SspcChunk } from "../../binary/footage_chunks.ts";
import { validateDuration, validateFootageDimension, validateFrameRate, validateOptiName } from "../validators.ts";
import { FootageSource } from "./footage.ts";

import type { ListChunk } from "../../binary/chunk.ts";
import type { OptiChunk } from "../../binary/footage_chunks.ts";
import type { U1Chunk } from "../../binary/scalar_chunks.ts";

/**
 * The `PlaceholderSource` object describes the footage source of a
 * placeholder.
 *
 * ```ts
 * import { PlaceholderSource, parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const footage = app.project.footages[0];
 * if (footage.mainSource instanceof PlaceholderSource) {
 *   console.log(footage.mainSource.nativeFrameRate);
 * }
 * ```
 *
 * Info:
 * `PlaceholderSource` is a subclass of {@link FootageSource} object. All
 * methods and attributes of {@link FootageSource} are available when working
 * with `PlaceholderSource`. `PlaceholderSource` does not define any
 * additional methods or attributes.
 *
 * @example
 * @see https://ae-scripting.docsforadobe.dev/sources/placeholdersource/
 */
export class PlaceholderSource extends FootageSource {
  static _ownsName = true;

  declare _opti: OptiChunk;

  get _rateIsAssumed(): boolean {
    return true;
  }

  constructor(kw: { _sspc: SspcChunk; _opti: OptiChunk; _linl?: U1Chunk | null; _clrs?: ListChunk | null }) {
    const { _sspc, _opti, _linl = null, _clrs = null } = kw;
    super({ _sspc, _linl, _clrs });
    this._opti = _opti;
  }

  /**
   * Create a new placeholder source with backing chunks.
   *
   * @param name - The placeholder name.
   * @param width - Width in pixels (4-30000).
   * @param height - Height in pixels (4-30000).
   * @param frameRate - Frame rate in fps (1.0-99.0).
   * @param duration - Duration in seconds (\> 0, \<= 10800).
   */
  static _new(name: string, width: number, height: number, frameRate: number, duration: number): PlaceholderSource {
    validateOptiName(name);
    validateFootageDimension(width);
    validateFootageDimension(height);
    validateFrameRate(frameRate);
    validateDuration(duration);
    if (duration <= 0.0) {
      throw new ValueError(`duration must be > 0, got ${numStr(duration)}`);
    }

    const sspc = new SspcChunk({
      width,
      height,
      alphaModeRaw: 3,
      layerIndex: 0xfffffffe,
    });
    sspc.footageMissingAtSave = true;
    sspc.nativeFrameRate = frameRate;
    sspc.duration = duration;

    const opti = new PlaceholderOptiChunk({ placeholderName: name });

    return new this({ _sspc: sspc, _opti: opti });
  }

  /**
   * A placeholder's duration is in seconds whatever its rate: AE 2026
   * reports 10 s for a 10 s placeholder even with a conform rate stored
   * (as py_aep once wrote one).
   */
  get _duration(): number {
    return this._sspc.duration * this._sspc.loop;
  }

  _resolveName(_rawName: string): string {
    return this._opti.placeholderName;
  }

  _storeName(value: string): void {
    validateOptiName(value);
    this._opti.placeholderName = value;
  }
}
