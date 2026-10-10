// burrow-storage/passkey. KP-5..8, ENC-11, SEC-7: a passkey backs up the
// storage token in a keyslot, a backend document encrypted under a key derived
// from the passkey's PRF output. The passkey never becomes the token.
import { randomBytes, sha256, utf8, zeroise } from "./bytes.js";
import { PRF_SALT_V1, deriveSlotKeys, type SlotKeys } from "./codec/derive.js";
import { type DocCipher, open, seal } from "./codec/envelope.js";
import { decodeToken, encodeToken } from "./codec/token.js";
import { defaultBackend, validateBackend } from "./config.js";
import { BackendError, BurrowError } from "./errors.js";
import type { Backend } from "./types.js";

export interface PasskeyBackupOptions {
  /**
   * Backend instance where the keyslot lives. Default: resolve the page's
   * config, like `burrow()`. This option does not accept BackendConfig.
   * `save()` and `restore()` reject `backend` before prompting when the
   * backend is missing, invalid, or the page config cannot be resolved.
   */
  backend?: Backend;
  /**
   * WebAuthn rp.id. Default: the page's host. Set it to the registrable domain
   * to share across subdomains.
   */
  rpId?: string;
  /** Relying-party display name. Default: the page's host. */
  rpName?: string;
  /**
   * user.name shown by the authenticator. Default: the page's host. Never an
   * email unless you choose one. The user handle derives from this label:
   * saving again on the same rp may replace its earlier passkey. Use distinct
   * labels for backups you want to keep separately, and warn before saving.
   */
  userName?: string;
  /**
   * user.displayName shown by the authenticator. Default: `userName`. It does
   * not affect the user handle or the replacement scope. Applies to the new
   * credential; this utility does not rename an existing passkey.
   */
  displayName?: string;
  /** How long a prompt may stay open, in ms. Default 120 000. */
  timeoutMs?: number;
}

/** Backs up a storage token behind a passkey, and gets it back. */
export interface PasskeyBackup {
  /**
   * Whether this browser can create a passkey with the PRF extension, in a
   * secure context. Never prompts (KP-7).
   */
  available(): Promise<boolean>;
  /**
   * Create a passkey and store `token` in a keyslot only it can open (KP-5).
   * A passkey for the same rp and `userName` may be replaced (D-47), before
   * this backup is written. Keep the current and any earlier storage tokens
   * elsewhere, and warn the user before calling, even when saving the same
   * token again. A failure after creation does not restore the old passkey.
   * Call from a user gesture. Rejects `bad-token`, `cancelled` (the prompt was
   * dismissed), `prf-unsupported`, `backend` or `conflict`.
   */
  save(token: string): Promise<void>;
  /**
   * Ask for a passkey and return the token from its keyslot (KP-6): one
   * prompt. Resolves `null` when the prompt is dismissed or the passkey has no
   * keyslot. Call from a user gesture (KP-8). Rejects `prf-unsupported`,
   * `decrypt-failed` or `backend`.
   */
  restore(): Promise<string | null>;
}

type PrfResults = { enabled?: boolean; results?: { first?: BufferSource } };
const prfOf = (c: PublicKeyCredential) =>
  (c.getClientExtensionResults() as { prf?: PrfResults }).prf;
const prfInput = () =>
  ({
    prf: { eval: { first: utf8(PRF_SALT_V1) } },
  }) as AuthenticationExtensionsClientInputs;
const bytes = (b: BufferSource) =>
  new Uint8Array(
    b instanceof ArrayBuffer
      ? b
      : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
  );
// D-47: a stable user handle per label, so a repeat save replaces the passkey
// instead of adding an identical entry.
const userHandle = async (name: string) =>
  (await sha256(utf8("burrow/user/v1" + name))).slice(0, 16);
const slotCipher = (s: SlotKeys): DocCipher => ({
  key: s.kek,
  mac: s.slotMac,
  aad: s.slotId + "slot",
});

function dismissed(e: unknown): boolean {
  return (
    (e as DOMException)?.name === "NotAllowedError" ||
    (e as DOMException)?.name === "AbortError"
  );
}

async function writeSlot(
  backend: Backend,
  s: SlotKeys,
  secret: Uint8Array,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await backend.get(s.slotId);
    const rev = cur ? cur.rev + 1 : 0;
    const plain = new Uint8Array(secret);
    let env;
    try {
      env = await seal(slotCipher(s), s.slotId, rev, plain, Date.now());
    } finally {
      zeroise(plain); // SEC-1
    }
    try {
      await backend.put(s.slotId, env, cur ? cur.rev : null);
      return;
    } catch (e) {
      if (!(e instanceof BackendError && e.code === "conflict")) throw e;
    }
  }
  throw new BurrowError("conflict");
}

export function passkeyBackup(
  options: PasskeyBackupOptions = {},
): PasskeyBackup {
  const host = () => globalThis.location?.hostname ?? "localhost";
  const timeout = options.timeoutMs ?? 120_000;
  let backend: Promise<Backend> | undefined;
  const store = () =>
    (backend ??= (async () => {
      let b: Backend | null;
      try {
        b =
          options.backend === undefined
            ? await defaultBackend()
            : validateBackend(options.backend);
      } catch {
        // Factory exceptions can contain arbitrary config values, even in a
        // BurrowError. Match the core's fixed config error without a cause.
        throw new BurrowError("backend", "backend configuration failed");
      }
      if (!b)
        throw new BurrowError("backend", "a passkey keyslot needs a backend");
      return b;
    })().catch((e) => {
      backend = undefined; // try again on the next call
      throw e;
    }));

  /**
   * One assertion with the PRF extension; null when dismissed. Discoverable:
   * the user picks the passkey.
   */
  async function evaluate(
    credentialId?: Uint8Array<ArrayBuffer>,
  ): Promise<Uint8Array | null> {
    let cred: PublicKeyCredential | null;
    try {
      cred = (await navigator.credentials.get({
        publicKey: {
          challenge: randomBytes(32),
          ...(options.rpId ? { rpId: options.rpId } : {}),
          userVerification: "required",
          timeout,
          allowCredentials: credentialId
            ? [{ type: "public-key", id: credentialId }]
            : [],
          extensions: prfInput(),
        },
      })) as PublicKeyCredential | null;
    } catch (e) {
      if (dismissed(e)) return null;
      throw new BurrowError("prf-unsupported", undefined, { cause: e });
    }
    if (!cred) return null;
    const first = prfOf(cred)?.results?.first;
    if (!first) throw new BurrowError("prf-unsupported");
    return bytes(first);
  }

  return {
    async available() {
      const PKC = globalThis.PublicKeyCredential as
        | (typeof PublicKeyCredential & {
            getClientCapabilities?: () => Promise<Record<string, boolean>>;
          })
        | undefined;
      if (
        !globalThis.isSecureContext ||
        !PKC ||
        !globalThis.navigator?.credentials
      )
        return false;
      try {
        if (PKC.getClientCapabilities) {
          const caps = await PKC.getClientCapabilities();
          if (caps["extension:prf"] === false) return false;
        }
        return await PKC.isUserVerifyingPlatformAuthenticatorAvailable();
      } catch {
        return false;
      }
    },

    // KP-5, SEC-7: discoverable credential, user verification required, no
    // attestation.
    async save(token) {
      const secret = await decodeToken(token); // bad-token before any prompt
      try {
        const b = await store();
        const userName = options.userName ?? host();
        const userId = await userHandle(userName);
        let cred: PublicKeyCredential | null;
        try {
          cred = (await navigator.credentials.create({
            publicKey: {
              rp: {
                name: options.rpName ?? host(),
                ...(options.rpId ? { id: options.rpId } : {}),
              },
              user: {
                id: userId,
                name: userName,
                displayName: options.displayName ?? userName,
              },
              challenge: randomBytes(32),
              pubKeyCredParams: [
                { type: "public-key", alg: -7 },
                { type: "public-key", alg: -257 },
              ],
              authenticatorSelection: {
                residentKey: "required",
                requireResidentKey: true,
                userVerification: "required",
              },
              attestation: "none",
              timeout,
              extensions: prfInput(),
            },
          })) as PublicKeyCredential | null;
        } catch (e) {
          if (dismissed(e))
            throw new BurrowError(
              "cancelled",
              "the passkey prompt was dismissed",
              { cause: e },
            );
          throw new BurrowError("prf-unsupported", undefined, { cause: e });
        }
        if (!cred) throw new BurrowError("cancelled");
        const prf = prfOf(cred);
        if (!prf?.enabled && !prf?.results?.first)
          throw new BurrowError("prf-unsupported");
        // Some authenticators return PRF output at creation; the rest need one
        // assertion.
        const out = prf.results?.first
          ? bytes(prf.results.first)
          : await evaluate(new Uint8Array(cred.rawId));
        if (!out)
          throw new BurrowError(
            "cancelled",
            "the passkey prompt was dismissed",
          );
        try {
          await writeSlot(b, await deriveSlotKeys(out), secret);
        } finally {
          zeroise(out);
        }
      } finally {
        zeroise(secret); // SEC-1
      }
    },

    // KP-6: one passkey prompt per new device.
    async restore() {
      const b = await store();
      const prf = await evaluate();
      if (!prf) return null;
      let secret: Uint8Array | undefined;
      try {
        const slot = await deriveSlotKeys(prf);
        const env = await b.get(slot.slotId);
        if (!env) return null;
        if ("x" in env) throw new BurrowError("expired");
        secret = await open(slotCipher(slot), env);
        if (secret.length !== 32) throw new BurrowError("decrypt-failed");
        return await encodeToken(secret);
      } finally {
        zeroise(prf);
        if (secret) zeroise(secret);
      }
    },
  };
}
