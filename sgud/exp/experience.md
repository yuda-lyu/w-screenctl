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
## 操作紀錄與系統級開關(2026-10-26 screenctl-run02)

- **寫紀錄用 Hapi `response` 事件,不用 `onPreResponse`**:被 `onRequest` 接管(Origin／Host 拒絕)與 notFound／預檢特殊路由的請求,路由層擴充點(`onPreAuth`、`onPreResponse`)不會執行(server.ext 於建立後才註冊,不重建特殊路由的生命週期),只有 `server.events.on('response')` 對所有請求都觸發.拒絕原因由閘門寫在 `request.app.denied`,事件處理函式讀它.
- **參數摘要在 `onPreHandler` 取**(驗證之後):驗證失敗(400)的請求不會走到,因此不會把格式錯誤的 payload 記進去;被閘門攔下的請求也沒有摘要.
- **回應送出後才寫檔**:客戶端可能先收到回應、紀錄才落檔;**測試不得 sleep 或輪詢紀錄檔**(2026-10-30 起,見文末〈計時器相關測試〉):in-process 用 `test/tools/respTap.mjs` 等伺服器端 `response` 事件,子行程用 `test/tools/fileWait.mjs` 等 `fs.watch` 通知.「不應有紀錄」亦以事件序界定,不再用 300 ms 觀察窗.
- **單一字元鍵(逐鍵輸入密碼)的處理**:`/keyboard/key` 若逐字送密碼,鍵名本身就是密碼;規則:具名鍵與含 ctrl／alt／super／meta 的快捷鍵原樣記,其餘單一可印字元記 `<char>`.
- **紀錄寫入器的邊界**:延遲到首次寫入才建立目錄(建立 logger 與 bootRoutes 類測試不留檔);ENOENT 重建目錄重試一次;**每次寫入前都 `stat` 實際檔案大小,不快取**(外審 #7:快取在部分寫入失敗、兩個 logger 共檔、外部截斷時都會失準,實測 100 次部分寫入長到 11690 bytes);輪替失敗時丟棄而非繼續 append(有界優先於完整);單筆超大不拆行;`append` 部分成功後失敗要記 `dirty`,下一筆以 `\n` 開頭,否則連下一筆成功的紀錄也無法解析.連續失敗只警告一次,恢復後才再警告.
- **輪替要可還原**:先把目前檔改名到 `.rotating`(此步最常因檔案被占用而失敗,此時其他備份都還沒動),再 `.keep-1`→`.keep`、`.rotating`→`.1`;中途失敗把 `.rotating` 改回目前檔.反覆失敗不會吃掉歷史(外審 #11).
- **紀錄入檔前的清除要涵蓋所有載體,不只 body 與 Authorization**:拒絕事件發生在路由與驗證之前,Origin／Host／path 是未受信任字串,可帶帳密、query、甚至目前 token(例如把 token 誤放進 URL 路徑);因此 Origin／Host 僅在語法合法時記、path 對未註冊者遮蔽長片段、寫入器最後對現行 token 全文(原文與 JSON 跳脫兩種形式)清除.`about://user:pw@…` 也屬帳密載體,`stripUrl` 對所有協定一視同仁(外審 #1、#2).
- **開關型別要從嚴**:`0`／`[]`／`{}` 被當成「未給」會讓環境變數已關閉的功能被選項重開(外審 #3).安全相關開關只認布林、`0`／`1`、已知字串,其餘 `SCREENCTL_CONFIG` 拒絕啟動.
- **客戶端斷線後 `request.info.remoteAddress` 為空**(2026-10-26 以 `probe-abort.mjs` 實測):來源 IP 要在請求一開始(閘門之前)的 `onRequest` 先存進 `request.app.auditIp`.
- **用「位元組 vs 字元數」之類兩種估算做測試夾具,必須斷言夾具前提**(N40 首輪存活的教訓):夾具若讓兩種估算恰在同一點輪替,等於沒測.寫法:先算出兩種估算值並 assert 它們在目標點分歧,再**每寫一筆就檢查**(只看最後狀態,超限的檔案之後會被輪替掉而掩蓋).
- **測試／變異不得寫真實使用者目錄**:新增「預設寫入家目錄」的功能後,凡會啟動伺服器的測試都要同時 (a) 帶 `auditLogFile` 導向 `test/_tmp` 或 `auditLog:false`,(b) 把 HOME／USERPROFILE 指到測試夾(api 測試用 `apiHarness.useFakeHome`,g 子行程用 env,變異執行器對子行程設 env).並在每輪結束核對 `~/.w-screenctl` 不存在.
- **覆寫 USERPROFILE 會讓 Playwright 啟動 Chrome 逾時**(`launchPersistentContext timeout 20000ms`,2026-10-26 實測):會啟動真 Chrome 的場景(L5 驗收)不要覆寫 HOME／USERPROFILE,改以 `SCREENCTL_TOKEN_FILE`、`SCREENCTL_AUDIT_LOG_FILE` 明指到 `tmp`;不啟動 Chrome 的測試／變異才覆寫.兩種做法都要在結束時核對 `~/.w-screenctl` 不存在.
- **系統級端點的測試安全**:變異可能拿掉 `SYSTEM_DISABLED` 判斷,故任何會對「真實 g 子行程」送系統級請求的測試只用 `/screenshot`(唯讀);鍵鼠請求一律走 `opt.backend` 替身;Chrome 請求走 `opt.chromeManager` 替身(含 `/chrome/open`,避免啟動真 Chrome).
- **MaxListenersExceededWarning**:`WScreenctl` 每個實例對 `process` 掛 SIGTERM/SIGINT `once` 監聽且 `stop()` 不移除(既有行為,未改);同一行程起超過 10 個實例的測試需 `process.setMaxListeners`.

## 計時器相關測試(2026-10-30 tm-screenctl;規則見 rulebook〈TM-xx〉)

- **探測先於設計**:原以為「客戶端中途斷線,Hapi 會在斷線當下發 `response` 事件」,以 `tmp` 探測腳本實測為否——**請求本體已收完之斷線,Hapi 不發事件,`response` 要等 handler 完成才來**(Node 24 + @hapi/hapi 21.4.9).因此「已斷線」改由伺服器端 `socket.once('close')` 界定,不能拿 response 事件當斷線訊號.凡設計事件閘門,先用探測腳本印出事件的實際先後與時刻.
- **稽核紀錄的同步點=Hapi `response` 事件**:podium 同步、依註冊順序呼叫,稽核監聽器先註冊且同步 append,故測試端掛在其後的監聽器被呼叫時,檔案已是最終狀態(探測實測:tap 事件發生時 `lines` 已含該筆;404／成功預檢不寫、被拒預檢寫).「不該有」類斷言因此不需觀察窗.限制:若稽核寫入器日後改非同步,此同步點失效,須先在 src 加寫入完成回調.
- **子行程的紀錄檔用 `fs.watch` 等行數**(`test/tools/fileWait.mjs`):先建監看再檢查,看門狗逾時時若檔案其實已達標,訊息會註明「fs.watch 未通知」,以便辨識監看漏報.
- **`mock.timers` 只假造 `Date` 即可驗「耗時 ms」**:Hapi 以 `Date.now()` 記 `received`／`responded`,handler 以閘門停住、測試推進 250 ms 後放行 → `ms === 250`;socket 逾時、看門狗等真實計時器不受影響(看門狗須用模組載入時保存之 `setTimeout`).
- **`loadPreload` 的環境變數不可用 `SCREENCTL_` 開頭**:`api-security-g` 的 `cleanEnv` 與 `apiHarness.clearEnv` 會清掉 `SCREENCTL_*`,子行程(`node g.mjs`)就收不到負載;故不用 `SCREENCTL_`.
- **負載執行器來源與環境變數(2026-10-30 起)**:`test/tools/loadTrial.mjs`＋`loadPreload.mjs` 自 wsemi(≥1.9.33)`test/tools/` **兩檔同時整份複製**,不各自修改(原複製自 w-mousekey、環境變數 `LT_*`,已汰換);環境變數統一 `WSEMI_LT_LAG`／`WSEMI_LT_PROBE`／`WSEMI_LT_DIAG`,測試之清環境變數處只清 `SCREENCTL_*`／`PORT`／`CHROME_USER_DATA`,不會清掉 `WSEMI_LT_*`.升版時以 `cmp node_modules/wsemi/test/tools/loadTrial.mjs test/tools/loadTrial.mjs`(與 `loadPreload.mjs`)驗位元組全等.與舊版差異:不退出失敗鍵 `(mocha did not exit)`;`--run-max` 預設 900 秒(單次逾 15 分須明給 `--run-max 0` 或更大值);`--exit-grace` 即 `--hang-sec`.
- **`momo.e2e` 含於 `npm test` 的 glob**(`test/*.test.mjs`),會開有頭 Chrome 並連外網;跑全套前先確認桌面無人操作(`quser` 的閒置時間),否則排除該檔另跑.
