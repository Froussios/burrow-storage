# Backend support and candidates

Assessment for [issue #23](https://github.com/Froussios/burrow-storage/issues/23), with service
documentation checked on 2026-10-09 and scope/status updated on 2026-10-10. At the
[owner's direction](https://github.com/Froussios/burrow-storage/issues/23#issuecomment-6093262113),
additional backend implementations are separate backlog issues. This overview records their
status outside #23; it does not certify candidates or provide deployable server code. No paid
resources were created.

## Support status

- **Supported:** an adapter is implemented in this repository. This does not certify every
  deployment's privacy, costs or rules; see the evidence below and the setup guide.
- **Candidate:** a direction to investigate, conditional on the stated design/deployment
  gates. Opening its issue does not select it for implementation.
- **Rejected:** the direct variant fails a requirement as-is. A gateway or different design
  would need separate approval and evidence.
- **Want:** explicitly selected by the repo owner for implementation. **None selected.**
  Feasibility and candidate issue creation do not imply this status.

| Backend or variant | Status | Scope / follow-up |
| --- | --- | --- |
| Firestore | Supported | Reference hosted adapter; caller-owned setup and live rules checks in [Firestore setup](firestore-setup.md). |
| MemoryBackend | Supported | In-memory development/test adapter, not persistent hosted storage. |
| Cloudflare Worker + D1 | Candidate | [#64](https://github.com/Froussios/burrow-storage/issues/64): private D1 binding, conditional SQL and Free Worker limits. |
| Supabase private RPCs | Candidate | [#65](https://github.com/Froussios/burrow-storage/issues/65): private tables, audited grants and chain/CAS RPCs. |
| PocketBase transactional routes | Candidate | [#66](https://github.com/Froussios/burrow-storage/issues/66): conditional on self-hosting acceptance; no bundled Free host. Owner must accept hosting and the route design. |
| Deno KV + chunking/gateway | Candidate | [#67](https://github.com/Froussios/burrow-storage/issues/67): feasibility unproven; prove full-envelope atomic chunking within transaction limits first. |
| Upstash Redis + restricted gateway | Candidate | [#68](https://github.com/Froussios/burrow-storage/issues/68): private credentials and atomic script; verify Free hard stops. |
| Worker + KV alone | Rejected | No required atomic compare-and-set. |
| S3-compatible direct | Rejected | No native SHA-256 chain policy; provider free allowances may bill. |
| Native Deno KV value per envelope | Rejected | 64 KiB values cannot hold the current envelope size. |
| Upstash Redis direct | Rejected | Standard public tokens expose bypass writes/list/delete; read-only tokens cannot sync. |
| Firebase Realtime Database direct | Rejected | No documented SHA-256 rules primitive for the write chain. |

Keep this overview current when a linked follow-up changes: update its status, scope/link and
validation evidence here. Mark Want only with an explicit owner selection, Supported only
after adapter implementation, and retain the limits of any hosted validation.

Generic HTTP is a transport, not a backend selection. Concrete HTTP protocol work belongs in
the chosen backend's issue; it has no separate implementation issue. The five candidate issues
are unassigned backlog. Each requires a concrete proposal to @Froussios and explicit approval
before backend implementation or deployment, including any BE-2 interpretation or requirement
exception. These gates do not keep #23 open once its approved public-use scope is complete.

A candidate must satisfy all of BE-1–BE-7: atomic compare-and-set on the stored revision,
SHA-256 token-chain enforcement, public read by exact id with no listing, no unauthenticated
client deletes, browser access with publishable credentials and CORS, a free plan with hard
caps, and an approximately 1 MiB envelope. Push is optional. The unchanged
`test/conformance/suite.ts` verifies adapter semantics; raw HTTP policy probes must additionally
verify no-list/no-delete and bypass resistance. Local mocks cannot establish hosted policy.

Preserve [independent token and content storage](extending.md#independent-token-and-content-storage)
(D-50). Adapter reports should verify independently configured instances and mixed adapters:
save/restore through one backend, then link and read/write content through another, including
while recovery is unavailable. The requirements below apply to envelope backends, not token
carriers.

Ids are capabilities. Every store needs a primary lookup structure, but no extra secondary
indexes or application logs should retain ids. Whether BE-2 permits that necessary lookup
structure needs owner confirmation in each candidate's issue. Hosted request logs, backups
and operator retention are not fully observable from public documentation. All candidates
have an unresolved privacy gate; use of ids in URL paths also needs a concrete logging audit.
Retention/cleanup policy is separately pending in
[#22](https://github.com/Froussios/burrow-storage/issues/22).

## Requirement matrix

“Possible” means an implementation could provide the property, not that it passed a test.
“Server” means custom trusted code must enforce it. Privacy is unresolved for every hosted
candidate. Polling works when there is no push support.

| Candidate | Atomic revision CAS | SHA-256 chain | Read by id, no list/delete | Browser with public config | Free hard caps | Envelope ≥1 MiB | Push |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Worker + KV alone | **No** | Server, still not atomic | Server | Worker+CORS | Yes, Free only | Yes | No built-in document watch |
| Worker + D1 | Possible, conditional SQL | Worker hash + same SQL condition | Server; private D1 binding | Worker+CORS | Yes, Free only | Yes, 2 MB row | Extra server code |
| Generic HTTP | Server-dependent | Server-dependent | Server-dependent | CORS + public endpoint | Hosting-dependent | Server-dependent | Optional |
| Supabase RPC | Possible, conditional SQL | Database SHA-256 | Private tables + narrow RPCs | Publishable key + API | Free only; behavior needs probes | Possible; verify API payload | Not enabled by ordinary private-table RPCs |
| PocketBase | Possible, custom transaction | Custom hook/route | Rules plus custom route audit | Public routes+CORS | No bundled hosted free tier | Possible; configure body/field limits | Custom access audit required |
| S3-compatible direct | ETag CAS, mapping needed | **No native chain policy** | Possible IAM/bucket policy | Provider-dependent; no public signing secret | Provider-dependent; AWS usage can bill | Yes | No ordinary browser document watch |
| Deno KV | Versionstamp CAS | Server | Server | Deployed gateway | Free-plan terms need quota probes | **No, 64 KiB per value** | Server watch/gateway |
| Upstash Redis direct | Possible, trusted script | No proven public write authority | Standard token fails; read-only cannot write | REST API, restricted token needed | Free-plan quota behavior needs probes | Possible; verify current plan limits | REST pub/sub, access audit needed |
| Firebase Realtime Database | Transactions/conditional REST | **No documented SHA-256 rules primitive** | Child rules can deny parent/list/delete | Public SDK/REST+CORS | Spark only | Yes | Child listeners |

## Cloudflare Worker + KV or D1

[KV is eventually consistent and lacks the required atomic operations](https://developers.cloudflare.com/kv/concepts/how-kv-works/).
A get/check/put sequence can let both concurrent writers succeed, so KV alone is rejected.
The [Free KV limits](https://developers.cloudflare.com/kv/platform/pricing/) stop operations
at quota: 100,000 reads/day, 1,000 writes/day and 1 GB storage. Adding a coordinator changes
this candidate and would require a separate design/conformance review.

D1 is a stronger candidate. A Worker can compute the UTF-8 token SHA-256, then issue one
conditional `UPDATE` comparing id, stored `rev`, stored `next`, and incoming `rev`. A unique
insert arbitrates creates. The hash and revision comparisons must be in the same atomic
statement; reading first and later writing without those predicates is insufficient.
[D1's limits](https://developers.cloudflare.com/d1/platform/limits/) allow 2 MB rows and 500 MB
per Free database. [Free D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
provides 5 million rows read/day, 100,000 written/day and 5 GB total storage, with errors at
quota. [Workers Free](https://developers.cloudflare.com/workers/platform/pricing/) adds
100,000 requests/day and 10 ms CPU/request. JSON processing near the size limit must fit
that CPU budget. Paid plans have overage billing and are outside this proposal.

Setup would require a Free account, a D1 database/schema, a bound Worker exposing only exact-id
read and authenticated-chain writes, CORS, size/error mapping, disabled application/request
logging where configurable, and deployments of both server and adapter. The D1 management
token must never reach a browser. No-list/no-delete applies to the public Worker, not admin SQL.
Conformance: **not run**; no deployment or approved server design exists here.

## Generic HTTP

`GET/PUT /vaults/{id}` with `If-Match` is a transport, not an independent store. The server
must atomically validate the expected revision and chain, handle create races, deny list and
delete, cap envelope size, expose CORS and map errors. Request paths contain ids, so default
access logs and caching must be audited. Nothing in HTTP establishes free hard caps or
privacy. Setup/cost are those of the chosen server and datastore. Conformance: **not run**;
no endpoint exists. An HTTP adapter should follow an approved deployed protocol, not invent
one and describe a mock as backend evidence.

## Supabase

Postgres can enforce CAS with conditional updates/unique creates and
[`pgcrypto.digest(..., 'sha256')`](https://www.postgresql.org/docs/current/pgcrypto.html).
Ordinary public table access can be queried/listed; RLS by itself is not a read-by-id capability
boundary. Keep the table private, revoke direct anonymous table access, and expose narrowly
granted read/write RPCs. A privileged function must pin its search path and validate every
argument; [Supabase's function guide](https://supabase.com/docs/guides/database/functions)
explains grants and RLS bypass. Do not expose a service-role key.

[Publishable keys](https://supabase.com/docs/guides/getting-started/api-keys) support browser
requests without a user login. [The Free plan](https://supabase.com/pricing) includes a 500 MB
database; [Free usage does not bill](https://supabase.com/docs/guides/platform/cost-control).
Quota enforcement/grace periods, pausing, API size limits, logs and Realtime visibility still
need deployed probes. A paid-plan spend cap is not equivalent to a universal zero-bill promise.
Setup would create a Free project, private envelope table, audited RPC grants/schema and
publishable client config, then verify raw access and conformance. Conformance: **not run**;
no approved deployment/configuration exists.

## PocketBase

[PocketBase is a server with SQLite](https://pocketbase.io/docs/), not a hosted hard-capped free
service. Its [rules separate list/view/delete](https://pocketbase.io/docs/api-rules-and-filters/),
but a custom transactional route/hook is needed to prove CAS and SHA-256 validation together.
Configure field/body size to hold envelopes, deny all bypass writes and list/delete routes,
audit subscription access and disable id-bearing logs. Setup requires installing, hosting,
maintaining and backing up that server and configuring HTTPS/CORS. Software is open source;
hosting, storage and egress cost depend on the host. It fails the “no backend of your own”
expectation unless the owner accepts self-hosting. Conformance: **not run**; no instance exists.

## S3-compatible storage

[S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)
compare ETags, not envelope revisions. A client would need a validated revision/ETag mapping,
create-only conditions and race handling. Bucket policy can deny list/delete and require
conditional writes, but cannot compute the envelope token's SHA-256 and validate the chain.
An id-holder could read the ETag and overwrite; `writeAuth: false` is a real capability loss.
[S3 prices](https://aws.amazon.com/s3/pricing/) meter storage/requests/egress; free allowances
are not a lasting hard cap. Other compatible providers need individual verification. Browser
conditional writes also need provider-specific authorization and CORS; never publish account
signing secrets. Setup would configure a bucket, exact policies/CORS and safe authorization.
Conformance: **not run**; this does not satisfy the required authenticated-chain contract.

## Deno KV

[Deno KV](https://docs.deno.com/api/deno/cloud/) has atomic versionstamp checks, but a value is
limited to 64 KiB. The existing item size therefore fails without chunking. Atomic chunking,
partial reads, garbage collection and quota amplification would be a new design requiring
approval. Native database credentials are not publishable browser access: deploy a gateway
that validates the chain and forbids list/delete. [Deploy pricing](https://deno.com/deploy/pricing)
distinguishes Free allowances from paid overages; hard-stop behavior and current plan limits
need confirmation for the selected deployment. Setup would choose a current Free runtime/KV,
implement that gateway and chunk scheme, configure CORS/logging and test the deployment.
Conformance: **not run**; no approved chunking design or deployment exists.

## Upstash Redis

[Upstash REST tokens](https://upstash.com/docs/redis/features/restapi) are either standard
(full command access) or read-only by default. Publishing the standard token exposes
list/delete/unchecked writes; read-only cannot sync. Custom ACL tokens restrict commands and
keys, but no demonstrated policy forces *every* write through the chain/CAS check without
exposing a bypass. A trusted gateway can hold the private write token and run an atomic
script; this adds deployed server code. REST pub/sub exists but its capability isolation must
be audited. [Current pricing](https://upstash.com/pricing/redis) lists a Free plan with 256 MB
storage and 10 GB bandwidth; exact command hard stops and value/request caps need live
verification, and paid usage is excluded. Setup would create a Free database, restrict tokens,
implement the gateway and CORS/log controls, then test raw bypasses. Conformance: **not run**;
no acceptable public write configuration or gateway exists.

## Firebase Realtime Database

Child-path rules can permit exact reads while denying parent reads and deletes, and
conditional writes/transactions can provide CAS. However, the
[documented rules API](https://firebase.google.com/docs/reference/security/database) has no
SHA-256 primitive for validating Burrow's chain. Hash functions in the navigation for the
Firebase Admin SDK do not add a rules-language primitive. Changing the chain or adding a
server is a separate proposal; direct access must declare `writeAuth: false`.
[Limits](https://firebase.google.com/docs/database/usage/limits) permit 10 MB strings and
16 MB SDK writes; [Spark pricing](https://firebase.google.com/pricing) has free quotas while
Blaze meters overages. Setup would create an explicitly Spark database and deploy child rules
and caller config, but that still does not solve chain enforcement. Conformance: **not run**;
rejected as a direct authenticated-chain backend.

## Evidence and remaining backend work

`MemoryBackend` conformance runs with `npm test`. The reference Firestore suite uses the
emulator (`npm run test:firestore`); an actual public Firebase project must separately pass
raw setup checks. Emulator results cannot prove hosted cost, logs or quota behavior.

The existing `test/unit/passkey.test.ts` integration covers token save/restore through an
independent `MemoryBackend`, linking that token to content storage, and continuing content
sync while the token backend is unavailable without further token-backend calls. The Firestore
emulator suite additionally creates two independently configured project instances with the
shipped rules: identical document ids retain distinct envelopes through creates, updates,
`get`, `getMany` and watch delivery. That verifies SDK project routing locally. It is not a
live two-project test; hosted two-project validation has **not been performed**.

No additional candidate has passed conformance or demonstrated every requirement. Backend
selection, BE-2 decisions, implementation and deployed evidence now belong to the linked
candidate issues. #23's approved scope is public configuration/setup, independent token access
and content storage, this external status overview, and backend-scoped follow-ups. Completing
that scope does not select a candidate or certify an additional hosted adapter. Retrieving a
stored token with an available credential is token access. Recovery after losing authenticating
credentials is outside the project's scope.
