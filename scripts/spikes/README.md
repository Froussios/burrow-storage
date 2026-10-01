# WP-00 spikes

Throwaway harness that checks the platform assumptions Burrow's design rests on before code depends
on them. Findings are written up in [`docs/platform-notes.md`](../../docs/platform-notes.md); raw
outputs are in `results/`. This directory is **not part of the library**: it has its own
`package.json` with pinned versions, no lockfile, and nothing in `src/` may import from it. Root
tooling (eslint, tsc, size-limit) should ignore `scripts/spikes/`.

| File | What |
|---|---|
| `spike.rules` | Architecture §9.4 verbatim, plus two spike-only probe collections (`probe`, `authprobe`). Never deploy outside a throwaway project |
| `rest-matrix.mjs` | The REST matrix, rules probes and CORS probe. Each function is self-contained so it runs in Node and inside a page via `page.evaluate` |
| `run-emulator.mjs` | Matrix + rules probes against the Firestore emulator → `results/emulator.json` |
| `run-browser.mjs` | Chromium: page environment, CORS against production, WebAuthn PRF on the CDP virtual authenticator → `results/browser.json`; with `--prod`, the matrix against a real project → `results/prod.json` |
| `blank.html` | The `file://` page |

## Run

```sh
cd scripts/spikes
npm install                 # firebase-tools + playwright, pinned; needs Java 11+ for the emulator
npm run emulator            # rules hashing, REST matrix, race test on the emulator
npm run browser             # needs network access to firestore.googleapis.com
```

Playwright 1.56.1 needs its Chromium build (1194). In Claude Code web sessions it is pre-installed at
`/opt/pw-browsers`, so do not run `playwright install`. Elsewhere run `npx playwright install chromium`
once. Behind a TLS-intercepting proxy, set `SPIKE_IGNORE_HTTPS_ERRORS=1`. `run-browser.mjs` passes
`HTTPS_PROXY` to Chromium, which ignores it otherwise.

The `https://burrow-spike.example` origin is synthetic: Playwright serves that page locally, so it is
a real secure https origin and a valid WebAuthn `rp.id`, while the page's requests to Firestore go to
the network.

## Owner run against a real Spark project

This is the one step that needs credentials. It runs the same matrix in production from both origins.

1. In the Firebase console, create a **throwaway** project on Spark (no billing account). Add Cloud
   Firestore in production mode, any location. Do not reuse a project that holds real data:
   `spike.rules` opens two probe collections.
2. Deploy the spike rules:
   `npx firebase login` then `npx firebase deploy --only firestore:rules --project <project-id>`.
3. Take the project's Web API key (Project settings → General), unrestricted for now.
4. Run `BURROW_SPIKE_PROJECT=<project-id> BURROW_SPIKE_API_KEY=<key> npm run prod`. The project id and
   key are redacted from `results/prod.json`. Every matrix step should report `ok: true`. Note any that
   do not, plus the `get-without-api-key` answer.
5. Referrer check (FS-12 vs NF-1): in Google Cloud console → APIs & Services → Credentials, restrict
   that key to HTTP referrer `https://burrow-spike.example/*` and wait a few minutes. Then run
   `SPIKE_LABEL=referrer-restricted BURROW_SPIKE_PROJECT=… BURROW_SPIKE_API_KEY=… npm run prod`.
   Expected: the `https` origin passes and `file://` fails with `403` and reason
   `API_KEY_HTTP_REFERRER_BLOCKED`.
6. Commit both JSON files (they are redacted) and update the "pending owner run" rows in
   `docs/platform-notes.md`. Then delete the project.
