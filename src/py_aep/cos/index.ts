/** COS (Carousel Object Syntax) parser and serializer. */

export {
  CosName,
  CosParser,
  IndirectObject,
  IndirectReference,
  Stream,
  cosGet,
  runSpans,
} from "./cos.ts";
export { CosField } from "./descriptors.ts";
export { decodePdfTextString } from "./pdfdoc.ts";
export { serialize } from "./serializer.ts";
export { POINT_TEXT_COS_TEMPLATE, getCosTemplate } from "./text.ts";
