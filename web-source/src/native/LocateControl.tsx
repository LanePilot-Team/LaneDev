import { useEffect, useRef, useState } from 'react'
import { Marker } from 'maplibre-gl'
import type { MapCore } from '../app/mapCore'
import { requestCurrentPosition } from '../nav/geolocation'
import { deviceHeading, subscribeClientState } from './client'

export function LocateControl({ core, loading, navigating }: {
  core: MapCore; loading: boolean; navigating: boolean
}) {
  const marker = useRef<Marker | null>(null)
  const sequence = useRef(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    sequence.current++
    setBusy(false)
    setError('')
    if (navigating) { marker.current?.remove(); marker.current = null }
    return () => { sequence.current++; marker.current?.remove(); marker.current = null }
  }, [navigating])
  useEffect(() => {
    const update = () => {
      const current = deviceHeading()
      marker.current?.setRotation(current ?? 0)
      if (marker.current) {
        marker.current.getElement().dataset.heading = current === null ? 'unknown' : 'known'
        marker.current.getElement().setAttribute('aria-label', current === null
          ? '目前位置；朝向暫不可用' : `目前位置；面向 ${Math.round(current)} 度，扇形為朝向`)
      }
    }
    // 直接改 marker DOM，不經 React 重繪；1 秒計時負責把過期（>3s）的方向隱藏
    update()
    const unsubscribe = subscribeClientState(update)
    const timer = setInterval(update, 1000)
    return () => { unsubscribe(); clearInterval(timer) }
  }, [])
  async function locate() {
    const id = ++sequence.current
    setBusy(true); setError('')
    try {
      const result = await requestCurrentPosition()
      if (id !== sequence.current || !core.mapRef.current) return
      marker.current?.remove()
      const element = document.createElement('div')
      element.className = 'client-location-marker'
      const currentHeading = deviceHeading()
      element.dataset.heading = currentHeading === null ? 'unknown' : 'known'
      const beam = document.createElement('span'); beam.className = 'location-beam'
      const dot = document.createElement('span'); dot.className = 'location-dot'
      element.append(beam, dot)
      element.setAttribute('aria-label', '目前位置與手機朝向')
      marker.current = new Marker({ element, rotationAlignment: 'map', rotation: currentHeading ?? 0 })
        .setLngLat(result.position).addTo(core.mapRef.current)
      core.mapRef.current.easeTo({ center: result.position, zoom: 18 })
    } catch (e) { if (id === sequence.current) setError(e instanceof Error ? e.message : '無法定位') }
    finally { if (id === sequence.current) setBusy(false) }
  }
  if (navigating) return null
  return <div className="client-locate">
    {error && <p role="alert">{error}</p>}
    <button
      type="button"
      disabled={busy || loading}
      onClick={locate}
      aria-label={busy ? '定位中' : '目前位置'}
      title={busy ? '定位中' : '目前位置'}
    >
      <svg className="locate-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
      </svg>
    </button>
  </div>
}
