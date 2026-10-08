# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). The envelope format, the v1 derivation salts and
labels, and the storage-token encoding are public contract: changing them is a major release.

## [Unreleased]

### Added
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
  firestore` guide and `--run` script.
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
- A sync pass could drop a key written while it was reading the cache.
- `link()` could finish against the old identity when the first sync pass was still running.
- Firestore reads could return a stale view of a document the page also listens to; reads now go
  through a transaction.
- A `BackendError` used as an error's `cause` kept its message unredacted, so a third-party
  adapter that put an id in it would leak it; it is now rebuilt and scrubbed like any other
  cause (#32).
