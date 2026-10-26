# 現況(state)

只記現況、不寫過程(過程見 `sgud/exp/experience.md`);藍圖見 `sgud/rule/rulebook.md`.最後更新:2026-10-26(screenctl-run01).`package.json` 版本 1.0.26(本輪未改版、未發布;npm 帳號暫時被鎖).

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
| `g.mjs` 旗標(`--host --token-file --evaluate --allow-origin --allow-host --help`) | 完成;刻意無 `--token` | SEC-11 | `api-security-g` | — |
| `service/`(systemd、工作排程) | 已改為本機綁定 + token 由檔案/環境變數 | — | 無自動測試(設定檔) | 未於真實 systemd/排程器實跑 |
| README(安全預設、Upgrade Notes)、`SECURITY.md`、JSDoc | 完成 | — | — | `docs/` 與 `dist/` 由發布流程重建,目前仍是舊碼 |

## 最近一次驗證

- 2026-10-26:`unit-security`(43)+`api-security`(54)+`api-security-g`(10)+既有非瀏覽器測試(97)共 202 passing / 2 pending(POSIX 權限);變異 29/29 被抓到;L5 真 Chrome(headless)+跨站探測頁 22/22;修前 HEAD 對照組可被跨站頁面導向任意位址;外審 sol 16 條已核對(15 採納修正,1 條範圍外).
- 未跑:`momo.e2e`(有頭視窗+外網).
- 測試接縫:`WScreenctl({ backend })` 可注入系統級後端替身(進階/測試用),`persistToken(file, token, { replace, fsApi })` 可注入檔案系統故障.
- token 檔:預設 `~/.w-screenctl/token-<port>`(非預設位址為 `token-<位址>-<port>`,每次啟動重生、暫存檔 rename 取代);明指之 `tokenFile` 存在則讀、不存在則新建(`link`,已存在即 EEXIST 拒絕啟動).

## 發布前檢查(給主控)

- `dist/w-screenctl.umd.js` 目前為舊碼(`grep -c SCREENCTL_TOKEN` 為 0);發布流程重建後應 ≥ 1.
- `npm pack --dry-run` 應為 25 檔(見 `.npmignore`)且含 `src/security.mjs`.
