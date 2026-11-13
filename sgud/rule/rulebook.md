# 規則帳本

本檔為套件設計與開發階段之規則帳本(藍圖),為要求程式碼須長成什麼樣,或由規格產出之測試(項目/說明/流程)有哪些,包含軸、單一擁有者、已知限制、破壞性變更紀錄,以及對應是哪些測試檔案或指令等,由agent自行編列、擴充與維護.當前已做到哪些記於`sgud/state/state.md`.過長時依類型拆為`rulebook_<類型>.md`,本檔只留索引.

## 一、預設安全規則(SEC-xx)

**單一擁有者**:`src/security.mjs`(設定解析、閘門、token 檔);`src/WScreenctl.mjs` 只負責接線與路由標記.判準詞:已套/未套/刻意不套.測試標題內之 `Rxx` 與本節 `SEC-xx` 同號(R01=SEC-01…).

**測試檔與指令**(單檔指令自行編寫,不加 `.mocharc.json`;port ≥ 8000 固定):

| 檔 | 層 | port | 內容 |
|---|---|---|---|
| `test/unit-security.test.mjs` | unit | 無 | `security.mjs` 之設定解析、迴路判定、Host 解析、定時比較、閘門(替身 request) |
| `test/api-security.test.mjs` | api | 8731~8738 | 真 Hapi + 真 HTTP;`rawRequest` 可自訂 Host/Origin,`rawSocket` 可送重複標頭;系統級端點以 `opt.backend` 替身驗證(不碰真實桌面) |
| `test/api-security-g.test.mjs` | api | 8751~8764 | 真子行程 `node g.mjs`(隱藏視窗、輸出導向 `test/_tmp`;子行程 HOME／USERPROFILE 指到測試夾,預設帶測試夾內之 `SCREENCTL_AUDIT_LOG_FILE`) |
| `test/unit-audit.test.mjs` | unit | 無 | `auditLog.mjs`(摘要、遮蔽、紀錄項組裝、輪替、寫檔失敗)與操作紀錄／系統級開關之設定解析、能力輸出 |
| `test/api-audit.test.mjs` | api | 8741~8748、8848 | 真 Hapi + 真 HTTP;系統級後端與 Chrome 以 `opt.backend`、`opt.chromeManager` 替身注入(不碰桌面、不啟動 Chrome);HOME 指到測試夾 |
| `test/tools/rawHttp.mjs` | 輔助 | — | `rawRequest`(node:http)、`rawSocket`(原始 TCP) |
| `test/tools/apiHarness.mjs` | 輔助 | — | api 測試共用:伺服器啟停、環境隔離(SCREENCTL_*／PORT／CHROME_USER_DATA)、假 HOME、console 攔截;`defaults()` 讓每個 `start()` 預設帶測試夾內之 `auditLogFile` |

```bash
node C:/opensrcOper/tools/quiet-run.mjs --lock --name <名> -- node node_modules/mocha/bin/mocha.js --no-parallel test/unit-security.test.mjs test/api-security.test.mjs test/api-security-g.test.mjs --timeout 60000
```

| 規則 | 須長成什麼樣 | 盤點指令 | 站點全集與判準 | 測試 |
|---|---|---|---|---|
| SEC-01 預設只綁本機 | `DEFAULT_HOST='127.0.0.1'`;Hapi `host` 取自 `sec.host`,不得寫死其他值 | `git grep -n --untracked "0\.0\.0\.0" -- src g.mjs service`;`git grep -n --untracked "host:" -- src` | `0.0.0.0` 僅出現在警告/說明文字(`WScreenctl.mjs:36`、service 註解 2 處)=已套;`Hapi.server({host})` 唯一站點=已套 | R01(unit、api、g) |
| SEC-02 全路由預設須 token | `onPreAuth` 對所有已註冊路由驗 Bearer;免 token 僅 `options.app.public === true`(嚴格 `=== true`) | `git grep -n --untracked "app: {" -- src`;`git grep -n --untracked "server.route(" -- src`(20 條) | `app.public` 站點=僅 `GET /health`;新增路由不需標記即受保護;`GET /health` 以外之路由表項由 api-security R03 列舉驗證 | R02、R03、R04 |
| SEC-03 定時比較 | token 比對只經 `checkBearer`:兩邊 sha256 後 `crypto.timingSafeEqual`,格式不符亦比一次 | `git grep -n --untracked "timingSafeEqual\|checkBearer" -- src` | 唯一比對站點=`security.mjs:checkBearer`;不得有 `===`/`equals` 比 token | unit R02(spy 驗呼叫次數與長度) |
| SEC-04 CORS 預設關 | `routes.cors` 取自 `sec.cors`(預設 `false`;僅 `allowedOrigins` 非空時為白名單、`credentials:false`) | `git grep -n --untracked "cors" -- src` | 唯一站點=`WScreenctl.mjs:79`=已套;不得出現 `cors: true`、`origin: ['*']` | R05、R10(含 `server.settings.routes.cors`) |
| SEC-05 Origin 白名單 | `onRequest`:有 `Origin` 標頭且與(已正規化之)`allowedOrigins` 不逐字相同→403;設定值經 `normalizeOrigin`(形狀檢查 + `new URL().origin`)正規化成瀏覽器表示法,只容許一個尾斜線;`*`、`null`、萬用字元、非 http(s)、含路徑、無效 IPv6、超界 port、非字串元素者啟動即拒絕 | `git grep -n --untracked "normalizeOrigin\|ORIGIN_RE\|FORBIDDEN_ORIGIN\|toList(" -- src` | 站點=`createGate.onRequest`、`resolveSecurity`、`normalizeOrigin`、`toList` | R05、R10 |
| SEC-06 Host 檢查 | 綁迴路時 `Host` 須在 {localhost,127.0.0.1,[::1],綁定位址,allowedHosts};缺/格式異常→403(缺 Host 先被 Node 以 400 擋);**判定只有一份**(`createGate` 內 `hostVerdict`),`onRequest` 與 `onPreResponse` 共用(見 SEC-14) | `git grep -n --untracked "parseHostHeader\|FORBIDDEN_HOST\|hostVerdict" -- src` | 站點=`createGate.hostVerdict`(唯一判定)、`createGate.onRequest`、`createGate.onPreResponse`;非迴路且未設 `allowedHosts` 時不檢查=刻意不套(token 為唯一防線,README/SECURITY 已載;Hapi 21.4.13 起其對格式異常者仍回 400,見 SEC-14〈已知落差〉) | R06(unit 5 案、api-security 4 案) |
| SEC-07 高權限端點開關 | 高權限路由以 `options.app.feature` 標記;`onPreAuth` 於 token 驗證後、payload 解析前依開關回 403 | `git grep -n --untracked "feature:" -- src` | 站點=`/chrome/evaluate`(`feature:'evaluate'`)=已套;系統級 `/keyboard/*`、`/mouse/*`、`/screenshot` 刻意維持開啟(任務〈範圍〉4:本套件主要用途,受 token 保護) | R07 |
| SEC-08 非迴路須 token | `resolveSecurity` 對非迴路 host 無 token(含空字串/空白/不存在之 tokenFile)丟 `SCREENCTL_CONFIG` 並於綁 port 前拒絕 | `git grep -n --untracked "refusing to start" -- src` | 站點=`resolveSecurity`;不得有自動產生 token 後在非迴路啟動之路徑 | R08 |
| SEC-09 token 來源與持久化 | 優先序 選項>環境變數>token 檔>自動產生;自動產生者在 `server.start()` 成功後才 `persistToken`;不印 token 全文 | `git grep -n --untracked "persistToken\|describeSecurity\|console\." -- src/WScreenctl.mjs src/security.mjs` | 寫檔站點=`WScreenctl.mjs` 啟動後一處;log 站點=`describeSecurity` 與 `WScreenctl.mjs` 之 `running at`,均不含 token 變數 | R09 |
| SEC-10 設定值驗證 | `allowedOrigins`/`allowedHosts`/`enableEvaluate` 不合規格即拒絕啟動,不退化為寬鬆值 | `git grep -n --untracked "configError(" -- src` | 站點=`security.mjs` 內各 `configError`;皆回 `code='SCREENCTL_CONFIG'` | R10、unit-security |
| SEC-11 驗證不可停用 | token 只認非空字串(trim 後);其餘型別/空值=未給;格式 16~256 可印字元 | `git grep -n --untracked "TOKEN_RE\|function str(" -- src` | 站點=`resolveSecurity`;不得新增「無 token 模式」選項或旗標;`g.mjs` 不提供 `--token` | R11 |
| SEC-12 標頭嚴格解析 | 標頭值外圍空白只認 SP/HTAB(`ows`),不用 `String.prototype.trim`;原始標頭中重複的 `Host`/`Authorization` 一律拒絕(`rawCount` 讀 `request.raw.req.rawHeaders`);Host 名稱以 `parseHostHeader` 解析 | `git grep -n --untracked "\.trim()\|ows(\|rawCount(" -- src/security.mjs` | `trim()` 僅用於設定值(`str`、`toList`、token 檔內容),標頭路徑(`checkBearer`、`parseHostHeader`)一律 `ows`=已套 | R02、R06(unit + api `rawSocket`) |
| SEC-13 token 檔寫入 | 只經 `persistToken`:先寫同目錄暫存檔(`wx`,0600)再 `rename`(取代模式)或 `link`(新建模式;已存在→EEXIST 不覆寫);失敗清暫存檔;預設檔名含非預設位址;明指之檔用新建模式 | `git grep -n --untracked "writeFileSync\|renameSync\|linkSync\|persistToken" -- src` | 寫檔站點=`persistToken` 內與 `WScreenctl.mjs` 啟動後一處=已套;不得在 `server.start()` 之前寫 | R09 |
| SEC-14 Hapi 先行 Host 驗證之調適(@hapi/hapi ≥ 21.4.13) | Hapi 於 `_onRequest` 開頭、早於所有 `onRequest` 擴充,即對 Host 做 RFC 9112 3.2 驗證並回 400;本套件契約(格式異常之 Host 一律 403 FORBIDDEN_HOST 並寫一筆操作紀錄)不變,作法:`gate.onPreResponse` 於 `request.response` 為 Boom 400 時,以本套件自己的 `hostVerdict` 重驗 `request.headers.host`/原始標頭,拒絕者換成 403 並記 `request.app.denied`;**只用公開介面**(不讀 `_hostError` 等私有欄位、不比對 Hapi 錯誤訊息文字);本套件判定放行者(含 `hostCheck` 關閉)維持 Hapi 原回應;非 400 之 Boom、非 Boom、已被閘門拒絕者不碰。`Hapi.server({ info: { remote: true } })` 使來源位址於請求建立時即取下(該類請求不經 `auditIp` 擴充) | `git grep -n --untracked "onPreResponse\|info: { remote\|hostVerdict" -- src`;`git grep -n --untracked "_hostError\|Invalid host header" -- src`(應為空) | `onPreResponse` 註冊站點=`WScreenctl.mjs`(須在 `server.start()` 之前註冊:啟動後補掛者不套到內建特殊路由);`hostVerdict` 呼叫站點=2(`onRequest`、`onPreResponse`)皆有接線測試;Hapi 與本套件之判定差異見下〈已知落差〉 | R06(unit:`onPreResponse` 5 案含「兩擴充判定一致」表;api-security:`HAPI_REJECTED_HOSTS` 18 種×(有/無/錯 token、POST、OPTIONS)、重複 Host、「契約全表」約 600 樣本;api-audit:10 種逐筆一筆+欄位集合+token 不落檔、重複 Host、連線即斷之 ip);變異 11/11 被抓到(項目見 state) |

**SEC-14〈已知落差〉:Hapi 21.4.13 `hostRx` 與本套件 `HOST_HEADER_RE`/白名單之差異**(實測:`tmp` 探針 2610 樣本〔隨機 + 結構化〕、`HAPI_REJECTED_HOSTS` 逐項;Hapi 規則見 `node_modules/@hapi/hapi/lib/request.js` 之 `internals.hostRx`)

| Host 形態 | Hapi 21.4.13 | 本套件 | 結果 | 處置 |
|---|---|---|---|---|
| 夾帶 userinfo(`h:p@evil`、`u@h:p`)、空白、逗號+空白多值、`/ ? # \ < > " \| ^ \` { }`、括號未閉合、非 ASCII | 400(先行) | 403 | 一律 403 FORBIDDEN_HOST + 紀錄 | `onPreResponse` 調適(SEC-14) |
| 重複 Host 標頭(第一個格式不合) | 400(先行) | 403(`rawCount`) | 403 + 紀錄 | 同上;第一個合法第二個不合:Hapi 放行,走 `onRequest` 403 |
| 空值、`h:`(空 port)、`[zz]:80`(括號內非 hex)、`a%41`、`a,b`、白名單外名稱、`h:port` 以 NBSP 包夾 | 放行(`\w.~!$&'()*+,;=%-`、`:\d*`;先 `trim()` 含 NBSP) | 403(`HOST_HEADER_RE` 較嚴;`ows` 只剝 SP/HTAB) | 403(走 `onRequest`,與升版前相同) | 無須調適(本套件更嚴) |
| 本套件放行之 Host(合法名稱,port 1~5 位數,含 `h:99999`) | 放行 | 放行 | 200 | 子集關係成立:2610 樣本中「Hapi 擋而本套件放行」=0;由「契約全表」測試鎖定(日後 Hapi 再收嚴即紅) |
| 非迴路又未設 `allowedHosts`(`hostCheck` 關閉,刻意不檢查 Host)且 Host 格式異常 | 400(先行,Hapi 原回應 `{statusCode:400,error,message}`) | 不檢查(升版前放行) | **400,且不寫操作紀錄**(本套件未拒絕、`app.denied` 未設) | **已知落差**:Hapi 先行驗證所致、非本套件契約變動;只有 unit 覆蓋(Windows 防火牆對話框風險,不實際綁非迴路位址)。是否改以本套件格式回應並寫紀錄,待裁示(報告〈需裁示〉) |
| `:authority` 與 Host 不一致(HTTP/2) | 400 | — | 不適用 | HTTP/1.1 listener 不可達(實測:Node 解析器對 `:authority` 標頭名直接 400,Hapi 不會看到);若日後改用 HTTP/2 listener 須重評 |

**破壞性變更紀錄**:2026-10-26 預設安全化(只綁本機、必須 token、關 CORS、evaluate 預設關),詳 README〈Upgrade Notes〉與 `SECURITY.md`.起因 OSV MAL-2026-13618.

## 一之二、操作紀錄與系統級開關規則(AUD-xx)

**單一擁有者**:`src/auditLog.mjs`(紀錄項組裝、參數摘要、寫入／輪替);設定解析與閘門在 `src/security.mjs`;接線在 `src/WScreenctl.mjs`.測試標題內之 `Axx` 與 `AUD-xx` 同號(A01=AUD-01…).測試指令同 SEC 節,另加 `test/unit-audit.test.mjs`、`test/api-audit.test.mjs`.

| 規則 | 須長成什麼樣 | 盤點指令 | 站點全集與判準 | 測試 |
|---|---|---|---|---|
| AUD-01 一動作一筆 | 唯一寫入點=`server.events.on('response')`→`audit.record`→`buildAuditEntry`;記:被拒絕者(任何端點)、已註冊且非公開之路由(成功／400／handler 失敗皆記);不記:公開路由成功(/health)、404、預檢成功 | `git grep -n --untracked "audit\.record\|events\.on('response'" -- src` | 站點=`WScreenctl.mjs` 一處=已套;不得在 handler 內另寫紀錄(會重複) | A01(unit 規則表 + api 19 路由逐筆) |
| AUD-02 參數摘要登錄表=路由表 | `SUMMARIZERS`(`AUDIT_ROUTE_KEYS`)與 `server.table()` 同集合(20 條);新增路由必須登錄,未登錄預設 `{}`;摘要只用 `pickPrim`/專用函式由白名單複製,不展開 payload | `git grep -n --untracked "server.route(" -- src`(20)對 `AUDIT_ROUTE_KEYS`(20) | api-audit 一致性測試比對兩者,新增路由未登錄即失敗 | A01 |
| AUD-03 機敏內容不入紀錄 | `/keyboard/type`、`/chrome/keyboard/type` 只記 `textLen`;evaluate 只記 `scriptLen`+`scriptSha256`;網址 `stripUrl`(任何協定去查詢字串／片段／帳密,含 `about://u:p@h`);鍵名 `redactKeys`(已知具名鍵／快捷鍵原樣;單一字素或 `KeyA`／`minus` 類 `<char>`;非已知鍵名 `<key>`);`userData` 只記 true;`origin`／`host` 欄位經 `cleanOrigin`／`cleanHost`(只留 scheme://host[:port]／host[:port],否則 `<invalid>`);未註冊路徑 `maskPath`(>24 字元片段 `<long>`),已註冊路由記樣板;`code` 只收 `^[A-Z][A-Z0-9_]*$`;寫入器 `redact` 清除目前 token 全文;token／Authorization／請求本體／回應內容／錯誤訊息全文不記 | `git grep -n --untracked "payload\|headers\|authorization" -- src/auditLog.mjs` | 讀 payload 站點=各 `sum*` 函式(白名單);讀 headers 站點=`buildAuditEntry` 僅 `origin`／`host`(僅對應拒絕碼,截斷 200)=已套 | A02(unit + api 全檔掃描 token／文字／script／查詢字串／帳密) |
| AUD-04 拒絕事件 | 閘門所有拒絕都經 `deny(request,…)` 並設 `request.app.denied=<code>`;被拒絕者不附 `params` | `git grep -n --untracked "deny(" -- src/security.mjs` | `deny(` 呼叫站點(onRequest 2〔Host 經 `hostVerdict`、Origin〕、onPreAuth 3、onPreResponse 1〔Hapi 先行 Host 400 之改寫,SEC-14〕)全數傳入 request=已套 | A03 |
| AUD-05 位置／權限／大小／失敗 | 預設 `<家目錄>/.w-screenctl/audit-<port>.jsonl`(與 token 檔同目錄,非預設位址含位址段);POSIX 0600/0700;單檔 `maxBytes`(1 KiB~1 GiB,預設 5 MiB);保留 `keep`(0~100,預設 5);同步 append、首次寫入才建立;每次寫入前 stat 實際大小(不快取);輪替先把目前檔改名為 `.rotating`(此步失敗其他檔不動),中途失敗還原;首次寫入刪除超出 keep 之舊檔;append 失敗後下一筆前置換行;既有檔案權限寬於 0600 則收緊(POSIX);失敗不丟、只警告一次(恢復後才再警告);輪替失敗丟棄新紀錄使檔案有界;`ok` 無法由本體取得時以 HTTP 狀態推導;`ip` 於請求一開始取下(`app.auditIp`;被 Hapi 先行擋下、不經 `onRequest` 擴充者〔SEC-14〕由 `Hapi.server({ info: { remote: true } })` 於請求建立時取下) | `git grep -n --untracked "appendFileSync\|renameSync\|defaultAuditFile" -- src` | 寫檔站點=`createAuditLogger` 內=已套 | A04 |
| AUD-06 系統級可關閉 | 7 條系統級路由以 `SYSTEM_APP`(`feature:'system'`)標記;`enableSystem=false` 時閘門於 token 驗證與 evaluate 判斷之後回 403 `SYSTEM_DISABLED` 並記錄;`/chrome/*` 不標;預設開 | `git grep -n --untracked "SYSTEM_APP" -- src`(8=1 定義+7 路由) | 7 條=`/screenshot`、`/mouse/{click,dblclick,drag,scroll}`、`/keyboard/{key,type}`=已套;不得標到 `/chrome/*` | A05 |
| AUD-07 啟動輸出列出能力 | `describeSecurity` 的 `capabilities` 行:chrome／系統級(on｜DISABLED)／evaluate(off｜ON)／audit-log(路徑｜OFF);audit 關閉另有警告 | `git grep -n --untracked "capabilities" -- src` | 站點=`describeSecurity` 一處 | A05(unit、api、g) |
| AUD-08 測試不得寫真實使用者目錄 | 每個會啟動伺服器之測試:(a) `auditLogFile` 導向 `test/_tmp` 或 `auditLog:false`;(b) HOME／USERPROFILE 指到測試夾(`apiHarness.useFakeHome`;g 子行程以 env);變異執行器亦同 | `git grep -n --untracked "WScreenctl(" -- test` | 站點:`apiHarness.start`(預設帶 auditLogFile)、`bootRoutes`(auditLog:false)、`momo.e2e`(auditLog:false)、`api-security` 第二實例(EADDRINUSE,HOME 已指向測試夾)=已套;g 測試經 `runG` 的 env=已套 | 每次跑完人工核對 `~/.w-screenctl` 不存在(報告附) |

## 一之三、計時器相關之測試規則(TM-xx;2026-10-30,tm-screenctl)

**規格正本**:`C:\opensrcOper\dspec\計時器相關函數之觀察回調與測試.md`(P1~P7)與全域技能 role-coder-for-test §8(細則 `references/timer-tests.md`);本節只記本套件的落地與站點全集,不重述規格.

**本套件特性**:被測的稽核寫入器(`createAuditLogger`)為**同步 append、無計時器**(`git grep -n "setTimeout\|setInterval" -- src/auditLog.mjs` 為空),故依規格「無計時器之函數:改等被測物事件,不為測試改 src」——**沒有新增任何 `opt.onTrace`**,對外行為與 JSDoc 未動.

| 規則 | 須長成什麼樣 | 盤點指令 | 站點全集與判準 | 測試 |
|---|---|---|---|---|
| TM-01 in-process 稽核紀錄以 Hapi `response` 事件為同步點 | 掛在稽核監聽器**之後**的 `test/tools/respTap.mjs`(`tapResponses`):每個請求以 `tap.request()` 送出(等到伺服器端 response 事件才返回),其後讀紀錄檔即最終狀態;不 sleep、不輪詢紀錄檔.依據:podium 同步且依註冊順序呼叫監聽器,`audit.record` 為同步 append,`WScreenctl.mjs` 先註冊.**若稽核寫入器日後改為經計時器或 I/O 回呼才落檔(串流、佇列),本同步點即失效(變異 M02〔setImmediate 延後一輪〕新舊測試皆抓不到,因客戶端往返已涵蓋該延後),須先在 src 加寫入完成之觀察回調(`onTrace`,事件列舉寫入 JSDoc,並補五種回調案)再改本規則** | `git grep -n "sleep(\|waitLines" -- test`(應為空)；`git grep -n "tapResponses" -- test` | `api-audit.test.mjs` 全檔(改前 32 站點:`waitLines` 輪詢呼叫 17〔含 `last` 輔助 1,其下 9 個呼叫點〕、輪替案自寫輪詢 1、`sleep(300/400)` 否定窗 11、`sleep(900)` 1、handler 內 `sleep(250/300)` 2;改後 0)=已套 | api-audit 全檔 |
| TM-02 否定斷言(不該有紀錄、不該多一筆)以事件序界定 | 不用觀察窗:`/health`、404、成功預檢、`auditLog:false` 之「不寫」,於該請求(及其後續請求)之 response 事件過後立即斷言;客戶端中途斷線案另加**屏障請求**(其處理須經過事件迴圈,handler 完成後之續行必已跑完)再數行.**已知限制**:計時器遲發(數十毫秒後才補寫)之重複寫入,response 事件當下抓不到(src 稽核路徑無計時器);改由第一區塊末尾之「A01 收尾」總量守恆案抓(整段測試經過的時間即觀察區間,非 sleep;變異 M03 新版 1 案轉紅,舊版 6 案) | 同上 | api-audit 之 11 處否定窗=已套;`api-security-g` 之 `--no-audit-log`(子行程,拿不到其事件)=後續請求完整處理後斷言(殘留限制同上) | api-audit、api-security-g |
| TM-03 時間本身是規格者用假時鐘 | 「ms 反映實際處理時間」:`mock.timers.enable({ apis: ['Date'] })` 只假造 Date,handler 以閘門停住、測試推進 250 ms 後放行,斷言 `ms === 250`、`ts` 為假時鐘起點;真實計時器(socket、看門狗)不受影響;`finally` 內 `mock.timers.reset()` | `git grep -n "mock.timers" -- test` | api-audit「耗時（ms）」一案=已套;其餘 `e.ms` 只斷言有限非負(不設牆鐘上界) | api-audit |
| TM-04 客戶端中途斷線以事件閘門排序 | handler 閘門 `started`→客戶端 `req.destroy()`→伺服器端 `socket.once('close')`→放行 handler→`done`→該請求 response 事件→屏障請求;**實測 Hapi 對「請求本體已收完」之斷線不發事件,response 事件要等 handler 完成才來**(故用 socket close 界定「已斷線」)；舊作法(handler sleep 300、80 ms 後斷線、sleep 900)在負載下順序顛倒會悄悄退化成一般請求 | — | api-audit「客戶端在處理中途斷線」=已套 | api-audit |
| TM-05 子行程(`node g.mjs`)以可觀察條件同步 | 就緒=`/health` 200(啟動輸出為同步寫檔,此時已齊)並與子行程 `exit` 競爭(提早結束即時失敗);稽核紀錄落檔以 `test/tools/fileWait.mjs`(`fs.watch` 通知,先建監看再檢查)等行數;看門狗(真實計時器)只防懸置 | `git grep -n "waitUp\|waitFileLines" -- test` | `api-security-g` 之 `waitUp` 12 處、`waitFileLines` 1 處=已套;`waitUp` 內 100 ms 為重試節奏,非等待假設 | api-security-g |
| TM-06 外部網站渲染等待 | `momo.e2e`:`sleep(5000)` 改為兩個頁面可觀察之就緒條件,條件式重試(取樣 500 ms、看門狗 45 s):①`document.readyState==='complete'`(測試端伺服器加 `enableEvaluate:true` 僅供讀此值;實測 headless 於約 4.4 s 達成,而 0.9 s 時 readyState 仍為 loading、截圖卻已 14975B,故不可只看截圖大小)②截圖為 >10000B 之 PNG;`ok:false` 為真失敗不重試.外部站點本身不可控之部分(改版、限流、驗證頁)仍可使本案失敗,屬環境事實 | `git grep -n "WATCHDOG_MS" -- test/momo.e2e.test.mjs` | 1 站點=已套 | momo.e2e(有頭+外網,見下方〈對照表〉) |
| TM-07 src 計時器不加 `onTrace` 之理由 | 逐站:`chromeManager._withDeadline`(測試直接 await 其 rejection/回值,無延時同步;已補清計時器之斷言)、`chromeManager` 清理寬限 `TIMEOUT_CLEANUP_GRACE`(需真 Chrome,無測試依其時序)、`WScreenctl` evaluate 5 s 逾時(測試只驗訊息分類 `errClassify`)、`gracefulShutdown` 硬逾時(`unref`,無測試) | `git grep -n "setTimeout" -- src` | 5 站點(`chromeManager.mjs:210,270,282`、`WScreenctl.mjs:215,471`;2026-11-13 行號依 pm-sc 改動更新,站點未增減)=刻意不加 | `chromeManager` |
| TM-08 負載試驗 | `test/tools/loadTrial.mjs`＋`loadPreload.mjs` **整份複製自 wsemi `test/tools/`(1.9.33 起統一版,兩檔須同時複製、不各自修改;需擴充者回報 wsemi)**;環境變數 `WSEMI_LT_LAG`／`WSEMI_LT_PROBE`／`WSEMI_LT_DIAG`(不可用 `SCREENCTL_` 開頭,因測試之 `cleanEnv`／`apiHarness.clearEnv` 會清 `SCREENCTL_*`;`WSEMI_LT_*` 不在被清之集合內,測試端無需處理).不退出之失敗鍵 `(mocha did not exit)`(原 `(mocha did not exit by itself)`;本套件無依此鍵解析之程式);`--hang-sec`(別名 `--exit-grace`,預設 30)、`--run-max`(預設 900 秒,單次逾 15 分須給 `--run-max 0` 或更大值)、`--guard`、`--diag`.三種負載:`--burners 8`、`--lag 400:1000`、`--lag 1500:3000`;一律 `quiet-run --lock-exclusive`,PID 回驗,每次 mocha 須自行退出.依賴外網之 `momo.e2e` 不納入(外部站點之耗時不可重現,且有頭視窗) | `node test/tools/loadTrial.mjs --out <夾> --runs 5 --burners 8 --cwd <夾> -- --no-parallel test/api-audit.test.mjs test/api-security-g.test.mjs test/chromeManager.test.mjs --timeout 180000`;位元組比對:`cmp node_modules/wsemi/test/tools/loadTrial.mjs test/tools/loadTrial.mjs`(`loadPreload.mjs` 同) | 兩檔與 wsemi 1.9.33 位元組全等=已套;`LT_` 無殘留(`git grep -n "LT_" -- test sgud` 僅 `WSEMI_LT_` 與本條說明) | 見任務報告 |

## 一之四、Chromium 系瀏覽器之啟動規則(PW-xx;2026-11-13,pm-sc,排程第 442 項)

**背景**:Windows 上 Chrome 153 起每啟動一個新的瀏覽器根行程即以錯誤密碼呼叫一次 `LogonUser`(10 分鐘內 10 次鎖帳號);自有套件 w-playwright 於每次啟動之命令列恰給一個 `--disable-features`(Playwright 預設＋`AutofillAiWalletPrivatePasses`＋呼叫端自給者).全庫規則見 w-playwright 帳本 R-PW-ONLY、R-PW-WIRING;本節只記本套件之落地與站點全集.**單一擁有者**:`src/chromeManager.mjs` 之 `_launch`.測試標題之 `PW-0x` 與本節同號.

| 規則 | 須長成什麼樣 | 盤點指令 | 站點全集與判準 | 測試 |
|---|---|---|---|---|
| PW-01 唯一啟動點經 w-playwright | `_launch` 以 `wpw.launchChromiumPersistent(dir, ctxOpts)` 啟動;`src`、`test`、`toolg`、`g.mjs` 不得以靜態／動態 import、`require` 引用 `playwright`／`playwright-core`;`package.json` 不宣告兩者(依 `w-playwright` ^1.0.1);`toolg/gDistRollup.mjs` 之 external／globals 為 `'w-playwright'` | `rg -n --glob '*.{mjs,js}' --glob '!**/node_modules/**' --glob '!**/dist/**' --glob '!**/docs/**' "(from\s+\|import\(\s*\|require\(\s*)['\"\`]playwright(-core)?['\"\`/]" .`(應 0;防空集合:同正則對 `node_modules/w-playwright/src/_pw.mjs` 須命中);`rg -n "\"playwright(-core)?\"\s*:" package.json`(應 0);`rg -n "wpw\.(launchChromium\|launchChromiumPersistent)\(" src`(應 1) | 啟動站點全集=1(`chromeManager.mjs` `_launch`)=已套 | `unit-chromeLaunch`(選項矩陣 6 格、reuse／replace)、`api-chromeLaunch` PW-01/02;變異 M1(不經 wpw,以替身 context 模擬)、M6(改非持久 `launchChromium`)轉紅 |
| PW-02 送出之選項 | `channel:'chrome'`、`headless`(`opt.headless !== false`)、`ignoreDefaultArgs:['--enable-automation']`、`locale:'zh-TW'`、`viewport`、`deviceScaleFactor`(有 viewport 時)、`args` 原序(含 `--disable-features=Translate`,由 w-playwright 併入唯一一串;合併前即須含之,不依賴 Playwright 預設清單是否含 `Translate`);`userDataDir` 只解析相對路徑(`path.isAbsolute ? 原字串 : path.resolve`),絕對路徑原字串照交——與 Playwright 用戶端原本之處理相同(`coreBundle.js` `launchPersistentContext`),w-playwright 介面要求非空者為絕對路徑.合併後命令列恰一個 `--disable-features`、為最後一個元素、含 Playwright 預設＋守門＋`Translate` | 同上 | 判準:`wpw.setBrowserTypeForTest` 替身收到之合併選項;合併前之選項以測試端包裝 `wpw.launchChromiumPersistent`(記錄後照常轉呼叫)取得 | 同上;變異 M2(拿掉 channel)、M3(`ignoreDefaultArgs:true`)、M4(不轉絕對)、M5(拿掉 `Translate`)、M7(headless 反轉)、M8(絕對路徑亦 `path.resolve`)皆轉紅 |
| PW-03 失敗通道 | 啟動失敗之錯誤為 w-playwright 之固定詞彙(`E_LAUNCH`「browser launch failed」、`E_LAUNCH_TIMEOUT`「browser launch timed out」、`E_ENV`、`E_PW_VERSION`、`E_LOGON_GUARD`);`chromeManager` 照舊以 `err.message` 記 `lastError`、`errClassify` 不改(逾時→`TIMEOUT`,其餘 `UNKNOWN`;**瀏覽器啟動即結束原由 Playwright 訊息 `Target … closed` 分類為 `CHROME_NOT_OPEN`/`after_recovery`,遷移後為 `UNKNOWN`/`never`**,已載於 README);本套件不傳 `funLog`(不輸出 Playwright 原錯誤;〈診斷輸出與遮罩〉D1 例外、D2);不支援之環境變數只擋「需啟動」者(新開、`replace`),已開啟而重用者照常.**已知限制**:`W_PLAYWRIGHT_LOGON_GUARD` 開啟時 w-playwright 把同行程之非 headless shell 啟動排入同一佇列(`_launchCore.mjs` `withLogonLock`);本套件 `_launch` 之 20 秒期限與 30 秒寬限不知佇列,排隊中之啟動可能於本套件回報逾時後才真正發生(其 context 由逾時路徑之 `launchP.then(ctx.close)` 關閉),排隊後之守門拒絕亦被逾時訊息蓋過.單一 `ChromeManager` 已以 `_opLock` 序列化,只在同行程多個管理器或單次啟動逾 50 秒時出現;不改(屬 w-playwright 之佇列設計,外審 terra F2) | `rg -n "funLog" src`(應 0) | `_launch` 之 catch 一處=已套 | `unit-chromeLaunch`(`E_LAUNCH`、`E_LAUNCH_TIMEOUT`、`E_ENV` ×2、已開啟後設 `PWDEBUG` 之 reuse／replace)、`api-chromeLaunch` PW-03(HTTP 回應表:一般、逾時、啟動即結束;`PWDEBUG`) |
| PW-04 真路徑接線 | 至少一案以替身之 `next({ ...o, channel: undefined, headless: true })` 交回 w-playwright 真啟動受管之 headless shell(非真 Chrome/Edge/完整 Chromium,不觸發 LogonUser),驗 `/chrome/open`→頁面截圖 PNG→`DELETE /chrome`;未安裝 headless shell 時 skip(略過不算通過) | — | `api-chromeLaunch` PW-04 一處=已套 | `api-chromeLaunch` |
| PW-05 真 Chrome 測試之紀律 | 會啟動真 Chrome／Edge／完整 Chromium 之測試檔每檔最多啟動一次(`before` 起、`after` 關,it 失敗或重試不再啟動);`after` 以測試持有之 `ChromeManager`(經 `WScreenctl({ chromeManager })` 傳入)之 `shutdown` 確實關閉後才停服務,清理失敗不吞掉;Windows 啟動前以 `w-playwright/test/tools/readBadPassword.mjs` 讀錯誤密碼次數,不可讀或非 0 即略過整檔;關閉後再讀須不變——末案於流程中斷言(並斷言確有啟動成功),`after` 另於「嘗試過啟動」時一律再比對;只在主控以守門監看之時段執行(agent 不自跑) | `rg -n "chrome/open\|readBadPassword" test/momo.e2e.test.mjs` | 站點=`momo.e2e`(唯一真 Chrome 測試)=已套 | `momo.e2e`(2026-11-13 未跑,`--dry-run` 載入 4 案) |

**破壞性變更**:命令列之 `--disable-features` 由「只有本套件之 `Translate`(Playwright 預設 18 項整串失效)」改為「Playwright 預設＋`AutofillAiWalletPrivatePasses`＋`Translate`」;啟動失敗之 `error` 改為固定詞彙(瀏覽器啟動即結束之 `code`/`retry` 由 `CHROME_NOT_OPEN`/`after_recovery` 改為 `UNKNOWN`/`never`);`PWDEBUG`(inspector)、`SELENIUM_REMOTE_URL` 時需啟動之 `/chrome/open` 失敗.詳 README〈Upgrade Notes〉.

**dist 檢查**(發布前;測試不建置 dist):以副本並指定 cwd 執行 `toolg/gDistRollup.mjs`,建出之 `dist/w-screenctl.umd.js` 須 `require("playwright")`／`require("playwright-core")` 0 處、`require("w-playwright")` ≥1;2026-11-13 已以此法實跑並由 dist 正式入口經替身驗接線(恰一串、含守門與 `Translate`).

## 二、改動範圍 → 測試檔對照表

| 改動 | 必跑 |
|---|---|
| `src/auditLog.mjs`、操作紀錄／`enableSystem` 之設定與閘門 | `unit-audit`、`api-audit`、`api-security-g`、`unit-security`、`api-security` |
| `src/security.mjs`、`src/WScreenctl.mjs` 之閘門/路由標記、`g.mjs` | `unit-security`、`api-security`、`api-security-g`、`unit-audit`、`api-audit`、`bootRoutes`(路由數) |
| `src/routeFactory.mjs`、`src/schemas.mjs`、`src/util/*` | 對應 unit(`routeFactory`、`errClassify`、`keyAlias`、`chromeRss`)+ `api-security`(確認 400 VALIDATION 判斷仍成立) |
| `src/chromeManager.mjs`、`src/backend/*` | `chromeManager`、`chromeRss`、`unit-chromeLaunch`、`api-chromeLaunch`(PW-04 真啟動 headless shell 一次);有頭/真 Chrome 流程另見 `momo.e2e.test.mjs` |
| 升級 `w-playwright`(或改動啟動選項、`toolg/gDistRollup.mjs` 之 external) | `unit-chromeLaunch`、`api-chromeLaunch`、`chromeManager` + PW-01 盤點指令;真 Chrome 之 `momo.e2e` 由主控於守門監看下另排 |
| 升級 `@hapi/hapi`(或改動請求生命週期擴充點之註冊) | `unit-security`、`api-security`、`api-audit`、`api-security-g`、`bootRoutes` + 其餘非瀏覽器測試(Hapi 在 `onRequest` 之前先行驗證〔SEC-14〕之類變動,只會在真 Hapi 的 api 測試現形) |
| 新增/修改路由 | `bootRoutes`(EXPECTED 表)+ `api-security` R03(自動列舉全路由,新路由不需改測試即被驗)+ `api-audit`(路由表須與摘要登錄表、案例表一致:新路由必須登錄摘要並補案例) |

`momo.e2e.test.mjs`:以 `opt.headless:false` 開有頭視窗並連外網;依主控規範(本機有人使用不得跳視窗)agent 不自行執行,由主控或使用者於適當環境跑.
