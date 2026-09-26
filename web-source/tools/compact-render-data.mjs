import { simplify } from '@turf/turf'

// About 0.01 mm in latitude: remove redundant collinear samples, not road detail.
export const RENDER_TOLERANCE_DEGREES = 1e-10
export function renderPropertyKeys(style) {
  const keys = new Set(['osm_id', 'name', 'highway', 'lanes', 'oneway', 'maxspeed'])
  function walk(value) {
    if (Array.isArray(value)) {
      if ((value[0] === 'get' || value[0] === 'has') && typeof value[1] === 'string') keys.add(value[1])
      value.forEach(walk)
    } else if (value && typeof value === 'object') Object.values(value).forEach(walk)
  }
  walk(style.layers)
  return keys
}

export function compactRenderData(data, keys, keepAllProperties = false) {
  return { ...data, features: data.features.map(feature => {
    const geometry = ['LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'].includes(feature.geometry.type)
      ? simplify(feature, { tolerance: RENDER_TOLERANCE_DEGREES, highQuality: true }).geometry
      : feature.geometry
    return { ...feature, geometry, properties: keepAllProperties ? feature.properties
      : Object.fromEntries(Object.entries(feature.properties ?? {}).filter(([key]) => keys.has(key))) }
  }) }
}
