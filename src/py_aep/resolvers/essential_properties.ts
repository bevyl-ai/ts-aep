/**
 * Resolve a precomp layer's Essential Properties overrides to the source
 * composition's Essential Graphics controllers.
 *
 * The override\<-\>controller link is a shared UUID: a precomp layer's
 * `LIST:OvG2` carries one UUID per override (`Layer.essentialPropertyUuids`),
 * each equal to an `EssentialGraphicsController.uuid` on the source composition.
 */

import { deferred } from "../../pyrt/index.ts";
import { PropertyType } from "../enums/general.ts";
import type { AVLayer } from "../models/layers/av_layer.ts";
import type { EssentialGraphicsController, SourcePropertyRef } from "../models/essential_graphics.ts";
import type { Project } from "../models/project.ts";
import type { Property } from "../models/properties/property.ts";
import type { PropertyGroup } from "../models/properties/property_group.ts";

const _composition = deferred<typeof import("../models/items/composition.ts")>("py_aep/models/items/composition");
const _av_layer = deferred<typeof import("../models/layers/av_layer.ts")>("py_aep/models/layers/av_layer");
const _property_group = deferred<typeof import("../models/properties/property_group.ts")>("py_aep/models/properties/property_group");

/** Essential Graphics controller type for a Media Replacement slot. */
export const _MEDIA_REPLACEMENT_CONTROLLER_TYPE = 14;

/**
 * Return the source-comp controllers a precomp layer's Essential
 * Properties overrides reference, matched by UUID, in override order.
 *
 * Returns `[]` when the layer is not a precomp (no `CompItem` source, e.g.
 * a text layer or a footage layer), when the source composition has no
 * controllers, or when the layer has no overrides. A UUID with no matching
 * controller (e.g. a controller removed after the override was created) is
 * skipped; the raw UUIDs remain on `Layer.essentialPropertyUuids`.
 */
export function resolve_essential_property_controllers(layer: AVLayer): EssentialGraphicsController[] {
  const uuids = layer.essentialPropertyUuids;
  if (!uuids?.length) return [];
  const source = layer.source;
  if (!(source instanceof _composition().CompItem)) return [];
  const by_uuid = new Map(source.motionGraphicsControllers.map((c) => [c.uuid, c] as const));
  return uuids.map((uuid) => by_uuid.get(uuid)).filter((c) => c !== undefined);
}

/**
 * Resolve the source-composition `AVLayer` that owns a controller's
 * controlled property, via the controller's `CCId`/`CLId`.
 *
 * Returns `null` when the controller stores no source comp/layer, the comp
 * is missing, or no layer matches the stored `layer_id`.
 */
export function _resolve_controller_source_layer(project: Project, controller: EssentialGraphicsController): AVLayer | null {
  if (controller.sourceCompId == null || controller.sourceLayerId == null) return null;
  const comp = project.items.get(controller.sourceCompId) ?? null;
  if (!(comp instanceof _composition().CompItem)) return null;
  const layer = comp.layersById.get(controller.sourceLayerId) ?? null;
  return layer instanceof _av_layer().AVLayer ? layer : null;
}

/**
 * Resolve an indexed path node, or `null` to fall back to by-name.
 *
 * AE's index model (verified against AE 2026 output - see
 * `resolvers/motion_graphics`): a param inside an EFFECT is addressed by
 * its parT position, where slot 0 is the hidden parameter-group header,
 * so visible params map to `index - 1` in the project's parT-ordered
 * param defs; a child of any other INDEXED group (the Effect Parade,
 * Mask Parade, shape Vectors groups, Text Animators) by its plain
 * 0-based child position. The resolved child must carry the stored match
 * name - a disagreement (stale index) returns `null` so the caller falls
 * back to by-name resolution.
 */
export function _resolve_indexed_child(group: PropertyGroup, ref: SourcePropertyRef, project: Project): Property | PropertyGroup | null {
  if (ref.propIndex == null) return null;
  if (group.isEffect) {
    const defs = project._effect_param_defs.get(group.matchName);
    if (defs != null && defs.size > 0) {
      const keys = [...defs.keys()];
      const pos = ref.propIndex - 1;
      if (0 <= pos && pos < keys.length && keys[pos] === ref.matchName) {
        return group._child_or_null(ref.matchName);
      }
    }
    return null;
  }
  if (group.propertyType === PropertyType.INDEXED_GROUP) {
    const children = group.properties;
    if (0 <= ref.propIndex && ref.propIndex < children.length) {
      const child = children[ref.propIndex];
      if (child.matchName === ref.matchName) return child;
    }
  }
  return null;
}

/**
 * Walk a controller's source-property `path` from `source_layer` to the
 * exposed leaf.
 *
 * A node with `prop_index=None` (AE's by-name marker, `0xFFFFFFFF`)
 * resolves by match name. An indexed node resolves through
 * `_resolve_indexed_child`, which disambiguates duplicate match names
 * (e.g. the same effect applied twice); when the index cannot be
 * interpreted it falls back to the first match-name hit, the pre-index
 * behavior. Returns `null` if any node fails to resolve (missing child,
 * or the path descends past a leaf).
 */
export function _walk_source_property(source_layer: AVLayer, path: SourcePropertyRef[]): Property | PropertyGroup | null {
  const project = source_layer.containingComp._project;
  let cur: Property | PropertyGroup = source_layer;
  for (const ref of path) {
    if (!(cur instanceof _property_group().PropertyGroup)) return null;
    let child: Property | PropertyGroup | null = null;
    if (ref.propIndex != null) child = _resolve_indexed_child(cur, ref, project);
    if (child == null) {
      child = cur._child_or_null(ref.matchName);
      if (child === null) return null;
    }
    cur = child;
  }
  return cur;
}

/**
 * Pre-order position of `target` among all descendants (groups + leaves)
 * of `root`, or `null` if not found. Matches the flat OvG2 UUID ordering.
 */
export function _preorder_index(root: PropertyGroup, target: Property): number | null {
  const counter = [0];

  function rec(group: PropertyGroup): number | null {
    for (const child of group.properties) {
      const pos = counter[0];
      counter[0] += 1;
      if (child === target) return pos;
      if (child instanceof _property_group().PropertyGroup) {
        const found = rec(child);
        if (found != null) return found;
      }
    }
    return null;
  }

  return rec(root);
}

/**
 * Resolve an Essential Property override leaf to its source-comp controller.
 *
 * Walks up to the `ADBE Layer Overrides` root, computes the leaf's PRE-ORDER
 * position in the override subtree (groups + leaves) - which aligns 1:1 with
 * the flat OvG2 UUID list, the `ADBE Layer Overrides Group` container consuming
 * the type-10 Group controller's slot - and matches that UUID to a controller
 * on the precomp's source composition. Returns `null` when `prop` is not an
 * override leaf or the controller cannot be resolved (e.g. it was removed).
 */
export function resolve_essential_property_controller(prop: Property): EssentialGraphicsController | null {
  let root: PropertyGroup | Property | null = prop._parent_property;
  while (root != null && root.matchName !== "ADBE Layer Overrides") {
    root = root._parent_property;
  }
  if (root == null) return null;
  const layer = root._parent_property;
  if (!(layer instanceof _av_layer().AVLayer)) return null;
  const idx = _preorder_index(root, prop);
  if (idx == null) return null;
  const uuids = layer.essentialPropertyUuids;
  if (idx >= uuids.length) return null;
  const source = layer.source;
  if (!(source instanceof _composition().CompItem)) return null;
  return source.motionGraphicsControllers.find((c) => c.uuid === uuids[idx]) ?? null;
}

/**
 * Resolve an Essential Property override leaf to its originating source.
 *
 * For a media-replacement override (`ADBE Layer Source Alternate`, controller
 * type 14) this returns the source-composition `AVLayer` the slot points at -
 * matched via the override's controller `source_comp_id` (`CCId`) and
 * `source_layer_id` (`CLId`). For a Property-source controller (created from a
 * Property rather than Media Replacement Footage) it walks the controller's
 * source-property path by match name and returns the source `Property` (or
 * `PropertyGroup` for a grouped controller).
 *
 * Returns `null` when the property is not such an override or the source
 * cannot be resolved.
 */
export function resolve_essential_property_source(prop: Property): Property | PropertyGroup | AVLayer | null {
  const controller = resolve_essential_property_controller(prop);
  if (controller == null || prop._composition == null) return null;
  const source_layer = _resolve_controller_source_layer(prop._composition._project, controller);
  if (source_layer == null) return null;
  if (controller.controllerType === _MEDIA_REPLACEMENT_CONTROLLER_TYPE) return source_layer;
  // Property-source controller: the exposed leaf is the tail of the
  // controlled-property path, resolved by match name from the source layer.
  if (!controller.sourcePropertyPath?.length) return null;
  return _walk_source_property(source_layer, controller.sourcePropertyPath);
}
