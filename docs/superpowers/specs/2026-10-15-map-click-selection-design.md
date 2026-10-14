# Map Click Location Selection Design

## English specification

### Goal

Add a development-friendly way to choose route stops by clicking the map. The feature must work for the start, destination, and via stops, while preserving the existing local/Google place search and the browse-mode road-information interaction.

### User flow

1. The user enters route planning and chooses a start, destination, or via stop to edit.
2. The stop editor offers a `Select on map` action in addition to place search.
3. The app enters a scoped map-picking state for that stop and displays a compact instruction and cancel action.
4. The user taps any map position. The planner snaps it to the nearest routable lane using the existing graph snapper and distance guard.
5. On success, the selected stop is replaced, stale place metadata is cleared, the endpoint marker is updated, and the blue route is recalculated.
6. The picker exits after a successful selection. Search remains available for the same stop.

### Boundaries and behavior

- Browse-mode map taps keep their current POI selection and road-information behavior.
- Real GPS navigation is unchanged.
- Google Places is not required for map selection or coordinate storage.
- A clicked stop is labeled as a map-selected coordinate and shows longitude/latitude when no place label exists.
- Failed snapping or excessive distance keeps the picker active and reports the existing route error style.
- Replacing a searched stop clears its previous place ID, provider, address, and place position so stale UI data cannot remain.
- The existing stop order and via-stop behavior remain unchanged.

### Architecture

- Reuse the existing `pick` mode and `useMapCore` click dispatch.
- Add an explicit map-picking stop ID at the App/PlanPanel boundary so the map handler knows exactly which stop to update.
- Extend the planner map-click operation to accept the target stop ID and report whether the update succeeded.
- Keep snapping, endpoint source updates, route calculation, and route rendering inside the planner.
- Keep the UI state (instruction, cancel, and button pressed state) inside the route planning panel/App boundary.

### Validation

- Unit-test stop replacement from a map coordinate, including clearing stale place metadata and retaining the selected coordinate.
- Unit-test target-stop selection so clicking for one stop cannot update another stop.
- Run the complete web test suite and production build.
- Build and install the Android debug APK, then manually verify start, destination, via-stop selection, route redraw, and simulation start on a connected phone.

### Out of scope

- Reverse geocoding a clicked coordinate.
- Adding or changing Google Places API keys.
- Manual route dragging or alternative-route selection.
- Changes to production GPS navigation behavior.

## 繁體中文規格

### 目標

新增開發測試用的「點擊地圖選址」功能，讓使用者可以用地圖點擊設定起點、終點與停靠點，同時保留既有本地／Google 地標搜尋，以及瀏覽模式的道路資訊點擊行為。

### 使用流程

1. 使用者進入路線規劃，選擇要編輯的起點、終點或停靠點。
2. 停靠點編輯區除了搜尋地點外，提供「在地圖上選取」操作。
3. App 進入只針對該停靠點的地圖選取狀態，顯示簡短提示與取消操作。
4. 使用者點擊地圖任意位置，系統沿用既有路網吸附與距離檢查，將位置吸附到最近的可導航車道。
5. 成功後更新該停靠點、清除舊地標資料、更新端點標記並重新計算藍色路線。
6. 成功選取後離開點擊模式；同一停靠點仍可改用搜尋功能。

### 邊界與行為

- 瀏覽模式的地圖點擊維持現有地標選取與道路資訊功能。
- 正式 GPS 導航不修改。
- 點擊選址不需要 Google Places API。
- 點擊設定的停靠點顯示為地圖座標；沒有地標名稱時顯示經度／緯度。
- 吸附失敗或距離道路過遠時，維持點擊模式並沿用現有路線錯誤提示。
- 替換已搜尋的停靠點時，清除舊的 Place ID、provider、地址與地標座標，避免畫面保留過期資料。
- 既有停靠點順序與新增／移除停靠點行為不變。

### 架構

- 重用既有 `pick` 模式與 `useMapCore` 的地圖點擊分派。
- 在 App 與 PlanPanel 之間加入明確的「目前正在地圖選取哪個停靠點」狀態，讓地圖事件精準更新指定停靠點。
- 擴充 planner 的地圖點擊操作，使其能接收指定停靠點 ID，並回報更新是否成功。
- 吸附、端點資料更新、路線計算與路線繪製仍由 planner 負責。
- 提示文字、取消操作與按鈕狀態仍由路線規劃面板／App 邊界管理。

### 驗證

- 單元測試地圖座標更新停靠點，包含清除舊地標資料與保留新座標。
- 單元測試指定停靠點，確保點擊某一停靠點不會誤改其他停靠點。
- 執行完整 Web 測試與正式 build。
- 建立並安裝 Android Debug APK，使用已連接手機手動驗證起點、終點、停靠點、路線重繪與開始模擬導航。

### 不在本次範圍

- 點擊座標的地址反查。
- 新增或修改 Google Places API Key。
- 手動拖曳路線或替代路線選擇。
- 修改正式 GPS 導航行為。
