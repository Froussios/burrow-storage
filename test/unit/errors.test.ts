// API-13 / BE-4 / SEC-8: error codes, and nothing secret in an error's message
// or cause.
import { describe, expect, it } from "vitest";
import { b64url, hex, randomBytes } from "../../src/bytes.js";
import {
  BackendError,
  type BackendErrorCode,
  BurrowError,
  type BurrowErrorCode,
  fromBackend,
  scrub,
  scrubText,
} from "../../src/errors.js";

const ID = b64url(randomBytes(32)).slice(0, 43); // a document id or token shape
const HEX = hex(randomBytes(32)); // a commitment (next) shape
const ID_RE = /[A-Za-z0-9_-]{40,}/;

const BURROW_CODES: BurrowErrorCode[] = [
  "unlinked",
  "cancelled",
  "prf-unsupported",
  "bad-token",
  "item-too-large",
  "backend",
  "conflict",
  "expired",
  "quota",
  "decrypt-failed",
  "would-orphan",
];
const BACKEND_CODES: BackendErrorCode[] = [
  "conflict",
  "expired",
  "unauthorized",
  "too-large",
  "quota",
  "network",
];

describe("SEC-8 scrub()", () => {
  it("keeps only name, message and a string code from an Error cause", () => {
    const original = Object.assign(
      new TypeError(`write to burrow/${ID} failed`),
      {
        code: "permission-denied",
        id: ID,
        path: `projects/p/databases/(default)/documents/burrow/${ID}`,
        customData: { doc: ID, next: HEX },
      },
    );
    (original as Error).cause = new Error(ID);
    const s = scrub(original) as Error & { code?: string };
    expect(s).toBeInstanceOf(Error);
    expect(s).not.toBe(original);
    expect(s.name).toBe("TypeError");
    expect(s.message).toBe("write to burrow/[redacted] failed");
    expect(s.code).toBe("permission-denied");
    expect(s.cause).toBeUndefined();
    expect(Object.keys(s).sort()).toEqual(["code", "name"]);
    expect(
      Object.getOwnPropertyNames(s).every((p) =>
        ["stack", "message", "name", "code"].includes(p),
      ),
    ).toBe(true);
    expect(JSON.stringify(s)).not.toContain(ID);
    expect(s.stack ?? "").not.toContain(ID);
  });

  it("drops a non-string code", () => {
    const s = scrub(Object.assign(new Error("x"), { code: 42 })) as Error & {
      code?: unknown;
    };
    expect("code" in s).toBe(false);
  });

  it("redacts 43-char base64url ids and 64-char hex strings in messages", () => {
    expect(scrubText(`doc ${ID} rev 3`)).toBe("doc [redacted] rev 3");
    expect(scrubText(`next=${HEX}.`)).toBe("next=[redacted].");
    expect(scrubText(`a/${ID}/b ${HEX}`)).toBe("a/[redacted]/b [redacted]");
    expect((scrub(new Error(`hash ${HEX}`)) as Error).message).toBe(
      "hash [redacted]",
    );
    // Ordinary words and short codes survive.
    expect(
      scrubText("permission-denied: Missing or insufficient permissions."),
    ).toBe("permission-denied: Missing or insufficient permissions.");
  });

  it("scrubs a string cause and drops any other non-Error value", () => {
    expect(scrub(`failed at ${ID}`)).toBe("failed at [redacted]");
    for (const v of [{ id: ID }, [ID], 42, null, undefined, Symbol("s")])
      expect(scrub(v)).toBeUndefined();
  });

  it("passes a BurrowError through unchanged (its cause was scrubbed already)", () => {
    const e = new BurrowError("backend");
    expect(scrub(e)).toBe(e);
  });

  it("rebuilds a BackendError with its code, a redacted message and a scrubbed cause (#32)", () => {
    class AdapterError extends BackendError {
      readonly doc = ID;
    }
    const original = new AdapterError("unauthorized", `write to ${ID} denied`);
    Object.defineProperty(original, "cause", {
      value: new Error(`rules rejected ${HEX}`),
    });
    const s = scrub(original) as BackendError;
    expect(s).toBeInstanceOf(BackendError);
    expect(s).not.toBe(original);
    expect(s).toMatchObject({
      name: "BackendError",
      code: "unauthorized",
      message: "write to [redacted] denied",
    });
    expect((s.cause as Error).message).toBe("rules rejected [redacted]");
    expect("doc" in s).toBe(false);
    expect(Object.keys(s).sort()).toEqual(["code", "name"]);
    expect(s.stack ?? "").not.toMatch(ID_RE);
    expect(String(s)).not.toMatch(ID_RE);

    // A message with nothing to redact, and no cause, survives as is.
    const plain = scrub(new BackendError("network")) as BackendError;
    expect(plain).toMatchObject({ code: "network", message: "network" });
    expect("cause" in plain).toBe(false);
  });

  it("stops at a BackendError cause chain that loops back on itself", () => {
    const loop = new BackendError("network", `at ${ID}`);
    Object.defineProperty(loop, "cause", { value: loop });
    let s = scrub(loop) as BackendError | undefined;
    let n = 0;
    for (; s; s = s.cause as BackendError | undefined, n++)
      expect(s.message).toBe("at [redacted]");
    expect(n).toBeGreaterThan(1);
    expect(n).toBeLessThan(20);
  });

  it("BurrowError and fromBackend scrub a BackendError cause whose message holds an id (#32)", () => {
    const leaky = new BackendError("network", `get ${ID} timed out`);
    for (const e of [
      new BurrowError("backend", undefined, { cause: leaky }),
      fromBackend(leaky),
    ]) {
      expect(e.cause).toBeInstanceOf(BackendError);
      expect((e.cause as BackendError).message).toBe(
        "get [redacted] timed out",
      );
      expect((e.cause as BackendError).code).toBe("network");
    }
  });
});

describe("API-13/BE-4 BurrowError and BackendError", () => {
  it("every code constructs with name, code and a message that is the code", () => {
    for (const code of BURROW_CODES) {
      const e = new BurrowError(code);
      expect(e).toBeInstanceOf(Error);
      expect(e).toMatchObject({ name: "BurrowError", code, message: code });
    }
    for (const code of BACKEND_CODES)
      expect(new BackendError(code)).toMatchObject({
        name: "BackendError",
        code,
        message: code,
      });
  });

  it("SEC-8 a cause holding an id never puts it in the error, its cause or its JSON", () => {
    const leaky = Object.assign(
      new Error(`document burrow/${ID} next ${HEX}`),
      { id: ID },
    );
    for (const e of [
      new BurrowError("backend", undefined, { cause: leaky }),
      new BackendError("network", undefined, { cause: leaky }),
    ]) {
      expect(e.message).not.toMatch(ID_RE);
      const cause = e.cause as Error;
      expect(cause).not.toBe(leaky);
      expect(cause.message).not.toMatch(ID_RE);
      expect(
        JSON.stringify({
          message: e.message,
          cause: { ...cause, message: cause.message },
        }),
      ).not.toMatch(ID_RE);
      expect(String(e)).not.toMatch(ID_RE);
    }
    expect(
      new BurrowError("backend", undefined, { cause: `at ${ID}` }).cause,
    ).toBe("at [redacted]");
  });

  it("no cause means no cause property", () => {
    expect("cause" in new BurrowError("conflict")).toBe(false);
    expect("cause" in new BackendError("conflict")).toBe(false);
  });

  it("fromBackend maps adapter codes onto the public enum without leaking ids", () => {
    const leaky = new Error(`get ${ID} failed`);
    const map: Record<BackendErrorCode, BurrowErrorCode> = {
      conflict: "conflict",
      expired: "expired",
      quota: "quota",
      "too-large": "item-too-large",
      unauthorized: "backend",
      network: "backend",
    };
    for (const code of BACKEND_CODES) {
      const e = fromBackend(
        new BackendError(code, undefined, { cause: leaky }),
      );
      expect(e).toMatchObject({
        name: "BurrowError",
        code: map[code],
        message: map[code],
      });
      expect((e.cause as BackendError).code).toBe(code);
      expect(((e.cause as BackendError).cause as Error).message).toBe(
        "get [redacted] failed",
      );
    }
    const same = new BurrowError("decrypt-failed");
    expect(fromBackend(same)).toBe(same);
    const other = fromBackend(leaky);
    expect(other.code).toBe("backend");
    expect((other.cause as Error).message).not.toMatch(ID_RE);
  });
});
