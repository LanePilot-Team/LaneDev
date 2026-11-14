// Locations verified against the five named places in Google Maps.
export const MAP_BOUNDS = [120.314, 22.718, 120.332, 22.731];
const mercatorY = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
export function project([lon, lat]) {
  const [west, south, east, north] = MAP_BOUNDS;
  const worldWidth = (east - west) * Math.PI / 180, worldHeight = mercatorY(north) - mercatorY(south);
  const scale = Math.min(840 / worldWidth, 580 / worldHeight);
  return [450 + (lon - (west + east) / 2) * Math.PI / 180 * scale, 320 + ((mercatorY(north) + mercatorY(south)) / 2 - mercatorY(lat)) * scale];
}
export const ENDPOINTS = [
  { id: 'north', letter: 'A', name: '都會公園捷運站', description: '北側・高楠公路', lon:120.321029, lat:22.72933, label:[405,70,195] },
  { id: 'station', letter: 'B', name: '楠梓火車站', description: '楠梓新路・建楠路229號', lon:120.32437, lat:22.727035, label:[625,150,200] },
  { id: 'east', letter: 'C', name: '健仁醫院', description: '東側・楠陽路136號', lon:120.3290217, lat:22.7236493, label:[700,295,185] },
  { id: 'south', letter: 'D', name: '中油楠梓直營站', description: '南側・高楠公路1376號', lon:120.3253565, lat:22.7194044, label:[590,525,200] },
  { id: 'west', letter: 'E', name: '後勁捷運站', description: '西側・加昌路178號', lon:120.3166, lat:22.72246, label:[35,325,190] },
].map(p => { const [x,y] = project([p.lon,p.lat]); return {...p,short:p.name,x,y}; });
export const SCREENS = [
  { id: 'real', name: '道路實景', ratio: '16:9' },
  { id: 'google', name: 'Google Maps', ratio: '9:16' },
  { id: 'nav', name: '車道導航', ratio: '9:16' },
];
export const VEHICLES = { car: '汽車', scooter: '機車' };
// Only the expressly requested directional vehicle combinations are selectable.
const letters = Object.fromEntries(ENDPOINTS.map(p => [p.letter, p.id]));
const requested = {
  car: ['AB','AC','AD','AE','BA','BD','BE','CA','CD','CE','DA','DB','DC','DE','EA','EC','ED'],
  scooter: ['AB','AC','AD','AE','BC','BD','CA','CB','CD','CE','DA','DB','DC','DE','EA','EB','EC','ED'],
};
export const ROUTE_CASES = Object.entries(requested).flatMap(([vehicle, pairs]) => pairs.map(pair => {
  const from=letters[pair[0]], to=letters[pair[1]], id=`${from}-${to}`;
  return {id,from,to,vehicle,key:`${id}:${vehicle}`,hasVideo:true};
}));
export const ROUTES = [...new Map(ROUTE_CASES.map(({id,from,to}) => [id,{id,from,to}])).values()];
export const routeCase = (from,to,vehicle) => ROUTE_CASES.find(route=>route.from===from&&route.to===to&&route.vehicle===vehicle);
export const endpoint = id => ENDPOINTS.find(point => point.id === id);
export const routeFor = (from, to) => ROUTES.find(route => route.from === from && route.to === to);
export function routePosition(route, distance = 0) {
  if (route?.status !== 'ready' || route.coordinates.length < 2) return null;
  const d = Math.max(0, Math.min(distance, route.routeD.at(-1)));
  let i = 1;
  while (i < route.routeD.length - 1 && route.routeD[i] < d) i++;
  const a = route.coordinates[i-1], b = route.coordinates[i];
  const t = (d - route.routeD[i-1]) / (route.routeD[i] - route.routeD[i-1] || 1);
  const coordinates = a.map((v,k) => v + (b[k]-v)*t);
  const [x,y] = project(a), [nx,ny] = project(b);
  return { coordinates, point:project(coordinates), heading:Math.atan2(nx-x,y-ny)*180/Math.PI };
}
export const cameraRotation = route => -(routePosition(route)?.heading || 0);
export function chooseSource(asset, quality, connection) {
  if (!asset) return '';
  if (quality === 'low' || (quality === 'auto' && (connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType || '') || (connection?.downlink > 0 && connection.downlink < 3)))) return asset.low || asset.src || '';
  return asset.src || asset.low || '';
}
export function validMediaURL(value) {
  if (!value || typeof value !== 'string') return false;
  try { const url = new URL(value, 'https://local.invalid/'); return ['http:', 'https:', 'blob:'].includes(url.protocol); } catch { return false; }
}
export function commonDuration(entries) {
  const lengths = entries.map(({ duration, offset = 0 }) => duration - offset).filter(length => Number.isFinite(length) && length > 0);
  return lengths.length ? Math.min(...lengths) : 0;
}
export const availableScreens = assets => SCREENS.filter(s => validMediaURL(assets?.[s.id]?.src) || validMediaURL(assets?.[s.id]?.low)).map(s => s.id);
