// 測試輔助：以 Hapi server 的 'response' 事件作為同步點（取代「sleep 後讀紀錄檔」與輪詢）
//
// 依據：
// - Hapi 於每個請求結束時（含被閘門攔下、404、預檢、客戶端中途斷線）恰發一次 'response' 事件（request._finalize）
// - 事件由 podium 同步、依註冊順序呼叫監聽器；稽核寫入器（src/WScreenctl.mjs 的 server.events.on('response', audit.record)）
//   於啟動時先註冊，且 audit.record 為同步 append，所以「本輔助註冊之監聽器被呼叫」時，該請求之稽核紀錄已寫入或確定不會寫入
// - 因此：事件到達後立即讀紀錄檔即是最終狀態；「不應有紀錄」「不應多一筆」由事件序判定，不需要觀察窗
//
// 防懸置上限（watchdog）用模組載入時保存之真實計時器，只防「事件永不來」，不表達規格；逾時以明確訊息失敗
import { rawRequest } from './rawHttp.mjs'

const realSetTimeout = setTimeout
const realClearTimeout = clearTimeout

export const WATCHDOG_MS = 30000

/**
 * 以真實計時器為上限等待一個 promise（只防懸置）
 *
 * @param {Promise} p 要等的 promise
 * @param {String} label 逾時時的說明
 * @param {Integer} [ms=WATCHDOG_MS]
 * @returns {Promise}
 */
export function guard(p, label, ms = WATCHDOG_MS) {
    let timer
    const wd = new Promise((_resolve, reject) => {
        timer = realSetTimeout(() => reject(new Error(`watchdog ${ms}ms: ${label}`)), ms)
    })
    return Promise.race([p, wd]).finally(() => realClearTimeout(timer))
}

/** @returns {{promise: Promise, resolve: Function}} */
export function deferred() {
    let done
    const promise = new Promise((resolve) => {
        done = resolve
    })
    return { promise, resolve: done }
}

/**
 * 在 Hapi server 上掛 'response' 事件計數器
 *
 * @param {Object} server Hapi server（WScreenctl 的回傳值）；須在其建立之後才呼叫（監聽器順序在稽核寫入器之後）
 * @param {Object} [o]
 * @param {Integer} [o.watchdogMs=WATCHDOG_MS]
 * @returns {{seen: Number, waitSeen: Function, request: Function, expect: Function}}
 */
export function tapResponses(server, { watchdogMs = WATCHDOG_MS } = {}) {
    let seen = 0
    let issued = 0
    let waiters = []

    server.events.on('response', () => {
        seen++
        const ready = waiters.filter((w) => seen >= w.n)
        waiters = waiters.filter((w) => seen < w.n)
        for (const w of ready) {
            realClearTimeout(w.timer)
            w.resolve(seen)
        }
    })

    const waitSeen = (n, label = '') => {
        if (seen >= n) return Promise.resolve(seen)
        return new Promise((resolve, reject) => {
            const w = { n, resolve }
            w.timer = realSetTimeout(() => {
                waiters = waiters.filter((x) => x !== w)
                reject(new Error(`watchdog ${watchdogMs}ms: 伺服器端 response 事件未達 ${n}（目前 ${seen}）${label ? `：${label}` : ''}`))
            }, watchdogMs)
            waiters.push(w)
        })
    }

    return {
        get seen() {
            return seen
        },
        waitSeen,
        /** 登記「不經 request() 送出」之請求數（例如自行以 node:http 送出並中途斷線者） */
        expect(k = 1) {
            issued += k
            return issued
        },
        /** 送出請求，並等到伺服器端已處理完（response 事件；此時稽核紀錄已同步寫入）才回傳 */
        async request(opt) {
            const n = ++issued
            const r = await rawRequest(opt)
            await waitSeen(n, `${opt.method || 'GET'} ${opt.path || '/'}`)
            return r
        },
    }
}
