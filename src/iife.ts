// Single-file browser build: global `Burrow`. The Firestore SDK is fetched on first use from
// burrow-firestore.js next to this script (same origin, SEC-4), never from a third-party host.
import { setFirestoreSdkLoader } from "./backends/firestore.js";

const here = (globalThis.document?.currentScript as HTMLScriptElement | null)?.src;
setFirestoreSdkLoader(() => import(new URL("burrow-firestore.js", here ?? globalThis.location.href).href));

export * from "./index.js";
export { FirestoreBackend } from "./backends/firestore.js";
