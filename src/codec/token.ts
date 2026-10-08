// KP-11/12: the storage token. version (1 byte) || root secret (32) ||
// checksum (2) = 35 bytes = 56 Crockford base32 characters, shown in 14 groups
// of 4.
import { concat, sha256 } from "../bytes.js";
import { BurrowError } from "../errors.js";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/**
 * 0x01: a random root secret (KP-1), the only version v1 accepts. 0x02 stays
 * reserved for a passphrase-derived secret (ENC-3), which is not implemented
 * (docs/decisions.md D-12, D-42).
 */
const TOKEN_VERSION = 0x01;
const SECRET_BYTES = 32;
const TOKEN_CHARS = 56;

async function checksum(body: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  return (await sha256(body)).subarray(0, 2);
}

function toBase32(b: Uint8Array): string {
  let out = "",
    acc = 0,
    bits = 0;
  for (const byte of b) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >>> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

function fromBase32(s: string): Uint8Array {
  const out: number[] = [];
  let acc = 0,
    bits = 0;
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new BurrowError("bad-token");
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
    acc &= (1 << bits) - 1;
  }
  return Uint8Array.from(out);
}

/**
 * Case-insensitive; ignores hyphens and whitespace; reads O as 0 and I/L as 1.
 */
export function normaliseToken(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

export async function encodeToken(secret: Uint8Array): Promise<string> {
  if (secret.length !== SECRET_BYTES)
    throw new RangeError("root secret must be 32 bytes");
  const body = concat(Uint8Array.of(TOKEN_VERSION), secret);
  const raw = concat(body, await checksum(body));
  try {
    return toBase32(raw).match(/.{4}/g)!.join("-");
  } finally {
    body.fill(0);
    raw.fill(0);
  }
}

/**
 * Returns the 32-byte root secret; the caller zeroises it. Rejects bad-token
 * before any network call (KP-12).
 */
export async function decodeToken(input: string): Promise<Uint8Array> {
  if (typeof input !== "string") throw new BurrowError("bad-token");
  const s = normaliseToken(input);
  if (s.length !== TOKEN_CHARS) throw new BurrowError("bad-token");
  const raw = fromBase32(s);
  const body = new Uint8Array(raw.subarray(0, 1 + SECRET_BYTES));
  const sum = await checksum(body);
  try {
    if (sum[0] !== raw[33] || sum[1] !== raw[34] || raw[0] !== TOKEN_VERSION)
      throw new BurrowError("bad-token");
    return body.slice(1);
  } finally {
    raw.fill(0);
    body.fill(0);
  }
}
