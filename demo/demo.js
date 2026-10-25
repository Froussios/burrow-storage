// The Burrow demo: a theme and a text draft that follow the user across
// devices. It shows the two ways an app can hold the storage token
// (docs/user-journeys.md):
//   - "every visit": the core alone. The token is in this page's memory, the
//     data only in the store; a reload locks the page again.
//   - "stay signed in": this page keeps the token in localStorage itself and
//     opens the offline wrapper, which keeps a plaintext copy in IndexedDB.
// Burrow stores no token in either case; keeping one is the page's choice.
(async () => {
  const $ = (id) => document.getElementById(id);
  const say = (text) => {
    $("message").textContent = text;
  };
  const APP = "burrow-demo";
  // "Stay signed in": the page's own record of the token, in plaintext.
  const KEPT = "burrow-demo:token";
  const backend = Burrow.readBackendConfig();
  const passkey = Burrow.passkeyToken({ app: APP });

  /** The open store (core or offline wrapper) and how the page got it. */
  let store = null;
  let session = null;
  let status = "locked";
  // Draft edits not yet handed to the store, or on their way.
  let saving = 0;

  // The token as Burrow reads it: case, spaces and hyphens ignored, O read as
  // 0 and I/L as 1, shown in groups of four.
  const canonical = (token) =>
    token
      .toUpperCase()
      .replace(/[\s-]/g, "")
      .replace(/O/g, "0")
      .replace(/[IL]/g, "1")
      .replace(/(.{4})(?!$)/g, "$1-");

  const kept = () => {
    try {
      return JSON.parse(localStorage.getItem(KEPT) ?? "null");
    } catch {
      return null;
    }
  };

  // Status badge and debug panel.
  const badge = $("status");
  const debug = () => {
    $("debug").textContent = JSON.stringify(
      {
        mode: session?.mode ?? null,
        status,
        tokenKeptByPage: !!kept(),
      },
      null,
      2,
    );
  };
  const showStatus = (s = status, error) => {
    status = s;
    badge.dataset.status = s;
    badge.textContent =
      error?.code === "quota"
        ? "sync paused (daily limit)"
        : saving && s !== "locked"
          ? "saving…"
          : s === "idle"
            ? "synced"
            : s;
    if (error?.code === "expired")
      say(
        "Synced content expired. The copy on this device is kept and still editable. Export it before choosing a fresh token.",
      );
    if (error?.code === "decrypt-failed")
      say("This token cannot read the stored data. Check the token.");
    debug();
  };

  // Theme
  const applyTheme = (theme) => {
    document.documentElement.dataset.theme =
      theme === "dark" ? "dark" : "light";
    $("theme").setAttribute("aria-pressed", String(theme === "dark"));
  };
  const draft = $("draft");
  const render = (data) => {
    applyTheme(data.theme);
    if (document.activeElement !== draft) draft.value = data.draft ?? "";
  };

  /**
   * Write through the store. The core rejects when the store cannot be
   * reached; the offline wrapper keeps the write and reports status instead.
   */
  const save = async (items) => {
    if (!store) return;
    saving++;
    try {
      await store.set(items);
      saving--;
      showStatus(session.mode === "often" ? "idle" : store.status);
    } catch (e) {
      saving--;
      if (e.code === "closed") return locked();
      showStatus("offline", e);
      say(`Not saved: the store could not be reached (${e.code ?? e.name}).`);
    }
  };

  $("theme").addEventListener("click", () => {
    const next =
      document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    void save({ theme: next });
  });
  // Saved shortly after typing stops: with the core, every write is a network
  // round trip.
  let typing;
  const flush = () => {
    if (!typing) return;
    clearTimeout(typing);
    typing = undefined;
    saving--;
    void save({ draft: draft.value });
  };
  draft.addEventListener("input", () => {
    if (!typing) saving++;
    clearTimeout(typing);
    typing = setTimeout(flush, 400);
    showStatus();
  });
  // Best effort: hand a pending edit to the store when the page goes away.
  window.addEventListener("pagehide", flush);

  /** Read everything again; the core has no background sync. */
  const refresh = async () => {
    if (!store) return;
    try {
      render(await store.get());
      if (session.mode === "often") showStatus("idle");
    } catch (e) {
      if (e.code === "closed") return locked();
      showStatus("offline", e);
    }
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refresh();
    else flush();
  });

  const SOURCES = {
    passkey: "your passkey: it gives this token wherever it is available",
    "new passkey": "a new passkey created here",
    generated: "generated on this device",
    pasted: "pasted or typed in",
  };
  const showToken = () => {
    const { token, source, mode, since } = session;
    const from = SOURCES[source] ?? source;
    $("code").textContent = token;
    $("token-source").textContent =
      (since
        ? `Kept by this page since ${new Date(since).toLocaleString()}; originally ${from}`
        : from.charAt(0).toUpperCase() + from.slice(1)) + ".";
    $("custody").textContent =
      mode === "once"
        ? "Kept by this page in this browser's localStorage, unencrypted, until you sign out."
        : "In this page's memory only. Reloading or closing the page locks it.";
    $("data-copy").textContent =
      mode === "once"
        ? "Encrypted in the store, plus an unencrypted copy in this browser for offline use."
        : "Only in the store, encrypted. Nothing is kept on this device.";
  };

  /** Show the sign-in choices; nothing is open. */
  const locked = () => {
    if (typing) saving--;
    clearTimeout(typing);
    typing = undefined;
    store = null;
    session = null;
    $("app").hidden = true;
    $("signin").hidden = false;
    draft.value = "";
    applyTheme("light");
    showStatus("locked");
  };

  /**
   * Open the store with a token. "once" also keeps the token in this page's
   * own record and wraps the core in the offline copy.
   */
  const open = async (input, source, mode, since) => {
    const core = await Burrow.burrow({ app: APP, backend, token: input });
    const token = canonical(input);
    store?.close();
    if (mode === "once") {
      store = await Burrow.offline(core);
      store.onStatus.addListener(({ status: s, error }) =>
        showStatus(s, error),
      );
      // Writes from other tabs and changes from the store.
      store.onChanged.addListener(({ changes }) => {
        if ("theme" in changes) applyTheme(changes.theme.newValue);
        if ("draft" in changes && document.activeElement !== draft)
          draft.value = changes.draft.newValue ?? "";
      });
      if (!since)
        localStorage.setItem(
          KEPT,
          JSON.stringify({ token, source, since: Date.now() }),
        );
    } else {
      store = core;
    }
    session = { token, source, mode, since };
    $("signin").hidden = true;
    $("app").hidden = false;
    showToken();
    showStatus(mode === "once" ? store.status : "syncing");
    await refresh();
  };

  const mode = () =>
    document.querySelector("input[name=mode]:checked")?.value ?? "often";

  // Passkey: the token comes from the passkey itself; nothing is stored.
  const NO_PASSKEY =
    "This browser cannot use passkeys for this. Use a storage token instead.";
  const signin = async (get, source) => {
    for (const b of document.querySelectorAll("#signin button"))
      b.disabled = true;
    try {
      const token = await get();
      await open(token, source, mode());
      return true;
    } catch (e) {
      say(
        e.code === "prf-unsupported"
          ? NO_PASSKEY
          : e.code === "cancelled"
            ? "No passkey was used. Try again, or use a storage token."
            : e.code === "bad-token"
              ? "That token is not right. Check it and try again."
              : `Could not open your storage (${e.code ?? e.name}).`,
      );
      return false;
    } finally {
      for (const b of document.querySelectorAll("#signin button"))
        b.disabled = false;
    }
  };
  $("passkey-get").addEventListener("click", async () => {
    if (!(await passkey.available())) return say(NO_PASSKEY);
    if (await signin(() => passkey.get(), "passkey"))
      say("Signed in with your passkey.");
  });
  $("passkey-create").addEventListener("click", async () => {
    if (!(await passkey.available())) return say(NO_PASSKEY);
    if (await signin(() => passkey.create(), "new passkey"))
      say(
        "Passkey created. On another device with this passkey, choose “Use my passkey”.",
      );
  });
  $("new-token").addEventListener("click", async () => {
    if (await signin(() => Burrow.generateToken(), "generated"))
      say(
        "New token. Copy it and keep it: it is the only way back to this data.",
      );
  });
  $("token-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (await signin(async () => $("token-input").value, "pasted")) {
      $("token-input").value = "";
      say("Your data is here.");
    }
  });

  $("copy-token").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(session.token);
      say("Token copied.");
    } catch {
      say("Could not copy. Select the token and copy it by hand.");
    }
  });

  // Export (graceful failure: the user can always take their data by hand).
  $("export").addEventListener("click", async () => {
    let items;
    try {
      items = await store.get();
    } catch (e) {
      return say(`Could not read your data (${e.code ?? e.name}).`);
    }
    const blob = new Blob(
      [
        JSON.stringify(
          { burrow: 1, app: APP, exportedAt: new Date().toISOString(), items },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(blob),
      download: "burrow-demo.json",
    });
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // Sign out: forget the token here. "Stay signed in" also deletes the page's
  // token record and the local copy (after pushing unsynced writes, or with
  // confirmation). The data stays in the store for the token.
  $("signout").addEventListener("click", async () => {
    if (session.mode === "once") {
      if (typing) {
        clearTimeout(typing);
        typing = undefined;
        saving--;
        await save({ draft: draft.value });
      }
      try {
        await store.forget();
      } catch (e) {
        if (e.code !== "would-orphan")
          return say(`Could not sign out (${e.code ?? e.name}).`);
        if (
          !confirm(
            "Some changes have not reached the store yet. Sign out and discard them?",
          )
        )
          return say("Still signed in.");
        await store.forget({ discardLocal: true });
      }
      localStorage.removeItem(KEPT);
    } else store.close();
    locked();
    say("Signed out. Keep your token or passkey to come back to your data.");
  });

  // Another tab signed out of "stay signed in".
  window.addEventListener("storage", (e) => {
    if (e.key === KEPT && !e.newValue && session?.mode === "once") {
      store.close();
      locked();
    }
  });

  const remembered = kept();
  if (remembered) {
    try {
      await open(
        remembered.token,
        remembered.source,
        "once",
        remembered.since ?? Date.now(),
      );
    } catch (e) {
      // Only a token that cannot be right is dropped; any other failure may
      // pass, and the record is the user's way back in.
      locked();
      if (e?.code === "bad-token") localStorage.removeItem(KEPT);
      else
        say(
          `Could not open your storage (${e?.code ?? e?.name}). Reload to try again.`,
        );
    }
  } else locked();
  document.body.dataset.ready = "true";
})();
