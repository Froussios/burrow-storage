#!/usr/bin/env node
// Typechecks the code examples in the user-facing docs against the built
// declarations (dist/*.d.ts), so README and guide snippets cannot drift from
// src/types.ts. Run after `npm run build`.
//
// Each ```ts / ```js block in the files below is classified:
//   - usage example            → compiled as a module (js blocks with JS-level
//     strictness)
//   - member signature listing → must match the same members of BurrowArea
//     exactly
//   - interface/type/class listing → each declared name must match the exported
//     type of that name (a `declare class` listing only has to be a subset of
//     the real class)
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Isolate concurrent checks, including checkouts sharing installed
// dependencies.
const out = mkdtempSync(join(tmpdir(), "burrow-doc-snippets-"));
process.on("exit", () => rmSync(out, { recursive: true, force: true }));
const DOCS = [
  "README.md",
  "docs/api.md",
  "docs/sync-and-tokens.md",
  "docs/storage-standards.md",
  "docs/firestore-setup.md",
  "docs/extending.md",
];

// Type names exported by burrow-storage that listings may reference without
// declaring.
const EXPORTED = [
  "Envelope",
  "Manifest",
  "ManifestEntry",
  "Item",
  "BackendCapabilities",
  "Backend",
  "BackendConfig",
  "BackendFactory",
  "BurrowConfig",
  "Status",
  "TokenSource",
  "TokenInfo",
  "StorageChanges",
  "ChangedEvent",
  "StatusEvent",
  "Inspection",
  "GetKeys",
  "BurrowArea",
  "BurrowError",
  "BackendError",
  "BurrowErrorCode",
  "BackendErrorCode",
  "MemoryBackendOptions",
];
// Generic exports, aliased with their parameters.
const GENERIC = { BurrowEvent: "T" };
// Type names exported by burrow-storage/firestore and burrow-storage/passkey.
const FIRESTORE = ["FirestoreConfig"];
const PASSKEY = ["PasskeyBackupOptions", "PasskeyBackup"];

// Free names the usage examples treat as page context.
const CONTEXT = `
declare const applyTheme: (t: unknown) => void;
declare const badge: HTMLElement;
declare const say: (s: string) => void;
declare const showBanner: (s: string) => void;
declare const input: HTMLInputElement;
declare const tokenEl: HTMLElement;
declare const text: string;
declare const myVault: {
  put(token: string): Promise<void>;
  get(): Promise<string | null>;
};
`;

const firstLine = (body) =>
  body.split("\n").find((l) => l.trim() && !l.trim().startsWith("//")) ?? "";

function usage(body) {
  let pre = "";
  if (!/^\s*import /m.test(body)) {
    pre +=
      'import { burrow, MemoryBackend, BurrowError } from "burrow-storage";\n';
    pre += 'import { FirestoreBackend } from "burrow-storage/firestore";\n';
    pre += 'import { passkeyBackup } from "burrow-storage/passkey";\n';
  }
  if (!/\b(const|let)\s+store\b/.test(body))
    pre += 'declare const store: import("burrow-storage").BurrowArea;\n';
  if (!/\b(const|let)\s+storage\b/.test(body))
    pre += "declare const storage: Storage;\n";
  return `${pre}${CONTEXT}\nexport {};\n${body}`;
}

function members(body) {
  return `import type { BurrowArea, GetKeys, TokenInfo, Inspection } from "burrow-storage";
interface Doc {
${body}}
type Missing = Exclude<keyof Doc, keyof BurrowArea>;
const none: Missing[] = [];
type K = keyof Doc & keyof BurrowArea;
const a: Pick<BurrowArea, K> = null! as Doc;
const b: Doc = null! as Pick<BurrowArea, K>;
export { none, a, b };
`;
}

function declarations(body) {
  const declared = [
    ...body.matchAll(/^(?:export\s+)?(?:interface|type)\s+(\w+)/gm),
  ].map((m) => m[1]);
  const classes = [...body.matchAll(/^declare\s+class\s+(\w+)/gm)].map(
    (m) => m[1],
  );
  const all = [...declared, ...classes];
  const aliases = [
    ...EXPORTED.filter((n) => !all.includes(n)).map(
      (n) => `  type ${n} = R.${n};`,
    ),
    ...Object.entries(GENERIC)
      .filter(([n]) => !all.includes(n))
      .map(([n, p]) => `  type ${n}<${p}> = R.${n}<${p}>;`),
    ...FIRESTORE.filter((n) => !all.includes(n)).map(
      (n) => `  type ${n} = F.${n};`,
    ),
    ...PASSKEY.filter((n) => !all.includes(n)).map(
      (n) => `  type ${n} = P.${n};`,
    ),
  ].join("\n");
  const real = (n) =>
    (FIRESTORE.includes(n)
      ? `F.${n}`
      : PASSKEY.includes(n)
        ? `P.${n}`
        : `R.${n}`) + (GENERIC[n] ? "<unknown>" : "");
  const doc = (n) => `D.${n}` + (GENERIC[n] ? "<unknown>" : "");
  const known = (n) =>
    EXPORTED.includes(n) ||
    FIRESTORE.includes(n) ||
    PASSKEY.includes(n) ||
    n in GENERIC;
  // Interfaces and types are compared structurally in both directions; a
  // documented class only has to list members the real class has (its private
  // fields cannot be written down).
  const checks = [
    ...declared
      .filter(known)
      .map(
        (n) =>
          `const a_${n}: ${real(n)} = null! as unknown as ${doc(n)};\nconst b_${n}: ${doc(n)} = null! as unknown as ${real(n)};\nexport { a_${n}, b_${n} };`,
      ),
    ...classes
      .filter(known)
      .map(
        (n) =>
          `const b_${n}: ${doc(n)} = null! as unknown as ${real(n)};\nexport { b_${n} };`,
      ),
  ];
  return `import type * as R from "burrow-storage";
import type * as F from "burrow-storage/firestore";
import type * as P from "burrow-storage/passkey";
namespace D {
${aliases}
${body.replace(/^(interface|type)\s/gm, "export $1 ").replace(/^declare\s+class\s/gm, "export declare class ")}
}
${checks.join("\n")}
export {};
`;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "ts"), { recursive: true });
mkdirSync(join(out, "js"), { recursive: true });
const where = {};
let n = 0;
for (const file of DOCS) {
  const text = readFileSync(join(root, file), "utf8");
  for (const m of text.matchAll(/```(ts|js)\n([\s\S]*?)```/g)) {
    const [, lang, body] = m;
    const line = text.slice(0, m.index).split("\n").length;
    const head = firstLine(body).trim();
    // Examples that import from the repository itself (e.g. the conformance
    // suite) are repo-internal.
    if (/from\s+["']\.\.?\//.test(body)) continue;
    let kind, code;
    if (/^(interface|type|declare class)\s/.test(head)) {
      kind = "ts";
      code = declarations(body);
    } else if (
      /^(readonly\s|\w+\??\(.*\):)/.test(head) &&
      !/=/.test(head.split(":")[0])
    ) {
      kind = "ts";
      code = members(body);
    } else {
      kind = lang;
      code = usage(body);
    }
    const name = `s${String(++n).padStart(2, "0")}.ts`;
    writeFileSync(join(out, kind, name), code);
    where[`${kind}/${name}`] = `${file}:${line}`;
  }
}

const paths = {
  "burrow-storage": [join(root, "dist/index.d.ts")],
  "burrow-storage/firestore": [join(root, "dist/firestore.d.ts")],
  "burrow-storage/passkey": [join(root, "dist/passkey.d.ts")],
};
const base = {
  target: "ES2022",
  module: "ESNext",
  moduleResolution: "Bundler",
  lib: ["ES2022", "DOM", "DOM.Iterable"],
  noEmit: true,
  skipLibCheck: true,
  strict: true,
  noImplicitAny: false,
  paths,
};
writeFileSync(
  join(out, "tsconfig.ts.json"),
  JSON.stringify({ compilerOptions: base, include: ["ts/*.ts"] }),
);
// ```js examples are JavaScript: no strict null checks, catch variables are
// `any`.
writeFileSync(
  join(out, "tsconfig.js.json"),
  JSON.stringify({
    compilerOptions: {
      ...base,
      strictNullChecks: false,
      useUnknownInCatchVariables: false,
    },
    include: ["js/*.ts"],
  }),
);

const tsc = join(root, "node_modules/typescript/bin/tsc");
let failed = false;
for (const cfg of ["tsconfig.ts.json", "tsconfig.js.json"]) {
  const r = spawnSync(process.execPath, [tsc, "-p", join(out, cfg)], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    failed = true;
    for (const l of r.stdout.split("\n").filter(Boolean)) {
      const m = l.match(/(ts|js)[/\\](s\d+\.ts)\((\d+),/);
      console.error(m ? `${where[`${m[1]}/${m[2]}`]} → ${l}` : l);
    }
  }
}
if (failed) {
  console.error("doc snippets: FAILED");
  process.exit(1);
}
console.log(`doc snippets: ${n} blocks typecheck against dist/*.d.ts`);
