import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalizePlaces, placesToGeoJSON } from './place_merge.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = path.join(root, 'public', 'data', 'places')
const outputPath = path.join(outputDir, 'places.json')
const rawOutputPath = path.join(outputDir, 'raw-places.json')
const geoJsonOutputPath = path.join(outputDir, 'places.geojson')
const overridesPath = path.join(outputDir, 'place_overrides.json')
const roadDatabasePath = path.join(root, 'public', 'data', 'road_database.json')
const envPath = path.join(root, '.env.local')

const OVERPASS_ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
]

const TDX_AUTH_URL =
  'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token'
const TDX_API_ROOT = 'https://tdx.transportdata.tw/api'

const args = new Set(process.argv.slice(2))
const osmOnly = args.has('--osm-only')
const tdxOnly = args.has('--tdx-only')
const rebuildOnly = args.has('--rebuild')
const updateOsm = !tdxOnly && !rebuildOnly
const updateTdx = !osmOnly && !rebuildOnly

if (args.has('--help')) {
  console.log(`LaneDev 地標資料手動更新

用法：
  npm run places:update             更新 OSM 與 TDX
  npm run places:update -- --osm-only
  npm run places:update -- --tdx-only
  npm run places:update -- --rebuild 只套用合併規則與人工 override

TDX 認證由 .env.local 或環境變數讀取：
  TDX_CLIENT_ID=...
  TDX_CLIENT_SECRET=...
`)
  process.exit(0)
}

if ([osmOnly, tdxOnly, rebuildOnly].filter(Boolean).length > 1) {
  throw new Error('--osm-only、--tdx-only 與 --rebuild 不能同時使用')
}

async function loadLocalEnv() {
  try {
    const text = await fs.readFile(envPath, 'utf8')
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
      if (!match || process.env[match[1]] !== undefined) continue
      let value = match[2].trim()
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      process.env[match[1]] = value
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function uniqueStrings(values) {
  return [...new Set(values.flatMap((value) =>
    typeof value === 'string'
      ? value.split(';').map((part) => part.trim()).filter(Boolean)
      : [],
  ))]
}

function textOf(value) {
  if (typeof value === 'string') return value.trim()
  if (!value || typeof value !== 'object') return ''
  return String(value.Zh_tw ?? value.ZhTw ?? value.zh_tw ?? value.En ?? '').trim()
}

function firstText(record, keys) {
  for (const key of keys) {
    const value = textOf(record?.[key])
    if (value) return value
  }
  return ''
}

function addressFromOsm(tags) {
  if (tags['addr:full']) return tags['addr:full']
  const street = tags['addr:street'] ?? tags['addr:place'] ?? ''
  const number = tags['addr:housenumber'] ?? ''
  return [tags['addr:city'], tags['addr:district'], street, number]
    .filter(Boolean).join('')
}

function osmCategory(tags) {
  const amenity = tags.amenity
  if (['restaurant', 'cafe', 'fast_food', 'food_court', 'bar', 'pub', 'ice_cream']
    .includes(amenity)) return 'food'
  if (['school', 'university', 'college', 'kindergarten', 'library', 'music_school']
    .includes(amenity)) return 'education'
  if (['hospital', 'clinic', 'doctors', 'dentist', 'pharmacy', 'veterinary']
    .includes(amenity) || tags.healthcare) return 'medical'
  if (['townhall', 'police', 'fire_station', 'courthouse', 'post_office', 'community_centre']
    .includes(amenity) || tags.office === 'government') return 'government'
  if (['parking', 'parking_entrance', 'bicycle_parking', 'motorcycle_parking']
    .includes(amenity)) return 'parking'
  if (['bus_station', 'ferry_terminal', 'taxi', 'fuel', 'charging_station']
    .includes(amenity) || tags.public_transport || tags.railway) return 'transport'
  if (tags.shop) return 'shopping'
  if (tags.tourism || tags.historic) return 'tourism'
  if (tags.leisure) return 'recreation'
  if (tags.office || tags.craft) return 'service'
  return 'other'
}

function osmRawCategory(tags) {
  for (const key of [
    'amenity', 'shop', 'tourism', 'leisure', 'healthcare',
    'public_transport', 'railway', 'office', 'historic', 'craft',
  ]) {
    if (tags[key]) return `${key}=${tags[key]}`
  }
  return 'other'
}

function normalizeOsm(osm, fetchedAt) {
  return (osm.elements ?? []).flatMap((element) => {
    const tags = element.tags ?? {}
    const name = tags['name:zh'] ?? tags.name ?? tags.brand
    const point = element.type === 'node'
      ? [element.lon, element.lat]
      : [element.center?.lon, element.center?.lat]
    if (!name || !point.every(Number.isFinite)) return []
    return [{
      id: `osm:${element.type}:${element.id}`,
      source: 'osm',
      sourceId: `${element.type}/${element.id}`,
      name,
      aliases: uniqueStrings([
        tags.name, tags['name:zh'], tags['name:en'], tags.short_name,
        tags.alt_name, tags.old_name, tags.brand, tags.operator,
      ]).filter((value) => value !== name),
      category: osmCategory(tags),
      position: point,
      address: addressFromOsm(tags) || undefined,
      phone: tags.phone ?? tags['contact:phone'] ?? undefined,
      website: tags.website ?? tags['contact:website'] ?? undefined,
      openingHours: tags.opening_hours ?? undefined,
      fetchedAt,
      rawCategory: osmRawCategory(tags),
    }]
  })
}

const OSM_QUERY = `[out:json][timeout:120];
area(3602106299)->.nanzih;
area(3602106266)->.zuoying;
(.nanzih; .zuoying;)->.searchAreas;
(
  nwr(area.searchAreas)["name"]["amenity"];
  nwr(area.searchAreas)["name"]["shop"];
  nwr(area.searchAreas)["name"]["tourism"];
  nwr(area.searchAreas)["name"]["leisure"];
  nwr(area.searchAreas)["name"]["office"];
  nwr(area.searchAreas)["name"]["healthcare"];
  nwr(area.searchAreas)["name"]["public_transport"];
  nwr(area.searchAreas)["name"]["railway"~"^(station|halt|tram_stop|subway_entrance)$"];
  nwr(area.searchAreas)["name"]["historic"];
  nwr(area.searchAreas)["name"]["craft"];
);
out center qt;`

async function fetchOsm(fetchedAt) {
  const failures = []
  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'user-agent': 'LaneDev/0.2 manual-place-updater',
          },
          body: new URLSearchParams({ data: OSM_QUERY }),
        })
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 180)}`)
        }
        const places = normalizeOsm(await response.json(), fetchedAt)
        if (!places.length) throw new Error('回傳資料沒有可用的具名地標')
        return { places, endpoint }
      } catch (error) {
        failures.push(`${endpoint} 第 ${attempt} 次：${error}`)
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1800))
      }
    }
  }
  throw new Error(`OSM Overpass 更新失敗\n${failures.join('\n')}`)
}

function roadBounds(database) {
  const bounds = {
    minLng: Infinity, minLat: Infinity,
    maxLng: -Infinity, maxLat: -Infinity,
  }
  for (const segment of database.segments ?? []) {
    for (const point of segment.geometry?.coordinates ?? []) {
      bounds.minLng = Math.min(bounds.minLng, Number(point[0]))
      bounds.minLat = Math.min(bounds.minLat, Number(point[1]))
      bounds.maxLng = Math.max(bounds.maxLng, Number(point[0]))
      bounds.maxLat = Math.max(bounds.maxLat, Number(point[1]))
    }
  }
  if (!Object.values(bounds).every(Number.isFinite)) throw new Error('無法取得路網範圍')
  return bounds
}

function inBounds(position, bounds, padding = 0.006) {
  return position[0] >= bounds.minLng - padding && position[0] <= bounds.maxLng + padding &&
    position[1] >= bounds.minLat - padding && position[1] <= bounds.maxLat + padding
}

function positionOf(record, keys) {
  for (const key of keys) {
    const value = record?.[key]
    if (!value || typeof value !== 'object') continue
    const lng = Number(value.PositionLon ?? value.Longitude ?? value.Lon ?? value.X)
    const lat = Number(value.PositionLat ?? value.Latitude ?? value.Lat ?? value.Y)
    if (Number.isFinite(lng) && Number.isFinite(lat)) return [lng, lat]
  }
  const lng = Number(record?.PositionLon ?? record?.Longitude ?? record?.Lon)
  const lat = Number(record?.PositionLat ?? record?.Latitude ?? record?.Lat)
  return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null
}

const TDX_DATASETS = [
  {
    key: 'attraction', category: 'tourism',
    urls: ['/tourism/service/odata/V2/Tourism/Attraction'],
    pageSize: 500, spatialFilter: true,
    collectionKeys: ['Attractions', 'ScenicSpots'],
    idKeys: ['AttractionID', 'ScenicSpotID'],
    nameKeys: ['AttractionName', 'ScenicSpotName'],
    positionKeys: ['AttractionPosition', 'ScenicSpotPosition', 'Position'],
  },
  {
    key: 'restaurant', category: 'food',
    urls: ['/tourism/service/odata/V2/Tourism/Restaurant'],
    pageSize: 500, spatialFilter: true,
    collectionKeys: ['Restaurants'],
    idKeys: ['RestaurantID'], nameKeys: ['RestaurantName'],
    positionKeys: ['RestaurantPosition', 'Position'],
  },
  {
    key: 'hotel', category: 'tourism',
    urls: ['/tourism/service/odata/V2/Tourism/Hotel'],
    pageSize: 500, spatialFilter: true,
    collectionKeys: ['Hotels'],
    idKeys: ['HotelID'], nameKeys: ['HotelName'],
    positionKeys: ['HotelPosition', 'Position'],
  },
  {
    key: 'tourism-service', category: 'service',
    urls: ['/tourism/service/odata/V2/Tourism/TourismServiceSite'],
    pageSize: 500, spatialFilter: true,
    collectionKeys: ['TourismServiceSites'],
    idKeys: ['TourismServiceSiteID', 'ServiceSiteID'],
    nameKeys: ['TourismServiceSiteName', 'ServiceSiteName'],
    positionKeys: ['TourismServiceSitePosition', 'ServiceSitePosition', 'Position'],
  },
  {
    key: 'tra-station', category: 'transport',
    urls: ['/basic/v2/Rail/TRA/Station'],
    collectionKeys: ['Stations'],
    idKeys: ['StationID'], nameKeys: ['StationName'],
    positionKeys: ['StationPosition', 'Position'],
    addressKeys: ['StationAddress', 'Address'],
  },
  {
    key: 'krtc-station', category: 'transport',
    urls: ['/basic/v2/Rail/Metro/Station/KRTC'],
    collectionKeys: ['Stations'],
    idKeys: ['StationID'], nameKeys: ['StationName'],
    positionKeys: ['StationPosition', 'Position'],
    addressKeys: ['StationAddress', 'Address'],
  },
  {
    key: 'bus-station', category: 'transport', optional: true,
    urls: ['/basic/v2/Bus/Station/City/Kaohsiung'],
    collectionKeys: ['Stations'],
    idKeys: ['StationID'], nameKeys: ['StationName'],
    positionKeys: ['StationPosition', 'Position'],
    addressKeys: ['StationAddress', 'Address'],
  },
  {
    key: 'car-park', category: 'parking',
    urls: ['/basic/v1/Parking/OffStreet/CarPark/City/Kaohsiung'],
    collectionKeys: ['CarParks'],
    idKeys: ['CarParkID'], nameKeys: ['CarParkName'],
    positionKeys: ['CarParkPosition', 'Position'],
    addressKeys: ['CarParkAddress', 'Address'],
  },
]

function extractRecords(json, preferredKeys) {
  if (Array.isArray(json)) return json
  for (const key of preferredKeys) if (Array.isArray(json?.[key])) return json[key]
  const arrays = Object.values(json ?? {}).filter(Array.isArray)
  return arrays.sort((a, b) => b.length - a.length)[0] ?? []
}

function addressText(value) {
  if (typeof value === 'string') return value.trim()
  if (!value || typeof value !== 'object') return ''
  const full = firstText(value, ['FullAddress', 'Address', 'StreetAddress'])
  if (full) return full
  return uniqueStrings([
    firstText(value, ['City', 'County']),
    firstText(value, ['Town', 'District']),
    firstText(value, ['Road', 'Street']),
  ]).join('')
}

function firstAddress(record, keys) {
  for (const key of keys) {
    const address = addressText(record?.[key])
    if (address) return address
  }
  return ''
}

function normalizeTdxRecords(records, dataset, fetchedAt, bounds) {
  return records.flatMap((record, index) => {
    const name = firstText(record, dataset.nameKeys)
    const sourceId = firstText(record, dataset.idKeys) || String(index)
    const position = positionOf(record, dataset.positionKeys)
    if (!name || !position || !inBounds(position, bounds)) return []
    const aliases = uniqueStrings([
      ...dataset.nameKeys.map((key) => {
        const value = record[key]
        return value && typeof value === 'object' ? value.En : ''
      }),
    ]).filter((value) => value !== name)
    return [{
      id: `tdx:${dataset.key}:${sourceId}`,
      source: 'tdx',
      sourceId: `${dataset.key}/${sourceId}`,
      name,
      aliases,
      category: dataset.category,
      position,
      address: firstAddress(
        record,
        dataset.addressKeys ?? ['PostalAddress', 'Address', 'Location'],
      ) || undefined,
      phone: firstText(record, ['Phone', 'Telephone']) || undefined,
      website: firstText(record, ['WebsiteURL', 'WebsiteUrl', 'Website', 'Url']) || undefined,
      openingHours: firstText(record, ['OpenTime', 'OpeningHours']) || undefined,
      updatedAt: firstText(record, ['UpdateTime', 'SrcUpdateTime']) || undefined,
      fetchedAt,
      rawCategory: `tdx:${dataset.key}`,
    }]
  })
}

async function getTdxToken() {
  const clientId = process.env.TDX_CLIENT_ID?.trim()
  const clientSecret = process.env.TDX_CLIENT_SECRET?.trim()
  if (!clientId || !clientSecret) {
    throw new Error('缺少 TDX_CLIENT_ID 或 TDX_CLIENT_SECRET；請設定在 .env.local')
  }
  const response = await fetch(TDX_AUTH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  })
  if (!response.ok) throw new Error(`TDX 認證失敗：HTTP ${response.status}`)
  const json = await response.json()
  if (!json.access_token) throw new Error('TDX 認證回應沒有 access_token')
  return json.access_token
}

function tdxSpatialFilter(bounds, padding = 0.006) {
  return [
    `PositionLon ge ${bounds.minLng - padding}`,
    `PositionLon le ${bounds.maxLng + padding}`,
    `PositionLat ge ${bounds.minLat - padding}`,
    `PositionLat le ${bounds.maxLat + padding}`,
  ].join(' and ')
}

async function fetchTdxResponse(url, token) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'accept-encoding': 'gzip',
      },
    })
    if (response.status !== 429 || attempt === 4) return response
    const retryAfter = Number(response.headers.get('retry-after'))
    const waitMs = Number.isFinite(retryAfter)
      ? Math.min(Math.max(retryAfter * 1000, 1000), 30000)
      : 15000 * attempt
    console.warn(`    TDX 流量限制，${Math.ceil(waitMs / 1000)} 秒後重試...`)
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }
  throw new Error('無法取得 TDX 回應')
}

async function fetchTdxDataset(dataset, token, bounds) {
  const failures = []
  for (const relativeUrl of dataset.urls) {
    try {
      const records = []
      const pageSize = dataset.pageSize ?? 30000
      for (let skip = 0, page = 1; page <= 200; skip += pageSize, page += 1) {
        const url = new URL(`${TDX_API_ROOT}${relativeUrl}`)
        url.searchParams.set('$top', String(pageSize))
        if (dataset.pageSize) url.searchParams.set('$skip', String(skip))
        if (dataset.spatialFilter) {
          url.searchParams.set('$filter', tdxSpatialFilter(bounds))
        }
        const response = await fetchTdxResponse(url, token)
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`)
        }
        const pageRecords = extractRecords(await response.json(), dataset.collectionKeys)
        if (!Array.isArray(pageRecords)) throw new Error('回應中找不到資料陣列')
        records.push(...pageRecords)
        if (!dataset.pageSize || pageRecords.length < pageSize) break
        if (page === 200) throw new Error('分頁超過安全上限 200 頁')
      }
      return { records, relativeUrl }
    } catch (error) {
      failures.push(`${relativeUrl}: ${error}`)
    }
  }
  if (dataset.optional) {
    console.warn(`  略過 ${dataset.key}：${failures.join('；')}`)
    return null
  }
  throw new Error(`${dataset.key} 下載失敗：${failures.join('；')}`)
}

async function fetchTdx(fetchedAt, bounds) {
  const token = await getTdxToken()
  const places = []
  const datasets = []
  for (const dataset of TDX_DATASETS) {
    console.log(`  TDX ${dataset.key}...`)
    const result = await fetchTdxDataset(dataset, token, bounds)
    if (!result) continue
    const normalized = normalizeTdxRecords(result.records, dataset, fetchedAt, bounds)
    places.push(...normalized)
    datasets.push({
      key: dataset.key,
      endpoint: result.relativeUrl,
      received: result.records.length,
      included: normalized.length,
    })
  }
  if (!places.length) throw new Error('TDX 沒有取得目前路網範圍內的地標')
  return { places, datasets }
}

function validatePlaces(places, source) {
  if (!places.length) throw new Error(`${source} 地標數量為 0`)
  const ids = new Set()
  for (const place of places) {
    if (!place.id || !place.name) throw new Error(`${source} 有缺少 ID 或名稱的資料`)
    if (ids.has(place.id)) throw new Error(`${source} ID 重複：${place.id}`)
    ids.add(place.id)
    const [lng, lat] = place.position
    if (!Number.isFinite(lng) || !Number.isFinite(lat) ||
        lng < 118 || lng > 123 || lat < 21 || lat > 26) {
      throw new Error(`${source} 座標異常：${place.id}`)
    }
  }
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.tmp`
  await fs.writeFile(temporaryPath, `${JSON.stringify(value)}\n`)
  await fs.rename(temporaryPath, filePath)
}

function guardAgainstLargeDrop(previousPlaces, nextPlaces, source) {
  const previousCount = previousPlaces.filter((place) => place.source === source).length
  if (previousCount >= 20 && nextPlaces.length < previousCount * 0.25) {
    throw new Error(
      `${source} 數量由 ${previousCount} 降為 ${nextPlaces.length}，為避免覆蓋好資料已停止更新`,
    )
  }
}

await loadLocalEnv()
await fs.mkdir(outputDir, { recursive: true })

const fetchedAt = new Date().toISOString()
const roadDatabase = JSON.parse(await fs.readFile(roadDatabasePath, 'utf8'))
const bounds = roadBounds(roadDatabase)
const previous = await readJsonFile(outputPath)
const previousRaw = await readJsonFile(rawOutputPath)
const previousPlaces = Array.isArray(previousRaw?.places)
  ? previousRaw.places
  : Array.isArray(previous?.places) ? previous.places : []
const overrides = await readJsonFile(overridesPath) ?? {}

if (rebuildOnly && !previousPlaces.length) {
  throw new Error('沒有可重建的快取資料；請先執行一次 OSM／TDX 更新')
}

let osmPlaces = previousPlaces.filter((place) => place.source === 'osm')
let tdxPlaces = previousPlaces.filter((place) => place.source === 'tdx')
let osmMetadata = previousRaw?.sources?.osm ?? previous?.sources?.osm ?? null
let tdxMetadata = previousRaw?.sources?.tdx ?? previous?.sources?.tdx ?? null

if (updateOsm) {
  console.log('更新 OSM 地標（楠梓區＋左營區）...')
  const result = await fetchOsm(fetchedAt)
  validatePlaces(result.places, 'OSM')
  guardAgainstLargeDrop(previousPlaces, result.places, 'osm')
  osmPlaces = result.places
  osmMetadata = {
    fetchedAt,
    count: osmPlaces.length,
    endpoint: result.endpoint,
    license: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors',
  }
  console.log(`  OSM：${osmPlaces.length} 筆`)
}

if (updateTdx) {
  console.log('更新 TDX 地標...')
  const result = await fetchTdx(fetchedAt, bounds)
  validatePlaces(result.places, 'TDX')
  guardAgainstLargeDrop(previousPlaces, result.places, 'tdx')
  tdxPlaces = result.places
  tdxMetadata = {
    fetchedAt,
    count: tdxPlaces.length,
    datasets: result.datasets,
    attribution: '資料介接：交通部 TDX 平臺',
  }
  console.log(`  TDX：${tdxPlaces.length} 筆`)
}

const rawPlaceById = new Map()
for (const place of [...osmPlaces, ...tdxPlaces]) rawPlaceById.set(place.id, place)
const rawPlaces = [...rawPlaceById.values()].sort((a, b) => a.id.localeCompare(b.id))
const canonical = canonicalizePlaces(rawPlaces, overrides)
validatePlaces(canonical.places, '合併後')
for (const warning of canonical.warnings) console.warn(`  override 警告：${warning}`)

const countCanonicalForSource = (source) => canonical.places.filter((place) =>
  place.sourceRefs.some((reference) => reference.source === source),
).length
if (osmMetadata) osmMetadata.canonicalCount = countCanonicalForSource('osm')
if (tdxMetadata) tdxMetadata.canonicalCount = countCanonicalForSource('tdx')

const output = {
  schemaVersion: 2,
  generatedAt: fetchedAt,
  regions: roadDatabase.regions ?? [],
  bounds,
  sources: { osm: osmMetadata, tdx: tdxMetadata },
  mergeStats: canonical.stats,
  places: canonical.places,
}

const rawOutput = {
  schemaVersion: 1,
  generatedAt: fetchedAt,
  sources: { osm: osmMetadata, tdx: tdxMetadata },
  places: rawPlaces,
}
await writeJsonAtomic(rawOutputPath, rawOutput)
await writeJsonAtomic(geoJsonOutputPath, placesToGeoJSON(canonical.places))
await writeJsonAtomic(outputPath, output)

console.log(`完成：${outputPath}`)
console.log(
  `合併：${canonical.stats.rawCount} 筆原始資料 → ` +
  `${canonical.stats.canonicalCount} 筆地標（移除 ${canonical.stats.removedDuplicates} 筆重複）`,
)
console.log(`來源：OSM ${osmPlaces.length}、TDX ${tdxPlaces.length}`)
