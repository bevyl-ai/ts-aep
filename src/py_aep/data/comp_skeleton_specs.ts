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

/** Heterogeneous spec-tree data, read dynamically by the skeleton builder. */
type SpecBody = Record<string, any>;
type SpecNode = [string, string, SpecBody];

// ---------------------------------------------------------------------------
// Shared tdb4 layouts
// ---------------------------------------------------------------------------

// 1-D scalar property (sliders, rotations, opacity).
export const _TDB4_SCALAR: Record<string, number | string | boolean> = {
  value_hint_type: 1,
  value_hint_flag: 255,
  cvot_flags: 255,
  time_base: "$TB",
  type_flags: 8,
  property_category: 9,
};

// Boolean / checkbox property.
export const _TDB4_BOOL: Record<string, number | string | boolean> = {
  value_hint_type: 65535,
  cvot_flags: 4,
  time_base: "$TB",
  type_flags: 4,
  property_category: 4,
};

// 3-D spatial point (Anchor Point / Position).
export const _TDB4_SPATIAL: Record<string, number | string | boolean> = {
  dimensions: 3,
  spatial_static_flags: 15,
  pad2a: 3,
  value_hint_type: 65535,
  value_hint_flag: 255,
  cvot_flags: 255,
  time_base: "$TB",
  type_flags: 8,
  property_category: 9,
  reserved_4c: 3,
  reserved_4d: 3,
  spatial_marker: true,
  expr_flags: 1,
};

// ---------------------------------------------------------------------------
// Shared property nodes
// ---------------------------------------------------------------------------

export function _bool_prop(
  match_name: string,
  value: number,
): SpecNode {
  return [
    "prop",
    match_name,
    {
      tdsb: { enable_flags: 3 },
      tdsn: "-_0_/-",
      tdb4: _TDB4_BOOL,
      cdat: [value, 0.0, 0.0, 0.0, 0.0],
    },
  ];
}

/** Material-options slider with 0-100 bounds. */
export function _coefficient_prop(
  match_name: string,
  value: number,
): SpecNode {
  return [
    "prop",
    match_name,
    {
      tdsb: { enable_flags: 3 },
      tdsn: "-_0_/-",
      tdb4: _TDB4_SCALAR,
      cdat: [value, 0.0, 0.0, 0.0, 0.0],
      tdum: [0.0],
      tduM: [100.0],
    },
  ];
}

export const _ANCHOR_POINT: SpecNode = [
  "prop",
  "ADBE Anchor Point",
  {
    tdsb: {},
    tdsn: "-_0_/-",
    tdb4: _TDB4_SPATIAL,
    cdat: ["$W2", "$H2", 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
  },
];

export function _position_prop(
  x: number | string,
  y: number | string,
  z: number | string,
): SpecNode {
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
export const _SPLIT_POSITIONS: SpecNode[] = [0, 1, 2].map(
  (i): SpecNode => [
    "prop",
    `ADBE Position_${i}`,
    {
      tdsb: { enable_flags: 3 },
      tdsn: "-_0_/-",
      tdb4: _TDB4_SCALAR,
      cdat: [0.0, 0.0, 0.0, 0.0, 0.0],
      tdum: [0.0],
      tduM: [0.0],
    },
  ],
);

export const _SCALE: SpecNode = [
  "prop",
  "ADBE Scale",
  {
    tdsb: { enable_flags: 3 },
    tdsn: "-_0_/-",
    tdb4: { dimensions: 3, ..._TDB4_SCALAR },
    cdat: [1.0, 1.0, 1.0, ...Array(12).fill(0.0)],
    tdum: [0.0],
    tduM: [0.0],
  },
];

export const _ROTATE_Z: SpecNode = [
  "prop",
  "ADBE Rotate Z",
  {
    tdsb: {},
    tdsn: "-_0_/-",
    tdb4: _TDB4_SCALAR,
    cdat: [0.0, 0.0, 0.0, 0.0, 0.0],
  },
];

export const _OPACITY: SpecNode = [
  "prop",
  "ADBE Opacity",
  {
    tdsb: { enable_flags: 3 },
    tdsn: "-_0_/-",
    tdb4: _TDB4_SCALAR,
    cdat: [1.0, 0.0, 0.0, 0.0, 0.0],
    tdum: [0.0],
    tduM: [100.0],
  },
];

export const _ENVIR_APPEAR: SpecNode = _bool_prop(
  "ADBE Envir Appear in Reflect",
  1.0,
);

/** `node` restricted to the releases that write the `gate` part. */
export function _gated(
  node: SpecNode,
  gate: string,
): SpecNode {
  const [kind, match_name, body] = node;
  return [kind, match_name, { ...body, gate }];
}

// ---------------------------------------------------------------------------
// Viewer layer template (Default + Front/Left/Top/Back/Right/Bottom +
// Custom View 1-3)
// ---------------------------------------------------------------------------

export function _view_layer(
  list_type: string,
  name: string,
  position: [number | string, number | string, number | string] | null,
  kw: { has_scale: boolean },
): SpecBody {
  const { has_scale } = kw;
  const children: SpecNode[] = [_ANCHOR_POINT];
  if (position != null) {
    children.push(_position_prop(...position));
  }
  children.push(..._SPLIT_POSITIONS);
  if (has_scale) {
    children.push(_SCALE);
  }
  children.push(_ROTATE_Z, _OPACITY, _ENVIR_APPEAR);
  // reserved_8c marks the six secondary (SLay) views.
  const secondary = list_type === "SLay" ? 1 : 0;
  return {
    list_type,
    name,
    ldta: {
      start_time_divisor: 600,
      in_point_divisor: "$TB",
      out_point_dividend: "$DUR_UNITS",
      out_point_divisor: "$TB",
      layer_flags_1: 68,
      layer_flags_2: 1,
      label: 4,
      layer_name: name,
      layer_type: 2,
      reserved_8c: secondary,
      reserved_90: 0x01000000,
      reserved_94: 1,
      reserved_98: 102.0472440944882,
      matte_layer_id: 0,
    },
    tdgp: {
      children: [
        [
          "group",
          "ADBE Transform Group",
          { children, tdsb: {}, tdsn: "-_0_/-" },
        ],
        [
          "group",
          "ADBE Camera Options Group",
          { children: [], tdsb: {}, tdsn: "-_0_/-" },
        ],
      ],
      tdsb: {},
      tdsn: "",
    },
  };
}

// ---------------------------------------------------------------------------
// The unique `Markers` (SecL) layer
// ---------------------------------------------------------------------------

export const _LAYER_STYLE_NAMES: string[] = [
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

export const _MARKERS_LAYER: SpecBody = {
  list_type: "SecL",
  name: "Markers",
  ldta: {
    quality: 2,
    start_time_divisor: 600,
    in_point_divisor: "$TB",
    out_point_dividend: "$DUR_UNITS",
    out_point_divisor: "$TB",
    layer_flags_2: 135,
    reserved_3b: 1,
    label: 8,
    layer_name: "Markers",
    blending_mode: 2,
    layer_type: 4,
    reserved_90: 0x01000000,
    matte_layer_id: 0,
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
                tdsb: { enable_flags: 3 },
                tdsn: "-_0_/-",
                tdb4: {
                  spatial_static_flags: 7,
                  value_hint_type: 6,
                  cvot_flags: 7,
                  time_base: "$TB",
                  no_value_flags: 1,
                  type_flags: 24,
                  spatial_marker: true,
                },
                cdat: [0.0, 0.0, 0.0],
                otda: [0.0, 0.0, 0.0],
              },
            ],
            [
              "prop",
              "ADBE Rotate X",
              {
                tdsb: { enable_flags: 3 },
                tdsn: "-_0_/-",
                tdb4: _TDB4_SCALAR,
                cdat: [0.0, 0.0, 0.0, 0.0, 0.0],
              },
            ],
            [
              "prop",
              "ADBE Rotate Y",
              {
                tdsb: { enable_flags: 3 },
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
                children: [
                  [
                    "group",
                    "ADBE Adv Blend Group",
                    { children: [], tdsb: {}, tdsn: "-_0_/-" },
                  ],
                ],
                tdsb: { enable_flags: 3 },
                tdsn: "-_0_/-",
              },
            ],
            ..._LAYER_STYLE_NAMES.map(
              (style) => [
                "group",
                `${style}/enabled`,
                {
                  children: [],
                  tdsb: { enable_flags: 2 },
                  tdsn: "-_0_/-",
                },
              ],
            ),
          ],
          tdsb: { enable_flags: 3 },
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
                tdsb: { enable_flags: 3 },
                tdsn: "-_0_/-",
                tdb4: {
                  value_hint_type: 2,
                  time_base: "$TB",
                  type_flags: 4,
                  property_category: 4,
                },
                cdat: [1.0, 0.0, 0.0, 0.0, 0.0],
              },
            ],
          ],
          tdsb: { enable_flags: 3 },
          tdsn: "-_0_/-",
        },
      ],
      [
        "group",
        "ADBE Material Options Group",
        {
          children: [
            ...([
              _bool_prop("ADBE Casts Shadows", 0.0),
              _coefficient_prop("ADBE Light Transmission", 0.0),
              _bool_prop("ADBE Accepts Shadows", 1.0),
              _bool_prop("ADBE Accepts Lights", 1.0),
              [
                "prop",
                "ADBE Shadow Color",
                {
                  tdsb: { enable_flags: 3 },
                  tdsn: "-_0_/-",
                  tdb4: {
                    dimensions: 4,
                    spatial_static_flags: 7,
                    value_hint_type: 2,
                    value_hint_flag: 255,
                    cvot_flags: 255,
                    time_base: "$TB",
                    type_flags: 1,
                    property_category: 1,
                    spatial_marker: true,
                  },
                  cdat: ["$SHADOW_ALPHA", ...Array(11).fill(0.0)],
                },
              ],
            ] satisfies SpecNode[]).map((node) => _gated(node, "markers material")),
            _bool_prop("ADBE Appears in Reflections", 1.0),
            ...([
              ["ADBE Ambient Coefficient", 100.0],
              ["ADBE Diffuse Coefficient", 50.0],
              ["ADBE Specular Coefficient", 50.0],
              ["ADBE Shininess Coefficient", 5.0],
              ["ADBE Metal Coefficient", 100.0],
            ] satisfies [string, number][]).map(([match_name, value]) =>
              _gated(_coefficient_prop(match_name, value), "markers material"),
            ),
            _coefficient_prop("ADBE Reflection Coefficient", 0.0),
            _coefficient_prop("ADBE Glossiness Coefficient", 100.0),
            _coefficient_prop("ADBE Fresnel Coefficient", 0.0),
            _coefficient_prop("ADBE Transparency Coefficient", 0.0),
            _coefficient_prop("ADBE Transp Rolloff", 0.0),
            [
              "prop",
              "ADBE Index of Refraction",
              {
                tdsb: { enable_flags: 3 },
                tdsn: "-_0_/-",
                tdb4: { ..._TDB4_SCALAR, value_hint_type: 65535 },
                cdat: [1.0, 0.0, 0.0, 0.0, 0.0],
                tdum: [1.0],
                tduM: [2.0],
              },
            ],
          ],
          tdsb: { enable_flags: 3 },
          tdsn: "-_0_/-",
        },
      ],
      [
        "group",
        "ADBE Audio Group",
        { children: [], tdsb: { enable_flags: 3 }, tdsn: "-_0_/-" },
      ],
      [
        "group",
        "ADBE Layer Sets",
        {
          children: [],
          tdsb: { enable_flags: 3 },
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

export const COMP_VIEW_LAYER_SPECS: SpecBody[] = [
  {
    ..._view_layer("DLay", "Default", null, { has_scale: true }),
    gate: "default view layer",
  },
  _view_layer("SLay", "Front", ["$W2", "$H2", -5000.0], { has_scale: false }),
  _view_layer("SLay", "Left", ["$W2 - 5000", "$H2", 0.0], { has_scale: false }),
  _view_layer("SLay", "Top", ["$W2", "$H2 - 5000", 0.0], { has_scale: false }),
  _view_layer("SLay", "Back", ["$W2", "$H2", 5000.0], { has_scale: false }),
  _view_layer("SLay", "Right", ["$W2 + 5000", "$H2", 0.0], { has_scale: false }),
  _view_layer("SLay", "Bottom", ["$W2", "$H2 + 5000", 0.0], { has_scale: false }),
  _view_layer(
    "CLay",
    "Custom View 1",
    ["$W2 - ZV", "$H2 - ZV", "$-ZV"],
    { has_scale: true },
  ),
  _view_layer("CLay", "Custom View 2", ["$W2", "$H2 - ZV", "$-ZV"], {
    has_scale: true,
  }),
  _view_layer(
    "CLay",
    "Custom View 3",
    ["$W2 + ZV", "$H2 - ZV", "$-ZV"],
    { has_scale: true },
  ),
  _MARKERS_LAYER,
];
