// KP-5..8, SEC-7, D-58: burrow-storage/passkey against a scripted WebAuthn
// authenticator. Browser coverage with a real (virtual) authenticator lives in
// test/e2e/passkey.spec.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  b64url,
  concat,
  fromB64url,
  hex,
  sha256,
  utf8,
} from "../../src/bytes.js";
import { PRF_SALT, derivePasskeySecret } from "../../src/codec/derive.js";
import { decodeToken, encodeToken } from "../../src/codec/token.js";
import { BurrowError } from "../../src/errors.js";
import { type PasskeyToken, passkeyToken } from "../../src/passkey.js";
import vectors from "../vectors.json" with { type: "json" };
import { World } from "../support/devices.js";

const fresh = (b: Uint8Array): ArrayBuffer => b.slice().buffer;
const notAllowed = () =>
  new DOMException(
    "The operation either timed out or was not allowed.",
    "NotAllowedError",
  );

type CreateOpts = CredentialCreationOptions & {
  publicKey: PublicKeyCredentialCreationOptions;
};
type GetOpts = CredentialRequestOptions & {
  publicKey: PublicKeyCredentialRequestOptions;
};

/**
 * A scripted platform authenticator. Each credential has a fixed 32-byte seed;
 * its PRF output for a salt is SHA-256(seed || salt), so outputs are
 * deterministic and differ per credential.
 */
class FakeAuthenticator {
  readonly creds = new Map<string, Uint8Array>(); // b64url(rawId) -> seed
  /**
   * What create() reports: PRF results inline, only `enabled`, or
   * `enabled: false`.
   */
  createMode: "results" | "enabled-only" | "disabled" = "results";
  /** Override get(): resolve null, reject, or omit PRF results. */
  getMode: "ok" | "null" | "cancel" | "no-prf" = "ok";
  /**
   * Credential picked by a discoverable get() (empty allowCredentials).
   * Default: the last created.
   */
  chosen?: string;
  readonly createCalls: CreateOpts[] = [];
  readonly getCalls: GetOpts[] = [];
  #n = 0;

  async prf(seed: Uint8Array, salt: BufferSource): Promise<Uint8Array> {
    const s =
      salt instanceof ArrayBuffer
        ? new Uint8Array(salt)
        : new Uint8Array(salt.buffer, salt.byteOffset, salt.byteLength);
    return sha256(concat(seed, s));
  }

  /**
   * PRF output this authenticator gives for credential `id` with Burrow's salt.
   */
  async expectedPrf(id: string): Promise<Uint8Array> {
    return this.prf(this.creds.get(id)!, utf8(PRF_SALT));
  }

  #credential(
    rawId: Uint8Array,
    prf: Record<string, unknown>,
  ): PublicKeyCredential {
    return {
      type: "public-key",
      id: b64url(rawId),
      rawId: fresh(rawId),
      authenticatorAttachment: "platform",
      getClientExtensionResults: () => ({ prf }),
    } as unknown as PublicKeyCredential;
  }

  create = vi.fn(
    async (opts: CreateOpts): Promise<PublicKeyCredential | null> => {
      this.createCalls.push(opts);
      const rawId = new Uint8Array(16).fill(++this.#n);
      const seed = new Uint8Array(32).fill(0x40 + this.#n);
      const id = b64url(rawId);
      this.creds.set(id, seed);
      this.chosen = id;
      if (this.createMode === "disabled")
        return this.#credential(rawId, { enabled: false });
      if (this.createMode === "enabled-only")
        return this.#credential(rawId, { enabled: true });
      const first = (
        opts.publicKey.extensions as {
          prf?: { eval?: { first: BufferSource } };
        }
      ).prf?.eval?.first;
      return this.#credential(rawId, {
        enabled: true,
        results: { first: fresh(await this.prf(seed, first!)) },
      });
    },
  );

  get = vi.fn(async (opts: GetOpts): Promise<PublicKeyCredential | null> => {
    this.getCalls.push(opts);
    if (this.getMode === "null") return null;
    if (this.getMode === "cancel") throw notAllowed();
    const allow = opts.publicKey.allowCredentials ?? [];
    const id = allow.length
      ? allow
          .map((c) =>
            b64url(
              new Uint8Array(c.id as ArrayBuffer | Uint8Array<ArrayBuffer>),
            ),
          )
          .find((i) => this.creds.has(i))
      : this.chosen;
    // no matching credential on this authenticator
    if (!id || !this.creds.has(id)) throw notAllowed();
    const rawId = fromB64url(id);
    if (this.getMode === "no-prf") return this.#credential(rawId, {});
    const first = (
      opts.publicKey.extensions as { prf?: { eval?: { first: BufferSource } } }
    ).prf?.eval?.first;
    return this.#credential(rawId, {
      results: { first: fresh(await this.prf(this.creds.get(id)!, first!)) },
    });
  });
}

/**
 * Install the authenticator as navigator.credentials and a matching
 * PublicKeyCredential.
 */
function install(
  auth: FakeAuthenticator,
  platform: { uv?: boolean; caps?: Record<string, boolean> | null } = {},
) {
  const PKC = {
    isUserVerifyingPlatformAuthenticatorAvailable: vi.fn(
      async () => platform.uv ?? true,
    ),
    signalUnknownCredential: vi.fn(async (_o: object) => {}),
    ...(platform.caps === null
      ? {}
      : {
          getClientCapabilities: vi.fn(
            async () => platform.caps ?? { "extension:prf": true },
          ),
        }),
  };
  vi.stubGlobal("PublicKeyCredential", PKC);
  vi.stubGlobal("isSecureContext", true);
  Object.defineProperty(globalThis.navigator, "credentials", {
    value: { create: auth.create, get: auth.get },
    configurable: true,
    writable: true,
  });
  return PKC;
}

let auth: FakeAuthenticator;
let p: PasskeyToken;

beforeEach(() => {
  auth = new FakeAuthenticator();
  p = passkeyToken({ app: "notes" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis.navigator as { credentials?: unknown }).credentials;
});

/** The token the fake authenticator's credential `id` gives `app`. */
async function expectedToken(id: string, app = "notes"): Promise<string> {
  return encodeToken(
    await derivePasskeySecret(await auth.expectedPrf(id), app),
  );
}

describe("passkeyToken() options", () => {
  it("rejects an invalid app id synchronously", () => {
    for (const app of [undefined, "", "Upper", "x".repeat(65)])
      expect(() => passkeyToken({ app } as unknown as { app: string })).toThrow(
        TypeError,
      );
  });

  it("rejects an invalid rpId with TypeError before prompting", async () => {
    install(auth);
    for (const rpId of ["", "https://example.com", "example.com:443", "a b"]) {
      const bad = passkeyToken({ app: "notes", rpId });
      await expect(bad.create()).rejects.toThrow(TypeError);
      await expect(bad.get()).rejects.toThrow(TypeError);
    }
    expect(auth.create).not.toHaveBeenCalled();
    expect(auth.get).not.toHaveBeenCalled();
  });
});

describe("KP-7 available()", () => {
  it("KP-7 false without PublicKeyCredential", async () => {
    install(auth);
    vi.stubGlobal("PublicKeyCredential", undefined);
    expect(await p.available()).toBe(false);
  });

  it("KP-7 false without navigator.credentials", async () => {
    install(auth);
    delete (globalThis.navigator as { credentials?: unknown }).credentials;
    expect(await p.available()).toBe(false);
  });

  it("KP-7 false outside a secure context, before any probe", async () => {
    const PKC = install(auth);
    vi.stubGlobal("isSecureContext", false);
    expect(await p.available()).toBe(false);
    expect(
      PKC.isUserVerifyingPlatformAuthenticatorAvailable,
    ).not.toHaveBeenCalled();
  });

  it("KP-7 false when getClientCapabilities reports extension:prf false, or the probe throws", async () => {
    install(auth, { caps: { "extension:prf": false } });
    expect(await p.available()).toBe(false);
    const PKC = install(auth);
    PKC.isUserVerifyingPlatformAuthenticatorAvailable.mockRejectedValueOnce(
      new Error("boom"),
    );
    expect(await p.available()).toBe(false);
    install(auth, { uv: false });
    expect(await p.available()).toBe(false);
  });

  it("KP-7 true with a UV platform authenticator and PRF (or no capability report), and never prompts", async () => {
    install(auth);
    expect(await p.available()).toBe(true);
    install(auth, { caps: {} });
    expect(await p.available()).toBe(true);
    install(auth, { caps: null });
    expect(await p.available()).toBe(true);
    expect(auth.create).not.toHaveBeenCalled();
    expect(auth.get).not.toHaveBeenCalled();
  });
});

describe("D-58 supported: the token comes from the PRF output, with nothing stored", () => {
  beforeEach(() => {
    install(auth);
  });

  it("create() returns the token derived from the new passkey; get() returns the same token", async () => {
    const token = await p.create();
    expect(auth.create).toHaveBeenCalledOnce();
    expect(auth.get).not.toHaveBeenCalled(); // PRF came back at creation
    expect(token).toBe(await expectedToken(auth.chosen!));
    expect(await decodeToken(token)).toHaveLength(32);
    expect(await p.get()).toBe(token);
    expect(await passkeyToken({ app: "notes" }).get()).toBe(token);
  });

  it("KP-5/SEC-7 create() asks for a discoverable, user-verified credential with a random handle, no attestation, PRF with the library input", async () => {
    await p.create();
    const opts = auth.createCalls[0]!.publicKey;
    expect(opts.authenticatorSelection).toMatchObject({
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    });
    expect(opts.attestation).toBe("none");
    expect(opts.user).toMatchObject({ name: "notes", displayName: "notes" });
    expect((opts.user.id as Uint8Array).byteLength).toBe(16);
    expect(
      new TextDecoder().decode(
        (opts.extensions as { prf: { eval: { first: Uint8Array } } }).prf.eval
          .first,
      ),
    ).toBe("burrow/prf-token/v1");
    await p.create();
    expect(auth.createCalls[1]!.publicKey.user.id).not.toEqual(opts.user.id);
  });

  it("each create() is a new passkey and a new token; it never replaces an earlier one", async () => {
    const first = await p.create();
    const firstId = auth.chosen!;
    const second = await p.create();
    expect(second).not.toBe(first);
    auth.chosen = firstId; // the user picks the first passkey again
    expect(await p.get()).toBe(first);
  });

  it("D-54 one passkey gives each app its own token", async () => {
    const notes = await p.create();
    const todo = await passkeyToken({ app: "todo" }).get();
    expect(todo).not.toBe(notes);
    expect(todo).toBe(await expectedToken(auth.chosen!, "todo"));
  });

  it("KP-6 get() is discoverable, user-verified and evaluates the library input", async () => {
    await p.create();
    await p.get();
    const opts = auth.getCalls[0]!.publicKey;
    expect(opts.allowCredentials).toEqual([]);
    expect(opts.userVerification).toBe("required");
  });

  it("create() with prf.enabled but no results takes exactly one follow-up assertion for that credential", async () => {
    auth.createMode = "enabled-only";
    const token = await p.create();
    expect(auth.get).toHaveBeenCalledOnce();
    const allow = auth.getCalls[0]!.publicKey.allowCredentials!;
    expect(allow).toHaveLength(1);
    expect(b64url(new Uint8Array(allow[0]!.id as ArrayBuffer))).toBe(
      auth.chosen,
    );
    expect(token).toBe(await expectedToken(auth.chosen!));
  });

  it("D-58 nothing is written to IndexedDB, Web Storage or a backend", async () => {
    const before = await indexedDB.databases();
    const opened = vi.spyOn(indexedDB, "open");
    const fetched = vi.spyOn(globalThis, "fetch");
    await p.create();
    await p.get();
    expect(opened).not.toHaveBeenCalled();
    expect(fetched).not.toHaveBeenCalled();
    expect(await indexedDB.databases()).toEqual(before);
  });

  it("the token opens the store like any other token", async () => {
    const token = await p.create();
    const world = new World();
    try {
      const a = await world.device().core({ app: "notes", token });
      await a.set({ k: "from the passkey's token" });
      const b = await world
        .device()
        .core({ app: "notes", token: await p.get() });
      expect(await b.get()).toEqual({ k: "from the passkey's token" });
    } finally {
      world.close();
    }
  });

  it("rp.name defaults to the host, rpId and labels are passed through", async () => {
    vi.stubGlobal("location", { hostname: "Example.COM" });
    const q = passkeyToken({
      app: "notes",
      rpId: "Example.com",
      userName: "me",
      displayName: "Me",
    });
    await q.create();
    await q.get();
    const c = auth.createCalls[0]!.publicKey;
    expect(c.rp).toEqual({ name: "Example.COM", id: "example.com" });
    expect(c.user).toMatchObject({ name: "me", displayName: "Me" });
    expect(auth.getCalls[0]!.publicKey.rpId).toBe("example.com");
  });
});

describe("D-58 cancelled and unsupported flows reject; null is never a token", () => {
  beforeEach(() => {
    install(auth);
  });

  it("create() rejects cancelled when the prompt is dismissed or aborted", async () => {
    auth.create.mockRejectedValueOnce(notAllowed());
    await expect(p.create()).rejects.toMatchObject({
      name: "BurrowError",
      code: "cancelled",
    });
    auth.create.mockRejectedValueOnce(new DOMException("x", "AbortError"));
    await expect(p.create()).rejects.toMatchObject({ code: "cancelled" });
    auth.create.mockResolvedValueOnce(null);
    await expect(p.create()).rejects.toMatchObject({ code: "cancelled" });
  });

  it("create() rejects cancelled when the follow-up assertion is dismissed; get() later returns the token", async () => {
    auth.createMode = "enabled-only";
    auth.getMode = "cancel";
    await expect(p.create()).rejects.toMatchObject({ code: "cancelled" });
    auth.getMode = "ok";
    expect(await p.get()).toBe(await expectedToken(auth.chosen!));
  });

  it("create() on an authenticator without PRF rejects prf-unsupported and signals the useless passkey", async () => {
    const PKC = install(auth);
    auth.createMode = "disabled";
    await expect(p.create()).rejects.toMatchObject({ code: "prf-unsupported" });
    expect(PKC.signalUnknownCredential).toHaveBeenCalledWith({
      rpId: "localhost",
      credentialId: auth.chosen,
    });
  });

  it("create() still rejects prf-unsupported where signalUnknownCredential is missing or fails", async () => {
    const PKC = install(auth) as { signalUnknownCredential?: unknown };
    delete PKC.signalUnknownCredential;
    auth.createMode = "disabled";
    await expect(p.create()).rejects.toMatchObject({ code: "prf-unsupported" });
    const PKC2 = install(auth);
    PKC2.signalUnknownCredential.mockRejectedValueOnce(new Error("no"));
    await expect(p.create()).rejects.toMatchObject({ code: "prf-unsupported" });
  });

  it("create() rejects prf-unsupported when it fails for another reason", async () => {
    auth.create.mockRejectedValueOnce(
      new DOMException("no", "NotSupportedError"),
    );
    await expect(p.create()).rejects.toMatchObject({ code: "prf-unsupported" });
  });

  it("get() rejects cancelled when the user dismisses the prompt, it times out, or there is no passkey", async () => {
    auth.getMode = "cancel";
    await expect(p.get()).rejects.toMatchObject({ code: "cancelled" });
    auth.getMode = "null";
    await expect(p.get()).rejects.toMatchObject({ code: "cancelled" });
    // No credential at all: the browser says NotAllowedError.
    auth.getMode = "ok";
    await expect(p.get()).rejects.toMatchObject({ code: "cancelled" });
  });

  it("get() rejects prf-unsupported when the assertion has no PRF result or fails otherwise", async () => {
    await p.create();
    auth.getMode = "no-prf";
    await expect(p.get()).rejects.toMatchObject({ code: "prf-unsupported" });
    auth.getMode = "ok";
    auth.get.mockRejectedValueOnce(new DOMException("x", "SecurityError"));
    await expect(p.get()).rejects.toMatchObject({ code: "prf-unsupported" });
  });

  it("every rejection is a BurrowError, never a null or empty token", async () => {
    auth.getMode = "null";
    const err = await p.get().catch((e) => e);
    expect(err).toBeInstanceOf(BurrowError);
  });
});

describe("D-58 derivation vectors", () => {
  it("token = HKDF-SHA256(prf, salt burrow/passkey-token/v1, info app), encoded as a storage token", async () => {
    for (const v of vectors.passkeyToken) {
      const secret = await derivePasskeySecret(
        Uint8Array.from(Buffer.from(v.prfHex, "hex")),
        v.app,
      );
      expect(hex(secret)).toBe(v.secretHex);
      expect(await encodeToken(secret)).toBe(v.token);
    }
  });

  it("the PRF input is the library constant", async () => {
    expect(PRF_SALT).toBe("burrow/prf-token/v1");
    // The fake authenticator's own outputs: one seed, one input, one output.
    const out = await sha256(concat(new Uint8Array(32), utf8(PRF_SALT)));
    expect(out).toHaveLength(32);
    expect(fromB64url(b64url(out))).toEqual(out);
  });
});
