# 回饋

任務中發現之自有套件、全域技能、全域設定之調整與抽提提案.只增不改;處置結果(已通報、已修、不採納)另記一列並寫明承接哪一列.回饋是紀錄與提案,實際修改走主控之通報管道.

| 日期 | 類別 | 對象 | 內容 | 依據 |
|---|---|---|---|---|
| 2026-11-12 | 全域技能 | role-coder-for-validate(Step 1 輸入空間表之「相依大版升級」軸) | 現列軸只有「舊版預設會自動做、新版移除者」。建議增列對稱的一軸:**新版新增、且早於本套件擴充點執行之前置驗證/攔截**——例:@hapi/hapi 21.4.13 於 `_onRequest` 開頭驗 Host(RFC 9112 3.2),早於所有 `onRequest` 擴充,使本套件 `onRequest` 內「格式異常 Host→403＋操作紀錄」的契約失效(實得 Hapi 之 400,且不寫紀錄)。掃描法:凡在擴充點內做的拒絕/紀錄,逐項問「框架會不會先擋」,並以框架原始碼的生命週期入口(此例 `request.js` 之 `_onRequest`)列出先行檢查 | `sgud/exp/experience.md`〈升 @hapi/hapi 21.4.13〉;`src/security.mjs`(`onPreResponse`);跟跑紅案 `test/api-security.test.mjs` R06、`test/api-audit.test.mjs` A02 |
| 2026-11-12 | 全域技能 | role-coder-for-test(§5 或附註) | 以 Edit 寫入含 ` ` 等轉義之測試字串,工具會把轉義轉成字面字元,eslint `no-irregular-whitespace` 報錯(本輪再次發生;`sgud/exp/experience.md` 已有同條)。建議於本技能加一句:寫入此類字串後立即以 `grep -c $'\xc2\xa0'` 或 eslint 檢查,改以 Write 腳本換回轉義文字 | `npx eslint test/api-security.test.mjs`(2 error,修後 0);`sgud/exp/experience.md`〈預設安全化〉第 22 條 |
