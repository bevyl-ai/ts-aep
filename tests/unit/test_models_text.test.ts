import { afterEach, describe, expect, mock, test } from "bun:test";

import "../../src/py_aep/binary/_register.ts";

import { AssertionError, RuntimeError, b } from "../../src/pyrt/index.ts";
import { PropertyValueType } from "../../src/py_aep/enums/index.ts";
import * as specialized_properties from "../../src/py_aep/parsers/specialized_properties.ts";
import { raises } from "../support/pytest.ts";

// NOTE(port): `monkeypatch.setattr(specialized_properties, name, value)` - ESM namespace
// bindings are read-only, so the name is patched in the module that defines it via bun's
// `mock.module` (live bindings update in already-imported modules) and restored by `undo`.
const PATCH_MODULES: Record<string, string> = {
  findByListType: "../../src/py_aep/binary/utils.ts",
  parseProperty: "../../src/py_aep/parsers/property_value.ts",
  CosParser: "../../src/py_aep/cos/index.ts",
  parseBtdkCos: "../../src/py_aep/parsers/text.ts",
};
const REAL_MODULES = new Map<string, Record<string, unknown>>();
for (const path of Object.values(PATCH_MODULES)) {
  REAL_MODULES.set(path, { ...(await import(path)) });
}

class MonkeyPatch {
  private readonly patched = new Map<string, Record<string, unknown>>();

  setattr(_obj: unknown, name: string, value: unknown): void {
    const path = PATCH_MODULES[name];
    const overrides = this.patched.get(path) ?? {};
    overrides[name] = value;
    this.patched.set(path, overrides);
    mock.module(path, () => ({ ...REAL_MODULES.get(path), ...overrides }));
  }

  undo(): void {
    for (const path of this.patched.keys()) {
      mock.module(path, () => ({ ...REAL_MODULES.get(path) }));
    }
    this.patched.clear();
  }
}

describe("TestParseTextDocument", () => {
  /** Unit tests for Source Text property parsing fallbacks. */

  const monkeypatch = new MonkeyPatch();
  afterEach(() => monkeypatch.undo());

  test("test_ignores_malformed_cos_payload", () => {
    /** Malformed COS data should keep the property but skip the value. */
    const prop: { keyframes: never[]; value: null; _propertyValueType: PropertyValueType | null } = {
      keyframes: [],
      value: null,
      _propertyValueType: null,
    };
    const tdbsChunk = { chunks: [] };
    const btdkChunk = { data: b("bad") };
    const rootChunk = { chunks: [] };

    // NOTE(port): Python fake is keyword-only because the caller passes chunks=/list_type= by keyword; RULEBOOK maps positional-or-keyword params to positional, so the TS call and fake are positional.
    const fakeFindByListType = (chunks: unknown, listType: string) => {
      if (listType === "tdbs") return tdbsChunk;
      if (listType === "btdk") return btdkChunk;
      throw new AssertionError(`Unexpected list_type: ${listType}`);
    };

    class BrokenCosParser {
      constructor(..._args: unknown[]) {}

      parse(): Record<string, unknown> {
        throw new SyntaxError("bad COS");
      }
    }

    monkeypatch.setattr(specialized_properties, "findByListType", fakeFindByListType);
    monkeypatch.setattr(specialized_properties, "parseProperty", (..._kwargs: unknown[]) => prop);
    monkeypatch.setattr(specialized_properties, "CosParser", BrokenCosParser);

    const result = specialized_properties.parseTextDocument(
      // @ts-expect-error SimpleNamespace stand-in for a ListChunk
      rootChunk,
      "ADBE Text Document",
      0,
      {},
      {},
    );

    expect<unknown>(result).toBe(prop);
    expect(prop._propertyValueType).toBe(PropertyValueType.TEXT_DOCUMENT);
    expect(prop.value == null).toBe(true);
  });

  test("test_raises_unexpected_cos_errors", () => {
    /** Unexpected bugs in COS conversion should still surface. */
    const prop: { keyframes: never[]; value: null; _propertyValueType: PropertyValueType | null } = {
      keyframes: [],
      value: null,
      _propertyValueType: null,
    };
    const tdbsChunk = { chunks: [] };
    const btdkChunk = { data: b("ok") };
    const rootChunk = { chunks: [] };

    // NOTE(port): Python fake is keyword-only because the caller passes chunks=/list_type= by keyword; RULEBOOK maps positional-or-keyword params to positional, so the TS call and fake are positional.
    const fakeFindByListType = (chunks: unknown, listType: string) => {
      if (listType === "tdbs") return tdbsChunk;
      if (listType === "btdk") return btdkChunk;
      throw new AssertionError(`Unexpected list_type: ${listType}`);
    };

    class ValidCosParser {
      constructor(..._args: unknown[]) {}

      parse(): Map<string, unknown> {
        return new Map<string, unknown>();
      }
    }

    const raiseRuntimeError = (..._args: unknown[]): unknown => {
      throw new RuntimeError("boom");
    };

    monkeypatch.setattr(specialized_properties, "findByListType", fakeFindByListType);
    monkeypatch.setattr(specialized_properties, "parseProperty", (..._kwargs: unknown[]) => prop);
    monkeypatch.setattr(specialized_properties, "CosParser", ValidCosParser);
    monkeypatch.setattr(specialized_properties, "parseBtdkCos", raiseRuntimeError);

    raises(
      RuntimeError,
      () =>
        specialized_properties.parseTextDocument(
          // @ts-expect-error SimpleNamespace stand-in for a ListChunk
          rootChunk,
          "ADBE Text Document",
          0,
          {},
          {},
        ),
      "boom",
    );
  });
});
