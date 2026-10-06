> **Historical document.** This is the requirements brief the implementation was built from,
> snapshotted on 2026-10-01 (rev 79). Tests and code comments cite its requirement ids (`API-3`,
> `ENC-7`, `SYNC-10`, …), which is why it is kept. Where it disagrees with the code, the code and
> [`../architecture.md`](../architecture.md) describe what ships; [`../decisions.md`](../decisions.md)
> records every deliberate departure (for example the 749 000-byte item ceiling, the `(ts, h)`
> tie-break, and the sync code being shown to users as the *storage token*).

# Burrow — Requirements

2026-09-30

## Pitch

**Burrow** is a drop-in JavaScript library that gives a static website persistent, cross-device user data with no login and no backend of its own. A burrow is dug by its owner, hidden from everyone else, and found only by one who knows the entrance: the user's device holds the key, the site holds nothing, and the data sits encrypted at unguessable addresses in a shared free store that any prototype can reuse.

One-line integration target:

```ts
import { burrow } from "burrow-storage";
const store = await burrow({ app: "my-prototype" });
await store.set({ theme: "dark" });
const { theme } = await store.get("theme");
```

Published on npm as `burrow-storage`; the repo, class, global and docs use the bare name `Burrow`.

## Problem statement and design principles

Small sites need per-user state (preferences, drafts, progress) that survives a browser reset and follows the user across devices. Browser storage does neither; `chrome.storage.sync` is capped at 100 KB and extension-only; every hosted answer either demands a login, a backend to maintain, or a paid tier per project.

Burrow's answer is a **capability key** instead of an identity: the user holds a secret, the secret derives both an unguessable storage path and an encryption key, and the store itself is public but content-addressed and opaque. The design principles that follow from that, in priority order:

1. **No login.** The user never creates an account, enters an email, or sees a third-party consent screen. Identity is a secret they hold, not one a server knows.
2. **No backend.** The site ships static files only. The one shared store is configured once by the developer and reused by every prototype; the library must never require a per-site server, function, or database.
3. **Local-first.** Every read and write completes against the local cache immediately. Sync is background, best-effort, and never blocks the UI.
4. **Zero trust in the store.** The store sees only hashed paths and ciphertext. A full dump of the store must reveal nothing about any user.
5. **Swappable store.** The Firestore reference backend is one adapter behind a small interface; a site can move stores without touching application code.
6. **Familiar shape.** The API mirrors the browser's own storage interfaces so that adoption is mostly a find-and-replace.
7. **Graceful failure.** If sync is unavailable the site keeps working locally, and the user can always export and re-import their data by hand.

## Goals and non-goals

**Goals**

- Persist per-user key/value data across browser resets and devices with no user account and no site-owned server.
- Integrate in under ten lines on any static site: one script or import, one config object with the app id and store settings.
- Keep the free tier of the shared store sufficient for tens of prototypes with hobby-scale traffic, and make the worst case under abuse "sync pauses", never "a bill".
- Make the developer, the store operator, and anyone with a store dump unable to read user data.
- Allow the store to be replaced (Cloudflare Worker, S3-compatible bucket, self-hosted) by implementing one interface.
- Ship TypeScript types, ESM and a single-file browser build, with zero required runtime dependencies beyond the chosen backend's client.

**Non-goals**

- Multi-user or shared data (collaboration, leaderboards, aggregate analytics). Each key belongs to exactly one user.
- Real-time or sub-second sync. Eventually consistent within seconds is the target; a CRDT is out of scope.
- Large media or file payloads. Per-item sync is mandatory: the ceiling is 1 MiB per item (ENC-4) and the store's daily quota, and anything bigger belongs in a file host. A single-blob design is ruled out. Data is split into one document per item (see Encryption and Sync), so the limit is 1 MiB per item and the store's daily quota, and partial push/pull matches the `chrome.storage` contract.
- Identity in the usual sense: no emails, no profiles, no password reset. Losing the key means losing the data, and the library must make that clear.
- Server-side rendering support. The library is browser-only.
- Being a general Firestore/Firebase wrapper. Only the calls the adapter needs are used.

## Terminology

| Term | Meaning |
|---|---|
| **App** | One website or prototype, identified by a developer-chosen `app` id (e.g. `"budget-planner"`). Namespaces both the local cache and the remote path. |
| **Root secret** | The 32-byte secret a user holds. Generated silently on first use and persisted on the device wrapped under a non-extractable key, like a session cookie. Leaves the device only inside a passkey-wrapped keyslot or a sync code. |
| **Key provider** | An unlock method that carries the root secret to another device or back after a reset: passkey PRF (via a keyslot), sync code, or an app-supplied provider. Not needed for first use. |
| **Path** | An unguessable document id derived from the root secret and app id: one base id for the user's manifest, one id per item key. The store's only notion of "who". |
| **Vault** | One user's data for one app in the store: an encrypted manifest document (the key directory) plus one encrypted document per item, each with its own revision chain. |
| **Backend** | The adapter that reads and writes individual documents in a remote store (Firestore, Worker, …). |
| **Store** | The remote system a backend talks to. Shared across apps; configured once by the developer. |
| **Area** | The `StorageArea`-shaped object the app talks to: `get`, `set`, `remove`, `clear`, `onChanged`. |
| **Facade** | The synchronous `Storage`-compatible view (`getItem`/`setItem`) over the local cache, for drop-in replacement of `localStorage`. |
| **Sync code** | A human-typeable encoding of the root secret (e.g. 20 base32 characters) used to link a second device when passkeys are unavailable. |

## Architecture overview

*(Architecture diagram in the source doc: four layers — API, Core, Key providers, Backend adapters — with the backend interface as the one swappable seam. Redrawn in `../architecture.md`.)*

Site code talks to one of two shapes of the same store; the core keeps a local cache, encrypts vaults with a key from a key provider, and hands opaque bytes to whichever backend adapter is configured. Only the backend layer knows what the store is, so substituting Firestore means implementing that one interface.

Layer responsibilities:

1. **API layer** — `StorageArea` (async, primary) and the `Storage` facade (sync, over the cache). Both are thin; all logic lives below.
2. **Core** — local cache, vault codec (path derivation, encryption, versioning) and the sync engine (queueing, last-writer-wins merge, change events). Backend- and provider-agnostic.
3. **Key providers** — unlock methods that carry the device-generated root secret to another device or back after a reset. Pluggable; the default enrols a passkey (via a keyslot) and falls back to a sync code. Not needed for first use.
4. **Backend adapters** — get/put/delete an opaque vault at a path, with optimistic concurrency. Pluggable; Firestore is the reference implementation.

## Functional requirements: public API

The primary API mirrors the WebExtensions `chrome.storage.StorageArea` shape, because it is the browser's own answer to "synced key/value settings" and it is already asynchronous. A secondary facade implements the Web Storage `Storage` interface so `localStorage` call sites can be swapped with no other change.

### Entry point

```ts
export function burrow(config: BurrowConfig): Promise<BurrowArea>;

interface BurrowConfig {
  app: string;                       // required; [a-z0-9-]{1,64}
  backend?: Backend;                 // default: FirestoreBackend from a global/config block
  keyProvider?: KeyProvider | KeyProvider[];  // default: [passkey(), syncCode()]
  cache?: "indexeddb" | "memory";   // default: indexeddb
  rememberDevice?: boolean;          // default: true; false = keep the secret in memory only (KP-8)
  syncIntervalMs?: number;           // default: 30_000; 0 disables polling
  debounceMs?: number;               // default: 1_500 (coalesce writes before upload)
  maxItemBytes?: number;             // default: 200_000 per item (plaintext, before encryption)
}
```

- **API-1** `burrow()` MUST resolve with a usable secret and no user interaction: it loads the locally persisted secret if one exists, otherwise generates one (KP-1). Providers are only invoked by `link()` and `protect()`, both from a user gesture.
- **API-2** Multiple `burrow({app})` calls with the same `app` in one page MUST return the same instance.

### `BurrowArea` (StorageArea-shaped)

```ts
interface BurrowArea {
  get(keys?: null | string | string[] | Record<string, unknown>, opts?: { fresh?: boolean }): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  clear(): Promise<void>;
  getBytesInUse(keys?: null | string | string[]): Promise<number>;
  onChanged: EventTarget<{ changes: Record<string, { oldValue?: unknown; newValue?: unknown }>; source: "local" | "remote" }>;

  // Burrow-specific
  readonly status: "idle" | "syncing" | "offline" | "error";
  readonly protection: "none" | "passkey" | "code" | string;   // which unlock method is enrolled on this device's secret
  onStatus: EventTarget<{ status: BurrowArea["status"]; error?: BurrowError }>;
  onUnprotected: EventTarget<void>;      // fires once per device when data exists but no unlock method does (KP-14)
  protect(providerId?: string): Promise<void>;                  // enrol an unlock method for the current secret
  link(options?: { provider?: string; code?: string; discardLocal?: boolean }): Promise<void>;   // recover an existing secret onto this device
  unlink(): Promise<void>;               // forget the local secret (log out of this device); cache and remote stay
  syncNow(): Promise<void>;
  exportCode(): Promise<string>;         // the sync code for another device
  exportJSON(): Promise<string>;         // plaintext backup of this app's keys
  importJSON(json: string): Promise<void>;
  readonly storage: Storage;             // the facade, see below
}
```

- **API-3** `get`, `set`, `remove`, `clear` MUST accept the same argument shapes as `chrome.storage.StorageArea` and MUST resolve from the local cache without waiting on the network.
- **API-4** Values MUST be any structured-cloneable JSON value. Non-JSON values (functions, `Date`, `Map`) MUST throw a `TypeError` at `set()` time rather than silently serialising.
- **API-5** `onChanged` MUST fire for local writes (`source: "local"`) and for changes pulled from the store (`source: "remote"`), with the same `changes` shape as `chrome.storage.onChanged`. Events MUST be batched per sync pass, not per key.
- **API-6** `set()` MUST resolve once the write is durable locally. It MUST NOT reject because the remote is unreachable; remote failures surface through `onStatus`.
- **API-7** `link()` MUST try each configured provider's `recover()` in order, replace the device's secret with the recovered one on success, and reject with `BurrowError("no-provider")` if none succeeds. `link({code})` MUST accept a sync code without prompting. If the device already held a different secret with unsynced data, `link()` MUST reject with `would-orphan` unless `{ discardLocal: true }` is passed.
- **API-8** `unlink()` MUST zeroise the in-memory secret and remove the persisted wrapped secret, exactly as a logout clears a session cookie, and MUST leave the local cache and remote documents intact. The next `burrow()` on that device starts a fresh secret per KP-1.

### `Storage` facade

```ts
const store = await burrow({ app: "notes" });
const s = store.storage;           // implements the DOM Storage interface
s.setItem("draft", text);          // synchronous; write-behind to the cache and remote
window.myLocalStorage = s;         // drop-in
```

- **API-9** `storage` MUST implement `length`, `key(n)`, `getItem`, `setItem`, `removeItem`, `clear` with `Storage` semantics: string-only values, `null` for missing keys, synchronous.
- **API-10** The facade MUST be backed by an in-memory mirror of the cache that is fully loaded before `burrow()` resolves, so reads are correct from the first call.
- **API-11** Facade writes MUST be visible immediately to `getItem` and MUST be persisted to the cache asynchronously; the library MUST flush pending facade writes on `visibilitychange` to hidden and on `pagehide`.
- **API-12** The facade MUST NOT dispatch the window `storage` event (it is reserved for real Web Storage); it MUST forward changes to `onChanged` instead.

### Errors

- **API-13** All rejections MUST be `BurrowError` with a stable `code` from a documented enum (`no-provider`, `prf-unsupported`, `bad-code`, `item-too-large`, `backend`, `conflict`, `quota`, `decrypt-failed`, `would-orphan`) and an optional `cause`.

## Functional requirements: key providers

The root secret is generated on the device, silently, the first time an app is used; nothing is asked of the user. It is then persisted on that device the way a session cookie would be, so return visits need no prompt at all. Key providers are *unlock methods* layered on top: ways to get the same root secret onto another device, or back after a browser reset. A passkey is the default unlock method; a sync code is the fallback. Neither is required to start using the site, and both are pluggable.

```ts
interface KeyProvider {
  readonly id: string;                        // "passkey" | "sync-code" | custom
  available(): Promise<boolean>;              // feature-detect without prompting
  enrol(ctx: { app: string; rootSecret: Uint8Array }): Promise<void>;
      // protect the existing root secret with this method (e.g. create a passkey, write a keyslot)
  recover(ctx: { app: string; interactive: boolean; input?: string }): Promise<Uint8Array | null>;
      // get the root secret back on a new device; null = declined or not interactive-capable now
}
```

- **KP-1** On first use of an app on a device with no stored secret, the library MUST generate a 32-byte root secret with `crypto.getRandomValues`, persist it locally (KP-2), and begin syncing under it immediately. No provider is invoked and no UI is shown. This is the zero-friction path and it MUST always be available.
- **KP-2** The root secret MUST be persisted on the device across page loads and browser restarts, wrapped under a non-extractable AES-KW `CryptoKey` stored in the same IndexedDB (ENC-10). This is the equivalent of a login cookie: it survives until the user clears site data or calls `unlink()`, and it means a returning user is never prompted.
- **KP-3** `link()` MUST first try each configured provider's `recover()` in order (a returning user on a fresh device), and only if none yields a secret fall back to KP-1. `protect(providerId?)` MUST call `enrol()` on the chosen provider to attach an unlock method to the current secret. A site typically exposes one button, "Sync to another device", which calls `protect()` then shows the code or confirms the passkey.
- **KP-4** The root secret is one 256-bit random value for the user across all apps on the origin; per-app keys are derived from it (Derivation). Providers never replace it; they wrap or transport it.

### Passkey (WebAuthn PRF) — default

A passkey does not *become* the secret; it unlocks a **keyslot**, a small document in the store holding the root secret wrapped under a key derived from the passkey's PRF output. This keeps the root secret random and lets several methods (a passkey on each platform, a printed code) unlock the same data, in the way disk-encryption keyslots do.

- **KP-5** `enrol()` MUST create a discoverable credential with `navigator.credentials.create()`, `extensions: { prf: {} }`, `rp.id` = the site's registrable domain, `user.name` = a label the site supplies (default the app name; no email is requested), then evaluate PRF with a fixed library salt, derive `kek` and `slotId` (Derivation), and write the keyslot document `Envelope{ ct = AES-256-GCM(kek, rootSecret) }` at `slotId` through the normal backend `put`, chained like any document.
- **KP-6** `recover()` MUST call `navigator.credentials.get()` with `extensions: { prf: { eval: { first: <salt> } } }`, derive `kek` and `slotId`, `get` the keyslot, unwrap, and hand back the root secret. One passkey prompt per new device; thereafter KP-2 applies and the passkey is not touched again on that device.
- **KP-7** `available()` MUST return false when `PublicKeyCredential` is undefined, when `create()` returns no `prf.enabled`, or when the platform has no user-verifying authenticator; the library MUST then fall through to the next provider without an error.
- **KP-8** Because PRF evaluation needs user verification, `enrol()` and `recover()` MUST only be called from a user gesture (`interactive: true`). A site MAY set `rememberDevice: false` to disable KP-2 and require the passkey on every session instead, for shared-computer scenarios.
- **KP-9** The credential id MUST be cached locally so `get()` can pass `allowCredentials` and skip the account chooser when a device is re-linked.
- **KP-10** Cross-ecosystem recovery (an Apple passkey used on Windows) is expected to work through the hybrid/QR flow. The docs MUST state that PRF support is uneven and that the sync code is the guaranteed path.

### Sync code — fallback and portability

- **KP-11** `exportCode()` MUST encode the root secret as Crockford base32 with a 1-byte version prefix and a 2-byte checksum, grouped in blocks of 4 (e.g. `L1-2K9F-8WMA-…`), 56 characters before hyphens. Decoding MUST be case-insensitive and ignore hyphens, spaces and O/0, I/1 confusions. The sync-code provider's `enrol()` is exactly this export; its `recover({input})` is the decode.
- **KP-12** `link({code})` MUST verify the checksum and reject with `bad-code` before any network call.
- **KP-13** The code MAY also be offered as a URL fragment (`#burrow=<code>`) and a QR string for device-to-device transfer; the library MUST strip the fragment from `location` after reading it and MUST persist the recovered secret per KP-2.
- **KP-14** The library MUST expose an `onUnprotected` hook that fires once per device when data exists but no unlock method has been enrolled, so a site can show a low-key "back this up / sync to another device" prompt at a moment of its choosing rather than at first load.

### Custom providers

- **KP-15** A site MAY supply its own provider (a passphrase through Argon2id, a hardware key, a QR handshake). It implements `enrol`/`recover` and the library MUST treat it like any other provider and MUST NOT special-case the built-ins.

## Functional requirements: encryption and path derivation

Everything the store sees is derived from the root secret through one-way functions, so a store dump reveals neither who a vault belongs to nor what it contains. All primitives are WebCrypto; no third-party crypto library is permitted.

### Derivation

```
ikm       = root secret (32 bytes, random, KP-1)
prk       = HKDF-Extract(SHA-256, salt = "burrow/v1", ikm)
pathKey   = HKDF-Expand(prk, info = "path" || app, 32)
encKey    = HKDF-Expand(prk, info = "enc"  || app, 32)     // AES-256-GCM key, all documents
macKey    = HKDF-Expand(prk, info = "auth" || app, 32)     // write-token chains
base      = base64url(SHA-256(pathKey))[0:43]                 // id of the user's manifest document
docId(k)  = base64url(HMAC-SHA-256(pathKey, "item" || k))[0:43]  // id of the document for item key k

// Passkey keyslot (KP-5/6): the PRF output plays the role of ikm for its own small key set
sprk      = HKDF-Extract(SHA-256, salt = "burrow/slot/v1", prfOutput)
kek       = HKDF-Expand(sprk, info = "kek", 32)             // wraps the root secret
slotMac   = HKDF-Expand(sprk, info = "auth", 32)            // write chain for the keyslot document
slotId    = base64url(SHA-256(HKDF-Expand(sprk, "slot", 32)))[0:43]
```

- **ENC-1** `base` MUST be unique per (root secret, app) and `docId(k)` unique per (root secret, app, item key). Item key names MUST never appear in the store in the clear: ids are keyed hashes, and the list of keys lives only inside the encrypted manifest.
- **ENC-2** Derivation MUST be deterministic and versioned: the `v1` salt string and info labels are frozen; any change is a new version with a migration path.
- **ENC-3** Sync codes derived from typed input (KP-2) MUST first pass through PBKDF2-SHA-256 with at least 600,000 iterations (WebCrypto has no Argon2) before becoming `ikm`. Random secrets skip this step; the version prefix in the code says which applies.

### Document formats

```ts
// Every stored document, manifest and item alike, has this shape.
interface Envelope {
  v: 1;
  iv: string;        // 12 bytes, base64url, fresh per write
  ct: string;        // AES-256-GCM(encKey, iv, plaintext, aad = docId || app || String(rev))
  rev: number;       // monotonically increasing per document
  ts: number;        // writer's wall clock, ms
  tok: string;       // one-time write token for THIS rev, see ENC-7
  next: string;      // sha256 of the token the NEXT rev must present
  z?: true;          // plaintext was deflate-raw compressed
}

// Plaintext of the manifest document (id = base): the user's key directory.
interface Manifest {
  v: 1;
  items: Record<string, { ts: number; deleted?: true }>;   // item key -> last-write time, tombstone
}

// Plaintext of an item document (id = docId(key)).
interface Item {
  v: 1;
  key: string;
  value: unknown;    // any JSON value; null after deletion (document is never removed, see FS-5)
  ts: number;
}
```

- **ENC-4** Plaintext MUST be UTF-8 JSON; the library MUST compress with `CompressionStream("deflate-raw")` when available and set `z`. An item's plaintext MUST be capped at `maxItemBytes` (default 200 KB, hard ceiling 900 KB to stay under Firestore's 1 MiB document limit) with `item-too-large` before encrypting. The manifest is small by construction (a few dozen bytes per key) and MUST reject when it would exceed 900 KB.
- **ENC-5** The IV MUST come from `crypto.getRandomValues` for every write; the envelope MUST bind `docId`, `app` and `rev` as GCM additional authenticated data so a document cannot be replayed to another id or an older revision. The manifest's AAD uses `base` as its id.
- **ENC-6** Decryption failure on any document MUST surface as `decrypt-failed`, MUST NOT overwrite the local cache, and MUST pause sync until the user re-links (the usual cause is a wrong sync code).

### Write authorisation without accounts

A public-writable id means anyone who learns it can overwrite it. Each document, manifest and item alike, carries its own write-token chain, so knowing one id never grants writes to another:

- **ENC-7** Writes MUST be gated by a hash chain of one-time tokens that a rules engine can check with SHA-256 alone: `tok(id, n) = base64url(HMAC-SHA-256(macKey, id || n))`. A document at revision `n` stores `next = hex(SHA-256(tok(id, n+1)))`. A write to revision `n+1` MUST present `tok(id, n+1)` in `tok` and set `next = hex(SHA-256(tok(id, n+2)))`; the store accepts it only if `SHA-256(tok) == stored next` and `rev == stored rev + 1`. A consumed token is useless once stored, only the secret holder can compute future tokens, and readers still need nothing but the id.
- **ENC-8** The `rev == stored rev + 1` check doubles as optimistic concurrency per document; a rejected write MUST be treated as `conflict`, and the client MUST re-fetch that document, merge (see Sync) and retry with the fresh `next`. The manifest is the only document two devices routinely contend on.
- **ENC-9** If a backend cannot enforce the chain, the adapter MUST declare `capabilities.writeAuth = false` and the library MUST warn once in the console in development builds.

### Local cache at rest

- **ENC-10** The local cache MUST store items in plaintext (it stands in for `localStorage`, which is also plaintext) and MUST persist the root secret only wrapped under a non-extractable AES-KW `CryptoKey` held in the same IndexedDB (`CryptoKey` objects are storable and non-extractable). This is the device's session: a copied database is not enough to derive any id or key, but a script running on the origin can use the secret, exactly as it could read a session cookie. With `rememberDevice: false` nothing is persisted and the secret lives in memory for the page's lifetime.
- **ENC-11** A keyslot document is an ordinary `Envelope` whose `ct` is `AES-256-GCM(kek, rootSecret)` with AAD `slotId || "slot"`, written and chained with `slotMac`. The store cannot distinguish it from an item. Losing the passkey loses only that keyslot; the data stays reachable through any other enrolled method.

## Functional requirements: local cache, sync and conflict resolution

The cache is the source of truth for the UI; the remote documents are a replica that devices converge on. Data is split per item, so pushes and pulls move only the keys that changed, exactly as `chrome.storage` semantics imply. Merge is per-key last-writer-wins with tombstones, which is enough for single-user settings and needs no coordination.

### Local cache

- **SYNC-1** The cache MUST be one IndexedDB database per origin named `burrow`, with an object store per app, so clearing one app never touches another. A `memory` cache MUST be selectable for tests and private-mode fallbacks.
- **SYNC-2** Each cached item MUST carry `{ value, ts, deleted?, dirty?, rev?, next? }`. `ts` is the writer's wall clock in ms; `dirty` marks items not yet uploaded; `rev`/`next` are the last known state of that item's remote document.
- **SYNC-3** The cache MUST also hold: the manifest's last known `rev` and `next`, the wrapped secret (if any), the passkey credential id, and the last successful sync time.
- **SYNC-4** If IndexedDB is unavailable (some private modes), the library MUST fall back to `memory` and set `status` to `offline` rather than fail.

### Sync engine

- **SYNC-5** Pushes MUST be debounced (`debounceMs`) and coalesced, then written as: each dirty item document (in parallel, each on its own chain), then the manifest once, last. Writing the manifest last means a crash mid-push leaves at most some items unreferenced, which the next push re-lists; it never leaves the manifest pointing at data that is not there. A push MUST be attempted on `visibilitychange` → hidden and on `pagehide` using `fetch` with `keepalive: true` where the adapter supports it.
- **SYNC-6** A pull MUST read the manifest first and then fetch only the item documents whose manifest `ts` is newer than the cached `ts` (or unknown locally). A pull with nothing newer costs one read. Pulls happen on `link()`, on page focus/visibility → visible, on `syncNow()`, and every `syncIntervalMs` while visible. Adapters with `capabilities.subscribe` MUST subscribe to the manifest only and fetch changed items on each notification.
- **SYNC-7** `get(keys)` on a linked store MAY fetch those specific item documents directly (ids are computable without the manifest) when the site passes `{ fresh: true }`; the default `get` answers from the cache without a network round trip (API-3).
- **SYNC-8** Every remote write MUST be a read-merge-write on that document: fetch, verify `rev`, merge into the cache, write at `rev + 1` with the correct `tok`/`next`. On `conflict`, retry up to 3 times with jittered backoff (200 ms, 800 ms, 3 s) then surface `status: "error"` and keep the items dirty. Because item documents are only ever written by the holder of the same secret, conflicts on items are rare; manifest conflicts are expected and MUST be resolved by merging the two key maps under the rules below.
- **SYNC-9** Network and quota failures MUST use exponential backoff capped at `max(syncIntervalMs, 5 min)`; dirty items MUST never be dropped.

### Merge rules

- **SYNC-10** For each key, the entry with the greater `ts` wins; ties are broken by comparing the serialised value bytewise so both sides converge. Tombstones live in the manifest (`deleted: true`) and participate like any value; they MUST be kept for 30 days before being pruned, so a delete on device A is not resurrected by a stale device B.
- **SYNC-11** Clock skew MUST be mitigated: the library MUST record the greatest remote `ts` seen on each pull and, if a local write would carry a `ts` lower than it, bump it to `remote ts + 1`. The library MUST NOT depend on server timestamps, since not every backend has them.
- **SYNC-12** `remove(key)` MUST mark the key deleted in the manifest and overwrite the item document with `value: null` on the next push, releasing its storage; `clear()` does the same for every known key. Documents are never deleted (FS-5).
- **SYNC-13** After a pull that changed any key, `onChanged` MUST fire once with `source: "remote"` listing only keys whose visible value changed.

### Multi-tab

- **SYNC-14** Tabs of the same origin MUST coordinate through `BroadcastChannel("burrow:" + app)` (fall back to `storage` events on a sentinel `localStorage` key) so a write in one tab updates the others' in-memory mirrors and only one tab (`navigator.locks` when available) performs remote sync at a time.

## Backend adapter contract

A backend stores opaque envelopes at opaque ids and enforces the revision chain per document. It knows nothing about keys, apps, users, manifests or encryption; a manifest and an item look identical to it. This is the substitution point: Firestore, a Cloudflare Worker, an S3-compatible bucket with a tiny proxy, or an in-memory test double all implement the same five members.

```ts
interface Backend {
  readonly id: string;                                  // "firestore" | "worker" | ...
  readonly capabilities: {
    writeAuth: boolean;      // enforces the tok/next chain server-side (ENC-7)
    subscribe: boolean;      // can push changes for one document id
    keepalive: boolean;      // put() survives page unload
    maxEnvelopeBytes: number;
  };

  get(id: string): Promise<Envelope | null>;                 // null = not found
  getMany?(ids: string[]): Promise<(Envelope | null)[]>;     // optional batching; default = parallel get()
  put(id: string, env: Envelope, expectedRev: number | null): Promise<void>;
      // expectedRev null = create (must not exist); otherwise must equal stored rev.
      // rejects BackendError("conflict") | ("unauthorized") | ("too-large") | ("quota") | ("network")
  subscribe?(id: string, onChange: (env: Envelope) => void): () => void;
}
```

- **BE-1** `put` MUST be atomic with respect to the revision check: two concurrent writers at the same `expectedRev` MUST result in exactly one success and one `conflict`.
- **BE-2** Adapters MUST NOT log, index or otherwise retain `path` beyond what the store itself needs to serve it. Paths are secrets.
- **BE-3** Adapters MUST be constructible with a plain config object and no build step (`new FirestoreBackend({ projectId, apiKey, collection })`), and MUST lazy-load their SDK so sites that use a different backend do not pay for it.
- **BE-4** Adapters MUST map every failure to a `BackendError` with one of the listed codes; unknown errors map to `network` and are retried.
- **BE-5** Adapters MUST NOT require a user identity of any kind. If a store needs a credential to accept anonymous traffic (an API key, an anonymous session), the adapter obtains it silently and it MUST be safe to publish in page source.
- **BE-6** A `MemoryBackend` MUST ship with the library, implement `writeAuth: true`, and be used by the conformance test suite that every adapter MUST pass (see Acceptance criteria).
- **BE-7** Adapters SHOULD implement `subscribe` where the store offers it at no extra cost (Firestore `onSnapshot`), and MUST make it a no-op fallback to polling otherwise.

Planned adapters, in order: `firestore` (reference, ships with v1), `memory` (ships with v1), `worker` (Cloudflare Worker + KV/D1, with the ~50-line Worker source in the repo), `http` (generic REST for self-hosters: `GET/PUT /vaults/{path}` with `If-Match`).

## Reference backend: Firestore (Spark plan)

One Firestore project on the free Spark plan serves every app. It is chosen because it needs no card, never pauses, has hard daily quotas instead of a meter, allows unauthenticated access gated by rules, and its rules language can evaluate SHA-256, which is all the write chain needs.

### Data layout

- **FS-1** One collection, default name `burrow`; document id = `base` for a user's manifest or `docId(key)` for an item. Manifest and item documents are indistinguishable to the store. No subcollections, no per-app collections: the app is already folded into the ids.
- **FS-2** Document fields are exactly the `Envelope` fields (`v, iv, ct, rev, ts, tok, next`, plus `z: true` when deflated). No other fields are allowed; rules reject them.
- **FS-3** The adapter MUST use the modular Firebase JS SDK (`firebase/firestore` only; no `firebase/auth`), initialised with the public web config. The config MUST be readable from a `<meta name="burrow-firestore">` tag or a `window.BURROW` object so a script-tag integration needs no bundler.
- **FS-4** Multi-document reads MUST be issued as parallel `getDoc` calls, not as an `in` query on `documentId()`: a query needs `list` permission, which rules deny.

### Security rules

```
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents/burrow/{path} {
    function shape(d) {
      return d.keys().hasOnly(['v','iv','ct','rev','ts','tok','next','z'])
          && d.v == 1
          && d.rev is int && d.ts is int
          && d.iv is string && d.iv.size() == 16
          && d.ct is string && d.ct.size() <= 1000000       // keeps the document under Firestore's 1 MiB
          && d.tok is string && d.tok.size() <= 64
          && d.next is string && d.next.size() == 64
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

- **FS-5** `list` MUST stay denied: enumeration is the one thing that would break the id-as-capability model. This is also why the manifest exists: it is the only way a client learns which item documents belong to a user.
- **FS-6** `delete` MUST stay denied; removal is a manifest tombstone plus an overwrite of the item with `value: null` (SYNC-12). Abandoned documents are bounded by the size cap and MAY be reaped by an owner-run script after 12 months without writes.
- **FS-7** The create rule accepts any well-formed first write at an unused id. This is by design (a new user's first sync, a new key's first document) and safe because ids are unguessable; the size cap bounds abuse per document and Spark's 20K writes/day bounds it globally.
- **FS-8** The adapter MUST implement `put` with a transaction (`runTransaction`) that reads the document, checks `rev`, and writes, so BE-1 holds even though rules also enforce it; a rules rejection (`permission-denied`) MUST be mapped to `conflict` when the local `expectedRev` is stale and to `unauthorized` otherwise.
- **FS-9** `subscribe` MUST use `onSnapshot` on the manifest document only; changed items are fetched on notification (SYNC-6). The adapter MUST detach the listener when the page is hidden for more than 5 minutes to stay within connection quotas.

### Operating requirements

- **FS-10** The repo MUST include `firestore.rules`, a `firebase.json`, and a one-command setup (`npx burrow-setup firestore`) that prints the exact console steps: create project, enable Firestore in production mode, deploy rules, restrict the API key. No Auth product is enabled, so no authorised-domain step exists.
- **FS-11** Documentation MUST state the Spark ceilings (1 GiB storage, 50K reads / 20K writes / 20K deletes per day), what one sync costs (a pull is 1 read plus 1 per changed item; a push is 1 write per changed item plus 1 for the manifest), and that hitting a ceiling pauses sync until the daily reset, with no possibility of a bill while the project stays on Spark.
- **FS-12** The `apiKey` in the web config is an identifier, not a secret; docs MUST say so and MUST recommend restricting it to the developer's domains in the Cloud console.
- **FS-13** Rules unit tests (Firebase emulator) MUST cover: create at rev 0, valid chained update, wrong `tok`, skipped `rev`, extra field, oversize `ct`, list attempt (including an `in` query on document ids), delete attempt.

## Security and privacy requirements

The threat model assumes the store is public, the developer is honest but not trusted with data, and the network is hostile. The one asset is the root secret; everything else is derived from it or is ciphertext.

| Threat | Mitigation | Requirement |
|---|---|---|
| Store dump (operator, breach, subpoena) | Paths are hashes, contents are AES-GCM ciphertext, no user identifiers stored | ENC-1, ENC-5, FS-2 |
| Enumeration of vaults | `list` denied; 256-bit path space | FS-4 |
| Path learned by an attacker (leaked URL, logs) | Read exposes ciphertext only; write needs the token chain | ENC-7 |
| Overwrite / vandalism of a known path | Hash-chain write tokens; rev must advance by one | ENC-7, ENC-8 |
| Replay of an old vault to a path | `rev` and `path` bound as GCM AAD; store rejects rev ≤ current | ENC-5, FS rules |
| Weak typed secret brute-forced offline | Random 256-bit secrets by default; typed passphrases go through PBKDF2 ≥ 600K iterations | KP-2, ENC-3 |
| Malicious script on the site (XSS, compromised CDN) | Out of scope for the library, same as `localStorage`; docs recommend SRI and CSP | SEC-6 |
| Copied IndexedDB from a device | Wrapped secret under a non-extractable `CryptoKey` | ENC-10 |
| Abuse of the shared store (junk writes, quota exhaustion) | Size cap per vault, Spark hard quotas, no delete, no list; worst case sync pauses | FS-6, FS-10 |
| Lost secret | Not recoverable by design; sync code export, JSON export, clear UX | SEC-3 |

- **SEC-1** The library MUST never send the root secret, `pathKey`, `encKey` or `macKey` over the network, MUST never write them to `localStorage`, `sessionStorage`, cookies or the URL, and MUST zeroise `Uint8Array` copies after import into `CryptoKey` objects.
- **SEC-2** All keys imported into WebCrypto MUST be non-extractable except the root secret while it is being encoded for `exportCode()`.
- **SEC-3** Docs and the default UI hooks MUST make the no-recovery property explicit: "Burrow cannot reset your data. Keep your sync code." `exportCode()` MUST be reachable from the public API at any time while linked.
- **SEC-4** The library MUST NOT collect telemetry, contact any host other than the configured backend, or load remote scripts at runtime.
- **SEC-5** The library MUST run correctly under a strict CSP (`default-src 'self'` plus the backend's host) and MUST NOT use `eval`, `new Function`, or inline scripts.
- **SEC-6** The published bundle MUST ship with SRI hashes and a signed provenance attestation (npm provenance); docs MUST show the SRI form of the script tag.
- **SEC-7** Passkey credentials MUST be created with `residentKey: "required"`, `userVerification: "required"`, and MUST NOT request attestation.
- **SEC-8** Errors and status events MUST NOT include the path, tokens or key material; `BurrowError.cause` MAY include the backend's error object but the library MUST scrub `path` from it.
- **SEC-9** The cryptographic design (Derivation, Vault format, Write authorisation) MUST be documented in a `SECURITY.md` with the threat table above, and SHOULD receive an external review before a 1.0 tag.

## Non-functional requirements

| Area | Requirement |
|---|---|
| Language | TypeScript, `strict`, ES2022 target; public types exported from one `index.d.ts` |
| Packaging | ESM (`import { burrow } from "burrow-storage"`), plus a single-file IIFE build (`burrow.min.js`, global `Burrow`) for script-tag use; side-effect free, tree-shakeable |
| Size | Core + memory backend ≤ 12 KB min+gzip; Firestore adapter loads `firebase/firestore` lazily and is not counted; passkey provider ≤ 2 KB |
| Runtime dependencies | None in core. Adapters may depend on their store's SDK only. Build/test tooling is unconstrained |
| Browser support | Last 2 versions of Chrome, Edge, Firefox, Safari, plus iOS Safari and Android Chrome; requires WebCrypto, IndexedDB, `BroadcastChannel`; PRF is optional and feature-detected |
| Performance | `burrow()` resolves in < 50 ms on a warm cache (excluding backend SDK load); `get`/`set` complete in < 5 ms; a sync round-trip costs one manifest read plus one read per changed item, and one write per changed item plus one manifest write |
| Offline | Full read/write functionality with no network; sync resumes automatically |
| Frameworks | Framework-agnostic; optional thin wrappers (`useBurrow` for React, a Svelte store) live in separate packages and are not required |
| Docs | README with the 10-line integration, a `localStorage` migration recipe, backend setup guide, and a hosted demo on a static host |
| Licence | MIT |
| Versioning | SemVer; the vault format `v` and derivation salt are part of the public contract and change only with a major version and a migration |

- **NF-1** The library MUST work when served from `file://` for local prototyping, except for passkeys (WebAuthn requires a secure origin); the sync-code provider MUST cover that case.
- **NF-2** The library MUST NOT patch globals or register service workers.
- **NF-3** A `debug` flag MUST enable structured console logging of sync events without ever logging secrets or paths (SEC-8).

## Error handling and observability

Failures are reported through `status` and `onStatus`, never by rejecting a local read or write. The site decides whether to show anything; the library only guarantees it never loses local data and never throws for remote reasons.

| Situation | `status` | Site sees | Library does |
|---|---|---|---|
| No unlock method enrolled | `idle`, `protection: "none"` | `onUnprotected` fires once; a "sync to another device" button | Syncs normally; data recoverable only from this device |
| Sync healthy | `idle` / `syncing` | `onChanged` remote events | Debounced push, periodic pull |
| Network down or backend 5xx | `offline` | Optional "offline" badge | Backoff, keep dirty items |
| Quota exhausted (Spark daily cap) | `offline` with `error.code = quota` | Same as offline | Retry after the reset window |
| Wrong code / foreign vault | `error` with `decrypt-failed` | Prompt to re-link | Pause sync; cache untouched |
| Persistent write conflict | `error` with `conflict` | Optional "sync stuck" notice | Keep retrying on next trigger |
| Item over size cap | `set()` rejects `item-too-large` | Handle at call site | Nothing written |

- **ERR-1** `set()` and facade `setItem()` MUST be the only places that reject synchronously-detectable problems (`TypeError`, `item-too-large`). Everything else is asynchronous status.
- **ERR-2** `onStatus` MUST fire on every transition and carry the last `BurrowError`, so a site can render one badge from one listener.
- **ERR-3** With `debug: true`, the library MUST log one line per sync event (`push`, `pull`, `merge`, `conflict`, `backoff`) with rev numbers, byte counts and durations, and MUST NOT log paths, tokens, keys or values.
- **ERR-4** The library MUST expose `store.inspect()` returning a plain object (status, rev, dirty key count, last sync time, backend id, provider id) for support and for the demo page's debug panel.

## Acceptance criteria and test plan

v1 is done when a new static site can add Burrow in under ten lines, a user's data reaches a second device through either a passkey or a typed code, and the store contains nothing readable.

### Acceptance criteria

- A demo page on a static host persists a theme and a text draft across a full browser data reset on the same device after re-linking with a passkey.
- The same data appears on a second device (different OS) after entering the sync code, within 30 s of linking, with no account created anywhere.
- Replacing `localStorage` with `store.storage` in an existing sample app requires no other code change and passes that app's tests.
- Two devices editing different keys offline then reconnecting converge with both changes; editing the same key converges on the later write on both.
- Deleting a key on device A removes it on device B, and a stale device C does not resurrect it.
- A dump of the Firestore collection contains only 43-character ids and envelope fields; no field decrypts without the secret.
- With a stolen path but no secret, `get` succeeds (ciphertext), `update` is rejected by rules, `list` and `delete` are rejected.
- Swapping `FirestoreBackend` for `MemoryBackend` and for a `WorkerBackend` stub passes the same conformance suite unchanged.
- Core bundle ≤ 12 KB min+gzip; `burrow()` ≤ 50 ms warm; strict-CSP demo page runs without console errors.
- Rules tests, unit tests and cross-browser tests pass in CI on every push.

### Test plan

| Layer | Method | Covers |
|---|---|---|
| Derivation & crypto | Unit tests with fixed vectors committed to the repo | ENC-1..ENC-5, KP-9/10, deterministic output across engines |
| Merge | Property-based tests (fast-check) over random op sequences and clocks | SYNC-9..SYNC-12: convergence, tombstones, skew |
| Backend conformance | One suite run against `MemoryBackend`, Firestore emulator, and any new adapter | BE-1..BE-7, ENC-7/8 chain behaviour |
| Firestore rules | `@firebase/rules-unit-testing` against the emulator | FS-12 matrix |
| API surface | Unit tests mirroring `chrome.storage` argument shapes and `Storage` semantics | API-1..API-13 |
| Browser integration | Playwright across Chromium, Firefox, WebKit; virtual authenticator with PRF in Chromium | KP-3..KP-8, multi-tab, unload flush, offline/online |
| Bundle & CSP | Size check in CI; demo served with strict CSP under Playwright | NF table, SEC-5 |

## Open questions and future work

Decisions still needed before implementation starts:

- **Sync-code entropy for typed secrets.** KP-2/ENC-3 allow a passphrase provider; decide whether v1 ships it at all or ships only random secrets plus codes.
- **Firestore `hashing.sha256` availability.** Verify in the emulator and production that `hashing.sha256(string).toHexString()` behaves as the rules assume before committing to the chain design; fall back to a Worker-verified chain if not.
- **Name: Burrow.** Decided. The brand word stands alone for the repo, class, global and docs; the npm package adds `-storage` because it implements the browser `Storage`/`StorageArea` contract. Run `npm view burrow-storage` before publishing; fall back to a scoped name if taken.
  - **Burrow**: dug by its owner, hidden from everyone else, found only by one who knows the entrance. Repo burrow, npm burrow-storage, global Burrow.


Future work, not in v1:

- Cloudflare Worker backend with the reference Worker source and a `wrangler` template.
- Generic `http` backend for self-hosters (S3-compatible bucket behind a 20-line signing proxy).
- Optional user-owned backend: Google Drive `appDataFolder` behind the same `Backend` interface, for sites willing to accept a Google popup in exchange for no shared store at all.
- Shared (multi-user) vaults with a per-vault write key, for small collaborative prototypes.
- Chunked items for single values above the per-document limit.
