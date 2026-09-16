import { useEffect } from 'react'
import { nativeCommand, setVoice, setZoom, useClientState } from './client'
import './client.css'

export function ClientSettings({ navigating }: { navigating: boolean }) {
  const state = useClientState()
  useEffect(() => { nativeCommand('status') }, [])
  return <details className={`client-settings${navigating ? ' navigating' : ''}`}>
    <summary>設定</summary>
    <div className="client-settings-body">
      <label><input type="checkbox" checked={state.voice} onChange={e => setVoice(e.target.checked)} /> 語音導航</label>
      <label>導航視距
        <select aria-label="導航視距" value={state.zoom} onChange={e => setZoom(Number(e.target.value))}>
          {[16, 17, 18, 19, 20, 21, 22].map(zoom => <option key={zoom} value={zoom}>
            {zoom <= 17 ? '遠景' : zoom <= 19 ? '路口' : '車道'} · {zoom}
          </option>)}
        </select>
      </label>
      <p>{state.tts}</p>
      <button onClick={() => nativeCommand('ttsSettings')}>安裝／設定中文語音</button>
      <button onClick={() => nativeCommand('speak', { text: '語音導航測試，前方路口請右轉。' })} disabled={!state.voice}>試聽</button>
      <p>{state.location}</p>
      <button onClick={() => nativeCommand('locationSettings')}>開啟手機定位設定</button>
      <button onClick={() => nativeCommand('appSettings')}>App 定位權限</button>
      <p>{state.compass}{state.heading === null ? '' : ` · ${Math.round(state.heading) % 360}°`}</p>
    </div>
  </details>
}
