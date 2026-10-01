# Burrow

**Persistent, cross-device user data for static sites. No login, no backend, nothing readable in the store.**

A burrow is dug by its owner, hidden from everyone else, and found only by one who knows the entrance.
Burrow gives a static website per-user key/value storage that survives a browser reset and follows the
user to their other devices. The user's device holds a secret; the secret derives unguessable document
ids and an encryption key; the documents sit in one shared free store (Firestore on the Spark plan by
default) that any number of prototypes can reuse. The site ships static files only.

> **Status: design complete, implementation not started.** The requirements, design review,
> architecture and work plan are in [`docs/`](docs/). Work is tracked in GitHub issues, one per work
> package. If you are an agent picking this up, start with [`CLAUDE.md`](CLAUDE.md).

## What it will look like

```ts
import { burrow } from "burrow-storage";

const store = await burrow({ app: "my-prototype" });
await store.set({ theme: "dark" });
const { theme } = await store.get("theme");

store.onChanged.addListener(({ changes, source }) => { /* "local" | "remote" */ });
```

Script tag, no bundler:

```html
<meta name="burrow-firestore" content='{"projectId":"your-project","apiKey":"your-web-api-key"}'>
<script src="https://cdn.example/burrow.min.js" integrity="sha384-…" crossorigin="anonymous"></script>
<script>
  const store = await Burrow.burrow({ app: "my-prototype" });
</script>
```

Drop-in for `localStorage`:

```ts
const store = await burrow({ app: "notes" });
const s = store.storage;        // implements the DOM Storage interface, synchronous
s.setItem("draft", text);       // write-behind to the local cache and the store
```

Second device:

```ts
await store.protect();                        // enrol a passkey (default) for one-prompt recovery
const code = await store.exportCode();        // or show the 56-character sync code
// on the other device:
await store.link({ code });                   // or store.link() to use the passkey
```

## How it works, in one paragraph

`burrow()` generates a random 256-bit root secret on first use and keeps it on the device, wrapped,
like a session cookie; the user is never prompted. From the secret and the `app` id it derives a path
key, an encryption key and a write-token key. Each item is one encrypted document whose id is an HMAC
of the key name; an encrypted **manifest** document lists the keys. The store allows anyone to read a
document by id and nobody to list them. Writes are gated by a per-document hash chain that the
store's rules verify with SHA-256, so knowing an id lets you read ciphertext but never overwrite it.
Reads and writes hit the local cache first; sync is background and per key, with last-writer-wins
merge and tombstones. A passkey (WebAuthn PRF) or a typed sync code carries the secret to another
device.

## Properties

- **No login.** No account, email or consent screen. Identity is a secret the user holds.
- **No backend.** One shared Firestore project on the free Spark plan serves every prototype. The
  store can be swapped by implementing a five-member `Backend` interface.
- **Local-first.** `get`/`set` resolve from the cache; the UI never waits on the network.
- **Zero trust in the store.** A dump of the store reveals ids that are hashes and contents that are
  AES-GCM ciphertext. See [`SECURITY.md`](SECURITY.md) for what the store *does* learn.
- **Familiar shape.** The API mirrors `chrome.storage.StorageArea`; a `Storage` facade replaces
  `localStorage`.
- **Graceful failure.** Offline or over quota, the site keeps working locally and sync resumes.

## What it is not

Not multi-user, not real-time, not for media files, not an identity system. **Burrow cannot reset
your data.** If the secret is lost on every device and no passkey or sync code exists, the data is
gone; sites using Burrow must say so to their users.

## Documentation map

| File | What |
|---|---|
| [`docs/requirements.md`](docs/requirements.md) | The requirements, snapshot of the source doc, with numbered requirement ids |
| [`docs/design-review.md`](docs/design-review.md) | Validation of the design: contradictions, gaps and the resolutions adopted |
| [`docs/architecture.md`](docs/architecture.md) | The implementation spec: exact encodings, schemas, algorithms, module layout |
| [`docs/decisions.md`](docs/decisions.md) | Decision records |
| [`docs/implementation-plan.md`](docs/implementation-plan.md) | Milestones, work packages, dependency graph, definitions of done |
| [`SECURITY.md`](SECURITY.md) | Cryptographic design and threat model |
| [`CLAUDE.md`](CLAUDE.md) | Working instructions for agents and contributors |

## Licence

MIT.
