# Storage tokens, passkeys and sync

Where the user's token comes from, who keeps it, how the offline wrapper syncs, and what a site
should show. Signatures are in [api.md](api.md); the design is D-57 to D-59 in
[decisions.md](decisions.md).

## Terms

| Term | Meaning |
| --- | --- |
| **Storage token** (or just **token**) | The 32-byte secret that owns a user's data. Whoever holds it can read and write that data from any device. Shown to people as 56 characters in groups of four, `07DV-1XKY-…`, which is also the form the API takes: `burrow({ token })`. |
| **Passkey token** | A token derived from a passkey's WebAuthn PRF output by `passkeyToken()` from `burrow-storage/passkey`. The same passkey gives an app the same token wherever the passkey is available. Nothing is stored. |
| **Core** | `burrow()`: remote storage only. It holds the token's keys in memory and nothing on disk. |
| **Offline wrapper** | `offline(store)` from `burrow-storage/offline`: the same interface over an unencrypted local copy. |

The store only ever deals in the token string. Burrow never generates one by itself, never
recovers one, and never remembers one between page loads. Getting the token, and keeping it, is
the site's choice: the user types or pastes it, a password manager fills it, a passkey gives it,
or the site keeps it.

## Getting a token

### A new identity

```js
const token = await generateToken();
tokenEl.textContent = token; // ask the user to keep it
const store = await burrow({ app: "notes", backend, token });
```

A new token has no data. Burrow keeps no copy of it, so if the user does not keep it and no
passkey gives it, the data is unreachable once the page lets go of it.

### The storage token, typed or pasted

```js
try {
  const store = await burrow({ app: "notes", backend, token: input.value });
} catch (e) {
  if (e.code === "bad-token") say("That token is not right. Check it and try again.");
  else throw e;
}
```

- Decoding is forgiving: case, spaces and hyphens are ignored, `O` reads as `0`, `I` and `L` as
  `1`. The alphabet has no `I`, `L`, `O` or `U`.
- A 16-bit checksum catches typos: a wrong token rejects with `bad-token` before any network call.
  A random well-formed string passes the checksum about once in 65 536 attempts and is then
  opened as a new, empty identity. Show the token in use, so the user can compare it with the
  one they meant to enter.
- It needs no WebAuthn, so it works in every supported browser.
- A password manager is the natural place to keep it.

### Passkeys

```js
import { burrow } from "burrow-storage";
import { passkeyToken } from "burrow-storage/passkey";
const passkey = passkeyToken({ app: "notes" });

// first time, from a click: a new passkey and a new identity
const created = await passkey.create();

// any later visit, on any device with that passkey, from a click: one prompt
try {
  const token = await passkey.get();
  const store = await burrow({ app: "notes", backend, token });
} catch (e) {
  if (e.code === "cancelled") say("No passkey was used.");
  else if (e.code === "prf-unsupported") say("Use your storage token instead.");
  else throw e;
}
```

`create()` makes a discoverable passkey (user verification required, no attestation, a random
user handle) and evaluates the WebAuthn PRF extension with a fixed input; `get()` asks the user to
pick an existing passkey and evaluates it the same way. The PRF output, run through HKDF with the
app id, is the token: deterministic for that passkey and app, unrelated between apps, and stored
nowhere.

What this does and does not give:

- **The passkey is not a vault.** WebAuthn does not let a page store a chosen value in a passkey
  and read it back (the `largeBlob` extension can, but whether it works is up to the browser and
  the passkey provider, and Burrow does not use it:
  [WebKit added it in Safari 17](https://origin-devforums.apple.com/forums/thread/730133) while
  platform authenticators lagged, and a
  [2026 survey of credential managers](https://www.corbado.com/blog/webauthn-l3-credential-manager-support)
  lists it as provider-dependent). So the token is *derived*: `create()` makes a
  new identity, and there is no way to put an existing token into a passkey. A user who started
  with a pasted or generated token keeps that token as a string.
- **The token outlives nothing but its copies.** It can be recovered only while the passkey is
  available and supports PRF, or from a copy of the string. Deleting the passkey, or losing every
  device and account that holds it, loses that route; a new passkey is a new token. Show the token
  so the user can keep it too.
- **Each `create()` adds a passkey.** It never replaces one, so earlier identities stay
  reachable, but the user then picks from several passkeys at `get()`. Use a distinct
  `userName` if your app creates more than one on purpose.
- **Other devices depend on the provider.** A passkey synced by iCloud Keychain or Google
  Password Manager can give the same token on the user's other devices, if PRF works there.
  Cross-ecosystem use (a phone's passkey on a desktop through a QR code) goes through the
  browser's hybrid flow, which Burrow has not tested.
- **Cancel is a rejection.** WebAuthn reports a dismissed prompt, a timeout and "no matching
  passkey" as the same error, so all three reject `cancelled`; there is no empty token.

**Support** varies with the browser, the operating system, the authenticator and the passkey
provider, and both the browser and the authenticator must support PRF. `available()` checks what
the browser can tell without prompting; the authenticator the user picks may still lack PRF, and
`create()` then rejects `prf-unsupported` (and, where the browser allows, tells the provider the
useless passkey can be removed). Burrow's own tests run only against Chromium's virtual
authenticator. Third-party reports as of 2026, not verified by Burrow:

- Apple platforms: iCloud Keychain passkeys support PRF from macOS 15 and Safari 18; Chrome on
  macOS from about version 132.
  ([Yubico](https://developers.yubico.com/WebAuthn/Concepts/PRF_Extension/Developers_Guide_to_PRF.html),
  [compatibility matrix](https://github.com/kummahiih/private-circle/blob/main/docs/WEBAUTHN_PRF_SUPPORT.md))
- Android: Google Password Manager passkeys include PRF in Chrome, Edge and Samsung Internet.
  ([Corbado](https://www.corbado.com/blog/passkeys-prf-webauthn))
- Windows Hello: hmac-secret, which PRF needs, reportedly arrived with the February 2026 Windows 11
  updates, without Microsoft documentation.
  ([Corbado](https://www.corbado.com/blog/webauthn-l3-credential-manager-support))
- Security keys: support differs between browsers; reports on Safari conflict.
- Firefox: PRF on by default from about version 135; reported unreliable on Android.

**The storage token is the path that always works**; offer it alongside the passkey.

## Keeping the token: login often or login once

The core keeps the token's keys in memory until `close()` or the end of the page. What happens at
the next page load is up to the site:

| | Login often | Login once |
| --- | --- | --- |
| Token | In the page's memory only | Kept by the page (the demo uses `localStorage`) |
| Store | The core | The offline wrapper over the core |
| Next visit | Ask again: a passkey prompt, or the token pasted | Opens at once, with no prompt |
| Offline | Nothing works | Reads and writes use the local copy |
| On the device | Nothing | The token, as the page stores it, and an unencrypted copy of the data |
| Copied browser profile | Gets nothing | Gets the data and the token: lasting read-write access, since tokens cannot be revoked |

Burrow never persists the token for you, under any option. If a site stores it, the site owns
that choice and should say plainly what it means. A passkey makes "login often" cheap: one prompt
per visit, nothing on the device. The demo implements both columns with honest explanations
([user-journeys.md](user-journeys.md)).

## What to show

The demo (`demo/`, [user-journeys.md](user-journeys.md)) is the reference UI. Its rules:

1. **Never make up a token silently.** Offer "use my passkey", "create a passkey", "start with a
   new token" and "enter a token".
2. **Show the token in use** and where it came from, so a mistyped token is visible.
3. **Say where it is kept**: "in this page's memory only" or "kept by this page in this browser,
   unencrypted".
4. **Say it plainly:** "Burrow cannot reset your data. Keep your storage token, or your passkey if
   it gave you the token."
5. **Before signing out with unsynced writes, ask.** The offline wrapper's `forget()` rejects
   `would-orphan` while writes are unsynced; retry with `discardLocal: true` only after the user
   agrees to lose them.
6. On `decrypt-failed`, tell the user the token cannot read the stored data; on `expired`, that
   synced content expired and the local copy is kept.

## How the offline wrapper syncs

- **Per item.** Each key is its own encrypted document; an encrypted **manifest** per app and
  token lists the keys with their timestamps. A push writes only the changed items, then the
  manifest. A full refresh reads the manifest and fetches only items newer than the local copy.
- **Network first.** `get()` asks the store and merges the answer into the copy; `set()` and
  `remove()` store the write in the copy, then push it. Each waits for the store up to 3 seconds,
  then answers from the copy and lets the remote work finish in the background.
- **Offline.** After a failure, or while the browser says it is offline, calls use the copy at
  once. Retries back off exponentially from 2 s to 5 minutes; the network coming back and
  `syncNow()` retry at once. Unsynced writes are never dropped.
- **Last writer wins, per key.** A write made while the store answers is stamped above whatever
  the store holds, so it wins as the latest. A write made offline keeps its own time (bumped
  above every timestamp the device has seen, so clock skew cannot make it lose to something it
  already saw); when it is replayed, a newer write made elsewhere wins and the copy takes that
  value. Equal timestamps are broken by a hash of the value, and a delete beats a value, so all
  replicas converge.
- **Deletes are tombstones.** A removed key stays in the manifest as deleted for 30 days, so a
  device that was offline does not resurrect it. The item document is overwritten with a deleted
  marker and is never removed from the store. Deleting a key the copy does not show is ignored
  offline; online it is kept like any write until the store has it.
- **Remote changes.** The wrapper subscribes to the manifest where the backend can notify
  (Firestore does), refreshes when the page becomes visible or the network returns, and reports
  what changed on `onChanged` with `source: "remote"`. It does not poll.
- **Conflicts.** A write that collides with another device is retried up to three times with
  jittered backoff (200 ms, 800 ms, 3 s) after re-reading the document; the manifest is where two
  devices usually collide, and merging it is a union of the two key directories.
- **Failures.** Network and quota errors set `status` to `"offline"`. A document that does not
  decrypt, or an expiry stub, sets `"error"` and stops remote work for that instance; the local
  copy and unsynced writes stay and keep working.
- **One copy per token.** The copy is named by a fingerprint of the token, so a device that opens
  the app with another token sees that token's data, and the first token's copy, unsynced writes
  included, is there again when it returns. `forget()` deletes the current one.
- **Tabs.** Tabs of one app and token share the copy and tell each other about writes through a
  `BroadcastChannel`; replays and renewals take a `navigator.locks` lock so two tabs never push
  the same write at once. `forget()` in one tab closes the others.

The core alone has none of this: each call goes to the store and rejects if it cannot. The data
model and algorithms in detail: [architecture.md](architecture.md).

## Inactive content and expiry

The offline wrapper renews listed content about every 30 days per device; the core alone renews
only what it writes. An operator may run optional content-only cleanup after 395 days since a
document's server write time. A permanent expiry stub makes the core reject `expired`, and makes
the offline wrapper pause remote work while keeping its copy and unsynced writes. Before choosing
a fresh token with unsynced local data, read the data with `get()` and save it; then use the
fresh token and write it again. This is an app/user choice, not backend migration or automatic
republication. Full policy and limits: [retention.md](retention.md).
