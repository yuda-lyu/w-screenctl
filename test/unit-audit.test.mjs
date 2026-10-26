// unit：src/auditLog.mjs（參數摘要、遮蔽、紀錄項組裝、輪替、寫檔失敗）與 src/security.mjs 之操作紀錄／系統級開關設定解析
// 每條斷言之 Axx 對應 sgud/rule/rulebook.md 之 AUD-xx 規則。紀錄檔一律寫在 test/_tmp/unit-audit/，不碰使用者目錄。

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    AUDIT_ROUTE_KEYS,
    DEFAULT_AUDIT_MAX_BYTES,
    DEFAULT_AUDIT_KEEP,
    stripUrl,
    redactKeys,
    summarizeParams,
    buildAuditEntry,
    createAuditLogger
} from '../src/auditLog.mjs'
import { resolveSecurity, describeSecurity, defaultAuditFile, defaultTokenFile } from '../src/security.mjs'

const fdTest = path.dirname(fileURLToPath(import.meta.url))
const fdTmp = path.join(fdTest, '_tmp', 'unit-audit')
const TOK = 'unit-token-0123456789abcdef-QQ'

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
const lines = (f) => fs.readFileSync(f, 'utf8').split('\n').filter((x) => x !== '').map((x) => JSON.parse(x))

describe('unit-audit', function() {

    before(() => fs.mkdirSync(fdTmp, { recursive: true }))
    after(() => fs.rmSync(fdTmp, { recursive: true, force: true }))

    // ───────────────────────────────────────────────────────────
    describe('stripUrl', () => {
        it('A02 去除查詢字串、片段、帳密；保留協定／主機／port／路徑', () => {
            assert.equal(stripUrl('https://user:pw@example.com:8443/a/b?secret=abc&t=1#frag'), 'https://example.com:8443/a/b')
            assert.equal(stripUrl('http://example.com/?x=1'), 'http://example.com/')
            assert.equal(stripUrl('about:blank#x'), 'about:blank')
            assert.equal(stripUrl('about:blank?q=1'), 'about:blank')
            assert.equal(stripUrl('file:///C:/t/a.html?q=1#h'), 'file:///C:/t/a.html')
        })
        it('A02 任何協定皆去帳密：含 authority 之 about:// 寫法也不例外（審查指出之缺口）', () => {
            assert.equal(stripUrl('about://alice:ABOUT_PASSWORD@example.com/page?query=SECRET_QUERY#SECRET_FRAGMENT'), 'about://example.com/page')
            assert.equal(stripUrl('ftp://u:p@host.example:2121/x?y#z'), 'ftp://host.example:2121/x')
            for (const u of ['about://alice:ABOUT_PASSWORD@example.com/page', 'https://a:b@h/p?x=1#y', 'file://user:pw@host/share/f.txt']) {
                const s = stripUrl(u)
                assert.ok(!/ABOUT_PASSWORD|a:b|user:pw|\?|#|@/.test(s), s)
            }
        })
        it('A02 無法解析 → <invalid>；過長路徑截斷', () => {
            assert.equal(stripUrl('not a url'), '<invalid>')
            assert.equal(stripUrl(undefined), '<invalid>')
            assert.ok(stripUrl('https://example.com/' + 'a'.repeat(1000)).length <= 300)
        })
    })

    describe('redactKeys', () => {
        it('A02 具名鍵與快捷鍵原樣記錄', () => {
            for (const k of ['Enter', 'Return', 'Escape', 'Tab', 'F5', 'ctrl+a', 'Control+A', 'alt+F4', 'super+r', 'Meta+Shift+P', 'PageDown', 'space', 'shift+Tab']) {
                assert.equal(redactKeys(k), k)
            }
        })
        it('A02 單一可印字元（可能是逐字輸入的密碼）不記字面：a→<char>、shift+7→shift+<char>、+→<char>', () => {
            assert.equal(redactKeys('a'), '<char>')
            assert.equal(redactKeys('Z'), '<char>')
            assert.equal(redactKeys('7'), '<char>')
            assert.equal(redactKeys('+'), '<char>')
            assert.equal(redactKeys('shift+7'), 'shift+<char>')
            assert.equal(redactKeys('Shift+a'), 'Shift+<char>')
        })
        it('A02 「一個字」以字素計，不是 UTF-16 長度：單一 emoji、組合字元、ZWJ 序列、非 BMP 字元都記 <char>', () => {
            for (const c of ['😀', '𠮷', 'é', '👨‍👩‍👧', '🇹🇼', '密']) {
                assert.equal(redactKeys(c), '<char>', c)
                assert.equal(redactKeys(`shift+${c}`), 'shift+<char>', c)
            }
            assert.equal(redactKeys('ctrl+😀'), 'ctrl+😀', '快捷鍵原樣')
        })
        it('A02 代表「一個字元」的鍵名（Playwright 的 KeyA／Digit5、xdotool 的 minus／kp_5）同樣不記字面', () => {
            for (const k of ['KeyA', 'KeyZ', 'Digit5', 'Numpad7', 'kp_5', 'minus', 'comma', 'semicolon']) {
                assert.equal(redactKeys(k), '<char>', k)
            }
            assert.equal(redactKeys('ctrl+KeyA'), 'ctrl+KeyA')
        })
        it('A02 不是已知鍵名之字串（例如被誤送進來的整段文字）只記 <key>，不記字面', () => {
            assert.equal(redactKeys('hunter2'), '<key>')
            assert.equal(redactKeys('P@ssw0rd'), '<key>')
            assert.equal(redactKeys('shift+hunter2'), 'shift+<key>')
            assert.equal(redactKeys('ctrl+hunter2'), 'ctrl+<key>')
            assert.equal(redactKeys('hunter2+a'), '<key>+<char>')
            for (const k of ['hunter2', 'P@ssw0rd', 'shift+hunter2']) assert.ok(!redactKeys(k).includes('hunter') && !redactKeys(k).includes('ssw0rd'))
        })
        it('A02 超長輸入截斷', () => {
            assert.ok(redactKeys('x'.repeat(1000)).length <= 200)
            assert.equal(redactKeys('x'.repeat(1000)), '<key>')
        })
    })

    // ───────────────────────────────────────────────────────────
    describe('summarizeParams：只複製白名單欄位，不展開 payload', () => {
        const S = summarizeParams
        it('A01 滑鼠：座標、按鍵、方向、格數', () => {
            assert.deepEqual(S('POST', '/mouse/click', { x: 1, y: 2, button: 3, junk: 'x' }), { x: 1, y: 2, button: 3 })
            assert.deepEqual(S('POST', '/mouse/dblclick', { x: 1, y: 2 }), { x: 1, y: 2 })
            assert.deepEqual(S('POST', '/mouse/drag', { fromX: 1, fromY: 2, toX: 3, toY: 4, button: 1 }), { fromX: 1, fromY: 2, toX: 3, toY: 4, button: 1 })
            assert.deepEqual(S('POST', '/mouse/scroll', { x: 1, y: 2, direction: 'down', amount: 3 }), { x: 1, y: 2, direction: 'down', amount: 3 })
            for (const k of ['click', 'dblclick', 'drag', 'scroll']) {
                assert.deepEqual(S('POST', `/chrome/mouse/${k}`, { x: 5, y: 6, fromX: 7, direction: 'up', amount: 2, button: 2 }), S('POST', `/mouse/${k}`, { x: 5, y: 6, fromX: 7, direction: 'up', amount: 2, button: 2 }))
            }
        })
        it('A02 鍵盤：key 走遮蔽規則；type 只記字元數，絕不含文字', () => {
            assert.deepEqual(S('POST', '/keyboard/key', { keys: 'ctrl+v' }), { keys: 'ctrl+v' })
            assert.deepEqual(S('POST', '/keyboard/key', { keys: 'p' }), { keys: '<char>' })
            assert.deepEqual(S('POST', '/chrome/keyboard/key', { keys: 'Enter' }), { keys: 'Enter' })
            const t = S('POST', '/keyboard/type', { text: 'P@ssw0rd-秘密' })
            assert.deepEqual(t, { textLen: 'P@ssw0rd-秘密'.length })
            assert.ok(!JSON.stringify(t).includes('P@ssw0rd'))
            assert.deepEqual(S('POST', '/chrome/keyboard/type', { text: '' }), { textLen: 0 })
        })
        it('A02 evaluate：只記長度與 SHA-256（UTF-8），不含 script', () => {
            const script = 'document.cookie + "密"'
            const r = S('POST', '/chrome/evaluate', { script })
            assert.deepEqual(r, { scriptLen: script.length, scriptSha256: sha(script) })
            assert.ok(!JSON.stringify(r).includes('cookie'))
        })
        it('A02 網址類：去除查詢字串／片段／帳密', () => {
            assert.deepEqual(S('POST', '/chrome/navigate', { url: 'https://u:p@example.com/x?token=abc#h' }), { url: 'https://example.com/x' })
            const o = S('POST', '/chrome/open', {
                url: 'https://example.com/a?secret=1',
                mode: 'replace',
                window: { x: 0, y: 0, width: 800, height: 600 },
                viewport: { width: 800, height: 600 },
                userData: 'C:/Users/someone/profile',
                opt: { headless: false, disableGpu: false, disableSandbox: true, deviceScaleFactor: 2 },
            })
            assert.deepEqual(o, {
                url: 'https://example.com/a',
                mode: 'replace',
                window: { x: 0, y: 0, width: 800, height: 600 },
                viewport: { width: 800, height: 600 },
                userData: true,
                opt: { headless: false, disableGpu: false, disableSandbox: true, deviceScaleFactor: 2 },
            })
            assert.ok(!JSON.stringify(o).includes('someone'), 'userData 路徑只記「有指定」')
            assert.deepEqual(S('POST', '/chrome/open', { opt: { headless: true, disableGpu: false, disableSandbox: false } }), { opt: { headless: true, disableGpu: false, disableSandbox: false } })
        })
        it('A01 截圖：區域座標；無區域→空物件', () => {
            assert.deepEqual(S('POST', '/screenshot', { region: { x: 1, y: 2, width: 3, height: 4 } }), { region: { x: 1, y: 2, width: 3, height: 4 } })
            assert.deepEqual(S('POST', '/screenshot', {}), {})
            assert.deepEqual(S('POST', '/chrome/screenshot', null), {})
        })
        it('A01 無參數之路由與未登錄之路由 → 空物件（新路由未登錄時預設不記任何參數，寧缺勿洩）', () => {
            assert.deepEqual(S('GET', '/chrome', null), {})
            assert.deepEqual(S('DELETE', '/chrome', undefined), {})
            assert.deepEqual(S('POST', '/some/new/route', { password: 'x' }), {})
            assert.deepEqual(S('HEAD', '/chrome', null), {})
        })
        it('A01 摘要登錄表涵蓋全部控制路由（20 條，含 /health 之空登錄）', () => {
            assert.equal(AUDIT_ROUTE_KEYS.length, 20)
            assert.equal(new Set(AUDIT_ROUTE_KEYS).size, 20)
            for (const k of ['GET /health', 'POST /chrome/open', 'GET /chrome', 'DELETE /chrome', 'POST /chrome/evaluate', 'POST /keyboard/type', 'POST /chrome/keyboard/type', 'POST /screenshot']) {
                assert.ok(AUDIT_ROUTE_KEYS.includes(k), k)
            }
        })
    })

    // ───────────────────────────────────────────────────────────
    describe('buildAuditEntry', () => {
        const req = (o = {}) => ({
            method: 'post',
            path: '/mouse/click',
            route: { path: o.routePath === undefined ? '/mouse/click' : o.routePath, settings: { app: o.app || {} } },
            headers: o.headers || {},
            info: { remoteAddress: o.ip || '127.0.0.1', received: 1790000000000, responded: 1790000000042 },
            response: o.response === undefined ? { statusCode: 200, source: { ok: true } } : o.response,
            app: o.appState || {},
            ...(o.over || {}),
        })

        it('A01 已註冊之控制路由：記 ts(ISO)、method(大寫)、path、ip、status、ms、ok、params', () => {
            const e = buildAuditEntry(req({ appState: { auditParams: { x: 1, y: 2, button: 1 } } }))
            assert.deepEqual(e, {
                ts: new Date(1790000000000).toISOString(),
                method: 'POST',
                path: '/mouse/click',
                ip: '127.0.0.1',
                status: 200,
                ms: 42,
                ok: true,
                params: { x: 1, y: 2, button: 1 },
            })
        })
        it('A01 handler 失敗（HTTP 200、ok:false）→ 記 ok:false 與 code', () => {
            const e = buildAuditEntry(req({ response: { statusCode: 200, source: { ok: false, code: 'CHROME_NOT_OPEN', error: 'secret detail' } } }))
            assert.equal(e.ok, false)
            assert.equal(e.code, 'CHROME_NOT_OPEN')
            assert.ok(!JSON.stringify(e).includes('secret detail'), '不記錯誤訊息全文')
        })
        it('A03 閘門拒絕：記 denied（原因碼）、status、ip、path，無 params；Origin／Host 拒絕多記該標頭值（截斷）', () => {
            const e1 = buildAuditEntry(req({
                routePath: '/{p*}',
                appState: { denied: 'FORBIDDEN_ORIGIN', auditParams: { x: 1 } },
                headers: { origin: 'https://evil.example', host: '127.0.0.1:7000', authorization: 'Bearer SECRET-TOKEN-VALUE' },
                response: { statusCode: 403, source: { ok: false, code: 'FORBIDDEN_ORIGIN', error: 'forbidden' } },
            }))
            assert.equal(e1.denied, 'FORBIDDEN_ORIGIN')
            assert.equal(e1.status, 403)
            assert.equal(e1.origin, 'https://evil.example')
            assert.equal(e1.params, undefined)
            assert.ok(!JSON.stringify(e1).includes('SECRET-TOKEN-VALUE'))
            const e2 = buildAuditEntry(req({
                routePath: '/{p*}',
                appState: { denied: 'FORBIDDEN_HOST' },
                headers: { host: 'evil.example' + 'x'.repeat(500) },
                response: { statusCode: 403, source: { ok: false, code: 'FORBIDDEN_HOST' } },
            }))
            assert.equal(e2.denied, 'FORBIDDEN_HOST')
            assert.ok(e2.host.length <= 200)
            const e3 = buildAuditEntry(req({ appState: { denied: 'UNAUTHORIZED' }, headers: { authorization: 'Bearer wrong-token-12345678' }, response: { statusCode: 401, source: { ok: false, code: 'UNAUTHORIZED' } } }))
            assert.equal(e3.denied, 'UNAUTHORIZED')
            assert.equal(e3.origin, undefined)
            assert.equal(e3.host, undefined)
            assert.ok(!JSON.stringify(e3).includes('wrong-token'))
        })
        it('A03 Origin／Host 只記通過語法檢查之值：帳密、路徑、查詢字串不落檔；無法解析者記 <invalid>', () => {
            const o = (origin) => buildAuditEntry(req({ routePath: '/{p*}', appState: { denied: 'FORBIDDEN_ORIGIN' }, headers: { origin }, response: { statusCode: 403, source: { ok: false, code: 'FORBIDDEN_ORIGIN' } } })).origin
            assert.equal(o('https://user:pw@evil.example/p?token=SECRET#h'), 'https://evil.example')
            assert.equal(o('http://evil.example:8080'), 'http://evil.example:8080')
            assert.equal(o('null'), 'null')
            assert.equal(o('not an origin'), '<invalid>')
            assert.equal(o('javascript:alert(1)'), '<invalid>')
            const h = (host) => buildAuditEntry(req({ routePath: '/{p*}', appState: { denied: 'FORBIDDEN_HOST' }, headers: { host }, response: { statusCode: 403, source: { ok: false, code: 'FORBIDDEN_HOST' } } })).host
            assert.equal(h('evil.example:7000'), 'evil.example:7000')
            assert.equal(h('[::1]:7000'), '[::1]:7000')
            assert.equal(h('user:pw@evil.example'), '<invalid>')
            assert.equal(h('a b'), '<invalid>')
            assert.equal(h('evil.example/path?token=SECRET'), '<invalid>')
        })
        it('A01 結果欄：回應本體無 ok（例如 GET /chrome 之狀態快照）時以 HTTP 狀態推導；code 只收穩定代碼格式', () => {
            const snap = buildAuditEntry(req({ response: { statusCode: 200, source: { state: 'open', url: 'https://example.com/' } } }))
            assert.equal(snap.ok, true)
            assert.equal(snap.code, undefined)
            assert.equal(buildAuditEntry(req({ response: { statusCode: 500, source: { error: 'x' } } })).ok, false)
            assert.equal(buildAuditEntry(req({ response: null })).ok, undefined, '無回應（斷線）不推導')
            const weird = buildAuditEntry(req({ response: { statusCode: 200, source: { ok: false, code: 'contains secret detail and spaces' } } }))
            assert.equal(weird.ok, false)
            assert.equal(weird.code, undefined, '非穩定代碼格式者不記')
        })
        it('A03 未註冊路徑被拒：過長片段（可能是被誤放進路徑的 token）遮蔽為 <long>；已註冊路由記路由樣板而非原始路徑', () => {
            const e = buildAuditEntry(req({ routePath: '/{p*}', appState: { denied: 'FORBIDDEN_HOST' }, over: { path: '/probe/abcdefghijklmnopqrstuvwxyz0123456789/x' }, headers: { host: 'evil.example' }, response: { statusCode: 403, source: { ok: false, code: 'FORBIDDEN_HOST' } } }))
            assert.equal(e.path, '/probe/<long>/x')
            const r = buildAuditEntry(req({ appState: { denied: 'UNAUTHORIZED' }, over: { path: '/mouse/click' }, response: { statusCode: 401, source: { ok: false, code: 'UNAUTHORIZED' } } }))
            assert.equal(r.path, '/mouse/click')
        })
        it('A01 不記：公開路由成功（/health）、未註冊路徑之 404、預檢成功', () => {
            assert.equal(buildAuditEntry(req({ routePath: '/health', app: { public: true }, over: { path: '/health', method: 'get' } })), null)
            assert.equal(buildAuditEntry(req({ routePath: '/{p*}', over: { path: '/no/such' }, response: { statusCode: 404, source: { error: 'Not Found' } } })), null)
            assert.equal(buildAuditEntry(req({ routePath: '/{p*}', over: { method: 'options' }, response: { statusCode: 200 } })), null)
        })
        it('A03 公開路由被拒（/health 遇外站 Origin）仍記；未註冊路徑被拒（Host 不符）仍記', () => {
            const a = buildAuditEntry(req({ routePath: '/health', app: { public: true }, appState: { denied: 'FORBIDDEN_ORIGIN' }, headers: { origin: 'https://evil.example' }, over: { path: '/health', method: 'get' }, response: { statusCode: 403, source: { ok: false, code: 'FORBIDDEN_ORIGIN' } } }))
            assert.equal(a.path, '/health')
            assert.equal(a.denied, 'FORBIDDEN_ORIGIN')
            const b = buildAuditEntry(req({ routePath: '/{p*}', appState: { denied: 'FORBIDDEN_HOST' }, headers: { host: 'evil.example' }, over: { path: '/probe' }, response: { statusCode: 403, source: { ok: false, code: 'FORBIDDEN_HOST' } } }))
            assert.equal(b.path, '/probe')
        })
        it('A01 Boom 錯誤回應（無 source）、連線中斷（response=null）、IPv4-mapped 位址、過長路徑', () => {
            const boom = buildAuditEntry(req({ response: { isBoom: true, output: { statusCode: 400 } } }))
            assert.equal(boom.status, 400)
            assert.equal(boom.ok, false)
            const aborted = buildAuditEntry(req({ response: null }))
            assert.equal(aborted.status, 0)
            const mapped = buildAuditEntry(req({ ip: '::ffff:192.168.1.5' }))
            assert.equal(mapped.ip, '192.168.1.5')
            // 請求一開始記下的位址（app.auditIp）優先；socket 位址已不可得（空字串）時仍可記
            const gone = { remoteAddress: '', received: 1790000000000, responded: 1790000000042 }
            const early = buildAuditEntry(req({ over: { info: gone }, appState: { auditIp: '10.1.2.3' } }))
            assert.equal(early.ip, '10.1.2.3')
            assert.equal(buildAuditEntry(req({ over: { info: gone }, appState: {} })).ip, '')
            const long = buildAuditEntry(req({ routePath: '/{p*}', appState: { denied: 'FORBIDDEN_HOST' }, over: { path: '/' + 'a'.repeat(1000) } }))
            assert.ok(long.path.length <= 200)
        })
        it('A01 路徑為使用者可控字串：含換行／引號時仍是單行合法 JSON', () => {
            const e = buildAuditEntry(req({ routePath: '/{p*}', appState: { denied: 'UNAUTHORIZED' }, over: { path: '/a\nb"c' }, response: { statusCode: 401, source: { ok: false, code: 'UNAUTHORIZED' } } }))
            const line = JSON.stringify(e)
            assert.ok(!line.includes('\n'))
            assert.equal(JSON.parse(line).path, '/a\nb"c')
        })
    })

    // ───────────────────────────────────────────────────────────
    describe('createAuditLogger：寫入、輪替、失敗', () => {
        const mk = (name, extra = {}) => {
            const d = path.join(fdTmp, name)
            fs.rmSync(d, { recursive: true, force: true })
            const file = path.join(d, 'audit.jsonl')
            const warns = []
            const lg = createAuditLogger({ file, maxBytes: 1024, keep: 3, ...extra.cfg }, { warn: (m) => warns.push(m), ...extra.deps })
            return { d, file, warns, lg }
        }
        const entry = (i) => ({ ts: 't', method: 'POST', path: '/mouse/click', ip: '127.0.0.1', status: 200, ms: 1, ok: true, params: { x: i, y: i } })

        it('A04 預設值：上限 5 MiB、保留 5 份', () => {
            assert.equal(DEFAULT_AUDIT_MAX_BYTES, 5 * 1024 * 1024)
            assert.equal(DEFAULT_AUDIT_KEEP, 5)
        })

        it('A04 目錄不存在時於首次寫入才建立；一筆一行 JSONL', () => {
            const { d, file, lg } = mk('basic')
            assert.equal(fs.existsSync(d), false, '建立 logger 時不得建立目錄或檔案（延遲到首次寫入）')
            lg.write(entry(1))
            lg.write(entry(2))
            const got = lines(file)
            assert.deepEqual(got.map((x) => x.params.x), [1, 2])
            assert.equal(fs.readFileSync(file, 'utf8').split('\n').length, 3)
        })

        it('A04 POSIX：目錄 0700、檔案 0600', function() {
            if (process.platform === 'win32') this.skip()
            const { d, file, lg } = mk('perm')
            lg.write(entry(1))
            assert.equal(fs.statSync(file).mode & 0o777, 0o600)
            assert.equal(fs.statSync(d).mode & 0o777, 0o700)
        })

        it('A04 輪替：超過上限即改名 .1 並保留 keep 份、更舊者刪除、每份不超過上限、保留者為連續的最新紀錄且順序不亂', () => {
            const { d, file, lg } = mk('rotate')
            const N = 80
            for (let i = 1; i <= N; i++) lg.write(entry(i))
            const names = fs.readdirSync(d).sort()
            assert.deepEqual(names, ['audit.jsonl', 'audit.jsonl.1', 'audit.jsonl.2', 'audit.jsonl.3'])
            for (const n of names) assert.ok(fs.statSync(path.join(d, n)).size <= 1024, `${n} 超過上限`)
            // .3 最舊 → .1 → 目前檔最新
            const seq = [3, 2, 1].map((k) => lines(`${file}.${k}`)).flat().concat(lines(file)).map((x) => x.params.x)
            assert.equal(seq[seq.length - 1], N, '最新一筆必在目前檔')
            for (let i = 1; i < seq.length; i++) assert.equal(seq[i], seq[i - 1] + 1, '保留之紀錄應連續遞增')
            assert.ok(seq[0] > 1, '更舊的紀錄應已被丟棄')
        })

        it('A04 keep=0：不保留舊檔（超過上限即清掉重寫），總量仍有界', () => {
            const { d, file, lg } = mk('keep0', { cfg: { keep: 0 } })
            for (let i = 1; i <= 60; i++) lg.write(entry(i))
            assert.deepEqual(fs.readdirSync(d), ['audit.jsonl'])
            assert.ok(fs.statSync(file).size <= 1024)
            const xs = lines(file).map((x) => x.params.x)
            assert.equal(xs[xs.length - 1], 60)
        })

        it('A04 單筆即超過上限：仍完整寫入（不拆行、不丟棄），下一筆再輪替', () => {
            const { d, file, lg } = mk('big', { cfg: { maxBytes: 1024, keep: 1 } })
            lg.write({ ...entry(1), pad: 'p'.repeat(3000) })
            lg.write(entry(2))
            assert.deepEqual(fs.readdirSync(d).sort(), ['audit.jsonl', 'audit.jsonl.1'])
            assert.equal(lines(`${file}.1`)[0].params.x, 1)
            assert.equal(lines(file)[0].params.x, 2)
        })

        it('A04 既有檔案已有內容：沿用其大小計算輪替（重啟後不會從 0 開始無限成長）', () => {
            const { d, file } = mk('resume')
            fs.mkdirSync(d, { recursive: true })
            fs.writeFileSync(file, ('x'.repeat(99) + '\n').repeat(10)) // 1000 bytes
            const lg = createAuditLogger({ file, maxBytes: 1024, keep: 2 }, { warn() {} })
            lg.write(entry(1))
            assert.ok(fs.existsSync(`${file}.1`), '應已輪替')
            assert.equal(lines(file).length, 1)
        })

        it('A04 寫檔失敗（磁碟滿）：write 不丟例外；console 只警告一次；恢復成功後再失敗才再警告一次', () => {
            let failing = true
            const fsApi = {
                ...fs,
                appendFileSync(...a) {
                    if (failing) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
                    return fs.appendFileSync(...a)
                }
            }
            const { file, warns, lg } = mk('fail', { deps: { fsApi } })
            for (let i = 0; i < 5; i++) assert.doesNotThrow(() => lg.write(entry(i)))
            assert.equal(warns.length, 1, '連續失敗只警告一次')
            assert.match(warns[0], /ENOSPC/)
            assert.match(warns[0], new RegExp(file.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')))
            failing = false
            lg.write(entry(100))
            assert.equal(lines(file).at(-1).params.x, 100)
            failing = true
            for (let i = 0; i < 3; i++) lg.write(entry(i))
            assert.equal(warns.length, 2, '恢復後再失敗會再警告一次')
        })

        it('A04 目錄中途被刪除（ENOENT）→ 重建目錄後重試，紀錄不遺失', () => {
            const { d, file, lg } = mk('enoent')
            lg.write(entry(1))
            fs.rmSync(d, { recursive: true, force: true })
            lg.write(entry(2))
            assert.deepEqual(lines(file).map((x) => x.params.x), [2])
        })

        it('A04 輪替失敗（改名被拒）：不丟例外、警告一次、超過上限時丟棄新紀錄而非無限成長', () => {
            const fsApi = {
                ...fs,
                renameSync() {
                    throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
                }
            }
            const { file, warns, lg } = mk('rotfail', { deps: { fsApi } })
            for (let i = 1; i <= 100; i++) assert.doesNotThrow(() => lg.write(entry(i)))
            assert.equal(warns.length, 1)
            assert.match(warns[0], /EPERM/)
            assert.ok(fs.statSync(file).size <= 1024, '輪替失敗時檔案仍須有界')
        })

        it('A04 部分寫入後失敗（只寫進一半就 ENOSPC）：下一筆仍是可獨立解析的完整一行，殘行不黏到下一筆', () => {
            let failNext = true
            const fsApi = {
                ...fs,
                appendFileSync(f, line, o) {
                    if (failNext) {
                        failNext = false
                        fs.appendFileSync(f, line.slice(0, 9), o) // 只寫進一半
                        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
                    }
                    return fs.appendFileSync(f, line, o)
                }
            }
            const { file, lg } = mk('partial', { deps: { fsApi } })
            fs.mkdirSync(path.dirname(file), { recursive: true }) // 目錄先存在，才會真的「寫進一半」而不是先遇到 ENOENT
            lg.write(entry(1))
            lg.write(entry(2))
            lg.write(entry(3))
            const raw = fs.readFileSync(file, 'utf8').split('\n').filter((x) => x !== '')
            const parsed = raw.map((x) => {
                try {
                    return JSON.parse(x)
                }
                catch {
                    return null
                }
            })
            assert.equal(parsed[0], null, '殘行本身無法解析（可接受）')
            assert.deepEqual(parsed.slice(1).map((x) => x.params.x), [2, 3], '之後的每一筆都必須可獨立解析')
        })

        it('A04 大小以實際檔案為準（不快取）：部分寫入失敗、兩個 logger 共用同一檔，檔案仍不超過上限', () => {
            const d = path.join(fdTmp, 'shared')
            fs.rmSync(d, { recursive: true, force: true })
            const file = path.join(d, 'a.jsonl')
            const a = createAuditLogger({ file, maxBytes: 1024, keep: 1 }, { warn() {} })
            const b = createAuditLogger({ file, maxBytes: 1024, keep: 1 }, { warn() {} })
            for (let i = 0; i < 60; i++) (i % 2 ? a : b).write(entry(i))
            assert.ok(fs.statSync(file).size <= 1024, `實際 ${fs.statSync(file).size} bytes`)
            let failing = 100
            const fsApi = {
                ...fs,
                appendFileSync(f, line, o) {
                    if (failing-- > 0) {
                        fs.appendFileSync(f, line.slice(0, 60), o) // 每次失敗都留下 60 位元組殘行
                        throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
                    }
                    return fs.appendFileSync(f, line, o)
                }
            }
            const f2 = path.join(d, 'b.jsonl')
            const c = createAuditLogger({ file: f2, maxBytes: 1024, keep: 1 }, { fsApi, warn() {} })
            for (let i = 0; i < 100; i++) c.write(entry(i))
            assert.ok(fs.statSync(f2).size <= 1024, `部分寫入失敗時檔案不得無限成長：${fs.statSync(f2).size} bytes（快取大小的作法會長到約 6000）`)
        })

        it('A04 UTF-8 位元組計算：寫入非 ASCII 內容時，以實際位元組（不是字元數）判斷上限', () => {
            const { d, file, lg } = mk('utf8', { cfg: { maxBytes: 1024, keep: 2 } })
            // 一行約 209 字元／369 位元組：兩行（738）之後再加一行，以字元數估算為 947（≤1024，會誤判可容納）、以位元組為 1107（須輪替）
            const note = '密'.repeat(80)
            const probe = JSON.stringify({ ...entry(1), note }) + '\n'
            assert.ok(2 * Buffer.byteLength(probe) + probe.length <= 1024 && 3 * Buffer.byteLength(probe) > 1024, '夾具前提：字元數估算與位元組估算須在第三行分歧')
            for (let i = 1; i <= 30; i++) {
                lg.write({ ...entry(i), note })
                // 每寫一筆就檢查（不能只看最後狀態：超限的檔案之後會被輪替掉而掩蓋錯誤）
                assert.ok(fs.statSync(file).size <= 1024, `第 ${i} 筆後目前檔 ${fs.statSync(file).size} bytes`)
            }
            for (const n of fs.readdirSync(d)) assert.ok(fs.statSync(path.join(d, n)).size <= 1024, `${n} ${fs.statSync(path.join(d, n)).size} bytes`)
            assert.equal(lines(file).at(-1).params.x, 30)
        })

        it('A04 輪替失敗後可重試且不吃掉既有歷史：目前檔改名先失敗三次（被占用）→ 各備份原封不動；恢復後正常輪替', () => {
            let renameFail = 0
            const fsApi = {
                ...fs,
                renameSync(a, b) {
                    if (renameFail > 0 && a === file0) {
                        renameFail--
                        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
                    }
                    return fs.renameSync(a, b)
                }
            }
            const d = path.join(fdTmp, 'rot-retry')
            fs.rmSync(d, { recursive: true, force: true })
            fs.mkdirSync(d, { recursive: true })
            const file0 = path.join(d, 'a.jsonl')
            const wr = (f, xs) => fs.writeFileSync(f, xs.map((x) => JSON.stringify(entry(x)) + '\n').join(''))
            wr(file0, [10, 11])
            wr(`${file0}.1`, [8, 9])
            wr(`${file0}.2`, [6, 7])
            wr(`${file0}.3`, [4, 5])
            const warns = []
            const lg = createAuditLogger({ file: file0, maxBytes: 250, keep: 3 }, { fsApi, warn: (m) => warns.push(m) })
            renameFail = 3
            for (const x of [12, 13, 14]) lg.write(entry(x)) // 三次輪替都失敗：新紀錄被丟棄，歷史必須完整
            assert.deepEqual([file0, `${file0}.1`, `${file0}.2`, `${file0}.3`].map((f) => lines(f).map((x) => x.params.x)), [[10, 11], [8, 9], [6, 7], [4, 5]])
            assert.equal(warns.length, 1)
            lg.write(entry(15)) // 恢復：正常輪替，最舊的 [4,5] 才被擠出
            assert.deepEqual([file0, `${file0}.1`, `${file0}.2`, `${file0}.3`].map((f) => lines(f).map((x) => x.params.x)), [[15], [10, 11], [8, 9], [6, 7]])
            assert.equal(fs.existsSync(`${file0}.rotating`), false)
        })

        it('A04 輪替中途（搬移舊檔時）失敗：目前檔還原、不留暫存檔，紀錄與歷史不遺失（僅最舊一份可能已被擠出）', () => {
            const d = path.join(fdTmp, 'rot-mid')
            fs.rmSync(d, { recursive: true, force: true })
            fs.mkdirSync(d, { recursive: true })
            const file0 = path.join(d, 'a.jsonl')
            const wr = (f, xs) => fs.writeFileSync(f, xs.map((x) => JSON.stringify(entry(x)) + '\n').join(''))
            wr(file0, [10, 11])
            wr(`${file0}.1`, [8, 9])
            wr(`${file0}.2`, [6, 7])
            const fsApi = {
                ...fs,
                renameSync(a, b) {
                    if (a === `${file0}.1`) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
                    return fs.renameSync(a, b)
                }
            }
            const lg = createAuditLogger({ file: file0, maxBytes: 250, keep: 3 }, { fsApi, warn() {} })
            lg.write(entry(12))
            assert.deepEqual(lines(file0).map((x) => x.params.x), [10, 11], '目前檔須還原')
            assert.equal(fs.existsSync(`${file0}.rotating`), false)
            assert.deepEqual(lines(`${file0}.1`).map((x) => x.params.x), [8, 9])
        })

        it('A04 調降保留份數後：首次寫入即刪除超出 keep 的舊輪替檔（keep=0 → 全刪）', () => {
            for (const [keep, left] of [[2, ['a.jsonl.1', 'a.jsonl.2']], [0, []]]) {
                const d = path.join(fdTmp, `prune${keep}`)
                fs.rmSync(d, { recursive: true, force: true })
                fs.mkdirSync(d, { recursive: true })
                for (const n of ['a.jsonl.1', 'a.jsonl.2', 'a.jsonl.3', 'a.jsonl.4']) fs.writeFileSync(path.join(d, n), 'old\n')
                const lg = createAuditLogger({ file: path.join(d, 'a.jsonl'), maxBytes: 1024, keep }, { warn() {} })
                lg.write(entry(1))
                assert.deepEqual(fs.readdirSync(d).filter((n) => n !== 'a.jsonl').sort(), left, `keep=${keep}`)
            }
        })

        it('A02 redact：目前 token 全文不論經哪個載體進到紀錄項（路徑、Origin、params…），寫檔前一律清除（含 JSON 跳脫形式）；過短者不處理', () => {
            const TOKEN = 'tok-0123456789abcdef-XYZ'
            const QUOTED = 'ab"cd\\ef-0123456789'
            const { file, lg } = mk('redact', { cfg: { maxBytes: 100000, redact: [TOKEN, QUOTED, 'short'] } })
            lg.write({ ...entry(1), path: `/probe/${TOKEN}`, origin: `https://x.example/${TOKEN}`, params: { url: `https://h/${QUOTED}`, note: 'short-word' } })
            const raw = fs.readFileSync(file, 'utf8')
            assert.ok(!raw.includes(TOKEN))
            assert.ok(!raw.includes('ab\\"cd\\\\ef-0123456789') && !raw.includes(QUOTED))
            assert.ok(raw.includes('<redacted>'))
            assert.ok(raw.includes('short-word'), '長度不足 8 者不處理（避免誤傷）')
            assert.equal(JSON.parse(raw.trim()).path, '/probe/<redacted>')
        })

        it('A04 POSIX 權限：既有檔案寬於 0600 時於首次寫入後收緊（mode 參數只對新建檔案生效）；Windows 不處理；已是 0600 不動', () => {
            const calls = []
            const mkApi = (mode) => ({
                ...fs,
                statSync(f) {
                    const st = fs.statSync(f)
                    return { size: st.size, mode }
                },
                chmodSync(f, m) {
                    calls.push([f, m])
                }
            })
            const run = (name, platform, mode) => {
                const { file, lg } = mk(name, { deps: { fsApi: mkApi(mode), platform } })
                lg.write(entry(1))
                lg.write(entry(2))
                return file
            }
            const f1 = run('chmod-linux', 'linux', 0o100644)
            assert.deepEqual(calls, [[f1, 0o600]], '寬於 0600 應收緊，且只做一次')
            calls.length = 0
            run('chmod-win', 'win32', 0o100644)
            run('chmod-ok', 'linux', 0o100600)
            assert.deepEqual(calls, [])
        })

        it('A04 logger 不吞掉非序列化問題：循環參照之 entry 不丟例外（記為警告）', () => {
            const { lg, warns } = mk('circ')
            const e = entry(1)
            e.self = e
            assert.doesNotThrow(() => lg.write(e))
            assert.equal(warns.length, 1)
        })

        it('A04 record(request)：對不該記的請求不寫檔；request 結構異常不丟例外', () => {
            const { file, lg } = mk('record')
            assert.doesNotThrow(() => lg.record(null))
            assert.doesNotThrow(() => lg.record({}))
            assert.equal(fs.existsSync(file), false)
        })
    })

    // ───────────────────────────────────────────────────────────
    describe('resolveSecurity：系統級開關與操作紀錄設定', () => {
        const R = (opt = {}, env = {}, ctx = { port: 7000 }) => resolveSecurity({ token: TOK, ...opt }, env, ctx)

        it('A05 enableSystem 預設 true；選項 > 環境變數；空環境變數＝未設（維持預設開）；不認得之值拒絕啟動', () => {
            assert.equal(R().enableSystem, true)
            assert.equal(R({ enableSystem: false }).enableSystem, false)
            assert.equal(R({}, { SCREENCTL_ENABLE_SYSTEM: '0' }).enableSystem, false)
            assert.equal(R({}, { SCREENCTL_ENABLE_SYSTEM: 'false' }).enableSystem, false)
            assert.equal(R({}, { SCREENCTL_ENABLE_SYSTEM: 'off' }).enableSystem, false)
            assert.equal(R({}, { SCREENCTL_ENABLE_SYSTEM: '' }).enableSystem, true)
            assert.equal(R({}, { SCREENCTL_ENABLE_SYSTEM: '1' }).enableSystem, true)
            assert.equal(R({ enableSystem: true }, { SCREENCTL_ENABLE_SYSTEM: '0' }).enableSystem, true)
            assert.equal(R({ enableSystem: false }, { SCREENCTL_ENABLE_SYSTEM: '1' }).enableSystem, false)
            assert.throws(() => R({}, { SCREENCTL_ENABLE_SYSTEM: 'maybe' }), /refusing to start/)
        })

        it('A05 開關型別從嚴：布林、0／1、可辨識字串才收；0 與 [] 之類不得被當成「未給」而使環境變數的關閉失效；空白選項視為未給（往環境變數找）', () => {
            const env0 = { SCREENCTL_ENABLE_SYSTEM: '0', SCREENCTL_AUDIT_LOG: '0', SCREENCTL_ENABLE_EVALUATE: '0' }
            assert.equal(R({ enableSystem: 0 }, { SCREENCTL_ENABLE_SYSTEM: '1' }).enableSystem, false)
            assert.equal(R({ enableSystem: 1 }, env0).enableSystem, true)
            assert.equal(R({ auditLog: 0 }, { SCREENCTL_AUDIT_LOG: '1' }).audit.enabled, false)
            assert.equal(R({ enableEvaluate: 1 }).evaluate, true)
            for (const bad of [2, -1, 0.5, NaN, [], [0], {}, 'x', 'enable', () => true]) {
                assert.throws(() => R({ enableSystem: bad }, env0), /refusing to start.*enableSystem/, String(bad))
                assert.throws(() => R({ auditLog: bad }, env0), /refusing to start.*auditLog/, String(bad))
                assert.throws(() => R({ enableEvaluate: bad }, env0), /refusing to start.*enableEvaluate/, String(bad))
            }
            // 空白選項＝未給：改看環境變數（與 host、token 等其他選項一致）
            assert.equal(R({ enableSystem: ' ' }, env0).enableSystem, false)
            assert.equal(R({ auditLog: '' }, env0).audit.enabled, false)
            assert.equal(R({ enableSystem: '' }).enableSystem, true)
        })

        it('A04 auditLogFile 非字串（false／數字／物件／陣列）→ 拒絕啟動，不默默改用環境變數或預設位置；空白視為未給', () => {
            const f = path.join(fdTmp, 'x.jsonl')
            for (const bad of [false, true, 123, {}, [], [f]]) {
                assert.throws(() => R({ auditLogFile: bad }, { SCREENCTL_AUDIT_LOG_FILE: f }), /refusing to start.*auditLogFile/, JSON.stringify(bad))
            }
            assert.equal(R({ auditLogFile: ' ' }, { SCREENCTL_AUDIT_LOG_FILE: f }).audit.file, f)
            assert.equal(R({ auditLogFile: undefined }).audit.file, defaultAuditFile(7000, '127.0.0.1'))
            assert.equal(R({ auditLogFile: null }).audit.file, defaultAuditFile(7000, '127.0.0.1'))
        })

        it('A04 上限／份數來源衝突：選項優先於環境變數；空白選項改看環境變數', () => {
            assert.equal(R({ auditLogKeep: 1 }, { SCREENCTL_AUDIT_LOG_KEEP: '3' }).audit.keep, 1)
            assert.equal(R({ auditLogKeep: 0 }, { SCREENCTL_AUDIT_LOG_KEEP: '3' }).audit.keep, 0)
            assert.equal(R({ auditLogKeep: ' ' }, { SCREENCTL_AUDIT_LOG_KEEP: '3' }).audit.keep, 3)
            assert.equal(R({ auditLogMaxBytes: 4096 }, { SCREENCTL_AUDIT_LOG_MAX_BYTES: '8192' }).audit.maxBytes, 4096)
            assert.equal(R({ auditLogMaxBytes: '' }, { SCREENCTL_AUDIT_LOG_MAX_BYTES: '8192' }).audit.maxBytes, 8192)
        })

        it('A05 enableEvaluate 之既有語意不變（預設 false、空環境變數＝false）', () => {
            assert.equal(R().evaluate, false)
            assert.equal(R({}, { SCREENCTL_ENABLE_EVALUATE: '' }).evaluate, false)
            assert.equal(R({}, { SCREENCTL_ENABLE_EVALUATE: '1' }).evaluate, true)
        })

        it('A04 操作紀錄預設：開啟、預設檔位於使用者目錄之 .w-screenctl（檔名含 port）、5 MiB、保留 5 份', () => {
            const a = R().audit
            assert.equal(a.enabled, true)
            assert.equal(a.file, defaultAuditFile(7000, '127.0.0.1'))
            assert.equal(path.basename(a.file), 'audit-7000.jsonl')
            assert.equal(path.dirname(a.file), path.dirname(defaultTokenFile(7000, '127.0.0.1')), '與 token 檔同目錄')
            assert.equal(a.maxBytes, 5 * 1024 * 1024)
            assert.equal(a.keep, 5)
        })

        it('A04 預設檔名：非預設位址含位址段（同 port 不同位址之實例不共用）', () => {
            const home = () => '/home/u'
            assert.equal(defaultAuditFile(7000, undefined, home), path.join('/home/u', '.w-screenctl', 'audit-7000.jsonl'))
            assert.equal(defaultAuditFile(7000, '::1', home), path.join('/home/u', '.w-screenctl', 'audit-__1-7000.jsonl'))
            assert.equal(defaultAuditFile(7000, '127.0.0.2', home), path.join('/home/u', '.w-screenctl', 'audit-127.0.0.2-7000.jsonl'))
            assert.equal(R({ host: '127.0.0.2' }, {}, { port: 7001 }).audit.file, defaultAuditFile(7001, '127.0.0.2'))
        })

        it('A05 操作紀錄可關閉：選項 auditLog:false、環境變數 SCREENCTL_AUDIT_LOG=0；選項 > 環境變數；預設開', () => {
            assert.equal(R({ auditLog: false }).audit.enabled, false)
            assert.equal(R({}, { SCREENCTL_AUDIT_LOG: '0' }).audit.enabled, false)
            assert.equal(R({}, { SCREENCTL_AUDIT_LOG: 'no' }).audit.enabled, false)
            assert.equal(R({}, { SCREENCTL_AUDIT_LOG: '' }).audit.enabled, true)
            assert.equal(R({ auditLog: true }, { SCREENCTL_AUDIT_LOG: '0' }).audit.enabled, true)
            assert.equal(R({ auditLog: false }, { SCREENCTL_AUDIT_LOG: '1' }).audit.enabled, false)
            assert.throws(() => R({}, { SCREENCTL_AUDIT_LOG: 'maybe' }), /refusing to start/)
        })

        it('A04 路徑、上限、份數：選項 > 環境變數；相對路徑轉絕對；空白視為未給', () => {
            const f = path.join(fdTmp, 'x.jsonl')
            assert.equal(R({ auditLogFile: f }).audit.file, f)
            assert.equal(R({}, { SCREENCTL_AUDIT_LOG_FILE: f }).audit.file, f)
            assert.equal(R({ auditLogFile: f }, { SCREENCTL_AUDIT_LOG_FILE: '/other/y.jsonl' }).audit.file, f)
            assert.equal(R({ auditLogFile: './rel.jsonl' }).audit.file, path.resolve('./rel.jsonl'))
            assert.equal(R({ auditLogFile: '   ' }).audit.file, defaultAuditFile(7000, '127.0.0.1'))
            assert.equal(R({ auditLogMaxBytes: 4096 }).audit.maxBytes, 4096)
            assert.equal(R({}, { SCREENCTL_AUDIT_LOG_MAX_BYTES: '8192' }).audit.maxBytes, 8192)
            assert.equal(R({ auditLogMaxBytes: 4096 }, { SCREENCTL_AUDIT_LOG_MAX_BYTES: '8192' }).audit.maxBytes, 4096)
            assert.equal(R({ auditLogKeep: 0 }).audit.keep, 0)
            assert.equal(R({}, { SCREENCTL_AUDIT_LOG_KEEP: '2' }).audit.keep, 2)
        })

        it('A04 上限／份數不合規格 → 拒絕啟動（不默默退回預設）', () => {
            for (const bad of ['abc', 100, 1023, 1.5, -1, 2 ** 31, '1e3x', true, {}]) {
                assert.throws(() => R({ auditLogMaxBytes: bad }), /refusing to start.*audit/i, `maxBytes=${String(bad)}`)
            }
            for (const bad of ['abc', -1, 101, 1.5, true, {}]) {
                assert.throws(() => R({ auditLogKeep: bad }), /refusing to start.*audit/i, `keep=${String(bad)}`)
            }
            assert.throws(() => R({}, { SCREENCTL_AUDIT_LOG_MAX_BYTES: 'many' }), /refusing to start/)
            assert.throws(() => R({}, { SCREENCTL_AUDIT_LOG_KEEP: '-3' }), /refusing to start/)
        })
    })

    describe('describeSecurity：啟動時印出目前啟用之能力', () => {
        const D = (opt, env = {}) => describeSecurity(resolveSecurity({ token: TOK, ...opt }, env, { port: 7000 }))

        it('A05 預設：capabilities 行列出 chrome／系統級／evaluate／紀錄路徑，不帶警告', () => {
            const { info, warn } = D({ auditLogFile: path.join(fdTmp, 'cap.jsonl') })
            const line = info.find((x) => /capabilities/.test(x))
            assert.ok(line, info.join('\n'))
            assert.match(line, /system\(mouse\/keyboard\/screenshot\)=on/)
            assert.match(line, /evaluate=off/)
            assert.ok(line.includes(path.join(fdTmp, 'cap.jsonl')))
            assert.deepEqual(warn, [])
        })
        it('A05 系統級關閉／evaluate 開啟／紀錄關閉：各自標示，紀錄關閉另有警告', () => {
            const { info, warn } = D({ enableSystem: false, enableEvaluate: true, auditLog: false })
            const line = info.find((x) => /capabilities/.test(x))
            assert.match(line, /system\(mouse\/keyboard\/screenshot\)=DISABLED/)
            assert.match(line, /evaluate=ON/)
            assert.match(line, /audit-log=OFF/)
            assert.ok(warn.some((x) => /audit log is OFF/i.test(x)), warn.join('\n'))
        })
    })
})
