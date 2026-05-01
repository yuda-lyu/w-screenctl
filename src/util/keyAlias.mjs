// 把 caller 任意風格的按鍵組合，正規化為 xdotool 標準寫法。
//   - 修飾鍵 → 小寫（ctrl / shift / alt / super）
//   - 特殊鍵 → X11 keysym 標準（Return / BackSpace / Page_Up / space ...）
//   - F1~F24 → 大寫 F + 數字
//   - 單字元、未知 token → 原樣傳出
// 正規化後的字串送入 backend 兩邊都通：
//   linux: 直接餵給 xdotool key
//   win32: 餵給 w-mousekey sendCombo（內部 lowercase 後查表，相容）

const ALIAS = {
    // 修飾鍵
    ctrl: 'ctrl', control: 'ctrl', control_l: 'ctrl', control_r: 'ctrl',
    shift: 'shift', shift_l: 'shift', shift_r: 'shift',
    alt: 'alt', alt_l: 'alt', alt_r: 'alt',
    super: 'super', super_l: 'super', super_r: 'super',
    meta: 'super', win: 'super',
    // 特殊鍵
    return: 'Return', enter: 'Return',
    escape: 'Escape', esc: 'Escape',
    backspace: 'BackSpace',
    delete: 'Delete', del: 'Delete',
    insert: 'Insert', ins: 'Insert',
    tab: 'Tab',
    home: 'Home', end: 'End',
    page_up: 'Page_Up', pageup: 'Page_Up', pgup: 'Page_Up', prior: 'Page_Up',
    page_down: 'Page_Down', pagedown: 'Page_Down', pgdn: 'Page_Down', next: 'Page_Down',
    up: 'Up', down: 'Down', left: 'Left', right: 'Right',
    space: 'space',
    caps_lock: 'Caps_Lock', capslock: 'Caps_Lock',
    num_lock: 'Num_Lock', numlock: 'Num_Lock',
    scroll_lock: 'Scroll_Lock', scrolllock: 'Scroll_Lock',
    print: 'Print', printscreen: 'Print',
    pause: 'Pause',
}

for (let i = 1; i <= 24; i++) {
    ALIAS[`f${i}`] = `F${i}`
}

function normalizeToken(t) {
    const lower = t.toLowerCase()
    if (ALIAS[lower]) return ALIAS[lower]
    return t
}

export function normalizeKey(combo) {
    if (typeof combo !== 'string') {
        throw new TypeError(`normalizeKey: expected string, got ${combo === null ? 'null' : typeof combo}`)
    }
    return combo.split('+').map((t) => normalizeToken(t.trim())).join('+')
}
