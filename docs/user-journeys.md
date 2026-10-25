# Demo page: user journeys

These journeys define what a person must be able to do on the Burrow demo page
(`demo/index.html`, deployed at <https://froussios.github.io/burrow-storage/>). They drive the
demo's design and its browser tests. The page shows the two ways an app can hold the storage
token (D-57): **sign in on every visit** and **stay signed in**.

## Demo v2: selectable scenarios

`demo/v2.html?scenario=offline` and `demo/v2.html?scenario=core` open separate
scenarios. The sidebar enumerates the registry in `demo/v2.js`; an absent scenario
selects `offline`, and an unknown value shows the index without opening a store.
The original page remains available. `demo:build` packages and stamps both pages.

- **Offline wrapper** uses app `burrow-demo-v2-offline`, the same async editor over
  `offline(core)`, and the page-owned localStorage record
  `burrow-demo-v2-offline:token`. It is the stay-signed-in flow: both the retained
  token and the offline content copy are plaintext.
- **Remote only / Core lib, backed by Firebase** uses app `burrow-demo-v2-core`, with the token in memory for the
  visit. Reloading asks for the token or passkey again. Remote failures are shown
  as failed saves, with confirmation before abandoning an unsaved edit.

Both scenarios begin with an explicit token/passkey action. The v2 actions distinguish
**Get token from passkey**, **Create passkey and token**, and **Create token only**.
New random tokens and passkey-derived tokens are separate per scenario. Passkey creation labels include
its scenario, and each creates a distinct credential; selecting an existing
credential still derives a different token for each app. A deliberately reused
pasted token cannot reveal the other scenario's content because document derivation
also includes the app namespace. Nothing is shared with the original demo's app.

Switching scenarios waits for pending editor writes to reach the selected store
(or the offline copy). It does not sign out the other scenario or erase its data.
Core memory custody means switching away still requires reopening on return.
Signing out clears only the selected scenario's retained token and offline copy;
remote content remains available with that scenario's token or passkey.

The only storage-specific branches are initialization, offline status/change
subscriptions and offline `forget()` on sign-out. Both scenarios use `get()` and
`set()` through the same editor, export and theme code. More divergent scenarios
should be called out when added, rather than duplicating the editor.

`test/e2e/demo-v2.spec.ts` covers navigation, reloads, offline replay, remote
namespace isolation, core failure behavior, and passkey separation. It uses the
real crypto and a shared memory backend; it never contacts the live project.

## Terms

- **Storage token** (or just **token**): the secret that owns a user's data. Whoever holds it can
  read and write that data from any device. It is 56 characters, shown in 14 groups of four
  (`07DV-1XKY-…`). The requirements brief calls it the *root secret*, and its typed form the *sync
  code* (KP-11).
- **Passkey token**: the token a passkey gives this app (`passkeyToken({ app }).create()` or
  `.get()`). The same passkey gives the same token on every device where it is available; nothing
  is stored (D-58).
- **Sign in on every visit** ("login often"): the page opens the core with the token and keeps it
  in memory only. Nothing is stored on the device; a reload locks the page again.
- **Stay signed in** ("login once"): the page keeps the token itself, in `localStorage`, and opens
  the offline wrapper, which keeps an unencrypted copy of the data in IndexedDB. The next visit
  opens at once and works offline. Anyone who can read the browser profile can read both and use
  the token.

Burrow itself never makes up a token and never stores one: the page asks how to sign in.

## What the page shows

Before signing in, the **Open your storage** panel: a choice between *Sign in on every visit*
(the default) and *Stay signed in*, each with a one-line explanation of what it keeps on the
device, and four ways in: **Use my passkey**, **Create a passkey**, **Start with a new token**, and
a field to **enter a storage token**.

After signing in, the draft and theme, and the **Storage token** panel:

- the token in use, with **Copy token**, so the user can keep it in a password manager;
- **From**: where the token came from (a new passkey, your passkey, generated on this device,
  pasted or typed in; or *Kept by this page since …; originally …* after a reload in *stay
  signed in*);
- **Token**: where it is kept (*In this page's memory only…* or *Kept by this page in this
  browser's localStorage, unencrypted, until you sign out.*);
- **Data**: where the data is (*Only in the store, encrypted…* or *…plus an unencrypted copy in
  this browser for offline use.*);
- **Export JSON** and **Sign out**.

The status badge shows *locked*, *saving…*, *synced*, *syncing*, *offline* or *error*.

## Summary

| # | Mode | Starting state | User action | Outcome | Test |
| --- | --- | --- | --- | --- | --- |
| 1 | Every visit | No passkey | Create a passkey | A new token from the passkey; data saves to the store; a reload locks the page | `passkey.spec.ts`, demo journeys 1 and 2 |
| 2 | Every visit | A passkey | Use my passkey | The same token and its data, also after wiping the site | `passkey.spec.ts`, demo journeys 1 and 2 |
| 3 | Either | The token, from another device | Enter it | The existing data appears | `demo.spec.ts`; `test/smoke/demo.spec.ts` against the deployed demo |
| 4 | Either | — | Enter an invalid token | An error; nothing opens | `demo.spec.ts`, journeys 3 and 4 |
| 5 | Stay signed in | Signed in earlier | Open the page; go offline; sign out | Opens at once with the data; edits work offline and sync later; signing out removes the token and the copy | `demo.spec.ts`, journey 5 |

## 1. Create a passkey (every visit)

**Starting state:** the sign-in panel, *Sign in on every visit* selected.

**Steps:** the user clicks **Create a passkey** and confirms the passkey prompt (sometimes two:
some authenticators evaluate PRF only on a second prompt).

**Outcome:** the page opens with an empty store. The panel says *From: A new passkey created
here*, *Token: In this page's memory only*. What the user writes saves to the store; the badge
shows *saving…* then *synced*. Reloading the page locks it: the sign-in panel again, and nothing
about the user on the device.

**How:** `passkeyToken({ app: "burrow-demo" }).create()` creates a discoverable passkey with a
random user handle and returns the token derived from its PRF output; the page opens
`burrow({ app, backend, token })`. Every edit is `store.set()`, a round trip to the store, saved
400 ms after typing stops.

**Notes:**
- A dismissed prompt shows "No passkey was used. Try again, or use a storage token." Where the
  browser or authenticator lacks PRF, the page says the browser cannot use passkeys for this.
- Each **Create a passkey** is a new passkey and a new, empty identity. It never replaces one.
- A write the store refuses is reported ("Not saved: the store could not be reached…") and is
  not kept: the core queues nothing.

## 2. Use my passkey

**Starting state:** the sign-in panel; a passkey made on this device or synced to it.

**Steps:** **Use my passkey**, pick the passkey, confirm.

**Outcome:** the same token, *From: Your passkey…*, and the user's data. This works after
clearing all site data too: nothing was stored.

**How:** `passkeyToken({ app: "burrow-demo" }).get()` returns the token that passkey gives this
app; the page opens the core with it, then reads everything.

**Notes:** a passkey from another ecosystem works only through the browser's QR/hybrid flow,
which has not been tested. Losing the passkey loses this way back; the token string still works.

## 3. Enter a storage token

**Starting state:** the sign-in panel. The user has their token, copied from another device.

**Steps:** they paste or type it into **Or enter a storage token** and click **Open**.

**Outcome:** the panel shows the token in its canonical form, *From: Pasted or typed in*, and
their data appears. Case, spaces and hyphens are ignored, and `O`/`0` and `I`/`L`/`1` count as
the same.

**How:** `burrow({ app, backend, token })` checks the checksum before any network call, then the
page reads the data. With *stay signed in* selected, the page also keeps the token and opens the
offline wrapper.

## 4. Enter an invalid token

**Outcome:** one of two things, and the user can always try again.

| Input | What the page does |
| --- | --- |
| Wrong length, a character outside the alphabet, or a failed checksum | Shows "That token is not right. Check it and try again." Nothing opens. |
| A well-formed token nobody has used, or a typo that passes the 16-bit checksum (about 1 in 65,536) | Opens it: an empty store under a new identity. The panel shows the token in use, so the user can compare it with the one they meant. |

## 5. Stay signed in

**Starting state:** the sign-in panel. The user selects *Stay signed in* and signs in any way.

**Outcome:** the panel says *Token: Kept by this page in this browser's localStorage,
unencrypted, until you sign out.* and *Data: Encrypted in the store, plus an unencrypted copy in
this browser for offline use.*

- **The next visit** opens at once, with the draft and theme on first render and no prompt; the
  panel says *Kept by this page since …; originally …*. Changes from other devices arrive
  through the store's listener.
- **Offline**, edits still save, to the copy; the badge shows *offline*. When the network
  returns, they reach the store and the badge shows *synced*. Another device then sees them.
- **Sign out** pushes unsynced edits first. If some cannot be pushed, the page asks before
  discarding them; declining keeps the user signed in. Signing out deletes the page's token
  record and the local copy, then shows the sign-in panel. Other tabs sign out too.

**How:** the page stores `{ token, source, since }` under `burrow-demo:token` in `localStorage`
and opens `offline(await burrow({ app, backend, token }))`. Sign out is `forget()`, retried with
`discardLocal: true` after confirmation, and then removes the record.

**Notes:** this is the page's own choice of token custody, not Burrow's: a copied browser profile
gives anyone the token and lasting access to the data. The page says so before the user picks
it.
