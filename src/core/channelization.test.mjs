import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import {
  buildCappedTriangleRange, buildHatchDistances, buildOffsetTurnBayMarkings, channelizationKey, reviewKey,
  resolveChannelization, singleBayUnusedSideOffsets, TAIWAN_YELLOW_HATCH_V1,
} from './channelization.ts'
import { haversine, skewFromCross } from './geo.ts'

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
const { buildChannelization } = await vite.ssrLoadModule('/src/core/turnbays.ts')
after(() => vite.close())

const parent = 'way/7@node/9'
const bay = {
  key: parent,
  turns: 'left',
  bayLenM: 30,
  taperLenM: 15,
  widthM: 3,
  source: 'manual',
  singleMode: 'capped',
  back: false,
}

const record = (type, key, fields, seq) => ({
  seq,
  ts: '2026-07-29T00:00:00.000Z',
  author: 'test',
  op: 'set',
  target: { type, key },
  fields,
})

const fixtureStart = [120.3, 22.72]
const fixtureEnd = [120.3, 22.72108]
const fixtureTotalM = haversine(fixtureStart, fixtureEnd)
const fixtureSetbackM = 12
const fixtureCrossBearing = 100
const fixtureSkew = skewFromCross(0, fixtureCrossBearing)
const fixtureCenterHalfM = 1.5

function buildFixtureChannelization({
  forwardBay = true,
  singleMode = 'capped',
  journal = [],
  withBay = true,
  centerM = 3,
  centerKind = 'hatch',
  end = fixtureEnd,
} = {}) {
  const totalM = haversine(fixtureStart, end)
  const road = {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: [fixtureStart, end] },
    properties: {
      osm_id: 7,
      highway: 'primary',
      roadMarkingMode: 'all',
      centerM,
      centerKind,
      islandBayMode: false,
      coupletMerged: true,
      oneway: 'no',
    },
  }
  const edge = {
    coords: [fixtureStart, end],
    road,
    back: false,
    fromNode: 1,
    toNode: 2,
    startSetbackM: fixtureSetbackM,
    endSetbackM: fixtureSetbackM,
  }
  const graph = {
    scopeEdges: (scope) => scope(road) ? [edge] : [],
    crossOrientationAt: () => fixtureCrossBearing,
  }
  const bay = {
    key: forwardBay ? 'way/7@node/2' : 'way/7@node/1~b',
    wayId: 7,
    nodeId: forwardBay ? 2 : 1,
    approachBearing: forwardBay ? 0 : 180,
    kind: 'center',
    bayLenM: 30,
    taperLenM: 15,
    widthM: 3,
    turns: 'left',
    source: 'manual',
    offM: 0,
    d0M: 30,
    bayStartM: 45,
    endM: totalM - fixtureSetbackM,
    setbackM: fixtureSetbackM,
    back: !forwardBay,
    paired: false,
    singleMode,
    polygon: null,
    casing: null,
    arrows: [],
    lines: [],
  }
  return buildChannelization(graph, withBay ? [bay] : [], journal)
}

function stylesAndOwners(lines) {
  return lines.map(({ style, ownerKey }) => ({ style, ownerKey }))
}

const manualCentralBandJournal = [
  record('channelization', 'way/7@node/2#channelization', {
    mode: 'override',
    closure: 'unused-side',
    s_start_m: 3,
    s_end_m: 8,
    width_start_m: 0.1,
    width_end_m: 0.2,
  }, 1),
]

function distanceAlongFixture(coord) {
  return haversine(fixtureStart, [fixtureStart[0], coord[1]])
}

function lateralOffsetFromFixture(coord) {
  const magnitude = haversine([fixtureStart[0], coord[1]], coord)
  return Math.sign(coord[0] - fixtureStart[0]) * magnitude
}

function endpointNearestStation(line, stationM) {
  return line.coords.reduce((nearest, coord) =>
    Math.abs(distanceAlongFixture(coord) - stationM)
      < Math.abs(distanceAlongFixture(nearest) - stationM) ? coord : nearest)
}

test('one offset bay creates one review index record even without channelization', () => {
  assert.deepEqual(buildOffsetTurnBayMarkings([], [bay]), [{
    key: parent,
    offset_bay: {
      state: 'active', turns: 'left', source: 'manual', bay_len_m: 30,
      taper_len_m: 15, width_m: 3,
    },
    channelization: { state: 'none' },
    review: { status: 'unreviewed' },
  }])
})

test('channelization and review child records do not overwrite each other', () => {
  const records = [
    record('channelization', channelizationKey(parent), {
      mode: 'override', closure: 'unused-side', s_start_m: 8, s_end_m: 34,
      width_start_m: 0.2, width_end_m: 3,
    }, 1),
    record('approach_marking_review', reviewKey(parent), {
      status: 'verified', evidence_url: 'https://example.test/pano', note: '現地封閉',
    }, 2),
  ]
  const [actual] = buildOffsetTurnBayMarkings(records, [bay])
  assert.equal(actual.channelization.state, 'override')
  assert.equal(actual.channelization.closure, 'unused-side')
  assert.equal(actual.review.status, 'verified')
  assert.equal(actual.review.note, '現地封閉')
})

test('disabled channelization stays reviewable and produces no active geometry', () => {
  const [actual] = buildOffsetTurnBayMarkings([
    record('channelization', channelizationKey(parent), { mode: 'disabled' }, 1),
  ], [bay])
  assert.deepEqual(actual.channelization, { state: 'disabled' })
})

test('hatch distances retain the same 1.25 m pitch for narrow and wide tapered regions', () => {
  assert.deepEqual(buildHatchDistances(0.3, 5.4), [1.25, 2.5, 3.75, 5])
  assert.deepEqual(buildHatchDistances(0.3, 9.1), [1.25, 2.5, 3.75, 5, 6.25, 7.5, 8.75])
})

test('a hatch central band without turn bays fills its valid central range', () => {
  const hatches = buildFixtureChannelization({ withBay: false, centerM: 3.2 })
    .filter((line) => line.style === 'channel-hatch')

  assert.ok(hatches.length > 2)
  const stations = hatches.map((line) => distanceAlongFixture(line.coords[0]))
  for (let i = 1; i < stations.length; i++) {
    assert.ok(Math.abs(
      stations[i] - stations[i - 1] - TAIWAN_YELLOW_HATCH_V1.stripePitchM,
    ) < 0.02)
  }
})

test('pure central hatches keep stations across widths and extend count across lengths', () => {
  const narrow = buildFixtureChannelization({ withBay: false, centerM: 1.6 })
    .filter((line) => line.style === 'channel-hatch')
  const wide = buildFixtureChannelization({ withBay: false, centerM: 4.8 })
    .filter((line) => line.style === 'channel-hatch')
  const longer = buildFixtureChannelization({
    withBay: false,
    centerM: 4.8,
    end: [fixtureStart[0], 22.72144],
  }).filter((line) => line.style === 'channel-hatch')

  assert.deepEqual(
    narrow.map((line) => +distanceAlongFixture(line.coords[0]).toFixed(2)),
    wide.map((line) => +distanceAlongFixture(line.coords[0]).toFixed(2)),
  )
  assert.ok(wide.every((line, i) =>
    haversine(line.coords[0], line.coords[1])
      > haversine(narrow[i].coords[0], narrow[i].coords[1])))
  assert.ok(longer.length > wide.length)
  assert.deepEqual(
    longer.slice(0, wide.length).map((line) => +distanceAlongFixture(line.coords[0]).toFixed(2)),
    wide.map((line) => +distanceAlongFixture(line.coords[0]).toFixed(2)),
  )
})

test('zero-width and physical-island central bands produce no pure hatches', () => {
  const zeroWidth = buildFixtureChannelization({ withBay: false, centerM: 0 })
    .filter((line) => line.style === 'channel-hatch')
  const island = buildFixtureChannelization({
    withBay: false,
    centerM: 3.2,
    centerKind: 'island',
  }).filter((line) => line.style === 'channel-hatch')

  assert.equal(zeroWidth.length, 0)
  assert.equal(island.length, 0)
})

test('single capped bay defaults to an unused-side closure but ignore produces none', () => {
  assert.equal(resolveChannelization(parent, { ...bay, singleMode: 'capped' }, []).closure, 'unused-side')
  assert.equal(resolveChannelization(parent, { ...bay, singleMode: 'ignore' }, []), null)
})

test('equivalent manual and inferred capped settings have the same marking styles', () => {
  const inferred = buildFixtureChannelization({ singleMode: 'capped', forwardBay: true })
  const manual = buildFixtureChannelization({
    singleMode: 'capped', forwardBay: true, journal: manualCentralBandJournal,
  })
  assert.deepEqual(stylesAndOwners(manual), stylesAndOwners(inferred))
})

test('capped triangle range retains its forward boundaries and fixed offset', () => {
  const movingAt = (distanceM) => distanceM / 9

  assert.deepEqual(buildCappedTriangleRange({
    taperStartM: 18,
    stopBoundaryM: 54,
    movingAt,
    fixedOffsetM: -1.6,
  }), {
    startM: 18,
    endM: 54,
    movingAt,
    fixedOffsetM: -1.6,
  })
})

test('capped triangle range rejects reversed boundaries', () => {
  assert.equal(buildCappedTriangleRange({
    taperStartM: 54,
    stopBoundaryM: 18,
    movingAt: () => 0,
    fixedOffsetM: 1.6,
  }), null)
})

test('a forward capped bay triangle spans the unused stop line to the full lane split', () => {
  const outlines = buildFixtureChannelization({ forwardBay: true })
    .filter((line) => line.style === 'single-bay-unused')
  assert.equal(outlines.length, 2)

  const tipCoords = outlines.map((line) => endpointNearestStation(line, 45))
  assert.ok(haversine(tipCoords[0], tipCoords[1]) < 0.05)
  assert.ok(outlines.every((line) =>
    Math.abs(Math.max(...line.coords.map(distanceAlongFixture)) - 45) < 0.2))
})

test('a backward capped bay mirrors the unused approach triangle in the road frame', () => {
  const forwardOutlines = buildFixtureChannelization({ forwardBay: true })
    .filter((line) => line.style === 'single-bay-unused')
  const backwardOutlines = buildFixtureChannelization({ forwardBay: false })
    .filter((line) => line.style === 'single-bay-unused')
  assert.equal(forwardOutlines.length, 2)
  assert.equal(backwardOutlines.length, 2)

  const backwardTipM = fixtureTotalM - 45
  const backwardTipCoords = backwardOutlines
    .map((line) => endpointNearestStation(line, backwardTipM))
  assert.ok(haversine(backwardTipCoords[0], backwardTipCoords[1]) < 0.05)
  assert.ok(backwardOutlines.every((line) =>
    Math.abs(Math.min(...line.coords.map(distanceAlongFixture)) - backwardTipM) < 0.2))

  const forwardSide = lateralOffsetFromFixture(endpointNearestStation(forwardOutlines[0], 45))
  const backwardSide = lateralOffsetFromFixture(
    endpointNearestStation(backwardOutlines[0], backwardTipM),
  )
  assert.ok(forwardSide < -fixtureCenterHalfM + 0.1)
  assert.ok(backwardSide > fixtureCenterHalfM - 0.1)
})

for (const forwardBay of [true, false]) {
  const direction = forwardBay ? 'forward' : 'backward'
  test(`${direction} capped bay cap is nonzero and follows both skew-clipped boundaries`, () => {
    const caps = buildFixtureChannelization({ forwardBay })
      .filter((line) => line.style === 'channel-cap')
    assert.equal(caps.length, 1)
    assert.ok(haversine(caps[0].coords[0], caps[0].coords[1]) > 2.5)

    const rawBoundaryM = forwardBay
      ? fixtureSetbackM
      : fixtureTotalM - fixtureSetbackM
    const offsets = forwardBay
      ? [-fixtureCenterHalfM, fixtureCenterHalfM]
      : [fixtureCenterHalfM, -fixtureCenterHalfM]
    const expectedStations = offsets.map((offsetM) => forwardBay
      ? fixtureSetbackM + fixtureSkew * offsetM + 0.5
      : fixtureTotalM - fixtureSetbackM + fixtureSkew * offsetM - 0.5)
      .sort((a, b) => a - b)
    const actualStations = caps[0].coords.map(distanceAlongFixture).sort((a, b) => a - b)

    assert.ok(Math.abs(actualStations[0] - expectedStations[0]) < 0.2)
    assert.ok(Math.abs(actualStations[1] - expectedStations[1]) < 0.2)
    assert.ok(actualStations.every((stationM) => Math.abs(stationM - rawBoundaryM) > 0.2))
  })

  test(`${direction} capped bay hatches keep v1 pitch and stay outside the traversable bay`, () => {
    const hatches = buildFixtureChannelization({ forwardBay })
      .filter((line) => line.style === 'channel-hatch')
    assert.ok(hatches.length > 2)

    const hatchStations = hatches.map((line) => distanceAlongFixture(line.coords[0]))
    for (let i = 1; i < hatchStations.length; i++) {
      assert.ok(Math.abs((hatchStations[i] - hatchStations[i - 1]) - 1.25) < 0.02)
    }
    for (const line of hatches) {
      assert.ok(haversine(line.coords[0], line.coords[1]) >= 0.3)
      for (const coord of line.coords) {
        const stationM = distanceAlongFixture(coord)
        const lateralM = lateralOffsetFromFixture(coord)
        assert.ok(forwardBay ? stationM < 45 : stationM > fixtureTotalM - 45)
        assert.ok(lateralM > -fixtureCenterHalfM && lateralM < fixtureCenterHalfM)
      }
    }
  })
}

test('single forward bay closes the opposite side of its left-turn lane', () => {
  assert.deepEqual(singleBayUnusedSideOffsets('forward', 1.5), {
    movingStart: -1.5,
    unusedBoundary: 1.5,
  })
})

test('single backward bay mirrors the unused-side closure', () => {
  assert.deepEqual(singleBayUnusedSideOffsets('backward', 1.5), {
    movingStart: 1.5,
    unusedBoundary: -1.5,
  })
})
