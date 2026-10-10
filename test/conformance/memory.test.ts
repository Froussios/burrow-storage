import { MemoryBackend } from "../../src/backends/memory.js";
import type { Backend } from "../../src/types.js";
import { backendConformance } from "./suite.js";

const expire = async (b: Backend, id: string) => {
  const memory = b as MemoryBackend;
  const cur = memory.store.get(id)!;
  memory.store.set(id, { x: true, rev: cur.rev, next: cur.next });
};
backendConformance("MemoryBackend", () => new MemoryBackend(), expire);
backendConformance(
  "MemoryBackend (with latency)",
  () => new MemoryBackend({ latencyMs: 3 }),
  expire,
);
