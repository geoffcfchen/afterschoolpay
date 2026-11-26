# 環境設定

Afterschool Pay 目前採用三個層級來管理品質與上線風險：

| 環境 | Git 分支 | 用途 | 部署目標 |
| --- | --- | --- | --- |
| 本機開發 | `codex/*` 或 feature branch | 開發與快速驗證 | `npm run dev` |
| Staging | `staging` | 給內部測試、確認資料規則與 UI 流程 | Firebase Hosting + Firestore rules + Cloud Functions |
| Production | `main` | 正式給補習班使用 | GitHub Pages + production Firestore rules + Cloud Functions |

## Firebase 專案

建議建立兩個 Firebase project：

| 環境 | Firebase project id |
| --- | --- |
| Production | `afterschoolpay` |
| Staging | `afterschoolpay-staging` |

`.firebaserc` 已經保留這兩個 alias。若 staging project id 不同，請同步修改 `.firebaserc` 與 GitHub secret。

## GitHub Environments

建議在 GitHub repository 建立：

- `staging`
- `github-pages`

`github-pages` 目前同時作為 production deploy environment，因為正式前端仍使用 GitHub Pages。

## Production Secrets

production frontend build 需要：

```text
VITE_FB_API_KEY
VITE_FB_AUTH_DOMAIN
VITE_FB_PROJECT_ID
VITE_FB_STORAGE_BUCKET
VITE_FB_MESSAGING_SENDER_ID
VITE_FB_APP_ID
VITE_FB_MEASUREMENT_ID
```

若要讓 GitHub Actions 自動發布 production Firestore rules 與 Cloud Functions，再加入：

```text
PRODUCTION_FIREBASE_PROJECT_ID
PRODUCTION_FIREBASE_SERVICE_ACCOUNT_JSON
```

`PRODUCTION_FIREBASE_PROJECT_ID` 可和 `VITE_FB_PROJECT_ID` 相同。service account 建議只給 Firestore rules 與 Cloud Functions deploy 需要的最小權限。

## Staging Secrets

staging deploy 需要：

```text
STAGING_FIREBASE_PROJECT_ID
STAGING_FIREBASE_SERVICE_ACCOUNT_JSON
STAGING_VITE_FB_API_KEY
STAGING_VITE_FB_AUTH_DOMAIN
STAGING_VITE_FB_STORAGE_BUCKET
STAGING_VITE_FB_MESSAGING_SENDER_ID
STAGING_VITE_FB_APP_ID
STAGING_VITE_FB_MEASUREMENT_ID
```

staging workflow 會部署 Firebase Hosting、Firestore rules 與 Cloud Functions。如果缺少必要 secrets，workflow 會顯示 warning 並跳過部署；補齊 secrets 後下一次 `staging` push 就會正式部署。

## 本機環境

複製 `.env.example` 成 `.env.local`，填入 Firebase Web App 設定：

```bash
cp .env.example .env.local
```

本機開發：

```bash
npm run dev
```
