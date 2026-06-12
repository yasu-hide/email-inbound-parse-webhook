# Qdrant Query Templates

このファイルは `qdrant-find` 用の検索テンプレ集。
目的は「毎回ゼロからクエリを考えない」こと。

## 1. Worker 全体仕様

- `Cloudflare Email Worker parse webhook required env secrets`
- `email worker reject policy parsing error webhook signing`
- `multipart form-data payload contract charsets`

## 2. メール解析

- `parseEmailStream postal-mime multipart fallback`
- `RFC2047 subject decode folded header`
- `charset fallback windows-31j iso-2022-jp`
- `quoted-printable base64 body decode`

## 3. Webhook 署名

- `webhook signature ECDSA P-256 timestamp body`
- `X-Email-Event-Webhook-Signature verification`
- `p1363 to DER conversion`

## 4. Payload Builder

- `buildWebhookPayload envelope fallback`
- `payloadToFormData required optional fields`
- `charsets json field from to subject text html`

## 5. テスト探索

- `index.spec reject when WEBHOOK_URL missing`
- `webhook signature integration test exact multipart body`
- `postal-mime adapter malformed multipart fallback`
- `baseline compare gate matchRate criticalDiffCount`

## 6. 運用・デプロイ

- `wrangler deploy required secrets`
- `baseline compare ci gate`
- `github actions deploy cloudflare worker`

## 7. 差分追跡クエリ

- `recent changes in src index.ts webhook-client.ts`
- `new tests for multipart or charset`
- `qdrant diff targets full summary`

## 8. 擬似グラフ2段検索テンプレ

1段目で機能を引き、2段目で `links` 語彙を使って辿る。

- 解析系
	- 1段目: `parseEmailStream postal mime fallback behavior`
	- 2段目: `belongs_to:file:src/email-parser.ts tested_by:file:test/mime-parser.spec.ts related_doc:file:SPEC.md`
- 署名系
	- 1段目: `webhook ECDSA signature timestamp body`
	- 2段目: `belongs_to:file:src/webhook-signature.ts tested_by:file:test/webhook-signature.spec.ts related_doc:file:README.md`
- payload系
	- 1段目: `buildWebhookPayload charsets form-data fields`
	- 2段目: `belongs_to:file:src/webhook-payload-builder.ts tested_by:file:test/webhook-payload-builder.spec.ts related_doc:file:PAYLOAD_CONTRACT_CHECKLIST.md`

### `links` 語彙リファレンス

- `imports:file:<path>`
- `tested_by:file:<path>`
- `related_doc:file:<path>`
- `belongs_to:file:<path>`

## クエリ作成ルール

- 1クエリは「機能 + 制約 + 文脈」の3要素を入れる。
- シンボル名が分かってるときは必ず入れる。
- エラー調査は `error message + symbol + expected behavior` で作る。

## 自動運用コマンド

- 差分抽出 + 投入バッチ生成
	- `pnpm run qdrant:refresh`
	- 同一 `path` は最新1件だけ残す（path-latest dedupe）
	- 出力: `artifacts/qdrant/diff-targets.json`, `artifacts/qdrant/store-batch.json`
- 2段検索Gate検証
	- 事前に 2段目の検索結果を以下に保存する
		- `artifacts/qdrant/query-results/parse-hop2.txt`
		- `artifacts/qdrant/query-results/signature-hop2.txt`
		- `artifacts/qdrant/query-results/payload-hop2.txt`
	- 実行: `pnpm run qdrant:two-hop-validate`
	- Gate付き実行: `QDRANT_TWO_HOP_GATE=1 pnpm run qdrant:two-hop-validate`
	- 出力: `artifacts/qdrant/two-hop-validation.md`, `artifacts/qdrant/two-hop-validation.json`
