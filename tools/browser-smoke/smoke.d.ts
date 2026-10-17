export interface SmokeResult {
  backend: string;
  total: number;
  identical: number;
  problems: string[];
}

export function smoke(
  py_aep: typeof import("../../src/py_aep/index.ts"),
  fetch_bytes: (name: string) => Promise<Uint8Array>,
  samples: string[],
  log: (line: string) => void,
): Promise<SmokeResult>;
