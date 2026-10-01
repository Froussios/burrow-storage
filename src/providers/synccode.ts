// KP-11..13: the sync code. enrol() is the export itself (exportCode() shows it); recover() decodes.
import { decodeSyncCode } from "../codec/synccode.js";
import type { KeyProvider } from "../types.js";

export function syncCode(): KeyProvider {
  return {
    id: "sync-code",
    available: async () => true,
    enrol: async () => {},
    recover: async ({ input }) => (input ? (await decodeSyncCode(input)).secret : null),
  };
}
