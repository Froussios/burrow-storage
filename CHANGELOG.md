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
- Unlock methods: the storage token (`exportCode()`, `link({ code })`, `#burrow=<token>` links)
  and passkeys with PRF-wrapped keyslots (`protect("passkey")`, `link({ provider: "passkey" })`).
- `store.token` / `onToken`: where this device's token came from (`generated`, `code`, `link`,
  `passkey`, custom) and whether it was remembered from an earlier visit.
- `unlink({ discardLocal })` with the same `would-orphan` guard as `link()`.
- `syncNow()` rejects with the sync error when a pass fails; `exportJSON()` /
  `importJSON()` with the `{ burrow: 1, app, exportedAt, items }` format; `inspect()`.
- Events are `BurrowEvent`s: real `EventTarget`s with chrome-style `addListener` helpers.
- `FirestoreBackend` (`burrow-storage/firestore`) over the modular Firebase SDK, with transactional
  reads and writes and a manifest listener; `readFirestoreConfig()` for the
  `<meta name="burrow-firestore">` / `window.BURROW.firestore` page config; `passkey()` options
  (`rpId`, `rpName`, `userName`, `timeoutMs`).
- Firestore security rules with the SHA-256 write chain, emulator tests, `npx burrow-setup
  firestore` guide and `--run` script.
- Static demo (theme, draft, storage token panel, passkey backup, export, debug panel) under a
  strict CSP.
- The demo is always available at <https://froussios.github.io/burrow-storage/>, redeployed to
  GitHub Pages from every push to `main`. Its footer shows the commit and build time
  (`npm run demo:build`), and Playwright smoke checks (`npm run test:smoke`) check each deploy:
  the page itself, and the demo's Firebase project as a separate step.
- Script-tag build `burrow.min.js` (global `Burrow`) that loads the Firestore SDK as a
  same-directory classic script (`burrow-firestore.js`), so it also loads from `file://`.
- SRI hashes and npm provenance in the release workflow.
- Documentation set for external users: README, API reference, guides for tokens and sync,
  localStorage migration, the shared store, and extending; SECURITY.md; architecture and
  decision log.

### Changed
- User-facing wording calls the sync code the **storage token**; API names are unchanged.
- Setting a key to the value it already has is still a write (it takes a new timestamp and
  syncs), so the last writer wins across devices; only the `onChanged` event is skipped.
- `exportCode()` no longer marks the token as protected; `protect("sync-code")` does.

### Fixed (found during development)
- A sync pass could drop a key written while it was reading the cache.
- `link()` could finish against the old identity when the first sync pass was still running.
- Firestore reads could return a stale view of a document the page also listens to; reads now go
  through a transaction.
