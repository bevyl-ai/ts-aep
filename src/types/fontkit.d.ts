// Source-only: types `import "fontkit"` (browser entry, `dep("fontkit")`).
// Not shipped, so it never overrides a consumer's own fontkit declarations.
declare module "fontkit" {
  export const create: import("../pyrt/fontkit.ts").Fontkit["create"];
}
