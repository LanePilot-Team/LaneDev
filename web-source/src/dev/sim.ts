// 開發測試模式（dev 限定，見 AGENTS.md 例外條款）：`npm run dev` 且網址帶 ?sim 時生效。
//   - 地圖點一下 = 起點、再點一下 = 終點（自動規劃），第三下重新開始
//   - 規劃面板多一顆「模擬駕駛」，沿路線等速前進（移植舊 main 的 nav/drive.ts）
// prod build 時 vite.config.ts 把 src/dev/index.ts alias 成 src/devStub.ts，
// 這個目錄不會進 prod 模組圖；tools/package-client.mjs 也會擋下混進 bundle 的 src/dev/。
export const SIM = import.meta.env.DEV
  && typeof location !== 'undefined'
  && new URLSearchParams(location.search).has('sim')

/** 模擬駕駛基準速度（km/h），實際速度 = 基準 × 倍率 */
export const SIM_BASE_KMH = 40
export const SIM_MULTIPLIERS = [1, 3, 6, 10]
