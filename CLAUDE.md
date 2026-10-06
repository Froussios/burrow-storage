# CLAUDE.md — working in the Burrow repository

Burrow (`burrow-storage` on npm) is a browser library that gives static sites encrypted,
cross-device per-user key/value storage with no login and no site-owned backend. This file tells
an agent or contributor how to work here.

## State of the project

The library is implemented and tested but **not yet released** (version 0.0.0, no npm publish, no
tags). The repository is about to be public. The documentation set is current with the code:

| Read | For |
| --- | --- |
| `README.md` | What Burrow is, why, quick start, the API in one page |
| `docs/api.md` | The public contract, member by member; `src/types.ts` is the source of truth |
| `docs/sync-and-tokens.md`, `docs/storage-standards.md`, `docs/firestore-setup.md`, `docs/extending.md` | User guides |
| `SECURITY.md` | The cryptographic design (normative) and threat model |
| `docs/architecture.md` | How the code is put together, module by module, with the sync algorithm |
| `docs/decisions.md` | Decision log: D-1… (implementation) and D1… (planning, with status) |
| `docs/user-journeys.md` | The five user journeys the demo and its browser tests implement |
| `CHANGELOG.md` | Keep-a-Changelog, unreleased section |
| `docs/history/` | The pre-implementation requirements brief, design review and plan. The brief's requirement ids (`API-3`, `ENC-7`, …) are cited by tests and code comments. Historical otherwise. |

GitHub issues #1–#18 and PR #19 are from the planning phase and do not reflect the code; treat
them as history unless the owner says otherwise.

## Hard rules (from the requirements; not negotiable without the owner)

- **No runtime dependencies** in the core. The Firestore adapter uses the Firebase modular SDK as
  an optional peer dependency, loaded lazily (`firebase/app`, `firebase/firestore` only; no auth).
- **WebCrypto only.** No third-party crypto. Every key derived from the token is imported
  non-extractable; the only extractable key object is the short-lived HMAC vehicle in
  `src/secret.ts` that carries the raw token through AES-KW.
- **Never** send, log, or persist outside the cache: the root secret, `pathKey`, `encKey`,
  `macKey`, document ids, write tokens, or user values. `debug` logging reports codes, counts,
  revisions, bytes and durations only. Error `cause`s go through `scrub()` in `src/errors.ts`.
- No `eval`, `new Function`, inline scripts, third-party script hosts, service workers, or global
  patching. The demo runs under `default-src 'none'; script-src 'self'; connect-src 'self'
  https://firestore.googleapis.com`.
- Local reads and writes never reject for remote reasons (API-3, API-6). Remote failure is status.
- Unsynced writes are never dropped by the engine (SYNC-9).
- **Public contract**, major version to change: the `Envelope` format, HKDF salts `burrow/v1`,
  `burrow/slot/v1`, PRF salt `burrow/prf/v1`, the info labels, the AAD and token formats, the
  storage-token encoding (`SECURITY.md`).
- Size budgets (min+gzip, `npm run size`): core + memory backend ≤ 12 KB; passkey provider ≤ 2 KB.
- Terminology: user-facing text says **storage token** for the sync code and **passkey backup**
  for a keyslot; the API names stay (`exportCode`, `link({ code })`, `bad-code`, `"code"`), see D-28.

## Toolchain

TypeScript 5.9 `strict`, ES2022, browser `lib`. **Node 22 or newer** for development (`npm test`
uses Node's `--localstorage-file`); `engines` says `>=18` because that is enough to run the
`burrow-setup` CLI. npm. Builds with tsup (`tsup.config.ts`). Tests with vitest (unit, property
via fast-check, backend conformance), Playwright (`test/e2e`, three engines, a CDP virtual
authenticator for passkeys), `node --test` for the rules under the Firestore emulator
(firebase-tools, Java 21). No linter is configured. GitHub Actions: `ci.yml`, `pages.yml`
(demo to GitHub Pages on `main`), `release.yml` (npm publish with provenance on `v*` tags).

```
npm ci
npm run typecheck      # tsc --noEmit
npm test               # vitest: test/unit, test/property, test/conformance/memory.test.ts
npm run test:watch
npm run build          # tsup → dist/index.js, dist/firestore.js, dist/burrow.min.js, dist/burrow-firestore.js
npm run size           # scripts/size.mjs budgets
npm run docs:check     # typecheck every README/guide code block against dist/*.d.ts (after a build)
npm run check          # typecheck + test + build + size + docs:check
npm run test:rules     # firebase emulator: node --test firebase/tests/rules.test.mjs  (cd firebase/tests && npm ci first)
npm run test:firestore # conformance suite against the emulator
npm run test:e2e       # playwright under the emulator (npm run build first)
npm run test:live      # conformance against a real project from BURROW_FIRESTORE or the demo page; writes throwaway docs; never in CI
npm run serve          # static server for demo/ and test pages at http://localhost:4173 (after a build)
npm run sri            # SRI hashes for the bundles → dist/sri.json
node scripts/gen-vectors.mjs   # regenerate test/vectors.json (output must not change within v1)
```

`BURROW_EMULATOR_PORT` overrides port 8080. In Claude Code web sessions Chromium is preinstalled
under `/opt/pw-browsers`; do not run `playwright install`. If Java is missing, say so and skip the
emulator suites.

## Layout

```
src/
  index.ts              public entry: burrow(), re-exports, default backend discovery, per-page Env
  iife.ts               script-tag entry (global Burrow) and the burrow-firestore.js loader
  types.ts              every public interface (single source of truth)
  errors.ts  events.ts  BurrowError/BackendError/scrub(); BurrowEvent
  core.ts               Core: mirror, cache, local writes, sync engine, tabs, link/unlink/protect
  facade.ts             synchronous Storage facade (Proxy)
  secret.ts             SecretHolder: AES-KW wrapped token
  bytes.ts              utf8/base64url/hex/sha256/random/zeroise
  codec/                derive.ts (HKDF, ids, tokens), envelope.ts (seal/open), synccode.ts
  cache/                types.ts, indexeddb.ts, memory.ts
  sync/merge.ts         pure LWW merge
  providers/            passkey.ts, synccode.ts
  backends/             memory.ts, firestore.ts, firestore-sdk.ts
test/                   unit/, property/, conformance/, e2e/, sample-app/, support/, vectors.json, setup.ts
firebase/               firestore.rules, firebase.json, README.md, tests/ (rules tests, own package.json)
scripts/                burrow-setup.mjs (bin), setup.sh, emulator.mjs, serve.mjs, size.mjs, sri.mjs, gen-vectors.mjs
demo/                   index.html, demo.js, demo.css, burrow.config.example.html
docs/                   guides, api, architecture, decisions, user-journeys, history/
```

## Conventions

- Name tests after the requirement ids they verify:
  `it("API-7 link rejects would-orphan when dirty items exist")`.
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
