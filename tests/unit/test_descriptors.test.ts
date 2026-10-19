/** Tests for ChunkField and CosField descriptor contracts. */

import { describe, expect, test } from "bun:test";

import {
  AttributeError,
  RuntimeError,
  ValueError,
  descriptor,
  float,
  getOrThrow,
  int,
  defineEnum,
  assert,
  truthy,
  instanceDict,
} from "../../src/pyrt/index.ts";
import type { EnumValue } from "../../src/pyrt/index.ts";
import { boxFloat } from "../../src/pyrt/num.ts";

import type { CosDict, CosNode } from "../../src/py_aep/cos/cos.ts";
import { CosField } from "../../src/py_aep/cos/descriptors.ts";
import { cosFloat } from "../../src/py_aep/cos/kinds.ts";
import { ChunkField, materialization, runSuppressed } from "../../src/py_aep/models/descriptors.ts";
import { raises } from "../support/pytest.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal stub for a chunk body that tracks setattr calls. */
class _FakeBody {
  [key: string]: unknown;
  declare synthetic: boolean;

  constructor(kw: { synthetic?: boolean; [key: string]: unknown } = {}) {
    const { synthetic = false, ...kwargs } = kw;
    this.synthetic = synthetic;
    for (const [k, v] of Object.entries(kwargs)) {
      Reflect.set(this, k, v);
    }
  }
}

/** Minimal stub for a parent chunk with len_body. */
class _FakeParent {
  _parent: _FakeParent | null = null;
  declare body: _FakeBody;

  constructor(child: _FakeBody) {
    this.body = child;
    child._parent = this; // type: ignore[attr-defined]
  }
}

// ---------------------------------------------------------------------------
// ChunkField contract tests
// ---------------------------------------------------------------------------

/** Model using a scalar reverse. */
class _ScalarModel {
  declare _body: _FakeBody | null;
  declare quality: number;

  constructor(body: _FakeBody | null) {
    this._body = body;
  }
}
descriptor(_ScalarModel, "quality", new ChunkField<number>("_body", "quality", { reverse: int }));

/** Model with no reverse (direct write). */
class _DirectModel {
  declare _body: _FakeBody | null;
  declare name: string;

  constructor(body: _FakeBody | null) {
    this._body = body;
  }
}
descriptor(_DirectModel, "name", new ChunkField<string>("_body", "name"));

describe("TestChunkFieldScalarReverse", () => {
  test("test_scalar_reverse_writes_one_field", () => {
    const body = new _FakeBody({ quality: 0 });
    new _FakeParent(body);
    const model = new _ScalarModel(body);
    const previous = materialization.allowed;
    materialization.allowed = true;
    try {
      model.quality = 5;
    } finally {
      materialization.allowed = previous;
    }
    expect(body.quality).toBe(5);
  });

  test("test_scalar_reverse_does_not_touch_other_fields", () => {
    const body = new _FakeBody({ quality: 0, other: 99 });
    new _FakeParent(body);
    const model = new _ScalarModel(body);
    const previous = materialization.allowed;
    materialization.allowed = true;
    try {
      model.quality = 10;
    } finally {
      materialization.allowed = previous;
    }
    expect(body.other).toBe(99);
  });
});

describe("TestChunkFieldDirectWrite", () => {
  test("test_direct_write_without_reverse", () => {
    const body = new _FakeBody({ name: "old" });
    new _FakeParent(body);
    const model = new _DirectModel(body);
    const previous = materialization.allowed;
    materialization.allowed = true;
    try {
      model.name = "new";
    } finally {
      materialization.allowed = previous;
    }
    expect(body.name).toBe("new");
  });
});

// ---------------------------------------------------------------------------
// ChunkField contract
// ---------------------------------------------------------------------------

/** Model with a read-only ChunkField. */
class _ReadOnlyModel {
  declare _body: _FakeBody | null;
  declare width: number;

  constructor(body: _FakeBody | null) {
    this._body = body;
  }
}
descriptor(_ReadOnlyModel, "width", new ChunkField<number>("_body", "width", { readOnly: true }));

/** Model with a ChunkField that has a default. */
class _DefaultModel {
  declare _body: _FakeBody | null;
  declare tag: string;

  constructor(body: _FakeBody | null) {
    this._body = body;
  }
}
descriptor(_DefaultModel, "tag", new ChunkField<string>("_body", "tag", { default: "none" }));

/** Model with a validated ChunkField. */
class _ValidateModel {
  declare _body: _FakeBody | null;
  declare count: number;

  static _check_positive(value: number, _obj: object): void {
    if (value < 0) {
      throw new ValueError("must be positive");
    }
  }

  constructor(body: _FakeBody | null) {
    this._body = body;
  }
}
descriptor(
  _ValidateModel,
  "count",
  new ChunkField<number>("_body", "count", { validate: _ValidateModel._check_positive }),
);

/** Model with a post_set callback. */
class _PostSetModel {
  declare _body: _FakeBody | null;
  declare post_called: boolean;
  declare mode: number;

  constructor(body: _FakeBody | null) {
    this._body = body;
    this.post_called = false;
  }

  _on_mode_change(): void {
    this.post_called = true;
  }
}
descriptor(_PostSetModel, "mode", new ChunkField<number>("_body", "mode", { postSet: "_on_mode_change" }));

/** Model with synthetic body that tracks materialization. */
class _SyntheticModel {
  declare _body: _FakeBody | null;
  declare materialized: boolean;
  declare value: number;

  constructor(body: _FakeBody | null) {
    this._body = body;
    this.materialized = false;
  }

  _ensureMaterialized(): void {
    this.materialized = true;
    assert(this._body != null);
    this._body.synthetic = false;
  }
}
descriptor(_SyntheticModel, "value", new ChunkField<number>("_body", "value"));

const _MyEnum = defineEnum(
  "_MyEnum",
  { OFF: 0, ON: 1, AUTO: 2 },
  {
    // NOTE(port): _enum_class/getattr(enum, "fromBinary") binds the classmethod to the enum (covered by TestChunkFieldEnum below).
    from_binary(value: number) {
      return this.of(value);
    },
  },
);
type _MyEnum = EnumValue<typeof _MyEnum>;

/** Model with an enum ChunkField. */
class _EnumModel {
  declare _body: _FakeBody | null;
  declare mode: number;

  constructor(body: _FakeBody | null) {
    this._body = body;
  }
}
descriptor(_EnumModel, "mode", ChunkField.enum(_MyEnum, "_body", "mode"));

/** Model whose enum field tolerates out-of-enum stored values. */
class _ForgivingEnumModel {
  declare _body: _FakeBody | null;
  declare mode: number;

  constructor(body: _FakeBody | null) {
    this._body = body;
  }
}
descriptor(_ForgivingEnumModel, "mode", ChunkField.enum(_MyEnum, "_body", "mode", { allowOutOfEnumValues: true }));

/** Model with a ChunkField.bool field. */
class _BoolModel {
  declare _body: _FakeBody | null;
  declare flag: boolean;

  constructor(body: _FakeBody | null) {
    this._body = body;
  }
}
descriptor(_BoolModel, "flag", ChunkField.bool("_body", "flag"));

describe("TestChunkFieldDictOverride", () => {
  /** Parse-time __dict__ overrides take priority over chunk body. */

  test("test_dict_override_beats_body", () => {
    const body = new _FakeBody({ width: 100 });
    const model = new _ReadOnlyModel(body);
    instanceDict(model).set("width", 999);
    expect(model.width).toBe(999);
  });

  test("test_set_clears_dict_override", () => {
    const body = new _FakeBody({ name: "from_body" });
    new _FakeParent(body);
    const model = new _DirectModel(body);
    instanceDict(model).set("name", "override");
    expect(model.name).toBe("override");
    const previous = materialization.allowed;
    materialization.allowed = true;
    try {
      model.name = "written";
    } finally {
      materialization.allowed = previous;
    }
    expect(instanceDict(model).has("name")).toBe(false);
    expect(model.name).toBe("written");
  });
});

describe("TestChunkFieldDefault", () => {
  test("test_default_when_body_is_none", () => {
    const model = new _DefaultModel(null);
    expect(model.tag).toBe("none");
  });

  test("test_no_default_raises_attribute_error", () => {
    const model = new _DirectModel(null);
    raises(AttributeError, () => model.name, "is null");
  });

  test("test_write_to_none_body_stores_in_dict", () => {
    const model = new _DirectModel(null);
    const previous = materialization.allowed;
    materialization.allowed = true;
    try {
      model.name = "stored";
    } finally {
      materialization.allowed = previous;
    }
    expect(model.name).toBe("stored");
    expect(instanceDict(model).get("name")).toBe("stored");
  });
});

describe("TestChunkFieldReadOnly", () => {
  test("test_read_only_rejects_writes", () => {
    const body = new _FakeBody({ width: 100 });
    const model = new _ReadOnlyModel(body);
    raises(
      AttributeError,
      () => {
        model.width = 200;
      },
      "read-only",
    );
  });

  test("test_read_only_reads_normally", () => {
    const body = new _FakeBody({ width: 42 });
    const model = new _ReadOnlyModel(body);
    expect(model.width).toBe(42);
  });
});

describe("TestChunkFieldSuppressMaterialization", () => {
  test("test_write_blocked_during_suppress", () => {
    const body = new _FakeBody({ name: "old" });
    new _FakeParent(body);
    const model = new _DirectModel(body);
    runSuppressed(() => {
      raises(
        RuntimeError,
        () => {
          model.name = "new";
        },
        "during parsing",
      );
    });
    expect(body.name).toBe("old");
  });
});

describe("TestChunkFieldSyntheticMaterialization", () => {
  test("test_synthetic_body_triggers_ensure_materialized", () => {
    const body = new _FakeBody({ synthetic: true, value: 0 });
    new _FakeParent(body);
    const model = new _SyntheticModel(body);
    const previous = materialization.allowed;
    materialization.allowed = true;
    try {
      model.value = 42;
    } finally {
      materialization.allowed = previous;
    }
    expect(model.materialized).toBe(true);
    expect(body.synthetic).toBe(false);
    expect(body.value).toBe(42);
  });

  test("test_non_synthetic_body_skips_materialization", () => {
    const body = new _FakeBody({ synthetic: false, value: 0 });
    new _FakeParent(body);
    const model = new _SyntheticModel(body);
    const previous = materialization.allowed;
    materialization.allowed = true;
    try {
      model.value = 7;
    } finally {
      materialization.allowed = previous;
    }
    expect(model.materialized).toBe(false);
    expect(body.value).toBe(7);
  });
});

describe("TestChunkFieldPostSet", () => {
  test("test_post_set_fires_after_write", () => {
    const body = new _FakeBody({ mode: 0 });
    new _FakeParent(body);
    const model = new _PostSetModel(body);
    const previous = materialization.allowed;
    materialization.allowed = true;
    try {
      model.mode = 3;
    } finally {
      materialization.allowed = previous;
    }
    expect(model.post_called).toBe(true);
    expect(body.mode).toBe(3);
  });
});

describe("TestChunkFieldValidation", () => {
  test("test_validate_rejects_invalid_value", () => {
    const body = new _FakeBody({ count: 0 });
    new _FakeParent(body);
    const model = new _ValidateModel(body);
    const previous = materialization.allowed;
    materialization.allowed = true;
    try {
      raises(
        ValueError,
        () => {
          model.count = -1;
        },
        "must be positive",
      );
    } finally {
      materialization.allowed = previous;
    }
  });

  test("test_validate_accepts_valid_value", () => {
    const body = new _FakeBody({ count: 0 });
    new _FakeParent(body);
    const model = new _ValidateModel(body);
    const previous = materialization.allowed;
    materialization.allowed = true;
    try {
      model.count = 5;
    } finally {
      materialization.allowed = previous;
    }
    expect(body.count).toBe(5);
  });
});

describe("TestChunkFieldEnumValidation", () => {
  test("test_invalid_int_rejected", () => {
    const body = new _FakeBody({ mode: 0 });
    new _FakeParent(body);
    const model = new _EnumModel(body);
    const previous = materialization.allowed;
    materialization.allowed = true;
    try {
      raises(
        ValueError,
        () => {
          model.mode = 99;
        },
        "Invalid value 99",
      );
    } finally {
      materialization.allowed = previous;
    }
  });

  test("test_valid_enum_member_accepted", () => {
    const body = new _FakeBody({ mode: 0 });
    new _FakeParent(body);
    const model = new _EnumModel(body);
    const previous = materialization.allowed;
    materialization.allowed = true;
    try {
      model.mode = _MyEnum.ON;
    } finally {
      materialization.allowed = previous;
    }
    expect(body.mode).toBe(1);
  });

  test("test_valid_int_accepted", () => {
    const body = new _FakeBody({ mode: 0 });
    new _FakeParent(body);
    const model = new _EnumModel(body);
    const previous = materialization.allowed;
    materialization.allowed = true;
    try {
      model.mode = 2;
    } finally {
      materialization.allowed = previous;
    }
    expect(body.mode).toBe(2);
  });
});

describe("TestChunkFieldEnumAllowOutOfEnumValues", () => {
  /** Forgiving read (the binary is trusted), strict write. */

  test("test_out_of_enum_stored_value_reads_back_raw", () => {
    const body = new _FakeBody({ mode: 99 });
    const model = new _ForgivingEnumModel(body);
    expect(model.mode).toBe(99);
    expect(_MyEnum.has(model.mode)).toBe(false);
  });

  test("test_in_enum_stored_value_still_reads_as_member", () => {
    const body = new _FakeBody({ mode: 2 });
    const model = new _ForgivingEnumModel(body);
    expect(model.mode).toBe(_MyEnum.AUTO);
  });

  test("test_write_still_rejects_out_of_enum", () => {
    // The wrapped transform hides the enum class from `_enum_class`,
    // so strictness has to come from the auto-added validate_enum.
    const body = new _FakeBody({ mode: 0 });
    new _FakeParent(body);
    const model = new _ForgivingEnumModel(body);
    const previous = materialization.allowed;
    materialization.allowed = true;
    try {
      raises(ValueError, () => {
        model.mode = 99;
      });
    } finally {
      materialization.allowed = previous;
    }
    expect(body.mode).toBe(0);
  });

  test("test_write_accepts_member", () => {
    const body = new _FakeBody({ mode: 0 });
    new _FakeParent(body);
    const model = new _ForgivingEnumModel(body);
    const previous = materialization.allowed;
    materialization.allowed = true;
    try {
      model.mode = _MyEnum.AUTO;
    } finally {
      materialization.allowed = previous;
    }
    expect(body.mode).toBe(2);
  });

  test("test_caller_validate_is_not_overridden", () => {
    const calls: unknown[] = [];

    function _record(value: unknown, _obj: unknown): void {
      calls.push(value);
    }

    const cf = ChunkField.enum(_MyEnum, "_body", "mode", {
      allowOutOfEnumValues: true,
      validate: _record,
    });
    expect(cf.validate).toBe(_record);
  });

  test("test_read_only_gets_no_validate", () => {
    const cf = ChunkField.enum(_MyEnum, "_body", "mode", {
      allowOutOfEnumValues: true,
      readOnly: true,
    });
    expect(cf.validate).toBe(null);
  });
});

describe("TestChunkFieldBool", () => {
  /** `ChunkField.bool` bakes in `validate_bool`. */

  test.each([["no"], [2], [1], [0], [null], [[]], [boxFloat(1)]])("test_rejects_non_bool[%#]", (bad) => {
    const body = new _FakeBody({ flag: false });
    new _FakeParent(body);
    const model = new _BoolModel(body);
    const previous = materialization.allowed;
    materialization.allowed = true;
    try {
      raises(
        TypeError,
        () => {
          // @ts-expect-error deliberately assigns a non-bool to check runtime validation
          model.flag = bad;
        },
        "expected a bool",
      );
    } finally {
      materialization.allowed = previous;
    }
    expect(body.flag).toBe(false);
  });

  test.each([[true], [false]])("test_accepts_bool[%#]", (value) => {
    const body = new _FakeBody({ flag: !value });
    new _FakeParent(body);
    const model = new _BoolModel(body);
    const previous = materialization.allowed;
    materialization.allowed = true;
    try {
      model.flag = value;
    } finally {
      materialization.allowed = previous;
    }
    expect(body.flag).toBe(value);
  });

  test("test_caller_validate_is_not_overridden", () => {
    function _custom(_value: unknown, _obj: unknown): void {}

    const cf = ChunkField.bool("_body", "flag", { validate: _custom });
    expect(cf.validate).toBe(_custom);
  });
});

describe("TestChunkFieldTransform", () => {
  test("test_transform_applied_on_get", () => {
    const body = new _FakeBody({ quality: 1 });
    const model = new _ScalarModel(body);
    // _ScalarModel has reverse=int but no transform,
    // so we test with a model that does have transform.
    const cf = new ChunkField<boolean>("_body", "flag", { transform: truthy, reverse: int });
    cf.attach(model.constructor, "flag");
    model._body = new _FakeBody({ flag: 0 });
    expect(cf.get(model, model.constructor)).toBe(false);
    model._body = new _FakeBody({ flag: 1 });
    expect(cf.get(model, model.constructor)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CosField contract tests
// ---------------------------------------------------------------------------

/** Model using CosField with scalar reverse. */
class _CosModel {
  declare _style: CosDict | null;
  declare fontSize: number | null;
  declare _propagateCalled: boolean;

  constructor(style: CosDict | null) {
    this._style = style;
    this._propagateCalled = false;
  }

  _propagateCos(): void {
    this._propagateCalled = true;
  }
}
descriptor(
  _CosModel,
  "fontSize",
  new CosField<number | null, "_style", _CosModel>("_style", "1", {
    transform: cosFloat,
    reverse: float,
    accepts: (v: unknown): v is number => typeof v === "number",
    default: null,
  }),
);

describe("TestCosFieldScalarReverse", () => {
  test("test_scalar_reverse_writes_to_dict", () => {
    const style = new Map<string, CosNode>([["1", 12]]);
    const model = new _CosModel(style);
    model.fontSize = 24.0;
    expect(getOrThrow(style, "1")).toBe(24.0);
  });

  test("test_propagate_cos_called", () => {
    const style = new Map<string, CosNode>([["1", 12]]);
    const model = new _CosModel(style);
    model.fontSize = 18.0;
    expect(model._propagateCalled).toBe(true);
  });

  test("test_none_value_removes_key", () => {
    const style = new Map<string, CosNode>([["1", 12]]);
    const model = new _CosModel(style);
    model.fontSize = null;
    expect(style.has("1")).toBe(false);
  });
});
