// api：預設安全（只綁本機、必須 token、關閉跨站、evaluate 預設關）
//
// 直打真實 Hapi server（真 port、真 HTTP），不 mock 接縫。
// 驗證「有副作用之端點」時一律用「通過閘門後被 Joi 擋下（400）」或「chrome 未開（CHROME_NOT_OPEN）」判斷，
// 不送合法 payload，避免真的操作到本機桌面或開出 Chrome。
// 每條斷言之 Rxx 對應 sgud/rule/rulebook.md 之 SEC-xx 規則。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WScreenctl from '../src/WScreenctl.mjs'
import { rawRequest, rawSocket } from './tools/rawHttp.mjs'

const fdTest = path.dirname(fileURLToPath(import.meta.url))
const fdTmp = path.join(fdTest, '_tmp', 'api-security')

const TOKEN = 'test-token-0123456789abcdef-XYZ'
const EVIL = 'https://evil.example'

// 本檔使用之 port（>= 8000，固定不隨機；與 api-security-g.test.mjs 之 87[5-9]x 錯開）
const P_DEFAULT = 8731
const P_EVAL = 8732
const P_ORIGIN = 8733
const P_GEN = 8734
const P_REFUSE = 8735
const P_EXTRA = 8736
const P_LOOP2 = 8737
const P_BACKEND = 8738

const auth = (t = TOKEN) => ({ authorization: `Bearer ${t}` })

// 所有 SCREENCTL_* 環境變數，以及優先於 opt 的 PORT、CHROME_USER_DATA，於本檔期間清空，避免開發者本機設定干擾；結束還原
const isScreenctlEnv = (k) => k.startsWith('SCREENCTL_') || k === 'PORT' || k === 'CHROME_USER_DATA'
let savedEnv = {}
function clearScreenctlEnv() {
    for (const k of Object.keys(process.env)) {
        if (isScreenctlEnv(k)) {
            savedEnv[k] = process.env[k]
            delete process.env[k]
        }
    }
}
function restoreScreenctlEnv() {
    for (const k of Object.keys(process.env)) {
        if (isScreenctlEnv(k)) delete process.env[k]
    }
    Object.assign(process.env, savedEnv)
    savedEnv = {}
}

const servers = []
async function start(opt) {
    const s = await WScreenctl(opt)
    servers.push(s)
    return s
}
async function stopAll() {
    while (servers.length) {
        const s = servers.pop()
        try {
            await s.stop({ timeout: 3000 })
        }
        catch {}
    }
}

// 攔截 console，回傳期間輸出之全文（用於驗證 token 不入 log）
async function captureConsole(fn) {
    const lines = []
    const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info }
    for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.map(String).join(' '))
    try {
        const r = await fn()
        return { r, out: lines.join('\n') }
    }
    finally {
        Object.assign(console, orig)
    }
}

describe('api-security：預設安全', function() {
    this.timeout(30000)

    before(() => {
        clearScreenctlEnv()
        fs.mkdirSync(fdTmp, { recursive: true })
        // WScreenctl 每個實例會對 process 掛 SIGTERM／SIGINT 一次性監聽；本檔於同一行程內啟動多個實例，放寬上限避免無關警告
        process.setMaxListeners(100)
    })

    after(async () => {
        await stopAll()
        restoreScreenctlEnv()
        fs.rmSync(fdTmp, { recursive: true, force: true })
    })

    // ───────────────────────────────────────────────────────────
    describe('預設設定（只給 token）', () => {
        let server

        before(async () => {
            server = await start({ port: P_DEFAULT, token: TOKEN })
        })

        it('R01 預設只綁 127.0.0.1（server 實際監聽位址）', () => {
            assert.equal(server.listener.address().address, '127.0.0.1')
        })

        it('R01 預設不可由本機之非迴路位址連入（ECONNREFUSED）', async function() {
            const lan = Object.values(os.networkInterfaces()).flat()
                .find((i) => i && i.family === 'IPv4' && !i.internal)
            if (!lan) this.skip() // 無外部介面之環境無從驗證
            await assert.rejects(
                rawRequest({ port: P_DEFAULT, path: '/health', address: lan.address }),
                (e) => e.code === 'ECONNREFUSED',
            )
        })

        it('R05 預設之 Hapi 路由設定 cors=false（不依賴請求是否帶 Origin）', () => {
            assert.equal(server.settings.routes.cors, false)
        })

        it('R02 無 token → 401（GET /chrome）', async () => {
            const r = await rawRequest({ port: P_DEFAULT, path: '/chrome' })
            assert.equal(r.status, 401)
            assert.equal(r.json.ok, false)
            assert.equal(r.json.code, 'UNAUTHORIZED')
            assert.match(String(r.headers['www-authenticate']), /^Bearer/i)
        })

        it('R02 錯 token → 401；長度不同之 token 亦 401（不拋例外）', async () => {
            for (const t of ['wrong-token-0123456789abcdef-XY', 'x', TOKEN + 'x', TOKEN.slice(0, -1)]) {
                const r = await rawRequest({ port: P_DEFAULT, path: '/chrome', headers: auth(t) })
                assert.equal(r.status, 401, `token=${t.length} chars`)
            }
        })

        it('R02 非 Bearer 方案或缺 token 值 → 401', async () => {
            for (const v of [`Basic ${TOKEN}`, 'Bearer', 'Bearer ', TOKEN, `Bearer ${TOKEN} extra`]) {
                const r = await rawRequest({ port: P_DEFAULT, path: '/chrome', headers: { authorization: v } })
                assert.equal(r.status, 401, `Authorization: ${v}`)
            }
        })

        it('R02 正確 token → 200（GET /chrome 回 state=closed）', async () => {
            const r = await rawRequest({ port: P_DEFAULT, path: '/chrome', headers: auth() })
            assert.equal(r.status, 200)
            assert.equal(r.json.state, 'closed')
        })

        it('R02 Bearer 方案名不分大小寫（RFC 7235）', async () => {
            const r = await rawRequest({ port: P_DEFAULT, path: '/chrome', headers: { authorization: `bearer ${TOKEN}` } })
            assert.equal(r.status, 200)
        })

        it('R02 系統級端點：無 token → 401；有 token → 通過閘門（空 payload 被 Joi 擋下回 400，不實際操作桌面）', async () => {
            for (const p of ['/mouse/click', '/mouse/dblclick', '/mouse/drag', '/mouse/scroll', '/keyboard/key', '/keyboard/type']) {
                const r0 = await rawRequest({ port: P_DEFAULT, method: 'POST', path: p, body: {} })
                assert.equal(r0.status, 401, `${p} 無 token`)
                const r1 = await rawRequest({ port: P_DEFAULT, method: 'POST', path: p, body: {}, headers: auth() })
                assert.equal(r1.status, 400, `${p} 有 token 應通過閘門後被 Joi 擋下`)
                assert.equal(r1.json.code, 'VALIDATION')
            }
        })

        it('R03 全部已註冊路由（server.table）：無 token / 錯 token 皆 401，唯 GET /health 免', async () => {
            const table = server.table().map((r) => ({ method: r.method.toUpperCase(), path: r.path }))
            assert.ok(table.length >= 20, `路由表過小(${table.length})`)
            const open = []
            // POST 一律送「schema 不認得之欄位」：即使閘門失效，Joi 也會擋下，不會真的開 Chrome 或操作桌面
            const body = (method) => (method === 'POST' ? { __probe__: 1 } : undefined)
            for (const { method, path: p } of table) {
                const noTok = await rawRequest({ port: P_DEFAULT, method, path: p, body: body(method) })
                const badTok = await rawRequest({ port: P_DEFAULT, method, path: p, body: body(method), headers: auth('wrong-token-0123456789abcdef-XY') })
                if (noTok.status !== 401 || badTok.status !== 401) open.push(`${method} ${p} -> ${noTok.status}/${badTok.status}`)
            }
            assert.deepEqual(open, ['GET /health -> 200/200'])
        })

        it('R03 未註冊之路徑：不執行任何 handler（無論有無 token 皆 404），但 Host／Origin 檢查仍適用', async () => {
            // Hapi 之 notFound／預檢為內建特殊路由，不跑路由層 onPreAuth；此處只鎖定「不會被當成已註冊路由放行」
            const r0 = await rawRequest({ port: P_DEFAULT, path: '/no/such/route' })
            assert.equal(r0.status, 404)
            const r1 = await rawRequest({ port: P_DEFAULT, path: '/no/such/route', headers: auth() })
            assert.equal(r1.status, 404)
            const r2 = await rawRequest({ port: P_DEFAULT, path: '/no/such/route', headers: { origin: EVIL } })
            assert.equal(r2.status, 403)
            const r3 = await rawRequest({ port: P_DEFAULT, path: '/no/such/route', headers: { host: 'evil.example' } })
            assert.equal(r3.status, 403)
        })

        it('R04 GET /health 免 token（亦不因帶錯 token 而被拒）', async () => {
            const r0 = await rawRequest({ port: P_DEFAULT, path: '/health' })
            assert.equal(r0.status, 200)
            assert.equal(r0.json.status, 'ok')
            const r1 = await rawRequest({ port: P_DEFAULT, path: '/health', headers: auth('wrong-token-0123456789abcdef-XY') })
            assert.equal(r1.status, 200)
        })

        it('R05 預設不開 CORS：回應不含 access-control-allow-origin', async () => {
            const r = await rawRequest({ port: P_DEFAULT, path: '/health' })
            assert.equal(r.headers['access-control-allow-origin'], undefined)
            const r2 = await rawRequest({ port: P_DEFAULT, path: '/chrome', headers: auth() })
            assert.equal(r2.headers['access-control-allow-origin'], undefined)
        })

        it('R05 CORS 預檢（帶外站 Origin 之 OPTIONS）→ 403 且無 CORS 放行標頭', async () => {
            const r = await rawRequest({
                port: P_DEFAULT,
                method: 'OPTIONS',
                path: '/chrome/open',
                headers: {
                    'origin': EVIL,
                    'access-control-request-method': 'POST',
                    'access-control-request-headers': 'authorization,content-type',
                },
            })
            assert.equal(r.status, 403)
            assert.equal(r.json.code, 'FORBIDDEN_ORIGIN')
            assert.equal(r.headers['access-control-allow-origin'], undefined)
        })

        it('R05 帶外站 Origin 之實際請求 → 403（即使 token 正確；含 /health、含 Origin: null）', async () => {
            for (const origin of [EVIL, 'null', 'http://localhost:3000', 'http://127.0.0.1:7000']) {
                for (const p of ['/chrome', '/health']) {
                    const r = await rawRequest({ port: P_DEFAULT, path: p, headers: { ...auth(), origin } })
                    assert.equal(r.status, 403, `Origin=${origin} ${p}`)
                    assert.equal(r.json.code, 'FORBIDDEN_ORIGIN')
                    assert.equal(r.headers['access-control-allow-origin'], undefined)
                }
            }
        })

        it('R06 偽造 Host（DNS rebinding）→ 403（即使 token 正確）', async () => {
            for (const host of [`evil.example:${P_DEFAULT}`, 'evil.example', `127.0.0.1.evil.example:${P_DEFAULT}`, `localhost.evil.example:${P_DEFAULT}`, `0.0.0.0:${P_DEFAULT}`, '192.168.1.5:7000']) {
                const r = await rawRequest({ port: P_DEFAULT, path: '/chrome', headers: { ...auth(), host } })
                assert.equal(r.status, 403, `Host=${host}`)
                assert.equal(r.json.code, 'FORBIDDEN_HOST')
            }
        })

        it('R06 缺 Host 標頭 → 被拒（Node http 層 400，或閘門 403；絕不放行）', async () => {
            const r = await rawRequest({ port: P_DEFAULT, path: '/chrome', headers: auth(), setHost: false })
            assert.ok(r.status === 400 || r.status === 403, `status=${r.status}`)
        })

        it('R06 格式異常之 Host（夾帶 userinfo、空白、多值）→ 403', async () => {
            for (const host of [`127.0.0.1:${P_DEFAULT}@evil.example`, `user@127.0.0.1:${P_DEFAULT}`, `127.0.0.1:${P_DEFAULT}, evil.example`, 'bad host', `127.0.0.1:${P_DEFAULT}/x`]) {
                const r = await rawRequest({ port: P_DEFAULT, path: '/chrome', headers: { ...auth(), host } })
                assert.equal(r.status, 403, `Host=${host}`)
                assert.equal(r.json.code, 'FORBIDDEN_HOST')
            }
        })

        it('R06 本機名稱 Host（127.0.0.1 / localhost / [::1]，含或不含 port）→ 通過', async () => {
            for (const host of [`127.0.0.1:${P_DEFAULT}`, '127.0.0.1', `localhost:${P_DEFAULT}`, `LOCALHOST:${P_DEFAULT}`, `[::1]:${P_DEFAULT}`]) {
                const r = await rawRequest({ port: P_DEFAULT, path: '/chrome', headers: { ...auth(), host } })
                assert.equal(r.status, 200, `Host=${host}`)
            }
        })

        it('R07 /chrome/evaluate 預設關閉：有 token 回 403 EVALUATE_DISABLED（先於 payload 驗證）；無 token 仍 401', async () => {
            const r0 = await rawRequest({ port: P_DEFAULT, method: 'POST', path: '/chrome/evaluate', body: { script: '1+1' } })
            assert.equal(r0.status, 401)
            const r1 = await rawRequest({ port: P_DEFAULT, method: 'POST', path: '/chrome/evaluate', body: { script: '1+1' }, headers: auth() })
            assert.equal(r1.status, 403)
            assert.equal(r1.json.ok, false)
            assert.equal(r1.json.code, 'EVALUATE_DISABLED')
            const r2 = await rawRequest({ port: P_DEFAULT, method: 'POST', path: '/chrome/evaluate', body: {}, headers: auth() })
            assert.equal(r2.status, 403, '關閉時不應先走 payload 驗證')
        })

        it('R07 其餘 /chrome/* 端點不受 evaluate 開關影響（GET /chrome、POST /chrome/navigate 可達 handler）', async () => {
            const r = await rawRequest({ port: P_DEFAULT, method: 'POST', path: '/chrome/navigate', body: { url: 'about:blank' }, headers: auth() })
            assert.equal(r.status, 200)
            assert.equal(r.json.code, 'CHROME_NOT_OPEN') // chrome 未開：到達 handler 才會有此碼
        })

        it('R09 token 不入 log：啟動輸出不含以選項傳入之 token 全文', async () => {
            const { out } = await captureConsole(async () => {
                const s = await start({ port: P_REFUSE, token: TOKEN })
                await s.stop({ timeout: 3000 })
                servers.pop()
            })
            assert.ok(!out.includes(TOKEN), '啟動 log 洩漏 token')
        })
    })

    // ───────────────────────────────────────────────────────────
    describe('enableEvaluate 開啟', () => {
        before(async () => {
            await start({ port: P_EVAL, token: TOKEN, enableEvaluate: true })
        })

        it('R07 開啟後 /chrome/evaluate 到達 handler（chrome 未開 → CHROME_NOT_OPEN，非 403）', async () => {
            const r = await rawRequest({ port: P_EVAL, method: 'POST', path: '/chrome/evaluate', body: { script: '1+1' }, headers: auth() })
            assert.equal(r.status, 200)
            assert.equal(r.json.ok, false)
            assert.equal(r.json.code, 'CHROME_NOT_OPEN')
        })

        it('R07 開啟後仍須 token（無 token 401）', async () => {
            const r = await rawRequest({ port: P_EVAL, method: 'POST', path: '/chrome/evaluate', body: { script: '1+1' } })
            assert.equal(r.status, 401)
        })

        it('R07 開啟後 payload 驗證恢復（缺 script → 400 VALIDATION）', async () => {
            const r = await rawRequest({ port: P_EVAL, method: 'POST', path: '/chrome/evaluate', body: {}, headers: auth() })
            assert.equal(r.status, 400)
            assert.equal(r.json.code, 'VALIDATION')
        })
    })

    // ───────────────────────────────────────────────────────────
    describe('allowedOrigins 白名單', () => {
        const OK = 'https://dev.example'
        before(async () => {
            const s = await start({ port: P_ORIGIN, token: TOKEN, allowedOrigins: [OK] })
            // 白名單啟用時 CORS 只列該 Origin，不是 true／*
            assert.deepEqual(s.settings.routes.cors.origin, [OK])
            assert.equal(s.settings.routes.cors.credentials, false)
        })

        it('R10 白名單 Origin 之預檢 → 放行且回該 Origin（不回 *），預檢不需 token', async () => {
            const r = await rawRequest({
                port: P_ORIGIN,
                method: 'OPTIONS',
                path: '/chrome/open',
                headers: { 'origin': OK, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
            })
            assert.ok(r.status === 200 || r.status === 204, `status=${r.status}`)
            assert.equal(r.headers['access-control-allow-origin'], OK)
            assert.match(String(r.headers['access-control-allow-headers']), /authorization/i)
        })

        it('R10 白名單 Origin 之實際請求：有 token → 200 且帶 CORS 標頭；無 token → 401', async () => {
            const r = await rawRequest({ port: P_ORIGIN, path: '/chrome', headers: { ...auth(), origin: OK } })
            assert.equal(r.status, 200)
            assert.equal(r.headers['access-control-allow-origin'], OK)
            const r2 = await rawRequest({ port: P_ORIGIN, path: '/chrome', headers: { origin: OK } })
            assert.equal(r2.status, 401)
        })

        it('R10 非白名單 Origin（含相近字串）→ 403', async () => {
            for (const origin of [EVIL, 'https://dev.example.evil.example', 'http://dev.example', 'https://dev.example:8443', 'null']) {
                const r = await rawRequest({ port: P_ORIGIN, path: '/chrome', headers: { ...auth(), origin } })
                assert.equal(r.status, 403, `Origin=${origin}`)
                const p = await rawRequest({ port: P_ORIGIN, method: 'OPTIONS', path: '/chrome/open', headers: { origin, 'access-control-request-method': 'POST' } })
                assert.equal(p.status, 403, `preflight Origin=${origin}`)
                assert.equal(p.headers['access-control-allow-origin'], undefined)
            }
        })

        it('R06 白名單 Origin 不放寬 Host 檢查（偽造 Host 仍 403）', async () => {
            const r = await rawRequest({ port: P_ORIGIN, path: '/chrome', headers: { ...auth(), origin: OK, host: `evil.example:${P_ORIGIN}` } })
            assert.equal(r.status, 403)
        })
    })

    // ───────────────────────────────────────────────────────────
    describe('補強：重複標頭、HEAD、特殊路由、破損 payload', () => {
        const origins = ['https://dev.example']
        before(async () => {
            await start({ port: P_EXTRA, token: TOKEN, allowedOrigins: origins })
        })

        it('R06/R02 重複的 Host 標頭（原始請求有兩個）→ 403，即使第一個合法、token 正確', async () => {
            const r = await rawSocket({
                port: P_EXTRA,
                text: `GET /chrome HTTP/1.1\r\nHost: 127.0.0.1:${P_EXTRA}\r\nHost: evil.example\r\nAuthorization: Bearer ${TOKEN}\r\nConnection: close\r\n\r\n`,
            })
            assert.equal(r.status, 403)
            assert.equal(r.json.code, 'FORBIDDEN_HOST')
        })

        it('R02 重複的 Authorization 標頭 → 401（無論正確與錯誤之先後）；單一正確者 → 200', async () => {
            const mk = (...vals) => `GET /chrome HTTP/1.1\r\nHost: 127.0.0.1:${P_EXTRA}\r\n${vals.map((v) => `Authorization: ${v}\r\n`).join('')}Connection: close\r\n\r\n`
            const good = `Bearer ${TOKEN}`
            const bad = 'Bearer wrong-token-0123456789abcdef-XY'
            assert.equal((await rawSocket({ port: P_EXTRA, text: mk(good, bad) })).status, 401)
            assert.equal((await rawSocket({ port: P_EXTRA, text: mk(bad, good) })).status, 401)
            assert.equal((await rawSocket({ port: P_EXTRA, text: mk(good) })).status, 200)
        })

        it('R06/R02 標頭外圍夾帶 NBSP（非 HTTP 空白）→ Host 403、Authorization 401', async () => {
            const r1 = await rawRequest({ port: P_EXTRA, path: '/chrome', headers: { ...auth(), host: `127.0.0.1:${P_EXTRA}\u00a0` } })
            assert.equal(r1.status, 403)
            const r2 = await rawRequest({ port: P_EXTRA, path: '/chrome', headers: { authorization: `Bearer ${TOKEN}\u00a0` } })
            assert.equal(r2.status, 401)
            const r3 = await rawRequest({ port: P_EXTRA, path: '/chrome', headers: { authorization: `Bearer\u00a0${TOKEN}` } })
            assert.equal(r3.status, 401)
        })

        it('R05 重複的 Origin 標頭（合併為逗號字串）→ 403', async () => {
            const text = `GET /chrome HTTP/1.1\r\nHost: 127.0.0.1:${P_EXTRA}\r\nAuthorization: Bearer ${TOKEN}\r\nOrigin: https://dev.example\r\nOrigin: https://evil.example\r\nConnection: close\r\n\r\n`
            assert.equal((await rawSocket({ port: P_EXTRA, text })).status, 403)
        })

        it('R05 Origin 大小寫不同於白名單 → 403（逐字比對；瀏覽器送出的本來就是小寫）', async () => {
            const r = await rawRequest({ port: P_EXTRA, path: '/chrome', headers: { ...auth(), origin: 'HTTPS://DEV.EXAMPLE' } })
            assert.equal(r.status, 403)
        })

        it('R02/R04 HEAD：/chrome 無 token → 401；/health 為公開路由（HEAD 隨 GET 之標記）→ 200', async () => {
            const a = await rawRequest({ port: P_EXTRA, method: 'HEAD', path: '/chrome' })
            assert.equal(a.status, 401)
            const b = await rawRequest({ port: P_EXTRA, method: 'HEAD', path: '/chrome', headers: auth() })
            assert.equal(b.status, 200)
            const c = await rawRequest({ port: P_EXTRA, method: 'HEAD', path: '/health' })
            assert.equal(c.status, 200)
        })

        it('R04/R06 /health 受 Host 檢查：非本機 Host → 403', async () => {
            const r = await rawRequest({ port: P_EXTRA, path: '/health', headers: { host: 'evil.example' } })
            assert.equal(r.status, 403)
        })

        it('R05/R03 白名單 Origin 之預檢打到未註冊路徑 → 不得成為成功之業務回應（不回 CORS 放行，亦不執行 handler）', async () => {
            const r = await rawRequest({ port: P_EXTRA, method: 'OPTIONS', path: '/no/such/route', headers: { 'origin': origins[0], 'access-control-request-method': 'POST' } })
            assert.notEqual(r.status, 200)
            assert.equal(r.headers['access-control-allow-origin'], undefined)
        })

        it('R03/R07 方法不符之已註冊路徑（GET /chrome/evaluate）→ 無 token 一律 401 或 404，不洩漏、不執行 handler', async () => {
            const r = await rawRequest({ port: P_EXTRA, method: 'GET', path: '/chrome/evaluate' })
            assert.ok(r.status === 401 || r.status === 404, `status=${r.status}`)
            const r2 = await rawRequest({ port: P_EXTRA, method: 'PATCH', path: '/chrome', headers: auth() })
            assert.ok(r2.status === 404 || r2.status === 405, `status=${r2.status}`)
        })

        it('R07 evaluate 關閉時，破損 JSON 之 payload：無 token → 401、有 token → 403（閘門先於 payload 解析）', async () => {
            const r0 = await rawRequest({ port: P_EXTRA, method: 'POST', path: '/chrome/evaluate', body: '{not json' })
            assert.equal(r0.status, 401)
            const r1 = await rawRequest({ port: P_EXTRA, method: 'POST', path: '/chrome/evaluate', body: '{not json', headers: auth() })
            assert.equal(r1.status, 403)
            assert.equal(r1.json.code, 'EVALUATE_DISABLED')
        })

        it('R02 任何路由之超大 payload（> 10 MB）在無 token 時不會被解析：回 401', async () => {
            const big = '{"text":"' + 'a'.repeat(11 * 1024 * 1024) + '"}'
            let status = null
            try {
                status = (await rawRequest({ port: P_EXTRA, method: 'POST', path: '/keyboard/type', body: big })).status
            }
            catch (err) {
                // 伺服器於讀完 body 前即回應並關閉連線時，用戶端可能先遇到連線重置：同樣代表 body 未被解析
                assert.ok(['ECONNRESET', 'EPIPE'].includes(err.code), err.code)
            }
            if (status !== null) assert.equal(status, 401, '未通過 token 前不得進入 payload 解析（否則會是 413 或 400）')
        })
    })

    // ───────────────────────────────────────────────────────────
    describe('自訂監聽位址實際生效（迴路範圍內之 127.0.0.2）', () => {
        it('R01 host:127.0.0.2 → 只在該位址監聽；Host 標頭 127.0.0.2 通過、其餘本機名稱仍通過；127.0.0.1 連不到', async function() {
            let s
            try {
                s = await start({ port: P_LOOP2, host: '127.0.0.2', token: TOKEN })
            }
            catch (err) {
                if (err.code === 'EADDRNOTAVAIL') this.skip() // macOS 預設未設定 127.0.0.2
                throw err
            }
            assert.equal(s.listener.address().address, '127.0.0.2')
            const ok = await rawRequest({ port: P_LOOP2, address: '127.0.0.2', path: '/chrome', headers: { ...auth(), host: `127.0.0.2:${P_LOOP2}` } })
            assert.equal(ok.status, 200)
            const alias = await rawRequest({ port: P_LOOP2, address: '127.0.0.2', path: '/chrome', headers: { ...auth(), host: `localhost:${P_LOOP2}` } })
            assert.equal(alias.status, 200)
            await assert.rejects(rawRequest({ port: P_LOOP2, address: '127.0.0.1', path: '/health' }), (e) => e.code === 'ECONNREFUSED')
        })
    })

    // ───────────────────────────────────────────────────────────
    describe('系統級端點仍可用（以後端替身驗證，不操作真實桌面）', () => {
        const calls = []
        const rec = (name) => async (...a) => {
            calls.push([name, ...a])
        }
        const backend = {
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
        before(async () => {
            await start({ port: P_BACKEND, token: TOKEN, backend })
        })
        const post = (p, body, headers = auth()) => rawRequest({ port: P_BACKEND, method: 'POST', path: p, body, headers })

        it('R07 有 token + 合法 payload：/mouse/*、/keyboard/*、/screenshot 皆執行並回 ok（維持開啟，只是受 token 保護）', async () => {
            calls.length = 0
            assert.deepEqual((await post('/mouse/click', { x: 10, y: 20 })).json, { ok: true })
            assert.deepEqual((await post('/mouse/dblclick', { x: 1, y: 2 })).json, { ok: true })
            assert.deepEqual((await post('/mouse/drag', { fromX: 1, fromY: 2, toX: 3, toY: 4, button: 3 })).json, { ok: true })
            assert.deepEqual((await post('/mouse/scroll', { x: 5, y: 6, direction: 'down' })).json, { ok: true })
            assert.deepEqual((await post('/keyboard/key', { keys: 'Enter' })).json, { ok: true })
            assert.deepEqual((await post('/keyboard/type', { text: '你好 hi' })).json, { ok: true })
            const shot = (await post('/screenshot', { region: { x: 1, y: 2, width: 3, height: 4 } })).json
            assert.deepEqual(shot, { ok: true, image: 'QUFB', format: 'png' })
            assert.deepEqual(calls, [
                ['mouseClick', 10, 20, 1],
                ['mouseDblClick', 1, 2],
                ['mouseDrag', 1, 2, 3, 4, 3],
                ['mouseScroll', 5, 6, 'down', 3],
                ['keyboardKey', 'Return'], // 'Enter' 經 normalizeKey 轉成 xdotool 風格
                ['keyboardType', '你好 hi'],
                ['screenshot', { x: 1, y: 2, width: 3, height: 4 }],
            ])
        })

        it('R02/R05/R06 無 token／錯 token／跨站 Origin／非本機 Host：同樣合法 payload 一律被擋，後端完全不被呼叫', async () => {
            calls.length = 0
            const body = { x: 10, y: 20 }
            assert.equal((await post('/mouse/click', body, {})).status, 401)
            assert.equal((await post('/mouse/click', body, auth('wrong-token-0123456789abcdef-XY'))).status, 401)
            assert.equal((await post('/mouse/click', body, { ...auth(), origin: EVIL })).status, 403)
            assert.equal((await post('/mouse/click', body, { ...auth(), host: 'evil.example' })).status, 403)
            assert.equal((await post('/keyboard/type', { text: 'x' }, {})).status, 401)
            assert.equal((await post('/screenshot', {}, {})).status, 401)
            assert.deepEqual(calls, [])
        })
    })

    // ───────────────────────────────────────────────────────────
    describe('token 來源：未給時自動產生', () => {
        const fTok = path.join(fdTmp, 'gen.token')

        it('R09 loopback 且未給 token → 自動產生、寫入 tokenFile、可用該 token 呼叫、啟動輸出不含全文', async () => {
            fs.rmSync(fTok, { force: true })
            const { out } = await captureConsole(() => start({ port: P_GEN, tokenFile: fTok }))
            assert.ok(fs.existsSync(fTok), 'tokenFile 未建立')
            const tok = fs.readFileSync(fTok, 'utf8').trim()
            assert.ok(tok.length >= 32, `token 過短(${tok.length})`)
            assert.ok(!out.includes(tok), '啟動 log 洩漏自動產生之 token 全文')
            assert.ok(out.includes(fTok), '啟動 log 應告知 tokenFile 位置')
            const r0 = await rawRequest({ port: P_GEN, path: '/chrome' })
            assert.equal(r0.status, 401)
            const r1 = await rawRequest({ port: P_GEN, path: '/chrome', headers: auth(tok) })
            assert.equal(r1.status, 200)
        })

        it('R09 tokenFile 權限限本人（POSIX 0600）', function() {
            if (process.platform === 'win32') this.skip() // Windows 之 mode 位元無意義，改依使用者設定檔 ACL
            assert.equal(fs.statSync(fTok).mode & 0o777, 0o600)
        })

        it('R09 零設定：token 寫入 <家目錄>/.w-screenctl/token-<port>；第二個實例因 port 被占用而啟動失敗時，不得覆寫執行中實例之 token 檔', async () => {
            await stopAll()
            // 把家目錄指向測試夾（os.homedir() 於 Windows 讀 USERPROFILE、POSIX 讀 HOME），不碰真實家目錄
            const home = path.join(fdTmp, 'home')
            const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
            process.env.HOME = home
            process.env.USERPROFILE = home
            try {
                const f = path.join(home, '.w-screenctl', `token-${P_GEN}`)
                await start({ port: P_GEN })
                assert.ok(fs.existsSync(f), `預設 token 檔未建立：${f}`)
                const first = fs.readFileSync(f, 'utf8')
                // 同 port 再起一個：必須失敗；失敗不得動到 token 檔
                await assert.rejects(WScreenctl({ port: P_GEN }), /EADDRINUSE/)
                assert.equal(fs.readFileSync(f, 'utf8'), first)
                const r = await rawRequest({ port: P_GEN, path: '/chrome', headers: auth(first.trim()) })
                assert.equal(r.status, 200, '執行中實例之 token 應仍有效')
            }
            finally {
                for (const [k, v] of Object.entries(saved)) {
                    if (v === undefined) delete process.env[k]
                    else process.env[k] = v
                }
                await stopAll()
            }
        })

        it('R09 明指之 tokenFile 於啟動期間被他人建立 → 拒絕啟動、不覆寫該檔、不佔用 port', async () => {
            await stopAll()
            const f = path.join(fdTmp, 'raced.token')
            fs.writeFileSync(f, 'other-instance-token-0123456789\n')
            // 模擬「解析設定時檔案尚不存在、寫檔前被另一實例建立」：讓 resolveSecurity 的第一次 existsSync(f) 回 false
            const orig = fs.existsSync
            let hit = false
            fs.existsSync = (p) => {
                if (!hit && path.resolve(String(p)) === path.resolve(f)) {
                    hit = true
                    return false
                }
                return orig.call(fs, p)
            }
            try {
                await assert.rejects(start({ port: P_GEN, tokenFile: f }), (e) => e.code === 'SCREENCTL_CONFIG' && /another process/.test(e.message))
            }
            finally {
                fs.existsSync = orig
            }
            assert.equal(hit, true)
            assert.equal(fs.readFileSync(f, 'utf8'), 'other-instance-token-0123456789\n')
            await assert.rejects(rawRequest({ port: P_GEN, path: '/health' }), (e) => e.code === 'ECONNREFUSED')
        })

        it('R09 已存在之 tokenFile 被沿用（不覆寫）', async () => {
            await stopAll()
            const fixed = 'file-token-0123456789abcdef-AAA'
            const f2 = path.join(fdTmp, 'fixed.token')
            fs.writeFileSync(f2, fixed + '\n')
            await start({ port: P_GEN, tokenFile: f2 })
            assert.equal(fs.readFileSync(f2, 'utf8').trim(), fixed)
            const r = await rawRequest({ port: P_GEN, path: '/chrome', headers: auth(fixed) })
            assert.equal(r.status, 200)
        })
    })

    // ───────────────────────────────────────────────────────────
    describe('啟動前拒絕之設定', () => {
        it('R08 綁非迴路位址且未設 token → 拒絕啟動，並印出警告；不留下 token 檔、不佔用 port', async () => {
            const f = path.join(fdTmp, 'refuse.token')
            for (const host of ['0.0.0.0', '::', '192.168.1.5', 'example.com']) {
                const { out, r } = await captureConsole(async () => {
                    try {
                        await start({ port: P_REFUSE, host, tokenFile: f })
                        return 'started'
                    }
                    catch (e) {
                        return e
                    }
                })
                assert.ok(r instanceof Error, `host=${host} 應拒絕啟動`)
                assert.match(r.message, /refus/i)
                assert.match(r.message, /token/i)
                assert.ok(/SCREENCTL_TOKEN|token/i.test(out + r.message))
                assert.ok(!fs.existsSync(f), 'host=' + host + ' 不應寫出 token 檔')
            }
            // port 未被占用：此處再起一個應成功
            const s = await start({ port: P_REFUSE, token: TOKEN })
            assert.equal(s.listener.address().port, P_REFUSE)
        })

        it('R08 經環境變數 SCREENCTL_HOST=0.0.0.0 且未設 token 亦拒絕啟動', async () => {
            await stopAll()
            process.env.SCREENCTL_HOST = '0.0.0.0'
            try {
                await assert.rejects(start({ port: P_REFUSE, tokenFile: path.join(fdTmp, 'refuse2.token') }), /refus/i)
            }
            finally {
                delete process.env.SCREENCTL_HOST
            }
        })

        it('R11 token 不可被停用：token:false / 空字串 / 空白 → 視為未給（loopback 改自動產生，仍須驗證）', async () => {
            await stopAll()
            for (const [i, v] of [false, '', '   ', null].entries()) {
                const f = path.join(fdTmp, `off${i}.token`)
                const s = await start({ port: P_REFUSE, token: v, tokenFile: f })
                const r = await rawRequest({ port: P_REFUSE, path: '/chrome' })
                assert.equal(r.status, 401, `token=${JSON.stringify(v)} 不應關閉驗證`)
                await s.stop({ timeout: 3000 })
                servers.pop()
            }
        })

        it('R11 空字串 SCREENCTL_TOKEN 不得被當成「無 token 即放行」；非迴路 + 空 token 仍拒絕', async () => {
            process.env.SCREENCTL_TOKEN = ''
            try {
                await assert.rejects(start({ port: P_REFUSE, host: '0.0.0.0' }), /refus/i)
            }
            finally {
                delete process.env.SCREENCTL_TOKEN
            }
        })

        it('R11 過短之 token（< 16 字元）→ 拒絕啟動，錯誤訊息不回顯 token', async () => {
            await assert.rejects(
                start({ port: P_REFUSE, token: 'short-secret' }),
                (e) => /token/i.test(e.message) && !e.message.includes('short-secret'),
            )
        })

        it('R10 allowedOrigins 含萬用字元 * 或 null → 拒絕啟動（不得退化成全開）', async () => {
            for (const bad of ['*', 'null', 'https://*.example.com', 'not-an-origin']) {
                await assert.rejects(start({ port: P_REFUSE, token: TOKEN, allowedOrigins: [bad] }), /origin/i, bad)
            }
        })
    })
})
