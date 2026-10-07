// §7 document format: AES-256-GCM with id/app/rev bound as AAD (ENC-5),
// optional deflate-raw (ENC-4).
import { b64url, fromB64url, randomBytes, subtle, utf8 } from "../bytes.js";
import { BurrowError } from "../errors.js";
import type { Envelope } from "../types.js";
import { commitment, token } from "./derive.js";

/**
 * Rules cap `ct` at 1,000,000 base64url chars (= 750,000 ciphertext bytes,
 * incl. the 16-byte tag).
 */
export const MAX_CT_CHARS = 1_000_000;
/**
 * Largest plaintext that always fits under MAX_CT_CHARS, even incompressible
 * (docs/decisions.md D-4).
 */
export const HARD_MAX_PLAINTEXT = 749_000;

export interface DocCipher {
  /** AES-GCM key for ct. */
  readonly key: CryptoKey;
  /** HMAC key for the write-token chain (macKey, or slotMac for a keyslot). */
  readonly mac: CryptoKey;
  /**
   * The AAD prefix: id || app for manifests and items, slotId || "slot" for a
   * keyslot (ENC-5).
   */
  readonly aad: string;
}

const aadFor = (c: DocCipher, rev: number) => utf8(c.aad + String(rev));

async function pipe(
  data: Uint8Array<ArrayBuffer>,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Response(new Blob([data]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

const canCompress = () => typeof CompressionStream === "function";

/** Encrypt `plaintext` as revision `rev` of document `id`. */
export async function seal(
  c: DocCipher,
  id: string,
  rev: number,
  plaintext: Uint8Array<ArrayBuffer>,
  ts: number,
): Promise<Envelope> {
  let body = plaintext;
  let z = false;
  if (canCompress() && plaintext.length > 64) {
    const packed = await pipe(plaintext, new CompressionStream("deflate-raw"));
    if (packed.length < plaintext.length) {
      body = packed;
      z = true;
    }
  }
  const iv = randomBytes(12);
  const ct = b64url(
    new Uint8Array(
      await subtle().encrypt(
        { name: "AES-GCM", iv, additionalData: aadFor(c, rev) },
        c.key,
        body,
      ),
    ),
  );
  if (ct.length > MAX_CT_CHARS) throw new BurrowError("item-too-large");
  const env: Envelope = {
    v: 1,
    iv: b64url(iv),
    ct,
    rev,
    ts: Math.floor(ts),
    tok: await token(c.mac, id, rev),
    next: await commitment(c.mac, id, rev),
  };
  if (z) env.z = true;
  return env;
}

/** Decrypt an envelope read at `id`. Any failure is decrypt-failed (ENC-6). */
export async function open(
  c: DocCipher,
  env: Envelope,
): Promise<Uint8Array<ArrayBuffer>> {
  try {
    if (env.v !== 1) throw new Error("unknown envelope version");
    const pt = new Uint8Array(
      await subtle().decrypt(
        {
          name: "AES-GCM",
          iv: fromB64url(env.iv),
          additionalData: aadFor(c, env.rev),
        },
        c.key,
        fromB64url(env.ct),
      ),
    );
    return env.z ? await pipe(pt, new DecompressionStream("deflate-raw")) : pt;
  } catch (e) {
    throw new BurrowError("decrypt-failed", undefined, { cause: e });
  }
}

/**
 * API-4: values must be JSON. Throws TypeError for anything JSON.stringify
 * would silently change (undefined, functions, Date, Map, NaN, class instances,
 * cycles).
 */
export function assertJson(
  value: unknown,
  path = "value",
  seen = new Set<object>(),
): void {
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (Number.isFinite(value)) return;
      break;
    case "object": {
      if (value === null) return;
      if (seen.has(value)) throw new TypeError(`${path} is circular`);
      seen.add(value);
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++)
          assertJson(value[i], `${path}[${i}]`, seen);
      } else {
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) break;
        for (const [k, v] of Object.entries(value))
          assertJson(v, `${path}.${k}`, seen);
      }
      seen.delete(value);
      return;
    }
  }
  throw new TypeError(`${path} is not a JSON value`);
}
