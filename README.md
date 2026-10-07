# clinic-pace

門診看診進度 on pace 置頂小視窗（不存病人資料，只記按鍵時間與人數）。設計見 vikunja-todo dispatch runs/r1007-39/report.md。

## 怎麼用（外院電腦）

1. 把 `clinic-pace.html` 這一個檔案放在 USB 或雲端，到診間電腦上雙擊（或拖進 Chrome／Edge）。
2. 按「開啟置頂小視窗」→ 小視窗會浮在 HIS 上面（Chrome／Edge 116 以上；舊瀏覽器退成一般小視窗，不會置頂）。
3. 看完一位按 **✓ 看完**；按錯按 **↶**；沒人候診按 **空**；總人數 **−／＋**。小視窗在前面時：空白鍵／Enter＝看完、Backspace＝撤銷、I＝空檔、+／-＝人數。

狀態存在那台電腦瀏覽器的 localStorage（`file://`），關掉重開會接著算，隔天自動歸檔。
不連網路、不接 HIS。

## 開發

- 單一檔案 `clinic-pace.html`：`<script id="pace-core">` 是算法（無 DOM），`<script id="pace-ui">` 是畫面。
- 算法測試：`node --test`（直接從 HTML 抽 `pace-core` 來跑；含 r1007-39 東基兩個範例）。
- UI 冒煙測試＋截圖：`python tests/ui_check.py <輸出資料夾>`（Playwright 開有視窗的 Edge，會跳出 PiP 小視窗幾秒）。
- 站點預設值（時刻來自復健科日曆 2026-10-07）在 `DEFAULT_SITES`；玉里、關山「交通」分鐘數是估計值，實測後在頁面上改。
