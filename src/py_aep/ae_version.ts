/**
 * Version gates: the model-method decorator, and the parts of a new item or
 * layer each After Effects release writes.
 */

import { AttributeError, TypeError_, getattr, getitem, hasattr, int, type_name } from "../pyrt/index.ts";

// The After Effects majors whose saves contain each version-gated part of a
// new project, item or layer, as `(first, last)` (`last` None: still
// written). From the projects AE 15 (CC 2018) and AE 22-26 save for newly
// created ones (samples/versions, emptier_2018.aep). AE 16-18 are not available to measure: a part AE 15
// lacks and AE 22 writes keeps its pre-gate behaviour there (first = 16),
// and a part AE 15 and AE 22 agree on is taken to hold for 16-18 as well.
export const _WRITTEN_BY = new Map<string, readonly [number, number | null]>([
  // Root chunks of a new project: the JavaScript expression engine
  // (`LIST:ExEn`), the Media Replacement folder id (`mrid`, read from
  // format 93.22), color management (`pcms` / `PwCs`) and `pdvc`.
  ["expression engine", [16, null]],
  ["media replacement folder id", [17, null]],
  ["color management", [22, null]],
  ["pdvc", [23, null]],
  // The UTF-8 code page Windows AE stamps in `nnhd` (1252 before).
  ["utf-8 code page", [26, null]],
  // `iide` + `idpc` at the head of every item's LIST:Item.
  ["item ids", [16, null]],
  // A comp item's `comr`, `LIST:CIF3`, Default viewer layer (`LIST:DLay`)
  // and the `ppSn` inside the `LIST:FEE` that follows it.
  ["comr", [16, null]],
  ["CIF3", [16, null]],
  ["default view layer", [16, null]],
  ["ppSn", [16, null]],
  // The empty `LIST:OvdG` AE 15 closes every layer and viewer layer with.
  ["layer OvdG", [0, 15]],
  // The Layer Sets group (layers and the Markers viewer layer) and the
  // Source Options group (AV layers).
  ["layer sets", [16, null]],
  ["source options", [16, null]],
  // The Layer Source Alternate value (`tdbs`); AE 22 writes only its
  // match name and blsv / blsi.
  ["source alternate value", [23, null]],
  // The ldta matte-layer field (164- instead of 160-byte records).
  ["matte layer id", [23, null]],
  // A light layer's ldta source id: 0xFFFFFFFF from AE 23, 0 before.
  ["light source id", [23, null]],
  // Casts Shadows ... Metal Coefficient in the Markers viewer layer's
  // Material Options, and its Shadow Color alpha (AE 24 writes 0).
  ["markers material", [24, null]],
  ["markers shadow alpha", [25, null]],
  // The 1 / 102.047... stamped at 0x94 / 0x98 of viewer-layer records.
  ["view layer ldta tail", [26, null]],
]);

/**
 * Whether After Effects `major` writes the version-gated `part` (a
 * `_WRITTEN_BY` key) for a newly created project, item or layer.
 */
export function ae_writes(part: string, major: number): boolean {
  const [first, last] = getitem(_WRITTEN_BY, part);
  return first <= major && (last == null || major <= last);
}

/**
 * Navigate from a model object to the AE version major number.
 *
 * Supports Layer (via `containing_comp`), Item (via `_project`),
 * ViewOptions (via `_item`), Property / PropertyGroup (via
 * `_containing_layer`), and Project (via `_head`).
 */
export function get_ae_version_major(obj: any): number {
  // Layer -> CompItem -> Project -> HeadChunk
  if (hasattr(obj, "_containing_comp")) {
    return int(obj._containing_comp._project._head.ae_version_major);
  }
  // Property / PropertyGroup -> owning Layer (parent_property chain)
  if (hasattr(obj, "_containing_layer")) {
    return get_ae_version_major(obj._containing_layer);
  }
  // Item / RenderQueueItem -> Project -> HeadChunk
  if (hasattr(obj, "_project")) {
    return int(obj._project._head.ae_version_major);
  }
  // ViewOptions -> AVItem -> Project -> HeadChunk
  const item = getattr(obj, "_item", null);
  if (item != null) {
    return int(item._project._head.ae_version_major);
  }
  // Project / TextDocument -> HeadChunk (TextDocument's is wired lazily, so
  // may be None until the document is handed out via a Property)
  const head = getattr(obj, "_head", null);
  if (head != null) {
    return int(head.ae_version_major);
  }
  throw new TypeError_(`Cannot determine AE version from ${type_name(obj)}`);
}

/**
 * Restrict a model method to files from a minimum AE major version.
 *
 * @param min_major - Minimum AE major version number (e.g. 23 for AE 23.x).
 * @throws {@link AttributeError} If the file predates the required version.
 */
export function requires_version(min_major: number) {
  return function decorator<T, A extends unknown[], R>(method: (this: T, ...args: A) => R): (this: T, ...args: A) => R {
    const wrapper = function (this: T, ...args: A): R {
      const major = get_ae_version_major(this);
      if (major < min_major) {
        throw new AttributeError(
          `${method.name}() requires AE ${min_major}+ ` +
            `file format (file is AE ${major}).`,
        );
      }
      return method.call(this, ...args);
    };
    Object.defineProperty(wrapper, "name", { value: method.name });
    return wrapper;
  };
}
