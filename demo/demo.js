// The Burrow demo: a theme and a text draft that follow the user across devices.
// The draft uses the localStorage-compatible facade; everything else uses the async API.
(async () => {
  const $ = (id) => document.getElementById(id);
  const say = (text) => { $("message").textContent = text; };

  const store = await Burrow.burrow({ app: "burrow-demo" });
  const s = store.storage; // drop-in for localStorage

  // Theme
  const applyTheme = (theme) => {
    document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
    $("theme").setAttribute("aria-pressed", String(theme === "dark"));
  };
  applyTheme(s.getItem("theme"));
  $("theme").addEventListener("click", () => {
    s.setItem("theme", s.getItem("theme") === "dark" ? "light" : "dark");
    applyTheme(s.getItem("theme"));
  });

  // Draft: saved on every keystroke; the facade write is synchronous and persisted behind the scenes.
  const draft = $("draft");
  draft.value = s.getItem("draft") ?? "";
  draft.addEventListener("input", () => s.setItem("draft", draft.value));

  // Changes from another device or tab.
  store.onChanged.addListener(({ changes }) => {
    if ("theme" in changes) applyTheme(changes.theme.newValue);
    if ("draft" in changes && document.activeElement !== draft) draft.value = changes.draft.newValue ?? "";
    debug();
  });

  // Status badge and debug panel (ERR-4).
  const badge = $("status");
  const debug = () => { $("debug").textContent = JSON.stringify(store.inspect(), null, 2); };
  const showStatus = ({ status, error }) => {
    badge.dataset.status = status;
    badge.textContent = error?.code === "quota" ? "sync paused (daily limit)" : status === "idle" ? "synced" : status;
    if (error?.code === "decrypt-failed") say("This device cannot read the synced data. Link it again with your code.");
    debug();
  };
  store.onStatus.addListener(showStatus);
  showStatus({ status: store.status });
  setInterval(debug, 5000);

  // KP-14: a low-key nudge once there is something worth keeping.
  store.onUnprotected.addListener(() => say("Tip: show your storage token or create a backup with a key so you can get this back on another device."));

  // Storage token (the sync code of KP-11, KP-13)
  $("show-code").addEventListener("click", async () => {
    const code = await store.exportCode();
    $("code").textContent = code;
    const link = new URL(location.href);
    link.hash = "burrow=" + code;
    $("code-link").href = link.href;
    $("code-box").hidden = false;
    debug();
  });

  // Passkey (KP-5)
  $("passkey").addEventListener("click", async () => {
    try {
      await store.protect("passkey");
      say("Backup created. On another device, go to “Link to existing backup” and choose “Use my passkey”.");
    } catch (e) {
      say(e.code === "prf-unsupported" ? "This browser cannot use passkeys for this. Keep your storage token instead." : `Passkey not added (${e.code ?? e.name}).`);
    }
    debug();
  });

  // Linking (API-7)
  const link = async (options) => {
    try {
      await store.link(options);
      say("Linked. Your data is here.");
    } catch (e) {
      if (e.code === "would-orphan" && confirm("This device has changes that are not synced yet. Discard them and link anyway?")) {
        return link({ ...options, discardLocal: true });
      }
      say(e.code === "bad-code" ? "That token is not right. Check it and try again." : e.code === "no-provider" ? "No passkey was used." : `Could not link (${e.code ?? e.name}).`);
    }
    draft.value = s.getItem("draft") ?? "";
    applyTheme(s.getItem("theme"));
    debug();
  };
  $("link-form").addEventListener("submit", (e) => { e.preventDefault(); link({ code: $("link-code").value }); });
  $("link-passkey").addEventListener("click", () => link({ provider: "passkey" }));

  // Export (graceful failure: the user can always take their data by hand).
  $("export").addEventListener("click", async () => {
    const blob = new Blob([await store.exportJSON()], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "burrow-demo.json" });
    a.click();
    URL.revokeObjectURL(a.href);
  });

  document.body.dataset.ready = "true";
})();
