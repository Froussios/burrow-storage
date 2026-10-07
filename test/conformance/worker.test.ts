// Requirements brief, Acceptance criteria: "Swapping FirestoreBackend for
// MemoryBackend and for a WorkerBackend stub passes the same conformance suite
// unchanged."
import { backendConformance } from "./suite.js";
import { WorkerBackend } from "./worker.js";

backendConformance(
  "WorkerBackend stub (acceptance: the same suite passes unchanged for a WorkerBackend stub)",
  () => new WorkerBackend(),
);
