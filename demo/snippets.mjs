// The demo and docs:check consume the same examples. Tokens and user data
// never enter these strings; only the static scenario configuration does.
export function demoSnippets({ app, offline, title }) {
  const setup = `const app = ${JSON.stringify(app)};
// Reads the page's publishable burrow-firestore meta configuration.
const backend = Burrow.readBackendConfig();
if (!backend) throw new Error("Configure a storage backend first.");
const keptKey = ${JSON.stringify(app + ":token")};
const passkey = Burrow.passkeyToken({
  app,
  userName: app,
  displayName: ${JSON.stringify("Burrow v2 · " + title)},
});

let store;
let currentToken = null;
let tokenSource = null;
let pendingSave = Promise.resolve();
let unsaved = false;

async function connect(token, source = "pasted") {
  const core = await Burrow.burrow({ app, backend, token });
  const nextStore = ${offline ? "await Burrow.offline(core)" : "core"};
  store?.close();
  store = nextStore;
  currentToken = token; // Memory only; remembering is separate demo code.
  tokenSource = source;
  document.getElementById("code").textContent = token;
}`;

  const clickHandler = (id, body) =>
    `document.getElementById(${JSON.stringify(id)}).addEventListener("click", async () => {\n${body
      .split("\n")
      .map((line) => "  " + line)
      .join("\n")}\n});`;

  const passkeyAction = (method, source, checkbox) =>
    clickHandler(
      method === "get" ? "passkey-get" : "passkey-create",
      `const remember = document.getElementById(${JSON.stringify(checkbox)}).checked;
try {
  if (!(await passkey.available())) {
    throw new Error("Passkey PRF is unavailable. Use a storage token instead.");
  }
  // Run from the corresponding button's click handler: this prompts the user.
  const token = await passkey.${method}();
  await connect(token, ${JSON.stringify(source)});
  rememberToken(remember);
} catch (error) {
  document.getElementById("message").textContent =
    error.code === "cancelled" ? "No passkey was used." :
    error.code === "prf-unsupported" ? "Use a storage token instead." :
    error.message;
}`,
    );

  const actions = [
    {
      id: "remember-token",
      title: "Remember token on this device",
      description:
        "Optional demo code, used by either user flow after connecting. It stores the token unencrypted only when that flow's checkbox is checked. Neither library stores it.",
      code: `function rememberToken(remember) {
  if (!remember) return false;
  try {
    localStorage.setItem(keptKey, JSON.stringify({
      token: currentToken,
      source: tokenSource,
      since: Date.now(),
    }));
    return true;
  } catch {
    // The connected token is still in memory. Do not claim it was saved.
    document.getElementById("message").textContent =
      "Could not save your token. Write it down or keep it in a password manager.";
    return false;
  }
}`,
    },
    {
      id: "passkey-get",
      title: "Get token from passkey",
      description:
        "The chosen passkey reproduces this app's token via PRF. There is no token record or recovery keyslot to fetch from Firebase. Cancellation or missing PRF leaves setup incomplete.",
      code: passkeyAction("get", "passkey", "remember-returning"),
    },
    {
      id: "paste-token",
      title: "Connect with a token you saved",
      description:
        "The token is supplied to the core for validation and key derivation. Reading content later needs the selected scenario's backend, or its offline copy.",
      code: `document.getElementById("token-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.getElementById("token-input");
  const remember = document.getElementById("remember-returning").checked;
  try {
    await connect(input.value, "pasted");
    rememberToken(remember);
    input.value = "";
  } catch (error) {
    document.getElementById("message").textContent =
      error.code === "bad-token" ? "Check the token and try again." : error.message;
  }
});`,
    },
    {
      id: "passkey-create",
      title: "Create passkey and token",
      description:
        "Creates a new credential and derives its app-scoped token. This does not back up an arbitrary existing token. The token can be reproduced wherever that passkey and PRF are available.",
      code: passkeyAction("create", "new passkey", "remember-new"),
    },
    {
      id: "token-create",
      title: "Create token only",
      description:
        "Creates a random token, without a passkey. With remembering off it remains in memory; the user must keep a copy to restore access.",
      code: clickHandler(
        "new-token",
        `const remember = document.getElementById("remember-new").checked;
const token = await Burrow.generateToken();
await connect(token, "generated");
const saved = rememberToken(remember);
if (!remember || saved) {
  document.getElementById("message").textContent = saved
    ? "Saved on this device. Keep a separate copy."
    : "Write down this token or save it in your password manager before leaving.";
}`,
      ),
    },
    {
      id: "token-restore",
      title: "Restore a remembered token on the next visit",
      description:
        "Runs only for the demo-owned record saved by an earlier opt-in. Without a record, show the user choices. A restore failure never silently generates a replacement identity.",
      code: `let saved = null;
try {
  saved = JSON.parse(localStorage.getItem(keptKey) ?? "null");
} catch {
  // Missing, malformed, or unavailable storage: ask the user to connect.
}
if (typeof saved?.token === "string") {
  try {
    await connect(saved.token, saved.source);
    // No passkey prompt: the demo already has the saved token.
    // The offline scenario can restore its content copy without the backend.
  } catch (error) {
    if (error.code === "bad-token") {
      try { localStorage.removeItem(keptKey); } catch { /* storage unavailable */ }
    }
    // Preserve the token record for other failures so the user can retry.
    document.getElementById("message").textContent =
      "Could not restore the connection. Keep your token and retry.";
  }
}`,
    },
    {
      id: "content",
      title: "Read and save the draft",
      description: offline
        ? "Run after connect() succeeds. The same async API is used through the offline wrapper. Remote failures become status; accepted offline writes stay in the plaintext copy and sync later. Persistent local failures can still reject."
        : "Run after connect() succeeds. Core reads and writes go to the remote store and reject on failure. There is no durable offline queue. This example serializes saves; the demo also debounces typing.",
      code: `const draft = document.getElementById("draft");
try {
  const data = await store.get();
  draft.value = typeof data.draft === "string" ? data.draft : "";
} catch (error) {
  document.getElementById("message").textContent = error.message;
}
draft.addEventListener("input", () => {
  const value = draft.value;
  pendingSave = pendingSave.then(async () => {
    try {
      await store.set({ draft: value });
      unsaved = false;
    } catch (error) {
      unsaved = true;
      document.getElementById("message").textContent =
        "Not saved. Keep this edit and retry (" + (error.code ?? error.name) + ").";
    }
  });
});${
        offline
          ? `

store.onStatus.addListener(({ status, error }) => {
  document.getElementById("status").textContent = error?.code ?? status;
});
store.onChanged.addListener(({ changes }) => {
  const change = changes.draft;
  if (change && document.activeElement !== draft) {
    draft.value = typeof change.newValue === "string" ? change.newValue : "";
  }
});`
          : ""
      }`,
    },
    {
      id: "export",
      title: "Export the content as JSON",
      description:
        "Exports content, not the storage token. Core reads may fail while the backend is unreachable; the offline scenario can read its local copy.",
      code: clickHandler(
        "export",
        `try {
  const items = await store.get();
  const blob = new Blob([JSON.stringify({
    burrow: 1, app, exportedAt: new Date().toISOString(), items,
  }, null, 2)], { type: "application/json" });
  const link = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: ${JSON.stringify("burrow-demo-v2-" + (offline ? "offline" : "core") + ".json")},
  });
  link.click();
  URL.revokeObjectURL(link.href);
} catch (error) {
  document.getElementById("message").textContent = "Could not export: " + error.message;
}`,
      ),
    },
    {
      id: "signout",
      title: "Sign out and remove this device's token",
      description: offline
        ? "Wait for editor saves, ask before discarding queued changes, then clear the wrapper's content copy and the demo's token record. Remote content remains."
        : "Wait for editor saves and ask before abandoning a failed edit. Close the core and remove any demo-owned token record; remote content remains.",
      code: `async function signOut() {
  await pendingSave;
  if (unsaved && !confirm("Some edits were not saved. Discard them?")) return;
${
  offline
    ? `  try {
    await store.forget();
  } catch (error) {
    if (error.code !== "would-orphan") throw error;
    if (!confirm("Some changes have not synced. Discard them and sign out?")) return;
    await store.forget({ discardLocal: true });
  }`
    : "  store.close();"
}
  localStorage.removeItem(keptKey); // Report a storage failure; do not claim erasure.
  currentToken = null;
  tokenSource = null;
  // Clear the token display, show the user choices, and disable the editor.
}
document.getElementById("signout").addEventListener("click", async () => {
  try { await signOut(); }
  catch (error) {
    document.getElementById("message").textContent =
      "Could not finish signing out: " + error.message;
  }
});`,
    },
  ];
  return { setup, actions };
}
