#!/usr/bin/env node
// Regenerates test/vectors.json from an independent implementation (node:crypto, not WebCrypto),
// so the committed vectors cross-check src/codec/derive.ts. Output must never change for v1 (ENC-2).
import { createHash, createHmac, hkdfSync } from "node:crypto";
import { writeFileSync } from "node:fs";

const b64url = (b) => Buffer.from(b).toString("base64url");
const id = (b) => b64url(b).slice(0, 43);
const sha = (b) => createHash("sha256").update(b).digest();
const hmac = (k, d) => createHmac("sha256", k).update(d).digest();
const expand = (ikm, salt, info) => Buffer.from(hkdfSync("sha256", ikm, salt, info, 32));

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

// Sync code: 0x01 || secret || sha256(0x01 || secret)[0:2], Crockford base32, groups of 4.
const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const body = Buffer.concat([Buffer.of(1), rootSecret]);
const raw = Buffer.concat([body, sha(body).subarray(0, 2)]);
let bits = "";
for (const b of raw) bits += b.toString(2).padStart(8, "0");
let code = "";
for (let i = 0; i < bits.length; i += 5) code += A[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];

const itemId = docId("theme");
const v = {
  rootSecretHex: rootSecret.toString("hex"),
  app,
  base,
  docId: { theme: itemId, draft: docId("draft"), "": docId("") },
  tok: { base0: tok(macKey, base, 0), base1: tok(macKey, base, 1), theme7: tok(macKey, itemId, 7) },
  next: { base0: next(macKey, base, 0), theme7: next(macKey, itemId, 7) },
  slot: {
    prfHex: prf.toString("hex"),
    slotId,
    tok0: tok(slotMac, slotId, 0),
    // kek is exercised indirectly: AES-GCM(kek) round trips; record its fingerprint only.
    kekSha256: sha(kek).toString("hex"),
  },
  syncCode: code.match(/.{4}/g).join("-"),
  otherApp: { app: "other", base: id(sha(expand(rootSecret, "burrow/v1", "pathother"))) },
};
writeFileSync(new URL("../test/vectors.json", import.meta.url), JSON.stringify(v, null, 2) + "\n");
console.log(v);
