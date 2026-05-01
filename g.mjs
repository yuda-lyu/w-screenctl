// 啟動腳本：給 systemd / Windows 工作排程等 service 用
// 直接 `node g.mjs` 即啟動，預設 port 7000；可由 env PORT 覆寫
import WScreenctl from './src/WScreenctl.mjs'

WScreenctl().catch((err) => {
    console.error(err)
    process.exit(1)
})
