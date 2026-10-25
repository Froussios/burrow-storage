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
      id: "core",
      title: "Remote only",
      app: "burrow-demo-v2-core",
      offline: false,
      summary: "Core lib, backed by Firebase.",
      detail:
        "The core library stores no content or token on disk. Network failures reject reads and writes; there is no durable offline queue. This demo can remember the token separately if you choose.",
      storage: "No persistent content copy",
      network: "Failed writes are reported",
      setup:
        'const store = await Burrow.burrow({ app: "burrow-demo-v2-core", backend, token });',
    },
    {
      id: "offline",
      title: "Offline wrapper",
      app: "burrow-demo-v2-offline",
      offline: true,
      summary: "Keep working when the network goes away.",
      detail:
        "The offline wrapper keeps a plaintext content copy on this device and syncs changes when the store is reachable. Remembering the token is a separate option implemented by this demo.",
      storage: "Plaintext copy in IndexedDB",
      network: "Edits queue locally, then sync",
      setup:
        'const core = await Burrow.burrow({ app: "burrow-demo-v2-offline", backend, token });\nconst store = await Burrow.offline(core);',
    },
  ];
  const url = new URL(location.href);
  const requested = url.searchParams.get("scenario") ?? scenarios[0].id;
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
    hint.textContent = item.offline
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
  for (const key of ["storage", "network"])
    $("scenario-" + key).textContent = scenario[key];
  $("signin-hint").textContent = scenario.offline
    ? "The offline wrapper keeps a plaintext content copy in this browser. You still need a token or passkey to reopen it."
    : "Reads and writes go directly to the encrypted remote store. The core library keeps no content on disk.";
  const updateCustodyChoice = () => {
    const remember = $("remember-token").checked;
    $("scenario-token").textContent = remember
      ? "Saved by this demo on this device"
      : "In memory for this visit";
    $("token-only-hint").textContent = remember
      ? "No passkey is created. This demo will save the token on this device because remembering is selected. Keep a separate copy: clearing browser data removes it."
      : "No passkey is created, and this demo will not store the token. Write it down or save it in your password manager before leaving.";
  };
  $("remember-token").addEventListener("change", updateCustodyChoice);
  updateCustodyChoice();
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
        library: scenario.offline ? "offline wrapper" : "core",
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
        status = scenario.offline ? target.status : "idle";
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
      if (!scenario.offline) showStatus(failedKeys.size ? "offline" : "idle");
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
    const { token, source, since, remembered, persistenceFailed } = session;
    const from = SOURCES[source] ?? source;
    $("code").textContent = token;
    $("token-source").textContent =
      (since
        ? `Kept by this page since ${new Date(since).toLocaleString()}; originally ${from}`
        : from.charAt(0).toUpperCase() + from.slice(1)) + ".";
    $("custody").textContent = remembered
      ? "Saved unencrypted in localStorage by this demo, until you sign out. The library does not store it."
      : "In this page's memory only. This demo has not stored it; reloading or closing the page requires the token or passkey again.";
    $("token-reminder").textContent = persistenceFailed
      ? "This browser could not save your token. Write it down or save it in your password manager before leaving."
      : remembered
        ? "This demo saved the token on this device. Keep a separate copy in case browser data is cleared."
        : source === "passkey" || source === "new passkey"
          ? "This demo has not stored your token. Use the passkey to get it again, or write the token down."
          : "This demo has not stored your token. Write it down or save it in your password manager before leaving; otherwise you cannot reopen this data.";
    $("data-copy").textContent = scenario.offline
      ? "Encrypted in the store, plus an unencrypted content copy in this browser for offline use."
      : "Only in the store, encrypted. No persistent content copy on this device.";
    $("scenario-token").textContent = remembered
      ? "Saved by this demo on this device"
      : "In memory for this visit";
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
    $("code").textContent = "";
    $("remember-token").checked = false;
    updateCustodyChoice();
    applyTheme("light");
    showStatus("locked");
  };

  /**
   * Library choice controls content caching; the separate remember choice
   * controls the demo-owned token record for either library setup.
   */
  const open = async (input, source, remember, since) => {
    const core = await Burrow.burrow({ app: APP, backend, token: input });
    const token = canonical(input);
    store?.close();
    if (scenario.offline) {
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
    } else {
      store = core;
    }
    let remembered = false;
    let persistenceFailed = false;
    if (remember) {
      try {
        if (!since)
          localStorage.setItem(
            KEPT,
            JSON.stringify({ token, source, since: Date.now() }),
          );
        remembered = true;
      } catch {
        persistenceFailed = true;
      }
    }
    session = { token, source, since, remembered, persistenceFailed };
    $("remember-token").checked = remembered;
    $("signin").hidden = true;
    $("app").hidden = false;
    showToken();
    showStatus(scenario.offline ? store.status : "syncing");
    await refresh();
  };

  // Passkey: the utility derives a token. The demo owns any persistence.
  const NO_PASSKEY =
    "This browser cannot use passkeys for this. Use a storage token instead.";
  const signin = async (get, source) => {
    const remember = $("remember-token").checked;
    for (const b of document.querySelectorAll("#signin button, #signin input"))
      b.disabled = true;
    try {
      const token = await get();
      await open(token, source, remember);
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
      for (const b of document.querySelectorAll(
        "#signin button, #signin input",
      ))
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
        session.remembered
          ? "Token created and saved on this device by the demo. Keep a separate copy."
          : "Token created. This demo has not stored it. Write it down or save it in your password manager before leaving.",
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

  // Sign out removes the demo-owned token record for either scenario. The
  // offline wrapper also clears its content copy, after handling queued edits.
  $("signout").addEventListener("click", async () => {
    await flush();
    if (scenario.offline) {
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
    } else {
      if (
        failedKeys.size &&
        !confirm("Some edits were not saved. Sign out and discard them?")
      )
        return say("Still signed in.");
      store.close();
    }
    let cleanupFailed = false;
    try {
      localStorage.removeItem(KEPT);
    } catch {
      cleanupFailed = session.remembered;
    }
    locked();
    say(
      cleanupFailed
        ? "Could not remove the saved token. Clear this site's browser data to remove it."
        : "Signed out. Keep your token or passkey to come back to your data.",
    );
  });

  // Another tab removed this scenario's demo-owned token record.
  window.addEventListener("storage", (e) => {
    if (e.key === KEPT && !e.newValue && session?.remembered) {
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

  const remembered = kept();
  if (remembered) {
    try {
      await open(
        remembered.token,
        remembered.source,
        true,
        remembered.since ?? Date.now(),
      );
    } catch (e) {
      // Only a token that cannot be right is dropped; any other failure may
      // pass, and the record is the user's way back in.
      locked();
      if (e?.code === "bad-token") {
        try {
          localStorage.removeItem(KEPT);
        } catch {
          /* browser storage unavailable */
        }
      } else
        say(
          `Could not open your storage (${e?.code ?? e?.name}). Reload to try again.`,
        );
    }
  } else locked();
  document.body.dataset.ready = "true";
})();
