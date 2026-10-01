# Security

Burrow keeps per-user data in a public store that nobody, including the store's operator and
the site's developer, can read or attribute to a user. This document describes how. Everything
in "Derivation" and "Formats" is frozen public contract for v1. Changing any of it is a major
release with a migration path.

**Reporting a vulnerability:** open a private advisory at
<https://github.com/Froussios/burrow-storage/security/advisories/new>. Please do not file a
public issue.

## The one asset

A user's identity is a **root secret**: 32 bytes from `crypto.getRandomValues`, generated
silently the first time an app runs on a device. One secret serves every app on the origin;
each app gets its own derived keys. The secret never leaves the device except:

- as a **sync code**, which the user carries to another device by hand, or
- wrapped inside a **passkey keyslot**, which only that passkey's PRF output can unwrap.

On the device the secret is stored in IndexedDB, wrapped (AES-KW) under a non-extractable
`CryptoKey`. A copy of the database files without the browser's key store is not enough to
recover it. A script running on the origin can use it, exactly as it could read a session
cookie. With `rememberDevice: false`, nothing is persisted.

Burrow never sends the root secret or any derived key over the network, never writes them to
`localStorage`, `sessionStorage`, cookies or the URL (except a sync-code link the user chooses
to open), and zeroises byte copies after use. Every derived WebCrypto key is non-extractable.

## Derivation (v1)

```
ikm      = root secret (32 bytes)
prk      = HKDF-Extract(SHA-256, salt = "burrow/v1", ikm)
pathKey  = HKDF-Expand(prk, "path" || app, 32)
encKey   = HKDF-Expand(prk, "enc"  || app, 32)        AES-256-GCM, every document of the app
macKey   = HKDF-Expand(prk, "auth" || app, 32)        HMAC-SHA-256, write tokens
base     = base64url(SHA-256(pathKey))[0:43]                    manifest id
docId(k) = base64url(HMAC-SHA-256(pathKey, "item" || k))[0:43]  item id for key k

Passkey keyslot (PRF evaluated with salt "burrow/prf/v1"):
sprk     = HKDF-Extract(SHA-256, salt = "burrow/slot/v1", prfOutput)
kek      = HKDF-Expand(sprk, "kek", 32)               wraps the root secret
slotMac  = HKDF-Expand(sprk, "auth", 32)              write tokens for the keyslot
slotId   = base64url(SHA-256(HKDF-Expand(sprk, "slot", 32)))[0:43]
```

`||` is concatenation of UTF-8 bytes. `app` matches `/^[a-z0-9-]{1,64}$/`. Test vectors
produced by an independent implementation (`node:crypto`) are committed in
`test/vectors.json`, and the unit tests check the WebCrypto code against them.

A secret derived from a typed passphrase must first pass through PBKDF2-SHA-256 with at least
600,000 iterations. v1 ships only random secrets, so this path is implemented but not exported.

## Formats

Every stored document, whether manifest, item or keyslot, is an envelope. The store cannot tell
the three apart.

```ts
interface Envelope {
  v: 1;
  iv: string;    // 12 random bytes, base64url, fresh per write
  ct: string;    // base64url AES-256-GCM(key, iv, plaintext, aad)
  rev: number;   // 0, 1, 2, … per document
  ts: number;    // writer's clock, ms
  tok: string;   // write token for this rev
  next: string;  // hex SHA-256 of the token the next rev must present
  z?: true;      // plaintext was deflate-raw compressed
}
```

- **AAD** binds each ciphertext to where and when it may live: `id || app || String(rev)` for
  manifests and items, `slotId || "slot" || String(rev)` for keyslots. A document copied to
  another id, another app or another revision fails to decrypt.
- **Manifest plaintext** (id `base`): `{ v: 1, items: { [key]: { ts, h?, deleted? } } }`, the
  user's key directory. Key names exist only here, encrypted.
- **Item plaintext** (id `docId(key)`): `{ v: 1, key, value, ts, deleted? }`.
- **Keyslot plaintext**: the 32-byte root secret, encrypted under `kek`.

Plaintext is UTF-8 JSON, compressed when that helps. An item is capped at `maxItemBytes`
(default 200,000; never above 749,000 bytes, so the ciphertext always fits the store's 1,000,000
character limit).

Any decryption failure surfaces as `decrypt-failed`. Sync then pauses, and the local cache is
left untouched.

## Write authorisation without accounts

Each document carries its own hash chain:

```
tok(id, n)  = base64url(HMAC-SHA-256(macKey, id || String(n)))
document at rev n stores  next = hex(SHA-256(tok(id, n + 1)))
```

To write revision `n + 1`, a writer presents `tok(id, n + 1)` and commits to
`hex(SHA-256(tok(id, n + 2)))`. The store accepts the write only if
`SHA-256(tok) == stored next` **and** `rev == stored rev + 1`. A token is useless once it is
stored, and only the secret's holder can compute the next one. Readers need nothing but the
id. The `rev` check also gives optimistic concurrency: a stale writer gets `conflict`, re-reads
and merges.

The reference Firestore rules ([`firebase/firestore.rules`](firebase/firestore.rules)) enforce
this. They:

- allow `get` to anyone, because the content is ciphertext;
- deny `list`, because enumeration would turn ids into a directory;
- deny `delete`; removal is a tombstone plus an overwrite;
- allow `create` only at `rev == 0`, with exactly the envelope fields and 43-character ids;
- allow `update` only at `rev == stored + 1`, and only if
  `hashing.sha256(tok).toHexString().lower() == stored next`.

The emulator tests (`firebase/tests/rules.test.mjs`) cover each case, including an `in` query on
ids and a partial update that tries to skip the chain. A backend that cannot enforce the chain
must declare `capabilities.writeAuth = false`, and Burrow warns in the console.

## Local cache at rest

The cache stands in for `localStorage`, so items are stored in IndexedDB in plaintext, in one
object store per app. The root secret is stored only wrapped (see above). After `unlink()` the
cache stays until a different secret takes the device over, and is cleared then. Use
`rememberDevice: false` on shared computers; the cache then defaults to memory.

## Threat model

The store is public, the developer is honest but not trusted with data, and the network is
hostile.

| Threat | Mitigation |
| --- | --- |
| Store dump (operator, breach, subpoena) | Ids are keyed hashes; contents are AES-GCM ciphertext; no user identifier is stored anywhere. |
| Enumeration | `list` denied; 256-bit id space. |
| An id leaks (URL, logs) | Reading it yields ciphertext only; writing needs the token chain. Burrow never logs ids, and errors are scrubbed of them. |
| Overwrite or vandalism of a known id | Hash-chained tokens; `rev` must advance by exactly one. |
| Replay of an old document | `id`, `app` and `rev` are GCM AAD; the store rejects `rev ≤ current`. |
| Brute force of a weak typed secret | Secrets are random 256-bit by default; a passphrase must go through PBKDF2 ≥ 600,000. |
| Malicious script on the site (XSS, bad CDN) | Out of scope, as for `localStorage`. Use a strict CSP and SRI (see the README). Burrow runs without `eval`, inline scripts or third-party script hosts. |
| Copied IndexedDB from a device | The secret is wrapped under a non-extractable key; `rememberDevice: false` for shared machines. |
| Abuse of the shared store | Size cap per document, Spark's hard daily quotas, no delete, no list. The worst case is that sync pauses until the daily reset, never a bill. |
| Lost secret | Not recoverable by design. Burrow offers the sync code, passkey keyslots, JSON export, and the `onUnprotected` event so sites can prompt users to keep a copy. |

## What Burrow does not do

- It contacts no host other than the configured backend, collects no telemetry, and loads no
  remote scripts. The script-tag build loads the Firestore SDK from `burrow-firestore.js` on
  the page's own origin.
- It does not register service workers or patch globals.
- `debug: true` logs sync events with revisions, counts, byte sizes and timings only. It never
  logs ids, tokens, keys or values.
- Passkeys use `residentKey: "required"`, `userVerification: "required"` and no attestation. The
  passkey's `user.name` is the app id (or a label the site chooses), never an email unless the
  site supplies one.
