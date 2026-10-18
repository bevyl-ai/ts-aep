/**
 * Children of the built-in property groups reachable by attribute name.
 *
 * `PropertyGroup.__getattr__` (Python's `group.child_name`) finds a child by
 * its display name in snake_case. For these groups the names below resolve to
 * the same child (by match name) on every instance, in every layer kind and
 * After Effects version the sample corpus covers, so the types can promise
 * them; `tests/read_only/test_child_attributes.test.ts` checks the promise.
 * Names that depend on the layer (`anchor_point` vs `point_of_interest`,
 * `rotation` vs `z_rotation` with the 3D switch) or on the version are left
 * out: reach those children by match name.
 */
export const CHILD_MATCH_NAMES = {
  "ADBE Transform Group": {
    position: "ADBE Position",
    xPosition: "ADBE Position_0",
    yPosition: "ADBE Position_1",
    zPosition: "ADBE Position_2",
    scale: "ADBE Scale",
    orientation: "ADBE Orientation",
    xRotation: "ADBE Rotate X",
    yRotation: "ADBE Rotate Y",
    opacity: "ADBE Opacity",
    appearsInReflections: "ADBE Envir Appear in Reflect",
  },
  "ADBE Text Properties": {
    sourceText: "ADBE Text Document",
    pathOptions: "ADBE Text Path Options",
    moreOptions: "ADBE Text More Options",
    animators: "ADBE Text Animators",
  },
  "ADBE Text Path Options": {
    path: "ADBE Text Path",
    reversePath: "ADBE Text Reverse Path",
    perpendicularToPath: "ADBE Text Perpendicular To Path",
    forceAlignment: "ADBE Text Force Align Path",
    firstMargin: "ADBE Text First Margin",
    lastMargin: "ADBE Text Last Margin",
  },
  "ADBE Text More Options": {
    anchorPointGrouping: "ADBE Text Anchor Point Option",
    groupingAlignment: "ADBE Text Anchor Point Align",
  },
  "ADBE Text Animator": {
    selectors: "ADBE Text Selectors",
  },
  "ADBE Camera Options Group": {
    zoom: "ADBE Camera Zoom",
    depthOfField: "ADBE Camera Depth of Field",
    focusDistance: "ADBE Camera Focus Distance",
    aperture: "ADBE Camera Aperture",
    blurLevel: "ADBE Camera Blur Level",
    irisShape: "ADBE Iris Shape",
    irisRotation: "ADBE Iris Rotation",
    irisRoundness: "ADBE Iris Roundness",
    irisAspectRatio: "ADBE Iris Aspect Ratio",
    irisDiffractionFringe: "ADBE Iris Diffraction Fringe",
    highlightGain: "ADBE Iris Highlight Gain",
    highlightThreshold: "ADBE Iris Highlight Threshold",
    highlightSaturation: "ADBE Iris Hightlight Saturation",
  },
  "ADBE Light Options Group": {
    source: "ADBE Light Env Atom",
    backgroundVisible: "ADBE Light Backgd Visible",
    backgroundOpacity: "ADBE Light Backgd Opacity",
    backgroundBlur: "ADBE Light Backgd Blur",
    intensity: "ADBE Light Intensity",
    color: "ADBE Light Color",
    coneAngle: "ADBE Light Cone Angle",
    coneFeather: "ADBE Light Cone Feather 2",
    falloff: "ADBE Light Falloff Type",
    radius: "ADBE Light Falloff Start",
    falloffDistance: "ADBE Light Falloff Distance",
    castsShadows: "ADBE Casts Shadows",
    shadowDarkness: "ADBE Light Shadow Darkness",
    shadowDiffusion: "ADBE Light Shadow Diffusion",
  },
  "ADBE Plane Options Group": {
    curvature: "ADBE Plane Curvature",
    segments: "ADBE Plane Subdivision",
  },
  "ADBE Material Options Group": {
    castsShadows: "ADBE Casts Shadows",
    lightTransmission: "ADBE Light Transmission",
    acceptsShadows: "ADBE Accepts Shadows",
    acceptsLights: "ADBE Accepts Lights",
    appearsInReflections: "ADBE Appears in Reflections",
    ambient: "ADBE Ambient Coefficient",
    diffuse: "ADBE Diffuse Coefficient",
    specularIntensity: "ADBE Specular Coefficient",
    specularShininess: "ADBE Shininess Coefficient",
    metal: "ADBE Metal Coefficient",
    reflectionIntensity: "ADBE Reflection Coefficient",
    reflectionSharpness: "ADBE Glossiness Coefficient",
    reflectionRolloff: "ADBE Fresnel Coefficient",
    transparency: "ADBE Transparency Coefficient",
    transparencyRolloff: "ADBE Transp Rolloff",
    indexOfRefraction: "ADBE Index of Refraction",
  },
  "ADBE Audio Group": {
    audioLevels: "ADBE Audio Levels",
  },
  "ADBE Mask Atom": {
    maskPath: "ADBE Mask Shape",
    maskFeather: "ADBE Mask Feather",
    maskOpacity: "ADBE Mask Opacity",
    maskExpansion: "ADBE Mask Offset",
  },
  "ADBE Vector Group": {
    blendMode: "ADBE Vector Blend Mode",
    contents: "ADBE Vectors Group",
    transform: "ADBE Vector Transform Group",
    materialOptions: "ADBE Vector Materials Group",
  },
  "ADBE Vector Transform Group": {
    anchorPoint: "ADBE Vector Anchor",
    position: "ADBE Vector Position",
    scale: "ADBE Vector Scale",
    skew: "ADBE Vector Skew",
    skewAxis: "ADBE Vector Skew Axis",
    rotation: "ADBE Vector Rotation",
    opacity: "ADBE Vector Group Opacity",
  },
  "ADBE Vector Shape - Group": {
    shapeDirection: "ADBE Vector Shape Direction",
    path: "ADBE Vector Shape",
  },
  "ADBE Vector Graphic - Fill": {
    blendMode: "ADBE Vector Blend Mode",
    composite: "ADBE Vector Composite Order",
    fillRule: "ADBE Vector Fill Rule",
    color: "ADBE Vector Fill Color",
    opacity: "ADBE Vector Fill Opacity",
  },
  "ADBE Vector Graphic - Stroke": {
    blendMode: "ADBE Vector Blend Mode",
    composite: "ADBE Vector Composite Order",
    color: "ADBE Vector Stroke Color",
    opacity: "ADBE Vector Stroke Opacity",
    strokeWidth: "ADBE Vector Stroke Width",
    lineCap: "ADBE Vector Stroke Line Cap",
    lineJoin: "ADBE Vector Stroke Line Join",
    miterLimit: "ADBE Vector Stroke Miter Limit",
    dashes: "ADBE Vector Stroke Dashes",
  },
} as const;

/** {@link CHILD_MATCH_NAMES} as a type: group match name to attribute name to child match name. */
export type ChildMatchNames = typeof CHILD_MATCH_NAMES;
