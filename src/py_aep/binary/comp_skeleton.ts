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

import { aeWrites } from "../ae_version.ts";
import { COMP_VIEW_LAYER_SPECS, type GroupSpec, type LayerSpec, type PropSpec, type SpecExtras, type SpecValue } from "../data/comp_skeleton_specs.ts";
import { Chunk, ListChunk } from "./chunk.ts";
import { CdtaChunk, CsctChunk, frameGrid } from "./composition_chunks.ts";
import { IdtaChunk } from "./item_chunks.ts";
import { LdtaChunk } from "./layer_chunks.ts";
import { ClassicPrdaChunk, PrinChunk } from "./misc_chunks.ts";
import { buildGideList, buildItemIdChunks, buildOvdg, buildOvg2 } from "./mutations.ts";
import { CdatChunk, OtdaChunk, Tdb4Chunk, TdmnChunk, TdsbChunk, TdsnChunk, TdumChunk } from "./property_chunks.ts";
import { S2Chunk, S4Chunk, U1Chunk, U4Chunk, Utf8Chunk } from "./scalar_chunks.ts";
import { Bytes, literal, ValueError } from "../../pyrt/index.ts";

/** Build the `fvdv` ... `fifl` view-data septet AE writes after every
 * item's `LIST:Item` (and twice after each comp viewer layer). */
export function buildItemViewChunks(): Chunk[] {
  return [
    new U4Chunk({ chunkType: "fvdv", value: 3 }),
    new U1Chunk({ chunkType: "fiop" }),
    new U4Chunk({ chunkType: "ftts" }),
    new U1Chunk({ chunkType: "foac" }),
    new U1Chunk({ chunkType: "fiac" }),
    new S2Chunk({ chunkType: "fipc" }),
    new U4Chunk({ chunkType: "fifl" }),
  ];
}

/** Build the per-layer view block AE writes after each layer's LIST
 * (an empty `Ewst` plus two view-data septets). */
export function buildLayerViewBlock(): Chunk[] {
  return [
    new ListChunk({ listType: "Ewst", chunks: [] }),
    ...buildItemViewChunks(),
    ...buildItemViewChunks(),
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

export function _buildTdbs(spec: PropSpec, env: Record<string, number>): ListChunk {
  const tdb4 = new Tdb4Chunk(
    Object.fromEntries(Object.entries<SpecValue>(spec["tdb4"]).map(([k, v]) => [k, _evaluate(v, env)])),
  );
  if (tdb4._spatialMarker && !tdb4.color && !tdb4.noValue) {
    // AE writes the comp's pixel aspect into spatial point tdb4s
    // (not orientation / color, despite their spatial marker).
    tdb4.pixelAspect = env["PAR"];
  }
  const chunks: Chunk[] = [
    new TdsbChunk({ ...(spec["tdsb"] ?? {}) }),
    TdsnChunk.new_(spec["tdsn"]),
    tdb4,
  ];
  const { cdat, tdum, tduM } = spec;
  if (cdat !== undefined) {
    chunks.push(
      new CdatChunk({ values: cdat.map((v) => Number(_evaluate(v, env))) }),
    );
  }
  if (tdum !== undefined) {
    chunks.push(new TdumChunk({ chunkType: "tdum", values: [...tdum] }));
  }
  if (tduM !== undefined) {
    chunks.push(new TdumChunk({ chunkType: "tduM", values: [...tduM] }));
  }
  return new ListChunk({ listType: "tdbs", chunks });
}

export function _buildExtras(extras: SpecExtras): Chunk[] {
  const out: Chunk[] = [];
  for (const [kind, payload] of extras) {
    if (kind === "OvG2") {
      out.push(buildOvg2());
    } else {
      out.push(new Chunk({ chunkType: kind, data: Bytes.fromHex(payload) }));
    }
  }
  return out;
}

export function _buildTdgp(
  spec: GroupSpec,
  env: Record<string, number>,
  aeMajor: number,
): ListChunk {
  const chunks: Chunk[] = [
    new TdsbChunk({ ...(spec["tdsb"] ?? {}) }),
    TdsnChunk.new_(spec["tdsn"] ?? ""),
  ];
  for (const node of spec["children"]) {
    const [kind, matchName, body, extras] = node;
    if (body.gate !== undefined && !aeWrites(body.gate, aeMajor)) continue;
    chunks.push(new TdmnChunk({ value: matchName }));
    if (extras !== undefined) chunks.push(..._buildExtras(extras));
    if (kind === "group") {
      chunks.push(_buildTdgp(body, env, aeMajor));
    } else if (kind === "prop") {
      chunks.push(_buildTdbs(body, env));
    } else if (kind === "orientation") {
      const otdaValues = body.otda.map((v) => Number(_evaluate(v, env)));
      const { otda: _otda, ...inner } = body;
      const otky = new ListChunk({
        listType: "otky",
        chunks: [new OtdaChunk({ values: otdaValues })],
      });
      chunks.push(
        new ListChunk({
          listType: "otst",
          chunks: [_buildTdbs(inner, env), otky],
        }),
      );
    } else {
      throw new ValueError(`unknown spec node kind ${literal(kind)}`);
    }
  }
  chunks.push(new TdmnChunk({ value: "ADBE Group End" }));
  return new ListChunk({ listType: "tdgp", chunks });
}

export function _buildViewLayer(
  spec: LayerSpec,
  env: Record<string, number>,
  layerId: number,
  aeMajor: number,
): ListChunk {
  const ldtaKwargs: Record<string, SpecValue> = Object.fromEntries(
    Object.entries<SpecValue>(spec["ldta"]).map(([k, v]) => [k, _evaluate(v, env)]),
  );
  if (!aeWrites("matte layer id", aeMajor)) {
    // The matte-layer field arrived with AE 23: AE 22 writes 160-byte
    // records and refuses a 22-format file with the longer one.
    delete ldtaKwargs.matteLayerId;
  }
  if (!aeWrites("view layer ldta tail", aeMajor)) {
    delete ldtaKwargs.reserved94;
    delete ldtaKwargs.reserved98;
  }
  const ldta = new LdtaChunk({ layerId, ...ldtaKwargs });
  const [gide, _lhd3, _inner] = buildGideList();
  const chunks: Chunk[] = [
    ldta,
    new Utf8Chunk({ value: spec["name"] }),
    _buildTdgp(spec["tdgp"], env, aeMajor),
    gide,
  ];
  if (aeWrites("layer OvdG", aeMajor)) {
    chunks.push(buildOvdg());
  }
  return new ListChunk({ listType: spec["listType"], chunks });
}

/** Build a `LIST:CpS2` template-name block (`CsCt` + name + locale).
 *
 * Returns `(cps2, name_utf8)` so callers can keep a reference to the
 * name chunk for later edits.
 */
export function buildCps2(name: string): [ListChunk, Utf8Chunk] {
  const nameUtf8 = new Utf8Chunk({ value: name });
  const cps2 = new ListChunk({
    listType: "CpS2",
    chunks: [new CsctChunk(), nameUtf8, new Utf8Chunk({ value: "en_US" })],
  });
  return [cps2, nameUtf8];
}

export function _buildCif(listType: string): ListChunk {
  const [cps2, _nameUtf8] = buildCps2("Untitled");
  return new ListChunk({
    listType: listType,
    chunks: [
      cps2,
      new ListChunk({
        listType: "CapS",
        chunks: [
          new CsctChunk(),
          new U4Chunk({ chunkType: "CapL" }),
          new Utf8Chunk({ value: "Untitled" }),
        ],
      }),
      new Chunk({ chunkType: "CPTm", data: Uint8Array.of(0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01) }),
      new Chunk({ chunkType: "CROI", data: Bytes.repeat(new Uint8Array(1), 8) }),
      new S4Chunk({ chunkType: "CcCt" }),
    ],
  });
}

/**
 * A comp time in timebase units, snapped to the nearest whole frame of
 * the comp's frame grid (`frameGrid`).
 *
 * AE rounds half a frame up (52.5 frames -\> 53, where `round` gives 52),
 * measured on AE 2026 for `addComp`, the `duration` setter and a frame-rate
 * change. Snapping in whole timebase units keeps a value built as
 * `frames / 23.976` on its frame even though the stored rate is only
 * 16.16-accurate.
 */
export function _frameUnits(seconds: number, timebase: number, unitsPerFrame: number): number {
  const units = Math.round(seconds * timebase);
  return Math.floor((units + Math.floor(unitsPerFrame / 2)) / unitsPerFrame) * unitsPerFrame;
}

/** A comp duration in timebase units, snapped like `_frameUnits`.
 *
 * Under half a frame, AE stores a zero-length composition; py_aep keeps one
 * frame instead.
 */
export function _durationUnits(duration: number, timebase: number, unitsPerFrame: number): number {
  return Math.max(_frameUnits(duration, timebase, unitsPerFrame), unitsPerFrame);
}

/** Build a `cdta` matching AE's new-comp field encoding (600-based
 * cursor / work-area divisors, duration in timebase units). */
export function _buildCdta(
  width: number,
  height: number,
  pixelAspect: number,
  duration: number,
  frameRate: number,
): CdtaChunk {
  const cdta = new CdtaChunk({ width, height });
  cdta.frameRate = frameRate;
  // The grid of the rate as given: the stored 16.16 rate of 3.3333 fps
  // (3.33329773) would round 8000 units a frame to 7999.
  const [timebase, unitsPerFrame] = frameGrid(frameRate);
  cdta.timeDividend = 0;
  cdta.timeDivisor = 600;
  cdta.workAreaStartDividend = 0;
  cdta.workAreaStartDivisor = 600;
  cdta.workAreaEndDivisor = 600;
  cdta.durationDividend = _durationUnits(duration, timebase, unitsPerFrame);
  cdta.durationDivisor = timebase;
  cdta.pixelAspect = pixelAspect;
  cdta.displayStartTimeDividend = 0;
  return cdta;
}

/** Build the complete `LIST:Item` chunk tree AE 2026 writes for
 * `app.project.items.addComp()`.
 *
 * `aeMajor` is the project's After Effects major version: the parts that
 * release does not write are left out (see `aeWrites`). `label` is the
 * "Comp Label Index 2" label preference (AE factory value 15). Returns
 * `(item_list, idta, name_utf8, gide)`.
 */
export function buildNewCompItem(kw: {
  itemId: number;
  name: string;
  width: number;
  height: number;
  pixelAspect: number;
  duration: number;
  frameRate: number;
  allocateLayerId: () => number;
  aeMajor: number;
  label?: number;
}): [ListChunk, IdtaChunk, Utf8Chunk, ListChunk] {
  const {
    itemId,
    name,
    width,
    height,
    pixelAspect,
    duration,
    frameRate,
    allocateLayerId,
    aeMajor,
    label = 15,
  } = kw;
  const idta = new IdtaChunk({ itemType: 4, itemId, label, flags17: 0x20 });
  const nameUtf8 = new Utf8Chunk({ value: name });
  const cdta = _buildCdta(width, height, pixelAspect, duration, frameRate);
  const prin = new ListChunk({
    listType: "PRin",
    chunks: [new PrinChunk(), new ClassicPrdaChunk()],
  });

  const env: Record<string, number> = {
    W2: width / 2.0,
    H2: height / 2.0,
    ZV: (width * pixelAspect) / 0.72,
    TB: cdta.internalTimebase,
    DUR_UNITS: cdta.durationDividend,
    PAR: pixelAspect,
    SHADOW_ALPHA: aeWrites("markers shadow alpha", aeMajor) ? 255.0 : 0.0,
  };

  const children: Chunk[] = [
    ...buildItemIdChunks(itemId, aeMajor),
    idta,
    nameUtf8,
    new ListChunk({
      listType: "dats",
      chunks: [new Chunk({ chunkType: "numS", data: Bytes.repeat(new Uint8Array(1), 4) })],
    }),
    cdta,
    new U1Chunk({ chunkType: "cdrp" }),
  ];
  if (aeWrites("comr", aeMajor)) {
    children.push(new Chunk({ chunkType: "comr", data: new Uint8Array(1) }));
  }
  children.push(prin);
  for (const spec of COMP_VIEW_LAYER_SPECS) {
    if (spec.gate !== undefined && !aeWrites(spec.gate, aeMajor)) continue;
    children.push(_buildViewLayer(spec, env, allocateLayerId(), aeMajor));
    children.push(...buildLayerViewBlock());
  }
  const cifTypes = ["CIFO", "CIF2"];
  if (aeWrites("CIF3", aeMajor)) {
    cifTypes.push("CIF3");
  }
  children.push(...cifTypes.map((t) => _buildCif(t)));
  const [gide, _lhd3, _inner] = buildGideList();
  children.push(gide);

  const itemList = new ListChunk({ listType: "Item", chunks: children });
  return [itemList, idta, nameUtf8, gide];
}
