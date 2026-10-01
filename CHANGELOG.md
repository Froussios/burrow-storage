# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). The envelope version and the v1
derivation salts are public contract: changing them is a major release.

## [Unreleased]

### Added
- `burrow()` entry point with a `chrome.storage`-shaped `BurrowArea` and a
  synchronous `Storage` facade.
- Codec: HKDF id/key derivation, AES-256-GCM envelopes bound to id/app/rev,
  deflate-raw compression, hash-chained write tokens, sync codes.
- IndexedDB and memory caches; `MemoryBackend`; backend conformance suite.
- Sync engine: per-item documents, manifest, per-key last-writer-wins with
  tombstones, clock-skew correction, multi-tab coordination.
- Unlock methods: sync code and passkey (WebAuthn PRF keyslot).
- `FirestoreBackend` for the shared Spark-plan project, with rules and tests.
- Static demo (theme, draft, sync code, passkey backup, export, debug panel) under a strict CSP.
- `npx burrow-setup firestore` setup guide and script; SRI hashes and npm provenance on release.
- Script-tag build loads the Firestore SDK as a same-origin classic script, so it also works
  from `file://`.

### Fixed (found during development)
- A sync pass could drop a key written while it was reading the cache.
- `link()` could finish against the old identity when the first sync pass was still running.
- Firestore reads could return a stale view of a document the page also listens to; reads now
  go through a transaction.
