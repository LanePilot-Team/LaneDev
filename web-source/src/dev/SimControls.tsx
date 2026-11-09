// dev ?sim 限定：模擬駕駛中的暫停／倍率控制，與地圖點選提示。
import { SIM_BASE_KMH, SIM_MULTIPLIERS } from './sim.ts'

const box: React.CSSProperties = {
  position: 'fixed', left: 8, bottom: 8, zIndex: 9999, display: 'flex', gap: 4, alignItems: 'center',
  background: 'rgba(20,20,20,.85)', color: '#fff', font: '12px/1.4 sans-serif',
  padding: '6px 8px', borderRadius: 6,
}
const btn = (on: boolean): React.CSSProperties => ({
  font: '12px sans-serif', padding: '2px 8px', cursor: 'pointer',
  background: on ? '#2f7cf6' : '#eee', color: on ? '#fff' : '#222', border: 0, borderRadius: 4,
})

export function SimControls({ sim, driving }: {
  sim: { multiplier: number; setMultiplier: (m: number) => void; paused: boolean; togglePause: () => void }
  driving: boolean
}) {
  if (!driving) return <div style={box}>🧪 sim：點地圖設起點 → 終點，第三下重來</div>
  return <div style={box}>
    <span>🧪 模擬 {SIM_BASE_KMH * sim.multiplier} km/h</span>
    <button style={btn(false)} onClick={sim.togglePause}>{sim.paused ? '▶' : '⏸'}</button>
    {SIM_MULTIPLIERS.map((m) => <button key={m} style={btn(sim.multiplier === m)}
      onClick={() => sim.setMultiplier(m)}>{m}×</button>)}
  </div>
}
