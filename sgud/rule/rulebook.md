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
| SEC-06 Host 檢查 | 綁迴路時 `Host` 須在 {localhost,127.0.0.1,[::1],綁定位址,allowedHosts};缺/格式異常→403(缺 Host 先被 Node 以 400 擋) | `git grep -n --untracked "parseHostHeader\|FORBIDDEN_HOST" -- src` | 站點=`createGate.onRequest`;非迴路且未設 `allowedHosts` 時不檢查=刻意不套(token 為唯一防線,README/SECURITY 已載) | R06 |
| SEC-07 高權限端點開關 | 高權限路由以 `options.app.feature` 標記;`onPreAuth` 於 token 驗證後、payload 解析前依開關回 403 | `git grep -n --untracked "feature:" -- src` | 站點=`/chrome/evaluate`(`feature:'evaluate'`)=已套;系統級 `/keyboard/*`、`/mouse/*`、`/screenshot` 刻意維持開啟(任務〈範圍〉4:本套件主要用途,受 token 保護) | R07 |
| SEC-08 非迴路須 token | `resolveSecurity` 對非迴路 host 無 token(含空字串/空白/不存在之 tokenFile)丟 `SCREENCTL_CONFIG` 並於綁 port 前拒絕 | `git grep -n --untracked "refusing to start" -- src` | 站點=`resolveSecurity`;不得有自動產生 token 後在非迴路啟動之路徑 | R08 |
| SEC-09 token 來源與持久化 | 優先序 選項>環境變數>token 檔>自動產生;自動產生者在 `server.start()` 成功後才 `persistToken`;不印 token 全文 | `git grep -n --untracked "persistToken\|describeSecurity\|console\." -- src/WScreenctl.mjs src/security.mjs` | 寫檔站點=`WScreenctl.mjs` 啟動後一處;log 站點=`describeSecurity` 與 `WScreenctl.mjs` 之 `running at`,均不含 token 變數 | R09 |
| SEC-10 設定值驗證 | `allowedOrigins`/`allowedHosts`/`enableEvaluate` 不合規格即拒絕啟動,不退化為寬鬆值 | `git grep -n --untracked "configError(" -- src` | 站點=`security.mjs` 內各 `configError`;皆回 `code='SCREENCTL_CONFIG'` | R10、unit-security |
| SEC-11 驗證不可停用 | token 只認非空字串(trim 後);其餘型別/空值=未給;格式 16~256 可印字元 | `git grep -n --untracked "TOKEN_RE\|function str(" -- src` | 站點=`resolveSecurity`;不得新增「無 token 模式」選項或旗標;`g.mjs` 不提供 `--token` | R11 |
| SEC-12 標頭嚴格解析 | 標頭值外圍空白只認 SP/HTAB(`ows`),不用 `String.prototype.trim`;原始標頭中重複的 `Host`/`Authorization` 一律拒絕(`rawCount` 讀 `request.raw.req.rawHeaders`);Host 名稱以 `parseHostHeader` 解析 | `git grep -n --untracked "\.trim()\|ows(\|rawCount(" -- src/security.mjs` | `trim()` 僅用於設定值(`str`、`toList`、token 檔內容),標頭路徑(`checkBearer`、`parseHostHeader`)一律 `ows`=已套 | R02、R06(unit + api `rawSocket`) |
| SEC-13 token 檔寫入 | 只經 `persistToken`:先寫同目錄暫存檔(`wx`,0600)再 `rename`(取代模式)或 `link`(新建模式;已存在→EEXIST 不覆寫);失敗清暫存檔;預設檔名含非預設位址;明指之檔用新建模式 | `git grep -n --untracked "writeFileSync\|renameSync\|linkSync\|persistToken" -- src` | 寫檔站點=`persistToken` 內與 `WScreenctl.mjs` 啟動後一處=已套;不得在 `server.start()` 之前寫 | R09 |

**破壞性變更紀錄**:2026-10-26 預設安全化(只綁本機、必須 token、關 CORS、evaluate 預設關),詳 README〈Upgrade Notes〉與 `SECURITY.md`.起因 OSV MAL-2026-13618.

## 一之二、操作紀錄與系統級開關規則(AUD-xx)

**單一擁有者**:`src/auditLog.mjs`(紀錄項組裝、參數摘要、寫入／輪替);設定解析與閘門在 `src/security.mjs`;接線在 `src/WScreenctl.mjs`.測試標題內之 `Axx` 與 `AUD-xx` 同號(A01=AUD-01…).測試指令同 SEC 節,另加 `test/unit-audit.test.mjs`、`test/api-audit.test.mjs`.

| 規則 | 須長成什麼樣 | 盤點指令 | 站點全集與判準 | 測試 |
|---|---|---|---|---|
| AUD-01 一動作一筆 | 唯一寫入點=`server.events.on('response')`→`audit.record`→`buildAuditEntry`;記:被拒絕者(任何端點)、已註冊且非公開之路由(成功／400／handler 失敗皆記);不記:公開路由成功(/health)、404、預檢成功 | `git grep -n --untracked "audit\.record\|events\.on('response'" -- src` | 站點=`WScreenctl.mjs` 一處=已套;不得在 handler 內另寫紀錄(會重複) | A01(unit 規則表 + api 19 路由逐筆) |
| AUD-02 參數摘要登錄表=路由表 | `SUMMARIZERS`(`AUDIT_ROUTE_KEYS`)與 `server.table()` 同集合(20 條);新增路由必須登錄,未登錄預設 `{}`;摘要只用 `pickPrim`/專用函式由白名單複製,不展開 payload | `git grep -n --untracked "server.route(" -- src`(20)對 `AUDIT_ROUTE_KEYS`(20) | api-audit 一致性測試比對兩者,新增路由未登錄即失敗 | A01 |
| AUD-03 機敏內容不入紀錄 | `/keyboard/type`、`/chrome/keyboard/type` 只記 `textLen`;evaluate 只記 `scriptLen`+`scriptSha256`;網址 `stripUrl`(任何協定去查詢字串／片段／帳密,含 `about://u:p@h`);鍵名 `redactKeys`(已知具名鍵／快捷鍵原樣;單一字素或 `KeyA`／`minus` 類 `<char>`;非已知鍵名 `<key>`);`userData` 只記 true;`origin`／`host` 欄位經 `cleanOrigin`／`cleanHost`(只留 scheme://host[:port]／host[:port],否則 `<invalid>`);未註冊路徑 `maskPath`(>24 字元片段 `<long>`),已註冊路由記樣板;`code` 只收 `^[A-Z][A-Z0-9_]*$`;寫入器 `redact` 清除目前 token 全文;token／Authorization／請求本體／回應內容／錯誤訊息全文不記 | `git grep -n --untracked "payload\|headers\|authorization" -- src/auditLog.mjs` | 讀 payload 站點=各 `sum*` 函式(白名單);讀 headers 站點=`buildAuditEntry` 僅 `origin`／`host`(僅對應拒絕碼,截斷 200)=已套 | A02(unit + api 全檔掃描 token／文字／script／查詢字串／帳密) |
| AUD-04 拒絕事件 | 閘門所有拒絕都經 `deny(request,…)` 並設 `request.app.denied=<code>`;被拒絕者不附 `params` | `git grep -n --untracked "deny(" -- src/security.mjs` | `deny(` 呼叫站點(onRequest 3、onPreAuth 3)全數傳入 request=已套 | A03 |
| AUD-05 位置／權限／大小／失敗 | 預設 `<家目錄>/.w-screenctl/audit-<port>.jsonl`(與 token 檔同目錄,非預設位址含位址段);POSIX 0600/0700;單檔 `maxBytes`(1 KiB~1 GiB,預設 5 MiB);保留 `keep`(0~100,預設 5);同步 append、首次寫入才建立;每次寫入前 stat 實際大小(不快取);輪替先把目前檔改名為 `.rotating`(此步失敗其他檔不動),中途失敗還原;首次寫入刪除超出 keep 之舊檔;append 失敗後下一筆前置換行;既有檔案權限寬於 0600 則收緊(POSIX);失敗不丟、只警告一次(恢復後才再警告);輪替失敗丟棄新紀錄使檔案有界;`ok` 無法由本體取得時以 HTTP 狀態推導;`ip` 於請求一開始取下(`app.auditIp`) | `git grep -n --untracked "appendFileSync\|renameSync\|defaultAuditFile" -- src` | 寫檔站點=`createAuditLogger` 內=已套 | A04 |
| AUD-06 系統級可關閉 | 7 條系統級路由以 `SYSTEM_APP`(`feature:'system'`)標記;`enableSystem=false` 時閘門於 token 驗證與 evaluate 判斷之後回 403 `SYSTEM_DISABLED` 並記錄;`/chrome/*` 不標;預設開 | `git grep -n --untracked "SYSTEM_APP" -- src`(8=1 定義+7 路由) | 7 條=`/screenshot`、`/mouse/{click,dblclick,drag,scroll}`、`/keyboard/{key,type}`=已套;不得標到 `/chrome/*` | A05 |
| AUD-07 啟動輸出列出能力 | `describeSecurity` 的 `capabilities` 行:chrome／系統級(on｜DISABLED)／evaluate(off｜ON)／audit-log(路徑｜OFF);audit 關閉另有警告 | `git grep -n --untracked "capabilities" -- src` | 站點=`describeSecurity` 一處 | A05(unit、api、g) |
| AUD-08 測試不得寫真實使用者目錄 | 每個會啟動伺服器之測試:(a) `auditLogFile` 導向 `test/_tmp` 或 `auditLog:false`;(b) HOME／USERPROFILE 指到測試夾(`apiHarness.useFakeHome`;g 子行程以 env);變異執行器亦同 | `git grep -n --untracked "WScreenctl(" -- test` | 站點:`apiHarness.start`(預設帶 auditLogFile)、`bootRoutes`(auditLog:false)、`momo.e2e`(auditLog:false)、`api-security` 第二實例(EADDRINUSE,HOME 已指向測試夾)=已套;g 測試經 `runG` 的 env=已套 | 每次跑完人工核對 `~/.w-screenctl` 不存在(報告附) |

## 二、改動範圍 → 測試檔對照表

| 改動 | 必跑 |
|---|---|
| `src/auditLog.mjs`、操作紀錄／`enableSystem` 之設定與閘門 | `unit-audit`、`api-audit`、`api-security-g`、`unit-security`、`api-security` |
| `src/security.mjs`、`src/WScreenctl.mjs` 之閘門/路由標記、`g.mjs` | `unit-security`、`api-security`、`api-security-g`、`unit-audit`、`api-audit`、`bootRoutes`(路由數) |
| `src/routeFactory.mjs`、`src/schemas.mjs`、`src/util/*` | 對應 unit(`routeFactory`、`errClassify`、`keyAlias`、`chromeRss`)+ `api-security`(確認 400 VALIDATION 判斷仍成立) |
| `src/chromeManager.mjs`、`src/backend/*` | `chromeManager`、`chromeRss`;有頭/真 Chrome 流程另見 `momo.e2e.test.mjs` |
| 新增/修改路由 | `bootRoutes`(EXPECTED 表)+ `api-security` R03(自動列舉全路由,新路由不需改測試即被驗)+ `api-audit`(路由表須與摘要登錄表、案例表一致:新路由必須登錄摘要並補案例) |

`momo.e2e.test.mjs`:以 `opt.headless:false` 開有頭視窗並連外網;依主控規範(本機有人使用不得跳視窗)agent 不自行執行,由主控或使用者於適當環境跑.
