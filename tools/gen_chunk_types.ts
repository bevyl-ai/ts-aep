// Generates src/py_aep/binary/chunk_types.ts, the type-level twin of the
// runtime chunk registry: `ChunkTypes` maps each chunk_type passed to
// `register("xxxx", ...)(Cls)` in src/py_aep/binary to `Cls`, so the lookup
// helpers in binary/utils.ts return the registered class for a literal type.
// Each class with struct fields is augmented with those fields' types, derived
// from the format (`u4_field` -> number, `u8_field` -> bigint, bytes -> Uint8Array,
// encoded bytes -> string, `bool_field` / `coerce: py_bool` -> boolean, an enum
// coerce -> that enum, `items_field` -> the item class). Optional fields include
// null. The module holds only `import type` and type declarations: it emits nothing.
//
// usage: bun tools/gen_chunk_types.ts          rewrite chunk_types.ts
//        bun tools/gen_chunk_types.ts --check  exit 1 if it is stale

import ts from "typescript";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const BINARY = path.join(ROOT, "src", "py_aep", "binary");
const OUT = path.join(BINARY, "chunk_types.ts");

// Registration order is import order: chunk.ts, then _register.ts's imports.
const order = ["chunk.ts"];
const reg = ts.createSourceFile(
  "_register.ts",
  fs.readFileSync(path.join(BINARY, "_register.ts"), "utf8"),
  ts.ScriptTarget.Latest,
);
for (const st of reg.statements) {
  if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
    const f = st.moduleSpecifier.text.replace(/^\.\//, "");
    if (!order.includes(f)) order.push(f);
  }
}

const types = new Map<string, { cls: string; file: string }>();
const errors: string[] = [];
for (const file of order) {
  const sf = ts.createSourceFile(file, fs.readFileSync(path.join(BINARY, file), "utf8"), ts.ScriptTarget.Latest, true);
  const exported = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isClassDeclaration(st) && st.name && st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      exported.add(st.name.text);
    }
  }
  for (const st of sf.statements) {
    // register("a", "b")(Cls);
    if (!ts.isExpressionStatement(st) || !ts.isCallExpression(st.expression)) continue;
    const outer = st.expression;
    const inner = outer.expression;
    if (!ts.isCallExpression(inner) || !ts.isIdentifier(inner.expression) || inner.expression.text !== "register")
      continue;
    const [arg] = outer.arguments;
    if (outer.arguments.length !== 1 || !ts.isIdentifier(arg)) {
      errors.push(`${file}: register(...) applied to something other than a class name`);
      continue;
    }
    if (!exported.has(arg.text)) errors.push(`${file}: registered class ${arg.text} is not exported`);
    for (const a of inner.arguments) {
      if (!ts.isStringLiteral(a)) {
        errors.push(`${file}: register(...) for ${arg.text} takes a non-literal chunk_type`);
        continue;
      }
      // A later registration replaces an earlier one, as CHUNK_TYPES.set does.
      types.set(a.text, { cls: arg.text, file });
    }
  }
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

// --- struct field types -------------------------------------------------------

const HELPER_FMT: Record<string, string> = {
  u1Field: "B",
  u2Field: "H",
  u4Field: "I",
  u8Field: "Q",
  s2Field: "h",
  s4Field: "i",
  f4Field: "f",
  f8Field: "d",
  boolField: "B",
};

const files = fs.readdirSync(BINARY).filter((f) => f.endsWith(".ts") && f !== "chunk_types.ts");
const source = new Map<string, ts.SourceFile>();
for (const file of files) {
  source.set(
    file,
    ts.createSourceFile(file, fs.readFileSync(path.join(BINARY, file), "utf8"), ts.ScriptTarget.Latest, true),
  );
}

const propName = (name: ts.PropertyName): string | null => {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
};

type ClassInfo = {
  name: string;
  file: string;
  base: string | null;
  /** get/set/method names: a struct field must not redeclare these. */
  accessors: Set<string>;
  /** Return type of a getter that is not itself a struct field (`color` over `color_r/g/b`). */
  getters: Map<string, string>;
  /** `declare` type text of own properties, when present. */
  declared: Map<string, string>;
};
const classes = new Map<string, ClassInfo>();
for (const [file, sf] of source) {
  for (const st of sf.statements) {
    if (!ts.isClassDeclaration(st) || !st.name) continue;
    const accessors = new Set<string>();
    const getters = new Map<string, string>();
    const declared = new Map<string, string>();
    for (const m of st.members) {
      const name = m.name && propName(m.name);
      if (!name) continue;
      if (ts.isGetAccessor(m) || ts.isSetAccessor(m) || ts.isMethodDeclaration(m)) accessors.add(name);
      if (ts.isGetAccessor(m) && m.type) getters.set(name, m.type.getText(sf).replace(/\s+/g, " ").trim());
      if (ts.isPropertyDeclaration(m) && m.type) declared.set(name, m.type.getText(sf).replace(/\s+/g, " ").trim());
    }
    const base =
      st.heritageClauses
        ?.flatMap((h) => (h.token === ts.SyntaxKind.ExtendsKeyword ? h.types : []))
        .map((t) => t.expression.getText(sf))[0] ?? null;
    classes.set(`${file}:${st.name.text}`, { name: st.name.text, file, base, accessors, getters, declared });
  }
}
const findClass = (name: string, from: string): ClassInfo | undefined =>
  classes.get(`${from}:${name}`) ?? [...classes.values()].find((c) => c.name === name);

const hasAccessor = (info: ClassInfo, field: string): boolean => {
  for (let c: ClassInfo | undefined = info; c; c = c.base ? findClass(c.base, c.file) : undefined) {
    if (c.accessors.has(field)) return true;
  }
  return false;
};

const objProp = (obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined => {
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p) || propName(p.name) !== name) continue;
    return p.initializer;
  }
  return undefined;
};

/** Type a struct format stands for. `encoding` decodes `s`/`p`/`c` to string; `coerce` replaces the unpacked type. */
function typeOfFmt(fmt: string, encoding: string | null, coerce: string | null, optional: boolean): string {
  let base: string;
  if (coerce === "truthy") base = "boolean";
  else if (coerce) base = coerce;
  else {
    const m = /^(\d*)([a-zA-Z?])$/.exec(fmt);
    if (!m) errors.push(`unparsed struct format ${JSON.stringify(fmt)}`);
    const code = m ? m[2] : "";
    if (code === "q" || code === "Q") base = "bigint";
    else if (code === "?") base = "boolean";
    else if (code === "s" || code === "p" || code === "c") base = encoding ? "string" : "Uint8Array";
    else if (code && "bBhHiIlLefd".includes(code)) base = "number";
    else {
      errors.push(`unknown struct code ${JSON.stringify(code)} in ${JSON.stringify(fmt)}`);
      base = "unknown";
    }
  }
  return optional ? `${base} | null` : base;
}

/**
 * The type of one `define()` field, or null when the property is not a struct
 * field (`field({ default })`, a raw `chunk_type`, ...).
 */
function fieldType(init: ts.Expression): { type: string; refs: string[] } | null {
  if (!ts.isCallExpression(init) || !ts.isIdentifier(init.expression)) return null;
  const helper = init.expression.text;
  const opt = init.arguments.find((a): a is ts.ObjectLiteralExpression => ts.isObjectLiteralExpression(a));
  const optional = !!opt && objProp(opt, "optional")?.kind === ts.SyntaxKind.TrueKeyword;
  const encNode = opt && objProp(opt, "encoding");
  const encoding = encNode && ts.isStringLiteral(encNode) ? encNode.text : encNode ? "" : null;
  const coerceNode = opt && objProp(opt, "coerce");
  const coerce = coerceNode && ts.isIdentifier(coerceNode) ? coerceNode.text : null;
  if (helper === "itemsField") {
    const cls = init.arguments[0];
    if (!cls || !ts.isIdentifier(cls)) {
      errors.push("itemsField() item class is not a name");
      return null;
    }
    const type = optional ? `${cls.text}[] | null` : `${cls.text}[]`;
    return { type, refs: [cls.text] };
  }
  let fmt: string | null = null;
  let enc = encoding;
  let crc = coerce;
  if (helper === "fmtField") {
    const a0 = init.arguments[0];
    if (!a0 || !ts.isStringLiteral(a0)) {
      errors.push("fmtField() format is not a string literal");
      return null;
    }
    fmt = a0.text;
  } else if (helper === "bytesField") fmt = "s";
  else if (helper === "strField") {
    fmt = "s";
    enc = enc || "utf-8";
  } else if (helper === "asciiField") {
    fmt = "s";
    enc = "ascii";
  } else if (helper === "boolField") {
    fmt = "B";
    crc = crc ?? "truthy";
  } else if (helper in HELPER_FMT) {
    const mapped = HELPER_FMT[helper];
    if (mapped == null) return null;
    fmt = mapped;
  } else return null;
  // An enum coerce names the enum type (`coerce: SomeEnum` -> `SomeEnum`).
  const refs = crc && crc !== "truthy" ? [crc] : [];
  return { type: typeOfFmt(fmt, enc, crc, optional), refs };
}

type OwnedFields = { cls: string; file: string; fields: { name: string; type: string }[]; refs: Set<string> };
const owned: OwnedFields[] = [];
for (const [file, sf] of source) {
  for (const st of sf.statements) {
    if (!ts.isExpressionStatement(st) || !ts.isCallExpression(st.expression)) continue;
    const call = st.expression;
    if (!ts.isIdentifier(call.expression) || call.expression.text !== "define") continue;
    const clsNode = call.arguments[0];
    const spec = call.arguments[1];
    if (!clsNode || !ts.isIdentifier(clsNode) || !spec || !ts.isObjectLiteralExpression(spec)) {
      errors.push(`${file}: define() is not define(Class, { ... })`);
      continue;
    }
    const info = findClass(clsNode.text, file);
    if (!info) {
      errors.push(`${file}: define() on unknown class ${clsNode.text}`);
      continue;
    }
    const fields: { name: string; type: string }[] = [];
    const refs = new Set<string>();
    for (const p of spec.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const name = propName(p.name);
      if (!name) {
        errors.push(`${file}: ${clsNode.text} has a computed field name`);
        continue;
      }
      const parsed = fieldType(p.initializer);
      if (!parsed) continue;
      if (hasAccessor(info, name)) continue;
      // A hand-written enum annotation wins over the unpacked integer (`declare status: RQItemStatus`).
      const declared = info.declared.get(name);
      const enumName = declared && /^[A-Z][A-Za-z0-9_]*$/.test(declared) && parsed.type === "number" ? declared : null;
      // An integer field the code also stores a boolean in (`_spatial_marker = false`) keeps
      // `number | boolean`: writing `0`/`1` instead would change the value held on the object.
      const boolUnion =
        declared === `${parsed.type} | boolean` || declared === `boolean | ${parsed.type}` ? declared : null;
      // `q`/`Q` unpack to bigint, but the field default and every writer pass a number
      // (`sspc.data_size = size`). Storing `0n` instead is a different value, so the field
      // holds both.
      const big = parsed.type === "bigint" ? "number | bigint" : null;
      const type = enumName ?? boolUnion ?? big ?? parsed.type;
      if (enumName) refs.add(enumName);
      for (const r of parsed.refs) refs.add(r);
      fields.push({ name, type });
    }
    if (fields.length) owned.push({ cls: clsNode.text, file, fields, refs });
  }
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

// `find_by_type(chunks, "Ropt")` is typed as the registered base, while `read()`
// returns a variant. Models keep the base, so a field every variant defines the
// same way is added there (`body.solid_name`). A field the variants type
// differently stays on the variant only.
const NO_VARIANT = new Set(["Chunk", "ContainerChunk", "ListChunk", "FmtItem", "AttrsBase"]);
const variantKids = new Map<string, ClassInfo[]>();
for (const info of classes.values()) {
  const parent = info.base ? findClass(info.base, info.file) : undefined;
  if (!parent || NO_VARIANT.has(parent.name)) continue;
  const key = `${parent.file}:${parent.name}`;
  const list = variantKids.get(key);
  if (list) list.push(info);
  else variantKids.set(key, [info]);
}
const ownedBy = new Map(owned.map((o) => [`${o.file}:${o.cls}`, o]));
for (const [key, list] of variantKids) {
  const parent = classes.get(key);
  if (!parent) continue;
  const typesByName = new Map<string, Set<string>>();
  const add = (name: string, type: string) => {
    if (parent.accessors.has(name)) return;
    const declared = parent.declared.get(name);
    if (declared != null && declared !== type) return;
    const set = typesByName.get(name);
    if (set) set.add(type);
    else typesByName.set(name, new Set([type]));
  };
  for (const child of list) {
    const childOwned = ownedBy.get(`${child.file}:${child.name}`);
    if (childOwned) for (const f of childOwned.fields) add(f.name, f.type);
    for (const [name, type] of child.getters) add(name, type);
  }
  const extra: { name: string; type: string }[] = [];
  for (const [name, set] of typesByName) {
    if (set.size !== 1) continue;
    const type = [...set][0];
    if (type == null) continue;
    if (parent.declared.get(name) === type) continue;
    if (ownedBy.get(key)?.fields.some((f) => f.name === name)) continue;
    extra.push({ name, type });
  }
  if (!extra.length) continue;
  const entry = ownedBy.get(key);
  if (entry) entry.fields.push(...extra);
  else {
    const created: OwnedFields = { cls: parent.name, file: parent.file, fields: extra, refs: new Set() };
    owned.push(created);
    ownedBy.set(key, created);
  }
}
const byFile = new Map<string, Set<string>>([["chunk.ts", new Set(["Chunk"])]]);
const addImport = (file: string, name: string) => {
  const set = byFile.get(file);
  if (set) set.add(name);
  else byFile.set(file, new Set([name]));
};
const sortedTypes = [...types].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
for (const { cls, file } of types.values()) addImport(file, cls);
// An item class declared in the augmented module resolves inside `declare module` without an import.
for (const { file, refs } of owned) for (const r of refs) if (!classes.has(`${file}:${r}`)) addImport(file, r);
const ident = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name));
const byModule = new Map<string, OwnedFields[]>();
const moduleGroup = (file: string): OwnedFields[] => {
  const group = byModule.get(file);
  if (group) return group;
  const created: OwnedFields[] = [];
  byModule.set(file, created);
  return created;
};
for (const o of owned) moduleGroup(o.file).push(o);
const augmentations = [...byModule]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([file, groups]) => {
    const body = groups
      .sort((a, b) => a.cls.localeCompare(b.cls))
      .flatMap(({ cls, fields }) => [
        `  interface ${cls} {`,
        ...fields.map((f) => `    ${ident(f.name)}: ${f.type};`),
        "  }",
      ]);
    return [`declare module "./${file}" {`, ...body, "}"].join("\n");
  });
const key = (t: string) => (/^[A-Za-z_$][\w$]*$/.test(t) ? t : JSON.stringify(t));
const out = [
  "// Generated by tools/gen_chunk_types.ts; do not edit.",
  "// The class each chunk_type is registered to (`register(...)(Cls)`); type-only.",
  "",
  ...[...byFile]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, classes]) => `import type { ${[...classes].sort().join(", ")} } from "./${file}";`),
  "",
  "/** Registered chunk class by `chunk_type`. */",
  "export interface ChunkTypes {",
  ...sortedTypes.map(([t, { cls }]) => `  ${key(t)}: ${cls};`),
  "}",
  "",
  "/** Registered chunk class (the constructor) by `chunk_type`: what `CHUNK_TYPES.get` returns. */",
  "export interface ChunkClasses {",
  ...sortedTypes.map(([t, { cls }]) => `  ${key(t)}: typeof ${cls};`),
  "}",
  "",
  "/** The class a chunk of type `K` is read as: its registered class, else `Chunk`. */",
  "export type ChunkOf<K extends string> = K extends keyof ChunkTypes ? ChunkTypes[K] : Chunk;",
  "",
  "// Struct fields of each chunk/item class (`define(Cls, { f: u4_field(), ... })`).",
  "// Integers are `number`, `q`/`Q` are `number | bigint` (the unpack is a bigint, the",
  "// writers store a number), raw `s` is `Uint8Array`, an encoding makes `string`,",
  "// `bool_field` and `coerce: py_bool` are `boolean`, an enum coerce (or a `declare`",
  "// of an enum over an integer) is that enum, `items_field` is the item class.",
  "// Optional fields include `null`. A field shared by every variant of a",
  "// registered base (`RoptChunk`, `OptiChunk`) is declared on the base too,",
  "// which is what `find_by_type` returns and what models store.",
  ...augmentations,
  "",
].join("\n");

if (process.argv.includes("--check")) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (current !== out) {
    console.error("src/py_aep/binary/chunk_types.ts is stale: run bun tools/gen_chunk_types.ts");
    process.exit(1);
  }
  console.log(
    `chunk_types.ts up to date (${types.size} chunk types, ${owned.reduce((n, o) => n + o.fields.length, 0)} fields)`,
  );
} else {
  fs.writeFileSync(OUT, out);
  console.log(
    `wrote src/py_aep/binary/chunk_types.ts (${types.size} chunk types, ${owned.reduce((n, o) => n + o.fields.length, 0)} fields)`,
  );
}
