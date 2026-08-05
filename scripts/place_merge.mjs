const EARTH_RADIUS_M = 6_371_008.8

const CATEGORY_RANK = {
  transport: 110,
  medical: 100,
  education: 90,
  government: 80,
  tourism: 70,
  recreation: 60,
  parking: 50,
  food: 40,
  shopping: 35,
  service: 30,
  other: 10,
}

const DETAIL_CATEGORIES = new Set(['food', 'shopping', 'service', 'other'])
const GENERIC_NAMES = new Set([
  '全家便利商店', '萊爾富', '統一超商', '7eleven', '711', 'youbike', '微笑單車',
])

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === 'string')
    .map((value) => value.trim()).filter(Boolean))]
}

export function normalizePlaceName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-Hant')
    .replaceAll('臺', '台')
    .replace(/[s\p{P}\p{S}]+/gu, '')
}

export function distanceMeters(a, b) {
  const toRadians = (degrees) => degrees * Math.PI / 180
  const lat1 = toRadians(a[1])
  const lat2 = toRadians(b[1])
  const deltaLat = lat2 - lat1
  const deltaLng = toRadians(b[0] - a[0])
  const h = Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

function placeNames(place) {
  // 別名保留給搜尋使用，不作自動合併依據；同一站區的不同運輸系統
  // 常互相把名稱列為別名，拿來合併會把高鐵、臺鐵、捷運串成同一筆。
  return uniqueStrings([place.name])
    .map(normalizePlaceName).filter((name) => name.length >= 2)
}

function mergeDistance(a, b, matchedName) {
  if (a.category === 'transport' || b.category === 'transport') return 120
  if (a.category === 'parking' || b.category === 'parking') return 70
  if (DETAIL_CATEGORIES.has(a.category) || DETAIL_CATEGORIES.has(b.category)) {
    return GENERIC_NAMES.has(matchedName) ? 15 : 32
  }
  return 65
}

function categoriesCompatible(a, b) {
  if (a.category === b.category) return true
  if (a.category === 'transport' || b.category === 'transport') {
    return normalizePlaceName(a.name) === normalizePlaceName(b.name)
  }
  return ['tourism', 'service', 'other'].includes(a.category) ||
    ['tourism', 'service', 'other'].includes(b.category)
}

function pairKey(a, b) {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`
}

class UnionFind {
  constructor(size) {
    this.parent = Array.from({ length: size }, (_, index) => index)
    this.members = Array.from({ length: size }, (_, index) => new Set([index]))
  }

  find(index) {
    if (this.parent[index] !== index) this.parent[index] = this.find(this.parent[index])
    return this.parent[index]
  }

  union(a, b) {
    let rootA = this.find(a)
    let rootB = this.find(b)
    if (rootA === rootB) return rootA
    if (this.members[rootA].size < this.members[rootB].size) {
      [rootA, rootB] = [rootB, rootA]
    }
    this.parent[rootB] = rootA
    for (const member of this.members[rootB]) this.members[rootA].add(member)
    this.members[rootB].clear()
    return rootA
  }
}

function primaryScore(place) {
  const raw = place.rawCategory ?? ''
  let score = 0
  if (/tdx:(tra|krtc)-station/.test(raw)) score += 600
  else if (raw === 'railway=station') score += 560
  else if (/public_transport=station/.test(raw)) score += 520
  else if (/tdx:(attraction|hotel|car-park)/.test(raw)) score += 420
  else if (place.source === 'tdx') score += 300
  if (place.id.startsWith('osm:relation:')) score += 90
  else if (place.id.startsWith('osm:way:')) score += 60
  if (place.address) score += 25
  if (place.website) score += 10
  return score
}

function displayPriority(category, members, name) {
  const rawCategories = members.map((place) => place.rawCategory ?? '')
  if (category === 'transport') {
    if (rawCategories.some((raw) =>
      /tdx:(tra|krtc)-station|railway=station|public_transport=station/.test(raw)) ||
      /高鐵|火車站|車站|捷運站/.test(name)) return 100
    return 45
  }
  return {
    medical: 78,
    education: 72,
    government: 68,
    tourism: 65,
    recreation: 52,
    parking: 45,
    food: 28,
    shopping: 26,
    service: 24,
    other: 18,
  }[category] ?? 18
}

function tierForPriority(priority) {
  if (priority >= 90) return 'major'
  if (priority >= 60) return 'area'
  if (priority >= 35) return 'local'
  return 'detail'
}

function selectCategory(members) {
  return members.map((place) => place.category)
    .sort((a, b) => (CATEGORY_RANK[b] ?? 0) - (CATEGORY_RANK[a] ?? 0))[0] ?? 'other'
}

function newestText(members, key) {
  return members.map((place) => place[key]).filter(Boolean).sort().at(-1)
}

function canonicalId(primary) {
  return `place:${primary.id.replaceAll(':', '/')}`
}

function mergeGroup(members, override) {
  const ordered = [...members].sort((a, b) =>
    primaryScore(b) - primaryScore(a) || a.id.localeCompare(b.id),
  )
  const primary = ordered[0]
  const category = override?.category ?? selectCategory(members)
  const name = override?.name ?? primary.name
  const priority = override?.priority ?? displayPriority(category, members, name)
  const aliases = uniqueStrings(members.flatMap((place) => [place.name, ...(place.aliases ?? [])]))
    .filter((alias) => alias !== name)
  const sourceRefs = members.map((place) => ({
    source: place.source,
    sourceId: place.sourceId,
    id: place.id,
  })).sort((a, b) => a.id.localeCompare(b.id))
  const firstWith = (key) => ordered.find((place) => place[key])?.[key]
  return {
    ...primary,
    id: override?.id ?? canonicalId(primary),
    name,
    aliases,
    category,
    position: override?.position ?? primary.position,
    address: override?.address ?? firstWith('address'),
    phone: override?.phone ?? firstWith('phone'),
    website: override?.website ?? firstWith('website'),
    openingHours: override?.openingHours ?? firstWith('openingHours'),
    updatedAt: newestText(members, 'updatedAt'),
    fetchedAt: newestText(members, 'fetchedAt') ?? primary.fetchedAt,
    sourceRefs,
    memberIds: sourceRefs.map((reference) => reference.id),
    mergedCount: members.length,
    priority,
    tier: override?.tier ?? tierForPriority(priority),
    icon: override?.icon ?? `poi-${category}`,
    hidden: override?.hidden === true,
  }
}

function normalizeOverrides(overrides) {
  return {
    mergeGroups: Array.isArray(overrides?.mergeGroups) ? overrides.mergeGroups : [],
    keepSeparate: Array.isArray(overrides?.keepSeparate) ? overrides.keepSeparate : [],
    patches: Array.isArray(overrides?.patches) ? overrides.patches : [],
  }
}

export function canonicalizePlaces(rawPlaces, rawOverrides = {}) {
  const overrides = normalizeOverrides(rawOverrides)
  const byId = new Map(rawPlaces.map((place, index) => [place.id, index]))
  const unionFind = new UnionFind(rawPlaces.length)
  const warnings = []

  for (const group of overrides.mergeGroups) {
    const indexes = uniqueStrings(group.members ?? []).flatMap((id) => {
      const index = byId.get(id)
      if (index === undefined) {
        warnings.push(`mergeGroups ${group.id ?? '(未命名)'} 找不到 ${id}`)
        return []
      }
      return [index]
    })
    for (let index = 1; index < indexes.length; index += 1) {
      unionFind.union(indexes[0], indexes[index])
    }
  }

  const blockedPairs = new Set()
  for (const group of overrides.keepSeparate) {
    const ids = uniqueStrings(Array.isArray(group) ? group : [])
    for (let a = 0; a < ids.length; a += 1) {
      for (let b = a + 1; b < ids.length; b += 1) blockedPairs.add(pairKey(ids[a], ids[b]))
    }
  }
  const hasBlockedMembers = (rootA, rootB) => {
    for (const a of unionFind.members[rootA]) {
      for (const b of unionFind.members[rootB]) {
        if (blockedPairs.has(pairKey(rawPlaces[a].id, rawPlaces[b].id))) return true
      }
    }
    return false
  }

  const nameBuckets = new Map()
  rawPlaces.forEach((place, index) => {
    for (const name of placeNames(place)) {
      if (!nameBuckets.has(name)) nameBuckets.set(name, [])
      nameBuckets.get(name).push(index)
    }
  })
  const comparedPairs = new Set()
  for (const [matchedName, indexes] of nameBuckets) {
    for (let a = 0; a < indexes.length; a += 1) {
      for (let b = a + 1; b < indexes.length; b += 1) {
        const left = indexes[a]
        const right = indexes[b]
        const comparisonKey = pairKey(left, right)
        if (comparedPairs.has(comparisonKey)) continue
        comparedPairs.add(comparisonKey)
        const placeA = rawPlaces[left]
        const placeB = rawPlaces[right]
        if (!categoriesCompatible(placeA, placeB)) continue
        if (distanceMeters(placeA.position, placeB.position) >
            mergeDistance(placeA, placeB, matchedName)) continue
        const rootA = unionFind.find(left)
        const rootB = unionFind.find(right)
        if (rootA === rootB || hasBlockedMembers(rootA, rootB)) continue
        unionFind.union(rootA, rootB)
      }
    }
  }

  const groups = new Map()
  rawPlaces.forEach((place, index) => {
    const root = unionFind.find(index)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(place)
  })

  const mergeOverrideFor = (members) => overrides.mergeGroups.find((override) =>
    (override.members ?? []).some((id) => members.some((place) => place.id === id)),
  )
  const places = [...groups.values()].map((members) => {
    let canonical = mergeGroup(members, mergeOverrideFor(members))
    for (const patch of overrides.patches) {
      if (patch.matchId !== canonical.id && !canonical.memberIds.includes(patch.matchId)) continue
      const { matchId: _matchId, ...fields } = patch
      canonical = { ...canonical, ...fields }
    }
    canonical.tier = canonical.tier ?? tierForPriority(canonical.priority)
    canonical.icon = canonical.icon ?? `poi-${canonical.category}`
    return canonical
  }).sort((a, b) =>
    a.name.localeCompare(b.name, 'zh-Hant') || a.id.localeCompare(b.id),
  )

  const mergedGroups = places.filter((place) => place.mergedCount > 1).length
  return {
    places,
    warnings,
    stats: {
      rawCount: rawPlaces.length,
      canonicalCount: places.length,
      visibleCount: places.filter((place) => !place.hidden).length,
      mergedGroups,
      removedDuplicates: rawPlaces.length - places.length,
    },
  }
}

export function placesToGeoJSON(places) {
  return {
    type: 'FeatureCollection',
    features: places.filter((place) => !place.hidden).map((place) => ({
      type: 'Feature',
      id: place.id,
      properties: {
        id: place.id,
        name: place.name,
        category: place.category,
        icon: place.icon,
        priority: place.priority,
        tier: place.tier,
        sources: uniqueStrings(place.sourceRefs.map((reference) => reference.source)).join('+'),
        mergedCount: place.mergedCount,
      },
      geometry: { type: 'Point', coordinates: place.position },
    })),
  }
}
