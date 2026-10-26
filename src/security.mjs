import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'


// 預設安全：本模組集中處理「綁定位址、token、Host／Origin 檢查、高權限端點開關」。
// 新增路由時：預設即須 token（無需任何標記）；只有 options.app.public === true 之路由免 token；
// 高權限路由以 options.app.feature 標示所屬開關（目前僅 'evaluate'）。

export const DEFAULT_HOST = '127.0.0.1'

// 設定來源之環境變數名稱
export const ENV_NAMES = {
    host: 'SCREENCTL_HOST',
    token: 'SCREENCTL_TOKEN',
    tokenFile: 'SCREENCTL_TOKEN_FILE',
    enableEvaluate: 'SCREENCTL_ENABLE_EVALUATE',
    allowedOrigins: 'SCREENCTL_ALLOWED_ORIGINS',
    allowedHosts: 'SCREENCTL_ALLOWED_HOSTS',
}

// token：可印字元（0x21~0x7e，不含空白），16~256 字元
const TOKEN_RE = /^[\x21-\x7e]{16,256}$/
const BEARER_RE = /^Bearer[ \t]+([\x21-\x7e]+)$/i
const ORIGIN_RE = /^https?:\/\/(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(:\d{1,5})?$/
const HOST_HEADER_RE = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(?::(\d{1,5}))?$/i
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/


function configError(msg) {
    const err = new Error(msg)
    err.code = 'SCREENCTL_CONFIG'
    return err
}

// 僅接受字串並去除前後空白；其餘型別（false、null、數字…）一律視為「未給」
function str(v) {
    return typeof v === 'string' ? v.trim() : ''
}

function sha256(s) {
    return crypto.createHash('sha256').update(s).digest()
}

// HTTP 標頭值外圍空白只認 SP／HTAB（RFC 7230 OWS）；String.prototype.trim 連 NBSP 等 Unicode 空白都會剪掉，不可用於標頭
function ows(s) {
    return s.replace(/^[ \t]+|[ \t]+$/g, '')
}

// 清單設定（allowedOrigins、allowedHosts）：陣列或逗號分隔字串；元素型別錯誤即拒絕，不默默丟棄
function toList(v, name) {
    if (v === undefined || v === null) return []
    if (Array.isArray(v)) {
        for (const x of v) {
            if (typeof x !== 'string') throw configError(`refusing to start: ${name} entries must be strings`)
        }
        return v.map((x) => x.trim()).filter((x) => x !== '')
    }
    if (typeof v !== 'string') throw configError(`refusing to start: ${name} must be an array of strings or a comma separated string`)
    return v.split(',').map((x) => x.trim()).filter((x) => x !== '')
}

// 設定值之 origin 正規化：驗證形狀後交給 WHATWG URL 序列化，與瀏覽器送出之 Origin 同一表示法
// （小寫、去預設 port、去前導零、IPv4 簡寫展開；超界 port、無效 IPv6 會丟錯）；只容許一個尾斜線（常見貼法）
function normalizeOrigin(x, name) {
    const bad = () => configError(`refusing to start: ${name} entry "${x}" is not a valid origin (expected scheme://host[:port]; "*" and "null" are not allowed)`)
    const n = x.toLowerCase().replace(/\/$/, '')
    if (!ORIGIN_RE.test(n)) throw bad()
    let u
    try {
        u = new URL(n)
    }
    catch {
        throw bad()
    }
    if (u.origin === 'null') throw bad()
    return u.origin
}

// 設定值之 Host 名稱正規化：形狀（主機名稱或 [IPv6]，可帶 port）+ URL 驗證（無效 IPv6、超界 port 會丟錯），回傳小寫主機名稱（IPv6 保留中括號）
function normalizeHostName(x, name) {
    const bad = () => configError(`refusing to start: ${name} entry "${x}" is not a valid host name`)
    if (!HOST_HEADER_RE.test(x)) throw bad()
    let u
    try {
        u = new URL(`http://${x}`)
    }
    catch {
        throw bad()
    }
    return u.hostname
}

function parseSwitch(v, name) {
    if (typeof v === 'boolean') return v
    const s = str(v).toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(s)) return true
    if (['', '0', 'false', 'no', 'off'].includes(s)) return false
    throw configError(`refusing to start: ${name} must be one of 1/true/yes/on or 0/false/no/off`)
}


/**
 * 判斷監聽位址是否為迴路位址（僅本機可連入）
 *
 * 保守判定：認不得之寫法一律視為非迴路（須 token 才能啟動）
 *
 * @param {String} host 監聽位址
 * @returns {Boolean}
 */
export function isLoopbackHost(host) {
    if (typeof host !== 'string') return false
    let h = host.trim().toLowerCase()
    if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
    if (h === 'localhost') return true
    if (IPV4_RE.test(h)) return h.startsWith('127.')
    if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true
    const m = /^::ffff:(.+)$/.exec(h) // IPv4-mapped IPv6
    return !!(m && IPV4_RE.test(m[1]) && m[1].startsWith('127.'))
}

/**
 * 解析 Host 標頭，回傳小寫之主機名稱（IPv6 保留中括號），格式不合回傳 null
 *
 * @param {String} v Host 標頭值
 * @returns {String|null}
 */
export function parseHostHeader(v) {
    if (typeof v !== 'string') return null
    const m = HOST_HEADER_RE.exec(ows(v))
    return m ? m[1].toLowerCase() : null
}

/**
 * 預設之 token 檔位置：預設位址為 `<使用者家目錄>/.w-screenctl/token-<port>`，
 * 其他位址為 `token-<位址>-<port>`（位址中非英數與 `.-` 者換成 `_`），避免同 port 不同位址之實例共用同一檔而互相覆寫
 *
 * @param {Integer} port 服務 port
 * @param {String} [host='127.0.0.1'] 監聽位址
 * @param {Function} [homedir=os.homedir] 取得家目錄之函式
 * @returns {String}
 */
export function defaultTokenFile(port, host = DEFAULT_HOST, homedir = os.homedir) {
    const h = String(host).toLowerCase()
    const tag = h === DEFAULT_HOST ? '' : `${h.replace(/[^a-z0-9.-]/g, '_')}-`
    return path.join(homedir(), '.w-screenctl', `token-${tag}${port}`)
}

/**
 * 寫出 token 檔：目錄 0700、檔案 0600（POSIX）；一律先寫同目錄暫存檔（獨佔建立）再一次到位，不會留下半寫入之檔，失敗時暫存檔會清除
 * - replace=true（預設；伺服器自有之預設路徑）：rename 原子取代，失敗時舊檔原封不動
 * - replace=false（使用者明指之 tokenFile）：原子建立，目標已存在（例如另一實例搶先寫入）即丟 EEXIST，絕不覆寫
 * Windows 之 mode 位元無作用，權限取決於所在資料夾之 ACL（使用者家目錄預設僅本人／系統管理者可讀）
 *
 * @param {String} file token 檔路徑
 * @param {String} token token 全文
 * @param {Object} [opt={}]
 * @param {Boolean} [opt.replace=true] 目標已存在時是否取代
 * @param {Object} [opt.fsApi=fs] 檔案系統實作（測試注入故障用）
 */
export function persistToken(file, token, { replace = true, fsApi = fs } = {}) {
    const dir = path.dirname(file)
    fsApi.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)
    const data = token + '\n'
    const rmTmp = () => {
        try {
            fsApi.rmSync(tmp, { force: true })
        }
        catch {}
    }
    try {
        fsApi.writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' })
        if (replace) {
            fsApi.renameSync(tmp, file)
            return
        }
        try {
            fsApi.linkSync(tmp, file) // 原子建立；目標已存在則 EEXIST
        }
        catch (err) {
            if (err.code === 'EEXIST') throw err
            // 檔案系統不支援硬連結：退回獨佔寫入（同樣不覆寫既有檔；若是本次寫到一半失敗，清掉自己建出之半檔）
            try {
                fsApi.writeFileSync(file, data, { mode: 0o600, flag: 'wx' })
            }
            catch (err2) {
                if (err2.code !== 'EEXIST') {
                    try {
                        fsApi.rmSync(file, { force: true })
                    }
                    catch {}
                }
                throw err2
            }
        }
        rmTmp()
    }
    catch (err) {
        rmTmp()
        throw err
    }
}


/**
 * 解析並驗證安全設定；設定有誤或不安全時丟出 code='SCREENCTL_CONFIG' 之 Error（拒絕啟動）
 *
 * 優先序（新增之安全選項）：選項 > 環境變數 > 預設
 * 副作用：只讀取 token 檔，不寫檔（寫檔由呼叫端於 server 啟動成功後以 persistToken 執行）
 *
 * @param {Object} [opt={}] 同 WScreenctl 之 opt
 * @param {Object} [env=process.env] 環境變數
 * @param {Object} [ctx={}] 內部用
 * @param {Integer} [ctx.port] 服務 port（決定預設 token 檔名）
 * @returns {Object} 設定：host, loopback, token, tokenSource, tokenFile, persist, evaluate, allowedOrigins, allowedHosts, hostSet, cors
 */
export function resolveSecurity(opt = {}, env = process.env, ctx = {}) {
    const o = opt && typeof opt === 'object' ? opt : {}
    const e = env || {}

    // 綁定位址
    let host = str(o.host) || str(e[ENV_NAMES.host]) || DEFAULT_HOST
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
    const loopback = isLoopbackHost(host)

    // token：選項 > 環境變數 > 檔案 > （僅迴路）自動產生
    let token = ''
    let tokenSource = ''
    let tokenFile = null
    let persist = false
    let persistReplace = true // 預設路徑（伺服器自有）可取代舊檔；使用者明指之 tokenFile 只可新建，不覆寫
    if (str(o.token)) {
        token = str(o.token)
        tokenSource = 'option token'
    }
    else if (str(e[ENV_NAMES.token])) {
        token = str(e[ENV_NAMES.token])
        tokenSource = `env ${ENV_NAMES.token}`
    }
    else {
        const fileRaw = str(o.tokenFile) || str(e[ENV_NAMES.tokenFile])
        const fileGiven = fileRaw ? path.resolve(fileRaw) : '' // 一律轉絕對路徑，啟動輸出才指得到實際檔案
        if (fileGiven && fs.existsSync(fileGiven)) {
            try {
                token = fs.readFileSync(fileGiven, 'utf8')
                if (token.charCodeAt(0) === 0xFEFF) token = token.slice(1) // 去除 UTF-8 BOM（PowerShell 的 > 與 Out-File 會寫入）
                token = token.trim()
            }
            catch (err) {
                throw configError(`refusing to start: cannot read token file "${fileGiven}": ${err.message}`)
            }
            tokenSource = `file ${fileGiven}`
            tokenFile = fileGiven
            if (!token) throw configError(`refusing to start: token file "${fileGiven}" is empty`)
        }
        else if (!loopback) {
            throw configError(
                `refusing to start: host "${host}" is not a loopback address and no token was provided.\n` +
                'Anyone who can reach this port could control this machine\'s mouse, keyboard and Chrome.\n' +
                `Provide a token (option "token", env ${ENV_NAMES.token}, or an existing token file via option "tokenFile" / env ${ENV_NAMES.tokenFile}), or bind to ${DEFAULT_HOST}.`,
            )
        }
        else {
            token = crypto.randomBytes(32).toString('base64url')
            tokenFile = fileGiven || defaultTokenFile(ctx.port, host)
            tokenSource = 'generated'
            persist = true
            persistReplace = !fileGiven
        }
    }
    if (!TOKEN_RE.test(token)) {
        throw configError(`refusing to start: token (${tokenSource}) must be 16-256 printable ASCII characters without whitespace (token files must be saved as UTF-8 or ASCII)`)
    }

    // 高權限端點：預設關閉
    let evaluate = false
    if (o.enableEvaluate !== undefined && o.enableEvaluate !== null) evaluate = parseSwitch(o.enableEvaluate, 'enableEvaluate')
    else evaluate = parseSwitch(e[ENV_NAMES.enableEvaluate], ENV_NAMES.enableEvaluate)

    // 跨站白名單：預設空（全拒）；不接受 * 與 null
    const rawOrigins = o.allowedOrigins !== undefined && o.allowedOrigins !== null ? o.allowedOrigins : e[ENV_NAMES.allowedOrigins]
    const allowedOrigins = []
    for (const x of toList(rawOrigins, 'allowedOrigins')) {
        const n = normalizeOrigin(x, 'allowedOrigins')
        if (!allowedOrigins.includes(n)) allowedOrigins.push(n)
    }

    // Host 標頭白名單：綁迴路時內建本機名稱；另可追加（例：反向代理之對外名稱）
    const rawHosts = o.allowedHosts !== undefined && o.allowedHosts !== null ? o.allowedHosts : e[ENV_NAMES.allowedHosts]
    const allowedHosts = []
    for (const x of toList(rawHosts, 'allowedHosts')) {
        const n = normalizeHostName(x, 'allowedHosts')
        if (!allowedHosts.includes(n)) allowedHosts.push(n)
    }
    const hostSet = new Set(allowedHosts)
    if (loopback) {
        for (const n of ['localhost', '127.0.0.1', '[::1]']) hostSet.add(n)
        const self = host.includes(':') ? `[${host.toLowerCase()}]` : host.toLowerCase()
        hostSet.add(self)
    }

    return {
        host,
        loopback,
        token,
        tokenSource,
        tokenFile,
        persist,
        persistReplace,
        evaluate,
        allowedOrigins,
        allowedHosts,
        hostCheck: hostSet.size > 0,
        hostSet,
        cors: allowedOrigins.length > 0 ? { origin: [...allowedOrigins], credentials: false, maxAge: 600 } : false,
    }
}


function deny(h, status, code, error, headers = {}) {
    const res = h.response({ ok: false, error, code, retry: 'never' }).code(status)
    for (const [k, v] of Object.entries(headers)) res.header(k, v)
    return res.takeover()
}

/**
 * 檢查 Authorization 標頭之 Bearer token（定時比較）
 *
 * 兩邊先各自雜湊成等長摘要再 timingSafeEqual，長度與內容皆不影響比較時間；
 * 格式不符時仍做一次比較，避免以回應時間分辨「格式錯」與「值錯」。
 *
 * @param {String} authorization Authorization 標頭值
 * @param {Buffer} expectedDigest 正確 token 之 sha256 摘要
 * @returns {Boolean}
 */
export function checkBearer(authorization, expectedDigest) {
    const m = typeof authorization === 'string' ? BEARER_RE.exec(ows(authorization)) : null
    const given = sha256(m ? m[1] : '')
    const same = crypto.timingSafeEqual(given, expectedDigest)
    return !!m && same
}

/**
 * 建立 Hapi 閘門
 *
 * onRequest（先於路由比對，涵蓋所有請求含 404 與 CORS 預檢）：
 *   - Host 標頭須在白名單（綁迴路時為本機名稱）→ 擋 DNS rebinding
 *   - 帶 Origin 之請求須在 allowedOrigins（預設空＝一律拒絕）→ 擋跨站
 * onPreAuth（路由比對後，先於 payload 解析與 Joi 驗證）：
 *   - options.app.public === true 之路由（目前僅 GET /health）免 token
 *   - 其餘一律須 Bearer token（預設拒絕，不特別放行任何 method）
 *   - options.app.feature === 'evaluate' 且未開啟 → 403
 * 注意：Hapi 內建之 notFound 與 CORS 預檢（OPTIONS）特殊路由不經 onPreAuth（server.ext 於建立後才註冊，
 * 不會重建特殊路由之生命週期；api-security 之預檢測試鎖定此行為）。預檢因此不需 token，且已受 onRequest 的 Origin／Host 檢查；
 * 它只回 CORS 標頭，不執行任何 handler。
 *
 * @param {Object} cfg resolveSecurity 之回傳
 * @returns {{onRequest: Function, onPreAuth: Function}}
 */
export function createGate(cfg) {
    const digest = sha256(cfg.token)
    const origins = new Set(cfg.allowedOrigins)

    // 原始標頭中某名稱出現幾次：Node 對重複的 Host／Authorization 只留第一個，閘門看不到後者；
    // 重複本身即為格式異常（前面若有代理，代理與本服務可能各看到不同的值），一律拒絕
    const rawCount = (request, name) => {
        const raw = request.raw && request.raw.req && request.raw.req.rawHeaders
        if (!Array.isArray(raw)) return 0
        let n = 0
        for (let i = 0; i < raw.length; i += 2) {
            if (String(raw[i]).toLowerCase() === name) n++
        }
        return n
    }

    const onRequest = (request, h) => {
        if (rawCount(request, 'host') > 1) {
            return deny(h, 403, 'FORBIDDEN_HOST', 'forbidden: duplicate Host header')
        }
        if (cfg.hostCheck) {
            const name = parseHostHeader(request.headers.host)
            if (name === null || !cfg.hostSet.has(name)) {
                return deny(h, 403, 'FORBIDDEN_HOST', 'forbidden: Host header is not allowed')
            }
        }
        // 請求之 Origin 與白名單逐字比對（瀏覽器送出的已是正規化小寫；白名單已於設定時正規化），檢查之值即使用之值
        const origin = request.headers.origin
        if (origin !== undefined && !origins.has(String(origin))) {
            return deny(h, 403, 'FORBIDDEN_ORIGIN', 'forbidden: cross-origin requests are not allowed')
        }
        return h.continue
    }

    const onPreAuth = (request, h) => {
        const app = (request.route && request.route.settings && request.route.settings.app) || {}
        if (app.public === true) return h.continue
        if (rawCount(request, 'authorization') > 1 || !checkBearer(request.headers.authorization, digest)) {
            return deny(h, 401, 'UNAUTHORIZED', 'unauthorized: missing or invalid Bearer token', { 'www-authenticate': 'Bearer' })
        }
        if (app.feature === 'evaluate' && !cfg.evaluate) {
            return deny(
                h, 403, 'EVALUATE_DISABLED',
                `forbidden: /chrome/evaluate is disabled; enable it with option "enableEvaluate", env ${ENV_NAMES.enableEvaluate}=1 or "node g.mjs --evaluate"`,
            )
        }
        return h.continue
    }

    return { onRequest, onPreAuth }
}

/**
 * 啟動後輸出之安全摘要（不含 token 全文）
 *
 * @param {Object} cfg resolveSecurity 之回傳
 * @returns {{info: String[], warn: String[]}}
 */
export function describeSecurity(cfg) {
    const info = []
    const warn = []
    info.push(
        `[security] bind=${cfg.host} (${cfg.loopback ? 'loopback only' : 'NOT loopback'}) | auth=Bearer token (${cfg.tokenSource.startsWith('generated') ? 'generated' : cfg.tokenSource.split(' ')[0]})` +
        ` | evaluate=${cfg.evaluate ? 'ENABLED' : 'disabled'} | cors=${cfg.allowedOrigins.length ? cfg.allowedOrigins.join(',') : 'off'}`,
    )
    if (cfg.persist) {
        info.push(`[security] token file: ${cfg.tokenFile}`)
        info.push('[security] send header "Authorization: Bearer <contents of the token file>" (the token itself is not printed)')
    }
    else if (cfg.tokenFile) {
        info.push(`[security] token read from file: ${cfg.tokenFile}`)
    }
    if (!cfg.loopback) {
        warn.push(
            `[security] WARNING: listening on non-loopback address ${cfg.host}. Anyone who can reach this port and holds the token controls this machine's mouse, keyboard and Chrome. ` +
            'The token travels in clear text over HTTP: prefer an SSH tunnel or a TLS reverse proxy, and firewall the port.',
        )
        if (!cfg.allowedHosts.length) warn.push('[security] WARNING: Host header is not checked on a non-loopback bind; set allowedHosts to enable it.')
    }
    if (cfg.evaluate) {
        warn.push('[security] WARNING: /chrome/evaluate is ENABLED: callers holding the token can run arbitrary JavaScript in the controlled Chrome page.')
    }
    return { info, warn }
}
