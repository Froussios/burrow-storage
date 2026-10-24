// FS-3/BE-3 backend selection: the app passes an instance or a config to
// burrow(); page config is data the app may read with readBackendConfig()
// (D-57).
import { afterEach, describe, expect, it, vi } from "vitest";
import { FirestoreBackend } from "../../src/backends/firestore.js";
import { MemoryBackend } from "../../src/backends/memory.js";
import { readBackendConfig, registerBackend } from "../../src/config.js";
import { burrow, generateToken } from "../../src/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function page(meta: Record<string, string> = {}, config = {}) {
  vi.stubGlobal("document", {
    querySelector: (selector: string) => {
      const name = selector.match(/name="([^"]+)"/)?.[1] ?? "";
      return name in meta ? { getAttribute: () => meta[name] } : null;
    },
  });
  vi.stubGlobal("BURROW", config);
}

const shared = new MemoryBackend();
const factory = vi.fn(() => shared);
registerBackend("test-memory", factory);

describe("FS-3 readBackendConfig()", () => {
  it("prefers generic meta, then the generic global, then Firestore meta and global", () => {
    page(
      {
        "burrow-backend": '{"type":"test-memory","region":"example"}',
        "burrow-firestore": "invalid JSON must not be read",
      },
      { backend: { type: "unknown" } },
    );
    expect(readBackendConfig()).toEqual({
      type: "test-memory",
      region: "example",
    });
    page({}, { backend: { type: "test-memory" }, firestore: {} });
    expect(readBackendConfig()).toEqual({ type: "test-memory" });
    for (const viaMeta of [true, false]) {
      const firestore = { apiKey: "publishable", projectId: "caller-project" };
      page(
        viaMeta ? { "burrow-firestore": JSON.stringify(firestore) } : {},
        viaMeta ? {} : { firestore },
      );
      expect(readBackendConfig()).toEqual({ ...firestore, type: "firestore" });
    }
    page();
    expect(readBackendConfig()).toBeNull();
  });

  it.each(["{", "null", "[]"])(
    "rejects malformed page config %s with a TypeError that does not echo it",
    (content) => {
      page({ "burrow-backend": content });
      expect(() => readBackendConfig()).toThrow(TypeError);
      page({ "burrow-firestore": content });
      expect(() => readBackendConfig()).toThrow(TypeError);
    },
  );

  it("burrow() never reads page config by itself", async () => {
    page({ "burrow-backend": '{"type":"test-memory"}' });
    await expect(
      burrow({ app: "x", token: await generateToken() } as never),
    ).rejects.toThrow(TypeError);
  });
});

describe("BE-1/BE-3 the backend passed to burrow()", () => {
  it("a config loads only the selected registered adapter", async () => {
    factory.mockClear();
    const s = await burrow({
      app: "config-test",
      token: await generateToken(),
      backend: { type: "test-memory", region: "example" },
    });
    expect(factory).toHaveBeenCalledExactlyOnceWith({
      type: "test-memory",
      region: "example",
    });
    await s.set({ k: 1 });
    expect(shared.stats.puts).toBeGreaterThan(0);
  });

  it("a Firestore config is accepted without contacting Firestore", async () => {
    const s = await burrow({
      app: "x",
      token: await generateToken(),
      backend: {
        type: "firestore",
        apiKey: "emulator",
        projectId: "burrow-rules-test",
        emulator: { host: "127.0.0.1", port: 1 },
      },
    });
    s.close();
  });

  it.each([
    { id: undefined },
    { capabilities: undefined },
    { capabilities: { writeAuth: "true", subscribe: false } },
    { capabilities: { writeAuth: true, subscribe: undefined } },
    { get: undefined },
  ])("a malformed instance %j rejects with TypeError", async (invalid) => {
    const backend = {
      id: "supplied",
      capabilities: { writeAuth: true, subscribe: false },
      get: vi.fn(async () => null),
      put: vi.fn(async () => {}),
      ...invalid,
    };
    await expect(
      burrow({
        app: "x",
        token: await generateToken(),
        backend: backend as never,
      }),
    ).rejects.toThrow(TypeError);
  });

  it("a rejected factory gives a fixed backend error and never exposes its values", async () => {
    const secret = "sensitive config value";
    registerBackend("test-rejecting", () => {
      throw new Error(secret);
    });
    const error = await burrow({
      app: "x",
      token: await generateToken(),
      backend: { type: "test-rejecting" },
    }).catch((e) => e);
    expect(error.code).toBe("backend");
    expect(error.message).toBe("backend configuration failed");
    expect(error.cause).toBeUndefined();
  });

  it("refuses registry replacement and invalid adapter types", () => {
    expect(() => registerBackend("firestore", factory)).toThrow(TypeError);
    expect(() => registerBackend("not/a/script", factory)).toThrow(TypeError);
  });

  it("FS-3 appId is optional, while missing or invalid required fields are rejected", () => {
    expect(
      new FirestoreBackend({ apiKey: "publishable", projectId: "own-project" }),
    ).toBeInstanceOf(FirestoreBackend);
    for (const config of [
      {},
      { apiKey: 1, projectId: "own-project" },
      { apiKey: "publishable", projectId: " " },
      { apiKey: "publishable", projectId: "own-project", collection: "a/b" },
      { apiKey: "publishable", projectId: "own-project", appId: " " },
    ])
      expect(() => new FirestoreBackend(config as never)).toThrow(TypeError);
  });
});
