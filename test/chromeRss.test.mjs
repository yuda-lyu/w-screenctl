import assert from 'node:assert/strict'
import { parseTasklistCsvSumKb, parsePsRssChromeSumKb } from '../src/util/chromeRss.mjs'

describe('parseTasklistCsvSumKb', () => {

    it('sums multiple chrome rows (en-US thousands separator)', () => {
        const out = [
            '"chrome.exe","12345","Console","1","150,432 K"',
            '"chrome.exe","12346","Console","1","98,200 K"',
            '"chrome.exe","12347","Console","1","45,128 K"',
        ].join('\r\n')
        assert.equal(parseTasklistCsvSumKb(out), 150432 + 98200 + 45128)
    })

    it('returns 0 on INFO message (no matching task, en-US)', () => {
        const out = 'INFO: No tasks are running which match the specified criteria.\r\n'
        assert.equal(parseTasklistCsvSumKb(out), 0)
    })

    it('returns 0 on INFO message (zh-TW locale)', () => {
        const out = '資訊: 沒有執行符合指定準則的工作。\r\n'
        assert.equal(parseTasklistCsvSumKb(out), 0)
    })

    it('returns 0 on empty input', () => {
        assert.equal(parseTasklistCsvSumKb(''), 0)
    })

    it('handles thousands separator using dot (de-DE locale)', () => {
        const out = '"chrome.exe","1","C","1","1.024 K"'
        assert.equal(parseTasklistCsvSumKb(out), 1024)
    })

    it('handles single row without trailing newline', () => {
        const out = '"chrome.exe","999","Console","1","42 K"'
        assert.equal(parseTasklistCsvSumKb(out), 42)
    })

    it('skips malformed lines (less than 5 fields)', () => {
        const out = [
            '"chrome.exe","1","Console"',
            '"chrome.exe","2","Console","1","100 K"',
        ].join('\r\n')
        assert.equal(parseTasklistCsvSumKb(out), 100)
    })

    it('skips rows where mem field has no digits', () => {
        const out = [
            '"chrome.exe","1","Console","1","N/A"',
            '"chrome.exe","2","Console","1","50 K"',
        ].join('\r\n')
        assert.equal(parseTasklistCsvSumKb(out), 50)
    })

    it('accepts \\n line endings (not just \\r\\n)', () => {
        const out = [
            '"chrome.exe","1","Console","1","10 K"',
            '"chrome.exe","2","Console","1","20 K"',
        ].join('\n')
        assert.equal(parseTasklistCsvSumKb(out), 30)
    })

    it('coerces non-string input safely', () => {
        assert.equal(parseTasklistCsvSumKb(null), 0)
        assert.equal(parseTasklistCsvSumKb(undefined), 0)
    })

})

describe('parsePsRssChromeSumKb', () => {

    it('sums chrome rows from ps -o rss=,comm=', () => {
        const out = [
            '  150432 chrome',
            '   98200 chrome',
            '   45128 chrome',
        ].join('\n')
        assert.equal(parsePsRssChromeSumKb(out), 150432 + 98200 + 45128)
    })

    it('matches chromium', () => {
        const out = '  50000 chromium'
        assert.equal(parsePsRssChromeSumKb(out), 50000)
    })

    it('matches chrome_crashpad_handler', () => {
        const out = '   2048 chrome_crashpad'
        assert.equal(parsePsRssChromeSumKb(out), 2048)
    })

    it('does not match unrelated processes named like chrome', () => {
        const out = [
            '  10000 chromedriver',     // 不應算（不是 chrome 本體）
            '   5000 chromedriver-bin', // 不應算
        ].join('\n')
        // chromedriver 也以 chrome 開頭+driver，目前 regex `chrome([_-]|$)` 不允許 driver，故 0
        assert.equal(parsePsRssChromeSumKb(out), 0)
    })

    it('skips processes that merely have chrome in args (now we only match comm)', () => {
        const out = [
            '  20000 vim',     // 即使 args 是 chrome.log，comm 是 vim 不算
            '  30000 grep',
        ].join('\n')
        assert.equal(parsePsRssChromeSumKb(out), 0)
    })

    it('skips non-chrome processes', () => {
        const out = [
            '  10000 node',
            '  20000 chrome',
            '   5000 firefox',
        ].join('\n')
        assert.equal(parsePsRssChromeSumKb(out), 20000)
    })

    it('returns 0 on empty input', () => {
        assert.equal(parsePsRssChromeSumKb(''), 0)
    })

    it('returns 0 when no chrome process matches', () => {
        const out = [
            '  10000 node',
            '   5000 firefox',
        ].join('\n')
        assert.equal(parsePsRssChromeSumKb(out), 0)
    })

    it('coerces non-string input safely', () => {
        assert.equal(parsePsRssChromeSumKb(null), 0)
        assert.equal(parsePsRssChromeSumKb(undefined), 0)
    })

})
