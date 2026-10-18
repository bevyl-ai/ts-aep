"""Edit-and-save differential, Python side.

For each sample: walk the parsed project like dump_py.py, collect public
attributes that have a setter and hold a primitive value, pick a deterministic
subset, write it as a plan (OUT/<name>.plan.json), then apply the plan to a
fresh parse, record each edit's outcome, and save (OUT/<name>.py.aep).
edit_ts.ts replays the same plan on the TS port.

usage: uv run --project .upstream python tools/diff/edit_py.py OUT_DIR PER_SAMPLE SAMPLE...
"""

import hashlib
import inspect
import enum
import json
import pathlib
import re
import sys

import py_aep

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from dump_py import is_container, public_names  # noqa: E402

MAX_DEPTH = 40


def settable(obj, name):
    for cls in type(obj).__mro__:
        attr = vars(cls).get(name)
        if attr is None:
            continue
        if isinstance(attr, property):
            return attr.fset is not None
        return hasattr(type(attr), "set") and not inspect.isroutine(attr)
    return False


def candidates(app):
    out = []
    seen = set()
    keep = []

    def walk(path, value, depth):
        if depth > MAX_DEPTH or value is None or isinstance(value, (bool, int, float, str, bytes, dict, set)):
            return
        if isinstance(value, (list, tuple)):
            for i, v in enumerate(value):
                walk(f"{path}[{i}]", v, depth + 1)
            return
        if id(value) in seen:
            return
        seen.add(id(value))
        keep.append(value)
        for name in public_names(value):
            try:
                v = getattr(value, name)
            except Exception:  # noqa: BLE001
                continue
            if inspect.ismethod(v) or inspect.isfunction(v):
                continue
            if isinstance(v, (bool, int, float, str)) and not isinstance(v, type) and settable(value, name):
                out.append((f"{path}.{name}", v))
            else:
                walk(f"{path}.{name}", v, depth + 1)
        if is_container(value):
            try:
                items = list(value)
            except Exception:  # noqa: BLE001
                return
            for i, v in enumerate(items):
                walk(f"{path}[{i}]", v, depth + 1)

    walk("app", app, 0)
    return out


def new_value(v):
    if isinstance(v, bool):
        return {"bool": not v}
    if isinstance(v, int):
        return {"int": v + 1}
    if isinstance(v, float):
        return {"float": v + 0.5}
    return {"str": v + "x"}


def decode(spec):
    (kind, v), = spec.items()
    return float(v) if kind == "float" else v


STEP = re.compile(r"\.(\w+)|\[(\d+)\]")


def resolve(app, path):
    obj = app
    steps = STEP.findall(path[len("app"):])
    for name, idx in steps[:-1]:
        obj = getattr(obj, name) if name else (obj[int(idx)] if isinstance(obj, (list, tuple)) else list(obj)[int(idx)])
    return obj, steps[-1][0]


def main():
    out = pathlib.Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    per = int(sys.argv[2])
    for sample in sys.argv[3:]:
        name = sample.replace("/", "__")
        try:
            cands = candidates(py_aep.parse(sample))
        except Exception as e:  # noqa: BLE001
            (out / f"{name}.plan.json").write_text(json.dumps({"error": type(e).__name__}))
            continue
        cands.sort(key=lambda c: hashlib.sha1(c[0].encode()).hexdigest())
        plan = [{"path": p, "value": new_value(v)} for p, v in cands[:per]]
        (out / f"{name}.plan.json").write_text(json.dumps({"edits": plan}))
        app = py_aep.parse(sample)
        outcomes = []
        for e in plan:
            try:
                obj, attr = resolve(app, e["path"])
                new = decode(e["value"])
                old = getattr(obj, attr, None)
                # ts-aep enum members are plain numbers (RULEBOOK sec 6), so an
                # int edit of an enum-valued field cannot be told from the
                # member: hand Python the member too when the int is one.
                if isinstance(old, enum.Enum) and isinstance(new, int):
                    try:
                        new = type(old)(new)
                    except ValueError:
                        pass
                setattr(obj, attr, new)
                outcomes.append("ok")
            except Exception as ex:  # noqa: BLE001
                outcomes.append(type(ex).__name__)
        try:
            app.project.save(str(out / f"{name}.py.aep"))
            save = "ok"
        except Exception as ex:  # noqa: BLE001
            save = type(ex).__name__
        (out / f"{name}.py.json").write_text(json.dumps({"outcomes": outcomes, "save": save}))


if __name__ == "__main__":
    main()
