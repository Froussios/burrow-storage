// WP-00 REST matrix. Every function below is SELF-CONTAINED (no closures over module scope) because
// run-browser.mjs ships them into a page with Playwright's page.evaluate(fn, arg), which serialises
// the function source. They use only fetch + WebCrypto, so they run unchanged in Node 20+ and in a page.
//
// Encodings follow docs/architecture.md exactly:
//   tok(id, n) = b64u(HMAC-SHA-256(macKey, utf8(`${id}:${n}`)))       §5.4
//   nextOf(t)  = hex(SHA-256(utf8(t)))  (lowercase, over the base64url TEXT)
//   fields     = v/rev/ts integerValue (as strings), iv/ct/tok/next stringValue, z booleanValue  §9.3
//   create     = POST {coll}?documentId={id};  update = PATCH {coll}/{id}?currentDocument.exists=true

/**
 * Runs the Firestore REST + rules matrix against `docsUrl`
 * (".../v1/projects/{p}/databases/(default)/documents").
 * Each step records what the store answered and whether it matches what architecture §9.3/§9.4 assume.
 */
export async function runRestMatrix(cfg) {
  const { docsUrl, headers = {}, raceWriters = 10, redact = [], noKeyCheck = false } = cfg;
  const enc = new TextEncoder();
  const subtle = crypto.subtle;
  const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
  const b64u = (bytes) => {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const sha256 = async (s) => new Uint8Array(await subtle.digest("SHA-256", enc.encode(s)));
  const hmacKey = async () =>
    subtle.importKey("raw", rnd(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const macKey = await hmacKey();
  const otherMacKey = await hmacKey();
  const tokWith = async (key, id, n) =>
    b64u(new Uint8Array(await subtle.sign("HMAC", key, enc.encode(`${id}:${n}`))));
  const tok = (id, n) => tokWith(macKey, id, n);
  const nextOf = async (t) => hex(await sha256(t));

  const ids = [];
  const newId = () => {
    const id = b64u(rnd(32)); // 43 chars
    ids.push(id);
    return id;
  };
  const scrub = (s) => {
    if (typeof s !== "string") return s;
    for (const id of ids) s = s.split(id).join("<id>");
    for (const r of redact) if (r) s = s.split(r).join("<redacted>");
    return s.length > 300 ? s.slice(0, 300) + "…" : s;
  };

  const fieldsOf = (env) => {
    const f = {
      v: { integerValue: String(env.v) },
      iv: { stringValue: env.iv },
      ct: { stringValue: env.ct },
      rev: env.revAsDouble ? { doubleValue: env.rev } : { integerValue: String(env.rev) },
      ts: { integerValue: String(env.ts) },
      tok: { stringValue: env.tok },
      next: { stringValue: env.next },
    };
    if (env.z) f.z = { booleanValue: true };
    if (env.extra) f.extra = { stringValue: env.extra };
    return f;
  };
  const envelope = async (id, rev, over = {}) => ({
    v: 1,
    iv: b64u(rnd(12)),
    ct: b64u(rnd(48)),
    rev,
    ts: Date.now(),
    tok: await tok(id, rev),
    next: await nextOf(await tok(id, rev + 1)),
    ...over,
  });

  async function call(method, url, body, hdrs = headers) {
    try {
      const res = await fetch(url, {
        method,
        headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...hdrs },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      const err = Array.isArray(json) ? json[0]?.error : json?.error;
      return { http: res.status, status: err?.status ?? null, message: scrub(err?.message ?? null), json };
    } catch (e) {
      return { http: 0, status: null, message: scrub(String(e)), json: null };
    }
  }
  const coll = (c) => `${docsUrl}/${c}`;
  const get = (id, hdrs) => call("GET", `${coll("burrow")}/${id}`, undefined, hdrs);
  const create = (id, env) => call("POST", `${coll("burrow")}?documentId=${id}`, { fields: fieldsOf(env) });
  const update = (id, env) =>
    call("PATCH", `${coll("burrow")}/${id}?currentDocument.exists=true`, { fields: fieldsOf(env) });

  const steps = [];
  const record = (name, assumption, r, ok, extra = {}) => {
    const { json, ...rest } = r;
    steps.push({ name, assumption, ...rest, ok, ...extra });
    return r;
  };
  const is = (r, http, status) => r.http === http && (status === undefined || r.status === status);

  // --- basic lifecycle ---------------------------------------------------------------------------
  const id = newId();
  let r = await get(id);
  record("get-missing", "404 NOT_FOUND → adapter returns null", r, is(r, 404, "NOT_FOUND"));

  const e0 = await envelope(id, 0);
  r = await create(id, e0);
  record("create-rev0", "POST ?documentId at rev 0 is accepted", r, is(r, 200));

  r = await get(id);
  const f = r.json?.fields ?? {};
  const types = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, Object.keys(v)[0]]));
  const roundTrip =
    f.v?.integerValue === "1" &&
    f.rev?.integerValue === "0" &&
    f.ts?.integerValue === String(e0.ts) &&
    f.iv?.stringValue === e0.iv &&
    f.ct?.stringValue === e0.ct &&
    f.tok?.stringValue === e0.tok &&
    f.next?.stringValue === e0.next &&
    Object.keys(f).length === 7;
  record(
    "get-roundtrip",
    "GET returns exactly the written fields; integers come back as decimal strings",
    r,
    is(r, 200) && roundTrip,
    { fieldTypes: types },
  );

  r = await create(id, await envelope(id, 0));
  record(
    "create-existing",
    "§9.3 maps this to conflict: 409 ALREADY_EXISTS (403 would also classify as conflict)",
    r,
    is(r, 409) || is(r, 403),
  );

  r = await update(id, await envelope(id, 1, { z: true }));
  record(
    "update-rev1-correct-tok-with-z",
    "chained update (tok(id,1), next(tok(id,2))) is accepted",
    r,
    is(r, 200),
  );

  r = await update(id, await envelope(id, 2, { tok: await tokWith(otherMacKey, id, 2) }));
  record(
    "update-wrong-tok",
    "tok from another macKey is rejected 403 PERMISSION_DENIED",
    r,
    is(r, 403, "PERMISSION_DENIED"),
  );

  const otherId = newId();
  r = await update(id, await envelope(id, 2, { tok: await tok(otherId, 2) }));
  record("update-tok-of-other-id", "tok bound to another id is rejected", r, is(r, 403, "PERMISSION_DENIED"));

  r = await update(id, await envelope(id, 3));
  record("update-skipped-rev", "rev must be stored+1 (here +2) → 403", r, is(r, 403, "PERMISSION_DENIED"));

  r = await update(id, await envelope(id, 1));
  record(
    "update-replayed-rev",
    "re-presenting the consumed rev-1 token is rejected",
    r,
    is(r, 403, "PERMISSION_DENIED"),
  );

  r = await update(id, await envelope(id, 2, { revAsDouble: true }));
  record(
    "update-rev-as-doubleValue",
    "rev sent as doubleValue fails `rev is int` → adapter must send integerValue",
    r,
    is(r, 403, "PERMISSION_DENIED"),
  );

  r = await update(id, await envelope(id, 2, { extra: "x" }));
  record(
    "update-extra-field",
    "fields outside the envelope are rejected (FS-2)",
    r,
    is(r, 403, "PERMISSION_DENIED"),
  );

  const e2 = await envelope(id, 2);
  r = await update(id, e2);
  record("update-rev2-correct-tok-without-z", "chained update accepted", r, is(r, 200));
  r = await get(id);
  const zGone = r.json?.fields && !("z" in r.json.fields) && r.json.fields.rev?.integerValue === "2";
  record(
    "patch-replaces-document",
    "PATCH without updateMask replaces the whole document (stale `z` disappears)",
    r,
    is(r, 200) && zGone,
  );

  const missing = newId();
  r = await update(missing, await envelope(missing, 1));
  record(
    "update-missing-doc",
    "§9.3 maps PATCH ?currentDocument.exists=true on a missing doc to conflict (expects 404)",
    r,
    is(r, 404) || is(r, 403),
  );

  const fresh = newId();
  r = await create(fresh, await envelope(fresh, 1));
  record("create-at-rev1", "create must be rev 0", r, is(r, 403, "PERMISSION_DENIED"));

  // --- size cap (G3): ct of exactly 1 000 000 chars must fit in one document; 1 000 001 must not ----
  const big = newId();
  r = await create(big, await envelope(big, 0, { ct: "A".repeat(1_000_000) }));
  record(
    "create-ct-1000000",
    "a 1 000 000-char ct fits under Firestore's 1 MiB document limit and passes rules",
    r,
    is(r, 200),
  );
  const over = newId();
  r = await create(over, await envelope(over, 0, { ct: "A".repeat(1_000_001) }));
  record(
    "create-ct-1000001",
    "ct over the cap is rejected by rules (adapter pre-checks → too-large)",
    r,
    is(r, 403, "PERMISSION_DENIED") || is(r, 400),
  );

  // --- enumeration and delete (FS-4, FS-5, FS-6) ------------------------------------------------------
  r = await call("GET", coll("burrow"));
  record("list-collection", "list is denied", r, is(r, 403, "PERMISSION_DENIED"));

  const name = (d) => `${docsUrl.replace(/^https?:\/\/[^/]+\/v1\//, "")}/burrow/${d}`;
  r = await call("POST", `${docsUrl}:runQuery`, {
    structuredQuery: {
      from: [{ collectionId: "burrow" }],
      where: {
        fieldFilter: {
          field: { fieldPath: "__name__" },
          op: "IN",
          value: { arrayValue: { values: [{ referenceValue: name(id) }, { referenceValue: name(big) }] } },
        },
      },
    },
  });
  record(
    "query-in-documentId",
    "an `in` query on document ids needs list → denied",
    r,
    is(r, 403, "PERMISSION_DENIED"),
  );

  r = await call("DELETE", `${coll("burrow")}/${id}`);
  record("delete", "delete is denied", r, is(r, 403, "PERMISSION_DENIED"));

  // --- D3 / BE-1: N concurrent blind PATCHes at the same rev, all with the correct token ------------
  const raceId = newId();
  await create(raceId, await envelope(raceId, 0));
  const contenders = await Promise.all(Array.from({ length: raceWriters }, () => envelope(raceId, 1)));
  const results = await Promise.all(contenders.map((e) => update(raceId, e)));
  const winners = results.map((x, i) => (x.http === 200 ? i : -1)).filter((i) => i >= 0);
  const after = await get(raceId);
  const storedCt = after.json?.fields?.ct?.stringValue;
  const loserCodes = [...new Set(results.filter((x) => x.http !== 200).map((x) => `${x.http} ${x.status}`))];
  steps.push({
    name: "race-concurrent-patch",
    assumption: `${raceWriters} concurrent PATCHes at the same rev with the correct tok → exactly one 200 (D3, BE-1)`,
    http: null,
    status: null,
    message: null,
    winners: winners.length,
    loserCodes,
    storedIsWinner: winners.length === 1 && storedCt === contenders[winners[0]].ct,
    ok: winners.length === 1 && storedCt === contenders[winners[0]].ct,
  });

  // --- API key requirement (only meaningful against production) ---------------------------------------
  if (noKeyCheck) {
    r = await get(id, {});
    record("get-without-api-key", "informational: is x-goog-api-key required at all?", r, true);
  }

  return steps;
}

/**
 * Rules probes (spike.rules). `hashing`: for each sample string, submits the lowercase and the uppercase
 * hex SHA-256 of its UTF-8 bytes to the `probe` collection; the rules accept iff `h` equals
 * hashing.sha256(s).toHexString() exactly. `authIsNull`: the `authprobe` collection accepts a create
 * iff request.auth == null.
 */
export async function runRulesProbes(cfg) {
  const { docsUrl, headers = {} } = cfg;
  const post = async (coll, fields) => {
    try {
      const res = await fetch(`${docsUrl}/${coll}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ fields }),
      });
      await res.text();
      return res.status === 200 ? "accepted" : `rejected ${res.status}`;
    } catch (e) {
      return `no answer (${e})`;
    }
  };
  const enc = new TextEncoder();
  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const samples = [
    { label: "ascii", s: "abc" },
    { label: "base64url-token-43", s: "q3_Y-8u2nX0aLrT5vK9pWm4sBz7cE1dF6gH0jJ2kL8o" },
    { label: "non-ascii-utf8", s: "é ünïcødé 🦡" },
  ];
  const hashing = [];
  for (const { label, s } of samples) {
    const h = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
    const row = { label, utf8Bytes: enc.encode(s).length };
    for (const [variant, value] of [
      ["lower", h],
      ["upper", h.toUpperCase()],
    ]) {
      row[variant] = await post("probe", { s: { stringValue: s }, h: { stringValue: value } });
    }
    hashing.push(row);
  }
  const authIsNull = await post("authprobe", { x: { integerValue: "1" } });
  return { hashing, authIsNull };
}

/**
 * CORS + error-shape probe for production firestore.googleapis.com without a real project. Run inside a
 * page (https origin and file://). http 0 means the browser blocked the response (CORS) or the network failed.
 */
export async function runCorsProbe(cfg) {
  const { docsUrl, apiKey } = cfg;
  const id = "A".repeat(43);
  const fields = { v: { integerValue: "1" } };
  const cases = [
    [
      "GET, x-goog-api-key header (preflighted)",
      "GET",
      `${docsUrl}/burrow/${id}`,
      { "x-goog-api-key": apiKey },
    ],
    ["GET, ?key= query param (simple request)", "GET", `${docsUrl}/burrow/${id}?key=${apiKey}`, {}],
    ["GET, no key", "GET", `${docsUrl}/burrow/${id}`, {}],
    [
      "POST create, key header + JSON (preflighted)",
      "POST",
      `${docsUrl}/burrow?documentId=${id}`,
      { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      { fields },
    ],
    [
      "PATCH update, key header + JSON (preflighted)",
      "PATCH",
      `${docsUrl}/burrow/${id}?currentDocument.exists=true`,
      { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      { fields },
    ],
  ];
  const out = [];
  for (const [label, method, url, headers, body] of cases) {
    try {
      const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const json = await res.json().catch(() => null);
      out.push({
        label,
        cors: "ok",
        http: res.status,
        status: json?.error?.status ?? null,
        reason: json?.error?.details?.find?.((d) => d.reason)?.reason ?? null,
        message: (json?.error?.message ?? "").slice(0, 200),
      });
    } catch (e) {
      out.push({ label, cors: "blocked-or-network", http: 0, error: String(e) });
    }
  }
  return out;
}
