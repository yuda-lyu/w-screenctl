# w-screenctl
An operator for chrome or system in nodejs.

![language](https://img.shields.io/badge/language-JavaScript-orange.svg) 
[![npm version](http://img.shields.io/npm/v/w-screenctl.svg?style=flat)](https://npmjs.org/package/w-screenctl) 
[![license](https://img.shields.io/npm/l/w-screenctl.svg?style=flat)](https://npmjs.org/package/w-screenctl) 
[![npm download](https://img.shields.io/npm/dt/w-screenctl.svg)](https://npmjs.org/package/w-screenctl) 
[![npm download](https://img.shields.io/npm/dm/w-screenctl.svg)](https://npmjs.org/package/w-screenctl) 
[![jsdelivr download](https://img.shields.io/jsdelivr/npm/hm/w-screenctl.svg)](https://www.jsdelivr.com/package/npm/w-screenctl)

## Documentation
To view documentation or get support, visit [docs](https://yuda-lyu.github.io/w-screenctl/WScreenctl.html).

## Installation

### Using npm(ES6 module):
```alias
npm i w-screenctl
```

### 前置依賴（系統側）

| 平台 | 必裝 | 用途 |
|---|---|---|
| 全部 | Google Chrome | `/chrome/*` 走 Playwright `channel: 'chrome'`，需系統實機 Chrome |
| Linux | `xdotool`、`imagemagick` | 系統級 mouse/keyboard、`/screenshot` |
| Windows | 無額外需求 | `w-mousekey` 已含 AHK 64-bit |

```bash
# Ubuntu / Debian
sudo apt install xdotool imagemagick

# Fedora / RHEL
sudo dnf install xdotool ImageMagick
```

## Upgrade Notes

### 預設安全化（破壞性變更；1.0.26 之後的版本起）

早期版本啟動即於 `0.0.0.0:7000` 開放**無認證、CORS 全開**之 HTTP 服務，且含 `POST /chrome/evaluate`（任意 JS）與系統級 `/keyboard/*`、`/mouse/*`：同網段任何人，乃至使用者瀏覽之任意網頁（跨站請求），皆可操控主機（見 OSV MAL-2026-13618 與 [SECURITY.md](SECURITY.md)）。本套件之用途（讓開發者與 AI agent 以 HTTP 操控瀏覽器與桌面）不變，但改為**預設安全**：

| 項目 | 舊行為 | 新行為 | 需要舊行為時 |
|---|---|---|---|
| 監聽位址 | `0.0.0.0`（區網可連） | `127.0.0.1`（僅本機） | `host` 選項／`SCREENCTL_HOST`。綁非迴路位址**必須先給 token**，否則拒絕啟動 |
| 認證 | 無 | 除 `GET /health` 外，所有端點須 `Authorization: Bearer <token>` | token 未給時啟動自動產生。**無法關閉驗證** |
| CORS／跨站 | 全開 | 關閉：帶 `Origin` 之請求一律 403，`Host` 標頭須為本機名稱（擋 DNS rebinding） | `allowedOrigins` 白名單（仍須 token） |
| `POST /chrome/evaluate` | 開 | **關**（403 `EVALUATE_DISABLED`） | `enableEvaluate: true`／`SCREENCTL_ENABLE_EVALUATE=1`／`node g.mjs --evaluate` |
| 其餘（端點路徑、功能語意、payload、回應格式） | | 不變 | |

升級時要做的事：

1. 呼叫端對所有端點（`/health` 除外）加上 `Authorization: Bearer <token>`，位址改用 `http://127.0.0.1:<port>`。
2. 呼叫端在另一台機器：優先用 SSH 通道（`ssh -L 7000:127.0.0.1:7000 host`）；確需直連才綁非迴路位址並自行設 token（見[安全預設](#安全預設)）。
3. 依賴 `/chrome/evaluate` 者：啟動時顯式開啟。
4. 由網頁直接呼叫本服務者：設 `allowedOrigins`，且仍須帶 token。
5. 程式內呼叫（`WScreenctl({...})`）未給 `token` 時，會自動產生並寫入 `~/.w-screenctl/token-<port>`；測試或 CI 請明給 `token`（不會寫檔）。
6. 自動啟動設定（`service/`）已改為本機綁定，token 由環境變數或檔案提供，見[自動啟動 / 部署](#自動啟動--部署)。

### 新增操作紀錄與系統級開關（向下相容；操作紀錄預設開啟）

| 項目 | 行為 | 如何調整 |
|---|---|---|
| 操作紀錄 | 每次控制動作與每次被拒絕之請求各記一行 JSON，寫入 `~/.w-screenctl/audit-<port>.jsonl`（首次寫入才建立）；不記 token、輸入文字、script 全文，詳見[操作紀錄](#操作紀錄audit-log) | `auditLog: false`／`SCREENCTL_AUDIT_LOG=0`／`--no-audit-log` 關閉；`auditLogFile` 改位置 |
| 系統級端點可關閉 | 預設仍開啟（與先前一致）；只需操控 Chrome 時可整批關閉 `/screenshot`、`/mouse/*`、`/keyboard/*`，改回 403 `SYSTEM_DISABLED` 並記錄 | `enableSystem: false`／`SCREENCTL_ENABLE_SYSTEM=0`／`--no-system` |
| 啟動輸出 | 多一行 `[security] capabilities: …`，列出目前啟用之能力（系統級、evaluate、操作紀錄路徑） | — |

升級注意：預設會在使用者目錄新增紀錄檔（單檔上限 5 MiB、輪替保留 5 份，總量約 30 MiB）；測試或 CI 請以 `auditLogFile` 導向暫存夾，或 `auditLog: false`。

## API 控制說明

w-screenctl 啟動後對外提供 REST API，讓外部程式 / AI agent 透過 HTTP 控制：
- **作業系統桌面**：滑鼠、鍵盤、桌面截圖（Linux 走 xdotool / ImageMagick；Windows 走 w-mousekey / AHK）
- **Chrome 瀏覽器**：開關、導頁、頁面截圖、執行 JS、頁面內滑鼠鍵盤事件（透過 Playwright；跨平台）

> ⚠ 能呼叫本服務者即擁有該主機之滑鼠、鍵盤與 Chrome 控制權。預設只綁本機並要求 token，請妥善保管 token，細節見[安全預設](#安全預設)。

### 啟動

#### 最省事：本機開發／AI agent

```bash
node g.mjs
# running at http://127.0.0.1:7000 (platform=...)
# [security] bind=127.0.0.1 (loopback only) | auth=Bearer token (generated) | evaluate=disabled | cors=off
# [security] token file: /home/you/.w-screenctl/token-7000     ← token 自動產生並寫在此檔（不會印出 token 全文）
# [security] capabilities: chrome=on | system(mouse/keyboard/screenshot)=on | evaluate=off | audit-log=/home/you/.w-screenctl/audit-7000.jsonl (max 5242880 bytes x 5 rotated)

TOKEN=$(cat ~/.w-screenctl/token-7000)
curl http://127.0.0.1:7000/health                                          # 免 token
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7000/chrome        # 其餘都要 token

node g.mjs --evaluate           # 需要 /chrome/evaluate 時顯式開啟（等同 SCREENCTL_ENABLE_EVALUATE=1）
node g.mjs --no-system          # 只操控 Chrome 時，關閉系統級滑鼠鍵盤與桌面截圖（等同 SCREENCTL_ENABLE_SYSTEM=0）
PORT=8000 node g.mjs            # 改 port（token 檔、操作紀錄隨之改為 …-8000）
```

以 npm 安裝者，啟動腳本在套件內：`node node_modules/w-screenctl/g.mjs`。要在背景啟動並把 token 檔放在專案暫存夾（不碰家目錄）：`SCREENCTL_TOKEN_FILE=./tmp/screenctl.token SCREENCTL_AUDIT_LOG_FILE=./tmp/screenctl-audit.jsonl nohup node node_modules/w-screenctl/g.mjs > ./tmp/screenctl.log 2>&1 &`，之後 `TOKEN=$(cat ./tmp/screenctl.token)`（token 檔與操作紀錄都在專案暫存夾，清掉 `tmp/` 即一併清除）。

Windows PowerShell 取 token：`$TOKEN = (Get-Content "$HOME\.w-screenctl\token-7000").Trim()`；用 `curl.exe`（不是 `curl` 別名）呼叫。自行指定 token 亦可：`SCREENCTL_TOKEN=<16 字元以上之隨機字串> node g.mjs`。

#### 程式內呼叫

```js
import WScreenctl from 'w-screenctl'

const server = await WScreenctl({ port: 7000, token: process.env.MY_TOKEN })
// 啟動後印出: running at http://127.0.0.1:7000 (platform=...)
// 未給 token：自動產生並寫入 ~/.w-screenctl/token-7000；綁非迴路位址又未給 token：丟出 Error（code 'SCREENCTL_CONFIG'）拒絕啟動
```

#### 命令列旗標（`node g.mjs`）

旗標只是 `WScreenctl` 選項之捷徑；**沒有 `--token`**（會出現在行程列表與 shell 歷史），token 請用環境變數或檔案。

| 旗標 | 對應選項 | 說明 |
|---|---|---|
| `--host <addr>` | `host` | 監聽位址；非迴路位址須已有 token |
| `--token-file <path>` | `tokenFile` | 檔案存在則讀其內容為 token；不存在則自動產生並寫入該檔 |
| `--evaluate` | `enableEvaluate` | 開啟 `POST /chrome/evaluate` |
| `--allow-origin <origin>` | `allowedOrigins` | 放行跨站 Origin，可重複 |
| `--allow-host <name>` | `allowedHosts` | 額外接受之 Host 名稱，可重複 |
| `--no-system` | `enableSystem: false` | 關閉系統級端點（`/screenshot`、`/mouse/*`、`/keyboard/*`），改回 403 `SYSTEM_DISABLED` 並記錄 |
| `--no-audit-log` | `auditLog: false` | 不寫操作紀錄（啟動時印警告） |
| `--audit-log-file <path>` | `auditLogFile` | 操作紀錄檔位置 |
| `-h`、`--help` | | 顯示用法 |

開機自動啟動見 [自動啟動 / 部署](#自動啟動--部署)。

#### 設定一覽

| 設定 | 選項 | 環境變數 | 預設 | 優先序 |
|---|---|---|---|---|
| Port | `port` | `PORT` | `7000` | 環境變數 > 選項（既有行為） |
| Chrome user data 目錄 | `fdUserData` | `CHROME_USER_DATA` | 當前工作路徑 `./user_data/`（首次啟動自動建立） | 環境變數 > 選項（既有行為） |
| 監聽位址 | `host` | `SCREENCTL_HOST` | `127.0.0.1` | 選項 > 環境變數 |
| Bearer token | `token` | `SCREENCTL_TOKEN` | 自動產生（僅迴路位址） | 選項 > 環境變數 > token 檔 > 自動產生 |
| token 檔 | `tokenFile` | `SCREENCTL_TOKEN_FILE` | `~/.w-screenctl/token-<port>` | 選項 > 環境變數 |
| 開啟 `/chrome/evaluate` | `enableEvaluate` | `SCREENCTL_ENABLE_EVALUATE`（`1`/`true`/`yes`/`on`） | 關 | 選項 > 環境變數 |
| 系統級端點（滑鼠、鍵盤、桌面截圖） | `enableSystem` | `SCREENCTL_ENABLE_SYSTEM`（`0`/`false`/`no`/`off` 關閉） | 開 | 選項 > 環境變數 |
| 操作紀錄 | `auditLog` | `SCREENCTL_AUDIT_LOG`（`0`/`false`/`no`/`off` 關閉） | 開 | 選項 > 環境變數 |
| 操作紀錄檔 | `auditLogFile` | `SCREENCTL_AUDIT_LOG_FILE` | `~/.w-screenctl/audit-<port>.jsonl` | 選項 > 環境變數 |
| 單檔上限（位元組） | `auditLogMaxBytes` | `SCREENCTL_AUDIT_LOG_MAX_BYTES` | `5242880`（5 MiB；範圍 1024～1073741824） | 選項 > 環境變數 |
| 輪替保留份數 | `auditLogKeep` | `SCREENCTL_AUDIT_LOG_KEEP` | `5`（範圍 0～100） | 選項 > 環境變數 |

> 開關類設定（`enableEvaluate`、`enableSystem`、`auditLog`）只接受布林、`0`／`1`，或 `1/true/yes/on`、`0/false/no/off` 字串；其他型別或值（如 `2`、`[]`、`"maybe"`）**拒絕啟動**，不會被默默當成預設值。選項為 `undefined`／`null`／空白字串時視為「未給」，改看環境變數、再看預設。`auditLogFile` 給非字串同樣拒絕啟動。
| 跨站 Origin 白名單 | `allowedOrigins`（陣列或逗號字串） | `SCREENCTL_ALLOWED_ORIGINS` | 空（全拒） | 選項 > 環境變數 |
| 額外 Host 名稱 | `allowedHosts`（陣列或逗號字串） | `SCREENCTL_ALLOWED_HOSTS` | 空 | 選項 > 環境變數 |

### 安全預設

| 面向 | 預設行為 |
|---|---|
| 監聽 | 只綁 `127.0.0.1`。綁其他位址（`0.0.0.0`、區網 IP…）而**沒有 token** → 拒絕啟動並印出原因；有 token 仍會印出警告（token 以明文走 HTTP） |
| 認證 | 除 `GET /health` 外一律 `Authorization: Bearer <token>`，以定時比較（`crypto.timingSafeEqual`）驗證；缺、錯皆 `401`。**沒有任何值或旗標可停用驗證**（`token: false`、空字串都視為「未給」） |
| 跨站 | 不輸出任何 CORS 標頭；請求帶 `Origin`（瀏覽器跨站請求與預檢）預設 `403`；`Host` 標頭須為 `localhost`／`127.0.0.1`／`[::1]`（擋 DNS rebinding），否則 `403`。`/health` 亦受這兩項檢查。標頭解析從嚴：重複的 `Host`／`Authorization` 標頭、以 NBSP 等非 HTTP 空白包夾的值一律拒絕 |
| 高權限端點 | `POST /chrome/evaluate`（任意 JS）預設 `403 EVALUATE_DISABLED`，須顯式開啟。系統級 `/keyboard/*`、`/mouse/*`、`/screenshot` 為本套件主要用途，預設開啟，但受 token 保護；只需操控 Chrome 時可用 `enableSystem: false`／`--no-system` 整批關閉（`403 SYSTEM_DISABLED`） |
| 操作紀錄 | 預設開啟：每次控制動作與每次被拒絕之請求各記一行（時間、端點、來源 IP、狀態碼、耗時、不含機敏內容之參數摘要）；token、輸入文字、script 全文一律不記，詳見[操作紀錄](#操作紀錄audit-log) |
| log | 不印 token 全文，只印來源與 token 檔路徑；啟動時印出目前啟用之能力 |

**為什麼只綁本機仍要 token**：不設認證時，使用者瀏覽的任何網頁都能對 `http://127.0.0.1:7000` 送請求（跨站偽造），DNS rebinding 亦可繞過同源限制；token 是唯一不靠瀏覽器行為的防線，`Host`／`Origin` 檢查則是縱深防禦。

**token 格式與取得**

- 16～256 個可印字元（ASCII `!`～`~`，不含空白）；不合規格拒絕啟動（不回顯 token）。自動產生者為 43 字元之隨機字串（256 bit）。
- 未給時**每次啟動重新產生**（舊 token 作廢），寫入 `tokenFile`（預設 `~/.w-screenctl/token-<port>`；綁定位址不是預設的 `127.0.0.1` 時為 `token-<位址>-<port>`，同 port 不同位址之實例不會共用同一檔）。檔案在 server 成功綁定 port 後才寫，故第二個實例因 port 衝突而失敗時不會覆寫執行中實例之 token。寫入一律先寫同目錄暫存檔再一次到位（失敗時舊檔原封不動）；你以 `tokenFile` 明指、而啟動期間被另一個程序先建立時，會拒絕啟動而不覆寫（請讓每個實例用自己的檔案）。
- `allowedOrigins` 會正規化成瀏覽器送出之 Origin 表示法（小寫、去預設 port：`https://x:443` 即 `https://x`、去前導零、IPv4 簡寫展開），允許一個尾斜線（`https://x/`）；含路徑、多個尾斜線、無效 IPv6、超界 port、非字串元素一律拒絕啟動。請求之 `Origin` 與正規化後之白名單逐字比對。
- 權限：POSIX 目錄 `0700`、檔案 `0600`；Windows 之 mode 位元無作用，權限取決於所在資料夾之 ACL（使用者家目錄預設僅本人與系統管理者可讀）。若改用共用資料夾請自行收緊 ACL。
- 要固定 token（例如 service）：預先建立 token 檔（`openssl rand -base64 32 > ~/.config/screenctl/token && chmod 600 ~/.config/screenctl/token`），以 `SCREENCTL_TOKEN_FILE`／`--token-file` 指向它。檔案須存為 UTF-8／ASCII（PowerShell 5.1 之 `>` 會寫出 UTF-16，請用 `Set-Content -Encoding ascii`）。
- 輪替：改檔案內容（或刪檔）後重啟。

**驗證失敗之回應**（皆為 `{ ok:false, error, code, retry:'never' }`）：

| HTTP | `code` | 觸發 |
|---|---|---|
| 401 | `UNAUTHORIZED` | 缺 `Authorization`、方案不是 Bearer、token 錯（附 `WWW-Authenticate: Bearer`） |
| 403 | `FORBIDDEN_HOST` | `Host` 標頭不在白名單 |
| 403 | `FORBIDDEN_ORIGIN` | 請求帶 `Origin` 且不在 `allowedOrigins` |
| 403 | `EVALUATE_DISABLED` | 呼叫 `/chrome/evaluate` 但未開啟（需先通過 token 驗證） |
| 403 | `SYSTEM_DISABLED` | 呼叫系統級端點（`/screenshot`、`/mouse/*`、`/keyboard/*`）但已以 `enableSystem: false` 關閉（需先通過 token 驗證） |

**綁非迴路位址（不建議）**：token 以明文走 HTTP，且 `Host` 不檢查（除非設 `allowedHosts`）。請改用 SSH 通道或 TLS 反向代理，並以防火牆限制來源。能呼叫者等同取得主機之鍵鼠與 Chrome 控制權（含 `file://` 讀取與有頭 Chrome 之任意操作），請視 token 為主機密碼。

### 操作紀錄（audit log）

預設開啟。每次經 HTTP 的**控制動作**（系統級 `/screenshot`、`/mouse/*`、`/keyboard/*`，與 `/chrome/*` 含 open／navigate／evaluate／screenshot／頁面級滑鼠鍵盤／`GET /chrome`／`DELETE /chrome`）與每次**被拒絕的請求**（401／403：缺或錯 token、`Origin`／`Host` 被擋、evaluate 未開、系統級已關閉）各記一行 JSON（JSONL）。**不記**：公開的 `GET /health` 成功、未註冊路徑的 404、預檢成功。

```jsonl
{"ts":"2026-10-26T06:30:01.123Z","method":"POST","path":"/mouse/click","ip":"127.0.0.1","status":200,"ms":14,"ok":true,"params":{"x":960,"y":540,"button":1}}
{"ts":"2026-10-26T06:30:02.456Z","method":"POST","path":"/keyboard/type","ip":"127.0.0.1","status":200,"ms":22,"ok":true,"params":{"textLen":12}}
{"ts":"2026-10-26T06:30:03.789Z","method":"POST","path":"/chrome/evaluate","ip":"127.0.0.1","status":200,"ms":9,"ok":true,"params":{"scriptLen":14,"scriptSha256":"…64 hex…"}}
{"ts":"2026-10-26T06:30:05.000Z","method":"POST","path":"/chrome/navigate","ip":"127.0.0.1","status":200,"ms":310,"ok":true,"params":{"url":"https://example.com/path"}}
{"ts":"2026-10-26T06:30:09.000Z","method":"GET","path":"/chrome","ip":"192.168.1.8","status":401,"ms":1,"ok":false,"code":"UNAUTHORIZED","denied":"UNAUTHORIZED"}
{"ts":"2026-10-26T06:30:11.000Z","method":"POST","path":"/chrome/open","ip":"127.0.0.1","status":403,"ms":1,"ok":false,"code":"FORBIDDEN_ORIGIN","denied":"FORBIDDEN_ORIGIN","origin":"https://evil.example"}
```

| 欄位 | 說明 |
|---|---|
| `ts` | 請求到達時間（ISO 8601，UTC） |
| `method`／`path` | HTTP 方法與路徑（不含查詢字串；超長截斷 200 字元） |
| `ip` | 連線的來源位址（請求一開始即取下之 socket 位址，客戶端中途斷線仍有；**不採信** `X-Forwarded-For` 等可偽造標頭；IPv4-mapped 位址正規化為 IPv4） |
| `status`／`ms` | HTTP 狀態碼與處理耗時（毫秒）；客戶端中途斷線時動作照常完成並照記（`status` 為伺服器端產生之回應碼） |
| `ok`／`code` | 回應本體的 `ok`（本體沒有 `ok` 者，如 `GET /chrome` 的狀態快照，以 HTTP 狀態推導）與穩定代碼（如 `CHROME_NOT_OPEN`、`VALIDATION`；只收全大寫底線格式）；HTTP 200 而 `ok:false` 代表動作被受理但失敗。不記錯誤訊息全文 |
| `denied` | 僅被閘門拒絕時出現：`UNAUTHORIZED`、`FORBIDDEN_HOST`、`FORBIDDEN_ORIGIN`、`EVALUATE_DISABLED`、`SYSTEM_DISABLED` |
| `origin`／`host` | 僅 `FORBIDDEN_ORIGIN`／`FORBIDDEN_HOST` 時附上，便於追查：只記通過語法檢查之值（`origin` 只留 `scheme://host[:port]`，去除帳密、路徑、查詢字串；`host` 為 `host[:port]`），其餘記 `<invalid>` |
| `params` | 參數摘要（下表）；被拒絕、或驗證失敗（400）的請求不附 |

**參數摘要只含不敏感的欄位**（由白名單複製，不展開 payload）：

| 端點 | `params` |
|---|---|
| `/mouse/click`、`/chrome/mouse/click` | `x`、`y`、`button` |
| `/mouse/dblclick`、`/chrome/mouse/dblclick` | `x`、`y` |
| `/mouse/drag`、`/chrome/mouse/drag` | `fromX`、`fromY`、`toX`、`toY`、`button` |
| `/mouse/scroll`、`/chrome/mouse/scroll` | `x`、`y`、`direction`、`amount` |
| `/keyboard/key`、`/chrome/keyboard/key` | `keys`：已知的具名鍵與快捷鍵（`Enter`、`F5`、`ctrl+a`）原樣記；**單一可印字元**（以字素計，單一 emoji 也算一個；Playwright 的 `KeyA`／`Digit5`、xdotool 的 `minus` 亦同；可能是逐鍵輸入的密碼）只記 `<char>`（`shift+7` → `shift+<char>`）；**不是已知鍵名**的其他字串只記 `<key>` |
| `/keyboard/type`、`/chrome/keyboard/type` | **只記 `textLen`（字元數）**，絕不記文字 |
| `/chrome/evaluate` | **只記 `scriptLen` 與 `scriptSha256`**（UTF-8 的 SHA-256），不記 script |
| `/chrome/open` | `url`（去除查詢字串、片段、帳密）、`mode`、`window`、`viewport`、`userData`（只記 `true`＝有指定自訂 profile，不記路徑）、`opt`（`headless`、`disableGpu`、`disableSandbox`、`deviceScaleFactor`） |
| `/chrome/navigate` | `url`（同上） |
| `/screenshot` | `region`（若有） |
| 其餘（`GET /chrome`、`DELETE /chrome`、`/chrome/screenshot`） | 無 |

**一律不記**：token 與 `Authorization` 標頭、請求本體、輸入文字、script 全文、網址的查詢字串／片段／帳密（任何協定，含 `about://user:pw@…`）、`userData` 路徑、回應內容（例如截圖）。新增路由而未登錄摘要時，預設不記任何參數。

**額外的防線**：寫檔前會自整行清除「目前的 token 全文」（含 JSON 跳脫形式，記為 `<redacted>`），不論它經由哪個載體進到紀錄項（例如被誤放進路徑）。已註冊路由記路由樣板；**未註冊路徑**的路徑文字是呼叫端可控字串，超過 24 字元的片段記為 `<long>`，整體截斷 200 字元。

**位置、權限、大小**

- 預設 `~/.w-screenctl/audit-<port>.jsonl`（與 token 檔同目錄；綁定位址不是預設的 `127.0.0.1` 時為 `audit-<位址>-<port>.jsonl`）；以 `auditLogFile`／`SCREENCTL_AUDIT_LOG_FILE`／`--audit-log-file` 改位置。檔案於首次寫入時才建立；POSIX 檔案 `0600`、新建目錄 `0700`；Windows 依資料夾 ACL（使用者家目錄預設僅本人與系統管理者可讀）。
- 單檔上限預設 5 MiB（`auditLogMaxBytes`），超過即輪替：`audit-7000.jsonl` → `audit-7000.jsonl.1` → … → `audit-7000.jsonl.5`，最舊者刪除；預設保留 5 份（`auditLogKeep`，0 表示不留舊檔）。總量上限約 `(keep + 1) × maxBytes`（預設約 30 MiB）。一行不會被拆到兩個檔；單筆即超過上限者仍完整寫入。每次寫入前都重新取得實際檔案大小（重啟、外部截斷、部分寫入失敗都不會讓上限失準）。輪替時先把目前檔改名（此步失敗，例如檔案被其他程式占用，其餘備份原封不動，之後可重試），中途失敗會還原目前檔。調降 `auditLogKeep` 後，超出的舊輪替檔於首次寫入時刪除；調降 `auditLogMaxBytes` 後，既有較大的舊檔不會被截斷（避免毀損稽核資料），隨輪替自然汰換。POSIX 下既有的紀錄檔若權限寬於 `0600`，首次寫入後會收緊為 `0600`（既有目錄的權限不改）。
- 同步寫入（一筆一行，並行請求不會交錯）。**一個紀錄檔請只給一個實例寫入**（預設檔名含 port 即為此）。

**寫檔失敗不影響請求**：紀錄檔無法寫入（磁碟滿、路徑不可寫、輪替被拒…）時，控制動作與回應照常，console 只警告一次（`[audit] cannot write audit log …`），寫入恢復成功後才會再次警告；輪替失敗時為維持檔案大小有界，會丟棄新紀錄。寫入只成功一半（例如磁碟剛好滿）而留下殘行時，下一筆前會先換行，殘行不會黏到下一筆（下一筆仍可獨立解析）。

**關閉**：`auditLog: false`／`SCREENCTL_AUDIT_LOG=0`／`--no-audit-log`；關閉時啟動輸出會印警告。只想限縮能力而非關紀錄，用 `enableSystem: false`／`--no-system`。

**隱私與使用提醒**：紀錄檔含端點、來源 IP、座標、不含查詢字串的網址等操作軌跡，屬使用者本機資料；請勿納入版控或對外分享。它是營運稽核用的紀錄，**不是防竄改紀錄**（能寫該目錄者可改檔）。查看：`tail -f ~/.w-screenctl/audit-7000.jsonl`；PowerShell：`Get-Content "$HOME\.w-screenctl\audit-7000.jsonl" -Wait -Tail 20`；只看被拒絕的：`grep '"denied"' ~/.w-screenctl/audit-7000.jsonl`。

### 通用約定

- Base URL：`http://127.0.0.1:{port}`，預設 `http://127.0.0.1:7000`（請用 `127.0.0.1`；部分用戶端會先解析 `localhost` 為 `::1` 而連不上）
- 除 `GET /health` 外，所有請求須帶 `Authorization: Bearer <token>`（以下範例以 `$AUTH` 代表此標頭）
- 所有 POST 用 `Content-Type: application/json`
- 回應一律 JSON
- 截圖一律 base64 PNG
- 座標皆以左上角為原點
- CORS 預設關閉（見[安全預設](#安全預設)）
- payload 上限 10 MB

```bash
HOST=http://127.0.0.1:7000
AUTH="Authorization: Bearer $(cat ~/.w-screenctl/token-7000)"
```

### 響應契約

**成功**：
```json
{ "ok": true, ...payload }
```

**失敗**（內部錯誤、超時、chrome 狀態不對、Joi 驗證錯）：
```json
{ "ok": false, "error": "<message>", "code": "<stable_code>", "retry": "<hint>" }
```

`retry` 對照：
| `retry` | 意義 |
|---|---|
| `never` | 環境問題或永久性錯誤，重試也沒用 |
| `after_1s` | 超時類錯誤，1 秒後可重試 |
| `after_recovery` | chrome 處於 `closed` 狀態（含異常死亡），需先 `POST /chrome/open` 恢復 |

`code` 是穩定的程式判斷 key（caller 寫分支用，比 message 字串穩）：
| `code` | 觸發情境 |
|---|---|
| `UNAUTHORIZED` | 缺 / 錯 Bearer token（HTTP 401） |
| `FORBIDDEN_HOST` | `Host` 標頭不在白名單，疑似 DNS rebinding（HTTP 403） |
| `FORBIDDEN_ORIGIN` | 請求帶 `Origin` 且不在 `allowedOrigins`，即跨站請求（HTTP 403） |
| `EVALUATE_DISABLED` | `/chrome/evaluate` 未開啟（HTTP 403） |
| `SYSTEM_DISABLED` | 系統級端點已關閉（HTTP 403） |
| `VALIDATION` | Joi schema 拒絕 payload（HTTP 400） |
| `CHROME_NOT_OPEN` | chrome 不是 open（含 caller 操作期間 chromium 死亡） |
| `TIMEOUT` | 任何 timeout 字樣（launch / goto / evaluate / close） |
| `UNKNOWN` | 都不命中 → fallback never |

**Joi 驗證錯誤**（payload 型別 / 欄位 / 範圍錯）→ HTTP 400 + 統一格式：
```json
{ "ok": false, "error": "\"x\" must be a number", "code": "VALIDATION", "retry": "never" }
```

caller 可寫一個 generic retry helper：看 HTTP status、ok、code、retry，四層判斷下一步動作。

### 零信任設計

caller 可任意 retry / 中斷 / agent swap，server 維持自洽：
- **狀態只有兩態**：`open` / `closed`，由 Playwright `context.isClosed()` 即時衍生，不維護自製 state machine。caller 看到的就是當下事實
- `GET /chrome` 永遠回真實當前 state；`closed` 含 `lastError`（chromium 異常死亡時記下原因）
- `POST /chrome/open` 不指定 `mode` 時是 **idempotent**：已開回 `reused: true`；caller 給不同 `url` 自動 navigate 一次；`closed` 則直接 launch
- 所有 lifecycle 操作（open / close / shutdown）走 serial queue 序列化，並發 `/chrome/open` + `DELETE /chrome` 不會 race；timeout 路徑會等底層資源真釋放（最多 30s grace）才放鎖，避免下一筆 retry 撞 `SingletonLock`
- 失敗響應的 `code` / `retry` 欄位讓 caller 寫穩定分支（不依賴 message 字串）
- shutdown 走「先 close chrome → 再 stop server」順序，避免新 chromium 變孤兒；60s 硬上限後 `process.exit(1)` 由 OS 回收

### 跨平台

| 路由群組 | Linux | Windows |
|---|---|---|
| `/screenshot`, `/mouse/*`, `/keyboard/*`（系統級） | xdotool + ImageMagick | w-mousekey + AHK |
| `/chrome/*`（含頁面級 mouse/keyboard） | Playwright | Playwright |
| `/health` 記憶體 | `free -b` + `ps aux` | `os.totalmem/freemem` + `tasklist` |

### 兩層控制：系統級 vs 瀏覽器頁面級

同時暴露兩套滑鼠 / 鍵盤路由，**不衝突**：

| 路徑 | 影響範圍 | 座標系統 | 鍵盤語法 |
|---|---|---|---|
| `/mouse/*`、`/keyboard/*` | **整個桌面**（會打斷其他程式） | 螢幕像素 | xdotool 風格（`Return`、`ctrl+v`） |
| `/chrome/mouse/*`、`/chrome/keyboard/*` | **僅當前 Chrome 頁面** | viewport CSS 像素 | Playwright 風格（`Enter`、`Control+V`） |

選擇原則：
- 操作 Chrome 內元素 → 用 `/chrome/*`，免擔心視窗位置 / 遮擋
- 操作其他 app（vscode、terminal、檔案總管）→ 用系統級

---

### 1. 健康檢查

| 方法 | 路徑 |
|---|---|
| `GET` | `/health` |

> **唯一免 token 之端點**（`GET`，`HEAD` 隨之；仍受 `Host`／`Origin` 檢查）。

```bash
curl $HOST/health
```

回應：
```json
{
  "status": "ok",
  "platform": "win32",
  "chrome": "open",
  "uptime": 123.45,
  "memory": {
    "total": "15.8GB",
    "used": "10.4GB",
    "available": "5.4GB",
    "chromeRSS": "1.3GB"
  }
}
```

| 欄位 | 說明 |
|---|---|
| `platform` | Node.js `process.platform`（`win32` / `linux` / `darwin`...） |
| `chrome` | Chrome 狀態：`open` / `closed` |
| `memory.chromeRSS` | 所有 `chrome.exe` / `chrome` 程序的常駐記憶體加總 |

> `memory` 欄位有 30 秒 cache，連續打 /health 不會打爆 ps/tasklist。

---

### 2. Chrome 管理

> 全域單一 Chrome 實例，所有 caller 共享。共用同一份 user data（cookie / 登入狀態保留）。

#### 2.1 開啟 Chrome

| 方法 | 路徑 |
|---|---|
| `POST` | `/chrome/open` |

Body：
```json
{
  "url": "https://example.com",
  "mode": "reuse",
  "window": { "x": 0, "y": 0, "width": 1280, "height": 800 },
  "viewport": { "width": 1280, "height": 800 },
  "userData": "/custom/path/to/profile",
  "opt": { "headless": true, "disableGpu": false, "disableSandbox": false, "deviceScaleFactor": 1 }
}
```

| 欄位 | 必填 | 說明 |
|---|---|---|
| `url` | 否 | 導頁目標；未給則 `about:blank` |
| `mode` | 否 | 無＝已開時回 `reused: true`（idempotent）；`"replace"`＝關掉重開；`"reuse"`＝同 idempotent，明示意圖 |
| `window` | 否 | OS 視窗外框：`{x, y, width, height}`，位置與大小可分開給（x/y 成對、width/height 成對）；**位置與大小都未給**才套 `--start-maximized`。見下方[四個正交旋鈕](#四個正交旋鈕window--viewport--devicescalefactor-各自可選) |
| `viewport` | 否 | 頁面邏輯尺寸 `{width, height}`（CSS 像素）；未給＝WYSIWYG，跟著實際視窗內容區。兩欄位給就都要給 |
| `userData` | 否 | 完整 user data 路徑（覆寫 server 預設）；未給則用 server 的 `fdUserData` |
| `opt.headless` | 否 | 預設 `true`（無實體視窗）；要用系統級滑鼠鍵盤 / 系統截圖操作這個 chrome，或要肉眼看畫面時給 `false` |
| `opt.disableGpu` | 否 | 預設 `false`（使用顯卡加速）；`true` 加 `--disable-gpu` |
| `opt.disableSandbox` | 否 | 預設 `false`（保留砂盒，較安全）；`true` 加 `--no-sandbox` |
| `opt.deviceScaleFactor` | 否 | 像素密度 DPR（正數），加 `--force-device-scale-factor`；未給則跟隨系統螢幕 DPR |

##### 四個正交旋鈕（window / viewport / deviceScaleFactor 各自可選）

Chrome 的「視窗外框」「頁面邏輯尺寸」「像素密度」是三件**獨立**的事，本 API 拆成可各自指定的旋鈕，互不綁定：

| 旋鈕 | 控制什麼 | 對應 chrome / playwright | 不給時 |
|---|---|---|---|
| `window.x` / `window.y` | OS 視窗左上角位置 | `--window-position` | 不指定位置 |
| `window.width` / `window.height` | OS 視窗外框大小（含標題列 / 邊框） | `--window-size` | 不指定大小 |
| `viewport` | 頁面邏輯尺寸（CSS 像素，`getBoundingClientRect` 的座標系） | context `viewport` | `null` → WYSIWYG，跟著實際視窗內容區 |
| `opt.deviceScaleFactor` | 像素密度 DPR | `--force-device-scale-factor` | 跟隨系統螢幕 DPR |

- **`window` 位置與大小可分開給**：只給 `{x,y}`（只挪位置）、只給 `{width,height}`（只改大小）、兩者都給、或都不給（→ `--start-maximized`）。x/y 必須成對、width/height 必須成對（Joi `.and`）。
- **預設不給 `viewport`（WYSIWYG）**：頁面邏輯尺寸 = 實際視窗內容區，截圖所見即視窗所見——這是控制座標的基礎，多數情況維持預設即可。只有需要「不論視窗多大都用固定邏輯尺寸渲染」時才明確給 `viewport`。
- **headless（預設 `opt.headless: true`）沒有實體視窗**：`/chrome/*` 路由（截圖、導頁、evaluate、chrome 級滑鼠鍵盤）照常運作；但 `/system/*` 系統級滑鼠鍵盤與系統截圖抓不到它，`window.x` / `window.y` 的視窗定位也失去意義。要走系統級操作或肉眼盯畫面時，送 `opt.headless: false`。
- **`deviceScaleFactor` 與 `viewport` 的搭配**：搭配明確 `viewport` 時，截圖輸出像素 = `viewport × deviceScaleFactor`（context DPR 才會被套上）；只給 `deviceScaleFactor`（viewport 維持 WYSIWYG）只改 Chrome 端渲染 DPR，不強制 context 尺寸。

> ⚠ 混合 DPI 多螢幕環境（各螢幕縮放比不同）下，`--force-device-scale-factor` 可能扭曲 `--window-position` 的落點、或讓視窗跨螢幕跳變。需要精準定位時優先在單一螢幕內操作，或先不給 `deviceScaleFactor` 驗證位置正確再加。

回應：
```json
{ "ok": true, "state": "open", "url": "https://example.com", "reused": false, "gotoOk": true, "gotoError": null }
```

| 欄位 | 說明 |
|---|---|
| `ok` | 成功必為 `true`；lifecycle 失敗（launch crash、timeout）才為 `false` |
| `state` | 操作完之後 chrome 的狀態（成功必為 `open`） |
| `reused` | `true` 代表已有現存 chrome 被沿用（無 mode 或 mode=reuse 都可能） |
| `gotoOk` | 導頁是否成功（state-first 設計：失敗也算 Chrome 已開） |
| `gotoError` | gotoOk=false 時的錯誤訊息 |

> 採 `waitUntil: 'commit'` + 15s timeout；只等 Chrome 接受導頁就返回，避免 PDF / 串流頁卡死。

```bash
# 預設 headless 開啟（無實體視窗，滿版邏輯尺寸）
curl -H "$AUTH" -X POST $HOST/chrome/open \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com"}'

# 有頭開啟（要用系統級滑鼠鍵盤 / 系統截圖，或要肉眼看畫面）
curl -H "$AUTH" -X POST $HOST/chrome/open \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com", "opt": {"headless": false}}'

# 已開就沿用
curl -H "$AUTH" -X POST $HOST/chrome/open \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com", "mode": "reuse"}'

# 關閉舊的再重開
curl -H "$AUTH" -X POST $HOST/chrome/open \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com", "mode": "replace"}'

# 自訂 user data 與視窗
curl -H "$AUTH" -X POST $HOST/chrome/open \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","userData":"/tmp/chrome-test","window":{"x":0,"y":0,"width":470,"height":900}}'

# 固定頁面邏輯尺寸（viewport）＋ DPR：截圖輸出 = 800×600 × 2 = 1600×1200 px
curl -H "$AUTH" -X POST $HOST/chrome/open \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","viewport":{"width":800,"height":600},"opt":{"deviceScaleFactor":2}}'
```

#### 2.2 查詢 Chrome 狀態

| 方法 | 路徑 |
|---|---|
| `GET` | `/chrome` |

```bash
curl -H "$AUTH" $HOST/chrome
```

回應永遠回 `state` 欄位，state 為 `open` 或 `closed`：

```json
// state === 'open'
{ "state": "open", "url": "https://example.com", "createdAt": "2026-04-19T..." }

// state === 'closed'（含一般關閉與 chromium 異常死亡）
{ "state": "closed" }

// state === 'closed' 且有殘留錯誤訊息（chromium 上次異常結束）
{ "state": "closed", "lastError": "context closed unexpectedly" }
```

caller 可從 state 判斷下一步：
- `closed` → 打 `/chrome/open` 啟動
- `open` → 直接用 `/chrome/screenshot` 等業務操作

#### 2.3 關閉 Chrome

| 方法 | 路徑 |
|---|---|
| `DELETE` | `/chrome` |

回應：
```json
{ "ok": true, "closed": true }
```

`closed: false` 代表本來就沒開（會附 `reason: "closed"`）。

#### 2.4 網頁截圖（僅 viewport）

| 方法 | 路徑 |
|---|---|
| `POST` | `/chrome/screenshot` |

回應：
```json
{ "ok": true, "image": "iVBOR...(base64)...", "format": "png" }
```

> 只截 viewport 內容；要截整個桌面（含 Chrome 框、taskbar）用 [3.1 系統截圖](#31-系統截圖)。

#### 2.5 導頁

| 方法 | 路徑 |
|---|---|
| `POST` | `/chrome/navigate` |

Body：
```json
{ "url": "https://example.com" }
```

回應（成功）：
```json
{ "ok": true, "url": "https://example.com" }
```

回應（goto 失敗，例如 DNS 錯、網路錯、target closed）：
```json
{ "ok": false, "error": "page.goto: net::ERR_NAME_NOT_RESOLVED ...", "code": "UNKNOWN", "retry": "never" }
```
（含 `timeout` 字樣 → `code: "TIMEOUT", retry: "after_1s"`；含 `Target closed` 字樣 → `code: "CHROME_NOT_OPEN", retry: "after_recovery"`）

> `url`（成功時）是實際載入的 URL（從 `page.url()` 取，反映 redirect 後最終位址）。
> 與 `/chrome/open` 不同：navigate 失敗時直接走統一 `{ ok: false, error, code, retry }` 格式（不再回 `gotoOk: false` 的半成功）。`/chrome/open` 仍保留 `gotoOk` 因為 lifecycle 與 navigate 是兩件事（chrome 已開即視為 lifecycle 成功）。
> 採 `waitUntil: 'commit'` + 15s timeout。

#### 2.6 執行 JavaScript

| 方法 | 路徑 |
|---|---|
| `POST` | `/chrome/evaluate` |

> ⚠ **預設關閉**：未開啟時回 `403 { "ok": false, "code": "EVALUATE_DISABLED", ... }`（需先通過 token 驗證，且先於 payload 驗證）。此端點可在受控頁面執行任意 JS，請僅於需要時開啟：`node g.mjs --evaluate`、環境變數 `SCREENCTL_ENABLE_EVALUATE=1`，或程式內 `WScreenctl({ enableEvaluate: true })`。啟動時會印出警告。

Body：
```json
{ "script": "document.title" }
```

回應（成功）：
```json
{ "ok": true, "result": "Example Domain" }
```

回應（失敗 / 5s timeout）：
```json
{ "ok": false, "error": "evaluate timeout 5s", "code": "TIMEOUT", "retry": "after_1s" }
```

| 欄位 | 說明 |
|---|---|
| `ok` | script 是否成功執行（語法 / runtime / timeout 任一失敗為 `false`） |
| `result` | 成功時為 script 回傳值（`ok: false` 時無此欄位） |
| `error` / `code` / `retry` | 失敗時的統一錯誤格式（見[響應契約](#響應契約)） |

> 5 秒 timeout：含無限迴圈、永不 resolve 的 Promise 等情境會被中斷，回 `{ ok: false, error: "evaluate timeout 5s" }`。
> ⚠ timeout 只是讓 HTTP request 結束，**頁面內 JS 仍可能在 chromium 中繼續跑**。若 caller 的 script 進入無限迴圈，建議用 `mode: 'replace'` 重啟 chrome。

⚠️ **`script` 是 expression，不是 statement**（Playwright `page.evaluate` 語意）：

- ❌ `"const x = 1; x"`
- ✅ `"1 + 1"`
- ✅ 回傳物件外加括號：`"({url: location.href, title: document.title})"`
- ✅ 多行寫 IIFE：`"(() => { const a = 1; const b = 2; return a + b })()"`

---

### 3. 系統級控制

> 影響整個桌面，會與其他程式互動。座標基於整個螢幕的左上角。
>
> 本節 7 條端點（`/screenshot`、`/mouse/*`、`/keyboard/*`）可整批關閉：`enableSystem: false`／`SCREENCTL_ENABLE_SYSTEM=0`／`node g.mjs --no-system`，關閉後回 `403 { "ok": false, "code": "SYSTEM_DISABLED" }`（須先通過 token 驗證）並記入[操作紀錄](#操作紀錄audit-log)；`/chrome/*`（含頁面級滑鼠鍵盤）不受影響。每次呼叫（含被拒絕者）都會留下操作紀錄，`/keyboard/type` 只記文字長度。

#### 3.1 系統截圖

| 方法 | 路徑 |
|---|---|
| `POST` | `/screenshot` |

Body（皆選填）：
```json
{ "region": { "x": 100, "y": 100, "width": 800, "height": 600 } }
```

不傳 `region` 則截整個桌面。

```bash
# 全螢幕
curl -H "$AUTH" -X POST $HOST/screenshot \
  -H 'Content-Type: application/json' -d '{}'

# 區域
curl -H "$AUTH" -X POST $HOST/screenshot \
  -H 'Content-Type: application/json' \
  -d '{"region":{"x":100,"y":100,"width":800,"height":600}}'
```

#### 3.2 滑鼠

`button` 欄位：`1`=左鍵（預設）、`2`=中鍵、`3`=右鍵。

| 方法 | 路徑 | Body |
|---|---|---|
| `POST` | `/mouse/click` | `{ x, y, button? }` |
| `POST` | `/mouse/dblclick` | `{ x, y }` |
| `POST` | `/mouse/drag` | `{ fromX, fromY, toX, toY, button? }` |
| `POST` | `/mouse/scroll` | `{ x, y, direction, amount? }` |

`/mouse/scroll` 的 `direction`：`"up"` / `"down"`，`amount` 預設 3。

```bash
# 左鍵點 (960, 540)
curl -H "$AUTH" -X POST $HOST/mouse/click \
  -H 'Content-Type: application/json' -d '{"x":960,"y":540}'

# 右鍵點
curl -H "$AUTH" -X POST $HOST/mouse/click \
  -H 'Content-Type: application/json' -d '{"x":960,"y":540,"button":3}'

# 雙擊
curl -H "$AUTH" -X POST $HOST/mouse/dblclick \
  -H 'Content-Type: application/json' -d '{"x":960,"y":540}'

# 拖曳
curl -H "$AUTH" -X POST $HOST/mouse/drag \
  -H 'Content-Type: application/json' \
  -d '{"fromX":100,"fromY":200,"toX":500,"toY":200}'

# 向下滾 5 格
curl -H "$AUTH" -X POST $HOST/mouse/scroll \
  -H 'Content-Type: application/json' \
  -d '{"x":960,"y":540,"direction":"down","amount":5}'
```

#### 3.3 鍵盤

| 方法 | 路徑 | Body |
|---|---|---|
| `POST` | `/keyboard/key` | `{ keys }` |
| `POST` | `/keyboard/type` | `{ text }` |

##### `/keyboard/key` — 特殊鍵 / 組合鍵

採 **xdotool 風格**，組合鍵用 `+` 連接。內建 alias 正規化（`Enter` / `Esc` / `Backspace` / `PageUp` / `Control` / `Win` 等都會自動轉成標準寫法），caller 寫法寬鬆。

```bash
# 單鍵
curl -H "$AUTH" -X POST $HOST/keyboard/key \
  -H 'Content-Type: application/json' -d '{"keys":"Return"}'

# Ctrl+A
curl -H "$AUTH" -X POST $HOST/keyboard/key \
  -H 'Content-Type: application/json' -d '{"keys":"ctrl+a"}'

# Alt+F4
curl -H "$AUTH" -X POST $HOST/keyboard/key \
  -H 'Content-Type: application/json' -d '{"keys":"alt+F4"}'

# Win+R（執行對話框）
curl -H "$AUTH" -X POST $HOST/keyboard/key \
  -H 'Content-Type: application/json' -d '{"keys":"super+r"}'
```

常用按鍵與接受的 alias：

| 鍵位 | 標準寫法 | 也接受 |
|---|---|---|
| Enter | `Return` | `Enter`、`enter` |
| Esc | `Escape` | `Esc`、`esc` |
| Tab | `Tab` | — |
| 空白 | `space` | `Space`、`SPACE` |
| 退格 | `BackSpace` | `Backspace`、`backspace` |
| 刪除 | `Delete` | `Del`、`del` |
| 方向鍵 | `Up` / `Down` / `Left` / `Right` | — |
| 翻頁 | `Page_Up` / `Page_Down` | `PageUp`、`PageDown`、`pgup`、`pgdn` |
| F1-F24 | `F1` ~ `F24` | `f1` ~ `f24` |
| Ctrl | `ctrl` | `Control`、`Control_L`、`Control_R` |
| Shift | `shift` | `Shift`、`Shift_L` |
| Alt | `alt` | `Alt`、`Alt_L` |
| Win / Cmd | `super` | `Super`、`Meta`、`Win` |

##### `/keyboard/type` — 輸入文字

ASCII 與非 ASCII（中文 / emoji）皆可。Linux 用 `xdotool type` + `xdotool key U<codepoint>`；Windows 用 AHK `SendText`。**不使用剪貼簿**。

```bash
# 英文
curl -H "$AUTH" -X POST $HOST/keyboard/type \
  -H 'Content-Type: application/json' -d '{"text":"hello world"}'

# 中文
curl -H "$AUTH" -X POST $HOST/keyboard/type \
  -H 'Content-Type: application/json' -d '{"text":"你好世界"}'
```

---

### 4. Chrome 頁面級控制

> 透過 Playwright 注入頁面，**只影響當前 Chrome 頁面**，不會影響桌面其他 app。座標為 viewport CSS 像素（左上角為原點）。

#### 4.1 頁面截圖

見 [2.4](#24-網頁截圖僅-viewport)（僅 viewport）。

#### 4.2 滑鼠

`button` 欄位：`1`=左鍵（預設）、`2`=中鍵、`3`=右鍵。

| 方法 | 路徑 | Body |
|---|---|---|
| `POST` | `/chrome/mouse/click` | `{ x, y, button? }` |
| `POST` | `/chrome/mouse/dblclick` | `{ x, y }` |
| `POST` | `/chrome/mouse/drag` | `{ fromX, fromY, toX, toY, button? }` |
| `POST` | `/chrome/mouse/scroll` | `{ x, y, direction, amount? }` |

`/chrome/mouse/scroll` 的 `direction`：`"up"` / `"down"` / `"left"` / `"right"`，`amount` 預設 3。內部以 `step=100` 像素轉成 dx/dy 餵 `page.mouse.wheel()`。

```bash
# 點頁面 (560, 496)
curl -H "$AUTH" -X POST $HOST/chrome/mouse/click \
  -H 'Content-Type: application/json' -d '{"x":560,"y":496}'
```

#### 4.3 鍵盤

採 **Playwright 鍵語法**（與系統級不同！）：

```bash
# 單鍵
curl -H "$AUTH" -X POST $HOST/chrome/keyboard/key \
  -H 'Content-Type: application/json' -d '{"keys":"Enter"}'

# Ctrl+A（注意大寫的 Control，與系統級的 ctrl 不同）
curl -H "$AUTH" -X POST $HOST/chrome/keyboard/key \
  -H 'Content-Type: application/json' -d '{"keys":"Control+A"}'

# 輸入文字
curl -H "$AUTH" -X POST $HOST/chrome/keyboard/type \
  -H 'Content-Type: application/json' -d '{"text":"Hello 世界"}'
```

| 鍵位 | Playwright 名稱 |
|---|---|
| Enter / Tab / Escape | `Enter` / `Tab` / `Escape` |
| 退格 / 刪除 / 空白 | `Backspace` / `Delete` / `Space` |
| 方向鍵 | `ArrowUp` / `ArrowDown` / `ArrowLeft` / `ArrowRight` |
| 功能鍵 | `F1` ~ `F12` |
| Modifier | `Control` / `Shift` / `Alt` / `Meta` |

> `/chrome/keyboard/type` 走 `insertText`，**不觸發物理 keydown/keyup**。靠 keydown 偵測的頁面（如全域 hotkey）改用 `/chrome/keyboard/key` 逐鍵 press。

---

### 典型流程範例

#### 開頁面 → 截圖 → 點按鈕 → 輸入

```bash
HOST=http://127.0.0.1:7000
AUTH="Authorization: Bearer $(cat ~/.w-screenctl/token-7000)"

# 1. 開 Chrome
curl -H "$AUTH" -X POST $HOST/chrome/open \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","mode":"reuse"}'

# 2. 用 evaluate 查欄位實際座標（別目測截圖；須以 --evaluate 啟動）
curl -H "$AUTH" -X POST $HOST/chrome/evaluate \
  -H 'Content-Type: application/json' \
  -d '{"script":"Array.from(document.querySelectorAll(\"input\")).map(i=>{const r=i.getBoundingClientRect();return {type:i.type,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})"}'

# 3. 頁面內點欄位 + 輸入
curl -H "$AUTH" -X POST $HOST/chrome/mouse/click \
  -H 'Content-Type: application/json' -d '{"x":560,"y":496}'
curl -H "$AUTH" -X POST $HOST/chrome/keyboard/type \
  -H 'Content-Type: application/json' -d '{"text":"admin"}'

# 4. 頁面截圖確認
curl -H "$AUTH" -X POST $HOST/chrome/screenshot
```

#### 切換到其他 app（系統級操作）

```bash
HOST=http://127.0.0.1:7000
AUTH="Authorization: Bearer $(cat ~/.w-screenctl/token-7000)"

# 1. 系統級 Win+R（叫出執行對話框）
curl -H "$AUTH" -X POST $HOST/keyboard/key \
  -H 'Content-Type: application/json' -d '{"keys":"super+r"}'

# 2. 系統級輸入
curl -H "$AUTH" -X POST $HOST/keyboard/type \
  -H 'Content-Type: application/json' -d '{"text":"notepad"}'

# 3. Enter
curl -H "$AUTH" -X POST $HOST/keyboard/key \
  -H 'Content-Type: application/json' -d '{"keys":"Return"}'

# 4. 全螢幕截圖
curl -H "$AUTH" -X POST $HOST/screenshot \
  -H 'Content-Type: application/json' -d '{}'
```

---

### 實務上的坑 / 最佳實踐

1. **不要靠截圖猜頁面元素座標**
   截圖像素與 CSS 像素不一定 1:1（DPR、縮放、zoom）。座標一律用 `/chrome/evaluate` 查 `getBoundingClientRect()` 算中心點。

2. **視窗大小變了 → 舊座標全失效**
   每段新操作前重新查座標。

3. **按鈕 `disabled` / `opacity:0.5` 要先驗**
   SPA 登入鈕常在驗證前 disabled，點了沒反應也不報錯。先 evaluate 確認 `getComputedStyle(el).opacity === "1"` 與 `!el.disabled`。

4. **`evaluate` 的 script 是 expression**
   - ❌ `"return 1"` / `"const x = 1; x"`
   - ✅ `"1 + 1"` / `"({a:1})"` / `"(()=>{...})()"`

5. **頁面導航後等 DOM 穩定**
   `waitUntil: 'commit'` 只等 Chrome 接受導頁，**SPA 動態內容可能還沒渲染**。最穩做法：evaluate 輪詢檢查目標元素存在再操作。

6. **SingletonLock 衝突**
   若 `userData` 指向系統 Chrome profile（如 `~/AppData/Local/Google/Chrome/User Data`），**必須先完全關閉個人 Chrome**，否則 `launchPersistentContext` 會卡住。建議用獨立 profile。

7. **Chrome 已開時重複 `/chrome/open`**
   預設行為即 idempotent reuse（回 `reused: true`，不報錯）；給不同 `url` 會自動 navigate。要強制重開請帶 `mode: "replace"`。

8. **page 卡死自救（runaway script / 惡意網頁）**
   兩種情境會把 page 主執行緒卡住：
   - `/chrome/evaluate` 送出含無限迴圈或重 sync 計算的 script（API 會 hang 5s 後 timeout，但 page 仍卡）
   - `/chrome/navigate` 到含 `<script>while(true){}</script>` 之類的網頁（API 立刻回 `ok:true`，但 page 卡）

   **徵兆**：後續所有 `/chrome/*`（screenshot / mouse / keyboard / evaluate / navigate）都 hang 或 timeout。
   **恢復**：`DELETE /chrome` → 等回 `closed: true` → `POST /chrome/open` 重開。server 不會自動救卡死的 page，由 caller 觀察徵兆後重啟。

9. **輸入前先確定 focus**
   `/chrome/keyboard/type` 送到目前 focus 的元素；沒 focus 會打到空氣。先 click 對欄位中心，或 evaluate 呼叫 `el.focus()`。

10. **清空已有文字**
    click 聚焦 → `Control+A` → `Delete` → type 新值。

11. **系統 vs 頁面鍵盤語法不同**
    系統級用 xdotool 風格（`Return` / `ctrl+v`），頁面級用 Playwright 風格（`Enter` / `Control+V`）。**別混用**。

---

### 限制

- 僅支援**單一 Chrome、單一 page**；不支援多 tab 並行、多 context
- `/chrome/keyboard/type` 不觸發物理 `keydown/keyup`；依賴那些事件的頁面要改走 `/chrome/keyboard/key`
- Linux 系統級需安裝 `xdotool` 與 `imagemagick`
- Windows 系統級依賴 `w-mousekey`（內含 AHK 64-bit）

---

## 自動啟動 / 部署

`service/` 提供兩平台開機自動啟動設定檔，皆執行專案根目錄的 `g.mjs`：

```
service/
├── screenctl-linux.service    Linux systemd unit
└── screenctl-win.xml           Windows 工作排程設定檔
```

### Linux（systemd）

設定檔：[service/screenctl-linux.service](service/screenctl-linux.service)

#### 安裝前要客製的欄位

| 欄位 | 預設值 | 改成 |
|---|---|---|
| `User` | `YOUR_USERNAME` | 執行此服務的 Linux 使用者（用 `whoami` 查） |
| `WorkingDirectory` | `/opt/screenctl` | 專案根目錄絕對路徑（含 `g.mjs`） |
| `ExecStart` | `/usr/bin/node g.mjs` | node 路徑用 `which node` 確認 |
| `Environment=DISPLAY=:99` | 預設保留 | headless 環境刪除；有 X server / VNC 才需要 |
| `After / Requires=vnc.service` | 預設保留 | 沒有 VNC service 就刪掉這兩行 |
| `Environment=SCREENCTL_TOKEN_FILE=…` | `/home/YOUR_USERNAME/.config/screenctl/token` | 把 `YOUR_USERNAME` 改成同一使用者 |

單元已預設**只綁本機**（`SCREENCTL_HOST=127.0.0.1`）且**token 由檔案提供**；`/chrome/evaluate` 預設關閉，需要時取消註解 `Environment=SCREENCTL_ENABLE_EVALUATE=1`。建議先建好 token 檔（固定 token，重啟不變；未建則首次啟動自動產生並寫入，權限 `0600`）：

```bash
sudo -u YOUR_USERNAME install -d -m 700 /home/YOUR_USERNAME/.config/screenctl
openssl rand -base64 32 | sudo -u YOUR_USERNAME tee /home/YOUR_USERNAME/.config/screenctl/token > /dev/null
sudo chmod 600 /home/YOUR_USERNAME/.config/screenctl/token

# 呼叫端取用
TOKEN=$(cat /home/YOUR_USERNAME/.config/screenctl/token)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7000/chrome
```

#### 安裝 / 啟動

```bash
sudo cp service/screenctl-linux.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now screenctl-linux
```

#### 操作

```bash
sudo systemctl status   screenctl-linux
sudo systemctl restart  screenctl-linux
sudo systemctl stop     screenctl-linux
sudo systemctl disable  screenctl-linux       # 取消開機自啟
journalctl -u screenctl-linux -f              # 跟 log
```

#### 移除

```bash
sudo systemctl disable --now screenctl-linux
sudo rm /etc/systemd/system/screenctl-linux.service
sudo systemctl daemon-reload
```

---

### Windows（工作排程）

設定檔：[service/screenctl-win.xml](service/screenctl-win.xml)

#### 為什麼用工作排程而不是 Windows Service

系統級 mouse/keyboard（透過 w-mousekey / AHK）必須跑在**互動式 desktop session**。Windows Service 預設跑在 session 0 沒有 desktop，AHK 送鍵會無效。工作排程可指定「使用者登入時」觸發，自然有 desktop。

#### 安裝前要客製的欄位

| 欄位 | 預設值 | 改成 |
|---|---|---|
| `<Command>` | `C:\Program Files\nodejs\node.exe` | Node.js 執行檔絕對路徑 |
| `<Arguments>` | `g.mjs` | 保留即可（已是預設啟動腳本） |
| `<WorkingDirectory>` | `C:\screenctl` | 專案根目錄絕對路徑 |

要覆寫 `PORT` / `CHROME_USER_DATA` 等環境變數，把 `<Command>` 改成 `cmd.exe`、`<Arguments>` 包成 `/c set PORT=8000 && node g.mjs`。

設定檔已採安全預設，**不需改動即只綁本機並要求 token**：

- `g.mjs` 預設監聽 `127.0.0.1`；每次啟動自動產生 token，寫入執行此工作之使用者的 `%USERPROFILE%\.w-screenctl\token-<port>`（啟動輸出不印 token 全文）。呼叫端取用：`(Get-Content "$HOME\.w-screenctl\token-7000").Trim()`。
- 要固定 token（重啟不變）：`<Arguments>` 改為 `g.mjs --token-file C:\Users\你的使用者\.w-screenctl\token.txt`（檔案存在則讀取，不存在則首次啟動自動產生並寫入；請存為 UTF-8／ASCII，且勿放在 `C:\` 根目錄下之共用資料夾）。XML 註解內不可出現連續兩個減號，故設定檔內以文字說明，旗標寫法以本節為準。
- `/chrome/evaluate` 預設關閉；需要時 `<Arguments>` 加 `--evaluate`。

#### 安裝 / 啟動（管理員 cmd）

```cmd
schtasks /create /tn "screenctl-api" /xml service\screenctl-win.xml
schtasks /run    /tn "screenctl-api"
```

#### 操作

```cmd
schtasks /run    /tn "screenctl-api"     啟動
schtasks /end    /tn "screenctl-api"     停止
schtasks /query  /tn "screenctl-api" /v  看狀態
```

也可在「工作排程器」GUI 中找到 `screenctl-api` 進行管理。

#### 移除

```cmd
schtasks /end    /tn "screenctl-api"
schtasks /delete /tn "screenctl-api" /f
```

#### 觸發行為

- 預設 `<LogonTrigger>`：任一使用者登入即啟動，登入後延遲 5 秒
- 程序異常結束時，每 1 分鐘自動重試，最多 999 次
- 若要綁定特定使用者：在 `<LogonTrigger>` 加 `<UserId>DESKTOP-XXX\username</UserId>`
- 若要改成「開機觸發」（無人登入時）：`<LogonTrigger>` 換成 `<BootTrigger>`，但會失去 desktop（系統級 mouse/keyboard 失效）
