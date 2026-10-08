// The page's default backend, shared by burrow() and passkeyBackup().
import type { Backend } from "./types.js";

/**
 * FS-3: the Firestore config from <meta name="burrow-firestore"> or
 * window.BURROW.firestore.
 */
export function readFirestoreConfig(): {
  apiKey: string;
  projectId: string;
  appId: string;
} | null {
  const meta = globalThis.document
    ?.querySelector?.('meta[name="burrow-firestore"]')
    ?.getAttribute("content");
  if (meta) {
    try {
      return JSON.parse(meta);
    } catch {
      console.warn('[burrow] <meta name="burrow-firestore"> is not valid JSON');
    }
  }
  return (
    (
      globalThis as {
        BURROW?: {
          firestore?: { apiKey: string; projectId: string; appId: string };
        };
      }
    ).BURROW?.firestore ?? null
  );
}

/**
 * A FirestoreBackend from the page's config, or null. Instances share one
 * Firebase app (FirestoreBackend reuses it by name).
 */
export async function defaultBackend(): Promise<Backend | null> {
  const cfg = readFirestoreConfig();
  if (!cfg) return null;
  const { FirestoreBackend } = await import("./backends/firestore.js");
  return new FirestoreBackend(cfg);
}
