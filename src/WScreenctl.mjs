import Hapi from '@hapi/hapi'
import get from 'lodash-es/get.js'
import ispint from 'wsemi/src/ispint.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import cint from 'wsemi/src/cint.mjs'
import { normalizeKey } from './util/keyAlias.mjs'
import bkLinux from './backend/bkLinux.mjs'
import bkWin from './backend/bkWin.mjs'
import ChromeManager from './chromeManager.mjs'
import { systemRoute, chromeRoute, lifecycleRoute, errResponse } from './routeFactory.mjs'
import * as S from './schemas.mjs'
import { resolveSecurity, createGate, describeSecurity, persistToken } from './security.mjs'


/**
 * 啟動 w-screenctl 服務，對外提供 REST API 控制作業系統桌面（滑鼠、鍵盤、截圖）與 Chrome 瀏覽器
 *
 * 跨平台支援：Linux 走 xdotool / ImageMagick，Windows 走 w-mousekey / AHK；Chrome 控制全平台皆透過 Playwright
 *
 * `/chrome/open` 預設以 headless 啟動；需要實體視窗（系統級滑鼠鍵盤 / 系統截圖操作 chrome 時）
 * 得於 payload 送 `opt.headless: false`
 *
 * 零信任設計：caller 可任意 retry / 中斷 / agent swap，server 維持自洽狀態。所有 chrome lifecycle
 * 透過 ChromeManager 序列化；所有路由經由 routeFactory 統一錯誤處理；所有 payload 經 Joi 驗證。
 *
 * 預設安全（1.0.26 之後的版本起；破壞性變更）：
 * - 只綁 127.0.0.1；綁其他位址須自行提供 token，否則拒絕啟動（丟出 code 為 SCREENCTL_CONFIG 之 Error）
 * - 除 `GET /health` 外所有端點須 `Authorization: Bearer <token>`（定時比較）。token 未給時啟動自動產生並寫入 token 檔
 * - 預設不開 CORS；Host 標頭須為本機名稱（擋 DNS rebinding）；帶 Origin 之請求預設一律拒絕，可由 `allowedOrigins` 放行白名單
 * - `/chrome/evaluate` 預設關閉（403），須 `enableEvaluate` 顯式開啟
 * 新增之安全選項優先序皆為：選項 > 環境變數 > 預設（`port`、`fdUserData` 維持既有之環境變數優先）
 *
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Integer} [opt.port=7000] 服務監聽 port，優先序：env PORT > opt.port > 7000
 * @param {String} [opt.fdUserData] Chrome user data 資料夾路徑，優先序：env CHROME_USER_DATA > opt.fdUserData > 當前工作路徑下的 ./user_data
 * @param {String} [opt.host='127.0.0.1'] 監聽位址，優先序：opt.host > env SCREENCTL_HOST > 127.0.0.1。非迴路位址（如 0.0.0.0）且未提供 token 時拒絕啟動
 * @param {String} [opt.token] Bearer token（16~256 個可印字元、不含空白），優先序：opt.token > env SCREENCTL_TOKEN > token 檔 > 自動產生（僅迴路位址）。無法以任何值停用驗證
 * @param {String} [opt.tokenFile] token 檔路徑，優先序：opt.tokenFile > env SCREENCTL_TOKEN_FILE。檔案存在則讀取其內容為 token；不存在（且為迴路位址）則自動產生並寫入該檔；皆未給時寫入 `<家目錄>/.w-screenctl/token-<port>`（host 非預設時為 `token-<host>-<port>`；每次啟動重新產生並以暫存檔原子取代）。明指之檔只新建、不覆寫（啟動期間被他人先建立即拒絕啟動）。權限：POSIX 為 0600，Windows 依資料夾 ACL
 * @param {Boolean} [opt.enableEvaluate=false] 是否開啟 `POST /chrome/evaluate`（任意 JS 執行），優先序：opt.enableEvaluate > env SCREENCTL_ENABLE_EVALUATE（1/true/yes/on）> 關閉
 * @param {Array<String>|String} [opt.allowedOrigins=[]] 允許跨站呼叫之 Origin 白名單（`scheme://host[:port]`，可為陣列或逗號分隔字串，元素須為字串；不接受 `*`、`null`、含路徑者，並正規化成瀏覽器送出之 Origin 表示法），優先序：opt.allowedOrigins > env SCREENCTL_ALLOWED_ORIGINS。預設空＝帶 Origin 之請求一律 403 且不輸出 CORS 標頭
 * @param {Object} [opt.backend] 進階／測試用：以替身取代系統級後端（須提供 screenshot、mouseClick、mouseDblClick、mouseDrag、mouseScroll、keyboardKey、keyboardType、getMemoryInfo）；預設依平台使用 bkWin／bkLinux
 * @param {Array<String>|String} [opt.allowedHosts=[]] 額外允許之 Host 標頭主機名稱（例：反向代理之對外名稱），優先序：opt.allowedHosts > env SCREENCTL_ALLOWED_HOSTS。綁迴路位址時另內建 localhost、127.0.0.1、[::1]；綁非迴路位址且未設時不檢查 Host
 * @returns {Promise<Server>} Hapi server 實例
 */
async function WScreenctl(opt = {}) {

    let port = get(opt, 'port', null)
    if (ispint(process.env.PORT)) port = cint(process.env.PORT)
    if (!ispint(port)) port = 7000
    port = cint(port)

    // opt.backend：進階／測試用，以替身取代系統級後端（screenshot、mouse*、keyboard*、getMemoryInfo），測試才不必真的操作桌面
    const backend = get(opt, 'backend', null) || (process.platform === 'win32' ? bkWin : bkLinux)

    let fdUserData = process.env.CHROME_USER_DATA
    if (!isestr(fdUserData)) fdUserData = get(opt, 'fdUserData', null)
    if (!isestr(fdUserData)) {
        fdUserData = './user_data'
    }

    // 安全設定須在綁 port 之前解析：設定有誤或不安全（例：綁非迴路位址卻無 token）即拒絕啟動
    const sec = resolveSecurity(opt, process.env, { port })
    const gate = createGate(sec)

    const chromeManager = new ChromeManager()

    // ── Hapi 伺服器 ──────────────────────────────────────────

    // 統一 Joi 失敗響應，符合 { ok, error, retry } 契約
    const validationFailAction = (req, h, err) => h.response({
        ok: false,
        error: err.message,
        code: 'VALIDATION',
        retry: 'never',
    }).code(400).takeover()

    const server = Hapi.server({
        port,
        host: sec.host,
        routes: {
            cors: sec.cors, // 預設 false（不輸出任何 CORS 標頭）；僅 allowedOrigins 非空時啟用白名單
            payload: { maxBytes: 10 * 1024 * 1024 },
            validate: { failAction: validationFailAction },
        },
    })

    // 預設拒絕：所有已註冊路由皆須 token（免 token 者須顯式標 options.app.public）；
    // Host／Origin 檢查涵蓋一切請求。Hapi 內建之 notFound 與 CORS 預檢特殊路由不經 onPreAuth（只回 404／CORS 標頭，不執行 handler）
    server.ext('onRequest', gate.onRequest)
    server.ext('onPreAuth', gate.onPreAuth)

    const validate = (payload) => ({ payload, failAction: validationFailAction })

    // ─── Chrome 生命週期路由 ────────────────────────────────

    server.route({
        method: 'POST',
        path: '/chrome/open',
        options: { validate: validate(S.schemaChromeOpen) },
        handler: lifecycleRoute('chrome/open', async (p) => {
            const r = await chromeManager.open({
                url: p.url,
                mode: p.mode,
                window: p.window,
                viewport: p.viewport,
                userDataDir: p.userData || fdUserData,
                opt: p.opt || {}, // opt 含 headless（預設 true）/ disableGpu / disableSandbox / deviceScaleFactor，透傳給 launch
            })
            return { ok: true, ...r }
        }),
    })

    server.route({
        method: 'GET',
        path: '/chrome',
        handler: () => chromeManager.snapshot(),
    })

    server.route({
        method: 'DELETE',
        path: '/chrome',
        handler: lifecycleRoute('chrome/delete', async () => {
            const r = await chromeManager.close()
            return { ok: true, ...r }
        }),
    })

    // ─── Chrome 頁面操作 ────────────────────────────────────

    server.route({
        method: 'POST',
        path: '/chrome/screenshot',
        handler: chromeRoute('chrome/screenshot', chromeManager, async (inst) => {
            const buf = await inst.page.screenshot({ fullPage: false, timeout: 5000 })
            return { ok: true, image: buf.toString('base64'), format: 'png' }
        }),
    })

    server.route({
        method: 'POST',
        path: '/chrome/navigate',
        options: { validate: validate(S.schemaChromeNavigate) },
        handler: chromeRoute('chrome/navigate', chromeManager, async (inst, p) => {
            // goto 失敗直接 throw 給 chromeRoute → errResponse 統一處理（含 retry hint）
            await inst.page.goto(p.url, { waitUntil: 'commit', timeout: 15000 })
            return { ok: true, url: inst.page.url() }
        }),
    })

    server.route({
        method: 'POST',
        path: '/chrome/evaluate',
        // app.feature='evaluate'：高權限端點（任意 JS 執行），預設關閉，由閘門於驗證 token 後、payload 解析前擋下（403）
        options: { validate: validate(S.schemaChromeEvaluate), app: { feature: 'evaluate' } },
        handler: chromeRoute('chrome/evaluate', chromeManager, async (inst, p) => {
            // timeout 與 script 錯誤都 throw 出去給 chromeRoute → errResponse 統一分類
            // 包成 IIFE 在頁內 Promise.race，timeout 字樣會被 errClassify 抓成 retry: 'after_1s'
            let timer
            try {
                const result = await Promise.race([
                    inst.page.evaluate(p.script),
                    new Promise((_resolve, reject) => {
                        timer = setTimeout(() => reject(new Error('evaluate timeout 5s')), 5000)
                    }),
                ])
                return { ok: true, result }
            }
            finally {
                if (timer) clearTimeout(timer)
            }
        }),
    })

    // ─── Chrome 頁面級輸入 ──────────────────────────────────

    const PAGE_BTN = { 1: 'left', 2: 'middle', 3: 'right' }

    server.route({
        method: 'POST',
        path: '/chrome/mouse/click',
        options: { validate: validate(S.schemaChromeMouseClick) },
        handler: chromeRoute('chrome/mouse/click', chromeManager, async (inst, p) => {
            await inst.page.mouse.click(p.x, p.y, { button: PAGE_BTN[p.button] })
            return { ok: true }
        }),
    })

    server.route({
        method: 'POST',
        path: '/chrome/mouse/dblclick',
        options: { validate: validate(S.schemaChromeMouseDblClick) },
        handler: chromeRoute('chrome/mouse/dblclick', chromeManager, async (inst, p) => {
            await inst.page.mouse.dblclick(p.x, p.y)
            return { ok: true }
        }),
    })

    server.route({
        method: 'POST',
        path: '/chrome/mouse/drag',
        options: { validate: validate(S.schemaChromeMouseDrag) },
        handler: chromeRoute('chrome/mouse/drag', chromeManager, async (inst, p) => {
            const btn = PAGE_BTN[p.button]
            await inst.page.mouse.move(p.fromX, p.fromY)
            await inst.page.mouse.down({ button: btn })
            await inst.page.mouse.move(p.toX, p.toY)
            await inst.page.mouse.up({ button: btn })
            return { ok: true }
        }),
    })

    server.route({
        method: 'POST',
        path: '/chrome/mouse/scroll',
        options: { validate: validate(S.schemaChromeMouseScroll) },
        handler: chromeRoute('chrome/mouse/scroll', chromeManager, async (inst, p) => {
            const step = 100
            const deltas = {
                up: [0, -step * p.amount],
                down: [0, step * p.amount],
                left: [-step * p.amount, 0],
                right: [step * p.amount, 0],
            }
            const [dx, dy] = deltas[p.direction]
            await inst.page.mouse.move(p.x, p.y)
            await inst.page.mouse.wheel(dx, dy)
            return { ok: true }
        }),
    })

    server.route({
        method: 'POST',
        path: '/chrome/keyboard/key',
        options: { validate: validate(S.schemaChromeKeyboardKey) },
        handler: chromeRoute('chrome/keyboard/key', chromeManager, async (inst, p) => {
            await inst.page.keyboard.press(p.keys)
            return { ok: true }
        }),
    })

    server.route({
        method: 'POST',
        path: '/chrome/keyboard/type',
        options: { validate: validate(S.schemaChromeKeyboardType) },
        handler: chromeRoute('chrome/keyboard/type', chromeManager, async (inst, p) => {
            await inst.page.keyboard.type(p.text)
            return { ok: true }
        }),
    })

    // ─── 系統級控制 ─────────────────────────────────────────

    server.route({
        method: 'POST',
        path: '/screenshot',
        options: { validate: validate(S.schemaSystemScreenshot) },
        handler: systemRoute('screenshot', async (p) => {
            const image = await backend.screenshot(p.region || null)
            return { ok: true, image, format: 'png' }
        }),
    })

    server.route({
        method: 'POST',
        path: '/mouse/click',
        options: { validate: validate(S.schemaSystemMouseClick) },
        handler: systemRoute('mouse/click', async (p) => {
            await backend.mouseClick(p.x, p.y, p.button)
            return { ok: true }
        }),
    })

    server.route({
        method: 'POST',
        path: '/mouse/dblclick',
        options: { validate: validate(S.schemaSystemMouseDblClick) },
        handler: systemRoute('mouse/dblclick', async (p) => {
            await backend.mouseDblClick(p.x, p.y)
            return { ok: true }
        }),
    })

    server.route({
        method: 'POST',
        path: '/mouse/drag',
        options: { validate: validate(S.schemaSystemMouseDrag) },
        handler: systemRoute('mouse/drag', async (p) => {
            await backend.mouseDrag(p.fromX, p.fromY, p.toX, p.toY, p.button)
            return { ok: true }
        }),
    })

    server.route({
        method: 'POST',
        path: '/mouse/scroll',
        options: { validate: validate(S.schemaSystemMouseScroll) },
        handler: systemRoute('mouse/scroll', async (p) => {
            await backend.mouseScroll(p.x, p.y, p.direction, p.amount)
            return { ok: true }
        }),
    })

    server.route({
        method: 'POST',
        path: '/keyboard/key',
        options: { validate: validate(S.schemaSystemKeyboardKey) },
        handler: systemRoute('keyboard/key', async (p) => {
            await backend.keyboardKey(normalizeKey(p.keys))
            return { ok: true }
        }),
    })

    server.route({
        method: 'POST',
        path: '/keyboard/type',
        options: { validate: validate(S.schemaSystemKeyboardType) },
        handler: systemRoute('keyboard/type', async (p) => {
            await backend.keyboardType(p.text)
            return { ok: true }
        }),
    })

    // ─── 健康檢查（30s cache） ───────────────────────────────

    function fmtBytes(bytes) {
        if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + 'GB'
        return (bytes / 1048576).toFixed(0) + 'MB'
    }

    let healthCache = null
    let healthCacheTime = 0
    const HEALTH_TTL = 30000
    async function getHealthMemory() {
        const now = Date.now()
        if (healthCache && now - healthCacheTime < HEALTH_TTL) return healthCache
        const m = await backend.getMemoryInfo()
        healthCache = m
            ? {
                total: fmtBytes(m.total),
                used: fmtBytes(m.used),
                available: fmtBytes(m.available),
                chromeRSS: fmtBytes(m.chromeRSS),
            }
            : null
        healthCacheTime = now
        return healthCache
    }

    // 唯一免 token 之路由（app.public）；仍受 Host／Origin 檢查
    server.route({
        method: 'GET',
        path: '/health',
        options: { app: { public: true } },
        handler: async () => {
            const memory = await getHealthMemory().catch(() => null)
            return {
                status: 'ok',
                platform: process.platform,
                chrome: chromeManager.snapshot().state,
                uptime: process.uptime(),
                memory,
            }
        },
    })

    await server.start()

    // 自動產生之 token 須在 server 啟動成功（確認 port 無他人占用）後才寫檔，
    // 否則第二個實例因 port 衝突而啟動失敗時，會把執行中實例所用之 token 檔覆寫掉
    if (sec.persist) {
        try {
            persistToken(sec.tokenFile, sec.token, { replace: sec.persistReplace })
        }
        catch (err) {
            // 沒有人讀得到 token 的伺服器等於無法使用：停掉並拒絕啟動
            await server.stop({ timeout: 3000 }).catch(() => {})
            const why = err.code === 'EEXIST'
                ? 'the file was created by another process while this one was starting (give each instance its own tokenFile, or restart to read it)'
                : err.message
            const e = new Error(`refusing to start: cannot write generated token to "${sec.tokenFile}": ${why}. Set option "tokenFile" / env SCREENCTL_TOKEN_FILE to a writable path, or provide a token.`)
            e.code = 'SCREENCTL_CONFIG'
            throw e
        }
    }

    // token 全文不輸出（log 可能被收集）；只告知來源與 token 檔位置
    server.app.screenctl = {
        host: sec.host,
        port: server.info.port,
        loopback: sec.loopback,
        tokenSource: sec.tokenSource,
        tokenFile: sec.tokenFile,
        evaluate: sec.evaluate,
        allowedOrigins: [...sec.allowedOrigins],
        allowedHosts: [...sec.allowedHosts],
    }
    console.log(`running at ${server.info.uri} (platform=${process.platform})`)
    const { info, warn } = describeSecurity(sec)
    for (const line of info) console.log(line)
    for (const line of warn) console.warn(line)

    // ─── Graceful shutdown ──────────────────────────────────
    //
    // 順序設計：
    //   1. chromeManager.shutdown() 先：拒新 enqueue + 排空既有 + 關 chromium
    //      （若直接 server.stop 先，正在 launch 的 chromium 會變孤兒）
    //   2. server.stop() 後：拒新 HTTP 連線 + 等 in-flight 完成
    //   3. 整體有 60s 硬上限（須 ≥ chromeManager 內 launch timeout 20s + cleanup grace 30s = 50s），
    //      超時直接 exit(1)，由 OS 回收 chromium

    let shuttingDown = false
    async function gracefulShutdown(signal) {
        if (shuttingDown) return
        shuttingDown = true
        console.log(`[${signal}] shutting down...`)

        const hardKillTimer = setTimeout(() => {
            console.error('[shutdown] hard timeout 60s, force exit')
            process.exit(1)
        }, 60000)
        hardKillTimer.unref()

        try {
            await chromeManager.shutdown()
        }
        catch (err) {
            console.error('[shutdown] chromeManager.shutdown failed:', err.message)
        }
        try {
            await server.stop({ timeout: 10000 })
        }
        catch (err) {
            console.error('[shutdown] server.stop failed:', err.message)
        }
        clearTimeout(hardKillTimer)
        process.exit(0)
    }
    process.once('SIGTERM', () => gracefulShutdown('SIGTERM'))
    process.once('SIGINT', () => gracefulShutdown('SIGINT'))

    server.gracefulShutdown = () => gracefulShutdown('manual')

    return server
}


export { errResponse }
export default WScreenctl
