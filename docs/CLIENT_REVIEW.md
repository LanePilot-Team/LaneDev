# Android 用戶端驗證與待確認事項

本次修改留在 `codex/android-standalone` 同一工作區，未提交或推送。
LaneDev 核心目標是以車道級道路、待轉區與 3D 路面資訊提供汽機車導航；
此分支把前端內建於 Android APK，以本機 HTTPS WebView 執行，不依賴開發伺服器。
本次將開發工具轉為唯讀用戶端，保留官方道路及待轉區作為導航輸入。

## 已修改範圍

1. 移除編輯、匯入與展示入口；打包排除 editor 模組，停用資料寫入與舊 localStorage 編輯覆蓋。Android 拒絕本機非 GET 資料請求。
2. 定位權限、系統定位開關檢查、目前位置按鈕；路線預設目前起點，支援自訂起終點。系統不允許 App 擅自打開 GPS，改提供系統設定入口。
3. 語音改接 Android TextToSpeech，中文語音可用狀態、下載／設定入口與試聽；不再依賴 Web Speech API。
4. 排除大眾運輸圖層、路由入口、資料檔及場站／共享單車 POI；保留停車場與一般地標。
5. 導航畫面縮短為方向、距離及簡短安全提醒，播報保留原本完整車道／道路文案，可關閉。
6. 導航視距 16–22 可選並保存，套用於導航、重新置中及重規劃。
7. 移除模擬駕駛、Demo 與速度倍率及其計時路徑。導航只依 GPS 更新；沒有以倍率推進車輛或動畫的功能。
8. 前景使用 Android rotation-vector 感測器取得手機方向；低速導航使用可靠且新鮮的朝向資料，無感測器時退回路線方向。

## 驗證紀錄（2026-09-07）

- `npm test`：22 項通過，涵蓋定位、原完整語音文案、語音開關、視距、起點建立及交通 POI 篩選。
- `npm run build`：TypeScript 與正式打包通過；模組圖檢查無 editor、模擬 Driver、transit 模組。
- `tools/gradle.ps1 assembleDebug`、`testDebugUnitTest`：通過。
- Pixel 6／Android API 37 模擬器：確認原生精確定位授權、GPS 座標、方向事件及唯讀 API 回傳 403。
- 使用模擬器注入座標測試「目前位置 → 國立高雄大學」約 1.9 公里路線，成功進入 GPS 導航；畫面方向指令、視距切換與語音關閉正常。
- 最終 APK 已重跑上述流程；驗證規劃預設目前起點，切換自訂後起終點清空、延遲 GPS 不覆蓋自訂模式。測試結束恢復視距 20 與語音開啟。
- 現有模擬器缺少中文 TTS 資料：已驗證缺少資料的提示，未驗證實際中文聲音輸出。需在裝置的文字轉語音設定下載中文資料，再按試聽。
- 真實移動、磁場校正、不同廠牌 TTS、道路安全及效能須實機驗證；本次沒有 FPS benchmark，不能視為保證固定幀率。

## 額外發現：未修改，等待使用者決定

| 問題 | 證據與可能影響 |
| --- | --- |
| GPS 停車時 ETA 可能失真 | `web-source/src/nav/gpsNav.ts` 在速度不高於 1 km/h 時將 remainS 設為 0；模擬器靜止、尚有路程時 ETA 顯示當下時間。 |
| 偏航重規劃可能跳過停靠點 | `web-source/src/nav/useDrive.ts` 的 rerouteFrom 只取最後一個 stop 作目的地；若有中途站，原規劃順序可能不保留。 |
| Google 地點搜尋備援未配置 | `web-source/index.html` 的 VITE_GOOGLE_MAPS_API_KEY 尚未提供，正式建置有警告；內建本地 POI 搜尋已測試，但不能保證 Google 備援。 |
| 新版 Android 安全區 | API 37 模擬器導航截圖中，上方指示可能與系統狀態列重疊；應另外確認 edge-to-edge / window insets。 |
| 背景／鎖屏導航未保證 | 目前沒有定位 foreground service 或背景定位設計；感測器與螢幕保持開啟只在 App 前景工作，離開 App 後持續導航需另行設計。 |
| 原始前端依賴 audit 警告 | 本次 npm audit 報告含 high / critical；production dependency 路徑包含 osmtogeojson / @xmldom/xmldom。未擅自升級，且 audit 不等於已證實 APK 有可利用漏洞，需再查實際打包及資料輸入路徑。 |

上述項目未納入本次修正；尤其 ETA、停靠點及安全區應優先確認。
