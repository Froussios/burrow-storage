// Burrow: encrypted, cross-device, per-user storage for static sites. No login,
// no backend of your own. This entry is the remote-only core (D-57); the
// offline wrapper is burrow-storage/offline and the passkey token utility
// burrow-storage/passkey.
import { Core } from "./core.js";
import type { BurrowConfig, BurrowStorage } from "./types.js";

export { MemoryBackend } from "./backends/memory.js";
export type { MemoryBackendOptions } from "./backends/memory.js";
export { generateToken } from "./core.js";
export { BurrowError, BackendError } from "./errors.js";
export type { BurrowErrorCode, BackendErrorCode } from "./errors.js";
export { BurrowEvent } from "./events.js";
export {
  readBackendConfig,
  readFirestoreConfig,
  registerBackend,
} from "./config.js";
export type * from "./types.js";

/**
 * Open the store for one app with the backend and token the app supplies.
 * Derives the keys locally and resolves without a network call; every later
 * read and write goes to the store and rejects if it cannot be reached.
 */
export function burrow(config: BurrowConfig): Promise<BurrowStorage> {
  return Core.create(config);
}
