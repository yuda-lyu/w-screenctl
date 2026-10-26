// unit：src/security.mjs（設定解析、迴路判定、Host 解析、Bearer 定時比較、閘門邏輯）
// 每條斷言之 Rxx 對應 sgud/rule/rulebook.md 之 SEC-xx 規則。不綁 port、不碰使用者家目錄。

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    DEFAULT_HOST,
    isLoopbackHost,
    parseHostHeader,
    defaultTokenFile,
    persistToken,
    resolveSecurity,
    checkBearer,
    createGate,
    describeSecurity
} from '../src/security.mjs'

const fdTest = path.dirname(fileURLToPath(import.meta.url))
const fdTmp = path.join(fdTest, '_tmp', 'unit-security')

const TOK = 'unit-token-0123456789abcdef-QQ'
const TOK2 = 'unit-token-ZZZZZZZZZZZZZZZZZZZZ-2'

const sha = (s) => crypto.createHash('sha256').update(s).digest()

describe('unit-security', function() {

    before(() => fs.mkdirSync(fdTmp, { recursive: true }))
    after(() => fs.rmSync(fdTmp, { recursive: true, force: true }))

    describe('isLoopbackHost', () => {
        it('R01 迴路寫法 → true', () => {
            for (const h of ['127.0.0.1', '127.0.0.2', '127.255.255.254', 'localhost', 'LOCALHOST', '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']) {
                assert.equal(isLoopbackHost(h), true, h)
            }
        })
        it('R08 非迴路／認不得之寫法 → false（保守：須 token 才能啟動）', () => {
            for (const h of ['0.0.0.0', '::', '', ' ', '192.168.1.5', '10.0.0.1', '100.120.70.67', 'example.com', 'localhost.evil.com', '127.0.0.1.evil.com', '128.0.0.1', '::ffff:10.0.0.1', undefined, null, 127, '127.1']) {
                assert.equal(isLoopbackHost(h), false, String(h))
            }
        })
    })

    describe('parseHostHeader', () => {
        it('R06 合法 Host → 小寫主機名稱（去 port；IPv6 保留中括號）', () => {
            assert.equal(parseHostHeader('127.0.0.1:7000'), '127.0.0.1')
            assert.equal(parseHostHeader('LocalHost'), 'localhost')
            assert.equal(parseHostHeader('[::1]:7000'), '[::1]')
            assert.equal(parseHostHeader('example.com:80'), 'example.com')
        })
        it('R06 格式異常 → null', () => {
            for (const v of [undefined, null, '', 'a b', 'u@h', 'h:p', 'h:123456', 'h/x', 'a,b', '[::1', 'h@', 'localhost\u00a0', '\u00a0localhost', 'local\u00a0host']) {
                assert.equal(parseHostHeader(v), null, JSON.stringify(v))
            }
        })
        it('R06 外圍空白只認 SP／HTAB（RFC 7230 OWS），不認 NBSP 等 Unicode 空白', () => {
            assert.equal(parseHostHeader('  localhost:7000\t'), 'localhost')
        })
    })

    describe('defaultTokenFile', () => {
        it('R09 位於使用者家目錄 .w-screenctl 下，檔名含 port；非預設位址再含位址（同 port 不同位址之實例不共用同一檔）', () => {
            const home = () => '/home/u'
            assert.equal(defaultTokenFile(7000, undefined, home), path.join('/home/u', '.w-screenctl', 'token-7000'))
            assert.equal(defaultTokenFile(7000, '127.0.0.1', home), path.join('/home/u', '.w-screenctl', 'token-7000'))
            assert.equal(defaultTokenFile(7000, '::1', home), path.join('/home/u', '.w-screenctl', 'token-__1-7000'))
            assert.equal(defaultTokenFile(7000, 'localhost', home), path.join('/home/u', '.w-screenctl', 'token-localhost-7000'))
            assert.equal(defaultTokenFile(7000, '127.0.0.2', home), path.join('/home/u', '.w-screenctl', 'token-127.0.0.2-7000'))
            assert.notEqual(defaultTokenFile(7000, '::1', home), defaultTokenFile(7000, '127.0.0.1', home))
        })
        it('R09 resolveSecurity 依 host 選預設檔；預設檔可取代舊檔、明指之檔不可（persistReplace）', () => {
            assert.equal(resolveSecurity({ host: '::1' }, {}, { port: 7000 }).tokenFile, defaultTokenFile(7000, '::1'))
            assert.equal(resolveSecurity({}, {}, { port: 7000 }).persistReplace, true)
            assert.equal(resolveSecurity({ tokenFile: path.join(fdTmp, 'nofile.token') }, {}, { port: 7000 }).persistReplace, false)
        })
    })

    describe('resolveSecurity：預設值與優先序', () => {
        it('R01 全預設 → 127.0.0.1、迴路、自動產生 token（待寫入預設檔）、evaluate 關、無 CORS', () => {
            const c = resolveSecurity({}, {}, { port: 7000 })
            assert.equal(DEFAULT_HOST, '127.0.0.1')
            assert.equal(c.host, '127.0.0.1')
            assert.equal(c.loopback, true)
            assert.equal(c.tokenSource, 'generated')
            assert.equal(c.persist, true)
            assert.ok(c.token.length >= 32)
            assert.equal(c.tokenFile, defaultTokenFile(7000))
            assert.equal(c.evaluate, false)
            assert.deepEqual(c.allowedOrigins, [])
            assert.equal(c.cors, false)
            assert.equal(c.hostCheck, true)
            assert.deepEqual([...c.hostSet].sort(), ['127.0.0.1', '[::1]', 'localhost'])
        })

        it('R09 自動產生之 token 每次不同（隨機）、不寫檔（寫檔由呼叫端於啟動成功後執行）', () => {
            const f = path.join(fdTmp, 'nowrite.token')
            const a = resolveSecurity({ tokenFile: f }, {}, { port: 1 })
            const b = resolveSecurity({ tokenFile: f }, {}, { port: 1 })
            assert.notEqual(a.token, b.token)
            assert.equal(fs.existsSync(f), false)
            assert.equal(a.tokenFile, f)
        })

        it('R09 token 優先序：選項 > 環境變數 > 檔案 > 自動產生', () => {
            const f = path.join(fdTmp, 'prec.token')
            fs.writeFileSync(f, TOK2 + '\n')
            const env = { SCREENCTL_TOKEN: 'env-token-0123456789abcdef-E', SCREENCTL_TOKEN_FILE: f }
            assert.equal(resolveSecurity({ token: TOK }, env).token, TOK)
            assert.equal(resolveSecurity({ token: TOK }, env).tokenSource, 'option token')
            assert.equal(resolveSecurity({}, env).token, 'env-token-0123456789abcdef-E')
            assert.equal(resolveSecurity({}, { SCREENCTL_TOKEN_FILE: f }).token, TOK2)
            assert.equal(resolveSecurity({ tokenFile: f }, {}).token, TOK2)
            assert.equal(resolveSecurity({ tokenFile: f }, {}).persist, false)
            // 選項給 token 時 tokenFile 被忽略：不讀、不寫
            const r = resolveSecurity({ token: TOK, tokenFile: path.join(fdTmp, 'ignored.token') }, {})
            assert.equal(r.persist, false)
            assert.equal(r.tokenFile, null)
        })

        it('R09 tokenFile 給相對路徑時轉為絕對路徑（啟動輸出才指得到實際檔案）', () => {
            const c = resolveSecurity({ tokenFile: './rel-path.token' }, {})
            assert.ok(path.isAbsolute(c.tokenFile), c.tokenFile)
            assert.equal(c.tokenFile, path.resolve('./rel-path.token'))
        })

        it('R09 token 檔：去除 UTF-8 BOM 與前後空白／換行', () => {
            const f = path.join(fdTmp, 'bom.token')
            fs.writeFileSync(f, '﻿' + TOK + '\r\n')
            assert.equal(resolveSecurity({ tokenFile: f }, {}).token, TOK)
        })

        it('R11 token 檔為空／內容不合規格／是資料夾 → 拒絕啟動（不自動覆寫）', () => {
            const fe = path.join(fdTmp, 'empty.token')
            fs.writeFileSync(fe, '  \n')
            assert.throws(() => resolveSecurity({ tokenFile: fe }, {}), /refusing to start.*empty/)
            const fb = path.join(fdTmp, 'bad.token')
            fs.writeFileSync(fb, 'short')
            assert.throws(() => resolveSecurity({ tokenFile: fb }, {}), /refusing to start.*token/)
            assert.equal(fs.readFileSync(fb, 'utf8'), 'short')
            assert.throws(() => resolveSecurity({ tokenFile: fdTmp }, {}), /refusing to start/)
        })

        it('R11 token 規格：< 16、內含空白／Tab／換行／NUL／DEL 等控制字元、中文、> 256 → 拒絕，且錯誤訊息不含 token', () => {
            const a = 'a'.repeat(16)
            const bads = [
                'a'.repeat(15),
                'a'.repeat(8) + ' ' + 'b'.repeat(8),
                a + '\t' + a,
                a + '\n' + a,
                a + '\0' + a,
                a + '\x7f' + a,
                a + '\x1b[31m' + a,
                '密碼密碼密碼密碼密碼密碼密碼密碼',
                a + '\u00a0' + a,
                'a'.repeat(257),
            ]
            for (const bad of bads) {
                assert.throws(() => resolveSecurity({ token: bad }, {}), (e) => e.code === 'SCREENCTL_CONFIG' && !e.message.includes(bad), JSON.stringify(bad))
            }
            assert.doesNotThrow(() => resolveSecurity({ token: 'a'.repeat(16) }, {}))
            assert.doesNotThrow(() => resolveSecurity({ token: 'a'.repeat(256) }, {}))
        })

        it('R11 無法用任何值停用驗證：false/null/空字串/空白/數字 → 視為未給，迴路改自動產生；非迴路拒絕', () => {
            for (const v of [false, null, undefined, '', '   ', 0, 1234567890123456]) {
                const c = resolveSecurity({ token: v }, {})
                assert.equal(c.tokenSource, 'generated', JSON.stringify(v))
                assert.ok(c.token.length >= 32)
                assert.throws(() => resolveSecurity({ token: v, host: '0.0.0.0' }, {}), /refusing to start/)
            }
            assert.throws(() => resolveSecurity({ host: '0.0.0.0' }, { SCREENCTL_TOKEN: '' }), /refusing to start/)
            assert.throws(() => resolveSecurity({ host: '0.0.0.0' }, { SCREENCTL_TOKEN: '   ', SCREENCTL_TOKEN_FILE: '' }), /refusing to start/)
        })

        it('R08 host 優先序：選項 > 環境變數 > 預設；非迴路無 token → 拒絕，附設定指引', () => {
            assert.equal(resolveSecurity({ host: 'localhost' }, { SCREENCTL_HOST: '0.0.0.0' }).host, 'localhost')
            assert.equal(resolveSecurity({}, { SCREENCTL_HOST: '127.0.0.2' }).host, '127.0.0.2')
            assert.equal(resolveSecurity({ host: '[::1]' }, {}).host, '::1')
            for (const h of ['0.0.0.0', '::', '192.168.1.5', 'myhost.lan']) {
                assert.throws(() => resolveSecurity({ host: h }, {}), (e) => {
                    return e.code === 'SCREENCTL_CONFIG' && /refusing to start/.test(e.message) && /SCREENCTL_TOKEN/.test(e.message) && e.message.includes(h)
                })
            }
            assert.throws(() => resolveSecurity({}, { SCREENCTL_HOST: '0.0.0.0' }), /refusing to start/)
        })

        it('R08 非迴路 + 明給 token → 允許；Host 檢查預設不啟用，設 allowedHosts 才啟用', () => {
            const a = resolveSecurity({ host: '0.0.0.0', token: TOK }, {})
            assert.equal(a.loopback, false)
            assert.equal(a.hostCheck, false)
            const b = resolveSecurity({ host: '0.0.0.0', token: TOK, allowedHosts: ['Screenctl.Lan:7000'] }, {})
            assert.equal(b.hostCheck, true)
            assert.deepEqual([...b.hostSet], ['screenctl.lan'])
        })

        it('R08 非迴路 + 已存在之 token 檔 → 允許；token 檔不存在 → 拒絕（不得以自動產生蒙混）', () => {
            const f = path.join(fdTmp, 'nonloop.token')
            fs.writeFileSync(f, TOK)
            assert.equal(resolveSecurity({ host: '0.0.0.0', tokenFile: f }, {}).token, TOK)
            fs.rmSync(f)
            assert.throws(() => resolveSecurity({ host: '0.0.0.0', tokenFile: f }, {}), /refusing to start/)
        })

        it('R07 enableEvaluate：預設 false；選項 > 環境變數；字串開關；不認得之值 → 拒絕', () => {
            assert.equal(resolveSecurity({}, {}).evaluate, false)
            assert.equal(resolveSecurity({ enableEvaluate: true }, {}).evaluate, true)
            assert.equal(resolveSecurity({}, { SCREENCTL_ENABLE_EVALUATE: '1' }).evaluate, true)
            assert.equal(resolveSecurity({}, { SCREENCTL_ENABLE_EVALUATE: 'TRUE' }).evaluate, true)
            assert.equal(resolveSecurity({}, { SCREENCTL_ENABLE_EVALUATE: '0' }).evaluate, false)
            assert.equal(resolveSecurity({ enableEvaluate: false }, { SCREENCTL_ENABLE_EVALUATE: '1' }).evaluate, false)
            assert.equal(resolveSecurity({ enableEvaluate: true }, { SCREENCTL_ENABLE_EVALUATE: '0' }).evaluate, true)
            assert.throws(() => resolveSecurity({}, { SCREENCTL_ENABLE_EVALUATE: 'maybe' }), /refusing to start/)
        })

        it('R10 allowedOrigins：陣列或逗號字串；正規化（小寫、去尾斜線）；選項 > 環境變數；產生 CORS 白名單設定', () => {
            const c = resolveSecurity({ allowedOrigins: [' HTTPS://Dev.Example/ ', 'http://localhost:3000', 'http://localhost:3000'] }, {})
            assert.deepEqual(c.allowedOrigins, ['https://dev.example', 'http://localhost:3000'])
            assert.deepEqual(c.cors, { origin: ['https://dev.example', 'http://localhost:3000'], credentials: false, maxAge: 600 })
            assert.deepEqual(resolveSecurity({}, { SCREENCTL_ALLOWED_ORIGINS: 'https://a.example, https://b.example:8443' }).allowedOrigins, ['https://a.example', 'https://b.example:8443'])
            assert.deepEqual(resolveSecurity({ allowedOrigins: [] }, { SCREENCTL_ALLOWED_ORIGINS: 'https://a.example' }).allowedOrigins, [])
        })

        it('R10 allowedOrigins 含 * / null / 萬用字元 / 非 http(s) / 含路徑（含多個尾斜線）→ 拒絕啟動', () => {
            for (const bad of ['*', 'null', 'https://*.example.com', 'ftp://a.example', 'a.example', 'https://a.example/path', 'https://a.example//', 'https://a.example////', 'https://a.example/?x=1', 'https://', 'https://a b']) {
                assert.throws(() => resolveSecurity({ allowedOrigins: [bad] }, {}), /refusing to start.*origin/i, bad)
            }
        })

        it('R10 allowedOrigins 正規化成瀏覽器送出之 Origin 表示法：去預設 port、去前導零、IPv4 簡寫展開、IPv6 縮寫；無效 IPv6／超界 port 拒絕', () => {
            const norm = (x) => resolveSecurity({ allowedOrigins: [x] }, {}).allowedOrigins[0]
            assert.equal(norm('https://dev.example:443'), 'https://dev.example')
            assert.equal(norm('http://dev.example:80'), 'http://dev.example')
            assert.equal(norm('http://localhost:03000'), 'http://localhost:3000')
            assert.equal(norm('https://dev.example:8443'), 'https://dev.example:8443')
            assert.equal(norm('http://127.1:3000'), 'http://127.0.0.1:3000')
            assert.equal(norm('http://[0:0:0:0:0:0:0:1]:3000'), 'http://[::1]:3000')
            assert.equal(norm('HTTPS://Dev.Example/'), 'https://dev.example')
            for (const bad of ['http://[.]', 'http://[:::]', 'https://dev.example:99999', 'https://dev.example:65536', 'http://[::1', 'http://[1:2:3:4:5:6:7:8:9]']) {
                assert.throws(() => resolveSecurity({ allowedOrigins: [bad] }, {}), /refusing to start.*origin/i, bad)
            }
        })

        it('R10/R06 清單設定之元素型別錯誤 → 拒絕啟動（不默默丟棄；錯的高順位設定不可使環境變數之限制失效）', () => {
            for (const bad of [[false], [null], [123], [{}], ['https://a.example', 5], 123, true, {}]) {
                assert.throws(() => resolveSecurity({ allowedOrigins: bad }, {}), /refusing to start/, JSON.stringify(bad))
                assert.throws(() => resolveSecurity({ allowedHosts: bad }, {}), /refusing to start/, JSON.stringify(bad))
            }
            assert.throws(() => resolveSecurity({ host: '0.0.0.0', token: TOK, allowedHosts: [false] }, { SCREENCTL_ALLOWED_HOSTS: 'proxy.example' }), /refusing to start/)
        })

        it('R06 allowedHosts 格式錯 → 拒絕啟動；綁 127.0.0.2 時該位址自動加入白名單', () => {
            assert.throws(() => resolveSecurity({ allowedHosts: ['bad host'] }, {}), /refusing to start/)
            for (const bad of ['[.]', '[:::]', 'proxy.lan:99999', 'proxy.lan:65536', 'a@b', 'proxy.lan/x', '[::1']) {
                assert.throws(() => resolveSecurity({ allowedHosts: [bad] }, {}), /refusing to start/, bad)
            }
            const c = resolveSecurity({ host: '127.0.0.2', allowedHosts: 'proxy.lan' }, {})
            assert.deepEqual([...c.hostSet].sort(), ['127.0.0.1', '127.0.0.2', '[::1]', 'localhost', 'proxy.lan'])
            assert.deepEqual(resolveSecurity({ allowedHosts: ['Proxy.Lan:7000', '[0:0:0:0:0:0:0:1]'] }, {}).allowedHosts, ['proxy.lan', '[::1]'])
        })

        it('R09 一般輸入不得丟出非 SCREENCTL_CONFIG 之例外（opt 為 null／非物件）', () => {
            assert.doesNotThrow(() => resolveSecurity(null, {}))
            assert.doesNotThrow(() => resolveSecurity('x', {}))
            assert.doesNotThrow(() => resolveSecurity(undefined, undefined))
        })
    })

    describe('persistToken', () => {
        it('R09 寫入 token + 換行；覆寫既有檔；建立不存在之目錄', () => {
            const f = path.join(fdTmp, 'sub', 'dir', 'p.token')
            persistToken(f, TOK)
            assert.equal(fs.readFileSync(f, 'utf8'), TOK + '\n')
            persistToken(f, TOK2)
            assert.equal(fs.readFileSync(f, 'utf8'), TOK2 + '\n')
        })
        it('R09 POSIX：目錄 0700、檔案 0600（即使舊檔為 0644）', function() {
            if (process.platform === 'win32') this.skip()
            const f = path.join(fdTmp, 'perm', 'p.token')
            fs.mkdirSync(path.dirname(f), { recursive: true })
            fs.writeFileSync(f, 'old', { mode: 0o644 })
            persistToken(f, TOK)
            assert.equal(fs.statSync(f).mode & 0o777, 0o600)
        })

        const leftovers = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))
        // 檔案系統替身：writeFileSync 寫到一半（先寫部分內容）再丟 ENOSPC
        const fsHalfWrite = (target) => ({
            ...fs,
            writeFileSync(p, data, opt) {
                if (String(p) === target || String(p).endsWith('.tmp')) {
                    fs.writeFileSync(p, 'part', opt)
                    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
                }
                return fs.writeFileSync(p, data, opt)
            },
        })

        it('R09 取代模式：寫入失敗（磁碟滿）時舊 token 檔原封不動、不留半寫入之暫存檔', () => {
            const d = path.join(fdTmp, 'atomic-replace')
            const f = path.join(d, 'old.token')
            fs.mkdirSync(d, { recursive: true })
            fs.writeFileSync(f, TOK + '\n')
            assert.throws(() => persistToken(f, TOK2, { replace: true, fsApi: fsHalfWrite(f) }), /ENOSPC/)
            assert.equal(fs.readFileSync(f, 'utf8'), TOK + '\n')
            assert.deepEqual(leftovers(d), [])
        })

        it('R09 取代模式：目標位置不可被取代（資料夾）→ 丟錯，暫存檔清除', () => {
            const d = path.join(fdTmp, 'atomic-replace2')
            const f = path.join(d, 'is-a-dir')
            fs.mkdirSync(f, { recursive: true })
            assert.throws(() => persistToken(f, TOK))
            assert.deepEqual(leftovers(d), [])
            assert.ok(fs.statSync(f).isDirectory())
        })

        it('R09 新建模式（使用者明指之檔）：目標已存在（例如另一實例搶先寫入）→ EEXIST，絕不覆寫，不留暫存檔', () => {
            const d = path.join(fdTmp, 'create-only')
            const f = path.join(d, 'shared.token')
            fs.mkdirSync(d, { recursive: true })
            fs.writeFileSync(f, TOK + '\n')
            assert.throws(() => persistToken(f, TOK2, { replace: false }), (e) => e.code === 'EEXIST')
            assert.equal(fs.readFileSync(f, 'utf8'), TOK + '\n')
            assert.deepEqual(leftovers(d), [])
        })

        it('R09 兩個實例同時解析同一個尚不存在之 tokenFile：先寫者得檔，後寫者 EEXIST（不會互相覆寫成各持不同 token）', () => {
            const f = path.join(fdTmp, 'race', 'shared.token')
            const a = resolveSecurity({ tokenFile: f }, {}, { port: 1 })
            const b = resolveSecurity({ tokenFile: f }, {}, { port: 2 })
            assert.notEqual(a.token, b.token)
            persistToken(a.tokenFile, a.token, { replace: a.persistReplace })
            assert.throws(() => persistToken(b.tokenFile, b.token, { replace: b.persistReplace }), (e) => e.code === 'EEXIST')
            assert.equal(fs.readFileSync(f, 'utf8').trim(), a.token)
        })

        it('R09 新建模式、檔案系統不支援硬連結時退回獨佔寫入；寫到一半失敗會清掉自己建出之半檔', () => {
            const d = path.join(fdTmp, 'nolink')
            fs.mkdirSync(d, { recursive: true })
            const noLink = {
                ...fs,
                linkSync() {
                    throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
                }
            }
            const f = path.join(d, 'a.token')
            persistToken(f, TOK, { replace: false, fsApi: noLink })
            assert.equal(fs.readFileSync(f, 'utf8'), TOK + '\n')
            assert.throws(() => persistToken(f, TOK2, { replace: false, fsApi: noLink }), (e) => e.code === 'EEXIST')
            assert.equal(fs.readFileSync(f, 'utf8'), TOK + '\n')
            // 第二段：退回路徑本身寫入失敗
            const f2 = path.join(d, 'b.token')
            const failFallback = {
                ...fs,
                linkSync() {
                    throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
                },
                writeFileSync(p, data, opt) {
                    if (String(p) === f2) {
                        fs.writeFileSync(p, 'part', opt)
                        throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
                    }
                    return fs.writeFileSync(p, data, opt)
                },
            }
            assert.throws(() => persistToken(f2, TOK, { replace: false, fsApi: failFallback }), /ENOSPC/)
            assert.equal(fs.existsSync(f2), false, '半檔應被清除')
            assert.deepEqual(leftovers(d), [])
        })
    })

    describe('checkBearer：定時比較', () => {
        const d = sha(TOK)

        it('R02 正確 → true；各種錯誤 → false', () => {
            assert.equal(checkBearer(`Bearer ${TOK}`, d), true)
            assert.equal(checkBearer(`bearer ${TOK}`, d), true)
            assert.equal(checkBearer(`BEARER   ${TOK}  `, d), true)
            for (const v of [undefined, null, '', 'Bearer', 'Bearer ', TOK, `Basic ${TOK}`, `Bearer ${TOK}x`, `Bearer x${TOK}`, `Bearer ${TOK} y`, `Bearer ${TOK2}`, `Token ${TOK}`, `Bearer\n${TOK}`, 12345, `Bearer ${TOK}\u00a0`, `\u00a0Bearer ${TOK}`, `Bearer\u00a0${TOK}`]) {
                assert.equal(checkBearer(v, d), false, JSON.stringify(v))
            }
            assert.equal(checkBearer(`\tBearer \t${TOK} \t`, d), true, '外圍只認 SP／HTAB')
        })

        it('R02 一律以 crypto.timingSafeEqual 比較兩個 32 byte 摘要（含格式錯誤與長度不同之輸入，不因長度而提前結束）', () => {
            const orig = crypto.timingSafeEqual
            const calls = []
            crypto.timingSafeEqual = (a, b) => {
                calls.push([a.length, b.length])
                return orig.call(crypto, a, b)
            }
            try {
                const inputs = [`Bearer ${TOK}`, `Bearer ${TOK2}`, 'Bearer x', 'Bearer ' + 'y'.repeat(300), 'garbage', undefined, '']
                for (const v of inputs) checkBearer(v, d)
                assert.equal(calls.length, inputs.length, '每次檢查都必須做一次定時比較')
                assert.ok(calls.every(([x, y]) => x === 32 && y === 32), JSON.stringify(calls))
            }
            finally {
                crypto.timingSafeEqual = orig
            }
        })
    })

    describe('createGate', () => {
        // 最小化之 Hapi 替身：response().code().header().takeover()
        const h = {
            continue: Symbol('continue'),
            response(body) {
                const r = { body, status: 200, headers: {}, taken: false }
                r.code = (c) => {
                    r.status = c; return r
                }
                r.header = (k, v) => {
                    r.headers[k] = v; return r
                }
                r.takeover = () => {
                    r.taken = true; return r
                }
                return r
            },
        }
        const req = (o = {}) => ({
            headers: o.headers || {},
            method: o.method || 'get',
            route: { settings: { app: o.app || {} } },
            raw: o.rawHeaders ? { req: { rawHeaders: o.rawHeaders } } : undefined,
        })

        it('R06 非迴路 + allowedHosts：Host 不在名單 → 403；在名單 → 通過', () => {
            const g = createGate(resolveSecurity({ host: '0.0.0.0', token: TOK, allowedHosts: ['screenctl.lan'] }, {}))
            assert.equal(g.onRequest(req({ headers: { host: 'screenctl.lan:7000' } }), h), h.continue)
            const r = g.onRequest(req({ headers: { host: 'evil.example' } }), h)
            assert.equal(r.status, 403)
            assert.equal(r.body.code, 'FORBIDDEN_HOST')
        })

        it('R06 非迴路未設 allowedHosts：不檢查 Host（token 為唯一防線）', () => {
            const g = createGate(resolveSecurity({ host: '0.0.0.0', token: TOK }, {}))
            assert.equal(g.onRequest(req({ headers: { host: 'anything.example' } }), h), h.continue)
            assert.equal(g.onRequest(req({ headers: {} }), h), h.continue)
        })

        it('R05 Origin：無 Origin 通過；有 Origin 須與（已正規化之）白名單逐字相同，否則 403（大小寫不同、尾斜線、預設 port 寫法皆拒）', () => {
            const g = createGate(resolveSecurity({ token: TOK, allowedOrigins: ['https://dev.example:443', 'http://localhost:3000/'] }, {}))
            const base = { host: '127.0.0.1:7000' }
            assert.equal(g.onRequest(req({ headers: base }), h), h.continue)
            assert.equal(g.onRequest(req({ headers: { ...base, origin: 'https://dev.example' } }), h), h.continue)
            assert.equal(g.onRequest(req({ headers: { ...base, origin: 'http://localhost:3000' } }), h), h.continue)
            for (const origin of ['https://evil.example', 'null', '', 'https://dev.example/', 'https://dev.example:443', 'HTTPS://DEV.EXAMPLE', 'https://Dev.Example', 'http://localhost:03000', 'http://localhost:3000/']) {
                const r = g.onRequest(req({ headers: { ...base, origin } }), h)
                assert.equal(r.status, 403, origin)
                assert.equal(r.body.code, 'FORBIDDEN_ORIGIN')
            }
        })

        it('R06/R02 原始標頭中重複的 Host、Authorization（Node 只留第一個）→ 拒絕；Origin 重複由 Node 合併後比對失敗', () => {
            const g = createGate(resolveSecurity({ token: TOK }, {}))
            const dupHost = ['Host', 'localhost', 'Host', 'evil.example']
            const r = g.onRequest(req({ headers: { host: 'localhost' }, rawHeaders: dupHost }), h)
            assert.equal(r.status, 403)
            assert.equal(r.body.code, 'FORBIDDEN_HOST')
            assert.equal(g.onRequest(req({ headers: { host: 'localhost' }, rawHeaders: ['Host', 'localhost', 'Accept', '*/*'] }), h), h.continue)
            // 大小寫不同之重複名稱亦算重複
            assert.equal(g.onRequest(req({ headers: { host: 'localhost' }, rawHeaders: ['HOST', 'localhost', 'host', 'localhost'] }), h).status, 403)
            const good = `Bearer ${TOK}`
            assert.equal(g.onPreAuth(req({ headers: { authorization: good }, rawHeaders: ['Authorization', good] }), h), h.continue)
            const dupAuth = g.onPreAuth(req({ headers: { authorization: good }, rawHeaders: ['Authorization', good, 'authorization', 'Bearer wrong-token-0123456789abcdef'] }), h)
            assert.equal(dupAuth.status, 401)
            assert.equal(g.onPreAuth(req({ headers: { authorization: good }, rawHeaders: ['Authorization', 'Bearer wrong-token-0123456789abcdef', 'Authorization', good] }), h).status, 401)
            // 公開路由不受 Authorization 重複影響（本來就不看）
            assert.equal(g.onPreAuth(req({ app: { public: true }, rawHeaders: ['Authorization', 'a', 'Authorization', 'b'] }), h), h.continue)
        })

        it('R02 onPreAuth：預設路由須 token（401 + WWW-Authenticate）；app.public 免；任何 method 皆不特別放行', () => {
            const g = createGate(resolveSecurity({ token: TOK }, {}))
            const r = g.onPreAuth(req(), h)
            assert.equal(r.status, 401)
            assert.equal(r.headers['www-authenticate'], 'Bearer')
            assert.equal(g.onPreAuth(req({ headers: { authorization: `Bearer ${TOK}` } }), h), h.continue)
            assert.equal(g.onPreAuth(req({ app: { public: true } }), h), h.continue)
            for (const method of ['options', 'head', 'get', 'post', 'delete']) {
                assert.equal(g.onPreAuth(req({ method }), h).status, 401, method)
            }
            // public 必須嚴格為 true，其他 truthy 值不算
            assert.equal(g.onPreAuth(req({ app: { public: 'yes' } }), h).status, 401)
            assert.equal(g.onPreAuth(req({ app: { public: 1 } }), h).status, 401)
        })

        it('R07 onPreAuth：feature=evaluate 未開 → 403（token 正確時）；無 token 仍 401；開啟後通過', () => {
            const off = createGate(resolveSecurity({ token: TOK }, {}))
            const on = createGate(resolveSecurity({ token: TOK, enableEvaluate: true }, {}))
            const a = { authorization: `Bearer ${TOK}` }
            assert.equal(off.onPreAuth(req({ app: { feature: 'evaluate' } }), h).status, 401)
            const r = off.onPreAuth(req({ headers: a, app: { feature: 'evaluate' } }), h)
            assert.equal(r.status, 403)
            assert.equal(r.body.code, 'EVALUATE_DISABLED')
            assert.equal(on.onPreAuth(req({ headers: a, app: { feature: 'evaluate' } }), h), h.continue)
        })

        it('R02 route 資訊缺失（例如特殊路由）時 onPreAuth 不丟例外，且預設須 token', () => {
            const g = createGate(resolveSecurity({ token: TOK }, {}))
            assert.equal(g.onPreAuth({ headers: {}, method: 'get' }, h).status, 401)
            assert.equal(g.onPreAuth({ headers: {}, method: 'get', route: {} }, h).status, 401)
        })
    })

    describe('describeSecurity', () => {
        it('R09 輸出不含 token 全文（自動產生、選項、環境變數、檔案四種來源）', () => {
            const f = path.join(fdTmp, 'desc.token')
            fs.writeFileSync(f, TOK2)
            const cfgs = [
                resolveSecurity({}, {}, { port: 7000 }),
                resolveSecurity({ token: TOK }, {}),
                resolveSecurity({}, { SCREENCTL_TOKEN: TOK }),
                resolveSecurity({ tokenFile: f }, {}),
            ]
            for (const c of cfgs) {
                const { info, warn } = describeSecurity(c)
                const all = [...info, ...warn].join('\n')
                assert.ok(!all.includes(c.token), c.tokenSource)
                assert.ok(info[0].includes('127.0.0.1'))
            }
            assert.ok(describeSecurity(cfgs[0]).info.join('\n').includes(cfgs[0].tokenFile))
        })
        it('R08／R07 非迴路與 evaluate 開啟時印出警告', () => {
            const { warn } = describeSecurity(resolveSecurity({ host: '0.0.0.0', token: TOK, enableEvaluate: true }, {}))
            const all = warn.join('\n')
            assert.match(all, /non-loopback/)
            assert.match(all, /evaluate/i)
            assert.match(all, /Host header is not checked/)
            assert.equal(describeSecurity(resolveSecurity({ token: TOK }, {})).warn.length, 0)
        })
    })
})
