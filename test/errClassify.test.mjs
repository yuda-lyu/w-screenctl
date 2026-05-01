import assert from 'node:assert/strict'
import { classify } from '../src/util/errClassify.mjs'

describe('errClassify', () => {

    describe('chromeState 標籤優先', () => {
        it('closed → after_recovery / CHROME_NOT_OPEN', () => {
            const e = new Error('x'); e.chromeState = 'closed'
            assert.deepEqual(classify(e), { retry: 'after_recovery', code: 'CHROME_NOT_OPEN' })
        })
        it('任何 chromeState 標籤 → CHROME_NOT_OPEN', () => {
            const e = new Error('x'); e.chromeState = 'whatever'
            assert.deepEqual(classify(e), { retry: 'after_recovery', code: 'CHROME_NOT_OPEN' })
        })
    })

    describe('message regex（chromeState 沒帶時）', () => {
        it('"chrome closed" → CHROME_NOT_OPEN', () => {
            assert.equal(classify(new Error('chrome closed')).code, 'CHROME_NOT_OPEN')
        })
        it('"chrome dead" → CHROME_NOT_OPEN', () => {
            assert.equal(classify(new Error('chrome dead')).code, 'CHROME_NOT_OPEN')
        })
        it('Playwright Target closed → CHROME_NOT_OPEN', () => {
            assert.equal(classify(new Error('Target page, context or browser has been closed')).code, 'CHROME_NOT_OPEN')
        })
        it('Playwright Target crashed → CHROME_NOT_OPEN', () => {
            assert.equal(classify(new Error('Target browser has been crashed')).code, 'CHROME_NOT_OPEN')
        })
        it('Playwright disconnected → CHROME_NOT_OPEN', () => {
            assert.equal(classify(new Error('browser has been disconnected')).code, 'CHROME_NOT_OPEN')
        })
        it('Execution context destroyed → CHROME_NOT_OPEN', () => {
            assert.equal(classify(new Error('Execution context was destroyed')).code, 'CHROME_NOT_OPEN')
        })
        it('timeout → after_1s / TIMEOUT', () => {
            assert.deepEqual(classify(new Error('Timeout 30000ms exceeded')), { retry: 'after_1s', code: 'TIMEOUT' })
        })
        it('evaluate timeout → TIMEOUT', () => {
            assert.equal(classify(new Error('evaluate timeout 5s')).code, 'TIMEOUT')
        })
    })

    describe('未匹配 → never / UNKNOWN', () => {
        it('random error → UNKNOWN', () => {
            assert.deepEqual(classify(new Error('xdotool not found')), { retry: 'never', code: 'UNKNOWN' })
        })
        it('empty message → UNKNOWN', () => {
            assert.deepEqual(classify(new Error('')), { retry: 'never', code: 'UNKNOWN' })
        })
        it('null → UNKNOWN', () => {
            assert.deepEqual(classify(null), { retry: 'never', code: 'UNKNOWN' })
        })
        it('undefined → UNKNOWN', () => {
            assert.deepEqual(classify(undefined), { retry: 'never', code: 'UNKNOWN' })
        })
        it('plain string → UNKNOWN（除非含 timeout 等關鍵字）', () => {
            assert.deepEqual(classify('plain text'), { retry: 'never', code: 'UNKNOWN' })
        })
        it('string containing "timeout" still hit TIMEOUT', () => {
            assert.equal(classify('something timed out').code, 'TIMEOUT')
        })
    })

})
