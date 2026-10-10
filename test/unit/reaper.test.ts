import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  conditionalStub,
  expiryCandidate,
  parseArgs,
  quotaDay,
  reap,
  RETENTION_MS,
  type ReaperOptions,
  type Request,
} from "../../scripts/burrow-reaper.mjs";
const prefix = "projects/reaper-test/databases/(default)/documents/content";
const now = Date.parse("2026-10-10T12:00:00Z");
const id = "a".repeat(43);
const next = "b".repeat(64);
const document = (id: string, time = now - RETENTION_MS) => ({
  name: `${prefix}/${id}`,
  updateTime: new Date(time).toISOString(),
  fields: { rev: { integerValue: "3" }, next: { stringValue: next } },
});
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function options(
  extra: Partial<ReaperOptions> = {},
): Promise<ReaperOptions> {
  const dir = await mkdtemp(join(tmpdir(), "burrow-reaper-"));
  directories.push(dir);
  return {
    ...parseArgs([
      "--project",
      "reaper-test",
      "--database",
      "(default)",
      "--collection",
      "content",
      "--content-only",
    ]),
    state: join(dir, "cache.json"),
    ...extra,
  };
}
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe("D-48 owner reaper", () => {
  it("uses only valid server updateTime and preserves the exact timestamp precondition", () => {
    const doc = document(id);
    expect(
      expiryCandidate(
        {
          ...doc,
          fields: { ...doc.fields, ts: { integerValue: "0" } },
          updateTime: new Date(now).toISOString(),
        },
        prefix,
        now,
      ),
    ).toBe("active");
    expect(
      expiryCandidate(
        {
          ...doc,
          fields: { ...doc.fields, ts: { integerValue: String(now) } },
        },
        prefix,
        now,
      ),
    ).toMatchObject({ currentDocument: { updateTime: doc.updateTime } });
    for (const updateTime of [
      undefined,
      null,
      "bad",
      "2025-02-30T00:00:00Z",
      "9999-99-99T00:00:00Z",
    ])
      expect(expiryCandidate({ ...doc, updateTime }, prefix, now)).toBe(
        "refused",
      );
    const microseconds = doc.updateTime.replace(".000Z", ".123456Z");
    expect(
      expiryCandidate({ ...doc, updateTime: microseconds }, prefix, now + 1000),
    ).toMatchObject({ currentDocument: { updateTime: microseconds } });
    expect(
      expiryCandidate({ ...doc, name: "another/target" }, prefix, now),
    ).toBe("refused");
    expect(
      expiryCandidate(
        { ...doc, fields: { ...doc.fields, x: { booleanValue: true } } },
        prefix,
        now,
      ),
    ).toBe("stub");
  });

  it("defaults to dry run and refuses ambiguous/mixed targets or unsafe budgets", () => {
    const valid = [
      "--project",
      "reaper-test",
      "--database",
      "(default)",
      "--collection",
      "content",
      "--content-only",
    ];
    expect(parseArgs(valid)).toMatchObject({
      apply: false,
      maxReads: 10_000,
      maxWrites: 1000,
    });
    for (const args of [
      [],
      valid.slice(0, -1),
      [...valid, "--mixed"],
      [...valid, "--max-reads", "50001"],
      [...valid, "--max-writes", "20001"],
      [...valid, "--page-size", "101"],
      [...valid, "--oops"],
    ])
      expect(() => parseArgs(args)).toThrow();
  });

  it("dry run masks payloads, paginates, counts without identifiers and never writes", async () => {
    const opts = await options({ pageSize: 2 });
    const request = vi.fn<Request>(async (path) => {
      const query = new URL("https://test.invalid" + path).searchParams;
      expect(query.getAll("mask.fieldPaths")).toEqual(["x", "rev", "next"]);
      return query.has("pageToken")
        ? response({ documents: [document("c".repeat(43), now)] })
        : response({
            documents: [
              document(id),
              {
                ...document("d".repeat(43)),
                fields: { x: { booleanValue: true } },
              },
            ],
            nextPageToken: "private-cursor",
          });
    });
    const summary = await reap(opts, { request, now: () => now });
    expect(summary).toMatchObject({
      scanned: 3,
      eligible: 1,
      active: 1,
      stubs: 1,
      stubbed: 0,
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(summary)).not.toContain(id);
    expect(JSON.stringify(summary)).not.toContain(next);
    expect((await stat(opts.state)).mode & 0o777).toBe(0o600);
  });

  it("reserves daily quota persistently across reruns and resumes the private cursor after Pacific midnight", async () => {
    const opts = await options({ maxReads: 2, pageSize: 1 });
    const seen: string[] = [];
    const request: Request = async (path) => {
      const token =
        new URL("https://test.invalid" + path).searchParams.get("pageToken") ??
        "0";
      seen.push(token);
      const n = Number(token);
      return response({
        documents: [document(String(n).repeat(43))],
        ...(n < 2 ? { nextPageToken: String(n + 1) } : {}),
      });
    };
    expect(await reap(opts, { request, now: () => now })).toMatchObject({
      scanned: 2,
      budgetStopped: true,
    });
    expect(await reap(opts, { request, now: () => now })).toMatchObject({
      scanned: 0,
      budgetStopped: true,
    });
    expect(seen).toEqual(["0", "1"]);
    expect(
      await reap(opts, { request, now: () => now + 86_400_000 }),
    ).toMatchObject({ scanned: 1, budgetStopped: false });
    expect(seen).toEqual(["0", "1", "2"]);
    const data = JSON.parse(await readFile(opts.state, "utf8"));
    expect(Object.values(data.projects)).toEqual([
      { day: quotaDay(now + 86_400_000), reads: 1, writes: 0 },
    ]);
    expect(quotaDay(Date.parse("2026-10-10T06:59:59Z"))).toBe("2026-10-09");
    expect(quotaDay(Date.parse("2026-10-10T07:00:00Z"))).toBe("2026-10-10");
  });

  it("write attempts reserve quota, skip changed documents once and keep an interrupted page for the next run", async () => {
    const opts = await options({ apply: true, maxWrites: 1 });
    let writes = 0;
    const request: Request = async (_path, init) => {
      if (init?.method === "POST") {
        writes++;
        const write = JSON.parse(init.body as string).writes[0];
        expect(Object.keys(write.update.fields).sort()).toEqual([
          "next",
          "rev",
          "x",
        ]);
        expect(write.currentDocument.updateTime).toBe(document(id).updateTime);
        return response(
          {
            error: { status: "FAILED_PRECONDITION", message: `${id} ${next}` },
          },
          400,
        );
      }
      return response({
        documents: [document(id), document("c".repeat(43))],
        nextPageToken: "next",
      });
    };
    expect(await reap(opts, { request, now: () => now })).toMatchObject({
      changed: 1,
      stubbed: 0,
      budgetStopped: true,
    });
    expect(writes).toBe(1);
    expect(await reap(opts, { request, now: () => now })).toMatchObject({
      changed: 0,
      budgetStopped: true,
    });
    expect(writes).toBe(1);
    const data = JSON.parse(await readFile(opts.state, "utf8"));
    expect(Object.values(data.scans)).toEqual([]);
  });

  it("explicit cursor recovery preserves project quota and other target/mode cursors", async () => {
    const opts = await options({ maxReads: 3, pageSize: 1 });
    const request: Request = async (path) => {
      const token = new URL("https://test.invalid" + path).searchParams.get(
        "pageToken",
      );
      return token
        ? response({ error: { message: "private-stale-cursor" } }, 400)
        : response({
            documents: [document(id)],
            nextPageToken: "private-stale-cursor",
          });
    };
    await expect(reap(opts, { request, now: () => now })).rejects.toThrow(
      "request-failed",
    );
    const before = JSON.parse(await readFile(opts.state, "utf8"));
    expect(Object.values(before.projects)).toEqual([
      { day: quotaDay(now), reads: 2, writes: 0 },
    ]);
    // A distinct mode shares project reservations but has its own scan.
    const apply = { ...opts, apply: true };
    await reap(apply, {
      request: async (_path, init) =>
        init
          ? response({})
          : response({
              documents: [document(id)],
              nextPageToken: "other-mode",
            }),
      now: () => now,
    });
    const recovered: string[] = [];
    const restart: Request = async (path) => {
      recovered.push(path);
      return response({ documents: [] });
    };
    expect(
      await reap(
        { ...opts, resetCursor: true },
        { request: restart, now: () => now },
      ),
    ).toMatchObject({ scanned: 0, budgetStopped: true });
    expect(recovered).toHaveLength(0);
    const data = JSON.parse(await readFile(opts.state, "utf8"));
    expect(Object.values(data.projects)).toEqual([
      { day: quotaDay(now), reads: 3, writes: 1 },
    ]);
    expect(Object.values(data.scans).sort()).toEqual(["", "other-mode"]);
    await reap(
      { ...opts, resetCursor: true },
      {
        request: restart,
        now: () => now + 86_400_000,
      },
    );
    expect(recovered).toHaveLength(1);
    expect(
      new URL("https://test.invalid" + recovered[0]).searchParams.has(
        "pageToken",
      ),
    ).toBe(false);
    expect((await stat(opts.state)).mode & 0o777).toBe(0o600);
  });

  it("the npm-style executable symlink runs help and rejects mixed targets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "burrow-reaper-bin-"));
    directories.push(dir);
    const bin = join(dir, "burrow-reaper");
    await symlink(
      new URL("../../scripts/burrow-reaper.mjs", import.meta.url).pathname,
      bin,
    );
    const env = { ...process.env, CI: "" };
    const help = spawnSync(bin, ["--help"], { encoding: "utf8", env });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("burrow-reaper --project");
    expect(help.stdout).toContain("default deployment shares a collection");
    expect(help.stdout).toContain("--reset-cursor");
    const mixed = spawnSync(bin, ["--mixed"], { encoding: "utf8", env });
    expect(mixed.status).toBe(1);
    expect(mixed.stderr).toBe("FAIL mixed-collection-refused\n");
  });

  it("never makes an unconditional replacement or leaks server error messages", async () => {
    const request = vi.fn<Request>(async () =>
      response({ error: { status: "PERMISSION_DENIED", message: id } }, 403),
    );
    await expect(
      conditionalStub(request, "projects/p/databases/d", {
        update: { name: id, fields: {} },
        currentDocument: { updateTime: "" },
      }),
    ).rejects.toMatchObject({ code: "server-update-time-required" });
    expect(request).not.toHaveBeenCalled();
    const candidate = expiryCandidate(document(id), prefix, now);
    if (typeof candidate === "string") throw new Error("expected candidate");
    await expect(
      conditionalStub(request, "projects/p/databases/d", candidate),
    ).rejects.toThrow("request-failed");
    const cli = spawnSync(
      process.execPath,
      ["scripts/burrow-reaper.mjs", "--project", id, "--mixed"],
      { encoding: "utf8", env: { ...process.env, CI: "" } },
    );
    expect(cli.status).toBe(1);
    expect(cli.stderr).toBe("FAIL mixed-collection-refused\n");
    expect(cli.stderr).not.toContain(id);
  });
});
