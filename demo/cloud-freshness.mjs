// Demo-owned observation of confirmed backend requests. Keep no document ids,
// envelopes, tokens or content; a local/offline completion is not a cloud save.
export function observeCloud(backend, confirmed) {
  const observed = {
    id: backend.id,
    capabilities: backend.capabilities,
    async get(...args) {
      const result = await backend.get(...args);
      confirmed("read", Date.now());
      return result;
    },
    async put(...args) {
      await backend.put(...args);
      confirmed("save", Date.now());
    },
  };
  if (backend.getMany)
    observed.getMany = async (ids) => {
      const result = await backend.getMany(ids);
      if (ids.length) confirmed("read", Date.now());
      return result;
    };
  // Notifications can come from an SDK's cache. Count the explicit cloud
  // reads they trigger instead of treating a notification as a fresh read.
  if (backend.subscribe) observed.subscribe = backend.subscribe.bind(backend);
  return observed;
}

// Remember times, not credentials or content. A one-way identifier separates
// app/token spaces without saving a token or any encryption/write key.
export async function cloudHistory(app, token) {
  const bytes = new TextEncoder().encode(
    `burrow-demo/cloud-times\0${app}\0${token}`,
  );
  let digest;
  try {
    digest = await crypto.subtle.digest("SHA-256", bytes);
  } catch {
    return { read: () => null, record() {} };
  } finally {
    bytes.fill(0);
  }
  const identity = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const prefix = `${app}:cloud-times:${identity}:`;
  return {
    read(kind) {
      try {
        const at = Number(localStorage.getItem(prefix + kind));
        return Number.isSafeInteger(at) && at > 0 && at <= 8.64e15 ? at : null;
      } catch {
        return null;
      }
    },
    record(kind, at) {
      try {
        localStorage.setItem(prefix + kind, String(at));
      } catch {
        // The current confirmation still displays if storage is unavailable.
      }
    },
  };
}
