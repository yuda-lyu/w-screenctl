import { mkdirSync } from 'fs'
import { chromium } from 'playwright'


/**
 * Chrome 生命週期管理器
 *
 * 設計原則：state 由 Playwright 的 context.isClosed() 衍生，不自製 state machine。
 * caller 看 snapshot 拿 'open' / 'closed' 兩態；操作 API 只在 open 狀態可用，否則拋
 * chromeState-tagged Error 給 errResponse 統一處理。
 *
 * lifecycle 操作（open / close / shutdown）走 _opLock 序列化，避免並發 race。
 */

const TIMEOUT_LAUNCH = 20000
const TIMEOUT_GOTO = 15000
const TIMEOUT_CLOSE_GRACEFUL = 5000
const TIMEOUT_CLEANUP_GRACE = 30000

class ChromeManager {

    constructor() {
        this.context = null
        this.createdAt = null
        this.lastError = null
        this.shuttingDown = false
        this._opLock = Promise.resolve()
    }

    isOpen() {
        return this.context !== null && !this.context.isClosed()
    }

    snapshot() {
        if (this.isOpen()) {
            try {
                return {
                    state: 'open',
                    url: this.context.pages()[0]?.url() || '',
                    createdAt: this.createdAt,
                }
            }
            catch {
                // page.url() 拋 → 視為 closed
            }
        }
        const r = { state: 'closed' }
        if (this.lastError) r.lastError = this.lastError
        return r
    }

    // 業務 handler 用：取 page；非 open 拋帶標籤錯誤給 errResponse 處理
    // caller 可能用 evaluate 關掉 default page；對齊 _launch / reuse 的 fallback 用 newPage 補回
    async withPage(fn) {
        if (!this.isOpen()) {
            const err = new Error('chrome closed')
            err.chromeState = 'closed'
            throw err
        }
        const page = this.context.pages()[0] || await this.context.newPage()
        return fn({ page })
    }

    async open(opts = {}) {
        if (this.shuttingDown) {
            const err = new Error('shutdown_in_progress')
            err.chromeState = 'closed'
            throw err
        }
        return this._enqueue(async () => {
            const mode = opts.mode

            // 已 open 且非 replace：reuse；caller 給不同 url 自動 navigate
            if (this.isOpen() && mode !== 'replace') {
                // caller 可能用 evaluate 關掉 default page；對齊 _launch 的 fallback
                const page = this.context.pages()[0] || await this.context.newPage()
                const currentUrl = page.url()
                let gotoOk = true
                let gotoError = null
                if (opts.url && opts.url !== currentUrl) {
                    try {
                        await this._withDeadline(
                            page.goto(opts.url, { waitUntil: 'commit', timeout: TIMEOUT_GOTO }),
                            TIMEOUT_GOTO + 1000,
                            'reuse-navigate',
                        )
                    }
                    catch (err) {
                        gotoOk = false
                        gotoError = err.message
                    }
                }
                return {
                    state: 'open',
                    url: page.url(),
                    reused: true,
                    gotoOk,
                    gotoError,
                }
            }

            if (this.isOpen() && mode === 'replace') {
                await this._closeInternal()
            }
            // 非 open（含 isClosed 已 true 的殘骸 context）→ 清掉 reference 後重開
            if (this.context && !this.isOpen()) {
                this.context = null
            }

            return this._launch(opts)
        })
    }

    async close() {
        return this._enqueue(async () => {
            if (!this.isOpen() && !this.context) {
                return { closed: false, reason: 'closed' }
            }
            await this._closeInternal()
            return { closed: true }
        })
    }

    async shutdown() {
        this.shuttingDown = true
        return this._enqueue(async () => {
            if (this.context) await this._closeInternal()
            return { shutdown: true }
        })
    }

    // ── 內部 ─────────────────────────────────────────────

    _enqueue(fn) {
        const next = this._opLock.then(() => fn(), () => fn())
        this._opLock = next.catch(() => undefined)
        return next
    }

    async _launch(opts) {
        const { url, window, viewport, userDataDir, opt = {} } = opts
        if (!userDataDir) throw new Error('userDataDir required')

        const disableGpu = opt.disableGpu === true
        const disableSandbox = opt.disableSandbox === true
        const hasPos = window && Number.isFinite(window.x) && Number.isFinite(window.y)
        const hasSize = window && Number.isFinite(window.width) && Number.isFinite(window.height)
        const hasViewport = viewport && viewport.width && viewport.height
        const deviceScaleFactor = opt.deviceScaleFactor

        const args = [
            '--disable-dev-shm-usage',
            '--disable-infobars',
            '--test-type',
            '--hide-crash-restore-bubble',
            '--disable-notifications',
            '--disable-features=Translate',
            '--lang=zh-TW',
        ]
        if (disableSandbox) args.push('--no-sandbox')
        if (disableGpu) args.push('--disable-gpu')
        if (Number.isFinite(deviceScaleFactor)) args.push(`--force-device-scale-factor=${deviceScaleFactor}`)

        if (hasPos) args.push(`--window-position=${window.x},${window.y}`)
        if (hasSize) args.push(`--window-size=${window.width},${window.height}`)
        if (!hasPos && !hasSize) args.push('--start-maximized')

        let _viewport = null
        if (hasViewport) {
            _viewport = { width: viewport.width, height: viewport.height }
        }

        mkdirSync(userDataDir, { recursive: true })

        const ctxOpts = {
            channel: 'chrome',
            headless: false,
            ignoreDefaultArgs: ['--enable-automation'],
            args,
            viewport: _viewport,
            locale: 'zh-TW',
        }
        if (hasViewport && Number.isFinite(deviceScaleFactor)) ctxOpts.deviceScaleFactor = deviceScaleFactor

        // launch 不能 cancel；race 輸了要等底層真結束才釋放 _opLock，避免 retry 撞 SingletonLock
        const launchP = chromium.launchPersistentContext(userDataDir, ctxOpts)
        let context
        try {
            context = await this._withDeadline(launchP, TIMEOUT_LAUNCH, 'launchPersistentContext')
        }
        catch (err) {
            this.lastError = err.message
            if (/launchPersistentContext timeout/.test(err.message)) {
                const cleanup = launchP.then(
                    (ctx) => ctx.close().catch(() => {}),
                    () => {},
                )
                await Promise.race([
                    cleanup,
                    new Promise((resolve) => setTimeout(resolve, TIMEOUT_CLEANUP_GRACE)),
                ])
            }
            throw err
        }

        // 異常死亡偵測：caller 沒主動 close 就轉 closed，記下 reason
        context.once('close', () => {
            // 只在我們仍持有此 context 且非主動 close 時記錯
            if (this.context === context && !this.shuttingDown) {
                this.lastError = this.lastError || 'context closed unexpectedly'
            }
        })

        this.context = context
        this.createdAt = new Date().toISOString()
        this.lastError = null

        const page = context.pages()[0] || await context.newPage()

        let gotoOk = true
        let gotoError = null
        if (url) {
            try {
                await this._withDeadline(
                    page.goto(url, { waitUntil: 'commit', timeout: TIMEOUT_GOTO }),
                    TIMEOUT_GOTO + 1000,
                    'page.goto',
                )
            }
            catch (err) {
                gotoOk = false
                gotoError = err.message
                console.error('[chromeManager] goto failed:', err.message)
            }
        }

        return {
            state: 'open',
            url: page.url(),
            reused: false,
            gotoOk,
            gotoError,
        }
    }

    async _closeInternal() {
        if (!this.context) return
        const ctx = this.context
        const closeP = ctx.close()
        try {
            await this._withDeadline(closeP, TIMEOUT_CLOSE_GRACEFUL, 'context.close')
            this.lastError = null
        }
        catch (err) {
            console.error('[chromeManager] context.close failed; chromium may leak:', err.message)
            this.lastError = `close_failed: ${err.message}`
            // race 輸了等底層真關完（或 30s grace），避免 _opLock 釋放後撞 SingletonLock
            await Promise.race([
                closeP.catch(() => {}),
                new Promise((resolve) => setTimeout(resolve, TIMEOUT_CLEANUP_GRACE)),
            ])
        }
        finally {
            this.context = null
            this.createdAt = null
        }
    }

    async _withDeadline(promise, ms, label) {
        let timer
        const timeoutP = new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms)
        })
        try {
            return await Promise.race([promise, timeoutP])
        }
        finally {
            if (timer) clearTimeout(timer)
        }
    }

}

export default ChromeManager
