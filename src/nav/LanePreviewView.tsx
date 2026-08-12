import type { CSSProperties } from 'react'
import type { LaneArrowKind, LanePreviewAction, LanePreviewModel } from './lanePreview'
import twoStageWaitSign from './assets/lane-guidance/two-stage-wait-sign.png'

const ARROW_LABEL: Record<LaneArrowKind, string> = {
  left: '左轉',
  through: '直行',
  right: '右轉',
  'through-left': '直行或左轉',
  'through-right': '直行或右轉',
  uturn: '迴轉',
}

/**
 * 一格車道的箭頭。複合車道（直行＋轉彎）畫成**兩支各自完整的箭頭疊在一起**：
 * 每支都從格子底部起筆、含自己的轉折與箭頭頭部，選中的那支畫在最上層。
 *
 * 舊版對複合箭頭是「共用一根主幹 + 兩截分支」，而且選中某一支時另一支整個不畫，
 * 於是畫面上只剩一個方向、其餘樣式消失；未選中的部分又用半透明疊上去，交疊處
 * 會透出下層而糊成一片。改成「完整箭頭疊圖 + 未選中用不透明灰」後，
 * 直行時是一支完整的直箭頭壓在灰色轉彎箭頭上，轉彎時反過來，兩者都不會被切斷。
 */
const ARROW_PATH: Record<'through' | 'left' | 'right', string> = {
  through: 'M32 58V14',
  left: 'M32 58V32Q32 25 24 25H15',
  right: 'M32 58V32Q32 25 40 25H49',
}
const ARROW_HEAD: Record<'through' | 'left' | 'right', string> = {
  through: '32,4 23,17 41,17',
  left: '5,25 18,16 18,34',
  right: '59,25 46,16 46,34',
}

function LaneArrow({ kind, highlightedAction }: {
  kind: LaneArrowKind
  highlightedAction?: LanePreviewAction
}) {
  if (kind === 'uturn') {
    const className = highlightedAction ? 'lane-arrow-part-active' : 'lane-arrow-part-muted'
    return (
      <svg className="lane-preview-arrow" viewBox="0 0 64 64" aria-hidden="true">
        <path className={className} d="M43 58V27C43 15 35 9 26 9S10 16 10 27v12" />
        <polygon className={className} points="10,48 1,35 19,35" />
      </svg>
    )
  }
  const branches: ('through' | 'left' | 'right')[] =
    kind === 'through-left' ? ['through', 'left']
      : kind === 'through-right' ? ['through', 'right']
        : [kind]
  // 選中的行向若不屬於這格（理論上不會發生），整格照舊整支點亮
  const highlighted = highlightedAction
    && (branches as string[]).includes(highlightedAction)
    ? highlightedAction
    : undefined
  const classOf = (branch: string) => !highlightedAction
    ? 'lane-arrow-part-muted'
    : highlighted === undefined || highlighted === branch
      ? 'lane-arrow-part-active'
      : 'lane-arrow-part-muted'
  // 未選中的先畫、選中的後畫 → 選中那支完整壓在上層，不會被另一支切斷
  const order = [...branches].sort((a, b) =>
    Number(a === highlighted) - Number(b === highlighted))
  return (
    <svg className="lane-preview-arrow" viewBox="0 0 64 64" aria-hidden="true">
      {order.map((branch) => (
        <g key={branch} className={classOf(branch)}>
          <path d={ARROW_PATH[branch]} />
          <polygon points={ARROW_HEAD[branch]} />
        </g>
      ))}
    </svg>
  )
}

function previewLabel(model: LanePreviewModel): string {
  if (model.status === 'no-data') return '暫無車道資料'
  const active = model.lanes
    .map((lane, index) => lane.active ? `第 ${index + 1} 車道` : null)
    .filter((value): value is string => value !== null)
  const truncated = model.truncated ? '，來源超過十車道，僅顯示前十條' : ''
  return `共 ${model.lanes.length} 車道，建議 ${active.join('、') || '無'}${truncated}`
}

export function TwoStageWaitSign() {
  return (
    <img
      className="two-stage-sign"
      src={twoStageWaitSign}
      alt="機車兩段式左轉待轉標誌"
    />
  )
}

export function LanePreviewPanel({ model }: { model: LanePreviewModel }) {
  if (model.status === 'no-data') {
    return (
      <div className="lane-preview lane-preview-empty" aria-label={previewLabel(model)}>
        暫無車道資料
      </div>
    )
  }

  return (
    <div className="lane-preview" aria-label={previewLabel(model)}>
      <div
        className="lane-preview-row"
        style={{ '--lane-count': model.lanes.length } as CSSProperties}
      >
        {model.lanes.map((lane, index) => (
          <div className={`lane-preview-cell lane-preview-cell-${lane.state}`} key={index}>
            <LaneArrow kind={lane.arrow} highlightedAction={lane.highlightedAction} />
            <span className="sr-only">{`第 ${index + 1} 車道：${ARROW_LABEL[lane.arrow]}，${
              lane.state === 'primary' ? '主要建議' :
                lane.state === 'secondary' ? '可用替代' : '不建議'
            }`}</span>
          </div>
        ))}
      </div>
      {model.inferenceNote && <div className="lane-preview-note">{model.inferenceNote}</div>}
      {model.warningNote && <div className="lane-preview-warning">{model.warningNote}</div>}
    </div>
  )
}
