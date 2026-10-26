// boot smoke：起 server、驗證所有路由都註冊成功（不實際操作滑鼠／鍵盤／chrome）
import assert from 'node:assert/strict'
import WScreenctl from '../src/WScreenctl.mjs'

const EXPECTED = [
    'GET /health',
    'POST /chrome/open', 'GET /chrome', 'DELETE /chrome',
    'POST /chrome/screenshot', 'POST /chrome/navigate', 'POST /chrome/evaluate',
    'POST /chrome/mouse/click', 'POST /chrome/mouse/dblclick',
    'POST /chrome/mouse/drag', 'POST /chrome/mouse/scroll',
    'POST /chrome/keyboard/key', 'POST /chrome/keyboard/type',
    'POST /screenshot',
    'POST /mouse/click', 'POST /mouse/dblclick', 'POST /mouse/drag', 'POST /mouse/scroll',
    'POST /keyboard/key', 'POST /keyboard/type',
]

describe('boot smoke：路由註冊', function() {
    this.timeout(15000)

    let server
    let actual

    before(async () => {
        // 預設安全後必須有 token；明給 token 則不會寫出 token 檔（不污染使用者家目錄）
        // auditLog:false：本測試只看路由表，不產生任何操作紀錄檔（預設紀錄檔位於使用者目錄）
        server = await WScreenctl({ port: 7099, token: 'boot-routes-test-token-0123456789', auditLog: false })
        actual = server.table().map((r) => `${r.method.toUpperCase()} ${r.path}`)
    })

    after(async () => {
        if (server) {
            try { await server.stop({ timeout: 5000 }) }
            catch {}
        }
    })

    it(`註冊 ${EXPECTED.length} 個路由（無遺漏）`, () => {
        const missing = EXPECTED.filter((e) => !actual.includes(e))
        assert.deepEqual(missing, [], `missing routes: ${missing.join(', ')}`)
    })

    it('沒有非預期的多餘路由', () => {
        const extra = actual.filter((a) => !EXPECTED.includes(a))
        assert.deepEqual(extra, [], `extra routes: ${extra.join(', ')}`)
    })

})
