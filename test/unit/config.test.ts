import { afterEach, describe, expect, it, vi } from "vitest";
import { FirestoreBackend } from "../../src/backends/firestore.js";
import { MemoryBackend } from "../../src/backends/memory.js";
import { defaultBackend, registerBackend } from "../../src/config.js";
import { World } from "../support/devices.js";

let world: World;
afterEach(() => {
  world?.close();
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

const factory = vi.fn(() => new MemoryBackend());
registerBackend("test-memory", factory);

describe("FS-3/BE-3 public backend configuration", () => {
  it("loads only the selected registered adapter and prefers generic meta", async () => {
    factory.mockClear();
    page(
      {
        "burrow-backend": '{"type":"test-memory","region":"example"}',
        "burrow-firestore": "invalid JSON must not be read",
      },
      { backend: { type: "unknown" } },
    );
    expect(factory).not.toHaveBeenCalled();
    expect(await defaultBackend()).toBeInstanceOf(MemoryBackend);
    expect(factory).toHaveBeenCalledExactlyOnceWith({
      type: "test-memory",
      region: "example",
    });
  });

  it("supports generic global config, then legacy Firestore meta and global config", async () => {
    page({}, { backend: { type: "test-memory" }, firestore: {} });
    expect(await defaultBackend()).toBeInstanceOf(MemoryBackend);
    for (const viaMeta of [true, false]) {
      const firestore = { apiKey: "publishable", projectId: "caller-project" };
      page(
        viaMeta ? { "burrow-firestore": JSON.stringify(firestore) } : {},
        viaMeta ? {} : { firestore },
      );
      expect(await defaultBackend()).toBeInstanceOf(FirestoreBackend);
    }
    page();
    expect(await defaultBackend()).toBeNull();
  });

  it.each(["{", "null", "[]", '{"type":"unknown"}', '{"type":"firestore"}'])(
    "API-1/API-3 invalid generic config %s keeps local reads and writes available",
    async (content) => {
      page(
        { "burrow-backend": content },
        {
          firestore: {
            apiKey: "must-not-fall-back",
            projectId: "other-project",
          },
        },
      );
      world = new World();
      const device = world.device();
      const env = device.env();
      env.defaultBackend = defaultBackend;
      const area = await device.open({ backend: undefined }, env);
      expect(area.inspect()).toMatchObject({
        status: "error",
        backend: "none",
      });
      await area.set({ draft: "available locally" });
      expect(await area.get("draft")).toEqual({ draft: "available locally" });
      expect(area.inspect().dirtyKeys).toBe(1);
      expect(area.status).toBe("error");
    },
  );

  it("supports caller config and gives explicit backend precedence over shorthand and page config", async () => {
    world = new World();
    const device = world.device();
    const env = device.env();
    env.defaultBackend = vi.fn(() => {
      throw new Error("must not read page");
    });
    const area = await device.open(
      { backend: { type: "test-memory" }, firestore: {} as never },
      env,
    );
    expect(area.inspect().backend).toBe("memory");
    expect(env.defaultBackend).not.toHaveBeenCalled();
    const firestore = await device.open(
      {
        app: "shorthand",
        backend: undefined,
        firestore: {
          apiKey: "emulator",
          projectId: "burrow-rules-test",
          emulator: { host: "127.0.0.1", port: 1 },
        },
      },
      env,
    );
    expect(firestore.inspect().backend).toBe("firestore");
    expect(env.defaultBackend).not.toHaveBeenCalled();
  });

  it("API-1 a rejected factory preserves the cache and never exposes its error values", async () => {
    const secret = "sensitive config value";
    registerBackend("test-rejecting", () => {
      throw new Error(secret);
    });
    world = new World();
    const device = world.device();
    const area = await device.open({ backend: { type: "test-rejecting" } });
    expect(area.status).toBe("error");
    const error = await area.syncNow().catch((e) => e);
    expect(error.code).toBe("backend");
    expect(error.message).toBe("backend configuration failed");
    expect(error.cause).toBeUndefined();
    await area.set({ saved: 1 });
    area.close();
    const reopened = await device.open({ backend: undefined });
    expect(await reopened.get()).toEqual({ saved: 1 });
    expect(reopened.status).toBe("idle");
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
    ])
      expect(() => new FirestoreBackend(config as never)).toThrow(TypeError);
  });
});
