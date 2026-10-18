// The Burrow demo: a theme and a text draft that follow the user across
// devices. The draft uses the localStorage-compatible facade; everything else
// uses the async API.
(async () => {
  const $ = (id) => document.getElementById(id);
  const say = (text) => {
    $("message").textContent = text;
  };

  const store = await Burrow.burrow({ app: "burrow-demo" });
  const s = store.storage; // drop-in for localStorage
  // The token's passkey backup lives outside the store
  // (burrow-storage/passkey).
  const backup = Burrow.passkeyBackup({ userName: "burrow-demo" });

  // Theme
  const applyTheme = (theme) => {
    document.documentElement.dataset.theme =
      theme === "dark" ? "dark" : "light";
    $("theme").setAttribute("aria-pressed", String(theme === "dark"));
  };
  applyTheme(s.getItem("theme"));
  $("theme").addEventListener("click", () => {
    s.setItem("theme", s.getItem("theme") === "dark" ? "light" : "dark");
    applyTheme(s.getItem("theme"));
  });

  // Draft: saved on every keystroke; the facade write is synchronous and
  // persisted behind the scenes.
  const draft = $("draft");
  draft.value = s.getItem("draft") ?? "";
  draft.addEventListener("input", () => s.setItem("draft", draft.value));

  // Changes from another device or tab.
  store.onChanged.addListener(({ changes }) => {
    if ("theme" in changes) applyTheme(changes.theme.newValue);
    if ("draft" in changes && document.activeElement !== draft)
      draft.value = changes.draft.newValue ?? "";
    if ("backup" in changes) showBackup();
    debug();
  });

  // Status badge and debug panel (ERR-4).
  const badge = $("status");
  const debug = () => {
    $("debug").textContent = JSON.stringify(store.inspect(), null, 2);
  };
  const showStatus = ({ status, error }) => {
    badge.dataset.status = status;
    badge.textContent =
      error?.code === "quota"
        ? "sync paused (daily limit)"
        : status === "idle"
          ? "synced"
          : status;
    if (error?.code === "expired")
      say(
        "Synced content expired. Local data is kept and still editable. Export it before choosing a fresh token.",
      );
    if (error?.code === "decrypt-failed")
      say(
        "This device cannot read the synced data. Link it again with your storage token.",
      );
    debug();
  };
  store.onStatus.addListener(showStatus);
  showStatus({ status: store.status });
  setInterval(debug, 5000);

  // Whether the token has a passkey backup is the demo's own record, kept in
  // the store under "backup" so it travels with the data to every device.
  const showBackup = () => {
    $("token-backup").textContent =
      s.getItem("backup") === "passkey"
        ? "Yes, in a passkey."
        : s.getItem("backup") === "unknown"
          ? "Not confirmed. Keep the storage token or try saving again."
          : "None yet. Create one below, or keep the token yourself.";
  };

  // A low-key nudge, once per visit, when there is something worth keeping and
  // the token exists only on this device.
  let nudged = false;
  store.onChanged.addListener(({ source }) => {
    if (nudged || source !== "local") return;
    if (store.token.source !== "generated" || s.getItem("backup")) return;
    nudged = true;
    say(
      "Tip: create a backup with a key, or keep your storage token, so you can get this back on another device.",
    );
  });

  // The storage token in use, always on screen, with where it came from.
  const SOURCES = {
    generated: "generated on this device",
    token: "pasted or typed in",
    passkey: "restored from your passkey",
  };
  const when = (ms) => ` · ${new Date(ms).toLocaleString()}`;
  const describeToken = ({ source, remembered, since }) => {
    const how = SOURCES[source] ?? `restored by “${source}”`;
    if (!remembered)
      return (
        how.charAt(0).toUpperCase() +
        how.slice(1) +
        (source === "generated" ? " (new)" : "") +
        when(since)
      );
    return `Remembered by this browser; originally ${how}` + when(since);
  };
  const showToken = async () => {
    $("code").textContent = await store.exportToken();
    $("token-source").textContent = describeToken(store.token);
    showBackup();
    debug();
  };
  store.onToken.addListener(showToken);
  $("copy-token").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("code").textContent);
      say("Token copied.");
    } catch {
      say("Could not copy. Select the token and copy it by hand.");
    }
  });

  // Passkey (KP-5)
  const NO_PASSKEY =
    "This browser cannot use passkeys for this. Keep your storage token instead.";
  let saving = false;
  const tokenControls = document.querySelectorAll(
    "#passkey, #forget, #link-passkey, #link-form button[type=submit]",
  );
  $("passkey").addEventListener("click", async () => {
    if (saving) return;
    saving = true;
    for (const control of tokenControls) control.disabled = true;
    try {
      if (!(await backup.available())) return say(NO_PASSKEY);
      const token = await store.exportToken();
      // Persist uncertainty before credential replacement, including if the
      // user closes the page while the authenticator or keyslot write waits.
      await store.set({ backup: "unknown" });
      await backup.save(token);
      // Another tab can change the identity while the passkey prompt is open.
      if ((await store.exportToken()) !== token)
        return say("Passkey backup created for the previous storage token.");
      await store.set({ backup: "passkey" });
      say(
        "Backup created. On another device, go to “Link to existing backup” and choose “Use my passkey”.",
      );
    } catch (e) {
      say(
        e.code === "prf-unsupported"
          ? NO_PASSKEY
          : e.code === "cancelled"
            ? "Passkey backup was not saved. Keep the storage token or try again."
            : `Passkey backup was not saved (${e.code ?? e.name}). Keep the storage token or try again.`,
      );
    } finally {
      saving = false;
      for (const control of tokenControls) control.disabled = false;
      showBackup();
      debug();
    }
  });

  // Confirm only when the library reports current data or unsynced changes.
  // Retry with the same options, including a token restored by a passkey.
  const changeToken = async (change, options, action) => {
    for (;;) {
      try {
        await change(options);
        return true;
      } catch (e) {
        const prompt =
          e.code === "would-orphan"
            ? `This device has changes that are not synced yet. Discard them and ${action} anyway?`
            : e.code === "would-replace"
              ? action === "link"
                ? "Replace this device's storage token and data? Keep the current token or a passkey so you can return to them."
                : "Forget this device's storage token and data? Keep the token or a passkey so you can return to them."
              : null;
        if (!prompt) throw e;
        if (!confirm(prompt)) return false;
        options = {
          ...options,
          ...(e.code === "would-orphan"
            ? { discardLocal: true }
            : { replace: true }),
        };
      }
    }
  };

  // Linking (API-7)
  const link = async (options) => {
    if (saving) return;
    try {
      if (!(await changeToken((o) => store.link(o), options, "link")))
        return say("Kept this device as it was.");
      say("Linked. Your data is here.");
    } catch (e) {
      say(
        e.code === "bad-token"
          ? "That token is not right. Check it and try again."
          : `Could not link (${e.code ?? e.name}).`,
      );
    }
    draft.value = s.getItem("draft") ?? "";
    applyTheme(s.getItem("theme"));
    await showToken();
  };
  $("link-form").addEventListener("submit", (e) => {
    e.preventDefault();
    link({ token: $("link-code").value });
  });
  // KP-6: confirmation retries reuse the token from one passkey prompt.
  $("link-passkey").addEventListener("click", async () => {
    let token;
    try {
      token = await backup.restore();
    } catch (e) {
      return say(
        e.code === "prf-unsupported"
          ? NO_PASSKEY
          : `Could not use the passkey (${e.code ?? e.name}).`,
      );
    }
    if (!token) return say("No passkey backup was used.");
    await link({ token, source: "passkey" });
  });

  // Export (graceful failure: the user can always take their data by hand).
  $("export").addEventListener("click", async () => {
    const blob = new Blob([await store.exportJSON()], {
      type: "application/json",
    });
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(blob),
      download: "burrow-demo.json",
    });
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // Forget the token on this device, like logging out (API-8). The next visit
  // starts a new token.
  $("forget").addEventListener("click", async () => {
    if (saving) return;
    try {
      if (!(await changeToken((o) => store.unlink(o), {}, "forget")))
        return say("Kept this device as it was.");
    } catch (e) {
      return say(`Could not forget this device (${e.code ?? e.name}).`);
    }
    location.reload();
  });

  await showToken();
  document.body.dataset.ready = "true";
})();
