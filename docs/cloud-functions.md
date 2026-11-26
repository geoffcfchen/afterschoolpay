# Cloud Functions 邊界

Afterschool Pay 會逐步把「需要後端可信任執行」的流程移到 Cloud Functions。第一波已建立 callable function：

```text
createStudentInvoicePayment
```

## 已搬移

### 確認收款並開收據

前端現在會先呼叫 `createStudentInvoicePayment`。Cloud Function 會：

- 確認使用者已登入
- 確認使用者是該組織 active member
- 確認使用者有 `canRecordDailyLedger`
- 確認使用者可以在收款分校操作
- 用 Firestore transaction 建立 payment
- 同一個 transaction 更新 invoice 的 `paidTotal`、`balance`、`status`
- 產生 `receiptNumber`
- 寫入 `organizations/{orgId}/auditLogs/{auditLogId}`

目前保留前端 transaction fallback：如果 function 尚未部署或暫時不可用，付款流程仍可運作。等 staging/production functions 都部署完成後，下一步可以移除 fallback，並收緊 Firestore rules，禁止前端直接建立 payment。

## 適合搬到 Cloud Functions 的流程

| 流程 | 原因 | 建議優先順序 |
| --- | --- | --- |
| 收款與收據 | 需要不可重複收據號、transaction、收款人紀錄與 audit log | 已開始 |
| 老師薪資發放 | 需要記錄發放人、發放日期、不可被前端任意改金額 | 高 |
| 作廢繳費通知單 / 作廢薪資單 | 需要理由、操作者與 audit log | 高 |
| 雜項支出 | 需要建立人、分校權限、修改歷史 | 中 |
| 月結 / 收支總覽快照 | 需要固定每月結果，避免歷史資料變動造成報表漂移 | 中 |
| 自動標示逾期通知單 | 適合 scheduled function 每天檢查 | 中 |
| PDF / 收據快照 | 需要保存當下列印內容，避免後續學生資料變更影響舊收據 | 中 |

## 目前暫不搬移

- 一般 UI 編輯狀態
- 班級日期微調
- 學生課程選取
- 即時列表讀取

這些仍適合由前端直接寫 Firestore，並用 Firestore rules 控制權限。
