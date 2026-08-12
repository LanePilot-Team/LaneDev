// 測速執法設置點審計：確認 public/data/speed_cameras.json 的每一個點
// 真的落在楠梓／左營路網上、方向對得起道路走向，而且導航跑過去時提示會如期觸發。
//
// 為什麼要這支：相機資料是外部來源，座標與方向文字都可能跟我們的底圖對不起來。
// 「離最近道路 80 公尺」的點在導航裡永遠不會提示（超過 MAX_OFFSET_M），
// 「方向文字寫南向北、但那條路實際是東西向」則代表方向解析或座標有問題——
// 這兩種在畫面上都看不出來，只有逐點量才會現形。
//
// 用法：node scripts/run_offline.mjs scripts/speed_camera_audit.ts [--db=...]
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { foldJournal, applyToRoads } from '../src/core/enhancements'
import { newRoadsFromFolded } from '../src/core/newroads'
import { angleDelta, bearing, cumulative, haversine, offsetMeters } from '../src/core/geo'
import { RoadGraph } from '../src/core/graph'
import {
  matchCamerasToRoute, speedCameraAlertAt, alertDistanceM, ENFORCEMENT_LABEL,
  HEADING_TOLERANCE_DEG, MAX_OFFSET_M,
  type SpeedCamera, type SpeedCameraDataset,
} from '../src/core/speedCameras'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name: string, fallback = '') =>
  process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback

/** 通過與否一律用導航端的實際門檻（從 core 匯入），審計才是在測「真的會發生的事」 */
const MAX_SNAP_M = MAX_OFFSET_M
/** 方向差沒到不通過、但已經超過八方位該有的誤差 → 值得人工核對 */
const HEADING_WARN_DEG = 45
/** 兩條路的中心線靠這麼近＝疊在一起（高架壓平面），相機會對不出是哪一條 */
const STACKED_M = 6

// ── 載入底圖（與 app 同一條前處理管線）──
const db = JSON.parse(readFileSync(
  arg('db', join(HERE, '../public/data/road_database.json')), 'utf8'))
const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('segments 解析失敗')
const prepared = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
const folded = foldJournal(db.editor?.journal ?? [])
const roads = [...prepared.roads, ...newRoadsFromFolded(folded, prepared.nodeRemap)]
applyToRoads(roads, folded)
const active = roads.filter((r) => !r.properties.deleted)

const dataset = JSON.parse(readFileSync(
  join(HERE, '../public/data/speed_cameras.json'), 'utf8')) as SpeedCameraDataset

console.log(`底圖 ${active.length} 段；測速點 ${dataset.cameras.length} 筆`
  + `（${dataset.districts.join('、')}），來源同步時間 ${dataset.source.fetchedAt}`)
console.log(`授權：${dataset.source.agency}「${dataset.source.dataset}」${dataset.source.license}\n`)

interface RoadHit { road: RoadFeature; distM: number; segBearing: number }

/** 相機附近的道路（依垂距排序）——要看的不只最近那條，疊在一起的路也得列出來 */
function nearbyRoads(camera: SpeedCamera): RoadHit[] {
  const hits = new Map<RoadFeature, RoadHit>()
  for (const road of active) {
    const cs = road.geometry.coordinates as [number, number][]
    for (let i = 1; i < cs.length; i++) {
      const a = cs[i - 1], b = cs[i]
      if (haversine(a, b) === 0) continue
      // 點到線段距離：先投影再量（本區尺度直接用平面近似即可）
      const t = Math.max(0, Math.min(1, projectFraction(a, b, camera.pos)))
      const p: [number, number] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
      const distM = haversine(p, camera.pos)
      const prev = hits.get(road)
      if (!prev || distM < prev.distM) hits.set(road, { road, distM, segBearing: bearing(a, b) })
    }
  }
  return [...hits.values()].sort((x, y) => x.distM - y.distM)
}

/** 點投影到折線上最近的位置（診斷用：距離＋該處走向） */
function projectOnPath(coords: [number, number][], p: [number, number]) {
  let best = { distM: Infinity, segBearing: 0 }
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i]
    if (haversine(a, b) === 0) continue
    const t = Math.max(0, Math.min(1, projectFraction(a, b, p)))
    const q: [number, number] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
    const distM = haversine(q, p)
    if (distM < best.distM) best = { distM, segBearing: bearing(a, b) }
  }
  return best
}

function projectFraction(a: [number, number], b: [number, number], p: [number, number]) {
  const kx = Math.cos((a[1] * Math.PI) / 180)
  const ax = 0, ay = 0
  const bx = (b[0] - a[0]) * kx, by = b[1] - a[1]
  const px = (p[0] - a[0]) * kx, py = p[1] - a[1]
  const len2 = (bx - ax) ** 2 + (by - ay) ** 2
  return len2 === 0 ? 0 : ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / len2
}

const graph = new RoadGraph(active)

/**
 * 從上游 400m 規劃到下游 200m，再照導航的取樣頻率掃一遍，回報提示的完整序列。
 * 起訖點沿「相機所在道路的實際走向」推，不是沿方向文字的八方位——後者在彎路上
 * 會把端點丟到隔壁街廓，規劃出來的路線根本不經過相機。
 * 方向不明的相機沒有「上游」可言，跳過這關。
 */
function simulateDrive(camera: SpeedCamera, roadBearing: number): string {
  if (!camera.headings.length) return '方向不明，略過（導航時兩個方向都會提示）'
  // 道路線段的方向可能與行車方向相反，先轉成行車方向
  const heading = camera.headings.some((h) => Math.abs(angleDelta(roadBearing, h)) <= 90)
    ? roadBearing : (roadBearing + 180) % 360
  const rad = (heading * Math.PI) / 180
  const back = offsetMeters(camera.pos, -Math.sin(rad) * 400, -Math.cos(rad) * 400)
  const fwd = offsetMeters(camera.pos, Math.sin(rad) * 200, Math.cos(rad) * 200)
  const route = graph.routeDetailed(back, fwd, 'car', {}).route
  if (!route) return '無法自動產生通過該點的路線（路網轉向限制），本項略過'
  const matched = matchCamerasToRoute([camera], route.coords, route.cum)
  if (!matched.length) {
    // 沒提示要說得出原因：垂距太遠（規劃走到別條路）還是方向被濾掉（走到對向車道）。
    // 這兩件事在畫面上長得一樣，但一個是資料問題、一個是這支腳本自己挑錯端點。
    const near = projectOnPath(route.coords, camera.pos)
    const delta = Math.min(...camera.headings.map(
      (h) => Math.abs(angleDelta(near.segBearing, h))))
    return near.distM > MAX_OFFSET_M
      ? `路線離相機 ${near.distM.toFixed(1)}m（門檻 ${MAX_OFFSET_M}m）——`
        + '自動挑的起訖點把路線帶到別條路，非提示邏輯問題'
      : `路線行向 ${Math.round(near.segBearing)}°，與相機方向差 ${Math.round(delta)}°`
        + `（門檻 ${HEADING_TOLERANCE_DEG}°）——走到對向車道，方向過濾正確擋掉`
  }
  const phases: string[] = []
  let last = ''
  for (let d = 0; d <= route.lengthM; d += 5) {
    const alert = speedCameraAlertAt(matched, d, camera.speedLimitKph ?? 50)
    const key = alert ? alert.phase : '—'
    if (key !== last) {
      if (alert) phases.push(`${alert.phase}@${Math.round(alert.distanceM)}m`)
      last = key
    }
  }
  return `路線長 ${Math.round(route.lengthM)}m，相機在 ${Math.round(matched[0].alongM)}m；`
    + `提示序列 ${phases.join(' → ')}`
}

let failures = 0
const warnings: string[] = []
for (const camera of dataset.cameras) {
  const nearby = nearbyRoads(camera)
  const near = nearby[0]
  const head = `${camera.districtName} ${camera.address}`
  if (!near) {
    console.log(`❌ ${head}：底圖上找不到任何道路`)
    failures++
    continue
  }
  const snapOk = near.distM <= MAX_SNAP_M
  // 道路是雙向線段，兩個走向都算「對得上」——相機拍的是其中一個行向
  const headingDelta = camera.headings.length === 0 ? 0 : Math.min(...camera.headings.map((h) =>
    Math.min(Math.abs(angleDelta(near.segBearing, h)),
      Math.abs(angleDelta(near.segBearing + 180, h)))))
  const headingOk = headingDelta <= HEADING_TOLERANCE_DEG

  // 端到端：拿最近的那條路當成路線（必要時反向，讓行進方向＝相機拍攝方向），
  // 掃過整條看提示會不會如期出現、通過後會不會收掉
  let coords = [...(near.road.geometry.coordinates as [number, number][])]
  if (camera.headings.length && coords.length >= 2) {
    const forward = bearing(coords[0], coords[coords.length - 1])
    const matchesForward = camera.headings.some(
      (h) => Math.abs(angleDelta(forward, h)) <= 90)
    if (!matchesForward) coords = coords.reverse()
  }
  const cum = cumulative(coords)
  const matched = matchCamerasToRoute([camera], coords, cum)
  let firstAlertM: number | null = null
  let passedSeen = false
  if (matched.length) {
    for (let d = 0; d <= cum[cum.length - 1]; d += 5) {
      const alert = speedCameraAlertAt(matched, d, camera.speedLimitKph ?? 50)
      if (alert && firstAlertM === null && alert.phase !== 'passed') {
        firstAlertM = matched[0].alongM - d
      }
      if (alert?.phase === 'passed') passedSeen = true
    }
  }
  const alertOk = matched.length > 0

  // 疊在一起的路：高架壓在平面道路上時，相機只有座標無法分辨是哪一層，
  // 導航沿著下層走也會被提示（已知限制，先讓它可見）
  const stacked = nearby.filter((hit) => hit !== near && hit.distM <= STACKED_M
    && (hit.road.properties.name ?? '') !== (near.road.properties.name ?? ''))

  const flag = snapOk && headingOk && alertOk ? '✅' : '❌'
  if (flag === '❌') failures++
  console.log(`${flag} ${head}`)
  console.log(`     ${ENFORCEMENT_LABEL[camera.enforcementType]}｜速限 ${camera.speedLimitKph}`
    + `｜方向文字「${camera.directionText}」→ 行向 ${camera.headings.join('/')}°`)
  console.log(`     最近道路：${near.road.properties.name ?? '(無名)'}`
    + ` ${near.distM.toFixed(1)}m（走向 ${Math.round(near.segBearing)}°，差 ${Math.round(headingDelta)}°）`
    + `${snapOk ? '' : ` ← 超過 ${MAX_SNAP_M}m，導航不會提示`}`
    + `${headingOk ? '' : ' ← 方向與道路走向對不上'}`)
  // 提前量會被「路段長度」蓋住：底圖在路口就把 way 切塊，相機前面那一塊可能只有幾十公尺。
  // 真的導航時路線是連續的，所以這裡同時報理論警示距離，兩個數字要一起看。
  console.log(`     提示：${alertOk
    ? `理論警示距離 ${Math.round(alertDistanceM(camera.speedLimitKph ?? 50, camera.speedLimitKph))}m；`
      + `沿該路段（長 ${Math.round(cum[cum.length - 1])}m）實際最早 ${Math.round(firstAlertM ?? 0)}m 前跳出，`
      + `通過後${passedSeen ? '有' : '沒有'}收尾提示`
    : '沿該道路行駛不會觸發（垂距或方向被濾掉）'}`)

  // 端到端第二關：真的用導航路徑規劃跑一趟。前面那關用單一路段當假路線，
  // 只證明幾何對得上；這關證明「使用者真的導航經過時」提示會照設計跳出來。
  const drive = simulateDrive(camera, near.segBearing)
  console.log(`     實際導航：${drive}`)

  if (headingOk && headingDelta > HEADING_WARN_DEG) {
    warnings.push(`${head}：方向文字與道路走向差 ${Math.round(headingDelta)}°`
      + `（容忍上限 ${HEADING_TOLERANCE_DEG}°），八方位描述配斜向道路的極限，建議人工核對`)
  }
  if (stacked.length) {
    console.log(`     ⚠ 疊層：${stacked.map((s) =>
      `${s.road.properties.name ?? '(無名)'} ${s.distM.toFixed(1)}m`).join('、')}`)
    warnings.push(`${head}：中心線 ${STACKED_M}m 內還有 `
      + `${stacked.map((s) => s.road.properties.name ?? '(無名)').join('、')}`
      + '，沿下層道路行駛也會被提示（座標無法分辨高架／平面）')
  }
}

console.log(`\n${dataset.cameras.length - failures}/${dataset.cameras.length} 通過`)
if (warnings.length) {
  console.log(`\n⚠ ${warnings.length} 項待人工核對：`)
  for (const w of warnings) console.log(`  ・${w}`)
}
if (failures) {
  console.log('\n有測速點對不上底圖或方向，請人工核對座標／方向文字後再更新資料檔')
  process.exit(1)
}
