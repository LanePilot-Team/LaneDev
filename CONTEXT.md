# LaneDev marking vocabulary

## 路口進入方向標線紀錄 / Approach Marking Record

一筆可人工回查的路口進入方向標線聚合資料。以既有道路區塊／進入方向鍵加上行進方向穩定識別，並明確保存路口 node，收納該方向的偏心道、附屬槽化帶、實景證據與審核狀態。它不是繪圖指令歷程；現有 `editor.journal` 的最新折疊結果才是其內容，並在同一份 `road_database.json` 輸出為 `approach_markings` 索引。

## 偏心道 / Offset Turn Bay

在接近路口處由中央帶切出的特定行進方向左轉或迴轉儲車空間。偏心道可以存在而沒有附屬槽化帶。

## 附屬槽化帶 / Bay-owned Channelization

只可依附有效偏心道的未使用中央空間標線。它不是一般道路中央槽化或實體分隔島；沒有母偏心道時不可獨立存在。

## 未使用側封閉 / Unused-side Closure

單側偏心道旁確有未使用中央空間時，以兩側邊界、端部封口與固定規格斜紋明確禁止進入的附屬槽化帶形式。
