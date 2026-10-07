# Platform notes

> **Historical.** These are the WP-00 measurements (issue #2), taken on 2026-10-01 before
> implementation and kept on the unmerged branch `wp-00-spikes` until now. They were made against
> the planned REST adapter; the shipped adapter uses the Firebase SDK with transactions instead
> (docs/decisions.md, D1 and D-21), so the REST error shapes below no longer apply. The rules
> findings (rows 1, 2, 8) and the passkey findings (rows 9–11) still hold; row 11 is the
> `file://` gap in `docs/architecture.md` §13. The harness and raw outputs referred to below
> (`scripts/spikes/`) remain on that branch.

What the platforms Burrow depends on actually do, measured rather than assumed. Each entry says how
and when it was measured. When a finding contradicts `docs/architecture.md`, the architecture is
amended in the same change and the entry says so. Raw outputs live in `scripts/spikes/results/`; the
harness that produced them is `scripts/spikes/` (see its README to re-run or extend).

## WP-00 summary (2026-10-01)

| # | Assumption | Relied on by | Result | Evidence |
|---|---|---|---|---|
| 1 | `hashing.sha256(string)` hashes the UTF-8 bytes; `toHexString()` casing | §9.4 update rule | **Uppercase hex.** UTF-8 confirmed. The rule's `.lower()` is required, not cosmetic | emulator |
| 2 | §9.4 accepts a correct token chain and rejects wrong tokens | ENC-7, §9.4 | Confirmed: correct chain accepted; wrong key, other id's token, skipped rev, replayed rev all `403` | emulator |
| 3 | Requests carrying only `x-goog-api-key` reach rules with `request.auth == null` | BE-5, §9.3 | Confirmed on the emulator. Production: **pending owner run** | emulator |
| 4 | CORS to `firestore.googleapis.com` from an `https://` origin and from `file://` (`Origin: null`) for `GET`/`POST`/`PATCH` with `x-goog-api-key` | NF-1, D1 | Confirmed against production, Chromium 141, on error responses (no real project). Success-path CORS: **pending owner run** | production, browser |
| 5 | Error shapes the adapter classifies | §9.3 | Recorded (table in §2.1). **`PATCH` on a missing document is `403`, not `404`.** Project/key failures are also `403 PERMISSION_DENIED`. `429` not reproducible here | emulator, production |
| 6 | A single-document write and its rules evaluation are atomic (D3, BE-1) | D3 | Confirmed on the emulator: 12 rounds × 10 concurrent `PATCH`es → exactly one winner each time. **Losers get `403` or `409 ABORTED`** | emulator |
| 7 | `PATCH` without `updateMask` replaces the whole document | §9.3, `z` flag | Confirmed: a `z` from the previous revision disappears | emulator |
| 8 | A 1 000 000-character `ct` fits in one document; 1 000 001 is rejected | G3, §5.5 | Confirmed (emulator). Production document-size limit: **pending owner run** | emulator |
| 9 | `create()` returns `prf.results.first`, and it equals the `get()` output for the same salt | §8.2 step 3 | Confirmed on Chromium's virtual authenticator, platform and roaming. Real devices: **not measured** | Chromium |
| 10 | `get()` with empty `allowCredentials` returns the PRF output | §8.2 `recover` | Confirmed (Chromium virtual authenticator) | Chromium |
| 11 | Passkey `available()` is false where passkeys cannot work, so `protect()` falls through (KP-7, NF-1) | §8.2 | **Not as specified:** on `file://` Chromium reports a platform authenticator and PRF support, yet `create()` throws `SecurityError` | Chromium |
| 12 | `file://` is a secure context with WebCrypto, IndexedDB, `BroadcastChannel`, `navigator.locks`, `deflate-raw` | NF-1, §2 | Confirmed on Chromium 141. Firefox and WebKit: **not measured** (not installed here) | Chromium |

Architecture amended as a result: §8.2 (`available()` requires a hostname; notes on PRF at create),
§9.3 (error classification, no `updateMask`), §9.4 (why `.lower()`). Decisions D19, D20.

## 1. Firestore rules: hashing and the write chain

**Setup.** Firestore emulator `cloud-firestore-emulator-v1.22.0` via firebase-tools 15.32.1, Node 22,
rules `scripts/spikes/spike.rules` (§9.4 verbatim plus two spike-only probe collections), requests
over REST with no `Authorization` header.

**Hash casing.** For each sample string the probe submits the lowercase and the uppercase hex
SHA-256 of its UTF-8 bytes; the rule accepts iff `h == hashing.sha256(s).toHexString()`.

| Sample | UTF-8 bytes | lowercase digest | uppercase digest |
|---|---|---|---|
| `abc` | 3 | rejected 403 | **accepted** |
| 43-char base64url token | 43 | rejected 403 | **accepted** |
| `é ünïcødé 🦡` | 19 | rejected 403 | **accepted** |

So `toHexString()` returns uppercase hex of the UTF-8 bytes. §5.4 has clients store `next` as
lowercase hex and §9.4 lowercases the rules-side digest, so the chain works; dropping `.lower()` from
the rule would reject every update. Architecture §9.4 now says so.

**Chain.** Correct chain at revs 0→1→2 accepted; `tok` under another `macKey`, `tok` computed for
another id, a skipped rev, and a replayed rev-1 token all rejected with `403 PERMISSION_DENIED`.

**Auth.** A create on a collection whose rule is `allow create: if request.auth == null` is accepted
for a request carrying only `x-goog-api-key`.

## 2. Firestore REST

### 2.1 Emulator matrix

`scripts/spikes/rest-matrix.mjs`, encodings exactly as architecture §5.4 and §9.3. All 21 steps matched
the architecture's assumptions once the two amendments below were made. 12 runs, identical outcomes.

| Step | Answer | Notes |
|---|---|---|
| `GET` missing document | `404 NOT_FOUND` | → `null` |
| `POST ?documentId=` at rev 0 | `200` | |
| `GET` round trip | `200` | Exactly the 7 written fields; `v`, `rev`, `ts` come back as `integerValue` decimal strings |
| `POST` on an existing id | `409 ALREADY_EXISTS` | As §9.3 |
| `PATCH ?currentDocument.exists=true`, correct chain | `200` | |
| wrong `tok` / other id's `tok` / skipped rev / replayed rev | `403 PERMISSION_DENIED` | |
| `rev` sent as `doubleValue` | `403` | `rev is int` fails: the adapter must send `integerValue` |
| extra field | `403` | FS-2 |
| `PATCH` without `updateMask` after a `z: true` revision | `200` | Stored document no longer has `z` |
| **`PATCH ?currentDocument.exists=true` on a missing document** | **`403 PERMISSION_DENIED`** | §9.3 assumed `404`. Rules run first: the emulator evaluates `update` with `resource == null` (`Null value error`). The classify-by-read path still yields `conflict` |
| `POST` at rev 1 | `403` | |
| `ct` of 1 000 000 chars | `200` | Fits in one document |
| `ct` of 1 000 001 chars | `403` | |
| `GET` collection (list), `runQuery` with `__name__ IN [...]` | `403` | FS-5 |
| `DELETE` | `403` | FS-6 |
| 10 concurrent `PATCH`es at one rev, all with the correct `tok` | exactly one `200` | Losers: a mix of `403 PERMISSION_DENIED` and **`409 ABORTED`** in every one of 12 rounds; the stored document is the winner's |

`409 ABORTED` is Firestore reporting lost contention on a document. The write did not land. §9.3's
mapping did not cover it, so an adapter built to the old table would have mapped it to `network`
(BE-4), shown `offline` and backed off instead of re-reading. Amended: `ABORTED` → `conflict` (D19).

The emulator's rule-denial messages (`false for 'update' @ L20`, `evaluation error at …`) are
diagnostics, not a contract. The adapter must not parse them.

### 2.2 Production, without a project

`firestore.googleapis.com` called from Chromium 141 (Playwright 1.56.1) pages on a synthetic
`https://burrow-spike.example` origin and on `file://` (`Origin: null`), for a project id that does not
exist. 3 attempts per request shape per origin.

| Request | `https://` origin | `file://` origin | Answer |
|---|---|---|---|
| `GET` + `x-goog-api-key` header (preflighted) | answered | answered | `403 PERMISSION_DENIED`, reason `CONSUMER_INVALID` |
| `GET` + `?key=` (simple request) | answered | answered | same |
| `GET`, no key | answered | answered | same |
| `POST` create + key header + JSON (preflighted) | answered | answered | same |
| `PATCH` update + key header + JSON (preflighted) | answered | answered | same |

No CORS error was reported in any attempt from either origin, so the preflight accepts
`x-goog-api-key` and `content-type`, and the `PATCH` method, for both an https origin and `null`. About
one request in ten failed at the transport layer with `net::ERR_TOO_MANY_RETRIES`, for any request
shape and either origin. That is this sandbox's TLS-intercepting egress proxy (the browser ran with
`ignoreHTTPSErrors` for that reason), not Firestore. Every shape was answered in at least 2 of 3
attempts from each origin (`results/browser.json`).

Consequences:

- **Project- and key-level rejections are `403 PERMISSION_DENIED` too**, with an `ErrorInfo` reason
  (`CONSUMER_INVALID` here; a referrer-restricted key is expected to give `API_KEY_HTTP_REFERRER_BLOCKED`, to be confirmed by the owner run). Under the
  old §9.3, a misconfigured `projectId` would have sent every `put` down the classify path, whose read
  also gets `403`, and could have been reported as an endless `conflict`. Since the rules allow every
  `get`, a `403` on a read can only be project- or key-level. Amended: a `403` on `GET`, including the
  classifying read, → `unauthorized` (D19).
- A bogus key on a nonexistent project yields `CONSUMER_INVALID`, not a key error: the project is
  resolved first. Whether a real project accepts requests **without** a key is part of the owner run.

### 2.3 Pending: one run against a real Spark project (owner)

Everything above that says "pending owner run" needs credentials this environment does not have. The
procedure is in `scripts/spikes/README.md` (`npm run prod`). It runs the same matrix and rules probes
in Chromium from both origins against a throwaway Spark project with `spike.rules` deployed. It
answers: production hash casing, `request.auth == null`, success-path CORS, the production document-size
limit at 1 000 000 chars, whether production also returns `409 ABORTED` under contention, whether a key
is required at all, and, as a second run with an HTTP-referrer-restricted key, whether `file://` is
blocked.

That last point is a predicted conflict between **FS-12** (restrict the API key to the developer's
domains) and **NF-1** (works from `file://`). A `file://` page sends no `Referer`, so a
referrer-restricted key should reject it. If the owner run confirms it, the Firestore setup guide
(WP-13/WP-15) must say: for `file://` prototyping use a separate, unrestricted development key, or
accept local-only mode.

## 3. WebAuthn PRF

### 3.1 Chromium 141, CDP virtual authenticator

`WebAuthn.addVirtualAuthenticator` with `protocol: "ctap2"`, `ctap2Version: "ctap2_1"`,
`hasResidentKey`, `hasUserVerification`, `automaticPresenceSimulation`. The page is
`https://burrow-spike.example` with `rp.id = location.hostname`, and the calls are exactly architecture
§8.2 step 2 and `recover` step 1, salt `burrow/prf/v1`. Only lengths and equalities are recorded.

| Authenticator | IsUVPAA | `create()` → `prf` | `get()`, empty `allowCredentials` | `get()` with `allowCredentials` | other salt |
|---|---|---|---|---|---|
| none | `false` | not called | — | — | — |
| internal, UV, PRF | `true` | `enabled: true`, `results.first` 32 bytes | 32 bytes, same credential, **equals create output** | equals empty-list output | differs |
| internal, UV, no PRF | `true` | `enabled: false`, no results | no results | no results | — |
| usb (roaming), UV, PRF | **`false`** | `enabled: true`, 32 bytes | equals create output | equal | differs |
| internal, PRF, UV fails | `true` | `NotAllowedError` | — | — | — |
| internal, UV, PRF, on **`file://`** | **`true`** | **`SecurityError`** (`rp.id` is `""`) | — | — | — |

`getClientCapabilities()` exists and reports `"extension:prf": true` in every scenario, **including with
no authenticator at all**, and `hybridTransport: false` in headless Linux. `passkeyPlatformAuthenticator`
and `userVerifyingPlatformAuthenticator` track IsUVPAA.

Findings and what they change:

1. **PRF at create works and matches PRF at get.** §8.2 step 3's fast path (use `results.first` from
   `create()`) is sound on Chromium. The follow-up `get()` stays for platforms that report only
   `enabled`. If a platform ever returned a create-time output that differs from its get-time output,
   the keyslot written at enrol would be unrecoverable; WP-12's browser test should assert equality,
   and the real-device rows below should record it.
2. **No-PRF authenticators report `prf: { enabled: false }`**, so §8.2's `!ext?.enabled` →
   `prf-unsupported` path is right; `get()` then returns no `results`, which `recover` already treats as
   `prf-unsupported`.
3. **`available()` as specified returns `true` on `file://`**: IsUVPAA is `true` and the PRF capability
   is `true`, but `create()` throws `SecurityError`. `protect()` would then pick the passkey and fail
   instead of falling through to the sync code, which breaks KP-7 and NF-1. Amended: `available()` also
   requires `location.hostname !== ""` (D20).
4. **`"extension:prf"` is a browser capability, not an authenticator capability.** It rules out
   browsers that do not know PRF, and nothing more. `prf-unsupported` at enrol (design-review C1) remains
   the real check.
5. **A UV failure is `NotAllowedError`**, indistinguishable from a user cancel. `recover` maps it to
   `null`, which is right; `enrol` should surface it as "declined", not as `prf-unsupported`.
6. **KP-7's IsUVPAA gate hides working setups.** A roaming security key with PRF works end to end, but
   IsUVPAA is `false` when there is no platform authenticator, so `available()` returns `false`. The
   same holds for a desktop that only has a phone over hybrid transport. KP-7 requires this behaviour
   (`false` "when the platform has no user-verifying authenticator"), so the architecture keeps it. It
   is raised for an owner decision in issue #2 rather than changed here.

### 3.2 Real devices: not measured

No real Safari, iOS, Android or Windows device was available to this spike. Fill these in when one is
(the probe in `scripts/spikes/run-browser.mjs` can be pasted into a page served over https).

| Platform | PRF `results` at `create()`? | create output == get output? | `get()` with empty `allowCredentials`? | Measured by / date |
|---|---|---|---|---|
| Safari, macOS (iCloud Keychain) | not measured | | | |
| Safari, iOS | not measured | | | |
| Chrome, Android (Google Password Manager) | not measured | | | |
| Chrome, Windows (Windows Hello) | not measured | | | |
| Firefox, any | not measured | | | |
| Cross-device hybrid (phone as authenticator) | not measured | | | |

## 4. Page environment

Chromium 141 headless, measured in-page.

| Capability | `https://` origin | `file://` |
|---|---|---|
| `self.origin` | `https://burrow-spike.example` | `null` |
| `isSecureContext` | `true` | `true` |
| `crypto.subtle` | yes | yes |
| IndexedDB open + upgrade | ok | ok |
| `BroadcastChannel` | yes | yes |
| `navigator.locks` | yes | yes |
| `CompressionStream("deflate-raw")` | yes | yes |
| `PublicKeyCredential` | yes | yes (but see §3.1: `create()` fails) |

Firefox and WebKit are not installed in this environment and were not measured. Firefox's
per-file `file://` origin policy may affect IndexedDB and `BroadcastChannel` scoping there; WP-14's
cross-browser suite should cover `file://` explicitly.

## 5. Limits of these measurements

- The emulator runs the same rules language as production but not the same storage engine. Contention
  behaviour (`409 ABORTED`) and the document-size limit are confirmed only on the emulator until the
  owner run.
- The virtual authenticator implements CTAP 2.1 `hmac-secret` as Chromium understands it. It says
  nothing about Apple, Google Password Manager or Windows Hello.
- Production observations went through a TLS-intercepting egress proxy. CORS headers came back intact,
  since the browser accepted every answered response, but transport errors there are the proxy's.
