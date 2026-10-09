# Storage tokens, passkey backups and sync

How a user's data gets from one device to another, what the library does in the background, and
what a site should show. Signatures are in [api.md](api.md).

## Terms

| Term | Meaning |
| --- | --- |
| **Storage token** (or just **token**) | The 32-byte secret that owns a user's data. Whoever holds it can read and write that data from any device. Shown to people as 56 characters in groups of four, `07DV-1XKY-…`, which is also the form the API takes and returns: `exportToken()`, `link({ token })`. |
| **Passkey backup** | The token stored in a *keyslot* document in the shared store, wrapped under a key that only the passkey's PRF output can derive. One passkey, one keyslot. Optional, from `burrow-storage/passkey`. |
| **Linking** | Making this device use an existing token instead of the one it generated. |

The store only ever deals in the token. Getting it from one device to the next is the site's
choice: the user types or pastes it, a password manager fills it, a passkey backup returns it, or
the site's own mechanism does. Each one ends in `link({ token })`.

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
tokenEl.textContent = await store.exportToken();

// second device
try {
  await store.link({ token: input.value });
} catch (e) {
  if (e.code === "bad-token") say("That token is not right. Check it and try again.");
}
```

- Decoding is forgiving: case, spaces and hyphens are ignored, `O` reads as `0`, `I` and `L` as
  `1`. The alphabet has no `I`, `L`, `O` or `U`.
- A 16-bit checksum catches typos: a wrong token rejects with `bad-token` before any network call
  and nothing changes. A random well-formed string passes the checksum about once in 65 536
  attempts and is then adopted as a new, empty token. The demo therefore always shows the token
  in use, so the user can compare it with the one they meant to enter.
- It needs no WebAuthn, so it works in every supported browser, including those whose passkeys
  lack the PRF extension.
- A password manager is the natural place to keep it: the user saves it once on the first device
  and fills it in on the next.

## Second device, option 2: a passkey backup

```js
import { passkeyBackup } from "burrow-storage/passkey";
const backup = passkeyBackup({ userName: "notes" });

// first device, from a click, after keeping the current and earlier tokens
if (await backup.available() && confirm("An earlier notes passkey may be replaced, even if this save fails. Have you kept the storage tokens and want to continue?")) {
  try {
    await backup.save(await store.exportToken());
  } catch (e) {
    if (e.code === "prf-unsupported") say("This browser cannot use passkeys for this. Keep your token instead.");
  }
}

// second device, from a click: one passkey prompt
const token = await backup.restore();      // null if declined or no backup
if (token) await store.link({ token, source: "passkey" });
```

`save(token)` creates a discoverable passkey (user verification required, no attestation) and
evaluates the WebAuthn PRF extension with a fixed salt. From the PRF output it derives a wrapping
key, a write-token key and a document id, and writes the token, encrypted, at that id in the
shared store. The passkey itself never becomes the secret, so several passkeys (one per platform)
can each hold a keyslot for the same token.

Saving again with the same RP ID and `userName` may replace the earlier passkey; the effective
name defaults to the page's host. The app chooses the label and may append a distinguishing
suffix to keep separate backups. `displayName` defaults to that label, sets only the new
credential's visible name, and does not change its handle. Labels are visible to the password
manager; they are not private account identifiers.

Warn before each save and ask the user to keep the current and any earlier storage tokens.
Replacement happens before PRF evaluation and the keyslot write. Saving a different token
under the same label loses the old token's passkey route; even for the same token, a failed
save after creation can leave no usable passkey backup. The kept token or another backup is
the recovery route. Older random-handle duplicates remain. The replacement tests use only
Chromium's virtual authenticator; iCloud Keychain, Google Password Manager, Windows Hello,
1Password and Bitwarden have not been validated on real devices.

`restore()` evaluates the PRF again, derives the same id, reads and unwraps the keyslot, and
returns the token. If the chosen passkey has no keyslot, or the user cancels, it returns `null`
and nothing changes. Because the token comes back as a value, a `would-orphan` retry of `link()`
reuses it without a second prompt. `source: "passkey"` labels it in `store.token.source`, so the
UI can say where it came from.

PRF support varies by browser, operating system and authenticator, and not every security key
offers it. `backup.available()` checks without prompting. Cross-ecosystem use (an Apple passkey on
Windows) goes through the browser's QR/hybrid flow. **The storage token is the path that always
works**; offer it alongside the passkey.

## What to show

The demo (`demo/`, [user-journeys.md](user-journeys.md)) is the reference UI. Its rules:

1. **Always show the token in use** and where it came from (`BurrowArea.token`): generated here,
   pasted, restored from a passkey, remembered from an earlier visit.
2. **Nudge once.** A token whose `source` is `"generated"` was made on this device and, as far
   as Burrow knows, exists nowhere else. Once there is something worth keeping, show a low-key
   banner, not a modal on first load. Burrow cannot know whether the user kept the token, so
   remember a confirmed backup yourself. The demo stores it in the area, where it syncs with the
   data:

   ```js
   let nudged = false;
   store.onChanged.addListener(({ source }) => {
     if (nudged || source !== "local" || store.token.source !== "generated") return;
     if (store.storage.getItem("backup")) return; // the site's own record
     nudged = true;
     showBanner("Keep your storage token, or create a passkey backup, to get this back elsewhere.");
   });
   ```
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
