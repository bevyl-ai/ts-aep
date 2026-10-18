// `contextvars.ContextVar` for synchronous code: set() returns a token that
// reset() restores. py_aep never awaits while one is set.

export class ContextVar<T> {
  private value: T;

  constructor(
    readonly name: string,
    opts: { default: T },
  ) {
    this.value = opts.default;
  }

  get(): T {
    return this.value;
  }

  set(value: T): { readonly old: T } {
    const token = { old: this.value };
    this.value = value;
    return token;
  }

  reset(token: { readonly old: T }): void {
    this.value = token.old;
  }
}
