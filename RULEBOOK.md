# py_aep → TypeScript port rulebook

Goal: **py-aep's behaviour in idiomatic TypeScript.** Behaviour must match CPython 3.12 py-aep
exactly: byte-identical saves, the same values, the same errors (the py-aep differential in CI is
the gate). The code and the API are TypeScript, not Python:

- Public members are camelCase and use ExtendScript's names (`comp.frameRate`,
  `layer.transform.anchorPoint`, `layer.threeDLayer`). Binary chunk fields stay snake_case: they
  are the file schema, not API.
- JS protocols instead of Python dunders: `group.property(key)`, Map-shaped views
  (`get`/`set`/`delete`/`has`/`size`), `length` getters, `equals(other)`, `toString()`, and
  `[INSPECT]()` (Node's `util.inspect.custom`) for the readable form `repr()` and `console.log`
  print.
- Files keep their py-aep twins' paths so `tools/sync_upstream.py` can still map an upstream
  change to the TS file it touches; port each upstream change by hand.

Python source: `../repo/src/py_aep/**`, `../repo/tests/**`. TS root: this directory.
Runtime shims for Python semantics live in `src/pyrt/` — **read `src/pyrt/*.ts` before
translating** and use them; do not reimplement anything they provide. Never edit `src/pyrt/`
(report a missing shim in your final answer instead and write a local helper marked
`// TODO(pyrt): <what>`).

## 1. Files and imports

| Python | TypeScript |
|---|---|
| `src/py_aep/a/b.py` | `src/py_aep/a/b.ts` |
| `src/py_aep/a/__init__.py` | `src/py_aep/a/index.ts` |
| `tests/x/test_y.py` | `tests/x/test_y.test.ts` |
| `tests/conftest.py`, `tests/helpers.py` | `tests/conftest.ts`, `tests/helpers.ts` |

- Relative ESM imports **with the `.ts` extension**: `from .chunk import Chunk` →
  `import { Chunk } from "./chunk.ts";` `from ..enums import X` → `"../enums/index.ts"`.
  `import py_aep` (tests) → `import * as py_aep from "../../src/py_aep/index.ts";`.
- Import names exactly as Python does. Assume every imported name exists in the target TS module
  under the identical name (other agents translate those files in parallel to the same rules).
- Deferred imports inside functions (`from .x import Y` indented inside a def — Python's cycle
  breaker) → **not** a top-level import: declare at module level
  `const _x = deferred<typeof import("./x.ts")>("py_aep/a/x");` (pyrt; the key is the target's
  path relative to `src`, without `.ts`) and use `_x().Y` at the original use sites; add
  `import type { Y } from "./x.ts";` if `Y` is also used as a type. Then run
  `bun tools/gen_deferred_modules.ts`, which regenerates the hub `src/py_aep/_modules.ts` that
  statically imports and registers every deferred target (`py_aep/index.ts` imports it last;
  `--check` fails on a stale hub or a wrong key). A top-level import would let a subclass module
  (`class M extends Base`) evaluate before `Base` exists (TDZ). `if TYPE_CHECKING:` imports →
  `import type`. Python's end-of-module
  "import for registration side effects" lines in `binary/chunk.py` become the separate module
  `src/py_aep/binary/_register.ts`, which imports `./chunk.ts` and every `*_chunks.ts`, and any
  module whose code needs all chunk types registered (`models/project.ts`, `py_aep/index.ts`,
  tests) imports `"…/binary/_register.ts"`. Inside `binary/chunk.ts`, replace
  `isinstance(x, Lhd3Chunk)` / `PrinChunk` / `Utf8Chunk` deferred imports with a registry lookup
  (`x instanceof CHUNK_TYPES.get("lhd3")!`, `new (CHUNK_TYPES.get("Utf8")!)({...})`).
- `__all__` / re-exports in `__init__.py` → `export { ... } from "./mod.ts"` in `index.ts`.
- `from typing import ...`, `TYPE_CHECKING` blocks, `from __future__ ...` → drop (use
  `import type` for names only used in annotations).
- Third-party: `attrs` → `pyrt/attrs.ts`; `fontTools` → `fontkit` (+ hand logic),
  `uharfbuzz` → `harfbuzzjs`, `yaml` → `yaml` (npm). Where parity with the Python library is not
  certain, translate faithfully anyway and add `// TODO(port): <specific parity risk>`.
- Stdlib: `struct` → `pyrt struct` (`pack_into` included); `io.BytesIO` / `io.StringIO` →
  `pyrt BytesIO` / `StringIO`; `open(path, "rb")` → `pyrt open_rb`; `pathlib.Path` →
  `pyrt Path` (`p / "x"` → `p.div("x")`, `Path.home()`); `PurePosixPath` / `PureWindowsPath` →
  pyrt's (same `div`). **`src/` never touches the host directly**: no
  `node:` imports, no `Buffer`, no `require`/`createRequire`, and no `process` outside the
  `cli/` entry points (argv, exit codes, stdio). Everything
  host-specific goes through `pyrt/host.ts` (`import * as host from ".../pyrt/host.ts"`):
  files → `host.fs` (the sync `node:fs` subset: `readFileSync`, `writeFileSync`, `statSync`,
  `openSync`/`readSync`/`writeSync`/`closeSync`, `readdirSync`, …; Node/Bun's own `node:fs`, or
  the in-memory fs in browsers/Workers); `os.path` → `host.path`; `os.environ` → `host.env`;
  `sys.platform` → `host.platform` (`"darwin"|"win32"|"linux"`, `"browser"` without a host);
  `tempfile` dirs → `host.tmpdir()`. `math.*` → `Math.*`
  except helpers in `pyrt/num.ts` (`isclose`, `copysign`, `fsum`, `radians`, `degrees`) and
  `math.hypot` → pyrt `hypot` (CPython's rounding);
  `zlib` → `pyrt/zlib.ts` over fflate (`zlib.decompress`, `zlib.decompressobj().decompress(x,
  max_length)`, `zlib.error`, `gzip_decompress`); `hashlib.md5(x).digest()` → `md5(x)`
  (`pyrt/md5.ts`); `base64.b64encode/b64decode` → `pyrt/base64.ts` (CPython's non-strict
  decode, `binascii.Error`); `uuid.uuid4()` / `.bytes` → `uuid4()` / `uuid4_bytes()`
  (`pyrt/uuid.ts`); a latin-1 string view of bytes → `bytes_.latin1_str` / `latin1_bytes`;
  fonts → `fontkit.create(host.fs.readFileSync(p))` (never `fontkit.openSync`);
  `json.loads` / `json.dumps` → pyrt `json_loads` / `json_dumps` (dicts are Maps, floats
  `PyFloat`, big ints `bigint`; see §7); `re` → pyrt `py_re(pattern, flags)` (Python syntax and
  Unicode `\d`/`\w`/`\s`), `re_search` / `re_match` / `re_fullmatch` / `re_escape`, and
  `pattern_match` / `pattern_search` / `pattern_findall` for a compiled pattern's methods;
  `warnings.warn` → `pyrt warn`; `logging.getLogger(__name__)` → a module const
  `const logger = { debug() {}, info() {}, warning: (m: string) => warn(m) }` (keep call sites);
  `functools.lru_cache` → `pyrt lru_cache`; `copy.deepcopy`/`copy.copy` → `pyrt deepcopy`/`copy`;
  `contextvars.ContextVar` → `pyrt ContextVar`; `fractions.Fraction` → `pyrt Fraction`;
  `itertools` → small inline loops; `unicodedata` → `String.prototype.normalize` or a TODO.

## 2. Names

- **Keep every identifier verbatim**, snake_case included: modules, functions, methods,
  parameters, locals, constants, class names, attributes, private `_x` and `__x` names.
- TS reserved words as identifiers get a trailing underscore: `new` → `new_`, `default` →
  `default_`, `in` → `in_`, `function` → `function_`, `delete` → `delete_`, `class` →
  `class_`, `switch`, `case`, `var`, `let`, `const`, `enum`, `export`, `import`, `void`,
  `with`, `yield`, `this`, `super`, `typeof`, `instanceof`, `package`, `interface`, `private`,
  `public`, `static`, `debugger`, `extends`, `implements`. Exports keep the Python name where
  ESM allows: `export { new_ as new }`.
- Python builtin shadowing: a local named `len`, `str`, `min`, `max`, `range`, `type`, `bytes`,
  `format`, `round` that conflicts with an imported pyrt helper → suffix the local with `_`.

## 3. Values

| Python | TypeScript |
|---|---|
| `None` | `null` |
| `x is None` / `x is not None` | `x == null` / `x != null` (loose: also catches `undefined`) |
| `True` / `False` | `true` / `false` |
| `int`, `float` | `number` (see §4 for where they differ) |
| `str` | `string` |
| `bytes` | `Uint8Array` (treat as immutable — never write into one you did not just allocate) |
| `bytearray` | `Uint8Array` you own (mutable) |
| `list`, `tuple` | arrays (`readonly` for tuples where natural) |
| `dict` built only to be splatted as `**kwargs` (`cls(**kw)`, `f(**kw)`) | plain object `Record<string, any>` (keys are identifiers; it becomes a TS options object) |
| `dict` | `Map` — always (except the `**kwargs` case above), unless it is a fixed literal record of identifier keys only read by name (then a plain object `as const`). JS objects reorder integer-like keys and stringify numbers; Maps don't. |
| `set` / `frozenset` | `Set` (`ReadonlySet` for frozenset); tuple members → `tkey(...)` strings |
| tuple as dict key / set member | `tkey(a, b)` from pyrt (`Map<string, V>`) |
| `b"\x00ab"` literal | `b("\x00ab")` from pyrt |
| `bytes(n)` / `b"\x00" * n` | `new Uint8Array(n)` / `bytes_.repeat(b("\x00"), n)` |
| bytes ops (`+`, `==`, `.find`, `.strip`, `.startswith`, slicing, `.join`, `.hex`, `int.from_bytes`) | `pyrt bytes_.*` helpers (`concat`, `bytes_eq`, `find`, `strip`, `startswith`, `slice`, `join`, `hex`, `int_from_bytes`) |
| `x.decode(enc, errors)` / `s.encode(enc, errors)` | `decode(x, enc, errors)` / `encode(s, enc, errors)` from pyrt — **never** `TextDecoder`/`TextEncoder` (they drop BOMs and replace lone surrogates; `surrogateescape` must round-trip) |

## 4. Semantics that differ (use pyrt every time)

- **Truthiness**: `if x:` / `not x` / `x or y` / `x and y` / `bool(x)` where `x` may be a
  container (list, tuple, str, bytes, dict, set, object with `__len__`) → `py_bool(x)`,
  `!py_bool(x)`, `py_or(x, y)`, `py_and(x, y)`. Plain `if (x)` is fine only when `x` is
  certainly a number, boolean, or nullable object. An empty array / Uint8Array is truthy in JS.
- **Equality**: `==` on numbers/strings/booleans/None → `===` (`== null` for None). On lists,
  tuples, bytes, dicts, attrs instances or anything with `__eq__` → `py_eq(a, b)`. `!=` →
  `!py_eq`. `is` → `===`.
- **Membership**: `x in container` → `contains(container, x)`, or the direct `.has()` /
  `.includes()` when the container type is certain (string/array of primitives/Set/Map).
- **Arithmetic**: `a // b` → `floordiv(a, b)`; `a % b` → `mod(a, b)` (JS `%` keeps the dividend's
  sign); `divmod` → `divmod`; `round(x)` / `round(x, n)` → `round(x)` / `round(x, n)` from pyrt
  (ties to even, exact) — **never `Math.round`**; `int(x)` → `int(x)` (truncates; parses strings);
  `float(s)` → `float(s)`; `abs` → `Math.abs`; `sum(xs)` → `sum(xs)` from pyrt (CPython 3.12
  compensated summation) — never `reduce((a,b)=>a+b)`; `math.fsum` → `fsum`; `x ** y` → `x ** y`.
  `/` is true division in both.
- **Integers wider than int32**: JS `& | ^ ~ << >>` operate on int32. For values that can exceed
  2^31 (u4 fields, flags words, ids, hashes) use `and`, `or`, `and_not`, `lshift`, `rshift`
  from pyrt or append `>>> 0` to an unsigned 32-bit result. `1 << n` with n ≥ 31 →
  `lshift(1, n)`. Values that can exceed 2^53 (u64 `Q`/`q` struct fields, murmur hashes,
  64-bit arithmetic) → `bigint` throughout that code path.
- **Floats**: keep every float expression in the same operand order (no algebraic
  simplification, no `Math.hypot` unless Python uses `math.hypot`). Float32 rounding
  `struct.unpack("<f", struct.pack("<f", x))` → keep through `struct` (it raises on overflow
  like Python) — `Math.fround` only where Python cannot overflow.
- **Strings**: Python indexes code points; JS indexes UTF-16 units. `len(s)`, `s[i]`, slicing and
  `enumerate(s)` on text that may contain astral characters → `Array.from(s)` first, unless the
  Python code itself works in UTF-16 units (`text/ranges.py` does). `s.upper()`/`.lower()` →
  `toUpperCase()`/`toLowerCase()`; `.strip/.lstrip/.rstrip/.split` → pyrt `strip`, `lstrip`,
  `rstrip`, `split` (Python's argument semantics); `.isdigit()` etc. → pyrt `isdigit`, `isalpha`,
  `isspace`, `isupper`, `islower`; `s.startswith(("a","b"))` → `["a","b"].some(p => s.startsWith(p))`;
  `str * n` → `.repeat(n)`; `chr`/`ord` → `String.fromCodePoint` / `codePointAt(0)`.
- **f-strings / `%` / `str()` / `repr()`**: interpolate with template literals. A float rendered
  in output (`f"{x}"`, `str(x)`) → `float_repr(x)` / `num_str(x)`; a format spec (`f"{x:.3f}"`,
  `"%g" % x`, `format(x, ".10g")`) → `format(x, ".3f")` from pyrt; `{x!r}` / `repr(x)` →
  `repr(x)` from pyrt. Exception messages must stay character-identical (tests match them with
  regexes).
- **Ordering**: `sorted(xs, key=k, reverse=r)` → `sorted(xs, k, r)`; `min`/`max` with key or on
  tuples/strings → pyrt `min`/`max`; `<` between tuples/lists → `py_cmp(a, b) < 0`.
  `xs.sort(key=k)` → `xs.splice(0, xs.length, ...sorted(xs, k))`.
- **Indexing**: `xs[-1]` → `xs.at(-1)!` (or `at(xs, -1)` when an IndexError matters);
  `xs[a:b]` → `xs.slice(a, b)` for non-negative bounds else `py_slice(xs, a, b)`;
  `d[k]` on a Map where KeyError matters → `getitem(d, k)`; `d.get(k, default)` →
  `dict_get(d, k, default)` (returns `null`, not `undefined`, when absent).
- **Iteration**: `for i, x in enumerate(xs)` → `for (const [i, x] of xs.entries())` (or
  `enumerate(xs, start)`); `zip` → pyrt `zip`; `range` → classic `for` loops (or pyrt `range`);
  comprehensions → `map`/`filter`/loops preserving evaluation order; generators (`yield`) →
  `function*` (keep them lazy where Python is lazy). `any(...)`/`all(...)` → `.some`/`.every`.
- **Exceptions**: Python exception classes → pyrt classes (`ValueError`, `KeyError`,
  `TypeError_` for `TypeError`, `AssertionError_`, `OSError` (also `IOError`), `IndexError`,
  `AttributeError`, `NotImplementedError`, `UnicodeDecodeError`, `StructError` for
  `struct.error`, …). `except (A, B) as e:` → `catch (e) { if (!(e instanceof A || e instanceof B)) throw e; … }`.
  Custom exception classes extend the pyrt class Python's extends. `raise X from e` →
  `throw Object.assign(new X(...), { cause: e })`. `assert c, msg` → `py_assert(c, msg)`.
  Bare `except Exception:` also catches JS `Error`s.
- **`isinstance(x, int)`** → `typeof x === "number" && Number.isInteger(x)`; `float` →
  `typeof x === "number"` (an int-valued float is indistinguishable — add
  `// TODO(port): int/float distinction` where the Python branch depends on it). Exception:
  COS data carries Python floats boxed as pyrt `PyFloat` (the parser makes them; code that
  stores a Python float into a COS dict wraps it with `pyfloat(...)`), so there
  `isinstance(x, (int, float))` → `is_real(x)`, `float(x)` / `py_eq` unwrap, and getters
  hand users plain numbers (`float(x)` / `unbox(x)`);
  `str` → `typeof x === "string"`; `bytes` → `x instanceof Uint8Array`; `(list, tuple)` →
  `Array.isArray(x)`; `dict` → `x instanceof Map`; a class → `instanceof`; an enum → `E.has(x)`.
- **`hasattr` / `getattr` / `setattr`** with a literal name → direct property access
  (`"name" in obj`, `obj.name`); with a computed name or a default → pyrt `hasattr`/`getattr`
  and `obj[name] = v`.
- **More builtins**: `type(x).__name__` → `type_name(x)`; `[x] * n` → `list_mul([x], n)`;
  `dict(m)` → `dict(m)`; `m.items()` on a Mapping → `mapping_items(m)`; `obj.__dict__` →
  `instance_dict(obj)`; `a / b` that must raise `ZeroDivisionError` → `truediv(a, b)` (pass
  `"int"` for int operands); `int(s)` / `float(s)` already accept Unicode digits and `_`
  separators like CPython; `FileExistsError`, `SystemExit` are in pyrt `errors.ts`;
  `pytest.fail` / `pytest.importorskip` → pyrt `fail` / `importorskip`.
- **Default arguments** are evaluated once in Python: a mutable default (`def f(x=[])`) that the
  body mutates → hoist a module-level constant; otherwise ordinary TS defaults.

## 5. Functions and calls

- Positional-or-keyword params → positional TS params in the same order with the same
  defaults. Keyword-only params (after `*` or `*args`) → one trailing options object
  `kw: { name?: T; … } = {}` destructured at the top (`const { name = dflt } = kw;`).
  `**kwargs` → `kwargs: Record<string, any> = {}` (merged into the same trailing object when the
  function also has keyword-only params). `*args` → rest param `...args`.
- Call sites: a positional-or-keyword argument passed by keyword in Python is passed
  positionally in TS (fill skipped optional positions with `undefined`, which triggers the
  default exactly like omitting it). Keyword-only arguments go in the trailing object.
  Translate call sites to *other* modules by reading that function's Python signature.
- Python `None` passed explicitly stays `null` (does **not** trigger a TS default).
- `@staticmethod` → `static`. `@classmethod` → `static` with `this` as `cls`
  (`cls(...)` → `new this(...)`; `cls.attr` → `this.attr`). Instance code reading a class
  attribute through `self` (`self._ENCODING`) → `(this.constructor as typeof Cls)._ENCODING`.
- `@property` / `.setter` → `get` / `set` accessors. A property without a setter that Python
  code never assigns stays getter-only.
- `@overload` stubs → TS overload signatures (or drop them).
- `lambda` → arrow function.
- Nested functions and closures → nested `function`s / arrows; `nonlocal`/`global` → outer `let`.

## 6. Classes

- `class A(B):` → `class A extends B`. Multiple inheritance does not occur (if you meet it,
  stop and report).
- Class attributes (constants, tables) → `static` members. Annotated-only attributes in plain
  classes → `declare name: T;` plus constructor assignment as in `__init__`.
- `__init__` → `constructor` (call `super(...)` first). `super().method(...)` →
  `super.method(...)`.
- **attrs** (`@define`): fields are declared with `declare` (never JS initializers) and
  registered with `define(Cls, { field: spec, ... })` right after the class, before any
  decorator-equivalent calls. `attrs.field(default=…, repr=False, init=False, eq=False,
  metadata=…, converter=…)` → `field({ default, repr, init, eq, metadata, converter })`;
  `Factory(list)` → `Factory(() => [])`. The class (or a base) must extend `AttrsBase`
  (`binary/chunk.ts`'s `Chunk` and `fmt_field.ts`'s `FmtItem` do). Construction:
  `Cls(a=1, b=2)` → `new Cls({ a: 1, b: 2 })` — keyword object always, using the
  **init names** (leading underscores stripped: field `_trailing` → key `trailing`); a
  positional call maps to keys by field order. `object.__setattr__(inst, "x", v)` on an attrs
  instance → `inst.x = v`. `attrs.fields(cls)` → `fields(cls)`; `attrs.evolve` → copy + assign.
  A hand-written `__init__` on an attrs subclass → `constructor(...) { super(NO_INIT); … }`.
- `@dataclass` → class with a constructor taking the fields positionally in declaration order
  (keyword calls translated per §5), `frozen=True` → `readonly` fields; generated `__eq__` →
  an `__eq__(other)` method comparing fields with `py_eq` only if Python code or tests compare
  instances.
- `NamedTuple` → class with the named `readonly` fields, a positional constructor, and
  `*[Symbol.iterator]()` yielding the fields in order (so `a, b = t` → `const [a, b] = t`);
  `t[0]` → the named field. `_replace(x=…)` → a `_replace(kw)` method if used.
- `__slots__` → drop.
- Descriptors (`ChunkField`, `BitField`, any class with `__get__`/`__set__`): the
  descriptor class keeps the protocol methods (`__get__(obj, owner)`, `__set__(obj, value)`,
  `__set_name__(owner, name)`); a field it serves is `declare enabled: T;` in the model
  class, bound in a `static {}` block at the end of that class with
  `descriptor(this, "enabled", new ChunkField(...))` (pyrt `dunder.ts`), which infers the
  field's types from the class. Class-level access → `getDescriptor(Cls, "name")`.
- A missing-attribute fallback (Python's `__getattr__`) is `_missingAttribute(name)` and an
  assignment hook (`__setattr__`) is `_assignAttribute(name, value)`, wired with
  `pyClassHooks(Cls)`.
  `object.__setattr__(self, k, v)` → `object_setattr(this, k, v)`;
  `object.__getattribute__` → `object_getattr`.
- Other dunders: `__repr__` → `__repr__()` (also used by pyrt `repr`), `__str__` →
  `__str__()` + `toString()`, `__eq__` → `__eq__(other)` (pyrt `py_eq` calls it),
  `__hash__` → drop (note if a class is used as a Map key by value), `__len__` → `__len__()`
  (pyrt `len`/`py_bool` call it), `__iter__` → `[Symbol.iterator]()`, `__contains__` →
  `__contains__(x)`, `__getitem__` → `__getitem__(k)` and translate `obj[k]` call sites to
  `obj.__getitem__(k)`, `__bool__` → `__bool__()`, `__deepcopy__` → `__deepcopy__(memo)`.
- **Enums**: `class E(IntEnum): A = 1` → `export const E = int_enum("E", { A: 1 }, { …methods })`
  plus `export type E = EnumValue<typeof E>;`. `auto()` → `auto()`. Members are plain numbers.
  `E(v)` → `E.of(v)`; `member.name` → `E.name_of(member)`; `member.value` → `member`;
  `isinstance(x, E)` → `E.has(x)`; iteration → `E.members()`; `E["A"]` → `E.by_name("A")`;
  `_missing_`, `from_binary`, `to_binary` and other classmethods → `methods` (use `this` for
  the enum). Non-int `Enum` → `py_enum`.

## 7. Byte-exactness rules (non-negotiable)

- Parse → save of an untouched file must be byte-identical. Preserve every raw-bytes path the
  Python keeps (`_trailing`, `_NulTailStr.raw`, deferred raw bodies, legacy bodies, unknown
  chunks).
- `_NulTailStr` (a `str` subclass carrying `.raw`) → `class _NulTailStr extends String { raw }`;
  compare such values with `py_eq` / `String(x)`.
- `json.dumps(obj, ...)` → pyrt `json_dumps(obj, { separators, ensure_ascii, sort_keys, indent,
  default_ })`: Python's separators, escaping and float spelling. A float that must print as
  `1.0` is a `PyFloat` (`json_loads` produces them).
- Dict iteration order = insertion order (Map). Never iterate a plain object whose keys could be
  numeric strings.

## 8. Types

`tsconfig` is non-strict (`noImplicitAny: false`). Add types from Python annotations where they
are cheap and obvious; use `any` freely otherwise. Never let typing change behavior. No
`@ts-ignore`; use `as any` locally if the compiler blocks a faithful translation.

## 9. Tests (pytest → bun:test)

See `src/pyrt/pytest.ts` header for the mapping. One `.test.ts` per Python test file; each Python
test function becomes one `test()` with the **same name**, inside `describe("<ClassName>")` for
test classes. Parametrize → `test.each(rows)("name[%#]", …)`. Fixtures from `conftest.py` →
exported functions in `tests/conftest.ts` called at the top of the test (module-scoped fixtures →
lazily cached module constants). Keep every assertion; `assert a == b` on primitives →
`expect(a).toBe(b)`, on containers/bytes → `expect(py_eq(a, b)).toBe(true)`, approx → pyrt
`approx`. Samples live at `samples/` in this directory (same layout as upstream).

## 10. Comments and TODOs

Keep docstrings as JSDoc (`/** … */`) and keep comments that explain *why*. Mark anything you
could not translate faithfully with `// TODO(port): <precise reason>` at the exact spot and keep
going — never leave a function unimplemented without the TODO, never stub silently.
