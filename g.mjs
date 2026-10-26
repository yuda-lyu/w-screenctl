// 啟動腳本：給本機開發、AI agent、systemd / Windows 工作排程等 service 用
// 直接 `node g.mjs` 即啟動：只綁 127.0.0.1、port 7000（可由 env PORT 覆寫）、須 Bearer token
// token 未給時自動產生並寫入 ~/.w-screenctl/token-<port>（啟動輸出會告知位置，不印出 token 全文）
// 其餘設定見 README「安全預設」；旗標只是 WScreenctl 選項之捷徑，沒有 --token（避免 token 出現在行程列表與 shell 歷史）
import { parseArgs } from 'node:util'
import WScreenctl from './src/WScreenctl.mjs'


const USAGE = `Usage: node g.mjs [options]

  --host <addr>           listen address (default 127.0.0.1; env SCREENCTL_HOST). A non-loopback address requires a token.
  --token-file <path>     read the token from this file; if it does not exist it is generated and written there (env SCREENCTL_TOKEN_FILE)
  --evaluate              enable POST /chrome/evaluate (arbitrary JS in the page; default off; env SCREENCTL_ENABLE_EVALUATE=1)
  --allow-origin <origin> allow cross-origin calls from this origin, repeatable (env SCREENCTL_ALLOWED_ORIGINS, comma separated)
  --allow-host <name>     extra accepted Host header name, repeatable (env SCREENCTL_ALLOWED_HOSTS, comma separated)
  --no-system             disable the system-level endpoints (/screenshot, /mouse/*, /keyboard/*): 403 SYSTEM_DISABLED; Chrome-only use (env SCREENCTL_ENABLE_SYSTEM=0)
  --no-audit-log          do not write the audit log (default: every control action and rejected request is recorded; env SCREENCTL_AUDIT_LOG=0)
  --audit-log-file <path> audit log location (default ~/.w-screenctl/audit-<port>.jsonl; env SCREENCTL_AUDIT_LOG_FILE; size/rotation: SCREENCTL_AUDIT_LOG_MAX_BYTES, SCREENCTL_AUDIT_LOG_KEEP)
  -h, --help              show this help

Token: env SCREENCTL_TOKEN, or a token file, or generated at startup (loopback only). Port: env PORT (default 7000).`

let values
try {
    ({ values } = parseArgs({
        options: {
            'host': { type: 'string' },
            'token-file': { type: 'string' },
            'evaluate': { type: 'boolean' },
            'allow-origin': { type: 'string', multiple: true },
            'allow-host': { type: 'string', multiple: true },
            'no-system': { type: 'boolean' },
            'no-audit-log': { type: 'boolean' },
            'audit-log-file': { type: 'string' },
            'help': { type: 'boolean', short: 'h' },
        },
        strict: true,
    }))
}
catch (err) {
    console.error(err.message)
    console.error(USAGE)
    process.exit(2)
}

if (values.help) {
    console.log(USAGE)
    process.exit(0)
}

const opt = {}
if (values.host) opt.host = values.host
if (values['token-file']) opt.tokenFile = values['token-file']
if (values.evaluate) opt.enableEvaluate = true
if (values['allow-origin']) opt.allowedOrigins = values['allow-origin']
if (values['allow-host']) opt.allowedHosts = values['allow-host']
if (values['no-system']) opt.enableSystem = false
if (values['no-audit-log']) opt.auditLog = false
if (values['audit-log-file']) opt.auditLogFile = values['audit-log-file']

WScreenctl(opt).catch((err) => {
    // 設定有誤／不安全而拒絕啟動：只印訊息，不印堆疊
    if (err && err.code === 'SCREENCTL_CONFIG') console.error(err.message)
    else console.error(err)
    process.exit(1)
})
