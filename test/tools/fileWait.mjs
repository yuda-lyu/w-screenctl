// 測試輔助：等「他行程寫的檔案」達到指定行數（以 fs.watch 的檔案系統通知為同步點，不輪詢、不 sleep）
//
// 用於被測物在子行程（例如 node g.mjs）、測試端拿不到其內部事件的情境。
// 先建立監看再做第一次檢查（不漏掉建立監看前已發生之寫入）；每次通知都重新檢查條件。
// 防懸置上限用真實計時器，只防「通知永不來」；逾時時若條件其實已成立，訊息會註明「檔案已達標但 fs.watch 未通知」以便辨識監看漏報
import fs from 'node:fs'
import path from 'node:path'

const realSetTimeout = setTimeout
const realClearTimeout = clearTimeout

export function countLines(file) {
    try {
        return fs.readFileSync(file, 'utf8').split('\n').filter((x) => x !== '').length
    }
    catch {
        return 0
    }
}

/**
 * @param {String} file 檔案路徑（其所在資料夾須已存在）
 * @param {Integer} n 至少幾行
 * @param {Object} [o]
 * @param {Integer} [o.watchdogMs=45000]
 * @returns {Promise<Integer>} 達標時之行數
 */
export function waitFileLines(file, n, { watchdogMs = 45000 } = {}) {
    return new Promise((resolve, reject) => {
        const base = path.basename(file)
        let watcher = null
        let timer = null
        let done = false
        const finish = (fn, v) => {
            if (done) return
            done = true
            realClearTimeout(timer)
            try {
                watcher && watcher.close()
            }
            catch {}
            fn(v)
        }
        const check = (_evType, name) => {
            if (name && String(name) !== base) return
            const c = countLines(file)
            if (c >= n) finish(resolve, c)
        }
        try {
            watcher = fs.watch(path.dirname(file), { persistent: false }, check)
        }
        catch (err) {
            finish(reject, err)
            return
        }
        watcher.on('error', (err) => finish(reject, err))
        timer = realSetTimeout(() => {
            const c = countLines(file)
            finish(reject, new Error(`watchdog ${watchdogMs}ms: ${file} 只有 ${c} 行，預期至少 ${n}${c >= n ? '（檔案已達標但 fs.watch 未通知）' : ''}`))
        }, watchdogMs)
        check()
    })
}
