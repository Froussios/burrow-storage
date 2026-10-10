// Requirements brief, Acceptance criteria: "Swapping FirestoreBackend for
// MemoryBackend and for a WorkerBackend stub passes the same conformance suite
// unchanged."
import { backendConformance } from "./suite.js";
import type { Backend, StoredDocument } from "../../src/types.js";
import { createWorker, WorkerBackend } from "./worker.js";

const stores = new WeakMap<Backend, Map<string, StoredDocument>>();
backendConformance(
  "WorkerBackend stub (acceptance: the same suite passes unchanged for a WorkerBackend stub)",
  () => {
    const store = new Map<string, StoredDocument>();
    const handler = createWorker(store);
    const backend = new WorkerBackend({
      fetch: (input, init) => handler(new Request(input, init)),
    });
    stores.set(backend, store);
    return backend;
  },
  async (b, id) => {
    const store = stores.get(b)!;
    const cur = store.get(id)!;
    store.set(id, { x: true, rev: cur.rev, next: cur.next });
  },
);
