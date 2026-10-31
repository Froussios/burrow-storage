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
