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

- 現時点ではなし

### 完了済みのテスト拡張（2026-05-03）

- multipart（text/plain + text/html、添付あり、境界異常）で本文抽出が維持されることを確認するテストを追加済み
- Webhook 配信の失敗系（非 2xx / ネットワークエラー）でも reject しないことを確認するテストを追加済み
- `MAX_MESSAGE_SIZE` 関連（超過、rawSize 未提供、非数値時フォールバック）の判定を確認するテストを追加済み
- HTML-only メールの抽出を確認するテストを追加済み
- nested multipart（`multipart/mixed` 内に `multipart/alternative`）で本文抽出が維持されることを確認するテストを追加済み

## プロダクト上の確認事項

- Webhook 配信失敗時はメールを reject すべきか、それとも best-effort のままとすべきか
- 下流の Webhook 受信側では、項目未設定と項目省略をより厳密に区別する必要があるか
- 添付ファイルを破棄する現行挙動は明示的なプロダクト判断か、それとも実装上の簡略化に留まるか
- 現行の文字コードフォールバック挙動は、想定する送信元メールに対して十分か

## リファクタリング候補

- 現時点ではなし

### 完了済みのリファクタリング（2026-05-03）

- 解析・正規化・配信の責務分割を完了し、parser/payload builder/文字コードユーティリティを再編
- postal-mime adapter を導入して段階移行を実施し、最終的に `parseEmailStream` を postal-mime 単一路線へ統一
- 互換維持のために導入した legacy フォールバックと依存注入引数を廃止し、legacy MIME 解析モジュールを削除
- ベースライン比較基盤（30件固定ケース、レポート生成）を整備し、比較基準を固定期待値比較へ移行
- CI の test job にベースライン比較ゲート（`pnpm run baseline:compare:ci`）を組み込み、デプロイ前の必須チェックとして定着
- multipart/alternative の正常系では postal-mime 結果を優先し、異常シグナル時のみ互換フォールバックを適用する判定を導入
- multipart/mixed の単純構造では postal-mime 優先、境界異常や複雑構造ではフォールバック維持とする判定へ更新
- nested multipart（`multipart/mixed` 内 `multipart/alternative`）で本文抽出を維持する経路を追加
- multipart 異常系フォールバックを開始境界・終端境界・パート整合で判定し、baseline レポートに理由を出力可能にした
- 期待値更新運用を実装し、`baseline:update` と PR テンプレで更新理由・影響ケース・再検証ログを明示化
