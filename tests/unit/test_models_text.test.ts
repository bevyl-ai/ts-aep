import { afterEach, describe, expect, mock, test } from "bun:test";

import "../../src/py_aep/binary/_register.ts";
import { raises } from "../../src/pyrt/pytest.ts";
import { AssertionError_, Path, RuntimeError, b } from "../../src/pyrt/index.ts";
import { PropertyValueType } from "../../src/py_aep/enums/index.ts";
import * as specialized_properties from "../../src/py_aep/parsers/specialized_properties.ts";
import { SyntaxError_ } from "../../src/py_aep/cos/cos.ts";

const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "layer");

// NOTE(port): `monkeypatch.setattr(specialized_properties, name, value)` - ESM namespace
// bindings are read-only, so the name is patched in the module that defines it via bun's
// `mock.module` (live bindings update in already-imported modules) and restored by `undo`.
const PATCH_MODULES: Record<string, string> = {
  find_by_list_type: "../../src/py_aep/binary/utils.ts",
  parse_property: "../../src/py_aep/parsers/property_value.ts",
  CosParser: "../../src/py_aep/cos/index.ts",
  parse_btdk_cos: "../../src/py_aep/parsers/text.ts",
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
    const prop: { keyframes: never[]; value: null; _property_value_type: PropertyValueType | null } = {
      keyframes: [],
      value: null,
      _property_value_type: null,
    };
    const tdbs_chunk = { chunks: [] };
    const btdk_chunk = { data: b("bad") };
    const root_chunk = { chunks: [] };

    // NOTE(port): Python fake is keyword-only because the caller passes chunks=/list_type= by keyword; RULEBOOK maps positional-or-keyword params to positional, so the TS call and fake are positional.
    const fake_find_by_list_type = (chunks: unknown, list_type: string) => {
      if (list_type === "tdbs") return tdbs_chunk;
      if (list_type === "btdk") return btdk_chunk;
      throw new AssertionError_(`Unexpected list_type: ${list_type}`);
    };

    class BrokenCosParser {
      constructor(..._args: unknown[]) {}

      parse(): Record<string, unknown> {
        throw new SyntaxError_("bad COS");
      }
    }

    monkeypatch.setattr(specialized_properties, "find_by_list_type", fake_find_by_list_type);
    monkeypatch.setattr(specialized_properties, "parse_property", (..._kwargs: unknown[]) => prop);
    monkeypatch.setattr(specialized_properties, "CosParser", BrokenCosParser);

    const result = specialized_properties.parse_text_document(
      // @ts-expect-error SimpleNamespace stand-in for a ListChunk
      root_chunk,
      "ADBE Text Document",
      0,
      {},
      {},
    );

    expect<unknown>(result).toBe(prop);
    expect(prop._property_value_type).toBe(PropertyValueType.TEXT_DOCUMENT);
    expect(prop.value == null).toBe(true);
  });

  test("test_raises_unexpected_cos_errors", () => {
    /** Unexpected bugs in COS conversion should still surface. */
    const prop: { keyframes: never[]; value: null; _property_value_type: PropertyValueType | null } = {
      keyframes: [],
      value: null,
      _property_value_type: null,
    };
    const tdbs_chunk = { chunks: [] };
    const btdk_chunk = { data: b("ok") };
    const root_chunk = { chunks: [] };

    // NOTE(port): Python fake is keyword-only because the caller passes chunks=/list_type= by keyword; RULEBOOK maps positional-or-keyword params to positional, so the TS call and fake are positional.
    const fake_find_by_list_type = (chunks: unknown, list_type: string) => {
      if (list_type === "tdbs") return tdbs_chunk;
      if (list_type === "btdk") return btdk_chunk;
      throw new AssertionError_(`Unexpected list_type: ${list_type}`);
    };

    class ValidCosParser {
      constructor(..._args: unknown[]) {}

      parse(): Map<string, unknown> {
        return new Map<string, unknown>();
      }
    }

    const raise_runtime_error = (..._args: unknown[]): unknown => {
      throw new RuntimeError("boom");
    };

    monkeypatch.setattr(specialized_properties, "find_by_list_type", fake_find_by_list_type);
    monkeypatch.setattr(specialized_properties, "parse_property", (..._kwargs: unknown[]) => prop);
    monkeypatch.setattr(specialized_properties, "CosParser", ValidCosParser);
    monkeypatch.setattr(specialized_properties, "parse_btdk_cos", raise_runtime_error);

    raises(
      RuntimeError,
      () =>
        specialized_properties.parse_text_document(
          // @ts-expect-error SimpleNamespace stand-in for a ListChunk
          root_chunk,
          "ADBE Text Document",
          0,
          {},
          {},
        ),
      "boom",
    );
  });
});
