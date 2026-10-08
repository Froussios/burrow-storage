// Gate 2 setup checks use the production backend and codec, with fresh,
// throwaway keys each run. Only fixed check names and error codes escape.
import { deleteApp, initializeApp } from "firebase/app";
import {
  collection,
  doc,
  documentId,
  getDocs,
  getFirestore,
  query,
  setDoc,
  setLogLevel,
  where,
  connectFirestoreEmulator,
} from "firebase/firestore";
import { b64url, randomBytes, utf8, zeroise } from "../bytes.js";
import {
  FirestoreBackend,
  type FirestoreConfig,
} from "../backends/firestore.js";
import { deriveAppKeys } from "../codec/derive.js";
import { open, seal } from "../codec/envelope.js";

type Check = "create-read" | "forged-update" | "list" | "in-query";
export class SetupCheckError extends Error {
  constructor(
    readonly check: Check,
    readonly code:
      "unexpected-result" | "permission-denied" | "quota" | "network",
  ) {
    super(`FAIL ${check}: ${code}`);
  }
}

function codeOf(error: unknown): SetupCheckError["code"] {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "permission-denied" || code === "unauthorized")
    return "permission-denied";
  if (code === "resource-exhausted" || code === "quota") return "quota";
  if (
    typeof code === "string" &&
    ["network", "unavailable", "deadline-exceeded", "cancelled"].includes(code)
  )
    return "network";
  return "unexpected-result";
}

/** Internal entry used by the bin and emulator tests; no credentials needed. */
export async function checkFirestore(
  config: FirestoreConfig,
  report: (message: string) => void,
): Promise<void> {
  // Firestore's own diagnostics can include document paths. This standalone
  // check emits only the fixed messages below, never SDK errors or causes.
  setLogLevel("silent");
  const backend = new FirestoreBackend(config);
  const raw = initializeApp(config, "burrow:setup-check");
  const db = getFirestore(raw);
  if (config.emulator)
    connectFirestoreEmulator(db, config.emulator.host, config.emulator.port);
  let check: Check = "create-read";
  try {
    const root = randomBytes(32);
    const keys = await deriveAppKeys(root, "burrow-setup-check").finally(() =>
      zeroise(root),
    );
    const cipher = {
      key: keys.encKey,
      mac: keys.macKey,
      aad: keys.base + keys.app,
    };
    const plaintext = utf8('{"v":1,"items":{}}');
    const env = await seal(cipher, keys.base, 0, plaintext, Date.now());
    await backend.put(keys.base, env, null);
    const stored = await backend.get(keys.base);
    if (!stored || JSON.stringify(stored) !== JSON.stringify(env))
      throw new SetupCheckError(check, "unexpected-result");
    const decoded = await open(cipher, stored);
    if (
      decoded.length !== plaintext.length ||
      !decoded.every((byte, index) => byte === plaintext[index])
    )
      throw new SetupCheckError(check, "unexpected-result");
    report(`PASS ${check}`);

    const ref = doc(db, config.collection ?? "burrow", keys.base);
    const deny = async (operation: () => Promise<unknown>) => {
      try {
        await operation();
      } catch (error) {
        // Network, API-key and quota failures never count as a rules pass.
        if ((error as { code?: unknown })?.code === "permission-denied") {
          report(`PASS ${check}`);
          return;
        }
        throw error;
      }
      throw new SetupCheckError(check, "unexpected-result");
    };
    // Successful create/read is a prerequisite: a referrer-blocked key can
    // also report permission-denied, so never run these denial probes first.
    check = "forged-update";
    // Keep the forged token and every other field structurally valid: denial
    // must exercise the write chain, not a token-shape restriction.
    await deny(() =>
      setDoc(ref, { ...env, rev: 1, tok: b64url(randomBytes(32)) }),
    );
    check = "list";
    const coll = collection(db, config.collection ?? "burrow");
    await deny(() => getDocs(coll));
    check = "in-query";
    await deny(() =>
      getDocs(query(coll, where(documentId(), "in", [keys.base]))),
    );
  } catch (error) {
    if (error instanceof SetupCheckError) throw error;
    throw new SetupCheckError(check, codeOf(error));
  } finally {
    await Promise.allSettled([backend.close(), deleteApp(raw)]);
  }
}
