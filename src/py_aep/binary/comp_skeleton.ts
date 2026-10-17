/**
 * Typed builders for the view-state skeleton of a new composition item.
 *
 * After Effects writes ~180 chunks of viewer state into every comp item
 * (`LIST:dats`, `cdrp`, `comr`, eleven viewer pseudo-layers in `DLay` /
 * `SLay` / `CLay` / `SecL` lists, `Ewst` blocks, `CIFO`/`CIF2`/`CIF3`,
 * `Gide`) and hard-crashes opening a comp without them. The viewer layers
 * are built from `data/comp_skeleton_specs.py` (generated from AE 2026
 * ground truth by `scripts/dev/gen_comp_skeleton.py`); `$`-prefixed spec
 * strings are expressions over the comp parameters, evaluated here.
 */

import { ae_writes } from "../ae_version.ts";
import { COMP_VIEW_LAYER_SPECS, type GroupSpec, type LayerSpec, type PropSpec, type SpecExtras, type SpecValue } from "../data/comp_skeleton_specs.ts";
import { Chunk, ListChunk } from "./chunk.ts";
import { CdtaChunk, CsctChunk, frame_grid } from "./composition_chunks.ts";
import { IdtaChunk } from "./item_chunks.ts";
import { LdtaChunk } from "./layer_chunks.ts";
import { ClassicPrdaChunk, PrinChunk } from "./misc_chunks.ts";
import { build_gide_list, build_item_id_chunks, build_ovdg, build_ovg2 } from "./mutations.ts";
import { CdatChunk, OtdaChunk, Tdb4Chunk, TdmnChunk, TdsbChunk, TdsnChunk, TdumChunk } from "./property_chunks.ts";
import { S2Chunk, S4Chunk, U1Chunk, U4Chunk, Utf8Chunk } from "./scalar_chunks.ts";
import { b, bytes_, float, floordiv, repr, round, ValueError } from "../../pyrt/index.ts";

/** Build the `fvdv` ... `fifl` view-data septet AE writes after every
 * item's `LIST:Item` (and twice after each comp viewer layer). */
export function build_item_view_chunks(): Chunk[] {
  return [
    new U4Chunk({ chunk_type: "fvdv", value: 3 }),
    new U1Chunk({ chunk_type: "fiop" }),
    new U4Chunk({ chunk_type: "ftts" }),
    new U1Chunk({ chunk_type: "foac" }),
    new U1Chunk({ chunk_type: "fiac" }),
    new S2Chunk({ chunk_type: "fipc" }),
    new U4Chunk({ chunk_type: "fifl" }),
  ];
}

/** Build the per-layer view block AE writes after each layer's LIST
 * (an empty `Ewst` plus two view-data septets). */
export function build_layer_view_block(): Chunk[] {
  return [
    new ListChunk({ list_type: "Ewst", chunks: [] }),
    ...build_item_view_chunks(),
    ...build_item_view_chunks(),
  ];
}

// NOTE(port): the only specs in data/comp_skeleton_specs.ts are `+`/`-`/unary minus over env names and int
// literals (`W2 - ZV`, `-ZV`, `H2 + 5000`, `TB`); there JS doubles and CPython eval agree, so Function stands in.

export function _evaluate(value: SpecValue, env: Record<string, number>): SpecValue {
  if (typeof value === "string" && value.startsWith("$")) {
    const names = Object.keys(env);
    return new Function(...names, `return (${value.slice(1)});`)(...names.map((n) => env[n]));
  }
  return value;
}

export function _build_tdbs(spec: PropSpec, env: Record<string, number>): ListChunk {
  const tdb4 = new Tdb4Chunk(
    Object.fromEntries(Object.entries<SpecValue>(spec["tdb4"]).map(([k, v]) => [k, _evaluate(v, env)])),
  );
  if (tdb4._spatial_marker && !tdb4.color && !tdb4.no_value) {
    // AE writes the comp's pixel aspect into spatial point tdb4s
    // (not orientation / color, despite their spatial marker).
    tdb4.pixel_aspect = env["PAR"];
  }
  const chunks: Chunk[] = [
    new TdsbChunk({ ...(spec["tdsb"] ?? {}) }),
    TdsnChunk.new_(spec["tdsn"]),
    tdb4,
  ];
  const { cdat, tdum, tduM } = spec;
  if (cdat !== undefined) {
    chunks.push(
      new CdatChunk({ values: cdat.map((v) => float(_evaluate(v, env))) }),
    );
  }
  if (tdum !== undefined) {
    chunks.push(new TdumChunk({ chunk_type: "tdum", values: [...tdum] }));
  }
  if (tduM !== undefined) {
    chunks.push(new TdumChunk({ chunk_type: "tduM", values: [...tduM] }));
  }
  return new ListChunk({ list_type: "tdbs", chunks });
}

export function _build_extras(extras: SpecExtras): Chunk[] {
  const out: Chunk[] = [];
  for (const [kind, payload] of extras) {
    if (kind === "OvG2") {
      out.push(build_ovg2());
    } else {
      out.push(new Chunk({ chunk_type: kind, data: bytes_.fromhex(payload) }));
    }
  }
  return out;
}

export function _build_tdgp(
  spec: GroupSpec,
  env: Record<string, number>,
  ae_major: number,
): ListChunk {
  const chunks: Chunk[] = [
    new TdsbChunk({ ...(spec["tdsb"] ?? {}) }),
    TdsnChunk.new_(spec["tdsn"] ?? ""),
  ];
  for (const node of spec["children"]) {
    const [kind, match_name, body, extras] = node;
    if (body.gate !== undefined && !ae_writes(body.gate, ae_major)) continue;
    chunks.push(new TdmnChunk({ value: match_name }));
    if (extras !== undefined) chunks.push(..._build_extras(extras));
    if (kind === "group") {
      chunks.push(_build_tdgp(body, env, ae_major));
    } else if (kind === "prop") {
      chunks.push(_build_tdbs(body, env));
    } else if (kind === "orientation") {
      const otda_values = body.otda.map((v) => float(_evaluate(v, env)));
      const { otda: _otda, ...inner } = body;
      const otky = new ListChunk({
        list_type: "otky",
        chunks: [new OtdaChunk({ values: otda_values })],
      });
      chunks.push(
        new ListChunk({
          list_type: "otst",
          chunks: [_build_tdbs(inner, env), otky],
        }),
      );
    } else {
      throw new ValueError(`unknown spec node kind ${repr(kind)}`);
    }
  }
  chunks.push(new TdmnChunk({ value: "ADBE Group End" }));
  return new ListChunk({ list_type: "tdgp", chunks });
}

export function _build_view_layer(
  spec: LayerSpec,
  env: Record<string, number>,
  layer_id: number,
  ae_major: number,
): ListChunk {
  const ldta_kwargs: Record<string, SpecValue> = Object.fromEntries(
    Object.entries<SpecValue>(spec["ldta"]).map(([k, v]) => [k, _evaluate(v, env)]),
  );
  if (!ae_writes("matte layer id", ae_major)) {
    // The matte-layer field arrived with AE 23: AE 22 writes 160-byte
    // records and refuses a 22-format file with the longer one.
    delete ldta_kwargs.matte_layer_id;
  }
  if (!ae_writes("view layer ldta tail", ae_major)) {
    delete ldta_kwargs.reserved_94;
    delete ldta_kwargs.reserved_98;
  }
  const ldta = new LdtaChunk({ layer_id, ...ldta_kwargs });
  const [gide, _lhd3, _inner] = build_gide_list();
  const chunks: Chunk[] = [
    ldta,
    new Utf8Chunk({ value: spec["name"] }),
    _build_tdgp(spec["tdgp"], env, ae_major),
    gide,
  ];
  if (ae_writes("layer OvdG", ae_major)) {
    chunks.push(build_ovdg());
  }
  return new ListChunk({ list_type: spec["list_type"], chunks });
}

/** Build a `LIST:CpS2` template-name block (`CsCt` + name + locale).
 *
 * Returns `(cps2, name_utf8)` so callers can keep a reference to the
 * name chunk for later edits.
 */
export function build_cps2(name: string): [ListChunk, Utf8Chunk] {
  const name_utf8 = new Utf8Chunk({ value: name });
  const cps2 = new ListChunk({
    list_type: "CpS2",
    chunks: [new CsctChunk(), name_utf8, new Utf8Chunk({ value: "en_US" })],
  });
  return [cps2, name_utf8];
}

export function _build_cif(list_type: string): ListChunk {
  const [cps2, _name_utf8] = build_cps2("Untitled");
  return new ListChunk({
    list_type,
    chunks: [
      cps2,
      new ListChunk({
        list_type: "CapS",
        chunks: [
          new CsctChunk(),
          new U4Chunk({ chunk_type: "CapL" }),
          new Utf8Chunk({ value: "Untitled" }),
        ],
      }),
      new Chunk({ chunk_type: "CPTm", data: b("\x00\x00\x00\x00\x00\x00\x00\x01") }),
      new Chunk({ chunk_type: "CROI", data: bytes_.repeat(b("\x00"), 8) }),
      new S4Chunk({ chunk_type: "CcCt" }),
    ],
  });
}

/**
 * A comp time in timebase units, snapped to the nearest whole frame of
 * the comp's frame grid (`frame_grid`).
 *
 * AE rounds half a frame up (52.5 frames -\> 53, where `round` gives 52),
 * measured on AE 2026 for `addComp`, the `duration` setter and a frame-rate
 * change. Snapping in whole timebase units keeps a value built as
 * `frames / 23.976` on its frame even though the stored rate is only
 * 16.16-accurate.
 */
export function _frame_units(seconds: number, timebase: number, units_per_frame: number): number {
  const units = round(seconds * timebase);
  return floordiv(units + floordiv(units_per_frame, 2), units_per_frame) * units_per_frame;
}

/** A comp duration in timebase units, snapped like `_frame_units`.
 *
 * Under half a frame, AE stores a zero-length composition; py_aep keeps one
 * frame instead.
 */
export function _duration_units(duration: number, timebase: number, units_per_frame: number): number {
  return Math.max(_frame_units(duration, timebase, units_per_frame), units_per_frame);
}

/** Build a `cdta` matching AE's new-comp field encoding (600-based
 * cursor / work-area divisors, duration in timebase units). */
export function _build_cdta(
  width: number,
  height: number,
  pixel_aspect: number,
  duration: number,
  frame_rate: number,
): CdtaChunk {
  const cdta = new CdtaChunk({ width, height });
  cdta.frame_rate = frame_rate;
  // The grid of the rate as given: the stored 16.16 rate of 3.3333 fps
  // (3.33329773) would round 8000 units a frame to 7999.
  const [timebase, units_per_frame] = frame_grid(frame_rate);
  cdta.time_dividend = 0;
  cdta.time_divisor = 600;
  cdta.work_area_start_dividend = 0;
  cdta.work_area_start_divisor = 600;
  cdta.work_area_end_divisor = 600;
  cdta.duration_dividend = _duration_units(duration, timebase, units_per_frame);
  cdta.duration_divisor = timebase;
  cdta.pixel_aspect = pixel_aspect;
  cdta.display_start_time_dividend = 0;
  return cdta;
}

/** Build the complete `LIST:Item` chunk tree AE 2026 writes for
 * `app.project.items.addComp()`.
 *
 * `ae_major` is the project's After Effects major version: the parts that
 * release does not write are left out (see `ae_writes`). `label` is the
 * "Comp Label Index 2" label preference (AE factory value 15). Returns
 * `(item_list, idta, name_utf8, gide)`.
 */
export function build_new_comp_item(kw: {
  item_id: number;
  name: string;
  width: number;
  height: number;
  pixel_aspect: number;
  duration: number;
  frame_rate: number;
  allocate_layer_id: () => number;
  ae_major: number;
  label?: number;
}): [ListChunk, IdtaChunk, Utf8Chunk, ListChunk] {
  const {
    item_id,
    name,
    width,
    height,
    pixel_aspect,
    duration,
    frame_rate,
    allocate_layer_id,
    ae_major,
    label = 15,
  } = kw;
  const idta = new IdtaChunk({ item_type: 4, item_id, label, flags_17: 0x20 });
  const name_utf8 = new Utf8Chunk({ value: name });
  const cdta = _build_cdta(width, height, pixel_aspect, duration, frame_rate);
  const prin = new ListChunk({
    list_type: "PRin",
    chunks: [new PrinChunk(), new ClassicPrdaChunk()],
  });

  const env: Record<string, number> = {
    W2: width / 2.0,
    H2: height / 2.0,
    ZV: (width * pixel_aspect) / 0.72,
    TB: cdta.internal_timebase,
    DUR_UNITS: cdta.duration_dividend,
    PAR: pixel_aspect,
    SHADOW_ALPHA: ae_writes("markers shadow alpha", ae_major) ? 255.0 : 0.0,
  };

  const children: Chunk[] = [
    ...build_item_id_chunks(item_id, ae_major),
    idta,
    name_utf8,
    new ListChunk({
      list_type: "dats",
      chunks: [new Chunk({ chunk_type: "numS", data: bytes_.repeat(b("\x00"), 4) })],
    }),
    cdta,
    new U1Chunk({ chunk_type: "cdrp" }),
  ];
  if (ae_writes("comr", ae_major)) {
    children.push(new Chunk({ chunk_type: "comr", data: b("\x00") }));
  }
  children.push(prin);
  for (const spec of COMP_VIEW_LAYER_SPECS) {
    if (spec.gate !== undefined && !ae_writes(spec.gate, ae_major)) continue;
    children.push(_build_view_layer(spec, env, allocate_layer_id(), ae_major));
    children.push(...build_layer_view_block());
  }
  const cif_types = ["CIFO", "CIF2"];
  if (ae_writes("CIF3", ae_major)) {
    cif_types.push("CIF3");
  }
  children.push(...cif_types.map((t) => _build_cif(t)));
  const [gide, _lhd3, _inner] = build_gide_list();
  children.push(gide);

  const item_list = new ListChunk({ list_type: "Item", chunks: children });
  return [item_list, idta, name_utf8, gide];
}
