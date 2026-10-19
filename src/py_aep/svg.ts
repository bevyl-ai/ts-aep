// `py_aep.svg`: read an SVG into absolute-coordinate drawables and add them to
// shape layer contents, as After Effects' SVG import does.
export { buildShapeLayerContents } from "./svg/build.ts";
export * from "./svg/index.ts";
export { parseTransform } from "./svg/transform.ts";
