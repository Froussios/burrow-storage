import { initializeApp } from "firebase/app";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("firebase/app", () => ({
  initializeApp: vi.fn(() => {
    throw new Error(
      "The live suite must not initialize Firebase without a target",
    );
  }),
  deleteApp: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it.each([
  undefined,
  "",
  " ",
  "not JSON",
  '{"projectId":',
  "null",
  "[]",
  "true",
  "{}",
  '{"apiKey":"key","projectId":" "}',
  '{"apiKey":"key","projectId":"own","appId":123}',
  '{"apiKey":"key","projectId":"own","appId":" "}',
  '{"apiKey":"key","projectId":"own","emulator":{"host":"localhost","port":8080}}',
])(
  "#43 the live suite rejects BURROW_FIRESTORE=%s before initializing Firebase",
  async (config) => {
    vi.resetModules();
    vi.stubEnv("BURROW_FIRESTORE", config);

    // Validate at module scope before registering tests or starting Firebase.
    const load = import("../conformance/live.test.js");
    await expect(load).rejects.toThrow("BURROW_FIRESTORE environment variable");
    await expect(load).rejects.toThrow("docs/firestore-setup.md");
    expect(initializeApp).not.toHaveBeenCalled();
  },
);

it.each([undefined, "optional-app-id"])(
  "#23 the live config accepts appId=%s before SDK initialization",
  async (appId) => {
    vi.resetModules();
    const config = {
      apiKey: "publishable",
      projectId: "caller-owned",
      ...(appId === undefined ? {} : { appId }),
    };
    vi.stubEnv("BURROW_FIRESTORE", JSON.stringify(config));
    vi.mocked(initializeApp).mockImplementationOnce(() => {
      throw new Error("SDK initialization stub");
    });
    await expect(import("../conformance/live.test.js")).rejects.toThrow(
      "SDK initialization stub",
    );
    expect(initializeApp).toHaveBeenCalledExactlyOnceWith(config, "gate2-raw");
  },
);
