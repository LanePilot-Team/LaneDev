// 導航畫面狀態：GPS 導航（gpsNav）每筆定位輸出一份，HUD／語音／鏡頭共用。
import type { Maneuver } from '../core/graph.ts'
import type { ResolvedLaneGuidance } from '../core/laneGuidance.ts'

export interface DriveState {
  pos: [number, number]
  bearing: number
  speedKmh: number
  traveledM: number
  remainM: number
  remainS: number
  next: Maneuver | null
  /** next 之後緊接的動作（連動指示「隨後…」用） */
  next2: Maneuver | null
  nextDistM: number
  arrived: boolean
  /** 即將抵達（剩餘距離進入提示範圍）：HUD 提早換成抵達卡，結束才不會太突然 */
  arriving?: boolean
  /** 這筆定位精度不足以分辨車道／方向：HUD 標示訊號弱 */
  gpsWeak?: boolean
  /** 已偏離路線帶：車畫在實際定位上，路線進度暫停；離得夠遠會自動重新規劃 */
  offRoute?: boolean
  /** 目前所在道路名（span.road）——HUD 底部列顯示；detour 暫時路線可能沒有 */
  roadName?: string
  /** 目前行向的車道數/轉向真值——HUD 車道列隨所在路段即時更新 */
  roadLaneGuidance?: ResolvedLaneGuidance
  /** 高架高度（公尺）：所在路段屬高架清單時 >0，車模 z 用（core/elevation.ts） */
  elevM?: number
}

