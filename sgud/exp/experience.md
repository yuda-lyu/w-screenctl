# 累積經驗

本檔為執行工作時特有之累積經驗,留給後續之嘗試、執行與判斷,由agent自行編列、擴充與維護.過長時抽出舊者為`experience_<年月日>.md`,並於本檔註明何時抽出.

## 預設安全化(2026-10-26 screenctl-run01)

- **Hapi 特殊路由不跑路由層擴充點**:`server.ext('onPreAuth', …)` 在 `Hapi.server()` 建立之後才註冊,內建的 notFound 與 CORS 預檢(OPTIONS)特殊路由不會重建生命週期,故兩者**不經 `onPreAuth`**(實測:未註冊路徑無 token 回 404 非 401).因此「擋 Origin/Host」放 `onRequest`(涵蓋一切請求),「驗 token/功能開關」放 `onPreAuth`(涵蓋所有已註冊路由);不要把 Host/Origin 檢查挪到 `onPreAuth`.
- **缺 Host 標頭**:Node http 對 HTTP/1.1 缺 Host 先回 400,不會到閘門;測試只能斷言「400 或 403,絕不放行」.
- **測試時避免真的操作桌面/開 Chrome**:驗「請求通過閘門」改用「合法 token + 空/未知欄位 payload → Joi 400 VALIDATION」或「chrome 未開 → CHROME_NOT_OPEN」;列舉全路由時 POST 一律送 `{__probe__:1}`(schema 全為 `Joi.object`,不認得之鍵必 400),即使閘門壞掉也不會真的開 Chrome 或按鍵.
- **os.homedir() 在 Windows 讀 `USERPROFILE`**(POSIX 讀 `HOME`):測試預設 token 檔路徑時把兩者指到 `test/_tmp/…`,不碰真實家目錄.
- **自動產生 token 的寫檔時機**:須在 `server.start()` 成功後.若在啟動前寫,第二個實例因 port 衝突失敗時會覆寫執行中實例的 token 檔(變異 M14 驗證;只有「零設定=預設路徑」會踩到,明指且已存在之 tokenFile 是讀不是寫).
- **Windows 綁 `0.0.0.0` 可能觸發防火牆對話框(可見視窗)**:測試不實際綁非迴路位址;該路徑由 unit(`resolveSecurity`/`describeSecurity`/`createGate`)覆蓋,拒絕啟動路徑(不綁 port)則可在 api/g 層驗.
- **rollup 建置的外部模組要寫裸名**(`'fs'`、`'crypto'`,不是 `'node:fs'`;`toolg/gDistRollup.mjs` 之 externals 只列裸名),也避免新增未列入 externals 的內建模組(如 `net`).檢查法:`tmp` 內以相同設定建一次(不動 `./dist`)並對建出之 UMD 跑 smoke.
- **`dist/` 為舊碼**:發布流程會重建;但在重建前 `dist/w-screenctl.umd.js` 仍是不安全舊版.發布前閘門可加一條 `grep -c SCREENCTL_TOKEN dist/w-screenctl.umd.js` 應 ≥ 1.
- **修前紅的 L5 做法**:`git archive HEAD src g.mjs | tar -x -C tmp/…/old`,同一個跨站探測頁(另一 port 的 HTML,內含 `fetch`)讓受控 Chrome 開啟,舊碼下頁面可把受控 Chrome 導向任意位址;新碼下全部 `Failed to fetch`.
- **eslint**:既有測試檔本來就不符專案 eslint 規則(try/catch 單行大括號等),新增測試以 `eslint --fix` 整理過;`src/`、`g.mjs` 新碼須 0 error.
- **標頭解析從嚴(外審 sol 找出)**:Node 對重複的 `Host`/`Authorization` 只留第一個,閘門從 `request.headers` 看不到後者,要讀 `request.raw.req.rawHeaders` 計數;`String.prototype.trim()` 連 NBSP 都剪,不可用在標頭值(用只認 SP/HTAB 的 `ows`);設定值(token 檔內容、環境變數)才用 `trim()`.
- **Origin 白名單用 `new URL(x).origin` 正規化**:與瀏覽器送出之序列化同一表示法(去預設 port、小寫、去前導零、無效 IPv6/超界 port 直接丟錯);請求端逐字比對,不再 `toLowerCase()`(檢查之值即使用之值).尾斜線只容許一個.
- **清單設定不得默默丟棄非字串元素**:`allowedHosts:[false]` 若被丟成空清單,會讓環境變數設定的限制失效;一律丟 `SCREENCTL_CONFIG`.
- **token 檔寫入**:同目錄暫存檔 → `rename`(伺服器自有之預設檔)/`link`(使用者明指之檔,已存在→EEXIST 不覆寫);預設檔名對非預設位址加位址段,避免同 port 不同位址互蓋.測試以注入 `fsApi`(ENOSPC、半寫入)與 monkeypatch `fs.existsSync`(模擬「解析時不存在、寫檔時已被他人建立」)重現,不需真的磁碟滿.
- **外審的效益**:sol(gpt-6.1-sol/max)約 22 分鐘找到 16 條,屬實 15(1 條範圍外既有行為);其中最有價值的是「測試只用 Joi 400 證明系統級端點通過閘門」(→ 加 `opt.backend` 替身,有 token+合法 payload 才證明維持開啟)與「OPTIONS 例外使預設拒絕可被未來路由破壞」(→ 移除).提示詞用「功能正確性審查」措辭未被擋.
- **Edit 工具會把字串內的 ` ` 轉成字面 NBSP**:eslint `no-irregular-whitespace` 會報;改用寫檔腳本把字面字元換回轉義文字,或用 `String.fromCharCode`.
- **變異測試執行器必須隔離家目錄**:被變異的程式(例如預設 host 改回 `0.0.0.0`、拿掉非迴路檢查)會正常啟動並把自動產生的 token 寫到真實的 `~/.w-screenctl/`(2026-10-26 實際發生,留下 6 個孤兒 token 檔,事後清除並回驗).跑變異時對子行程設 `HOME`、`USERPROFILE` 指到暫存夾.另外這些變異會真的綁 `0.0.0.0` 的測試 port(防火牆對話框風險),只在確有必要的變異才跑.
- **MaxListenersExceededWarning**:`WScreenctl` 每個實例對 `process` 掛 SIGTERM/SIGINT `once` 監聽且 `stop()` 不移除(既有行為,未改);同一行程起超過 10 個實例的測試需 `process.setMaxListeners`.
