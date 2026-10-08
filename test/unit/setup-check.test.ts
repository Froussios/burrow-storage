import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Envelope } from "../../src/types.js";

const state = vi.hoisted(() => ({
  stored: null as Envelope | null,
  denial: "permission-denied" as string | null,
  close: vi.fn(),
  forged: null as Envelope | null,
  createDenial: false,
}));
vi.mock("../../src/backends/firestore.js", () => ({
  FirestoreBackend: class {
    async put(_id: string, env: Envelope) {
      if (state.createDenial)
        throw { code: "unauthorized", message: "private-referrer-error" };
      state.stored = env;
    }
    async get() {
      return state.stored;
    }
    close = state.close;
  },
}));
vi.mock("firebase/app", () => ({
  initializeApp: () => ({}),
  deleteApp: vi.fn(),
}));
vi.mock("firebase/firestore", () => {
  const deny = async () => {
    if (state.denial)
      throw {
        code: state.denial,
        message: "private-document-id private-token",
      };
  };
  return {
    getFirestore: () => ({}),
    connectFirestoreEmulator: vi.fn(),
    setLogLevel: vi.fn(),
    doc: vi.fn(),
    collection: vi.fn(),
    documentId: vi.fn(),
    query: vi.fn(),
    where: vi.fn(),
    setDoc: async (_ref: unknown, env: Envelope) => {
      state.forged = env;
      return deny();
    },
    getDocs: deny,
  };
});
import { checkFirestore, SetupCheckError } from "../../src/setup/check.js";

beforeEach(() => {
  state.stored = null;
  state.forged = null;
  state.createDenial = false;
  state.denial = "permission-denied";
  state.close.mockClear();
});

describe("FS-10 packaged rules check", () => {
  const config = { apiKey: "test", projectId: "test", appId: "test" };
  it("reports the four checks without exposing an id, token or envelope", async () => {
    const messages: string[] = [];
    await checkFirestore(config, (line) => messages.push(line));
    expect(messages).toEqual([
      "PASS create-read",
      "PASS forged-update",
      "PASS list",
      "PASS in-query",
    ]);
    expect(state.forged?.tok).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state.forged?.rev).toBe(1);
    expect(state.close).toHaveBeenCalledOnce();
  });
  it("a blocked create cannot produce passes for the denial probes", async () => {
    state.createDenial = true;
    const messages: string[] = [];
    await expect(
      checkFirestore(config, (line) => messages.push(line)),
    ).rejects.toMatchObject({
      check: "create-read",
      code: "permission-denied",
    });
    expect(messages).toEqual([]);
    expect(state.forged).toBeNull();
  });
  it.each(["unavailable", "resource-exhausted"])(
    "does not count %s as evidence of a rules denial",
    async (denial) => {
      state.denial = denial;
      const messages: string[] = [];
      let failure: unknown;
      try {
        await checkFirestore(config, (line) => messages.push(line));
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(SetupCheckError);
      expect((failure as Error).message).not.toMatch(/private|token|document/);
      expect(messages).toEqual(["PASS create-read"]);
      expect(state.close).toHaveBeenCalledOnce();
    },
  );
  it("fails when rules allow a forged update", async () => {
    state.denial = null;
    await expect(checkFirestore(config, () => {})).rejects.toMatchObject({
      check: "forged-update",
      code: "unexpected-result",
    });
  });
});

describe("FS-10 bin guardrails before remote access", () => {
  const bin = fileURLToPath(
    new URL("../../scripts/burrow-setup.mjs", import.meta.url),
  );
  const run = (args: string[], env = process.env) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [bin, ...args], { env });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
        child.once("error", reject);
        child.once("close", (status) => resolve({ status, stdout, stderr }));
      },
    );
  it.each([
    "invalid-private-config",
    "null",
    "[]",
    '{"apiKey":"test","projectId":"test","emulator":{}}',
    '{"apiKey":"test","projectId":"test","appId":""}',
  ])(
    "refuses unsafe or malformed config without echoing it",
    async (config) => {
      const result = await run(["check", config]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Supply your own config JSON");
      expect(result.stderr).not.toContain(config);
    },
  );
  it("refuses a live check in CI", async () => {
    const result = await run(
      ["check", '{"apiKey":"test","projectId":"test","appId":"test"}'],
      { ...process.env, CI: "1" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must not run in CI");
  });
  it("prints the human guide and shipped agent path", async () => {
    const result = await run(["firestore"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SETUP-AGENT.md");
    expect(result.stdout).not.toContain("--run");
  });
  it("rejects the removed provisioning flag", async () => {
    const result = await run(["firestore", "--run"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("was removed");
  });
});
