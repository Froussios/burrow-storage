// §7 derivation. ENC-2: the v1 salts and info labels below are frozen public contract.
import { b64url, concat, hex, sha256, subtle, utf8, zeroise } from "../bytes.js";

export const SALT_V1 = "burrow/v1";
export const SLOT_SALT_V1 = "burrow/slot/v1";
/** Fixed library salt for the WebAuthn PRF evaluation (KP-5/6). */
export const PRF_SALT_V1 = "burrow/prf/v1";
export const ID_LENGTH = 43;

const HMAC = { name: "HMAC", hash: "SHA-256" } as const;

/** Import key material as an HKDF key through a private copy, zeroised once imported (SEC-1). */
async function hkdfBase(ikm: Uint8Array): Promise<CryptoKey> {
  const copy = new Uint8Array(ikm);
  try {
    return await subtle().importKey("raw", copy, "HKDF", false, ["deriveBits", "deriveKey"]);
  } finally {
    zeroise(copy);
  }
}

const hkdf = (salt: string, info: Uint8Array<ArrayBuffer>) =>
  ({ name: "HKDF", hash: "SHA-256", salt: utf8(salt), info }) as const;

// HKDF-Extract then HKDF-Expand(prk, info, 32): WebCrypto's HKDF performs both steps.
async function expandBits(ikm: CryptoKey, salt: string, info: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await subtle().deriveBits(hkdf(salt, info), ikm, 256));
}

const idOf = (digest: Uint8Array) => b64url(digest).slice(0, ID_LENGTH);

export interface AppKeys {
  readonly app: string;
  /** Id of the user's manifest document. */
  readonly base: string;
  readonly pathKey: CryptoKey;
  readonly encKey: CryptoKey;
  readonly macKey: CryptoKey;
}

/** Derive the per-app key set from the root secret. All keys non-extractable (SEC-2). */
export async function deriveAppKeys(rootSecret: Uint8Array, app: string): Promise<AppKeys> {
  const ikm = await hkdfBase(rootSecret);
  const pathBits = await expandBits(ikm, SALT_V1, concat(utf8("path"), utf8(app)));
  try {
    const base = idOf(await sha256(pathBits));
    const pathKey = await subtle().importKey("raw", pathBits, HMAC, false, ["sign"]);
    const encKey = await subtle().deriveKey(hkdf(SALT_V1, concat(utf8("enc"), utf8(app))), ikm,
      { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const macKey = await subtle().deriveKey(hkdf(SALT_V1, concat(utf8("auth"), utf8(app))), ikm,
      { ...HMAC, length: 256 }, false, ["sign"]);
    return { app, base, pathKey, encKey, macKey };
  } finally {
    zeroise(pathBits);
  }
}

async function hmac(key: CryptoKey, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  return new Uint8Array(await subtle().sign("HMAC", key, data));
}

/** docId(k) = base64url(HMAC-SHA-256(pathKey, "item" || k))[0:43] (ENC-1). */
export async function docId(keys: AppKeys, key: string): Promise<string> {
  return idOf(await hmac(keys.pathKey, concat(utf8("item"), utf8(key))));
}

/** tok(id, n) = base64url(HMAC-SHA-256(macKey, id || n)), n as a decimal string (ENC-7). */
export async function token(macKey: CryptoKey, id: string, n: number): Promise<string> {
  return b64url(await hmac(macKey, utf8(id + String(n))));
}

/** The commitment a document at rev n stores: hex(SHA-256(tok(id, n+1))). */
export async function commitment(macKey: CryptoKey, id: string, n: number): Promise<string> {
  return hex(await sha256(utf8(await token(macKey, id, n + 1))));
}

export interface SlotKeys {
  readonly slotId: string;
  /** Wraps the root secret (AES-256-GCM). */
  readonly kek: CryptoKey;
  /** Write chain for the keyslot document. */
  readonly slotMac: CryptoKey;
}

/** The passkey keyslot key set: PRF output plays the role of ikm (KP-5/6, ENC-11). */
export async function deriveSlotKeys(prfOutput: Uint8Array): Promise<SlotKeys> {
  const ikm = await hkdfBase(prfOutput);
  const kek = await subtle().deriveKey(hkdf(SLOT_SALT_V1, utf8("kek")), ikm,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const slotMac = await subtle().deriveKey(hkdf(SLOT_SALT_V1, utf8("auth")), ikm,
    { ...HMAC, length: 256 }, false, ["sign"]);
  const slotBits = await expandBits(ikm, SLOT_SALT_V1, utf8("slot"));
  try {
    return { slotId: idOf(await sha256(slotBits)), kek, slotMac };
  } finally {
    zeroise(slotBits);
  }
}

/**
 * ENC-3: a secret derived from typed input passes through PBKDF2-SHA-256 (≥ 600,000 iterations)
 * before it becomes ikm. Not exported from the package in v1 (docs/decisions.md D-12).
 */
export async function passphraseSecret(passphrase: string, salt: string, iterations = 600_000): Promise<Uint8Array> {
  if (iterations < 600_000) throw new RangeError("PBKDF2 needs at least 600,000 iterations (ENC-3)");
  const k = await subtle().importKey("raw", utf8(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await subtle().deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: utf8(salt), iterations }, k, 256));
}
