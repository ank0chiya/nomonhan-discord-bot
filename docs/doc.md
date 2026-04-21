# Discord リマインダーBot 開発・運用チートシート

## 1. Cloudflare Workers (Wrangler) の基本コマンド
開発、デプロイ、エラー調査に使用する必須コマンド群。

* **`npx wrangler deploy`**
  コード（`src/index.ts`）や設定（`wrangler.toml`）を書き換えた後、Cloudflareにアップロードして本番環境に反映する。
* **`npx wrangler tail`**
  本番環境のリアルタイムログをターミナルに表示する。原因不明のエラー調査や、Cron（定期実行）の動作確認に使用する。
* **`npx wrangler secret put [シークレット名]`**
  コード内に直接書けない機密情報をCloudflareに安全に登録する。

## 2. 登録したシークレット（環境変数）一覧
以下のシークレットは `wrangler.toml` には記載せず、`wrangler secret put` コマンドを使用して登録する。

* **`DISCORD_PUBLIC_KEY`**
  Discordからのリクエストの署名検証（本物かどうかの確認）に使用。Discord Developer Portal の「General Information」から取得。（※Tokenとは別物）
* **`DISCORD_WEBHOOK_URL`**
  定期実行（Cron）時にDiscordチャンネルへメッセージを送信するための宛先URL。Discordのチャンネル設定「連携サービス」から取得。

## 3. Discord スラッシュコマンドの登録手順
コードのデプロイ後、以下の `curl` コマンドを実行してDiscordのAPIにコマンドの仕様を登録する。

### 事前準備
実行するターミナルで以下の環境変数をセットしておく。
```bash
export TOKEN="あなたのBotトークン"
export APPLICATION_ID="あなたのアプリケーションID"
```

### `/remind` コマンドの登録
```bash
curl -X POST \
-H "Authorization: Bot ${TOKEN}" \
-H "Content-Type: application/json" \
-d '{
  "name": "remind",
  "description": "リマインドを設定します",
  "options": [
    {"type": 3, "name": "date", "description": "予定の日付 (例: 2026-05-01)", "required": true},
    {"type": 3, "name": "time", "description": "通知する時間 (例: 20:00 / デフォルトは09:00)", "required": false},
    {"type": 3, "name": "message", "description": "リマインド内容", "required": false}
  ]
}' \
"[https://discord.com/api/v10/applications/$](https://discord.com/api/v10/applications/$){APPLICATION_ID}/commands"
```

### `/list-reminders` コマンドの登録
```bash
curl -X POST \
-H "Authorization: Bot ${TOKEN}" \
-H "Content-Type: application/json" \
-d '{"name": "list-reminders", "description": "現在予約中のリマインド一覧を表示します"}' \
"[https://discord.com/api/v10/applications/$](https://discord.com/api/v10/applications/$){APPLICATION_ID}/commands"
```

### `/cancel` コマンドの登録
```bash
curl -X POST \
-H "Authorization: Bot ${TOKEN}" \
-H "Content-Type: application/json" \
-d '{
  "name": "cancel",
  "description": "予約中のリマインドをキャンセルします",
  "options": [{
    "type": 3,
    "name": "id",
    "description": "キャンセルするリマインドのID（一覧コマンドで確認できます）",
    "required": true
  }]
}' \
"[https://discord.com/api/v10/applications/$](https://discord.com/api/v10/applications/$){APPLICATION_ID}/commands"
```

## 4. 開発時の重要ポイント・ハマりどころ

* **タイムゾーン（時差）の罠**
  Cloudflare Workersの内部時計とKVは「UTC（世界標準時）」で動作する。Discord上に日本時間（JST）で表示させる場合は、コード内で `toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })` を使用して変換を行うこと。
* **Cron（定期実行）のトリガー設定**
  コード上に `scheduled` 関数を記述しただけでは実行されない。必ず `wrangler.toml` に以下の設定を追記すること。
  ```toml
  [triggers]
  crons = ["* * * * *"]
  ```
* **署名検証（Signature Validation）**
  Discord側で「インタラクション・エンドポイントURLを認証できませんでした」というエラーが出る場合、原因のほとんどは `DISCORD_PUBLIC_KEY` の設定ミスか未登録。
* **KVの古いデータによるパースエラー**
  KVから取得したデータを `JSON.parse()` する際、開発初期の古い形式のデータ（単なる文字列など）が混ざっているとエラーでクラッシュする。取得時は `try-catch` で囲んで安全に処理する設計を徹底すること。