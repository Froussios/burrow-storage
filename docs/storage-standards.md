# Burrow and the browser's storage APIs

Burrow offers two interfaces to the same data. `store.storage` implements the Web Storage
`Storage` interface, the one behind `localStorage`. The store object itself follows
`chrome.storage.StorageArea`. This page shows how to set Burrow up, then lists exactly where each
interface differs from the API it imitates.

## Setting up

1. **Choose where the data syncs.** With no configuration, Burrow keeps data on the device only.
   To sync across devices, create a Firestore project once and put its public config on your
   pages ([firestore-setup.md](firestore-setup.md)).
2. **Load the library.** Either load `burrow.min.js` with a script tag, which defines the global
   `Burrow`, or install the package and import it. The [README](../README.md#quick-start) shows
   both forms.
3. **Open the store** for your app, once per page, before any code that reads it:

   ```js
   import { burrow } from "burrow-storage";
   const store = await burrow({ app: "my-app" });
   ```

4. **Use either interface,** or both; they share the same keys:

   ```js
   store.storage.setItem("theme", "dark");          // Web Storage style, synchronous
   await store.set({ draft: { text: "Hello" } });   // chrome.storage style, JSON values
   ```

The [API reference](api.md) documents every member.

## `store.storage` and Web Storage

`store.storage` implements the `Storage` interface from the
[HTML standard](https://html.spec.whatwg.org/multipage/webstorage.html): `length`, `key(index)`,
`getItem(key)`, `setItem(key, value)`, `removeItem(key)` and `clear()`, all synchronous, plus
named-property access (`s.theme`, `s.theme = "dark"`, `delete s.theme`, `"theme" in s`,
`Object.keys(s)`). Property access never reaches a key named after one of the six members; use
`getItem("key")` for those. It differs from `localStorage` in these ways:

| | `localStorage` | `store.storage` |
| --- | --- | --- |
| When it exists | Before any script runs | After `await burrow()` resolves, a few milliseconds from a warm cache |
| Scope | The whole origin | One `app`; two apps on an origin have separate keys |
| Values | Strings; `setItem` stores `String(value)` | The same for `setItem`. A value written through the async API with `set()` reads back as its JSON text. |
| Persistence | Synchronous; the browser persists it | Visible at once, written to IndexedDB in the background (batched per microtask), and flushed when the page is hidden or closed. A failed background write is not reported. |
| Other tabs | See a write at once, and get a `storage` event | See it once it reaches IndexedDB, usually within milliseconds; no `storage` event is fired, use `store.onChanged` |
| Size limit | An origin-wide quota, typically about 5 MB; exceeding it throws `QuotaExceededError` | No total quota of its own. Each item is limited to `maxItemBytes` (200 000 bytes of JSON by default); exceeding it throws `BurrowError("item-too-large")` |
| Key order for `key(i)` | Implementation-defined | Also implementation-defined: keys loaded from the cache come in sorted order, and keys added later follow in insertion order |
| `instanceof Storage` | `true` | `false`; `Object.prototype.toString.call(s)` still gives `"[object Storage]"` |
| After `store.unlink()` | Not applicable | Writes throw `BurrowError("no-provider")`; open a new store with `burrow()` |
| Clearing site data | Deletes the data | Deletes the local copy; the data stays in the store, reachable with the storage token |
| Other devices | Never | Writes sync to every device that uses the same storage token |

## The store object and `chrome.storage.StorageArea`

The asynchronous API mirrors `chrome.storage.StorageArea` from the WebExtensions API: `get`, `set`,
`remove`, `clear`, `getBytesInUse` and `onChanged`, with the same argument shapes. `get()` accepts
nothing or `null` for every key, one key, an array of keys, or an object whose values are defaults.
It differs in these ways:

| | `chrome.storage` | Burrow |
| --- | --- | --- |
| Availability | Browser extensions only | Any web page in a secure context (HTTPS or `localhost`) |
| Call style | Promises, or callbacks with `chrome.runtime.lastError` | Promises only |
| Values | JSON-serialisable values; other objects are coerced (a `Map` is stored as `{}`, for example) | JSON values only; anything else rejects with `TypeError` instead of being coerced |
| `onChanged` payload | `changes`, plus the area name on `chrome.storage.onChanged` | `{ changes, source }`, where `source` is `"local"` for writes on this device and `"remote"` for changes pulled from the store. Listen with `addListener(fn)` or `addEventListener("changed", …)` |
| Limits | `storage.sync`: about 100 KB in total and 8 KB per item; `storage.local`: about 10 MB | 200 000 bytes per item by default (up to 749 000), no item count limit, and the quotas of the backing store |
| Errors | Rejections with a message | `BurrowError` with a stable `code` (see [api.md](api.md#errors)) |
| Not implemented | | `setAccessLevel()`, `getKeys()`, the `QUOTA_*` constants and the area name |

Burrow adds members of its own for sync and tokens (`status`, `token`, `protect()`, `link()`,
`unlink()`, `exportCode()`, `syncNow()` and others), described in the [API reference](api.md).

Writing a key to the value it already has is still a new write that syncs, so the last writer
wins across devices; like `chrome.storage`, Burrow fires no `onChanged` event for it.
