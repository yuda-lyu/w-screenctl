// 接線測試：ChromeManager 之唯一啟動點經 w-playwright（規則帳本 PW-01、PW-02；w-playwright 帳本 R-PW-WIRING）
//
// 以 wpw.setBrowserTypeForTest 之替身取代 w-playwright 所呼叫之 BrowserType：替身收到的是 w-playwright「合併後」之選項，
// 本檔不啟動任何瀏覽器。替身只作用於本測試所引用之 w-playwright（與 src 同一份），故每案皆斷言替身確被呼叫（未呼叫即可能空過）。
// 環境前提：W_PLAYWRIGHT_LOGON_GUARD 開啟時（Windows），w-playwright 於呼叫替身前仍讀錯誤密碼次數（channel 'chrome' 非 headless shell），
// 次數 ≥1 時各案以 E_LOGON_GUARD 失敗——屬應停止之訊號，不放寬。
// 臨時檔：test/_tmp/unit-chromeLaunch/（after 刪除）

import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import wpw from 'w-playwright'
import ChromeManager from '../src/chromeManager.mjs'
import { classify } from '../src/util/errClassify.mjs'

const TMP = path.resolve('test/_tmp/unit-chromeLaunch')
const INFO = wpw.getPlaywrightInfo()
const PW_DEFAULTS = INFO.defaultDisableFeatures // Playwright 1.64.1 之預設停用清單（w-playwright 內附表）
const GUARD = INFO.guardFeatures // ['AutofillAiWalletPrivatePasses']

// 本套件固定加入之參數（src/chromeManager.mjs，除 --disable-features 外依原序）
const BASE_ARGS = ['--disable-dev-shm-usage', '--disable-infobars', '--test-type', '--hide-crash-restore-bubble', '--disable-notifications', '--lang=zh-TW']

function makeCtx() {
    let closed = false
    let cur = 'about:blank'
    const page = {
        url: () => cur,
        goto: async (u) => {
            cur = u
        },
    }
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

// 安裝替身：記錄每次呼叫；impl 未給時回傳替身 context
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

const isFeatSwitch = (a) => /^--?(disable|enable)-features(=|$)/i.test(a)

// 合併後 args 之守門斷言（spec：命令列恰一個 --disable-features，為最後一個元素，含 Playwright 預設＋守門＋本套件之 Translate）
function assertGuardArgs(args) {
    const sw = args.filter(isFeatSwitch)
    assert.equal(sw.length, 1, `功能開關須恰一個：${JSON.stringify(sw)}`)
    const last = args[args.length - 1]
    assert.equal(last, sw[0], '合併之 --disable-features 須為 args 最後一個元素')
    assert.match(last, /^--disable-features=/)
    const items = last.slice('--disable-features='.length).split(',')
    for (const f of [...PW_DEFAULTS, ...GUARD, 'Translate']) {
        assert.ok(items.includes(f), `--disable-features 缺 ${f}`)
    }
    return items
}

describe('unit-chromeLaunch：ChromeManager 之啟動經 w-playwright', function() {
    this.timeout(60000)

    let fake = null

    before(() => {
        fs.mkdirSync(TMP, { recursive: true })
    })

    afterEach(() => {
        if (fake) fake.restore()
        fake = null
    })

    after(() => {
        fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    })

    it('前提：w-playwright 內附表與實裝 playwright-core 一致，守門功能為 AutofillAiWalletPrivatePasses', () => {
        assert.equal(INFO.tableMatch, true)
        assert.ok(PW_DEFAULTS.length > 0)
        assert.deepEqual([...GUARD], ['AutofillAiWalletPrivatePasses'])
    })

    // 選項矩陣：opt × window × viewport；每格斷言替身收到之合併選項（spec：channel chrome、headless 依 opt、守門一串、其餘參數原序）
    const CASES = [
        { name: '預設（無 window、headless 預設 true）', open: {}, headless: true, extra: ['--start-maximized'], viewport: null },
        { name: 'headless:false＋window 位置與大小', open: { window: { x: 0, y: 0, width: 1280, height: 800 }, opt: { headless: false } }, headless: false, extra: ['--window-position=0,0', '--window-size=1280,800'], viewport: null },
        { name: 'window 只給位置', open: { window: { x: 10, y: 20 } }, headless: true, extra: ['--window-position=10,20'], viewport: null },
        { name: 'window 只給大小', open: { window: { width: 800, height: 600 } }, headless: true, extra: ['--window-size=800,600'], viewport: null },
        { name: 'disableSandbox＋disableGpu＋viewport＋deviceScaleFactor', open: { viewport: { width: 800, height: 600 }, opt: { disableGpu: true, disableSandbox: true, deviceScaleFactor: 1.5 } }, headless: true, extra: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1.5', '--start-maximized'], viewport: { width: 800, height: 600 }, dsf: 1.5 },
        { name: 'deviceScaleFactor 而無 viewport（只給命令列參數）', open: { opt: { deviceScaleFactor: 2 } }, headless: true, extra: ['--force-device-scale-factor=2', '--start-maximized'], viewport: null },
    ]

    CASES.forEach((c, i) => {
        it(`PW-01/02 ${c.name}：唯一啟動點經 wpw.launchChromiumPersistent，合併選項含守門`, async () => {
            fake = installFake()
            const m = new ChromeManager()
            const dir = path.join(TMP, `case${i}`)
            const r = await m.open({ ...c.open, userDataDir: dir })
            assert.equal(r.state, 'open')
            assert.equal(r.reused, false)
            // 經 w-playwright：替身之持久啟動恰 1 次、非持久啟動 0 次
            assert.equal(fake.calls.persistent.length, 1, '替身未被呼叫：啟動未經 w-playwright')
            assert.equal(fake.calls.launch, 0)
            const { dir: gotDir, o } = fake.calls.persistent[0]
            assert.equal(gotDir, path.resolve(dir))
            assert.equal(o.channel, 'chrome')
            assert.equal(o.headless, c.headless)
            assert.equal(o.locale, 'zh-TW')
            assert.deepEqual(o.viewport, c.viewport)
            if (c.dsf === undefined) assert.equal('deviceScaleFactor' in o, false)
            else assert.equal(o.deviceScaleFactor, c.dsf)
            assert.ok(Array.isArray(o.ignoreDefaultArgs) && o.ignoreDefaultArgs.includes('--enable-automation'), 'ignoreDefaultArgs 須保留 --enable-automation')
            assertGuardArgs(o.args)
            // 其餘參數依原序（--disable-features 以外）
            assert.deepEqual(o.args.slice(0, -1), [...BASE_ARGS, ...c.extra])
            assert.equal(m.isOpen(), true)
        })
    })

    it('PW-02 相對路徑之 userDataDir 以絕對路徑交給 w-playwright，資料夾即被建立', async () => {
        fake = installFake()
        const m = new ChromeManager()
        const rel = path.relative(process.cwd(), path.join(TMP, 'rel-profile'))
        assert.equal(path.isAbsolute(rel), false)
        await m.open({ userDataDir: rel })
        assert.equal(fake.calls.persistent.length, 1)
        assert.equal(fake.calls.persistent[0].dir, path.resolve(rel))
        assert.equal(fs.statSync(path.resolve(rel)).isDirectory(), true)
    })

    it('PW-02 絕對路徑之 userDataDir 原字串照交（不做字面正規化，同 Playwright 用戶端：含 `..`、斜線方向皆不改）', async () => {
        fake = installFake()
        const m = new ChromeManager()
        const abs = `${TMP.split(path.sep).join('/')}/abs-a/../abs-keep`
        assert.equal(path.isAbsolute(abs), true)
        assert.notEqual(path.resolve(abs), abs, '前提：字面正規化會改變此字串')
        await m.open({ userDataDir: abs })
        assert.equal(fake.calls.persistent.length, 1)
        assert.equal(fake.calls.persistent[0].dir, abs)
    })

    it('PW-02 交給 w-playwright 之選項（合併前）即含本套件自給之 --disable-features=Translate（不依賴 Playwright 預設清單是否含之）', async () => {
        fake = installFake()
        const seen = []
        const orig = wpw.launchChromiumPersistent
        wpw.launchChromiumPersistent = (d, o) => { // 只記錄、照常轉呼叫 w-playwright（測試端包裝，結束即還原）
            seen.push(o)
            return orig(d, o)
        }
        try {
            const m = new ChromeManager()
            await m.open({ userDataDir: path.join(TMP, 'pre-merge') })
        }
        finally {
            wpw.launchChromiumPersistent = orig
        }
        assert.equal(seen.length, 1)
        assert.ok(seen[0].args.includes('--disable-features=Translate'))
        assert.equal(fake.calls.persistent.length, 1, '包裝後仍須經 w-playwright')
    })

    it('PW-03 已 open 後才設 PWDEBUG：reuse 不需啟動故照常回應；mode=replace 先關舊 context，再啟動時 E_ENV', async () => {
        fake = installFake()
        const m = new ChromeManager()
        const dir = path.join(TMP, 'env-reuse')
        await m.open({ userDataDir: dir })
        const had = Object.prototype.hasOwnProperty.call(process.env, 'PWDEBUG')
        const old = process.env.PWDEBUG
        process.env.PWDEBUG = '1'
        try {
            const r = await m.open({ userDataDir: dir })
            assert.equal(r.reused, true)
            assert.equal(fake.calls.persistent.length, 1, 'reuse 不得啟動')
            await assert.rejects(() => m.open({ userDataDir: dir, mode: 'replace' }), (e) => e.code === 'E_ENV')
            assert.equal(fake.calls.persistent.length, 1, 'E_ENV 先於呼叫 BrowserType')
            assert.equal(fake.calls.ctxs[0].closeCalls, 1, 'replace 先關舊 context')
            assert.equal(m.isOpen(), false)
        }
        finally {
            if (had) process.env.PWDEBUG = old
            else delete process.env.PWDEBUG
        }
    })

    it('PW-01 已 open 之 reuse 不再啟動；mode=replace 先關舊 context 再經 w-playwright 啟動一次', async () => {
        fake = installFake()
        const m = new ChromeManager()
        const dir = path.join(TMP, 'reuse')
        await m.open({ userDataDir: dir })
        const r2 = await m.open({ userDataDir: dir, url: 'http://127.0.0.1:1/x' })
        assert.equal(r2.reused, true)
        assert.equal(fake.calls.persistent.length, 1, 'reuse 不得再啟動')
        const r3 = await m.open({ userDataDir: dir, mode: 'replace' })
        assert.equal(r3.reused, false)
        assert.equal(fake.calls.persistent.length, 2)
        assert.equal(fake.calls.ctxs[0].closeCalls, 1, 'replace 須先關舊 context')
        assertGuardArgs(fake.calls.persistent[1].o.args)
    })

    it('PW-03 啟動失敗：錯誤為 w-playwright 之固定詞彙（E_LAUNCH），不含 Playwright 原訊息；lastError 同；分類 UNKNOWN／never', async () => {
        fake = installFake(async () => {
            throw new Error('browserType.launchPersistentContext: secret-detail C:/somewhere/chrome.exe')
        })
        const m = new ChromeManager()
        let err = null
        try {
            await m.open({ userDataDir: path.join(TMP, 'fail') })
        }
        catch (e) {
            err = e
        }
        assert.ok(err, 'open 應失敗')
        assert.equal(fake.calls.persistent.length, 1)
        assert.equal(err.code, 'E_LAUNCH')
        assert.equal(err.message, 'browser launch failed')
        assert.equal(m.lastError, 'browser launch failed')
        assert.equal(m.isOpen(), false)
        assert.deepEqual(m.snapshot(), { state: 'closed', lastError: 'browser launch failed' })
        assert.deepEqual(classify(err), { retry: 'never', code: 'UNKNOWN' })
        // 失敗後佇列不卡：下一次 open 照常經 w-playwright
        fake.restore()
        fake = installFake()
        const r = await m.open({ userDataDir: path.join(TMP, 'fail') })
        assert.equal(r.state, 'open')
        assert.equal(fake.calls.persistent.length, 1)
    })

    it('PW-03 Playwright 逾時（TimeoutError）→ E_LAUNCH_TIMEOUT「browser launch timed out」，分類 TIMEOUT／after_1s（與遷移前之逾時分類相同）', async () => {
        fake = installFake(async () => {
            const e = new Error('Timeout 180000ms exceeded.')
            e.name = 'TimeoutError'
            throw e
        })
        const m = new ChromeManager()
        await assert.rejects(() => m.open({ userDataDir: path.join(TMP, 'tmo') }), (e) => {
            assert.equal(e.code, 'E_LAUNCH_TIMEOUT')
            assert.equal(e.message, 'browser launch timed out')
            assert.deepEqual(classify(e), { retry: 'after_1s', code: 'TIMEOUT' })
            return true
        })
        assert.equal(m.lastError, 'browser launch timed out')
    })

    for (const [k, v] of [['PWDEBUG', '1'], ['SELENIUM_REMOTE_URL', 'http://127.0.0.1:1/wd/hub']]) {
        it(`PW-03 不支援之環境變數 ${k} → E_ENV，替身 0 次（不啟動）`, async () => {
            fake = installFake()
            const had = Object.prototype.hasOwnProperty.call(process.env, k)
            const old = process.env[k]
            process.env[k] = v
            try {
                const m = new ChromeManager()
                await assert.rejects(() => m.open({ userDataDir: path.join(TMP, `env-${k}`) }), (e) => {
                    assert.equal(e.code, 'E_ENV')
                    assert.equal(e.message, `unsupported environment: ${k}`)
                    return true
                })
                assert.equal(fake.calls.persistent.length, 0)
                assert.equal(m.lastError, `unsupported environment: ${k}`)
            }
            finally {
                if (had) process.env[k] = old
                else delete process.env[k]
            }
        })
    }

})
