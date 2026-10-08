import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

let root: string;
const servers: ChildProcess[] = [];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "burrow-serve-"));
  for (const dir of ["scripts", "demo", "site", "dist"])
    await mkdir(join(root, dir));
  await copyFile(
    new URL("../../scripts/serve.mjs", import.meta.url),
    join(root, "scripts/serve.mjs"),
  );
  for (const dir of ["demo", "site"])
    await copyFile(
      new URL("../../demo/index.html", import.meta.url),
      join(root, dir, "index.html"),
    );
  await writeFile(join(root, "dist/burrow.min.js"), "// bundle fixture\n");
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }),
  );
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function serve(emulator?: string): Promise<string> {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = (listener.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) };
  delete env.FIRESTORE_EMULATOR_HOST;
  if (emulator !== undefined) env.FIRESTORE_EMULATOR_HOST = emulator;
  const child = spawn(process.execPath, [join(root, "scripts/serve.mjs")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  servers.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`serve.mjs exited before listening: ${code}`)),
    );
    child.stdout!.on("data", (chunk) => {
      if (chunk.toString().includes("serving ")) resolve();
    });
  });
  return `http://127.0.0.1:${port}`;
}

it.each([undefined, "", "127.0.0.1:9199"])(
  "#40 local demo and assembled site use the emulator with host %s",
  async (emulator) => {
    const url = await serve(emulator);
    const port = emulator ? 9199 : 8080;
    for (const page of ["/demo/", "/demo/index.html", "/site/"])
      await expectEmulatorPage(url + page, port);
    const bundle = await fetch(url + "/demo/burrow.min.js");
    expect(bundle.status).toBe(200);
    expect(await bundle.text()).toBe("// bundle fixture\n");
  },
);

async function expectEmulatorPage(url: string, port: number) {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  const html = await response.text();
  const config = html.match(
    /<meta\s+name="burrow-firestore"\s+content='([^']*)'/,
  )?.[1];
  expect(config).toBeDefined();
  expect(JSON.parse(config!)).toEqual({
    apiKey: "emulator",
    projectId: "burrow-rules-test",
    appId: "1:0:web:0",
    emulator: { host: "127.0.0.1", port },
  });
  expect(html).toContain(`connect-src 'self' http://127.0.0.1:${port}`);
  expect(html).not.toContain("burrow-storage-shared");
  expect(html).not.toContain("https://firestore.googleapis.com");
}

it("#40 local serving refuses a page whose live config cannot be replaced", async () => {
  await writeFile(
    join(root, "demo/malformed.html"),
    '<meta name="burrow-firestore" content="{}">',
  );
  const url = await serve();
  const response = await fetch(url + "/demo/malformed.html");
  expect(response.status).toBe(500);
  expect(await response.text()).toContain("cannot point");
});
