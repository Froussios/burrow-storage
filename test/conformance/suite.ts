// Backend conformance suite (BE-1..BE-7, ENC-7/8). Every adapter MUST pass it unchanged.
import { describe, expect, it } from "vitest";
import { b64url, randomBytes, utf8 } from "../../src/bytes.js";
import { deriveAppKeys } from "../../src/codec/derive.js";
import { type DocCipher, seal } from "../../src/codec/envelope.js";
import { BackendError } from "../../src/errors.js";
import type { Backend, Envelope } from "../../src/types.js";

const CODES = ["conflict", "unauthorized", "too-large", "quota", "network"];
const newId = () => b64url(randomBytes(32));

async function chain(): Promise<{ id: string; env: (rev: number, body?: string) => Promise<Envelope> }> {
  const keys = await deriveAppKeys(randomBytes(32), "conformance");
  const id = newId();
  const c: DocCipher = { key: keys.encKey, mac: keys.macKey, aad: id + "conformance" };
  return { id, env: (rev, body = `rev ${rev}`) => seal(c, id, rev, utf8(body), Date.now()) };
}

async function rejectCode(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) {
    expect(e).toBeInstanceOf(BackendError);
    expect(CODES).toContain((e as BackendError).code);
    return (e as BackendError).code;
  }
  throw new Error("expected rejection");
}

export function backendConformance(name: string, make: () => Backend | Promise<Backend>): void {
  describe(`backend conformance: ${name}`, () => {
    it("declares capabilities, including writeAuth (ENC-9)", async () => {
      const b = await make();
      expect(typeof b.id).toBe("string");
      expect(b.capabilities).toMatchObject({ writeAuth: true });
      expect(typeof b.capabilities.subscribe).toBe("boolean");
      expect(typeof b.capabilities.keepalive).toBe("boolean");
      expect(b.capabilities.maxEnvelopeBytes).toBeGreaterThan(0);
    });

    it("get of an unknown id is null", async () => {
      expect(await (await make()).get(newId())).toBeNull();
    });

    it("create at rev 0, then get returns the same envelope", async () => {
      const b = await make(); const c = await chain();
      const e0 = await c.env(0);
      await b.put(c.id, e0, null);
      expect(await b.get(c.id)).toEqual(e0);
    });

    it("create over an existing document is conflict", async () => {
      const b = await make(); const c = await chain();
      await b.put(c.id, await c.env(0), null);
      expect(await rejectCode(b.put(c.id, await c.env(0), null))).toBe("conflict");
    });

    it("create at rev != 0 is rejected", async () => {
      const b = await make(); const c = await chain();
      await rejectCode(b.put(c.id, await c.env(1), null));
      expect(await b.get(c.id)).toBeNull();
    });

    it("ENC-7 chained updates with the committed token succeed", async () => {
      const b = await make(); const c = await chain();
      await b.put(c.id, await c.env(0), null);
      await b.put(c.id, await c.env(1), 0);
      const e2 = await c.env(2, "two");
      await b.put(c.id, e2, 1);
      expect(await b.get(c.id)).toEqual(e2);
    });

    it("ENC-7 update with a token from another chain is unauthorized", async () => {
      const b = await make(); const c = await chain(); const other = await chain();
      await b.put(c.id, await c.env(0), null);
      const forged = { ...(await c.env(1)), tok: (await other.env(1)).tok };
      expect(await rejectCode(b.put(c.id, forged, 0))).toBe("unauthorized");
      expect((await b.get(c.id))!.rev).toBe(0);
    });

    it("ENC-8 stale expectedRev is conflict", async () => {
      const b = await make(); const c = await chain();
      await b.put(c.id, await c.env(0), null);
      await b.put(c.id, await c.env(1), 0);
      expect(await rejectCode(b.put(c.id, await c.env(1), 0))).toBe("conflict");
    });

    it("skipping a revision is rejected", async () => {
      const b = await make(); const c = await chain();
      await b.put(c.id, await c.env(0), null);
      await rejectCode(b.put(c.id, await c.env(2), 0));
      expect((await b.get(c.id))!.rev).toBe(0);
    });

    it("replaying an older revision is rejected", async () => {
      const b = await make(); const c = await chain();
      await b.put(c.id, await c.env(0), null);
      const e1 = await c.env(1);
      await b.put(c.id, e1, 0);
      await b.put(c.id, await c.env(2), 1);
      await rejectCode(b.put(c.id, e1, 0));
      await rejectCode(b.put(c.id, e1, 1));
      expect((await b.get(c.id))!.rev).toBe(2);
    });

    it("BE-1 concurrent writers at the same rev: exactly one wins, the other is conflict", async () => {
      const b = await make(); const c = await chain();
      await b.put(c.id, await c.env(0), null);
      const [x, y] = await Promise.allSettled([b.put(c.id, await c.env(1, "x"), 0), b.put(c.id, await c.env(1, "y"), 0)]);
      const ok = [x, y].filter((r) => r.status === "fulfilled");
      const bad = [x, y].filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(ok).toHaveLength(1);
      expect(bad.map((r) => (r.reason as BackendError).code)).toEqual(["conflict"]);
    });

    it("BE-1 concurrent creates: exactly one wins", async () => {
      const b = await make(); const c = await chain();
      const rs = await Promise.allSettled([b.put(c.id, await c.env(0, "x"), null), b.put(c.id, await c.env(0, "y"), null)]);
      expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(rs.filter((r) => r.status === "rejected").map((r) => ((r as PromiseRejectedResult).reason as BackendError).code)).toEqual(["conflict"]);
    });

    it("FS-2 envelopes with extra fields are rejected", async () => {
      const b = await make(); const c = await chain();
      await rejectCode(b.put(c.id, { ...(await c.env(0)), owner: "me" } as Envelope, null));
      expect(await b.get(c.id)).toBeNull();
    });

    it("ids that are not 43 characters are rejected", async () => {
      const b = await make(); const c = await chain();
      await rejectCode(b.put("short-id", await c.env(0), null));
    });

    it("oversize ct is too-large", async () => {
      const b = await make(); const c = await chain();
      expect(await rejectCode(b.put(c.id, { ...(await c.env(0)), ct: "A".repeat(1_000_001) }, null))).toBe("too-large");
    });

    it("getMany, when offered, keeps order and reports missing ids as null", async () => {
      const b = await make();
      if (!b.getMany) return;
      const c = await chain(); const d = await chain();
      await b.put(c.id, await c.env(0), null);
      await b.put(d.id, await d.env(0), null);
      const got = await b.getMany([d.id, newId(), c.id]);
      expect(got.map((e) => e?.ct ?? null)).toEqual([(await b.get(d.id))!.ct, null, (await b.get(c.id))!.ct]);
    });

    it("get reflects a committed put at once, even while subscribed to that document", async () => {
      const b = await make();
      const c = await chain();
      const stop = b.capabilities.subscribe && b.subscribe ? b.subscribe(c.id, () => {}) : () => {};
      try {
        await new Promise((r) => setTimeout(r, 300));
        expect(await b.get(c.id)).toBeNull();
        await b.put(c.id, await c.env(0), null);
        expect((await b.get(c.id))?.rev).toBe(0);
        await b.put(c.id, await c.env(1), 0);
        expect((await b.get(c.id))?.rev).toBe(1);
      } finally {
        stop();
      }
    });

    it("BE-7 subscribe, when offered, delivers later writes", async () => {
      const b = await make();
      if (!b.capabilities.subscribe || !b.subscribe) return;
      const c = await chain();
      await b.put(c.id, await c.env(0), null);
      const seen: number[] = [];
      const stop = b.subscribe(c.id, (e) => seen.push(e.rev));
      await b.put(c.id, await c.env(1), 0);
      await expect.poll(() => seen.includes(1), { timeout: 10_000 }).toBe(true);
      stop();
    });
  });
}
