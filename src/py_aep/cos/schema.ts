/**
 * zod schemas for the text-document COS tree (the `btdk` blob).
 *
 * Two layers, both run by the library:
 *
 * - {@link decodeBtdk} is the single entry point from a parsed
 *   {@link CosNode}: it checks the whole blob against {@link cosNode}
 *   (every value a COS kind, every dictionary string-keyed) and only then
 *   hands the tree to the text models as a {@link CosDict}. Nothing deeper is checked
 *   there, because py_aep never validates COS: a value of the wrong kind
 *   fails (or is tolerated) at the point of use, so the decode must not
 *   reject what Python would read later or never.
 * - The layouts below name the kind of every key py_aep reads with an
 *   `isinstance` check; {@link read} runs the key's schema on the value
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

import * as z from "zod/mini";
import { PyFloat } from "../../pyrt/index.ts";
import { CosName, CosString, IndirectObject, IndirectReference, Stream, type CosDict, type CosNode } from "./cos.ts";
import { pyInt, pyNumber } from "./kinds.ts";

/** Any COS value, checked recursively (dictionaries and arrays included). */
export const cosNode: z.ZodMiniType<CosNode> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.instanceof(PyFloat),
    z.string(),
    z.instanceof(CosString),
    z.instanceof(Uint8Array),
    z.instanceof(CosName),
    z.instanceof(IndirectObject),
    z.instanceof(IndirectReference),
    z.instanceof(Stream),
    z.array(cosNode),
    z.map(z.string(), cosNode),
  ]),
);

/**
 * {@link cosNode}'s check written out by hand: running the zod union over
 * every value of a text document cost more than parsing the document.
 * zod's `z.number()` refuses `NaN` and infinities, hence `Number.isFinite`.
 */
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
    x instanceof PyFloat ||
    x instanceof CosString ||
    x instanceof Uint8Array ||
    x instanceof CosName ||
    x instanceof IndirectObject ||
    x instanceof IndirectReference ||
    x instanceof Stream
  );
}

/** Whether `tree` is a COS dictionary whose every value is a COS value (see {@link cosNode}). */
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
export type Layout = { readonly [key: string]: z.ZodMiniType<CosNode> };

/**
 * `d[key]` typed by the layout: the value when present and of the
 * layout's kind for `key` (the schema runs on the current value), else
 * `undefined`.
 */
export function read<L extends Layout, K extends keyof L & string>(layout: L, d: CosDict, key: K): z.output<L[K]> | undefined {
  if (!d.has(key)) return undefined;
  const result = layout[key].safeParse(d.get(key));
  return result.success ? result.data : undefined;
}

/** A COS name (`/SimplePaint`), the class tag under key `"99"`. */
export const cosName = z.instanceof(CosName);

/** A character style (run payload, document default and preset style). */
export const charStyle = {
  "0": pyInt, // font index into the font table
  "1": pyNumber, // font size
  "2": z.boolean(), // faux bold
  "3": z.boolean(), // faux italic
  "4": z.boolean(), // auto leading
  "5": pyNumber, // leading
  "6": pyNumber, // horizontal scale
  "7": pyNumber, // vertical scale
  "8": pyInt, // tracking
  "9": pyNumber, // baseline shift
  "11": pyInt, // auto kern type
  "12": pyInt, // font caps option
  "13": pyInt, // font baseline option
  "18": z.boolean(), // ligature
  "35": pyInt, // baseline direction
  "36": pyNumber, // tsume
  "52": z.boolean(), // no break
  "56": z.boolean(), // apply fill
  "57": z.boolean(), // apply stroke
  "58": z.boolean(), // stroke over fill
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
