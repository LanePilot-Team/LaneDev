import { useEffect, useState } from 'react'
import { nativeCommand } from '../native/client'
import type { PlaceRecord } from './places'

const cache = new Map<string, Promise<string>>()
let running = 0
const queue: Array<() => void> = []
function pump() { while (running < 2 && queue.length) queue.shift()!() }
export function lookupAddress(position: [number, number]): Promise<string> {
  if (!window.LaneNative) return Promise.resolve('')
  const key = position.join(',')
  const existing = cache.get(key)
  if (existing) return existing
  const result = new Promise<string>(resolve => {
    queue.push(() => {
      running++
      const id = crypto.randomUUID()
      const timer = setTimeout(() => finish(''), 8000)
      function finish(address: string) {
        clearTimeout(timer)
        window.removeEventListener('lane-native', receive)
        running--
        if (!address) cache.delete(key)
        resolve(address)
        pump()
      }
      function receive(event: Event) {
        const data = (event as CustomEvent).detail
        if (data.type === 'addressResult' && data.id === id) finish(data.address || '')
      }
      window.addEventListener('lane-native', receive)
      nativeCommand('reverseGeocode', { id, lng: position[0], lat: position[1] })
    })
  })
  if (cache.size > 300) cache.delete(cache.keys().next().value!)
  cache.set(key, result)
  pump()
  return result
}

export function PlaceAddress({ place }: { place: Pick<PlaceRecord, 'address' | 'position'> }) {
  const [lookup, setLookup] = useState<{ key: string; text: string } | null>(null)
  const key = place.position.join(',')
  const known = place.address?.trim()
  useEffect(() => {
    if (known) return
    let active = true
    const timer = setTimeout(() => {
      lookupAddress(place.position).then(text => { if (active) setLookup({ key, text }) })
    }, 250)
    return () => { active = false; clearTimeout(timer) }
  }, [key, known])
  const result = lookup?.key === key ? lookup.text : null
  return <small className="place-address">{known || (result === null ? '查詢詳細地址中…'
    : result ? `附近地址：${result}（座標查詢，非確認門牌）`
      : `詳細地址未提供 · 座標 ${place.position[1].toFixed(5)}, ${place.position[0].toFixed(5)}`)}</small>
}
