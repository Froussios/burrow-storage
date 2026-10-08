# Security

Burrow keeps per-user data in a store that anyone may read by id, yet neither the store's operator
nor the site's developer can read it, and nothing in it names a user. This document is the
normative description of how, and the plain list of what it does not protect. Everything under
*Derivation* and *Formats* is frozen public contract for v1: changing any of it is a major release
with a migration path.

**In brief.** Burrow aims to guarantee that:

- the store, its operator and anyone with a copy of it learn no key names, no values and no user
  identity, only opaque ids, ciphertext, sizes, timing and request IPs;
- nobody without the user's secret can write a document the client will accept, and no client
  without the secret can overwrite one at all, because the store's rules check a per-document
  write-token chain;
- the secret leaves the device only when the user carries it.

It assumes the user's device, every script on the site's origin, and the code the site serves
are trustworthy, exactly as `localStorage` does, and it runs only in a secure context (HTTPS or
`localhost`), where WebCrypto is available. It does not protect against code running on your
origin, a copied browser profile, an operator who deletes or rolls back documents, junk that fills
a free project's storage, or the loss of every copy of the secret, whether by the user or by the
browser evicting storage. Details follow.

**Reporting a vulnerability:** open a private advisory at
<https://github.com/Froussios/burrow-storage/security/advisories/new>. Please do not file a
public issue.

## The one asset

A user's identity is a **storage token** (the *root secret* below): 32 bytes from
`crypto.getRandomValues`, generated silently the first time an app runs on a device. One token
serves every Burrow app on the origin; each app derives its own keys from it. The token leaves the
device only when the user carries it:

- typed or pasted, encoded as 56 Crockford base32 characters (`exportToken()`, `link()`), or
- wrapped inside a **passkey keyslot** in the store, which only that passkey's PRF output can
  unwrap (`burrow-storage/passkey`).

Between the store and a backup, the token crosses the site's own code as that encoded string:
`exportToken()` returns it and `link({ token })` takes it, and the passkey backup's `save()` and
`restore()` take and return it too. JavaScript strings cannot be zeroised, so the string lives
until the garbage collector reclaims it, like any password the page handles. The store's own copy
stays wrapped as described below, and the passkey backup zeroises the raw bytes and the PRF output
it derives from the string.

On the device the token is kept in IndexedDB wrapped with AES-KW under a non-extractable
`CryptoKey`, and in memory only in that wrapped form; it is unwrapped for the duration of one
operation and the copy is zeroised afterwards. With `rememberDevice: false` nothing is persisted.
Burrow never sends the token or any derived key over the network, never writes them to
`localStorage`, `sessionStorage`, cookies or the URL, and never logs them. Every key derived from
the token (`pathKey`, `encKey`, `macKey`, the keyslot keys) is imported non-extractable; the one
extractable WebCrypto object is the short-lived HMAC "vehicle" key that carries the raw token
through `wrapKey`/`unwrapKey`.

## Derivation (v1)

```
ikm      = root secret (32 bytes)
prk      = HKDF-Extract(SHA-256, salt = "burrow/v1", ikm)
pathKey  = HKDF-Expand(prk, "path" || app, 32)
encKey   = HKDF-Expand(prk, "enc"  || app, 32)        AES-256-GCM, every document of the app
macKey   = HKDF-Expand(prk, "auth" || app, 32)        HMAC-SHA-256, write tokens
base     = base64url(SHA-256(pathKey))[0:43]                    manifest id
docId(k) = base64url(HMAC-SHA-256(pathKey, "item" || k))[0:43]  item id for key k

Passkey keyslot (WebAuthn PRF evaluated with salt "burrow/prf/v1"):
sprk     = HKDF-Extract(SHA-256, salt = "burrow/slot/v1", prfOutput)
kek      = HKDF-Expand(sprk, "kek", 32)               AES-256-GCM, wraps the root secret
slotMac  = HKDF-Expand(sprk, "auth", 32)              HMAC-SHA-256, write tokens for the keyslot
slotId   = base64url(SHA-256(HKDF-Expand(sprk, "slot", 32)))[0:43]
```

`||` is concatenation of UTF-8 bytes; `app` matches `/^[a-z0-9-]{1,64}$/`. WebCrypto's HKDF
performs extract and expand in one `deriveBits` call. Test vectors produced by an independent
implementation (`node:crypto`, `scripts/gen-vectors.mjs`) are committed in `test/vectors.json`,
and the unit tests check the WebCrypto code against them.

A token derived from something the user types (a passphrase) would have to pass through
PBKDF2-SHA-256 with at least 600 000 iterations first. v1 has no such path and accepts only random
tokens (version byte `0x01`); the storage-token encoding reserves `0x02` for a passphrase-derived
token, and v1 rejects it as `bad-token`.

## Formats

Every stored document, whether manifest, item or keyslot, is an envelope. The store cannot tell
the three apart.

```ts
interface Envelope {
  v: 1;
  iv: string;    // 12 random bytes, base64url (16 chars), fresh per write
  ct: string;    // base64url AES-256-GCM(key, iv, plaintext, aad)
  rev: number;   // 0, 1, 2, … per document
  ts: number;    // writer's clock, ms
  tok: string;   // write token for this rev
  next: string;  // hex SHA-256 of the token the next rev must present
  z?: true;      // plaintext was deflate-raw compressed
}
```

- **AAD** binds each ciphertext to where and when it may live: the UTF-8 bytes of
  `id || app || String(rev)` for manifests and items, and `slotId || "slot" || String(rev)` for
  keyslots. Because `id` is a fixed 43 characters and `app` only ever pairs with the ids derived
  for it, the concatenation is unambiguous. A document copied to another id, another app or
  another revision fails to decrypt.
- **Manifest plaintext** (id `base`): `{ v: 1, items: { [key]: { ts, h?, deleted? } } }`, the
  user's key directory. Key names exist only here, encrypted. `h` is a 16-hex-character hash of
  the value used to break timestamp ties deterministically.
- **Item plaintext** (id `docId(key)`): `{ v: 1, key, value, ts, deleted? }`.
- **Keyslot plaintext**: the 32 raw bytes of the root secret, encrypted under `kek`.

Manifest and item plaintext is UTF-8 JSON, compressed with deflate-raw when it is over 64 bytes
and compression shrinks it. An item is capped at `maxItemBytes` (default 200 000 bytes; never above 749 000, so
the ciphertext always fits the store's 1 000 000-character limit even when incompressible).

Any decryption failure surfaces as `decrypt-failed`: sync pauses, the local cache is left
untouched, and `link()` resumes it.

## Write authorisation without accounts

Each document carries its own hash chain of one-time tokens:

```
tok(id, n)  = base64url(HMAC-SHA-256(macKey, id || String(n)))
document at rev n stores  next = hex(SHA-256(tok(id, n + 1)))      (hash over the base64url text)
```

To write revision `n + 1`, a writer presents `tok(id, n + 1)` and commits to
`hex(SHA-256(tok(id, n + 2)))`. The store accepts the write only if `SHA-256(tok) == stored next`
**and** `rev == stored rev + 1`. A token is useless once it is stored, and only the token's holder
can compute the next one. Readers need nothing but the id. The `rev` check also gives optimistic
concurrency: a stale writer gets `conflict`, re-reads and merges. Keyslots use the same scheme
under `slotMac`.

The reference Firestore rules ([`firebase/firestore.rules`](firebase/firestore.rules)) enforce
this. They:

- allow `get` to anyone, because the content is ciphertext;
- deny `list`, because enumeration would turn ids into a directory;
- deny `delete`; removal is a tombstone plus an overwrite;
- allow `create` only at `rev == 0`, with exactly the envelope fields and a 43-character id;
- allow `update` only at `rev == stored + 1`, and only if
  `hashing.sha256(tok).toHexString().lower() == stored next`.

The emulator tests (`firebase/tests/rules.test.mjs`) cover each case, including an `in` query on
ids and a partial update that tries to skip the chain. A backend that cannot enforce the chain
must declare `capabilities.writeAuth = false`, and Burrow warns once in the console.

## Local cache at rest

The cache stands in for `localStorage`, so items are stored in IndexedDB in plaintext, in one
object store per app. The token is stored only wrapped (see above), with its wrapping key beside
it. The cache is stamped with a
fingerprint of the token that owns it; after `unlink()`, or when another app on the origin links
a different token, the next `burrow()` finds the stamp wrong and clears the app's cache before use,
so one identity's data never shows under another. Use `rememberDevice: false` on shared computers;
the cache then defaults to memory.

## Threat model

The store is public, the network is hostile, and the developer is trusted to serve honest code
but not trusted with the data: neither the developer's store nor its operator should be able to
read it.

| Threat | Mitigation |
| --- | --- |
| Store dump (operator, breach, subpoena) | Ids are keyed hashes; contents are AES-GCM ciphertext; no user identifier is stored anywhere. |
| Enumeration | `list` denied; 256-bit id space. |
| An id leaks (URL, logs) | Reading it yields ciphertext only; writing needs the token chain. Burrow never logs ids, and error causes are scrubbed of anything that looks like one. |
| Overwrite or vandalism of a known id | Hash-chained tokens; `rev` must advance by exactly one. |
| Replay of an old document | `id`, `app` and `rev` are GCM additional data; the store rejects `rev ≤ current`. |
| Brute force of a weak typed secret | Tokens are random 256-bit; a passphrase would have to go through PBKDF2 ≥ 600 000 (not in v1). |
| Malicious script on the site (XSS, bad CDN) | **Out of scope**, as for `localStorage`: a script on your origin can read the cache and call `exportToken()`. Use a strict CSP and SRI; Burrow runs without `eval`, inline scripts or third-party script hosts when self-hosted. |
| Copied browser profile | The wrapped token is **an obstacle, not a guarantee**. The AES-KW key that wraps it is stored beside it in IndexedDB. "Non-extractable" stops a script from exporting that key; it does not stop someone who copies the browser's profile directory, where the key material lives with the rest of IndexedDB. Treat a copied profile as a copied token. `rememberDevice: false` plus a passkey keeps nothing on disk. |
| Junk writes to the shared project | Anyone who knows the project id can create documents. Daily read and write quotas reset, so traffic abuse only pauses sync and can never produce a bill on Spark. **Stored bytes (1 GiB) do not reset**: the rules forbid delete, so only the project owner can remove junk, from the console or with the Admin SDK. Accepted for prototypes. Burrow has no built-in defence: the Firestore adapter creates its own Firebase app instance, so a site cannot attach Firebase App Check to it today. |
| Lost token | Not recoverable by design. A browser can also lose it: Safari deletes a site's IndexedDB after seven days of Safari use without the user interacting with the site, and other browsers may evict storage under disk pressure (Burrow does not request persistent storage). Burrow offers the storage token, passkey keyslots, JSON export, and `token.source === "generated"` so sites can prompt users to keep a copy. |
| Compression side channel | Ciphertext length reveals how compressible the plaintext was. Irrelevant for a user's own settings; there is no switch to disable compression in v1. |
| Operator rollback or deletion | Rules bind clients, not the project's owner: through the console or the Admin SDK the owner (or Google) can delete a document, restore an older one, or write garbage. A restored document still decrypts, and clients write on top of it at the next revision. Garbage fails to decrypt (`decrypt-failed`, sync pauses). Availability and freshness depend on the operator; confidentiality does not. |

**What the store still learns:** how many documents exist, their sizes, when and how often each
is written, and the client IP of each request. One user's documents are not linkable to each
other except by timing. Key names and values are never visible.

## What Burrow does not do

- It contacts no host other than the configured backend, collects no telemetry, and loads no
  remote scripts. The script-tag build loads the Firestore SDK from `burrow-firestore.js` in the
  same directory as `burrow.min.js`; self-host both so that directory is your own origin.
- It does not register service workers or patch globals.
- `debug: true` logs sync events with revisions, counts, byte sizes and timings only. It never
  logs ids, tokens, keys or values.
- Passkeys use `residentKey: "required"`, `userVerification: "required"` and no attestation. The
  passkey's `user.name` is the app id unless the site supplies a label; it is never an email
  unless the site chooses one.
