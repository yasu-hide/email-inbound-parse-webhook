# PAYLOAD CONTRACT CHECKLIST

このチェックリストは、`buildWebhookPayload` と `payloadToFormData` の契約を回帰確認するための観点をまとめたものです。

## 1. 必須項目

- `from`
- `to`
- `subject`
- `charsets`

確認ポイント:

- `from` と `to` は、`parsed` 側を優先し、欠落時は `message.from` / `message.to` にフォールバックする。
- `subject` は存在する場合に送信される。
- `charsets` は JSON 文字列として `multipart/form-data` に含まれる。

## 2. 任意項目

- `cc`
- `text`
- `html`

確認ポイント:

- 値が存在する場合のみフォームに含まれる。
- 空文字や未定義が不要に送信されない。

## 3. 文字コード情報

確認ポイント:

- `from` / `to` / `subject` の charset は `utf-8` として扱われる。
- `text` / `html` の charset は解析結果の実値を保持する。
- `headerCharsets` と `formData` 内 `charsets` の整合が取れている。
- 非 UTF-8 の `text` / `html` は同名フォームパートのまま元文字コードバイト列で送信される。
- `textBytes` / `htmlBytes` のような SendGrid 未定義フォーム項目が送信されない。

## 4. 優先順位

確認ポイント:

- `from`: `parsed.from` > `message.from`
- `to`: `parsed.to` > `message.to`
- `subject`: `parsed.subject` のみ（`message` からは補完しない）
- 本文系 (`text` / `html`): `parsed` のみ

## 5. 実装境界

確認ポイント:

- ドメイン層: `buildWebhookPayload` は payload 生成に責務を限定する。
- 変換層: `payloadToFormData` は transport 変換に責務を限定する。
- 送信層: raw multipart body は通常フォーム項目に不要な `Content-Type: text/plain; charset=...` を付けない。
- 互換ラッパー: `buildWebhookFormData` は後方互換のために残し、2段構成の結果と同値である。

## 6. エンドポイント検証

`POST /internal/payload-preview` で以下を確認する。

- 200: 正常系で `payload` / `headerCharsets` / `formFields` を返す。
- 400: 不正 JSON を拒否する。
- 405: 非 POST を拒否する。
- 404: 未知パスを拒否する。

対応テスト:

- `test/index.spec.ts` の `fetch payload preview endpoint`
- `test/webhook-payload-builder.spec.ts` の payload 契約テスト
