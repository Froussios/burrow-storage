# Security

Burrow keeps per-user data in a store that anyone may read by id, yet neither the store's operator
nor the site's developer can read it, and nothing in it names a user. This document is the
normative description of how, and the plain list of what it does not protect. Everything under
*Derivation* and *Formats*, including the passkey token derivation under `burrow/prf-token/v1`
and `burrow/passkey-token/v1`, specifies the current cryptographic contract. Burrow has no
clients, so this contract may change without backward compatibility, a migration path or a major
release required solely for compatibility
([D-55](docs/decisions.md#d-55-no-backward-compatibility-obligation-until-clients-arrive)).
Code, tests, reference vectors and this document must agree after any change. D-57 records the
split into a remote-only core, an optional offline wrapper and an independent passkey token
utility; D-58 records the passkey derivation.

**In brief.** Burrow aims to guarantee that:

- the store, its operator and anyone with a copy of it learn no key names, no values and no user
  identity, only opaque ids, ciphertext, sizes, timing and request IPs;
- nobody without the user's token can write a document the client will accept, and no client
  without it can overwrite one at all, because the store's rules check a per-document write-token
  chain;
- Burrow itself never writes the token, or any key derived from it, to disk, and never sends
  either over the network.

It assumes the user's device, every script on the site's origin, and the code the site serves
are trustworthy, exactly as `localStorage` does, and it runs only in a secure context (HTTPS or
`localhost`), where WebCrypto is available. It does not protect against code running on your
origin, an operator who deletes or rolls back documents, junk that fills a free project's storage,
or the loss of every copy of the token. The optional offline wrapper keeps an **unencrypted** copy
of the data on the device, and a page that keeps the token itself keeps it however it chooses.
Details follow.

**Reporting a vulnerability:** open a private advisory at
<https://github.com/Froussios/burrow-storage/security/advisories/new>. Please do not file a
public issue.

## The one asset

A user's identity is a **storage token** (the *root secret* below): 32 bytes, encoded for people as
56 Crockford base32 characters. Each app derives its own keys from it (D-54), so one token gives
every app its own documents. Burrow never makes one up: the app supplies it to `burrow()`, having
obtained it

- from `generateToken()`, 32 bytes from `crypto.getRandomValues` (KP-1);
- from a passkey, through `passkeyToken({ app }).create()` or `.get()`, which derive it from the
  passkey's PRF output and store nothing (D-58); or
- from the user or the app's own storage: typed, pasted, kept in a password manager, or kept by
  the page.

`burrow()` decodes the string (rejecting `bad-token` on a checksum or length mismatch), derives the
app's keys as non-extractable `CryptoKey`s, and zeroises the decoded bytes. From then on the core
holds only those keys, in memory, until `close()` drops them; it does not keep the token. The
passkey utility zeroises the PRF output and the derived secret once it has encoded the token.

The token crosses the site's own code as that encoded string, before `burrow()` and wherever the
site keeps it. JavaScript strings cannot be zeroised, so the string lives until the garbage
collector reclaims it, like any password the page handles. **Custody of the token belongs to the
app** (D-57): neither the core nor the offline wrapper persists it, and neither stores a wrapped
copy beside a key that unwraps it. A page that keeps the token across visits, as the demo's
"stay signed in" does in `localStorage`, makes that copy readable to anything that can read the
browser profile and to every script on the origin. The documentation says so where it shows it.

Burrow never sends the token or a derived key over the network, never writes them to IndexedDB,
`localStorage`, `sessionStorage`, cookies or the URL, and logs nothing.

## Derivation (v1)

```
ikm      = root secret (32 bytes)
prk      = HKDF-Extract(SHA-256, salt = "burrow/v1", ikm)
pathKey  = HKDF-Expand(prk, "path" || app, 32)
encKey   = HKDF-Expand(prk, "enc"  || app, 32)        AES-256-GCM, every document of the app
macKey   = HKDF-Expand(prk, "auth" || app, 32)        HMAC-SHA-256, write tokens
base     = base64url(SHA-256(pathKey))[0:43]                    manifest id
docId(k) = base64url(HMAC-SHA-256(pathKey, "item" || k))[0:43]  item id for key k

Passkey token (D-58; WebAuthn PRF evaluated with input "burrow/prf-token/v1"):
prf      = the credential's PRF output for that input (32 bytes)
ikm      = HKDF(SHA-256, salt = "burrow/passkey-token/v1", ikm = prf, info = app, 32)
token    = the storage-token encoding of ikm

Local copy name (the offline wrapper; a fingerprint, not a key; D-8, D-57):
identity = hex(SHA-256("owner:" || base))[0:16]
```

`||` is concatenation of UTF-8 bytes; `app` matches `/^[a-z0-9-]{1,64}$/`. WebCrypto's HKDF
performs extract and expand in one `deriveBits` call. Test vectors produced by an independent
implementation (`node:crypto`, `scripts/gen-vectors.mjs`) are committed in `test/vectors.json`,
and the unit tests check the WebCrypto code against them.

The authenticator evaluates PRF as HMAC over SHA-256(`"WebAuthn PRF"` || 0x00 || input) with a
secret only it holds, so the output is fixed for a credential and input and unknown to anyone
without the credential. The passkey token is therefore deterministic per credential and app: the
same credential gives an app the same token on every device where that credential is available
and PRF works, and different apps get unrelated tokens from the same credential. The PRF output
itself is never used as a key; HKDF separates it from any other use.

A token derived from something the user types (a passphrase) would have to pass through
PBKDF2-SHA-256 with at least 600 000 iterations first. v1 has no such path and accepts only
version byte `0x01`; the storage-token encoding reserves `0x02` for a passphrase-derived token,
and v1 rejects it as `bad-token`.

## Formats

Every live encrypted document, whether manifest or item, is an envelope. The store cannot tell
them apart. An owner-operated content cleanup may replace an inactive document with
`{ x: true, rev, next }`, retaining its occupied id and token-chain commitment (D-48).

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
  `id || app || String(rev)`. Because `id` is a fixed 43 characters and `app` only ever pairs with
  the ids derived for it, the concatenation is unambiguous. A document copied to another id,
  another app or another revision fails to decrypt.
- **Manifest plaintext** (id `base`): `{ v: 1, items: { [key]: { ts, h?, deleted? } } }`, the
  user's key directory. Key names exist only here, encrypted. `h` is a 16-hex-character hash of
  the value used to break timestamp ties deterministically.
- **Item plaintext** (id `docId(key)`): `{ v: 1, key, value, ts, deleted? }`.

Manifest and item plaintext is UTF-8 JSON, compressed with deflate-raw when it is over 64 bytes
and compression shrinks it. An item document is capped at 200 000 bytes of JSON, well under the
749 000 that always fit the store's 1 000 000-character limit even when incompressible.

Any decryption failure surfaces as `decrypt-failed`: the core rejects the call; the offline
wrapper stops remote work for that instance and leaves its local copy untouched.

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
concurrency: a stale writer gets `conflict`, re-reads and merges.

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

## Data on the device

**The core keeps nothing on disk** (D-57). It holds the derived keys and what it last read in
memory; closing the page or calling `close()` drops them. Other libraries on the page may keep
records of their own; none may hold Burrow data. The Firebase SDK, for one, keeps a heartbeat
record in IndexedDB (`firebase-heartbeat-database`) with SDK version strings, dates, the Firebase
app name (which contains the project id) and the site's app id, the same for every user. It runs
with its default in-memory cache, so it writes no documents to disk.

**No document path reaches the disk.** A document's path (`burrow/<id>`) is a stable pseudonym:
whoever finds one in a profile can link that device to the user's documents in the store, see
when they change and how large they are, though not read them. The SDK sends paths only in
request bodies (POST) and receives them in the streamed responses of its Listen channel; the
URLs carry the project and database only. The browser tests (`test/e2e/browser.spec.ts`) check
both layers in each engine: the core leaves no Burrow database, no Web Storage and no cookies,
and no script-visible storage or file in the browser's own profile directory (HTTP cache,
history, session restore) contains the token, a document id seen on the wire, or, with the core
alone, a key name or value. They run under the Firestore emulator, whose response headers can
differ from production; extensions, proxies and network logs outside the browser are not
covered.

**The offline wrapper keeps an unencrypted copy** (`burrow-storage/offline`). Items, their
versions and the sync state of one app and one token live in an IndexedDB database named
`burrow:<app>:<identity>`, where `identity` is the 64-bit fingerprint above: it names the copy and
cannot open or write anything. Key names and values are stored **in plaintext**, protected only
by the device and the browser, like `localStorage`. The token and the derived keys are never
written; the wrapper does not need them to read or write its copy, so it works offline after a
start with the token. Each token has its own copy, so switching tokens on a device never shows
one identity's data under another or drops another identity's unsynced writes; copies of earlier
identities stay on disk until the app calls `forget()` for them. `forget()` deletes the database;
IndexedDB backups, logs and the file system may still hold old data, so it is not secure erasure.
Encrypting the copy is deliberately not part of this design: any key that opens it without a
prompt would have to sit beside it.

## Optional content expiry (D-48)

The offline wrapper renews content as the app is used, about every 30 days per app, token and
device: listed item documents first, manifest last, without advancing logical item timestamps.
The receipt is recorded only on full success. The core alone renews nothing; only its own writes
refresh their documents' server write time. The optional owner reaper uses **server**
`Document.updateTime`, never client envelope `ts`, for its 395-day inactivity cutoff and exact
conditional whole-document replacement. A concurrent write changes that server timestamp and
makes the old precondition fail. It skips permanent stubs and emits only counts/fixed error codes.
Private operator-cache cursors must never be published.

Stubs retain `rev` and `next`: creates/replays at the occupied id fail and an update still needs
the token chain at R+1. The backend atomically refuses ordinary writes to stubs; an explicit
`replaceExpired` opt-in is available to authenticated custom callers. This is an inactivity
policy, not a hard maximum age or a ban on legitimate renewal. A token holder can extend it.
The flag is owner-created availability metadata; clients cannot create stub-shaped requests
under the reference rules. The rules continue to validate normal requests against the stored
chain, so updated clients are required to enforce the ordinary-write opt-in gate. No v2
ciphertext format or timestamp trust gate is introduced.

The core rejects `expired` when it meets a stub. The offline wrapper then pauses remote work for
the instance and keeps its local copy and unsynced writes. Independent item writes already
committed before a later expiry cannot be rolled back. Neither layer automatically republishes
an expired identity. Older clients may decrypt-fail or authentically rewrite a stub. The store
holds no token-access documents to exclude: there are no keyslots (D-58).

Only a dedicated content target is eligible for this reaper. The operator explicitly
acknowledges this boundary. The locked, private daily budget/cache bounds this operator's
requests across invocations sharing it; it cannot reserve quota against other clients, and
permanent stub/index storage and junk creation remain costs. No TTL, paid billing, backend-owned
app scheduling or identity migration is enabled. See [retention.md](docs/retention.md) for the
public promise, limits and operation.

## Threat model

The store is public, the network is hostile, and the developer is trusted to serve honest code
but not trusted with the data: neither the developer's store nor its operator should be able to
read it.

| Threat | Mitigation |
| --- | --- |
| Store dump (operator, breach, subpoena) | Ids are keyed hashes; contents are AES-GCM ciphertext; no user identifier is stored anywhere. |
| Enumeration | `list` denied; 256-bit id space. |
| An id leaks (URL, logs) | Reading it yields ciphertext only; writing needs the token chain. Burrow logs nothing, and error causes are scrubbed of anything that looks like an id. |
| Overwrite or vandalism of a known id | Hash-chained tokens; `rev` must advance by exactly one. |
| Replay of an old document | `id`, `app` and `rev` are GCM additional data; the store rejects `rev ≤ current`. |
| Brute force of a weak typed secret | Tokens are random 256-bit or PRF-derived; a passphrase would have to go through PBKDF2 ≥ 600 000 (not in v1). |
| Malicious script on the site (XSS, bad CDN) | **Out of scope**, as for `localStorage`: a script on your origin can use an open store, read the offline copy, and read the token wherever the page keeps it. Use a strict CSP and SRI; Burrow runs without `eval`, inline scripts or third-party script hosts when self-hosted. |
| Copied browser profile | **Core only:** nothing of the user's is on disk. **Offline wrapper:** the copy's key names and values are readable in plaintext; the token and keys are not there, so the copy alone cannot read anything else from the store or write to it. **A page that keeps the token** (the demo's "stay signed in") gives a copied profile the token itself: lasting read-write access to everything, since tokens cannot be revoked or rotated. |
| Junk writes to the shared project | Anyone who knows the project id can create documents. Daily read and write quotas reset, so traffic abuse only pauses sync and can never produce a bill on Spark. **Stored bytes (1 GiB) do not reset**: the rules forbid delete, so only the project owner can remove junk, from the console or with the Admin SDK. Accepted for prototypes. Optional inactivity cleanup shrinks old content ciphertext but leaves permanent stubs; it does not bound ongoing junk creation or solve squatting. Burrow has no built-in defence: the Firestore adapter creates its own Firebase app instance, so a site cannot attach Firebase App Check to it today. |
| Lost token | Not recoverable by design: Burrow keeps no copy anywhere. A passkey reproduces its token wherever that passkey is available and supports PRF; losing the passkey loses that route, and a new passkey gives a new token. Keep the token string too, for example in a password manager. The offline copy is not a backup: browsers may evict it (Safari after seven days without interaction; others under disk pressure). |
| Compression side channel | Ciphertext length reveals how compressible the plaintext was. Irrelevant for a user's own settings; there is no switch to disable compression in v1. |
| Operator rollback or deletion | Rules bind clients, not the project's owner: through the console or the Admin SDK the owner (or Google) can delete a document, restore an older one, or write garbage. A restored document still decrypts, and clients write on top of it at the next revision. Garbage fails to decrypt (`decrypt-failed`). Availability and freshness depend on the operator; confidentiality does not. |

**What the store still learns:** how many documents exist, their sizes, when and how often each
is written, and the client IP of each request. One user's documents are not linkable to each
other except by timing. Key names and values are never visible.

## Passkeys (D-58)

- `passkeyToken()` creates discoverable credentials with `residentKey: "required"`,
  `userVerification: "required"`, no attestation, the PRF extension, and a **random** 16-byte user
  handle, so `create()` never replaces an existing passkey: each call is a new credential and a
  new token. `user.name` is the site's `userName`, or the app id; `displayName` defaults to it.
  Neither enters the derivation, and both are visible to the authenticator or password manager.
- A passkey is not a secret store. WebAuthn does not let a page put a chosen value into a
  credential and read it back, except through the `largeBlob` extension, whose support varies by
  browser, authenticator and passkey provider; Burrow does not use it. The token is derived, so
  the passkey and the token are not interchangeable: the token can be written down and used
  without the passkey, but the passkey cannot be recreated from the token.
- WebAuthn reports a dismissed prompt, a timeout and "no matching passkey" as the same
  `NotAllowedError`, on purpose; all reject `cancelled`. An authenticator without PRF rejects
  `prf-unsupported`. A new credential that turns out to have no PRF is useless; where the browser
  offers `PublicKeyCredential.signalUnknownCredential()`, the utility tells the provider so it can
  remove it. No result is ever a null or empty token.
- Some authenticators return the PRF output at creation; others need one assertion, a second
  prompt. If that prompt is dismissed, the passkey exists and `get()` later returns its token.
- Whether a passkey, and its PRF, reaches another device depends on the passkey provider (for
  example iCloud Keychain or Google Password Manager), not on Burrow. Burrow's browser tests
  exercise Chromium's virtual authenticator only; the support notes in
  [sync-and-tokens.md](docs/sync-and-tokens.md#passkeys) are third-party reports, not
  measurements.

## What Burrow does not do

- It contacts no host other than the configured backend, collects no telemetry, logs nothing,
  and loads no remote scripts. The script-tag build loads the Firestore SDK from
  `burrow-firestore.js` in the same directory as `burrow.min.js`; self-host both so that
  directory is your own origin.
- It does not register service workers or patch globals.
- It does not generate, recover or store a token on its own, and it has no online token backup.
