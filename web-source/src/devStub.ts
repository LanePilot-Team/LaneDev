// prod build 用的 dev 工具空殼（vite.config.ts 把 src/dev/index.ts alias 到這裡）。
// 介面要跟 src/dev/index.ts 一致；使用處都另有 import.meta.env.DEV 守住，這些不會被呼叫。
import type { SimDriver as RealSimDriver } from './dev/simDrive.ts'
import type { SimControls as RealSimControls } from './dev/SimControls.tsx'

export const SIM = false
export const SimDriver = null as unknown as typeof RealSimDriver
export const SimControls = (() => null) as unknown as typeof RealSimControls
