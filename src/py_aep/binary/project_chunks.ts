/**
 * Root-level project chunk types used when building a new project.
 *
 * These chunks appear once at the top of the `RIFX` of every `.aep` and
 * are otherwise opaque to py_aep. They are modelled here with best-guess
 * `fmtField`s and fresh-project defaults (captured from an AE 2026 empty
 * project) so `Project._new()` can build a valid skeleton by instantiating
 * them with no arguments. See `scripts/dev/dump_new_project.py`.
 */

import { b, Bytes, define, encode, field } from "../../pyrt/index.ts";
import { Chunk } from "./chunk.ts";
import { bytesField, s2Field, u1Field, u2Field, u4Field } from "./fmt_field.ts";
import { register } from "./registry.ts";

// ---------------------------------------------------------------------------
// svap - save-app marker (4 bytes); byte 3 tracks the AE build number
// ---------------------------------------------------------------------------

/**
 * Top-of-file marker (4 bytes).
 *
 * The last byte is the AE build number; the leading 3 bytes are stable
 * for AE 2024+ (AE's open gate keys off `head.file_format_version`, not
 * svap).
 */
export class SvapChunk extends Chunk {
  declare chunkType: string;
  declare _prefix: Uint8Array;
  declare buildNumber: number;
}
define(SvapChunk, {
  chunkType: field({ default: "svap" }),
  _prefix: bytesField(3, { default: b("\x0f\x10\x06"), repr: false }),
  buildNumber: u1Field({ default: 0x43 }),
});
register("svap")(SvapChunk);

// ---------------------------------------------------------------------------
// cpid - working-space ICC profile id (16 bytes)
// ---------------------------------------------------------------------------

/**
 * Working-space profile id (16 bytes): the ICC Profile ID (ISO
 * 15076-1 MD5) of the working color space, whose ICC is embedded after
 * `PwCs` (AE 22+) or kept in `LIST:CPPl` (older files). All `0xFF` when
 * the working space is None or the project uses OCIO; a new project
 * has no working space.
 */
export class CpidChunk extends Chunk {
  declare chunkType: string;
  declare data: Uint8Array;
}
define(CpidChunk, {
  chunkType: field({ default: "cpid" }),
  data: field({ default: Bytes.repeat(b("\xff"), 16) }),
});
register("cpid")(CpidChunk);

// ---------------------------------------------------------------------------
// fdta - root folder data (14 bytes)
// ---------------------------------------------------------------------------

/**
 * Root folder descriptor (14 bytes).
 *
 * The leading 10 bytes are zero; the 4-byte tail is an opaque
 * folder-state value that varies per file (AE rewrites it on save).
 */
export class FdtaChunk extends Chunk {
  declare chunkType: string;
  declare _reserved00: Uint8Array;
  declare _tail: Uint8Array;
}
define(FdtaChunk, {
  chunkType: field({ default: "fdta" }),
  _reserved00: bytesField(10, { repr: false }),
  _tail: bytesField(4, { default: b("\x1f\x44\x84\x00"), repr: false }),
});
register("fdta")(FdtaChunk);

// ---------------------------------------------------------------------------
// Rhed - render queue header (20 bytes)
// ---------------------------------------------------------------------------

/** Render queue header (`LRdr/Rhed`, 20 bytes). */
export class RhedChunk extends Chunk {
  declare chunkType: string;
  declare _a: number;
  declare _b: number;
  declare _c: number;
  declare _d: number;
  declare _uid: number;
  declare _e: number;
}
define(RhedChunk, {
  chunkType: field({ default: "Rhed" }),
  _a: u2Field({ default: 1, repr: false }),
  _b: u2Field({ default: 2, repr: false }),
  _c: u4Field({ repr: false }),
  _d: u4Field({ repr: false }),
  // Render-queue identity captured from one empty project. The fixed default
  // is intentional: it keeps newProject() output deterministic, and AE
  // rewrites render-queue state on save - so every generated file sharing
  // this value is inert (it is not a cross-file item/project id).
  _uid: u4Field({ default: 0x03e2076c, repr: false }),
  _e: u4Field({ default: 1, repr: false }),
});
register("Rhed")(RhedChunk);

// ---------------------------------------------------------------------------
// wsns - workspace-name byte length (S2); wsnm - workspace name (UTF-16-LE)
// ---------------------------------------------------------------------------

/**
 * Workspace-name byte length (2 bytes).
 *
 * Holds the byte length of the following `wsnm` chunk. A fresh project's
 * `"Default"` workspace name is 14 bytes in UTF-16-LE.
 */
export class WsnsChunk extends Chunk {
  declare chunkType: string;
  declare value: number;
}
define(WsnsChunk, {
  chunkType: field({ default: "wsns" }),
  value: s2Field({ default: 14 }),
});
register("wsns")(WsnsChunk);

/** Workspace name (variable length, UTF-16-LE). Fresh projects use `"Default"`. */
export class WsnmChunk extends Chunk {
  declare chunkType: string;
  declare data: Uint8Array;
}
define(WsnmChunk, {
  chunkType: field({ default: "wsnm" }),
  data: field({ default: encode("Default", "utf-16-le") }),
});
register("wsnm")(WsnmChunk);
