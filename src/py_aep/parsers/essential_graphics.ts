/** Parser for Essential Graphics panel data (LIST:CIF3 chunks). */

import { filterByListType, filterByType, findByListType, findByListTypeOrNull, findByType } from "../binary/utils.ts";
import type { Utf8Chunk } from "../binary/scalar_chunks.ts";
import type { Chunk, ListChunk } from "../binary/chunk.ts";
import { _suppressMaterialization } from "../models/descriptors.ts";
import { EssentialGraphicsController, SourcePropertyRef } from "../models/essential_graphics.ts";
import { jsonGet, jsonRequire, parseJson, typeName } from "../../pyrt/index.ts";

// AE stores 0xFFFFFFFF in a CPrp path node's `index` to mean "match by name".
const _BY_NAME_INDEX = 0xffffffff;

/**
 * Parse a controller's `CPrp` path JSON into root-to-leaf refs.
 *
 * The JSON maps stringified positions (`"0"`, `"1"`, ...) to
 * `{"index", "matchName"}` nodes describing the path from the layer root to
 * the source property the controller exposes.
 */
function _parseSourcePropertyPath(raw: string): SourcePropertyRef[] {
  const nodes = parseJson(raw);
  if (!(nodes instanceof Map)) throw new TypeError(`'${typeName(nodes)}' object is not a path node map`);
  const path: SourcePropertyRef[] = [];
  for (const key of [...nodes.keys()].sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))) {
    const node = jsonRequire(nodes, key);
    const index = jsonGet(node, "index", null);
    const matchName = jsonGet(node, "matchName", "");
    if (typeof matchName !== "string" || (index !== null && typeof index !== "number")) {
      throw new TypeError(`malformed CPrp path node ${key}`);
    }
    path.push(new SourcePropertyRef(matchName, index === _BY_NAME_INDEX ? null : index));
  }
  return path;
}

/**
 * Parse a single LIST:CCtl chunk into a controller.
 *
 * @param cctlChunk - A LIST:CCtl chunk.
 */
function _parseController(cctlChunk: ListChunk): EssentialGraphicsController {
  const cps2 = findByListType(cctlChunk.chunks, "CpS2");
  const nameUtf8 = filterByType(cps2.chunks, "Utf8")[0];

  const ctyp = findByType(cctlChunk.chunks, "CTyp");

  const uuidChunks = filterByType(cctlChunk.chunks, "Utf8");
  const uuid = uuidChunks?.length > 0 ? uuidChunks[0].value : "";

  // The controlled-property path is the nested LIST:CPrp's Utf8 (JSON), a
  // different CPrp from the override-side OvG2/CPrp. Absent for some
  // controllers -> empty path.
  let sourcePropertyPath: SourcePropertyRef[] = [];
  let sourceCompId: number | null = null;
  let sourceLayerId: number | null = null;
  const cprp = findByListTypeOrNull(cctlChunk.chunks, "CPrp");
  if (cprp != null) {
    const pathUtf8 = filterByType(cprp.chunks, "Utf8");
    if (pathUtf8?.length > 0) {
      sourcePropertyPath = _parseSourcePropertyPath(pathUtf8[0].value);
    }
    // CCId / CLId identify the source comp + layer that own the
    // controlled property (the layer is matched by its `layerId`).
    const ccid = filterByType(cprp.chunks, "CCId");
    if (ccid?.length > 0) {
      sourceCompId = ccid[0].value;
    }
    const clid = filterByType(cprp.chunks, "CLId");
    if (clid?.length > 0) {
      sourceLayerId = clid[0].value;
    }
  }

  return new EssentialGraphicsController({
    _nameUtf8: nameUtf8,
    _ctyp: ctyp,
    uuid,
    sourcePropertyPath: sourcePropertyPath,
    sourceCompId: sourceCompId,
    sourceLayerId: sourceLayerId,
  });
}

/**
 * Parse the Essential Graphics panel from a composition's child chunks.
 *
 * Reads the Essential Graphics container and extracts the template name and
 * controllers. `CIF3` is the current, authoritative version (AE 2022+);
 * `CIF2`/`CIFO` are same-structure legacy versions that can be STALE
 * snapshots holding fewer (or zero) controllers than `CIF3` in the same
 * file. The `CIF3 -> CIF2 -> CIFO` order is therefore necessary - prefer
 * `CIF3` when present, and fall back to the legacy versions only so a
 * pre-CIF3 file still yields its template name and controllers rather than
 * silently parsing as no Essential Graphics.
 *
 * @param child_chunks - The child chunks of a composition LIST:Item chunk.
 * @returns A tuple of (template_name_utf8_chunk, controllers) if an Essential Graphics container is
 *   found, otherwise `null`.
 */
export const parseEssentialGraphics = _suppressMaterialization().decorate(function parse_essential_graphics(
  childChunks: Chunk[],
): [Utf8Chunk, EssentialGraphicsController[]] | null {
  let cif: ListChunk | null = null;
  for (const listType of ["CIF3", "CIF2", "CIFO"]) {
    cif = findByListTypeOrNull(childChunks, listType);
    if (cif !== null) break;
  }
  if (cif == null) return null;

  const cifChunks = cif.chunks;

  // Template name from the first LIST:CpS2
  const cps2 = findByListType(cifChunks, "CpS2");
  const templateNameUtf8 = filterByType(cps2.chunks, "Utf8")[0];

  const cctlChunks = filterByListType(cifChunks, "CCtl");
  const controllers = cctlChunks.map((cctl) => _parseController(cctl));

  return [templateNameUtf8, controllers];
});
