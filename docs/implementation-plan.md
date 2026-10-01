# Implementation plan

Work is cut into work packages (WP). Each WP is one GitHub issue, one branch, one PR. The issue
is the live status; this file is the map. An agent picking up a WP reads, in order:
`CLAUDE.md` → this file → the WP's issue → the architecture sections it cites → the requirement ids
it cites. Do not start a WP whose dependencies are not merged unless the issue says a stub is fine.

## Milestones

| Milestone | Outcome | WPs |
|---|---|---|
| **M0 Spikes & scaffold** | Repo builds, lints, tests, measures size in CI; the three platform assumptions are verified | WP-00, WP-01 |
| **M1 Core offline** | `burrow()` works end to end against `MemoryBackend` in node and in a browser: cache, crypto, sync, merge, API, facade, multi-tab, sync code | WP-02 … WP-11 |
| **M2 Firestore** | The same code syncs through a real Spark project; rules tested on the emulator; setup CLI | WP-13 |
| **M3 Passkeys** | Second-device recovery with a passkey via a keyslot; virtual-authenticator tests | WP-12 |
| **M4 Release 0.1** | Demo site, docs, SECURITY.md final, acceptance suite green cross-browser, npm publish with provenance | WP-14, WP-15, WP-16 |

M2 and M3 are independent of each other and can run in parallel after M1.

## Dependency graph

```
WP-00 spikes ─────────────────────────────────┐
WP-01 scaffold ─┬─ WP-02 primitives ─┬─ WP-03 crypto ─┬─ WP-04 backend contract + memory + conformance
                │                    │                 ├─ WP-05 cache + secret persistence
                │                    │                 └─ WP-11 sync-code provider
                │                    └─ WP-06 merge (pure)
                └────────────────────────── WP-07 sync engine  (needs 03, 04, 05, 06)
                                            WP-08 BurrowArea API + registry (needs 05, 07)
                                            WP-09 Storage facade (needs 08)
                                            WP-10 multi-tab (needs 08)
                                            WP-12 passkey provider (needs 03, 04, 08; after WP-00 PRF spike)
                                            WP-13 Firestore REST adapter + rules + CLI (needs 04; after WP-00)
                                            WP-14 browser integration tests (needs 09, 10, 11; 12, 13 for their specs)
                                            WP-15 demo + docs (needs 13, 12)
                                            WP-16 release (needs all)
```

## Work packages

Each WP lists: goal · scope (in/out) · spec refs · design refs · definition of done (DoD) · size
(S ≤ ½ day, M ≈ 1–2 days, L ≈ 3–5 days of focused agent work).

### WP-00 Spikes: verify platform assumptions — size S

Goal: retire the three assumptions the design rests on before code depends on them.
1. **Rules hashing.** In the Firestore emulator, confirm `hashing.sha256(string).toHexString()`
   returns lowercase hex of the UTF-8 bytes of the string, and that the update rule in
   architecture §9.4 accepts a correct chain and rejects a wrong `tok`. Also confirm on a real Spark
   project once (document the project id used in the issue, not in the repo).
2. **Unauthenticated REST.** Confirm `GET`/`POST`/`PATCH` on `firestore.googleapis.com` with only
   `x-goog-api-key` works from a browser page (CORS from `https://` and from `file://`/`null`
   origin), that rules see `request.auth == null`, and record the exact JSON error shapes for 403,
   404, 409, 429 (`status` field strings).
3. **PRF at create vs get.** On Chromium (CDP virtual authenticator with `hasPrf: true`) and, if a
   device is available, Safari and Android: does `create()` return `prf.results.first`? Does `get()`
   with empty `allowCredentials` return it? Record per platform in `docs/platform-notes.md`.
DoD: `docs/platform-notes.md` with findings; architecture §9.3/§8.2 amended if anything differs; the
issue lists any requirement that must change.

### WP-01 Repo scaffold and CI — size M

Scope: `package.json` (name `burrow-storage`, `exports` for `.` and `./firestore`, `sideEffects:false`,
`files`), `tsconfig.json` (strict, ES2022, `lib: ["ES2022","DOM","DOM.Iterable"]`), tsup config for
ESM + IIFE (`Burrow` global), vitest config (node env + `fake-indexeddb/auto` setup file), Playwright
config (Chromium/Firefox/WebKit, serves `demo/` and `test/browser/pages/`), eslint + prettier,
size-limit config with the §2 budgets, `npm run` scripts (`build`, `test`, `test:unit`,
`test:browser`, `test:rules`, `lint`, `typecheck`, `size`, `vectors`), GitHub Actions workflow
running lint, typecheck, unit, size on every push and browser + rules (emulator) on PRs. Empty
`src/index.ts` exporting a version constant so the pipeline runs. `LICENSE` exists already.
Design refs: architecture §1, §2; decisions D9, D10.
DoD: CI green on the branch; `npm run build` emits the three bundles; size-limit reports.

### WP-02 Primitives — size S

Scope: `util/bytes.ts` (utf8 encode/decode, base64url encode/decode without padding, hex, concat,
`zero()`, constant-time equality), `util/base32.ts` (Crockford alphabet, encode/decode, confusable
mapping O→0, I/L→1, case-insensitive, strips non-alphanumerics), `util/events.ts` (`BurrowEvent<T>`
emitter with try/catch per listener), `util/json.ts` (`assertJsonValue` per architecture §4.3,
`jsonBytes`), `util/timers.ts` (injectable clock, debounce, jittered backoff schedule), `util/log.ts`.
Spec refs: API-4, KP-11, ERR-3. Design refs: architecture §4.3, §4.4, §8.1 (codec only), D6.
DoD: unit tests incl. base32 round-trips with fast-check, every `assertJsonValue` reject case listed
in §4.3, error messages never include values.

### WP-03 Crypto: derivation, tokens, envelopes, device wrapping, vectors — size M

Scope: `crypto/derive.ts`, `crypto/tokens.ts`, `crypto/envelope.ts` (seal/open with optional
deflate-raw, AAD `${id}|${app}|${rev}`, size check against a `maxEnvelopeBytes` argument),
`crypto/secret.ts` (generate, `fp`, wrap/unwrap under a non-extractable AES-GCM key),
`scripts/gen-vectors.py` and `test/vectors/*.json`: derivation (3 roots × 2 apps), `docId` for keys
incl. unicode and empty string, token chains `n = 0..5` with `next`, envelopes with fixed iv for
decrypt-only vectors (plain and deflated), wrong-AAD negatives.
Spec refs: ENC-1..ENC-5, ENC-7, ENC-10, KP-2, SEC-1, SEC-2. Design refs: architecture §5; D5, D11, D17.
DoD: all vectors pass; all `CryptoKey`s non-extractable (test via `exportKey` throwing); raw buffers
zeroed (test with a spy on the array); `open()` rejects a changed `rev`, `id` or `app`.

### WP-04 Backend contract, `MemoryBackend`, conformance suite — size M

Scope: `errors.ts` (`BurrowError`, `BackendError`, `scrub()`), `backends/memory.ts` with chain
verification, test hooks (`failNext`, `latencyMs`, `dump`), synchronous `subscribe`; `getMany`
default in core; `test/conformance/backend.suite.ts` exported as `runBackendConformance(factory)`.
Spec refs: BE-1..BE-7, ENC-7, ENC-8, SEC-8. Design refs: architecture §9.1, §9.2, §4.7.
DoD: suite covers create/update/conflict/unauthorized/too-large/race (10 concurrent `put`s at the same
rev → exactly one success)/`getMany` parity/`subscribe` delivery; `MemoryBackend` passes; `scrub()`
removes 43/64-char ids and hex and named fields.

### WP-05 Cache: IndexedDB and memory stores, app state, secret persistence — size M

Scope: `cache/types.ts`, `cache/idb.ts` (database `burrow` v1, stores `items` `[app,key]`, `state`,
`meta`; open with fallback), `cache/memory.ts`; integration of `crypto/secret.ts` for `meta.secret`;
fingerprint check helper (`validateAppCache(app)`).
Spec refs: SYNC-1..SYNC-4, ENC-10, KP-2. Design refs: architecture §6; D2.
DoD: unit tests on `fake-indexeddb`: per-app clear touches only that app; `putMany` is atomic
(inject a failure mid-batch); `CryptoKey` round-trips through the store; open failure → memory
fallback flagged; state/meta CRUD.

### WP-06 Merge logic — size S

Scope: `sync/merge.ts` pure functions `resolveKey`, `mergeManifests`, `pruneTombstones`, `planPull`
(the diff in architecture §7.3); property tests with fast-check simulating 2–3 devices with skewed
clocks, random set/remove/offline/online sequences, 30-day horizon.
Spec refs: SYNC-10..SYNC-13. Design refs: architecture §7.3; D13, D14.
DoD: properties: commutative, idempotent, convergent; "stale device does not resurrect" scenario;
tie-break rules exactly as D13; no I/O in the module.

### WP-07 Sync engine — size L

Scope: `sync/engine.ts`: status machine, push (two-stage dirty, item then manifest, per-document
retry schedule, conflict re-fetch and merge), pull (manifest-first diff, parallel item fetch, one
`onChanged`), scheduler (debounce, adaptive polling, backoff, visibility/focus triggers), flush mode,
`decrypt-failed` pause, debug log lines, `inspect()` data. Uses the injectable clock and timers.
Spec refs: SYNC-5..SYNC-9, SYNC-13, ENC-6, ENC-8, ERR-2, ERR-3, NF-3. Design refs: architecture §7.1–7.5, §10; D3, D14, D16.
DoD: unit tests against `MemoryBackend` with fake timers covering: debounce coalescing; manifest
written last; crash between item and manifest (simulated by `failNext`) → retry writes manifest only;
item conflict both directions; manifest conflict merges; pull with no change costs exactly one `get`;
adaptive interval doubling and reset; backoff on `network`/`quota`; dirty never dropped; status
transitions and `onStatus` payloads; two engines on one backend converge (reuses WP-06 scenarios).

### WP-08 `BurrowArea` API and registry — size M

Scope: `api/area.ts`, `api/registry.ts`, `index.ts` wiring (`burrow()` startup sequence §4.1),
`get/set/remove/clear/getBytesInUse` argument shapes, `onChanged` local events, `protect`, `link`,
`unlink`, `syncNow`, `exportCode`, `exportJSON`, `importJSON`, `inspect`, `onUnprotected`, `linked`
semantics for `rememberDevice:false`, fingerprint wipe at startup.
Spec refs: API-1..API-8, API-13, KP-1..KP-4, KP-14, ERR-1, ERR-4. Design refs: architecture §4.1, §4.2, §4.6, §4.7; D8.
DoD: tests mirroring every `chrome.storage.StorageArea` argument shape; `set` rejects before writing
anything when one key is invalid; `would-orphan` across apps; `link` wipes the app cache and pulls;
`unlink` keeps items and the next `burrow()` wipes; `rememberDevice:false` performs no network and
generates no secret; `onUnprotected` fires once per device; `burrow()` < 50 ms warm with 200 items
(vitest benchmark, informational in CI).

### WP-09 `Storage` facade — size S

Scope: `api/facade.ts`, coalesced write-behind, unload flush hook into the engine's flush mode,
`getItem` stringification rule, no `storage` event.
Spec refs: API-9..API-12, ERR-1. Design refs: architecture §4.5; D15.
DoD: DOM `Storage` semantic tests (`length`, `key(n)` order, `null` for missing, string coercion);
synchronous `item-too-large`; mirror correct before `burrow()` resolves; writes land in the cache in
one transaction per tick; `pagehide` flushes.

### WP-10 Multi-tab coordination — size M

Scope: `sync/tabs.ts`: `BroadcastChannel` protocol (`changes`, `pulled`, `secret-changed`, `ping`),
leader election via `navigator.locks`, heartbeat fallback, follower behaviour in the engine.
Spec refs: SYNC-14. Design refs: architecture §7.6; D12.
DoD: unit tests with a fake `BroadcastChannel` and fake locks: exactly one leader; followers never
call the backend; a follower's write is pushed by the leader; leader loss promotes a follower;
`secret-changed` reloads followers. Browser test lands in WP-14.

### WP-11 Sync-code provider — size S

Scope: `providers/sync-code.ts` (encode with version byte and checksum, decode with confusables,
`KeyProvider` impl), `exportCode()` wiring, `link({code})` with `bad-code` before network and the
empty-vault check (T4).
Spec refs: KP-11, KP-12, SEC-3. Design refs: architecture §8.1; D4, D7.
DoD: vectors from WP-03 pass; 56 chars / 14 groups; checksum and version negatives; confusable inputs
decode; `link({code})` on a code with no manifest → `bad-code`.

### WP-12 Passkey provider and keyslots — size L

Scope: `providers/passkey.ts` per architecture §8.2: `available()` without prompting, `enrol()` with
PRF at create or a follow-up `get()`, keyslot write with `slotMac` chain, `recover()`,
`meta.credential` persistence, `prf-unsupported` and cancel handling; `protect()`/`link()` wiring.
Spec refs: KP-5..KP-10, ENC-11, SEC-7. Design refs: architecture §8.2; design-review C1, G6; WP-00 PRF findings.
DoD: unit tests with a mocked `navigator.credentials` covering both PRF paths and all rejections;
Playwright Chromium test with a CDP virtual authenticator (`hasPrf`, `hasResidentKey`,
`hasUserVerification`, `isUserVerified`): enrol on page A, clear site data, recover on page B, data
appears; provider bundle ≤ 2 KB min+gzip.

### WP-13 Firestore REST adapter, rules, emulator tests, setup CLI — size L

Scope: `backends/firestore.ts` and `src/firestore.ts` entry (`FirestoreBackend`, `fromPage()`),
field encoding, error classification with read-on-403, keepalive option; `firestore/firestore.rules`
(architecture §9.4), `firestore/firebase.json` (rules path, emulator ports), `test/rules/*.test.ts`
(FS-13 matrix), conformance suite run against the emulator, `firestore/reaper.mjs` (admin SDK,
documents with `ts` older than 12 months → delete; dry-run default), `bin/burrow-setup.mjs` printing
the console steps and writing a `<meta>` snippet, `docs/backend-firestore.md` with the Spark ceilings
and per-sync costs (FS-11, FS-12, Q4 honesty).
Spec refs: FS-1..FS-13, BE-1..BE-7, SEC-4, SEC-5. Design refs: architecture §9.3, §9.4; D1, D3; WP-00 findings.
DoD: rules matrix green on the emulator; conformance green on the emulator incl. the race test; a
manual run against a real Spark project recorded in the PR; `firestore` entry ≤ 3 KB; `npx
burrow-setup firestore` output reviewed.

### WP-14 Browser integration and acceptance tests — size L

Scope: Playwright specs for: startup budget; IndexedDB persistence across reloads; two tabs (leader,
propagation both directions, leader handoff on close); unload flush observed by a mock Firestore
REST server (`test/browser/mock-firestore.ts`, also used to simulate 403/429/5xx); offline → online
resume (`context.setOffline`); `rememberDevice:false` unlinked mode; strict-CSP page without console
errors; the acceptance criteria list from `docs/requirements.md` as one spec file, run on Chromium,
Firefox, WebKit (passkey cases Chromium-only).
Spec refs: acceptance criteria, SEC-5, NF table. Design refs: architecture §11.
DoD: all specs green on all three engines in CI; the acceptance spec names each criterion in its test
title.

### WP-15 Demo site and documentation — size M

Scope: `demo/` static page (theme + draft text, link/protect buttons, status badge, debug panel from
`inspect()`, strict CSP meta, SRI script tag), hosted via GitHub Pages workflow; README final form
(10-line integration, `localStorage` migration recipe, backend setup pointer, "Burrow cannot reset
your data" wording per SEC-3); `SECURITY.md` final (threat table, what the store learns, T1–T4
honesty); `docs/backend-firestore.md`; `docs/providers.md` (writing a custom provider, KP-15);
`docs/backends.md` (writing an adapter, running the conformance suite).
Spec refs: SEC-3, SEC-6 (SRI form), SEC-9, NF Docs row, KP-10, KP-15. Design refs: all.
DoD: demo runs from Pages against a Spark project; docs reviewed against the final API in
`src/types.ts`; no stale requirement ids.

### WP-16 Release 0.1.0 — size S

Scope: `npm view burrow-storage` check (fall back to a scoped name), `CHANGELOG.md`, GitHub Actions
publish workflow with npm provenance (`--provenance`), SRI hash generation for `burrow.min.js`
appended to the release notes, version tag, size report in the release.
Spec refs: SEC-6, NF Versioning. Design refs: D18.
DoD: package installable; `import { burrow } from "burrow-storage"` and the IIFE both work from a
clean project; provenance badge visible on npm.

## Follow-ups (not in v1, file as issues when v1 ships)

- Firestore SDK adapter with `onSnapshot` subscribe (D1 consequence).
- Cloudflare Worker backend with reference Worker source and `wrangler` template.
- Generic `http` backend for self-hosters.
- Google Drive `appDataFolder` backend.
- Passphrase provider (version byte `0x02`, PBKDF2 ≥ 600 K per ENC-3).
- URL-fragment / QR handshake transport behind explicit opt-in (D7).
- Chunked items above the per-document limit.
- Shared multi-user vaults.
- External cryptographic review before 1.0 (SEC-9).

## Working agreements for every WP

- Requirement ids in test names and PR descriptions (`"API-7 link rejects would-orphan"`).
- No new runtime dependency without a decision entry in `docs/decisions.md`.
- Any deviation from `docs/architecture.md` is first written into that document in the same PR.
- Keep `src/types.ts` the single public surface; README snippets must compile against it.
- Never log or persist ids, tokens, key material or values outside the cache (SEC-8).
