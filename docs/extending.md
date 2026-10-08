# Extending Burrow: backends and token carriers

Two things are yours to choose: the **backend**, where encrypted documents live, is a plain
interface from `burrow-storage` that nothing in the core special-cases; and **how a token reaches
another device**, which needs no interface at all, because the store only takes and gives a
string.

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
