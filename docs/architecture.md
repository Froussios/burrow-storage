# Burrow architecture and detailed design

This document is the implementation specification. It refines `docs/requirements.md` to the level
of exact byte encodings, data structures, algorithms and module boundaries, and it incorporates the
resolutions from `docs/design-review.md`. Where the two disagree, this document wins. Requirement
ids (API-3, ENC-7, …) refer to `docs/requirements.md`; decision ids (D1, …) to `docs/decisions.md`.

Contents

1. Layers and module layout
2. Package, build and runtime constraints
3. Public types
4. API layer: `burrow()`, `BurrowArea`, `Storage` facade, errors
5. Crypto: derivation, envelopes, write tokens, size limits
6. Local cache: schema, secret persistence, fingerprints
7. Sync engine: state, push, pull, merge, scheduling, multi-tab
8. Key providers: sync code, passkey and keyslots
9. Backends: contract, `MemoryBackend`, `FirestoreBackend` (REST), rules
10. Observability
11. Test strategy and vectors

---

## 1. Layers and module layout

```
             site code
                │
   ┌────────────┴─────────────┐
   │  API layer               │  burrow(), BurrowArea (async), Storage facade (sync)
   ├──────────────────────────┤
   │  Core                    │  cache · codec (derive, envelope, tokens) · sync engine · merge
   ├─────────────┬────────────┤
   │ Key         │ Backend    │  providers: sync-code, passkey    backends: memory, firestore
   │ providers   │ adapters   │  (pluggable)                      (pluggable; the one swappable seam)
   └─────────────┴────────────┘
                              remote store (Firestore Spark, Worker, …)
```

Dependency direction is strictly downward: `api → core → (providers | backends | cache)`. Core never
imports a concrete provider or backend; it receives them through `BurrowConfig`. Providers and
backends never import each other or core internals; they depend only on `src/types.ts`.

```
src/
  index.ts                 public entry: burrow, BurrowError, MemoryBackend, syncCode, passkey, types
  firestore.ts             public subpath entry "burrow-storage/firestore": FirestoreBackend
  types.ts                 every public interface (also emitted as index.d.ts)
  errors.ts                BurrowError, BackendError, error codes
  util/
    bytes.ts               utf8 / base64url / hex encode+decode, concat, constant-time compare, zero()
    base32.ts              Crockford base32 encode/decode with confusable mapping
    events.ts              BurrowEvent<T>: addListener/removeListener/hasListener/emit
    json.ts                assertJsonValue(), jsonBytes() (UTF-8 byte length of JSON.stringify)
    log.ts                 debug logger (never logs ids, tokens, keys, values)
    timers.ts              debounce, backoff schedule, jitter (injectable clock for tests)
  crypto/
    derive.ts              deriveAppKeys(root, app) → { pathKey, encKey, macKey, base, docId(k) }
    tokens.ts              tok(id, n), nextOf(tok)
    envelope.ts            seal(plaintext, id, rev) / open(envelope, id) incl. deflate-raw
    secret.ts              generateRootSecret(), fingerprint(), wrapForDevice(), unwrapFromDevice()
  cache/
    types.ts               CacheStore interface
    idb.ts                 IndexedDB implementation ("burrow" database)
    memory.ts              in-memory implementation (tests, private-mode fallback)
  sync/
    engine.ts              SyncEngine: triggers, push, pull, status, backoff, locks
    merge.ts               pure functions: mergeManifests, resolveKey, pruneTombstones
    tabs.ts                BroadcastChannel + navigator.locks coordination
  api/
    area.ts                BurrowAreaImpl
    facade.ts              StorageFacade
    registry.ts            per-app singleton map (API-2)
  providers/
    sync-code.ts           encode/decode + KeyProvider impl
    passkey.ts             WebAuthn PRF + keyslot KeyProvider impl
  backends/
    memory.ts              MemoryBackend (writeAuth: true)
    firestore.ts           FirestoreBackend over REST
test/
  vectors/                 committed JSON test vectors (derivation, tokens, envelopes, sync codes)
  unit/                    vitest, node + fake-indexeddb
  conformance/             backend conformance suite (run against memory and the emulator)
  rules/                   @firebase/rules-unit-testing against the emulator
  browser/                 Playwright specs (Chromium, Firefox, WebKit)
firestore/
  firestore.rules
  firebase.json
  reaper.mjs               owner-run admin script (FS-6)
bin/
  burrow-setup.mjs         `npx burrow-setup firestore` (FS-10)
demo/                      static demo site with strict CSP
```

## 2. Package, build and runtime constraints

- **Package** `burrow-storage`, MIT, ESM-only source, TypeScript `strict`, target ES2022, no runtime
  dependencies. `package.json#exports`: `"."` (core + memory backend + both providers) and
  `"./firestore"`. One `index.d.ts` per entry.
- **Builds** (tsup/esbuild): `dist/index.js`, `dist/firestore.js` (ESM); `dist/burrow.min.js` (IIFE,
  global `Burrow` exposing the same exports, Firestore included). `sideEffects: false`.
- **Size budgets** (size-limit, in CI, min+gzip): core entry ≤ 12 KB, of which `providers/passkey.ts`
  ≤ 2 KB; `firestore` entry ≤ 3 KB.
- **Browser support**: last 2 of Chrome, Edge, Firefox, Safari; iOS Safari; Android Chrome. Hard
  requirements: WebCrypto (`subtle`), `BroadcastChannel`, `fetch`. IndexedDB falls back to memory
  (SYNC-4). `CompressionStream`, `navigator.locks`, WebAuthn PRF, `getClientCapabilities` are
  feature-detected.
- **Forbidden**: `eval`, `new Function`, inline scripts, remote script loading, service workers,
  patching globals, writing to `localStorage` except the multi-tab sentinel key (which holds a
  timestamp only), any host other than the configured backend (SEC-4, SEC-5, NF-2).
- **Secrets hygiene** (SEC-1, SEC-2): raw key bytes live in `Uint8Array`s only as long as needed and
  are overwritten with `fill(0)` after import into `CryptoKey`s; every imported `CryptoKey` is
  `extractable: false`. The root secret is the one exception while `exportCode()` encodes it.

## 3. Public types

```ts
// src/types.ts — the whole public surface. Keep this file the single source of truth.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export interface BurrowConfig {
  app: string;                               // required; /^[a-z0-9-]{1,64}$/
  backend?: Backend | null;                  // default: FirestoreBackend.fromPage() if configured, else null (local-only)
  keyProvider?: KeyProvider | KeyProvider[]; // default: [passkey(), syncCode()]
  cache?: "indexeddb" | "memory";            // default "indexeddb"
  rememberDevice?: boolean;                  // default true
  syncIntervalMs?: number;                   // default 30_000; 0 disables polling
  debounceMs?: number;                       // default 1_500
  maxItemBytes?: number;                     // default 200_000, hard max 700_000 (plaintext)
  compress?: boolean;                        // default true
  debug?: boolean;                           // default false
}

export type BurrowStatus = "idle" | "syncing" | "offline" | "error";
export type ChangeSource = "local" | "remote";
export interface Changes { [key: string]: { oldValue?: JsonValue; newValue?: JsonValue } }

export interface BurrowEvent<T> {
  addListener(fn: (ev: T) => void): void;
  removeListener(fn: (ev: T) => void): void;
  hasListener(fn: (ev: T) => void): boolean;
}

export interface BurrowArea {
  get(keys?: null | string | string[] | Record<string, JsonValue>, opts?: { fresh?: boolean }): Promise<Record<string, JsonValue>>;
  set(items: Record<string, JsonValue>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  clear(): Promise<void>;
  getBytesInUse(keys?: null | string | string[]): Promise<number>;
  readonly onChanged: BurrowEvent<{ changes: Changes; source: ChangeSource }>;

  readonly app: string;
  readonly status: BurrowStatus;
  readonly linked: boolean;                  // false only with rememberDevice:false before link()
  readonly protection: "none" | "passkey" | "sync-code" | string;
  readonly onStatus: BurrowEvent<{ status: BurrowStatus; error?: BurrowError }>;
  readonly onUnprotected: BurrowEvent<void>;
  protect(providerId?: string): Promise<void>;
  link(options?: { provider?: string; code?: string; discardLocal?: boolean }): Promise<void>;
  unlink(): Promise<void>;
  syncNow(): Promise<void>;
  exportCode(): Promise<string>;
  exportJSON(): Promise<string>;
  importJSON(json: string): Promise<void>;
  inspect(): BurrowInspection;
  readonly storage: Storage;
}

export interface BurrowInspection {
  app: string; status: BurrowStatus; linked: boolean; protection: string;
  backend: string | null; manifestRev: number | null; dirtyKeys: number; keys: number;
  lastSyncAt: number | null; lastError: { code: BurrowErrorCode; message: string } | null;
  cache: "indexeddb" | "memory"; tabRole: "leader" | "follower";
}

export type BurrowErrorCode =
  | "no-provider" | "prf-unsupported" | "bad-code" | "item-too-large" | "backend"
  | "conflict" | "quota" | "decrypt-failed" | "would-orphan" | "unsupported" | "not-linked";

export class BurrowError extends Error {
  readonly code: BurrowErrorCode;
  readonly cause?: unknown;                  // scrubbed: never contains ids, tokens, key material
}

export interface Envelope {
  v: 1;
  iv: string;        // base64url, 16 chars (12 bytes)
  ct: string;        // base64url of AES-256-GCM ciphertext || tag
  rev: number;       // integer ≥ 0
  ts: number;        // writer wall clock, ms, integer
  tok: string;       // base64url, 43 chars; "" is NOT allowed — rev 0 carries tok(id, 0) too
  next: string;      // lowercase hex, 64 chars
  z?: true;
}

export interface Backend {
  readonly id: string;
  readonly capabilities: {
    writeAuth: boolean;
    subscribe: boolean;
    keepalive: boolean;
    maxEnvelopeBytes: number;                // max ct.length the store accepts
  };
  get(id: string): Promise<Envelope | null>;
  getMany?(ids: string[]): Promise<(Envelope | null)[]>;
  put(id: string, env: Envelope, expectedRev: number | null, opts?: { keepalive?: boolean }): Promise<void>;
  subscribe?(id: string, onChange: (env: Envelope) => void): () => void;
}

export type BackendErrorCode = "conflict" | "unauthorized" | "too-large" | "quota" | "network";
export class BackendError extends Error { readonly code: BackendErrorCode; readonly cause?: unknown }

export interface KeyProvider {
  readonly id: string;
  available(): Promise<boolean>;
  enrol(ctx: { app: string; rootSecret: Uint8Array; backend: Backend | null; label?: string }): Promise<void>;
  recover(ctx: { app: string; interactive: boolean; input?: string; backend: Backend | null }): Promise<Uint8Array | null>;
}

export function burrow(config: BurrowConfig): Promise<BurrowArea>;
export function syncCode(): KeyProvider;
export function passkey(opts?: { label?: string }): KeyProvider;
export class MemoryBackend implements Backend { /* §9.2 */ }
// "burrow-storage/firestore"
export class FirestoreBackend implements Backend {
  constructor(cfg: { projectId: string; apiKey: string; collection?: string; databaseId?: string });
  static fromPage(): FirestoreBackend | null;   // <meta name="burrow-firestore"> or window.BURROW.firestore
}
```

Differences from the requirements text, all from the design review: `linked`, `not-linked` and
`unsupported` codes, `compress`, `debug`, `BurrowEvent` instead of `EventTarget` (D6), `backend` passed
to providers (the passkey provider needs it for keyslots), `backend: null` meaning local-only.

## 4. API layer

### 4.1 `burrow(config)` — startup sequence

1. Validate `app` against `/^[a-z0-9-]{1,64}$/`; `TypeError` otherwise. Return the registry entry if
   one exists for `app` (API-2); with a differing config, warn when `debug`.
2. Open the cache: IndexedDB unless `cache: "memory"`; on any failure to open fall back to memory and
   remember `status = "offline"` (SYNC-4). If `crypto.subtle` is missing, reject `unsupported`.
3. Load the device secret from `meta.secret` (§6.2). If present: unwrap, derive app keys (§5.1),
   compute `fp`. If absent and `rememberDevice !== false`: generate 32 random bytes, wrap, store,
   `protection = "none"` (KP-1). If absent and `rememberDevice === false`: `linked = false`; skip to 5.
4. Compare the app's `state.fp` with the current `fp`. If they differ (secret changed by `link()` in
   another app or another tab): clear this app's items and state, keep going. This is G4.
5. Load every item of the app into the facade mirror (API-10) and the dirty set.
6. Construct the sync engine (no network yet), join the tab channel, pick leader via lock (§7.6).
7. Resolve. After resolution, on a microtask: if `linked` and a backend exists, schedule an initial
   pull; if `linked`, `protection === "none"`, the app has ≥ 1 item and `meta.unprotectedFired[app]`
   is unset, emit `onUnprotected` once and set the flag (KP-14).

Budget: steps 1–7 must complete in < 50 ms on a warm cache with ≤ 200 items (NF). The only awaits are
IndexedDB opens/reads and one `unwrapKey`.

### 4.2 `get` / `set` / `remove` / `clear` / `getBytesInUse`

Argument shapes exactly as `chrome.storage.StorageArea` (API-3):

- `get()` / `get(null)` → all keys. `get("k")` → `{k}` if present. `get(["a","b"])` → present subset.
  `get({a: 1, b: 2})` → defaults filled in for missing keys. Values are structured-cloned on the way
  out so callers cannot mutate the mirror. `opts.fresh` (SYNC-7): if `linked` and a backend exists,
  fetch `docId(k)` for each requested key, run the merge for each (§7.3), then answer from the cache;
  on network failure answer from the cache anyway.
- `set(items)`: for each key, `assertJsonValue(value)` (§4.3) and `jsonBytes(value) ≤ maxItemBytes`
  else reject `item-too-large` (nothing is written if any key fails: validate all first). Then one
  cache transaction writing `{ value, ts, dirty: 2 }` for every key with `ts = clock.now()` (§7.3
  skew rule), update the mirror, emit `onChanged` once with `source: "local"` and only keys whose
  value changed (deep-equal by JSON text), notify other tabs, schedule a push. Resolves when the cache
  transaction completes (API-6).
- `remove(keys)`: same, writing `{ value: null, ts, deleted: true, dirty: 2 }`; keys that were absent
  are not written and not reported.
- `clear()`: `remove` of every live key.
- `getBytesInUse(keys)`: sum over selected live keys of `utf8len(key) + jsonBytes(value)`, as Chrome
  computes it.

### 4.3 Value rules (API-4, G7)

`assertJsonValue(v)` accepts `null`, `boolean`, finite `number`, `string`, `Array` of accepted values,
and plain objects (`Object.getPrototypeOf(v) === Object.prototype || null`) whose own enumerable
string-keyed values are accepted or `undefined` (dropped). Anything else — `NaN`, `±Infinity`,
`bigint`, `symbol`, functions, `Date`, `Map`, `Set`, typed arrays, class instances — throws
`TypeError("burrow: value at key \"k\" is not a JSON value (Date)")`. Cycles throw `TypeError` too.

### 4.4 Events

`BurrowEvent<T>` is a minimal emitter. Listeners run synchronously in registration order inside a
try/catch; a throwing listener is reported with `console.error` and does not stop the others.
`onChanged` for local writes fires once per `set`/`remove`/`clear` call; for remote changes once per
pull (API-5, SYNC-13); for writes made in another tab once per received broadcast, with
`source: "local"`.

### 4.5 `Storage` facade (API-9..12, G8)

`StorageFacade` implements the DOM `Storage` interface over the in-memory mirror:

- `length`, `key(n)` (insertion order of the mirror), `getItem(k)`: `null` if absent or tombstoned;
  the value if it is a string; `JSON.stringify(value)` otherwise.
- `setItem(k, v)`: `v = String(v)`; size check as `set` (throws `BurrowError("item-too-large")`
  synchronously, ERR-1); updates the mirror synchronously; enqueues the cache write. `removeItem`,
  `clear` likewise.
- Facade writes are coalesced into one cache transaction per macrotask (`queueMicrotask` would be
  too eager; use `setTimeout(0)`), and flushed synchronously-as-possible on `visibilitychange` →
  hidden and `pagehide` (IndexedDB writes started in those handlers complete in practice; nothing
  more can be promised). `onChanged` fires after the mirror update with `source: "local"`.
- The facade never dispatches the window `storage` event (API-12).
- Property-style access (`s.foo = "x"`) is **not** supported; `localStorage` ports that rely on it
  are rejected by the type and documented as unsupported.

### 4.6 `protect`, `link`, `unlink`, `exportCode`, `exportJSON`, `importJSON`

- `protect(providerId?)`: pick the provider by id or the first whose `available()` resolves true;
  reject `no-provider` if none. Call `enrol({ app, rootSecret, backend, label })`. On success set
  `protection = provider.id` and persist it in `meta`. Must be called from a user gesture for the
  passkey provider; the library does not check, the browser does.
- `link({ provider, code, discardLocal })`:
  1. If `code` is given: decode (§8.1), reject `bad-code` before any network call (KP-12).
     Otherwise iterate providers (filtered to `provider` if given), calling
     `recover({ app, interactive: true, backend })`; first non-null wins; all null → `no-provider`.
  2. If the device has a secret and any app of this origin has dirty items, and `!discardLocal`,
     reject `would-orphan` (nothing changed). The dirty check spans all apps because the secret does.
  3. Validate the recovered secret has data: `backend.get(base(secret, app))`; if `null` and the
     code came from `code`, also check nothing else proves it (T4) → reject `bad-code`. (A passkey
     recovery is trusted without this check: the keyslot proved it.)
  4. Persist: wrap and store the new secret, update `meta.fp`, set `protection` to the provider id
     (`"sync-code"` for code). Clear **this** app's items and state (other apps are cleared lazily
     in §4.1 step 4). Broadcast `secret-changed` to other tabs, which reload (§7.6).
  5. Run a pull; resolve when it completes or fails (the promise resolves either way; failure
     surfaces via `onStatus`). `linked = true`.
- `unlink()`: zero the in-memory secret, delete `meta.secret`, `meta.fp`, `meta.protection`,
  `meta.credential`; keep the app's items (API-8); set `linked = false`; stop syncing; broadcast
  `secret-changed`. The area keeps serving reads and local writes, so a site can still call
  `exportJSON()` after `unlink()`. The next `burrow()` on the device generates a fresh secret (KP-1)
  and, because `state.fp` no longer matches, wipes the cache before use (§6.2): the old identity's
  plaintext never shows up under the new one. Docs say "export first if you want to keep the data".
- `exportCode()`: `not-linked` if no secret; otherwise §8.1 encode.
- `exportJSON()`: `JSON.stringify({ v: 1, app, exportedAt, items: { key: value } })` of live keys.
- `importJSON(json)`: parse, validate each value (§4.3), `set` them all in one call.

### 4.7 Errors (API-13, SEC-8)

`BurrowError(code, message, cause?)`. `cause` is passed through `scrub()` which deletes any string
property whose value is 43 or 64 chars of `[A-Za-z0-9_-]`/hex, and the properties `url`, `path`,
`documentId`, `tok`, `next`. Messages never interpolate ids, tokens or values.

## 5. Crypto

All primitives are WebCrypto. No third-party crypto. Strings are encoded as UTF-8 everywhere below.
`b64u(x)` is base64url without padding; `hex(x)` is lowercase.

### 5.1 Derivation (ENC-1, ENC-2)

```
root      : 32 random bytes (crypto.getRandomValues)
hkdf(ikm, salt, info, len) = WebCrypto deriveBits({ name:"HKDF", hash:"SHA-256", salt, info }, ikm, len*8)
                             (this is Extract-then-Expand in one call)

pathKey   = hkdf(root, "burrow/v1", "path" || app, 32)
encKey    = hkdf(root, "burrow/v1", "enc"  || app, 32)    → importKey raw AES-GCM, non-extractable, [encrypt, decrypt]
macKey    = hkdf(root, "burrow/v1", "auth" || app, 32)    → importKey raw HMAC-SHA-256, non-extractable, [sign]
pathKeyK  = importKey(pathKey, HMAC-SHA-256, non-extractable, [sign])

base      = b64u(SHA-256(pathKey))                        // 43 chars; the manifest id
docId(k)  = b64u(HMAC-SHA-256(pathKeyK, "item" || k))     // 43 chars; item key k's document id

fp        = b64u(SHA-256("fp" || root))[0:16]             // device-local fingerprint, never stored remotely
```

`app` is already restricted to `[a-z0-9-]`, and the labels `path`/`enc`/`auth` start with distinct
letters, so no separator is needed in `info`. The raw `pathKey` bytes are zeroed after `base` and
`pathKeyK` are computed. `root` is zeroed after the three derivations unless `exportCode()` is in
progress; the engine keeps `root` only as an opaque handle (`Uint8Array` inside a closure) because
`exportCode()` and `protect()` need the raw bytes. Rationale for not making it a `CryptoKey`: HKDF
`deriveBits` needs the raw key imported as HKDF `CryptoKey`, which is fine, but `exportCode()` needs
bytes; keeping one in-memory copy is simpler than keeping two representations.

Derivation version: the salt `burrow/v1` and the labels are frozen (ENC-2). A future `v2` derives
with a new salt and a migration that pulls under v1 and pushes under v2.

### 5.2 Envelope sealing (ENC-4, ENC-5)

```
seal(plaintextObj, id, rev, ts, tok, next, opts):
  pt   = utf8(JSON.stringify(plaintextObj))
  if opts.compress && CompressionStream:
      c = deflateRaw(pt); if c.length < pt.length: pt = c; z = true
  iv   = 12 random bytes
  aad  = utf8(`${id}|${app}|${rev}`)
  ct   = AES-256-GCM.encrypt(encKey, iv, pt, aad, tagLength 128)
  env  = { v:1, iv:b64u(iv), ct:b64u(ct), rev, ts, tok, next, ...(z && {z:true}) }
  if env.ct.length > backend.capabilities.maxEnvelopeBytes: throw item-too-large
  return env

open(env, id):
  aad = utf8(`${id}|${app}|${env.rev}`)
  pt  = AES-256-GCM.decrypt(encKey, b64uDecode(env.iv), b64uDecode(env.ct), aad)   // throws → decrypt-failed
  if env.z: pt = inflateRaw(pt)
  return JSON.parse(utf8decode(pt))
```

Binding `rev` in the AAD means a document can only be decrypted at the revision it was written for;
binding `id` means it cannot be replayed to another id. The `|` separator resolves G1.

### 5.3 Plaintext formats

```ts
interface Manifest { v: 1; items: Record<string, { ts: number; deleted?: true }> }
interface Item     { v: 1; key: string; value: JsonValue | null; ts: number }
interface Keyslot  { v: 1; root: string /* b64u of 32 bytes */; created: number }   // plaintext of a keyslot envelope (§8.2)
```

`Item.key` is redundant with the id and is checked on `open`: a mismatch is `decrypt-failed`.

### 5.4 Write tokens (ENC-7, ENC-8, G2)

```
tok(id, n)  = b64u(HMAC-SHA-256(macKey, utf8(`${id}:${n}`)))        // n in decimal ASCII; 43 chars
nextOf(t)   = hex(SHA-256(utf8(t)))                                 // hash of the base64url TEXT; 64 chars
```

A document at revision `n` carries `tok = tok(id, n)` and `next = nextOf(tok(id, n+1))`. To write
revision `n+1` the client sends `tok(id, n+1)` and `next = nextOf(tok(id, n+2))`. The store accepts
when `SHA-256(presented tok) == stored next` and `rev == stored rev + 1`. Revision 0 (create) carries
`tok(id, 0)` so the shape is uniform; the store does not check it.

Keyslot documents use the same scheme with `slotMac` (§8.2) in place of `macKey`.

Only `rev` needs caching per document (G11); every token is recomputable.

### 5.5 Size limits (ENC-4, G3)

| Limit | Value | Enforced where |
|---|---|---|
| `maxItemBytes` default | 200 000 bytes of `JSON.stringify(value)` | `set()`, `setItem()`, `importJSON()` |
| `maxItemBytes` hard ceiling | 700 000 bytes | config validation (`TypeError` if higher) |
| Envelope `ct` | `≤ backend.capabilities.maxEnvelopeBytes` chars (Firestore 1 000 000) | `seal()` → `item-too-large` |
| Manifest plaintext | 700 000 bytes | `seal()` → `item-too-large` surfaced via `onStatus` (a `set` that would overflow the manifest is rejected up front with `item-too-large` when `keys × 60 bytes` estimate exceeds the ceiling) |

700 000 bytes of plaintext + 16 tag bytes → 933 355 base64url characters < 1 000 000.

### 5.6 Device persistence of the root secret (ENC-10, KP-2, D5)

```
kek  = generateKey({ name:"AES-GCM", length:256 }, extractable:false, ["encrypt","decrypt"])
wrap:   iv = 12 random bytes; ct = AES-GCM.encrypt(kek, iv, root, aad "burrow/device/v1")
store   meta.secret = { v:1, kek /* CryptoKey */, iv: ArrayBuffer, ct: ArrayBuffer }
unwrap: AES-GCM.decrypt(kek, iv, ct, aad) → root
```

Stored as one IndexedDB record; `CryptoKey` objects are structured-cloneable. With
`rememberDevice: false` nothing is stored and `root` lives in the closure only.

## 6. Local cache

### 6.1 IndexedDB schema (SYNC-1..3, D2)

Database `burrow`, version 1. Object stores:

| Store | Key | Value |
|---|---|---|
| `items` | `[app, key]` (compound) | `{ value: JsonValue \| null, ts: number, deleted?: true, dirty: 0\|1\|2, rev?: number }` |
| `state` | `app` | `{ fp: string, manifestRev: number \| null, lastSyncAt: number \| null, maxRemoteTs: number, pollMs: number, unprotectedFired: boolean }` |
| `meta` | string | `"secret"` → §5.6 record · `"fp"` → string · `"protection"` → string · `"credential"` → `{ id: ArrayBuffer, userId: ArrayBuffer }` |

Per-app isolation: clearing app A is `items.delete(IDBKeyRange.bound([A], [A, "￿"]))` plus
`state.delete(A)`. Everything about one app is one key range.

`CacheStore` interface (implemented by `idb.ts` and `memory.ts`):

```ts
interface CacheStore {
  getAll(app): Promise<Map<string, CachedItem>>;
  putMany(app, entries: [string, CachedItem][]): Promise<void>;       // one transaction
  deleteMany(app, keys: string[]): Promise<void>;
  clearApp(app): Promise<void>;
  getState(app): Promise<AppState | undefined>;  putState(app, s): Promise<void>;
  getMeta<T>(k): Promise<T | undefined>;  putMeta(k, v): Promise<void>;  deleteMeta(k): Promise<void>;
}
```

### 6.2 Secret, fingerprint and protection (G4)

`meta.secret`, `meta.fp`, `meta.protection` and `meta.credential` are per origin. `state[app].fp` is
the fingerprint the app's items were written under. Rule: **an app cache is valid only while
`state.fp === meta.fp`**; otherwise it is wiped before use. `link()` and `unlink()` change `meta.fp`
(or delete it); `burrow()` applies the rule at startup; a running area applies it when it receives a
`secret-changed` broadcast (it reloads itself: wipe, pull).

### 6.3 Dirty states (G5)

| `dirty` | Meaning |
|---|---|
| 2 | Local change not yet written to the item document |
| 1 | Item document written at `rev`; manifest does not yet list this `ts` |
| 0 | Fully synced |

## 7. Sync engine

### 7.1 State

```ts
interface EngineState {
  status: BurrowStatus; lastError?: BurrowError;
  leader: boolean;                         // only the leader tab talks to the backend
  pushTimer?: Timer; pullTimer?: Timer; backoffMs: number; pollMs: number;
  inFlight: null | Promise<void>;          // one sync pass at a time per tab
}
```

Status derivation: `syncing` while a pass is in flight; `offline` when the last pass failed with
`network`/`quota` or the cache is memory-fallback or `linked === false`; `error` when the last pass
failed with `conflict` (after retries), `decrypt-failed`, or a backend `unauthorized` (surfaced as
code `backend`, items stay dirty, retried on the next trigger; §9.3); `idle` otherwise. `onStatus` fires on
every transition with `lastError` (ERR-2).

### 7.2 Push (SYNC-5, SYNC-8, SYNC-9)

Triggered by: debounce after a local write (`debounceMs`, restarted by each write); `syncNow()`;
`visibilitychange` → hidden and `pagehide` (flush mode, §7.5); after a pull that found dirty items.

```
push():
  if !leader or !linked or !backend: return
  dirty = items where dirty > 0
  if dirty.empty: return
  // stage 1: item documents, in parallel, each on its own chain
  await Promise.all(dirty.filter(d => d.dirty == 2).map(writeItem))
  // stage 2: manifest, once
  await writeManifest(dirty)
  mark all pushed items dirty = 0 (only those whose ts is unchanged since the pass began)

writeItem(k, entry):
  id = docId(k); rev = entry.rev ?? null
  plaintext = { v:1, key:k, value: entry.deleted ? null : entry.value, ts: entry.ts }
  for attempt in [0, 200ms, 800ms, 3s] (jitter ±25%):
    env = seal(plaintext, id, rev == null ? 0 : rev+1, entry.ts, tok(id, newRev), nextOf(tok(id, newRev+1)))
    try: await backend.put(id, env, rev); entry.rev = newRev; entry.dirty = 1; persist; return
    catch conflict:
      remote = await backend.get(id)            // null is possible only on a lost race to create
      if remote: r = open(remote, id); winner = resolveKey(local=entry, remote={ts:r.ts, value:r.value, deleted:r.value===null})
                 entry.rev = remote.rev
                 if winner == remote: apply remote to cache (dirty 0), fire onChanged(remote); return
      // local wins or remote missing: retry with the fresh rev
    catch too-large: mark entry error, surface onStatus(item-too-large), dirty stays 2, return
    catch quota|network: throw (ends the pass; backoff)
  throw conflict (status error, items stay dirty)

writeManifest(dirtyEntries):
  for attempt in same schedule:
    remote = cached manifest? (we always re-read on conflict; first attempt uses state.manifestRev)
    local  = manifest built from the cache: every key → { ts, deleted? } with tombstones pruned (§7.3)
    env = seal(local, base, rev+1, now, tok(base, rev+1), nextOf(tok(base, rev+2)))
    try: await backend.put(base, env, state.manifestRev); state.manifestRev = rev+1; return
    catch conflict:
      remoteEnv = await backend.get(base); remoteM = open(remoteEnv, base)
      state.manifestRev = remoteEnv.rev
      merged = mergeManifests(cacheView, remoteM)      // §7.3; may schedule item fetches for keys where remote is newer
      apply merged to cache (newer remote keys: fetch their items now, before retrying)
      // loop: retry with merged content
```

Items whose `dirty == 1` are listed by the manifest write without rewriting the document; that is
the crash-recovery path of G5.

### 7.3 Pull and merge (SYNC-6, SYNC-10..13)

```
pull():
  if !leader or !linked or !backend: return
  env = await backend.get(base)
  if env == null: (fresh vault) if any dirty: push(); return
  if env.rev == state.manifestRev and no dirty: return          // nothing changed, 1 read
  remote = open(env, base)                                       // decrypt-failed → status error, pause sync until link()
  state.maxRemoteTs = max(state.maxRemoteTs, max ts in remote.items)
  plan = for each key in remote.items ∪ cache.keys:
           r = remote.items[key]; l = cache[key]
           if r && (!l || r.ts > l.ts || (r.ts == l.ts && !l.deleted != !r.deleted)): fetch item (unless r.deleted: tombstone needs no fetch)
           if !r && l && l.dirty == 0: delete locally (pruned remotely, SYNC-10 reasoning)
  envs = await backend.getMany(ids of fetches)   (parallel get() default)
  for each fetched env: it = open(env, id); check it.key == key; apply resolveKey(local, remote) → cache (dirty 0, rev = env.rev)
  state.manifestRev = env.rev; state.lastSyncAt = now
  fire onChanged({changes: keys whose visible value changed}, "remote") once
  if any dirty: push()
```

`resolveKey(local, remote)` (pure, `merge.ts`): greater `ts` wins; equal `ts` → a tombstone beats a
value (deletes are idempotent and this keeps convergence); equal `ts` and both values → the
bytewise-greater `JSON.stringify` wins. A local entry with `dirty > 0` that loses to remote is
overwritten and set `dirty = 0`; one that wins stays dirty and is pushed.

`mergeManifests(local, remote)` applies `resolveKey` per key over the two `{ts, deleted}` maps and
returns the union, plus the list of keys where remote won and a fetch is needed.

Clock skew (SYNC-11): `clock.now() = max(Date.now(), state.maxRemoteTs + 1, lastLocalTs + 1)`; every
local write uses it, so a local write always sorts after everything this device has seen.

Tombstones: a `deleted` entry stays in the manifest for 30 days from its `ts` and is dropped from the
manifest on the next manifest write after that (`pruneTombstones`). The item document keeps
`value: null` forever (FS-6). Locally the tombstone row is deleted when it is pruned from the manifest.

### 7.4 Scheduling (SYNC-6, Q3)

Pull triggers: `burrow()` start (if linked), `link()`, `syncNow()`, `visibilitychange` → visible,
`focus`, every `pollMs` while the document is visible, `subscribe` notification when the backend has
it. `pollMs` starts at `syncIntervalMs`; after a pull that found no change and had nothing to push it
doubles (cap 300 000 ms); any local write, focus, visible, or pull that found changes resets it to
`syncIntervalMs`. `syncIntervalMs: 0` disables the timer (event triggers still pull).

Backoff (SYNC-9): a pass that fails with `network` or `quota` sets `backoffMs = min(max(2 × backoffMs,
5 000), max(syncIntervalMs, 300 000))` with ±25 % jitter and schedules the next pass then; a success
resets it. `quota` additionally sets `lastError.code = "quota"`. Dirty items are never dropped.

### 7.5 Unload flush (SYNC-5, Q5)

On `pagehide` and `visibilitychange` → hidden the leader runs `push()` in **flush mode**: facade
writes are committed to the cache first; then, if `backend.capabilities.keepalive`, item envelopes
whose `ct.length ≤ 32 768` and the manifest are written with `{ keepalive: true }`, without retries.
Larger items stay `dirty = 2` and go on the next load. Without keepalive, only the cache commit runs.

### 7.6 Multi-tab (SYNC-14)

`BroadcastChannel("burrow:" + app)` messages: `{ t: "changes", changes, ts }` after a local write
(receivers update mirror + cache view and fire `onChanged("local")`), `{ t: "pulled", changes }` from
the leader after a pull (receivers apply and fire `onChanged("remote")`), `{ t: "secret-changed" }`
after `link()`/`unlink()` (receivers reload per §6.2), `{ t: "ping" }` for leader election fallback.

Leader election: `navigator.locks.request("burrow:leader:" + app, { mode: "exclusive" })` held for
the tab's lifetime; the holder is leader, others are followers who never touch the backend. Without
`navigator.locks` (old Safari): the fallback is a heartbeat on `localStorage["burrow:leader:" + app]`
= `${tabId}:${Date.now()}`; a tab takes leadership when the heartbeat is older than 10 s. The
sentinel holds no secret. Followers who receive `changes` with dirty items rely on the leader to push
them; the leader reads the dirty set from the cache, not from memory, on every pass.

Without `BroadcastChannel` (not in the support matrix) the library runs single-tab and warns in debug.

## 8. Key providers

### 8.1 Sync code (KP-11, KP-12)

```
bytes   = [0x01] || root(32) || checksum(2)         where checksum = SHA-256(0x01 || root)[0:2]
code    = crockford32(bytes)                         // 35 bytes → 56 chars, alphabet 0123456789ABCDEFGHJKMNPQRSTVWXYZ
display = code grouped 4-4-4-… joined with "-"      // 14 groups

decode(input):
  s = input.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g,"0").replace(/[IL]/g,"1")
  if s.length != 56: bad-code
  bytes = crockford32decode(s)  (invalid char → bad-code)
  if bytes[0] != 0x01: bad-code  (unknown version)
  if SHA-256(bytes[0..33])[0:2] != bytes[33..35]: bad-code
  return bytes[1..33]
```

Version byte `0x01` = random secret (no stretching). A future passphrase provider would use `0x02` and
ENC-3's PBKDF2 (D4). The provider's `enrol()` is a no-op that resolves (the code is obtained from
`exportCode()`), `recover({input})` decodes, `available()` is always true.

### 8.2 Passkey with keyslot (KP-5..10, ENC-11, C1, G6)

Derivation from the PRF output (32 bytes):

```
kek      = hkdf(prf, "burrow/slot/v1", "kek",  32)     → AES-GCM key, non-extractable
slotMac  = hkdf(prf, "burrow/slot/v1", "auth", 32)     → HMAC key, non-extractable
slotId   = b64u(SHA-256(hkdf(prf, "burrow/slot/v1", "slot", 32)))
PRF salt = utf8("burrow/prf/v1")  (fixed, library constant), passed as eval.first
```

Keyslot document: `Envelope` at `slotId` with `ct = AES-GCM(kek, iv, utf8(JSON{v:1, root:b64u(root),
created}), aad = utf8(`${slotId}|slot`))`, chained with `tok(slotId, n)` under `slotMac`. The store
cannot tell it from an item.

`available()`: `typeof PublicKeyCredential !== "undefined"` && `location.hostname !== ""`
&& `isUserVerifyingPlatformAuthenticatorAvailable()`
&& (`getClientCapabilities` absent || `caps["extension:prf"] !== false`). Never prompts.

The hostname check (D20) excludes `file://` and other opaque origins. There Chromium reports a
platform authenticator and PRF support, yet `create()` throws `SecurityError` because `rp.id` would
be `""` (WP-00). Without the check, `protect()` would pick the passkey and fail instead of falling
through to the sync code (KP-7, NF-1). `caps["extension:prf"]` is a browser-level flag: it is `true`
with no authenticator attached. It rules out browsers that do not know PRF, not authenticators
without it, which is why `enrol()` still checks `prf.enabled` (C1). See `docs/platform-notes.md` §3.

`enrol({ rootSecret, backend, label })` (user gesture required; rejects `backend` null with `no-provider`):

1. `userId = 16 random bytes`.
2. `navigator.credentials.create({ publicKey: { rp: { id: location.hostname, name: label ?? location.hostname },
   user: { id: userId, name: label ?? location.hostname, displayName: label ?? location.hostname },
   challenge: 32 random bytes, pubKeyCredParams: [{ alg: -7, type: "public-key" }, { alg: -257, type: "public-key" }],
   authenticatorSelection: { residentKey: "required", userVerification: "required" },
   attestation: "none", extensions: { prf: { eval: { first: salt } } } } })`.
3. `ext = cred.getClientExtensionResults().prf`. If `!ext?.enabled` → reject `prf-unsupported`
   (the created credential is useless; the docs say so). If `ext.results?.first` is present, use it;
   else call `navigator.credentials.get()` as in `recover` with `allowCredentials: [cred.rawId]` to
   obtain the PRF output (second prompt on platforms that do not evaluate at create). WP-00: Chromium
   returns `results.first` at `create()`, and it equals the `get()` output for the same salt; real
   devices are not yet measured (`docs/platform-notes.md` §3.2). A `NotAllowedError` from `create()`
   is a cancel or a failed user verification, not `prf-unsupported`.
4. Derive `kek`, `slotMac`, `slotId`; `remote = backend.get(slotId)`; write the keyslot envelope at
   `rev = remote ? remote.rev + 1 : 0`.
5. Persist `meta.credential = { id: cred.rawId, userId }`.

`recover({ interactive, backend })` (returns `null` if `!interactive` or `!backend`):

1. `navigator.credentials.get({ publicKey: { rpId: location.hostname, challenge: 32 random bytes,
   userVerification: "required", allowCredentials: meta.credential ? [{ id, type: "public-key" }] : [],
   extensions: { prf: { eval: { first: salt } } } } })`. A user cancel (`NotAllowedError`) → `null`.
2. `prf = results.prf?.results?.first`; absent → throw `prf-unsupported`.
3. Derive; `env = backend.get(slotId)`; `null` → `null` (this passkey was never enrolled here).
4. `open` with `kek` (failure → `decrypt-failed`); return `root`. Persist `meta.credential`.

Cross-ecosystem (KP-10) is the platform's hybrid flow; nothing to implement. The docs state that the
sync code is the guaranteed path.

## 9. Backends

### 9.1 Contract (BE-1..7)

See §3 for the interface. Semantics an adapter must guarantee (and the conformance suite checks):

- `get(id)` → `null` when absent; the stored `Envelope` otherwise, fields exactly as written.
- `put(id, env, null)` creates; rejects `conflict` if the document exists.
- `put(id, env, n)` updates; rejects `conflict` if stored `rev !== n` **or** (when `writeAuth`) if
  `SHA-256(env.tok) !== stored.next` or `env.rev !== n + 1`. Two concurrent `put`s at the same
  `expectedRev` yield exactly one success (BE-1).
- `too-large` when `env.ct.length > capabilities.maxEnvelopeBytes`.
- Any other failure → `quota` (store said so) or `network`.
- Never log or persist `id` beyond serving the request (BE-2). No identity (BE-5).
- `getMany` default (provided by core when absent): `Promise.all(ids.map(get))`.

### 9.2 `MemoryBackend`

`Map<string, Envelope>`; `writeAuth: true` (verifies the chain exactly as the rules do, including
hashing the `tok` text with WebCrypto SHA-256); `subscribe: true` (synchronous listeners, used by
tests); `keepalive: true`; `maxEnvelopeBytes: 1_000_000`. Test hooks: `failNext(code)`,
`latencyMs`, `dump()` (for the "store contains nothing readable" acceptance test).

### 9.3 `FirestoreBackend` over REST (D1)

Config: `{ projectId, apiKey, collection = "burrow", databaseId = "(default)" }`. `fromPage()` reads
`<meta name="burrow-firestore" content='{"projectId":"…","apiKey":"…"}'>` then
`window.BURROW?.firestore`, returns `null` if neither exists.

Base URL: `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents/${collection}`.
Every request carries header `x-goog-api-key: ${apiKey}` and `Content-Type: application/json`.

| Operation | HTTP | Notes |
|---|---|---|
| `get(id)` | `GET {base}/{id}` | 404 → `null`; 200 → decode `fields`; 403 → `unauthorized` |
| `put(id, env, null)` | `POST {base}?documentId={id}` body `{fields}` | 409 (`ALREADY_EXISTS` or `ABORTED`) → `conflict`; 403 → classify |
| `put(id, env, n)` | `PATCH {base}/{id}?currentDocument.exists=true` body `{fields}`, **no `updateMask`** | 409 `ABORTED` → `conflict`; 403 → classify; 404 → `conflict` |

Field encoding: `v`, `rev`, `ts` → `{ integerValue: String(n) }`; `iv`, `ct`, `tok`, `next` →
`{ stringValue }`; `z` → `{ booleanValue: true }` only when set. A number sent as `doubleValue` fails
`rev is int` (WP-00). Decoding is the inverse; a document with unexpected fields or types is `network`
(treated as corrupt, retried later, logged in debug). `PATCH` carries no `updateMask`, so it replaces
the whole document and a `z` from the previous revision cannot survive; with a mask it would merge.

Classifying 403 (`PERMISSION_DENIED`): read the document. If that read is itself 403 → `unauthorized`.
If the document does not exist or `stored.rev !== expectedRev` → `conflict`. Otherwise →
`unauthorized`. Cost: one read, only on rejection (Q2, D3). Rules allow every `get`, so a 403 on a read
is always a project- or key-level rejection: a wrong `projectId` (`CONSUMER_INVALID`), a disabled API,
or a key whose restrictions exclude the page. Retrying cannot fix it, and without the first rule a
misconfigured project would be reported as an endless `conflict`. The engine surfaces `unauthorized` as
`status: "error"` with code `backend`.

A `PATCH ?currentDocument.exists=true` on a missing document answers 403, not 404: rules run before
the precondition, and `update` fails on `resource == null`. The classifying read then finds no
document → `conflict`. The 404 row is kept defensively. `409 ABORTED` is Firestore reporting lost
contention on the document (WP-00: under 10 concurrent `PATCH`es at one rev, the losers got a mix of
403 and `ABORTED` every round). The write did not land, so `conflict` sends the engine down its
re-read-and-retry path instead of `network` backoff. Decision D19.

Error mapping: 429 or `RESOURCE_EXHAUSTED` → `quota`; 400 `INVALID_ARGUMENT` mentioning size, or
`ct.length > maxEnvelopeBytes` before sending → `too-large`; network failure, 5xx, `UNAVAILABLE`,
`DEADLINE_EXCEEDED` → `network`. Never branch on `error.message`; it is a diagnostic, not a contract.

Capabilities: `writeAuth: true`, `subscribe: false`, `keepalive: true`, `maxEnvelopeBytes: 1_000_000`.
`put(..., { keepalive: true })` passes `keepalive: true` to `fetch`.

WP-00 (`docs/platform-notes.md` §1–§2) verified on the emulator: the full request matrix above,
`request.auth == null` for key-only requests, atomic single-document writes under contention, and a
1 000 000-character `ct` fitting in one document. Against production it verified CORS from `https` and
`null` origins for `GET`/`POST`/`PATCH` with `x-goog-api-key`, on error responses. One run against a
real Spark project (`scripts/spikes`, `npm run prod`) is pending: the same matrix in production, plus
whether an HTTP-referrer-restricted key blocks `file://` pages (FS-12 vs NF-1).

### 9.4 Firestore rules (FS-1..9)

```
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents/burrow/{path} {
    function shape(d) {
      return d.keys().hasOnly(['v','iv','ct','rev','ts','tok','next','z'])
          && d.v == 1
          && d.rev is int && d.rev >= 0 && d.ts is int
          && d.iv is string && d.iv.size() == 16
          && d.ct is string && d.ct.size() <= 1000000
          && d.tok is string && d.tok.size() == 43
          && d.next is string && d.next.size() == 64
          && (!('z' in d) || d.z == true)
          && path.size() == 43;
    }
    allow get: if true;
    allow list: if false;
    allow create: if shape(request.resource.data) && request.resource.data.rev == 0;
    allow update: if shape(request.resource.data)
                  && request.resource.data.rev == resource.data.rev + 1
                  && hashing.sha256(request.resource.data.tok).toHexString().lower() == resource.data.next;
    allow delete: if false;
  }
}
```

`hashing.sha256(s)` hashes the UTF-8 bytes of `s`, and `toHexString()` returns **uppercase** hex
(WP-00, emulator). The `.lower()` is therefore required: clients store `next` as lowercase hex (§5.4),
and without it every update would be rejected.

The collection name is fixed in the rules file; `burrow-setup` rewrites it when the developer picks
another. `firebase.json` declares the rules file and the emulator port for tests.

## 10. Observability (ERR-1..4, NF-3)

`debug: true` logs one line per event through `util/log.ts`: `push {items, manifestRev, bytes, ms}`,
`pull {changed, reads, manifestRev, ms}`, `merge {key: "<redacted>", winner}`, `conflict {doc: "item"|"manifest", attempt}`,
`backoff {ms, code}`, `leader {role}`. Never ids, tokens, keys, values or the app's key names beyond a
count. `inspect()` returns `BurrowInspection` (§3).

## 11. Test strategy and vectors

| Layer | Tooling | What |
|---|---|---|
| Vectors | `test/vectors/*.json` generated by `scripts/gen-vectors.py` (Python `hashlib`/`hmac`/`cryptography`, independent of the TS code) | HKDF outputs for fixed roots and apps; `base`, `docId`; `tok`/`next` chains; sealed envelopes with fixed iv (decrypt-only vectors); sync codes incl. confusable decoding |
| Unit | vitest, node 20, `fake-indexeddb`, injectable clock | `util/*`, `crypto/*`, `cache/*`, `merge.ts`, API argument shapes, facade semantics, error mapping |
| Property | fast-check | `resolveKey`/`mergeManifests` commutativity, idempotence, convergence over random op sequences on 2–3 simulated devices with skewed clocks and 30-day tombstone horizon |
| Conformance | vitest suite parameterised by a `Backend` factory | BE-1..7, chain enforcement, concurrent put race (10 writers, exactly 1 success), too-large, run against `MemoryBackend` and the Firestore emulator |
| Rules | `@firebase/rules-unit-testing` + emulator | FS-13 matrix: create rev 0, chained update, wrong tok, skipped rev, extra field, oversize ct, wrong iv size, list, `in` query, delete |
| Browser | Playwright (Chromium, Firefox, WebKit); CDP virtual authenticator with `hasPrf` in Chromium | startup budget, IndexedDB persistence, two-tab leader + propagation, unload flush with keepalive (observed via a mock server), offline/online, passkey enrol/recover, strict-CSP demo page without console errors |
| Size | size-limit in CI | budgets in §2 |

Acceptance tests in `test/browser/acceptance.spec.ts` map one-to-one to the acceptance criteria list
in `docs/requirements.md`.
