// The demo's Firestore backend (#24, D-40, D-41): the Firebase project named in
// the page's Firebase config (burrow-storage-shared on the deployed demo, the
// emulator in ci.yml) exists, has a Firestore database, accepts the page's web
// app config, has the Burrow rules deployed (a new token's first write and a
// later update both pass them), is within its quota, and syncs two devices
// both ways. A second backend gets its own spec and Playwright project
// alongside this one. Every run writes a few KB that are never deleted (D-40).
import { expect, test } from "@playwright/test";
import { COMMIT, csp, device, inspect, load } from "./support";

const EMU = process.env.FIRESTORE_EMULATOR_HOST;
const LIVE = "https://firestore.googleapis.com";
/** What the CSP allows: the emulator is added to it under the emulator. */
const FIRESTORE = [LIVE, ...(EMU ? [`http://${EMU}`] : [])];
/** Where the page must go: the emulator only, so CI never writes to a live project. */
const TARGET = EMU ? `http://${EMU}` : LIVE;

test("the CSP lets the page reach Firestore and no other backend", async ({
  browser,
}) => {
  const a = await device(browser);
  await load(a.page);
  expect((await csp(a.page))["connect-src"]).toBe(
    ["'self'", ...FIRESTORE].join(" "),
  );
});

test("two fresh browser contexts sync through the demo's Firebase project", async ({
  browser,
  baseURL,
}) => {
  const a = await device(browser);
  const b = await device(browser);
  const note = `smoke test ${COMMIT?.slice(0, 7) ?? "local"} ${new Date().toISOString()}`;

  // A writes, and the write reaches Firestore: a new token has no manifest
  // until its first push.
  await load(a.page);
  await a.page.locator("#draft").fill(note);
  await expect
    .poll(() => inspect(a.page), { timeout: 30_000 })
    .toMatchObject({
      status: "idle",
      dirtyKeys: 0,
      manifestRev: expect.any(Number),
    });
  const token = (await a.page.locator("#code").textContent())!;

  // B links with A's token and gets the write.
  await load(b.page);
  await b.page.locator("#link-code").fill(token);
  await b.page.locator("#link-form button[type=submit]").click();
  await expect(b.page.locator("#message")).toHaveText(
    "Linked. Your data is here.",
    { timeout: 30_000 },
  );
  await expect(b.page.locator("#draft")).toHaveValue(note, { timeout: 30_000 });

  // And back: B's change reaches A, still open, through Firestore.
  await b.page.locator("#theme").click();
  await expect(a.page.locator("html")).toHaveAttribute("data-theme", "dark", {
    timeout: 30_000,
  });

  expect([...a.problems, ...b.problems]).toEqual([]);
  const own = new URL(baseURL!).origin;
  for (const d of [a, b])
    expect([...d.origins].filter((o) => o !== own)).toEqual([TARGET]);
});
