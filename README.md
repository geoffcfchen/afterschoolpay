# Afterschool Pay

Afterschool Pay 是給補習班與課後照顧團隊使用的收費、薪資與每日收支管理系統。目前專案使用 React、Vite 與 Firebase，主要工作區以「組織 > 分校 > 學生 / 老師 / 帳務」為核心。

目前預設組織是 `互動霧峰加盟校`，預設分校包含 `一校`、`二校`、`三校`。

## 目前功能

- **組織與團隊權限**：新使用者可建立組織或申請加入既有組織；等級 1 負責人可開通成員、調整角色與分校權限。
- **學生與課程**：第一次可匯入學費袋 Excel，匯入後資料會自動儲存到 Firestore；之後可直接在系統管理班級、課程、學生、全班日期、個別日期與雜項費用。
- **繳費通知單**：在 `/students-courses` 預覽並產生繳費通知單，通知單會存到學生帳戶底下。
- **點名表**：每個課程可開啟 A/B 班設定，同一位學生可在不同科目屬於不同 A/B 班，並可依課程與 A/B 班產生點名表。
- **老師薪資**：在 `/teacher-payroll` 建立老師與薪資單，支援月薪、8 堂課、多課程、時薪、時數與多筆額外薪資原因。
- **每日收支**：在 `/daily-ledger` 管理學生繳費通知單與老師薪資單狀態，並從這裡列印。

## 主要頁面

| 路徑 | 用途 |
| --- | --- |
| `/dashboard` | 登入後工作區入口，依權限顯示功能卡片 |
| `/organization-setup` | 建立組織或申請加入既有組織 |
| `/team-access` | 管理成員角色、權限與可查看分校 |
| `/students-courses` | 管理分校、班級、課程、學生、雜項費用、繳費通知單與點名表 |
| `/teacher-payroll` | 建立老師資料與老師薪資單 |
| `/daily-ledger` | 管理學生繳費與老師薪資發放狀態，並列印帳務單據 |

## 本機開發

安裝套件：

```bash
npm install
```

建立 `.env.local`，填入 Firebase Web App 設定：

```env
VITE_FB_API_KEY=...
VITE_FB_AUTH_DOMAIN=...
VITE_FB_PROJECT_ID=...
VITE_FB_STORAGE_BUCKET=...
VITE_FB_MESSAGING_SENDER_ID=...
VITE_FB_APP_ID=...
VITE_FB_MEASUREMENT_ID=...
```

啟動本機開發伺服器：

```bash
npm run dev
```

常用指令：

```bash
npm run dev
npm run build
npm run lint
npm run preview
```

## Firebase 設定

### Authentication

請在 Firebase Authentication 啟用：

- Email/Password
- Google

Google 登入需要設定 support email，並確認 Authorized domains 包含：

- `localhost`
- `afterschoolpay.com`
- `www.afterschoolpay.com`
- `afterschoolpay.firebaseapp.com`

登入流程會使用 `fetchSignInMethodsForEmail` 判斷 email 可用的登入方式。若 Firebase 專案啟用 Email enumeration protection，這個判斷可能無法正常回傳，需要在 Firebase Authentication 設定中關閉。

### Firestore Rules

Firestore rules 放在：

```text
firestore.rules
```

部署 rules：

```bash
firebase deploy --only firestore:rules
```

如果 Firebase CLI 顯示憑證過期，先重新登入：

```bash
firebase login --reauth
```

目前 `firestore.rules` 內的 bootstrap owner 是：

```text
gcfchen@gmail.com
```

如果第一位等級 1 負責人要改成其他 email，請先修改 `firestore.rules` 裡的 `isBootstrapOwner()`，再部署 rules。

## Firestore 資料結構

核心資料目前放在同一個 organization 底下：

```text
users/{uid}

organizations/{orgId}
organizations/{orgId}/members/{uid}
organizations/{orgId}/branches/{branchId}
organizations/{orgId}/programs/{programId}

organizations/{orgId}/branches/{branchId}/settings/feeOptions
organizations/{orgId}/branches/{branchId}/billingWorkspaces/current
organizations/{orgId}/branches/{branchId}/billingWorkspaces/current/classes/{classId}

organizations/{orgId}/students/{studentId}
organizations/{orgId}/students/{studentId}/invoices/{invoiceId}
organizations/{orgId}/students/{studentId}/payments/{paymentId}

organizations/{orgId}/employees/{employeeId}
organizations/{orgId}/employees/{employeeId}/salarySlips/{salarySlipId}
```

重要觀念：

- `users/{uid}` 是登入帳號 profile，紀錄目前使用者所屬組織。
- `organizations/{orgId}/members/{uid}` 是該組織內的角色、權限與分校範圍。
- 學生使用系統產生的唯一 `studentId`，不是 Excel 裡的舊 `編號`。舊編號只作為 legacy reference。
- 同一位學生可以跨分校有多張繳費通知單；每日收支會在學生 profile 集中顯示。
- 雜項表目前是分校層級設定，每個分校可以有自己的雜項費用表。
- 老師資料存在 `employees`，老師薪資單存在該老師底下的 `salarySlips`。

## 主要單據狀態

學生繳費通知單：

- `unpaid`：未付款
- `overdue`：已逾期
- `paid`：已付款
- `void`：作廢

老師薪資單：

- `unpaid`：未發放
- `paid`：已發放
- `void`：作廢

## GitHub Pages 部署

GitHub Actions workflow 位於：

```text
.github/workflows/deploy.yml
```

push 到 `main` 後會 build 並部署到 GitHub Pages。請在 GitHub repository secrets 設定：

```text
VITE_FB_API_KEY
VITE_FB_AUTH_DOMAIN
VITE_FB_PROJECT_ID
VITE_FB_STORAGE_BUCKET
VITE_FB_MESSAGING_SENDER_ID
VITE_FB_APP_ID
VITE_FB_MEASUREMENT_ID
```

GitHub Pages source 設定為 GitHub Actions，custom domain 使用：

```text
afterschoolpay.com
```

`public/CNAME` 會讓 custom domain 在每次部署後保留。

## 開發注意事項

- 匯入 Excel 主要是第一次導入資料；匯入後應以系統資料庫為主。
- `/students-courses` 與 `/daily-ledger` 使用 Firestore realtime listener，資料變更會即時反映。
- 新增班級、學生、雜項、日期與薪資單後，資料會直接寫入 Firestore，不需要額外按儲存。
- 新增 Firestore collection 或欄位時，記得同步檢查 `firestore.rules`。
