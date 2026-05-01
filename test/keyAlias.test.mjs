import assert from 'node:assert/strict'
import { normalizeKey } from '../src/util/keyAlias.mjs'

describe('normalizeKey', () => {

    describe('Enter / Return alias', () => {
        it('Enter -> Return', () => assert.equal(normalizeKey('Enter'), 'Return'))
        it('enter -> Return', () => assert.equal(normalizeKey('enter'), 'Return'))
        it('RETURN -> Return', () => assert.equal(normalizeKey('RETURN'), 'Return'))
        it('Return idempotent', () => assert.equal(normalizeKey('Return'), 'Return'))
    })

    describe('其他特殊鍵 alias', () => {
        it('Esc -> Escape', () => assert.equal(normalizeKey('Esc'), 'Escape'))
        it('Del -> Delete', () => assert.equal(normalizeKey('Del'), 'Delete'))
        it('Backspace -> BackSpace', () => assert.equal(normalizeKey('Backspace'), 'BackSpace'))
        it('PageUp -> Page_Up', () => assert.equal(normalizeKey('PageUp'), 'Page_Up'))
        it('pgdn -> Page_Down', () => assert.equal(normalizeKey('pgdn'), 'Page_Down'))
        it('SPACE -> space', () => assert.equal(normalizeKey('SPACE'), 'space'))
        it('CapsLock -> Caps_Lock', () => assert.equal(normalizeKey('CapsLock'), 'Caps_Lock'))
        it('PrintScreen -> Print', () => assert.equal(normalizeKey('PrintScreen'), 'Print'))
    })

    describe('修飾鍵 alias', () => {
        it('Control -> ctrl', () => assert.equal(normalizeKey('Control'), 'ctrl'))
        it('CTRL -> ctrl', () => assert.equal(normalizeKey('CTRL'), 'ctrl'))
        it('Meta -> super', () => assert.equal(normalizeKey('Meta'), 'super'))
        it('Win -> super', () => assert.equal(normalizeKey('Win'), 'super'))
        it('Control_L -> ctrl', () => assert.equal(normalizeKey('Control_L'), 'ctrl'))
    })

    describe('組合鍵', () => {
        it('Ctrl+Enter -> ctrl+Return', () => assert.equal(normalizeKey('Ctrl+Enter'), 'ctrl+Return'))
        it('Control+v -> ctrl+v (Playwright 風格)', () =>
            assert.equal(normalizeKey('Control+v'), 'ctrl+v'))
        it('CTRL+SHIFT+t -> ctrl+shift+t', () =>
            assert.equal(normalizeKey('CTRL+SHIFT+t'), 'ctrl+shift+t'))
        it('alt+F4 idempotent', () => assert.equal(normalizeKey('alt+F4'), 'alt+F4'))
        it('alt+f4 -> alt+F4', () => assert.equal(normalizeKey('alt+f4'), 'alt+F4'))
        it('super+l idempotent', () => assert.equal(normalizeKey('super+l'), 'super+l'))
        it('Win+r -> super+r', () => assert.equal(normalizeKey('Win+r'), 'super+r'))
    })

    describe('F 鍵', () => {
        it('F5 idempotent', () => assert.equal(normalizeKey('F5'), 'F5'))
        it('f12 -> F12', () => assert.equal(normalizeKey('f12'), 'F12'))
        it('F24 idempotent', () => assert.equal(normalizeKey('F24'), 'F24'))
    })

    describe('passthrough（未知 / 單字元）', () => {
        it('a -> a', () => assert.equal(normalizeKey('a'), 'a'))
        it('A -> A (保留大小寫，xdotool 接受)', () => assert.equal(normalizeKey('A'), 'A'))
        it('1 -> 1', () => assert.equal(normalizeKey('1'), '1'))
        it('plus -> plus (X11 keysym 名稱原樣)', () => assert.equal(normalizeKey('plus'), 'plus'))
        it('unknown_key -> unknown_key', () =>
            assert.equal(normalizeKey('unknown_key'), 'unknown_key'))
    })

    describe('容錯', () => {
        it('空白被 trim', () => assert.equal(normalizeKey('ctrl + Enter'), 'ctrl+Return'))
        it('null 拋 TypeError', () => assert.throws(() => normalizeKey(null), TypeError))
        it('undefined 拋 TypeError', () => assert.throws(() => normalizeKey(undefined), TypeError))
        it('number 拋 TypeError', () => assert.throws(() => normalizeKey(123), TypeError))
        it('空字串維持原樣', () => assert.equal(normalizeKey(''), ''))
    })

})
