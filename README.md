# Burrow

**Per-user data for static sites that survives a browser reset and follows the user to their other
devices. No login. No server to write or run. Nothing readable in the store.**

**[Try the live demo](https://froussios.github.io/burrow-storage/)**: type something, then open the
page on another device and paste the storage token it shows.

```js
// In an ES module. With no store configured, the data simply stays on this device.
import { burrow } from "burrow-storage";

const store = await burrow({ app: "my-prototype" });
await store.set({ theme: "dark" });
const { theme } = await store.get("theme");
```

The user never signs up, and you never write or run a server. Burrow encrypts every value on the
device and syncs it through one free Firestore project that you create once and reuse for every
site you build. That project holds opaque ids and ciphertext: no accounts, no key names, no values.
The data belongs to a random **storage token** that the device generates and remembers. To reach
the data from another device, or after clearing the browser, the user enters that token or
unlocks a **passkey backup** of it.

- **Status:** pre-release. Everything below is implemented and tested in Chromium, Firefox and
  WebKit (passkeys in Chromium only, with a virtual authenticator), but nothing is on npm yet.
  Until the first release, follow [Installing before the first release](#installing-before-the-first-release).
- **Demo:** <https://froussios.github.io/burrow-storage/> is a page whose theme and text draft
  follow you across devices. It is redeployed from every push to `main`, and its footer shows the
  commit it was built from. It syncs through the maintainer's demo project, which does not delete
  documents, so what you type there stays in it, encrypted. The source is in [`demo/`](demo/); run
  it locally against the emulator with `npm run build` then
  `node scripts/emulator.mjs "npm run serve"` (needs Java 21) and open
  <http://localhost:4173/demo/>. To run locally against your own live or pre-production project,
  set `BURROW_FIRESTORE` to its config JSON; see
  [Local development](docs/firestore-setup.md#local-development). To deploy it with your own
  project, replace its `<meta name="burrow-firestore">` before deploying.

## Contents

- [Why Burrow](#why-burrow)
- [Privacy: who can see what](#privacy-who-can-see-what)
- [Quick start](#quick-start)
- [The API in one page](#the-api-in-one-page)
- [Reaching the data from another device](#reaching-the-data-from-another-device)
- [Replacing localStorage](#replacing-localstorage)
- [Limits, costs and browser support](#limits-costs-and-browser-support)
- [Security in brief](#security-in-brief)
- [Documentation](#documentation)
- [Development](#development)

## Why Burrow

Small sites and prototypes keep per-user state: a theme, a draft, a score, a to-do list.
`localStorage` loses it the moment the user clears site data, switches browser or picks up another
device. The usual fix is an account system and a hosted database. That asks a lot of a prototype:
a sign-up form for the user, a backend for you, and a table of personal data you then have to
protect.

Burrow replaces the account with a **capability**: the storage token, 256 random bits that the
device generates the first time your site runs and remembers, the way a browser remembers a login.
Everything follows from the token. It derives the ids under which the user's documents are stored,
the key that encrypts them, and the key that authorises writes to them. The store holds no
identity, because the ids are unguessable and the content is opaque. To use the same data on
another device, the user carries the token across (typed or pasted, ideally from a password
manager) or unlocks a passkey backup of it, and that device derives the same ids and keys.

### How it compares

| | `localStorage` | Accounts and a hosted database | Burrow |
| --- | --- | --- | --- |
| Survives clearing site data | No | Yes | Yes, if the user kept the storage token or a passkey backup |
| Same data on the user's other devices | No | Yes | Yes |
| What the user has to do | Nothing | Sign up, sign in, reset passwords | Nothing at first; keep the token or make a passkey backup to add a device |
| What you have to run | Nothing | Authentication, a database, access rules | One free Firestore project for all your sites, set up once |
| Who can read the data at rest | The device | You and your providers | Only the user's devices |
| Account data you hold | None | Emails, password hashes or OAuth ids | None |
| Works offline | Yes | Depends on the SDK | Yes; changes sync when the network returns |
| If the user loses access | The data is gone | Password reset | The data is gone: nobody can reset it |

### What else you get

- **Local-first.** Reads and writes complete against a local cache at once, with or without a
  network. Sync runs in the background and never blocks the UI.
- **A familiar API.** `BurrowArea`, the object `burrow()` resolves to, mirrors `chrome.storage`;
  its `storage` property is a synchronous drop-in for `localStorage`.
- **No bill.** On Firebase's free Spark plan the quotas are hard limits, so no amount of traffic
  can run up a charge. What heavy use or abuse can cost you is availability: sync pauses until the
  daily reset, and junk that fills the free storage stops writes until you clean it up (see
  [limits](#limits-costs-and-browser-support)).
- **A swappable store.** Firestore is one adapter behind a small `Backend` interface, and a
  conformance suite tells you when another adapter is right.

**What Burrow is not:** multi-user or shared data, real-time collaboration, a file store, or an
identity system. Two devices that change the same key are not merged: the later write wins.
**Burrow cannot reset a user's data.** If the token is gone from every device and the user kept
neither a copy nor a passkey backup, the data is unreachable. Burrow gives you an event to remind
the user at a good moment.

## Privacy: who can see what

A user's data is readable only on a device that holds their storage token, by the code your site
runs there. Everyone else in the chain handles ciphertext.

| Who | Can see | Can do |
| --- | --- | --- |
| The user, on a device that holds the token | Everything | Read and write |
| Scripts running on your page | Everything, exactly as with `localStorage` | Read and write |
| You, as owner of the Firestore project | Opaque ids, ciphertext, sizes and write times; request IP addresses too if you turn on data-access audit logs. No key names, values or user identities | Delete documents from the console, but not read or forge them |
| Google, which hosts Firestore | The same, plus each request's IP address | The same |
| Anyone with a copy of the database | Ciphertext they can neither decrypt nor attribute to a user | Nothing |
| Anyone who learns one document id | That document's ciphertext | Nothing: each write needs a one-time write token derived from the storage token |
| Anyone who reads your page's Firebase config | Nothing more | Create junk documents at unused ids, spending your free quota and storage |

This protects users from the store and whoever runs it. It does not protect them from the site
itself: your page's code holds the token, so users trust the code you serve, as they do with any
web app. For you as a developer, it means there is no account data to secure: no emails, no
passwords, no user table. A breach of the store, or a request to hand its contents over, yields
ciphertext.

### What a stored document looks like

This is the document that `BurrowArea.set({ theme: "dark" })` produced against the in-memory
backend, exactly as the operator of the store sees it:

```
o6zmGhLyv-ZWpnmyzMvJohTlfWQuqedYgW7d-e_xhZc
{
  "v": 1,
  "iv": "goGQXgqLQBiXSfNM",
  "ct": "U0FYE-a8ATYErCmnHt4HoDQR3VOH3lBAU88Qtci_QhRdzGwnY8RP1L4CgOXciCcz_XMhcc6OLCHDG3f6VIP8TSPyWhtNc8s",
  "rev": 0,
  "ts": 1791009528956,
  "tok": "j9v1mdNScMqEKgO8l8iLGljk_lsDu2q5LUjWTk_rJ8U",
  "next": "7a44f75ed594f744ad7f37edd38d37a5d8c7a6836c3b98d130db1706c65e728a"
}
```

- The first line is the document id: an HMAC-SHA-256 of the key name `theme`, under a key derived
  from the user's storage token and your app id.
- `ct` is the AES-256-GCM encryption of `{"v":1,"key":"theme","value":"dark","ts":…}`. It is bound
  to the id, the app and the revision, so it fails to decrypt if it is moved to another document
  or relabelled with another revision.
- `tok` is the one-time write token that authorised this write. `next` commits to the write token
  the next revision must present, and the store's rules check that chain with SHA-256.
- `rev` and `ts` are in the clear: the store sees how often and when a document changes.

The same write updates one more document of the same shape: the user's encrypted key directory
for this app, called the *manifest*, which tells another device which keys exist. Nothing in
either document names the user. Only timing links them: a user's documents are written moments
apart. Listing the collection is denied, so an id is the only way in, and ids cannot be guessed.

[SECURITY.md](SECURITY.md) has the full threat model.

## Quick start

### 1. Create the store, once

Burrow works with no store at all: data then stays on the device, and `burrow()` warns once in the
console. To sync across devices, create one Firebase project on the free Spark plan and reuse it
for every site you build:

```sh
npx burrow-setup firestore
```

It prints the console steps: create the project, create Firestore, deploy the security rules that
ship with Burrow, and restrict the API key. To have a coding agent perform the steps, tell it:

> Follow `node_modules/burrow-storage/firebase/SETUP-AGENT.md` to set up a Burrow store.

The [agent guide](firebase/SETUP-AGENT.md) asks for your project id, permanent location and
website referrers, verifies each step before changing resources, and records resumable progress.
Sign-in and choices that need human confirmation stay with you. It never enables billing or
other Firebase products. The provisioning instructions still await a fresh-project end-to-end
run and a second verification run.

Burrow requires `apiKey` and `projectId`; `appId` is optional. **These values are public by
design.** The `apiKey` identifies your project and sits in your page source. Restrict it to the
Cloud Firestore API and to your own domains: that stops other websites from using it in their
pages, though not a script running outside a browser. Details, costs and quotas:
[docs/firestore-setup.md](docs/firestore-setup.md).

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

`burrow.min.js` defines the global `Burrow`. It does not inline the Firestore SDK: on first use it
loads `burrow-firestore.js` from its own directory. Serve both files from your site and the page
contacts no third-party script host and runs under `script-src 'self'` (move the inline script
into a file of its own). If you load `burrow.min.js` from a CDN instead, the SDK file comes from
that CDN too, and that second request carries no SRI hash. Each release attaches both files with
their SRI hashes.

Pin the bundle with its Subresource Integrity hash, whether you load it from a CDN or your own
site:

```html
<script src="https://cdn.jsdelivr.net/npm/burrow-storage@VERSION/dist/burrow.min.js"
        integrity="sha384-HASH" crossorigin="anonymous"></script>
```

Each release's notes print this tag with the real `VERSION` and `HASH`, and `npm run sri` prints
it for a local build (the hashes are also written to `dist/sri.json`).

### 2b. Bundler or ESM

```sh
npm install burrow-storage firebase
```

`firebase` is an optional peer dependency, needed only for the Firestore backend.

```js
import { burrow } from "burrow-storage";

const store = await burrow({
  app: "my-prototype",
  firestore: { apiKey: "…", projectId: "your-project" },
});
```

Use your own Firebase project; the owner's store is for the hosted demo only. `appId` is optional.
The explicit `backend: new FirestoreBackend(config)` form from `burrow-storage/firestore` also
works. Invalid remote configuration keeps local storage available with `status: "error"`;
fix the config and reload the page to enable sync.

Generic page configuration selects an adapter by type:

```html
<meta name="burrow-backend"
      content='{"type":"firestore","apiKey":"…","projectId":"your-project"}'>
```

With this tag (or `window.BURROW = { backend: { type: "firestore", … } }`) you can omit
`backend` and `firestore`. The legacy `burrow-firestore` tag and `window.BURROW.firestore`
also work. The adapter loads on demand. See [backend configuration](docs/extending.md#page-configuration)
and the [candidate assessment](docs/backend-candidates.md) for other stores.

### 3. Use it

```js
await store.set({ theme: "dark", draft: "Dear diary" });   // durable locally before it resolves
const { theme } = await store.get("theme");                 // from the cache, no network
const all = await store.get();                              // every key
await store.remove("draft");

store.onChanged.addListener(({ changes, source }) => {
  // source: "local" (written on this device, in this tab or another) or "remote" (pulled from the store)
  if (changes.theme) applyTheme(changes.theme.newValue);
});

store.onStatus.addListener(({ status, error }) => {
  badge.textContent = status;                               // "idle" | "syncing" | "offline" | "error"
});
```

Writes never fail because the network did. If the store is unreachable, `status` becomes
`"offline"`, the writes wait in the local cache, and sync resumes with backoff.

### Installing before the first release

Nothing is published to npm yet, so `npm install burrow-storage` and `npx burrow-setup` do not work
today. Build from a clone instead:

```sh
git clone https://github.com/Froussios/burrow-storage.git
cd burrow-storage && npm ci && npm run build
node scripts/burrow-setup.mjs firestore     # the setup guide, in place of npx burrow-setup
```

Then copy `dist/burrow.min.js` and `dist/burrow-firestore.js` next to your page, or run
`npm install /path/to/burrow-storage firebase` in your project for the ESM build.

## The API in one page

Full reference with every signature and error: [docs/api.md](docs/api.md).

| Member | What it does |
| --- | --- |
| `burrow(config)` | Opens the store for one `app`. Resolves from the local cache, usually within a few milliseconds, with no user interaction. Calling it again with the same `app` on the same page returns the same instance. |
| `get(keys?, { fresh? })` | `chrome.storage` shapes: nothing (all keys), `"key"`, `["a","b"]`, or `{ key: default }`. `fresh: true` fetches from the store first. |
| `set(items)` | Any JSON values. Resolves once written locally. Non-JSON values (`Date`, `Map`, functions, `undefined`, `NaN`) are rejected with a `TypeError`. |
| `remove(keys)`, `clear()` | Delete keys everywhere; a tombstone carries the delete to other devices. |
| `getBytesInUse(keys?)` | Size of the keys and their JSON values, counted as `chrome.storage` counts it. |
| `onChanged` | `{ changes: { key: { oldValue?, newValue? } }, source }`. Use `addListener(fn)`, or `addEventListener("changed", e => e.detail)`. |
| `status`, `onStatus` | `"idle"`, `"syncing"`, `"offline"` or `"error"`; the event carries the last `BurrowError`. |
| `token`, `onToken` | Where this device's storage token came from: `{ source, remembered, since }`. |
| `exportToken()` | The storage token: 56 characters in groups of four. |
| `link({ token, source? })` | Adopt an existing token on this device: typed in, or returned by a backup such as a passkey. `source` labels it in `token.source`. |
| `unlink()` | Forget the token on this device, like logging out, and close this instance. The cached data stays, in plaintext, until the next `burrow()` clears it. |
| `syncNow()` | Run one sync pass now; rejects if it failed. |
| `exportJSON()`, `importJSON(json)` | A plaintext export of the app's data, and its inverse. |
| `inspect()` | A plain object for a debug panel. |
| `storage` | The synchronous `Storage` facade. |
| `passkeyBackup()` | From `burrow-storage/passkey`, optional: `save(token)` behind a passkey, `restore()` it on another device. |

Failures that Burrow detects reject with a `BurrowError` that carries a stable `code`:
`bad-token`, `item-too-large`, `would-orphan`, `unlinked`, `cancelled`, `prf-unsupported`,
`decrypt-failed`, `conflict`, `quota` or `backend`. Invalid arguments reject with a `TypeError`, or
throw one from the synchronous facade. Two calls can also pass on an error from below: `set()` when
the browser refuses the local write (for example, its storage is full), and
`passkeyBackup().save()` when the store fails.

## Reaching the data from another device

The first device generates the storage token on first use and remembers it. Another device gets
the same token to `link()`; the store does not care how. Burrow supports two ways:

| Way | First device | Other device |
| --- | --- | --- |
| Storage token | `BurrowArea.exportToken()`, shown to the user | `BurrowArea.link({ token })` with what they type |
| Passkey backup | `PasskeyBackup.save(token)` | `BurrowArea.link({ token: await PasskeyBackup.restore(), source: "passkey" })` |

- **Storage token.** 56 characters, such as
  `07DV-1XKY-2X98-DRCP-DJV6-FC2E-459V-AJTY-26K2-XJFQ-9BXZ-QRNF-X0F5-Z1XS` (made up; it fails its
  checksum). Case, spaces and hyphens are ignored, and `O`/`0` and `I`/`L`/`1` read the same. A
  bad checksum rejects with `bad-token` before any network call. The natural place to keep it is a
  password manager.
- **Passkey backup.** `passkeyBackup()` from `burrow-storage/passkey` stores the token in a
  *keyslot* document, encrypted under a key that only the passkey can derive (WebAuthn PRF), and
  gives it back on another device with one prompt. Needs HTTPS or `localhost` and PRF support,
  which still varies: `available()` says whether it can work, without prompting.
  Saving again with the same `userName` on the same site may replace its earlier passkey;
  pass distinct labels to keep separate backups. Warn first and keep the current and any
  earlier storage tokens: a failed save after creation can lose the earlier passkey route.
  [Naming and replacement limits](docs/api.md#passkey-backup).

Token recovery and content storage are deliberately independent. The passkey utility reuses
the storage implementation's `Backend` interface, but can use a different instance: pass
`passkeyBackup({ backend })` a backend for another Firebase project or another database.
Keeping the token directly in a password manager needs no keyslot backend or passkey utility.
This separation lets sites choose content storage and recovery independently, including their
availability and retention policies. New token carriers and backend adapters should preserve
it; sharing the page's backend by default is a convenience. See
[independent token and content storage](docs/extending.md#independent-token-and-content-storage).

Burrow does not track whether the token is kept anywhere. `token.source === "generated"` means it
was made on this device and exists nowhere else as far as Burrow knows: the moment to nudge the
user to keep it ([how](docs/sync-and-tokens.md#what-to-show)).

`link()` with a different token replaces the token for every Burrow app on the origin, refills the
cache from the store, and fires `onToken` and `onChanged`. Writes this app has not synced are pushed
first; if any remain, it rejects with `would-orphan`, unless called with `discardLocal: true`. Other
apps on the origin switch on their next load and drop what they had not synced.

`burrow({ app, rememberDevice: false })` keeps the token in memory only, for shared computers.
Anything written before `link()` belongs to a throwaway token.

## Replacing localStorage

`BurrowArea.storage` implements the Web Storage `Storage` interface synchronously, including
named-property access. Writes are visible at once and persisted and synced in the background. The
repository runs a sample app's own tests against both `localStorage` and `BurrowArea.storage`. The
main differences:

- It exists only once `burrow()` has resolved, so start-up reads (for example, applying a theme
  before first paint) wait for it.
- No window `storage` event; `BurrowArea.onChanged` reports changes.
- Keys are per `app`, where `localStorage` is shared by the whole origin.
- Values written with `BurrowArea.set()` read back from `getItem` as their JSON text.

The full comparison with Web Storage and `chrome.storage`:
[docs/storage-standards.md](docs/storage-standards.md).

## Limits, costs and browser support

| | |
| --- | --- |
| Item size | `maxItemBytes`: default 200 000 bytes of JSON per item, hard ceiling 749 000 |
| Spark quotas | Per day, shared by all your sites: 50 000 reads, 20 000 writes, 20 000 deletes; 1 GiB stored in total |
| Sync with nothing new | 1 read |
| Pulling changes | 1 read, plus 1 per changed item |
| Pushing *n* changed items | *n* + 1 writes and about *n* + 2 reads, because Firestore writes run in a transaction that reads first |
| Polling | Every 30 s while the page is visible (configurable). A Firestore listener on the manifest also delivers changes as they happen. |
| Capacity | At the default interval, a visible tab costs about 120 reads an hour, so the daily reads cover roughly 400 hours of open, visible tabs across all your sites |
| Conflicts | Per key, the later write wins, by device clock corrected for skew. Values are never merged. |
| Eviction | Safari deletes a site's IndexedDB, and with it the remembered token, after seven days of Safari use without the user interacting with the site. Other browsers may evict storage when the disk runs low; Burrow does not request persistent storage. The data stays in the store, reachable with the storage token or a passkey backup. |
| Browsers | Tested on Chromium, Firefox and WebKit; aimed at the last two versions of Chrome, Edge, Firefox and Safari, iOS Safari and Android Chrome. Needs a secure context (HTTPS or `localhost`), because WebCrypto does. Without IndexedDB the cache is in memory and the token is not remembered. |
| Bundle | `burrow.min.js` about 14 KB min+gzip (core 11.4 KB, held under a 12 KB budget in CI); `burrow-firestore.js` about 135 KB, loaded only when Firestore is used |

Writes are debounced (1.5 s) and coalesced. Raise `syncIntervalMs` for sites with long-lived tabs.
When a daily quota runs out, sync pauses until it resets and then resumes on its own. Stored bytes
do not reset: anyone who reads your page's config can fill the 1 GiB with junk documents, which
look like users' documents. Writes for every site on the project then fail until you clean up by
hand. [docs/firestore-setup.md](docs/firestore-setup.md) has the full cost table and the abuse
story.

## Security in brief

Everything the store holds is derived from the user's storage token through one-way functions, or
is ciphertext under a key derived from it:

- **Ids:** `base64url(HMAC-SHA-256(pathKey, "item" ‖ key))`, with one key set per user and app,
  derived with HKDF.
- **Content:** AES-256-GCM with a fresh IV per write; the id, the app and the revision are bound
  as additional authenticated data.
- **Writes:** a per-document hash chain of one-time HMAC write tokens, checked by the store's rules
  with SHA-256.
- **On the device:** the token is wrapped with AES-KW under a non-extractable WebCrypto key that is
  stored beside it in IndexedDB. That stops a script from exporting the token, but not someone
  who copies the browser profile. Cached items are plaintext, as with `localStorage`.
- **Leaving the device:** the token leaves only when the user carries it, as text, or inside a
  passkey keyslot.

Out of scope, as for `localStorage`: a malicious script on your own origin, and the code your site
serves. Ship a strict CSP and use SRI for the script tag. Burrow needs no `eval`, no inline script
and no third-party host, and the demo runs under `default-src 'none'`. [SECURITY.md](SECURITY.md)
has the derivation, the formats, the threat table, and the plain list of what Burrow does *not*
protect against: copied browser profiles, junk filling the store, and timing metadata.

## Documentation

| | |
| --- | --- |
| [docs/api.md](docs/api.md) | Full API reference: config, methods, events, errors, types |
| [docs/sync-and-tokens.md](docs/sync-and-tokens.md) | Storage tokens, passkey backups, `rememberDevice`, what to show users |
| [docs/storage-standards.md](docs/storage-standards.md) | Setting up, and how Burrow differs from Web Storage and `chrome.storage` |
| [docs/firestore-setup.md](docs/firestore-setup.md) | Creating and running the store: rules, costs, quotas, abuse |
| [docs/extending.md](docs/extending.md) | Writing a backend for another store, or another way to carry the token |
| [SECURITY.md](SECURITY.md) | Cryptographic design and threat model |
| [docs/architecture.md](docs/architecture.md) | How the implementation fits together, for contributors |
| [docs/decisions.md](docs/decisions.md) | Decision log |
| [CHANGELOG.md](CHANGELOG.md) | Changes per release |

## Development

```sh
npm ci
npm test               # unit, property and backend-conformance tests (Node, fake IndexedDB)
npm run typecheck
npm run build          # dist/: ESM entries, burrow.min.js, burrow-firestore.js
npm run size           # bundle budgets
npm run docs:check     # typechecks every code example in this README and the guides (after a build)
npm run test:rules     # Firestore rules in the emulator (needs Java 21)
npm run test:firestore # backend conformance against the emulator
npm run test:e2e       # Chromium, Firefox and WebKit via Playwright, against the emulator
npm run serve          # local demo defaults to the emulator; BURROW_FIRESTORE selects your own project
npm run demo:build     # site/: the deployable demo, stamped with the commit (after npm run build)
npm run test:smoke     # demo smoke test: BURROW_DEMO_URL=<deployed demo>, or site/ under the emulator
```

`npm run check` runs typecheck, tests, build, size and `docs:check` in one go. Development needs
Node 22 or newer; the emulator suites need Java 21. Set `BURROW_EMULATOR_PORT` if port 8080 is
taken. To start the emulator and local demo together, run
`node scripts/emulator.mjs "npm run serve"` after building. Bare `npm run serve` expects an
already-running emulator at `127.0.0.1:8080`, or at `FIRESTORE_EMULATOR_HOST` if set; it never
uses the source page's project config. To connect to your own real project, explicitly set
`BURROW_FIRESTORE` to its config JSON before running `npm run serve` directly. Invalid config
stops the server; do not also set `FIRESTORE_EMULATOR_HOST`. See
[Local development](docs/firestore-setup.md#local-development) for commands.
Contributor notes are in [CLAUDE.md](CLAUDE.md).

## License

MIT
