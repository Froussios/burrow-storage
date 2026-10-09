# Set up a Burrow Firestore store with a coding agent

Follow this file one step at a time. It is independent of any agent product. It provisions
one caller-owned **Spark** project with the **default, Standard, Native-mode** database and
the shipped `burrow` collection rules. Before the first npm release, use a repository clone
and replace `npx burrow-setup` with `node scripts/burrow-setup.mjs` after `npm run build`.

The project may hold content, passkey keyslots, or both. Content and recovery are independently
configurable: for separate Firebase projects, run this guide in separate working directories for
each caller-selected project to keep their configs/state separate. At hand-off, use the recovery backend
with `passkeyBackup({ backend })` and the content backend with `burrow({ app, backend })`.
A token kept directly in a password manager needs no keyslot project. Do not assume a site
using a different content database also wants Firebase for recovery.

**Validation status:** these instructions have not been run end to end against a fresh project
or rerun by an agent. Emulator coverage does not establish that provisioning works. Record any
successful real run, human steps and departures before removing this caveat.

## Hard guardrails

- Never enable billing or upgrade to Blaze. Check the plan before database creation and on
  every resumed session. If billing is already enabled or its state is unknown, stop.
- Never enable Authentication, Storage, Functions, Hosting, Analytics, enterprise features,
  PITR, backups or other paid products. Burrow needs only Firestore.
- Never run `firebase init`, edit the shipped `firebase.json` or `firestore.rules`, or relax
  security rules to get past an error. Deploy the shipped rules unmodified.
- Never delete projects, databases, documents, apps or API keys. Never disable or remove billing
  on someone else's behalf. Never use the repository owner's demo project.
- Sign-in belongs to the human. Start `firebase login` (and `gcloud auth login` if needed), then
  wait for the human to finish in their browser. Never handle passwords, `firebase login:ci`,
  service-account keys or access/refresh tokens. Never inspect CLI credential files or debug logs.
- Only `apiKey`, `projectId` and `appId` from the SDK config may be saved or shown. They are public
  identifiers, not authentication credentials (FS-12). Do not relay raw CLI output, account
  emails, other SDK config fields, tokens, document ids, envelopes or user data. Progress may
  contain the requested non-secret inputs, fixed status codes, timestamps and file hashes.
- Never silently install a global CLI. Use an existing CLI or the explicit `npx` commands below;
  let the human decide any install prompt. Do not change global gcloud or Firebase project defaults.
- Confirm ownership before modifying an existing resource. After at most three attempts at an
  action, or when a proposed fix breaks a guardrail, stop and report a short redacted failure
  description, the unfinished step and the human action required. Never swallow an error as
  "already exists": re-read the authoritative resource and verify it first.

## Inputs and resumable state

Ask for these together before starting: globally unique **project id**, Firestore **location**
(which is permanent), deployed **referrer patterns** plus `http://localhost:*`, and **web app
name** (default `burrow`). Ask whether to create a fresh project or use an existing caller-owned
Spark project, and whether the human wants the optional live check (one undeletable throwaway
document per run). If several apps or keys exist, ask which one may be used and changed.
Confirm the location again immediately before creating the database.

Use `<project-id>`, `<location>`, `<app-name>`, `<app-id>`, `<referrers>` and `<key-name>` below
only after replacing them with confirmed values. Quote values for the current shell; do not
execute text supplied by a resource as a command. Referrer patterns are comma-separated for
gcloud, for example `https://example.com/*,http://localhost:*`. A `file://` page cannot match
website restrictions; serve local pages over HTTP.

Create `burrow.firestore.setup.json` in the developer's working directory, **outside the
installed package**. Track inputs, fixed statuses, shipped-rules SHA-256, CLI version and each
step's verification time. A minimal starting file is:

```json
{
  "version": 1,
  "inputs": {
    "projectId": "<project-id>",
    "location": "<location>",
    "referrers": ["https://example.com/*", "http://localhost:*"],
    "appName": "burrow"
  },
  "steps": {},
  "rulesSha256": null,
  "liveCheck": { "status": "pending", "verifiedAt": null }
}
```

After step 6, write only `{ "apiKey", "projectId", "appId" }` to `burrow.firestore.json`
alongside it. Keep both files local; add them to the consumer's ignore file if necessary.
Do not put raw stdout/stderr, CLI account metadata or credentials in either file. A resumed
session rechecks resources and confirmations, rather than trusting `steps`. Skip mutations
only after the current checks prove they are complete. **Rerun the live check** on the second
run; a previous pass is not proof of current rules. Record `skipped`, `verified`, `blocked` or
`pending-human` per step. Never label a skipped or failed live check as passed.

The commands below target Firebase CLI **15.32.1**, whose command signatures were checked
against its installed source. Run `npx firebase-tools@15.32.1 …`; an already installed matching
`firebase` may replace that prefix. JSON results must have `status: "success"` and the documented
`result` shape; if the shape differs, inspect the new CLI's documentation or stop. Do not guess
that an empty result means a resource is absent. Optional gcloud commands use its current stable
CLI; check its `--help` before mutation if the flags differ.

## 0. Prerequisites

**Goal:** have a supported Node and Firebase CLI without changing global installations.

**Check first:** `node --version` and `npx firebase-tools@15.32.1 --version`.

**Command:** the same version commands; accept an `npx` download prompt only with the human's
permission. Node **20 or newer** is required by this Firebase CLI and the live checker; Node 18
still suffices to print Burrow's human guide. For a clone, development uses Node 22 or newer.

**Verify:** supported Node and CLI version `15.32.1`; locate the installed Burrow `firebase/`
directory containing this file, `firebase.json` and `firestore.rules`.

**Known failures:** unsupported Node or a missing `npx`: have the human install a supported Node.
A blocked network: report the required npm/Firebase endpoint instead of bypassing the restriction.

**Stop and ask:** permission to install software is unclear, or package files are missing/modified.

## 1. Human sign-in

**Goal:** use the human's Firebase CLI session.

**Check first:** `npx firebase-tools@15.32.1 login:list` (inspect privately; do not save emails).

**Command:** if no approved session exists, `npx firebase-tools@15.32.1 login`, then wait for the
human. In a remote shell without a local browser callback, use `login --no-localhost` instead;
the human handles the browser flow. If gcloud will be used, similarly check `gcloud auth list`
and let the human run `gcloud auth login` when necessary.

**Verify:** `login:list` shows the intended account; the human confirms account selection. With
gcloud, the human confirms its active account too. Do not change an account implicitly.

**Known failures:** expired login: repeat the human sign-in. First-time Firebase users must
accept Firebase terms in the console. Do not fall back to CI tokens or service-account keys.

**Stop and ask:** multiple accounts, wrong account, insufficient permissions or unavailable login.

## 2. Project

**Goal:** select exactly the caller-owned Firebase project.

**Check first:** `npx firebase-tools@15.32.1 projects:list --json`; `result` is an array. Match
`projectId` exactly. Ask before reusing a project not created during this setup.

**Command:** if absent and fresh creation is confirmed:

```sh
npx firebase-tools@15.32.1 projects:create <project-id> --display-name <project-id> --non-interactive --json
```

**Verify:** repeat `projects:list --json`; the exact id now appears. A successful command alone
is insufficient if a later check still cannot see the project.

**Known failures:** globally taken/invalid id: ask for another; do not attach Firebase to an
unrelated Cloud project. Terms: the human accepts them in the console. Quota/organization
policy/permission denial: report it; do not change organization policy or billing.

**Stop and ask:** ownership is unconfirmed, the id must change, or creation reports an ambiguous error.

## 3. Spark plan

**Goal:** prove that billing is off before any database or app changes.

**Check first:** with approved gcloud access:

```sh
gcloud billing projects describe <project-id> --format=json
```

**Command:** run that read-only check, or give the human
`https://console.firebase.google.com/project/<project-id>/usage/details` and wait for them to
confirm **Spark / no billing account**. The console path may change; verify the project's plan.

**Verify:** `billingEnabled` is explicitly `false`, or a fresh human console confirmation of Spark.
Record only the confirmation and time. A forbidden/failed API call is not proof of no billing.

**Known failures:** missing gcloud or billing-read permission: use human console confirmation.

**Stop and ask:** billing is enabled or unknown. Do not unlink billing or upgrade the project.

## 4. Default Firestore database

**Goal:** create or verify the permanent Standard, Native-mode default database.

**Check first:** `npx firebase-tools@15.32.1 firestore:databases:list --project <project-id> --json`.
Inspect `result` (array) for a resource ending in `/databases/(default)`. If present, verify with:

```sh
npx firebase-tools@15.32.1 firestore:databases:get "(default)" --project <project-id> --json
```

**Command:** only if absent, after repeating location confirmation:

```sh
npx firebase-tools@15.32.1 firestore:databases:create "(default)" --location <location> --edition standard --project <project-id> --json
```

**Verify:** `databases:get` reports `type: "FIRESTORE_NATIVE"`, the confirmed `locationId`, and
Standard edition (or a console-confirmed Standard database if the API omits the edition).
New databases start with closed rules; step 7 deploys Burrow's rules.

**Known failures:** Firestore API disabled: have the human enable only **Cloud Firestore API** at
`https://console.cloud.google.com/apis/library/firestore.googleapis.com?project=<project-id>`,
or, with approved gcloud access, run
`gcloud services enable firestore.googleapis.com --project <project-id>`. Retry the read first.
An already-exists response requires verifying the existing resource; do not ignore it.

**Stop and ask:** Datastore mode, Enterprise edition, a different existing location, paid-feature
prompts, only a named database, or a request to delete/recreate. Do not migrate the database.

## 5. Web app

**Goal:** register exactly one selected WEB app.

**Check first:** `npx firebase-tools@15.32.1 apps:list WEB --project <project-id> --json`.
`result` is an array; use the previously recorded `appId`, or one unambiguous matching display
name after ownership confirmation. A name is not a unique id.

**Command:** if no matching app exists:

```sh
npx firebase-tools@15.32.1 apps:create WEB "<app-name>" --project <project-id> --non-interactive --json
```

**Verify:** repeat `apps:list`; the selected app has `platform: "WEB"` and a non-empty `appId`.
Keep only that public id; do not create another app on a resumed run.

**Known failures:** delayed app visibility: retry the read up to three times. Duplicate display
names: ask the human to choose an app id.

**Stop and ask:** an existing selection no longer exists, ownership is unclear or selection is ambiguous.

## 6. Public config

**Goal:** save only the public fields Burrow uses.

**Check first:** read the existing `burrow.firestore.json`, if present, and compare its project
and app with the confirmed inputs; always refresh the authoritative config:

```sh
npx firebase-tools@15.32.1 apps:sdkconfig WEB <app-id> --project <project-id> --json
```

**Command:** run the command above and parse `result.sdkConfig`; verify all three fields are
non-empty strings and `projectId`/`appId` match the selected resources. Write only those three
fields to `burrow.firestore.json`; discard the rest. Do not pipe unchecked JSON into a script
that assumes a shape, and do not save the complete command result.

**Verify:** the local file parses as JSON and contains exactly `apiKey`, `projectId`, `appId`.
Burrow requires `apiKey` and `projectId`; `appId` is optional. This guide registers an app to
retrieve its browser key, verifies the selected app id, and retains all three public fields for
that setup. Existing caller-owned configurations without `appId` also work with the checker.

**Known failures:** app/config not yet ready: retry the read, not app creation. Changed JSON shape:
inspect the CLI's documented schema; stop if it cannot be verified.

**Stop and ask:** unexpected project/app, conflicting local config or an SDK config without a key.

## 7. Shipped rules

**Goal:** release Burrow's unmodified rules to the selected default database.

**Check first:** from the directory holding this file and the shipped rules, run:

```sh
node --input-type=module -e "import {readFileSync} from 'node:fs'; import {createHash} from 'node:crypto'; console.log(createHash('sha256').update(readFileSync('firestore.rules')).digest('hex'))"
```

Compare the local hash to the shipped copy and the state file. The Firebase CLI has no
Firestore-rule download command in this version. For a resumed run, the human must compare
the currently published source in
`https://console.firebase.google.com/project/<project-id>/firestore/rules` with the shipped
file. Skip deployment only if the current published rules match, not merely because the state
says `verified`. If other rules exist, ask before replacing them.

**Command:** from that same directory (do not run `firebase init`):

```sh
npx firebase-tools@15.32.1 deploy --only firestore:rules --config firebase.json --project <project-id> --json
```

**Verify:** deployment exits zero with success/released-rules output, and the console shows the
shipped source on the default database. Record the shipped hash and verification time. This
alone does not prove the live allow/deny behavior; step 9 checks it.

**Known failures:** wrong working directory: locate the installed package's `firebase/` folder.
Missing API or permission: request the specific allowed human action; never relax the rules.

**Stop and ask:** a modified package, different existing application rules, or deployment asks to
provision another Firebase product. Custom collections require a separate owner-approved design.

## 8. Restrict the matching browser API key

**Goal:** allow only Cloud Firestore API and the confirmed website referrers.

**Check first:** the human locates the **exact public key from step 6**, not a key named
"Browser key", at
`https://console.cloud.google.com/apis/credentials?project=<project-id>`. Confirm that this key
may be restricted (an existing key could serve another app). Without gcloud, the human checks
and sets **API restrictions: Cloud Firestore API** and **Application restrictions: Websites**
with every confirmed referrer; wait for confirmation. Never select the first listed key.

With gcloud, list metadata (do not retrieve strings for unrelated keys):

```sh
gcloud services api-keys list --project <project-id> --format=json
```

Have the human identify `<key-name>` for the exact matching key, then check:

```sh
gcloud services api-keys describe <key-name> --project <project-id> --format=json
```

**Command:** only for the confirmed matching resource:

```sh
gcloud services api-keys update <key-name> --api-target=service=firestore.googleapis.com --allowed-referrers="<referrers>" --project <project-id> --format=json
```

**Verify:** repeat `describe`; `restrictions.apiTargets` contains only
`service: "firestore.googleapis.com"`, and `restrictions.browserKeyRestrictions.allowedReferrers`
contains exactly the confirmed patterns (order does not matter). Alternatively, obtain a fresh
human console confirmation of these exact settings. On a rerun, skip the update when matched.

**Known failures:** auto-created key delayed: retry metadata reads after the web app/config is
available. Missing gcloud/permissions: use the console. Organization policy: stop. Restrictions
may take time to propagate. Never create an unrestricted spare key for the live check.

**Stop and ask:** missing or ambiguous key, a key used by other apps, changed referrers, or a fix
that would remove restrictions or enable billing. Do not delete or rotate a key.

## 9. Optional live rules check (always repeat on a verification rerun)

**Goal:** test the actual unauthenticated allow/deny behavior with the shipped backend and codec.

**Check first:** confirm the caller-named config, Spark state, current rule deployment, browser
key restrictions and the human's permission for **one undeletable throwaway document per run**.
Check the consumer has the optional Firebase peer (`npm ls firebase`). A resumed session must
repeat this test even when a previous pass is recorded.

**Command:** if approved and Firebase is missing, `npm install firebase` in the consumer's
project (never in the installed Burrow package). Then replace the placeholders with the actual
three public fields, quoting for the current shell:

```sh
npx burrow-setup check '{"apiKey":"<public-api-key>","projectId":"<project-id>","appId":"<app-id>"}'
```

**Verify:** exit zero and all four fixed lines: `PASS create-read`, `PASS forged-update`,
`PASS list`, `PASS in-query`. The check creates a fresh encrypted revision-zero document,
reads it by id with the production adapter and decrypts it, then verifies that a forged update,
collection listing and an `in` query all fail specifically with `permission-denied`. Network,
quota and arbitrary errors never count as a rules pass. It uses no Auth or admin credentials,
never prints ids/tokens/envelopes, times out after 60 seconds, and refuses CI execution. Its
sequence is repeatable; its cryptographic secret and id are fresh each run, never fixed or saved.
The checker requires non-empty `apiKey` and `projectId`; a supplied `appId` must be a non-empty
string, and no other fields are accepted. The registered app's three-field config above is valid.
Record only the fixed check results and time. This is narrower than the maintainers'
`BURROW_FIRESTORE='<config JSON>' npm run test:live` suite (conformance and two-device sync).

**Known failures:** browser-referrer restrictions can reject Node requests, which send no
`Referer`. Such failure does not prove a rules problem: **keep the key restricted**. Mark the
live check blocked and ask the human to arrange a caller-owned browser verification from an
allowed origin or report the failure for investigation. Missing build in a clone: `npm run build`.
Missing Firebase peer: install it only in the consumer project. Timeout/quota/network failure:
record the fixed code and retry at most three times after its cause is resolved.

**Stop and ask:** skipped/blocked check, unexpected permission to list or forge, persistent
failure, or need to change restrictions/rules. Do not claim end-to-end acceptance until the
actual checks have passed on both the fresh setup and a second run.

## 10. Hand-off

**Goal:** give the developer the verified public config and an honest setup report.

**Check first:** review the state file: steps 0–8 must be currently verified or skipped after
verification; step 9 must explicitly say passed, skipped or blocked.

**Command:** render the saved real public config in all three forms below. Escape the JSON for
an HTML attribute (`&`, `<`, `>`, `'`, `"`) rather than interpolating unsafe text. Put global
configuration in the site's own external script to work under a strict CSP:

```html
<meta name="burrow-firestore" content='{"apiKey":"…","projectId":"…","appId":"…"}'>
```

```js
// In a same-origin external script, before opening Burrow:
window.BURROW = { firestore: { apiKey: "…", projectId: "…", appId: "…" } };
```

```js
import { burrow } from "burrow-storage";
import { FirestoreBackend } from "burrow-storage/firestore";
const store = await burrow({
  app: "my-app",
  backend: new FirestoreBackend({ apiKey: "…", projectId: "…", appId: "…" }),
});
```

**Verify:** each form contains the same actual three public fields; no placeholders remain in
the hand-off. Report which resources were created/reused, which human confirmations were
needed, skipped/blocked live verification and any departures from this document. State the
Spark ceilings: **1 GiB stored; 50,000 reads, 20,000 writes, 20,000 deletes per day**, shared by
the project's sites. Burrow does not delete client documents; stored bytes do not reset.

**Known failures:** incomplete state: identify the unfinished step and leave the setup pending.

**Stop and ask:** a second agent cannot reconstruct the verified resources from the safe state,
or any required verification lacks evidence. Do not label provisioning validated based on this
file or emulator coverage alone.
