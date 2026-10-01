# CLAUDE.md — working in the Burrow repository

Burrow (`burrow-storage` on npm) is a browser library giving static sites encrypted, cross-device
key/value storage with no login and no site-owned backend. This file tells an agent how to work here.

## State of the project

Planning is complete; implementation has not started. Everything an implementer needs is in the
repository:

1. `docs/requirements.md` — what to build, with requirement ids (`API-3`, `ENC-7`, `SYNC-10`, …).
2. `docs/design-review.md` — the spec's known contradictions and gaps, each with the resolution adopted.
3. `docs/architecture.md` — **the implementation spec.** Exact encodings, schemas, algorithms, module
   layout, public types. When it disagrees with the requirements text, architecture.md wins.
4. `docs/decisions.md` — decision records (D1…). Binding until superseded.
5. `docs/implementation-plan.md` — milestones and work packages WP-00…WP-16 with definitions of done.
6. GitHub issues — one per work package (#2–#18, map in the plan); the issue is the live status, the plan is the map. Issue #1 holds the design-review decisions awaiting owner confirmation.

Read them in that order the first time. Afterwards, for a given WP: the issue → the architecture
sections it cites → the requirement ids it cites.

## How to pick up work

- Take the lowest-numbered open WP issue whose dependencies (listed in the issue and in the plan's
  dependency graph) are merged. M2 (Firestore, WP-13) and M3 (passkeys, WP-12) can run in parallel.
- Branch per WP: `wp-NN-short-name`. One PR per WP, referencing the issue (`Closes #N`).
- Name tests after requirement ids: `it("API-7 link rejects would-orphan when dirty items exist")`.
- If you must deviate from `docs/architecture.md`, change that document in the same PR and add a row
  to `docs/decisions.md`. Do not leave the spec and the code disagreeing.
- Do not change requirement ids or renumber anything; add new ids with a suffix (`SYNC-10a`) if needed.
- Update the WP issue with progress and the DoD checklist; close it from the PR.
- Decisions D1–D8 change MUST requirements and await owner confirmation in issue #1. Build to the adopted defaults; if the owner overrules one, the issue will say so.

## Hard rules (from the requirements; not negotiable without the owner)

- **No runtime dependencies** in core. Adapters may depend on their store's SDK only; the reference
  Firestore adapter uses REST and has none (D1).
- **WebCrypto only.** No third-party crypto. Every imported `CryptoKey` is non-extractable (SEC-2).
- **Never** send, log, or persist outside the cache: the root secret, `pathKey`, `encKey`, `macKey`,
  document ids, write tokens, or user values. Debug logging reports counts, revs, bytes and durations
  only (SEC-1, SEC-8, ERR-3). Error `cause` goes through `scrub()`.
- No `eval`, `new Function`, inline scripts, remote script loading, service workers, global patching
  (SEC-5, NF-2). The library must run under `default-src 'self'` plus the store host.
- Local reads and writes never reject for remote reasons (API-3, API-6). Remote failure is status.
- Dirty items are never dropped (SYNC-9).
- Vault format `v`, HKDF salt `burrow/v1`, labels, and the sync-code version byte are public contract;
  changing them is a major version with a migration (D18).
- Size budgets (min+gzip): core entry ≤ 12 KB, passkey provider ≤ 2 KB inside it, firestore entry ≤ 3 KB.

## Toolchain (decided in D10; WP-01 sets it up)

TypeScript 5 `strict`, ES2022, `lib` DOM. Node 20+, npm. Builds with tsup (ESM `dist/index.js`,
`dist/firestore.js`; IIFE `dist/burrow.min.js`, global `Burrow`). Tests: vitest with
`fake-indexeddb` (unit, property via fast-check, backend conformance), Playwright (Chromium, Firefox,
WebKit; CDP virtual authenticator for passkeys), firebase-tools emulator with
`@firebase/rules-unit-testing` (rules). size-limit, eslint, prettier. GitHub Actions.

Expected scripts once WP-01 lands (keep this list current):

```
npm run build          # tsup → dist/
npm run typecheck      # tsc --noEmit
npm run lint           # eslint + prettier --check
npm run test:unit      # vitest (node + fake-indexeddb)
npm run test:rules     # firebase emulators:exec "vitest run test/rules"
npm run test:browser   # playwright test
npm run size           # size-limit
npm run vectors        # python3 scripts/gen-vectors.py → test/vectors/
npm test               # unit + size
```

A pre-installed Chromium is available in Claude Code web sessions at `/opt/pw-browsers`; do not run
`playwright install`. The Firestore emulator needs Java; if it is missing, say so in the PR and run
the rules tests locally.

## Layout (target; see architecture §1 for the full tree)

```
src/            library source — api/, crypto/, cache/, sync/, providers/, backends/, util/, types.ts
test/           vectors/, unit/, conformance/, rules/, browser/
firestore/      firestore.rules, firebase.json, reaper.mjs
bin/            burrow-setup.mjs
demo/           static demo site (strict CSP)
docs/           requirements, design review, architecture, decisions, plan, backend and provider guides
scripts/        gen-vectors.py and other dev scripts
```

## Conventions

- `src/types.ts` is the single public surface; README snippets must compile against it.
- Pure logic (merge, derivation, codecs) lives in modules with no I/O so it can be property-tested.
- Inject clocks and timers (`util/timers.ts`); never call `Date.now()` or `setTimeout` directly in
  core logic.
- Prefer small files with one responsibility; the module layout in architecture §1 is the map.
- Commit messages: imperative subject ≤ 72 chars, body says *why*; reference the WP (`WP-07`) and
  requirement ids touched.
- Keep docs honest: when a capability turns out to be unavailable on a platform, write it in
  `docs/platform-notes.md` and amend the architecture, do not paper over it.

## Upstream source of the requirements

The requirements originate in a Claude doc ("Burrow — Requirements") owned by the repo owner.
`docs/requirements.md` is a snapshot at rev 79 (2026-10-01). If the owner updates the doc, re-snapshot
it and re-run the design review for the changed sections rather than editing the snapshot by hand.
