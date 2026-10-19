// Heavy dependencies only some features need (fontkit: text metrics; yaml: OCIO
// configs), loaded on first use instead of at import. Node and Bun load them
// through `require`; bundled hosts (browsers, Workers) import them statically
// in `py_aep/browser.ts` and hand them over with `provideDep`.

import type { Fontkit } from "./fontkit.ts";
import type * as Yaml from "yaml";

type Deps = { fontkit: Fontkit; yaml: typeof Yaml };

const loaded: Partial<Deps> = {};

/** Hand over a statically imported dependency (bundled hosts). */
export function provideDep<K extends keyof Deps>(name: K, mod: Deps[K]): void {
  loaded[name] = mod;
}

/** The dependency, loaded on first use. */
export function dep<K extends keyof Deps>(name: K): Deps[K] {
  const mod = loaded[name];
  if (mod !== undefined) return mod;
  const nodeModule = globalThis.process?.getBuiltinModule?.("node:module");
  if (nodeModule == null) {
    throw new Error(`${name} is not loaded: import "@bevyl-ai/ts-aep" through its browser entry on this host`);
  }
  return (loaded[name] = nodeModule.createRequire(import.meta.url)(name) as Deps[K]);
}
