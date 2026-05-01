import { classify } from './util/errClassify.mjs'

// 把 Error 轉成統一的 { ok: false, error, code, retry } 響應
export function errResponse(err) {
    const msg = err && err.message ? err.message : String(err)
    const { retry, code } = classify(err)
    return { ok: false, error: msg, code, retry }
}

// systemRoute：不需要 chrome instance（mouse/keyboard/screenshot 系統級）
export function systemRoute(name, fn) {
    return async (request, h) => {
        try {
            return await fn(request.payload || {}, h)
        }
        catch (err) {
            console.error(`[${name}] failed:`, err.message)
            return errResponse(err)
        }
    }
}

// chromeRoute：需要 chrome 開啟（page-level mouse/keyboard/screenshot/evaluate/navigate）
//   chromeManager.withPage 會在 state !== open 時拋 chromeState-tagged error，errResponse 轉成正確 retry
//   業務操作期間若 chrome 死亡，補 chromeState 於 catch 內，讓 classify 命中
export function chromeRoute(name, chromeManager, fn) {
    return async (request, h) => {
        try {
            return await chromeManager.withPage((inst) => fn(inst, request.payload || {}, h))
        }
        catch (err) {
            // 若 catch 時 chrome 已轉非 open，補上 chromeState 給 classify
            if (!err.chromeState && !chromeManager.isOpen()) {
                err.chromeState = 'closed'
            }
            console.error(`[${name}] failed:`, err.message)
            return errResponse(err)
        }
    }
}

// lifecycleRoute：直接操作 chromeManager（open/close）
export function lifecycleRoute(name, fn) {
    return async (request, h) => {
        try {
            return await fn(request.payload || {}, h)
        }
        catch (err) {
            console.error(`[${name}] failed:`, err.message)
            return errResponse(err)
        }
    }
}
