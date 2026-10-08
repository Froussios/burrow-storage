import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  await writeFile(
    join(root, "demo/malformed.html"),
    '<meta name="burrow-firestore" content="{}">',
  );
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

async function serve(options: { emulator?: string; firestore?: string } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: "0" };
  delete env.FIRESTORE_EMULATOR_HOST;
  delete env.BURROW_FIRESTORE;
  if (options.emulator !== undefined)
    env.FIRESTORE_EMULATOR_HOST = options.emulator;
  if (options.firestore !== undefined) env.BURROW_FIRESTORE = options.firestore;
  const child = spawn(process.execPath, [join(root, "scripts/serve.mjs")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  servers.push(child);
  let errors = "";
  child.stderr!.on("data", (chunk) => (errors += chunk.toString()));
  return new Promise<string>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(
        new Error(`serve.mjs exited before listening: ${code}: ${errors}`),
      ),
    );
    child.stdout!.on("data", (chunk) => {
      const port = chunk.toString().match(/http:\/\/localhost:(\d+)/)?.[1];
      if (port) resolve(`http://127.0.0.1:${port}`);
    });
  });
}

it.each([undefined, "", "127.0.0.1:9199"])(
  "#40 local demo and assembled site use the emulator with host %s",
  async (emulator) => {
    const url = await serve({ emulator });
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
  expect(readConfig(html)).toEqual({
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
  const url = await serve();
  const response = await fetch(url + "/demo/malformed.html");
  expect(response.status).toBe(500);
  expect(await response.text()).toContain("cannot configure");
});

const project = {
  apiKey: "developer-key",
  projectId: "developer-preprod",
  appId: "1:123:web:abc",
};

it("#40 explicit BURROW_FIRESTORE config selects the developer's cloud project", async () => {
  const url = await serve({
    firestore: JSON.stringify({
      ...project,
      authDomain: "developer-preprod.firebaseapp.com",
    }),
  });
  for (const page of ["/demo/", "/site/"]) {
    const response = await fetch(url + page);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(readConfig(html)).toEqual(project);
    expect(html).toContain(
      "connect-src 'self' https://firestore.googleapis.com",
    );
    expect(html).not.toContain("burrow-storage-shared");
    expect(html).not.toContain("http://127.0.0.1:8080");
  }
});

it("#40 explicit config preserves the collection and safely escapes attribute values", async () => {
  const config = { ...project, collection: "preprod's-$&-<items>&lt;" };
  const url = await serve({ firestore: JSON.stringify(config) });
  const html = await (await fetch(url + "/demo/")).text();
  expect(readConfig(html)).toEqual(config);
  expect(html).toContain("preprod&#39;s-$&amp;-&lt;items&gt;&amp;lt;");
});

it("#23 local serving accepts Firestore config without appId", async () => {
  const config = { apiKey: project.apiKey, projectId: project.projectId };
  const url = await serve({ firestore: JSON.stringify(config) });
  for (const page of ["/demo/", "/site/"]) {
    const html = await (await fetch(url + page)).text();
    expect(readConfig(html)).toEqual(config);
    expect(html).toContain(
      "connect-src 'self' https://firestore.googleapis.com",
    );
    expect(html).not.toContain("burrow-storage-shared");
  }
});

function readConfig(html: string) {
  const config = html.match(
    /<meta\s+name="burrow-firestore"\s+content='([^']*)'/,
  )?.[1];
  expect(config).toBeDefined();
  return JSON.parse(
    config!
      .replaceAll("&#39;", "'")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&"),
  );
}

it.each([
  "",
  " ",
  "not JSON",
  "null",
  "[]",
  "true",
  '"config"',
  "{}",
  JSON.stringify({ ...project, apiKey: 123 }),
  JSON.stringify({ ...project, projectId: " " }),
  JSON.stringify({ ...project, appId: " " }),
  JSON.stringify({ ...project, appId: 123 }),
  JSON.stringify({ ...project, collection: "" }),
  JSON.stringify({ ...project, emulator: { host: "localhost", port: 8080 } }),
])("#40 invalid explicit config %s stops local serving", async (firestore) => {
  const startup = serve({ firestore });
  await expect(startup).rejects.toThrow("BURROW_FIRESTORE");
  await expect(startup).rejects.toThrow("docs/firestore-setup.md");
});

it("#40 rejects simultaneous live and emulator targets", async () => {
  await expect(
    serve({ firestore: JSON.stringify(project), emulator: "127.0.0.1:9199" }),
  ).rejects.toThrow("Choose BURROW_FIRESTORE or FIRESTORE_EMULATOR_HOST");
});

it("#40 refuses unrewritable page config with an explicit cloud target too", async () => {
  const url = await serve({ firestore: JSON.stringify(project) });
  const response = await fetch(url + "/demo/malformed.html");
  expect(response.status).toBe(500);
});
