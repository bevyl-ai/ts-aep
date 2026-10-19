/** The error kinds the package entry point exports, as a caller catches them. */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  AepError,
  FileSystemError,
  InvalidValueError,
  NotFoundError,
  parse,
  type CompItem,
} from "../../src/py_aep/index.ts";

const COMPOSITION_DIR = join(import.meta.dir, "..", "..", "samples", "models", "composition");
const COMP = join(COMPOSITION_DIR, "bgColor.aep");
const C4D = join(COMPOSITION_DIR, "renderer_cinema_4d.aep");

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
}

describe("public error kinds", () => {
  test("a missing file is a FileSystemError", () => {
    const e = thrown(() => parse(join(import.meta.dir, "no-such-file.aep")));
    expect(e).toBeInstanceOf(FileSystemError);
    expect(e).toBeInstanceOf(AepError);
    expect((e as Error).name).toBe("FileSystemError");
  });

  test("an unknown renderer option is a NotFoundError", () => {
    const comp = parse(C4D).project.compositions[0] as CompItem;
    const e = thrown(() => comp.rendererOptions.set("No Such Option", 1));
    expect(e).toBeInstanceOf(NotFoundError);
    expect((e as Error).name).toBe("NotFoundError");
  });

  test("a refused value is an InvalidValueError", () => {
    const comp = parse(COMP).project.compositions[0] as CompItem;
    const e = thrown(() => {
      comp.frameRate = -1;
    });
    expect(e).toBeInstanceOf(InvalidValueError);
    expect((e as Error).name).toBe("InvalidValueError");
  });
});
