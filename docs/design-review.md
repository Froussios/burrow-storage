# Design review of the Burrow requirements

Reviewed: `docs/requirements.md` (snapshot of the requirements doc at rev 79, 2026-10-01).
Reviewer: Claude, at the request of the repo owner, before implementation starts.

**Verdict.** The core design is sound: a capability secret deriving unguessable per-document ids,
AES-GCM envelopes with id and revision bound as AAD, a per-document hash-chain write token that
Firestore rules can verify with SHA-256 alone, an encrypted manifest for key discovery under a
`list`-denied collection, and per-key last-writer-wins with tombstones. Nothing in it is broken in a
way that needs a redesign. There are, however, four contradictions between requirements, a handful of
underspecified encodings that would make two implementations diverge, two behaviours that would
silently waste store quota, and one claim in the threat model that overstates what the browser
gives us. Each item below has a severity, the evidence, and the resolution the implementation plan
adopts. Items marked **needs owner decision** change a MUST in the spec; the plan proceeds with the
stated default unless the owner overrules it in the tracking issue.

Severity scale: **S1** would produce wrong or lost data, or a security gap · **S2** would waste quota,
block a requirement, or make implementations incompatible · **S3** editorial drift, no behaviour change.

## 1. Contradictions between requirements

| # | Sev | Where | Problem | Resolution adopted |
|---|---|---|---|---|
| C1 | S2 | KP-7 vs KP-7 itself and API-1 | `available()` MUST "feature-detect without prompting" but is also told to return false "when `create()` returns no `prf.enabled`". Calling `create()` prompts the user and, worse, mints a credential on their authenticator that cannot be removed. | `available()` checks only `PublicKeyCredential`, `isUserVerifyingPlatformAuthenticatorAvailable()` and, where present, `getClientCapabilities()["extension:prf"]`. The `prf.enabled` check happens inside `enrol()`, which rejects with `prf-unsupported`. See architecture §8.2. |
| C2 | S2 | KP-3 vs API-7 | KP-3 says `link()` falls back to generating a fresh secret (KP-1) if no provider yields one; API-7 says `link()` rejects with `no-provider`. | API-7 wins. `link()` never generates; the device already has a secret from `burrow()`. A rejected `link()` leaves the device exactly as it was. |
| C3 | S1 | KP-13 vs SEC-1 | KP-13 allows carrying the sync code in a URL fragment; SEC-1 forbids writing the secret to the URL. A fragment lands in browser history on the receiving device and in any screenshot or share sheet. | Fragment transport is out of v1. QR codes carry the plain sync code, which the receiving page passes to `link({ code })`. Recorded as decision D7. |
| C4 | S3 | Terminology vs KP-11 | Terminology describes the sync code as "e.g. 20 base32 characters"; KP-11 specifies 56 characters (1 + 32 + 2 bytes). The KP-11 example `L1-2K9F-…` also starts with a 2-character group although groups are 4. | 56 characters in 14 groups of 4 is correct and is what we build. Terminology row is stale. |

## 2. Gaps that would make implementations diverge

| # | Sev | Where | Problem | Resolution adopted |
|---|---|---|---|---|
| G1 | S1 | ENC-5 | AAD is `docId \|\| app \|\| String(rev)` with no separator. `app` may end in a digit (`[a-z0-9-]`), so `("app1", rev 2)` and `("app", rev 12)` produce the same AAD. The binding is weaker than intended. | AAD is the UTF-8 of `` `${id}|${app}|${rev}` ``; `\|` is outside the app charset. Keyslot AAD is `` `${slotId}|slot` ``. Architecture §5.3. |
| G2 | S2 | ENC-7 | `tok(id, n) = HMAC(macKey, id \|\| n)` does not say how `n` is encoded, and `next = SHA-256(tok)` does not say whether the hash is over the 32 raw bytes or the base64url text. The rules hash the text they receive, so the client must hash the text. | `n` is its decimal ASCII form; the HMAC input is UTF-8 of `` `${id}:${n}` ``. `next` is lowercase hex of SHA-256 over the UTF-8 of the base64url `tok` string. Test vectors are committed. Architecture §5.4. |
| G3 | S2 | ENC-4 vs FS rules | The plaintext "hard ceiling" of 900 KB cannot pass the rules: 900 KB of incompressible plaintext becomes ~1.2 M base64url characters, and the rule caps `ct` at 1 000 000 characters. | The ceiling is enforced on the encoded envelope, not the plaintext: `ct.length ≤ backend.capabilities.maxEnvelopeBytes` (Firestore: 1 000 000). The plaintext hard ceiling becomes 700 000 bytes, which encodes to at most ~933 400 characters. `maxItemBytes` default stays 200 000. Architecture §5.5. |
| G4 | S1 | KP-1, KP-4, API-7, API-8 | The root secret is per origin and shared by every app (KP-4), but `link()` and `unlink()` are called on one app's area. Nothing says what happens to the other apps' caches, which now hold data belonging to a secret the device no longer has, and nothing says what `link()` does to the current app's clean (synced) items. | The wrapped secret is stored once per origin together with a fingerprint `fp = base64url(SHA-256("fp" \|\| rootSecret))[0:16]`. Every app cache records the `fp` it was filled under. `burrow()` wipes and re-pulls a cache whose `fp` differs from the current secret's. `link()` wipes the current app's cache (clean items are re-pulled; dirty items are the `would-orphan` case). Architecture §6.3. |
| G5 | S1 | SYNC-5 | "Items first, manifest last" is right, but dirty-clearing is unspecified. If `dirty` is cleared when the item document lands, a crash before the manifest write leaves the item unlisted forever. If it is cleared only after the manifest write, every retry rewrites the item document and burns a write and a revision. | Two-stage flag: `dirty = 2` (item document not written), `dirty = 1` (written, not yet in the manifest), `dirty = 0`. A retry after a crash writes only the manifest. Architecture §7.2. |
| G6 | S2 | KP-5 | `user.id` for the WebAuthn credential is not specified, and `user.name` defaults to the app name although the credential is per origin and shared by all apps. PRF evaluation at `create()` time is not supported on every platform that supports it at `get()` time. | `user.id` is 16 random bytes stored with the credential id; `user.name` defaults to `location.hostname`. `enrol()` evaluates PRF during `create()` when the result is present and otherwise performs one immediate `get()` (two prompts on older platforms). Architecture §8.2. |
| G7 | S2 | API-4 | "Structured-cloneable JSON value" is two different sets. `Date` and `Map` are structured-cloneable; `NaN` is a number but not JSON. | Values are JSON values: `null`, booleans, finite numbers, strings, arrays and plain objects of those. `undefined` properties are dropped as `JSON.stringify` does. Anything else throws `TypeError`. Architecture §4.3. |
| G8 | S3 | API-9 vs API-3 | The facade is string-only and the area is JSON-typed, but both address the same keys. `getItem` after `set({ a: 1 })` is undefined. | `getItem` returns the value itself when it is a string and `JSON.stringify(value)` otherwise. `setItem` stores a string. Architecture §4.5. |
| G9 | S3 | API-2 | Same `app`, different config in a second `burrow()` call. | Return the existing instance and log a warning in debug mode. |
| G10 | S3 | BurrowConfig | `debug` (NF-3, ERR-3) and a way to pass the Firestore config directly are missing from the config type. | Added `debug?: boolean`. The Firestore adapter takes its config from its constructor, the `<meta>` tag or `window.BURROW`, in that order. |
| G11 | S2 | SYNC-2 | Caching `next` per item is unnecessary: `tok(id, n)` for any `n` is computable from `macKey`, so only `rev` is needed. | Cache `rev` only. Fewer bytes, one less thing to get out of sync. |

## 3. Behaviours that would waste quota or lose data

| # | Sev | Where | Problem | Resolution adopted |
|---|---|---|---|---|
| Q1 | S1 | KP-1 + `rememberDevice: false` | With nothing persisted, every page load generates a fresh secret and "begins syncing under it immediately". A user who never calls `protect()` creates an orphan manifest and item documents on every visit, and loses their data on every visit too. | With `rememberDevice: false` and no secret in memory, `burrow()` resolves **unlinked**: memory cache, `linked === false`, `status === "offline"`, no secret generated and no network traffic until `link()` succeeds. Writes work locally. `BurrowArea.linked` is added to the API. **Needs owner decision**, default adopted. |
| Q2 | S2 | FS-8, FS-11 | A `runTransaction` put is one read plus one write, so the stated push cost ("1 write per changed item plus 1 for the manifest") is understated by one read per document. The Firestore rules already enforce `rev == stored + 1` atomically per document, which is exactly the compare-and-swap BE-1 needs. | Blind write first: the adapter writes the envelope and lets the rules arbitrate. Only on `permission-denied` does it read the document to classify the failure as `conflict` (stored rev ≠ expected) or `unauthorized`. Happy-path cost is one write per document. Verified by a concurrency test in the conformance suite against the emulator. Decision D3. |
| Q3 | S2 | SYNC-6 | Polling the manifest every 30 s while visible is 2 880 reads per day per open tab, against a shared 50 000. | Adaptive interval: start at `syncIntervalMs`, double after each pull that found nothing, cap at 5 min, reset to base on any local write, focus or remote change. Architecture §7.4. |
| Q4 | S1 | FS-7 | Storage exhaustion is not a daily-reset quota. Anyone who knows the project id can create 1 000 documents of 1 MB each and fill the 1 GiB Spark allowance permanently; rules forbid delete, so only the owner's admin script can reap. The spec's "worst case sync pauses" is true for reads and writes but not for storage. | Accepted for v1 with honest documentation: SECURITY.md names it, the setup guide ships an owner-run reaper script (admin SDK, documents untouched for 12 months, FS-6), and App Check with reCAPTCHA is listed as the optional hardening for a site that is being abused. |
| Q5 | S2 | SYNC-5 | `fetch` with `keepalive: true` is limited to 64 KB of in-flight body per page. Large items cannot be flushed on unload that way. | On `pagehide` the engine flushes the manifest and any dirty items whose envelope is under 32 KB with keepalive; larger items stay dirty and go on the next page load. Documented in the Offline row of the NF table. |

## 4. Threat-model claims to soften

| # | Sev | Where | Problem | Resolution adopted |
|---|---|---|---|---|
| T1 | S2 | ENC-10, threat table row "Copied IndexedDB" | "A copied database is not enough to derive any id or key" overstates it. A non-extractable `CryptoKey` is non-extractable through WebCrypto, but browsers persist its material in the profile directory; Chromium protects it with OS-level encryption on some platforms, Firefox does not. The wrapping is a real obstacle to casual copying, not a cryptographic guarantee. | SECURITY.md says so in those words. The design stays: it costs nothing and it is the best the platform offers without a passkey on every load (`rememberDevice: false`). |
| T2 | S3 | ENC-4 | Compress-then-encrypt leaks plaintext compressibility through `ct` length. Irrelevant to a single-user settings store with no attacker-controlled plaintext mixed in, but it should be stated. | Noted in SECURITY.md. Compression stays on by default; `compress: false` is a config option for sites that store attacker-influenced strings next to secrets. |
| T3 | S3 | ENC-1 | Item key names are hidden, but the store still sees document count, sizes and write times. Documents of one user are not linkable to each other except by timing. | Noted in SECURITY.md under "What the store learns". |
| T4 | S3 | Status table | A mistyped sync code that passes the 16-bit checksum (1 in 65 536) does not produce `decrypt-failed`; it derives a different `base` and finds an empty vault. `decrypt-failed` can only arise from corruption or a derivation-version mismatch. | Status table row reworded. `link()` additionally rejects with `bad-code` when the recovered secret has no manifest **and** no keyslot anywhere, since a code that was exported must have had at least a manifest. |

## 5. Changes to MUST requirements that need the owner's sign-off

The plan proceeds with these defaults. Tracked in the "Confirm design-review decisions" issue.

| # | Spec says | Plan does | Why |
|---|---|---|---|
| D1 | FS-3: the adapter MUST use the modular Firebase JS SDK | The reference adapter talks to the **Firestore REST API with `fetch`** and has no SDK dependency. An SDK-based adapter with `onSnapshot` subscribe is a follow-up. | The SDK is ~100 KB gzipped against a 12 KB library; REST gives `keepalive` for unload flushes (SYNC-5), which the SDK cannot; no `initializeApp` collision with a site's own Firebase; security rules apply identically to REST. Cost: no `subscribe`, so v1 polls (mitigated by Q3). |
| D2 | SYNC-1: one IndexedDB object store per app | One `items` store with compound key `[app, key]` and one `state` store keyed by app | Creating a store per app needs a `versionchange` upgrade on first use of every new app, which is blocked while any other tab has the database open. A key-range delete gives the same isolation without the upgrade dance. |
| D3 | FS-8: put MUST use `runTransaction` | Blind write, rules arbitrate, read only to classify a rejection (Q2) | Halves the happy-path cost; BE-1 still holds because a single-document write and its rules evaluation are atomic in Firestore. |
| D4 | ENC-3: typed passphrases through PBKDF2 | No passphrase provider in v1; ENC-3 remains the rule a custom provider must follow | Random secrets plus codes are the decided default; PBKDF2 in core is dead weight until someone needs it. Resolves the first open question. |
| D5 | ENC-10: wrap with AES-KW | Wrap with AES-GCM under a non-extractable 256-bit key | AES-KW wraps `CryptoKey` objects, so the 32 raw bytes would have to masquerade as an HMAC key to be unwrapped and exported. AES-GCM over the raw bytes is the same security with a straight code path. |
| D6 | API: `onChanged: EventTarget<…>` | A small typed emitter with `addListener`/`removeListener`/`hasListener`, as `chrome.storage.onChanged` has | `EventTarget` is not generic and dispatches `Event` objects; the chrome shape is what a `chrome.storage` port expects. |
| D7 | KP-13: sync code MAY travel in a URL fragment | Not in v1 (C3) | Secret in history. |
| D8 | — | Add `linked: boolean`, `unsupported` error code, `compress` option | Q1, SYNC-4, T2 |

## 6. Editorial drift (fix in the source doc, no behaviour change)

- ENC-3 cites "KP-2" for typed sync codes; KP-2 is now device persistence. Should cite KP-11 and KP-15.
- Threat table: "Enumeration of vaults" cites FS-4 (should be FS-5); "Weak typed secret" cites KP-2 (should be KP-1, KP-11, ENC-3); "Abuse of the shared store" cites FS-6, FS-10 (should be FS-7, ENC-4, FS-11).
- Test plan: "KP-9/10" for derivation vectors should be ENC-7, ENC-11; "FS-12 matrix" should be FS-13; "SYNC-9..SYNC-12" for merge should be SYNC-10..SYNC-13.
- Rules `shape()` should also require `z` to be `true` when present: `(!('z' in d) || d.z == true)`.
- The architecture diagram caption still says "Locket".
- KP-9 (cache the credential id for `allowCredentials`) only helps when `rememberDevice: false`, because in every other case the cache survives exactly as long as the secret does. Keep it, but say so.

## 7. Things I checked and found correct

- `base64url` of 32 bytes without padding is exactly 43 characters, so `[0:43]` is a no-op and `path.size() == 43` in the rules is right. A 12-byte IV is 16 characters. Hex SHA-256 is 64.
- The rules functions used (`hashing.sha256`, `Bytes.toHexString()`, `String.lower()`, `Map.keys().hasOnly()`) all exist in rules language v2. The emulator spike (issue WP-00) confirms the hex casing before anything depends on it.
- The create rule accepting any first write at an unused id is safe for confidentiality and integrity: an attacker cannot compute an id that a real user will later use (256-bit HMAC under a secret key), and squatting a random id affects nobody.
- Writing items before the manifest means a reader never fetches an item older than the manifest entry that pointed at it; it may fetch a newer one, which is harmless.
- Item documents are only ever written by holders of the same secret, so item conflicts come from the same user's two devices and the LWW merge is well defined. Manifest conflicts are the common case and are resolved by merging the two key maps, which is a commutative union under LWW.
- Tombstone pruning after 30 days plus "clean key absent from manifest ⇒ delete locally" gives the acceptance criterion "stale device C does not resurrect": C's key is clean, so it is removed. A dirty key on C after 30 days is a genuine edit and is allowed to win.
- Re-creating a key whose document was overwritten with `null` continues that document's chain at `rev + 1`; the blind-write path handles it (create fails, read, retry as update).
- Firestore document ids made of `A-Za-z0-9-_` never collide with the reserved `.`/`..`/`__x__` forms.
- The 20 K writes/day Spark cap is shared by every app and user on the project. A pull with no changes costs one read; the plan's adaptive polling keeps an idle tab at ~290 reads/day.
- Spark has no billing account, so exhausting a quota returns `RESOURCE_EXHAUSTED` and can never produce a bill. That is still true in 2026.
- `file://` is a secure context in all target browsers, so WebCrypto and IndexedDB are available there; WebAuthn is not, as NF-1 says. CORS from a `null` origin to `firestore.googleapis.com` is confirmed by the spike.
