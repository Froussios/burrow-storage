// Demo v2: one editor, with configuration selected by ?scenario=.
// Each scenario owns its app namespace, passkey derivation and token record.
(async () => {
  const $ = (id) => document.getElementById(id);
  const say = (text) => {
    $("message").textContent = text;
  };
  // Add scenarios here; the navigation enumerates the entire registry.
  const scenarios = [
    {
      id: "offline",
      title: "Offline wrapper",
      app: "burrow-demo-v2-offline",
      mode: "once",
      summary: "Keep working when the network goes away.",
      detail:
        "The offline wrapper keeps a plaintext copy on this device and syncs changes when the store is reachable. This demo also keeps this scenario's token in localStorage, unencrypted, so it can reopen without a prompt.",
      storage: "Plaintext copy in IndexedDB",
      token: "Remembered by this page",
      network: "Edits queue locally, then sync",
      setup:
        'const core = await Burrow.burrow({ app: "burrow-demo-v2-offline", backend, token });\nconst store = await Burrow.offline(core);',
    },
    {
      id: "core",
      title: "Remote only",
      app: "burrow-demo-v2-core",
      mode: "often",
      summary: "Core lib, backed by Firebase.",
      detail:
        "The core keeps the token in this page's memory and stores no content on disk. A reload asks you to open it again. Network failures reject reads and writes; there is no durable offline queue.",
      storage: "No persistent content copy",
      token: "Memory for this visit",
      network: "Failed writes are reported",
      setup:
        'const store = await Burrow.burrow({ app: "burrow-demo-v2-core", backend, token });',
    },
  ];
  const url = new URL(location.href);
  const requested = url.searchParams.get("scenario") ?? "offline";
  const scenario = scenarios.find(({ id }) => id === requested);
  for (const item of scenarios) {
    const target = new URL(location.href);
    target.search = "";
    target.hash = "";
    target.searchParams.set("scenario", item.id);
    const link = document.createElement("a");
    link.href = target.href;
    link.className = "scenario-link";
    link.dataset.scenario = item.id;
    if (item === scenario) link.setAttribute("aria-current", "page");
    const name = document.createElement("strong");
    name.textContent = item.title;
    const hint = document.createElement("span");
    hint.textContent =
      item.mode === "once"
        ? "Local copy + sync"
        : "Core lib, backed by Firebase";
    link.append(name, hint);
    $("scenarios").append(link);
  }
  if (!scenario) {
    $("scenario-title").textContent = "Choose a scenario";
    $("scenario-summary").textContent =
      "That scenario is not available. Choose one from the navigation.";
    $("scenario-config").hidden = true;
    $("status").textContent = "unknown scenario";
    document.body.dataset.ready = "true";
    return;
  }
  if (!url.searchParams.has("scenario")) {
    url.searchParams.set("scenario", scenario.id);
    history.replaceState(null, "", url);
  }
  document.body.dataset.scenario = scenario.id;
  document.title = `Burrow demo v2 · ${scenario.title}`;
  $("scenario-title").textContent = scenario.title;
  $("scenario-summary").textContent = scenario.summary;
  $("scenario-detail").textContent = scenario.detail;
  $("setup-code").textContent = scenario.setup;
  for (const key of ["storage", "token", "network"])
    $("scenario-" + key).textContent = scenario[key];
  $("signin-hint").textContent =
    scenario.mode === "once"
      ? "Open once on a trusted device. This page remembers the token and keeps a plaintext offline copy. Anyone who can read this browser's files can read both."
      : "Open on every visit. Your token stays in memory and your content stays in the encrypted store. Keep the token or passkey to return after a reload.";
  const APP = scenario.app;
  // Token custody is an explicit demo choice, scoped to this scenario.
  const KEPT = `${APP}:token`;
  const backend = Burrow.readBackendConfig();
  const passkey = Burrow.passkeyToken({
    app: APP,
    userName: APP,
    displayName: `Burrow v2 · ${scenario.title}`,
  });

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
        scenario: scenario.id,
        app: APP,
        mode: session?.mode ?? null,
        status,
        tokenKeptByPage: scenario.mode === "once" && !!kept(),
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
    if (!failedKeys.has("theme")) applyTheme(data.theme);
    if (!failedKeys.has("draft") && !typing && document.activeElement !== draft)
      draft.value = data.draft ?? "";
  };

  /**
   * Write through the store. The core rejects when the store cannot be
   * reached; the offline wrapper keeps the write and reports status instead.
   */
  const save = (items) => {
    if (!store) return Promise.resolve();
    const target = store;
    saving++;
    showStatus();
    writes = writes.then(async () => {
      try {
        await target.set(items);
        for (const key of Object.keys(items)) failedKeys.delete(key);
        if (!failedKeys.size) say("");
        status = session.mode === "often" ? "idle" : target.status;
      } catch (e) {
        for (const key of Object.keys(items)) failedKeys.add(key);
        status = "offline";
        say(`Not saved: the store could not be reached (${e.code ?? e.name}).`);
      } finally {
        saving--;
        showStatus();
      }
    });
    return writes;
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
  let writes = Promise.resolve();
  const failedKeys = new Set();
  const flush = () => {
    if (!typing) return writes;
    clearTimeout(typing);
    typing = undefined;
    saving--;
    return save({ draft: draft.value });
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
      if (session.mode === "often")
        showStatus(failedKeys.size ? "offline" : "idle");
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
    const { token, source, mode, since, remembered } = session;
    const from = SOURCES[source] ?? source;
    $("code").textContent = token;
    $("token-source").textContent =
      (since
        ? `Kept by this page since ${new Date(since).toLocaleString()}; originally ${from}`
        : from.charAt(0).toUpperCase() + from.slice(1)) + ".";
    $("custody").textContent =
      mode === "once"
        ? remembered
          ? "Kept by this page in this browser's localStorage, unencrypted, until you sign out."
          : "In memory only: this browser could not remember it. Keep the token to reopen the offline copy after a reload."
        : "In this page's memory only. Reloading or closing the page locks it.";
    $("data-copy").textContent =
      mode === "once"
        ? "Encrypted in the store, plus an unencrypted copy in this browser for offline use."
        : "Only in the store, encrypted. Nothing is kept on this device.";
  };

  /** Show the sign-in choices; nothing is open. */
  const locked = () => {
    failedKeys.clear();
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
      if (!since) {
        try {
          localStorage.setItem(
            KEPT,
            JSON.stringify({ token, source, since: Date.now() }),
          );
        } catch {
          say(
            "This browser could not remember the token. Keep it yourself; a reload will ask for it again.",
          );
        }
      }
    } else {
      store = core;
    }
    session = {
      token,
      source,
      mode,
      since,
      remembered: mode === "once" && !!kept(),
    };
    $("signin").hidden = true;
    $("app").hidden = false;
    showToken();
    showStatus(mode === "once" ? store.status : "syncing");
    await refresh();
  };

  const mode = () => scenario.mode;

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
        "Passkey and token created. On another device with this passkey, choose “Get token from passkey”.",
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
      download: `burrow-demo-v2-${scenario.id}.json`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // Sign out: forget the token here. "Stay signed in" also deletes the page's
  // token record and the local copy (after pushing unsynced writes, or with
  // confirmation). The data stays in the store for the token.
  $("signout").addEventListener("click", async () => {
    await flush();
    if (session.mode === "once") {
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
    } else {
      if (
        failedKeys.size &&
        !confirm("Some edits were not saved. Sign out and discard them?")
      )
        return say("Still signed in.");
      store.close();
    }
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

  for (const link of document.querySelectorAll(".scenario-link")) {
    link.addEventListener("click", async (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        return;
      if (link.dataset.scenario === scenario.id) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      await flush();
      if (
        failedKeys.size &&
        !confirm(
          "Some edits were not saved. Switch scenarios and discard them?",
        )
      )
        return;
      failedKeys.clear();
      store?.close();
      location.assign(link.href);
    });
  }
  window.addEventListener("beforeunload", (e) => {
    if (typing || saving || failedKeys.size) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  const remembered = scenario.mode === "once" ? kept() : null;
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
