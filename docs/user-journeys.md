# User journeys

These five journeys define what a person using a Burrow-backed site must be able to do. They
inform the design: where the current implementation (branch `brief-implementation`) already
supports a journey, its section says how. Where it does not, or where the journey asks for
behaviour the requirements do not specify, the section names the gap. Open questions are
collected at the end.

## Terms

- **Storage token** (or just **token**): the secret that owns a user's data. Whoever holds it
  can read and write that data from any device. It is 56 characters, shown in groups of four
  (`04G1-20G3-…`). The requirements call it the *root secret*, and its typed form the *sync
  code* (KP-11); this document calls both the token.
- **Backup**: the user's data in the shared store, encrypted under keys derived from the token.
  The store holds data for many tokens and cannot tell them apart.
- **Passkey**: a WebAuthn credential that can hold a token. The token sits in a keyslot that
  only that passkey can unlock (KP-5, KP-6).
- **Has a token**: this browser remembers a token from an earlier visit (KP-2).

## Summary

| # | Starting state | User action | Outcome | Supported today |
| --- | --- | --- | --- | --- |
| 1 | No token | Generate a token, store it in a passkey | Data is backed up | Yes, but generation is implicit |
| 2 | No token | Pull an existing token from a passkey | Existing data appears | Yes |
| 3 | No token | Enter a token | Existing data appears | Yes |
| 4 | No token | Enter an invalid token | An error, or empty data with working sync | Yes; one edge case is silent |
| 5 | Has a token | Open the site | Previous data appears at once | Yes |

## 1. Generate a new token and store it in a passkey

**Starting state:** this browser has no token. It is a first visit, or site data was cleared.

**Steps:**
1. The user chooses to create a new backup.
2. A new token is generated.
3. The user's passkey prompt appears; they confirm, and the token is stored in the passkey.

**Outcome:** the user's data is backed up. On any other device, the same passkey brings it back
(journey 2).

**Today:** `burrow({ app })` generates the token silently on the first visit (KP-1). The user
has no "generate" step; they already have a token, and anything they type is already syncing
under it. The demo's **Create new backup with key** button calls `store.protect("passkey")`.
That creates a discoverable passkey and writes a keyslot holding the token, wrapped under the
passkey's PRF output.
Evidence: `test/e2e/passkey.spec.ts` (Chromium virtual authenticator).

**Gaps:**
- The journey makes generation an explicit user step; the implementation makes it automatic
  and invisible. See question Q1.
- If the browser or authenticator has no PRF support, `protect("passkey")` fails with
  `prf-unsupported`. Firefox and Safari often lack it. The only fallback is showing the token
  for the user to write down. The journey should say what happens then (Q3).
- "Backed up" happens in two places at different times. Data syncs to the store within seconds
  of being written, before any passkey exists. The passkey only makes the token recoverable.
  The UI should not suggest the data is safe until both are true.

## 2. Pull an existing token from a passkey

**Starting state:** this browser has no token. The user created a backup with a passkey on
another device, or before clearing site data.

**Steps:**
1. The user chooses to link to an existing backup with their passkey.
2. The passkey prompt appears; they pick the passkey and confirm.

**Outcome:** the token is restored to this browser, and the user sees their existing data.

**Today:** `store.link({ provider: "passkey" })` asks the passkey for its PRF output, derives
the keyslot id, reads the keyslot, unwraps the token, and replaces this browser's token with it
(KP-6). It then pulls the data, typically within a few seconds. The demo's **Use my passkey**
button does this.
Evidence: `passkey.spec.ts` (enrol, wipe all site data, recover; enrol, unlink, recover).

**Gaps:**
- Before linking, the browser already holds an automatically generated token (journey 1).
  If the user typed anything first, linking would abandon it, so `link()` refuses with
  `would-orphan`. The demo then asks whether to discard it. The journey should say whether
  that data is discarded, merged into the backup, or kept (Q2).
- A passkey from another ecosystem (an Apple passkey on Windows) works only through the
  QR/hybrid flow, and PRF support there is uneven. Not tested on real hardware.
- If the user picks a passkey that has no keyslot, recovery returns nothing. The user sees
  "No passkey was used", which is the wrong message.

## 3. Enter a token

**Starting state:** this browser has no token. The user has their token written down or
copied from another device.

**Steps:**
1. The user chooses to link to an existing backup.
2. They type or paste the token, or open a link containing it (`https://site/#burrow=<token>`).

**Outcome:** the user sees their existing data.

**Today:** `store.link({ code })` decodes the token, checks its checksum before any network
call (KP-12), replaces this browser's token and pulls the data. Typing is forgiving: case,
hyphens and spaces are ignored, and `O`/`0` and `I`/`L`/`1` are treated as the same. A token in
the URL fragment links on page load, then is removed from the address bar (KP-13). The demo's
**Link to existing backup** field does this.
Evidence: `test/e2e/browser.spec.ts` (second device: 2.8 s in Chromium); a live run against
the shared store (5.5 s); `test/unit/area.test.ts`.

**Gaps:**
- The same `would-orphan` question as journey 2 (Q2).
- A token in a URL can end up in browser history, sync services or chat previews before
  Burrow removes it from the address bar. The journey should decide whether links are offered
  at all (Q4).

## 4. Enter an invalid token

**Starting state:** this browser has no token. The user mistypes, or pastes something that
is not a token.

**Steps:** as journey 3.

**Outcome:** either an error the user can act on, or empty data with sync working. Either
way, nothing is corrupted and the user can try again.

**Today:** there are three cases.

| Input | Result |
| --- | --- |
| Wrong length, characters outside the alphabet, or failed checksum | `link()` rejects with `bad-code`, before any network call. The demo says "That token is not right. Check it and try again." This browser's own token and data are untouched. |
| A well-formed token nobody has used | Linking succeeds. The user sees empty data, and anything they write syncs under that token: a working, new, empty backup. |
| A typo that still passes the checksum | Same as the previous row. The checksum is 16 bits, so about 1 typo in 65,536 gets through. |

Evidence: `test/unit/codec.test.ts` (KP-11/12: wrong checksum, length and characters are
rejected; single-character typos at every third position are all caught) and `test/unit/area.test.ts`
("KP-12 a bad code is rejected before any network call").

**Gaps:**
- The second and third rows look identical to the user: their data appears to be gone. Linking
  cannot tell "an unused token" from "a token with data", because an unknown token's manifest
  simply does not exist. A site could warn "This backup is empty. Is the token right?" when a
  link finds no data (Q5).
- Linking replaces this browser's token. After linking a wrong token, the user's own token is
  gone unless they saved it, or unless `would-orphan` stopped the link.

## 5. Return with a token

**Starting state:** this browser has a token from an earlier visit.

**Steps:** the user opens the site.

**Outcome:** their previous data is displayed immediately, with no prompt.

**Today:** `burrow({ app })` loads the wrapped token and the whole local cache from IndexedDB
before it resolves. Reads answer from memory, so the page renders the data on its first paint,
then pulls any changes from other devices in the background (API-1, API-10, KP-2).
`burrow()` takes 6 ms in Chromium and 11 ms in Firefox when the cache is warm (budget 50 ms).
Changes arriving from other devices fire `onChanged`.
Evidence: `browser.spec.ts` ("KP-1/KP-2 data and secret persist across reloads; burrow() is
fast when warm").

**Gaps:**
- "Has a token" ends when the user clears site data, or uses private browsing or another
  browser profile. They are then back in journey 2 or 3, and only if they made a backup.
- With `rememberDevice: false` (shared computers), every visit starts without a token by
  design.

## Open questions for the design

- **Q1. Is there a "no token" state?** The journeys start from "the user has no token" and
  make generation a choice (journey 1). The requirements make generation silent and immediate
  (KP-1, principle "No login"), so a visitor can use the site with no setup. To honour the
  journeys literally, a site would show a choice before any data exists: "Create new backup" /
  "Link to existing backup". That conflicts with KP-1's zero-friction path. A middle ground is
  to keep silent generation but present the token as "new, not backed up" until journey 1
  completes.
- **Q2. What happens to data typed before linking?** Options: discard it (today, after
  confirmation), merge it into the linked backup, or keep it under the old token. Merging is
  the friendliest choice but the API does not offer it yet.
- **Q3. What is journey 1 without passkey PRF?** Show the token for the user to copy, offer a
  file download, or both.
- **Q4. Should tokens travel in links?** Links are convenient for moving to a phone, but they
  leak into history and previews.
- **Q5. Should an empty link warn?** Show "This backup is empty" when a token links to no data,
  so the user can catch an unused or mistyped token (journey 4).

## Terminology change

This document says **storage token**, or just **token**, where the requirements and the code
say *root secret* or *sync code*. The demo uses "token" in everything it shows. The public API
still uses the old names (`exportCode()`, `link({ code })`, the error code `bad-code`), and so
do `docs/requirements.md`, `docs/architecture.md`, the README and SECURITY.md. Renaming those is
a breaking API change and should be decided separately.
