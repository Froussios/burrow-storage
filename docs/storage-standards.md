# Burrow and the browser's storage APIs

`burrow()` resolves to a `BurrowArea`, which offers two interfaces to the same data:

- `BurrowArea` itself follows `chrome.storage.StorageArea` from the WebExtensions API.
- Its `storage` property implements the Web Storage `Storage` interface, the one behind
  `localStorage`.

Both are declared in [`src/types.ts`](../src/types.ts). This page shows how to set Burrow up, then
lists exactly where each interface differs from the standard it imitates.

## Setting up

1. **Backend.** Without one, data stays on the device. To sync across devices, configure Firestore
   once ([firestore-setup.md](firestore-setup.md)).
2. **Library.** `dist/burrow.min.js` defines the global `Burrow`; the `burrow-storage` package
   exports the same API ([README](../README.md#quick-start)).
3. **`burrow({ app })`** resolves to the app's `BurrowArea`, once per page. Neither interface
   exists before it resolves. Both read and write the same keys.

The [API reference](api.md) documents every member.

## `BurrowArea.storage` and Web Storage

`BurrowArea.storage` implements the
[`Storage` interface](https://html.spec.whatwg.org/multipage/webstorage.html#the-storage-interface)
synchronously: its six members and named-property access. A named property never shadows one of
the six members; `getItem()` reads such a key. It differs from `localStorage` in these ways:

| | Web Storage (`localStorage`) | `BurrowArea.storage` |
| --- | --- | --- |
| When it exists | Before any script runs | Once `burrow()` resolves, a few milliseconds from a warm cache |
| Scope | The whole origin | One `app`; two apps on an origin have separate keys |
| Values | Strings; `setItem` stores `String(value)` | The same for `setItem`. A value written through the async API with `set()` reads back as its JSON text. |
| Persistence | Synchronous; the browser persists it | Visible at once, written to IndexedDB in the background (batched per microtask), and flushed when the page is hidden or closed. A failed background write is not reported. |
| Other tabs | See a write at once, and get a `storage` event | See it once it reaches IndexedDB, usually within milliseconds; no `storage` event is fired, use `BurrowArea.onChanged` |
| Size limit | An origin-wide quota, typically about 5 MB; exceeding it throws `QuotaExceededError` | No total quota of its own. Each item is limited to `maxItemBytes` (200 000 bytes of JSON by default); exceeding it throws `BurrowError("item-too-large")` |
| Key order for `key(i)` | Implementation-defined | Also implementation-defined: keys loaded from the cache come in sorted order, and keys added later follow in insertion order |
| `instanceof Storage` | `true` | `false`; `Object.prototype.toString.call(s)` still gives `"[object Storage]"` |
| After `BurrowArea.unlink()` | Not applicable | Writes throw `BurrowError("unlinked")`; call `burrow()` again for a new `BurrowArea` |
| Clearing site data | Deletes the data | Deletes the local copy; the data stays in the store, reachable with the storage token |
| Other devices | Never | Writes sync to every device that uses the same storage token |

## `BurrowArea` and `chrome.storage.StorageArea`

`BurrowArea` mirrors `chrome.storage.StorageArea` from the WebExtensions API: `get`, `set`,
`remove`, `clear`, `getBytesInUse` and `onChanged`, with the same argument shapes. `get()` accepts
nothing or `null` for every key, one key, an array of keys, or an object whose values are defaults.
It differs in these ways:

| | `chrome.storage.StorageArea` | `BurrowArea` |
| --- | --- | --- |
| Availability | Browser extensions only | Any web page in a secure context (HTTPS or `localhost`) |
| Call style | Promises, or callbacks with `chrome.runtime.lastError` | Promises only |
| Values | JSON-serialisable values; other objects are coerced (a `Map` is stored as `{}`, for example) | JSON values only; anything else rejects with `TypeError` instead of being coerced |
| `onChanged` payload | `changes`, plus the area name on `chrome.storage.onChanged` | `{ changes, source }`, where `source` is `"local"` for writes on this device and `"remote"` for changes pulled from the store. Listen with `addListener(fn)` or `addEventListener("changed", …)` |
| Limits | `storage.sync`: about 100 KB in total and 8 KB per item; `storage.local`: about 10 MB | 200 000 bytes per item by default (up to 749 000), no item count limit, and the quotas of the backing store |
| Errors | Rejections with a message | `BurrowError` with a stable `code` (see [api.md](api.md#errors)) |
| Not implemented | | `setAccessLevel()`, `getKeys()`, the `QUOTA_*` constants and the area name |

`BurrowArea` adds members of its own for sync and tokens (`status`, `token`, `link()`, `unlink()`,
`exportToken()`, `syncNow()` and others), described in the [API reference](api.md).

Writing a key to the value it already has is still a new write that syncs, so the last writer
wins across devices; like `chrome.storage`, Burrow fires no `onChanged` event for it.
