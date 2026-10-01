# Burrow

Persistent, cross-device, per-user storage for static sites. No login, no backend of your own.

A burrow is dug by its owner, hidden from everyone else, and found only by one who knows the
entrance. The user's device holds a random key. The key derives unguessable document ids and
encryption keys. The data sits encrypted at those ids in one shared, free store that every
prototype can reuse. The site holds nothing, and the store sees only hashes and ciphertext.

```html
<meta name="burrow-firestore" content='{"apiKey":"…","projectId":"…","appId":"…"}'>
<script src="burrow.min.js"></script>
<script type="module">
  const store = await Burrow.burrow({ app: "my-prototype" });
  await store.set({ theme: "dark" });
  const { theme } = await store.get("theme");
</script>
```

Or with a bundler:

```js
import { burrow } from "burrow-storage";
const store = await burrow({ app: "my-prototype" });
```

- **No login.** Nobody creates an account, types an email or sees a consent screen. A secret is
  generated silently on first use and kept on the device, like a session cookie.
- **Local-first.** Reads and writes complete against IndexedDB immediately; sync runs in the
  background and never blocks the UI. Works offline.
- **Zero trust in the store.** Ids are keyed hashes, contents are AES-256-GCM ciphertext, and
  writes need a hash-chained token only the key holder can compute.
- **Familiar shape.** The async API mirrors `chrome.storage`; `store.storage` is a drop-in
  `localStorage`.
- **Swappable store.** Firestore on the free Spark plan is the reference backend. Another store
  needs one small interface.

> **Burrow cannot reset your users' data.** If a user loses every device and has no sync code or
> passkey, their data is gone. Offer the sync code, and use `onUnprotected` to remind them.

## Contents

- [How it works](#how-it-works)
- [API](#api)
- [Sync to another device](#sync-to-another-device)
- [Migrating from localStorage](#migrating-from-localstorage)
- [Setting up the shared store](#setting-up-the-shared-store)
- [Security, CSP and SRI](#security-csp-and-sri)
- [Configuration](#configuration)
- [Custom backends and unlock methods](#custom-backends-and-unlock-methods)
- [Browser support and size](#browser-support-and-size)
- [Development](#development)

## How it works

```
your site ──► store.storage (sync, localStorage-shaped)   store (async, chrome.storage-shaped)
                         └──────────────┬─────────────────────┘
                               Burrow core: IndexedDB cache · codec · sync engine
                     unlock methods ┘                         └ backend (the only swappable seam)
               passkey keyslot · sync code                      Firestore · memory · your own
```

1. On first use the device generates a 256-bit root secret. It is stored in IndexedDB, wrapped
   under a non-extractable WebCrypto key.
2. From the secret and your `app` id, HKDF derives a path key, an encryption key and a write
   key. Every document id is a keyed hash: one *manifest* (the user's key directory), one
   document per item key, one *keyslot* per passkey.
3. Each document is an envelope: `{ v, iv, ct, rev, ts, tok, next }`. The ciphertext binds its
   id, app and revision as AES-GCM additional data. `tok` proves the writer knows the secret;
   `next` commits to the token the next revision must present. Firestore rules check that
   chain with SHA-256, so knowing an id lets you read ciphertext but never write.
4. Sync is per item, last-writer-wins per key, with tombstones. A pull with nothing new costs
   one read. A push costs one write per changed item plus one for the manifest.

The full design is in [SECURITY.md](SECURITY.md); judgement calls are in
[DECISIONS.md](DECISIONS.md).

## API

### `burrow(config): Promise<BurrowArea>`

Resolves from the local cache with no user interaction, usually in a few milliseconds. Calling it
again with the same `app` on the same page returns the same instance.

### `BurrowArea`

| Member | What it does |
| --- | --- |
| `get(keys?, { fresh? })` | `chrome.storage` shapes: `null` (everything), `"key"`, `["a", "b"]`, or `{ key: default }`. Answers from the cache. `fresh: true` also fetches those items from the store first. |
| `set(items)` | Writes any JSON values. Resolves once the write is durable locally, never waits on the network. A non-JSON value (`Date`, `Map`, a function, `undefined`) throws `TypeError`. |
| `remove(keys)`, `clear()` | Delete keys everywhere (a tombstone syncs to other devices). |
| `getBytesInUse(keys?)` | Approximate size, as in `chrome.storage`. |
| `onChanged` | `{ changes: { key: { oldValue?, newValue? } }, source: "local" \| "remote" }`, batched per sync pass. `addListener(fn)` or `addEventListener("changed", e => e.detail)`. |
| `status`, `onStatus` | `"idle"`, `"syncing"`, `"offline"` or `"error"`; the event carries the last `BurrowError`. |
| `protection`, `onUnprotected` | Which unlock method protects this device's secret. `onUnprotected` fires once per device when data exists and none does. |
| `protect(providerId?)` | Enrol an unlock method (`"passkey"`, `"sync-code"`). Call from a user gesture. |
| `exportCode()` | The sync code for another device, e.g. `04G1-…` (56 characters). |
| `link({ code } \| { provider } \| {})` | Bring an existing secret onto this device: from a code, or from the configured providers in order. |
| `unlink()` | Forget the secret on this device, like logging out. The data stays in the store. |
| `syncNow()` | Push and pull now. Rejects with the error if the pass failed. |
| `exportJSON()`, `importJSON(json)` | A plaintext backup the user can keep. |
| `inspect()` | `{ status, protection, manifestRev, dirtyKeys, lastSyncAt, backend, provider }` for a debug panel. |
| `storage` | A synchronous `Storage` (`getItem`, `setItem`, `key`, `length`, property access…). |

### Errors

Every rejection is a `BurrowError` with a stable `code`:

| `code` | When |
| --- | --- |
| `item-too-large` | `set()` / `setItem()` over `maxItemBytes` (thrown before anything is written). |
| `bad-code` | `link({ code })` with a mistyped code. Checked before any network call. |
| `no-provider` | `link()` found no way to recover a secret, or `protect()` had nothing to enrol. |
| `prf-unsupported` | The browser or authenticator cannot do passkey PRF. Offer the sync code. |
| `would-orphan` | `link()`/`unlink()` would abandon writes that never synced. Pass `{ discardLocal: true }` to proceed. |
| `decrypt-failed` | A document does not decrypt with this secret. Sync pauses; the cache is untouched; re-link. |
| `conflict`, `backend`, `quota` | Sync trouble. These arrive through `onStatus`, never from `set()`. |

Write failures never reject `set()`. If the store is unreachable, `status` turns `"offline"`, dirty
items wait, and sync retries with backoff. If the daily quota is exhausted, sync pauses until the
quota resets.

## Sync to another device

Nothing is needed to start; the first device just works. To bring the data elsewhere, the user
needs one of:

- **Sync code**: always available. Show `await store.exportCode()`, and on the other device call
  `store.link({ code })`. The code is case-insensitive and forgives `O/0` and `I/L/1`. You can
  also share it as a link: `https://your.site/#burrow=<code>` links the device on load, and
  Burrow removes the code from the address bar.
- **Passkey**: `store.protect("passkey")` creates a passkey and stores the secret in a keyslot
  wrapped by the passkey's PRF output. On a new device, `store.link({ provider: "passkey" })`
  needs one passkey prompt. PRF support is uneven across browsers and authenticators, and
  cross-ecosystem use goes through the QR/hybrid flow. **The sync code is the guaranteed path.**

A typical site has one button, "Sync to another device", that calls `protect()` and then shows
the code. It also listens once for `onUnprotected` to nudge the user at a calm moment:

```js
store.onUnprotected.addListener(() => showBanner("Keep a copy: show your sync code"));
```

On shared computers, use `burrow({ app, rememberDevice: false })`: nothing is persisted, and
the user links with their passkey or code each session.

## Migrating from localStorage

1. Load Burrow once, before your code runs:
   ```js
   const store = await burrow({ app: "my-app" });
   ```
2. Replace `localStorage` with `store.storage`. Nothing else changes. `getItem`, `setItem`,
   `removeItem`, `clear`, `key(i)`, `length`, `storage.foo = "x"`, `"foo" in storage` and
   `Object.keys(storage)` all behave as before. Writes are visible immediately and persisted in
   the background, and are flushed when the page is hidden or closed.
3. Optionally import what the user already has:
   ```js
   if (!store.storage.length) {
     for (let i = 0; i < localStorage.length; i++) {
       const k = localStorage.key(i);
       store.storage.setItem(k, localStorage.getItem(k));
     }
   }
   ```
4. To react to changes from other devices, use `store.onChanged`. Burrow does not fire the
   window `storage` event.

The repo's acceptance test does exactly this to a sample app (`test/sample-app/app.js`): a
literal find-and-replace of the identifier, then the app's own tests run against both.

## Setting up the shared store

Do this once; every prototype then reuses the same project.

```sh
npx burrow-setup firestore          # prints the exact console steps
npx burrow-setup firestore --run    # or does them with gcloud + the Firebase CLI
```

In short: create a Firebase project **without** billing (the Spark plan), create Firestore in
production mode, deploy [`firebase/firestore.rules`](firebase/firestore.rules), and restrict the
browser API key. Then give pages the three public config fields:

```html
<meta name="burrow-firestore" content='{"apiKey":"…","projectId":"…","appId":"…"}'>
<!-- or: window.BURROW = { firestore: { apiKey, projectId, appId } } -->
<!-- or: burrow({ app, backend: new FirestoreBackend({ apiKey, projectId, appId }) }) -->
```

**The `apiKey` is an identifier, not a secret.** It is safe in page source. Restrict it in the
Google Cloud console to the Cloud Firestore API and to your own domains, so other sites cannot
spend your quota.

**Costs and ceilings.** Spark gives 1 GiB stored, plus 50,000 reads, 20,000 writes and 20,000
deletes per day, shared by every prototype on the project. Each sync costs:

| Operation | Cost |
| --- | --- |
| Pull with nothing new | 1 read |
| Pull | 1 read + 1 read per changed item |
| Push | 1 write per changed item + 1 manifest write (+ 1 manifest read) |
| Passkey enrol / recover | 1–2 reads/writes |

Writes are debounced (1.5 s by default) and coalesced. When a ceiling is hit, sync pauses until
the daily reset. On Spark there is no way to be billed.

The rules deny `list` (so ids stay capabilities) and `delete` (removal is a tombstone plus an
overwrite). They accept a first write at an unused id, and an update only with the right token
at exactly the next revision.

## Security, CSP and SRI

The store, its operator, your site's developer and anyone with a database dump cannot read user
data or tell users apart. Ids are 43-character keyed hashes, every field is ciphertext or
envelope metadata, and no user identifier exists anywhere. The threat model, derivation and
formats are in [SECURITY.md](SECURITY.md).

As with `localStorage`, a malicious script running on your origin can use the data, so protect
the page itself:

- **CSP.** Burrow needs no `eval`, inline script or third-party script host. A policy like
  `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' https://firestore.googleapis.com`
  works; see [`demo/index.html`](demo/index.html). The script-tag build loads the Firestore SDK
  on first use from `burrow-firestore.js`, next to `burrow.min.js` on your own origin.
- **SRI.** If you load from a CDN, pin the file. Every release lists its hashes:
  ```html
  <script src="https://cdn.jsdelivr.net/npm/burrow-storage@VERSION/dist/burrow.min.js"
          integrity="sha384-…" crossorigin="anonymous"></script>
  ```
  Releases are published with npm provenance. For a `'self'`-only CSP, self-host
  `burrow.min.js` and `burrow-firestore.js` together.

## Configuration

```ts
burrow({
  app: "my-app",            // required, /^[a-z0-9-]{1,64}$/
  backend,                  // default: Firestore from <meta name="burrow-firestore"> or window.BURROW
  keyProvider,              // default: [passkey(), syncCode()]
  cache: "indexeddb",       // or "memory"
  rememberDevice: true,     // false: secret in memory only (shared computers)
  syncIntervalMs: 30_000,   // polling while visible; 0 disables (live updates still arrive)
  debounceMs: 1_500,        // coalesce writes before upload
  maxItemBytes: 200_000,    // per item, plaintext; hard ceiling 749,000
  debug: false,             // one console line per sync event; never ids, keys or values
});
```

With no backend configured, Burrow still works and keeps everything on the device.

## Custom backends and unlock methods

A backend stores opaque envelopes at opaque ids and enforces the revision chain:

```ts
interface Backend {
  id: string;
  capabilities: { writeAuth: boolean; subscribe: boolean; keepalive: boolean; maxEnvelopeBytes: number };
  get(id): Promise<Envelope | null>;
  put(id, envelope, expectedRev /* null = create */): Promise<void>;  // rejects BackendError(code)
  getMany?(ids): Promise<(Envelope | null)[]>;
  subscribe?(id, onChange): () => void;
}
```

Run the conformance suite in `test/conformance/suite.ts` against yours. A store that cannot check
the token chain must declare `writeAuth: false`, and Burrow will warn.

An unlock method implements `{ id, available(), enrol(ctx), recover(ctx) }`; see `KeyProvider`
in the types. Pass it as `keyProvider`.

## Browser support and size

The last two versions of Chrome, Edge, Firefox and Safari, plus iOS Safari and Android Chrome.
Burrow needs WebCrypto, IndexedDB and BroadcastChannel; passkey PRF is optional and
feature-detected. It works from `file://` for prototyping, except passkeys, which need a secure
origin; use the sync code there.

| Bundle | min + gzip |
| --- | --- |
| Core + memory backend | 11.2 KB (budget 12 KB, checked in CI) |
| Passkey provider | +1.0 KB (budget 2 KB) |
| Firestore adapter | +0.9 KB; the Firebase SDK (≈ 135 KB) loads only when used |

## Development

```sh
npm ci
npm test               # unit, property and conformance tests (Node, fake IndexedDB)
npm run test:rules     # Firestore rules in the emulator (needs Java 21)
npm run test:firestore # backend conformance against the emulator
npm run test:e2e       # Chromium, Firefox, WebKit via Playwright, against the emulator
npm run test:live      # the conformance suite against the live shared project (writes throwaway docs)
npm run build && npm run size
npm run serve          # demo at http://localhost:4173/demo/
```

Set `BURROW_EMULATOR_PORT` if port 8080 is taken.

## License

MIT
