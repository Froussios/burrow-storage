# Storage tokens, passkey backups and sync

How a user's data gets from one device to another, what the library does in the background, and
what a site should show. Signatures are in [api.md](api.md).

## Terms

| Term | Meaning |
| --- | --- |
| **Storage token** (or just **token**) | The 32-byte secret that owns a user's data. Whoever holds it can read and write that data from any device. Shown to people as 56 characters in groups of four, `07DV-1XKY-…`. The API calls it `code`: `exportCode()`, `link({ code })`, `bad-code`. |
| **Passkey backup** | The token stored in a *keyslot* document in the shared store, wrapped under a key that only the passkey's PRF output can derive. One passkey, one keyslot. |
| **Protection** | What this device knows could bring the token back elsewhere: `"passkey"`, `"code"` (the user has kept the token) or `"none"`. |
| **Linking** | Making this device use an existing token instead of the one it generated. |

## First device: nothing to do

`burrow()` generates a token the first time an app runs on a device and remembers it in IndexedDB,
wrapped under a non-extractable key, the way a browser remembers a login. The user sees no prompt.
Data written from then on syncs under that token within seconds, so the store already holds
everything; what the token provides is the *address and the key* to it.

Remembering is only as durable as the browser's storage. Safari deletes a site's IndexedDB after
seven days of Safari use without the user interacting with the site, and other browsers may evict
storage when the disk runs low. The device then starts over with a new, empty token, while the
data waits in the store for the old one. That is why a kept token or a passkey backup matters even
to users with a single device.

Because the token is per origin, every Burrow app on the same origin shares it. A user who links
one app has linked them all; each app still has its own documents. An app that is not open when
another app links picks up the new token on its next load, and drops any writes it had not
synced under the old one.

## Second device, option 1: the storage token

```js
// first device
tokenEl.textContent = await store.exportCode();

// second device
try {
  await store.link({ code: input.value });
} catch (e) {
  if (e.code === "bad-code") say("That token is not right. Check it and try again.");
}
```

- Decoding is forgiving: case, spaces and hyphens are ignored, `O` reads as `0`, `I` and `L` as
  `1`. The alphabet has no `I`, `L`, `O` or `U`.
- A 16-bit checksum catches typos: a wrong token rejects with `bad-code` before any network call
  and nothing changes. A random well-formed string passes the checksum about once in 65 536
  attempts and is then adopted as a new, empty token. The demo therefore always shows the token
  in use, so the user can compare it with the one they meant to enter.
- It needs no WebAuthn, so it works in every supported browser, including those whose passkeys
  lack the PRF extension.

## Links

The token can travel as a link, `https://your.site/#burrow=<token>`. A page that opens with that
fragment adopts the token during `burrow()` and removes it from the address bar with
`history.replaceState`. Burrow never puts the token in a URL on its own; the demo builds such a
link as a convenience. Two cautions:

- **A link is the token.** Anyone who gets it gets the data, and it may linger in browser history,
  autocomplete, or wherever it was shared.
- **Burrow adopts any link, on every page load, without asking.** Someone who gets a user to open a
  link carrying *their own* token switches that device, and every Burrow app on its origin, to
  that token. They can then read what the user writes there, and the user's own token is forgotten
  on that device unless they kept a copy. Showing the token in use, as the demo does, makes a
  switch visible.

A site that does not hand out links should drop the fragment before Burrow can read it:

```js
// Before burrow(): ignore #burrow= links on a site that never offers them.
if (/[#&]burrow=/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search);
const store = await burrow({ app: "my-app" });
```

## Second device, option 2: a passkey backup

```js
// first device, from a click
try {
  await store.protect("passkey");
} catch (e) {
  if (e.code === "prf-unsupported") say("This browser cannot use passkeys for this. Keep your token instead.");
}

// second device, from a click
await store.link({ provider: "passkey" });   // one passkey prompt; no-provider if declined
```

`protect("passkey")` creates a discoverable passkey (user verification required, no attestation)
and evaluates the WebAuthn PRF extension with a fixed salt. From the PRF output it derives a
wrapping key, a write-token key and a document id, and writes the token, encrypted, at that id in
the shared store. The passkey itself never becomes the secret, so several passkeys (one per
platform) can each hold a keyslot for the same token.

`link({ provider: "passkey" })` evaluates the PRF again, derives the same id, reads and unwraps the
keyslot. If the chosen passkey has no keyslot, or the user cancels, the call rejects with
`no-provider` and nothing changes.

PRF support varies by browser, operating system and authenticator, and not every security key
offers it. `passkey().available()` checks without prompting. Cross-ecosystem use (an Apple passkey on Windows) goes through the browser's QR/hybrid
flow. **The storage token is the path that always works**; offer it alongside the passkey.

## What to show

The demo (`demo/`, [user-journeys.md](user-journeys.md)) is the reference UI. Its rules:

1. **Always show the token in use** and where it came from (`BurrowArea.token`): generated here,
   pasted, opened from a link, restored from a passkey, remembered from an earlier visit.
2. **Nudge once.** `onUnprotected` fires once per device when there is data and no protection,
   usually soon after the first write. Register the listener right after `burrow()` resolves: the
   event is not repeated for listeners added later. Use it for a low-key banner, not a modal on
   first load. When the user confirms they saved the token, call `protect("sync-code")`, which
   records the copy (`protection` becomes `"code"`); `exportCode()` alone does not.
3. **Confirm before discarding.** `link()` and `unlink()` reject with `would-orphan` when this
   device has writes that never synced. Ask, then retry with `discardLocal: true`.
4. **Say it plainly:** "Burrow cannot reset your data. Keep your storage token."
5. On `decrypt-failed` (status `"error"`), tell the user to link the device again.

Shared computers: `burrow({ app, rememberDevice: false })` keeps the token in memory only and the
cache in memory too. Each session starts with a fresh token until the user links.

Logging out: `unlink()` forgets the token on the device. The remote documents stay; the next
`burrow()` generates a new token and clears the old token's cached items before use, so the next
user of the device never sees the previous one's data in the site. Until then the old items remain
in IndexedDB in plaintext; on a shared computer, `rememberDevice: false` keeps them off the disk
altogether.

## How sync works

- **Per item.** Each key is its own encrypted document; an encrypted **manifest** per app and user
  lists the keys with their timestamps. A push writes only the changed items, then the manifest.
  A pull reads the manifest and fetches only items that are newer than the cached copy. A pull
  with nothing new is one read.
- **Last writer wins, per key.** Each write carries the device's clock, bumped so it is never
  behind the latest timestamp the device has seen from the store (clock skew cannot make a new
  write lose to an old one). Equal timestamps are broken by a hash of the value, and a delete
  beats a value, so all replicas converge to the same answer.
- **Deletes are tombstones.** A removed key stays in the manifest as deleted for 30 days, so a
  device that was offline does not resurrect it. The item document is overwritten with a deleted
  marker and is never removed from the store.
- **Triggers.** Page load. Local writes, debounced 1.5 s. Page becomes visible. Every
  `syncIntervalMs` (30 s) while visible. A change notification from the Firestore listener on the
  manifest. `link()` and `syncNow()`. Page hidden or unloaded: pending writes are flushed to the
  cache and a push starts; if the page closes before it finishes, the writes go out on the next
  visit.
- **Conflicts.** A write that collides with another device is retried up to three times with
  jittered backoff (200 ms, 800 ms, 3 s) after re-reading the document; the manifest is where two
  devices usually collide, and merging it is a union of the two key directories.
- **Failures.** Network and quota errors set `status` to `"offline"` and back off exponentially
  from 2 s, capped at the larger of `syncIntervalMs` and 5 minutes. Unsynced writes are never
  dropped. A document that does not decrypt sets `"error"` and pauses sync until the device links
  again; the cache is left as it was.
- **Tabs.** Tabs of one app share the cache and tell each other about writes through a
  `BroadcastChannel`; each sync pass takes a `navigator.locks` lock so two tabs never push at once.
  Linking or unlinking in one tab switches or closes the other tabs of the same app.

The data model and algorithms in detail: [architecture.md](architecture.md).
