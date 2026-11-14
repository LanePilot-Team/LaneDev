import { ENDPOINTS, SCREENS, VEHICLES, ROUTES, ROUTE_CASES, routeCase, endpoint, routeFor, project, routePosition, cameraRotation, chooseSource, validMediaURL, commonDuration, availableScreens } from './route-model.js';

const $ = id => document.getElementById(id);
const $$ = query => [...document.querySelectorAll(query)];
const svgNS = 'http://www.w3.org/2000/svg';
const state = { from: null, to: null, selecting: 'from', vehicle: 'car', view: 'map', zoom: 1, visible: new Set(SCREENS.map(s => s.id)), quality: 'auto', introAnimation: null };
let manifest = { routes: {} }, geometry = { routes: {} }, geometryState = 'loading', notifyTimer;
let preloadedSignature = '';
let previewFrame = 0, previewDistance = 0, previewLast = 0;
const currentGeometry = () => geometry.routes?.[`${state.from}-${state.to}`]?.[state.vehicle];
function stopPreview() { cancelAnimationFrame(previewFrame); previewFrame = 0; previewLast = 0; $('route-cursor').toggleAttribute('hidden',true); $('preview-route').textContent = '預覽路徑'; }
function placeCursor(route, distance) { const at=routePosition(route,distance); if (!at) return; $('route-cursor').setAttribute('transform',`translate(${at.point[0]} ${at.point[1]}) rotate(${at.heading})`); }
function tickPreview(now) { const route=currentGeometry(); if (!route || state.view !== 'map') { stopPreview(); return; } if(previewLast) previewDistance += Math.min(now-previewLast,100)*.055*Number($('preview-speed').value); previewLast=now; placeCursor(route,previewDistance); if(previewDistance >= route.routeD.at(-1)) { stopPreview(); return; } previewFrame=requestAnimationFrame(tickPreview); }
function notify(message) { clearTimeout(notifyTimer); $('notification').textContent = message; $('notification').hidden = false; notifyTimer = setTimeout(() => $('notification').hidden = true, 4200); }
const currentKey = () => `${state.from}-${state.to}:${state.vehicle}`;
function assetsFor(routeId, vehicle) { return manifest.routes?.[routeId]?.[vehicle] || {}; }
function currentAssets() { return assetsFor(`${state.from}-${state.to}`, state.vehicle); }
function node(tag, attrs = {}, text) { const el = document.createElementNS(svgNS, tag); for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value); if (text) el.textContent = text; return el; }

function renderMapView() {
  stopPreview(); previewDistance = 0;
  $$('.active-route').forEach(el=>el.remove());
  $('route-overlay').replaceChildren();
  const selected=routeCase(state.from,state.to,state.vehicle), route=selected ? currentGeometry() : null, ready=route?.status==='ready';
  // Expand the view for routes whose real turnaround lies south of the normal map.
  const maxY = ready ? Math.max(640, ...route.coordinates.map(p=>project(p)[1] + 35)) : 640;
  $('route-map').setAttribute('viewBox', `0 0 900 ${maxY}`);
  $('route-cursor').toggleAttribute('hidden', true);
  $('route-cursor').setAttribute('visibility',ready?'visible':'hidden');
  $('preview-route').disabled = !ready;
  const carNotes = {
    'station-east': '此路線請沿平面道路行駛。',
    'east-station': '此路線請沿平面道路行駛。',
    'west-station': '請參考後勁捷運站（E）至健仁醫院（C）的路線，再沿平面道路前往楠梓火車站（B）。',
  };
  const specialNote = state.vehicle === 'car' ? carNotes[`${state.from}-${state.to}`] : null;
  $('geometry-status').textContent = specialNote || (!selected ? (state.from && state.to ? '此方向與車種未列入交流道路線展示，請參考平面道路導航。' : '選擇起點與終點。') : ready ? `${route.review?.status==='approved'?'已確認':'待人工驗證'} · ${(route.lengthM/1000).toFixed(2)} km${state.from==='south' && state.to==='station' && state.vehicle==='scooter' ? '（右轉接續段依確認補繪，待核對）' : ''}` : geometryState==='loading' ? '路徑載入中…' : geometryState==='error' ? '路徑載入失敗，請重新整理。' : route?.review?.note || '此方向的完整路徑待確認。');
  $('geometry-status').classList.toggle('pending',!!selected&&!ready);
  if(!ready) return;
  // Route order is independent of basemap elevation: later travel paints over earlier travel.
  const points=route.coordinates.map(project), group=node('g',{class:'active-route',fill:'none','stroke-linecap':'round','stroke-linejoin':'round'});
  const defs=node('defs'), clip=node('clipPath',{id:'route-seam-clip',clipPathUnits:'userSpaceOnUse'});
  clip.append(node('circle',{cx:0,cy:0,r:4,fill:'#fff'})); defs.append(clip); group.append(defs);
  const position=([x,y])=>`${x.toFixed(3)} ${y.toFixed(3)}`;
  group.append(node('path',{d:points.map((p,i)=>`${i?'L':'M'}${position(p)}`).join(''),stroke:'#fff','stroke-width':6}));
  for(let i=1;i<points.length;i++){
    const start=points[i-1],end=points[i],d=`M${position(start)}L${position(end)}`;
    group.append(node('path',{d,stroke:'#fff','stroke-width':6,'data-route-step':i,'data-paint':'outline'}));
    group.append(node('path',{d,stroke:'#287b97','stroke-width':3.5,'data-route-step':i,'data-paint':'line'}));
    if(i<2)continue;
    // A new outline must not erase the blue line immediately before its shared endpoint.
    // Repair only the local join; later route segments will still paint above this patch.
    let first=i-2;
    while(first>0&&Math.hypot(points[first][0]-start[0],points[first][1]-start[1])<5)first--;
    const join=points.slice(first,i+1).map(([x,y])=>[x-start[0],y-start[1]]);
    group.append(node('path',{d:join.map((p,j)=>`${j?'L':'M'}${position(p)}`).join(''),stroke:'#287b97','stroke-width':3.5,'clip-path':'url(#route-seam-clip)',transform:`translate(${position(start)})`,'data-route-join':i-1}));
  }
  $('route-overlay').append(group);
  placeCursor(route,0);
}
function renderBaseMap(data) {
  const root = $('map-roads'); root.replaceChildren();
  const labels = node('g', {class:'map-labels'}), named = new Map(), layers = new Map();
  for (const feature of [...data.features].sort((a,b) => a.layer - b.layer)) {
    const coordinates = feature.coordinates.map(project);
    const d = coordinates.map(([x,y],i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join('');
    const group = node('g', {'data-layer':feature.layer,'data-way':feature.id,'data-bridge':String(feature.bridge),fill:'none','stroke-linecap':'round','stroke-linejoin':'round'});
    if (feature.kind === 'water') group.append(node('path',{d,stroke:'#bddbdc','stroke-width':13}));
    else if (feature.kind === 'rail') { group.append(node('path',{d,stroke:'#c6cbc7','stroke-width':3})); group.append(node('path',{d,stroke:'#f7f9f5','stroke-width':1.6,'stroke-dasharray':'3 5'})); }
    else {
      const major = /^(primary|secondary|trunk|motorway)$/.test(feature.highway), small = /residential|living|unclassified/.test(feature.highway);
      const width = Math.max(2,Math.min(16,(feature.widthM || (major?22:small?8:12))*.35));
      group.append(node('path',{d,stroke:feature.bridge ? '#b3bebc' : '#d7ddd6','stroke-width':width+2.4}));
      group.append(node('path',{d,stroke:feature.bridge ? '#fbfcfa' : '#fff','stroke-width':width}));
      if (['高楠公路','楠陽路','加昌路','楠梓新路'].includes(feature.name)) {
        const path = group.lastChild;
        if (!named.has(feature.name) || coordinates.length > named.get(feature.name).count) named.set(feature.name,{path,count:coordinates.length});
      }
    }
    if(!layers.has(feature.layer)){ const layer=node('g',{'data-map-layer':feature.layer}); layers.set(feature.layer,layer); root.append(layer); }
    layers.get(feature.layer).append(group);
  }
  for (const [name,{path}] of named) {
    const length = path.getTotalLength(), p = path.getPointAtLength(length*.5), q = path.getPointAtLength(length*.5+2);
    if (p.x < 50 || p.x > 850 || p.y < 60 || p.y > 580) continue;
    let angle = Math.atan2(q.y-p.y,q.x-p.x)*180/Math.PI; if (angle > 90 || angle < -90) angle += 180;
    labels.append(node('text',{x:p.x,y:p.y-7,transform:`rotate(${angle} ${p.x} ${p.y})`,fill:'#809088','font-size':12,'text-anchor':'middle','paint-order':'stroke',stroke:'#f5f7f2','stroke-width':3},name));
  }
  root.append(labels); renderMapView();
}

function buildNodes() {
  ENDPOINTS.forEach(p => {
    const g = node('g', { class: 'map-node', 'data-endpoint': p.id, tabindex: '0', role: 'button', 'aria-label': `選擇${p.name}，${p.description}`, 'aria-pressed': 'false' });
    const [lx, ly, width] = p.label;
    g.append(node('path', { d: `M${p.x} ${p.y}L${Math.min(Math.max(p.x, lx + 16), lx + width - 16)} ${ly + 63}`, fill: 'none', stroke: '#bac7af', 'stroke-width': '1.2' }));
    g.append(node('rect', { x: lx, y: ly, width, height: 63, rx: 9, class: 'node-label-bg' }));
    g.append(node('text', { x: lx + 14, y: ly + 23, class: 'node-label' }, p.name));
    g.append(node('text', { x: lx + 14, y: ly + 42, class: 'node-sublabel' }, p.description));
    g.append(node('text', { x: lx + width - 12, y: ly + 52, 'text-anchor': 'end', class: 'node-state' }));
    g.append(node('circle', { cx: p.x, cy: p.y, r: 28, class: 'node-halo' }));
    g.append(node('circle', { cx: p.x, cy: p.y, r: 19, class: 'node-dot' }));
    g.append(node('text', { x: p.x, y: p.y + 5, class: 'node-letter' }, p.letter));
    g.addEventListener('click', () => selectEndpoint(p.id));
    g.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectEndpoint(p.id); } });
    $('map-nodes').append(g);
  });
}
function selectEndpoint(id) {
  if (state.from === id) { clearEndpoint('from'); return; }
  if (state.to === id) { clearEndpoint('to'); return; }
  if (state.selecting === 'from') {
    state.from = id; state.selecting = 'to';
  } else {
    state.to = id; state.selecting = 'to';
  }
  renderMap();
}
function clearEndpoint(type) {
  state[type] = null;
  state.selecting = state.from ? 'to' : 'from';
  renderMap();
  notify(type === 'from' ? '已清除起點' : '已清除終點');
}
function renderMap() {
  const route = routeCase(state.from, state.to, state.vehicle);
  $$('.map-node').forEach(g => {
    const id = g.dataset.endpoint, isOrigin = id === state.from, isDestination = id === state.to;
    g.classList.toggle('is-origin', isOrigin); g.classList.toggle('is-destination', isDestination);
    g.setAttribute('aria-pressed', String(isOrigin || isDestination));
    g.querySelector('.node-state').textContent = isOrigin ? '起點' : isDestination ? '終點' : '';
  });
  for (const type of ['origin', 'destination']) {
    const p = endpoint(state[type === 'origin' ? 'from' : 'to']);
    $(`${type}-text`).textContent = p ? p.name : type === 'origin' ? '點選起點' : '點選終點';
    $(`${type}-text`).classList.toggle('placeholder', !p);
    const button = $(type === 'origin' ? 'edit-origin' : 'edit-destination');
    const name = type === 'origin' ? '起點' : '終點';
    button.setAttribute('aria-label', p ? `清除${name}：${p.name}` : `選擇${name}`);
    button.title = p ? `再次點擊可清除${name}` : `在地圖上選擇${name}`;
    button.classList.toggle('has-selection', !!p);
    button.querySelector('.edit-hint').textContent = p ? '×' : '↗';
  }
  $('clear-route').hidden = !state.from && !state.to;
  $('swap-route').disabled = !state.from || !state.to;
  $('start-route').hidden = !!route && !route.hasVideo;
  $('route-availability').parentElement.hidden = !!route && !route.hasVideo;
  $('start-route').disabled = !route || !route.hasVideo;
  $('start-route').querySelector('span').textContent = route ? '觀看影片' : state.from && state.to ? '此方向未列入' : '選擇起終點';
  const currentCase=routeCase(state.from,state.to,state.vehicle),caseIndex=ROUTE_CASES.indexOf(currentCase);
  $('route-counter').textContent = currentCase ? `${String(caseIndex+1).padStart(2,'0')} / ${ROUTE_CASES.length} ▾` : `${ROUTE_CASES.length}組路線 ▾`;
  $('case-label').textContent = currentCase ? `${endpoint(state.from).letter} → ${endpoint(state.to).letter} · ${VEHICLES[state.vehicle]}` : '汽車17組・機車18組';
  $('previous-case').disabled=caseIndex<=0; $('next-case').disabled=caseIndex===ROUTE_CASES.length-1;
  renderCaseReviews();
  $('map-instruction').textContent = route ? `${endpoint(state.from).letter} → ${endpoint(state.to).letter} · ${VEHICLES[state.vehicle]}` : state.from && state.to ? '此方向未列入' : state.from ? '選擇終點' : '選擇起點';
  renderMapView();
  const count = Object.values(currentAssets()).filter(a => a && (a.src || a.low)).length;
  $('route-availability').textContent = route ? `可播放 ${count} / 3 個畫面` : '請選擇路線';
  $$('[data-vehicle]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.vehicle === state.vehicle)));
  if (state.view === 'map') prepareSelectedRoute(route);
}
function zoomMap(value) { state.zoom = Math.min(1.65, Math.max(.85, value)); $('map-scene').style.transform = `scale(${state.zoom})`; $('zoom-in').disabled = state.zoom >= 1.65; $('zoom-out').disabled = state.zoom <= .85; }

let introToken = 0, introTimer;
async function enterRoute({ skipAnimation = false } = {}) {
  if (!routeCase(state.from, state.to, state.vehicle)?.hasVideo) return;
  stopPreview();
  if (currentGeometry()?.status !== 'ready' || state.view === 'player' || skipAnimation || matchMedia('(prefers-reduced-motion: reduce)').matches) { showPlayer(); return; }
  const token = ++introToken;
  state.view = 'intro';
  const overlay = $('intro-overlay');
  overlay.querySelector('.intro-map')?.remove();
  const clone = $('route-map').cloneNode(true);
  clone.id = 'intro-map'; clone.removeAttribute('hidden'); clone.classList.add('intro-map'); clone.removeAttribute('role'); clone.setAttribute('aria-hidden', 'true');
  // Unique IDs avoid resolving the original map's gradient/filter during the camera move.
  clone.querySelectorAll('[id]').forEach(el => { const id = el.id; el.id = `intro-${id}`; });
  clone.querySelectorAll('*').forEach(el => { for (const attr of [...el.attributes]) if (attr.value.includes('url(#')) el.setAttribute(attr.name, attr.value.replaceAll('url(#', 'url(#intro-')); });
  clone.querySelectorAll('[tabindex]').forEach(el => el.removeAttribute('tabindex'));
  overlay.prepend(clone);
  overlay.hidden = false;
  $('explorer').inert = true; $('player').inert = true; document.querySelector('.site-header').inert = true;
  $('skip-intro').focus();
  const scene = clone.querySelector('#intro-map-scene'); scene.style.transform = ''; scene.style.transformOrigin = '450px 320px';
  const route = currentGeometry(), start = routePosition(route), p = { x:start.point[0], y:start.point[1] }, rotation = cameraRotation(route);
  // The source road moves to the camera centre before rotation; no separately assembled objects.
  const animation = scene.animate([
    { transform: `translate(0px,0px) rotate(0deg) scale(${state.zoom})`, offset: 0 },
    { transform: `translate(0px,0px) rotate(0deg) scale(1.3)`, offset: .27 },
    { transform: `rotate(${rotation}deg) scale(2.35) translate(${450 - p.x}px,${320 - p.y}px)`, offset: 1 },
  ], { duration: 1650, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });
  state.introAnimation = animation;
  introTimer = setTimeout(() => { if (token === introToken) finishIntro(); }, 1760);
}
function finishIntro() {
  introToken++; clearTimeout(introTimer); state.introAnimation?.cancel(); state.introAnimation = null;
  $('intro-overlay').hidden = true; $('intro-overlay').querySelector('.intro-map')?.remove();
  $('explorer').inert = false; $('player').inert = false; document.querySelector('.site-header').inert = false;
  showPlayer();
}
function showPlayer() {
  state.view = 'player'; $('explorer').hidden = true; $('player').hidden = false;
  $('player-origin').textContent = endpoint(state.from).name;
  $('player-destination').textContent = endpoint(state.to).name;
  $('player-vehicle').textContent = VEHICLES[state.vehicle];
  document.title = `${endpoint(state.from).short} → ${endpoint(state.to).short} · ${VEHICLES[state.vehicle]}`;
  if (preloadedSignature !== routeLoadSignature() || !player.loaded.size || player.failed.size) player.loadRoute();
  preloadedSignature = '';
  renderScreens(); window.scrollTo({ top: 0, behavior: 'instant' });
  $('back-map').focus({ preventScroll: true });
}
function backToMap() {
  if (state.view === 'intro') { introToken++; clearTimeout(introTimer); state.introAnimation?.cancel(); $('intro-overlay').hidden = true; $('explorer').inert = false; document.querySelector('.site-header').inert = false; }
  player.unload(); state.view = 'map'; $('explorer').hidden = false; $('player').hidden = true; $('player').inert = false;
  document.title = '楠梓路線'; renderMap(); $('start-route').focus({ preventScroll: true });
}

class SynchronizedPlayer {
  constructor() {
    this.time = 0; this.duration = 0; this.intent = false; this.buffering = false; this.raf = 0; this.generation = 0; this.cleanups = new Map(); this.loaded = new Map(); this.failed = new Set(); this.speed = 1; this.lastCheck = 0; this.attempting = false; this.scrubbing = false;
    this.tick = this.tick.bind(this);
  }
  active() { return SCREENS.filter(s => state.visible.has(s.id) && this.loaded.has(s.id) && !this.failed.has(s.id)).map(s => ({ id: s.id, video: $(`video-${s.id}`), ...this.loaded.get(s.id) })); }
  pauseVideos() { cancelAnimationFrame(this.raf); this.raf = 0; this.active().forEach(({ video }) => video.pause()); }
  setStatus(text) { $('sync-status').textContent = text; }
  unloadScreen(id) {
    this.cleanups.get(id)?.(); this.cleanups.delete(id);
    const video = $(`video-${id}`); video.pause(); video.removeAttribute('src'); video.load(); video.hidden = true;
    this.loaded.delete(id); this.failed.delete(id);
    const panel = document.querySelector(`[data-panel="${id}"]`);
    panel.querySelector('.empty-media').hidden = false; panel.querySelector('.media-loading').hidden = true; panel.querySelector('.media-error').hidden = true;
  }
  unload() { this.generation++; this.intent = false; this.attempting = false; this.buffering = false; this.scrubbing = false; clearTimeout(this.scrubTimer); this.scrubTimer = 0; this.pauseVideos(); SCREENS.forEach(s => this.unloadScreen(s.id)); this.time = 0; this.duration = 0; this.updateUI(); }
  loadRoute() { this.unload(); SCREENS.filter(s => state.visible.has(s.id)).forEach(s => this.loadScreen(s.id)); this.updateUI(); }
  loadScreen(id) {
    const asset = currentAssets()[id], url = chooseSource(asset, state.quality, navigator.connection);
    if (!validMediaURL(url)) return;
    const video = $(`video-${id}`), panel = document.querySelector(`[data-panel="${id}"]`), offset = 0, end = null, events = [];
    const on = (name, fn) => { video.addEventListener(name, fn); events.push([name, fn]); };
    const showFootageGap = () => {
      if (id !== 'real') return;
      const gap = panel.querySelector('.footage-gap'), t = video.currentTime;
      const start = Number(asset.footageStart || 0), end = Number(asset.footageEnd || Infinity);
      gap.hidden = !(t + .05 < start || t >= end);
      if (!gap.hidden) gap.textContent = t < start ? `實景尚未開始（約 ${Math.ceil(start-t)} 秒後有畫面）` : '這段時間沒有實景錄影';
    };
    this.loaded.set(id, { offset, end, url }); this.failed.delete(id);
    panel.querySelector('.empty-media').hidden = true; panel.querySelector('.media-error').hidden = true; panel.querySelector('.media-loading').hidden = false;
    video.hidden = false; video.preload = 'auto'; video.muted = id === 'real' || !$(`sound-${id}`)?.checked; video.playbackRate = this.speed;
    on('loadedmetadata', () => {
      if (!Number.isFinite(video.duration) || offset >= video.duration || offset < 0) { this.fail(id, '同步切點超過影片長度，請重新設定。'); return; }
      try { video.currentTime = Math.min(this.time + offset, video.duration); } catch {}

      this.recalculate();
    });
    on('canplay', () => { panel.querySelector('.media-loading').hidden = true; this.recalculate(); if (this.intent && !this.scrubbing) this.tryPlay(); else this.updateUI(); });
    on('progress', () => this.renderBuffered());
    on('seeked', () => { showFootageGap(); if (this.intent && !this.scrubbing) this.tryPlay(); });
    on('timeupdate', showFootageGap);
    on('waiting', () => { if (!this.intent || (video.readyState >= 3 && !video.seeking)) return; this.buffering = true; panel.querySelector('.media-loading').hidden = false; this.pauseVideos(); this.setStatus('緩衝中 · 全部畫面同步等候'); this.updateUI(); this.scheduleRecovery(); });
    on('stalled', () => { if (this.intent && video.readyState < 3) { this.buffering = true; this.pauseVideos(); this.setStatus('網路較慢 · 等候影片'); this.updateUI(); this.scheduleRecovery(); } });
    on('error', () => this.fail(id, '影片載入失敗，可重新載入或關閉此畫面。'));
    on('ended', () => { if (this.time >= this.duration - .5 || video.currentTime >= video.duration - .1) { this.time = this.duration; this.pause(); } });
    this.cleanups.set(id, () => events.forEach(([name, fn]) => video.removeEventListener(name, fn)));
    video.src = url; video.load();
  }
  fail(id, reason) {
    this.failed.add(id); $(`video-${id}`).pause();
    const panel = document.querySelector(`[data-panel="${id}"]`); panel.querySelector('.media-loading').hidden = true; panel.querySelector('.media-error').hidden = false;
    panel.querySelector('.media-error p').textContent = reason;
    this.recalculate();
    if (this.active().length && this.intent) this.tryPlay(); else { this.intent = false; this.pauseVideos(); this.setStatus('請重新載入影片'); this.updateUI(); }
  }
  recalculate() {
    this.duration = commonDuration(this.active().map(({ video, offset, end }) => ({ duration: end > 0 ? Math.min(video.duration, end) : video.duration, offset })));
    if (this.duration && this.time > this.duration) { this.time = this.duration; this.intent = false; this.pauseVideos(); this.align(); }
    this.updateUI();
  }
  align(fast = false) { this.active().forEach(({ video, offset }) => { if (video.readyState && Math.abs(video.currentTime - this.time - offset) > .06) { try { const target=Math.max(0, Math.min(this.time + offset, video.duration)); if (fast && typeof video.fastSeek === 'function') video.fastSeek(target); else video.currentTime = target; } catch {} } }); }
  previewScrub(time) {
    this.time = Math.min(this.duration, Math.max(0, Number(time))); this.updateUI();
    if (this.scrubTimer) return;
    this.scrubTimer = setTimeout(() => { this.scrubTimer = 0; if (this.scrubbing) this.align(true); }, 120);
  }
  renderBuffered() {
    let ranges = this.duration > 0 ? [[0, this.duration]] : [];
    const active = this.active();
    if (!active.length || SCREENS.some(s => state.visible.has(s.id) && (!this.loaded.has(s.id) || this.failed.has(s.id))) || active.some(({video}) => !Number.isFinite(video.duration))) ranges = [];
    for (const {video, offset, end} of active) {
      const available=[];
      for (let i=0;i<video.buffered.length;i++) {
        const a=Math.max(0,video.buffered.start(i)-offset), b=Math.min(this.duration,video.buffered.end(i)-offset,end>0?end-offset:Infinity);
        if (b>a) available.push([a,b]);
      }
      ranges = ranges.flatMap(([a,b]) => available.map(([c,d]) => [Math.max(a,c),Math.min(b,d)]).filter(([x,y]) => y>x));
      if (!ranges.length) break;
    }
    const signature=JSON.stringify([Math.round(this.duration*10),ranges.map(([a,b])=>[Math.round(a*10),Math.round(b*10)])]);
    if (signature===this.bufferSignature) return;
    this.bufferSignature=signature;
    $('buffered-ranges').replaceChildren(...ranges.map(([a,b])=>{const span=document.createElement('span');span.className='buffered-range';span.style.left=`${a/this.duration*100}%`;span.style.width=`${(b-a)/this.duration*100}%`;return span;}));
  }
  scheduleRecovery() {
    if (this.recoveryTimer) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = 0;
      if (this.intent && this.buffering && state.view === 'player') { this.tryPlay(); this.scheduleRecovery(); }
    }, 500);
  }
  async tryPlay() {
    if (!this.intent || this.attempting || this.scrubbing || state.view !== 'player') return;
    const active = this.active();
    if (!active.length) { this.intent = false; this.updateUI(); return; }
    if (active.some(({ video }) => video.readyState < 3 || video.seeking)) { this.buffering = true; this.pauseVideos(); this.setStatus('緩衝中 · 全部畫面同步等候'); this.updateUI(); this.scheduleRecovery(); return; }
    this.attempting = true; this.buffering = false;
    this.align();
    if (active.some(({ video }) => video.seeking)) { this.attempting = false; this.buffering = true; this.updateUI(); this.scheduleRecovery(); return; }
    const generation = this.generation;
    const results = await Promise.allSettled(active.map(({ video }) => { video.playbackRate = this.speed; return video.play(); }));
    if (generation !== this.generation) return;
    this.attempting = false;
    if (!this.intent || state.view !== 'player') { this.pauseVideos(); this.updateUI(); return; }
    if (results.some(r => r.status === 'rejected')) { this.intent = false; this.pauseVideos(); notify('瀏覽器暫停了播放，請再按一次播放鍵。'); this.setStatus('已暫停'); }
    else if (active.some(({ video }) => video.readyState < 3)) { this.pauseVideos(); this.buffering = true; this.setStatus('緩衝中 · 全部畫面同步等候'); this.scheduleRecovery(); }
    else if (this.buffering) { this.buffering = false; this.tryPlay(); }
    else { active.forEach(({id}) => { document.querySelector(`[data-panel="${id}"] .media-loading`).hidden = true; }); this.setStatus('同步播放中'); cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(this.tick); }
    this.updateUI();
  }
  play() { if (!this.duration) return; if (this.time >= this.duration - .08) { this.time = 0; this.align(); } this.intent = true; this.tryPlay(); }
  pause() { this.intent = false; this.buffering = false; this.pauseVideos(); this.setStatus(this.loaded.size ? '已暫停' : '等待影片載入'); this.updateUI(); }
  tick(now) {
    if (!this.intent || this.buffering || state.view !== 'player') return;
    const active = this.active(), master = active[0]; if (!master) { this.pause(); return; }
    this.time = Math.max(0, master.video.currentTime - master.offset);
    if (this.time >= this.duration - .06) { this.time = this.duration; this.pause(); return; }
    if (now - this.lastCheck > 250) {
      this.lastCheck = now;
      for (const entry of active.slice(1)) { const drift = entry.video.currentTime - entry.offset - this.time; if (!entry.video.seeking && Math.abs(drift) > .4) { entry.video.currentTime = this.time + entry.offset; } }
      this.updateUI();
    }
    this.raf = requestAnimationFrame(this.tick);
  }
  seek(time) { this.time = Math.min(this.duration, Math.max(0, Number(time))); this.pauseVideos(); this.align(); this.updateUI(); if (this.intent && !this.scrubbing) this.tryPlay(); }
  toggleScreen(id) {
    this.generation++; this.attempting = false; this.pauseVideos();
    if (state.visible.has(id)) this.loadScreen(id); else this.unloadScreen(id);
    this.recalculate(); this.align(); if (this.intent) this.tryPlay();
  }
  changeQuality() {
    const time = this.time, intent = this.intent; this.generation++; this.attempting = false; this.pauseVideos();
    SCREENS.forEach(s => this.unloadScreen(s.id)); this.time = time; this.intent = intent;
    SCREENS.filter(s => state.visible.has(s.id)).forEach(s => this.loadScreen(s.id)); this.recalculate();
    notify(state.quality === 'low' ? '優先使用省流量版本；未提供時使用原影片。' : state.quality === 'high' ? '已切換原畫質。' : '依網路狀態優先選擇影片版本。');
  }
  updateUI() {
    const enabled = this.duration > 0 && this.active().length > 0;
    $('play-pause').disabled = !enabled; $('replay').disabled = !enabled; $('timeline').disabled = !enabled;
    $('play-pause').classList.toggle('is-playing', this.intent); $('play-pause').setAttribute('aria-label', this.intent ? '暫停' : '播放');
    $('play-pause').querySelector('use').setAttribute('href', this.intent ? '#i-pause' : '#i-play');
    $('timeline').max = this.duration || 100; $('timeline').value = this.time; $('timeline-played').style.width = `${this.duration ? this.time / this.duration * 100 : 0}%`; this.renderBuffered();
    const format = t => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    $('time-display').replaceChildren(document.createTextNode(`${format(this.time)} `), Object.assign(document.createElement('span'), { textContent: `/ ${format(this.duration)}` }));
    if (!this.loaded.size) this.setStatus('等待影片載入');
    else if (!this.intent && enabled) this.setStatus(`已就緒 · ${this.active().length} 個畫面`);
  }
}
const player = new SynchronizedPlayer();
function routeLoadSignature() {
  return JSON.stringify([currentKey(), currentAssets(), [...state.visible], state.quality]);
}
function prepareSelectedRoute(route) {
  const key = currentKey();
  if (!route?.hasVideo) {
    if (preloadedSignature) { player.unload(); preloadedSignature = ''; }
    return;
  }
  if (!SCREENS.some(({id}) => validMediaURL(chooseSource(currentAssets()[id], state.quality, navigator.connection)))) return;
  const signature = routeLoadSignature();
  if (signature === preloadedSignature) return;
  player.loadRoute();
  preloadedSignature = signature;
}
function renderScreens() {
  SCREENS.forEach(s => { document.querySelector(`[data-panel="${s.id}"]`).hidden = !state.visible.has(s.id); document.querySelector(`[data-screen="${s.id}"]`).setAttribute('aria-pressed', String(state.visible.has(s.id))); });
  for (const id of ['google','nav']) $(`sound-${id}`).disabled = !state.visible.has(id);
  $('screens').dataset.count = state.visible.size; $('screens').dataset.real = state.visible.has('real');
}

function chooseCase(route){
  state.from=route.from;state.to=route.to;state.vehicle=route.vehicle;state.selecting='to';
  if($('cases-dialog').open)$('cases-dialog').close();
  renderMap();
}
function buildCasePicker(){
  for(const vehicle of ['car','scooter']){
    const section=document.createElement('section'),heading=document.createElement('h3'),grid=document.createElement('div');
    heading.textContent=`${VEHICLES[vehicle]} · ${ROUTE_CASES.filter(r=>r.vehicle===vehicle).length}組`; grid.className='case-grid';
    for(const route of ROUTE_CASES.filter(r=>r.vehicle===vehicle)){
      const button=document.createElement('button');button.dataset.case=route.key;button.className='case-choice';
      button.setAttribute('aria-label',`${endpoint(route.from).letter}往${endpoint(route.to).letter} ${VEHICLES[vehicle]}`);
      const name=document.createElement('strong'),status=document.createElement('small');
      name.textContent=`${endpoint(route.from).letter} → ${endpoint(route.to).letter}`;status.textContent=`${endpoint(route.from).name}\n→ ${endpoint(route.to).name}`;
      button.append(name,status);button.onclick=()=>chooseCase(route);grid.append(button);
    }
    section.append(heading,grid);$('case-groups').append(section);
  }
}
function renderCaseReviews(){
  $$('[data-case]').forEach(button=>{
    button.setAttribute('aria-pressed',String(button.dataset.case===currentKey()));
  });
}
function initEvents() {
  $('route-counter').onclick=()=>{$('cases-dialog').showModal();};
  for(const [id,delta] of [['previous-case',-1],['next-case',1]])$(id).onclick=()=>{
    const index=ROUTE_CASES.findIndex(r=>r.key===currentKey());
    const next=ROUTE_CASES[index+delta];if(next)chooseCase(next);
  };

  $('edit-origin').onclick = () => { if (state.from) clearEndpoint('from'); else { state.selecting = 'from'; renderMap(); document.querySelector('.map-node').focus({ preventScroll: true }); } };
  $('edit-destination').onclick = () => { if (state.to) { clearEndpoint('to'); return; } if (!state.from) { notify('請先選擇出發地。'); return; } state.selecting = 'to'; renderMap(); };
  $('clear-route').onclick = () => { state.from = null; state.to = null; state.selecting = 'from'; renderMap(); document.querySelector('.map-node').focus({ preventScroll: true }); notify('已清除起終點'); };
  $('swap-route').onclick = () => { [state.from, state.to] = [state.to, state.from]; renderMap(); };
  $$('[data-vehicle]').forEach(b => b.onclick = () => { state.vehicle = b.dataset.vehicle; renderMap(); });
  $('zoom-in').onclick = () => zoomMap(state.zoom + .15); $('zoom-out').onclick = () => zoomMap(state.zoom - .15); $('map-reset').onclick = () => zoomMap(1);
  $('labels-toggle').onclick = () => { const enabled = $('labels-toggle').getAttribute('aria-pressed') !== 'true'; $('labels-toggle').setAttribute('aria-pressed', enabled); $('map-viewport').classList.toggle('labels-hidden', !enabled); };
  $('preview-route').onclick = () => { if(previewFrame){ stopPreview(); return; } const route=currentGeometry(); if(route?.status!=='ready')return; if(previewDistance>=route.routeD.at(-1))previewDistance=0; $('route-cursor').toggleAttribute('hidden',false); $('preview-route').textContent='暫停預覽'; previewFrame=requestAnimationFrame(tickPreview); };
  $('start-route').onclick = () => enterRoute({ skipAnimation: true }); $('skip-intro').onclick = finishIntro;
  for (const id of ['back-map', 'change-route', 'nav-explore']) $(id).onclick = backToMap;
  $$('[data-close-dialog]').forEach(b => b.onclick = () => b.closest('dialog').close());
  $$('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target !== dialog) return; const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); }));
  $$('[data-screen]').forEach(b => b.onclick = () => { const id = b.dataset.screen; if (state.visible.has(id)) { if (state.visible.size === 1) { notify('至少保留一個觀看畫面。'); return; } state.visible.delete(id); } else state.visible.add(id); renderScreens(); player.toggleScreen(id); });
  $('play-pause').onclick = () => player.intent ? player.pause() : player.play();
  $('replay').onclick = () => player.seek(0);
  $('timeline').addEventListener('pointerdown', () => { player.scrubbing = true; player.pauseVideos(); });
  $('timeline').addEventListener('input', event => { if (player.scrubbing) player.previewScrub(event.target.value); else player.seek(event.target.value); });
  const endScrub = () => { if (player.scrubbing) { clearTimeout(player.scrubTimer); player.scrubTimer=0; player.scrubbing = false; player.seek($('timeline').value); } };
  window.addEventListener('pointerup', endScrub); window.addEventListener('pointercancel', endScrub); $('timeline').addEventListener('change', endScrub);
  $('speed').onchange = e => { player.speed = Number(e.target.value); player.active().forEach(({ video }) => video.playbackRate = player.speed); };
  $('quality').onchange = e => { state.quality = e.target.value; player.changeQuality(); };
  for (const id of ['google','nav']) $(`sound-${id}`).onchange = event => { $(`video-${id}`).muted = !event.target.checked; $('video-real').muted = true; };
  $('fullscreen').onclick = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else if ($('player-shell').requestFullscreen) await $('player-shell').requestFullscreen(); else notify('此瀏覽器不支援整頁全螢幕。'); } catch { notify('目前瀏覽器無法開啟全螢幕。'); } };
  $$('[data-retry]').forEach(b => b.onclick = () => { const id = b.dataset.retry; player.unloadScreen(id); player.loadScreen(id); player.updateUI(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { stopPreview(); if(player.intent)player.pause(); } });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && state.view === 'intro') finishIntro();
    if (state.view !== 'player' || $$('dialog[open]').length || /INPUT|SELECT|TEXTAREA|BUTTON/.test(event.target.tagName)) return;
    if (event.code === 'Space') { event.preventDefault(); if (player.duration) player.intent ? player.pause() : player.play(); }
    if (event.code === 'ArrowRight' && player.duration) { event.preventDefault(); player.seek(player.time + 5); }
    if (event.code === 'ArrowLeft' && player.duration) { event.preventDefault(); player.seek(player.time - 5); }
  });
}
buildNodes(); buildCasePicker(); initEvents(); renderMap();
fetch('./basemap.json').then(r => { if (!r.ok) throw new Error('basemap'); return r.json(); }).then(renderBaseMap).catch(() => notify('道路底圖載入失敗，請重新整理'));
fetch('./route-geometry.json', {cache:'no-cache'}).then(r=>{ if(!r.ok)throw new Error('geometry'); return r.json(); }).then(data=>{ geometry=data; geometryState='ready'; renderMap(); }).catch(()=>{ geometryState='error'; renderMap(); });
fetch('./routes.json', { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error('manifest'); return r.json(); }).then(data => { manifest = data; renderMap(); if (state.view === 'player') player.loadRoute(); }).catch(() => notify('影片設定未能載入。'));

