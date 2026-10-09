// KP-5..8, SEC-7, ENC-11: burrow-storage/passkey against a scripted WebAuthn
// authenticator. Browser coverage with a real (virtual) authenticator lives in
// test/e2e/passkey.spec.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBackend } from "../../src/backends/memory.js";
import {
  b64url,
  concat,
  fromB64url,
  randomBytes,
  sha256,
  utf8,
} from "../../src/bytes.js";
import { PRF_SALT_V1, deriveSlotKeys } from "../../src/codec/derive.js";
import { encodeToken } from "../../src/codec/token.js";
import { BackendError, BurrowError } from "../../src/errors.js";
import { type PasskeyBackup, passkeyBackup } from "../../src/passkey.js";
import type { BackendConfig } from "../../src/types.js";
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
    return this.prf(this.creds.get(id)!, utf8(PRF_SALT_V1));
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
let backend: MemoryBackend;
let p: PasskeyBackup;
const newToken = () => encodeToken(randomBytes(32));

beforeEach(() => {
  auth = new FakeAuthenticator();
  backend = new MemoryBackend();
  p = passkeyBackup({ backend });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis.navigator as { credentials?: unknown }).credentials;
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

  it("KP-7 false when there is no user-verifying platform authenticator", async () => {
    install(auth, { uv: false });
    expect(await p.available()).toBe(false);
  });

  it("KP-7 false when getClientCapabilities reports extension:prf false", async () => {
    const PKC = install(auth, { caps: { "extension:prf": false } });
    expect(await p.available()).toBe(false);
    expect(PKC.getClientCapabilities).toHaveBeenCalledOnce();
  });

  it("KP-7 false when the capability probe throws", async () => {
    const PKC = install(auth);
    PKC.isUserVerifyingPlatformAuthenticatorAvailable.mockRejectedValueOnce(
      new Error("boom"),
    );
    expect(await p.available()).toBe(false);
  });

  it("KP-7 true with a UV platform authenticator and PRF (or no capability report)", async () => {
    install(auth);
    expect(await p.available()).toBe(true);
    // extension:prf unknown: falls back to the UV check
    install(auth, { caps: {} });
    expect(await p.available()).toBe(true);
    install(auth, { caps: null }); // browser without getClientCapabilities
    expect(await p.available()).toBe(true);
  });

  it("KP-7 never prompts: create() and get() are not called", async () => {
    install(auth);
    await p.available();
    install(auth, { uv: false });
    await p.available();
    expect(auth.create).not.toHaveBeenCalled();
    expect(auth.get).not.toHaveBeenCalled();
  });
});

describe("KP-5/KP-6 save and restore", () => {
  beforeEach(() => {
    install(auth);
  });

  it("KP-5 save with PRF results from create() writes a keyslot that KP-6 restore() opens", async () => {
    const token = await newToken();
    await p.save(token);
    expect(auth.create).toHaveBeenCalledOnce();
    // PRF came back at creation: no second prompt
    expect(auth.get).not.toHaveBeenCalled();

    // ENC-11: one ordinary envelope at slotId, derived from the PRF output.
    const slot = await deriveSlotKeys(await auth.expectedPrf(auth.chosen!));
    expect([...backend.store.keys()]).toEqual([slot.slotId]);
    expect(backend.store.get(slot.slotId)).toMatchObject({ v: 1, rev: 0 });

    // A new device: a fresh utility, the same (synced) passkey, same backend.
    expect(await passkeyBackup({ backend }).restore()).toBe(token);
    expect(auth.get).toHaveBeenCalledOnce();
  });

  it("KP-5 save accepts the token as a user would type it", async () => {
    const token = await newToken();
    await p.save(token.toLowerCase().replace(/-/g, " "));
    expect(await p.restore()).toBe(token);
  });

  it("KP-12 save rejects bad-token before prompting or writing", async () => {
    for (const bad of ["", "0000-0000", 42 as unknown as string])
      await expect(p.save(bad)).rejects.toMatchObject({ code: "bad-token" });
    expect(auth.create).not.toHaveBeenCalled();
    expect(backend.stats.puts).toBe(0);
  });

  it("KP-5/SEC-7 create() asks for a discoverable, user-verified credential, no attestation, PRF with the library salt", async () => {
    p = passkeyBackup({
      backend,
      rpId: "example.com",
      rpName: "Example",
      userName: "notes",
    });
    await p.save(await newToken());
    const pk = auth.createCalls[0]!.publicKey;
    expect(pk.rp).toEqual({ id: "example.com", name: "Example" });
    expect(pk.user.name).toBe("notes");
    expect(pk.authenticatorSelection).toMatchObject({
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    });
    expect(pk.attestation).toBe("none");
    const first = (pk.extensions as { prf: { eval: { first: Uint8Array } } })
      .prf.eval.first;
    expect(new TextDecoder().decode(first)).toBe(PRF_SALT_V1);
  });

  it("KP-5 rp.name and user.name default to the page's host", async () => {
    vi.stubGlobal("location", { hostname: "notes.example" });
    await p.save(await newToken());
    const pk = auth.createCalls[0]!.publicKey;
    expect(pk.rp).toEqual({ name: "notes.example" });
    expect(pk.user).toMatchObject({
      name: "notes.example",
      displayName: "notes.example",
    });
  });

  it("KP-5 user handle is stable per userName, differs between labels, and displayName does not change it (D-50)", async () => {
    const handle = async (o: { userName?: string; displayName?: string }) => {
      auth.createCalls.length = 0;
      await passkeyBackup({ backend, ...o }).save(await newToken());
      const pk = auth.createCalls[0]!.publicKey;
      return { id: b64url(new Uint8Array(pk.user.id as ArrayBuffer)), pk };
    };
    const a1 = await handle({ userName: "a" });
    const a2 = await handle({ userName: "a", displayName: "Alice's laptop" });
    const b = await handle({ userName: "b" });
    expect(a1.id).toBe(a2.id);
    expect(a1.id).not.toBe(b.id);
    expect(a1.id).toHaveLength(22); // 16 bytes
    expect(a2.pk.user).toMatchObject({
      name: "a",
      displayName: "Alice's laptop",
    });
  });

  it("KP-5 create() with prf.enabled but no results takes exactly one follow-up get() for the PRF output", async () => {
    auth.createMode = "enabled-only";
    const token = await newToken();
    await p.save(token);
    expect(auth.create).toHaveBeenCalledOnce();
    expect(auth.get).toHaveBeenCalledOnce();
    // The follow-up assertion targets the credential just created and asks for
    // UV and the salt.
    const pk = auth.getCalls[0]!.publicKey;
    expect(pk.userVerification).toBe("required");
    expect(pk.allowCredentials).toHaveLength(1);
    expect(
      b64url(
        new Uint8Array(pk.allowCredentials![0]!.id as Uint8Array<ArrayBuffer>),
      ),
    ).toBe(auth.chosen);
    const slot = await deriveSlotKeys(await auth.expectedPrf(auth.chosen!));
    expect(backend.store.has(slot.slotId)).toBe(true);
    expect(await p.restore()).toBe(token);
  });

  it("KP-5 save rejects cancelled when the follow-up get() is dismissed, and writes nothing", async () => {
    auth.createMode = "enabled-only";
    auth.getMode = "cancel";
    await expect(p.save(await newToken())).rejects.toMatchObject({
      name: "BurrowError",
      code: "cancelled",
    });
    expect(backend.store.size).toBe(0);
  });

  it("KP-7 create() reporting prf.enabled false rejects prf-unsupported and writes nothing", async () => {
    auth.createMode = "disabled";
    const err = await p.save(await newToken()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BurrowError);
    expect(err).toMatchObject({ code: "prf-unsupported" });
    expect(auth.get).not.toHaveBeenCalled();
    expect(backend.store.size).toBe(0);
  });

  it("KP-5 save rejects cancelled when the create() prompt is dismissed", async () => {
    auth.create.mockRejectedValueOnce(notAllowed());
    await expect(p.save(await newToken())).rejects.toMatchObject({
      code: "cancelled",
    });
    auth.create.mockResolvedValueOnce(null);
    await expect(p.save(await newToken())).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(backend.store.size).toBe(0);
  });

  it("KP-5 save rejects prf-unsupported when create() fails for another reason", async () => {
    auth.create.mockRejectedValueOnce(
      new DOMException("nope", "NotSupportedError"),
    );
    await expect(p.save(await newToken())).rejects.toMatchObject({
      code: "prf-unsupported",
    });
  });

  it("KP-5/ENC-11 saving again over an existing keyslot continues its write-token chain", async () => {
    await p.save(await newToken());
    const id = auth.chosen!;
    const slot = await deriveSlotKeys(await auth.expectedPrf(id));
    expect(backend.store.get(slot.slotId)!.rev).toBe(0);

    // A new token saved under a credential whose PRF output is the same (the
    // authenticator hands back the existing credential), so the slot id is the
    // same and the write must follow the chain.
    auth.createMode = "enabled-only";
    auth.create.mockImplementation(async (opts) => {
      auth.createCalls.push(opts);
      return {
        rawId: fresh(fromB64url(id)),
        getClientExtensionResults: () => ({ prf: { enabled: true } }),
      } as unknown as PublicKeyCredential;
    });
    const second = await newToken();
    // MemoryBackend refuses a put that breaks the tok/next chain
    await p.save(second);
    expect(backend.store.size).toBe(1);
    expect(backend.store.get(slot.slotId)!.rev).toBe(1);
    await p.save(second);
    expect(backend.store.get(slot.slotId)!.rev).toBe(2);
    expect(await p.restore()).toBe(second);
  });

  it("KP-5 save retries a keyslot write that loses a race, then succeeds", async () => {
    const put = backend.put.bind(backend);
    const spy = vi
      .spyOn(backend, "put")
      .mockRejectedValueOnce(new BackendError("conflict"))
      .mockRejectedValueOnce(new BackendError("conflict"))
      .mockImplementation(put);
    const token = await newToken();
    await p.save(token);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(await p.restore()).toBe(token);
  });

  it("KP-5 save rejects conflict after three lost races", async () => {
    vi.spyOn(backend, "put").mockRejectedValue(new BackendError("conflict"));
    await expect(p.save(await newToken())).rejects.toMatchObject({
      name: "BurrowError",
      code: "conflict",
    });
    expect(backend.put).toHaveBeenCalledTimes(3);
  });

  it("KP-5 a store failure during the keyslot write rejects save with the raw BackendError (docs/api.md)", async () => {
    backend.failWith = "network";
    const err = await p.save(await newToken()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendError);
    expect(err).toMatchObject({ code: "network" });
    expect(backend.store.size).toBe(0);
  });

  it("save and restore reject backend, without prompting, when there is none and the page has no config", async () => {
    const none = passkeyBackup();
    await expect(none.save(await newToken())).rejects.toMatchObject({
      code: "backend",
    });
    await expect(none.restore()).rejects.toMatchObject({ code: "backend" });
    expect(auth.create).not.toHaveBeenCalled();
    expect(auth.get).not.toHaveBeenCalled();
  });
});

describe("the default backend", () => {
  beforeEach(() => {
    install(auth);
  });

  it("rejects invalid page config before prompting, without retaining its values", async () => {
    vi.resetModules();
    try {
      vi.stubGlobal("document", {
        querySelector: (selector: string) =>
          selector === 'meta[name="burrow-backend"]'
            ? { getAttribute: () => '{"projectId":"short-private' }
            : null,
      });
      const { passkeyBackup: fresh } = await import("../../src/passkey.js");
      const backup = fresh();
      const token = await newToken();
      for (const operation of [
        () => backup.save(token),
        () => backup.restore(),
      ]) {
        const error = await operation().catch((e: unknown) => e);
        expect(error).toMatchObject({
          name: "BurrowError",
          code: "backend",
          message: "backend configuration failed",
        });
        expect(error).not.toHaveProperty("cause");
      }
      expect(auth.create).not.toHaveBeenCalled();
      expect(auth.get).not.toHaveBeenCalled();
    } finally {
      vi.resetModules();
    }
  });

  it.each(["error", "burrow", "backend"])(
    "drops values from a factory-thrown %s error and retries corrected config",
    async (kind) => {
      vi.resetModules();
      try {
        const { registerBackend } = await import("../../src/config.js");
        const errors = await import("../../src/errors.js");
        const { passkeyBackup: fresh } = await import("../../src/passkey.js");
        const factory = vi.fn((config: BackendConfig) => {
          if (config.privateValue) {
            const message = `bad config: ${config.privateValue}`;
            throw kind === "burrow"
              ? new errors.BurrowError("backend", message)
              : kind === "backend"
                ? new errors.BackendError("network", message)
                : new Error(message);
          }
          return backend;
        });
        registerBackend("passkey-test", factory);
        vi.stubGlobal("BURROW", {
          backend: { type: "passkey-test", privateValue: "short-private" },
        });
        const backup = fresh();
        const token = await newToken();
        for (const operation of [
          () => backup.save(token),
          () => backup.restore(),
        ]) {
          const error = await operation().catch((e: unknown) => e);
          expect(error).toMatchObject({
            name: "BurrowError",
            code: "backend",
            message: "backend configuration failed",
          });
          expect(error).not.toHaveProperty("cause");
        }
        expect(auth.create).not.toHaveBeenCalled();
        expect(auth.get).not.toHaveBeenCalled();
        vi.stubGlobal("BURROW", { backend: { type: "passkey-test" } });
        await backup.save(token);
        expect(await backup.restore()).toBe(token);
        expect(factory).toHaveBeenCalledTimes(3);
      } finally {
        vi.resetModules();
      }
    },
  );

  it("is looked up again after a failure, not cached", async () => {
    vi.resetModules();
    const lookups = vi.fn<() => Promise<MemoryBackend | null>>();
    vi.doMock("../../src/config.js", () => ({ defaultBackend: lookups }));
    try {
      const { passkeyBackup: fresh } = await import("../../src/passkey.js");
      const b = fresh();
      lookups.mockRejectedValueOnce(new TypeError("chunk failed to load"));
      await expect(b.restore()).rejects.toMatchObject({
        name: "BurrowError",
        code: "backend",
      });
      lookups.mockResolvedValueOnce(null);
      await expect(b.restore()).rejects.toMatchObject({ code: "backend" });
      const token = await newToken();
      lookups.mockResolvedValue(backend);
      await b.save(token);
      expect(await b.restore()).toBe(token);
      expect(lookups).toHaveBeenCalledTimes(3);
      expect(auth.get).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock("../../src/config.js");
      vi.resetModules();
    }
  });
});

describe("BE-1 explicit backend instances", () => {
  beforeEach(() => {
    install(auth);
  });

  it.each([
    { get: undefined },
    { put: undefined },
    { id: undefined },
    { capabilities: undefined },
    { capabilities: { writeAuth: "true", subscribe: false } },
    { capabilities: { writeAuth: true, subscribe: undefined } },
  ])(
    "rejects malformed instance %j before prompting or calling it",
    async (invalid) => {
      const get = vi.fn(async () => null);
      const put = vi.fn(async () => {});
      const supplied = {
        id: "supplied",
        capabilities: { writeAuth: true, subscribe: false },
        get,
        put,
        ...invalid,
      };
      const backup = passkeyBackup({ backend: supplied as never });
      const token = await newToken();
      for (const operation of [
        () => backup.save(token),
        () => backup.restore(),
      ]) {
        const error = await operation().catch((e: unknown) => e);
        expect(error).toMatchObject({
          name: "BurrowError",
          code: "backend",
          message: "backend configuration failed",
        });
        expect(error).not.toHaveProperty("cause");
      }
      expect(auth.create).not.toHaveBeenCalled();
      expect(auth.get).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
    },
  );

  it("drops errors from instance validation before prompting", async () => {
    const supplied = {
      get: vi.fn(),
      put: vi.fn(),
      get capabilities(): never {
        throw new Error("private-config-value");
      },
    };
    const backup = passkeyBackup({ backend: supplied as never });
    const token = await newToken();
    for (const operation of [
      () => backup.save(token),
      () => backup.restore(),
    ]) {
      const error = await operation().catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: "backend",
        message: "backend configuration failed",
      });
      expect(error).not.toHaveProperty("cause");
    }
    expect(auth.create).not.toHaveBeenCalled();
    expect(auth.get).not.toHaveBeenCalled();
    expect(supplied.get).not.toHaveBeenCalled();
    expect(supplied.put).not.toHaveBeenCalled();
  });

  it("rejects explicit config or null without invoking a factory or falling back to the page", async () => {
    vi.resetModules();
    try {
      const { registerBackend } = await import("../../src/config.js");
      const { passkeyBackup: fresh } = await import("../../src/passkey.js");
      const factory = vi.fn(() => backend);
      registerBackend("explicit-passkey-test", factory);
      vi.stubGlobal("BURROW", {
        backend: { type: "explicit-passkey-test" },
      });
      for (const invalid of [{ type: "explicit-passkey-test" }, null]) {
        const backup = fresh({ backend: invalid as never });
        await expect(backup.save(await newToken())).rejects.toMatchObject({
          code: "backend",
          message: "backend configuration failed",
        });
        await expect(backup.restore()).rejects.toMatchObject({
          code: "backend",
        });
      }
      expect(factory).not.toHaveBeenCalled();
      expect(auth.create).not.toHaveBeenCalled();
      expect(auth.get).not.toHaveBeenCalled();
    } finally {
      vi.resetModules();
    }
  });
});

describe("KP-6 restore outcomes", () => {
  beforeEach(() => {
    install(auth);
  });

  it("KP-6 restore() makes a discoverable request: the user picks the passkey, nothing is remembered on the device", async () => {
    const token = await newToken();
    await p.save(token);
    const ls = vi.fn();
    vi.stubGlobal("localStorage", { getItem: ls, setItem: ls });
    expect(await p.restore()).toBe(token);
    expect(await p.restore()).toBe(token);
    for (const c of auth.getCalls)
      expect(c.publicKey.allowCredentials).toEqual([]);
    expect(ls).not.toHaveBeenCalled();
  });

  it("KP-6 restore() returns null when the user cancels (get rejects NotAllowedError)", async () => {
    await p.save(await newToken());
    auth.getMode = "cancel";
    expect(await p.restore()).toBeNull();
  });

  it("KP-6 restore() returns null when the prompt is aborted (AbortError)", async () => {
    await p.save(await newToken());
    auth.get.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    expect(await p.restore()).toBeNull();
  });

  it("KP-6 restore() returns null when get() resolves null", async () => {
    await p.save(await newToken());
    auth.getMode = "null";
    expect(await p.restore()).toBeNull();
  });

  it("KP-6 restore() returns null when no keyslot exists for the PRF output", async () => {
    await p.save(await newToken());
    // a backend without the slot
    expect(
      await passkeyBackup({ backend: new MemoryBackend() }).restore(),
    ).toBeNull();
    // A different passkey whose PRF output has no slot behind it.
    auth.creds.set("other-credential-id-xx", new Uint8Array(32).fill(0x99));
    auth.chosen = "other-credential-id-xx";
    const before = backend.stats.gets;
    expect(await p.restore()).toBeNull();
    expect(backend.stats.gets).toBe(before + 1);
  });

  it("KP-6/ENC-6 restore() rejects decrypt-failed when the keyslot ciphertext is tampered with", async () => {
    await p.save(await newToken());
    const slot = await deriveSlotKeys(await auth.expectedPrf(auth.chosen!));
    const env = backend.store.get(slot.slotId)!;
    const ct = env.ct;
    env.ct = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
    const err = await p.restore().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BurrowError);
    expect(err).toMatchObject({ code: "decrypt-failed" });
  });

  it("KP-6/ENC-11 a keyslot moved to another revision does not decrypt (rev is in the AAD)", async () => {
    await p.save(await newToken());
    const slot = await deriveSlotKeys(await auth.expectedPrf(auth.chosen!));
    backend.store.get(slot.slotId)!.rev = 7;
    await expect(p.restore()).rejects.toMatchObject({
      code: "decrypt-failed",
    });
  });

  it("KP-6 restore() rejects prf-unsupported when the assertion carries no PRF result", async () => {
    await p.save(await newToken());
    auth.getMode = "no-prf";
    await expect(p.restore()).rejects.toMatchObject({
      code: "prf-unsupported",
    });
  });

  it("KP-6 restore() rejects prf-unsupported when get() fails for a reason other than dismissal", async () => {
    await p.save(await newToken());
    auth.get.mockRejectedValueOnce(
      new DOMException("bad rp id", "SecurityError"),
    );
    await expect(p.restore()).rejects.toMatchObject({
      code: "prf-unsupported",
    });
  });

  it("KP-6 get() asks for user verification and evaluates PRF with the library salt", async () => {
    p = passkeyBackup({ backend, rpId: "example.com", timeoutMs: 5_000 });
    await p.save(await newToken());
    await p.restore();
    const pk = auth.getCalls[0]!.publicKey;
    expect(pk).toMatchObject({
      rpId: "example.com",
      userVerification: "required",
      timeout: 5_000,
    });
    const first = (pk.extensions as { prf: { eval: { first: Uint8Array } } })
      .prf.eval.first;
    expect(new TextDecoder().decode(first)).toBe(PRF_SALT_V1);
  });
});

describe("KP-5/KP-6 with the StorageArea", () => {
  let world: World;
  afterEach(() => world?.close());

  it("save(exportToken()) on one device; restore() then link({ token, source }) on another restores the data with one prompt", async () => {
    install(auth);
    world = new World();
    const A = world.device();
    const a = await A.open();
    await a.set({ theme: "dark" });
    await a.syncNow();
    const token = await a.exportToken();
    await passkeyBackup({ backend: A.backend }).save(token);

    const B = world.device();
    const b = await B.open();
    expect(await b.exportToken()).not.toBe(token);
    const got = await passkeyBackup({ backend: B.backend }).restore();
    expect(got).toBe(token);
    await b.link({ token: got!, source: "passkey" });
    expect(await b.get("theme")).toEqual({ theme: "dark" });
    expect(b.token.source).toBe("passkey");
    expect(auth.get).toHaveBeenCalledOnce();
  });

  it("API-7 with unsynced data, a would-orphan retry reuses the restored token: still one prompt", async () => {
    install(auth);
    world = new World();
    const A = world.device();
    const a = await A.open();
    await a.set({ theme: "dark" });
    await a.syncNow();
    await passkeyBackup({ backend: A.backend }).save(await a.exportToken());

    const B = world.device();
    const b = await B.open();
    B.backend.failWith = "network";
    await b.set({ unsynced: 1 });
    const token = (await passkeyBackup({ backend: A.backend }).restore())!;
    await expect(b.link({ token, source: "passkey" })).rejects.toMatchObject({
      code: "would-orphan",
    });
    B.backend.failWith = null;
    await b.link({ token, source: "passkey", discardLocal: true });
    expect(await b.get()).toEqual({ theme: "dark" });
    expect(auth.get).toHaveBeenCalledOnce();
  });
});
