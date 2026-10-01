# Decisions

Judgement calls made while implementing the brief, and SHOULD/MAY items declined. Each one
names the requirement it touches. Where the brief was ambiguous or self-contradictory, the
reading chosen is the one that best serves the design principles in §1, in their order.

## D-1 Gate 1 passed, so work continued (§0, M0)

§0 says to stop and report at both gates; M0 says to stop *if Gate 1 fails*. Gate 1 passed
(12/12 rules tests, including the chained update, so `hashing.sha256(string).toHexString()`
matches Node/WebCrypto SHA-256 hex). The result was reported and work continued to Gate 2,
where the brief explicitly says to report before continuing.

## D-2 Emulator port is configurable (M0, FS-13)

`firebase/tests/rules.test.mjs` was written verbatim, then changed in one place: it reads
the emulator host from `FIRESTORE_EMULATOR_HOST` (which `firebase emulators:exec` exports)
and falls back to the original `127.0.0.1:8080`. `scripts/emulator.mjs` runs any command
under the emulator and honours `BURROW_EMULATOR_PORT` when 8080 is taken locally.
CI uses the defaults.

## D-3 Sync code layout (KP-11)

`version (1 byte) || root secret (32) || checksum (2)` = 35 bytes = exactly 56 Crockford
base32 characters, shown as 14 groups of 4. The brief's example `L1-2K9F-…` has a
2-character first group, which cannot be both "56 characters" and "blocks of 4"; groups of 4
were kept. The checksum is the first 2 bytes of SHA-256 over `version || secret`. Version
`0x01` marks a random secret, `0x02` a passphrase-derived one (ENC-3). Decoding maps `O→0`,
`I→1`, `L→1`.

## D-4 Item size ceiling is 749,000 bytes, not 900 KB (ENC-4)

The provided rules cap `ct` at 1,000,000 base64url characters, which is 750,000 ciphertext
bytes including the 16-byte GCM tag. An incompressible 900 KB plaintext could never be
stored. The hard ceiling for `maxItemBytes` (and for the manifest) is therefore 749,000
bytes. Compression is applied only when it shrinks the plaintext, so that ceiling always fits.
`seal()` also refuses any envelope whose `ct` would exceed the rules' cap.

## D-5 Tie-break by a hash of the serialised value; manifest entries carry it (SYNC-10)

SYNC-10 breaks equal-`ts` ties by "comparing the serialised value bytewise". The manifest
holds no values, so it cannot apply that order. The manifest would then disagree with the
item documents, and devices whose cached entry matched the manifest's `ts` would never
refetch the winner. Instead, the order is `(ts, h)`, where `h` is the first 16 hex chars of
SHA-256 of the value's JSON serialisation. The manifest entry stores `h` (`{ ts, h }`), so
item documents and the manifest use one deterministic order and replicas converge. A
tombstone sorts above any hash, so a delete wins an exact tie. Property tests cover ties.

## D-6 Item plaintext carries `deleted` (SYNC-12)

`Item.value` is `null` after deletion, but `null` is also a legal stored value. Item
documents therefore carry `deleted: true` when they are tombstones, so a direct item read
(SYNC-7) can tell "deleted" from "set to null" without the manifest.

## D-7 Provider context includes the backend and a small device store (KP-5, KP-9, KP-15)

The passkey provider writes and reads a keyslot through the backend and must cache the
credential id locally. `enrol`/`recover` contexts therefore also receive `backend` and
`store` (a per-device string store). This is additive; custom providers may ignore both,
and the built-ins get no special treatment (KP-15).

## D-8 The cache belongs to one secret; unlink() guards against orphaning (API-8, API-7)

The local cache is stamped with a fingerprint of the secret that owns it: a hash of the
manifest id, not the id itself. `unlink()` leaves the cache and the remote documents intact,
as API-8 requires. The *next* `burrow()` then generates a fresh secret (KP-1), sees the
cache belongs to another secret, and clears that app's cache before use, so a logged-out
user's data does not appear under the new identity. To make this safe, `unlink()` first
tries to push unsynced writes and rejects with `would-orphan` if it cannot, unless
`{ discardLocal: true }` is passed. That makes it symmetric with `link()` (API-7), whose
`would-orphan` check also pushes first when it can.
After `unlink()` the old instance is closed; its methods reject. The would-orphan check
looks at the calling app's unsynced data only.

## D-9 The root secret is per origin; per-app state is per app (KP-4, SYNC-1, SYNC-3)

KP-4 makes one secret serve every app on the origin, so the wrapped secret, the protection
state and provider data live in an origin-wide `_device` object store. Per-app sync state
(`manifestRev`, max remote ts, last sync, the onUnprotected flag) lives in `_meta`, keyed
by app. Items live in one object store per app (`app:<id>`), created by a version upgrade
the first time an app is used. A keyslot is therefore per origin, not per app: the PRF salt
is a fixed library constant. Its AAD prefix is `slotId || "slot"`, used in place of
`id || app` (ENC-5).

## D-10 Cached item rev used optimistically (SYNC-8, SYNC-2)

The cache stores each item's last known `rev` (SYNC-2); `next` is not stored because it
is recomputed from the secret. An item push writes at `rev + 1` directly, and re-reads the
document only on `conflict` (or when no rev is known). That is read-merge-write with a
cached read: a successful put proves nobody wrote since. The manifest is always read
first, because the pass needs its contents for the pull anyway. Costs match FS-11: an
idle pull is 1 read; a push is 1 write per changed item, plus 1 read and 1 write for the
manifest.

## D-11 Storage facade details (API-9..12)

- `getItem` of a value written through the async API returns its JSON text (Storage only
  holds strings); facade writes store strings, as `localStorage` does.
- The facade is a Proxy, so `s.theme`, `s["theme"] = …`, `"theme" in s`, `delete s.theme`
  and `Object.keys(s)` behave as on `localStorage`; method names cannot be shadowed.
- `onChanged` events from facade writes are batched per microtask, and net-zero changes
  (set then removed in one batch) are dropped.

## D-12 Passphrase provider not shipped in v1 (ENC-3, the brief's open decision)

v1 ships random secrets plus sync codes, the brief's stated default. The PBKDF2 path
(`passphraseSecret`, ≥ 600,000 iterations) is implemented and tested but not exported.

## D-13 `onChanged` is an EventTarget with chrome-style helpers (API-5)

`EventTarget<…>` is not a real TypeScript type. `onChanged`, `onStatus` and
`onUnprotected` are `BurrowEvent` objects: real `EventTarget`s (events named `changed`,
`status`, `unprotected`, payload in `event.detail`) that also offer
`addListener`/`removeListener`/`hasListener` like `chrome.storage.onChanged`.

## D-14 `exportCode()` counts as enrolling the sync code (KP-11, KP-14)

The sync-code provider's `enrol()` *is* the export. So calling `exportCode()` on an
unprotected device sets `protection: "code"`, which stops `onUnprotected` from firing
again.

## D-15 `rememberDevice: false` also defaults the cache to memory (KP-8, ENC-10)

On a shared computer, keeping the secret out of storage while leaving the items in
IndexedDB in plaintext would defeat the purpose. With `rememberDevice: false` the cache
defaults to `memory`; an explicit `cache: "indexeddb"` still wins.

## D-16 No backend configured means local-only, not an error (Principle 7)

If no `backend` is passed and no `<meta name="burrow-firestore">` or
`window.BURROW.firestore` exists, `burrow()` still resolves and works locally. It warns
once in the console, and `inspect().backend` is `"none"`.

## D-17 Script-tag build loads the Firestore SDK from a same-origin file (BE-3, SEC-4, SEC-5)

`burrow.min.js` does not inline Firebase. On first use, the Firestore adapter imports
`burrow-firestore.js` from the same directory as the script. That file is a self-hosted,
minified build of `firebase/app` + `firebase/firestore`. No third-party script host is
contacted, and a CSP of `script-src 'self'` suffices. ESM users import the SDK through
their bundler as usual.

## D-18 TypeScript 5.9 for builds

TypeScript 7 (the native port) has no JS API, which the declaration bundler in tsup
needs. The project pins TypeScript 5.9.

## D-19 IndexedDB unavailable → memory cache with status "offline" (SYNC-4)

As the brief says. `status` returns to `idle` after a successful sync pass, because
"offline" otherwise means "the remote is unreachable". `inspect()` reports
`cache: memory` through the debug panel.

## D-20 Clearing `dirty` after a push is conditional on nothing newer (SYNC-5, SYNC-14)

A pass clears `dirty` only for cache entries whose `ts` still equals what it pushed. It
does this in one IndexedDB transaction, so a write from another tab during the pass is
never lost. Reads of the cache that began before a key's latest local write never
overwrite that key in memory. A stress test found a race here, now fixed.

## D-21 Firestore reads go through a transaction (BE-1, FS-8, FS-9)

`getDocFromServer` can be answered from the watch stream of the page's own `onSnapshot`
listener on the same document. That stream may not yet reflect a transaction that just
committed. Live, this made the manifest look missing right after it was written, roughly 40% of
the time. `FirestoreBackend.get` therefore reads with `runTransaction(tx => tx.get(ref))`, which
goes straight to the backend. It costs the same one read. The conformance suite now checks that
a `get` sees a committed `put` at once while subscribed.

## D-22 `link()` waits for any running sync pass (API-7)

A pass started under the old secret must not finish after the identity changes. `link()`
drains the running pass and swaps the secret inside the sync lock. Passes read their keys once,
inside that lock.

## D-23 Live project configuration (FS-10, FS-12)

The shared project `burrow-storage-shared` was created with Firestore's default deny-all rules,
so Gate 2 first failed. With the owner's go-ahead, `firebase/firestore.rules` was deployed through
the Firebase Rules API (ruleset `06220eed-…`). The browser API key was restricted to the Cloud
Firestore API only. **A referrer restriction was not applied:** it depends on where the demo is
hosted, and it would stop the Node-based live checks (`npm run test:live`), which send no Referer.
`setup.sh` applies both when run with `REFERRERS`.

## D-24 Script-tag SDK is a classic script (NF-1, SEC-5)

`burrow-firestore.js` is an IIFE that sets `BurrowFirestoreSdk`, loaded with a `<script>`
element next to `burrow.min.js`. Module `import()` of a `file://` URL is blocked in Chromium, so
an ES module chunk would have broken sync from `file://`. A classic same-origin script works
there and under `script-src 'self'`.

## D-25 Local browser runs: Chromium and Firefox only

This development machine has no root access and lacks the browsers' system libraries. Chromium
and Firefox ran with user-local copies of those libraries. WebKit's launcher replaces
`LD_LIBRARY_PATH`, so it did not run locally. The CI workflow installs system dependencies
(`playwright install --with-deps`) and runs all three engines.

## D-26 Setting an unchanged value is still a write (SYNC-10, API-5)

A property test found that `set({ k: 67 })` on device A, `set({ k: 0 })` on device B, then
`set({ k: 67 })` again on A converged on `0`. A still showed 67, so the third write was dropped as
a no-op, and B's earlier write won. An unchanged `set()` now takes a new timestamp and syncs, so
the last write wins. Only the `onChanged` event is skipped, as in `chrome.storage`. The cost: an
app that re-sets unchanged values causes one write per debounce window.
