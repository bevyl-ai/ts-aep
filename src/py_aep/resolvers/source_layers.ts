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
  literal,
  sorted,
  type PathLike,
} from "../../pyrt/index.ts";
import { AI_COMP_EXTENSIONS, PSD_COMP_EXTENSIONS } from "../data/file_formats.ts";
import { readAiLayerOcgs, readAiLayers, type AiLayer } from "./ai_layers.ts";
import { PsdGroup, readPsdLayers, type PsdLayer, type PsdNode } from "./psd_layers.ts";

/**
 * Return a PSD's leaf layers in document order (bottom layer first).
 *
 * Flattens the {@link readPsdLayers} group tree to the layers AE's
 * chooser offers (groups excluded).
 *
 * @throws {@link UnsupportedPsdLayersError} If the file is not a valid PSD/PSB.
 * @throws {@link FlattenedPsdError} If the document has no layer records.
 */
export function psdLeafLayers(
  file: PathLike,
  kw: { maskBoxes?: boolean } = {},
): PsdLayer[] {
  const { maskBoxes = true } = kw;
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

  _walk(readPsdLayers(file, { maskBoxes }));
  leaves.splice(
    0,
    leaves.length,
    ...sorted(leaves, (leaf) => leaf.recordIndex),
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
export function listLayers(file: PathLike): string[] {
  const suffix = new Path(file).suffix.toLowerCase();
  if (PSD_COMP_EXTENSIONS.has(suffix)) {
    const leaves = psdLeafLayers(file, { maskBoxes: false });
    return [...leaves].reverse().map((leaf) => leaf.name);
  }
  if (AI_COMP_EXTENSIONS.has(suffix)) {
    return [...readAiLayers(file)].reverse();
  }
  throw new ValueError(
    `listLayers supports layered .psd/.psb/.ai/.pdf files, got ${literal(suffix)}`,
  );
}

/**
 * Map a stored binary layer index to its `listLayers` position in `file`.
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
export function layerIndexForStored(
  file: PathLike,
  storedIndex: number,
): number {
  const suffix = new Path(file).suffix.toLowerCase();
  if (PSD_COMP_EXTENSIONS.has(suffix)) {
    const leaves = psdLeafLayers(file, { maskBoxes: false });
    for (const [i, leaf] of [...leaves].reverse().entries()) {
      if (leaf.recordIndex === storedIndex) {
        return i;
      }
    }
    throw new ValueError(
      `${new Path(file).name}: no selectable layer has stored index ` +
        `${storedIndex} (leaf record indices: ` +
        `${literal(leaves.map((leaf) => leaf.recordIndex))})`,
    );
  }
  if (AI_COMP_EXTENSIONS.has(suffix)) {
    const names = readAiLayers(file);
    if (!(0 <= storedIndex && storedIndex < names.length)) {
      throw new ValueError(
        `${new Path(file).name}: no layer has stored (document) index ` +
          `${storedIndex}; the file has ${names.length} layers`,
      );
    }
    return names.length - 1 - storedIndex;
  }
  throw new ValueError(
    `layerIndexForStored supports layered .psd/.psb/.ai/.pdf ` +
      `files, got ${literal(suffix)}`,
  );
}

export function _outOfRange(
  file: PathLike,
  layerIndex: number,
  names: string[],
): ValueError {
  return new ValueError(
    `${new Path(file).name}: layerIndex ${layerIndex} out of range; the ` +
      `file has ${names.length} selectable layers (top first): ${literal(names)}`,
  );
}

/**
 * Return the PSD leaf layer at `layerIndex` in `listLayers` order
 * (top layer first).
 *
 * @throws {@link ValueError} If `layerIndex` is out of range.
 * @throws {@link UnsupportedPsdLayersError} If the file's layers cannot be read.
 */
export function resolvePsdLayer(
  file: PathLike,
  layerIndex: number,
): PsdLayer {
  const leaves = psdLeafLayers(file);
  if (!(0 <= layerIndex && layerIndex < leaves.length)) {
    throw _outOfRange(
      file,
      layerIndex,
      [...leaves].reverse().map((leaf) => leaf.name),
    );
  }
  return leaves[leaves.length - 1 - layerIndex];
}

/**
 * Resolve an AI/PDF layer chosen by `listLayers` position.
 *
 * @param file - Path to a `.ai` or `.pdf` file.
 * @param layerIndex - The layer's index in `listLayers` order (top first).
 * @param data - The file's bytes, if the caller already read them.
 * @returns A `(layers, document_index)` tuple: the file's layers in document order (bottom layer
 *   first) and the chosen layer's position in them, which is the index the binary stores. The whole
 *   list comes back because the binding also records how many layers the document has.
 * @throws {@link ValueError} If `layerIndex` is out of range.
 * @throws {@link UnsupportedAiLayersError} If the file's layers cannot be read.
 */
export function resolveAiLayer(
  file: PathLike,
  layerIndex: number,
  data: Uint8Array | null = null,
): [AiLayer[], number] {
  const layers = readAiLayerOcgs(file, data);
  if (!(0 <= layerIndex && layerIndex < layers.length)) {
    throw _outOfRange(
      file,
      layerIndex,
      [...layers].reverse().map((layer) => layer.name),
    );
  }
  return [layers, layers.length - 1 - layerIndex];
}
