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

it.each([undefined, ""])(
  "#43 the live suite rejects BURROW_FIRESTORE=%s before initializing Firebase",
  async (config) => {
    vi.resetModules();
    vi.stubEnv("BURROW_FIRESTORE", config);

    const load = import("../conformance/live.test.js");
    await expect(load).rejects.toThrow("BURROW_FIRESTORE");
    await expect(load).rejects.toThrow("docs/firestore-setup.md");
    expect(initializeApp).not.toHaveBeenCalled();
  },
);
