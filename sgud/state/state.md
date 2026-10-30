# 現況(state)

只記現況、不寫過程(過程見 `sgud/exp/experience.md`);藍圖見 `sgud/rule/rulebook.md`.最後更新:2026-10-30(a-screenctl:負載執行器改用 wsemi 1.9.33 統一版;src 零改動).`package.json` 版本 1.0.29(本輪未改版、未發布);相依已升 w-mousekey ^1.0.45、wsemi ^1.9.33.

## 功能狀態

| 功能 | 狀態 | 規則帳本 | 測試檔 | 已知缺口/待辦 |
|---|---|---|---|---|
| Chrome 生命週期(`/chrome/open`、`GET/DELETE /chrome`)、頁面操作(截圖、導頁、evaluate、頁面級滑鼠鍵盤) | 完成(本輪僅加閘門,語意未動) | — | `chromeManager`、`chromeRss`、`errClassify`、`routeFactory`、`bootRoutes`;`momo.e2e`(有頭,未納入 agent 自跑) | — |
| 系統級 `/screenshot`、`/mouse/*`、`/keyboard/*`(Windows: w-mousekey/AHK;Linux: xdotool+ImageMagick) | 完成;維持開啟,受 token 保護 | SEC-07 | `keyAlias`;閘門由 `api-security` 驗(以 Joi 400 判斷通過,不實際操作桌面) | 真實鍵鼠實際動作未於本輪重測(程式路徑未動) |
| 預設只綁本機 | 完成 | SEC-01 | `unit-security`、`api-security` R01、`api-security-g` | — |
| Bearer token(定時比較)、`/health` 免 token、未註冊路徑 | 完成 | SEC-02/03 | `unit-security`、`api-security` R02~R04 | 未註冊路徑與預檢走 Hapi 特殊路由,無 token 時回 404 而非 401(無 handler 執行,已鎖定於測試) |
| token 來源/自動產生/token 檔 | 完成 | SEC-09/11 | `unit-security`、`api-security` R09/R11、`api-security-g` | POSIX 0600 僅在 POSIX 驗(本機 Windows 測試略過 2 條);Windows 依資料夾 ACL(已載於 README/SECURITY) |
| CORS 預設關、Origin 白名單、Host 檢查 | 完成 | SEC-04/05/06 | `api-security` R05/R06/R10、`api-security-g` | 非迴路綁定時 Host 不檢查(刻意,需 `allowedHosts` 才啟用) |
| `/chrome/evaluate` 預設關 | 完成(403 `EVALUATE_DISABLED`) | SEC-07 | `api-security` R07、`api-security-g` | — |
| 非迴路綁定須 token 才啟動 | 完成 | SEC-08 | `unit-security`、`api-security` R08、`api-security-g` | 「非迴路 + token 實際綁定」不在測試實跑(Windows 防火牆對話框風險),僅 unit 覆蓋 |
| 操作紀錄(預設開):每次控制動作與被拒絕請求各一行 JSONL,參數摘要不含機敏內容 | 完成(screenctl-run02) | AUD-01~05、AUD-07 | `unit-audit`、`api-audit`、`api-security-g` | 紀錄檔 0600/目錄 0700 僅在 POSIX 驗(本機 Windows 略過);輪替失敗時丟棄新紀錄(維持有界);非防竄改;來源 IP 為 socket 位址(不信 `X-Forwarded-For`) |
| 系統級端點可關閉(`enableSystem`／`SCREENCTL_ENABLE_SYSTEM=0`／`--no-system`) | 完成;預設開(與 run01 一致) | AUD-06 | `api-audit`、`unit-audit`、`api-security-g` | 真實滑鼠鍵盤動作不在測試中實跑(替身驗證) |
| `g.mjs` 旗標(`--host --token-file --evaluate --allow-origin --allow-host --no-system --no-audit-log --audit-log-file --help`) | 完成;刻意無 `--token` | SEC-11、AUD-05/06 | `api-security-g` | — |
| `service/`(systemd、工作排程) | 已改為本機綁定 + token 由檔案/環境變數 | — | 無自動測試(設定檔) | 未於真實 systemd/排程器實跑 |
| README(安全預設、Upgrade Notes)、`SECURITY.md`、JSDoc | 完成 | — | — | `docs/` 與 `dist/` 由發布流程重建,目前仍是舊碼 |
| 計時器相關測試(事件同步;2026-10-30 tm-screenctl) | 完成:`api-audit`(32 個 sleep／輪詢站點→0)、`api-security-g`(`waitUp` 競爭子行程 exit、稽核落檔改 `fs.watch`、否定窗改後續請求界定)、`chromeManager`(queue 閘門、`_withDeadline` 補清計時器斷言)、`momo.e2e`(`sleep(5000)`→`readyState` 與截圖非空白之條件式重試);負載試驗工具 `test/tools/loadTrial.mjs`、`loadPreload.mjs`(整份複製自 wsemi 1.9.33 `test/tools/`,與 wsemi 版位元組全等,環境變數 `WSEMI_LT_*`,不退出失敗鍵 `(mocha did not exit)`,`--run-max` 預設 900 秒;已以本套件用法實跑);測試輔助 `respTap.mjs`、`fileWait.mjs` | TM-01~TM-08 | `api-audit`、`api-security-g`、`chromeManager`、`momo.e2e` | 沒有新增 `opt.onTrace`(稽核寫入器同步且無計時器,src 零改動);已知限制:計時器遲發之重複寫入僅由「收尾」總量守恆案抓,稽核寫入器若改非同步須先加 src 觀察回調;`momo.e2e` 有頭＋外網,不納入負載試驗 |

## 最近一次驗證

- 2026-10-26(run02):11 個非瀏覽器測試檔(既有 6 + `unit-security` 43 + `api-security` 54 + `unit-audit` 58 + `api-audit` 34 + `api-security-g` 15)**297 passing / 4 pending**(皆 POSIX 專屬:token 檔 0600 ×2、紀錄檔 0600/0700 ×2);變異 70/70 被抓到(run01 的 29 + run02 的 41;N40 首輪存活,測試夾具強化後被抓到);L5 真 `node g.mjs` + headless Chrome + 唯讀系統級截圖 42/42;rollup 建置 + UMD smoke 通過;`npm pack --dry-run` 26 檔;外審 sol 16 條全屬實並已處理(#8、#9 部分採納).
- 2026-10-26(run01):`unit-security`(43)+`api-security`(54)+`api-security-g`(10)+既有非瀏覽器測試(97)共 202 passing / 2 pending(POSIX 權限);變異 29/29;L5 22/22;外審 sol 16 條(15 採納修正,1 條範圍外).
- 未跑:`momo.e2e`(有頭視窗+外網;已改 `auditLog:false`、`node --check` 通過).
- 測試接縫:`WScreenctl({ backend })` 可注入系統級後端替身(進階/測試用),`persistToken(file, token, { replace, fsApi })` 可注入檔案系統故障.
- token 檔:預設 `~/.w-screenctl/token-<port>`(非預設位址為 `token-<位址>-<port>`,每次啟動重生、暫存檔 rename 取代);明指之 `tokenFile` 存在則讀、不存在則新建(`link`,已存在即 EEXIST 拒絕啟動).

## 發布前檢查(給主控)

- `dist/w-screenctl.umd.js` 目前為舊碼(`grep -c SCREENCTL_TOKEN`、`grep -c audit-` 皆為 0);發布流程重建後應 ≥ 1.
- `npm pack --dry-run` 應為 26 檔(見 `.npmignore`)且含 `src/security.mjs`、`src/auditLog.mjs`.
- 測試/驗證腳本不得寫真實 `~/.w-screenctl`:跑完以 `ls ~/.w-screenctl` 確認不存在(AUD-08).
