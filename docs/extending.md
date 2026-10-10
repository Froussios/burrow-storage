# Extending Burrow: backends and token carriers

Two things are yours to choose: the **backend**, where encrypted documents live, is a plain
interface from `burrow-storage` that nothing in the core special-cases; and **how a token reaches
another device**, which needs no interface at all, because the store only takes and gives a
string.

## Independent token and content storage

Keep token recovery independent of content storage. This is a design requirement for extensions
and new backends: the storage implementation takes a token string, while the site chooses how
to keep or recover it. Neither side should require access to the other's state or service.
This lets a site choose availability, ownership, cost and retention separately for recovery
and content. The decision is recorded in D-50 in [decisions.md](decisions.md).

The token-access API is independent of content I/O: `exportToken()` and `link({ token })`
exchange a string, and the optional `PasskeyBackup.save()` / `restore()` utility accesses its
own selected backend. Retrieving a stored token with an available credential, including
`PasskeyBackup.restore()`, is supported token access. Recovery after losing authenticating
credentials is outside the project's scope. Reusing the envelope `Backend` protocol does not
require sharing a configured instance or service.

The passkey utility implements `PasskeyBackup`, created by `passkeyBackup()` from
`burrow-storage/passkey`. It reuses the same `Backend` interface as the storage implementation,
but its backend instance is independently selectable. All three arrangements are supported:

- Encrypted token keyslots in a different Firebase project from the content.
- Encrypted token keyslots in another database through an adapter implementing `Backend`.
- The token kept directly in a password manager or another token carrier, with no keyslot
  backend and no passkey utility involved.

For example, two separately configured Firestore instances. Deploy the shipped
`firebase/firestore.rules` unmodified in both projects: content and keyslots use the same
`burrow` collection and write-token rules. See [Firestore setup](firestore-setup.md).

```js
import { burrow } from "burrow-storage";
import { FirestoreBackend } from "burrow-storage/firestore";
import { passkeyBackup } from "burrow-storage/passkey";

const contentBackend = new FirestoreBackend({
  apiKey: "content-project-browser-key",
  projectId: "content-project",
});
const tokenBackend = new FirestoreBackend({
  apiKey: "recovery-project-browser-key",
  projectId: "recovery-project",
});
const store = await burrow({ app: "my-app", backend: contentBackend });
const backup = passkeyBackup({ backend: tokenBackend });

// First device, after the site's passkey-replacement warning, from a click:
await backup.save(await store.exportToken());
// Later, on another device configured for these same stores, from a click:
const token = await backup.restore();
if (token) await store.link({ token, source: "passkey" });
```

Either backend can instead be another `Backend` implementation. Omitting the passkey utility's
backend resolves the page's configuration; it does not inherit a backend supplied only to
`burrow()`. Sharing one backend is a convenience, not a requirement. The site must configure the
appropriate stores on each device: neither the token nor the passkey contains backend config.
Each remote store must enforce its own envelope/write rules. Core sync must not assume it can
renew or enumerate keyslots, and a token carrier need not implement `Backend` at all.

## A backend for another store

A backend stores opaque envelopes at opaque ids and enforces one rule: a write must present the
expected revision. It knows nothing about users, apps, keys or encryption; a manifest, an item
and a keyslot look identical to it.

The interface is `Backend`, defined with a comment on every member in
[`src/types.ts`](../src/types.ts) and exported as a type from `burrow-storage`:

```ts
import type { Backend, BackendCapabilities, Envelope } from "burrow-storage";
import { BackendError } from "burrow-storage";   // what every failure must reject with
```

Its members are `id`, `capabilities`, `get(id)`, `put(id, env, expectedRev, opts?)`, and the
optional `getMany(ids)` and `subscribe(id, onChange)`.

### Contract

- `put(id, env, null)` creates; it must reject with `BackendError("conflict")` if a document
  exists. `put(id, env, n)` must reject with `conflict` unless the stored revision is exactly `n`.
  Two concurrent writers at the same `expectedRev` must see exactly one success. This is the
  optimistic-concurrency check the sync engine relies on.
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
- `subscribe(id, onChange)` is called with the user's manifest id only; call `onChange` with the
  new envelope when it changes and return an unsubscribe function. Burrow falls back to polling
  when it is absent.

### Verifying it

The conformance suite every adapter must pass unchanged is `test/conformance/suite.ts` in the
repository. It runs under vitest:

```ts
// test/conformance/my-store.test.ts
import { backendConformance } from "./suite.js";
import { MyBackend } from "../../src/backends/my-store.js";

backendConformance("MyBackend", () => new MyBackend({ /* … */ }));
```

It covers creates, chained updates, wrong tokens, skipped revisions, stale `expectedRev`,
concurrent writers, oversize documents, `getMany` parity and `subscribe` delivery. The Firestore
adapter passes it against the emulator (`npm run test:firestore`); `MemoryBackend` passes it in
`npm test`.

The underlying store must offer an atomic compare-and-set for `put`; Workers KV alone, for
example, does not.

See the [backend support overview](backend-candidates.md#support-status) for implemented
adapters, candidates, rejected direct variants and backend-scoped follow-up issues. HTTP is
only a transport: define and verify its chain/CAS, access and error protocol in the chosen
backend's issue before implementing a generic client. No HTTP endpoint or candidate deployment
is supplied by the core.

## Another way to carry the token

There is no plug-in interface for this. The store deals only in the storage token, a 56-character
string: `exportToken()` hands it out and `link({ token, source })` takes it in. Anything that can
keep a string for the user and give it back can carry it: a password manager, a QR code shown on
one device and scanned on another, a file the user saves, your own service.

```js
// Keep it somewhere, from a click.
await myVault.put(await store.exportToken());

// Later, on another device, from a click.
const token = await myVault.get();
if (token) await store.link({ token, source: "vault" });
```

`source` is a label that Burrow records with the token and reports in `store.token.source`, so
the page can say where the token came from. It has no other effect.

Treat the token like a password. Whoever obtains it can read and overwrite the user's data, from
anywhere, for good: Burrow cannot revoke it. So do not put it in a URL, a log, analytics or an
error report, and encrypt it at rest under something only the user has, as the passkey backup does.

The passkey backup, [`src/passkey.ts`](../src/passkey.ts), is the reference: it is built only on
`exportToken()` and `link()` plus a backend for its keyslot, with no access to the store's state.

## Page configuration

The built-in `firestore` factory loads the adapter on demand. Configure a store directly:

```js
import { burrow } from "burrow-storage";

const store = await burrow({
  app: "my-app",
  backend: { type: "firestore", apiKey: "…", projectId: "your-project" },
});
```

`firestore: { apiKey, projectId }` is shorthand; `appId` is optional. An explicit backend
instance still works. Caller `backend` takes precedence over `firestore`, which takes
precedence over page config. The first call for an app fixes its configuration for the page.

Without either caller option, discovery checks, in order:

1. `<meta name="burrow-backend" content='{"type":"firestore","apiKey":"…","projectId":"your-project"}'>`;
2. `window.BURROW.backend`, using the same config object;
3. legacy `<meta name="burrow-firestore">` and then `window.BURROW.firestore`.

Malformed or incomplete config and an unregistered type produce a usable local store with
`status: "error"`; `syncNow()` rejects `BurrowError("backend")`. Local writes stay dirty in
the cache. Burrow never silently selects a different project after a config error. Correct
configuration and reload the page to enable sync. No config gives the ordinary `idle`
local-only store. `readFirestoreConfig()` reads only the legacy Firestore config and throws
on malformed JSON; it does not interpret generic config.

Register your adapter factory before opening a store. Config is publishable data; keep admin
credentials on the server. A factory may use a dynamic import for its own adapter subpath.
Here is a small test-store example using an existing adapter:

```js
import { burrow, registerBackend, MemoryBackend } from "burrow-storage";

registerBackend("test-store", async () => new MemoryBackend());
const store = await burrow({ app: "my-app", backend: { type: "test-store" } });
```

`registerBackend(type, factory)` accepts a lowercase letters/digits/hyphens type of 1–64
characters and a factory `(config: BackendConfig) => Backend | Promise<Backend>`. Duplicate
registration throws, including attempts to replace `firestore`. The factory receives the
entire `{ type, …options }` object and validates its own fields. Registration does not run it;
only selecting its type does. Page JSON never supplies a module URL or executable code.

Factories create or load an adapter and must settle promptly. Keep remote connectivity
checks and document requests in the backend's I/O methods (`get`, `put`, `getMany`,
`subscribe`), so initialization can open local storage while the remote service is
unavailable. Initialization awaits the factory: one that never settles prevents local
storage from opening.

The ESM Firestore adapter remains in `burrow-storage/firestore`; the script-tag build exposes
`Burrow.FirestoreBackend` and loads its SDK from the same-origin `burrow-firestore.js` file.
New adapters should use their own subpath and a separate measured budget. `npm run size`
enforces 2 KiB min+gzip for the Firestore adapter excluding its SDK, and 150 KiB for that
lazy SDK. Core + memory remains 12 KiB and passkey backup adds at most 2 KiB.

See [backend candidates](backend-candidates.md) for the current feasibility assessment. A
registered adapter is not certified merely because a factory can instantiate it: its actual
server policy, concurrency, quota behavior, CORS and access restrictions need verification.
