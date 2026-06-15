import { join } from 'path'
import { mkdirSync, readFileSync, unlinkSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import { getChromeRss } from '../util/chromeRss.mjs'


const execFileAsync = promisify(execFile)

const DISPLAY = process.env.DISPLAY || ':99'
const SCREENSHOT_DIR = '/tmp/screenshots'
const TIMEOUT_MS = 5000

const env = () => ({ ...process.env, DISPLAY })
const opts = () => ({ env: env(), timeout: TIMEOUT_MS })

async function screenshot(region) {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    const file = join(SCREENSHOT_DIR, `sc_${randomUUID()}.png`)
    try {
        if (region) {
            const geo = `${region.width}x${region.height}+${region.x}+${region.y}`
            await execFileAsync('import', ['-window', 'root', '-crop', geo, file], opts())
        }
        else {
            await execFileAsync('import', ['-window', 'root', file], opts())
        }
        return readFileSync(file).toString('base64')
    }
    finally {
        try {
            unlinkSync(file)
        }
        catch {}
    }
}

async function mouseClick(x, y, button = 1) {
    await execFileAsync('xdotool',
        ['mousemove', String(x), String(y), 'click', String(button)],
        opts())
}

async function mouseDblClick(x, y) {
    await execFileAsync('xdotool',
        ['mousemove', String(x), String(y), 'click', '--repeat', '2', '1'],
        opts())
}

async function mouseDrag(fromX, fromY, toX, toY, button = 1) {
    await execFileAsync('xdotool', [
        'mousemove', String(fromX), String(fromY),
        'mousedown', String(button),
        'mousemove', '--sync', String(toX), String(toY),
        'mouseup', String(button),
    ], opts())
}

async function mouseScroll(x, y, direction, amount = 3) {
    const btnMap = { up: 4, down: 5, left: 6, right: 7 }
    const btn = btnMap[direction] || 5
    await execFileAsync('xdotool',
        ['mousemove', String(x), String(y), 'click', '--repeat', String(amount), String(btn)],
        opts())
}

async function keyboardKey(keys) {
    await execFileAsync('xdotool', ['key', '--', String(keys)], opts())
}

async function keyboardType(text) {
    // ASCII printable 走 xdotool type，控制字元 (\t \n \r) 對應特殊鍵，其他非 ASCII 走 xdotool key U<codepoint>
    const SPECIAL_CTRL = { 0x09: 'Tab', 0x0A: 'Return', 0x0D: 'Return' }
    const parts = []
    let asciiBuffer = ''
    for (const ch of text) {
        const code = ch.codePointAt(0)
        if (code >= 0x20 && code <= 0x7E) {
            asciiBuffer += ch
        }
        else {
            if (asciiBuffer) {
                parts.push({ type: 'ascii', text: asciiBuffer })
                asciiBuffer = ''
            }
            const key = SPECIAL_CTRL[code] || `U${code.toString(16)}`
            parts.push({ type: 'unicode', key })
        }
    }
    if (asciiBuffer) {
        parts.push({ type: 'ascii', text: asciiBuffer })
    }
    for (const part of parts) {
        if (part.type === 'ascii') {
            await execFileAsync('xdotool',
                ['type', '--clearmodifiers', '--', part.text],
                opts())
        }
        else {
            await execFileAsync('xdotool', ['key', part.key], opts())
        }
    }
}

async function getMemoryInfo() {
    try {
        const { stdout } = await execFileAsync('free', ['-b'], { encoding: 'utf8', timeout: TIMEOUT_MS })
        const mem = stdout.trim().split('\n')[1].split(/\s+/)
        const chromeRSS = await getChromeRss()
        return {
            total: parseInt(mem[1], 10),
            used: parseInt(mem[2], 10),
            available: parseInt(mem[6], 10),
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
