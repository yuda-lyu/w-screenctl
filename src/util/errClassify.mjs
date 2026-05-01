// 錯誤分類：把任意 Error 物件分類成 { retry, code }
//
// 設計目標：給 caller 看的 retry hint 與一個穩定 code 寫程式分支用。
// 規則最小集，只覆蓋 caller 真實會遇到的幾種情境。
//
// retry: 'never' | 'after_500ms' | 'after_1s' | 'after_recovery'

const RULES = [
    { match: /chrome (closed|dead)|Target.*(closed|crashed)|browser has been disconnected|Execution context was destroyed/i,
        retry: 'after_recovery', code: 'CHROME_NOT_OPEN' },
    { match: /timeout|timed?\s?out/i, retry: 'after_1s', code: 'TIMEOUT' },
]

export function classify(err) {
    const msg = err && err.message ? err.message : String(err)
    // err.chromeState 標籤（ChromeManager 拋的錯）：closed / 其他非 open
    if (err && err.chromeState) {
        return { retry: 'after_recovery', code: 'CHROME_NOT_OPEN' }
    }
    for (const r of RULES) {
        if (r.match.test(msg)) return { retry: r.retry, code: r.code }
    }
    return { retry: 'never', code: 'UNKNOWN' }
}
