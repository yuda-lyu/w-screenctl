// api：g.mjs 啟動腳本之安全預設（真的以子行程啟動 node g.mjs、隱藏視窗、輸出導向 test/_tmp）
// 每條斷言之 Rxx 對應 sgud/rule/rulebook.md 之 SEC-xx 規則。
// 不送合法之桌面操作 payload；以 Joi 400／CHROME_NOT_OPEN 判斷是否通過閘門。

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rawRequest } from './tools/rawHttp.mjs'

const fdTest = path.dirname(fileURLToPath(import.meta.url))
const fdRoot = path.dirname(fdTest)
const fGm = path.join(fdRoot, 'g.mjs')
const fdTmp = path.join(fdTest, '_tmp', 'api-security-g')
const fdHome = path.join(fdTmp, 'home') // 子行程之使用者目錄（HOME／USERPROFILE）指到測試夾，預設 token／紀錄檔不會寫進真實使用者目錄

const EVIL = 'https://evil.example'
const children = []

function cleanEnv(extra = {}) {
    const env = {}
    for (const [k, v] of Object.entries(process.env)) {
        if (!k.startsWith('SCREENCTL_') && k !== 'PORT' && k !== 'CHROME_USER_DATA') env[k] = v
    }
    return { ...env, ...extra }
}

// 啟動 node g.mjs（隱藏視窗、stdout／stderr 導向檔案）
function runG({ name, args = [], env = {} }) {
    const fOut = path.join(fdTmp, `${name}.out.log`)
    const fErr = path.join(fdTmp, `${name}.err.log`)
    const out = fs.openSync(fOut, 'w')
    const err = fs.openSync(fErr, 'w')
    const child = spawn(process.execPath, [fGm, ...args], {
        cwd: fdRoot,
        env: cleanEnv({ HOME: fdHome, USERPROFILE: fdHome, SCREENCTL_AUDIT_LOG_FILE: path.join(fdTmp, `${name}.audit.jsonl`), ...env }),
        windowsHide: true,
        stdio: ['ignore', out, err],
    })
    fs.closeSync(out)
    fs.closeSync(err)
    const h = {
        child,
        exited: new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
        stdout: () => fs.readFileSync(fOut, 'utf8'),
        stderr: () => fs.readFileSync(fErr, 'utf8'),
    }
    children.push(h)
    return h
}

async function waitUp(port, ms = 20000) {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
        try {
            const r = await rawRequest({ port, path: '/health' })
            if (r.status === 200) return
        }
        catch {}
        await new Promise((resolve) => setTimeout(resolve, 150))
    }
    throw new Error(`server on ${port} not up within ${ms}ms`)
}

async function stop(h) {
    if (h.child.exitCode === null && h.child.signalCode === null) h.child.kill()
    await h.exited
}

async function assertPortFree(port) {
    await assert.rejects(rawRequest({ port, path: '/health' }), (e) => e.code === 'ECONNREFUSED', `port ${port} 仍有人監聽`)
}

describe('api-security-g：node g.mjs', function() {
    this.timeout(60000)

    before(() => fs.mkdirSync(fdHome, { recursive: true }))

    after(async () => {
        for (const h of children) {
            try {
                await stop(h)
            }
            catch {}
        }
        fs.rmSync(fdTmp, { recursive: true, force: true })
    })

    it('R01/R02/R07/R09 node g.mjs（零設定）：只綁本機、自動產生 token 並寫入 token 檔、log 不含 token、evaluate 預設關', async () => {
        const port = 8751
        const fTok = path.join(fdTmp, 'g1.token')
        const h = runG({ name: 'g1', env: { PORT: String(port), SCREENCTL_TOKEN_FILE: fTok } })
        await waitUp(port)

        // 免 token：/health
        assert.equal((await rawRequest({ port, path: '/health' })).status, 200)
        // 無 token → 401
        assert.equal((await rawRequest({ port, path: '/chrome' })).status, 401)
        // token 檔
        const tok = fs.readFileSync(fTok, 'utf8').trim()
        assert.ok(tok.length >= 32)
        const ok = await rawRequest({ port, path: '/chrome', headers: { authorization: `Bearer ${tok}` } })
        assert.equal(ok.status, 200)
        assert.equal(ok.json.state, 'closed')
        // evaluate 預設 403
        const ev = await rawRequest({ port, method: 'POST', path: '/chrome/evaluate', body: { script: '1+1' }, headers: { authorization: `Bearer ${tok}` } })
        assert.equal(ev.status, 403)
        assert.equal(ev.json.code, 'EVALUATE_DISABLED')
        // 跨站被拒
        const cs = await rawRequest({ port, path: '/chrome', headers: { authorization: `Bearer ${tok}`, origin: EVIL } })
        assert.equal(cs.status, 403)
        // log：告知 token 檔位置與安全摘要，不含 token 全文
        const out = h.stdout()
        assert.ok(out.includes('bind=127.0.0.1'), out)
        assert.ok(out.includes(fTok), out)
        assert.ok(!out.includes(tok) && !h.stderr().includes(tok), 'log 洩漏 token')

        await stop(h)
        await assertPortFree(port)
    })

    it('R07 --evaluate 旗標開啟 /chrome/evaluate（到達 handler：chrome 未開 → CHROME_NOT_OPEN）', async () => {
        const port = 8752
        const fTok = path.join(fdTmp, 'g2.token')
        const h = runG({ name: 'g2', args: ['--evaluate'], env: { PORT: String(port), SCREENCTL_TOKEN_FILE: fTok } })
        await waitUp(port)
        const tok = fs.readFileSync(fTok, 'utf8').trim()
        const ev = await rawRequest({ port, method: 'POST', path: '/chrome/evaluate', body: { script: '1+1' }, headers: { authorization: `Bearer ${tok}` } })
        assert.equal(ev.status, 200)
        assert.equal(ev.json.code, 'CHROME_NOT_OPEN')
        assert.match(h.stderr() + h.stdout(), /\/chrome\/evaluate is ENABLED/)
        await stop(h)
    })

    it('R07 環境變數 SCREENCTL_ENABLE_EVALUATE=1 開啟；SCREENCTL_TOKEN 優先於 token 檔且不寫檔', async () => {
        const port = 8753
        const fTok = path.join(fdTmp, 'g3.token')
        const envTok = 'env-token-0123456789abcdef-ZZ'
        const h = runG({ name: 'g3', env: { PORT: String(port), SCREENCTL_ENABLE_EVALUATE: '1', SCREENCTL_TOKEN: envTok, SCREENCTL_TOKEN_FILE: fTok } })
        await waitUp(port)
        const ev = await rawRequest({ port, method: 'POST', path: '/chrome/evaluate', body: { script: '1+1' }, headers: { authorization: `Bearer ${envTok}` } })
        assert.equal(ev.json.code, 'CHROME_NOT_OPEN')
        assert.equal(fs.existsSync(fTok), false, '以環境變數給 token 時不應寫 token 檔')
        assert.ok(!h.stdout().includes(envTok))
        await stop(h)
    })

    it('R10 --allow-origin 白名單：預檢放行；其他 Origin 403', async () => {
        const port = 8754
        const h = runG({ name: 'g4', args: ['--allow-origin', 'https://dev.example'], env: { PORT: String(port), SCREENCTL_TOKEN: 'g4-token-0123456789abcdef-XX' } })
        await waitUp(port)
        const ok = await rawRequest({ port, method: 'OPTIONS', path: '/chrome/open', headers: { 'origin': 'https://dev.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' } })
        assert.equal(ok.headers['access-control-allow-origin'], 'https://dev.example')
        const bad = await rawRequest({ port, method: 'OPTIONS', path: '/chrome/open', headers: { 'origin': EVIL, 'access-control-request-method': 'POST' } })
        assert.equal(bad.status, 403)
        await stop(h)
    })

    it('R09 --token-file 優先於環境變數 SCREENCTL_TOKEN_FILE（旗標指的檔被建立並使用，環境變數指的檔不碰）', async () => {
        const port = 8757
        const fA = path.join(fdTmp, 'g9-flag.token')
        const fB = path.join(fdTmp, 'g9-env.token')
        const h = runG({ name: 'g9', args: ['--token-file', fA], env: { PORT: String(port), SCREENCTL_TOKEN_FILE: fB } })
        await waitUp(port)
        assert.ok(fs.existsSync(fA), '旗標指定之 token 檔應被建立')
        assert.equal(fs.existsSync(fB), false, '環境變數指定之 token 檔不應被碰')
        const tok = fs.readFileSync(fA, 'utf8').trim()
        assert.equal((await rawRequest({ port, path: '/chrome', headers: { authorization: `Bearer ${tok}` } })).status, 200)
        await stop(h)
    })

    it('R05/R06 --allow-origin 可重複（兩個都放行、第三個 403）、--allow-host 追加 Host 名稱（Host 檢查仍生效）', async () => {
        const port = 8758
        const tok = 'g10-token-0123456789abcdef-XX'
        const h = runG({
            name: 'g10',
            args: ['--allow-origin', 'https://a.example', '--allow-origin', 'https://b.example', '--allow-host', 'proxy.lan'],
            env: { PORT: String(port), SCREENCTL_TOKEN: tok },
        })
        await waitUp(port)
        const pre = (origin) => rawRequest({ port, method: 'OPTIONS', path: '/chrome/open', headers: { origin, 'access-control-request-method': 'POST' } })
        assert.equal((await pre('https://a.example')).headers['access-control-allow-origin'], 'https://a.example')
        assert.equal((await pre('https://b.example')).headers['access-control-allow-origin'], 'https://b.example')
        assert.equal((await pre('https://c.example')).status, 403)
        const get = (host) => rawRequest({ port, path: '/chrome', headers: { authorization: `Bearer ${tok}`, host } })
        assert.equal((await get(`proxy.lan:${port}`)).status, 200)
        assert.equal((await get(`127.0.0.1:${port}`)).status, 200)
        assert.equal((await get('evil.example')).status, 403)
        await stop(h)
    })

    it('R07 --evaluate 旗標優先於環境變數 SCREENCTL_ENABLE_EVALUATE=0（選項 > 環境變數）', async () => {
        const port = 8759
        const tok = 'g11-token-0123456789abcdef-XX'
        const h = runG({ name: 'g11', args: ['--evaluate'], env: { PORT: String(port), SCREENCTL_TOKEN: tok, SCREENCTL_ENABLE_EVALUATE: '0' } })
        await waitUp(port)
        const ev = await rawRequest({ port, method: 'POST', path: '/chrome/evaluate', body: { script: '1+1' }, headers: { authorization: `Bearer ${tok}` } })
        assert.equal(ev.json.code, 'CHROME_NOT_OPEN')
        await stop(h)
    })

    it('R08 --host 0.0.0.0 且未設 token → 退出碼 1、stderr 有拒絕與設定指引、未監聽', async () => {
        const port = 8755
        const h = runG({ name: 'g5', args: ['--host', '0.0.0.0'], env: { PORT: String(port) } })
        const { code } = await h.exited
        assert.equal(code, 1)
        const err = h.stderr()
        assert.match(err, /refusing to start/)
        assert.match(err, /SCREENCTL_TOKEN/)
        assert.ok(!/at .*\.mjs:\d+/.test(err), '設定錯誤不應印出堆疊')
        await assertPortFree(port)
    })

    it('R08 SCREENCTL_HOST=0.0.0.0 且 SCREENCTL_TOKEN 為空字串 → 同樣拒絕啟動（空 token 不等於已設 token）', async () => {
        // 不做「非迴路 + 有 token 實際綁定」之測試：會對 node.exe 觸發 Windows 防火牆對話框；該路徑由 unit-security 覆蓋
        const port = 8756
        const h = runG({ name: 'g6', env: { PORT: String(port), SCREENCTL_HOST: '0.0.0.0', SCREENCTL_TOKEN: '' } })
        assert.equal((await h.exited).code, 1)
        assert.match(h.stderr(), /refusing to start/)
        await assertPortFree(port)
    })

    it('A05 --no-system 關閉系統級端點（改用不會有副作用之 /screenshot 驗證：403 SYSTEM_DISABLED）、啟動輸出標示 DISABLED、Chrome 頁面級不受影響', async () => {
        // 注意：此測試對真實子行程送系統級請求；若旗標失效，/screenshot 只會截一張桌面圖（唯讀），不會有鍵鼠動作
        const port = 8760
        const tok = 'g12-token-0123456789abcdef-XX'
        // 環境變數 SCREENCTL_ENABLE_SYSTEM=1 與旗標 --no-system 衝突：旗標（選項）優先，系統級仍關閉
        const h = runG({ name: 'g12', args: ['--no-system'], env: { PORT: String(port), SCREENCTL_TOKEN: tok, SCREENCTL_ENABLE_SYSTEM: '1' } })
        await waitUp(port)
        const r = await rawRequest({ port, method: 'POST', path: '/screenshot', body: {}, headers: { authorization: `Bearer ${tok}` } })
        assert.equal(r.status, 403)
        assert.equal(r.json.code, 'SYSTEM_DISABLED')
        const c = await rawRequest({ port, method: 'POST', path: '/chrome/navigate', body: { url: 'about:blank' }, headers: { authorization: `Bearer ${tok}` } })
        assert.equal(c.json.code, 'CHROME_NOT_OPEN') // 到達 handler
        assert.match(h.stdout(), /system\(mouse\/keyboard\/screenshot\)=DISABLED/)
        await stop(h)
    })

    it('A05 環境變數 SCREENCTL_ENABLE_SYSTEM=0 關閉系統級（旗標未給）', async () => {
        const port = 8761
        const tok = 'g13-token-0123456789abcdef-XX'
        const h = runG({ name: 'g13', env: { PORT: String(port), SCREENCTL_TOKEN: tok, SCREENCTL_ENABLE_SYSTEM: '0' } })
        await waitUp(port)
        const r = await rawRequest({ port, method: 'POST', path: '/screenshot', body: {}, headers: { authorization: `Bearer ${tok}` } })
        assert.equal(r.json.code, 'SYSTEM_DISABLED')
        await stop(h)
    })

    it('A04 --audit-log-file 指定紀錄檔位置（優先於環境變數）；請求被記錄；啟動輸出列出紀錄路徑；紀錄不含 token', async () => {
        const port = 8762
        const tok = 'g14-token-0123456789abcdef-XX'
        const fA = path.join(fdTmp, 'g14-flag.audit.jsonl')
        const fB = path.join(fdTmp, 'g14-env.audit.jsonl')
        const h = runG({ name: 'g14', args: ['--audit-log-file', fA], env: { PORT: String(port), SCREENCTL_TOKEN: tok, SCREENCTL_AUDIT_LOG_FILE: fB } })
        await waitUp(port)
        assert.equal((await rawRequest({ port, path: '/chrome', headers: { authorization: `Bearer ${tok}` } })).status, 200)
        assert.equal((await rawRequest({ port, path: '/chrome' })).status, 401)
        const t0 = Date.now()
        while (Date.now() - t0 < 4000 && !(fs.existsSync(fA) && fs.readFileSync(fA, 'utf8').split('\n').filter(Boolean).length >= 2)) await new Promise((resolve) => setTimeout(resolve, 50))
        const lines = fs.readFileSync(fA, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x))
        assert.deepEqual(lines.map((x) => [x.method, x.path, x.status, x.denied]), [['GET', '/chrome', 200, undefined], ['GET', '/chrome', 401, 'UNAUTHORIZED']])
        assert.equal(fs.existsSync(fB), false, '環境變數指定之紀錄檔不應被碰')
        assert.ok(!fs.readFileSync(fA, 'utf8').includes(tok))
        assert.ok(h.stdout().includes(fA), h.stdout())
        await stop(h)
    })

    it('A05 --no-audit-log 關閉操作紀錄：不建立紀錄檔、啟動輸出標示 OFF 並警告', async () => {
        const port = 8763
        const tok = 'g15-token-0123456789abcdef-XX'
        const f = path.join(fdTmp, 'g15.audit.jsonl')
        // 環境變數 SCREENCTL_AUDIT_LOG=1 與旗標 --no-audit-log 衝突：旗標（選項）優先，仍不寫紀錄
        const h = runG({ name: 'g15', args: ['--no-audit-log'], env: { PORT: String(port), SCREENCTL_TOKEN: tok, SCREENCTL_AUDIT_LOG: '1', SCREENCTL_AUDIT_LOG_FILE: f } })
        await waitUp(port)
        assert.equal((await rawRequest({ port, path: '/chrome', headers: { authorization: `Bearer ${tok}` } })).status, 200)
        await new Promise((resolve) => setTimeout(resolve, 500))
        assert.equal(fs.existsSync(f), false)
        assert.match(h.stdout(), /audit-log=OFF/)
        assert.match(h.stderr() + h.stdout(), /audit log is OFF/i)
        await stop(h)
    })

    it('A05 紀錄設定值不合規格 → 退出碼 1、拒絕啟動（不默默退回預設）', async () => {
        const port = 8764
        const h = runG({ name: 'g16', env: { PORT: String(port), SCREENCTL_TOKEN: 'g16-token-0123456789abcdef-XX', SCREENCTL_AUDIT_LOG_MAX_BYTES: 'many' } })
        assert.equal((await h.exited).code, 1)
        assert.match(h.stderr(), /refusing to start/)
        await assertPortFree(port)
    })

    it('旗標錯誤 → 退出碼 2 並印出用法；--help → 退出碼 0', async () => {
        const bad = runG({ name: 'g7', args: ['--bogus'] })
        assert.equal((await bad.exited).code, 2)
        assert.match(bad.stderr(), /Usage: node g\.mjs/)
        const help = runG({ name: 'g8', args: ['--help'] })
        assert.equal((await help.exited).code, 0)
        assert.match(help.stdout(), /--evaluate/)
        for (const flag of ['--no-system', '--no-audit-log', '--audit-log-file']) assert.ok(help.stdout().includes(flag), `--help 應列出 ${flag}`)
        assert.ok(!/--token\b/.test(help.stdout().replace(/--token-file/g, '')), '不提供 --token 旗標（避免出現在行程列表）')
    })
})
