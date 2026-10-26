// 測試輔助：api 測試共用之伺服器啟停、環境隔離、console 攔截
// 隔離原則：測試期間 SCREENCTL_*、PORT、CHROME_USER_DATA 清空；HOME／USERPROFILE 可指到測試專用夾（os.homedir() 於 Windows 讀 USERPROFILE、POSIX 讀 HOME），
// 且每個由 start() 啟動之伺服器預設帶一個測試夾內的 auditLogFile，絕不寫入真實使用者目錄。
import WScreenctl from '../../src/WScreenctl.mjs'

const isScreenctlEnv = (k) => k.startsWith('SCREENCTL_') || k === 'PORT' || k === 'CHROME_USER_DATA'

/**
 * @param {Object} o
 * @param {Function} [o.defaults] 回傳每個 start() 預設帶入之選項（可被呼叫端覆寫）
 */
export function makeHarness({ defaults = () => ({}) } = {}) {
    const servers = []
    let savedEnv = {}
    let savedHome = null

    const h = {
        servers,

        clearEnv() {
            for (const k of Object.keys(process.env)) {
                if (isScreenctlEnv(k)) {
                    savedEnv[k] = process.env[k]
                    delete process.env[k]
                }
            }
        },

        restoreEnv() {
            for (const k of Object.keys(process.env)) {
                if (isScreenctlEnv(k)) delete process.env[k]
            }
            Object.assign(process.env, savedEnv)
            savedEnv = {}
        },

        useFakeHome(home) {
            if (!savedHome) savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
            process.env.HOME = home
            process.env.USERPROFILE = home
        },

        restoreHome() {
            if (!savedHome) return
            for (const [k, v] of Object.entries(savedHome)) {
                if (v === undefined) delete process.env[k]
                else process.env[k] = v
            }
            savedHome = null
        },

        async start(opt) {
            const s = await WScreenctl({ ...defaults(), ...opt })
            servers.push(s)
            return s
        },

        async stop(s) {
            try {
                await s.stop({ timeout: 3000 })
            }
            catch {}
            const i = servers.indexOf(s)
            if (i >= 0) servers.splice(i, 1)
        },

        async stopAll() {
            while (servers.length) await h.stop(servers[servers.length - 1])
        },

        // 攔截 console，回傳期間輸出之全文（用於驗證 token 不入 log、警告次數）
        async captureConsole(fn) {
            const lines = []
            const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info }
            for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.map(String).join(' '))
            try {
                const r = await fn()
                return { r, out: lines.join('\n'), lines }
            }
            finally {
                Object.assign(console, orig)
            }
        },
    }
    return h
}
