// The model class (and value type) each well-known match name resolves to.
//
// `PropertyGroup.__getitem__` / `property()` / `addProperty()` return the
// mapped type for a match-name key. A key outside the map (an index, a display
// name, an effect parameter) returns `Property | PropertyGroup` as before.
// Every entry must hold for every layer kind that has the child: a group here is
// always a group, and a property's value always has the listed type.
import type { Gradient } from "./gradient.ts";
import type { MarkerValue } from "./marker.ts";
import type { MaskPropertyGroup } from "./mask_property_group.ts";
import type { Property } from "./property.ts";
import type { PropertyGroup } from "./property_group.ts";
import type { Shape } from "./shape.ts";
import type { TextDocument } from "../text/text_document.ts";
import type { ChildMatchNames } from "../../data/child_names.ts";

export interface MatchNameTypes {
  // Layer top level
  "ADBE Marker": Property<MarkerValue | null>;
  "ADBE Time Remapping": Property<number>;
  "ADBE Transform Group": ChildGroup<"ADBE Transform Group">;
  "ADBE Effect Parade": PropertyGroup;
  "ADBE Layer Styles": PropertyGroup;

  // Transform
  "ADBE Anchor Point": Property<number[]>;
  "ADBE Position": Property<number[]>;
  "ADBE Position_0": Property<number>;
  "ADBE Position_1": Property<number>;
  "ADBE Position_2": Property<number>;
  "ADBE Scale": Property<number[]>;
  "ADBE Orientation": Property<number[]>;
  "ADBE Rotate X": Property<number>;
  "ADBE Rotate Y": Property<number>;
  "ADBE Rotate Z": Property<number>;
  "ADBE Opacity": Property<number>;

  // Masks
  "ADBE Mask Parade": PropertyGroup;
  "ADBE Mask Atom": ChildGroup<"ADBE Mask Atom", MaskPropertyGroup>;
  "ADBE Mask Shape": Property<Shape>;
  "ADBE Mask Feather": Property<number[]>;
  "ADBE Mask Opacity": Property<number>;
  "ADBE Mask Offset": Property<number>;

  // Camera / light / 3D options
  "ADBE Camera Options Group": ChildGroup<"ADBE Camera Options Group">;
  "ADBE Camera Zoom": Property<number>;
  "ADBE Camera Focus Distance": Property<number>;
  "ADBE Light Options Group": ChildGroup<"ADBE Light Options Group">;
  "ADBE Plane Options Group": ChildGroup<"ADBE Plane Options Group">;
  "ADBE Material Options Group": ChildGroup<"ADBE Material Options Group">;

  // Text
  "ADBE Text Properties": ChildGroup<"ADBE Text Properties">;
  "ADBE Text Document": Property<TextDocument>;
  "ADBE Text Path Options": ChildGroup<"ADBE Text Path Options">;
  "ADBE Text More Options": ChildGroup<"ADBE Text More Options">;
  "ADBE Text Animators": PropertyGroup;
  "ADBE Text Animator": ChildGroup<"ADBE Text Animator">;
  "ADBE Text Animator Properties": PropertyGroup;
  "ADBE Text Selectors": PropertyGroup;

  // Shape layer contents
  "ADBE Root Vectors Group": PropertyGroup;
  "ADBE Vectors Group": PropertyGroup;
  "ADBE Vector Group": ChildGroup<"ADBE Vector Group">;
  "ADBE Vector Transform Group": ChildGroup<"ADBE Vector Transform Group">;
  "ADBE Vector Shape - Group": ChildGroup<"ADBE Vector Shape - Group">;
  "ADBE Vector Shape": Property<Shape>;
  "ADBE Vector Graphic - Fill": ChildGroup<"ADBE Vector Graphic - Fill">;
  "ADBE Vector Graphic - Stroke": ChildGroup<"ADBE Vector Graphic - Stroke">;
  "ADBE Vector Graphic - G-Fill": PropertyGroup;
  "ADBE Vector Graphic - G-Stroke": PropertyGroup;
  "ADBE Vector Grad Colors": Property<Gradient>;

  // Children of the groups in CHILD_MATCH_NAMES (data/child_names.ts)
  "ADBE Accepts Lights": Property<number>;
  "ADBE Accepts Shadows": Property<number>;
  "ADBE Ambient Coefficient": Property<number>;
  "ADBE Appears in Reflections": Property<number>;
  "ADBE Audio Group": ChildGroup<"ADBE Audio Group">;
  "ADBE Audio Levels": Property<number[]>;
  "ADBE Camera Aperture": Property<number>;
  "ADBE Camera Blur Level": Property<number>;
  "ADBE Camera Depth of Field": Property<number>;
  "ADBE Casts Shadows": Property<number>;
  "ADBE Diffuse Coefficient": Property<number>;
  "ADBE Envir Appear in Reflect": Property<number>;
  "ADBE Fresnel Coefficient": Property<number>;
  "ADBE Glossiness Coefficient": Property<number>;
  "ADBE Index of Refraction": Property<number>;
  "ADBE Iris Aspect Ratio": Property<number>;
  "ADBE Iris Diffraction Fringe": Property<number>;
  "ADBE Iris Highlight Gain": Property<number>;
  "ADBE Iris Highlight Threshold": Property<number>;
  "ADBE Iris Hightlight Saturation": Property<number>;
  "ADBE Iris Rotation": Property<number>;
  "ADBE Iris Roundness": Property<number>;
  "ADBE Iris Shape": Property<number>;
  "ADBE Light Backgd Blur": Property<number>;
  "ADBE Light Backgd Opacity": Property<number>;
  "ADBE Light Backgd Visible": Property<number>;
  "ADBE Light Color": Property<number[]>;
  "ADBE Light Cone Angle": Property<number>;
  "ADBE Light Cone Feather 2": Property<number>;
  "ADBE Light Env Atom": PropertyGroup;
  "ADBE Light Falloff Distance": Property<number>;
  "ADBE Light Falloff Start": Property<number>;
  "ADBE Light Falloff Type": Property<number>;
  "ADBE Light Intensity": Property<number>;
  "ADBE Light Shadow Darkness": Property<number>;
  "ADBE Light Shadow Diffusion": Property<number>;
  "ADBE Light Transmission": Property<number>;
  "ADBE Metal Coefficient": Property<number>;
  "ADBE Plane Curvature": Property<number>;
  "ADBE Plane Subdivision": Property<number>;
  "ADBE Reflection Coefficient": Property<number>;
  "ADBE Shadow Color": Property<number[]>;
  "ADBE Shininess Coefficient": Property<number>;
  "ADBE Specular Coefficient": Property<number>;
  "ADBE Text Anchor Point Align": Property<number[]>;
  "ADBE Text Anchor Point Option": Property<number>;
  "ADBE Text First Margin": Property<number>;
  "ADBE Text Force Align Path": Property<number>;
  "ADBE Text Last Margin": Property<number>;
  "ADBE Text Path": Property<number>;
  "ADBE Text Perpendicular To Path": Property<number>;
  "ADBE Text Reverse Path": Property<number>;
  "ADBE Transp Rolloff": Property<number>;
  "ADBE Transparency Coefficient": Property<number>;
  "ADBE Vector Anchor": Property<number[]>;
  "ADBE Vector Blend Mode": Property<number>;
  "ADBE Vector Composite Order": Property<number>;
  "ADBE Vector Fill Color": Property<number[]>;
  "ADBE Vector Fill Opacity": Property<number>;
  "ADBE Vector Fill Rule": Property<number>;
  "ADBE Vector Group Opacity": Property<number>;
  "ADBE Vector Materials Group": PropertyGroup;
  "ADBE Vector Position": Property<number[]>;
  "ADBE Vector Rotation": Property<number>;
  "ADBE Vector Scale": Property<number[]>;
  "ADBE Vector Shape Direction": Property<number>;
  "ADBE Vector Skew Axis": Property<number>;
  "ADBE Vector Skew": Property<number>;
  "ADBE Vector Stroke Color": Property<number[]>;
  "ADBE Vector Stroke Dashes": PropertyGroup;
  "ADBE Vector Stroke Line Cap": Property<number>;
  "ADBE Vector Stroke Line Join": Property<number>;
  "ADBE Vector Stroke Miter Limit": Property<number>;
  "ADBE Vector Stroke Opacity": Property<number>;
  "ADBE Vector Stroke Width": Property<number>;
}

/**
 * A built-in group `M` with its attribute-named children typed (Python
 * `group.childName`, resolved through `_missingAttribute`); see `CHILD_MATCH_NAMES`.
 */
export type ChildGroup<M extends keyof ChildMatchNames, G extends PropertyGroup = PropertyGroup> = G & {
  readonly [A in keyof ChildMatchNames[M]]: MatchNameTypes[ChildMatchNames[M][A] & keyof MatchNameTypes];
};

/** Every child match name in `CHILD_MATCH_NAMES` has a `MatchNameTypes` entry (a missing one fails here). */
type ChildMatchName = {
  [M in keyof ChildMatchNames]: ChildMatchNames[M][keyof ChildMatchNames[M]];
}[keyof ChildMatchNames];
type AllChildrenTyped<T extends never> = T;
export type _ChildMatchNamesCovered = AllChildrenTyped<Exclude<ChildMatchName, keyof MatchNameTypes>>;

/** No table name shadows a group member: attribute access only reaches `_missingAttribute` when the class has no such member. */
type ShadowedChildName = {
  [M in keyof ChildMatchNames]: Extract<
    keyof ChildMatchNames[M],
    keyof (M extends "ADBE Mask Atom" ? MaskPropertyGroup : PropertyGroup)
  >;
}[keyof ChildMatchNames];
export type _ChildNamesUnshadowed = AllChildrenTyped<ShadowedChildName>;
