#!/usr/bin/env node
// Regenerates test/vectors.json from an independent implementation (node:crypto, not WebCrypto),
// so the committed vectors cross-check src/codec/derive.ts. Output must never change for v1 (ENC-2).
// New vectors may be added; they are inserted so that no existing line of the JSON changes.
import { createCipheriv, createHash, createHmac, hkdfSync } from "node:crypto";
import { writeFileSync } from "node:fs";

const b64url = (b) => Buffer.from(b).toString("base64url");
const id = (b) => b64url(b).slice(0, 43);
const sha = (b) => createHash("sha256").update(b).digest();
const hmac = (k, d) => createHmac("sha256", k).update(d).digest();
const expand = (ikm, salt, info) =>
  Buffer.from(hkdfSync("sha256", ikm, salt, info, 32));

const rootSecret = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const app = "test-app";
const pathKey = expand(rootSecret, "burrow/v1", "path" + app);
const macKey = expand(rootSecret, "burrow/v1", "auth" + app);
const base = id(sha(pathKey));
const docId = (k) => id(hmac(pathKey, "item" + k));
const tok = (key, i, n) => b64url(hmac(key, i + String(n)));
const next = (key, i, n) => sha(tok(key, i, n + 1)).toString("hex");

const prf = Buffer.alloc(32, 0xa5);
const kek = expand(prf, "burrow/slot/v1", "kek");
const slotMac = expand(prf, "burrow/slot/v1", "auth");
const slotId = id(sha(expand(prf, "burrow/slot/v1", "slot")));

// Sync code: version || secret || sha256(version || secret)[0:2], Crockford base32, groups of 4.
const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function syncCode(secret, version = 1) {
  const body = Buffer.concat([Buffer.of(version), secret]);
  const raw = Buffer.concat([body, sha(body).subarray(0, 2)]);
  let bits = "";
  for (const b of raw) bits += b.toString(2).padStart(8, "0");
  let code = "";
  for (let i = 0; i < bits.length; i += 5)
    code += A[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return code.match(/.{4}/g).join("-");
}

const itemId = docId("theme");

// A key outside ASCII: precomposed Greek, a CJK character, an astral-plane emoji and spaces.
const UNICODE_KEY = "κλειδί 鍵 🔑";

// The write-token chain of one document, n = 0..5: tok(id, n) and the commitment next(id, n).
const chainOf = (key, i) =>
  Array.from({ length: 6 }, (_, n) => ({
    n,
    tok: tok(key, i, n),
    next: next(key, i, n),
  }));

// A second root secret: SHA-256 of a fixed label, unrelated in structure to the first.
const root2 = sha(Buffer.from("burrow test vector root 2"));
const pathKey2 = expand(root2, "burrow/v1", "path" + app);
const macKey2 = expand(root2, "burrow/v1", "auth" + app);
const base2 = id(sha(pathKey2));
const docId2 = (k) => id(hmac(pathKey2, "item" + k));

// A decrypt-only envelope: the item document for "theme" under the first root secret, rev 3,
// AES-256-GCM with AAD = id || app || String(rev). Real envelopes use a fresh random iv per write
// (ENC-5); this one uses a FIXED iv so the output stays stable. The plaintext is under 64 bytes,
// so seal() would not compress it either (no `z`).
const encKey = expand(rootSecret, "burrow/v1", "enc" + app);
const envRev = 3;
const envTs = 1_700_000_000_000;
const envPlaintext = JSON.stringify({
  v: 1,
  key: "theme",
  value: "dark",
  ts: envTs,
});
const envIv = Buffer.from("000102030405060708090a0b", "hex");
const gcm = createCipheriv("aes-256-gcm", encKey, envIv);
gcm.setAAD(Buffer.from(itemId + app + String(envRev), "utf8"));
const envCt = Buffer.concat([
  gcm.update(envPlaintext, "utf8"),
  gcm.final(),
  gcm.getAuthTag(),
]);

const v = {
  rootSecretHex: rootSecret.toString("hex"),
  app,
  base,
  docId: {
    theme: itemId,
    [UNICODE_KEY]: docId(UNICODE_KEY),
    draft: docId("draft"),
    "": docId(""),
  },
  tok: {
    base0: tok(macKey, base, 0),
    base1: tok(macKey, base, 1),
    theme7: tok(macKey, itemId, 7),
  },
  next: { base0: next(macKey, base, 0), theme7: next(macKey, itemId, 7) },
  slot: {
    prfHex: prf.toString("hex"),
    slotId,
    tok0: tok(slotMac, slotId, 0),
    // kek is exercised indirectly: AES-GCM(kek) round trips; record its fingerprint only.
    kekSha256: sha(kek).toString("hex"),
  },
  syncCode: syncCode(rootSecret),
  unicodeKey: UNICODE_KEY,
  // Write tokens for the manifest (id = base) of the first root secret.
  chain: chainOf(macKey, base),
  root2: {
    rootSecretHex: root2.toString("hex"),
    base: base2,
    docId: {
      theme: docId2("theme"),
      [UNICODE_KEY]: docId2(UNICODE_KEY),
      "": docId2(""),
    },
    // Write tokens for the item document of "theme".
    chain: chainOf(macKey2, docId2("theme")),
    syncCode: syncCode(root2),
  },
  envelope: {
    key: "theme",
    plaintext: envPlaintext,
    env: {
      v: 1,
      iv: b64url(envIv),
      ct: b64url(envCt),
      rev: envRev,
      ts: envTs,
      tok: tok(macKey, itemId, envRev),
      next: next(macKey, itemId, envRev),
    },
  },
  otherApp: {
    app: "other",
    base: id(sha(expand(rootSecret, "burrow/v1", "pathother"))),
  },
};
writeFileSync(
  new URL("../test/vectors.json", import.meta.url),
  JSON.stringify(v, null, 2) + "\n",
);
console.log(v);
