// 轉彎步驟清單：路線規劃完成後在側面板逐步列出指引（沒進導航模式也能看懂整條路線）。
// 文字與箭頭直接重用導航 HUD 的 guidanceText / ManeuverArrow，不另寫一份文案；
// 兩段式左轉項目用黃底（與導航看板的待轉提醒同色系）。
import type { Profile, RouteResult } from '../core/graph'
import { guidanceText, ManeuverArrow } from '../nav/DriveHUD'

function fmtDist(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(1)} 公里`
  return `${Math.max(10, Math.round(m / 10) * 10)} 公尺`
}

export function ManeuverList({ route, profile }: { route: RouteResult; profile: Profile }) {
  let prev = 0
  return (
    <div className="mlist">
      {route.maneuvers.map((m, i) => {
        const segM = m.distM - prev
        prev = m.distM
        const twoStage = !!m.twoStage
        const bay = !twoStage && m.bayOffM !== undefined
        return (
          <div key={i} className={`mlist-item${twoStage ? ' two-stage' : ''}`}>
            <ManeuverArrow kind={twoStage ? 'two-stage' : m.kind} />
            <div className="mlist-text">
              <span className="mlist-dist">{segM < 15 ? '隨即' : `${fmtDist(segM)}後`}</span>
              <span className="mlist-act">{guidanceText(m, 'near', profile, twoStage, bay)}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
