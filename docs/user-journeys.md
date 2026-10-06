# Demo page: user journeys

These five journeys define what a person must be able to do on the Burrow demo page
(`demo/index.html`). They drive the demo's design and its browser tests. The page also has
**Forget this device**, which calls `unlink()` (API-8): the token is forgotten here, the next load
starts a new one, and the old token still links back to the data.

## Terms

- **Storage token** (or just **token**): the secret that owns a user's data. Whoever holds it can
  read and write that data from any device. It is 56 characters, shown in 14 groups of four
  (`07DV-1XKY-…`). The requirements brief calls it the *root secret*, and its typed form the *sync
  code* (KP-11); the API keeps those names (`exportCode()`, `link({ code })`), see
  [decisions.md](decisions.md) D-28.
- **Backup**: the user's data in the shared store, encrypted under keys derived from the token.
- **Passkey backup**: the token stored in a passkey's keyslot, so that passkey can bring it back
  on any device (KP-5, KP-6).
- **No token**: this browser has never used the demo, or its site data was cleared. On load the
  demo generates a fresh token (KP-1), so "no token" means "only a brand-new, empty token".

## What the page always shows

The **Storage token** panel is always visible. It shows:

- the token in use, with **Copy token** and a **Link for your other device** (`#burrow=<token>`);
- where the token came from:

  | Source | Shown as |
  | --- | --- |
  | Generated on load (KP-1) | Generated on this device (new) |
  | Typed or pasted into **Link to existing backup** | Pasted or typed in |
  | Opened from a `#burrow=` link (KP-13) | Opened from a link |
  | Recovered from a passkey (KP-6) | Restored from your passkey |
  | Loaded from this browser on a later visit (KP-2) | Remembered by this browser; originally … |

  Each source also shows when this device obtained the token. The page reads the source from
  `BurrowArea.token` (`{ source, remembered, since }`) and updates it on `BurrowArea.onToken`.
- whether a passkey backup exists.

## Summary

| # | Starting state | User action | Outcome | Test |
| --- | --- | --- | --- | --- |
| 1 | No token | Create new backup with key | The token is stored in a passkey; data is backed up | `passkey.spec.ts`, demo journeys 1 and 2 |
| 2 | No token | Use my passkey | The existing token and data appear | `passkey.spec.ts`, demo journeys 1 and 2 |
| 3 | No token | Paste a token | The existing data appears | `demo.spec.ts` |
| 4 | No token | Paste an invalid token | An error, or empty data with working sync | `demo.spec.ts`, journey 4 |
| 5 | Has a token | Open the page | Previous data appears immediately | `demo.spec.ts` (reload) |

## 1. Create a new backup with a passkey

**Starting state:** no token. The page has just generated one, and the panel says *Generated on
this device (new)* and *Passkey backup: None yet*.

**Steps:** the user clicks **Create new backup with key** and confirms the passkey prompt.

**Outcome:** the token is stored in a new passkey. The panel says *Passkey backup: Yes, in a
passkey*. The data the user writes syncs to the store under that token.

**How:** `BurrowArea.protect("passkey")` creates a discoverable passkey, evaluates its PRF, and
writes a keyslot holding the token wrapped under the PRF output.

**Notes:**
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

**How:** `BurrowArea.link({ provider: "passkey" })` reads the keyslot, unwraps the token, makes it
this device's token, and pulls the data.

**Notes:**
- If the user wrote anything under the fresh token first, linking would abandon it. The page
  asks before discarding it (`would-orphan`).
- A passkey from another ecosystem works only through the QR/hybrid flow. This has not been
  tested on real hardware.
- If the user picks a passkey that has no backup, the page says "No passkey was used". A clearer
  message is a known gap.

## 3. Paste a token

**Starting state:** no token. The user has their token, copied from another device's panel.

**Steps:** they paste or type it into **Link to existing backup** and click **Link this
device**. Alternatively, they open the **Link for your other device** URL.

**Outcome:** the panel shows the pasted token, *Pasted or typed in* (or *Opened from a link*).
Their existing data appears.

**How:** `BurrowArea.link({ code })` checks the token's checksum before any network call, adopts it
and pulls the data. Case, spaces and hyphens are ignored, and `O`/`0` and `I`/`L`/`1` count as
the same. A token in the URL is removed from the address bar once read.

## 4. Paste an invalid token

**Starting state:** no token. The user mistypes or pastes the wrong thing.

**Outcome:** one of two things, and the user can always try again.

| Input | What the page does |
| --- | --- |
| Wrong length, a character outside the alphabet, or a failed checksum | Shows "That token is not right. Check it and try again." The current token and data are unchanged. |
| A well-formed token nobody has used, or a typo that passes the 16-bit checksum (about 1 in 65,536) | Adopts it. The panel shows the new token, *Pasted or typed in*. The data is empty, and anything written syncs under it: a working, new backup. |

**Notes:** the second row looks like "my data is gone". Because the panel always shows the token
in use, the user can compare it with the one they meant to paste. A future version could warn
"This backup is empty. Is the token right?" when a link finds no data.

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
