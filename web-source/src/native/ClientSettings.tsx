import { useEffect } from 'react'
import { nativeCommand, setVoice, setZoom, useClientState } from './client.ts'
import './client.css'

export function ClientSettings({ navigating }: { navigating: boolean }) {
  const state = useClientState()
  useEffect(() => { nativeCommand('status') }, [])
  return <details className={`client-settings${navigating ? ' navigating' : ''}`}>
    <summary aria-label="設定" title="設定">
      <span className="settings-icon" aria-hidden="true">⚙</span>
    </summary>
    <div className="client-settings-body">
      <section className="settings-section">
        <h3>導航</h3>
        <label className="settings-row"><span>語音導航</span><input type="checkbox" checked={state.voice} onChange={e => setVoice(e.target.checked)} /></label>
        <label className="settings-row"><span>導航視距</span>
          <select aria-label="導航視距" value={state.zoom} onChange={e => setZoom(Number(e.target.value))}>
            {[16, 17, 18, 19, 20, 21, 22].map(zoom => <option key={zoom} value={zoom}>
              {zoom <= 17 ? '遠景' : zoom <= 19 ? '路口' : '車道'} · {zoom}
            </option>)}
          </select>
        </label>
      </section>

      <details className="settings-section settings-subsection">
        <summary>語音設定</summary>
        <div className="settings-subsection-body">
          <p className="settings-status">{state.tts}</p>
          <div className="settings-actions">
            <button onClick={() => nativeCommand('ttsInstall')}>下載中文語音</button>
            <button onClick={() => nativeCommand('ttsSettings')}>系統語音設定</button>
            <button onClick={() => nativeCommand('ttsRefresh')}>重新檢查語音</button>
            <button onClick={() => nativeCommand('ttsTest')}>試聽中文</button>
          </div>
          <p className="settings-status" role="status">{state.speech}<br />{state.audio}</p>
        </div>
      </details>

      <details className="settings-section settings-subsection">
        <summary>定位與方向</summary>
        <div className="settings-subsection-body">
          <p className="settings-status">{state.location}</p>
          <div className="settings-actions">
            <button onClick={() => nativeCommand('locationSettings')}>開啟手機定位設定</button>
            <button onClick={() => nativeCommand('appSettings')}>App 定位權限</button>
          </div>
          <p className="settings-status">{state.compass}{state.heading === null ? '' : ` · ${Math.round(state.heading) % 360}°`}</p>
        </div>
      </details>
    </div>
  </details>
}
