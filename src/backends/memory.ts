// BE-6: in-memory backend that enforces the same document rules as firebase/firestore.rules,
// including the tok/next write chain (writeAuth: true). Used by tests and the conformance suite.
import { sha256hex } from "../bytes.js";
import { BackendError } from "../errors.js";
import type { Backend, Envelope } from "../types.js";

// Subscribers live with the document map, so every backend sharing a store (device) is notified.
const hubs = new WeakMap<Map<string, Envelope>, Map<string, Set<(env: Envelope) => void>>>();

const FIELDS = new Set(["v", "iv", "ct", "rev", "ts", "tok", "next", "z"]);

/** Mirror of the rules' shape(): returns false for anything the store must refuse. */
export function wellFormed(id: string, d: Envelope): boolean {
  return id.length === 43
    && Object.keys(d).every((k) => FIELDS.has(k))
    && d.v === 1
    && Number.isInteger(d.rev) && Number.isInteger(d.ts)
    && typeof d.iv === "string" && d.iv.length === 16
    && typeof d.ct === "string"
    && typeof d.tok === "string" && d.tok.length <= 64
    && typeof d.next === "string" && d.next.length === 64
    && (!("z" in d) || d.z === true);
}

export interface MemoryBackendOptions {
  /** Shared document map, so several backends (devices) see the same store. */
  store?: Map<string, Envelope>;
  /** Artificial latency per call, ms. */
  latencyMs?: number;
}

export class MemoryBackend implements Backend {
  readonly id = "memory";
  readonly capabilities = { writeAuth: true, subscribe: true, keepalive: true, maxEnvelopeBytes: 1_048_576 };
  readonly store: Map<string, Envelope>;
  /** Test hook: when set, every call rejects with this error code. */
  failWith: "network" | "quota" | null = null;
  /** Calls made, for asserting sync costs (FS-11). */
  readonly stats = { gets: 0, puts: 0 };
  readonly #latency: number;
  readonly #subs: Map<string, Set<(env: Envelope) => void>>;

  constructor(opts: MemoryBackendOptions = {}) {
    this.store = opts.store ?? new Map();
    this.#latency = opts.latencyMs ?? 0;
    let hub = hubs.get(this.store);
    if (!hub) hubs.set(this.store, (hub = new Map()));
    this.#subs = hub;
  }

  async #enter(): Promise<void> {
    if (this.#latency) await new Promise((r) => setTimeout(r, this.#latency));
    else await Promise.resolve();
    if (this.failWith) throw new BackendError(this.failWith);
  }

  async get(id: string): Promise<Envelope | null> {
    await this.#enter();
    this.stats.gets++;
    const d = this.store.get(id);
    return d ? structuredClone(d) : null;
  }

  async getMany(ids: string[]): Promise<(Envelope | null)[]> {
    return Promise.all(ids.map((id) => this.get(id)));
  }

  async put(id: string, env: Envelope, expectedRev: number | null): Promise<void> {
    await this.#enter();
    const doc = structuredClone(env);
    if (doc.ct.length > 1_000_000) throw new BackendError("too-large");
    if (!wellFormed(id, doc)) throw new BackendError("unauthorized", "malformed envelope");
    const hash = await sha256hex(doc.tok);
    // BE-1: everything from here to the write is synchronous, so the check-and-set is atomic.
    const cur = this.store.get(id);
    if (expectedRev === null) {
      if (cur) throw new BackendError("conflict");
      if (doc.rev !== 0) throw new BackendError("unauthorized", "create must be rev 0");
    } else {
      if (!cur || cur.rev !== expectedRev) throw new BackendError("conflict");
      if (doc.rev !== cur.rev + 1) throw new BackendError("unauthorized", "rev must advance by one");
      if (hash !== cur.next) throw new BackendError("unauthorized", "token does not match commitment");
    }
    this.store.set(id, doc);
    this.stats.puts++;
    for (const fn of this.#subs.get(id) ?? []) queueMicrotask(() => fn(structuredClone(doc)));
  }

  subscribe(id: string, onChange: (env: Envelope) => void): () => void {
    let set = this.#subs.get(id);
    if (!set) this.#subs.set(id, (set = new Set()));
    set.add(onChange);
    return () => { set.delete(onChange); };
  }
}
