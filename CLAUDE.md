# CLAUDE.md — 追火車組隊媒合系統

給 AI 協作者與開發者的專案規則。使用者是初學者：說明、錯誤訊息、註解一律**繁體中文**。

## 架構
- 前端：純 HTML／CSS／JS（不需要編譯），部署在 GitHub Pages。`index.html` → `js/config.js`、`js/api.js`、`js/app.js`。
- 後端：`apps-script/Code.gs`（Google Apps Script V8，綁定在使用者的 Google Sheet），`doPost` 收 JSON（`Content-Type: text/plain` 避免 CORS 預檢）。
- 資料：Sheet 工作表「設定／成員／隊伍／申請／紀錄」。網頁開關都在「設定」工作表，不必改程式。
- 本機模擬模式：localhost 且 `API_URL` 空白（或 `?local=1`）時，`dev/mock-gas.js` 模擬 Google 服務、在瀏覽器執行 Code.gs，資料存 localStorage。

## 規則
1. **所有規則都在後端檢查**（人數、權限、鎖定、第二階段）；前端只負責顯示，不能只靠前端擋。
2. 寫入資料的操作一律在 `handle_` 的 LockService 鎖內執行；**先驗證完再寫入**（Sheet 沒有交易，丟出錯誤前的寫入不會回復）。
3. 隱私：手機只給管理員；LINE ID 只給同隊隊友；生日只存加鹽雜湊。新增欄位時要決定 `share`（公開或只給隊友）。
4. Sheet 一律純文字格式（避免 09 開頭的 0 被吃掉）；使用者文字去掉開頭的 `= + - @`。
5. 不要把 LINE 群組連結、密碼放進前端檔案（repo 公開）；LINE 連結放「設定」工作表，只回傳給已登入的人。
6. 不得宣稱是官方網站；頁尾的非官方聲明不可移除。
7. 2027 年規則未公布：棒次（`LEGS`）與第二階段欄位（`PHASE2_FIELDS`）是 2026 年資料，修改前請依官方簡章。

## 測試
- 修改 Code.gs 後執行後端測試：啟動 `scripts/serve.ps1`（或雙擊 `本機預覽.cmd`），開 `http://localhost:8080/tests/backend.html`，標題顯示 `PASS` 才算通過。
- 新增後端規則時，在 `tests/backend-tests.js` 加測試；不得宣稱未執行的測試已通過。
- 這台電腦沒有 Node.js：測試與預覽都在瀏覽器執行，伺服器用 PowerShell（`.ps1` 存成 UTF-8 with BOM）。

## 部署注意
- 更新 Apps Script 要用「管理部署作業 → 編輯 → 新版本」，不要「新增部署作業」（網址會變）。
- 更新前端檔案時把 `index.html` 的 `?v=` 版本號加一，避免手機快取舊檔。
