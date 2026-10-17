// The `pathlib.Path` subset py_aep uses, over the host fs / path (pyrt/host).

import { fs, homedir, path as nodepath, type HostStats } from "./host.ts";
import { error_code, FileNotFoundError } from "./errors.ts";

export class Path {
  readonly path: string;

  constructor(...parts: (string | Path)[]) {
    this.path = parts.length ? nodepath.join(...parts.map(String)) : ".";
  }

  /** `Path.home()`: `os.path.expanduser("~")`, i.e. `$HOME` first, then the password database. */
  static home(): Path {
    return new Path(homedir());
  }

  toString(): string {
    return this.path;
  }

  /** `PurePath.__eq__`: equal when same flavour and same normalised path. */
  __eq__(other: unknown): boolean {
    return other instanceof Path && other.path === this.path;
  }

  /** `p / "child"` */
  div(...parts: (string | Path)[]): Path {
    return new Path(this.path, ...parts.map(String));
  }

  get name(): string {
    return nodepath.basename(this.path);
  }

  get stem(): string {
    const n = this.name;
    const i = n.lastIndexOf(".");
    return i > 0 ? n.slice(0, i) : n;
  }

  get suffix(): string {
    const n = this.name;
    const i = n.lastIndexOf(".");
    return i > 0 ? n.slice(i) : "";
  }

  get parent(): Path {
    return new Path(nodepath.dirname(this.path));
  }

  get parts(): string[] {
    return this.path.split(nodepath.sep).filter(Boolean);
  }

  with_suffix(suffix: string): Path {
    return new Path(this.parent.path, this.stem + suffix);
  }

  with_name(name: string): Path {
    return new Path(this.parent.path, name);
  }

  exists(): boolean {
    return fs.existsSync(this.path);
  }

  is_file(): boolean {
    return fs.existsSync(this.path) && fs.statSync(this.path).isFile();
  }

  is_dir(): boolean {
    return fs.existsSync(this.path) && fs.statSync(this.path).isDirectory();
  }

  resolve(): Path {
    return new Path(nodepath.resolve(this.path));
  }

  read_bytes(): Uint8Array {
    try {
      // A plain view of the host's buffer (a Node `Buffer` subclasses Uint8Array with other
      // `slice` semantics) instead of a copy of the whole file.
      const data = fs.readFileSync(this.path);
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } catch (e: unknown) {
      if (error_code(e) === "ENOENT") throw new FileNotFoundError(`[Errno 2] No such file or directory: '${this.path}'`);
      throw e;
    }
  }

  write_bytes(data: Uint8Array): number {
    fs.writeFileSync(this.path, data);
    return data.length;
  }

  read_text(encoding: ConstructorParameters<typeof TextDecoder>[0] = "utf-8"): string {
    return new TextDecoder(encoding).decode(this.read_bytes());
  }

  write_text(text: string): number {
    fs.writeFileSync(this.path, text, "utf-8");
    return text.length;
  }

  mkdir(opts: { parents?: boolean; exist_ok?: boolean } = {}): void {
    if (opts.exist_ok && this.exists()) return;
    fs.mkdirSync(this.path, { recursive: opts.parents ?? false });
  }

  unlink(opts: { missing_ok?: boolean } = {}): void {
    if (opts.missing_ok && !this.exists()) return;
    fs.unlinkSync(this.path);
  }

  /** `os.replace(self, target)` / `Path.replace` */
  replace(target: string | Path): Path {
    fs.renameSync(this.path, String(target));
    return new Path(String(target));
  }

  iterdir(): Path[] {
    return fs.readdirSync(this.path).sort().map((n) => this.div(n));
  }

  /** `glob` with `*`, `?` and a leading `**` segment. */
  glob(pattern: string): Path[] {
    const recursive = pattern.startsWith("**/");
    const leaf = recursive ? pattern.slice(3) : pattern;
    const re = new RegExp(
      "^" + leaf.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + "$",
    );
    const out: Path[] = [];
    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const full = nodepath.join(dir, ent.name);
        if (re.test(ent.name)) out.push(new Path(full));
        if (recursive && ent.isDirectory()) walk(full);
      }
    };
    walk(this.path);
    return out;
  }

  rglob(pattern: string): Path[] {
    return this.glob("**/" + pattern);
  }

  stat(): HostStats {
    return fs.statSync(this.path);
  }
}

/** Accepts `str | os.PathLike` like Python APIs do. */
export type PathLike = string | Path;

export function fspath(p: PathLike): string {
  return String(p);
}

/** `ntpath.splitroot` (CPython 3.12). */
function nt_splitroot(p: string): [string, string, string] {
  const normp = p.replace(/\//g, "\\");
  if (normp.slice(0, 1) === "\\") {
    if (normp.slice(1, 2) === "\\") {
      // UNC drives (\\server\share, \\?\UNC\server\share) and device drives.
      const start = normp.slice(0, 8).toUpperCase() === "\\\\?\\UNC\\" ? 8 : 2;
      const index = normp.indexOf("\\", start);
      if (index === -1) return [p, "", ""];
      const index2 = normp.indexOf("\\", index + 1);
      if (index2 === -1) return [p, "", ""];
      return [p.slice(0, index2), p.slice(index2, index2 + 1), p.slice(index2 + 1)];
    }
    return ["", p.slice(0, 1), p.slice(1)];
  }
  if (normp.slice(1, 2) === ":") {
    if (normp.slice(2, 3) === "\\") return [p.slice(0, 2), p.slice(2, 3), p.slice(3)];
    return [p.slice(0, 2), "", p.slice(2)];
  }
  return ["", "", p];
}

/** `posixpath.splitroot` (CPython 3.12). */
function posix_splitroot(p: string): [string, string, string] {
  if (p.slice(0, 1) !== "/") return ["", "", p];
  if (p.slice(1, 2) !== "/" || p.slice(2, 3) === "/") return ["", "/", p.slice(1)];
  return ["", p.slice(0, 2), p.slice(2)];
}

/** `ntpath.join` (CPython 3.12). */
function nt_join(path: string, ...paths: string[]): string {
  let [result_drive, result_root, result_path] = nt_splitroot(path);
  for (const p of paths) {
    const [p_drive, p_root, p_path] = nt_splitroot(p);
    if (p_root) {
      if (p_drive || !result_drive) result_drive = p_drive;
      result_root = p_root;
      result_path = p_path;
      continue;
    } else if (p_drive && p_drive !== result_drive) {
      if (p_drive.toLowerCase() !== result_drive.toLowerCase()) {
        result_drive = p_drive;
        result_root = p_root;
        result_path = p_path;
        continue;
      }
      result_drive = p_drive;
    }
    if (result_path && !"\\/".includes(result_path.slice(-1))) result_path += "\\";
    result_path += p_path;
  }
  if (result_path && !result_root && result_drive && !":\\/".includes(result_drive.slice(-1))) {
    return result_drive + "\\" + result_path;
  }
  return result_drive + result_root + result_path;
}

/** `posixpath.join` */
function posix_join(a: string, ...p: string[]): string {
  let path = a;
  for (const b of p) {
    if (b.startsWith("/")) path = b;
    else if (!path || path.endsWith("/")) path += b;
    else path += "/" + b;
  }
  return path;
}

type Flavour = {
  sep: string;
  altsep: string | null;
  splitroot: (p: string) => [string, string, string];
  join: (a: string, ...p: string[]) => string;
  casefold: boolean;
};

const POSIX: Flavour = { sep: "/", altsep: null, splitroot: posix_splitroot, join: posix_join, casefold: false };
const WINDOWS: Flavour = { sep: "\\", altsep: "/", splitroot: nt_splitroot, join: nt_join, casefold: true };

/**
 * `pathlib.PurePath` (CPython 3.12) for the flavours `PurePosixPath` and
 * `PureWindowsPath`: pure string manipulation, the same on every host.
 */
export class PurePath {
  declare readonly _raw_paths: string[];
  declare readonly drive: string;
  declare readonly root: string;
  declare readonly _tail: string[];
  protected get _flavour(): Flavour {
    throw new TypeError("PurePath is abstract; use PurePosixPath or PureWindowsPath");
  }

  constructor(...args: (string | PurePath)[]) {
    const paths: string[] = [];
    for (const a of args) {
      if (a instanceof PurePath) {
        if (a._flavour === WINDOWS && this._flavour === POSIX) paths.push(...a._raw_paths.map((p) => p.replace(/\\/g, "/")));
        else paths.push(...a._raw_paths);
      } else {
        paths.push(String(a));
      }
    }
    this._raw_paths = paths;
    const f = this._flavour;
    let path = paths.length === 0 ? "" : paths.length === 1 ? paths[0] : f.join(paths[0], ...paths.slice(1));
    let drv = "";
    let root = "";
    let tail: string[] = [];
    if (path) {
      if (f.altsep) path = path.split(f.altsep).join(f.sep);
      let rel: string;
      [drv, root, rel] = f.splitroot(path);
      if (!root && drv.startsWith(f.sep) && !drv.endsWith(f.sep)) {
        const drv_parts = drv.split(f.sep);
        if ((drv_parts.length === 4 && !"?.".includes(drv_parts[2])) || drv_parts.length === 6) root = f.sep;
      }
      tail = rel.split(f.sep).filter((x) => x && x !== ".");
    }
    this.drive = drv;
    this.root = root;
    this._tail = tail;
  }

  /** A new path of the same flavour from the given segments (`with_segments`). */
  protected _with(...args: (string | PurePath)[]): this {
    return new (this.constructor as new (...a: (string | PurePath)[]) => this)(...args);
  }

  get anchor(): string {
    return this.drive + this.root;
  }

  get parts(): string[] {
    return this.drive || this.root ? [this.drive + this.root, ...this._tail] : [...this._tail];
  }

  get name(): string {
    return this._tail.length ? this._tail[this._tail.length - 1] : "";
  }

  get suffix(): string {
    const name = this.name;
    const i = name.lastIndexOf(".");
    return 0 < i && i < name.length - 1 ? name.slice(i) : "";
  }

  get stem(): string {
    const name = this.name;
    const i = name.lastIndexOf(".");
    return 0 < i && i < name.length - 1 ? name.slice(0, i) : name;
  }

  get parent(): this {
    if (!this._tail.length) return this;
    const f = this._flavour;
    return this._with(this.anchor + this._tail.slice(0, -1).join(f.sep));
  }

  /** `p / "child"` */
  div(...parts: (string | PurePath)[]): this {
    return this._with(this, ...parts);
  }

  joinpath(...parts: (string | PurePath)[]): this {
    return this._with(this, ...parts);
  }

  is_absolute(): boolean {
    if (this._flavour === POSIX) return Boolean(this.root);
    return Boolean(this.drive && this.root);
  }

  toString(): string {
    const f = this._flavour;
    if (this.drive || this.root) return this.drive + this.root + this._tail.join(f.sep);
    if (this._tail.length && f.splitroot(this._tail[0])[0]) return ["." , ...this._tail].join(f.sep);
    return this._tail.join(f.sep) || ".";
  }

  __str__(): string {
    return this.toString();
  }

  __eq__(other: unknown): boolean {
    if (!(other instanceof PurePath) || other._flavour !== this._flavour) return false;
    const a = String(this);
    const b = String(other);
    return this._flavour.casefold ? a.toLowerCase() === b.toLowerCase() : a === b;
  }

  __repr__(): string {
    return `${this.constructor.name}('${this.toString()}')`;
  }
}

export class PurePosixPath extends PurePath {
  protected get _flavour(): Flavour {
    return POSIX;
  }
}

export class PureWindowsPath extends PurePath {
  protected get _flavour(): Flavour {
    return WINDOWS;
  }
}
