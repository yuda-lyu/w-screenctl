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

## API 控制說明

w-screenctl 啟動後對外提供 REST API，讓外部程式 / AI agent 透過 HTTP 控制：
- **作業系統桌面**：滑鼠、鍵盤、桌面截圖（Linux 走 xdotool / ImageMagick；Windows 走 w-mousekey / AHK）
- **Chrome 瀏覽器**：開關、導頁、頁面截圖、執行 JS、頁面內滑鼠鍵盤事件（透過 Playwright；跨平台）

### 啟動

#### 程式內呼叫

```js
import WScreenctl from 'w-screenctl'

const server = await WScreenctl({ port: 7000 })
// 啟動後印出: running at http://0.0.0.0:7000 (platform=...)
```

#### 命令列直接啟動

專案根目錄附 `g.mjs` 啟動腳本：

```bash
node g.mjs
PORT=8000 node g.mjs    # 改 port
```

開機自動啟動見 [自動啟動 / 部署](#自動啟動--部署)。

| 設定 | 來源 | 說明 |
|---|---|---|
| Port | env `PORT` > `opt.port` > `7000` | 全部失效時用預設 7000 |
| Chrome user data 目錄 | env `CHROME_USER_DATA` > `opt.fdUserData` > 當前工作路徑 `./user_data/` | 首次啟動自動建立 |

### 通用約定

- Base URL：`http://{host}:{port}`，預設 `http://0.0.0.0:7000`
- 所有 POST 用 `Content-Type: application/json`
- 回應一律 JSON
- 截圖一律 base64 PNG
- 座標皆以左上角為原點
- CORS 全開
- payload 上限 10 MB

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

```bash
curl http://localhost:7000/health
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
  "opt": { "disableGpu": false, "disableSandbox": false, "deviceScaleFactor": 1 }
}
```

| 欄位 | 必填 | 說明 |
|---|---|---|
| `url` | 否 | 導頁目標；未給則 `about:blank` |
| `mode` | 否 | 無＝已開時回 `reused: true`（idempotent）；`"replace"`＝關掉重開；`"reuse"`＝同 idempotent，明示意圖 |
| `window` | 否 | OS 視窗外框：`{x, y, width, height}`，位置與大小可分開給（x/y 成對、width/height 成對）；**位置與大小都未給**才套 `--start-maximized`。見下方[四個正交旋鈕](#四個正交旋鈕window--viewport--devicescalefactor-各自可選) |
| `viewport` | 否 | 頁面邏輯尺寸 `{width, height}`（CSS 像素）；未給＝WYSIWYG，跟著實際視窗內容區。兩欄位給就都要給 |
| `userData` | 否 | 完整 user data 路徑（覆寫 server 預設）；未給則用 server 的 `fdUserData` |
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
# 預設滿版開啟
curl -X POST http://localhost:7000/chrome/open \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com"}'

# 已開就沿用
curl -X POST http://localhost:7000/chrome/open \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com", "mode": "reuse"}'

# 關閉舊的再重開
curl -X POST http://localhost:7000/chrome/open \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com", "mode": "replace"}'

# 自訂 user data 與視窗
curl -X POST http://localhost:7000/chrome/open \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","userData":"/tmp/chrome-test","window":{"x":0,"y":0,"width":470,"height":900}}'

# 固定頁面邏輯尺寸（viewport）＋ DPR：截圖輸出 = 800×600 × 2 = 1600×1200 px
curl -X POST http://localhost:7000/chrome/open \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","viewport":{"width":800,"height":600},"opt":{"deviceScaleFactor":2}}'
```

#### 2.2 查詢 Chrome 狀態

| 方法 | 路徑 |
|---|---|
| `GET` | `/chrome` |

```bash
curl http://localhost:7000/chrome
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
curl -X POST http://localhost:7000/screenshot \
  -H 'Content-Type: application/json' -d '{}'

# 區域
curl -X POST http://localhost:7000/screenshot \
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
curl -X POST http://localhost:7000/mouse/click \
  -H 'Content-Type: application/json' -d '{"x":960,"y":540}'

# 右鍵點
curl -X POST http://localhost:7000/mouse/click \
  -H 'Content-Type: application/json' -d '{"x":960,"y":540,"button":3}'

# 雙擊
curl -X POST http://localhost:7000/mouse/dblclick \
  -H 'Content-Type: application/json' -d '{"x":960,"y":540}'

# 拖曳
curl -X POST http://localhost:7000/mouse/drag \
  -H 'Content-Type: application/json' \
  -d '{"fromX":100,"fromY":200,"toX":500,"toY":200}'

# 向下滾 5 格
curl -X POST http://localhost:7000/mouse/scroll \
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
curl -X POST http://localhost:7000/keyboard/key \
  -H 'Content-Type: application/json' -d '{"keys":"Return"}'

# Ctrl+A
curl -X POST http://localhost:7000/keyboard/key \
  -H 'Content-Type: application/json' -d '{"keys":"ctrl+a"}'

# Alt+F4
curl -X POST http://localhost:7000/keyboard/key \
  -H 'Content-Type: application/json' -d '{"keys":"alt+F4"}'

# Win+R（執行對話框）
curl -X POST http://localhost:7000/keyboard/key \
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
curl -X POST http://localhost:7000/keyboard/type \
  -H 'Content-Type: application/json' -d '{"text":"hello world"}'

# 中文
curl -X POST http://localhost:7000/keyboard/type \
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
curl -X POST http://localhost:7000/chrome/mouse/click \
  -H 'Content-Type: application/json' -d '{"x":560,"y":496}'
```

#### 4.3 鍵盤

採 **Playwright 鍵語法**（與系統級不同！）：

```bash
# 單鍵
curl -X POST http://localhost:7000/chrome/keyboard/key \
  -H 'Content-Type: application/json' -d '{"keys":"Enter"}'

# Ctrl+A（注意大寫的 Control，與系統級的 ctrl 不同）
curl -X POST http://localhost:7000/chrome/keyboard/key \
  -H 'Content-Type: application/json' -d '{"keys":"Control+A"}'

# 輸入文字
curl -X POST http://localhost:7000/chrome/keyboard/type \
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
HOST=http://localhost:7000

# 1. 開 Chrome
curl -X POST $HOST/chrome/open \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","mode":"reuse"}'

# 2. 用 evaluate 查欄位實際座標（別目測截圖）
curl -X POST $HOST/chrome/evaluate \
  -H 'Content-Type: application/json' \
  -d '{"script":"Array.from(document.querySelectorAll(\"input\")).map(i=>{const r=i.getBoundingClientRect();return {type:i.type,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})"}'

# 3. 頁面內點欄位 + 輸入
curl -X POST $HOST/chrome/mouse/click \
  -H 'Content-Type: application/json' -d '{"x":560,"y":496}'
curl -X POST $HOST/chrome/keyboard/type \
  -H 'Content-Type: application/json' -d '{"text":"admin"}'

# 4. 頁面截圖確認
curl -X POST $HOST/chrome/screenshot
```

#### 切換到其他 app（系統級操作）

```bash
HOST=http://localhost:7000

# 1. 系統級 Win+R（叫出執行對話框）
curl -X POST $HOST/keyboard/key \
  -H 'Content-Type: application/json' -d '{"keys":"super+r"}'

# 2. 系統級輸入
curl -X POST $HOST/keyboard/type \
  -H 'Content-Type: application/json' -d '{"text":"notepad"}'

# 3. Enter
curl -X POST $HOST/keyboard/key \
  -H 'Content-Type: application/json' -d '{"keys":"Return"}'

# 4. 全螢幕截圖
curl -X POST $HOST/screenshot \
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
