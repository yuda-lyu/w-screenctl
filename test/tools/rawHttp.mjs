// 測試輔助：以 node:http 送請求，可自訂 Host / Origin 等 fetch 不允許（或不保證）覆寫之標頭
import http from 'node:http'
import net from 'node:net'


/**
 * 以原始 TCP 送出一段 HTTP 文字（可寫出 node:http 用戶端不會產生的請求，例如重複的 Host 標頭）
 * 呼叫端須自行在文字中帶 `Connection: close`
 *
 * @param {Object} o
 * @param {Integer} o.port 目標 port
 * @param {String} o.text 完整請求文字（以 \r\n 換行）
 * @param {String} [o.address='127.0.0.1'] 連線位址
 * @returns {Promise<{status: Number, text: String, json: *}>}
 */
export function rawSocket({ port, text, address = '127.0.0.1' }) {
    return new Promise((resolve, reject) => {
        const chunks = []
        const sock = net.connect({ host: address, port }, () => sock.write(text))
        sock.setTimeout(10000, () => sock.destroy(new Error('rawSocket timeout 10s')))
        sock.on('data', (c) => chunks.push(c))
        sock.on('error', reject)
        sock.on('close', () => {
            const all = Buffer.concat(chunks).toString('utf8')
            const m = /^HTTP\/1\.[01] (\d{3})/.exec(all)
            const body = all.split('\r\n\r\n').slice(1).join('\r\n\r\n')
            let json = null
            try {
                json = JSON.parse(body)
            }
            catch {}
            resolve({ status: m ? Number(m[1]) : 0, text: all, json })
        })
    })
}


/**
 * 送一個 HTTP 請求並回傳 { status, headers, text, json }
 *
 * @param {Object} o
 * @param {Integer} o.port 目標 port
 * @param {String} [o.method='GET'] HTTP 方法
 * @param {String} [o.path='/'] 路徑
 * @param {Object} [o.headers={}] 標頭（可含 host / origin / authorization）
 * @param {*} [o.body] 物件會 JSON.stringify，字串原樣送出
 * @param {String} [o.address='127.0.0.1'] 實際連線之位址（與 Host 標頭無關）
 * @param {Boolean} [o.setHost=true] false 則不自動補 Host 標頭
 * @returns {Promise<Object>}
 */
export function rawRequest({ port, method = 'GET', path = '/', headers = {}, body, address = '127.0.0.1', setHost = true }) {
    return new Promise((resolve, reject) => {
        const h = { ...headers }
        let payload = null
        if (body !== undefined) {
            payload = typeof body === 'string' ? body : JSON.stringify(body)
            if (!Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['content-type'] = 'application/json'
        }
        const req = http.request({ host: address, port, method, path, headers: h, setHost }, (res) => {
            const chunks = []
            res.on('data', (c) => chunks.push(c))
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8')
                let json = null
                try {
                    json = JSON.parse(text)
                }
                catch {}
                resolve({ status: res.statusCode, headers: res.headers, text, json })
            })
        })
        req.setTimeout(10000, () => req.destroy(new Error('rawRequest timeout 10s')))
        req.on('error', reject)
        if (payload !== null) req.write(payload)
        req.end()
    })
}
