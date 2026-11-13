// 接線測試（api 層）：HTTP POST /chrome/open → 內建 ChromeManager → w-playwright（規則帳本 PW-01～PW-03；w-playwright 帳本 R-PW-WIRING）
//
// 真 Hapi＋真 HTTP；w-playwright 所呼叫之 BrowserType 以 wpw.setBrowserTypeForTest 之替身取代，替身收到合併後之選項。
// 「真路徑」一案：替身收下合併選項後以 next({ ...o, channel: undefined, headless: true }) 交回 w-playwright，
// 由 w-playwright 真啟動 Playwright 受管之 headless shell 一次（非真 Chrome／Edge／完整 Chromium；本檔唯一之真啟動），
// 驗證本套件於 w-playwright 交回之真 BrowserContext 上之開、截圖、關。headless shell 未安裝時該案 skip 並寫明原因。
// 不寫真實使用者目錄：token 明給（不寫 token 檔）、auditLog:false；不覆寫 HOME／USERPROFILE（覆寫會使瀏覽器啟動逾時，見 sgud 經驗）。
// 臨時檔：test/_tmp/api-chromeLaunch/（after 刪除）。port 8771 固定。

import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import wpw from 'w-playwright'
import { makeHarness } from './tools/apiHarness.mjs'
import { rawRequest } from './tools/rawHttp.mjs'

const PORT = 8771
const TOKEN = 'chrome-launch-test-token-0123456789'
const TMP = path.resolve('test/_tmp/api-chromeLaunch')
const PROFILE = path.join(TMP, 'profile')
const INFO = wpw.getPlaywrightInfo()
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

const isFeatSwitch = (a) => /^--?(disable|enable)-features(=|$)/i.test(a)

// spec：命令列恰一個 --disable-features，為最後一個元素，含 Playwright 預設＋守門＋本套件之 Translate
function assertGuardArgs(args) {
    const sw = args.filter(isFeatSwitch)
    assert.equal(sw.length, 1, `功能開關須恰一個：${JSON.stringify(sw)}`)
    assert.equal(args[args.length - 1], sw[0])
    const items = sw[0].slice('--disable-features='.length).split(',')
    for (const f of [...INFO.defaultDisableFeatures, ...INFO.guardFeatures, 'Translate']) {
        assert.ok(items.includes(f), `--disable-features 缺 ${f}`)
    }
}

function makeCtx() {
    let closed = false
    const page = { url: () => 'about:blank', goto: async () => {} }
    const ctx = {
        closeCalls: 0,
        isClosed: () => closed,
        pages: () => [page],
        newPage: async () => page,
        once: () => {},
        close: async () => {
            ctx.closeCalls++
            closed = true
        },
    }
    return ctx
}

function installFake(impl) {
    const calls = { persistent: [], launch: 0, ctxs: [] }
    const restore = wpw.setBrowserTypeForTest({
        launch: async () => {
            calls.launch++
            throw new Error('non-persistent launch must not be used')
        },
        launchPersistentContext: async (dir, o, next) => {
            calls.persistent.push({ dir, o })
            if (impl) return impl(dir, o, next)
            const ctx = makeCtx()
            calls.ctxs.push(ctx)
            return ctx
        },
    })
    return { calls, restore }
}

const h = makeHarness()
const auth = () => ({ authorization: `Bearer ${TOKEN}` })
const api = (method, p, body) => rawRequest({ port: PORT, method, path: p, headers: auth(), body })

describe('api-chromeLaunch：/chrome/open 經 w-playwright 啟動', function() {
    this.timeout(120000)

    let fake = null

    before(async () => {
        h.clearEnv()
        fs.mkdirSync(TMP, { recursive: true })
        await h.start({ port: PORT, token: TOKEN, auditLog: false, fdUserData: PROFILE })
    })

    afterEach(async () => {
        // 每案結束一律關閉（不論成敗），再還原替身
        try {
            await api('DELETE', '/chrome')
        }
        catch {}
        if (fake) fake.restore()
        fake = null
    })

    after(async () => {
        await h.stopAll()
        h.restoreEnv()
        fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    })

    it('PW-01/02 POST /chrome/open（預設 user data）→ 經 wpw.launchChromiumPersistent，選項含守門；DELETE /chrome 關閉該 context', async () => {
        fake = installFake()
        const r = await api('POST', '/chrome/open', {})
        assert.equal(r.status, 200)
        assert.equal(r.json.ok, true, `open failed: ${r.json.error}`)
        assert.equal(r.json.state, 'open')
        assert.equal(fake.calls.persistent.length, 1, '替身未被呼叫：/chrome/open 未經 w-playwright')
        assert.equal(fake.calls.launch, 0)
        const { dir, o } = fake.calls.persistent[0]
        assert.equal(dir, path.resolve(PROFILE))
        assert.equal(o.channel, 'chrome')
        assert.equal(o.headless, true)
        assert.ok(o.ignoreDefaultArgs.includes('--enable-automation'))
        assertGuardArgs(o.args)
        const d = await api('DELETE', '/chrome')
        assert.deepEqual(d.json, { ok: true, closed: true })
        assert.equal(fake.calls.ctxs[0].closeCalls, 1)
    })

    it('PW-02 payload.userData（相對路徑）→ 以絕對路徑交給 w-playwright；opt.headless:false 原樣送出', async () => {
        fake = installFake()
        const rel = path.relative(process.cwd(), path.join(TMP, 'payload-profile'))
        const r = await api('POST', '/chrome/open', { userData: rel, opt: { headless: false } })
        assert.equal(r.json.ok, true, `open failed: ${r.json.error}`)
        assert.equal(fake.calls.persistent.length, 1)
        assert.equal(fake.calls.persistent[0].dir, path.resolve(rel))
        assert.equal(fake.calls.persistent[0].o.headless, false)
        assertGuardArgs(fake.calls.persistent[0].o.args)
    })

    // 啟動失敗之 HTTP 回應（spec：error 為 w-playwright 之固定詞彙、不含 Playwright 原訊息；code／retry 依 errClassify）
    const FAILS = [
        {
            name: '一般失敗',
            make: () => new Error('browserType.launchPersistentContext: secret-detail C:/somewhere/chrome.exe'),
            want: { ok: false, error: 'browser launch failed', code: 'UNKNOWN', retry: 'never' },
        },
        {
            name: 'Playwright 逾時（TimeoutError；與遷移前同為 TIMEOUT／after_1s）',
            make: () => {
                const e = new Error('browserType.launchPersistentContext: Timeout 180000ms exceeded.')
                e.name = 'TimeoutError'
                return e
            },
            want: { ok: false, error: 'browser launch timed out', code: 'TIMEOUT', retry: 'after_1s' },
        },
        {
            name: '瀏覽器啟動即結束（Playwright「Target page, context or browser has been closed」；遷移前分類為 CHROME_NOT_OPEN／after_recovery，行為變更）',
            make: () => new Error('browserType.launchPersistentContext: Target page, context or browser has been closed'),
            want: { ok: false, error: 'browser launch failed', code: 'UNKNOWN', retry: 'never' },
        },
    ]
    for (const c of FAILS) {
        it(`PW-03 啟動失敗之回應：${c.name}；GET /chrome 之 lastError 同`, async () => {
            fake = installFake(async () => {
                throw c.make()
            })
            const r = await api('POST', '/chrome/open', {})
            assert.equal(fake.calls.persistent.length, 1)
            assert.deepEqual(r.json, c.want)
            const g = await api('GET', '/chrome')
            assert.deepEqual(g.json, { state: 'closed', lastError: c.want.error })
        })
    }

    it('PW-03 不支援之環境變數 PWDEBUG → 回應 { ok:false, error:"unsupported environment: PWDEBUG", code:"UNKNOWN", retry:"never" }，替身 0 次', async () => {
        fake = installFake()
        const had = Object.prototype.hasOwnProperty.call(process.env, 'PWDEBUG')
        const old = process.env.PWDEBUG
        process.env.PWDEBUG = '1'
        try {
            const r = await api('POST', '/chrome/open', {})
            assert.deepEqual(r.json, { ok: false, error: 'unsupported environment: PWDEBUG', code: 'UNKNOWN', retry: 'never' })
            assert.equal(fake.calls.persistent.length, 0)
        }
        finally {
            if (had) process.env.PWDEBUG = old
            else delete process.env.PWDEBUG
        }
    })

    it('PW-04 真路徑：替身以 next() 交回 w-playwright 真啟動 headless shell 一次 → 開、頁面截圖（PNG）、關', async function() {
        const seen = []
        fake = installFake(async (dir, o, next) => {
            seen.push(o)
            // 只改 channel 與 headless：受管之 headless shell（不觸發 LogonUser；非真 Chrome）
            return next({ ...o, channel: undefined, headless: true })
        })
        const r = await api('POST', '/chrome/open', {})
        if (r.json.ok === false && /managed browser \(headless-shell\) is not installed/.test(String(r.json.error))) {
            this.skip() // 本機未安裝 w-playwright 所用之 headless shell（wpw.ensureChromium() 可安裝）；略過不算通過
        }
        assert.equal(r.json.ok, true, `open failed: ${r.json.error}`)
        assert.equal(r.json.state, 'open')
        assert.equal(fake.calls.persistent.length, 1)
        assertGuardArgs(seen[0].args)
        const s = await api('POST', '/chrome/screenshot')
        assert.equal(s.json.ok, true, `screenshot failed: ${s.json.error}`)
        assert.equal(s.json.format, 'png')
        const buf = Buffer.from(s.json.image, 'base64')
        assert.ok(buf.subarray(0, 8).equals(PNG_MAGIC), '截圖不是 PNG')
        const g = await api('GET', '/chrome')
        assert.equal(g.json.state, 'open')
        const d = await api('DELETE', '/chrome')
        assert.deepEqual(d.json, { ok: true, closed: true })
        const g2 = await api('GET', '/chrome')
        assert.equal(g2.json.state, 'closed')
    })

})
