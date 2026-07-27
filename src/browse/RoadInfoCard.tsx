// 瀏覽模式：點擊道路顯示路段資訊卡。
import type { Map as MLMap, PointLike } from 'maplibre-gl'

/** 瀏覽模式點擊：命中的路段屬性（沒點到路回 null） */
export function queryRoadInfoAt(map: MLMap, point: PointLike): Record<string, unknown> | null {
  const hit = map.queryRenderedFeatures(point, {
    layers: ['road-surface', 'roads-simple'],
  })
  return hit.length > 0 ? { ...hit[0].properties } : null
}

export function RoadInfoCard({ info, onClose }: {
  info: Record<string, unknown>; onClose: () => void
}) {
  return (
    <div className="road-card">
      <div className="road-name">{String(info.name ?? '（未命名道路）')}</div>
      <div className="road-attrs">
        <span>{String(info.highway)}</span>
        <span>{String(info.lanes ?? '?')} 車道</span>
        <span>{info.oneway === 'yes' ? '單行' : '雙向'}</span>
        {Boolean(info.maxspeed) && <span>限速 {String(info.maxspeed)}</span>}
      </div>
      <div className="road-src">OSM way/{String(info.osm_id)} · Base Layer</div>
      <button className="mini" onClick={onClose}>×</button>
    </div>
  )
}
