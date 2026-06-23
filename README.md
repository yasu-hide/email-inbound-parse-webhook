[![codecov](https://codecov.io/github/yasu-hide/email-inbound-parse-webhook/graph/badge.svg?token=IIOKN284E5)](https://codecov.io/github/yasu-hide/email-inbound-parse-webhook)

# email-inbound-parse-webhook

本プロジェクトは、受信メールを解析し、正規化した項目を外部 Webhook へ転送する Cloudflare Email Worker です。

本 Worker はメール処理用のバックエンドであり、ブラウザ向けアプリケーションではありません。`public/index.html` に配置されている静的ページは、Workers Assets により配信される案内用ページです。

## 概要

Cloudflare Email Routing から本 Worker にメールが配送されると、以下の処理を実行します。

- 生の MIME ストリームを読み取る
- `From`、`To`、`Cc`、`Subject` などの主要ヘッダを復号する
- `text/plain` および `text/html` の本文を抽出する
- 文字コード情報を正規化する
- 解析結果を `multipart/form-data` 形式で `WEBHOOK_URL` へ送信する

現行実装の挙動は以下のとおりです。

- 添付ファイルは無視され、転送対象に含まれません
- `WEBHOOK_URL` は必須です
- `INBOUND_PARSE_WEBHOOK_PRIVATE_KEY` は必須です
- `MAX_MESSAGE_SIZE` は任意設定であり、既定値は `10 * 1024 * 1024` バイトです
- Webhook 送信に失敗した場合はログを出力しますが、解析済みメール自体は reject しません

## 前提条件

- Node.js
- pnpm
- Cloudflare Wrangler
- Email Routing および Email Workers が有効化された Cloudflare アカウント

本リポジトリでは、Dependabot の npm ecosystem が安定して扱えるように pnpm 10 系を固定しています。

本リポジトリでは、`wrangler.jsonc` を Worker 設定の正本として扱います。

## セットアップ

依存関係をインストールします。

```bash
pnpm install
```

ローカル開発用の必須 Secret を `.dev.vars` または `.env` に設定します。

```dotenv
WEBHOOK_URL=https://example.com/webhook
INBOUND_PARSE_WEBHOOK_PRIVATE_KEY=<PKCS8_P256_PRIVATE_KEY_PEM_WITH_ESCAPED_NEWLINES>
```

`INBOUND_PARSE_WEBHOOK_PRIVATE_KEY` には、ECDSA prime256v1（P-256）の PKCS#8 PEM private key を設定します。改行を `\n` としてエスケープした値も利用できます。

対応する public key は、Webhook 受信側の署名検証設定に使用します。

署名鍵は ECDSA prime256v1 で作成します。

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

- `inbound-parse-webhook-private.pem`: この Worker の `INBOUND_PARSE_WEBHOOK_PRIVATE_KEY` に設定します
- `inbound-parse-webhook-public.pem`: Webhook 受信側の `INBOUND_PARSE_WEBHOOK_PUBLIC_KEY` に設定します

private key は Secret です。PEM ファイルはリポジトリにコミットしないでください。ローカルの `.env` に貼り付ける場合は、以下で改行を `\n` に変換できます。

```bash
awk 'NF { sub(/\r$/, ""); printf "%s\\n", $0 }' inbound-parse-webhook-private.pem
```

任意設定として、以下を追加できます。

```dotenv
MAX_MESSAGE_SIZE=10485760
```

補足事項:

- `wrangler.jsonc` に `secrets.required` を定義している場合、Wrangler はローカル開発時に `.dev.vars` または `.env` から宣言済みの必須 Secret のみを読み込みます
- `.dev.vars*` および `.env*` は `.gitignore` により除外済みです
- `MAX_MESSAGE_SIZE` は Worker 実装上は利用できますが、`wrangler.jsonc` では必須 Secret として宣言していません

## 開発

ローカル開発を開始します。

```bash
pnpm dev
```

テストを実行します。

```bash
pnpm test
```

Binding や required secrets を変更した場合は、Worker の型定義を再生成します。

```bash
pnpm cf-typegen
```

ローカルからデプロイを実行します。

```bash
pnpm run deploy:worker
```

GitHub Actions からも同様にデプロイできます。CI/CD の構成、必須 Secrets、実行条件は `DEPLOY.md` を参照してください。

## Cloudflare 側の設定

本リポジトリでは Worker のコードおよび必要な Secret 名を定義していますが、受信メールの配送を有効にするためには Cloudflare 側で追加設定が必要です。

Cloudflare Email Workers を利用するための最低限の流れは、以下のとおりです。

1. Worker を作成またはデプロイする
2. 対象ゾーンで Email Routing と Email Workers を有効化する
3. 受信メールルートを本 Worker に紐付ける

参考資料:

- Cloudflare Email Workers: https://developers.cloudflare.com/email-routing/email-workers/
- Wrangler configuration: https://developers.cloudflare.com/workers/wrangler/configuration/

## Webhook ペイロード

本 Worker は `WEBHOOK_URL` に対して `multipart/form-data` を POST します。

Webhook リクエストには、送信時刻とリクエスト本文に対する ECDSA 署名を付与します。署名ヘッダは以下のとおりです。

- `X-Email-Event-Webhook-Signature`
- `X-Email-Event-Webhook-Timestamp`

契約の回帰チェック観点は `PAYLOAD_CONTRACT_CHECKLIST.md` に集約しています。

送信される可能性のあるフォーム項目は以下のとおりです。

- `from`: 復号済み送信者ヘッダ、または `message.from`
- `to`: 復号済み宛先ヘッダ、または `message.to`
- `subject`: 復号済み件名ヘッダ
- `cc`: 復号済み Cc ヘッダ。存在する場合のみ送信されます
- `text`: プレーンテキスト本文。存在する場合のみ送信されます
- `html`: HTML 本文。存在する場合のみ送信されます
- `charsets`: JSON オブジェクトを文字列化した値

`charsets` の例:

```json
{
  "from": "utf-8",
  "to": "utf-8",
  "subject": "utf-8",
  "text": "iso-2022-jp"
}
```

`from`、`to`、`subject` は値が存在する限り `utf-8` に正規化されます。`text` および `html` には、検出または宣言された本文の文字コードが格納されます。非 UTF-8 本文の場合、Webhook の `text` / `html` フォームパートは元の本文文字コードに従うバイト列として送信されます。

## エラーハンドリング

以下の場合、受信メールは reject されます。

- `WEBHOOK_URL` が設定されていない場合
- `INBOUND_PARSE_WEBHOOK_PRIVATE_KEY` が設定されていない場合
- `message.rawSize` が利用可能であり、かつ `MAX_MESSAGE_SIZE` を超過した場合
- 解析処理で例外が発生した場合
- Webhook 署名の生成に失敗した場合

一方で、Webhook リクエストが HTTP エラーを返した場合、または `fetch` 実行時に例外が発生した場合は、受信メールを reject しません。この場合は失敗をログに記録するのみです。

## ログ

現行実装では、以下の構造化ログを出力します。

- `email.received`
- `email.rejected.no_webhook`
- `email.rejected.no_webhook_signing_key`
- `email.rejected.too_large`
- `email.parse_error`
- `email.parsed`
- `email.webhook_signing_error`
- `webhook.post_success`
- `webhook.post_failure`
- `webhook.post_error`

`wrangler.jsonc` では Observability を有効化しています。

## テストカバレッジ

現行テストはヘッダ復号、文字コード処理、reject 条件、Webhook 配信失敗時挙動、multipart 本文抽出を対象としており、以下のケースを確認しています。

- RFC 2047 Base64 形式および Q-encoding 形式の件名復号
- 折り返しヘッダの復号
- `From`、`To`、`Cc` の display-name 復号
- 本文文字コードのフォールバックと正規化
- ISO-2022-JP 本文の復号
- `WEBHOOK_URL` 未設定時の reject
- `INBOUND_PARSE_WEBHOOK_PRIVATE_KEY` 未設定時の reject
- `MAX_MESSAGE_SIZE` 超過時の reject
- `MAX_MESSAGE_SIZE` 同値時の非 reject
- `message.rawSize` 未提供時にサイズ reject 判定をスキップする挙動
- `MAX_MESSAGE_SIZE` が非数値の場合に既定値へフォールバックする挙動
- 解析例外時の reject
- Webhook 署名ヘッダの付与と署名対象本文の検証
- Webhook 署名生成失敗時の reject
- Webhook 非 2xx およびネットワークエラー時の非 reject
- multipart（text/plain + text/html + cc）の送信 payload 契約
- 非 UTF-8 本文を `text` / `html` フォームパート名のまま元文字コードバイト列で送信する挙動
- 添付 part を含む multipart で添付を無視する挙動
- HTML のみを含むメール本文の抽出

具体的なテストケースは `test/index.spec.ts`、`test/mime-parser.spec.ts`、`test/postal-mime-adapter.spec.ts` を参照してください。

`fetch` エントリポイントでは、`POST /internal/payload-preview` に JSON を送ることで、Email ハンドラと同じ payload builder 経路（`buildWebhookPayload` + `payloadToFormData`）の preview を確認できます。

## 既知の制約

- 添付ファイルは無視されます
- MIME 解析は `postal-mime` を本線に使用し、multipart の異常シグナル時のみ互換フォールバックを適用します
- multipart の境界ケースは十分に網羅されていません

今後の改善案および未確定事項については、`PLANS.md` を参照してください。
