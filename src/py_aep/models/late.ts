/**
 * Functions the models call that live in modules importing the models back:
 * the parsers and synthesis code that build model subclasses. A static import
 * from a model would evaluate those modules before the base class their
 * subclasses extend, so each provider fills in its entries when it loads.
 * Every provider is reachable from the package entry points.
 */
import type * as effect from "../parsers/effect.ts";
import type * as layer from "../parsers/layer.ts";
import type * as marker from "../parsers/marker.ts";
import type * as property from "../parsers/property.ts";
import type * as specializedProperties from "../parsers/specialized_properties.ts";
import type * as core from "../synthesis/core.ts";
import type { MaskPropertyGroup } from "./properties/mask_property_group.ts";

export const late = {} as {
  MaskPropertyGroup: typeof MaskPropertyGroup;
  parseEffect: typeof effect.parseEffect;
  matchEffectDefinition: typeof effect.matchEffectDefinition;
  rehomeEffectDefinitions: typeof effect.rehomeEffectDefinitions;
  _effectInstances: typeof effect._effectInstances;
  parseLayer: typeof layer.parseLayer;
  parseMarker: typeof marker.parseMarker;
  parsePropertyGroup: typeof property.parsePropertyGroup;
  _parseMaskAtom: typeof property._parseMaskAtom;
  _parseShapeShap: typeof specializedProperties._parseShapeShap;
  applyDimensionalityNaming: typeof core.applyDimensionalityNaming;
  followSourceAnchor: typeof core.followSourceAnchor;
  synthesizeLayerProperties: typeof core.synthesizeLayerProperties;
};
