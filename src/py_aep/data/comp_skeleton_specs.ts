/**
 * View-layer specs for a freshly created composition item.
 *
 * Derived from the comp item After Effects 2026 writes for
 * `app.project.items.addComp()`; verify against re-captured ground truth
 * with `scripts/dev/gen_comp_skeleton.py`. Strings starting with `$` are
 * expressions evaluated at build time with the comp's parameters (see
 * `py_aep.binary.comp_skeleton`):
 *
 * - `TB`: `cdta.internal_timebase` - `DUR_UNITS`: `round(duration * TB)`
 * - `W2` / `H2`: comp center - `ZV`: `width * pixel_aspect / 0.72`
 * - `PAR`: pixel aspect ratio - `FPS`: frame rate
 * - `SHADOW_ALPHA`: the Markers layer's Shadow Color alpha (0 in AE 24)
 *
 * A `"gate"` key (in a view-layer spec or a node body) names the
 * `py_aep.ae_version.ae_writes` part that node belongs to; releases that do
 * not write it leave the node out.
 *
 * The ten viewer pseudo-layers (`DLay` / `SLay` / `CLay`) share one
 * template and differ only in name, the secondary-view flag
 * `ldta.reserved_8c`, the per-view `ADBE Position` value, and the
 * presence of `ADBE Scale`. The `Markers` (`SecL`) layer is unique.
 *
 * The spec structures are shared (aliased) between layers; treat them as
 * immutable.
 */

/** A leaf of a spec: a literal, or a `$`-prefixed expression over the env names. */
export type SpecValue = string | number | boolean;
/** Chunk constructor keywords (`tdsb`, `tdb4`, `ldta`) by field name. */
type SpecFields = Record<string, SpecValue>;
/** The body of a `prop` node: one `LIST:tdbs`. */
export type PropSpec = {
  tdsb?: SpecFields;
  tdsn: string;
  tdb4: SpecFields;
  cdat?: SpecValue[];
  tdum?: number[];
  tduM?: number[];
  gate?: string;
};
/** The body of an `orientation` node: a `tdbs` body plus the `otda` values. */
type OrientationSpec = PropSpec & { otda: SpecValue[] };
/** The body of a `group` node: one `LIST:tdgp`. */
export type GroupSpec = { children: SpecNode[]; tdsb?: SpecFields; tdsn?: string; gate?: string };
/** Raw chunks written after a node's match name, as `(chunk_type, hex payload)`. */
export type SpecExtras = [kind: string, payload: string][];
/** A child of a group: `(kind, match_name, body)`, optionally followed by extras. */
type SpecNode =
  | [kind: "group", matchName: string, body: GroupSpec, extras?: SpecExtras]
  | [kind: "prop", matchName: string, body: PropSpec, extras?: SpecExtras]
  | [kind: "orientation", matchName: string, body: OrientationSpec, extras?: SpecExtras];
/** A prop node (the kind `_boolProp` / `_coefficientProp` build and `_gated` restricts). */
type PropNode = Extract<SpecNode, { 0: "prop" }>;
/** A viewer pseudo-layer. */
export type LayerSpec = { listType: string; name: string; ldta: SpecFields; tdgp: GroupSpec; gate?: string };

// ---------------------------------------------------------------------------
// Shared tdb4 layouts
// ---------------------------------------------------------------------------

// 1-D scalar property (sliders, rotations, opacity).
const _TDB4_SCALAR: SpecFields = {
  valueHintType: 1,
  valueHintFlag: 255,
  cvotFlags: 255,
  timeBase: "$TB",
  typeFlags: 8,
  propertyCategory: 9,
};

// Boolean / checkbox property.
const _TDB4_BOOL: SpecFields = {
  valueHintType: 65535,
  cvotFlags: 4,
  timeBase: "$TB",
  typeFlags: 4,
  propertyCategory: 4,
};

// 3-D spatial point (Anchor Point / Position).
const _TDB4_SPATIAL: SpecFields = {
  dimensions: 3,
  spatialStaticFlags: 15,
  pad2a: 3,
  valueHintType: 65535,
  valueHintFlag: 255,
  cvotFlags: 255,
  timeBase: "$TB",
  typeFlags: 8,
  propertyCategory: 9,
  reserved4c: 3,
  reserved4d: 3,
  spatialMarker: true,
  exprFlags: 1,
};

// ---------------------------------------------------------------------------
// Shared property nodes
// ---------------------------------------------------------------------------

function _boolProp(matchName: string, value: number): PropNode {
  return [
    "prop",
    matchName,
    {
      tdsb: { enableFlags: 3 },
      tdsn: "-_0_/-",
      tdb4: _TDB4_BOOL,
      cdat: [value, 0.0, 0.0, 0.0, 0.0],
    },
  ];
}

/** Material-options slider with 0-100 bounds. */
function _coefficientProp(matchName: string, value: number): PropNode {
  return [
    "prop",
    matchName,
    {
      tdsb: { enableFlags: 3 },
      tdsn: "-_0_/-",
      tdb4: _TDB4_SCALAR,
      cdat: [value, 0.0, 0.0, 0.0, 0.0],
      tdum: [0.0],
      tduM: [100.0],
    },
  ];
}

const _ANCHOR_POINT: SpecNode = [
  "prop",
  "ADBE Anchor Point",
  {
    tdsb: {},
    tdsn: "-_0_/-",
    tdb4: _TDB4_SPATIAL,
    cdat: ["$W2", "$H2", 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
  },
];

function _positionProp(x: number | string, y: number | string, z: number | string): PropNode {
  return [
    "prop",
    "ADBE Position",
    {
      tdsb: {},
      tdsn: "-_0_/-",
      tdb4: _TDB4_SPATIAL,
      cdat: [x, y, z, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    },
  ];
}

// X / Y / Z separation followers (ADBE Position_0 / _1 / _2).
const _SPLIT_POSITIONS: SpecNode[] = [0, 1, 2].map((i): SpecNode => [
  "prop",
  `ADBE Position_${i}`,
  {
    tdsb: { enableFlags: 3 },
    tdsn: "-_0_/-",
    tdb4: _TDB4_SCALAR,
    cdat: [0.0, 0.0, 0.0, 0.0, 0.0],
    tdum: [0.0],
    tduM: [0.0],
  },
]);

const _SCALE: SpecNode = [
  "prop",
  "ADBE Scale",
  {
    tdsb: { enableFlags: 3 },
    tdsn: "-_0_/-",
    tdb4: { dimensions: 3, ..._TDB4_SCALAR },
    cdat: [1.0, 1.0, 1.0, ...Array(12).fill(0.0)],
    tdum: [0.0],
    tduM: [0.0],
  },
];

const _ROTATE_Z: SpecNode = [
  "prop",
  "ADBE Rotate Z",
  {
    tdsb: {},
    tdsn: "-_0_/-",
    tdb4: _TDB4_SCALAR,
    cdat: [0.0, 0.0, 0.0, 0.0, 0.0],
  },
];

const _OPACITY: SpecNode = [
  "prop",
  "ADBE Opacity",
  {
    tdsb: { enableFlags: 3 },
    tdsn: "-_0_/-",
    tdb4: _TDB4_SCALAR,
    cdat: [1.0, 0.0, 0.0, 0.0, 0.0],
    tdum: [0.0],
    tduM: [100.0],
  },
];

const _ENVIR_APPEAR: SpecNode = _boolProp("ADBE Envir Appear in Reflect", 1.0);

/** `node` restricted to the releases that write the `gate` part. */
function _gated(node: PropNode, gate: string): PropNode {
  const [kind, matchName, body] = node;
  return [kind, matchName, { ...body, gate }];
}

// ---------------------------------------------------------------------------
// Viewer layer template (Default + Front/Left/Top/Back/Right/Bottom +
// Custom View 1-3)
// ---------------------------------------------------------------------------

function _viewLayer(
  listType: string,
  name: string,
  position: [number | string, number | string, number | string] | null,
  kw: { hasScale: boolean },
): LayerSpec {
  const { hasScale } = kw;
  const children: SpecNode[] = [_ANCHOR_POINT];
  if (position != null) {
    children.push(_positionProp(...position));
  }
  children.push(..._SPLIT_POSITIONS);
  if (hasScale) {
    children.push(_SCALE);
  }
  children.push(_ROTATE_Z, _OPACITY, _ENVIR_APPEAR);
  // reserved_8c marks the six secondary (SLay) views.
  const secondary = listType === "SLay" ? 1 : 0;
  return {
    listType: listType,
    name,
    ldta: {
      startTimeDivisor: 600,
      inPointDivisor: "$TB",
      outPointDividend: "$DUR_UNITS",
      outPointDivisor: "$TB",
      layerFlags1: 68,
      layerFlags2: 1,
      label: 4,
      layerName: name,
      layerType: 2,
      reserved8c: secondary,
      reserved90: 0x01000000,
      reserved94: 1,
      reserved98: 102.0472440944882,
      matteLayerId: 0,
    },
    tdgp: {
      children: [
        ["group", "ADBE Transform Group", { children, tdsb: {}, tdsn: "-_0_/-" }],
        ["group", "ADBE Camera Options Group", { children: [], tdsb: {}, tdsn: "-_0_/-" }],
      ],
      tdsb: {},
      tdsn: "",
    },
  };
}

// ---------------------------------------------------------------------------
// The unique `Markers` (SecL) layer
// ---------------------------------------------------------------------------

const _LAYER_STYLE_NAMES: string[] = [
  "dropShadow",
  "innerShadow",
  "outerGlow",
  "innerGlow",
  "bevelEmboss",
  "chromeFX",
  "solidFill",
  "gradientFill",
  "patternFill",
  "frameFX",
];

const _MARKERS_LAYER: LayerSpec = {
  listType: "SecL",
  name: "Markers",
  ldta: {
    quality: 2,
    startTimeDivisor: 600,
    inPointDivisor: "$TB",
    outPointDividend: "$DUR_UNITS",
    outPointDivisor: "$TB",
    layerFlags2: 135,
    reserved3b: 1,
    label: 8,
    layerName: "Markers",
    blendingMode: 2,
    layerType: 4,
    reserved90: 0x01000000,
    matteLayerId: 0,
  },
  tdgp: {
    children: [
      [
        "group",
        "ADBE Transform Group",
        {
          children: [
            _SPLIT_POSITIONS[0],
            _SPLIT_POSITIONS[1],
            [
              "orientation",
              "ADBE Orientation",
              {
                tdsb: { enableFlags: 3 },
                tdsn: "-_0_/-",
                tdb4: {
                  spatialStaticFlags: 7,
                  valueHintType: 6,
                  cvotFlags: 7,
                  timeBase: "$TB",
                  noValueFlags: 1,
                  typeFlags: 24,
                  spatialMarker: true,
                },
                cdat: [0.0, 0.0, 0.0],
                otda: [0.0, 0.0, 0.0],
              },
            ],
            [
              "prop",
              "ADBE Rotate X",
              {
                tdsb: { enableFlags: 3 },
                tdsn: "-_0_/-",
                tdb4: _TDB4_SCALAR,
                cdat: [0.0, 0.0, 0.0, 0.0, 0.0],
              },
            ],
            [
              "prop",
              "ADBE Rotate Y",
              {
                tdsb: { enableFlags: 3 },
                tdsn: "-_0_/-",
                tdb4: _TDB4_SCALAR,
                cdat: [0.0, 0.0, 0.0, 0.0, 0.0],
              },
            ],
            _ENVIR_APPEAR,
          ],
          tdsb: {},
          tdsn: "-_0_/-",
        },
      ],
      [
        "group",
        "ADBE Layer Styles",
        {
          children: [
            [
              "group",
              "ADBE Blend Options Group",
              {
                children: [["group", "ADBE Adv Blend Group", { children: [], tdsb: {}, tdsn: "-_0_/-" }]],
                tdsb: { enableFlags: 3 },
                tdsn: "-_0_/-",
              },
            ],
            ..._LAYER_STYLE_NAMES.map((style): SpecNode => [
              "group",
              `${style}/enabled`,
              {
                children: [],
                tdsb: { enableFlags: 2 },
                tdsn: "-_0_/-",
              },
            ]),
          ],
          tdsb: { enableFlags: 3 },
          tdsn: "-_0_/-",
        },
      ],
      [
        "group",
        "ADBE Extrsn Options Group",
        {
          children: [
            [
              "prop",
              "ADBE Bevel Direction",
              {
                tdsb: { enableFlags: 3 },
                tdsn: "-_0_/-",
                tdb4: {
                  valueHintType: 2,
                  timeBase: "$TB",
                  typeFlags: 4,
                  propertyCategory: 4,
                },
                cdat: [1.0, 0.0, 0.0, 0.0, 0.0],
              },
            ],
          ],
          tdsb: { enableFlags: 3 },
          tdsn: "-_0_/-",
        },
      ],
      [
        "group",
        "ADBE Material Options Group",
        {
          children: [
            ...(
              [
                _boolProp("ADBE Casts Shadows", 0.0),
                _coefficientProp("ADBE Light Transmission", 0.0),
                _boolProp("ADBE Accepts Shadows", 1.0),
                _boolProp("ADBE Accepts Lights", 1.0),
                [
                  "prop",
                  "ADBE Shadow Color",
                  {
                    tdsb: { enableFlags: 3 },
                    tdsn: "-_0_/-",
                    tdb4: {
                      dimensions: 4,
                      spatialStaticFlags: 7,
                      valueHintType: 2,
                      valueHintFlag: 255,
                      cvotFlags: 255,
                      timeBase: "$TB",
                      typeFlags: 1,
                      propertyCategory: 1,
                      spatialMarker: true,
                    },
                    cdat: ["$SHADOW_ALPHA", ...Array(11).fill(0.0)],
                  },
                ],
              ] satisfies PropNode[]
            ).map((node) => _gated(node, "markers material")),
            _boolProp("ADBE Appears in Reflections", 1.0),
            ...(
              [
                ["ADBE Ambient Coefficient", 100.0],
                ["ADBE Diffuse Coefficient", 50.0],
                ["ADBE Specular Coefficient", 50.0],
                ["ADBE Shininess Coefficient", 5.0],
                ["ADBE Metal Coefficient", 100.0],
              ] satisfies [string, number][]
            ).map(([matchName, value]) => _gated(_coefficientProp(matchName, value), "markers material")),
            _coefficientProp("ADBE Reflection Coefficient", 0.0),
            _coefficientProp("ADBE Glossiness Coefficient", 100.0),
            _coefficientProp("ADBE Fresnel Coefficient", 0.0),
            _coefficientProp("ADBE Transparency Coefficient", 0.0),
            _coefficientProp("ADBE Transp Rolloff", 0.0),
            [
              "prop",
              "ADBE Index of Refraction",
              {
                tdsb: { enableFlags: 3 },
                tdsn: "-_0_/-",
                tdb4: { ..._TDB4_SCALAR, valueHintType: 65535 },
                cdat: [1.0, 0.0, 0.0, 0.0, 0.0],
                tdum: [1.0],
                tduM: [2.0],
              },
            ],
          ],
          tdsb: { enableFlags: 3 },
          tdsn: "-_0_/-",
        },
      ],
      ["group", "ADBE Audio Group", { children: [], tdsb: { enableFlags: 3 }, tdsn: "-_0_/-" }],
      [
        "group",
        "ADBE Layer Sets",
        {
          children: [],
          tdsb: { enableFlags: 3 },
          tdsn: "-_0_/-",
          gate: "layer sets",
        },
      ],
    ],
    tdsb: {},
    tdsn: "",
  },
};

// ---------------------------------------------------------------------------

export const COMP_VIEW_LAYER_SPECS: LayerSpec[] = [
  {
    ..._viewLayer("DLay", "Default", null, { hasScale: true }),
    gate: "default view layer",
  },
  _viewLayer("SLay", "Front", ["$W2", "$H2", -5000.0], { hasScale: false }),
  _viewLayer("SLay", "Left", ["$W2 - 5000", "$H2", 0.0], { hasScale: false }),
  _viewLayer("SLay", "Top", ["$W2", "$H2 - 5000", 0.0], { hasScale: false }),
  _viewLayer("SLay", "Back", ["$W2", "$H2", 5000.0], { hasScale: false }),
  _viewLayer("SLay", "Right", ["$W2 + 5000", "$H2", 0.0], { hasScale: false }),
  _viewLayer("SLay", "Bottom", ["$W2", "$H2 + 5000", 0.0], { hasScale: false }),
  _viewLayer("CLay", "Custom View 1", ["$W2 - ZV", "$H2 - ZV", "$-ZV"], { hasScale: true }),
  _viewLayer("CLay", "Custom View 2", ["$W2", "$H2 - ZV", "$-ZV"], {
    hasScale: true,
  }),
  _viewLayer("CLay", "Custom View 3", ["$W2 + ZV", "$H2 - ZV", "$-ZV"], { hasScale: true }),
  _MARKERS_LAYER,
];
