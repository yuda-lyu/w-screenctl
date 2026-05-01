import assert from 'node:assert/strict'
import { errResponse } from '../src/routeFactory.mjs'

describe('errResponse', () => {

    it('chromeState=closed → retry: after_recovery', () => {
        const err = new Error('chrome closed')
        err.chromeState = 'closed'
        assert.equal(errResponse(err).retry, 'after_recovery')
    })

    it('chromeState=dead → retry: after_recovery', () => {
        const err = new Error('chrome dead')
        err.chromeState = 'dead'
        assert.equal(errResponse(err).retry, 'after_recovery')
    })

    it('timeout message → retry: after_1s', () => {
        const err = new Error('xdotool timeout')
        assert.equal(errResponse(err).retry, 'after_1s')
    })

    it('unknown error → retry: never', () => {
        const err = new Error('xdotool not found in PATH')
        assert.equal(errResponse(err).retry, 'never')
    })

    it('non-Error coerces safely', () => {
        const r = errResponse('plain string')
        assert.equal(r.ok, false)
        assert.equal(r.error, 'plain string')
        assert.equal(r.retry, 'never')
        assert.equal(r.code, 'UNKNOWN')
    })

    it('shape is { ok, error, code, retry }', () => {
        const r = errResponse(new Error('foo'))
        assert.deepEqual(Object.keys(r).sort(), ['code', 'error', 'ok', 'retry'])
    })

    it('Playwright Target closed → after_recovery + CHROME_NOT_OPEN', () => {
        const err = new Error('Target page, context or browser has been closed')
        const r = errResponse(err)
        assert.equal(r.retry, 'after_recovery')
        assert.equal(r.code, 'CHROME_NOT_OPEN')
    })

    it('未匹配的環境錯誤 → never / UNKNOWN', () => {
        const err = new Error('spawn xdotool ENOENT')
        const r = errResponse(err)
        assert.equal(r.retry, 'never')
        assert.equal(r.code, 'UNKNOWN')
    })

})
