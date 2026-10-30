// api：操作紀錄（audit log）與系統級開關
//
// 直打真實 Hapi server（真 port、真 HTTP）。系統級後端與 Chrome 以替身注入（opt.backend、opt.chromeManager），
// 因此不會操作真實桌面、也不會啟動 Chrome。紀錄檔一律寫在 test/_tmp/api-audit/（HOME／USERPROFILE 亦指到該處），
// 絕不寫入真實使用者目錄。每條斷言之 Axx 對應 sgud/rule/rulebook.md 之 AUD-xx 規則。
//
// 同步方式（計時器相關測試規範，sgud/rule/rulebook.md〈TM-01〉）：不 sleep、不輪詢紀錄檔。
// 紀錄於 Hapi 'response' 事件由稽核寫入器同步 append；tapResponses 掛在其後的監聽器被呼叫時，該請求之紀錄「已寫入或確定不會寫入」，
// 所以每個請求以 tap.request() 送出（等到伺服器端 response 事件才返回），之後立刻讀紀錄檔即是最終狀態；
// 「不該有紀錄」「不該多一筆」由事件序判定，不需要觀察窗。看門狗上限（真實計時器）只防事件永不來。

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mock } from 'node:test'
import { fileURLToPath } from 'node:url'
import { rawRequest } from './tools/rawHttp.mjs'
import { makeHarness } from './tools/apiHarness.mjs'
import { tapResponses, deferred, guard } from './tools/respTap.mjs'

const fdTest = path.dirname(fileURLToPath(import.meta.url))
const fdTmp = path.join(fdTest, '_tmp', 'api-audit')
const fdHome = path.join(fdTmp, 'home')

const TOKEN = 'audit-token-0123456789abcdef-XYZ'
const WRONG = 'wrong-token-0123456789abcdef-XY'
const EVIL = 'https://evil.example'
const SECRET_TEXT = 'P@ssw0rd-秘密-LEAK-TEXT'
const SECRET_SCRIPT = 'document.cookie + "LEAK-SCRIPT"'
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')

// 本檔使用之 port（>= 8000，固定不隨機）
const P_ALL = 8741
const P_DENY = 8742
const P_ENV = 8743
const P_ROT = 8744
const P_FAIL = 8745
const P_OFF = 8746
const P_HOME = 8747
const P_PAR = 8748

const auth = (t = TOKEN) => ({ authorization: `Bearer ${t}` })

const H = makeHarness({ defaults: () => ({ token: TOKEN, auditLogFile: path.join(fdTmp, 'audit-fallback.jsonl') }) })

function makeBackend(calls) {
    const rec = (name) => async (...a) => {
        calls.push([name, ...a])
    }
    return {
        screenshot: async (region) => {
            calls.push(['screenshot', region])
            return 'QUFB'
        },
        mouseClick: rec('mouseClick'),
        mouseDblClick: rec('mouseDblClick'),
        mouseDrag: rec('mouseDrag'),
        mouseScroll: rec('mouseScroll'),
        keyboardKey: rec('keyboardKey'),
        keyboardType: rec('keyboardType'),
        getMemoryInfo: async () => null,
    }
}

// ChromeManager 替身：不啟動 Chrome
function makeChrome(calls, state = { open: true }) {
    const page = {
        goto: async (u) => {
            calls.push(['goto', u])
        },
        url: () => 'https://example.com/after',
        evaluate: async (s) => {
            calls.push(['evaluate', s])
            return 42
        },
        screenshot: async () => Buffer.from('PNGDATA'),
        mouse: {
            click: async (...a) => {
                calls.push(['mouse.click', ...a])
            },
            dblclick: async (...a) => {
                calls.push(['mouse.dblclick', ...a])
            },
            move: async (...a) => {
                calls.push(['mouse.move', ...a])
            },
            down: async (...a) => {
                calls.push(['mouse.down', ...a])
            },
            up: async (...a) => {
                calls.push(['mouse.up', ...a])
            },
            wheel: async (...a) => {
                calls.push(['mouse.wheel', ...a])
            },
        },
        keyboard: {
            press: async (k) => {
                calls.push(['press', k])
            },
            type: async (t) => {
                calls.push(['type', t])
            },
        },
    }
    return {
        isOpen: () => state.open,
        snapshot: () => (state.open ? { state: 'open', url: 'https://example.com/', createdAt: 't' } : { state: 'closed' }),
        withPage: async (fn) => {
            if (!state.open) {
                const e = new Error('chrome closed')
                e.chromeState = 'closed'
                throw e
            }
            return fn({ page })
        },
        open: async (a) => {
            calls.push(['open', a])
            state.open = true
            return { state: 'open', url: a.url || 'about:blank', reused: false, gotoOk: true, gotoError: null }
        },
        close: async () => {
            const was = state.open
            state.open = false
            return was ? { closed: true } : { closed: false, reason: 'closed' }
        },
        shutdown: async () => ({ shutdown: true }),
    }
}

const readLines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter((x) => x !== '') : [])
const readEntries = (f) => readLines(f).map((x) => JSON.parse(x))

describe('api-audit：操作紀錄與系統級開關', function() {
    this.timeout(60000)

    before(() => {
        H.clearEnv()
        fs.rmSync(fdTmp, { recursive: true, force: true })
        fs.mkdirSync(fdHome, { recursive: true })
        H.useFakeHome(fdHome)
        // 防線：確認家目錄確實已指到測試夾，否則整個檔案不跑（避免寫入真實使用者目錄）
        assert.equal(path.resolve(os.homedir()), path.resolve(fdHome), 'os.homedir() 未指到測試夾')
        process.setMaxListeners(100)
    })

    after(async () => {
        await H.stopAll()
        H.restoreHome()
        H.restoreEnv()
        fs.rmSync(fdTmp, { recursive: true, force: true })
    })

    // ───────────────────────────────────────────────────────────
    describe('各類控制動作各一筆紀錄，欄位正確', () => {
        const f = path.join(fdTmp, 'all.jsonl')
        const bCalls = []
        const cCalls = []
        let t0

        const CASES = [
            ['POST', '/mouse/click', { x: 10, y: 20, button: 3 }, { x: 10, y: 20, button: 3 }],
            ['POST', '/mouse/dblclick', { x: 1, y: 2 }, { x: 1, y: 2 }],
            ['POST', '/mouse/drag', { fromX: 1, fromY: 2, toX: 3, toY: 4 }, { fromX: 1, fromY: 2, toX: 3, toY: 4, button: 1 }],
            ['POST', '/mouse/scroll', { x: 5, y: 6, direction: 'down' }, { x: 5, y: 6, direction: 'down', amount: 3 }],
            ['POST', '/keyboard/key', { keys: 'Enter' }, { keys: 'Enter' }],
            ['POST', '/keyboard/key', { keys: 'p' }, { keys: '<char>' }],
            ['POST', '/keyboard/key', { keys: 'ctrl+a' }, { keys: 'ctrl+a' }],
            ['POST', '/keyboard/key', { keys: 'hunter2' }, { keys: '<key>' }],
            ['POST', '/keyboard/type', { text: SECRET_TEXT }, { textLen: SECRET_TEXT.length }],
            ['POST', '/screenshot', { region: { x: 1, y: 2, width: 3, height: 4 } }, { region: { x: 1, y: 2, width: 3, height: 4 } }],
            ['POST', '/screenshot', {}, {}],
            ['POST', '/chrome/open', { url: 'https://u:pw@example.com/a/b?secret=abc#frag', mode: 'reuse', userData: 'C:/someone/profile', opt: { headless: true, disableGpu: true } },
                { url: 'https://example.com/a/b', mode: 'reuse', userData: true, opt: { headless: true, disableGpu: true, disableSandbox: false } }],
            ['POST', '/chrome/navigate', { url: 'https://example.com/n?token=zzz' }, { url: 'https://example.com/n' }],
            ['POST', '/chrome/navigate', { url: 'about://alice:ABOUT_PASSWORD@example.com/page?query=SECRET_QUERY#SECRET_FRAGMENT' }, { url: 'about://example.com/page' }],
            ['POST', '/chrome/evaluate', { script: SECRET_SCRIPT }, { scriptLen: SECRET_SCRIPT.length, scriptSha256: sha(SECRET_SCRIPT) }],
            ['POST', '/chrome/screenshot', undefined, {}],
            ['GET', '/chrome', undefined, {}],
            ['POST', '/chrome/mouse/click', { x: 1, y: 2 }, { x: 1, y: 2, button: 1 }],
            ['POST', '/chrome/mouse/dblclick', { x: 3, y: 4 }, { x: 3, y: 4 }],
            ['POST', '/chrome/mouse/drag', { fromX: 1, fromY: 2, toX: 3, toY: 4 }, { fromX: 1, fromY: 2, toX: 3, toY: 4, button: 1 }],
            ['POST', '/chrome/mouse/scroll', { x: 7, y: 8, direction: 'left', amount: 2 }, { x: 7, y: 8, direction: 'left', amount: 2 }],
            ['POST', '/chrome/keyboard/key', { keys: 'Escape' }, { keys: 'Escape' }],
            ['POST', '/chrome/keyboard/type', { text: SECRET_TEXT }, { textLen: SECRET_TEXT.length }],
            ['DELETE', '/chrome', undefined, {}],
        ]

        let srv
        let tap
        before(async () => {
            srv = await H.start({ port: P_ALL, enableEvaluate: true, auditLogFile: f, backend: makeBackend(bCalls), chromeManager: makeChrome(cCalls) })
            tap = tapResponses(srv)
            t0 = Date.now() - 1000
        })

        it('A01 路由表（server.table）= 本表案例 + GET /health，且參數摘要登錄表與路由表一致（新增路由未登錄會在此失敗）', async () => {
            const { AUDIT_ROUTE_KEYS } = await import('../src/auditLog.mjs') // 動態載入：模組缺席時只有本條失敗，其餘仍就行為判紅綠
            const table = srv.table().map((r) => `${r.method.toUpperCase()} ${r.path}`).sort()
            const cases = [...new Set(CASES.map(([m, p]) => `${m} ${p}`))].concat(['GET /health']).sort()
            assert.deepEqual(table, cases)
            assert.deepEqual([...AUDIT_ROUTE_KEYS].sort(), table)
        })

        it('A01 全部 19 條控制路由（系統級 7、Chrome 12；共 24 次呼叫，含同路由之不同參數）各產生恰一筆；欄位集合、型別與參數摘要皆正確', async () => {
            let n = 0
            for (const [method, p, body, params] of CASES) {
                const r = await tap.request({ port: P_ALL, method, path: p, body, headers: auth() })
                assert.equal(r.status, 200, `${method} ${p}`)
                n++
                const all = readEntries(f)
                assert.equal(all.length, n, `${method} ${p} 應只新增一筆`)
                const e = all[n - 1]
                assert.equal(e.method, method)
                assert.equal(e.path, p)
                assert.equal(e.ip, '127.0.0.1')
                assert.equal(e.status, 200)
                assert.equal(e.ok, true, `${method} ${p} ok（含 GET /chrome：回應本體無 ok 欄位，以 HTTP 狀態推導）`)
                assert.equal(new Date(e.ts).toISOString(), e.ts, 'ts 須為 ISO')
                assert.ok(Date.parse(e.ts) >= t0 && Date.parse(e.ts) <= Date.now() + 1000, `ts 範圍 ${e.ts}`)
                assert.ok(Number.isFinite(e.ms) && e.ms >= 0, `ms=${e.ms}`) // ms 之數值語意由「耗時（ms）」案以假時鐘驗；此處不設牆鐘上限（負載下會誤報）
                assert.equal(e.denied, undefined)
                assert.deepEqual(e.params, params, `${method} ${p} params`)
                assert.deepEqual(Object.keys(e).sort(), ['ip', 'method', 'ms', 'ok', 'params', 'path', 'status', 'ts'], `${method} ${p} 不得有多餘欄位`)
            }
            assert.equal(tap.seen, CASES.length)
            assert.equal(readLines(f).length, CASES.length) // 每個請求之 response 事件都已過；若有重複寫入，此刻必已出現
            assert.equal(new Set(CASES.map(([m, p]) => `${m} ${p}`)).size, 19, '應涵蓋全部 19 條控制路由')
        })

        it('A01 動作確實有被執行（紀錄不是取代執行），且紀錄摘要與實際執行值一致（檢查之值即使用之值）', () => {
            assert.deepEqual(bCalls.map((x) => x[0]), ['mouseClick', 'mouseDblClick', 'mouseDrag', 'mouseScroll', 'keyboardKey', 'keyboardKey', 'keyboardKey', 'keyboardKey', 'keyboardType', 'screenshot', 'screenshot'])
            // 系統級：座標與按鍵為實際送進後端之值（Enter 經 normalizeKey 成 Return；紀錄記請求原值 Enter，二者為同一個鍵）
            assert.deepEqual(bCalls[0], ['mouseClick', 10, 20, 3])
            assert.deepEqual(bCalls[2], ['mouseDrag', 1, 2, 3, 4, 1])
            assert.deepEqual(bCalls[3], ['mouseScroll', 5, 6, 'down', 3])
            assert.deepEqual(bCalls.filter((x) => x[0] === 'keyboardKey').map((x) => x[1]), ['Return', 'p', 'ctrl+a', 'hunter2'])
            assert.deepEqual(bCalls.find((x) => x[0] === 'keyboardType'), ['keyboardType', SECRET_TEXT])
            // Chrome 頁面級：實際送進頁面之值
            const chromeOnly = (name) => cCalls.filter((x) => x[0] === name)
            assert.deepEqual(chromeOnly('open')[0][1].userDataDir.endsWith('profile'), true)
            assert.deepEqual(chromeOnly('goto').map((x) => x[1]), ['https://example.com/n?token=zzz', 'about://alice:ABOUT_PASSWORD@example.com/page?query=SECRET_QUERY#SECRET_FRAGMENT'])
            assert.deepEqual(chromeOnly('evaluate'), [['evaluate', SECRET_SCRIPT]])
            assert.deepEqual(chromeOnly('mouse.click'), [['mouse.click', 1, 2, { button: 'left' }]])
            assert.deepEqual(chromeOnly('mouse.dblclick'), [['mouse.dblclick', 3, 4]])
            assert.deepEqual(chromeOnly('mouse.wheel'), [['mouse.wheel', -200, 0]])
            assert.deepEqual(chromeOnly('press'), [['press', 'Escape']])
            assert.deepEqual(chromeOnly('type'), [['type', SECRET_TEXT]])
        })

        it('A02 紀錄檔不含：token、type 文字、evaluate script 全文、URL 查詢字串／片段／帳密（含 about:// 寫法）、userData 路徑、Authorization、非鍵名字串', () => {
            const text = fs.readFileSync(f, 'utf8')
            for (const bad of [TOKEN, 'Bearer', 'authorization', 'P@ssw0rd', '秘密', 'LEAK-TEXT', 'LEAK-SCRIPT', 'document.cookie', 'secret=abc', 'token=zzz', 'frag', 'pw@', 'someone', 'u:pw', 'ABOUT_PASSWORD', 'SECRET_QUERY', 'SECRET_FRAGMENT', 'alice', 'hunter2']) {
                assert.ok(!text.includes(bad), `紀錄檔洩漏 ${bad}`)
            }
        })

        it('A01 不記：GET /health（公開）、未註冊路徑 404、預檢成功之外的無關請求；HEAD 以 HEAD 記', async () => {
            const before = readLines(f).length
            assert.equal((await tap.request({ port: P_ALL, path: '/health' })).status, 200)
            assert.equal((await tap.request({ port: P_ALL, path: '/no/such/route', headers: auth() })).status, 404)
            assert.equal(readLines(f).length, before, '/health 與 404 不應產生紀錄') // 兩者之 response 事件皆已過（稽核監聽器先於 tap 執行）：判定不寫，不需觀察窗
            assert.equal((await tap.request({ port: P_ALL, method: 'HEAD', path: '/chrome', headers: auth() })).status, 200)
            const all = readEntries(f)
            assert.equal(all.length, before + 1)
            assert.equal(all[before].method, 'HEAD')
            assert.equal(all[before].path, '/chrome')
        })

        it('A01 驗證失敗（400）：記 status／code，但不記任何 payload 內容', async () => {
            const before = readLines(f).length
            const r = await tap.request({ port: P_ALL, method: 'POST', path: '/chrome/navigate', body: { url: 'https://example.com/x', zzz: 'LEAK-VALIDATION' }, headers: auth() })
            assert.equal(r.status, 400)
            const all = readEntries(f)
            assert.equal(all.length, before + 1, '驗證失敗應恰一筆')
            const e = all[before]
            assert.equal(e.status, 400)
            assert.equal(e.ok, false)
            assert.equal(e.code, 'VALIDATION')
            assert.equal(e.params, undefined)
            assert.ok(!JSON.stringify(e).includes('LEAK-VALIDATION'))
        })

        it('A01 來源 IP 取 socket 位址：偽造的 X-Forwarded-For／X-Real-IP／Forwarded 不影響紀錄', async () => {
            const before = readLines(f).length
            const r = await tap.request({ port: P_ALL, method: 'POST', path: '/mouse/click', body: { x: 1, y: 2 }, headers: { ...auth(), 'x-forwarded-for': '6.6.6.6', 'x-real-ip': '7.7.7.7', 'forwarded': 'for=8.8.8.8' } })
            assert.equal(r.status, 200)
            const all = readEntries(f)
            assert.equal(all.length, before + 1)
            assert.equal(all[before].ip, '127.0.0.1')
            assert.ok(!JSON.stringify(all[before]).includes('6.6.6.6'))
        })

        it('A01 公開路由：HEAD /health 成功不記；被拒絕之 HEAD（無 token）記為 HEAD', async () => {
            const before = readLines(f).length
            assert.equal((await tap.request({ port: P_ALL, method: 'HEAD', path: '/health' })).status, 200)
            assert.equal(readLines(f).length, before)
            assert.equal((await tap.request({ port: P_ALL, method: 'HEAD', path: '/chrome' })).status, 401)
            const all = readEntries(f)
            assert.equal(all.length, before + 1)
            assert.equal(all[before].method, 'HEAD')
            assert.equal(all[before].denied, 'UNAUTHORIZED')
        })

        it('A01 耗時（ms）反映實際處理時間：handler 歷時 250 ms（假時鐘）→ 紀錄之 ms 恰為 250', async () => {
            // 時間本身是規格：以 node:test 的 mock.timers 只假造 Date，handler 以閘門停住，測試端把虛擬時間推進 250 ms 後才放行；
            // 因此 ms 為確定值，不受負載影響（舊作法：真實 sleep(250) 後斷言 200 <= ms < 3000，上界在重度阻塞下會誤報）
            const f2 = path.join(fdTmp, 'slow.jsonl')
            const started = deferred()
            const gate = deferred()
            const slow = {
                ...makeBackend([]),
                mouseDblClick: async () => {
                    started.resolve()
                    await gate.promise
                }
            }
            const s = await H.start({ port: P_PAR + 101, auditLogFile: f2, backend: slow, chromeManager: makeChrome([]) })
            const tap2 = tapResponses(s)
            mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00.000Z') })
            try {
                const pending = tap2.request({ port: P_PAR + 101, method: 'POST', path: '/mouse/dblclick', body: { x: 1, y: 2 }, headers: auth() })
                await guard(started.promise, 'handler 未啟動')
                mock.timers.tick(250)
                gate.resolve()
                const r = await pending
                assert.equal(r.status, 200)
            }
            finally {
                mock.timers.reset()
            }
            const all = readEntries(f2)
            assert.equal(all.length, 1)
            assert.equal(all[0].ms, 250, `ms=${all[0].ms}`)
            assert.equal(all[0].ts, '2026-01-01T00:00:00.000Z', 'ts 為請求到達時刻（假時鐘起點）')
            await H.stop(s)
        })

        it('A01 handler 丟例外（後端、open、close 失敗）：HTTP 200 + ok:false，各記恰一筆（ok:false、code 為穩定代碼），仍記參數摘要', async () => {
            const f2 = path.join(fdTmp, 'throws.jsonl')
            const boom = () => {
                throw new Error('boom: secret internal detail')
            }
            const chrome = { ...makeChrome([]), open: async () => boom(), close: async () => boom() }
            const backend = { ...makeBackend([]), mouseClick: async () => boom() }
            const s = await H.start({ port: P_PAR + 102, auditLogFile: f2, backend, chromeManager: chrome })
            const tap2 = tapResponses(s)
            const calls = [['POST', '/mouse/click', { x: 3, y: 4 }], ['POST', '/chrome/open', { url: 'https://example.com/z?k=v' }], ['DELETE', '/chrome', undefined]]
            for (const [m, p, body] of calls) {
                const r = await tap2.request({ port: P_PAR + 102, method: m, path: p, body, headers: auth() })
                assert.equal(r.status, 200)
                assert.equal(r.json.ok, false, p)
            }
            const all = readEntries(f2)
            assert.equal(all.length, 3, '各記恰一筆')
            for (const e of all) {
                assert.equal(e.status, 200)
                assert.equal(e.ok, false)
                assert.equal(e.code, 'UNKNOWN')
                assert.ok(!JSON.stringify(e).includes('secret internal detail'), '不記錯誤訊息全文')
            }
            assert.deepEqual(all[0].params, { x: 3, y: 4, button: 1 })
            assert.deepEqual(all[1].params, { url: 'https://example.com/z', opt: {} })
            await H.stop(s)
        })

        it('A01 客戶端在處理中途斷線：動作照常執行並仍記恰一筆（status 為數字）', async () => {
            // 以事件閘門決定順序（舊作法：handler sleep(300)、客戶端 80 ms 後斷線、再 sleep(900)，負載下順序會顛倒而悄悄退化成一般請求）：
            // handler 啟動(started) → 客戶端斷線 → 伺服器端該連線之 socket 已 close（實測：Hapi 對「請求本體已收完」之斷線不發事件，
            // 要等 handler 完成才發 response 事件，故斷線與否改由 socket close 界定）→ 放行 handler → handler 完成(done)
            // → 該請求之 response 事件（稽核於此寫入）→ 再送一個屏障請求（其處理需要經過事件迴圈，若有重複寫入此時必已出現）→ 才斷言
            const f2 = path.join(fdTmp, 'abort.jsonl')
            const calls = []
            const started = deferred()
            const gate = deferred()
            const done = deferred()
            const closed = deferred()
            const slow = {
                ...makeBackend(calls),
                mouseClick: async (...a) => {
                    started.resolve()
                    await gate.promise
                    calls.push(['mouseClick', ...a])
                    done.resolve()
                }
            }
            const s = await H.start({ port: P_PAR + 103, auditLogFile: f2, backend: slow, chromeManager: makeChrome([]) })
            const tap2 = tapResponses(s)
            s.listener.once('connection', (socket) => socket.once('close', () => closed.resolve())) // 此時尚無其他連線；第一條連線即斷線者
            const req = http.request({ host: '127.0.0.1', port: P_PAR + 103, method: 'POST', path: '/mouse/click', headers: { ...auth(), 'content-type': 'application/json' } })
            req.on('error', () => {}) // 自行斷線之 ECONNRESET
            req.write(JSON.stringify({ x: 9, y: 9 }))
            req.end()
            tap2.expect(1)
            await guard(started.promise, 'handler 未啟動')
            req.destroy() // 客戶端在處理中途斷線
            await guard(closed.promise, '伺服器端未見連線關閉')
            assert.deepEqual(calls, [], '本案要求「處理中途」斷線：伺服器端見到斷線時 handler 尚未完成')
            gate.resolve()
            await guard(done.promise, 'handler 未完成')
            await tap2.waitSeen(1, '斷線之請求完成後應發出 response 事件')
            const barrier = await tap2.request({ port: P_PAR + 103, path: '/chrome', headers: auth() })
            assert.equal(barrier.status, 200)
            assert.deepEqual(calls, [['mouseClick', 9, 9, 1]], '動作應照常完成')
            const all = readEntries(f2)
            assert.equal(all.length, 2, `斷線之請求應恰一筆（另加屏障請求一筆）：${JSON.stringify(all)}`)
            assert.equal(all[0].path, '/mouse/click')
            assert.equal(typeof all[0].status, 'number')
            assert.equal(all[0].ip, '127.0.0.1', '斷線後 socket 位址不可得，須取請求一開始記下之位址（實測：未處理時 ip 為空字串）')
            assert.equal(all[1].path, '/chrome')
            await H.stop(s)
        })

        it('A01 handler 失敗（Chrome 未開，HTTP 200、ok:false）：記 ok:false 與 code，仍記參數摘要', async () => {
            const f2 = path.join(fdTmp, 'closed.jsonl')
            const s = await H.start({ port: P_PAR, auditLogFile: f2, enableEvaluate: true, backend: makeBackend([]), chromeManager: makeChrome([], { open: false }) })
            const tap2 = tapResponses(s)
            const r = await tap2.request({ port: P_PAR, method: 'POST', path: '/chrome/evaluate', body: { script: SECRET_SCRIPT }, headers: auth() })
            assert.equal(r.json.code, 'CHROME_NOT_OPEN')
            const all = readEntries(f2)
            assert.equal(all.length, 1, 'handler 失敗應恰一筆')
            const [e] = all
            assert.equal(e.status, 200)
            assert.equal(e.ok, false)
            assert.equal(e.code, 'CHROME_NOT_OPEN')
            assert.deepEqual(e.params, { scriptLen: SECRET_SCRIPT.length, scriptSha256: sha(SECRET_SCRIPT) })
            await H.stop(s)
        })

        it('A01 並行 40 個請求：每筆一行、皆為合法 JSON、不交錯', async () => {
            const f3 = path.join(fdTmp, 'par.jsonl')
            const s = await H.start({ port: P_PAR + 100, auditLogFile: f3, backend: makeBackend([]), chromeManager: makeChrome([]) })
            const tap2 = tapResponses(s)
            await Promise.all(Array.from({ length: 40 }, (_, i) => tap2.request({ port: P_PAR + 100, method: 'POST', path: '/mouse/click', body: { x: i, y: i }, headers: auth() })))
            assert.equal(tap2.seen, 40)
            const all = readEntries(f3) // 40 個請求之 response 事件皆已過；以 JSON.parse 逐行解析本身即驗證「不交錯」
            assert.equal(all.length, 40)
            assert.deepEqual(all.map((e) => e.params.x).sort((a, b) => a - b), Array.from({ length: 40 }, (_, i) => i))
            await H.stop(s)
        })

        it('A01 收尾：本區塊對同一伺服器之全部請求，紀錄總數 = 請求數 − 3 個不記的請求（/health、404、HEAD /health），無遲發之重複寫入', () => {
            // 事件序只能界定「response 事件當下」的狀態；本案補一道總量守恆：以整段測試經過的時間為觀察區間（非 sleep），
            // 若有計時器遲發之重複寫入，先前請求的重複紀錄此刻必已落檔，總數即對不上
            assert.equal(readLines(f).length, tap.seen - 3, `請求 ${tap.seen} 個，其中 3 個（GET /health、GET 404、HEAD /health）不記`)
        })
    })

    // ───────────────────────────────────────────────────────────
    describe('拒絕事件', () => {
        const f = path.join(fdTmp, 'deny.jsonl')
        const bCalls = []
        const SYS = [
            ['/mouse/click', { x: 1, y: 2 }],
            ['/mouse/dblclick', { x: 1, y: 2 }],
            ['/mouse/drag', { fromX: 1, fromY: 2, toX: 3, toY: 4 }],
            ['/mouse/scroll', { x: 1, y: 2, direction: 'down' }],
            ['/keyboard/key', { keys: 'Enter' }],
            ['/keyboard/type', { text: 'LEAKME-BODY' }],
            ['/screenshot', {}],
        ]
        let banner
        let tap

        // 本區塊所有請求都經 tap（等到伺服器端 response 事件才返回），故以此遮蔽匯入之 rawRequest：之後讀紀錄檔即為最終狀態
        const rawRequest = (o) => tap.request(o)

        before(async () => {
            const { r: srv, out } = await H.captureConsole(() => H.start({ port: P_DENY, enableSystem: false, auditLogFile: f, backend: makeBackend(bCalls), chromeManager: makeChrome([]) }))
            banner = out
            tap = tapResponses(srv)
        })

        // 第 n 筆紀錄；呼叫時（前 n 個請求之 response 事件皆已過）檔案應恰有 n 行
        const last = async (n) => {
            const all = readEntries(f)
            assert.equal(all.length, n, `${f} 應恰有 ${n} 行`)
            return all[n - 1]
        }

        it('A03 401：無 token、錯 token → 記 denied=UNAUTHORIZED、來源 IP、端點；不記 token', async () => {
            const a = await rawRequest({ port: P_DENY, path: '/chrome' })
            assert.equal(a.status, 401)
            const e1 = await last(1)
            assert.deepEqual({ method: e1.method, path: e1.path, ip: e1.ip, status: e1.status, denied: e1.denied }, { method: 'GET', path: '/chrome', ip: '127.0.0.1', status: 401, denied: 'UNAUTHORIZED' })
            assert.equal(e1.params, undefined)
            const b = await rawRequest({ port: P_DENY, method: 'POST', path: '/mouse/click', body: { x: 1, y: 2 }, headers: auth(WRONG) })
            assert.equal(b.status, 401)
            const e2 = await last(2)
            assert.equal(e2.denied, 'UNAUTHORIZED')
            assert.equal(e2.path, '/mouse/click')
            assert.ok(!fs.readFileSync(f, 'utf8').includes(WRONG))
        })

        it('A03 403 Origin：帶外站 Origin（含 /health、含請求本體）→ denied=FORBIDDEN_ORIGIN，並記該 Origin（截斷）；不記本體', async () => {
            const r = await rawRequest({ port: P_DENY, method: 'POST', path: '/keyboard/type', body: { text: 'LEAKME-BODY' }, headers: { ...auth(), origin: EVIL } })
            assert.equal(r.status, 403)
            const e = await last(3)
            assert.equal(e.denied, 'FORBIDDEN_ORIGIN')
            assert.equal(e.origin, EVIL)
            assert.equal(e.status, 403)
            assert.equal(e.params, undefined)
            const h = await rawRequest({ port: P_DENY, path: '/health', headers: { origin: EVIL } })
            assert.equal(h.status, 403)
            const e2 = await last(4)
            assert.equal(e2.path, '/health')
            assert.equal(e2.denied, 'FORBIDDEN_ORIGIN')
            const pre = await rawRequest({ port: P_DENY, method: 'OPTIONS', path: '/chrome/open', headers: { 'origin': EVIL, 'access-control-request-method': 'POST' } })
            assert.equal(pre.status, 403)
            const e3 = await last(5)
            assert.equal(e3.method, 'OPTIONS')
            assert.equal(e3.denied, 'FORBIDDEN_ORIGIN')
        })

        it('A03 403 Host：非本機 Host（含未註冊路徑）→ denied=FORBIDDEN_HOST，並記該 Host', async () => {
            const r = await rawRequest({ port: P_DENY, path: '/chrome', headers: { ...auth(), host: 'evil.example' } })
            assert.equal(r.status, 403)
            const e = await last(6)
            assert.equal(e.denied, 'FORBIDDEN_HOST')
            assert.equal(e.host, 'evil.example')
            const u = await rawRequest({ port: P_DENY, path: '/no/such/route', headers: { host: 'evil.example' } })
            assert.equal(u.status, 403)
            const e2 = await last(7)
            assert.equal(e2.path, '/no/such/route')
            assert.equal(e2.denied, 'FORBIDDEN_HOST')
        })

        it('A03 403 EVALUATE_DISABLED：evaluate 未開 → 記 denied；script 全文不入檔', async () => {
            const r = await rawRequest({ port: P_DENY, method: 'POST', path: '/chrome/evaluate', body: { script: 'LEAKME-SCRIPT' }, headers: auth() })
            assert.equal(r.status, 403)
            assert.equal(r.json.code, 'EVALUATE_DISABLED')
            const e = await last(8)
            assert.equal(e.denied, 'EVALUATE_DISABLED')
            assert.equal(e.path, '/chrome/evaluate')
            assert.equal(e.params, undefined)
        })

        it('A05 系統級關閉：7 條系統級端點（合法 payload + 正確 token）皆 403 SYSTEM_DISABLED 並各記一筆；後端零呼叫', async () => {
            let n = 8
            for (const [p, body] of SYS) {
                const r = await rawRequest({ port: P_DENY, method: 'POST', path: p, body, headers: auth() })
                assert.equal(r.status, 403, p)
                assert.equal(r.json.ok, false)
                assert.equal(r.json.code, 'SYSTEM_DISABLED', p)
                n++
                const e = await last(n)
                assert.equal(e.path, p)
                assert.equal(e.status, 403)
                assert.equal(e.denied, 'SYSTEM_DISABLED')
                assert.equal(e.ip, '127.0.0.1')
                assert.equal(e.params, undefined)
            }
            assert.deepEqual(bCalls, [])
        })

        it('A05 系統級關閉不蓋過 token 驗證（無 token 仍 401）；Chrome 頁面級端點與 /health 不受影響', async () => {
            const a = await rawRequest({ port: P_DENY, method: 'POST', path: '/mouse/click', body: { x: 1, y: 2 } })
            assert.equal(a.status, 401)
            const c = await rawRequest({ port: P_DENY, method: 'POST', path: '/chrome/mouse/click', body: { x: 1, y: 2 }, headers: auth() })
            assert.equal(c.status, 200)
            assert.equal(c.json.ok, true)
            const h = await rawRequest({ port: P_DENY, path: '/health' })
            assert.equal(h.status, 200)
        })

        it('A03 全部拒絕紀錄不含 token、錯 token、請求本體文字', () => {
            const text = fs.readFileSync(f, 'utf8')
            for (const bad of [TOKEN, WRONG, 'LEAKME', 'authorization', 'Bearer']) assert.ok(!text.includes(bad), `洩漏 ${bad}`)
        })

        it('A02 token 放進任何載體（路徑、Origin 路徑、查詢字串、非法 Host）而被拒絕時，token 全文都不落檔；過長路徑片段記為 <long>', async () => {
            const before = readLines(f).length
            const r1 = await rawRequest({ port: P_DENY, path: `/probe/${TOKEN}` }) // 無 Authorization：401 前 onRequest 已過；路徑未註冊→404（不記）；改帶外站 Origin 令其被拒
            assert.equal(r1.status, 404)
            const r2 = await rawRequest({ port: P_DENY, path: `/probe/${TOKEN}`, headers: { origin: EVIL } })
            assert.equal(r2.status, 403)
            const r3 = await rawRequest({ port: P_DENY, path: `/chrome?token=${TOKEN}` })
            assert.equal(r3.status, 401)
            const r4 = await rawRequest({ port: P_DENY, path: '/chrome', headers: { origin: `https://user:pw@evil.example/${TOKEN}?t=${TOKEN}#${TOKEN}` } })
            assert.equal(r4.status, 403)
            const r5 = await rawRequest({ port: P_DENY, path: '/chrome', headers: { host: `evil.example/${TOKEN}` } })
            assert.equal(r5.status, 403)
            const all = readEntries(f) // 5 個請求之 response 事件皆已過（r1 為 404 不記）
            const mine = all.slice(before)
            assert.equal(mine.length, 4)
            assert.equal(mine[0].path, '/probe/<long>')
            assert.equal(mine[2].origin, 'https://evil.example')
            assert.equal(mine[3].host, '<invalid>')
            const text = fs.readFileSync(f, 'utf8')
            assert.ok(!text.includes(TOKEN) && !text.includes('pw@'), '紀錄檔洩漏 token 或帳密')
        })

        it('A03 拒絕紀錄只含允許的欄位（不得有 body／headers／params 等額外欄位）；origin 僅出現在 FORBIDDEN_ORIGIN、host 僅出現在 FORBIDDEN_HOST', () => {
            const all = readLines(f).map((x) => JSON.parse(x))
            const base = ['ts', 'method', 'path', 'ip', 'status', 'ms', 'ok', 'code']
            const denials = all.filter((e) => e.denied)
            assert.ok(denials.length >= 15, `拒絕紀錄過少(${denials.length})`)
            for (const e of denials) {
                const extra = e.denied === 'FORBIDDEN_ORIGIN' ? ['origin'] : e.denied === 'FORBIDDEN_HOST' ? ['host'] : []
                assert.deepEqual(Object.keys(e).sort(), [...base, 'denied', ...extra].sort(), `${e.method} ${e.path} ${e.denied}`)
                assert.equal(e.ok, false)
                assert.equal(e.code, e.denied)
            }
        })

        it('A02 token 較短（路徑片段不超過遮蔽門檻）時，寫入器仍把目前 token 全文清除：路徑記為 /probe/<redacted>', async () => {
            const f2 = path.join(fdTmp, 'short-token.jsonl')
            const SHORT = 'tok-0123456789abcdef' // 20 字元：不會被 <long> 遮蔽，只能靠寫入器清除
            const s = await H.start({ port: P_PAR + 105, token: SHORT, auditLogFile: f2, backend: makeBackend([]), chromeManager: makeChrome([]) })
            const tap2 = tapResponses(s)
            const r = await tap2.request({ port: P_PAR + 105, path: `/probe/${SHORT}`, headers: { origin: EVIL } })
            assert.equal(r.status, 403)
            const all = readEntries(f2)
            assert.equal(all.length, 1)
            const [e] = all
            assert.equal(e.path, '/probe/<redacted>')
            assert.ok(!fs.readFileSync(f2, 'utf8').includes(SHORT))
            await H.stop(s)
        })

        it('A05 啟動輸出列出目前啟用之能力：系統級 DISABLED、evaluate off、紀錄路徑', () => {
            const line = banner.split('\n').find((x) => /capabilities/.test(x))
            assert.ok(line, banner)
            assert.match(line, /system\(mouse\/keyboard\/screenshot\)=DISABLED/)
            assert.match(line, /evaluate=off/)
            assert.ok(line.includes(f), line)
            assert.ok(!banner.includes(TOKEN))
        })
    })

    // ───────────────────────────────────────────────────────────
    describe('系統級開關之來源：環境變數、選項、旗標優先序', () => {
        it('A05 SCREENCTL_ENABLE_SYSTEM=0 → 系統級 403；選項 enableSystem:true 優先於環境變數 → 200', async () => {
            process.env.SCREENCTL_ENABLE_SYSTEM = '0'
            try {
                const calls = []
                const f = path.join(fdTmp, 'env.jsonl')
                const s = await H.start({ port: P_ENV, auditLogFile: f, backend: makeBackend(calls), chromeManager: makeChrome([]) })
                const tap = tapResponses(s)
                const r = await tap.request({ port: P_ENV, method: 'POST', path: '/mouse/click', body: { x: 1, y: 2 }, headers: auth() })
                assert.equal(r.status, 403)
                assert.equal(r.json.code, 'SYSTEM_DISABLED')
                assert.deepEqual(calls, [])
                assert.equal(readLines(f).length, 1)
                await H.stop(s)

                const s2 = await H.start({ port: P_ENV, auditLogFile: f, enableSystem: true, backend: makeBackend(calls), chromeManager: makeChrome([]) })
                const r2 = await rawRequest({ port: P_ENV, method: 'POST', path: '/mouse/click', body: { x: 1, y: 2 }, headers: auth() })
                assert.equal(r2.status, 200)
                assert.equal(calls.length, 1)
                await H.stop(s2)
            }
            finally {
                delete process.env.SCREENCTL_ENABLE_SYSTEM
            }
        })

        it('A05 預設（未設）系統級為開：與 run01 行為一致', async () => {
            const calls = []
            const s = await H.start({ port: P_ENV, backend: makeBackend(calls), chromeManager: makeChrome([]) })
            const r = await rawRequest({ port: P_ENV, method: 'POST', path: '/keyboard/key', body: { keys: 'Enter' }, headers: auth() })
            assert.equal(r.status, 200)
            assert.deepEqual(calls, [['keyboardKey', 'Return']])
            await H.stop(s)
        })
    })

    // ───────────────────────────────────────────────────────────
    describe('跨站白名單下的預檢', () => {
        it('A01 允許之 Origin 的預檢（OPTIONS）成功時不記；同 Origin 的實際請求照記；不被允許的預檢記為拒絕', async () => {
            const f = path.join(fdTmp, 'preflight.jsonl')
            const OK_ORIGIN = 'https://dev.example'
            const s = await H.start({ port: P_PAR + 104, auditLogFile: f, allowedOrigins: [OK_ORIGIN], backend: makeBackend([]), chromeManager: makeChrome([]) })
            const tap = tapResponses(s)
            const pre = await tap.request({ port: P_PAR + 104, method: 'OPTIONS', path: '/mouse/click', headers: { 'origin': OK_ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } })
            assert.ok(pre.status === 200 || pre.status === 204, `status=${pre.status}`)
            assert.equal(pre.headers['access-control-allow-origin'], OK_ORIGIN)
            assert.equal(tap.seen, 1, '預檢也會發 response 事件（否則下一行之「不記」無從由事件序判定）')
            assert.equal(readLines(f).length, 0, '成功預檢不應產生紀錄（驗證 Hapi 特殊路由之實際形狀確實被排除）')
            const r = await tap.request({ port: P_PAR + 104, method: 'POST', path: '/mouse/click', body: { x: 1, y: 2 }, headers: { ...auth(), origin: OK_ORIGIN } })
            assert.equal(r.status, 200)
            const bad = await tap.request({ port: P_PAR + 104, method: 'OPTIONS', path: '/mouse/click', headers: { 'origin': EVIL, 'access-control-request-method': 'POST' } })
            assert.equal(bad.status, 403)
            const all = readEntries(f)
            assert.equal(all.length, 2)
            assert.deepEqual(all.map((e) => [e.method, e.path, e.status, e.denied]), [['POST', '/mouse/click', 200, undefined], ['OPTIONS', '/mouse/click', 403, 'FORBIDDEN_ORIGIN']])
            await H.stop(s)
        })
    })

    // ───────────────────────────────────────────────────────────
    describe('輪替', () => {
        it('A04 超過上限即輪替：只保留 keep 份、每份 ≤ 上限、保留者為連續的最新請求', async () => {
            const d = path.join(fdTmp, 'rot')
            const f = path.join(d, 'audit.jsonl')
            const s = await H.start({ port: P_ROT, auditLogFile: f, auditLogMaxBytes: 2048, auditLogKeep: 2, backend: makeBackend([]), chromeManager: makeChrome([]) })
            const tap = tapResponses(s)
            const N = 60
            for (let i = 1; i <= N; i++) {
                const r = await tap.request({ port: P_ROT, method: 'POST', path: '/mouse/click', body: { x: i, y: i }, headers: auth() })
                assert.equal(r.status, 200)
            }
            // 第 N 個請求之 response 事件已過，最後一筆（含其輪替）已同步落檔
            assert.equal(JSON.parse(readLines(f).pop()).params.x, N)
            assert.deepEqual(fs.readdirSync(d).sort(), ['audit.jsonl', 'audit.jsonl.1', 'audit.jsonl.2'])
            for (const n of fs.readdirSync(d)) assert.ok(fs.statSync(path.join(d, n)).size <= 2048, `${n} 超過上限`)
            const seq = [2, 1].flatMap((k) => readLines(`${f}.${k}`)).concat(readLines(f)).map((x) => JSON.parse(x).params.x)
            assert.equal(seq[seq.length - 1], N)
            for (let i = 1; i < seq.length; i++) assert.equal(seq[i], seq[i - 1] + 1)
            assert.ok(seq[0] > 1, '較舊的紀錄應已被丟棄')
            await H.stop(s)
        })
    })

    // ───────────────────────────────────────────────────────────
    describe('寫檔失敗不影響請求', () => {
        it('A04 紀錄檔位置不可寫（上層是一般檔案）：伺服器照常啟動、所有請求照常回應、console 只警告一次', async () => {
            const blocker = path.join(fdTmp, 'blocker.txt')
            fs.writeFileSync(blocker, 'i am a file')
            const f = path.join(blocker, 'audit.jsonl')
            const calls = []
            const { r: s, lines } = await H.captureConsole(async () => {
                const srv = await H.start({ port: P_FAIL, auditLogFile: f, backend: makeBackend(calls), chromeManager: makeChrome([]) })
                const tap = tapResponses(srv)
                for (let i = 0; i < 6; i++) {
                    const r = await tap.request({ port: P_FAIL, method: 'POST', path: '/mouse/click', body: { x: i, y: i }, headers: auth() })
                    assert.equal(r.status, 200, `第 ${i} 個請求`)
                    assert.equal(r.json.ok, true)
                }
                const denied = await tap.request({ port: P_FAIL, path: '/chrome' })
                assert.equal(denied.status, 401)
                return srv // 7 個請求之 response 事件皆已過：每次寫入失敗之警告（console.warn）都已發出
            })
            assert.equal(calls.length, 6, '動作照常執行')
            const warns = lines.filter((x) => /\[audit\]/.test(x))
            assert.equal(warns.length, 1, `應只警告一次：\n${warns.join('\n')}`)
            assert.ok(!warns[0].includes(TOKEN))
            await H.stop(s)
        })
    })

    // ───────────────────────────────────────────────────────────
    describe('操作紀錄可關閉；預設位置與權限', () => {
        it('A05 auditLog:false → 不建立紀錄檔、啟動輸出標示 OFF 並警告；請求照常', async () => {
            const f = path.join(fdTmp, 'off.jsonl')
            const calls = []
            const { r: s, out } = await H.captureConsole(() => H.start({ port: P_OFF, auditLog: false, auditLogFile: f, backend: makeBackend(calls), chromeManager: makeChrome([]) }))
            const tap = tapResponses(s)
            const r = await tap.request({ port: P_OFF, method: 'POST', path: '/mouse/click', body: { x: 1, y: 2 }, headers: auth() })
            assert.equal(r.status, 200)
            const d = await tap.request({ port: P_OFF, path: '/chrome' })
            assert.equal(d.status, 401)
            assert.equal(fs.existsSync(f), false, '關閉時不得建立紀錄檔') // 兩個請求（含一個被拒絕者）之 response 事件皆已過：判定未寫，不需觀察窗
            assert.match(out, /audit-log=OFF/)
            assert.match(out, /audit log is OFF/i)
            await H.stop(s)
        })

        it('A05 環境變數 SCREENCTL_AUDIT_LOG=0 關閉；選項 auditLog:true 優先 → 照常記錄', async () => {
            const f = path.join(fdTmp, 'off-env.jsonl')
            process.env.SCREENCTL_AUDIT_LOG = '0'
            try {
                const s = await H.start({ port: P_OFF, auditLogFile: f, backend: makeBackend([]), chromeManager: makeChrome([]) })
                await tapResponses(s).request({ port: P_OFF, method: 'POST', path: '/mouse/click', body: { x: 1, y: 2 }, headers: auth() })
                assert.equal(fs.existsSync(f), false)
                await H.stop(s)
                const s2 = await H.start({ port: P_OFF, auditLog: true, auditLogFile: f, backend: makeBackend([]), chromeManager: makeChrome([]) })
                await tapResponses(s2).request({ port: P_OFF, method: 'POST', path: '/mouse/click', body: { x: 1, y: 2 }, headers: auth() })
                assert.equal(readLines(f).length, 1, '選項 auditLog:true 優先：同樣之請求這次有記錄（對照上一段之「未記」）')
                await H.stop(s2)
            }
            finally {
                delete process.env.SCREENCTL_AUDIT_LOG
            }
        })

        it('A05 環境變數 SCREENCTL_AUDIT_LOG_FILE 指定位置', async () => {
            const f = path.join(fdTmp, 'env-file.jsonl')
            process.env.SCREENCTL_AUDIT_LOG_FILE = f
            try {
                const s = await H.start({ port: P_OFF, auditLogFile: undefined, backend: makeBackend([]), chromeManager: makeChrome([]) })
                await tapResponses(s).request({ port: P_OFF, method: 'POST', path: '/mouse/click', body: { x: 1, y: 2 }, headers: auth() })
                assert.equal(readLines(f).length, 1)
                await H.stop(s)
            }
            finally {
                delete process.env.SCREENCTL_AUDIT_LOG_FILE
            }
        })

        it('A04 預設位置：<使用者目錄>/.w-screenctl/audit-<port>.jsonl（與 token 檔同目錄；此處使用者目錄已指到測試夾）', async () => {
            const f = path.join(fdHome, '.w-screenctl', `audit-${P_HOME}.jsonl`)
            const s = await H.start({ port: P_HOME, auditLogFile: undefined, backend: makeBackend([]), chromeManager: makeChrome([]) })
            await tapResponses(s).request({ port: P_HOME, method: 'POST', path: '/mouse/click', body: { x: 1, y: 2 }, headers: auth() })
            const all = readEntries(f)
            assert.equal(all.length, 1)
            assert.equal(all[0].path, '/mouse/click')
            await H.stop(s)
        })

        it('A04 POSIX：紀錄檔 0600、目錄 0700', async function() {
            if (process.platform === 'win32') this.skip()
            const f = path.join(fdHome, '.w-screenctl', `audit-${P_HOME}.jsonl`)
            assert.equal(fs.statSync(f).mode & 0o777, 0o600)
            assert.equal(fs.statSync(path.dirname(f)).mode & 0o777, 0o700)
        })
    })
})
