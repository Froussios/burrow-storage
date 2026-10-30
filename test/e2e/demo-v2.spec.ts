// Demo v2: shared async editor, isolated scenarios and explicit token custody.
import { type BrowserContext, type Page, expect, test } from "@playwright/test";
import { MemoryBackend } from "../../src/backends/memory.js";
import type { Envelope, PutOptions } from "../../src/types.js";
import { databases, profileDump } from "./helpers.js";

const OFFLINE = "burrow-demo-v2-offline:token";
const TOKEN = /^([0-9A-Z]{4}-){13}[0-9A-Z]{4}$/;

// A real encrypted store shared across navigations and browser contexts,
// without reaching the live project or depending on network timing.
async function backend(context: BrowserContext, remote = new MemoryBackend()) {
  await context.exposeBinding("demoRemote", async (_, method, args) => {
    try {
      const value =
        method === "get"
          ? await remote.get(args[0] as string)
          : await remote.put(
              ...(args as [string, Envelope, number | null, PutOptions?]),
            );
      return { value };
    } catch (e) {
      return { error: (e as { code: string }).code };
    }
  });
  await context.route("**/burrow.min.js", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body:
        (await response.text()) +
        `
Burrow.registerBackend("demo-v2-test", () => ({
  id: "demo-v2-test",
  capabilities: { writeAuth: true, subscribe: false },
  async get(...args) {
    const result = await window.demoRemote("get", args);
    if (result.error) throw new Burrow.BackendError(result.error);
    return result.value;
  },
  async put(...args) {
    const result = await window.demoRemote("put", args);
    if (result.error) throw new Burrow.BackendError(result.error);
  }
}));
window.BURROW = { backend: { type: "demo-v2-test" } };`,
    });
  });
  return remote;
}

async function open(page: Page, scenario = "offline") {
  await page.goto(`/demo/v2.html?scenario=${scenario}`);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
}

async function start(page: Page, remember = false) {
  await page.locator("#remember-new").setChecked(remember);
  await page.locator("#new-token").click();
  await expect(page.locator("#code")).toHaveText(TOKEN);
  await expect(page.locator("#status")).toHaveText("synced");
  return (await page.locator("#code").textContent())!;
}

async function enter(page: Page, token: string, remember = false) {
  await page.locator("#remember-returning").setChecked(remember);
  await page.locator("#token-input").fill(token);
  await page.locator("#token-form button").click();
  await expect(page.locator("#draft")).toBeEnabled();
  await expect(page.locator("#status")).toHaveText("synced");
}

test("initial reads finish before either demo accepts edits", async ({
  context,
  page,
}) => {
  const remote = await backend(context);
  const get = remote.get.bind(remote);
  for (const url of ["/demo/index.html", "/demo/v2.html?scenario=core"]) {
    let release!: () => void;
    let reading!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requested = new Promise<void>((resolve) => {
      reading = resolve;
    });
    remote.get = async (id) => {
      reading();
      await paused;
      return get(id);
    };
    await page.goto(url);
    await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
    await page.locator("#new-token").click();
    await requested;
    try {
      if (url === "/demo/index.html")
        await expect(page.locator("#app")).toBeHidden();
      else await expect(page.locator("#theme")).toBeDisabled();
    } finally {
      release();
    }
    await expect(page.locator("#theme")).toBeVisible();
    await expect(page.locator("#theme")).toBeEnabled();
    await page.locator("#theme").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("#status")).toHaveText("synced");
  }
});

test("scenario URLs enumerate every setup and reject unknown scenarios without opening storage", async ({
  context,
  page,
}) => {
  const remote = await backend(context);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto("/demo/v2.html");
  await expect(page).toHaveURL(/scenario=core$/);
  await expect(page.locator(".scenario-link")).toHaveCount(2);
  await expect(page.locator(".scenario-link").first()).toHaveAttribute(
    "data-scenario",
    "core",
  );
  await expect(page.locator("#remember-new")).not.toBeChecked();
  await expect(page.locator('[aria-current="page"]')).toHaveAttribute(
    "data-scenario",
    "core",
  );
  await expect(page.locator("#signin")).toBeVisible();
  const code = page.locator("main #snippet-passkey-get");
  await expect(code.locator("code")).toBeHidden();
  await code.locator("summary").click();
  await expect(code.locator("code")).toBeVisible();
  await expect(code.locator("code")).toContainText("burrow-demo-v2-core");
  await code.locator("summary").click();
  await expect(code.locator("code")).toBeHidden();
  await open(page, "does-not-exist");
  await expect(page.locator("#status")).toHaveText("unknown scenario");
  await expect(page.locator("#signin")).toBeHidden();
  expect(await profileDump(page)).not.toContain("burrow-demo-v2-offline:token");
  expect(remote.stats).toEqual({ gets: 0, puts: 0 });
  expect(errors).toEqual([]);
});

test("switching immediately after an edit preserves offline data; core uses a separate token and locks on reload", async ({
  context,
  page,
}) => {
  await backend(context);
  await open(page);
  const offline = await start(page, true);
  await page.locator("#draft").fill("offline space");
  // Navigation must await the debounce/local write, without a data-loss prompt.
  await page.locator('[data-scenario="core"]').click();
  await expect(page.locator("#signin")).toBeVisible();
  const core = await start(page);
  expect(core).not.toBe(offline);
  await expect(page.locator("#draft")).toHaveValue("");
  await page.locator("#draft").fill("core space");
  await expect(page.locator("#status")).toHaveText("synced");
  const dump = await profileDump(page);
  expect(dump).not.toContain(core);
  expect(dump).not.toContain("core space");
  expect(JSON.parse(JSON.parse(dump).localStorage[OFFLINE]).token).toBe(
    offline,
  );
  await page.reload();
  await expect(page.locator("#signin")).toBeVisible();
  await enter(page, core);
  await expect(page.locator("#draft")).toHaveValue("core space");
  await page.locator('[data-scenario="offline"]').click();
  await expect(page.locator("#draft")).toHaveValue("offline space");
  await expect(page.locator("#code")).toHaveText(offline);
});

test("offline writes survive a reload without a backend, then reach another device on reconnect", async ({
  browser,
  context,
  page,
}) => {
  const remote = await backend(context);
  const second = await browser.newContext();
  await backend(second, remote);
  await open(page);
  const token = await start(page, true);
  remote.failWith = "network";
  await page.locator("#draft").fill("queued while offline");
  await expect(page.locator("#status")).toHaveText("offline");
  await expect(page.locator("#draft")).toBeEnabled();
  await page.reload();
  await expect(page.locator("#draft")).toHaveValue("queued while offline");
  await expect(page.locator("#code")).toHaveText(token);
  remote.failWith = null;
  // Reopening triggers sync without waiting for the retry timer.
  await page.reload();
  await expect(page.locator("#status")).toHaveText("synced");
  const other = await second.newPage();
  await open(other);
  await enter(other, token);
  await expect(other.locator("#draft")).toHaveValue("queued while offline");
  await second.close();
});

test("even an explicitly reused token cannot expose another scenario's remote content; signing out clears only offline data", async ({
  context,
  page,
}) => {
  await backend(context);
  await open(page);
  const token = await start(page, true);
  await page.locator("#draft").fill("isolated by app as well as token");
  await expect(page.locator("#status")).toHaveText("synced");
  await page.locator('[data-scenario="core"]').click();
  await enter(page, token);
  await expect(page.locator("#draft")).toHaveValue("");
  await page.locator("#draft").fill("separate remote content");
  await expect(page.locator("#status")).toHaveText("synced");
  await page.locator('[data-scenario="offline"]').click();
  await expect(page.locator("#draft")).toHaveValue(
    "isolated by app as well as token",
  );
  await page.locator("#signout").click();
  await expect(page.locator("#signin")).toBeVisible();
  const dump = await profileDump(page);
  expect(JSON.parse(dump).localStorage).toEqual({});
  expect(databases(dump)).toEqual([]);
  await page.locator('[data-scenario="core"]').click();
  await enter(page, token);
  await expect(page.locator("#draft")).toHaveValue("separate remote content");
});

test("core reports a refused write, keeps nothing on disk, and asks before abandoning the edit", async ({
  context,
  page,
}) => {
  const remote = await backend(context);
  await open(page, "core");
  await start(page);
  remote.failWith = "network";
  await page.locator("#draft").fill("not saved");
  await expect(page.locator("#message")).toHaveText(
    "Not saved: the store could not be reached (backend).",
  );
  await expect(page.locator("#draft")).toBeEnabled();
  await expect(page.locator("#draft")).toHaveValue("not saved");
  const dump = await profileDump(page);
  expect(JSON.parse(dump).localStorage).toEqual({});
  expect(databases(dump)).toEqual([]);
  page.once("dialog", (d) => void d.dismiss());
  await page.locator('[data-scenario="offline"]').click();
  await expect(page.locator("#draft")).toHaveValue("not saved");
  await expect(page).toHaveURL(/scenario=core$/);
  remote.failWith = null;
  await page.locator("#draft").fill("retry saved");
  await expect(page.locator("#status")).toHaveText("synced");
});

test("passkeys create distinct credentials and tokens for the two scenarios", async ({
  browserName,
  context,
  page,
}) => {
  test.skip(
    browserName !== "chromium",
    "virtual PRF authenticator requires Chromium",
  );
  await backend(context);
  await open(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        hasPrf: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  await page.locator("#passkey-create").click();
  await expect(page.locator("#code")).toHaveText(TOKEN);
  const offline = await page.locator("#code").textContent();
  await page.locator('[data-scenario="core"]').click();
  // The same existing passkey also derives a different token for core.
  await page.locator("#passkey-get").click();
  await expect(page.locator("#code")).toHaveText(TOKEN);
  const core = await page.locator("#code").textContent();
  expect(core).not.toBe(offline);
  await page.locator("#signout").click();
  await page.locator("#passkey-create").click();
  await expect(page.locator("#code")).toHaveText(TOKEN);
  expect(await page.locator("#code").textContent()).not.toBe(offline);
  const { credentials } = await cdp.send("WebAuthn.getCredentials", {
    authenticatorId,
  });
  expect(credentials).toHaveLength(2);
  expect(new Set(credentials.map((c) => c.userHandle)).size).toBe(2);
});

test("core can remember the token as a demo option without persisting content", async ({
  context,
  page,
}) => {
  await backend(context);
  await open(page, "core");
  const token = await start(page, true);
  await page.locator("#draft").fill("remote content only");
  await expect(page.locator("#status")).toHaveText("synced");
  await expect(page.locator("#custody")).toContainText("by this demo");
  const dump = await profileDump(page);
  expect(
    JSON.parse(JSON.parse(dump).localStorage["burrow-demo-v2-core:token"])
      .token,
  ).toBe(token);
  expect(databases(dump)).toEqual([]);
  expect(dump).not.toContain("remote content only");
  await page.reload();
  await expect(page.locator("#code")).toHaveText(token);
  await expect(page.locator("#draft")).toHaveValue("remote content only");
  await page.locator("#signout").click();
  await expect(page.locator("#signin")).toBeVisible();
  expect(JSON.parse(await profileDump(page)).localStorage).toEqual({});
  await page.reload();
  await expect(page.locator("#signin")).toBeVisible();
  await expect(page.locator("#remember-new")).not.toBeChecked();
});

test("offline content can persist without remembering the token; a token is required to reopen it", async ({
  context,
  page,
}) => {
  const remote = await backend(context);
  await open(page);
  await expect(page.locator("#remember-new")).not.toBeChecked();
  await expect(page.locator("#token-only-hint")).toContainText(
    "will not store the token",
  );
  const token = await start(page);
  await expect(page.locator("#token-reminder")).toContainText("Write it down");
  await page.locator("#draft").fill("cached without token custody");
  await expect(page.locator("#status")).toHaveText("synced");
  const dump = await profileDump(page);
  expect(JSON.parse(dump).localStorage).toEqual({});
  expect(dump).not.toContain(token);
  expect(databases(dump)).toHaveLength(1);
  remote.failWith = "network";
  await page.reload();
  await expect(page.locator("#signin")).toBeVisible();
  await expect(page.locator("#draft")).toBeVisible();
  await expect(page.locator("#draft")).toBeDisabled();
  await page.locator("#token-input").fill(token);
  await page.locator("#token-form button").click();
  await expect(page.locator("#draft")).toHaveValue(
    "cached without token custody",
  );
  await expect(page.locator("#status")).toHaveText("offline");
  expect(JSON.parse(await profileDump(page)).localStorage).toEqual({});
});

test("a failed demo token save stays in memory and tells the user to keep it", async ({
  context,
  page,
}) => {
  await backend(context);
  await open(page, "core");
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Storage disabled", "SecurityError");
    };
  });
  await start(page, true);
  await expect(page.locator("#token-reminder")).toContainText(
    "could not save your token",
  );
  await expect(page.locator("#custody")).toContainText("memory only");
  expect(JSON.parse(await profileDump(page)).localStorage).toEqual({});
  await page.reload();
  await expect(page.locator("#signin")).toBeVisible();
});

test("the workspace stays visible and disabled until setup, and becomes disabled again after sign-out", async ({
  context,
  page,
}) => {
  const remote = await backend(context);
  await open(page, "core");
  await expect(page.locator("#draft")).toBeVisible();
  await expect(page.locator("#draft")).toBeDisabled();
  await expect(page.locator("#theme")).toBeDisabled();
  await expect(page.locator("#token-details")).toBeHidden();
  await expect(page.locator("#autosave-hint")).toBeHidden();
  expect(remote.stats).toEqual({ gets: 0, puts: 0 });
  await page.locator("#token-input").fill("invalid");
  await page.locator("#token-form button").click();
  await expect(page.locator("#message")).toContainText(
    "That token is not right",
  );
  await expect(page.locator("#draft")).toBeDisabled();
  await start(page);
  await expect(page.locator("#draft")).toBeEnabled();
  await expect(page.locator("#autosave-hint")).toBeVisible();
  await expect(page.locator("#draft")).toHaveAttribute(
    "aria-describedby",
    "autosave-hint",
  );
  await page.locator("#draft").fill("working draft");
  await expect(page.locator("#status")).toHaveText("synced");
  await page.locator("#signout").click();
  await expect(page.locator("#draft")).toBeVisible();
  await expect(page.locator("#draft")).toBeDisabled();
  await expect(page.locator("#draft")).toHaveValue("");
  await expect(page.locator("#theme")).toBeDisabled();
  await expect(page.locator("#autosave-hint")).toBeHidden();
  await expect(page.locator("#draft")).not.toHaveAttribute(
    "aria-describedby",
    "autosave-hint",
  );
});

test("new and returning users have independent remembering choices", async ({
  context,
  page,
}) => {
  await backend(context);
  await open(page, "core");
  await expect(
    page.getByRole("heading", { name: "Returning user", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "New user", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", {
      name: "Returning user or New user",
      exact: true,
    }),
  ).toBeVisible();
  await page.locator("#remember-returning").check();
  // The checked returning choice must not save a newly generated token.
  const token = await start(page);
  expect(JSON.parse(await profileDump(page)).localStorage).toEqual({});
  await page.locator("#signout").click();
  await page.locator("#remember-new").check();
  // The checked new-user choice must not save a pasted token.
  await enter(page, token);
  expect(JSON.parse(await profileDump(page)).localStorage).toEqual({});
  await page.locator("#signout").click();
  await enter(page, token, true);
  expect(
    JSON.parse(
      JSON.parse(await profileDump(page)).localStorage[
        "burrow-demo-v2-core:token"
      ],
    ).token,
  ).toBe(token);
  await page.reload();
  await expect(page.locator("#draft")).toBeEnabled();
  await expect(page.locator("#code")).toHaveText(token);
});

test("remembering help is available on focus, hover and tap, and can be dismissed", async ({
  context,
  page,
}) => {
  await backend(context);
  await open(page, "core");
  const trigger = page.getByRole("button", {
    name: "About remembering a token for returning users",
  });
  const tooltip = page.locator("#remember-returning-hint");
  await expect(tooltip).toBeHidden();
  await trigger.focus();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("unencrypted");
  await page.keyboard.press("Escape");
  await expect(tooltip).toBeHidden();
  await trigger.click();
  await expect(tooltip).toBeVisible();
  await trigger.click();
  await expect(tooltip).toBeHidden();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.click();
  await expect(tooltip).toBeVisible();
  await page.locator("#scenario-title").click();
  await expect(tooltip).toBeHidden();
  await trigger.hover();
  await expect(tooltip).toBeVisible();
  await expect(page.locator("#remember-returning")).not.toBeChecked();
  await expect(page.locator("#draft")).toBeDisabled();
});

test("library actions have short adjacent code examples that do not execute", async ({
  context,
  page,
}) => {
  const remote = await backend(context);
  for (const scenario of ["core", "offline"]) {
    await open(page, scenario);
    const before = { ...remote.stats };
    const examples = [
      ["passkey-get", "passkey.get()"],
      ["passkey-create", "passkey.create()"],
      ["paste-token", "Burrow.burrow"],
      ["token-create", "Burrow.generateToken()"],
      ["theme", "store.set"],
      ["content", "store.get"],
    ] as const;
    for (const [id, api] of examples) {
      const example = page.locator(`main #snippet-${id}`);
      await expect(example.locator("code").first()).toBeHidden();
      await example.locator("summary").click();
      await expect(example.locator("code").first()).toContainText(api);
    }
    await expect(page.locator("#snippet-content code").nth(1)).toContainText(
      "store.set",
    );
    await expect(page.locator("#remember-returning")).not.toBeChecked();
    await expect(page.locator("#remember-new")).not.toBeChecked();
    await expect(page.locator("#draft")).toBeDisabled();
    expect(remote.stats).toEqual(before);
    await expect(
      page.locator("#token-form #snippet-paste-token"),
    ).toBeVisible();
    await expect(
      page.locator(".action-line:has(#passkey-get) #snippet-passkey-get"),
    ).toBeVisible();

    await start(page);
    await expect(page.locator("#message")).toContainText("Token created.");
    const connected = { ...remote.stats };
    const signout = page.locator("#token-details #snippet-signout");
    await expect(signout.locator("code")).toBeHidden();
    await signout.locator("summary").click();
    await expect(signout.locator("code")).toContainText(
      "localStorage.removeItem",
    );
    await expect(page.locator("#draft")).toBeEnabled();
    expect(remote.stats).toEqual(connected);
  }
});
