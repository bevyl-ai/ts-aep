/** Chunk tree mutation helpers for the binary I/O layer. */

import { b64encode } from "../../pyrt/base64.ts";
import { uuid4Bytes } from "../../pyrt/uuid.ts";

import {
  b,
  Bytes,
  BytesIO,
  copy,
  encode,
  floordiv,
  getOrThrow,
  rstrip,
  struct,
  ValueError,
  assert,
  truthyOr,
} from "../../pyrt/index.ts";
import { aeWrites } from "../ae_version.ts";
import { DROPDOWN_CONTROL } from "../data/dropdown_control.ts";
import { Chunk, ContainerChunk, ListChunk, readChunks, writeChunk } from "./chunk.ts";
import { CsctChunk } from "./composition_chunks.ts";
import { IdpcChunk } from "./item_chunks.ts";
import { GdtaChunk, KfColor, KfMultiDimensional, KfNoValue, KfPosition, LdatChunk, LdatItem, LdatItemType, Lhd3Chunk } from "./ldat_chunks.ts";
import type { ShapePoint } from "./ldat_chunks.ts";
import { ApidChunk, DcuiChunk, DropChunk, EmbpChunk, EmpdChunk, EpidChunk, Fth5Chunk, HdrmChunk, IpwsChunk, LinlChunk, McspChunk, OcspChunk, OmtnChunk, PguiChunk, PrgbChunk, ShphChunk, StrtChunk, TensionItem } from "./misc_chunks.ts";
import type { FeatherPointItem } from "./misc_chunks.ts";
import { TDSN_SENTINEL, CdatChunk, Tdb4Chunk, TdmnChunk, TdsbChunk, TdsnChunk } from "./property_chunks.ts";
import { RoutItem } from "./render_chunks.ts";
import { F8Chunk, S4Chunk, U4Chunk, U4LeChunk, Utf8Chunk } from "./scalar_chunks.ts";
import { filterByType, isChunkType, recursiveFind } from "./utils.ts";

// Keyframe ldat items always use raw type 4; the effective LdatItemType is
// disambiguated by item_size (and spatial context on re-read).
export const _KEYFRAME_ITEM_TYPE_RAW = 4;

// Fixed serialized byte size per keyframe item type.
export const ITEM_SIZE_BY_TYPE: Map<LdatItemType, number> = new Map<LdatItemType, number>([
  [LdatItemType.color, 152],
  [LdatItemType.three_d_spatial, 128],
  [LdatItemType.three_d, 128],
  [LdatItemType.two_d_spatial, 104],
  [LdatItemType.two_d, 88],
  [LdatItemType.orientation, 80],
  [LdatItemType.no_value, 64],
  [LdatItemType.one_d, 48],
  [LdatItemType.marker, 16],
  [LdatItemType.shape, 8],
]);

/** `[0.0] * n` (Python list repetition; no pyrt shim for lists). */
export function zerosList(n: number): number[] {
  return Array.from({ length: n }, () => 0.0);
}

/** Remove all chunks of `chunkType` from the list in-place. */
export function removeChunksByType(chunks: Chunk[], chunkType: string): void {
  let i = chunks.length - 1;
  while (i >= 0) {
    if (chunks[i].chunkType === chunkType) {
      chunks.splice(i, 1);
    }
    i -= 1;
  }
}

/**
 * Add or remove a single-byte flag chunk.
 *
 * When `enable` is true and no chunk of `chunkType` exists, call
 * `factory()` to create one and append it. When false, remove all
 * matching chunks.
 */
export function toggleFlagChunk(
  chunks: Chunk[],
  chunkType: string,
  enable: boolean,
  factory: () => Chunk,
): void {
  const has = chunks.some((c) => c.chunkType === chunkType);
  if (enable && !has) {
    chunks.push(factory());
  } else if (!enable && has) {
    removeChunksByType(chunks, chunkType);
  }
}

/** Clear the `synthetic` flag on tdmn chunks adjacent to `target`. */
export function _unflagMarkers(parentChunks: Chunk[], target: ListChunk): void {
  let idx: number | null = null;
  for (const [i, c] of parentChunks.entries()) {
    if (c === target) {
      idx = i;
      break;
    }
  }
  if (idx == null) return;
  if (idx > 0 && parentChunks[idx - 1].chunkType === "tdmn") {
    parentChunks[idx - 1].synthetic = false;
  }
  if (idx + 1 < parentChunks.length && parentChunks[idx + 1].chunkType === "tdmn") {
    parentChunks[idx + 1].synthetic = false;
  }
}

/**
 * Point effect internal-param (`-0000`) tdpi chunks at `layerId`.
 *
 * Every effect's hidden `-0000` parameter carries the owning layer's
 * id in its `tdpi`; AE rewrites these when a layer is duplicated.
 * Layer-reference tdpi values (regular value params) keep pointing at
 * the referenced layer and are left untouched.
 */
export function rewriteOwnerTdpi(chunk: Chunk, layerId: number): void {
  if (!(chunk instanceof ListChunk)) return;
  const chunks = chunk.chunks;
  for (const [i, c] of chunks.entries()) {
    const next = chunks[i + 1];
    if (
      isChunkType(c, "tdmn") &&
      c.value.endsWith("-0000") &&
      i + 1 < chunks.length &&
      next instanceof ListChunk
    ) {
      for (const tdpi of filterByType(next.chunks, "tdpi")) {
        tdpi.value = layerId;
      }
    } else if (c instanceof ListChunk) {
      rewriteOwnerTdpi(c, layerId);
    }
  }
}

/** Every layer id referenced by a LAYER parameter under `chunk`.
 *
 * The hidden `-0000` owner params are excluded: those name the owning
 * layer, not a reference (see `rewriteOwnerTdpi`).
 */
export function collectLayerRefTdpiIds(chunk: Chunk, out: Set<number> | null = null): Set<number> {
  if (out == null) out = new Set<number>();
  if (!(chunk instanceof ListChunk)) return out;
  const chunks = chunk.chunks;
  for (const [i, c] of chunks.entries()) {
    const next = chunks[i + 1];
    if (
      isChunkType(c, "tdmn") &&
      i + 1 < chunks.length &&
      next instanceof ListChunk &&
      !c.value.endsWith("-0000")
    ) {
      for (const tdpi of filterByType(next.chunks, "tdpi")) {
        if (tdpi.value) {
          out.add(tdpi.value);
        }
      }
    }
    if (c instanceof ListChunk) {
      collectLayerRefTdpiIds(c, out);
    }
  }
  return out;
}

/** Retarget every layer-reference `tdpi` in `chunk` through `idMap`.
 *
 * A LAYER parameter (Set Matte's "Take Matte From Layer", CC Sphere's
 * light layer, Layer Control, ...) stores the referenced layer's id in a
 * `tdpi`. Moving the owning layer to another composition leaves that id
 * naming a layer the new comp does not contain, and After Effects then
 * refuses the whole file: "Can't find layer ID=N in composition X".
 *
 * Ids absent from `idMap` are cleared to 0 (no layer), which is what AE
 * writes for a copy whose reference did not travel with it. The hidden
 * `-0000` owner params are skipped - `rewriteOwnerTdpi` owns those.
 */
export function remapLayerRefTdpi(chunk: Chunk, idMap: Map<number, number>): void {
  if (!(chunk instanceof ListChunk)) return;
  const chunks = chunk.chunks;
  for (const [i, c] of chunks.entries()) {
    const next = chunks[i + 1];
    if (
      isChunkType(c, "tdmn") &&
      i + 1 < chunks.length &&
      next instanceof ListChunk
    ) {
      if (c.value.endsWith("-0000")) continue;
      for (const tdpi of filterByType(next.chunks, "tdpi")) {
        if (tdpi.value) {
          tdpi.value = idMap.get(tdpi.value) ?? 0;
        }
      }
    }
    if (c instanceof ListChunk) {
      remapLayerRefTdpi(c, idMap);
    }
  }
}

/** Restamp every non-zero `tdb4` timebase in `chunk` to `timeBase`.
 *
 * A `tdb4` carries the timebase of the composition it was written in
 * (`cdta.internal_timebase`). Cloning a subtree into another comp - a
 * different frame rate, or another project entirely - therefore carries
 * a foreign timebase on every parameter AE had already stamped, which
 * misreads that parameter's keyframe times.
 *
 * Parameters AE never stamped keep their `0`: the field is written
 * lazily (see `Property._ensure_time_base`), and a zero there is the
 * "not yet stamped" state, not a 0 fps timebase.
 */
export function rewriteTimeBase(chunk: Chunk, timeBase: number): void {
  for (const found of recursiveFind([chunk], "tdb4")) {
    const tdb4 = found;
    if (tdb4._timeBase) {
      tdb4._timeBase = timeBase;
    }
  }
}

/** Drop every synthetic chunk under `chunk`, in place.
 *
 * `writeAep` skips synthetic chunks, so a subtree that is MOVED rather
 * than serialized carries them along - and a re-parse then reads them as
 * though they came from the file. The parser has no way to tell that a
 * synthesized cdat holds a default in whatever units its synthesizer used
 * (user units for a transform, `parT` 0-512 for an effect point, ARGB
 * 0-255 for a colour), so it resolves them as real values and the model
 * disagrees with the file it just wrote. Removing them lets synthesis run
 * again on the far side, exactly as it does when the file is re-opened.
 */
export function stripSynthetic(chunk: Chunk): void {
  if (!(chunk instanceof ListChunk)) return;
  chunk.chunks.splice(0, chunk.chunks.length, ...chunk.chunks.filter((c) => !c.synthetic));
  for (const child of chunk.chunks) {
    stripSynthetic(child);
  }
}

/** Deep-copy a chunk tree via serialize/deserialize round-trip.
 *
 * Synthetic chunks are excluded during serialization, so the clone
 * contains only real (non-synthetic) chunks.
 */
export function cloneChunkTree<T extends Chunk>(chunk: T): T extends ListChunk ? ListChunk : T;
export function cloneChunkTree(chunk: Chunk): Chunk {
  const buf = new BytesIO();
  const size = writeChunk(buf, chunk);
  buf.seek(0);
  return readChunks(buf, size)[0];
}

/**
 * Build an empty keyframe container `LIST:list` (lhd3 + ldat).
 *
 * The opaque lhd3 counters are seeded to the constant values After
 * Effects writes for every animated property (`_count_b=1`,
 * `_counter_a=1`, `_counter_b=4`), regardless of keyframe count.
 *
 * @returns `(inner, lhd3, ldat)` - the `LIST:list`, its header, and the (empty) data chunk. Callers
 *   append `LdatItem`s to `ldat.items` and keep `lhd3.count` in sync.
 */
export function buildKeyframeList(
  itemType: LdatItemType,
  itemSize: number,
): [ListChunk, Lhd3Chunk, LdatChunk] {
  const lhd3 = new Lhd3Chunk({
    itemSize,
    itemTypeRaw: _KEYFRAME_ITEM_TYPE_RAW,
    counterB: 4,
  });
  const ldat = new LdatChunk({ items: [], itemType, itemSize });
  const inner = new ListChunk({ listType: "list", chunks: [lhd3, ldat] });
  return [inner, lhd3, ldat];
}

// AE's canonical LIST:LRdr child order: header, output-frames blob,
// render-settings list, item list, settings info.
export const LRDR_CHILD_ORDER = ["Rhed", "Rout", "list", "LItm", "LSIf"] as const;

/**
 * Build the render-queue settings `LIST:list` skeleton (lhd3 + ldat).
 *
 * The lhd3 is sized for the 2246-byte render-settings items AE writes; the
 * ldat starts synthetic so `writeAep()` skips it until the queue's first
 * `add()`. Shared by `RenderQueue._new` and `parseRenderQueue`'s
 * degenerate-file rebuild so the two skeletons cannot drift.
 *
 * @returns `(inner, lhd3, ldat)` - the `LIST:list`, its header, and the data chunk.
 */
export function buildRqSettingsList(
  kw: { synthetic?: boolean } = {},
): [ListChunk, Lhd3Chunk, LdatChunk] {
  const { synthetic = false } = kw;
  const lhd3 = new Lhd3Chunk({ itemSize: 2246, itemTypeRaw: 1, counterB: 1 });
  const ldat = new LdatChunk({ synthetic: true });
  const inner = new ListChunk({ listType: "list", synthetic, chunks: [lhd3, ldat] });
  return [inner, lhd3, ldat];
}

/** Build a fresh keyframe-data payload of `itemType`.
 *
 * Speed / influence are seeded to zero (LINEAR defaults). The caller
 * sets the actual value afterwards (e.g. via `Keyframe.value`).
 */
export function buildKfData(itemType: LdatItemType, numValue: number): KfColor | KfPosition | KfNoValue | KfMultiDimensional {
  if (itemType === LdatItemType.color) {
    return new KfColor();
  }
  if (itemType === LdatItemType.two_d_spatial || itemType === LdatItemType.three_d_spatial) {
    return new KfPosition({
      value: zerosList(numValue),
      inSpatialTangents: zerosList(numValue),
      outSpatialTangents: zerosList(numValue),
      spatialFlags: 1,
    });
  }
  if (itemType === LdatItemType.no_value) {
    return new KfNoValue();
  }
  return new KfMultiDimensional({
    value: zerosList(numValue),
    inSpeed: zerosList(numValue),
    inInfluence: zerosList(numValue),
    outSpeed: zerosList(numValue),
    outInfluence: zerosList(numValue),
  });
}

/** Wrap a keyframe-data payload in an `LdatItem` with LINEAR defaults. */
export function buildLdatItem(kfData: KfColor | KfPosition | KfNoValue | KfMultiDimensional | Uint8Array, kw: { spatial: boolean }): LdatItem {
  const { spatial } = kw;
  return new LdatItem({
    timeUnits: 0,
    inInterpolationType: 1,
    outInterpolationType: 1,
    keyFlags: spatial ? 7 : 0,
    kfData,
  });
}

/** Mirror orientation angles into a keyframe item's trailing bytes.
 *
 * AE stores a copy of the otda angles after the ease data of each
 * orientation keyframe item: 3 little-endian doubles.
 */
export function setOrientationItemValues(item: LdatItem, values: number[]): void {
  item._trailing = struct.pack("<3d", ...values.slice(0, 3));
}

/** Build a keyframe-header `LdatItem` for a complex (parallel-container) property.
 *
 * Shape, gradient, orientation, marker and text properties store the real
 * per-keyframe value in a sibling container (omks / GCky / otky / mrky /
 * btdk); this header item carries only timing/ease plus type-specific
 * padding. Layouts reverse-engineered from AE 2026 output.
 */
export function buildParallelLdatItem(
  itemType: LdatItemType,
  orientationValues: number[] | null = null,
): LdatItem {
  const itemSize = getOrThrow(ITEM_SIZE_BY_TYPE, itemType);
  // Orientation shares the valueless 48-byte ease prefix with shape and
  // gradient keys; only the trailing padding (which holds a copy of the
  // angles) differs.
  let kfData: KfNoValue | Uint8Array;
  let interp: number;
  let flags: number;
  if (itemType === LdatItemType.orientation || itemType === LdatItemType.no_value) {
    kfData = new KfNoValue();
    interp = 1;
    flags = 1;
  } else if (itemType === LdatItemType.marker) {
    // marker, text (HOLD - no interpolation)
    kfData = Bytes.repeat(b("\x00"), 8);
    interp = 3;
    flags = 0;
  } else {
    // CPython 3.12 repr of an IntEnum member: <LdatItemType.name: value>
    throw new ValueError(
      `unsupported parallel item type <LdatItemType.${LdatItemType.nameOf(itemType)}: ${itemType}>`,
    );
  }
  const bodyLen = 8 + (kfData instanceof Uint8Array ? kfData.length : kfData.tobytes().length);
  const item = new LdatItem({
    timeUnits: 0,
    inInterpolationType: interp,
    outInterpolationType: interp,
    keyFlags: flags,
    kfData,
    trailing: Bytes.repeat(b("\x00"), itemSize - bodyLen),
  });
  if (itemType === LdatItemType.orientation && orientationValues != null) {
    setOrientationItemValues(item, orientationValues);
  }
  return item;
}

/** Build a `shap` LIST chunk: `shph` + point `LIST:list` + `omtn`, then
 * an `fth5` when the path has feather points (the order AE writes).
 *
 * `bbox` is `(top_left_x, top_left_y, bottom_right_x, bottom_right_y)`;
 * `points` are the normalized bezier control points (3 per vertex);
 * `tensions` the per-vertex RotoBezier tensions (empty `omtn` when
 * `null`); `featherPoints` are copied, so the source keeps its own.
 */
export function buildShap(
  bbox: [number, number, number, number],
  kw: {
    openPath: boolean;
    points: ShapePoint[];
    tensions?: number[] | null;
    featherPoints?: FeatherPointItem[] | null;
  },
): ListChunk {
  const { openPath, points, tensions = null, featherPoints = null } = kw;
  const shph = new ShphChunk();
  shph.open = openPath;
  [shph.topLeftX, shph.topLeftY, shph.bottomRightX, shph.bottomRightY] = bbox;
  const nVerts = floordiv(points.length, 3);
  const lhd3 = new Lhd3Chunk({
    count: points.length,
    itemSize: 8,
    itemTypeRaw: 4,
    countB: nVerts,
    counterA: 1,
    counterB: 4 * nVerts,
  });
  const ldat = new LdatChunk({
    items: [...points],
    itemType: LdatItemType.shape,
    itemSize: 8,
  });
  const inner = new ListChunk({ listType: "list", chunks: [lhd3, ldat] });
  const omtn = new OmtnChunk({
    tensions: truthyOr(tensions, []).map((t) => new TensionItem({ value: t })),
  });
  const chunks: Chunk[] = [shph, inner, omtn];
  if (featherPoints != null && featherPoints.length > 0) {
    // NOTE(port): FeatherPointItem has plain int/float fields and no converters, so a shallow copy equals attrs.evolve(fp).
    chunks.push(new Fth5Chunk({ points: featherPoints.map((fp) => copy(fp)) }));
  }
  return new ListChunk({ listType: "shap", chunks });
}

/**
 * Build an empty `LIST:Gide` guide container.
 *
 * @returns (gide, lhd3, inner) - the outer Gide list, header chunk, and inner `LIST:list`. Callers
 *   can append an `LdatChunk` to *inner* when guide data is needed.
 */
export function buildGideList(): [ListChunk, Lhd3Chunk, ListChunk] {
  const lhd3 = new Lhd3Chunk({ itemSize: 16, itemTypeRaw: 2 });
  const inner = new ListChunk({ listType: "list", chunks: [lhd3] });
  const gide = new ListChunk({ listType: "Gide", chunks: [new GdtaChunk(), inner] });
  return [gide, lhd3, inner];
}

/** Build the `LIST:OvG2(CprC)` block AE writes after a Layer
 * Overrides tdmn. */
export function buildOvg2(): ListChunk {
  return new ListChunk({ listType: "OvG2", chunks: [new S4Chunk({ chunkType: "CprC" })] });
}

/** Build the empty `LIST:OvdG(CprC)` AE 15 writes at the end of every
 * layer (see `ae_writes("layer OvdG")`). */
export function buildOvdg(): ListChunk {
  return new ListChunk({ listType: "OvdG", chunks: [new S4Chunk({ chunkType: "CprC" })] });
}

/** Build the `iide` / `idpc` pair that opens a new item's `LIST:Item`,
 * or nothing for a release that does not write them. */
export function buildItemIdChunks(itemId: number, aeMajor: number): Chunk[] {
  if (!aeWrites("item ids", aeMajor)) {
    return [];
  }
  return [new U4LeChunk({ chunkType: "iide", value: itemId }), new IdpcChunk()];
}

/** Build the `blsv`/`blsi` pair AE writes after a Layer Source
 * Alternate tdmn. */
export function buildSourceAlternateExtras(): Chunk[] {
  return [
    new U4Chunk({ chunkType: "blsv", value: 1 }),
    new U4Chunk({ chunkType: "blsi" }),
  ];
}

/** Assemble a `LIST:CCtl` Essential Graphics controller.
 *
 * Layout per the AE 2025 `essential_graphics` fixtures: localized name
 * (CpS2), Premiere caption (CapS), uuid, CTyp, the type-specific value
 * chunks, then the controlled-property reference (CprC + CPrp holding
 * the source comp item id, the source layer id and the root-to-leaf
 * path JSON).
 *
 * Returns `(cctl, name_utf8, ctyp)` so callers can bind the editable
 * chunks to the controller model.
 */
export function _buildCctl(
  name: string,
  uuidStr: string,
  controllerType: number,
  valueChunks: Chunk[],
  compId: number,
  layerId: number,
  pathJson: string,
): [ListChunk, Utf8Chunk, U4Chunk] {
  const nameUtf8 = new Utf8Chunk({ value: name });
  const cps2 = new ListChunk({
    listType: "CpS2",
    chunks: [new CsctChunk(), nameUtf8, new Utf8Chunk({ value: "en_US" })],
  });
  const caps = new ListChunk({
    listType: "CapS",
    chunks: [new CsctChunk(), new U4Chunk({ chunkType: "CapL" }), new Utf8Chunk({ value: name })],
  });
  const ctyp = new U4Chunk({ chunkType: "CTyp", value: controllerType });
  const cprp = new ListChunk({
    listType: "CPrp",
    chunks: [
      new U4Chunk({ chunkType: "CCId", value: compId }),
      new U4Chunk({ chunkType: "CLId", value: layerId }),
      new Utf8Chunk({ value: pathJson }),
    ],
  });
  const cctl = new ListChunk({
    listType: "CCtl",
    chunks: [
      cps2,
      caps,
      new Utf8Chunk({ value: uuidStr }),
      ctyp,
      ...valueChunks,
      new S4Chunk({ chunkType: "CprC", value: 1 }),
      cprp,
    ],
  });
  return [cctl, nameUtf8, ctyp];
}

/** Build a Slider (CTyp 2) controller. `CVal`/`CDef` both take the
 * property's value at add time, matching AE. */
export function buildSliderCctl(
  name: string,
  uuidStr: string,
  value: number,
  sliderMin: number,
  sliderMax: number,
  compId: number,
  layerId: number,
  pathJson: string,
): [ListChunk, Utf8Chunk, U4Chunk] {
  const valueChunks: Chunk[] = [
    new Chunk({ chunkType: "CVal", data: struct.pack(">d", value) }),
    new Chunk({ chunkType: "CDef", data: struct.pack(">d", value) }),
    new F8Chunk({ chunkType: "Smin", value: sliderMin }),
    new F8Chunk({ chunkType: "Smax", value: sliderMax }),
  ];
  return _buildCctl(name, uuidStr, 2, valueChunks, compId, layerId, pathJson);
}

/** Build a Checkbox (CTyp 1) controller. */
export function buildCheckboxCctl(
  name: string,
  uuidStr: string,
  value: boolean,
  compId: number,
  layerId: number,
  pathJson: string,
): [ListChunk, Utf8Chunk, U4Chunk] {
  const byte = value ? b("\x01") : b("\x00");
  const valueChunks: Chunk[] = [
    new Chunk({ chunkType: "CVal", data: byte }),
    new Chunk({ chunkType: "CDef", data: byte }),
  ];
  return _buildCctl(name, uuidStr, 1, valueChunks, compId, layerId, pathJson);
}

/** Build a Color (CTyp 4) controller. `rgba` is 4 floats in 0-1. */
export function buildColorCctl(
  name: string,
  uuidStr: string,
  rgba: number[],
  compId: number,
  layerId: number,
  pathJson: string,
): [ListChunk, Utf8Chunk, U4Chunk] {
  const data = struct.pack(">4f", ...rgba);
  const valueChunks: Chunk[] = [
    new Chunk({ chunkType: "CVal", data }),
    new Chunk({ chunkType: "CDef", data }),
  ];
  return _buildCctl(name, uuidStr, 4, valueChunks, compId, layerId, pathJson);
}

/** Build a Source Text (CTyp 6) controller.
 *
 * The two `CFEd` / `CSEd` byte flags mirror the `capProp*Edit` booleans
 * of `fontCapsJson` (all disabled); the second JSON is the
 * no-alternate-source reference AE writes for a fresh controller.
 */
export function buildTextCctl(
  name: string,
  uuidStr: string,
  text: string,
  fontCapsJson: string,
  compId: number,
  layerId: number,
  pathJson: string,
): [ListChunk, Utf8Chunk, U4Chunk] {
  const valueChunks: Chunk[] = [
    new Utf8Chunk({ value: text }),
    new Utf8Chunk({ value: text }),
    new Chunk({ chunkType: "CFEd", data: b("\x00") }),
    new Chunk({ chunkType: "CSEd", data: b("\x00") }),
    new Chunk({ chunkType: "CFEd", data: b("\x00") }),
    new Utf8Chunk({ value: fontCapsJson }),
    new Utf8Chunk({ value: '{"compId":-1,"isEnabled":false,"layerId":-1}' }),
    new Chunk({ chunkType: "CTov", data: b("\x07\x00\x00\x00") }),
  ];
  return _buildCctl(name, uuidStr, 6, valueChunks, compId, layerId, pathJson);
}

export const _NULL_UUID = "00000000-0000-0000-0000-000000000000";

/** Build a Media Replacement (CTyp 14) controller.
 *
 * Decoded from the AE 2025 `media_replacement.aep` fixture: the two null
 * uuids are the not-yet-assigned alternate source, `CSMw`/`CSMh` the
 * source item's pixel dimensions, `CSMs`/`CSMe` the layer's in/out points
 * in the comp's internal timebase units (verified: out 30.03003s x 23976
 * = 720000), `CSMt` that timebase, and the trailing Utf8 a thumbnail
 * cache file name AE regenerates on open. `CSMp` (8 bytes), `CCEx` and
 * `CSMd` are written as the constants AE emits for a fresh controller;
 * their semantics are undecoded.
 */
export function buildMediaCctl(
  name: string,
  uuidStr: string,
  width: number,
  height: number,
  inUnits: number,
  outUnits: number,
  timebase: number,
  thumbnailName: string,
  compId: number,
  layerId: number,
  pathJson: string,
): [ListChunk, Utf8Chunk, U4Chunk] {
  const valueChunks: Chunk[] = [
    new Utf8Chunk({ value: _NULL_UUID }),
    new Utf8Chunk({ value: _NULL_UUID }),
    new U4Chunk({ chunkType: "CSMw", value: width }),
    new U4Chunk({ chunkType: "CSMh", value: height }),
    new U4Chunk({ chunkType: "CSMs", value: inUnits }),
    new U4Chunk({ chunkType: "CSMe", value: outUnits }),
    new U4Chunk({ chunkType: "CSMt", value: timebase }),
    new Chunk({ chunkType: "CSMp", data: b("\x00\x00\x00\x00\x00\x00\x00\x01") }),
    new Chunk({ chunkType: "CCEx", data: b("\x01") }),
    new Utf8Chunk({ value: thumbnailName }),
    new U4Chunk({ chunkType: "CSMd", value: 2 }),
  ];
  return _buildCctl(name, uuidStr, 14, valueChunks, compId, layerId, pathJson);
}

/** An ICC profile as `LIST:CLRS` records it. */
export class ColorProfileRecord {
  /** The profile's 16-byte ICC profile ID (`epid` or `apid`). */
  readonly profileId: Uint8Array;

  /** The JSON envelope carrying the profile's bytes and name. */
  readonly envelope: string;

  constructor(profileId: Uint8Array, envelope: string) {
    this.profileId = profileId;
    this.envelope = envelope;
  }

  *[Symbol.iterator](): Generator<Uint8Array | string> {
    yield this.profileId;
    yield this.envelope;
  }
}

/** Build a complete `LIST:Pin` with required companion chunks.
 *
 * `pathChunks` (the `LIST:Als2` path and, for sequences, the
 * prefix/extension `Utf8` chunks) are inserted between the leading
 * empty `Utf8` and `opti`. File sources pass them; solid/placeholder
 * sources (no file path) pass nothing.
 *
 * `layerName` fills the `Utf8` slot after `sspc`: AE stores the
 * referenced layer's name there when the footage is a single layer of a
 * layered file (chosen-layer or comp import), and leaves it empty
 * otherwise.
 *
 * The `LIST:CLRS` record of the media's own color space takes one of
 * three shapes, each measured from an AE 2026 import:
 *
 * - `embeddedProfile` (the profile a PNG/JPEG/TIFF/PSD embeds): `epid`
 *   holds the profile's ID and an `mcsp` pair carries the profile itself.
 *   Interpret Footage shows "Embedded".
 * - `assignedProfile` (the profile AE assigns when the media embeds none
 *   - sRGB for every format measured): `apid` holds its ID and `ocsp`
 *   carries its bytes.
 * - `embeddedProfileName` (a media color space that is named rather than
 *   embedded, e.g. an `.ai` document's): an `empd` flag plus a `Utf8` name.
 *
 * `colorManaged` records that the media has a color space of its own even
 * when none of the three is given - AE writes exactly that for a JPEG with
 * no profile. Without it the source falls back to the working space, which
 * is what AE writes for a solid.
 */
export function buildPinList(
  sspc: Chunk,
  opti: Chunk,
  kw: {
    isSolid?: boolean;
    pathChunks?: Chunk[] | null;
    embeddedProfileName?: string | null;
    embeddedProfile?: ColorProfileRecord | null;
    assignedProfile?: ColorProfileRecord | null;
    colorManaged?: boolean;
    layerName?: string;
  } = {},
): ListChunk {
  const {
    isSolid = false,
    pathChunks = null,
    embeddedProfileName = null,
    embeddedProfile = null,
    assignedProfile = null,
    colorManaged = false,
    layerName = "",
  } = kw;
  const epid = new EpidChunk();
  const apid = new ApidChunk();
  const ipws = new IpwsChunk({ value: colorManaged ? 0 : 1 });
  let mediaChunks: Chunk[] = [];
  let embeddedEnvelope = "";
  let assignedEnvelope = "";
  if (embeddedProfile != null) {
    epid.data = embeddedProfile.profileId;
    embeddedEnvelope = embeddedProfile.envelope;
    // AE stores the embedded profile twice: once behind a lowercase
    // `mcsp` marker and again behind the `Mcsp` flag below.
    mediaChunks = [
      new Chunk({ chunkType: "mcsp", data: b("\x01") }),
      new Utf8Chunk({ value: embeddedEnvelope }),
    ];
  } else if (assignedProfile != null) {
    apid.data = assignedProfile.profileId;
    assignedEnvelope = assignedProfile.envelope;
  }

  const clrsChunks: Chunk[] = [epid, apid];
  if (embeddedProfileName != null) {
    clrsChunks.push(new EmpdChunk());
    clrsChunks.push(new Utf8Chunk({ value: embeddedProfileName }));
  }
  clrsChunks.push(
    new LinlChunk(),
    new EmbpChunk(),
    ipws,
    ...mediaChunks,
  );
  if (isSolid) {
    clrsChunks.push(new DcuiChunk());
    clrsChunks.push(new PrgbChunk());
  }
  clrsChunks.push(
    new McspChunk(),
    new Utf8Chunk({ value: embeddedEnvelope }),
    new OcspChunk(),
    new Utf8Chunk({ value: assignedEnvelope }),
    new HdrmChunk(),
    new Utf8Chunk({ value: "{}" }),
  );
  const clrs = new ListChunk({ listType: "CLRS", chunks: clrsChunks });

  const mnfo = new ListChunk({
    listType: "mnfo",
    chunks: [new StrtChunk(), new DropChunk()],
  });

  return new ListChunk({
    listType: "Pin ",
    chunks: [
      sspc,
      new Utf8Chunk({ value: layerName }),
      ...truthyOr(pathChunks, []),
      opti,
      PguiChunk.new_(),
      clrs,
      mnfo,
      new Utf8Chunk(),
    ],
  });
}

/** Build the fixed block of `Rout` entries AE writes per render queue
 * item (`ROUT_ITEMS_PER_RQ_ITEM` = 1 render flag + 4 slot entries).
 *
 * `state` is a position-dependent slot type code: 0x11 at positions
 * 0/1/3, 0x7B at position 2, 0x88 at position 4.
 */
export function buildRoutBlock(): RoutItem[] {
  return [
    new RoutItem({ flags: 0x40, state: 0x11 }),
    new RoutItem({ flags: 0x80, state: 0x11 }),
    new RoutItem({ flags: 0xa0, state: 0x7b }),
    new RoutItem({ flags: 0x80, state: 0x11 }),
    new RoutItem({ flags: 0xa0, state: 0x88 }),
  ];
}

/** Build an empty output-module metadata container (`LIST:list` with
 * lhd3 + ldat) for a new render queue item.
 *
 * `count_b`/`counter_a`/`counter_b` stay at 1 to match real files; only
 * `count` tracks the output module count.
 */
export function buildOmContainer(): ListChunk {
  const lhd3 = new Lhd3Chunk({ count: 0, itemSize: 128, itemTypeRaw: 1, counterB: 1 });
  const ldat = new LdatChunk({ items: [], itemType: LdatItemType.litm, itemSize: 128 });
  return new ListChunk({ listType: "list", chunks: [lhd3, ldat] });
}

/**
 * Build the `(tdmn, LIST:om-s)` pair for a new Path element's
 * `ADBE Vector Shape` property.
 *
 * AE writes an empty bezier path (no vertices) with a unit bounding
 * box for `addProperty("ADBE Vector Shape - Group")`; the chunk
 * layout mirrors a static mask path (`tdbs` with empty `cdat` plus
 * the `omks > shap` value container).
 *
 * @param timeBase - The comp's internal timebase (`cdta.internal_timebase`).
 */
export function buildDefaultPathShape(timeBase: number): [TdmnChunk, ListChunk] {
  const tdb4 = new Tdb4Chunk({
    spatialStaticFlags: 7,
    pad2a: 1,
    valueHintType: 2,
    cvotFlags: 7,
    timeBase,
    noValueFlags: 1,
    typeFlags: 8,
    spatialMarker: true,
  });
  const tdbs = new ListChunk({
    listType: "tdbs",
    chunks: [
      new TdsbChunk(),
      TdsnChunk.new_(TDSN_SENTINEL),
      tdb4,
      new CdatChunk({ pad: b("\x00\x00\x00\x00") }),
    ],
  });
  const shap = new ListChunk({
    listType: "shap",
    chunks: [
      new ShphChunk({ flags: 9, bottomRightX: 1.0, bottomRightY: 1.0 }),
      new ListChunk({
        listType: "list",
        chunks: [new Lhd3Chunk({ itemSize: 8, itemTypeRaw: 4, counterB: 4 })],
      }),
      new OmtnChunk(),
    ],
  });
  const oms = new ListChunk({
    listType: "om-s",
    chunks: [tdbs, new ListChunk({ listType: "omks", chunks: [shap] })],
  });
  return [new TdmnChunk({ value: "ADBE Vector Shape" }), oms];
}

// AE-exact `ADBE Mask Shape` om-s written when a mask's rotoBezier is
// enabled: the implicit default full-frame rectangle materialized as an
// explicit roto-bezier path. Geometry is normalized [0, 1] (so it is
// comp/layer-size independent); only the embedded tdb4 time_base is
// comp-specific and is patched per call. Captured from AE 2026
// (rotoBezier=true on a freshly added mask); py_aep round-trips it
// byte-identically.
export const _DEFAULT_ROTO_MASK_SHAPE_OMS =
  "4c495354000001c26f6d2d734c495354000000b67464627374647362000000040100000174" +
  "64736e0000000e55746638000000062d5f305f2f2d746462340000007cdb99000100070001" +
  "00020007000060003f1a36e2eb1c432d3ff00000000000003ff00000000000003ff0000000" +
  "0000003ff00000000000000001000800000000000000000000000000000000000000010000" +
  "00000000000000000000000000000000000000000000000000000000000000000000000000" +
  "00000000006364617400000004000000004c495354000000f86f6d6b734c495354000000ec" +
  "736861707368706800000018b3de020100000000000000003f8000003f800000010000004c" +
  "495354000000a86c6973746c6864330000003400d00bee000000000000000c000000040000" +
  "000800000004000000010000001000000000000000000000000000000000000000006c6461" +
  "740000006000000000000000000000000000000000000000003f800000000000003f800000" +
  "000000003f8000003f8000003f8000003f8000003f8000003f8000003f8000003f80000000" +
  "0000003f800000000000003f8000000000000000000000000000006f6d746e000000103f80" +
  "00003f8000003f8000003f800000";

/**
 * Build the `(tdmn, LIST:om-s)` pair AE writes for `ADBE Mask Shape`
 * when a path-less mask first materializes one.
 *
 * A freshly added mask has no Mask Shape subtree (AE treats it as the
 * implicit default full-frame rectangle); enabling rotoBezier or setting
 * a path materializes that default as an explicit path. The geometry is
 * normalized, so only the comp's internal timebase and the layer's
 * aspect vary.
 *
 * @param timeBase - The comp's internal timebase (`cdta.internal_timebase`).
 * @param kw - Keyword arguments:
 * - `aspect`: The tdb4 X multiplier AE stamps on a mask path: the layer's mask space in display
 *     pixels, width / height.
 * - `rotoBezier`: Whether the mask-shape `tdsb` roto flag is set. The baked template originates
 *     from an enable-rotoBezier capture (flag on); a plain bezier path write clears it, matching AE
 *     (psd_vector_mask fixtures).
 */
export function buildDefaultMaskShape(
  timeBase: number,
  kw: { aspect: number; rotoBezier?: boolean },
): [TdmnChunk, ListChunk] {
  const { aspect, rotoBezier = false } = kw;
  const raw = Bytes.fromHex(_DEFAULT_ROTO_MASK_SHAPE_OMS);
  const oms = readChunks(new BytesIO(raw), raw.length)[0];
  assert(oms instanceof ListChunk);
  const tdbs = oms.chunks[0];
  assert(tdbs instanceof ListChunk);
  for (const c of tdbs.chunks) {
    if (c instanceof Tdb4Chunk) {
      c._timeBase = timeBase;
      c.pixelAspect = aspect;
    } else if (c instanceof TdsbChunk) {
      c.rotoBezier = rotoBezier;
    }
  }
  return [new TdmnChunk({ value: "ADBE Mask Shape" }), oms];
}

/**
 * Build the `(tdmn, LIST:tdgp)` pair AE writes for a freshly added
 * shape element.
 *
 * A new element is a named, otherwise empty group: child properties
 * stay at AE-side defaults and are synthesized on parse rather than
 * written to binary. `subgroups` lists the mandatory empty subgroups
 * some elements carry as `(match_name, tdsb lock flags)` pairs.
 *
 * @param matchName - The element match name (e.g. `ADBE Vector Shape - Rect`).
 * @param name - The instance name AE bakes into the tdsn (`"Base N"`).
 * @param kw - Keyword arguments:
 * - `subgroups`: Mandatory empty subgroups to write inside the element, as
 *     `(match_name, tdsb lock flags, tdsb enable flags)` triples.
 * - `pathTimeBase`: For the Path element (`ADBE Vector Shape - Group`), the comp's internal
 *     timebase; adds the default empty `ADBE Vector Shape` bezier property.
 */
export function buildVectorElement(
  matchName: string,
  name: string,
  kw: {
    subgroups?: ReadonlyArray<readonly [string, number, number]>;
    pathTimeBase?: number | null;
  } = {},
): [TdmnChunk, ListChunk] {
  const { subgroups = [], pathTimeBase = null } = kw;
  const chunks: Chunk[] = [new TdsbChunk(), TdsnChunk.new_(name)];
  if (pathTimeBase != null) {
    chunks.push(...buildDefaultPathShape(pathTimeBase));
  }
  for (const [subMatchName, lockFlags, enableFlags] of subgroups) {
    chunks.push(new TdmnChunk({ value: subMatchName }));
    chunks.push(
      new ListChunk({
        listType: "tdgp",
        chunks: [
          new TdsbChunk({ lockFlags, enableFlags }),
          TdsnChunk.new_(TDSN_SENTINEL),
          new TdmnChunk({ value: "ADBE Group End" }),
        ],
      }),
    );
  }
  chunks.push(new TdmnChunk({ value: "ADBE Group End" }));
  return [new TdmnChunk({ value: matchName }), new ListChunk({ listType: "tdgp", chunks })];
}

/**
 * Build the `(tdmn, LIST:tdgp)` pair AE writes for a freshly added
 * text selector.
 *
 * A new selector is a named group `[tdsb, tdsn("X Selector N"), group end]` whose value children are synthesized on parse. The
 * Range Selector additionally carries an empty `ADBE Text Range Advanced` subgroup in binary (its children are synthesized too);
 * Wiggly and Expression selectors do not.
 *
 * @param matchName - The selector match name (e.g. `ADBE Text Selector`).
 * @param name - The instance name AE bakes into the tdsn (`"Base N"`).
 * @param kw - Keyword arguments:
 * - `hasAdvanced`: Whether to write the empty Advanced subgroup (Range Selector only).
 */
export function buildTextSelector(
  matchName: string,
  name: string,
  kw: { hasAdvanced: boolean },
): [TdmnChunk, ListChunk] {
  const { hasAdvanced } = kw;
  const chunks: Chunk[] = [new TdsbChunk(), TdsnChunk.new_(name)];
  if (hasAdvanced) {
    chunks.push(new TdmnChunk({ value: "ADBE Text Range Advanced" }));
    chunks.push(
      new ListChunk({
        listType: "tdgp",
        chunks: [
          new TdsbChunk(),
          TdsnChunk.new_(TDSN_SENTINEL),
          new TdmnChunk({ value: "ADBE Group End" }),
        ],
      }),
    );
  }
  chunks.push(new TdmnChunk({ value: "ADBE Group End" }));
  return [new TdmnChunk({ value: matchName }), new ListChunk({ listType: "tdgp", chunks })];
}

/**
 * Build the `(tdmn, LIST:tdgp)` pair AE writes for a freshly added
 * text animator.
 *
 * A new animator is `[tdsb, tdsn("Animator N"), Animator Properties (empty), group end]`. The empty `ADBE Text Animator Properties`
 * subgroup is in binary; its 103-property pool and the (also empty)
 * `ADBE Text Selectors` group are synthesized on parse.
 *
 * @param name - The instance name AE bakes into the tdsn (`"Animator N"`).
 */
export function buildTextAnimator(name: string): [TdmnChunk, ListChunk] {
  const propertiesTdgp = new ListChunk({
    listType: "tdgp",
    chunks: [
      new TdsbChunk(),
      TdsnChunk.new_(TDSN_SENTINEL),
      new TdmnChunk({ value: "ADBE Group End" }),
    ],
  });
  const tdgp = new ListChunk({
    listType: "tdgp",
    chunks: [
      new TdsbChunk(),
      TdsnChunk.new_(name),
      new TdmnChunk({ value: "ADBE Text Animator Properties" }),
      propertiesTdgp,
      new TdmnChunk({ value: "ADBE Group End" }),
    ],
  });
  return [new TdmnChunk({ value: "ADBE Text Animator" }), tdgp];
}

/**
 * Build the `(tdmn, LIST:sspc)` pair AE writes for a freshly added
 * expression-control effect.
 *
 * The parameter definitions (`LIST:parT`) are baked plugin data from
 * `data/effect_controls.py`. The instance tdgp carries the hidden
 * `-0000` internal parameter (a 1-D scalar whose `tdpi` points at the
 * containing layer) and the named Compositing Options group; value
 * parameters stay at their defaults and are omitted from binary,
 * except the Layer Control's, which AE always writes.
 *
 * @param matchName - The effect match name (e.g. `ADBE Slider Control`).
 * @param displayName - The default effect name, written to `fnam`.
 * @param partBytes - This control's serialized `LIST:parT` chunk.
 * @param kw - Keyword arguments:
 * - `tdsnName`: The instance name for the effect tdsn - the unnamed sentinel for a first instance,
 *     `"Name N"` for later ones.
 * - `timeBase`: The comp's internal timebase (`cdta.internal_timebase`).
 * - `layerId`: Id of the layer the effect is applied to.
 * - `layerParamName`: When set, also write the `-0001` value parameter to the tdgp, with this
 *     tdsn display name.
 */
export function buildExpressionControl(
  matchName: string,
  displayName: string,
  partBytes: Uint8Array,
  kw: {
    tdsnName: string;
    timeBase: number;
    layerId: number;
    layerParamName?: string | null;
  },
): [TdmnChunk, ListChunk] {
  const { tdsnName, timeBase, layerId, layerParamName = null } = kw;
  const part = readChunks(new BytesIO(partBytes), partBytes.length)[0];

  function paramTdbs(name: string, enableFlags: number): ListChunk {
    const tdb4 = new Tdb4Chunk({
      valueHintType: 1,
      timeBase,
      typeFlags: 4,
      propertyCategory: 4,
      reserved48: 0x80000000,
    });
    return new ListChunk({
      listType: "tdbs",
      chunks: [
        new TdsbChunk({ enableFlags }),
        TdsnChunk.new_(name),
        tdb4,
        new CdatChunk({ values: [0.0, 0.0, 0.0, 0.0, 0.0] }),
        new S4Chunk({ chunkType: "tdpi", value: layerId }),
        new S4Chunk({ chunkType: "tdps" }),
      ],
    });
  }

  const tdgpChunks: Chunk[] = [
    new TdsbChunk(),
    TdsnChunk.new_(tdsnName),
    new TdmnChunk({ value: matchName + "-0000" }),
    paramTdbs("", 3),
  ];
  if (layerParamName != null) {
    tdgpChunks.push(
      new TdmnChunk({ value: matchName + "-0001" }),
      paramTdbs(layerParamName, 1),
    );
  }
  tdgpChunks.push(
    new TdmnChunk({ value: "ADBE Effect Built In Params" }),
    new ListChunk({
      listType: "tdgp",
      chunks: [
        new TdsbChunk(),
        TdsnChunk.new_("Compositing Options"),
        new TdmnChunk({ value: "ADBE Group End" }),
      ],
    }),
    new TdmnChunk({ value: "ADBE Group End" }),
  );
  // AE writes an all-zero pgui GUID for every expression control
  // (verified on Slider/Color/Checkbox/Point/Layer + dropdown, AE 2026);
  // PguiChunk() defaults to 16 zero bytes.
  const pgui = new PguiChunk();
  const sspc = new ListChunk({
    listType: "sspc",
    chunks: [
      new ContainerChunk({
        chunkType: "fnam",
        chunks: [new Utf8Chunk({ value: displayName })],
      }),
      part,
      new ListChunk({ listType: "tdgp", chunks: tdgpChunks }),
      pgui,
    ],
  });
  return [new TdmnChunk({ value: matchName }), sspc];
}

/**
 * Build a Dropdown Menu Control - a pseudo-effect whose match name
 * is generated fresh per instance.
 *
 * The match name is `"Pseudo/@@" + base64(uuid4 bytes)` (standard
 * alphabet, padding stripped), always 31 chars - the same length as
 * the captured placeholder in `DROPDOWN_CONTROL["part"]`, so a
 * byte-level substitution into the baked `parT` preserves chunk
 * sizes. The tdgp is the same as a value-less control (only the
 * `-0000` internal param); the Menu enum + items live in the `parT`.
 *
 * @param kw - Keyword arguments:
 * - `tdsnName`: The instance name for the effect tdsn.
 * - `timeBase`: The comp's internal timebase.
 * - `layerId`: Id of the layer the effect is applied to.
 */
export function buildDropdownControl(kw: {
  tdsnName: string;
  timeBase: number;
  layerId: number;
}): [TdmnChunk, ListChunk] {
  const { tdsnName, timeBase, layerId } = kw;
  // uuid4().bytes is 16 random bytes; base64 of those, padding stripped.
  const matchName =
    "Pseudo/@@" + rstrip(b64encode(uuid4Bytes()), "=");
  const partBytes = Bytes.replace(
    Bytes.fromHex(DROPDOWN_CONTROL.part),
    encode(DROPDOWN_CONTROL.placeholder, "ascii"),
    encode(matchName, "ascii"),
  );
  return buildExpressionControl(matchName, DROPDOWN_CONTROL.name, partBytes, {
    tdsnName,
    timeBase,
    layerId,
  });
}
