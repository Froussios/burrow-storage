// API-5 / ERR-2: BurrowEvent is both a chrome.storage-style listener channel and a real EventTarget.
import { describe, expect, it } from "vitest";
import { BurrowEvent } from "../../src/events.js";

/**
 * Run `fn` with uncaught exceptions captured instead of failing the run. Node's EventTarget reports
 * an exception thrown by a listener as an uncaught exception on the next tick (the DOM reports it
 * to window.onerror); either way dispatch continues with the next listener. Vitest's own handlers
 * are set aside for the duration and restored afterwards.
 */
async function catchUncaught(fn: () => void): Promise<unknown[]> {
  const caught: unknown[] = [];
  const saved = process.listeners("uncaughtException");
  process.removeAllListeners("uncaughtException");
  const mine = (e: unknown) => {
    caught.push(e);
  };
  process.on("uncaughtException", mine);
  try {
    fn();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    process.off("uncaughtException", mine);
    for (const l of saved) process.on("uncaughtException", l);
  }
  return caught;
}

describe("BurrowEvent", () => {
  it("API-5 addListener, hasListener and removeListener", () => {
    const ev = new BurrowEvent<number>("changed");
    const seen: number[] = [];
    const fn = (n: number) => seen.push(n);
    expect(ev.hasListener(fn)).toBe(false);
    ev.addListener(fn);
    expect(ev.hasListener(fn)).toBe(true);
    ev.emit(1);
    ev.removeListener(fn);
    expect(ev.hasListener(fn)).toBe(false);
    ev.emit(2);
    expect(seen).toEqual([1]);
    // Removing an unknown or already removed listener is a no-op.
    expect(() => ev.removeListener(fn)).not.toThrow();
    expect(() => ev.removeListener(() => {})).not.toThrow();
  });

  it("API-5 adding the same function twice registers it once", () => {
    const ev = new BurrowEvent<string>("changed");
    let calls = 0;
    const fn = () => {
      calls++;
    };
    ev.addListener(fn);
    ev.addListener(fn);
    ev.emit("x");
    expect(calls).toBe(1);
    ev.removeListener(fn); // one removal is enough
    ev.emit("y");
    expect(calls).toBe(1);
  });

  it("API-5 listeners run in registration order and each receives the detail", () => {
    const ev = new BurrowEvent<{ k: number }>("changed");
    const order: string[] = [];
    const detail = { k: 1 };
    ev.addListener((d) => {
      expect(d).toBe(detail);
      order.push("a");
    });
    ev.addListener((d) => {
      expect(d).toBe(detail);
      order.push("b");
    });
    ev.emit(detail);
    expect(order).toEqual(["a", "b"]);
  });

  it("is a real EventTarget: addEventListener receives a CustomEvent with detail", () => {
    const ev = new BurrowEvent<{ status: string }>("status");
    expect(ev).toBeInstanceOf(EventTarget);
    expect(ev.type).toBe("status");
    const got: Event[] = [];
    const l = (e: Event) => got.push(e);
    ev.addEventListener("status", l);
    ev.addEventListener("other", () => {
      throw new Error("wrong type");
    });
    ev.emit({ status: "idle" });
    expect(got).toHaveLength(1);
    expect(got[0]).toBeInstanceOf(CustomEvent);
    expect(got[0]!.type).toBe("status");
    expect((got[0] as CustomEvent).detail).toEqual({ status: "idle" });
    ev.removeEventListener("status", l);
    ev.emit({ status: "syncing" });
    expect(got).toHaveLength(1);
  });

  it("both listener styles receive the same emit", () => {
    const ev = new BurrowEvent<number>("changed");
    const seen: string[] = [];
    ev.addListener((n) => seen.push(`listener:${n}`));
    ev.addEventListener("changed", (e) =>
      seen.push(`target:${(e as CustomEvent<number>).detail}`),
    );
    ev.emit(7);
    expect(seen).toEqual(["listener:7", "target:7"]);
  });

  it("ERR-2 a listener that throws does not stop the next listener, and the error is reported", async () => {
    const ev = new BurrowEvent<number>("changed");
    const seen: number[] = [];
    const boom = new Error("listener failed");
    ev.addListener(() => {
      throw boom;
    });
    ev.addListener((n) => seen.push(n));
    ev.addEventListener("changed", (e) =>
      seen.push((e as CustomEvent<number>).detail * 10),
    );
    let returned = false;
    const caught = await catchUncaught(() => {
      ev.emit(4);
      returned = true;
    });
    // emit() itself does not throw: the core's caller is never interrupted by a page's listener.
    expect(returned).toBe(true);
    expect(seen).toEqual([4, 40]);
    expect(caught).toEqual([boom]);
  });
});
