# Content retention and renewal

A store operator may enable inactivity cleanup with the optional `burrow-reaper` tool. Burrow
renews content when the app is used, but does not promise that every store runs cleanup or that
all data disappears after a year. The operator must publish their retention policy to the app's
users. This policy concerns **content**, independently of the store selected for token access
(D-48, D-50).

## Client use renews content

Opening an app, reading or writing its storage, using the synchronous facade, or calling
`syncNow()` can request renewal when this device's last complete renewal is due. Requests
coalesce per app/device. After a complete pass, the cache records a deadline 29–30 days later
(the bounded jitter avoids synchronized requests). Already-open tabs consult the shared receipt
under the sync lock; reloads retain it. A token switch resets ownership of that receipt. Polls
and subscriptions alone do not schedule a new renewal after a successful receipt.

A due pass fetches every item still listed in the manifest, including retained deletion markers,
then rewrites those items before rewriting the manifest. It preserves values, logical `ts`,
tie-break hashes and deletion state. Normal 30-day pruning of logical deletion markers from the
manifest still applies; it does not delete their remote documents. Documents no longer listed
are not enumerated or renewed. Ordinary writes also update their document's server write time.
A failed pass records no renewal success. Retries may repeat earlier successful item writes.
If a listed live document is missing and this device has no cached copy, renewal cannot
reconstruct its ciphertext: the pass reports a backend availability failure and keeps the
directory and receipt unchanged. Repeated retries cannot repair that condition without another
copy or operator restoration. It does not drop the key or claim a complete renewal.

This uses the existing authenticated write-token chain. It increases read/write costs about
once a month **per app and device in use**: one read and write per listed item plus the manifest,
with extra reads on conflicts. Multiple devices renew independently, so monthly cost scales
with devices times listed items; tabs sharing one device cache coalesce. The client's clock
controls scheduling only; it is not trusted for cleanup
eligibility. Offline or clock-skewed devices may miss a renewal, and the operator's cleanup
schedule and the 395-day horizon provide no availability guarantee.

## Expiry preserves local data

An operator replaces an eligible document with a permanent minimal stub:

```ts
interface ExpiredStub { x: true; rev: number; next: string }
```

The id stays occupied; the latest revision and next-token commitment remain. Ciphertext and
all other envelope fields are removed. This prevents creating over the id or replaying the same
or an older revision. It is an inactivity policy: a legitimate token holder can still authorize
a new revision. The encrypted v1 envelope, its AAD, salts and token encoding have not changed.

`Backend.get()`, `getMany()` and `subscribe()` return a distinct stub, including a notification
whose revision is unchanged. A normal `put()` atomically rejects `BackendError("expired")` if
it encounters a stub, even after a client previously read/cached its revision. Only an explicit
`put(..., { replaceExpired: true })` opts into replacing it; normal revision and token-chain
checks still apply. This low-level opt-in is not an automatic restore or a high-level republish
API. Older clients may ignore the flag and decrypt-fail, or authenticated writes may revive the
stub. Before using `--apply`, deploy expiry-aware builds implementing D-48's distinct stub reads
and atomic ordinary-put refusal to clients that write this store. Published 0.1.1 predates that
behavior; this PR's source package version is not proof of a deployed expiry-aware build. Verify
the deployed bundle/commit. The rules still permit legitimate writes from older token holders,
so client rollout cannot enforce this gate against an uncontrolled old client.

The core reports `onStatus` with `status: "error"` and `BurrowError("expired")` and pauses remote
work. Local reads and writes keep working. It detects expiry before decryption or applying that
pass's remote merges/pruning, and clears dirty flags only after manifest publication succeeds.
A fresh single-item read returns the cached value while reporting expiry. Item and manifest
expiry are independent; an expired item can stop a pass whose manifest is still live. Some
independent item writes may already have committed before a later item/manifest expires; there
is no cross-document transaction or rollback. Cached values and unsynced writes remain intact,
and no full-success receipt is recorded.

Export local data/JSON and keep the storage token before choosing a fresh identity. Existing
`link()`/`unlink()` rules still reject orphaning dirty writes unless `discardLocal: true` is
explicit. Linking the same expired token merely retries and pauses again while a stub remains.
The backend does not migrate identities or recover tokens after loss of authenticating
credentials.

## Token-access data is excluded

Passkey keyslots contain the encrypted storage token. Keeping only `rev`/`next` would destroy
access to that token even with a working authenticator. Keep the **full token-access payload**
outside cleanup. `passkeyBackup().restore()` remains read-only; repeated `save()` creates a new
credential and slot and can replace the previous credential (D-47). Neither is an existing-slot
renewal. Core does not contact, enumerate or manage the independently selected token backend.

An opaque mixed collection cannot identify content versus keyslots. Choose a dedicated content
collection/project when configuring content and token access. The reaper requires
`--content-only` as the operator's explicit acknowledgment and refuses `--mixed` or a missing
acknowledgment. It cannot verify that acknowledgment from encrypted data; do not use it on a
mixed collection, on the token-access collection, or on the default collection until you have
verified that it contains content only. The client adapter's current database is `(default)`.

## Optional owner cleanup

The tool uses ordinary Firestore REST reads/writes and an owner-supplied short-lived OAuth
access token with permission to list/update the selected database. The public browser API key
is insufficient. Run outside CI; never grant admin credentials to the page. The tool reads no
credential files and has no default project, database or collection. Install the package or
run `node scripts/burrow-reaper.mjs` from its checkout.

```sh
# Set BURROW_FIRESTORE_ADMIN_TOKEN securely in this process; do not paste it in an issue.
burrow-reaper --project YOUR-PROJECT --database '(default)' --collection CONTENT \
  --content-only --state /private/path/reaper-cache.json
# Inspect aggregate counts, then use the same selection/cache with --apply to write stubs.
```

Dry-run is the default. `--apply` enables rewriting. `--page-size` (1–100, default 100),
`--max-reads` (1–50,000, default 10,000) and `--max-writes` (0–20,000, default 1,000) bound this
operator's requests per project/day across invocations sharing the cache. Every request reserves
its worst-case reads or attempted write **before** the request, even when it fails. Resets use
midnight Pacific time, including DST, like Firestore's free quota. Permanent stubs count toward
scans. Unused reservations are deliberately not refunded.

Use the **same private cache file** for all targets, dry-runs, reruns and processes in a project.
The default is `.burrow-reaper-cache.json` in the current directory; a stable explicit path is
recommended. This file holds aggregate quota reservations and opaque pagination cursors, not
user values. It is mode 0600 and must not be logged, published or committed. A lock refuses
simultaneous runs; after a crash, first ensure no run remains active before removing its stale
`.lock`. Preserve the cache across invocations; deleting it or using multiple cache files
resets/bypasses this operator's budget. The tool cannot account for unrelated clients or other
operators' traffic. Leave budget for the app and monitor your project. An interrupted page
retains its cursor; the next run resumes after quota becomes available. Dry-run/apply have
separate cursors but share quota reservations. Completed scans restart from the beginning.

A server pagination token can become unusable. If a stored cursor keeps producing
`request-failed`, rerun the same target/cache with `--reset-cursor` (and `--apply` if that was
the affected mode). It restarts only that target/mode's scan under the cache lock and preserves
all project/day reservations and other scan cursors. It may revisit earlier pages and consumes
the remaining read/write budget normally; exhausted quota still stops the run. Use the flag
for that one recovery run, then remove it from subsequent commands. Never leave it in a cron
job or other schedule: each invocation restarts the scan, so earlier pages can consume the
budget repeatedly while later documents remain unvisited. Do not delete or edit the private
cache to recover a cursor, and do not paste its contents into logs/issues.

For each non-stub document the tool uses the server's output-only `updateTime`, refusing missing
or invalid timestamps. Only documents at least **395 days** old are eligible. Envelope `ts`,
client reads and client-supplied timestamp fields have no effect. The document mask reads only
`x`, `rev`, `next` plus server metadata. A whole-document replacement carries the exact observed
`currentDocument.updateTime` precondition. A concurrent write wins or the stub wins; a stale
precondition is skipped without a blind retry. Malformed metadata is counted as refused.
Output contains counts and fixed error codes, never ids, tokens, payloads or server messages.

No Firestore TTL policy or billing change is enabled. TTL requires paid billing and has no free
usage allowance. Ordinary scans/writes still consume quota; permanent stubs and token-access
payloads still consume storage/index overhead, and scanning costs grow. Cleanup shrinks old
ciphertext but does not solve ongoing junk writes, id squatting, permanent stub storage or the
1 GiB limit. It cannot recover already erased ciphertext.

Local validation uses only synthetic data and caller-named emulator projects. For local runs,
`FIRESTORE_EMULATOR_HOST=127.0.0.1:PORT` selects that emulator explicitly, still requiring the
project/database/collection/content-only flags. It never falls back to the owner's live project.

Primary references: [Firestore server document timestamps](https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents#Document),
[exact updateTime preconditions](https://firebase.google.com/docs/firestore/reference/rest/v1/Precondition),
[listing and masks](https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents/list),
[free quota](https://firebase.google.com/docs/firestore/quotas#free-quota),
[TTL pricing](https://firebase.google.com/docs/firestore/ttl#ttl_deletion).
