import fc from "fast-check";
import { describe, expect, it } from "vitest";
import vectors from "../vectors.json" with { type: "json" };
import { b64url, fromB64url, hex, sha256, utf8 } from "../../src/bytes.js";
import {
  commitment,
  deriveAppKeys,
  deriveSlotKeys,
  docId,
  passphraseSecret,
  token,
} from "../../src/codec/derive.js";
import {
  HARD_MAX_PLAINTEXT,
  assertJson,
  open,
  seal,
} from "../../src/codec/envelope.js";
import {
  CODE_VERSION_PASSPHRASE,
  CODE_VERSION_RANDOM,
  decodeSyncCode,
  encodeSyncCode,
  normaliseCode,
} from "../../src/codec/synccode.js";
import { BurrowError } from "../../src/errors.js";
import type { Envelope } from "../../src/types.js";

const fromHex = (h: string) =>
  Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const root = fromHex(vectors.rootSecretHex);

describe("ENC-1/ENC-2 derivation matches the committed vectors", () => {
  it("base and docId", async () => {
    const k = await deriveAppKeys(root, vectors.app);
    expect(k.base).toBe(vectors.base);
    expect(await docId(k, "theme")).toBe(vectors.docId.theme);
    expect(await docId(k, "draft")).toBe(vectors.docId.draft);
    expect(await docId(k, "")).toBe(vectors.docId[""]);
  });

  it("ENC-7 tok and next", async () => {
    const k = await deriveAppKeys(root, vectors.app);
    expect(await token(k.macKey, k.base, 0)).toBe(vectors.tok.base0);
    expect(await token(k.macKey, k.base, 1)).toBe(vectors.tok.base1);
    expect(await token(k.macKey, vectors.docId.theme, 7)).toBe(
      vectors.tok.theme7,
    );
    expect(await commitment(k.macKey, k.base, 0)).toBe(vectors.next.base0);
    expect(await commitment(k.macKey, vectors.docId.theme, 7)).toBe(
      vectors.next.theme7,
    );
    // The commitment is what the Firestore rule recomputes with
    // hashing.sha256(tok).
    expect(hex(await sha256(utf8(vectors.tok.base1)))).toBe(vectors.next.base0);
  });

  it("ENC-1 docId for a unicode key and the empty key", async () => {
    const k = await deriveAppKeys(root, vectors.app);
    expect(await docId(k, vectors.unicodeKey)).toBe(
      vectors.docId[vectors.unicodeKey as keyof typeof vectors.docId],
    );
    // No normalisation: the decomposed spelling of the same Greek text is a
    // different key.
    expect(await docId(k, vectors.unicodeKey.normalize("NFD"))).not.toBe(
      vectors.docId[vectors.unicodeKey as keyof typeof vectors.docId],
    );
  });

  it("ENC-1/ENC-2 a second root secret", async () => {
    const r2 = vectors.root2;
    const k = await deriveAppKeys(fromHex(r2.rootSecretHex), vectors.app);
    expect(k.base).toBe(r2.base);
    expect(await docId(k, "theme")).toBe(r2.docId.theme);
    expect(await docId(k, vectors.unicodeKey)).toBe(
      r2.docId[vectors.unicodeKey as keyof typeof r2.docId],
    );
    expect(await docId(k, "")).toBe(r2.docId[""]);
    for (const { n, tok, next } of r2.chain) {
      expect(await token(k.macKey, r2.docId.theme, n)).toBe(tok);
      expect(await commitment(k.macKey, r2.docId.theme, n)).toBe(next);
    }
    expect(await encodeSyncCode(fromHex(r2.rootSecretHex))).toBe(r2.syncCode);
    expect(hex((await decodeSyncCode(r2.syncCode)).secret)).toBe(
      r2.rootSecretHex,
    );
  });

  it("ENC-7 write tokens n = 0..5 chain: next(n) = sha256(tok(n+1))", async () => {
    const k = await deriveAppKeys(root, vectors.app);
    expect(vectors.chain.map((s) => s.n)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const { n, tok, next } of vectors.chain) {
      expect(await token(k.macKey, k.base, n)).toBe(tok);
      expect(await commitment(k.macKey, k.base, n)).toBe(next);
    }
    for (let n = 0; n < vectors.chain.length - 1; n++)
      expect(hex(await sha256(utf8(vectors.chain[n + 1]!.tok)))).toBe(
        vectors.chain[n]!.next,
      );
  });

  it("slot keys", async () => {
    const s = await deriveSlotKeys(fromHex(vectors.slot.prfHex));
    expect(s.slotId).toBe(vectors.slot.slotId);
    expect(await token(s.slotMac, s.slotId, 0)).toBe(vectors.slot.tok0);
  });

  it("ENC-1 ids are 43 chars and unique per app, key and secret", async () => {
    const a = await deriveAppKeys(root, vectors.app);
    const b = await deriveAppKeys(root, vectors.otherApp.app);
    const other = await deriveAppKeys(new Uint8Array(32).fill(9), vectors.app);
    expect(b.base).toBe(vectors.otherApp.base);
    const ids = [
      a.base,
      b.base,
      other.base,
      await docId(a, "x"),
      await docId(b, "x"),
      await docId(other, "x"),
      await docId(a, "y"),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("SEC-2 derived keys are non-extractable", async () => {
    const k = await deriveAppKeys(root, vectors.app);
    for (const key of [k.pathKey, k.encKey, k.macKey])
      expect(key.extractable).toBe(false);
  });
});

describe("ENC-4/ENC-5 envelope", () => {
  const cipher = async (aad: string) => {
    const k = await deriveAppKeys(root, vectors.app);
    return { key: k.encKey, mac: k.macKey, aad };
  };
  const pt = (s: string) => utf8(s);

  it("round trips and chains tok/next", async () => {
    const c = await cipher(vectors.base + vectors.app);
    const env = await seal(c, vectors.base, 0, pt('{"a":1}'), 1234.9);
    expect(env).toMatchObject({
      v: 1,
      rev: 0,
      ts: 1234,
      tok: vectors.tok.base0,
      next: vectors.next.base0,
    });
    expect(env.iv).toHaveLength(16);
    expect(new TextDecoder().decode(await open(c, env))).toBe('{"a":1}');
  });

  it("ENC-5 opens the committed envelope vector (sealed by node:crypto with a fixed iv)", async () => {
    const id = vectors.docId.theme;
    const c = await cipher(id + vectors.app);
    const env = vectors.envelope.env as Envelope;
    expect(new TextDecoder().decode(await open(c, env))).toBe(
      vectors.envelope.plaintext,
    );
    expect(JSON.parse(vectors.envelope.plaintext)).toMatchObject({
      v: 1,
      key: vectors.envelope.key,
    });
    expect(env.tok).toBe(await token(c.mac, id, env.rev));
    expect(env.next).toBe(await commitment(c.mac, id, env.rev));
  });

  it("ENC-5/ENC-6 the envelope vector with a changed rev, id or app does not open", async () => {
    const id = vectors.docId.theme;
    const c = await cipher(id + vectors.app);
    const env = vectors.envelope.env as Envelope;
    for (const rev of [env.rev - 1, env.rev + 1, 0])
      await expect(open(c, { ...env, rev })).rejects.toMatchObject({
        name: "BurrowError",
        code: "decrypt-failed",
      });
    await expect(
      open({ ...c, aad: vectors.docId.draft + vectors.app }, env),
    ).rejects.toMatchObject({ code: "decrypt-failed" });
    await expect(
      open({ ...c, aad: id + vectors.otherApp.app }, env),
    ).rejects.toMatchObject({ code: "decrypt-failed" });
  });

  it("ENC-5 fresh IV per write", async () => {
    const c = await cipher("x");
    const a = await seal(c, vectors.base, 0, pt("same"), 1);
    const b = await seal(c, vectors.base, 0, pt("same"), 1);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it("ENC-5 binds id, app and rev: replay to another id or rev fails", async () => {
    const c = await cipher(vectors.base + vectors.app);
    const env = await seal(c, vectors.base, 3, pt("hello"), 1);
    await expect(
      open({ ...c, aad: vectors.docId.theme + vectors.app }, env),
    ).rejects.toMatchObject({ code: "decrypt-failed" });
    await expect(
      open({ ...c, aad: vectors.base + "other" }, env),
    ).rejects.toMatchObject({ code: "decrypt-failed" });
    await expect(open(c, { ...env, rev: 2 })).rejects.toMatchObject({
      code: "decrypt-failed",
    });
  });

  it("ENC-6 tampering and wrong keys are decrypt-failed", async () => {
    const c = await cipher("x");
    const env = await seal(c, vectors.base, 0, pt("hello"), 1);
    const ct = fromB64url(env.ct);
    ct[0]! ^= 1;
    await expect(open(c, { ...env, ct: b64url(ct) })).rejects.toBeInstanceOf(
      BurrowError,
    );
    const wrong = await deriveAppKeys(new Uint8Array(32), vectors.app);
    await expect(open({ ...c, key: wrong.encKey }, env)).rejects.toMatchObject({
      code: "decrypt-failed",
    });
  });

  it("ENC-4 compresses when it helps and marks z", async () => {
    const c = await cipher("x");
    const big = pt(JSON.stringify({ text: "a".repeat(10_000) }));
    const env = await seal(c, vectors.base, 0, big, 1);
    expect(env.z).toBe(true);
    expect(env.ct.length).toBeLessThan(1000);
    expect(new TextDecoder().decode(await open(c, env))).toBe(
      new TextDecoder().decode(big),
    );
    const small = await seal(c, vectors.base, 0, pt("{}"), 1);
    expect(small.z).toBeUndefined();
  });

  it("ENC-4 the hard plaintext ceiling always fits the rules' ct cap", async () => {
    const c = await cipher("x");
    const noise = (n: number) => {
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i += 65536)
        crypto.getRandomValues(b.subarray(i, i + 65536));
      return b;
    };
    const env = await seal(c, vectors.base, 0, noise(HARD_MAX_PLAINTEXT), 1);
    expect(env.ct.length).toBeLessThanOrEqual(1_000_000);
    await expect(
      seal(c, vectors.base, 0, noise(760_000), 1),
    ).rejects.toMatchObject({ code: "item-too-large" });
  });
});

describe("API-4 JSON values only", () => {
  it("accepts JSON", () => {
    for (const v of [
      null,
      1,
      "s",
      true,
      [1, [2]],
      { a: { b: [null] } },
      Object.create(null),
    ])
      expect(() => assertJson(v)).not.toThrow();
  });
  it("rejects what JSON.stringify would silently change", () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    for (const v of [
      undefined,
      () => 1,
      new Date(),
      new Map(),
      NaN,
      Infinity,
      { a: undefined },
      [undefined],
      cyc,
      new (class X {})(),
      1n,
      Symbol("s"),
    ])
      expect(() => assertJson(v)).toThrow(TypeError);
  });
  it("rejects Set and typed arrays, naming the key but never the value", () => {
    const secret = "hunter2-do-not-log";
    for (const v of [
      new Set([secret]),
      new Uint8Array(1),
      new Float64Array([1.5]),
      new ArrayBuffer(4),
    ]) {
      expect(() => assertJson(v, "prefs")).toThrow(TypeError);
      for (const nested of [{ inner: v }, [v]]) {
        let msg = "";
        try {
          assertJson(nested, "prefs");
        } catch (e) {
          msg = (e as Error).message;
        }
        expect(msg).toMatch(/^prefs(\.inner|\[0\]) is not a JSON value$/);
      }
    }
    let msg = "";
    try {
      assertJson({ ok: 1, list: [1, { s: new Set([secret]) }] }, "settings");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toBe("settings.list[1].s is not a JSON value");
    expect(msg).not.toContain(secret);
    try {
      assertJson({ when: new Date(0), label: secret }, "k");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toContain(secret);
    expect(msg).not.toContain("1970");
  });
});

describe("KP-11/KP-12 sync code", () => {
  it("matches the committed vector and round trips", async () => {
    const code = await encodeSyncCode(root);
    expect(code).toBe(vectors.syncCode);
    expect(normaliseCode(code)).toHaveLength(56);
    expect(code.split("-").every((g) => g.length === 4)).toBe(true);
    expect(hex((await decodeSyncCode(code)).secret)).toBe(
      vectors.rootSecretHex,
    );
  });

  it("decoding ignores case, hyphens, spaces and O/0, I/L/1 confusions", async () => {
    const messy = vectors.syncCode
      .toLowerCase()
      .replace(/0/g, "o")
      .replace(/1/g, "l")
      .replace(/-/g, "  ");
    expect(hex((await decodeSyncCode(messy)).secret)).toBe(
      vectors.rootSecretHex,
    );
  });

  it("rejects a wrong checksum, length or character with bad-code", async () => {
    const flip = vectors.syncCode.replace(/^./, (c) => (c === "0" ? "1" : "0"));
    for (const bad of [
      flip,
      vectors.syncCode.slice(0, -1),
      vectors.syncCode.replace(/.$/, "U"),
      "",
    ])
      await expect(decodeSyncCode(bad)).rejects.toMatchObject({
        code: "bad-code",
      });
  });

  it("KP-11 property: encode/decode round trips any 32-byte secret", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.constantFrom(CODE_VERSION_RANDOM, CODE_VERSION_PASSPHRASE),
        async (secret, version) => {
          const code = await encodeSyncCode(secret, version);
          expect(code).toMatch(
            /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){13}$/,
          );
          const out = await decodeSyncCode(code);
          expect(out.version).toBe(version);
          expect([...out.secret]).toEqual([...secret]);
          // Messy input of the same code decodes too.
          expect([
            ...(await decodeSyncCode(code.toLowerCase().replace(/-/g, " ")))
              .secret,
          ]).toEqual([...secret]);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("KP-12 an unknown version byte with a valid checksum is bad-code", async () => {
    // Build the 35 bytes by hand: version || secret || sha256(version ||
    // secret)[0:2], base32.
    const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const encode = async (version: number) => {
      const body = new Uint8Array([version, ...root]);
      const sum = new Uint8Array(
        await crypto.subtle.digest("SHA-256", body),
      ).subarray(0, 2);
      let bits = "";
      for (const b of [...body, ...sum]) bits += b.toString(2).padStart(8, "0");
      let out = "";
      for (let i = 0; i < bits.length; i += 5)
        out += A[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
      return out.match(/.{4}/g)!.join("-");
    };
    // the hand encoder is right
    expect(await encode(CODE_VERSION_RANDOM)).toBe(vectors.syncCode);
    expect(
      (await decodeSyncCode(await encode(CODE_VERSION_PASSPHRASE))).version,
    ).toBe(CODE_VERSION_PASSPHRASE);
    for (const v of [0x00, 0x03, 0x7f, 0xff])
      await expect(decodeSyncCode(await encode(v))).rejects.toMatchObject({
        name: "BurrowError",
        code: "bad-code",
      });
  });

  it("KP-12 I and i decode as 1", async () => {
    expect(vectors.syncCode).toContain("1");
    let n = 0;
    const withI = vectors.syncCode.replace(/1/g, () => (n++ % 2 ? "I" : "i"));
    expect(withI).not.toContain("1");
    expect(normaliseCode(withI)).toBe(normaliseCode(vectors.syncCode));
    expect(hex((await decodeSyncCode(withI)).secret)).toBe(
      vectors.rootSecretHex,
    );
  });

  it("KP-12 a token with every hyphen removed decodes", async () => {
    const bare = vectors.syncCode.replace(/-/g, "");
    expect(bare).toHaveLength(56);
    expect(hex((await decodeSyncCode(bare)).secret)).toBe(
      vectors.rootSecretHex,
    );
    expect(hex((await decodeSyncCode(bare.toLowerCase())).secret)).toBe(
      vectors.rootSecretHex,
    );
  });

  it("detects any single-character typo", async () => {
    const s = normaliseCode(vectors.syncCode);
    let caught = 0;
    for (let i = 2; i < s.length; i += 3) {
      const typo = s.slice(0, i) + (s[i] === "Z" ? "Y" : "Z") + s.slice(i + 1);
      await decodeSyncCode(typo).catch(() => caught++);
    }
    expect(caught).toBe(Math.ceil((s.length - 2) / 3));
  });
});

describe("ENC-3 passphrase KDF", () => {
  it("refuses fewer than 600,000 iterations", async () => {
    await expect(passphraseSecret("pw", "salt", 1000)).rejects.toThrow(
      RangeError,
    );
  });
});
