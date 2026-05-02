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
- `MAX_MESSAGE_SIZE` は任意設定であり、既定値は `10 * 1024 * 1024` バイトです
- Webhook 送信に失敗した場合はログを出力しますが、解析済みメール自体は reject しません

## 前提条件

- Node.js
- pnpm
- Cloudflare Wrangler
- Email Routing および Email Workers が有効化された Cloudflare アカウント

本リポジトリでは、`wrangler.jsonc` を Worker 設定の正本として扱います。

## セットアップ

依存関係をインストールします。

```bash
pnpm install
```

ローカル開発用の必須 Secret を `.dev.vars` または `.env` に設定します。

```dotenv
WEBHOOK_URL=https://example.com/webhook
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

デプロイを実行します。

```bash
pnpm deploy
```

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

送信される可能性のあるフォーム項目は以下のとおりです。

- `from`: 復号済み送信者ヘッダ、または `message.from`
- `to`: 復号済み宛先ヘッダ、または `message.to`
- `subject`: 復号済み件名ヘッダ
- `cc`: 復号済み Cc ヘッダ。存在する場合のみ送信されます
- `text`: 復号済みプレーンテキスト本文。存在する場合のみ送信されます
- `html`: 復号済み HTML 本文。存在する場合のみ送信されます
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

`from`、`to`、`subject` は値が存在する限り `utf-8` に正規化されます。`text` および `html` には、検出または宣言された本文の文字コードが格納されます。

## エラーハンドリング

以下の場合、受信メールは reject されます。

- `WEBHOOK_URL` が設定されていない場合
- `message.rawSize` が利用可能であり、かつ `MAX_MESSAGE_SIZE` を超過した場合
- 解析処理で例外が発生した場合

一方で、Webhook リクエストが HTTP エラーを返した場合、または `fetch` 実行時に例外が発生した場合は、受信メールを reject しません。この場合は失敗をログに記録するのみです。

## ログ

現行実装では、以下の構造化ログを出力します。

- `email.received`
- `email.rejected.no_webhook`
- `email.rejected.too_large`
- `email.parse_error`
- `email.parsed`
- `webhook.post_success`
- `webhook.post_failure`
- `webhook.post_error`

`wrangler.jsonc` では Observability を有効化しています。

## テストカバレッジ

現行テストは主にヘッダ復号と文字コード処理を対象としており、以下のケースを確認しています。

- RFC 2047 Base64 形式および Q-encoding 形式の件名復号
- 折り返しヘッダの復号
- `From`、`To`、`Cc` の display-name 復号
- 本文文字コードのフォールバックと正規化
- ISO-2022-JP 本文の復号

具体的なテストケースは `test/index.spec.ts` を参照してください。

## 既知の制約

- 添付ファイルは無視されます
- MIME 解析は軽量な独自実装です
- multipart の境界ケースは十分に網羅されていません
- Webhook 認証は本リポジトリでは未実装です

今後の改善案および未確定事項については、`PLANS.md` を参照してください。
