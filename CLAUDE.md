# CLAUDE.md — working in the Burrow repository

Burrow (`burrow-storage` on npm) is a browser library that gives static sites encrypted,
cross-device per-user key/value storage with no login and no site-owned backend. This file tells
an agent or contributor how to work here.

## State of the project

The first release is `0.1.1` (tag `v0.1.1`, staged on npm by `release.yml` through trusted
publishing and approved by the owner with 2FA, D-53; `0.0.0` is a code-free placeholder that
claimed the name). The repository is public. The documentation set is current with the code:

| Read | For |
| --- | --- |
| `README.md` | What Burrow is, why, quick start, the API in one page |
| `docs/api.md` | The public contract, member by member; `src/types.ts` is the source of truth |
| `docs/retention.md`, `docs/sync-and-tokens.md`, `docs/storage-standards.md`, `docs/firestore-setup.md`, `docs/extending.md` | User guides |
| `SECURITY.md` | The cryptographic design (normative) and threat model |
| `docs/architecture.md` | How the code is put together, module by module: the core, the offline wrapper and its sync, the passkey utility |
| `docs/decisions.md` | Decision log: D-1… (implementation) and D1… (planning, with status) |
| `docs/user-journeys.md` | The user journeys the demo and its browser tests implement, in both sign-in modes |
| `CHANGELOG.md` | Keep-a-Changelog, unreleased section |
| `docs/history/` | The pre-implementation requirements brief, design review, plan and WP-00 platform notes. The brief's requirement ids (`API-3`, `ENC-7`, …) are cited by tests and code comments. Historical otherwise. |

GitHub issues #1–#18 and PR #19 are from the planning phase and do not reflect the code; treat
them as history unless the owner says otherwise.

## Backward compatibility: no clients yet

Burrow currently has no clients. The demo, test fixtures and published npm versions do not
create a backward-compatibility obligation. Until clients arrive, design proposals and reviews
must favour the simplest correct design for current needs. Breaking changes to APIs, storage,
tokens, passkeys and cryptographic formats are allowed; do not require compatibility shims,
legacy readers, migration paths, deprecation periods or major-version bumps solely to preserve
earlier behaviour (D-55).

Security and correctness rules still apply. Update the implementation, tests, reference vectors
and affected documentation together, and record design changes in `docs/decisions.md`. Existing
references to a frozen or stable public contract describe the current implementation; they do
not override this policy. When the first clients arrive, document the supported contract and
compatibility and migration expectations before further breaking changes.

## Hard rules (from the requirements; not negotiable without the owner)

- **Three independent layers** (D-57): the remote-only core (`burrow()`, no disk, async calls
  that reject on remote failure), the optional plaintext offline wrapper (`offline()`), and the
  independent passkey token utility (`passkeyToken()`). The wrapper uses the core's internal seam
  (`remoteOf()`), never the backend directly; the seam is not public API.
- **No runtime dependencies** in the core. The Firestore adapter uses the Firebase modular SDK as
  an optional peer dependency, loaded lazily (`firebase/app`, `firebase/firestore` only; no auth).
- **WebCrypto only.** No third-party crypto. Every key derived from the token is imported
  non-extractable, and decoded token bytes and PRF outputs are zeroised once used.
- **Burrow never persists the token** or any key derived from it, under any option, and never
  generates or recovers one implicitly (D-57). Token custody is the app's.
- **Never** send or log the root secret, `pathKey`, `encKey`, `macKey`, document ids, write
  tokens, or user values, and never persist any of them except user values in the offline
  wrapper's plaintext copy. Burrow logs nothing. Error `cause`s go through `scrub()` in
  `src/errors.ts`.
- No `eval`, `new Function`, inline scripts, third-party script hosts, service workers, or global
  patching. The demo runs under `default-src 'none'; script-src 'self'; connect-src 'self'
  https://firestore.googleapis.com`.
- In the offline wrapper, reads and writes never reject for remote reasons (API-3, API-6); remote
  failure is status, and unsynced writes are never dropped (SYNC-9). The core instead rejects
  remote failures and queues nothing.
- Only the demo may use the owner's Firebase project. CI reaches it only through the deployed
  demo page in `pages.yml`; other tests and scripts use the emulator or a caller-named project
  (D-43, #40). Live setup checks require caller-supplied config (`BURROW_FIRESTORE` for
  `npm run test:live`, the argument to `burrow-setup check`) and never run in CI. They have no
  fallback to the owner's project (D-49 amends D-43).
  `npm run serve` rewrites the local demo and assembled `site/` to use the emulator
  (`FIRESTORE_EMULATOR_HOST` or `127.0.0.1:8080`) by default. Set `BURROW_FIRESTORE` to an
  explicit project config to use your own live or pre-production store; invalid config or
  simultaneous live and emulator settings stop the server (D-44).
- **Current cryptographic contract:** the `Envelope` format, HKDF salt `burrow/v1`, the info
  labels, the AAD and token formats, the storage-token encoding, and the passkey token
  derivation (PRF input `burrow/prf-token/v1`, HKDF salt `burrow/passkey-token/v1`, info = app)
  (`SECURITY.md`, D-58). Changes must keep code, tests, reference vectors and security
  documentation consistent. Compatibility and migration follow the no-clients policy above
  (D-55).
- Size budgets (min+gzip, `npm run size`): core + memory backend ≤ 12 KB; core, offline wrapper
  and memory backend together ≤ 12 KB; the passkey token utility (`burrow-storage/passkey`)
  ≤ 2 KB on top of the core.
- Terminology: the **storage token** (`burrow({ token })`, `generateToken()`, `bad-token`), the
  **core**, the **offline wrapper** and the **passkey token**, in user-facing text and the API
  alike. The requirements brief's *sync code* and *root secret* are the same token.
- The store deals only in the token string. Ways to obtain or keep it (the passkey utility, a
  site's own) live outside the core and the wrapper; there is no provider interface (D-42), and
  there is no online token storage or keyslot (D-58).
- Preserve expiry pause/copy/dirty data in the offline wrapper and its use-driven renewal (D-48,
  D-59). Optional owner reaping is content-only, server-updateTime conditioned, quota bounded and
  outside CI. See `docs/retention.md`.
- The offline wrapper's copy is plaintext and must be documented as such; encrypting it is
  deferred, not solved (D-57).

## Toolchain

TypeScript 5.9 `strict`, ES2022, browser `lib`. **Node 22 or newer** for development; `engines`
says `>=20`, which the `burrow-setup check` live rules check and the agent setup's Firebase CLI
need. npm.
Builds with tsup (`tsup.config.ts`). Tests with vitest (unit, property
via fast-check, backend conformance), Playwright (`test/e2e`, three engines, a CDP virtual
authenticator for passkeys), `node --test` for the rules under the Firestore emulator
(firebase-tools, Java 21). No linter is configured. GitHub Actions: `ci.yml`, `pages.yml`
(demo to GitHub Pages at <https://froussios.github.io/burrow-storage/> on every push to `main`,
then a smoke test against it), `release.yml` (on `v*` tags, stages the package on npm with
provenance through trusted publishing; the owner approves it with 2FA),
`claude-code-review.yml` (Claude reviews the owner's PRs with the `pr-review` skill in
`.claude/skills/pr-review/SKILL.md` and approves on a "no blocking issues" verdict) and
`claude.yml` (`@claude` mentions from people with write access).

```
npm ci
npm run typecheck      # tsc --noEmit
npm run format         # prettier --write ., then scripts/wrap-comments.mjs wraps comments at 80
npm run format:check   # both in check mode (runs in CI)
npm test               # vitest: test/unit, test/property, test/conformance/{memory,worker}.test.ts
npm run test:watch
npm run build          # tsup → dist/index.js, dist/offline.js, dist/passkey.js, dist/firestore.js, dist/burrow.min.js, dist/burrow-firestore.js
npm run size           # scripts/size.mjs budgets
npm run docs:check     # typecheck every README/guide code block against dist/*.d.ts (after a build)
npm run check          # typecheck + test + build + size + docs:check
npm run test:rules     # firebase emulator: node --test firebase/tests/rules.test.mjs  (cd firebase/tests && npm ci first)
npm run test:firestore # conformance suite against the emulator
npm run test:e2e       # playwright under the emulator (npm run build first)
npm run test:live      # one-off setup check of your own project; set the BURROW_FIRESTORE environment variable (docs/firestore-setup.md); never in CI
npm run serve          # local demo defaults to the emulator; BURROW_FIRESTORE selects your own project (after a build)
npm run demo:build     # site/: the deployable demo, footer stamped with the commit (after a build)
npm run test:smoke     # demo smoke test: BURROW_DEMO_URL=<deployed demo>, or site/ under the emulator:
                       #   node scripts/emulator.mjs "npm run test:smoke"
npm run sri            # SRI hashes for the bundles → dist/sri.json
npm run release:approve  # owner, after a v* release run: approve on npm (2FA), publish the draft release
node scripts/gen-vectors.mjs   # regenerate test/vectors.json; changes must match the documented design
```

`node scripts/emulator.mjs "npm run serve"` starts the emulator and local demo together.
`FIRESTORE_EMULATOR_HOST` selects an already-running emulator for bare `npm run serve`;
`BURROW_EMULATOR_PORT` overrides port 8080 when using `scripts/emulator.mjs`.
For a real project, set `BURROW_FIRESTORE` to its config JSON and run `npm run serve` directly;
see [firestore-setup.md](docs/firestore-setup.md#local-development). Do not also set
`FIRESTORE_EMULATOR_HOST`. CI browser and smoke suites use only the emulator.
In Claude Code web sessions Chromium is preinstalled
under `/opt/pw-browsers`; do not run `playwright install`. If its build is not the one Playwright
expects, run through an untracked local config that spreads the real one and sets
`use.launchOptions.executablePath: "/opt/pw-browsers/chromium"`. If Java is missing, say so and
skip the emulator suites.

## Layout

```
src/
  index.ts              public entry: burrow(), generateToken(), re-exports
  core.ts               Core: remote-only store, keys in memory, push/publish, internal seam
  offline.ts            burrow-storage/offline: offline(), the plaintext copy, replay, tabs, renewal
  passkey.ts            burrow-storage/passkey: passkeyToken() (a token derived from a passkey)
  config.ts             backend selection: registerBackend, readBackendConfig (page config)
  iife.ts               script-tag entry (global Burrow) and the burrow-firestore.js loader
  types.ts              every public interface (single source of truth)
  errors.ts  events.ts  BurrowError/BackendError/scrub(); BurrowEvent
  bytes.ts              utf8/base64url/hex/sha256/random/zeroise
  codec/                derive.ts (HKDF, ids, tokens, passkey token), envelope.ts (seal/open), token.ts
  cache/                the offline wrapper's copy: types.ts, indexeddb.ts, memory.ts
  sync/merge.ts         pure LWW merge
  backends/             memory.ts, firestore.ts, firestore-sdk.ts
test/                   unit/, property/, conformance/, e2e/, smoke/, support/, vectors.json, setup.ts
firebase/               SETUP-AGENT.md, firestore.rules, firebase.json, README.md, tests/ (rules tests, own package.json)
scripts/                burrow-setup.mjs, burrow-reaper.mjs (bins), emulator.mjs, serve.mjs, build-demo.mjs, size.mjs, sri.mjs, gen-vectors.mjs, check-docs.mjs
demo/                   index.html, demo.js, demo.css, favicon.svg, burrow.config.example.html
docs/                   guides, api, architecture, decisions, user-journeys, history/
```

## Conventions

- Name tests after the requirement or decision ids they verify:
  `it("API-8 forget() refuses to orphan unsynced writes, then deletes the copy")`.
- Pure logic (merge, derivation, codecs) stays in modules with no I/O so it can be property-tested
  and checked against vectors.
- `src/types.ts` is the single public surface; README and `docs/api.md` snippets must compile
  against it; `npm run docs:check` (`scripts/check-docs.mjs`) enforces that.
- Any behaviour change that departs from `SECURITY.md` or `docs/architecture.md` updates that
  document in the same PR and adds a `D-n` entry to `docs/decisions.md`. Do not leave the docs
  and the code disagreeing.
- Do not renumber requirement ids or decisions; add new ones at the end.
- Commit messages: imperative subject ≤ 72 chars, body says *why*; cite requirement or decision
  ids touched.
- Keep docs honest: when a platform lacks a capability, document it (architecture §13 lists the
  known gaps) rather than papering over it.

## Upstream source of the requirements

The requirements brief (`docs/history/requirements.md`) is a snapshot taken on 2026-10-01 of a
document the owner maintains elsewhere. If the owner updates it, re-snapshot it and reconcile the
changed sections against the code and `docs/decisions.md` rather than editing the snapshot by hand.
