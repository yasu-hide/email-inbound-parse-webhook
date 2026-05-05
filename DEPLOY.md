# Deploy

本プロジェクトはローカル実行と GitHub Actions 実行の両方で Cloudflare へデプロイできます。

## ローカルデプロイ

```bash
pnpm run deploy:worker
```

## GitHub Actions デプロイ

`main` ブランチへの push をトリガーに、以下の順序で実行します。

1. `test` ジョブで `pnpm test` を実行
2. `test` ジョブで `pnpm run baseline:compare:ci` を実行（固定期待値との比較ゲート）
3. `test` 成功時のみ `deploy` ジョブで `pnpm run deploy:worker` を実行

これにより、テスト失敗時はデプロイされません。

`baseline:compare:ci` は、32件の固定ケースに対して現行出力が期待値と一致すること（`matchRate >= 99%` かつ `critical = 0`）を確認します。

期待値の更新が必要な場合は、`pnpm run baseline:update` を実行したうえで `pnpm run baseline:compare:ci` の再実行結果を PR に記載してください。

Workflow は [.github/workflows/deploy.yml](.github/workflows/deploy.yml) に定義します。

## 必須 GitHub Secrets

GitHub リポジトリの Secrets に以下を設定してください。

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

補足:

- これらは GitHub Actions の `deploy.yml` 用 Secret であり、Dependabot の update 実行には使われません
- private registry を Dependabot から参照する場合は、GitHub の Dependabot secrets と registries 設定を別途追加してください
- 本リポジトリは Dependabot の npm ecosystem 互換性を優先して pnpm 10 系を固定しています
- pnpm 10 以降では `deploy` が組み込みコマンドと衝突するため、Worker デプロイは `pnpm run deploy:worker` を使います

Cloudflare の最新ガイド:

- https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/

## Worker 側の前提

`WEBHOOK_URL` と `INBOUND_PARSE_WEBHOOK_PRIVATE_KEY` は Worker の required secret です。未設定の場合、メール処理が reject されます。

初回または secret 未登録環境では、事前に設定してください。

```bash
wrangler secret put WEBHOOK_URL
wrangler secret put INBOUND_PARSE_WEBHOOK_PRIVATE_KEY < inbound-parse-webhook-private.pem
```

`INBOUND_PARSE_WEBHOOK_PRIVATE_KEY` には、P-256 ECDSA の PKCS#8 PEM private key を設定します。対応する public key は Webhook 受信側の署名検証設定に使用します。

鍵ペアは以下のように作成できます。

```bash
openssl genpkey \
  -algorithm EC \
  -pkeyopt ec_paramgen_curve:prime256v1 \
  -out inbound-parse-webhook-private.pem

openssl pkey \
  -in inbound-parse-webhook-private.pem \
  -pubout \
  -out inbound-parse-webhook-public.pem
```

- `inbound-parse-webhook-private.pem` はこの Worker の `INBOUND_PARSE_WEBHOOK_PRIVATE_KEY` に設定します
- `inbound-parse-webhook-public.pem` は受信側アプリケーションの `INBOUND_PARSE_WEBHOOK_PUBLIC_KEY` に設定します

private key は Secret です。PEM ファイルはリポジトリにコミットしないでください。登録後は安全な場所へ保管するか削除してください。

補足:

- `MAX_MESSAGE_SIZE` は任意設定です
- 必要に応じて `pnpm cf-typegen` で型定義を再生成してください
