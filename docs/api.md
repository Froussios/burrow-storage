# API reference

Everything exported by `burrow-storage` and its entry points, with the behaviour that matters to a
caller. The source of truth is `src/types.ts` (and `src/passkey.ts` for the passkey utility); this
page explains it. Terms: the **storage token** is the user's secret, a 56-character string; the
**core** is the remote-only store `burrow()` returns; the **offline wrapper** is the optional
local copy `offline()` puts in front of it (D-57).

## Entry points

```js
import { burrow, generateToken, MemoryBackend, BurrowError } from "burrow-storage";
import { offline } from "burrow-storage/offline";
import { passkeyToken } from "burrow-storage/passkey";
import { FirestoreBackend } from "burrow-storage/firestore";
```

| Export | From | What |
| --- | --- | --- |
| `burrow(config)` | `burrow-storage` | Open the store for one app with a backend and a token |
| `generateToken()` | `burrow-storage` | A fresh random storage token, for an app that keeps its own |
| `MemoryBackend` | `burrow-storage` | In-memory store for tests and demos |
| `BurrowError`, `BackendError` | `burrow-storage` | Error classes with a stable `code` |
| `BurrowEvent` | `burrow-storage` | The event class used by the offline wrapper's `onChanged` and `onStatus` |
| `registerBackend(type, factory)` | `burrow-storage` | Register a lazy adapter factory before opening stores |
| `readBackendConfig()`, `readFirestoreConfig()` | `burrow-storage` | Read the page's backend config, to pass to `burrow()` |
| `offline(store)` | `burrow-storage/offline` | Optional: a plaintext local copy for offline use |
| `passkeyToken(options)` | `burrow-storage/passkey` | Optional: a storage token derived from a passkey |
| `FirestoreBackend` | `burrow-storage/firestore` | The reference backend (needs the optional `firebase` peer dependency) |
| all types | `burrow-storage` | `BurrowStorage`, `OfflineStorage`, `BurrowConfig`, `Backend`, `Envelope`, … |

The script-tag build `dist/burrow.min.js` exposes all of the above, `offline`, `passkeyToken` and
`FirestoreBackend` included, on the global `Burrow`. It loads the Firestore SDK on first use from
`burrow-firestore.js` next to itself.

## `burrow(config): Promise<BurrowStorage>`

Opens the store for one app. It validates the config and the token and derives the keys, with no
network access and no user interaction, so it resolves offline too. Every call opens a new,
independent instance. It needs a secure context (HTTPS or `localhost`), because WebCrypto does.

```ts
interface BurrowConfig {
  app: string;
  backend: Backend | BackendConfig;
  token: string;
}
```

| Option | Behaviour |
| --- | --- |
| `app` | Required. Names the app, `/^[a-z0-9-]{1,64}$/`, else `TypeError`. The same token gives each app its own keys and documents; pages that pass the same `app` and token share the data. |
| `backend` | Required. An adapter instance, or `{ type, …options }` for a registered factory (`firestore` is built in). Missing, an unregistered type or a malformed instance rejects with `TypeError`; a factory that throws rejects `BurrowError("backend", "backend configuration failed")`, with no cause so configuration values cannot leak. Burrow never reads page config by itself: pass `readBackendConfig()` to use it. |
| `token` | Required. The storage token, from `generateToken()`, `passkeyToken().get()` or wherever the app keeps it. Case, spaces and hyphens do not matter, and O, I and L read as 0, 1 and 1. Anything malformed, with a bad checksum or an unknown version, rejects `bad-token`. Burrow never generates or remembers one by itself. |

The store keeps only the keys derived from the token, in memory, until `close()`. It writes
nothing to disk. What the app does with the token is the app's responsibility; see
[sync-and-tokens.md](sync-and-tokens.md).

## `BurrowStorage`

What `burrow()` resolves to, and what `offline()` extends. The argument shapes are those of
`chrome.storage`'s `StorageArea`. It is declared, with a comment on every member, in
[`src/types.ts`](../src/types.ts):

```ts
interface BurrowStorage {
  get(keys?: GetKeys): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  clear(): Promise<void>;
  close(): void;
}
type GetKeys = null | undefined | string | string[] | Record<string, unknown>;
```

| Member | Behaviour |
| --- | --- |
| `get()` / `get(null)` | Every live key. |
| `get("k")`, `get(["a", "b"])` | The keys that exist. |
| `get({ a: 1, b: "x" })` | Stored values, with the object's values as defaults for missing keys. |
| `set(items)` | Validates every key first, so an invalid batch writes nothing: values must be JSON (`undefined`, `NaN`, `Infinity`, functions, `Date`, `Map`, class instances and cycles reject with `TypeError`), and each item must fit 200 000 bytes, measured as the UTF-8 length of `JSON.stringify({ v: 1, key, value, ts })` (`BurrowError("item-too-large")`). Writing a value equal to the current one is still a new write. |
| `remove(keys)` | Marks keys deleted; the tombstone reaches other devices. Keys that do not exist are ignored. |
| `clear()` | `remove()` of every key. |
| `close()` | Drops the keys and everything held in memory. Every later call rejects `BurrowError("closed")`. Nothing on disk changes. |

Values are structured-cloned on the way in and out, so callers never share objects with the store.

**The core** (`burrow()`) talks to the store on every call: `get()` reads it (one read per named
key; the manifest plus changed items for all keys), and `set()`, `remove()` and `clear()` resolve
once the store has the write. When the store cannot be reached, or refuses, the call **rejects**
and nothing is kept for later. A write made through the core counts as the latest: it is stamped
above whatever the store holds for that key, so it wins even against a device whose clock runs
ahead. The core has no events and no status; read again to see other devices' changes.

## `offline(store): Promise<OfflineStorage>`

Exported by `burrow-storage/offline`. Puts a local copy in front of a store from `burrow()` and
takes ownership of it: closing the result closes the store too. It reads only the device, so it
resolves offline; it still needs a store opened with the token, so it never starts without one.
Passing anything else, or a store that is already wrapped, rejects with `TypeError`; a closed
store rejects `closed`.

```ts
interface OfflineStorage extends BurrowStorage {
  readonly onChanged: BurrowEvent<ChangedEvent>;
  readonly status: Status;
  readonly onStatus: BurrowEvent<StatusEvent>;
  syncNow(): Promise<void>;
  forget(options?: { discardLocal?: boolean }): Promise<void>;
}
```

**The copy is plaintext.** Key names and values sit in this browser's IndexedDB unencrypted,
protected only by the device, like `localStorage`. The token and the keys are never written. Each
app and token has its own copy, so opening the wrapper with another token shows that token's
data and leaves the other copy, unsynced writes included, for when that token returns.

**Network first.** `get()` asks the store and merges the answer into the copy before answering;
`set()`, `remove()` and `clear()` store the write in the copy, then push it. Each waits for the
store up to 3 seconds and then answers from the copy, while the remote work finishes in the
background. After a remote failure, or while the browser reports no network, calls use the copy
at once until a retry succeeds. These calls never reject for remote reasons (API-3, API-6): a
write stored in the copy is kept until it reaches the store (SYNC-9).

**Conflicts.** A write made while the store answers counts as the latest, as with the core. A write
made offline keeps the time it was made: when it is replayed, a newer write of that key made
elsewhere meanwhile wins, and the copy takes that value (`onChanged`, `"remote"`). Different keys
never conflict. A delete is a tombstone that competes like a value, so a device that was offline
cannot bring a deleted key back with an older write. Deleting a key the copy does not show is
ignored while offline.

| Member | Behaviour |
| --- | --- |
| `onChanged` | See [Events](#events). |
| `status` | `"idle"`, `"syncing"`, `"offline"` or `"error"`; see below. |
| `onStatus` | Fires on every change of `status` or its error. |
| `syncNow()` | Pushes unsynced writes, renews content when due ([retention](retention.md)) and refreshes the whole copy. Unlike the data calls, it rejects with the `BurrowError` when the store cannot be reached or a pause is in force. |
| `forget({ discardLocal? })` | Deletes this token's copy from the device and closes. It first tries to push unsynced writes; if some remain, it rejects `would-orphan` unless `discardLocal` is true. Other tabs with the same copy close too. The data stays in the store for the token. IndexedDB backups may still hold old data: it is not secure erasure. |

| `status` | Meaning |
| --- | --- |
| `"idle"` | The last remote work succeeded. |
| `"syncing"` | A background sync is running. |
| `"offline"` | The browser reports no network, or the last remote call failed with a network or quota error (`error.code` is `"backend"` or `"quota"`), or IndexedDB was unavailable at start-up (the copy is then in memory only). Retries back off from 2 s to 5 minutes; the `online` event and `syncNow()` retry at once. Unsynced writes wait. |
| `"error"` | `decrypt-failed` or `expired`: remote work stops for this instance; the copy and unsynced writes stay and keep working locally. `conflict` or `item-too-large`: retried on the next write or sync. |

The wrapper also refreshes the copy when the page becomes visible, when the network comes back,
and when the backend reports a change to the user's manifest (Firestore does, through a listener
that is dropped after five hidden minutes). It does not poll.

### Events

The offline wrapper's events are `BurrowEvent<T>`s, `EventTarget`s that also have the
`chrome.storage.onChanged` listener methods:

```ts
declare class BurrowEvent<T> extends EventTarget {
  readonly type: string;
  addListener(fn: (detail: T) => void): void;
  removeListener(fn: (detail: T) => void): void;
  hasListener(fn: (detail: T) => void): boolean;
}
```

`addListener` callbacks receive the payload `T`. Listeners added with
`addEventListener(type, …)` receive a `CustomEvent<T>` whose `detail` is the payload.

| Member | `type` | Payload `T` | Fires when |
| --- | --- | --- | --- |
| `onChanged` | `"changed"` | `ChangedEvent`: `{ changes: { [key]: { oldValue?, newValue? } }, source: "local" \| "remote" }` | After a write is stored in the copy (`"local"`), after changes from the store reach the copy (`"remote"`), and for either in another tab of the same app and token (with their source). Writes that change nothing visible fire nothing. |
| `onStatus` | `"status"` | `StatusEvent`: `{ status, error?: BurrowError }` | Whenever the (status, error) pair changes. |

## `generateToken(): Promise<string>`

A fresh storage token: 32 bytes from `crypto.getRandomValues`, a version byte and a 16-bit
checksum, as 56 Crockford base32 characters in 14 groups of 4 joined by hyphens, such as
`07DV-1XKY-2X98-DRCP-DJV6-FC2E-459V-AJTY-26K2-XJFQ-9BXZ-QRNF-X0F5-Z1XS` (made up; it fails its
checksum). Each call is a new identity with no data. Nothing is stored: keep it, or show it to
the user to keep.

```js
const token = await generateToken();
const store = await burrow({ app: "notes", backend, token });
await store.set({ theme: "dark" });
```

## Passkey token

Exported by `burrow-storage/passkey`, and as `Burrow.passkeyToken` in the script-tag build. It
turns a passkey into a storage token for one app and stores nothing, on the device or anywhere
else (D-58). It knows nothing about the store: pass the token it returns to `burrow()`.

```js
const passkey = passkeyToken({ app: "notes" });
// From a click: a new passkey, so a new identity.
const fresh = await passkey.create();
// From a click, on any device where that passkey is available: the same token.
const again = await passkey.get();
const store = await burrow({ app: "notes", backend, token: again });
```

```ts
interface PasskeyTokenOptions {
  app: string;
  rpId?: string;
  rpName?: string;
  userName?: string;
  displayName?: string;
  timeoutMs?: number;
}
interface PasskeyToken {
  available(): Promise<boolean>;
  create(): Promise<string>;
  get(): Promise<string>;
}
```

| Option | Behaviour |
| --- | --- |
| `app` | Required, as for `burrow()`, else `TypeError` at once. One passkey gives each app its own, unrelated token. |
| `rpId` | WebAuthn RP ID. Default: the page's host (`localhost` outside a page). Set the registrable domain to share passkeys across subdomains. Canonicalised to lowercase ASCII/IDNA; empty values, URLs, ports and other URL fields reject with `TypeError` before prompting. The browser decides whether the RP is allowed for the page. |
| `rpName` | RP display name. Default: the page's host. |
| `userName`, `displayName` | The new passkey's account name and display name, shown in the passkey picker. Default: the app id, and `userName`. Presentation only; they do not enter the token. |
| `timeoutMs` | How long a prompt may stay open. Default 120 000. |

| Member | Behaviour |
| --- | --- |
| `available()` | Never prompts. True in a secure context with `PublicKeyCredential`, a user-verifying platform authenticator, and no `getClientCapabilities()` report denying `extension:prf`. The authenticator the user picks may still lack PRF. |
| `create()` | Creates a new discoverable passkey with user verification, no attestation and a random user handle, and returns the token it gives this app: a new identity. It never replaces an existing passkey. One prompt, or two when the authenticator returns no PRF output at creation; if the second is dismissed the passkey exists and `get()` returns its token later. |
| `get()` | Asks for an existing passkey; the user picks it. Returns the token that passkey gives this app: the same token every time, on every device where the passkey is available and supports PRF. |

Both reject with a `BurrowError`, never resolve without a token: `cancelled` when the prompt is
dismissed, times out, or no passkey is there to pick (browsers report all three the same way, on
purpose), and `prf-unsupported` when the browser or authenticator cannot evaluate PRF (a new
passkey without PRF is reported to the passkey provider as unknown where the browser allows, so
it can remove it). Call both from a user gesture: browsers allow passkey prompts only then.

The token is derived, not stored in the passkey: the passkey and the token are not
interchangeable. The token works without the passkey, so the user can also keep the string; the
passkey cannot be rebuilt from the token. Losing every copy of the passkey loses that route to
the token, and a new passkey gives a new token. Whether a passkey reaches other devices depends on
the passkey provider. Limits and support notes: [sync-and-tokens.md](sync-and-tokens.md#passkeys);
the derivation: [SECURITY.md](../SECURITY.md#derivation-v1).

## Page config

`readBackendConfig()` returns the page's backend config, or `null`: generic
`<meta name="burrow-backend" content='{"type": …}'>`, then `window.BURROW.backend`, then the
Firestore shorthand (`<meta name="burrow-firestore">` or `window.BURROW.firestore`) as
`{ type: "firestore", … }`. Malformed JSON, or a value that is not an object, throws `TypeError`
without echoing it. `readFirestoreConfig()` returns only the Firestore shorthand. Page data selects
a registered factory; it never selects a script URL or code.

```js
const config = readBackendConfig();
if (!config) throw new Error("this page has no backend config");
const store = await burrow({ app: "notes", backend: config, token });
```

## Errors

```ts
declare class BurrowError extends Error {
  readonly name: "BurrowError";
  readonly code: BurrowErrorCode;
}
type BurrowErrorCode = "closed" | "cancelled" | "prf-unsupported" | "bad-token" | "item-too-large"
  | "backend" | "conflict" | "quota" | "decrypt-failed" | "expired" | "would-orphan";
```

Failures that Burrow detects reject with a `BurrowError` that carries a stable `code`. Argument
mistakes reject with a `TypeError`. One error from below can pass through: the offline wrapper's
`set()`, `remove()` and `clear()` reject with the browser's own error when the local IndexedDB
write fails (for example, when its storage is full). `cause`, when present, is scrubbed of
anything that looks like an id or token.

| `code` | Raised by | Meaning |
| --- | --- | --- |
| `bad-token` | `burrow()` | The token is missing, malformed, fails its checksum or has an unknown version. |
| `item-too-large` | `set()`; the core's writes; the wrapper's `onStatus` | An item exceeds 200 000 bytes, or the encrypted document or manifest would exceed the store's limit. |
| `backend` | the core's calls; `burrow()`; the wrapper's `onStatus` and `syncNow()` | A network or store failure, or a backend factory that failed. |
| `quota` | the core's calls; the wrapper's `onStatus` and `syncNow()` | The store's daily quota is exhausted. |
| `conflict` | the core's writes; the wrapper's `onStatus` and `syncNow()` | Writes kept colliding with another writer after retries. |
| `decrypt-failed` | the core's calls; the wrapper's `onStatus` and `syncNow()` | A document does not decrypt under this token, or does not belong to its key (corruption or tampering). The wrapper stops remote work for the instance and keeps its copy. |
| `expired` | the core's calls; the wrapper's `onStatus` and `syncNow()` | An operator expired a content document ([retention](retention.md)). The wrapper stops remote work and keeps its copy and unsynced writes. |
| `would-orphan` | `forget()` | This copy has writes that never reached the store; pass `discardLocal: true` to drop them. |
| `closed` | any call after `close()` or `forget()` | Open the store again. |
| `cancelled` | `passkeyToken().create()`, `.get()` | The passkey prompt was dismissed, timed out, or found no passkey. |
| `prf-unsupported` | `passkeyToken().create()`, `.get()` | WebAuthn PRF is unavailable with this browser or authenticator. Offer the storage token instead. |

```ts
declare class BackendError extends Error {
  readonly name: "BackendError";
  readonly code: BackendErrorCode;
}
type BackendErrorCode = "conflict" | "unauthorized" | "too-large" | "quota" | "network" | "expired";
```

`BackendError` is what a backend adapter throws. Burrow maps `conflict`, `unauthorized`,
`too-large`, `quota` and `network` to `conflict`, `backend`, `item-too-large`, `quota` and
`backend` respectively. `expired` remains `expired`.

## Backends

```ts
interface Backend {
  readonly id: string;
  readonly capabilities: BackendCapabilities;
  get(id: string): Promise<StoredDocument | null>;
  getMany?(ids: string[]): Promise<(StoredDocument | null)[]>;
  put(id: string, env: Envelope, expectedRev: number | null, options?: PutOptions): Promise<void>;
  subscribe?(id: string, onChange: (env: StoredDocument) => void): () => void;
}
interface BackendCapabilities { writeAuth: boolean; subscribe: boolean }
interface ExpiredStub { x: true; rev: number; next: string }
type StoredDocument = Envelope | ExpiredStub;
interface PutOptions { replaceExpired?: true }
```

Normal puts atomically refuse an expired stub. `replaceExpired: true` explicitly opts into
replacement while keeping the revision/token-chain checks; Burrow never opts in. Subscriptions
must preserve the stub flag even when its revision is unchanged. Use-driven content renewal (the
offline wrapper) coalesces per app, token and device for 29–30 days; the operator may enable
395-day inactivity cleanup. Full behavior and operator limits: [retention.md](retention.md).

Writing your own: [extending.md](extending.md).

### `new FirestoreBackend(config: FirestoreConfig)`

Exported by `burrow-storage/firestore`, and available as the built-in `{ type: "firestore" }`.

```ts
interface FirestoreConfig {
  apiKey: string;
  projectId: string;
  appId?: string;                            // optional; Firestore does not require it
  collection?: string;                       // default "burrow", the collection the bundled rules name
  emulator?: { host: string; port: number }; // the Firestore emulator
}
```

Reads and writes go through Firestore transactions; live updates use a document listener on the
user's manifest. Capabilities: `writeAuth: true, subscribe: true`. Constructing it loads nothing;
the SDK loads on the first request. The Firebase SDK keeps a heartbeat record of its own (SDK
versions and a date) in IndexedDB; it holds nothing of the user's.

### `new MemoryBackend(options?: MemoryBackendOptions)`

```ts
interface MemoryBackendOptions {
  store?: Map<string, StoredDocument>; // share one map between instances to simulate several devices
  latencyMs?: number;
}
```

Enforces exactly the rules of the Firestore rules file, write-token chain included. Two members
exist for tests: `failWith: "network" | "quota" | null` makes every call reject, and
`stats: { gets: number; puts: number }` counts calls.

## Types

```ts
interface Envelope {          // live encrypted document
  v: 1; iv: string; ct: string; rev: number; ts: number; tok: string; next: string; z?: true;
}
interface Manifest { v: 1; items: Record<string, { ts: number; deleted?: true; h?: string }> }
interface Item { v: 1; key: string; value: unknown; ts: number; deleted?: true }
type Status = "idle" | "syncing" | "offline" | "error";
interface ChangedEvent { changes: StorageChanges; source: "local" | "remote" }
type StorageChanges = Record<string, { oldValue?: unknown; newValue?: unknown }>;
interface StatusEvent { status: Status; error?: BurrowError }
```
