# 路線預覽面板設計規格 / Route Preview Panel Design Specification

## 繁體中文版

### 目標

將使用者按下「路線」後看到的路線規劃介面，改成接近 Google 導航的精簡路線預覽：地圖維持主要視覺，路線直接畫在地圖上；下方浮動卡片集中呈現起點、終點、交通工具、距離／時間與開始導航操作。

### 使用者體驗

1. 使用者從地點搜尋結果按下「路線」後，進入路線預覽模式。
2. 地圖顯示目前計算出的路線預覽，不被面板完全遮住。
3. 浮動卡片標題為「路線預覽」，只保留短提示「確認起終點後即可開始導航」。
4. 起點與終點各自顯示：
   - 起點／終點標籤與顏色圓點。
   - 地點名稱或「目前位置」。
   - 可用寬度內的地址摘要。
   - 「更換」按鈕。
5. 「更換」會開啟該端點的搜尋流程；選定新地點後，回到預覽卡片並更新路線、距離與時間。
6. 保留「新增停靠點」操作，並使用次要的虛線按鈕，避免與主要導航操作競爭。
7. 汽車／機車切換與短提示同列，使用兩個等寬圖標選項呈現目前車種，並保留可及性標籤。
8. 卡片底部只保留一個滿寬、醒目的「開始導航」按鈕；在起點尚未定位、正在定位、端點搜尋中或路線無效時，按鈕維持停用並顯示目前可操作狀態。
9. 關閉路線面板的 X 按鈕保留，關閉後回到地圖瀏覽模式，不改變既有清除路線與模式切換行為。

### 版面與視覺

- 桌面與較寬畫面：使用左側或上方的浮動白色卡片，地圖仍保持可見。
- 手機畫面：使用固定在上方、具有限制高度的浮動卡片，卡片圓角與地圖重疊，但保留約 45–50% 畫面給主要路線預覽。
- 卡片內容按「路線預覽 → 車種 → 起點／終點 → 停靠點 → 距離／時間 → 開始導航」排序。
- 不再顯示目前面板中較長的操作說明段落。
- 目的地地址只顯示地點名稱與地址，不顯示「座標查詢，非確認門牌」。
- 路線計算、導航狀態、端點資料格式與既有資料來源不變；本次只調整介面呈現與端點編輯入口。

### 元件與資料流

- `PlanPanel`：保留現有起點／停靠點／終點狀態與 `planner` 呼叫，改寫呈現結構與精簡文案。
- `PlaceSearch`：沿用既有地點搜尋元件；由 `PlanPanel` 傳入目前要編輯的 stop，成功選取後呼叫既有 `planner.setStopDestination`。
- `usePlanner`：不改路線計算與路線摘要 API；車種切換仍使用既有 `toggleProfile`。
- 地圖路線圖層：不改既有 route source 或 route preview 繪製流程。
- 開始導航：仍由既有 `startGpsNav` callback 觸發。

### 錯誤與狀態

- 定位失敗：在卡片內顯示現有可操作錯誤，使用者仍可搜尋並設定起點。
- 路線計算失敗：保留現有錯誤訊息，隱藏或停用開始導航按鈕，避免啟動無效導航。
- 搜尋端點時：卡片進入搜尋狀態，保留取消操作；未選取結果不覆蓋原本端點。
- 路線重算中：沿用現有 `mapLoading`／定位狀態控制，避免重複開始導航。

### 驗收條件

- 按下搜尋結果的「路線」後，可以同時看到地圖路線預覽與起終點卡片。
- 起點與終點各有可操作的「更換」入口，選取新地點後路線資訊會更新。
- 汽車／機車切換仍可用，且目前選項清楚可辨識。
- 「新增停靠點」仍可用；既有停靠點不會因 UI 改版遺失。
- 開始導航按鈕在可導航狀態下滿寬顯示，且仍觸發既有導航流程。
- 手機寬度下卡片不水平溢出、不遮住主要操作；桌面寬度下地圖仍可辨識。
- 現有自動化測試維持通過，Android debug APK 可成功編譯與安裝。

### 不在本次範圍

- 不更換路由演算法、路網資料、Google Places API 或定位服務。
- 不重新設計導航中的 HUD、語音播報或地圖樣式。
- 不新增帳號、同步、收藏或歷史路線功能。

### 2026-10-07 實機回饋修訂

本節 supersedes the earlier mobile bottom-sheet placement for the route preview card.

- 手機版路線預覽卡固定在畫面上方，地圖與路線預覽留在下方。
- 定位與設定按鈕回到底部右側，不能因路線卡片展開而被擠到上方。
- 起點與終點改成緊湊的預填欄位：同一列顯示顏色圓點、起點／終點標籤、目前值與「更換」按鈕。
- 地址降為欄位下方的小字；不為地址另占一張大卡片。
- 汽車／機車改成固定高度、固定欄寬的分段控制，切換時不改變面板高度或按鈕位置。
- 新增停靠點保留為次要操作，開始導航保持在卡片底部的滿寬主按鈕。

### 2026-10-07 Feedback Revision

This section supersedes the earlier mobile bottom-sheet placement for the route preview card.

- On phones, pin the route preview card at the top so the map and route preview remain visible below it.
- Return the locate/settings controls to the bottom-right; expanding the route card must not push those controls upward.
- Render origin and destination as compact prefilled rows: colored dot, origin/destination label, current value, and a same-row “更換” action.
- Reduce the address to a small secondary line below each field instead of a separate large content block.
- Use a fixed-height, equal-width segmented control for car/motorcycle selection so switching does not change the card height or button positions.
- Keep adding a via stop as a secondary action and keep the full-width start-navigation button at the bottom of the card.

### 2026-10-07 Compact Vehicle and Scroll Revision

依照實機回饋，再縮短路線預覽卡的第一視覺層級：

- 「確認起終點後即可開始導航」與汽車／機車控制放在同一列。
- 汽車／機車只顯示圖標，不再顯示完整文字；保留 `aria-label`、tooltip 與選取狀態，避免辨識性與可及性下降。
- 路線卡採固定可視高度，約保留手機畫面 45–50% 的地圖空間。
- 標題列、起點、終點、既有停靠點與「新增停靠點」屬於固定可見區；「新增停靠點」不得因內容變長而需要滑動才能找到。
- 路線距離／時間、開始導航與路線步驟放在卡片內部的可滾動內容區，避免整張面板持續向上推擠地圖與地圖操作。
- 編輯起點／終點或搜尋結果展開時，卡片仍可在手機高度內滾動；搜尋結果不得遮住關閉與取消操作。

### 2026-10-07 Compact Vehicle and Scroll Revision (English)

Based on device feedback, reduce the first visual layer of the route preview card:

- Place “確認起終點後即可開始導航” and the car/motorcycle controls on one row.
- Show icons only for car/motorcycle; retain `aria-label`, tooltip, and selected state so discoverability and accessibility are not lost.
- Give the route card a bounded visible height, targeting roughly 45–50% of the phone viewport for the map.
- Keep the header, origin, destination, existing via stops, and “新增停靠點” in the always-visible region; the add-via action must not require scrolling to discover.
- Put route distance/time, start navigation, and route steps in an internal scroll region so the whole panel does not continue pushing map controls away.
- When editing a stop or showing search results, keep the card scrollable within the phone viewport; search results must not cover close or cancel controls.

---

## English Version

### Goal

Redesign the route-planning screen shown after the user taps “路線” into a compact Google-Navigation-like route preview. The map remains the primary visual surface with the route drawn on it, while a floating card summarizes the origin, destination, vehicle type, distance/time, and navigation action.

### User Experience

1. Tapping “路線” from a place-search result enters route-preview mode.
2. The map shows the calculated route preview and remains substantially visible.
3. The floating card is titled “路線預覽” and keeps only the short hint “確認起終點後即可開始導航”.
4. Each origin and destination row shows a colored marker, a label, a place name or “目前位置”, an address summary when available, and a “更換” action.
5. Tapping “更換” opens the existing search flow for that stop. Selecting a new place returns to the preview card and updates the route, distance, and duration.
6. “新增停靠點” remains available as a secondary dashed action so it does not compete with the primary navigation action.
7. Car/motorcycle selection shares a row with the short hint and uses two equal-width icon options with accessible labels and a clear selected state.
8. The card ends with one full-width, prominent “開始導航” button. It remains disabled while the origin is locating, a stop is being edited, or no valid route is available.
9. The existing close button remains and returns to browse mode without changing the existing route-clearing and mode-switching behavior.

### Layout and Visual Direction

- On desktop and wide screens, use a floating white card near the left/top area while keeping the map visible.
- On phones, use a top-pinned floating card with a bounded height; it may overlap the map while preserving roughly 45–50% of the viewport for the route preview.
- Order the content as: route preview, vehicle type, origin/destination, via stops, distance/time, and start navigation.
- Remove the current long instructional paragraph.
- Show only the place name and address for a selected destination; do not show “座標查詢，非確認門牌”.
- Keep routing, navigation state, stop data, and data sources unchanged; this change is limited to presentation and stop-edit entry points.

### Components and Data Flow

- `PlanPanel`: keep the existing stop state and planner calls, but replace the presentation structure and verbose copy.
- `PlaceSearch`: reuse the existing place-search component; `PlanPanel` provides the stop being edited and continues to call `planner.setStopDestination` after selection.
- `usePlanner`: do not change route calculation or route-summary APIs; vehicle switching continues to use `toggleProfile`.
- Map route layers: do not change the existing route source or route-preview rendering pipeline.
- Start navigation: continue to invoke the existing `startGpsNav` callback.

### Errors and States

- Location failure: show the existing actionable error inside the card and allow manual origin search.
- Route calculation failure: preserve the existing error text and disable or hide start navigation to prevent invalid navigation.
- Stop editing: show the search state and cancellation action; do not replace the existing stop until a result is selected.
- Route recalculation: continue using the existing loading/location state to prevent duplicate navigation starts.

### Acceptance Criteria

- After tapping “路線”, the user can see both the map route preview and an origin/destination card.
- Origin and destination each expose a working “更換” entry point, and selecting a new place updates route information.
- Car/motorcycle switching remains functional with a visible selected state.
- “新增停靠點” remains functional and existing via stops are preserved.
- The start-navigation button is full-width when actionable and still triggers the existing navigation flow.
- The card does not overflow horizontally on phone widths and leaves primary map controls usable; the route remains recognizable on desktop widths.
- Existing automated tests continue to pass, and the Android debug APK builds and installs successfully.

### Out of Scope

- Changing routing algorithms, road-network data, Google Places API, or location services.
- Redesigning the in-navigation HUD, voice guidance, or map style.
- Adding accounts, synchronization, favorites, or route history.
