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
    x_position: "ADBE Position_0",
    y_position: "ADBE Position_1",
    z_position: "ADBE Position_2",
    scale: "ADBE Scale",
    orientation: "ADBE Orientation",
    x_rotation: "ADBE Rotate X",
    y_rotation: "ADBE Rotate Y",
    opacity: "ADBE Opacity",
    appears_in_reflections: "ADBE Envir Appear in Reflect",
  },
  "ADBE Text Properties": {
    source_text: "ADBE Text Document",
    path_options: "ADBE Text Path Options",
    more_options: "ADBE Text More Options",
    animators: "ADBE Text Animators",
  },
  "ADBE Text Path Options": {
    path: "ADBE Text Path",
    reverse_path: "ADBE Text Reverse Path",
    perpendicular_to_path: "ADBE Text Perpendicular To Path",
    force_alignment: "ADBE Text Force Align Path",
    first_margin: "ADBE Text First Margin",
    last_margin: "ADBE Text Last Margin",
  },
  "ADBE Text More Options": {
    anchor_point_grouping: "ADBE Text Anchor Point Option",
    grouping_alignment: "ADBE Text Anchor Point Align",
  },
  "ADBE Text Animator": {
    selectors: "ADBE Text Selectors",
  },
  "ADBE Camera Options Group": {
    zoom: "ADBE Camera Zoom",
    depth_of_field: "ADBE Camera Depth of Field",
    focus_distance: "ADBE Camera Focus Distance",
    aperture: "ADBE Camera Aperture",
    blur_level: "ADBE Camera Blur Level",
    iris_shape: "ADBE Iris Shape",
    iris_rotation: "ADBE Iris Rotation",
    iris_roundness: "ADBE Iris Roundness",
    iris_aspect_ratio: "ADBE Iris Aspect Ratio",
    iris_diffraction_fringe: "ADBE Iris Diffraction Fringe",
    highlight_gain: "ADBE Iris Highlight Gain",
    highlight_threshold: "ADBE Iris Highlight Threshold",
    highlight_saturation: "ADBE Iris Hightlight Saturation",
  },
  "ADBE Light Options Group": {
    source: "ADBE Light Env Atom",
    background_visible: "ADBE Light Backgd Visible",
    background_opacity: "ADBE Light Backgd Opacity",
    background_blur: "ADBE Light Backgd Blur",
    intensity: "ADBE Light Intensity",
    color: "ADBE Light Color",
    cone_angle: "ADBE Light Cone Angle",
    cone_feather: "ADBE Light Cone Feather 2",
    falloff: "ADBE Light Falloff Type",
    radius: "ADBE Light Falloff Start",
    falloff_distance: "ADBE Light Falloff Distance",
    casts_shadows: "ADBE Casts Shadows",
    shadow_darkness: "ADBE Light Shadow Darkness",
    shadow_diffusion: "ADBE Light Shadow Diffusion",
  },
  "ADBE Plane Options Group": {
    curvature: "ADBE Plane Curvature",
    segments: "ADBE Plane Subdivision",
  },
  "ADBE Material Options Group": {
    casts_shadows: "ADBE Casts Shadows",
    light_transmission: "ADBE Light Transmission",
    accepts_shadows: "ADBE Accepts Shadows",
    accepts_lights: "ADBE Accepts Lights",
    appears_in_reflections: "ADBE Appears in Reflections",
    ambient: "ADBE Ambient Coefficient",
    diffuse: "ADBE Diffuse Coefficient",
    specular_intensity: "ADBE Specular Coefficient",
    specular_shininess: "ADBE Shininess Coefficient",
    metal: "ADBE Metal Coefficient",
    reflection_intensity: "ADBE Reflection Coefficient",
    reflection_sharpness: "ADBE Glossiness Coefficient",
    reflection_rolloff: "ADBE Fresnel Coefficient",
    transparency: "ADBE Transparency Coefficient",
    transparency_rolloff: "ADBE Transp Rolloff",
    index_of_refraction: "ADBE Index of Refraction",
  },
  "ADBE Audio Group": {
    audio_levels: "ADBE Audio Levels",
  },
  "ADBE Mask Atom": {
    mask_path: "ADBE Mask Shape",
    mask_feather: "ADBE Mask Feather",
    mask_opacity: "ADBE Mask Opacity",
    mask_expansion: "ADBE Mask Offset",
  },
  "ADBE Vector Group": {
    blend_mode: "ADBE Vector Blend Mode",
    contents: "ADBE Vectors Group",
    transform: "ADBE Vector Transform Group",
    material_options: "ADBE Vector Materials Group",
  },
  "ADBE Vector Transform Group": {
    anchor_point: "ADBE Vector Anchor",
    position: "ADBE Vector Position",
    scale: "ADBE Vector Scale",
    skew: "ADBE Vector Skew",
    skew_axis: "ADBE Vector Skew Axis",
    rotation: "ADBE Vector Rotation",
    opacity: "ADBE Vector Group Opacity",
  },
  "ADBE Vector Shape - Group": {
    shape_direction: "ADBE Vector Shape Direction",
    path: "ADBE Vector Shape",
  },
  "ADBE Vector Graphic - Fill": {
    blend_mode: "ADBE Vector Blend Mode",
    composite: "ADBE Vector Composite Order",
    fill_rule: "ADBE Vector Fill Rule",
    color: "ADBE Vector Fill Color",
    opacity: "ADBE Vector Fill Opacity",
  },
  "ADBE Vector Graphic - Stroke": {
    blend_mode: "ADBE Vector Blend Mode",
    composite: "ADBE Vector Composite Order",
    color: "ADBE Vector Stroke Color",
    opacity: "ADBE Vector Stroke Opacity",
    stroke_width: "ADBE Vector Stroke Width",
    line_cap: "ADBE Vector Stroke Line Cap",
    line_join: "ADBE Vector Stroke Line Join",
    miter_limit: "ADBE Vector Stroke Miter Limit",
    dashes: "ADBE Vector Stroke Dashes",
  },
} as const;

/** {@link CHILD_MATCH_NAMES} as a type: group match name to attribute name to child match name. */
export type ChildMatchNames = typeof CHILD_MATCH_NAMES;
