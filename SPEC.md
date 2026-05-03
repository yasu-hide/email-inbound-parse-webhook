# SPEC

## 1. 目的

本 Worker は、Cloudflare Email Workers 経由で受信したメールを処理し、生の MIME メッセージから必要なヘッダおよび本文を解析したうえで、外部 Webhook に転送します。

本書は、`src/index.ts` および関連モジュールに実装されている現行挙動を仕様として記述するものです。

## 2. 実行環境

- プラットフォーム: Cloudflare Workers
- トリガー: `email(message, env, ctx)`
- エントリポイント: `src/index.ts`
- 静的アセット: `public/`
- Observability: `wrangler.jsonc` にて有効化

## 3. 入力

### 3.1 メールイベント入力

本 Worker は、少なくとも以下のプロパティを持つ Cloudflare Email Worker の message オブジェクトを想定します。

- `message.from`
- `message.to`
- `message.raw`

実行環境によって利用可能な任意フィールド:

- `message.rawSize`

本 Worker が利用する任意のメッセージ機能:

- `message.setReject(reason)`

### 3.2 環境変数入力

- `WEBHOOK_URL`: 必須
- `MAX_MESSAGE_SIZE`: 任意

`MAX_MESSAGE_SIZE` が未設定、または数値でない場合、本 Worker は `10485760` バイトを使用します。

## 4. 処理フロー

### 4.1 事前検証

解析開始前に、以下の検証を行います。

1. `WEBHOOK_URL` が未設定の場合、`email.rejected.no_webhook` をログ出力し、`message.setReject('WEBHOOK_URL not configured')` を呼び出して処理を終了します
2. `message.rawSize` が利用可能であり、かつ `MAX_MESSAGE_SIZE` を超過する場合、`email.rejected.too_large` をログ出力し、`message.setReject('Message too large')` を呼び出して処理を終了します

### 4.2 MIME 解析

本 Worker は、生のメールストリームを独自実装により解析します。

現行実装で行っている処理は以下のとおりです。

- ヘッダと本文の区切りが見つかるまで、ストリームから生ヘッダを読み取る
- 継続行を含むヘッダを unfold する
- ヘッダ名を小文字キーとして収集する
- RFC 2047 encoded-word を復号する
- 必要に応じて以下の論理ヘッダを抽出する
  - `from`
  - `to`
  - `cc`
  - `subject`

### 4.3 文字コード処理

本 Worker は、文字コードの正規化およびフォールバック付き復号を行います。

現行実装で対応している主な文字コードは以下のとおりです。

- `utf-8`
- `windows-31j`
- `shift_jis` および関連エイリアス。内部的には `windows-31j` に正規化します
- `euc-jp`
- `iso-2022-jp`
- `iso-8859-1`

文字コード情報が存在しない場合でも、内部のフォールバック判定により復号を試み、その結果の文字コード名を記録します。

### 4.4 multipart の挙動

トップレベルの `Content-Type` に MIME boundary が含まれる場合、本 Worker は当該メッセージを multipart として扱います。

各 part に対して実施する処理は以下のとおりです。

- part ヘッダを解析する
- `text/plain` part を復号し、`result.text` に追記する
- `text/html` part を復号し、`result.html` に追記する
- 添付扱いの part、または `filename=` を含む part は無視する

複数の text または HTML part が存在する場合、それらは改行で連結されます。

### 4.5 非 multipart の挙動

メッセージが multipart でない場合、本 Worker は以下のように処理します。

- 残りの本文ストリームを、実装上の上限まで読み込む
- `Content-Transfer-Encoding` および宣言済み文字コードに基づいて本文を復号する
- トップレベルの `Content-Type` が `text/html` の場合、復号結果を `html` として扱う
- それ以外の場合、復号結果を `text` として扱う

### 4.6 Transfer-Encoding 対応

現行実装で対応している復号経路は以下のとおりです。

- `base64`
- `quoted-printable`
- 未エンコード、またはその他の値。平文バイト列として処理します

## 5. 出力契約

解析に成功した場合、本 Worker は `FormData` を構築し、`WEBHOOK_URL` に対して POST します。

### 5.1 HTTP リクエスト

- メソッド: `POST`
- ボディ: `multipart/form-data`
- URL: `env.WEBHOOK_URL`

### 5.2 フォーム項目

常に追加される項目:

- `from`
- `to`
- `subject`
- `charsets`

条件付きで追加される項目:

- `cc`
- `text`
- `html`

### 5.3 文字コードメタデータ

`charsets` フィールドには、JSON オブジェクトを文字列化した値を格納します。

現行実装の挙動は以下のとおりです。

- `from`: 値が存在する場合は `utf-8`、存在しない場合は空文字列
- `to`: 値が存在する場合は `utf-8`、存在しない場合は空文字列
- `subject`: 値が存在する場合は `utf-8`、存在しない場合は空文字列
- `cc`: 存在する場合は `utf-8`
- `text`: 存在する場合は検出または宣言済みの文字コード
- `html`: 存在する場合は検出または宣言済みの文字コード

## 6. エラーハンドリング

### 6.1 reject 条件

本 Worker は、以下の場合にメールを reject します。

- `WEBHOOK_URL` が未設定である場合
- `message.rawSize` が `MAX_MESSAGE_SIZE` を超過する場合
- 解析処理中に例外が発生した場合

reject 理由は以下のいずれかです。

- `WEBHOOK_URL not configured`
- `Message too large`
- `Parsing error`

### 6.2 reject しない失敗

Webhook 配信に失敗した場合、本 Worker はメールを reject しません。

対象となる失敗は以下のとおりです。

- Webhook が非 2xx の HTTP レスポンスを返した場合
- `fetch` 実行時に例外が発生した場合

いずれの場合も、ログ出力のみを行います。

## 7. ログ

現行実装では、以下のログイベントを出力します。

- `email.received`
- `email.rejected.no_webhook`
- `email.rejected.too_large`
- `email.parse_error`
- `email.parsed`
- `webhook.post_success`
- `webhook.post_failure`
- `webhook.post_error`

## 8. テストで確認済みの挙動

現行の自動テストでは、以下の挙動を確認しています。

- RFC 2047 Base64 形式の件名復号
- RFC 2047 Q-encoding 形式の件名復号
- 折り返しヘッダの復号
- `From`、`To`、`Cc` における display-name の復号
- 本文文字コードのフォールバック処理
- ISO-2022-JP プレーンテキスト本文の復号
- 非 UTF-8 の生 subject ヘッダバイト列の復号
- `WEBHOOK_URL` 未設定時の reject
- `MAX_MESSAGE_SIZE` 超過時の reject
- `MAX_MESSAGE_SIZE` 同値時の非 reject
- `message.rawSize` 未提供時にサイズ reject 判定をスキップする挙動
- `MAX_MESSAGE_SIZE` が非数値の場合に既定値へフォールバックする挙動
- 解析例外発生時の reject
- Webhook 非 2xx 応答時の非 reject
- Webhook ネットワーク例外時の非 reject
- multipart（text/plain + text/html + cc）の payload 契約
- 添付 part を含む multipart で添付を無視する挙動
- 非 multipart な HTML 本文メールの抽出

## 9. 非対象および未対応事項

現行実装では、以下を提供しません。

- 添付ファイルの転送
- Webhook 認証または署名
- Webhook 配信失敗時の再送キューイング
- あらゆる multipart 構造に対する完全な MIME 準拠
- 安定した外部向けペイロードスキーマのバージョン管理

## 10. 関連設定ファイル

- Worker 設定: `wrangler.jsonc`
- Env 型定義: `src/env.d.ts`
- 生成済み Binding 型: `worker-configuration.d.ts`
- テスト: `test/index.spec.ts`
