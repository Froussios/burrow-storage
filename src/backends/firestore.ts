// §10 reference backend: one Firestore collection on the Spark plan, guarded by firebase/firestore.rules.
import { BackendError } from "../errors.js";
import type { Backend, Envelope } from "../types.js";
import { wellFormed } from "./memory.js";

type Sdk = typeof import("./firestore-sdk.js");
type Db = ReturnType<Sdk["getFirestore"]>;

export interface FirestoreConfig {
  /** An identifier, not a secret: restrict it to your domains in the Google Cloud console (FS-12). */
  apiKey: string;
  projectId: string;
  appId: string;
  /** FS-1: default "burrow". */
  collection?: string;
  /** Point at the Firestore emulator (tests). */
  emulator?: { host: string; port: number };
}

// BE-3: the SDK is loaded on first use. Script-tag builds swap this loader for a same-origin chunk.
let loadSdk: () => Promise<Sdk> = () => import("./firestore-sdk.js");
/** @internal */
export function setFirestoreSdkLoader(fn: () => Promise<Sdk>): void {
  loadSdk = fn;
}

const FIELDS = ["v", "iv", "ct", "rev", "ts", "tok", "next", "z"] as const;

function toEnvelope(d: Record<string, unknown>): Envelope {
  const e: Record<string, unknown> = {};
  for (const k of FIELDS) if (d[k] !== undefined) e[k] = d[k];
  return e as unknown as Envelope;
}

// FS-2: exactly the envelope fields; Firestore refuses `undefined`.
const toDoc = (env: Envelope) =>
  toEnvelope(env as unknown as Record<string, unknown>) as unknown as Record<
    string,
    unknown
  >;

/** BE-4: map every SDK failure onto the adapter error codes. Unknown errors are network (retried). */
function mapError(e: unknown): BackendError {
  if (e instanceof BackendError) return e;
  const code = (e as { code?: string })?.code ?? "";
  if (code === "resource-exhausted")
    return new BackendError("quota", undefined, { cause: e });
  if (code === "permission-denied")
    return new BackendError("unauthorized", undefined, { cause: e });
  if (code === "invalid-argument")
    return new BackendError("too-large", undefined, { cause: e });
  return new BackendError("network", undefined, { cause: e });
}

export class FirestoreBackend implements Backend {
  readonly id = "firestore";
  readonly capabilities = {
    writeAuth: true,
    subscribe: true,
    keepalive: false,
    maxEnvelopeBytes: 1_048_576,
  };
  readonly #cfg: FirestoreConfig;
  readonly #collection: string;
  #conn: Promise<{ sdk: Sdk; db: Db }> | null = null;

  constructor(config: FirestoreConfig) {
    if (!config?.apiKey || !config.projectId || !config.appId)
      throw new TypeError("FirestoreBackend needs apiKey, projectId and appId");
    this.#cfg = config;
    this.#collection = config.collection ?? "burrow";
  }

  #connect(): Promise<{ sdk: Sdk; db: Db }> {
    return (this.#conn ??= (async () => {
      const sdk = await loadSdk();
      const { apiKey, projectId, appId, emulator } = this.#cfg;
      const name = `burrow:${projectId}${emulator ? `@${emulator.host}:${emulator.port}` : ""}`;
      const existing = sdk.getApps().find((a) => a.name === name);
      const app =
        existing ?? sdk.initializeApp({ apiKey, projectId, appId }, name);
      const db = sdk.getFirestore(app);
      if (emulator && !existing)
        sdk.connectFirestoreEmulator(db, emulator.host, emulator.port);
      return { sdk, db };
    })().catch((e) => {
      this.#conn = null;
      throw mapError(e);
    }));
  }

  async get(id: string): Promise<Envelope | null> {
    const { sdk, db } = await this.#connect();
    try {
      // A transactional read goes straight to the backend. getDoc/getDocFromServer can be served
      // from the watch stream of our own onSnapshot listener on the same document, which may not
      // yet reflect a transaction that just committed; that read would report a stale revision.
      const ref = sdk.doc(db, this.#collection, id);
      const snap = await sdk.runTransaction(db, (tx) => tx.get(ref));
      return snap.exists() ? toEnvelope(snap.data()) : null;
    } catch (e) {
      throw mapError(e);
    }
  }

  /** FS-4: parallel single-document reads; an `in` query would need list, which rules deny. */
  getMany(ids: string[]): Promise<(Envelope | null)[]> {
    return Promise.all(ids.map((id) => this.get(id)));
  }

  /** FS-8: a transaction reads, checks rev, writes; BE-1 holds because Firestore serialises it. */
  async put(
    id: string,
    env: Envelope,
    expectedRev: number | null,
  ): Promise<void> {
    if (env.ct.length > 1_000_000) throw new BackendError("too-large");
    if (!wellFormed(id, env))
      throw new BackendError("unauthorized", "malformed envelope");
    const { sdk, db } = await this.#connect();
    const ref = sdk.doc(db, this.#collection, id);
    try {
      await sdk.runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const rev = snap.exists() ? (snap.data().rev as number) : null;
        if (rev !== expectedRev) throw new BackendError("conflict");
        tx.set(ref, toDoc(env));
      });
    } catch (e) {
      const err = mapError(e);
      if (err.code !== "unauthorized") throw err;
      // FS-8: a denial on a stale expectedRev is a conflict; on a fresh one it is unauthorized.
      const cur = await this.get(id).catch(() => undefined);
      if (cur !== undefined && (cur?.rev ?? null) !== expectedRev)
        throw new BackendError("conflict", undefined, { cause: e });
      throw err;
    }
  }

  /** FS-9 / BE-7: onSnapshot on one document (the core subscribes to the manifest only). */
  subscribe(id: string, onChange: (env: Envelope) => void): () => void {
    let stop: (() => void) | null = null;
    let cancelled = false;
    void this.#connect().then(
      ({ sdk, db }) => {
        if (cancelled) return;
        stop = sdk.onSnapshot(
          sdk.doc(db, this.#collection, id),
          (snap) => {
            if (snap.exists() && !snap.metadata.hasPendingWrites)
              onChange(toEnvelope(snap.data()));
          },
          () => {
            /* the core falls back to polling */
          },
        );
      },
      () => {},
    );
    return () => {
      cancelled = true;
      stop?.();
    };
  }

  /** Shut down the SDK app (tests). */
  async close(): Promise<void> {
    if (!this.#conn) return;
    const { sdk, db } = await this.#conn;
    this.#conn = null;
    await sdk.deleteApp(db.app);
  }
}
