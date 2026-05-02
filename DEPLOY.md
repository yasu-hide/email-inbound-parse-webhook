# Deploy

本プロジェクトはローカル実行と GitHub Actions 実行の両方で Cloudflare へデプロイできます。

## ローカルデプロイ

```bash
pnpm deploy
```

## GitHub Actions デプロイ

`main` ブランチへの push をトリガーに、以下の順序で実行します。

1. `test` ジョブで `pnpm test` を実行
2. `test` 成功時のみ `deploy` ジョブで `pnpm deploy` を実行

これにより、テスト失敗時はデプロイされません。

Workflow は [.github/workflows/deploy.yml](.github/workflows/deploy.yml) に定義します。

## 必須 GitHub Secrets

GitHub リポジトリの Secrets に以下を設定してください。

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

補足:

- これらは GitHub Actions の `deploy.yml` 用 Secret であり、Dependabot の update 実行には使われません
- private registry を Dependabot から参照する場合は、GitHub の Dependabot secrets と registries 設定を別途追加してください
- 本リポジトリは Dependabot の npm ecosystem 互換性を優先して pnpm 10 系を固定しています

Cloudflare の最新ガイド:

- https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/

## Worker 側の前提

`WEBHOOK_URL` は Worker の required secret です。未設定の場合、メール処理が reject されます。

初回または secret 未登録環境では、事前に設定してください。

```bash
wrangler secret put WEBHOOK_URL
```

補足:

- `MAX_MESSAGE_SIZE` は任意設定です
- 必要に応じて `pnpm cf-typegen` で型定義を再生成してください
