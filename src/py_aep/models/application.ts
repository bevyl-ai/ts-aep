// Port of py_aep/models/application.py.

import { ae_writes } from "../ae_version.ts";
import { LEGACY_NAME_FORMAT } from "../binary/chunk.ts";
import type { HeadChunk } from "../binary/item_chunks.ts";
import { ChunkField } from "./descriptors.ts";
import { validate_ae_version, validate_u1 } from "./validators.ts";
import type { Preferences } from "./preferences.ts";
import type { Viewer } from "./viewer/viewer.ts";
import { descriptor, int, repr, split, str, ValueError, type Path, type ClassAttributes } from "../../pyrt/index.ts";
import { Project } from "./project.ts";

// Version-gated parts After Effects expects from the format version alone,
// whatever the file holds. Measured on AE 2026: projects relabelled across
// the AE 23 layer-record change fail to open ("chunk in file too big", "file
// is damaged", "missing data in file"), and so does an AE 16 project relabelled
// 22 (without the AE 17 Media Replacement folder id), while relabels between
// 15 and 16, 17 and 18, 18 and 22, and among 23-26 open unchanged.
export const _LAYOUT_PARTS = ["matte layer id", "media replacement folder id"] as const;

/** A version whose file layout matches the project's. */
export function _validate_version(value: string, obj: Application): void {
  validate_ae_version(value);
  const current = obj._head.ae_version_major;
  const target = int(split(str(value), ".", 1)[0]);
  if (obj._head.file_format_version < LEGACY_NAME_FORMAT) {
    // Every release py_aep writes reads names as `Utf8` children, where
    // this project holds them as bare strings (and lacks root chunks
    // the newer format requires).
    throw new ValueError(
      `cannot relabel an After Effects ${current} project as ${target}: ` +
        "it stores names in the older format; open and re-save it in " +
        "the target release instead",
    );
  }
  for (const part of _LAYOUT_PARTS) {
    if (ae_writes(part, current) !== ae_writes(part, target)) {
      throw new ValueError(
        `cannot relabel an After Effects ${current} project as ` +
          `${target}: the releases lay out the ${part} differently and ` +
          "After Effects would not open the file; open and re-save it " +
          "in the target release instead",
      );
    }
  }
}

/**
 * The `Application` object represents the After Effects application. Attributes
 * provide access to the project and application-level settings parsed from
 * the binary file.
 *
 * @example
 * ```ts
 * import { parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * console.log(app.version);
 * ```
 * @see https://ae-scripting.docsforadobe.dev/general/application/
 */
export class Application {
  declare ["constructor"]: ClassAttributes<typeof Application>;
  /**
   * The build number of After Effects that last saved the project.
   * Read / Write.
   *
   * **Warning:** This attribute is read-only in ExtendScript. Modifying it could
   * cause issues when opening the file in After Effects.
   */
  declare build_number: number;

  /**
   * The version of After Effects that last saved the project, formatted as
   * "\{major\}.\{minor\}x\{build\}" (e.g., "25.6x101"). Read / Write.
   *
   * Setting it also updates the file-format compatibility marker (which
   * determines the oldest AE that can open the file, and the rules AE reads
   * it with) to the one After Effects writes for that release, so the file
   * claims to be openable by that AE. A major py_aep has no marker for (a
   * release newer than 26, or one After Effects skipped) only changes the
   * version: the marker is kept, so the file opens wherever it opened
   * before. The major and the build must be at most 255, the minor at most
   * 15.
   *
   * **Warning:** Setting the version does **not** migrate the project structure: the
   * version-gated chunks and features are left unchanged, so relabeling
   * to an older version may produce a file that the older AE opens but
   * whose newer content it cannot represent. A relabel across a change
   * After Effects reads by the format version alone (the AE 23 layer
   * record, the AE 17 Media Replacement folder id) raises `ValueError`,
   * since no After Effects would open the result. To create a project
   * faithfully targeting a specific AE version use {@link py_aep.new}; to
   * convert an existing project, open and re-save it in the target AE.
   *
   * This attribute is read-only in ExtendScript. Modifying it could
   * cause issues when opening the file in After Effects.
   */
  declare version: string;

  /**
   * Indicates whether the After Effects version is a beta version. Read / Write.
   *
   * **Warning:** This attribute is read-only in ExtendScript. Modifying it could
   * cause issues when opening the file in After Effects.
   */
  declare is_beta: boolean;

  /** The name of the application. Always "After Effects". Read-only. */
  static app_name: string = "After Effects";

  /** Instance-level read of the class attribute (`app.app_name` in Python). */
  get app_name(): string {
    return this.constructor.app_name;
  }

  declare _head: HeadChunk;
  declare _project: Project;
  declare _active_viewer: Viewer | null;

  constructor(kw: { _head: HeadChunk; project: Project; active_viewer?: Viewer | null }) {
    const { _head, project, active_viewer = null } = kw;
    this._head = _head;
    this._project = project;
    this._active_viewer = active_viewer;
  }

  /**
   * Build a new, empty {@link Application} (mirrors File \> New Project).
   *
   * See `py_aep.new`.
   */
  static _new(version: string, ae_preferences_dir: Path | null = null, platform: string | null = null): Application {
    const project = Project._new(version, ae_preferences_dir, platform);
    return new this({ _head: project._head, project, active_viewer: null });
  }

  __repr__(): string {
    return `Application(version=${repr(this.version)}, build_number=${repr(this.build_number)}, app_name=${repr(this.app_name)})`;
  }

  /** The project that is currently loaded. Read-only. */
  get project(): Project {
    return this._project;
  }

  /**
   * The Viewer object for the currently focused or active-focused viewer
   * (Composition, Layer, or Footage) panel. Returns `null` if no viewers
   * are open. Read-only.
   */
  get active_viewer(): Viewer | null {
    return this._active_viewer;
  }

  /**
   * The {@link Preferences} object, providing access to the After Effects
   * preference files (requires `ae_preferences_dir` to read values from
   * disk; overrides work without it). Read-only.
   */
  get preferences(): Preferences {
    return this._project._preferences;
  }

  /**
   * A string indicating the version and build of After Effects, formatted
   * as "\{major\}.\{minor\}x\{build\}" (e.g., "25.6x101"). Read / Write.
   *
   * Alias for {@link Application.version | version}.
   *
   * **Warning:** This attribute is read-only in ExtendScript. Modifying it could
   * cause issues when opening the file in After Effects.
   */
  get build_name(): string {
    return this.version;
  }

  set build_name(value: string) {
    this.version = value;
  }
}

descriptor(
  Application,
  "build_number",
  new ChunkField("_head", "ae_build_number", {
    // An 8-bit field of the head chunk: a larger build would wrap.
    validate: validate_u1,
  }),
);

descriptor(
  Application,
  "version",
  new ChunkField("_head", "version", {
    validate: _validate_version,
    post_set: (obj: Application) => obj._head.sync_file_format_version(),
  }),
);

descriptor(Application, "is_beta", ChunkField.bool("_head", "ae_version_beta_flag"));
