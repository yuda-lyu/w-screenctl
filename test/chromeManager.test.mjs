import assert from 'node:assert/strict'
import ChromeManager from '../src/chromeManager.mjs'

// 注入 fake context，避開真 chromium。模擬 Playwright context 的關鍵介面：
//   isClosed(), pages(), close()
function fakeCtx({ url = 'http://x', closed = false, closeImpl } = {}) {
    let _closed = closed
    const ctx = {
        isClosed: () => _closed,
        pages: () => [{ url: () => url }],
        close: closeImpl || (async () => { _closed = true }),
        once: () => {},
        _setClosed: (v) => { _closed = v },
    }
    return ctx
}

describe('ChromeManager', () => {

    it('initial: isOpen=false, snapshot=closed', () => {
        const m = new ChromeManager()
        assert.equal(m.isOpen(), false)
        assert.deepEqual(m.snapshot(), { state: 'closed' })
    })

    it('snapshot 帶 lastError 當 closed 且有錯', () => {
        const m = new ChromeManager()
        m.lastError = 'boom'
        assert.deepEqual(m.snapshot(), { state: 'closed', lastError: 'boom' })
    })

    it('isOpen=true 時 snapshot 回 open + url + createdAt', () => {
        const m = new ChromeManager()
        m.context = fakeCtx({ url: 'http://a' })
        m.createdAt = 't0'
        assert.deepEqual(m.snapshot(), { state: 'open', url: 'http://a', createdAt: 't0' })
    })

    it('context.isClosed()=true → snapshot 回 closed', () => {
        const m = new ChromeManager()
        m.context = fakeCtx({ closed: true })
        assert.equal(m.isOpen(), false)
        assert.equal(m.snapshot().state, 'closed')
    })

    it('snapshot 在 page.url() throw 時 fallback 為 closed', () => {
        const m = new ChromeManager()
        m.context = {
            isClosed: () => false,
            pages: () => [{ url: () => { throw new Error('page closed') } }],
        }
        assert.equal(m.snapshot().state, 'closed')
    })

    it('withPage 在非 open 拋 chromeState=closed 錯誤', async () => {
        const m = new ChromeManager()
        await assert.rejects(
            () => m.withPage(() => 1),
            (err) => err.chromeState === 'closed' && /chrome closed/.test(err.message),
        )
    })

    it('withPage 在 open 把 page 包進 { page } 傳給 fn', async () => {
        const m = new ChromeManager()
        m.context = fakeCtx({ url: 'http://x' })
        const r = await m.withPage((inst) => inst.page.url())
        assert.equal(r, 'http://x')
    })

    it('withPage pages() 為空時用 newPage 補回（對齊 reuse fallback）', async () => {
        const m = new ChromeManager()
        let newPageCalled = 0
        m.context = {
            isClosed: () => false,
            pages: () => [],
            newPage: async () => {
                newPageCalled++
                return { url: () => 'about:blank' }
            },
        }
        const r = await m.withPage((inst) => inst.page.url())
        assert.equal(newPageCalled, 1)
        assert.equal(r, 'about:blank')
    })

    it('close 在已 closed 回 { closed: false, reason: closed }', async () => {
        const m = new ChromeManager()
        const r = await m.close()
        assert.deepEqual(r, { closed: false, reason: 'closed' })
    })

    it('close 在 open 呼叫 ctx.close() 並清狀態', async () => {
        const m = new ChromeManager()
        let closeCalled = 0
        m.context = fakeCtx({
            closeImpl: async function() {
                closeCalled++
                this._setClosed(true)
            },
        })
        m.context._setClosed = function(v) { this._c = v; this.isClosed = () => v }
        m.createdAt = 't0'
        const r = await m.close()
        assert.equal(closeCalled, 1)
        assert.deepEqual(r, { closed: true })
        assert.equal(m.context, null)
        assert.equal(m.createdAt, null)
    })

    it('shutdown 後 open 立即被拒，error 帶 chromeState=closed', async () => {
        const m = new ChromeManager()
        await m.shutdown()
        await assert.rejects(
            () => m.open({ userDataDir: './user_data' }),
            (err) => err.chromeState === 'closed' && /shutdown_in_progress/.test(err.message),
        )
    })

    it('queue 序列化：lifecycle 操作排隊', async () => {
        const m = new ChromeManager()
        const log = []
        // 用 _enqueue 直接餵 task 觀察序列化（不打 chromium）
        const a = m._enqueue(async () => {
            log.push('a-start')
            await new Promise((r) => setTimeout(r, 20))
            log.push('a-done')
            return 'A'
        })
        const b = m._enqueue(async () => {
            log.push('b-start')
            return 'B'
        })
        const [ra, rb] = await Promise.all([a, b])
        assert.equal(ra, 'A')
        assert.equal(rb, 'B')
        assert.deepEqual(log, ['a-start', 'a-done', 'b-start'])
    })

    it('queue 前一個 reject 不卡後續', async () => {
        const m = new ChromeManager()
        const a = m._enqueue(async () => { throw new Error('boom') }).catch((e) => e.message)
        const b = m._enqueue(async () => 'ok')
        const [ra, rb] = await Promise.all([a, b])
        assert.equal(ra, 'boom')
        assert.equal(rb, 'ok')
    })

    it('_withDeadline 超時拋 timeout', async () => {
        const m = new ChromeManager()
        await assert.rejects(
            () => m._withDeadline(new Promise(() => {}), 30, 'test-op'),
            /test-op timeout 30ms/,
        )
    })

    it('_withDeadline 成功路徑回值且 clearTimeout', async () => {
        const m = new ChromeManager()
        const r = await m._withDeadline(Promise.resolve('ok'), 1000, 'test-op')
        assert.equal(r, 'ok')
    })

})
