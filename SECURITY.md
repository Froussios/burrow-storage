# Security

This file is the SEC-9 deliverable: the cryptographic design in one place, the threat model, and what
Burrow does **not** protect against. It is written for reviewers; the README has the user-facing
version. Status: pre-implementation draft, to be finalised in WP-15 and reviewed externally before 1.0.

## The one asset

A user holds a 32-byte random **root secret**. Everything else the store ever sees is derived from it
through one-way functions or is ciphertext under a key derived from it. Losing the secret loses the
data; Burrow has no reset. Sites must tell users: *"Burrow cannot reset your data. Keep your sync code."*

## Cryptographic design (normative text in `docs/architecture.md` §5 and §8)

| Purpose | Construction |
|---|---|
| Per-app keys | `HKDF-SHA-256(ikm = root, salt = "burrow/v1", info = label ‖ app)` for `pathKey`, `encKey`, `macKey` |
| Document ids | manifest `base = base64url(SHA-256(pathKey))`; item `docId(k) = base64url(HMAC-SHA-256(pathKey, "item" ‖ k))`; 43 chars each |
| Confidentiality and integrity | AES-256-GCM under `encKey`, fresh 96-bit IV per write, AAD `id|app|rev` |
| Write authorisation | Per-document hash chain: document at rev `n` stores `next = SHA-256(tok(id, n+1))`; writer of rev `n+1` presents `tok(id, n+1) = base64url(HMAC-SHA-256(macKey, id:n+1))`. Store checks `SHA-256(tok) == next` and `rev == stored + 1` |
| Compression | deflate-raw before encryption, optional (`compress: false`) |
| Device persistence | root wrapped with AES-256-GCM under a non-extractable `CryptoKey` kept in IndexedDB; `rememberDevice: false` keeps it in memory only |
| Passkey unlock | WebAuthn PRF output → `HKDF(salt "burrow/slot/v1")` → `kek`, `slotMac`, `slotId`; a **keyslot** document holds the root wrapped under `kek`, chained under `slotMac` |
| Sync code | `0x01 ‖ root ‖ SHA-256(0x01 ‖ root)[0:2]` in Crockford base32, 56 chars |

All primitives are WebCrypto. Derived keys are imported non-extractable. The only raw key material
held in JavaScript memory is one copy of the root secret, needed for `exportCode()` and `protect()`.

## Threat model

The store is public (anyone can read any document they can name), the developer is honest but not
trusted with data, the network is hostile, and the user's device is trusted while the user is using it.

| Threat | Mitigation | Status |
|---|---|---|
| Store dump by operator, breach or subpoena | Ids are keyed hashes; contents are AES-GCM ciphertext; no identifiers stored | Mitigated |
| Enumeration of vaults | `list` denied in rules; 256-bit id space | Mitigated |
| Attacker learns an id (logs, leaked URL) | Read yields ciphertext; writes need the token chain | Mitigated |
| Overwrite or vandalism of a known id | Hash-chain tokens; rev must advance by exactly one; rules verify | Mitigated |
| Replay of an old document to an id or revision | `id` and `rev` are GCM AAD; store rejects `rev ≤ current` | Mitigated |
| Cross-document swap (manifest ↔ item, app A ↔ app B) | `id` and `app` in AAD | Mitigated |
| Offline brute force of the secret | 256-bit random; sync codes carry it verbatim (no low-entropy input in v1) | Mitigated |
| Copied IndexedDB from a device | Root is wrapped under a non-extractable key. **This is an obstacle, not a guarantee**: browsers persist key material in the profile; Chromium protects it with OS keyring on some platforms, Firefox does not. A determined attacker with the profile directory may recover the secret. `rememberDevice: false` plus a passkey removes the stored secret entirely | Partially mitigated, documented |
| Malicious script on the site (XSS, compromised CDN) | Out of scope, same as `localStorage`: a script on the origin can read the cache and call `exportCode()`. Use SRI and a strict CSP; Burrow runs under `default-src 'self'` plus the store host | Out of scope |
| Junk writes exhausting the shared store | Per-document size cap; Spark daily read/write caps reset daily so the worst case for *traffic* is "sync pauses". **Storage (1 GiB) does not reset**: anyone who knows the project id can fill it with ~1 000 junk documents, and rules forbid delete, so only the owner can reap (`firestore/reaper.mjs`). Optional hardening: Firebase App Check | Accepted for prototypes, documented |
| Lost secret | Not recoverable by design; sync code, passkey keyslots and JSON export are the user's responsibility | By design |
| Compression side channel | Ciphertext length reveals plaintext compressibility. Irrelevant for a single user's own settings; `compress: false` exists for sites that store attacker-influenced strings | Documented |
| Operator rollback | A store operator can restore an older document version; the client sees a lower `rev` and overwrites. Availability and freshness depend on the operator; confidentiality does not | Out of scope |

## What the store learns

Even with everything working as designed the store sees: the number of documents, their sizes, when
each was written and how often, and the client IP of each request. Documents of one user are not
linkable to each other except by timing correlation. Item key names and values are never visible.

## Reporting

Open a private security advisory on the GitHub repository. Please do not file public issues for
vulnerabilities.
