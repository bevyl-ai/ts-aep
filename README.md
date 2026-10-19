# ts-aep

An [AI rewrite](https://bun.com/blog/bun-in-rust) of the amazing
[py-aep](https://github.com/forticheprod/py-aep) package, the After Effects
`.aep` reader/writer, in idiomatic TypeScript. It behaves exactly like py-aep
at upstream commit `2cef9f4` (see `UPSTREAM_COMMIT`): the same values, the same
errors, byte-identical saves.

**This is a proof-of-concept project — use with caution.**

The API uses After Effects' own scripting names in camelCase (`comp.frameRate`,
`layer.transform.anchorPoint`, `layer.threeDLayer`, `group.property("ADBE
Position")`), and JS conventions: settings are Map-shaped (`get`/`set`/`has`/
`size`), groups have `length`, `console.log(layer)` prints a readable summary.
Files keep their py-aep twins' paths, so an upstream change maps to the TS file
it touches. Python semantics the behaviour depends on (rounding, floor division,
`struct`, `surrogateescape`, …) live in `src/pyrt/`. Rules: `RULEBOOK.md`.

## Status

Against upstream at the pinned commit (CI runs all of this, including the py-aep
differential, on every push):

- Test suite: all 15,431 upstream tests translated to `bun:test`; 15,369 pass,
  62 skip on missing system fonts / OCIO configs / AE preferences — identical to
  CPython 3.12. (Runtime skips report as passes in bun's tally.)
- Differential check against py-aep on all 644 upstream sample projects
  (`tools/diff/`): every public attribute of the parsed project is identical, and
  25,427 deterministic edits through public setters give the same outcome and
  byte-identical saved files.
- Parse → save is byte-identical on all 644 samples, in Node, Bun, a browser and
  workerd.
- `tsc` reports 0 errors with `strict` on everywhere (library, tests, tools). The library holds 16
  `any` and 54 type assertions, most of them where py-aep itself uses an unchecked
  `cast()`; the gate fails if either count grows. 26 `TODO(port)` markers name the
  remaining known gaps (fontkit/harfbuzzjs vs fontTools/uharfbuzz text metrics,
  argparse help text in the CLIs, integers beyond 2^53, no LZMA decoder).

## Install

```bash
bun add @bevyl-ai/ts-aep
```

```ts
import { parse } from "@bevyl-ai/ts-aep";

const app = parse("project.aep");
for (const comp of app.project.compositions) console.log(comp.name, comp.duration);
app.project.save("copy.aep");
```

## Use

The library runs unchanged in Node 22.3+, Bun, browsers and Cloudflare Workers.
Node and Bun load fontkit and yaml (text metrics, OCIO configs) on first use;
bundlers and Workers resolve the `browser` / `workerd` export, which imports them
up front.
`parse` takes a path or the file's bytes; `project.save(path)` takes a path. All
host access goes through `src/pyrt/host.ts`: Node and Bun use their own
`node:fs`, `node:path` and `node:os` (via `process.getBuiltinModule`); hosts
without them get an in-memory file system and POSIX paths.

A project decodes lazily: `comp.layers` builds each layer from its own
settings, and a layer's properties (Transform, Effects, Masks, Text, ...) are
decoded the first time one is read. A script that reads layer attributes only
(names, times, labels, switches, sources) never builds a property. Reading an
attribute a layer does not have (`source` on a camera) looks it up among its
properties, which builds them; test the layer's type instead.

Beyond py-aep's API: `@bevyl-ai/ts-aep/svg` exports py-aep's public `svg`
module (`readSvg`, `buildShapeLayerContents`, `parseTransform`);
`project.addEffectDefinitions(efdg)` imports effect definitions After Effects
saved in another project, so `addProperty` can add those effects;
`FontObject.technology` and `designVector` are writable (a CFF font needs
`CT_TYPE1_FONT`) and `TextDocument.fonts` lists every font a document
registers; `TextLayer.continuouslyRasterize` sets the collapse switch AE
scripting refuses on text (effects on unrasterized text ask for missing
footage); `Shape.bounds` is the box a shape's points are stored in.
COS reals that `{:.10g}` would write with an exponent are written fixed-point,
which After Effects requires.

### Types

Children are typed by match name: `group.property("ADBE Position")` is a
`Property<number[]>` and `layer.property("ADBE Transform Group")` a group. The
children of the built-in groups (Transform, Text, camera / light / material
options, masks, shape fills, strokes and transforms) are also typed by their
attribute name, as in py-aep:

```ts
const layer = comp.layers[0];
const position: number[] = layer.transform.position.value;
const text = comp.textLayers[0].text?.sourceText.value.text;
```

A child whose attribute name depends on the layer (`anchorPoint` on an AV
layer is a camera's `pointOfInterest`; `rotation` becomes `zRotation` on a 3D
layer) is reached by match name instead. Other built-in children resolve by
attribute name at runtime, untyped; third-party effect parameters are reached
with `group.property("Display Name")`.

### Node / Bun

```ts
import * as aep from "@bevyl-ai/ts-aep";

const app = aep.parse("project.aep");
app.project.save("copy.aep");
```

### Errors

Everything ts-aep throws extends `AepError`, as one of four kinds:

| Class               | Thrown when                                                     |
| ------------------- | --------------------------------------------------------------- |
| `InvalidValueError` | a value After Effects would refuse, or bytes that do not decode |
| `NotFoundError`     | no item, property, key or index by that name or position        |
| `UnsupportedError`  | the file, layer or property type does not support the operation |
| `FileSystemError`   | a file cannot be read or written                                |

```ts
import { AepError, FileSystemError, parse } from "@bevyl-ai/ts-aep";

try {
  parse("missing.aep");
} catch (e) {
  if (e instanceof FileSystemError) console.log("cannot read it");
  else if (e instanceof AepError) console.log(e.name, e.message);
  else throw e;
}
```

Bad arguments throw JS's own `TypeError`.

### Browsers and Workers

Build a bundle, then move bytes in and out of `memfs` around the usual calls:

```bash
bun build src/py_aep/index.ts --target=browser --outdir=dist/browser
```

```ts
import * as py_aep from "./dist/browser/index.js";

py_aep.memfs.write("/in.aep", new Uint8Array(await (await fetch(url)).arrayBuffer()));
py_aep.parse("/in.aep").project.save("/out.aep");
const saved: Uint8Array = py_aep.memfs.read("/out.aep");
```

`memfs` also has `exists`, `list`, `remove` and `clear`. Footage, fonts, ICC
profiles or OCIO configs a project refers to are only found if you write them
into `memfs` at the paths the project expects. `useMemoryFs()` forces the
in-memory backend where `node:fs` exists too; `fsBackend()` reports which one
is active.

Host caveats:

- Node must be 22.3+ (or 20.16+): older Node has no `process.getBuiltinModule`,
  so the library silently falls back to the in-memory fs and real paths are
  not found.

- Text recomposition shapes with harfbuzz (wasm). In a browser, serve
  `node_modules/harfbuzzjs/hb.wasm` next to the bundle's `index.js`. Where it
  cannot load, the library still loads and only shaping raises (the console
  shows emscripten's abort message once).
- Cloudflare Workers refuse to compile wasm from fetched bytes, so shaping is
  unavailable there; everything else works. With the `nodejs_compat` flag,
  `process.getBuiltinModule("node:fs")` returns Workers' own virtual fs (only
  `/tmp` is writable, per request); call `useMemoryFs()` to use `memfs`
  instead. Parse and save are synchronous and CPU-bound: large projects can hit
  the Workers CPU-time limit.
- Without a host, `platform` is `"browser"`, so a new project's default
  platform is macOS (as on any non-Windows host), `tmpdir()` is `/tmp`,
  `homedir()` is `/` and the environment is empty.

Smoke checks: `bun tools/browser-smoke/run.ts [N]` runs the bundle with
`process` hidden (memory fs, POSIX paths) over N samples and checks saves are
byte-identical; `tools/browser-smoke/index.html` does the same in a real
browser (instructions in the file); `tools/browser-smoke/workers-run.ts` runs
the same check inside workerd through miniflare (see its header).

### Development

```bash
bun install
tools/fetch-samples.sh   # upstream checkout + LFS samples (~240 MB)
bun test
```

## License

MIT. Derived from py-aep, Copyright (c) 2023 Fortiche production; see `LICENSE`.

## Releasing

Releases publish from GitHub Actions with npm trusted publishing (OIDC), so no
npm token is stored anywhere:

1. One-time, on npmjs.com: package `@bevyl-ai/ts-aep` → Settings → Trusted publishing →
   GitHub Actions, owner `bevyl-ai`, repository `ts-aep`, workflow `release.yml`.
   If npm requires the package to exist first, do the very first publish by hand
   (`npm login`, then `bun publish --access public`) and add the trusted
   publisher afterwards.
2. Bump `version` in `package.json`, commit, then `git tag v<version> && git push --tags`.
   `.github/workflows/release.yml` runs the tests and the packed-tarball smoke
   (`tools/pack_smoke.sh`), then `npm publish` with provenance.
