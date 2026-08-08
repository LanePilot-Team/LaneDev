import type { CSSProperties } from 'react'
import type { LaneArrowKind, LanePreviewModel } from './lanePreview'
import activeLeft from './assets/lane-guidance/active-left.png'
import activeThrough from './assets/lane-guidance/active-through.png'
import activeRight from './assets/lane-guidance/active-right.png'
import activeThroughLeft from './assets/lane-guidance/active-through-left.png'
import activeThroughRight from './assets/lane-guidance/active-through-right.png'
import inactiveLeft from './assets/lane-guidance/inactive-left.png'
import inactiveThrough from './assets/lane-guidance/inactive-through.png'
import inactiveRight from './assets/lane-guidance/inactive-right.png'
import inactiveThroughLeft from './assets/lane-guidance/inactive-through-left.png'
import inactiveThroughRight from './assets/lane-guidance/inactive-through-right.png'
import twoStageWaitSign from './assets/lane-guidance/two-stage-wait-sign.png'

const ACTIVE: Record<LaneArrowKind, string> = {
  left: activeLeft,
  through: activeThrough,
  right: activeRight,
  'through-left': activeThroughLeft,
  'through-right': activeThroughRight,
}

const INACTIVE: Record<LaneArrowKind, string> = {
  left: inactiveLeft,
  through: inactiveThrough,
  right: inactiveRight,
  'through-left': inactiveThroughLeft,
  'through-right': inactiveThroughRight,
}

const ARROW_LABEL: Record<LaneArrowKind, string> = {
  left: '左轉',
  through: '直行',
  right: '右轉',
  'through-left': '直行或左轉',
  'through-right': '直行或右轉',
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
            <img
              className="lane-preview-arrow"
              src={(lane.state === 'inactive' ? INACTIVE : ACTIVE)[lane.arrow]}
              alt={`第 ${index + 1} 車道：${ARROW_LABEL[lane.arrow]}，${
                lane.state === 'primary' ? '主要建議' :
                  lane.state === 'secondary' ? '可用替代' : '不建議'
              }`}
            />
          </div>
        ))}
      </div>
      {model.inferenceNote && <div className="lane-preview-note">{model.inferenceNote}</div>}
      {model.warningNote && <div className="lane-preview-warning">{model.warningNote}</div>}
    </div>
  )
}
