# API reference

Everything exported by `burrow-storage`, with the behaviour that matters to a caller. The source of
truth is `src/types.ts`; this page explains it. Terms: the **storage token** is the user's secret
(the `code` in method names); a **passkey backup** is that token stored in a passkey-protected
keyslot document.

## Entry points

```js
import { burrow, MemoryBackend, BurrowError, BackendError, passkey, syncCode } from "burrow-storage";
import { FirestoreBackend } from "burrow-storage/firestore";
```

| Export | From | What |
| --- | --- | --- |
| `burrow(config)` | `burrow-storage` | Open an area for one app |
| `MemoryBackend` | `burrow-storage` | In-memory store for tests and demos |
| `BurrowError`, `BackendError` | `burrow-storage` | Error classes with a stable `code` |
| `BurrowEvent` | `burrow-storage` | The event class used by `onChanged` and friends |
| `passkey(options?)`, `syncCode()` | `burrow-storage` | The built-in unlock methods |
| `readFirestoreConfig()` | `burrow-storage` | Reads the page's Firestore config, if you need it yourself |
| `FirestoreBackend` | `burrow-storage/firestore` | The reference backend (needs the optional `firebase` peer dependency) |
| all types | `burrow-storage` | `BurrowArea`, `BurrowConfig`, `Backend`, `KeyProvider`, `Envelope`, … |

The script-tag build `dist/burrow.min.js` exposes all of the above, `FirestoreBackend` included,
on the global `Burrow`. It loads the Firestore SDK on first use from `burrow-firestore.js` next to
itself.

## `burrow(config): Promise<BurrowArea>`

Opens the store for one app. It resolves once the device's token and the whole local cache are
loaded, with no network access and no user interaction, typically in under 20 ms. Calling it again
with the same `app` on the same page returns the same promise; a second, different config is
ignored. It needs a secure context (HTTPS or `localhost`), because WebCrypto does.

```ts
interface BurrowConfig {
  app: string;                              // required, /^[a-z0-9-]{1,64}$/
  backend?: Backend;                        // default: from the page, see below
  keyProvider?: KeyProvider | KeyProvider[]; // default: [passkey(), syncCode()]
  cache?: "indexeddb" | "memory";           // default: "indexeddb" ("memory" when rememberDevice is false)
  rememberDevice?: boolean;                 // default: true
  syncIntervalMs?: number;                  // default: 30_000; 0 disables polling
  debounceMs?: number;                      // default: 1_500
  maxItemBytes?: number;                    // default: 200_000; clamped to 749_000
  debug?: boolean;                          // default: false
}
```

| Option | Behaviour |
| --- | --- |
| `app` | Namespaces the cache and the derived keys. Two apps on one origin share the storage token but never see each other's data. An invalid id throws `TypeError`. |
| `backend` | When omitted, Burrow reads `<meta name="burrow-firestore" content='{"apiKey","projectId","appId"}'>`, then `window.BURROW.firestore`, and builds a `FirestoreBackend` from it (loading the adapter on demand). With neither present it runs **local-only**: everything works, nothing leaves the device, and one `console.warn` says so. |
| `keyProvider` | The unlock methods `protect()` and `link()` can use, tried in order. Passing your own replaces the defaults; include `passkey()` and `syncCode()` yourself if you still want them. |
| `cache` | `"memory"` keeps items in memory for the page's lifetime. If IndexedDB cannot be opened, Burrow falls back to memory and sets `status` to `"offline"` until a sync succeeds. |
| `rememberDevice` | `false` keeps the token in memory only and defaults the cache to memory, for shared computers. Every page load then starts with a fresh token until the user links. |
| `syncIntervalMs` | Polling interval while the page is visible. The Firestore backend also pushes changes through a listener, so a long interval is fine when live updates matter more than cost. |
| `debounceMs` | Local writes are coalesced for this long before a push. |
| `maxItemBytes` | Size limit per item, measured as the UTF-8 length of `JSON.stringify({ v: 1, key, value, ts })`, so the key name counts. Values above 749 000 are clamped silently. |
| `debug` | One `console.debug` line per sync event (`pull`, `push`, `conflict`, `backoff`, `error`, …) with revisions, counts, bytes and durations. Never ids, tokens, keys or values. |

If the page URL carries `#burrow=<token>` when `burrow()` runs, the device adopts that token
first (see [`link()`](#tokens-and-devices)), the fragment is removed with `history.replaceState`, and the promise
resolves after the first sync attempt. This happens without asking, for any link; a site that
does not hand out links should drop the fragment before calling `burrow()`
([sync-and-tokens.md](sync-and-tokens.md#links)).

## `BurrowArea`

### Data

```ts
get(keys?: GetKeys, opts?: { fresh?: boolean }): Promise<Record<string, unknown>>;
set(items: Record<string, unknown>): Promise<void>;
remove(keys: string | string[]): Promise<void>;
clear(): Promise<void>;
getBytesInUse(keys?: null | string | string[]): Promise<number>;
```

`type GetKeys = null | undefined | string | string[] | Record<string, unknown>`

| Method | Behaviour |
| --- | --- |
| `get()` / `get(null)` | Every live key. |
| `get("k")`, `get(["a", "b"])` | The keys that exist. |
| `get({ a: 1, b: "x" })` | Stored values, with the object's values as defaults for missing keys. |
| `get(keys, { fresh: true })` | With a backend: fetches those item documents (or runs a full sync when no keys are given) before answering. Network errors are swallowed and the cache answers. |
| `set(items)` | Validates every key first, so an invalid batch writes nothing: keys must be strings, values must be JSON (`undefined`, `NaN`, `Infinity`, functions, `Date`, `Map`, class instances and cycles throw `TypeError`), and each item must fit `maxItemBytes` (`BurrowError("item-too-large")`). Resolves once the write is stored locally; **never** rejects because the store is unreachable. Writing a value equal to the current one fires no `onChanged` but is still a new write that syncs. |
| `remove(keys)` | Marks live keys deleted; the tombstone syncs to other devices. Missing keys are ignored. |
| `clear()` | `remove()` of every key. |
| `getBytesInUse(keys?)` | Sum of the UTF-8 lengths of each key and its JSON value, as `chrome.storage` counts it. |

Values are structured-cloned on the way in and out, so callers never share objects with the cache.

### Events

Every event is a `BurrowEvent<T>`: a real `EventTarget` that also offers the
`chrome.storage.onChanged` listener shape.

```ts
import type { ChangedEvent } from "burrow-storage";

const onChange = ({ changes, source }: ChangedEvent) => console.log(source, Object.keys(changes));
store.onChanged.addListener(onChange);           // chrome.storage style
store.onChanged.hasListener(onChange);           // true
store.onChanged.removeListener(onChange);

// DOM style: the payload is the CustomEvent's detail
store.onChanged.addEventListener("changed", (e) => {
  const { changes } = (e as CustomEvent<ChangedEvent>).detail;
});
```

| Event | Type name | Payload | Fires when |
| --- | --- | --- | --- |
| `onChanged` | `"changed"` | `{ changes: { [key]: { oldValue?, newValue? } }, source: "local" \| "remote" }` | After a local write is stored (`"local"`), per batch of facade writes (`"local"`), once per sync pass for changes pulled from the store (`"remote"`), and for writes made in another tab (their own source). Changes that net to nothing are dropped. |
| `onStatus` | `"status"` | `{ status, error?: BurrowError }` | Whenever the (status, error) pair changes. Every sync pass goes `"syncing"` then `"idle"`. |
| `onToken` | `"token"` | `TokenInfo` | When this device's token changes: after `link()` here or in another tab. Not at start-up. |
| `onUnprotected` | `"unprotected"` | `undefined` | Once per device and app, when at least one key exists and `protection` is `"none"`. Checked at start-up and after local writes. Register the listener right after `burrow()` resolves: the event is not repeated for listeners added later. |

### State

```ts
readonly status: "idle" | "syncing" | "offline" | "error";
readonly token: TokenInfo;          // { source, remembered, since }
readonly protection: "none" | "passkey" | "code" | string;
readonly storage: Storage;
inspect(): Inspection;
```

| Status | Meaning |
| --- | --- |
| `"idle"` | Nothing in flight. Also the local-only state when no backend is configured. |
| `"syncing"` | A sync pass is running. |
| `"offline"` | The last pass failed with a network or quota error (`error.code` is `"backend"` or `"quota"`), or IndexedDB was unavailable at start-up. Burrow retries with exponential backoff from 2 s, capped at the larger of `syncIntervalMs` and 5 minutes. Dirty items wait. |
| `"error"` | `decrypt-failed` (sync is paused until the device links again), or `conflict` / `item-too-large` (retried on the next trigger). |

`TokenInfo.source` is `"generated"` (made on this device), `"code"` (typed or pasted),
`"link"` (from a `#burrow=` URL), `"passkey"`, `"unknown"` (stored before the source was
recorded), or a custom provider's id. `remembered` is true when the token was loaded from this
browser's storage on page load; `since` is when the device obtained it.

`protection` is what can bring the token back on another device from this device's point of
view: `"passkey"` after `protect("passkey")` or a passkey recovery, `"code"` after
`protect("sync-code")` or `link({ code })`, otherwise `"none"`. `exportCode()` does not change it.

`inspect()` returns
`{ status, tokenSource, protection, manifestRev, dirtyKeys, lastSyncAt, backend, provider }`
where `backend` is the backend id or `"none"` and `provider` is `null`, `"sync-code"`,
`"passkey"` or a custom id.

### Tokens and devices

```ts
exportCode(): Promise<string>;
protect(providerId?: string): Promise<void>;
link(options?: { provider?: string; code?: string; discardLocal?: boolean }): Promise<void>;
unlink(options?: { discardLocal?: boolean }): Promise<void>;
```

**`exportCode()`** returns the storage token: 56 Crockford base32 characters in 14 groups of 4
joined by hyphens, such as `07DV-1XKY-2X98-DRCP-DJV6-FC2E-459V-AJTY-26K2-XJFQ-9BXZ-QRNF-X0F5-Z1XS`
(a made-up example that fails its checksum). It encodes a version byte, the 32-byte secret and a
16-bit checksum.

**`protect(providerId?)`** enrols an unlock method for the current token. Without an id it uses
the first configured provider that is available (with the defaults: the passkey, else the token);
with `"passkey"` it creates a discoverable passkey with user verification and writes a keyslot
document to the backend; with `"sync-code"` it only records that the user has kept the token.
Call it from a user gesture. Rejections: `no-provider` (unknown id, nothing available, or the
passkey prompt was dismissed), `prf-unsupported` (the browser or authenticator cannot evaluate the
PRF extension), `backend` (a passkey needs a backend), `conflict` (the keyslot write kept
conflicting). A failing store may also surface a raw `BackendError`.

**`link(options)`** adopts an existing token on this device.

- `link({ code })` decodes the token first and rejects with `bad-code` before any network call
  when it is malformed, has a bad checksum, or an unknown version.
- `link({ provider: "passkey" })` or `link()` asks each configured provider (in order, or only the
  named one) to recover a token; the passkey shows one prompt. A provider that fails or is
  declined is skipped, and if none succeeds the call rejects with `no-provider`.
- If the recovered token is the one already in use, the call just records the protection and
  resumes sync. This is how a device recovers from `decrypt-failed`.
- Otherwise, if this app has writes that never reached the store, Burrow tries to push them under
  the old token first and rejects with `would-orphan` if any remain; pass `discardLocal: true` to
  drop them. Then the new token replaces the old one **for every app on the origin**, this app's
  cache is cleared and refilled from the store, `onToken` fires, and `onChanged` reports the
  before/after difference with `source: "remote"`. Open tabs of this app switch at once; other
  apps on the origin switch on their next load, and drop any writes they had not synced.
- `link()` resolves even when the first sync afterwards fails; check `status`.

**`unlink(options)`** forgets the token on this device, like logging out. It has the same
`would-orphan` guard as `link()`. The remote documents are untouched, the instance is closed (every
later call throws `BurrowError("no-provider")`), other tabs of this app close theirs, and the next
`burrow()` on the device generates a fresh token and clears the old token's cached items before
use.

### Sync and backups

```ts
syncNow(): Promise<void>;
exportJSON(): Promise<string>;
importJSON(json: string): Promise<void>;
```

`syncNow()` flushes pending writes and runs one sync pass. Unlike `set()`, it rejects with the
`BurrowError` when the pass leaves the store in `"offline"` or `"error"`.

`exportJSON()` returns `{ "burrow": 1, "app": "…", "exportedAt": "<ISO date>", "items": { … } }`
as pretty-printed plaintext. `importJSON(json)` validates that shape (`TypeError("not a Burrow
export")` otherwise) and merges the items with `set()`; it does not check that `app` matches.

### `storage`: the `Storage` facade

`BurrowArea.storage` implements the DOM `Storage` interface synchronously over the in-memory mirror.
Reads are correct from the first call; writes are visible at once, persisted in the background
(batched per microtask), and flushed when the page is hidden or unloaded.

- `length`, `key(i)` (insertion order), `getItem`, `setItem`, `removeItem`, `clear`.
- Property access as on `localStorage`: `s.theme`, `s["theme"] = "dark"`, `"theme" in s`,
  `delete s.theme`, `Object.keys(s)`. The six method names always resolve to the methods.
- `setItem` stores `String(value)`. `getItem` returns strings as they are and other values written
  through the async API as their JSON text; `null` for a missing key.
- Changes are reported on `onChanged` (batched per microtask). The window `storage` event is
  never fired.
- An item over `maxItemBytes` throws `BurrowError("item-too-large")` synchronously.
- `Object.prototype.toString.call(s)` is `"[object Storage]"`; `s instanceof Storage` is false.

## Errors

Failures that Burrow detects reject with a `BurrowError` that carries a stable `code`. Argument
mistakes reject with a `TypeError` (the synchronous facade throws it). Two errors from below can
also pass through: `set()`, `remove()` and `clear()` reject with the browser's own error when the
local IndexedDB write fails (for example, when its storage is full), and `protect("passkey")` can
reject with a raw `BackendError` when the store fails. `cause`, when present, is scrubbed of
anything that looks like an id or token.

| `code` | Raised by | Meaning |
| --- | --- | --- |
| `bad-code` | `link({ code })`, a `#burrow=` link | The token is malformed, fails its checksum or has an unknown version. Nothing was changed. |
| `item-too-large` | `set()`, `setItem()`; `onStatus` | An item exceeds `maxItemBytes`, or the encrypted document or manifest would exceed the store's limit. |
| `would-orphan` | `link()`, `unlink()` | This app has writes that never synced; pass `discardLocal: true` to drop them. |
| `no-provider` | `protect()`, `link()`, any call after `unlink()` | No unlock method could do the job, the passkey prompt was dismissed, or the instance was unlinked. |
| `prf-unsupported` | `protect("passkey")`, passkey recovery | WebAuthn PRF is not available here. Offer the storage token instead. |
| `decrypt-failed` | `onStatus` | A document does not decrypt under this token (corruption or a version mismatch). Sync pauses, the cache is untouched; `link()` resumes it. |
| `conflict` | `onStatus`, `syncNow()`, `protect("passkey")` | Writes kept colliding with another writer after retries. Retried on the next trigger. |
| `quota` | `onStatus`, `syncNow()` | The store's daily quota is exhausted. Sync pauses and retries with backoff. |
| `backend` | `onStatus`, `syncNow()`, `protect("passkey")` | A network or store failure (retried), or a passkey backup was requested with no backend. |

`BackendError` is what a backend adapter throws: `conflict`, `unauthorized`, `too-large`, `quota`
or `network`. Burrow maps them to `conflict`, `backend`, `item-too-large`, `quota` and `backend`
respectively.

## Backends

```ts
interface Backend {
  readonly id: string;
  readonly capabilities: { writeAuth: boolean; subscribe: boolean; keepalive: boolean; maxEnvelopeBytes: number };
  get(id: string): Promise<Envelope | null>;
  getMany?(ids: string[]): Promise<(Envelope | null)[]>;
  put(id: string, env: Envelope, expectedRev: number | null, opts?: { keepalive?: boolean }): Promise<void>;
  subscribe?(id: string, onChange: (env: Envelope) => void): () => void;
}
```

**`new FirestoreBackend({ apiKey, projectId, appId, collection?, emulator? })`** from
`burrow-storage/firestore`. `collection` defaults to `"burrow"` (the bundled rules name that
collection; change both together). `emulator: { host, port }` points at the Firestore emulator.
Reads and writes go through Firestore transactions; live updates use a document listener on the
user's manifest. Capabilities: `writeAuth: true, subscribe: true, keepalive: false`.

**`new MemoryBackend({ store?, latencyMs? })`** enforces exactly the same rules as the Firestore
rules file, including the write-token chain. Pass the same `store` map to several instances to
simulate several devices. Test hooks: `failWith: "network" | "quota" | null` makes every call
reject; `stats.gets` and `stats.puts` count calls.

Writing your own: [docs/extending.md](extending.md).

## Unlock methods (`KeyProvider`)

```ts
interface KeyProvider {
  readonly id: string;
  available(): Promise<boolean>;
  enrol(ctx: { app: string; rootSecret: Uint8Array; backend: Backend; store?: ProviderStore }): Promise<void>;
  recover(ctx: { app: string; interactive: boolean; input?: string; backend: Backend; store?: ProviderStore }): Promise<Uint8Array | null>;
}
```

**`passkey({ rpId?, rpName?, userName?, timeoutMs? })`**: id `"passkey"`. `rpId` defaults to the
page's host (set it to the registrable domain to share one passkey across subdomains), `rpName`
to the host, `userName` to the app id, `timeoutMs` to 120 000. `available()` never prompts: it
checks for `PublicKeyCredential`, a user-verifying platform authenticator, and that
`getClientCapabilities()` does not deny `extension:prf`.

**`syncCode()`**: id `"sync-code"`. Always available; `enrol()` is a no-op (the token is obtained
with `exportCode()`); `recover({ input })` decodes a token. Its protection value is `"code"`.

When the page runs local-only (no backend configured), `protect()` and `link()` still call custom
providers, and pass `backend` as `null` despite its type. A provider that needs the store must
check for that.

## Types

```ts
interface Envelope {          // every stored document
  v: 1; iv: string; ct: string; rev: number; ts: number; tok: string; next: string; z?: true;
}
interface Manifest { v: 1; items: Record<string, { ts: number; deleted?: true; h?: string }> }
interface Item { v: 1; key: string; value: unknown; ts: number; deleted?: true }
interface TokenInfo { source: TokenSource; remembered: boolean; since: number | null }
type TokenSource = "generated" | "code" | "link" | "passkey" | "unknown" | (string & {});
type Protection = "none" | "passkey" | "code" | (string & {});
type Status = "idle" | "syncing" | "offline" | "error";
interface ChangedEvent { changes: StorageChanges; source: "local" | "remote" }
interface StatusEvent { status: Status; error?: BurrowError }
interface Inspection {
  status: Status; tokenSource: TokenSource; protection: Protection; manifestRev: number | null;
  dirtyKeys: number; lastSyncAt: number | null; backend: string; provider: string | null;
}
```
