import os from 'os'
import mk from 'w-mousekey/src/mousekey.mjs'
import sc from 'w-mousekey/src/screen.mjs'
import { getChromeRss } from '../util/chromeRss.mjs'

// xdotool 風格按鈕碼（1=左, 2=中, 3=右）→ w-mousekey 字串
const BTN = { 1: 'left', 2: 'middle', 3: 'right' }
const toBtn = (b) => BTN[b] || 'left'

async function screenshot(region) {
    const buf = region
        ? await sc.screen(region.x, region.y, region.width, region.height)
        : await sc.screenFull()
    return buf.toString('base64')
}

async function mouseClick(x, y, button = 1) {
    await mk.mouseClick(x, y, toBtn(button))
}

async function mouseDblClick(x, y) {
    await mk.mouseDblClick(x, y)
}

async function mouseDrag(fromX, fromY, toX, toY, button = 1) {
    await mk.mouseDrag(fromX, fromY, toX, toY, toBtn(button))
}

async function mouseScroll(x, y, direction, amount = 3) {
    await mk.mouseScroll(x, y, direction, amount)
}

async function keyboardKey(keys) {
    await mk.sendCombo(keys)
}

async function keyboardType(text) {
    await mk.sendString(text)
}

async function getMemoryInfo() {
    try {
        const total = os.totalmem()
        const free = os.freemem()
        const chromeRSS = await getChromeRss()
        return {
            total,
            used: total - free,
            available: free,
            chromeRSS,
        }
    }
    catch {
        return null
    }
}

export default {
    screenshot,
    mouseClick,
    mouseDblClick,
    mouseDrag,
    mouseScroll,
    keyboardKey,
    keyboardType,
    getMemoryInfo,
}
