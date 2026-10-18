// `uuid.uuid4()` over `crypto.getRandomValues` (every target runtime has it;
// `crypto.randomUUID` needs a secure context in browsers).

/** `uuid.uuid4().bytes`: 16 random bytes with the version-4 / RFC 4122 bits set. */
export function uuid4Bytes(): Uint8Array {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return b;
}

/** `str(uuid.uuid4())`: lowercase, hyphenated. */
export function uuid4(): string {
  const h = Array.from(uuid4Bytes(), (v) => v.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
