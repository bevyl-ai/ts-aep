/**
 * Simple scalar and string chunk types.
 *
 * Each class wraps a single value (int, float, or str) and is registered
 * for one or more chunk_type strings via the multi-key `@register` decorator.
 *
 * Integer and float chunks use `fmtField()` to declare their binary format
 * inline - the generic `Chunk.read()` / `write()` handles I/O.
 * String chunks keep a custom `read()` / `write()` (they use encoding, not struct).
 */

import { define, field, decode, encode } from "../../pyrt/index.ts";
import type { ClassAttributes, ByteStream } from "../../pyrt/index.ts";
import { readBytes, writeBytes } from "./bin_utils.ts";
import { Chunk, type ChunkReadKwargs } from "./chunk.ts";
import { f8Field, s2Field, s4Field, u1Field, u2Field, u4Field } from "./fmt_field.ts";
import { register } from "./registry.ts";

// ---------------------------------------------------------------------------
// String base (encoding-based, custom read/write)
// ---------------------------------------------------------------------------

/** Base for variable-length string chunks. */
export class _StringChunkBase extends Chunk {
  declare ["constructor"]: ClassAttributes<typeof _StringChunkBase>;
  static _ENCODING = "";

  declare value: string;

  static read(fp: ByteStream, size: number, kwargs: ChunkReadKwargs = {}): _StringChunkBase {
    const { chunkType = "" } = kwargs;
    const cls = this;
    const raw = readBytes(fp, size);
    return new cls({ chunkType, value: decode(raw, cls._ENCODING) });
  }

  write(fp: ByteStream): number {
    return writeBytes(fp, encode(this.value, this.constructor._ENCODING));
  }
}
define(_StringChunkBase, {
  value: field({ default: "" }),
});

// ---------------------------------------------------------------------------
// Integer chunks (fmt_field declarative - no read/write override)
// ---------------------------------------------------------------------------

/** Unsigned 1-byte integer chunk. */
export class U1Chunk extends Chunk {
  declare value: number;
}
define(U1Chunk, {
  value: u1Field(),
});
register("efdc", "acer", "cdrp", "foac", "fiac", "fiop", "lnrb", "lnrp", "qtlg", "pcms", "PwCs", "pdvc")(U1Chunk);

/** Unsigned 2-byte integer chunk. */
export class U2Chunk extends Chunk {
  declare value: number;
}
define(U2Chunk, {
  value: u2Field(),
});
register("oacc")(U2Chunk);

/** Signed 2-byte integer chunk. */
export class S2Chunk extends Chunk {
  declare value: number;
}
define(S2Chunk, {
  value: s2Field(),
});
register("fivc", "fipc")(S2Chunk);

/** Unsigned 4-byte integer chunk. */
export class U4Chunk extends Chunk {
  declare value: number;
}
define(U4Chunk, {
  value: u4Field(),
});
register(
  "CapL",
  "CCId",
  "CLId",
  "CSMd",
  "CSMe",
  "CSMh",
  "CSMs",
  "CSMt",
  "CSMw",
  "CTyp",
  "blsi",
  "blsv",
  "fovi",
  "fivi",
  "fcid",
  "fvdv",
  "ftts",
  "fifl",
)(U4Chunk);

/**
 * Unsigned 4-byte integer chunk, little-endian inside the big-endian file.
 *
 * `iide` echoes the item id. `sfid` / `mrid` hold the item id of the folder
 * After Effects files new items into (the Solids folder / the Media
 * Replacement Comps folder), 0 when there is none. `StVS` is the file count
 * heading the `LIST:StVc` of an alphabetical image sequence, followed by one
 * `Utf8` file name per frame.
 */
export class U4LeChunk extends Chunk {
  declare value: number;
}
define(U4LeChunk, {
  value: u4Field({ endian: "<" }),
});
register("iide", "mrid", "sfid", "StVS")(U4LeChunk);

/**
 * Signed 4-byte integer chunk.
 *
 * `CprC` is big-endian inside `LIST:CCtl` but little-endian inside
 * `LIST:OvG2` (a layer override count: `03 00 00 00` for three
 * `LIST:CPrp`). py_aep never reads that count and writes it only as 0,
 * so `value` is meaningful for the `LIST:CCtl` copy alone.
 */
export class S4Chunk extends Chunk {
  declare value: number;
}
define(S4Chunk, {
  value: s4Field(),
});
register("tdli", "tdpi", "tdps", "CcCt", "CprC", "parn")(S4Chunk);

// ---------------------------------------------------------------------------
// Float chunks
// ---------------------------------------------------------------------------

/** 8-byte double-precision float chunk. */
export class F8Chunk extends Chunk {
  declare value: number;
}
define(F8Chunk, {
  value: f8Field({ default: 0.0 }),
});
register("Smax", "Smin", "adfr", "ppSn")(F8Chunk);

// ---------------------------------------------------------------------------
// String chunks (concrete)
// ---------------------------------------------------------------------------

/** Variable-length UTF-8 string chunk. */
export class Utf8Chunk extends _StringChunkBase {
  static _ENCODING = "UTF-8";

  declare chunkType: string;
}
define(Utf8Chunk, {
  chunkType: field({ default: "Utf8" }),
});
register("alas", "pjef", "Utf8")(Utf8Chunk);

/** Variable-length ASCII string chunk. */
export class AsciiChunk extends _StringChunkBase {
  static _ENCODING = "ASCII";
}
define(AsciiChunk, {});
register("fitt")(AsciiChunk);
