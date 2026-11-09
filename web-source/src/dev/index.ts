// dev 工具唯一入口。prod build 時 vite.config.ts 把這個檔 alias 成 src/devStub.ts，
// 所以 src/dev/ 底下的模組完全不會進入 prod 模組圖（package-client.mjs 會再檢查一次）。
export { SIM } from './sim.ts'
export { SimDriver } from './simDrive.ts'
export { SimControls } from './SimControls.tsx'
