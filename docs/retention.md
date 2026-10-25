# Content retention and renewal

A store operator may enable inactivity cleanup with the optional `burrow-reaper` tool. Burrow
renews content when the app is used, but does not promise that every store runs cleanup or that
all data disappears after a year. The operator must publish their retention policy to the app's
users. This policy concerns **content**: Burrow stores no token record anywhere (D-48, D-58).

## Client use renews content

Renewal belongs to the offline wrapper (`burrow-storage/offline`, D-59), which has somewhere to
keep a deadline. Opening it, reading or writing through it, or calling `syncNow()` requests
renewal when this device's last complete renewal for that app and token is due. Requests
coalesce per app, token and device. After a complete renewal, the local copy records a deadline
29–30 days later (the bounded jitter avoids synchronized requests). Already-open tabs consult the
shared deadline under the sync lock; reloads retain it. Each token's copy has its own deadline.
Subscriptions alone do not schedule a renewal.

**The core alone does not renew.** It keeps nothing on disk, so it has no deadline to keep; its
own writes refresh the server write time of the documents they write, and nothing else. In a
store whose operator runs cleanup, content that a core-only app only reads can expire. Use the
offline wrapper, or write periodically, if that matters.

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
once a month **per app, token and device in use**: one read and write per listed item plus the
manifest, with extra reads on conflicts. Multiple devices renew independently, so monthly cost
scales with devices times listed items; tabs sharing one device's copy coalesce. The client's clock
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

The core rejects the call with `BurrowError("expired")` when it meets a stub, before decrypting
anything. The offline wrapper then reports `onStatus` with `status: "error"` and that error and
pauses remote work for the instance; local reads and writes keep working against its copy, which
it does not change on the way. A named `get()` of an expired key answers from the copy while
reporting expiry. Item and manifest expiry are independent; an expired item can stop a sync
whose manifest is still live. Some independent item writes may already have committed before a
later item/manifest expires; there is no cross-document transaction or rollback. The copy's
values and unsynced writes remain intact, and no renewal success is recorded.

This also applies to retired keys: deletion can be pruned from the manifest after 30 days,
leaving an unlisted item document that the operator may later replace with a stub. The rest
of the account can remain live and renew normally. With the offline wrapper, an ordinary `set()`
on that key keeps the new value locally, but its push encounters the stub and pauses **all**
remote work with `expired`. A named `get()` likewise pauses and returns the local value if
present (or no value if absent). Every local entry and unsynced write stays intact. With the
core alone, the call rejects `expired`. Neither a new
ordinary write nor an older queued write gains replacement authority because the key is
unlisted; the minimal stub no longer has the deletion's logical timestamp/hash. With an
unexpired old document, ordinary sync still compares logical versions, so a newer retained
deletion can defeat an older offline write (D-46). Thirty-day pruning alone does not authorize
replacing an expiry stub.

Read the local data with `get()` and save it, and keep the storage token, before choosing a
fresh identity; then open the fresh token and write the data again. `forget()` refuses to drop
unsynced writes unless `discardLocal: true` is explicit. Opening the same expired token merely
retries and pauses again while a stub remains. The backend does not migrate identities or
recover tokens.

## Only content is stored

Burrow keeps no token-access documents: there are no keyslots (D-58), so a Burrow collection
holds only content. Still point the reaper only at a collection you know holds Burrow content and
nothing else of yours: it cannot classify encrypted data. It requires `--content-only` as the
operator's explicit acknowledgment and refuses `--mixed` or a missing acknowledgment. The client
adapter's current database is `(default)`.

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
usage allowance. Ordinary scans/writes still consume quota; permanent stubs still consume
storage/index overhead, and scanning costs grow. Cleanup shrinks old
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
