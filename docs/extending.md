# Extending Burrow: backends and unlock methods

Two seams are pluggable: the **backend** (where encrypted documents live) and the **unlock
methods** (how a token reaches another device). Both are plain interfaces from `burrow-storage`;
nothing in the core special-cases the built-ins.

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
- `keepalive` and `opts.keepalive` are declared for adapters that can honour them (a `fetch` with
  `keepalive: true`); the shipped backends do not use them yet.

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

## An unlock method

> **Planned change.** [#28](https://github.com/Froussios/burrow-storage/issues/28) proposes
> replacing this interface: only the token would cross the API, with passkey storage as a separate,
> optional utility.

An unlock method is a `KeyProvider`: it stores the storage token somewhere off the device and
returns it later. Burrow ships `passkey()` and `syncCode()`. `KeyProvider` and the context types
it receives (`EnrolContext`, `RecoverContext`, `ProviderStore`) are defined with a comment on every
member in [`src/types.ts`](../src/types.ts).

### How Burrow calls a provider

Providers are configured with `BurrowConfig.keyProvider`; the list replaces the default
`[passkey(), syncCode()]`. Only Burrow calls them:

| `BurrowArea` method | Provider calls | Records the provider's id in |
| --- | --- | --- |
| `protect(id?)` | `available()`, then `enrol(ctx)` on the provider named `id`, or on the first available one | `BurrowArea.protection` |
| `link({ provider? })` | `available()`, then `recover(ctx)` on the provider named `provider`, or on each in order until one returns a token | `BurrowArea.protection` and `BurrowArea.token.source` |

The id `"sync-code"` is recorded as `"code"`. When `link()` recovers the token already in use, only
a `protection` of `"none"` is updated.

### Contract

- `available()` must answer without prompting the user.
- `enrol(ctx)` receives the token as `ctx.rootSecret`, zeroised after the call; do not keep a
  reference. A provider that writes to the backend should store an envelope chained under a key
  derived from its own material, as `passkey()` does.
- `recover(ctx)` may prompt (`ctx.interactive` is true). It returns the 32-byte token, or `null`
  when the user declined or nothing was found. If it throws, Burrow tries the next provider.
- On a local-only page, `ctx.backend` is `null` at runtime despite its type.
- A token derived from user input (a passphrase) must go through PBKDF2-SHA-256 with at least
  600 000 iterations and is tagged with version byte `0x02` in the storage-token encoding
  (reserved; v1 ships only random tokens, `0x01`).

The built-in providers, [`src/providers/passkey.ts`](../src/providers/passkey.ts) and
[`src/providers/synccode.ts`](../src/providers/synccode.ts), are the reference implementations.
