// The Burrow demo: a theme and a text draft that follow the user across devices.
// The draft uses the localStorage-compatible facade; everything else uses the async API.
(async () => {
  const $ = (id) => document.getElementById(id);
  const say = (text) => {
    $("message").textContent = text;
  };

  const store = await Burrow.burrow({ app: "burrow-demo" });
  const s = store.storage; // drop-in for localStorage

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

  // Draft: saved on every keystroke; the facade write is synchronous and persisted behind the scenes.
  const draft = $("draft");
  draft.value = s.getItem("draft") ?? "";
  draft.addEventListener("input", () => s.setItem("draft", draft.value));

  // Changes from another device or tab.
  store.onChanged.addListener(({ changes }) => {
    if ("theme" in changes) applyTheme(changes.theme.newValue);
    if ("draft" in changes && document.activeElement !== draft)
      draft.value = changes.draft.newValue ?? "";
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
    if (error?.code === "decrypt-failed")
      say(
        "This device cannot read the synced data. Link it again with your code.",
      );
    debug();
  };
  store.onStatus.addListener(showStatus);
  showStatus({ status: store.status });
  setInterval(debug, 5000);

  // KP-14: a low-key nudge once there is something worth keeping.
  store.onUnprotected.addListener(() =>
    say(
      "Tip: create a backup with a key, or keep your storage token, so you can get this back on another device.",
    ),
  );

  // The storage token in use, always on screen, with where it came from.
  const SOURCES = {
    generated: "generated on this device",
    code: "pasted or typed in",
    link: "opened from a link",
    passkey: "restored from your passkey",
  };
  const when = (ms) => (ms ? ` · ${new Date(ms).toLocaleString()}` : "");
  const describeToken = ({ source, remembered, since }) => {
    const how =
      SOURCES[source] ??
      (source === "unknown" ? "" : `restored by “${source}”`);
    if (!remembered)
      return (
        how.charAt(0).toUpperCase() +
        how.slice(1) +
        (source === "generated" ? " (new)" : "") +
        when(since)
      );
    return (
      (how
        ? `Remembered by this browser; originally ${how}`
        : "Remembered by this browser") + when(since)
    );
  };
  const showToken = async () => {
    const code = await store.exportCode();
    $("code").textContent = code;
    const link = new URL(location.href);
    link.hash = "burrow=" + code;
    $("code-link").href = link.href;
    $("token-source").textContent = describeToken(store.token);
    $("token-backup").textContent =
      store.protection === "passkey"
        ? "Yes, in a passkey"
        : "None yet. Create one below, or keep the token yourself.";
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
  $("passkey").addEventListener("click", async () => {
    try {
      await store.protect("passkey");
      say(
        "Backup created. On another device, go to “Link to existing backup” and choose “Use my passkey”.",
      );
      await showToken();
    } catch (e) {
      say(
        e.code === "prf-unsupported"
          ? "This browser cannot use passkeys for this. Keep your storage token instead."
          : `Passkey not added (${e.code ?? e.name}).`,
      );
    }
    debug();
  });

  // Linking (API-7)
  const link = async (options) => {
    try {
      await store.link(options);
      say("Linked. Your data is here.");
    } catch (e) {
      if (
        e.code === "would-orphan" &&
        confirm(
          "This device has changes that are not synced yet. Discard them and link anyway?",
        )
      ) {
        return link({ ...options, discardLocal: true });
      }
      say(
        e.code === "bad-code"
          ? "That token is not right. Check it and try again."
          : e.code === "no-provider"
            ? "No passkey was used."
            : `Could not link (${e.code ?? e.name}).`,
      );
    }
    draft.value = s.getItem("draft") ?? "";
    applyTheme(s.getItem("theme"));
    await showToken();
  };
  $("link-form").addEventListener("submit", (e) => {
    e.preventDefault();
    link({ code: $("link-code").value });
  });
  $("link-passkey").addEventListener("click", () =>
    link({ provider: "passkey" }),
  );

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

  // Forget the token on this device, like logging out (API-8). The next visit starts a new token.
  $("forget").addEventListener("click", async () => {
    if (
      !confirm(
        "Forget the storage token on this device? Your data stays in the backup; keep the token or a passkey to get it back.",
      )
    )
      return;
    try {
      await store.unlink();
    } catch (e) {
      if (
        e.code !== "would-orphan" ||
        !confirm(
          "This device has changes that are not synced yet. Discard them and forget anyway?",
        )
      ) {
        say(
          e.code === "would-orphan"
            ? "Kept this device as it was."
            : `Could not forget this device (${e.code ?? e.name}).`,
        );
        return;
      }
      try {
        await store.unlink({ discardLocal: true });
      } catch (e2) {
        say(`Could not forget this device (${e2.code ?? e2.name}).`);
        return;
      }
    }
    location.reload();
  });

  await showToken();
  document.body.dataset.ready = "true";
})();
