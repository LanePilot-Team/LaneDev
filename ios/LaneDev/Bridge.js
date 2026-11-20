/* Geolocation adapter only. Route progress, matching, rerouting and speech decisions stay in React. */
(() => {
  if (window !== window.top || location.protocol !== 'lanedev:' || location.host !== 'app') return;
  const post = command => window.webkit.messageHandlers.LaneNative.postMessage(JSON.stringify(command));
  Object.defineProperty(window, 'LanePlatform', { value: 'ios' });
  Object.defineProperty(window, 'LaneNative', { value: Object.freeze({ postMessage: message => {
    if (typeof message === 'string') window.webkit.messageHandlers.LaneNative.postMessage(message);
  } }) });

  // Native replies carry the IDs captured when the fix/error was sent. IDs never repeat across documents.
  const documentKey = Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-');
  let nextId = 0, foreground = true, authorization = 'checking';
  const watches = new Map();
  const clearWatch = id => {
    const entry = watches.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    watches.delete(id);
    post({ type: 'locationStop', id: entry.key });
  };
  const failure = (code, reason, message) => ({
    code, reason, message, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3,
  });
  const arm = (id, entry) => {
    clearTimeout(entry.timer);
    if (!foreground || !Number.isFinite(entry.timeout)
      || !['checking', 'notDetermined', 'full'].includes(authorization)) return;
    entry.timer = setTimeout(() => {
      if (watches.get(id) !== entry) return;
      if (entry.once) clearWatch(id);
      entry.error?.(failure(3, 'timeout', 'GPS 取得逾時'));
    }, entry.timeout);
  };
  const watch = (success, error, options = {}, once = false) => {
    const id = ++nextId;
    const entry = {
      key: documentKey + ':' + id, success, error, once,
      timeout: Math.max(0, options.timeout ?? Infinity), timer: 0, lastTimestamp: 0,
      earliest: Date.now() - Math.max(0, Math.min(1000, options.maximumAge ?? 0)),
    };
    watches.set(id, entry);
    arm(id, entry);
    post({ type: 'locationStart', id: entry.key });
    return id;
  };
  Object.defineProperty(window, 'LaneGeolocation', { value: Object.freeze({
    getCurrentPosition: (success, error, options) => {
      const id = watch(success, error, options, true);
      return () => clearWatch(id);
    },
    watchPosition: (success, error, options) => watch(success, error, options),
    clearWatch,
    getAuthorization: () => authorization,
  }) });

  window.addEventListener('lane-native', event => {
    const data = event.detail;
    if (data?.type === 'locationAuthorization' && authorization !== data.state) {
      authorization = data.state;
      for (const [id, entry] of watches) arm(id, entry);
    }
    if (data?.type === 'lifecycle' && foreground !== data.active) {
      foreground = data.active;
      for (const [id, entry] of [...watches]) {
        if (watches.get(id) !== entry) continue;
        if (foreground) entry.earliest = Math.max(entry.earliest, data.timestamp ?? Date.now());
        arm(id, entry);
        if (!foreground && !entry.once) {
          entry.error?.(failure(2, 'paused', '前景導航已暫停，返回 App 後等待新定位'));
        }
      }
    }
    if (data?.type === 'position' && foreground && authorization === 'full' && Array.isArray(data.ids)) {
      const c = data.coords, age = Date.now() - data.timestamp;
      if (!c || !Number.isFinite(c.longitude) || !Number.isFinite(c.latitude)
        || Math.abs(c.longitude) > 180 || Math.abs(c.latitude) > 90
        || !Number.isFinite(c.accuracy) || c.accuracy < 0
        || !Number.isFinite(data.timestamp) || age < -1000 || age > 10000) return;
      for (const [id, entry] of [...watches]) {
        if (watches.get(id) !== entry || !data.ids.includes(entry.key)
          || data.timestamp <= entry.lastTimestamp || data.timestamp < entry.earliest) continue;
        entry.lastTimestamp = data.timestamp;
        if (entry.once) clearWatch(id); else arm(id, entry);
        entry.success({ coords: c, timestamp: data.timestamp });
      }
    }
    if (data?.type === 'positionError' && Array.isArray(data.ids)) {
      for (const [id, entry] of [...watches]) {
        if (watches.get(id) !== entry || !data.ids.includes(entry.key)) continue;
        if (entry.once || (data.code === 1 && !data.recoverable)) clearWatch(id);
        entry.error?.(failure(data.code, data.reason, data.message));
      }
    }
  });
  window.addEventListener('pagehide', () => { for (const id of [...watches.keys()]) clearWatch(id); });
})();
