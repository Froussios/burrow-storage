// Single-file browser build: global `Burrow`. The Firestore SDK is fetched on
// first use from burrow-firestore.js next to this script (same origin, SEC-4),
// never from a third-party host. It is a classic script, so this also works
// from file:// (NF-1) and under script-src 'self'.
import { setFirestoreSdkLoader } from "./backends/firestore.js";

type Sdk = typeof import("./backends/firestore-sdk.js");
const g = globalThis as typeof globalThis & { BurrowFirestoreSdk?: Sdk };
const here = (globalThis.document?.currentScript as HTMLScriptElement | null)
  ?.src;
let loading: Promise<Sdk> | undefined;

setFirestoreSdkLoader(
  () =>
    (loading ??= new Promise<Sdk>((resolve, reject) => {
      if (g.BurrowFirestoreSdk) return resolve(g.BurrowFirestoreSdk);
      const s = document.createElement("script");
      s.src = new URL("burrow-firestore.js", here ?? location.href).href;
      s.onload = () =>
        g.BurrowFirestoreSdk
          ? resolve(g.BurrowFirestoreSdk)
          : reject(new Error("burrow-firestore.js did not load"));
      s.onerror = () => {
        loading = undefined;
        s.remove();
        reject(new Error("could not load burrow-firestore.js"));
      };
      document.head.appendChild(s);
    })),
);

export * from "./index.js";
export { FirestoreBackend } from "./backends/firestore.js";
