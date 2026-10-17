/** Chunk tree mutation helpers for the binary I/O layer. */

import { b64encode } from "../../pyrt/base64.ts";
import { uuid4_bytes } from "../../pyrt/uuid.ts";

import {
  b,
  bytes_,
  BytesIO,
  copy,
  encode,
  floordiv,
  getitem,
  len,
  rstrip,
  struct,
  ValueError,
  py_assert,
  py_or,
} from "../../pyrt/index.ts";
import { ae_writes } from "../ae_version.ts";
import { DROPDOWN_CONTROL } from "../data/dropdown_control.ts";
import { Chunk, ContainerChunk, ListChunk, read_chunks, write_chunk } from "./chunk.ts";
import { CsctChunk } from "./composition_chunks.ts";
import { IdpcChunk } from "./item_chunks.ts";
import { GdtaChunk, KfColor, KfMultiDimensional, KfNoValue, KfPosition, LdatChunk, LdatItem, LdatItemType, Lhd3Chunk } from "./ldat_chunks.ts";
import type { ShapePoint } from "./ldat_chunks.ts";
import { ApidChunk, DcuiChunk, DropChunk, EmbpChunk, EmpdChunk, EpidChunk, Fth5Chunk, HdrmChunk, IpwsChunk, LinlChunk, McspChunk, OcspChunk, OmtnChunk, PguiChunk, PrgbChunk, ShphChunk, StrtChunk, TensionItem } from "./misc_chunks.ts";
import type { FeatherPointItem } from "./misc_chunks.ts";
import { TDSN_SENTINEL, CdatChunk, Tdb4Chunk, TdmnChunk, TdsbChunk, TdsnChunk } from "./property_chunks.ts";
import { RoutItem } from "./render_chunks.ts";
import { F8Chunk, S4Chunk, U4Chunk, U4LeChunk, Utf8Chunk } from "./scalar_chunks.ts";
import { filter_by_type, recursive_find } from "./utils.ts";

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
export function zeros_list(n: number): number[] {
  return Array.from({ length: n }, () => 0.0);
}

/** Remove all chunks of `chunk_type` from the list in-place. */
export function remove_chunks_by_type(chunks: Chunk[], chunk_type: string): void {
  let i = chunks.length - 1;
  while (i >= 0) {
    if (chunks[i].chunk_type === chunk_type) {
      chunks.splice(i, 1);
    }
    i -= 1;
  }
}

/**
 * Add or remove a single-byte flag chunk.
 *
 * When `enable` is true and no chunk of `chunk_type` exists, call
 * `factory()` to create one and append it. When false, remove all
 * matching chunks.
 */
export function toggle_flag_chunk(
  chunks: Chunk[],
  chunk_type: string,
  enable: boolean,
  factory: () => Chunk,
): void {
  const has = chunks.some((c) => c.chunk_type === chunk_type);
  if (enable && !has) {
    chunks.push(factory());
  } else if (!enable && has) {
    remove_chunks_by_type(chunks, chunk_type);
  }
}

/** Clear the `synthetic` flag on tdmn chunks adjacent to `target`. */
export function _unflag_markers(parent_chunks: Chunk[], target: ListChunk): void {
  let idx: number | null = null;
  for (const [i, c] of parent_chunks.entries()) {
    if (c === target) {
      idx = i;
      break;
    }
  }
  if (idx == null) return;
  if (idx > 0 && parent_chunks[idx - 1].chunk_type === "tdmn") {
    parent_chunks[idx - 1].synthetic = false;
  }
  if (idx + 1 < parent_chunks.length && parent_chunks[idx + 1].chunk_type === "tdmn") {
    parent_chunks[idx + 1].synthetic = false;
  }
}

/**
 * Point effect internal-param (`-0000`) tdpi chunks at `layer_id`.
 *
 * Every effect's hidden `-0000` parameter carries the owning layer's
 * id in its `tdpi`; AE rewrites these when a layer is duplicated.
 * Layer-reference tdpi values (regular value params) keep pointing at
 * the referenced layer and are left untouched.
 */
export function rewrite_owner_tdpi(chunk: Chunk, layer_id: number): void {
  if (!(chunk instanceof ListChunk)) return;
  const chunks = chunk.chunks;
  for (const [i, c] of chunks.entries()) {
    const next = chunks[i + 1];
    if (
      c.chunk_type === "tdmn" &&
      (c as TdmnChunk).value.endsWith("-0000") &&
      i + 1 < chunks.length &&
      next instanceof ListChunk
    ) {
      for (const tdpi of filter_by_type(next.chunks, "tdpi")) {
        tdpi.value = layer_id;
      }
    } else if (c instanceof ListChunk) {
      rewrite_owner_tdpi(c, layer_id);
    }
  }
}

/** Every layer id referenced by a LAYER parameter under `chunk`.
 *
 * The hidden `-0000` owner params are excluded: those name the owning
 * layer, not a reference (see `rewrite_owner_tdpi`).
 */
export function collect_layer_ref_tdpi_ids(chunk: Chunk, out: Set<number> | null = null): Set<number> {
  if (out == null) out = new Set<number>();
  if (!(chunk instanceof ListChunk)) return out;
  const chunks = chunk.chunks;
  for (const [i, c] of chunks.entries()) {
    const next = chunks[i + 1];
    if (
      c.chunk_type === "tdmn" &&
      i + 1 < chunks.length &&
      next instanceof ListChunk &&
      !(c as TdmnChunk).value.endsWith("-0000")
    ) {
      for (const tdpi of filter_by_type(next.chunks, "tdpi")) {
        if (tdpi.value) {
          out.add(tdpi.value);
        }
      }
    }
    if (c instanceof ListChunk) {
      collect_layer_ref_tdpi_ids(c, out);
    }
  }
  return out;
}

/** Retarget every layer-reference `tdpi` in `chunk` through `id_map`.
 *
 * A LAYER parameter (Set Matte's "Take Matte From Layer", CC Sphere's
 * light layer, Layer Control, ...) stores the referenced layer's id in a
 * `tdpi`. Moving the owning layer to another composition leaves that id
 * naming a layer the new comp does not contain, and After Effects then
 * refuses the whole file: "Can't find layer ID=N in composition X".
 *
 * Ids absent from `id_map` are cleared to 0 (no layer), which is what AE
 * writes for a copy whose reference did not travel with it. The hidden
 * `-0000` owner params are skipped - `rewrite_owner_tdpi` owns those.
 */
export function remap_layer_ref_tdpi(chunk: Chunk, id_map: Map<number, number>): void {
  if (!(chunk instanceof ListChunk)) return;
  const chunks = chunk.chunks;
  for (const [i, c] of chunks.entries()) {
    const next = chunks[i + 1];
    if (
      c.chunk_type === "tdmn" &&
      i + 1 < chunks.length &&
      next instanceof ListChunk
    ) {
      if ((c as TdmnChunk).value.endsWith("-0000")) continue;
      for (const tdpi of filter_by_type(next.chunks, "tdpi")) {
        if (tdpi.value) {
          tdpi.value = id_map.get(tdpi.value) ?? 0;
        }
      }
    }
    if (c instanceof ListChunk) {
      remap_layer_ref_tdpi(c, id_map);
    }
  }
}

/** Restamp every non-zero `tdb4` timebase in `chunk` to `time_base`.
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
export function rewrite_time_base(chunk: Chunk, time_base: number): void {
  for (const found of recursive_find([chunk], "tdb4")) {
    const tdb4 = found;
    if (tdb4._time_base) {
      tdb4._time_base = time_base;
    }
  }
}

/** Drop every synthetic chunk under `chunk`, in place.
 *
 * `write_aep` skips synthetic chunks, so a subtree that is MOVED rather
 * than serialized carries them along - and a re-parse then reads them as
 * though they came from the file. The parser has no way to tell that a
 * synthesized cdat holds a default in whatever units its synthesizer used
 * (user units for a transform, `parT` 0-512 for an effect point, ARGB
 * 0-255 for a colour), so it resolves them as real values and the model
 * disagrees with the file it just wrote. Removing them lets synthesis run
 * again on the far side, exactly as it does when the file is re-opened.
 */
export function strip_synthetic(chunk: Chunk): void {
  if (!(chunk instanceof ListChunk)) return;
  chunk.chunks.splice(0, chunk.chunks.length, ...chunk.chunks.filter((c) => !c.synthetic));
  for (const child of chunk.chunks) {
    strip_synthetic(child);
  }
}

/** Deep-copy a chunk tree via serialize/deserialize round-trip.
 *
 * Synthetic chunks are excluded during serialization, so the clone
 * contains only real (non-synthetic) chunks.
 */
export function clone_chunk_tree<T extends Chunk>(chunk: T): T extends ListChunk ? ListChunk : T;
export function clone_chunk_tree(chunk: Chunk): Chunk {
  const buf = new BytesIO();
  const size = write_chunk(buf, chunk);
  buf.seek(0);
  return read_chunks(buf, size)[0];
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
export function build_keyframe_list(
  item_type: LdatItemType,
  item_size: number,
): [ListChunk, Lhd3Chunk, LdatChunk] {
  const lhd3 = new Lhd3Chunk({
    item_size: item_size,
    item_type_raw: _KEYFRAME_ITEM_TYPE_RAW,
    counter_b: 4,
  });
  const ldat = new LdatChunk({ items: [], item_type: item_type, item_size: item_size });
  const inner = new ListChunk({ list_type: "list", chunks: [lhd3, ldat] });
  return [inner, lhd3, ldat];
}

// AE's canonical LIST:LRdr child order: header, output-frames blob,
// render-settings list, item list, settings info.
export const LRDR_CHILD_ORDER = ["Rhed", "Rout", "list", "LItm", "LSIf"] as const;

/**
 * Build the render-queue settings `LIST:list` skeleton (lhd3 + ldat).
 *
 * The lhd3 is sized for the 2246-byte render-settings items AE writes; the
 * ldat starts synthetic so `write_aep()` skips it until the queue's first
 * `add()`. Shared by `RenderQueue._new` and `parse_render_queue`'s
 * degenerate-file rebuild so the two skeletons cannot drift.
 *
 * @returns `(inner, lhd3, ldat)` - the `LIST:list`, its header, and the data chunk.
 */
export function build_rq_settings_list(
  kw: { synthetic?: boolean } = {},
): [ListChunk, Lhd3Chunk, LdatChunk] {
  const { synthetic = false } = kw;
  const lhd3 = new Lhd3Chunk({ item_size: 2246, item_type_raw: 1, counter_b: 1 });
  const ldat = new LdatChunk({ synthetic: true });
  const inner = new ListChunk({ list_type: "list", synthetic: synthetic, chunks: [lhd3, ldat] });
  return [inner, lhd3, ldat];
}

/** Build a fresh keyframe-data payload of `item_type`.
 *
 * Speed / influence are seeded to zero (LINEAR defaults). The caller
 * sets the actual value afterwards (e.g. via `Keyframe.value`).
 */
export function build_kf_data(item_type: LdatItemType, num_value: number): KfColor | KfPosition | KfNoValue | KfMultiDimensional {
  if (item_type === LdatItemType.color) {
    return new KfColor();
  }
  if (item_type === LdatItemType.two_d_spatial || item_type === LdatItemType.three_d_spatial) {
    return new KfPosition({
      value: zeros_list(num_value),
      in_spatial_tangents: zeros_list(num_value),
      out_spatial_tangents: zeros_list(num_value),
      spatial_flags: 1,
    });
  }
  if (item_type === LdatItemType.no_value) {
    return new KfNoValue();
  }
  return new KfMultiDimensional({
    value: zeros_list(num_value),
    in_speed: zeros_list(num_value),
    in_influence: zeros_list(num_value),
    out_speed: zeros_list(num_value),
    out_influence: zeros_list(num_value),
  });
}

/** Wrap a keyframe-data payload in an `LdatItem` with LINEAR defaults. */
export function build_ldat_item(kf_data: KfColor | KfPosition | KfNoValue | KfMultiDimensional | Uint8Array, kw: { spatial: boolean }): LdatItem {
  const { spatial } = kw;
  return new LdatItem({
    time_units: 0,
    in_interpolation_type: 1,
    out_interpolation_type: 1,
    key_flags: spatial ? 7 : 0,
    kf_data: kf_data,
  });
}

/** Mirror orientation angles into a keyframe item's trailing bytes.
 *
 * AE stores a copy of the otda angles after the ease data of each
 * orientation keyframe item: 3 little-endian doubles.
 */
export function set_orientation_item_values(item: LdatItem, values: number[]): void {
  item._trailing = struct.pack("<3d", ...values.slice(0, 3));
}

/** Build a keyframe-header `LdatItem` for a complex (parallel-container) property.
 *
 * Shape, gradient, orientation, marker and text properties store the real
 * per-keyframe value in a sibling container (omks / GCky / otky / mrky /
 * btdk); this header item carries only timing/ease plus type-specific
 * padding. Layouts reverse-engineered from AE 2026 output.
 */
export function build_parallel_ldat_item(
  item_type: LdatItemType,
  orientation_values: number[] | null = null,
): LdatItem {
  const item_size = getitem(ITEM_SIZE_BY_TYPE, item_type);
  // Orientation shares the valueless 48-byte ease prefix with shape and
  // gradient keys; only the trailing padding (which holds a copy of the
  // angles) differs.
  let kf_data: KfNoValue | Uint8Array;
  let interp: number;
  let flags: number;
  if (item_type === LdatItemType.orientation || item_type === LdatItemType.no_value) {
    kf_data = new KfNoValue();
    interp = 1;
    flags = 1;
  } else if (item_type === LdatItemType.marker) {
    // marker, text (HOLD - no interpolation)
    kf_data = bytes_.repeat(b("\x00"), 8);
    interp = 3;
    flags = 0;
  } else {
    // CPython 3.12 repr of an IntEnum member: <LdatItemType.name: value>
    throw new ValueError(
      `unsupported parallel item type <LdatItemType.${LdatItemType.name_of(item_type)}: ${item_type}>`,
    );
  }
  const body_len = 8 + (kf_data instanceof Uint8Array ? kf_data.length : len(kf_data.tobytes()));
  const item = new LdatItem({
    time_units: 0,
    in_interpolation_type: interp,
    out_interpolation_type: interp,
    key_flags: flags,
    kf_data: kf_data,
    trailing: bytes_.repeat(b("\x00"), item_size - body_len),
  });
  if (item_type === LdatItemType.orientation && orientation_values != null) {
    set_orientation_item_values(item, orientation_values);
  }
  return item;
}

/** Build a `shap` LIST chunk: `shph` + point `LIST:list` + `omtn`, then
 * an `fth5` when the path has feather points (the order AE writes).
 *
 * `bbox` is `(top_left_x, top_left_y, bottom_right_x, bottom_right_y)`;
 * `points` are the normalized bezier control points (3 per vertex);
 * `tensions` the per-vertex RotoBezier tensions (empty `omtn` when
 * `null`); `feather_points` are copied, so the source keeps its own.
 */
export function build_shap(
  bbox: [number, number, number, number],
  kw: {
    open_path: boolean;
    points: ShapePoint[];
    tensions?: number[] | null;
    feather_points?: FeatherPointItem[] | null;
  },
): ListChunk {
  const { open_path, points, tensions = null, feather_points = null } = kw;
  const shph = new ShphChunk();
  shph.open = open_path;
  [shph.top_left_x, shph.top_left_y, shph.bottom_right_x, shph.bottom_right_y] = bbox;
  const n_verts = floordiv(points.length, 3);
  const lhd3 = new Lhd3Chunk({
    count: points.length,
    item_size: 8,
    item_type_raw: 4,
    count_b: n_verts,
    counter_a: 1,
    counter_b: 4 * n_verts,
  });
  const ldat = new LdatChunk({
    items: [...points],
    item_type: LdatItemType.shape,
    item_size: 8,
  });
  const inner = new ListChunk({ list_type: "list", chunks: [lhd3, ldat] });
  const omtn = new OmtnChunk({
    tensions: py_or(tensions, []).map((t) => new TensionItem({ value: t })),
  });
  const chunks: Chunk[] = [shph, inner, omtn];
  if (feather_points != null && feather_points.length > 0) {
    // NOTE(port): FeatherPointItem has plain int/float fields and no converters, so a shallow copy equals attrs.evolve(fp).
    chunks.push(new Fth5Chunk({ points: feather_points.map((fp) => copy(fp)) }));
  }
  return new ListChunk({ list_type: "shap", chunks: chunks });
}

/**
 * Build an empty `LIST:Gide` guide container.
 *
 * @returns (gide, lhd3, inner) - the outer Gide list, header chunk, and inner `LIST:list`. Callers
 *   can append an `LdatChunk` to *inner* when guide data is needed.
 */
export function build_gide_list(): [ListChunk, Lhd3Chunk, ListChunk] {
  const lhd3 = new Lhd3Chunk({ item_size: 16, item_type_raw: 2 });
  const inner = new ListChunk({ list_type: "list", chunks: [lhd3] });
  const gide = new ListChunk({ list_type: "Gide", chunks: [new GdtaChunk(), inner] });
  return [gide, lhd3, inner];
}

/** Build the `LIST:OvG2(CprC)` block AE writes after a Layer
 * Overrides tdmn. */
export function build_ovg2(): ListChunk {
  return new ListChunk({ list_type: "OvG2", chunks: [new S4Chunk({ chunk_type: "CprC" })] });
}

/** Build the empty `LIST:OvdG(CprC)` AE 15 writes at the end of every
 * layer (see `ae_writes("layer OvdG")`). */
export function build_ovdg(): ListChunk {
  return new ListChunk({ list_type: "OvdG", chunks: [new S4Chunk({ chunk_type: "CprC" })] });
}

/** Build the `iide` / `idpc` pair that opens a new item's `LIST:Item`,
 * or nothing for a release that does not write them. */
export function build_item_id_chunks(item_id: number, ae_major: number): Chunk[] {
  if (!ae_writes("item ids", ae_major)) {
    return [];
  }
  return [new U4LeChunk({ chunk_type: "iide", value: item_id }), new IdpcChunk()];
}

/** Build the `blsv`/`blsi` pair AE writes after a Layer Source
 * Alternate tdmn. */
export function build_source_alternate_extras(): Chunk[] {
  return [
    new U4Chunk({ chunk_type: "blsv", value: 1 }),
    new U4Chunk({ chunk_type: "blsi" }),
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
export function _build_cctl(
  name: string,
  uuid_str: string,
  controller_type: number,
  value_chunks: Chunk[],
  comp_id: number,
  layer_id: number,
  path_json: string,
): [ListChunk, Utf8Chunk, U4Chunk] {
  const name_utf8 = new Utf8Chunk({ value: name });
  const cps2 = new ListChunk({
    list_type: "CpS2",
    chunks: [new CsctChunk(), name_utf8, new Utf8Chunk({ value: "en_US" })],
  });
  const caps = new ListChunk({
    list_type: "CapS",
    chunks: [new CsctChunk(), new U4Chunk({ chunk_type: "CapL" }), new Utf8Chunk({ value: name })],
  });
  const ctyp = new U4Chunk({ chunk_type: "CTyp", value: controller_type });
  const cprp = new ListChunk({
    list_type: "CPrp",
    chunks: [
      new U4Chunk({ chunk_type: "CCId", value: comp_id }),
      new U4Chunk({ chunk_type: "CLId", value: layer_id }),
      new Utf8Chunk({ value: path_json }),
    ],
  });
  const cctl = new ListChunk({
    list_type: "CCtl",
    chunks: [
      cps2,
      caps,
      new Utf8Chunk({ value: uuid_str }),
      ctyp,
      ...value_chunks,
      new S4Chunk({ chunk_type: "CprC", value: 1 }),
      cprp,
    ],
  });
  return [cctl, name_utf8, ctyp];
}

/** Build a Slider (CTyp 2) controller. `CVal`/`CDef` both take the
 * property's value at add time, matching AE. */
export function build_slider_cctl(
  name: string,
  uuid_str: string,
  value: number,
  slider_min: number,
  slider_max: number,
  comp_id: number,
  layer_id: number,
  path_json: string,
): [ListChunk, Utf8Chunk, U4Chunk] {
  const value_chunks: Chunk[] = [
    new Chunk({ chunk_type: "CVal", data: struct.pack(">d", value) }),
    new Chunk({ chunk_type: "CDef", data: struct.pack(">d", value) }),
    new F8Chunk({ chunk_type: "Smin", value: slider_min }),
    new F8Chunk({ chunk_type: "Smax", value: slider_max }),
  ];
  return _build_cctl(name, uuid_str, 2, value_chunks, comp_id, layer_id, path_json);
}

/** Build a Checkbox (CTyp 1) controller. */
export function build_checkbox_cctl(
  name: string,
  uuid_str: string,
  value: boolean,
  comp_id: number,
  layer_id: number,
  path_json: string,
): [ListChunk, Utf8Chunk, U4Chunk] {
  const byte = value ? b("\x01") : b("\x00");
  const value_chunks: Chunk[] = [
    new Chunk({ chunk_type: "CVal", data: byte }),
    new Chunk({ chunk_type: "CDef", data: byte }),
  ];
  return _build_cctl(name, uuid_str, 1, value_chunks, comp_id, layer_id, path_json);
}

/** Build a Color (CTyp 4) controller. `rgba` is 4 floats in 0-1. */
export function build_color_cctl(
  name: string,
  uuid_str: string,
  rgba: number[],
  comp_id: number,
  layer_id: number,
  path_json: string,
): [ListChunk, Utf8Chunk, U4Chunk] {
  const data = struct.pack(">4f", ...rgba);
  const value_chunks: Chunk[] = [
    new Chunk({ chunk_type: "CVal", data: data }),
    new Chunk({ chunk_type: "CDef", data: data }),
  ];
  return _build_cctl(name, uuid_str, 4, value_chunks, comp_id, layer_id, path_json);
}

/** Build a Source Text (CTyp 6) controller.
 *
 * The two `CFEd` / `CSEd` byte flags mirror the `capProp*Edit` booleans
 * of `font_caps_json` (all disabled); the second JSON is the
 * no-alternate-source reference AE writes for a fresh controller.
 */
export function build_text_cctl(
  name: string,
  uuid_str: string,
  text: string,
  font_caps_json: string,
  comp_id: number,
  layer_id: number,
  path_json: string,
): [ListChunk, Utf8Chunk, U4Chunk] {
  const value_chunks: Chunk[] = [
    new Utf8Chunk({ value: text }),
    new Utf8Chunk({ value: text }),
    new Chunk({ chunk_type: "CFEd", data: b("\x00") }),
    new Chunk({ chunk_type: "CSEd", data: b("\x00") }),
    new Chunk({ chunk_type: "CFEd", data: b("\x00") }),
    new Utf8Chunk({ value: font_caps_json }),
    new Utf8Chunk({ value: '{"compId":-1,"isEnabled":false,"layerId":-1}' }),
    new Chunk({ chunk_type: "CTov", data: b("\x07\x00\x00\x00") }),
  ];
  return _build_cctl(name, uuid_str, 6, value_chunks, comp_id, layer_id, path_json);
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
export function build_media_cctl(
  name: string,
  uuid_str: string,
  width: number,
  height: number,
  in_units: number,
  out_units: number,
  timebase: number,
  thumbnail_name: string,
  comp_id: number,
  layer_id: number,
  path_json: string,
): [ListChunk, Utf8Chunk, U4Chunk] {
  const value_chunks: Chunk[] = [
    new Utf8Chunk({ value: _NULL_UUID }),
    new Utf8Chunk({ value: _NULL_UUID }),
    new U4Chunk({ chunk_type: "CSMw", value: width }),
    new U4Chunk({ chunk_type: "CSMh", value: height }),
    new U4Chunk({ chunk_type: "CSMs", value: in_units }),
    new U4Chunk({ chunk_type: "CSMe", value: out_units }),
    new U4Chunk({ chunk_type: "CSMt", value: timebase }),
    new Chunk({ chunk_type: "CSMp", data: b("\x00\x00\x00\x00\x00\x00\x00\x01") }),
    new Chunk({ chunk_type: "CCEx", data: b("\x01") }),
    new Utf8Chunk({ value: thumbnail_name }),
    new U4Chunk({ chunk_type: "CSMd", value: 2 }),
  ];
  return _build_cctl(name, uuid_str, 14, value_chunks, comp_id, layer_id, path_json);
}

/** An ICC profile as `LIST:CLRS` records it. */
export class ColorProfileRecord {
  /** The profile's 16-byte ICC profile ID (`epid` or `apid`). */
  readonly profile_id: Uint8Array;

  /** The JSON envelope carrying the profile's bytes and name. */
  readonly envelope: string;

  constructor(profile_id: Uint8Array, envelope: string) {
    this.profile_id = profile_id;
    this.envelope = envelope;
  }

  *[Symbol.iterator](): Generator<Uint8Array | string> {
    yield this.profile_id;
    yield this.envelope;
  }
}

/** Build a complete `LIST:Pin` with required companion chunks.
 *
 * `path_chunks` (the `LIST:Als2` path and, for sequences, the
 * prefix/extension `Utf8` chunks) are inserted between the leading
 * empty `Utf8` and `opti`. File sources pass them; solid/placeholder
 * sources (no file path) pass nothing.
 *
 * `layer_name` fills the `Utf8` slot after `sspc`: AE stores the
 * referenced layer's name there when the footage is a single layer of a
 * layered file (chosen-layer or comp import), and leaves it empty
 * otherwise.
 *
 * The `LIST:CLRS` record of the media's own color space takes one of
 * three shapes, each measured from an AE 2026 import:
 *
 * - `embedded_profile` (the profile a PNG/JPEG/TIFF/PSD embeds): `epid`
 *   holds the profile's ID and an `mcsp` pair carries the profile itself.
 *   Interpret Footage shows "Embedded".
 * - `assigned_profile` (the profile AE assigns when the media embeds none
 *   - sRGB for every format measured): `apid` holds its ID and `ocsp`
 *   carries its bytes.
 * - `embedded_profile_name` (a media color space that is named rather than
 *   embedded, e.g. an `.ai` document's): an `empd` flag plus a `Utf8` name.
 *
 * `color_managed` records that the media has a color space of its own even
 * when none of the three is given - AE writes exactly that for a JPEG with
 * no profile. Without it the source falls back to the working space, which
 * is what AE writes for a solid.
 */
export function build_pin_list(
  sspc: Chunk,
  opti: Chunk,
  kw: {
    is_solid?: boolean;
    path_chunks?: Chunk[] | null;
    embedded_profile_name?: string | null;
    embedded_profile?: ColorProfileRecord | null;
    assigned_profile?: ColorProfileRecord | null;
    color_managed?: boolean;
    layer_name?: string;
  } = {},
): ListChunk {
  const {
    is_solid = false,
    path_chunks = null,
    embedded_profile_name = null,
    embedded_profile = null,
    assigned_profile = null,
    color_managed = false,
    layer_name = "",
  } = kw;
  const epid = new EpidChunk();
  const apid = new ApidChunk();
  const ipws = new IpwsChunk({ value: color_managed ? 0 : 1 });
  let media_chunks: Chunk[] = [];
  let embedded_envelope = "";
  let assigned_envelope = "";
  if (embedded_profile != null) {
    epid.data = embedded_profile.profile_id;
    embedded_envelope = embedded_profile.envelope;
    // AE stores the embedded profile twice: once behind a lowercase
    // `mcsp` marker and again behind the `Mcsp` flag below.
    media_chunks = [
      new Chunk({ chunk_type: "mcsp", data: b("\x01") }),
      new Utf8Chunk({ value: embedded_envelope }),
    ];
  } else if (assigned_profile != null) {
    apid.data = assigned_profile.profile_id;
    assigned_envelope = assigned_profile.envelope;
  }

  const clrs_chunks: Chunk[] = [epid, apid];
  if (embedded_profile_name != null) {
    clrs_chunks.push(new EmpdChunk());
    clrs_chunks.push(new Utf8Chunk({ value: embedded_profile_name }));
  }
  clrs_chunks.push(
    new LinlChunk(),
    new EmbpChunk(),
    ipws,
    ...media_chunks,
  );
  if (is_solid) {
    clrs_chunks.push(new DcuiChunk());
    clrs_chunks.push(new PrgbChunk());
  }
  clrs_chunks.push(
    new McspChunk(),
    new Utf8Chunk({ value: embedded_envelope }),
    new OcspChunk(),
    new Utf8Chunk({ value: assigned_envelope }),
    new HdrmChunk(),
    new Utf8Chunk({ value: "{}" }),
  );
  const clrs = new ListChunk({ list_type: "CLRS", chunks: clrs_chunks });

  const mnfo = new ListChunk({
    list_type: "mnfo",
    chunks: [new StrtChunk(), new DropChunk()],
  });

  return new ListChunk({
    list_type: "Pin ",
    chunks: [
      sspc,
      new Utf8Chunk({ value: layer_name }),
      ...py_or(path_chunks, []),
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
export function build_rout_block(): RoutItem[] {
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
export function build_om_container(): ListChunk {
  const lhd3 = new Lhd3Chunk({ count: 0, item_size: 128, item_type_raw: 1, counter_b: 1 });
  const ldat = new LdatChunk({ items: [], item_type: LdatItemType.litm, item_size: 128 });
  return new ListChunk({ list_type: "list", chunks: [lhd3, ldat] });
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
 * @param time_base - The comp's internal timebase (`cdta.internal_timebase`).
 */
export function build_default_path_shape(time_base: number): [TdmnChunk, ListChunk] {
  const tdb4 = new Tdb4Chunk({
    spatial_static_flags: 7,
    pad2a: 1,
    value_hint_type: 2,
    cvot_flags: 7,
    time_base: time_base,
    no_value_flags: 1,
    type_flags: 8,
    spatial_marker: true,
  });
  const tdbs = new ListChunk({
    list_type: "tdbs",
    chunks: [
      new TdsbChunk(),
      TdsnChunk.new_(TDSN_SENTINEL),
      tdb4,
      new CdatChunk({ pad: b("\x00\x00\x00\x00") }),
    ],
  });
  const shap = new ListChunk({
    list_type: "shap",
    chunks: [
      new ShphChunk({ flags: 9, bottom_right_x: 1.0, bottom_right_y: 1.0 }),
      new ListChunk({
        list_type: "list",
        chunks: [new Lhd3Chunk({ item_size: 8, item_type_raw: 4, counter_b: 4 })],
      }),
      new OmtnChunk(),
    ],
  });
  const oms = new ListChunk({
    list_type: "om-s",
    chunks: [tdbs, new ListChunk({ list_type: "omks", chunks: [shap] })],
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
 * @param time_base - The comp's internal timebase (`cdta.internal_timebase`).
 * @param kw - Keyword arguments:
 * - `aspect`: The tdb4 X multiplier AE stamps on a mask path: the layer's mask space in display
 *     pixels, width / height.
 * - `roto_bezier`: Whether the mask-shape `tdsb` roto flag is set. The baked template originates
 *     from an enable-rotoBezier capture (flag on); a plain bezier path write clears it, matching AE
 *     (psd_vector_mask fixtures).
 */
export function build_default_mask_shape(
  time_base: number,
  kw: { aspect: number; roto_bezier?: boolean },
): [TdmnChunk, ListChunk] {
  const { aspect, roto_bezier = false } = kw;
  const raw = bytes_.fromhex(_DEFAULT_ROTO_MASK_SHAPE_OMS);
  const oms = read_chunks(new BytesIO(raw), raw.length)[0];
  py_assert(oms instanceof ListChunk);
  const tdbs = oms.chunks[0];
  py_assert(tdbs instanceof ListChunk);
  for (const c of tdbs.chunks) {
    if (c instanceof Tdb4Chunk) {
      c._time_base = time_base;
      c.pixel_aspect = aspect;
    } else if (c instanceof TdsbChunk) {
      c.roto_bezier = roto_bezier;
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
 * @param match_name - The element match name (e.g. `ADBE Vector Shape - Rect`).
 * @param name - The instance name AE bakes into the tdsn (`"Base N"`).
 * @param kw - Keyword arguments:
 * - `subgroups`: Mandatory empty subgroups to write inside the element, as
 *     `(match_name, tdsb lock flags, tdsb enable flags)` triples.
 * - `path_time_base`: For the Path element (`ADBE Vector Shape - Group`), the comp's internal
 *     timebase; adds the default empty `ADBE Vector Shape` bezier property.
 */
export function build_vector_element(
  match_name: string,
  name: string,
  kw: {
    subgroups?: ReadonlyArray<readonly [string, number, number]>;
    path_time_base?: number | null;
  } = {},
): [TdmnChunk, ListChunk] {
  const { subgroups = [], path_time_base = null } = kw;
  const chunks: Chunk[] = [new TdsbChunk(), TdsnChunk.new_(name)];
  if (path_time_base != null) {
    chunks.push(...build_default_path_shape(path_time_base));
  }
  for (const [sub_match_name, lock_flags, enable_flags] of subgroups) {
    chunks.push(new TdmnChunk({ value: sub_match_name }));
    chunks.push(
      new ListChunk({
        list_type: "tdgp",
        chunks: [
          new TdsbChunk({ lock_flags: lock_flags, enable_flags: enable_flags }),
          TdsnChunk.new_(TDSN_SENTINEL),
          new TdmnChunk({ value: "ADBE Group End" }),
        ],
      }),
    );
  }
  chunks.push(new TdmnChunk({ value: "ADBE Group End" }));
  return [new TdmnChunk({ value: match_name }), new ListChunk({ list_type: "tdgp", chunks: chunks })];
}

/**
 * Build the `(tdmn, LIST:tdgp)` pair AE writes for a freshly added
 * text selector.
 *
 * A new selector is a named group `[tdsb, tdsn("X Selector N"), group end]` whose value children are synthesized on parse. The
 * Range Selector additionally carries an empty `ADBE Text Range Advanced` subgroup in binary (its children are synthesized too);
 * Wiggly and Expression selectors do not.
 *
 * @param match_name - The selector match name (e.g. `ADBE Text Selector`).
 * @param name - The instance name AE bakes into the tdsn (`"Base N"`).
 * @param kw - Keyword arguments:
 * - `has_advanced`: Whether to write the empty Advanced subgroup (Range Selector only).
 */
export function build_text_selector(
  match_name: string,
  name: string,
  kw: { has_advanced: boolean },
): [TdmnChunk, ListChunk] {
  const { has_advanced } = kw;
  const chunks: Chunk[] = [new TdsbChunk(), TdsnChunk.new_(name)];
  if (has_advanced) {
    chunks.push(new TdmnChunk({ value: "ADBE Text Range Advanced" }));
    chunks.push(
      new ListChunk({
        list_type: "tdgp",
        chunks: [
          new TdsbChunk(),
          TdsnChunk.new_(TDSN_SENTINEL),
          new TdmnChunk({ value: "ADBE Group End" }),
        ],
      }),
    );
  }
  chunks.push(new TdmnChunk({ value: "ADBE Group End" }));
  return [new TdmnChunk({ value: match_name }), new ListChunk({ list_type: "tdgp", chunks: chunks })];
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
export function build_text_animator(name: string): [TdmnChunk, ListChunk] {
  const properties_tdgp = new ListChunk({
    list_type: "tdgp",
    chunks: [
      new TdsbChunk(),
      TdsnChunk.new_(TDSN_SENTINEL),
      new TdmnChunk({ value: "ADBE Group End" }),
    ],
  });
  const tdgp = new ListChunk({
    list_type: "tdgp",
    chunks: [
      new TdsbChunk(),
      TdsnChunk.new_(name),
      new TdmnChunk({ value: "ADBE Text Animator Properties" }),
      properties_tdgp,
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
 * @param match_name - The effect match name (e.g. `ADBE Slider Control`).
 * @param display_name - The default effect name, written to `fnam`.
 * @param part_bytes - This control's serialized `LIST:parT` chunk.
 * @param kw - Keyword arguments:
 * - `tdsn_name`: The instance name for the effect tdsn - the unnamed sentinel for a first instance,
 *     `"Name N"` for later ones.
 * - `time_base`: The comp's internal timebase (`cdta.internal_timebase`).
 * - `layer_id`: Id of the layer the effect is applied to.
 * - `layer_param_name`: When set, also write the `-0001` value parameter to the tdgp, with this
 *     tdsn display name.
 */
export function build_expression_control(
  match_name: string,
  display_name: string,
  part_bytes: Uint8Array,
  kw: {
    tdsn_name: string;
    time_base: number;
    layer_id: number;
    layer_param_name?: string | null;
  },
): [TdmnChunk, ListChunk] {
  const { tdsn_name, time_base, layer_id, layer_param_name = null } = kw;
  const part = read_chunks(new BytesIO(part_bytes), part_bytes.length)[0];

  function param_tdbs(name: string, enable_flags: number): ListChunk {
    const tdb4 = new Tdb4Chunk({
      value_hint_type: 1,
      time_base: time_base,
      type_flags: 4,
      property_category: 4,
      reserved_48: 0x80000000,
    });
    return new ListChunk({
      list_type: "tdbs",
      chunks: [
        new TdsbChunk({ enable_flags: enable_flags }),
        TdsnChunk.new_(name),
        tdb4,
        new CdatChunk({ values: [0.0, 0.0, 0.0, 0.0, 0.0] }),
        new S4Chunk({ chunk_type: "tdpi", value: layer_id }),
        new S4Chunk({ chunk_type: "tdps" }),
      ],
    });
  }

  const tdgp_chunks: Chunk[] = [
    new TdsbChunk(),
    TdsnChunk.new_(tdsn_name),
    new TdmnChunk({ value: match_name + "-0000" }),
    param_tdbs("", 3),
  ];
  if (layer_param_name != null) {
    tdgp_chunks.push(
      new TdmnChunk({ value: match_name + "-0001" }),
      param_tdbs(layer_param_name, 1),
    );
  }
  tdgp_chunks.push(
    new TdmnChunk({ value: "ADBE Effect Built In Params" }),
    new ListChunk({
      list_type: "tdgp",
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
    list_type: "sspc",
    chunks: [
      new ContainerChunk({
        chunk_type: "fnam",
        chunks: [new Utf8Chunk({ value: display_name })],
      }),
      part,
      new ListChunk({ list_type: "tdgp", chunks: tdgp_chunks }),
      pgui,
    ],
  });
  return [new TdmnChunk({ value: match_name }), sspc];
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
 * - `tdsn_name`: The instance name for the effect tdsn.
 * - `time_base`: The comp's internal timebase.
 * - `layer_id`: Id of the layer the effect is applied to.
 */
export function build_dropdown_control(kw: {
  tdsn_name: string;
  time_base: number;
  layer_id: number;
}): [TdmnChunk, ListChunk] {
  const { tdsn_name, time_base, layer_id } = kw;
  // uuid4().bytes is 16 random bytes; base64 of those, padding stripped.
  const match_name =
    "Pseudo/@@" + rstrip(b64encode(uuid4_bytes()), "=");
  const part_bytes = bytes_.replace(
    bytes_.fromhex(DROPDOWN_CONTROL.part),
    encode(DROPDOWN_CONTROL.placeholder, "ascii"),
    encode(match_name, "ascii"),
  );
  return build_expression_control(match_name, DROPDOWN_CONTROL.name, part_bytes, {
    tdsn_name: tdsn_name,
    time_base: time_base,
    layer_id: layer_id,
  });
}
