/* Geolocation adapter only. Route progress, matching, rerouting and speech decisions stay in React. */
(() => {
  if (window !== window.top || location.protocol !== 'lanedev:' || location.host !== 'app') return;
  const post = command => window.webkit.messageHandlers.LaneNative.postMessage(JSON.stringify(command));
  Object.defineProperty(window, 'LanePlatform', { value: 'ios' });
  Object.defineProperty(window, 'LaneNative', { value: Object.freeze({ postMessage: message => {
    if (typeof message === 'string') window.webkit.messageHandlers.LaneNative.postMessage(message);
  } }) });
  let nextId = 0, foreground = true;
  const watches = new Map();
  const clearWatch = id => {
    const entry = watches.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    watches.delete(id);
    post({ type: 'locationStop', id });
  };
  const failure = (code, message) => ({ code, message, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
  const arm = (id, entry) => {
    clearTimeout(entry.timer);
    if (!foreground || !Number.isFinite(entry.timeout)) return;
    entry.timer = setTimeout(() => {
      if (!watches.has(id)) return;
      if (entry.once) clearWatch(id);
      entry.error?.(failure(3, 'GPS 取得逾時'));
    }, entry.timeout);
  };
  const watch = (success, error, options = {}, once = false) => {
    const id = ++nextId;
    const entry = { success, error, once, timeout: Math.max(0, options.timeout ?? Infinity), timer: 0 };
    watches.set(id, entry);
    arm(id, entry);
    post({ type: 'locationStart', id });
    return id;
  };
  Object.defineProperty(window, 'LaneGeolocation', { value: Object.freeze({
    getCurrentPosition: (success, error, options) => { watch(success, error, options, true); },
    watchPosition: (success, error, options) => watch(success, error, options),
    clearWatch,
  }) });
  window.addEventListener('lane-native', event => {
    const data = event.detail;
    if (data.type === 'lifecycle') {
      foreground = data.active;
      for (const [id, entry] of watches) arm(id, entry);
    }
    if (data.type === 'position' && foreground) {
      const c = data.coords;
      if (!c || !Number.isFinite(c.longitude) || !Number.isFinite(c.latitude)
        || Math.abs(c.longitude) > 180 || Math.abs(c.latitude) > 90
        || !Number.isFinite(c.accuracy) || c.accuracy < 0
        || !Number.isFinite(data.timestamp) || Math.abs(Date.now() - data.timestamp) > 15000) return;
      for (const [id, entry] of [...watches]) {
        if (!watches.has(id)) continue;
        if (entry.once) clearWatch(id); else arm(id, entry);
        entry.success({ coords: c, timestamp: data.timestamp });
      }
    }
    if (data.type === 'positionError') {
      for (const [id, entry] of [...watches]) {
        if (entry.once || data.code === 1) clearWatch(id);
        entry.error?.(failure(data.code, data.message));
      }
    }
  });
  window.addEventListener('pagehide', () => { for (const id of [...watches.keys()]) clearWatch(id); });
})();
