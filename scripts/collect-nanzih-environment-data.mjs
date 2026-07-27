import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import osmtogeojson from 'osmtogeojson'

const ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
]
const ADMINISTRATIVE_RELATION_ID = 2106299
const OVERPASS_AREA_ID = 3602106299
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = path.join(root, 'public', 'data', 'environment')

const queries = {
  green: `[out:json][timeout:180];
area(${OVERPASS_AREA_ID})->.a;
(
  way(area.a)["leisure"~"^(park|garden|playground|recreation_ground|nature_reserve)$"];
  relation(area.a)["leisure"~"^(park|garden|playground|recreation_ground|nature_reserve)$"];
  way(area.a)["landuse"~"^(village_green|forest|grass|meadow|farmland|orchard)$"];
  relation(area.a)["landuse"~"^(village_green|forest|grass|meadow|farmland|orchard)$"];
  way(area.a)["natural"~"^(wood|scrub|grassland|wetland)$"];
  relation(area.a)["natural"~"^(wood|scrub|grassland|wetland)$"];
);
out body;
>;
out skel qt;`,
  waterAreas: `[out:json][timeout:180];
area(${OVERPASS_AREA_ID})->.a;
(
  way(area.a)["natural"="water"];
  relation(area.a)["natural"="water"];
  way(area.a)["waterway"="riverbank"];
  relation(area.a)["waterway"="riverbank"];
  way(area.a)["natural"="wetland"];
  relation(area.a)["natural"="wetland"];
);
out body;
>;
out skel qt;`,
  waterways: `[out:json][timeout:180];
area(${OVERPASS_AREA_ID})->.a;
way(area.a)["waterway"~"^(river|stream|canal|drain|ditch)$"];
out body geom;`,
}

const usedEndpoints = new Set()

async function collect(query) {
  const failures = []
  for (const endpoint of ENDPOINTS) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'user-agent': 'LaneDev/0.2 one-time-environment-collector',
          },
          body: new URLSearchParams({ data: query }),
        })
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`)
        }
        usedEndpoints.add(endpoint)
        return response.json()
      } catch (error) {
        failures.push(`${endpoint} attempt ${attempt}: ${error}`)
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 2500))
      }
    }
  }
  throw new Error(`All Overpass endpoints failed:\n${failures.join('\n')}`)
}

function identity(feature) {
  const [osmType = 'way', osmId = ''] = String(feature.id ?? '').split('/')
  // osmtogeojson exposes OSM tags directly on feature.properties.
  const tags = { ...(feature.properties ?? {}) }
  delete tags.id
  return { osmType, osmId, tags }
}

function safeFeature(feature) {
  const type = feature.geometry?.type
  return feature.geometry && feature.geometry.coordinates
    && !feature.properties?.building
    && !feature.properties?.highway
    && ['Polygon', 'MultiPolygon', 'LineString', 'MultiLineString'].includes(type)
}

function greenClassification(tags) {
  const leisure = tags.leisure
  const landuse = tags.landuse
  const natural = tags.natural
  if (['park', 'recreation_ground'].includes(leisure) || landuse === 'village_green') {
    return ['park', 'high']
  }
  if (['garden', 'playground'].includes(leisure)) return ['garden', 'high']
  if (natural === 'wood' || landuse === 'forest') return ['forest_or_wood', 'medium']
  if (['grass', 'meadow'].includes(landuse) || natural === 'grassland') {
    return ['grass_or_meadow', 'medium']
  }
  if (['scrub', 'heath', 'wetland'].includes(natural) || leisure === 'nature_reserve') {
    return ['natural_green', 'medium']
  }
  if (['farmland', 'orchard'].includes(landuse)) return ['agricultural', 'low']
  return null
}

function waterClassification(tags) {
  if (tags.waterway === 'riverbank' || (tags.natural === 'water' && tags.water === 'river')) {
    return 'river'
  }
  if (tags.natural === 'water' && ['lake', 'reservoir'].includes(tags.water)) {
    return 'lake_or_reservoir'
  }
  if (tags.natural === 'water' && ['pond', 'basin'].includes(tags.water)) {
    return 'pond_or_basin'
  }
  if (tags.natural === 'wetland') return 'wetland'
  if (tags.natural === 'water') return 'water_unspecified'
  return null
}

function asCollection(features) {
  return { type: 'FeatureCollection', features }
}

function convertGreen(osm) {
  return osmtogeojson(osm).features.filter(safeFeature)
    .filter((feature) => ['Polygon', 'MultiPolygon'].includes(feature.geometry.type))
    .flatMap((feature) => {
      const { osmType, osmId, tags } = identity(feature)
      const category = greenClassification(tags)
      if (!category) return []
      return [{
        type: 'Feature',
        id: `${osmType}/${osmId}`,
        properties: {
          osm_id: osmId,
          osm_type: osmType,
          name: tags.name ?? null,
          feature_category: 'green_area',
          green_type: category[0],
          green_priority: category[1],
          source_tags: tags,
        },
        geometry: feature.geometry,
      }]
    })
}

function convertWaterAreas(osm) {
  return osmtogeojson(osm).features.filter(safeFeature)
    .filter((feature) => ['Polygon', 'MultiPolygon'].includes(feature.geometry.type))
    .flatMap((feature) => {
      const { osmType, osmId, tags } = identity(feature)
      const waterType = waterClassification(tags)
      if (!waterType || tags.natural === 'coastline') return []
      return [{
        type: 'Feature',
        id: `${osmType}/${osmId}`,
        properties: {
          osm_id: osmId,
          osm_type: osmType,
          name: tags.name ?? null,
          feature_category: 'water_area',
          water_type: waterType,
          source_tags: tags,
        },
        geometry: feature.geometry,
      }]
    })
}

function convertWaterways(osm) {
  return osmtogeojson(osm).features.filter(safeFeature)
    .filter((feature) => ['LineString', 'MultiLineString'].includes(feature.geometry.type))
    .flatMap((feature) => {
      const { osmType, osmId, tags } = identity(feature)
      if (!['river', 'stream', 'canal', 'drain', 'ditch'].includes(tags.waterway)) return []
      return [{
        type: 'Feature',
        id: `${osmType}/${osmId}`,
        properties: {
          osm_id: osmId,
          osm_type: osmType,
          name: tags.name ?? null,
          feature_category: 'waterway_line',
          waterway_type: tags.waterway,
          source_tags: tags,
        },
        geometry: feature.geometry,
      }]
    })
}

function countsBy(features, field) {
  return Object.fromEntries(features.reduce((counts, feature) => {
    const value = feature.properties[field]
    counts.set(value, (counts.get(value) ?? 0) + 1)
    return counts
  }, new Map()))
}

await fs.mkdir(outputDir, { recursive: true })
console.log('Collecting green areas...')
const greenOsm = await collect(queries.green)
console.log('Collecting water areas...')
const waterOsm = await collect(queries.waterAreas)
console.log('Collecting waterways...')
const waterwaysOsm = await collect(queries.waterways)

const green = convertGreen(greenOsm)
const waterAreas = convertWaterAreas(waterOsm)
const waterways = convertWaterways(waterwaysOsm)

await Promise.all([
  fs.writeFile(path.join(outputDir, 'nanzih_green_areas.geojson'), JSON.stringify(asCollection(green))),
  fs.writeFile(path.join(outputDir, 'nanzih_water_areas.geojson'), JSON.stringify(asCollection(waterAreas))),
  fs.writeFile(path.join(outputDir, 'nanzih_waterways.geojson'), JSON.stringify(asCollection(waterways))),
])

const metadata = {
  source: 'OpenStreetMap',
  extracted_at: new Date().toISOString(),
  administrative_relation_id: ADMINISTRATIVE_RELATION_ID,
  overpass_area_id: OVERPASS_AREA_ID,
  endpoint: [...usedEndpoints],
  query: queries,
  feature_counts: {
    green_areas: green.length,
    water_areas: waterAreas.length,
    waterways: waterways.length,
    green_types: countsBy(green, 'green_type'),
    water_types: countsBy(waterAreas, 'water_type'),
    waterway_types: countsBy(waterways, 'waterway_type'),
  },
  license: 'ODbL 1.0',
  attribution: '© OpenStreetMap contributors',
}
await fs.writeFile(
  path.join(outputDir, 'source-metadata.json'),
  JSON.stringify(metadata, null, 2),
)
console.log(JSON.stringify(metadata.feature_counts, null, 2))
