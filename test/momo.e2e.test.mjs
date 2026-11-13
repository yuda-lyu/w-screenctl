// e2e：開 chrome 有頭 → 去 momo 首頁 → 截圖 → 驗證 → 清理
//
// 跟其他單元測試一起跑（mocha 自動撿到此檔）。
// before/after hooks 確保不論 it 成敗都會關 chrome 與停 server。
// 截圖以 buffer 在記憶體驗證大小，不落地（依專案 CLAUDE.md 全域規範）。
//
// 真 Chrome（有頭）之啟動本檔只有一次：before 起（POST /chrome/open）、after 關（本測試持有之 ChromeManager 之 shutdown，等關閉完成後才停服務）；
// it 失敗或重試皆不再啟動。
// 啟動經 w-playwright（src/chromeManager.mjs）：命令列一律帶守門參數，使 Windows 上 Chrome 不再以錯誤密碼呼叫 LogonUser。
// Windows：啟動前讀錯誤密碼次數（w-playwright 隨包發布之 readBadPassword，與其執行期登入守門同一讀法），
// 不可讀或非 0 即不啟動（整檔略過；略過不算通過，等其歸零〔最後一次失敗 10 分鐘後〕再跑）；
// 關閉後再讀須與啟動前相同（端到端不變式）：末案於流程中斷言，after 另於「嘗試過啟動」時一律再比對（before 失敗或中途停止時末案不會執行）。

import assert from 'node:assert/strict'
import readBadPassword from 'w-playwright/test/tools/readBadPassword.mjs'
import WScreenctl from '../src/WScreenctl.mjs'
import ChromeManager from '../src/chromeManager.mjs'

const PORT = parseInt(process.env.E2E_PORT || '8080', 10)
const TARGET_URL = 'https://www.momoshop.com.tw/main/Main.jsp'
const TOKEN = 'momo-e2e-test-token-0123456789' // 預設安全後所有端點（除 /health）須 Bearer token

// 外部網站（momoshop）之渲染時間不可控（網路、廣告、反爬機制皆在我們之外），故不以固定延時假設「5 秒後必已渲染」，
// 改等頁面可觀察之就緒條件（見 waitFor 的用法）。下列兩個常數都不是「等待時間」：
// WATCHDOG_MS 只防懸置（須小於 mocha 的 60s 逾時），條件成立即返回；POLL_MS 為取樣間隔。
// 外部站點本身無法由測試控制之部分（站點改版、被限流或導向驗證頁）仍可能使本案失敗，那是環境事實而非計時問題。
const WATCHDOG_MS = 45000
const POLL_MS = 500
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 重複取樣直到 check() 回傳真值；check 內的斷言錯誤（真失敗）直接拋出，不重試
async function waitFor(check, label) {
    const t0 = Date.now()
    for (;;) {
        if (await check()) return
        if (Date.now() - t0 > WATCHDOG_MS) throw new Error(`watchdog ${WATCHDOG_MS}ms: ${label()}`)
        await sleep(POLL_MS)
    }
}

async function api(method, urlPath, body) {
    const r = await fetch(`http://127.0.0.1:${PORT}${urlPath}`, {
        method,
        headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    })
    return r.json()
}

describe('e2e: chrome 開→ momo →截圖→關', function() {
    this.timeout(60000)

    let server = null
    let cm = null // 本測試持有之 Chrome 管理器（與服務內建者同一類別；after 以 shutdown 確實關閉）
    let openRes = null // 本檔唯一一次啟動之回應（before 內取得，由第一案斷言）
    let launchAttempted = false
    let bad0 = null // Windows：啟動前之錯誤密碼次數

    before(async function() {
        if (process.platform === 'win32') {
            const b = await readBadPassword()
            if (!b.ok || b.bad !== 0) {
                this.skip() // 錯誤密碼次數不可讀或非 0：不啟動真 Chrome（試跑紀律）
            }
            bad0 = b.bad
        }
        cm = new ChromeManager()
        // auditLog:false：本測試不驗操作紀錄，且預設紀錄檔位於使用者目錄
        // enableEvaluate：僅供測試端讀 document.readyState 判斷頁面是否載入完成（見渲染等待案）；本服務只綁本機且須 token
        // chromeManager：傳入本測試持有之實例（WScreenctl 之進階選項），after 才能等它關閉完成
        server = await WScreenctl({ port: PORT, token: TOKEN, auditLog: false, enableEvaluate: true, chromeManager: cm })
        // 本檔唯一一次啟動（有頭真 Chrome）
        launchAttempted = true
        openRes = await api('POST', '/chrome/open', {
            url: TARGET_URL,
            window: { x: 0, y: 0, width: 1280, height: 800 },
            opt: { headless: false }, // 本案驗有頭視窗流程；/chrome/open 預設為 headless
        })
    })

    after(async () => {
        // 不論 it 成敗都要清理：先關 chrome（shutdown 排空佇列並等關閉完成），再停 server；清理失敗不吞掉，最後一併拋出
        // （before 略過而未建立者不動，免打到占用同埠之他服務）
        const errs = []
        try {
            if (cm) await cm.shutdown()
        }
        catch (e) {
            errs.push(e)
        }
        try {
            if (server) await server.stop({ timeout: 5000 })
        }
        catch (e) {
            errs.push(e)
        }
        // 嘗試過啟動者一律再讀錯誤密碼次數（末案可能因 before 失敗或中途停止而未執行）
        if (launchAttempted && process.platform === 'win32') {
            const b1 = await readBadPassword()
            if (!b1.ok || b1.bad !== bad0) {
                errs.push(new Error(`錯誤密碼次數由 ${bad0} 變為 ${b1.ok ? b1.bad : '不可讀'}：立即停止一切真 Chrome 之啟動並回報`))
            }
        }
        if (errs.length === 1) throw errs[0]
        if (errs.length > 1) throw new AggregateError(errs, 'momo e2e 清理失敗')
    })

    it('POST /chrome/open momo 首頁 → state=open + gotoOk', async () => {
        const r = openRes // 啟動於 before（本檔唯一一次）
        assert.equal(r.ok, true, `open failed: ${r.error}`)
        assert.equal(r.state, 'open')
        assert.equal(r.gotoOk, true, `goto failed: ${r.gotoError}`)
    })

    it('首頁載入完成（readyState=complete）且截圖非空白後，POST /chrome/screenshot 取得 base64 PNG', async () => {
        // /chrome/open 只等到 navigation commit，頁面仍在載入／渲染（實測 headless：0.9s 時 readyState=loading 而截圖已 14975B，
        // 單看截圖大小會在頁面尚未載入時就放行），所以就緒條件有兩個，皆為頁面可觀察之狀態，條件式重試至成立：
        // ①document.readyState==='complete'（載入狀態）②截圖為非空白（>10000B）之 PNG。舊作法：sleep(5000) 後截一張。
        // 任一請求失敗（ok:false）為真失敗，不重試
        await waitFor(async () => {
            const e = await api('POST', '/chrome/evaluate', { script: 'document.readyState' })
            assert.equal(e.ok, true, `evaluate failed: ${e.error}`)
            return e.result === 'complete'
        }, () => '頁面 readyState 未達 complete')
        let r
        let buf
        await waitFor(async () => {
            r = await api('POST', '/chrome/screenshot')
            assert.equal(r.ok, true, `screenshot failed: ${r.error}`)
            buf = Buffer.from(r.image, 'base64')
            return buf.length > 10000
        }, () => `截圖仍為空白頁（最後一張 ${buf ? buf.length : 0}B）`)
        assert.equal(r.format, 'png')

        // PNG 標頭驗證：8 bytes magic
        const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        assert.ok(buf.subarray(0, 8).equals(PNG_MAGIC), 'screenshot 不是合法 PNG')
        // 大小驗證：太小視為空白頁
        assert.ok(buf.length > 10000, `screenshot 太小 (${buf.length}B)，可能是空白頁`)
    })

    it('DELETE /chrome → state=closed', async () => {
        const r = await api('DELETE', '/chrome')
        assert.equal(r.ok, true)
        assert.equal(r.closed, true)

        const status = await api('GET', '/chrome')
        assert.equal(status.state, 'closed')
    })

    it('Windows：啟動真 Chrome 前後錯誤密碼次數不變（經 w-playwright 之守門參數生效）', async function() {
        if (process.platform !== 'win32') {
            this.skip() // LogonUser 之症狀限 Windows
        }
        assert.equal(openRes && openRes.ok, true, '真 Chrome 未成功啟動，無從驗證守門') // 守門生效之前提：確有啟動
        const b1 = await readBadPassword()
        assert.deepEqual([b1.ok, b1.bad], [true, bad0], `錯誤密碼次數由 ${bad0} 變為 ${b1.bad}：立即停止一切真 Chrome 之啟動並回報`)
    })

})
