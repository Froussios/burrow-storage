# The shared store: Firestore on the Spark plan

> **Best effort, AI-generated.** An AI assistant wrote this guide from the repository's code and
> scripts. The rules and the adapter are covered by tests against the Firestore emulator. The setup
> steps, console paths, costs and quotas have not been verified end to end against a fresh Firebase
> project, and `npx burrow-setup firestore --run` has never been run end to end. Check each step
> against the [Firebase documentation](https://firebase.google.com/docs/firestore) before you rely
> on it, and please report what you find.

Burrow's reference backend is one Firestore collection in one Firebase project on the free Spark
plan. You create it once and reuse it for every prototype. It is chosen because it needs no card,
has hard daily quotas instead of a meter (so abuse can pause sync but never produce a bill),
accepts unauthenticated requests gated by security rules, and its rules language can evaluate
SHA-256, which is all the write chain needs.

## Create the project

```sh
npx burrow-setup firestore
```

prints the steps. To have them performed with `gcloud` and the Firebase CLI (two browser sign-ins,
bash, and a project id nobody else has taken):

```sh
PROJECT=my-burrow-store LOCATION=us-central1 REFERRERS="https://you.github.io/*,http://localhost:*" \
  npx burrow-setup firestore --run
```

`REFERRERS` defaults to localhost only and `APP_NAME` to `burrow`. Before the first npm release,
run the same commands from a clone as `node scripts/burrow-setup.mjs firestore`. By hand:

1. **Create a Firebase project without a billing account**, Google Analytics off. Do not upgrade
   to Blaze.
2. **Create Firestore in production mode.** Pick a location near your users; it cannot change.
3. **Register a web app** (Project settings → Your apps → Web). Keep three values from its
   config: `apiKey`, `projectId`, `appId`.
4. **Deploy the bundled rules.** From the package's `firebase/` folder (`node_modules/burrow-storage/firebase`,
   or the repository):

   ```sh
   npx firebase-tools login
   npx firebase-tools deploy --only firestore:rules --project <your-project-id>
   ```

5. **Restrict the browser API key** in the Google Cloud console (APIs & Services → Credentials →
   "Browser key (auto created by Firebase)"): API restrictions to *Cloud Firestore API* only;
   application restrictions to your domains (`https://you.github.io/*`, `http://localhost:*`).
   The key is an identifier, not a secret, and will sit in page source. The referrer restriction
   stops other websites from using it in their pages; it does not stop a script outside a browser,
   which can send any referrer it likes. A page opened from `file://` has no web origin to match a
   referrer restriction, so during development serve it from `http://localhost`.
6. Leave Authentication, Storage, Functions and Blaze off. Burrow needs none of them.

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

## Local development with the emulator

```sh
npm run test:rules       # rules matrix
npm run test:firestore   # backend conformance suite
npm run test:e2e         # browser tests; the demo is served pointed at the emulator
```

`scripts/emulator.mjs` runs any command under `firebase emulators:exec` and exports
`FIRESTORE_EMULATOR_HOST` to it; `scripts/serve.mjs` then injects `emulator` into the demo's
config and widens its CSP. Needs Java 21. Set `BURROW_EMULATOR_PORT` if 8080 is taken.
