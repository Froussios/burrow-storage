// WP-00 browser spikes (Chromium via Playwright).
//
//   npm run browser    platform report for an https origin and file://, CORS + error shapes against
//                      production firestore.googleapis.com using a project that does not exist, and the
//                      WebAuthn PRF probe on the CDP virtual authenticator.  → results/browser.json
//   npm run prod       the full REST matrix + hashing probe from both origins against a REAL Spark
//                      project that has spike.rules deployed. Needs BURROW_SPIKE_PROJECT and
//                      BURROW_SPIKE_API_KEY. The project id and key are redacted from the output.
//                      → results/prod.json (results/prod-$SPIKE_LABEL.json when SPIKE_LABEL is set)
//
// The https origin is synthetic: Playwright fulfils https://burrow-spike.example/ locally, so the page is
// a real secure https origin (and a valid WebAuthn rp.id) while every other request goes to the network.
// Behind a TLS-intercepting proxy set SPIKE_IGNORE_HTTPS_ERRORS=1.
import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { runRestMatrix, runRulesProbes, runCorsProbe } from "./rest-matrix.mjs";

const PROD = process.argv.includes("--prod");
const HTTPS_ORIGIN = "https://burrow-spike.example";
const FILE_URL = new URL("./blank.html", import.meta.url).href;
const PAGE = "<!doctype html><meta charset=utf-8><title>burrow spike</title><p>burrow spike";

// Chromium ignores HTTPS_PROXY; hand it over explicitly when the environment routes egress through one.
const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const proxy = proxyUrl
  ? (({ protocol, host, username, password }) => ({
      server: `${protocol}//${host}`,
      ...(username && { username: decodeURIComponent(username), password: decodeURIComponent(password) }),
      bypass: "burrow-spike.example",
    }))(new URL(proxyUrl))
  : undefined;
const browser = await chromium.launch({ proxy });
const newContext = async () => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: process.env.SPIKE_IGNORE_HTTPS_ERRORS === "1" });
  await ctx.route(`${HTTPS_ORIGIN}/**`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: PAGE }),
  );
  return ctx;
};
const openPages = async (ctx) => {
  const https = await ctx.newPage();
  await https.goto(`${HTTPS_ORIGIN}/`);
  const file = await ctx.newPage();
  await file.goto(FILE_URL);
  return { https, file };
};

// What the library needs from the page's environment (architecture §2), probed in-page.
async function environment() {
  const out = {
    origin: self.origin,
    isSecureContext,
    subtle: typeof crypto.subtle?.digest === "function",
    broadcastChannel: typeof BroadcastChannel === "function",
    locks: typeof navigator.locks?.request === "function",
    deflateRaw: (() => {
      try {
        new CompressionStream("deflate-raw");
        return true;
      } catch {
        return false;
      }
    })(),
    publicKeyCredential: typeof PublicKeyCredential === "function",
  };
  try {
    await new Promise((resolve, reject) => {
      const req = indexedDB.open("burrow-spike", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("s");
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
    out.indexedDB = "ok";
  } catch (e) {
    out.indexedDB = String(e);
  }
  return out;
}

// WebAuthn PRF probe (architecture §8.2). Self-contained for page.evaluate. Records lengths and
// equalities only, never PRF output bytes.
async function prfProbe({ doCreate }) {
  const rpId = location.hostname;
  const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
  const salt = new TextEncoder().encode("burrow/prf/v1");
  const otherSalt = new TextEncoder().encode("burrow/prf/other");
  const hexOf = (buf) =>
    buf ? Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("") : null;
  const out = { rpId };
  out.isUserVerifyingPlatformAuthenticatorAvailable =
    await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  out.getClientCapabilities =
    typeof PublicKeyCredential.getClientCapabilities === "function"
      ? await PublicKeyCredential.getClientCapabilities()
      : "absent";
  if (!doCreate) return out;

  let cred;
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        rp: { id: rpId, name: rpId },
        user: { id: rnd(16), name: rpId, displayName: rpId },
        challenge: rnd(32),
        pubKeyCredParams: [
          { alg: -7, type: "public-key" },
          { alg: -257, type: "public-key" },
        ],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        attestation: "none",
        extensions: { prf: { eval: { first: salt } } },
        timeout: 10_000,
      },
    });
  } catch (e) {
    out.create = { error: e.name };
    return out;
  }
  const cx = cred.getClientExtensionResults().prf;
  out.create = {
    prf:
      cx === undefined
        ? "absent"
        : {
            enabled: cx.enabled ?? "absent",
            resultsFirst: cx.results?.first ? `${cx.results.first.byteLength} bytes` : "absent",
          },
  };
  const createFirst = hexOf(cx?.results?.first);

  const get = async (useAllowList, s) => {
    try {
      const a = await navigator.credentials.get({
        publicKey: {
          rpId,
          challenge: rnd(32),
          userVerification: "required",
          allowCredentials: useAllowList ? [{ id: cred.rawId, type: "public-key" }] : [],
          extensions: { prf: { eval: { first: s } } },
          timeout: 10_000,
        },
      });
      return {
        sameCredential: a.id === cred.id,
        first: hexOf(a.getClientExtensionResults().prf?.results?.first),
      };
    } catch (e) {
      return { error: e.name };
    }
  };
  const summary = (g) =>
    g.error
      ? g
      : {
          sameCredential: g.sameCredential,
          resultsFirst: g.first ? `${g.first.length / 2} bytes` : "absent",
        };
  const discoverable = await get(false, salt);
  const allowList = await get(true, salt);
  const other = await get(true, otherSalt);
  out.getEmptyAllowCredentials = {
    ...summary(discoverable),
    equalsCreateOutput: createFirst && discoverable.first ? discoverable.first === createFirst : null,
  };
  out.getWithAllowCredentials = {
    ...summary(allowList),
    equalsEmptyAllowCredentials:
      allowList.first && discoverable.first ? allowList.first === discoverable.first : null,
  };
  out.getOtherSalt = {
    ...summary(other),
    differsFromLibrarySalt: other.first && allowList.first ? other.first !== allowList.first : null,
  };
  return out;
}

// [page, virtual authenticator options or null]. rp.id is location.hostname, as architecture §8.2 does.
const PLATFORM = { transport: "internal", hasPrf: true, isUserVerified: true };
const SCENARIOS = {
  "no-virtual-authenticator": ["https", null],
  "internal+uv+prf": ["https", PLATFORM],
  "internal+uv, no prf": ["https", { ...PLATFORM, hasPrf: false }],
  "usb (roaming key)+uv+prf": ["https", { ...PLATFORM, transport: "usb" }],
  "internal+prf, uv fails": ["https", { ...PLATFORM, isUserVerified: false }],
  "internal+uv+prf on file://": ["file", PLATFORM],
};

async function prfScenarios() {
  const out = {};
  for (const [label, [where, opts]] of Object.entries(SCENARIOS)) {
    const ctx = await newContext();
    const page = await ctx.newPage();
    await page.goto(where === "https" ? `${HTTPS_ORIGIN}/` : FILE_URL);
    if (opts) {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("WebAuthn.enable", { enableUI: false });
      await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          ctap2Version: "ctap2_1",
          hasResidentKey: true,
          hasUserVerification: true,
          automaticPresenceSimulation: true,
          ...opts,
        },
      });
    }
    out[label] = await page.evaluate(prfProbe, { doCreate: opts !== null });
    await ctx.close();
  }
  return out;
}

const result = {
  chromium: browser.version(),
  playwright: "1.56.1",
  ranAt: new Date().toISOString().slice(0, 10),
};
const ctx = await newContext();
const pages = await openPages(ctx);

if (!PROD) {
  const docsUrl =
    "https://firestore.googleapis.com/v1/projects/burrow-wp00-no-such-project/databases/(default)/documents";
  const apiKey = "not-a-real-api-key-burrow-wp00";
  const ATTEMPTS = 3;
  for (const [name, page] of Object.entries(pages)) {
    // fetch() only says "Failed to fetch"; Chromium's own reason tells a CORS block (console error) from
    // a network error (requestfailed net::ERR_*). Several attempts, because a flaky egress path would
    // otherwise read as a CORS result.
    const diagnostics = [];
    page.on("requestfailed", (req) => diagnostics.push(`${req.method()} ${req.failure()?.errorText}`));
    page.on(
      "console",
      (msg) => /CORS|blocked/i.test(msg.text()) && diagnostics.push(msg.text().slice(0, 200)),
    );
    const attempts = [];
    for (let i = 0; i < ATTEMPTS; i++) attempts.push(await page.evaluate(runCorsProbe, { docsUrl, apiKey }));
    const corsAgainstProduction = attempts[0].map(({ label }, i) => {
      const answered = attempts.map((a) => a[i]).filter((r) => r.cors === "ok");
      const { cors, label: _, ...answer } = answered[0] ?? { http: 0 };
      return { label, answeredAttempts: `${answered.length}/${ATTEMPTS}`, ...answer };
    });
    result[name] = {
      environment: await page.evaluate(environment),
      corsAgainstProduction,
      corsConsoleErrors: diagnostics.filter((d) => /CORS|blocked/i.test(d)).length,
      failedRequests: diagnostics.filter((d) => !/CORS|blocked/i.test(d)),
    };
  }
  result.prf = await prfScenarios();
  await writeFile(new URL("./results/browser.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
} else {
  const project = process.env.BURROW_SPIKE_PROJECT;
  const apiKey = process.env.BURROW_SPIKE_API_KEY;
  if (!project || !apiKey) {
    console.error(
      "Set BURROW_SPIKE_PROJECT and BURROW_SPIKE_API_KEY (a throwaway Spark project with spike.rules deployed).",
    );
    process.exit(2);
  }
  const docsUrl = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
  const headers = { "x-goog-api-key": apiKey };
  for (const [name, page] of Object.entries(pages)) {
    result[name] = {
      environment: await page.evaluate(environment),
      rules: await page.evaluate(runRulesProbes, { docsUrl, headers }),
      matrix: await page.evaluate(runRestMatrix, {
        docsUrl,
        headers,
        raceWriters: 10,
        redact: [project, apiKey],
        noKeyCheck: true,
      }),
    };
  }
  const out = `./results/prod${process.env.SPIKE_LABEL ? `-${process.env.SPIKE_LABEL}` : ""}.json`;
  await writeFile(new URL(out, import.meta.url), JSON.stringify(result, null, 2) + "\n");
}

await browser.close();
console.log(JSON.stringify(result, null, 2));
