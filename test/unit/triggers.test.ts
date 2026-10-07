import { afterEach, describe, expect, it, vi } from "vitest";
import { World, settle, until } from "../support/devices.js";

let world: World;
afterEach(() => {
  world?.close();
  vi.restoreAllMocks();
});

describe("SYNC-6 pull triggers", () => {
  it("SYNC-6 a page focus pulls changes made on another device", async () => {
    world = new World();
    const a = await world.device().open();
    const bDev = world.device();
    // Without a live listener, only a trigger brings remote changes in.
    Object.defineProperty(bDev.backend, "capabilities", {
      value: { ...bDev.backend.capabilities, subscribe: false },
    });
    const b = await bDev.open();
    await b.link({ code: await a.exportCode() });
    await settle(b);
    await a.set({ theme: "dark" });
    await settle(a);
    expect(await b.get("theme")).toEqual({}); // no polling (syncIntervalMs 0), no listener
    const real = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => real() + 10_000); // past the focus throttle
    bDev.win.dispatchEvent(new Event("focus"));
    await until(async () => (await b.get("theme")).theme === "dark");
  });

  it("SYNC-6 a focus right after a pass started does not start another (one read per window switch)", async () => {
    world = new World();
    const dev = world.device();
    const a = await dev.open();
    await settle(a);
    const gets = dev.backend.stats.gets;
    dev.win.dispatchEvent(new Event("focus"));
    await new Promise((r) => setTimeout(r, 50));
    expect(dev.backend.stats.gets).toBe(gets);
  });

  it("SYNC-6 focus does not start a pass while the page is hidden", async () => {
    world = new World();
    const dev = world.device();
    const a = await dev.open();
    await settle(a);
    const gets = dev.backend.stats.gets;
    dev.visibility.visibilityState = "hidden";
    dev.win.dispatchEvent(new Event("focus"));
    await new Promise((r) => setTimeout(r, 50));
    expect(dev.backend.stats.gets).toBe(gets);
  });
});

describe("ERR-3 debug lines", () => {
  it("ERR-3 a pull that merges remote entries logs one merge line with counts only", async () => {
    world = new World();
    const a = await world.device().open();
    await a.set({ k1: "secret value", k2: 2 });
    await settle(a);
    const lines: unknown[][] = [];
    vi.spyOn(console, "debug").mockImplementation((...args: unknown[]) => {
      lines.push(args);
    });
    const b = await world.device().open({ debug: true });
    await b.link({ code: await a.exportCode() });
    await settle(b);
    const merges = lines.filter((l) => String(l[0]).endsWith(" merge"));
    expect(merges.length).toBeGreaterThanOrEqual(1);
    expect(merges[0]![1]).toEqual({ attempt: 0, remote: 2, pruned: 0 });
    const text = JSON.stringify(lines);
    expect(text).not.toContain("secret value");
    expect(text).not.toContain("k1");
  });
});
