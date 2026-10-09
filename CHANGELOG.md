# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). The envelope format, the v1 derivation salts and
labels, the storage-token encoding, and the passkey user-handle derivation with its
`burrow/user/v1` prefix are public contract: changing them is a major release with a migration
path.

## [Unreleased]

### Added

- Passkey backup: optional `displayName` for the new credential's visible name, separate from
  its `userName` identity (#21, D-47).
- Generic backend configuration (`burrow-backend` meta / `window.BURROW.backend`), lazy
  `registerBackend(type, factory)`, caller `{ backend: { type, …options } }` and Firestore
  shorthand. Invalid backend config preserves local reads/writes and reports an error status
  (#23, D-45). Firestore `appId` is optional. Separate adapter and SDK size budgets.
- `burrow()` entry point with a `chrome.storage`-shaped `BurrowArea` and a synchronous `Storage`
  facade (`store.storage`) that supports property-style access like `localStorage`.
- Codec: HKDF id and key derivation, AES-256-GCM envelopes bound to id, app and revision,
  deflate-raw compression, hash-chained write tokens, the storage-token encoding (56 Crockford
  base32 characters, version byte, checksum).
- IndexedDB and memory caches; `MemoryBackend`; a backend conformance suite.
- Sync engine: one document per item plus an encrypted manifest, per-key last-writer-wins with a
  deterministic `(ts, h)` tie-break and 30-day tombstones, clock-skew correction, debounced
  pushes, polling and listener-driven pulls, exponential backoff, multi-tab coordination over
  `BroadcastChannel` with Web Locks.
- The storage token crosses the API as its 56-character string: `exportToken()` hands it out and
  `link({ token, source })` adopts it on another device.
- `burrow-storage/passkey`: `passkeyBackup()` with `available()`, `save(token)` and `restore()`,
  a passkey backup of the token in a PRF-wrapped keyslot, separate from the store
  (`Burrow.passkeyBackup` in the script-tag build).
- `store.token` / `onToken`: where this device's token came from (`generated`, `token`, or the
  site's `source` label such as `passkey`) and whether it was remembered from an earlier visit.
- `unlink({ discardLocal })` with the same `would-orphan` guard as `link()`.
- `syncNow()` rejects with the sync error when a pass fails; `exportJSON()` /
  `importJSON()` with the `{ burrow: 1, app, exportedAt, items }` format; `inspect()`.
- Events are `BurrowEvent`s: real `EventTarget`s with chrome-style `addListener` helpers.
- `FirestoreBackend` (`burrow-storage/firestore`) over the modular Firebase SDK, with transactional
  reads and writes and a manifest listener; `readFirestoreConfig()` for the
  `<meta name="burrow-firestore">` / `window.BURROW.firestore` page config; `passkeyBackup()`
  options (`backend`, `rpId`, `rpName`, `userName`, `timeoutMs`).
- Firestore security rules with the SHA-256 write chain, emulator tests, `npx burrow-setup
  firestore` human guide, shipped agent-neutral `firebase/SETUP-AGENT.md` instructions, and a
  packaged `burrow-setup check` for live Gate 2 rules verification.
- Static demo (theme, draft, storage token panel, passkey backup, export, debug panel) under a
  strict CSP.
- The demo is always available at <https://froussios.github.io/burrow-storage/>, redeployed to
  GitHub Pages from every push to `main`. Its footer shows the commit and build time
  (`npm run demo:build`), and a Playwright smoke test (`npm run test:smoke`) checks each deploy
  against the live store.
- Script-tag build `burrow.min.js` (global `Burrow`) that loads the Firestore SDK as a
  same-directory classic script (`burrow-firestore.js`), so it also loads from `file://`.
- SRI hashes and npm provenance in the release workflow.
- Documentation set for external users: README, API reference, guides for tokens and sync,
  localStorage migration, the shared store, and extending; SECURITY.md; architecture and
  decision log.

### Changed

- Documented independent token recovery and content storage (D-50, #22/#23/#36), with separate
  backend configuration and regression coverage for a recovery-service outage.
- Passkey handles derive from the effective `userName`: repeated saves with the same RP and
  label replace the earlier credential on conforming discoverable authenticators (#21, D-47).
  The first 16 bytes of SHA-256 over UTF-8 `"burrow/user/v1" + userName` are stable v1 public
  contract; changing the derivation would stop replacement of existing credentials.
  Apps choose distinguishing labels for separate backups. The demo uses `burrow-demo` and
  warns before creation: replacement precedes the PRF/keyslot write and can lose the earlier
  recovery route even if saving fails. Existing random-handle duplicates remain; replacement
  is validated only with Chromium's virtual authenticator.
- Replace the unverified one-shot Firestore setup shell script and `--run` flag with checked,
  resumable agent instructions; human console steps still satisfy FS-10 (#36, D-49).
  Fresh-project setup and a second live verification run remain unverified.
- Explicit `backend: null` from untyped callers now counts as invalid configuration
  instead of falling back to page discovery. `burrow()` opens local storage with error
  status; passkey operations reject `backend` before prompting. Omit `backend` to discover
  page config (#23, D-45).
- Malformed legacy `burrow-firestore` JSON now produces a usable local store with
  `status: "error"`; it no longer warns and falls back to `window.BURROW.firestore` or
  another project. Passkey backup operations reject `backend` for that invalid config
  or failed adapter factory without retaining exception values (#23, D-45). Local serving
  and the live setup check also accept omitted Firestore `appId`.
- `npm run test:live` requires the `BURROW_FIRESTORE` environment variable to name the caller's
  own project; it no longer falls back to the demo's store. The setup guide and printed steps
  explain this optional check, its limits and its undeletable throwaway documents (#43, D-43).
- Token-only API (#28, D-42): the `KeyProvider` interface, `BurrowConfig.keyProvider`,
  `protect()`, `link({ provider })`, `protection`, `onUnprotected` and the `passkey()` and
  `syncCode()` providers are gone. `exportCode()`, `link({ code })` and `bad-code` are renamed
  `exportToken()`, `link({ token })` and `bad-token`; `no-provider` is split into `unlinked` and
  `cancelled`; `inspect()` drops `tokenSource`, `protection` and `provider`.
- The passkey backup keeps no credential id on the device; `restore()` lets the user pick the
  passkey. Its `available()` also requires a secure context.
- `Backend.put()` no longer takes `{ keepalive }`, and `BackendCapabilities` keeps only
  `writeAuth` and `subscribe`.
- Version byte `0x02` (passphrase-derived tokens) is reserved but rejected as `bad-token`; the
  unexported PBKDF2 helper is removed.
- Setting a key to the value it already has is still a write (it takes a new timestamp and
  syncs), so the last writer wins across devices; only the `onChanged` event is skipped.

### Fixed (found during development)
- A manifest conflict could re-list an item overwritten by a newer deletion whose tombstone
  had expired. Retries now re-read unlisted item results before publishing them, preserving
  newer offline writes (#55, D-46).
- Bare `npm run serve` could sync the local demo with the owner's live project. Local demo and
  assembled-site pages now default to the emulator, or use an explicit project from
  `BURROW_FIRESTORE`; their CSP follows the selected backend. Invalid explicit config stops the
  server and pages whose config cannot be rewritten are refused (#40, D-44).
- A sync pass could drop a key written while it was reading the cache.
- `link()` could finish against the old identity when the first sync pass was still running.
- Firestore reads could return a stale view of a document the page also listens to; reads now go
  through a transaction.
- A `BackendError` used as an error's `cause` kept its message unredacted, so a third-party
  adapter that put an id in it would leak it; it is now rebuilt and scrubbed like any other
  cause (#32).
