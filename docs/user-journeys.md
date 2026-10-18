# Demo page: user journeys

These five journeys define what a person must be able to do on the Burrow demo page
(`demo/index.html`, deployed at <https://froussios.github.io/burrow-storage/>). They drive the
demo's design and its browser tests. The page also has **Forget this device**, described below.

## Terms

- **Storage token** (or just **token**): the secret that owns a user's data. Whoever holds it can
  read and write that data from any device. It is 56 characters, shown in 14 groups of four
  (`07DV-1XKY-…`). The requirements brief calls it the *root secret*, and its typed form the *sync
  code* (KP-11); the API calls it the token (`exportToken()`, `link({ token })`), see
  [decisions.md](decisions.md) D-42.
- **Backup**: the user's data in the shared store, encrypted under keys derived from the token.
- **Passkey backup**: the token stored in a passkey's keyslot, so that passkey can bring it back
  on any device (KP-5, KP-6).
- **No token**: this browser has never used the demo, or its site data was cleared. On load the
  demo generates a fresh token (KP-1), so "no token" means "only a brand-new, empty token".

## What the page always shows

The **Storage token** panel is always visible. It shows:

- the token in use, with **Copy token**, so the user can keep it in a password manager;
- where the token came from:

  | Source | Shown as |
  | --- | --- |
  | Generated on load (KP-1) | Generated on this device (new) |
  | Typed or pasted into **Link to existing backup** | Pasted or typed in |
  | Recovered from a passkey (KP-6) | Restored from your passkey |
  | Loaded from this browser on a later visit (KP-2) | Remembered by this browser; originally … |

  Each source also shows when this device obtained the token. The page reads the source from
  `BurrowArea.token` (`{ source, remembered, since }`) and updates it on `BurrowArea.onToken`.
- the recorded passkey backup status: *Yes, in a passkey.* after a successful save, *Not
  confirmed. Keep the storage token or try saving again.* while a save is pending or after it
  fails, or *None yet. Create one below, or keep the token yourself.* before either. This record travels with the
  data; it cannot verify that a previously saved passkey is still available.

## Summary

| # | Starting state | User action | Outcome | Test |
| --- | --- | --- | --- | --- |
| 1 | No token | Create new backup with key | The token is stored in a passkey; data is backed up | `passkey.spec.ts`, demo journeys 1 and 2 |
| 2 | No token | Use my passkey | The existing token and data appear | `passkey.spec.ts`, demo journeys 1 and 2 |
| 3 | No token | Paste a token | The existing data appears | `demo.spec.ts`; `test/smoke/demo.spec.ts` against the deployed demo |
| 4 | No token | Paste an invalid token | An error, or empty data with working sync | `demo.spec.ts`, journey 4 |
| 5 | Has a token | Open the page | Previous data appears immediately | `demo.spec.ts` (reload) |

## 1. Create a new backup with a passkey

**Starting state:** no token. The page has just generated one, and the panel says *Generated on
this device (new)* and *Passkey backup: None yet*.

**Steps:** the user clicks **Create new backup with key** and confirms the passkey prompt. The
page does not ask for a separate confirmation.

**Outcome:** the token is stored behind a new passkey. The panel says *Passkey backup: Yes, in a
passkey.* This records the successful save, rather than continuously checking recovery. The
data the user writes syncs to the store under that token.

**How:** `passkeyBackup({ userName: "burrow-demo" }).save(await store.exportToken())` creates a
discoverable passkey, evaluates its PRF, and writes a keyslot holding the token wrapped under the
PRF output. The user handle derives from the decoded token and effective relying party ID
using a separate HKDF domain. The label is only for display: different tokens coexist even
under the same label, while saving the same token again on the same relying party replaces its
credential regardless of label. The demo records `backup: "passkey"` in the store, so every
device linked to the token shows the recorded status.

**Notes:**
- Re-saving the same token may replace its credential before PRF evaluation or writing the
  new keyslot. A failure afterward can leave no usable passkey backup. Before starting a save,
  the demo persists `backup: "unknown"` and shows *Not confirmed. Keep the storage token or try
  saving again.* This survives closing the page during a save. Success records `"passkey"`
  only if the current token still matches the saved token. The user can retry or copy the token
  they still have on this device.
- Data syncs within seconds of being written, before any passkey exists. The passkey is what
  makes the token recoverable after the browser forgets it.
- Where the browser or authenticator lacks the PRF extension (support varies), the page says the
  browser cannot use passkeys for this. The user should copy the token instead.

## 2. Restore the token from a passkey

**Starting state:** no token. The user made a passkey backup earlier, on this device before
clearing its data, or on another device.

**Steps:** under **Link to existing backup**, the user clicks **Use my passkey** and confirms
the prompt.

**Outcome:** the panel shows the original token, *Restored from your passkey*. The user's
existing data appears, typically within a few seconds.

**How:** `passkeyBackup().restore()` reads the keyslot and unwraps the token;
`BurrowArea.link({ token, source: "passkey" })` makes it this device's token and pulls the data.

**Notes:**
- If the current token has locally cached live data, `link()` rejects with `would-replace`.
  The page asks before replacing it and retries with `replace: true` only after confirmation.
  An empty local cache or linking the token already in use needs no replacement confirmation.
- Unsynced writes have an independent `would-orphan` guard. The page asks before discarding
  them and retries with `discardLocal: true` only after confirmation; accepting this does not
  bypass the replacement guard. Declining either confirmation leaves the device as it was.
- Restore runs once. All confirmation retries reuse its token without another passkey prompt.
  The guards inspect local state; they do not establish whether the current token has data
  stored only on another device or in the shared store.
- A passkey from another ecosystem works only through the QR/hybrid flow. This has not been
  tested on real hardware.
- If the user picks a passkey that has no backup, the page says "No passkey backup was used", the
  same as for a dismissed prompt: `restore()` returns `null` in both cases. A clearer message is a
  known gap.

## 3. Paste a token

**Starting state:** no token. The user has their token, copied from another device's panel.

**Steps:** they paste or type it into **Link to existing backup** and click **Link this
device**.

**Outcome:** the panel shows the pasted token, *Pasted or typed in*.
Their existing data appears.

**How:** `BurrowArea.link({ token })` checks the token's checksum before any network call, adopts it
and pulls the data. Case, spaces and hyphens are ignored, and `O`/`0` and `I`/`L`/`1` count as
the same.

**Notes:** linking over locally cached live data or unsynced writes follows the same independent
replacement and discard confirmations as restoring from a passkey. Linking an empty device or
its current token needs no replacement confirmation.

## 4. Paste an invalid token

**Starting state:** no token. The user mistypes or pastes the wrong thing.

**Outcome:** one of two things, and the user can always try again.

| Input | What the page does |
| --- | --- |
| Wrong length, a character outside the alphabet, or a failed checksum | Shows "That token is not right. Check it and try again." The current token and data are unchanged. |
| A well-formed token nobody has used, or a typo that passes the 16-bit checksum (about 1 in 65,536) | Adopts it. The panel shows the new token, *Pasted or typed in*. The data is empty, and anything written syncs under it: a working, new backup. |

**Notes:** the second row looks like "my data is gone". Because the panel always shows the token
in use, the user can compare it with the one they meant to paste. A future version could warn
"This backup is empty. Is the token right?" when linking finds no data.

## 5. Return with a token

**Starting state:** this browser used the demo before and still has its token.

**Steps:** the user opens the page.

**Outcome:** the draft and theme appear on first render, with no prompt. The panel shows the same
token, *Remembered by this browser; originally …*. Changes from other devices arrive in the
background.

**How:** `burrow()` loads the token and the whole local cache before it resolves (API-1,
API-10). That takes 6 ms in Chromium and 11 ms in Firefox, against a 50 ms budget.

**Notes:** clearing site data, a private window or another browser profile means no token. The
user then goes through journey 2 or 3.

## Forget this device

**Forget this device** calls `unlink()` (API-8). If locally cached live data exists, the library
rejects with `would-replace`; the page asks for confirmation before retrying with `replace:
true`. Unsynced writes independently require confirmation to retry with `discardLocal: true`.
Declining either confirmation keeps the current token and data. An empty device with no
unsynced writes is forgotten without confirmation.

After unlinking, the page reloads and starts a new token. Other devices and remote documents
are unaffected; the old token still links back to its data. The prompts depend on the local
cache and pending writes, not proof of what exists remotely or whether a passkey can recover
the old token. The user should keep that token or another working backup if they want to
return to it.
