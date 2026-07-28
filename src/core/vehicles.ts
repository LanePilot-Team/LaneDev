// 放置的車輛模型（Simulation Layer 雛形）：吸附到車道中心、沿路向擺放。
// 3D 渲染在 models3d.ts（three.js 自訂圖層）；本檔只管資料與存取。

export interface PlacedVehicle {
  id: string
  type: 'car' | 'moto'
  pos: [number, number]
  bearing: number
  road?: string
}

const KEY = 'navsim-vehicles-v1'

export function loadVehicles(): PlacedVehicle[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]')
  } catch {
    return []
  }
}

export function saveVehicles(v: PlacedVehicle[]) {
  localStorage.setItem(KEY, JSON.stringify(v))
}

