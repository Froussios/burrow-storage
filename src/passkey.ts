// burrow-storage/passkey (D-58): a storage token derived from a passkey. The
// WebAuthn PRF extension gives a fixed 32-byte secret per credential and input;
// HKDF turns it into one token per app. Nothing is stored, on the device or in
// any backend: the passkey reproduces the token wherever it is available. It is
// independent of the core and the offline wrapper; the token string is the only
// link (D-42).
import { randomBytes, utf8, zeroise } from "./bytes.js";
import { PRF_SALT, derivePasskeySecret } from "./codec/derive.js";
import { encodeToken } from "./codec/token.js";
import { BurrowError } from "./errors.js";

export interface PasskeyTokenOptions {
  /**
   * The app the token is for, as passed to `burrow()`. One passkey gives each
   * app its own token. Must match /^[a-z0-9-]{1,64}$/.
   */
  app: string;
  /**
   * WebAuthn rp.id. Default: the page's host. Set it to the registrable domain
   * to share across subdomains. Case and IDNs are canonicalised as URL hosts;
   * empty IDs, URLs, ports and other URL fields reject with TypeError before
   * prompting.
   */
  rpId?: string;
  /** Relying-party display name. Default: the page's host. */
  rpName?: string;
  /**
   * user.name shown by the authenticator for a new passkey. Default: `app`.
   * Presentation only: it does not enter the token.
   */
  userName?: string;
  /** user.displayName for a new passkey. Default: `userName`. */
  displayName?: string;
  /** How long a prompt may stay open, in ms. Default 120 000. */
  timeoutMs?: number;
}

/**
 * Gets a storage token from a passkey. Call `create()` and `get()` from a user
 * gesture; the app decides when.
 */
export interface PasskeyToken {
  /**
   * Whether this browser can create a passkey with the PRF extension, in a
   * secure context. Never prompts (KP-7). The authenticator chosen at the
   * prompt may still lack PRF.
   */
  available(): Promise<boolean>;
  /**
   * Create a new passkey and return the token it gives this app: a new
   * identity. Never replaces an existing passkey. Rejects `cancelled` (the
   * prompt was dismissed or timed out), `prf-unsupported`, or the browser's
   * SecurityError when `rpId` does not fit the page. Some
   * authenticators need a second prompt to evaluate PRF; if that one is
   * dismissed, the passkey exists and `get()` returns its token later.
   */
  create(): Promise<string>;
  /**
   * Ask for an existing passkey (the user picks it) and return the token it
   * gives this app: the same token every time for the same passkey. Rejects
   * `cancelled` (dismissed, timed out, or no passkey), `prf-unsupported`, or
   * the browser's SecurityError when `rpId` does not fit the page.
   */
  get(): Promise<string>;
}

type PrfResults = { enabled?: boolean; results?: { first?: BufferSource } };
const prfOf = (c: PublicKeyCredential) =>
  (c.getClientExtensionResults() as { prf?: PrfResults }).prf;
const prfInput = () =>
  ({
    prf: { eval: { first: utf8(PRF_SALT) } },
  }) as AuthenticationExtensionsClientInputs;
const bytes = (b: BufferSource) =>
  new Uint8Array(
    b instanceof ArrayBuffer
      ? b
      : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
  );
// Use the same canonical RP for every WebAuthn request. Reject URL fields
// rather than silently dropping them; WebAuthn validates whether the resulting
// domain is allowed for the current origin.
function canonicalRpId(value: string): string {
  try {
    if (typeof value !== "string" || !value || /[:/?#@\\%\s]/.test(value))
      throw 0;
    return new URL("https://" + value).hostname;
  } catch {
    throw new TypeError("invalid relying-party id");
  }
}

/**
 * WebAuthn reports a dismissed prompt, a timeout and "no matching passkey" as
 * the same NotAllowedError, on purpose; all are `cancelled`. A SecurityError
 * (an `rpId` that does not fit the page) is the site's to fix: it passes
 * through.
 */
function credentialError(e: unknown): unknown {
  const name = (e as DOMException)?.name;
  if (name === "SecurityError") return e;
  return name === "NotAllowedError" || name === "AbortError"
    ? new BurrowError("cancelled", "the passkey prompt was dismissed", {
        cause: e,
      })
    : new BurrowError("prf-unsupported", undefined, { cause: e });
}

export function passkeyToken(options: PasskeyTokenOptions): PasskeyToken {
  const app = options?.app;
  if (typeof app !== "string" || !/^[a-z0-9-]{1,64}$/.test(app))
    throw new TypeError("app must match /^[a-z0-9-]{1,64}$/");
  const host = () => globalThis.location?.hostname ?? "localhost";
  const rp = () =>
    canonicalRpId(options.rpId === undefined ? host() : options.rpId);
  const timeout = options.timeoutMs ?? 120_000;

  /** The app's token from a PRF output, which is zeroised. */
  async function tokenOf(prf: Uint8Array): Promise<string> {
    let secret: Uint8Array | undefined;
    try {
      secret = await derivePasskeySecret(prf, app);
      return await encodeToken(secret);
    } finally {
      zeroise(prf); // SEC-1
      zeroise(secret);
    }
  }

  /**
   * One assertion with the PRF extension. Without `credentialId` it is
   * discoverable: the user picks the passkey.
   */
  async function evaluate(
    rpId: string,
    credentialId?: Uint8Array<ArrayBuffer>,
  ): Promise<Uint8Array> {
    let cred: PublicKeyCredential | null;
    try {
      cred = (await navigator.credentials.get({
        publicKey: {
          challenge: randomBytes(32),
          rpId,
          userVerification: "required",
          timeout,
          allowCredentials: credentialId
            ? [{ type: "public-key", id: credentialId }]
            : [],
          extensions: prfInput(),
        },
      })) as PublicKeyCredential | null;
    } catch (e) {
      throw credentialError(e);
    }
    if (!cred) throw new BurrowError("cancelled");
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
    // attestation. A random user handle, so a new passkey never replaces one.
    async create() {
      const rpId = rp();
      const userName = options.userName ?? app;
      let cred: PublicKeyCredential | null;
      try {
        cred = (await navigator.credentials.create({
          publicKey: {
            rp: { name: options.rpName ?? host(), id: rpId },
            user: {
              id: randomBytes(16),
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
        throw credentialError(e);
      }
      if (!cred) throw new BurrowError("cancelled");
      const prf = prfOf(cred);
      if (!prf?.enabled && !prf?.results?.first) {
        // The new passkey cannot give a token. Where the browser supports it,
        // tell the passkey provider so it can drop the useless credential.
        try {
          void (
            PublicKeyCredential as unknown as {
              signalUnknownCredential?: (o: object) => Promise<void>;
            }
          )
            .signalUnknownCredential?.({ rpId, credentialId: cred.id })
            ?.catch(() => {});
        } catch {
          /* not supported */
        }
        throw new BurrowError("prf-unsupported");
      }
      // Some authenticators return PRF output at creation; the rest need one
      // assertion.
      return tokenOf(
        prf.results?.first
          ? bytes(prf.results.first)
          : await evaluate(rpId, new Uint8Array(cred.rawId)),
      );
    },

    // KP-6: one passkey prompt on any device the passkey is available on.
    async get() {
      return tokenOf(await evaluate(rp()));
    },
  };
}
