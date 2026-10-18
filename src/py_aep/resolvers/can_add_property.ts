/**
 * Resolver for `PropertyGroup.canAddProperty`.
 *
 * Determines whether a property with a given match name or display name
 * can be added to a specific indexed group.
 */

import { py_enum, type EnumValue } from "../../pyrt/index.ts";
import { EXPRESSION_CONTROLS } from "../data/effect_controls.ts";
import { MATCH_NAME_TO_AUTO_NAME } from "../data/match_names.ts";
import { TEXT_ANIMATOR_POOL } from "../data/text_animator_pool.ts";
import { PropertyType } from "../enums/index.ts";

/**
 * Category of an addable property - selects the model's builder.
 *
 * The resolver is the single source of truth for this classification so
 * the model can dispatch on it without re-deriving the category from the
 * resolved match name.
 */
export const AddableKind = py_enum("AddableKind", {
  MASK: "mask",
  EXPRESSION_CONTROL: "expression_control",
  DROPDOWN: "dropdown",
  SHAPE: "shape",
  TEXT_ANIMATOR: "text_animator",
  TEXT_SELECTOR: "text_selector",
  ANIMATOR_PROPERTY: "animator_property",
});
export type AddableKind = EnumValue<typeof AddableKind>;

// Match names that can be added to specific indexed groups via add_property().
export const _ADDABLE_MASK_MATCH_NAMES: ReadonlySet<string> = new Set(["ADBE Mask Atom"]);

// Effects creatable via add_property(). The Dropdown Menu Control
// registers as a pseudo effect with a per-instance generated match name
// (`Pseudo/@@` + base64(uuid4)); add_property generates one on demand.
export const _ADDABLE_EFFECT_MATCH_NAMES: ReadonlySet<string> = new Set([
  ...EXPRESSION_CONTROLS.keys(),
  "ADBE Dropdown Control",
]);

export const _EFFECT_DISPLAY_TO_MATCH: Map<string, string> = new Map(
  [...EXPRESSION_CONTROLS].map(([mn, entry]): [string, string] => [entry.name, mn]),
);
_EFFECT_DISPLAY_TO_MATCH.set("Dropdown Menu Control", "ADBE Dropdown Control");

export const _ADDABLE_TEXT_ANIMATOR_MATCH_NAMES: ReadonlySet<string> = new Set(["ADBE Text Animator"]);

// Selectors addable to a text animator's Selectors group.
export const _ADDABLE_TEXT_SELECTOR_MATCH_NAMES: ReadonlySet<string> = new Set([
  "ADBE Text Selector",
  "ADBE Text Wiggly Selector",
  "ADBE Text Expressible Selector",
]);

// Animator properties applicable to a text animator's (NAMED) Properties
// group - the full pool minus the 8 variable-font axes (not addable).
export const _ADDABLE_ANIMATOR_PROPERTY_MATCH_NAMES: ReadonlySet<string> = new Set(
  TEXT_ANIMATOR_POOL.filter((e) => !e.mn.startsWith("ADBE Text VF Axis")).map((e) => e.mn),
);
export const _ANIMATOR_PROPERTY_DISPLAY_TO_MATCH: Map<string, string> = new Map(
  TEXT_ANIMATOR_POOL.filter(
    (e) => e.name && !e.mn.startsWith("ADBE Text VF Axis"),
  ).map((e): [string, string] => [e.name, e.mn]),
);

// Shape elements that can be added to a Root Vectors Group (Contents).
export const _ADDABLE_SHAPE_MATCH_NAMES: ReadonlySet<string> = new Set([
  "ADBE Vector Group",
  "ADBE Vector Shape - Rect",
  "ADBE Vector Shape - Ellipse",
  "ADBE Vector Shape - Star",
  "ADBE Vector Shape - Group",
  "ADBE Vector Graphic - Fill",
  "ADBE Vector Graphic - Stroke",
  "ADBE Vector Graphic - G-Fill",
  "ADBE Vector Graphic - G-Stroke",
  "ADBE Vector Filter - Merge",
  "ADBE Vector Filter - Offset",
  "ADBE Vector Filter - PB",
  "ADBE Vector Filter - Repeater",
  "ADBE Vector Filter - RC",
  "ADBE Vector Filter - Trim",
  "ADBE Vector Filter - Twist",
  "ADBE Vector Filter - Roughen",
  "ADBE Vector Filter - Wiggler",
  "ADBE Vector Filter - Zigzag",
]);

// Reverse lookup: display name -> match name for addable items.
export const _ADDABLE_DISPLAY_TO_MATCH: Map<string, string> = new Map();
// Python `del _mn, _auto` at the end of this loop is module-namespace
// cleanup only; TS loop bindings are already block-scoped.
for (const _mn of new Set([
  ..._ADDABLE_MASK_MATCH_NAMES,
  ..._ADDABLE_TEXT_ANIMATOR_MATCH_NAMES,
  ..._ADDABLE_TEXT_SELECTOR_MATCH_NAMES,
  ..._ADDABLE_SHAPE_MATCH_NAMES,
])) {
  const _auto = MATCH_NAME_TO_AUTO_NAME.get(_mn) ?? null;
  if (_auto != null) _ADDABLE_DISPLAY_TO_MATCH.set(_auto, _mn);
}

// Per-group addable sets + builder kind, keyed by parent match name.
// "ADBE Vectors Group" is a nested shape group's own contents.
export const _ADDABLE_BY_GROUP = new Map<string, readonly [ReadonlySet<string>, AddableKind]>([
  ["ADBE Mask Parade", [_ADDABLE_MASK_MATCH_NAMES, AddableKind.MASK]],
  ["ADBE Effect Mask Parade", [_ADDABLE_MASK_MATCH_NAMES, AddableKind.MASK]],
  ["ADBE Text Animators", [_ADDABLE_TEXT_ANIMATOR_MATCH_NAMES, AddableKind.TEXT_ANIMATOR]],
  ["ADBE Text Selectors", [_ADDABLE_TEXT_SELECTOR_MATCH_NAMES, AddableKind.TEXT_SELECTOR]],
  ["ADBE Root Vectors Group", [_ADDABLE_SHAPE_MATCH_NAMES, AddableKind.SHAPE]],
  ["ADBE Vectors Group", [_ADDABLE_SHAPE_MATCH_NAMES, AddableKind.SHAPE]],
  [
    "ADBE Text Animator Properties",
    [_ADDABLE_ANIMATOR_PROPERTY_MATCH_NAMES, AddableKind.ANIMATOR_PROPERTY],
  ],
]);

// Addable groups that are NAMED (not indexed) - the ExtendScript
// "named-group exception". Adding to them materializes a fixed-pool
// member in place rather than appending a new indexed child.
export const _NAMED_ADDABLE_GROUPS: ReadonlySet<string> = new Set(["ADBE Text Animator Properties"]);

/**
 * Resolve `name` to `(match_name, kind)` for an addable property.
 *
 * Returns the resolved match name plus its builder category if the
 * group is an indexed group and `name` is a valid match name or display
 * name for the group type, `null` otherwise. `kind` is the single
 * source of truth for the category, so the model dispatches on it
 * without re-classifying the match name. For the Effect Parade, only
 * the expression controls py_aep can create are accepted (AE itself
 * validates against the installed effects).
 *
 * @param match_name - The match name of the parent group.
 * @param property_type - The property type of the parent group.
 * @param name - A match name or display name to resolve.
 */
export function resolve_addable(
  match_name: string,
  property_type: PropertyType,
  name: string,
): [string, AddableKind] | null {
  if (!name) return null;
  // Most addable groups are indexed; the text-animator Properties group
  // is the NAMED-group exception (see _NAMED_ADDABLE_GROUPS).
  if (property_type !== PropertyType.INDEXED_GROUP && !_NAMED_ADDABLE_GROUPS.has(match_name)) {
    return null;
  }

  if (match_name === "ADBE Effect Parade") {
    const resolved = _ADDABLE_EFFECT_MATCH_NAMES.has(name)
      ? name
      : _EFFECT_DISPLAY_TO_MATCH.get(name) ?? null;
    if (resolved == null) return null;
    const kind =
      resolved === "ADBE Dropdown Control" ? AddableKind.DROPDOWN : AddableKind.EXPRESSION_CONTROL;
    return [resolved, kind];
  }

  const entry = _ADDABLE_BY_GROUP.get(match_name) ?? null;
  if (entry == null) return null;
  const [allowed, kind] = entry;
  if (allowed.has(name)) return [name, kind];
  // Try display name -> match name reverse lookup (pool names for the
  // animator Properties group, since their registry names diverge).
  const resolved =
    kind === AddableKind.ANIMATOR_PROPERTY
      ? _ANIMATOR_PROPERTY_DISPLAY_TO_MATCH.get(name) ?? null
      : _ADDABLE_DISPLAY_TO_MATCH.get(name) ?? null;
  if (resolved != null && allowed.has(resolved)) return [resolved, kind];
  return null;
}

/**
 * Check whether a property with the given name can be added.
 *
 * Returns `true` if the group is an indexed group and `name` is a
 * valid match name or display name for the group type. For the Effect
 * Parade, only the expression controls py_aep can create are
 * accepted.
 *
 * @param match_name - The match name of the parent group.
 * @param property_type - The property type of the parent group.
 * @param name - A match name or display name to check.
 */
export function can_add_property(
  match_name: string,
  property_type: PropertyType,
  name: string,
): boolean {
  return resolve_addable(match_name, property_type, name) !== null;
}
