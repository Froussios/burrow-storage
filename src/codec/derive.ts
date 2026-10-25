// §7 derivation. The salts and info labels below are the current
// cryptographic contract (ENC-2, D-55): changes go with SECURITY.md and
// test/vectors.json.
import {
  b64url,
  concat,
  hex,
  sha256,
  subtle,
  utf8,
  zeroise,
} from "../bytes.js";

export const SALT_V1 = "burrow/v1";
/** Fixed library input for the WebAuthn PRF evaluation (D-58). */
export const PRF_SALT = "burrow/prf-token/v1";
/** HKDF salt turning a passkey's PRF output into an app's token (D-58). */
export const PASSKEY_TOKEN_SALT = "burrow/passkey-token/v1";
export const ID_LENGTH = 43;

const HMAC = { name: "HMAC", hash: "SHA-256" } as const;

/**
 * Import key material as an HKDF key through a private copy, zeroised once
 * imported (SEC-1).
 */
async function hkdfBase(ikm: Uint8Array): Promise<CryptoKey> {
  const copy = new Uint8Array(ikm);
  try {
    return await subtle().importKey("raw", copy, "HKDF", false, [
      "deriveBits",
      "deriveKey",
    ]);
  } finally {
    zeroise(copy);
  }
}

const hkdf = (salt: string, info: Uint8Array<ArrayBuffer>) =>
  ({ name: "HKDF", hash: "SHA-256", salt: utf8(salt), info }) as const;

// WebCrypto's HKDF performs both HKDF-Extract and HKDF-Expand.
async function expandBits(
  ikm: CryptoKey,
  salt: string,
  info: Uint8Array<ArrayBuffer>,
  length = 256,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await subtle().deriveBits(hkdf(salt, info), ikm, length),
  );
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

/**
 * Derive the per-app key set from the root secret. All keys non-extractable
 * (SEC-2).
 */
export async function deriveAppKeys(
  rootSecret: Uint8Array,
  app: string,
): Promise<AppKeys> {
  const ikm = await hkdfBase(rootSecret);
  const pathBits = await expandBits(
    ikm,
    SALT_V1,
    concat(utf8("path"), utf8(app)),
  );
  try {
    const base = idOf(await sha256(pathBits));
    const pathKey = await subtle().importKey("raw", pathBits, HMAC, false, [
      "sign",
    ]);
    const encKey = await subtle().deriveKey(
      hkdf(SALT_V1, concat(utf8("enc"), utf8(app))),
      ikm,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const macKey = await subtle().deriveKey(
      hkdf(SALT_V1, concat(utf8("auth"), utf8(app))),
      ikm,
      { ...HMAC, length: 256 },
      false,
      ["sign"],
    );
    return { app, base, pathKey, encKey, macKey };
  } finally {
    zeroise(pathBits);
  }
}

async function hmac(
  key: CryptoKey,
  data: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array> {
  return new Uint8Array(await subtle().sign("HMAC", key, data));
}

/** docId(k) = base64url(HMAC-SHA-256(pathKey, "item" || k))[0:43] (ENC-1). */
export async function docId(keys: AppKeys, key: string): Promise<string> {
  return idOf(await hmac(keys.pathKey, concat(utf8("item"), utf8(key))));
}

/**
 * tok(id, n) = base64url(HMAC-SHA-256(macKey, id || n)), n as a decimal string
 * (ENC-7).
 */
export async function token(
  macKey: CryptoKey,
  id: string,
  n: number,
): Promise<string> {
  return b64url(await hmac(macKey, utf8(id + String(n))));
}

/** The commitment a document at rev n stores: hex(SHA-256(tok(id, n+1))). */
export async function commitment(
  macKey: CryptoKey,
  id: string,
  n: number,
): Promise<string> {
  return hex(await sha256(utf8(await token(macKey, id, n + 1))));
}

/**
 * The 32-byte root secret of the token a passkey gives an app:
 * HKDF-SHA256(prfOutput, salt "burrow/passkey-token/v1", info = app). The same
 * credential gives each app its own token (D-58). The caller zeroises it.
 */
export async function derivePasskeySecret(
  prfOutput: Uint8Array,
  app: string,
): Promise<Uint8Array<ArrayBuffer>> {
  return expandBits(await hkdfBase(prfOutput), PASSKEY_TOKEN_SALT, utf8(app));
}
