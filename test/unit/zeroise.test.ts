import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveAppKeys, deriveSlotKeys } from "../../src/codec/derive.js";
import { SecretHolder } from "../../src/secret.js";

// SEC-1: Uint8Array copies of key material are zeroised once imported into a
// CryptoKey. Each test records every raw buffer handed to importKey and checks
// it reads all zeros after the call, while the caller's own buffer is left
// alone.
function recordImports(): Uint8Array[] {
  const seen: Uint8Array[] = [];
  const real = crypto.subtle.importKey.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "importKey").mockImplementation(((
    format: KeyFormat,
    data: BufferSource,
    ...rest: unknown[]
  ) => {
    if (format === "raw" && data instanceof Uint8Array) seen.push(data);
    return (real as (...a: unknown[]) => Promise<CryptoKey>)(
      format,
      data,
      ...rest,
    );
  }) as typeof crypto.subtle.importKey);
  return seen;
}

const secret = () => Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const allZero = (b: Uint8Array) => b.every((x) => x === 0);

describe("SEC-1 key material copies are zeroised after import", () => {
  afterEach(() => vi.restoreAllMocks());

  it("SEC-1 deriveAppKeys zeroises its copy of the root secret and the path bits", async () => {
    const seen = recordImports();
    const input = secret();
    await deriveAppKeys(input, "app");
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const b of seen) expect(allZero(b)).toBe(true);
    expect(input).toEqual(secret());
  });

  it("SEC-1 deriveSlotKeys zeroises its copy of the PRF output", async () => {
    const seen = recordImports();
    const input = secret();
    await deriveSlotKeys(input);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    for (const b of seen) expect(allZero(b)).toBe(true);
    expect(input).toEqual(secret());
  });

  it("SEC-1 SecretHolder.wrap zeroises its copy of the root secret", async () => {
    const seen = recordImports();
    const input = secret();
    const holder = await SecretHolder.wrap(input);
    expect(seen.length).toBe(1);
    expect(allZero(seen[0]!)).toBe(true);
    expect(input).toEqual(secret());
    expect(await holder.use(async (s) => Array.from(s))).toEqual(
      Array.from(secret()),
    );
  });
});
