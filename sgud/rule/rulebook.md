# 規則帳本

本檔為套件設計與開發階段之規則帳本(藍圖),為要求程式碼須長成什麼樣,或由規格產出之測試(項目/說明/流程)有哪些,包含軸、單一擁有者、已知限制、破壞性變更紀錄,以及對應是哪些測試檔案或指令等,由agent自行編列、擴充與維護.當前已做到哪些記於`sgud/state/state.md`.過長時依類型拆為`rulebook_<類型>.md`,本檔只留索引.

## 一、預設安全規則(SEC-xx)

**單一擁有者**:`src/security.mjs`(設定解析、閘門、token 檔);`src/WScreenctl.mjs` 只負責接線與路由標記.判準詞:已套/未套/刻意不套.測試標題內之 `Rxx` 與本節 `SEC-xx` 同號(R01=SEC-01…).

**測試檔與指令**(單檔指令自行編寫,不加 `.mocharc.json`;port ≥ 8000 固定):

| 檔 | 層 | port | 內容 |
|---|---|---|---|
| `test/unit-security.test.mjs` | unit | 無 | `security.mjs` 之設定解析、迴路判定、Host 解析、定時比較、閘門(替身 request) |
| `test/api-security.test.mjs` | api | 8731~8738 | 真 Hapi + 真 HTTP;`rawRequest` 可自訂 Host/Origin,`rawSocket` 可送重複標頭;系統級端點以 `opt.backend` 替身驗證(不碰真實桌面) |
| `test/api-security-g.test.mjs` | api | 8751~8759 | 真子行程 `node g.mjs`(隱藏視窗、輸出導向 `test/_tmp`) |
| `test/tools/rawHttp.mjs` | 輔助 | — | `rawRequest`(node:http)、`rawSocket`(原始 TCP) |

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

## 二、改動範圍 → 測試檔對照表

| 改動 | 必跑 |
|---|---|
| `src/security.mjs`、`src/WScreenctl.mjs` 之閘門/路由標記、`g.mjs` | `unit-security`、`api-security`、`api-security-g`、`bootRoutes`(路由數) |
| `src/routeFactory.mjs`、`src/schemas.mjs`、`src/util/*` | 對應 unit(`routeFactory`、`errClassify`、`keyAlias`、`chromeRss`)+ `api-security`(確認 400 VALIDATION 判斷仍成立) |
| `src/chromeManager.mjs`、`src/backend/*` | `chromeManager`、`chromeRss`;有頭/真 Chrome 流程另見 `momo.e2e.test.mjs` |
| 新增/修改路由 | `bootRoutes`(EXPECTED 表)+ `api-security` R03(自動列舉全路由,新路由不需改測試即被驗) |

`momo.e2e.test.mjs`:以 `opt.headless:false` 開有頭視窗並連外網;依主控規範(本機有人使用不得跳視窗)agent 不自行執行,由主控或使用者於適當環境跑.
