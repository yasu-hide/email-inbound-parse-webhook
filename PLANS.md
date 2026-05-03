# PLANS

本ファイルは、現行仕様の対象外とした将来要件、未解決のプロダクト判断、および今後の実装候補を管理するためのものです。

## 未実装機能

- 共有 Secret ヘッダやリクエスト署名など、Webhook 認証を追加する
- 下流システムで必要となる場合に備え、添付ファイルのメタデータまたは本体を転送可能にする
- `multipart/alternative` および `multipart/mixed` を含む、より複雑な multipart 構造への対応を強化する
- Webhook 配信失敗時に備え、再送またはキューイング機構を追加する
- 外部向け Webhook ペイロード契約にバージョンを導入する

## 運用上の追記事項

- 環境ごとの Cloudflare Email Routing 設定手順を文書化する
- 本番向け受信ルートの命名規則および管理方法を定義する
- `MAX_MESSAGE_SIZE` を Secret として扱うか、変数として扱うか、または両方にするかを決定する
- 実行時に利用可能な環境項目と生成される Worker 型定義の整合を取る

## テスト拡張候補

- nested multipart（`multipart/mixed` 内に `multipart/alternative`）で本文抽出が維持されることを確認するテストを追加する

### 完了済みのテスト拡張（2026-05-03）

- `text/plain` と `text/html` の両方を含む multipart メールの結合テストを追加済み
- 添付ファイル付き multipart メールで添付を無視しつつ本文抽出が維持されることを確認するテストを追加済み
- Webhook が非 2xx を返す場合に reject しないテストを追加済み
- Webhook のネットワークエラー時に reject しないテストを追加済み
- `MAX_MESSAGE_SIZE` 超過による reject のテストを追加済み
- `message.rawSize` が未提供の場合にサイズ reject 判定をスキップするテストを追加済み
- `MAX_MESSAGE_SIZE` が非数値の場合に既定値へフォールバックするテストを追加済み
- HTML のみを含むメールのテストを追加済み

## プロダクト上の確認事項

- Webhook 配信失敗時はメールを reject すべきか、それとも best-effort のままとすべきか
- 下流の Webhook 受信側では、項目未設定と項目省略をより厳密に区別する必要があるか
- 添付ファイルを破棄する現行挙動は明示的なプロダクト判断か、それとも実装上の簡略化に留まるか
- 現行の文字コードフォールバック挙動は、想定する送信元メールに対して十分か

## リファクタリング候補

- postal-mime への全面移行を完了する（現状の multipart 宣言時 legacy フォールバックを解消し、経路を一本化する）
- legacy MIME 解析モジュールの整理方針を確定する（削除または deprecate 維持）

### 完了済みのリファクタリング（2026-05-03）

- 解析、正規化、配信の責務分割（第1段階）を完了
- parser 内部を責務ごとに再分割し、`parseEmailStream(stream, deps?)` の差し替え依存注入インターフェースを導入
- 文字コード判定/正規化ユーティリティを `src/email-normalizer-utils.ts` に分離し、単体テストを追加
- `buildWebhookPayload` と `payloadToFormData` を導入し、payload builder の責務を分離（既存 `buildWebhookFormData` は互換ラッパとして維持）
- postal-mime adapter を導入し、`parseEmailStream` のデフォルト経路を postal-mime ベースへ段階移行
- 互換維持のため、multipart 宣言メールは legacy 経路へフォールバックするハイブリッド経路を導入
- G3 比較ランナー（30件固定コーパス）とレポート生成コマンドを追加し、旧経路との一致率を継続検証可能にした
- CI の test job に G3 互換ゲート（`pnpm run g3:compare:ci`）を追加し、デプロイ前に互換条件を必須化
