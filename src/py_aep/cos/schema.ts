/**
 * Kinds and layouts for the text-document COS tree (the `btdk` blob).
 *
 * Two layers, both run by the library:
 *
 * - {@link decodeBtdk} is the single entry point from a parsed
 *   {@link CosNode}: it checks the whole blob with `isCosNode`
 *   (every value a COS kind, every dictionary string-keyed) and only then
 *   hands the tree to the text models as a {@link CosDict}. Nothing deeper is checked
 *   there, because py_aep never validates COS: a value of the wrong kind
 *   fails (or is tolerated) at the point of use, so the decode must not
 *   reject what Python would read later or never.
 * - The layouts below name the kind of every key py_aep reads with an
 *   `isinstance` check; {@link read} runs the key's kind on the value
 *   at the moment it is read and returns it typed, or `undefined` when it
 *   is absent or of another kind (which is what the `isinstance` check
 *   decides in Python). Keys read through a Python builtin instead go
 *   through the operations in `kinds.ts`, which raise what the builtin
 *   raises.
 *
 * The layouts are the dicts py_aep reads with `isinstance` checks.
 * `tests/unit/test_cos_schema.test.ts` checks that every sample's tree, and
 * the trees py_aep writes, match them wherever they sit, so real files take
 * the typed path.
 */

import { BoxedFloat } from "../../pyrt/index.ts";
import { CosName, CosString, IndirectObject, IndirectReference, Stream, type CosDict, type CosNode } from "./cos.ts";
import { pyBoolKind, pyInt, pyNumber, type Kind } from "./kinds.ts";

/** Every value a COS kind and every dictionary string-keyed; numbers are finite. */
function isCosNode(x: CosNode): boolean {
  if (x === null || typeof x === "boolean" || typeof x === "string") return true;
  if (typeof x === "number") return Number.isFinite(x);
  if (Array.isArray(x)) return x.every(isCosNode);
  if (x instanceof Map) {
    for (const [key, value] of x) {
      if (typeof key !== "string" || !isCosNode(value)) return false;
    }
    return true;
  }
  return (
    x instanceof BoxedFloat ||
    x instanceof CosString ||
    x instanceof Uint8Array ||
    x instanceof CosName ||
    x instanceof IndirectObject ||
    x instanceof IndirectReference ||
    x instanceof Stream
  );
}

/** Whether `tree` is a COS dictionary whose every value is a COS value. */
function isCosDict(tree: CosNode): tree is CosDict {
  return tree instanceof Map && isCosNode(tree);
}

/**
 * Decode a parsed `btdk` blob: the tree itself when it is a COS
 * dictionary of COS values, else `null` (py_aep then gives the layer no
 * text documents, as for any non-dict blob).
 */
export function decodeBtdk(tree: CosNode): CosDict | null {
  return isCosDict(tree) ? tree : null;
}

// -- Layouts --------------------------------------------------------------------

/** The kind of each key of one COS dictionary layout. */
export type Layout = { readonly [key: string]: Kind<CosNode> };

/** `d[key]` when it is of the kind the layout gives `key`, else `undefined` (absent or another kind). */
export function read<K extends string, T extends CosNode>(
  layout: { readonly [P in K]: Kind<T> },
  d: CosDict,
  key: K,
): T | undefined {
  const value = d.get(key);
  return layout[key](value) ? value : undefined;
}

export const cosName: Kind<CosName> = (x): x is CosName => x instanceof CosName;

/** A character style (run payload, document default and preset style). */
export const charStyle = {
  "0": pyInt, // font index into the font table
  "1": pyNumber, // font size
  "2": pyBoolKind, // faux bold
  "3": pyBoolKind, // faux italic
  "4": pyBoolKind, // auto leading
  "5": pyNumber, // leading
  "6": pyNumber, // horizontal scale
  "7": pyNumber, // vertical scale
  "8": pyInt, // tracking
  "9": pyNumber, // baseline shift
  "11": pyInt, // auto kern type
  "12": pyInt, // font caps option
  "13": pyInt, // font baseline option
  "18": pyBoolKind, // ligature
  "35": pyInt, // baseline direction
  "36": pyNumber, // tsume
  "52": pyBoolKind, // no break
  "56": pyBoolKind, // apply fill
  "57": pyBoolKind, // apply stroke
  "58": pyBoolKind, // stroke over fill
  "62": pyInt, // line join type
  "63": pyNumber, // stroke width
  "70": pyInt, // digit set
} as const;

/** A `/L` (line) cache node: its baseline (`"10"` is a dict on other tags). */
export const cacheLine = {
  "99": cosName,
  "10": pyNumber, // baseline
} as const;

/** First-baseline settings (`frame["2"]["10"]`): alignment and minimum. */
export const firstBaseline = { "0": pyInt, "1": pyNumber } as const;

/** A font-index holder: a style, typography settings or used-font record (`"0"`). */
export const fontRef = { "0": pyInt } as const;
