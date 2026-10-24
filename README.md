# Burrow

**Per-user data for static sites that follows the user to their other devices. No login. No
server to write or run. Nothing readable in the store.**

**[Try the live demo](https://froussios.github.io/burrow-storage/)**: start with a new token or a
passkey, type something, then open the page on another device and sign in the same way.

```js
// In an ES module.
import { burrow, generateToken } from "burrow-storage";

const token = await generateToken(); // or a passkey's token, or one the user kept
const store = await burrow({ app: "my-prototype", backend, token });
await store.set({ theme: "dark" });
const { theme } = await store.get("theme");
```

The user never signs up, and you never write or run a server. Burrow encrypts every value in the
browser and stores it in one free Firestore project that you create once and reuse for every site
you build. That project holds opaque ids and ciphertext: no accounts, no key names, no values.
The data belongs to a random **storage token**. Whoever holds the token can read and write the
data from any device; Burrow itself never stores it. Your page decides how the user keeps it:
typed or pasted, derived from a **passkey** each visit, or kept by the page on the device.

Burrow comes in three independent parts:

- **The core** (`burrow-storage`): remote storage. Async `get`/`set`/`remove`/`clear` that go
  to the store, encryption under the hood, nothing written to the device.
- **The offline wrapper** (`burrow-storage/offline`), optional: the same interface over a local,
  **unencrypted** copy in IndexedDB, so reads and writes keep working offline and sync later.
- **The passkey token** (`burrow-storage/passkey`), optional: a storage token derived from a
  passkey, so a user can sign in on any device that has the passkey, with nothing stored anywhere.

- **Status:** pre-release. Everything below is implemented and tested in Chromium, Firefox and
  WebKit (passkeys in Chromium only, with a virtual authenticator), but nothing is on npm yet.
  Until the first release, follow [Installing before the first release](#installing-before-the-first-release).
- **Demo:** <https://froussios.github.io/burrow-storage/> is a page whose theme and text draft
  follow you across devices, with both ways of signing in: on every visit (nothing stored on the
  device) or staying signed in (the page keeps the token and an unencrypted copy). It is
  redeployed from every push to `main`, and its footer shows the commit it was built from. It
  syncs through the maintainer's demo project, which does not delete documents, so what you type
  there stays in it, encrypted. The source is in
  [`demo/`](https://github.com/Froussios/burrow-storage/tree/main/demo/); run
  it locally against the emulator with `npm run build` then
  `node scripts/emulator.mjs "npm run serve"` (needs Java 21) and open
  <http://localhost:4173/demo/>. To run locally against your own live or pre-production project,
  set `BURROW_FIRESTORE` to its config JSON; see
  [Local development](https://github.com/Froussios/burrow-storage/blob/main/docs/firestore-setup.md#local-development).
  To deploy it with your own project, replace its `<meta name="burrow-firestore">`
  before deploying.

## Contents

- [Why Burrow](#why-burrow)
- [Privacy: who can see what](#privacy-who-can-see-what)
- [Quick start](#quick-start)
- [The API in one page](#the-api-in-one-page)
- [Signing in: where the token lives](#signing-in-where-the-token-lives)
- [Coming from localStorage](#coming-from-localstorage)
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

Burrow replaces the account with a **capability**: the storage token, 256 random bits. Everything
follows from the token. It derives the ids under which the user's documents are stored, the key
that encrypts them, and the key that authorises writes to them. The store holds no identity,
because the ids are unguessable and the content is opaque. On another device, the same token
derives the same ids and keys, so the data is simply there.

Because the token is the whole identity and cannot be revoked, Burrow does not keep it for you.
Your page passes it to `burrow()`, and Burrow holds only the keys derived from it, in memory. You
choose how the user gets the token back next time:

| | How | Stored on the device |
| --- | --- | --- |
| Sign in every visit | A passkey prompt (`passkeyToken().get()`), or the user pastes the token | Nothing |
| Stay signed in | Your page keeps the token itself, and the offline wrapper keeps a copy of the data | Whatever your page stores, plus an unencrypted copy of the data |

### How it compares

| | `localStorage` | Accounts and a hosted database | Burrow |
| --- | --- | --- | --- |
| Survives clearing site data | No | Yes | Yes, if the user kept the storage token or a passkey |
| Same data on the user's other devices | No | Yes | Yes |
| What the user has to do | Nothing | Sign up, sign in, reset passwords | Keep a token, or approve a passkey prompt |
| What you have to run | Nothing | Authentication, a database, access rules | One free Firestore project for all your sites, set up once |
| Who can read the data at rest | The device | You and your providers | Only devices with the token (and, with the offline wrapper, the device's unencrypted copy) |
| Account data you hold | None | Emails, password hashes or OAuth ids | None |
| Works offline | Yes | Depends on the SDK | With the offline wrapper; changes sync when the network returns |
| If the user loses access | The data is gone | Password reset | The data is gone: nobody can reset it |

### What else you get

- **One async interface.** The core and the offline wrapper both implement `BurrowStorage`, with
  the argument shapes of `chrome.storage`'s `StorageArea`, so code written against one works
  with the other.
- **No bill.** On Firebase's free Spark plan the quotas are hard limits, so no amount of traffic
  can run up a charge. What heavy use or abuse can cost you is availability: requests fail until
  the daily reset, and junk that fills the free storage stops writes until you clean it up (see
  [limits](#limits-costs-and-browser-support)).
- **Use renews content.** With the offline wrapper, client use coalesces a full renewal about
  every 30 days. An operator may enable content-only cleanup after 395 days of server write
  inactivity; expiry keeps the local copy and unsynced writes. See
  [retention](docs/retention.md) for the optional cleanup, costs and limits.
- **A swappable store.** Firestore is one adapter behind a small `Backend` interface, and a
  conformance suite tells you when another adapter is right.

**What Burrow is not:** multi-user or shared data, real-time collaboration, a file store, or an
identity system. Two devices that change the same key are not merged: the later write wins.
**Burrow cannot reset a user's data.** If every copy of the token is gone, and no passkey that
gives it is left, the data is unreachable.

## Privacy: who can see what

A user's data is readable only where their storage token is, by the code your site runs there,
and, if you use the offline wrapper, in that device's unencrypted copy. Everyone else in the chain
handles ciphertext.

| Who | Can see | Can do |
| --- | --- | --- |
| The user, on a device that holds the token | Everything | Read and write |
| Scripts running on your page | Everything your page can reach: an open store, the offline copy, the token if your page keeps it | Read and write |
| Anyone who copies the browser profile | With the offline wrapper, the copy's keys and values; the token too if your page keeps it there | With the token: read and write, for good |
| You, as owner of the Firestore project | Opaque ids, ciphertext, sizes and write times; request IP addresses too if you turn on data-access audit logs. No key names, values or user identities | Delete documents from the console, but not read or forge them |
| Google, which hosts Firestore | The same, plus each request's IP address | The same |
| Anyone with a copy of the database | Ciphertext they can neither decrypt nor attribute to a user | Nothing |
| Anyone who learns one document id | That document's ciphertext | Nothing: each write needs a one-time write token derived from the storage token |
| Anyone who reads your page's Firebase config | Nothing more | Create junk documents at unused ids, spending your free quota and storage |

This protects users from the store and whoever runs it. It does not protect them from the site
itself: your page's code handles the token, so users trust the code you serve, as they do with any
web app. For you as a developer, it means there is no account data to secure: no emails, no
passwords, no user table. A breach of the store, or a request to hand its contents over, yields
ciphertext.

### What a stored document looks like

This is the document that `store.set({ theme: "dark" })` produced against the in-memory
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

[SECURITY.md](https://github.com/Froussios/burrow-storage/blob/main/SECURITY.md)
has the full threat model.

## Quick start

### 1. Create the store, once

Create one Firebase project on the free Spark plan and reuse it for every site you build.
[docs/firestore-setup.md](https://github.com/Froussios/burrow-storage/blob/main/docs/firestore-setup.md#create-the-project)
lists the console steps: create the project, create Firestore, deploy the security rules that
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
[docs/firestore-setup.md](https://github.com/Froussios/burrow-storage/blob/main/docs/firestore-setup.md).

### 2a. Script tag, no bundler

```html
<meta name="burrow-firestore" content='{"apiKey":"…","projectId":"…","appId":"…"}'>
<script src="burrow.min.js"></script>
<script>
  // From a click, so the passkey prompt is allowed.
  button.onclick = async () => {
    const token = await Burrow.passkeyToken({ app: "my-prototype" }).get();
    const backend = Burrow.readBackendConfig();
    const store = await Burrow.burrow({ app: "my-prototype", backend, token });
    await store.set({ theme: "dark" });
  };
</script>
```

`burrow.min.js` defines the global `Burrow`, with the core, `offline` and `passkeyToken`. It does
not inline the Firestore SDK: on first use it loads `burrow-firestore.js` from its own directory.
Serve both files from your site and the page contacts no third-party script host and runs under
`script-src 'self'` (move the inline script into a file of its own). If you load `burrow.min.js`
from a CDN instead, the SDK file comes from that CDN too, and that second request carries no SRI
hash. Each release attaches both files with their SRI hashes.

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
  backend: { type: "firestore", apiKey: "…", projectId: "your-project" },
  token,
});
```

Use your own Firebase project; the owner's store is for the hosted demo only. `appId` is optional.
The explicit `backend: new FirestoreBackend(config)` form from `burrow-storage/firestore` also
works. The adapter and the SDK load on demand, so `burrow()` itself makes no network call.

To keep the config in the page instead, use a meta tag and pass `readBackendConfig()`:

```html
<meta name="burrow-backend"
      content='{"type":"firestore","apiKey":"…","projectId":"your-project"}'>
```

`readBackendConfig()` also reads `window.BURROW = { backend: { type: "firestore", … } }`, the
`burrow-firestore` tag and `window.BURROW.firestore`. See
[backend configuration](https://github.com/Froussios/burrow-storage/blob/main/docs/extending.md#page-configuration)
and the
[backend support overview](https://github.com/Froussios/burrow-storage/blob/main/docs/backend-candidates.md#support-status)
for implemented adapters, candidates, rejected variants and their follow-up issues.

### 3. Use it

```js
await store.set({ theme: "dark", draft: "Dear diary" });   // resolves once the store has it
const { theme } = await store.get("theme");                 // reads the store
const all = await store.get();                              // every key
await store.remove("draft");
```

With the core alone, every call goes to the store and **rejects** if it cannot be reached; nothing
is kept on the device. For offline use, wrap it:

```js
import { burrow } from "burrow-storage";
import { offline } from "burrow-storage/offline";

const local = await offline(await burrow({ app: "my-prototype", backend, token }));
await local.set({ draft: "works offline" });                // stored on the device first

local.onChanged.addListener(({ changes, source }) => {
  // "local": written on this device (this tab or another); "remote": from the store
  if (changes.theme) applyTheme(changes.theme.newValue);
});
local.onStatus.addListener(({ status }) => {
  badge.textContent = status;                               // "idle" | "syncing" | "offline" | "error"
});
```

The wrapper tries the store first and answers from its copy when the store is slow or
unreachable. Its writes never fail because the network did: they wait in the copy and sync
when the network returns. **The copy is not encrypted**; it relies on the device for protection,
as `localStorage` does.

### Installing before the first release

Nothing is published to npm yet, so `npm install burrow-storage` and `npx burrow-setup` do not work
today. Build from a clone instead:

```sh
git clone https://github.com/Froussios/burrow-storage.git
cd burrow-storage && npm ci && npm run build
node scripts/burrow-setup.mjs check '<config JSON>'   # in place of npx burrow-setup check
```

Then copy `dist/burrow.min.js` and `dist/burrow-firestore.js` next to your page, or run
`npm install /path/to/burrow-storage firebase` in your project for the ESM build.

## The API in one page

Full reference with every signature and error:
[docs/api.md](https://github.com/Froussios/burrow-storage/blob/main/docs/api.md).

| Member | What it does |
| --- | --- |
| `burrow({ app, backend, token })` | Opens the store for one `app`. All three are required. Resolves with no network call and no user interaction. |
| `generateToken()` | A fresh random storage token: 56 characters in groups of four. |
| `get(keys?)` | `chrome.storage` shapes: nothing (all keys), `"key"`, `["a","b"]`, or `{ key: default }`. |
| `set(items)` | Any JSON values. Non-JSON values (`Date`, `Map`, functions, `undefined`, `NaN`) reject with a `TypeError`. |
| `remove(keys)`, `clear()` | Delete keys everywhere; a tombstone carries the delete to other devices. |
| `close()` | Drop the keys held in memory; later calls reject `closed`. |
| `offline(store)` | From `burrow-storage/offline`: the same interface over an unencrypted local copy, plus the members below. |
| `onChanged` | Offline wrapper: `{ changes: { key: { oldValue?, newValue? } }, source }`. Use `addListener(fn)`, or `addEventListener("changed", e => e.detail)`. |
| `status`, `onStatus` | Offline wrapper: `"idle"`, `"syncing"`, `"offline"` or `"error"`; the event carries the last `BurrowError`. |
| `syncNow()` | Offline wrapper: push unsynced writes and refresh the copy now; rejects if the store cannot be reached. |
| `forget({ discardLocal? })` | Offline wrapper: delete this token's copy from the device and close. |
| `passkeyToken({ app })` | From `burrow-storage/passkey`: `create()` a passkey and its token, or `get()` the token of an existing one. `available()` checks support without prompting. |

The core's calls reject when the store cannot be reached; the offline wrapper's data calls never
do. Failures that Burrow detects reject with a `BurrowError` that carries a stable `code`:
`bad-token`, `item-too-large`, `backend`, `quota`, `conflict`, `decrypt-failed`, `expired`,
`would-orphan`, `closed`, `cancelled` or `prf-unsupported`. Invalid arguments reject with a
`TypeError`. The offline wrapper's writes can also pass on the browser's own error when it refuses
the local write (for example, its storage is full).

## Signing in: where the token lives

Burrow never generates, recovers or remembers a token on its own. Your page gets one and passes
it to `burrow()`; the two ways can be combined:

| Way | First time | Next time, or on another device |
| --- | --- | --- |
| Passkey | `passkeyToken({ app }).create()` makes a passkey and returns its token | `passkeyToken({ app }).get()`: one prompt, the same token, nothing stored |
| Storage token | `generateToken()`, shown to the user to keep | The user pastes it |

- **Storage token.** 56 characters, such as
  `07DV-1XKY-2X98-DRCP-DJV6-FC2E-459V-AJTY-26K2-XJFQ-9BXZ-QRNF-X0F5-Z1XS` (made up; it fails its
  checksum). Case, spaces and hyphens are ignored, and `O`/`0` and `I`/`L`/`1` read the same. A
  bad checksum rejects with `bad-token` before any network call. The natural place to keep it is
  a password manager.
- **Passkey.** The passkey's PRF output, run through HKDF with the app id, is the token: the same
  passkey gives the same token on every device where it is available, and each app its own token.
  Nothing is stored, on the device or online. Needs HTTPS or `localhost` and PRF support, which
  still varies by browser, authenticator and passkey provider: `available()` says whether it can
  work, without prompting. Each `create()` is a new passkey and a new token. Losing the passkey
  loses that way back to the data, so offer the token string too.
  [Limits](https://github.com/Froussios/burrow-storage/blob/main/docs/sync-and-tokens.md#passkeys).

How long the page keeps the token is your choice, and your responsibility:

- **Sign in every visit.** Keep the token in memory only and use the core. A reload asks again.
  Nothing about the user is on the device.
- **Stay signed in.** Store the token yourself (the demo uses `localStorage`) and use the offline
  wrapper. The page opens at once and works offline, but anyone who can read the browser profile
  can read the copy and use the token, for good: tokens cannot be revoked. Say so to your users.

Each `app` derives its own keys from a token, so apps never see each other's data. The offline
wrapper keeps one copy per app and token on the device; switching tokens never shows or drops
another token's data.

## Coming from localStorage

Burrow's interface is asynchronous, shaped like `chrome.storage` rather than Web Storage, because
the core reads and writes over the network. The main differences from `localStorage`:

- Every call returns a promise; values are any JSON, not only strings.
- No window `storage` event; the offline wrapper's `onChanged` reports changes from this device
  and from the store.
- Keys are per `app` and token, where `localStorage` is shared by the whole origin.
- The data survives the device only if the token does; with the offline wrapper it also stays on
  the device, unencrypted, like `localStorage`.

A synchronous Web Storage facade is not part of this release; it could return as an optional
adapter. The full comparison with Web Storage and `chrome.storage`:
[docs/storage-standards.md](https://github.com/Froussios/burrow-storage/blob/main/docs/storage-standards.md).

## Limits, costs and browser support

| | |
| --- | --- |
| Item size | 200 000 bytes of JSON per item |
| Spark quotas | Per day, shared by all your sites: 50 000 reads, 20 000 writes, 20 000 deletes; 1 GiB stored in total |
| Reading one key | 1 read |
| Reading every key | 1 read, plus 1 per item changed since this instance last read it (all of them the first time; the offline wrapper only fetches what its copy lacks) |
| Writing *n* items | *n* + 1 writes and up to *n* + 2 reads, because Firestore writes run in a transaction that reads first |
| Live updates | Offline wrapper only: a Firestore listener on the manifest, plus a refresh when the page becomes visible or the network returns. Nothing polls. |
| Conflicts | Per key, the later write wins. A write made while the store answers counts as the latest; a write made offline competes with the time it was made. Values are never merged. |
| Eviction | Safari deletes a site's IndexedDB, and with it the offline copy, after seven days of Safari use without the user interacting with the site. Other browsers may evict storage when the disk runs low; Burrow does not request persistent storage. The data stays in the store, reachable with the token. |
| Browsers | Tested on Chromium, Firefox and WebKit; aimed at the last two versions of Chrome, Edge, Firefox and Safari, iOS Safari and Android Chrome. Needs a secure context (HTTPS or `localhost`), because WebCrypto does. Without IndexedDB the offline copy is in memory only. |
| Bundle | Core about 6 KB min+gzip, core with the offline wrapper about 9.5 KB (12 KB budget in CI), passkey token under 1 KB more; `burrow.min.js` about 12 KB; `burrow-firestore.js` about 135 KB, loaded only when Firestore is used |

Every read through the core, and every read through the offline wrapper while the store answers,
costs at least one request: read once and keep the result, or use the wrapper's `onChanged`.
When a daily quota runs out, requests fail until it resets. Stored bytes do not reset: anyone who
reads your page's config can fill the 1 GiB with junk documents, which look like users'
documents. Writes for every site on the project then fail until you clean up by hand.
[docs/firestore-setup.md](https://github.com/Froussios/burrow-storage/blob/main/docs/firestore-setup.md)
has the full cost table and the abuse story.

## Security in brief

Everything the store holds is derived from the user's storage token through one-way functions, or
is ciphertext under a key derived from it:

- **Ids:** `base64url(HMAC-SHA-256(pathKey, "item" ‖ key))`, with one key set per user and app,
  derived with HKDF.
- **Content:** AES-256-GCM with a fresh IV per write; the id, the app and the revision are bound
  as additional authenticated data.
- **Writes:** a per-document hash chain of one-time HMAC write tokens, checked by the store's rules
  with SHA-256.
- **On the device:** Burrow writes neither the token nor a key anywhere. The core keeps nothing
  on disk; the offline wrapper keeps the data unencrypted, as `localStorage` does. A page that
  keeps the token across visits keeps it however it chooses.
- **Leaving the device:** Burrow never sends the token. A passkey reproduces it on another device
  without it ever being stored online.

Out of scope, as for `localStorage`: a malicious script on your own origin, and the code your site
serves. Ship a strict CSP and use SRI for the script tag. Burrow needs no `eval`, no inline script
and no third-party host, and the demo runs under `default-src 'none'`.
[SECURITY.md](https://github.com/Froussios/burrow-storage/blob/main/SECURITY.md)
has the derivation, the formats, the threat table, and the plain list of what Burrow does *not*
protect against: the offline copy and any token your page keeps in a copied browser profile, junk
filling the store, and timing metadata.

## Documentation

| | |
| --- | --- |
| [docs/api.md](https://github.com/Froussios/burrow-storage/blob/main/docs/api.md) | Full API reference: the core, the offline wrapper, the passkey token, errors, types |
| [docs/sync-and-tokens.md](https://github.com/Froussios/burrow-storage/blob/main/docs/sync-and-tokens.md) | Storage tokens, passkeys, signing in every visit or staying signed in, offline sync, what to show users |
| [docs/storage-standards.md](https://github.com/Froussios/burrow-storage/blob/main/docs/storage-standards.md) | Setting up, and how Burrow differs from Web Storage and `chrome.storage` |
| [docs/firestore-setup.md](https://github.com/Froussios/burrow-storage/blob/main/docs/firestore-setup.md) | Creating and running the store: rules, costs, quotas, abuse |
| [docs/extending.md](https://github.com/Froussios/burrow-storage/blob/main/docs/extending.md) | Writing a backend for another store, or another way to keep the token |
| [SECURITY.md](https://github.com/Froussios/burrow-storage/blob/main/SECURITY.md) | Cryptographic design and threat model |
| [docs/architecture.md](https://github.com/Froussios/burrow-storage/blob/main/docs/architecture.md) | How the implementation fits together, for contributors |
| [docs/decisions.md](https://github.com/Froussios/burrow-storage/blob/main/docs/decisions.md) | Decision log |
| [CHANGELOG.md](https://github.com/Froussios/burrow-storage/blob/main/CHANGELOG.md) | Changes per release |

## Development

### Backward compatibility

Burrow currently has no clients. Until clients arrive, backward compatibility is not a design
constraint: APIs, storage, tokens, passkeys and cryptographic formats may change without
compatibility shims, migration paths, deprecation periods or major-version bumps solely for
compatibility. The demo, test fixtures and published npm versions do not create such an
obligation. Prefer the simplest correct design for current needs, and update code, tests and
documentation together. When the first clients arrive, document the supported contract and
compatibility and migration expectations before further breaking changes. See
[D-55](docs/decisions.md#d-55-no-backward-compatibility-obligation-until-clients-arrive).

### Commands

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
[Local development](https://github.com/Froussios/burrow-storage/blob/main/docs/firestore-setup.md#local-development)
for commands.
Contributor notes are in
[CLAUDE.md](https://github.com/Froussios/burrow-storage/blob/main/CLAUDE.md).

## License

MIT
