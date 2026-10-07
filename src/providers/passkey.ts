// KP-5..10, ENC-11, SEC-7: a passkey unlocks a keyslot holding the root secret, wrapped under a key
// derived from the passkey's PRF output. The passkey never becomes the secret.
import { b64url, fromB64url, randomBytes, utf8, zeroise } from "../bytes.js";
import { PRF_SALT_V1, deriveSlotKeys, type SlotKeys } from "../codec/derive.js";
import { type DocCipher, open, seal } from "../codec/envelope.js";
import { BackendError, BurrowError } from "../errors.js";
import type { Backend, KeyProvider } from "../types.js";

export interface PasskeyOptions {
  /** WebAuthn rp.id. Default: the page's host. Set it to the registrable domain to share across subdomains. */
  rpId?: string;
  /** Relying-party display name. Default: the page's host. */
  rpName?: string;
  /** user.name shown by the authenticator. Default: the app id. Never an email unless you choose one. */
  userName?: string;
  timeoutMs?: number;
}

const CRED = "passkey.credentialId";
type PrfResults = { enabled?: boolean; results?: { first?: BufferSource } };
const prfOf = (c: PublicKeyCredential) => (c.getClientExtensionResults() as { prf?: PrfResults }).prf;
const prfInput = () => ({ prf: { eval: { first: utf8(PRF_SALT_V1) } } }) as AuthenticationExtensionsClientInputs;
const bytes = (b: BufferSource) => new Uint8Array(b instanceof ArrayBuffer ? b : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const slotCipher = (s: SlotKeys): DocCipher => ({ key: s.kek, mac: s.slotMac, aad: s.slotId + "slot" });

function dismissed(e: unknown): boolean {
  return (e as DOMException)?.name === "NotAllowedError" || (e as DOMException)?.name === "AbortError";
}

async function writeSlot(backend: Backend, s: SlotKeys, rootSecret: Uint8Array): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await backend.get(s.slotId);
    const rev = cur ? cur.rev + 1 : 0;
    const plain = new Uint8Array(rootSecret);
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

export function passkey(options: PasskeyOptions = {}): KeyProvider {
  const host = () => globalThis.location?.hostname ?? "localhost";

  async function evaluate(credentialId?: Uint8Array<ArrayBuffer>): Promise<{ prf: Uint8Array; rawId: ArrayBuffer } | null> {
    let cred: PublicKeyCredential | null;
    try {
      cred = (await navigator.credentials.get({
        publicKey: {
          challenge: randomBytes(32),
          ...(options.rpId ? { rpId: options.rpId } : {}),
          userVerification: "required",
          timeout: options.timeoutMs ?? 120_000,
          allowCredentials: credentialId ? [{ type: "public-key", id: credentialId }] : [],
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
    return { prf: bytes(first), rawId: cred.rawId };
  }

  return {
    id: "passkey",

    // KP-7: feature-detect without prompting.
    async available() {
      const PKC = globalThis.PublicKeyCredential as (typeof PublicKeyCredential & {
        getClientCapabilities?: () => Promise<Record<string, boolean>>;
      }) | undefined;
      if (!PKC || !globalThis.navigator?.credentials) return false;
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

    // KP-5, SEC-7: discoverable credential, user verification required, no attestation.
    async enrol({ app, rootSecret, backend, store }) {
      let cred: PublicKeyCredential | null;
      try {
        cred = (await navigator.credentials.create({
          publicKey: {
            rp: { name: options.rpName ?? host(), ...(options.rpId ? { id: options.rpId } : {}) },
            user: { id: randomBytes(16), name: options.userName ?? app, displayName: options.userName ?? app },
            challenge: randomBytes(32),
            pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
            authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
            attestation: "none",
            timeout: options.timeoutMs ?? 120_000,
            extensions: prfInput(),
          },
        })) as PublicKeyCredential | null;
      } catch (e) {
        if (dismissed(e)) throw new BurrowError("no-provider", "the passkey prompt was dismissed", { cause: e });
        throw new BurrowError("prf-unsupported", undefined, { cause: e });
      }
      if (!cred) throw new BurrowError("no-provider");
      const prf = prfOf(cred);
      if (!prf?.enabled && !prf?.results?.first) throw new BurrowError("prf-unsupported");
      const rawId = new Uint8Array(cred.rawId);
      // Some authenticators return PRF output at creation; the rest need one assertion.
      let out = prf.results?.first ? bytes(prf.results.first) : (await evaluate(rawId))?.prf;
      if (!out) throw new BurrowError("no-provider", "the passkey prompt was dismissed");
      try {
        await writeSlot(backend, await deriveSlotKeys(out), rootSecret);
      } finally {
        out.fill(0);
      }
      // KP-9: remember the passkey only once a keyslot backs it. The id is a hint for recover(), so
      // failing to save it must not fail an enrolment whose keyslot is already written.
      await store?.set(CRED, b64url(rawId)).catch(() => {});
    },

    // KP-6: one passkey prompt per new device.
    async recover({ interactive, backend, store }) {
      if (!interactive) return null; // KP-8: PRF needs a user gesture
      const cached = await store?.get(CRED);
      const got = await evaluate(cached ? fromB64url(cached) : undefined);
      if (!got) return null;
      try {
        const slot = await deriveSlotKeys(got.prf);
        const env = await backend.get(slot.slotId);
        if (!env) return null;
        const secret = await open(slotCipher(slot), env);
        if (secret.length !== 32) throw new BurrowError("decrypt-failed");
        await store?.set(CRED, b64url(new Uint8Array(got.rawId)));
        return secret;
      } finally {
        got.prf.fill(0);
      }
    },
  };
}
