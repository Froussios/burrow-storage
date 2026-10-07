// A WorkerBackend stub: a tiny HTTP document store (the shape a Cloudflare Worker or similar
// edge function would have) and a Backend that talks to it through a fetch-compatible function.
// It exists to show the conformance suite is backend-agnostic (requirements brief, Acceptance
// criteria: "Swapping FirestoreBackend for MemoryBackend and for a WorkerBackend stub passes the
// same conformance suite unchanged.") and as a worked example of the REST shape in
// docs/extending.md. It enforces the same rules as MemoryBackend, which mirror
// firebase/firestore.rules.
import { wellFormed } from "../../src/backends/memory.js";
import { sha256hex } from "../../src/bytes.js";
import { BackendError } from "../../src/errors.js";
import type { Backend, Envelope } from "../../src/types.js";

/** Same limits as MemoryBackend: the whole request, and the ciphertext field (FS rules). */
export const MAX_ENVELOPE_BYTES = 1_048_576;
const MAX_CT_CHARS = 1_000_000;

export type Handler = (req: Request) => Promise<Response>;
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const PREFIX = "/doc/";
const status = (code: number): Response => new Response(null, { status: code });

/**
 * The "worker": GET /doc/{id} and PUT /doc/{id} over `store`.
 * PUT carries `If-None-Match: *` for a create or `If-Match: <rev>` for an update.
 * 200 (GET), 201 (created), 204 (updated), 404, 409 conflict, 403 chain or shape failure,
 * 413 too large, 405 / 428 for requests a conforming client never sends.
 */
export function createWorker(
  store: Map<string, Envelope> = new Map(),
): Handler {
  return async (req) => {
    const path = new URL(req.url).pathname;
    if (!path.startsWith(PREFIX)) return status(404);
    let id: string;
    try {
      id = decodeURIComponent(path.slice(PREFIX.length));
    } catch {
      return status(404);
    }

    if (req.method === "GET") {
      const doc = store.get(id);
      if (!doc) return status(404);
      return new Response(JSON.stringify(doc), {
        status: 200,
        headers: { "content-type": "application/json", etag: `"${doc.rev}"` },
      });
    }
    if (req.method !== "PUT")
      return new Response(null, {
        status: 405,
        headers: { allow: "GET, PUT" },
      });

    const create = req.headers.get("if-none-match") === "*";
    const ifMatch = req.headers.get("if-match");
    const expected =
      ifMatch === null ? null : Number(ifMatch.replace(/^(W\/)?"|"$/g, ""));
    if (!create && (expected === null || !Number.isInteger(expected)))
      return status(428);

    const body = await req.text();
    if (new TextEncoder().encode(body).length > MAX_ENVELOPE_BYTES)
      return status(413);
    let doc: Envelope;
    try {
      doc = JSON.parse(body) as Envelope;
    } catch {
      return status(403);
    }
    if (typeof doc !== "object" || doc === null || Array.isArray(doc))
      return status(403);
    if (typeof doc.ct === "string" && doc.ct.length > MAX_CT_CHARS)
      return status(413);
    if (!wellFormed(id, doc)) return status(403);
    const hash = await sha256hex(doc.tok);

    // BE-1: from here to the write everything is synchronous, so the compare-and-set is atomic.
    const cur = store.get(id);
    if (create) {
      if (cur) return status(409);
      if (doc.rev !== 0) return status(403);
    } else {
      if (!cur || cur.rev !== expected) return status(409);
      if (doc.rev !== cur.rev + 1) return status(403);
      if (hash !== cur.next) return status(403);
    }
    store.set(id, doc);
    return status(create ? 201 : 204);
  };
}

export interface WorkerBackendOptions {
  /** fetch-compatible transport. Default: an in-process worker from `createWorker()`. */
  fetch?: FetchLike;
  /** Base URL of the worker. Default: a placeholder origin for the in-process worker. */
  baseUrl?: string;
}

function codeFor(statusCode: number): BackendError {
  switch (statusCode) {
    case 409:
      return new BackendError("conflict");
    case 401:
    case 403:
      return new BackendError("unauthorized");
    case 413:
      return new BackendError("too-large");
    case 429:
      return new BackendError("quota");
    default:
      return new BackendError("network", `HTTP ${statusCode}`);
  }
}

export class WorkerBackend implements Backend {
  readonly id = "worker";
  readonly capabilities = {
    writeAuth: true,
    subscribe: false,
    keepalive: true,
    maxEnvelopeBytes: MAX_ENVELOPE_BYTES,
  };
  readonly #fetch: FetchLike;
  readonly #base: string;

  constructor(opts: WorkerBackendOptions = {}) {
    if (opts.fetch) {
      this.#fetch = opts.fetch;
    } else {
      const worker = createWorker();
      this.#fetch = (input, init) => worker(new Request(input, init));
    }
    this.#base = (opts.baseUrl ?? "https://worker.burrow.invalid").replace(
      /\/+$/,
      "",
    );
  }

  #url(id: string): string {
    return `${this.#base}${PREFIX}${encodeURIComponent(id)}`;
  }

  async #send(id: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(this.#url(id), init);
    } catch (e) {
      throw new BackendError("network", "request failed", { cause: e });
    }
  }

  async get(id: string): Promise<Envelope | null> {
    const res = await this.#send(id, { method: "GET" });
    if (res.status === 404) return null;
    if (res.status !== 200) throw codeFor(res.status);
    try {
      return (await res.json()) as Envelope;
    } catch (e) {
      throw new BackendError("network", "unreadable response", { cause: e });
    }
  }

  async getMany(ids: string[]): Promise<(Envelope | null)[]> {
    return Promise.all(ids.map((id) => this.get(id)));
  }

  async put(
    id: string,
    env: Envelope,
    expectedRev: number | null,
    opts?: { keepalive?: boolean },
  ): Promise<void> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (expectedRev === null) headers["if-none-match"] = "*";
    else headers["if-match"] = String(expectedRev);
    const init: RequestInit = {
      method: "PUT",
      headers,
      body: JSON.stringify(env),
    };
    if (opts?.keepalive) init.keepalive = true;
    const res = await this.#send(id, init);
    if (res.status === 200 || res.status === 201 || res.status === 204) return;
    throw codeFor(res.status);
  }
}
