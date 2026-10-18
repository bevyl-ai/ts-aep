import { ViewerType } from "../../enums/index.ts";
import { ChunkField } from "../descriptors.ts";
import { _validateNumber } from "../validators.ts";
import { descriptor } from "../../../pyrt/index.ts";
import type { AsciiChunk, U1Chunk } from "../../binary/scalar_chunks.ts";
import type { View } from "./view.ts";

/**
 * The `Viewer` object represents a Composition, Layer, or Footage panel.
 *
 * ```ts
 * import { parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const viewer = app.activeViewer;
 * console.log(viewer.type);
 * ```
 *
 * @example
 * @see https://ae-scripting.docsforadobe.dev/other/viewer/
 */
export class Viewer {
  /**
   * The content in the viewer panel. Read-only.
   */
  declare type: ViewerType;

  declare _fitt: AsciiChunk;
  declare _foac: U1Chunk;
  declare _fiac: U1Chunk;
  declare _views: View[];
  declare _active_view_index: number;

  constructor(kw: { _fitt: AsciiChunk; _foac: U1Chunk; _fiac: U1Chunk }) {
    const { _fitt, _foac, _fiac } = kw;
    this._fitt = _fitt;
    this._foac = _foac;
    this._fiac = _fiac;
    this._views = [];
    this._active_view_index = 0;
  }

  /**
   * All of the {@link View} objects associated with this viewer.
   * Read-only.
   */
  get views(): View[] {
    return this._views;
  }

  /**
   * The index of the active view in the viewer's `views` array.
   * Read / Write.
   *
   * **Note:** The active locked view index is not persisted in the binary
   * format. It defaults to 0 (first view). Set it manually or call
   * `View.setActive()` to change which view is active.
   */
  get activeViewIndex(): number {
    return this._active_view_index;
  }

  set activeViewIndex(value: number) {
    // With no views the index is moot; clamp the upper bound to 0 so the
    // bound stays valid (an empty views list would otherwise give max=-1,
    // rejecting every value including 0).
    const maxIndex = this._views.length > 0 ? this._views.length - 1 : 0;
    _validateNumber({ min: 0, max: maxIndex, integer: true })(value);
    this._active_view_index = value;
  }

  /**
   * When `true`, indicates if the viewer panel is active.
   * Read-only.
   */
  get active(): boolean {
    return this._foac != null && this._foac.value !== 0 && this._fiac != null && this._fiac.value !== 0;
  }
}

descriptor(
  Viewer,
  "type",
  ChunkField.enum(ViewerType, "_fitt", "value", {
    transform: (v: string) => ViewerType.from_string(v),
    read_only: true,
  }),
);
