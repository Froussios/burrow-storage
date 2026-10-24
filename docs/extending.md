# Extending Burrow: backends and token custody

Two things are yours to choose: the **backend**, where encrypted documents live, is a plain
interface from `burrow-storage` that nothing in the core special-cases; and **how the user's token
is kept and brought back**, which needs no interface at all, because the store only takes a
string.

## Token custody stays outside the store

The core takes the token as a string at `burrow({ token })` and keeps only the keys derived from
it, in memory (D-57). The offline wrapper never sees more than the core does. Neither persists
the token, and neither depends on how it was obtained, so a site can combine any of these:

- the passkey utility, `passkeyToken()` from `burrow-storage/passkey`, which derives the token
  from a passkey and stores nothing (D-58);
- the user's password manager, or any place the user keeps a 56-character string;
- the site's own storage, which then carries the site's own security story.

There is no online token store: no keyslot, recovery document or backup service is part of
Burrow (D-58 supersedes D-50's independent recovery backend). Extensions must keep it that way:
the store takes a token string and never asks a token carrier for anything, and a token carrier
needs no access to the store's state or backend.

## A backend for another store

A backend stores opaque envelopes at opaque ids and enforces one rule: a write must present the
expected revision. It knows nothing about users, apps, keys or encryption; a manifest and an
item look identical to it.

The interface is `Backend`, defined with a comment on every member in
[`src/types.ts`](../src/types.ts) and exported as a type from `burrow-storage`:

```ts
import type { Backend, BackendCapabilities, Envelope, StoredDocument, PutOptions } from "burrow-storage";
import { BackendError } from "burrow-storage";   // what every failure must reject with
```

Its members are `id`, `capabilities`, `get(id)`, `put(id, env, expectedRev, opts?)`, and the
optional `getMany(ids)` and `subscribe(id, onChange)`. Client use drives content renewal; backend
adapters do not schedule it. See [retention.md](retention.md) for owner-only cleanup and
dedicated content-target selection.

### Contract

- `put(id, env, null)` creates; it must reject with `BackendError("conflict")` if a document
  exists. `put(id, env, n)` must reject with `conflict` unless the stored revision is exactly `n`.
  Two concurrent writers at the same `expectedRev` must see exactly one success. This is the
  optimistic-concurrency check every write relies on.
- `get`/`getMany`/`subscribe` return `StoredDocument` (an `Envelope` or `{ x: true, rev, next }`
  owner stub). Preserve the flag and notify even at an unchanged revision. Ordinary `put` must
  atomically reject `BackendError("expired")` on a stub; explicit `PutOptions.replaceExpired`
  opts into replacement while retaining revision/write-chain checks. Never auto-delete a stub.
- A store that can verify the write chain (`writeAuth: true`) also rejects, with `unauthorized`,
  any update whose `env.rev` is not `stored.rev + 1` or whose `SHA-256(env.tok)` (hex, lowercase,
  over the UTF-8 text of the base64url token) is not the stored `next`, and any create with
  `env.rev !== 0` or a malformed envelope. The envelope shape is: only the fields
  `v, iv, ct, rev, ts, tok, next, z`; `v === 1`; integer `rev` and `ts`; `iv` of 16 characters;
  `tok` of at most 64; `next` of exactly 64; `z` absent or `true`; the id 43 characters.
  `wellFormed(id, env)` in `src/backends/memory.ts` implements this check; it is not exported
  from the package, so copy it if you need it.
- A store that cannot verify the chain declares `writeAuth: false`. Burrow warns once in the
  console, because anyone who learns an id can then overwrite that document.
- Map every failure to a `BackendError` with one of `conflict`, `unauthorized`, `too-large`,
  `quota`, `network`. Unknown errors are `network` and are retried with backoff.
- Never log, index or retain ids beyond what the store itself needs. Ids are capabilities.
- `subscribe(id, onChange)` is called by the offline wrapper with the user's manifest id only;
  call `onChange` with the new envelope when it changes and return an unsubscribe function.
  Without it, the wrapper learns of remote changes only when it reads or syncs.

### Verifying it

The conformance suite every adapter must pass unchanged is `test/conformance/suite.ts` in the
repository. It runs under vitest:

```ts
// test/conformance/my-store.test.ts
import { backendConformance } from "./suite.js";
import { MyBackend } from "../../src/backends/my-store.js";

backendConformance("MyBackend", () => new MyBackend({ /* … */ }),
  async (backend, id) => { /* test-only owner hook: replace with { x: true, rev, next } */ });
```

It covers creates, chained updates, wrong tokens, skipped revisions, stale `expectedRev`,
concurrent writers, oversize documents, `getMany` parity and `subscribe` delivery. The Firestore
adapter passes it against the emulator (`npm run test:firestore`); `MemoryBackend` passes it in
`npm test`.

The underlying store must offer an atomic compare-and-set for `put`; Workers KV alone, for
example, does not.

HTTP is only a transport: define and verify its chain/CAS, access and error protocol in the
chosen backend's issue before implementing a generic client. No HTTP endpoint or candidate
deployment is supplied by the core.

## Another way to keep the token

There is no plug-in interface for this. The store deals only in the storage token, a 56-character
string: `generateToken()` makes one, and `burrow({ token })` takes it. Anything that can keep a
string for the user and give it back can carry it: a password manager, a QR code shown on one
device and scanned on another, a file the user saves, your own service.

```js
// Keep it somewhere, from a click.
await myVault.put(token);

// Later, on another device, from a click.
const kept = await myVault.get();
if (kept) await burrow({ app: "my-app", backend, token: kept });
```

Treat the token like a password. Whoever obtains it can read and overwrite the user's data, from
anywhere, for good: Burrow cannot revoke it. So do not put it in a URL, a log, analytics or an
error report, and if you keep it at rest, protect it under something only the user has. Storing
it in plain `localStorage`, as the demo's "stay signed in" does, makes it readable to anyone with
the browser profile and to every script on the origin; say so to your users.

The passkey utility, [`src/passkey.ts`](../src/passkey.ts), is the reference: it uses no store
API at all, only WebAuthn and the token encoding.

## Page configuration

The built-in `firestore` factory loads the adapter on demand. Configure a store directly:

```js
import { burrow } from "burrow-storage";

const store = await burrow({
  app: "my-app",
  backend: { type: "firestore", apiKey: "…", projectId: "your-project" },
  token,
});
```

`appId` is optional. An explicit backend instance works too. `burrow()` never looks at the page:
to keep the config in the page, read it with `readBackendConfig()` and pass it on. That checks,
in order:

1. `<meta name="burrow-backend" content='{"type":"firestore","apiKey":"…","projectId":"your-project"}'>`;
2. `window.BURROW.backend`, using the same config object;
3. `<meta name="burrow-firestore">` and then `window.BURROW.firestore`, returned as
   `{ type: "firestore", … }`.

It returns `null` when the page has none, and throws `TypeError` for malformed JSON or a value
that is not an object, without echoing the value. `burrow()` rejects with `TypeError` for a
missing backend, an unregistered type or a malformed instance, and with
`BurrowError("backend", "backend configuration failed")` when a factory throws. It never falls
back to another project. `readFirestoreConfig()` reads only the Firestore shorthand.

Register your adapter factory before opening a store. Config is publishable data; keep admin
credentials on the server. A factory may use a dynamic import for its own adapter subpath.
Here is a small test-store example using an existing adapter:

```js
import { burrow, registerBackend, MemoryBackend } from "burrow-storage";

registerBackend("test-store", async () => new MemoryBackend());
const store = await burrow({ app: "my-app", backend: { type: "test-store" }, token });
```

`registerBackend(type, factory)` accepts a lowercase letters/digits/hyphens type of 1–64
characters and a factory `(config: BackendConfig) => Backend | Promise<Backend>`. Duplicate
registration throws, including attempts to replace `firestore`. The factory receives the
entire `{ type, …options }` object and validates its own fields. Registration does not run it;
only selecting its type does. Page JSON never supplies a module URL or executable code.

Factories create or load an adapter and must settle promptly. Keep remote connectivity
checks and document requests in the backend's I/O methods (`get`, `put`, `getMany`,
`subscribe`), so `burrow()` resolves, and the offline wrapper opens, while the remote service is
unavailable. `burrow()` awaits the factory: one that never settles keeps the store from opening.

The ESM Firestore adapter remains in `burrow-storage/firestore`; the script-tag build exposes
`Burrow.FirestoreBackend` and loads its SDK from the same-origin `burrow-firestore.js` file.
New adapters should use their own subpath and a separate measured budget. `npm run size`
enforces 2 KiB min+gzip for the Firestore adapter excluding its SDK, and 150 KiB for that
lazy SDK. Core + memory and core + offline wrapper + memory each stay within 12 KiB, and the
passkey token utility adds at most 2 KiB.

See the [backend support overview](backend-candidates.md#support-status) for implemented
adapters, candidates, rejected direct variants and backend-scoped follow-up issues. A registered
adapter is not certified merely because a factory can instantiate it: its actual server policy,
concurrency, quota behavior, CORS and access restrictions need verification.
