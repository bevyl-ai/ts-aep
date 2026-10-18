// The only module that touches the host runtime: file system, path flavour,
// os facts and the environment. Node and Bun hand back their own `node:fs`,
// `node:path` and `node:os` through `process.getBuiltinModule`, so behaviour
// there is unchanged. Browsers and Workers (no `process`) get an in-memory
// file system and POSIX paths; `memfs` moves bytes in and out of it:
//
//   memfs.write("/in.aep", bytes);
//   py_aep.parse("/in.aep").project.save("/out.aep");
//   const out = memfs.read("/out.aep");
//
// `useMemoryFs()` forces the in-memory backend where `node:fs` exists too
// (Workers with `nodejs_compat`, tests).

export interface HostStats {
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
  mtimeMs: number;
}

export interface HostBigStats {
  isFile(): boolean;
  isDirectory(): boolean;
  size: bigint;
  mtimeMs: bigint;
  mtimeNs: bigint;
}

export interface HostDirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

/** An open directory (`fs.opendirSync`): entries in the OS's readdir order, then null. */
export interface HostDir {
  readSync(): HostDirent | null;
  closeSync(): void;
}

/** The sync `node:fs` subset py_aep uses. */
/** Text encodings the port writes with (a host-neutral subset of Node's `BufferEncoding`). */
export type HostEncoding = "utf8" | "utf-8" | "latin1" | "ascii";

export interface HostFs {
  existsSync(path: string): boolean;
  statSync(path: string, opts?: { bigint?: false }): HostStats;
  statSync(path: string, opts: { bigint: true }): HostBigStats;
  statSync(path: string, opts?: { bigint?: boolean }): HostStats | HostBigStats;
  readFileSync(path: string): Uint8Array;
  writeFileSync(path: string, data: Uint8Array | string, encoding?: HostEncoding): void;
  mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  readdirSync(path: string): string[];
  readdirSync(path: string, opts: { withFileTypes: true }): HostDirent[];
  opendirSync(path: string): HostDir;
  unlinkSync(path: string): void;
  renameSync(from: string, to: string): void;
  mkdtempSync(prefix: string): string;
  rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void;
  openSync(path: string, flags: string): number;
  readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number;
  writeSync(fd: number, data: Uint8Array | string): number;
  fstatSync(fd: number): HostStats;
  closeSync(fd: number): void;
}

/** The `node:path` subset py_aep uses. */
export interface HostPath {
  sep: string;
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
  dirname(path: string): string;
  basename(path: string): string;
  isAbsolute(path: string): boolean;
}

const _process = globalThis.process;

function _builtin(name: "node:os"): typeof import("node:os") | null;
function _builtin(name: "node:path"): typeof import("node:path") | null;
function _builtin(name: "node:fs"): typeof import("node:fs") | null;
function _builtin(name: string): object | null {
  try {
    return _process?.getBuiltinModule?.(name) ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- os facts

/** `sys.platform`'s Node spelling: "darwin" | "win32" | "linux" | "browser". */
export const platform: string = typeof _process?.platform === "string" ? _process.platform : "browser";

/** `os.environ` (empty off Node/Bun). */
export const env: Record<string, string | undefined> = _process?.env ?? {};

const _os = _builtin("node:os");

export function tmpdir(): string {
  return _os ? _os.tmpdir() : "/tmp";
}

export function homedir(): string {
  return _os ? _os.homedir() : "/";
}

export function cwd(): string {
  return typeof _process?.cwd === "function" ? _process.cwd() : "/";
}

// ---------------------------------------------------------------- paths

function _normalizePosix(path: string): string {
  const absolute = path.startsWith("/");
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(seg);
  }
  const joined = out.join("/");
  if (absolute) return "/" + joined;
  return joined || ".";
}

/** `node:path`'s POSIX flavour, for hosts without `node:path`. */
export const posixPath: HostPath = {
  sep: "/",
  join(...parts: string[]): string {
    const joined = parts.filter((p) => p.length > 0).join("/");
    return joined ? _normalizePosix(joined) : ".";
  },
  resolve(...parts: string[]): string {
    let resolved = "";
    for (let i = parts.length - 1; i >= -1 && !resolved.startsWith("/"); i--) {
      const p = i >= 0 ? parts[i] : cwd();
      if (!p) continue;
      resolved = resolved ? `${p}/${resolved}` : p;
    }
    const n = _normalizePosix(resolved);
    return n === "." ? "/" : n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
  },
  dirname(path: string): string {
    if (!path) return ".";
    let end = path.length;
    while (end > 1 && path[end - 1] === "/") end--;
    const i = path.lastIndexOf("/", end - 1);
    if (i < 0) return ".";
    if (i === 0) return "/";
    let j = i;
    while (j > 1 && path[j - 1] === "/") j--;
    return path.slice(0, j);
  },
  basename(path: string): string {
    let end = path.length;
    while (end > 1 && path[end - 1] === "/") end--;
    const trimmed = path.slice(0, end);
    if (trimmed === "/") return "";
    return trimmed.slice(trimmed.lastIndexOf("/") + 1);
  },
  isAbsolute(path: string): boolean {
    return path.startsWith("/");
  },
};

/** The host's `os.path`: Node's own where present, POSIX otherwise. */
export const path: HostPath = _builtin("node:path") ?? posixPath;

// ---------------------------------------------------------------- memory fs

function _fsError(code: string, syscall: string, p: string): Error {
  const text: Record<string, string> = {
    ENOENT: "no such file or directory",
    EEXIST: "file already exists",
    EISDIR: "illegal operation on a directory",
    ENOTDIR: "not a directory",
    ENOTEMPTY: "directory not empty",
    EBADF: "bad file descriptor",
  };
  return Object.assign(new Error(`${code}: ${text[code] ?? code}, ${syscall} '${p}'`), {
    code,
    syscall,
    path: p,
    errno: -1,
  });
}

interface _MemFile {
  data: Uint8Array;
  mtimeMs: number;
}

interface _MemFd {
  path: string;
  writable: boolean;
}

/** A sync, in-memory `node:fs` subset over absolute POSIX-style keys. */
export class MemoryFs implements HostFs {
  readonly files = new Map<string, _MemFile>();
  readonly dirs = new Set<string>(["/"]);
  private readonly fds = new Map<number, _MemFd>();
  private nextFd = 3;

  key(p: string): string {
    return path.resolve(String(p));
  }

  private _isDir(k: string): boolean {
    if (this.dirs.has(k) || path.dirname(k) === k) return true;
    const prefix = k.endsWith(path.sep) ? k : k + path.sep;
    for (const f of this.files.keys()) if (f.startsWith(prefix)) return true;
    return false;
  }

  private _children(k: string): string[] {
    const prefix = k.endsWith(path.sep) ? k : k + path.sep;
    const names = new Set<string>();
    for (const entry of [...this.files.keys(), ...this.dirs]) {
      if (entry !== k && entry.startsWith(prefix)) names.add(entry.slice(prefix.length).split(path.sep)[0]);
    }
    return [...names];
  }

  private _stats(k: string): HostStats {
    const f = this.files.get(k);
    if (f) return { isFile: () => true, isDirectory: () => false, size: f.data.length, mtimeMs: f.mtimeMs };
    if (this._isDir(k)) return { isFile: () => false, isDirectory: () => true, size: 0, mtimeMs: 0 };
    throw _fsError("ENOENT", "stat", k);
  }

  private _put(k: string, data: Uint8Array, syscall: string): void {
    if (this._isDir(k)) throw _fsError("EISDIR", syscall, k);
    if (!this._isDir(path.dirname(k))) throw _fsError("ENOENT", syscall, k);
    this.files.set(k, { data, mtimeMs: Date.now() });
  }

  existsSync(p: string): boolean {
    const k = this.key(p);
    return this.files.has(k) || this._isDir(k);
  }

  statSync(p: string, opts?: { bigint?: false }): HostStats;
  statSync(p: string, opts: { bigint: true }): HostBigStats;
  statSync(p: string, opts?: { bigint?: boolean }): HostStats | HostBigStats;
  statSync(p: string, opts: { bigint?: boolean } = {}): HostStats | HostBigStats {
    const st = this._stats(this.key(p));
    if (!opts.bigint) return st;
    return {
      ...st,
      size: BigInt(st.size),
      mtimeMs: BigInt(Math.trunc(st.mtimeMs)),
      mtimeNs: BigInt(Math.trunc(st.mtimeMs)) * 1000000n,
    };
  }

  readFileSync(p: string): Uint8Array;
  readFileSync(p: string, encoding: string): string;
  readFileSync(p: string, encoding?: string): Uint8Array | string {
    const k = this.key(p);
    const f = this.files.get(k);
    if (!f) throw _fsError(this._isDir(k) ? "EISDIR" : "ENOENT", "open", k);
    const copy = f.data.slice();
    return encoding ? new TextDecoder().decode(copy) : copy;
  }

  writeFileSync(p: string, data: Uint8Array | string): void {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
    this._put(this.key(p), bytes, "open");
  }

  mkdirSync(p: string, opts: { recursive?: boolean } = {}): void {
    const k = this.key(p);
    if (this.files.has(k)) throw _fsError("EEXIST", "mkdir", k);
    if (this._isDir(k)) {
      if (opts.recursive) return;
      throw _fsError("EEXIST", "mkdir", k);
    }
    const parent = path.dirname(k);
    if (!this._isDir(parent)) {
      if (!opts.recursive) throw _fsError("ENOENT", "mkdir", k);
      this.mkdirSync(parent, opts);
    }
    this.dirs.add(k);
  }

  readdirSync(p: string): string[];
  readdirSync(p: string, opts: { withFileTypes: true }): HostDirent[];
  readdirSync(p: string, opts?: { withFileTypes?: boolean }): string[] | HostDirent[] {
    const k = this.key(p);
    if (this.files.has(k)) throw _fsError("ENOTDIR", "scandir", k);
    if (!this._isDir(k)) throw _fsError("ENOENT", "scandir", k);
    const names = this._children(k).sort();
    if (!opts?.withFileTypes) return names;
    return names.map((name) => {
      const child = path.join(k, name);
      const isFile = this.files.has(child);
      return { name, isFile: () => isFile, isDirectory: () => !isFile };
    });
  }

  opendirSync(p: string): HostDir {
    const entries = this.readdirSync(p, { withFileTypes: true });
    let i = 0;
    return { readSync: () => entries[i++] ?? null, closeSync: () => {} };
  }

  unlinkSync(p: string): void {
    const k = this.key(p);
    if (!this.files.delete(k)) throw _fsError(this._isDir(k) ? "EISDIR" : "ENOENT", "unlink", k);
  }

  renameSync(from: string, to: string): void {
    const src = this.key(from);
    const f = this.files.get(src);
    if (!f) throw _fsError("ENOENT", "rename", src);
    const dst = this.key(to);
    this._put(dst, f.data, "rename");
    if (dst !== src) this.files.delete(src);
  }

  mkdtempSync(prefix: string): string {
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    for (;;) {
      const rnd = new Uint8Array(6);
      globalThis.crypto.getRandomValues(rnd);
      const candidate = prefix + Array.from(rnd, (v) => alphabet[v % alphabet.length]).join("");
      if (!this.existsSync(candidate)) {
        this.mkdirSync(candidate, { recursive: true });
        return candidate;
      }
    }
  }

  rmSync(p: string, opts: { recursive?: boolean; force?: boolean } = {}): void {
    const k = this.key(p);
    if (this.files.delete(k)) return;
    if (!this._isDir(k)) {
      if (opts.force) return;
      throw _fsError("ENOENT", "rm", k);
    }
    const prefix = k.endsWith(path.sep) ? k : k + path.sep;
    const nested = [...this.files.keys(), ...this.dirs].filter((e) => e.startsWith(prefix));
    if (nested.length && !opts.recursive) throw _fsError("ENOTEMPTY", "rm", k);
    for (const e of nested) {
      this.files.delete(e);
      this.dirs.delete(e);
    }
    if (k !== "/") this.dirs.delete(k);
  }

  openSync(p: string, flags: string): number {
    const k = this.key(p);
    if (flags === "r") {
      if (!this.files.has(k)) throw _fsError(this._isDir(k) ? "EISDIR" : "ENOENT", "open", k);
    } else if (flags === "w" || flags === "wx") {
      if (flags === "wx" && (this.files.has(k) || this._isDir(k))) throw _fsError("EEXIST", "open", k);
      this._put(k, new Uint8Array(0), "open");
    } else {
      throw new Error(`memory fs: unsupported open flags '${flags}'`);
    }
    const fd = this.nextFd++;
    this.fds.set(fd, { path: k, writable: flags !== "r" });
    return fd;
  }

  private _fd(fd: number): _MemFd {
    const entry = this.fds.get(fd);
    if (!entry) throw _fsError("EBADF", "fd", String(fd));
    return entry;
  }

  readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number {
    const data = this.files.get(this._fd(fd).path)?.data ?? new Uint8Array(0);
    const start = position ?? 0;
    const chunk = data.subarray(start, Math.min(start + length, data.length));
    buffer.set(chunk, offset);
    return chunk.length;
  }

  writeSync(fd: number, data: Uint8Array | string): number {
    const entry = this._fd(fd);
    if (!entry.writable) throw _fsError("EBADF", "write", entry.path);
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const f = this.files.get(entry.path);
    const prev = f?.data ?? new Uint8Array(0);
    const next = new Uint8Array(prev.length + bytes.length);
    next.set(prev);
    next.set(bytes, prev.length);
    this.files.set(entry.path, { data: next, mtimeMs: Date.now() });
    return bytes.length;
  }

  fstatSync(fd: number): HostStats {
    return this._stats(this._fd(fd).path);
  }

  closeSync(fd: number): void {
    this._fd(fd);
    this.fds.delete(fd);
  }
}

const _memory = new MemoryFs();
const _nodeFs: HostFs | null = _builtin("node:fs");
let _active: HostFs | null = null;

/** Route every py_aep file access to the in-memory file system. */
export function useMemoryFs(): void {
  _active = _memory;
}

/** Route file access back to the host's `node:fs` (when it has one). */
export function useHostFs(): void {
  _active = null;
}

/** "node" when file access goes to the host's `node:fs`, else "memory". */
export function fsBackend(): "node" | "memory" {
  return (_active ?? _nodeFs ?? _memory) === _memory ? "memory" : "node";
}

/** The active file system: the host's `node:fs`, or the in-memory one. */
export const fs: HostFs = new Proxy({} as HostFs, {
  get(_t, name: string) {
    const target: HostFs = _active ?? _nodeFs ?? _memory;
    const v: unknown = Reflect.get(target, name);
    if (typeof v !== "function") return v;
    if (name !== "readFileSync") return v.bind(target);
    // A Node `Buffer` slices to views; hand out a plain Uint8Array so `slice` copies.
    return (...args: unknown[]) => {
      const out: unknown = v.apply(target, args);
      return out instanceof Uint8Array && out.constructor !== Uint8Array
        ? new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
        : out;
    };
  },
});

/**
 * `os.scandir(path)`: the entries in the OS's readdir order, which Python's
 * listings keep (`readdirSync` sorts them on Node; a directory handle does not).
 */
export function scandir(p: string): HostDirent[] {
  const dir = fs.opendirSync(p);
  const out: HostDirent[] = [];
  try {
    for (let ent = dir.readSync(); ent !== null; ent = dir.readSync()) out.push(ent);
  } finally {
    dir.closeSync();
  }
  return out;
}

/**
 * Move bytes in and out of the in-memory file system (the backend in
 * browsers and Workers; see `useMemoryFs`).
 */
export const memfs = {
  write(p: string, data: Uint8Array | ArrayBuffer): void {
    const k = _memory.key(p);
    _memory.mkdirSync(path.dirname(k), { recursive: true });
    _memory.writeFileSync(k, data instanceof Uint8Array ? data : new Uint8Array(data));
  },
  read(p: string): Uint8Array {
    return _memory.readFileSync(p);
  },
  exists(p: string): boolean {
    return _memory.existsSync(p);
  },
  /** Every file path, sorted; under `dir` when given. */
  list(dir = "/"): string[] {
    const k = _memory.key(dir);
    const prefix = k.endsWith(path.sep) ? k : k + path.sep;
    return [..._memory.files.keys()].filter((f) => f.startsWith(prefix)).sort();
  },
  remove(p: string): void {
    _memory.rmSync(p, { recursive: true, force: true });
  },
  clear(): void {
    _memory.files.clear();
    _memory.dirs.clear();
    _memory.dirs.add("/");
  },
};
