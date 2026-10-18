/**
 * Build Essential Graphics (Motion Graphics template) controllers from a
 * source property or layer.
 *
 * The read side (parsing controllers) lives in `parsers/essential_graphics.py`
 * and `resolvers/essential_properties.py`. This module is the write side: it
 * classifies a property into an Essential Graphics controller type, builds the
 * root-to-leaf source-property path, and decides whether a property or layer can
 * be exposed - shared by `Property`/`AVLayer.addToMotionGraphicsTemplate`.
 *
 * Path shape (the CPrp JSON): each node is `{"index", "matchName"}`. AE resolves
 * named groups by name (index `0xFFFFFFFF`) and indexed-group children by index.
 * The index model, verified against AE 2026 output (the `essential_graphics`
 * fixtures plus a headless run covering masks, shape contents, text animators
 * and effect topic groups):
 *
 * - a child of an INDEXED group is its 0-based position among that group's
 *   children: a mask atom in the Mask Parade, a shape group in Root Vectors, a
 *   fill in a nested Vectors Group, a text animator in Text Animators, and an
 *   effect in the Effect Parade all follow this rule;
 * - an effect PARAM leaf is the exception: its index is the position in the
 *   effect's flat `parT` parameter list, where the hidden parameter-group
 *   header pard occupies slot 0, so visible params start at 1
 *   (`ADBE Fill-0002` -\> 3 after `-0001`/`-0007`; `ADBE Fractal Noise-0010`
 *   -\> 10). Effect TOPIC groups (e.g. Fractal Noise's "Transform") are pure
 *   UI: both AE's DOM and py_aep keep the params flat, and the stored path
 *   never contains a topic-group node;
 * - every other node resolves by name.
 *
 * py_aep refuses (reports "not addable") only what it cannot produce
 * faithfully: an effect param whose parT definitions are unavailable, children
 * of `ADBE Effect Built In Params`, and by-name nodes whose match name is
 * ambiguous among siblings - matching how `canImportAs` gates on what py_aep
 * can actually produce rather than on what After Effects allows.
 */

import { PropertyType } from "../enums/general.ts";
import { PropertyControlType, PropertyValueType } from "../enums/property.ts";
import type { CompItem } from "../models/items/composition.ts";
import type { AVItem } from "../models/items/av_item.ts";
import type { AVLayer } from "../models/layers/av_layer.ts";
import type { Layer } from "../models/layers/layer.ts";
import type { Property } from "../models/properties/property.ts";
import type { PropertyGroup } from "../models/properties/property_group.ts";
import { valueEquals, stringifyJson } from "../../pyrt/index.ts";
import { FootageItem } from "../models/items/footage.ts";
import { SolidSource } from "../models/sources/solid.ts";
import { TextDocument } from "../models/text/text_document.ts";
import * as _composition from "../models/items/composition.ts";

// AE stores this in a CPrp path node's index to mean "match by name".
const _BY_NAME_INDEX = 0xffffffff;

const _TEXT_DOCUMENT = "ADBE Text Document";

// Essential Graphics controller type ids (see EssentialGraphicsController).
export const CONTROLLER_CHECKBOX = 1;
export const CONTROLLER_SLIDER = 2;
export const CONTROLLER_COLOR = 4;
const CONTROLLER_TEXT = 6;

/**
 * One CPrp path node: a match name plus AE's child index.
 *
 * `propIndex` is `null` for by-name resolution (serialized as
 * `0xFFFFFFFF`); a number is AE's hidden-param-aware child index (see the
 * module docstring). Named `propIndex`, not `index`, to avoid shadowing
 * `Array.prototype.indexOf` - mirroring `SourcePropertyRef`.
 */
export class PathNode {
  readonly matchName: string;
  readonly propIndex: number | null;

  constructor(matchName: string, propIndex: number | null) {
    this.matchName = matchName;
    this.propIndex = propIndex;
  }

  *[Symbol.iterator](): Generator<string | number | null> {
    yield this.matchName;
    yield this.propIndex;
  }
}

/**
 * AE's parT index of `paramMn` inside effect `effectMn`, or `null`.
 *
 * The project-level param defs preserve parT order and exclude the hidden
 * parameter-group header pard (slot 0), so the AE index is `1 + position`
 * (verified across the essential_graphics fixtures: `ADBE Fill-0002` -\> 3,
 * every `* Control-0001` -\> 1).
 */
function _effectParamIndex(layer: Layer, effectMn: string, paramMn: string): number | null {
  const defs = layer.containingComp._project._effectParamDefs.get(effectMn) ?? null;
  if (defs == null || defs.size === 0) return null;
  const keys = [...defs.keys()];
  if (!keys.includes(paramMn)) return null;
  return 1 + keys.indexOf(paramMn);
}

/**
 * Path for a param sitting DIRECTLY inside an effect, or `null`.
 *
 * The effect node carries its 0-based Effect Parade position, the leaf its
 * parT index; the parade itself resolves by name. Duplicate effect
 * instances are fine - the index disambiguates them.
 */
function _effectParamPath(prop: Property): [PathNode[], Layer] | null {
  const effect: PropertyGroup | null = prop.parentProperty;
  if (effect == null || !effect.isEffect) return null;
  const parade: PropertyGroup | null = effect.parentProperty;
  if (parade == null || parade.matchName !== "ADBE Effect Parade") return null;
  const layer: PropertyGroup | null = parade.parentProperty;
  if (layer == null || !layer._isLayer()) return null;
  const effectIndex = parade.properties.findIndex((e) => e === effect);
  if (effectIndex === -1) return null;
  const leafIndex = _effectParamIndex(layer, effect.matchName, prop.matchName);
  if (leafIndex == null) return null;
  return [
    [
      new PathNode("ADBE Effect Parade", null),
      new PathNode(effect.matchName, effectIndex),
      new PathNode(prop.matchName, leafIndex),
    ],
    layer,
  ];
}

/**
 * Build the root-to-leaf CPrp path from `prop`'s layer to `prop`.
 *
 * Returns `[nodes, layer]` where `nodes` runs from the layer's top-level
 * group down to `prop`. Per the AE index model (validated against AE 2026
 * output for masks, shape contents, text animators and effects):
 *
 * - a child of an INDEXED group carries its 0-based position among that
 *   group's children (a mask in the Mask Parade, a shape group in Root
 *   Vectors, a fill in a Vectors Group, an animator in Text Animators);
 * - an effect param carries its parT slot instead (hidden header at 0,
 *   see `_effectParamPath`), so effect subtrees resolve only through
 *   that dedicated branch;
 * - every other node resolves by name, refused when the match name is
 *   not unique among its siblings (defensive: named groups have unique
 *   children by AE construction, but a written by-name path must be
 *   provably unambiguous).
 *
 * `null` when `prop` is not owned by a layer, an effect node cannot be
 * indexed, or a by-name node is ambiguous.
 */
export function _sourcePropertyPath(prop: Property): [PathNode[], Layer] | null {
  const effectPath = _effectParamPath(prop);
  if (effectPath != null) return effectPath;

  const chain: PathNode[] = [];
  let node: Property | PropertyGroup = prop;
  let parent: PropertyGroup | null = prop.parentProperty;
  while (parent != null && !parent._isLayer()) {
    if (parent.isEffect || parent.matchName === "ADBE Effect Parade") {
      // Effect subtrees are handled by _effect_param_path only; a
      // positional index here would miss the hidden header pard.
      return null;
    }
    if (parent.propertyType === PropertyType.INDEXED_GROUP) {
      const idx = parent.properties.findIndex((c) => c === node);
      if (idx === -1) return null;
      chain.push(new PathNode(node.matchName, idx));
    } else {
      if (parent.properties.filter((c) => c.matchName === node.matchName).length !== 1) {
        return null;
      }
      chain.push(new PathNode(node.matchName, null));
    }
    node = parent;
    parent = parent.parentProperty;
  }
  if (parent == null || !parent._isLayer()) return null;
  // The layer's top-level group resolves by name too.
  if (parent.properties.filter((c) => c.matchName === node.matchName).length !== 1) {
    return null;
  }
  chain.push(new PathNode(node.matchName, null));
  return [chain.reverse(), parent];
}

/** Serialize a CPrp path into AE's JSON (by-name nodes as `0xFFFFFFFF`). */
export function _pathJson(nodes: PathNode[]): string {
  const body = new Map(
    nodes.map((node, i): [string, { index: number; matchName: string }] => [
      String(i),
      {
        index: node.propIndex != null ? node.propIndex : _BY_NAME_INDEX,
        matchName: node.matchName,
      },
    ]),
  );
  return stringifyJson(body, { separators: [",", ":"] });
}

/**
 * Return the Essential Graphics controller type for `prop`, or `null`.
 *
 * Supported (per the AE Scripting Guide): Checkbox, Color, single-value
 * numeric Slider, and Source Text. Classified on `propertyValueType`
 * (the control type is `UNKNOWN` for many transform properties, e.g.
 * Opacity), with the Checkbox control type distinguishing a boolean from a
 * plain numeric slider (both are 1-D value types).
 */
function classifyProperty(prop: Property): number | null {
  if (prop.matchName === _TEXT_DOCUMENT) return CONTROLLER_TEXT;
  if (prop.propertyValueType === PropertyValueType.COLOR) return CONTROLLER_COLOR;
  if (prop.propertyControlType === PropertyControlType.BOOLEAN) return CONTROLLER_CHECKBOX;
  if (prop.propertyControlType === PropertyControlType.ENUM) {
    // Dropdown params are 1-D but AE exposes them as a type-13 Dropdown
    // controller (menu entries included), which py_aep does not build.
    return null;
  }
  if (prop.propertyValueType === PropertyValueType.OneD) {
    // A slider controller is seeded from the property's current value,
    // so a value-less 1-D property (e.g. `ADBE Layer Source Alternate`)
    // cannot back one - reporting it addable made
    // `addToMotionGraphicsTemplate` raise instead of returning False.
    if (prop.value == null) return null;
    return CONTROLLER_SLIDER;
  }
  return null;
}

/**
 * `true` if `comp` already exposes the same layer property.
 *
 * Compares `(match_name, index)` pairs so two instances of the same effect
 * (identical match names, different parade indices) stay independently
 * addable.
 */
function _alreadyAdded(comp: CompItem, layerId: number, nodes: PathNode[]): boolean {
  const wanted = nodes.map((node) => [node.matchName, node.propIndex]);
  for (const ctrl of comp.motionGraphicsControllers) {
    if (ctrl.sourceLayerId !== layerId) continue;
    const stored = ctrl.sourcePropertyPath.map((ref) => [ref.matchName, ref.propIndex]);
    if (valueEquals(stored, wanted)) return true;
  }
  return false;
}

/** Everything `CompItem` needs to add a property controller. */
export class PropertyControllerPlan {
  readonly controllerType: number;
  readonly nodes: PathNode[];
  readonly pathJson: string;
  readonly layer: Layer;

  constructor(controllerType: number, nodes: PathNode[], pathJson: string, layer: Layer) {
    this.controllerType = controllerType;
    this.nodes = nodes;
    this.pathJson = pathJson;
    this.layer = layer;
  }

  *[Symbol.iterator](): Generator<number | PathNode[] | string | Layer> {
    yield this.controllerType;
    yield this.nodes;
    yield this.pathJson;
    yield this.layer;
  }
}

/**
 * Resolve everything needed to add `prop` to `comp`'s EGP, or `null`.
 *
 * `null` covers: an unsupported property type, a path py_aep cannot
 * serialize (see `_sourcePropertyPath`), a layer not in `comp`, or a
 * property already exposed.
 */
export function propertyControllerPlan(prop: Property, comp: CompItem): PropertyControllerPlan | null {
  const controllerType = classifyProperty(prop);
  if (controllerType == null) return null;
  const resolved = _sourcePropertyPath(prop);
  if (resolved == null) return null;
  const [nodes, layer] = resolved;
  if (layer.containingComp !== comp) return null;
  if (_alreadyAdded(comp, layer._ldta.layerId, nodes)) return null;
  return new PropertyControllerPlan(controllerType, nodes, _pathJson(nodes), layer);
}

/** Whether `prop` can be added to `comp`'s Essential Graphics panel. */
export function canAddProperty(prop: Property, comp: CompItem): boolean {
  return propertyControllerPlan(prop, comp) != null;
}

/**
 * Build the Source Text controller's font-caps JSON from the property's
 * current TextDocument (AE 2025 key order).
 */
export function fontCapsJson(prop: Property): string {
  const value = prop.value;
  let font: string | null = "";
  let size: number = 0;
  if (value instanceof TextDocument) {
    font = value.font || "";
    const fs = value.fontSize;
    if (fs != null) size = Number.isInteger(fs) ? Math.trunc(fs) : fs;
  }
  return stringifyJson(
    {
      capPropFontEdit: false,
      capPropFontFauxStyleEdit: false,
      capPropFontSizeEdit: false,
      fontEditValue: font,
      fontFSAllCapsValue: false,
      fontFSBoldValue: false,
      fontFSItalicValue: false,
      fontFSSmallCapsValue: false,
      fontSizeEditValue: size,
    },
    { separators: [",", ":"] },
  );
}

/**
 * The fixed CPrp path of a Media Replacement controller.
 *
 * AE always targets the layer's `ADBE Layer Source Alternate` leaf (under
 * Source Options), both nodes by name.
 */
export function mediaControllerPath(): [PathNode[], string] {
  const nodes = [new PathNode("ADBE Source Options Group", null), new PathNode("ADBE Layer Source Alternate", null)];
  return [nodes, _pathJson(nodes)];
}

/**
 * Whether `layer` can be added to `comp`'s EGP as a Media Replacement.
 *
 * Mirrors the eligibility rules of `AVLayer.canAddToMotionGraphicsTemplate`:
 * the layer must be a Media Replacement layer (has video, not an adjustment
 * or null layer, source is a footage/comp item that is not a solid), must
 * live in `comp`, and must not already be exposed.
 */
export function canAddLayer(layer: AVLayer, comp: CompItem): boolean {
  if (layer.containingComp !== comp) return false;
  if (!layer.hasVideo || layer.adjustmentLayer || layer.nullLayer) return false;
  const source: AVItem | null = layer.source;
  if (source instanceof FootageItem) {
    if (source.mainSource instanceof SolidSource) return false;
  } else if (!(source instanceof _composition.CompItem)) {
    return false;
  }
  // Only an existing MEDIA controller blocks the layer; property
  // controllers (slider/checkbox/...) on the same layer coexist with a
  // Media Replacement in AE.
  const [nodes] = mediaControllerPath();
  return !_alreadyAdded(comp, layer._ldta.layerId, nodes);
}
