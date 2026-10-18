// Main entry point for parsing After Effects project files.
// `from __future__ import annotations`, `TYPE_CHECKING` blocks and `cast(...)`
// are dropped: annotations are types only, and `cast` becomes `as`.

import type { ListChunk } from "../binary/chunk.ts";
import { findByType } from "../binary/utils.ts";
import { Application } from "../models/application.ts";
import { _suppressMaterialization } from "../models/descriptors.ts";
import { FolderItem } from "../models/items/folder.ts";
import type { Project } from "../models/project.ts";
import type { Viewer } from "../models/viewer/viewer.ts";

/** Recursively collect viewers from a folder and its subfolders. */
export function* _collectViewers(folder: FolderItem): Generator<Viewer> {
  yield* folder._viewers;
  for (const item of folder.items) {
    if (item instanceof FolderItem) {
      yield* _collectViewers(item);
    }
  }
}

/**
 * Build an {@link Application} from the parsed RIFX data and project.
 *
 * @param rifx - The parsed binary RIFX root chunk.
 * @param project - The already-parsed {@link Project}.
 */
export const parseApp = _suppressMaterialization()(function parse_app(
  rifx: ListChunk,
  project: Project,
): Application {
  const rootChunks = rifx.chunks;
  const headChunk = findByType(rootChunks, "head");

  // Collect viewer panels from the folder tree (parsed during parse_folder)
  const viewers = _collectViewers(project.rootFolder);
  // `next((v for v in viewers if v.active), None)`
  let activeViewer: Viewer | null = null;
  for (const v of viewers) {
    if (v.active) {
      activeViewer = v;
      break;
    }
  }

  return new Application({
    _head: headChunk,
    project,
    active_viewer: activeViewer,
  });
});
