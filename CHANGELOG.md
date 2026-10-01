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
