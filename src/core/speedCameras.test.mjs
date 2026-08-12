import test from 'node:test'
import assert from 'node:assert/strict'
import {
  alertDistanceM,
  matchCamerasToRoute,
  parseDirectionHeadings,
  parseEnforcementType,
  speedCameraAlertAt,
  speedCameraAnnouncement,
  NEAR_ALERT_M,
  OVER_SPEED_TOLERANCE_KPH,
} from './speedCameras.ts'
import { cumulative, offsetMeters, pointAlong } from './geo.ts'

const ORIGIN = [120.32, 22.72]

/** 沿正北的直線路線，長度約 lengthM 公尺（里程一律以 cum 為準） */
function northRoute(lengthM, step = 50) {
  const coords = []
  for (let d = 0; d <= lengthM + step; d += step) coords.push(offsetMeters(ORIGIN, 0, d))
  return { coords, cum: cumulative(coords) }
}

/** 路線上里程 m 的座標——相機位置一律用它產生，測試裡的距離才跟 cum 同一把尺 */
const atM = (route, m) => pointAlong(route.coords, route.cum, m).pos

const camera = (overrides = {}) => ({
  id: 'npa:test',
  sourceDataset: 'npa:7320',
  enforcementType: 'speed_camera',
  headings: [0],
  speedLimitKph: 60,
  ...overrides,
})

test('方向文字解析：單向、雙向、斜向', () => {
  assert.deepEqual(parseDirectionHeadings('南向北'), [0])
  assert.deepEqual(parseDirectionHeadings('北向南'), [180])
  assert.deepEqual(parseDirectionHeadings('東向西'), [270])
  assert.deepEqual(parseDirectionHeadings('西向東'), [90])
  assert.deepEqual(parseDirectionHeadings('南往北'), [0])
  assert.deepEqual(parseDirectionHeadings('往南'), [180])
  assert.deepEqual(parseDirectionHeadings('北上車道'), [0])
  assert.deepEqual(parseDirectionHeadings('東南向西北'), [315])
  assert.deepEqual(parseDirectionHeadings('南北雙向').sort((a, b) => a - b), [0, 180])
  assert.deepEqual(parseDirectionHeadings('東西雙向').sort((a, b) => a - b), [90, 270])
})

test('方向文字解析：型態註記不影響方向', () => {
  assert.deepEqual(parseDirectionHeadings('南北雙向(區間測速)').sort((a, b) => a - b), [0, 180])
  assert.deepEqual(parseDirectionHeadings('南北雙向兼闖紅燈').sort((a, b) => a - b), [0, 180])
  assert.deepEqual(parseDirectionHeadings('南向北(超速闖紅燈)'), [0])
})

test('方向文字解析：不明句型回傳空陣列（代表不做方向過濾）', () => {
  assert.deepEqual(parseDirectionHeadings('往中壢方向'), [])
  assert.deepEqual(parseDirectionHeadings('多向'), [])
  assert.deepEqual(parseDirectionHeadings('雙向'), [])
  assert.deepEqual(parseDirectionHeadings(undefined), [])
})

test('執法型態由方向文字判斷', () => {
  assert.equal(parseEnforcementType('南向北').enforcementType, 'speed_camera')
  assert.equal(parseEnforcementType('南北雙向(區間測速)').enforcementType, 'interval')
  assert.equal(parseEnforcementType('雙向測速科技執法').enforcementType, 'tech_enforcement')
  assert.equal(parseEnforcementType('南北雙向兼闖紅燈').alsoRedLight, true)
  assert.equal(parseEnforcementType('南向北').alsoRedLight, false)
})

test('相機投影到路線：里程與垂距', () => {
  const route = northRoute(1000)
  const [rc] = matchCamerasToRoute([camera({ pos: atM(route, 600) })], route.coords, route.cum)
  assert.ok(rc, '同向的相機應該要被收進來')
  assert.ok(Math.abs(rc.alongM - 600) < 2, `里程應約 600，實際 ${rc.alongM}`)
  assert.ok(rc.offsetM < 1)
  assert.ok(Math.abs(rc.routeBearing) < 1 || Math.abs(rc.routeBearing - 360) < 1)
})

test('對向的相機不提醒', () => {
  const route = northRoute(1000) // 往北開
  const matched = matchCamerasToRoute(
    [camera({ pos: atM(route, 600), headings: [180] })], route.coords, route.cum,
  )
  assert.deepEqual(matched, [], '南向的相機在往北的路線上不該提醒')
})

test('雙向相機兩個方向都提醒', () => {
  const route = northRoute(1000)
  const matched = matchCamerasToRoute(
    [camera({ pos: atM(route, 600), headings: [0, 180] })], route.coords, route.cum,
  )
  assert.equal(matched.length, 1)
})

test('方向不明的相機照樣提醒（寧可多提醒不要漏）', () => {
  const route = northRoute(1000)
  const matched = matchCamerasToRoute(
    [camera({ pos: atM(route, 600), headings: [] })], route.coords, route.cum,
  )
  assert.equal(matched.length, 1)
})

test('離路線太遠的相機（隔壁街）不列入', () => {
  const route = northRoute(1000)
  const far = camera({ pos: offsetMeters(atM(route, 600), 80, 0) })
  assert.deepEqual(matchCamerasToRoute([far], route.coords, route.cum), [])
})

test('智慧型警示距離跟著車速走', () => {
  assert.ok(alertDistanceM(90, 90) > alertDistanceM(50, 50), '高速時要更早提醒')
  assert.equal(Math.round(alertDistanceM(60, 60)), 300)
  // 塞車（車速 0）時不能縮到看不見；速限撐住下限
  assert.ok(alertDistanceM(0, 60) >= 180)
  assert.equal(alertDistanceM(200, 110), 800, '再快也不會超過上限')
})

test('提示階段：範圍外 → 接近 → 逼近 → 通過', () => {
  const route = northRoute(1500)
  const rcs = matchCamerasToRoute([camera({ pos: atM(route, 600) })], route.coords, route.cum)
  const at = (traveled, speed = 60) => speedCameraAlertAt(rcs, traveled, speed)

  assert.equal(at(100), null, '警示距離（300m）之外不提示')
  assert.equal(at(400).phase, 'approach')
  assert.ok(Math.abs(at(400).distanceM - 200) < 2)
  assert.equal(at(600 - NEAR_ALERT_M + 10).phase, 'near')
  assert.equal(at(605).phase, 'passed')
  assert.ok(at(605).distanceM > 0, '通過後距離是「已通過多遠」')
  assert.equal(at(800), null, '通過夠遠就收掉提示')
})

test('超速判定帶寬限值', () => {
  const route = northRoute(1500)
  const rcs = matchCamerasToRoute([camera({ pos: atM(route, 600) })], route.coords, route.cum)
  assert.equal(speedCameraAlertAt(rcs, 500, 60).overLimit, false)
  assert.equal(speedCameraAlertAt(rcs, 500, 60 + OVER_SPEED_TOLERANCE_KPH).overLimit, false)
  const over = speedCameraAlertAt(rcs, 500, 75)
  assert.equal(over.overLimit, true)
  assert.equal(over.overByKph, 15)
})

test('相隔夠遠時：先講完前一台的「已通過」，再換下一台', () => {
  const route = northRoute(1500)
  const rcs = matchCamerasToRoute([
    camera({ id: 'a', pos: atM(route, 600) }),
    camera({ id: 'b', pos: atM(route, 900) }),
  ], route.coords, route.cum)
  assert.equal(rcs.length, 2)
  const passed = speedCameraAlertAt(rcs, 640, 60)
  assert.equal(passed.camera.id, 'a')
  assert.equal(passed.phase, 'passed')
  assert.equal(speedCameraAlertAt(rcs, 800, 60).camera.id, 'b')
})

test('兩台相機只隔幾十公尺時，下一台優先於前一台的收尾', () => {
  const route = northRoute(1500)
  const rcs = matchCamerasToRoute([
    camera({ id: 'a', pos: atM(route, 600) }),
    camera({ id: 'b', pos: atM(route, 660) }),
  ], route.coords, route.cum)
  const alert = speedCameraAlertAt(rcs, 620, 60)
  assert.equal(alert.camera.id, 'b', '還在報「已通過」就被下一台拍到才是真的糟')
  assert.equal(alert.phase, 'near')
})

test('語音：進入範圍報距離與速限、超速催減速、通過報結束', () => {
  const route = northRoute(1500)
  const rcs = matchCamerasToRoute([camera({ pos: atM(route, 600) })], route.coords, route.cum)
  const say = (traveled, speed = 60) =>
    speedCameraAnnouncement(speedCameraAlertAt(rcs, traveled, speed))

  const approach = say(400)
  assert.match(approach.text, /前方 200 公尺，固定式測速，速限 60/)
  assert.equal(approach.key, 'npa:test:approach')

  assert.equal(say(520, 60), null, '沒超速時逼近階段不再囉嗦')
  assert.match(say(520, 78).text, /超速 18 公里，請減速/)
  assert.match(say(620).text, /固定式測速已通過/)
})

test('語音距離講整數，不報 287 公尺這種假精確', () => {
  const route = northRoute(2000)
  const rcs = matchCamerasToRoute(
    [camera({ pos: atM(route, 1000), speedLimitKph: 90 })],
    route.coords, route.cum,
  )
  assert.match(speedCameraAnnouncement(speedCameraAlertAt(rcs, 587, 90)).text, /前方 400 公尺/)
})
