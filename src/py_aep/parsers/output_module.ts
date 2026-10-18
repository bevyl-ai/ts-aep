import type { Utf8Chunk } from "../binary/scalar_chunks.ts";
import { filterByType, findByListTypeOrNull, findByType, findByTypeOrNull } from "../binary/utils.ts";
import { _suppressMaterialization } from "../models/descriptors.ts";
import { OutputModule } from "../models/renderqueue/output_module.ts";
import type { RenderQueueItem } from "../models/renderqueue/render_queue_item.ts";
import { parseFormatOptions } from "./format_options.ts";
import type { Chunk } from "../binary/chunk.ts";
import type { OutputModuleSettingsItem } from "../binary/render_chunks.ts";

/**
 * Parse an output module from its chunk group.
 *
 * Each output module consists of:
 * - Roou: Output options (binary data)
 * - Ropt: Render options (binary data)
 * - hdrm: HDR metadata (optional)
 * - Utf8: HDR10 / color metadata JSON (optional, only when hdrm present)
 * - LIST Als2: Output file path info (only once an output file is set;
 *   a freshly added module has none)
 *   - alas: JSON with fullpath and target_is_folder
 * - Utf8: Template/format name (e.g., "H.264 - Match Render Settings - 15 Mbps")
 * - Utf8: File name template (e.g., "[compName].[fileextension]" or "output.mp4")
 *
 * The format name and file-name template are always the last two top-level
 * `Utf8` chunks (the optional HDR-metadata `Utf8` precedes them, and the
 * `alas` lives inside the `Als2` LIST), so they are located by position
 * rather than relative to `Als2` - which may be absent.
 *
 * @param chunks - List of chunks belonging to this output module.
 * @param om_ldat_data - Parsed OutputModuleSettingsItem from LdatItem.
 * @param render_queue_item - The parent render queue item.
 * @returns OutputModule with parsed attributes.
 */
export const parseOutputModule = _suppressMaterialization().decorate(
  function parse_output_module(
    chunks: Chunk[],
    omLdatData: OutputModuleSettingsItem,
    renderQueueItem: RenderQueueItem,
  ): OutputModule {
    const roouChunk = findByType(chunks, "Roou");

    // The alas (output file path) is present only once a file is set.
    const als2Chunk = findByListTypeOrNull(chunks, "Als2");
    const alasUtf8 = als2Chunk === null ? null : findByTypeOrNull(als2Chunk.chunks, "alas");

    // Format name + file-name template are the last two top-level Utf8 chunks.
    const omUtf8 = filterByType(chunks, "Utf8");
    let nameUtf8: Utf8Chunk | null;
    let fileNameUtf8: Utf8Chunk | null;
    if (omUtf8.length >= 2) {
      nameUtf8 = omUtf8[omUtf8.length - 2];
      fileNameUtf8 = omUtf8[omUtf8.length - 1];
    } else {
      nameUtf8 = null;
      fileNameUtf8 = null;
    }

    const formatOptions = parseFormatOptions(chunks);

    return new OutputModule({
      _om_ldat: omLdatData,
      _roou: roouChunk,
      _alas_utf8: alasUtf8,
      _file_name_utf8: fileNameUtf8,
      _name_utf8: nameUtf8,
      _render_settings_ldat: renderQueueItem._ldat,
      parent: renderQueueItem,
      format_options: formatOptions,
    });
  },
);
