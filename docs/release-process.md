# 發布流程

這份流程的目標是讓 Afterschool Pay 可以逐步變成多補習班可使用的正式產品：每次變更都有 PR、CI、staging 驗證與 production 部署紀錄。

## 建議流程

1. 從最新 `staging` 或 `main` 建立 feature branch，例如 `codex/mobile-ledger`.
2. 完成開發後開 PR，目標先進 `staging`。
3. PR 需要通過 CI：
   - `Lint`
   - `Build`
   - `Firebase Rules Sanity`
   - `CI`
4. merge 到 `staging` 後，GitHub Actions 會部署 staging。
5. 在 staging 確認匯入、收款、收據、薪資、雜項支出與權限流程。
6. staging 確認後，開 PR 從 `staging` 進 `main`。
7. merge 到 `main` 後，GitHub Actions 會部署 production。

緊急修正可以直接開 PR 到 `main`，但仍建議跑完 CI 與 production 部署檢查。

## CI 檢查

`.github/workflows/ci.yml` 會在 PR、`main` push、`staging` push 時執行：

- `npm run lint`
- `npm run build`
- Firebase 設定檔存在與 rules path sanity check

CI build 使用 placeholder Firebase env，確保一般程式錯誤不會被 secrets 擋住。

## Staging 部署

`.github/workflows/deploy-staging.yml` 會在 `staging` push 或手動觸發時執行：

- 安裝依賴
- lint
- build
- deploy Firebase Hosting
- deploy Firestore rules

staging 必須先在 GitHub 設好 `STAGING_*` secrets。

## Production 部署

`.github/workflows/deploy-production.yml` 會在 `main` push 或手動觸發時執行：

- 安裝依賴
- lint
- build
- deploy GitHub Pages
- 如果有 production Firebase service account secret，會同步 deploy Firestore rules

正式前端目前保留 GitHub Pages 與 `public/CNAME`，避免在導入 staging 時改動正式網址架構。

## Firestore Rules 發布

短期內可以手動發布 rules：

```bash
firebase deploy --only firestore:rules --project afterschoolpay
```

長期建議使用 GitHub Actions secrets 讓 production workflow 自動發布 rules，避免程式碼和 Firebase console 的 rules 版本不同。

## Branch Protection 建議

建議在 GitHub 對 `main` 和 `staging` 開啟 branch protection：

- Require a pull request before merging
- Require status checks to pass before merging
- Require branches to be up to date before merging
- Required checks:
  - `Lint`
  - `Build`
  - `Firebase Rules Sanity`
  - `CI`

production `main` 可再加上 require approval，讓正式上線多一層人工確認。
