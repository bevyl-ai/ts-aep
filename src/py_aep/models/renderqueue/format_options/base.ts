import { RuntimeError, objectSetattr, pyObject } from "../../../../pyrt/index.ts";
import type { OutputModule } from "../output_module.ts";


/**
 * Shared plumbing for the format-specific render-option wrappers.
 *
 * Every wrapper holds an `Ropt` chunk that lives inside its output
 * module's block. `OutputModule.applyTemplate()` and a rolled-back
 * `batch_edit()` REPLACE that chunk (the new one may even be a different
 * format, and so a different wrapper class), rebinding
 * `OutputModule._format_options` to a freshly parsed object. A reference
 * the caller took before that point still wraps the old chunk, which is
 * no longer in the tree - so its writes would land in an orphaned body
 * and be silently dropped from the saved file, while reading back as if
 * they had succeeded.
 *
 * Those call sites mark the outgoing wrapper detached, and every write
 * is gated on it here.
 */
export class FormatOptionsBase {
  /**
   * Back-reference to the owning output module. `null` while the parser
   * is building the wrapper, before `OutputModule` wires it up - which
   * is why detachment needs its own flag rather than reusing `is None`.
   */
  declare _parentOm: OutputModule | null;

  /** Set when the owning module has replaced this wrapper's chunk. */
  declare _detached: boolean;

  constructor() {
    return pyObject(this);
  }

  _checkAttached(): void {
    if (this._detached) {
      throw new RuntimeError(
        "format options are detached from their output module: the " +
          "module replaced them (applyTemplate, or a rolled-back " +
          "batchEdit). Re-fetch `outputModule.formatOptions`.",
      );
    }
  }

  __setattr__(name: string, value: unknown): void {
    // Public fields only: `__init__` assigns `_body` (and friends), and
    // the detach itself writes `_detached`, both before/while there is
    // anything to guard.
    if (!name.startsWith("_")) {
      this._checkAttached();
    }
    objectSetattr(this, name, value);
  }
}

// Class-level defaults, as in Python: instances fall back to the prototype until assigned.
FormatOptionsBase.prototype._parentOm = null;
FormatOptionsBase.prototype._detached = false;
