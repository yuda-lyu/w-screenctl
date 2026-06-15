import { execFile } from 'child_process'
import { promisify } from 'util'
import { userInfo } from 'os'


const execFileAsync = promisify(execFile)
const TIMEOUT_MS = 5000

// 解析 tasklist /FO CSV /NH 的輸出，加總 Mem Usage 欄位（KB）。純函式。
//   行首非 " 視為非資料行（INFO / 空行 / 警告）跳過，避免依賴語系字串。
//   Mem Usage 欄位形如 "150,432 K" / "1.024 K"（語系決定千分號），用 \D+ 移除非數字。
export function parseTasklistCsvSumKb(stdout) {
    let totalKb = 0
    for (const lineRaw of String(stdout).split(/\r?\n/)) {
        const line = lineRaw.trim()
        if (!line.startsWith('"')) continue
        const fields = line.replace(/^"/, '').replace(/"$/, '').split('","')
        if (fields.length < 5) continue
        const digits = fields[4].replace(/\D+/g, '')
        if (!digits) continue
        totalKb += parseInt(digits, 10)
    }
    return totalKb
}

// 解析 ps -o rss=,comm= 的輸出，加總 chrome / chromium 程序 RSS（KB）。純函式。
//   只用 comm（程序執行檔名稱）精準匹配，避免 args 內含 chrome 字樣的非 chrome 程序被誤計
//   （如 vim chrome.log、grep chrome ...）。
export function parsePsRssChromeSumKb(stdout) {
    let totalKb = 0
    for (const line of String(stdout).split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\S+)/)
        if (!m) continue
        const rss = parseInt(m[1], 10)
        const comm = m[2]
        // ps -o comm= 在 Linux 上預設截到 15 字元，仍能精準匹配 chrome / chromium / chrome_crashpad 等
        if (/^chrome([_-]|$)|^chromium([_-]|$)/.test(comm)) {
            totalKb += rss
        }
    }
    return totalKb
}

async function getChromeRssLinux() {
    try {
        const uid = userInfo().uid
        const { stdout } = await execFileAsync(
            'ps',
            ['-u', String(uid), '-o', 'rss=,comm='],
            { encoding: 'utf8', timeout: TIMEOUT_MS },
        )
        return parsePsRssChromeSumKb(stdout) * 1024
    }
    catch {
        return 0
    }
}

async function getChromeRssWin32() {
    try {
        const { stdout } = await execFileAsync(
            'tasklist',
            ['/FI', 'IMAGENAME eq chrome.exe', '/FO', 'CSV', '/NH'],
            { encoding: 'utf8', windowsHide: true, timeout: TIMEOUT_MS },
        )
        return parseTasklistCsvSumKb(stdout) * 1024
    }
    catch {
        return 0
    }
}

// 回傳 Chrome 全部程序加總的 RSS（byte）。失敗回 0，永遠不丟。
export async function getChromeRss() {
    if (process.platform === 'win32') return getChromeRssWin32()
    return getChromeRssLinux()
}
