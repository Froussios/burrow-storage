# Burrow and the browser's storage APIs

`burrow()` resolves to a `BurrowStorage`, and the optional `offline()` wrapper to an
`OfflineStorage` that extends it (D-57). Both follow the argument shapes of
`chrome.storage.StorageArea` from the WebExtensions API, without claiming to be one. Neither
offers the synchronous Web Storage interface behind `localStorage`.

Both are declared in [`src/types.ts`](../src/types.ts). This page shows how to set Burrow up, then
lists exactly where it differs from the standards it is compared with.

## Setting up

1. **Backend.** Configure Firestore once ([firestore-setup.md](firestore-setup.md)), or another
   adapter. `burrow()` needs one.
2. **Token.** A storage token for the user: `generateToken()`, a passkey's
   (`passkeyToken().get()`), or one the user or the page kept
   ([sync-and-tokens.md](sync-and-tokens.md)).
3. **Library.** `dist/burrow.min.js` defines the global `Burrow`; the `burrow-storage` package
   exports the same API ([README](../README.md#quick-start)).
4. **`burrow({ app, backend, token })`** resolves to the store, and `offline(store)` to the wrapped
   one if you want a local copy. Every call opens a new instance.

The [API reference](api.md) documents every member.

## Burrow and `chrome.storage.StorageArea`

Both layers offer `get`, `set`, `remove` and `clear` with `StorageArea`'s argument shapes: `get()`
accepts nothing or `null` for every key, one key, an array of keys, or an object whose values
are defaults. The offline wrapper adds `onChanged`. It differs in these ways:

| | `chrome.storage.StorageArea` | Burrow |
| --- | --- | --- |
| Availability | Browser extensions only | Any web page in a secure context (HTTPS or `localhost`) |
| Call style | Promises, or callbacks with `chrome.runtime.lastError` | Promises only |
| Where calls go | The browser's own storage | The core: the network, every call. The offline wrapper: the network first, then the device's copy. |
| Failure | Rejections with a message | `BurrowError` with a stable `code` ([api.md](api.md#errors)). The core rejects when the store cannot be reached; the offline wrapper does not. |
| Values | JSON-serialisable values; other objects are coerced (a `Map` is stored as `{}`, for example) | JSON values only; anything else rejects with `TypeError` instead of being coerced |
| `onChanged` | On every area | Offline wrapper only: `{ changes, source }`, where `source` is `"local"` for writes on this device and `"remote"` for changes from the store. Listen with `addListener(fn)` or `addEventListener("changed", …)`. |
| Limits | `storage.sync`: about 100 KB in total and 8 KB per item; `storage.local`: about 10 MB | 200 000 bytes per item, no item count limit, and the quotas of the backing store |
| Not implemented | | `getBytesInUse()`, `setAccessLevel()`, `getKeys()`, the `QUOTA_*` constants and the area name |
| Extra members | | `close()`; on the offline wrapper `status`, `onStatus`, `syncNow()` and `forget()` |

Writing a key to the value it already has is still a new write, so the last writer wins across
devices; like `chrome.storage`, the offline wrapper fires no `onChanged` event for it.

## Burrow and Web Storage

Burrow has no synchronous `Storage` facade (D-57): the core cannot answer without the network,
and a facade over the offline wrapper is left to an optional adapter. Moving from `localStorage`:

| | Web Storage (`localStorage`) | Burrow |
| --- | --- | --- |
| Calls | Synchronous | Promises |
| When it exists | Before any script runs | Once `burrow()` (and `offline()`) resolve, with the token |
| Scope | The whole origin | One `app` and one token |
| Values | Strings | Any JSON value |
| Other tabs | A `storage` event | The offline wrapper's `onChanged`; the core has no events |
| On the device | Plaintext, until site data is cleared | The core: nothing. The offline wrapper: plaintext, until site data is cleared or `forget()` |
| Clearing site data | Deletes the data | Deletes the offline copy; the data stays in the store, reachable with the token |
| Other devices | Never | Every device that uses the same token |
