// Backend discovery shared by burrow() and passkeyBackup(). Page data selects
// a registered factory; it never selects a script URL or executable code.
import type { FirestoreConfig } from "./backends/firestore.js";
import type { Backend, BackendConfig, BackendFactory } from "./types.js";

const adapters = new Map<string, BackendFactory>([
  [
    "firestore",
    async (config) => {
      const { FirestoreBackend } = await import("./backends/firestore.js");
      return new FirestoreBackend(config as unknown as FirestoreConfig);
    },
  ],
]);

/** Register an adapter factory before opening stores that use its type. */
export function registerBackend(type: string, factory: BackendFactory): void {
  if (!/^[a-z0-9-]{1,64}$/.test(type) || typeof factory !== "function")
    throw new TypeError("registerBackend needs a type and a factory");
  if (adapters.has(type))
    throw new TypeError("backend type already registered");
  adapters.set(type, factory);
}

/** @internal Resolve an instance or a declarative config. */
export async function configuredBackend(
  value: Backend | BackendConfig,
): Promise<Backend> {
  const instance =
    typeof (value as Backend)?.get === "function" &&
    typeof (value as Backend)?.put === "function";
  const factory = instance
    ? undefined
    : adapters.get((value as BackendConfig)?.type);
  if (!instance && !factory)
    throw new TypeError("backend type is not registered");
  const backend = instance
    ? (value as Backend)
    : await factory!(value as BackendConfig);
  if (
    !backend ||
    typeof backend.get !== "function" ||
    typeof backend.put !== "function" ||
    !backend.capabilities ||
    typeof backend.capabilities.writeAuth !== "boolean" ||
    typeof backend.capabilities.subscribe !== "boolean" ||
    typeof backend.id !== "string"
  )
    throw new TypeError("backend factory returned an invalid backend");
  return backend;
}

function metaConfig(name: string): unknown | undefined {
  const content = globalThis.document
    ?.querySelector?.(`meta[name="${name}"]`)
    ?.getAttribute("content");
  if (content === null || content === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Do not include the JSON parser's message: it can echo config values.
    throw new TypeError("backend page config is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new TypeError("backend page config must be an object");
  return parsed;
}

function pageConfig():
  | {
      backend?: BackendConfig;
      firestore?: FirestoreConfig;
    }
  | undefined {
  return (
    globalThis as {
      BURROW?: {
        backend?: BackendConfig;
        firestore?: FirestoreConfig;
      };
    }
  ).BURROW;
}

/** FS-3: read the legacy Firestore page config. */
export function readFirestoreConfig(): FirestoreConfig | null {
  return (metaConfig("burrow-firestore") ??
    pageConfig()?.firestore ??
    null) as FirestoreConfig | null;
}

/** Generic config first; then the legacy Firestore page config. */
export async function defaultBackend(): Promise<Backend | null> {
  const generic = metaConfig("burrow-backend") ?? pageConfig()?.backend;
  if (generic !== undefined) return configuredBackend(generic as BackendConfig);
  const firestore = readFirestoreConfig();
  return firestore
    ? configuredBackend({ ...firestore, type: "firestore" })
    : null;
}
