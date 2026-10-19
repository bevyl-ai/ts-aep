// Python-semantics runtime for the py_aep port. Import what a module needs
// by name: `import { struct, round, py_bool } from "../../pyrt/index.ts"`.

export * from "./errors.ts";
export * from "./builtins.ts";
export * from "./num.ts";
export * as struct from "./struct.ts";
export * as Bytes from "./bytes.ts";
export { ascii, ascii as b, concat, equals as bytesEqual } from "./bytes.ts";
export { decode, encode, ord } from "./codecs.ts";
export { ByteStream, FileStream, openFile } from "./bytesio.ts";
export { Fraction } from "./fraction.ts";
export {
  define,
  field,
  fields,
  has as attrsHas,
  Factory,
  AttrsBase,
  NO_INIT,
  attrsEq,
  type Attribute,
  type FieldSpec,
} from "./attrs.ts";
export { defineEnum, auto, type EnumValue } from "./enum.ts";
export { Path, PurePath, PurePosixPath, PureWindowsPath, fspath, type PathLike } from "./pathlib.ts";
export {
  descriptor,
  getDescriptor,
  descriptorsOf,
  pyObject,
  pyClassHooks,
  objectSetattr,
  objectGetattr,
  instanceDict,
  hasInstanceDict,
  type ClassAttributes,
} from "./dunder.ts";
export * as etree from "./etree.ts";
export { hypot } from "./math.ts";
export {
  parseJson,
  stringifyJson,
  jsonFloat,
  jsonGet,
  jsonRequire,
  jsonInt,
  JSONDecodeError,
  type JsonValue,
} from "./json.ts";
export { pyRe, reSearch, reMatch, reEscape, reFlags, patternMatch } from "./re.ts";
