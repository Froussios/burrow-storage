# Decisions

The judgement calls behind the code, in two parts. **Part A** (D-1 … D-43, with a hyphen) is the
log kept while implementing; each entry names the requirement it touches in
[history/requirements.md](history/requirements.md) ("the brief") and the choice made where the
brief was silent or self-contradictory. **Part B** (D1 … D20, no hyphen) is the earlier planning
log, kept so its numbering stays meaningful, with the status of each item against the code.

Where a planning decision and an implementation decision disagree, the implementation decision is
the one in force. Changing anything marked *public contract* (envelope format, derivation salts
and labels, the storage-token encoding) is a major release with a migration.

## Part A: implementation decisions

### D-1 The rules' SHA-256 was verified before the write chain relied on it

The brief left open whether Firestore's `hashing.sha256(string).toHexString()` matches the
SHA-256 hex that Node and WebCrypto compute. It hashes the same UTF-8 bytes, but `toHexString()`
returns uppercase hex, so the rules compare `.lower()` of it with the stored `next`
([history/platform-notes.md](history/platform-notes.md) row 1). The rules tests
(`firebase/tests/rules.test.mjs`) proved the chain in the emulator before the client depended on
it, and a round trip against a live project (`npm run test:live`) confirmed it in production.

### D-2 Emulator port is configurable (FS-13)

`firebase/tests/rules.test.mjs` reads the emulator host from `FIRESTORE_EMULATOR_HOST` (exported
by `firebase emulators:exec`) with `127.0.0.1:8080` as the fallback. `scripts/emulator.mjs` runs
any command under the emulator and honours `BURROW_EMULATOR_PORT`. CI uses the defaults.

### D-3 Storage-token layout (KP-11)

`version (1 byte) || root secret (32) || checksum (2)` = 35 bytes = exactly 56 Crockford base32
characters, shown as 14 groups of 4. The brief's example `L1-2K9F-…` had a 2-character first group,
which cannot be both "56 characters" and "blocks of 4"; groups of 4 were kept. The checksum is the
first 2 bytes of SHA-256 over `version || secret`. Version `0x01` marks a random secret, `0x02` a
passphrase-derived one (ENC-3). Decoding maps `O→0`, `I→1`, `L→1`. *Public contract.*

### D-4 Item size ceiling is 749 000 bytes, not 900 KB (ENC-4)

The rules cap `ct` at 1 000 000 base64url characters, which is 750 000 ciphertext bytes including
the 16-byte GCM tag. An incompressible 900 KB plaintext could never be stored. The hard ceiling for
`maxItemBytes` (and for the manifest) is therefore 749 000 bytes. Compression is applied only when
it shrinks the plaintext, so the ceiling always fits. `seal()` also refuses any envelope whose `ct`
would exceed the cap. A larger configured value is clamped silently.

### D-5 Tie-break by a hash of the serialised value; manifest entries carry it (SYNC-10)

SYNC-10 breaks equal-`ts` ties by comparing the serialised value bytewise. The manifest holds no
values, so it could not apply that order, and devices whose cached entry matched the manifest's
`ts` would never refetch the winner. The order is `(ts, h)` instead, where `h` is the first 16 hex
characters of SHA-256 of the value's JSON serialisation, stored in the manifest entry. A tombstone
sorts above any hash, so a delete wins an exact tie. Property tests cover ties.

### D-6 Item plaintext carries `deleted` (SYNC-12)

`Item.value` is `null` after deletion, but `null` is also a legal stored value. Item documents
carry `deleted: true` when they are tombstones, so a direct item read (SYNC-7) can tell "deleted"
from "set to null" without the manifest.

### D-7 Provider context includes the backend and a small device store (KP-5, KP-9, KP-15)

*Superseded by D-42: there are no providers.*

The passkey provider writes and reads a keyslot through the backend and caches the credential id
locally, so `enrol`/`recover` receive `backend` and `store` (a per-device string store). Custom
providers may ignore both; the built-ins get no special treatment.

### D-8 The cache belongs to one token; `unlink()` guards against orphaning (API-8, API-7)

The local cache is stamped with a fingerprint of the token that owns it (a hash of the manifest
id, never the id itself). `unlink()` leaves the cache and the remote documents intact. The next
`burrow()` generates a fresh token, sees the cache belongs to another, and clears that app's cache
before use, so a logged-out user's data does not appear under the new identity. `unlink()` first
tries to push unsynced writes and rejects with `would-orphan` if any remain, unless
`{ discardLocal: true }` is passed; `link()` behaves the same way. After `unlink()` the instance is
closed and its methods reject. The guard looks at the calling app's unsynced data only.

### D-9 The token is per origin; per-app state is per app (KP-4, SYNC-1, SYNC-3)

The wrapped token, the protection state and provider data live in an origin-wide `_device` object
store. Per-app sync state (`manifestRev`, max remote `ts`, last sync, the `onUnprotected` flag)
lives in `_meta`, keyed by app. Items live in one object store per app (`app:<id>`), created by a
version upgrade the first time an app is used. A keyslot is per origin, not per app: the PRF salt
is a fixed library constant and the keyslot AAD prefix is `slotId || "slot"`.

### D-10 Cached item revision used optimistically (SYNC-8, SYNC-2)

The cache stores each item's last known `rev`; `next` is not stored because it is recomputed from
the token. An item push writes at `rev + 1` directly and re-reads the document only on `conflict`
(or when no revision is known): a successful put proves nobody wrote since. The manifest is always
read first because the pass needs it for the pull anyway. Note that Firestore writes run inside a
transaction that reads the document, so on that backend every put also costs a read; see
[firestore-setup.md](firestore-setup.md) for the full cost table.

### D-11 Storage facade details (API-9..12)

`getItem` of a value written through the async API returns its JSON text (Storage holds strings);
facade writes store strings, as `localStorage` does. The facade is a `Proxy`, so `s.theme`,
`s["theme"] = …`, `"theme" in s`, `delete s.theme` and `Object.keys(s)` behave as on
`localStorage`; the six method names cannot be shadowed. `onChanged` events from facade writes are
batched per microtask, and net-zero changes are dropped.

### D-12 Passphrase provider not shipped in v1 (ENC-3)

*Amended by D-42: the unexported PBKDF2 helper is removed, and v1 rejects version `0x02`.*

v1 ships random tokens only. The PBKDF2 path (`passphraseSecret`, ≥ 600 000 iterations) is
implemented and tested but not exported; version byte `0x02` is reserved for it.

### D-13 Events are `EventTarget`s with chrome-style helpers (API-5)

`EventTarget<…>` is not a real TypeScript type. `onChanged`, `onStatus`, `onUnprotected` and
`onToken` are `BurrowEvent` objects: real `EventTarget`s (events named `changed`, `status`,
`unprotected`, `token`, payload in `event.detail`) that also offer `addListener`, `removeListener`
and `hasListener` like `chrome.storage.onChanged`.

### D-14 Withdrawn (see D-27)

Originally: calling `exportCode()` counted as enrolling the sync-code method and set
`protection: "code"`. Withdrawn because the demo shows the token on every load.

### D-15 `rememberDevice: false` also defaults the cache to memory (KP-8, ENC-10)

Keeping the token out of storage while leaving the items in IndexedDB in plaintext would defeat the
purpose. With `rememberDevice: false` the cache defaults to `memory`; an explicit
`cache: "indexeddb"` still wins.

### D-16 No backend configured means local-only, not an error

If no `backend` is passed and no `<meta name="burrow-firestore">` or `window.BURROW.firestore`
exists, `burrow()` still resolves and works locally, warns once in the console, and
`inspect().backend` is `"none"`. A config that is present but incomplete (missing `apiKey`,
`projectId` or `appId`) originally rejected with `TypeError`.

**Partly superseded by D-45:** a configured backend that cannot be resolved now returns a
usable local store with `status: "error"`; it never silently selects another project.
Firestore `appId` is optional. Missing configuration remains the local-only `idle` case.

### D-17 Script-tag build loads the Firestore SDK from a same-directory file (BE-3, SEC-4, SEC-5)

`burrow.min.js` does not inline Firebase. On first use the adapter loads `burrow-firestore.js`
from the directory `burrow.min.js` came from. That file is a self-contained minified build of
`firebase/app` + `firebase/firestore`. Self-hosted, no third-party script host is contacted and
`script-src 'self'` suffices; loaded from a CDN, the SDK comes from the same CDN (without an SRI
attribute on that second request). ESM users import the SDK through their bundler as usual.

### D-18 TypeScript 5.9 for builds

TypeScript 7 (the native port) has no JS API, which tsup's declaration bundler needs. The project
pins TypeScript 5.9.

### D-19 IndexedDB unavailable → memory cache with status `"offline"` (SYNC-4)

`status` returns to `"idle"` after a successful sync pass, because "offline" otherwise means "the
remote is unreachable". The token cannot be remembered in that mode.

### D-20 Clearing `dirty` after a push is conditional on nothing newer (SYNC-5, SYNC-14)

A pass clears `dirty` only for cache entries whose `ts` still equals what it pushed, in one
IndexedDB transaction, so a write from another tab during the pass is never lost. Reads of the
cache that began before a key's latest local write never overwrite that key in memory. A stress
test found a race here, now fixed.

### D-21 Firestore reads go through a transaction (BE-1, FS-8, FS-9)

`getDocFromServer` can be answered from the watch stream of the page's own `onSnapshot` listener
on the same document, which may not yet reflect a transaction that just committed. Live, this made
the manifest look missing right after it was written about 40 % of the time.
`FirestoreBackend.get` therefore reads with `runTransaction(tx => tx.get(ref))`, which goes
straight to the backend at the same cost of one read. The conformance suite checks that a `get`
sees a committed `put` at once while subscribed.

### D-22 `link()` waits for any running sync pass (API-7)

A pass started under the old token must not finish after the identity changes. `link()` drains the
running pass and swaps the token inside the sync lock; passes read their keys once, inside that
lock.

### D-23 Live project configuration (FS-10, FS-12)

The demo's shared project was created with Firestore's default deny-all rules, so the first live
check failed; `firebase/firestore.rules` was then deployed and the browser API key restricted to
the Cloud Firestore API. Setup (`scripts/setup.sh`) requires `PROJECT` and `LOCATION`, applies the
API restriction, and restricts referrers to `REFERRERS` (default: localhost only). A referrer
restriction also blocks the Node-based live checks (`npm run test:live`), which send no `Referer`.

### D-24 Script-tag SDK is a classic script (NF-1, SEC-5)

`burrow-firestore.js` is an IIFE that sets `BurrowFirestoreSdk`, loaded with a `<script>` element.
Module `import()` of a `file://` URL is blocked in Chromium, so an ES module chunk would have
broken sync from `file://`. A classic same-directory script works there and under
`script-src 'self'`.

### D-25 Browser runs

CI installs system dependencies (`playwright install --with-deps`) and runs Chromium, Firefox and
WebKit. Locally, run whichever engines your machine supports.

### D-26 Setting an unchanged value is still a write (SYNC-10, API-5)

A property test found that `set({ k: 67 })` on device A, `set({ k: 0 })` on device B, then
`set({ k: 67 })` again on A converged on `0`: A still showed 67, so the third write was dropped as
a no-op and B's earlier write won. An unchanged `set()` now takes a new timestamp and syncs, so the
last write wins. Only the `onChanged` event is skipped, as in `chrome.storage`. The cost: an app
that re-sets unchanged values causes one write per debounce window.

### D-27 `store.token` reports where the token came from; `exportCode()` does not protect (supersedes D-14)

*Amended by D-42: `source` is now the label passed to `link()`, and `protection` is gone.*

The demo always shows the storage token in use and where it came from
([user-journeys.md](user-journeys.md)). `store.token` is `{ source, remembered, since }`: `source`
is `generated`, `code` (`link({ code })`), `passkey`, or a custom provider's id; `remembered` is
true when the token was loaded from this browser's storage on page load; `since` is when this device
obtained it. The source is persisted next to the wrapped token, so it survives reloads, and
`onToken` fires when it changes. Because the demo calls `exportCode()` on every load, `exportCode()`
no longer sets `protection: "code"`; otherwise `onUnprotected` could never fire.
`protect("sync-code")` still records that the user kept the token.

### D-28 The sync code is presented to people as the "storage token"

*Superseded by D-42: the API now uses the same name.*

User-facing text (demo, README, guides) says *storage token*; the API keeps its names
(`exportCode()`, `link({ code })`, `bad-code`, provider id `sync-code`, protection `"code"`),
and the docs say once that `code` in the API means the token. Chosen by the owner before the
repository went public; a rename of the API would be a breaking change for no functional gain.

### D-29 Polling is a fixed interval (SYNC-6)

SYNC-6 asks for a pull every `syncIntervalMs` while the page is visible, and on focus, visibility
and `syncNow()`. The plan (WP-07) added adaptive polling, doubling the interval up to 300 s while
nothing changes. It was not built: a fixed interval keeps the cost predictable (one read per
interval per visible tab, docs/firestore-setup.md), the manifest listener already delivers live
changes, and hidden tabs do not poll. A site that wants fewer reads raises the interval or sets it
to 0 and relies on the listener and the triggers.

### D-30 No `storage`-event fallback for tab messages (SYNC-14)

SYNC-14 names a fallback to `storage` events on a sentinel `localStorage` key when
`BroadcastChannel` is missing. It is not implemented: every current browser has `BroadcastChannel`
(Safari since 15.4, in 2022). Where it is missing, the channel is `null` (`src/index.ts`): tabs do
not update each other's mirror until they reload or pull, and sync passes are still serialised by
`navigator.locks`.

### D-31 The unload push is best-effort; no keepalive flush (D16)

The plan's keepalive flush (D16: on `pagehide`, write envelopes up to 32 KB with
`fetch(..., { keepalive: true })`) is dropped, not deferred. The Firestore adapter writes through
SDK transactions, which cannot be sent as keepalive requests. On `pagehide` and when hidden, Burrow
flushes the facade to IndexedDB and starts a normal push; if the page closes first, the items stay
dirty in the cache and go out on the next visit (SYNC-9). `capabilities.keepalive` and
`put(..., { keepalive })` stay in the `Backend` interface for adapters that can honour them.
(D-42 removed them: nothing used them.)

### D-32 `link({ code })` does not require existing data (design review T4)

The design review proposed rejecting a well-formed token that has no manifest with `bad-code`, to
catch a valid but wrong token. It is not adopted. A token whose first device has not synced yet
(offline, or within the debounce) would be refused, and the 16-bit checksum already rejects typos
before any network call (KP-12). A token with no data is adopted as a new, empty identity; the
demo shows the token in use, so a wrong one is visible (architecture §13, sync-and-tokens.md).

### D-33 No reaper script (design review Q4, FS-6)

Clients cannot delete documents (FS-6), and the planned owner-run reaper (`firestore/reaper.mjs`,
admin SDK, deleting documents older than 12 months) was not shipped. Removal is manual, with admin
credentials, as docs/firestore-setup.md describes. Expiring unused documents is an open design
question tracked in issue #22, which would replace a reaper with Firestore TTL or a similar
mechanism.

### D-34 Browser tests run against the Firestore emulator, not a mock (WP-14)

The plan called for an in-process mock of the Firestore REST endpoints in the browser tests.
With the SDK adapter (D1 superseded), the Playwright tests run the real SDK against the Firestore
emulator (`npm run test:e2e`), which also enforces the real rules. Failure injection (network,
quota, conflicts) is covered by unit tests against `MemoryBackend.failWith` instead of injected
HTTP statuses. Acceptance criterion 8 (the conformance suite passes unchanged for Firestore,
Memory and a Worker-style backend) runs as `test/conformance/{firestore,memory,worker}.test.ts`.

### D-35 A second `burrow()` for the same app ignores its config silently (API-2)

API-2 requires the same instance for the same `app` on one page. The plan added a warning when the
second call's config differs; it is not implemented, because configs carry objects (a backend,
providers) that cannot be compared meaningfully. docs/api.md states that the second config is
ignored.

### D-36 `FirestoreBackend` uses the default database only (FS-1)

`FirestoreBackend` has no `databaseId` option; it reads and writes the project's `(default)`
database. A named database would also need its own rules deployment, which `burrow-setup` does
not do. Adding the option is a small change if a site needs it.

### D-37 The AAD and write-token formats keep the brief's plain concatenation (ENC-5, ENC-7)

The design review proposed separators (`id|app|rev` for the AAD, `id:n` for the write token).
They were not adopted: the formats follow the brief (`id || app || String(rev)` and
`id || String(n)`), which is public contract. Both are unambiguous in use: `id` is a fixed 43
characters, and each app's ids and keys are derived for that app alone, so a document copied to
another id, app or revision fails to decrypt or verify (SECURITY.md, "Formats").

### D-38 The demo page loads its bundles without SRI (SEC-6)

WP-15 planned an SRI script tag on the demo. The demo is deployed with the bundles it was built
with, from its own origin, under `script-src 'self'`; an `integrity` attribute would have to be
regenerated on every build and protects against nothing the CSP does not already exclude. SRI
matters when a page loads Burrow from a CDN, and the README shows that form (SEC-6).

### D-39 The demo is hosted on GitHub Pages (#24)

The demo is always available at <https://froussios.github.io/burrow-storage/>, redeployed from
every push to `main`. The owner chose GitHub Pages over Firebase Hosting on the store's project
(`burrow-storage-shared.web.app`) and over Cloudflare Pages or Netlify, once the repository was
public. The origin is effectively permanent: passkeys created on the demo are bound to the rp ID
`froussios.github.io`, and the token is remembered per origin (D-9), so a move orphans both.

What the choice costs:

- The origin is shared with every other GitHub Pages site of the account. They can read the
  demo's IndexedDB and use its token, and they share its passkey rp ID. SECURITY.md already
  excludes code running on the same origin.
- Pages cannot set response headers, so the CSP stays a `<meta>` tag. A meta CSP ignores
  `frame-ancestors`, so other sites can frame the demo.

The bundles are deployed beside the page, so the CSP is unchanged: `script-src 'self'` and
`connect-src 'self' https://firestore.googleapis.com`. The browser key is restricted to the Cloud
Firestore API only; if referrer restrictions are added (D-23), they must include
`https://froussios.github.io/*`.

The repository's Pages source must be **GitHub Actions** (Settings → Pages → Build and deployment).
With "Deploy from a branch", GitHub renders the README at the same URL instead of the demo, and
`pages.yml` fails at `configure-pages`.

### D-40 Each demo deploy is smoke-tested against the live store (#24)

After the deploy job, `pages.yml` runs `test/smoke/demo.spec.ts` on Chromium against the deployed
URL. The page must show the commit being deployed: the test reloads with a fresh query until it
does, for up to three minutes, so a cached copy of the previous deploy cannot pass. The page must
also keep its strict CSP, log no console errors, request nothing outside its own origin and the
store, and show a token. Two fresh browser contexts must then sync both ways: one writes, the other
links with its token and reads the write, then changes the theme, and the first sees the change.

A failure fails the workflow run, but the deployment stays live; there is no automatic rollback. The
deploy is not gated on `ci.yml`: the head is deployed as it is, and the smoke test is the check.
Runs are serialised (`cancel-in-progress: false`), so each smoke test sees its own deploy. Each run
writes a few KB (one token's manifest and two items) to `burrow-storage-shared`, and a failed test
that Playwright retries writes another set. These documents are never deleted (D-33, #22), and the
runs share Spark's daily quotas with every other use of the project. CI runs the same spec against
the assembled `site/` under the emulator, so the test itself is checked before a merge.

### D-41 No `#burrow=` links: the token is never read from the URL (KP-13, D7; #35)

KP-13 allowed (MAY) carrying the token in a URL fragment. An earlier build adopted a
`#burrow=<token>` fragment on every `burrow()`, without asking, and removed it with
`history.replaceState`; that superseded D7. It is removed, and D7 is in force again: KP-13 is not
implemented.

- **Token fixation.** Anyone who got a user to open a link they made switched that device, and
  every Burrow app on the origin, to their token, then read what the user wrote. The library had
  no mitigation, and a site that never offered links still had to strip the fragment before
  calling `burrow()`, so the default was unsafe.
- **The link is the token.** It ends up in history, synced history, autocomplete, chat logs and
  screenshots; removing it from the address bar after reading undoes none of that. The token
  should leave the device only when the user deliberately carries it.
- **Better paths exist.** A password manager, through `exportCode()` and `link({ code })`, or a
  passkey backup, which moves the token without showing it.

`burrow()` no longer reads `location`, `Env` lost its `location` and `history` members, and
`TokenSource` no longer has `"link"`. The docs do not describe links at all, not even as a recipe
on top of `link({ code })`.

### D-42 Only the token crosses the API; the passkey backup is a separate utility (#28)

The `KeyProvider` interface let the store call unlock methods: `protect()` enrolled one,
`link({ provider })` recovered the token through one, and the store recorded which in
`protection`. #28 asked for something simpler. The store now deals only in the storage token, as
the 56-character string the user also sees: `exportToken()` hands it out, and
`link({ token, source? })` adopts it. Getting it from one device to another is the site's choice.

- **Removed:** `KeyProvider`, `EnrolContext`, `RecoverContext`, `ProviderStore`,
  `BurrowConfig.keyProvider`, `protect()`, `link({ provider })` and `link()` with no arguments,
  `protection`, `onUnprotected`, `Protection`, the `passkey()` and `syncCode()` providers, and
  `inspect()`'s `protection`, `provider` and `tokenSource` (the last duplicated `store.token`).
  The device store loses `protection` and the `p:<name>` provider values; app meta loses
  `unprotectedFired`.
- **The passkey backup** is `passkeyBackup()` from `burrow-storage/passkey` (also
  `Burrow.passkeyBackup`): `available()`, `save(token)`, `restore()`. It keeps the WebAuthn and
  PRF code and the keyslot format of the old provider unchanged, so existing keyslots still open
  and SECURITY.md's derivation is untouched. It defaults its backend from the page like
  `burrow()` does (shared in `src/config.ts`), and its `userName` defaults to the page's host
  instead of the app id, since it has no app.
- **`source` instead of provider ids.** `link()` takes an optional label, persisted with the token
  and reported in `token.source` (default `"token"`). The demo's "Restored from your passkey"
  needs it, and the store is the only place that can keep it next to the token and share it with
  other tabs.
- **No protection bookkeeping.** With the backup outside the store, Burrow cannot know whether a
  token is kept anywhere, so it no longer pretends to. `token.source === "generated"` is the
  useful half of KP-14: this token was made here. A site that wants to say "backed up" keeps its
  own record; the demo keeps it in the store under `backup`, so it syncs with the data. This
  supersedes KP-14, KP-15 and the `protect()` clause of KP-3.
- **The name.** `exportCode()`, `link({ code })`, `bad-code` and the source `"code"` become
  `exportToken()`, `link({ token })`, `bad-token` and `"token"`. D-28 kept the old names because a
  rename was a breaking change for no gain; this change breaks the API anyway, and the docs no
  longer have to explain that `code` means the token. The internal codec is `codec/token.ts`;
  the format and `test/vectors.json` are unchanged.
- **Errors.** `no-provider` meant three things. It becomes `unlinked` (a call after `unlink()`)
  and `cancelled` (a dismissed passkey prompt in `save()`); "no provider could recover" no longer
  exists, and `restore()` resolves `null` instead.
- **The token as a string in the site's hands.** SECURITY.md already listed typing, pasting and
  carrying it as the ways the token leaves the device. Raw bytes would add a second format and a
  zeroise duty that a site cannot honour for a JavaScript string anyway. The store's own copy
  stays wrapped (`SecretHolder`), and the passkey backup zeroises the bytes it decodes.
- **KP-9 dropped.** The old provider cached the passkey's credential id on the device so recovery
  could skip the account picker. It only helped on a device that still had site data (backup,
  unlink, restore), the case that needs it least; a wiped device has no hint anyway. `restore()`
  always makes a discoverable request, and the utility stores nothing on the device.
- **`available()` checks `isSecureContext`.** This closes the architecture gap where, from
  `file://`, the passkey looked available and then failed with `prf-unsupported`.
- **Also removed, unused:** `Backend.put()`'s `{ keepalive }` and `capabilities.keepalive`
  (honoured by no backend, and the unload flush was dropped in D-31), `capabilities.maxEnvelopeBytes`
  (never read), and the unexported `passphraseSecret` with acceptance of version byte `0x02`
  (D-12). `0x02` stays reserved in the format and is rejected as `bad-token`.
- **Not added: `BurrowConfig.token`.** Opening the store with a given token was considered and
  rejected. It conflicts with API-2 (a second config for the same app is ignored), and a passkey
  restore needs a user gesture after the page has loaded anyway, so `link()` is the one way in.

Also: API-7's `link()` takes a token, not a provider. The passkey restore with unsynced local
data used to prompt twice (`link({ provider })`, `would-orphan`, then `link()` again); now the
retry reuses the token `restore()` returned, with one prompt.

### D-43 Only the demo uses the owner's Firebase project (#40, #43)

The owner's project is the demo's store, not a default for tests or setup scripts. Only
`demo/index.html` and the deployed demo may be coupled to it. CI reaches it only through the
post-deploy page smoke test in `pages.yml` (D-40), exercising the page as a user would; direct
checks of the project's rules, quotas or key restrictions do not belong there. Other tests and
scripts use the emulator or a project the caller explicitly names.

`npm run test:live` is a one-off check of the caller's own setup. It requires the
`BURROW_FIRESTORE` environment variable, exits non-zero with setup guidance before contacting
Firebase when the variable is missing, empty or not valid JSON, and never runs in CI.
It checks unauthenticated create/read by id, refusal of a forged write token and of listing,
backend conformance and two-device sync. It leaves undeletable throwaway documents and does not
check Spark vs Blaze or that Auth, Storage and Functions are off. The setup guide and printed
steps describe these limits. The earlier live runs in D-1 and D-23 remain historical records.

### D-44 Local serving defaults to the emulator; real projects are explicit (#40)

D-43 isolates CI and the live setup check, but bare `npm run serve` still served the demo's
live config whenever `FIRESTORE_EMULATOR_HOST` was absent or empty. Local development could
therefore write undeletable documents to the owner's project.

`scripts/serve.mjs` rewrites pages in `demo/` and the assembled `site/` to use
`FIRESTORE_EMULATOR_HOST` or `127.0.0.1:8080` by default. For local development against a real
project, including pre-production, the caller explicitly supplies `BURROW_FIRESTORE` config
JSON with non-empty `apiKey` and `projectId` strings and optional `appId` and `collection`.
`appId` became optional in D-45, including for the local server and live setup check.
It reuses the live setup check's config format. Unknown SDK fields are ignored and an
`emulator` field is rejected. Empty, malformed or incomplete explicit config and simultaneous
live and emulator settings stop the server before it listens. This validates the config's
shape, not the project's existence or setup.

The server adjusts the page's CSP for the chosen backend and refuses a page whose config
cannot be rewritten. The source page's project is never a default or fallback. An unavailable
emulator means sync is offline. `node scripts/emulator.mjs "npm run serve"` starts both for
emulator development; `BURROW_FIRESTORE='<config JSON>' npm run serve` uses the caller's project.
Config values are escaped for the HTML attribute, and inserted through a replacement callback
so quotes, markup characters and dollar signs remain data. HTTP regression tests cover both
targets and failures without contacting a cloud project; CI browser tests use the emulator.

This affects local HTTP responses only. The source demo config and assembled deployment files
still use the demo project, as does the post-deploy page smoke test in `pages.yml` (D-40).

### D-45 Public backend configuration and lazy adapter factories (#23)

`backend` accepts an instance or `{ type, …options }`; `firestore` is shorthand. Explicit
`backend` wins over shorthand. Page discovery prefers `burrow-backend` meta, then
`window.BURROW.backend`, then legacy Firestore meta/global config. Registered factories
load adapters on demand; the Firestore factory is built in. Registration cannot replace an
existing type. Page data selects a registered type, never a script URL or executable code.
The script-tag Firestore SDK still comes from its same-origin chunk (D-17, D-24).

Firestore needs `apiKey` and `projectId`, not a Firebase web-app `appId`; the latter is optional.
Invalid remote config or failed adapter loading must not reject local initialization (API-1,
API-3). A usable local store resolves with `status: "error"` and a fixed `backend` error,
without retaining config/parser/factory exception values. Dirty writes stay cached. Missing
config remains the `idle` local-only case (D-16). The first opened instance keeps its backend;
correct config and reload to enable sync. Passkey backup operations still reject if their
backend cannot be resolved, since a keyslot needs remote storage. They discard configuration
exception values in the same way and retry page discovery on the next call. Their explicit
`backend` option accepts an instance checked against the same structural contract as the
core; declarative config comes from the page.

The Firestore subpath has a 2 KiB min+gzip adapter budget excluding the lazy SDK; the SDK
has a separate 150 KiB budget. Both are enforced by `npm run size`. This leaves headroom
above the measured 1.55/135.80 KiB baselines without hiding SDK growth in the core budget.
No other hosted adapter is certified. The [candidate assessment](backend-candidates.md)
records feasibility, costs, setup and missing conformance evidence; #23 stays open pending
backend choice/privacy approval and deployment tests. Setup work is tracked separately in #36.
D-52 amends this remaining #23 scope at the owner's direction.

### D-46 Revalidate unlisted item results on manifest retries (SYNC-10, #55)

A successful item write is not proof that the item is still current when a manifest conflict
forces a retry. Another device can overwrite it with a newer deletion, then prune that
tombstone from the manifest because its logical timestamp is already more than 30 days old.
Reusing the first writer's saved result would re-list the deleted value, and its own cache
would not fetch the newer item because the manifest version equals its cached version.

When a result from an earlier attempt is absent from the newly read directory, the engine
reads the item again before publishing it. A newer remote version is adopted; a newer local
offline write still wins the same `(ts, h)` comparison. Tombstone timestamps, the 30-day
manifest lifetime, and the envelope format stay the same. Results still listed in the
directory can be reused without an extra read.
This applies to every saved result, including one whose local entry became clean after
adopting a published deletion on an earlier retry; that result must still be revalidated if a
later manifest conflict exposes the deletion's expiry.
A live result being published remains in the cache even while absent from the old directory,
so adopting a newer unlisted value cannot briefly remove it locally during the same pass.
The pass publishes unlisted live results even when revalidation cleared the last dirty key,
so the next pass sees their manifest entries and keeps them without depending on the other
writer finishing its manifest upload.
Forced publication lists the observed winning `(ts, h)` from the other device; it creates no
new local write or timestamp.

### D-49 Replace one-shot Firestore provisioning with resumable agent instructions (#36)

The Bash setup script had no end-to-end evidence, guessed CLI output shapes and API key display
names, swallowed errors as already-existing resources and silently installed a global CLI.
Delete it and its `--run` entry point. Ship `firebase/SETUP-AGENT.md` as an agent-neutral guide
with confirmed inputs, per-step checks and verification, safe local progress, known failures
and stop conditions. A rerun rechecks resources, skips completed mutations and repeats live
verification. CLI sign-in stays with the human; optional gcloud actions have console fallbacks.
No billing, unrelated Firebase products, rule edits or deletion are allowed. FS-10 remains met
by `burrow-setup firestore`, which prints human console steps and the agent-guide path. D-51
amends this: the printer is removed.

The recommended packaged `burrow-setup check '<config JSON>'` reuses the production backend,
HKDF derivation and envelope codec, rather than asking an agent to invent crypto. It creates and
reads one fresh encrypted document, decrypts it, and expects permission denial for a forged
update, listing and an id `in` query. It refuses CI and accepts only caller-supplied public
config. This amends D-43's literal environment-variable requirement: `npm run test:live` uses
`BURROW_FIRESTORE`, while `burrow-setup check` takes the public config argument. Both require
an explicit caller-owned project, never fall back to the owner's store and never run in CI.
Node 20+ provides native WebCrypto; the Firebase SDK remains the optional peer. Only
fixed check names and safe codes are printed, with SDK diagnostics suppressed. Each run leaves
one undeletable throwaway document. The broader `npm run test:live` remains for maintainers.
Neither check verifies billing/products, and browser-referrer restrictions may block Node;
never relax restrictions to make it pass.

The guide's CLI signatures were checked against Firebase CLI 15.32.1 source. Fresh-project
provisioning, a small agent's end-to-end execution and the second run remain blocked on human
sign-in/project inputs and live verification. Keep the end-to-end caveat until evidence exists;
this implementation alone does not close #36 or establish its complete acceptance.

### D-47 Deterministic passkey user handle; replacement is the app's to warn about (#21)

Owner scope: [app/user responsibility and overwrite by default](https://github.com/Froussios/burrow-storage/issues/21#issuecomment-6073994356),
then [label-varying derivation and WebAuthn-style names](https://github.com/Froussios/burrow-storage/issues/21#issuecomment-6074104571).
These decisions accept a scoped behavior rather than a universal manager guarantee.

`save()` derives `user.id` as the first 16 bytes of SHA-256(`"burrow/user/v1"` ‖ `userName`),
where `userName` is the effective label (host by default). The rp ID scopes it to the site;
a different label gives a different handle. CTAP2 authenticators replace a discoverable
credential with the same rp ID and user handle, so a repeat save leaves one entry. Only that
the handle varies with the label was required by the owner when choosing the initial algorithm.
The chosen derivation is now stable v1 public contract: the `burrow/user/v1` prefix, UTF-8 input,
SHA-256 and first-16-byte truncation may not change without a major release and migration path,
since a new handle would stop replacement of earlier credentials and allow duplicate labels.
`displayName` is a separate option (default `userName`) and does not enter the handle, so an
app can change the new credential's presentation without changing its identity. Renaming an
existing passkey remains out of scope. The RP ID scopes credential use but is not hashed into
the handle; matching explicit public labels have matching handles across sites. This adds no
independent user identifier beyond that label. The default host label differs per site, and
apps can choose site-specific, non-sensitive labels. Keyslot format and crypto are unchanged.

Replacement happens inside `credentials.create()`, before the PRF output and the keyslot write.
If the follow-up fails, neither passkey may hold a usable backup, and a different token saved
under the same label loses its passkey route. Responsibility is passed to the app and user:
sites must warn before every `save()` and ask users to keep the current and earlier tokens,
or use a distinct `userName` (device name, date, user-chosen) per token. Not adopted: a random
suffix by default (defeats the goal),
`excludeCredentials` and a `passkey-exists` error (the library has no credential ids to send;
D-42), a name-to-credential registry. Limits: earlier random-handle duplicates remain, since
WebAuthn offers no enumeration or deletion; replacement was exercised only with Chromium's
virtual authenticator, not iCloud Keychain, Google Password Manager, Windows Hello, 1Password
or Bitwarden.

The demo passes `userName: "burrow-demo"` and asks the user to confirm the replacement/loss
warning before calling `save()`. Declining it never prompts the authenticator. A failed save
does not claim that no credential was created or that an earlier credential survived.
The historical backup marker remains, but its badge says "Previously saved with a passkey.
Keep the storage token." It does not promise current recoverability or discard the record
of another backup that might still work.

### D-50 Token recovery and content storage remain independent

Preserve D-42's token-string boundary when extending Burrow. The core and `PasskeyBackup`
reuse the `Backend` interface, but their instances, Firebase projects or database providers
are independently selectable. Shared page config is a convenience; the passkey utility does
not inherit a backend passed only to `burrow()`. Token carriers such as a password manager
need no keyslot backend or provider interface. The site configures the appropriate services
on each device and passes the recovered token to `link()`.

This lets sites choose ownership, availability, cost and retention separately for content
and recovery. New adapters (#23) and setup guidance (#36) must preserve that choice. Retention
work (#22) must keep keyslot maintenance in the passkey utility: core sync has neither its
backend nor its PRF-derived keys, and content operations must work when recovery is unavailable
once the token is available. This decision does not choose an expiry policy or change crypto.
See [independent configuration](extending.md#independent-token-and-content-storage).

### D-51 Drop the console-steps printer; `burrow-setup` keeps only `check` (FS-10)

`burrow-setup firestore` executed nothing: it printed a copy of the console steps in
`docs/firestore-setup.md`, so the two could drift, and no user had run it before the first
release. The owner withdrew FS-10's printed one-command setup. The steps live in
`docs/firestore-setup.md` and the shipped `firebase/SETUP-AGENT.md`, which also covers agents
(D-49). FS-10 still requires the shipped `firestore.rules` and `firebase.json`. The bin keeps
only `burrow-setup check '<config JSON>'`. `firestore` fails with a pointer to both guides.
`engines` rises to Node 20, the minimum for the checker and the agent guide's Firebase CLI. The
requirements snapshot is not edited. This amends D-49's sentence on how FS-10 is met.

### D-52 Narrow #23's scope; additional backend work moves to #64–#68

The [owner's 2026-10-10 scope clarification](https://github.com/Froussios/burrow-storage/issues/23#issuecomment-6093262113)
amends D-45's remaining #23 closure prerequisites. Public configuration/setup, independent
token-access verification, an external support-status overview and backend-scoped follow-ups
complete #23; additional backend implementation/deployment is separate work. The
[overview](backend-candidates.md#support-status) links the unassigned candidate issues #64–#68.
Their backend selection, BE-2 interpretation, concrete design approval and deployed conformance
gates remain in those issues. No candidate is marked "want" or approved for deployment merely
because its issue exists. HTTP is a transport whose protocol belongs to the selected backend.

D-50's independent token/content boundary is unchanged. Core token-string access and the
optional passkey utility's independent backend satisfy that boundary without a new provider
interface. Retrieving a stored token with an available credential is supported token access;
recovery after losing authenticating credentials is outside the project, as the
[owner clarified separately](https://github.com/Froussios/burrow-storage/issues/22#issuecomment-6093406173).
Emulator instance-isolation coverage is local routing evidence, not live two-project validation
or certification of a candidate. Closing the completed #23 scope does not waive those gates.

### D-53 Publish to npm through trusted publishing, not a stored token (SEC-6)

The name `burrow-storage` was claimed on 2026-10-10 with a code-free `0.0.0` placeholder
published by hand. The package is configured on npm to trust `release.yml` in
`Froussios/burrow-storage`, so the workflow publishes with a short-lived GitHub Actions OIDC
credential and the repository holds no `NPM_TOKEN`. npm now restricts long-lived tokens that
bypass two-factor authentication, and a token that is never stored cannot leak from the
repository's secrets. Provenance is unchanged.

The trust relationship allows only `npm stage publish`, not `npm publish`, as npm recommends. A `v*`
tag therefore stages the version, and it becomes public only when the owner approves it with 2FA
(`npm run release:approve`, `npm stage approve <stage-id>` or the package page on npmjs.com). Anyone
who can push a tag can stage a release but cannot publish one. The workflow installs npm 11.21 or
newer for `npm stage`. The GitHub release with the bundles is created as a draft at staging time;
the owner publishes it after approving the npm version (`release:approve` does both), so a rejected
stage leaves no public release. This paragraph replaces D-53's first wording, which had the workflow
run `npm publish`; no version was ever published that way. Before re-running a release, check
`npm stage list`: a version that is already staged cannot be staged again.

## Part B: planning decisions and their status

These were proposed in the pre-implementation design review
([history/design-review.md](history/design-review.md)) and adopted by default pending the owner's
confirmation. The implementation then went its own way on several. Status against the code:

| # | Planned | Status |
| --- | --- | --- |
| D1 | Firestore adapter over the REST API with `fetch`, no SDK | **Superseded.** The adapter uses the modular Firebase SDK (`firebase/app`, `firebase/firestore`), lazy-loaded; script-tag pages get it from `burrow-firestore.js` (D-17, D-24). It provides `subscribe` through `onSnapshot`. |
| D2 | One IndexedDB `items` store with compound key `[app, key]` | **Superseded.** One object store per app, created by a version upgrade (D-9). |
| D3 | Blind writes arbitrated by rules; read only to classify a 403 | **Superseded.** `put` runs a Firestore transaction (read, compare, set); reads also go through a transaction (D-21). |
| D4 | No passphrase provider in v1 | **Adopted** (D-12). The decoder accepts version byte `0x02` for forward compatibility. |
| D5 | Wrap the token with AES-GCM rather than AES-KW | **Superseded.** AES-KW under a non-extractable key, with an extractable HMAC "vehicle" key carrying the raw bytes (`src/secret.ts`). |
| D6 | A chrome-style emitter that is not an `EventTarget` | **Superseded.** `BurrowEvent` extends `EventTarget` and adds the chrome-style methods (D-13). |
| D7 | No URL-fragment transport for the token | **Adopted** (D-41). |
| D8 | `linked`, `not-linked`/`unsupported` error codes, `compress`, `rememberDevice: false` starts unlinked | **Not adopted** except `debug`. `rememberDevice: false` generates an in-memory token per load (D-15). |
| D9 | Single package, two entries, IIFE includes both | **Adopted** for the entries; the IIFE excludes the SDK (D-17). |
| D10 | tsup, vitest, fast-check, Playwright, firebase-tools, size-limit, eslint, prettier | **Partly adopted.** No eslint, prettier or size-limit; a custom `scripts/size.mjs`; rules tests use `node --test`. |
| D11 | Test vectors from an independent Python script | **Adopted in spirit**: `scripts/gen-vectors.mjs` uses `node:crypto`, independent of the WebCrypto code. |
| D12 | Leader tab does all network I/O | **Superseded.** Any tab may sync; passes are serialised by a Web Lock (architecture §8). |
| D13 | Equal-`ts` tie-break: tombstone, then bytewise JSON | **Superseded** by the `(ts, h)` order (D-5). |
| D14 | Clock `max(now, maxRemoteTs + 1, lastLocalTs + 1)` | **Adopted** per key: `nextTs(now, previous ts of the key, maxRemoteTs)`. |
| D15 | Facade `getItem` stringifies non-string values | **Adopted** (D-11). |
| D16 | Keepalive flush for envelopes ≤ 32 KB | **Dropped** (D-31). The option stays in the `Backend` interface; no shipped backend honours it. |
| D17 | One raw copy of the token in a closure | **Superseded.** The token is held wrapped and unwrapped per use (`SecretHolder.use`). |
| D18 | Format, salts and token version are public contract; major version to change | **Adopted.** |
| D19 | Classify REST errors per WP-00's measured shapes (`PATCH` on a missing document is `403`; losers of a race get `403` or `409 ABORTED`) | **Moot.** The SDK adapter maps SDK error codes instead (architecture §10); the measurements are in [history/platform-notes.md](history/platform-notes.md). |
| D20 | `passkey().available()` requires a hostname, because on `file://` Chromium reports PRF support yet `create()` throws | **Not implemented.** Listed in architecture §13; from `file://` `protect()` rejects `prf-unsupported` instead of falling through. |
