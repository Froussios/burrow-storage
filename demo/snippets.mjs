// Short API examples next to their controls. Only static scenario metadata
// enters these strings, never a visitor's token or content.
export function demoSnippets({ app, offline }) {
  const quotedApp = JSON.stringify(app);
  const key = JSON.stringify(app + ":token");
  const connectedStore = offline ? "await Burrow.offline(core)" : "core";
  const connect = `const core = await Burrow.burrow({
  app: ${quotedApp},
  backend: Burrow.readBackendConfig(),
  token,
});
const store = ${connectedStore};`;
  const passkey = `const passkey = Burrow.passkeyToken({
  app: ${quotedApp},
});`;
  const remember = (flow) => ({
    id: `remember-${flow}`,
    title: "Remember token on this device",
    description:
      "Demo-owned storage after connecting. The in-memory session holds the token. Saving can fail; keep the token and report the failure.",
    snippets: [
      {
        label: "Save after opting in",
        code: `const key = ${key};
if (document.getElementById("remember-${flow}").checked) {
  localStorage.setItem(key, JSON.stringify({
    token: session.token,
    source: session.source,
    since: Date.now(),
  }));
}`,
      },
      {
        label: "Restore on the next visit",
        code: `const key = ${key};
let saved;
try {
  saved = JSON.parse(localStorage.getItem(key) ?? "null");
} catch { saved = null; }
if (saved?.token) {
  const core = await Burrow.burrow({
    app: ${quotedApp},
    backend: Burrow.readBackendConfig(),
    token: saved.token,
  });
  const store = ${connectedStore};
}`,
      },
    ],
  });
  const actions = [
    {
      id: "passkey-get",
      title: "Get token from passkey",
      description:
        "Call from the button click. PRF reproduces the app's token; no token is fetched from Firebase. Handle cancelled/prf-unsupported without creating a new identity.",
      code: `${passkey}
if (!(await passkey.available())) {
  throw new Error("Passkey PRF unavailable");
}
const token = await passkey.get();
${connect}`,
    },
    {
      id: "paste-token",
      title: "Connect with a saved token",
      description:
        "The core validates the pasted token. A bad-token error leaves setup incomplete.",
      code: `const token = document.getElementById("token-input").value;
${connect}`,
    },
    {
      id: "passkey-create",
      title: "Create passkey and token",
      description:
        "Call from the button click. Creates a new credential and app token; this is not a backup of an existing arbitrary token.",
      code: `${passkey}
if (!(await passkey.available())) {
  throw new Error("Passkey PRF unavailable");
}
const token = await passkey.create();
${connect}`,
    },
    {
      id: "token-create",
      title: "Create token only",
      description:
        "A random token, without a passkey. Keep it yourself unless you explicitly select remembering.",
      code: `const token = await Burrow.generateToken();
${connect}`,
    },
    remember("returning"),
    remember("new"),
    {
      id: "theme",
      title: "Change the theme",
      description: "Uses the store returned by the chosen connection action.",
      code: `const theme = document.documentElement.dataset.theme === "dark"
  ? "light" : "dark";
await store.set({ theme });
document.documentElement.dataset.theme = theme;`,
    },
    {
      id: "content",
      title: "Read and save the draft",
      description: offline
        ? "Use the connected store. The offline wrapper keeps accepted writes in its plaintext copy and syncs later; remote failures are status."
        : "Use the connected store. Core reads/writes require the backend and reject on failure; there is no durable offline queue.",
      snippets: [
        {
          label: "Read",
          code: `const data = await store.get("draft");
document.getElementById("draft").value =
  typeof data.draft === "string" ? data.draft : "";`,
        },
        {
          label: "Save",
          code: `await store.set({
  draft: document.getElementById("draft").value,
});`,
        },
      ],
    },
    {
      id: "signout",
      title: "Sign out",
      description:
        "After pending editor saves finish, close the store and remove the demo's saved token. The demo also clears its in-memory session/display and disables the editor. Report failures instead of claiming removal succeeded.",
      code: `${
        offline
          ? `try {
  await store.forget();
} catch (error) {
  if (error.code !== "would-orphan") throw error;
  if (!confirm("Discard unsynced changes?")) throw error;
  await store.forget({ discardLocal: true });
}`
          : "store.close();"
      }
localStorage.removeItem(${key});`,
    },
  ];
  return { actions };
}
