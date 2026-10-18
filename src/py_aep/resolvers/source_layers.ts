/**
 * Enumerate and resolve the selectable layers of a layered source file.
 *
 * Mirrors the "Choose Layer" dropdown in After Effects' import dialog for
 * layered files (`.psd`/`.psb` via the Photoshop layer records, `.ai`/`.pdf`
 * via PDF Optional Content Groups): leaf layers only (groups are not
 * selectable), listed top layer first, nested leaves shown without a group
 * prefix.
 */

import {
  Path,
  ValueError,
  repr,
  sorted,
  type PathLike,
} from "../../pyrt/index.ts";
import { AI_COMP_EXTENSIONS, PSD_COMP_EXTENSIONS } from "../data/file_formats.ts";
import { read_ai_layer_ocgs, read_ai_layers, type AiLayer } from "./ai_layers.ts";
import { PsdGroup, read_psd_layers, type PsdLayer, type PsdNode } from "./psd_layers.ts";

/**
 * Return a PSD's leaf layers in document order (bottom layer first).
 *
 * Flattens the {@link read_psd_layers} group tree to the layers AE's
 * chooser offers (groups excluded).
 *
 * @throws {@link UnsupportedPsdLayersError} If the file is not a valid PSD/PSB.
 * @throws {@link FlattenedPsdError} If the document has no layer records.
 */
export function psd_leaf_layers(
  file: PathLike,
  kw: { mask_boxes?: boolean } = {},
): PsdLayer[] {
  const { mask_boxes = true } = kw;
  const leaves: PsdLayer[] = [];

  const _walk = (nodes: PsdNode[]): void => {
    for (const node of nodes) {
      if (node instanceof PsdGroup) {
        _walk(node.children);
      } else {
        leaves.push(node);
      }
    }
  };

  _walk(read_psd_layers(file, { mask_boxes }));
  leaves.splice(
    0,
    leaves.length,
    ...sorted(leaves, (leaf) => leaf.record_index),
  );
  return leaves;
}

/**
 * Return the selectable layer names of a layered file, top layer first.
 *
 * The order and contents match After Effects' "Choose Layer" import
 * dropdown: leaf layers only, top-most first. Duplicate names are
 * possible (Photoshop does not enforce unique layer names).
 *
 * @param file - Path to a `.psd`, `.psb`, `.ai`, or `.pdf` file.
 * @throws {@link ValueError} If the extension is not a layered format, or the file's layers cannot
 *   be enumerated (`UnsupportedPsdLayersError` / `UnsupportedAiLayersError`, both `ValueError`
 *   subclasses).
 */
export function list_layers(file: PathLike): string[] {
  const suffix = new Path(file).suffix.toLowerCase();
  if (PSD_COMP_EXTENSIONS.has(suffix)) {
    const leaves = psd_leaf_layers(file, { mask_boxes: false });
    return [...leaves].reverse().map((leaf) => leaf.name);
  }
  if (AI_COMP_EXTENSIONS.has(suffix)) {
    return [...read_ai_layers(file)].reverse();
  }
  throw new ValueError(
    `list_layers supports layered .psd/.psb/.ai/.pdf files, got ${repr(suffix)}`,
  );
}

/**
 * Map a stored binary layer index to its `list_layers` position in `file`.
 *
 * The stored index is the `sspc` layer index field of a single-layer
 * binding: the PSD layer record index (which counts group divider
 * records) or the AI/PDF document-order OCG index. Used by
 * `FootageItem.replace(..., CURRENT_VALUE)` to rebind a new file at the
 * same stored index.
 *
 * @throws {@link ValueError} If the extension is not a layered format, or no selectable layer of
 *   `file` has that stored index.
 */
export function layer_index_for_stored(
  file: PathLike,
  stored_index: number,
): number {
  const suffix = new Path(file).suffix.toLowerCase();
  if (PSD_COMP_EXTENSIONS.has(suffix)) {
    const leaves = psd_leaf_layers(file, { mask_boxes: false });
    for (const [i, leaf] of [...leaves].reverse().entries()) {
      if (leaf.record_index === stored_index) {
        return i;
      }
    }
    throw new ValueError(
      `${new Path(file).name}: no selectable layer has stored index ` +
        `${stored_index} (leaf record indices: ` +
        `${repr(leaves.map((leaf) => leaf.record_index))})`,
    );
  }
  if (AI_COMP_EXTENSIONS.has(suffix)) {
    const names = read_ai_layers(file);
    if (!(0 <= stored_index && stored_index < names.length)) {
      throw new ValueError(
        `${new Path(file).name}: no layer has stored (document) index ` +
          `${stored_index}; the file has ${names.length} layers`,
      );
    }
    return names.length - 1 - stored_index;
  }
  throw new ValueError(
    `layer_index_for_stored supports layered .psd/.psb/.ai/.pdf ` +
      `files, got ${repr(suffix)}`,
  );
}

export function _out_of_range(
  file: PathLike,
  layer_index: number,
  names: string[],
): ValueError {
  return new ValueError(
    `${new Path(file).name}: layerIndex ${layer_index} out of range; the ` +
      `file has ${names.length} selectable layers (top first): ${repr(names)}`,
  );
}

/**
 * Return the PSD leaf layer at `layer_index` in `list_layers` order
 * (top layer first).
 *
 * @throws {@link ValueError} If `layer_index` is out of range.
 * @throws {@link UnsupportedPsdLayersError} If the file's layers cannot be read.
 */
export function resolve_psd_layer(
  file: PathLike,
  layer_index: number,
): PsdLayer {
  const leaves = psd_leaf_layers(file);
  if (!(0 <= layer_index && layer_index < leaves.length)) {
    throw _out_of_range(
      file,
      layer_index,
      [...leaves].reverse().map((leaf) => leaf.name),
    );
  }
  return leaves[leaves.length - 1 - layer_index];
}

/**
 * Resolve an AI/PDF layer chosen by `list_layers` position.
 *
 * @param file - Path to a `.ai` or `.pdf` file.
 * @param layer_index - The layer's index in `list_layers` order (top first).
 * @param data - The file's bytes, if the caller already read them.
 * @returns A `(layers, document_index)` tuple: the file's layers in document order (bottom layer
 *   first) and the chosen layer's position in them, which is the index the binary stores. The whole
 *   list comes back because the binding also records how many layers the document has.
 * @throws {@link ValueError} If `layer_index` is out of range.
 * @throws {@link UnsupportedAiLayersError} If the file's layers cannot be read.
 */
export function resolve_ai_layer(
  file: PathLike,
  layer_index: number,
  data: Uint8Array | null = null,
): [AiLayer[], number] {
  const layers = read_ai_layer_ocgs(file, data);
  if (!(0 <= layer_index && layer_index < layers.length)) {
    throw _out_of_range(
      file,
      layer_index,
      [...layers].reverse().map((layer) => layer.name),
    );
  }
  return [layers, layers.length - 1 - layer_index];
}
