import { MemoryBackend } from "../../src/backends/memory.js";
import { backendConformance } from "./suite.js";

backendConformance("MemoryBackend", () => new MemoryBackend());
backendConformance("MemoryBackend (with latency)", () => new MemoryBackend({ latencyMs: 3 }));
