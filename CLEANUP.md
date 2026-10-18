# Cleanup guide: from 1:1 port to TypeScript

The port (see `RULEBOOK.md`) is done: every test passes, every sample saves
byte-identical, and the differential harness matches py-aep on every sample and
edit. This guide turns the transliterated code into ordinary TypeScript without
changing behavior, one pass at a time.

Each pass is a mechanical rewrite with a fixed scope. It is only "done" when
`tools/gate.sh` passes: `tsc` clean, `bun test` at or above the counts in
`tools/gate_baseline.json` with 0 failures, all 644 samples byte-identical, and
the py-aep differential (parse attributes, 25,427 edits, saved bytes)
identical. No test is skipped, deleted, or loosened to get there.

The trap to watch for: code that looks the same in both forms but behaves
differently. Every rule below names the condition under which the rewrite is
exact. If you cannot show the condition holds from the code in front of you,
leave the call alone. `tsconfig` is not strict, so a declared type does not
prove a value is non-null; read the code that produces it.

If a rewrite needs a paragraph-long comment to justify it, don't make it.

## Fixed during every pass

- The public surface: names, signatures, and return types of everything
  `src/py_aep/index.ts` exports and every public (non-`_`) member of a model
  class. The tests and the differential harness exercise this surface.
- Exception classes and message text (tests match them).
- Float operation order and every byte-producing path (`struct`, `codecs`,
  `json_dumps`, `float_repr`, `format`).
- `src/pyrt/` itself and `tests/` (unless the pass says otherwise).

## Pass 1: native idioms in function bodies

Replace pyrt helpers with plain TS where the operand types make it exact. No
renames, no signature changes, no structural changes.

Applied by a one-off codemod (since removed), which asked the type
checker for each operand and only rewrites when a rule below holds; calls on
`any`, on maps whose values may be null, or on `__len__`/`__eq__` objects stay.
Hand edits on top of it go
through the same rules.

### Truthiness: `py_bool`, `py_or`, `py_and`

`py_bool(x)` is Python truth: `None`, `0`, `NaN`-is-true, empty
string/array/bytes/Map/Set, `__bool__`, `__len__`. Rewrite by the type `x`
provably has:

| `x` is | `py_bool(x)` becomes |
|---|---|
| `boolean` | `x` |
| `boolean \| null` | `!!x` |
| `number` (never null) | `x !== 0` (not `!!x`: `NaN` is truthy in Python) |
| `string` or `string \| null` (a primitive, see below) | `!!x` |
| array, `Uint8Array` | `x.length > 0` (nullable: `x != null && x.length > 0`) |
| `Map` / `Set` | `x.size > 0` (nullable likewise) |
| class instance with no `__len__` / `__bool__`, or null | `x != null` |

Keep `py_bool` when `x` is or may be:

- a `PropertyGroup` or any subclass (`Layer`, `AVLayer`, `MaskPropertyGroup`,
  …), a `ListChunk`, `Settings`, `EssentialGraphics`-style containers, or
  anything else defining `__len__` / `__bool__`: their truth is "non-empty".
- a `String` object: `_NulTailStr` (fixed-size chunk string fields) and
  `CosString` (COS data) are `String` objects and always truthy to `!!`.
  Values read from chunk string fields or COS trees can be these.
- a `PyFloat` or anything from a COS tree (`cos_get`, `_doc`, `_char_style`,
  parsed JSON) unless the code has already unboxed it.
- `any` whose possible values you cannot enumerate.

`py_or(a, b)` is `py_bool(a) ? a : b` and `py_and(a, b)` is
`py_bool(a) ? b : a`. Write them as that conditional with the native test from
the table, or as `a || b` only when `a` is a primitive string, a boolean, or a
nullable object without `__len__`/`__bool__`. A number `a` uses
`a !== 0 ? a : b`. An array `a`: `a != null && a.length > 0 ? a : b`. `b` is
evaluated eagerly in the call form and lazily in the rewrite; that is fine
unless `b` has side effects that later code depends on.

### Maps: `dict_get`, `getitem`, `setdefault`, `dict_pop`

- `dict_get(m, k)` / `dict_get(m, k, null)` → `m.get(k) ?? null`. Exact
  whenever `m` is a `Map` (a stored `undefined` is never distinguished from
  `null`; None checks use `== null`).
- `dict_get(m, k, d)` with a non-null `d` → `m.get(k) ?? d` only when no value
  stored in `m` can be `null`/`undefined` (a constant table of non-null
  literals, or a map whose every `set` you can see stores a non-null value).
  Otherwise `m.has(k) ? m.get(k) : d`.
- Only when `m` is certainly a `Map`. `dict_get` on an `any` from a COS tree is
  a Map in practice, but if a non-Map can reach it, keep the call.
- `getitem(m, k)` raises `KeyError`. Rewrite to `m.get(k)` only where the key
  is provably present (an `m.has(k)` guard or early exit, or `k` came from
  iterating `m`) and nothing between the proof and the read can remove it: no
  `delete`/`clear`/`dict_pop`, no reassignment of `m` or `k`, and no call other
  than `get`/`has` (any call might delete through an alias). Otherwise keep it.
- `getattr(x, "p", null)` → `x?.p ?? null` (`x.p` when `x` is non-null) when
  `p` is declared on `x`'s type. Never when `x` can be a class with
  `__getattr__` (`PropertyGroup`, layers, …): `getattr` checks `p in x` first,
  so an unset `declare` field yields the default, while a plain read falls
  through to the proxy and throws.
- `setdefault` / `dict_pop`: keep (they are already one call; the native form
  is longer).

### Equality and membership: `py_eq`, `contains`, `len`

- `py_eq(a, b)` → `a === b` when both sides are primitive `number`, `string`,
  `boolean`, or `null` (compare with `null` via `== null` / `!= null`). Keep it
  when either side can be a `PyFloat`, `bigint`, `String` object, array, bytes,
  `Map`, `Set`, or a class with `__eq__` (chunks, gradients, COS values, items,
  layers, `Settings`, synthesis specs, …). A `boolean` vs `number` comparison
  is `py_eq` too (Python `True == 1`).
- `contains(c, x)` → `c.includes(x)` for a primitive string `c` (substring) or
  an array of primitives; `c.has(x)` for a `Set` or `Map`. Keep it for arrays
  that may hold objects with `__eq__`, arrays of arrays, or `__contains__`
  objects.
- `len(x)` → `x.length` (string, array, `Uint8Array`) or `x.size` (`Map`,
  `Set`) when the type is certain. Keep for `__len__` objects or `any`.
  Note: a string's `.length` counts UTF-16 units and so does `len` here.

### Iteration: `range`, `enumerate`, `zip`

- `for (const i of range(n))` → `for (let i = 0; i < n; i++)`;
  `range(a, b)` / `range(a, b, step)` likewise, keeping the bounds expressions
  evaluated once (hoist into a `const` if they have side effects or are
  expensive). `for (const _ of range(n))` → `for (let i = 0; i < n; i++)`.
- `Array.from(range(n), f)` → `Array.from({ length: n }, (_, i) => f(i))` (for
  `n` ≥ 0; a negative `n` gives an empty list in both).
- `[...range(n)]` → `Array.from({ length: n }, (_, i) => i)`.
- `enumerate(xs)` over an array → `xs.entries()`; with a start offset, keep.
- `zip(a, b)` → index loop over `Math.min(a.length, b.length)` only where it
  reads more clearly; otherwise keep.

### Indexing and slicing

- `at(xs, i)` → `xs[i]` when `0 <= i < xs.length` is guaranteed by the
  surrounding code; `xs.at(-1)!` when non-empty is guaranteed. Otherwise keep
  (it raises `IndexError`).
- `py_slice(xs, a, b)` with literal non-negative bounds (or omitted ones) →
  `xs.slice(a, b)`. Keep for negative or computed bounds and any step.

### Keep (these carry Python numerics or formatting the tests depend on)

`round`, `floordiv`, `mod`, `divmod`, `truediv`, `int`, `float`, `sum`,
`fsum`, `hypot`, `sorted`, `min`, `max`, `py_cmp`, `repr`, `str`,
`float_repr`, `num_str`, `format`, `split`, `strip`/`lstrip`/`rstrip`,
`isdigit` & co., `decode`/`encode`, `struct`, `bytes_` helpers, `tkey`,
`deepcopy`/`copy`, `lru_cache`, `warn`, `py_assert`.

One exception: `int(x)` where `x` is a primitive `number` that is provably
finite (not `NaN` / `±Infinity`) may become `Math.trunc(x)`. If finiteness
is not provable from the code, keep `int`.

### Comments

- Delete a `NOTE(port)` comment when the code it explained no longer exists
  or no longer needs explaining after the rewrite. Keep `NOTE(port)` comments
  that still explain a non-obvious behavior.
- Keep `TODO(port)` markers.
- Don't add comments explaining the rewrite.

### Imports

Drop pyrt names that are no longer used in the file. Keep import order
otherwise.

A lazy cycle breaker becomes a static import when the target
module cannot reach the importing one through value imports (type-only
imports are erased and don't count), counting static imports already added
during the same run. The target then fully evaluates before the importer, and
it cannot observe a half-initialized module: every module still evaluating
reaches the importer, so the target reaching one would mean it reaches the
importer. The rest go through `late` (`src/py_aep/models/late.ts`).

## Pass 2: docstrings to TSDoc

A one-off codemod (since removed) rewrote comments only (`tools/tsdoc_lint.ts`
must report 0 messages; code printed without comments is identical before and
after):

- Google-style sections: `Args:` → `@param name - …` (names read from the TS
  signature, so renames like `default_` match); keyword-only args → one
  `@param kw - Keyword arguments:` with a bullet per option (TSDoc names cannot
  be dotted); `Returns:` / `Yields:` → `@returns`; `Raises:` →
  `@throws {@link Error} …`; `Example(s):` → `@example`; `See:` → `@see`;
  `Note:` / `Warning:` → bold-led paragraphs in the description.
- mkdocs cross-references: `[Name][]` → `{@link Name}`, `[text][Name]` →
  `{@link Name | text}`; RST ``` ``x`` ``` → `` `x` ``.
- Hygiene on every doc comment: `@param x - …` hyphen, `<`, `>`, `{`, `}` and
  non-tag `@` escaped outside code, code spans never wrapped across lines.

The prose still speaks Python (`None`, `True`, Python examples, `py_aep.x`
paths); pass 3 rewrites it in TypeScript terms.

## Pass 3: TSDoc to TypeScript

Types and docs only. `bun tools/js_equal.ts <base>` must show that the
JavaScript TypeScript emits for every touched file is unchanged.

- A one-off codemod (since removed): `` `None` `` / `` `True` `` / `` `False` `` →
  `` `null` `` / `` `true` `` / `` `false` ``; `{@link py_aep.models.x.Name}` → `{@link Name}`.
- Per file, from the Python annotations of the same symbol: `any` → real types
  (port classes, enums, `Map<…>`, `unknown` where nothing reads the value).
  `any` stays only where the value is genuinely dynamic: parsed COS/JSON data,
  property values whose type depends on the property kind, Python duck typing,
  and overload-compatibility signatures.
- Every Python example is a TypeScript example importing from
  `@bevyl-ai/ts-aep`; `tools/doc_examples.ts` typechecks them all (in the gate).

## Pass 4: bottom-up types

Types only (`bun tools/js_equal.ts <base>` = 0). Layers are typed in
dependency order so precise types flow upward instead of being cast in:
pyrt → binary/enums/data → cos/color → parsers/synthesis → models →
resolvers/svg → cli. `bun tools/strict_report.ts` prints strict-mode errors
and `any` / `unknown` / `as`-cast counts per layer; `tools/strict_file.ts`
checks single files.

- `src/` is strict (`tsconfig.src.json`, run by `bun run typecheck` and the
  gate). Tests are not yet.
- Shared APIs carry the types: generated `ChunkTypes` (`tools/gen_chunk_types.ts`)
  so `find_by_type(chunks, "ldta")` returns `LdtaChunk`; discriminated
  keyframe payloads; `ChunkField<T>` / `descriptor()` tied to the declared
  field type; `MatchNameTypes` so `group.property("ADBE Position")` returns
  `Property<number[]>`; typed `struct.unpack` for literal formats.
- Untyped dependencies get accurate ambient declarations in `src/types/`
  (fontkit 2.0.4, harfbuzzjs), shipped with the package types.
- Rule: fix a type at its declaration; a cast is the last resort; `unknown`
  only for opaque values; `any` only behind a named alias for genuinely
  dynamic data (parsed COS/JSON trees, ExtendScript-style duck typing).
- The text-document COS tree (`btdk`) has earned types, with no cast:
  - The parser builds `CosNode` values (`cos/cos.ts`). `decode_btdk`
    (`cos/schema.ts`) is the one entry point from untyped data; it runs the
    recursive zod schema `cos_node` over the blob and yields a `CosDict`.
    Nothing deeper is checked there: py-aep never validates COS, so a value
    of the wrong kind must fail where Python fails, or not at all.
  - Every `isinstance` check py-aep makes is a zod kind run as a type guard
    (`is(py_int, x)`, `read(char_style, d, "0")`, `cos/kinds.ts`). Every
    other access goes through an operation that raises what the Python
    builtin raises on the wrong kind: `cos_float` / `cos_int` (TypeError),
    `cos_dict(x, "get")` / `cos_setdefault` / `cos_pop` (AttributeError),
    `cos_item` / `cos_setitem` (TypeError, KeyError), `py_add` (int + float
    is a boxed float). A stored `null` is not a missing key: use
    `cos_get_or(d, k, default)`, never `d.get(k) ?? default`.
  - Writes mutate the same `Map`s the serializer emits, so key order, extra
    keys, int vs `PyFloat` and `CosString` survive.
  - `bun tools/type_ratchet.ts` (in the gate) keeps `cos/`, `models/text/`
    and `resolvers/text_*.ts` at zero `as` casts, `!` assertions and `any`.
  - `tools/diff/fault_run.sh` (in the gate) corrupts the btdk tree of every
    sample with text and checks that py-aep and the port read, write and
    save each corrupted project identically, exception classes included.
- The gate ratchets the per-layer `any` / `unknown` / cast counts against
  `loose_types` in `tools/gate_baseline.json`: they may only fall, and a pass
  that lowers them lowers the baseline.

## Later passes

Each of these changes structure and needs its own guide section first:

- attrs `define(...)` / `field(...)` and `descriptor(Cls, name, ...)` →
  class fields and accessors (decorators or explicit getters/setters).
- `int_enum` / `py_enum` → TS `enum` or `as const` objects (touches public
  API through `E.of`, `E.name_of`).
- Done: the lazy registry is gone; real cycles go through `late`.
- `__getattr__` / `py_object` proxies, `__eq__`/`__len__` dunders → explicit
  methods.
- snake_case internals → camelCase (public names stay until an API decision).
- `Port of py_aep/...` headers and the `RULEBOOK.md` sync rules: retire once
  upstream syncs stop being file-by-file.
