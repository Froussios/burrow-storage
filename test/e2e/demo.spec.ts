// M7: the demo under its strict CSP, with no console errors, syncing between two devices.
import { type ConsoleMessage, expect, test } from "@playwright/test";

test("the demo runs under its strict CSP without console errors and syncs a second device", async ({ browser }) => {
  const errors: string[] = [];
  const watch = (m: ConsoleMessage) => { if (m.type() === "error") errors.push(m.text()); };
  const deviceA = await browser.newContext();
  const deviceB = await browser.newContext();
  const a = await deviceA.newPage();
  a.on("console", watch);
  a.on("pageerror", (e) => errors.push(String(e)));
  await a.goto("/demo/index.html");
  await expect(a.locator("body")).toHaveAttribute("data-ready", "true");
  await a.locator("#theme").click();
  await expect(a.locator("html")).toHaveAttribute("data-theme", "dark");
  await a.locator("#draft").fill("hello from the demo");
  await a.locator("#show-code").click();
  await expect(a.locator("#code")).toHaveText(/^([0-9A-Z]{4}-){13}[0-9A-Z]{4}$/);
  const code = (await a.locator("#code").textContent())!;
  await expect(a.locator("#status")).toHaveText("synced", { timeout: 15_000 });

  const b = await deviceB.newPage();
  b.on("console", watch);
  b.on("pageerror", (e) => errors.push(String(e)));
  await b.goto("/demo/index.html");
  await expect(b.locator("body")).toHaveAttribute("data-ready", "true");
  await b.locator("#link-code").fill(code.toLowerCase());
  await b.locator("#link-form button[type=submit]").click();
  await expect(b.locator("#draft")).toHaveValue("hello from the demo", { timeout: 30_000 });
  await expect(b.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(errors).toEqual([]);
  await deviceA.close(); await deviceB.close();
});
