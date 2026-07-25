# Annotated Lane Guidance Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically resolve navigation lane guidance from bundled LanePilot annotations, with per-lane OSM fallback and intersection-specific approach selection.

**Architecture:** A build-time Node script extracts a compact deterministic artifact from `annotations.jsonl`. A React-independent TypeScript index and resolver combine approach, segment, legacy, and OSM data; `RoadGraph` stores resolved guidance on maneuvers and route spans, while the HUD switches from span guidance to maneuver guidance at 250 metres.

**Tech Stack:** Node.js test runner, TypeScript, React 19, Vite 8, JSON/JSONL static assets.

## Global Constraints

- Data priority is `intersection_approach > segment_direction > legacy > OSM > inference`.
- Manual known values override OSM per lane; manual `unknown`, empty, or missing values use the same OSM lane.
- An approach annotation applies only to its exact way, intersection node, and direction.
- At more than 250 metres the HUD uses current-span guidance; at 250 metres or less it uses the next maneuver approach.
- Only `source: 'inferred'` displays `車道建議（系統推測）`.
- Navigation controls remain unavailable until the map-loading flow has resolved the compact index load or its explicit fallback.
- `annotations.jsonl` remains the source of truth; generated output is deterministic.
- No new runtime dependency.
- Author shared implementation in `LaneDev`, then synchronize the approved whitelist into `LaneNav`.
- Do not stage existing lockfile changes, the repository-root `package-lock.json`, or the source-artwork directory.

---

### Task 1: Deterministic compact lane-guidance generator

**Files:**
- Create: `LaneDev/scripts/build_lane_guidance.mjs`
- Create: `LaneDev/scripts/build_lane_guidance.test.mjs`
- Create: `LaneDev/public/data/lanepilot/lane-guidance.json`
- Modify: `LaneDev/package.json`

**Interfaces:**
- Consumes: raw JSONL text with LanePilot `object_identity` and `lane_detail_tags.lane_profiles`.
- Produces:
  - `extractLaneGuidance(jsonlText: string): LaneGuidanceRecord[]`
  - `writeLaneGuidance({ inputPath, outputPath }): void`
  - deterministic `public/data/lanepilot/lane-guidance.json`.

- [ ] **Step 1: Write failing generator tests**

Create fixture records inline in `build_lane_guidance.test.mjs` and assert exact compact output:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { extractLaneGuidance } from './build_lane_guidance.mjs'

const line = (identity, profile) => JSON.stringify({
  object_identity: identity,
  lane_nav_tags: { lane_detail_tags: { lane_profiles: [profile] } },
})

test('extracts intersection and segment contexts deterministically', () => {
  const jsonl = [
    line({
      object_type: 'nav_context_annotation',
      nav_segment_key: 'way/20',
      context_scope: 'segment_direction',
      approach_direction: 'backward',
      source_osm: { osm_id: 20 },
    }, {
      direction: 'backward',
      lane_count: 2,
      lane_movements: ['left', 'through'],
    }),
    line({
      object_type: 'nav_context_annotation',
      nav_segment_key: 'way/10',
      context_scope: 'intersection_approach',
      applies_to_intersection_key: 'node/99',
      approach_direction: 'forward',
      source_osm: { osm_id: 10 },
    }, {
      direction: 'forward',
      lane_count: 3,
      lane_movements: ['left;through', 'through', 'unknown'],
    }),
  ].join('\n')

  assert.deepEqual(extractLaneGuidance(jsonl), [
    {
      wayId: 10, direction: 'forward', scope: 'intersection_approach',
      intersectionNodeId: 99, laneCount: 3,
      laneMovements: ['left;through', 'through', 'unknown'],
    },
    {
      wayId: 20, direction: 'backward', scope: 'segment_direction',
      laneCount: 2, laneMovements: ['left', 'through'],
    },
  ])
})

test('rejects an approach context without an intersection node', () => {
  const jsonl = line({
    object_type: 'nav_context_annotation',
    nav_segment_key: 'way/10',
    context_scope: 'intersection_approach',
    approach_direction: 'forward',
    source_osm: { osm_id: 10 },
  }, {
    direction: 'forward', lane_count: 1, lane_movements: ['through'],
  })

  assert.throws(() => extractLaneGuidance(jsonl), /intersection node.*way\/10/i)
})

test('rejects duplicate records that would create an ambiguous key', () => {
  const duplicate = line({
    object_type: 'nav_context_annotation',
    nav_segment_key: 'way/10',
    context_scope: 'intersection_approach',
    applies_to_intersection_key: 'node/99',
    approach_direction: 'forward',
    source_osm: { osm_id: 10 },
  }, {
    direction: 'forward', lane_count: 1, lane_movements: ['through'],
  })

  assert.throws(() => extractLaneGuidance(`${duplicate}\n${duplicate}`), /duplicate.*way\/10/i)
})
```

- [ ] **Step 2: Run the generator test and verify RED**

Run:

```powershell
cd LaneDev
node --test scripts/build_lane_guidance.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `build_lane_guidance.mjs`.

- [ ] **Step 3: Implement the minimal generator**

Implement exports and CLI execution in `build_lane_guidance.mjs`:

```js
export function extractLaneGuidance(text) {
  const out = []
  for (const [lineIndex, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue
    const record = JSON.parse(raw)
    const identity = record.object_identity ?? {}
    if (!String(identity.object_type ?? '').includes('annotation')) continue
    const wayId = Number(identity.source_osm?.osm_id ??
      String(identity.nav_segment_key ?? '').replace(/^way\//, ''))
    if (!Number.isFinite(wayId)) {
      throw new Error(`invalid way identity at line ${lineIndex + 1}`)
    }
    const scope = identity.context_scope === 'intersection_approach'
      ? 'intersection_approach'
      : identity.context_scope === 'segment_direction'
        ? 'segment_direction'
        : 'legacy'
    const profiles = record.lane_nav_tags?.lane_detail_tags?.lane_profiles ?? []
    for (const profile of profiles) {
      const direction = profile.direction ?? identity.approach_direction
      if (direction !== 'forward' && direction !== 'backward') continue
      if (!Array.isArray(profile.lane_movements)) continue
      const compact = {
        wayId,
        direction,
        scope,
        laneCount: Number.isFinite(Number(profile.lane_count))
          ? Number(profile.lane_count) : undefined,
        laneMovements: profile.lane_movements.map(String),
      }
      if (scope === 'intersection_approach') {
        const nodeId = Number(String(identity.applies_to_intersection_key ?? '')
          .replace(/^node\//, ''))
        if (!Number.isFinite(nodeId)) {
          throw new Error(`intersection node missing for way/${wayId} at line ${lineIndex + 1}`)
        }
        compact.intersectionNodeId = nodeId
      }
      out.push(compact)
    }
  }
  return out.sort((a, b) =>
    a.wayId - b.wayId ||
    (a.intersectionNodeId ?? -1) - (b.intersectionNodeId ?? -1) ||
    a.direction.localeCompare(b.direction) ||
    a.scope.localeCompare(b.scope))
}
```

Before returning, the generator must reject duplicate keys composed from scope, way ID, optional node ID, and direction. The CLI must read `public/data/lanepilot/annotations.jsonl`, write pretty JSON plus one trailing newline, and print record count and byte size.

- [ ] **Step 4: Add package scripts**

Add:

```json
"lane-guidance:data": "node scripts/build_lane_guidance.mjs",
"predev": "npm run lane-guidance:data",
"prebuild": "npm run lane-guidance:data",
"test:lane-guidance": "node --test scripts/build_lane_guidance.test.mjs src/core/laneGuidance.test.mjs"
```

Keep the existing `test:lane-preview` script.

- [ ] **Step 5: Verify GREEN and generate the real artifact**

Run:

```powershell
npm.cmd run lane-guidance:data
node --test scripts/build_lane_guidance.test.mjs
```

Expected: generator prints approximately 960 records and the test passes.

- [ ] **Step 6: Commit Task 1**

```powershell
git add -- LaneDev/scripts/build_lane_guidance.mjs LaneDev/scripts/build_lane_guidance.test.mjs LaneDev/public/data/lanepilot/lane-guidance.json LaneDev/package.json
git commit -m "feat: generate compact lane guidance data"
```

---

### Task 2: Lane-guidance index and per-lane resolver

**Files:**
- Create: `LaneDev/src/core/laneGuidance.ts`
- Create: `LaneDev/src/core/laneGuidance.test.mjs`

**Interfaces:**
- Consumes:
  - `LaneGuidanceRecord[]`
  - `{ wayId, intersectionNodeId?, direction, roadLaneCount, osmMovements? }`
- Produces:
  - `buildLaneGuidanceIndex(records): LaneGuidanceIndex`
  - `remapLaneGuidanceRecords(records, { existingWayIds, nodeRemap, wayRemap }): LaneGuidanceRecord[]`
  - `resolveLaneGuidance(index, input): ResolvedLaneGuidance`
  - `LaneGuidanceSource = 'annotation' | 'annotation+osm' | 'osm' | 'inferred'`.

- [ ] **Step 1: Write failing resolver tests**

Cover exact precedence and per-lane fallback:

```js
test('approach annotation wins only at its matching node', () => {
  const index = buildLaneGuidanceIndex([
    record({ scope: 'segment_direction', laneMovements: ['through', 'right'] }),
    record({
      scope: 'intersection_approach',
      intersectionNodeId: 99,
      laneMovements: ['left', 'through'],
    }),
  ])

  assert.deepEqual(resolveLaneGuidance(index, input({ intersectionNodeId: 99 })), {
    laneCount: 2,
    laneMovements: ['left', 'through'],
    source: 'annotation',
  })
  assert.deepEqual(resolveLaneGuidance(index, input({ intersectionNodeId: 100 })).laneMovements,
    ['through', 'right'])
})

test('manual unknown uses OSM in the same lane', () => {
  const index = buildLaneGuidanceIndex([
    record({ laneCount: 3, laneMovements: ['left', 'unknown', ''] }),
  ])
  assert.deepEqual(resolveLaneGuidance(index, input({
    roadLaneCount: 3,
    osmMovements: ['through', 'through', 'right'],
  })), {
    laneCount: 3,
    laneMovements: ['left', 'through', 'right'],
    source: 'annotation+osm',
  })
})

test('direction and partial arrays never leak or discard known lanes', () => {
  const index = buildLaneGuidanceIndex([
    record({ direction: 'forward', laneCount: 3, laneMovements: ['left'] }),
  ])
  assert.deepEqual(resolveLaneGuidance(index, input({
    direction: 'forward',
    roadLaneCount: 3,
    osmMovements: ['through', 'through', 'right'],
  })).laneMovements, ['left', 'through', 'right'])
  assert.equal(resolveLaneGuidance(index, input({ direction: 'backward' })).source, 'inferred')
})

test('remaps a dropped couplet way and reverses direction when required', () => {
  const records = [record({
    wayId: 10, direction: 'forward', scope: 'intersection_approach',
    intersectionNodeId: 90,
  })]
  const remapped = remapLaneGuidanceRecords(records, {
    existingWayIds: new Set([20]),
    nodeRemap: new Map([[90, 99]]),
    wayRemap: new Map([[10, {
      keepIds: [20], dropReversed: false, sameDir: false,
    }]]),
  })
  assert.deepEqual(remapped[0], {
    ...records[0],
    wayId: 20,
    direction: 'backward',
    intersectionNodeId: 99,
  })
})
```

- [ ] **Step 2: Run resolver tests and verify RED**

Run:

```powershell
node --test src/core/laneGuidance.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `laneGuidance.ts`.

- [ ] **Step 3: Implement focused index and resolver**

Define stable keys:

```ts
const segmentKey = (wayId: number, direction: LaneDirection) =>
  `${wayId}/${direction}`
const approachKey = (wayId: number, nodeId: number, direction: LaneDirection) =>
  `${wayId}@${nodeId}/${direction}`
```

`buildLaneGuidanceIndex` stores approach records separately and stores one segment fallback per direction. For duplicate segment candidates, prefer `segment_direction` over `legacy`.

`remapLaneGuidanceRecords` keeps records whose way IDs survived road preparation. For a dropped way, clone the record for each surviving `keepId`, apply `nodeRemap`, and use the existing import-flow alignment rule:

```ts
const aligned = remap.dropReversed
  ? !(remap.sameDir ?? false)
  : (remap.sameDir ?? false)
```

When `aligned` is false, exchange `forward` and `backward`.

`resolveLaneGuidance` must:

1. Find exact approach, otherwise segment/legacy.
2. Choose valid manual lane count, otherwise road lane count.
3. Resolve each lane independently.
4. Treat `unknown` and blank manual values as missing.
5. Return `annotation+osm` only when both sources contributed at least one final lane.
6. Return `inferred` with `laneMovements: undefined` only when no lane from either source is usable.

- [ ] **Step 4: Verify GREEN**

Run:

```powershell
npm.cmd run test:lane-guidance
```

Expected: all generator and resolver tests pass.

- [ ] **Step 5: Commit Task 2**

```powershell
git add -- LaneDev/src/core/laneGuidance.ts LaneDev/src/core/laneGuidance.test.mjs
git commit -m "feat: resolve annotated lane guidance"
```

---

### Task 3: Route, span, and HUD integration

**Files:**
- Modify: `LaneDev/src/core/graph.ts`
- Modify: `LaneDev/src/nav/drive.ts`
- Modify: `LaneDev/src/nav/gpsNav.ts`
- Modify: `LaneDev/src/nav/lanePreview.ts`
- Modify: `LaneDev/src/nav/lanePreview.test.mjs`
- Modify: `LaneDev/src/nav/DriveHUD.tsx`

**Interfaces:**
- Consumes: `LaneGuidanceIndex` and `resolveLaneGuidance`.
- Produces:
  - `Maneuver.laneGuidance: ResolvedLaneGuidance`
  - route span `laneGuidance: ResolvedLaneGuidance`
  - `DriveState.roadLaneGuidance?: ResolvedLaneGuidance`
  - `selectLanePreviewGuidance({ distanceM, current, maneuver })`.

- [ ] **Step 1: Write failing 250-metre source-selection tests**

Add to `lanePreview.test.mjs`:

```js
test('uses current span beyond 250m and maneuver guidance at 250m', () => {
  const current = {
    laneCount: 2, laneMovements: ['through', 'through'], source: 'osm',
  }
  const maneuver = {
    laneCount: 3,
    laneMovements: ['left', 'through', 'through'],
    source: 'annotation',
  }
  assert.equal(selectLanePreviewGuidance({
    distanceM: 251, current, maneuver,
  }), current)
  assert.equal(selectLanePreviewGuidance({
    distanceM: 250, current, maneuver,
  }), maneuver)
})

test('keeps annotation source out of the inference note', () => {
  const model = ready({
    turnLanes: ['left', 'through'],
    laneCount: 2,
    guidanceSource: 'annotation',
  })
  assert.equal(model.inferred, false)
})
```

- [ ] **Step 2: Run preview tests and verify RED**

Run:

```powershell
npm.cmd run test:lane-preview
```

Expected: FAIL because `selectLanePreviewGuidance` and `guidanceSource` do not exist.

- [ ] **Step 3: Add resolved guidance to graph outputs**

Change `RoadGraph` to accept an optional index:

```ts
constructor(
  roads: RoadFeature[],
  private laneGuidanceIndex: LaneGuidanceIndex = buildLaneGuidanceIndex([]),
) { ... }
```

When building each maneuver, resolve with:

```ts
resolveLaneGuidance(index, {
  wayId: prev.road.properties.osm_id,
  intersectionNodeId: next.from >= 0 ? next.from : prev.to,
  direction: prev.back ? 'backward' : 'forward',
  roadLaneCount: prev.back
    ? prev.road.properties.lanesBackward
    : prev.road.properties.lanesForward,
  osmMovements: prev.back
    ? prev.road.properties.turnLanesB
    : prev.road.properties.turnLanes,
})
```

Resolve each route span without `intersectionNodeId` so it uses segment/legacy/OSM guidance.

- [ ] **Step 4: Carry span guidance through simulated and GPS drive state**

Replace direct road lane fields with:

```ts
roadLaneGuidance?: ResolvedLaneGuidance
```

Both `drive.ts` and `gpsNav.ts` copy `span.laneGuidance` into the current `DriveState`.

- [ ] **Step 5: Implement HUD source selection**

Add the pure selector:

```ts
export function selectLanePreviewGuidance<T>({
  distanceM, current, maneuver,
}: {
  distanceM: number
  current?: T
  maneuver?: T
}): T | undefined {
  return distanceM <= 250 ? maneuver ?? current : current ?? maneuver
}
```

Extend `LanePreviewInput` with optional `guidanceSource`. When supplied, set the model's inference note from `guidanceSource === 'inferred'`; preserve existing fallback behavior for direct callers without a source.

`DriveHUD` passes selected `laneCount`, `laneMovements`, and `source` to `buildLanePreview`.

- [ ] **Step 6: Verify all lane tests and build**

Run:

```powershell
npm.cmd run test:lane-guidance
npm.cmd run test:lane-preview
npm.cmd run build
```

Expected: all tests pass and TypeScript/Vite build succeeds.

- [ ] **Step 7: Commit Task 3**

```powershell
git add -- LaneDev/src/core/graph.ts LaneDev/src/nav/drive.ts LaneDev/src/nav/gpsNav.ts LaneDev/src/nav/lanePreview.ts LaneDev/src/nav/lanePreview.test.mjs LaneDev/src/nav/DriveHUD.tsx
git commit -m "feat: use annotated guidance in route HUD"
```

---

### Task 4: Runtime preload, synchronization, and release verification

**Files:**
- Modify: `LaneDev/src/app/mapCore.ts`
- Modify: `LaneDev/scripts/sync_lanenav.mjs`
- Modify: `LaneNav/package.json`
- Synchronize: `LaneNav/scripts/build_lane_guidance.mjs`
- Synchronize: `LaneNav/scripts/build_lane_guidance.test.mjs`
- Synchronize: `LaneNav/public/data/lanepilot/lane-guidance.json`
- Synchronize: `LaneNav/src/core/laneGuidance.ts`
- Synchronize: `LaneNav/src/core/laneGuidance.test.mjs`
- Synchronize: shared changed source files from Task 3.

**Interfaces:**
- Consumes: compact `/data/lanepilot/lane-guidance.json`.
- Produces: map initialization that constructs every `RoadGraph` with the loaded index or an explicit empty-index fallback.

- [ ] **Step 1: Add compact-index loader**

In `mapCore.ts`, fetch and validate the compact record array:

```ts
async function loadLaneGuidanceIndex(): Promise<LaneGuidanceIndex> {
  try {
    const response = await fetch('/data/lanepilot/lane-guidance.json')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return buildLaneGuidanceIndex(await response.json())
  } catch (error) {
    console.warn('車道標註索引載入失敗，改用 OSM／系統推測', error)
    return buildLaneGuidanceIndex([])
  }
}
```

Load the compact records in the existing initial `Promise.all` with roads and buildings. After `prepareBaseRoads`, remap the records with `nodeRemap`, `wayRemap`, and the surviving road IDs, then build the index. Construct the graph only after that work resolves:

```ts
const [roadsRaw, buildings, laneGuidanceRecords] = await Promise.all([...])
const laneGuidanceIndex = buildLaneGuidanceIndex(remapLaneGuidanceRecords(
  laneGuidanceRecords,
  { existingWayIds, nodeRemap, wayRemap },
))
graphRef.current = new RoadGraph(roads, laneGuidanceIndex)
```

Keep the resolved index in a ref so `replaceBaseMap` also constructs its new graph with the same index. Existing `setLoading(false)` remains after all initialization work, preserving the navigation readiness gate.

- [ ] **Step 2: Extend the synchronization whitelist**

Add both generator files to `WHITELIST`:

```js
'scripts/build_lane_guidance.mjs',
'scripts/build_lane_guidance.test.mjs',
```

The existing `public/data` entry carries the generated artifact.

- [ ] **Step 3: Run source verification**

Run:

```powershell
cd LaneDev
npm.cmd run test:lane-guidance
npm.cmd run test:lane-preview
npm.cmd run build
```

Expected: generator runs from `prebuild`, all tests pass, and build succeeds.

- [ ] **Step 4: Synchronize into LaneNav**

Run:

```powershell
npm.cmd run sync-lanenav
```

Update `LaneNav/package.json` with `lane-guidance:data`, `predev`, `prebuild`, and `test:lane-guidance`, matching the source package scripts while preserving LaneNav package name/version.

- [ ] **Step 5: Verify release parity**

Run:

```powershell
cd ..\LaneNav
npm.cmd run test:lane-guidance
npm.cmd run test:lane-preview
npm.cmd run build
git diff --no-index -- ..\LaneDev\public\data\lanepilot\lane-guidance.json public\data\lanepilot\lane-guidance.json
git diff --no-index -- ..\LaneDev\src\core\laneGuidance.ts src\core\laneGuidance.ts
```

Expected: all commands exit zero; source and release artifacts are identical.

- [ ] **Step 6: Browser integration verification**

Run LaneNav locally, plan a route through an annotated approach, and verify:

- map loading completes before route controls become usable;
- at more than 250 metres the preview uses current-span guidance;
- at 250 metres or less it switches to the maneuver approach;
- a known annotated approach does not display `車道建議（系統推測）`;
- browser console contains no new lane-guidance errors.

- [ ] **Step 7: Commit synchronized release files**

Stage only the intended LaneDev runtime/sync changes and the synchronized LaneNav files. Exclude all pre-existing lockfiles and source artwork:

```powershell
git add -- LaneDev/src/app/mapCore.ts LaneDev/scripts/sync_lanenav.mjs LaneNav/package.json LaneNav/scripts/build_lane_guidance.mjs LaneNav/scripts/build_lane_guidance.test.mjs LaneNav/public/data/lanepilot/lane-guidance.json LaneNav/src
git diff --cached --check
git commit -m "chore: sync annotated lane guidance into LaneNav"
```

- [ ] **Step 8: Final scope verification**

Run:

```powershell
git status --short --branch
git diff --check
git log --oneline --decorate -10
git diff --stat main...HEAD
```

Expected: only the user's pre-existing lockfiles, repository-root lockfile, and source-artwork folder remain uncommitted.
