# Burrow

**Per-user data for static sites that survives a browser reset and follows the user to their other
devices. No login. No backend of your own. Nothing readable in the store.**

```js
import { burrow } from "burrow-storage";

const store = await burrow({ app: "my-prototype" });
await store.set({ theme: "dark" });
const { theme } = await store.get("theme");
```

That is the whole integration. The user is never asked to sign up, and you never run a server.
The data is encrypted on the device and kept in one shared, free Firestore project that every
prototype can reuse. The project's operator, you, and anyone holding a dump of the database see
only random-looking ids and ciphertext.

- **Demo:** [`demo/`](demo/) is a page whose theme and text draft follow you across devices. Run it
  with `npm run build && npm run serve` and open <http://localhost:4173/demo/>; a hosted copy is
  published to GitHub Pages from `main`.
- **Status:** pre-release. The API below is implemented and tested; the first npm release is
  pending, so until then build from source (see [Development](#development)).

## Contents

- [Why Burrow](#why-burrow)
- [What the store sees](#what-the-store-sees)
- [Quick start](#quick-start)
- [The API in one page](#the-api-in-one-page)
- [Reaching the data from another device](#reaching-the-data-from-another-device)
- [Replacing localStorage](#replacing-localstorage)
- [Setting up the shared store](#setting-up-the-shared-store)
- [Limits, costs and browser support](#limits-costs-and-browser-support)
- [Security in brief](#security-in-brief)
- [Documentation](#documentation)
- [Development](#development)

## Why Burrow

Small sites and prototypes keep per-user state: a theme, a draft, a score, a list. `localStorage`
loses it the moment the user clears site data or opens another device. Every hosted alternative
asks for something a prototype should not need: an account for the user to create, a backend for
you to run, or a paid tier per project.

Burrow replaces the account with a **capability**: a random 256-bit secret, generated on the device
the first time your site runs, kept like a session cookie. Everything else follows from that
secret. It derives the ids under which the user's documents are stored, the key that encrypts them,
and the key that authorises writes. The store needs no idea who the user is, because the ids are
unguessable and the content is opaque. A user who wants the same data on a second device carries
the secret across, as a passkey or as a 56-character **storage token**, and the second device
derives the same ids and keys.

What you get:

| | |
| --- | --- |
| **No login** | No account, email, OAuth popup or consent screen. First use is silent. |
| **No backend** | Static files only. One Firestore project on the free Spark plan serves all your prototypes, and it has hard daily quotas, so the worst case under abuse is "sync pauses", never a bill. |
| **Local-first** | Reads and writes complete against the local cache immediately and work offline. Sync is a background process that never blocks the UI. |
| **Private by construction** | The store holds keyed-hash ids and AES-256-GCM ciphertext. Writes are gated by a hash chain only the secret's holder can extend, so even someone who learns an id can read nothing and write nothing. |
| **Familiar shape** | The async API mirrors `chrome.storage`. `store.storage` is a synchronous drop-in for `localStorage`. |
| **Swappable store** | Firestore is one adapter behind a small `Backend` interface; a conformance suite tells you when yours is right. |

What it is not: multi-user or shared data, real-time collaboration, a file store, or an identity
system. **Burrow cannot reset a user's data.** If the secret is gone from every device and there is
no passkey backup or saved token, the data is unreachable. Burrow gives you the hooks to tell the
user so at a good moment.

## What the store sees

This is a real document, produced by `store.set({ theme: "dark" })` against the in-memory backend,
exactly as the operator of the shared Firestore collection would see it:

```
a7tkB2hrkzrgP1Xcuc6mdBIn7k-Znuoddrm7Ij7F6eQ
{
  "v": 1,
  "iv": "_7JMHgHRuX6Jcc3d",
  "ct": "CcAWNBvevgwBL68y7TTwHAYH1FW9vW3FjZneDHKyL2VBCVjEzDnusnm8LsuzH_7CuExNcppP5WOfaFvAAvWa2Fw0HnrqeKm7c5u1li1GJjHT0w",
  "rev": 0,
  "ts": 1791007923822,
  "tok": "2y6ROEfHowJEIvdMOBPYORzAZKfDlUA8d7uwHNqD4VE",
  "next": "f604b4a4e4bdbf329a6a70c567fd6a481bade773ad1df44ff1a1d01bd46be9ee",
  "z": true
}
```

The id (first line) is 43 characters derived from the user's secret and the key name by HMAC. `ct`
is the AES-256-GCM ciphertext of `{ key: "theme", value: "dark" }`, bound to the id, your app id
and the revision. `tok` is the one-time token that authorised this write; `next` commits to the
token the next revision must present, and the store's rules verify that chain with SHA-256. There
is no user id, no key name, no plaintext, nothing that links two documents of the same user.
Listing the collection is denied, so an id is the only way in, and 256 random bits are not
guessable.

What the store does learn: how many documents exist, their sizes, when they are written, and the
IP each request comes from. What a script running on your own origin learns: everything, exactly
as with `localStorage`. [SECURITY.md](SECURITY.md) has the full threat model.

## Quick start

### 1. Pick a store

Burrow works with no store at all: data then stays on the device, and `burrow()` warns once in the
console. To sync across devices you need the shared Firestore project, created once and reused by
every site you build:

```sh
npx burrow-setup firestore
```

It prints the console steps (create a Spark project, create Firestore, deploy the bundled rules,
restrict the API key) and gives you three public values: `apiKey`, `projectId`, `appId`. Details,
costs and quotas are in [docs/firestore-setup.md](docs/firestore-setup.md).

### 2a. Script tag, no bundler

```html
<meta name="burrow-firestore" content='{"apiKey":"…","projectId":"…","appId":"…"}'>
<script src="burrow.min.js"></script>
<script>
  Burrow.burrow({ app: "my-prototype" }).then(async (store) => {
    await store.set({ theme: "dark" });
    const { theme } = await store.get("theme");
  });
</script>
```

`burrow.min.js` exposes the global `Burrow`. The Firestore SDK is not inlined: on first use the
adapter loads `burrow-firestore.js` from the same directory as `burrow.min.js`. Self-host the two
files together and the page contacts no third-party script host, works under `script-src 'self'`,
and works from `file://`. (If you load `burrow.min.js` from a CDN instead, the SDK file comes from
that CDN too, and that second request carries no SRI hash.) Both files are in the package's `dist/`
folder and attached to every GitHub release with their SRI hashes.

### 2b. Bundler or ESM

```sh
npm install burrow-storage firebase
```

`firebase` is an optional peer dependency; it is needed only when you use the Firestore backend.

```js
import { burrow } from "burrow-storage";
import { FirestoreBackend } from "burrow-storage/firestore";

const store = await burrow({
  app: "my-prototype",
  backend: new FirestoreBackend({ apiKey: "…", projectId: "…", appId: "…" }),
});
```

With the `<meta name="burrow-firestore">` tag (or `window.BURROW = { firestore: {…} }`) on the
page you can omit `backend`; Burrow finds the config and loads the adapter itself.

### 3. Use it

```js
await store.set({ theme: "dark", draft: "Dear diary" });   // durable locally before it resolves
const { theme } = await store.get("theme");                 // from the cache, no network
const all = await store.get();                              // every key
await store.remove("draft");

store.onChanged.addListener(({ changes, source }) => {
  // source: "local" (this device) or "remote" (another device or tab)
  if (changes.theme) applyTheme(changes.theme.newValue);
});

store.onStatus.addListener(({ status, error }) => {
  badge.textContent = status;                               // "idle" | "syncing" | "offline" | "error"
});
```

Writes never fail because the network did. If the store is unreachable, `status` becomes
`"offline"`, the writes wait, and sync resumes with backoff.

## The API in one page

Full reference with every signature and error: [docs/api.md](docs/api.md).

| Member | What it does |
| --- | --- |
| `burrow(config)` | Opens the store for one `app`. Resolves from the local cache, usually in a few milliseconds, with no user interaction. Same `app` on the same page returns the same instance. |
| `get(keys?, { fresh? })` | `chrome.storage` shapes: nothing (all keys), `"key"`, `["a","b"]`, or `{ key: default }`. `fresh: true` fetches from the store first. |
| `set(items)` | Any JSON values. Resolves once written locally. Non-JSON values (`Date`, `Map`, functions, `undefined`, `NaN`) throw `TypeError`. |
| `remove(keys)`, `clear()` | Delete keys everywhere; a tombstone reaches other devices. |
| `getBytesInUse(keys?)` | Size of the plaintext JSON, as `chrome.storage` counts it. |
| `onChanged` | `{ changes: { key: { oldValue?, newValue? } }, source }`. `addListener(fn)` or `addEventListener("changed", e => e.detail)`. |
| `status`, `onStatus` | `"idle"`, `"syncing"`, `"offline"`, `"error"`; the event carries the last `BurrowError`. |
| `token`, `onToken` | Where this device's storage token came from: `{ source, remembered, since }`. |
| `protection`, `onUnprotected` | Whether a passkey or a saved token can bring the data back; `onUnprotected` fires once per device when there is data and nothing protects it. |
| `exportCode()` | The storage token, 56 characters in groups of four. |
| `link({ code })`, `link({ provider })`, `link()` | Adopt an existing token on this device: typed in, or recovered by a passkey. |
| `protect("passkey")` | Create a passkey backup of the token. |
| `unlink()` | Forget the token on this device, like logging out. |
| `syncNow()` | Run one sync pass now; rejects if it failed. |
| `exportJSON()`, `importJSON(json)` | Plaintext export of the app's data, and its inverse. |
| `inspect()` | A plain object for a debug panel. |
| `storage` | The synchronous `Storage` facade. |

Every rejection is a `BurrowError` with a stable `code`: `bad-code`, `item-too-large`,
`would-orphan`, `no-provider`, `prf-unsupported`, `decrypt-failed`, `conflict`, `quota`, `backend`.
Invalid arguments throw `TypeError`.

## Reaching the data from another device

Nothing is needed on the first device: the token is generated and remembered there. To use the
same data elsewhere, the user carries the token across in one of two ways.

**The storage token.** Always available, including from `file://`. Show
`await store.exportCode()` on the first device; on the second, call `store.link({ code })` with
what the user typed or pasted. The token looks like
`0400-20G3-0G2G-C1R8-1450-P30D-1R7H-048J-2CA1-A5GQ-30CH-M6RW-3MF1-YJ8H`. Case, spaces and hyphens
do not matter, and `O`/`0` and `I`/`L`/`1` are read as the same. A mistyped token fails the
checksum and rejects with `bad-code` before any network call. The page may also offer it as a link,
`https://your.site/#burrow=<token>`: a device that opens the link adopts the token and Burrow
removes it from the address bar at once.

**A passkey backup.** `store.protect("passkey")` creates a passkey and stores the token in a
*keyslot* document wrapped under the passkey's PRF output; the passkey never becomes the secret.
On another device, `store.link({ provider: "passkey" })` needs one passkey prompt. Passkeys need
a secure origin (`https:` or `localhost`), and PRF support is uneven across browsers and
authenticators; where it is missing `protect("passkey")` rejects with `prf-unsupported`. The
storage token is the path that always works.

```js
// A calm moment to nudge the user, once per device, when there is data worth keeping.
store.onUnprotected.addListener(() => {
  showBanner("Keep a copy of your storage token, or back it up with a passkey.");
});

// Second device
try {
  await store.link({ code: input.value });
} catch (e) {
  if (e.code === "bad-code") say("That token is not right.");
  if (e.code === "would-orphan") {
    // this device has writes that never synced; confirm, then
    await store.link({ code: input.value, discardLocal: true });
  }
}
```

Linking replaces the device's token for every Burrow app on the origin, pulls the data, and fires
`onToken` and `onChanged`; another app on the same origin picks the new token up on its next load
and drops what it cached under the old one, including anything it never managed to sync. On
shared computers use `burrow({ app, rememberDevice: false })`: the token lives in memory only,
the cache defaults to memory, and the user links each session. Have them link before they write,
because anything written first belongs to a throwaway token.

## Replacing localStorage

```js
const store = await burrow({ app: "my-app" });
const storage = store.storage;      // implements the DOM Storage interface, synchronously
storage.setItem("draft", text);     // visible at once, persisted and synced in the background
storage.getItem("draft");
```

Swapping the identifier `localStorage` for `store.storage` is the only change: `getItem`,
`setItem`, `removeItem`, `clear`, `key(i)`, `length`, `storage.foo = "x"`, `"foo" in storage` and
`Object.keys(storage)` all behave as before, pending writes are flushed when the page is hidden or
closed, and the repository's acceptance test does exactly that find-and-replace on a sample app.
Two differences: Burrow does not fire the window `storage` event (use `onChanged`), and values
written through the async API come back from `getItem` as their JSON text. Migration recipe:
[docs/localstorage-migration.md](docs/localstorage-migration.md).

## Setting up the shared store

One Firebase project on the Spark plan, created once:

```sh
npx burrow-setup firestore          # prints the exact console steps
npx burrow-setup firestore --run    # or performs them with gcloud and the Firebase CLI
```

The project needs no billing account, no Authentication product, no Functions. The bundled
[`firebase/firestore.rules`](firebase/firestore.rules) let anyone read a document by id, nobody
list or delete, and allow an update only at the next revision with the right token. Then put the
three public config values on each page as the `<meta name="burrow-firestore">` tag shown above.

**The `apiKey` is an identifier, not a secret.** Restrict it in the Google Cloud console to the
Cloud Firestore API and to your own domains so other sites cannot spend your quota. The guide:
[docs/firestore-setup.md](docs/firestore-setup.md).

## Limits, costs and browser support

| | |
| --- | --- |
| Item size | `maxItemBytes`, default 200 000 bytes of JSON per item, hard ceiling 749 000 |
| Spark quotas | 1 GiB stored; 50 000 reads, 20 000 writes, 20 000 deletes per day, shared by all your prototypes |
| Pull with nothing new | 1 read |
| Pull | 1 read, plus 1 per changed item |
| Push | about 1 read and 1 write per changed item (Firestore writes go through a transaction), plus 1 read and 1 write for the manifest |
| Polling | every 30 s while the page is visible (configurable); live updates also arrive through a Firestore listener |
| Browsers | last two versions of Chrome, Edge, Firefox and Safari, iOS Safari, Android Chrome. Requires WebCrypto. Without IndexedDB the cache is in memory and the token is not remembered; without `BroadcastChannel` tabs are not coordinated. |
| Bundle | `burrow.min.js` 14 KB min+gzip (core 11.4 KB, checked in CI against a 12 KB budget); `burrow-firestore.js` 140 KB, loaded only when Firestore is used |

Writes are debounced (1.5 s) and coalesced. When a daily ceiling is hit, sync pauses until the
quota resets and resumes on its own.

## Security in brief

Everything the store holds is derived from the user's secret through one-way functions or is
ciphertext under a key derived from it:

- ids: `base64url(HMAC-SHA-256(pathKey, "item" ‖ key))`, one key per app per user via HKDF;
- content: AES-256-GCM with a fresh IV per write, id, app and revision bound as additional data;
- writes: a per-document hash chain of one-time HMAC tokens, checked by the rules with SHA-256;
- on the device: the secret is wrapped (AES-KW) under a non-extractable WebCrypto key in IndexedDB;
- in transit: the secret leaves the device only inside a passkey keyslot or as the storage token.

Out of scope, as for `localStorage`: a malicious script on your own origin. Ship a strict CSP and
use SRI for the script tag; Burrow needs no `eval`, no inline script and no third-party host, and
the demo runs under `default-src 'none'`. [SECURITY.md](SECURITY.md) has the derivation, formats,
threat table and the honest list of what is *not* protected (copied browser profiles, storage
exhaustion of the shared project, timing metadata).

## Documentation

| | |
| --- | --- |
| [docs/api.md](docs/api.md) | Full API reference: config, methods, events, errors, types |
| [docs/sync-and-tokens.md](docs/sync-and-tokens.md) | Storage tokens, passkey backups, links, `rememberDevice`, UX advice |
| [docs/localstorage-migration.md](docs/localstorage-migration.md) | The facade and how to migrate an existing site |
| [docs/firestore-setup.md](docs/firestore-setup.md) | Creating and operating the shared store; costs, quotas, abuse |
| [docs/extending.md](docs/extending.md) | Writing a backend for another store, or a custom unlock method |
| [SECURITY.md](SECURITY.md) | Cryptographic design and threat model |
| [docs/architecture.md](docs/architecture.md) | How the implementation is put together (for contributors) |
| [docs/decisions.md](docs/decisions.md) | Decision log |
| [CHANGELOG.md](CHANGELOG.md) | Changes per release |

## Development

```sh
npm ci
npm test               # unit, property and backend-conformance tests (Node, fake IndexedDB)
npm run typecheck
npm run build          # dist/: ESM entries, burrow.min.js, burrow-firestore.js
npm run size           # bundle budgets
npm run test:rules     # Firestore rules in the emulator (needs Java 21)
npm run test:firestore # backend conformance against the emulator
npm run test:e2e       # Chromium, Firefox, WebKit via Playwright, against the emulator
npm run serve          # demo at http://localhost:4173/demo/ (after npm run build)
```

`npm run check` runs typecheck, tests, build, size and `docs:check` (which typechecks every code
example in this README and the guides) together. Development needs
Node 22 or newer; the emulator suites need Java 21. Set `BURROW_EMULATOR_PORT` if port 8080 is
taken. Contributor notes are in [CLAUDE.md](CLAUDE.md).

## License

MIT
