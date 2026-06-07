# Doppler Secrets 管理

この拡張機能の秘密情報（API キー、Slack Webhook、ログイン資格情報）は **Doppler** から取得します。

正の定義は `utils/doppler-secrets.js` の `DOPPLER_SECRET_SCHEMA` です。

## セットアップ

1. Doppler で Service Token（読み取り専用）を発行する
2. 拡張のオプション画面 → **Doppler 設定** に Token を保存する
3. **接続テスト / 今すぐ取得** で 8 キーがすべて取得できることを確認する

## Doppler 側で用意するキー（8個）

| Doppler キー | 必須 | 用途 |
|---|---|---|
| `API_KEY` | はい | 外部 API 認証（本番）。全サイト共通 |
| `API_KEY_LOCAL` | いいえ | 外部 API 認証（ローカル手動実行時）。未設定なら `API_KEY` を使用 |
| `SLACK_ERROR_WEBHOOK_URL` | いいえ | エラー・0件時の Slack 通知（グローバル） |
| `SLACK_SUCCESS_WEBHOOK_URL` | いいえ | 成功時 heartbeat（グローバル） |
| `X_BOOKMARKS_SLACK_WEBHOOK_URL` | いいえ | X ブックマーク処理結果の Slack 通知 |
| `RAKUTEN_LOGIN_PASSWORD` | いいえ | 楽天カード自動ログイン（パスワードのみ） |
| `MONEYTREE_LOGIN_EMAIL` | いいえ | Moneytree 自動ログイン |
| `MONEYTREE_LOGIN_PASSWORD` | いいえ | Moneytree 自動ログイン |

## 取得タイミング

| 実行経路 | 挙動 |
|---|---|
| 手動実行（今すぐ実行 / モック / ローカル） | 毎回 Doppler から再取得 |
| スケジュール実行 | 6 時間キャッシュを利用。期限切れ時のみ再取得 |
| スケジュール + Doppler 障害 | 有効なキャッシュがあれば stale cache で継続 |

手動実行で Doppler 取得に失敗した場合は、古いキャッシュは使わずエラーになります。

## ローカル手動実行（localMode）

- POST 先 URL は `http://localhost:3000` に差し替え（`utils/validation.js`）
- 認証には `API_KEY_LOCAL` を優先（未設定時は `API_KEY`）

## オプション画面に残すもの

- `doppler.serviceToken` のみ（永続化）

サイト別の API キー・Slack Webhook・ログイン情報の手入力欄は廃止しました。

## 移行

storage 正規化時に以下の旧フィールドを自動削除します。

- グローバル: `slackWebhookUrl`, `slackSuccessWebhookUrl`
- サイト別: `ifaApiKey`, `ifaApiKeyLocal`, `householdApiKey`, `householdApiKeyLocal`, `loginEmail`, `loginPassword`, `slackWebhookUrl`
