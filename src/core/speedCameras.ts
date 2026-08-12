// 測速執法點（測速照相）提示的核心邏輯——純函式，不碰 DOM/地圖，離線 harness 與
// node --test 都能直接跑。資料來源是內政部警政署「測速執法設置點」開放資料，
// 由 scripts/build_speed_cameras.mjs 過濾成楠梓區＋左營區後寫進 public/data。
//
// 設計參考市面上的測速提示 App（神盾等）驗證過的三件事：
//   1. 智慧型警示距離：警示距離跟著車速走，不是固定公尺數（見 alertDistanceM）。
//   2. 相機方向判斷：對向的相機不吵人——用「路線在該點的行向」與相機拍攝方向比對，
//      不是用相機到車的方位角（見 matchCamerasToRoute）。
//   3. 通過後要收尾：跳出提示後再提示一次「已通過」，駕駛才知道可以恢復正常速度。
import { angleDelta, bearing, COS_LAT, haversine } from './geo.ts'

/** 執法型態。全國資料集沒有統一欄位，只能從拍攝方向文字裡撈關鍵字，
 * 撈不到就是一般固定式測速——不把沒把握的東西混進 speed_camera（資料指引第 6 節）。 */
export type EnforcementType = 'speed_camera' | 'interval' | 'red_light' | 'tech_enforcement'

export interface SpeedCamera {
  /** 穩定識別碼：來源資料集 + 座標/地址雜湊，重新匯入時同一個點會拿到同一個 id */
  id: string
  sourceDataset: string
  enforcementType: EnforcementType
  /** 同時取締闖紅燈（方向文字寫「兼闖紅燈」之類）；主型態仍是測速 */
  alsoRedLight?: boolean
  pos: [number, number]
  cityName?: string
  districtName?: string
  address?: string
  /** 原始拍攝方向文字（例：南向北、東西雙向）——面板要能顯示原文供人核對 */
  directionText?: string
  /**
   * 由方向文字解出的「行車方位角」（度，0=北）。雙向會有兩個。
   * 空陣列 = 解不出來，這時不做方向過濾（寧可多提醒，不要漏提醒）。
   */
  headings: number[]
  speedLimitKph?: number
}

export interface SpeedCameraDataset {
  version: number
  generatedAt: string
  source: {
    dataset: string
    agency: string
    license: string
    licenseUrl: string
    url: string
    fetchedAt: string
  }
  districts: string[]
  cameras: SpeedCamera[]
}

// ── 方向文字 → 方位角 ──

const COMPASS: Record<string, number> = {
  北: 0, 東北: 45, 東: 90, 東南: 135, 南: 180, 西南: 225, 西: 270, 西北: 315,
}

/**
 * 把警政署的拍攝方向文字解成行車方位角。全國資料裡這個欄位是自由文字
 * （「南向北」「往南」「南北雙向」「往中壢方向」…），所以只認得出常見句型，
 * 其餘一律回傳空陣列代表「不知道方向」。楠梓＋左營的 10 筆全是「X向Y」單向句型。
 *
 * 注意方向是「行車方向」不是「相機朝向」：「南向北」= 由南往北開的車會被拍，
 * 所以行向 = 北 = 0°。
 */
export function parseDirectionHeadings(text: string | undefined): number[] {
  if (!text) return []
  // 先拿掉型態註記（括號內的區間測速／超速闖紅燈、「兼闖紅燈」尾巴、測速/科技執法字樣），
  // 那些是執法型態不是方向，留著會讓下面的句型比對整條失敗
  const t = text
    .replace(/[（(].*?[)）]/g, '')
    .replace(/兼.*$/, '')
    .replace(/區間測速|科技執法|測速/g, '')
    .replace(/\s+/g, '')
  if (!t) return []

  // 「南北雙向」「東西雙向」「北南雙向」「南北向」「東西向」「南北相向」
  const both = /^([東西南北])([東西南北])(雙向|向|相向|雙向測速|測速)?$/.exec(t)
  if (both && both[1] !== both[2]) {
    // 「南北雙向」= 兩個行向都會被拍：往北(0) 與 往南(180)
    return [COMPASS[both[2]], COMPASS[both[1]]]
  }

  // 「南向北」「南往北」「東南向西北」「東往西向」
  const to = /^([東西南北]{1,2})(?:向|往)([東西南北]{1,2})向?$/.exec(t)
  if (to && COMPASS[to[2]] !== undefined) return [COMPASS[to[2]]]

  // 「往北」「北向」「北上方向」「南下車道」
  const single = /^(?:往)?([東西南北]{1,2})(?:向|上|下)?(?:方向|車道)?$/.exec(t)
  if (single && COMPASS[single[1]] !== undefined) {
    // 「北上」= 往北、「南下」= 往南，跟「北向」同義
    return [COMPASS[single[1]]]
  }

  return [] // 「往中壢方向」「多向」之類地名／不明句型：不做方向過濾
}

/** 從拍攝方向文字判斷執法型態（同上，全國資料沒有獨立欄位） */
export function parseEnforcementType(text: string | undefined): {
  enforcementType: EnforcementType
  alsoRedLight: boolean
} {
  const t = (text ?? '').replace(/\s+/g, '')
  const alsoRedLight = t.includes('闖紅燈')
  if (t.includes('區間測速')) return { enforcementType: 'interval', alsoRedLight }
  if (t.includes('科技執法')) return { enforcementType: 'tech_enforcement', alsoRedLight }
  return { enforcementType: 'speed_camera', alsoRedLight }
}

export const ENFORCEMENT_LABEL: Record<EnforcementType, string> = {
  speed_camera: '固定式測速',
  interval: '區間測速',
  red_light: '闖紅燈違規',
  tech_enforcement: '科技執法',
}

// ── 相機 × 路線比對 ──

/** 相機投影到路線上，垂距超過這個就當作「不在這條路上」（隔壁巷／對向分隔道） */
export const MAX_OFFSET_M = 30
/**
 * 行向與相機拍攝方向差超過這個角度 = 對向，不提醒。
 * 放到 60° 是因為方向文字只有八方位，而道路實際走向常常是斜的
 * （例：大中快速道路在文川匝道口實際走向 322°，資料寫「東向西」= 270°，差 52°）。
 */
export const HEADING_TOLERANCE_DEG = 60

export interface RouteCamera {
  camera: SpeedCamera
  /** 沿路線的里程（公尺），與 DriveState.traveledM 同一基準（route.coords 的累積長度） */
  alongM: number
  /** 相機到路線的垂直距離（公尺） */
  offsetM: number
  /** 路線在該點的行進方位角 */
  routeBearing: number
}

/** 經緯度 → 以 origin 為原點的本地平面公尺座標（本區域尺度下夠精確） */
function toLocal(p: [number, number], origin: [number, number]): [number, number] {
  return [(p[0] - origin[0]) * 111320 * COS_LAT, (p[1] - origin[1]) * 110540]
}

/**
 * 把相機清單投影到一條路線上，回傳「這趟路上會遇到、而且方向對得上」的相機，
 * 依里程排序。這是方向過濾的正解：用路線在該點的行向去比對相機的拍攝方向，
 * 對向車道的相機（例如高楠公路南向北的機器，我們正在往南開）會直接被剔掉。
 */
export function matchCamerasToRoute(
  cameras: SpeedCamera[],
  coords: [number, number][],
  cum: number[],
): RouteCamera[] {
  if (coords.length < 2) return []
  const out: RouteCamera[] = []
  for (const camera of cameras) {
    let best: { alongM: number; offsetM: number; routeBearing: number } | null = null
    for (let i = 1; i < coords.length; i++) {
      const a = coords[i - 1], b = coords[i]
      // 粗篩：離線段兩端都很遠就不必算投影（相機數量少，但路線點很多）
      if (haversine(a, camera.pos) > 2000 && haversine(b, camera.pos) > 2000) continue
      const A = toLocal(a, a), B = toLocal(b, a), P = toLocal(camera.pos, a)
      const vx = B[0] - A[0], vy = B[1] - A[1]
      const len2 = vx * vx + vy * vy
      if (len2 === 0) continue
      const t = Math.max(0, Math.min(1, (P[0] * vx + P[1] * vy) / len2))
      const cx = vx * t, cy = vy * t
      const offsetM = Math.hypot(P[0] - cx, P[1] - cy)
      if (best && offsetM >= best.offsetM) continue
      const segLen = cum[i] - cum[i - 1]
      best = { alongM: cum[i - 1] + segLen * t, offsetM, routeBearing: bearing(a, b) }
    }
    if (!best || best.offsetM > MAX_OFFSET_M) continue
    // 方向過濾：相機解不出方向（headings 空）時一律提醒，寧可多提醒不要漏
    if (camera.headings.length > 0) {
      const matched = camera.headings.some(
        (h) => Math.abs(angleDelta(best!.routeBearing, h)) <= HEADING_TOLERANCE_DEG,
      )
      if (!matched) continue
    }
    out.push({ camera, ...best })
  }
  return out.sort((x, y) => x.alongM - y.alongM)
}

// ── 提示狀態機 ──

/** 智慧型警示距離：以目前車速換算約這麼多秒的行車距離 */
const LEAD_SECONDS = 18
const MIN_ALERT_M = 180
const MAX_ALERT_M = 800
/** 進入這個距離內就升級為「逼近」（畫面轉紅、超速才再喊一次） */
export const NEAR_ALERT_M = 150
/** 通過相機後，「測速結束」還要顯示多遠（公尺） */
const PASSED_HOLD_M = 120
/** 超速寬限值：速限 +5 km/h 以內不算超速，免得車速錶誤差一直叫 */
export const OVER_SPEED_TOLERANCE_KPH = 5

/**
 * 警示距離跟著車速走（神盾的「智慧型警告距離」）：市區 50 km/h 約 250 m、
 * 快速道路 90 km/h 約 450 m。用 max(車速, 速限) 當基準，讓塞車時（車速接近 0）
 * 也不會縮到只剩幾十公尺才提醒——那樣等於沒提醒。
 */
export function alertDistanceM(speedKmh: number, speedLimitKph?: number): number {
  const basis = Math.max(speedKmh, speedLimitKph ?? 0, 30)
  return Math.min(MAX_ALERT_M, Math.max(MIN_ALERT_M, (basis / 3.6) * LEAD_SECONDS))
}

export type SpeedCameraPhase = 'approach' | 'near' | 'passed'

export interface SpeedCameraAlert {
  camera: SpeedCamera
  phase: SpeedCameraPhase
  /** 到相機的距離（公尺）；phase='passed' 時是已通過的距離（正值） */
  distanceM: number
  speedLimitKph?: number
  /** 超過速限＋寬限值 */
  overLimit: boolean
  /** 超出速限多少 km/h（未超速為 0） */
  overByKph: number
}

/**
 * 依目前里程與車速算出該顯示哪一則提示。優先順序刻意這樣定：
 *   1. 下一台已經逼近（≤ NEAR_ALERT_M）就顯示下一台——新的風險比上一台的收尾重要，
 *      連續兩台相機只隔幾十公尺時才不會還在報「已通過」就被拍。
 *   2. 否則剛通過一台就顯示「已通過」，讓駕駛知道可以恢復正常速度。
 *   3. 否則顯示警示距離內的下一台。
 */
export function speedCameraAlertAt(
  routeCameras: RouteCamera[],
  traveledM: number,
  speedKmh: number,
): SpeedCameraAlert | null {
  const overOf = (limit?: number) => {
    if (limit === undefined) return { overLimit: false, overByKph: 0 }
    const over = speedKmh - limit
    return {
      overLimit: over > OVER_SPEED_TOLERANCE_KPH,
      overByKph: over > OVER_SPEED_TOLERANCE_KPH ? Math.round(over) : 0,
    }
  }

  const next = routeCameras.find((rc) => rc.alongM > traveledM)
  const nextDistM = next ? next.alongM - traveledM : Number.POSITIVE_INFINITY

  if (nextDistM > NEAR_ALERT_M) {
    for (let i = routeCameras.length - 1; i >= 0; i--) {
      const rc = routeCameras[i]
      const passedM = traveledM - rc.alongM
      if (passedM < 0) continue
      if (passedM > PASSED_HOLD_M) break // 再往前都是更早通過的
      return {
        camera: rc.camera, phase: 'passed', distanceM: passedM,
        speedLimitKph: rc.camera.speedLimitKph, ...overOf(rc.camera.speedLimitKph),
      }
    }
  }

  if (!next || nextDistM > alertDistanceM(speedKmh, next.camera.speedLimitKph)) return null
  return {
    camera: next.camera,
    phase: nextDistM <= NEAR_ALERT_M ? 'near' : 'approach',
    distanceM: nextDistM,
    speedLimitKph: next.camera.speedLimitKph,
    ...overOf(next.camera.speedLimitKph),
  }
}

// ── 語音播報 ──

/** 距離講成整數（500 公尺、300 公尺），不要「287 公尺」那種假精確 */
function spokenDistance(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(1)} 公里`
  const step = m > 300 ? 100 : 50
  return `${Math.max(step, Math.round(m / step) * step)} 公尺`
}

export interface SpeedCameraAnnouncement {
  /** 去重用：同一台相機的同一則播報只講一次 */
  key: string
  text: string
}

/**
 * 產生該播的語音。刻意只有三則，避免像有些 App 一路唸到人麻痺：
 *   進入警示範圍 → 報距離＋速限；逼近且超速 → 催減速；通過 → 報結束。
 * 沒有要播就回 null。
 */
export function speedCameraAnnouncement(
  alert: SpeedCameraAlert | null,
): SpeedCameraAnnouncement | null {
  if (!alert) return null
  const label = ENFORCEMENT_LABEL[alert.camera.enforcementType]
  const limit = alert.speedLimitKph ? `，速限 ${alert.speedLimitKph}` : ''
  if (alert.phase === 'approach') {
    return {
      key: `${alert.camera.id}:approach`,
      text: `前方 ${spokenDistance(alert.distanceM)}，${label}${limit}`,
    }
  }
  if (alert.phase === 'near' && alert.overLimit) {
    return {
      key: `${alert.camera.id}:over`,
      text: `超速 ${alert.overByKph} 公里，請減速`,
    }
  }
  if (alert.phase === 'passed') {
    return { key: `${alert.camera.id}:passed`, text: `${label}已通過` }
  }
  return null
}

/** 相機清單 → 地圖用 GeoJSON（速限圓標圖層讀 limit / type / label） */
export function speedCamerasToGeoJson(cameras: SpeedCamera[]) {
  return {
    type: 'FeatureCollection' as const,
    features: cameras.map((c) => ({
      type: 'Feature' as const,
      id: c.id,
      properties: {
        id: c.id,
        limit: c.speedLimitKph ?? null,
        limitText: c.speedLimitKph ? String(c.speedLimitKph) : '',
        type: c.enforcementType,
        typeLabel: ENFORCEMENT_LABEL[c.enforcementType],
        address: c.address ?? '',
        directionText: c.directionText ?? '',
      },
      geometry: { type: 'Point' as const, coordinates: c.pos },
    })),
  }
}
