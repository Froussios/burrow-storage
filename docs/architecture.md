# Architecture

How the implementation is put together, for contributors. It describes the code as it is in
`src/`; the public contract is in [api.md](api.md) and the cryptographic design in
[SECURITY.md](../SECURITY.md). Requirement ids in code comments (`API-3`, `SYNC-10`, `KP-5`, …)
refer to [history/requirements.md](history/requirements.md); decision ids (`D-5`) to
[decisions.md](decisions.md).

Contents: 1 Layers and files · 2 Runtime shape · 3 Start-up · 4 Data model · 5 Local reads and
writes · 6 The sync engine · 7 Merge rules · 8 Tabs · 9 Tokens, linking and the passkey backup · 10 Backends
· 11 Build and packaging · 12 Tests and CI · 13 Known gaps

## 1. Layers and files

```
site code ──► store.storage (sync, Storage-shaped)      store (async, chrome.storage-shaped)
   │                    └──────────────┬──────────────────────┘
   │                          Core (src/core.ts): mirror · cache · codec · sync engine
   │  exportToken() / link({ token })                            └ Backend (the swappable seam)
   └──► passkeyBackup() (src/passkey.ts, optional) ── keyslot ──► firestore · memory · yours
```

Dependencies point downward only: `core.ts` imports the codec, caches, merge and secret modules;
`passkey.ts` and the backends import only `types.ts`, `errors.ts`, the codec, `config.ts` and
`bytes.ts`. The core never sees the passkey backup: the site moves the token between them as a
string. Nothing in the core names a concrete backend except `index.ts`, which supplies the
default.

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Public entry: `burrow()`, re-exports, the per-page `Env`, one `Core` per app |
| `src/config.ts` | Default backend discovery shared by `burrow()` and `passkeyBackup()`: `registerBackend`, `configuredBackend`, `readFirestoreConfig`, `defaultBackend` |
| `src/iife.ts` | Entry of `burrow.min.js`: global `Burrow` (with `passkeyBackup`), plus the loader that fetches `burrow-firestore.js` on demand |
| `src/types.ts` | Every public interface; `src/errors.ts` the two error classes and `scrub()`; `src/events.ts` `BurrowEvent` |
| `src/core.ts` | `Core implements BurrowArea`: the in-memory mirror, local writes, the sync engine, tabs, link/unlink |
| `src/facade.ts` | The synchronous `Storage` facade (a `Proxy` over a small class) |
| `src/secret.ts` | `SecretHolder`: the token wrapped with AES-KW, unwrapped per use |
| `src/codec/derive.ts` | HKDF derivation, document ids, write tokens, keyslot keys; `codec/envelope.ts` seal/open with AES-GCM and deflate; `codec/token.ts` the storage-token encoding |
| `src/cache/types.ts` | `Cache` interface; `cache/indexeddb.ts` and `cache/memory.ts` implement it |
| `src/sync/merge.ts` | Pure merge functions: `compare`, `mergeDirectories`, `nextTs`, `valueHash` |
| `src/passkey.ts` | `burrow-storage/passkey`: `passkeyBackup()`, the optional passkey backup of the token |
| `src/backends/memory.ts`, `backends/firestore.ts`, `backends/firestore-sdk.ts` | The backends; `firestore-sdk.ts` is the slice of the Firebase SDK the adapter uses |
| `src/bytes.ts` | UTF-8, base64url, hex, SHA-256, random bytes, `zeroise` |
| `firebase/` | `firestore.rules`, `firebase.json`, the rules tests (`tests/`) |
| `scripts/` | `burrow-setup.mjs` (the `burrow-setup` bin), `emulator.mjs`, `serve.mjs`, `size.mjs`, `sri.mjs`, `gen-vectors.mjs` |
| `demo/` | The static demo page (strict CSP) |
| `test/` | `unit/`, `property/`, `conformance/`, `e2e/`, `sample-app/`, `support/`, `vectors.json` |

## 2. Runtime shape

`Core` is constructed against an **`Env`**: the host services it needs (`openCache`, `channel`,
`locks`, `win`, `doc`, `defaultBackend`). `browserEnv()` builds the page's `Env`; tests build their
own to simulate several devices and tabs in one process (`test/support/devices.ts`).
`createBurrow(config, env)` keeps one `Promise<Core>` per `(env, app)` in a `WeakMap`, which is how
`burrow()` returns the same instance for the same app (API-2). A rejected promise, and an instance
closed by `unlink()`, are removed so the next call starts fresh.

`Core` holds:

- the **mirror**: `Map<key, CachedItem>`, the in-memory copy of the app's cache that every read
  and the facade answer from;
- the **cache**: the `Cache` implementation (IndexedDB or memory) the mirror is persisted to;
- the **secret** (`SecretHolder`) and the derived **app keys** (`AppKeys`: `base`, `pathKey`,
  `encKey`, `macKey`);
- per-app **meta** (`AppMeta`: owner fingerprint, `manifestRev`, `maxRemoteTs`, `lastSyncAt`, `renewAt`);
- the sync engine's timers, the backend subscription, the tab channel and the three events.

## 3. Start-up (`Core.create` → `#init`)

1. Validate `app` (`/^[a-z0-9-]{1,64}$/`, else `TypeError`). Resolve `config.backend` (instance
   or registered type), then `config.firestore`, else `env.defaultBackend()`. Page discovery
   prefers generic `burrow-backend` meta / `window.BURROW.backend`, then legacy Firestore
   meta / global config. Factories load adapters on demand; only the Firestore factory is
   built in. No page data is evaluated or used as a script URL. No config means `null`
   (local-only, one warning). Failed config/factory resolution also uses `null`, and sets
   `status: "error"` with a fixed `backend` error after local initialization. No exception
   details are retained; no fallback to another project occurs. Reload after correction.
2. Open the cache: `config.cache`, defaulting to `"indexeddb"`, or `"memory"` when
   `rememberDevice` is `false`. If IndexedDB cannot be opened, fall back to `MemoryCache` and
   remember to set `status` to `"offline"`.
3. Under the `secret` lock: load the wrapped token from the device store (`rememberDevice`
   only); otherwise generate 32 random bytes, wrap them, and persist them with
   `tokenSource: "generated"`. `token` is set to `{ source, remembered, since }`.
4. `#adoptIdentity()`: derive the app keys; compute the cache's **owner fingerprint**
   `hex(SHA-256("owner:" + base))[0:16]`; if the app's stored `meta.owner` differs, clear the
   app's items and reset its meta. Load the mirror from the cache.
5. Warn once if the backend declares `writeAuth: false`.
6. `#start()`: listen for `pagehide`, `visibilitychange` and `focus`; open
   `BroadcastChannel("burrow:" + app)`; start the poll timer (`syncIntervalMs > 0`, fires only while
   visible); subscribe to the manifest if the backend can; kick off the first sync (not awaited).
   `burrow()` resolves after this.

## 4. Data model

### 4.1 Remote: envelopes

Every live encrypted document in the store is an `Envelope` (`{ v, iv, ct, rev, ts, tok, next, z? }`). Three
kinds share the format and are indistinguishable to the store:

| Kind | Id | Plaintext | Chain key | AAD |
| --- | --- | --- | --- | --- |
| Manifest | `base` | `{ v: 1, items: { key: { ts, h?, deleted? } } }` | `macKey` | `base ‖ app ‖ rev` |
| Item | `docId(key)` | `{ v: 1, key, value, ts, deleted? }` | `macKey` | `id ‖ app ‖ rev` |
| Keyslot | `slotId` | the raw 32-byte token | `slotMac` | `slotId ‖ "slot" ‖ rev` |

`seal()` compresses plaintexts over 64 bytes with deflate-raw when that shrinks them, encrypts
with a fresh 12-byte IV, computes `tok(id, rev)` and `next = hex(SHA-256(tok(id, rev + 1)))`, and
refuses a `ct` over 1 000 000 characters. `open()` reverses it and turns every failure into
`decrypt-failed`. Derivation details and constants: [SECURITY.md](../SECURITY.md).

An optional owner cleanup replaces inactive content with a permanent `ExpiredStub`
(`{ x: true, rev, next }`). `StoredDocument = Envelope | ExpiredStub` is the backend read/watch
contract; normal client writes remain unchanged envelopes. Opaque keyslots are excluded by
selecting a dedicated content target (D-48, D-50).

### 4.2 Local: the cache

IndexedDB database `burrow`, one per origin:

| Object store | Key | Value |
| --- | --- | --- |
| `app:<app>` | item key | `CachedItem { value?, ts, h?, deleted?, dirty?, rev? }` |
| `_meta` | `"app:<app>"` | `AppMeta { owner, manifestRev, maxRemoteTs, lastSyncAt, renewAt }` |
| `_device` | field name | `DeviceMeta`: `wrapped`, `kw` (the non-extractable `CryptoKey` itself), `tokenSource`, `tokenSince` |

The first use of a new app bumps the database version to add its store; another tab holding the
old version closes on `versionchange` and reconnects lazily (`IdbCache.#connect`, five attempts).
`updateItems(keys, fn)` is a single read-modify-write transaction, which is what lets a sync pass
and a concurrent write from another tab coexist without clobbering (D-20).

`dirty: true` marks an item whose latest local write has not been confirmed in the manifest.
`rev` is the last known revision of the item's remote document; `next` is never stored because
tokens are recomputable from `macKey` (D-10).

### 4.3 Limits

| | Value | Where |
| --- | --- | --- |
| Item plaintext | `maxItemBytes` (default 200 000) measured on `{v, key, value, ts}` JSON; clamped to `HARD_MAX_PLAINTEXT = 749_000` | `core.ts #prepare`, `envelope.ts` |
| Ciphertext | `MAX_CT_CHARS = 1_000_000` base64url characters | `seal()`, both backends, the rules |
| Manifest plaintext | 749 000 bytes, else `item-too-large` ("manifest is full") | `#pass` |
| Tombstone retention | 30 days (`TOMBSTONE_TTL_MS`) | `merge.ts` |
| Conflict retries | 3 per document. Manifest: after 200, 800 and 3000 ms. Item: at once, then after 200 and 800 ms. Jitter ×0.75–1.25 | `CONFLICT_BACKOFF` |
| Network/quota backoff | 2 s doubling, cap `max(syncIntervalMs, 5 min)` | `#failed` |
| Listener detach | after 5 hidden minutes | `HIDDEN_DETACH_MS` |

## 5. Local reads and writes

**Reads** (`get`, `getBytesInUse`, the facade) come from the mirror; values are
`structuredClone`d out. `get(keys, { fresh: true })` first runs a full sync (no keys) or fetches
the named item documents (`#fetchKeys`), swallowing errors.

**Writes** go through `#prepare()`: keys must be strings, values pass `assertJson()`, each item's
`ts` is `nextTs(now, previous ts, maxRemoteTs)` so it sorts after everything this device has seen
(SYNC-11), and the size is checked. Nothing is written if any key fails. `#applyLocal()` then
updates the mirror, records the write sequence number for the key, computes the `onChanged`
delta (`addChange` drops no-ops), and persists: `set`/`remove` await the cache write; the facade's
`writeSync` schedules it on a microtask. After persistence the write is broadcast to other tabs,
and a push is scheduled after `debounceMs`.

Writing a value equal to the current one still produces a new `ts` and syncs (D-26), so the last
writer wins across devices; only the `onChanged` event is suppressed.

**Write ordering guard.** A read of the cache that began before a key's latest local write must
not overwrite that key in the mirror. `#mark()` snapshots the write sequence and the set of keys
with pending or in-flight cache writes; `#settledSince(key, mark)` says whether the mirror entry
may be replaced by what that read returned. Both `#reload()` (other tabs' writes) and
`#applyRemote()` (sync) use it.

**Facade** writes are batched: `onChanged` is emitted once per microtask with net-zero changes
removed (set then removed in one batch). Pending facade writes are flushed on `pagehide` and
when the page is hidden.

## 6. The sync engine

### 6.1 Triggers and coalescing

`#sync()` is called by: `#start()` at start-up; the debounce timer after a local write; the poll
timer (visible only); `visibilitychange` → visible; window `focus` while visible, unless a pass
started in the last five seconds; the backend's manifest subscription when the revision changed;
`syncNow()`; `link()`; `get(null, { fresh: true })`;
and `#hide()` when dirty items exist. Calls while a pass is running set
`#rerun` and share the running promise; the loop repeats until nothing requested another pass. A
pass runs under the Web Lock `burrow:<ns>:<app>:sync`, so two tabs of the same app never push at
once. `#sync()` never rejects; failures go to `#failed()`.

### 6.2 One pass (`#pass`)

```
flush pending facade writes; reload the shared cache and receipt under sync lock
status ← "syncing"; renew ← client use requested and shared renewAt is due
loop (manifest conflict retries):
  1. read manifest; reject expired before decrypting; maxRemoteTs ← max(ts seen)
  2. fetch newer items (all listed items when renewing); precheck batch for stubs
     re-read every unlisted prior result (D-46); stage remote versions without cache changes
  3. build a temporary LWW view; push dirty items and due listed renewal items
     retain/adopt results across retries by full logical version (ts/hash/deleted)
  4. merge directory (normal 30-day logical tombstone pruning); write manifest last
     conflict → backoff and retry; expired/failure → leave cached/dirty state untouched
on complete read-only pass or successful publication: apply staged remote merges/pruning
on publication: clear dirty only for the exact published logical version; preserve newer writes
on full renewal success: renewAt ← now + bounded 29–30 day jitter
save metadata; broadcast and emit visible remote changes once
```

Items are written **before** the manifest, each on its own chain, so a reader never fetches an
item older than the manifest entry pointing at it; a crash between the two leaves items unlisted,
and the next pass re-lists them (they are kept in `ok` across manifest retries within a pass,
and remain `dirty` across passes). On a manifest retry, an already-written item absent from the
latest directory is read again: another device may have overwritten it with a tombstone that
has already expired from the manifest. The current item version competes with the local write
before it is re-listed, so an old result cannot resurrect a deletion (D-46). Every unlisted
result is revalidated, including a deletion staged on an earlier retry. A live revalidated result remains cached while the pass publishes its
manifest entry; absence from the old directory does not briefly remove that value locally.
Publication still runs if revalidation cleared the last dirty key but a live result remains
unlisted; otherwise the next pass, without the saved results, could prune it again.

`#pushItem` writes at `cached rev + 1` with the cached rev as the precondition (D-10). With no
cached rev, or on `conflict`, it reads the document; if the remote version wins the comparison it
returns it as `adopted` instead of writing. A due renewal writes that winning payload instead,
without changing its logical version. It retries conflicts up to three times. Ordinary puts
atomically refuse a stored stub; the core never opts into replacing one.

### 6.3 Failure handling (`#failed`)

| Error | Effect |
| --- | --- |
| `decrypt-failed`, `expired` | `status: "error"`, `#paused = true`: no pass runs until `link()` succeeds. The cache is untouched. |
| `conflict`, `item-too-large` | `status: "error"`; items stay dirty; retried on the next trigger. |
| anything else (`quota`, `backend`) | `status: "offline"` with that error; retry timer with exponential backoff; items stay dirty. |

`onStatus` fires on every change of the `(status, error)` pair; a successful pass sets `"idle"`
and resets the backoff.

### 6.4 Use-driven renewal and optional owner cleanup

Opening/using an app requests due renewal; background notifications/polls alone do not renew
again after a successful receipt. All listed documents, including retained deletion markers,
are fetched and rewritten, items first and manifest last. Pruned/unlisted documents are not
rediscovered. Coalescing persists per app/device in `renewAt`; the sync lock and cache reload
prevent stale already-open tabs from renewing again. Failed publication or observed expiry
leaves cache, dirty data and renewal receipt intact, though earlier independent remote item
writes may already exist. A token ownership change resets the receipt.

`scripts/burrow-reaper.mjs` is optional owner maintenance outside CI, not a browser dependency or
an app scheduler. It selects an explicit dedicated content target, scans with a three-field
mask and private paginated checkpoint, and conditionally replaces eligible documents using
exact server `updateTime`. A locked 0600 operator cache reserves daily reads/attempted writes
before requests across targets/reruns in the same project. Skipped stubs still cost scan reads;
other clients' quota and permanent stored bytes are not bounded by this ledger. Token-access
payloads remain untouched and restore stays read-only. See [retention.md](retention.md).

## 7. Merge rules (`src/sync/merge.ts`)

- Order on `(ts, h)`: higher `ts` wins; on equal `ts` a tombstone (`h = "~"`) beats any value,
  and otherwise the greater value hash wins. `h` is the first 16 hex characters of the SHA-256 of
  the JSON serialisation, stored in the manifest so that every replica applies the same order
  without holding the values (D-5).
- `mergeDirectories(a, b, now)` keeps the winner per key and drops tombstones older than 30
  days. Both the manifest write (step 4) and the pull comparison (step 2) use `compare`.
- `nextTs(now, previous, maxRemoteTs)` = `max(now, previous + 1, maxRemoteTs + 1)`.
- A synced (non-dirty) local key missing from the manifest was a tombstone that expired: it is
  deleted locally. A dirty one is kept and pushed, which after 30 days is a legitimate re-creation.

Property tests in `test/property/merge.test.ts` simulate devices with skewed clocks and random
operation sequences and assert convergence.

## 8. Tabs

Tabs of one app share the IndexedDB cache. They talk over `BroadcastChannel("burrow:" + app)`:

| Message | Sent when | Receiver does |
| --- | --- | --- |
| `{ t: "changed", keys, source }` | after a local write persisted, or after a pass applied remote changes | re-reads those keys from the cache (`#reload`) and emits `onChanged` with the given source |
| `{ t: "identity" }` | after `link()` or `unlink()` | reloads the token from the device store: switches identity (fires `onToken`, re-adopts, emits the before/after difference) or, if none is stored, closes itself |

There is no leader election: any tab may run a pass, serialised by the Web Lock. Without
`navigator.locks` passes are not serialised across tabs; without `BroadcastChannel` tabs do not
learn of each other's writes until their next pass.

## 9. Tokens, linking and the passkey backup

The token is wrapped on creation (`SecretHolder.wrap`): an extractable HMAC "vehicle" key holds
the 32 bytes and is wrapped with AES-KW under a non-extractable key generated for the device;
the pair `{ kw, wrapped }` is what `_device` stores. `use(fn)` unwraps, exports the raw bytes, runs
`fn`, and zeroises them. `exportToken()` is `use(encodeToken)`.

**`link({ token, source, discardLocal })`** checks `source` (a non-empty string, default
`"token"`; else `TypeError`), decodes `token` with `decodeToken()` (`bad-token` before any I/O),
then `#switchTo(secret, source, discardLocal)` and zeroises the decoded bytes:

1. If the new token derives the same `base` as the current one: unpause, sync. Nothing else
   changes, `token.source` included. This is the `decrypt-failed` recovery path.
2. Otherwise flush; if dirty items exist and `discardLocal` is false, run a pass under the old
   token and reject `would-orphan` if any remain.
3. Wrap the new token, wait for any running pass (`#drain`), then under the `sync` and `secret`
   locks: persist it, swap `#secret`, set `token` (`source`, `since`) and store `tokenSource`
   and `tokenSince` in `_device`, invalidate the cache's owner stamp, `#adoptIdentity()` (which
   clears the app's items), unpause.
4. Broadcast `identity`, emit `onToken`, resubscribe, run a pass with `onChanged` suppressed, then
   emit one `onChanged("remote")` with the difference between the mirror before and after.

**`unlink(options)`** has the same `would-orphan` guard, then forgets the secret, deletes the
token fields from `_device`, broadcasts `identity` and closes the instance. Later calls throw
`unlinked`.

**The passkey backup** (`src/passkey.ts`, `burrow-storage/passkey`) never touches the core. It
resolves its backend once, on first use: an `options.backend` instance checked against the
shared structural contract, else `defaultBackend()` from
`config.ts` (which shares the page's Firebase app with the store's backend), else it rejects
`backend` before prompting. Page config and factory exceptions become a fixed `backend`
error without a cause, so arbitrary configuration values cannot escape. A failed resolution
is retried on the next call. It keeps no state on the device.

The boundary is preserved by [D-50](decisions.md#d-50-token-recovery-and-content-storage-remain-independent).
For separate backend configuration and token carriers, see
[extending.md](extending.md#independent-token-and-content-storage).

- `available()`: a secure context, `PublicKeyCredential` and `navigator.credentials` exist,
  `getClientCapabilities()` does not report `extension:prf: false`, and
  `isUserVerifyingPlatformAuthenticatorAvailable()`.
- `save(token)`: `decodeToken()` first (`bad-token` before any prompt), then
  `credentials.create` with a discoverable credential, user verification, ES256/RS256, no
  attestation, the PRF extension with salt `burrow/prf/v1`, `rp.name` and `user.name` from the
  options or the page's host, `user.displayName` from its option or effective `userName`, and
  `rp.id` only when `rpId` is given. `user.id` is the first 16 bytes of
  SHA-256(`"burrow/user/v1"` ‖ effective `userName`) (D-47); `displayName` does not enter it. A
  dismissed prompt is `cancelled`; other errors are `prf-unsupported`. If the authenticator did
  not return the PRF output at creation, one `credentials.get` for that credential follows. The
  keyslot is written at `slotId` with `writeSlot()` (read, then put at `rev + 1`, three tries on
  conflict). The decoded secret and the PRF output are zeroised.
  A conforming discoverable authenticator replaces a credential for the same RP and handle
  during creation, before the PRF evaluation and keyslot write. Failure afterward cannot undo
  replacement, even for a repeated save of the same token. Sites warn and ask users to keep
  the current and earlier tokens first, or use distinct labels to retain separate backups.
  Old random-handle credentials/keyslots remain. Only Chromium's virtual authenticator has
  been validated; there is no universal password-manager guarantee.
- `restore()`: a discoverable `credentials.get` (the browser's account picker), derive the slot
  keys, `get(slotId)`, `open()`, `encodeToken()`; a missing slot or a dismissed prompt is `null`.

## 10. Backends

`Backend` is six members (`id`, `capabilities`, `get`, `getMany?`, `put`, `subscribe?`), see
[extending.md](extending.md) for the contract. The core uses `capabilities.writeAuth` (warn) and
`capabilities.subscribe` (whether to subscribe).

**`MemoryBackend`** keeps a `Map<id, StoredDocument>` and enforces the rules exactly: well-formedness
(`wellFormed()` mirrors `shape()` in the rules file), create at rev 0, update at `rev + 1`, and
`SHA-256(tok) == next`. Subscribers are notified on a microtask. Several instances sharing one
map simulate several devices.

**`FirestoreBackend`** (`burrow-storage/firestore`) wraps the modular Firebase SDK:

- `#connect()` loads the SDK through `loadSdk` (a dynamic `import("./firestore-sdk.js")`, replaced
  in the script-tag build by a `<script>` loader for `burrow-firestore.js`), initialises an app
  named `burrow:<projectId>` (so it never collides with a site's own Firebase app), and connects
  the emulator when configured.
- `get` runs `runTransaction(tx => tx.get(ref))` rather than `getDoc`, because a plain read can be
  served from the page's own `onSnapshot` stream and report a revision older than a transaction
  that just committed (D-21).
- `put` runs a transaction that reads, compares `rev` with `expectedRev`, atomically checks the
  stored expiry flag unless explicit replacement was requested, and sets the normal envelope;
  `permission-denied` is re-classified as `conflict` when a fresh read shows a different revision.
- `subscribe` is `onSnapshot` on one document, ignoring snapshots with pending local writes.
- Errors map `resource-exhausted` → `quota`, `permission-denied` → `unauthorized`,
  `invalid-argument` → `too-large`, everything else → `network`.

**Rules** (`firebase/firestore.rules`) are summarised in [firestore-setup.md](firestore-setup.md)
and tested in `firebase/tests/rules.test.mjs` under the emulator.

## 11. Build and packaging

`tsup.config.ts` produces three builds:

| Output | Entry | Notes |
| --- | --- | --- |
| `dist/index.js`, `dist/passkey.js`, `dist/firestore.js` (+ `.d.ts`, maps) | `src/index.ts`, `src/passkey.ts`, `src/backends/firestore.ts` | ESM, `firebase/*` external, shared chunks |
| `dist/burrow.min.js` | `src/iife.ts` | IIFE, global `Burrow`; the static SDK import is stubbed out so Firebase is not inlined |
| `dist/burrow-firestore.js` | `src/backends/firestore-sdk.ts` | IIFE, global `BurrowFirestoreSdk`, Firebase bundled; loaded on demand by `burrow.min.js` from its own directory |

`package.json` exports `.`, `./passkey` and `./firestore`; `firebase >= 10` is an optional peer dependency;
`files` ships `dist/`, the setup bin, `firebase/SETUP-AGENT.md`, `firebase/firestore.rules` and
`firebase.json`. `docs/firestore-setup.md` lists the human deployment steps; shipped
`firebase/SETUP-AGENT.md` guides an agent through provisioning and verification (D-51).
`burrow-setup check` runs the packaged `src/setup/check.ts` Gate 2 rules check using the same
backend and codec, with fresh throwaway keys and fixed, redacted output. It never provisions
resources or runs in CI. `scripts/size.mjs` builds with esbuild and checks
the core (≤ 12 KB min+gzip) and the passkey backup on top of it (≤ 2 KB); `scripts/sri.mjs` writes
`dist/sri.json` and prints the script tags for release notes. The release workflow publishes with
npm provenance on a `v*` tag, authenticated by npm trusted publishing rather than a stored token.
It stages the version and drafts the GitHub release; the owner runs `npm run release:approve`,
which approves the staged version on npm with 2FA and publishes the release (D-53).

## 12. Tests and CI

| Suite | Command | Runs where | Covers |
| --- | --- | --- | --- |
| Unit (`test/unit/*.test.ts`) | `npm test` | Node, `fake-indexeddb`, Node's `--localstorage-file` as the reference `Storage` | area API (`area.test.ts`), facade (`facade.test.ts`), codec and vectors (`codec.test.ts`), cache (`cache.test.ts`), the sample-app drop-in test |
| Property (`test/property/merge.test.ts`) | `npm test` | Node, fast-check | merge convergence, tombstones, clock skew |
| Conformance (`test/conformance/`) | `npm test` (memory), `npm run test:firestore` (emulator), `npm run test:live` (your own project, never in CI) | Node | `backendConformance()` for every backend |
| Rules (`firebase/tests/rules.test.mjs`) | `npm run test:rules` | `node --test` under the emulator (Java 21) | the rules matrix |
| Browser (`test/e2e/*.spec.ts`) | `npm run test:e2e` | Playwright on Chromium, Firefox, WebKit, served by `scripts/serve.mjs` against the emulator | persistence, tabs, unload flush, the demo journeys; passkeys on Chromium via a CDP virtual authenticator with PRF |
| Demo smoke (`test/smoke/demo.spec.ts`) | `npm run test:smoke` | Playwright on Chromium, against the deployed demo (`BURROW_DEMO_URL`) and its live store, or against the assembled `site/` under the emulator | the page shows the expected commit, keeps its strict CSP, loads from its own origin and the store only, logs no console errors, shows a token; two fresh contexts sync both ways |

Test titles cite the requirement ids they verify. `npm run docs:check` (`scripts/check-docs.mjs`)
typechecks every code block in the README and the guides against the built declarations: usage
examples compile, member-signature listings must match `BurrowArea`, and interface listings must
match the exported type of the same name. Multi-device tests build several `Env`s over
one `MemoryBackend` store (`test/support/devices.ts`).

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

Contributors need Node 22 or newer (`--localstorage-file`), Java 21 for the emulator, and
Playwright browsers for the e2e suite (`npx playwright install --with-deps`).

## 13. Known gaps

Things the code does not do that a reader of the interfaces might expect:

- The push started on `pagehide` is best-effort: the Firestore adapter writes through
  transactions, which the SDK does not queue, so if the page closes first the items stay dirty in
  the cache and go out on the next visit (D-31). There is no `keepalive` write path (D-42).
- Polling is a fixed interval; there is no adaptive back-off for idle tabs, so a visible idle tab
  costs one read per `syncIntervalMs` (D-29).
- `rememberDevice: false` generates a fresh token on every load and syncs under it immediately;
  data written before `link()` creates throwaway documents in the store.
- The token is per origin but the `would-orphan` guard in `link()` and `unlink()` looks only at
  the calling app; other apps' unsynced writes on the device are discarded on their next load.
- Open tabs of *other* apps on the origin are not told about a `link()` or `unlink()` (the
  channel is per app); they keep using the old token until they reload.
- Burrow does not know whether a token is backed up anywhere; a site that wants to say so keeps
  its own record (the demo keeps it in the store, D-42).
- `passkeyBackup().restore()` returns `null` both when the prompt is dismissed and when the chosen
  passkey has no keyslot, so a page cannot tell the user which happened.
- The Firestore adapter initialises its own named Firebase app and has no hook for Firebase App
  Check, so a site cannot protect Burrow's requests with App Check.
- A non-default `collection` needs a matching edit to `firestore.rules`; `burrow-setup` does not
  rewrite it.
- There is no tool to reap abandoned documents from a project; removal is manual (D-33, #22).
- `FirestoreBackend` always uses the project's `(default)` database; there is no `databaseId`
  option (D-36).
- `link({ token })` adopts a well-formed token that has no data as a new, empty identity (the demo
  shows the token in use so a typo is visible; D-32).
- Nothing calls `navigator.storage.persist()`, so a browser may evict the cache and the remembered
  token (Safari after seven days of use without interaction).
- `set()`, `remove()` and `clear()` reject with the raw IndexedDB error when the local write fails,
  not with a `BurrowError`.
