/** General-purpose utilities for py_aep. */

import { warn } from "../pyrt/index.ts";

/**
 * Decorator that marks a function as deprecated.
 *
 * Emits a `DeprecationWarning` with `message` each time the decorated
 * function is called.
 *
 * @param message - Explanation shown in the warning (e.g. migration path).
 */
export function deprecated(message: string) {
  return function decorator<T, A extends unknown[], R>(func: (this: T, ...args: A) => R): (this: T, ...args: A) => R {
    function wrapper(this: T, ...args: A): R {
      // TODO(port): warn(message) carries only the message string, so the DeprecationWarning
      // category and stacklevel=2 (caller attribution) are not represented; affects only warning-filter
      // and location semantics, not the message text.
      // TODO(port): JS functions have no __qualname__; func.name is used, so a decorated method warns as
      // "m is deprecated..." where Python says "Cls.m is deprecated...". No call sites exist in src yet.
      warn(`${func.name} is deprecated. ${message}`);
      return func.apply(this, args);
    }
    // functools.wraps(func): copy __name__ and set __wrapped__ (no __doc__/__qualname__ in JS).
    Object.defineProperty(wrapper, "name", { value: func.name, configurable: true });
    wrapper.wrapped = func;
    return wrapper;
  };
}
