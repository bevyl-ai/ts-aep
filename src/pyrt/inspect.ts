/** Node's `util.inspect.custom`: the readable form `console.log` shows, and `repr()`. */
export const INSPECT: unique symbol = Symbol.for("nodejs.util.inspect.custom");

/** A value as a JS literal for debug output: `'text'`, `true`, `null`, `[1, 2]`, `Map { 'k' => v }`. */
export function literal(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return `[${value.map(literal).join(", ")}]`;
  if (value instanceof Uint8Array) return `Uint8Array(${value.length})`;
  if (value instanceof Map) return `Map { ${[...value].map(([k, v]) => `${literal(k)} => ${literal(v)}`).join(", ")} }`;
  if (typeof value === "object" && INSPECT in value && typeof value[INSPECT] === "function") return String(value[INSPECT]());
  return String(value);
}

/** Debug form `Name { key: value, ... }` for `console.log` and error messages. */
export function describe(name: string, fields: Record<string, unknown>): string {
  const parts = Object.entries(fields).map(([k, v]) => `${k}: ${literal(v)}`);
  return parts.length ? `${name} { ${parts.join(", ")} }` : `${name} {}`;
}
