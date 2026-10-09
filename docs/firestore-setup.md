# The shared store: Firestore on the Spark plan

> **Best effort, AI-generated.** An AI assistant wrote this guide from the repository's code and
> scripts. The rules and the adapter are covered by tests against the Firestore emulator. The setup
> steps, console paths, costs and quotas have not been verified end to end against a fresh Firebase
> project. The agent guide has never been run end to end or rerun against the same project. Check each step
> against the [Firebase documentation](https://firebase.google.com/docs/firestore) before you rely
> on it, and please report what you find.

Burrow's reference backend is one Firestore collection in one Firebase project on the free Spark
plan. You create it once and reuse it for every prototype. It is chosen because it needs no card,
has hard daily quotas instead of a meter (so abuse can pause sync but never produce a bill),
accepts unauthenticated requests gated by security rules, and its rules language can evaluate
SHA-256, which is all the write chain needs.

For separate content and keyslot projects, deploy the shipped `firebase/firestore.rules`
unmodified in both projects; keyslots use the same `burrow` collection and write-token rules.
See
[independent configuration](extending.md#independent-token-and-content-storage).

## Create the project

Follow the steps below by hand, or have a coding agent perform them with the shipped
[agent instructions](../firebase/SETUP-AGENT.md):

> Follow `node_modules/burrow-storage/firebase/SETUP-AGENT.md` to set up a Burrow store.

The agent confirms your project id, permanent location, referrers and app name, checks resources
before creating them and records safe resumable state. Sign-in belongs to you; optional gcloud
commands have console fallbacks. It deploys the shipped rules unmodified and never enables
billing, Auth, Storage, Functions or Hosting. By hand:

1. **Create a Firebase project without a billing account**, Google Analytics off. Do not upgrade
   to Blaze.
2. **Create Firestore in production mode.** Pick a location near your users; it cannot change.
3. **Register a web app** (Project settings → Your apps → Web). Keep `apiKey` and `projectId`
   from its config; `appId` is optional for Burrow.
4. **Deploy the bundled rules.** From the package's `firebase/` folder (`node_modules/burrow-storage/firebase`,
   or the repository):

   ```sh
   npx firebase-tools login
   npx firebase-tools deploy --only firestore:rules --project <your-project-id>
   ```

5. **Restrict the browser API key** in the Google Cloud console (APIs & Services → Credentials →
   the key matching the `apiKey` from your web app config, rather than a display name): API restrictions to *Cloud Firestore API* only;
   application restrictions to your domains (`https://you.github.io/*`, `http://localhost:*`).
   The key is an identifier, not a secret, and will sit in page source. The referrer restriction
   stops other websites from using it in their pages; it does not stop a script outside a browser,
   which can send any referrer it likes. A page opened from `file://` has no web origin to match a
   referrer restriction, so during development serve it from `http://localhost`.
6. Leave Authentication, Storage, Functions, Hosting and Blaze off. Burrow needs none of them.
7. **Optionally check your own live rules** (Node 20 or newer, optional Firebase peer installed):

   ```sh
   npx burrow-setup check '{"apiKey":"…","projectId":"your-project-id","appId":"…"}'
   ```

   The checker requires non-empty `apiKey` and `projectId`; `appId` is optional but must be a
   non-empty string if supplied. It accepts only those public fields and targets the shipped
   `burrow` collection rules. This packaged check uses the shipped backend and codec. It writes one throwaway encrypted
   document that cannot be deleted through the client rules (FS-6), reads and decrypts it by
   id, then verifies that a forged token, collection listing and an `in` query are rejected.
   All four fixed `PASS` lines and a zero exit status are required; a network or quota error
   never counts as a rules pass. It prints no document ids, tokens or envelopes, refuses CI,
   and stops after 60 seconds. The config must name your project; it has no default. The
   [agent guide, step 9](../firebase/SETUP-AGENT.md#9-optional-live-rules-check-always-repeat-on-a-verification-rerun)
   explains consent, failure handling and rerun evidence.

   Maintainers can also run the broader conformance and two-device sync suite from a clone
   with development dependencies installed:

   ```sh
   BURROW_FIRESTORE='{"apiKey":"…","projectId":"your-project-id","appId":"…"}' npm run test:live
   ```

   This suite is never run in CI. Missing, empty or invalid JSON config exits non-zero before
   contacting Firebase. Each run leaves a few KB of undeletable throwaway documents.

   Neither check verifies Spark vs Blaze, or that Auth, Storage, Functions and Hosting are off;
   check these in the console. Browser-referrer restrictions can block Node checks, which send
   no `Referer`. Keep the key restricted and record a blocked check; do not remove restrictions
   to get a pass. Passing emulator tests does not establish a successful fresh-project setup.

## Put the config on the page

Any one of:

```html
<!-- A: meta tag, no JavaScript -->
<meta name="burrow-firestore" content='{"apiKey":"…","projectId":"…","appId":"…"}'>

<!-- B: a global -->
<script>window.BURROW = { firestore: { apiKey: "…", projectId: "…", appId: "…" } };</script>
```

```js
// C: explicitly, with a bundler
import { burrow } from "burrow-storage";
import { FirestoreBackend } from "burrow-storage/firestore";
const store = await burrow({ app: "my-app", backend: new FirestoreBackend({ apiKey: "…", projectId: "…", appId: "…" }) });
```

With A or B, `burrow()` finds the config and loads the adapter on demand. Script-tag pages load
the Firestore SDK from `burrow-firestore.js` next to `burrow.min.js`, on your own origin;
bundler users import the SDK through the optional `firebase` peer dependency.

The config may also carry `"collection"` (default `burrow`; the rules file names the collection
too, so change both) and, for local development, `"emulator": { "host", "port" }`.

## What the rules enforce

[`firebase/firestore.rules`](../firebase/firestore.rules), on `burrow/{id}`:

| Operation | Rule |
| --- | --- |
| `get` | Allowed to anyone who knows the 43-character id. The content is ciphertext. |
| `list` | Denied. Enumeration is the one thing that would turn ids into a directory. |
| `create` | Allowed at revision 0 with exactly the envelope fields `v, iv, ct, rev, ts, tok, next, z` within their size limits. Ids are unguessable, so a first write at an unused id harms nobody. |
| `update` | Allowed only when `rev` equals the stored `rev + 1` and `SHA-256(tok)` equals the stored `next`. Only the token's holder can compute the next `tok`. |
| `delete` | Denied. Removal is a tombstone in the manifest plus an overwrite of the item. |

The emulator tests in `firebase/tests/rules.test.mjs` cover each row, including an `in` query on
ids and an update that tries to skip the chain. [SECURITY.md](../SECURITY.md) explains the chain.

## Costs and quotas

Spark, per day, shared by every app and user on the project: **50 000 reads, 20 000 writes,
20 000 deletes, 1 GiB stored**. What Burrow spends:

| Operation | Reads | Writes |
| --- | --- | --- |
| A sync pass with nothing new | 1 (the manifest) | 0 |
| The page becoming visible or regaining focus | One sync pass; a focus within five seconds of the last pass costs nothing | 0 |
| Pulling *k* changed items | 1 + *k* | 0 |
| Pushing *n* changed items | *n* + 2, plus 1 for each key this device has not synced before | *n* + 1 |
| Live listener on the manifest | 1 each time it attaches, then 1 per manifest change, this device's own pushes included | 0 |
| Passkey backup: create | 2 | 1 |
| Passkey backup: restore | 1, then a sync pass | 0 |

Pushes cost more reads than writes because the adapter writes through Firestore transactions,
which read the document before writing it. A push reads the manifest twice: once when the pass
pulls, and again inside the transaction that writes it. The listener attaches when the page
loads, and again when it becomes visible after more than five hidden minutes.

Writes are debounced (`debounceMs`, 1.5 s) and coalesced, so a user typing into a draft field costs
one write per pause, not per keystroke. Polling runs every `syncIntervalMs` (30 s) while a tab is
visible: about 120 reads an hour, or 2 900 a day for an always-visible tab. The daily 50 000 reads
therefore cover roughly 400 hours of open, visible tabs across all your sites. Raise the interval,
or set it to 0 and rely on the listener plus the visibility and focus triggers, for sites with
long-lived tabs.

When a ceiling is hit the store answers `resource-exhausted`; Burrow sets `status` to `"offline"`
with `error.code === "quota"`, keeps unsynced writes, and retries with backoff until the daily
reset. Nothing can convert that into a charge while the project stays on Spark.

## Abuse, honestly

Anyone who learns your project id can write to the collection, because a first write at an unused
id is allowed by design. Junk documents look exactly like users' documents. Daily quotas bound the *traffic* they can cause, and the worst outcome is
that sync pauses for your users until midnight Pacific time. **Stored bytes do not reset.** A
determined party could fill the 1 GiB with junk documents, and because the rules forbid deletes,
only the project owner can remove them (from the console, or with the Admin SDK, which bypasses
the rules; delete documents whose `ts` is older than you care about). For prototypes this is an
accepted risk. Burrow has no built-in defence against it today. Firebase App Check would be the
natural hardening, but the adapter creates its own Firebase app instance and does not initialise
App Check, so a site cannot turn it on yet.

Removed keys leave their item documents behind forever, overwritten with a deleted marker and
bounded by the size cap; the manifest forgets them after 30 days.

## Local development

```sh
npm run test:rules       # rules matrix
npm run test:firestore   # backend conformance suite
npm run test:e2e         # browser tests; the demo is served pointed at the emulator
node scripts/emulator.mjs "npm run serve" # start the emulator and local demo (after a build)
```

`scripts/emulator.mjs` runs any command under `firebase emulators:exec` and exports
`FIRESTORE_EMULATOR_HOST` to it. By default, `scripts/serve.mjs` replaces the local demo and
assembled `site/` config with the emulator's, and replaces the live Firestore endpoint in their CSP.
Bare `npm run serve` expects an already-running emulator at `127.0.0.1:8080`, or at
`FIRESTORE_EMULATOR_HOST` if set. It never uses the source page's config as a default.
Starting the emulator needs Java 21; set `BURROW_EMULATOR_PORT` if 8080 is taken.

To run the page locally against your own live or pre-production Firebase project, supply its
public config explicitly in `BURROW_FIRESTORE` and run the server directly after building:

```sh
BURROW_FIRESTORE='{"apiKey":"your-api-key","projectId":"your-project-id"}' npm run serve
```

In PowerShell:

```powershell
$env:BURROW_FIRESTORE = '{"apiKey":"your-api-key","projectId":"your-project-id"}'
npm run serve
```

Open <http://localhost:4173/demo/>. The server replaces both `demo/` and assembled `site/` page
configs with the supplied project and allows `https://firestore.googleapis.com` in their CSP.
`apiKey` and `projectId` must be non-empty strings. `appId` is optional and, when supplied,
must be a non-empty string. An optional non-empty `collection` string selects a collection
whose rules you have configured. Other Firebase SDK config fields
are ignored; omit the `emulator` field. An empty, malformed or incomplete config stops the
server before it listens, without falling back to the source page or the emulator. Validation
checks the config's shape, not whether the project exists or its rules and key restrictions are
correct. Configure the project with the steps above and allow `http://localhost:*` in the
browser key's referrer restrictions. The page writes real documents to the selected project.

Choose one target: `BURROW_FIRESTORE` and a non-empty `FIRESTORE_EMULATOR_HOST` together are an
error. Unset `BURROW_FIRESTORE` to return to the emulator. CI browser and smoke suites continue
to use only the emulator.
