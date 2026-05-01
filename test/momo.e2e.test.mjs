// e2e：開 chrome 有頭 → 去 momo 首頁 → 截圖 → 驗證 → 清理
//
// 跟其他單元測試一起跑（mocha 自動撿到此檔）。
// before/after hooks 確保不論 it 成敗都會關 chrome 與停 server。
// 截圖以 buffer 在記憶體驗證大小，不落地（依專案 CLAUDE.md 全域規範）。

import assert from 'node:assert/strict'
import WScreenctl from '../src/WScreenctl.mjs'

const PORT = parseInt(process.env.E2E_PORT || '8080', 10)
const TARGET_URL = 'https://www.momoshop.com.tw/main/Main.jsp'
const RENDER_WAIT_MS = 5000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(method, urlPath, body) {
    const r = await fetch(`http://127.0.0.1:${PORT}${urlPath}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    })
    return r.json()
}

describe('e2e: chrome 開→ momo →截圖→關', function() {
    this.timeout(60000)

    let server

    before(async () => {
        server = await WScreenctl({ port: PORT })
    })

    after(async () => {
        // 不論 it 成敗都要清理：先關 chrome，再停 server
        try { await api('DELETE', '/chrome') }
        catch {}
        if (server) {
            try { await server.stop({ timeout: 5000 }) }
            catch {}
        }
    })

    it('POST /chrome/open momo 首頁 → state=open + gotoOk', async () => {
        const r = await api('POST', '/chrome/open', {
            url: TARGET_URL,
            window: { x: 0, y: 0, width: 1280, height: 800 },
        })
        assert.equal(r.ok, true, `open failed: ${r.error}`)
        assert.equal(r.state, 'open')
        assert.equal(r.gotoOk, true, `goto failed: ${r.gotoError}`)
    })

    it('等首頁渲染後 POST /chrome/screenshot 取得 base64 PNG', async () => {
        await sleep(RENDER_WAIT_MS)
        const r = await api('POST', '/chrome/screenshot')
        assert.equal(r.ok, true, `screenshot failed: ${r.error}`)
        assert.equal(r.format, 'png')

        const buf = Buffer.from(r.image, 'base64')
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

})
