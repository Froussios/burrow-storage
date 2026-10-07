// KP-1/KP-2/ENC-10: the root secret. Held wrapped under a non-extractable AES-KW key, in memory
// and (unless rememberDevice is false) in IndexedDB. Unwrapped only for the length of one use.
import { randomBytes, subtle, zeroise } from "./bytes.js";
import type { Cache } from "./cache/types.js";

const KW = { name: "AES-KW", length: 256 } as const;
// The wrapping vehicle: an HMAC key holding the raw secret, extractable only so it can be wrapped.
const VEHICLE = { name: "HMAC", hash: "SHA-256", length: 256 } as const;

export class SecretHolder {
  #kw: CryptoKey | null;
  #wrapped: Uint8Array<ArrayBuffer> | null;

  private constructor(kw: CryptoKey, wrapped: Uint8Array<ArrayBuffer>) {
    this.#kw = kw;
    this.#wrapped = wrapped;
  }

  static async wrap(secret: Uint8Array): Promise<SecretHolder> {
    const kw = await subtle().generateKey(KW, false, ["wrapKey", "unwrapKey"]);
    const copy = new Uint8Array(secret);
    let vehicle: CryptoKey;
    try {
      vehicle = await subtle().importKey("raw", copy, VEHICLE, true, ["sign"]);
    } finally {
      zeroise(copy); // SEC-1
    }
    return new SecretHolder(kw, new Uint8Array(await subtle().wrapKey("raw", vehicle, kw, "AES-KW")));
  }

  /** KP-2: the persisted secret, or null when this device has none. */
  static async load(cache: Cache): Promise<SecretHolder | null> {
    const d = await cache.getDevice();
    return d.kw && d.wrapped ? new SecretHolder(d.kw, new Uint8Array(d.wrapped)) : null;
  }

  /** KP-1: a fresh 32-byte secret from crypto.getRandomValues. */
  static async generate(): Promise<SecretHolder> {
    const s = randomBytes(32);
    try { return await SecretHolder.wrap(s); } finally { zeroise(s); }
  }

  get live(): boolean { return this.#kw !== null; }

  async persist(cache: Cache): Promise<void> {
    if (!this.#kw || !this.#wrapped) throw new Error("secret was forgotten");
    await cache.setDevice({ kw: this.#kw, wrapped: this.#wrapped });
  }

  /** Unwraps for the duration of `fn` and zeroises the copy afterwards (SEC-1). */
  async use<T>(fn: (secret: Uint8Array) => Promise<T>): Promise<T> {
    if (!this.#kw || !this.#wrapped) throw new Error("secret was forgotten");
    const k = await subtle().unwrapKey("raw", this.#wrapped, this.#kw, "AES-KW", VEHICLE, true, ["sign"]);
    const raw = new Uint8Array(await subtle().exportKey("raw", k));
    try { return await fn(raw); } finally { zeroise(raw); }
  }

  /** API-8: zeroise in memory. The caller removes the persisted copy. */
  forget(): void {
    zeroise(this.#wrapped);
    this.#wrapped = null;
    this.#kw = null;
  }
}
