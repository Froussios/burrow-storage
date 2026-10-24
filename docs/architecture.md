# Architecture

How the implementation is put together, for contributors. It describes the code as it is in
`src/`; the public contract is in [api.md](api.md) and the cryptographic design in
[SECURITY.md](../SECURITY.md). Requirement ids in code comments (`API-3`, `SYNC-10`, `KP-5`, …)
refer to [history/requirements.md](history/requirements.md); decision ids (`D-5`) to
[decisions.md](decisions.md). The split into three layers is D-57.

Contents: 1 Layers and files · 2 Runtime shape · 3 Start-up · 4 Data model · 5 Core reads and
writes · 6 The offline wrapper · 7 Merge rules · 8 Tabs · 9 Tokens and the passkey utility ·
10 Backends · 11 Build and packaging · 12 Tests and CI · 13 Known gaps

## 1. Layers and files

```
site code ──► offline(store) (optional)      ── plaintext copy in IndexedDB, per app and token
   │               │ internal seam: pull · push · renew · watch
   ├──► burrow({ app, backend, token }) ─► Core (src/core.ts): keys · codec · push/publish
   │                                           └ Backend (the swappable seam)
   │                                               └► firestore · memory · yours
   └──► passkeyToken({ app }) (optional) ──► WebAuthn PRF → token string → back to the site
```

Each layer is independent of the ones it does not wrap. The core imports the codec, the merge
functions and `config.ts`; the offline wrapper (`src/offline.ts`) imports the core's internal
seam, the caches and the merge functions; the passkey utility (`src/passkey.ts`) imports only the
codec, `bytes.ts` and `errors.ts`. The site moves the token between the utility and the core as a
string; neither layer knows how it was obtained. Nothing in the core names a concrete backend
except the built-in `firestore` factory in `config.ts`.

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Public entry of `burrow-storage`: `burrow()`, `generateToken()`, re-exports |
| `src/core.ts` | `Core implements BurrowStorage`: key derivation, reads, writes, the push and manifest publication, the internal seam for the wrapper, shared helpers (`prepareWrites`, `tombstones`, `pick`) |
| `src/offline.ts` | `burrow-storage/offline`: `offline(store)`, the network-first wrapper with its plaintext copy, replay, renewal and tab coordination |
| `src/passkey.ts` | `burrow-storage/passkey`: `passkeyToken()`, a token derived from a passkey's PRF output |
| `src/config.ts` | Backend selection: `registerBackend`, `configuredBackend`, `validateBackend`, and the page-config readers `readBackendConfig`, `readFirestoreConfig` |
| `src/iife.ts` | Entry of `burrow.min.js`: global `Burrow` (core, `offline`, `passkeyToken`, `FirestoreBackend`), plus the loader that fetches `burrow-firestore.js` on demand |
| `src/types.ts` | Every public interface; `src/errors.ts` the two error classes and `scrub()`; `src/events.ts` `BurrowEvent` |
| `src/codec/derive.ts` | HKDF derivation, document ids, write tokens, the passkey token secret; `codec/envelope.ts` seal/open with AES-GCM and deflate, and `assertJson`; `codec/token.ts` the storage-token encoding |
| `src/cache/types.ts` | The wrapper's `Cache` interface; `cache/indexeddb.ts` and `cache/memory.ts` implement it |
| `src/sync/merge.ts` | Pure merge functions: `compare`, `mergeDirectories`, `nextTs`, `valueHash` |
| `src/backends/memory.ts`, `backends/firestore.ts`, `backends/firestore-sdk.ts` | The backends; `firestore-sdk.ts` is the slice of the Firebase SDK the adapter uses |
| `src/bytes.ts` | UTF-8, base64url, hex, SHA-256, random bytes, `zeroise` |
| `firebase/` | `firestore.rules`, `firebase.json`, the rules tests (`tests/`) |
| `scripts/` | `burrow-setup.mjs` (the `burrow-setup` bin), `burrow-reaper.mjs`, `emulator.mjs`, `serve.mjs`, `build-demo.mjs`, `size.mjs`, `sri.mjs`, `gen-vectors.mjs` |
| `demo/` | The static demo page (strict CSP), with both sign-in modes |
| `test/` | `unit/`, `property/`, `conformance/`, `e2e/`, `smoke/`, `support/`, `vectors.json` |

## 2. Runtime shape

**`Core`** holds, in memory only:

- the derived **app keys** (`AppKeys`: `base`, `pathKey`, `encKey`, `macKey`), all
  non-extractable; `close()` drops them, and every later call rejects `closed`;
- the **identity**, `hex(SHA-256("owner:" + base))[0:16]`, a fingerprint that names the wrapper's
  copy and opens nothing;
- `#known`, what this instance last read or wrote of each key (value, version, revision): the
  in-memory content cache that lets `get()` skip unchanged items and writes skip a read (D-10);
- `#unlisted`, item results written but not yet listed in a published manifest;
- `#maxRemoteTs` (SYNC-11) and the last manifest revision seen;
- `#writes`, a promise chain that sends this instance's writes to the store in call order.

There is no environment object, timer, listener or channel: each `burrow()` call is an
independent instance, and nothing is shared between them except the backend's store.

The **internal seam** (`Remote` in `src/core.ts`) is what the wrapper builds on: `pull(keys,
have)`, `push(entries, { fresh, ifPresent })`, `renew(local)`, `watch(onChange, onExpired)`,
`identity`, `app` and `closed`. `Core.create` registers it in a module-private
`WeakMap`; `remoteOf(store)` looks it up. The store object and the public types do not expose
it (D-57), and the wrapper refuses anything without one.

**`Offline`** (`src/offline.ts`) is created against an **`OfflineEnv`**: the host services it
needs (`openCache`, `channel`, `locks`, `win`, `doc`, `online()`, `waitMs`). The page's env uses
IndexedDB, `BroadcastChannel`, `navigator.locks`, `window`, `document` and `navigator.onLine`,
with `waitMs` 3 000 ms. Tests build their own to simulate several devices and tabs in one process
(`test/support/devices.ts`). It holds the `Cache`, the copy's metadata, the status and error,
whether remote work is paused, the keys this tab knows to be dirty, the keys with a fresh write
in flight, the retry and hidden timers, the manifest subscription, and the tab channel.

## 3. Start-up

**`burrow(config)`** (`Core.create`):

1. Validate `app` (`/^[a-z0-9-]{1,64}$/`) and the presence of `backend`, else `TypeError`.
2. `decodeToken(config.token)`: `bad-token` on any length, alphabet, version or checksum
   problem. Derive the app keys, then zeroise the decoded bytes (SEC-1).
3. Resolve the backend: an instance is checked structurally (`validateBackend`); a config selects
   a registered factory, which may load its adapter on demand. An unregistered type or a
   malformed instance is a `TypeError`; a factory that throws becomes a fixed
   `BurrowError("backend", "backend configuration failed")` with no cause, so configuration
   values cannot escape. Page config is never read here; a site that wants it passes
   `readBackendConfig()`.
4. Warn once if the backend declares `writeAuth: false` (ENC-9). Compute the identity, register
   the seam, resolve. No network call has been made.

**`offline(store)`** (`Offline.create`):

1. Look up the seam (`TypeError` if `store` did not come from `burrow()`, or is already
   wrapped; `closed` if it was closed).
2. Open the cache for `(app, identity)`. If IndexedDB cannot be opened, fall back to
   `MemoryCache` with status `"offline"` (SYNC-4, D-19).
3. Read the copy's metadata and note which keys are dirty. Status is `"offline"` if the browser
   reports no network.
4. Listen for `online`, `offline` and `visibilitychange`; open
   `BroadcastChannel("burrow:<app>:<identity>")`; subscribe to the manifest if the backend can;
   note use for renewal; start a background sync if unsynced writes are waiting. Resolve. Only
   the device has been read.

## 4. Data model

### 4.1 Remote: envelopes

Every live encrypted document in the store is an `Envelope` (`{ v, iv, ct, rev, ts, tok, next,
z? }`). Two kinds share the format and are indistinguishable to the store:

| Kind | Id | Plaintext | Chain key | AAD |
| --- | --- | --- | --- | --- |
| Manifest | `base` | `{ v: 1, items: { key: { ts, h?, deleted? } } }` | `macKey` | `base ‖ app ‖ rev` |
| Item | `docId(key)` | `{ v: 1, key, value, ts, deleted? }` | `macKey` | `id ‖ app ‖ rev` |

`seal()` compresses plaintexts over 64 bytes with deflate-raw when that shrinks them, encrypts
with a fresh 12-byte IV, computes `tok(id, rev)` and `next = hex(SHA-256(tok(id, rev + 1)))`, and
refuses a `ct` over 1 000 000 characters. `open()` reverses it and turns every failure into
`decrypt-failed`. Derivation details and constants: [SECURITY.md](../SECURITY.md).

An optional owner cleanup replaces inactive content with a permanent `ExpiredStub`
(`{ x: true, rev, next }`). `StoredDocument = Envelope | ExpiredStub` is the backend read/watch
contract; normal client writes remain unchanged envelopes (D-48).

### 4.2 Local: the offline wrapper's copy

One IndexedDB database per app and token, `burrow:<app>:<identity>`, at version 1:

| Object store | Key | Value |
| --- | --- | --- |
| `items` | item key | `CachedItem { value?, ts, h?, deleted?, dirty?, rev? }`, in plaintext |
| `meta` | `"meta"` | `AppMeta { maxRemoteTs, lastSyncAt, renewAt }` |

Nothing token-derived is stored except the identity in the database name. A database per
identity needs no version upgrades when apps or tokens are added, and `forget()` deletes it
whole (`IdbCache.destroy`; another tab's open connection closes on `versionchange`).
`updateItems(keys, fn)` is a single read-modify-write transaction and reports each key's entry
before and after, which is what lets a sync and a concurrent write from another tab coexist
without clobbering (D-20), and what `onChanged` is computed from.

`dirty: true` marks an item whose latest local write has not been confirmed in the manifest.
`h` is filled at write time, so every local entry can be compared inside a transaction. `rev` is
the last known revision of the item's remote document; `next` is never stored because tokens are
recomputable from `macKey` (D-10). The core does not use the `Cache`; its `#known` map has the
same entry shape.

### 4.3 Limits

| | Value | Where |
| --- | --- | --- |
| Item | 200 000 bytes of `{v, key, value, ts}` JSON (`MAX_ITEM_BYTES`) | `prepareWrites` in `core.ts` |
| Ciphertext | `MAX_CT_CHARS = 1_000_000` base64url characters | `seal()`, both backends, the rules |
| Manifest plaintext | 749 000 bytes (`HARD_MAX_PLAINTEXT`), else `item-too-large` ("manifest is full") | `#publish` |
| Tombstone retention | 30 days (`TOMBSTONE_TTL_MS`) | `merge.ts` |
| Conflict retries | 3 per document. Manifest: after 200, 800 and 3000 ms. Item: at once, then after 200 and 800 ms. Jitter ×0.75–1.25 | `CONFLICT_BACKOFF` |
| Wrapper wait for the store | 3 000 ms (`waitMs`), then answer from the copy | `#attempt` |
| Wrapper network/quota backoff | 2 s doubling, capped at 5 min | `#failed` |
| Listener detach | after 5 hidden minutes | `HIDDEN_DETACH_MS` |

## 5. Core reads and writes

Every public call runs through `#call()`, which rejects `closed` after `close()` and maps any
failure to a `BurrowError` (`fromBackend`, API-13): `backend` for network and unauthorised
errors, `quota`, `conflict`, `item-too-large`, `expired`, `decrypt-failed`.

**`get(keys)`** (`#pull`). Named keys: compute their ids and fetch the item documents directly
(SYNC-7), one read each. All keys: read the manifest, fetch only the items whose listed version
is newer than what `#known` holds, and answer from the listing (plus `#unlisted`). A missing
manifest is an empty store. Any expiry stub met rejects `expired`; any document that does not
decrypt or belong to its key rejects `decrypt-failed`. Values are `structuredClone`d out, and
object-form keys supply defaults.

**`set(items)`** validates everything first (`prepareWrites`: `TypeError` for non-JSON values,
`item-too-large` for oversize items; nothing is written if any key fails), stamps each item
`nextTs(now, known ts, maxRemoteTs)`, and pushes them as **fresh** writes. **`remove(keys)`**
pushes fresh tombstones with `ifPresent`, so deleting a key the store does not have writes
nothing. **`clear()`** reads every key and removes the live ones (SYNC-12). Writing an unchanged
value still writes (D-26).

**`#push(entries, { fresh, ifPresent })`** writes each item with `#pushItem`, then lists them with
`#publish`. Items are written **before** the manifest, each on its own chain, so a reader never
fetches an item older than the manifest entry pointing at it.

`#pushItem` writes at `known rev + 1` with the known rev as the precondition (D-10). With no known
rev, or on `conflict`, it reads the document first:

- a **fresh** write is stamped above the remote version (`nextTs(ts, remote ts, maxRemoteTs)`),
  so it wins as the latest write; a fresh delete of an already-deleted item is a no-op;
- otherwise (a queued write the wrapper replays) the versions are compared with `compare`; if
  the remote one wins, it is returned as the result instead of writing (last writer wins);
- a delete with `ifPresent` of a missing document returns `null`; any other delete creates the
  tombstone document, so an older write elsewhere cannot later resurrect the key;
- during renewal the winning payload is rewritten at the next revision without changing its
  logical version.

It retries conflicts up to three times. Ordinary puts atomically refuse a stored stub; the core
never opts into replacing one.

**`#publish`** merges every pending result, this push's and earlier unlisted ones, into the
manifest: read it, merge with `mergeDirectories` (normal 30-day tombstone pruning), write at
`rev + 1`, retry conflicts with backoff. A result from an earlier attempt or an earlier call that
the directory does not list is read again first: another device may have overwritten it with a
deletion that has already been pruned from the manifest, and re-listing the old result would
resurrect it (D-46). If everything pending is already listed at the same version, nothing is
written. If publication fails, the results stay in `#unlisted` and the next push lists them; the
call rejects.

## 6. The offline wrapper

The wrapper keeps the same interface and adds `onChanged`, `status`, `onStatus`, `syncNow()` and
`forget()`. Its choices are D-59.

### 6.1 Network first

**`get(keys)`**: if the store is reachable, `#pull(keys)` asks the core for the named keys (or the
manifest and the changed items) and merges the answer into the copy (§7). The call waits for that
up to `waitMs`, then answers from the copy either way; a pull still in flight lands later and
emits `onChanged`.

**`set(items)` and `remove(keys)`** validate and stamp like the core, then write the copy first:
each entry is stored `dirty`, re-stamped inside the transaction above anything another tab wrote
meanwhile, and `onChanged` (`local`) fires. That is the durable point (API-6, SYNC-9). Then, if
reachable, the entries are pushed as fresh writes, again for up to `waitMs`. While that push is
in flight, a pull never replaces those keys (`#fresh`), so a remote version stamped by a fast
clock cannot overwrite a write the user just made before it is restamped. `remove()` writes local
tombstones only for keys the copy shows; the others are pushed with `ifPresent` when reachable
and dropped otherwise, as `chrome.storage` ignores unknown keys. **`clear()`** pulls the whole
listing first when reachable, then removes every key the copy shows.

**Reachable** means: remote work is not paused, no retry is pending, and the browser does not
report itself offline. Otherwise calls use the copy at once and do not touch the network.

### 6.2 Replay and background sync

`#replay(keys, fresh)` pushes dirty entries under the Web Lock
`burrow:<ns>:<app>:<identity>:sync`: the named keys as fresh writes after `set()`/`remove()`, or
every dirty entry with its own timestamp in a background sync. It then settles each key in one
transaction: if the entry is still the one that was sent, it becomes the remote result (clean,
with its revision and possibly a new timestamp); if a newer local write arrived meanwhile, that
one stays dirty and learns the revision (D-20). A result that differs visibly from the local
value (a remote write won) emits `onChanged` (`remote`).

`#sync(pull)` is the background pass: replay every dirty entry, renew if due (§6.4), and with
`pull` refresh the whole copy. Callers coalesce onto the running pass. It runs from:

| Trigger | Pull? |
| --- | --- |
| `syncNow()` | yes |
| the retry timer after a failure | yes |
| the window's `online` event | yes |
| the page becoming visible (SYNC-6) | yes |
| a manifest change notified by the backend (FS-9), other than this instance's own | yes |
| start-up with unsynced writes, a successful call with unsynced writes left, renewal due | no |

There is no polling and no focus trigger.

### 6.3 Failure handling (`#failed`)

| Error | Effect |
| --- | --- |
| `decrypt-failed`, `expired` | `status: "error"`; remote work pauses for this instance (the subscription is dropped too). The copy and unsynced writes are untouched; reads and writes use the copy. |
| `conflict`, `item-too-large` | `status: "error"`; items stay dirty; retried on the next write or sync. |
| anything else (`quota`, `backend`) | `status: "offline"` with that error; retry timer with exponential backoff; items stay dirty. |
| `closed` | the core was closed; the wrapper closes too. |

`onStatus` fires on every change of the `(status, error)` pair. A successful background sync
sets `"idle"`; so does a successful read or write outside one. `syncNow()` rejects with the error
when the status ends `"error"` or `"offline"`.

### 6.4 Use-driven renewal and optional owner cleanup

Using the wrapper (open, `get`, `set`, `remove`, `clear`, `syncNow`) requests renewal when the
copy's `renewAt` has passed; the request runs in a background sync. Under the sync lock the
deadline is re-read from the shared copy, so tabs renew once between them. `renew()` in the core
reads the manifest, fetches every listed item, including retained deletion markers, and rewrites
them without changing their logical versions, then rewrites the manifest. A listed live document
that is missing is rewritten from the local copy; with no local copy the pass fails with a
backend error and records nothing. On success `renewAt` becomes now plus 29–30 days. Failure or
observed expiry leaves the copy, its dirty data and the deadline intact, though earlier
independent item writes may already exist. The core alone never renews (D-59): only its own
writes refresh their documents.

After deletion is pruned from the manifest, the unlisted item document can later become an
expiry stub while the rest of the account remains live. An ordinary `set()` cannot replace that
stub: the push meets it, the call stays local and remote work pauses with `expired`, preserving
every entry and unsynced write. A named `get()` of that key also meets it and pauses, answering
from the copy. Manifest absence grants no replacement authority to new or queued writes.

`scripts/burrow-reaper.mjs` is optional owner maintenance outside CI, not a browser dependency or
an app scheduler. It selects an explicit dedicated content target, scans with a three-field
mask and private paginated checkpoint, and conditionally replaces eligible documents using
exact server `updateTime`. A locked 0600 operator cache reserves daily reads/attempted writes
before requests across targets/reruns in the same project. Skipped stubs still cost scan reads;
other clients' quota and permanent stored bytes are not bounded by this ledger. See
[retention.md](retention.md).

### 6.5 Forget and close

`forget()` first tries a sync when unsynced writes exist; if some remain, it rejects
`would-orphan` unless `discardLocal` is true. It then tells the other tabs, closes, and deletes the
database. `close()` stops timers, listeners, the subscription and the channel, closes the cache
connection and closes the core it wraps.

## 7. Merge rules (`src/sync/merge.ts`)

- Order on `(ts, h)`: higher `ts` wins; on equal `ts` a tombstone (`h = "~"`) beats any value,
  and otherwise the greater value hash wins. `h` is the first 16 hex characters of the SHA-256 of
  the JSON serialisation, stored in the manifest so that every replica applies the same order
  without holding the values (D-5).
- `mergeDirectories(a, b, now)` keeps the winner per key and drops tombstones older than 30
  days. The manifest publication and the pull comparison both use `compare`.
- `nextTs(now, previous, maxRemoteTs)` = `max(now, previous + 1, maxRemoteTs + 1)`.
- A pull merges into the wrapper's copy in one transaction per batch: a remote entry newer than
  the local one replaces it, dirty or not (the dirty write lost by last-writer-wins), unless a
  fresh write of that key is in flight; an older or equal remote entry only teaches the local
  entry its revision. After a full pull, a clean local key missing from the listing is removed;
  a dirty one is kept and pushed. A key the store has no document for is kept as it is, since the
  copy may be the only one left. With no manifest at all, nothing is pruned.

Property tests in `test/property/merge.test.ts` simulate devices with skewed clocks, offline
periods, tombstone expiry and random operation sequences, both with writes queued until a sync
and network first, and assert convergence.

## 8. Tabs

Tabs of one app and token share the IndexedDB copy, so a read in any tab sees every tab's writes.
They talk over `BroadcastChannel("burrow:<app>:<identity>")`:

| Message | Sent when | Receiver does |
| --- | --- | --- |
| `{ t: "changed", changes, source }` | after a local write or after remote changes reached the copy | emits `onChanged` with the same changes and source |
| `{ t: "forget" }` | in `forget()`, before the database is deleted | closes itself |

There is no leader election: any tab may replay or renew, serialised by the Web Lock. Without
`navigator.locks` they are not serialised across tabs (the store still arbitrates every write, so
the cost is duplicate requests, not lost data); without `BroadcastChannel` tabs do not hear of
each other's writes, though reads still see them. The core has no tab behaviour: each tab's
instances talk to the store independently.

## 9. Tokens and the passkey utility

The core takes the token as a string and keeps only the keys derived from it (§3); there is no
`SecretHolder`, no persisted token and no `link()`. `generateToken()` encodes 32 bytes from
`crypto.getRandomValues` and zeroises them.

**`passkeyToken({ app, … })`** (`src/passkey.ts`, `burrow-storage/passkey`) never touches the core
or a backend and keeps no state (D-58). The app id is checked at construction (`TypeError`).

- `available()`: a secure context, `PublicKeyCredential` and `navigator.credentials` exist,
  `getClientCapabilities()` does not report `extension:prf: false`, and
  `isUserVerifyingPlatformAuthenticatorAvailable()`. It never prompts.
- `create()`: `credentials.create` with a discoverable credential, user verification, ES256/RS256,
  no attestation, the PRF extension with input `burrow/prf-token/v1`, a random 16-byte
  `user.id`, `rp.name` from the option or the page's host, `user.name` from the option or the app
  id, and the canonical effective RP ID (the explicit `rpId` or current hostname, lowercase
  ASCII/IDNA; invalid syntax is a `TypeError` before prompting). If the result reports neither PRF
  output nor `prf.enabled`, it calls `PublicKeyCredential.signalUnknownCredential()` where present
  and rejects `prf-unsupported`. If PRF is enabled without output, one `credentials.get` for that
  credential follows.
- `get()`: a discoverable `credentials.get` (the browser's account picker) with the same PRF input.
- Both turn the PRF output into the app's token with `derivePasskeySecret` (HKDF, salt
  `burrow/passkey-token/v1`, info `app`) and `encodeToken`, zeroising the output and the secret.
  `NotAllowedError` and `AbortError`, or a `null` credential, reject `cancelled`; any other
  credential error, or missing PRF results, rejects `prf-unsupported`.

## 10. Backends

`Backend` is six members (`id`, `capabilities`, `get`, `getMany?`, `put`, `subscribe?`), see
[extending.md](extending.md) for the contract. The core uses `capabilities.writeAuth` (warn) and,
through `watch()`, `capabilities.subscribe` (whether the wrapper can subscribe).

**`MemoryBackend`** keeps a `Map<id, StoredDocument>` and enforces the rules exactly: well-formedness
(`wellFormed()` mirrors `shape()` in the rules file), create at rev 0, update at `rev + 1`, and
`SHA-256(tok) == next`. Subscribers are notified on a microtask. Several instances sharing one
map simulate several devices; `failWith` makes every call fail, for tests.

**`FirestoreBackend`** (`burrow-storage/firestore`) wraps the modular Firebase SDK:

- `#connect()` loads the SDK through `loadSdk` (a dynamic `import("./firestore-sdk.js")`, replaced
  in the script-tag build by a `<script>` loader for `burrow-firestore.js`), initialises an app
  named `burrow:<projectId>` (so it never collides with a site's own Firebase app), and connects
  the emulator when configured. Constructing the adapter loads nothing, so `burrow()` resolves
  offline.
- `get` runs `runTransaction(tx => tx.get(ref))` rather than `getDoc`, because a plain read can be
  served from the page's own `onSnapshot` stream and report a revision older than a transaction
  that just committed (D-21).
- `put` runs a transaction that reads, compares `rev` with `expectedRev`, atomically checks the
  stored expiry flag unless explicit replacement was requested, and sets the normal envelope;
  `permission-denied` is re-classified as `conflict` when a fresh read shows a different revision.
- `subscribe` is `onSnapshot` on one document, ignoring snapshots with pending local writes.
- Errors map `resource-exhausted` → `quota`, `permission-denied` → `unauthorized`,
  `invalid-argument` → `too-large`, everything else → `network`.
- The SDK keeps a heartbeat record of its own in IndexedDB (`firebase-heartbeat-database`: SDK
  versions, a date and the Firebase app name); Burrow cannot turn it off (§13).

**Rules** (`firebase/firestore.rules`) are summarised in [firestore-setup.md](firestore-setup.md)
and tested in `firebase/tests/rules.test.mjs` under the emulator.

## 11. Build and packaging

`tsup.config.ts` produces three builds:

| Output | Entry | Notes |
| --- | --- | --- |
| `dist/index.js`, `dist/offline.js`, `dist/passkey.js`, `dist/firestore.js`, `dist/setup-check.js` (+ `.d.ts`, maps) | `src/index.ts`, `src/offline.ts`, `src/passkey.ts`, `src/backends/firestore.ts`, `src/setup/check.ts` | ESM, `firebase/*` external, shared chunks (the core's seam `WeakMap` lives in one chunk, shared by `index.js` and `offline.js`) |
| `dist/burrow.min.js` | `src/iife.ts` | IIFE, global `Burrow`; the static SDK import is stubbed out so Firebase is not inlined |
| `dist/burrow-firestore.js` | `src/backends/firestore-sdk.ts` | IIFE, global `BurrowFirestoreSdk`, Firebase bundled; loaded on demand by `burrow.min.js` from its own directory |

`package.json` exports `.`, `./offline`, `./passkey` and `./firestore`; `firebase >= 10` is an
optional peer dependency; `files` ships `dist/`, the setup and reaper bins,
`firebase/SETUP-AGENT.md`, `firebase/firestore.rules`, `firebase.json` and `docs/retention.md`.
`docs/firestore-setup.md` lists the human deployment steps; shipped `firebase/SETUP-AGENT.md`
guides an agent through provisioning and verification (D-51). `burrow-setup check` runs the
packaged `src/setup/check.ts` Gate 2 rules check using the same backend and codec, with fresh
throwaway keys and fixed, redacted output. It never provisions resources or runs in CI.
`scripts/size.mjs` builds with esbuild and checks the core with the memory backend (≤ 12 KB
min+gzip), the core with the offline wrapper (≤ 12 KB together, the envelope the local-first core
had) and the passkey utility on top of the core (≤ 2 KB); `scripts/sri.mjs` writes `dist/sri.json`
and prints the script tags for release notes. The release workflow publishes with npm provenance
on a `v*` tag, authenticated by npm trusted publishing rather than a stored token. It stages the
version and drafts the GitHub release; the owner runs `npm run release:approve`, which approves
the staged version on npm with 2FA and publishes the release (D-53).

## 12. Tests and CI

| Suite | Command | Runs where | Covers |
| --- | --- | --- | --- |
| Unit (`test/unit/*.test.ts`) | `npm test` | Node, `fake-indexeddb` | the core (`core.test.ts`: required config, errors, no persistence, sync between devices), the wrapper (`offline.test.ts`: network first, offline start, replay and conflicts, identity copies, tabs, forget), expiry and renewal (`expiry.test.ts`), the passkey utility against a scripted authenticator (`passkey.test.ts`), codec and vectors, caches, config |
| Property (`test/property/merge.test.ts`) | `npm test` | Node, fast-check | merge convergence, tombstones, clock skew, offline periods, queued and network-first writes |
| Conformance (`test/conformance/`) | `npm test` (memory, worker), `npm run test:firestore` (emulator), `npm run test:live` (your own project, never in CI) | Node | `backendConformance()` for every backend; core and wrapper over the emulator |
| Rules (`firebase/tests/rules.test.mjs`) | `npm run test:rules` | `node --test` under the emulator (Java 21) | the rules matrix |
| Browser (`test/e2e/*.spec.ts`) | `npm run test:e2e` | Playwright on Chromium, Firefox, WebKit, served by `scripts/serve.mjs` against the emulator | nothing of the core in the profile, the wrapper's plaintext copy without the token, offline start and replay, tabs, apps, forget, expiry; the demo journeys in both modes; passkeys on Chromium via a CDP virtual authenticator with and without PRF |
| Demo smoke (`test/smoke/demo.spec.ts`) | `npm run test:smoke` | Playwright on Chromium, against the deployed demo (`BURROW_DEMO_URL`) and its live store, or against the assembled `site/` under the emulator | the page shows the expected commit, keeps its strict CSP, loads from its own origin and the store only, logs no console errors, asks how to sign in; two fresh contexts, one in each mode, sync both ways |

Test titles cite the requirement and decision ids they verify. `npm run docs:check`
(`scripts/check-docs.mjs`) typechecks every code block in the README and the guides against the
built declarations: usage examples compile, member-signature listings must match
`OfflineStorage` (which extends `BurrowStorage`), and interface listings must match the exported
type of the same name. Multi-device tests build several devices over one `MemoryBackend` store,
each with its own IndexedDB, Web Lock shim and channels (`test/support/devices.ts`).

For the optional live setup check, set the `BURROW_FIRESTORE` environment variable as described
in [firestore-setup.md, step 7](firestore-setup.md#create-the-project).

CI (`.github/workflows/ci.yml`): typecheck, unit/property/conformance, build, size and
`docs:check` on Node 24 and 26; rules and emulator conformance; browser tests on three engines,
then the demo smoke test against `site/` under the emulator. `pages.yml` runs on every push to
`main`: `scripts/build-demo.mjs` assembles `site/` (the demo files plus the two bundles, one
origin, so `script-src 'self'` covers them, and the page footer stamped with the commit and build
time), the job deploys it to GitHub Pages at <https://froussios.github.io/burrow-storage/>, and a
second job runs the smoke test against the deployed page; a smoke failure fails the run (D-39,
D-40). `release.yml` stages on tags for the owner to approve (D-53). Only the demo may use the
owner's Firebase project; CI reaches it through the deployed page (D-43).

Local serving follows the same isolation rule (D-44): `scripts/serve.mjs` rewrites `demo/` and
`site/` pages to use `FIRESTORE_EMULATOR_HOST`, defaulting to `127.0.0.1:8080`, or an explicit
project from the `BURROW_FIRESTORE` config JSON. It adjusts their CSP for the selected backend.
An invalid explicit config or simultaneous live and emulator settings stops the server before
it listens. If a page's Firestore config cannot be rewritten, it returns HTTP 500 instead of
serving the original. Run
`node scripts/emulator.mjs "npm run serve"` to start both the emulator and server after a build;
bare `npm run serve` expects the emulator to be running already. To use your own live or
pre-production project, set `BURROW_FIRESTORE` and run the server directly; commands and config
requirements are in [firestore-setup.md](firestore-setup.md#local-development). CI continues to
use the emulator.

Contributors need Node 22 or newer, Java 21 for the emulator, and Playwright browsers for the
e2e suite (`npx playwright install --with-deps`).

## 13. Known gaps

Things the code does not do that a reader of the interfaces might expect:

- The offline wrapper's copy is **plaintext**. Anything that can read the browser profile can
  read the key names and values. Encrypting it is deferred (D-57): a key that opens it without a
  prompt would have to be stored beside it.
- A page that keeps the token across visits, as the demo's "stay signed in" does in
  `localStorage`, keeps it unprotected. Burrow offers no protected token storage; the only
  token-free way back in is a passkey or the user's own copy.
- The core does not renew content; only the offline wrapper does (D-59). A core-only app whose
  data is only read can see it expire where an operator runs `burrow-reaper`.
- The core has no events: it does not notice remote changes until the next read. The offline
  wrapper learns them from the backend's subscription, visibility and reconnection, not by
  polling.
- Network first costs one request or more per read. After a failure, the wrapper answers from
  its copy until a retry succeeds, which can be up to five minutes later; `syncNow()` retries at
  once.
- A write still on its way when the page closes may or may not reach the store. The wrapper
  has it in its copy as dirty and replays it on the next start; with the core alone it is lost.
- Copies of tokens no longer used stay on the device until the app opens the wrapper with that
  token and calls `forget()`; there is no listing of them.
- The Firebase SDK writes a heartbeat record to IndexedDB (`firebase-heartbeat-database`) and,
  while offline, logs failed requests and probes connectivity with an image request that a
  strict `img-src` refuses. None of it holds user data; Burrow cannot switch it off.
- The passkey utility cannot tell "dismissed", "timed out" and "no passkey" apart: WebAuthn
  reports all three as `NotAllowedError` (`cancelled`). Real authenticators and passkey providers
  are not tested; only Chromium's virtual authenticator is.
- The Firestore adapter initialises its own named Firebase app and has no hook for Firebase App
  Check, so a site cannot protect Burrow's requests with App Check.
- A non-default `collection` needs a matching edit to `firestore.rules`; `burrow-setup` does not
  rewrite it.
- `FirestoreBackend` always uses the project's `(default)` database; there is no `databaseId`
  option (D-36).
- A well-formed token that has no data opens a new, empty identity (D-32); the demo shows the
  token in use so a typo is visible.
- Nothing calls `navigator.storage.persist()`, so a browser may evict the offline copy (Safari
  after seven days of use without interaction).
- The wrapper's `set()`, `remove()` and `clear()` reject with the raw IndexedDB error when the
  local write fails, not with a `BurrowError`.
