# Migrating from localStorage

`store.storage` is a synchronous `Storage` object backed by Burrow's local cache. For most sites,
swapping the identifier is the whole migration; the repository's acceptance test
(`test/sample-app/`) does exactly that find-and-replace on a sample app and runs the app's own
tests against both. The differences that can matter are listed below.

## Steps

1. Open Burrow once, before the code that uses storage runs:

   ```js
   import { burrow } from "burrow-storage";
   const store = await burrow({ app: "my-app" });
   const storage = store.storage;
   ```

   With a script tag: `const store = await Burrow.burrow({ app: "my-app" })`. The promise resolves
   after the whole cache is loaded, so the first `getItem` is already correct.

2. Replace `localStorage` with `storage` (or assign `window.appStorage = store.storage` and use
   that). Nothing else changes:

   | Works as before | Notes |
   | --- | --- |
   | `getItem`, `setItem`, `removeItem`, `clear`, `key(i)`, `length` | Synchronous |
   | `storage.theme`, `storage["theme"] = "dark"`, `delete storage.theme` | Property access through a Proxy |
   | `"theme" in storage`, `Object.keys(storage)` | Enumerates live keys |
   | `setItem("n", 42)` stores `"42"` | `String(value)`, as `localStorage` does |

3. Optionally import what the user already has in real `localStorage`, once:

   ```js
   if (storage.length === 0) {
     for (let i = 0; i < localStorage.length; i++) {
       const k = localStorage.key(i);
       storage.setItem(k, localStorage.getItem(k));
     }
   }
   ```

4. React to changes from other devices and tabs with `store.onChanged`; Burrow does not fire the
   window `storage` event.

## Differences from localStorage

- **It exists only after `burrow()` resolves.** `localStorage` is there before your first line of
  code runs; `store.storage` is not. Code that reads storage during start-up, for example to apply
  a theme before first paint, has to wait for `burrow()` (a few milliseconds from a warm cache).
- **Writes are write-behind.** `setItem` updates the in-memory mirror immediately and persists
  to IndexedDB in the background, batched per microtask. Pending writes are flushed when the page
  is hidden or unloaded. A storage failure is logged with `debug: true` rather than thrown.
- **Other tabs see a write a moment later.** A tab learns of another tab's write once it reaches
  the cache, usually within milliseconds, and reports it on `onChanged`. `localStorage` is
  visible to every tab at once.
- **One namespace per app.** `localStorage` is shared by the whole origin; each Burrow `app` has
  its own keys, so two apps on one origin do not see each other's data.
- **Size limit.** An item larger than `maxItemBytes` (default 200 000 bytes) throws
  `BurrowError("item-too-large")` synchronously instead of a `QuotaExceededError`.
- **Values written through the async API** (`store.set({ n: 42 })`) come back from `getItem("n")`
  as their JSON text, `"42"`. Strings come back unchanged.
- **Key order** from `key(i)` and `Object.keys()` is insertion order.
- `storage instanceof Storage` is false; `Object.prototype.toString.call(storage)` is
  `"[object Storage]"`.
- After `unlink()`, writes throw `BurrowError("no-provider")`; call `burrow()` again.

## Using both APIs

The facade and the async API share the same keys. A site can migrate call sites gradually, keep
`storage` for the legacy code and use `store.set()` / `store.get()` with real JSON values in new
code. `onChanged` reports writes from either side.
