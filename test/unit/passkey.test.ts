// KP-5..9, SEC-7, ENC-11: the passkey provider against a scripted WebAuthn authenticator.
// Browser coverage with a real (virtual) authenticator lives in test/e2e/passkey.spec.ts.
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
import { BackendError, BurrowError } from "../../src/errors.js";
import { passkey } from "../../src/providers/passkey.js";
import type { KeyProvider, ProviderStore } from "../../src/types.js";
import { World } from "../support/devices.js";

const CRED_KEY = "passkey.credentialId";

/** Copy into a fresh ArrayBuffer: the provider zeroises the PRF output it receives. */
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
 * A scripted platform authenticator. Each credential has a fixed 32-byte seed; its PRF output for
 * a salt is SHA-256(seed || salt), so outputs are deterministic and differ per credential.
 */
class FakeAuthenticator {
  readonly creds = new Map<string, Uint8Array>(); // b64url(rawId) -> seed
  /** What create() reports: PRF results inline, only `enabled`, or `enabled: false`. */
  createMode: "results" | "enabled-only" | "disabled" = "results";
  /** Override get(): resolve null, reject, or omit PRF results. */
  getMode: "ok" | "null" | "cancel" | "no-prf" = "ok";
  /** Credential picked by a discoverable get() (empty allowCredentials). Default: the last created. */
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

  /** PRF output this authenticator gives for credential `id` with Burrow's salt. */
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
    if (!id || !this.creds.has(id)) throw notAllowed(); // no matching credential on this authenticator
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

/** Install the authenticator as navigator.credentials and a matching PublicKeyCredential. */
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
  Object.defineProperty(globalThis.navigator, "credentials", {
    value: { create: auth.create, get: auth.get },
    configurable: true,
    writable: true,
  });
  return PKC;
}

function memStore(): ProviderStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (n) => map.get(n),
    set: async (n, v) => {
      map.set(n, v);
    },
  };
}

let auth: FakeAuthenticator;
let backend: MemoryBackend;
let store: ReturnType<typeof memStore>;
let p: KeyProvider;
const enrol = (rootSecret: Uint8Array, b = backend, s: ProviderStore = store) =>
  p.enrol({ app: "test", rootSecret, backend: b, store: s });
const recover = (b = backend, s: ProviderStore = store, interactive = true) =>
  p.recover({ app: "test", interactive, backend: b, store: s });

beforeEach(() => {
  auth = new FakeAuthenticator();
  backend = new MemoryBackend();
  store = memStore();
  p = passkey();
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
    install(auth, { caps: {} }); // extension:prf unknown: falls back to the UV check
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

describe("KP-5/KP-6 enrol and recover", () => {
  beforeEach(() => {
    install(auth);
  });

  it("KP-5 enrol with PRF results from create() writes a keyslot that KP-6 recover() unwraps", async () => {
    const secret = randomBytes(32);
    const keep = secret.slice();
    await enrol(secret);
    expect(auth.create).toHaveBeenCalledOnce();
    expect(auth.get).not.toHaveBeenCalled(); // PRF came back at creation: no second prompt

    // ENC-11: one ordinary envelope at slotId, derived from the PRF output.
    const slot = await deriveSlotKeys(await auth.expectedPrf(auth.chosen!));
    expect([...backend.store.keys()]).toEqual([slot.slotId]);
    expect(backend.store.get(slot.slotId)).toMatchObject({ v: 1, rev: 0 });
    expect(secret).toEqual(keep); // enrol does not consume the caller's buffer

    // A new device: empty provider store, same (synced) passkey, same backend.
    const got = await recover(backend, memStore());
    expect(got).toBeInstanceOf(Uint8Array);
    expect(got!.length).toBe(32);
    expect(got).toEqual(keep);
    expect(auth.get).toHaveBeenCalledOnce();
  });

  it("KP-5/SEC-7 create() asks for a discoverable, user-verified credential, no attestation, PRF with the library salt", async () => {
    p = passkey({ rpId: "example.com", rpName: "Example", userName: "notes" });
    await enrol(randomBytes(32));
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

  it("KP-5 user.name defaults to the app id", async () => {
    await enrol(randomBytes(32));
    expect(auth.createCalls[0]!.publicKey.user).toMatchObject({
      name: "test",
      displayName: "test",
    });
  });

  it("KP-5 create() with prf.enabled but no results takes exactly one follow-up get() for the PRF output", async () => {
    auth.createMode = "enabled-only";
    const secret = randomBytes(32);
    await enrol(secret);
    expect(auth.create).toHaveBeenCalledOnce();
    expect(auth.get).toHaveBeenCalledOnce();
    // The follow-up assertion targets the credential just created and asks for UV and the salt.
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
    expect(await recover(backend, memStore())).toEqual(secret);
  });

  it("KP-5 enrol rejects no-provider when the follow-up get() is dismissed, and writes nothing", async () => {
    auth.createMode = "enabled-only";
    auth.getMode = "cancel";
    await expect(enrol(randomBytes(32))).rejects.toMatchObject({
      name: "BurrowError",
      code: "no-provider",
    });
    expect(backend.store.size).toBe(0);
  });

  it("KP-7 create() reporting prf.enabled false rejects prf-unsupported and writes nothing", async () => {
    auth.createMode = "disabled";
    const err = await enrol(randomBytes(32)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BurrowError);
    expect(err).toMatchObject({ code: "prf-unsupported" });
    expect(auth.get).not.toHaveBeenCalled();
    expect(backend.store.size).toBe(0);
  });

  it("KP-5 enrol rejects no-provider when the create() prompt is dismissed", async () => {
    auth.create.mockRejectedValueOnce(notAllowed());
    await expect(enrol(randomBytes(32))).rejects.toMatchObject({
      code: "no-provider",
    });
    auth.create.mockResolvedValueOnce(null);
    await expect(enrol(randomBytes(32))).rejects.toMatchObject({
      code: "no-provider",
    });
    expect(backend.store.size).toBe(0);
  });

  it("KP-5 enrol rejects prf-unsupported when create() fails for another reason", async () => {
    auth.create.mockRejectedValueOnce(
      new DOMException("nope", "NotSupportedError"),
    );
    await expect(enrol(randomBytes(32))).rejects.toMatchObject({
      code: "prf-unsupported",
    });
  });

  it("KP-5/ENC-11 re-enrol over an existing keyslot continues its write-token chain", async () => {
    const first = randomBytes(32);
    await enrol(first);
    const id = auth.chosen!;
    const slot = await deriveSlotKeys(await auth.expectedPrf(id));
    expect(backend.store.get(slot.slotId)!.rev).toBe(0);

    // A new token enrolled under a credential whose PRF output is the same (the authenticator hands
    // back the existing credential), so the slot id is the same and the write must follow the chain.
    auth.createMode = "enabled-only";
    auth.create.mockImplementation(async (opts) => {
      auth.createCalls.push(opts);
      return {
        rawId: fresh(fromB64url(id)),
        getClientExtensionResults: () => ({ prf: { enabled: true } }),
      } as unknown as PublicKeyCredential;
    });
    const second = randomBytes(32);
    await enrol(second); // MemoryBackend refuses a put that breaks the tok/next chain
    expect(backend.store.size).toBe(1);
    expect(backend.store.get(slot.slotId)!.rev).toBe(1);
    await enrol(second);
    expect(backend.store.get(slot.slotId)!.rev).toBe(2);
    expect(await recover(backend, memStore())).toEqual(second);
  });

  it("KP-5 enrol retries a keyslot write that loses a race, then succeeds", async () => {
    const put = backend.put.bind(backend);
    const spy = vi
      .spyOn(backend, "put")
      .mockRejectedValueOnce(new BackendError("conflict"))
      .mockRejectedValueOnce(new BackendError("conflict"))
      .mockImplementation(put);
    const secret = randomBytes(32);
    await enrol(secret);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(await recover(backend, memStore())).toEqual(secret);
  });

  it("KP-5 enrol rejects conflict after three lost races", async () => {
    vi.spyOn(backend, "put").mockRejectedValue(new BackendError("conflict"));
    await expect(enrol(randomBytes(32))).rejects.toMatchObject({
      name: "BurrowError",
      code: "conflict",
    });
    expect(backend.put).toHaveBeenCalledTimes(3);
  });

  it("KP-5 a store failure during the keyslot write rejects enrol with the raw BackendError (docs/api.md)", async () => {
    backend.failWith = "network";
    const err = await enrol(randomBytes(32)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendError);
    expect(err).toMatchObject({ code: "network" });
    expect(backend.store.size).toBe(0);
  });
});

describe("KP-6/KP-8 recover outcomes", () => {
  beforeEach(() => {
    install(auth);
  });

  it("KP-8 recover() without a user gesture returns null and does not prompt", async () => {
    await enrol(randomBytes(32));
    expect(await recover(backend, store, false)).toBeNull();
    expect(auth.get).not.toHaveBeenCalled();
  });

  it("KP-6 recover() returns null when the user cancels (get rejects NotAllowedError)", async () => {
    await enrol(randomBytes(32));
    auth.getMode = "cancel";
    expect(await recover(backend, memStore())).toBeNull();
  });

  it("KP-6 recover() returns null when the prompt is aborted (AbortError)", async () => {
    await enrol(randomBytes(32));
    auth.get.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    expect(await recover(backend, memStore())).toBeNull();
  });

  it("KP-6 recover() returns null when get() resolves null", async () => {
    await enrol(randomBytes(32));
    auth.getMode = "null";
    expect(await recover(backend, memStore())).toBeNull();
  });

  it("KP-6 recover() returns null when no keyslot exists for the PRF output", async () => {
    await enrol(randomBytes(32));
    expect(await recover(new MemoryBackend(), memStore())).toBeNull(); // a backend without the slot
    // A different passkey whose PRF output has no slot behind it.
    auth.creds.set("other-credential-id-xx", new Uint8Array(32).fill(0x99));
    auth.chosen = "other-credential-id-xx";
    const before = backend.stats.gets;
    expect(await recover(backend, memStore())).toBeNull();
    expect(backend.stats.gets).toBe(before + 1);
  });

  it("KP-6/ENC-6 recover() rejects decrypt-failed when the keyslot ciphertext is tampered with", async () => {
    await enrol(randomBytes(32));
    const slot = await deriveSlotKeys(await auth.expectedPrf(auth.chosen!));
    const env = backend.store.get(slot.slotId)!;
    const ct = env.ct;
    env.ct = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
    const err = await recover(backend, memStore()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BurrowError);
    expect(err).toMatchObject({ code: "decrypt-failed" });
  });

  it("KP-6/ENC-11 a keyslot moved to another revision does not decrypt (rev is in the AAD)", async () => {
    await enrol(randomBytes(32));
    const slot = await deriveSlotKeys(await auth.expectedPrf(auth.chosen!));
    backend.store.get(slot.slotId)!.rev = 7;
    await expect(recover(backend, memStore())).rejects.toMatchObject({
      code: "decrypt-failed",
    });
  });

  it("KP-6 recover() rejects prf-unsupported when the assertion carries no PRF result", async () => {
    await enrol(randomBytes(32));
    auth.getMode = "no-prf";
    await expect(recover(backend, memStore())).rejects.toMatchObject({
      code: "prf-unsupported",
    });
  });

  it("KP-6 recover() rejects prf-unsupported when get() fails for a reason other than dismissal", async () => {
    await enrol(randomBytes(32));
    auth.get.mockRejectedValueOnce(
      new DOMException("bad rp id", "SecurityError"),
    );
    await expect(recover(backend, memStore())).rejects.toMatchObject({
      code: "prf-unsupported",
    });
  });

  it("KP-6 get() asks for user verification and evaluates PRF with the library salt", async () => {
    p = passkey({ rpId: "example.com", timeoutMs: 5_000 });
    await enrol(randomBytes(32));
    await recover(backend, memStore());
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

describe("KP-9 cached credential id", () => {
  beforeEach(() => {
    install(auth);
  });

  it("KP-9 enrol caches the credential id in the provider store", async () => {
    await enrol(randomBytes(32));
    expect(store.map.get(CRED_KEY)).toBe(auth.chosen);
  });

  it("KP-9 enrol caches no credential id when the keyslot write fails", async () => {
    backend.failWith = "network";
    await expect(enrol(randomBytes(32))).rejects.toMatchObject({
      code: "network",
    });
    expect(store.map.has(CRED_KEY)).toBe(false);
  });

  it("KP-9 a failure to save the credential id does not fail an enrolment whose keyslot is written", async () => {
    const failing: ProviderStore = {
      get: async () => undefined,
      set: async () => {
        throw new Error("quota");
      },
    };
    const secret = randomBytes(32);
    await enrol(secret, backend, failing);
    expect(backend.store.size).toBe(1);
    expect(await recover(backend, memStore())).toEqual(secret);
  });

  it("KP-9 recover passes the cached id as allowCredentials", async () => {
    const secret = randomBytes(32);
    await enrol(secret);
    const id = auth.chosen!;
    auth.chosen = undefined; // a discoverable request would fail: only allowCredentials can succeed
    expect(await recover()).toEqual(secret);
    const allow = auth.getCalls[0]!.publicKey.allowCredentials!;
    expect(allow).toHaveLength(1);
    expect(allow[0]!.type).toBe("public-key");
    expect(
      b64url(new Uint8Array(allow[0]!.id as Uint8Array<ArrayBuffer>)),
    ).toBe(id);
  });

  it("KP-9 without a cached id recover makes a discoverable request, then caches the id it got", async () => {
    const secret = randomBytes(32);
    await enrol(secret);
    const other = memStore();
    expect(await recover(backend, other)).toEqual(secret);
    expect(auth.getCalls[0]!.publicKey.allowCredentials).toEqual([]);
    expect(other.map.get(CRED_KEY)).toBe(auth.chosen);
  });

  it("KP-9 recover does not cache an id when nothing was recovered", async () => {
    await enrol(randomBytes(32));
    const other = memStore();
    expect(await recover(new MemoryBackend(), other)).toBeNull();
    expect(other.map.has(CRED_KEY)).toBe(false);
  });

  it("KP-9 works without a provider store", async () => {
    const secret = randomBytes(32);
    await p.enrol({ app: "test", rootSecret: secret, backend });
    expect(
      await p.recover({ app: "test", interactive: true, backend }),
    ).toEqual(secret);
    expect(auth.getCalls[0]!.publicKey.allowCredentials).toEqual([]);
  });
});

describe("KP-3 through the StorageArea", () => {
  let world: World;
  afterEach(() => world?.close());

  it("KP-3/KP-6 protect('passkey') on one device, link({ provider: 'passkey' }) on another restores the data", async () => {
    install(auth);
    world = new World();
    const a = await world.device().open({ keyProvider: passkey() });
    await a.set({ theme: "dark" });
    await a.syncNow();
    await a.protect("passkey");
    expect(a.protection).toBe("passkey");
    const code = await a.exportCode();

    const b = await world.device().open({ keyProvider: passkey() });
    expect(await b.exportCode()).not.toBe(code);
    await b.link({ provider: "passkey" });
    expect(await b.exportCode()).toBe(code);
    expect(await b.get("theme")).toEqual({ theme: "dark" });
    expect(b.protection).toBe("passkey");
    expect(auth.get).toHaveBeenCalledOnce();
  });

  it("KP-7 protect('passkey') rejects prf-unsupported when the provider is unavailable", async () => {
    install(auth, { uv: false });
    world = new World();
    const a = await world.device().open({ keyProvider: passkey() });
    await expect(a.protect("passkey")).rejects.toMatchObject({
      code: "prf-unsupported",
    });
    expect(auth.create).not.toHaveBeenCalled();
  });
});
