import { getMember } from "../../pyrt/index.ts";
import type { Path } from "../../pyrt/index.ts";
import { NhedChunk, NnhdChunk } from "../binary/item_chunks.ts";
import { DwgaChunk } from "../binary/misc_chunks.ts";
import { Utf8Chunk } from "../binary/scalar_chunks.ts";
import type { Chunk, ListChunk } from "../binary/chunk.ts";
import {
  ChunkNotFoundError,
  filterByType,
  findByListType,
  findByListTypeOrNull,
  findByType,
  findByTypeOrNull,
} from "../binary/utils.ts";
import { GpuAccelType } from "../enums/index.ts";
import { suppressingMaterialization } from "../models/descriptors.ts";
import { Project } from "../models/project.ts";
import { parseEffectDefinitions } from "./effect.ts";
import { parseFolder } from "./item.ts";
import { parseRenderQueue } from "./render_queue.ts";

/**
 * The color-profile `Utf8` AE writes immediately after `marker`.
 *
 * `marker` is `PwCs` (working space) or `pdvc` (display space). The slot is
 * identified by its marker rather than by the order the envelopes appear in:
 * an unset slot holds a literal `{}`, so keying on "first profile envelope
 * wins" reads a display space as the working space whenever the working space
 * is unset. Mirrors `Project._rewrite_color_profile`, which writes by this
 * same rule.
 *
 * @returns The `Utf8Chunk` holding the profile envelope, or `null` when the marker is absent or its
 *   slot is unset.
 */
function _colorProfileUtf8(rootChunks: Chunk[], marker: string): Utf8Chunk | null {
  for (const [i, chunk] of rootChunks.entries()) {
    if (chunk.chunkType !== marker || i + 1 >= rootChunks.length) continue;
    const following = rootChunks[i + 1];
    if (following.chunkType !== "Utf8" || !(following instanceof Utf8Chunk)) continue;
    if (following.value.includes("baseColorProfile")) return following;
  }
  return null;
}

// The project settings nhed holds as nnhd does, in its older layout.
const _NHED_SETTINGS = [
  "_displayByte",
  "footageTimecodeDisplayStartType",
  "_feetByte",
  "timecodeDefaultBase",
  "framesCountType",
  "bitsPerChannel",
  "transparencyGridThumbnails",
] as const;

/** The fields `_NHED_SETTINGS` names, which nhed and nnhd both declare with the same types. */
type _NhedSettings = Pick<NhedChunk, (typeof _NHED_SETTINGS)[number]>;

/** A synthetic nnhd carrying the settings of a project that has only nhed. */
export function _nnhdFromNhed(nhed: NhedChunk): NnhdChunk {
  const nnhd = new NnhdChunk({ synthetic: true });
  // setattr(nnhd, name, getattr(nhed, name)) with a computed name
  const copySetting = <K extends keyof _NhedSettings>(dst: _NhedSettings, name: K): void => {
    dst[name] = getMember(nhed, name);
  };
  for (const name of _NHED_SETTINGS) copySetting(nnhd, name);
  return nnhd;
}

/**
 * Parse an After Effects (.aep) project file into a Project.
 *
 * @param rifx - The parsed binary RIFX root chunk.
 * @param xmp - The XMP metadata string from the file trailer.
 * @param file_path - Path to the `.aep` file (stored on the Project).
 * @param ae_preferences_dir - Optional path to the AE preferences directory for template lookup.
 */
export const parseProject = suppressingMaterialization(function parse_project(
  rifx: ListChunk,
  xmp: string,
  filePath: string,
  aePreferencesDir: Path | null = null,
): Project {
  const rootChunks = rifx.chunks;

  const rootFolderChunk = findByListType(rootChunks, "Fold");
  const headChunk = findByType(rootChunks, "head");
  const nhedChunk = findByType(rootChunks, "nhed");
  const acerChunk = findByType(rootChunks, "acer");
  const adfrChunk = findByType(rootChunks, "adfr");
  // Older projects (AE CC 12.0) have none of nnhd, dwga and gpuG: their
  // settings come from nhed, and the others take their defaults. The
  // stand-ins are synthetic, so the file is written back without them.
  const nnhdChunk = findByTypeOrNull(rootChunks, "nnhd") ?? _nnhdFromNhed(nhedChunk);
  const dwgaChunk = findByTypeOrNull(rootChunks, "dwga") ?? new DwgaChunk({ synthetic: true });
  let gpugUtf8: Utf8Chunk;
  try {
    const gpugChunk = findByListType(rootChunks, "gpuG");
    gpugUtf8 = findByType(gpugChunk.chunks, "Utf8");
  } catch (e) {
    if (!(e instanceof ChunkNotFoundError)) throw e;
    // AE 2026 reports SOFTWARE for a CC 12.0 project.
    gpugUtf8 = new Utf8Chunk({
      value: GpuAccelType.toBinary(GpuAccelType.SOFTWARE),
      synthetic: true,
    });
  }

  // Expression engine: LIST:ExEn > Utf8
  const exenChunk = findByListTypeOrNull(rootChunks, "ExEn");
  const exenUtf8 = exenChunk === null ? null : findByTypeOrNull(exenChunk.chunks, "Utf8");

  // CMS settings JSON
  let cmsUtf8: Utf8Chunk | null = null;
  for (const c of filterByType(rootChunks, "Utf8")) {
    const content = c.value;
    // The color-management settings JSON is fragmented across AE versions:
    // some files store `{"colorManagementSystem":..,"ocioConfigurationFile":..}`,
    // others `{"graphicsWhiteLuminance":..,"lutInterpolationMethod":..}`. Prefer
    // the `colorManagementSystem` chunk (so OCIO projects are detected), but
    // fall back to a `lutInterpolationMethod`-only chunk when there is none.
    if (content.includes("colorManagementSystem")) {
      cmsUtf8 = c;
    } else if (cmsUtf8 == null && content.includes("lutInterpolationMethod")) {
      cmsUtf8 = c;
    }
  }

  const wsUtf8 = _colorProfileUtf8(rootChunks, "PwCs");
  const dcsUtf8 = _colorProfileUtf8(rootChunks, "pdvc");

  const project = new Project({
    _nhed: nhedChunk,
    _nnhd: nnhdChunk,
    _head: headChunk,
    _acer: acerChunk,
    _adfr: adfrChunk,
    _dwga: dwgaChunk,
    _gpugUtf8: gpugUtf8,
    _exenUtf8: exenUtf8,
    _cmsUtf8: cmsUtf8,
    _wsUtf8: wsUtf8,
    _dcsUtf8: dcsUtf8,
    _rifx: rifx,
    _xmp: xmp,
    file: filePath,
    items: new Map(),
    renderQueue: null,
    aePreferencesDir: aePreferencesDir,
  });

  project._effectParamDefs = parseEffectDefinitions(rootChunks, nnhdChunk._systemCodePage);

  const rootFolder = parseFolder(
    true, // is_root
    rootFolderChunk.chunks, // child_chunks
    project, // project
    null, // _idta
    null, // _name_utf8
    null, // _cmta
    rootFolderChunk, // _item_list
    null, // _gide
    null, // parent_folder
  );
  project.items.set(0, rootFolder);

  project._renderQueue = parseRenderQueue(rootChunks, project);

  const fcidChunk = findByTypeOrNull(rootChunks, "fcid");
  if (fcidChunk !== null) {
    // `fcid` can name an item that no longer exists (After Effects leaves
    // the id behind when the active item is deleted outside its own
    // bookkeeping, and opens such a file with nothing selected). Treat a
    // dangling id as "no active item" rather than failing the parse.
    project._activeItem = project.items.get(fcidChunk.value) ?? null;
  }

  return project;
});
